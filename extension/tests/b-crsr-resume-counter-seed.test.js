// @tier: fast
//
// AC-CWRR-6 regression tests.
//
// The R-CRSR crash-resume path (WS-3-FacetA) makes the phase loop SKIP the
// phases a prior process already finished. It read `completed_phases` to pick
// the start index but never seeded the in-memory `counters` from it. Since
// `finalizePipeline` computes
//
//     pipelineFailed = (counters.completed + counters.skipped) < phases.length
//
// a resumed run could never satisfy it: a pipeline that resumed at index 2 and
// then completed both remaining phases still reported completed=2 of 4. The
// three observable consequences, all in `finalizePipeline`:
//   1. a fully-successful resumed pipeline finalizes FAILED
//   2. the closer install()+tag(), gated `!pipelineFailed`, is SKIPPED
//   3. it exits 1, which can drive auto-resume retry loops
//
// The invariant these tests pin is the one the bug broke: the resume index and
// the seeded counts are two halves of ONE fact, so
//
//     seeded_completed + seeded_skipped + phases_the_loop_will_run === total
//
// Asserting only `plan.index` (as the WS-3-FacetA suite does) cannot catch
// this — the index was always correct; the counts were the missing half.
//
// R-PTSB: sandbox PICKLE_DATA_ROOT for every session-touching helper invocation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readResumePhasePlan, seedResumePhaseCounters, writePipelineStatus } from '../bin/pipeline-runner.js';

const PHASES = ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'];
const EMPTY_COUNTERS = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };

function mkSession() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-crsr-seed-')));
  process.env.PICKLE_DATA_ROOT = root; // R-PTSB sandbox
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function writeStatus(sessionDir, payload) {
  fs.writeFileSync(
    path.join(sessionDir, 'pipeline-status.json'),
    JSON.stringify(payload, null, 2),
  );
}

function runtimeFor(sessionDir) {
  return { sessionDir, config: { phases: [...PHASES] } };
}

/**
 * Replays `seedResumePhaseCounters` + `finalizePipeline`'s verdict over a resume: seed the
 * counters WHOLESALE from the plan (the production `Object.assign`), then credit every phase
 * the loop will actually run from `plan.index`. This is the real data flow — index and
 * counters feeding one predicate — not the plan object inspected in isolation.
 */
function resumedVerdict(plan) {
  const counters = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
  Object.assign(counters, plan.counters);
  for (let i = plan.index; i < PHASES.length; i++) counters.completed++;
  const pipelineFailed = (counters.completed + counters.skipped) < PHASES.length;
  return { counters, pipelineFailed, unsuccessful: pipelineFailed || counters.nonConvergent > 0 };
}

function pipelineFailedAfterFullySuccessfulResume(plan) {
  return resumedVerdict(plan).pipelineFailed;
}

test('AC-CWRR-6: resume seeds completed/skipped from the same status file that chose the index', () => {
  const sessionDir = mkSession();
  writeStatus(sessionDir, {
    status: 'running',
    current_phase: 'anatomy-park',
    completed_phases: 2,
    skipped_phases: 0,
    total_phases: 4,
  });
  const plan = readResumePhasePlan(runtimeFor(sessionDir));
  assert.equal(plan.index, 2);
  assert.equal(plan.counters.completed, 2);
  assert.equal(plan.counters.skipped, 0);
});

test('AC-CWRR-6: a fully-successful resumed pipeline does NOT finalize FAILED', () => {
  const sessionDir = mkSession();
  writeStatus(sessionDir, {
    status: 'running',
    current_phase: 'anatomy-park',
    completed_phases: 2,
    skipped_phases: 0,
    total_phases: 4,
  });
  const plan = readResumePhasePlan(runtimeFor(sessionDir));
  // Pre-fix this was `true` — closer install/tag skipped, exit code 1.
  assert.equal(pipelineFailedAfterFullySuccessfulResume(plan), false);
});

test('AC-CWRR-6: a resume whose prior phases were SKIPPED still reconciles to total', () => {
  const sessionDir = mkSession();
  writeStatus(sessionDir, {
    status: 'running',
    current_phase: 'szechuan-sauce',
    completed_phases: 1,
    skipped_phases: 2,
    total_phases: 4,
  });
  const plan = readResumePhasePlan(runtimeFor(sessionDir));
  assert.equal(plan.index, 3);
  assert.equal(plan.counters.completed, 1);
  assert.equal(plan.counters.skipped, 2);
  assert.equal(pipelineFailedAfterFullySuccessfulResume(plan), false);
});

test('AC-CWRR-6: cold start seeds zero counts (counters must not be pre-credited)', () => {
  const sessionDir = mkSession();
  // No status file at all.
  const plan = readResumePhasePlan(runtimeFor(sessionDir));
  assert.deepEqual(plan, { index: 0, counters: EMPTY_COUNTERS });
  // A cold-start run that completes every phase also reconciles.
  assert.equal(pipelineFailedAfterFullySuccessfulResume(plan), false);
});

test('AC-CWRR-6: a non-running prior status is a cold start, not a resume credit', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const sessionDir = mkSession();
    writeStatus(sessionDir, {
      status,
      current_phase: 'anatomy-park',
      completed_phases: 2,
      skipped_phases: 0,
      total_phases: 4,
    });
    const plan = readResumePhasePlan(runtimeFor(sessionDir));
    assert.deepEqual(plan, { index: 0, counters: EMPTY_COUNTERS }, `status=${status}`);
  }
});

test('AC-CWRR-6: malformed counts never seed a counter', () => {
  for (const skipped of [null, 'two', NaN, -1, 1.5, undefined]) {
    const sessionDir = mkSession();
    writeStatus(sessionDir, {
      status: 'running',
      current_phase: 'anatomy-park',
      completed_phases: 2,
      skipped_phases: skipped,
      total_phases: 4,
    });
    const plan = readResumePhasePlan(runtimeFor(sessionDir));
    assert.equal(plan.counters.skipped, 0, `skipped_phases=${String(skipped)}`);
    assert.equal(plan.counters.completed, 2, `skipped_phases=${String(skipped)}`);
  }
});

// AP-EXT-ITER185-01 regression.
//
// The seed above carried TWO of `PhaseCounters`' five members. The other three —
// `nonConvergent`, `phaseDispositions`, `phaseSkips` — record a phase that RAN but withheld
// its success verdict, and every one of them was dropped on resume. Four observable
// consequences, all measured on the shipped `bin/pipeline-runner.js` before the fix:
//   1. `unsuccessful = pipelineFailed || nonConvergent > 0` reads false, so the run REPORTS
//      SUCCESS over a verdict a prior phase explicitly withheld
//   2. `maybeRunCloserRelease` (gated `!unsuccessful`) cuts the closer install()+tag()
//   3. the terminal exit code is 0 instead of 1
//   4. `writeTerminalPipelineStatus` then hands `writePipelineStatus` the EMPTIED maps, and an
//      explicitly-supplied `{}` wins over the persisted record (AP-EXT-ITER90-01) — so the
//      last surviving attribution for the withholding is erased from disk
//
// The counts were never the whole fact: the resume index and the whole ledger are two halves
// of ONE status read. These cases exercise that flow end to end — persisted status ->
// readResumePhasePlan -> seeded counters -> verdict -> the real terminal writePipelineStatus.

const WITHHELD_STATUS = {
  status: 'running',
  current_phase: 'anatomy-park',
  completed_phases: 2,
  skipped_phases: 0,
  total_phases: 4,
  phase_skips: { citadel: 'empty_scope' },
  phase_dispositions: { pickle: 'done_over_red_worker_gate_tests:abc123' },
};

test('AP-EXT-ITER185-01: a resume carries the prior phase dispositions, not just the counts', () => {
  const sessionDir = mkSession();
  writeStatus(sessionDir, WITHHELD_STATUS);
  const plan = readResumePhasePlan(runtimeFor(sessionDir));
  assert.equal(plan.index, 2);
  assert.deepEqual(plan.counters.phaseDispositions, WITHHELD_STATUS.phase_dispositions);
  assert.deepEqual(plan.counters.phaseSkips, WITHHELD_STATUS.phase_skips);
  // Derived from the dispositions map — every `nonConvergent` raise writes one alongside it.
  assert.equal(plan.counters.nonConvergent, 1);
});

test('AP-EXT-ITER185-01: a resumed run does NOT report success over a withheld verdict', () => {
  const sessionDir = mkSession();
  writeStatus(sessionDir, WITHHELD_STATUS);
  const verdict = resumedVerdict(readResumePhasePlan(runtimeFor(sessionDir)));
  // Every phase executed, so this is NOT a phase shortfall — the run reached completion.
  assert.equal(verdict.pipelineFailed, false);
  // Pre-fix this was `false`: success reported, closer install()+tag() cut, exit 0.
  assert.equal(verdict.unsuccessful, true, 'the withheld verdict must survive the crash boundary');
});

test('AP-EXT-ITER185-01: the terminal status write does not erase the carried attribution', () => {
  const sessionDir = mkSession();
  writeStatus(sessionDir, WITHHELD_STATUS);
  const { counters, unsuccessful } = resumedVerdict(readResumePhasePlan(runtimeFor(sessionDir)));
  // Exactly what `writeTerminalPipelineStatus` writes, through the real writer.
  writePipelineStatus(sessionDir, unsuccessful ? 'failed' : 'completed', {
    current_phase: null,
    completed_phases: counters.completed,
    skipped_phases: counters.skipped,
    total_phases: PHASES.length,
    phase_skips: counters.phaseSkips,
    phase_dispositions: counters.phaseDispositions,
  });
  const after = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf8'));
  assert.equal(after.status, 'failed');
  assert.deepEqual(after.phase_dispositions, WITHHELD_STATUS.phase_dispositions);
  assert.deepEqual(after.phase_skips, WITHHELD_STATUS.phase_skips);
});

test('AP-EXT-ITER185-01: a malformed or absent ledger seeds nothing, never a fabricated withholding', () => {
  for (const phase_dispositions of [undefined, null, 'pickle', [], 42, { pickle: 7 }]) {
    const sessionDir = mkSession();
    writeStatus(sessionDir, { ...WITHHELD_STATUS, phase_skips: undefined, phase_dispositions });
    const plan = readResumePhasePlan(runtimeFor(sessionDir));
    const label = `phase_dispositions=${JSON.stringify(phase_dispositions)}`;
    assert.deepEqual(plan.counters.phaseDispositions, {}, label);
    assert.deepEqual(plan.counters.phaseSkips, {}, label);
    assert.equal(plan.counters.nonConvergent, 0, label);
    // A read failure must not invent a withholding either.
    assert.equal(resumedVerdict(plan).unsuccessful, false, label);
  }
});

test('AP-EXT-ITER185-01: the SHIPPED seed applies the whole ledger, not a chosen subset', () => {
  const sessionDir = mkSession();
  writeStatus(sessionDir, WITHHELD_STATUS);
  // Drive the production seeder, not a replay of it — a seed that carried `completed`/`skipped`
  // only is exactly the shape this finding is about, and a helper that re-implements
  // `Object.assign` here could not tell the two apart.
  const counters = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
  const lines = [];
  const index = seedResumePhaseCounters(runtimeFor(sessionDir), counters, (m) => lines.push(m));
  assert.equal(index, 2);
  assert.deepEqual(counters, {
    completed: 2,
    skipped: 0,
    phaseSkips: WITHHELD_STATUS.phase_skips,
    nonConvergent: 1,
    phaseDispositions: WITHHELD_STATUS.phase_dispositions,
  });
  assert.match(lines.join('\n'), /nonConvergent=1/, 'the operator log names the carried withholding');
});

test('AP-EXT-ITER185-01: a cold start seeds nothing through the shipped seeder', () => {
  const sessionDir = mkSession();
  const counters = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
  const lines = [];
  assert.equal(seedResumePhaseCounters(runtimeFor(sessionDir), counters, (m) => lines.push(m)), 0);
  assert.deepEqual(counters, EMPTY_COUNTERS);
  assert.equal(lines.length, 0, 'a cold start logs no crash-resume line');
});
