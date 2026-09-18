// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { showStatus, computeConsecutiveNoProgress } from '../bin/status.js';
import { writePipelineStatus } from '../bin/pipeline-runner.js';

const DEAD_TMP_PID = 99_999_999;

/**
 * All tests use EXTENSION_DIR to isolate from the real ~/.claude/pickle-rick/.
 * A temp dir stands in as the extension root; current_sessions.json is
 * created (or not) inside that temp dir as each test requires.
 */

function withExtensionDir(fn) {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-')));
    const saved = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = tmpDir;
    try {
        return fn(tmpDir);
    } finally {
        if (saved === undefined) {
            delete process.env.EXTENSION_DIR;
        } else {
            process.env.EXTENSION_DIR = saved;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Capture all stdout output (both console.log and process.stdout.write)
 * during the execution of `fn`. Returns the concatenated output string.
 */
function captureStdout(fn) {
    const chunks = [];
    const origWrite = process.stdout.write;
    process.stdout.write = function (chunk, ...args) {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
    };
    try {
        fn();
    } finally {
        process.stdout.write = origWrite;
    }
    return chunks.join('');
}

// --- No sessions map ---

test('showStatus: prints "No active" when sessions map does not exist', () => {
    withExtensionDir(() => {
        // No current_sessions.json created — dir is empty
        const output = captureStdout(() => showStatus('/some/fake/cwd'));
        assert.ok(
            output.includes('No active Pickle Rick session'),
            `Expected "No active Pickle Rick session" in output, got: ${output}`
        );
    });
});

// --- Corrupt sessions map ---

test('showStatus: prints "unreadable" when sessions map is corrupt JSON', () => {
    withExtensionDir((tmpDir) => {
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            '{{{{ not valid json !!!!'
        );
        const output = captureStdout(() => showStatus('/some/fake/cwd'));
        assert.ok(
            output.includes('No active Pickle Rick session'),
            `Expected "No active Pickle Rick session" in output, got: ${output}`
        );
    });
});

// --- CWD not in map ---

test('showStatus: prints "No active" when cwd is not in sessions map', () => {
    withExtensionDir((tmpDir) => {
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ '/other/project': '/some/session/dir' })
        );
        const output = captureStdout(() => showStatus('/my/project'));
        assert.ok(
            output.includes('No active Pickle Rick session'),
            `Expected "No active Pickle Rick session" in output, got: ${output}`
        );
    });
});

// --- Session dir doesn't exist ---

test('showStatus: prints "No active" when mapped session dir does not exist on disk', () => {
    withExtensionDir((tmpDir) => {
        const fakeCwd = '/tmp/pickle-status-test-cwd';
        const missingSession = '/tmp/pickle-nonexistent-session-dir-xyz';
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: missingSession })
        );
        const output = captureStdout(() => showStatus(fakeCwd));
        assert.ok(
            output.includes('No active Pickle Rick session'),
            `Expected "No active Pickle Rick session" in output, got: ${output}`
        );
    });
});

// --- Happy path ---

test('showStatus: does not throw with valid sessions map and state.json', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';

        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                step: 'implement',
                iteration: 3,
                max_iterations: 10,
                current_ticket: 'TICKET-1',
                original_prompt: 'Build the thing',
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            // Should contain the panel title and key fields
            assert.ok(output.includes('Session Status'), `Expected panel title in output, got: ${output}`);
            assert.ok(output.includes('implement'), `Expected phase "implement" in output, got: ${output}`);
            assert.ok(output.includes('TICKET-1'), `Expected ticket "TICKET-1" in output, got: ${output}`);
            assert.ok(output.includes('Worker test gate timeout'), `Expected timeout field in output, got: ${output}`);
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

test('pickle-status continued to remediation: shows recoverable pickle summary from activity', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';

        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(path.join(sessionDir, 'pipeline-status.json'), JSON.stringify({
            status: 'completed',
            current_phase: null,
            completed_phases: 3,
            skipped_phases: 0,
            total_phases: 4,
            updated_at: new Date().toISOString(),
        }));
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                step: 'completed',
                iteration: 3,
                max_iterations: 10,
                current_ticket: 'TICKET-RECOVERABLE',
                original_prompt: 'Recover after pickle fail',
                activity: [
                    {
                        event: 'recoverable_phase_failure',
                        ts: new Date().toISOString(),
                        phase: 'pickle',
                        exit_code: 1,
                        fatal: false,
                        decision: 'continue',
                    },
                ],
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            assert.match(
                output,
                /Phase pickle exited with code 1 — pipeline continued to remediation/,
                `Expected continued-to-remediation summary, got: ${output}`
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER148-02: the recap's numerator is a MEASUREMENT, not a literal.
//
// It used to count `phase_completed` activity entries. No producer has ever
// emitted that event -- it is absent from VALID_ACTIVITY_EVENTS and from
// activity-events.schema.json, and `git log -S` shows the reader landed
// (ee5019c4) as a pure addition with no writer. Measured over the 16 real
// sessions on the authoring box: every one printed `0/4`, six of them after
// completing all four phases. The prior fixture hand-wrote three phantom
// events AND set the live `completed_phases` to 0, so the pin was green over
// a channel the runtime never fills.
//
// Both cases below drive the REAL producer (`writePipelineStatus`, the sole
// writer of pipeline-status.json) into the REAL reader (`showStatus`). The
// activity array deliberately carries NO phase_completed entries -- the number
// must come from the produced record.
// ---------------------------------------------------------------------------

function withRecapSession(fn) {
    return withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                step: 'completed',
                iteration: 4,
                max_iterations: 10,
                current_ticket: 'TICKET-RECAP',
                original_prompt: 'Summarize completed phases',
                activity: [{ event: 'session_started', ts: new Date().toISOString() }],
            })
        );
        try {
            return fn(sessionDir, fakeCwd);
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
}

test('pickle-status recap: reports the phase count the pipeline actually produced', () => {
    withRecapSession((sessionDir, fakeCwd) => {
        // The real writer, exactly as finalizePipeline calls it.
        writePipelineStatus(sessionDir, 'completed', {
            current_phase: null,
            completed_phases: 4,
            skipped_phases: 0,
            total_phases: 4,
        });

        const produced = JSON.parse(
            fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8')
        );
        assert.equal(produced.completed_phases, 4, 'precondition: the producer recorded 4');

        const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(
            state.activity.filter((e) => e?.event === 'phase_completed').length,
            0,
            'precondition: no phase_completed events exist -- this is the production shape'
        );

        const output = captureStdout(() => showStatus(fakeCwd));
        assert.match(
            output,
            /Pipeline recap: 4\/4 phases completed/,
            `A fully-completed pipeline must not recap as 0/4, got: ${output}`
        );
    });
});

test('pickle-status recap: a partially-completed pipeline reports its own shortfall', () => {
    // The negative control: the numerator must TRACK the producer, not be a
    // constant that happens to match the denominator. Same wire, different value.
    withRecapSession((sessionDir, fakeCwd) => {
        writePipelineStatus(sessionDir, 'failed', {
            current_phase: null,
            completed_phases: 2,
            skipped_phases: 0,
            total_phases: 4,
        });

        const output = captureStdout(() => showStatus(fakeCwd));
        assert.match(
            output,
            /Pipeline recap: 2\/4 phases completed/,
            `Expected the produced shortfall 2/4, got: ${output}`
        );
        assert.doesNotMatch(
            output,
            /Pipeline recap: 4\/4 phases completed/,
            'the numerator must not be the denominator'
        );
    });
});

test('pickle-status recap: recovers pipeline-status.json from orphan tmp when base is absent', () => {
    // Regression: status.ts must promote a newer `.tmp.<pid>` pipeline-status.json
    // snapshot (left by an interrupted tmp-rename write) instead of raw-reading the
    // absent/stale base file. Sibling readers (monitor.ts, pipeline-runner.ts) already
    // use readRecoverableJsonObject; status.ts had drifted to raw JSON.parse.
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';
        const ts = new Date().toISOString();

        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        // No base pipeline-status.json — only a dead-pid recoverable tmp snapshot.
        const statusPath = path.join(sessionDir, 'pipeline-status.json');
        fs.writeFileSync(`${statusPath}.tmp.${DEAD_TMP_PID}`, JSON.stringify({
            status: 'completed',
            current_phase: null,
            completed_phases: 1,
            skipped_phases: 0,
            total_phases: 4,
            updated_at: ts,
        }));
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                step: 'completed',
                iteration: 1,
                max_iterations: 10,
                current_ticket: 'TICKET-ORPHAN',
                original_prompt: 'Recover pipeline-status from tmp',
                // AP-EXT-ITER148-02: no phantom `phase_completed` fixture -- the
                // recovered tmp snapshot supplies BOTH halves of the ratio.
                activity: [{ event: 'session_started', ts }],
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            // With the raw-read bug total_phases would be 0 ("1/0"); the recovered
            // tmp supplies total_phases=4.
            assert.match(
                output,
                /Pipeline recap: 1\/4 phases completed/,
                `Expected recovered total_phases from orphan tmp, got: ${output}`
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

test('pickle-status recoverable count: shows total recoverable_phase_failure events', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';
        const ts = new Date().toISOString();

        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(path.join(sessionDir, 'pipeline-status.json'), JSON.stringify({
            status: 'failed',
            current_phase: null,
            completed_phases: 0,
            skipped_phases: 0,
            total_phases: 4,
            updated_at: ts,
        }));
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                step: 'completed',
                iteration: 4,
                max_iterations: 10,
                current_ticket: 'TICKET-FAILURES',
                original_prompt: 'Count recoverable failures',
                activity: [
                    { event: 'recoverable_phase_failure', ts, phase: 'pickle', exit_code: 1, fatal: false, decision: 'continue' },
                    { event: 'recoverable_phase_failure', ts, phase: 'anatomy-park', exit_code: 1, fatal: false, decision: 'continue' },
                ],
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            assert.match(
                output,
                /Recoverable phase failures: 2/,
                `Expected recoverable failure count in output, got: ${output}`
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

test('showStatus: renders resolved worker_test_gate_timeout_ms from settings', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-timeout-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';
        fs.mkdirSync(path.join(tmpDir, 'extension', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'extension', 'bin', 'log-watcher.js'), '');

        fs.writeFileSync(
            path.join(tmpDir, 'pickle_settings.json'),
            JSON.stringify({ worker_test_gate_timeout_ms: 3456 })
        );
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                step: 'implement',
                iteration: 3,
                max_iterations: 10,
                current_ticket: 'TICKET-1',
                original_prompt: 'Build the thing',
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            assert.ok(output.includes('Worker test gate timeout'), `Expected timeout label in output, got: ${output}`);
            assert.ok(output.includes('3456 ms'), `Expected resolved timeout value in output, got: ${output}`);
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

test('showStatus: falls back to active session state when the sessions map is missing', () => {
    withExtensionDir((tmpDir) => {
        const fakeCwd = path.join(tmpDir, 'repo');
        const sessionDir = path.join(tmpDir, 'sessions', 'fallback-session');
        fs.mkdirSync(fakeCwd, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                active: true,
                working_dir: fakeCwd,
                session_dir: sessionDir,
                step: 'implement',
                iteration: 2,
                max_iterations: 5,
                current_ticket: 'T-FALLBACK',
                original_prompt: 'Recover from missing map',
            })
        );

        const output = captureStdout(() => showStatus(fakeCwd));
        assert.ok(output.includes('Session Status'), `Expected panel title in output, got: ${output}`);
        assert.ok(output.includes('T-FALLBACK'), `Expected fallback ticket in output, got: ${output}`);
    });
});

test('showStatus: unreadable mapped state falls back to the live same-cwd session', () => {
    withExtensionDir((tmpDir) => {
        const fakeCwd = path.join(tmpDir, 'repo');
        const staleSessionDir = path.join(tmpDir, 'sessions', 'stale-session');
        const liveSessionDir = path.join(tmpDir, 'sessions', 'live-session');
        fs.mkdirSync(fakeCwd, { recursive: true });
        fs.mkdirSync(staleSessionDir, { recursive: true });
        fs.mkdirSync(liveSessionDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: staleSessionDir })
        );
        fs.writeFileSync(path.join(staleSessionDir, 'state.json'), '{{{corrupt json');
        fs.writeFileSync(
            path.join(liveSessionDir, 'state.json'),
            JSON.stringify({
                active: true,
                working_dir: fakeCwd,
                session_dir: liveSessionDir,
                step: 'implement',
                iteration: 4,
                max_iterations: 9,
                current_ticket: 'T-LIVE',
                original_prompt: 'Prefer the readable live session',
            })
        );

        const output = captureStdout(() => showStatus(fakeCwd));
        assert.ok(output.includes('Session Status'), `Expected panel title in output, got: ${output}`);
        assert.ok(output.includes('T-LIVE'), `Expected live session ticket in output, got: ${output}`);
        assert.ok(!output.includes('Session state is unreadable.'), `Should not report unreadable stale state, got: ${output}`);
    });
});

test('showStatus: prefers the crash-recovered orphan tmp snapshot over stale base state', () => {
    withExtensionDir((tmpDir) => {
        const fakeCwd = path.join(tmpDir, 'repo');
        const sessionDir = path.join(tmpDir, 'sessions', 'recovered-session');
        const statePath = path.join(sessionDir, 'state.json');
        fs.mkdirSync(fakeCwd, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        // Snapshots must satisfy isRecoverableStateSnapshotCandidate.
        const baseFields = {
            working_dir: fakeCwd,
            session_dir: sessionDir,
            max_iterations: 9,
            max_time_minutes: 60,
            worker_timeout_seconds: 120,
            start_time_epoch: Math.floor(Date.now() / 1000),
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
            schema_version: 1,
        };
        fs.writeFileSync(
            statePath,
            JSON.stringify({
                ...baseFields,
                active: true,
                step: 'implement',
                iteration: 1,
                current_ticket: 'T-BASE',
                original_prompt: 'Base state should lose to recovered tmp',
            })
        );
        const orphanPath = `${statePath}.tmp.${DEAD_TMP_PID}`;
        fs.writeFileSync(
            orphanPath,
            JSON.stringify({
                ...baseFields,
                active: false,
                step: 'verify',
                iteration: 7,
                current_ticket: 'T-RECOVERED',
                original_prompt: 'Recovered state should drive status output',
            })
        );

        const output = captureStdout(() => showStatus(fakeCwd));
        const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.ok(output.includes('T-RECOVERED'), `Expected recovered ticket in output, got: ${output}`);
        assert.ok(output.includes('verify'), `Expected recovered phase in output, got: ${output}`);
        assert.ok(output.includes('7 of 9'), `Expected recovered iteration in output, got: ${output}`);
        assert.ok(output.includes('No'), `Expected recovered inactive status in output, got: ${output}`);
        assert.equal(persisted.current_ticket, 'T-RECOVERED', 'recovered tmp should be promoted into state.json');
        assert.equal(fs.existsSync(orphanPath), false, 'orphan tmp should be consumed during recovery');
    });
});

// --- Truncates long prompts ---

test('showStatus: truncates original_prompt longer than 80 chars', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';

        const longPrompt = 'A'.repeat(120);
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                step: 'research',
                iteration: 1,
                max_iterations: 5,
                current_ticket: 'T-2',
                original_prompt: longPrompt,
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            // Strip ANSI codes and whitespace to get raw text for assertion
            const stripped = output.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, '');
            // The full 120-char prompt should NOT appear
            assert.ok(
                !stripped.includes(longPrompt),
                'Full long prompt should not appear in output'
            );
            // The truncation ellipsis must be present
            assert.ok(
                output.includes('\u2026'),
                `Expected ellipsis character in truncated output, got: ${output}`
            );
            // The first 80 chars should still be in the output (possibly word-wrapped)
            assert.ok(
                stripped.includes('A'.repeat(80)),
                `Expected first 80 chars of prompt in output, got: ${output}`
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

// --- Shows iteration with max ---

test('showStatus: shows "N of M" when max_iterations > 0', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';

        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                step: 'plan',
                iteration: 4,
                max_iterations: 12,
                current_ticket: 'T-3',
                original_prompt: 'Do something',
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            assert.ok(
                output.includes('4 of 12'),
                `Expected "4 of 12" in iteration output, got: ${output}`
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

// --- String numeric state fields (Number() coercion, deep review pass 6) ---

test('showStatus: string max_iterations and iteration are correctly coerced', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';

        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                step: 'implement',
                iteration: '3',        // string, not number
                max_iterations: '10',   // string, not number
                current_ticket: 'T-STR',
                original_prompt: 'test coercion',
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            // Should display "3 of 10", NOT "3 of 10" from string interpolation
            // and definitely not "undefined" or "NaN"
            assert.ok(
                output.includes('3 of 10'),
                `Expected "3 of 10" in output with string state values, got: ${output}`
            );
            assert.ok(
                !output.includes('NaN'),
                `Should not contain NaN, got: ${output}`
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

test('showStatus: string "0" for max_iterations does not show "N of 0"', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';

        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                step: 'prd',
                iteration: '2',
                max_iterations: '0',  // string "0" — truthy but should coerce to 0
                current_ticket: null,
                original_prompt: 'test zero string',
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            // String "0" is truthy, but Number("0") is 0 → should NOT show "of 0"
            assert.ok(
                !output.includes('of 0'),
                `Should NOT show "of 0" for string "0" max_iterations, got: ${output}`
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

// --- Active / Mode display (deep review pass 12) ---

test('showStatus: shows Active=Yes and Mode=inline for active non-tmux session', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';

        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                active: true,
                step: 'implement',
                iteration: 2,
                max_iterations: 10,
                current_ticket: 'T-ACT',
                original_prompt: 'test active display',
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            assert.ok(output.includes('Yes'), `Expected "Yes" for active session, got: ${output}`);
            assert.ok(output.includes('inline'), `Expected "inline" mode, got: ${output}`);
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

test('showStatus: shows Active=No for inactive session', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';

        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                active: false,
                step: 'implement',
                iteration: 5,
                max_iterations: 10,
                current_ticket: 'T-INACT',
                original_prompt: 'test inactive display',
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            assert.ok(output.includes('No'), `Expected "No" for inactive session, got: ${output}`);
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

test('showStatus: shows Mode=tmux for tmux_mode session', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';

        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                active: true,
                tmux_mode: true,
                step: 'research',
                iteration: 1,
                max_iterations: 50,
                current_ticket: 'T-TMUX',
                original_prompt: 'tmux mode test',
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            assert.ok(output.includes('tmux'), `Expected "tmux" mode, got: ${output}`);
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

// --- Shows iteration without max ---

test('showStatus: shows just the number when max_iterations is 0', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-session-'))
        );
        const fakeCwd = sessionDir + '-cwd';

        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                step: 'breakdown',
                iteration: 7,
                max_iterations: 0,
                current_ticket: 'T-4',
                original_prompt: 'Another task',
            })
        );

        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            // Should contain "7" but NOT "7 of 0"
            assert.ok(
                !output.includes('7 of 0'),
                `Should not contain "7 of 0" when max_iterations is 0, got: ${output}`
            );
            assert.ok(
                output.includes('7'),
                `Expected iteration number "7" in output, got: ${output}`
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

// --- Consecutive no_progress counter ---

const BASE_MICROVERSE_STATE = {
    status: 'iterating',
    prd_path: '/tmp/prd.md',
    gap_analysis_path: '',
    key_metric: { description: 'test metric', validation: 'echo 50', type: 'command', timeout_seconds: 5, tolerance: 2 },
    convergence: { stall_limit: 50, stall_counter: 0, history: [] },
    failure_history: [],
    failed_approaches: [],
    approach_exhaustion_fired: false,
    baseline_score: 0,
};

test('showStatus: shows Consecutive no_progress counter from microverse.json', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-mv-'))
        );
        const fakeCwd = sessionDir + '-cwd';
        const ts = new Date().toISOString();
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ step: 'implement', iteration: 5, max_iterations: 20, current_ticket: 'T-MV', original_prompt: 'Converge' })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'microverse.json'),
            JSON.stringify({
                ...BASE_MICROVERSE_STATE,
                failure_history: [
                    { iteration: 3, failure_class: 'no_progress', description: 'stall1', timestamp: ts },
                    { iteration: 4, failure_class: 'no_progress', description: 'stall2', timestamp: ts },
                ],
            })
        );
        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            assert.ok(
                output.includes('Consecutive no_progress'),
                `Expected "Consecutive no_progress" label in output, got: ${output}`
            );
            assert.ok(
                output.includes('2/3'),
                `Expected "2/3" in output for 2 consecutive no_progress entries, got: ${output}`
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

test('showStatus: shows [LLM bypass active] marker for LLM-judge sessions', () => {
    withExtensionDir((tmpDir) => {
        const sessionDir = fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-status-llm-'))
        );
        const fakeCwd = sessionDir + '-cwd';
        const ts = new Date().toISOString();
        fs.writeFileSync(
            path.join(tmpDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({ step: 'implement', iteration: 3, max_iterations: 20, current_ticket: 'T-LLM', original_prompt: 'Converge' })
        );
        fs.writeFileSync(
            path.join(sessionDir, 'microverse.json'),
            JSON.stringify({
                ...BASE_MICROVERSE_STATE,
                key_metric: { description: 'llm metric', validation: 'judge', type: 'llm', timeout_seconds: 30, tolerance: 0 },
                failure_history: [
                    { iteration: 1, failure_class: 'no_progress', description: 'stall1', timestamp: ts },
                    { iteration: 2, failure_class: 'no_progress', description: 'stall2', timestamp: ts },
                ],
            })
        );
        try {
            const output = captureStdout(() => showStatus(fakeCwd));
            assert.ok(
                output.includes('[LLM bypass active]'),
                `Expected "[LLM bypass active]" in output for LLM-judge session, got: ${output}`
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});

test('computeConsecutiveNoProgress: returns 0 for empty failure_history', () => {
    const mvState = { failure_history: [] };
    assert.equal(computeConsecutiveNoProgress(mvState), 0);
});

test('computeConsecutiveNoProgress: counts only recent no_progress (capped at 3)', () => {
    const ts = new Date().toISOString();
    const mvState = {
        failure_history: [
            { iteration: 1, failure_class: 'regression', description: 'r', timestamp: ts },
            { iteration: 2, failure_class: 'no_progress', description: 'n', timestamp: ts },
            { iteration: 3, failure_class: 'no_progress', description: 'n', timestamp: ts },
            { iteration: 4, failure_class: 'no_progress', description: 'n', timestamp: ts },
        ],
    };
    assert.equal(computeConsecutiveNoProgress(mvState), 3);
});
