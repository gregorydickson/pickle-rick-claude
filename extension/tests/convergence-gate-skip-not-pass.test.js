// @tier: fast
// B-OFFREPO (AC-OFFREPO-1) — a runGate SKIP must never be reported as an executed
// PASS. `emptyGateResult()` is a bare `{ status: 'green', ... }` literal shared by
// every skip path inside runGate. Two of its three producers already emit the
// canonical `gate_skipped` event and return directly, bypassing
// `finalizeGateResult` (the function that emits `gate_run_complete`). The third —
// `resolveGateTargetDirs`'s no-changed-files early exit — used to be routed through
// `finalizeGateResult`, so a caller listening only for `gate_run_complete` saw
// `status: 'green'` for a check that never ran. This suite drives all three
// producers and asserts the same invariant holds for each: a `gate_skipped` event
// fires, and `gate_run_complete` never does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import {
  assignOccurrenceIndices,
  buildFailures,
  runGate,
  subtractBaseline,
} from '../services/convergence-gate.js';

async function withGitFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-skip-not-pass-'));
  try {
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: dir, stdio: 'pipe' });
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function captureEvents() {
  const events = [];
  return { events, onEvent: (event, data) => events.push({ event, data }) };
}

test('runGate: no_changed_files skip emits gate_skipped, never gate_run_complete', async () => {
  await withGitFixture(async dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'root', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    const { events, onEvent } = captureEvents();
    // HEAD~1 doesn't resolve (only one commit exists) → getChangedSince returns [] →
    // resolveGateTargetDirs's no-changed-files early exit fires.
    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'],
      onEvent,
    });

    assert.equal(result.status, 'green', 'return value shape is unchanged by this fix');
    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(skipped, 'gate_skipped must be emitted for the no-changed-files skip');
    assert.equal(skipped.data.reason, 'no_changed_files');
    assert.equal(
      events.find(e => e.event === 'gate_run_complete'),
      undefined,
      'gate_run_complete must NOT be emitted — this skip never executed any check'
    );
    // The pre-existing diff-scope-fallback event is preserved (pinned by the "all
    // 14 gate event names" source-grep test elsewhere) — this fix is additive.
    assert.ok(events.find(e => e.event === 'gate_diff_scope_fallback'));
  });
});

test('runGate: dirty_worktree_no_rescue skip emits gate_skipped, never gate_run_complete', async () => {
  await withGitFixture(async dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'root', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
    // Dirty the worktree.
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted\n');

    const { events, onEvent } = captureEvents();
    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'],
      workerMode: true, onEvent,
    });

    assert.equal(result.status, 'green');
    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(skipped, 'gate_skipped must be emitted for the dirty-worktree worker-mode skip');
    assert.equal(skipped.data.reason, 'dirty_worktree_no_rescue');
    assert.equal(
      events.find(e => e.event === 'gate_run_complete'),
      undefined,
      'gate_run_complete must NOT be emitted — this skip never executed any check'
    );
  });
});

test('runGate: no_project_type_detected skip emits gate_skipped, never gate_run_complete', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-skip-empty-'));
  try {
    const { events, onEvent } = captureEvents();
    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'], onEvent,
    });

    assert.equal(result.status, 'green');
    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(skipped, 'gate_skipped must be emitted for the no-project-type skip');
    assert.equal(skipped.data.reason, 'no_project_type_detected');
    assert.equal(
      events.find(e => e.event === 'gate_run_complete'),
      undefined,
      'gate_run_complete must NOT be emitted — this skip never executed any check'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// AP-EXT-ITER20-01 — the sibling of "a skip is not a pass": a baseline SUBTRACTION that
// cancels the wrong check is also a green that never happened. `buildFailures`' unparsed
// fallback keys every check identically (`file: pkgDir`, `ruleOrCode: String(exitCode)`,
// `line: 0`), and `tests` has no granular parser, so it ALWAYS takes that shape when red.
// A repo whose suite is red at baseline capture therefore has a coarse `tests` entry
// standing by to absorb the first coarse `typecheck`/`lint` failure the phase introduces.
// Both the ordinal grouping and the fingerprint must key on `check` for that to be
// impossible — hence the shared identity key.
function coarse(check, exitCode = '1', dir = '/repo') {
  return {
    check, file: dir, line: 0, ruleOrCode: exitCode,
    message: `${check} failed`, severity: 'error', occurrence_index: 0,
  };
}

function baselineOf(failures) {
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    working_dir: '/repo',
    project_type: 'npm',
    checks: ['typecheck', 'lint', 'tests'],
    failures: assignOccurrenceIndices(failures),
  };
}

test('subtractBaseline: a coarse typecheck failure is NOT cancelled by a baselined coarse tests failure', () => {
  const baseline = baselineOf([coarse('tests')]);
  // This iteration: the suite went green, but the phase broke the typecheck (tsc exited
  // non-zero with output the tsc parser could not attribute → the coarse fallback).
  const current = assignOccurrenceIndices([coarse('typecheck')]);

  const newFailures = subtractBaseline(current, baseline);

  assert.equal(newFailures.length, 1, 'a brand-new coarse typecheck failure must survive subtraction');
  assert.equal(newFailures[0].check, 'typecheck');
});

test('subtractBaseline: a coarse timeout is scoped to its own check', () => {
  const timeout = (check) => ({
    check, file: '<timeout>', line: 0, ruleOrCode: 'GATE_CHECK_TIMEOUT',
    message: `${check} timed out`, severity: 'error', occurrence_index: 0,
  });
  const newFailures = subtractBaseline(
    assignOccurrenceIndices([timeout('typecheck')]),
    baselineOf([timeout('tests')]),
  );
  assert.equal(newFailures.length, 1, 'a newly-timing-out typecheck is not a baselined tests timeout');
});

test('subtractBaseline: the surviving failure is the NEW check, not the still-red baselined one', () => {
  const baseline = baselineOf([coarse('tests')]);
  // Same red tests as the baseline PLUS a new coarse typecheck break. Cross-check ordinal
  // grouping used to hand occurrence 0 to typecheck (subtracted) and occurrence 1 to the
  // unchanged tests failure (reported) — red for the wrong reason, at the wrong check.
  const current = assignOccurrenceIndices([coarse('typecheck'), coarse('tests')]);

  const newFailures = subtractBaseline(current, baseline);

  assert.equal(newFailures.length, 1);
  assert.equal(newFailures[0].check, 'typecheck', 'the regression the phase introduced is the one reported');
});

test('subtractBaseline: a genuinely pre-existing coarse failure is still subtracted', () => {
  const baseline = baselineOf([coarse('tests')]);
  const newFailures = subtractBaseline(assignOccurrenceIndices([coarse('tests')]), baseline);
  assert.equal(newFailures.length, 0, 'the same red check must not be re-reported as a regression');
});

test('assignOccurrenceIndices: ordinals are counted within one check, not across checks', () => {
  const indexed = assignOccurrenceIndices([coarse('typecheck'), coarse('lint'), coarse('tests')]);
  assert.deepEqual(
    indexed.map(f => `${f.check}:${f.occurrence_index}`).sort(),
    ['lint:0', 'tests:0', 'typecheck:0'],
    'three different checks are three separate identities, each its own occurrence 0'
  );
});

// AP-EXT-ITER34-01 — the fourth, worse variant of this file's thesis: not a skip
// mis-reported as a pass, but a gate that RUNS NOTHING and reports an executed
// `gate_run_complete` green, with no `gate_skipped` to give it away.
// `selectWorkspaceTargetDirs` narrows the workspace packages using two
// REPO-ROOT-relative inputs (`getChangedSince`'s output and `opts.allowedPaths`,
// i.e. `scope.json:allowed_paths`) but resolved them against `opts.workingDir` —
// which R-SZGB-A `detectProjectTypeWithRootResolution` may already have rewritten
// to a package dir one level down. Every candidate then filtered out.
// Every other workspace fixture in this repo puts the workspace root AT the git
// root, so the two path spaces coincide by accident and the narrowing matches for
// the wrong reason. These cases put it ONE LEVEL BELOW and assert the gate STATUS.
function buildNestedWorkspaceRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nested-ws-root-'));
  execSync('git init', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
  execSync('git config user.email "t@t.com"', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
  execSync('git config user.name "T"', { cwd: dir, stdio: 'pipe', timeout: 30_000 });

  // No project marker at the git root: `app/` is the lone depth-1 candidate, so
  // R-SZGB-A rewrites `workingDir` to it.
  const appDir = path.join(dir, 'app');
  const passingDir = path.join(appDir, 'packages', 'passing');
  const failingDir = path.join(appDir, 'packages', 'failing');
  fs.mkdirSync(passingDir, { recursive: true });
  fs.mkdirSync(failingDir, { recursive: true });

  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'workspace-root', private: true, workspaces: ['packages/*'],
  }, null, 2));
  fs.writeFileSync(path.join(passingDir, 'package.json'), JSON.stringify({
    name: 'passing', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' },
  }, null, 2));
  fs.writeFileSync(path.join(failingDir, 'package.json'), JSON.stringify({
    name: 'failing', version: '1.0.0', scripts: { test: 'node -e "process.exit(1)"' },
  }, null, 2));
  fs.writeFileSync(path.join(passingDir, 'src.js'), 'v1\n');
  fs.writeFileSync(path.join(failingDir, 'src.js'), 'v1\n');

  execSync('git add .', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
  execSync('git commit -m "init nested workspace"', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
  return { dir, passingDir, failingDir };
}

function commitTouch(dir, fileDir) {
  fs.writeFileSync(path.join(fileDir, 'src.js'), 'v2\n');
  execSync('git add .', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
  execSync('git commit -m "touch package"', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
}

test('AP-EXT-ITER34-01: nested workspace root — scope=changed runs the changed workspace package', async () => {
  const { dir, failingDir } = buildNestedWorkspaceRepo();
  try {
    commitTouch(dir, failingDir);
    const { events, onEvent } = captureEvents();

    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'], onEvent,
    });

    assert.equal(result.status, 'red', 'a workspace root below the git root must still run the changed package');
    assert.equal(result.total_raw_failure_count, 1);
    assert.deepEqual(
      result.failures.map(f => path.relative(dir, f.file).replace(/\\/g, '/')),
      ['app/packages/failing'],
    );
    assert.ok(
      !events.some(e => e.event === 'gate_skipped'),
      'the pre-fix green was silent — running zero checks did not even announce itself as a skip',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER34-01: nested workspace root — narrowing still excludes untouched packages', async () => {
  const { dir, passingDir } = buildNestedWorkspaceRepo();
  try {
    commitTouch(dir, passingDir);

    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'],
    });

    assert.equal(result.status, 'green', 'the repo-root base must narrow, not disable narrowing');
    assert.equal(result.total_raw_failure_count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER34-01: nested workspace root — repo-root-relative allowedPaths keep the owning package in scope', async () => {
  const { dir } = buildNestedWorkspaceRepo();
  try {
    // `scope.json:allowed_paths` is spelled from the REPO ROOT, like git's diff output.
    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'],
      allowedPaths: ['app/packages/failing/**'],
    });

    assert.equal(result.status, 'red', 'repo-root-relative allowedPaths must resolve against the repo root');
    assert.equal(result.total_raw_failure_count, 1);
    assert.deepEqual(
      result.failures.map(f => path.relative(dir, f.file).replace(/\\/g, '/')),
      ['app/packages/failing'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER34-01: nested workspace root — changed-file narrowing composes with allowedPaths', async () => {
  const { dir, failingDir } = buildNestedWorkspaceRepo();
  try {
    commitTouch(dir, failingDir);

    // Both narrowing arms active at once — the production per-iteration gate shape
    // (`since` from the iteration SHA, `allowedPaths` from scope.json).
    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'],
      allowedPaths: ['app/packages/failing/**'],
    });

    assert.equal(result.status, 'red');
    assert.equal(result.total_raw_failure_count, 1);
    assert.deepEqual(
      result.failures.map(f => path.relative(dir, f.file).replace(/\\/g, '/')),
      ['app/packages/failing'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// AP-EXT-ITER130-01 — the same false green as AP-EXT-ITER34-01, reached through the ONE
// narrowing input that fix did not resolve. `e9636cf1` added the root-control-file expansion
// (`WORKSPACE_ROOT_CONTROL_FILES`) so that a change to the workspace root manifest widens the
// gate back to EVERY package, and pinned it with FLAT fixtures only — workspace root AT the git
// root, where `package.json` is spelled the same in both path spaces. Both of the predicate's
// inputs are REPO-ROOT-relative while every member of the set is WORKSPACE-ROOT-relative, so one
// level down (`app/package.json`) the expansion was inert: a change set mixing the root manifest
// with one package's file narrowed to that package alone and `gate_run_complete` reported green
// over every sibling the manifest change affects. Measured before the fix on this exact fixture:
// `status: green`, zero failures, no `gate_skipped`.
function commitMixedRootAndPackage(dir, appDir, fileDir) {
  const pkgPath = path.join(appDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  pkg.version = '2.0.0';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(fileDir, 'src.js'), 'v2\n');
  execSync('git add .', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
  execSync('git commit -m "bump root manifest and touch one package"', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
}

test('AP-EXT-ITER130-01: nested workspace root — a changed root manifest expands scope to every workspace package', async () => {
  const { dir, passingDir } = buildNestedWorkspaceRepo();
  try {
    // MIXED on purpose: the root manifest alone empties the candidate set and lands in the
    // AP-EXT-ITER121-01 declared skip, which is honest. It is the mix that produces a green —
    // one package survives the narrowing, so the gate runs, passes, and reports an executed pass.
    commitMixedRootAndPackage(dir, path.join(dir, 'app'), passingDir);
    const { events, onEvent } = captureEvents();

    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'], onEvent,
    });

    assert.equal(result.status, 'red', 'a root manifest below the git root must still widen scope to every package');
    assert.equal(result.total_raw_failure_count, 1);
    assert.deepEqual(
      result.failures.map(f => path.relative(dir, f.file).replace(/\\/g, '/')),
      ['app/packages/failing'],
      'the package the changed manifest never touched is the one that must still be measured',
    );
    assert.ok(
      !events.some(e => e.event === 'gate_skipped'),
      'the pre-fix green was silent — it ran one package of two and announced nothing',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER130-01: nested workspace root — a root manifest in allowedPaths expands scope to every workspace package', async () => {
  const { dir } = buildNestedWorkspaceRepo();
  try {
    // The allowedPaths arm of the same predicate, spelled the way `scope.json:allowed_paths` is.
    // Mixed for the same reason: `app/packages/passing/**` is what keeps a candidate alive, so a
    // missed expansion is a green rather than the declared empty-target-set skip.
    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'],
      allowedPaths: ['app/package.json', 'app/packages/passing/**'],
    });

    assert.equal(result.status, 'red', 'a root manifest in allowedPaths must widen scope past the packages it names');
    assert.equal(result.total_raw_failure_count, 1);
    assert.deepEqual(
      result.failures.map(f => path.relative(dir, f.file).replace(/\\/g, '/')),
      ['app/packages/failing'],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER130-01 control: a changed NON-control root file still narrows to the owning package', async () => {
  const { dir, passingDir } = buildNestedWorkspaceRepo();
  try {
    // Over-rejection control. Same shape as the headline — a root-level file plus one package's
    // file — but the root file is not a workspace control file, so the expansion must NOT fire
    // and the failing package must stay out of scope. Resolving into the workspace path space
    // must widen the SET's reach, never turn every repo-root path into a whole-workspace run.
    fs.writeFileSync(path.join(dir, 'README.md'), 'v2\n');
    fs.writeFileSync(path.join(passingDir, 'src.js'), 'v2\n');
    execSync('git add .', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
    execSync('git commit -m "touch a non-control root file and one package"', { cwd: dir, stdio: 'pipe', timeout: 30_000 });

    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'],
    });

    assert.equal(result.status, 'green', 'narrowing must still narrow — only the 7 control files widen scope');
    assert.equal(result.total_raw_failure_count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// AP-EXT-ITER38-02 — the fifth variant of this file's thesis, reached by the
// ENUMERATION-FAILURE axis rather than AP-EXT-ITER34-01's path-space axis.
// `getChangedSince` maps ANY git failure (unreachable/rebased-away `since` SHA,
// timeout) to `[]`, so an empty changed set is never distinguishable from
// "nothing changed" — it must be DECLARED as a skip, never narrowed against.
// `resolveGateTargetDirs`'s flat arm always declared it; `selectWorkspaceTargetDirs`
// narrowed instead (`affectsAllWorkspacePackages([])` is false, so the package
// filter excluded every candidate), returning `[]` with NO event and letting
// `finalizeGateResult` report an executed `gate_run_complete` green over a gate
// that ran ZERO checks. Assert the EVENTS, not the status: the pre-fix return
// value was already `green`, so a status-only oracle greens over its own bug.
test('AP-EXT-ITER38-02: nested workspace root — an unresolvable `since` is a declared skip, not a silent green', async () => {
  const { dir } = buildNestedWorkspaceRepo();
  try {
    const { events, onEvent } = captureEvents();

    // A SHA that does not resolve → `git diff` exits non-zero → getChangedSince
    // returns []. `failing`'s test script exits 1, so a gate that actually ran
    // would be RED; the pre-fix workspace arm reported green having run nothing.
    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'changed', since: '0'.repeat(40), checks: ['tests'],
      onEvent,
    });

    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(skipped, 'the workspace arm must declare the empty changed set as a skip');
    assert.equal(skipped.data.reason, 'no_changed_files');
    assert.ok(events.find(e => e.event === 'gate_diff_scope_fallback'));
    assert.equal(
      events.find(e => e.event === 'gate_run_complete'),
      undefined,
      'gate_run_complete must NOT be emitted — this gate executed zero checks',
    );
    assert.equal(result.status, 'green', 'the skip result shape matches the other skip producers');
    assert.equal(result.total_raw_failure_count, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER38-02: nested workspace root — a resolvable `since` still runs the changed package', async () => {
  const { dir, failingDir } = buildNestedWorkspaceRepo();
  try {
    commitTouch(dir, failingDir);
    const { events, onEvent } = captureEvents();

    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'], onEvent,
    });

    // The skip arm must not swallow a real changed set — narrowing still happens.
    assert.equal(result.status, 'red', 'a non-empty changed set must still reach the package filter');
    assert.equal(result.total_raw_failure_count, 1);
    assert.ok(
      !events.some(e => e.event === 'gate_skipped'),
      'a gate that ran checks must not report itself as skipped',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER38-02: nested workspace root — scope=full never consults the changed set', async () => {
  const { dir } = buildNestedWorkspaceRepo();
  try {
    const { events, onEvent } = captureEvents();

    // No `since` at all: the skip arm is unreachable and every package runs.
    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'], onEvent,
    });

    assert.equal(result.status, 'red', 'scope=full runs every workspace package');
    assert.ok(
      !events.some(e => e.event === 'gate_skipped'),
      'the empty-changed-set skip must not fire when scope is not `changed`',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER107-01 — a pre-measurement git probe that DID NOT COMPLETE is not an
// observation. Both producers used to read `.stdout` with no completion check and
// fabricated opposite verdicts from the same unread probe: `workerModeSkipResult`
// read an unreadable `git status` as a CLEAN tree (skip silently declined to fire),
// and `gitDriftResult` read an unreadable `git rev-parse` as HEAD `''`, which
// mismatches every expected value and produced a `GATE_WORKINGDIR_DRIFT` red
// reporting `got ""`. Both now route through the shared `enumerationCompleted`
// predicate and land on the one `worktree_unreadable` skip.
//
// `core.repositoryformatversion 99` is the fixture: git refuses EVERY command in the
// repo (`fatal: Expected git repo version <= 1, found 99`) while the on-disk worktree
// — including its dirtiness — is untouched, so "the probe failed" is isolated from
// "the tree changed".
// ---------------------------------------------------------------------------

function breakGitRepoFormat(dir) {
  execSync('git config core.repositoryformatversion 99', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
}

test('AP-EXT-ITER107-01: unreadable `git status` is not a clean tree — worker mode skips as worktree_unreadable', async () => {
  await withGitFixture(async dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'root', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
    // The tree IS dirty; only the probe is taken away.
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted\n');
    breakGitRepoFormat(dir);

    const { events, onEvent } = captureEvents();
    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'],
      workerMode: true, onEvent,
    });

    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(skipped, 'an unreadable worktree must skip, not read as clean and fall through to measurement');
    assert.equal(skipped.data.reason, 'worktree_unreadable');
    assert.equal(result.status, 'green');
    assert.deepEqual(result.check_status, { tests: 'skipped' }, 'the skip must record that it measured nothing');
    assert.equal(
      events.find(e => e.event === 'gate_run_complete'),
      undefined,
      'gate_run_complete must NOT be emitted — this skip never executed any check',
    );
  });
});

test('AP-EXT-ITER107-01: unreadable `git rev-parse` is not HEAD "" — drift is not fabricated', async () => {
  await withGitFixture(async dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'root', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    execSync('git add .', { cwd: dir, stdio: 'pipe' });
    execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
    const realHead = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8', timeout: 30_000 }).trim();
    breakGitRepoFormat(dir);

    const { events, onEvent } = captureEvents();
    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'],
      expected_head: realHead, expected_branch: 'main', onEvent,
    });

    assert.ok(
      !result.failures.some(f => f.ruleOrCode === 'GATE_WORKINGDIR_DRIFT'),
      `an unread rev-parse must not fabricate drift; got ${JSON.stringify(result.failures)}`,
    );
    assert.equal(
      events.find(e => e.event === 'gate_workingdir_drift_detected'),
      undefined,
      'no drift was observed, so no drift event may be emitted',
    );
    assert.equal(
      fs.existsSync(path.join(dir, 'gate')),
      false,
      'no drift report file may be written for a comparison that never ran',
    );

    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(skipped, 'the unreadable probe must land on the shared skip');
    assert.equal(skipped.data.reason, 'worktree_unreadable');
    assert.equal(
      events.find(e => e.event === 'gate_run_complete'),
      undefined,
      'gate_run_complete must NOT be emitted — the drift skip never executed any check',
    );
  });
});

// ---------------------------------------------------------------------------
// E1 (B-OFFREPO) — the RECORD half of this file's thesis.
//
// Every case above proves a skip is distinguishable by its EVENTS
// (`gate_skipped` fires, `gate_run_complete` does not). That oracle is blind to
// the field an in-memory caller actually reads: `GateResult.check_status`. A
// caller holding the returned object never saw the event stream, and the verdict
// it does see was ALWAYS `green` with ZERO failures — so a status or
// failure-count oracle greens over the whole defect. These cases assert the
// MEASUREMENT RECORD instead.
//
// The two shapes are the ones a repo-agnostic gate actually meets, and they
// deliberately collapse to ONE door (`no_project_type_detected`): an
// unrecognised project type, and a package that EXISTS but sits one level too
// deep for `resolveProjectRootOneLevelDown`'s depth-1 scan. Neither shape is
// covered elsewhere — the sibling record assert in
// `convergence-gate-no-disown-wiring.test.js` reaches this door only via a
// two-child-marker root, and no fixture in this repo puts a package at depth 2.
//
// `status` stays `green` in all three, ON PURPOSE. A skip is a non-halting
// disposition: every strict consumer keys on `status === 'red'`, so reddening a
// skip would convert an honest "not measured" into a new halt path. Honesty is a
// REPORTING property (`check_status`); halting is a DISPOSITION (`status`). The
// third case is the other direction — without a gate that genuinely RAN, a fix
// that stamps `skipped` on everything would pass the first two.
// ---------------------------------------------------------------------------

const ALL_CHECKS = ['typecheck', 'lint', 'tests'];

// `async` + `await` are load-bearing: a non-async wrapper returning `fn(dir)` runs its
// `finally` when the promise is CREATED, deleting the fixture before the gate ever reads it.
// The skip cases would then still pass — an absent directory has no project type either — i.e.
// pass for the wrong reason, which is the same fake-green this file exists to prevent.
async function withTmpDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runGateOnFixture(dir) {
  const { events, onEvent } = captureEvents();
  const result = await runGate({
    workingDir: dir, mode: 'strict', scope: 'full', checks: ALL_CHECKS, onEvent,
  });
  return { result, events };
}

function assertEveryCheckRecorded(result, expected, why) {
  for (const check of ALL_CHECKS) {
    assert.equal(result.check_status?.[check], expected, `${check}: ${why}`);
  }
}

test('E1/AC-E1b: an UNRECOGNISED project type records every check as skipped, not as a pass', async () => {
  await withTmpDir('cg-e1-no-type-', async dir => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'main.rb'), "puts 'no marker the gate knows'\n");

    const { result, events } = await runGateOnFixture(dir);

    assert.equal(result.status, 'green', 'a skip is not a red — the disposition must stay non-halting');
    assert.equal(result.failures.length, 0, 'nothing ran, so nothing failed');
    assertEveryCheckRecorded(
      result, 'skipped',
      'the gate could not classify this project, so it attempted no check and must SAY so; ' +
      'green with an absent or "ran" record is indistinguishable from a gate that measured everything',
    );
    assert.equal(
      events.find(e => e.event === 'gate_run_complete'), undefined,
      'gate_run_complete must NOT be emitted — this gate executed no check',
    );
  });
});

test('E1/AC-E1b: a monorepo package DEEPER THAN ONE LEVEL records every check as skipped', async () => {
  await withTmpDir('cg-e1-depth2-', async dir => {
    // `packages/app/` is the ordinary workspace layout, but `resolveProjectRootOneLevelDown`
    // scans IMMEDIATE children only: `packages/` carries no marker, so the real package one
    // level below it is never found and the gate takes the same no_project_type_detected exit.
    const pkgDir = path.join(dir, 'packages', 'app');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
      name: 'app', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));

    const { result, events } = await runGateOnFixture(dir);

    assert.equal(result.status, 'green', 'an unreachable package is not a regression — do not halt on it');
    assert.equal(result.failures.length, 0, 'nothing ran, so nothing failed');
    assertEveryCheckRecorded(
      result, 'skipped',
      'the package sits below the depth-1 scan, so the gate ran nothing against it; reporting ' +
      'this as measured would certify a monorepo the gate never entered',
    );
    assert.equal(
      events.find(e => e.event === 'gate_run_complete'), undefined,
      'gate_run_complete must NOT be emitted — the package was never reached',
    );
  });
});

test('E1/AC-E1b control: a gate that RAN AND PASSED records every check as ran', async () => {
  // The other direction. The two cases above are satisfied by ANY implementation that
  // stamps `skipped` unconditionally, which would be the same fake-green bug pointing the
  // other way — a gate that ran and passed reported as unmeasured. This case is what makes
  // the pair a DISCRIMINATION: same `status: 'green'`, opposite measurement record.
  await withTmpDir('cg-e1-ran-', async dir => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'ran-and-passed',
      version: '1.0.0',
      scripts: {
        typecheck: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }, null, 2));

    const { result, events } = await runGateOnFixture(dir);

    assert.equal(result.status, 'green', 'every check passed');
    assert.equal(result.failures.length, 0, 'a passing gate reports no failures');
    assertEveryCheckRecorded(
      result, 'ran',
      'this gate genuinely executed the check — recording it as skipped would discard a real ' +
      'measurement and is the same conflation in reverse',
    );
    assert.ok(
      events.find(e => e.event === 'gate_run_complete'),
      'a gate that executed its checks must report an executed run',
    );
    assert.equal(
      events.find(e => e.event === 'gate_skipped'), undefined,
      'nothing was skipped',
    );
  });
});

// AP-EXT-ITER121-01 — the fifth variant, and the one the AP-EXT-ITER34-01 cases above
// could not reach: the narrowing is CORRECT and still empties the candidate set, because
// the changed/allowed paths genuinely live under no workspace package. `e9636cf1` closed
// this for a 7-member `WORKSPACE_ROOT_CONTROL_FILES` enumeration (`package.json` + six
// lockfiles); every other root path — `tools/`, `scripts/`, `docs/`, `.github/` — still
// fell through with `targetDirs: []`, ran zero checks, and reported an executed
// `gate_run_complete` green. `hasUnmeasuredCheck` cannot catch it either: an all-`skipped`
// check_status reads as measured by design. The disposition now hangs off the EMPTIED SET,
// so no future root path can be the eighth omission.
function writeRootOnlyFile(dir) {
  const toolsDir = path.join(dir, 'app', 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(path.join(toolsDir, 'build.js'), 'v1\n');
  return 'app/tools/build.js';
}

test('AP-EXT-ITER121-01: allowedPaths under no workspace package is a declared skip, not an executed green', async () => {
  const { dir } = buildNestedWorkspaceRepo();
  try {
    const rootOnly = writeRootOnlyFile(dir);
    const { events, onEvent } = captureEvents();

    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'],
      allowedPaths: [rootOnly], onEvent,
    });

    assert.equal(result.status, 'green', 'nothing ran, so there is nothing to be red about');
    assert.deepEqual(result.check_status, { tests: 'skipped' }, 'zero checks were attempted');
    assert.ok(
      events.some(e => e.event === 'gate_skipped' && e.data.reason === 'no_target_dir_in_scope'),
      'a gate that ran zero checks must announce itself as a skip',
    );
    assert.ok(
      !events.some(e => e.event === 'gate_run_complete'),
      'pre-fix this reported an executed gate_run_complete pass over a gate that inspected nothing',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER121-01: a changed set under no workspace package takes the same declared skip', async () => {
  const { dir } = buildNestedWorkspaceRepo();
  try {
    writeRootOnlyFile(dir);
    execSync('git add .', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
    execSync('git commit -m "root-only change"', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
    const { events, onEvent } = captureEvents();

    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'changed', since: 'HEAD~1', checks: ['tests'], onEvent,
    });

    // The enumeration SUCCEEDED and is non-empty, so the AP-EXT-ITER38-02
    // `no_changed_files` arm cannot cover this — both causes must meet at one skip.
    assert.ok(
      !events.some(e => e.event === 'gate_skipped' && e.data.reason === 'no_changed_files'),
      'the changed set is non-empty; this is the narrowing arm, not the empty-enumeration arm',
    );
    assert.equal(result.status, 'green');
    assert.deepEqual(result.check_status, { tests: 'skipped' });
    assert.ok(
      events.some(e => e.event === 'gate_skipped' && e.data.reason === 'no_target_dir_in_scope'),
      'a non-empty changed set that resolves under no package still ran zero checks',
    );
    assert.ok(!events.some(e => e.event === 'gate_run_complete'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER121-01 control: a non-empty target set still runs and still reports an executed gate', async () => {
  const { dir } = buildNestedWorkspaceRepo();
  try {
    writeRootOnlyFile(dir);
    const { events, onEvent } = captureEvents();

    const result = await runGate({
      workingDir: dir, mode: 'strict', scope: 'full', checks: ['tests'],
      allowedPaths: ['app/packages/failing/**'], onEvent,
    });

    assert.equal(result.status, 'red', 'the declared skip must not swallow a target set that resolves');
    assert.equal(result.total_raw_failure_count, 1);
    assert.deepEqual(result.check_status, { tests: 'ran' });
    assert.ok(!events.some(e => e.event === 'gate_skipped'));
    assert.ok(events.some(e => e.event === 'gate_run_complete'), 'an executed gate still reports as executed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R-FBTN — a red `tests` check must surface the failing TEST NAMES, not a bare status.
//
// Measured at the time this pin was written, over a REAL 5,663-byte `node --test` run with three
// failures: `buildFailures(result, 'tests', dir)` returned ONE coarse failure whose `message` was
// `output.slice(0, 500)` — the HEAD of the stream, which for any streaming reporter is the PASSING
// tests. 0 of 3 names reached ANY of the three operator-visible render sites, and the single line
// `check-gate` printed for a RED gate began with a green checkmark.
//
// Every pin below is paired with a CONTROL ARM that runs the SAME oracle over the pre-fix coarse
// shape and asserts it FAILS to surface / FAILS to discriminate. Without the control arm a pin like
// this passes forever by never firing: an oracle that is trivially true (a counter that always
// returns "all surfaced") is green against the fix AND against the defect. The control arms fire on
// their own — they assert a concrete non-zero fact about the old shape, not merely `!pinCondition`.
// ---------------------------------------------------------------------------

// `node --test`'s spec reporter, verbatim in shape: each failure is printed inline AND repeated in
// a trailing summary block under a `✖ failing tests:` SECTION HEADER, and every name carries a
// duration suffix. TAP is appended so the fixture pins BOTH reporter shapes rather than only the
// one that happens to dominate this repo.
const FBTN_SPEC_REPORTER_OUTPUT = [
  '✔ backendEnvOverrides: worker invocation with a ticket injects core.hooksPath (27.727166ms)',
  '✔ backendEnvOverrides: inherited GIT_CONFIG_COUNT=2 composes at index 2 (19.78825ms)',
  '✔ backendEnvOverrides: never hardcodes GIT_CONFIG_KEY_0 (20.038583ms)',
  '✖ backendEnvOverrides: materialization failure emits neither key and logs once (9.016ms)',
  '✔ another passing case (1.5ms)',
  '✖ AC-WDTFTO-1-1: timed-out worker WITH a window commit preserves the sha (226.686833ms)',
  'ℹ tests 22',
  'ℹ fail 2',
  '',
  '✖ failing tests:',
  '',
  'test at tests/services/backend-spawn-trailer-env.test.js:118:1',
  '✖ backendEnvOverrides: materialization failure emits neither key and logs once (9.016ms)',
  "  AssertionError [ERR_ASSERTION]: expected 'a' to equal 'b'",
  '      at Test.run (node:internal/test_runner/test:1382:25)',
  'test at tests/worker-timeout-preserves-commit.test.js:120:1',
  '✖ AC-WDTFTO-1-1: timed-out worker WITH a window commit preserves the sha (226.686833ms)',
].join('\n');

const FBTN_TAP_REPORTER_OUTPUT = [
  'TAP version 13',
  '# Subtest: adds two numbers',
  'ok 1 - adds two numbers',
  '# Subtest: rejects a negative amount',
  'not ok 2 - rejects a negative amount',
  '  ---',
  '  duration_ms: 1.2',
  '  ...',
  'not ok 3 - handles a unicode ✔ inside the name',
  '1..3',
  '# fail 2',
].join('\n');

const FBTN_SPEC_FAILING_NAMES = [
  'backendEnvOverrides: materialization failure emits neither key and logs once',
  'AC-WDTFTO-1-1: timed-out worker WITH a window commit preserves the sha',
];
const FBTN_TAP_FAILING_NAMES = [
  'rejects a negative amount',
  'handles a unicode ✔ inside the name',
];

// Reproduces `check-gate.ts:136` — the narrowest of the three operator-visible render sites, so a
// name that survives this one survives `finalize-gate.ts:225` and `:337` too.
function fbtnRenderCheckGateReport(failures) {
  return failures
    .map(f => `  [${f.check}] ${f.file}:${f.line} ${f.ruleOrCode} — ${f.message.slice(0, 120)}`)
    .join('\n');
}

function fbtnNamesSurfaced(failures, names) {
  const report = fbtnRenderCheckGateReport(failures);
  return names.filter(name => report.includes(name)).length;
}

// The shape `buildFailures` produced for a red `tests` check before R-FBTN: the generic fallback,
// keyed by exit code, carrying a 500-char HEAD slice of the output.
function fbtnCoarsePreFixFailure(output, pkgDir, exitCode = 1) {
  return {
    check: 'tests',
    file: pkgDir,
    line: 0,
    ruleOrCode: String(exitCode),
    message: output.slice(0, 500),
    severity: 'error',
    occurrence_index: 0,
  };
}

test('R-FBTN: a red tests check surfaces every failing test name in the operator report', () => {
  const failures = buildFailures(
    { stdout: FBTN_SPEC_REPORTER_OUTPUT, stderr: '', exitCode: 1 },
    'tests',
    '/repo/pkg',
  );

  assert.equal(
    fbtnNamesSurfaced(failures, FBTN_SPEC_FAILING_NAMES),
    FBTN_SPEC_FAILING_NAMES.length,
    'every failing test name must appear in the rendered check-gate report',
  );
  // Not merely "the text is somewhere in there": the name must be the failure's IDENTITY, because
  // `failureIdentityKey` is `check::file::ruleOrCode` and baseline subtraction matches on it.
  assert.deepEqual(
    failures.map(f => f.ruleOrCode),
    FBTN_SPEC_FAILING_NAMES,
    'the test name is the failure identity, in first-seen order',
  );
  // The reporter prints each failure twice; the summary repeat must not become a second failure.
  assert.equal(failures.length, FBTN_SPEC_FAILING_NAMES.length, 'summary repeats are deduped');
  // `✖ failing tests:` is a section header, not a test.
  assert.ok(
    !failures.some(f => f.ruleOrCode.endsWith(':')),
    'a reporter section header must never be reported as a failing test',
  );
});

test('R-FBTN control arm: the pre-fix coarse shape surfaces ZERO names through the same oracle', () => {
  const coarse = [fbtnCoarsePreFixFailure(FBTN_SPEC_REPORTER_OUTPUT, '/repo/pkg')];

  assert.equal(
    fbtnNamesSurfaced(coarse, FBTN_SPEC_FAILING_NAMES),
    0,
    'the oracle must be able to SEE the defect — if this is non-zero the pin above proves nothing',
  );
  // The defect stated positively, so this arm asserts a fact of its own rather than the negation of
  // the pin: what the operator actually read on a RED gate was a PASSING test.
  const report = fbtnRenderCheckGateReport(coarse);
  assert.ok(
    report.includes('✔ backendEnvOverrides: worker invocation with a ticket injects core.hooksPath'),
    'the pre-fix report led with a green checkmark on a red gate',
  );
});

test('R-FBTN: TAP `not ok` lines surface too — the parser is not spec-reporter-only', () => {
  const failures = buildFailures(
    { stdout: FBTN_TAP_REPORTER_OUTPUT, stderr: '', exitCode: 1 },
    'tests',
    '/repo/pkg',
  );

  assert.deepEqual(failures.map(f => f.ruleOrCode), FBTN_TAP_FAILING_NAMES);
  assert.equal(
    fbtnNamesSurfaced(failures, FBTN_TAP_FAILING_NAMES),
    FBTN_TAP_FAILING_NAMES.length,
  );
  assert.ok(
    !failures.some(f => f.ruleOrCode.startsWith('adds two numbers')),
    'a passing `ok` line must never be reported as a failure',
  );
});

test('R-FBTN: per-test identities are distinct, so baseline subtraction can tell them apart', () => {
  const failures = buildFailures(
    { stdout: FBTN_SPEC_REPORTER_OUTPUT, stderr: '', exitCode: 1 },
    'tests',
    '/repo/pkg',
  );

  // `assignOccurrenceIndices` groups by `failureIdentityKey`. All-zero ordinals mean every failure
  // occupies its OWN identity, which is exactly what the subtraction needs to distinguish a
  // brand-new failing test from a baselined one.
  //
  // The expectation is a LITERAL derived from the fixture, never from `failures` itself: an oracle
  // shaped `failures.map(() => 0)` is trivially true for any array of length <= 1, so it stayed
  // GREEN against a parser that returned nothing and fell back to the single coarse failure. Pinning
  // the cardinality here is what makes this arm fire on the defect it exists to catch.
  assert.deepEqual(
    assignOccurrenceIndices(failures).map(f => f.occurrence_index),
    FBTN_SPEC_FAILING_NAMES.map(() => 0),
    'each failing test must own a distinct failure identity, one per failing test',
  );
});

test('R-FBTN control arm: the pre-fix coarse shape collapses every failing test into ONE identity', () => {
  const coarse = FBTN_SPEC_FAILING_NAMES.map(
    () => fbtnCoarsePreFixFailure(FBTN_SPEC_REPORTER_OUTPUT, '/repo/pkg'),
  );

  // 0,1,2 — one identity carrying three ordinals. This is the aliasing `failureIdentityKey`'s own
  // comment describes, and it is why the granularity pin above is load-bearing rather than cosmetic.
  assert.deepEqual(
    assignOccurrenceIndices(coarse).map(f => f.occurrence_index),
    FBTN_SPEC_FAILING_NAMES.map((_, i) => i),
    'the oracle must be able to SEE the collapse — if these were all 0 the pin above proves nothing',
  );
});

test('R-FBTN: an unrecognised reporter FAILS OPEN to the existing coarse fallback', () => {
  const unknown = 'Tests: 3 failed, 10 passed\nSomething broke in a way no marker describes';
  const failures = buildFailures({ stdout: unknown, stderr: '', exitCode: 2 }, 'tests', '/repo/pkg');

  // Exactly today's behaviour — no new failure mode, no abort, no throw. A reporter the marker
  // alphabet does not cover costs the CURRENT report and never less.
  assert.equal(failures.length, 1);
  assert.equal(failures[0].ruleOrCode, '2', 'the fallback still keys on the exit code');
  assert.ok(failures[0].message.includes('Something broke'));
});

test('R-FBTN: a passing tests check is still green — granularity never invents a failure', () => {
  assert.deepEqual(
    buildFailures({ stdout: FBTN_SPEC_REPORTER_OUTPUT, stderr: '', exitCode: 0 }, 'tests', '/repo/pkg'),
    [],
    'exit 0 short-circuits before any parsing, however many ✖ glyphs the output contains',
  );
});
