// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyTicketTier } from '../services/pickle-utils.js';
import { resolveEffectiveTierForTicket } from '../bin/spawn-morty.js';

function withTempTicket(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piap-a5-'));
  const file = path.join(dir, 'rick_ticket_test.md');
  fs.writeFileSync(file, content);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

// --- AC-PIAP-A5-1: Determinism ---

test('AC-PIAP-A5-1: classifyTicketTier is deterministic — same inputs yield same output across repeated calls', () => {
  const info = { fileCount: 3, acCount: 4, locEstimate: 100, text: 'implement the feature' };
  const r1 = classifyTicketTier(info);
  const r2 = classifyTicketTier(info);
  const r3 = classifyTicketTier(info);
  assert.equal(r1, r2, 'second call must match first');
  assert.equal(r2, r3, 'third call must match second');
});

test('AC-PIAP-A5-1: deterministic across different valid inputs', () => {
  const inputs = [
    { fileCount: 1, acCount: 1, locEstimate: 5, text: 'fix typo' },
    { fileCount: 2, acCount: 3, locEstimate: 50, text: 'add helper' },
    { fileCount: 10, acCount: 10, locEstimate: 500, text: 'refactor system' },
  ];
  for (const info of inputs) {
    const r1 = classifyTicketTier(info);
    const r2 = classifyTicketTier(info);
    assert.equal(r1, r2, `must be deterministic for input: ${JSON.stringify(info)}`);
  }
});

// --- AC-PIAP-A5-2: Tier boundaries + ambiguous rounds UP ---

test('AC-PIAP-A5-2: trivial fixture — 1 file, 1 AC, 5 LOC, no keywords', () => {
  const info = { fileCount: 1, acCount: 1, locEstimate: 5, text: 'update a config value' };
  assert.equal(classifyTicketTier(info), 'trivial');
});

test('AC-PIAP-A5-2: small fixture — 2 files, 2 ACs, 40 LOC, neutral text', () => {
  const info = { fileCount: 2, acCount: 2, locEstimate: 40, text: 'add new helper function' };
  assert.equal(classifyTicketTier(info), 'small');
});

test('AC-PIAP-A5-2: medium fixture — 3 files, 5 ACs, 120 LOC, neutral text', () => {
  const info = { fileCount: 3, acCount: 5, locEstimate: 120, text: 'implement the feature' };
  assert.equal(classifyTicketTier(info), 'medium');
});

test('AC-PIAP-A5-2: large fixture — 5 files, 7 ACs, 300 LOC, neutral text', () => {
  const info = { fileCount: 5, acCount: 7, locEstimate: 300, text: 'build the subsystem' };
  assert.equal(classifyTicketTier(info), 'large');
});

test('AC-PIAP-A5-2: larger keyword "refactor" promotes tier', () => {
  // Without keyword: fileScore=1(small), acScore=1(small), locScore=0(trivial) → small
  // With "refactor" keyword: delta=+1 → small+1 = medium
  const info = { fileCount: 2, acCount: 2, locEstimate: 10, text: 'refactor the module' };
  assert.equal(classifyTicketTier(info), 'medium');
});

test('AC-PIAP-A5-2: smaller keyword "typo" demotes tier', () => {
  // Without keyword: fileScore=1(small), acScore=1(small), locScore=1(small) → small
  // With "typo" keyword: delta=-1 → small-1 = trivial
  const info = { fileCount: 2, acCount: 2, locEstimate: 40, text: 'fix typo in label text' };
  assert.equal(classifyTicketTier(info), 'trivial');
});

test('AC-PIAP-A5-2: ambiguous inputs round UP — small fileCount but medium acCount → medium', () => {
  // fileScore = scoreDimension(2, [2,3,5]) = 1 (small)
  // acScore = scoreDimension(5, [2,4,7]) = 2 (medium)
  // locScore = scoreDimension(30, [21,81,251]) = 1 (small)
  // max = 2 (medium) — ties round UP to the larger tier
  const info = { fileCount: 2, acCount: 5, locEstimate: 30, text: 'neutral implementation task' };
  assert.equal(classifyTicketTier(info), 'medium');
});

test('AC-PIAP-A5-2: ambiguous inputs round UP — trivial files but large LOC → large', () => {
  // fileScore = 0 (trivial), acScore = 0 (trivial), locScore = scoreDimension(300, [21,81,251]) = 3 (large)
  // max = 3 (large) — single large dimension dominates
  const info = { fileCount: 1, acCount: 1, locEstimate: 300, text: 'big single-file change' };
  assert.equal(classifyTicketTier(info), 'large');
});

test('AC-PIAP-A5-2: "cross-cutting" keyword recognized', () => {
  // base: fileScore=1, acScore=1, locScore=0 → small
  // "cross-cutting" larger keyword: delta=+1 → medium
  const info = { fileCount: 2, acCount: 2, locEstimate: 5, text: 'cross-cutting concern across modules' };
  assert.equal(classifyTicketTier(info), 'medium');
});

test('AC-PIAP-A5-2: conflicting keywords cancel out — keyword delta clamped to 0', () => {
  // base: fileScore=1, acScore=1 → small
  // "refactor" (+1) and "typo" (-1): net delta = 0 → stays small
  const info = { fileCount: 2, acCount: 2, locEstimate: 10, text: 'refactor to fix typo' };
  assert.equal(classifyTicketTier(info), 'small');
});

test('AC-PIAP-A5-2: zero fileCount and acCount with no keywords → trivial', () => {
  const info = { fileCount: 0, acCount: 0, locEstimate: 0, text: 'tiny update' };
  assert.equal(classifyTicketTier(info), 'trivial');
});

// --- AC-PIAP-A5-3: No complexity_tier in ticket → classified before delegation ---

test('AC-PIAP-A5-3: ticket with no complexity_tier is classified (not bare medium default)', () => {
  const content = [
    '---',
    'id: test123',
    'title: Fix typo in button label',
    'status: Todo',
    'order: 1',
    '---',
    '',
    '# Fix Typo in Button Label',
    '',
    '## Problem',
    'There is a typo in the button label text.',
    '',
    '## Acceptance Criteria',
    '- Fix the typo in the label',
    '',
  ].join('\n');

  withTempTicket(content, (file) => {
    const tier = resolveEffectiveTierForTicket(file);
    assert.ok(tier !== null, 'must return a tier, not null');
    // "typo" keyword → smaller signal; 1 file-ish, 1 AC → trivial base
    // The classifier must have run (not the bare 'medium' normalizeTicketComplexityTier default)
    assert.equal(tier, 'trivial', 'trivial fixture should classify as trivial, not bare medium default');
  });
});

test('AC-PIAP-A5-3: ticket with explicit complexity_tier uses it directly', () => {
  const content = [
    '---',
    'id: test456',
    'title: Large refactor',
    'status: Todo',
    'order: 1',
    'complexity_tier: large',
    '---',
    '',
    '## Acceptance Criteria',
    '- AC1',
    '',
  ].join('\n');

  withTempTicket(content, (file) => {
    const tier = resolveEffectiveTierForTicket(file);
    assert.equal(tier, 'large', 'explicit tier should be returned as-is');
  });
});

test('AC-PIAP-A5-3: ticket with invalid complexity_tier falls back to classifier', () => {
  const content = [
    '---',
    'id: test789',
    'title: Quick color change',
    'status: Todo',
    'order: 1',
    'complexity_tier: INVALID',
    '---',
    '',
    '## Problem',
    'Change the button color.',
    '',
    '## Acceptance Criteria',
    '- Update the color value',
    '',
  ].join('\n');

  withTempTicket(content, (file) => {
    const tier = resolveEffectiveTierForTicket(file);
    // "color" is a smaller keyword → should classify as trivial (1 AC, few files, small LOC)
    assert.ok(['trivial', 'small'].includes(tier), `expected trivial or small, got ${tier}`);
    assert.notEqual(tier, 'medium', 'invalid tier must use classifier, not bare medium default');
  });
});

test('AC-PIAP-A5-3: null ticketFilePath returns null', () => {
  const tier = resolveEffectiveTierForTicket(null);
  assert.equal(tier, null, 'null path must return null');
});
