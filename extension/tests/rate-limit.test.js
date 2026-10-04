// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    detectRateLimitInLog,
    detectRateLimitInText,
    classifyIterationExit,
    computeRateLimitAction,
    isUsageWarning,
} from '../bin/mux-runner.js';

function makeTmpDir(prefix = 'rl-test-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// ---------------------------------------------------------------------------
// detectRateLimitInLog — returns RateLimitInfo
// ---------------------------------------------------------------------------

test('detectRateLimitInLog: returns limited=true for rate_limit_event with status rejected (flat)', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working...' }] } }),
            JSON.stringify({ type: 'rate_limit_event', status: 'rejected' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        const info = detectRateLimitInLog(logFile);
        assert.equal(info.limited, true);
        assert.equal(info.resetsAt, undefined);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns limited=true with resetsAt for nested rate_limit_info', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({
                type: 'rate_limit_event',
                rate_limit_info: {
                    status: 'rejected',
                    resetsAt: 1772229600,
                    rateLimitType: 'five_hour',
                    overageStatus: 'allowed',
                    isUsingOverage: true,
                },
            }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        const info = detectRateLimitInLog(logFile);
        assert.equal(info.limited, true);
        assert.equal(info.resetsAt, 1772229600);
        assert.equal(info.rateLimitType, 'five_hour');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns limited=false when no rate_limit_event present', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All good' }] } }),
            JSON.stringify({ type: 'result', subtype: 'success' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        const info = detectRateLimitInLog(logFile);
        assert.equal(info.limited, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns limited=false for rate_limit_event with non-rejected status', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1772424000 } }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        const info = detectRateLimitInLog(logFile);
        assert.equal(info.limited, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: allowed_warning is limited and carries status, resetsAt and rateLimitType', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({
                type: 'rate_limit_event',
                rate_limit_info: { status: 'allowed_warning', resetsAt: 1772816400, rateLimitType: 'seven_day', utilization: 0.52 },
            }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        const info = detectRateLimitInLog(logFile);
        assert.equal(info.limited, true);
        assert.equal(info.status, 'allowed_warning');
        assert.equal(info.resetsAt, 1772816400);
        assert.equal(info.rateLimitType, 'seven_day');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('F75-RLWARN-: a warning at line 4 of a 150-line log classifies as api_limit with its reset carried', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = ['{"type":"system"}', '{"type":"assistant"}', '{"type":"assistant"}'];
        lines.push(JSON.stringify({
            type: 'rate_limit_event',
            rate_limit_info: { status: 'allowed_warning', resetsAt: 1772816400, rateLimitType: 'five_hour', utilization: 0.9 },
        }));
        for (let i = 0; i < 146; i++) lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `line ${i}` }] } }));
        fs.writeFileSync(logFile, lines.join('\n'));
        const result = classifyIterationExit('continue', logFile);
        assert.equal(result.type, 'api_limit');
        assert.equal(result.rateLimitInfo.status, 'allowed_warning');
        assert.equal(result.rateLimitInfo.resetsAt, 1772816400);
        assert.equal(isUsageWarning(result.rateLimitInfo), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('F75-RLWARN-: a rejection is not a warning', () => {
    assert.equal(isUsageWarning({ limited: true, status: 'rejected' }), false);
    assert.equal(isUsageWarning(undefined), false);
});

test('detectRateLimitInLog: handles non-JSON lines gracefully', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            '{not valid json',
            'plain text line',
            JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1772229600 } }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        const info = detectRateLimitInLog(logFile);
        assert.equal(info.limited, true);
        assert.equal(info.resetsAt, 1772229600);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: returns limited=false for missing file', () => {
    const info = detectRateLimitInLog('/nonexistent/path/iter.log');
    assert.equal(info.limited, false);
});

test('detectRateLimitInLog: a crossing anywhere in the log counts; a LATER allowed event clears it', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const event = (status) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: 1772229600 } });
        const filler = [];
        for (let i = 0; i < 150; i++) filler.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `line ${i}` }] } }));
        fs.writeFileSync(logFile, [event('rejected'), ...filler].join('\n'));
        assert.equal(detectRateLimitInLog(logFile).limited, true);
        fs.writeFileSync(logFile, [event('rejected'), ...filler, event('allowed')].join('\n'));
        const cleared = detectRateLimitInLog(logFile);
        assert.equal(cleared.limited, false);
        assert.equal(cleared.sawEvents, true);
        assert.equal(cleared.resetsAt, undefined);
        // F75-RLWARN-: same clearing rule for a warning
        fs.writeFileSync(logFile, [event('allowed_warning'), ...filler, event('allowed')].join('\n'));
        assert.equal(detectRateLimitInLog(logFile).limited, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: last rejected event wins (takes latest resetsAt)', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1000000, rateLimitType: 'five_hour' } }),
            JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 2000000, rateLimitType: 'seven_day' } }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        const info = detectRateLimitInLog(logFile);
        assert.equal(info.limited, true);
        assert.equal(info.resetsAt, 2000000);
        assert.equal(info.rateLimitType, 'seven_day');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// detectRateLimitInText
// ---------------------------------------------------------------------------

test('detectRateLimitInText: detects "usage limit has been reached" in plain text', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        // Plain text lines (not JSON content) should match
        fs.writeFileSync(logFile, 'your daily usage limit has been reached\n');
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: detects "usage is limited...try again" in plain text', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        fs.writeFileSync(logFile, 'Your usage is limited. Please try again later.\n');
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: detects "rate limited...try again" in plain text', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        fs.writeFileSync(logFile, 'You are rate limited. Please try again in a few minutes.\n');
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: filters out JSON assistant/text content lines (no false positives)', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        // Lines containing "type":"assistant" or "type":"text" are filtered out
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'API rate limit exceeded.' }] } }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: ignores rate limit text inside tool_result lines', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            '{"type":"tool_result","content":"Error: rate limit exceeded"}',
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: ignores rate limit text inside user lines', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            '{"type":"user","content":"Please handle rate limit errors"}',
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: does not detect text beyond last 20 lines', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = ["You're out of usage for today"];
        for (let i = 0; i < 30; i++) {
            lines.push(`clean line ${i}`);
        }
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns false for missing file', () => {
    assert.equal(detectRateLimitInText('/nonexistent/path/iter.log'), false);
});

test('detectRateLimitInText: detects "out of extra usage" in plain text', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        fs.writeFileSync(logFile, "You're out of extra usage · resets Mar 6 at 11am\n");
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: detects "out of usage" (without extra) in plain text', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        fs.writeFileSync(logFile, "You're out of usage for today\n");
        assert.equal(detectRateLimitInText(logFile), true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInText: returns false for clean log', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Everything is fine.' }] } }),
            JSON.stringify({ type: 'result', subtype: 'success' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(detectRateLimitInText(logFile), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// classifyIterationExit — returns IterationExitResult
// ---------------------------------------------------------------------------

test('classifyIterationExit: task_completed → success', () => {
    const r = classifyIterationExit('task_completed', '/nonexistent/log');
    assert.equal(r.type, 'success');
    assert.equal(r.rateLimitInfo, undefined);
});

test('classifyIterationExit: review_clean → success', () => {
    assert.equal(classifyIterationExit('review_clean', '/nonexistent/log').type, 'success');
});

test('classifyIterationExit: error → error', () => {
    assert.equal(classifyIterationExit('error', '/nonexistent/log').type, 'error');
});

test('classifyIterationExit: inactive → inactive', () => {
    assert.equal(classifyIterationExit('inactive', '/nonexistent/log').type, 'inactive');
});

test('classifyIterationExit: continue with rate_limit_event in log → api_limit with rateLimitInfo', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1772229600, rateLimitType: 'five_hour' } }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        const r = classifyIterationExit('continue', logFile);
        assert.equal(r.type, 'api_limit');
        assert.equal(r.rateLimitInfo?.limited, true);
        assert.equal(r.rateLimitInfo?.resetsAt, 1772229600);
        assert.equal(r.rateLimitInfo?.rateLimitType, 'five_hour');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with rate limit plain text in log → api_limit without rateLimitInfo', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        // Plain text (not inside JSON content) triggers text fallback
        fs.writeFileSync(logFile, "your daily usage limit has been reached\n");
        const r = classifyIterationExit('continue', logFile);
        assert.equal(r.type, 'api_limit');
        assert.equal(r.rateLimitInfo, undefined);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with clean log → success', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'All done, nothing special.' }] } }),
            JSON.stringify({ type: 'result', subtype: 'success' }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        assert.equal(classifyIterationExit('continue', logFile).type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: continue with missing log file → success', () => {
    assert.equal(classifyIterationExit('continue', '/nonexistent/log').type, 'success');
});

test('classifyIterationExit: NDJSON detection takes priority over text detection', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const lines = [
            JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 9999999 } }),
            'Rate limit exceeded in plain text too',
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        const r = classifyIterationExit('continue', logFile);
        assert.equal(r.type, 'api_limit');
        assert.equal(r.rateLimitInfo?.resetsAt, 9999999);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: text-only api_limit has no rateLimitInfo (wait_source will be config)', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        // Only text pattern, no NDJSON rate_limit_event
        fs.writeFileSync(logFile, "You're out of usage for today\n");
        const r = classifyIterationExit('continue', logFile);
        assert.equal(r.type, 'api_limit');
        assert.equal(r.rateLimitInfo, undefined);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('classifyIterationExit: structured events present but not rejected → skips text fallback', () => {
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        // Structured rate_limit_event with 'accepted' status + text that would match
        const lines = [
            JSON.stringify({ type: 'rate_limit_event', status: 'accepted' }),
            "your daily usage limit has been reached",
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        const r = classifyIterationExit('continue', logFile);
        // Should be 'success' — structured events exist, none rejected, so text fallback is skipped
        assert.equal(r.type, 'success');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('detectRateLimitInLog: resetsAt in the past still sets limited=true', () => {
    // The resetsAt value is extracted regardless — the caller decides whether to use it
    const tmpDir = makeTmpDir();
    const logFile = path.join(tmpDir, 'iter.log');
    try {
        const pastEpoch = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
        const lines = [
            JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: pastEpoch, rateLimitType: 'five_hour' } }),
        ];
        fs.writeFileSync(logFile, lines.join('\n'));
        const info = detectRateLimitInLog(logFile);
        assert.equal(info.limited, true);
        assert.equal(info.resetsAt, pastEpoch);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Rate limit countdown computation (monitor display)
// ---------------------------------------------------------------------------

test('countdown computes remaining time from rate_limit_wait.json', () => {
    const waitData = {
        waiting: true,
        reason: 'API rate limit',
        started_at: new Date().toISOString(),
        wait_until: new Date(Date.now() + 52 * 60 * 1000 + 30 * 1000).toISOString(),
        consecutive_waits: 1,
        rate_limit_type: 'five_hour',
        resets_at_epoch: Math.floor(Date.now() / 1000) + 52 * 60,
        wait_source: 'api',
    };
    const remainMs = new Date(waitData.wait_until).getTime() - Date.now();
    const remainSec = Math.ceil(remainMs / 1000);
    assert.ok(remainSec > 3100 && remainSec <= 3150);
});

// ---------------------------------------------------------------------------
// computeRateLimitAction — pure decision function
// ---------------------------------------------------------------------------

test('computeRateLimitAction: resetsAt available → action=wait with api source', () => {
    const futureEpoch = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    const exitResult = { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt: futureEpoch } };
    const action = computeRateLimitAction(exitResult, 1, 3, 60);
    assert.equal(action.action, 'wait');
    assert.equal(action.waitSource, 'api');
    assert.equal(action.resetCounter, true);
    assert.equal(action.hasResetsAt, true);
    // waitMs should be ~3630s (3600 + 30s buffer) in ms, ±2s tolerance
    const expectedMs = (futureEpoch * 1000 - Date.now()) + 30_000;
    assert.ok(Math.abs(action.waitMs - expectedMs) < 2000, `waitMs ${action.waitMs} not close to ${expectedMs}`);
});

test('computeRateLimitAction: resetsAt available + retries >= max → still waits (does NOT bail)', () => {
    const futureEpoch = Math.floor(Date.now() / 1000) + 1800; // 30 min from now
    const exitResult = { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt: futureEpoch } };
    const action = computeRateLimitAction(exitResult, 5, 3, 60);
    assert.equal(action.action, 'wait', 'Should wait when resetsAt available, even if retries >= max');
    assert.equal(action.waitSource, 'api');
    assert.equal(action.resetCounter, true);
});

test('computeRateLimitAction: no resetsAt + retries >= max → bail', () => {
    const exitResult = { type: 'api_limit' }; // no rateLimitInfo
    const action = computeRateLimitAction(exitResult, 3, 3, 60);
    assert.equal(action.action, 'bail');
    assert.equal(action.waitMs, 0);
    assert.equal(action.resetCounter, false);
    assert.equal(action.hasResetsAt, false);
});

test('computeRateLimitAction: no resetsAt + retries < max → wait with config source', () => {
    const exitResult = { type: 'api_limit' };
    const action = computeRateLimitAction(exitResult, 1, 3, 60);
    assert.equal(action.action, 'wait');
    assert.equal(action.waitSource, 'config');
    assert.equal(action.waitMs, 60 * 60 * 1000); // 60 min in ms
    assert.equal(action.resetCounter, false);
    assert.equal(action.hasResetsAt, false);
});

// Ticket e9bdac75 (Workstream B): the 3× config cap is REMOVED. A far-future reset
// is now HONORED, clamped only to max_park_minutes (default 360). It no longer falls
// back to the config default and no longer spawn-burns into the wall.
test('computeRateLimitAction: far-future resetsAt → parks, clamped to max_park_minutes (no 3× cap)', () => {
    const farFuture = Math.floor(Date.now() / 1000) + 999999; // ~277h, well past max_park
    const exitResult = { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt: farFuture } };
    const action = computeRateLimitAction(exitResult, 1, 3, 60, 360); // explicit max_park=360
    assert.equal(action.action, 'wait');
    assert.equal(action.waitSource, 'api', 'honors the API reset, not config fallback');
    assert.equal(action.waitMs, 360 * 60 * 1000, 'clamped to max_park_minutes ceiling, not 3× config');
    assert.equal(action.resetCounter, true); // api source → counter reset
    assert.equal(action.hasResetsAt, true);
    assert.equal(action.resetAtEpochSec, farFuture, 'persists reset_at for --resume re-arm');
});

test('computeRateLimitAction: 5h resetsAt under max_park → parks the full ~5h (not 15-min 3× cap)', () => {
    const fiveHours = Math.floor(Date.now() / 1000) + 5 * 3600;
    const exitResult = { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt: fiveHours } };
    const action = computeRateLimitAction(exitResult, 1, 3, 5, 360); // 5min config, 360min ceiling
    assert.equal(action.action, 'wait');
    assert.equal(action.waitSource, 'api');
    // ~5h + 30s buffer, well under the 360-min ceiling and far above the old 15-min cap.
    const expectedMs = 5 * 3600 * 1000;
    assert.ok(action.waitMs >= expectedMs && action.waitMs <= expectedMs + 60_000,
        `waitMs ${action.waitMs} should be ~5h, not the removed 3×=15min cap`);
});

test('computeRateLimitAction: resetsAt in the past → falls back to config', () => {
    const pastEpoch = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const exitResult = { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt: pastEpoch } };
    const action = computeRateLimitAction(exitResult, 1, 3, 60);
    assert.equal(action.action, 'wait');
    assert.equal(action.waitSource, 'config');
    assert.equal(action.waitMs, 60 * 60 * 1000);
    assert.equal(action.hasResetsAt, true);
});

test('computeRateLimitAction: resetsAt = 0 → treated as no resetsAt', () => {
    const exitResult = { type: 'api_limit', rateLimitInfo: { limited: true, resetsAt: 0 } };
    const action = computeRateLimitAction(exitResult, 3, 3, 60);
    assert.equal(action.action, 'bail', 'resetsAt=0 should be treated as missing');
    assert.equal(action.hasResetsAt, false);
});

test('computeRateLimitAction: rateLimitInfo present but no resetsAt field → no resetsAt', () => {
    const exitResult = { type: 'api_limit', rateLimitInfo: { limited: true } };
    const action = computeRateLimitAction(exitResult, 2, 3, 60);
    assert.equal(action.action, 'wait');
    assert.equal(action.waitSource, 'config');
    assert.equal(action.hasResetsAt, false);
});
