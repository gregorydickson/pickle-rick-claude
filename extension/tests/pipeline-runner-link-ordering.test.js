// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectTickets, topoSortTickets, parseTicketFrontmatter } from '../services/pickle-utils.js';

// AC-SSV-05: topological sort honoring depends_on (replaces pure-numeric sort
// that let C-T0 run before NEW-T2 even though NEW-T2 depended on C-T0).

function ticket({ id, order = 0, depends_on = [], status = 'Todo' }) {
    return {
        id,
        title: id,
        status,
        order,
        type: null,
        working_dir: null,
        completed_at: null,
        skipped_at: null,
        complexity_tier: 'medium',
        depends_on,
    };
}

function writeTicket(dir, { id, order = 0, depends_on = [], status = 'Todo' }) {
    const sub = path.join(dir, id);
    fs.mkdirSync(sub, { recursive: true });
    const depsBlock = depends_on.length > 0
        ? `depends_on:\n${depends_on.map((d) => `  - ${d}`).join('\n')}\n`
        : '';
    fs.writeFileSync(
        path.join(sub, `rick_ticket_${id}.md`),
        `---\nid: ${id}\ntitle: ${id}\nstatus: ${status}\norder: ${order}\n${depsBlock}---\n`,
    );
}

// --- Linear chain ---

test('topoSortTickets: linear chain A->B->C orders C, B, A', () => {
    const tickets = [
        ticket({ id: 'A', depends_on: ['B'] }),
        ticket({ id: 'B', depends_on: ['C'] }),
        ticket({ id: 'C' }),
    ];
    const sorted = topoSortTickets(tickets);
    assert.deepEqual(sorted.map((t) => t.id), ['C', 'B', 'A']);
});

// --- Diamond ---

test('topoSortTickets: diamond A->{B,C}->D — D first, A last', () => {
    const tickets = [
        ticket({ id: 'A', depends_on: ['B', 'C'] }),
        ticket({ id: 'B', depends_on: ['D'] }),
        ticket({ id: 'C', depends_on: ['D'] }),
        ticket({ id: 'D' }),
    ];
    const sorted = topoSortTickets(tickets);
    assert.equal(sorted[0].id, 'D');
    assert.equal(sorted[3].id, 'A');
    const idxB = sorted.findIndex((t) => t.id === 'B');
    const idxC = sorted.findIndex((t) => t.id === 'C');
    const idxD = sorted.findIndex((t) => t.id === 'D');
    const idxA = sorted.findIndex((t) => t.id === 'A');
    assert.ok(idxD < idxB && idxD < idxC, 'D must precede B and C');
    assert.ok(idxB < idxA && idxC < idxA, 'A must follow both B and C');
});

// --- Cycle ---

test('topoSortTickets: cycle A->B->A throws with both ids in message', () => {
    const tickets = [
        ticket({ id: 'A', depends_on: ['B'] }),
        ticket({ id: 'B', depends_on: ['A'] }),
    ];
    assert.throws(
        () => topoSortTickets(tickets),
        (err) => {
            assert.match(err.message, /cycle detected/i);
            assert.match(err.message, /\bA\b/);
            assert.match(err.message, /\bB\b/);
            return true;
        },
    );
});

// --- Pure-order tie-break ---

test('topoSortTickets: pure-order tie-break (no depends_on) — order 10 first', () => {
    const tickets = [
        ticket({ id: 'X', order: 20 }),
        ticket({ id: 'Y', order: 10 }),
    ];
    const sorted = topoSortTickets(tickets);
    assert.deepEqual(sorted.map((t) => t.id), ['Y', 'X']);
});

// --- Mixed: depends_on overrides order ---

test('topoSortTickets: depends_on respected even when order would invert', () => {
    // Without depends_on, order 100 (NEW-T2) would come before order 200 (C-T0).
    // But NEW-T2 depends_on C-T0, so C-T0 must run first regardless of order.
    const tickets = [
        ticket({ id: 'NEW-T2', order: 100, depends_on: ['C-T0'] }),
        ticket({ id: 'C-T0', order: 200 }),
    ];
    const sorted = topoSortTickets(tickets);
    assert.deepEqual(sorted.map((t) => t.id), ['C-T0', 'NEW-T2']);
});

// --- Backward-compat: existing pure-order callers (no depends_on) ---

test('collectTickets: backward-compatible — no depends_on means pure order sort', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-topo-'));
    try {
        writeTicket(dir, { id: 'aaa', order: 20 });
        writeTicket(dir, { id: 'bbb', order: 10 });
        const tickets = collectTickets(dir);
        assert.equal(tickets.length, 2);
        assert.equal(tickets[0].id, 'bbb');
        assert.equal(tickets[1].id, 'aaa');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('collectTickets: depends_on parsed from frontmatter and respected by sort', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-topo-'));
    try {
        writeTicket(dir, { id: 'NEW-T2', order: 100, depends_on: ['C-T0'] });
        writeTicket(dir, { id: 'C-T0', order: 200 });
        const tickets = collectTickets(dir);
        assert.deepEqual(tickets.map((t) => t.id), ['C-T0', 'NEW-T2']);
        const dep = tickets.find((t) => t.id === 'NEW-T2');
        assert.deepEqual(dep.depends_on, ['C-T0']);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('parseTicketFrontmatter: inline depends_on array', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-topo-'));
    try {
        const sub = path.join(dir, 't1');
        fs.mkdirSync(sub);
        const file = path.join(sub, 'rick_ticket_t1.md');
        fs.writeFileSync(file, '---\nid: t1\ntitle: t1\nstatus: Todo\norder: 10\ndepends_on: [a, "b", c]\n---\n');
        const parsed = parseTicketFrontmatter(file);
        assert.deepEqual(parsed.depends_on, ['a', 'b', 'c']);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('parseTicketFrontmatter: dependencies alias merges with depends_on, dedupes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-topo-'));
    try {
        const sub = path.join(dir, 't1');
        fs.mkdirSync(sub);
        const file = path.join(sub, 'rick_ticket_t1.md');
        fs.writeFileSync(
            file,
            '---\nid: t1\ntitle: t1\nstatus: Todo\norder: 10\ndepends_on:\n  - a\n  - b\ndependencies:\n  - b\n  - c\n---\n',
        );
        const parsed = parseTicketFrontmatter(file);
        assert.deepEqual(parsed.depends_on, ['a', 'b', 'c']);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});

test('parseTicketFrontmatter: external: prefix is stripped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-topo-'));
    try {
        const sub = path.join(dir, 't1');
        fs.mkdirSync(sub);
        const file = path.join(sub, 'rick_ticket_t1.md');
        fs.writeFileSync(
            file,
            '---\nid: t1\ntitle: t1\nstatus: Todo\norder: 10\ndepends_on:\n  - external: ext-thing\n  - local-dep\n---\n',
        );
        const parsed = parseTicketFrontmatter(file);
        assert.deepEqual(parsed.depends_on, ['ext-thing', 'local-dep']);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
