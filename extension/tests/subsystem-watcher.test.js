// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUBSYSTEM_WATCHER_SRC = path.resolve(__dirname, '../src/bin/subsystem-watcher.ts');
const SUBSYSTEM_WATCHER_BIN = path.resolve(__dirname, '../bin/subsystem-watcher.js');

function run(args, { timeout = 10000 } = {}) {
    return spawnSync(process.execPath, [SUBSYSTEM_WATCHER_BIN, ...args], {
        env: { ...process.env },
        encoding: 'utf-8',
        timeout,
    });
}

function makeSessionDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-subsystem-watcher-')));
}

function writeState(sessionDir, overrides = {}) {
    const state = { active: false, pid: process.pid, step: 'implement', iteration: 1, ...overrides };
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state, null, 2));
}

function writeMicroverse(sessionDir, data) {
    fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify(data, null, 2));
}

// AC-1: Source file exists at canonical path
test('subsystem-watcher: source file exists at canonical path', () => {
    assert.ok(fs.existsSync(SUBSYSTEM_WATCHER_SRC), `Missing: ${SUBSYSTEM_WATCHER_SRC}`);
});

// AC-1 (compiled): compiled JS exists after build
test('subsystem-watcher: compiled JS exists at bin path', () => {
    assert.ok(fs.existsSync(SUBSYSTEM_WATCHER_BIN), `Missing compiled JS: ${SUBSYSTEM_WATCHER_BIN}`);
});

// Startup validation
test('subsystem-watcher: no args → exit 1, stderr includes Usage', () => {
    const result = run([]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), `stderr should include Usage, got: ${result.stderr}`);
});

test('subsystem-watcher: non-existent session dir → exit 1, stderr includes Usage', () => {
    const result = run(['/tmp/definitely-does-not-exist-subsystem-' + Date.now()]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), `stderr: ${result.stderr}`);
});

// AC-3: Emits ▸ <name> when current_subsystem is set
test('subsystem-watcher: emits ▸ <subsystem-name> when current_subsystem present', () => {
    const sessionDir = makeSessionDir();
    try {
        writeState(sessionDir, { active: false });
        writeMicroverse(sessionDir, {
            status: 'iterating',
            current_subsystem: 'auth-service',
        });
        const result = run([sessionDir]);
        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Watcher hung: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
        assert.ok(result.stdout.includes('▸ auth-service'), `Expected ▸ auth-service in stdout, got: ${result.stdout}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// AC-4: Emits ▸ idle when current_subsystem is null
test('subsystem-watcher: emits ▸ idle when current_subsystem is null', () => {
    const sessionDir = makeSessionDir();
    try {
        writeState(sessionDir, { active: false });
        writeMicroverse(sessionDir, { status: 'iterating', current_subsystem: null });
        const result = run([sessionDir]);
        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Watcher hung: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
        assert.ok(result.stdout.includes('▸ idle'), `Expected ▸ idle in stdout, got: ${result.stdout}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// AC-4: Emits ▸ idle when current_subsystem field is absent entirely
test('subsystem-watcher: emits ▸ idle when current_subsystem is absent', () => {
    const sessionDir = makeSessionDir();
    try {
        writeState(sessionDir, { active: false });
        writeMicroverse(sessionDir, { status: 'iterating' });
        const result = run([sessionDir]);
        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Watcher hung: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
        assert.ok(result.stdout.includes('▸ idle'), `Expected ▸ idle, got: ${result.stdout}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// AC-5: Missing microverse.json → no output, no crash
test('subsystem-watcher: no microverse.json → no output, clean exit', () => {
    const sessionDir = makeSessionDir();
    try {
        writeState(sessionDir, { active: false });
        // Do NOT write microverse.json
        const result = run([sessionDir]);
        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Watcher hung: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
        assert.equal(result.stdout.trim(), '', `Expected no output, got: ${result.stdout}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// AC-6: Liveness-driven exit — dead-pid active session terminates
test('subsystem-watcher: dead-pid active session terminates via recovered state', () => {
    const sessionDir = makeSessionDir();
    try {
        // Dead pid 999999 + active:true → StateManager.read demotes to inactive → watcher exits
        writeState(sessionDir, { active: true, pid: 999999 });
        writeMicroverse(sessionDir, { status: 'iterating', current_subsystem: 'api' });
        const result = spawnSync(process.execPath, [SUBSYSTEM_WATCHER_BIN, sessionDir], {
            env: { ...process.env },
            encoding: 'utf-8',
            timeout: 8000,
        });
        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Watcher hung instead of terminating: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected clean exit, got stderr: ${result.stderr}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// AC-7: Truncation-resilience uses detectLogTruncation (source inspection)
test('subsystem-watcher: source uses detectLogTruncation from pickle-utils', () => {
    const source = fs.readFileSync(SUBSYSTEM_WATCHER_SRC, 'utf-8');
    assert.ok(source.includes('detectLogTruncation'), 'source must import detectLogTruncation');
    assert.ok(source.includes('pickle-utils'), 'must import from pickle-utils');
    assert.ok(source.includes('trunc.truncated'), 'must check truncated flag');
});

// AC-2: readRecoverableJsonObject is used (source inspection)
test('subsystem-watcher: source uses readRecoverableJsonObject', () => {
    const source = fs.readFileSync(SUBSYSTEM_WATCHER_SRC, 'utf-8');
    assert.ok(source.includes('readRecoverableJsonObject'), 'source must use readRecoverableJsonObject');
    assert.ok(source.includes('recoverable-json'), 'must import from recoverable-json');
});

// Emits only on change (not on every tick)
test('subsystem-watcher: does not re-emit unchanged subsystem', () => {
    const sessionDir = makeSessionDir();
    try {
        writeState(sessionDir, { active: false });
        writeMicroverse(sessionDir, { status: 'iterating', current_subsystem: 'payments' });
        const result = run([sessionDir]);
        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Watcher hung: ${result.stderr}`);
        // Should emit exactly one line for this subsystem
        const lines = result.stdout.split('\n').filter(l => l.startsWith('▸'));
        assert.equal(lines.length, 1, `Expected 1 pointer line, got: ${lines.length} — ${result.stdout}`);
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

// B-LANES WS-3 (C6): concurrent lanes are sibling sessions `<session>--lane-<n>`.
function makeLaneRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-subsystem-lanes-')));
}

function writeLane(root, session, index, { name, iteration = 0, active = true, exitReason } = {}) {
    const laneDir = path.join(root, `${session}--lane-${index}`);
    fs.mkdirSync(laneDir, { recursive: true });
    const state = { active, pid: process.pid, step: 'implement', iteration };
    if (exitReason) state.exit_reason = exitReason;
    fs.writeFileSync(path.join(laneDir, 'state.json'), JSON.stringify(state));
    if (name) {
        fs.writeFileSync(path.join(laneDir, 'anatomy-park.json'), JSON.stringify({ lanes: [{ name, dir: name, excludes: [] }] }));
    }
}

function pointerLines(stdout) {
    return stdout.split('\n').filter(l => l.startsWith('▸'));
}

test('subsystem-watcher: 3-lane session renders one line per lane with name, pass count and status', () => {
    const root = makeLaneRoot();
    try {
        const sessionDir = path.join(root, 'sess');
        fs.mkdirSync(sessionDir);
        writeState(sessionDir, { active: false });
        writeMicroverse(sessionDir, { status: 'iterating', current_subsystem: 'parent-only' });
        writeLane(root, 'sess', 1, { name: 'extension/src/bin', iteration: 4 });
        writeLane(root, 'sess', 2, { name: 'extension/src/services', iteration: 7 });
        writeLane(root, 'sess', 3, { name: 'extension/tests/.', iteration: 2, active: false, exitReason: 'converged' });
        const result = run([sessionDir]);
        assert.notEqual(result.error?.code, 'ETIMEDOUT', `Watcher hung: ${result.stderr}`);
        assert.equal(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
        const lines = pointerLines(result.stdout);
        assert.equal(lines.length, 3, `Expected 3 lane lines, got: ${result.stdout}`);
        assert.match(lines[0], /extension\/src\/bin.*4.*running/);
        assert.match(lines[1], /extension\/src\/services.*7.*running/);
        assert.match(lines[2], /extension\/tests\/\..*2.*converged/);
        assert.ok(!result.stdout.includes('parent-only'), `Lane view must replace the single-subsystem line: ${result.stdout}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('subsystem-watcher: lanes order numerically and a lane with no state yet renders as starting', () => {
    const root = makeLaneRoot();
    try {
        const sessionDir = path.join(root, 'sess');
        fs.mkdirSync(sessionDir);
        writeState(sessionDir, { active: false });
        for (const i of [10, 2]) writeLane(root, 'sess', i, { name: `lane-name-${i}` });
        fs.mkdirSync(path.join(root, 'sess--lane-3'));
        const result = run([sessionDir]);
        const lines = pointerLines(result.stdout);
        assert.equal(lines.length, 3, `got: ${result.stdout}`);
        assert.match(lines[0], /lane-name-2/);
        assert.match(lines[1], /lane-3.*starting/);
        assert.match(lines[2], /lane-name-10/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('subsystem-watcher: a sibling lane of another session is not listed', () => {
    const root = makeLaneRoot();
    try {
        const sessionDir = path.join(root, 'sess');
        fs.mkdirSync(sessionDir);
        writeState(sessionDir, { active: false });
        writeLane(root, 'sess', 1, { name: 'mine-a' });
        writeLane(root, 'sess', 2, { name: 'mine-b' });
        writeLane(root, 'sess-other', 1, { name: 'theirs' });
        writeLane(root, 'other-sess', 1, { name: 'theirs-too' });
        const result = run([sessionDir]);
        const lines = pointerLines(result.stdout);
        assert.equal(lines.length, 2, `got: ${result.stdout}`);
        assert.ok(!/theirs/.test(result.stdout), result.stdout);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('subsystem-watcher: a 1-lane session renders exactly today\'s single-subsystem output', () => {
    const root = makeLaneRoot();
    try {
        const sessionDir = path.join(root, 'sess');
        fs.mkdirSync(sessionDir);
        writeState(sessionDir, { active: false });
        writeMicroverse(sessionDir, { status: 'iterating', current_subsystem: 'auth-service' });
        writeLane(root, 'sess', 1, { name: 'auth-service', iteration: 3 });
        const result = run([sessionDir]);
        assert.equal(result.status, 0, `stderr: ${result.stderr}`);
        assert.equal(result.stdout, '▸ auth-service\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('subsystem-watcher: lane view renders without a parent microverse.json', () => {
    const root = makeLaneRoot();
    try {
        const sessionDir = path.join(root, 'sess');
        fs.mkdirSync(sessionDir);
        writeState(sessionDir, { active: false });
        writeLane(root, 'sess', 1, { name: 'a' });
        writeLane(root, 'sess', 2, { name: 'b' });
        const result = run([sessionDir]);
        assert.equal(pointerLines(result.stdout).length, 2, `got: ${result.stdout}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
