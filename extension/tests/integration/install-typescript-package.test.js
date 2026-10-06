// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

test('install-typescript-package: pipeline-runner module-load smoke exits 0 (R-DTS-3)', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-dts3-'));
  const prefix = path.join(homeDir, '.claude', 'pickle-rick');

  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'settings.json'), '{}');

  try {
    const install = spawnSync('bash', [INSTALL_SH, '--prefix', prefix, '--no-confirm'], {
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: homeDir,
        PICKLE_INSTALL_ROOT: prefix,
        PICKLE_DATA_ROOT: path.join(homeDir, '.local', 'share', 'pickle-rick'),
      },
    });
    assert.equal(install.status, 0, `install.sh failed (exit ${install.status}):\n${install.stderr}`);

    const script = `require(process.env.HOME + '/.claude/pickle-rick/extension/bin/pipeline-runner.js')`;
    const probe = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: homeDir },
    });

    assert.equal(
      probe.status,
      0,
      `pipeline-runner module-load exited ${probe.status}:\nstdout: ${probe.stdout}\nstderr: ${probe.stderr}`,
    );
    assert.ok(
      !probe.stderr.includes('ERR_MODULE_NOT_FOUND'),
      `ERR_MODULE_NOT_FOUND in pipeline-runner module-load stderr:\n${probe.stderr}`,
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('codegraph per-mode deploy: real copied deps + probe exit 0 + idempotent (361e8bd9)', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-codegraph-'));
  const prefix = path.join(homeDir, '.claude', 'pickle-rick');

  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude', 'settings.json'), '{}');

  const env = {
    ...process.env,
    HOME: homeDir,
    PICKLE_INSTALL_ROOT: prefix,
    PICKLE_DATA_ROOT: path.join(homeDir, '.local', 'share', 'pickle-rick'),
  };

  // The operator host is git mode (REPO_ROOT/.git present), so install.sh copies the
  // source's production closure into the deploy root. Detect mode so the copy-shape
  // assertions stay host-agnostic; the scope dir + probe assertions are unconditional.
  const gitMode = fs.existsSync(path.join(REPO_ROOT, '.git'));

  // Source production closure as npm reports it: the FIRST line is the package root, and every
  // line under its node_modules/ is a package the deployed runtime must resolve inside the deploy root.
  const sourceClosure = () => {
    const ls = spawnSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
      cwd: path.join(REPO_ROOT, 'extension'),
      encoding: 'utf8',
      timeout: 60_000,
    });
    const [root, ...rest] = ls.stdout.split('\n').filter(Boolean);
    const underNodeModules = `${root}${path.sep}node_modules${path.sep}`;
    const packages = rest.filter((l) => l.startsWith(underNodeModules)).map((l) => l.slice(underNodeModules.length));
    return { root, packages };
  };

  const runInstall = () =>
    spawnSync('bash', [INSTALL_SH, '--prefix', prefix, '--no-confirm'], {
      encoding: 'utf8',
      timeout: 180_000,
      env,
    });

  const scopeDir = path.join(prefix, 'extension', 'node_modules', '@colbymchenry');
  const mainPkg = path.join(scopeDir, 'codegraph');

  const assertDeployed = (label) => {
    assert.ok(fs.existsSync(scopeDir), `${label}: scoped @colbymchenry dir must exist`);
    assert.ok(fs.existsSync(mainPkg), `${label}: @colbymchenry/codegraph must exist`);

    // Discover platform-binding entries via readdir (no shell glob over
    // node_modules/@colbymchenry/* — stays clear of the hook scanner).
    const entries = fs.readdirSync(scopeDir);
    const bindings = entries.filter((e) => /^codegraph-[^-]+-.+$/.test(e));

    if (gitMode) {
      assert.ok(
        !fs.lstatSync(mainPkg).isSymbolicLink() && fs.lstatSync(mainPkg).isDirectory(),
        `${label}: git-mode @colbymchenry/codegraph must be a real directory, not a symlink`,
      );
      assert.ok(
        bindings.length >= 1,
        `${label}: git mode must copy at least one codegraph-<plat>-<arch> binding (found: ${entries.join(', ')})`,
      );
      const binding = path.join(scopeDir, bindings[0]);
      assert.ok(
        !fs.lstatSync(binding).isSymbolicLink() && fs.lstatSync(binding).isDirectory(),
        `${label}: git-mode platform binding ${bindings[0]} must be a real directory, not a symlink`,
      );

      const { root, packages } = sourceClosure();
      assert.ok(packages.includes('typescript'), `${label}: source closure must include typescript (got: ${packages.join(', ')})`);
      const realPrefix = fs.realpathSync(prefix);
      const requireFromRunner = createRequire(path.join(prefix, 'extension', 'bin', 'pipeline-runner.js'));
      for (const pkg of packages) {
        const resolved = fs.realpathSync(requireFromRunner.resolve(`${pkg}/package.json`));
        assert.ok(
          resolved.startsWith(realPrefix + path.sep),
          `${label}: ${pkg} must resolve inside the deploy root ${realPrefix}, got ${resolved}`,
        );
      }

      // Unfiltered, the root line survives the `${_dep#"$_root"/}` strip whole, so its copy lands at
      // <deploy>/extension/<absolute source root> — check that exact path.
      const copiedRoot = path.join(prefix, 'extension', root);
      assert.ok(
        !fs.existsSync(copiedRoot),
        `${label}: the npm ls root line must not be copied (found ${copiedRoot})`,
      );
    }

    // Probe resolution from the deployed extension root (both modes).
    const probe = spawnSync(
      process.execPath,
      ['-e', "import('@colbymchenry/codegraph').then(()=>process.exit(0),()=>process.exit(1))"],
      { encoding: 'utf8', timeout: 30_000, cwd: path.join(prefix, 'extension'), env },
    );
    assert.equal(
      probe.status,
      0,
      `${label}: codegraph probe must exit 0 from deployed extension root:\nstdout: ${probe.stdout}\nstderr: ${probe.stderr}`,
    );
  };

  try {
    const first = runInstall();
    assert.equal(first.status, 0, `first install.sh failed (exit ${first.status}):\n${first.stderr}`);
    assert.match(first.stdout + first.stderr, /OK codegraph/, 'install.sh must print the codegraph self-probe OK line');
    assertDeployed('first run');

    // Second run must be idempotent: rsync --delete-excluded wipes node_modules,
    // the per-mode block recreates the scoped layout, probe still exits 0.
    const second = runInstall();
    assert.equal(second.status, 0, `second install.sh failed (exit ${second.status}):\n${second.stderr}`);
    assertDeployed('second run (idempotent)');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
