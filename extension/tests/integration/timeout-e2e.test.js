// @tier: integration
/**
 * timeout-e2e — E2E timeout happy path integration test.
 *
 * Incident fixture: manager sleeps 95% of worker_timeout_seconds, writes an
 * artifact, then deactivates the session and exits 0. The mux-runner must NOT
 * send SIGTERM and must advance the iteration counter.
 *
 * Regression guard for incident 2026-04-22-35fb01bc:
 *   Before fix: timeoutHandle fired at worker_timeout_seconds → SIGTERM
 *   After fix: hangGuard is sole kill authority (MAX_ITERATION_SECONDS)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_BIN = path.resolve(__dirname, '../../bin/mux-runner.js');

// 15s → 60s outer / 12s → 45s inner: budget for system load when run alongside
// concurrent codex/tmux work. The test verifies "subprocess completes without
// SIGTERM"; fake claude sleeps 950ms. The artifact-existence check is the
// real assertion, not the wall-clock budget.
test('timeout-e2e: manager sleeps 95% of budget, writes artifact, iteration advances, no SIGTERM', { timeout: 60_000 }, () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-timeout-e2e-')));
    try {
        const sessionDir = path.join(base, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        const templatesDir = path.join(base, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(templatesDir, '_pickle-manager-prompt.md'), 'placeholder');

        const artifactPath = path.join(base, 'artifact.txt');

        // worker_timeout_seconds=1. Fake claude sleeps 950ms (95%), writes artifact,
        // deactivates, exits 0. Under old code: SIGTERM at 1s. Under fixed code: completes.
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

// Sleep 95% of worker_timeout_seconds (1s) — old timeoutHandle would fire at 1s
await sleep(950);

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
                ...process.env,
                EXTENSION_DIR: base,
                NODE_ENV: 'test',
                EXTENSION_DIR_TEST: '1',
                PATH: `${fakeBinDir}:${process.env.PATH}`,
                PICKLE_BACKEND: 'claude',
            },
            encoding: 'utf-8',
            timeout: 45_000,
        });

        // Artifact must exist — subprocess ran to completion unsigterm'd
        assert.ok(
            fs.existsSync(artifactPath),
            `artifact not written — subprocess was killed before completing (exit: ${result.status}, signal: ${result.signal}), stderr tail: ${String(result.stderr).slice(-500)}`,
        );
        assert.equal(fs.readFileSync(artifactPath, 'utf-8'), 'completed', 'artifact content correct');

        // mux-runner must not have been SIGKILL'd by spawnSync timeout
        assert.ok(result.signal !== 'SIGKILL', 'mux-runner must not be SIGKILL\'d by test timeout');

        // Session must be deactivated (subprocess wrote active=false)
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'session deactivated by subprocess');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

// 15s → 45s outer / 10s → 30s inner: budget for system load when run alongside
// concurrent codex/tmux work. Fake claude exits immediately; budget covers
// node spawn + module load + state-file deactivation under contention.
test('timeout-e2e: session deactivated by subprocess → mux-runner exits cleanly', { timeout: 45_000 }, () => {
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
                ...process.env,
                EXTENSION_DIR: base,
                NODE_ENV: 'test',
                EXTENSION_DIR_TEST: '1',
                PATH: `${fakeBinDir}:${process.env.PATH}`,
                PICKLE_BACKEND: 'claude',
            },
            encoding: 'utf-8',
            timeout: 30_000,
        });

        assert.ok(
            result.signal !== 'SIGKILL',
            `mux-runner must exit before spawnSync timeout (exit: ${result.status}, signal: ${result.signal}), stderr tail: ${String(result.stderr).slice(-500)}`,
        );
        const finalState = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(finalState.active, false, 'session deactivated');
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});
