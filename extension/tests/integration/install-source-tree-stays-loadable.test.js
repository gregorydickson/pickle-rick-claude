// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const TARGET_FILE = path.join(REPO_ROOT, 'extension', 'types', 'index.js');
const POLL_INTERVAL_MS = 10;
// Minimum polls that must land INSIDE the subprocess lifetime. At a 10ms interval this is >=500ms of
// the compile window. Real runs observed 357-360 in-window samples, so this carries ~7x headroom on a
// loaded box while still failing a run that only sampled at the edges — which is the vacuous pass a
// bare `sampleCount > 0` cannot distinguish, since that counter also credits pre-spawn samples.
const MIN_IN_WINDOW_SAMPLES = 50;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function gitStatusPorcelain() {
    return execSync("git status --porcelain -- 'extension/**/*.js'", {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
}

test('install-source-tree-stays-loadable: extension/types/index.js is never observed absent during install.sh', async () => {
    const installShPath = process.env.INSTALL_SH_PATH
        ? path.resolve(REPO_ROOT, process.env.INSTALL_SH_PATH)
        : DEFAULT_INSTALL_SH;

    const beforeStatus = gitStatusPorcelain();

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-source-tree-'));
    const prefix = path.join(tmpHome, '.claude', 'pickle-rick');
    const dataRoot = path.join(tmpHome, '.local', 'share', 'pickle-rick');

    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), '{}');

    let stderr = '';
    let stdout = '';

    let polling = true;
    let sampleCount = 0;
    let minSize = Infinity;
    let neverAbsent = true;
    const samples = [];

    const pollLoop = (async () => {
        while (polling) {
            if (fs.existsSync(TARGET_FILE)) {
                sampleCount += 1;
                const size = fs.statSync(TARGET_FILE).size;
                if (size < minSize) minSize = size;
                samples.push({ t: Date.now(), present: true });
            } else {
                neverAbsent = false;
                samples.push({ t: Date.now(), present: false });
            }
            await sleep(POLL_INTERVAL_MS);
        }
    })();

    try {
        const child = spawn('bash', [installShPath, '--prefix', prefix, '--no-confirm'], {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                HOME: tmpHome,
                PICKLE_INSTALL_ROOT: prefix,
                PICKLE_DATA_ROOT: dataRoot,
                EXTENSION_DIR: prefix,
            },
        });

        const spawnedAt = Date.now();

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        let closedAt = 0;
        const exitCode = await new Promise((resolve) => {
            child.on('close', (code) => {
                closedAt = Date.now();
                resolve(code);
            });
        });

        polling = false;
        await pollLoop;

        // Precondition #1: git mode must have been exercised (install.sh:337), else the compile
        // block (install.sh:339-360) never ran and this test proves nothing.
        assert.ok(
            stderr.includes('[install.sh] Mode: git'),
            `precondition failed: install.sh did not report git mode (stderr:\n${stderr}\nstdout:\n${stdout})`,
        );

        // Precondition #2: the active-session guard (install.sh:285-306) must not have refused —
        // a sandboxed empty PICKLE_DATA_ROOT should let the script proceed to the compile block.
        assert.ok(
            !stderr.includes('REFUSE: install.sh blocked'),
            `precondition failed: install.sh refused due to an active session leaking into the sandbox (stderr:\n${stderr})`,
        );

        // AC-B3: the source tree must never be observed absent while install.sh runs.
        assert.equal(
            neverAbsent,
            true,
            `extension/types/index.js was observed ABSENT during install.sh (samples: ${JSON.stringify(samples.filter((s) => !s.present))})`,
        );

        // Non-vacuous sample-count assertion: the poll loop starts before spawn and stops after
        // close, so a total-sample count cannot distinguish "sampled throughout the compile window"
        // from "sampled once, before the child existed". Count only the polls whose timestamp falls
        // inside the subprocess lifetime, and require a floor.
        const inWindowSamples = samples.filter((s) => s.t >= spawnedAt && s.t <= closedAt);
        assert.ok(
            inWindowSamples.length >= MIN_IN_WINDOW_SAMPLES,
            `poll loop recorded only ${inWindowSamples.length} samples inside the install.sh subprocess lifetime `
            + `(spawned ${spawnedAt}, closed ${closedAt}, ${samples.length} samples total); `
            + `>= ${MIN_IN_WINDOW_SAMPLES} required — below that the absence check proves nothing`,
        );

        // Recorded as data only, per ticket: no assertion on minSize.
        console.log(`[install-source-tree-stays-loadable] recorded min observed size: ${minSize === Infinity ? 'n/a' : minSize} bytes, sample count: ${sampleCount}, in-window samples: ${inWindowSamples.length}`);

        assert.equal(exitCode, 0, `install.sh exited non-zero (${exitCode}):\nstderr:\n${stderr}\nstdout:\n${stdout}`);

        // AC-B5: the repo's own compiled JS tree must be byte-identical before and after (tsc
        // recompiles deterministically from unchanged .ts source).
        const afterStatus = gitStatusPorcelain();
        assert.equal(
            afterStatus,
            beforeStatus,
            `git status for extension/**/*.js changed after install.sh ran:\nbefore:\n${beforeStatus}\nafter:\n${afterStatus}`,
        );
    } finally {
        polling = false;
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});
