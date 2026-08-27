// @tier: fast
// AC-D2' part 2 (ticket f6d3a6b4): the mux-runner roster loop must not exit 0
// (local `exitReason = 'success'`) while `finalizeIfTrulyComplete` has just
// REFUSED — i.e. its own ground-truth re-scan (`muxBundleScan`) found a
// residual ticket (e.g. still `In Progress`). Pre-fix, both the `task_completed`
// and `review_clean` branches of the live `runMuxRunnerMain` loop discarded
// `finalizeIfTrulyComplete`'s return value and unconditionally set
// `exitReason = 'success'; break;` — so mux-runner exited 0 and printed a
// GREEN "mux-runner Complete" banner even when the finalize call it had just
// made refused and stamped `state.json.exit_reason` to `pipeline_phase_incomplete`
// / `phase_no_progress`. That split-brain (state.json says incomplete, process
// exit code says success) is why pipeline-runner never took the primary
// exit-code-3 `resolvePhaseIncompleteOutcome` route and had to fall back on the
// secondary `maybeStampPhaseGraduation` safety net, whose `reportPhaseIncomplete`
// cause line is the AC-D2' part-1 defect this same ticket fixes.
//
// `runMuxRunnerMain` is not exported (see the `mux-runner-done-without-commit-
// evidence-exit.test.js` REPORTED GAP and `post-final-verdict-oracle.test.js`'s
// identical pattern) — this is a source-shape conformance pin against the LIVE
// branch, distinguished from the dead `ctx.log(...)` `processTaskCompleted`/
// `processCompletionBranch` siblings (zero production callers — see the "loop
// helpers extracted, never wired" trap door in extension/CLAUDE.md) by excluding
// any `.`-qualified log receiver.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/bin/mux-runner.ts', import.meta.url), 'utf8');

function findLiveMarker(literal, label) {
  const re = new RegExp(`(?<![.\\w])log\\('${literal}'\\);`, 'g');
  const indices = [...src.matchAll(re)].map((m) => m.index);
  assert.deepEqual(
    indices.length,
    1,
    `exactly one UNQUALIFIED '${literal}' log line — a second hit means the dead sibling now also matches, or the live one was removed (${label})`,
  );
  return indices[0];
}

test('task_completed branch continues (does not exit) when finalizeIfTrulyComplete refuses', () => {
  const markerIndex = findLiveMarker('Task completed\\. Exiting loop\\.', 'task_completed');
  const nextBranchIndex = src.indexOf("} else if (result === 'review_clean')", markerIndex);
  assert.ok(nextBranchIndex > markerIndex, 'could not locate the end of the task_completed branch');
  const branch = src.slice(markerIndex, nextBranchIndex);

  assert.ok(
    branch.includes('finalizeIfTrulyComplete('),
    'the task_completed branch must still call the single completion authority',
  );
  assert.ok(
    /const finalizeResult = finalizeIfTrulyComplete\(/.test(branch),
    'the return value must be captured, not discarded',
  );

  const guardIndex = branch.indexOf('if (!finalizeResult.finalized) {');
  assert.ok(guardIndex >= 0, 'a refused finalize must be checked before deciding to exit');

  const successIndex = branch.indexOf("exitReason = 'success';");
  assert.ok(successIndex >= 0, 'the happy path must still set exitReason to success');
  assert.ok(
    guardIndex < successIndex,
    'the refusal guard must be evaluated BEFORE the unconditional success assignment',
  );

  // The refusal guard's own body must `continue` the loop, never `break` — a
  // break here would still exit the process (the exact bug this pins against),
  // even if some other field were changed first.
  const guardBody = branch.slice(guardIndex, successIndex);
  assert.ok(
    /\bcontinue;/.test(guardBody),
    'a refused finalize must continue the roster loop, not fall through to exit',
  );
  assert.ok(
    !/\bbreak;/.test(guardBody),
    'a refused finalize must not break out of the loop — that reintroduces the false success exit',
  );
});

test('review_clean branch continues (does not exit) when finalizeIfTrulyComplete refuses', () => {
  const markerIndex = findLiveMarker('Review clean\\. Exiting loop\\.', 'review_clean');
  const nextBranchIndex = src.indexOf("} else if (result === 'inactive')", markerIndex);
  assert.ok(nextBranchIndex > markerIndex, 'could not locate the end of the review_clean branch');
  const branch = src.slice(markerIndex, nextBranchIndex);

  assert.ok(
    branch.includes('finalizeIfTrulyComplete('),
    'the review_clean branch must still call the single completion authority',
  );
  assert.ok(
    /const finalizeResult = finalizeIfTrulyComplete\(/.test(branch),
    'the return value must be captured, not discarded',
  );

  const guardIndex = branch.indexOf('if (!finalizeResult.finalized) {');
  assert.ok(guardIndex >= 0, 'a refused finalize must be checked before deciding to exit');

  const successIndex = branch.indexOf("exitReason = 'success';");
  assert.ok(successIndex >= 0, 'the happy path must still set exitReason to success');
  assert.ok(
    guardIndex < successIndex,
    'the refusal guard must be evaluated BEFORE the unconditional success assignment',
  );

  const guardBody = branch.slice(guardIndex, successIndex);
  assert.ok(
    /\bcontinue;/.test(guardBody),
    'a refused finalize must continue the roster loop, not fall through to exit',
  );
  assert.ok(
    !/\bbreak;/.test(guardBody),
    'a refused finalize must not break out of the loop — that reintroduces the false success exit',
  );
});

// Negative control: the OTHER `review_clean` sub-branch (the state-read-failure
// fallback, which cannot re-attempt a scan because it could not even read
// state.json) is a deliberate, out-of-scope exception — a genuine
// cannot-continue edge distinct from the false-success ambiguity this ticket
// collapses. Pin its existence so a future refactor cannot silently delete the
// distinction without this test noticing.
test('review_clean state-read-failure fallback remains a distinct, unmodified branch', () => {
  const idx = src.indexOf('Cannot read state.json after review_clean');
  assert.ok(idx >= 0, 'the state-read-failure fallback must still exist as its own branch');
});
