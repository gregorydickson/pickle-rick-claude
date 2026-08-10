// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildJarNotification, discoverMarinatingTasks, loadJarTaskTimeout } from '../bin/jar-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JAR_RUNNER_BIN = path.resolve(__dirname, '../bin/jar-runner.js');

/**
 * Create an isolated temp root directory for EXTENSION_DIR.
 * Uses fs.realpathSync to resolve macOS /var -> /private/var symlinks,
 * ensuring paths match across the subprocess boundary.
 */
function makeTmpRoot() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-jar-runner-')));
    const sentinelDir = path.join(root, 'extension', 'bin');
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
    // R-PNTR: the bare `/pickle` command + its deployed pickle.md are gone; the
    // manager-lifecycle body now lives in _pickle-manager-prompt.md, resolved via
    // getExtensionRoot()/templates. Self-contained so the test no longer depends
    // on a deployed copy (matches jar-codex.test.js fixture).
    const templatesDir = path.join(root, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(
        path.join(templatesDir, '_pickle-manager-prompt.md'),
        '# Manager Prompt\n\nImplement the ticket.\n',
    );
    return root;
}

function buildRunnerEnv(extDir, overrides = {}) {
    return {
        HOME: process.env.HOME || '/tmp',
        NODE_ENV: 'test',
        EXTENSION_DIR: extDir,
        PICKLE_DATA_ROOT: extDir,
        PICKLE_BACKEND: '',
        PICKLE_ROLE: '',
        PICKLE_REFINEMENT_LOCK: '',
        CLAUDECODE: '',
        PATH: '',
        ...overrides,
    };
}

/**
 * Run jar-runner.js as a subprocess with isolated EXTENSION_DIR.
 * Returns the spawnSync result with stdout, stderr, and status.
 */
function run(extDir) {
    // 10s → 30s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests validate jar processing logic, not wall-clock.
    return spawnSync(process.execPath, [JAR_RUNNER_BIN], {
        env: buildRunnerEnv(extDir),
        encoding: 'utf-8',
        timeout: 30000,
    });
}

async function waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

// --- Empty jar (no jar/ directory) ---

test('jar-runner: outputs "Pickle Jar is empty" when no jar/ dir exists', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const result = run(tmpRoot);
        assert.ok(
            result.stdout.includes('Pickle Jar is empty'),
            `Expected "Pickle Jar is empty" in stdout, got: ${result.stdout}`
        );
        assert.ok(
            result.stdout.includes('Jar Complete'),
            `Expected "Jar Complete" signal in stdout, got: ${result.stdout}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- No marinating tasks ---

test('jar-runner: outputs "No marinating tasks" when jar/ has non-marinating tasks', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Create jar/2026-01-01/task1/meta.json with status !== 'marinating'
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', 'task1');
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify({
            status: 'consumed',
            repo_path: '/some/repo',
        }, null, 2));

        const result = run(tmpRoot);
        assert.ok(
            result.stdout.includes('No marinating tasks'),
            `Expected "No marinating tasks" in stdout, got: ${result.stdout}`
        );
        assert.ok(
            result.stdout.includes('Jar Complete'),
            `Expected "Jar Complete" signal in stdout, got: ${result.stdout}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('discoverMarinatingTasks: returns only marinating tasks in stable day/task order', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const jarRoot = path.join(tmpRoot, 'jar');
        fs.mkdirSync(path.join(jarRoot, '2026-01-02', 'task-b'), { recursive: true });
        fs.mkdirSync(path.join(jarRoot, '2026-01-01', 'task-c'), { recursive: true });
        fs.mkdirSync(path.join(jarRoot, '2026-01-01', 'task-a'), { recursive: true });

        fs.writeFileSync(path.join(jarRoot, '2026-01-02', 'task-b', 'meta.json'), JSON.stringify({
            status: 'marinating',
            repo_path: '/tmp/repo-b',
        }));
        fs.writeFileSync(path.join(jarRoot, '2026-01-01', 'task-c', 'meta.json'), JSON.stringify({
            status: 'consumed',
            repo_path: '/tmp/repo-c',
        }));
        fs.writeFileSync(path.join(jarRoot, '2026-01-01', 'task-a', 'meta.json'), JSON.stringify({
            status: 'marinating',
            repo_path: '/tmp/repo-a',
        }));

        const tasks = discoverMarinatingTasks(jarRoot);
        assert.deepEqual(tasks.map(task => task.taskId), ['task-a', 'task-b']);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('discoverMarinatingTasks: recovers newer dead-writer meta tmp before filtering status', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', 'task-a');
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');
        const tmpMetaPath = `${metaPath}.tmp.999999`;

        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            repo_path: '/tmp/repo-a',
        }));
        fs.writeFileSync(tmpMetaPath, JSON.stringify({
            status: 'consumed',
            repo_path: '/tmp/repo-a',
        }));
        const stale = new Date('2026-01-01T00:00:00.000Z');
        const newer = new Date('2026-01-01T00:00:01.000Z');
        fs.utimesSync(metaPath, stale, stale);
        fs.utimesSync(tmpMetaPath, newer, newer);

        const tasks = discoverMarinatingTasks(path.join(tmpRoot, 'jar'));

        assert.deepEqual(tasks.map(task => task.taskId), []);
        assert.equal(fs.existsSync(tmpMetaPath), false);
        assert.equal(
            JSON.parse(fs.readFileSync(metaPath, 'utf-8')).status,
            'consumed',
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// AP-EXT-ITER16-01: the sibling test above seeds a BASE meta.json plus a newer tmp,
// so it stays GREEN with an `existsSync(metaPath)` pre-gate in place. The defect lives
// on the tmp-ONLY path: addToJar writes meta.json tmp-rename, so a crash in that window
// leaves no base at all and the queued task went silently undiscoverable.
test('discoverMarinatingTasks: recovers a tmp-ONLY meta with no base file', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', 'task-a');
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');
        const tmpMetaPath = `${metaPath}.tmp.999999`;

        fs.writeFileSync(tmpMetaPath, JSON.stringify({
            status: 'marinating',
            repo_path: '/tmp/repo-a',
        }));
        assert.equal(fs.existsSync(metaPath), false);

        const tasks = discoverMarinatingTasks(path.join(tmpRoot, 'jar'));

        assert.deepEqual(tasks.map(task => task.taskId), ['task-a']);
        assert.equal(tasks[0].meta.repo_path, '/tmp/repo-a');
        // The recovering read PROMOTES the orphan tmp onto the base path.
        assert.equal(fs.existsSync(tmpMetaPath), false);
        assert.equal(
            JSON.parse(fs.readFileSync(metaPath, 'utf-8')).status,
            'marinating',
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('discoverMarinatingTasks: skips non-directories, missing meta, and corrupt meta files', () => {
    const tmpRoot = makeTmpRoot();
    const stderr = console.error;
    console.error = () => {};
    try {
        const jarRoot = path.join(tmpRoot, 'jar');
        fs.mkdirSync(path.join(jarRoot, '2026-01-03', 'good-task'), { recursive: true });
        fs.mkdirSync(path.join(jarRoot, '2026-01-03', 'missing-meta'), { recursive: true });
        fs.mkdirSync(path.join(jarRoot, '2026-01-03', 'bad-task'), { recursive: true });
        fs.writeFileSync(path.join(jarRoot, 'README.md'), 'not a day directory');
        fs.writeFileSync(path.join(jarRoot, '2026-01-03', 'good-task', 'meta.json'), JSON.stringify({
            status: 'marinating',
            repo_path: '/tmp/repo-good',
        }));
        fs.writeFileSync(path.join(jarRoot, '2026-01-03', 'bad-task', 'meta.json'), '{{{broken');

        const tasks = discoverMarinatingTasks(jarRoot);
        assert.deepEqual(tasks.map(task => task.taskId), ['good-task']);
    } finally {
        console.error = stderr;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Corrupt meta.json ---

test('jar-runner: outputs "Skipping" warning when meta.json is corrupt', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', 'task1');
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(path.join(taskDir, 'meta.json'), '{{{not json at all!!!');

        const result = run(tmpRoot);
        assert.ok(
            result.stderr.includes('Skipping'),
            `Expected "Skipping" in stderr for corrupt meta.json, got stderr: ${result.stderr}`
        );
        // With no valid marinating tasks, should still output "No marinating tasks"
        assert.ok(
            result.stdout.includes('No marinating tasks'),
            `Expected "No marinating tasks" in stdout, got: ${result.stdout}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Missing repo_path ---

test('jar-runner: skips task and sets status to failed when repo_path is missing', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-no-repo';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            // no repo_path
        }, null, 2));

        // Create the session dir that jar-runner will look for
        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 0,
        }, null, 2));

        const result = run(tmpRoot);
        assert.ok(
            result.stderr.includes('Skipping'),
            `Expected "Skipping" in stderr for missing repo_path, got stderr: ${result.stderr}`
        );
        assert.ok(
            result.stderr.includes('repo_path'),
            `Expected "repo_path" mentioned in skip message, got stderr: ${result.stderr}`
        );

        // Verify meta.json status was set to 'failed'
        const updatedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.equal(
            updatedMeta.status, 'failed',
            `Expected meta.status to be "failed", got: ${updatedMeta.status}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- PRD integrity check failure ---

test('jar-runner: skips task when PRD integrity check fails (hash mismatch)', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-bad-hash';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');

        // Write a PRD file
        const prdContent = '# My PRD\n\nThis is the original PRD content.\n';
        fs.writeFileSync(path.join(taskDir, 'prd.md'), prdContent);

        // Compute a WRONG hash (hash of different content)
        const wrongHash = crypto.createHash('sha256').update('totally different content').digest('hex');

        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,  // use tmpRoot as a valid path
            prd_hash: wrongHash,
        }, null, 2));

        // Create the session dir
        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 0,
        }, null, 2));

        const result = run(tmpRoot);
        assert.ok(
            result.stderr.includes('integrity check failed'),
            `Expected "integrity check failed" in stderr, got stderr: ${result.stderr}`
        );

        // Verify meta.json status was set to 'failed'
        const updatedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.equal(
            updatedMeta.status, 'failed',
            `Expected meta.status to be "failed", got: ${updatedMeta.status}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Missing session dir ---

test('jar-runner: skips task and sets status to failed when session dir is missing', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-no-session';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
        }, null, 2));

        // Intentionally do NOT create sessions/<taskId>/ dir

        const result = run(tmpRoot);
        assert.ok(
            result.stderr.includes('Session dir not found'),
            `Expected "Session dir not found" in stderr, got stderr: ${result.stderr}`
        );

        // Verify meta.json status was set to 'failed'
        const updatedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.equal(
            updatedMeta.status, 'failed',
            `Expected meta.status to be "failed", got: ${updatedMeta.status}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Settings type guard for default_manager_max_turns ---

test('jar-runner: ignores non-number default_manager_max_turns in settings (e.g., string)', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-bad-settings';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
        }, null, 2));

        // Write settings with a string value (should be ignored → default 50)
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_manager_max_turns: "fifty",
        }));

        // Create session dir with state.json
        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 0,
            working_dir: tmpRoot,
            session_dir: sessionDir,
        }, null, 2));

        const result = run(tmpRoot);
        // Should not crash — the string value should be ignored
        const combined = result.stdout + result.stderr;
        assert.ok(
            !combined.includes('TypeError'),
            `Should not have TypeError with string settings, got: ${combined.slice(0, 500)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('jar-runner: ignores zero or negative default_manager_max_turns in settings', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-zero-turns';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');
        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
        }, null, 2));

        // Write settings with zero value (should be ignored → default 50)
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_manager_max_turns: 0,
        }));

        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 0,
            working_dir: tmpRoot,
            session_dir: sessionDir,
        }, null, 2));

        const result = run(tmpRoot);
        const combined = result.stdout + result.stderr;
        // Should show MaxTurns: 50 (the default) since 0 is rejected
        assert.ok(
            combined.includes('50'),
            `Expected default max turns (50) when settings has 0, got: ${combined.slice(0, 500)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('jar-runner: ignores fractional default_manager_max_turns in settings', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-fractional-turns';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
        }, null, 2));

        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_manager_max_turns: 0.25,
        }));

        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 0,
            working_dir: tmpRoot,
            session_dir: sessionDir,
        }, null, 2));

        const result = run(tmpRoot);
        const combined = result.stdout + result.stderr;

        assert.match(combined, /MaxTurns[\s\S]*50/);
        assert.ok(!combined.includes('0.25'), `Fractional max turns leaked into spawn path: ${combined.slice(0, 500)}`);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('jar-runner: recovers newer dead-writer settings tmp before launching task', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-settings-tmp';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
        }, null, 2));

        const settingsPath = path.join(tmpRoot, 'pickle_settings.json');
        const tmpSettingsPath = `${settingsPath}.tmp.99999999`;
        fs.writeFileSync(settingsPath, JSON.stringify({
            default_manager_max_turns: 7,
            default_worker_timeout_seconds: 11,
        }));
        fs.writeFileSync(tmpSettingsPath, JSON.stringify({
            default_manager_max_turns: 19,
            default_worker_timeout_seconds: 23,
        }));
        const stale = new Date('2026-01-01T00:00:00.000Z');
        const newer = new Date('2026-01-01T00:00:01.000Z');
        fs.utimesSync(settingsPath, stale, stale);
        fs.utimesSync(tmpSettingsPath, newer, newer);

        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            backend: 'codex',
            step: 'prd',
            iteration: 0,
            working_dir: tmpRoot,
            session_dir: sessionDir,
        }, null, 2));

        const result = run(tmpRoot);
        const combined = result.stdout + result.stderr;

        assert.match(combined, /MaxTurns[\s\S]*19/);
        assert.match(combined, /Timeout[\s\S]*23s/);
        assert.equal(fs.existsSync(tmpSettingsPath), false);
        assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf-8')), {
            default_manager_max_turns: 19,
            default_worker_timeout_seconds: 23,
        });
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- PRD path traversal (deep review pass 6) ---

test('jar-runner: skips task when prd_path escapes task directory (path traversal)', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-traversal';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');

        // Write a PRD at the task dir level (legitimate)
        fs.writeFileSync(path.join(taskDir, 'prd.md'), '# Legit PRD\n');

        // But meta.json references a prd_path that escapes via ../
        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
            prd_path: '../../escaped.md',
            prd_hash: 'abc123',
        }, null, 2));

        // Create the session dir
        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 0,
        }, null, 2));

        const result = run(tmpRoot);

        // Should fail with path traversal rejection specifically
        const combined = result.stdout + result.stderr;
        assert.ok(
            combined.includes('escapes task directory'),
            `Expected "escapes task directory" in output, got stdout: ${result.stdout}, stderr: ${result.stderr}`
        );

        // Verify meta.json status was set to 'failed'
        const updatedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.equal(
            updatedMeta.status, 'failed',
            `Expected meta.status to be "failed", got: ${updatedMeta.status}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- PRD integrity passes with correct hash ---

test('jar-runner: does not skip task when PRD hash matches (integrity passes)', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-good-hash';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');

        // Write a PRD and compute the correct hash
        const prdContent = '# Good PRD\n\nThis content has a valid hash.\n';
        fs.writeFileSync(path.join(taskDir, 'prd.md'), prdContent);
        const correctHash = crypto.createHash('sha256').update(prdContent).digest('hex');

        fs.writeFileSync(metaPath, JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
            prd_hash: correctHash,
        }, null, 2));

        // Create the session dir (runTask will fail because claude isn't available,
        // but we should NOT see "integrity check failed")
        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: false,
            step: 'prd',
            iteration: 0,
        }, null, 2));

        const result = run(tmpRoot);
        // Should NOT contain integrity check failure
        assert.ok(
            !result.stderr.includes('integrity check failed'),
            `Should NOT see "integrity check failed" when hash matches, got stderr: ${result.stderr}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- runTask error isolation: corrupt state.json does not abort batch ---

test('jar-runner: corrupt session state.json does not abort remaining tasks', () => {
    const tmpRoot = makeTmpRoot();
    try {
        // Task 1: corrupt state.json — should fail gracefully
        const taskId1 = 'task-corrupt-state';
        const taskDir1 = path.join(tmpRoot, 'jar', '2026-01-01', taskId1);
        fs.mkdirSync(taskDir1, { recursive: true });
        fs.writeFileSync(path.join(taskDir1, 'meta.json'), JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
        }, null, 2));
        const sessionDir1 = path.join(tmpRoot, 'sessions', taskId1);
        fs.mkdirSync(sessionDir1, { recursive: true });
        fs.writeFileSync(path.join(sessionDir1, 'state.json'), '{{{corrupt');

        // Task 2: missing session dir — should also fail but prove batch continues
        const taskId2 = 'task-no-session';
        const taskDir2 = path.join(tmpRoot, 'jar', '2026-01-01', taskId2);
        fs.mkdirSync(taskDir2, { recursive: true });
        fs.writeFileSync(path.join(taskDir2, 'meta.json'), JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
        }, null, 2));
        // Intentionally no sessions/task-no-session/

        const result = run(tmpRoot);
        const combined = result.stdout + result.stderr;

        // Both tasks should have been processed (batch didn't abort after first failure)
        assert.ok(
            combined.includes(taskId1) && combined.includes(taskId2),
            `Expected both tasks to be mentioned in output, got: ${combined.slice(0, 1000)}`
        );
        // Should complete with summary
        assert.ok(
            combined.includes('Jar complete'),
            `Expected batch completion summary, got: ${combined.slice(0, 500)}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('jar-runner: SIGTERM shutdown preserves a newer orphan tmp session payload', async () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-recoverable-state';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
        }, null, 2));

        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        const statePath = path.join(sessionDir, 'state.json');
        // Snapshots must satisfy isRecoverableStateSnapshotCandidate.
        const baseFields = {
            schema_version: 1,
            backend: 'claude',
            working_dir: tmpRoot,
            session_dir: sessionDir,
            step: 'implement',
            max_iterations: 10,
            max_time_minutes: 60,
            worker_timeout_seconds: 120,
            start_time_epoch: Math.floor(Date.now() / 1000),
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
        };
        fs.writeFileSync(statePath, JSON.stringify({
            ...baseFields,
            active: false,
            iteration: 1,
            current_ticket: 'T-BASE',
            original_prompt: 'Base jar task state',
        }, null, 2));

        const fakeBin = path.join(tmpRoot, 'fake-bin');
        fs.mkdirSync(fakeBin, { recursive: true });
        const fakeClaude = path.join(fakeBin, 'claude');
        fs.writeFileSync(fakeClaude, '#!/bin/sh\n/bin/sleep 30\n');
        fs.chmodSync(fakeClaude, 0o755);

        const child = spawn(process.execPath, [JAR_RUNNER_BIN], {
            env: buildRunnerEnv(tmpRoot, { PATH: fakeBin }),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });

        await waitFor(() => {
            try {
                const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
                return state.active === true;
            } catch {
                return false;
            }
        });

        const activeState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(typeof activeState.pid, 'number', `Expected numeric pid stamp after task activation, got: ${JSON.stringify(activeState)}`);
        assert.ok(activeState.pid > 0, `Expected positive pid stamp after task activation, got: ${activeState.pid}`);

        const orphanTmpPath = `${statePath}.tmp.99999999`;
        fs.writeFileSync(orphanTmpPath, JSON.stringify({
            ...baseFields,
            active: true,
            iteration: 7,
            current_ticket: 'T-RECOVERED',
            original_prompt: 'Recovered jar task state',
        }, null, 2));

        child.kill('SIGTERM');
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error('jar-runner did not exit after SIGTERM'));
            }, 10000);
            child.on('exit', () => {
                clearTimeout(timer);
                resolve(undefined);
            });
            child.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

        const combined = stdout + stderr;
        const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.ok(
            combined.includes('Received SIGTERM'),
            `Expected shutdown log in output, got: ${combined.slice(0, 1000)}`
        );
        assert.equal(finalState.iteration, 7, 'shutdown must promote the newer orphan tmp before deactivation');
        assert.equal(finalState.current_ticket, 'T-RECOVERED', 'shutdown must preserve the recovered session payload');
        assert.equal(finalState.active, false, 'shutdown must deactivate the session');
        assert.equal(fs.existsSync(orphanTmpPath), false, 'orphan tmp should be consumed during shutdown recovery');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('jar-runner: recovers a newer orphan tmp state before bootstrapping a jarred task', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const taskId = 'task-bootstrap-recovery';
        const taskDir = path.join(tmpRoot, 'jar', '2026-01-01', taskId);
        fs.mkdirSync(taskDir, { recursive: true });
        const metaPath = path.join(taskDir, 'meta.json');
        fs.writeFileSync(path.join(taskDir, 'meta.json'), JSON.stringify({
            status: 'marinating',
            repo_path: tmpRoot,
        }, null, 2));

        const sessionDir = path.join(tmpRoot, 'sessions', taskId);
        fs.mkdirSync(sessionDir, { recursive: true });
        const statePath = path.join(sessionDir, 'state.json');
        fs.writeFileSync(statePath, '{broken json');
        const orphanTmpPath = `${statePath}.tmp.99999999`;
        // Snapshot must satisfy isRecoverableStateSnapshotCandidate so the
        // corrupt-base recovery path will promote it.
        fs.writeFileSync(orphanTmpPath, JSON.stringify({
            schema_version: 1,
            active: false,
            backend: 'claude',
            working_dir: tmpRoot,
            session_dir: sessionDir,
            step: 'implement',
            iteration: 7,
            max_iterations: 10,
            max_time_minutes: 60,
            worker_timeout_seconds: 10,
            start_time_epoch: Math.floor(Date.now() / 1000),
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
            current_ticket: 'T-RECOVERED',
            original_prompt: 'Recovered jar task state',
        }, null, 2));

        const fakeBin = path.join(tmpRoot, 'fake-bin');
        fs.mkdirSync(fakeBin, { recursive: true });
        const fakeClaude = path.join(fakeBin, 'claude');
        fs.writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n');
        fs.chmodSync(fakeClaude, 0o755);

        const result = spawnSync(process.execPath, [JAR_RUNNER_BIN], {
            env: buildRunnerEnv(tmpRoot, { PATH: fakeBin }),
            encoding: 'utf-8',
            timeout: 30000,
        });

        const combined = `${result.stdout}\n${result.stderr}`;
        assert.equal(result.status, 0, `expected clean exit, got output:\n${combined}`);
        assert.match(combined, new RegExp(`Task ${taskId} complete`), `expected recovered task to complete, got output:\n${combined}`);
        assert.doesNotMatch(combined, /Failed to read state\.json/, `bootstrap should recover the orphan tmp before task load, got output:\n${combined}`);

        const updatedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.equal(updatedMeta.status, 'consumed', 'recovered task should be marked consumed after successful run');

        const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(finalState.active, false, 'completed task should be deactivated');
        // finalizeTerminalState invariants on successful jar task: step='completed',
        // current_ticket cleared, exit_reason='success'. Iteration is reconciled by
        // the task itself via mux-runner's runnerIteration; we only assert the
        // recovered tmp was promoted at bootstrap (iteration > 0 from recovery).
        assert.equal(finalState.step, 'completed', 'task success must advance step to completed');
        assert.equal(finalState.current_ticket, null, 'task success must clear current_ticket');
        assert.equal(finalState.exit_reason, 'success', 'task success exit_reason');
        assert.equal(finalState.original_prompt, 'Recovered jar task state', 'recovered tmp original_prompt must survive');
        assert.equal(fs.existsSync(orphanTmpPath), false, 'recovered tmp should be consumed during task bootstrap');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// --- Notification logic (buildJarNotification) ---

test('buildJarNotification: all succeeded shows "Complete"', () => {
    const n = buildJarNotification(3, 0);
    assert.equal(n.title, '🥒 Pickle Run Complete');
    assert.equal(n.body, '3 tasks completed');
    assert.equal(n.subtitle, 'Pickle Jar');
});

test('buildJarNotification: single task uses singular "task"', () => {
    const n = buildJarNotification(1, 0);
    assert.equal(n.body, '1 task completed');
});

test('buildJarNotification: mixed results shows "Complete" with counts', () => {
    const n = buildJarNotification(2, 1);
    assert.equal(n.title, '🥒 Pickle Run Complete');
    assert.equal(n.body, '2 succeeded, 1 failed');
});

test('buildJarNotification: all failed shows "Failed"', () => {
    const n = buildJarNotification(0, 3);
    assert.equal(n.title, '🥒 Pickle Jar Failed');
    assert.equal(n.body, '0 succeeded, 3 failed');
});

// --- loadJarTaskTimeout ---

test('loadJarTaskTimeout: uses worker_timeout_seconds from state when set', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const timeout = loadJarTaskTimeout(tmpRoot, {
            active: true, working_dir: '/tmp', step: 'prd', iteration: 0,
            max_iterations: 10, max_time_minutes: 60, worker_timeout_seconds: 900,
            start_time_epoch: 0, completion_promise: null, original_prompt: '',
            current_ticket: null, history: [], started_at: '', session_dir: '',
        });
        assert.equal(timeout, 900);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('loadJarTaskTimeout: falls back to settings when state has no timeout', () => {
    const tmpRoot = makeTmpRoot();
    try {
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_worker_timeout_seconds: 600,
        }));
        const timeout = loadJarTaskTimeout(tmpRoot, {
            active: true, working_dir: '/tmp', step: 'prd', iteration: 0,
            max_iterations: 10, max_time_minutes: 60, worker_timeout_seconds: 0,
            start_time_epoch: 0, completion_promise: null, original_prompt: '',
            current_ticket: null, history: [], started_at: '', session_dir: '',
        });
        assert.equal(timeout, 600);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('loadJarTaskTimeout: returns default 1200 when no state or settings timeout', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const timeout = loadJarTaskTimeout(tmpRoot, {
            active: true, working_dir: '/tmp', step: 'prd', iteration: 0,
            max_iterations: 10, max_time_minutes: 60, worker_timeout_seconds: 0,
            start_time_epoch: 0, completion_promise: null, original_prompt: '',
            current_ticket: null, history: [], started_at: '', session_dir: '',
        });
        assert.equal(timeout, 1200);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('loadJarTaskTimeout: ignores NaN state timeout and uses settings', () => {
    const tmpRoot = makeTmpRoot();
    try {
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_worker_timeout_seconds: 500,
        }));
        // Cast to bypass TS — simulate corrupt state with NaN-coercing value
        const state = {
            active: true, working_dir: '/tmp', step: 'prd', iteration: 0,
            max_iterations: 10, max_time_minutes: 60, worker_timeout_seconds: NaN,
            start_time_epoch: 0, completion_promise: null, original_prompt: '',
            current_ticket: null, history: [], started_at: '', session_dir: '',
        };
        const timeout = loadJarTaskTimeout(tmpRoot, state);
        assert.equal(timeout, 500);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('loadJarTaskTimeout: ignores fractional state timeout and uses settings', () => {
    const tmpRoot = makeTmpRoot();
    try {
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_worker_timeout_seconds: 500,
        }));
        const timeout = loadJarTaskTimeout(tmpRoot, {
            active: true, working_dir: '/tmp', step: 'prd', iteration: 0,
            max_iterations: 10, max_time_minutes: 60, worker_timeout_seconds: 0.25,
            start_time_epoch: 0, completion_promise: null, original_prompt: '',
            current_ticket: null, history: [], started_at: '', session_dir: '',
        });
        assert.equal(timeout, 500);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('loadJarTaskTimeout: ignores fractional settings timeout and uses default', () => {
    const tmpRoot = makeTmpRoot();
    try {
        fs.writeFileSync(path.join(tmpRoot, 'pickle_settings.json'), JSON.stringify({
            default_worker_timeout_seconds: 0.25,
        }));
        const timeout = loadJarTaskTimeout(tmpRoot, {
            active: true, working_dir: '/tmp', step: 'prd', iteration: 0,
            max_iterations: 10, max_time_minutes: 60, worker_timeout_seconds: 0,
            start_time_epoch: 0, completion_promise: null, original_prompt: '',
            current_ticket: null, history: [], started_at: '', session_dir: '',
        });
        assert.equal(timeout, 1200);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('loadJarTaskTimeout: ignores negative state timeout', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const timeout = loadJarTaskTimeout(tmpRoot, {
            active: true, working_dir: '/tmp', step: 'prd', iteration: 0,
            max_iterations: 10, max_time_minutes: 60, worker_timeout_seconds: -100,
            start_time_epoch: 0, completion_promise: null, original_prompt: '',
            current_ticket: null, history: [], started_at: '', session_dir: '',
        });
        assert.equal(timeout, 1200);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
