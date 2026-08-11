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
const INJECTION_TARGET = path.join(REPO_ROOT, 'extension', 'src', 'types', 'index.ts');
const INJECTED_ERROR = '\nconst __INJECTED_TSC_FAILURE_98cbf066: string = 12345;\n';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Scoped to the compiled-tree + its .ts sources, mirroring the sibling success-path test's
// gitStatusPorcelain() — a whole-repo check would false-fail on this ticket's own unrelated dirt
// (the new test file, the manifest edits, an unrelated in-flight PRD draft).
function compiledTreeStatusPorcelain() {
    return execSync("git status --porcelain -- 'extension/**/*.js' 'extension/**/*.ts'", {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
}

// Enumerates every tracked compiled .js under extension/ (excluding tests/) whose .ts twin exists
// under extension/src/ — this is the AC-B7 "156 tracked compiled .js" set, computed live rather
// than pinned, so the test does not go stale as the source tree grows.
function trackedCompiledJsWithTsTwin() {
    const listing = execSync("git ls-files -- 'extension/*.js' 'extension/**/*.js'", {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    const compiled = listing.split('\n').filter((p) => p && !p.startsWith('extension/tests/'));
    const pairs = [];
    for (const relJs of compiled) {
        // extension/<sub>/<name>.js -> extension/src/<sub>/<name>.ts
        const withoutExtension = relJs.slice('extension/'.length, -'.js'.length);
        const relTs = path.join('extension', 'src', `${withoutExtension}.ts`);
        if (fs.existsSync(path.join(REPO_ROOT, relTs))) {
            pairs.push(relJs);
        }
    }
    return pairs;
}

test('install-compile-failure-preserves-source: I1 holds when tsc fails', async () => {
    const installShPath = process.env.INSTALL_SH_PATH
        ? path.resolve(REPO_ROOT, process.env.INSTALL_SH_PATH)
        : DEFAULT_INSTALL_SH;

    const trackedPairs = trackedCompiledJsWithTsTwin();
    assert.ok(trackedPairs.length > 0, 'precondition: at least one tracked compiled .js with a .ts twin must exist');

    const originalSource = fs.readFileSync(INJECTION_TARGET, 'utf8');
    const beforeStatus = compiledTreeStatusPorcelain();

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-compile-failure-'));
    const prefix = path.join(tmpHome, '.claude', 'pickle-rick');
    const dataRoot = path.join(tmpHome, '.local', 'share', 'pickle-rick');

    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), '{}');

    let stderr = '';
    let stdout = '';
    let exitCode = null;

    // Poll for absence WHILE install.sh runs, not just after it exits. A delete-then-regenerate
    // sequence (the pre-aa9f12a0 force-clean loop) can delete every compiled .js and have tsc
    // fully re-emit them all before the process exits — a post-exit-only check would never observe
    // the transient torn-tree window a concurrent reader could hit. Mirrors the AC-B3 poll loop in
    // install-source-tree-stays-loadable.test.js.
    let polling = true;
    let neverAbsent = true;
    const missingDuringRun = new Set();
    const pollLoop = (async () => {
        while (polling) {
            for (const relJs of trackedPairs) {
                if (!fs.existsSync(path.join(REPO_ROOT, relJs))) {
                    neverAbsent = false;
                    missingDuringRun.add(relJs);
                }
            }
            await sleep(20);
        }
    })();

    try {
        fs.writeFileSync(INJECTION_TARGET, `${originalSource}${INJECTED_ERROR}`);

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

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        exitCode = await new Promise((resolve) => {
            child.on('close', (code) => resolve(code));
        });

        polling = false;
        await pollLoop;

        // Give any last async fs writes from the failing compile step a moment to settle before
        // the final post-exit enumeration, mirroring the poll-settle pattern in the sibling test.
        await sleep(50);
    } finally {
        polling = false;
        fs.writeFileSync(INJECTION_TARGET, originalSource);
        // The failed install.sh run left the repo's own extension/types/index.js compiled from the
        // mutated (broken) source. Recompile against the now-restored source to bring the tracked
        // compiled tree back to its pre-test byte content — a normal build step, not a git undo.
        try {
            execSync('npx tsc', { cwd: path.join(REPO_ROOT, 'extension'), stdio: 'pipe' });
        } catch { /* best-effort: absence of a clean recompile is caught by the status assertion below */ }
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }

    // Precondition: git mode must have been exercised, else the compile block never ran.
    assert.ok(
        stderr.includes('[install.sh] Mode: git'),
        `precondition failed: install.sh did not report git mode (stderr:\n${stderr}\nstdout:\n${stdout})`,
    );

    // AC-B7 clause 1: non-zero exit on a compile failure.
    assert.notEqual(
        exitCode,
        0,
        `install.sh exited 0 despite an injected compile error (stderr:\n${stderr}\nstdout:\n${stdout})`,
    );

    // AC-B7 clause 2 (I1): every tracked compiled .js with a .ts twin must never be observed absent
    // — neither transiently during the run, nor in the final post-exit state.
    const missingAfter = trackedPairs.filter((relJs) => !fs.existsSync(path.join(REPO_ROOT, relJs)));
    assert.deepEqual(
        missingAfter,
        [],
        `compiled .js files missing in the final post-exit state (I1 violated): ${JSON.stringify(missingAfter)}`,
    );
    assert.equal(
        neverAbsent,
        true,
        `compiled .js files were observed transiently ABSENT during install.sh (I1 violated): ${JSON.stringify([...missingDuringRun])}`,
    );

    // Diagnostic recorded (not asserted) for the ticket's evidence requirement.
    console.log(`[install-compile-failure-preserves-source] captured diagnostic:\n${stderr}\n${stdout}`);

    // AC: the injected error was reverted without git checkout/stash/restore, and the compiled tree
    // is byte-identical to before the injection (tsc recompiles deterministically from unchanged
    // source).
    const afterStatus = compiledTreeStatusPorcelain();
    assert.equal(
        afterStatus,
        beforeStatus,
        `git status for extension/**/*.{js,ts} changed after revert:\nbefore:\n${beforeStatus}\nafter:\n${afterStatus}`,
    );
});
