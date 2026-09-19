// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

async function importModule() {
  const { parseTrapDoorDeclarations, auditTrapDoorDeclarations } = await import(
    '../../services/citadel/rule-set-invariant-audit.js'
  );
  return { parseTrapDoorDeclarations, auditTrapDoorDeclarations };
}

describe('parseTrapDoorDeclarations — unit', () => {
  test('valid triple counts as one declaration, zero findings', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Trap Doors',
      '',
      '- `src/foo.ts` — INVARIANT: foo stays stable. BREAKS: bar explodes. ENFORCE: extension/tests/foo.test.js.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 1);
    assert.equal(result.findings.length, 0);
  });

  test('INVARIANT without BREAKS emits malformed finding', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Trap Doors',
      '',
      '- `src/foo.ts` — INVARIANT: foo must be present. ENFORCE: extension/tests/foo.test.js.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 0);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].id, /malformed-triple:no-breaks/);
  });

  test('INVARIANT + BREAKS but ENFORCE content has no .test.js or .sh ref emits finding', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Trap Doors',
      '',
      '- `src/foo.ts` — INVARIANT: foo is invariant. BREAKS: something bad. ENFORCE: see the README for details.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 0);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].id, /malformed-triple:bad-enforce-ref/);
  });

  test('INVARIANT + BREAKS but no ENFORCE emits finding', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Trap Doors',
      '',
      '- `src/foo.ts` — INVARIANT: foo stays put. BREAKS: chaos ensues.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 0);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].id, /malformed-triple:no-enforce/);
  });

  test('ENFORCE with grep-prefixed command still counts when .test.js ref is present', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Trap Doors',
      '',
      '- `src/foo.ts` — INVARIANT: x is y. BREAKS: z. ENFORCE: `grep -c "foo" extension/src/bin/mux-runner.ts` ≥ 2; extension/tests/foo.test.js.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 1, 'grep-prefixed ENFORCE with trailing .test.js should count');
    assert.equal(result.findings.length, 0);
  });

  test('multiple valid triples counted correctly', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Trap Doors',
      '',
      '- `src/a.ts` — INVARIANT: a. BREAKS: b. ENFORCE: extension/tests/a.test.js.',
      '- `src/b.ts` — INVARIANT: c. BREAKS: d. ENFORCE: extension/tests/b.test.js.',
      '- `src/c.ts` — INVARIANT: e. BREAKS: f. ENFORCE: extension/scripts/check.sh.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(result.declarations, 3);
    assert.equal(result.findings.length, 0);
  });

  // AP-EXT-ITER296-01: an entry is identified by its own SHAPE, never by the heading it sits
  // under. A subject-bearing bullet counts wherever it appears; a `## state.json Field
  // Invariants` bullet leads with the label itself and is excluded wherever IT appears. The
  // heading names below are inert decoration to these assertions — that is the whole point.
  test('AP-EXT-ITER296-01: a subject-bearing entry counts under any heading; a label-leading one counts under none', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const content = [
      '## Other Section',
      '',
      '- `src/foo.ts` — INVARIANT: x. BREAKS: y. ENFORCE: extension/tests/foo.test.js.',
      '',
      '## Trap Doors',
      '',
      '- `src/bar.ts` — INVARIANT: a. BREAKS: b. ENFORCE: extension/tests/bar.test.js.',
      '',
      '## state.json Field Invariants',
      '',
      '- INVARIANT: `active` is liveness. ENFORCE: extension/tests/state-field-invariants.test.js.',
      '',
    ].join('\n');
    const result = parseTrapDoorDeclarations(content);
    assert.equal(
      result.declarations,
      2,
      'both subject-bearing entries count — the one above ## Trap Doors and the one inside it',
    );
    assert.equal(
      result.findings.length,
      0,
      'the label-leading state.json field-invariant bullet is not an entry, so its missing BREAKS is not a finding',
    );
  });

  test('empty content returns zero declarations and zero findings', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const result = parseTrapDoorDeclarations('');
    assert.equal(result.declarations, 0);
    assert.equal(result.findings.length, 0);
  });
});

describe('auditTrapDoorDeclarations — integration: real extension/CLAUDE.md', () => {
  test('counts at least 130 declarations against HEAD', async () => {
    const { auditTrapDoorDeclarations } = await importModule();
    const result = auditTrapDoorDeclarations({ repoRoot: REPO_ROOT });
    assert.ok(
      result.declarations >= 130,
      `Expected >= 130 declarations; got ${result.declarations}`,
    );
  });

  test('0 findings against clean HEAD catalog', async () => {
    const { auditTrapDoorDeclarations } = await importModule();
    const result = auditTrapDoorDeclarations({ repoRoot: REPO_ROOT });
    assert.deepStrictEqual(
      result.findings,
      [],
      `Expected 0 findings; got:\n${result.findings.map((f) => `  ${f.id}: ${f.message}`).join('\n')}`,
    );
  });

  // AP-EXT-ITER296-01: the audit used to cut the catalog at the first `## ` heading after
  // `## Trap Doors`, so every entry a later pass appended below an intervening heading was
  // unexamined while the audit still reported zero findings. Driven over the REAL catalogs
  // rather than a fixture, because the defect was invisible precisely to a fixture that keeps
  // its entries inside the section — the population at risk is the live corpus.
  test('AP-EXT-ITER296-01: entries below the first heading after ## Trap Doors are audited, not cut away', async () => {
    const { parseTrapDoorDeclarations } = await importModule();
    const catalogs = [
      'extension/src/bin/CLAUDE.md',
      'extension/src/services/CLAUDE.md',
      'extension/CLAUDE.md',
    ];

    let totalBelow = 0;
    for (const rel of catalogs) {
      const content = readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      const lines = content.split('\n');
      const trapDoorsIdx = lines.findIndex((l) => /^##\s+Trap Doors\s*$/.test(l));
      assert.ok(trapDoorsIdx !== -1, `${rel} has no ## Trap Doors heading`);
      const cutIdx = lines.findIndex((l, i) => i > trapDoorsIdx && /^##\s+/.test(l));
      assert.ok(cutIdx !== -1, `${rel} has no heading after ## Trap Doors, so it cannot separate`);

      // Everything the OLD slice-based reader could never see.
      const below = lines.slice(cutIdx).join('\n');
      const belowResult = parseTrapDoorDeclarations(below);
      assert.equal(
        belowResult.findings.length,
        0,
        `${rel}: entries below the cut are malformed: ${belowResult.findings
          .map((f) => f.id)
          .join(', ')}`,
      );
      totalBelow += belowResult.declarations;

      // The whole file must account for the below-the-cut entries too, so a reader that
      // silently re-narrows to the section cannot satisfy this.
      const whole = parseTrapDoorDeclarations(content);
      const above = parseTrapDoorDeclarations(lines.slice(0, cutIdx).join('\n'));
      assert.equal(
        whole.declarations,
        above.declarations + belowResult.declarations,
        `${rel}: whole-file count must equal above-cut + below-cut`,
      );
    }

    // Non-vacuity: if these catalogs ever stop carrying below-the-cut entries the assertions
    // above all pass on zero, so pin that the population is real and substantial.
    assert.ok(
      totalBelow >= 100,
      `Expected >= 100 trap-door entries below the cut across the catalogs; got ${totalBelow}`,
    );
  });
});
