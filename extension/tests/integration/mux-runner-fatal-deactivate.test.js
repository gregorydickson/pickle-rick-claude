// @tier: integration
/**
 * Regression guard for the un-deactivating [FATAL] path (BUG-2026-08-17 /
 * ticket 0b0c7424): mux-runner.ts's top-level `main().catch()` must stamp
 * `exit_reason` + `active: false` before `process.exit(1)`, so a genuine
 * LockError out of `StateManager.update` cannot leave `state.json.active`
 * stuck at `true` forever.
 *
 * Reproduction — `state.json.lock` is pre-created as a DIRECTORY. That wedges
 * every arm of the lock protocol deterministically, with no timing dependency:
 *   - `acquireLockFile`'s `linkSync` (state-manager.ts:312) gets EEXIST, i.e.
 *     "held by someone else", on every attempt;
 *   - `inspectLockFile` (state-manager.ts:232) cannot `readSync` a directory
 *     fd, so it returns null, so `tryStealStaleLock` (state-manager.ts:1165)
 *     refuses to steal ("can't read — holder may have released it").
 * `acquireLock` therefore burns its full maxLockRetries budget and throws
 * LockError (state-manager.ts:1140), whatever else the runner did first.
 *
 * Two earlier attempts at this fixture were both defeated by wall-clock, which
 * is why the lock is wedged structurally rather than merely held:
 *   1. Holding the lock and releasing it after a fixed 28s sleep. The runner
 *      spends longer than that in its startup gates (~46s measured), so the
 *      lock was always free again before it reached a contended write.
 *   2. Holding it for the child's whole life under this test process's own
 *      live pid. Two bugs: the payload must be `{pid, ts}` JSON to be read as
 *      a live holder at all (a bare pid string fails `isStaleLockSnapshot`'s
 *      `JSON.parse` shape check and is stolen on sight as corrupt), AND
 *      staleness is age-based — `staleLockTimeoutMs` is 30s while the retry
 *      budget is ~26.3s, so any lock the runner meets more than ~3.7s after
 *      it was stamped is stealable partway through the budget.
 * In both cases no crash fired, the runner fell through into its normal
 * iteration loop, and the fixture spawned real billable manager turns against
 * an empty working dir until the test timed out.
 *
 * Wedging the lock is safe for the assertions because the FATAL handler writes
 * through `forceWriteMutate` (state-manager.ts:1322), whose fallback arm is a
 * lock-free `forceWrite`.
 *
 * Two independent guards keep a non-crashing runner from ever billing again:
 * a fake `claude` on PATH that deactivates and exits 0, and max_iterations: 1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scrubGateEnv } from '../../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_BIN = path.resolve(__dirname, '../../bin/mux-runner.js');

// Measured 146s end-to-end: the runner's startup gates (~46s on the incident
// fixture) plus one full `acquireLock` budget (maxLockRetries=10 with capped
// exponential backoff, ~26.3s — types/index.ts:445) for each locked write it
// attempts against the wedged lock. 300s subprocess cap / 360s test cap is
// ~2x the measurement, so system load cannot turn the pass into a SIGTERM,
// while a genuinely hung child still cannot outlive the test.
// SERIAL: subprocess-timeout-coupling — manifested in .serial-tests.json.
const SUBPROCESS_CAP_MS = 300_000;

test('mux-runner FATAL path deactivates the session before exiting', { timeout: 360_000 }, () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-fatal-deactivate-')));
    const statePath = path.join(base, 'session', 'state.json');
    try {
        const sessionDir = path.join(base, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        const templatesDir = path.join(base, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(templatesDir, '_pickle-manager-prompt.md'), 'placeholder');

        fs.writeFileSync(statePath, JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 0,
            // Guard 2: even a runner that never crashes gets exactly one
            // iteration, so this fixture can never become a 100-turn runaway.
            max_iterations: 1,
            max_time_minutes: 720,
            worker_timeout_seconds: 60,
            original_prompt: 'fatal-deactivate regression test',
            working_dir: base,
        }, null, 2));

        const dataRoot = path.join(base, 'pickledata');
        fs.mkdirSync(dataRoot, { recursive: true });

        // Guard 1: a fake `claude` ahead of the real one on PATH. If the crash
        // path regresses and the runner reaches its manager spawn, it runs this
        // instead of a billable session, and terminates immediately.
        const fakeBinDir = path.join(base, 'fakebin');
        fs.mkdirSync(fakeBinDir, { recursive: true });
        const fakeClaude = path.join(fakeBinDir, 'claude');
        fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
import * as fs from 'node:fs';

const stateFile = process.env.PICKLE_STATE_FILE;
if (stateFile) {
    try {
        const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        s.active = false;
        fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
    } catch { /* best effort */ }
}
process.exit(0);
`);
        fs.chmodSync(fakeClaude, 0o755);

        // The structural wedge — see the header comment.
        fs.mkdirSync(`${statePath}.lock`);

        const result = spawnSync(process.execPath, [MUX_RUNNER_BIN, sessionDir], {
            env: {
                ...scrubGateEnv(),
                EXTENSION_DIR: base,
                NODE_ENV: 'test',
                EXTENSION_DIR_TEST: '1',
                PICKLE_DATA_ROOT: dataRoot,
                PATH: `${fakeBinDir}:${process.env.PATH}`,
                PICKLE_BACKEND: 'claude',
            },
            encoding: 'utf-8',
            timeout: SUBPROCESS_CAP_MS,
        });

        const stderrTail = String(result.stderr ?? '').slice(-500);
        assert.equal(
            result.signal,
            null,
            `mux-runner must exit on its own, not be killed at the ${SUBPROCESS_CAP_MS}ms cap — the crash path never fired; stderr tail: ${stderrTail}`,
        );
        assert.equal(result.status, 1, `mux-runner should exit 1 on the LockError crash path; stderr tail: ${stderrTail}`);

        const finalState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(finalState.active, false, 'FATAL handler must deactivate the session (active: false)');
        assert.equal(finalState.exit_reason, 'error', 'FATAL handler must stamp the existing "error" exit_reason');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
