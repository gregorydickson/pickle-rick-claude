// @tier: expensive
// BUG_REPRODUCES_AT: 1d181df15d53930e42b72ec8ee993d1e2aa594d4
// BUG_FIXED_AT: (ticket 82739e5b fix commit — populate after merge)
//
// Soak canary: monitors a deployed extension install for package.json version drift.
// Gated by RUN_EXPENSIVE_TESTS=1 — that is tier SELECTION, and the only skip in this file.
//
// The soak PROVISIONS ITS OWN sandbox root under os.tmpdir(): a private HOME, a private
// install prefix, and a private data root. It does NOT read PICKLE_INSTALL_ROOT — the
// installer reassigns that from --prefix unconditionally, so exporting it is inert. Nothing
// under the operator's real ~/.claude is read or written.
//
// Once RUN_EXPENSIVE_TESTS=1 is set, the operator has ASKED for the soak, so every remaining
// refusal THROWS with a `SOAK_UNRUN:` prefix rather than skipping. A skip reports as TAP
// `ok ... # SKIP` (exit 0) — a green over a leg that never ran, which at release scale is a
// false answer. `grep SOAK_UNRUN` over tier output is a complete audit of refusals.
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

    const soakSeconds = (() => {
        const raw = Number(process.env.SOAK_SECONDS ?? 1800);
        if (!Number.isFinite(raw) || raw < 1800) {
            throw new Error('SOAK_SECONDS must be >= 1800');
        }
        return raw;
    })();

    // Checked on the BASE dir BEFORE anything is created, so a bad TMPDIR costs no writes
    // and no soak time. Both sides are realpath'd so a symlinked $HOME cannot slip past,
    // and the separator guard stops /Users/greg matching /Users/gregory.
    const tmpBase = fs.realpathSync(os.tmpdir());
    const homeReal = fs.realpathSync(os.homedir());
    if (tmpBase === homeReal || tmpBase.startsWith(homeReal + path.sep)) {
        throw new Error(
            `SOAK_UNRUN: refusing to provision the soak sandbox under $HOME ` +
            `(os.tmpdir() resolved to ${tmpBase}, $HOME to ${homeReal}). ` +
            `Set TMPDIR to a non-$HOME path and re-run.`,
        );
    }

    // One sandbox root, mirroring the real layout: the installer derives its settings.json
    // and commands dir as <prefix>/../*, so nesting the prefix keeps those siblings INSIDE
    // the directory after() removes instead of leaking into the shared $TMPDIR.
    const soakHome = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase, 'pickle-soak-')));
    const installRoot = path.join(soakHome, '.claude', 'pickle-rick');
    const dataRoot = path.join(soakHome, '.local', 'share', 'pickle-rick');

    after(() => {
        try { fs.rmSync(soakHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // Explicit env rather than mutating process.env: the installer resolves several paths
    // from HOME that its --prefix flag does NOT cover (notably the agents dir), so HOME must
    // point into the sandbox for the run to be hermetic. PICKLE_DATA_ROOT keeps the
    // installer's active-session guard looking at the sandbox, not the operator's sessions.
    const soakEnv = {
        ...process.env,
        HOME: soakHome,
        PICKLE_INSTALL_ROOT: installRoot,
        PICKLE_DATA_ROOT: dataRoot,
    };

    // Setup plumbing, NOT a performance assertion — the test's thesis is version
    // stability during the soak; `assert.equal(install.status, 0)` below is unchanged.
    // The old 120_000 cap was a false-failure source: the installer runs a NETWORKED
    // `npm install @colbymchenry/codegraph` and measures ~95s cold on the operator host
    // (2026-07-18), i.e. only ~21% headroom, so ordinary network/load variance killed the
    // process (spawnSync returns status `null` on timeout → `null !== 0`, which reads as
    // "install failed" rather than "the cap was too tight"). Per operating principle 1a
    // (caps are runaway backstops, not schedulers) this is a generous backstop.
    //
    // This is also the --prefix support check: if --prefix is ever dropped, the installer
    // exits non-zero on the unknown flag and this assertion reports it with stderr attached.
    // A separate pre-flight probe would only convert that failure into a silent pass.
    const install = spawnSync('bash', [INSTALL_SH, '--prefix', installRoot, '--no-confirm'], {
        encoding: 'utf-8',
        timeout: 600_000,
        env: soakEnv,
    });
    assert.equal(install.status, 0, `install failed: ${install.stderr}`);

    // --prefix <installRoot> deposits directly into <installRoot>; package.json lives at
    // <installRoot>/extension/package.json.
    const pkgjsonPath = path.join(installRoot, 'extension', 'package.json');
    const expectedVersion = JSON.parse(fs.readFileSync(pkgjsonPath, 'utf-8')).version;
    assert.ok(typeof expectedVersion === 'string' && expectedVersion.length > 0,
        'installed package.json must have a version');

    // Ticket 361e8bd9: the deploy must self-verify the @colbymchenry/codegraph
    // runtime dependency in the deployed tree. The installer runs its own probe and
    // aborts non-zero on failure, so a status-0 install already implies a green
    // probe — but assert it independently here too (deploy-root install + probe
    // exit 0). On the operator host this runs the git-mode scoped-symlink path;
    // the tarball deploy-root `npm install` branch is documented as tester-only.
    const codegraphProbe = spawnSync(
        process.execPath,
        ['-e', "import('@colbymchenry/codegraph').then(()=>process.exit(0),()=>process.exit(1))"],
        { encoding: 'utf-8', timeout: 30_000, cwd: path.join(installRoot, 'extension'), env: soakEnv },
    );
    assert.equal(
        codegraphProbe.status,
        0,
        `deployed @colbymchenry/codegraph must resolve from ${path.join(installRoot, 'extension')}:\n` +
        `stdout: ${codegraphProbe.stdout}\nstderr: ${codegraphProbe.stderr}`,
    );

    const soakMs = soakSeconds * 1000;
    const intervalMs = 30_000;
    const startedAt = Date.now();
    const deadline = startedAt + soakMs;

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

    // Wall-clock oracle: a soak that returns far below SOAK_SECONDS did not soak. The loop
    // above already implies this structurally, but asserting it is the negative control that
    // stops a future short-circuit from re-becoming a fast green.
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
        elapsedMs >= soakMs,
        `SOAK_UNRUN: soak returned after ${elapsedMs}ms but SOAK_SECONDS requires ${soakMs}ms — ` +
        `a run this short did not soak`,
    );

    assert.equal(divergentEvents.length, 0,
        `version drift observed at end of soak: ${JSON.stringify(divergentEvents)}`);
});
