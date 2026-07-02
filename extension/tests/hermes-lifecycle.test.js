// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    evaluateManagerRelaunch,
    recordManagerRelaunch,
} from '../services/manager-relaunch.js';
import { Defaults } from '../types/index.js';

const pendingTickets = [
    { id: 'done', status: 'Done', title: '', order: 1, type: null, working_dir: null, completed_at: null, skipped_at: null },
    { id: 'pending', status: 'Todo', title: '', order: 2, type: null, working_dir: null, completed_at: null, skipped_at: null },
];

function hermesState(overrides = {}) {
    return {
        active: true,
        step: 'implement',
        iteration: 1,
        max_iterations: 100,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        max_time_minutes: 720,
        working_dir: process.cwd(),
        backend: 'hermes',
        manager_relaunch_count: 2,
        schema_version: 3,
        ...overrides,
    };
}

test('hermes-lifecycle: simple relaunch decision is eligible below cap', () => {
    const decision = evaluateManagerRelaunch(hermesState(), true);

    assert.equal(decision.should_relaunch, true);
    assert.equal(decision.reason, 'below_cap');
    assert.equal(decision.current_count, 2);
    assert.equal(decision.cap, Defaults.CODEX_MANAGER_RELAUNCH_CAP);
});

test('hermes-lifecycle: simple relaunch decision refuses when no work remains', () => {
    const decision = evaluateManagerRelaunch(hermesState(), false);

    assert.equal(decision.should_relaunch, false);
    assert.equal(decision.reason, 'no_pending_work');
});

test('hermes-lifecycle: runner relaunch decision counts pending hermes tickets', () => {
    const decision = evaluateManagerRelaunch(hermesState(), pendingTickets, null);

    assert.equal(decision.shouldRelaunch, true);
    assert.equal(decision.reason, 'eligible');
    assert.equal(decision.pendingCount, 1);
    assert.equal(decision.nextRelaunchCount, 3);
});

test('hermes-lifecycle: relaunch cap is enforced for hermes', () => {
    const state = hermesState({ manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP });
    const runnerDecision = evaluateManagerRelaunch(state, pendingTickets, null);
    const simpleDecision = evaluateManagerRelaunch(state, true);

    assert.equal(runnerDecision.shouldRelaunch, false);
    assert.equal(runnerDecision.reason, 'cap_exceeded');
    assert.equal(simpleDecision.should_relaunch, false);
    assert.equal(simpleDecision.reason, 'at_cap');
});

test('hermes-lifecycle: record relaunch persists shared manager counter', () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-hermes-relaunch-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-hermes-relaunch-data-'));
    const previousDataRoot = process.env.PICKLE_DATA_ROOT;
    const statePath = path.join(sessionDir, 'state.json');

    try {
        process.env.PICKLE_DATA_ROOT = dataRoot;
        fs.writeFileSync(statePath, JSON.stringify(hermesState({ manager_relaunch_count: 2 }), null, 2));
        const decision = evaluateManagerRelaunch(JSON.parse(fs.readFileSync(statePath, 'utf-8')), pendingTickets, null);

        recordManagerRelaunch(statePath, sessionDir, decision, 5, () => {});

        const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(persisted.backend, 'hermes');
        assert.equal(persisted.manager_relaunch_count, 3);
        assert.equal('codex_manager_relaunch_count' in persisted, false);
    } finally {
        if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
        else process.env.PICKLE_DATA_ROOT = previousDataRoot;
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});
