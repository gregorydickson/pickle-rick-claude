// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const COMMAND_PATH = path.resolve(import.meta.dirname, '../../../.claude/commands/anatomy-park.md');

function readCommand() {
    return fs.readFileSync(COMMAND_PATH, 'utf-8');
}

test('anatomy-park Step 6.6 appears between Step 6.5 and Step 7', () => {
    const content = readCommand();
    const m = /### Step 6\.5[\s\S]*?### Step 6\.6[\s\S]*?### Step 7/.test(content);
    assert.ok(m, 'Step 6.6 must appear between Step 6.5 and Step 7');
});

test('anatomy-park tmux chain invokes finalize-gate.js with anatomy-park skill', () => {
    const content = readCommand();
    assert.ok(content.includes('finalize-gate.js'), 'tmux chain must reference finalize-gate.js');
    const gateIdx = content.indexOf('finalize-gate.js');
    const chainStart = content.lastIndexOf('tmux send-keys', gateIdx);
    assert.ok(chainStart !== -1, 'finalize-gate.js must appear inside a tmux send-keys block');
    const chainRegion = content.slice(chainStart, gateIdx + 60);
    assert.ok(
        chainRegion.includes('microverse-runner.js') && chainRegion.includes('&&'),
        'microverse-runner.js must precede finalize-gate.js with && operator'
    );
    assert.ok(
        content.slice(gateIdx, gateIdx + 60).includes('anatomy-park'),
        'finalize-gate.js must be called with anatomy-park skill argument'
    );
});

test('anatomy-park all 4 gate message variants are present', () => {
    const content = readCommand();
    const variants = [
        'Gate skipped (PICKLE_GATE_DISABLED=1)',
        'Gate green. No regressions during loop',
        'all cleared by final gate',
        'gate exhausted remediation cycles',
    ];
    for (const v of variants) {
        assert.ok(content.includes(v), `Missing message variant: ${v}`);
    }
});

test('anatomy-park documents phase-2.5 pattern replay sweep', () => {
    const content = readCommand();
    const replayIdx = content.indexOf('#### PHASE 2.5: PATTERN REPLAY SWEEP');
    const phase2Idx = content.indexOf('#### PHASE 2: FIX');
    const phase3Idx = content.indexOf('#### PHASE 3: VERIFY');

    assert.ok(replayIdx > phase2Idx, 'Phase 2.5 must appear after Phase 2');
    assert.ok(replayIdx < phase3Idx, 'Phase 2.5 must appear before Phase 3');
    const section = content.slice(replayIdx, phase3Idx);
    assert.ok(
        section.includes('For EVERY Phase 2 fix') && !section.includes('`category: pattern`:'),
        'Phase 2.5 must trigger on every Phase 2 fix'
    );
    assert.ok(
        content.includes('Re-grep or re-walk the full diff scope'),
        'Phase 2.5 must replay the structural shape across the diff scope'
    );
});

test('F75-SWEEP-: PHASE 2.5 fixes in-lane siblings in the same commit and replays only out-of-lane', () => {
    const content = readCommand();
    const section = content.slice(
        content.indexOf('#### PHASE 2.5: PATTERN REPLAY SWEEP'),
        content.indexOf('#### PHASE 3: VERIFY')
    );
    assert.ok(section.includes('For EVERY Phase 2 fix'), 'every-fix trigger');
    assert.ok(!section.includes('severity: CRITICAL` AND `category: pattern'), 'no CRITICAL+pattern-only trigger');
    assert.ok(/In the current lane[\s\S]*same commit[\s\S]*one regression test per sibling/.test(section), 'in-lane siblings fixed in same commit');
    assert.ok(/Outside the lane[\s\S]*phase: "replay"/.test(section), 'replay only out-of-lane');
    for (const tok of ['original_finding_id', 'pattern_shape', 'PATTERN_SHAPE:']) {
        assert.ok(section.includes(tok), tok);
    }
});

test('anatomy-park replay findings and trap doors carry pattern metadata', () => {
    const content = readCommand();
    const required = [
        'phase: "discovery" | "replay"',
        'original_finding_id',
        'phase: "replay"',
        'pattern_shape',
        'PATTERN_SHAPE:',
    ];

    for (const token of required) {
        assert.ok(content.includes(token), `Missing anatomy-park replay metadata: ${token}`);
    }
});

test('anatomy-park persona prose unchanged', () => {
    const content = readCommand();
    const expected = 'Ladies and gentlemen, Anatomy Park is CLOSED. Every organ accounted for. No casualties. Well... minimal casualties.';
    assert.ok(content.includes(expected), 'Persona prose (convergence line) must be unchanged');
    assert.ok(
        content.includes('Each subsystem is an organ in the park'),
        'Persona prose (subsystem line) must be unchanged'
    );
});
