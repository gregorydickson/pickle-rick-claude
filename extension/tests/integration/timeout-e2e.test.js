// @tier: integration
/**
 * timeout-e2e — E2E timeout happy path integration test.
 *
 * Incident fixture: the manager subprocess runs past worker_timeout_seconds,
 * writes an artifact, then deactivates the session and exits 0.
 *
 * Regression provenance, incident 2026-04-22-35fb01bc:
 *   Before fix: timeoutHandle fired at worker_timeout_seconds → SIGTERM
 *   After fix: that handle was removed
 *
 * RE-SCOPED (AC-5 of prds/BUG-2026-08-17-serial-tier-attempt-2-measure-the-right-window.md).
 * The removed timeoutHandle is the last manager-path timer that ever derived from
 * worker_timeout_seconds. The kill authorities today are hangGuardMs (14400s) and
 * outputStallGuardMs (1800s) — src/bin/mux-runner.ts:3956-3959 — and neither reads
 * that field; it survives on the manager path only as startup validation (:7531),
 * per-ticket tier caching (:2125), and post-hoc timeout telemetry (:8101). Its one
 * timer lives on the spawn-morty worker path, which these ticket-less fixtures never
 * reach. Shrinking either live guard from a spawned bin is not possible — the only
 * override is runIteration's in-process runtimeOverrides parameter (:4249), and the
 * sole production call site passes none (:11382).
 *
 * So these fixtures assert the observable NEGATIVE instead: a manager subprocess that
 * outlives worker_timeout_seconds is not killed. That is a live property, and it is
 * evidence only while the sleep genuinely exceeds the configured budget.
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

// Budgets measured directly, not guessed. Per BUG-2026-08-18-timeout-e2e-measured-budgets
// AC-4: 3 uncapped runs of this exact fixture (real mux-runner.js spawn, no spawnSync cap)
// on the reference machine measured 62.06s / 53.70s / 52.91s elapsed, exit 0, signal null,
// artifact written every time — confirming fixture-cap-defect, not a runtime defect (the
// prior "for system load" comment was never measured and undersold the true magnitude: the
// old 45s inner / 60s outer caps sat BELOW the slowest observed run). New caps: inner
// spawnSync timeout = ceil(62.06 * 1.5) rounded to the nearest 5s = 95s (95_000ms, ~53%
// margin over the slowest run); outer node-test timeout = inner + 15s = 110s (110_000ms),
// so the test wrapper always has runway past the inner cap. The fake claude still sleeps
// 1500ms — 150% of the 1s worker_timeout_seconds below — and the artifact-existence check
// remains the real assertion, not the wall-clock budget.
test('timeout-e2e: manager runs 150% of worker_timeout_seconds unkilled, writes artifact', { timeout: 110_000 }, () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-timeout-e2e-')));
    try {
        const sessionDir = path.join(base, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        const templatesDir = path.join(base, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(templatesDir, '_pickle-manager-prompt.md'), 'placeholder');

        const artifactPath = path.join(base, 'artifact.txt');

        // worker_timeout_seconds=1. Fake claude sleeps 1500ms (150%), writes artifact,
        // deactivates, exits 0. Under the removed timeoutHandle: SIGTERM at 1s. Today no
        // manager-path timer reads this field, so the subprocess runs to completion.
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 0,
            max_iterations: 100,
            max_time_minutes: 720,
            worker_timeout_seconds: 1,
            original_prompt: 'timeout e2e regression test',
            working_dir: base,
        }, null, 2));

        const fakeBinDir = path.join(base, 'fakebin');
        fs.mkdirSync(fakeBinDir, { recursive: true });
        const fakeClaude = path.join(fakeBinDir, 'claude');
        fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import * as fs from 'node:fs';

// Sleep 150% of worker_timeout_seconds (1s) — the removed timeoutHandle fired at 1s
await sleep(1500);

// Write artifact — proves we were NOT SIGTERM'd
fs.writeFileSync(${JSON.stringify(artifactPath)}, 'completed');

// Deactivate so mux-runner outer loop exits
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

        const result = spawnSync(process.execPath, [MUX_RUNNER_BIN, sessionDir], {
            env: {
                ...scrubGateEnv(),
                EXTENSION_DIR: base,
                NODE_ENV: 'test',
                EXTENSION_DIR_TEST: '1',
                PATH: `${fakeBinDir}:${process.env.PATH}`,
                PICKLE_BACKEND: 'claude',
            },
            encoding: 'utf-8',
            timeout: 95_000,
        });

        // Artifact must exist — subprocess ran to completion unsigterm'd. Distinguish a
        // signalled kill from a self-exit unconditionally: `signal: null` with a non-zero
        // status is never a kill, it's the subprocess exiting on its own before finishing.
        const artifactFailureDescription = result.signal !== null
            ? `killed by signal ${result.signal}`
            : `exited with status ${result.status} (no signal — not a kill)`;
        assert.ok(
            fs.existsSync(artifactPath),
            `artifact not written — subprocess ${artifactFailureDescription} before completing, stderr tail: ${String(result.stderr).slice(-500)}`,
        );
        assert.equal(fs.readFileSync(artifactPath, 'utf-8'), 'completed', 'artifact content correct');

        // mux-runner must not have been killed by the spawnSync cap. spawnSync kills a timed-out
        // child with killSignal, which defaults to SIGTERM — so a SIGKILL-only check passes
        // silently on a capped child. A clean exit carries no signal at all.
        assert.equal(
            result.signal,
            null,
            `mux-runner must exit before the spawnSync timeout (exit: ${result.status}, signal: ${result.signal})`,
        );

        // Session must be deactivated (subprocess wrote active=false)
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'session deactivated by subprocess');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// Budgets measured directly, not guessed. Per BUG-2026-08-18-timeout-e2e-measured-budgets
// AC-4: 3 uncapped isolated runs of this exact fixture measured 50.90s / 51.34s / 50.83s
// elapsed, exit 0, signal null every time — same fixture-cap-defect class as the sibling
// test above. Isolated measurement does NOT predict in-tier wall-clock: a manager-run full
// `npm run test:integration:serial` pass observed this test taking 90615ms under real
// serial-tier load (7 files ahead of it at --test-concurrency=1) — 77% higher than the
// isolated 51.34s. Re-budgeted from the in-tier floor: inner spawnSync timeout =
// ceil(90.615 * 1.56) rounded to the nearest 5s = 145s (145_000ms, ~60% margin over the
// in-tier measurement); outer node-test timeout = inner + 15s = 160s (160_000ms). The prior
// "for system load" comment was never measured, and both the old 30s inner / 45s outer caps
// and the first re-budget (80s / 95s, isolated-only) sat BELOW the true in-tier wall-clock.
//
// NOT re-scoped by AC-5, deliberately. Unlike its sibling above, this test makes no
// claim about worker_timeout_seconds: nothing sleeps, so no timer of any duration is
// exercised and the 60 below is inert — present only to satisfy validateStartupState's
// "must be > 0" check (src/bin/mux-runner.ts:7544-7545). The title claims deactivation
// and a clean exit, and both are asserted, so there is no dead premise here to reconcile.
test('timeout-e2e: session deactivated by subprocess → mux-runner exits cleanly', { timeout: 160_000 }, () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-timeout-e2e2-')));
    try {
        const sessionDir = path.join(base, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        const templatesDir = path.join(base, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(templatesDir, '_pickle-manager-prompt.md'), 'placeholder');

        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 0,
            max_iterations: 100,
            max_time_minutes: 720,
            worker_timeout_seconds: 60,
            original_prompt: 'timeout e2e deactivation test',
            working_dir: base,
        }, null, 2));

        const fakeBinDir = path.join(base, 'fakebin');
        fs.mkdirSync(fakeBinDir, { recursive: true });
        const fakeClaude = path.join(fakeBinDir, 'claude');
        // Immediately deactivate and exit — no sleeping
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

        const result = spawnSync(process.execPath, [MUX_RUNNER_BIN, sessionDir], {
            env: {
                ...scrubGateEnv(),
                EXTENSION_DIR: base,
                NODE_ENV: 'test',
                EXTENSION_DIR_TEST: '1',
                PATH: `${fakeBinDir}:${process.env.PATH}`,
                PICKLE_BACKEND: 'claude',
            },
            encoding: 'utf-8',
            timeout: 145_000,
        });

        // spawnSync's cap kill uses killSignal (default SIGTERM), so asserting only on SIGKILL lets
        // a capped child pass. Any signal at all means the cap fired; a clean exit reports null.
        assert.equal(
            result.signal,
            null,
            `mux-runner must exit before spawnSync timeout (exit: ${result.status}, signal: ${result.signal}), stderr tail: ${String(result.stderr).slice(-500)}`,
        );
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'session deactivated');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
