// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { updateState } from '../services/pickle-utils.js';

function withTempSession(initialState, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(initialState));
    try {
        fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
}

test('updateState: sets a top-level key', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        updateState('step', 'breakdown', dir);
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.step, 'breakdown');
    });
});

test('updateState: preserves existing keys', () => {
    withTempSession({ active: true, step: 'prd', iteration: 3 }, (dir) => {
        updateState('step', 'research', dir);
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.active, true);
        assert.equal(state.iteration, 3);
    });
});

test('updateState: sets current_ticket', () => {
    withTempSession({ active: true, current_ticket: null }, (dir) => {
        updateState('current_ticket', 'abc123', dir);
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.current_ticket, 'abc123');
    });
});

test('updateState: changing current_ticket clears circuit-breaker budget cache', () => {
    withTempSession({
        active: true,
        current_ticket: 'old123',
        current_ticket_tier: 'large',
        current_ticket_budget: 12,
    }, (dir) => {
        updateState('current_ticket', 'new123', dir);
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.current_ticket, 'new123');
        assert.equal(state.current_ticket_tier, undefined);
        assert.equal(state.current_ticket_budget, undefined);
    });
});

test('updateState: throws when state.json missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        assert.throws(
            () => updateState('step', 'prd', dir),
            /state\.json not found/
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// ---------------------------------------------------------------------------
// Step validation
// ---------------------------------------------------------------------------

test('updateState: valid step "implement" is accepted', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.doesNotThrow(() => updateState('step', 'implement', dir));
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.step, 'implement');
    });
});

test('updateState: valid step "refactor" is accepted', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.doesNotThrow(() => updateState('step', 'refactor', dir));
    });
});

test('updateState: pipeline lifecycle steps are accepted', () => {
    const pipelineSteps = ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'];
    for (const step of pipelineSteps) {
        withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
            assert.doesNotThrow(() => updateState('step', step, dir));
            const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
            assert.equal(state.step, step);
        });
    }
});

test('updateState: invalid step throws with helpful message', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.throws(
            () => updateState('step', 'bad-step', dir),
            /invalid step/i
        );
    });
});

test('updateState: step validation is case-sensitive ("PRD" is not valid)', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.throws(
            () => updateState('step', 'PRD', dir),
            /invalid step/i
        );
    });
});

test('updateState: unknown keys are rejected', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.throws(
            () => updateState('custom_key', 'any-value', dir),
            /unknown state key/i
        );
    });
});

test('updateState: allowed non-step key "current_ticket" bypasses step validation', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.doesNotThrow(() => updateState('current_ticket', 'TICK-42', dir));
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.current_ticket, 'TICK-42');
    });
});

test('updateState: numeric key with non-numeric value throws', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.throws(
            () => updateState('iteration', 'abc', dir),
            /requires a finite number/i
        );
    });
});

test('updateState: numeric runner control keys reject fractional values', () => {
    withTempSession({ active: true, step: 'prd', worker_timeout_seconds: 60 }, (dir) => {
        assert.throws(
            () => updateState('worker_timeout_seconds', '1.5', dir),
            /requires an integer/i
        );
    });
});

test('updateState: worker_timeout_seconds rejects zero before mux-runner startup', () => {
    withTempSession({ active: true, step: 'prd', worker_timeout_seconds: 60 }, (dir) => {
        assert.throws(
            () => updateState('worker_timeout_seconds', '0', dir),
            /requires a positive integer/i
        );
    });
});

test('updateState: iteration rejects negative values before mux-runner startup', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.throws(
            () => updateState('iteration', '-1', dir),
            /requires a non-negative integer/i
        );
    });
});

// ---------------------------------------------------------------------------
// Boolean key coercion (C2 fix)
// ---------------------------------------------------------------------------

test('updateState: rejects "active" — owned by mux-runner/cancel.js', () => {
    withTempSession({ active: false, step: 'prd', iteration: 0 }, (dir) => {
        assert.throws(
            () => updateState('active', 'true', dir),
            /Unknown state key/i
        );
    });
});

test('updateState: rejects "completion_promise" — immutable after creation', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.throws(
            () => updateState('completion_promise', 'I AM DONE', dir),
            /Unknown state key/i
        );
    });
});

test('updateState: boolean key "tmux_mode" with "true" stores boolean true', () => {
    withTempSession({ active: true, step: 'prd', tmux_mode: false }, (dir) => {
        updateState('tmux_mode', 'true', dir);
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.strictEqual(state.tmux_mode, true);
        assert.strictEqual(typeof state.tmux_mode, 'boolean');
    });
});

test('updateState: boolean key rejects non-boolean values', () => {
    withTempSession({ active: true, step: 'prd', tmux_mode: false }, (dir) => {
        assert.throws(
            () => updateState('tmux_mode', 'yes', dir),
            /requires "true" or "false"/i
        );
    });
});

test('updateState: boolean key rejects numeric-looking values', () => {
    withTempSession({ active: true, step: 'prd', tmux_mode: false }, (dir) => {
        assert.throws(
            () => updateState('tmux_mode', '1', dir),
            /requires "true" or "false"/i
        );
    });
});

// ---------------------------------------------------------------------------
// CLI guard: sessionDir flag validation (deep review pass 12)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Review-loop fields: min_iterations, command_template, step: 'review'
// ---------------------------------------------------------------------------

test('updateState: min_iterations accepted as numeric key', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        updateState('min_iterations', '10', dir);
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.strictEqual(state.min_iterations, 10);
        assert.strictEqual(typeof state.min_iterations, 'number');
    });
});

test('updateState: command_template accepted as string key', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        updateState('command_template', 'szechuan-sauce.md', dir);
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.command_template, 'szechuan-sauce.md');
    });
});

test('updateState: step "review" is valid', () => {
    withTempSession({ active: true, step: 'prd', iteration: 0 }, (dir) => {
        assert.doesNotThrow(() => updateState('step', 'review', dir));
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(state.step, 'review');
    });
});

// ---------------------------------------------------------------------------
// CLI guard: sessionDir flag validation (deep review pass 12)
// ---------------------------------------------------------------------------

test('updateState CLI: exits 1 when sessionDir starts with --', () => {
    const updateStatePath = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '../bin/update-state.js'
    );
    assert.throws(
        () => execFileSync('node', [updateStatePath, 'step', 'breakdown', '--max-time'], { encoding: 'utf-8' }),
        (err) => {
            assert.ok(err.stderr.includes('Usage'), `Expected Usage in stderr, got: ${err.stderr}`);
            assert.equal(err.status, 1);
            return true;
        }
    );
});
