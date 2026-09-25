// @tier: integration
// Integration-tiered (not fast): several tests mutate process.env.PATH directly
// to point `gh`/subprocess resolution at on-disk stubs. Under the fast tier's
// 8-way concurrency a sibling test clobbers PATH mid-call (process-global-state
// race, R-TSPF), the real `gh` resolves, and its network call hangs to the 15s
// timeout. This file is in tests/integration/.serial-tests.json so it runs
// serialized — no concurrent PATH mutation.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    parseVersion,
    compareSemver,
    readCache,
    writeCache,
    readSettings,
    isCacheStale,
    checkForUpdate,
    getLatestRelease,
    downloadRelease,
    extractAndInstall,
    performUpgrade,
    BlockedDowngradeError,
} from '../bin/check-update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOP_HOOK = path.resolve(__dirname, '../hooks/handlers/stop-hook.js');
const CHECK_UPDATE = path.resolve(__dirname, '../bin/check-update.js');

function makeTmpDir() {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-update-test-')));
    fs.mkdirSync(path.join(tmpDir, 'extension', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'extension', 'bin', 'log-watcher.js'), '');
    return tmpDir;
}

function makeGhFixture(scriptBody) {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-update-gh-'));
    const ghPath = path.join(binDir, 'gh');
    fs.writeFileSync(ghPath, `#!/usr/bin/env bash
set -eu
${scriptBody}
`, { mode: 0o755 });
    return binDir;
}

// ---------------------------------------------------------------------------
// parseVersion
// ---------------------------------------------------------------------------

describe('parseVersion', () => {
    test('strips v prefix', () => {
        assert.equal(parseVersion('v1.2.3'), '1.2.3');
    });

    test('accepts bare semver', () => {
        assert.equal(parseVersion('1.2.3'), '1.2.3');
    });

    test('rejects non-semver', () => {
        assert.equal(parseVersion('1.2'), null);
        assert.equal(parseVersion('abc'), null);
        assert.equal(parseVersion('v1.2.3-beta'), null);
    });

    test('rejects empty/null-ish', () => {
        assert.equal(parseVersion(''), null);
    });
});

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
    test('equal versions', () => {
        assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
    });

    test('a < b (patch)', () => {
        assert.equal(compareSemver('1.2.3', '1.2.4'), -1);
    });

    test('a > b (minor)', () => {
        assert.equal(compareSemver('1.3.0', '1.2.9'), 1);
    });

    test('a < b (major)', () => {
        assert.equal(compareSemver('1.9.9', '2.0.0'), -1);
    });

    test('multi-digit versions', () => {
        assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
    });

    test('normalizes v-prefixed versions before comparing', () => {
        assert.equal(compareSemver('v1.2.3', '1.2.4'), -1);
        assert.equal(compareSemver('1.10.0', 'v1.9.0'), 1);
    });

    test('rejects invalid versions instead of treating NaN parts as equal', () => {
        assert.throws(() => compareSemver('bad.2.3', '1.2.3'), /Invalid semver comparison/);
    });
});

// ---------------------------------------------------------------------------
// readCache / writeCache
// ---------------------------------------------------------------------------

describe('readCache', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns defaults when file missing', () => {
        const cache = readCache();
        assert.equal(cache.last_check_epoch, 0);
        assert.equal(cache.latest_version, '');
        assert.equal(cache.current_version, '');
    });

    test('returns defaults when file corrupted', () => {
        fs.writeFileSync(path.join(tmpDir, 'update-check.json'), '{broken');
        const cache = readCache();
        assert.equal(cache.last_check_epoch, 0);
    });

    test('round-trips correctly', () => {
        const data = { last_check_epoch: 1000, latest_version: '2.0.0', current_version: '1.0.0' };
        writeCache(data);
        const result = readCache();
        assert.deepEqual(result, data);
    });

    test('normalizes v-prefixed cache versions before update comparison', () => {
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
        fs.writeFileSync(path.join(tmpDir, 'update-check.json'), JSON.stringify({
            last_check_epoch: Math.floor(Date.now() / 1000),
            latest_version: 'v2.0.0',
            current_version: 'v1.7.0',
        }));

        const result = checkForUpdate();
        assert.equal(result.status, 'update-available');
        assert.equal(result.currentVersion, '1.7.0');
        assert.equal(result.latestVersion, '2.0.0');
    });

    test('checkForUpdate ignores malformed fresh cached versions and fetches release', () => {
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
        fs.writeFileSync(path.join(tmpDir, 'update-check.json'), JSON.stringify({
            last_check_epoch: Math.floor(Date.now() / 1000),
            latest_version: 'not-a-version',
            current_version: '1.7.0',
        }));

        const binDir = path.join(tmpDir, 'mock-bin');
        const callsPath = path.join(tmpDir, 'gh-calls.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh\necho called >> ${JSON.stringify(callsPath)}\nif [ "$1" = "api" ]; then echo '{"tag_name":"v2.0.0","assets":[]}'; exit 0; fi\nexit 1\n`,
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = checkForUpdate();
            assert.equal(result.status, 'update-available');
            assert.equal(result.latestVersion, '2.0.0');
            assert.match(fs.readFileSync(callsPath, 'utf-8'), /^called/m);
        } finally {
            process.env.PATH = origPath;
        }
    });

    test('checkForUpdate uses recovered newer cache tmp instead of refetching release', () => {
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
        const cachePath = path.join(tmpDir, 'update-check.json');
        fs.writeFileSync(cachePath, JSON.stringify({
            last_check_epoch: 0,
            latest_version: '1.7.0',
            current_version: '1.7.0',
        }));
        const tmpPath = `${cachePath}.tmp.99999999`;
        const now = Math.floor(Date.now() / 1000);
        fs.writeFileSync(tmpPath, JSON.stringify({
            last_check_epoch: now,
            latest_version: '2.0.0',
            current_version: '1.7.0',
        }));
        const oldTime = new Date(Date.now() - 10_000);
        const newTime = new Date();
        fs.utimesSync(cachePath, oldTime, oldTime);
        fs.utimesSync(tmpPath, newTime, newTime);

        const binDir = path.join(tmpDir, 'mock-bin');
        const callsPath = path.join(tmpDir, 'gh-calls.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh\necho called >> ${JSON.stringify(callsPath)}\nexit 99\n`,
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = checkForUpdate();
            assert.equal(result.status, 'update-available');
            assert.equal(result.latestVersion, '2.0.0');
            assert.equal(fs.existsSync(callsPath), false, 'fresh recovered cache should skip gh api');
            assert.equal(fs.existsSync(tmpPath), false, 'recovered tmp should be promoted');
            assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf-8')).latest_version, '2.0.0');
        } finally {
            process.env.PATH = origPath;
        }
    });
});

// ---------------------------------------------------------------------------
// readSettings
// ---------------------------------------------------------------------------

describe('readSettings', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns defaults when file missing', () => {
        const settings = readSettings();
        assert.equal(settings.auto_update_enabled, true);
        assert.equal(settings.update_check_interval_hours, 24);
    });

    test('respects overrides', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false, update_check_interval_hours: 12 }),
        );
        const settings = readSettings();
        assert.equal(settings.auto_update_enabled, false);
        assert.equal(settings.update_check_interval_hours, 12);
    });

    test('returns defaults on corrupt file', () => {
        fs.writeFileSync(path.join(tmpDir, 'pickle_settings.json'), 'not json');
        const settings = readSettings();
        assert.equal(settings.auto_update_enabled, true);
        assert.equal(settings.update_check_interval_hours, 24);
    });

    test('checkForUpdate uses recovered newer settings tmp before auto-update decision', () => {
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
        const settingsPath = path.join(tmpDir, 'pickle_settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({ auto_update_enabled: true }));
        const tmpPath = `${settingsPath}.tmp.99999999`;
        fs.writeFileSync(tmpPath, JSON.stringify({
            auto_update_enabled: false,
            update_check_interval_hours: 12,
        }));
        const oldTime = new Date(Date.now() - 10_000);
        const newTime = new Date();
        fs.utimesSync(settingsPath, oldTime, oldTime);
        fs.utimesSync(tmpPath, newTime, newTime);

        const binDir = path.join(tmpDir, 'mock-bin');
        const callsPath = path.join(tmpDir, 'gh-calls.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh\necho called >> ${JSON.stringify(callsPath)}\nexit 99\n`,
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = checkForUpdate();
            assert.equal(result.status, 'up-to-date');
            assert.equal(result.currentVersion, '1.7.0');
            assert.equal(fs.existsSync(callsPath), false, 'recovered disabled settings should skip gh api');
            assert.equal(fs.existsSync(tmpPath), false, 'recovered settings tmp should be promoted');
            assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).auto_update_enabled, false);
        } finally {
            process.env.PATH = origPath;
        }
    });

    test('ignores invalid interval', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ update_check_interval_hours: -5 }),
        );
        const settings = readSettings();
        assert.equal(settings.update_check_interval_hours, 24);
    });

    test('checkForUpdate defaults non-finite interval so stale cache still fetches release', () => {
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            '{"update_check_interval_hours":1e309}',
        );
        writeCache({
            last_check_epoch: Math.floor(Date.now() / 1000) - 48 * 3600,
            latest_version: '1.7.0',
            current_version: '1.7.0',
        });

        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            '#!/bin/sh\nif [ "$1" = "api" ]; then echo \'{"tag_name":"v2.0.0","assets":[]}\'; exit 0; fi\nexit 1\n',
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = checkForUpdate();
            assert.equal(result.status, 'update-available');
            assert.equal(result.latestVersion, '2.0.0');
        } finally {
            process.env.PATH = origPath;
        }
    });
});

// ---------------------------------------------------------------------------
// isCacheStale
// ---------------------------------------------------------------------------

describe('isCacheStale', () => {
    test('zero epoch is stale', () => {
        assert.equal(isCacheStale({ last_check_epoch: 0, latest_version: '', current_version: '' }, 24), true);
    });

    test('old cache is stale', () => {
        const twoDaysAgo = Math.floor(Date.now() / 1000) - 48 * 3600;
        assert.equal(isCacheStale({ last_check_epoch: twoDaysAgo, latest_version: '', current_version: '' }, 24), true);
    });

    test('recent cache is fresh', () => {
        const fiveMinAgo = Math.floor(Date.now() / 1000) - 300;
        assert.equal(isCacheStale({ last_check_epoch: fiveMinAgo, latest_version: '', current_version: '' }, 24), false);
    });

    test('future-dated cache is stale', () => {
        const future = Math.floor(Date.now() / 1000) + 48 * 3600;
        assert.equal(isCacheStale({ last_check_epoch: future, latest_version: '', current_version: '' }, 24), true);
    });
});

// ---------------------------------------------------------------------------
// checkForUpdate (integration-ish, using EXTENSION_DIR override)
// ---------------------------------------------------------------------------

describe('checkForUpdate', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
        // Create a fake package.json so getCurrentVersion works
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns up-to-date when auto_update disabled', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false }),
        );
        const result = checkForUpdate();
        assert.equal(result.status, 'up-to-date');
        assert.equal(result.currentVersion, '1.7.0');
    });

    test('uses cached result when fresh', () => {
        const now = Math.floor(Date.now() / 1000);
        writeCache({ last_check_epoch: now, latest_version: '2.0.0', current_version: '1.7.0' });
        const result = checkForUpdate();
        assert.equal(result.status, 'update-available');
        assert.equal(result.latestVersion, '2.0.0');
    });

    test('uses cached result showing up-to-date', () => {
        const now = Math.floor(Date.now() / 1000);
        writeCache({ last_check_epoch: now, latest_version: '1.7.0', current_version: '1.7.0' });
        const result = checkForUpdate();
        assert.equal(result.status, 'up-to-date');
    });

    test('future-dated cache does not suppress release discovery', () => {
        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            '#!/bin/sh\nif [ "$1" = "api" ]; then echo \'{"tag_name":"v2.0.0","assets":[]}\'; exit 0; fi\nexit 1\n',
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        // binDir ONLY (not prepended to origPath): getLatestRelease's
        // `spawnSync('gh', ..., {timeout: 15_000})` must resolve to the stub.
        // With origPath present, a fixture/PATH race under --test-concurrency=8
        // could resolve the real `gh`, whose network call hangs to the 15s
        // timeout and returns 'error'. binDir-only makes the real gh
        // unreachable: stub hit → fast pass, stub missing → fast ENOENT.
        process.env.PATH = binDir;
        try {
            const future = Math.floor(Date.now() / 1000) + 48 * 3600;
            writeCache({ last_check_epoch: future, latest_version: '1.7.0', current_version: '1.7.0' });
            const result = checkForUpdate();
            assert.equal(result.status, 'update-available');
            assert.equal(result.latestVersion, '2.0.0');
        } finally {
            process.env.PATH = origPath;
        }
    });

    test('force bypasses disabled setting', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false }),
        );
        // Force will try to call gh api which may fail, but should not crash
        const result = checkForUpdate({ force: true });
        // Either error (no gh/no network) or a valid result — never throws
        assert.ok(['up-to-date', 'update-available', 'error'].includes(result.status));
    });

    test('returns error status on API failure, never throws', () => {
        // Stale cache forces API call — may succeed or fail depending on env
        const result = checkForUpdate();
        assert.ok(['up-to-date', 'update-available', 'error'].includes(result.status));
        assert.ok(typeof result.currentVersion === 'string', 'currentVersion should be a string');
    });
});

// ---------------------------------------------------------------------------
// downloadRelease
// ---------------------------------------------------------------------------

describe('downloadRelease', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns null on invalid tag, never throws', () => {
        const result = downloadRelease('v999.999.999-nonexistent');
        assert.equal(result, null);
    });

    test('refuses an empty or whitespace-only tag without spawning gh', () => {
        // gh treats an empty tag as "latest" — a refusing, recording stub proves no call is made.
        const ghDir = makeGhFixture('echo "$*" >> "$(dirname "$0")/calls"\nexit 1');
        const callsFile = path.join(ghDir, 'calls');
        const origPath = process.env.PATH;
        try {
            process.env.PATH = `${ghDir}:${origPath}`;
            assert.equal(downloadRelease(''), null);
            assert.equal(downloadRelease('  '), null);
            const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf-8') : '';
            assert.equal(calls, '', `gh must not be invoked; recorded: ${calls}`);
        } finally {
            process.env.PATH = origPath;
            fs.rmSync(ghDir, { recursive: true, force: true });
        }
    });

    test('requests release tar.gz assets via glob pattern instead of the source archive flag', () => {
        const tarRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-update-tar-'));
        const releaseRoot = path.join(tarRoot, 'pickle-rick-claude');
        const tarball = path.join(tarRoot, 'release.tar.gz');
        const ghDir = makeGhFixture(`
if [ "$1" = "release" ] && [ "$2" = "download" ]; then
  download_args=" $* "
  case "$download_args" in
    *" -p *.tar.gz "*|*" --pattern *.tar.gz "*) ;;
    *) exit 98 ;;
  esac
  case "$download_args" in
    *" -A tar.gz "*|*" --archive tar.gz "*) exit 99 ;;
  esac
  dest=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-D" ]; then
      shift
      dest="$1"
      break
    fi
    shift
  done
  cp ${JSON.stringify(tarball)} "$dest/$(basename ${JSON.stringify(tarball)})"
  exit 0
fi
exit 1
`);
        const origPath = process.env.PATH;
        try {
            fs.mkdirSync(path.join(releaseRoot, 'extension'), { recursive: true });
            fs.writeFileSync(path.join(releaseRoot, 'extension', 'package.json'), `${JSON.stringify({ version: '1.2.3' }, null, 2)}\n`);
            fs.writeFileSync(path.join(releaseRoot, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
            execFileSync('tar', ['-czf', tarball, '-C', tarRoot, 'pickle-rick-claude']);

            process.env.PATH = `${ghDir}:${origPath}`;
            const result = downloadRelease('v1.2.3');
            assert.equal(result?.endsWith('.tar.gz'), true);
        } finally {
            process.env.PATH = origPath;
            fs.rmSync(tarRoot, { recursive: true, force: true });
            fs.rmSync(ghDir, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// extractAndInstall
// ---------------------------------------------------------------------------

describe('extractAndInstall', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns error for nonexistent tarball', () => {
        const result = extractAndInstall('/tmp/nonexistent-pickle-fakefile.tar.gz');
        assert.equal(result.success, false);
        assert.ok(result.error);
    });

    test('returns error for invalid tarball', () => {
        const fakeTarball = path.join(tmpDir, 'fake.tar.gz');
        fs.writeFileSync(fakeTarball, 'not a real tarball');
        const result = extractAndInstall(fakeTarball);
        assert.equal(result.success, false);
    });
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER94-01 — the installer spawn's cap is a RUNAWAY BACKSTOP, not a schedule
//
// `runReleaseInstallScript` caps `bash install.sh` with spawnSync's `timeout`. The upgrade
// payload carries no `.git`, so the installer takes its TARBALL branch, whose mandatory step
// is a NETWORKED `npm install` of @colbymchenry/codegraph (the 0.9.x era) at the deploy root — 46 MB
// fetched, 181 MB unpacked, on EVERY upgrade, because the rsync above it runs
// `--delete-excluded` and rebuilds `node_modules` each run. At the former 30s that needed
// >12 Mbps sustained before a single local step ran.
//
// The cap firing is not a clean abort. It lands MID-DEPLOY, after the rsync has already
// published the new JS and the new `extension/package.json`: `getCurrentVersion()` then
// reports the NEW version, `checkForUpdate` reads up-to-date and never retries, and every
// step after the npm install — the codegraph self-probe, MANAGED_KEYS, the commands rsync,
// all three hook registrations — never ran. The half-deploy is permanent and silent.
//
// The behavioural case below is the falsifying control: its payload installer sleeps past
// the former cap. Restore `timeout: 30_000` and it reds with `install.sh failed (exit null)`,
// spawnSync's signature for a timeout kill, while the two sibling cases stay green.
// ---------------------------------------------------------------------------

describe('AP-EXT-ITER94-01: install.sh spawn cap', () => {
    let root;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-install-cap-')));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    /** A real installable payload (`extension/package.json` + `install.sh` sharing one root). */
    function stageTarball(installScriptBody) {
        const stage = fs.mkdtempSync(path.join(root, 'stage-'));
        fs.mkdirSync(path.join(stage, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(stage, 'extension', 'package.json'),
            JSON.stringify({ version: '99.0.0' }),
        );
        fs.writeFileSync(path.join(stage, 'install.sh'), installScriptBody);
        const tarball = path.join(fs.mkdtempSync(path.join(root, 'tarball-')), 'release.tar.gz');
        execFileSync('tar', ['czf', tarball, '-C', stage, 'extension', 'install.sh'], {
            encoding: 'utf-8',
            timeout: 30_000,
        });
        return tarball;
    }

    // ~32s by construction: the sleep must outlast the former 30s cap for the case to
    // discriminate at all. `extractAndInstall` deletes the extract dir in its `finally`, so
    // the installer's completion marker is written OUTSIDE it — the marker is the evidence
    // the script ran to its END rather than being killed part-way.
    test('AP-EXT-ITER94-01: an installer that outlasts the former 30s cap runs to completion', () => {
        const marker = path.join(root, 'installer-finished');
        const tarball = stageTarball(
            `#!/bin/bash\nsleep 31\necho done > ${JSON.stringify(marker)}\nexit 0\n`,
        );

        const result = extractAndInstall(tarball);

        assert.equal(
            result.success,
            true,
            `the cap must not kill a legitimate install (got: ${JSON.stringify(result)})`,
        );
        assert.equal(
            fs.existsSync(marker),
            true,
            'the installer must reach its final line — a mid-flight kill leaves a half-deploy',
        );
    });

    // Control: the cap must not have been widened into "ignore the installer's verdict".
    // A real non-zero exit still fails the upgrade, and reports its EXIT CODE — which is also
    // what distinguishes a genuine failure from a timeout kill, where spawnSync sets `null`.
    test('AP-EXT-ITER94-01 control: a failing installer still fails the upgrade, with its real exit code', () => {
        const tarball = stageTarball('#!/bin/bash\nexit 3\n');

        const result = extractAndInstall(tarball);

        assert.equal(result.success, false);
        assert.match(result.error, /install\.sh failed \(exit 3\)/);
    });

    // Lockstep, so the two callers of `bash install.sh` in this repo cannot re-diverge: the
    // PRODUCTION self-upgrade must not give the installer less time than the repo's own
    // harness for the same script. That harness cap is the only in-repo record of a measured
    // install.sh runtime (fde629a7 raised it 120s -> 600s after ~95s was measured on the
    // operator host and 120s was observed failing twice). Both reads are fail-closed.
    test('AP-EXT-ITER94-01 lockstep: the shipped cap is not below the harness cap for the same script', () => {
        const shipped = fs.readFileSync(CHECK_UPDATE, 'utf8');
        const shippedMatch = /const INSTALL_SCRIPT_TIMEOUT_MS = ([0-9_]+);/.exec(shipped);
        assert.ok(
            shippedMatch,
            'bin/check-update.js must declare INSTALL_SCRIPT_TIMEOUT_MS — the installer spawn '
                + 'cap may not be an inline literal, or this lockstep cannot see it',
        );
        const shippedMs = Number(shippedMatch[1].replace(/_/g, ''));

        const soakPath = path.resolve(__dirname, 'integration', 'deploy-lifecycle-soak.test.js');
        const soak = fs.readFileSync(soakPath, 'utf8');
        const soakMatch = /spawnSync\('bash', \[INSTALL_SH[^)]*?timeout: ([0-9_]+)/s.exec(soak);
        assert.ok(
            soakMatch,
            `could not read the harness cap from ${soakPath} — the spawn shape changed, so this `
                + 'lockstep is unanchored; re-anchor it rather than deleting it',
        );
        const soakMs = Number(soakMatch[1].replace(/_/g, ''));

        assert.ok(
            shippedMs >= soakMs,
            `the production installer cap (${shippedMs}ms) is below the harness cap for the same `
                + `script (${soakMs}ms). A cap is a runaway backstop, not a scheduler `
                + '(prds/MASTER_PLAN.md operating principle 1a); firing it lands mid-deploy.',
        );
    });
});

// ---------------------------------------------------------------------------
// performUpgrade
// ---------------------------------------------------------------------------

describe('performUpgrade', () => {
    let tmpDir;
    let origEnv;
    let origPath;
    let origDataRoot;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        origPath = process.env.PATH;
        origDataRoot = process.env.PICKLE_DATA_ROOT;
        process.env.EXTENSION_DIR = tmpDir;
        process.env.PICKLE_DATA_ROOT = path.join(tmpDir, 'data-root');
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        if (origDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = origDataRoot;
        process.env.PATH = origPath;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeDeployedPackage(version) {
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version }),
        );
    }

    function makeReleaseTarball(version) {
        const contentRoot = path.join(tmpDir, `release-${version}`);
        const packageRoot = path.join(contentRoot, 'pickle-rick-claude');
        fs.mkdirSync(path.join(packageRoot, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(packageRoot, 'extension', 'package.json'),
            JSON.stringify({ version }),
        );
        fs.writeFileSync(
            path.join(packageRoot, 'install.sh'),
            '#!/bin/sh\nprintf installed > "$EXTENSION_DIR/install-marker.txt"\n',
            { mode: 0o755 },
        );
        const tarball = path.join(tmpDir, `release-${version}.tar.gz`);
        execFileSync('tar', ['czf', tarball, '-C', contentRoot, 'pickle-rick-claude']);
        return tarball;
    }

    function makeSidecarTarball(name = 'aaa-sidecar.tar.gz', { includeInstallScript = false } = {}) {
        const contentRoot = path.join(tmpDir, name.replace(/[.]tar[.]gz$/, ''));
        const packageRoot = path.join(contentRoot, 'sidecar');
        fs.mkdirSync(path.join(packageRoot, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(packageRoot, 'extension', 'package.json'),
            JSON.stringify({ version: '1.67.0' }),
        );
        fs.writeFileSync(path.join(packageRoot, 'README.md'), '# sidecar');
        if (includeInstallScript) {
            fs.writeFileSync(path.join(packageRoot, 'install.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        }
        const tarball = path.join(tmpDir, name);
        execFileSync('tar', ['czf', tarball, '-C', contentRoot, 'sidecar']);
        return tarball;
    }

    function makeSplitRootTarball(name = 'split-root.tar.gz') {
        const contentRoot = path.join(tmpDir, name.replace(/[.]tar[.]gz$/, ''));
        const packageRoot = path.join(contentRoot, 'payload-a');
        const installRoot = path.join(contentRoot, 'payload-b');
        fs.mkdirSync(path.join(packageRoot, 'extension'), { recursive: true });
        fs.mkdirSync(installRoot, { recursive: true });
        fs.writeFileSync(
            path.join(packageRoot, 'extension', 'package.json'),
            JSON.stringify({ version: '1.67.0' }),
        );
        fs.writeFileSync(path.join(installRoot, 'install.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const tarball = path.join(tmpDir, name);
        execFileSync('tar', ['czf', tarball, '-C', contentRoot, 'payload-a', 'payload-b']);
        return tarball;
    }

    function makeMultiPayloadRootTarball(name = 'multi-root.tar.gz') {
        const contentRoot = path.join(tmpDir, name.replace(/[.]tar[.]gz$/, ''));
        const firstRoot = path.join(contentRoot, 'payload-a');
        const secondRoot = path.join(contentRoot, 'payload-b');
        for (const root of [firstRoot, secondRoot]) {
            fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
            fs.writeFileSync(
                path.join(root, 'extension', 'package.json'),
                JSON.stringify({ version: '1.67.0' }),
            );
            fs.writeFileSync(path.join(root, 'install.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        }
        const tarball = path.join(tmpDir, name);
        execFileSync('tar', ['czf', tarball, '-C', contentRoot, 'payload-a', 'payload-b']);
        return tarball;
    }

    function mockDownloadRelease(tarball) {
        return mockDownloadReleases([tarball]);
    }

    function mockDownloadReleases(tarballs) {
        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh
dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-D" ]; then
    shift
    dest="$1"
  fi
  shift
done
mkdir -p "$dest"
${tarballs.map((tarball) => `cp ${JSON.stringify(tarball)} "$dest/$(basename ${JSON.stringify(tarball)})"`).join('\n')}
`,
            { mode: 0o755 },
        );
        process.env.PATH = `${binDir}:${process.env.PATH}`;
    }

    test('fails gracefully when download fails', () => {
        const result = performUpgrade('1.0.0', '999.0.0', 'v999.0.0');
        assert.equal(result.success, false);
        assert.ok(result.error);
    });

    test('rejects downloaded tarballs whose package and install script live under different roots', () => {
        const tarball = makeSplitRootTarball();
        mockDownloadRelease(tarball);

        const result = downloadRelease('v1.67.0');
        assert.equal(result, null);
    });

    test('rejects downloaded tarballs with multiple installable payload roots', () => {
        const tarball = makeMultiPayloadRootTarball();
        mockDownloadRelease(tarball);

        const result = downloadRelease('v1.67.0');
        assert.equal(result, null);
    });

    test('never throws', () => {
        assert.doesNotThrow(() => {
            performUpgrade('1.0.0', '999.0.0', 'v999.0.0');
        });
    });

    test('refuses upgrade when auto_update_enabled=false and does not download', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false }),
        );
        // Mock gh that records every call — we expect zero calls.
        const binDir = path.join(tmpDir, 'mock-bin');
        const callsPath = path.join(tmpDir, 'gh-calls.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh\necho called >> ${JSON.stringify(callsPath)}\nexit 0\n`,
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = performUpgrade('1.0.0', '2.0.0', 'v2.0.0');
            assert.equal(result.success, false);
            assert.match(result.error, /disabled/i);
            assert.equal(fs.existsSync(callsPath), false, 'must not invoke gh when kill-switch is on');
        } finally {
            process.env.PATH = origPath;
        }
    });

    test('proceeds past kill-switch when auto_update_enabled=true (download mocked)', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: true }),
        );
        // Mock gh release download to fail cleanly so we don't hit the network.
        // The kill-switch must NOT short-circuit this — failure must come from download path.
        const binDir = path.join(tmpDir, 'mock-bin');
        const callsPath = path.join(tmpDir, 'gh-calls.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh\necho called >> ${JSON.stringify(callsPath)}\nexit 1\n`,
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = performUpgrade('1.0.0', '2.0.0', 'v2.0.0');
            assert.equal(result.success, false);
            // Must be the download error, not the kill-switch error.
            assert.match(result.error, /download/i);
            assert.ok(fs.existsSync(callsPath), 'gh must be invoked when kill-switch is off');
        } finally {
            process.env.PATH = origPath;
        }
    });

    test('force option overrides kill-switch and proceeds to download', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ auto_update_enabled: false }),
        );
        const binDir = path.join(tmpDir, 'mock-bin');
        const callsPath = path.join(tmpDir, 'gh-calls.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(
            path.join(binDir, 'gh'),
            `#!/bin/sh\necho called >> ${JSON.stringify(callsPath)}\nexit 1\n`,
            { mode: 0o755 },
        );
        const origPath = process.env.PATH;
        process.env.PATH = `${binDir}:${origPath}`;
        try {
            const result = performUpgrade('1.0.0', '2.0.0', 'v2.0.0', { force: true });
            assert.equal(result.success, false);
            // Failure must be from download path, not kill-switch.
            assert.match(result.error, /download/i);
            assert.ok(fs.existsSync(callsPath), '--force must bypass kill-switch and call gh');
        } finally {
            process.env.PATH = origPath;
        }
    });

    test('check-update.refuses-downgrade', () => {
        writeDeployedPackage('1.67.0');
        mockDownloadRelease(makeReleaseTarball('1.64.0'));

        assert.throws(
            () => performUpgrade('1.67.0', '1.66.0', 'v1.66.0'),
            (error) => {
                assert.ok(error instanceof BlockedDowngradeError);
                assert.equal(error.candidate, '1.64.0');
                assert.equal(error.current, '1.67.0');
                return true;
            },
        );

        assert.equal(fs.existsSync(path.join(tmpDir, 'install-marker.txt')), false);
    });

    test('check-update.allowDowngrade-bypass', () => {
        writeDeployedPackage('1.67.0');
        mockDownloadRelease(makeReleaseTarball('1.64.0'));

        const result = performUpgrade('1.67.0', '1.66.0', 'v1.66.0', { allowDowngrade: true, noConfirm: true });

        assert.equal(result.success, true);
        assert.equal(fs.readFileSync(path.join(tmpDir, 'install-marker.txt'), 'utf-8'), 'installed');
    });

    test('check-update.force-does-not-bypass', () => {
        writeDeployedPackage('1.67.0');
        mockDownloadRelease(makeReleaseTarball('1.64.0'));

        assert.throws(
            () => performUpgrade('1.67.0', '1.66.0', 'v1.66.0', { force: true }),
            (error) => {
                assert.ok(error instanceof BlockedDowngradeError);
                assert.equal(error.candidate, '1.64.0');
                assert.equal(error.current, '1.67.0');
                return true;
            },
        );

        assert.equal(fs.existsSync(path.join(tmpDir, 'install-marker.txt')), false);
    });

    test('downgrade active-session guard promotes recoverable session state tmp before refusing', () => {
        writeDeployedPackage('1.67.0');
        mockDownloadRelease(makeReleaseTarball('1.64.0'));

        const sessionDir = path.join(process.env.PICKLE_DATA_ROOT, 'sessions', 'active-abc123');
        fs.mkdirSync(sessionDir, { recursive: true });
        const statePath = path.join(sessionDir, 'state.json');
        const tmpStatePath = `${statePath}.tmp.999999`;
        fs.writeFileSync(statePath, JSON.stringify({
            active: false,
            session_id: 'active-abc123',
        }));
        fs.writeFileSync(tmpStatePath, JSON.stringify({
            active: true,
            session_id: 'active-abc123',
        }));
        const stale = new Date('2026-05-19T10:00:00.000Z');
        const newer = new Date('2026-05-19T10:00:01.000Z');
        fs.utimesSync(statePath, stale, stale);
        fs.utimesSync(tmpStatePath, newer, newer);

        const result = performUpgrade('1.67.0', '1.66.0', 'v1.66.0', { allowDowngrade: true, noConfirm: true });

        assert.equal(result.success, false);
        assert.equal(result.exitCode, 2);
        assert.match(result.error ?? '', /active session active-abc123/);
        assert.equal(fs.existsSync(path.join(tmpDir, 'install-marker.txt')), false);
        assert.equal(fs.existsSync(tmpStatePath), false);
        assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf-8')).active, true);
    });

    test('check-update.ignores-sidecar-tarballs-and-installs-the-unique-installable-release', () => {
        writeDeployedPackage('1.66.0');
        const installableTarball = makeReleaseTarball('1.67.0');
        const sidecarTarball = makeSidecarTarball('aaa-sidecar.tar.gz');
        mockDownloadReleases([sidecarTarball, installableTarball]);

        const result = performUpgrade('1.66.0', '1.67.0', 'v1.67.0', { noConfirm: true });

        assert.equal(result.success, true, result.error);
        assert.equal(fs.readFileSync(path.join(tmpDir, 'install-marker.txt'), 'utf-8'), 'installed');
    });
});

// ---------------------------------------------------------------------------
// getLatestRelease
// ---------------------------------------------------------------------------

describe('getLatestRelease', () => {
    test('returns null or valid ReleaseInfo, never throws', () => {
        const result = getLatestRelease();
        if (result !== null) {
            assert.ok(typeof result.tagName === 'string');
            assert.ok(Array.isArray(result.assets));
        }
    });
});

// ---------------------------------------------------------------------------
// Logging — debug.log gets [check-update] prefixed lines
// ---------------------------------------------------------------------------

describe('logging', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('writeCache produces [check-update] log entry in debug.log', () => {
        writeCache({ last_check_epoch: 1000, latest_version: '2.0.0', current_version: '1.0.0' });
        const logFile = path.join(tmpDir, 'debug.log');
        assert.ok(fs.existsSync(logFile), 'debug.log should exist');
        const content = fs.readFileSync(logFile, 'utf-8');
        assert.ok(content.includes('[check-update]'), 'debug.log should contain [check-update] prefix');
        assert.ok(content.includes('Cache written'), 'debug.log should mention cache write');
    });

    test('readCache on missing file produces log entry', () => {
        readCache();
        const logFile = path.join(tmpDir, 'debug.log');
        assert.ok(fs.existsSync(logFile), 'debug.log should exist');
        const content = fs.readFileSync(logFile, 'utf-8');
        assert.ok(content.includes('[check-update]'));
        assert.ok(content.includes('Cache missing or corrupted'));
    });

    test('log entries include ISO timestamp', () => {
        writeCache({ last_check_epoch: 1, latest_version: '1.0.0', current_version: '1.0.0' });
        const content = fs.readFileSync(path.join(tmpDir, 'debug.log'), 'utf-8');
        assert.match(content, /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
});

// ---------------------------------------------------------------------------
// Detached spawn — stop-hook spawns check-update.js with detached: true
// ---------------------------------------------------------------------------

describe('detached spawn (stop-hook)', () => {
    function makeMaxIterState(overrides = {}) {
        return {
            active: true,
            working_dir: process.cwd(),
            step: 'implement',
            iteration: 3,
            max_iterations: 3,
            max_time_minutes: 60,
            worker_timeout_seconds: 1200,
            start_time_epoch: Math.floor(Date.now() / 1000) - 30,
            completion_promise: null,
            original_prompt: 'test',
            current_ticket: null,
            history: [],
            started_at: new Date().toISOString(),
            session_dir: '/tmp/test',
            tmux_mode: false,
            ...overrides,
        };
    }

    function runStopHook(opts = {}) {
        const { state = makeMaxIterState(), response = 'short', createCheckUpdate = true, extraFiles = {} } = opts;
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-test-'));
        const sessionDir = path.join(tmpDir, 'session');
        fs.mkdirSync(sessionDir);
        const stateFile = path.join(sessionDir, 'state.json');
        fs.writeFileSync(stateFile, JSON.stringify(state));
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [process.cwd()]: sessionDir }),
        );
        if (createCheckUpdate) {
            fs.mkdirSync(path.join(tmpDir, 'extension', 'bin'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'extension', 'bin', 'check-update.js'), '// noop');
        }
        for (const [relPath, content] of Object.entries(extraFiles)) {
            const full = path.join(tmpDir, relPath);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
        }

        const env = {
            ...process.env,
            EXTENSION_DIR: tmpDir,
            FORCE_COLOR: '0',
            NODE_ENV: 'test',
            EXTENSION_DIR_TEST: '1',
        };
        delete env.PICKLE_ROLE;
        delete env.PICKLE_STATE_FILE;
        env.PICKLE_STATE_FILE = stateFile;

        try {
            execFileSync(process.execPath, [STOP_HOOK], {
                input: JSON.stringify({ last_assistant_message: response }),
                encoding: 'utf-8',
                env,
            });
            const debugLog = path.join(tmpDir, 'debug.log');
            return fs.existsSync(debugLog) ? fs.readFileSync(debugLog, 'utf-8') : '';
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    test('spawns detached check-update on task completion', () => {
        const log = runStopHook({
            state: makeMaxIterState({ iteration: 1, max_iterations: 100 }),
            response: 'All done! <promise>TASK_COMPLETED</promise>',
        });
        assert.ok(log.includes('Spawning detached check-update process'),
            'stop-hook should log detached spawn on task completion');
    });

    test('does NOT spawn on max iterations (only on completion)', () => {
        const log = runStopHook({
            response: 'Some work output that is long enough to not be degenerate response detection threshold',
        });
        assert.ok(!log.includes('Spawning detached'),
            'stop-hook should NOT spawn update check on max iterations');
    });

    test('skips spawn when check-update.js is missing', () => {
        const log = runStopHook({
            state: makeMaxIterState({ iteration: 1, max_iterations: 100 }),
            response: 'All done! <promise>TASK_COMPLETED</promise>',
            createCheckUpdate: false,
        });
        assert.ok(log.includes('check-update.js not found'),
            'should log that check-update.js was not found');
        assert.ok(!log.includes('Spawning detached'),
            'should NOT spawn when file missing');
    });

    test('skips spawn when auto_update disabled', () => {
        const log = runStopHook({
            state: makeMaxIterState({ iteration: 1, max_iterations: 100 }),
            response: 'All done! <promise>TASK_COMPLETED</promise>',
            extraFiles: { 'pickle_settings.json': JSON.stringify({ auto_update_enabled: false }) },
        });
        assert.ok(log.includes('Auto-update disabled'),
            'should log auto-update disabled');
        assert.ok(!log.includes('Spawning detached'),
            'should NOT spawn when auto-update disabled');
    });
});

// ---------------------------------------------------------------------------
// Integration — end-to-end with mock gh
// ---------------------------------------------------------------------------

describe('integration with mock gh', () => {
    let tmpDir;
    let origEnv;
    let origPath;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        origPath = process.env.PATH;
        process.env.EXTENSION_DIR = tmpDir;
        fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'extension', 'package.json'),
            JSON.stringify({ version: '1.7.0' }),
        );
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        process.env.PATH = origPath;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeMockGh(responseJson) {
        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        const script = `#!/bin/sh\necho '${JSON.stringify(responseJson).replace(/'/g, "'\\''")}'`;
        fs.writeFileSync(path.join(binDir, 'gh'), script, { mode: 0o755 });
        process.env.PATH = `${binDir}:${origPath}`;
    }

    test('detects newer version from mock gh, updates cache', () => {
        writeMockGh({
            tag_name: 'v2.0.0',
            assets: [{ name: 'pickle-rick-claude-v2.0.0.tar.gz', url: 'https://example.com/fake.tar.gz' }],
        });
        const result = checkForUpdate({ force: true });
        // gh api returns valid JSON, so getLatestRelease succeeds
        // performUpgrade will fail at download step (mock gh doesn't do release download properly)
        // but cache should be updated with the new version
        assert.ok(['update-available', 'up-to-date'].includes(result.status));
        const cache = readCache();
        assert.equal(cache.latest_version, '2.0.0');
        assert.equal(cache.current_version, '1.7.0');
    });

    test('handles unexpected tag format from gh', () => {
        writeMockGh({
            tag_name: 'release-candidate-1',
            assets: [],
        });
        const result = checkForUpdate({ force: true });
        assert.equal(result.status, 'error');
        assert.ok(result.error.includes('Invalid release tag'));
    });

    test('handles gh returning invalid JSON', () => {
        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\necho "not json at all"', { mode: 0o755 });
        process.env.PATH = `${binDir}:${origPath}`;
        const result = checkForUpdate({ force: true });
        assert.equal(result.status, 'error');
    });

    test('handles gh returning non-zero exit code', () => {
        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1', { mode: 0o755 });
        process.env.PATH = `${binDir}:${origPath}`;
        const result = checkForUpdate({ force: true });
        assert.equal(result.status, 'error');
    });

    test('process exit code is always 0 when run as subprocess', () => {
        const binDir = path.join(tmpDir, 'mock-bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(binDir, 'gh'), '#!/bin/sh\nexit 1', { mode: 0o755 });

        const env = { ...process.env, EXTENSION_DIR: tmpDir, PATH: `${binDir}:${origPath}` };
        // Run check-update.js as subprocess — should always exit 0 (no --upgrade flag)
        const result = execFileSync(process.execPath, [CHECK_UPDATE], {
            encoding: 'utf-8',
            env,
        });
        const parsed = JSON.parse(result.trim());
        assert.ok(['up-to-date', 'update-available', 'error'].includes(parsed.status));
    });
});

// ---------------------------------------------------------------------------
// Edge cases — extractAndInstall with missing install.sh, tarball edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
    let tmpDir;
    let origEnv;

    beforeEach(() => {
        tmpDir = makeTmpDir();
        origEnv = process.env.EXTENSION_DIR;
        process.env.EXTENSION_DIR = tmpDir;
    });

    afterEach(() => {
        if (origEnv === undefined) delete process.env.EXTENSION_DIR;
        else process.env.EXTENSION_DIR = origEnv;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('extractAndInstall fails when tarball has no install.sh', () => {
        const contentDir = path.join(tmpDir, 'content');
        fs.mkdirSync(contentDir);
        fs.writeFileSync(path.join(contentDir, 'README.md'), '# No install script here');
        const tarball = path.join(tmpDir, 'test-release.tar.gz');
        execFileSync('tar', ['czf', tarball, '-C', tmpDir, 'content']);
        const result = extractAndInstall(tarball);
        assert.equal(result.success, false);
        assert.ok(result.error.includes('install.sh'));
    });

    test('extractAndInstall fails when tarball has multiple installable payload roots', () => {
        const contentDir = path.join(tmpDir, 'content');
        const firstRoot = path.join(contentDir, 'payload-a');
        const secondRoot = path.join(contentDir, 'payload-b');
        for (const root of [firstRoot, secondRoot]) {
            fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
            fs.writeFileSync(path.join(root, 'extension', 'package.json'), JSON.stringify({ version: '1.2.3' }));
            fs.writeFileSync(path.join(root, 'install.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        }
        const tarball = path.join(tmpDir, 'test-release.tar.gz');
        execFileSync('tar', ['czf', tarball, '-C', contentDir, 'payload-a', 'payload-b']);
        const result = extractAndInstall(tarball);
        assert.equal(result.success, false);
        assert.match(result.error, /exactly one payload root shared by extension\/package\.json and install\.sh/);
    });

    test('extractAndInstall fails when install.sh exits non-zero', () => {
        const contentDir = path.join(tmpDir, 'content');
        fs.mkdirSync(path.join(contentDir, 'extension'), { recursive: true });
        fs.writeFileSync(path.join(contentDir, 'extension', 'package.json'), JSON.stringify({ version: '1.2.3' }));
        fs.writeFileSync(path.join(contentDir, 'install.sh'), '#!/bin/sh\nexit 1', { mode: 0o755 });
        const tarball = path.join(tmpDir, 'test-release.tar.gz');
        execFileSync('tar', ['czf', tarball, '-C', tmpDir, 'content']);
        const result = extractAndInstall(tarball);
        assert.equal(result.success, false);
        assert.ok(result.error.includes('install.sh failed'));
    });

    test('compareSemver handles 0.0.0', () => {
        assert.equal(compareSemver('0.0.0', '0.0.1'), -1);
        assert.equal(compareSemver('0.0.0', '0.0.0'), 0);
    });

    test('parseVersion accepts well-formed pre-release suffixes, rejects malformed (R2 931c492f)', () => {
        // R2 (931c492f) made parseVersion tolerate X.Y.Z-<ident>.<N> prereleases so the
        // 2.0.0-beta.1 bump cannot throw at the four check-update caller sites.
        assert.equal(parseVersion('v1.0.0-rc.1'), '1.0.0-rc.1');
        assert.equal(parseVersion('2.0.0-beta.1'), '2.0.0-beta.1');
        // malformed prerelease (ident without a numeric component) is still rejected
        assert.equal(parseVersion('1.0.0-alpha'), null);
    });

    test('parseVersion rejects build metadata', () => {
        assert.equal(parseVersion('1.0.0+build.123'), null);
    });

    test('isCacheStale with exactly boundary epoch', () => {
        const exactBoundary = Math.floor(Date.now() / 1000) - 24 * 3600;
        assert.equal(
            isCacheStale({ last_check_epoch: exactBoundary, latest_version: '', current_version: '' }, 24),
            true,
        );
    });

    test('readSettings ignores zero interval (uses default)', () => {
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ update_check_interval_hours: 0 }),
        );
        const settings = readSettings();
        assert.equal(settings.update_check_interval_hours, 24);
    });

    test('writeCache handles non-writable dir gracefully', () => {
        // Point EXTENSION_DIR at a nonexistent nested dir — writeCache should not throw
        process.env.EXTENSION_DIR = path.join(tmpDir, 'no', 'such', 'deep', 'dir');
        assert.doesNotThrow(() => {
            writeCache({ last_check_epoch: 1, latest_version: '1.0.0', current_version: '1.0.0' });
        });
    });
});
