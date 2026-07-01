// @tier: fast
//
// AC-GA-REC-1 — Clean-Tree Converged Re-Execution.
//
// Subject: `executeConvergedPlanAdapter` (mux-runner.js) extended to recover the
// clean-tree-converged case by re-executing the approved plan against the RAW plan_*.md
// path (NEVER the verify-only parsed PlanPhase[]). The implement pass is injected via the
// `ReExecutionSeam` DI seam so these tests never spawn a real subprocess. Post-implement
// dirtiness and the idempotency state read are injected through `_testHooks`.
//
// Covers one case per AC:
//   AC-GA-REC-1  advances clean tree via per-Phase commit (real diff → executePhaseLoop)
//   AC-GA-REC-2  re-execution is handed the RAW plan_*.md path, not the PlanPhase[]
//   AC-GA-REC-3  idempotent no-op keyed on completion_commit + recovery_attempts ledger
//   AC-GA-REC-4  no-diff re-execution reconciles to terminal, does NOT loop
//   AC-GA-REC-5  implementer timeout escalates to recovery_exhausted
//   AC-GA-REC-7  dirty-tree rung-3 path unchanged (runRecoveryLadder, recovery-controller)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

// R-PTSB: mux-runner.js is a session-writing bin; sandbox the data root to tmpdir
// so activity writes and session lookups never touch the real ~/.local/share/pickle-rick.
const DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-ctr-data-')));
process.env.PICKLE_DATA_ROOT = DATA_ROOT;

const TICKET_ID = '28d95d77';

function mkTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-clean-tree-')));
}

/** Lay down a session dir with a ticket dir, a plan_<id>.md, and a linear ticket file. */
function scaffoldSession(sessionDir, { complexityTier = 'medium', completionCommit = '' } = {}) {
  const ticketDir = path.join(sessionDir, TICKET_ID);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `plan_${TICKET_ID}.md`),
    '# Plan\n\n## Phase 1 — Trivial\n\n**Verify:** `true`\n',
    'utf-8',
  );
  const fm = [
    '---',
    `id: ${TICKET_ID}`,
    'title: "Clean-tree re-execution"',
    'status: In Progress',
    `complexity_tier: ${complexityTier}`,
    ...(completionCommit ? [`completion_commit: ${completionCommit}`] : []),
    '---',
    '',
    '# Description',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${TICKET_ID}.md`), fm, 'utf-8');
  return ticketDir;
}

function writeState(sessionDir, obj) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(obj), 'utf-8');
  return statePath;
}

/** A real git repo so the fall-through executePhaseLoop can `git add -A` + `git commit`. */
function initGitRepo(dir) {
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], { cwd: dir });
}

// PICKLE_DATA_ROOT is set above (R-PTSB sandbox); lazy-load mux-runner after env is set.
// Kept separate from initGitRepo to keep the audit-test-isolation window checks clean.
const load = () => import('../bin/mux-runner.js');

test('AC-GA-REC-1: clean tree + real diff from implementer → advances via per-Phase commit', async () => {
  const { executeConvergedPlanAdapter } = await load();
  const sessionDir = mkTmp();
  const workingDir = mkTmp();
  initGitRepo(workingDir);
  scaffoldSession(sessionDir);
  const statePath = writeState(sessionDir, { recovery_attempts: [] });

  const logs = [];
  const result = executeConvergedPlanAdapter({
    sessionDir,
    ticketId: TICKET_ID,
    workingDir,
    statePath,
    log: (m) => logs.push(m),
    reExecutionSeam: {
      // Implement pass "produces a diff" by writing a real file into the repo so the
      // fall-through executePhaseLoop's `git add -A` + `git commit` succeed.
      spawnImplementPass: () => {
        fs.writeFileSync(path.join(workingDir, 'new-feature.txt'), 'implemented\n', 'utf-8');
        return { ok: true };
      },
    },
  });

  assert.deepEqual(result, { ok: true });
  // The phase was committed: HEAD advanced and the tree is clean afterwards.
  const headMsg = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: workingDir, encoding: 'utf-8' }).trim();
  assert.match(headMsg, /execute-converged-plan phase 1/);
});

test('AC-GA-REC-2: re-execution receives the RAW plan_*.md path, never a PlanPhase[]', async () => {
  const { executeConvergedPlanAdapter } = await load();
  const sessionDir = mkTmp();
  const workingDir = mkTmp();
  scaffoldSession(sessionDir);
  const statePath = writeState(sessionDir, { recovery_attempts: [] });

  let captured = null;
  executeConvergedPlanAdapter({
    sessionDir,
    ticketId: TICKET_ID,
    workingDir,
    statePath,
    log: () => {},
    _testHooks: { isPostImplementDirty: () => false }, // short-circuit after capture
    reExecutionSeam: {
      spawnImplementPass: (opts) => { captured = opts; return { ok: true }; },
    },
  });

  assert.ok(captured, 'spawnImplementPass was called');
  assert.equal(typeof captured.planPath, 'string');
  assert.ok(!Array.isArray(captured.planPath));
  assert.match(captured.planPath, new RegExp(`plan_${TICKET_ID}\\.md$`));
});

test('AC-GA-REC-3: idempotent no-op when prior success + completion_commit set', async () => {
  const { executeConvergedPlanAdapter } = await load();
  const sessionDir = mkTmp();
  const workingDir = mkTmp();
  scaffoldSession(sessionDir, { completionCommit: 'abc1234' });
  const statePath = writeState(sessionDir, {
    recovery_attempts: [{ strategy: 'execute-converged-plan', outcome: 'success', reason: 'x', iteration: 1 }],
  });

  let spawnCount = 0;
  const result = executeConvergedPlanAdapter({
    sessionDir,
    ticketId: TICKET_ID,
    workingDir,
    statePath,
    log: () => {},
    reExecutionSeam: {
      spawnImplementPass: () => { spawnCount += 1; return { ok: true }; },
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(spawnCount, 0, 'implement pass must NOT be spawned on idempotent no-op');
});

test('AC-GA-REC-4: no-diff re-execution reconciles to terminal (ok:false), no loop', async () => {
  const { executeConvergedPlanAdapter } = await load();
  const sessionDir = mkTmp();
  const workingDir = mkTmp();
  scaffoldSession(sessionDir);
  const statePath = writeState(sessionDir, { recovery_attempts: [] });

  const logs = [];
  let spawnCount = 0;
  const result = executeConvergedPlanAdapter({
    sessionDir,
    ticketId: TICKET_ID,
    workingDir,
    statePath,
    log: (m) => logs.push(m),
    _testHooks: { isPostImplementDirty: () => false }, // implementer produced zero diff
    reExecutionSeam: {
      spawnImplementPass: () => { spawnCount += 1; return { ok: true }; },
    },
  });

  assert.deepEqual(result, { ok: false });
  assert.equal(spawnCount, 1, 'implement pass ran exactly once — no loop');
  assert.ok(logs.some((m) => /zero-diff/.test(m) && /reconcil/i.test(m)));
});

test('AC-GA-REC-5: implementer timeout escalates to recovery_exhausted via the ladder', async () => {
  const { executeConvergedPlanAdapter } = await load();
  const { runRecoveryLadder } = await import('../services/recovery-controller.js');
  const sessionDir = mkTmp();
  const workingDir = mkTmp();
  scaffoldSession(sessionDir);
  const statePath = writeState(sessionDir, { recovery_attempts: [] });

  const attempts = [];
  const out = runRecoveryLadder({
    iteration: 3,
    ticketId: TICKET_ID,
    assessEvidence: () => ({ treeDirty: false, planConvergedUncommitted: true, noWorkProduced: false }),
    runArmedGate: () => ({ ok: false }),
    commitAndFlipDone: () => ({ ok: false }),
    spawnRemediator: () => false,
    appendAttempt: (a) => attempts.push(a),
    log: () => {},
    executeConvergedPlan: () => executeConvergedPlanAdapter({
      sessionDir,
      ticketId: TICKET_ID,
      workingDir,
      statePath,
      log: () => {},
      reExecutionSeam: {
        spawnImplementPass: () => ({ ok: false, timedOut: true }),
      },
    }),
  });

  assert.equal(out.kind, 'exhausted');
  assert.ok(attempts.some((a) => a.strategy === 'execute-converged-plan' && a.outcome === 'failed'));
});

test('AC-GA-REC-7: dirty-tree rung-3 path unchanged (commit-and-continue advances)', async () => {
  const { runRecoveryLadder } = await import('../services/recovery-controller.js');
  const attempts = [];
  const calls = { armedGate: 0, commit: 0, remediator: 0 };
  const out = runRecoveryLadder({
    iteration: 7,
    ticketId: TICKET_ID,
    assessEvidence: () => ({ treeDirty: true, planConvergedUncommitted: false, noWorkProduced: false }),
    runArmedGate: () => { calls.armedGate += 1; return { ok: true }; },
    commitAndFlipDone: () => { calls.commit += 1; return { ok: true, sha: 'deadbeef' }; },
    spawnRemediator: () => { calls.remediator += 1; return false; },
    appendAttempt: (a) => attempts.push(a),
    log: () => {},
  });

  assert.deepEqual(out, { kind: 'advanced', strategy: 'commit-and-continue', sha: 'deadbeef' });
  assert.equal(calls.remediator, 0, 'dirty-tree commit-and-continue path is unchanged');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].strategy, 'commit-and-continue');
});
