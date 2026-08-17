// @tier: integration
// B-CITAIL T6 (R-TFP): the FR-B10 fixture spawns a fake-claude that sleeps ~95% of
// its worker_timeout budget; under c=8 fast-tier load the subprocess is starved and
// killed before writing its artifact (Linux CI flake). Promoted to integration +
// serialized (tests/integration/.serial-tests.json) so it runs at
// --test-concurrency=1 with the full budget. Class: load-dependent-timeout.
/**
 * FR-B10 regression: fixture manager sleeps beyond worker_timeout_seconds,
 * writes an artifact, and completes without SIGTERM.
 *
 * Before the fix, timeoutHandle fired at worker_timeout_seconds and sent
 * SIGTERM — the artifact was never written. After the fix (timeoutHandle
 * removed), hangGuard is the only kill authority (at MAX_ITERATION_SECONDS),
 * so a subprocess that finishes before MAX_ITERATION_SECONDS completes cleanly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMUX_RUNNER_BIN = path.resolve(__dirname, '../bin/mux-runner.js');

// 15s → 60s outer / 12s → 45s inner: budget for system load when run alongside
// concurrent codex/tmux work. The test verifies "subprocess completes without
// SIGTERM at worker_timeout_seconds=1s"; the fake claude sleeps 1200ms. The
// wall-clock budget is not the assertion — the artifact-existence check is.
test('FR-B10: fixture manager sleeps 95% of worker_timeout budget, writes artifact, no SIGTERM', { timeout: 60_000 }, () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-happy-path-')));
    try {
        const sessionDir = path.join(dir, 'session');
        fs.mkdirSync(sessionDir, { recursive: true });

        // Templates dir so runIteration gets past template validation
        const templatesDir = path.join(dir, 'templates');
        fs.mkdirSync(templatesDir, { recursive: true });
        fs.writeFileSync(path.join(templatesDir, '_pickle-manager-prompt.md'), 'placeholder');

        // Artifact file the fake claude will write after its sleep
        const artifactPath = path.join(dir, 'artifact.txt');

        // worker_timeout_seconds = 1. Old timeoutHandle would fire at 1s.
        // Fake claude sleeps 1200ms (> 1s) then writes artifact and exits — would
        // have been SIGTERM'd under old code. hangGuard fires at MAX_ITERATION_SECONDS
        // (14400s) so the fake claude completes safely.
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 0,
            max_iterations: 100,
            max_time_minutes: 720,
            worker_timeout_seconds: 1,
            original_prompt: 'happy-path regression test',
            working_dir: dir,
        }, null, 2));

        // Fake claude: sleep 1200ms (> worker_timeout_seconds of 1s), write artifact,
        // deactivate session so the mux-runner outer loop exits, then exit 0.
        const fakeBinDir = path.join(dir, 'fakebin');
        fs.mkdirSync(fakeBinDir, { recursive: true });
        const fakeClaude = path.join(fakeBinDir, 'claude');
        fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import * as fs from 'node:fs';

// Sleep beyond worker_timeout_seconds (1s) but well within MAX_ITERATION_SECONDS
await sleep(1200);

// Write the artifact — proves we were not SIGTERM'd at 1s
fs.writeFileSync(${JSON.stringify(artifactPath)}, 'completed');

// Deactivate so mux-runner loop exits after this iteration
const stateFile = process.env.PICKLE_STATE_FILE;
if (stateFile) {
    try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        state.active = false;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch { /* best effort */ }
}

process.exit(0);
`);
        fs.chmodSync(fakeClaude, 0o755);

        const result = spawnSync(process.execPath, [TMUX_RUNNER_BIN, sessionDir], {
            env: {
                ...process.env,
                EXTENSION_DIR: dir,
                NODE_ENV: 'test',
                EXTENSION_DIR_TEST: '1',
                PATH: `${fakeBinDir}:${process.env.PATH}`,
                PICKLE_BACKEND: 'claude',
            },
            encoding: 'utf-8',
            timeout: 45_000,
        });

        // Artifact must exist — proves the subprocess ran to completion unsigterm'd
        assert.ok(
            fs.existsSync(artifactPath),
            `Artifact not written — subprocess was killed before completing (exit: ${result.status}, signal: ${result.signal}), stderr tail: ${String(result.stderr).slice(-500)}`,
        );
        assert.equal(
            fs.readFileSync(artifactPath, 'utf8'),
            'completed',
            'Artifact content must be "completed"',
        );

        // mux-runner must have exited (not timed out by spawnSync)
        assert.ok(result.signal !== 'SIGKILL', 'mux-runner should not have been SIGKILL\'d by spawnSync timeout');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
