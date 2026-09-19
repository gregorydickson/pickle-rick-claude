// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { detectManagerMaxTurnsExit } from '../bin/mux-runner.js';

function writeLog(contents) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-max-turns-')));
    const logFile = path.join(dir, 'tmux_iteration_7.log');
    fs.writeFileSync(logFile, contents);
    return { dir, logFile };
}

function managerResultFixture(overrides = {}) {
    return {
        completion: 'error',
        timedOut: false,
        exitCode: 0,
        wallSeconds: 42,
        ...overrides,
    };
}

test('max-turns-detection: clean claude end_turn result at budget returns true', () => {
    const { dir, logFile } = writeLog([
        '{"type":"assistant","message":{"role":"assistant"}}',
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}',
        '',
    ].join('\n'));
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: timed out hang-guard outcome returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture({ timedOut: true }), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: non-zero exit code returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture({ exitCode: 1 }), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: last result event with is_error true returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":true,"num_turns":40}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: missing log file returns false', () => {
    assert.equal(
        detectManagerMaxTurnsExit(managerResultFixture(), '/definitely/missing/pickle-max-turns.log', 40),
        false,
    );
});

test('max-turns-detection: non-error completion returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture({ completion: 'continue' }), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: last result event must match even if earlier one does not', () => {
    const { dir, logFile } = writeLog([
        '{"type":"result","stop_reason":"tool_use","terminal_reason":"completed","is_error":false}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"continuing"}]}}',
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}',
        '',
    ].join('\n'));
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: last result event stop_reason mismatch returns false', () => {
    const { dir, logFile } = writeLog([
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"continuing"}]}}',
        '{"type":"result","stop_reason":"tool_use","terminal_reason":"completed","is_error":false,"num_turns":40}',
        '',
    ].join('\n'));
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: below-budget num_turns returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":39}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('max-turns-detection: missing max-turns budget returns false', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":40}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, null), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// AP-EXT-ITER292-02: the last-result-event discriminator set is enumerated, but only
// `stop_reason` and `is_error` were fixtured. `terminal_reason` and the `turn_count`
// fallback both survived a 602-test oracle when amputated, because every fixture in the
// corpus pairs `terminal_reason: 'completed'` with `stop_reason: 'end_turn'` and supplies
// `num_turns`, so neither ever varied independently of its siblings.
test('AP-EXT-ITER292-02: terminal_reason discriminates independently of stop_reason', () => {
    const rows = [
        { terminalReason: 'completed', expected: true },
        { terminalReason: 'max_turns', expected: false },
        { terminalReason: 'crash', expected: false },
        { terminalReason: 'error_during_execution', expected: false },
    ];
    for (const { terminalReason, expected } of rows) {
        const { dir, logFile } = writeLog(
            `{"type":"result","stop_reason":"end_turn","terminal_reason":"${terminalReason}","is_error":false,"num_turns":40}\n`
        );
        try {
            assert.equal(
                detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40),
                expected,
                `terminal_reason=${terminalReason} with every sibling field at the accepting value`,
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('AP-EXT-ITER292-02: turn_count is the live budget source when num_turns is absent', () => {
    const rows = [
        { turnCount: 40, expected: true },
        { turnCount: 41, expected: true },
        { turnCount: 39, expected: false },
    ];
    for (const { turnCount, expected } of rows) {
        const { dir, logFile } = writeLog(
            `{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"turn_count":${turnCount}}\n`
        );
        try {
            assert.equal(
                detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40),
                expected,
                `turn_count=${turnCount} against a budget of 40, no num_turns present`,
            );
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
});

test('AP-EXT-ITER292-02: num_turns wins over a disagreeing turn_count', () => {
    const { dir, logFile } = writeLog(
        '{"type":"result","stop_reason":"end_turn","terminal_reason":"completed","is_error":false,"num_turns":39,"turn_count":40}\n'
    );
    try {
        assert.equal(detectManagerMaxTurnsExit(managerResultFixture(), logFile, 40), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
