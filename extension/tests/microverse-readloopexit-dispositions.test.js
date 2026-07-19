// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readLoopExit } from '../bin/microverse-runner.js';
import { writeStateFile } from '../services/pickle-utils.js';

function makeSessionDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-readloopexit-'));
}

function makeCtx(statePath, iteration) {
    const logs = [];
    return {
        statePath,
        currentRunnerState: null,
        iteration,
        log: (msg) => logs.push(msg),
        logs,
    };
}

test('readLoopExit returns iteration_budget_exhausted when the iteration cap is hit', () => {
    const dir = makeSessionDir();
    try {
        const statePath = path.join(dir, 'state.json');
        writeStateFile(statePath, {
            active: true,
            working_dir: dir,
            session_dir: dir,
            step: 'implement',
            iteration: 1,
            max_iterations: 1,
            worker_timeout_seconds: 0,
            start_time_epoch: Math.floor(Date.now() / 1000),
            backend: 'claude',
            original_prompt: 'test',
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
            schema_version: 5,
        });

        const ctx = makeCtx(statePath, 1);
        const result = readLoopExit(ctx);
        assert.equal(result, 'iteration_budget_exhausted');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('readLoopExit returns time_budget_exhausted when the time cap is hit', () => {
    const dir = makeSessionDir();
    try {
        const statePath = path.join(dir, 'state.json');
        writeStateFile(statePath, {
            active: true,
            working_dir: dir,
            session_dir: dir,
            step: 'implement',
            // iteration: 1 (not 0) avoids demotePhantomSession's "fresh session,
            // never iterated" phantom-demotion heuristic (state-manager.ts) — that
            // heuristic fires on iteration===0 && empty history, flipping active
            // to false before readLoopExit's own cap checks ever run.
            iteration: 1,
            max_iterations: 1000,
            worker_timeout_seconds: 0,
            // Started 2 minutes ago against a 1-minute budget -> already exhausted.
            start_time_epoch: Math.floor(Date.now() / 1000) - 120,
            max_time_minutes: 1,
            backend: 'claude',
            original_prompt: 'test',
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
            schema_version: 5,
        });

        const ctx = makeCtx(statePath, 0);
        const result = readLoopExit(ctx);
        assert.equal(result, 'time_budget_exhausted');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('readLoopExit prefers iteration_budget_exhausted over time_budget_exhausted when both caps are hit', () => {
    const dir = makeSessionDir();
    try {
        const statePath = path.join(dir, 'state.json');
        writeStateFile(statePath, {
            active: true,
            working_dir: dir,
            session_dir: dir,
            step: 'implement',
            iteration: 1,
            max_iterations: 1,
            worker_timeout_seconds: 0,
            start_time_epoch: Math.floor(Date.now() / 1000) - 120,
            max_time_minutes: 1,
            backend: 'claude',
            original_prompt: 'test',
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
            schema_version: 5,
        });

        const ctx = makeCtx(statePath, 1);
        const result = readLoopExit(ctx);
        assert.equal(result, 'iteration_budget_exhausted');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('readLoopExit distinct cap reasons never collide', () => {
    const iterDir = makeSessionDir();
    const timeDir = makeSessionDir();
    try {
        const iterStatePath = path.join(iterDir, 'state.json');
        writeStateFile(iterStatePath, {
            active: true,
            working_dir: iterDir,
            session_dir: iterDir,
            step: 'implement',
            iteration: 1,
            max_iterations: 1,
            worker_timeout_seconds: 0,
            start_time_epoch: Math.floor(Date.now() / 1000),
            backend: 'claude',
            original_prompt: 'test',
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
            schema_version: 5,
        });

        const timeStatePath = path.join(timeDir, 'state.json');
        writeStateFile(timeStatePath, {
            active: true,
            working_dir: timeDir,
            session_dir: timeDir,
            step: 'implement',
            iteration: 1,
            max_iterations: 1000,
            worker_timeout_seconds: 0,
            start_time_epoch: Math.floor(Date.now() / 1000) - 120,
            max_time_minutes: 1,
            backend: 'claude',
            original_prompt: 'test',
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
            schema_version: 5,
        });

        const iterResult = readLoopExit(makeCtx(iterStatePath, 1));
        const timeResult = readLoopExit(makeCtx(timeStatePath, 0));

        assert.equal(iterResult, 'iteration_budget_exhausted');
        assert.equal(timeResult, 'time_budget_exhausted');
        assert.notEqual(iterResult, timeResult);
    } finally {
        fs.rmSync(iterDir, { recursive: true, force: true });
        fs.rmSync(timeDir, { recursive: true, force: true });
    }
});

test('readLoopExit returns null when neither cap is hit', () => {
    const dir = makeSessionDir();
    try {
        const statePath = path.join(dir, 'state.json');
        writeStateFile(statePath, {
            active: true,
            working_dir: dir,
            session_dir: dir,
            step: 'implement',
            iteration: 1,
            max_iterations: 1000,
            worker_timeout_seconds: 0,
            start_time_epoch: Math.floor(Date.now() / 1000),
            max_time_minutes: 60,
            backend: 'claude',
            original_prompt: 'test',
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
            schema_version: 5,
        });

        const ctx = makeCtx(statePath, 0);
        const result = readLoopExit(ctx);
        assert.equal(result, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
