// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseTicketFrontmatter, extractFrontmatter } from '../services/pickle-utils.js';

// --- Review ticket frontmatter round-trip ---

test('review ticket: frontmatter round-trip preserves all fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-review-'));
    try {
        const ticketContent = [
            '---',
            'id: r1a2b3c4',
            'title: "Review: correctness and architecture for abc1,def2,ghi3"',
            'status: Todo',
            'priority: High',
            'order: 35',
            'type: review',
            'review_group: abc1,def2,ghi3',
            'created: 2026-02-27',
            'updated: 2026-02-27',
            'links:',
            '  - url: ../rick_ticket_parent.md',
            '    title: Parent Ticket',
            '---',
            '# Description',
            '## Review Scope',
            'Review tickets abc1, def2, ghi3 for cross-cutting concerns.',
        ].join('\n');

        const filePath = path.join(dir, 'rick_ticket_r1a2b3c4.md');
        fs.writeFileSync(filePath, ticketContent);

        const parsed = parseTicketFrontmatter(filePath);
        assert.ok(parsed, 'should parse review ticket');
        assert.equal(parsed.id, 'r1a2b3c4');
        assert.equal(parsed.title, 'Review: correctness and architecture for abc1,def2,ghi3');
        assert.equal(parsed.status, 'Todo');
        assert.equal(parsed.order, 35);
        assert.equal(parsed.type, 'review');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('review ticket: parseTicketFrontmatter extracts review_group via extractFrontmatter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-review-'));
    try {
        const ticketContent = [
            '---',
            'id: r_group_test',
            'title: "Review: group extraction"',
            'status: Todo',
            'order: 45',
            'type: review',
            'review_group: impl1,impl2,impl3',
            '---',
            '# Review',
        ].join('\n');

        const filePath = path.join(dir, 'rick_ticket_r_group_test.md');
        fs.writeFileSync(filePath, ticketContent);

        // parseTicketFrontmatter returns TicketInfo which has id, title, status, order, type
        // review_group is NOT in TicketInfo — must extract via extractFrontmatter
        const parsed = parseTicketFrontmatter(filePath);
        assert.ok(parsed, 'should parse');
        assert.equal(parsed.type, 'review');
        assert.equal(parsed.id, 'r_group_test');

        // Verify review_group is accessible via extractFrontmatter
        const content = fs.readFileSync(filePath, 'utf-8');
        const fm = extractFrontmatter(content);
        assert.ok(fm, 'should have frontmatter');
        const match = fm.body.match(/^review_group:\s*(.+)$/m);
        assert.ok(match, 'review_group should be present in frontmatter');
        const ids = match[1].trim().split(',').map(s => s.trim());
        assert.deepEqual(ids, ['impl1', 'impl2', 'impl3']);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('review ticket: malformed review_group with empty segments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-review-'));
    try {
        const ticketContent = [
            '---',
            'id: r_malformed',
            'title: "Review: malformed group"',
            'status: Todo',
            'order: 50',
            'type: review',
            'review_group: abc1,,def2,,,ghi3',
            '---',
            '# Review',
        ].join('\n');

        const filePath = path.join(dir, 'rick_ticket_r_malformed.md');
        fs.writeFileSync(filePath, ticketContent);

        const content = fs.readFileSync(filePath, 'utf-8');
        const fm = extractFrontmatter(content);
        assert.ok(fm);
        const match = fm.body.match(/^review_group:\s*(.+)$/m);
        assert.ok(match);
        // Splitting with empty segments produces empty strings — consumers should filter
        const ids = match[1].trim().split(',').map(s => s.trim()).filter(Boolean);
        assert.deepEqual(ids, ['abc1', 'def2', 'ghi3']);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('review ticket: review_group parsing from frontmatter', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-review-'));
    try {
        const ticketContent = [
            '---',
            'id: r5e6f7g8',
            'title: "Review: group 2"',
            'status: Todo',
            'order: 65',
            'type: review',
            'review_group: abc1,def2,ghi3',
            '---',
            '# Review',
        ].join('\n');

        const filePath = path.join(dir, 'rick_ticket_r5e6f7g8.md');
        fs.writeFileSync(filePath, ticketContent);

        // Extract review_group via extractFrontmatter + manual parse
        const content = fs.readFileSync(filePath, 'utf-8');
        const fm = extractFrontmatter(content);
        assert.ok(fm, 'should have frontmatter');

        const match = fm.body.match(/^review_group:\s*(.+)$/m);
        assert.ok(match, 'should have review_group field');
        const groupIds = match[1].trim().split(',').map(s => s.trim());
        assert.deepEqual(groupIds, ['abc1', 'def2', 'ghi3']);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
