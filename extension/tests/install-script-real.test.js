// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

test('install-script-real.e2e installs to prefix and leaves home settings.json untouched', () => {
  // Use a fake $HOME so agents, commands, backup, and settings all route to the temp dir
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-real-'));
  const prefix = path.join(homeDir, '.claude', 'pickle-rick');

  // Pre-create settings.json — install.sh exits 1 if it's missing when PICKLE_INSTALL_ROOT == $HOME/.claude/pickle-rick
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'settings.json'), '{}');

  const realSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const settingsBefore = fs.existsSync(realSettingsPath)
    ? fs.readFileSync(realSettingsPath, 'utf8')
    : null;

  try {
    const result = spawnSync('bash', [INSTALL_SH, '--prefix', prefix, '--no-confirm'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDir,
        PICKLE_INSTALL_ROOT: prefix,
        PICKLE_DATA_ROOT: path.join(homeDir, '.local', 'share', 'pickle-rick'),
      },
    });

    assert.equal(result.status, 0, `install.sh failed (exit ${result.status}):\n${result.stderr}`);

    const deployedPkgPath = path.join(prefix, 'extension', 'package.json');
    assert.ok(fs.existsSync(deployedPkgPath), `expected ${deployedPkgPath} to exist`);
    const pkgVer = JSON.parse(fs.readFileSync(deployedPkgPath, 'utf8')).version;
    const srcVer = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'extension', 'package.json'), 'utf8')).version;
    assert.equal(pkgVer, srcVer);

    const settings = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8');
    assert.match(settings, /\$\{PICKLE_INSTALL_ROOT[^}]*\}/);

    const settingsAfter = fs.existsSync(realSettingsPath)
      ? fs.readFileSync(realSettingsPath, 'utf8')
      : null;
    assert.equal(settingsAfter, settingsBefore);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

// --- declined-downgrade exit-code contract (6955c947 / GitHub #40) ---
//
// install.sh:207-211 reads the [y/N] downgrade prompt; a refusal must exit
// non-zero like its sibling refusals (active-session :200, version-guard
// :225) instead of reporting exit 0 for "nothing was deployed". Never runs
// against ~/.claude/pickle-rick — every case below builds its own --prefix
// sandbox with a fake $HOME under os.tmpdir().

const SRC_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'extension', 'package.json'), 'utf8'),
).version;
const NEWER_DEPLOYED_VERSION = '9.9.9';

function makeDowngradeFixture(testId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `install-real-downgrade-${testId}-`));
  const fixtureHome = path.join(dir, 'home');
  fs.mkdirSync(path.join(fixtureHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(fixtureHome, '.claude', 'settings.json'), '{}');

  const prefix = path.join(dir, 'prefix');
  const deployedExtDir = path.join(prefix, 'extension');
  fs.mkdirSync(deployedExtDir, { recursive: true });
  fs.writeFileSync(
    path.join(deployedExtDir, 'package.json'),
    JSON.stringify({ name: 'pickle-rick-extension', version: NEWER_DEPLOYED_VERSION }, null, 2),
  );

  return { dir, fixtureHome, prefix };
}

function readDeployedVersion(prefix) {
  const pkgPath = path.join(prefix, 'extension', 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
}

function runDowngradeInstall(fixture, extraArgs, stdinInput) {
  return spawnSync(
    'bash',
    [INSTALL_SH, '--allow-downgrade', '--prefix', fixture.prefix, ...extraArgs],
    {
      encoding: 'utf8',
      input: stdinInput,
      env: {
        ...process.env,
        HOME: fixture.fixtureHome,
        PICKLE_INSTALL_ROOT: fixture.prefix,
        PICKLE_DATA_ROOT: path.join(fixture.fixtureHome, '.local', 'share', 'pickle-rick'),
      },
      timeout: 120_000,
    },
  );
}

test('install-script-real.downgrade-declined-closed-stdin: closed stdin exits non-zero and deploys nothing', () => {
  const fixture = makeDowngradeFixture('closed-stdin');
  try {
    const result = runDowngradeInstall(fixture, [], '');

    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}\nstderr: ${result.stderr}`);
    assert.equal(
      readDeployedVersion(fixture.prefix),
      NEWER_DEPLOYED_VERSION,
      'declined downgrade must not touch the deployed package.json',
    );
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('install-script-real.downgrade-no-confirm: --no-confirm still exits 0 and actually deploys', () => {
  const fixture = makeDowngradeFixture('no-confirm');
  try {
    const result = runDowngradeInstall(fixture, ['--no-confirm']);

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
    assert.equal(
      readDeployedVersion(fixture.prefix),
      SRC_VERSION,
      '--no-confirm downgrade must actually deploy the source version, not merely exit 0',
    );
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('install-script-real.downgrade-interactive-decline: typed "n" exits non-zero and deploys nothing', () => {
  const fixture = makeDowngradeFixture('interactive-n');
  try {
    const result = runDowngradeInstall(fixture, [], 'n\n');

    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /REFUSE: downgrade declined/);
    assert.equal(
      readDeployedVersion(fixture.prefix),
      NEWER_DEPLOYED_VERSION,
      'declined downgrade must not touch the deployed package.json',
    );
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('install-script-real.downgrade-interactive-accept: typed "y" exits 0 and actually deploys', () => {
  const fixture = makeDowngradeFixture('interactive-y');
  try {
    const result = runDowngradeInstall(fixture, [], 'y\n');

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}\nstderr: ${result.stderr}`);
    assert.equal(
      readDeployedVersion(fixture.prefix),
      SRC_VERSION,
      'accepted downgrade must actually deploy the source version',
    );
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
