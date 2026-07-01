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

function tmpDir(prefix = 'pickle-sigf-bridge-forms-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function gitRepoWith(files) {
  const repoRoot = tmpDir('pickle-sigf-bridge-forms-repo-');
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

function ticket(lines) {
  return lines.join('\n');
}

async function detectBridgeGap(factorySource, callerSource) {
  const { detectSignatureCallerGaps, createResolverCache } = await import(MODULE);
  const repoRoot = gitRepoWith({
    'src/threshold-schema.ts': "import { z } from 'zod';\nexport const thresholdSchema = z.object({ ltv: z.number() });\n",
    'src/facts-factory.ts': factorySource,
    'src/underwrite.spec.ts': callerSource,
  });
  try {
    const cache = createResolverCache(repoRoot, 5000);
    return detectSignatureCallerGaps({
      ticketContents: [ticket(['# Add a required `dti` field to thresholdSchema', '', 'Adds a new required field to the `thresholdSchema` shape.'])],
      declaredFiles: new Set(['src/facts-factory.ts', 'src/threshold-schema.ts']),
      repoRoot,
      cache,
    });
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

const bridgeForms = [
  {
    name: 'export default function',
    factorySource: [
      "import { thresholdSchema } from './threshold-schema';",
      'export default function makeFacts(input) {',
      '  return thresholdSchema.parse(input);',
      '}',
      '',
    ].join('\n'),
    callerSource: "import makeFacts from './facts-factory';\nconst f = makeFacts({ ltv: 80 });\n",
  },
  {
    name: 'export class',
    factorySource: [
      "import { thresholdSchema } from './threshold-schema';",
      'export class FactsFactory {',
      '  constructor(input) {',
      '    this.value = thresholdSchema.parse(input);',
      '  }',
      '}',
      '',
    ].join('\n'),
    callerSource: "import { FactsFactory } from './facts-factory';\nconst f = new FactsFactory({ ltv: 80 });\n",
  },
  {
    name: 'export list',
    factorySource: [
      "import { thresholdSchema } from './threshold-schema';",
      'function makeFacts(input) {',
      '  return thresholdSchema.parse(input);',
      '}',
      'export { makeFacts };',
      '',
    ].join('\n'),
    callerSource: "import { makeFacts } from './facts-factory';\nconst f = makeFacts({ ltv: 80 });\n",
  },
  {
    name: 'export list alias',
    factorySource: [
      "import { thresholdSchema } from './threshold-schema';",
      'function makeFacts(input) {',
      '  return thresholdSchema.parse(input);',
      '}',
      'export { makeFacts as makeF };',
      '',
    ].join('\n'),
    callerSource: "import { makeF } from './facts-factory';\nconst f = makeF({ ltv: 80 });\n",
  },
];

for (const form of bridgeForms) {
  test(`detects schema-shape gaps through ${form.name} bridge declarations`, async () => {
    const gaps = await detectBridgeGap(form.factorySource, form.callerSource);
    const schemaGaps = gaps.filter((gap) => gap.kind === 'schema-shape' && gap.symbol === 'thresholdSchema');
    assert.equal(schemaGaps.length, 1, `expected one schema-shape gap for ${form.name}; got ${JSON.stringify(gaps)}`);
    assert.ok(
      schemaGaps[0].outOfScopeCallers.includes('src/underwrite.spec.ts'),
      `out-of-fence caller must be named for ${form.name}; got ${JSON.stringify(schemaGaps[0].outOfScopeCallers)}`,
    );
  });
}

test('control: export default function without the changed schema reference is not harvested', async () => {
  const { detectSignatureCallerGaps, createResolverCache } = await import(MODULE);
  const repoRoot = gitRepoWith({
    'src/threshold-schema.ts': "import { z } from 'zod';\nexport const thresholdSchema = z.object({ ltv: z.number() });\n",
    'src/facts-factory.ts': [
      'export default function makeFacts(input) {',
      '  return input;',
      '}',
      '',
    ].join('\n'),
    'src/underwrite.spec.ts': "import makeFacts from './facts-factory';\nconst f = makeFacts({ ltv: 80 });\n",
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
    assert.deepEqual(schemaGaps, [], `unrelated default export must not be harvested; got ${JSON.stringify(gaps)}`);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
