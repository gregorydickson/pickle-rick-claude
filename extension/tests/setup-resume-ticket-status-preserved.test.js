// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../bin/setup.js');

// R-PNTR-4: the in-session (non-tmux) `/pickle` build loop was removed — a new
// build session MUST run under tmux. This test exercises resume status gating, so
// inject `--tmux` for new-session creates unless the call already selects a session
// mode (`--tmux`/`--paused`/`--resume`).
function run(args, dataRoot, { allowFail = false } = {}) {
    const hasMode = args.some(a => a === '--tmux' || a === '--paused' || a === '--resume');
    const finalArgs = hasMode ? args : ['--tmux', ...args];
    try {
        return execFileSync(process.execPath, [SETUP, ...finalArgs], {
            encoding: 'utf-8',
            env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
        });
    } catch (err) {
        if (allowFail) return err.stdout ?? '';
        throw err;
    }
}

function sessionRoot(output) {
    const match = output.match(/SESSION_ROOT=(.+)/);
    if (!match) throw new Error(`SESSION_ROOT not found:\n${output}`);
    return match[1].trim();
}

function withDataRoot(fn) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-srts-'));
    try {
        return fn(dataRoot);
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
}

function makeTicketFile(sessionDir, ticketId, status) {
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
    const content = [
        '---',
        `id: ${ticketId}`,
        `title: "Test ticket ${ticketId}"`,
        `status: "${status}"`,
        'priority: High',
        'order: 1',
        `skipped_reason: "operator test edit"`,
        '---',
        '',
        '# Description',
        'Test ticket for R-SRTS-1.',
    ].join('\n');
    fs.writeFileSync(ticketPath, content, 'utf-8');
    return ticketPath;
}

function injectCurrentTicket(statePath, ticketId) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.current_ticket = ticketId;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function readTicketStatus(ticketPath) {
    const content = fs.readFileSync(ticketPath, 'utf-8');
    const match = content.match(/^status:\s*"?([^"\n]+)"?/m);
    return match ? match[1].trim() : null;
}

function findActivityEvents(dataRoot, eventName) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    const events = [];
    for (const file of fs.readdirSync(activityDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const lines = fs.readFileSync(path.join(activityDir, file), 'utf-8').split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed.event === eventName) events.push(parsed);
            } catch { /* skip malformed */ }
        }
    }
    return events;
}

// AC-SRTS-1.a + AC-SRTS-1.b: default (no --force-ticket-status-sync) preserves operator edit.
// B-CURTIX: the pointer is a PENDING ticket — a terminal pointer is not a desync at all (see below).
test('setup-resume-ticket-status-preserved: default preserves operator-edited Todo status', () => {
    withDataRoot(dataRoot => {
        // Create a session
        const initOutput = run(['--task', 'srts1-preserve-test'], dataRoot);
        const sp = sessionRoot(initOutput);
        const statePath = path.join(sp, 'state.json');

        // Set current_ticket to a test ticket id
        const ticketId = 'test000a';
        injectCurrentTicket(statePath, ticketId);

        // Create the ticket file with operator-edited status "Todo"
        const ticketPath = makeTicketFile(sp, ticketId, 'Todo');

        assert.equal(readTicketStatus(ticketPath), 'Todo', 'ticket must start as Todo');

        // Resume WITHOUT --force-ticket-status-sync
        run(['--resume', sp], dataRoot, { allowFail: true });

        // Assert: ticket frontmatter unchanged
        assert.equal(
            readTicketStatus(ticketPath),
            'Todo',
            'resume without --force-ticket-status-sync must NOT rewrite operator-edited Todo status',
        );

        // Assert: setup_resume_ticket_status_preserved event emitted
        const preserved = findActivityEvents(dataRoot, 'setup_resume_ticket_status_preserved');
        assert.ok(preserved.length >= 1, 'setup_resume_ticket_status_preserved event must be emitted');

        const evt = preserved[0];
        assert.equal(evt.ticket_id, ticketId, 'event.ticket_id must match the operator-edited ticket');
        assert.equal(evt.observed_status, 'Todo', 'event.observed_status must be Todo');
        assert.equal(evt.expected_status, 'In Progress', 'event.expected_status must be In Progress');
        assert.equal(evt.reason, 'operator_edit', 'event.reason must be operator_edit');
    });
});

// AC-SRTS-1.c: --force-ticket-status-sync runs legacy override
test('setup-resume-ticket-status-preserved: --force-ticket-status-sync rewrites to In Progress', () => {
    withDataRoot(dataRoot => {
        // Create a session
        const initOutput = run(['--task', 'srts1-force-test'], dataRoot);
        const sp = sessionRoot(initOutput);
        const statePath = path.join(sp, 'state.json');

        const ticketId = 'test000b';
        injectCurrentTicket(statePath, ticketId);

        const ticketPath = makeTicketFile(sp, ticketId, 'Todo');

        assert.equal(readTicketStatus(ticketPath), 'Todo', 'ticket must start as Todo');

        // Resume WITH --force-ticket-status-sync
        run(['--resume', sp, '--force-ticket-status-sync'], dataRoot, { allowFail: true });

        // Assert: ticket frontmatter rewritten to In Progress
        assert.equal(
            readTicketStatus(ticketPath),
            'In Progress',
            '--force-ticket-status-sync must rewrite Todo → In Progress',
        );

        // Assert: setup_resume_overrode_ticket_status event emitted
        const overrode = findActivityEvents(dataRoot, 'setup_resume_overrode_ticket_status');
        assert.ok(overrode.length >= 1, 'setup_resume_overrode_ticket_status event must be emitted');

        const evt = overrode[0];
        assert.equal(evt.ticket_id, ticketId, 'event.ticket_id must match the overridden ticket');
        assert.equal(evt.prior_status, 'Todo', 'event.prior_status must be Todo');
        assert.equal(evt.new_status, 'In Progress', 'event.new_status must be In Progress');
        assert.equal(evt.source, 'force_flag', 'event.source must be force_flag');
    });
});

// B-CURTIX AC4: a TERMINAL pointer is never revived — no write and no event, with or without the flag.
// PRD fixture: three tickets, pointer terminal, two Todo siblings. The resume must exit 0 — a crash before the
// reconciler would leave every file untouched and read as a pass.
for (const status of ['Skipped', 'Done', 'Failed']) {
    for (const force of [false, true]) {
        test(`setup-resume-ticket-status-preserved: a ${status} pointer stays ${status} ${force ? 'under' : 'without'} --force-ticket-status-sync`, () => {
            withDataRoot(dataRoot => {
                const sp = sessionRoot(run(['--task', `curtix-ac4-${status}-${force}`], dataRoot));
                const statePath = path.join(sp, 'state.json');
                injectCurrentTicket(statePath, 'aaaa1111');
                const ticketPaths = [
                    makeTicketFile(sp, 'aaaa1111', status),
                    makeTicketFile(sp, 'bbbb2222', 'Todo'),
                    makeTicketFile(sp, 'cccc3333', 'Todo'),
                ];
                const before = ticketPaths.map(p => fs.readFileSync(p, 'utf-8'));

                run(['--resume', sp, ...(force ? ['--force-ticket-status-sync'] : [])], dataRoot);

                assert.deepEqual(ticketPaths.map(p => fs.readFileSync(p, 'utf-8')), before, 'every ticket file is byte-identical');
                assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf-8')).current_ticket, 'aaaa1111', 'resume does not move a terminal pointer');
                for (const eventName of ['setup_resume_overrode_ticket_status', 'setup_resume_ticket_status_preserved', 'ticket_state_desync_detected']) {
                    assert.equal(findActivityEvents(dataRoot, eventName).length, 0, `${eventName} must not fire for a terminal pointer`);
                }
            });
        });
    }
}

// c9d78d84: a resume that MOVES the pointer to the In Progress ticket re-infers the step for it. The first iteration
// head keeps max(step, inferred) while the pointer is unchanged, so a step carried over from the old ticket survives there.
test('setup-resume-ticket-status-preserved: a resume pointer move re-infers the step and clears the per-ticket cache', () => {
    withDataRoot(dataRoot => {
        const sp = sessionRoot(run(['--task', 'c9d78d84-resume-step'], dataRoot));
        const statePath = path.join(sp, 'state.json');
        makeTicketFile(sp, 'test000e', 'Todo');
        makeTicketFile(sp, 'test000f', 'In Progress');
        fs.writeFileSync(path.join(sp, 'test000f', 'research_2026-09-23.md'), '# research\n');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        Object.assign(state, {
            current_ticket: 'test000e',
            step: 'review',
            current_ticket_tier: 'large',
            current_ticket_budget_start_iteration: 3,
        });
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

        run(['--resume', sp], dataRoot, { allowFail: true });

        const resumed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(resumed.current_ticket, 'test000f', 'the pointer moves to the In Progress ticket');
        assert.equal(resumed.step, 'plan', 'the step is inferred from test000f\'s artifacts, not carried over from test000e');
        assert.equal(resumed.current_ticket_tier, undefined, 'the old ticket\'s tier cache is cleared');
        assert.equal(resumed.current_ticket_budget_start_iteration, undefined, 'the old ticket\'s budget baseline is cleared');
    });
});

// B-CURTIX AC5: two tickets In Progress — the pointer's ticket keeps In Progress and the other is demoted to Todo.
test('setup-resume-ticket-status-preserved: two In Progress tickets — the pointer wins and the other becomes Todo', () => {
    withDataRoot(dataRoot => {
        const sp = sessionRoot(run(['--task', 'curtix-ac5-two-in-progress'], dataRoot));
        const statePath = path.join(sp, 'state.json');
        // The pointer sorts SECOND, so a chooser that ignored it would pick test000g.
        injectCurrentTicket(statePath, 'test000h');
        const loserPath = makeTicketFile(sp, 'test000g', 'In Progress');
        const winnerPath = makeTicketFile(sp, 'test000h', 'In Progress');

        run(['--resume', sp], dataRoot);

        assert.equal(readTicketStatus(winnerPath), 'In Progress', 'the pointer\'s ticket stays In Progress');
        assert.equal(readTicketStatus(loserPath), 'Todo', 'the other In Progress ticket is demoted to Todo');
        assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf-8')).current_ticket, 'test000h', 'the pointer does not move');
        const desync = findActivityEvents(dataRoot, 'ticket_state_desync_detected');
        assert.deepEqual(desync.map(evt => evt.ticket), ['test000h'], 'one desync event naming the winner');
        assert.equal(findActivityEvents(dataRoot, 'setup_resume_ticket_status_preserved').length, 0, 'the winner is already In Progress — nothing to preserve');
    });
});
