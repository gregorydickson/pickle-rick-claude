// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const EXTENSION_ROOT = path.resolve(import.meta.dirname, '..');
const AUDIT_SCRIPT = path.join(EXTENSION_ROOT, 'scripts', 'audit-bundle-thesis.sh');

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function runGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function fixturePrd(ids = ['R-RTC-3', 'R-RTC-4', 'R-RTC-5', 'R-RTC-7', 'R-RTC-8']) {
  const rows = ids.map((id) => `| ${id} | Fixture requirement | P0 |`).join('\n');
  return `# Fixture PRD

| ID | Requirement | Priority |
|---|---|---|
${rows}
`;
}

function fixtureMatrix(rows = ['A', 'B', 'C', 'D']) {
  const rowByBug = {
    A: '| A | missing-e2e | R-RTC-3 | extension/tests/fixtures/a-canary.test.js | Section A reproducer assertion. | n/a |',
    B: '| B | missing-e2e | R-RTC-4 | extension/tests/fixtures/b-canary.test.js | Section B reproducer assertion. | n/a |',
    C: '| C | coverage-gap | R-RTC-5 | extension/tests/fixtures/c-canary.test.js | Section C reproducer assertion. | n/a |',
    D: '| D | mock-drift | R-RTC-7, R-RTC-8 | extension/tests/fixtures/d-canary.test.js | Section D reproducer assertion. | n/a |',
  };

  return `# Fixture Matrix

| Bug | Failure-mode classification | Section E artifact (R-RTC-N) | Canary test path | Bug-repro assertion | other-rationale |
|---|---|---|---|---|---|
${rows.map((bug) => rowByBug[bug]).join('\n')}
`;
}

function createFixtureRepo({ matrix = fixtureMatrix(), prd = fixturePrd(), missingCanary = false } = {}) {
  const repoRoot = makeTempDir('bundle-thesis-fixture-');

  try {
    assert.equal(runGit(repoRoot, ['init', '-b', 'main']).status, 0);
    assert.equal(runGit(repoRoot, ['config', 'user.email', 'test@example.com']).status, 0);
    assert.equal(runGit(repoRoot, ['config', 'user.name', 'Test User']).status, 0);

    writeFile(repoRoot, 'extension/scripts/audit-bundle-thesis.sh', fs.readFileSync(AUDIT_SCRIPT, 'utf8'));
    writeFile(repoRoot, 'prds/archive/design-notes/bundle-thesis-matrix.md', matrix);
    writeFile(repoRoot, 'prds/archive/bundles/p1-reliability-and-test-coverage-bundle-2026-05-03.md', prd);

    for (const name of ['a', 'b', 'c', 'd']) {
      if (missingCanary && name === 'c') {
        continue;
      }
      writeFile(
        repoRoot,
        `extension/tests/fixtures/${name}-canary.test.js`,
        "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture canary passes', () => assert.equal(1, 1));\n",
      );
    }

    assert.equal(runGit(repoRoot, ['add', '.']).status, 0);
    assert.equal(runGit(repoRoot, ['commit', '-m', 'baseline']).status, 0);
    return repoRoot;
  } catch (error) {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    throw error;
  }
}

function runAudit(repoRoot) {
  return spawnSync('bash', ['extension/scripts/audit-bundle-thesis.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function withFixture(options, fn) {
  const repoRoot = createFixtureRepo(options);
  try {
    fn(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test('bundle thesis audit: valid matrix exits green', () => {
  withFixture({}, (repoRoot) => {
    const result = runAudit(repoRoot);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  });
});

test('bundle thesis audit: missing row exits red with evidence', () => {
  withFixture({ matrix: fixtureMatrix(['A', 'B', 'D']) }, (repoRoot) => {
    const result = runAudit(repoRoot);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /C: missing matrix row/);
    assert.match(result.stderr, /matrix: expected exactly 4 rows, found 3/);
  });
});

test('bundle thesis audit: missing R-RTC requirement exits red', () => {
  withFixture({ prd: fixturePrd(['R-RTC-3', 'R-RTC-4', 'R-RTC-5', 'R-RTC-7']) }, (repoRoot) => {
    const result = runAudit(repoRoot);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /D: missing requirement in PRD: R-RTC-8/);
  });
});

test('bundle thesis audit: missing concrete canary exits red', () => {
  withFixture({ missingCanary: true }, (repoRoot) => {
    const result = runAudit(repoRoot);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /C: canary missing at HEAD: extension\/tests\/fixtures\/c-canary\.test\.js/);
  });
});

test('bundle thesis audit: other classification requires follow-up PRD rationale', () => {
  const matrix = fixtureMatrix().replace(
    '| C | coverage-gap | R-RTC-5 | extension/tests/fixtures/c-canary.test.js | Section C reproducer assertion. | n/a |',
    '| C | other | R-RTC-5 | extension/tests/fixtures/c-canary.test.js | Section C reproducer assertion. | missing-rationale |',
  );

  withFixture({ matrix }, (repoRoot) => {
    const result = runAudit(repoRoot);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /C: other classification requires other-rationale PRD path/);
  });
});
