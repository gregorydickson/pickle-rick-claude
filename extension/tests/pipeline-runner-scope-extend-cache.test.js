// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { computeScopeAutoExtension } from '../bin/pipeline-runner.js';

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sigf-scope-cache-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 'T']);
  return repo;
}

function writeTracked(repo, rel, body) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  git(repo, ['add', rel]);
}

const ARITY_TICKET = [
  'Add a new constructor parameter to `FooService`.',
  'This adds a new injected dependency to the FooService constructor.',
].join('\n');

test('computeScopeAutoExtension threads a cache so an expired build-path deadline returns unchanged without candidate reads', () => {
  const repo = makeRepo();
  writeTracked(repo, 'src/foo-service.ts', 'export class FooService { constructor(a, b) {} }\n');
  writeTracked(
    repo,
    'src/foo-controller.ts',
    'import { FooService } from "./foo-service";\nexport const controller = () => new FooService(1, 2);\n',
  );
  git(repo, ['commit', '-qm', 'fixture']);

  const realNow = Date.now;
  let nowCalls = 0;
  try {
    Date.now = () => {
      nowCalls += 1;
      return nowCalls === 1 ? 0 : 120_001;
    };
    const result = computeScopeAutoExtension(['src/foo-service.ts'], [ARITY_TICKET], new Set(['src/foo-service.ts']), repo);
    assert.equal(result.changed, false);
    assert.equal(result.capHit, false);
    assert.deepEqual(result.allowedPaths, ['src/foo-service.ts']);
    assert.deepEqual(result.addedPaths, []);
    assert.deepEqual(result.symbols, []);
  } finally {
    Date.now = realNow;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
