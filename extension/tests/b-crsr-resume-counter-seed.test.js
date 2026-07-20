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

import { readResumePhasePlan } from '../bin/pipeline-runner.js';

const PHASES = ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'];

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
 * Replays `finalizePipeline`'s predicate over a resume: seed the counters from
 * the plan, then credit every phase the loop will actually run from
 * `plan.index`. This is the real data flow — index and counters feeding one
 * predicate — not the plan object inspected in isolation.
 */
function pipelineFailedAfterFullySuccessfulResume(plan) {
  const counters = { completed: plan.completed, skipped: plan.skipped };
  for (let i = plan.index; i < PHASES.length; i++) counters.completed++;
  return (counters.completed + counters.skipped) < PHASES.length;
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
  assert.equal(plan.completed, 2);
  assert.equal(plan.skipped, 0);
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
  assert.equal(plan.completed, 1);
  assert.equal(plan.skipped, 2);
  assert.equal(pipelineFailedAfterFullySuccessfulResume(plan), false);
});

test('AC-CWRR-6: cold start seeds zero counts (counters must not be pre-credited)', () => {
  const sessionDir = mkSession();
  // No status file at all.
  const plan = readResumePhasePlan(runtimeFor(sessionDir));
  assert.deepEqual(plan, { index: 0, completed: 0, skipped: 0 });
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
    assert.deepEqual(plan, { index: 0, completed: 0, skipped: 0 }, `status=${status}`);
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
    assert.equal(plan.skipped, 0, `skipped_phases=${String(skipped)}`);
    assert.equal(plan.completed, 2, `skipped_phases=${String(skipped)}`);
  }
});
