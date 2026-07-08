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

// AC-SRTS-1.a + AC-SRTS-1.b: default (no --force-ticket-status-sync) preserves operator edit
test('setup-resume-ticket-status-preserved: default preserves operator-edited Skipped status', () => {
    withDataRoot(dataRoot => {
        // Create a session
        const initOutput = run(['--task', 'srts1-preserve-test'], dataRoot);
        const sp = sessionRoot(initOutput);
        const statePath = path.join(sp, 'state.json');

        // Set current_ticket to a test ticket id
        const ticketId = 'test000a';
        injectCurrentTicket(statePath, ticketId);

        // Create the ticket file with operator-edited status "Skipped"
        const ticketPath = makeTicketFile(sp, ticketId, 'Skipped');

        assert.equal(readTicketStatus(ticketPath), 'Skipped', 'ticket must start as Skipped');

        // Resume WITHOUT --force-ticket-status-sync
        run(['--resume', sp], dataRoot, { allowFail: true });

        // Assert: ticket frontmatter unchanged
        assert.equal(
            readTicketStatus(ticketPath),
            'Skipped',
            'resume without --force-ticket-status-sync must NOT rewrite operator-edited Skipped status',
        );

        // Assert: setup_resume_ticket_status_preserved event emitted
        const preserved = findActivityEvents(dataRoot, 'setup_resume_ticket_status_preserved');
        assert.ok(preserved.length >= 1, 'setup_resume_ticket_status_preserved event must be emitted');

        const evt = preserved[0];
        assert.equal(evt.ticket_id, ticketId, 'event.ticket_id must match the operator-edited ticket');
        assert.equal(evt.observed_status, 'Skipped', 'event.observed_status must be Skipped');
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

        const ticketPath = makeTicketFile(sp, ticketId, 'Skipped');

        assert.equal(readTicketStatus(ticketPath), 'Skipped', 'ticket must start as Skipped');

        // Resume WITH --force-ticket-status-sync
        run(['--resume', sp, '--force-ticket-status-sync'], dataRoot, { allowFail: true });

        // Assert: ticket frontmatter rewritten to In Progress
        assert.equal(
            readTicketStatus(ticketPath),
            'In Progress',
            '--force-ticket-status-sync must rewrite Skipped → In Progress',
        );

        // Assert: setup_resume_overrode_ticket_status event emitted
        const overrode = findActivityEvents(dataRoot, 'setup_resume_overrode_ticket_status');
        assert.ok(overrode.length >= 1, 'setup_resume_overrode_ticket_status event must be emitted');

        const evt = overrode[0];
        assert.equal(evt.ticket_id, ticketId, 'event.ticket_id must match the overridden ticket');
        assert.equal(evt.prior_status, 'Skipped', 'event.prior_status must be Skipped');
        assert.equal(evt.new_status, 'In Progress', 'event.new_status must be In Progress');
        assert.equal(evt.source, 'force_flag', 'event.source must be force_flag');
    });
});
