// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(__dirname, '../services/signature-caller-gap.js');

function tmpDir(prefix = 'pickle-sigf-deadline-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function gitRepoWith(files) {
  const repoRoot = tmpDir('pickle-sigf-deadline-repo-');
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

test('deadline truncates the arity scan before any candidate file is read', async () => {
  const { createResolverCache, detectSignatureCallerGaps } = await import(MODULE);
  const repoRoot = gitRepoWith({
    'src/widget-service.ts': 'export class WidgetService { constructor(a, b) {} }\n',
    'src/widget-service.spec.ts': "import { WidgetService } from './widget-service';\nconst s = new WidgetService(1, 2);\n",
    'src/widget-factory.ts': "export function buildWidget() { return new WidgetService(1, 2); }\n",
  });
  try {
    const cache = createResolverCache(repoRoot, 5000);
    cache.deadline = Date.now() - 1;
    const gaps = detectSignatureCallerGaps({
      ticketContents: [ticket(['# Add a 3rd constructor parameter to WidgetService'])],
      declaredFiles: new Set(['src/widget-service.ts']),
      repoRoot,
      cache,
    });
    assert.deepEqual(gaps, []);
    assert.equal(cache.truncated, true);
    assert.deepEqual([...cache.fileContents.keys()], [], 'expired deadline must stop before reading any candidate file');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('deadline truncates the schema-shape scan before any candidate file is read', async () => {
  const { createResolverCache, detectSignatureCallerGaps } = await import(MODULE);
  const repoRoot = gitRepoWith({
    'src/loan-schema.ts': "import { z } from 'zod';\nexport const loanSchema = z.object({ amount: z.number() });\n",
    'src/loan-parse.spec.ts': "import { loanSchema } from './loan-schema';\nconst a = loanSchema.parse({ amount: 1 });\n",
    'src/loan-builder.ts': "import { loanSchema } from './loan-schema';\nexport const b = loanSchema.safeParse({ amount: 2 });\n",
  });
  try {
    const cache = createResolverCache(repoRoot, 5000);
    cache.deadline = Date.now() - 1;
    const gaps = detectSignatureCallerGaps({
      ticketContents: [ticket(['# Change the `amount` field type on loanSchema', '', 'Changes a required property on the `loanSchema` shape.'])],
      declaredFiles: new Set(['src/loan-schema.ts']),
      repoRoot,
      cache,
    });
    assert.deepEqual(gaps, []);
    assert.equal(cache.truncated, true);
    assert.deepEqual([...cache.fileContents.keys()], [], 'expired deadline must stop before reading any schema candidate file');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('deadline returns partial arity findings and stops before later candidate reads', async () => {
  const { createResolverCache, detectSignatureCallerGaps } = await import(MODULE);
  const repoRoot = gitRepoWith({
    'src/widget-service.ts': 'export class WidgetService { constructor(a, b) {} }\n',
    'src/a-widget.spec.ts': "import { WidgetService } from './widget-service';\nconst a = new WidgetService(1, 2);\n",
    'src/b-widget.spec.ts': "import { WidgetService } from './widget-service';\nconst b = new WidgetService(3, 4);\n",
  });
  const realNow = Date.now;
  let nowCalls = 0;
  try {
    const cache = createResolverCache(repoRoot, 5000);
    cache.deadline = 100;
    Date.now = () => {
      nowCalls += 1;
      return nowCalls === 1 ? 99 : 101;
    };
    const gaps = detectSignatureCallerGaps({
      ticketContents: [ticket(['# Add a 3rd constructor parameter to WidgetService'])],
      declaredFiles: new Set(['src/widget-service.ts']),
      repoRoot,
      cache,
    });
    assert.deepEqual(gaps, [{
      symbol: 'WidgetService',
      kind: 'arity',
      outOfScopeCallers: ['src/a-widget.spec.ts'],
    }]);
    assert.equal(cache.truncated, true);
    assert.deepEqual(
      [...cache.fileContents.keys()].map((file) => path.relative(repoRoot, file)),
      ['src/a-widget.spec.ts'],
      'deadline must stop before reading later candidate files once a partial finding exists',
    );
  } finally {
    Date.now = realNow;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('future deadline preserves detection and leaves the cache untruncated', async () => {
  const { createResolverCache, detectSignatureCallerGaps } = await import(MODULE);
  const repoRoot = gitRepoWith({
    'src/threshold-schema.ts': "import { z } from 'zod';\nexport const thresholdSchema = z.object({ ltv: z.number() });\n",
    'src/facts-factory.ts': [
      "import { thresholdSchema } from './threshold-schema';",
      'export function makeFacts(input) {',
      '  return thresholdSchema.parse(input);',
      '}',
      '',
    ].join('\n'),
    'src/underwrite.spec.ts': "import { makeFacts } from './facts-factory';\nconst f = makeFacts({ ltv: 80 });\n",
  });
  try {
    const cache = createResolverCache(repoRoot, 5000);
    const gaps = detectSignatureCallerGaps({
      ticketContents: [ticket(['# Add a required `dti` field to thresholdSchema', '', 'Adds a new required field to the `thresholdSchema` shape.'])],
      declaredFiles: new Set(['src/facts-factory.ts', 'src/threshold-schema.ts']),
      repoRoot,
      cache,
    });
    const schemaGaps = gaps.filter((gap) => gap.kind === 'schema-shape' && gap.symbol === 'thresholdSchema');
    assert.equal(schemaGaps.length, 1, `expected one schema-shape gap; got ${JSON.stringify(gaps)}`);
    assert.deepEqual(schemaGaps[0].outOfScopeCallers, ['src/underwrite.spec.ts']);
    assert.equal(cache.truncated, false);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
