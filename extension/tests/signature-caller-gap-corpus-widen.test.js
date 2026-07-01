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

function tmpDir(prefix = 'pickle-sigf-corpus-widen-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function gitRepoWith(files) {
  const repoRoot = tmpDir('pickle-sigf-corpus-widen-repo-');
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

test('detects an out-of-fence production caller and skips the same caller when it is co-scoped', async () => {
  const { createResolverCache, detectSignatureCallerGaps } = await import(MODULE);
  const repoRoot = gitRepoWith({
    'src/foo-service.ts': 'export class FooService { constructor(a, b) {} }\n',
    'src/foo-controller.ts': "import { FooService } from './foo-service';\nexport const controller = () => new FooService(1, 2);\n",
    'src/foo-service.spec.ts': "import { FooService } from './foo-service';\nconst svc = new FooService(1, 2);\n",
  });
  const ticketContents = [ticket(['# Add a 3rd constructor parameter to FooService'])];
  try {
    const outOfFenceCache = createResolverCache(repoRoot, 5000);
    const outOfFence = detectSignatureCallerGaps({
      ticketContents,
      declaredFiles: new Set(['src/foo-service.ts']),
      repoRoot,
      cache: outOfFenceCache,
    });
    assert.deepEqual(outOfFence, [{
      symbol: 'FooService',
      kind: 'arity',
      outOfScopeCallers: ['src/foo-controller.ts', 'src/foo-service.spec.ts'],
    }]);

    const inFenceCache = createResolverCache(repoRoot, 5000);
    const inFence = detectSignatureCallerGaps({
      ticketContents,
      declaredFiles: new Set(['src/foo-service.ts', 'src/foo-controller.ts', 'src/foo-service.spec.ts']),
      repoRoot,
      cache: inFenceCache,
    });
    assert.deepEqual(inFence, []);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('caps widened candidates deterministically and truncates immediately on an expired deadline', async () => {
  const { CALLER_CANDIDATE_MAX, createResolverCache, detectSignatureCallerGaps } = await import(MODULE);
  const files = {
    'src/foo-service.ts': 'export class FooService { constructor(a, b) {} }\n',
  };
  for (let i = 0; i < CALLER_CANDIDATE_MAX + 20; i++) {
    files[`src/caller-${String(i).padStart(4, '0')}.ts`] =
      "import { FooService } from './foo-service';\nexport const make = () => new FooService(1, 2);\n";
  }
  const repoRoot = gitRepoWith(files);
  const ticketContents = [ticket(['# Add a 3rd constructor parameter to FooService'])];
  try {
    const stableA = createResolverCache(repoRoot, 5000);
    const stableB = createResolverCache(repoRoot, 5000);
    const first = detectSignatureCallerGaps({
      ticketContents,
      declaredFiles: new Set(['src/foo-service.ts']),
      repoRoot,
      cache: stableA,
    });
    const second = detectSignatureCallerGaps({
      ticketContents,
      declaredFiles: new Set(['src/foo-service.ts']),
      repoRoot,
      cache: stableB,
    });
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0].outOfScopeCallers.length, CALLER_CANDIDATE_MAX, 'first call must cap the candidate corpus');
    assert.deepEqual(first[0].outOfScopeCallers, second[0].outOfScopeCallers, 'git-ordered corpus must be deterministic across calls');

    const expired = createResolverCache(repoRoot, 5000);
    expired.deadline = Date.now() - 1;
    const gaps = detectSignatureCallerGaps({
      ticketContents,
      declaredFiles: new Set(['src/foo-service.ts']),
      repoRoot,
      cache: expired,
    });
    assert.deepEqual(gaps, []);
    assert.equal(expired.truncated, true);
    assert.deepEqual([...expired.fileContents.keys()], [], 'expired deadline must stop before reading widened candidates');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
