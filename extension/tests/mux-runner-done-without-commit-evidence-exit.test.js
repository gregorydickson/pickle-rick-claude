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
 * node:test has no describe.each — the "for every live site" assertion is a
 * plain loop inside one test().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_TS = path.resolve(__dirname, '..', 'src', 'bin', 'mux-runner.ts');

const { isHaltExit, isFailureExit } = await import('../bin/mux-runner.js');

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

test('mux-runner: done_without_commit_evidence classifiers map to a non-zero exit', () => {
  assert.equal(isHaltExit('done_without_commit_evidence'), true, "isHaltExit('done_without_commit_evidence') must be true");
  assert.equal(isFailureExit('done_without_commit_evidence'), true, "isFailureExit('done_without_commit_evidence') must be true");

  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');
  assert.ok(
    source.includes("if (exitReason === 'iteration_cap_exhausted') exitCode = 3;"),
    'TS source must map iteration_cap_exhausted to exit code 3 ahead of the isFailedExit branch',
  );
  assert.ok(
    source.includes('else if (isFailedExit) exitCode = 1;'),
    'TS source must map every other isFailureExit(exitReason) to exit code 1',
  );

  // Replicate the exact exit-code decision at :11347-11349 to prove
  // 'done_without_commit_evidence' resolves to exit code 1, without invoking
  // the process.exit-driving main().
  const exitReason = 'done_without_commit_evidence';
  const isFailedExit = isFailureExit(exitReason);
  let exitCode;
  if (exitReason === 'iteration_cap_exhausted') exitCode = 3;
  else if (isFailedExit) exitCode = 1;
  else exitCode = 0;
  assert.equal(exitCode, 1, "'done_without_commit_evidence' must map to exit code 1");
});
