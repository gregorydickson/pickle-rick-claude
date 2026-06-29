// @tier: fast
// R-SIGF WS-2 (LOA-1363): the shared signature-caller-gap detector must recognize
// schema-SHAPE changes (a breaking field add/change to a `<Name>Schema` symbol) and
// emit CallerGap entries with `kind:'schema-shape'` for BOTH direct consumers
// (`<Schema>.parse(`, `.safeParse(`, `z.infer<typeof <Schema>>`) AND factory-mediated
// consumers (an out-of-fence caller of an in-fence factory that references the schema —
// the `makeFacts({...})`→`thresholdSchema` zero-lexical-overlap repro).
// Tested DIRECTLY against the shared module; the blocking routing (T2) is out of scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(__dirname, '../services/signature-caller-gap.js');

function tmpDir(prefix = 'pickle-sigf-ws2-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function gitRepoWith(files) {
  const repoRoot = tmpDir('pickle-sigf-ws2-repo-');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.email', 'sigf@example.com'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.name', 'sigf'], { cwd: repoRoot });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  spawnSync('git', ['add', '-A'], { cwd: repoRoot });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });
  return repoRoot;
}

const ticket = (lines) => lines.join('\n');

// AC-SIGF-4: factory-mediated recall. The caller is git-TRACKED and OUT-of-fence;
// the factory `makeFacts` is in-fence and references `thresholdSchema` (zero lexical
// overlap between caller text and the schema symbol).
test('R-SIGF WS-2 AC-SIGF-4: factory-mediated consumer of a changed schema is detected (kind schema-shape)', async () => {
  const { detectSignatureCallerGaps, createResolverCache } = await import(MODULE);
  const repoRoot = gitRepoWith({
    // in-fence factory: references thresholdSchema, exports makeFacts
    'src/facts-factory.ts': [
      "import { thresholdSchema } from './threshold-schema';",
      'export function makeFacts(input) {',
      '  return thresholdSchema.parse(input);',
      '}',
      '',
    ].join('\n'),
    'src/threshold-schema.ts': "import { z } from 'zod';\nexport const thresholdSchema = z.object({ ltv: z.number() });\n",
    // out-of-fence git-TRACKED caller: only mentions makeFacts — NO 'thresholdSchema' token
    'src/underwrite.spec.ts': "import { makeFacts } from './facts-factory';\nconst f = makeFacts({ ltv: 80 });\n",
  });
  try {
    const cache = createResolverCache(repoRoot, 5000);
    const declaredFiles = new Set(['src/facts-factory.ts', 'src/threshold-schema.ts']);
    const content = ticket([
      '# Add a required `dti` field to thresholdSchema',
      '',
      'Adds a new required field to the `thresholdSchema` shape.',
    ]);
    const gaps = detectSignatureCallerGaps({ ticketContents: [content], declaredFiles, repoRoot, cache });
    const schemaGaps = gaps.filter((g) => g.kind === 'schema-shape' && g.symbol === 'thresholdSchema');
    assert.equal(schemaGaps.length, 1, `expected one schema-shape gap for thresholdSchema; got ${JSON.stringify(gaps)}`);
    assert.ok(
      schemaGaps[0].outOfScopeCallers.some((f) => /underwrite\.spec\.ts$/.test(f)),
      `factory-mediated caller must be named; got ${JSON.stringify(schemaGaps[0].outOfScopeCallers)}`,
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// AC-SIGF-4: direct consumer recall (`<Schema>.parse(` / `.safeParse(`).
test('R-SIGF WS-2 AC-SIGF-4: direct .parse/.safeParse consumer of a changed schema is detected', async () => {
  const { detectSignatureCallerGaps, createResolverCache } = await import(MODULE);
  const repoRoot = gitRepoWith({
    'src/loan-schema.ts': "import { z } from 'zod';\nexport const loanSchema = z.object({ amount: z.number() });\n",
    // out-of-fence direct consumers, git-tracked
    'src/loan-parse.spec.ts': "import { loanSchema } from './loan-schema';\nconst a = loanSchema.parse({ amount: 1 });\n",
    'src/loan-builder.ts': "import { loanSchema } from './loan-schema';\nexport const b = loanSchema.safeParse({ amount: 2 });\n",
  });
  try {
    const cache = createResolverCache(repoRoot, 5000);
    const declaredFiles = new Set(['src/loan-schema.ts']);
    const content = ticket([
      '# Change the `amount` field type on loanSchema',
      '',
      'Changes a required property on the `loanSchema` shape.',
    ]);
    const gaps = detectSignatureCallerGaps({ ticketContents: [content], declaredFiles, repoRoot, cache });
    const schemaGaps = gaps.filter((g) => g.kind === 'schema-shape' && g.symbol === 'loanSchema');
    assert.equal(schemaGaps.length, 1, `expected one schema-shape gap; got ${JSON.stringify(gaps)}`);
    const callers = schemaGaps[0].outOfScopeCallers;
    assert.ok(callers.some((f) => /loan-parse\.spec\.ts$/.test(f)), 'direct .parse caller must be named');
    assert.ok(callers.some((f) => /loan-builder\.ts$/.test(f)), 'direct .safeParse caller (builder corpus) must be named');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// AC-SIGF-4b (no false positive): a new OPTIONAL field is a compatible change → no gap.
test('R-SIGF WS-2 AC-SIGF-4b: a new OPTIONAL field (compatible change) is NOT detected', async () => {
  const { detectSignatureCallerGaps, createResolverCache } = await import(MODULE);
  const repoRoot = gitRepoWith({
    'src/quote-schema.ts': "import { z } from 'zod';\nexport const quoteSchema = z.object({ rate: z.number() });\n",
    'src/quote.spec.ts': "import { quoteSchema } from './quote-schema';\nconst q = quoteSchema.parse({ rate: 5 });\n",
  });
  try {
    const cache = createResolverCache(repoRoot, 5000);
    const declaredFiles = new Set(['src/quote-schema.ts']);
    const content = ticket([
      '# Add a new optional `memo` field to quoteSchema',
      '',
      'Adds a new optional field to the `quoteSchema` shape (backward-compatible).',
    ]);
    const gaps = detectSignatureCallerGaps({ ticketContents: [content], declaredFiles, repoRoot, cache });
    const schemaGaps = gaps.filter((g) => g.kind === 'schema-shape');
    assert.deepEqual(schemaGaps, [], `optional-field change must emit no schema-shape gap; got ${JSON.stringify(schemaGaps)}`);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// AC-SIGF-4b (no false positive): a consumer that merely IMPORTS the type without
// consuming the changed shape (no .parse(/factory call) → no gap.
test('R-SIGF WS-2 AC-SIGF-4b: a type-only importer that does not consume the shape is NOT detected', async () => {
  const { detectSignatureCallerGaps, createResolverCache } = await import(MODULE);
  const repoRoot = gitRepoWith({
    'src/policy-schema.ts': "import { z } from 'zod';\nexport const policySchema = z.object({ term: z.number() });\nexport type Policy = z.infer<typeof policySchema>;\n",
    // imports the TYPE only; never calls .parse/.safeParse, never a factory
    'src/policy.spec.ts': "import type { Policy } from './policy-schema';\nconst p = null;\n",
  });
  try {
    const cache = createResolverCache(repoRoot, 5000);
    const declaredFiles = new Set(['src/policy-schema.ts']);
    const content = ticket([
      '# Change the `term` field on policySchema',
      '',
      'Changes a required property on the `policySchema` shape.',
    ]);
    const gaps = detectSignatureCallerGaps({ ticketContents: [content], declaredFiles, repoRoot, cache });
    const schemaGaps = gaps.filter((g) => g.kind === 'schema-shape');
    assert.deepEqual(schemaGaps, [], `type-only importer must emit no schema-shape gap; got ${JSON.stringify(schemaGaps)}`);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// AC-SIGF-5: wall budget. A large corpus returns within the ResolverCache deadline and
// does not throw; the schema-shape gap is still detected.
test('R-SIGF WS-2 AC-SIGF-5: large fixture returns within the ResolverCache wall budget', async () => {
  const { detectSignatureCallerGaps, createResolverCache } = await import(MODULE);
  const files = {
    'src/big-schema.ts': "import { z } from 'zod';\nexport const bigSchema = z.object({ a: z.number() });\n",
    'src/big.spec.ts': "import { bigSchema } from './big-schema';\nconst x = bigSchema.parse({ a: 1 });\n",
  };
  // Pad the corpus with many tracked spec/factory files to make the scan non-trivial.
  for (let i = 0; i < 120; i++) {
    files[`src/noise-${i}.spec.ts`] = `// unrelated spec ${i}\nconst v${i} = ${i};\nexport const k${i} = v${i};\n`;
    files[`src/noise-factory-${i}.ts`] = `// unrelated factory ${i}\nexport function makeNoise${i}() { return ${i}; }\n`;
  }
  const repoRoot = gitRepoWith(files);
  try {
    const maxWallMs = 5000;
    const cache = createResolverCache(repoRoot, maxWallMs);
    const declaredFiles = new Set(['src/big-schema.ts']);
    const content = ticket([
      '# Change the `a` field on bigSchema',
      '',
      'Changes a required property on the `bigSchema` shape.',
    ]);
    const start = Date.now();
    const gaps = detectSignatureCallerGaps({ ticketContents: [content], declaredFiles, repoRoot, cache });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < maxWallMs, `scan must return within the wall budget (${maxWallMs}ms); took ${elapsed}ms`);
    const schemaGaps = gaps.filter((g) => g.kind === 'schema-shape' && g.symbol === 'bigSchema');
    assert.equal(schemaGaps.length, 1, `expected the schema-shape gap to still be detected; got ${JSON.stringify(gaps)}`);
    assert.ok(schemaGaps[0].outOfScopeCallers.some((f) => /big\.spec\.ts$/.test(f)), 'big.spec.ts must be flagged');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
