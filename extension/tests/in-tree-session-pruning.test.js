// @tier: integration
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../bin/setup.js');

// Sandbox the canonical data root so these runs never touch the operator's
// real ~/.local/share/pickle-rick/sessions/.
const DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-in-tree-prune-data-')));
after(() => {
    try { fs.rmSync(DATA_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

// The in-tree scaffold is deliberately keyed on process.cwd(), so each test
// runs setup.js with cwd pointed at a fresh mkdtemp dir — never the real repo tree.
function runSetupInCwd(cwd, extraEnv) {
    const env = {
        ...process.env,
        FORCE_COLOR: '0',
        PICKLE_DATA_ROOT: DATA_ROOT,
        ...extraEnv,
    };
    return execFileSync(process.execPath, [SETUP, '--tmux', 'in-tree prune test'], {
        cwd,
        encoding: 'utf-8',
        env,
    });
}

function makeTmpCwd() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-in-tree-prune-cwd-')));
}

function sessionIdFromOutput(output) {
    const match = output.match(/SESSION_ROOT=(.+)/);
    if (!match) throw new Error(`SESSION_ROOT not found in output:\n${output}`);
    return path.basename(match[1].trim());
}

test('in-tree scaffold: TASK_NOTES.md is created and reachable at the primary path', () => {
    const cwd = makeTmpCwd();
    try {
        const output = runSetupInCwd(cwd);
        const sessionId = sessionIdFromOutput(output);

        const notesPath = path.join(cwd, '.pickle-rick', 'sessions', sessionId, 'TASK_NOTES.md');
        assert.ok(fs.existsSync(notesPath), `expected in-tree scaffold at ${notesPath}`);
        const content = fs.readFileSync(notesPath, 'utf-8');
        assert.ok(content.length > 0, 'TASK_NOTES.md must be non-empty');
        assert.match(content, /# TASK_NOTES/);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('in-tree scaffold: an old session dir is pruned, a recent one survives', () => {
    const cwd = makeTmpCwd();
    try {
        const inTreeRoot = path.join(cwd, '.pickle-rick', 'sessions');
        fs.mkdirSync(inTreeRoot, { recursive: true });

        const oldDir = path.join(inTreeRoot, '2020-01-01-oldsession');
        const recentDir = path.join(inTreeRoot, '2020-01-01-recentsession');
        fs.mkdirSync(oldDir, { recursive: true });
        fs.mkdirSync(recentDir, { recursive: true });
        fs.writeFileSync(path.join(oldDir, 'TASK_NOTES.md'), '# TASK_NOTES\n');
        fs.writeFileSync(path.join(recentDir, 'TASK_NOTES.md'), '# TASK_NOTES\n');

        const now = Date.now() / 1000;
        const eightDaysAgo = now - 8 * 24 * 60 * 60;
        const oneDayAgo = now - 1 * 24 * 60 * 60;
        fs.utimesSync(oldDir, eightDaysAgo, eightDaysAgo);
        fs.utimesSync(recentDir, oneDayAgo, oneDayAgo);

        runSetupInCwd(cwd);

        assert.equal(fs.existsSync(oldDir), false, 'session dir older than the 7-day window must be pruned');
        assert.equal(fs.existsSync(recentDir), true, 'session dir inside the 7-day window must survive');
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('in-tree scaffold: pruning never blocks session start (unwritable root)', () => {
    const cwd = makeTmpCwd();
    const inTreeRoot = path.join(cwd, '.pickle-rick', 'sessions');
    fs.mkdirSync(inTreeRoot, { recursive: true });
    fs.chmodSync(inTreeRoot, 0o444);
    try {
        const output = runSetupInCwd(cwd);
        assert.match(output, /SESSION_ROOT=/, 'createSession must still return a session despite an unwritable in-tree root');
    } finally {
        fs.chmodSync(inTreeRoot, 0o755);
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('in-tree scaffold: the current session dir survives a second createSession call in the same cwd', () => {
    const cwd = makeTmpCwd();
    try {
        const firstOutput = runSetupInCwd(cwd);
        const firstSessionId = sessionIdFromOutput(firstOutput);
        const firstDir = path.join(cwd, '.pickle-rick', 'sessions', firstSessionId);
        assert.ok(fs.existsSync(firstDir), 'first session in-tree dir must exist right after creation');

        runSetupInCwd(cwd);

        assert.ok(fs.existsSync(firstDir), 'first session in-tree dir must still exist after a second createSession call');
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
