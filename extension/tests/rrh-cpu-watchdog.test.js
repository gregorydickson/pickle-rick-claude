// @tier: fast
/**
 * f2de392b — CPU/artifact liveness watchdog + conformance-present salvage (C6/C6a/C7).
 *
 * B-MRSW: a `/login` re-auth hung an in-flight worker that had ALREADY finished its
 * lifecycle (conformance present, gate-green tree, work uncommitted). The mux sat at
 * 0% CPU but the 900s idle watchdog never tripped because `/login` output kept
 * advancing `lastProgressMs` (false-liveness). The CPU/artifact watchdog defeats that
 * by keying on the worker's CPU-time delta + artifact-mtime advance, NOT output recency.
 *
 * The pure decision (`evaluateCpuLivenessWatchdog`) and the graded predicate
 * (`gradeConformanceComplete`) are exercised directly with injected CPU/mtime readings
 * and a tmp session dir — no real `claude -p`, no 55s sleep. The wired loop path is
 * covered by source-content assertions (the established mux-runner watchdog idiom).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  evaluateCpuLivenessWatchdog,
  gradeConformanceComplete,
  parsePsCpuTimeToSeconds,
  resolveCurrentWorkerPid,
} from '../bin/mux-runner.js';
// R-DSPW: imported from state-manager.js, never re-inlined — the same seam
// mux-runner.ts itself imports through (see the R-CIFB-A trap door).
import { isProcessAlive } from '../services/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_SRC = path.resolve(__dirname, '../src/bin/mux-runner.ts');
const src = readFileSync(MUX_SRC, 'utf8');

const CPU_FLOOR = 5;
const CLEAN = {
  active: true,
  workerAlive: true,
  windowSeconds: 902, // >= the 900s window
  cpuFloorSeconds: CPU_FLOOR,
  artifactMtimeAdvanced: false,
  rateLimitWaiting: false,
  circuitBreakerExecutable: true,
  lastError: null,
  consecutiveSubprocessErrors: 0,
};

// --- C6: alive 0%-CPU worker, no artifact-mtime advance → trips (defeats lastProgressMs) ---

test('C6: alive worker, <5s CPU over the window, no mtime advance → stalled (cpu_stall)', () => {
  // 0.3s CPU accrued over 902s wall: a `/login`-hung worker. Note the pure function
  // never takes lastProgressMs — by construction the trip is independent of any output
  // recency that would have kept the idle watchdog falsely fresh.
  const decision = evaluateCpuLivenessWatchdog({ ...CLEAN, cpuSecondsDelta: 0.3 });
  assert.equal(decision.stalled, true);
  assert.equal(decision.reason, 'cpu_stall');
  assert.equal(decision.cpuSecondsDelta, 0.3);
});

test('C6: a worker accruing >= the CPU floor is alive, not stalled (cpu_active)', () => {
  const decision = evaluateCpuLivenessWatchdog({ ...CLEAN, cpuSecondsDelta: 12 });
  assert.equal(decision.stalled, false);
  assert.equal(decision.reason, 'cpu_active');
});

test('C6: artifact-mtime advance is forward progress even at 0 CPU delta → not stalled', () => {
  const decision = evaluateCpuLivenessWatchdog({ ...CLEAN, cpuSecondsDelta: 0, artifactMtimeAdvanced: true });
  assert.equal(decision.stalled, false);
  assert.equal(decision.reason, 'mtime_advanced');
});

test('C6: a dead worker is an exit, not a CPU stall (no_worker)', () => {
  const decision = evaluateCpuLivenessWatchdog({ ...CLEAN, workerAlive: false, cpuSecondsDelta: 0 });
  assert.equal(decision.stalled, false);
  assert.equal(decision.reason, 'no_worker');
});

test('C6: inactive session is never a CPU stall (inactive)', () => {
  const decision = evaluateCpuLivenessWatchdog({ ...CLEAN, active: false, cpuSecondsDelta: 0 });
  assert.equal(decision.stalled, false);
  assert.equal(decision.reason, 'inactive');
});

test('C6: negative CPU delta floors at 0 and does not crash', () => {
  const decision = evaluateCpuLivenessWatchdog({ ...CLEAN, cpuSecondsDelta: -3 });
  assert.equal(decision.cpuSecondsDelta, 0);
  assert.equal(decision.stalled, true);
});

// --- C6a: parked worker → in_wait_state, NEVER the CPU branch ---

const WAIT_STATES = [
  ['rate-limit parked (rateLimitWaiting)', { rateLimitWaiting: true }],
  ['circuit breaker not executable', { circuitBreakerExecutable: false }],
  ['last_error set', { lastError: { message: 'boom', timestamp: 'now' } }],
  ['consecutive_subprocess_errors > 0', { consecutiveSubprocessErrors: 1 }],
];

for (const [label, override] of WAIT_STATES) {
  test(`C6a: ${label} short-circuits to in_wait_state before the CPU branch (never salvaged)`, () => {
    // Even with a wedged 0-CPU worker and no mtime advance, the wait short-circuit wins.
    const decision = evaluateCpuLivenessWatchdog({ ...CLEAN, ...override, cpuSecondsDelta: 0 });
    assert.equal(decision.stalled, false, `${label} must never be a CPU stall`);
    assert.equal(decision.reason, 'in_wait_state');
  });
}

test('C6a: the wait short-circuit precedes workerAlive — a parked DEAD worker is still in_wait_state', () => {
  const decision = evaluateCpuLivenessWatchdog({
    ...CLEAN,
    rateLimitWaiting: true,
    workerAlive: false,
    cpuSecondsDelta: 0,
  });
  assert.equal(decision.reason, 'in_wait_state');
});

// --- C7: graded =conformance predicate gates the salvage ---

function writeTicket(sessionDir, ticketId, tier, artifacts) {
  const dir = path.join(sessionDir, ticketId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\ncomplexity_tier: ${tier}\n---\n# ${ticketId}\n`,
  );
  for (const f of artifacts) writeFileSync(path.join(dir, f), 'x\n');
  return dir;
}

test('C7: complete medium set (=conformance) → gradeConformanceComplete true (salvage-eligible)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rrh-cpu-c7-ok-'));
  process.env.PICKLE_DATA_ROOT = root;
  try {
    const sessionDir = path.join(root, 'sessions', '2026-06-12-test');
    writeTicket(sessionDir, 'aaaa1111', 'medium', [
      'research_2026.md', 'research_review.md', 'plan_2026.md', 'plan_review.md',
      'conformance_2026.md', 'code_review_2026.md',
    ]);
    assert.equal(gradeConformanceComplete(sessionDir, 'aaaa1111'), true);
  } finally {
    delete process.env.PICKLE_DATA_ROOT;
    rmSync(root, { recursive: true, force: true });
  }
});

test('C7 safety: INCOMPLETE set (conformance_* missing) → gradeConformanceComplete false (never auto-commit)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rrh-cpu-c7-incomplete-'));
  process.env.PICKLE_DATA_ROOT = root;
  try {
    const sessionDir = path.join(root, 'sessions', '2026-06-12-test');
    // research_review APPROVED but conformance_* and downstream artifacts ABSENT.
    writeTicket(sessionDir, 'bbbb2222', 'medium', [
      'research_2026.md', 'research_review.md', 'plan_2026.md', 'plan_review.md',
    ]);
    assert.equal(gradeConformanceComplete(sessionDir, 'bbbb2222'), false);
  } finally {
    delete process.env.PICKLE_DATA_ROOT;
    rmSync(root, { recursive: true, force: true });
  }
});

test('C7: an unreadable/absent ticket dir grades incomplete (fail-safe — never auto-commit)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rrh-cpu-c7-absent-'));
  process.env.PICKLE_DATA_ROOT = root;
  try {
    assert.equal(gradeConformanceComplete(path.join(root, 'nope'), 'cccc3333'), false);
  } finally {
    delete process.env.PICKLE_DATA_ROOT;
    rmSync(root, { recursive: true, force: true });
  }
});

// --- ps TIME parsing (the injectable sampler's parser) ---

test('parsePsCpuTimeToSeconds: MM:SS / HH:MM:SS / DD-HH:MM:SS', () => {
  assert.equal(parsePsCpuTimeToSeconds('00:03'), 3);
  assert.equal(parsePsCpuTimeToSeconds('01:30'), 90);
  assert.equal(parsePsCpuTimeToSeconds('02:00:00'), 7200);
  assert.equal(parsePsCpuTimeToSeconds('1-00:00:00'), 86400);
  assert.equal(parsePsCpuTimeToSeconds('  00:00  '), 0);
  assert.equal(parsePsCpuTimeToSeconds('garbage'), null);
  assert.equal(parsePsCpuTimeToSeconds(''), null);
});

// --- Wiring: the main loop wires the CPU watchdog + routes a trip to the C7 salvage ---

test('wiring: mux-runner main loop calls evaluateCpuLivenessWatchdog and routes a cpu_stall to the salvage', () => {
  assert.ok(src.includes('evaluateCpuLivenessWatchdog({'), 'main loop must call evaluateCpuLivenessWatchdog');
  // The CPU-trip block emits the idle-stall event tagged liveness:'cpu' (no new event type).
  assert.ok(src.includes("liveness: 'cpu'"), 'CPU trip must tag the activity event liveness:cpu');
  // The trip must grade =conformance and route to the existing C7 committer.
  const tripSlice = src.slice(src.indexOf('evaluateCpuLivenessWatchdog({'));
  assert.ok(
    /gradeConformanceComplete\(sessionDir, cpuTicket\)/.test(tripSlice) &&
      /routeExitPathSalvage\(/.test(tripSlice),
    'a cpu_stall trip must grade =conformance then call the C7 salvage committer',
  );
  // INCOMPLETE set must NOT auto-commit (the else branch logs and waits).
  assert.ok(
    /not auto-committing/.test(tripSlice),
    'an INCOMPLETE conformance set must not be auto-committed',
  );
  // Self-recovery resets trackers, identical to the idle-stall path.
  assert.ok(
    /findNextPendingTicketId\(sessionDir\)/.test(tripSlice) &&
      /lastStateIteration = -1/.test(tripSlice) &&
      /stallCount = 0/.test(tripSlice),
    'self-recovery must re-evaluate the current ticket and reset stall trackers',
  );
});

test('wiring: the CPU-stall commit honors the AC-2 working_dir fail-safe (never process.cwd())', () => {
  const tripSlice = src.slice(src.indexOf('evaluateCpuLivenessWatchdog({'));
  assert.ok(
    /if \(!state\.working_dir\)/.test(tripSlice) &&
      /state_working_dir_missing/.test(tripSlice),
    'a missing working_dir must halt the git-mutating commit, not fall back to process.cwd()',
  );
});

// --- D5 (R-DSPW): a live worker is never classified dead ---------------------------
//
// prds/BUG-REPORT-2026-07-26-gitattr-double-trailer-and-duplicate-worker-spawn.md
// recorded two live `spawn-morty` processes racing one ticket because the manager
// judged a still-running worker as needing "resume". The fix (e4df9cce, ticket
// 70a67ccb) lives in spawn-morty.ts's worker-spawn lock — out of this ticket's scope
// fence. What IS in-fence is mux-runner.ts's own worker-liveness signal for the C6
// watchdog: `workerAlive: workerPid != null && isProcessAlive(workerPid)`, fed by
// `resolveCurrentWorkerPid`. Neither had test coverage before this ticket. These two
// tests drive that composition against REAL child processes (not a hand-set boolean)
// to prove it is genuinely liveness-driven, not vacuously true or false.

test('R-DSPW: a REAL live child process is never classified dead by the production worker-liveness composition', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rrh-cpu-dspw-live-'));
  const sessionDir = path.join(root, 'sessions', '2026-08-29-test');
  const ticketId = 'dead1234';
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    // resolveCurrentWorkerPid matches /^worker_session_(\d+)\.log$/ on the ticket dir.
    writeFileSync(path.join(ticketDir, `worker_session_${child.pid}.log`), 'live\n');

    const resolvedPid = resolveCurrentWorkerPid(sessionDir, ticketId);
    assert.equal(resolvedPid, child.pid, 'must resolve the pid recorded in the worker_session log');
    assert.equal(isProcessAlive(resolvedPid), true, 'a real running child must probe alive');

    // Exact production composition (mux-runner.ts:12250).
    const workerAlive = resolvedPid != null && isProcessAlive(resolvedPid);
    assert.equal(workerAlive, true, 'a live worker must never be classified dead');
  } finally {
    child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('R-DSPW: a dead pid recorded in the worker_session log is classified dead, not alive (negative control)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'rrh-cpu-dspw-dead-'));
  const sessionDir = path.join(root, 'sessions', '2026-08-29-test');
  const ticketId = 'dead5678';
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });

  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = await new Promise((resolve, reject) => {
    child.on('exit', () => resolve(child.pid));
    child.on('error', reject);
  });

  try {
    writeFileSync(path.join(ticketDir, `worker_session_${deadPid}.log`), 'dead\n');

    const resolvedPid = resolveCurrentWorkerPid(sessionDir, ticketId);
    assert.equal(resolvedPid, deadPid, 'the file-scan is pid-agnostic — it resolves the pid regardless of liveness');
    assert.equal(isProcessAlive(resolvedPid), false, 'an exited child must probe dead');

    // Exact production composition (mux-runner.ts:12250) — proves the classification
    // is genuinely liveness-driven, not a constant that would pass vacuously.
    const workerAlive = resolvedPid != null && isProcessAlive(resolvedPid);
    assert.equal(workerAlive, false, 'a dead worker must never be classified alive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
