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

test('planTicketWave: an overlapping parallel-safe candidate ends the wave; later disjoint ones are not pulled ahead', () => {
  // Negative controls: dropping the filesOverlap check yields ['A','B','C'] (two tickets
  // editing x.ts in one wave); turning its `break` into `continue` yields ['A','C'].
  const A = { id: 'A', order: 1, parallelSafe: true, files: ['extension/src/services/x.ts'] };
  const B = { id: 'B', order: 2, parallelSafe: true, files: ['extension/services/x.js'] };
  const C = { id: 'C', order: 3, parallelSafe: true, files: ['extension/src/y.ts'] };
  assert.deepEqual(planTicketWave([C, B, A], 3), ['A']);
  assert.deepEqual(planTicketWave([C, B], 3), ['B', 'C']);
});

test('planTicketWave: a candidate overlapping a middle wave member ends the wave', () => {
  // Negative controls: checking only the first or only the last member yields ['A','B','C','D']
  // (B and D both editing y.ts in one wave); D overlaps neither A nor C.
  const A = { id: 'A', order: 1, parallelSafe: true, files: ['extension/src/w.ts'] };
  const B = { id: 'B', order: 2, parallelSafe: true, files: ['extension/src/y.ts'] };
  const C = { id: 'C', order: 3, parallelSafe: true, files: ['extension/src/z.ts'] };
  const D = { id: 'D', order: 4, parallelSafe: true, files: ['extension/src/y.ts'] };
  assert.deepEqual(planTicketWave([D, C, B, A], 4), ['A', 'B', 'C']);
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
    // Subsystem catalogs are CLAUDE.md files too; neither side names the other's path.
    ['nested CLAUDE.md', ['extension/src/services/CLAUDE.md'], ['extension/src/x.ts'], true],
    ['bare .claude', ['.claude'], ['extension/src/x.ts'], true],
    ['.claude/ nested',['.claude/commands/a.md'], ['extension/src/x.ts'], true],
    [
      'bin/js vs src/bin/ts mirror',
      ['extension/bin/x.js'],
      ['extension/src/bin/x.ts'],
      true,
    ],
    ['directory token', ['extension/src/'], ['extension/src/a.ts'], true],
    ['slash-less basename', ['a.ts'], ['extension/src/a.ts'], true],
    // a9666495: every compiled tree mirrors src/, not only bin/ and services/.
    ['hooks/js vs src/hooks/ts mirror', ['extension/hooks/handlers/h.js'], ['extension/src/hooks/handlers/h.ts'], true],
    ['lib/js vs src/lib/ts mirror', ['extension/lib/m.js'], ['extension/src/lib/m.ts'], true],
    ['compiled dir vs its compiled file', ['extension/hooks/'], ['extension/hooks/handlers/h.js'], true],
    ['different mirrored files', ['extension/hooks/a.js'], ['extension/src/hooks/b.ts'], false],
    // a9666495: a directory declared without a trailing slash still contains its files.
    ['slash-less directory token', ['extension/src/services'], ['extension/src/services/a.ts'], true],
    ['sibling name prefix is not containment', ['extension/src/services'], ['extension/src/services-old/a.ts'], false],
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
