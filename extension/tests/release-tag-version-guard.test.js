// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RELEASE_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');

// AC-R1/AC-R3 pin the tag<->version guard the same way release-gate-parity.test.js
// pins the gate command string: assert the EXACT comparison substrings are
// present, not merely that some `VERSION=`-shaped line exists anywhere in the
// file. A guard that only checks tag existence (the exact defect class this
// bundle exists to close -- see B-RELTAG PRD "detection failure" section)
// would leave a loose regex green.
const EXPECTED_DERIVATION = 'EXPECTED="${GITHUB_REF_NAME#v}"';
const ACTUAL_DERIVATION = 'ACTUAL="$(node -p "require(\'./extension/package.json\').version")"';
const COMPARISON = 'if [ "$EXPECTED" != "$ACTUAL" ]; then';
const FAILURE_STEP = 'exit 1';
const ERROR_MESSAGE_MARKER = 'Tag version';

function readWorkflow() {
  return readFileSync(RELEASE_WORKFLOW, 'utf8');
}

function guardStepBlock(workflowText) {
  const start = workflowText.indexOf('Verify tag matches package version');
  assert.notEqual(start, -1, 'release.yml is missing the "Verify tag matches package version" step');

  const nextStep = workflowText.indexOf('\n      - name:', start);
  const nextUse = workflowText.indexOf('\n      - uses:', start);
  const candidates = [nextStep, nextUse].filter((index) => index !== -1);
  const end = candidates.length > 0 ? Math.min(...candidates) : workflowText.length;

  return workflowText.slice(start, end);
}

test('release workflow guards the tag version against extension/package.json before install', () => {
  const workflow = readWorkflow();
  const block = guardStepBlock(workflow);

  assert.ok(
    block.includes(EXPECTED_DERIVATION),
    'guard step must derive EXPECTED from GITHUB_REF_NAME the same way the tarball step does',
  );
  assert.ok(
    block.includes(ACTUAL_DERIVATION),
    "guard step must read ACTUAL from extension/package.json's version via node -p",
  );
  assert.ok(
    block.includes(COMPARISON),
    'guard step must compare EXPECTED against ACTUAL, not merely reference both values independently',
  );
});

test('guard step fails the job on mismatch and names both values in the error', () => {
  const workflow = readWorkflow();
  const block = guardStepBlock(workflow);

  assert.ok(
    block.includes(FAILURE_STEP),
    'guard step must exit non-zero on mismatch so the job fails -- a guard that only logs would leave the job green',
  );
  assert.ok(
    block.includes(ERROR_MESSAGE_MARKER) && block.includes('${EXPECTED}') && block.includes('${ACTUAL}'),
    'guard step error message must name both the tag-derived expected version and the actual package.json version',
  );
});

// Step order is only defined WITHIN a job: GitHub Actions runs jobs without a
// `needs:` edge in parallel on separate runners, so a whole-file index
// comparison across two jobs measures authoring order, not execution order.
// This assertion was born (b003c572) against a single-job release.yml, where
// those were the same thing, and 37452f90 split the file into the independent
// `gate` and `release` jobs that release-gate-parity.test.js now pins apart --
// leaving the old cross-job form unsatisfiable while its sibling pin holds.
//
// The invariant that survives the split is co-location, not precedence against
// the gate's toolchain: the guard must sit in the SAME job as the artifact it
// guards, ahead of it. The `gate` job legitimately has no stake in the tag --
// it measures the tree -- so the old "fail before provisioning the toolchain"
// half is deliberately NOT re-expressed here; re-adding it would mean a second
// copy of the guard in a job that does not publish anything.
//
// Same-job membership is proved by slicing between the two steps and requiring
// no top-level job header in between, rather than by enumerating step names.
const JOB_HEADER_RE = /^ {2}[A-Za-z0-9_-]+:\s*$/m;

test('guard step precedes the artifact build inside the same job', () => {
  const workflow = readWorkflow();

  const guardIndex = workflow.indexOf('Verify tag matches package version');
  const buildIndex = workflow.indexOf('Build tarball');

  assert.notEqual(guardIndex, -1, 'guard step not found');
  assert.notEqual(buildIndex, -1, 'Build tarball step not found');

  assert.ok(
    guardIndex < buildIndex,
    'guard step must run before the Build tarball step so a mismatched tag never produces a release artifact',
  );
  assert.doesNotMatch(
    workflow.slice(guardIndex, buildIndex),
    JOB_HEADER_RE,
    'guard step and Build tarball must live in the SAME job -- across two jobs with no needs: edge they run in parallel, so the guard orders nothing',
  );
});
