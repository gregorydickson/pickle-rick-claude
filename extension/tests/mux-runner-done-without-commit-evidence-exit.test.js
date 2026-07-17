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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_TS = path.resolve(__dirname, '..', 'src', 'bin', 'mux-runner.ts');

const muxRunner = await import('../bin/mux-runner.js');
const {
  isHaltExit,
  isFailureExit,
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

test('mux-runner: every live done_without_commit_evidence guard routes to exitReason+break, not bare return', () => {
  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');
  const sites = findDoneWithoutCommitEvidenceSites(source);

  // The authoritative sweep: exactly 5 recordExitReason(..., 'done_without_commit_evidence')
  // call sites exist in mux-runner.ts today (grep -n "done_without_commit_evidence" also
  // matches non-recordExitReason lines like the ExitReason union and FAILURE_EXIT_REASONS
  // set — this scan is scoped to recordExitReason( callsites only).
  assert.equal(sites.length, 5, `expected exactly 5 recordExitReason(..., 'done_without_commit_evidence') sites, found ${sites.length} at lines ${sites.map(s => s.lineNo).join(', ')}`);

  const bareReturnRe = /^\s*return;\s*$/m;
  const objectLiteralReturnRe = /return\s*\{/;
  const liveShapeRe = /exitReason\s*=\s*'done_without_commit_evidence';[\s\S]*?break;/;

  const liveSites = [];
  const excludedSites = [];
  const unclassified = [];

  for (const site of sites) {
    if (objectLiteralReturnRe.test(site.window)) {
      excludedSites.push(site);
    } else if (liveShapeRe.test(site.window) && !bareReturnRe.test(site.window)) {
      liveSites.push(site);
    } else {
      unclassified.push(site);
    }
  }

  assert.deepEqual(
    unclassified,
    [],
    `every recordExitReason(..., 'done_without_commit_evidence') site must classify as either the canonical exitReason+break shape or a known object-literal-return exclusion; unclassified sites (likely a NEW bare-return regression): ${JSON.stringify(unclassified.map(s => s.lineNo))}`,
  );

  // Exactly the three LIVE sites (~:10460, ~:10951/10952, ~:11026/11028) must have flipped.
  assert.equal(liveSites.length, 3, `expected exactly 3 live exitReason+break sites, found ${liveSites.length} at lines ${liveSites.map(s => s.lineNo).join(', ')}`);
  for (const site of liveSites) {
    assert.ok(
      !bareReturnRe.test(site.window),
      `live site at line ${site.lineNo} must NOT contain a bare "return;" — it must exit via exitReason + break`,
    );
    assert.match(
      site.window,
      /exitReason\s*=\s*'done_without_commit_evidence';/,
      `live site at line ${site.lineNo} must assign exitReason = 'done_without_commit_evidence'`,
    );
    assert.match(
      site.window,
      /break;/,
      `live site at line ${site.lineNo} must break out of the while(true) loop`,
    );
  }

  // Exactly the two KNOWN non-bare-return exclusions: ticket a3812edd's discarded-verdict
  // return (an `{ action: 'leave', ... }` object) and the dead processIterationOutcome
  // site (a `{ kind: 'break', ... }` object with zero production callers).
  assert.equal(excludedSites.length, 2, `expected exactly 2 known object-literal-return exclusions, found ${excludedSites.length} at lines ${excludedSites.map(s => s.lineNo).join(', ')}`);

  const a3812eddSite = excludedSites.find(s => /action:\s*'leave'/.test(s.window));
  assert.ok(a3812eddSite, 'ticket a3812edd\'s exclusion site (return { action: \'leave\', ... }) must be present — this ticket must NOT touch it');

  const deadSite = excludedSites.find(s => /kind:\s*'break'/.test(s.window));
  assert.ok(deadSite, 'the dead processIterationOutcome exclusion site (return { kind: \'break\', ... }) must be present — this ticket must NOT patch it');

  // Confirm the dead site is transitively unreachable: it sits inside processTaskCompleted,
  // whose only caller is processIterationOutcome, which itself has zero production callers
  // (its only other hit in src/ is the symbol-inventory string in bin/CLAUDE.md).
  const lines = source.split('\n');
  let enclosingFn = null;
  for (let i = deadSite.lineNo - 1; i >= 0; i--) {
    const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (m) { enclosingFn = m[1]; break; }
  }
  assert.equal(enclosingFn, 'processTaskCompleted', `dead exclusion site at line ${deadSite.lineNo} must be enclosed by processTaskCompleted, found ${enclosingFn}`);

  const taskCompletedCallers = [...source.matchAll(/processTaskCompleted\(/g)];
  // Exactly 2: its own declaration, plus the single call site inside processIterationOutcome.
  assert.equal(taskCompletedCallers.length, 2, `processTaskCompleted must have exactly one call site (inside processIterationOutcome) plus its own declaration; found ${taskCompletedCallers.length} occurrences`);

  const iterationOutcomeCallers = [...source.matchAll(/processIterationOutcome\(/g)];
  // Only the function's own declaration is expected — no other bin/service file imports and
  // invokes it, so processTaskCompleted (and its :7324 guard) is transitively dead code.
  assert.equal(iterationOutcomeCallers.length, 1, `processIterationOutcome must have zero production callers (declaration only); found ${iterationOutcomeCallers.length} occurrences`);
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
 * Parse the exit-code decision out of the TS source instead of re-implementing
 * it in the test. A hand-copied `if/else` would only ever prove the test's own
 * copy of the logic — it would keep passing while the source's mapping drifted.
 *
 * Fails CLOSED: an unparseable or reshaped exit map throws here rather than
 * yielding an empty/degenerate mapping that quietly passes.
 */
function deriveExitCodeMapFromSource(sourceText) {
  const capBranch = /if \(exitReason === '(\w+)'\) exitCode = (\d+);/.exec(sourceText);
  assert.ok(capBranch, 'exit map: could not parse the leading `if (exitReason === …) exitCode = N;` branch from mux-runner.ts — the map was reshaped, so this AC can no longer verify it');

  const failBranch = /else if \(isFailedExit\) exitCode = (\d+);/.exec(sourceText);
  assert.ok(failBranch, 'exit map: could not parse the `else if (isFailedExit) exitCode = N;` branch from mux-runner.ts — the map was reshaped, so this AC can no longer verify it');

  const defaultBranch = /else exitCode = (\d+);/.exec(sourceText);
  assert.ok(defaultBranch, 'exit map: could not parse the trailing `else exitCode = N;` branch from mux-runner.ts — the map was reshaped, so this AC can no longer verify it');

  const capReason = capBranch[1];
  const capCode = Number(capBranch[2]);
  const failCode = Number(failBranch[1]);
  const defaultCode = Number(defaultBranch[1]);

  return (reason) => {
    if (reason === capReason) return capCode;
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
test('mux-runner: the source exit map sends every failure ExitReason non-zero (forward-regression pin; vacuous pre-fix — see comment)', () => {
  assert.equal(isHaltExit('done_without_commit_evidence'), true, "isHaltExit('done_without_commit_evidence') must be true");
  assert.equal(isFailureExit('done_without_commit_evidence'), true, "isFailureExit('done_without_commit_evidence') must be true");

  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');
  const exitCodeFor = deriveExitCodeMapFromSource(source);

  // The AC's literal requirement.
  assert.equal(exitCodeFor('done_without_commit_evidence'), 1, "'done_without_commit_evidence' must map to exit code 1");

  // Derive the reason list from the ExitReason union itself, so a NEW failure
  // reason is covered automatically instead of being hand-added to a list.
  const unionMatch = source.match(/export type ExitReason = ([^;]+);/);
  assert.ok(unionMatch, 'ExitReason union declaration must be present in source');
  const reasons = [...unionMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(reasons.length > 10, `expected the ExitReason union to yield a substantial member list, found ${reasons.length}`);

  for (const reason of reasons) {
    const code = exitCodeFor(reason);
    if (reason === 'iteration_cap_exhausted') {
      assert.equal(code, 3, "'iteration_cap_exhausted' must keep its distinct exit code 3 (R-ICP-1)");
    } else if (isFailureExit(reason)) {
      assert.equal(code, 1, `'${reason}' is a failure exit and must map to a non-zero exit code 1 — a reclassification that sends it to 0 re-masks the failure`);
    } else {
      assert.equal(code, 0, `'${reason}' is not a failure exit and must map to exit code 0`);
    }
  }
});

// WS-1b (ticket a3812edd) — the FOURTH masking mechanism, distinct from the three
// bare-return sites de25ce90 fixed above. applyAutoTicketCompletionValidation (the
// :2892 excluded site) never bare-returns — it returns a verdict object. The bug is
// that its ONE production call site discarded that verdict entirely (a bare
// statement call), so a fatal `{action:'leave', reason:'guard_failed_no_commit_evidence'}`
// never reached the loop's exitReason+break exit path; the NEXT iteration's
// `state.active !== true` check then laundered it into 'cancelled' (exit 0).
test('mux-runner: applyAutoTicketCompletionValidation call site honors the fatal leave verdict', () => {
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
    /exitReason\s*=\s*'done_without_commit_evidence';[\s\S]{0,80}?break;/,
    "on the fatal guard-failure verdict, the call site must set exitReason = 'done_without_commit_evidence' and break out of the while(true) loop — matching the sibling precedent at the 'ticket already marked Done' branch",
  );
});

// WS-1c (ticket c0293300) — de25ce90 (WS-1) made the done_without_commit_evidence
// halt path reach the post-loop tail, which called
// `printMinimalPanel('mux-runner Complete', {...}, 'GREEN', '🥒')` with a HARDCODED
// GREEN — a FATAL halt printed a green "Complete" panel while
// buildTmuxNotification (11 lines below) correctly titled it "Pickle Run Failed".
// The fix derives ONE verdict (`deriveCompletionVerdict`) from `isFailureExit`
// and feeds both renderers, so they cannot diverge again.

test('mux-runner: a done_without_commit_evidence halt does not render a GREEN "Complete" panel', () => {
  const verdict = deriveCompletionVerdict('done_without_commit_evidence');
  assert.notEqual(verdict.colorName, 'GREEN', "done_without_commit_evidence must NOT render GREEN — MUST fail on pre-fix source (hardcoded 'GREEN')");
  assert.ok(
    !verdict.panelTitle.includes('Complete'),
    "done_without_commit_evidence must NOT title itself 'Complete' — MUST fail on pre-fix source (hardcoded 'mux-runner Complete')",
  );
});

test('mux-runner: the completion panel verdict matches buildTmuxNotification for every member of the ExitReason union', () => {
  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');

  // Derive the reason list from the ExitReason union itself — a NEW ExitReason
  // member must be picked up here automatically, never hand-added to a list.
  const unionMatch = source.match(/export type ExitReason = ([^;]+);/);
  assert.ok(unionMatch, 'ExitReason union declaration must be present in source');
  const reasons = [...unionMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(reasons.length > 10, `expected the ExitReason union to yield a substantial member list, found ${reasons.length}`);

  for (const reason of reasons) {
    const groundTruth = isFailureExit(reason);
    const panelVerdict = deriveCompletionVerdict(reason);

    assert.equal(panelVerdict.isFailure, groundTruth, `panel verdict for '${reason}' must match isFailureExit(exitReason)`);
    assert.equal(
      panelVerdict.colorName,
      groundTruth ? 'RED' : 'GREEN',
      `panel color for '${reason}' must be RED on failure, GREEN otherwise`,
    );
    assert.equal(
      panelVerdict.panelTitle.includes('Complete'),
      !groundTruth,
      `panel title for '${reason}' must say "Complete" only when it is NOT a failure exit`,
    );

    const notif = buildTmuxNotification(reason, 'unknown', 1, 10);
    const notifIsFailure = notif.title.includes('Failed');
    assert.equal(notifIsFailure, groundTruth, `notification title for '${reason}' must match isFailureExit(exitReason)`);

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
