// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
].join(' && ');
const RELEASE_GATE_COMMAND = `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && ${AUDIT_SCRIPTS} && npm run test:fast:budget && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`;

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
