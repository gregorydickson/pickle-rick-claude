// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PURGE_SCRIPT = path.join(REPO_ROOT, 'bin', 'purge-update-cache.js');

function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'purge-update-cache-test-'));
  const homeDir = path.join(dir, 'home');
  const tmpRoot = path.join(dir, 'tmp');
  const varFoldersRoot = path.join(dir, 'var-folders');
  const runtimeRoot = path.join(homeDir, '.claude', 'pickle-rick');
  const cachePath = path.join(runtimeRoot, 'update-check.json');
  const auditPath = path.join(runtimeRoot, 'deploy-audit.log');
  const tarballDir = path.join(tmpRoot, 'pickle-update-fixture');
  const extractDir = path.join(tmpRoot, 'pickle-extract-fixture');
  const prefixedTmpFile = path.join(tmpRoot, 'pickle-update-keep.txt');
  const darwinBranch = path.join(varFoldersRoot, 'zz', '12345', 'T');
  const darwinTarballDir = path.join(darwinBranch, 'pickle-update-darwin-fixture');
  const darwinExtractDir = path.join(darwinBranch, 'pickle-extract-darwin-fixture');
  const prefixedDarwinFile = path.join(darwinBranch, 'pickle-extract-darwin-keep.txt');
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(varFoldersRoot, { recursive: true });
  mkdirSync(tarballDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(darwinTarballDir, { recursive: true });
  mkdirSync(darwinExtractDir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify({
    last_check_epoch: 1,
    latest_version: '1.0.0',
    current_version: '1.0.0',
  }));
  writeFileSync(path.join(tarballDir, 'release.tar.gz'), 'fixture');
  writeFileSync(path.join(extractDir, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(darwinTarballDir, 'release.tar.gz'), 'fixture');
  writeFileSync(path.join(darwinExtractDir, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(prefixedTmpFile, 'leave me alone');
  writeFileSync(prefixedDarwinFile, 'leave me alone');
  return {
    dir,
    homeDir,
    tmpRoot,
    varFoldersRoot,
    cachePath,
    auditPath,
    tarballDir,
    extractDir,
    prefixedTmpFile,
    darwinTarballDir,
    darwinExtractDir,
    prefixedDarwinFile,
  };
}

function runPurge(fixture, args = []) {
  // B-CITAIL T4: these tests exercise the DEFAULT (HOME-based) runtime root. A
  // Linux-CI direct repro proved purge-update-cache.js resolves + removes the
  // fixture cache CORRECTLY under a clean `HOME`-override env — so the failure was
  // a LEAKED env var from the inherited full `process.env` re-rooting resolution
  // (CI sets EXTENSION_DIR + other PICKLE_* job-level), not a product bug. Spawn
  // with a MINIMAL hermetic env containing only what purge reads: PATH (to find
  // node), HOME (os.homedir → cache root), TMPDIR (os.tmpdir → updater tmp roots),
  // and PICKLE_PURGE_VAR_FOLDERS_ROOT. The EXTENSION_DIR-honoring tests below set
  // EXTENSION_DIR explicitly via their own spawn.
  const env = {
    PATH: process.env.PATH,
    HOME: fixture.homeDir,
    TMPDIR: fixture.tmpRoot,
    PICKLE_PURGE_VAR_FOLDERS_ROOT: fixture.varFoldersRoot,
  };
  return spawnSync('node', [PURGE_SCRIPT, ...args], { encoding: 'utf8', env });
}

describe('purge-update-cache.js', () => {
  test('removes update cache, updater tmp roots, and appends audit log', () => {
    const fixture = makeFixture();
    try {
      const result = runPurge(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.cachePath), false);
      assert.equal(existsSync(fixture.tarballDir), false);
      assert.equal(existsSync(fixture.extractDir), false);
      assert.equal(existsSync(fixture.prefixedTmpFile), true, 'prefix-matching tmp files must survive the purge');
      // B-CITAIL T4: var-folders cleanup is macOS-only by design
      // (`if (process.platform === 'darwin')` at purge-update-cache.js:102 —
      // /var/folders is a macOS concept). On Linux the darwin fixtures are
      // legitimately NOT purged, so these assertions are darwin-gated. (Verified
      // via Linux CI probe: cache + tmp-root removed, darwin dir untouched.)
      if (process.platform === 'darwin') {
        assert.equal(existsSync(fixture.darwinTarballDir), false);
        assert.equal(existsSync(fixture.darwinExtractDir), false);
        assert.equal(existsSync(fixture.prefixedDarwinFile), true, 'prefix-matching /var/folders files must survive the purge');
      }

      const lines = readFileSync(fixture.auditPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const audit = JSON.parse(lines[0]);
      assert.equal(audit.event, 'CACHE_PURGE');
      assert.ok(audit.removed_paths.includes(fixture.cachePath));
      assert.ok(audit.removed_paths.includes(fixture.tarballDir));
      assert.ok(audit.removed_paths.includes(fixture.extractDir));
      assert.equal(audit.removed_paths.includes(fixture.prefixedTmpFile), false);
      if (process.platform === 'darwin') {
        assert.ok(audit.removed_paths.includes(fixture.darwinTarballDir));
        assert.ok(audit.removed_paths.includes(fixture.darwinExtractDir));
        assert.equal(audit.removed_paths.includes(fixture.prefixedDarwinFile), false);
      }
      assert.equal(typeof audit.ts, 'string');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('succeeds without audit entry when cache and tmpdir entries are absent', () => {
    const fixture = makeFixture();
    try {
      rmSync(fixture.cachePath, { force: true });
      rmSync(fixture.tarballDir, { recursive: true, force: true });
      rmSync(fixture.extractDir, { recursive: true, force: true });
      rmSync(fixture.darwinTarballDir, { recursive: true, force: true });
      rmSync(fixture.darwinExtractDir, { recursive: true, force: true });
      const result = runPurge(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.auditPath), false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('dry-run reports paths without removing files or writing audit log', () => {
    const fixture = makeFixture();
    try {
      const result = runPurge(fixture, ['--dry-run']);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.cachePath), true);
      assert.equal(existsSync(fixture.tarballDir), true);
      assert.equal(existsSync(fixture.extractDir), true);
      assert.equal(existsSync(fixture.darwinTarballDir), true);
      assert.equal(existsSync(fixture.darwinExtractDir), true);
      assert.equal(existsSync(fixture.auditPath), false);
      assert.match(result.stderr, /Would remove/);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('honors EXTENSION_DIR for update cache and audit paths', () => {
    const fixture = makeFixture();
    const overrideRoot = path.join(fixture.dir, 'override-extension-root');
    const overrideCache = path.join(overrideRoot, 'update-check.json');
    const overrideAudit = path.join(overrideRoot, 'deploy-audit.log');
    try {
      mkdirSync(overrideRoot, { recursive: true });
      writeFileSync(path.join(overrideRoot, '.pickle-install-root'), '');
      writeFileSync(overrideCache, JSON.stringify({
        last_check_epoch: 2,
        latest_version: '2.0.0',
        current_version: '1.0.0',
      }));
      const result = spawnSync('node', [PURGE_SCRIPT], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fixture.homeDir,
          TMPDIR: fixture.tmpRoot,
          EXTENSION_DIR: overrideRoot,
          PICKLE_PURGE_VAR_FOLDERS_ROOT: fixture.varFoldersRoot,
        },
      });

      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(overrideCache), false);
      assert.equal(existsSync(fixture.cachePath), true);

      const lines = readFileSync(overrideAudit, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const audit = JSON.parse(lines[0]);
      assert.equal(audit.event, 'CACHE_PURGE');
      assert.ok(audit.removed_paths.includes(overrideCache));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('falls back to canonical runtime root when EXTENSION_DIR points at a missing install root', () => {
    const fixture = makeFixture();
    const invalidRoot = path.join(fixture.dir, 'missing-extension-root');
    const invalidAudit = path.join(invalidRoot, 'deploy-audit.log');
    try {
      const result = spawnSync('node', [PURGE_SCRIPT], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fixture.homeDir,
          TMPDIR: fixture.tmpRoot,
          EXTENSION_DIR: invalidRoot,
          PICKLE_PURGE_VAR_FOLDERS_ROOT: fixture.varFoldersRoot,
        },
      });

      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.cachePath), false, 'canonical cache must be purged when EXTENSION_DIR is invalid');
      assert.equal(existsSync(invalidAudit), false, 'invalid override root must not receive audit writes');

      const lines = readFileSync(fixture.auditPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 1);
      const audit = JSON.parse(lines[0]);
      assert.equal(audit.event, 'CACHE_PURGE');
      assert.ok(audit.removed_paths.includes(fixture.cachePath));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test('default runtime root matches the canonical extension root used by check-update.js', () => {
    const fixture = makeFixture();
    const codexRoot = path.join(fixture.homeDir, '.codex', 'pickle-rick');
    const codexCache = path.join(codexRoot, 'update-check.json');
    try {
      mkdirSync(codexRoot, { recursive: true });
      writeFileSync(codexCache, JSON.stringify({
        last_check_epoch: 3,
        latest_version: '3.0.0',
        current_version: '3.0.0',
      }));
      const result = runPurge(fixture);
      assert.strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      assert.equal(existsSync(fixture.cachePath), false, '.claude cache must be removed (canonical extension root)');
      assert.equal(existsSync(codexCache), true, '.codex cache must NOT be touched (regression guard for commit 5fc4ecee root drift)');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});
