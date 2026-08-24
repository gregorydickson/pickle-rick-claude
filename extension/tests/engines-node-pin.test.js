// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');
const PACKAGE_JSON_PATH = path.join(EXTENSION_ROOT, 'package.json');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const NODE_VERSION_RE = /^\s*node-version:\s*['"]?([^'"\n]+?)['"]?\s*$/gm;

function readPackageJson() {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
}

// 2724f7d0: glob every workflow rather than naming release.yml. ci.yml and
// stability-gate.yml drifted to a different major precisely because no test
// read them; hardcoding three paths would just move that hole to the fourth
// workflow. Collects EVERY match per file, so a second setup-node step in one
// workflow is covered too.
function readWorkflowNodeVersions() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .flatMap((workflow) => {
      const contents = readFileSync(path.join(WORKFLOWS_DIR, workflow), 'utf8');
      return [...contents.matchAll(NODE_VERSION_RE)].map((match) => ({
        workflow,
        version: match[1],
      }));
    });
}

test('package node engine matches every workflow setup-node version', () => {
  const packageJson = readPackageJson();
  const pins = readWorkflowNodeVersions();

  // Without this guard the loop below iterates zero times and passes green
  // while asserting nothing -- the same silent hole this test exists to close.
  assert.ok(pins.length > 0, `no workflow under ${WORKFLOWS_DIR} declares a setup-node node-version`);

  for (const { workflow, version } of pins) {
    assert.equal(
      version,
      packageJson.engines.node,
      `${workflow} pins node-version '${version}' but engines.node is '${packageJson.engines.node}'`,
    );
  }
});

test('codex engine is a >= floor (not an exact pin)', () => {
  const packageJson = readPackageJson();

  // c24b3c6b: codex engines pin is a >= floor, not an exact match — newer
  // codex CLIs satisfy the floor; an exact pin would reject every upgrade.
  assert.match(packageJson.engines.codex, /^>=\d+\.\d+\.\d+$/);
});

test('_audit.c8 documents the pinned coverage dependency', () => {
  const packageJson = readPackageJson();

  assert.ok(packageJson._audit.c8);
  assert.equal(packageJson._audit.c8.version, packageJson.devDependencies.c8);
});

test('engines.claude and engines.gh exist as exact pins', () => {
  const packageJson = readPackageJson();

  assert.ok('claude' in packageJson.engines, 'engines.claude must exist');
  assert.ok('gh' in packageJson.engines, 'engines.gh must exist');
  assert.match(packageJson.engines.claude, /^\d+\.\d+\.\d+$/);
  assert.match(packageJson.engines.gh, /^\d+\.\d+\.\d+$/);
});

test('node engine is a major-line pin (not a floor or an exact triple)', () => {
  const packageJson = readPackageJson();

  // e9fa6331: node's engines grammar is a major-line spec `<major>.x` — alone among the
  // candidate grammars it pins the major while letting the patch float, so runner image
  // bumps don't churn this file. (`codex` is a `>=` floor; `claude`/`gh` are exact
  // reproducibility triples.) setup-node accepts the same literal, so the equality
  // assertion above can compare it to `node-version` verbatim.
  assert.match(packageJson.engines.node, /^\d+\.x$/);
});
