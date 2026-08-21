// @tier: integration
// AP-EXT-ITER15-01: the R-ORSR-6 no-disown guard's ONLY production arming point is the
// baseline-mode `runGate` call. Every pre-existing case drives `subtractBaseline(current,
// baseline, selfGuard)` DIRECTLY with a hand-built context, so they all stayed GREEN while
// no production caller ever passed a third argument. These cases drive the real `runGate`
// against a real git repo and assert the resulting gate STATUS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { runGate } = await import(path.resolve(__dirname, '../services/convergence-gate.js'));

function git(dir, args) {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe', timeout: 30_000 });
}

// A fixture whose `typecheck` script always emits the SAME tsc-shaped failure, so the
// current run's fingerprint always matches the captured baseline. Whether the failure is
// subtracted therefore depends ONLY on the no-disown classifier.
function writeFixture(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'no-disown-fixture',
      private: true,
      scripts: { typecheck: 'node typecheck.cjs' },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'typecheck.cjs'),
    [
      "console.log(\"src/consumer.ts(3,11): error TS2339: Property 'total' does not exist on type 'AuditResult'.\");",
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(dir, 'src', 'audit.ts'), 'export interface AuditResult { sum: number }\n');
  fs.writeFileSync(path.join(dir, 'src', 'consumer.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
}

function makeRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  writeFixture(dir);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  return dir;
}

function headSha(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 }).trim();
}

async function captureBaseline(workingDir, baselinePath) {
  const result = await runGate({
    workingDir,
    mode: 'baseline',
    scope: 'full',
    checks: ['typecheck'],
    baselinePath,
  });
  assert.equal(fs.existsSync(baselinePath), true, 'baseline must land on disk');
  assert.equal(result.baseline_used, false, 'first baseline run captures, it does not compare');
}

test('AP-EXT-ITER15-01: a baseline-matching failure whose symbol the iteration changed is NOT disowned', async () => {
  const workingDir = makeRepo('cg-no-disown-wiring-self-');
  try {
    const baselinePath = path.join(workingDir, 'session', 'gate', 'baseline.json');
    await captureBaseline(workingDir, baselinePath);
    const base = headSha(workingDir);

    // The iteration's own diff changes the EXPORTED symbol the failure message quotes.
    fs.writeFileSync(
      path.join(workingDir, 'src', 'audit.ts'),
      'export interface AuditResult { sum: number; count: number }\n',
    );
    git(workingDir, ['add', '.']);
    git(workingDir, ['commit', '-m', 'iteration edit']);

    const result = await runGate({
      workingDir,
      mode: 'baseline',
      scope: 'changed',
      since: base,
      baselinePath,
      checks: ['typecheck'],
    });

    assert.equal(result.baseline_used, true, 'second run must compare against the baseline');
    assert.equal(
      result.status,
      'red',
      'the phase cannot disown a break intersecting its own diff as a coincidental baseline match',
    );
    assert.equal(result.new_failures_vs_baseline, 1);
    assert.match(result.failures[0].message, /AuditResult/);
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER15-01: a genuinely pre-existing failure is still subtracted (no false red)', async () => {
  const workingDir = makeRepo('cg-no-disown-wiring-preexisting-');
  try {
    const baselinePath = path.join(workingDir, 'session', 'gate', 'baseline.json');
    await captureBaseline(workingDir, baselinePath);
    const base = headSha(workingDir);

    // A changed file that is neither the failing file nor an exported-symbol source.
    fs.writeFileSync(path.join(workingDir, 'README.md'), 'fixture\nunrelated edit\n');
    git(workingDir, ['add', '.']);
    git(workingDir, ['commit', '-m', 'unrelated edit']);

    const result = await runGate({
      workingDir,
      mode: 'baseline',
      scope: 'changed',
      since: base,
      baselinePath,
      checks: ['typecheck'],
    });

    assert.equal(result.baseline_used, true, 'second run must compare against the baseline');
    assert.equal(result.status, 'green', 'a failure the iteration did not touch stays pre-existing');
    assert.equal(result.new_failures_vs_baseline, 0);
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

// AP-EXT-ITER8-02: both cases above put `package.json` AT the git root, so `runGate`'s
// `workingDir` and git's own path space coincide and the FILE axis of the classifier matches by
// accident. This repo is not shaped that way: the git root carries no project marker and the
// package lives one level down (`extension/`), so R-SZGB-A `detectProjectTypeWithRootResolution`
// rewrites `workingDir` to the package dir while `git diff --name-only` keeps emitting
// REPO-ROOT-relative paths. The fixture below reproduces that shape exactly.
function writeNestedFixture(root) {
  const pkg = path.join(root, 'extension');
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({
      name: 'nested-no-disown-fixture',
      private: true,
      scripts: { typecheck: 'node typecheck.cjs' },
    }, null, 2),
  );
  // Same file + same rule every run, so the fingerprint always matches the baseline; only the
  // LINE moves. Whether the failure survives therefore depends ONLY on the no-disown classifier.
  fs.writeFileSync(
    path.join(pkg, 'typecheck.cjs'),
    [
      "const line = require('fs').readFileSync(__dirname + '/line.txt', 'utf8').trim();",
      'console.log(`src/audit.ts(${line},11): error TS2554: Expected 1 arguments, but got 2.`);',
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(pkg, 'line.txt'), '3\n');
  fs.writeFileSync(path.join(pkg, 'src', 'audit.ts'), 'export const sum = 1;\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  return pkg;
}

function makeNestedRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, ['init']);
  git(root, ['config', 'user.name', 'Test User']);
  git(root, ['config', 'user.email', 'test@example.com']);
  const pkg = writeNestedFixture(root);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  return { root, pkg };
}

test('AP-EXT-ITER8-02: with the package one level below the git root, a failure in a file the iteration changed is NOT disowned', async () => {
  const { root, pkg } = makeNestedRepo('cg-no-disown-nested-self-');
  try {
    const baselinePath = path.join(root, 'session', 'gate', 'baseline.json');
    await captureBaseline(root, baselinePath);
    const base = headSha(root);

    // The iteration edits the very file the failure is reported in — no exported symbol is
    // involved, so ONLY the changed-FILE axis can keep this failure.
    fs.writeFileSync(path.join(pkg, 'src', 'audit.ts'), 'export const sum = 1;\nconst added = 2;\n');
    fs.writeFileSync(path.join(pkg, 'line.txt'), '9\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'iteration edit']);

    const result = await runGate({
      workingDir: root,
      mode: 'baseline',
      scope: 'changed',
      since: base,
      baselinePath,
      checks: ['typecheck'],
    });

    assert.equal(result.baseline_used, true, 'second run must compare against the baseline');
    assert.equal(
      result.status,
      'red',
      'a failure in a file THIS iteration changed cannot be disowned as a coincidental baseline match',
    );
    assert.equal(result.new_failures_vs_baseline, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER8-02: a nested-root failure the iteration did not touch is still subtracted (no false red)', async () => {
  const { root } = makeNestedRepo('cg-no-disown-nested-preexisting-');
  try {
    const baselinePath = path.join(root, 'session', 'gate', 'baseline.json');
    await captureBaseline(root, baselinePath);
    const base = headSha(root);

    // A changed file outside the package, unrelated to the failing file.
    fs.writeFileSync(path.join(root, 'README.md'), 'fixture\nunrelated edit\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'unrelated edit']);

    const result = await runGate({
      workingDir: root,
      mode: 'baseline',
      scope: 'changed',
      since: base,
      baselinePath,
      checks: ['typecheck'],
    });

    assert.equal(result.baseline_used, true, 'second run must compare against the baseline');
    assert.equal(result.status, 'green', 'a failure the iteration did not touch stays pre-existing');
    assert.equal(result.new_failures_vs_baseline, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
