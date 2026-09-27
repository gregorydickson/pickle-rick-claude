// @tier: fast
// Pure ticket-wave scheduler coverage: planTicketWave (wave composition from
// order/parallelSafe/files), filesOverlap (the overlap predicate it delegates to),
// and readParallelSafe (frontmatter opt-in reader).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planTicketWave, filesOverlap, readParallelSafe } from '../../services/ticket-waves.js';

test('planTicketWave: cap 2, successive calls removing planned ids yield the AC-1 table', () => {
  const I = { id: 'I', order: 10, parallelSafe: true, files: ['extension/src/x.ts'] };
  const J = { id: 'J', order: 20, parallelSafe: true, files: ['extension/src/y.ts'] };
  const W = { id: 'W', order: 30, parallelSafe: false, files: ['extension/src/index.ts'] };
  const T = { id: 'T', order: 40, parallelSafe: false, files: ['extension/tests/x.test.js'] };
  const L = { id: 'L', order: 50, parallelSafe: true, files: ['extension/src/z.ts'] };

  let pending = [I, J, W, T, L];
  const cap = 2;

  // Negative control (recorded per AC-3): removing the `!candidate.parallelSafe` break
  // in planTicketWave would let W (unmarked/unsafe) join J's wave on this first call —
  // W is disjoint from I and J's files, so only the parallelSafe check stops it. Without
  // that check call 1 would return ['I','J','W'] instead of ['I','J'] and this table reds.
  let wave = planTicketWave(pending, cap);
  assert.deepEqual(wave, ['I', 'J']);
  pending = pending.filter(c => !wave.includes(c.id));

  wave = planTicketWave(pending, cap);
  assert.deepEqual(wave, ['W']);
  pending = pending.filter(c => !wave.includes(c.id));

  wave = planTicketWave(pending, cap);
  assert.deepEqual(wave, ['T']);
  pending = pending.filter(c => !wave.includes(c.id));

  wave = planTicketWave(pending, cap);
  assert.deepEqual(wave, ['L']);
  pending = pending.filter(c => !wave.includes(c.id));

  assert.deepEqual(pending, []);
});

test('planTicketWave: empty pending returns empty wave', () => {
  assert.deepEqual(planTicketWave([], 2), []);
});

test('planTicketWave: cap is clamped to at least 1', () => {
  const A = { id: 'A', order: 1, parallelSafe: true, files: ['a.ts'] };
  const B = { id: 'B', order: 2, parallelSafe: true, files: ['b.ts'] };
  assert.deepEqual(planTicketWave([A, B], 0), ['A']);
});

test('filesOverlap: AC-2 table', () => {
  const rows = [
    ['disjoint', ['extension/src/x.ts'], ['extension/src/y.ts'], false],
    ['shared file', ['extension/src/x.ts'], ['extension/src/x.ts'], true],
    ['empty list a', [], ['extension/src/x.ts'], true],
    ['empty list b', ['extension/src/x.ts'], [], true],
    ['CLAUDE.md', ['CLAUDE.md'], ['extension/src/x.ts'], true],
    ['.claude/ nested', ['.claude/commands/a.md'], ['extension/src/x.ts'], true],
    [
      'bin/js vs src/bin/ts mirror',
      ['extension/bin/x.js'],
      ['extension/src/bin/x.ts'],
      true,
    ],
    ['directory token', ['extension/src/'], ['extension/src/a.ts'], true],
    ['slash-less basename', ['a.ts'], ['extension/src/a.ts'], true],
  ];

  for (const [label, a, b, expected] of rows) {
    assert.equal(filesOverlap(a, b), expected, `${label}: filesOverlap(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    assert.equal(filesOverlap(b, a), expected, `${label} (reversed)`);
  }
});

test('readParallelSafe: only the strict frontmatter true opts in', () => {
  assert.equal(readParallelSafe('---\nparallel_safe: true\n---\n'), true);
  assert.equal(readParallelSafe('---\nparallel_safe: false\n---\n'), false);
  assert.equal(readParallelSafe('---\ntitle: x\n---\n'), false);
  assert.equal(readParallelSafe(''), false);
});
