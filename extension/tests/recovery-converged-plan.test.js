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

// ---- AP-EXT-ITER227-01: the heading grammar matches the authored corpus -----
//
// `parsePlanPhases` used to accept ONE spelling — `## Phase N` with an em-dash or
// hyphen separator — of a heading nothing produces: no template, agent file or command
// prompt pins the level or the separator, so both are whatever the authoring model wrote.
// Measured over the operator's 72 live `plan_*.md` artifacts, 45 (63%) parsed to ZERO
// phases, hiding 177 of 283 authored headings, every one of them headed `### Phase N`.
//
// A zero-phase parse is not a degraded parse: `readConvergedPlanPhases` maps it to null,
// `executeConvergedPlanAdapter` returns `{ok:false}`, and the recovery ladder escalates to
// the terminal `recovery_exhausted` — discarding the diff the re-execution seam just
// produced. So this is a case TABLE over the live spellings, not a row per spelling: the
// grammar must not enumerate levels or separators at all, and a new authored spelling must
// need no new row here.
const ITER227_SHAPES = [
  ['h2 em-dash (the one spelling the old grammar accepted)', '## Phase 1 — structural: add the resolver'],
  ['h3 em-dash (45 of 72 live plans)', '### Phase 1 — structural: add the resolver'],
  ['h3 colon (`### Phase 1: Confirm no regression since research`)', '### Phase 1: structural: add the resolver'],
  ['h2 colon', '## Phase 1: structural: add the resolver'],
  ['h4 hyphen', '#### Phase 1 - structural: add the resolver'],
  ['h3 en-dash', '### Phase 1 – structural: add the resolver'],
  ['no separator at all', '### Phase 1 structural: add the resolver'],
];

for (const [label, heading] of ITER227_SHAPES) {
  test(`AP-EXT-ITER227-01: ${label} parses to the same Phase`, async () => {
    const { parsePlanPhases } = await load();
    const md = [
      '# Plan — b3 (37ec5fdf)',
      '',
      '## Phases',
      '',
      heading,
      'Edit the resolver, no call site changed.',
      '**Verify:** `./node_modules/.bin/tsc --noEmit`',
      '',
    ].join('\n');
    assert.deepEqual(parsePlanPhases(md), [{
      index: 1,
      title: 'structural: add the resolver',
      verify: './node_modules/.bin/tsc --noEmit',
    }], `heading spelling must not decide membership: ${heading}`);
  });
}

test('AP-EXT-ITER227-01: every authored Phase of a multi-phase H3 plan is executable', async () => {
  const { parsePlanPhases } = await load();
  // The shape of a real `### Phase N` plan (fa96d062/plan_2026-09-07.md), trimmed.
  const md = [
    '# Plan — G1 (fa96d062)',
    '',
    '## Scope',
    'One file.',
    '',
    '## Phases',
    '',
    '### Phase 1 — structural: add the resolver (no call site changed)',
    '**Verify:** `./node_modules/.bin/tsc --noEmit`',
    '',
    '### Phase 2 — behavioural: F4 (`:918`)',
    '**Verify:** `node --test tests/mux-runner.test.js`',
    '',
    '### Phase 3 — full fast tier',
    '**Verify:** `npm run test:fast`',
    '',
    '## Self-check',
    'Not a phase.',
    '',
  ].join('\n');
  const phases = parsePlanPhases(md);
  assert.equal(phases.length, 3, 'all three authored phases must be visible');
  assert.deepEqual(phases.map(p => p.index), [1, 2, 3]);
  assert.deepEqual(phases.map(p => p.title), [
    'structural: add the resolver (no call site changed)',
    'behavioural: F4 (`:918`)',
    'full fast tier',
  ]);
  assert.ok(phases.every(p => p.verify), 'each phase carries its own verify command');
});

// Over-rejection controls. The fix widens a grammar, so it must be shown NOT to have
// widened into the surrounding prose — otherwise `executePhaseLoop` would run phases the
// author never wrote. `## Phases` is the plans' own section header: 43 live occurrences,
// i.e. more than half the corpus carries one directly above the real headings.
const ITER227_NON_PHASES = [
  ['the `## Phases` section header (43 live occurrences)', '## Phases'],
  ['a `### Phases` section header', '### Phases'],
  ['a phase-less unit name (`### P1 — the seam bound`)', '### P1 — the seam bound'],
  ['prose naming a phase', 'See Phase 1 below for the resolver.'],
  ['a non-heading line that starts with a hash', '#Phase 1 — not a heading'],
  ['a verify-command heading (`### Verify command`)', '### Verify command (confirms the premise)'],
];

for (const [label, line] of ITER227_NON_PHASES) {
  test(`AP-EXT-ITER227-01 control: ${label} is not a Phase`, async () => {
    const { parsePlanPhases } = await load();
    assert.deepEqual(
      parsePlanPhases(`# Plan\n\n${line}\nSome body text.\n`),
      [],
      `must not be read as an authored Phase: ${line}`,
    );
  });
}

test('AP-EXT-ITER227-01 control: a section header does not absorb the real Phase below it', async () => {
  const { parsePlanPhases } = await load();
  const phases = parsePlanPhases(
    '# Plan\n\n## Phases\n\n### Phase 2 — the only real one\n\n**Verify:** `true`\n',
  );
  assert.deepEqual(phases, [{ index: 2, title: 'the only real one', verify: 'true' }]);
});
