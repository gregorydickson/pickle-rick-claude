// @tier: fast
//
// AC-R-WMNP-4: the wmw-auto-skip terminal no-progress trigger must route through
// the SAME RecoveryController ladder as closer_handoff_terminal BEFORE a bare
// Failed flip / respawn — fix-forward-trivial / execute-converged-plan / auto-split
// advance a near-green ticket; only a genuinely exhausted ladder escalates to
// recovery_exhausted. It must reuse the shared seam (attemptRecoveryBeforeTerminal
// + state.recovery_attempts), never a forked parallel ladder.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(__dirname, '../src/bin/mux-runner.ts'), 'utf-8');

// Isolate the wmw-auto-skip stages. 7ac3038c moved them out of the main loop into module-private
// step helpers (ladder -> suppression -> flip), so the slice starts at the first stage's definition
// rather than at the loop's skip-K guard; the guard itself is pinned by autoSkipCallSite() below.
function autoSkipBlock() {
  const start = SRC.indexOf('function routeWmwRecoveryLadder(');
  assert.ok(start > 0, 'wmw-auto-skip ladder stage present');
  // The block ends at the clear AFTER the terminal Failed flip. 7eb9fa20 added
  // an earlier suppress-branch clear (evidence-backed hold), so anchor the end
  // search past the flip itself rather than at the first clear.
  const flip = SRC.indexOf("updateTicketFrontmatter(apTicketId, sessionDir, { status: 'Failed', completion_commit: null });", start);
  assert.ok(flip > start, 'terminal flip present');
  const end = SRC.indexOf('updateMuxLifecycleState(statePath, { currentTicket: null });', flip);
  assert.ok(end > flip, 'terminal flip clear present');
  return SRC.slice(start, end);
}

test('AC-R-WMNP-4: ladder is invoked BEFORE the bare Failed flip', () => {
  const block = autoSkipBlock();
  // W4a routed every halt seam through the single choke point
  // `routeRecoveryBeforeTerminal`, which wraps `attemptRecoveryBeforeTerminal`
  // (the sole `runRecoveryLadder` decision site). The wmw-auto-skip seam now
  // reaches the ladder through the choke point, not by calling the inner
  // helper directly — see halt-or-recover-choke-point.test.js for the invariant.
  const recoveryIdx = block.indexOf('routeRecoveryBeforeTerminal(');
  const flipIdx = block.indexOf("status: 'Failed'");
  assert.ok(recoveryIdx >= 0, 'wmw-auto-skip routes through routeRecoveryBeforeTerminal (shared ladder choke point)');
  assert.ok(flipIdx >= 0, 'wmw-auto-skip still has the terminal Failed flip');
  assert.ok(recoveryIdx < flipIdx, 'the ladder runs BEFORE the terminal Failed flip, not after');
});

// The loop call site: the skip-K guard through the arm's closing `continue;`.
function autoSkipCallSite() {
  const start = SRC.indexOf('zeroProgressCount >= skipK');
  assert.ok(start > 0, 'auto-skip guard present');
  const end = SRC.indexOf('continue;', start);
  assert.ok(end > start, 'auto-skip loop arm continues');
  return SRC.slice(start, end + 'continue;'.length);
}

// The brace-matched body of the block opened by `needle` (bounded by the language, not an end needle).
function bracedBodyAfter(text, needle) {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `${needle} present`);
  const open = text.indexOf('{', at + needle.length - 1);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && (depth -= 1) === 0) return text.slice(open, i + 1);
  }
  assert.fail(`${needle} block is unterminated`);
}

test('AC-R-WMNP-4: the loop guard reaches the wmw stages and advances the loop', () => {
  const callSite = autoSkipCallSite();
  assert.match(callSite, /runWmwAutoSkip\(/, 'the skip-K guard routes into the wmw-auto-skip stages');
  assert.match(callSite, /emitWastedIterOnce\(\);\s*continue;$/, 'every non-exit wmw outcome records its iteration and continues the loop');
});

test('AC-R-WMNP-4: advanced → continue; exhausted → recovery_exhausted; fall_through → flip', () => {
  const block = autoSkipBlock();
  assert.match(block, /wmwRecovery\.kind === 'advanced'/, 'handles ladder advance');
  const advancedArm = bracedBodyAfter(block, "if (wmwRecovery.kind === 'advanced') {");
  assert.match(advancedArm, /return \{ kind: 'continue'/, 'an advanced recovery continues the loop instead of flipping Failed');
  assert.doesNotMatch(advancedArm, /status: 'Failed'/, 'the advanced arm never reaches the Failed flip');
  assert.match(block, /wmwRecovery\.kind === 'exhausted'/, 'handles ladder exhaustion');
  assert.match(block, /recordExitReason\(statePath, 'recovery_exhausted'\)/, 'exhausted ladder escalates to recovery_exhausted');
});

test('AC-R-WMNP-4: reuses the shared ladder seam, not a forked parallel implementation', () => {
  // The wmw path and the closer_handoff_terminal path call the SAME helper.
  const calls = (SRC.match(/attemptRecoveryBeforeTerminal\(/g) || []).length;
  assert.ok(calls >= 2, 'attemptRecoveryBeforeTerminal is shared by closer + wmw paths (>=2 callsites)');
  // Ledger reuse: recovery attempts are appended to state.recovery_attempts (R-ORSR-1), no new array.
  assert.match(SRC, /s\.recovery_attempts\.push\(attempt\)/, 'reuses state.recovery_attempts ledger');
});

test('AC-R-WMNP-4: attemptRecoveryBeforeTerminal seam runs and returns a RecoveryOutcome on no-evidence ticket', async () => {
  const { attemptRecoveryBeforeTerminal } = await import('../bin/mux-runner.js');
  const os = await import('node:os');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmnp-ladder-'));
  try {
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true, working_dir: sessionDir, step: 'implement', iteration: 6,
      max_iterations: 100, worker_timeout_seconds: 3600, start_time_epoch: 1,
      completion_promise: null, original_prompt: 'AC-R-WMNP-4', current_ticket: 'lad00001',
      history: [], started_at: new Date(0).toISOString(), session_dir: sessionDir,
      schema_version: 5, recovery_attempts: [], activity: [],
    }, null, 2));
    fs.mkdirSync(path.join(sessionDir, 'lad00001'), { recursive: true });

    // No git repo, no plan, no dirty tree → no recoverable evidence → fall_through
    // (the ladder ran but found nothing to advance). Proves the seam is reachable
    // and returns a well-formed RecoveryOutcome rather than throwing.
    const outcome = attemptRecoveryBeforeTerminal({
      sessionDir, statePath, extensionRoot: sessionDir, workingDir: sessionDir,
      ticketId: 'lad00001', iteration: 6, flags: null, log: () => {},
    });
    assert.ok(['advanced', 'fall_through', 'exhausted'].includes(outcome.kind),
      `returns a RecoveryOutcome kind, got ${outcome.kind}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
