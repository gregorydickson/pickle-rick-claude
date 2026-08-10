// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(extensionRoot, 'bin', 'check-scope-diff.js');

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-scope-diff-')));
}

function writeScopeJson(dir, allowedPaths) {
  const scopePath = path.join(dir, 'scope.json');
  fs.writeFileSync(scopePath, JSON.stringify({ allowed_paths: allowedPaths }));
  return scopePath;
}

// Helper: run check-scope-diff.js with --scope-json and optional extra args
function runScript(args = [], opts = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf-8',
    // 10s → 60s: check-scope-diff.js spawns git internally; under 8-way
    // full-suite load the node spawn + module load + git starve past 10s,
    // so the outer spawnSync SIGKILLs the script before it emits its
    // structured error. Fast-path cases still exit in well under a second.
    timeout: 60_000,
    ...opts,
  });
}

test('check-scope-diff-preflight: (a) all staged paths inside allowlist → exit 0', () => {
  const tmp = makeTmp();
  try {
    // Create a fake git repo with staged files
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });

    // Create a file inside the allowed path
    fs.mkdirSync(path.join(tmp, 'extension', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'foo.ts'), 'export {};');
    spawnSync('git', ['add', 'extension/src/foo.ts'], { cwd: tmp });

    const scopePath = writeScopeJson(tmp, ['extension/src']);
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'ok');
    assert.equal(output.staged_count, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('check-scope-diff-preflight: (b) one path outside allowlist → exit 1 + structured error', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });

    // Create one in-scope and one out-of-scope file
    fs.mkdirSync(path.join(tmp, 'extension', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'bar.ts'), 'export {};');
    fs.writeFileSync(path.join(tmp, 'unrelated', 'leaked.ts'), 'export {};');
    spawnSync('git', ['add', 'extension/src/bar.ts', 'unrelated/leaked.ts'], { cwd: tmp });

    const scopePath = writeScopeJson(tmp, ['extension/src']);
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'outside_scope');
    assert.ok(Array.isArray(output.staged_paths_outside_scope), 'staged_paths_outside_scope must be array');
    assert.ok(output.staged_paths_outside_scope.includes('unrelated/leaked.ts'), 'outside-scope path must appear in output');
    assert.equal(typeof output.scope_json_path, 'string');
    assert.equal(typeof output.head_ref, 'string');
    assert.equal(typeof output.suggested_remediation, 'string');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('check-scope-diff-preflight: (c) no scope.json → exit 0 (no-op)', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });

    // Pass a path that does not exist
    const missingScope = path.join(tmp, 'nonexistent-scope.json');
    const result = runScript(['--scope-json', missingScope], { cwd: tmp });

    assert.equal(result.status, 0, `expected exit 0 (no-op), got ${result.status}. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'no_scope');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('check-scope-diff-preflight: (d) malformed scope.json → exit 2 + clear error', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });

    const scopePath = path.join(tmp, 'scope.json');
    fs.writeFileSync(scopePath, '{ not valid json !!!');
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 2, `expected exit 2, got ${result.status}. stdout: ${result.stdout}`);
    const errOutput = JSON.parse(result.stderr.trim());
    assert.equal(errOutput.status, 'malformed_scope');
    assert.equal(typeof errOutput.error, 'string');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('check-scope-diff-preflight: (b-variant) missing allowed_paths field → exit 2 + clear error', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });

    const scopePath = path.join(tmp, 'scope.json');
    fs.writeFileSync(scopePath, JSON.stringify({ version: 1 })); // no allowed_paths
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 2, `expected exit 2, got ${result.status}`);
    const errOutput = JSON.parse(result.stderr.trim());
    assert.equal(errOutput.status, 'malformed_scope');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('check-scope-diff-preflight: no staged files with scope.json → exit 0 with staged_count 0', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });

    // No files staged
    const scopePath = writeScopeJson(tmp, ['extension/src']);
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'ok');
    assert.equal(output.staged_count, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('R-TDCS #128: a subsystem CLAUDE.md outside allowed_paths is NOT a scope violation (anatomy-park catalog deliverable)', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    // The trap-door catalog file lives OUTSIDE the feature diff (allowed_paths).
    fs.mkdirSync(path.join(tmp, 'src', 'modules', 'bank-statement'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'modules', 'bank-statement', 'CLAUDE.md'), '## Trap Doors\n- new invariant\n');
    spawnSync('git', ['add', 'src/modules/bank-statement/CLAUDE.md'], { cwd: tmp });

    const scopePath = writeScopeJson(tmp, ['src/modules/bank-statement/service.ts']); // CLAUDE.md NOT listed
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 0, `expected exit 0 (CLAUDE.md exempt), got ${result.status}. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'ok');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('R-TDCS #128: an out-of-scope source file IS still flagged even when staged alongside a CLAUDE.md (fence on source intact)', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    fs.mkdirSync(path.join(tmp, 'src', 'modules', 'bank-statement'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'modules', 'bank-statement', 'CLAUDE.md'), '## Trap Doors\n- x\n');
    fs.mkdirSync(path.join(tmp, 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'unrelated', 'leaked.ts'), 'export {};');
    spawnSync('git', ['add', 'src/modules/bank-statement/CLAUDE.md', 'unrelated/leaked.ts'], { cwd: tmp });

    const scopePath = writeScopeJson(tmp, ['src/modules/bank-statement/service.ts']);
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 1, `expected exit 1 (the .ts is out of scope), got ${result.status}. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'outside_scope');
    assert.ok(output.staged_paths_outside_scope.includes('unrelated/leaked.ts'), 'the out-of-scope .ts must be flagged');
    assert.ok(
      !output.staged_paths_outside_scope.some((p) => p.endsWith('CLAUDE.md')),
      'the CLAUDE.md catalog file must NOT be flagged',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// AP-EXT-ITER31-01: `allowed_paths` is built from `--name-status -M100 -z`
// (`scope-resolver.ts:computeAllowedFromDiff`). This reader must cross the SAME
// contract. Without `-z`, `core.quotePath` (default ON) C-quotes non-ASCII paths
// — `café.ts` reads back as the literal `"caf\303\251.ts"`, matches nothing in
// the fence, and an EXPLICITLY-ALLOWED file is refused `outside_scope`.
//
// Assert the RESOLVED VERDICT, never the argv: an argv oracle greens the moment
// someone re-tunes the flag list instead of the contract. The ASCII sibling cases
// above are blind to this by construction — every one of their paths is ASCII.
test('AP-EXT-ITER31-01: a non-ASCII staged path INSIDE the fence is not reported outside it', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
    // Leave core.quotePath at its default (ON) — that default IS the bug surface.

    fs.mkdirSync(path.join(tmp, 'extension', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'café.ts'), 'export {};');
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'plain.ts'), 'export {};');
    spawnSync('git', ['add', '--', 'extension/src/café.ts', 'extension/src/plain.ts'], { cwd: tmp });

    const scopePath = writeScopeJson(tmp, ['extension/src']);
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'ok', `non-ASCII in-scope path must not read as drift: ${result.stdout}`);
    assert.equal(output.staged_count, 2, 'both staged paths must be counted, undecorated');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The fence must still FENCE — widening the contract must not blind the check.
test('AP-EXT-ITER31-01: a non-ASCII staged path OUTSIDE the fence is still flagged, unquoted', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });

    fs.mkdirSync(path.join(tmp, 'extension', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'in.ts'), 'export {};');
    fs.writeFileSync(path.join(tmp, 'unrelated', 'café.ts'), 'export {};');
    spawnSync('git', ['add', '--', 'extension/src/in.ts', 'unrelated/café.ts'], { cwd: tmp });

    const scopePath = writeScopeJson(tmp, ['extension/src']);
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'outside_scope');
    assert.deepEqual(
      output.staged_paths_outside_scope,
      ['unrelated/café.ts'],
      'the flagged path must be the real, undecorated path an operator can `git reset HEAD` — not a C-quoted form',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
