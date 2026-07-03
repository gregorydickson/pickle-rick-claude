// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(__dirname, '../src/bin/mux-runner.ts'), 'utf8');

test('mux-runner-timer: iterTimeout absent from source', () => {
    assert.ok(!src.includes('iterTimeout'), 'iterTimeout should have been removed (FR-B1)');
});

test('mux-runner-timer: killEscalation absent from source', () => {
    assert.ok(!src.includes('killEscalation'), 'killEscalation should have been removed (FR-B1)');
});

test('mux-runner-timer: "iteration timed out" string absent from source', () => {
    assert.ok(!src.includes('iteration timed out'), '"iteration timed out" log line should have been removed (FR-B1)');
});

test('mux-runner-timer: hangGuard present in source', () => {
    assert.ok(src.includes('hangGuard'), 'hangGuard must remain as sole kill authority');
});

test('mux-runner-timer: hangGuardMs defaults to MAX_ITERATION_SECONDS with runtime override support', () => {
    // Anchor is declaration-shape-agnostic: matches the pre-refactor `const` local
    // and the IterationProcessController constructor parameter property alike.
    assert.ok(
        src.includes('hangGuardMs = (runtimeOverrides.maxIterationSeconds ?? Defaults.MAX_ITERATION_SECONDS) * 1000'),
        'hangGuardMs must default to Defaults.MAX_ITERATION_SECONDS while allowing explicit runtime overrides',
    );
});

test('mux-runner-timer: outputStallGuardMs defaults to OUTPUT_STALL_SECONDS with runtime override support', () => {
    assert.ok(
        src.includes('outputStallGuardMs = (runtimeOverrides.outputStallSeconds ?? Defaults.OUTPUT_STALL_SECONDS) * 1000'),
        'outputStallGuardMs must default to Defaults.OUTPUT_STALL_SECONDS while allowing explicit runtime overrides',
    );
});
