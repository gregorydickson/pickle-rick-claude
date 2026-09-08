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

// ---- AP-EXT-ITER228-01: the verify-marker grammar matches the authored corpus ----
//
// One field over from AP-EXT-ITER227-01, and the same class: `PLAN_PHASE_VERIFY_RE` demanded
// the exact `**Verify:**` decoration of a marker NOTHING produces — the plan prompt asks for
// "Phases with Goal/Steps/Verify command" and pins no spelling. Measured over the operator's
// 283 authored phase blocks in 72 live `plan_*.md` artifacts, that spelling parsed 95; the
// other 188 were `verify: null`. Null is not a degraded verify: `executeConvergedPlanAdapter`
// returns not-ok on it, `executePhaseLoop` STOPS there, and in 40 of the 69 phase-carrying
// plans the FIRST phase was the null one — so the entire diff the re-execution seam had just
// produced was abandoned uncommitted and the ladder escalated to `recovery_exhausted`.
//
// A case TABLE over the live decorations, not a row per decoration: the grammar must not
// enumerate them at all, and a new authored decoration must need no new row here.
const ITER228_MARKERS = [
  ['`**Verify:**` (the one decoration the old grammar accepted)', '**Verify:** `node --test tests/x.test.js`'],
  ['`**Verify**:` — emphasis outside the colon (4 live blocks)', '**Verify**: `node --test tests/x.test.js`'],
  ['`**Verify.**` — a period, not a colon (5 live blocks)', '**Verify.** `node --test tests/x.test.js`'],
  ['bare `Verify:` with no emphasis at all (6 live blocks)', 'Verify: `node --test tests/x.test.js`'],
  ['a list bullet: `- Verify:`', '- Verify: `node --test tests/x.test.js`'],
  ['a bulleted bold marker: `- **Verify:**`', '- **Verify:** `node --test tests/x.test.js`'],
  ['a trailing word: `**Verify command:**`', '**Verify command:** `node --test tests/x.test.js`'],
  ['lower-case `verify:`', 'verify: `node --test tests/x.test.js`'],
];

for (const [label, markerLine] of ITER228_MARKERS) {
  test(`AP-EXT-ITER228-01: ${label} yields the same runnable phase`, async () => {
    const { parsePlanPhases } = await load();
    const md = ['# Plan', '', '### Phase 1 — behavioural: widen the marker', 'Edit one constant.', markerLine, ''].join('\n');
    assert.deepEqual(parsePlanPhases(md), [{
      index: 1,
      title: 'behavioural: widen the marker',
      verify: 'node --test tests/x.test.js',
    }], `marker decoration must not decide whether the phase is runnable: ${markerLine}`);
  });
}

test('AP-EXT-ITER228-01: a multi-phase plan mixing decorations runs every phase', async () => {
  const { parsePlanPhases } = await load();
  // The shape of a real mixed-decoration plan (b5ffdb76, 950cc70c), trimmed.
  const md = [
    '# Plan — mixed decorations',
    '',
    '## Phases',
    '',
    '### Phase 1 — structural',
    '**Verify:** `./node_modules/.bin/tsc --noEmit`',
    '',
    '### Phase 2 — behavioural',
    'Verify: `node --test tests/mux-runner.test.js`',
    '',
    '### Phase 3 — full tier',
    '- Verify: `npm run test:fast`',
    '',
  ].join('\n');
  const phases = parsePlanPhases(md);
  assert.deepEqual(phases.map(p => p.verify), [
    './node_modules/.bin/tsc --noEmit',
    'node --test tests/mux-runner.test.js',
    'npm run test:fast',
  ], 'no phase may be the null one that stops the loop over the others’ committed work');
});

// Over-rejection controls. The fix widens a matcher whose capture is handed to a SHELL, so
// it must be shown not to have widened into the surrounding prose. The line anchor and the
// `\b` are the two load-bearing halves, and both point fail-CLOSED.

test('AP-EXT-ITER228-01 control: prose naming verification must not SHADOW the real command', async () => {
  const { parsePlanPhases } = await load();
  // Measured: 4 live blocks are exactly this shape. Unanchored, the capture is
  // `parseLlmJudgeOutput` — an identifier, run as a command, in place of the real one.
  const md = [
    '### Phase 2 — Regression test (AC-R3, mutation-verified)',
    '3. Mutation-verify: temporarily revert the `parseLlmJudgeOutput` full-shape return to',
    '   the scalar form and re-run.',
    'Verify: `node --test tests/microverse-helpers.test.js`',
    '',
  ].join('\n');
  assert.equal(parsePlanPhases(md)[0].verify, 'node --test tests/microverse-helpers.test.js');
});

test('AP-EXT-ITER228-01 control: a mid-line mention of verifying is not a verify line', async () => {
  const { parsePlanPhases } = await load();
  const md = [
    '### Phase 1 — Solo',
    'Read the interface and verify it against `resolveHardeningSettings` by eye.',
    '',
  ].join('\n');
  assert.equal(parsePlanPhases(md)[0].verify, null, 'prose must not become a shell command');
});

test('AP-EXT-ITER228-01 control: `Verifying`/`verified` prose is not the marker', async () => {
  const { parsePlanPhases } = await load();
  const md = [
    '### Phase 1 — Solo',
    'Verifying the emitter against `git log --oneline -1` is the point of Phase 2.',
    'verified: `cat plan.md` was read in Research.',
    '',
  ].join('\n');
  assert.equal(parsePlanPhases(md)[0].verify, null, '`Verify` must be the line’s own whole first word');
});

test('AP-EXT-ITER228-01 control: a verify line with no backticked span stays null', async () => {
  const { parsePlanPhases } = await load();
  // 102 of the 283 live blocks are this: an authored verification with nothing runnable.
  // The absent command stays absent — this fix parses markers, it does not invent commands.
  const md = ['### Phase 1 — Solo', '**Verify:** all four commands exit 0.', ''].join('\n');
  assert.equal(parsePlanPhases(md)[0].verify, null);
});

test('AP-EXT-ITER228-01 control: the self-check bullet plans carry is not a verify line', async () => {
  const { parsePlanPhases } = await load();
  // `## Self-check` is not a Phase heading, so its bullets sit inside the LAST phase's block.
  const md = [
    '### Phase 1 — Solo',
    '**Verify:** `npm run test:fast`',
    '',
    '## Self-check',
    '- Every phase has a verify command? Yes, runnable as written.',
    '- No magic steps: every step names its exact file and exact verify command.',
    '',
  ].join('\n');
  assert.equal(parsePlanPhases(md)[0].verify, 'npm run test:fast');
});

// ---- AP-EXT-ITER237-01: the grammar's STRUCTURAL properties, not its vocabulary ----
//
// AP-EXT-ITER227-01 and AP-EXT-ITER228-01 both widened this grammar's VOCABULARY (heading
// levels, separators, marker decorations) and pinned each widening exhaustively. What neither
// covers is the grammar's three remaining load-bearing STRUCTURAL properties — the two line
// anchors and the optional title — and a 9-mutant battery over `recovery-controller.js`,
// driven by every suite that reaches `parsePlanPhases` (368 cases), found all three amputable
// with the suites GREEN. They are pinned here because each one lands on the SAME terminal the
// two vocabulary findings were about: a phase whose `verify` is null stops `executePhaseLoop`
// where it stands, and the ladder escalates to `recovery_exhausted` — abandoning the diff the
// re-execution seam had just produced.
//
// These are properties, not lists: a plan citing a heading in prose must not become one, and
// an untitled heading must stay a Phase. No spelling is enumerated, so a new authored spelling
// needs no new row.

// Plans cite their own headings in prose constantly ("redo ### Phase 1 from scratch", "this
// bundle follows the ## Phase 3 convention"). BOTH anchors defend against it, at different
// positions, and neither is redundant: the split anchor governs a mention INSIDE a phase
// block, the header anchor a mention in the PREAMBLE above the first real heading.
const ITER237_PROSE_MENTIONS = [
  {
    label: 'inside a phase block (the split anchor)',
    // Unanchored split: the block is cut in two, the real Phase 1 loses its verify to the
    // fragment below the cut, and a phantom Phase 1 titled `from scratch.` is fabricated.
    md: [
      '# Plan', '', '## Phases', '',
      '### Phase 1 — structural: add the resolver',
      'Steps: edit the resolver. If it fails, redo ## Phase 1 from scratch.',
      '**Verify:** `./node_modules/.bin/tsc --noEmit`',
      '',
    ].join('\n'),
    expected: [{ index: 1, title: 'structural: add the resolver', verify: './node_modules/.bin/tsc --noEmit' }],
  },
  {
    label: 'in the preamble above the first heading (the header anchor)',
    // Unanchored header: the preamble itself parses as a phantom `Phase 3` carrying
    // `verify: null`, and it sorts FIRST — so the loop stops before any real phase runs.
    md: [
      '# Plan', '',
      'Context: this bundle follows the ## Phase 3 convention from the prior plan.',
      '',
      '### Phase 1 — the only real phase',
      '**Verify:** `npm run test:fast`',
      '',
    ].join('\n'),
    expected: [{ index: 1, title: 'the only real phase', verify: 'npm run test:fast' }],
  },
];

for (const { label, md, expected } of ITER237_PROSE_MENTIONS) {
  test(`AP-EXT-ITER237-01: a heading cited mid-line ${label} is prose, not a Phase`, async () => {
    const { parsePlanPhases } = await load();
    assert.deepEqual(
      parsePlanPhases(md),
      expected,
      'a mid-line mention must neither fabricate a phase nor strip the real one of its verify',
    );
  });
}

test('AP-EXT-ITER237-01: a title-less heading is an UNTITLED phase, never an invisible one', async () => {
  const { parsePlanPhases } = await load();
  // The title is optional BY CONSTRUCTION (`(.*)`), and that is load-bearing: requiring it
  // makes a bare `### Phase 1` fail the header match, so the phase is dropped from the plan
  // silently rather than run without a title. That is precisely the failure AP-EXT-ITER227-01
  // measured (a heading became invisible rather than untitled) surviving in a second axis.
  const md = [
    '# Plan', '', '## Phases', '',
    '### Phase 1',
    '**Verify:** `./node_modules/.bin/tsc --noEmit`',
    '',
    '### Phase 2 — behavioural',
    '**Verify:** `npm run test:fast`',
    '',
  ].join('\n');
  assert.deepEqual(parsePlanPhases(md), [
    { index: 1, title: '', verify: './node_modules/.bin/tsc --noEmit' },
    { index: 2, title: 'behavioural', verify: 'npm run test:fast' },
  ], 'an absent title costs a commit subject, never the phase');
});
