// @tier: integration
// B-CITAIL T6 (R-TFP): the FR-B10 fixture spawns a fake-claude that sleeps 120% of
// its worker_timeout budget; under c=8 fast-tier load the subprocess is starved and
// killed before writing its artifact (Linux CI flake). Promoted to integration +
// serialized (tests/integration/.serial-tests.json) so it runs at
// --test-concurrency=1 with the full budget. Class: load-dependent-timeout.
/**
 * FR-B10 regression: fixture manager sleeps beyond worker_timeout_seconds,
 * writes an artifact, and completes without SIGTERM.
 *
 * Before the fix, timeoutHandle fired at worker_timeout_seconds and sent
 * SIGTERM — the artifact was never written. After the fix that handle was
 * removed, and it was the last manager-path timer deriving from that field.
 *
 * RE-SCOPED (AC-5 of prds/BUG-2026-08-17-serial-tier-attempt-2-measure-the-right-window.md).
 * The kill authorities today are hangGuardMs (14400s) and outputStallGuardMs (1800s)
 * — src/bin/mux-runner.ts:3956-3959 — and neither reads worker_timeout_seconds, which
 * survives on the manager path only as startup validation, per-ticket tier caching and
 * post-hoc timeout telemetry. Asserting against either live guard from a spawned bin is
 * not possible: the only override is runIteration's in-process runtimeOverrides
 * parameter (:4249), and the sole production call site passes none (:11382).
 *
 * So this fixture asserts the observable NEGATIVE: a manager subprocess that outlives
 * worker_timeout_seconds is not killed. The 1200ms sleep against a 1s budget is 120%,
 * which is what makes that evidence rather than a coincidence — the title said 95%
 * until AC-5, contradicting the fixture's own arithmetic. The sleep is the sound half
 * of the pair, so the title moved and the number did not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scrubGateEnv } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMUX_RUNNER_BIN = path.resolve(__dirname, '../bin/mux-runner.js');

// 15s → 60s outer / 12s → 45s inner: budget for system load when run alongside
// concurrent codex/tmux work. The test verifies "subprocess completes without
// SIGTERM at worker_timeout_seconds=1s"; the fake claude sleeps 1200ms. The
// wall-clock budget is not the assertion — the artifact-existence check is.
test('FR-B10: fixture manager sleeps 120% of its worker_timeout budget, writes artifact, no SIGTERM', { timeout: 60_000 }, () => {
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

        // worker_timeout_seconds = 1. The removed timeoutHandle fired at 1s.
        // Fake claude sleeps 1200ms — 120% of that budget — then writes artifact and
        // exits; it would have been SIGTERM'd under the old code. Today the nearest
        // kill authority is hangGuard at MAX_ITERATION_SECONDS (14400s), so it completes.
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

// Sleep 120% of worker_timeout_seconds (1s), well within MAX_ITERATION_SECONDS
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
                ...scrubGateEnv(),
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
