// @tier: fast
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getBranchName, getGithubUser, updateTicketStatus } from '../services/git-utils.js';
import { formatLocalDateKey } from '../services/pickle-utils.js';

function withTimezone(tz, fn) {
    const saved = process.env.TZ;
    process.env.TZ = tz;
    try {
        return fn();
    } finally {
        if (saved === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = saved;
        }
    }
}

// --- getBranchName ---
// getGithubUser() falls back to 'pickle-rick' when gh/git unavailable,
// so branch format is always <user>/<type>/<task_id>

test('getBranchName: uses "fix" type for bug-related ticket id', () => {
    const branch = getBranchName('fix-auth-123');
    assert.match(branch, /\/fix\/fix-auth-123$/);
});

test('getBranchName: uses "fix" type for "bug" in ticket id', () => {
    const branch = getBranchName('bug-login-overflow');
    assert.match(branch, /\/fix\/bug-login-overflow$/);
});

test('getBranchName: uses "feat" type for normal ticket', () => {
    const branch = getBranchName('add-login-button');
    assert.match(branch, /\/feat\/add-login-button$/);
});

test('getBranchName: contains the ticket id', () => {
    const branch = getBranchName('abc123');
    assert.ok(branch.includes('abc123'), `ticket id not in branch: ${branch}`);
});

test('getBranchName: has three slash-separated parts', () => {
    const branch = getBranchName('my-ticket');
    const parts = branch.split('/');
    assert.ok(parts.length >= 3, `expected at least 3 parts: ${branch}`);
});

// --- updateTicketStatus ---

test('updateTicketStatus: updates status in frontmatter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'testticket';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    fs.writeFileSync(
        path.join(subDir, `rick_ticket_${ticketId}.md`),
        `---\nid: ${ticketId}\ntitle: Test\nstatus: Todo\nupdated: 2025-01-01\n---\n# Body\n`
    );
    try {
        updateTicketStatus(ticketId, 'Done', dir);
        const content = fs.readFileSync(
            path.join(subDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        assert.match(content, /^status: "Done"$/m);
        // updated date should be refreshed
        const today = formatLocalDateKey(new Date());
        assert.match(content, new RegExp(`updated: "${today}"`));
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('updateTicketStatus: updated date uses local day, not UTC day', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'local-day';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    fs.writeFileSync(
        path.join(subDir, `rick_ticket_${ticketId}.md`),
        `---\nid: ${ticketId}\ntitle: Test\nstatus: Todo\nupdated: 2025-01-01\n---\n# Body\n`
    );

    try {
        withTimezone('America/Chicago', () => {
            mock.timers.enable({ apis: ['Date'], now: new Date('2026-04-29T01:30:00.000Z') });
            try {
                updateTicketStatus(ticketId, 'Done', dir);
            } finally {
                mock.timers.reset();
            }
        });
        const content = fs.readFileSync(
            path.join(subDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        assert.match(content, /updated: "2026-04-28"/);
        assert.doesNotMatch(content, /updated: "2026-04-29"/);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('updateTicketStatus: throws when ticket file not found', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    try {
        assert.throws(
            () => updateTicketStatus('nonexistent', 'Done', dir),
            /not found/
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- getGithubUser ---

test('getGithubUser: returns a non-empty string', () => {
    const user = getGithubUser();
    assert.ok(typeof user === 'string', 'should return a string');
    assert.ok(user.length > 0, 'should not be empty');
});

// --- updateTicketStatus: updated field ---

test('updateTicketStatus: updates the "updated" field to today', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'upd-date-check';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    fs.writeFileSync(
        path.join(subDir, `rick_ticket_${ticketId}.md`),
        '---\nid: "upd-date-check"\ntitle: "Date Test"\nstatus: "Todo"\nupdated: "2020-01-01"\norder: 1\n---\n# Body\n'
    );
    try {
        updateTicketStatus(ticketId, 'InProgress', dir);
        const content = fs.readFileSync(
            path.join(subDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        const today = formatLocalDateKey(new Date());
        assert.match(content, new RegExp(`updated: "${today}"`),
            'updated field should be set to today');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- updateTicketStatus: no frontmatter ---

test('updateTicketStatus: no frontmatter prints warning and still replaces status', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'no-fm';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    // No --- delimiters — just bare YAML-like fields
    fs.writeFileSync(
        path.join(subDir, `rick_ticket_${ticketId}.md`),
        'id: "no-fm"\ntitle: "No Frontmatter"\nstatus: "Todo"\nupdated: "2020-01-01"\n\n# Body\nSome content.\n'
    );
    try {
        // Capture console.warn output
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            updateTicketStatus(ticketId, 'Done', dir);
        } finally {
            console.warn = origWarn;
        }
        // Should have warned about missing frontmatter
        assert.ok(warnings.some(w => w.includes('no valid YAML frontmatter')),
            `expected a warning about missing frontmatter, got: ${JSON.stringify(warnings)}`);
        // Status should still be updated via full-file replace
        const content = fs.readFileSync(
            path.join(subDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        assert.match(content, /^status: "Done"$/m);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- updateTicketStatus: preserves body content ---

test('updateTicketStatus: preserves body content after frontmatter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'body-preserve';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    const bodyContent = '# Ticket Body\nSome important content here.\n\n- bullet one\n- bullet two\n';
    fs.writeFileSync(
        path.join(subDir, `rick_ticket_${ticketId}.md`),
        `---\nid: "${ticketId}"\ntitle: "Body Test"\nstatus: "Todo"\nupdated: "2020-01-01"\norder: 1\n---\n${bodyContent}`
    );
    try {
        updateTicketStatus(ticketId, 'Done', dir);
        const content = fs.readFileSync(
            path.join(subDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        // Status should be updated
        assert.match(content, /^status: "Done"$/m);
        // Body content must be preserved exactly
        assert.ok(content.includes(bodyContent),
            'body content after frontmatter should be unchanged');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- updateTicketStatus: nested ticket ---

test('updateTicketStatus: finds ticket in nested subdirectory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'nested-ticket';
    // Create a deeper directory structure: session_dir/some/nested/dir/ticketId/
    const nestedDir = path.join(dir, 'some', 'nested', 'dir', ticketId);
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
        path.join(nestedDir, `rick_ticket_${ticketId}.md`),
        `---\nid: "${ticketId}"\ntitle: "Nested Test"\nstatus: "Todo"\nupdated: "2020-01-01"\norder: 1\n---\n# Nested Body\n`
    );
    try {
        updateTicketStatus(ticketId, 'InProgress', dir);
        const content = fs.readFileSync(
            path.join(nestedDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        assert.match(content, /^status: "InProgress"$/m,
            'status should be updated even in deeply nested ticket file');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- updateTicketStatus: warns when no status field found (deep review pass 6) ---

test('updateTicketStatus: warns when ticket has no status field to replace', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'no-status-field';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    // Frontmatter with no status: line at all
    fs.writeFileSync(
        path.join(subDir, `rick_ticket_${ticketId}.md`),
        `---\nid: "${ticketId}"\ntitle: "No Status"\norder: 1\n---\n# Body\n`
    );
    try {
        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));
        const origLog = console.log;
        const logs = [];
        console.log = (...args) => logs.push(args.join(' '));
        try {
            updateTicketStatus(ticketId, 'Done', dir);
        } finally {
            console.warn = origWarn;
            console.log = origLog;
        }
        // Should have warned about missing status field
        assert.ok(
            warnings.some(w => w.includes('status not updated')),
            `expected warning about status not updated, got: ${JSON.stringify(warnings)}`
        );
        // Should NOT have logged success
        assert.ok(
            !logs.some(l => l.includes('Successfully updated')),
            `should not log success when no status field was replaced, got: ${JSON.stringify(logs)}`
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- updateTicketStatus: depth limit protects against deep recursion ---

test('updateTicketStatus: respects depth limit on deeply nested directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'deep-ticket';
    // Create a structure 12 levels deep (exceeds the depth=10 limit)
    let current = dir;
    for (let i = 0; i < 12; i++) {
        current = path.join(current, `level${i}`);
    }
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(
        path.join(current, `rick_ticket_${ticketId}.md`),
        `---\nid: "${ticketId}"\ntitle: "Deep"\nstatus: "Todo"\n---\n# Body\n`
    );
    try {
        // Should throw because the file is too deep (>10 levels)
        assert.throws(
            () => updateTicketStatus(ticketId, 'Done', dir),
            /not found/,
            'Should not find ticket beyond depth limit'
        );
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- updateTicketStatus: YAML injection guard (deep review pass 8) ---

test('updateTicketStatus: rejects status with double quotes (YAML injection)', () => {
    assert.throws(
        () => updateTicketStatus('any-ticket', 'Done"\nevil: true', '/tmp/nonexistent'),
        /must not contain quotes or newlines/,
        'new_status with quotes/newlines should be rejected'
    );
});

test('updateTicketStatus: rejects status with bare newline', () => {
    assert.throws(
        () => updateTicketStatus('any-ticket', 'Done\ninjected: yes', '/tmp/nonexistent'),
        /must not contain quotes or newlines/,
        'new_status with newlines should be rejected'
    );
});

// --- updateTicketStatus: inserts updated field when missing (pass 9) ---

test('updateTicketStatus: inserts updated field when missing from frontmatter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'no-updated-field';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    // Frontmatter with status but no updated: line
    fs.writeFileSync(
        path.join(subDir, `rick_ticket_${ticketId}.md`),
        `---\nid: "${ticketId}"\ntitle: "No Updated"\nstatus: "Todo"\norder: 1\n---\n# Body\n`
    );
    try {
        updateTicketStatus(ticketId, 'Done', dir);
        const content = fs.readFileSync(
            path.join(subDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        // Status should be updated
        assert.match(content, /^status: "Done"$/m);
        // updated field should be inserted within frontmatter
        const today = formatLocalDateKey(new Date());
        assert.match(content, new RegExp(`updated: "${today}"`),
            'updated field should be inserted when missing');
        // Verify inserted before closing ---
        const fmEndIdx = content.indexOf('\n---', 4);
        const updatedIdx = content.indexOf(`updated: "${today}"`);
        assert.ok(updatedIdx < fmEndIdx,
            'updated field should appear before closing --- delimiter');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- updateTicketStatus: body status untouched (pass 9) ---

test('updateTicketStatus: does not replace status: line in body after frontmatter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
    const ticketId = 'body-status';
    const subDir = path.join(dir, ticketId);
    fs.mkdirSync(subDir);
    // status: appears both in frontmatter AND in the body
    fs.writeFileSync(
        path.join(subDir, `rick_ticket_${ticketId}.md`),
        `---\nid: "${ticketId}"\ntitle: "Body Status"\nstatus: "Todo"\nupdated: "2020-01-01"\n---\n# Body\nstatus: should-not-change\n`
    );
    try {
        updateTicketStatus(ticketId, 'Done', dir);
        const content = fs.readFileSync(
            path.join(subDir, `rick_ticket_${ticketId}.md`), 'utf-8');
        // Frontmatter status should be updated
        assert.match(content, /^status: "Done"$/m);
        // Body status should remain unchanged
        assert.ok(content.includes('status: should-not-change'),
            'status: in body after frontmatter must not be modified');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

// --- getBranchName: "issue" keyword → fix type ---

test('getBranchName: uses "fix" type for "issue" keyword in ticket id', () => {
    const branch = getBranchName('issue-auth-flow');
    assert.match(branch, /\/fix\/issue-auth-flow$/,
        'ticket id containing "issue" should use "fix" type');
});

// --- getBranchName: "patch" keyword → fix type ---

test('getBranchName: uses "fix" type for "patch" keyword in ticket id', () => {
    const branch = getBranchName('patch-memory-leak');
    assert.match(branch, /\/fix\/patch-memory-leak$/,
        'ticket id containing "patch" should use "fix" type');
});
