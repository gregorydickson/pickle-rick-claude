// @tier: fast
/**
 * pipeline-nonstop-halt-guard.test.js (AC-NS-4)
 *
 * WS-6: classifyMicroverseHaltDecision must route the three new strict-mode Template-A
 * non-convergent dispositions (stalled_below_target, iteration_budget_exhausted,
 * time_budget_exhausted) to run-finalize-gate-incomplete instead of falling through to the
 * unattributed default abort. Pins the nonstop invariant: under default settings, every
 * Template-A non-convergent disposition (plus the DEFAULT/unknown case) leaves
 * shouldHaltAfterPhase===false and isFatalPhaseFailure===false.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  classifyMicroverseHaltDecision,
  isFatalPhaseFailure,
  shouldHaltAfterPhase,
} from '../bin/pipeline-runner.js';
import { classifyMicroverseDisposition } from '../bin/microverse-runner.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStateWithExitReason(sessionDir, exitReason) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'nonstop halt guard test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    backend: 'claude',
    exit_reason: exitReason,
  }, null, 2));
  return statePath;
}

function makeRuntime(sessionDir, statePath, phase) {
  return {
    sessionDir,
    extensionRoot: process.cwd(),
    statePath,
    config: { phases: [phase], target: sessionDir },
    target: sessionDir,
    workingDir: sessionDir,
    repoRoot: sessionDir,
    backend: 'claude',
    phaseEnv: {},
    log: () => {},
  };
}

// The full Template-A non-convergent disposition set plus an unrecognized/DEFAULT reason.
const TEMPLATE_A_DISPOSITIONS = [
  'stalled_below_target',
  'iteration_budget_exhausted',
  'time_budget_exhausted',
  'anatomy_non_convergent',
  'no_progress',
  'stopped',
  'approach_exhaustion',
  'limit_reached',
];
const DEFAULT_CASE = 'not-a-real-exit';
const ALL_CASES = [...TEMPLATE_A_DISPOSITIONS, DEFAULT_CASE];
const PHASES = ['anatomy-park', 'szechuan-sauce'];

describe('AC-NS-4: nonstop invariant — Template-A dispositions never halt under default settings', () => {
  for (const phase of PHASES) {
    for (const exitReason of ALL_CASES) {
      test(`${phase} / exit_reason=${exitReason}: isFatalPhaseFailure===false, shouldHaltAfterPhase===false`, () => {
        const sessionDir = tmpDir('nonstop-halt-guard-');
        const statePath = writeStateWithExitReason(sessionDir, exitReason);
        const runtime = makeRuntime(sessionDir, statePath, phase);

        assert.equal(isFatalPhaseFailure(phase, runtime), false);
        assert.equal(shouldHaltAfterPhase(phase, 1, runtime), false);
      });
    }
  }
});

describe('AC-NS-4: strict-mode arms route the three new dispositions to run-finalize-gate-incomplete', () => {
  for (const exitReason of ['stalled_below_target', 'iteration_budget_exhausted', 'time_budget_exhausted']) {
    test(`classifyMicroverseHaltDecision(${exitReason}) → run-finalize-gate-incomplete, non-null recognizedExitReason`, () => {
      assert.deepEqual(classifyMicroverseHaltDecision(exitReason), {
        action: 'run-finalize-gate-incomplete',
        recognizedExitReason: exitReason,
      });
    });
  }
});

/**
 * d03738ee (harden): the four Template-A dispositions the original literal chain omitted.
 * The map classifies all of them `non-convergent`, but they are in neither
 * MICROVERSE_FATAL_REASONS nor MICROVERSE_FAILURE_REASONS, so pre-fix they fell straight
 * through to the unattributed abort. `limit_reached` is still live-emitted by
 * microverse-runner (rate-limit poll + wait-budget exhaustion), so this was reachable.
 */
describe('AC-NS-4: map-recognized dispositions the literal chain omitted also route to finalize-gate-incomplete', () => {
  for (const exitReason of ['limit_reached', 'no_progress', 'stopped', 'approach_exhaustion']) {
    test(`classifyMicroverseHaltDecision(${exitReason}) → run-finalize-gate-incomplete, non-null recognizedExitReason`, () => {
      assert.deepEqual(classifyMicroverseHaltDecision(exitReason), {
        action: 'run-finalize-gate-incomplete',
        recognizedExitReason: exitReason,
      });
    });
  }
});

/**
 * Drift guard: derives the expectation from the disposition map rather than a hand-written
 * list, so a future addition to MicroverseExitReason classified `non-convergent` fails here
 * instead of silently falling through to the unattributed abort — the exact way the original
 * four-reason gap survived T1–T7 and the wiring ticket.
 */
describe('AC-NS-4: every map-non-convergent reason is attributed (drift guard)', () => {
  for (const exitReason of TEMPLATE_A_DISPOSITIONS) {
    test(`${exitReason} is map-non-convergent and therefore attributed`, () => {
      assert.equal(
        classifyMicroverseDisposition(exitReason).reportAs,
        'non-convergent',
        `${exitReason} is listed as Template-A but the map does not classify it non-convergent`,
      );
      const decision = classifyMicroverseHaltDecision(exitReason);
      assert.equal(decision.action, 'run-finalize-gate-incomplete');
      assert.equal(decision.recognizedExitReason, exitReason);
    });
  }
});

describe('AC-NS-4: unattributed default abort is unchanged for genuinely unrecognized reasons', () => {
  test(`classifyMicroverseHaltDecision(${DEFAULT_CASE}) → abort, null recognizedExitReason`, () => {
    assert.deepEqual(classifyMicroverseHaltDecision(DEFAULT_CASE), {
      action: 'abort',
      recognizedExitReason: null,
    });
  });
});
