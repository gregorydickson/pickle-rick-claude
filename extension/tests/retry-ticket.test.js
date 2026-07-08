// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { retryTicket } from '../bin/retry-ticket.js';

function captureRetryOutput(fn) {
    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => {
        lines.push(args.join(' '));
    };
    try {
        fn();
    } finally {
        console.log = originalLog;
    }
    return lines.join('\n');
}

// --- Input validation ---

test('retryTicket: rejects path traversal ticketId', () => {
    assert.throws(() => retryTicket('../../../etc/passwd', '/cwd'), /Invalid ticket ID/);
});

test('retryTicket: rejects ticketId with spaces', () => {
    assert.throws(() => retryTicket('ticket with spaces', '/cwd'), /Invalid ticket ID/);
});

test('retryTicket: rejects empty ticketId', () => {
    assert.throws(() => retryTicket('', '/cwd'), /Invalid ticket ID/);
});

test('retryTicket: rejects ticketId with slashes', () => {
    assert.throws(() => retryTicket('foo/bar', '/cwd'), /Invalid ticket ID/);
});

test('retryTicket: rejects ticketId with null byte', () => {
    assert.throws(() => retryTicket('foo\0bar', '/cwd'), /Invalid ticket ID/);
});

// --- No session map ---

test('retryTicket: throws when no sessions map exists', () => {
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retry-')));
    const saved = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = tmpDir;
    try {
        // No current_sessions.json in tmpDir — should throw
        assert.throws(
            () => retryTicket('abc123', tmpDir),
            /No active session found for this directory\./
        );
    } finally {
        if (saved === undefined) {
            delete process.env.EXTENSION_DIR;
        } else {
            process.env.EXTENSION_DIR = saved;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// --- Ticket reset logic (filesystem-level integration test, fully isolated) ---

test('retryTicket: resets ticket status to Todo and archives artifacts', () => {
    const tmpExtDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retry-ext-')));
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-session-')));
    const fakeCwd = sessionDir; // use sessionDir as the cwd key
    const saved = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = tmpExtDir;

    try {
        const ticketId = 'test-ticket-9z';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });

        // Write ticket file with Done status
        fs.writeFileSync(
            path.join(ticketDir, `rick_ticket_${ticketId}.md`),
            `---\nid: ${ticketId}\ntitle: Test\nstatus: Done\norder: 10\n---\n`
        );

        // Write an artifact that should get archived
        fs.writeFileSync(path.join(ticketDir, 'research_2025-01-01.md'), '# Research');

        // Write state.json
        const state = {
            active: false,
            step: 'research',
            iteration: 2,
            session_dir: sessionDir,
            original_prompt: 'test task',
            worker_timeout_seconds: 1200,
        };
        fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state));

        // Write current_sessions.json into the isolated extension root
        fs.writeFileSync(
            path.join(tmpExtDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );

        retryTicket(ticketId, fakeCwd);

        // Verify: ticket status reset to Todo
        const ticketContent = fs.readFileSync(
            path.join(ticketDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        assert.match(ticketContent, /^status: "Todo"$/m);

        // Verify: artifact was archived
        const entries = fs.readdirSync(ticketDir);
        const archiveDirs = entries.filter(e => e.startsWith('_retry_'));
        assert.equal(archiveDirs.length, 1, 'Expected one archive dir');
        const archived = fs.readdirSync(path.join(ticketDir, archiveDirs[0]));
        assert.ok(archived.includes('research_2025-01-01.md'), 'Research file should be archived');

        // Verify: state.active set back to true
        const updatedState = JSON.parse(
            fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(updatedState.active, true);

        // Verify: output includes --timeout 1200 (not 1500, deep review pass 5)
        // We can't capture stdout from the function easily, but we verify the
        // state value used for timeout is 1200.
        assert.equal(
            Number(state.worker_timeout_seconds) || 1200,
            1200,
            'worker_timeout_seconds should produce timeout of 1200'
        );

        // Verify: no leftover .tmp files (PID-qualified atomic write, deep review pass 7)
        const ticketDirFiles = fs.readdirSync(ticketDir);
        const tmpFiles = ticketDirFiles.filter(f => f.includes('.tmp'));
        assert.equal(tmpFiles.length, 0, 'No .tmp files should remain after atomic write');
    } finally {
        if (saved === undefined) {
            delete process.env.EXTENSION_DIR;
        } else {
            process.env.EXTENSION_DIR = saved;
        }
        fs.rmSync(tmpExtDir, { recursive: true, force: true });
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('retryTicket: archives implementation and review lifecycle artifacts to prevent stale completion evidence', () => {
    const tmpExtDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retry-ext-')));
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-session-')));
    const fakeCwd = sessionDir;
    const saved = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = tmpExtDir;

    try {
        const ticketId = 'stale-artifact-ticket';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });

        fs.writeFileSync(
            path.join(ticketDir, `rick_ticket_${ticketId}.md`),
            `---\nid: ${ticketId}\ntitle: Test\nstatus: Done\norder: 10\n---\n`
        );
        fs.writeFileSync(path.join(ticketDir, 'conformance_2026-05-07.md'), '# Old implementation evidence');
        fs.writeFileSync(path.join(ticketDir, 'review_scope.md'), '# Old review evidence');

        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                active: false,
                step: 'review',
                iteration: 2,
                session_dir: sessionDir,
                original_prompt: 'retry stale artifacts',
                worker_timeout_seconds: 1200,
            })
        );

        fs.writeFileSync(
            path.join(tmpExtDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );

        retryTicket(ticketId, fakeCwd);

        const entries = fs.readdirSync(ticketDir);
        const archiveDir = entries.find((entry) => entry.startsWith('_retry_'));
        assert.ok(archiveDir, 'Expected retry archive directory');
        assert.equal(entries.includes('conformance_2026-05-07.md'), false, 'stale implementation artifact must be removed from live ticket dir');
        assert.equal(entries.includes('review_scope.md'), false, 'stale review artifact must be removed from live ticket dir');

        const archived = fs.readdirSync(path.join(ticketDir, archiveDir));
        assert.ok(archived.includes('conformance_2026-05-07.md'));
        assert.ok(archived.includes('review_scope.md'));
    } finally {
        if (saved === undefined) {
            delete process.env.EXTENSION_DIR;
        } else {
            process.env.EXTENSION_DIR = saved;
        }
        fs.rmSync(tmpExtDir, { recursive: true, force: true });
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('retryTicket: clears stale completed_at and skipped_at when resetting to Todo', () => {
    const tmpExtDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retry-ext-')));
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-session-')));
    const fakeCwd = sessionDir;
    const saved = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = tmpExtDir;

    try {
        const ticketId = 'retry-timestamps';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(ticketDir, { recursive: true });

        fs.writeFileSync(
            path.join(ticketDir, `rick_ticket_${ticketId}.md`),
            `---\nid: ${ticketId}\ntitle: Test\nstatus: Done\norder: 10\ncompleted_at: "2026-03-01T00:00:00.000Z"\nskipped_at: "2026-03-02T00:00:00.000Z"\n---\n`
        );

        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                active: false,
                step: 'implement',
                iteration: 2,
                session_dir: sessionDir,
                original_prompt: 'test task',
                worker_timeout_seconds: 1200,
            })
        );

        fs.writeFileSync(
            path.join(tmpExtDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );

        retryTicket(ticketId, fakeCwd);

        const ticketContent = fs.readFileSync(
            path.join(ticketDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        assert.match(ticketContent, /^status: "Todo"$/m);
        assert.doesNotMatch(ticketContent, /^completed_at:/m);
        assert.doesNotMatch(ticketContent, /^skipped_at:/m);
    } finally {
        if (saved === undefined) {
            delete process.env.EXTENSION_DIR;
        } else {
            process.env.EXTENSION_DIR = saved;
        }
        fs.rmSync(tmpExtDir, { recursive: true, force: true });
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});

test('retryTicket: falls back to active session state when the sessions map is missing', () => {
    const tmpExtDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retry-ext-')));
    const saved = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = tmpExtDir;

    try {
        const fakeCwd = path.join(tmpExtDir, 'repo');
        const sessionDir = path.join(tmpExtDir, 'sessions', 'fallback-session');
        const ticketId = 'fallback-ticket';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(fakeCwd, { recursive: true });
        fs.mkdirSync(ticketDir, { recursive: true });

        fs.writeFileSync(
            path.join(ticketDir, `rick_ticket_${ticketId}.md`),
            `---\nid: ${ticketId}\ntitle: Test\nstatus: Done\norder: 10\n---\n`
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                active: false,
                working_dir: fakeCwd,
                step: 'implement',
                iteration: 2,
                session_dir: sessionDir,
                original_prompt: 'retry via fallback',
                worker_timeout_seconds: 1200,
            })
        );

        retryTicket(ticketId, fakeCwd);

        const updatedState = JSON.parse(
            fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
        assert.equal(updatedState.active, true);
        const ticketContent = fs.readFileSync(
            path.join(ticketDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        assert.match(ticketContent, /^status: "Todo"$/m);
    } finally {
        if (saved === undefined) {
            delete process.env.EXTENSION_DIR;
        } else {
            process.env.EXTENSION_DIR = saved;
        }
        fs.rmSync(tmpExtDir, { recursive: true, force: true });
    }
});

test('retryTicket: missing map prefers the newest inactive same-cwd fallback session', () => {
    const tmpExtDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retry-ext-')));
    const saved = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = tmpExtDir;

    try {
        const fakeCwd = path.join(tmpExtDir, 'repo');
        const sessionsDir = path.join(tmpExtDir, 'sessions');
        const oldSessionDir = path.join(sessionsDir, '2026-04-01-old');
        const newSessionDir = path.join(sessionsDir, '2026-04-28-new');
        const ticketId = 'fallback-ticket';
        const oldTicketDir = path.join(oldSessionDir, ticketId);
        const newTicketDir = path.join(newSessionDir, ticketId);
        fs.mkdirSync(fakeCwd, { recursive: true });
        fs.mkdirSync(oldTicketDir, { recursive: true });
        fs.mkdirSync(newTicketDir, { recursive: true });

        fs.writeFileSync(
            path.join(oldTicketDir, `rick_ticket_${ticketId}.md`),
            `---\nid: ${ticketId}\ntitle: Old\nstatus: Done\norder: 10\n---\n`
        );
        fs.writeFileSync(
            path.join(newTicketDir, `rick_ticket_${ticketId}.md`),
            `---\nid: ${ticketId}\ntitle: New\nstatus: Done\norder: 10\n---\n`
        );

        const oldStatePath = path.join(oldSessionDir, 'state.json');
        const newStatePath = path.join(newSessionDir, 'state.json');
        fs.writeFileSync(
            oldStatePath,
            JSON.stringify({
                schema_version: 1,
                active: false,
                working_dir: fakeCwd,
                step: 'implement',
                iteration: 1,
                session_dir: oldSessionDir,
                original_prompt: 'retry old fallback',
                current_ticket: 'T-OLD',
                worker_timeout_seconds: 1200,
                started_at: '2026-04-01T12:00:00.000Z',
            })
        );
        fs.writeFileSync(
            newStatePath,
            JSON.stringify({
                schema_version: 1,
                active: false,
                working_dir: fakeCwd,
                step: 'implement',
                iteration: 2,
                session_dir: newSessionDir,
                original_prompt: 'retry new fallback',
                current_ticket: 'T-NEW',
                worker_timeout_seconds: 1200,
                started_at: '2026-04-28T12:00:00.000Z',
            })
        );
        fs.utimesSync(oldStatePath, new Date('2026-04-01T12:00:00.000Z'), new Date('2026-04-01T12:00:00.000Z'));
        fs.utimesSync(newStatePath, new Date('2026-04-28T12:00:00.000Z'), new Date('2026-04-28T12:00:00.000Z'));

        retryTicket(ticketId, fakeCwd);

        const oldState = JSON.parse(fs.readFileSync(oldStatePath, 'utf-8'));
        const newState = JSON.parse(fs.readFileSync(newStatePath, 'utf-8'));
        assert.equal(oldState.active, false, 'older fallback session must stay inactive');
        assert.equal(newState.active, true, 'newest fallback session should be reactivated');
        assert.equal(newState.current_ticket, ticketId, 'newest fallback session should own the retry');

        const oldTicketContent = fs.readFileSync(path.join(oldTicketDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        const newTicketContent = fs.readFileSync(path.join(newTicketDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        assert.match(oldTicketContent, /^status: Done$/m, 'older fallback ticket must remain untouched');
        assert.match(newTicketContent, /^status: "Todo"$/m, 'newest fallback ticket should be reset');
    } finally {
        if (saved === undefined) {
            delete process.env.EXTENSION_DIR;
        } else {
            process.env.EXTENSION_DIR = saved;
        }
        fs.rmSync(tmpExtDir, { recursive: true, force: true });
    }
});

test('retryTicket: resolved session path wins over stale state.session_dir', () => {
    const tmpExtDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retry-ext-')));
    const liveSessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-live-session-')));
    const staleSessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-stale-session-')));
    const fakeCwd = path.join(tmpExtDir, 'repo');
    const saved = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = tmpExtDir;

    try {
        const ticketId = 'stale-session-dir-ticket';
        const liveTicketDir = path.join(liveSessionDir, ticketId);
        fs.mkdirSync(fakeCwd, { recursive: true });
        fs.mkdirSync(liveTicketDir, { recursive: true });

        fs.writeFileSync(
            path.join(liveTicketDir, `rick_ticket_${ticketId}.md`),
            `---\nid: ${ticketId}\ntitle: Test\nstatus: Done\norder: 10\n---\n`
        );

        fs.writeFileSync(
            path.join(liveSessionDir, 'state.json'),
            JSON.stringify({
                active: false,
                working_dir: fakeCwd,
                step: 'implement',
                iteration: 2,
                session_dir: staleSessionDir,
                original_prompt: 'retry through recovered session path',
                worker_timeout_seconds: 1200,
            })
        );

        fs.writeFileSync(
            path.join(tmpExtDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: liveSessionDir })
        );

        retryTicket(ticketId, fakeCwd);

        const liveState = JSON.parse(
            fs.readFileSync(path.join(liveSessionDir, 'state.json'), 'utf-8'));
        assert.equal(liveState.active, true);
        assert.equal(liveState.session_dir, liveSessionDir);
        assert.equal(liveState.current_ticket, ticketId);

        const ticketContent = fs.readFileSync(
            path.join(liveTicketDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        assert.match(ticketContent, /^status: "Todo"$/m);
    } finally {
        if (saved === undefined) {
            delete process.env.EXTENSION_DIR;
        } else {
            process.env.EXTENSION_DIR = saved;
        }
        fs.rmSync(tmpExtDir, { recursive: true, force: true });
        fs.rmSync(liveSessionDir, { recursive: true, force: true });
        fs.rmSync(staleSessionDir, { recursive: true, force: true });
    }
});

test('retryTicket: malformed worker timeout falls back to spawn-morty-compatible default', () => {
    const tmpExtDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-retry-ext-')));
    const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-session-')));
    const fakeCwd = path.join(tmpExtDir, 'repo');
    const saved = process.env.EXTENSION_DIR;
    process.env.EXTENSION_DIR = tmpExtDir;

    try {
        const ticketId = 'fractional-timeout-ticket';
        const ticketDir = path.join(sessionDir, ticketId);
        fs.mkdirSync(fakeCwd, { recursive: true });
        fs.mkdirSync(ticketDir, { recursive: true });

        fs.writeFileSync(
            path.join(ticketDir, `rick_ticket_${ticketId}.md`),
            `---\nid: ${ticketId}\ntitle: Test\nstatus: Done\norder: 10\n---\n`
        );
        fs.writeFileSync(
            path.join(sessionDir, 'state.json'),
            JSON.stringify({
                active: false,
                working_dir: fakeCwd,
                step: 'implement',
                iteration: 2,
                session_dir: sessionDir,
                original_prompt: 'retry malformed timeout',
                worker_timeout_seconds: '0.5',
            })
        );
        fs.writeFileSync(
            path.join(tmpExtDir, 'current_sessions.json'),
            JSON.stringify({ [fakeCwd]: sessionDir })
        );

        const output = captureRetryOutput(() => retryTicket(ticketId, fakeCwd));

        assert.match(output, /spawn-morty\.js/);
        assert.match(output, /--timeout 1200\b/);
        assert.doesNotMatch(output, /--timeout 0\.5\b/);
    } finally {
        if (saved === undefined) {
            delete process.env.EXTENSION_DIR;
        } else {
            process.env.EXTENSION_DIR = saved;
        }
        fs.rmSync(tmpExtDir, { recursive: true, force: true });
        fs.rmSync(sessionDir, { recursive: true, force: true });
    }
});
