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

const { runGate, getChangedExportedSymbols } = await import(
  path.resolve(__dirname, '../services/convergence-gate.js'),
);
const { runInterfaceChangeSweep, handleWorkerManagedIteration } = await import(
  path.resolve(__dirname, '../bin/microverse-runner.js'),
);

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

// ---------------------------------------------------------------------------
// AP-EXT-ITER47-01: the R-ORSR-6 sweep's arming input could not say "I could not measure".
//
// `getChangedExportedSymbols` mapped EVERY git failure to an empty `Set`, and
// `runInterfaceChangeSweep` reads an empty set as "no exported symbol changed" → `ran: false`,
// which `applyInterfaceChangeSweepGuard` dropped with no log and no event. So a `git diff` that
// never completed was byte-identical to a clean measurement and INV-NO-SELF-DISOWN — the guard
// whose whole job is that a phase cannot disown its own whole-repo interface break — went inert
// while the run converged reporting success.
//
// These cases drive the REAL producer against a REAL repo. All five cases in
// tests/microverse-interface-change-sweep.test.js inject `() => new Set()`, so every one of them
// stays GREEN against the pre-fix runtime — the AP-EXT-ITER13-01 hand-authored-fixture failure.
// ---------------------------------------------------------------------------

// A SHA of the right shape that no repo here contains, so `git diff <sha>..HEAD` exits 128 —
// the most reachable failure arm (a pruned, shallow, or foreign base commit).
const UNREACHABLE_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** A repo whose second commit CHANGES an exported declaration, so the happy path is non-empty. */
function makeExportChangeRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'audit.ts'), 'export interface AuditResult { sum: number }\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = headSha(dir);

  fs.writeFileSync(path.join(dir, 'src', 'audit.ts'), 'export interface AuditResult { total: number }\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'change the exported shape']);
  return { dir, base };
}

test('AP-EXT-ITER47-01: getChangedExportedSymbols returns null (not an empty Set) when git cannot answer', () => {
  const { dir, base } = makeExportChangeRepo('cg-apiter47-producer-');
  try {
    // Control: the happy path still MEASURES, so the null arm is not just a broken reader.
    const measured = getChangedExportedSymbols(dir, base);
    assert.ok(measured instanceof Set, 'a reachable base must yield a real Set');
    assert.equal(measured.has('AuditResult'), true, 'the changed exported declaration must be seen');

    // The defect: an unreachable base is a FAILED measurement, not a measurement of zero.
    const unmeasurable = getChangedExportedSymbols(dir, UNREACHABLE_SHA);
    assert.equal(
      unmeasurable,
      null,
      'git exit 128 must report "could not measure"; an empty Set is a POSITIVE finding ' +
      '("no exported symbol changed") that silently disarms the R-ORSR-6 sweep',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER47-01: an unmeasurable symbol set reaches the sweep as skipped, not as a clean verdict', async () => {
  const { dir, base } = makeExportChangeRepo('cg-apiter47-chain-');
  let gateCalls = 0;
  try {
    // getChangedExportedSymbolsFn is deliberately NOT injected: this crosses the real
    // convergence-gate producer, which is the seam every pre-existing sweep case skips.
    const skipped = await runInterfaceChangeSweep({
      workingDir: dir,
      sessionDir: dir,
      startCommit: UNREACHABLE_SHA,
      runGateFn: async () => { gateCalls++; return { failures: [] }; },
      logActivityFn: () => {},
      getChangedFilesSinceFn: () => [],
    });
    assert.equal(skipped.ran, false, 'an unmeasurable input cannot run a whole-repo tsc');
    assert.equal(
      skipped.skipped,
      'symbols_unmeasurable',
      'the not-run REASON must survive to the caller; without it the caller cannot tell a sweep ' +
      'that never ran from a sweep that found nothing',
    );
    assert.equal(gateCalls, 0, 'no whole-repo tsc on an unmeasurable input');

    // Control: the same chain over a REACHABLE base does run, so the skip is not a dead sweep.
    const ran = await runInterfaceChangeSweep({
      workingDir: dir,
      sessionDir: dir,
      startCommit: base,
      runGateFn: async () => { gateCalls++; return { failures: [] }; },
      logActivityFn: () => {},
      getChangedFilesSinceFn: () => ['src/audit.ts'],
    });
    assert.equal(ran.ran, true, 'a reachable base with a changed export must sweep');
    assert.equal(ran.skipped, null, 'a sweep that RAN was never skipped');
    assert.equal(gateCalls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER47-01: a genuine zero-symbol measurement stays distinct from an unmeasurable one', async () => {
  const common = {
    workingDir: '/repo',
    sessionDir: '/sessions/apiter47',
    startCommit: 'base000',
    runGateFn: async () => ({ failures: [] }),
    logActivityFn: () => {},
    getChangedFilesSinceFn: () => ['src/audit.ts'],
  };

  const measuredZero = await runInterfaceChangeSweep({
    ...common,
    getChangedExportedSymbolsFn: () => new Set(),
  });
  const unmeasurable = await runInterfaceChangeSweep({
    ...common,
    getChangedExportedSymbolsFn: () => null,
  });

  assert.equal(measuredZero.ran, false);
  assert.equal(unmeasurable.ran, false);
  assert.equal(
    measuredZero.skipped,
    null,
    'a real measurement of zero is a VERDICT — it must not be tagged as a measurement failure',
  );
  assert.equal(unmeasurable.skipped, 'symbols_unmeasurable');
  assert.notEqual(
    measuredZero.skipped,
    unmeasurable.skipped,
    'the two must not collapse to one shape — that collapse IS the defect',
  );
});

// The RENDER half. A skip nothing surfaces is the same silence, one layer up — the
// `orphan-reaper.ts:sweepNotRun` lesson: the swallow is fine, the collapse into a reading is
// the bug, and something must render it.
async function convergeWithSymbolFn(getChangedExportedSymbolsFn) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-apiter47-render-'));
  const logs = [];
  try {
    fs.writeFileSync(
      path.join(sessionDir, 'anatomy-park.json'),
      JSON.stringify({ converged: true, reason: 'all subsystems clean' }, null, 2),
    );
    const result = await handleWorkerManagedIteration({
      currentMv: {
        convergence_file: 'anatomy-park.json',
        key_metric: { type: 'none' },
        iteration_regressions: 0,
      },
      preIterSha: 'aaaa1111',
      workingDir: sessionDir,
      sessionDir,
      enabledFiles: ['anatomy-park.json'],
      regressionWarningThreshold: 5,
      backend: 'claude',
      remediatorTimeoutS: 600,
      log: (msg) => logs.push(msg),
      iteration: 12,
      startCommit: UNREACHABLE_SHA,
      _deps: {
        // preIterSha === headSha → no commits → the per-iteration gate is skipped, leaving the
        // sweep guard as the only thing under test.
        getHeadShaFn: () => 'aaaa1111',
        logActivityFn: () => {},
        writeMicroverseStateFn: () => {},
        runGateFn: async () => ({ failures: [] }),
        getChangedExportedSymbolsFn,
        getChangedFilesSinceFn: () => [],
      },
    });
    return { result, logs };
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER47-01: an unmeasurable sweep is RENDERED to the operator and stays non-fatal', async () => {
  const { result, logs } = await convergeWithSymbolFn(() => null);

  const rendered = logs.filter((line) => line.includes('symbols_unmeasurable'));
  assert.equal(
    rendered.length,
    1,
    `the not-run reason must be surfaced exactly once; got logs: ${JSON.stringify(logs)}`,
  );
  assert.match(rendered[0], /NOT RUN/, 'the line must say the sweep did not run');

  // PRIME DIRECTIVE: an ABSENT measurement is not a measured regression. Rendering it must never
  // become a halt — a stopping gate takes reliability and quality to zero together.
  assert.equal(result.converged, true, 'an unmeasurable sweep must not block convergence');
  assert.equal(result.selfRedOpen, undefined, 'no self-red is open — nothing was measured');
});

test('AP-EXT-ITER47-01: a measured zero-symbol sweep renders NOTHING (no false alarm)', async () => {
  const { result, logs } = await convergeWithSymbolFn(() => new Set());

  assert.equal(
    logs.filter((line) => line.includes('symbols_unmeasurable')).length,
    0,
    'a real measurement of zero must stay silent; warning on it would train the operator to ignore the line',
  );
  assert.equal(result.converged, true);
});
