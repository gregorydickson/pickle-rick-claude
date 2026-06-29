// @tier: integration
// Ticket 0b9b2319 (WS-3): bounded, opt-in build-phase scope auto-extension.
// Covers AC-SIGF-6 (resolver), AC-SIGF-6e (paths-mode merge / flag-off / diff-mode),
// AC-SIGF-6b (over-cap extends nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { resolveScopeSettings } from '../services/pickle-utils.js';
import {
  computeScopeAutoExtension,
  maybeAutoExtendScope,
  SCOPE_AUTO_EXTEND_MAX,
  scopeByteOrder,
} from '../bin/pipeline-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const DEPLOYED_SETTINGS = require('../../pickle_settings.json');

// ---------------------------------------------------------------------------
// AC-SIGF-6: resolver
// ---------------------------------------------------------------------------

test('AC-SIGF-6: resolveScopeSettings defaults false on absent/empty/malformed', () => {
  assert.equal(resolveScopeSettings(undefined).autoExtendSignatureCallers, false);
  assert.equal(resolveScopeSettings(null).autoExtendSignatureCallers, false);
  assert.equal(resolveScopeSettings({}).autoExtendSignatureCallers, false);
  assert.equal(resolveScopeSettings({ scope: {} }).autoExtendSignatureCallers, false);
  assert.equal(resolveScopeSettings({ scope: [] }).autoExtendSignatureCallers, false);
  assert.equal(
    resolveScopeSettings({ scope: { auto_extend_signature_callers: 'yes' } }).autoExtendSignatureCallers,
    false,
    'non-boolean is malformed → default false',
  );
  assert.equal(
    resolveScopeSettings({ scope: { auto_extend_signature_callers: 1 } }).autoExtendSignatureCallers,
    false,
  );
});

test('AC-SIGF-6: resolveScopeSettings returns configured boolean', () => {
  assert.equal(
    resolveScopeSettings({ scope: { auto_extend_signature_callers: true } }).autoExtendSignatureCallers,
    true,
  );
  assert.equal(
    resolveScopeSettings({ scope: { auto_extend_signature_callers: false } }).autoExtendSignatureCallers,
    false,
  );
});

test('AC-SIGF-6: deployed pickle_settings.json defaults scope auto-extend OFF', () => {
  assert.equal(
    resolveScopeSettings(DEPLOYED_SETTINGS).autoExtendSignatureCallers,
    false,
    'deployed pickle_settings.json must default scope.auto_extend_signature_callers to false',
  );
});

test('AC-SIGF-6b: SCOPE_AUTO_EXTEND_MAX is 8', () => {
  assert.equal(SCOPE_AUTO_EXTEND_MAX, 8);
});

test('scopeByteOrder sorts locale-independently', () => {
  assert.deepEqual(['b', 'A', 'a'].sort(scopeByteOrder), ['A', 'a', 'b']);
});

// ---------------------------------------------------------------------------
// Git fixture: a repo whose out-of-fence factory/spec files construct services
// the ticket claims to change the arity of.
// ---------------------------------------------------------------------------

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sigf-scope-repo-'));
  git(repo, ['init', '-q']);
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

// ---------------------------------------------------------------------------
// AC-SIGF-6e: paths-mode merge — named callers land in allowed_paths.
// ---------------------------------------------------------------------------

test('AC-SIGF-6e: merge adds detector-named out-of-fence callers, byte-sorted + deduped', () => {
  const repo = makeRepo();
  writeTracked(repo, 'src/foo-service.ts', 'export class FooService { constructor() {} }\n');
  writeTracked(
    repo,
    'tests/foo.factory.ts',
    'import { FooService } from "../src/foo-service";\nexport const makeFoo = () => new FooService();\n',
  );
  git(repo, ['commit', '-qm', 'fixture']);

  const allowed = ['src/foo-service.ts'];
  const declared = new Set(['src/foo-service.ts']); // caller is OUT of fence
  const r = computeScopeAutoExtension(allowed, [ARITY_TICKET], declared, repo);

  assert.equal(r.capHit, false);
  assert.equal(r.changed, true);
  assert.ok(r.allowedPaths.includes('tests/foo.factory.ts'), 'named caller merged in');
  assert.deepEqual(r.allowedPaths, [...r.allowedPaths].sort(scopeByteOrder), 'byte-sorted');
  assert.equal(new Set(r.allowedPaths).size, r.allowedPaths.length, 'deduped');
  assert.deepEqual(r.addedPaths, ['tests/foo.factory.ts']);
  assert.ok(r.symbols.includes('FooService'));
});

test('AC-SIGF-6e: never adds a path the detector did not name', () => {
  const repo = makeRepo();
  writeTracked(repo, 'src/foo-service.ts', 'export class FooService {}\n');
  writeTracked(repo, 'tests/bar.factory.ts', 'export const x = 1;\n');
  git(repo, ['commit', '-qm', 'fixture']);

  const r = computeScopeAutoExtension(['src/foo-service.ts'], [ARITY_TICKET], new Set(['src/foo-service.ts']), repo);
  assert.equal(r.changed, false, 'no named callers → no extension');
  assert.equal(r.capHit, false);
});

test('AC-SIGF-6e: an in-fence declared caller is not added (detector skips bundle-scope callers)', () => {
  const repo = makeRepo();
  writeTracked(repo, 'src/foo-service.ts', 'export class FooService {}\n');
  writeTracked(
    repo,
    'tests/foo.factory.ts',
    'import { FooService } from "../src/foo-service";\nexport const f = () => new FooService();\n',
  );
  git(repo, ['commit', '-qm', 'fixture']);

  const allowed = ['src/foo-service.ts', 'tests/foo.factory.ts'];
  const declared = new Set(['src/foo-service.ts', 'tests/foo.factory.ts']);
  const r = computeScopeAutoExtension(allowed, [ARITY_TICKET], declared, repo);
  assert.equal(r.changed, false);
  assert.deepEqual(r.allowedPaths, allowed);
});

// ---------------------------------------------------------------------------
// AC-SIGF-6b: over-cap → allowed_paths UNCHANGED, cap_hit true.
// ---------------------------------------------------------------------------

test('AC-SIGF-6b: over-cap extends nothing (allowed_paths unchanged, cap_hit true)', () => {
  const repo = makeRepo();
  writeTracked(repo, 'src/foo-service.ts', 'export class FooService {}\n');
  for (let i = 0; i < 9; i++) {
    writeTracked(
      repo,
      `tests/caller${i}.factory.ts`,
      'import { FooService } from "../src/foo-service";\nexport const f = () => new FooService();\n',
    );
  }
  git(repo, ['commit', '-qm', 'fixture']);

  const allowed = ['src/foo-service.ts'];
  const r = computeScopeAutoExtension(allowed, [ARITY_TICKET], new Set(['src/foo-service.ts']), repo);
  assert.equal(r.capHit, true, 'cap hit on 10 > 8');
  assert.equal(r.changed, false);
  assert.deepEqual(r.allowedPaths, allowed, 'over-cap → allowed_paths UNCHANGED (no partial extend)');
  assert.deepEqual(r.addedPaths, [], 'no partial extend');
});

test('AC-SIGF-6b: exactly at the cap still extends (boundary)', () => {
  const repo = makeRepo();
  writeTracked(repo, 'src/foo-service.ts', 'export class FooService {}\n');
  for (let i = 0; i < 7; i++) {
    writeTracked(
      repo,
      `tests/at${i}.factory.ts`,
      'import { FooService } from "../src/foo-service";\nexport const f = () => new FooService();\n',
    );
  }
  git(repo, ['commit', '-qm', 'fixture']);

  const r = computeScopeAutoExtension(['src/foo-service.ts'], [ARITY_TICKET], new Set(['src/foo-service.ts']), repo);
  assert.equal(r.capHit, false, '8 == cap is not over-cap');
  assert.equal(r.changed, true);
  assert.equal(r.allowedPaths.length, 8);
});

// ---------------------------------------------------------------------------
// AC-SIGF-6e: diff/branch-mode no-op + flag-off (deployed default); best-effort.
// ---------------------------------------------------------------------------

function makeSession() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sigf-scope-sess-'));
}

function diffScope(allowed) {
  return {
    version: 1,
    mode: 'diff',
    strategy: 'strict',
    base_ref: 'main',
    base_sha: 'def456',
    head_sha: 'abc123',
    allowed_paths: allowed,
    resolved_at: new Date().toISOString(),
    refresh_history: [],
  };
}

function pathsScope(allowed) {
  return { ...diffScope(allowed), mode: 'paths', base_ref: null, base_sha: null };
}

test('AC-SIGF-6e: diff-mode is a no-op (no synthesis at setup)', () => {
  const session = makeSession();
  const scope = diffScope(['src/foo-service.ts']);
  maybeAutoExtendScope(session, process.cwd(), scope, () => {});
  assert.deepEqual(scope.allowed_paths, ['src/foo-service.ts'], 'diff-mode → unchanged');
});

test('AC-SIGF-6e: flag-off (deployed default) leaves paths-mode allowed_paths unchanged', () => {
  const session = makeSession();
  const scope = pathsScope(['src/foo-service.ts']);
  maybeAutoExtendScope(session, process.cwd(), scope, () => {});
  assert.deepEqual(scope.allowed_paths, ['src/foo-service.ts'], 'flag-off → unchanged');
});

test('maybeAutoExtendScope never throws on a bad session/repo dir (best-effort)', () => {
  const scope = pathsScope(['src/x.ts']);
  assert.doesNotThrow(() =>
    maybeAutoExtendScope('/nonexistent/session/dir', '/nonexistent/repo', scope, () => {}),
  );
});
