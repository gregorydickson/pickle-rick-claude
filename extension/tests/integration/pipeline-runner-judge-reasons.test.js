// @tier: integration
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  __setSpawnRunnerForTests,
  classifyMicroverseHaltDecision,
  main,
} from '../../bin/pipeline-runner.js';
import { MICROVERSE_EXIT_REASONS } from '../../types/index.js';

const __filename = fileURLToPath(import.meta.url);

class ExitIntercept extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(repo) {
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@test.local'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.mkdirSync(path.join(repo, 'services'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'services', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'services', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(repo, 'services', 'c.ts'), 'export const c = 3;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
}

function makeSession(phases) {
  const repo = tmpDir('pipeline-jr-repo-');
  const sessionDir = tmpDir('pipeline-jr-session-');
  initRepo(repo);
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    chain_meeseeks: false,
    backend: 'claude',
  }, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases,
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    dirty_exempt_segments: ['prds', 'docs'],
  }, null, 2));
  return { repo, sessionDir };
}

async function expectMainExit(sessionDir, code) {
  const originalExit = process.exit;
  const originalTmux = process.env.TMUX;
  delete process.env.TMUX;
  process.exit = ((actualCode) => {
    throw new ExitIntercept(actualCode ?? 0);
  });
  try {
    await assert.rejects(
      () => main(sessionDir),
      (err) => err instanceof ExitIntercept && err.code === code,
    );
  } finally {
    process.exit = originalExit;
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
  }
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
});

// B-ONEABORT AC-OA-1c: ran-to-completion is NOT reported-success. A passing recovery gate lets the
// phase CONTINUE (completed++, no halt) but `runAllBackendsExhaustedFinalizeGate` also raises
// `nonConvergent`, and `finalizePipeline` folds that into `unsuccessful` — so the run withholds the
// success verdict and exits 1 with exit_reason 'failed'. This deliberately DIVERGES from
// `judge_timeout` (R-PRJT-2), which is a transient measurement timeout over already-converged work
// and finalizes as a clean success. Exhausting every judge backend means the work was never
// measured at all; continuing is the reliability contract, reporting success would be fake-green.
test('all_judge_backends_exhausted + gate pass → phase continues but the run withholds success (exit 1, degraded)', async () => {
  const { repo, sessionDir } = makeSession(['szechuan-sauce']);
  const spawnCalls = [];
  let callCount = 0;
  __setSpawnRunnerForTests(async (cmd, args) => {
    spawnCalls.push({ cmd, args: [...args] });
    callCount++;
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (callCount === 1) {
      // microverse-runner: exits with all_judge_backends_exhausted
      state.exit_reason = 'all_judge_backends_exhausted';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    // finalize-gate: pass (exit 0)
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  try {
    // A PASSING recovery gate continues the phase, but the phase is DEGRADED: nonConvergent > 0
    // makes finalizePipeline report unsuccessful, so main() exits 1.
    await expectMainExit(sessionDir, 1);

    const finalizeGateCalls = spawnCalls.filter(c => c.args.some(a => String(a).includes('finalize-gate.js')));
    assert.equal(finalizeGateCalls.length, 1, 'finalize-gate.js must be spawned once for all_judge_backends_exhausted');

    const statePath = path.join(sessionDir, 'state.json');
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    // R-MWMO d2: the failed finalize PRESERVES the specific reason rather than flattening it to
    // 'failed', so the residual names what actually degraded.
    assert.equal(
      finalState.exit_reason,
      'all_judge_backends_exhausted',
      'a degraded phase must NOT stamp completed — that would be fake-green; the specific reason is preserved',
    );

    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /all_judge_backends_exhausted/, 'log must mention the exit reason');
    assert.match(
      runnerLog,
      /finalize-gate passed after all_judge_backends_exhausted — phase degraded, run cannot report success/,
      'log must record BOTH halves: the gate passed AND the run is degraded (AC-OA-1c)',
    );
    assert.doesNotMatch(runnerLog, /marking phase incomplete/, 'a PASSING gate must NOT mark the phase incomplete');
    assert.doesNotMatch(runnerLog, /aborting \(no finalize-gate\)/, 'log must NOT contain abort message');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('all_judge_backends_exhausted + gate fail → exit code 1 (failed), auto-resume=false', async () => {
  const { repo, sessionDir } = makeSession(['szechuan-sauce']);
  const spawnCalls = [];
  let callCount = 0;
  __setSpawnRunnerForTests(async (cmd, args) => {
    spawnCalls.push({ cmd, args: [...args] });
    callCount++;
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    if (callCount === 1) {
      state.exit_reason = 'all_judge_backends_exhausted';
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      return { exitCode: 1, stdout: '', stderr: '' };
    }
    // finalize-gate: fail (cap exhausted, exit 2)
    return { exitCode: 2, stdout: '', stderr: '' };
  });
  try {
    await expectMainExit(sessionDir, 1);

    const finalizeGateCalls = spawnCalls.filter(c => c.args.some(a => String(a).includes('finalize-gate.js')));
    assert.equal(finalizeGateCalls.length, 1, 'finalize-gate.js must still be spawned when it will fail');

    const statePath = path.join(sessionDir, 'state.json');
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    // AC-MWMO-D2-10 (R-MWMO d2 WS-3, `5e544152`): finalizePipeline no longer overwrites a
    // specific recorded exit_reason with the generic 'failed' — it preserves it, matching the
    // sibling phaseIncomplete/handoffStop branch (and the `pipeline_phase_incomplete` assertion
    // above). 'failed' is stamped ONLY when no reason was recorded. Erasing a named disposition
    // into a generic one is the observability loss the operating principles forbid.
    assert.equal(
      finalState.exit_reason,
      'all_judge_backends_exhausted',
      'exit_reason must PRESERVE the recorded reason when the gate fails (not erase it to "failed")',
    );

    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(runnerLog, /all_judge_backends_exhausted/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// B-ONEABORT AC-OA-1a: judge_cli_missing is a MICROVERSE_EXIT_REASONS union member (it is ALSO a
// MICROVERSE_FATAL_REASONS member, but classifyMicroverseHaltDecision checks union membership
// BEFORE the fatal-reason fallback, so union membership wins) — it routes to
// run-finalize-gate-incomplete, never a bare abort. The gate IS spawned; here it fails (stub
// returns exitCode 1 for every call), so the phase breaks and the pipeline still exits 1 — but for
// the right reason (a failed recovery gate), not a phantom "terminal, no gate" disposition.
test('judge_cli_missing (union member) — finalize-gate IS spawned, gate fails, pipeline exits 1 (degraded, not aborted)', async () => {
  const { repo, sessionDir } = makeSession(['szechuan-sauce']);
  const spawnCalls = [];
  __setSpawnRunnerForTests(async (cmd, args) => {
    spawnCalls.push({ cmd, args: [...args] });
    const statePath = path.join(sessionDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.exit_reason = 'judge_cli_missing';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    return { exitCode: 1, stdout: '', stderr: '' };
  });
  try {
    await expectMainExit(sessionDir, 1);

    const finalizeGateCalls = spawnCalls.filter(c => c.args.some(a => String(a).includes('finalize-gate.js')));
    assert.equal(
      finalizeGateCalls.length,
      1,
      'finalize-gate.js MUST be spawned for judge_cli_missing — it is a MICROVERSE_EXIT_REASONS union member (B-ONEABORT AC-OA-1a), not a bare abort',
    );

    const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
    assert.match(
      runnerLog,
      /finalize-gate failed after judge_cli_missing/,
      'B-ONEABORT: judge_cli_missing routes through run-finalize-gate-incomplete; the gate ran and failed, so this is the expected log line',
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// B-ONEABORT AC-OA-1a: NO member of MICROVERSE_EXIT_REASONS aborts; the union IS the subject list,
// so a newly-added reason inherits this without a matching test edit.
test('every MICROVERSE_EXIT_REASONS member routes to a non-abort action (B-ONEABORT three-armed contract)', () => {
  assert.equal(MICROVERSE_EXIT_REASONS.length, 18, 'union membership count changed — update this test deliberately if a reason was added/removed');
  for (const reason of MICROVERSE_EXIT_REASONS) {
    const decision = classifyMicroverseHaltDecision(reason);
    assert.notEqual(decision.action, 'abort', `${reason} must not abort — B-ONEABORT AC-OA-1a`);
    assert.equal(decision.recognizedExitReason, reason, `${reason} must be recognized verbatim`);
  }
});

// B-ONEABORT: the abort floor is narrow — non-string input, or a string outside the union. Per the
// ticket's correction to an earlier PRD draft, session_state_corrupted lives in
// MICROVERSE_FATAL_REASONS, NOT MICROVERSE_EXIT_REASONS — it is a non-member string that still
// carries a recognized fatal reason through the classifier's fallback arm.
test('abort floor stays narrow — only non-string or non-union-member strings abort', () => {
  assert.deepEqual(classifyMicroverseHaltDecision(null), { action: 'abort', recognizedExitReason: null });
  assert.deepEqual(classifyMicroverseHaltDecision(undefined), { action: 'abort', recognizedExitReason: null });
  assert.deepEqual(classifyMicroverseHaltDecision(42), { action: 'abort', recognizedExitReason: null });
  assert.deepEqual(classifyMicroverseHaltDecision('not-a-real-exit'), { action: 'abort', recognizedExitReason: null });
  assert.deepEqual(classifyMicroverseHaltDecision('session_state_corrupted'), {
    action: 'abort',
    recognizedExitReason: 'session_state_corrupted',
  });
});

// Assertion-count floor: guards against a future edit silently shrinking this file's coverage of
// the B-ONEABORT contract (AC-D3). Counts assert. call sites in this file's own source.
test('assertion-count floor — this file carries at least 13 assert. call sites', () => {
  const src = fs.readFileSync(__filename, 'utf-8');
  const count = (src.match(/assert\./g) || []).length;
  assert.ok(count >= 13, `expected >= 13 assert. call sites, found ${count}`);
});
