// @tier: fast
/**
 * Verifies the EPIC_COMPLETED recovery state machine end-to-end. Runs
 * mux-runner.js as a subprocess with a fake `claude` that emits
 * EPIC_COMPLETED on every iteration while a second ticket remains pending.
 *
 * History: pre-v1.57 this path exited 1 on the FIRST false EPIC_COMPLETED
 * (the "pending-tickets guard"). That cost an entire pipeline run for one
 * misfiring token. The replacement structural recovery: log loudly, mark
 * the manager's claim as a TASK_COMPLETED retry, and only bail with
 * `manager_persistent_hallucination` after the same ticket misbehaves
 * `FALSE_EPIC_THRESHOLD` times in a row. This test asserts both halves —
 * the per-iteration `MANAGER_FALSE_EPIC_COMPLETED` log AND the eventual
 * `MANAGER_PERSISTENT_HALLUCINATION` exit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_BIN = path.resolve(__dirname, '../bin/mux-runner.js');

function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-guard-log-')));
}

function buildSession(tmpRoot) {
    const extDir = path.join(tmpRoot, 'ext');
    const templatesDir = path.join(extDir, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    // B-CITAIL T5: sentinel so getExtensionRoot() ACCEPTS extDir instead of
    // falling back to the canonical deployed root (~/.claude/pickle-rick), which
    // exists on a dev box but is ABSENT on CI (no install.sh) — there the fallback
    // resolves the template/recovery path against a missing root and the
    // false-EPIC_COMPLETED recovery log is never emitted.
    fs.writeFileSync(path.join(extDir, '.pickle-install-root'), '');

    // Minimal pickle_settings.json with CB disabled so the recovery loop
    // isn't short-circuited by a CB trip before persistent_hallucination
    // fires. Set max_iterations comfortably above FALSE_EPIC_THRESHOLD so
    // the recovery hits the persistent-hallucination exit, not the
    // max-iterations exit.
    fs.writeFileSync(
        path.join(extDir, 'pickle_settings.json'),
        JSON.stringify({
            default_max_iterations: 50,
            default_max_time_minutes: 720,
            default_worker_timeout_seconds: 1200,
            default_manager_max_turns: 50,
            default_tmux_max_turns: 200,
            default_refinement_cycles: 3,
            default_refinement_max_turns: 100,
            default_meeseeks_model: 'sonnet',
            default_meeseeks_min_passes: 10,
            default_meeseeks_max_passes: 20,
            circuit_breaker: { enabled: false },
        })
    );

    // Minimal template so runIteration can build a prompt without install.sh.
    fs.writeFileSync(path.join(templatesDir, '_pickle-manager-prompt.md'), '# Test\n$ARGUMENTS\n');

    const sessionDir = path.join(tmpRoot, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    // Ticket A — current ticket (still Todo; guard excludes it from pending check).
    const tickADir = path.join(sessionDir, 'tickA');
    fs.mkdirSync(tickADir, { recursive: true });
    fs.writeFileSync(
        path.join(tickADir, 'rick_ticket_tickA.md'),
        ['---', 'id: tickA', 'title: Ticket A', 'status: Todo', 'order: 1', '---', '', '# Ticket A'].join('\n')
    );

    // Ticket B — pending; will cause the guard to fire.
    const tickBDir = path.join(sessionDir, 'tickB');
    fs.mkdirSync(tickBDir, { recursive: true });
    fs.writeFileSync(
        path.join(tickBDir, 'rick_ticket_tickB.md'),
        ['---', 'id: tickB', 'title: Ticket B', 'status: Todo', 'order: 2', '---', '', '# Ticket B'].join('\n')
    );

    fs.writeFileSync(
        path.join(sessionDir, 'state.json'),
        JSON.stringify({
            active: true,
            // Live pid so the R-PTSB-3 phantom-demotion guard does not demote
            // this active fixture on read before the guard-logging path runs.
            pid: process.pid,
            working_dir: tmpRoot,
            step: 'implement',
            iteration: 0,
            max_iterations: 50,
            max_time_minutes: 720,
            worker_timeout_seconds: 1200,
            start_time_epoch: Math.floor(Date.now() / 1000),
            completion_promise: null,
            original_prompt: 'guard logging test',
            current_ticket: 'tickA',
            history: [],
            started_at: new Date().toISOString(),
            session_dir: sessionDir,
            schema_version: 1,
            chain_meeseeks: false,
        }, null, 2)
    );

    // Fake claude: emits EPIC_COMPLETED in stream-json assistant format then exits 0.
    const fakeBinDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeClaudePath = path.join(fakeBinDir, 'claude');
    fs.writeFileSync(
        fakeClaudePath,
        '#!/bin/sh\necho \'{"type":"assistant","message":{"content":[{"type":"text","text":"<promise>EPIC_COMPLETED</promise>"}]}}\'\n'
    );
    fs.chmodSync(fakeClaudePath, 0o755);

    return { extDir, sessionDir, fakeBinDir };
}

test('guard-logging: false EPIC_COMPLETED triggers structural recovery (not exit-1) and eventually exits with manager_persistent_hallucination', () => {
    const tmpRoot = makeTmpRoot();
    try {
        const { extDir, sessionDir, fakeBinDir } = buildSession(tmpRoot);
        const expectedLogPath = path.join(sessionDir, 'tmux_iteration_1.log');

        const result = spawnSync(process.execPath, [MUX_RUNNER_BIN, sessionDir], {
            env: {
                ...process.env,
                EXTENSION_DIR: extDir,
                PATH: `${fakeBinDir}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
                PICKLE_BACKEND: 'claude',
            },
            encoding: 'utf-8',
            // 60s budget: the recovery loop runs FALSE_EPIC_THRESHOLD+1
            // iterations spawning the fake claude shim each time.
            timeout: 60000,
        });

        const output = (result.stderr ?? '') + (result.stdout ?? '');

        // Should ALWAYS exit non-zero — but on the persistent-hallucination
        // exit class, NOT on the first-false-EPIC fail-loud (which has been
        // replaced with structural recovery).
        assert.equal(
            result.status, 1,
            `Expected exit code 1 from manager_persistent_hallucination. Got ${result.status}. Output:\n${output}`
        );

        // Recovery must have logged the false-EPIC marker at least once
        // (every recovery iteration emits it).
        assert.ok(
            output.includes('MANAGER_FALSE_EPIC_COMPLETED'),
            `Expected MANAGER_FALSE_EPIC_COMPLETED log line from recovery. Got:\n${output}`
        );

        // Eventual bail with the persistent-hallucination class.
        assert.ok(
            output.includes('MANAGER_PERSISTENT_HALLUCINATION'),
            `Expected MANAGER_PERSISTENT_HALLUCINATION exit class. Got:\n${output}`
        );

        // Iteration log path is preserved in the recovery message for
        // operator triage (kept from the prior fail-loud version).
        assert.ok(
            output.includes('Iteration log:'),
            `Expected "Iteration log:" in recovery message. Got:\n${output}`
        );

        assert.ok(
            output.includes(expectedLogPath),
            `Expected absolute log path "${expectedLogPath}" in recovery message. Got:\n${output}`
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('guard-logging: compiled mux-runner.js embeds iterLogFile in the recovery / hallucination messages', () => {
    const compiled = fs.readFileSync(path.resolve(__dirname, '../bin/mux-runner.js'), 'utf-8');
    assert.ok(
        /Iteration log:.*iterLogFile|iterLogFile.*Iteration log:/.test(compiled),
        'Expected "Iteration log:" + iterLogFile concatenation in compiled mux-runner.js'
    );
});
