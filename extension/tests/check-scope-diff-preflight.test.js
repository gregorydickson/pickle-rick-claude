// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkScopeDiff, isUnevaluableScopeStatus } from '../bin/check-scope-diff.js';
import { UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';

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

// ---------------------------------------------------------------------------
// AP-EXT-ITER38-01: a staged-path enumeration that did not COMPLETE must never
// be reported as a fence that PASSED.
//
// Both cases drive the SHIPPED CLI against a REAL git repo and assert the
// EMITTED VERDICT — never the argv. An argv oracle would green the moment
// someone re-tunes the flag list instead of the axis, and every pre-existing
// case in this file stages a handful of short ASCII paths, which is blind to
// the truncation ceiling by construction.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER38-01: a staged enumeration git cannot run reports enumeration_failed, never ok', () => {
  const tmp = makeTmp();
  try {
    // No `git init` — the scope fence has a scope.json but no repo to enumerate,
    // so git exits non-zero. Pre-fix this returned [] and the empty set walked
    // straight through the allowlist filter into `{status:'ok',staged_count:0}`
    // at exit 0: a green fence over an enumeration that never happened.
    const scopePath = writeScopeJson(tmp, ['extension/src']);
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 2, `expected exit 2, got ${result.status}. stdout: ${result.stdout}`);
    const output = JSON.parse(result.stderr.trim());
    assert.equal(output.status, 'enumeration_failed');
    assert.match(output.error, /scope fence was not evaluated/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER38-01: a staged name list past Node\'s 1 MB default is still fenced, not silently emptied', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp, timeout: 30_000 });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp, timeout: 30_000 });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, timeout: 30_000 });

    // > 1 MB of NUL-separated path bytes, reached with deep paths rather than a
    // huge file count so the fixture stays cheap. Past Node's default maxBuffer
    // the child is SIGTERMed and `status` comes back null — indistinguishable,
    // to the guard, from a git that failed.
    const seg = 'd'.repeat(120);
    const deepRel = path.join('outside', ...Array(6).fill(seg));
    fs.mkdirSync(path.join(tmp, deepRel), { recursive: true });
    for (let i = 1; i <= 1500; i += 1) {
      fs.writeFileSync(path.join(tmp, deepRel, `f${i}-${'n'.repeat(120)}.txt`), '');
    }
    spawnSync('git', ['add', '-A'], { cwd: tmp, timeout: 60_000 });

    const bytes = spawnSync('git', ['diff', '--staged', '--name-only', '--no-renames', '-z'], {
      cwd: tmp, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30_000,
    }).stdout.length;
    assert.ok(bytes > 1024 * 1024, `fixture must exceed the 1 MB default; got ${bytes} bytes`);

    // Every staged path is outside the fence. Pre-fix: `{status:'ok'}` exit 0.
    const scopePath = writeScopeJson(tmp, ['extension/src']);
    const result = runScript(['--scope-json', scopePath], { cwd: tmp, maxBuffer: 64 * 1024 * 1024 });

    // The EXIT CODE is the verdict the worker acts on, so that is what this pins.
    // A >1 MB `outside_scope` payload is itself truncated at the 64 KB pipe buffer
    // by the CLI's `process.exit` — a separate, severity-independent defect that
    // does not change the code — so the stdout assertion stays a prefix check.
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.startsWith('{"status":"outside_scope"'),
      `expected an outside_scope verdict, got: ${result.stdout.slice(0, 120)}`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// A pid that is provably not alive, so `shouldSkipLiveTmp` does not defer the orphan tmp.
function deadPidForTmp() {
  for (const candidate of [999_999, 888_888, 777_777]) {
    try { process.kill(candidate, 0); } catch { return candidate; }
  }
  throw new Error('no dead pid available for fixture');
}

// AP-EXT-ITER40-01. `scope.json` is written tmp-rename by `scope-resolver.ts:writeScopeJson`,
// so a killed writer leaves the ONLY fence in a sibling `.tmp.<pid>`. This reader used to
// `existsSync`-gate + raw `JSON.parse`, which short-circuits the promotion the recovery
// primitive performs — the session's fence read as ABSENT, and `no_scope` exits 0.
//
// Assert the RESOLVED VERDICT (exit code + status) against a REAL git repo with a REAL
// out-of-scope staged path, plus the on-disk promotion. Asserting "does not throw" or
// stubbing the read would green over the pre-fix code, which returned `no_scope` quietly.
test('AP-EXT-ITER40-01: a crash-orphaned tmp-only scope.json still fences the commit, and is promoted', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });

    fs.mkdirSync(path.join(tmp, 'extension', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'in-fence.ts'), 'export {};');
    fs.writeFileSync(path.join(tmp, 'unrelated', 'leaked.ts'), 'export {};');
    spawnSync('git', ['add', 'extension/src/in-fence.ts', 'unrelated/leaked.ts'], { cwd: tmp, timeout: 30_000 });

    const scopePath = path.join(tmp, 'scope.json');
    const tmpScopePath = `${scopePath}.tmp.${deadPidForTmp()}`;
    fs.writeFileSync(tmpScopePath, JSON.stringify({ version: 1, mode: 'paths', allowed_paths: ['extension/src'] }));
    assert.equal(fs.existsSync(scopePath), false, 'fixture must start with NO base scope.json');

    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 1, `expected exit 1 (fence evaluated), got ${result.status}. stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'outside_scope');
    assert.deepEqual(output.staged_paths_outside_scope, ['unrelated/leaked.ts']);
    assert.equal(fs.existsSync(scopePath), true, 'the recovering read must promote the orphan tmp');
    assert.equal(fs.existsSync(tmpScopePath), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Control for the arm above: absence is decided AFTER the recovering read, so a session with
// neither a base nor a promotable orphan must STILL report `no_scope` at exit 0. Without this
// the fix could over-trigger and turn every genuinely-unscoped run into a hard error.
test('AP-EXT-ITER40-01: a genuinely absent scope.json (no base, no orphan tmp) is still no_scope at exit 0', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });

    fs.mkdirSync(path.join(tmp, 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'unrelated', 'leaked.ts'), 'export {};');
    spawnSync('git', ['add', 'unrelated/leaked.ts'], { cwd: tmp, timeout: 30_000 });

    const scopePath = path.join(tmp, 'scope.json');
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.equal(JSON.parse(result.stdout.trim()).status, 'no_scope');
    assert.equal(fs.existsSync(scopePath), false, 'nothing to promote must leave the dir untouched');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER38-01 (second failure shape): `maxBuffer` overflow does not always
// present as the SIGTERM the ceiling case above drives. When the child EXITS before
// Node's kill lands, `spawnSync` returns `status: 0`, `signal: null` and
// `error.code === 'ENOBUFS'` — measured on node v24.19.0, 25/25 runs, with
// `git diff --name-only -z` against this repo. A status-only guard reads that
// ceiling-exceeded read as a COMPLETE enumeration, so the fence greens over the
// staged tail it never saw.
//
// These cases cross the `_spawnSync` seam, NOT `_getStagedPaths`: the latter
// REPLACES the reader, which would leave its ceiling and its completion predicate
// — the code under test — unexercised. Driving the shipped CLI is not an option
// here; the real ceiling is 64 MiB.
// ---------------------------------------------------------------------------

function fakeSpawn(result, optsSink) {
  return (bin, args, opts) => {
    assert.equal(bin, 'git');
    assert.ok(args.includes('--name-only') && args.includes('-z'), 'the reader keeps its git contract');
    if (optsSink) optsSink.push(opts);
    return result;
  };
}

test('AP-EXT-ITER38-01: a maxBuffer-exceeded enumeration that still EXITS 0 reports enumeration_failed', () => {
  const tmp = makeTmp();
  try {
    const scopeJsonPath = writeScopeJson(tmp, ['extension/src']);
    const enobufs = Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
    // The visible head is in scope; the tail the ceiling cut off is unknown. Pre-fix
    // this returned `{status:'ok', staged_count:1}` at exit 0 — a green fence over a
    // read Node had already reported as truncated.
    const result = checkScopeDiff({
      scopeJsonPath,
      _spawnSync: fakeSpawn({ status: 0, signal: null, stdout: 'extension/src/a.ts\0', error: enobufs }),
    });

    assert.equal(result.status, 'enumeration_failed', 'an ENOBUFS read is not a fence verdict');
    assert.ok(isUnevaluableScopeStatus(result.status), 'it shares the cannot-render-a-verdict disposition');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER38-01: a COMPLETED enumeration through the same seam still renders a verdict', () => {
  const tmp = makeTmp();
  try {
    const scopeJsonPath = writeScopeJson(tmp, ['extension/src']);
    const optsSink = [];
    // No `error`: a real `status: 0` read. The distinction must not over-trigger.
    const result = checkScopeDiff({
      scopeJsonPath,
      _spawnSync: fakeSpawn({ status: 0, signal: null, stdout: 'extension/src/a.ts\0outside/b.ts\0' }, optsSink),
    });

    assert.equal(result.status, 'outside_scope');
    assert.deepEqual(result.staged_paths_outside_scope, ['outside/b.ts']);
    // The seam runs the REAL reader, so its ceiling is observable here — proof these
    // cases exercise the guard rather than a test-local stand-in for it.
    assert.equal(optsSink.length, 1, 'exactly one git enumeration');
    assert.equal(optsSink[0].maxBuffer, UNBOUNDED_READ_MAX_BUFFER, 'the reader declares the ONE ceiling');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-BIN-ITER33-01: `isPathInScope` — the predicate the fence actually IS — had
// NO fixture on either of its two arms. Eight commits hardened everything around
// it (the recovering read, the enumeration ceiling, the `-z` contract, the
// CLAUDE.md exemption) while the membership comparison stayed at its birth
// commit, uncovered.
//
// Both cases below drive the SHIPPED CLI against a REAL git repo and assert the
// emitted verdict, and both use a PRODUCTION-SHAPED fence: `allowed_paths` is
// built by `scope-resolver.ts:computeAllowedFromDiff` from `--name-status`, so
// every entry is a FILE path. Every pre-existing case in this file instead
// allowlists a DIRECTORY (`extension/src`), which reaches only the `startsWith`
// arm — so the arm that decides essentially every real allowlist hit was blind
// by construction.
// ---------------------------------------------------------------------------

test('AP-BIN-ITER33-01: a staged path EQUAL to an allowed file path is inside the fence', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp, timeout: 30_000 });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp, timeout: 30_000 });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, timeout: 30_000 });

    fs.mkdirSync(path.join(tmp, 'extension', 'src', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'bin', 'setup.ts'), 'export {};');
    spawnSync('git', ['add', 'extension/src/bin/setup.ts'], { cwd: tmp, timeout: 30_000 });

    // The allowlist names the staged file EXACTLY and has no staged descendant,
    // so only equality can admit it. Drop that arm and the fence refuses the very
    // file it was told to allow: `outside_scope` at exit 1, on every worker commit
    // of every scoped session.
    const scopePath = writeScopeJson(tmp, ['extension/src/bin/setup.ts']);
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'ok', 'an explicitly-allowed file path must not read as drift');
    assert.equal(output.staged_count, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The opposite direction, and the reason the separator is not cosmetic: an
// allowlist entry admits its DESCENDANTS, never its name-prefix SIBLINGS.
test('AP-BIN-ITER33-01: a staged path that merely name-prefixes an allowed path is still outside the fence', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp, timeout: 30_000 });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp, timeout: 30_000 });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, timeout: 30_000 });

    fs.mkdirSync(path.join(tmp, 'extension', 'src', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'docs', 'api-notes'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'bin', 'setup.ts'), 'export {};');
    // Extends an allowed FILE entry's name — the shape a worker produces by hand
    // (`.bak`, `.orig`, `.tsx`) while editing the file it is scoped to.
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'bin', 'setup.ts.bak'), 'export {};');
    // Extends an allowed DIRECTORY entry's name — the same defect one shape over.
    fs.writeFileSync(path.join(tmp, 'docs', 'api-notes', 'leaked.md'), 'x\n');
    spawnSync(
      'git',
      ['add', 'extension/src/bin/setup.ts', 'extension/src/bin/setup.ts.bak', 'docs/api-notes/leaked.md'],
      { cwd: tmp, timeout: 30_000 },
    );

    // Neither allowlist entry is an ANCESTOR of either sibling, so only the
    // separator decides them. Drop it and both walk straight through the fence.
    const scopePath = writeScopeJson(tmp, ['extension/src/bin/setup.ts', 'docs/api']);
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'outside_scope');
    assert.deepEqual(
      [...output.staged_paths_outside_scope].sort(),
      ['docs/api-notes/leaked.md', 'extension/src/bin/setup.ts.bak'],
      'both name-prefix siblings must be fenced, and the allowed file itself must not be',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER14-01: `--no-renames` (`check-scope-diff.ts:86`) is the flag that
// keeps a rename's SOURCE path inside the enumeration, and nothing judged it.
//
// The producer and this reader cross the same git contract asymmetrically, by
// design: `scope-resolver.ts:computeAllowedFromDiff` reads `--name-status -M100`
// and `git-utils.ts:getDiffFiles` records a rename's DESTINATION only
// (`tokens[i + 2]`), so a rename's source is never in `allowed_paths`. Rename
// detection is git's DEFAULT (`diff.renames`, on since 2.9), so `--no-renames`
// is not decoration — it disables that default, and a detected rename under
// `--name-only` emits only the destination. Drop the flag and moving an
// out-of-scope file INTO the fence erases the source path from the enumeration
// entirely: the staged deletion the fence exists to catch reports `ok` at
// exit 0.
//
// The `-z` sibling in the same argv array is fixtured (AP-EXT-ITER31-01) and
// documented; this one was neither. Both cases drive the SHIPPED CLI over a REAL
// git repo and assert the emitted VERDICT, never the argv — an argv oracle
// greens the moment someone re-tunes the flag list instead of the contract.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER14-01: a rename that moves an out-of-scope file INTO the fence is still flagged on its source path', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp, timeout: 30_000 });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp, timeout: 30_000 });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, timeout: 30_000 });

    fs.mkdirSync(path.join(tmp, 'unrelated'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'extension', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'unrelated', 'secret.ts'), 'export {};');
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'in.ts'), 'export {};');
    spawnSync('git', ['add', '-A'], { cwd: tmp, timeout: 30_000 });
    spawnSync('git', ['commit', '-qm', 'base'], { cwd: tmp, timeout: 30_000 });

    // Content is carried verbatim, so git scores this R100 — the strongest form
    // of the rename it would otherwise collapse to a single destination entry.
    spawnSync('git', ['mv', 'unrelated/secret.ts', 'extension/src/moved.ts'], { cwd: tmp, timeout: 30_000 });

    const scopePath = writeScopeJson(tmp, ['extension/src']);
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'outside_scope');
    assert.deepEqual(
      output.staged_paths_outside_scope,
      ['unrelated/secret.ts'],
      'the rename SOURCE is the staged deletion of an out-of-scope file and must be named',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The ACCEPT control, without which the case above is satisfied by a fence that
// refuses every rename: a rename wholly INSIDE the allowlist stays green, and
// both of its halves are counted.
test('AP-EXT-ITER14-01: a rename wholly inside the fence is not drift, and both halves are enumerated', () => {
  const tmp = makeTmp();
  try {
    spawnSync('git', ['init', '-q'], { cwd: tmp, timeout: 30_000 });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp, timeout: 30_000 });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, timeout: 30_000 });

    fs.mkdirSync(path.join(tmp, 'extension', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'a.ts'), 'export {};');
    spawnSync('git', ['add', '-A'], { cwd: tmp, timeout: 30_000 });
    spawnSync('git', ['commit', '-qm', 'base'], { cwd: tmp, timeout: 30_000 });

    spawnSync('git', ['mv', 'extension/src/a.ts', 'extension/src/b.ts'], { cwd: tmp, timeout: 30_000 });

    const scopePath = writeScopeJson(tmp, ['extension/src']);
    const result = runScript(['--scope-json', scopePath], { cwd: tmp });

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.status, 'ok', 'an in-fence rename must not read as drift');
    // 2, not 1: the source half must still reach the allowlist filter. A reader
    // that collapsed the rename would count 1 and pass this case vacuously.
    assert.equal(output.staged_count, 2, 'both halves of the rename must be enumerated');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
