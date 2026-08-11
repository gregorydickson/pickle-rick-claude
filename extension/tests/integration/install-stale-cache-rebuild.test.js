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
const INSTALL_SH = process.env.INSTALL_SH_PATH ?? DEFAULT_INSTALL_SH;

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

function plantStaleArtifacts() {
    const originalTypesIndex = fs.readFileSync(TYPES_INDEX_JS, 'utf8');
    const staleTypesIndex = originalTypesIndex.replace(
        /schemaVersion:\s*\d+,/,
        'schemaVersion: 1,',
    );
    assert.notEqual(staleTypesIndex, originalTypesIndex, 'precondition: schemaVersion literal must be replaceable');
    fs.writeFileSync(TYPES_INDEX_JS, staleTypesIndex);
    fs.writeFileSync(TSBUILDINFO_PATH, '{"stale":"fixture from install-stale-cache-rebuild.test.js"}\n');
    return originalTypesIndex;
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
        },
    });
    return { result, prefix };
}

test('install-stale-cache-rebuild: stale .tsbuildinfo + stale compiled JS still yields current-source-matching output', () => {
    const originalTypesIndex = plantStaleArtifacts();
    let tmpHome = '';
    try {
        tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-stale-cache-'));
        const { result, prefix } = runInstall(INSTALL_SH, tmpHome);

        assert.equal(result.status, 0, `install.sh failed (exit ${result.status}):\n${result.stderr}`);
        assert.match(result.stderr, /Mode: git/, 'expected git-mode install (compile block only runs in git mode)');

        const deployedExtensionRoot = path.join(prefix, 'extension');

        const recompiledTypesIndex = fs.readFileSync(TYPES_INDEX_JS, 'utf8');
        assert.notEqual(
            recompiledTypesIndex,
            originalTypesIndex.replace(/schemaVersion:\s*\d+,/, 'schemaVersion: 1,'),
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
