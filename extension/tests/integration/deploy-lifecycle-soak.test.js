// @tier: expensive
// BUG_REPRODUCES_AT: 1d181df15d53930e42b72ec8ee993d1e2aa594d4
// BUG_FIXED_AT: (ticket 82739e5b fix commit — populate after merge)
//
// Soak canary: monitors a deployed extension install for package.json version drift.
// Gated by RUN_EXPENSIVE_TESTS=1 and requires either CI=true or PICKLE_INSTALL_ROOT
// pointing to a non-$HOME path (safety guard against mutating live ~/.claude install).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = path.resolve(__dirname, '..', '..', '..', 'install.sh');

test('deploy-lifecycle soak: package.json version remains stable', { timeout: 2 * 3600 * 1000 }, async (t) => {
    if (!process.env.RUN_EXPENSIVE_TESTS) {
        t.skip('set RUN_EXPENSIVE_TESTS=1 to run soak canary');
        return;
    }

    const installRoot = process.env.PICKLE_INSTALL_ROOT ?? '';
    const isLocalRun = process.env.CI !== 'true';
    const isSafeRoot = installRoot.length > 0 && !installRoot.startsWith(os.homedir());

    if (isLocalRun && !isSafeRoot) {
        t.skip(
            'refuses to mutate $HOME settings.json — ' +
            'set PICKLE_INSTALL_ROOT to non-$HOME path or set CI=true',
        );
        return;
    }

    // Verify install.sh supports --prefix (ticket 09b89954); skip gracefully if not.
    const prefixSupported = (() => {
        const probe = spawnSync('bash', [INSTALL_SH, '--prefix', '/tmp/probe-noop', '--dry-run'], {
            encoding: 'utf-8',
            timeout: 5_000,
        });
        return probe.status === 0;
    })();

    if (!prefixSupported) {
        t.skip('install.sh does not support --prefix (requires ticket 09b89954); skipping soak');
        return;
    }

    const soakSeconds = (() => {
        const raw = Number(process.env.SOAK_SECONDS ?? 1800);
        if (!Number.isFinite(raw) || raw < 1800) {
            throw new Error('SOAK_SECONDS must be >= 1800');
        }
        return raw;
    })();

    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-soak-')));
    const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-data-')));

    after(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    process.env.PICKLE_INSTALL_ROOT = tmpDir;
    process.env.PICKLE_DATA_ROOT = path.join(dataDir, 'data');

    // Setup plumbing, NOT a performance assertion — the test's thesis is version
    // stability during the soak; `assert.equal(install.status, 0)` below is unchanged.
    // The old 120_000 cap was a false-failure source: install.sh runs a NETWORKED
    // `npm install @colbymchenry/codegraph` and measures ~95s cold on the operator host
    // (2026-07-18), i.e. only ~21% headroom, so ordinary network/load variance killed the
    // process (spawnSync returns status `null` on timeout → `null !== 0`, which reads as
    // "install.sh failed" rather than "the cap was too tight"). Per operating principle 1a
    // (caps are runaway backstops, not schedulers) this is a generous backstop.
    const install = spawnSync('bash', [INSTALL_SH, '--prefix', tmpDir, '--no-confirm'], {
        encoding: 'utf-8',
        timeout: 600_000,
        env: { ...process.env, PICKLE_INSTALL_ROOT: tmpDir },
    });
    assert.equal(install.status, 0, `install.sh failed: ${install.stderr}`);

    // install.sh --prefix <tmpDir> deposits directly into <tmpDir>; package.json
    // lives at <tmpDir>/extension/package.json (NOT under .claude/pickle-rick/).
    const pkgjsonPath = path.join(tmpDir, 'extension', 'package.json');
    const expectedVersion = JSON.parse(fs.readFileSync(pkgjsonPath, 'utf-8')).version;
    assert.ok(typeof expectedVersion === 'string' && expectedVersion.length > 0,
        'installed package.json must have a version');

    // Ticket 361e8bd9: the deploy must self-verify the @colbymchenry/codegraph
    // runtime dependency in the deployed tree. install.sh runs its own probe and
    // aborts non-zero on failure, so a status-0 install already implies a green
    // probe — but assert it independently here too (deploy-root install + probe
    // exit 0). On the operator host this runs the git-mode scoped-symlink path;
    // the tarball deploy-root `npm install` branch is documented as tester-only.
    const codegraphProbe = spawnSync(
        process.execPath,
        ['-e', "import('@colbymchenry/codegraph').then(()=>process.exit(0),()=>process.exit(1))"],
        { encoding: 'utf-8', timeout: 30_000, cwd: path.join(tmpDir, 'extension'), env: { ...process.env, PICKLE_INSTALL_ROOT: tmpDir } },
    );
    assert.equal(
        codegraphProbe.status,
        0,
        `deployed @colbymchenry/codegraph must resolve from ${path.join(tmpDir, 'extension')}:\n` +
        `stdout: ${codegraphProbe.stdout}\nstderr: ${codegraphProbe.stderr}`,
    );

    const soakMs = soakSeconds * 1000;
    const intervalMs = 30_000;
    const deadline = Date.now() + soakMs;

    let inconclusiveCount = 0;
    const divergentEvents = [];

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, intervalMs));

        let raw;
        try { raw = fs.readFileSync(pkgjsonPath, 'utf8'); } catch {
            inconclusiveCount++;
            if (inconclusiveCount >= 3) {
                throw new Error('INCONCLUSIVE_READS_TIMEOUT: 3+ consecutive read failures');
            }
            continue;
        }
        inconclusiveCount = 0;

        let parsed;
        try { parsed = JSON.parse(raw); } catch {
            inconclusiveCount++;
            if (inconclusiveCount >= 3) {
                throw new Error('INCONCLUSIVE_READS_TIMEOUT: 3+ consecutive JSON parse failures');
            }
            continue;
        }
        inconclusiveCount = 0;

        if (parsed.version !== expectedVersion) {
            divergentEvents.push({ ts: Date.now(), observed: parsed.version, expected: expectedVersion });
            if (divergentEvents.length >= 3) {
                const first = divergentEvents[0].ts;
                const last = divergentEvents[divergentEvents.length - 1].ts;
                if (last - first > 25 * 60 * 1000) {
                    throw new Error(
                        `VERSION_DRIFT_OBSERVED: ${divergentEvents.length} reads returned ` +
                        `${divergentEvents[0].observed} instead of ${expectedVersion}, ` +
                        `spread over ${Math.round((last - first) / 60000)} min`,
                    );
                }
            }
        } else {
            divergentEvents.length = 0;
        }
    }

    assert.equal(divergentEvents.length, 0,
        `version drift observed at end of soak: ${JSON.stringify(divergentEvents)}`);
});
