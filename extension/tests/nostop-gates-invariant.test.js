// @tier: fast
/**
 * B-NOSTOP-GATES WS-1 — AC-NSG-5b.
 *
 * ONE RULE: honesty is a REPORTING property, halting is a DISPOSITION, they are
 * not the same wire. For the pickle phase, with a `start_commit` present and
 * `pipeline_continue_on_phase_fail !== false`, NO quality-verdict exit_reason
 * may halt the pipeline — this holds for every incomplete/quality exit_reason
 * and every non-zero exit code mux-runner can produce for a phase that
 * genuinely ran (1 or 3).
 *
 * Two crash-floor pins verify the invariant is bounded, not universal:
 *   - `pipeline_continue_on_phase_fail === false` (the `--strict-phases` /
 *     persisted opt-in) still halts regardless of exit_reason/exitCode.
 *   - a missing `start_commit` still halts — progress is unmeasurable, and no
 *     downstream honesty gate can report around that.
 *
 * Widened reach (ticket 6dc7d243): the two describe blocks above only exercise
 * `shouldHaltAfterPhase`/`isFatalPhaseFailure` — the direct pickle-phase halt
 * decision. They never reach `dispatchHaltAction`'s recovery-gate producers
 * (`runJudgeTimeoutFinalizeGate`, `runAllBackendsExhaustedFinalizeGate`), which
 * is exactly how `runAllBackendsExhaustedFinalizeGate` shipped returning
 * `{action:'break'}` for a PASSING gate undetected. The third describe block
 * below structurally enumerates every `PhaseIterationOutcome` producer in
 * `pipeline-runner.ts` by regex over the source (not a hand-listed name set),
 * then asserts the ONE RULE over every producer shaped like a finalize-gate
 * recovery (spawns finalize-gate.js, branches on `gateResult.exitCode === 0`):
 * a passing gate's branch must never contain `action: 'break'`. A future
 * producer with the same shape is caught automatically — no test edit needed.
 */
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  __setSpawnRunnerForTests,
  isFatalPhaseFailure,
  shouldHaltAfterPhase,
} from '../bin/pipeline-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_RUNNER_SRC = path.resolve(__dirname, '../src/bin/pipeline-runner.ts');

/**
 * Minimum set of `PhaseIterationOutcome` producers known at authoring time
 * (research: `grep -n "PhaseIterationOutcome" src/bin/pipeline-runner.ts`,
 * minus the type declaration itself). `discoverPhaseIterationOutcomeProducers`
 * must find AT LEAST these — a superset check, so a 9th producer added later
 * does not require editing this list.
 */
const KNOWN_PRODUCERS = [
  'maybeStampPhaseGraduation',
  'runJudgeTimeoutFinalizeGate',
  'runAllBackendsExhaustedFinalizeGate',
  'dispatchHaltAction',
  'resolvePhaseIncompleteOutcome',
  'runPhaseIteration',
  'maybeStampPickleIncompleteRobust',
  'finalizePhaseSuccess',
];

/** Every function whose return type is `PhaseIterationOutcome` (bare, `| null`, or `Promise<...>`). */
function discoverPhaseIterationOutcomeProducers(sourceText) {
  const funcNameRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
  const funcStarts = [];
  let m;
  while ((m = funcNameRe.exec(sourceText))) {
    funcStarts.push({ idx: m.index, name: m[1] });
  }
  const returnTypeRe = /\):\s*(?:Promise<PhaseIterationOutcome>|PhaseIterationOutcome(?:\s*\|\s*null)?)\s*\{/g;
  const producers = new Set();
  while ((m = returnTypeRe.exec(sourceText))) {
    let owner = null;
    for (const f of funcStarts) {
      if (f.idx <= m.index) owner = f;
      else break;
    }
    if (owner) producers.add(owner.name);
  }
  return [...producers].sort();
}

/** Brace-matched body of a top-level `function <name>(` / `async function <name>(` declaration. */
function extractFunctionBody(sourceText, name) {
  const declRe = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const declMatch = declRe.exec(sourceText);
  if (!declMatch) throw new Error(`declaration not found for ${name}`);
  const braceStart = sourceText.indexOf('{', declMatch.index);
  return extractBraceBlock(sourceText, braceStart);
}

/** Brace-matched substring starting at an opening `{` index, through its balanced closing `}`. */
function extractBraceBlock(sourceText, openBraceIdx) {
  let depth = 0;
  for (let i = openBraceIdx; i < sourceText.length; i++) {
    const ch = sourceText[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return sourceText.slice(openBraceIdx, i + 1);
    }
  }
  throw new Error('unbalanced braces starting at ' + openBraceIdx);
}

/** True when a producer body spawns finalize-gate.js and branches on its exit code. */
function isFinalizeGateShaped(body) {
  return body.includes('finalize-gate.js') && body.includes('gateResult.exitCode === 0');
}

const TMP_DIRS = new Set();

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMP_DIRS.add(dir);
  return dir;
}

// Hang guard, NOT a perf assertion (extension/CLAUDE.md, serial-manifest hygiene principle): an
// unbounded execFileSync here can wedge the whole tier forever. 30s rather than the 15s the
// already-serialized gitattr integration files use, because this file stays @tier: fast and runs at
// --test-concurrency=8 — never shrink it to make a load-starved run pass.
const GIT_TIMEOUT_MS = 30_000;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: GIT_TIMEOUT_MS }).trim();
}

function makeRepo() {
  const repo = tmpDir('nostop-invariant-repo-');
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test User'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'seed.ts'), 'export const x = 1;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
  const startCommit = git(['rev-parse', 'HEAD'], repo);
  return { repo, startCommit };
}

function writeState(sessionDir, overrides = {}) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'nostop-gates invariant test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    backend: 'claude',
    ...overrides,
  }, null, 2));
  return statePath;
}

/** Build a minimal PipelineRuntime object the way production code does. */
function makeRuntime({ startCommit, repo, stateOverrides = {} } = {}) {
  const sessionDir = tmpDir('nostop-invariant-session-');
  const statePath = writeState(sessionDir, {
    working_dir: repo,
    start_commit: startCommit,
    ...stateOverrides,
  });
  return {
    sessionDir,
    extensionRoot: process.cwd(),
    statePath,
    config: {
      phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
      target: repo,
      anatomy_stall_limit: 3,
      szechuan_stall_limit: 5,
      anatomy_max_iterations: 100,
      szechuan_max_iterations: 50,
      citadel_strict: false,
      dirty_exempt_segments: ['prds', 'docs'],
    },
    target: repo,
    workingDir: repo,
    repoRoot: repo,
    backend: 'claude',
    phaseEnv: {},
    log: () => {},
  };
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
  for (const dir of TMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  TMP_DIRS.clear();
});

// The exit_reason vocabulary a quality-verdict pickle exit can carry. Sourced
// from mux-runner.ts's INCOMPLETE_EXIT_REASONS ({'done_without_commit_evidence'})
// plus the two pipeline-runner-internal incomplete stamps this ticket widens
// ('pipeline_phase_incomplete', 'phase_no_progress'). Not re-exported from
// mux-runner.ts, so the set is enumerated here rather than imported.
const QUALITY_VERDICT_EXIT_REASONS = [
  'done_without_commit_evidence',
  'pipeline_phase_incomplete',
  'phase_no_progress',
];

const MUX_NONZERO_EXIT_CODES = [1, 3];

describe('AC-NSG-5b — ONE RULE: quality-verdict exit_reasons never halt pickle', () => {
  for (const reason of QUALITY_VERDICT_EXIT_REASONS) {
    for (const exitCode of MUX_NONZERO_EXIT_CODES) {
      test(`exit_reason=${reason}, exitCode=${exitCode}: shouldHaltAfterPhase('pickle', ...) === false`, () => {
        const { repo, startCommit } = makeRepo();
        const runtime = makeRuntime({
          repo,
          startCommit,
          stateOverrides: {
            exit_reason: reason,
            pipeline_continue_on_phase_fail: true,
          },
        });

        assert.equal(
          isFatalPhaseFailure('pickle', runtime),
          false,
          `isFatalPhaseFailure must not fatal pickle for exit_reason=${reason}`,
        );
        assert.equal(
          shouldHaltAfterPhase('pickle', exitCode, runtime),
          false,
          `shouldHaltAfterPhase must not halt pickle for exit_reason=${reason}, exitCode=${exitCode}`,
        );
      });
    }
  }
});

describe('AC-NSG-5b — crash-floor pins (the invariant is bounded, not universal)', () => {
  test('pipeline_continue_on_phase_fail === false still halts regardless of exit_reason/exitCode', () => {
    const { repo, startCommit } = makeRepo();
    const runtime = makeRuntime({
      repo,
      startCommit,
      stateOverrides: {
        exit_reason: 'done_without_commit_evidence',
        pipeline_continue_on_phase_fail: false,
      },
    });

    // isFatalPhaseFailure itself is unaffected by the strict-phase override —
    // it is shouldHaltAfterPhase's SECOND check (:2846) that enforces the pin.
    assert.equal(isFatalPhaseFailure('pickle', runtime), false);
    assert.equal(
      shouldHaltAfterPhase('pickle', 3, runtime),
      true,
      '--strict-phases / persisted pipeline_continue_on_phase_fail=false is the bundle\'s ONLY ' +
      'rollback path and MUST survive this ticket\'s subtraction',
    );
  });

  test('missing start_commit still halts pickle — progress is unmeasurable', () => {
    const { repo } = makeRepo();
    const runtime = makeRuntime({
      repo,
      startCommit: undefined,
      stateOverrides: {
        exit_reason: 'done_without_commit_evidence',
        pipeline_continue_on_phase_fail: true,
      },
    });

    assert.equal(
      isFatalPhaseFailure('pickle', runtime),
      true,
      'a missing start_commit means progress is literally unmeasurable — no downstream honesty ' +
      'gate can report around that, so this arm (:2805 in the plan) stays fatal',
    );
    assert.equal(shouldHaltAfterPhase('pickle', 3, runtime), true);
  });
});

describe('AC-NSG-5b — structural producer enumeration (widened reach)', () => {
  const sourceText = fs.readFileSync(PIPELINE_RUNNER_SRC, 'utf-8');
  const producers = discoverPhaseIterationOutcomeProducers(sourceText);

  test('every PhaseIterationOutcome producer is discovered', () => {
    for (const name of KNOWN_PRODUCERS) {
      assert.ok(
        producers.includes(name),
        `structural discovery must find producer "${name}" — did its return-type annotation change?`,
      );
    }
  });

  test('every finalize-gate-shaped producer continues on a passing gate, never breaks', () => {
    const gateShapedProducers = producers.filter((name) => isFinalizeGateShaped(extractFunctionBody(sourceText, name)));

    // Guards the filter itself: if this list goes empty (e.g. a refactor renames
    // `gateResult`/`exitCode`), the assertion below would vacuously pass over zero
    // producers. Fail loud instead so the filter's own drift is caught.
    assert.ok(
      gateShapedProducers.length > 0,
      'no finalize-gate-shaped producer found — the shape-detection filter may have drifted',
    );
    assert.deepEqual(
      gateShapedProducers,
      ['runAllBackendsExhaustedFinalizeGate', 'runJudgeTimeoutFinalizeGate'],
      'the set of finalize-gate-shaped producers changed — a new one must also satisfy the ONE RULE below',
    );

    for (const name of gateShapedProducers) {
      const body = extractFunctionBody(sourceText, name);
      const condIdx = body.indexOf('gateResult.exitCode === 0');
      assert.ok(condIdx !== -1, `${name}: expected a gateResult.exitCode === 0 branch`);
      const braceIdx = body.indexOf('{', condIdx);
      const passingBranch = extractBraceBlock(body, braceIdx);

      assert.ok(
        passingBranch.includes("action: 'continue'"),
        `${name}: a PASSING finalize-gate must return { action: 'continue' } — found:\n${passingBranch}`,
      );
      assert.ok(
        !passingBranch.includes("action: 'break'"),
        `${name}: a PASSING finalize-gate must never return { action: 'break' } (B-NOSTOP-GATES ONE ` +
        `RULE) — found:\n${passingBranch}`,
      );
    }
  });
});
