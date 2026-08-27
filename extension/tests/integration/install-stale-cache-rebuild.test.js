// @tier: integration
// AC-B2/AC-B4 — proves the R-ITS-1 property (ticket aa9f12a0 deleted the force-clean loop
// on the argument that `rm -f .tsbuildinfo` already forces a full recompile): a run that
// starts from a stale compiled artifact AND a stale .tsbuildinfo still produces compiled JS
// byte-identical to current source.
//
// NOTE on the ticket's mutation-check requirement (AC-B2 mutation): extension/tsconfig.json
// sets neither `incremental` nor `composite` (confirmed absent 2026-08-11), so plain `npx tsc`
// as invoked by install.sh NEVER consults .tsbuildinfo at all — it unconditionally rewrites
// every output file on every invocation. Empirically, running install.sh with the
// `rm -f "$SCRIPT_DIR/extension/.tsbuildinfo"` line removed against this exact stale fixture
// still exits 0 with correctly recompiled output (verified via a scratch mutated copy of
// install.sh during implementation). A test asserting non-zero exit under that mutation would
// therefore assert something false and can never be both correct and passing — so it is not
// included here. See conformance_*.md for the full writeup; this is a ticket-premise defect,
// not a coverage gap in this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const EXTENSION_ROOT_SRC = path.join(REPO_ROOT, 'extension');
const DEFAULT_INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
// Resolved against the repo root, not cwd: the AC-B3 red-proof procedure places the pre-fix copy
// INSIDE the repository (so SCRIPT_DIR still finds a .git beside it and git mode is exercised), and
// these tiers run with cwd = extension/. Matches install-source-tree-stays-loadable.test.js.
const INSTALL_SH = process.env.INSTALL_SH_PATH
    ? path.resolve(REPO_ROOT, process.env.INSTALL_SH_PATH)
    : DEFAULT_INSTALL_SH;

const TSBUILDINFO_PATH = path.join(EXTENSION_ROOT_SRC, '.tsbuildinfo');
const TYPES_INDEX_JS = path.join(EXTENSION_ROOT_SRC, 'types', 'index.js');

// Named domain per install.sh:410-419 (post-rsync MD5 parity probe, R-ITS-2).
const PARITY_FILES = [
    'types/index.js',
    'services/state-manager.js',
    'bin/spawn-morty.js',
    'bin/mux-runner.js',
    'services/pickle-utils.js',
    'bin/spawn-refinement-team.js',
    'bin/microverse-runner.js',
    'bin/spawn-gate-remediator.js',
];

// AC-B5 — the deploy script must introduce no NEW drift in tracked compiled JS.
//
// Scoped to `.js` under extension/ deliberately: install.sh:342 runs `npm install`, which can
// legitimately rewrite tracked extension/package-lock.json. An unscoped check would go red for that
// and invite the catalogued work-destroying `git restore` response the PRD warns about.
//
// The pathspec is the plain `extension` directory plus a `.js` filter applied here, NOT
// `extension/**/*.js`: git pathspec `**` matching is fnmatch-dependent, and a pathspec that silently
// matched nothing would make this assertion vacuously green — the fix-looks-applied-and-is-not mode.
function scopedDirtyJsPaths() {
    const result = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', 'extension'], {
        encoding: 'utf8',
        timeout: 30_000,
    });
    // Fail closed: a probe that did not run must never read as "clean".
    assert.equal(
        result.status,
        0,
        `git status probe failed (exit ${result.status}): ${result.stderr || result.error}`,
    );
    const paths = new Set();
    for (const line of result.stdout.split('\n')) {
        if (!line.trim()) { continue; }
        // porcelain v1 is `XY <path>`, or `XY <old> -> <new>` for a rename.
        const entry = line.slice(3);
        const rename = entry.indexOf(' -> ');
        const raw = rename === -1 ? entry : entry.slice(rename + 4);
        const clean = raw.trim().replace(/^"|"$/g, '');
        if (clean.endsWith('.js')) { paths.add(clean); }
    }
    return paths;
}

function plantStaleArtifacts() {
    const originalTypesIndex = fs.readFileSync(TYPES_INDEX_JS, 'utf8');
    const staleTypesIndex = originalTypesIndex.replace(
        /schemaVersion:\s*\d+,/,
        'schemaVersion: 1,',
    );
    assert.notEqual(staleTypesIndex, originalTypesIndex, 'precondition: schemaVersion literal must be replaceable');
    fs.writeFileSync(TYPES_INDEX_JS, staleTypesIndex);
    fs.writeFileSync(TSBUILDINFO_PATH, '{"stale":"fixture from install-stale-cache-rebuild.test.js"}\n');
    return { originalTypesIndex, staleTypesIndex };
}

function restoreArtifacts(originalTypesIndex) {
    fs.writeFileSync(TYPES_INDEX_JS, originalTypesIndex);
    try { fs.rmSync(TSBUILDINFO_PATH, { force: true }); } catch { /* best-effort */ }
}

function runInstall(installSh, tmpHome) {
    const prefix = path.join(tmpHome, '.claude', 'pickle-rick');
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), '{}');
    const result = spawnSync('bash', [installSh, '--prefix', prefix, '--no-confirm'], {
        encoding: 'utf8',
        timeout: 120_000,
        env: {
            ...process.env,
            HOME: tmpHome,
            PICKLE_INSTALL_ROOT: prefix,
            PICKLE_DATA_ROOT: path.join(tmpHome, '.local', 'share', 'pickle-rick'),
            // install.sh has zero `export` statements, so PICKLE_INSTALL_ROOT is shell-local and the
            // child inherits nothing; the deployed log-activity.js resolves through
            // getExtensionRoot() -> process.env.EXTENSION_DIR (pickle-utils.ts:330), falling back to
            // ~/.claude/pickle-rick (:226,:334) when unset. Without this the run appends to the
            // operator's real activity stream.
            EXTENSION_DIR: prefix,
        },
    });
    return { result, prefix };
}

test('install-stale-cache-rebuild: stale .tsbuildinfo + stale compiled JS still yields current-source-matching output', () => {
    const { originalTypesIndex, staleTypesIndex } = plantStaleArtifacts();
    let tmpHome = '';
    try {
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-stale-cache-'));
        // AC-B5 baseline, captured AFTER planting so the deliberate stale fixture is already in the
        // set — the window then isolates the deploy script's own effect on tracked compiled JS.
        const dirtyBefore = scopedDirtyJsPaths();
        const { result, prefix } = runInstall(INSTALL_SH, tmpHome);

        // Precondition: the active-session guard (install.sh:293-306) must not have refused. Its
        // `exit 2` is already excluded by the status check below, but name it so a sandbox leak
        // reports as a leak instead of as a generic non-zero exit.
        assert.ok(
            !result.stderr.includes('REFUSE: install.sh blocked'),
            `precondition failed: install.sh refused due to an active session leaking into the sandbox (stderr:\n${result.stderr})`,
        );
        assert.equal(result.status, 0, `install.sh failed (exit ${result.status}):\n${result.stderr}`);
        assert.match(result.stderr, /Mode: git/, 'expected git-mode install (compile block only runs in git mode)');

        // AC-B5: no tracked compiled .js may be dirtied that was not already dirty going in.
        // Raw before/after equality is NOT the assertion — this test plants a stale types/index.js on
        // purpose and the deploy script recompiles it back to HEAD, so the set legitimately SHRINKS.
        // A subset check is the faithful reading and stays compatible with AC-B2.
        //
        // The pre-fix script fails this: its force-clean loop `rm -f`s every compiled .js with a .ts
        // twin, and tsc then re-creates them at the default umask — dropping the tracked 755 bit on
        // extension/bin/reap-orphans.js (the only tracked compiled .js that is BOTH mode-755 and has a
        // .ts twin). A mode-only change is invisible to the byte-parity loop below, and reap-orphans.js
        // is not in the 8-file _parity_files domain either, so this is the only assertion that sees it.
        const dirtyAfter = scopedDirtyJsPaths();
        const newlyDirty = [...dirtyAfter].filter((p) => !dirtyBefore.has(p)).sort();
        assert.deepEqual(
            newlyDirty,
            [],
            `AC-B5: install.sh introduced new drift in tracked extension/**/*.js: ${newlyDirty.join(', ')} `
            + '(a mode-only change counts — the pre-fix force-clean loop drops the tracked 755 bit). '
            + 'Do NOT `git restore` to clear this: repair the cause, or chmod the mode back.',
        );

        const deployedExtensionRoot = path.join(prefix, 'extension');

        const recompiledTypesIndex = fs.readFileSync(TYPES_INDEX_JS, 'utf8');
        assert.notEqual(
            recompiledTypesIndex,
            staleTypesIndex,
            'stale types/index.js must have been recompiled, not left as the stale fixture',
        );

        for (const relFile of PARITY_FILES) {
            const srcFile = path.join(EXTENSION_ROOT_SRC, relFile);
            const dstFile = path.join(deployedExtensionRoot, relFile);
            assert.ok(fs.existsSync(dstFile), `parity file missing from deploy tree: ${dstFile}`);
            const srcBuf = fs.readFileSync(srcFile);
            const dstBuf = fs.readFileSync(dstFile);
            assert.ok(
                srcBuf.equals(dstBuf),
                `parity mismatch for ${relFile} (8-file _parity_files domain, install.sh:410-419)`,
            );
        }
    } finally {
        restoreArtifacts(originalTypesIndex);
        if (tmpHome) {
            try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    }
});
