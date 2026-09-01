// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLAUDE_PATH = path.join(REPO_ROOT, 'CLAUDE.md');
const PACKAGE_JSON_PATH = path.resolve(__dirname, '..', 'package.json');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const RELEASE_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');
// Same capture semantics as engines-node-pin.test.js:13 -- strips the optional
// YAML quoting so the value compares verbatim against the JSON engines string.
const NODE_VERSION_RE = /^\s*node-version:\s*['"]?([^'"\n]+?)['"]?\s*$/gm;
const AUDIT_SCRIPTS = [
  'bash scripts/audit-test-tiers.sh',
  'bash scripts/audit-test-isolation.sh',
  'bash scripts/audit-subprocess-heavy-tests.sh',
  'bash scripts/audit-fix-commits.sh',
  'bash scripts/audit-bundle-thesis.sh',
  'bash scripts/audit-quarantine.sh',
  'bash scripts/audit-trap-door-enforcement.sh',
  'bash scripts/audit-guarded-reset.sh',
  'bash scripts/audit-un-terminalize-single-path.sh',
  'bash scripts/audit-did-we-count.sh',
].join(' && ');
const RELEASE_GATE_COMMAND = `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && ${AUDIT_SCRIPTS} && npm run test:fast:budget && npm run test:integration && npm run test:contract && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`;

function versioningSection(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(line => line === '## Versioning');
  assert.notEqual(start, -1, 'outer CLAUDE.md is missing ## Versioning section');
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? lines.length : end).join('\n');
}

function proseGateCommand() {
  const section = versioningSection(readFileSync(CLAUDE_PATH, 'utf8'));
  assert.ok(
    section.includes(`\`${RELEASE_GATE_COMMAND}\``),
    'outer CLAUDE.md Versioning section is missing the release gate command',
  );
  return RELEASE_GATE_COMMAND;
}

function runCommands(workflowText) {
  return workflowText
    .split(/\r?\n/)
    .map(line => line.match(/^\s*run:\s*(.+)\s*$/)?.[1])
    .filter(Boolean);
}

function nodeVersions(workflowText) {
  return [...workflowText.matchAll(NODE_VERSION_RE)].map(match => match[1]);
}

// R-RNTA: line-based job-block split (no YAML parser is a devDependency here,
// matching every other check in this file). Assumes top-level job names sit at
// exactly 2-space indent directly under `jobs:`, which is how every workflow in
// this repo is authored.
function jobBlocks(workflowText) {
  const lines = workflowText.split(/\r?\n/);
  const jobsStart = lines.findIndex(line => /^jobs:\s*$/.test(line));
  assert.notEqual(jobsStart, -1, 'workflow has no top-level jobs: key');

  const blocks = {};
  let currentName = null;
  let currentLines = [];
  for (let i = jobsStart + 1; i < lines.length; i++) {
    const jobHeader = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobHeader) {
      if (currentName) blocks[currentName] = currentLines.join('\n');
      currentName = jobHeader[1];
      currentLines = [];
    } else if (currentName) {
      currentLines.push(lines[i]);
    }
  }
  if (currentName) blocks[currentName] = currentLines.join('\n');
  return blocks;
}

function jobNameContaining(blocks, needle) {
  return Object.keys(blocks).find(name => blocks[name].includes(needle));
}

const TARBALL_STEP = 'Build tarball';

// R-RNTA: job-level keys sit at EXACTLY 4-space indent -- a direct child of the 2-space job
// name. Step-level keys sit deeper (release.yml:68's `if: failure()` is at 8). Reading the
// LEVEL is what separates "this whole job is skipped" from "this one step is skipped", and
// only the former can starve the release asset.
function jobLevelKeys(blockText) {
  return new Set(
    blockText
      .split('\n')
      .map(line => line.match(/^ {4}([A-Za-z0-9_-]+):/)?.[1])
      .filter(Boolean),
  );
}

// The oracle behind both the R-RNTA pin and its control arms. Returns one string per way the
// tarball's EXISTENCE has been made contingent on the gate's VERDICT; [] means independent.
// Shared on purpose: a control arm is only evidence if it exercises the same code as the pin.
function tarballIndependenceViolations(workflowText, gateNeedle) {
  const blocks = jobBlocks(workflowText);
  const gateJob = jobNameContaining(blocks, gateNeedle);
  const tarballJob = jobNameContaining(blocks, TARBALL_STEP);
  const violations = [];

  if (!gateJob) violations.push('no job carries the release gate command');
  if (!tarballJob) violations.push(`no job carries the '${TARBALL_STEP}' step`);
  if (gateJob && tarballJob && gateJob === tarballJob) {
    violations.push(`the gate command and '${TARBALL_STEP}' share job '${gateJob}'`);
  }

  if (tarballJob) {
    const keys = jobLevelKeys(blocks[tarballJob]);
    // Fail-closed guard. If the job-level parse yields nothing recognisable then the
    // indentation drifted, and every membership test below would report "absent" for the
    // wrong reason -- i.e. this pin would go green by never looking at anything.
    if (!keys.has('runs-on') || !keys.has('steps')) {
      violations.push(`job '${tarballJob}' exposes no parseable job-level runs-on/steps`);
    }
    if (keys.has('needs')) violations.push(`job '${tarballJob}' declares a job-level needs:`);
    if (keys.has('if')) violations.push(`job '${tarballJob}' declares a job-level if:`);
  }

  return violations;
}

test('release workflow gate matches outer CLAUDE.md Versioning gate', () => {
  const workflow = readFileSync(RELEASE_WORKFLOW, 'utf8');
  const gate = proseGateCommand();

  assert.ok(
    runCommands(workflow).some(command => command.includes(gate)),
    'release.yml must contain the exact release gate command from outer CLAUDE.md',
  );
});

// c0f184d2: parity covered WHICH COMMANDS run but never WHICH RUNTIME they run
// on -- the exact seam this bundle came through (three workflows had drifted to a
// different Node major than engines.node while every test stayed green).
//
// The existence half is NOT redundant with engines-node-pin.test.js. That test
// globs every workflow and guards `pins.length > 0` across the WHOLE glob
// (engines-node-pin.test.js:43), so it iterates zero release.yml entries and
// still passes if release.yml drops its setup-node step entirely. Verified by
// mutation: deleting release.yml's setup-node step leaves both that suite and
// this file's command-parity tests green (7/7), with the release gate silently
// running on the runner's default Node. This test is what goes red there.
test('each gate-carrying workflow pins the release gate runtime', () => {
  const engineNode = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')).engines.node;

  for (const [name, workflowPath] of [
    ['release.yml', RELEASE_WORKFLOW],
    ['ci.yml', CI_WORKFLOW],
  ]) {
    const pins = nodeVersions(readFileSync(workflowPath, 'utf8'));

    assert.ok(
      pins.length > 0,
      `${name} carries the release gate but declares no setup-node node-version, so the gate would run on the runner default`,
    );

    for (const version of pins) {
      assert.equal(
        version,
        engineNode,
        `${name} runs the release gate on node-version '${version}' but engines.node is '${engineNode}'`,
      );
    }
  }
});

// R-RNTA: the gate and the release artifact are two concerns with different failure modes and
// must not share a job -- a gate outcome must never determine whether the tarball is built and
// attached. Measured 2026-09-01 (FR-C3): the decoupling itself shipped at 37452f90 (2026-08-29),
// so this is a regression pin over an already-correct workflow, not a fix.
//
// Mutation-verified RED on each of: `needs: [gate]` added to the artifact job; a job-level `if:`
// added to the artifact job; the two jobs merged back into one; the job-level indentation drifting
// out of parse range. The `if:` arm is the one this pin used to MISS -- it checked only `needs:`,
// so an `if:` that skips the artifact job on a tag push starved the release asset while this test
// stayed green. The control arms below prove every one of those verdicts is reachable from the
// same oracle, so this pin cannot pass by never firing.
test('release tarball build/attach is independent of the gate job', () => {
  const workflow = readFileSync(RELEASE_WORKFLOW, 'utf8');

  assert.deepEqual(
    tarballIndependenceViolations(workflow, proseGateCommand()),
    [],
    'a gate failure must not be able to skip the tarball build or the GitHub release',
  );
});

// Control-arm fixtures: synthetic workflows carrying their own literal gate needle. Nothing here
// is read back out of release.yml, so an arm's expected value cannot be derived from the very
// thing the pin measures. Arm 0 establishes that this shape is clean, which is what licenses
// arms 1-4 to attribute their single-element result to the ONE mutation each introduces.
const CONTROL_GATE = 'run-the-control-gate';
const CONTROL_GATE_STEP = `      - name: Gate\n        run: ${CONTROL_GATE}`;
const CONTROL_TARBALL_STEP = `      - name: ${TARBALL_STEP}\n        run: tar -czf out.tgz .`;

function controlWorkflow({ artifactJobKeys = '', merged = false, artifactIndent = 4 } = {}) {
  if (merged) {
    return `jobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n`
      + `${CONTROL_GATE_STEP}\n${CONTROL_TARBALL_STEP}\n`;
  }
  const pad = ' '.repeat(artifactIndent);
  return `jobs:\n  gate:\n    runs-on: ubuntu-latest\n    steps:\n${CONTROL_GATE_STEP}\n`
    + `  release:\n${artifactJobKeys}${pad}runs-on: ubuntu-latest\n${pad}steps:\n`
    + `${CONTROL_TARBALL_STEP}\n`;
}

test('R-RNTA control 0: a decoupled two-job workflow reports no violations', () => {
  assert.deepEqual(
    tarballIndependenceViolations(controlWorkflow(), CONTROL_GATE),
    [],
    'the control fixture itself must be clean, or arms 1-4 prove nothing',
  );
});

test('R-RNTA control 1: a job-level needs: on the artifact job IS reported', () => {
  assert.deepEqual(
    tarballIndependenceViolations(
      controlWorkflow({ artifactJobKeys: '    needs: [gate]\n' }),
      CONTROL_GATE,
    ),
    ["job 'release' declares a job-level needs:"],
  );
});

test('R-RNTA control 2: a job-level if: on the artifact job IS reported', () => {
  assert.deepEqual(
    tarballIndependenceViolations(
      controlWorkflow({ artifactJobKeys: '    if: ${{ false }}\n' }),
      CONTROL_GATE,
    ),
    ["job 'release' declares a job-level if:"],
  );
});

test('R-RNTA control 3: the gate and the tarball sharing one job IS reported', () => {
  assert.deepEqual(
    tarballIndependenceViolations(controlWorkflow({ merged: true }), CONTROL_GATE),
    [`the gate command and '${TARBALL_STEP}' share job 'release'`],
  );
});

test('R-RNTA control 4: an artifact job whose job-level keys do not parse IS reported', () => {
  // The fail-closed half. Without this the 4-space key read would go green on a reformat by
  // finding no keys at all, which is exactly how a structural pin stops being able to fire.
  assert.deepEqual(
    tarballIndependenceViolations(controlWorkflow({ artifactIndent: 6 }), CONTROL_GATE),
    ["job 'release' exposes no parseable job-level runs-on/steps"],
  );
});

test('ci workflow runs full gate on push and PR to main', () => {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8');

  assert.match(workflow, /^\s*pull_request:\s*$/m);
  assert.match(workflow, /^\s*push:\s*$/m);
  assert.match(workflow, /^\s*-\s*main\s*$/m);
  assert.ok(
    runCommands(workflow).some(command => command.includes(RELEASE_GATE_COMMAND)),
    'ci.yml must contain the full gate command including audit scripts and expensive tests',
  );
});

// A tier the runner ACCEPTS but no gate command INVOKES is a test suite that exists,
// audits green and never executes. Measured at the time this pin was written: `contract`
// was such a tier -- 4 files / 99 tests, accepted by test-runner's VALID_TIERS, blessed by
// audit-test-tiers.sh and audit-trap-door-enforcement.sh, cited by three ENFORCE clauses in
// src/lib/CLAUDE.md, and reachable from no npm script at all. The tier set is READ FROM THE
// RUNNER rather than restated here, so adding a fifth tier without a consumer reds this pin
// instead of silently repeating the defect.
function reachedTiers(gateCommand, scripts, rootDir) {
  const tiers = new Set();
  const seenScripts = new Set();
  const seenFiles = new Set();

  const absorb = (text) => {
    // Both spellings reach the runner: the shell form `--tier contract` and the argv form
    // `'--tier', 'fast'` (bin/check-flake-budget.js). A pattern that reads only the shell form
    // reports the fast tier as unreached.
    for (const match of text.matchAll(/--tier['"]?[\s,]+['"]?([A-Za-z0-9_-]+)['"]?/g)) tiers.add(match[1]);

    for (const match of text.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
      const name = match[1];
      if (seenScripts.has(name) || !(name in scripts)) continue;
      seenScripts.add(name);
      absorb(scripts[name]);
    }
    // `test:fast` is reached only THROUGH a script file (test:fast:budget shells out to
    // bin/check-flake-budget.js, which spawns the runner itself), so a shell-text-only
    // walk would report the fast tier as unreached.
    for (const match of text.matchAll(/node (bin\/[A-Za-z0-9._-]+\.js)/g)) {
      const rel = match[1];
      if (seenFiles.has(rel)) continue;
      seenFiles.add(rel);
      const abs = path.join(rootDir, rel);
      if (existsSync(abs)) absorb(readFileSync(abs, 'utf8'));
    }
  };

  absorb(gateCommand);
  return tiers;
}

test('every tier the test runner accepts is invoked by the release gate', () => {
  const extensionRoot = path.resolve(__dirname, '..');
  const runnerSource = readFileSync(path.join(extensionRoot, 'bin', 'test-runner.js'), 'utf8');

  const tierSet = runnerSource.match(/VALID_TIERS\s*=\s*new Set\(\[([^\]]*)\]\)/);
  assert.ok(tierSet, 'bin/test-runner.js must declare VALID_TIERS as a Set literal');
  const validTiers = [...tierSet[1].matchAll(/['"]([A-Za-z0-9_-]+)['"]/g)].map(m => m[1]);
  assert.ok(validTiers.length > 0, 'VALID_TIERS parsed to zero tiers — the literal shape drifted');

  const { scripts } = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  const reached = reachedTiers(RELEASE_GATE_COMMAND, scripts, extensionRoot);

  for (const tier of validTiers) {
    assert.ok(
      reached.has(tier),
      `test-runner accepts --tier ${tier} but no command reachable from the release gate ever `
      + `invokes it, so every '// @tier: ${tier}' file is audited green and never executed`,
    );
  }
});
