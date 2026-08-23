// @tier: fast
/**
 * AC-MWMO-D2-1 / AC-MWMO-D2-4 — every LIVE done_without_commit_evidence guard
 * block in mux-runner.ts must route through the loop's canonical exit
 * (exitReason assignment + break), never a bare `return;`, so a recorded
 * FATAL halt exits non-zero instead of falling through to Node's default 0.
 *
 * The site list is DERIVED by scanning the source for every
 * recordExitReason(..., 'done_without_commit_evidence') call, so a NEW future
 * site fails this test instead of silently escaping it. :7324 (inside
 * processTaskCompleted, reachable only from processIterationOutcome, which
 * has zero production callers — transitively dead) and :2892 (ticket
 * a3812edd's discarded-verdict return) are named as the known non-bare-return
 * exclusions.
 *
 * node:test has no per-case table helper (the Jest/Vitest style API the PRD
 * originally mandated by name simply does not exist in this runner) — so the
 * "for every live site" universal is a plain loop over the derived array,
 * inside one test().
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REPORTED GAP — AC-MWMO-D2-2 and AC-MWMO-D2-3 are NOT pinned in this file, and
 * are NOT reachable in this (fast) tier. Recorded here rather than papered over
 * with a structural pin, because a structural stand-in for an outcome AC is the
 * same "the gate never fired, so it passed" failure this bundle exists to kill.
 *
 *   AC-MWMO-D2-2 — "drive the runner to a commit-less Done; observed process
 *                   exit code === 1"
 *   AC-MWMO-D2-3 — "the halt emits a session_end activity event"
 *
 * WHY UNREACHABLE (both facts are asserted by the bypass test below, so this
 * paragraph cannot rot silently):
 *   1. `guardCompletionCommitBeforeDone` (src/bin/mux-runner.ts:4726) returns
 *      `{ok: true, sha: 'pickle-test-mode-bypass'}` UNCONDITIONALLY when
 *      PICKLE_TEST_MODE=1 (:4743), and the fast tier sets it. All three live
 *      guard sites branch on `!guard.ok`, so in this tier the guard never
 *      refuses and the halt can never fire.
 *   2. `runMuxRunnerMain` (:8815) is not exported, so the loop that owns the
 *      exit map cannot be driven in-process at all.
 *
 * HANDOFF [manager] — to pin D2-2/D2-3 honestly they must move to the
 * integration tier: spawn mux-runner as a subprocess WITHOUT PICKLE_TEST_MODE,
 * against a synthetic tmp git repo whose ticket is Done with no
 * completion_commit, then assert the observed exit status is 1 and that a
 * session_end event carrying error === 'done_without_commit_evidence' was
 * emitted. That needs a NEW integration-tier file, which is outside the file
 * fence of the ticket (31ed007a) that wrote this note.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_REASONS } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_TS = path.resolve(__dirname, '..', 'src', 'bin', 'mux-runner.ts');

const muxRunner = await import('../bin/mux-runner.js');
const {
  isHaltExit,
  isFailureExit,
  isIncompleteExit,
  deriveCompletionVerdict,
  buildTmuxNotification,
  guardCompletionCommitBeforeDone,
} = muxRunner;

function findDoneWithoutCommitEvidenceSites(sourceText) {
  const lines = sourceText.split('\n');
  const callRe = /recordExitReason\([^,]+,\s*'done_without_commit_evidence'\)/;
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    if (callRe.test(lines[i])) {
      const windowLines = lines.slice(i, i + 8);
      sites.push({
        lineNo: i + 1,
        window: windowLines.join('\n'),
      });
    }
  }
  return sites;
}

// Ticket 96444430: done_without_commit_evidence is a per-ticket verdict, not a
// cannot-continue halt. Every recordExitReason(..., 'done_without_commit_evidence')
// site must record the residual and PARK the ticket (never break the phase loop,
// never assign the loop-terminating `exitReason` variable, never safeDeactivate).
// This REPLACES the pre-96444430 invariant (exitReason+break) which this ticket
// deliberately reverses — see extension/CLAUDE.md's B-NOSTOP-GATES thesis.
test('mux-runner: every live done_without_commit_evidence residual is recorded then parked (never halts the loop)', () => {
  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');
  const sites = findDoneWithoutCommitEvidenceSites(source);

  // The authoritative sweep: exactly 5 recordExitReason(..., 'done_without_commit_evidence')
  // call sites exist in mux-runner.ts today.
  assert.equal(sites.length, 5, `expected exactly 5 recordExitReason(..., 'done_without_commit_evidence') sites, found ${sites.length} at lines ${sites.map(s => s.lineNo).join(', ')}`);

  const haltShapeRe = /\bbreak;|kind:\s*'break'|exitReason\s*=\s*'done_without_commit_evidence';|safeDeactivate\(/;
  const delegateLeaveRe = /return\s*\{\s*action:\s*'leave'/;
  const parkedShapeRe = /(?:^|[^.\w])continue;|kind:\s*'continue'/m;

  const parkedSites = [];
  const delegateSites = [];
  const haltingSites = [];

  for (const site of sites) {
    if (haltShapeRe.test(site.window)) {
      haltingSites.push(site);
    } else if (delegateLeaveRe.test(site.window)) {
      delegateSites.push(site);
    } else if (parkedShapeRe.test(site.window)) {
      parkedSites.push(site);
    } else {
      haltingSites.push(site);
    }
  }

  assert.deepEqual(
    haltingSites,
    [],
    `every recordExitReason(..., 'done_without_commit_evidence') site must park (continue), never halt the loop; halting sites found: ${JSON.stringify(haltingSites.map(s => s.lineNo))}`,
  );

  // Exactly ONE delegate site: applyAutoTicketCompletionValidation returns the
  // fatal verdict as an object (`{ action: 'leave', reason: 'guard_failed_no_commit_evidence' }`)
  // to its single caller, which is responsible for parking (see the sibling test below).
  assert.equal(delegateSites.length, 1, `expected exactly 1 delegate-return site (applyAutoTicketCompletionValidation), found ${delegateSites.length} at lines ${delegateSites.map(s => s.lineNo).join(', ')}`);

  // The remaining 4 sites park in-place via a bare `continue;` or a
  // `{ kind: 'continue', ... }` LoopAction return.
  assert.equal(parkedSites.length, 4, `expected exactly 4 in-place park sites, found ${parkedSites.length} at lines ${parkedSites.map(s => s.lineNo).join(', ')}`);
});

// The executable half of the REPORTED GAP in this file's header. It asserts the
// two facts that make AC-MWMO-D2-2/D2-3 unreachable in this tier. It is not a
// stand-in for those ACs — it pins the REASON they are absent, so the reason
// cannot rot into a stale comment. If the PICKLE_TEST_MODE bypass is ever
// removed or the runner main is ever exported, this test FAILS, which is the
// signal to revisit whether D2-2/D2-3 have become reachable in-tier.
test('mux-runner: the PICKLE_TEST_MODE=1 bypass disarms the completion guard — why AC-D2-2/D2-3 cannot be driven in this tier', () => {
  const originalTestMode = process.env.PICKLE_TEST_MODE;
  process.env.PICKLE_TEST_MODE = '1';
  try {
    // Deliberately non-existent paths: the bypass at :4743 is the function's
    // first statement, so it must return BEFORE any filesystem or git access.
    // A verdict that comes back ok with the sentinel sha proves no IO ran —
    // any real evidence probe against these paths could not produce it.
    const verdict = guardCompletionCommitBeforeDone({
      sessionDir: path.join(path.sep, 'nonexistent-31ed007a', 'session'),
      ticketId: 'deadbeef',
      workingDir: path.join(path.sep, 'nonexistent-31ed007a', 'working-dir'),
      flags: null,
    });

    assert.equal(
      verdict.ok,
      true,
      'PICKLE_TEST_MODE=1 must make guardCompletionCommitBeforeDone return ok — this is exactly why a fast-tier test can never drive the !guard.ok halt that AC-D2-2/D2-3 require',
    );
    assert.equal(
      verdict.sha,
      'pickle-test-mode-bypass',
      'the verdict must carry the bypass sentinel sha — proving the guard short-circuited at src/bin/mux-runner.ts:4743 without probing the (non-existent) paths above',
    );
  } finally {
    if (originalTestMode === undefined) {
      delete process.env.PICKLE_TEST_MODE;
    } else {
      process.env.PICKLE_TEST_MODE = originalTestMode;
    }
  }

  // The compounding half: even without the bypass, the loop that owns the exit
  // map is unreachable in-process because its entry point is not exported.
  assert.equal(
    muxRunner.runMuxRunnerMain,
    undefined,
    'runMuxRunnerMain must remain unexported — if it is ever exported, AC-D2-2 (observed exit code) may become drivable in-process and this file\'s REPORTED GAP must be re-evaluated',
  );
});

/**
 * The ExitReason members, read from the ONE list that defines them. `ExitReason`
 * (mux-runner.ts) is `typeof EXIT_REASONS[number]`, so importing the array IS
 * enumerating the union — no source-text parse, and a NEW member is picked up
 * automatically rather than hand-added to a list here.
 *
 * This used to regex the members out of a hand-maintained literal union in
 * mux-runner.ts. That parse went silently empty the moment the union was collapsed
 * to a derivation, which is why the sanity floor below is retained: it fails CLOSED,
 * so a degenerate list throws rather than making every "for every reason" loop pass
 * by iterating nothing.
 */
function exitReasons() {
  const reasons = [...EXIT_REASONS];
  assert.ok(reasons.length > 10, `expected EXIT_REASONS to yield a substantial member list, found ${reasons.length}`);
  return reasons;
}

/**
 * Parse the exit-code decision out of the TS source instead of re-implementing
 * it in the test. A hand-copied `if/else` would only ever prove the test's own
 * copy of the logic — it would keep passing while the source's mapping drifted.
 *
 * Fails CLOSED: an unparseable or reshaped exit map throws here rather than
 * yielding an empty/degenerate mapping that quietly passes.
 */
function deriveExitCodeMapFromSource(sourceText) {
  // B-GTRUTH WS-A2: the map now carries MORE THAN ONE reason-specific branch
  // ('iteration_cap_exhausted' and 'done_without_commit_evidence' both map to 3), so
  // parse every one of them instead of only the leading branch. Generalizing the
  // parser — rather than reshaping the source to fit a single-branch regex — keeps the
  // mapping read FROM source; a hand-copied if/else would only ever prove the test's
  // own copy of the logic.
  const reasonBranches = [
    ...sourceText.matchAll(/(?:if|else if) \(exitReason === '(\w+)'\) exitCode = (\d+);/g),
  ].map((m) => [m[1], Number(m[2])]);
  assert.ok(
    reasonBranches.length > 0,
    'exit map: could not parse any `(else )?if (exitReason === …) exitCode = N;` branch from mux-runner.ts — the map was reshaped, so this AC can no longer verify it',
  );

  const failBranch = /else if \(isFailedExit\) exitCode = (\d+);/.exec(sourceText);
  assert.ok(failBranch, 'exit map: could not parse the `else if (isFailedExit) exitCode = N;` branch from mux-runner.ts — the map was reshaped, so this AC can no longer verify it');

  const defaultBranch = /else exitCode = (\d+);/.exec(sourceText);
  assert.ok(defaultBranch, 'exit map: could not parse the trailing `else exitCode = N;` branch from mux-runner.ts — the map was reshaped, so this AC can no longer verify it');

  const perReason = new Map(reasonBranches);
  const failCode = Number(failBranch[1]);
  const defaultCode = Number(defaultBranch[1]);

  return (reason) => {
    if (perReason.has(reason)) return perReason.get(reason);
    if (isFailureExit(reason)) return failCode;
    return defaultCode;
  };
}

// FORWARD-REGRESSION PIN — NOT red-first, and deliberately retained.
//
// Red-first verdict (ticket 31ed007a): this AC is VACUOUS against pre-fix source.
// At the pre-bundle baseline 3fc1d535, `isHaltExit` already included
// 'done_without_commit_evidence' (:4370), FAILURE_EXIT_REASONS already included
// it (:4372-4377), and BOTH exit-map branches already existed. Every assertion
// below passes on pre-fix source, so it cannot be shown red.
//
// That is consistent with the bug thesis rather than a defect in the AC: the
// classifiers were never wrong. The bug was that the three bare `return;` sites
// meant control never REACHED this map — which is AC-MWMO-D2-1's territory, and
// that AC is genuinely red-first. This AC is kept (not deleted) because the PRD's
// stated intent for it is forward-facing: "pinned so a future reclassification
// cannot silently re-mask the failure". It is strengthened here from a
// single-reason self-replication into a universal over the whole ExitReason
// union, evaluated against the mapping PARSED FROM SOURCE.
// B-GTRUTH WS-A2 (AC-GTRUTH-A2-3): the halt set is pinned EXACTLY, so a future
// reclassification cannot quietly re-admit a ticket-scoped reason. Derived over the
// whole ExitReason union, so 'state_schema_version_ahead' (explicitly not a member)
// and every future member are covered without being hand-listed.
const EXPECTED_HALT_EXITS = [
  'cancelled',
  'closer_handoff_terminal',
  'limit',
  'manager_handoff_pending',
  'timeout_repeat',
];

test('AC-GTRUTH-A2-3: isHaltExit is true for EXACTLY the five session-scoped pause reasons', () => {
  const actual = exitReasons().filter((r) => isHaltExit(r)).sort();
  assert.deepEqual(
    actual,
    EXPECTED_HALT_EXITS,
    'isHaltExit must contain exactly the session-scoped pause/defer reasons. ' +
    "'done_without_commit_evidence' is TICKET-scoped and was removed (WS-A2); " +
    "'state_schema_version_ahead' is not a member and must not be added.",
  );
});

test('AC-GTRUTH-A2-3/A2-4: done_without_commit_evidence is demoted out of BOTH classifier sets', () => {
  assert.equal(isHaltExit('done_without_commit_evidence'), false, "isHaltExit('done_without_commit_evidence') must be false after WS-A2 — MUST fail on pre-fix source");
  assert.equal(isFailureExit('done_without_commit_evidence'), false, "isFailureExit('done_without_commit_evidence') must be false after WS-A2 — MUST fail on pre-fix source");
});

test('AC-GTRUTH-A2-4: the source exit map routes done_without_commit_evidence to PhaseIncomplete (3), never 0', () => {
  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');
  const exitCodeFor = deriveExitCodeMapFromSource(source);

  // The whole point of the coupling: demoting the reason out of FAILURE_EXIT_REASONS
  // without adding this branch would send it to the `else exitCode = 0` default, and a
  // 0 exit graduates the phase — turning a loud halt into a silent fake-green. Exit 3
  // is what makes pipeline-runner call reportPhaseIncomplete.
  assert.equal(
    exitCodeFor('done_without_commit_evidence'),
    3,
    "'done_without_commit_evidence' must map to exit code 3 (PipelineRunnerExitCode.PhaseIncomplete) — " +
    'NOT 1 (pre-fix: fatal) and emphatically NOT 0 (silent graduation)',
  );

  // A NEW failure reason is covered automatically instead of hand-added here.
  const phaseIncompleteReasons = new Set(['iteration_cap_exhausted', 'done_without_commit_evidence']);
  for (const reason of exitReasons()) {
    const code = exitCodeFor(reason);
    if (phaseIncompleteReasons.has(reason)) {
      assert.equal(code, 3, `'${reason}' must keep its distinct exit code 3 (R-ICP-1 / WS-A2)`);
    } else if (isFailureExit(reason)) {
      assert.equal(code, 1, `'${reason}' is a failure exit and must map to a non-zero exit code 1 — a reclassification that sends it to 0 re-masks the failure`);
    } else {
      assert.equal(code, 0, `'${reason}' is not a failure exit and must map to exit code 0`);
    }
  }
});

// WS-1b (ticket a3812edd) established that applyAutoTicketCompletionValidation's
// ONE production call site must not discard its fatal `{action:'leave',
// reason:'guard_failed_no_commit_evidence'}` verdict. Ticket 96444430 changes
// WHAT the call site does with that verdict: it must PARK (continue the phase
// loop) instead of halting — the callee no longer safeDeactivates, so a
// `break` here would leave the session active but the loop exited, and the
// old exitReason+break shape is exactly the halt this ticket removes.
test('mux-runner: applyAutoTicketCompletionValidation call site parks on the fatal leave verdict, never halts', () => {
  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');

  const callSiteRe = /applyAutoTicketCompletionValidation\(\{/g;
  const callSites = [...source.matchAll(callSiteRe)];
  assert.equal(
    callSites.length,
    1,
    `expected exactly 1 applyAutoTicketCompletionValidation({ call site, found ${callSites.length} — a new call site changes this fix's scope`,
  );

  const callIndex = callSites[0].index;
  // Window: a short head before the call (to catch a `const x = ` capture prefix
  // on the same or preceding line) through a generous tail covering the enclosing
  // else-branch close, so the fatal-branch check (if present) is captured.
  const window = source.slice(Math.max(0, callIndex - 100), callIndex + 1200);

  assert.match(
    window,
    /(?:const|let)\s+\w+\s*=\s*applyAutoTicketCompletionValidation\(\{/,
    'the call site must capture the return value into a variable, not discard it as a bare statement call',
  );

  assert.match(
    window,
    /reason\s*===\s*'guard_failed_no_commit_evidence'/,
    "the call site must check the verdict's reason for the fatal guard-failure case specifically (not a bare action === 'leave' check, which would also fire on the benign ticket_already_terminal / malformed_or_missing_ticket_frontmatter leave-reasons)",
  );

  assert.match(
    window,
    /reason\s*===\s*'guard_failed_no_commit_evidence'\)\s*\{\s*[\s\S]{0,40}?continue;/,
    "on the fatal guard-failure verdict, the call site must `continue;` the phase loop — never break, never (re)assign exitReason to 'done_without_commit_evidence' (ticket 96444430)",
  );

  assert.doesNotMatch(
    window,
    /exitReason\s*=\s*'done_without_commit_evidence';[\s\S]{0,80}?break;/,
    'the call site must NOT halt via the pre-96444430 exitReason+break shape',
  );

  // The callee itself must no longer deactivate the session on guard failure —
  // deactivating there would still halt the run even though this call site parks.
  const fnStart = source.indexOf('export function applyAutoTicketCompletionValidation');
  assert.ok(fnStart >= 0, 'applyAutoTicketCompletionValidation definition must be present');
  const fnWindow = source.slice(fnStart, fnStart + 2000);
  const guardFailBlock = /if \(!guard\.ok\) \{[\s\S]*?\}/.exec(fnWindow);
  assert.ok(guardFailBlock, 'applyAutoTicketCompletionValidation must still guard on !guard.ok');
  assert.doesNotMatch(
    guardFailBlock[0],
    /safeDeactivate\(/,
    'applyAutoTicketCompletionValidation must not safeDeactivate on guard failure — its single caller now parks and continues the loop instead of halting',
  );
});

// WS-1c (ticket c0293300) — de25ce90 (WS-1) made the done_without_commit_evidence
// halt path reach the post-loop tail, which called
// `printMinimalPanel('mux-runner Complete', {...}, 'GREEN', '🥒')` with a HARDCODED
// GREEN — a FATAL halt printed a green "Complete" panel while
// buildTmuxNotification (11 lines below) correctly titled it "Pickle Run Failed".
// The fix derives ONE verdict (`deriveCompletionVerdict`) from `isFailureExit`
// and feeds both renderers, so they cannot diverge again.

// B-GTRUTH WS-A2 INVERSION. WS-1c's original assertion (must NOT render GREEN) was
// correct while the reason was classified a FAILURE. WS-A2 reclassifies it as
// INCOMPLETE — the run did not fail, it did not finish — so AC-GTRUTH-A2-4 requires
// the panel not to render RED. The invariant being protected is unchanged and is what
// the union-wide parity test below actually enforces: ONE verdict derivation
// (deriveCompletionVerdict) feeds both renderers, so the panel and the notification
// can never disagree. Neither renderer may hardcode a colour.
//
// THIRD-STATE CORRECTION. "not RED" was WS-A2's requirement, and this test used to
// spell the other half as `title === '🥒 Pickle Run Complete'` — because the verdict
// was BINARY, so "not a failure" left only the success arm. That made the renderers
// claim a bundle that halted mid-flight had COMPLETED, contradicting this very
// comment's own "it did not finish". `CompletionVerdict` now carries the third state
// (`isIncomplete` / YELLOW / "Incomplete"), so both halves of the AC hold at once:
// not RED, and not a claim of completion.
test('AC-GTRUTH-A2-4: a done_without_commit_evidence exit renders neither a RED "Failed" nor a "Complete" panel', () => {
  const verdict = deriveCompletionVerdict('done_without_commit_evidence');
  assert.notEqual(
    verdict.colorName,
    'RED',
    'done_without_commit_evidence is INCOMPLETE, not failed — rendering the session RED told ' +
    'the operator a shipped bundle had failed. MUST fail on pre-fix source.',
  );
  assert.equal(verdict.isFailure, false, 'the demoted reason must not read as a failure verdict');
  assert.equal(verdict.isIncomplete, true, 'the demoted reason must read as the INCOMPLETE third state');
  assert.equal(
    verdict.panelTitle.includes('Complete'),
    false,
    'the panel must not claim "Complete" for a run that halted mid-bundle with an ' +
    'unaccounted-for ticket — honest reporting: never report an outcome you did not observe',
  );
  assert.equal(
    buildTmuxNotification('done_without_commit_evidence', 'implement', 3, 125).title,
    '🥒 Pickle Run Incomplete',
    'the notification must agree with the panel — the two renderers share one verdict derivation',
  );
});

test('mux-runner: the completion panel verdict matches buildTmuxNotification for every member of the ExitReason union', () => {

  // A NEW ExitReason member is picked up automatically, never hand-added.
  for (const reason of exitReasons()) {
    const groundTruth = isFailureExit(reason);
    // Failure wins on overlap, mirroring deriveCompletionVerdict's own precedence.
    const incomplete = !groundTruth && isIncompleteExit(reason);
    const panelVerdict = deriveCompletionVerdict(reason);

    assert.equal(panelVerdict.isFailure, groundTruth, `panel verdict for '${reason}' must match isFailureExit(exitReason)`);
    assert.equal(panelVerdict.isIncomplete, incomplete, `panel verdict for '${reason}' must match isIncompleteExit(exitReason)`);
    assert.equal(
      panelVerdict.colorName,
      groundTruth ? 'RED' : incomplete ? 'YELLOW' : 'GREEN',
      `panel color for '${reason}' must be RED on failure, YELLOW when incomplete, GREEN otherwise`,
    );
    // 'Incomplete' does not contain 'Complete' (capital C), so these two are a real
    // three-way partition and not a pair that can both pass on the same title.
    assert.equal(
      panelVerdict.panelTitle.includes('Complete'),
      !groundTruth && !incomplete,
      `panel title for '${reason}' must claim "Complete" only when the run neither failed nor ended incomplete`,
    );
    assert.equal(
      panelVerdict.panelTitle.includes('Incomplete'),
      incomplete,
      `panel title for '${reason}' must say "Incomplete" exactly when isIncompleteExit says so`,
    );

    const notif = buildTmuxNotification(reason, 'unknown', 1, 10);
    const notifIsFailure = notif.title.includes('Failed');
    assert.equal(notifIsFailure, groundTruth, `notification title for '${reason}' must match isFailureExit(exitReason)`);
    assert.equal(
      notif.title.includes('Incomplete'),
      incomplete,
      `notification title for '${reason}' must say "Incomplete" exactly when the panel does`,
    );
    assert.equal(
      notif.title.includes('Complete'),
      !groundTruth && !incomplete,
      `notification title for '${reason}' must claim "Complete" exactly when the panel does`,
    );

    assert.equal(
      panelVerdict.isFailure,
      notifIsFailure,
      `panel verdict and buildTmuxNotification verdict must agree for '${reason}' — they must never diverge`,
    );
  }
});

test('mux-runner: buildTmuxNotification behavior is unchanged — success and failure titles/subtitles', () => {
  const success = buildTmuxNotification('success', 'implement', 3, 125);
  assert.equal(success.title, '🥒 Pickle Run Complete');
  assert.match(success.subtitle, /^Finished in /);

  const failure = buildTmuxNotification('error', 'implement', 3, 125);
  assert.equal(failure.title, '🥒 Pickle Run Failed');
  assert.equal(failure.subtitle, 'Exit: error (phase: implement)');

  const stopped = buildTmuxNotification('cancelled', 'implement', 3, 125);
  assert.equal(stopped.title, '🥒 Pickle Run Complete');
  assert.match(stopped.subtitle, /^Stopped: cancelled /);
});

test('mux-runner: printMinimalPanel has exactly one call site in mux-runner.ts, and it is not hardcoded to a fixed color', () => {
  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');
  const callSites = [...source.matchAll(/printMinimalPanel\(/g)];
  assert.equal(
    callSites.length,
    1,
    `expected exactly 1 printMinimalPanel( call site in mux-runner.ts, found ${callSites.length} — a NEW panel call site on a failure-reachable path must derive its color from deriveCompletionVerdict/isFailureExit, never hardcode a literal colour`,
  );

  assert.ok(
    !/printMinimalPanel\([^)]*'GREEN'/.test(source),
    "no printMinimalPanel( call site may hardcode a literal 'GREEN' color argument",
  );

  const callSiteWindow = source.slice(callSites[0].index, callSites[0].index + 400);
  assert.match(
    callSiteWindow,
    /completionVerdict\.colorName/,
    'the completion panel call site must pass a color derived from completionVerdict (deriveCompletionVerdict), not a literal',
  );
});
