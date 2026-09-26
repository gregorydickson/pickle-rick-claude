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
let plantedFixtures = [];

// The fixture dirs live inside the SOURCE tree, where an operator's real session state and
// codegraph index may already sit (both gitignored, so git cannot restore them). Cleanup
// removes only what planting created: the dummy file, plus the topmost directory that
// mkdirSync reports it made — never a directory that existed before the test.
function plantFixture(file, content) {
    const createdDir = fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return { file, createdDir };
}

function removeFixture({ file, createdDir }) {
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort */ }
    if (createdDir) {
        try { fs.rmSync(createdDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

before(() => {
    plantedFixtures = [
        plantFixture(PICKLE_RICK_FIXTURE_FILE, 'fixture: untracked working-dir state\n'),
        plantFixture(CODEGRAPH_FIXTURE_FILE, 'fixture: untracked codegraph index\n'),
    ];
});

after(() => {
    for (const planted of plantedFixtures) removeFixture(planted);
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

test('install-excludes-working-dir-state: fixture cleanup spares pre-existing operator state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-excludes-cleanup-'));
    try {
        const operatorDb = path.join(root, '.codegraph', 'codegraph.db');
        const operatorSession = path.join(root, '.pickle-rick', 'sessions', 'real-session', 'state.json');
        fs.mkdirSync(path.dirname(operatorDb), { recursive: true });
        fs.writeFileSync(operatorDb, 'operator index');
        fs.mkdirSync(path.dirname(operatorSession), { recursive: true });
        fs.writeFileSync(operatorSession, '{}');

        const plantedIntoExisting = [
            plantFixture(path.join(root, '.codegraph', 'dummy-index.bin'), 'x'),
            plantFixture(path.join(root, '.pickle-rick', 'sessions', 'dummy-session.txt'), 'x'),
        ];
        const plantedFresh = plantFixture(path.join(root, 'fresh', 'nested', 'dummy.txt'), 'x');
        for (const planted of [...plantedIntoExisting, plantedFresh]) removeFixture(planted);

        assert.ok(fs.existsSync(operatorDb), 'cleanup deleted a pre-existing .codegraph index');
        assert.ok(fs.existsSync(operatorSession), 'cleanup deleted a pre-existing .pickle-rick session');
        for (const { file } of plantedIntoExisting) {
            assert.equal(fs.existsSync(file), false, `planted fixture survived cleanup: ${file}`);
        }
        assert.equal(fs.existsSync(path.join(root, 'fresh')), false, 'a directory the fixture created survived cleanup');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
