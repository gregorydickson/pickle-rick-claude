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
 *
 * Widened again (ticket f7b9a302): the ONE RULE is now quantified over BOTH
 * termination channels, and both subject lists are DERIVED at runtime rather
 * than transcribed:
 *
 *   channel 1 — the pickle-phase halt decision (`shouldHaltAfterPhase` /
 *     `isFatalPhaseFailure`). Terminates ⟺ `shouldHaltAfterPhase === true`.
 *     Subjects come from `export type ExitReason` in `mux-runner.ts` plus the
 *     pipeline-runner-internal `recordExitReason` stamps, read off the source.
 *   channel 2 — the microverse termination decision
 *     (`classifyMicroverseHaltDecision`). Terminates ⟺ `action === 'abort'`.
 *     Subjects come from the exported `MICROVERSE_EXIT_REASONS` union.
 *
 * Why this ticket exists: AC-NSG-5b covered only channel 1, over a hand-copied
 * three-element array. `grep -c microverse` on this file returned 0, so the
 * microverse channel drifted freely and killed a 590-minute run. A hand-copied
 * list is how that drift happened — and how the earlier B-NS / B-APNC WS-1 drift
 * happened before it ("silently desynchronized from the map"). So neither list
 * is written down here: adding a union member without giving it a defined
 * behaviour reddens this suite with no test edit.
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
  classifyMicroverseHaltDecision,
  isFatalPhaseFailure,
  shouldHaltAfterPhase,
} from '../bin/pipeline-runner.js';
import { isFailureExit, isHaltExit, isIncompleteExit } from '../bin/mux-runner.js';
import { classifyMicroverseDisposition } from '../bin/microverse-runner.js';
import { StateManager } from '../services/state-manager.js';
import {
  CRASH_FLOOR_EXIT_REASONS,
  EXIT_REASONS,
  MICROVERSE_EXIT_REASONS,
  MICROVERSE_FATAL_REASONS,
} from '../types/index.js';

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

/**
 * The pipeline-runner-internal exit stamps: the quoted second argument of every
 * `recordExitReason(<expr>, '<literal>')` call. These never appear in `ExitReason` (they are
 * stamped by pipeline-runner, not mux-runner) but they land in the same `state.exit_reason` field
 * that channel 1 reads, so they belong to the same vocabulary. Template-literal arguments
 * (`signal:${signal}`) are excluded by construction — only quoted literals match.
 */
function readPipelineInternalExitStamps(sourceText) {
  return [...sourceText.matchAll(/recordExitReason\([^,)]+,\s*'([^']+)'/g)].map((m) => m[1]);
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

// Channel 1's exit_reason vocabulary, derived — never transcribed. Two sources feed the one
// `state.exit_reason` field the pickle-phase halt decision is quantified over: mux-runner's
// `ExitReason` union (the runner's own terminal labels) and pipeline-runner's internal
// `recordExitReason` stamps ('pipeline_phase_incomplete', 'phase_no_progress', …).
const PIPELINE_RUNNER_SOURCE = fs.readFileSync(PIPELINE_RUNNER_SRC, 'utf-8');
// `ExitReason` (mux-runner.ts) is `typeof EXIT_REASONS[number]`, so importing the array IS
// enumerating the union — the membership is read off the one list that defines it rather than
// re-parsed out of the type declaration. The non-empty assertion below keeps the fail-closed
// property the old source-text parse had: a degenerate list would make every loop pass vacuously.
const EXIT_REASON_UNION_MEMBERS = [...EXIT_REASONS];
const PIPELINE_INTERNAL_EXIT_STAMPS = readPipelineInternalExitStamps(PIPELINE_RUNNER_SOURCE);

// Root CLAUDE.md's crash floor names exactly the cannot-physically-continue reasons (toolchain
// unavailable, working dir missing, schema-ahead) as SANCTIONED halts of the pickle branch — this
// is the ticket that wired that floor in. Channel 1 asserts "no exit_reason halts pickle" for
// every OTHER reason; the crash floor is subtracted here, never hardcoded, so the two subject
// lists cannot silently drift apart.
const CHANNEL_ONE_EXIT_REASONS = [
  ...new Set([...EXIT_REASON_UNION_MEMBERS, ...PIPELINE_INTERNAL_EXIT_STAMPS]),
].filter((reason) => !CRASH_FLOOR_EXIT_REASONS.includes(reason)).sort();

// The one `ExitReason` member that is deliberately classified by none of the three dispositions
// below: it IS the success arm. Pinned as an exception, not assumed — see the classification test.
const SUCCESS_EXIT_REASON = 'success';

const MUX_NONZERO_EXIT_CODES = [1, 3];

describe('AC-OA-3a — the derived subject lists are non-empty and non-duplicated', () => {
  test('both channel-1 sources yielded members', () => {
    assert.ok(
      EXIT_REASON_UNION_MEMBERS.length > 0,
      'the ExitReason union derivation returned nothing — every channel-1 loop would pass vacuously',
    );
    assert.ok(
      PIPELINE_INTERNAL_EXIT_STAMPS.length > 0,
      'the recordExitReason stamp derivation returned nothing — the pipeline-internal reasons '
      + '(pipeline_phase_incomplete, phase_no_progress) would silently drop out of the invariant',
    );
    assert.ok(
      EXIT_REASON_UNION_MEMBERS.includes(SUCCESS_EXIT_REASON),
      `the derived union must contain '${SUCCESS_EXIT_REASON}' — if it does not, the declaration `
      + 'shape changed and the derivation is reading something else',
    );
    assert.ok(
      CRASH_FLOOR_EXIT_REASONS.length > 0,
      'CRASH_FLOOR_EXIT_REASONS is empty — the channel-1 subtraction would be a no-op and this '
      + 'test would silently stop proving the crash floor is excluded',
    );
  });

  test('channel 2 union is non-empty', () => {
    assert.ok(
      MICROVERSE_EXIT_REASONS.length > 0,
      'MICROVERSE_EXIT_REASONS is empty — the channel-2 loop would pass vacuously',
    );
  });

  test('no member is enumerated twice', () => {
    assert.equal(
      CHANNEL_ONE_EXIT_REASONS.length,
      new Set(CHANNEL_ONE_EXIT_REASONS).size,
      'channel-1 subjects contain a duplicate',
    );
    assert.equal(
      MICROVERSE_EXIT_REASONS.length,
      new Set(MICROVERSE_EXIT_REASONS).size,
      'channel-2 subjects contain a duplicate',
    );
  });
});

/**
 * Channel 1. One repo per exit code rather than one per (reason × exit code): `makeRepo` spends six
 * git subprocesses, and this file is `@tier: fast` at --test-concurrency=8. The reason is named in
 * every assert message so a failure still identifies the member.
 */
describe('AC-OA-3a — ONE RULE, channel 1: no exit_reason halts pickle', () => {
  for (const exitCode of MUX_NONZERO_EXIT_CODES) {
    test(`exitCode=${exitCode}: shouldHaltAfterPhase('pickle', ...) === false for every channel-1 exit_reason`, () => {
      const { repo, startCommit } = makeRepo();

      for (const reason of CHANNEL_ONE_EXIT_REASONS) {
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
      }
    });
  }
});

/**
 * Channel 1, exhaustiveness by construction. The loop above is exit_reason-INDEPENDENT by design
 * (`isFatalPhaseFailure`'s pickle branch reads only `start_commit`), so on its own a newly added
 * union member would be exercised and pass — covered, but not pinned.
 *
 * This is the property that does redden. Every `ExitReason` member except `'success'` must be
 * classified by one of mux-runner's three exported dispositions. An unclassified member is not
 * merely uncovered: mux-runner.ts's own comment records that "a reason demoted out of
 * FAILURE_EXIT_REASONS … otherwise lands in the success arm by default, which is how
 * done_without_commit_evidence came to print a green 'mux-runner Complete' panel for a bundle that
 * halted mid-flight." A union member with no defined behaviour is a FAILURE here, never a skip.
 */
describe('AC-OA-3b — channel 1: every union member has a defined disposition', () => {
  const dispositionsFor = (reason) => [
    isHaltExit(reason) && 'halt',
    isFailureExit(reason) && 'failure',
    isIncompleteExit(reason) && 'incomplete',
  ].filter(Boolean);

  for (const reason of EXIT_REASON_UNION_MEMBERS) {
    if (reason === SUCCESS_EXIT_REASON) { continue; }
    test(`${reason} is classified halt / failure / incomplete`, () => {
      assert.ok(
        dispositionsFor(reason).length > 0,
        `${reason} is in the ExitReason union but is classified by none of isHaltExit / `
        + 'isFailureExit / isIncompleteExit, so it lands in the success arm by default — the '
        + 'done_without_commit_evidence fake-green class (mux-runner.ts, FAILURE_EXIT_REASONS doc)',
      );
    });
  }

  test(`'${SUCCESS_EXIT_REASON}' is the one deliberate exception, and it is pinned`, () => {
    assert.deepEqual(
      dispositionsFor(SUCCESS_EXIT_REASON),
      [],
      `'${SUCCESS_EXIT_REASON}' acquired a halt/failure/incomplete disposition — if that is `
      + 'intended, the exception above is now wrong and the loop must cover it too',
    );
  });
});

/**
 * Channel 2 — the channel AC-NSG-5b never reached. `shouldHaltAfterPhase` is NOT the terminate wire
 * here: `isFatalPhaseFailure`'s microverse branch returns true for judge_timeout /
 * all_judge_backends_exhausted / the failure set purely to route the halt PATH, which then consults
 * the classifier and continues. The classifier's `action === 'abort'` is what actually terminates
 * the pipeline, so that is what the ONE RULE is quantified over.
 */
describe('AC-OA-3a — ONE RULE, channel 2: no microverse exit_reason aborts', () => {
  for (const reason of MICROVERSE_EXIT_REASONS) {
    test(`${reason}: classifyMicroverseHaltDecision does not abort`, () => {
      const decision = classifyMicroverseHaltDecision(reason);
      assert.notEqual(
        decision.action,
        'abort',
        `${reason} terminates the pipeline at the microverse classifier — a stopped pipeline `
        + 'produces no output, and no output has no quality',
      );
      assert.equal(
        decision.recognizedExitReason,
        reason,
        `${reason} must carry its own name into the decision, never an unattributed null`,
      );
    });
  }
});

/**
 * The invariant is bounded on channel 2 as well as channel 1. `session_state_corrupted` lives in
 * MICROVERSE_FATAL_REASONS, deliberately NOT in the exit union, and is the genuine
 * cannot-physically-continue floor. Channel 1's floor membership is out of scope for this ticket —
 * it is pinned by the two crash-floor tests above, not renegotiated here.
 */
describe('AC-OA-3a — channel 2 crash floor (the invariant is bounded, not universal)', () => {
  // Ticket 2ecd5464: sharpened from "session_state_corrupted is in there somewhere" (3 members)
  // to "it is the ONLY member" — judge_cli_missing and baseline_unmeasurable_unrecoverable are
  // demoted to park-and-report per B-NOSTOP-GATES (see oneabort-termination-invariant.test.js's
  // AC-2ecd5464 block for the full four-property proof on the actual recovery path).
  test('MICROVERSE_FATAL_REASONS has exactly one member: session_state_corrupted', () => {
    assert.deepEqual([...MICROVERSE_FATAL_REASONS], ['session_state_corrupted']);
  });

  test('session_state_corrupted is outside the exit union and still aborts', () => {
    assert.ok(
      !MICROVERSE_EXIT_REASONS.includes('session_state_corrupted'),
      'the floor must be excepted against the union it actually lives in (MICROVERSE_FATAL_REASONS)',
    );
    assert.equal(classifyMicroverseHaltDecision('session_state_corrupted').action, 'abort');
  });
});

/**
 * AC-OA-3b, observed rather than assumed. The ticket sketches the observation as "add a member to
 * an exported union locally, watch the suite go red, revert" — but this ticket's scope fence admits
 * only this test file, and its own AC requires `git diff -- extension/src/` to be empty, so that
 * mutation cannot be performed here. The same property is observed executably instead, in the two
 * halves it decomposes into: the subject lists FOLLOW the source, and an unrecognized member trips
 * exactly the conditions the loops above assert against.
 */
describe('AC-OA-3b — exhaustive by construction: a new member reddens this suite with no test edit', () => {
  const SYNTHETIC = 'synthetic_new_member';

  // This used to feed a synthetic `export type ExitReason = 'alpha' | 'synthetic';` string
  // through a source-text parser. The union is now `typeof EXIT_REASONS[number]`, so the
  // "follows the declaration" property is no longer about parsing — it is about the subject
  // list BEING the declaring array rather than a transcription of it. Asserted in the two
  // halves it decomposes into, both of which must hold for a new member to flow in unedited.
  test('the channel-1 subject list IS the EXIT_REASONS array, so a new member is picked up unedited', () => {
    assert.deepEqual(
      EXIT_REASON_UNION_MEMBERS,
      [...EXIT_REASONS],
      'the channel-1 subjects must be the EXIT_REASONS array itself — a transcribed copy would '
      + 'need a test edit for every new member, which is the drift this AC exists to prevent',
    );
  });

  test('mux-runner ExitReason derives from EXIT_REASONS, so array and union cannot diverge', () => {
    const muxSrc = fs.readFileSync(path.resolve(__dirname, '../src/bin/mux-runner.ts'), 'utf-8');
    const decl = /^export type ExitReason =([^;]*);/m.exec(muxSrc);
    assert.ok(decl, '`export type ExitReason` declaration not found in mux-runner.ts');
    assert.equal(
      decl[1].trim(),
      'typeof EXIT_REASONS[number]',
      'ExitReason must derive from EXIT_REASONS. Restating it as a literal union re-opens the '
      + 'drift where a reason exists in the union but not the array this suite quantifies over — '
      + 'it would then have no disposition pinned by the loops above.',
    );
  });

  test('the channel-1 stamp list follows the call sites, so a new stamp is picked up unedited', () => {
    const stamps = readPipelineInternalExitStamps(
      `recordExitReason(runtime.statePath, '${SYNTHETIC}');`,
    );
    assert.deepEqual(stamps, [SYNTHETIC]);
  });

  test('an unclassified channel-1 member trips the disposition assertion', () => {
    assert.equal(isHaltExit(SYNTHETIC), false);
    assert.equal(isFailureExit(SYNTHETIC), false);
    assert.equal(isIncompleteExit(SYNTHETIC), false);
  });

  test('an unrecognized channel-2 member trips the no-abort assertion', () => {
    assert.deepEqual(classifyMicroverseHaltDecision(SYNTHETIC), {
      action: 'abort',
      recognizedExitReason: null,
    });
  });
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
  const sourceText = PIPELINE_RUNNER_SOURCE;
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

/**
 * B-ONEABORT FR-B1 — the microverse arm (`isMicroverseArmFatal`, consumed by
 * `isFatalPhaseFailure`'s anatomy-park / szechuan-sauce branch).
 *
 * It used to be THREE arms: the crash floor, an inline `judge_timeout ||
 * all_judge_backends_exhausted || baseline_unmeasurable_transient` literal triple, and
 * `isMicroverseFailureExit`'s five-member set — eight hand-maintained literals across two lists,
 * i.e. the enumerated-set shape root CLAUDE.md names as "a liability with a maintenance schedule".
 * It is now ONE derived term: the crash floor, plus a `reportAs` read off `MICROVERSE_DISPOSITIONS`
 * (an exhaustive `Record<MicroverseExitReason, …>`, so tsc forces an entry for every new reason and
 * halt-eligibility follows by construction instead of by someone remembering a list).
 *
 * These pins protect the collapse in the three ways it can silently regress: by drifting in
 * membership, by losing the set-equality the derivation rests on, and by losing the state-manager
 * normalisation that makes the one disagreeing reason unreachable.
 */
describe('AC-OA-FRB1 — the microverse arm derives halt-eligibility, never restates it', () => {
  const MICROVERSE_PHASES = ['anatomy-park', 'szechuan-sauce'];
  // Probed through the SHIPPED entry point (`isFatalPhaseFailure` → `sm.read`), never through the
  // predicate in isolation: `sm.read` normalises legacy reasons, so a pure-predicate probe reports
  // a membership the runtime can never actually observe.
  function observedFatalReasons(phase, repo, startCommit) {
    return [...MICROVERSE_EXIT_REASONS, ...MICROVERSE_FATAL_REASONS].filter((exit_reason) =>
      isFatalPhaseFailure(phase, makeRuntime({ repo, startCommit, stateOverrides: { exit_reason } })));
  }

  test('halt-eligibility is exactly the disposition-derived set — no literal list survives', () => {
    const { repo, startCommit } = makeRepo();
    // The expectation is DERIVED from the same property the arm reads, not transcribed. A
    // transcribed list would need editing for every new reason — the drift this AC exists to stop.
    const expected = [...MICROVERSE_EXIT_REASONS, ...MICROVERSE_FATAL_REASONS].filter((r) =>
      MICROVERSE_FATAL_REASONS.includes(r)
      || ['failure', 'non-fatal-halt'].includes(classifyMicroverseDisposition(r).reportAs));

    for (const phase of MICROVERSE_PHASES) {
      assert.deepEqual(observedFatalReasons(phase, repo, startCommit), expected,
        `${phase}: the arm must agree with the disposition map it derives from`);
    }
  });

  test('the effective set is 10 reasons — the count B-ONEABORT recorded as 6', () => {
    const { repo, startCommit } = makeRepo();
    // Guards the derivation in the direction the derived expectation above cannot: if BOTH the arm
    // and MICROVERSE_DISPOSITIONS were widened together, the deepEqual would still pass. This
    // number is the measurement MASTER_PLAN's B-ONEABORT section was corrected to.
    for (const phase of MICROVERSE_PHASES) {
      assert.equal(observedFatalReasons(phase, repo, startCommit).length, 10,
        `${phase}: arm membership changed — re-measure before editing this number, and check no `
        + 'reason gained a gate-fail break (PRIME DIRECTIVE: no new abort condition)');
    }
  });

  test("the deleted inline triple is set-equal to the 'non-fatal-halt' disposition class", () => {
    // The collapse is only behaviour-preserving because these coincide exactly. If a fourth reason
    // becomes `non-fatal-halt`, or one of these three changes disposition, that is a deliberate
    // decision that must be re-measured here rather than absorbed silently.
    assert.deepEqual(
      MICROVERSE_EXIT_REASONS
        .filter((r) => classifyMicroverseDisposition(r).reportAs === 'non-fatal-halt').sort(),
      ['all_judge_backends_exhausted', 'baseline_unmeasurable_transient', 'judge_timeout'],
    );
  });

  test('sm.read normalises bare baseline_unmeasurable — the load-bearing invariant', () => {
    // Bare `baseline_unmeasurable` is the ONE reason whose disposition ('failure') disagrees with
    // the pre-collapse predicate, which excluded it. The collapse is safe only because
    // `migrateLegacyBaselineExitReason` (state-manager.ts) rewrites it on EVERY read — including
    // the already-current-schema branch — so the arm can never observe it. Delete that migration
    // while microverse-runner still emits the bare reason and it gains a gate-fail break: a new
    // abort condition. This pin fails first if that happens.
    const sessionDir = tmpDir('frb1-legacy-baseline-');
    const statePath = writeState(sessionDir, { exit_reason: 'baseline_unmeasurable' });
    const observed = new StateManager().read(statePath).exit_reason;

    assert.notEqual(observed, 'baseline_unmeasurable',
      'bare baseline_unmeasurable must be normalised before any consumer sees it');
    assert.equal(observed, 'baseline_unmeasurable_unrecoverable');
  });

  test('the arm body contains no exit-reason literal and no membership-set call', () => {
    const body = extractFunctionBody(PIPELINE_RUNNER_SOURCE, 'isMicroverseArmFatal');
    // Quoted literals in the body are compared against `reportAs`, a closed 5-value disposition
    // union — never against an exit reason. Any exit-reason literal here is the enumerated-set
    // shape growing back.
    // `typeof x !== 'string'` operands are type tags, not reasons — stripped so the scan below
    // reports only literals the arm actually compares a REASON against.
    const scanned = body.replace(/typeof\s+\w+\s*[!=]==\s*'[a-z]+'/g, '');
    const literals = [...scanned.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const REPORT_AS_VALUES = ['success', 'non-convergent', 'non-fatal-halt', 'failure', 'non-success'];
    assert.deepEqual(literals.filter((l) => !REPORT_AS_VALUES.includes(l)), [],
      'the arm must read a property of the reason, not restate reasons');
    assert.equal(body.includes('isMicroverseFailureExit'), false,
      'MICROVERSE_FAILURE_REASONS is no longer consulted here — re-adding it re-splits the arm');
  });
});
