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

test('guard step runs before actions/setup-node@v4 and before the install/compile step', () => {
  const workflow = readWorkflow();

  const guardIndex = workflow.indexOf('Verify tag matches package version');
  const setupNodeIndex = workflow.indexOf('actions/setup-node@v4');
  const installIndex = workflow.indexOf('Install and compile');

  assert.notEqual(guardIndex, -1, 'guard step not found');
  assert.notEqual(setupNodeIndex, -1, 'setup-node step not found');
  assert.notEqual(installIndex, -1, 'install/compile step not found');

  assert.ok(
    guardIndex < setupNodeIndex,
    'guard step must run before actions/setup-node@v4 so a mismatched tree fails before the toolchain is even provisioned',
  );
  assert.ok(
    guardIndex < installIndex,
    'guard step must run before the Install and compile step so a mismatched tree does not pay for the ~20-minute gate',
  );
});
