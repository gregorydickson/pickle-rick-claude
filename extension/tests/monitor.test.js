// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    summarizeLine,
    sparkline,
    renderMicroverseTrend,
    formatCurrentField,
    buildTicketLines,
    readPipelineLifecycle,
    shouldMonitorExit,
    renderElapsedField,
    writeWithWatchdog,
    MONITOR_STDOUT_WATCHDOG_MS,
    renderDashboard,
    inferModeFromStep,
    checkAndSwapMode,
    renderMicroverseDashboard,
} from '../bin/monitor.js';
import { getHeight } from '../services/pickle-utils.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { Writable } from 'node:stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONITOR_BIN = path.resolve(__dirname, '../bin/monitor.js');
const DEAD_TMP_PID = 99_999_999;

/**
 * Run monitor.js as a subprocess.
 * @param {string[]} args - CLI arguments
 */
function run(args) {
    // 10s → 45s: budget for system load when run alongside concurrent
    // codex/tmux work. Tests validate CLI/panel output, not wall-clock.
    return spawnSync(process.execPath, [MONITOR_BIN, ...args], {
        env: { ...process.env },
        encoding: 'utf-8',
        timeout: 45000,
    });
}

function tmpDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-monitor-')));
}

function deadTmpPath(filePath) {
    return `${filePath}.tmp.${DEAD_TMP_PID}`;
}

// --- Startup validation ---

test('monitor: no args → exit 1, stderr includes Usage', () => {
    const result = run([]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});

test('monitor: non-existent session dir → exit 1, stderr includes Usage', () => {
    const result = run(['/tmp/definitely-does-not-exist-pickle-' + Date.now()]);
    assert.equal(result.status, 1, 'should exit with code 1');
    assert.ok(result.stderr.includes('Usage'), 'stderr should include Usage');
});

// --- summarizeLine ---

test('summarizeLine: assistant text → first line of text', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello Morty\nSecond line' }] },
    });
    assert.equal(summarizeLine(line), 'Hello Morty');
});

test('summarizeLine: assistant tool_use → tool icon + name', () => {
    const line = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
    });
    assert.equal(summarizeLine(line), '🔧 Bash');
});

test('summarizeLine: result success', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', num_turns: 5 });
    assert.equal(summarizeLine(line), '✅ success');
});

test('summarizeLine: result error', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_turns' });
    assert.equal(summarizeLine(line), '❌ error_max_turns');
});

test('summarizeLine: system init', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-6' });
    assert.equal(summarizeLine(line), '🚀 init (claude-opus-4-6)');
});

test('summarizeLine: non-JSON → returns stripped line', () => {
    assert.equal(summarizeLine('plain text output'), 'plain text output');
});

test('summarizeLine: empty → empty string', () => {
    assert.equal(summarizeLine(''), '');
    assert.equal(summarizeLine('   '), '');
});

test('summarizeLine: unknown JSON type → empty string', () => {
    assert.equal(summarizeLine(JSON.stringify({ type: 'content_block_delta' })), '');
});

// --- sparkline ---

test('sparkline: empty array → empty string', () => {
    assert.equal(sparkline([]), '');
});

test('sparkline: single value → single block', () => {
    const result = sparkline([5]);
    assert.equal(result.length, 1);
});

test('sparkline: ascending values → ascending blocks', () => {
    const result = sparkline([0, 5, 10]);
    assert.equal(result.length, 3);
    // First char should be lowest block, last should be highest
    assert.equal(result[0], '▁');
    assert.equal(result[2], '█');
});

test('sparkline: descending values → descending blocks', () => {
    const result = sparkline([10, 5, 0]);
    assert.equal(result.length, 3);
    assert.equal(result[0], '█');
    assert.equal(result[2], '▁');
});

test('sparkline: all same values → all same blocks', () => {
    const result = sparkline([3, 3, 3]);
    assert.ok(result[0] === result[1] && result[1] === result[2]);
});

// --- renderMicroverseTrend ---

function makeMicroverseState(overrides = {}) {
    return {
        status: 'iterating',
        prd_path: '/tmp/target',
        key_metric: {
            description: 'violations',
            validation: 'count',
            type: 'llm',
            timeout_seconds: 60,
            tolerance: 0,
            direction: 'lower',
        },
        convergence: {
            stall_limit: 5,
            stall_counter: 0,
            history: [],
        },
        convergence_target: 0,
        gap_analysis_path: '',
        failed_approaches: [],
        baseline_score: 10,
        ...overrides,
    };
}

test('renderMicroverseTrend: empty history shows "No measurements yet"', () => {
    const mv = makeMicroverseState();
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(text.includes('No measurements yet'));
});

test('renderMicroverseTrend: shows direction and target', () => {
    const mv = makeMicroverseState();
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(text.includes('lower'));
    assert.ok(text.includes('0'));
});

test('renderMicroverseTrend: shows score and sparkline with history', () => {
    const mv = makeMicroverseState({
        convergence: {
            stall_limit: 5,
            stall_counter: 0,
            history: [
                { iteration: 1, metric_value: '8', score: 8, action: 'accept', description: 'fix1', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
                { iteration: 2, metric_value: '5', score: 5, action: 'accept', description: 'fix2', pre_iteration_sha: 'b', timestamp: new Date().toISOString() },
                { iteration: 3, metric_value: '3', score: 3, action: 'accept', description: 'fix3', pre_iteration_sha: 'c', timestamp: new Date().toISOString() },
            ],
        },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    // Should show latest score
    assert.ok(text.includes('3'), 'should show latest score');
    // Should show iteration:score entries
    assert.ok(text.includes('1:8'), 'should show iteration 1 score');
    assert.ok(text.includes('2:5'), 'should show iteration 2 score');
    assert.ok(text.includes('3:3'), 'should show iteration 3 score');
});

test('renderMicroverseTrend: shows stall counter when > 0', () => {
    const mv = makeMicroverseState({
        convergence: {
            stall_limit: 5,
            stall_counter: 3,
            history: [
                { iteration: 1, metric_value: '5', score: 5, action: 'accept', description: 'fix', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
            ],
        },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(text.includes('Stall: 3/5'));
});

test('renderMicroverseTrend: hides stall counter when 0', () => {
    const mv = makeMicroverseState({
        convergence: {
            stall_limit: 5,
            stall_counter: 0,
            history: [
                { iteration: 1, metric_value: '5', score: 5, action: 'accept', description: 'fix', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
            ],
        },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(!text.includes('Stall:'));
});

test('renderMicroverseTrend: shows CONVERGED badge', () => {
    const mv = makeMicroverseState({
        status: 'converged',
        convergence: {
            stall_limit: 5,
            stall_counter: 0,
            history: [
                { iteration: 1, metric_value: '0', score: 0, action: 'accept', description: 'done', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
            ],
        },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(text.includes('CONVERGED'));
});

test('renderMicroverseTrend: shows STOPPED badge with exit reason', () => {
    const mv = makeMicroverseState({
        status: 'stopped',
        exit_reason: 'stall_limit',
        convergence: {
            stall_limit: 5,
            stall_counter: 5,
            history: [
                { iteration: 1, metric_value: '5', score: 5, action: 'accept', description: 'fix', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
            ],
        },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(text.includes('STOPPED'));
    assert.ok(text.includes('stall_limit'));
});

test('renderMicroverseTrend: reverted entries show ✗', () => {
    const mv = makeMicroverseState({
        convergence: {
            stall_limit: 5,
            stall_counter: 1,
            history: [
                { iteration: 1, metric_value: '8', score: 8, action: 'accept', description: 'fix', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
                { iteration: 2, metric_value: '10', score: 10, action: 'revert', description: 'regressed', pre_iteration_sha: 'b', timestamp: new Date().toISOString() },
            ],
        },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    assert.ok(text.includes('✗'), 'reverted entry should show ✗');
    assert.ok(text.includes('✓'), 'accepted entry should show ✓');
});

test('renderMicroverseTrend: limits history display to last 8', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({
        iteration: i + 1,
        metric_value: String(12 - i),
        score: 12 - i,
        action: 'accept',
        description: `fix${i}`,
        pre_iteration_sha: `sha${i}`,
        timestamp: new Date().toISOString(),
    }));
    const mv = makeMicroverseState({
        convergence: { stall_limit: 15, stall_counter: 0, history },
    });
    const lines = renderMicroverseTrend(mv, 80);
    const text = lines.join('');
    // First 4 iterations should not appear in the compact history line
    assert.ok(!text.includes('1:12'), 'iteration 1 should be trimmed from compact display');
    assert.ok(!text.includes('4:9'), 'iteration 4 should be trimmed from compact display');
    // Last 8 should appear
    assert.ok(text.includes('5:8'), 'iteration 5 should appear');
    assert.ok(text.includes('12:1'), 'iteration 12 should appear');
});

// --- getHeight ---

test('getHeight: returns positive integer', () => {
    const h = getHeight();
    assert.ok(Number.isFinite(h) && h > 0, 'height should be a positive number');
});

test('getHeight: fallback when stdout.rows unset', () => {
    // Can't easily mutate process.stdout.rows in node --test; verify default
    // fallback path by passing an explicit fallback.
    const h = getHeight(42);
    assert.ok(h > 0);
});

// --- formatCurrentField ---

function stripAnsi(s) {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeTicket(id, title, status = 'todo') {
    return {
        id,
        title,
        status,
        order: 0,
        type: null,
        working_dir: null,
        completed_at: null,
        skipped_at: null,
    };
}

test('formatCurrentField: null current → "none"', () => {
    const out = stripAnsi(formatCurrentField(null, [], 80));
    assert.equal(out, 'none');
});

test('formatCurrentField: id with matching ticket → "<id>: <title>"', () => {
    const tickets = [makeTicket('8171ad11', 'Fix dashboard monitor overflow')];
    const out = stripAnsi(formatCurrentField('8171ad11', tickets, 80));
    assert.equal(out, '8171ad11: Fix dashboard monitor overflow');
});

test('formatCurrentField: id with no matching ticket → bare id', () => {
    const out = stripAnsi(formatCurrentField('deadbeef', [], 80));
    assert.equal(out, 'deadbeef');
});

test('formatCurrentField: long title truncated with ellipsis', () => {
    const title = 'x'.repeat(200);
    const tickets = [makeTicket('abc12345', title)];
    const out = stripAnsi(formatCurrentField('abc12345', tickets, 40));
    assert.ok(out.endsWith('…'), `expected ellipsis, got: ${out}`);
    assert.ok(out.length <= 40, `expected <= width, got length ${out.length}`);
    assert.ok(out.startsWith('abc12345: '), 'should keep id prefix');
});

// --- buildTicketLines ---

function makeTickets(n) {
    return Array.from({ length: n }, (_, i) =>
        makeTicket(`tkt${String(i).padStart(3, '0')}`, `Ticket ${i}`, i < 5 ? 'done' : 'todo')
    );
}

test('buildTicketLines: empty list → empty', () => {
    const lines = buildTicketLines([], null, 10);
    assert.deepEqual(lines, []);
});

test('buildTicketLines: full list when tickets fit budget', () => {
    const tickets = makeTickets(5);
    const lines = buildTicketLines(tickets, 'tkt002', 20);
    assert.equal(lines.length, 5, 'should render all 5 tickets');
    assert.ok(!lines.some((l) => l.includes('more above')), 'no above indicator');
    assert.ok(!lines.some((l) => l.includes('more below')), 'no below indicator');
    const joined = stripAnsi(lines.join(''));
    for (let i = 0; i < 5; i++) {
        assert.ok(joined.includes(`Ticket ${i}`), `ticket ${i} should render`);
    }
});

test('buildTicketLines: windowed with 20 tickets in tight budget', () => {
    const tickets = makeTickets(20);
    // 21-row terminal minus ~10 header/footer/recent rows → body ~11 lines
    const budget = 11;
    const currentId = 'tkt009';
    const lines = buildTicketLines(tickets, currentId, budget);

    // Total lines must fit budget (including indicator lines)
    assert.ok(lines.length <= budget, `${lines.length} lines should fit budget ${budget}`);

    // Current ticket must be visible
    const joined = stripAnsi(lines.join(''));
    assert.ok(joined.includes('tkt009:'), 'current ticket must be visible');
    assert.ok(joined.includes('Ticket 9'), 'current ticket title must be visible');
});

test('buildTicketLines: "N more above" indicator correct', () => {
    const tickets = makeTickets(20);
    const budget = 11;
    // Pick a current near the end so window must drop items from the top
    const lines = buildTicketLines(tickets, 'tkt015', budget);
    const joined = stripAnsi(lines.join(''));
    const aboveMatch = joined.match(/\.\.\. (\d+) more above \.\.\./);
    assert.ok(aboveMatch, `expected "more above" indicator, got: ${joined}`);
    // The number should equal the count of hidden tickets above the window
    const hiddenAbove = Number(aboveMatch[1]);
    const firstVisibleMatch = joined.match(/tkt(\d{3}):/);
    assert.ok(firstVisibleMatch);
    const firstVisibleIdx = Number(firstVisibleMatch[1]);
    assert.equal(hiddenAbove, firstVisibleIdx, 'above count matches hidden prefix');
});

test('buildTicketLines: "N more below" indicator correct', () => {
    const tickets = makeTickets(20);
    const budget = 11;
    // Current near the start — window should hide the tail
    const lines = buildTicketLines(tickets, 'tkt002', budget);
    const joined = stripAnsi(lines.join(''));
    const belowMatch = joined.match(/\.\.\. (\d+) more below \.\.\./);
    assert.ok(belowMatch, `expected "more below" indicator, got: ${joined}`);
    const hiddenBelow = Number(belowMatch[1]);
    // Find last visible ticket index
    const allVisible = Array.from(joined.matchAll(/tkt(\d{3}):/g)).map((m) => Number(m[1]));
    const lastVisibleIdx = Math.max(...allVisible);
    assert.equal(hiddenBelow, 20 - lastVisibleIdx - 1, 'below count matches hidden suffix');
});

test('buildTicketLines: current always visible across anchor positions', () => {
    const tickets = makeTickets(20);
    const budget = 11;
    for (let i = 0; i < 20; i++) {
        const id = `tkt${String(i).padStart(3, '0')}`;
        const lines = buildTicketLines(tickets, id, budget);
        const joined = stripAnsi(lines.join(''));
        assert.ok(lines.length <= budget, `anchor ${i}: lines fit budget`);
        assert.ok(joined.includes(`${id}:`), `anchor ${i}: current visible`);
    }
});

test('buildTicketLines: no current → anchors on last Done ticket', () => {
    const tickets = makeTickets(20);
    const budget = 11;
    const lines = buildTicketLines(tickets, null, budget);
    assert.ok(lines.length <= budget);
    const joined = stripAnsi(lines.join(''));
    // Last done is tkt004 (indices 0-4 are done)
    assert.ok(joined.includes('tkt004:'), 'last-done ticket should be visible as anchor');
});

test('buildTicketLines: budget <= 0 renders full list', () => {
    const tickets = makeTickets(5);
    const lines = buildTicketLines(tickets, null, 0);
    assert.equal(lines.length, 5);
});

// --- pipeline lifecycle ---

test('readPipelineLifecycle: non-pipeline session → none', () => {
    const dir = tmpDir();
    assert.equal(readPipelineLifecycle(dir), 'none');
    fs.rmSync(dir, { recursive: true });
});

test('readPipelineLifecycle: pipeline-status running wins', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'pipeline.json'), JSON.stringify({ phases: ['pickle'] }));
    fs.writeFileSync(path.join(dir, 'pipeline-status.json'), JSON.stringify({ status: 'running' }));
    assert.equal(readPipelineLifecycle(dir), 'running');
    fs.rmSync(dir, { recursive: true });
});

test('readPipelineLifecycle: promotes newer dead tmp pipeline-status before exit decisions', () => {
    const dir = tmpDir();
    try {
        fs.writeFileSync(path.join(dir, 'pipeline.json'), JSON.stringify({ phases: ['pickle', 'anatomy-park'] }));
        const statusPath = path.join(dir, 'pipeline-status.json');
        const tmpPath = path.join(dir, 'pipeline-status.json.tmp.999999');
        fs.writeFileSync(statusPath, JSON.stringify({ status: 'running' }));
        fs.writeFileSync(tmpPath, JSON.stringify({ status: 'completed' }));
        const now = Date.now() / 1000;
        fs.utimesSync(statusPath, now - 10, now - 10);
        fs.utimesSync(tmpPath, now, now);

        assert.equal(readPipelineLifecycle(dir), 'completed');
        assert.equal(shouldMonitorExit(dir, false), true);
        assert.equal(JSON.parse(fs.readFileSync(statusPath, 'utf-8')).status, 'completed');
        assert.equal(fs.existsSync(tmpPath), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('readPipelineLifecycle: falls back to runner log when status file missing', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'pipeline.json'), JSON.stringify({ phases: ['pickle'] }));
    fs.writeFileSync(path.join(dir, 'pipeline-runner.log'), '[2026-04-19T00:00:00.000Z] Pipeline finished: 1/1 phases, 00:05\n');
    assert.equal(readPipelineLifecycle(dir), 'completed');
    fs.rmSync(dir, { recursive: true });
});

test('shouldMonitorExit: inactive single session exits', () => {
    const dir = tmpDir();
    assert.equal(shouldMonitorExit(dir, false), true);
    fs.rmSync(dir, { recursive: true });
});

test('shouldMonitorExit: inactive pipeline session stays open while running', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'pipeline.json'), JSON.stringify({ phases: ['pickle', 'anatomy-park'] }));
    fs.writeFileSync(path.join(dir, 'pipeline-status.json'), JSON.stringify({ status: 'running' }));
    assert.equal(shouldMonitorExit(dir, false), false);
    fs.rmSync(dir, { recursive: true });
});

test('shouldMonitorExit: inactive pipeline session exits once terminal', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'pipeline.json'), JSON.stringify({ phases: ['pickle', 'anatomy-park'] }));
    fs.writeFileSync(path.join(dir, 'pipeline-status.json'), JSON.stringify({ status: 'completed' }));
    assert.equal(shouldMonitorExit(dir, false), true);
    fs.rmSync(dir, { recursive: true });
});

test('monitor CLI exits after orphan tmp recovery promotes an inactive higher-iteration state', () => {
    const dir = tmpDir();
    try {
        const baseState = {
            working_dir: '/tmp/stale-base',
            backend: 'claude',
            step: 'implement',
            iteration: 1,
            max_iterations: 50,
            max_time_minutes: 720,
            worker_timeout_seconds: 1200,
            start_time_epoch: 1700000000,
            original_prompt: 'stale base state',
            session_dir: dir,
            started_at: '2026-01-01T00:00:00Z',
            history: [],
            completion_promise: null,
            schema_version: 3,
            active: true,
            pid: 999999,
        };
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(baseState));
        fs.writeFileSync(deadTmpPath(path.join(dir, 'state.json')), JSON.stringify({
            ...baseState,
            active: false,
            iteration: 2,
            step: 'review',
            original_prompt: 'recovered inactive state',
            working_dir: '/tmp/recovered-state',
        }));

        const result = run([dir]);
        assert.equal(result.status, 0, `expected clean exit, got status=${result.status}, stderr=${result.stderr}`);
        assert.match(result.stdout, /SESSION COMPLETE/, `expected completion banner, got: ${result.stdout}`);
        assert.match(result.stdout, /OFFLINE/, `expected recovered inactive state to render offline, got: ${result.stdout}`);
        const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
        assert.equal(persisted.iteration, 2, 'higher-iteration tmp state should be promoted');
        assert.equal(persisted.active, false, 'promoted state should stay inactive');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('monitor CLI promotes dead writer microverse tmp before rendering trend', () => {
    const dir = tmpDir();
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
            active: false,
            iteration: 2,
            step: 'review',
            original_prompt: 'render microverse trend',
            working_dir: '/tmp/recovered-state',
            pid: 999999,
        }));

        const stale = makeMicroverseState({
            convergence: {
                stall_limit: 5,
                stall_counter: 0,
                history: [
                    { iteration: 1, metric_value: '9', score: 9, action: 'accept', description: 'stale', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
                ],
            },
        });
        const recovered = makeMicroverseState({
            convergence: {
                stall_limit: 5,
                stall_counter: 2,
                history: [
                    { iteration: 1, metric_value: '9', score: 9, action: 'accept', description: 'stale', pre_iteration_sha: 'a', timestamp: new Date().toISOString() },
                    { iteration: 2, metric_value: '4', score: 4, action: 'accept', description: 'recovered', pre_iteration_sha: 'b', timestamp: new Date().toISOString() },
                ],
            },
        });
        fs.writeFileSync(path.join(dir, 'microverse.json'), JSON.stringify(stale, null, 2));
        fs.writeFileSync(deadTmpPath(path.join(dir, 'microverse.json')), JSON.stringify(recovered, null, 2));
        const future = new Date(Date.now() + 1000);
        fs.utimesSync(deadTmpPath(path.join(dir, 'microverse.json')), future, future);

        const result = run([dir]);
        assert.equal(result.status, 0, `expected clean exit, got status=${result.status}, stderr=${result.stderr}`);
        assert.match(result.stdout, /2:4/, `expected recovered microverse score in monitor output, got: ${result.stdout}`);
        assert.match(result.stdout, /Stall: 2\/5/, `expected recovered stall counter in monitor output, got: ${result.stdout}`);
        assert.equal(fs.existsSync(deadTmpPath(path.join(dir, 'microverse.json'))), false);
        const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'microverse.json'), 'utf-8'));
        assert.equal(persisted.convergence.history.length, 2);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('monitor CLI promotes dead writer circuit breaker tmp before rendering state', () => {
    const dir = tmpDir();
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
            active: false,
            iteration: 4,
            step: 'review',
            original_prompt: 'render circuit breaker state',
            working_dir: '/tmp/recovered-state',
            pid: 999999,
        }));

        fs.writeFileSync(path.join(dir, 'circuit_breaker.json'), JSON.stringify({
            state: 'CLOSED',
            last_change: new Date().toISOString(),
            consecutive_no_progress: 0,
            consecutive_same_error: 0,
            last_error_signature: null,
            last_known_head: '',
            last_known_step: null,
            last_known_ticket: null,
            last_progress_iteration: 3,
            total_opens: 0,
            reason: '',
            opened_at: null,
            history: [],
        }, null, 2));
        const deadWriterPid = 987654321;
        fs.writeFileSync(path.join(dir, `circuit_breaker.json.tmp.${deadWriterPid}`), JSON.stringify({
            state: 'OPEN',
            last_change: new Date().toISOString(),
            consecutive_no_progress: 5,
            consecutive_same_error: 0,
            last_error_signature: null,
            last_known_head: '',
            last_known_step: 'review',
            last_known_ticket: null,
            last_progress_iteration: 3,
            total_opens: 1,
            reason: 'No progress in 5 iterations',
            opened_at: new Date().toISOString(),
            history: [],
        }, null, 2));
        const future = new Date(Date.now() + 1000);
        fs.utimesSync(path.join(dir, `circuit_breaker.json.tmp.${deadWriterPid}`), future, future);

        const result = run([dir]);
        assert.equal(result.status, 0, `expected clean exit, got status=${result.status}, stderr=${result.stderr}`);
        assert.match(result.stdout, /Circuit:/, `expected circuit field in monitor output, got: ${result.stdout}`);
        assert.match(result.stdout, /OPEN \(No progress in 5 iterations\)/, `expected recovered OPEN state, got: ${result.stdout}`);
        assert.equal(fs.existsSync(path.join(dir, `circuit_breaker.json.tmp.${deadWriterPid}`)), false);
        const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'circuit_breaker.json'), 'utf-8'));
        assert.equal(persisted.state, 'OPEN');
        assert.equal(persisted.reason, 'No progress in 5 iterations');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- AC-LPB-06: EXCEEDED indicator on Elapsed field ---

test('renderElapsedField: elapsed under budget shows no EXCEEDED', () => {
    // 500m elapsed, 720m max → under budget
    const out = stripAnsi(renderElapsedField(500 * 60, 720));
    assert.ok(!out.includes('EXCEEDED'), `expected no EXCEEDED suffix, got: ${out}`);
    assert.ok(out.includes('500m'), `expected formatted elapsed, got: ${out}`);
    assert.ok(out.includes('/ 720m'), `expected ceiling label, got: ${out}`);
});

test('renderElapsedField: elapsed over budget shows EXCEEDED', () => {
    // 1000m elapsed, 720m max → over budget
    const raw = renderElapsedField(1000 * 60, 720);
    const out = stripAnsi(raw);
    assert.ok(out.includes('EXCEEDED'), `expected EXCEEDED suffix, got: ${out}`);
    assert.ok(out.includes('1000m'), `expected formatted elapsed, got: ${out}`);
    assert.ok(out.includes('/ 720m'), `expected ceiling label, got: ${out}`);
    // Bold-red ANSI sequence (MX.ERR = '\x1b[1;31m') must be present in raw
    assert.ok(raw.includes('\x1b[1;31m'), 'EXCEEDED must use bold-red highlight');
});

test('renderElapsedField: elapsed exactly at budget does not show EXCEEDED', () => {
    // 720m elapsed, 720m max → at boundary, not strictly over
    const out = stripAnsi(renderElapsedField(720 * 60, 720));
    assert.ok(!out.includes('EXCEEDED'), `expected no EXCEEDED at boundary, got: ${out}`);
});

test('renderElapsedField: no max shows raw elapsed without EXCEEDED', () => {
    const out = stripAnsi(renderElapsedField(1000 * 60, 0));
    assert.ok(!out.includes('EXCEEDED'), `expected no EXCEEDED when no max, got: ${out}`);
    assert.ok(!out.includes('/'), `expected no ceiling label when no max, got: ${out}`);
    assert.ok(out.includes('elapsed:'), `expected elapsed-only label when no max, got: ${out}`);
});

// --- AC-SSV-07: stdout watchdog ---

test('MONITOR_STDOUT_WATCHDOG_MS: positive integer suitable for tmux pane redraws', () => {
    assert.ok(Number.isInteger(MONITOR_STDOUT_WATCHDOG_MS));
    assert.ok(MONITOR_STDOUT_WATCHDOG_MS > 0);
    assert.ok(MONITOR_STDOUT_WATCHDOG_MS <= 10_000, 'watchdog should not exceed 10s');
});

test('writeWithWatchdog: resolves quickly on a healthy sink', async () => {
    let received = '';
    const sink = new Writable({
        write(chunk, _enc, cb) {
            received += chunk.toString();
            cb();
        },
    });
    const start = Date.now();
    await writeWithWatchdog(sink, 'hello pickle\n', 500);
    const elapsed = Date.now() - start;
    assert.equal(received, 'hello pickle\n');
    assert.ok(elapsed < 200, `healthy write should resolve fast, took ${elapsed}ms`);
});

test('writeWithWatchdog: rejects with backpressure error when sink never drains', async (t) => {
    // Wedged sink: write callback never fires, drain never emitted.
    // Mimics a tmux pane whose scrollback is frozen and whose pipe buffer
    // is full — the synchronous syscall would block forever.
    const wedged = {
        _drainListeners: [],
        write(_chunk, _cb) {
            // Returning false signals backpressure; we deliberately never
            // emit 'drain' or invoke the callback.
            return false;
        },
        once(event, listener) {
            if (event === 'drain') this._drainListeners.push(listener);
            // 'error' / 'close' are intentionally swallowed.
            return this;
        },
    };
    const watchdogMs = 200;

    // Drive the mock clock rather than race a real wall-clock threshold: a prior version of this
    // test raced Date.now() against a real setTimeout and its upper-bound assertion had to be
    // deleted (98dfa740) because the event loop starves under the c=8 stability gate and the real
    // timer fires late. writeWithWatchdog (monitor.ts) calls bare global setTimeout/clearTimeout,
    // so mocking only 'setTimeout' here intercepts it transparently.
    t.mock.timers.enable({ apis: ['setTimeout'] });

    let settled = false;
    let err;
    const promise = writeWithWatchdog(wedged, 'wedged\n', watchdogMs);
    promise.then(
        () => { settled = true; },
        (e) => { settled = true; err = e; },
    );

    // One tick short of the threshold: the watchdog must not have fired yet.
    t.mock.timers.tick(watchdogMs - 1);
    await new Promise((resolve) => setImmediate(resolve)); // flush pending microtasks
    assert.equal(settled, false, 'watchdog must not fire before watchdogMs elapses');

    // Cross the threshold: the watchdog must fire now and reject.
    t.mock.timers.tick(1);
    try {
        await promise;
    } catch (e) {
        err = e;
    }
    assert.ok(err, 'writeWithWatchdog must reject when sink never drains');
    assert.ok(/watchdog/i.test(err.message), `expected watchdog error, got: ${err.message}`);
    assert.ok(/wedged|backpressure|drain/i.test(err.message), `expected pane wedge hint, got: ${err.message}`);
});

test('writeWithWatchdog: surfaces sink error', async () => {
    const exploding = {
        write(_chunk, _cb) {
            throw new Error('boom');
        },
        once() { return this; },
    };
    let err;
    try {
        await writeWithWatchdog(exploding, 'x', 500);
    } catch (e) {
        err = e;
    }
    assert.ok(err, 'should reject on synchronous throw');
    assert.match(err.message, /boom/);
});

// --- R-MDS-2: --mode flag dispatch ---

function makeMinimalState(overrides = {}) {
    return {
        active: false,
        iteration: 1,
        max_iterations: 10,
        max_time_minutes: 0,
        worker_timeout_seconds: 1200,
        start_time_epoch: Math.floor(Date.now() / 1000),
        step: 'implement',
        original_prompt: 'test task',
        working_dir: '/tmp/test',
        current_ticket: null,
        session_dir: '/tmp/test-session',
        pid: null,
        backend: 'claude',
        schema_version: 3,
        started_at: new Date().toISOString(),
        history: [],
        completion_promise: null,
        ...overrides,
    };
}

test('renderDashboard: pickle mode renders PICKLE RICK header', () => {
    const dir = tmpDir();
    try {
        const state = makeMinimalState();
        const segments = renderDashboard(state, 'pickle', dir, 80);
        const out = segments.join('').replace(/\x1b\[[0-9;]*[mJH]/g, '');
        assert.ok(out.includes('PICKLE RICK'), `expected PICKLE RICK header in pickle mode, got: ${out}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('renderDashboard: microverse mode renders microverse dashboard', () => {
    const dir = tmpDir();
    try {
        const state = makeMinimalState({ session_dir: dir });
        const segments = renderDashboard(state, 'microverse', dir, 80);
        const out = segments.join('').replace(/\x1b\[[0-9;]*[mJH]/g, '');
        assert.ok(
            out.includes('MICROVERSE MONITOR'),
            `expected MICROVERSE MONITOR header in microverse mode, got: ${out}`,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('renderDashboard: idle mode renders "Pipeline complete"', () => {
    const dir = tmpDir();
    try {
        const state = makeMinimalState();
        const segments = renderDashboard(state, 'idle', dir, 80);
        const out = segments.join('').replace(/\x1b\[[0-9;]*[mJH]/g, '');
        assert.ok(out.includes('Pipeline complete'), `expected "Pipeline complete" in idle mode, got: ${out}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('renderDashboard: pickle mode uses one render timestamp for elapsed and rate-limit countdown', () => {
    const dir = tmpDir();
    const baseNow = Date.parse('2026-05-20T12:00:00.000Z');
    try {
        fs.writeFileSync(path.join(dir, 'rate_limit_wait.json'), JSON.stringify({
            waiting: true,
            wait_until: new Date(baseNow + 10_000).toISOString(),
            rate_limit_type: 'tokens',
            wait_source: 'api',
        }));
        const state = makeMinimalState({
            start_time_epoch: Math.floor(baseNow / 1000) - 5,
            working_dir: '/tmp/render-clock',
        });
        const realNow = Date.now;
        let calls = 0;
        Date.now = () => baseNow + (calls++ * 1000);
        try {
            const out = renderDashboard(state, 'pickle', dir, 80).join('').replace(/\x1b\[[0-9;]*[mJH]/g, '');
            assert.match(out, /Elapsed:\s+elapsed: 0m 5s/, `expected elapsed to use the first render timestamp, got: ${out}`);
            assert.match(out, /Rate Limit:\s+⏳ Rate limited \[tokens\] \(API reset\) \(0m 10s remaining\)/, `expected rate-limit countdown to share the same render timestamp, got: ${out}`);
            assert.equal(calls, 1, 'pickle dashboard render should sample Date.now() once per render');
        } finally {
            Date.now = realNow;
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('monitor CLI: --mode bogus exits 64', () => {
    const dir = tmpDir();
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: false }));
        const result = run([dir, '--mode', 'bogus']);
        assert.equal(result.status, 64, `expected exit 64 for unknown mode, got ${result.status}`);
        assert.ok(
            result.stderr.includes('unknown mode') || result.stderr.includes('bogus'),
            `expected error message mentioning unknown mode, got: ${result.stderr}`,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('monitor CLI: no --mode defaults to pickle template', () => {
    const dir = tmpDir();
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
            active: false,
            iteration: 1,
            max_iterations: 10,
            step: 'implement',
            original_prompt: 'default mode test',
            working_dir: '/tmp/test',
            session_dir: dir,
            pid: 999999,
        }));
        const result = run([dir]);
        assert.equal(result.status, 0, `expected clean exit, got ${result.status}, stderr=${result.stderr}`);
        const out = result.stdout.replace(/\x1b\[[0-9;]*[mJH]/g, '');
        assert.ok(out.includes('PICKLE RICK'), `expected PICKLE RICK header for default (pickle) mode, got: ${out}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('monitor CLI promotes dead writer rate limit tmp before rendering countdown', () => {
    const dir = tmpDir();
    try {
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
            active: false,
            iteration: 3,
            step: 'implement',
            original_prompt: 'render recovered wait',
            working_dir: '/tmp/recovered-state',
            pid: 999999,
        }));
        fs.writeFileSync(path.join(dir, 'rate_limit_wait.json'), JSON.stringify({
            waiting: false,
            wait_until: new Date(Date.now() - 60_000).toISOString(),
        }));
        fs.writeFileSync(deadTmpPath(path.join(dir, 'rate_limit_wait.json')), JSON.stringify({
            waiting: true,
            reason: 'API rate limit',
            started_at: new Date().toISOString(),
            wait_until: new Date(Date.now() + 3_600_000).toISOString(),
            rate_limit_type: 'tokens',
            wait_source: 'api',
        }, null, 2));
        const future = new Date(Date.now() + 1000);
        fs.utimesSync(deadTmpPath(path.join(dir, 'rate_limit_wait.json')), future, future);

        const result = run([dir]);
        assert.equal(result.status, 0, `expected clean exit, got status=${result.status}, stderr=${result.stderr}`);
        assert.match(result.stdout, /Rate limited \[tokens\] \(API reset\)/, `expected recovered wait in monitor output, got: ${result.stdout}`);
        assert.equal(fs.existsSync(deadTmpPath(path.join(dir, 'rate_limit_wait.json'))), false);
        const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'rate_limit_wait.json'), 'utf-8'));
        assert.equal(persisted.waiting, true);
        assert.equal(persisted.rate_limit_type, 'tokens');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- R-MDS-3: inferModeFromStep + checkAndSwapMode ---

test('R-MDS-3 AC-1: inferModeFromStep maps all step categories', () => {
    // pickle-class steps
    for (const step of ['research', 'plan', 'implement', 'verify', 'review', 'simplify']) {
        assert.equal(inferModeFromStep(step), 'pickle', `step '${step}' should map to pickle`);
    }
    // microverse-class steps
    for (const step of ['anatomy-park', 'szechuan-sauce']) {
        assert.equal(inferModeFromStep(step), 'microverse', `step '${step}' should map to microverse`);
    }
    // idle steps
    assert.equal(inferModeFromStep('completed'), 'idle');
    assert.equal(inferModeFromStep(null), 'idle');
    assert.equal(inferModeFromStep(undefined), 'idle');
    // other → null (preserve current)
    assert.equal(inferModeFromStep('prd'), null);
    assert.equal(inferModeFromStep('breakdown'), null);
    assert.equal(inferModeFromStep('citadel'), null);
    assert.equal(inferModeFromStep('unknown-step'), null);
});

test('R-MDS-3 AC-2: checkAndSwapMode swaps when state.step changes', () => {
    const dir = tmpDir();
    try {
        const swaps = [];
        const noopLog = (e) => swaps.push(e);
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true, step: 'anatomy-park' }));
        const result = checkAndSwapMode(dir, 'pickle', noopLog);
        assert.equal(result, 'microverse', 'should swap to microverse when step=anatomy-park');
        assert.equal(swaps.length, 1, 'should emit exactly one monitor_mode_swapped event');
        assert.equal(swaps[0].event, 'monitor_mode_swapped');
        assert.equal(swaps[0].mode, 'microverse');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('R-MDS-3 AC-3: checkAndSwapMode is idempotent on same mode', () => {
    const dir = tmpDir();
    try {
        const swaps = [];
        const noopLog = (e) => swaps.push(e);
        fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true, step: 'implement' }));
        const first = checkAndSwapMode(dir, 'pickle', noopLog);
        const second = checkAndSwapMode(dir, first, noopLog);
        assert.equal(first, 'pickle', 'first call should return pickle (no swap needed)');
        assert.equal(second, 'pickle', 'second call should return pickle (idempotent)');
        assert.equal(swaps.length, 0, 'no swap events for same-mode re-checks');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('R-MDS-3 AC-4: checkAndSwapMode preserves mode when state is unreadable', () => {
    const dir = tmpDir();
    try {
        const swaps = [];
        const noopLog = (e) => swaps.push(e);
        fs.writeFileSync(path.join(dir, 'state.json'), 'this is not valid json{{{');
        const result = checkAndSwapMode(dir, 'microverse', noopLog);
        assert.equal(result, 'microverse', 'should preserve current mode on unreadable state');
        assert.equal(swaps.length, 0, 'no swap event when state is unreadable');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- R-MDS-4: renderMicroverseDashboard ---

// AP-EXT-ITER11-02: the subsystem row's fraction is `consecutive_clean` over the
// 2-consecutive-clean CONVERGENCE target, never over `stall_limit` (the ceiling on
// the unrelated `stall_counts`). The fixture keeps `stall_limit: 5` precisely so the
// two numbers cannot be confused: pre-fix this row rendered `2/5` and `1/5`, so a
// CONVERGED subsystem read two passes short of done on the operator's only view of
// anatomy-park progress. Driven through the real `renderMicroverseDashboard` over a
// real `anatomy-park.json`, not a hand-stubbed row.
test('R-MDS-4 AC-1 / AP-EXT-ITER11-02: subsystems render consecutive_clean over the clean-pass target, not stall_limit', () => {
    const dir = tmpDir();
    try {
        const apData = {
            subsystems: ['services', 'bin'],
            // `services` has CONVERGED (2 consecutive clean passes); `bin` is one short.
            consecutive_clean: { services: 2, bin: 1 },
            stall_limit: 5,
            findings_history: { services: [], bin: [] },
        };
        fs.writeFileSync(path.join(dir, 'anatomy-park.json'), JSON.stringify(apData));
        const state = makeMinimalState({ session_dir: dir });
        const result = renderMicroverseDashboard(state, null);
        const clean = result.replace(/\x1b\[[0-9;]*[mJH]/g, '');
        assert.ok(clean.includes('services'), 'subsystem name "services" should appear');
        assert.ok(clean.includes('bin'), 'subsystem name "bin" should appear');
        assert.ok(clean.includes('2/2'), 'a converged subsystem must render 2/2, not 2/stall_limit');
        assert.ok(clean.includes('1/2'), 'consecutive_clean=1 must render against the clean-pass target');
        // Anti-regression: the stall ceiling must not reappear as this row's denominator.
        assert.ok(!clean.includes('2/5'), 'stall_limit must not be the denominator');
        assert.ok(!clean.includes('1/5'), 'stall_limit must not be the denominator');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('R-MDS-4 AC-2: convergence section shows iter + last 5 classifications', () => {
    const dir = tmpDir();
    try {
        const state = makeMinimalState({ session_dir: dir, iteration: 7, max_iterations: 20 });
        const mv = {
            failure_history: [
                { iteration: 1, failure_class: 'no_progress', description: 'a', timestamp: '' },
                { iteration: 2, failure_class: 'regression', description: 'b', timestamp: '' },
                { iteration: 3, failure_class: 'tool_failure', description: 'c', timestamp: '' },
                { iteration: 4, failure_class: 'no_progress', description: 'd', timestamp: '' },
                { iteration: 5, failure_class: 'regression', description: 'e', timestamp: '' },
            ],
            convergence: { stall_counter: 0, stall_limit: 10, history: [] },
        };
        const result = renderMicroverseDashboard(state, mv);
        const clean = result.replace(/\x1b\[[0-9;]*[mJH]/g, '');
        assert.ok(clean.includes('iter 7/20'), `should show iter 7/20, got: ${clean}`);
        assert.ok(clean.includes('no_progress'), `should show failure class no_progress, got: ${clean}`);
        assert.ok(clean.includes('regression'), `should show failure class regression, got: ${clean}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('R-MDS-4 AC-3: stall warning fires red ANSI at stall_counter=4 stall_limit=6 (>=0.66)', () => {
    const dir = tmpDir();
    try {
        const state = makeMinimalState({ session_dir: dir });
        const mv = {
            failure_history: [],
            convergence: { stall_counter: 4, stall_limit: 6, history: [] },
        };
        const result = renderMicroverseDashboard(state, mv);
        // Bold red: \x1b[1;31m (MX.ERR)
        assert.ok(result.includes('\x1b[1;31m'), `ANSI bold-red should be present for stall at 4/6, got raw: ${JSON.stringify(result)}`);
        const clean = result.replace(/\x1b\[[0-9;]*[mJH]/g, '');
        assert.ok(clean.includes('4/6'), 'stall ratio 4/6 should appear in output');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('R-MDS-4 AC-4: sparkline uses 8-char ramp on last-10 values', () => {
    const dir = tmpDir();
    try {
        const state = makeMinimalState({ session_dir: dir });
        const history = Array.from({ length: 10 }, (_, i) => ({
            iteration: i + 1,
            score: i * 10,
            action: 'accept',
            metric_value: String(i * 10),
            description: '',
            pre_iteration_sha: '',
            timestamp: '',
        }));
        const mv = {
            failure_history: [],
            convergence: { stall_counter: 0, stall_limit: 10, history },
        };
        const result = renderMicroverseDashboard(state, mv);
        const sparkChars = '▁▂▃▄▅▆▇█';
        const found = [...result].filter(c => sparkChars.includes(c));
        assert.ok(found.length >= 1, `should contain sparkline chars from ramp, got raw: ${JSON.stringify(result)}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('R-MDS-4 AC-5: max line width <= 80 cols on max input', () => {
    const dir = tmpDir();
    try {
        const longName = 'very-long-subsystem-name-that-goes-on-and-on-forever';
        const apData = {
            subsystems: [longName, 'another-long-name'],
            consecutive_clean: { [longName]: 99, 'another-long-name': 1 },
            stall_limit: 100,
            findings_history: {
                [longName]: ['a very very very very long last action description that is quite lengthy'],
                'another-long-name': [],
            },
        };
        fs.writeFileSync(path.join(dir, 'anatomy-park.json'), JSON.stringify(apData));
        const state = makeMinimalState({ session_dir: dir });
        const mv = {
            failure_history: Array.from({ length: 5 }, (_, i) => ({
                iteration: i,
                failure_class: 'approach_exhaustion',
                description: '',
                timestamp: '',
            })),
            convergence: { stall_counter: 4, stall_limit: 6, history: [] },
        };
        const result = renderMicroverseDashboard(state, mv);
        const stripped = result.replace(/\x1b\[[0-9;]*[mJH]/g, '').replace(/\x1b\[2J\x1b\[H/g, '');
        const lines = stripped.split('\n').filter(l => l.length > 0);
        const maxLen = Math.max(...lines.map(l => l.length));
        assert.ok(maxLen <= 80, `max line length should be <= 80, got ${maxLen} in lines: ${JSON.stringify(lines)}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('R-MDS-4 AC-6: total height <= 14 lines', () => {
    const dir = tmpDir();
    try {
        const apData = {
            subsystems: ['s1', 's2', 's3', 's4', 's5'],
            consecutive_clean: { s1: 0, s2: 1, s3: 2, s4: 3, s5: 4 },
            stall_limit: 5,
            findings_history: { s1: [], s2: [], s3: [], s4: [], s5: [] },
        };
        fs.writeFileSync(path.join(dir, 'anatomy-park.json'), JSON.stringify(apData));
        const history = Array.from({ length: 10 }, (_, i) => ({
            iteration: i + 1, score: i, action: 'accept',
            metric_value: String(i), description: '', pre_iteration_sha: '', timestamp: '',
        }));
        const mv = {
            failure_history: [{ iteration: 1, failure_class: 'no_progress', description: '', timestamp: '' }],
            convergence: { stall_counter: 3, stall_limit: 5, history },
        };
        const state = makeMinimalState({ session_dir: dir });
        const result = renderMicroverseDashboard(state, mv);
        const stripped = result.replace(/\x1b\[[0-9;]*[mJH]/g, '').replace(/\x1b\[2J\x1b\[H/g, '');
        const lineCount = stripped.split('\n').filter(l => l.length > 0).length;
        assert.ok(lineCount <= 14, `height should be <= 14 lines, got ${lineCount}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('R-MDS-4 AC-7: missing fields render "--"', () => {
    const dir = tmpDir();
    try {
        const state = makeMinimalState({ session_dir: dir });
        const result = renderMicroverseDashboard(state, null);
        const stripped = result.replace(/\x1b\[[0-9;]*[mJH]/g, '');
        assert.ok(stripped.includes('--'), `should render "--" for missing fields, got: ${stripped}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
