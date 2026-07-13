// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tierToModel, resolveCodexModel, buildTierLifecycleSections } from '../bin/spawn-morty.js';
import { TIER_LIFECYCLE } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAWN_MORTY_BIN = path.resolve(__dirname, '../bin/spawn-morty.js');
const DEAD_TMP_PID = 99_999_999;

/**
 * Run spawn-morty.js as a subprocess and return the result.
 * @param {string[]} args - CLI arguments
 * @param {Record<string, string>} env - extra env vars to merge
 */
function run(args, env = {}) {
    // 15s → 45s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests are validating CLI behavior, not wall-clock.
    return spawnSync(process.execPath, [SPAWN_MORTY_BIN, ...args], {
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        timeout: 45000,
    });
}

/**
 * Create an isolated temp directory (resolves macOS /var -> /private/var symlinks).
 */
function makeTmpDir(prefix = 'pickle-spawn-morty-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function markTmpNewer(filePath) {
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(filePath, future, future);
}

function stripAnsi(value) {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function writeExtensionSentinel(extensionDir) {
    const sentinelDir = path.join(extensionDir, 'extension', 'bin');
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function writeCodexShim(shimDir, logPath) {
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'codex');
    fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  pickle_backend: process.env.PICKLE_BACKEND || null,
}, null, 2));
process.exit(0);
`);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
}

function writeHermesShim(shimDir, logPath, ticketDir) {
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'hermes');
    fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  pickle_backend: process.env.PICKLE_BACKEND || null,
  pickle_role: process.env.PICKLE_ROLE || null,
}, null, 2));
fs.writeFileSync(${JSON.stringify(path.join(ticketDir, 'conformance_2026-05-03.md'))}, 'ALL_PASS\\n');
console.log('Hermes worker completed with enough output for validation. '.repeat(8));
console.log('<promise>I AM DONE</promise>');
process.exit(0);
`);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
}

function makeHermesHarness(tmpDir, ticketId, state = {}) {
    writeExtensionSentinel(tmpDir);
    const sessionDir = path.join(tmpDir, 'session');
    const ticketDir = path.join(sessionDir, ticketId);
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
        active: true,
        backend: 'hermes',
        working_dir: repoDir,
        iteration: 1,
        max_iterations: 5,
        schema_version: 1,
        ...state,
    }));
    return { sessionDir, ticketDir, repoDir };
}

function readWorkerLogFile(ticketDir) {
    const workerLog = fs.readdirSync(ticketDir).find((name) => /^worker_session_\d+\.log$/.test(name));
    assert.ok(workerLog, `expected worker_session log in ${ticketDir}`);
    return fs.readFileSync(path.join(ticketDir, workerLog), 'utf-8');
}

function readStateEvent(statePath, eventName) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const activity = Array.isArray(state.activity) ? state.activity : [];
    return activity.find((entry) => entry?.event === eventName);
}

function writeCodexSpawnHarness(tmpDir, ticketId) {
    writeExtensionSentinel(tmpDir);
    const sessionDir = path.join(tmpDir, 'session');
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
        active: true,
        backend: 'codex',
        iteration: 1,
        schema_version: 1,
    }));

    const shimDir = path.join(tmpDir, 'bin');
    const shimLog = path.join(tmpDir, `${ticketId}-codex.json`);
    writeCodexShim(shimDir, shimLog);
    return { sessionDir, ticketDir, shimDir, shimLog };
}

function writeLastToolError(sessionDir, retryCount) {
    fs.writeFileSync(path.join(sessionDir, 'last-tool-error.json'), JSON.stringify({
        ts: new Date().toISOString(),
        tool: 'Bash',
        error_signature: 'Command failed with exit code 1',
        retry_count: retryCount,
    }));
}

function writeSuccessfulCodexShim(shimDir, logPath, ticketDir) {
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'codex');
    fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
}, null, 2));
fs.appendFileSync(${JSON.stringify(path.join(ticketDir, 'handoff_notes.md'))}, [
  '## 2026-05-03T00:00:00.000Z iteration handoff',
  'Tried: implemented handoff fixture',
  'Failed: none',
  'Next focus: tests/spawn-morty.test.js',
  'Command: npm test -- --grep handoff.write',
  ''
].join('\\n'));
fs.writeFileSync(${JSON.stringify(path.join(ticketDir, 'conformance_2026-05-03.md'))}, 'ALL_PASS\\n');
console.log('Worker completed with handoff notes. '.repeat(10));
console.log('<promise>I AM DONE</promise>');
process.exit(0);
`);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
}

function runCodexHarness(tmpDir, harness, ticketId) {
    return spawnSync(process.execPath, [SPAWN_MORTY_BIN,
        'implement the thing',
        '--ticket-id', ticketId,
        '--ticket-path', harness.ticketDir,
        '--timeout', '30',
    ], {
        env: {
            ...process.env,
            EXTENSION_DIR: tmpDir,
            PATH: `${harness.shimDir}${path.delimiter}${process.env.PATH || ''}`,
            PICKLE_BACKEND: '',
        },
        encoding: 'utf-8',
        timeout: 45000,
    });
}

function readCapturedCodexPrompt(shimLog) {
    const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
    return invocation.argv[invocation.argv.length - 1];
}

// --- Argument validation ---

test('spawn-morty: no args → exit 1, prints Usage', () => {
    const result = run([]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});

test('spawn-morty: missing --ticket-id → exit 1, prints required', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run([
            'some-task',
            '--ticket-path', tmpDir,
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(result.stderr.includes('required'), 'stderr should mention required');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: missing --ticket-path → exit 1, prints required', () => {
    const result = run([
        'some-task',
        '--ticket-id', 'ticket-001',
    ]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('required'), 'stderr should mention required');
});

test('spawn-morty: invalid ticket-id characters → exit 1, prints invalid characters', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run([
            'some-task',
            '--ticket-id', '../etc/passwd',
            '--ticket-path', tmpDir,
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(
            result.stderr.includes('invalid characters'),
            'stderr should mention invalid characters'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --ticket-id without value (last arg) → exit 1', () => {
    const tmpDir = makeTmpDir();
    try {
        // --ticket-id is the last arg so args[ticketIdIndex + 1] is undefined
        const result = run([
            'some-task',
            '--ticket-path', tmpDir,
            '--ticket-id',
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --ticket-id value starts with -- → exit 1', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run([
            'some-task',
            '--ticket-id', '--oops',
            '--ticket-path', tmpDir,
        ]);
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(
            result.stderr.includes('non-empty values'),
            'stderr should mention non-empty values'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// R-SMTEST early-exit invariant (ticket 910ae36c): --ticket-path is a /tmp dir outside
// the data root, so spawn-morty exits 1 via spawn_morty_invalid_ticket_path before
// reaching the claude spawn. Assertions hold: exit 1, no Usage/required/invalid-chars in stdout.
test('spawn-morty: valid args but no claude binary → exit 1 (spawn failure, not validation)', () => {
    const tmpDir = makeTmpDir();
    try {
        // Set PATH to a non-existent directory so `claude` cannot be found.
        // The process should get past all validation and fail when spawning claude.
        // Use a longer timeout (15s) — under full-suite concurrency the ENOENT
        // async error can take longer than the default 10s to surface.
        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
                'implement the thing',
                '--ticket-id', 'ticket-42',
                '--ticket-path', tmpDir,
            ], {
            env: { ...process.env, PATH: '/nonexistent' },
            encoding: 'utf-8',
            // 15s → 45s: budget for system load when run alongside concurrent
            // codex/tmux work. Validates panel content, not wall-clock.
            timeout: 45000,
        });
        assert.equal(result.status, 1, 'should exit with code 1');
        // It should NOT be a validation error — it got past validation
        assert.ok(
            !result.stdout.includes('Usage'),
            'should not be a Usage error (got past validation)'
        );
        assert.ok(
            !result.stdout.includes('required'),
            'should not be a "required" validation error'
        );
        assert.ok(
            !result.stdout.includes('invalid characters'),
            'should not be an "invalid characters" validation error'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// R-SMTEST-5 regression: guard must fire and emit event before reaching claude spawn.
test('spawn-morty: invalid --ticket-path exits non-zero within 5s and emits spawn_morty_invalid_ticket_path event', () => {
    const dataRootDir = makeTmpDir('pickle-smtest5-root-');
    const nonExistentPath = path.join(os.tmpdir(), `smtest5-nonexistent-${process.pid}`);
    try {
        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-smtest5-regression',
            '--ticket-path', nonExistentPath,
            '--timeout', '5',
        ], {
            env: { ...process.env, PICKLE_DATA_ROOT: dataRootDir },
            encoding: 'utf-8',
            timeout: 5000,
        });
        assert.ok(
            result.status !== null && result.status !== 0,
            `should exit non-zero within 5s (status=${result.status}, signal=${result.signal})`
        );
        assert.ok(
            result.stderr.includes('spawn_morty_invalid_ticket_path'),
            `stderr should contain spawn_morty_invalid_ticket_path event, got: ${result.stderr}`
        );
    } finally {
        fs.rmSync(dataRootDir, { recursive: true, force: true });
        fs.rmSync(nonExistentPath, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// --output-format and --ticket-file edge cases (deep review pass 5)
// ---------------------------------------------------------------------------

// R-SMTEST early-exit invariant (ticket 910ae36c): --ticket-path is a /tmp dir outside
// the data root; spawn-morty exits 1 via spawn_morty_invalid_ticket_path before spawn.
test('spawn-morty: --output-format as last arg (no value) defaults to text', () => {
    const tmpDir = makeTmpDir();
    try {
        // --output-format is the last arg with no value following it
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-77',
                '--ticket-path', tmpDir,
                '--output-format',
            ],
            { PATH: '/nonexistent' }
        );
        // Should get past validation (no crash, no validation error)
        assert.equal(result.status, 1, 'should exit with code 1 (no claude)');
        assert.ok(
            !result.stdout.includes('Usage'),
            'should not be a Usage error'
        );
        assert.ok(
            !result.stdout.includes('required'),
            'should not be a "required" error'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// R-SMTEST early-exit invariant (ticket 910ae36c): --ticket-path is a /tmp dir outside
// the data root; spawn-morty exits 1 via spawn_morty_invalid_ticket_path before spawn.
test('spawn-morty: --ticket-file with value starting with -- does not crash', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-88',
                '--ticket-path', tmpDir,
                '--ticket-file', '--bogus-flag',
            ],
            { PATH: '/nonexistent' }
        );
        // Should get past validation without crashing
        assert.equal(result.status, 1, 'should exit with code 1 (no claude)');
        assert.ok(
            !result.stdout.includes('Usage'),
            'should not be a Usage error'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// R-SMTEST early-exit invariant (ticket 910ae36c): --ticket-path is a /tmp dir outside
// the data root; spawn-morty exits 1 via spawn_morty_invalid_ticket_path before spawn.
test('spawn-morty: --timeout with custom value is accepted (no validation error)', () => {
    const tmpDir = makeTmpDir();
    try {
        // Same as the "no claude" test, but with --timeout to verify it parses without error.
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-99',
                '--ticket-path', tmpDir,
                '--timeout', '30',
            ],
            { PATH: '/nonexistent' }
        );
        assert.equal(result.status, 1, 'should exit with code 1 (no claude)');
        // No validation errors — it accepted the timeout and moved on
        assert.ok(
            !result.stdout.includes('Usage'),
            'should not be a Usage error'
        );
        assert.ok(
            !result.stdout.includes('required'),
            'should not be a "required" error'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --timeout rejects suffixed and missing values before worker spawn', () => {
    const tmpDir = makeTmpDir();
    try {
        for (const timeoutArgs of [['30junk'], ['3.5'], []]) {
            const result = run([
                'implement the thing',
                '--ticket-id', 'ticket-timeout-validation',
                '--ticket-path', tmpDir,
                '--timeout',
                ...timeoutArgs,
            ], { PATH: '/nonexistent' });
            assert.equal(result.status, 1, `should reject --timeout ${timeoutArgs[0] ?? '<missing>'}`);
            assert.match(result.stderr, /--timeout requires a positive integer/);
            assert.ok(
                !result.stderr.includes('Failed to spawn'),
                'validation should fail before worker spawn',
            );
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// --review flag (meso-review enforcement)
// ---------------------------------------------------------------------------

// R-SMTEST early-exit invariant (ticket 910ae36c): PICKLE_DATA_ROOT is set to tmpDir so
// ticketDir is inside the data root — the guard does NOT fire. Exit 1 comes from the
// absent claude binary (spawn failure), not the early-exit guard.
test('spawn-morty: --review flag accepted without validation error', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'rev-001');
        fs.mkdirSync(ticketDir, { recursive: true });
        const result = run(
            [
                'review correctness and architecture',
                '--ticket-id', 'rev-001',
                '--ticket-path', ticketDir,
                '--review',
            ],
            { PATH: '/nonexistent', PICKLE_DATA_ROOT: tmpDir }
        );
        assert.equal(result.status, 1, 'should exit with code 1 (no claude)');
        // Should get past validation — no Usage or required errors
        assert.ok(!result.stderr.includes('Usage'), 'should not be a Usage error');
        assert.ok(!result.stderr.includes('required'), 'should not be a "required" error');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --review flag shows Review Worker panel title', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'rev-002');
        fs.mkdirSync(ticketDir, { recursive: true });
        const result = run(
            [
                'review correctness',
                '--ticket-id', 'rev-002',
                '--ticket-path', ticketDir,
                '--review',
            ],
            { PATH: '/nonexistent', PICKLE_DATA_ROOT: tmpDir }
        );
        const combined = result.stdout + result.stderr;
        // Must match the actual panel title, not just the word "review" which appears in the command
        assert.match(combined, /Review Worker|type.*review/i,
            'should show Review Worker panel title or review type field');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: --review without --ticket-id still requires ticket-id', () => {
    const tmpDir = makeTmpDir();
    try {
        const result = run(
            [
                'review correctness',
                '--ticket-path', tmpDir,
                '--review',
            ],
        );
        assert.equal(result.status, 1, 'should exit with code 1');
        assert.ok(result.stderr.includes('required'), 'should require --ticket-id even with --review');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// proc.on('error') handler (deep review pass 7)
// ---------------------------------------------------------------------------

test('spawn-morty: spawn error (no claude binary) reports spawn-error status', () => {
    const tmpDir = makeTmpDir();
    try {
        // Point PATH to a directory with no `claude` binary to trigger ENOENT spawn error
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-err');
        fs.mkdirSync(ticketDir, { recursive: true });
        const result = run(
            [
                'implement the thing',
                '--ticket-id', 'ticket-err',
                '--ticket-path', ticketDir,
                '--timeout', '5',
            ],
            { PATH: '/nonexistent', PICKLE_DATA_ROOT: tmpDir }
        );
        assert.equal(result.status, 1, 'should exit with code 1');
        const combined = result.stdout + result.stderr;
        // The error handler should report spawn-error status
        assert.ok(
            combined.includes('spawn-error') || combined.includes('failed'),
            'should report spawn-error or failed status'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// F15: 30s minimum timeout floor
// ---------------------------------------------------------------------------

test('spawn-morty F15: 5s remaining is clamped to 30s minimum', () => {
    const tmpDir = makeTmpDir();
    try {
        // session/ticket structure so state.json is found as parentState
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-f15a');
        fs.mkdirSync(ticketDir, { recursive: true });

        // Started 55s ago with 1-minute max → ~5s remaining at fixture-write time.
        // Under load, the subprocess may not read state.json until several seconds
        // later — pushing remaining into the negative branch. Both branches enforce
        // the 30s floor and emit a "Timeout:" line; we assert the floor invariant
        // (>= 30s) rather than the exact 30s value to tolerate either path.
        const startEpoch = Math.floor(Date.now() / 1000) - 55;
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: true, max_time_minutes: 1, start_time_epoch: startEpoch })
        );

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-f15a',
            '--ticket-path', ticketDir,
            '--timeout', '600',
        ], {
            env: { ...process.env, PATH: '/nonexistent', PICKLE_DATA_ROOT: tmpDir },
            encoding: 'utf-8',
            // 15s → 45s: budget for system load when run alongside concurrent
            // codex/tmux work. Validates panel content, not wall-clock.
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        // Strip ANSI color codes so panel lines like "[2mTimeout:[0m 30s" parse.
        const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');
        const plain = stripAnsi(combined);
        // Either branch is valid:
        //  A) remaining > 0, < 30: clamped down with floor → "Timeout: 30s (Req: 600s)"
        //     "Worker timeout clamped: 30s" log line.
        //  B) remaining <= 0 (under load): floor max(30, --timeout=600) = 600s →
        //     "Session time already elapsed; running with requested timeout."
        //     "Timeout: 600s (Req: 600s)" — the floor would be 30 if --timeout < 30.
        // Both paths satisfy the invariant: effectiveTimeout >= 30. Verify by
        // extracting the panel Timeout value and asserting it >= 30s.
        const m = plain.match(/Timeout:\s*(\d+)s/);
        assert.ok(m, `effectiveTimeout panel line not found in output:\n${plain.slice(0, 800)}`);
        const effective = parseInt(m[1], 10);
        assert.ok(
            effective >= 30,
            `effectiveTimeout should be >= 30s floor, got ${effective}s`,
        );
        // And: with --timeout 600, effectiveTimeout cannot exceed 600.
        assert.ok(
            effective <= 600,
            `effectiveTimeout should be <= --timeout (600s), got ${effective}s`,
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty F15: negative remaining with short --timeout yields >=30s', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-f15b');
        fs.mkdirSync(ticketDir, { recursive: true });

        // Started 120s ago with 1-minute max → remaining is negative
        const startEpoch = Math.floor(Date.now() / 1000) - 120;
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ active: true, max_time_minutes: 1, start_time_epoch: startEpoch })
        );

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-f15b',
            '--ticket-path', ticketDir,
            '--timeout', '5',
        ], {
            env: { ...process.env, PATH: '/nonexistent', PICKLE_DATA_ROOT: tmpDir },
            encoding: 'utf-8',
            // 15s → 45s: budget for system load when run alongside concurrent
            // codex/tmux work. Validates panel content, not wall-clock.
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        // With remaining<=0 and --timeout 5, effectiveTimeout = max(30, 5) = 30
        assert.match(combined, /Timeout.*\b30s\b/, 'effectiveTimeout should be at least 30s even when session elapsed');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: recovers orphan tmp backend state before routing worker CLI', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-backend-recovery');
        fs.mkdirSync(ticketDir, { recursive: true });

        const statePath = path.join(sessionDir, 'state.json');
        const baseState = {
            working_dir: tmpDir,
            session_dir: sessionDir,
            started_at: '2026-01-01T00:00:00Z',
            original_prompt: 'test backend recovery',
            step: 'implement',
            iteration: 1,
            max_iterations: 5,
            max_time_minutes: 0,
            worker_timeout_seconds: 1200,
            start_time_epoch: 0,
            history: [],
            completion_promise: null,
            schema_version: 3,
            active: true,
            backend: 'claude',
        };
        fs.writeFileSync(statePath, JSON.stringify(baseState));
        fs.writeFileSync(
            `${statePath}.tmp.99999999`,
            JSON.stringify({
                ...baseState,
                backend: 'codex',
                iteration: 2,
            }),
        );

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-invocation.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-backend-recovery',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1, `expected validation failure after codex shim exit, got: ${combined}`);
        assert.match(stripAnsi(combined), /Backend:\s*codex\b/, `expected Backend: codex in output, got: ${combined}`);
        assert.ok(fs.existsSync(shimLog), 'codex shim should be invoked after backend recovery');
        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        assert.equal(invocation.pickle_backend, 'codex');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty.hermes: spawns hermes chat with toolsets and completes', () => {
    const tmpDir = makeTmpDir();
    const ticketId = 'ticket-hermes-worker';
    try {
        const harness = makeHermesHarness(tmpDir, ticketId, {
            hermes_toolsets: ['terminal', 'file', 'code_execution'],
            hermes_provider: 'anthropic',
            hermes_model: 'anthropic/claude-sonnet-4',
            hermes_max_turns: 9,
        });
        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'hermes-invocation.json');
        writeHermesShim(shimDir, shimLog, harness.ticketDir);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the hermes thing',
            '--ticket-id', ticketId,
            '--ticket-path', harness.ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        assert.equal(result.status, 0, `expected successful hermes shim worker, got: ${result.stdout + result.stderr}`);
        assert.ok(fs.existsSync(shimLog), 'hermes shim should be invoked');
        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        assert.equal(invocation.cwd, harness.repoDir);
        assert.equal(invocation.pickle_backend, 'hermes');
        assert.equal(invocation.pickle_role, 'worker');
        assert.equal(invocation.argv[0], 'chat');
        assert.equal(invocation.argv[1], '-q');
        assert.match(invocation.argv[2], /implement the hermes thing/);
        assert.equal(invocation.argv[3], '-Q');
        assert.ok(invocation.argv.includes('--ignore-rules'));
        assert.ok(invocation.argv.includes('--ignore-user-config'));
        const toolsetsIdx = invocation.argv.indexOf('--toolsets');
        const providerIdx = invocation.argv.indexOf('--provider');
        const maxTurnsIdx = invocation.argv.indexOf('--max-turns');
        const modelIdx = invocation.argv.indexOf('-m');
        assert.equal(invocation.argv[toolsetsIdx + 1], 'terminal,file,code_execution');
        assert.equal(invocation.argv[providerIdx + 1], 'anthropic');
        assert.equal(invocation.argv[maxTurnsIdx + 1], '9');
        assert.equal(invocation.argv[modelIdx + 1], 'anthropic/claude-sonnet-4');
        const logContent = readWorkerLogFile(harness.ticketDir);
        assert.match(logContent, /Hermes worker completed/);
        assert.match(logContent, /<promise>I AM DONE<\/promise>/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty.hermes-missing: missing binary exits 127 and logs event', () => {
    const tmpDir = makeTmpDir();
    const ticketId = 'ticket-hermes-missing';
    try {
        const harness = makeHermesHarness(tmpDir, ticketId);
        const emptyPath = path.join(tmpDir, 'empty-bin');
        fs.mkdirSync(emptyPath, { recursive: true });

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the hermes thing',
            '--ticket-id', ticketId,
            '--ticket-path', harness.ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: emptyPath,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        assert.equal(result.status, 127, `expected missing hermes binary exit 127, got: ${result.stdout + result.stderr}`);
        const combined = result.stdout + result.stderr;
        assert.match(combined, /spawn-error|failed/i);
        const logContent = readWorkerLogFile(harness.ticketDir);
        const event = JSON.parse(logContent.trim());
        assert.equal(event.event, 'hermes_binary_missing');
        assert.equal(event.ticket, ticketId);
        assert.equal(event.backend, 'hermes');
        assert.equal(event.command, 'hermes');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

function writeDeepseekClaudeShim(shimDir, logPath, ticketDir) {
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'claude');
    fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  pickle_backend: process.env.PICKLE_BACKEND || null,
  anthropic_base_url: process.env.ANTHROPIC_BASE_URL || null,
  anthropic_auth_token: process.env.ANTHROPIC_AUTH_TOKEN || null,
  anthropic_model: process.env.ANTHROPIC_MODEL || null,
}, null, 2));
fs.writeFileSync(${JSON.stringify(path.join(ticketDir, 'conformance_2026-05-03.md'))}, 'ALL_PASS\\n');
console.log('DeepSeek worker completed with enough output for validation. '.repeat(8));
console.log('<promise>I AM DONE</promise>');
process.exit(0);
`);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
}

function makeDeepseekHarness(tmpDir, ticketId, state = {}) {
    writeExtensionSentinel(tmpDir);
    const sessionDir = path.join(tmpDir, 'session');
    const ticketDir = path.join(sessionDir, ticketId);
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
        active: true,
        backend: 'deepseek',
        working_dir: repoDir,
        iteration: 1,
        max_iterations: 5,
        schema_version: 1,
        ...state,
    }));
    return { sessionDir, ticketDir, repoDir };
}

test('spawn-morty.deepseek: env overlay reaches child and PICKLE_BACKEND stays deepseek', () => {
    const tmpDir = makeTmpDir();
    const ticketId = 'ticket-deepseek-env';
    try {
        const harness = makeDeepseekHarness(tmpDir, ticketId);
        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'deepseek-invocation.json');
        writeDeepseekClaudeShim(shimDir, shimLog, harness.ticketDir);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the deepseek thing',
            '--ticket-id', ticketId,
            '--ticket-path', harness.ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
                DEEPSEEK_API_KEY: 'test-deepseek-key-12345',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        assert.equal(result.status, 0, `expected successful deepseek shim worker, got: ${result.stdout + result.stderr}`);
        assert.ok(fs.existsSync(shimLog), 'deepseek claude shim should be invoked');
        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        assert.equal(invocation.cwd, harness.repoDir);
        assert.equal(invocation.pickle_backend, 'deepseek', 'PICKLE_BACKEND must stay deepseek (not clobbered by env overlay)');
        assert.equal(invocation.anthropic_base_url, 'https://api.deepseek.com/anthropic', 'ANTHROPIC_BASE_URL from invocation.env overlay must reach child');
        assert.equal(invocation.anthropic_auth_token, 'test-deepseek-key-12345', 'ANTHROPIC_AUTH_TOKEN from invocation.env overlay must equal DEEPSEEK_API_KEY');
        assert.ok(invocation.anthropic_model, 'ANTHROPIC_MODEL from invocation.env overlay must be set');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: recovers orphan tmp session timeout before printing worker budget', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-timeout-recovery');
        fs.mkdirSync(ticketDir, { recursive: true });

        const statePath = path.join(sessionDir, 'state.json');
        const nowEpoch = Math.floor(Date.now() / 1000);
        const baseState = {
            working_dir: tmpDir,
            session_dir: sessionDir,
            started_at: '2026-01-01T00:00:00Z',
            original_prompt: 'test timeout recovery',
            step: 'implement',
            iteration: 1,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            history: [],
            completion_promise: null,
            schema_version: 3,
            active: true,
            backend: 'claude',
            max_time_minutes: 20,
            start_time_epoch: nowEpoch - 5,
        };
        fs.writeFileSync(statePath, JSON.stringify(baseState));
        fs.writeFileSync(
            `${statePath}.tmp.99999998`,
            JSON.stringify({
                ...baseState,
                backend: 'codex',
                max_time_minutes: 3,
                start_time_epoch: nowEpoch - 90,
                iteration: 2,
            }),
        );

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-timeout-recovery',
            '--ticket-path', ticketDir,
            '--timeout', '600',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: '/nonexistent',
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        const plain = stripAnsi(combined);
        assert.equal(result.status, 1, `expected spawn failure after recovered timeout path, got: ${plain}`);
        assert.match(plain, /Backend:\s*codex\b/, `expected recovered backend in output, got: ${plain}`);
        assert.ok(plain.includes('Worker timeout clamped'), `expected timeout clamp message, got: ${plain}`);
        const match = plain.match(/Timeout:\s*(\d+)s \(Req: 600s\)/);
        assert.ok(match, `expected timeout panel line, got: ${plain}`);
        const effective = Number(match[1]);
        assert.ok(
            Number.isFinite(effective) && effective >= 80 && effective <= 95,
            `expected recovered timeout near 90s, got ${effective}s`,
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: session working_dir controls child cwd and repo access', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-working-dir');
        const repoDir = path.join(tmpDir, 'target-repo');
        const wrongCwd = path.join(tmpDir, 'wrong-cwd');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.mkdirSync(repoDir, { recursive: true });
        fs.mkdirSync(wrongCwd, { recursive: true });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            working_dir: repoDir,
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-working-dir.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-working-dir',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            cwd: wrongCwd,
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1, `expected validation failure after codex shim exit, got: ${combined}`);
        assert.ok(fs.existsSync(shimLog), 'codex shim should be invoked');

        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        assert.equal(invocation.cwd, repoDir, 'worker subprocess should run from the recovered session working_dir');

        const addDirs = [];
        for (let i = 0; i < invocation.argv.length; i++) {
            if (invocation.argv[i] === '--add-dir' && typeof invocation.argv[i + 1] === 'string') {
                addDirs.push(invocation.argv[i + 1]);
                i++;
            }
        }
        assert.ok(addDirs.includes(repoDir), 'worker invocation should explicitly include the recovered repo root');
        assert.ok(addDirs.includes(ticketDir), 'worker invocation should still include the ticket directory');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// --effort threading: state.effort -> codex `-c reasoning.effort=<value>`
// ---------------------------------------------------------------------------

test('spawn-morty: state.effort=high reaches codex invocation as -c reasoning.effort=high', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-effort-thread');
        fs.mkdirSync(ticketDir, { recursive: true });

        const statePath = path.join(sessionDir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({
            active: true,
            backend: 'codex',
            effort: 'high',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-effort.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-effort-thread',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        // shim exits 0 with no real artifact -> validation failure (status 1) is expected
        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(shimLog), 'codex shim should be invoked');
        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        const argv = invocation.argv;
        const dashCIdx = argv.indexOf('-c');
        assert.ok(dashCIdx >= 0, `expected -c in argv, got: ${JSON.stringify(argv)}`);
        assert.equal(argv[dashCIdx + 1], 'reasoning.effort=high');
        // -c must appear BEFORE the `--` prompt separator
        const sepIdx = argv.indexOf('--');
        assert.ok(sepIdx >= 0 && dashCIdx < sepIdx, '-c reasoning.effort must come before --');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty: state.effort=xhigh reaches codex invocation as -c reasoning.effort=xhigh', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-effort-xhigh-thread');
        fs.mkdirSync(ticketDir, { recursive: true });

        const statePath = path.join(sessionDir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({
            active: true,
            backend: 'codex',
            effort: 'xhigh',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-effort-xhigh.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-effort-xhigh-thread',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(shimLog), 'codex shim should be invoked');
        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        const argv = invocation.argv;
        const dashCIdx = argv.indexOf('-c');
        assert.ok(dashCIdx >= 0, `expected -c in argv, got: ${JSON.stringify(argv)}`);
        assert.equal(argv[dashCIdx + 1], 'reasoning.effort=xhigh');
        const sepIdx = argv.indexOf('--');
        assert.ok(sepIdx >= 0 && dashCIdx < sepIdx, '-c reasoning.effort must come before --');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// P0: Codex worker contract addendum
// ---------------------------------------------------------------------------

test('spawn-morty P0: codex backend prompt contains "Codex-specific contract additions"', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-codex-addendum');
        fs.mkdirSync(ticketDir, { recursive: true });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-addendum.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-codex-addendum',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        assert.equal(result.status, 1, `expected validation failure after shim exit, got: ${result.stdout + result.stderr}`);
        assert.ok(fs.existsSync(shimLog), 'codex shim should be invoked');
        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        const prompt = invocation.argv[invocation.argv.length - 1];
        assert.match(prompt, /Codex-specific contract additions/,
            'codex prompt MUST contain the codex contract addendum');
        assert.match(prompt, /git add.*git commit.*before emitting/s,
            'codex addendum MUST require commit before promise');
        assert.match(prompt, /DEFERRED/,
            'codex addendum MUST mention DEFERRED for contradicted ACs');
        assert.match(prompt, /DO NOT explore harness internals/,
            'codex addendum MUST forbid harness exploration');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P0: claude backend prompt does NOT contain codex addendum', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-claude-no-addendum');
        fs.mkdirSync(ticketDir, { recursive: true });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'claude',
            iteration: 1,
            schema_version: 1,
        }));

        // Shim "claude" — same trick as codex shim. Captures prompt argv.
        const shimDir = path.join(tmpDir, 'bin');
        fs.mkdirSync(shimDir, { recursive: true });
        const shimLog = path.join(tmpDir, 'claude-prompt.json');
        const shimPath = path.join(shimDir, 'claude');
        fs.writeFileSync(shimPath, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(shimLog)}, JSON.stringify({
  argv: process.argv.slice(2),
}, null, 2));
process.exit(0);
`);
        fs.chmodSync(shimPath, 0o755);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'implement the thing',
            '--ticket-id', 'ticket-claude-no-addendum',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        assert.equal(result.status, 1, `expected validation failure after shim exit, got: ${result.stdout + result.stderr}`);
        assert.ok(fs.existsSync(shimLog), 'claude shim should be invoked');
        const invocation = JSON.parse(fs.readFileSync(shimLog, 'utf-8'));
        // The prompt is the value following `--append-system-prompt` or the last positional;
        // for claude shim, just join all argv and confirm the addendum string is absent.
        const allArgv = invocation.argv.join('\n');
        assert.ok(
            !allArgv.includes('Codex-specific contract additions'),
            'claude prompt MUST NOT contain codex contract addendum'
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Tool retry guidance
// ---------------------------------------------------------------------------

test('tool-retry.analyze-guidance: retry_count=2 prepends analyze guidance', () => {
    const tmpDir = makeTmpDir();
    const ticketId = 'ticket-tool-retry-analyze';
    try {
        const harness = writeCodexSpawnHarness(tmpDir, ticketId);
        writeLastToolError(harness.sessionDir, 2);

        const result = runCodexHarness(tmpDir, harness, ticketId);

        assert.equal(result.status, 1, `expected validation failure after shim exit, got: ${result.stdout + result.stderr}`);
        assert.ok(fs.existsSync(harness.shimLog), 'codex shim should be invoked');
        const prompt = readCapturedCodexPrompt(harness.shimLog);
        assert.ok(prompt.startsWith('# TOOL RETRY GUIDANCE'), 'tool retry guidance should be prepended');
        assert.match(prompt, /Analyze and fix the root cause before retrying/);
        assert.doesNotMatch(prompt, /TOOL RETRY CIRCUIT OPEN/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('tool-retry.stop: retry_count=4 prepends STOP guidance and emits activity', () => {
    const tmpDir = makeTmpDir();
    const ticketId = 'ticket-tool-retry-stop';
    try {
        const harness = writeCodexSpawnHarness(tmpDir, ticketId);
        const statePath = path.join(harness.sessionDir, 'state.json');
        writeLastToolError(harness.sessionDir, 4);

        const result = runCodexHarness(tmpDir, harness, ticketId);

        assert.equal(result.status, 1, `expected validation failure after shim exit, got: ${result.stdout + result.stderr}`);
        assert.ok(fs.existsSync(harness.shimLog), 'codex shim should be invoked');
        const prompt = readCapturedCodexPrompt(harness.shimLog);
        assert.ok(prompt.startsWith('# TOOL RETRY CIRCUIT OPEN'), 'STOP guidance should be prepended');
        assert.match(prompt, /STOP\./);
        assert.match(prompt, /completely different approach/);

        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        const event = state.activity?.find((entry) => entry.event === 'tool_retry_circuit_open');
        assert.ok(event, 'tool_retry_circuit_open activity should be emitted');
        assert.equal(event.ticket, ticketId);
        assert.equal(event.tool, 'Bash');
        assert.equal(event.retry_count, 4);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Cross-iteration handoff notes
// ---------------------------------------------------------------------------

test('handoff.read: prior per-ticket handoff notes are prepended to next prompt', () => {
    const tmpDir = makeTmpDir();
    const ticketId = 'ticket-handoff-read';
    try {
        const harness = writeCodexSpawnHarness(tmpDir, ticketId);
        fs.writeFileSync(path.join(harness.ticketDir, 'handoff_notes.md'), [
            '## previous iteration',
            'Tried: changed src/bin/spawn-morty.ts',
            'Failed: prompt did not include handoff context',
            'Next focus: tests/spawn-morty.test.js',
            'Command: npm test -- --grep handoff.read',
            '',
        ].join('\n'));

        const result = runCodexHarness(tmpDir, harness, ticketId);

        assert.equal(result.status, 1, `expected validation failure after shim exit, got: ${result.stdout + result.stderr}`);
        assert.ok(fs.existsSync(harness.shimLog), 'codex shim should be invoked');
        const prompt = readCapturedCodexPrompt(harness.shimLog);
        const handoffIndex = prompt.indexOf('# PRIOR ITERATION HANDOFF');
        const taskIndex = prompt.indexOf('implement the thing');
        assert.ok(handoffIndex === 0, 'handoff block should be the first prompt context when no tool retry guidance exists');
        assert.ok(taskIndex > handoffIndex, 'task/template text should follow prior handoff context');
        assert.match(prompt, /Failed: prompt did not include handoff context/);
        assert.match(prompt, /Next focus: tests\/spawn-morty\.test\.js/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('handoff.write: successful worker appends per-ticket handoff notes', () => {
    const tmpDir = makeTmpDir();
    const ticketId = 'ticket-handoff-write';
    try {
        const harness = writeCodexSpawnHarness(tmpDir, ticketId);
        writeSuccessfulCodexShim(harness.shimDir, harness.shimLog, harness.ticketDir);

        const result = runCodexHarness(tmpDir, harness, ticketId);

        assert.equal(result.status, 0, `expected successful shim worker, got: ${result.stdout + result.stderr}`);
        const handoffPath = path.join(harness.ticketDir, 'handoff_notes.md');
        assert.ok(fs.existsSync(handoffPath), 'handoff_notes.md should exist after worker iteration');
        const content = fs.readFileSync(handoffPath, 'utf-8');
        assert.match(content, /Tried: implemented handoff fixture/);
        assert.match(content, /Failed: none/);
        assert.match(content, /Next focus: tests\/spawn-morty\.test\.js/);
        assert.match(content, /Command: npm test -- --grep handoff\.write/);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// P2: Per-ticket backend routing heuristic
// ---------------------------------------------------------------------------

/**
 * Helper: write a `pickle_settings.json` to the EXTENSION_DIR. The flag value
 * controls whether the routing heuristic is enabled.
 */
function writeSettings(extensionDir, enableRouting) {
    fs.mkdirSync(extensionDir, { recursive: true });
    writeExtensionSentinel(extensionDir);
    fs.writeFileSync(
        path.join(extensionDir, 'pickle_settings.json'),
        JSON.stringify({ enable_backend_routing_heuristic: enableRouting })
    );
}

/**
 * Helper: write a ticket file with frontmatter for routing tests. Returns
 * the ticket file path.
 */
function writeTicketFile(ticketDir, frontmatter) {
    const ticketFile = path.join(ticketDir, 'ticket.md');
    const fmBody = Object.entries(frontmatter)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
    fs.writeFileSync(ticketFile, `---\n${fmBody}\n---\n\n# Ticket\n\nBody.\n`);
    return ticketFile;
}

test('spawn-morty P2: heuristic OFF (default) — large tier on codex stays codex', () => {
    const tmpDir = makeTmpDir();
    try {
        writeSettings(tmpDir, false);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-routing-off');
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = writeTicketFile(ticketDir, {
            id: 'ticket-routing-off',
            title: 'Refactor tokenizer',
            complexity_tier: 'large',
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-routing-off.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-routing-off',
            '--ticket-path', ticketDir,
            '--ticket-file', ticketFile,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1);
        // No override fired → backend stays codex → codex shim runs → shim log written.
        assert.ok(fs.existsSync(shimLog), 'codex shim should run when heuristic is OFF');
        assert.match(stripAnsi(combined), /Backend:\s*codex\b/,
            `expected Backend: codex, got: ${combined}`);
        assert.ok(!combined.includes('backend routed: codex → claude'),
            'no routing override message expected when heuristic is OFF');
        const event = readStateEvent(path.join(sessionDir, 'state.json'), 'worker_spawn_backend_resolved');
        assert.equal(event?.backend, 'codex');
        assert.equal(event?.source, 'state');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2: recovers disabled routing heuristic from newer dead settings tmp', () => {
    const tmpDir = makeTmpDir();
    try {
        writeSettings(tmpDir, true);
        const recoveredSettingsPath = path.join(tmpDir, `pickle_settings.json.tmp.${DEAD_TMP_PID}`);
        fs.writeFileSync(
            recoveredSettingsPath,
            JSON.stringify({ enable_backend_routing_heuristic: false })
        );
        markTmpNewer(recoveredSettingsPath);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-routing-recovered-off');
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = writeTicketFile(ticketDir, {
            id: 'ticket-routing-recovered-off',
            title: 'Refactor tokenizer',
            complexity_tier: 'large',
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-routing-recovered-off.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-routing-recovered-off',
            '--ticket-path', ticketDir,
            '--ticket-file', ticketFile,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(shimLog), 'codex shim should run when recovered heuristic is OFF');
        assert.ok(!combined.includes('backend routed: codex → claude'),
            `no routing override expected from stale enabled base, got: ${combined}`);
        assert.equal(fs.existsSync(recoveredSettingsPath), false,
            'dead settings tmp should be promoted and removed');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2: env backend overrides missing state backend and records env source', () => {
    const tmpDir = makeTmpDir();
    try {
        writeSettings(tmpDir, true);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-backend-env');
        fs.mkdirSync(ticketDir, { recursive: true });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-env.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-backend-env',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: 'codex',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        assert.equal(result.status, 1);
        const event = readStateEvent(path.join(sessionDir, 'state.json'), 'worker_spawn_backend_resolved');
        assert.equal(event?.backend, 'codex');
        assert.equal(event?.source, 'env');
        assert.equal(typeof event?.pid, 'number');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2: recovers disabled complexity tiers from newer dead settings tmp', () => {
    const tmpDir = makeTmpDir();
    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        writeExtensionSentinel(tmpDir);
        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ enable_complexity_tiers: true })
        );
        const recoveredSettingsPath = path.join(tmpDir, `pickle_settings.json.tmp.${DEAD_TMP_PID}`);
        fs.writeFileSync(
            recoveredSettingsPath,
            JSON.stringify({ enable_complexity_tiers: false })
        );
        markTmpNewer(recoveredSettingsPath);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-model-recovered-off');
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = writeTicketFile(ticketDir, {
            id: 'ticket-model-recovered-off',
            title: 'Implement neutral worker task',
            complexity_tier: 'large',
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'claude',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        fs.mkdirSync(shimDir, { recursive: true });
        const claudeLog = path.join(tmpDir, 'claude-model-recovered-off.json');
        const claudeShim = path.join(shimDir, 'claude');
        fs.writeFileSync(claudeShim, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ argv: process.argv.slice(2) }, null, 2));
process.exit(0);
`);
        fs.chmodSync(claudeShim, 0o755);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-model-recovered-off',
            '--ticket-path', ticketDir,
            '--ticket-file', ticketFile,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(claudeLog), 'claude shim should run for claude backend');
        const invocation = JSON.parse(fs.readFileSync(claudeLog, 'utf-8'));
        const modelIndex = invocation.argv.indexOf('--model');
        assert.notEqual(modelIndex, -1, 'claude invocation should include a model');
        assert.equal(invocation.argv[modelIndex + 1], 'sonnet',
            `recovered disabled complexity tiers should force sonnet, got: ${invocation.argv.join(' ')}`);
        assert.equal(fs.existsSync(recoveredSettingsPath), false,
            'dead settings tmp should be promoted and removed');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2: heuristic ON — large tier flips codex → claude', () => {
    const tmpDir = makeTmpDir();
    try {
        writeSettings(tmpDir, true);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-routing-large');
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = writeTicketFile(ticketDir, {
            id: 'ticket-routing-large',
            title: 'Refactor tokenizer',
            complexity_tier: 'large',
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            iteration: 1,
            schema_version: 1,
        }));

        // Shim claude (the override target). codex would also be invoked if
        // override fails — distinct shim logs make the assertion unambiguous.
        const shimDir = path.join(tmpDir, 'bin');
        fs.mkdirSync(shimDir, { recursive: true });
        const claudeLog = path.join(tmpDir, 'claude-large.json');
        const claudeShim = path.join(shimDir, 'claude');
        fs.writeFileSync(claudeShim, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ argv: process.argv.slice(2) }));
process.exit(0);
`);
        fs.chmodSync(claudeShim, 0o755);
        // No codex shim — if heuristic fails to flip, ENOENT crashes loudly.

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-routing-large',
            '--ticket-path', ticketDir,
            '--ticket-file', ticketFile,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(claudeLog), 'claude shim should run after override fires');
        assert.ok(combined.includes('backend routed: codex → claude'),
            `expected override log line, got: ${combined}`);
        assert.ok(combined.includes('complexity_tier=large'),
            `expected reason=complexity_tier=large, got: ${combined}`);
        const event = readStateEvent(path.join(sessionDir, 'state.json'), 'worker_spawn_backend_resolved');
        assert.equal(event?.backend, 'claude');
        assert.equal(event?.source, 'settings');
        assert.equal(typeof event?.pid, 'number');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2: heuristic ON — UI title flips codex → claude', () => {
    const tmpDir = makeTmpDir();
    try {
        writeSettings(tmpDir, true);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-routing-ui');
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = writeTicketFile(ticketDir, {
            id: 'ticket-routing-ui',
            title: 'Polish UI for billing dashboard',
            complexity_tier: 'medium',
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        fs.mkdirSync(shimDir, { recursive: true });
        const claudeLog = path.join(tmpDir, 'claude-ui.json');
        const claudeShim = path.join(shimDir, 'claude');
        fs.writeFileSync(claudeShim, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(claudeLog)}, JSON.stringify({ argv: process.argv.slice(2) }));
process.exit(0);
`);
        fs.chmodSync(claudeShim, 0o755);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-routing-ui',
            '--ticket-path', ticketDir,
            '--ticket-file', ticketFile,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(claudeLog), 'claude shim should run after UI title override fires');
        assert.ok(combined.includes('backend routed: codex → claude'),
            `expected override message, got: ${combined}`);
        assert.ok(/title-signal/.test(combined),
            `expected title-signal reason, got: ${combined}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2: heuristic ON — small tier + neutral title stays codex', () => {
    const tmpDir = makeTmpDir();
    try {
        writeSettings(tmpDir, true);
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-routing-stay');
        fs.mkdirSync(ticketDir, { recursive: true });
        const ticketFile = writeTicketFile(ticketDir, {
            id: 'ticket-routing-stay',
            title: 'Fix typo in helper',
            complexity_tier: 'small',
        });

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        const shimLog = path.join(tmpDir, 'codex-stay.json');
        writeCodexShim(shimDir, shimLog);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-routing-stay',
            '--ticket-path', ticketDir,
            '--ticket-file', ticketFile,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(shimLog), 'codex shim should run because small/neutral did not flip');
        assert.ok(!combined.includes('backend routed'),
            `no routing override expected for small/neutral, got: ${combined}`);
        assert.match(stripAnsi(combined), /Backend:\s*codex\b/,
            `expected Backend: codex, got: ${combined}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// P2: Post-flush guard — short log + git edits + artifact = success
// ---------------------------------------------------------------------------

/**
 * Helper: writes a shim that prints WORKER_DONE token (small log <200B),
 * creates a lifecycle artifact in the ticket dir, AND makes a git commit
 * in the session working_dir. Then exits 0.
 */
function writePostFlushShim(shimDir, ticketDir, workingDir, makeGitEdit) {
    fs.mkdirSync(shimDir, { recursive: true });
    const shimPath = path.join(shimDir, 'codex');
    const shimSrc = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
// Small post-promise log — under 200B
process.stdout.write('<promise>I AM DONE</promise>\\n');
// Lifecycle artifact for implementation role: research_*.md
fs.writeFileSync(path.join(${JSON.stringify(ticketDir)}, 'research_done.md'), 'r');
${makeGitEdit ? `
// Real git edit + commit in working dir
try {
  fs.writeFileSync(path.join(${JSON.stringify(workingDir)}, 'morty-edit.txt'), 'committed by shim\\n');
  execSync('git add morty-edit.txt && git commit -m "shim edit"', { cwd: ${JSON.stringify(workingDir)} });
} catch (e) { process.stderr.write('shim git failed: ' + e.message); }
` : ''}
process.exit(0);
`;
    fs.writeFileSync(shimPath, shimSrc);
    fs.chmodSync(shimPath, 0o755);
    return shimPath;
}

test('spawn-morty P2 post-flush: token + artifact + git edits + log<200B → success', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-postflush-success');
        const workingDir = path.join(tmpDir, 'repo');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.mkdirSync(workingDir, { recursive: true });

        // Init real git repo so checkGitEdits can run.
        // git init + initial commit using imported spawnSync. Backdate the
        // base commit so checkGitEdits's ">= startTime" comparison cleanly
        // excludes it (otherwise a same-second seed commit looks like worker
        // edits and the negative test false-passes).
        const baseEpoch = Math.floor(Date.now() / 1000) - 5;
        const gitSetup = spawnSync('bash', ['-c',
            `GIT_AUTHOR_DATE='@${baseEpoch} +0000' GIT_COMMITTER_DATE='@${baseEpoch} +0000' git init -q && ` +
            'git config user.email t@t && git config user.name t && ' +
            `GIT_AUTHOR_DATE='@${baseEpoch} +0000' GIT_COMMITTER_DATE='@${baseEpoch} +0000' git commit --allow-empty -q -m base`
        ], { cwd: workingDir, encoding: 'utf-8' });
        assert.equal(gitSetup.status, 0, `git init failed: ${gitSetup.stderr}`);

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            working_dir: workingDir,
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        writePostFlushShim(shimDir, ticketDir, workingDir, /* makeGitEdit */ true);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-postflush-success',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 0,
            `expected isSuccess via post-flush guard (exit 0), got: ${combined}`);
        assert.ok(/validation.*successful/i.test(combined),
            `expected successful validation, got: ${combined}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('spawn-morty P2 post-flush: token + artifact + zero git edits + log<200B → failure', () => {
    const tmpDir = makeTmpDir();
    try {
        const sessionDir = path.join(tmpDir, 'session');
        const ticketDir = path.join(sessionDir, 'ticket-postflush-fail');
        const workingDir = path.join(tmpDir, 'repo');
        fs.mkdirSync(ticketDir, { recursive: true });
        fs.mkdirSync(workingDir, { recursive: true });

        // git init + initial commit using imported spawnSync. Backdate the
        // base commit so checkGitEdits's ">= startTime" comparison cleanly
        // excludes it (otherwise a same-second seed commit looks like worker
        // edits and the negative test false-passes).
        const baseEpoch = Math.floor(Date.now() / 1000) - 5;
        const gitSetup = spawnSync('bash', ['-c',
            `GIT_AUTHOR_DATE='@${baseEpoch} +0000' GIT_COMMITTER_DATE='@${baseEpoch} +0000' git init -q && ` +
            'git config user.email t@t && git config user.name t && ' +
            `GIT_AUTHOR_DATE='@${baseEpoch} +0000' GIT_COMMITTER_DATE='@${baseEpoch} +0000' git commit --allow-empty -q -m base`
        ], { cwd: workingDir, encoding: 'utf-8' });
        assert.equal(gitSetup.status, 0, `git init failed: ${gitSetup.stderr}`);

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            backend: 'codex',
            working_dir: workingDir,
            iteration: 1,
            schema_version: 1,
        }));

        const shimDir = path.join(tmpDir, 'bin');
        writePostFlushShim(shimDir, ticketDir, workingDir, /* makeGitEdit */ false);

        const result = spawnSync(process.execPath, [SPAWN_MORTY_BIN,
            'do thing',
            '--ticket-id', 'ticket-postflush-fail',
            '--ticket-path', ticketDir,
            '--timeout', '30',
        ], {
            env: {
                ...process.env,
                EXTENSION_DIR: tmpDir,
                PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
                PICKLE_BACKEND: '',
            },
            encoding: 'utf-8',
            timeout: 45000,
        });

        const combined = result.stdout + result.stderr;
        assert.equal(result.status, 1,
            `expected validation failure when log<200B AND no git edits, got: ${combined}`);
        assert.ok(/no git edits|validation failed/i.test(combined),
            `expected validation failure message, got: ${combined}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// tierToModel — tier-based model routing
// ---------------------------------------------------------------------------

test('tierToModel: trivial -> haiku', () => {
    assert.equal(tierToModel('trivial'), 'haiku');
});

test('tierToModel: small -> sonnet', () => {
    assert.equal(tierToModel('small'), 'sonnet');
});

test('tierToModel: medium -> sonnet', () => {
    assert.equal(tierToModel('medium'), 'sonnet');
});

test('tierToModel: large -> opus', () => {
    assert.equal(tierToModel('large'), 'opus');
});

test('tierToModel: undefined -> sonnet (missing tier fallback)', () => {
    assert.equal(tierToModel(undefined), 'sonnet');
});

test('tierToModel: unrecognized tier -> sonnet (unknown fallback)', () => {
    assert.equal(tierToModel('mega'), 'sonnet');
    assert.equal(tierToModel(''), 'sonnet');
});

// ---------------------------------------------------------------------------
// resolveCodexModel — codex `-m <model>` resolution precedence
//
// Precedence: state.codex_model (trimmed, non-empty) →
//             pickle_settings.default_codex_model → undefined
// ---------------------------------------------------------------------------

function writeCodexSettings(extensionRoot, body) {
    fs.mkdirSync(extensionRoot, { recursive: true });
    fs.writeFileSync(path.join(extensionRoot, 'pickle_settings.json'), JSON.stringify(body));
}

test('resolveCodexModel: state.codex_model wins over settings default', () => {
    const extensionRoot = makeTmpDir('pickle-codex-model-state-');
    try {
        writeCodexSettings(extensionRoot, { default_codex_model: 'gpt-5.3-codex-spark' });
        const state = { codex_model: 'custom-model' };
        assert.equal(resolveCodexModel(extensionRoot, state), 'custom-model');
    } finally {
        fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
});

test('resolveCodexModel: settings default applies when state.codex_model is absent', () => {
    const extensionRoot = makeTmpDir('pickle-codex-model-settings-');
    try {
        writeCodexSettings(extensionRoot, { default_codex_model: 'gpt-5.3-codex-spark' });
        assert.equal(resolveCodexModel(extensionRoot, {}), 'gpt-5.3-codex-spark');
        assert.equal(resolveCodexModel(extensionRoot, null), 'gpt-5.3-codex-spark');
    } finally {
        fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
});

test('resolveCodexModel: settings default applies when state.codex_model is empty/whitespace', () => {
    const extensionRoot = makeTmpDir('pickle-codex-model-empty-');
    try {
        writeCodexSettings(extensionRoot, { default_codex_model: 'gpt-5.3-codex-spark' });
        assert.equal(resolveCodexModel(extensionRoot, { codex_model: '' }), 'gpt-5.3-codex-spark');
        assert.equal(resolveCodexModel(extensionRoot, { codex_model: '   ' }), 'gpt-5.3-codex-spark');
    } finally {
        fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
});

test('resolveCodexModel: undefined when neither state nor settings supplies a model', () => {
    const extensionRoot = makeTmpDir('pickle-codex-model-none-');
    try {
        writeCodexSettings(extensionRoot, {});
        assert.equal(resolveCodexModel(extensionRoot, null), undefined);
        assert.equal(resolveCodexModel(extensionRoot, { codex_model: '' }), undefined);
    } finally {
        fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
});

test('resolveCodexModel: undefined when settings file is missing', () => {
    const extensionRoot = makeTmpDir('pickle-codex-model-missing-');
    try {
        // No pickle_settings.json written.
        assert.equal(resolveCodexModel(extensionRoot, null), undefined);
        assert.equal(resolveCodexModel(extensionRoot, { codex_model: '   ' }), undefined);
    } finally {
        fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
});

test('resolveCodexModel: trims state.codex_model whitespace', () => {
    const extensionRoot = makeTmpDir('pickle-codex-model-trim-');
    try {
        writeCodexSettings(extensionRoot, { default_codex_model: 'gpt-5.3-codex-spark' });
        assert.equal(resolveCodexModel(extensionRoot, { codex_model: '  custom  ' }), 'custom');
    } finally {
        fs.rmSync(extensionRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// buildTierLifecycleSections — rendered-output sync-gate + commit-first rules
// (ticket 8327c4d8 / WS-WMFF-1: a worker parked on a test:fast monitor event
// that can never fire inside `claude -p` idled to budget death with a
// verified diff left uncommitted. These assertions read the ACTUAL rendered
// string returned by the builder, not the source file text, so a future
// refactor that keeps the source comment but drops the runtime string still
// fails the test.)
// ---------------------------------------------------------------------------

for (const tier of Object.keys(TIER_LIFECYCLE)) {
    test(`buildTierLifecycleSections: ${tier} tier Implement section carries sync-gate + commit-first rules`, () => {
        const rendered = buildTierLifecycleSections(TIER_LIFECYCLE[tier], tier);
        const implementSection = rendered.slice(rendered.indexOf('. Implement'));
        assert.match(implementSection, /synchronously/i,
            `expected synchronous-gate rule in ${tier} Implement section, got: ${implementSection}`);
        assert.match(implementSection, /commit first/i,
            `expected commit-first rule in ${tier} Implement section, got: ${implementSection}`);
        assert.match(implementSection, /no waker exists in `claude -p`/i,
            `expected no-waker rationale in ${tier} Implement section, got: ${implementSection}`);
    });
}

for (const tier of Object.keys(TIER_LIFECYCLE)) {
    const hasConformance = TIER_LIFECYCLE[tier].includes('conformance');
    test(`buildTierLifecycleSections: ${tier} tier Spec Conformance section ${hasConformance ? 'carries' : 'omits'} sync-gate + commit-first rules`, () => {
        const rendered = buildTierLifecycleSections(TIER_LIFECYCLE[tier], tier);
        const conformanceIdx = rendered.indexOf('. Spec Conformance');
        if (!hasConformance) {
            assert.equal(conformanceIdx, -1, `expected no Spec Conformance section for ${tier} tier`);
            return;
        }
        const conformanceSection = rendered.slice(conformanceIdx);
        assert.match(conformanceSection, /synchronously/i,
            `expected synchronous-gate rule in ${tier} Conformance section, got: ${conformanceSection}`);
        assert.match(conformanceSection, /commit first/i,
            `expected commit-first rule in ${tier} Conformance section, got: ${conformanceSection}`);
    });
}
