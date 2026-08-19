// @tier: fast
/**
 * Ticket 573a1daa (BUG-2026-08-19, AC-4 / AC-5) — the disposition of a
 * commit-less Done, and the disposition of a refused worker-gate verdict, are
 * DIFFERENT and must stay different.
 *
 * AC-4: a ticket whose worker completed its lifecycle, carries
 * `worker_gate_verdict: green`, and produced NO attributable commit is a
 * per-ticket verdict. `mux-runner` must PARK it — record the residual, leave the
 * ticket un-confirmed, and let the phase loop CONTINUE to the next ticket and on
 * to its terminal verdict. This class has now bitten twice (`B-GTRUTH` /
 * `f8559470`, then BUG-2026-08-19), so the fatal is pinned from three angles:
 * the loop action returned by the live handler, the residual + liveness left in
 * `state.json`, and a source invariant that no halt-shaped assignment survives.
 *
 * AC-5: the sibling `worker_gate_red` / `worker_gate_unavailable` refusal
 * (`src/bin/mux-runner.ts:5552-5575`) is a DIFFERENT class and stays fail-closed
 * (R-CWGE) — refusing the local Done flip. The park treatment must not widen to
 * it, which is asserted as non-membership in the shared classification.
 *
 * `PICKLE_TEST_MODE=1` makes `guardCompletionCommitBeforeDone` return `ok: true`
 * unconditionally (`src/bin/mux-runner.ts:5510`), so every case here runs with
 * that variable removed and restored — otherwise the guard never refuses and the
 * whole file would pass without ever reaching the code it exists to pin.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REPORTED LIMIT — `runMuxRunnerMain` (`src/bin/mux-runner.ts:10381`) is not
 * exported, so the four in-loop guard sites (`:11810`, `:11859`, `:12206`,
 * `:12283`) cannot be crossed in-process; only the `processTaskCompleted` site
 * (`:8514`) can. Driving `bin/mux-runner.js` as a subprocess was attempted while
 * writing this file: startup reached only "Iteration 2" after ~160 s (a large
 * part of it inside a `readdir` of the developer's `TMPDIR`, observed with
 * `lsof`/`sample`) and the fake `claude` was never invoked, so the fixture cost
 * exceeded the fatal-deactivate precedent (146 s measured,
 * `tests/integration/mux-runner-fatal-deactivate.test.js:60-63`) without
 * reaching the seam. Those four sites are therefore covered by the source
 * invariant below plus the derived per-site sweep in
 * `tests/mux-runner-done-without-commit-evidence-exit.test.js`, and NOT by an
 * observed loop advance. Recorded rather than papered over.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_TS = path.resolve(__dirname, '..', 'src', 'bin', 'mux-runner.ts');
const PIPELINE_RUNNER_TS = path.resolve(__dirname, '..', 'src', 'bin', 'pipeline-runner.ts');
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');

const {
  processCompletionBranch,
  processIterationOutcome,
  guardCompletionCommitBeforeDone,
  isPerTicketVerdictReason,
  isHaltExit,
  isFailureExit,
  deriveCompletionVerdict,
  buildTmuxNotification,
} = await import('../bin/mux-runner.js');

const GIT_TIMEOUT_MS = 20_000;

/**
 * Every fixture lives under a PRIVATE tmp root, and `TMPDIR` is repointed at it
 * for the life of this file (node:test gives each test file its own process, so
 * the mutation is contained). This is not cosmetic: `StateManager.read`'s
 * crash-recovery sweep scans the tmp root, so on a developer box with a busy
 * `TMPDIR` a single `processCompletionBranch` call measured 20 s against 0.55 s
 * with a private one — the same readdir cost that makes a mux-runner subprocess
 * fixture unaffordable (see the REPORTED LIMIT above).
 */
const PRIOR_TMPDIR = process.env.TMPDIR;
const PRIVATE_TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-zcp-root-')));
process.env.TMPDIR = PRIVATE_TMP;

test.after(() => {
  if (PRIOR_TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = PRIOR_TMPDIR;
  fs.rmSync(PRIVATE_TMP, { recursive: true, force: true });
});

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Runs `fn` with PICKLE_TEST_MODE removed, restoring whatever was there. The
 * guard's bypass is keyed on that variable, so a fixture that leaves it set
 * measures nothing.
 */
function withoutTestMode(fn) {
  const prior = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.PICKLE_TEST_MODE;
    else process.env.PICKLE_TEST_MODE = prior;
  }
}

const LIFECYCLE_ARTIFACTS = [
  ['research_2026-08-19.md', 'research body'],
  ['research_review.md', 'APPROVED'],
  ['plan_2026-08-19.md', 'plan body'],
  ['plan_review.md', 'APPROVED'],
  ['conformance_2026-08-19.md', 'ALL_PASS'],
  ['code_review_2026-08-19.md', 'PASS'],
];

/**
 * A session whose single ticket is Done and whose worker left a full lifecycle
 * trail. `commitForTicket` decides whether an attributable commit exists;
 * `pickleRickShaped` decides whether the working dir looks like pickle-rick's
 * own repo, which is what `isAdvisoryWorkerGateVerdict` keys on.
 */
function makeFixture({
  gateVerdict = 'green',
  commitForTicket = false,
  pickleRickShaped = false,
  ticketId = 'a1b2c3d4',
} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-zcp-')));
  const workingDir = path.join(root, 'repo');
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(workingDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  git(['init', '-b', 'main'], workingDir);
  git(['config', 'user.email', 'test@example.com'], workingDir);
  git(['config', 'user.name', 'Test User'], workingDir);
  git(['config', 'commit.gpgsign', 'false'], workingDir);
  fs.writeFileSync(path.join(workingDir, 'README.md'), 'fixture\n');
  git(['add', 'README.md'], workingDir);
  git(['commit', '-m', 'initial fixture', '--no-gpg-sign'], workingDir);
  const startCommit = git(['rev-parse', 'HEAD'], workingDir).trim();

  if (pickleRickShaped) fs.mkdirSync(path.join(workingDir, 'extension'), { recursive: true });

  let completionSha = null;
  if (commitForTicket) {
    fs.writeFileSync(path.join(workingDir, 'worker-output.txt'), 'worker changes\n');
    git(['add', 'worker-output.txt'], workingDir);
    git(['commit', '-m', `fix(${ticketId}): worker deliverable`, '--trailer', `Pickle-Ticket: ${ticketId}`, '--no-gpg-sign'], workingDir);
    completionSha = git(['rev-parse', 'HEAD'], workingDir).trim();
  }

  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  for (const [name, body] of LIFECYCLE_ARTIFACTS) {
    fs.writeFileSync(path.join(ticketDir, name), `${body}\n`);
  }
  fs.writeFileSync(path.join(ticketDir, 'worker_session_4242.log'), 'worker output\n');
  const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
  fs.writeFileSync(ticketPath, [
    '---',
    `id: ${ticketId}`,
    'title: "Verification: run the tiers and fix what they surface"',
    'status: "Done"',
    'priority: High',
    'order: 10',
    'complexity_tier: small',
    `worker_gate_verdict: ${gateVerdict}`,
    `worker_gate_tests_verdict: ${gateVerdict}`,
    '---',
    '# Description',
    '',
    '## Acceptance Criteria',
    '- [x] tiers run',
    '',
  ].join('\n'));

  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, `${JSON.stringify({
    active: true,
    schema_version: 3,
    working_dir: workingDir,
    session_dir: sessionDir,
    step: 'review',
    iteration: 3,
    max_iterations: 20,
    max_time_minutes: 60,
    worker_timeout_seconds: 600,
    start_time_epoch: Math.floor(Date.now() / 1000) - 600,
    start_commit: startCommit,
    original_prompt: 'zero-commit park fixture',
    current_ticket: ticketId,
    completion_promise: null,
    history: [],
    started_at: new Date().toISOString(),
    tmux_mode: false,
    backend: 'claude',
    activity: [],
  }, null, 2)}\n`);

  return { root, workingDir, sessionDir, statePath, ticketId, ticketPath, completionSha };
}

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function makeCtx(fixture, logLines) {
  return {
    sessionDir: fixture.sessionDir,
    statePath: fixture.statePath,
    extensionRoot: EXTENSION_ROOT,
    iteration: 3,
    log: (msg) => logLines.push(msg),
    now: () => Date.now(),
    sleep: async () => {},
  };
}

// ---------------------------------------------------------------------------
// AC-4 — the loop ADVANCES past a lifecycle-complete, green-gate, zero-commit ticket
// ---------------------------------------------------------------------------

test('AC-4: task_completed on a green-gate ticket with NO commit returns continue (the phase loop advances)', async () => {
  const fx = makeFixture({ gateVerdict: 'green', commitForTicket: false });
  const logLines = [];
  try {
    const action = await withoutTestMode(() =>
      processCompletionBranch(readState(fx.statePath), 'task_completed', makeCtx(fx, logLines)));

    assert.equal(
      action.kind,
      'continue',
      `expected the loop to advance; got kind='${action.kind}' reason='${action.reason}'. `
      + 'A break here is the BUG-2026-08-19 fatal reintroduced: a per-ticket verdict ending the run.',
    );
    assert.notEqual(
      action.reason,
      'done_without_commit_evidence',
      'done_without_commit_evidence must never be a loop-terminating reason',
    );

    const state = readState(fx.statePath);
    assert.equal(
      state.exit_reason,
      'done_without_commit_evidence',
      'the residual must survive — continuing is not claiming success (AC-2 honesty)',
    );
    assert.equal(
      state.active,
      true,
      'the session must NOT be deactivated: a per-ticket verdict may refuse a flip, never end the run',
    );
    assert.ok(
      logLines.some(line => line.includes('cannot flip Done')),
      `the refusal must still be logged; log was: ${JSON.stringify(logLines)}`,
    );
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('AC-4: the refused ticket is NOT confirmed Done — no completion_commit is written', async () => {
  const fx = makeFixture({ gateVerdict: 'green', commitForTicket: false });
  const logLines = [];
  try {
    await withoutTestMode(() =>
      processCompletionBranch(readState(fx.statePath), 'task_completed', makeCtx(fx, logLines)));

    const ticket = fs.readFileSync(fx.ticketPath, 'utf8');
    assert.doesNotMatch(
      ticket,
      /^completion_commit:/m,
      'parking must not launder the ticket into a completed one — it should park, not pass',
    );
    // The guard is what refuses, and it refuses for the absent-evidence reason
    // (not the gate reason) on this fixture.
    const guard = withoutTestMode(() => guardCompletionCommitBeforeDone({
      sessionDir: fx.sessionDir,
      ticketId: fx.ticketId,
      workingDir: fx.workingDir,
      rereadBackoffMs: 0,
      flags: {},
    }));
    assert.equal(guard.ok, false, 'zero-commit Done must still be refused locally');
    assert.match(guard.reason, /readEvidence\(\)\.kind === 'absent'/);
    assert.equal(guard.testsVerdict, 'green', 'the worker gate itself was green — the missing thing is the commit');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('AC-4: the same verdict routed through processIterationOutcome also continues', async () => {
  const fx = makeFixture({ gateVerdict: 'green', commitForTicket: false });
  const logLines = [];
  try {
    const action = await withoutTestMode(() => processIterationOutcome(
      readState(fx.statePath),
      { completion: 'task_completed', timedOut: false, wallSeconds: 12 },
      makeCtx(fx, logLines),
    ));

    assert.equal(
      action.kind,
      'continue',
      `the loop's own routing layer must also advance; got kind='${action.kind}' reason='${action.reason}'`,
    );
    assert.equal(readState(fx.statePath).active, true, 'routing layer must not deactivate either');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('AC-4: a ticket WITH an attributable commit still flips Done (the park is discriminating, not blanket)', async () => {
  const fx = makeFixture({ gateVerdict: 'green', commitForTicket: true });
  try {
    const guard = withoutTestMode(() => guardCompletionCommitBeforeDone({
      sessionDir: fx.sessionDir,
      ticketId: fx.ticketId,
      workingDir: fx.workingDir,
      rereadBackoffMs: 0,
      flags: {},
    }));
    assert.equal(guard.ok, true, 'a real attributable commit must still satisfy the guard');
    assert.equal(guard.sha, fx.completionSha);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-4 — the parked run still reaches a terminal verdict
// ---------------------------------------------------------------------------

test('AC-4: done_without_commit_evidence finalizes as an INCOMPLETE verdict, never a halt or a failure', () => {
  assert.equal(isHaltExit('done_without_commit_evidence'), false, 'not a halt — the run keeps going');
  assert.equal(isFailureExit('done_without_commit_evidence'), false, 'not a failure exit');
  assert.deepEqual(
    deriveCompletionVerdict('done_without_commit_evidence'),
    { isFailure: false, isIncomplete: true, colorName: 'YELLOW', panelTitle: 'mux-runner Incomplete' },
  );
  const notification = buildTmuxNotification('done_without_commit_evidence', 'review', 8, 600);
  assert.match(notification.title, /Incomplete/, 'the run reports a verdict — success is WITHHELD, not claimed');
  assert.match(notification.subtitle, /done_without_commit_evidence/, 'the residual reason is named to the operator');
});

// ---------------------------------------------------------------------------
// AC-4 — no halt-shaped disposition survives anywhere in the runner
// ---------------------------------------------------------------------------

test('AC-4: mux-runner.ts contains no path that ends the phase loop on done_without_commit_evidence', () => {
  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf8');

  assert.doesNotMatch(
    source,
    /exitReason\s*=\s*'done_without_commit_evidence'/,
    'assigning the loop-terminating exitReason for this reason is the BUG-2026-08-19 fatal (sites :11810, :12206, :12283)',
  );
  assert.doesNotMatch(
    source,
    /kind:\s*'break',\s*reason:\s*'done_without_commit_evidence'/,
    "returning { kind: 'break', reason: 'done_without_commit_evidence' } is the same fatal at the processTaskCompleted site (:8514)",
  );

  // No guard-fail site may deactivate the session: that is the halt wearing a
  // different hat (the next iteration's inactive-session check ends the run).
  const lines = source.split('\n');
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/recordExitReason\([^,]+,\s*'done_without_commit_evidence'\)/.test(lines[i])) continue;
    const windowText = lines.slice(i, i + 6).join('\n');
    if (/safeDeactivate\(/.test(windowText)) offenders.push(i + 1);
  }
  assert.deepEqual(
    offenders,
    [],
    `these done_without_commit_evidence sites deactivate the session instead of parking: lines ${offenders.join(', ')}`,
  );
});

test('AC-3: one shared classification — pipeline-runner consumes mux-runner\'s predicate rather than its own copy', () => {
  const pipelineSource = fs.readFileSync(PIPELINE_RUNNER_TS, 'utf8');
  assert.match(
    pipelineSource,
    /import\s*\{[^}]*isPerTicketVerdictReason[^}]*\}\s*from\s*'\.\/mux-runner\.js'/,
    'pipeline-runner must import the predicate, not restate the policy',
  );
  assert.doesNotMatch(
    pipelineSource,
    /INCOMPLETE_EXIT_REASONS\s*(?::|=)/,
    'a second membership set in pipeline-runner is the divergence this bundle removed',
  );
  assert.equal(isPerTicketVerdictReason('done_without_commit_evidence'), true);
});

// ---------------------------------------------------------------------------
// AC-5 — the worker-gate refusal is a DIFFERENT class and stays fail-closed
// ---------------------------------------------------------------------------

test('AC-5: a red worker-gate verdict on pickle-rick\'s own repo still refuses the Done flip (R-CWGE fail-closed)', () => {
  // `extension/` present in the working dir → the red is pickle-rick's own, so
  // `isAdvisoryWorkerGateVerdict` is false and the fail-closed arm is reached.
  const fx = makeFixture({ gateVerdict: 'red', commitForTicket: true, pickleRickShaped: true });
  try {
    const guard = withoutTestMode(() => guardCompletionCommitBeforeDone({
      sessionDir: fx.sessionDir,
      ticketId: fx.ticketId,
      workingDir: fx.workingDir,
      rereadBackoffMs: 0,
      flags: {},
    }));

    assert.equal(guard.ok, false, 'a red gate verdict must refuse the Done flip even with a real commit');
    assert.match(guard.reason, /worker_gate_verdict='red'/);
    assert.match(guard.reason, /fail-closed \(R-CWGE\)/);

    const events = (readState(fx.statePath).activity || [])
      .filter(entry => entry.event === 'worker_gate_verdict_fail_closed');
    assert.equal(events.length, 1, 'the fail-closed refusal must stay observable');
    assert.equal(events[0].ticket_id, fx.ticketId);
    assert.equal(events[0].gate_payload.verdict, 'red');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('AC-5: the refusal discriminates — the same fixture with a green verdict flips', () => {
  const fx = makeFixture({ gateVerdict: 'green', commitForTicket: true, pickleRickShaped: true });
  try {
    const guard = withoutTestMode(() => guardCompletionCommitBeforeDone({
      sessionDir: fx.sessionDir,
      ticketId: fx.ticketId,
      workingDir: fx.workingDir,
      rereadBackoffMs: 0,
      flags: {},
    }));
    assert.equal(guard.ok, true, 'green + commit is the accept case; a test that refuses everything measures nothing');
    assert.equal(
      (readState(fx.statePath).activity || []).filter(e => e.event === 'worker_gate_verdict_fail_closed').length,
      0,
      'no fail-closed event on the accept path',
    );
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('AC-5: the no-stop park class did NOT widen to the gate-verdict class', () => {
  assert.equal(isPerTicketVerdictReason('worker_gate_red'), false);
  assert.equal(isPerTicketVerdictReason('worker_gate_unavailable'), false);
  assert.equal(isPerTicketVerdictReason('done_without_commit_evidence'), true);

  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf8');
  const refusal = /if \(decision\.reason === 'worker_gate_red' \|\| decision\.reason === 'worker_gate_unavailable'\) \{[\s\S]*?\n {2}\}/.exec(source);
  assert.ok(refusal, 'the gate-verdict refusal block must still exist in guardCompletionCommitBeforeDone');
  assert.match(refusal[0], /ok:\s*false/, 'both gate reasons must still refuse');
  assert.doesNotMatch(
    refusal[0],
    /isPerTicketVerdictReason|recordExitReason|continue;/,
    'the gate-verdict refusal must not adopt the park treatment',
  );
});
