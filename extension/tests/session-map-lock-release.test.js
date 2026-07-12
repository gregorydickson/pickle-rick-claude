// @tier: fast
//
// The session-map lock guards the SHARED current_sessions.json, but a collision is
// per-cwd. So a lock stranded by one cwd's collision denies every OTHER cwd: the
// contender burns its full 10-retry backoff (~26s) before stealStaleLock's 30s window
// opens, takes a LockError, and setup.ts:1749 swallows it — the session is created but
// never registered in the map that resolve-state.ts uses to find a session by cwd.
//
// The bug: updateSessionMap's collision branch called process.exit(1) from INSIDE the
// withRetryLock callback. Release lives in a `finally` (pickle-utils.ts tryRunWithExclusiveLock),
// and process.exit skips finally blocks — so the lockfile survived, holding a dead pid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../bin/setup.js');

// A hang-guard, not a perf assertion — the collision path exits immediately.
const SPAWN_TIMEOUT_MS = 60_000;

function makeSandbox() {
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-maplock-data-')));
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-maplock-cwd-')));
    return { dataRoot, cwd };
}

function runSetup(args, { dataRoot, cwd }) {
    return execFileSync(process.execPath, [SETUP, ...args], {
        encoding: 'utf-8',
        cwd,
        timeout: SPAWN_TIMEOUT_MS,
        env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
    });
}

function lockPath(dataRoot) {
    return path.join(dataRoot, 'current_sessions.json.lock');
}

function readMap(dataRoot) {
    return JSON.parse(fs.readFileSync(path.join(dataRoot, 'current_sessions.json'), 'utf-8'));
}

// Hands the cwd's map slot to a live holder that is NOT the setup child, so the next
// setup in that cwd takes the collision branch. process.pid (the test runner) is alive
// by definition and its sessionPath differs from whatever the child would claim.
function handSlotToLiveHolder(dataRoot) {
    const mapFile = path.join(dataRoot, 'current_sessions.json');
    const map = JSON.parse(fs.readFileSync(mapFile, 'utf-8'));
    const cwdKey = Object.keys(map)[0];
    map[cwdKey] = { sessionPath: map[cwdKey].sessionPath, pid: process.pid };
    fs.writeFileSync(mapFile, JSON.stringify(map, null, 2));
    return { cwdKey, held: map[cwdKey] };
}

test('a blocked session-map collision releases the lock instead of stranding it', () => {
    const box = makeSandbox();
    try {
        runSetup(['--tmux', '--task', 'first'], box);
        const { held } = handSlotToLiveHolder(box.dataRoot);

        let stderr = '';
        let exitCode = 0;
        try {
            runSetup(['--tmux', '--task', 'second'], box);
        } catch (err) {
            exitCode = err.status;
            stderr = typeof err.stderr === 'string' ? err.stderr : '';
        }

        // Preserved behavior: the collision is still refused, loudly, with exit 1.
        assert.equal(exitCode, 1, 'a live holder of the cwd slot must still block the second session');
        assert.match(stderr, /session-map collision blocked/);

        // The regression: process.exit(1) from inside the lock callback skipped the
        // `finally` that unlinks the lockfile, stranding it with a now-dead pid.
        assert.equal(
            fs.existsSync(lockPath(box.dataRoot)),
            false,
            'the collision exit must not strand current_sessions.json.lock — a stranded lock denies every other cwd sharing this map',
        );

        // And the refusal must not have clobbered the incumbent's entry.
        const after = readMap(box.dataRoot);
        assert.deepEqual(Object.values(after)[0], held, 'a blocked collision must leave the incumbent map entry intact');
    } finally {
        fs.rmSync(box.dataRoot, { recursive: true, force: true });
        fs.rmSync(box.cwd, { recursive: true, force: true });
    }
});

test('a session-map write releases the lock on the success path too', () => {
    const box = makeSandbox();
    try {
        runSetup(['--tmux', '--task', 'only'], box);
        assert.equal(
            fs.existsSync(lockPath(box.dataRoot)),
            false,
            'the normal (non-collision) map write must leave no lockfile behind',
        );
    } finally {
        fs.rmSync(box.dataRoot, { recursive: true, force: true });
        fs.rmSync(box.cwd, { recursive: true, force: true });
    }
});
