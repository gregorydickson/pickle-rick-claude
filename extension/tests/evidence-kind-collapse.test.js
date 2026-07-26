// @tier: fast
//
// B-DURA T70: EvidenceKind collapse to { committed, absent }.
//
// Asserts the net-negative subtraction:
//   - EvidenceKind has exactly 2 variants (committed, absent); no inferred-*.
//   - The deprecated hasCompletionCommit shim is gone from pickle-utils.ts.
//   - The dead 'unreachable' variant of CompletionCommitEvidence['source'] is gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src');

test('EvidenceKind union is exactly committed | absent (no inferred-* variants)', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'ticket-completion-evidence.ts'), 'utf8');
  const m = src.match(/export type EvidenceKind\s*=\s*([^;]+);/);
  assert.ok(m, 'EvidenceKind type declaration must be present');
  const variants = m[1]
    .split('|')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .sort();
  assert.deepEqual(variants, ['absent', 'committed'], `EvidenceKind must be exactly committed|absent, got: ${variants.join(', ')}`);
  assert.ok(!src.includes("'inferred-fresh'"), 'inferred-fresh variant must be gone');
  assert.ok(!src.includes("'inferred-stale'"), 'inferred-stale variant must be gone');
});

test('hasCompletionCommit shim is deleted from pickle-utils.ts', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'pickle-utils.ts'), 'utf8');
  assert.ok(
    !/export function hasCompletionCommit\b/.test(src),
    'the deprecated hasCompletionCommit shim must be deleted (B-DURA T70)',
  );
});

test("dead 'unreachable' variant of CompletionCommitEvidence['source'] is deleted", () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'pickle-utils.ts'), 'utf8');
  const m = src.match(/source:\s*('explicit-reachable'[^;]*);/);
  assert.ok(m, "CompletionCommitEvidence['source'] union must be present");
  assert.ok(!m[1].includes('unreachable'), "the dead 'unreachable' source variant must be deleted");
});
