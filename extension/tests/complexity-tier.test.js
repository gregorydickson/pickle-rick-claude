// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    parseTicketFrontmatter,
    buildHandoffSummary,
} from '../services/pickle-utils.js';

function withTempFile(content, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-tier-'));
    const file = path.join(dir, 'rick_ticket_test.md');
    fs.writeFileSync(file, content);
    try {
        fn(file);
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
}

// --- parseTicketFrontmatter: complexity_tier ---

test('complexity_tier: parses valid tier "small"', () => {
    withTempFile('---\nid: t1\ntitle: Test\nstatus: Todo\norder: 1\ncomplexity_tier: small\n---\n', (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.complexity_tier, 'small');
    });
});

test('complexity_tier: invalid value defaults to medium', () => {
    withTempFile('---\nid: t2\ntitle: Test\nstatus: Todo\norder: 1\ncomplexity_tier: huge\n---\n', (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.complexity_tier, 'medium');
    });
});

test('complexity_tier: missing field defaults to medium', () => {
    withTempFile('---\nid: t3\ntitle: Test\nstatus: Todo\norder: 1\n---\n', (file) => {
        const result = parseTicketFrontmatter(file);
        assert.equal(result.complexity_tier, 'medium');
    });
});

test('complexity_tier: all 4 valid values accepted', () => {
    for (const tier of ['trivial', 'small', 'medium', 'large']) {
        withTempFile(`---\nid: t4\ntitle: Test\nstatus: Todo\norder: 1\ncomplexity_tier: ${tier}\n---\n`, (file) => {
            const result = parseTicketFrontmatter(file);
            assert.equal(result.complexity_tier, tier, `expected tier '${tier}' to be accepted`);
        });
    }
});

// --- buildHandoffSummary: complexity_tier display ---

test('complexity_tier: handoff shows tag for non-medium tiers, omits for medium', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-tier-'));
    try {
        // Create tickets with different tiers
        for (const [id, tier] of [['triv', 'trivial'], ['sm', 'small'], ['med', 'medium'], ['lg', 'large']]) {
            const ticketDir = path.join(dir, id);
            fs.mkdirSync(ticketDir);
            fs.writeFileSync(
                path.join(ticketDir, `rick_ticket_${id}.md`),
                `---\nid: ${id}\ntitle: Ticket ${tier}\nstatus: Todo\norder: 1\ncomplexity_tier: ${tier}\n---\n`
            );
        }

        const summary = buildHandoffSummary({ step: 'implement', iteration: 1 }, dir);

        assert.match(summary, /triv:.*\[trivial\]/, 'trivial tier should show [trivial] tag');
        assert.match(summary, /sm:.*\[small\]/, 'small tier should show [small] tag');
        assert.ok(!summary.match(/med:.*\[medium\]/), 'medium tier should NOT show [medium] tag');
        assert.match(summary, /lg:.*\[large\]/, 'large tier should show [large] tag');
    } finally {
        fs.rmSync(dir, { recursive: true });
    }
});
