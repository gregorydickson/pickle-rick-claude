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

const { runGate, getChangedExportedSymbols, getChangedFilesSince } = await import(
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

// ---------------------------------------------------------------------------
// AP-EXT-ITER117-01: a pure MOVE is an exported-symbol change.
//
// `diff.renames` is ON by default (git >= 2.9), so a 100%-similar move emits ONLY a
// `similarity index 100%` header with no `+`/`-` lines. `getChangedExportedSymbols` parses
// `+`/`-` lines, so it returned an EMPTY Set — and an empty Set is the POSITIVE verdict the
// sweep's `size === 0` arm reads as "this phase changed no exported symbol": `ran: false`,
// `skipped: null`, nothing rendered, no whole-repo typecheck. Same class as the unmeasurable
// arm directly above, reached through the git CONTRACT instead of a git failure.
//
// These cases cross the REAL producer against a REAL repo — an injected
// `getChangedExportedSymbolsFn` cannot observe an argv.
// ---------------------------------------------------------------------------

/** A repo whose second commit is a PURE content move — no edit, 100% similarity. */
function makePureMoveRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'audit.ts'),
    'export interface AuditResult { sum: number }\nexport function audit(): AuditResult { return { sum: 0 }; }\n',
  );
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = headSha(dir);

  git(dir, ['mv', 'src/audit.ts', 'src/moved-audit.ts']);
  git(dir, ['commit', '-m', 'move the module, byte for byte']);
  return { dir, base };
}

test('AP-EXT-ITER117-01: a pure file move is seen as an exported-symbol change, not as zero', () => {
  const { dir, base } = makePureMoveRepo('cg-apiter117-producer-');
  try {
    // PRECONDITION: git really did detect this as a rename, so the case pins the shape it
    // claims to. Without this the test could pass on a repo where the move was recorded as
    // delete+add, which was never the defect.
    const detected = execFileSync('git', ['diff', `${base}..HEAD`], {
      cwd: dir, encoding: 'utf-8', timeout: 30_000,
    });
    assert.match(detected, /similarity index 100%/, 'fixture precondition: git must detect the move as a rename');
    assert.equal(/^[+-][^+-]/m.test(detected), false, 'fixture precondition: a detected pure rename carries no +/- content lines');

    const measured = getChangedExportedSymbols(dir, base);
    assert.ok(measured instanceof Set, 'a reachable base must yield a real Set');
    assert.equal(
      measured.has('AuditResult'), true,
      'a move relocates every exported symbol in the module — the module specifier every importer ' +
      'uses just changed, so an empty Set here is a false "no exported symbol changed" verdict',
    );
    assert.equal(measured.has('audit'), true, 'both exported declarations move, not just the first');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER117-01: the moved-module sweep RUNS the whole-repo typecheck instead of reporting a clean verdict', async () => {
  const { dir, base } = makePureMoveRepo('cg-apiter117-chain-');
  let gateCalls = 0;
  try {
    const sweep = await runInterfaceChangeSweep({
      workingDir: dir,
      sessionDir: dir,
      startCommit: base,
      runGateFn: async () => { gateCalls++; return { failures: [] }; },
      logActivityFn: () => {},
      getChangedFilesSinceFn: () => ['src/moved-audit.ts'],
    });
    assert.equal(gateCalls, 1, 'the sweep must actually measure — pre-fix it short-circuited with zero gate calls');
    assert.equal(sweep.ran, true, 'a move must ARM the sweep');
    assert.equal(
      sweep.skipped, null,
      'and it must not be tagged unmeasurable — this input measures fine, it was being MISREAD',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER117-01: an unrelated non-TS edit still measures zero (the fix does not arm on everything)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-apiter117-control-'));
  try {
    git(dir, ['init']);
    git(dir, ['config', 'user.name', 'Test User']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'audit.ts'), 'export interface AuditResult { sum: number }\n');
    fs.writeFileSync(path.join(dir, 'README.md'), 'one\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'base']);
    const base = headSha(dir);

    fs.writeFileSync(path.join(dir, 'README.md'), 'two\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'docs only']);

    const measured = getChangedExportedSymbols(dir, base);
    assert.ok(measured instanceof Set, 'a reachable base must yield a real Set');
    assert.equal(measured.size, 0, 'a genuine zero must stay zero — `--no-renames` widens the diff, never the pathspec');
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


// ---------------------------------------------------------------------------
// AP-EXT-ITER48-01: the sweep's OTHER classifier axis could not say "I could not measure".
//
// AP-EXT-ITER47-01 taught `getChangedExportedSymbols` to report a failed measurement. Its
// sibling `getChangedSince` — read by the sweep through the `getChangedFilesSince` wrapper —
// still mapped every git failure to `[]`. `isSelfIntroducedFailure` short-circuits on
// `changedFiles.size > 0`, so a fabricated empty list silently disarms the FILE axis of
// INV-NO-SELF-DISOWN while the sweep still returns `ran: true` — a verdict
// `applyInterfaceChangeSweepGuard` reads as evidence that the phase did not break the repo.
// That is strictly worse than the symbol arm was: the symbol arm went quiet, this arm asserts.
//
// An empty file list is not even a coherent reading at that call site: the sweep only reaches
// it once `changedExportedSymbols.size > 0`, and no exported declaration changes without its
// file changing. So `[]` there is PROVABLY an enumeration failure being read as data.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER48-01: getChangedFilesSince returns null (not []) when git cannot answer', () => {
  const { dir, base } = makeExportChangeRepo('cg-apiter48-producer-');
  try {
    // Control: a reachable base still MEASURES, so the null arm is not just a broken reader.
    const measured = getChangedFilesSince(dir, base);
    assert.ok(Array.isArray(measured), 'a reachable base must yield a real array');
    assert.deepEqual(measured, ['src/audit.ts'], 'the changed file must be seen');

    // The defect: an unreachable base is a FAILED enumeration, not an enumeration of zero.
    assert.equal(
      getChangedFilesSince(dir, UNREACHABLE_SHA),
      null,
      'git exit 128 must report "could not measure"; [] is a POSITIVE finding ("this phase ' +
      'changed no file") that disarms the file axis of the R-ORSR-6 no-disown classifier',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER48-01: an unmeasurable changed-file list reaches the sweep as skipped, not as ran', async () => {
  const { dir, base } = makeExportChangeRepo('cg-apiter48-chain-');
  let gateCalls = 0;
  // A whole-repo break inside the phase's OWN diff whose message names no changed symbol, so
  // only the FILE axis can catch it. Pre-fix this was disowned and the sweep reported `ran`.
  const runGateFn = async () => {
    gateCalls++;
    return { failures: [{ check: 'typecheck', file: 'src/audit.ts', line: 3, ruleOrCode: 'TS2322', message: 'Type mismatch', severity: 'error' }] };
  };
  try {
    const skipped = await runInterfaceChangeSweep({
      workingDir: dir,
      sessionDir: dir,
      startCommit: UNREACHABLE_SHA,
      runGateFn,
      logActivityFn: () => {},
      // getChangedFilesSinceFn is deliberately NOT injected: this crosses the real
      // convergence-gate producer, which is the seam every pre-existing sweep case skips.
      getChangedExportedSymbolsFn: () => new Set(['AuditResult']),
    });
    assert.equal(
      skipped.skipped,
      'changed_files_unmeasurable',
      'the failing AXIS must survive to the caller — the rendered line names which git ' +
      'enumeration did not complete',
    );
    assert.equal(
      skipped.ran,
      false,
      'a sweep missing one of its two classifier axes has NOT run; reporting `ran: true` with ' +
      'an empty selfIntroduced is a green verdict over a disarmed guard',
    );
    assert.equal(gateCalls, 0, 'no whole-repo tsc when an input could not be enumerated');

    // Control: the same chain over a REACHABLE base runs and keeps the file-only break.
    const ran = await runInterfaceChangeSweep({
      workingDir: dir,
      sessionDir: dir,
      startCommit: base,
      runGateFn,
      logActivityFn: () => {},
      getChangedExportedSymbolsFn: () => new Set(['AuditResult']),
    });
    assert.equal(ran.ran, true, 'a reachable base must sweep');
    assert.equal(ran.skipped, null, 'a sweep that RAN was never skipped');
    assert.equal(
      ran.selfIntroduced.length,
      1,
      'the file axis must still catch a break the phase introduced in its own changed file',
    );
    assert.equal(gateCalls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER48-01: a measured EMPTY file list still sweeps (the skip cannot over-trigger)', async () => {
  const common = {
    workingDir: '/repo',
    sessionDir: '/sessions/apiter48',
    startCommit: 'base000',
    logActivityFn: () => {},
    getChangedExportedSymbolsFn: () => new Set(['AuditResult']),
  };
  let gateCalls = 0;
  const measuredEmpty = await runInterfaceChangeSweep({
    ...common,
    runGateFn: async () => { gateCalls++; return { failures: [] }; },
    getChangedFilesSinceFn: () => [],
  });
  const unmeasurable = await runInterfaceChangeSweep({
    ...common,
    runGateFn: async () => { gateCalls++; return { failures: [] }; },
    getChangedFilesSinceFn: () => null,
  });

  assert.equal(measuredEmpty.ran, true, 'a completed enumeration is a verdict — the sweep must run on it');
  assert.equal(measuredEmpty.skipped, null, 'a real measurement must not be tagged a measurement failure');
  assert.equal(unmeasurable.ran, false);
  assert.equal(unmeasurable.skipped, 'changed_files_unmeasurable');
  assert.notEqual(
    measuredEmpty.skipped,
    unmeasurable.skipped,
    'the two must not collapse to one shape — that collapse IS the defect',
  );
  assert.equal(gateCalls, 1, 'exactly the measured run reached tsc');
});

test('AP-EXT-ITER48-01: an unmeasurable file enumeration is RENDERED once and stays non-fatal', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-apiter48-render-'));
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
      iteration: 13,
      startCommit: UNREACHABLE_SHA,
      _deps: {
        getHeadShaFn: () => 'aaaa1111',
        logActivityFn: () => {},
        writeMicroverseStateFn: () => {},
        runGateFn: async () => ({ failures: [] }),
        getChangedExportedSymbolsFn: () => new Set(['AuditResult']),
        getChangedFilesSinceFn: () => null,
      },
    });

    const rendered = logs.filter((line) => line.includes('changed_files_unmeasurable'));
    assert.equal(
      rendered.length,
      1,
      `the not-run reason must be surfaced exactly once; got logs: ${JSON.stringify(logs)}`,
    );
    assert.match(rendered[0], /NOT RUN/, 'the line must say the sweep did not run');

    // PRIME DIRECTIVE: an ABSENT measurement is not a measured regression. Rendering it must
    // never become a halt — a stopping gate takes reliability and quality to zero together.
    assert.equal(result.converged, true, 'an unmeasurable sweep must not block convergence');
    assert.equal(result.selfRedOpen, undefined, 'no self-red is open — nothing was measured');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER7-01 — the sweep's THIRD unmeasurable axis: the whole-repo tsc itself.
//
// AP-EXT-ITER47-01/48-01 taught `runInterfaceChangeSweep` to say "I could not measure" about its
// two git INPUTS. The gate it runs on them kept no such door. A per-check timeout (or the
// cumulative gate deadline) yields a `<timeout>` / GATE_CHECK_TIMEOUT pseudo-failure whose file
// matches no changed file and whose message yields no identifier, so `classifyNoDisown` always
// files it under `other` — the sweep returned `{ ran: true, selfIntroduced: [] }` over a typecheck
// that never once ran, and `applyInterfaceChangeSweepGuard` read that empty list as positive
// INV-NO-SELF-DISOWN evidence and let convergence proceed. Same shape AP-EXT-ITER6-01 closed one
// layer down in `runGate`: the ABSENCE of failures read as evidence of a clean measurement.
//
// Every pre-existing sweep case injects a `runGateFn` stub, so all of them stayed GREEN against
// the pre-fix runtime — the AP-EXT-ITER13-01 hand-authored-fixture failure again. These cases
// cross the REAL `runGate` producer and only vary its per-check budget.
// ---------------------------------------------------------------------------

// One repo, one typecheck script that always sleeps then passes. The timeout arm and its control
// differ ONLY in the budget handed to the gate, so a green control cannot come from a different
// script.
function makeSlowTypecheckRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'slow-typecheck-fixture',
      private: true,
      scripts: { typecheck: 'node typecheck.cjs' },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'typecheck.cjs'),
    'setTimeout(() => process.exit(0), 1500);\n',
  );
  fs.writeFileSync(path.join(dir, 'src', 'audit.ts'), 'export interface AuditResult { sum: number }\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = headSha(dir);
  fs.writeFileSync(path.join(dir, 'src', 'audit.ts'), 'export interface AuditResult { total: number }\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'change the exported shape']);
  return { dir, base };
}

const SWEEP_ENUMERATORS = {
  getChangedExportedSymbolsFn: () => new Set(['AuditResult']),
  getChangedFilesSinceFn: () => ['src/audit.ts'],
};

test('AP-EXT-ITER7-01: runGate surfaces check_status in-memory, so a timed-out check is legible to its caller', async () => {
  const { dir } = makeSlowTypecheckRepo('cg-apiter7-producer-');
  try {
    const timedOut = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck'],
      _timeouts: { perCheck: { typecheck: 300 } },
    });
    assert.equal(
      timedOut.check_status?.typecheck,
      'failed',
      'the per-check timeout must reach the CALLER, not just the persisted baseline file; ' +
      'without it an in-memory consumer can only infer measurement from the failure list',
    );
    assert.ok(
      timedOut.failures.some((f) => f.ruleOrCode === 'GATE_CHECK_TIMEOUT'),
      'the timeout pseudo-failure is what a consumer would otherwise have to sniff for',
    );

    // Control: same repo, same script, generous budget — the field must be able to say `ran`,
    // or "failed" would just be a constant.
    const measured = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck'],
      _timeouts: { perCheck: { typecheck: 30_000 } },
    });
    assert.equal(measured.check_status?.typecheck, 'ran', 'a completed check must report `ran`');
    assert.equal(measured.status, 'green', 'the control script exits 0 — this is a real measurement');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER7-01: a timed-out whole-repo tsc reaches the sweep as skipped, not as a clean no-disown verdict', async () => {
  const { dir, base } = makeSlowTypecheckRepo('cg-apiter7-chain-');
  try {
    const starved = await runInterfaceChangeSweep({
      workingDir: dir,
      sessionDir: dir,
      startCommit: base,
      runGateFn: (opts) => runGate({ ...opts, _timeouts: { perCheck: { typecheck: 300 } } }),
      logActivityFn: () => {},
      ...SWEEP_ENUMERATORS,
    });
    assert.equal(
      starved.ran,
      false,
      'a sweep whose typecheck never completed has NOT run; reporting `ran: true` with an empty ' +
      'selfIntroduced is a green INV-NO-SELF-DISOWN verdict over a guard that measured nothing',
    );
    assert.equal(
      starved.skipped,
      'typecheck_unmeasurable',
      'the failing AXIS must survive to the caller so the rendered line names what did not run',
    );
    assert.equal(starved.selfIntroduced.length, 0, 'nothing was measured, so nothing is self-introduced');

    // Control: identical chain, generous budget — the skip must not swallow a real sweep.
    const swept = await runInterfaceChangeSweep({
      workingDir: dir,
      sessionDir: dir,
      startCommit: base,
      runGateFn: (opts) => runGate({ ...opts, _timeouts: { perCheck: { typecheck: 30_000 } } }),
      logActivityFn: () => {},
      ...SWEEP_ENUMERATORS,
    });
    assert.equal(swept.ran, true, 'a completed typecheck is a real measurement — the sweep must run on it');
    assert.equal(swept.skipped, null, 'a sweep that RAN was never skipped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER7-01: an unmeasurable typecheck is RENDERED once and stays non-fatal', async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-apiter7-render-'));
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
      iteration: 7,
      startCommit: 'bbbb2222',
      _deps: {
        getHeadShaFn: () => 'aaaa1111',
        logActivityFn: () => {},
        writeMicroverseStateFn: () => {},
        runGateFn: async () => ({
          failures: [{
            check: 'typecheck',
            file: '<timeout>',
            line: 0,
            ruleOrCode: 'GATE_CHECK_TIMEOUT',
            message: 'typecheck timed out after 300ms',
            severity: 'error',
            occurrence_index: 0,
          }],
          check_status: { typecheck: 'failed' },
        }),
        ...SWEEP_ENUMERATORS,
      },
    });

    const rendered = logs.filter((line) => line.includes('typecheck_unmeasurable'));
    assert.equal(
      rendered.length,
      1,
      `the not-run reason must be surfaced exactly once; got logs: ${JSON.stringify(logs)}`,
    );
    assert.match(rendered[0], /NOT RUN/, 'the line must say the sweep did not run');

    // PRIME DIRECTIVE: an ABSENT measurement is not a measured regression. Rendering it must
    // never become a halt — a stopping gate takes reliability and quality to zero together.
    assert.equal(result.converged, true, 'an unmeasurable sweep must not block convergence');
    assert.equal(result.selfRedOpen, undefined, 'no self-red is open — nothing was measured');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER7-02: the SKIP half of the same hole. AP-EXT-ITER7-01 closed the
// FAILED arm (a check that ran and could not be measured); a gate that DECLINED to
// attempt the check still returned green with zero failures, and the sweep read that
// empty failure list as positive INV-NO-SELF-DISOWN evidence.
//
// These cases cross the REAL `runGate` and vary only whether it can classify the
// project — no stub, because a stub is exactly what cannot reach the skip exits.
// ---------------------------------------------------------------------------

/**
 * A repo the gate CANNOT classify: no marker at the root, and TWO child markers, so
 * `resolveProjectRootOneLevelDown` refuses to guess and `runGate` takes the
 * `no_project_type_detected` early exit. This is the shape every repo-agnostic target
 * hits — pickle-rick itself is one added `package.json` away from it.
 */
function makeUnclassifiableRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  for (const child of ['frontend', 'backend']) {
    fs.mkdirSync(path.join(dir, child), { recursive: true });
    fs.writeFileSync(
      path.join(dir, child, 'package.json'),
      JSON.stringify({ name: child, private: true }, null, 2),
    );
  }
  fs.writeFileSync(path.join(dir, 'frontend', 'audit.ts'), 'export interface AuditResult { sum: number }\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = headSha(dir);
  fs.writeFileSync(path.join(dir, 'frontend', 'audit.ts'), 'export interface AuditResult { total: number }\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'change the exported shape']);
  return { dir, base };
}

const UNCLASSIFIABLE_SWEEP_ENUMERATORS = {
  getChangedExportedSymbolsFn: () => new Set(['AuditResult']),
  getChangedFilesSinceFn: () => ['frontend/audit.ts'],
};

test('AP-EXT-ITER7-02: a gate that SKIPPED the typecheck declares it, instead of returning green with no record', async () => {
  const { dir } = makeUnclassifiableRepo('cg-apiter7b-producer-');
  try {
    const skipped = await runGate({
      workingDir: dir,
      mode: 'strict',
      scope: 'full',
      checks: ['typecheck'],
    });
    // The verdict was ALWAYS green here and still is — that is precisely why a
    // status/failure-count oracle greens over this bug. Assert the MEASUREMENT RECORD.
    assert.equal(skipped.status, 'green', 'a skip is not a red — the disposition is unchanged');
    assert.equal(skipped.failures.length, 0, 'nothing ran, so nothing failed');
    assert.equal(
      skipped.check_status?.typecheck,
      'skipped',
      'an early skip attempts no check, so it must SAY so; returning green with `check_status` ' +
      'absent entirely is indistinguishable from a gate that measured everything',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER7-02: a typecheck the gate never attempted reaches the sweep as skipped, not as a clean no-disown verdict', async () => {
  const { dir, base } = makeUnclassifiableRepo('cg-apiter7b-chain-');
  try {
    const unmeasured = await runInterfaceChangeSweep({
      workingDir: dir,
      sessionDir: dir,
      startCommit: base,
      runGateFn: runGate,
      logActivityFn: () => {},
      ...UNCLASSIFIABLE_SWEEP_ENUMERATORS,
    });
    assert.equal(
      unmeasured.ran,
      false,
      'a whole-repo typecheck the gate DECLINED to attempt is not a typecheck that found nothing; ' +
      'reporting `ran: true` hands applyInterfaceChangeSweepGuard positive INV-NO-SELF-DISOWN ' +
      'evidence for a measurement that never happened',
    );
    assert.equal(
      unmeasured.skipped,
      'typecheck_unmeasurable',
      'the skip must leave by the SAME unmeasurable door as the two git axes and the timeout arm',
    );
    assert.equal(unmeasured.selfIntroduced.length, 0, 'nothing was measured, so nothing is self-introduced');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER7-02 control: a typecheck that genuinely RAN still yields a real sweep', async () => {
  // Over-rejection control. Without it a fix could pass by calling every gate unmeasurable.
  const { dir, base } = makeSlowTypecheckRepo('cg-apiter7b-control-');
  try {
    const swept = await runInterfaceChangeSweep({
      workingDir: dir,
      sessionDir: dir,
      startCommit: base,
      runGateFn: (opts) => runGate({ ...opts, _timeouts: { perCheck: { typecheck: 30_000 } } }),
      logActivityFn: () => {},
      ...SWEEP_ENUMERATORS,
    });
    assert.equal(swept.ran, true, 'a completed typecheck is a real measurement — the sweep must run on it');
    assert.equal(swept.skipped, null, 'a sweep that RAN was never skipped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER7-02 fence control: a runGateFn stub carrying NO check_status is still read as measured', async () => {
  // This pins the RESIDUAL the fix deliberately leaves, and the reason it is safe.
  // `isCheckUnmeasured` keys on the PRESENCE of a `check_status` record, so the five
  // `runGateFn` stubs in `tests/microverse-interface-change-sweep.test.js` — bare
  // `{ failures: [...] }`, no `check_status` — are unaffected. That file sits outside this
  // loop's scope fence, so this behaviour is load-bearing, not incidental. If a future pass
  // tightens the predicate to demand `check_status?.typecheck === 'ran'` outright, this case
  // goes RED first and names the fixtures that must be updated in the same bundle.
  const { dir, base } = makeUnclassifiableRepo('cg-apiter7b-fence-');
  try {
    const stubbed = await runInterfaceChangeSweep({
      workingDir: dir,
      sessionDir: dir,
      startCommit: base,
      runGateFn: async () => ({ failures: [] }),
      logActivityFn: () => {},
      ...UNCLASSIFIABLE_SWEEP_ENUMERATORS,
    });
    assert.equal(
      stubbed.ran,
      true,
      'absent `check_status` means "not produced by runGate" — post-fix only a test double can ' +
      'produce that shape, and narrowing it is a separate, fixture-owning change',
    );
    assert.equal(stubbed.skipped, null, 'a stub that reported no failures reports no skip either');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER117-02 — the REPLAY of AP-EXT-ITER117-01's rename contract onto the OTHER
// enumeration in `convergence-gate.ts`. `getChangedSince` (the reader behind
// `getChangedFilesSince`, `selectWorkspaceTargetDirs` and `buildNoDisownContext`) omitted
// `--no-renames`, and a DETECTED rename under `--name-only` emits ONLY the destination.
//
// The fence's PRODUCER (`scope-resolver.ts:computeAllowedFromDiff` — `--name-status -M100 -z`)
// emits BOTH paths of the same rename, so the two halves of one diff disagreed about which
// files the phase touched — the AP-EXT-ITER24-01 / AP-EXT-ITER31-01 "one diff, two git
// contracts" class, reached on the rename axis instead of the quoting axis.
//
// These cases cross the REAL producer against a REAL repo and assert the gate STATUS: an
// injected `getChangedFilesSinceFn` cannot observe an argv, and the pre-fix defect was an
// executed `gate_run_complete` GREEN with no `gate_skipped` to give it away.
// ---------------------------------------------------------------------------

/**
 * A workspace whose second commit moves a file ACROSS package boundaries, byte for byte.
 * The package the file moves OUT of is the one whose check FAILS, so a gate that never
 * targets it can only report green.
 */
function makeCrossPackageMoveRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'user.email', 'test@example.com']);

  const sourceDir = path.join(dir, 'packages', 'source');
  const destDir = path.join(dir, 'packages', 'dest');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'workspace-root', private: true, workspaces: ['packages/*'],
  }, null, 2));
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
    name: 'source', version: '1.0.0', scripts: { test: 'node -e "process.exit(1)"' },
  }, null, 2));
  fs.writeFileSync(path.join(destDir, 'package.json'), JSON.stringify({
    name: 'dest', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2));
  fs.writeFileSync(path.join(sourceDir, 'mod.js'), 'module.exports = { a: 1, b: 2, c: 3, d: 4 };\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = headSha(dir);

  git(dir, ['mv', 'packages/source/mod.js', 'packages/dest/mod.js']);
  git(dir, ['commit', '-m', 'move the module across packages, byte for byte']);
  return { dir, base, sourceDir, destDir };
}

test('AP-EXT-ITER117-02: the changed-file enumeration reports BOTH sides of a rename', () => {
  const { dir, base } = makeCrossPackageMoveRepo('cg-apiter117b-producer-');
  try {
    // PRECONDITION: git really did record this as a rename. Without it the case would pass
    // on a delete+add repo, which was never the defect.
    const detected = execFileSync('git', ['diff', '--name-status', '-M100', `${base}..HEAD`], {
      cwd: dir, encoding: 'utf-8', timeout: 30_000,
    });
    assert.match(detected, /^R100\t/m, 'fixture precondition: git must detect the move as a rename');

    const measured = getChangedFilesSince(dir, base);
    assert.ok(Array.isArray(measured), 'a reachable base must yield a real list');
    assert.deepEqual(
      [...measured].sort(),
      ['packages/dest/mod.js', 'packages/source/mod.js'],
      'the fence PRODUCER (`--name-status -M100 -z`) emits both paths of a rename; a reader ' +
      'that emits only the destination disagrees with it about the same diff',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER117-02: a cross-package move still runs the package the file moved OUT of', async () => {
  const { dir, base } = makeCrossPackageMoveRepo('cg-apiter117b-consumer-');
  const events = [];
  try {
    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'changed', since: base, checks: ['tests'],
      onEvent: (e) => events.push(e.event),
    });

    assert.equal(
      result.status, 'red',
      'the source package still holds every importer of the moved module — a gate that never ' +
      'targets it reports an executed green over code it did not inspect',
    );
    assert.deepEqual(
      result.failures.map(f => path.relative(dir, f.file).replace(/\\/g, '/')),
      ['packages/source'],
    );
    assert.ok(
      !events.includes('gate_skipped'),
      'the pre-fix green was SILENT — it ran zero checks over `packages/source` and still ' +
      'emitted gate_run_complete, so a skip event was never the tell',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER117-02 control: narrowing still excludes a package nothing touched', async () => {
  // `--no-renames` widens the DIFF, never the pathspec: an ordinary edit confined to one
  // package must still leave the other package untargeted, or the fix has simply disabled
  // the narrowing it was meant to correct.
  const { dir, destDir } = makeCrossPackageMoveRepo('cg-apiter117b-control-');
  try {
    fs.writeFileSync(path.join(destDir, 'other.js'), 'module.exports = 1;\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'touch only the passing package']);

    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'],
    });

    assert.equal(result.status, 'green', 'the failing package was untouched — it must stay out of scope');
    assert.equal(result.total_raw_failure_count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER117-03 — the arming from AP-EXT-ITER117-01/-02 reaches a classifier that
// disowns the very break it was armed to catch.
//
// A phase that MOVES a module breaks its out-of-fence importers with `TS2307`. That message
// names the module it CANNOT find (`'./moved-audit.js'`) and never the file that moved, and
// the failing file is the importer — which the phase did not touch. So the file axis missed,
// and the identifier axis dropped the specifier outright (`idShape` rejects `./moved-audit.js`).
// MEASURED on the shipped compiled mirror against a real `git mv`: `selfIntroduced 0, other 1` —
// `INV-NO-SELF-DISOWN` disowned a whole-repo break the phase itself caused, and the sweep
// returned `ran: true` with nothing to report while the repo did not compile.
//
// These cases drive the REAL producers and the REAL sweep. A hand-built `NoDisownContext`
// cannot observe the specifier-resolution seam the way the real rename enumeration does.
// ---------------------------------------------------------------------------

/**
 * A repo whose second commit moves a module into a subdirectory, byte for byte, leaving an
 * out-of-fence importer behind. The `typecheck` script emits the tsc lines measured from a
 * real `tsc --noEmit` over exactly this shape, plus two failures that must NOT be owned.
 */
function makeMovedModuleRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ['init']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'user.email', 'test@example.com']);

  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'moved-module-fixture', private: true, scripts: { typecheck: 'node typecheck.cjs' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'typecheck.cjs'), [
    // 1. the phase's OWN break: an importer it never touched, naming the module it moved.
    'console.log("src/importer.ts(1,23): error TS2307: Cannot find module \'./moved-audit.js\' or its corresponding type declarations.");',
    // 2. a genuinely unrelated failure in a file nothing touched.
    'console.log("src/legacy.ts(4,9): error TS2554: Expected 1 arguments, but got 2.");',
    // 3. a relative specifier that resolves OUTSIDE the phase diff.
    'console.log("src/legacy.ts(6,1): error TS2307: Cannot find module \'./absent-helper.js\' or its corresponding type declarations.");',
    // 4. a BARE specifier whose stem collides with the moved module — must not be resolved.
    'console.log("src/legacy.ts(8,1): error TS2307: Cannot find module \'moved-audit\' or its corresponding type declarations.");',
    'process.exit(1);',
    '',
  ].join('\n'));
  fs.writeFileSync(
    path.join(dir, 'src', 'moved-audit.ts'),
    'export interface Payload { id: string }\nexport function build(p: Payload): string { return p.id; }\n',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'importer.ts'),
    "import { build } from './moved-audit.js';\nexport const out = build({ id: 'x' });\n",
  );
  fs.writeFileSync(path.join(dir, 'src', 'legacy.ts'), 'export const legacy = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'base']);
  const base = headSha(dir);

  fs.mkdirSync(path.join(dir, 'src', 'moved'), { recursive: true });
  git(dir, ['mv', 'src/moved-audit.ts', 'src/moved/moved-audit.ts']);
  git(dir, ['commit', '-m', 'move the module, byte for byte']);
  return { dir, base };
}

test('AP-EXT-ITER117-03: a move\'s TS2307 break in an out-of-fence importer is OWNED, not disowned', async () => {
  const { dir, base } = makeMovedModuleRepo('cg-apiter117c-own-');
  try {
    // PRECONDITIONS. Without these the case would pass for the wrong reason.
    const detected = execFileSync('git', ['diff', '--name-status', '-M100', `${base}..HEAD`], {
      cwd: dir, encoding: 'utf-8', timeout: 30_000,
    });
    assert.match(detected, /^R100\t/m, 'fixture precondition: git must record this as a rename');

    const changedFiles = getChangedFilesSince(dir, base);
    assert.ok(
      !changedFiles.includes('src/importer.ts'),
      'precondition: the importer is OUT of the phase diff — the file axis cannot own it',
    );
    assert.ok(
      getChangedExportedSymbols(dir, base).size > 0,
      'precondition: AP-EXT-ITER117-01 must still arm the sweep, or nothing runs at all',
    );

    const sweep = await runInterfaceChangeSweep({
      workingDir: dir,
      sessionDir: dir,
      startCommit: base,
      runGateFn: runGate,
      logActivityFn: () => {},
    });

    assert.equal(sweep.ran, true, 'the sweep must actually run');
    assert.deepEqual(
      sweep.selfIntroduced.map(f => `${path.relative(dir, f.file).replace(/\\/g, '/')}:${f.line}`),
      ['src/importer.ts:1'],
      'the phase moved the module, so the importer break is the phase\'s own; pre-fix this ' +
      'list was EMPTY and the sweep reported ran:true with nothing to escalate',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER117-03 control: unrelated failures and unresolvable specifiers stay disowned', async () => {
  // Owning the specifier must not degrade into owning every TS2307. Three siblings in the
  // same sweep must remain `other`: a plain unrelated error, a relative specifier resolving
  // outside the diff, and a BARE specifier whose stem matches the moved module by name.
  const { dir, base } = makeMovedModuleRepo('cg-apiter117c-control-');
  try {
    const sweep = await runInterfaceChangeSweep({
      workingDir: dir,
      sessionDir: dir,
      startCommit: base,
      runGateFn: runGate,
      logActivityFn: () => {},
    });

    assert.equal(sweep.ran, true);
    assert.deepEqual(
      sweep.selfIntroduced.map(f => path.relative(dir, f.file).replace(/\\/g, '/')),
      ['src/importer.ts'],
      'only the importer names a module the phase actually moved',
    );
    assert.equal(
      sweep.selfIntroduced.some(f => path.basename(f.file) === 'legacy.ts'), false,
      'a bare `moved-audit` request is a package lookup, and `./absent-helper.js` resolves ' +
      'nowhere in the diff — resolving specifiers must stay anchored, not become a stem match',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
