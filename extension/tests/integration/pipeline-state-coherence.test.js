// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { respawnMonitorWindowForMode } from '../../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '../..');
const MUX_RUNNER_BIN = path.join(EXTENSION_ROOT, 'bin', 'mux-runner.js');

function makeTmpRoot() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-pipeline-state-')));
}

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function buildSession(tmpRoot) {
    const extDir = path.join(tmpRoot, 'ext');
    const templatesDir = path.join(extDir, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, '_pickle-manager-prompt.md'), '# Fixture\n$ARGUMENTS\n');
    writeJson(path.join(extDir, 'pickle_settings.json'), {
        default_max_iterations: 3,
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
    });

    const sessionDir = path.join(tmpRoot, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const statePath = path.join(sessionDir, 'state.json');
    writeJson(statePath, {
        active: true,
        // Live pid so the R-PTSB-3 phantom-demotion guard does not demote this
        // active fixture on read across the three-iteration coherence run.
        pid: process.pid,
        working_dir: tmpRoot,
        step: 'research',
        iteration: 0,
        max_iterations: 3,
        max_time_minutes: 720,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        completion_promise: null,
        original_prompt: 'pipeline state coherence fixture',
        current_ticket: 'coherence-ticket',
        history: [],
        activity: [],
        started_at: new Date().toISOString(),
        session_dir: sessionDir,
        schema_version: 1,
        chain_meeseeks: false,
    });

    const observationsPath = path.join(tmpRoot, 'observations.jsonl');
    const fakeBinDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeClaudePath = path.join(fakeBinDir, 'claude');
    fs.writeFileSync(
        fakeClaudePath,
        `#!/usr/bin/env node
const fs = require('fs');
const statePath = process.env.TEST_STATE_PATH;
const observationsPath = process.env.TEST_OBSERVATIONS_PATH;
const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
const nextByIteration = { 1: 'plan', 2: 'implement', 3: 'review' };
fs.appendFileSync(observationsPath, JSON.stringify({
  iteration: state.iteration,
  step: state.step,
  current_ticket: state.current_ticket
}) + '\\n');
const next = nextByIteration[state.iteration];
if (next && state.step !== next) {
  state.activity = Array.isArray(state.activity) ? state.activity : [];
  state.activity.push({
    event: 'phase_transition',
    source: 'test-fixture',
    iteration: state.iteration,
    previous_phase: state.step,
    next_phase: next,
    ticket: state.current_ticket
  });
  state.step = next;
}
if (state.iteration === 3) {
  state.activity.push({
    event: 'phase_transition',
    source: 'test-fixture',
    iteration: state.iteration,
    previous_phase: 'review',
    next_phase: 'completed',
    ticket: state.current_ticket
  });
}
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'continue fixture' }] } }));
`,
    );
    fs.chmodSync(fakeClaudePath, 0o755);

    return { extDir, sessionDir, fakeBinDir, observationsPath, statePath };
}

function readObservations(file) {
    return fs.readFileSync(file, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

function readActivityEvents(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    return fs.readdirSync(activityDir)
        .filter((name) => name.endsWith('.jsonl'))
        .flatMap((name) => fs.readFileSync(path.join(activityDir, name), 'utf-8')
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line)));
}

function countRunnerIterations(runnerLog) {
    const matches = runnerLog.match(/--- Iteration \d+(?: \(state\.iteration=\d+\))? ---/g);
    return matches ? matches.length : 0;
}

test('pipeline state stays coherent across a three-iteration mux-runner fixture', { timeout: 60000 }, () => {
    const tmpRoot = makeTmpRoot();
    try {
        const { extDir, sessionDir, fakeBinDir, observationsPath, statePath } = buildSession(tmpRoot);

        const result = spawnSync(process.execPath, [MUX_RUNNER_BIN, sessionDir], {
            cwd: EXTENSION_ROOT,
            env: {
                ...process.env,
                EXTENSION_DIR: extDir,
                // Without these, resolveExtensionRoot's sentinel check (extension/bin/log-watcher.js
                // under EXTENSION_DIR) fails and silently falls back to the canonical
                // ~/.claude/pickle-rick root. A dev machine with a real prior install masks this;
                // a fresh CI container has no canonical root and every downstream template/gate
                // lookup fails. EXTENSION_DIR_TEST is the sanctioned test-only bypass (see
                // resolveExtensionRoot / allowsMissingExtensionSentinelForTests in pickle-utils.ts).
                NODE_ENV: 'test',
                EXTENSION_DIR_TEST: '1',
                PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
                PICKLE_BACKEND: 'claude',
                PICKLE_DATA_ROOT: path.join(tmpRoot, 'pickle-data'),
                TEST_STATE_PATH: statePath,
                TEST_OBSERVATIONS_PATH: observationsPath,
            },
            encoding: 'utf-8',
            timeout: 60000,
        });

        const output = `${result.stderr ?? ''}${result.stdout ?? ''}`;
        // AC-M9 property pin (D2/abcd2712). The EXTENSION_DIR_TEST bypass set above is the ONLY
        // thing keeping this fixture pointed at its own extDir; without it resolveExtensionRoot
        // silently falls back to the canonical ~/.claude/pickle-rick root, which is populated on
        // any box that has run install.sh and EMPTY on a fresh CI container. That is why this test
        // was green on macOS and red on Linux CI.
        //
        // The fallback is announced on stderr by emitExtensionDirFallbackOnce on EVERY platform —
        // only its consequence is platform-dependent. Asserting its absence therefore turns a
        // Linux-only red into a red HERE: mutation-measured 2026-08-28 (macOS/Node 22.23.2),
        // removing the bypass leaves all other assertions GREEN and trips only this one.
        assert.ok(
            !output.includes('EXTENSION_DIR fallback'),
            `mux-runner fell back to the canonical extension root instead of the fixture's `
            + `EXTENSION_DIR — the fixture is measuring the host install, not itself:\n${output}`,
        );
        // Per R-CNAR-1 part 2 cap split (extension/CLAUDE.md trap door): once the
        // per-ticket budget (max_iterations=3) is consumed without an
        // EPIC_COMPLETED promise, mux-runner exits 3 with
        // exit_reason='iteration_cap_exhausted' via safeDeactivate (forensic path).
        // step/current_ticket are intentionally preserved for postmortem.
        assert.equal(result.status, 3, `expected exit 3 (iteration_cap_exhausted); output:\n${output}`);

        const runnerLogPath = path.join(sessionDir, 'mux-runner.log');
        assert.ok(fs.existsSync(runnerLogPath), 'mux-runner.log should exist');
        const runnerLog = fs.readFileSync(runnerLogPath, 'utf-8');
        const runnerIterationCount = countRunnerIterations(runnerLog);
        assert.equal(runnerIterationCount, 3, `expected three runner iterations; log:\n${runnerLog}`);

        const iterationLogs = fs.readdirSync(sessionDir)
            .filter((name) => /^tmux_iteration_\d+\.log$/.test(name))
            .sort();
        assert.deepEqual(iterationLogs, [
            'tmux_iteration_1.log',
            'tmux_iteration_2.log',
            'tmux_iteration_3.log',
        ]);

        const observations = readObservations(observationsPath);
        assert.deepEqual(
            observations.map((entry) => entry.iteration),
            [1, 2, 3],
            'backend should observe the same three iterations as mux-runner',
        );
        assert.deepEqual(
            observations.map((entry) => entry.step),
            ['research', 'plan', 'implement'],
            'step should advance coherently before each worker iteration',
        );
        assert.deepEqual(
            observations.map((entry) => entry.current_ticket),
            ['coherence-ticket', 'coherence-ticket', 'coherence-ticket'],
            'current_ticket should remain stable during active worker iterations',
        );

        const finalState = readJson(statePath);
        assert.equal(finalState.iteration, runnerIterationCount, 'state.iteration should match mux-runner.log iteration count');
        // Forensic preservation: cap-exhausted exits go through safeDeactivate, NOT
        // finalizeTerminalState. step and current_ticket survive for postmortem.
        // The fixture's iteration-3 worker advances state.step to 'review' before
        // the next loop iteration's cap-check fires.
        assert.equal(finalState.step, 'review', "terminal state.step should be 'review' (preserved from iteration 3 advance before cap check)");
        assert.equal(finalState.current_ticket, 'coherence-ticket', 'cap-exhausted forensic exit should preserve current_ticket');
        assert.equal(finalState.exit_reason, 'iteration_cap_exhausted', 'cap-exhausted exit must record exit_reason for auto-resume gating (R-CNAR-4)');
        assert.equal(finalState.active, false, 'safeDeactivate must clear active flag on cap exhaustion');

        const iterationStartEvents = readActivityEvents(path.join(tmpRoot, 'pickle-data'))
            .filter((entry) => entry.event === 'iteration_start');
        assert.deepEqual(
            iterationStartEvents.map((entry) => entry.iteration),
            [1, 2, 3],
            'activity log should contain one iteration_start event per runner iteration',
        );
        assert.equal(
            iterationStartEvents.length,
            runnerIterationCount,
            'iteration_start activity count should match mux-runner.log iteration count',
        );

        const phaseTransitions = (finalState.activity ?? []).filter((entry) => entry.event === 'phase_transition');
        assert.deepEqual(
            phaseTransitions.map((entry) => [entry.previous_phase, entry.next_phase]),
            [
                ['research', 'plan'],
                ['plan', 'implement'],
                ['implement', 'review'],
                ['review', 'completed'],
            ],
            'each phase boundary should emit phase_transition activity',
        );

        const observedAndTerminalSteps = [
            ...observations.map((entry) => entry.step),
            phaseTransitions[2]?.next_phase,
            phaseTransitions[3]?.next_phase,
            finalState.step,
        ];
        assert.deepEqual(
            observedAndTerminalSteps,
            ['research', 'plan', 'implement', 'review', 'completed', 'review'],
            'observed worker steps + activity-log phase transitions + cap-exhausted forensic state.step',
        );
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// R-MDS-1: respawnMonitorWindowForMode integration tests
//
// These drive the respawnMonitorWindowForMode that pipeline-runner actually
// calls at every phase boundary (services/monitor-window.ts, re-exported by
// pickle-utils). The mode argument is a monitor MODE forwarded verbatim to
// `monitor.js --mode`, and the ambient tmux session must carry this session
// dir's trailing hash or the call refuses to touch any pane.
// ---------------------------------------------------------------------------

const SESSION_HASH = 'abc12345';
const OWN_TMUX_SESSION = `pipeline-${SESSION_HASH}`;

function makeSessionDir(tmpRoot) {
    const sessionDir = path.join(tmpRoot, `2026-01-01-${SESSION_HASH}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
        active: true, step: 'anatomy-park', iteration: 1, schema_version: 1,
        working_dir: tmpRoot, max_iterations: 5, max_time_minutes: 720,
        worker_timeout_seconds: 1200, start_time_epoch: 0,
        completion_promise: null, original_prompt: '', current_ticket: null,
        history: [], activity: [], started_at: new Date().toISOString(),
        session_dir: sessionDir, chain_meeseeks: false,
    }));
    return sessionDir;
}

function readMonitorMode(sessionDir) {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8')).monitor_mode;
}

async function withRespawnSandbox(prefix, fn) {
    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    const prevDataRoot = process.env.PICKLE_DATA_ROOT;
    try {
        process.env.PICKLE_DATA_ROOT = path.join(tmpRoot, 'data');
        await fn(makeSessionDir(tmpRoot));
    } finally {
        if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prevDataRoot;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}

function ownSessionTmuxStub(captured, onRespawn = () => {}) {
    return (_cmd, args, _opts) => {
        captured.push([...args]);
        if (args[0] === 'display-message' && args.includes('#S')) return { status: 0, stdout: `${OWN_TMUX_SESSION}\n`, stderr: '' };
        // Pane pid unknown: a real-looking pid would become state.monitor_pid and be
        // signalled by the next respawn call's old-monitor reclaim.
        if (args[0] === 'display-message') return { status: 1, stdout: '', stderr: '' };
        if (args[0] === 'respawn-pane') onRespawn(args);
        return { status: 0, stdout: '', stderr: '' };
    };
}

test('respawnMonitorWindowForMode: respawns the monitor pane with the verbatim mode and records it', { timeout: 15000 }, async () => {
    await withRespawnSandbox('monitor-respawn-', async (sessionDir) => {
        const captured = [];
        const logs = [];
        const result = await respawnMonitorWindowForMode(sessionDir, 'anatomy-park', {
            inTmux: true, spawnSyncFn: ownSessionTmuxStub(captured), log: (m) => logs.push(m),
        });

        assert.equal(result, 'respawned');
        const respawnCalls = captured.filter((a) => a[0] === 'respawn-pane');
        assert.equal(respawnCalls.length, 1, 'exactly one respawn-pane call');
        assert.deepEqual(respawnCalls[0].slice(0, 4), ['respawn-pane', '-k', '-t', `${OWN_TMUX_SESSION}:monitor.0`]);
        assert.ok(respawnCalls[0][4].includes(`--mode anatomy-park ${sessionDir}`),
            `respawn command forwards the mode verbatim: ${respawnCalls[0][4]}`);
        assert.equal(readMonitorMode(sessionDir), 'anatomy-park', 'state.monitor_mode records the new mode');
        assert.ok(logs.includes('monitor: respawned for mode anatomy-park'), `logs: ${logs.join(' | ')}`);
    });
});

test('respawnMonitorWindowForMode: is a non-fatal no-op when tmux is unavailable or respawn-pane fails', { timeout: 15000 }, async () => {
    await withRespawnSandbox('monitor-respawn-', async (sessionDir) => {
        const captured = [];
        const tmuxDown = (_cmd, args, _opts) => { captured.push([...args]); return { status: 1, stdout: '', stderr: 'no server running' }; };
        const downResult = await respawnMonitorWindowForMode(sessionDir, 'szechuan-sauce', { inTmux: true, spawnSyncFn: tmuxDown });
        assert.equal(downResult, 'no-op');
        assert.equal(captured.filter((a) => a[0] === 'respawn-pane').length, 0, 'no pane touched when #S is unresolvable');
        assert.equal(readMonitorMode(sessionDir) ?? null, null, 'monitor_mode not recorded for a respawn that never ran');

        const paneFails = (_cmd, args, _opts) => {
            if (args[0] === 'display-message') return { status: 0, stdout: `${OWN_TMUX_SESSION}\n`, stderr: '' };
            return { status: 1, stdout: '', stderr: "can't find pane" };
        };
        const failResult = await respawnMonitorWindowForMode(sessionDir, 'szechuan-sauce', { inTmux: true, spawnSyncFn: paneFails });
        assert.equal(failResult, 'no-op');
        assert.equal(readMonitorMode(sessionDir) ?? null, null, 'a failed respawn-pane must not record the mode');
    });
});

// ---------------------------------------------------------------------------
// R-MDS-6: producer_done writer order — true BEFORE respawn, false AFTER
// ---------------------------------------------------------------------------

test('R-MDS-6: producer_done true→respawn→false sequence (writer-ownership protocol)', { timeout: 15000 }, async () => {
    const { StateManager } = await import('../../services/state-manager.js');
    const sm = new StateManager();

    await withRespawnSandbox('monitor-mds6-', async (sessionDir) => {
        const statePath = path.join(sessionDir, 'state.json');

        // Initialize monitor_panes (migration would do this automatically)
        sm.update(statePath, (s) => {
            s.monitor_panes = [
                { producer_done: false },
                { producer_done: false },
                { producer_done: false },
                { producer_done: false },
            ];
        });

        const sequence = [];
        // Capture flag at the moment of respawn-pane call (during respawn)
        const mockSpawnSync = ownSessionTmuxStub([], () => {
            try {
                const snap = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
                sequence.push({ event: 'respawn-pane', producer_done: snap.monitor_panes?.[2]?.producer_done });
            } catch { sequence.push({ event: 'respawn-pane', producer_done: 'error' }); }
        });

        // Simulate the pipeline-runner writer pattern (R-MDS-6):
        // Step 1: flip true BEFORE respawn
        sm.update(statePath, (s) => { if (Array.isArray(s.monitor_panes) && s.monitor_panes[2]) s.monitor_panes[2].producer_done = true; });
        sequence.push({ event: 'pre-respawn', producer_done: sm.read(statePath).monitor_panes?.[2]?.producer_done });

        // Step 2: call respawn (captured by mock)
        await respawnMonitorWindowForMode(sessionDir, 'anatomy-park', { inTmux: true, spawnSyncFn: mockSpawnSync });

        // Step 3: flip false AFTER respawn returns
        sm.update(statePath, (s) => { if (Array.isArray(s.monitor_panes) && s.monitor_panes[2]) s.monitor_panes[2].producer_done = false; });
        sequence.push({ event: 'post-respawn', producer_done: sm.read(statePath).monitor_panes?.[2]?.producer_done });

        // Assert order: first entry is pre-respawn, then >=1 respawn-pane all
        // observing producer_done=true, then post-respawn observing false.
        assert.equal(sequence[0]?.event, 'pre-respawn');
        assert.equal(sequence[0]?.producer_done, true, 'flag must be true before respawn');
        const respawnEntries = sequence.filter((s) => s.event === 'respawn-pane');
        assert.ok(respawnEntries.length > 0, 'respawn must invoke at least one tmux respawn-pane call');
        for (const r of respawnEntries) {
            assert.equal(r.producer_done, true, 'flag must be true DURING every respawn-pane call');
        }
        const last = sequence[sequence.length - 1];
        assert.equal(last?.event, 'post-respawn');
        assert.equal(last?.producer_done, false, 'flag must be false AFTER respawn returns');
    });
});

test('respawnMonitorWindowForMode: every phase-boundary mode reaches monitor.js verbatim; a repeat is a no-op', { timeout: 15000 }, async () => {
    await withRespawnSandbox('monitor-respawn-', async (sessionDir) => {
        // The modes handlePhaseBoundaryRespawn passes: the next phase, or 'idle' at pipeline end.
        for (const mode of ['anatomy-park', 'szechuan-sauce', 'idle']) {
            const captured = [];
            const result = await respawnMonitorWindowForMode(sessionDir, mode, { inTmux: true, spawnSyncFn: ownSessionTmuxStub(captured) });
            assert.equal(result, 'respawned', `mode=${mode} respawns`);
            const respawnCall = captured.find((a) => a[0] === 'respawn-pane');
            assert.ok(respawnCall && respawnCall[4].includes(`--mode ${mode} `), `mode=${mode} forwarded verbatim; captured: ${captured.map((a) => a.join(' ')).join(' || ')}`);
        }

        const captured = [];
        const repeat = await respawnMonitorWindowForMode(sessionDir, 'idle', { inTmux: true, spawnSyncFn: ownSessionTmuxStub(captured) });
        assert.equal(repeat, 'no-op', 'already in the requested mode');
        assert.equal(captured.length, 0, 'a same-mode call issues no tmux command');
    });
});

test('respawnMonitorWindowForMode: a tmux session not named for this session dir is never respawned', { timeout: 15000 }, async () => {
    await withRespawnSandbox('monitor-respawn-', async (sessionDir) => {
        const captured = [];
        const foreign = (_cmd, args, _opts) => {
            captured.push([...args]);
            if (args[0] === 'display-message') return { status: 0, stdout: 'pipeline-ffffffff\n', stderr: '' };
            return { status: 0, stdout: '', stderr: '' };
        };
        const result = await respawnMonitorWindowForMode(sessionDir, 'anatomy-park', { inTmux: true, spawnSyncFn: foreign });
        assert.equal(result, 'no-op');
        assert.equal(captured.filter((a) => a[0] === 'respawn-pane').length, 0, 'foreign session pane must not be killed');
        assert.equal(readMonitorMode(sessionDir) ?? null, null);
    });
});
