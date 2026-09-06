// @tier: fast
//
// R-ORSR-3 (e8f46d84): plan_converged_uncommitted taxonomy → execute-converged-plan.
// Covers the four machine-checkable ACs of the ticket:
//   AC1 — approval predicate: plan present + plan_review APPROVED → eligible; missing either → not.
//   AC2 — INV (taxonomy route): clean tree + approved plan classifies plan_converged_uncommitted
//         and the ladder routes to execute-converged-plan.
//   AC3 — partial-failure: a 3-Phase plan whose Phase 3 fails commits Phases 1–2, no Done.
//   (plus) plan-phase parser coverage for the authored `## Phase N — Title` + `**Verify:**` format.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../services/recovery-controller.js');

// ---- AC1: approval predicate -----------------------------------------------

test('AC1 isConvergedPlanEligible: plan present + review APPROVED → eligible', async () => {
  const { isConvergedPlanEligible } = await load();
  assert.equal(isConvergedPlanEligible({ planArtifactExists: true, planReviewApproved: true }), true);
});

test('AC1 isConvergedPlanEligible: missing plan artifact → not eligible', async () => {
  const { isConvergedPlanEligible } = await load();
  assert.equal(isConvergedPlanEligible({ planArtifactExists: false, planReviewApproved: true }), false);
});

test('AC1 isConvergedPlanEligible: plan present but review not APPROVED → not eligible', async () => {
  const { isConvergedPlanEligible } = await load();
  assert.equal(isConvergedPlanEligible({ planArtifactExists: true, planReviewApproved: false }), false);
});

// ---- AC2: ladder routing ---------------------------------------------------

test('AC2 INV taxonomy route: approved plan + no diff → ladder advances via execute-converged-plan', async () => {
  const { runRecoveryLadder } = await load();
  const attempts = [];
  let planCalls = 0;
  const out = runRecoveryLadder({
    iteration: 11,
    ticketId: 'tkt-orsr3',
    assessEvidence: () => ({ treeDirty: false, planConvergedUncommitted: true, noWorkProduced: false }),
    runArmedGate: () => ({ ok: false }),
    commitAndFlipDone: () => ({ ok: false }),
    spawnRemediator: () => false,
    executeConvergedPlan: () => { planCalls += 1; return { ok: true }; },
    appendAttempt: (a) => attempts.push(a),
    log: () => {},
  });
  assert.deepEqual(out, { kind: 'advanced', strategy: 'execute-converged-plan' });
  assert.equal(planCalls, 1, 'executor invoked exactly once');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].strategy, 'execute-converged-plan');
  assert.equal(attempts[0].outcome, 'success');
});

// ---- AC3: partial-failure phase loop ---------------------------------------

test('AC3 executePhaseLoop: 3-Phase plan, Phase 3 fails Verify → commits 1-2, ok:false, never Done', async () => {
  const { executePhaseLoop } = await load();
  const phases = [
    { index: 1, title: 'one', verify: 'true' },
    { index: 2, title: 'two', verify: 'true' },
    { index: 3, title: 'three', verify: 'false' },
  ];
  const committedPhases = [];
  const result = executePhaseLoop({
    phases,
    executePhase: (p) => ({ ok: p.index !== 3 }), // Phase 3 fails its verify
    commitPhase: (p) => { committedPhases.push(p.index); return { ok: true }; },
  });
  assert.equal(result.ok, false, 'overall not-ok → ladder will not mark Done');
  assert.equal(result.committed, 2, 'Phases 1 and 2 committed before Phase 3 broke');
  assert.equal(result.failedIndex, 2, '0-indexed failing phase');
  assert.deepEqual(committedPhases, [1, 2], 'Phase 3 was never committed');
});

test('AC3 executePhaseLoop: all phases pass → ok:true, all committed', async () => {
  const { executePhaseLoop } = await load();
  const phases = [
    { index: 1, title: '', verify: 'true' },
    { index: 2, title: '', verify: 'true' },
  ];
  const result = executePhaseLoop({
    phases,
    executePhase: () => ({ ok: true }),
    commitPhase: () => ({ ok: true }),
  });
  assert.deepEqual(result, { ok: true, committed: 2, failedIndex: null });
});

test('AC3 executePhaseLoop: empty plan → ok:false (honest failure, nothing to run)', async () => {
  const { executePhaseLoop } = await load();
  const result = executePhaseLoop({ phases: [], executePhase: () => ({ ok: true }), commitPhase: () => ({ ok: true }) });
  assert.deepEqual(result, { ok: false, committed: 0, failedIndex: null });
});

test('AC3 executePhaseLoop: commit blocked on Phase 2 → committed 1, stops, ok:false', async () => {
  const { executePhaseLoop } = await load();
  const phases = [
    { index: 1, title: '', verify: 'true' },
    { index: 2, title: '', verify: 'true' },
    { index: 3, title: '', verify: 'true' },
  ];
  const result = executePhaseLoop({
    phases,
    executePhase: () => ({ ok: true }),
    commitPhase: (p) => ({ ok: p.index === 1 }), // commit fails at Phase 2
  });
  assert.equal(result.ok, false);
  assert.equal(result.committed, 1);
  assert.equal(result.failedIndex, 1);
});

test('AC3 executePhaseLoop: a throwing adapter is contained as not-ok (INV-RUNG-ERROR-CONTAINED)', async () => {
  const { executePhaseLoop } = await load();
  const result = executePhaseLoop({
    phases: [{ index: 1, title: '', verify: 'x' }],
    executePhase: () => { throw new Error('boom'); },
    commitPhase: () => ({ ok: true }),
  });
  assert.deepEqual(result, { ok: false, committed: 0, failedIndex: 0 });
});

// ---- parser coverage: real plan format -------------------------------------

test('parsePlanPhases: parses `## Phase N — Title` headers + first `**Verify:**` command', async () => {
  const { parsePlanPhases } = await load();
  const md = [
    '# Plan',
    '',
    '## Phase 1 — RecoveryController module',
    'Goal: build it.',
    '**Verify:** `cd extension && npx tsc --noEmit` (compiles); `node --test ...`',
    '',
    '## Phase 2 — Wire adapters',
    'Steps: do the thing.',
    '**Verify:** `grep -c "foo(" src/bin/mux-runner.ts`',
    '',
  ].join('\n');
  const phases = parsePlanPhases(md);
  assert.equal(phases.length, 2);
  assert.deepEqual(phases[0], { index: 1, title: 'RecoveryController module', verify: 'cd extension && npx tsc --noEmit' });
  assert.deepEqual(phases[1], { index: 2, title: 'Wire adapters', verify: 'grep -c "foo(" src/bin/mux-runner.ts' });
});

test('parsePlanPhases: phase with no Verify line → verify:null; non-phase blocks ignored', async () => {
  const { parsePlanPhases } = await load();
  const md = '## Overview\nblah\n\n## Phase 1 — Solo\nNo verify here.\n';
  const phases = parsePlanPhases(md);
  assert.equal(phases.length, 1);
  assert.deepEqual(phases[0], { index: 1, title: 'Solo', verify: null });
});

test('parsePlanPhases: no phases at all → empty array', async () => {
  const { parsePlanPhases } = await load();
  assert.deepEqual(parsePlanPhases('# Plan\nNothing here.\n'), []);
});
