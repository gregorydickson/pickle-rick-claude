// @tier: integration
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const EXTENSION_ROOT_SRC = path.join(REPO_ROOT, 'extension');

const PICKLE_RICK_FIXTURE_DIR = path.join(EXTENSION_ROOT_SRC, '.pickle-rick', 'sessions');
const PICKLE_RICK_FIXTURE_FILE = path.join(PICKLE_RICK_FIXTURE_DIR, 'dummy-session.txt');
const CODEGRAPH_FIXTURE_DIR = path.join(EXTENSION_ROOT_SRC, '.codegraph');
const CODEGRAPH_FIXTURE_FILE = path.join(CODEGRAPH_FIXTURE_DIR, 'dummy-index.bin');

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

let tmpHome = '';

before(() => {
    fs.mkdirSync(PICKLE_RICK_FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(PICKLE_RICK_FIXTURE_FILE, 'fixture: untracked working-dir state\n');
    fs.mkdirSync(CODEGRAPH_FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(CODEGRAPH_FIXTURE_FILE, 'fixture: untracked codegraph index\n');
});

after(() => {
    try { fs.rmSync(path.join(EXTENSION_ROOT_SRC, '.pickle-rick'), { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(CODEGRAPH_FIXTURE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (tmpHome) {
        try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

function findAll(root, name) {
    const hits = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === name) { hits.push(full); }
                stack.push(full);
            }
        }
    }
    return hits;
}

test('install-excludes-working-dir-state: deploy tree contains no .pickle-rick or .codegraph, and payload survives', () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-excludes-'));
    const prefix = path.join(tmpHome, '.claude', 'pickle-rick');

    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', 'settings.json'), '{}');

    const install = spawnSync('bash', [INSTALL_SH, '--prefix', prefix, '--no-confirm'], {
        encoding: 'utf8',
        timeout: 120_000,
        env: {
            ...process.env,
            HOME: tmpHome,
            PICKLE_INSTALL_ROOT: prefix,
            PICKLE_DATA_ROOT: path.join(tmpHome, '.local', 'share', 'pickle-rick'),
        },
    });

    assert.equal(install.status, 0, `install.sh failed (exit ${install.status}):\n${install.stderr}`);

    const deployedExtensionRoot = path.join(prefix, 'extension');

    const pickleRickHits = findAll(deployedExtensionRoot, '.pickle-rick');
    assert.equal(pickleRickHits.length, 0, `.pickle-rick leaked into deploy tree: ${pickleRickHits.join(', ')}`);

    const codegraphHits = findAll(deployedExtensionRoot, '.codegraph');
    assert.equal(codegraphHits.length, 0, `.codegraph leaked into deploy tree: ${codegraphHits.join(', ')}`);

    for (const relFile of PARITY_FILES) {
        const srcFile = path.join(EXTENSION_ROOT_SRC, relFile);
        const dstFile = path.join(deployedExtensionRoot, relFile);
        assert.ok(fs.existsSync(dstFile), `parity file missing from deploy tree: ${dstFile}`);
        const srcBuf = fs.readFileSync(srcFile);
        const dstBuf = fs.readFileSync(dstFile);
        assert.ok(srcBuf.equals(dstBuf), `parity mismatch for ${relFile}`);
    }

    assert.ok(
        fs.existsSync(path.join(deployedExtensionRoot, 'bin', 'mux-runner.js')),
        'bin/mux-runner.js missing from deploy tree',
    );
    assert.ok(
        fs.existsSync(path.join(deployedExtensionRoot, 'services', 'state-manager.js')),
        'services/state-manager.js missing from deploy tree',
    );
});
