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
  withholdForFailedAcGate,
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
  // The two `reportAs` values the arm treats as halt-eligible — named here so the correspondence
  // with the production predicate is visible rather than an unexplained pair of strings.
  const HALT_ELIGIBLE_DISPOSITIONS = ['failure', 'non-fatal-halt'];
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
      || HALT_ELIGIBLE_DISPOSITIONS.includes(classifyMicroverseDisposition(r).reportAs));

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

  // AP-EXT-ITER46-01. `isMicroverseArmFatal` carries TWO fail-open arms, and until this pin only
  // one of them was enforced. The trailing `catch` is cataloged in `src/bin/CLAUDE.md` and pinned by
  // AC-CF-04; the `typeof reason !== 'string'` guard — added by the FR-B1 collapse that introduced
  // `classifyMicroverseDisposition` here — had neither. Measured before writing this test: flipping
  // that guard to `return true` survived all 467 tests in every file referencing
  // `isFatalPhaseFailure`/`shouldHaltAfterPhase`, while changing real behaviour on both microverse
  // phases (absent/null/non-string exit_reason: continue -> HALT). The source-shape test below even
  // STRIPS `typeof x !== 'string'` before scanning, so the guard was visible to the suite and
  // asserted by nothing.
  //
  // Why it matters more than a coverage gap: a microverse phase that exits non-zero without
  // stamping an exit_reason (killed runner, crash before `recordExitReason`, or a post-recovery
  // `clearExitReason`) is exactly the silent-death case. Fail-closed there is a NEW abort
  // condition on a run that could have continued — the root CLAUDE.md's PRIME DIRECTIVE, and the
  // same fail-open reasoning AC-CF-04 already protects one arm with.
  test('a microverse phase with no usable exit_reason continues — the second fail-open arm', () => {
    const { repo, startCommit } = makeRepo();
    // Every shape that reaches the guard: the key absent entirely, an explicit null, and a
    // non-string value. `JSON.stringify` drops an `undefined` value, so the first case really does
    // write a state file with no `exit_reason` key at all.
    const UNUSABLE = [
      ['absent', {}],
      ['null', { exit_reason: null }],
      ['non-string', { exit_reason: 0 }],
    ];

    for (const phase of MICROVERSE_PHASES) {
      for (const [label, override] of UNUSABLE) {
        const runtime = makeRuntime({
          repo,
          startCommit,
          stateOverrides: { pipeline_continue_on_phase_fail: true, ...override },
        });

        assert.equal(isFatalPhaseFailure(phase, runtime), false,
          `${phase}: exit_reason ${label} must not be halt-eligible — a phase that failed without `
          + 'stamping a reason has not reported a crash-floor condition');
        assert.equal(shouldHaltAfterPhase(phase, 1, runtime), false,
          `${phase}: exit_reason ${label} must not halt the pipeline (PRIME DIRECTIVE: a halt on a `
          + 'missing reason is a new abort condition)');
      }

      // Control, and the reason this pin cannot pass by the arm collapsing to a constant `false`:
      // a genuinely halt-eligible STRING must still be halt-eligible on the same runtime shape.
      // Without this, deleting the disposition read entirely would leave the block green.
      const halting = makeRuntime({
        repo,
        startCommit,
        stateOverrides: { pipeline_continue_on_phase_fail: true, exit_reason: 'judge_timeout' },
      });
      assert.equal(isFatalPhaseFailure(phase, halting), true,
        `${phase}: the fail-open arm must not swallow a real halt-eligible reason`);
    }
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

/**
 * AC-6 (ticket 0d579ec5, B-ONEABORT Root C) — the abort channel is BOUNDED, and the bound is
 * measured rather than asserted from memory.
 *
 * The reading function is the phase loop's single consumer of `PhaseIterationOutcome`
 * (`if (outcome.action === 'break') break;`), so an abort condition IS a guarded
 * `action: 'break'` inside a producer of that type. Nothing else in the file terminates the loop —
 * `exit_reason` appears ~54 times there and almost none of those are abort conditions, which is why
 * this census is by PRODUCER and not by grep.
 *
 * The count was 8 before this ticket. Two came off:
 *   - `runPhaseIteration`'s `runAcPhaseGate` break, a MEASUREMENT verdict that terminated the run.
 *     CLAUDE.md: a gate may refuse a LOCAL action and stamp a reason, and may never break the phase
 *     loop. It now withholds the phase's success and advances (`withholdForFailedAcGate`, pinned
 *     behaviourally below).
 *   - `dispatchHaltAction`'s duplicate exit. The crash-floor early-return existed only to skip the
 *     doomed abort-path typecheck gate — "a narrowing of when the gate runs, never a change to
 *     whether the pipeline halts" — so it now guards that gate instead of owning a second break.
 *     One disposition, one exit. Behaviour-identical; the site count is the whole point.
 *
 * The remaining six are the crash floor CLAUDE.md reserves halting for, plus two gate-red breaks
 * that are pinned outside this file (`nostop-gates-sibling-parity.test.js`,
 * `oneabort-termination-invariant.test.js`) and could not be reduced from this ticket's fence.
 */
describe('AC-6 (0d579ec5) — the abort channel is bounded and the bound is measured', () => {
  const producers = discoverPhaseIterationOutcomeProducers(PIPELINE_RUNNER_SOURCE);

  /** Every producer that owns at least one `action: 'break'`, mapped to how many it owns. */
  function abortSiteCensus() {
    const census = {};
    for (const name of producers) {
      const count = (extractFunctionBody(PIPELINE_RUNNER_SOURCE, name).match(/action: 'break'/g) ?? []).length;
      if (count > 0) census[name] = count;
    }
    return census;
  }

  test('the census machinery is not vacuous — producers were discovered and some do break', () => {
    // Without this, every assertion below passes trivially if the discovery regex drifts.
    assert.ok(producers.length > 0, 'no PhaseIterationOutcome producer discovered');
    assert.ok(Object.keys(abortSiteCensus()).length > 0, 'no abort site found — the scan drifted');
  });

  test('the abort census is exactly the six surviving sites, named one by one', () => {
    // Deliberately a per-producer MAP, not a total. A total-only assertion stays green when one
    // site is deleted and a new one is added somewhere else — which is precisely the regression
    // this ticket exists to make impossible. Re-measure with the probe in `conformance_*` before
    // editing any number here; a number without its probe is not a measurement.
    assert.deepEqual(abortSiteCensus(), {
      cancelledOutcome: 1,
      dispatchHaltAction: 1,
      resolvePhaseIncompleteOutcome: 1,
      runAllBackendsExhaustedFinalizeGate: 1,
      runJudgeTimeoutFinalizeGate: 1,
      runPhaseIteration: 1,
    });
  });

  test('the total moved DOWN from the pre-ticket 8 and no producer gained a site', () => {
    const census = abortSiteCensus();
    const total = Object.values(census).reduce((a, b) => a + b, 0);
    assert.equal(total, 6, 'abort-site total changed — AC-6 forbids upward movement');
    assert.ok(total < 8, 'AC-6 hard constraint: net movement must be downward');
    // The pre-ticket census had `dispatchHaltAction: 2` and `runPhaseIteration: 2`. Naming the two
    // that shrank keeps the reduction attributable instead of leaving it to the total.
    assert.equal(census.dispatchHaltAction, 1, 'dispatchHaltAction re-grew a second break');
    assert.equal(census.runPhaseIteration, 1, 'runPhaseIteration re-grew a second break');
  });

  test('the AC gate holds no break of its own — the reduction, read at the call site', () => {
    const body = extractFunctionBody(PIPELINE_RUNNER_SOURCE, 'runPhaseIteration');
    const acIdx = body.indexOf('runAcPhaseGate');
    assert.ok(acIdx !== -1, 'runPhaseIteration no longer calls runAcPhaseGate — re-derive this pin');
    // From the gate call to the end of the function: the tail that used to own the abort.
    assert.equal(
      body.slice(acIdx).includes("action: 'break'"),
      false,
      "the AC gate must not terminate the phase loop — it withholds the verdict and advances",
    );
  });

  /**
   * The behavioural half. A source-text pin alone would be satisfiable by a comment, so the helper
   * is CALLED and its effect on the counters observed. Both directions are covered: a failing gate
   * must continue AND report, and a passing gate must not report anything at all — without the
   * second case, a helper hard-wired to always withhold would pass the first.
   */
  describe('withholdForFailedAcGate — reporting without halting', () => {
    const freshCounters = () => ({
      completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {},
    });
    const failingGate = {
      status: 'fail',
      phase: 'per-phase',
      evaluated: ['AC-1', 'AC-2'],
      skipped: [],
      failures: [{ id: 'AC-2', reason: 'expected exit 0, got 1' }],
    };

    test('a failed AC gate continues the phase loop and withholds the success verdict', () => {
      const { repo, startCommit } = makeRepo();
      const runtime = makeRuntime({ repo, startCommit });
      const counters = freshCounters();
      const cancelMarker = path.join(tmpDir('nostop-ac-cancel-'), 'never-created');

      const outcome = withholdForFailedAcGate(
        runtime, counters, cancelMarker, 'citadel', failingGate, () => {},
      );

      assert.deepEqual(outcome, { action: 'continue' },
        'a measurement verdict must not break the phase loop (PRIME DIRECTIVE)');
      assert.equal(counters.nonConvergent, 1,
        'success must be withheld on the REPORTING wire — unsuccessful = pipelineFailed || nonConvergent > 0');
      assert.match(counters.phaseDispositions.citadel, /^ac_phase_gate_failed:/,
        'the failure must leave a residual a human can read in pipeline-status.json');
      assert.ok(counters.phaseDispositions.citadel.includes('AC-2'),
        'the residual must name the criterion that failed, not just that one did');
      assert.equal(counters.completed, 0,
        'a phase whose ACs are red is not a completed phase');
      fs.rmSync(repo, { recursive: true, force: true });
    });

    test('a passing AC gate is inert — the withhold cannot over-trigger', () => {
      const { repo, startCommit } = makeRepo();
      const runtime = makeRuntime({ repo, startCommit });
      const counters = freshCounters();
      const cancelMarker = path.join(tmpDir('nostop-ac-cancel-pass-'), 'never-created');

      const outcome = withholdForFailedAcGate(
        runtime, counters, cancelMarker,
        'citadel',
        { status: 'pass', phase: 'per-phase', evaluated: ['AC-1'], skipped: [], failures: [] },
        () => {},
      );

      assert.equal(outcome, null, 'a passing gate must fall through to the normal success path');
      assert.deepEqual(counters, freshCounters(), 'a passing gate must touch no counter');
      fs.rmSync(repo, { recursive: true, force: true });
    });

    test('operator cancel still wins over the withhold — removing an abort kept the operator\'s', () => {
      const { repo, startCommit } = makeRepo();
      const runtime = makeRuntime({ repo, startCommit });
      const counters = freshCounters();
      const cancelDir = tmpDir('nostop-ac-cancel-live-');
      const cancelMarker = path.join(cancelDir, 'cancel');
      fs.writeFileSync(cancelMarker, '');

      const outcome = withholdForFailedAcGate(
        runtime, counters, cancelMarker, 'citadel', failingGate, () => {},
      );

      assert.equal(outcome.action, 'break',
        'operator cancel is a crash-floor disposition and must survive this reduction');
      assert.equal(counters.nonConvergent, 1,
        'the residual is still recorded even when the operator cancels');
      fs.rmSync(repo, { recursive: true, force: true });
    });
  });
});
