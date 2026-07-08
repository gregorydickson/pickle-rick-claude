// @tier: fast
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    renderDashboard,
    renderMicroverseDashboard,
    inferModeFromStep,
} from '../bin/monitor.js';

function tmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mmd-')));
}

function stripAnsi(s) {
    return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function baseState(sessionDir, overrides = {}) {
    return {
        active: false,
        step: 'implement',
        iteration: 1,
        max_iterations: 50,
        session_dir: sessionDir,
        current_ticket: null,
        working_dir: sessionDir,
        start_time_epoch: Math.floor(Date.now() / 1000),
        ...overrides,
    };
}

function writeMicroverseJson(sessionDir) {
    const mv = {
        status: 'iterating',
        key_metric: { name: 'coverage', type: 'numeric', direction: 'higher', unit: '%' },
        convergence_target: 90,
        failure_history: [],
        convergence: {
            stall_counter: 0,
            stall_limit: 5,
            history: [
                { iteration: 1, score: 72, action: 'accept' },
                { iteration: 2, score: 75, action: 'accept' },
            ],
        },
        subsystems: ['services', 'bin'],
        current_subsystem: 'services',
    };
    fs.writeFileSync(path.join(sessionDir, 'microverse.json'), JSON.stringify(mv));
}

describe('monitor-mode-dispatch', () => {
    it('(1) --mode anatomy-park renders microverse template: Subsystems present, Tickets absent', () => {
        const sessionDir = tmpDir();
        try {
            const state = baseState(sessionDir, { step: 'anatomy-park' });
            writeMicroverseJson(sessionDir);

            const segments = renderDashboard(state, 'anatomy-park', sessionDir, 80);
            const plain = stripAnsi(segments.join(''));

            assert.ok(
                plain.includes('Subsystems'),
                `expected "Subsystems" in output, got: ${plain.slice(0, 300)}`,
            );
            assert.ok(
                !plain.includes('Tickets:'),
                `expected "Tickets:" to be absent in anatomy-park mode, got: ${plain.slice(0, 300)}`,
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });

    it('(2) --mode pickle renders pickle template: Tickets present', () => {
        const sessionDir = tmpDir();
        try {
            const state = baseState(sessionDir, { step: 'implement' });

            // write at least one ticket so buildPickleOutput renders the Tickets header
            const ticketDir = path.join(sessionDir, 'aabbccdd');
            fs.mkdirSync(ticketDir, { recursive: true });
            fs.writeFileSync(
                path.join(ticketDir, 'rick_ticket_aabbccdd.md'),
                [
                    '---',
                    'id: aabbccdd',
                    'title: "Test ticket"',
                    'status: "Todo"',
                    'priority: High',
                    'order: 1',
                    'created: 2026-05-26',
                    'updated: 2026-05-26',
                    '---',
                    '# Description',
                    'placeholder',
                ].join('\n'),
            );

            const segments = renderDashboard(state, 'pickle', sessionDir, 80);
            const plain = stripAnsi(segments.join(''));

            assert.ok(
                plain.includes('Tickets:'),
                `expected "Tickets:" in pickle mode output, got: ${plain.slice(0, 300)}`,
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });

    it('(3) --mode anatomy-park with missing microverse.json renders initializing stub without throwing', () => {
        const sessionDir = tmpDir();
        try {
            const state = baseState(sessionDir, { step: 'anatomy-park' });
            // microverse.json intentionally NOT written

            let output;
            assert.doesNotThrow(() => {
                const segments = renderDashboard(state, 'anatomy-park', sessionDir, 80);
                output = stripAnsi(segments.join(''));
            });

            assert.ok(
                output && output.includes('initializing'),
                `expected "initializing" in stub output, got: ${(output || '').slice(0, 300)}`,
            );
            assert.ok(
                !output.includes('Tickets:'),
                `expected "Tickets:" absent in initializing stub`,
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });

    it('(4) mode auto-detect: step=pickle → pickle render; step=anatomy-park → microverse render', () => {
        const sessionDir = tmpDir();
        try {
            writeMicroverseJson(sessionDir);

            // pickle step → inferModeFromStep returns 'pickle' → renderDashboard yields pickle output
            const pickleState = baseState(sessionDir, { step: 'implement' });
            const pickleMode = inferModeFromStep('implement');
            assert.equal(pickleMode, 'pickle', 'implement step should map to pickle mode');
            const pickleSegments = renderDashboard(pickleState, pickleMode, sessionDir, 80);
            // pickle template doesn't include "Subsystems:" header (that's microverse-only)
            const picklePlain = stripAnsi(pickleSegments.join(''));
            assert.ok(
                !picklePlain.includes('MICROVERSE MONITOR'),
                `expected pickle template (not microverse header), got: ${picklePlain.slice(0, 300)}`,
            );

            // anatomy-park step → inferModeFromStep returns 'microverse' → renderDashboard yields microverse output
            const anatomyState = baseState(sessionDir, { step: 'anatomy-park' });
            const anatomyMode = inferModeFromStep('anatomy-park');
            assert.equal(anatomyMode, 'microverse', 'anatomy-park step should map to microverse mode');
            const anatomySegments = renderDashboard(anatomyState, anatomyMode, sessionDir, 80);
            const anatomyPlain = stripAnsi(anatomySegments.join(''));
            assert.ok(
                anatomyPlain.includes('MICROVERSE MONITOR'),
                `expected microverse template header, got: ${anatomyPlain.slice(0, 300)}`,
            );
            assert.ok(
                !anatomyPlain.includes('Tickets:'),
                `expected "Tickets:" absent in microverse render`,
            );
        } finally {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});
