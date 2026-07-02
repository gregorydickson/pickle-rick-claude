// @tier: fast
// Tests for the IterationOutcome shape returned by runIteration (ticket ff3a5ae3).
// Covers: shape contract, timing fields on the inactive early-return path, and
// the documented completion-value union. The hang-guard and spawn-error resolve
// paths require a live `claude` subprocess and are covered by integration runs.

// F3 / R-DWC: this test file uses synthetic temp-dir sessions whose workingDir
// is not a real git repo. The F3 completion_commit guard bypasses on
// PICKLE_TEST_MODE=1 per R-WSRC-4 sandbox parity; set it module-wide.
process.env.PICKLE_TEST_MODE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { execFileSync } from 'node:child_process';

import {
    runIteration,
    commitPendingProbe,
    COMMIT_PENDING_HANDOFF_TEXT,
    processCompletionBranch,
    evaluateManagerRelaunch,
    recordManagerRelaunch,
} from '../bin/mux-runner.js';
import { Defaults } from '../types/index.js';

function makeInactiveSession() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-outcome-')));
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: false, step: 'implement', iteration: 0 }));
    return dir;
}

function makeExecutableNodeScript(filePath, source) {
    fs.writeFileSync(filePath, `#!/usr/bin/env node\n${source}`);
    fs.chmodSync(filePath, 0o755);
}

test('IterationOutcome: inactive early-return produces all four fields', async () => {
    const dir = makeInactiveSession();
    try {
        const outcome = await runIteration(dir, 1, dir, '');
        assert.ok('completion' in outcome, 'missing completion field');
        assert.ok('timedOut' in outcome, 'missing timedOut field');
        assert.ok('exitCode' in outcome, 'missing exitCode field');
        assert.ok('wallSeconds' in outcome, 'missing wallSeconds field');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('IterationOutcome: inactive path sets timedOut=false, exitCode=null, wallSeconds=0', async () => {
    const dir = makeInactiveSession();
    try {
        const outcome = await runIteration(dir, 1, dir, '');
        assert.equal(outcome.completion, 'inactive');
        assert.equal(outcome.timedOut, false);
        assert.equal(outcome.exitCode, null);
        assert.equal(outcome.wallSeconds, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('IterationOutcome: wallSeconds is a finite non-negative number (never NaN)', async () => {
    const dir = makeInactiveSession();
    try {
        const outcome = await runIteration(dir, 1, dir, '');
        assert.equal(typeof outcome.wallSeconds, 'number');
        assert.ok(Number.isFinite(outcome.wallSeconds), 'wallSeconds must be finite');
        assert.ok(outcome.wallSeconds >= 0, 'wallSeconds must be non-negative');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('IterationOutcome: completion value is from the documented string union', async () => {
    const dir = makeInactiveSession();
    try {
        const outcome = await runIteration(dir, 1, dir, '');
        const allowed = new Set(['task_completed', 'review_clean', 'continue', 'error', 'inactive']);
        assert.ok(allowed.has(outcome.completion), `unexpected completion: ${outcome.completion}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('IterationOutcome: inactive path never populates exitCode with a number', async () => {
    const dir = makeInactiveSession();
    try {
        const outcome = await runIteration(dir, 1, dir, '');
        // exitCode is null until proc.on('close') provides a code; the
        // inactive early-return predates the spawn, so it must be null.
        assert.equal(outcome.exitCode, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('IterationOutcome: missing state.json throws a descriptive error (not an outcome)', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-outcome-miss-')));
  try {
    await assert.rejects(
      runIteration(dir, 1, dir, ''),
      /Failed to read state.json/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('IterationOutcome: runIteration honors a higher-iteration inactive orphan tmp state', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-outcome-orphan-')));
    try {
        // Snapshots must satisfy isRecoverableStateSnapshotCandidate
        // (state-manager.ts:260, anatomy-park 47095472) — partial snapshots
        // are rejected during orphan-tmp promotion.
        const statePath = path.join(dir, 'state.json');
        const baseState = {
            working_dir: dir,
            backend: 'claude',
            step: 'implement',
            iteration: 0,
            max_iterations: 50,
            max_time_minutes: 720,
            worker_timeout_seconds: 1200,
            start_time_epoch: 1700000000,
            original_prompt: 'test',
            session_dir: dir,
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
            schema_version: 3,
            active: true,
            command_template: '../stale-template.md',
        };
        fs.writeFileSync(statePath, JSON.stringify(baseState));
        fs.writeFileSync(`${statePath}.tmp.99999999`, JSON.stringify({
            ...baseState,
            active: false,
            step: 'review',
            iteration: 3,
        }));

        const outcome = await runIteration(dir, 1, dir, '');
        assert.equal(outcome.completion, 'inactive');
        assert.equal(outcome.timedOut, false);
        assert.equal(outcome.exitCode, null);
        assert.equal(outcome.wallSeconds, 0);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('IterationOutcome: fractional mux max-turn settings fall back before spawning manager', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-outcome-turns-')));
    const oldPath = process.env.PATH;
    const oldBackend = process.env.PICKLE_BACKEND;
    try {
        fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'templates', '_pickle-manager-prompt.md'), '# Pickle\n\n$ARGUMENTS\n');
        fs.writeFileSync(path.join(dir, 'pickle_settings.json'), JSON.stringify({
            default_tmux_max_turns: 1.5,
            default_manager_max_turns: 2.25,
        }));
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
            active: true,
            step: 'implement',
            iteration: 0,
            max_iterations: 5,
            worker_timeout_seconds: 1200,
            original_prompt: 'test fractional max turns',
            working_dir: dir,
            backend: 'claude',
        }));

        const fakeBin = path.join(dir, 'fake-bin');
        fs.mkdirSync(fakeBin, { recursive: true });
        const argsPath = path.join(dir, 'claude-args.json');
        makeExecutableNodeScript(path.join(fakeBin, 'claude'), `
const fs = require('node:fs');
fs.writeFileSync(process.env.CLAUDE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
console.log('<promise>TASK_COMPLETED</promise>');
`);
        process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ''}`;
        process.env.PICKLE_BACKEND = 'claude';
        process.env.CLAUDE_ARGS_PATH = argsPath;

        const outcome = await runIteration(dir, 1, dir, '');
        assert.equal(outcome.exitCode, 0);

        const args = JSON.parse(fs.readFileSync(argsPath, 'utf-8'));
        const idx = args.indexOf('--max-turns');
        assert.notEqual(idx, -1, `expected --max-turns in ${JSON.stringify(args)}`);
        assert.equal(args[idx + 1], String(Defaults.MANAGER_MAX_TURNS));
    } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldBackend === undefined) delete process.env.PICKLE_BACKEND;
        else process.env.PICKLE_BACKEND = oldBackend;
        delete process.env.CLAUDE_ARGS_PATH;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// commit-pending health probe: codex-only nudge when the worker has uncommitted
// edits and the iteration counter has stagnated past the threshold. Happy path:
// trigger conditions met → handoff.txt is written with the documented nudge.
// ---------------------------------------------------------------------------

function initGitRepo(repoDir) {
    const opts = { cwd: repoDir, stdio: 'ignore' };
    execFileSync('git', ['init', '--quiet'], opts);
    execFileSync('git', ['config', 'user.email', 'probe@test.local'], opts);
    execFileSync('git', ['config', 'user.name', 'Probe Test'], opts);
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], opts);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# baseline\n');
    execFileSync('git', ['add', '.'], opts);
    execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], opts);
}

test('commitPendingProbe: codex + uncommitted edits + stagnation → fires and writes handoff.txt', () => {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-probe-fire-')));
    const workingDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-probe-repo-')));
    try {
        initGitRepo(workingDir);

        // Seed the trigger state: codex backend, advanced iteration counter,
        // last_progress lagging, uncommitted edit in the working tree.
        const statePath = path.join(sessionDir, 'state.json');
        fs.writeFileSync(statePath, JSON.stringify({
            active: true,
            backend: 'codex',
            step: 'implement',
            iteration: 5,
            working_dir: workingDir,
        }));
        // Uncommitted edit (tracked file modification — git diff --stat picks it up).
        fs.writeFileSync(path.join(workingDir, 'README.md'), '# baseline\nuncommitted edit\n');

        const logs = [];
        const result = commitPendingProbe({
            sessionDir,
            workingDir,
            backend: 'codex',
            iteration: 5,
            lastProgressIteration: 2, // stagnation = 3, threshold 2 → trips
            threshold: 2,
            pid: process.pid,
            log: (msg) => logs.push(msg),
        });

        assert.equal(result, 'fired', `expected fired, got ${result}`);

        const handoffPath = path.join(sessionDir, 'handoff.txt');
        assert.ok(fs.existsSync(handoffPath), 'handoff.txt should be written');

        const content = fs.readFileSync(handoffPath, 'utf-8');
        assert.match(content, /CIRCUIT BREAKER HEALTH PROBE — COMMIT PENDING/);
        assert.match(content, /git add <files>/);
        assert.match(content, /git commit -m/);
        assert.match(content, /# DEFERRED:/);
        assert.match(content, /<promise>I AM DONE<\/promise>/);
        // Stagnation count is interpolated into the body — N is replaced with the
        // actual count so the worker sees a concrete number, not a placeholder.
        assert.ok(!content.includes('for N iterations'), 'N placeholder should be replaced with actual count');
        assert.match(content, /for 3 iterations/);

        // Probe activation is logged through the injected log function.
        assert.ok(
            logs.some(m => m.includes('commit-pending probe FIRED')),
            'probe firing should be logged',
        );

        // Sanity: COMMIT_PENDING_HANDOFF_TEXT is the canonical template.
        assert.ok(
            COMMIT_PENDING_HANDOFF_TEXT.includes('CIRCUIT BREAKER HEALTH PROBE'),
            'exported template constant should match the documented header',
        );
    } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(workingDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Codex manager relaunch on per-iteration error (mux-runner trap door).
// Codex tmux_mode runs ONE long-lived manager; the 4h hang-guard treats it as
// terminal and strands remaining Todo tickets. mux-runner must consult
// `evaluateManagerRelaunch()` and relaunch instead of exiting when the
// backend is codex, tickets remain Todo/In Progress, the relaunch counter is
// below the cap, and the circuit breaker is not OPEN.
// ---------------------------------------------------------------------------

function writeTicketFile(sessionDir, id, status, order = 1) {
    const ticketDir = path.join(sessionDir, id);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), [
        '---',
        `id: ${id}`,
        `title: ${id} title`,
        `status: "${status}"`,
        `order: ${order}`,
        '---',
        '',
    ].join('\n'));
}

function makeRelaunchSession(opts = {}) {
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-codex-relaunch-')));
    const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-codex-relaunch-data-')));
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
        active: true,
        step: 'implement',
        iteration: 3,
        max_iterations: 100,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        max_time_minutes: 720,
        working_dir: sessionDir,
        backend: opts.backend ?? 'codex',
        manager_relaunch_count: opts.priorRelaunchCount ?? 0,
    }, null, 2));

    for (const t of opts.tickets || []) {
        writeTicketFile(sessionDir, t.id, t.status, t.order);
    }

    return { sessionDir, statePath, dataRoot };
}

function makeBranchCtx(session, overrides = {}) {
    const logs = [];
    const ctx = {
        sessionDir: session.sessionDir,
        statePath: session.statePath,
        extensionRoot: path.resolve('.'),
        iteration: 4,
        log: (msg) => logs.push(msg),
        cbEnabled: false,
        cbState: null,
        ...overrides,
    };
    return { ctx, logs };
}

function withDataRoot(dataRoot, fn) {
    const prev = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = prev;
    }
}

function readActivityEvents(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    const events = [];
    for (const entry of fs.readdirSync(activityDir)) {
        if (!entry.endsWith('.jsonl')) continue;
        const content = fs.readFileSync(path.join(activityDir, entry), 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            try { events.push(JSON.parse(line)); } catch { /* ignore */ }
        }
    }
    return events;
}

test('processCompletionBranch: task_completed + all Done → break with success + finalizeTerminalState invariants', async () => {
    const session = makeRelaunchSession({
        backend: 'claude',
        tickets: [
            { id: 't-1', status: 'Done', order: 1 },
            { id: 't-2', status: 'Done', order: 2 },
        ],
    });
    // Set step='research' + current_ticket so we can prove they get reconciled.
    const initialState = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
    initialState.step = 'research';
    initialState.current_ticket = 't-2';
    initialState.iteration = 5;
    fs.writeFileSync(session.statePath, JSON.stringify(initialState, null, 2));

    try {
        await withDataRoot(session.dataRoot, async () => {
            const { ctx } = makeBranchCtx(session, { iteration: 8 });
            const action = await processCompletionBranch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'task_completed',
                ctx,
            );
            assert.equal(action.kind, 'break');
            assert.equal(action.reason, 'success');

            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.active, false, 'active must be false after EPIC_COMPLETED success');
            assert.equal(persisted.step, 'completed', 'step must advance to completed');
            assert.equal(persisted.current_ticket, null, 'current_ticket must be cleared');
            assert.equal(persisted.iteration, 8, 'iteration must reconcile to runner ctx.iteration');
            assert.equal(persisted.exit_reason, 'success');
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('processCompletionBranch: review_clean → break with success + finalizeTerminalState invariants', async () => {
    const session = makeRelaunchSession({
        backend: 'claude',
        tickets: [{ id: 't-1', status: 'Done', order: 1 }],
    });
    const initialState = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
    initialState.step = 'review';
    initialState.current_ticket = 't-1';
    initialState.min_iterations = 0;
    fs.writeFileSync(session.statePath, JSON.stringify(initialState, null, 2));

    try {
        await withDataRoot(session.dataRoot, async () => {
            const { ctx } = makeBranchCtx(session, { iteration: 6 });
            const action = await processCompletionBranch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'review_clean',
                ctx,
            );
            assert.equal(action.kind, 'break');
            assert.equal(action.reason, 'success');

            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.active, false);
            assert.equal(persisted.step, 'completed');
            assert.equal(persisted.current_ticket, null);
            assert.equal(persisted.iteration, 6);
            assert.equal(persisted.exit_reason, 'success');
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('processCompletionBranch: codex + error + pending tickets + below cap → relaunch action', async () => {
    const session = makeRelaunchSession({
        backend: 'codex',
        priorRelaunchCount: 1,
        tickets: [
            { id: 't-done', status: 'Done', order: 1 },
            { id: 't-pending', status: 'Todo', order: 2 },
            { id: 't-in-progress', status: 'In Progress', order: 3 },
        ],
    });
    try {
        await withDataRoot(session.dataRoot, async () => {
            const { ctx } = makeBranchCtx(session, {
                outcome: { completion: 'error', timedOut: true, exitCode: null, wallSeconds: 14_401 },
            });
            const action = await processCompletionBranch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'relaunch', `expected relaunch, got ${action.kind} (${action.reason || ''})`);
            assert.equal(action.relaunchCount, 2, 'relaunchCount must be prior+1');
            assert.equal(action.pendingTickets, 2, 'pendingTickets must count Todo+InProgress');
            assert.equal(action.resetStall, true);

            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.manager_relaunch_count, 2,
                'state.manager_relaunch_count must be incremented');
            assert.equal(persisted.active, true,
                'session must remain active across relaunch (no safeDeactivate)');

            const events = readActivityEvents(session.dataRoot);
            const relaunchEvents = events.filter(e => e.event === 'codex_manager_relaunch');
            assert.equal(relaunchEvents.length, 1,
                `expected 1 codex_manager_relaunch event, got ${relaunchEvents.length}`);
            assert.equal(relaunchEvents[0].source, 'pickle');
            assert.equal(relaunchEvents[0].session, path.basename(session.sessionDir));
            assert.equal(relaunchEvents[0].iteration, 4);
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('processCompletionBranch: codex + error + all tickets Done → break with reason error', async () => {
    const session = makeRelaunchSession({
        backend: 'codex',
        tickets: [
            { id: 't-1', status: 'Done', order: 1 },
            { id: 't-2', status: 'Done', order: 2 },
        ],
    });
    try {
        await withDataRoot(session.dataRoot, async () => {
            const { ctx } = makeBranchCtx(session);
            const action = await processCompletionBranch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'break');
            assert.equal(action.reason, 'error');
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            // No relaunch happened — counter unchanged.
            assert.equal(persisted.manager_relaunch_count, 0);
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('processCompletionBranch: codex + error + counter at cap → break with reason error', async () => {
    const session = makeRelaunchSession({
        backend: 'codex',
        priorRelaunchCount: Defaults.CODEX_MANAGER_RELAUNCH_CAP,
        tickets: [
            { id: 't-pending', status: 'Todo', order: 1 },
            { id: 't-done', status: 'Done', order: 2 },
        ],
    });
    try {
        await withDataRoot(session.dataRoot, async () => {
            const { ctx } = makeBranchCtx(session);
            const action = await processCompletionBranch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'break',
                `expected break at cap, got ${action.kind} (count ${action.relaunchCount ?? 'n/a'})`);
            assert.equal(action.reason, 'error');
            // Cap honored: counter not bumped past the cap.
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.manager_relaunch_count, Defaults.CODEX_MANAGER_RELAUNCH_CAP);
            const events = readActivityEvents(session.dataRoot);
            assert.equal(
                events.filter(e => e.event === 'codex_manager_relaunch').length,
                0,
                'must NOT emit codex_manager_relaunch when cap is exceeded',
            );
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('processCompletionBranch: codex + error exactly at wall-clock cap → break without relaunch', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const session = makeRelaunchSession({
        backend: 'codex',
        priorRelaunchCount: 1,
        tickets: [
            { id: 't-pending', status: 'Todo', order: 1 },
        ],
    });
    try {
        await withDataRoot(session.dataRoot, async () => {
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            persisted.start_time_epoch = nowSec - 300;
            persisted.max_time_minutes = 5;
            fs.writeFileSync(session.statePath, JSON.stringify(persisted, null, 2));

            const realNow = Date.now;
            Date.now = () => (nowSec * 1000);
            try {
                const { ctx } = makeBranchCtx(session);
                const action = await processCompletionBranch(
                    JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                    'error',
                    ctx,
                );
                assert.equal(action.kind, 'break');
                assert.equal(action.reason, 'limit');

                const events = readActivityEvents(session.dataRoot);
                assert.equal(
                    events.filter(e => e.event === 'codex_manager_relaunch').length,
                    0,
                    'must NOT relaunch once elapsed time exactly reaches the configured budget',
                );

                const finalState = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
                assert.equal(finalState.active, false);
                assert.equal(finalState.current_ticket, null);
                assert.equal(finalState.exit_reason, 'limit');
                assert.equal(finalState.manager_relaunch_count, 1);
            } finally {
                Date.now = realNow;
            }
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('processCompletionBranch: claude backend + error + pending → relaunch action with claude cap', async () => {
    const session = makeRelaunchSession({
        backend: 'claude',
        tickets: [
            { id: 't-pending', status: 'Todo', order: 1 },
        ],
    });
    try {
        await withDataRoot(session.dataRoot, async () => {
            const iterLogFile = path.join(session.sessionDir, 'tmux_iteration_4.log');
            // R-ICDM-1: classifyManagerRelaunchExit now requires `num_turns >= maxTurns`
            // to classify as `claude_max_turns`. Simulate a real max-turns exit with
            // num_turns at the budget the ctx will pass.
            fs.writeFileSync(iterLogFile, [
                '{"type":"assistant","content":"work"}',
                '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":400}',
            ].join('\n'));
            const { ctx } = makeBranchCtx(session, {
                iterLogFile,
                outcome: { completion: 'error', timedOut: false, exitCode: 0, wallSeconds: 12 },
                maxTurns: 400,
            });
            const action = await processCompletionBranch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'relaunch');
            assert.equal(action.relaunchCount, 1);
            const events = readActivityEvents(session.dataRoot);
            assert.equal(
                events.filter(e => e.event === 'manager_max_turns_relaunch').length,
                1,
                'claude backend must emit relaunch activity when pending work remains',
            );
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.manager_relaunch_count, 1);
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('evaluateManagerRelaunch: pure decision honors cap, CB-OPEN, and pending state', () => {
    const codexState = { backend: 'codex', codex_manager_relaunch_count: 0 };
    const claudeState = { backend: 'claude' };
    const pending = [
        { id: 't1', status: 'Todo', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
        { id: 't2', status: 'Done', title: '', order: 2, type: null, working_dir: null, completed_at: null, skipped_at: null },
    ];
    const allDone = pending.map(t => ({ ...t, status: 'Done' }));

    // Eligible
    const eligible = evaluateManagerRelaunch(codexState, pending, null);
    assert.equal(eligible.shouldRelaunch, true);
    assert.equal(eligible.pendingCount, 1);
    assert.equal(eligible.nextRelaunchCount, 1);
    assert.equal(eligible.reason, 'eligible');

    // Claude uses the backend-specific cap and is also eligible.
    const claude = evaluateManagerRelaunch(claudeState, pending, null);
    assert.equal(claude.shouldRelaunch, true);
    assert.equal(claude.reason, 'eligible');
    assert.equal(claude.cap, Defaults.CLAUDE_MANAGER_RELAUNCH_CAP);

    // No pending
    const noPending = evaluateManagerRelaunch(codexState, allDone, null);
    assert.equal(noPending.shouldRelaunch, false);
    assert.equal(noPending.reason, 'no_pending');

    // Cap exceeded
    const capped = evaluateManagerRelaunch(
        { ...codexState, codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP },
        pending,
        null,
    );
    assert.equal(capped.shouldRelaunch, false);
    assert.equal(capped.reason, 'cap_exceeded');

    // Circuit breaker OPEN
    const cbOpen = evaluateManagerRelaunch(codexState, pending, { state: 'OPEN' });
    assert.equal(cbOpen.shouldRelaunch, false);
    assert.equal(cbOpen.reason, 'circuit_open');

    // Status normalization: quoted "Todo" still counts as pending
    const quoted = evaluateManagerRelaunch(codexState, [
        { id: 't1', status: '"Todo"', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
    ], null);
    assert.equal(quoted.shouldRelaunch, true);
    assert.equal(quoted.pendingCount, 1);
});

test('recordManagerRelaunch: persists counter and emits activity event', () => {
    const session = makeRelaunchSession({ backend: 'codex', priorRelaunchCount: 0 });
    try {
        withDataRoot(session.dataRoot, () => {
            const logs = [];
            recordManagerRelaunch(
                session.statePath,
                session.sessionDir,
                { shouldRelaunch: true, pendingCount: 3, nextRelaunchCount: 1, reason: 'eligible' },
                7,
                (m) => logs.push(m),
            );
            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.manager_relaunch_count, 1);

            const events = readActivityEvents(session.dataRoot);
            const relaunch = events.find(e => e.event === 'codex_manager_relaunch');
            assert.ok(relaunch, 'codex_manager_relaunch event must be present');
            assert.equal(relaunch.iteration, 7);
            assert.equal(relaunch.session, path.basename(session.sessionDir));
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC-LPB-03: hard wall-clock cap-gate inside evaluateManagerRelaunch.
// Relaunching after the time budget is exhausted only burns API turns the
// user already opted out of. The cap-gate must run BEFORE every other
// decision branch (CB OPEN, no_pending, cap_exceeded), so the budget cannot
// be papered over by any of them.
// ---------------------------------------------------------------------------
test('evaluateManagerRelaunch returns time_limit when elapsed > max_time_minutes', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Started 10 minutes ago, budget is 5 minutes → elapsed exceeds budget.
    const codexState = {
        backend: 'codex',
        codex_manager_relaunch_count: 0,
        start_time_epoch: nowSec - 600,
        max_time_minutes: 5,
    };
    const pending = [
        { id: 't1', status: 'Todo', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
    ];
    const decision = evaluateManagerRelaunch(codexState, pending, null);
    assert.equal(decision.shouldRelaunch, false);
    assert.equal(decision.reason, 'time_limit');
    assert.equal(decision.pendingCount, 0,
        'time_limit short-circuits before counting pending tickets');
});

test('evaluateManagerRelaunch returns time_limit when elapsed equals max_time_minutes', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const codexState = {
        backend: 'codex',
        codex_manager_relaunch_count: 0,
        start_time_epoch: nowSec - 300,
        max_time_minutes: 5,
    };
    const pending = [
        { id: 't1', status: 'Todo', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
    ];
    const realNow = Date.now;
    Date.now = () => nowSec * 1000;
    try {
        const decision = evaluateManagerRelaunch(codexState, pending, null);
        assert.equal(decision.shouldRelaunch, false);
        assert.equal(decision.reason, 'time_limit');
    } finally {
        Date.now = realNow;
    }
});

test('evaluateManagerRelaunch returns time_limit before circuit_open / cap_exceeded', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Budget exhausted AND CB OPEN AND cap exceeded — time_limit must win
    // because it runs first.
    const codexState = {
        backend: 'codex',
        codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP,
        start_time_epoch: nowSec - 86_400,  // 24h ago
        max_time_minutes: 60,
    };
    const pending = [
        { id: 't1', status: 'Todo', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
    ];
    const decision = evaluateManagerRelaunch(codexState, pending, { state: 'OPEN' });
    assert.equal(decision.shouldRelaunch, false);
    assert.equal(decision.reason, 'time_limit',
        'time_limit must short-circuit ahead of circuit_open and cap_exceeded');
});

test('evaluateManagerRelaunch returns existing reason when within budget', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // Plenty of budget left → cap-gate must NOT fire; eligible decision wins.
    const codexState = {
        backend: 'codex',
        codex_manager_relaunch_count: 0,
        start_time_epoch: nowSec - 60,  // 1 min ago
        max_time_minutes: 720,           // 12h budget
    };
    const pending = [
        { id: 't1', status: 'Todo', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
    ];
    const eligible = evaluateManagerRelaunch(codexState, pending, null);
    assert.equal(eligible.shouldRelaunch, true);
    assert.equal(eligible.reason, 'eligible');

    // Within budget and claude → eligible under the claude cap.
    const claudeState = { ...codexState, backend: 'claude' };
    const claude = evaluateManagerRelaunch(claudeState, pending, null);
    assert.equal(claude.reason, 'eligible');
    assert.equal(claude.cap, Defaults.CLAUDE_MANAGER_RELAUNCH_CAP);

    // Within budget but no pending → no_pending.
    const allDone = pending.map(t => ({ ...t, status: 'Done' }));
    const noPending = evaluateManagerRelaunch(codexState, allDone, null);
    assert.equal(noPending.reason, 'no_pending');

    // Within budget but cap exceeded → cap_exceeded.
    const cappedState = { ...codexState, codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP };
    const capped = evaluateManagerRelaunch(cappedState, pending, null);
    assert.equal(capped.reason, 'cap_exceeded');

    // Within budget but CB OPEN → circuit_open.
    const cbOpen = evaluateManagerRelaunch(codexState, pending, { state: 'OPEN' });
    assert.equal(cbOpen.reason, 'circuit_open');
});

test('evaluateManagerRelaunch ignores time_limit when max_time_minutes is missing or zero', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const pending = [
        { id: 't1', status: 'Todo', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
    ];

    // No max_time_minutes set → no time gate, eligible.
    const noBudget = evaluateManagerRelaunch(
        { backend: 'codex', codex_manager_relaunch_count: 0, start_time_epoch: nowSec - 86_400 },
        pending,
        null,
    );
    assert.equal(noBudget.reason, 'eligible',
        'no max_time_minutes → time gate inert, eligible falls through');

    // No start_time_epoch → cannot compute elapsed, skip the gate.
    const noEpoch = evaluateManagerRelaunch(
        { backend: 'codex', codex_manager_relaunch_count: 0, max_time_minutes: 1 },
        pending,
        null,
    );
    assert.equal(noEpoch.reason, 'eligible',
        'no start_time_epoch → time gate inert, eligible falls through');
});

// ---------------------------------------------------------------------------
// R-CMWL-4: codex manager no-progress guard.
// After 2 consecutive zero-progress relaunch passes, the loop must halt with
// reason='codex_manager_no_progress' instead of relaunching again.
// ---------------------------------------------------------------------------

test('processCompletionBranch: codex + error + 2 consecutive zero-progress passes → halt codex_manager_no_progress', async () => {
    const session = makeRelaunchSession({
        backend: 'codex',
        priorRelaunchCount: 1,
        tickets: [
            { id: 't-pending', status: 'Todo', order: 1 },
        ],
    });
    try {
        await withDataRoot(session.dataRoot, async () => {
            // Seed baseline: simulate a prior pass that established the baseline.
            // pending=1, baseline=1 → this pass also has pending=1 → zero progress.
            const seed = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            seed.codex_manager_relaunch_pending_baseline = 1;
            seed.codex_manager_consecutive_no_progress = 1; // already 1 from prior pass
            fs.writeFileSync(session.statePath, JSON.stringify(seed, null, 2));

            const { ctx } = makeBranchCtx(session, {
                outcome: { completion: 'error', timedOut: true, exitCode: null, wallSeconds: 14_401 },
            });
            const action = await processCompletionBranch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'break',
                `expected break on 2nd zero-progress pass, got ${action.kind}`);
            assert.equal(action.reason, 'codex_manager_no_progress',
                `expected codex_manager_no_progress reason, got ${action.reason}`);

            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.exit_reason, 'codex_manager_no_progress');
            assert.equal(persisted.active, false, 'session must be deactivated on halt');
            assert.equal(persisted.codex_manager_consecutive_no_progress, 2,
                'counter must be 2 after two zero-progress passes');

            const events = readActivityEvents(session.dataRoot);
            const noProgressEvents = events.filter(e => e.event === 'codex_manager_no_progress');
            assert.equal(noProgressEvents.length, 1,
                `expected 1 codex_manager_no_progress event, got ${noProgressEvents.length}`);
            assert.equal(noProgressEvents[0].consecutive_count, 2);
            assert.equal(noProgressEvents[0].pending_count, 1);
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('processCompletionBranch: codex + error + 1 zero-progress then progressing pass → counter resets, relaunch', async () => {
    const session = makeRelaunchSession({
        backend: 'codex',
        priorRelaunchCount: 1,
        tickets: [
            { id: 't-done', status: 'Done', order: 1 },
            { id: 't-pending', status: 'Todo', order: 2 },
        ],
    });
    try {
        await withDataRoot(session.dataRoot, async () => {
            // Seed: prior pass had pending=2, counter=1 (zero progress).
            // Now pending=1 (t-done completed) → progress → counter resets to 0 → relaunch.
            const seed = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            seed.codex_manager_relaunch_pending_baseline = 2;
            seed.codex_manager_consecutive_no_progress = 1;
            fs.writeFileSync(session.statePath, JSON.stringify(seed, null, 2));

            const { ctx } = makeBranchCtx(session, {
                outcome: { completion: 'error', timedOut: true, exitCode: null, wallSeconds: 14_401 },
            });
            const action = await processCompletionBranch(
                JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
                'error',
                ctx,
            );
            assert.equal(action.kind, 'relaunch',
                `expected relaunch after progress reset, got ${action.kind} (${action.reason ?? ''})`);

            const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
            assert.equal(persisted.codex_manager_consecutive_no_progress, 0,
                'counter must reset to 0 after progressing pass');
            assert.equal(persisted.codex_manager_relaunch_pending_baseline, 1,
                'baseline must update to current pending count');
        });
    } finally {
        fs.rmSync(session.sessionDir, { recursive: true, force: true });
        fs.rmSync(session.dataRoot, { recursive: true, force: true });
    }
});

test('processCompletionBranch: codex_manager_no_progress passes schema required-field check', () => {
    const schemaPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/types/activity-events.schema.json');
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    const def = schema.definitions.codex_manager_no_progress;
    assert.ok(def, 'activity-events.schema.json must define codex_manager_no_progress');
    assert.ok(schema.oneOf.some(o => o.$ref === '#/definitions/codex_manager_no_progress'),
        'activity-events.schema.json oneOf must reference codex_manager_no_progress');

    const required = def.required || [];
    const payload = {
        event: 'codex_manager_no_progress',
        ts: new Date().toISOString(),
        backend: 'codex',
        consecutive_count: 2,
        pending_count: 1,
        session: 'test-session',
        iteration: 5,
        source: 'pickle',
    };
    for (const field of required) {
        assert.ok(field in payload, `schema required field '${field}' must be in payload`);
    }
    assert.equal(payload.event, def.properties.event.const, 'event const must match');
});
