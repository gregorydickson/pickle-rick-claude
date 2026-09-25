// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getWorkspacePackages, filterByScope, runGate } from '../../services/convergence-gate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE = path.resolve(__dirname, '../fixtures/workspace-3-pkg');

test('getWorkspacePackages: 3-pkg fixture returns 3 absolute paths', () => {
  const pkgs = getWorkspacePackages(FIXTURE);
  assert.equal(pkgs.length, 3, `expected 3 packages, got ${pkgs.length}: ${pkgs.join(', ')}`);
  for (const p of pkgs) {
    assert.ok(path.isAbsolute(p), `expected absolute path, got ${p}`);
    assert.ok(fs.existsSync(path.join(p, 'package.json')), `no package.json in ${p}`);
  }
});

test('getWorkspacePackages: returns packages/a, packages/b, packages/c', () => {
  const pkgs = getWorkspacePackages(FIXTURE);
  const names = pkgs.map(p => path.basename(p)).sort();
  assert.deepEqual(names, ['a', 'b', 'c']);
});

test('getWorkspacePackages: nested workspace globs resolve nested package dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nested-workspaces-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'workspace-root',
      private: true,
      workspaces: ['packages/*/*'],
    }, null, 2));

    const nestedA = path.join(dir, 'packages', 'group-a', 'svc-a');
    const nestedB = path.join(dir, 'packages', 'group-b', 'svc-b');
    fs.mkdirSync(nestedA, { recursive: true });
    fs.mkdirSync(nestedB, { recursive: true });
    fs.writeFileSync(path.join(nestedA, 'package.json'), JSON.stringify({ name: 'svc-a' }, null, 2));
    fs.writeFileSync(path.join(nestedB, 'package.json'), JSON.stringify({ name: 'svc-b' }, null, 2));

    const pkgs = getWorkspacePackages(dir)
      .map(p => path.relative(dir, p).replace(/\\\\/g, '/'))
      .sort();

    assert.deepEqual(pkgs, [
      'packages/group-a/svc-a',
      'packages/group-b/svc-b',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('filterByScope: allowedPaths=packages/b/** returns only b (relative paths)', () => {
  const relPaths = ['packages/a', 'packages/b', 'packages/c'];
  const filtered = filterByScope(relPaths, { scope: 'full', allowedPaths: ['packages/b/**'] });
  assert.deepEqual(filtered, ['packages/b']);
});

test('filterByScope: no allowedPaths returns all files', () => {
  const files = ['packages/a', 'packages/b', 'packages/c'];
  assert.deepEqual(filterByScope(files, { scope: 'full' }), files);
});

test('filterByScope: empty allowedPaths returns all files', () => {
  const files = ['packages/a', 'packages/b'];
  assert.deepEqual(filterByScope(files, { scope: 'full', allowedPaths: [] }), files);
});

test('filterByScope: allowedPaths=packages/a/** + packages/c/** returns a and c', () => {
  const files = ['packages/a', 'packages/b', 'packages/c'];
  const filtered = filterByScope(files, { scope: 'full', allowedPaths: ['packages/a/**', 'packages/c/**'] });
  assert.deepEqual(filtered.sort(), ['packages/a', 'packages/c']);
});

test('filterByScope: exact file allowedPaths keeps owning workspace package in scope', () => {
  const files = ['packages/a', 'packages/b', 'packages/c'];
  const filtered = filterByScope(files, { scope: 'full', allowedPaths: ['packages/b/src/index.ts'] });
  assert.deepEqual(filtered, ['packages/b']);
});

test('runGate: workspace fixture scope=full allowedPaths=packages/a/** only runs in a', async () => {
  const result = await runGate({
    workingDir: FIXTURE,
    mode: 'strict',
    scope: 'full',
    checks: ['tests'],
    allowedPaths: ['packages/a/**'],
  });
  assert.equal(typeof result.status, 'string');
  assert.ok(['green', 'red', 'green-with-known-flake-warnings'].includes(result.status));
  assert.ok(Array.isArray(result.failures));
  assert.equal(typeof result.elapsed_ms, 'number');
  assert.equal(result.baseline_used, false);
  assert.equal(result.allowed_paths_used, true);
  assert.equal(result.status, 'green');
  assert.equal(result.failures.length, 0);
});

test('runGate: workspace fixture scope=full no allowedPaths runs all 3 packages', async () => {
  const result = await runGate({
    workingDir: FIXTURE,
    mode: 'strict',
    scope: 'full',
    checks: ['tests'],
  });
  assert.equal(result.status, 'green');
  assert.equal(result.failures.length, 0);
  assert.equal(result.allowed_paths_used, false);
});

test('runGate: allowedPaths can exclude an otherwise-failing workspace package', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'workspace-root',
      private: true,
      workspaces: ['packages/*'],
    }, null, 2));

    const passingDir = path.join(dir, 'packages', 'passing');
    const failingDir = path.join(dir, 'packages', 'failing');
    fs.mkdirSync(passingDir, { recursive: true });
    fs.mkdirSync(failingDir, { recursive: true });

    fs.writeFileSync(path.join(passingDir, 'package.json'), JSON.stringify({
      name: 'passing',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    fs.mkdirSync(path.join(passingDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(passingDir, 'src', 'index.ts'), 'export const ok = true;\n');
    fs.writeFileSync(path.join(failingDir, 'package.json'), JSON.stringify({
      name: 'failing',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(1)"' },
    }, null, 2));
    fs.mkdirSync(path.join(failingDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(failingDir, 'src', 'index.ts'), 'export const nope = false;\n');

    const scoped = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      allowedPaths: ['packages/passing/**'],
    });

    assert.equal(scoped.status, 'green');
    assert.deepEqual(scoped.failures, []);
    assert.equal(scoped.allowed_paths_used, true);
    assert.equal(scoped.total_raw_failure_count, 0, 'only the in-scope package should run');

    const unscoped = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
    });

    assert.equal(unscoped.status, 'red');
    assert.equal(unscoped.allowed_paths_used, false);
    assert.equal(unscoped.total_raw_failure_count, 1);
    assert.deepEqual(
      unscoped.failures.map(f => ({
        file: path.relative(dir, f.file),
        check: f.check,
        ruleOrCode: f.ruleOrCode,
      })),
      [
        {
          file: 'packages/failing',
          check: 'tests',
          ruleOrCode: '1',
        },
      ],
      'without allowedPaths the failing out-of-scope package must surface as a gate failure'
    );

    const scopedToExactFile = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
      allowedPaths: ['packages/passing/src/index.ts'],
    });

    assert.equal(scopedToExactFile.status, 'green');
    assert.deepEqual(scopedToExactFile.failures, []);
    assert.equal(scopedToExactFile.allowed_paths_used, true);
    assert.equal(
      scopedToExactFile.total_raw_failure_count,
      0,
      'an exact file scope must still run the owning package and exclude the failing sibling package',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGate: nested workspace globs do not false-green failing nested packages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-nested-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'workspace-root',
      private: true,
      workspaces: ['packages/*/*'],
    }, null, 2));

    const passingDir = path.join(dir, 'packages', 'group-a', 'passing');
    const failingDir = path.join(dir, 'packages', 'group-b', 'failing');
    fs.mkdirSync(passingDir, { recursive: true });
    fs.mkdirSync(failingDir, { recursive: true });

    fs.writeFileSync(path.join(passingDir, 'package.json'), JSON.stringify({
      name: 'nested-passing',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    fs.writeFileSync(path.join(failingDir, 'package.json'), JSON.stringify({
      name: 'nested-failing',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(1)"' },
    }, null, 2));

    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['tests'],
    });

    assert.equal(result.status, 'red');
    assert.equal(result.total_raw_failure_count, 1);
    assert.deepEqual(
      result.failures.map(f => path.relative(dir, f.file).replace(/\\\\/g, '/')),
      ['packages/group-b/failing'],
      'nested workspace failures must surface instead of silently skipping every package',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGate: root workspace control files keep all workspace packages in scope', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-root-scope-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'workspace-root',
      private: true,
      workspaces: ['packages/*'],
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');

    const passingDir = path.join(dir, 'packages', 'passing');
    const failingDir = path.join(dir, 'packages', 'failing');
    fs.mkdirSync(passingDir, { recursive: true });
    fs.mkdirSync(failingDir, { recursive: true });

    fs.writeFileSync(path.join(passingDir, 'package.json'), JSON.stringify({
      name: 'passing',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    fs.writeFileSync(path.join(failingDir, 'package.json'), JSON.stringify({
      name: 'failing',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(1)"' },
    }, null, 2));

    for (const allowedPaths of [['package.json'], ['pnpm-workspace.yaml']]) {
      const result = await runGate({
        workingDir: dir,
        mode: 'strict',
        scope: 'full',
        checks: ['tests'],
        allowedPaths,
      });

      assert.equal(result.status, 'red');
      assert.equal(result.total_raw_failure_count, 1);
      assert.deepEqual(
        result.failures.map(f => path.relative(dir, f.file).replace(/\\\\/g, '/')),
        ['packages/failing'],
        `root control file scope ${allowedPaths[0]} must still run the failing workspace package`,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGate: changed root workspace control files keep all workspace packages in scope', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-root-changed-'));
  try {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'workspace-root',
      private: true,
      workspaces: ['packages/*'],
    }, null, 2));

    const passingDir = path.join(dir, 'packages', 'passing');
    const failingDir = path.join(dir, 'packages', 'failing');
    fs.mkdirSync(passingDir, { recursive: true });
    fs.mkdirSync(failingDir, { recursive: true });

    fs.writeFileSync(path.join(passingDir, 'package.json'), JSON.stringify({
      name: 'passing',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    fs.writeFileSync(path.join(failingDir, 'package.json'), JSON.stringify({
      name: 'failing',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(1)"' },
    }, null, 2));

    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init workspace"', { cwd: dir, stdio: 'pipe' });

    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'workspace-root',
      private: true,
      version: '2.0.0',
      workspaces: ['packages/*'],
    }, null, 2));
    execSync('git add package.json', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "change root workspace manifest"', { cwd: dir, stdio: 'pipe' });

    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'changed',
      since: 'HEAD~1',
      checks: ['tests'],
      allowedPaths: ['package.json'],
    });

    assert.equal(result.status, 'red');
    assert.equal(result.total_raw_failure_count, 1);
    assert.deepEqual(
      result.failures.map(f => path.relative(dir, f.file).replace(/\\\\/g, '/')),
      ['packages/failing'],
      'changed root workspace manifests must keep every workspace package in scope',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A package-manager script the package does not define is never spawned: spawning it only
// yields ERR_PNPM_NO_SCRIPT, a spurious absolute-path failure row, a 'failed' check_status and an
// uncertifiable (project_type: null) baseline.
test('runGate: a workspace package without the gate lint script is skipped, not spawned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-noscript-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'workspace-root',
      private: true,
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');

    const pkgA = path.join(dir, 'packages', 'a');
    const pkgB = path.join(dir, 'packages', 'b');
    fs.mkdirSync(pkgA, { recursive: true });
    fs.mkdirSync(pkgB, { recursive: true });
    fs.writeFileSync(path.join(pkgA, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(pkgB, 'package.json'), JSON.stringify({
      name: 'b',
      version: '1.0.0',
      scripts: { 'lint:quiet': 'node -e "process.exit(0)"' },
    }, null, 2));

    const result = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['lint'],
    });
    assert.deepEqual(
      result.failures.filter(f => f.file === pkgA || f.file.startsWith(`${pkgA}${path.sep}`)),
      [],
      'no spawn (and so no failure row) in the package that lacks the script',
    );
    assert.equal(result.status, 'green');
    assert.equal(result.check_status?.lint, 'ran');

    const baselinePath = path.join(dir, 'session', 'gate', 'baseline.json');
    await runGate({
      workingDir: dir,
      mode: 'baseline',
      scope: 'full',
      checks: ['lint'],
      baselinePath,
      baselineIteration: 1,
    });
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.notEqual(baseline.project_type, null, 'a script-less package must not make the baseline uncertifiable');
    assert.equal(baseline.check_status.lint, 'ran');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runGate: a package-manager check whose script no package defines is skipped, not failed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-workspace-noscript-any-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'solo', version: '1.0.0' }, null, 2));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    const result = await runGate({ workingDir: dir, mode: 'strict', scope: 'full', checks: ['lint'] });
    assert.equal(result.check_status?.lint, 'skipped');
    assert.deepEqual(result.failures, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
