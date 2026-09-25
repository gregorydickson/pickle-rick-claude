// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setupAnatomyPark, writePipelineStatus, writeSkippedByScope } from '../bin/pipeline-runner.js';
import { finalizeGateMain } from '../bin/finalize-gate.js';
import { filterBySubsystem } from '../services/scope-resolver.js';

// B-LANES: filterBySubsystem takes lane records; these cases name plain one-dir lanes.
const lane = (name) => ({ name, dir: name, excludes: [], testRatioApplies: true, fileCount: 0 });
const keptNames = (names, ...rest) => filterBySubsystem(names.map(lane), ...rest).map((l) => l.name);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// R-CIFB: resolve the extension root from the REPO (not the deployed
// ~/.claude/pickle-rick), so setupAnatomyPark spawns extension/bin/init-microverse.js
// from the repo. CI never runs install.sh, so the deployed path is absent there
// (was the dominant chronic-CI-red failure: init-microverse.js MODULE_NOT_FOUND).
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const ANATOMY_PARK_MD = path.resolve(__dirname, '../../.claude/commands/anatomy-park.md');
const CHECK_SCOPE_DIFF = path.resolve(__dirname, '..', 'bin', 'check-scope-diff.js');

function makeTarget() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-scope-target-'));
}

function makeSession() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-scope-session-'));
}

function writeState(sessionDir, workingDir) {
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({
      active: false,
      working_dir: workingDir,
      step: 'review',
      iteration: 0,
      max_iterations: 10,
      max_time_minutes: 60,
      worker_timeout_seconds: 1200,
      start_time_epoch: Math.floor(Date.now() / 1000),
      completion_promise: null,
      original_prompt: 'test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: sessionDir,
    }, null, 2),
  );
}

function makeSubsystem(root, name, fileCount = 3) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.ts`), `export const x${i} = ${i};\n`);
  }
}

function readAnatomyPark(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'anatomy-park.json'), 'utf-8'));
}

function readMicroverse(sessionDir) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'microverse.json'), 'utf-8'));
}

// ---------------------------------------------------------------------------
// Pipeline mode: scope filters subsystems in anatomy-park.json
// ---------------------------------------------------------------------------

test('pipeline filter: 4 subsystems, scope covering 2 → anatomy-park.json has exactly those 2', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    makeSubsystem(target, 'gamma');
    makeSubsystem(target, 'delta');

    // scope touches alpha and gamma only
    const allowedPaths = ['alpha/f0.ts', 'gamma/f1.ts'];
    const repoRoot = target; // target IS repoRoot in this fixture

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {}, { allowedPaths, repoRoot });

    const ap = readAnatomyPark(session);
    assert.deepStrictEqual(ap.subsystems, ['alpha', 'gamma']);
    assert.deepStrictEqual(ap.pass_counts, { alpha: 0, gamma: 0 });
    assert.deepStrictEqual(ap.consecutive_clean, { alpha: 0, gamma: 0 });
    assert.deepStrictEqual(ap.stall_counts, { alpha: 0, gamma: 0 });
    assert.deepStrictEqual(ap.findings_history, { alpha: [], gamma: [] });
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('B-LANES: a split lane persists its record, prints its excludes, and a generated .js admits no lane', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'big/a', 20);
    makeSubsystem(target, 'big/b', 20);
    makeSubsystem(target, 'big/loose', 2);
    fs.mkdirSync(path.join(target, 'big', 'src'), { recursive: true });
    fs.writeFileSync(path.join(target, 'big', 'src', 'gen.ts'), 'export const g = 1;\n');
    fs.writeFileSync(path.join(target, 'big', 'gen.js'), 'exports.g = 1;\n');
    fs.writeFileSync(path.join(target, 'big', 'tsconfig.json'), '{ "compilerOptions": { "outDir": ".", "rootDir": "src" } }');

    // Scope names ONLY the compiled twin of big/src/gen.ts plus one loose remainder file.
    const onlyGenerated = setupAnatomyPark(makeSession(), target, 3, EXTENSION_ROOT, () => {}, {
      allowedPaths: ['big/gen.js'], repoRoot: target,
    });
    assert.deepStrictEqual(onlyGenerated, { skipReason: 'empty_scope' }, 'a generated file belongs to no lane');

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {}, {
      allowedPaths: ['big/loose/f0.ts', 'big/gen.js'], repoRoot: target,
    });
    const ap = readAnatomyPark(session);
    assert.deepStrictEqual(ap.subsystems, ['big/.']);
    assert.deepStrictEqual(ap.lanes, [
      { name: 'big/.', dir: 'big', excludes: ['big/a', 'big/b'], testRatioApplies: false, fileCount: 3 },
    ]);
    const prd = fs.readFileSync(path.join(session, 'prd.md'), 'utf-8');
    assert.match(prd, /1\. big\/\. \(3 files\) — reviews big\/ EXCLUDING big\/a\/, big\/b\/ \(other lanes\)/);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B-LANES: lane-less code is REPORTED (files_unmapped), never silently green
// ---------------------------------------------------------------------------

// Lanes of this fixture: extension/. (loose.ts), extension/src/bin, extension/src/services,
// extension/tests. Repo-root install.sh and anything outside a source directory belong to no lane.
function makeExtensionTarget() {
  const target = makeTarget();
  makeSubsystem(target, 'extension/src/bin', 20);
  fs.writeFileSync(path.join(target, 'extension/src/bin/setup.ts'), 'export const s = 1;\n');
  makeSubsystem(target, 'extension/src/services', 20);
  makeSubsystem(target, 'extension/tests/unit', 20);
  fs.writeFileSync(path.join(target, 'extension/loose.ts'), 'export const l = 1;\n');
  fs.mkdirSync(path.join(target, 'extension/templates'), { recursive: true });
  fs.writeFileSync(path.join(target, 'extension/templates/_pickle-manager-prompt.md'), '# prompt\n');
  return target;
}

function scopeJson(allowedPaths) {
  return {
    version: 1, mode: 'branch', strategy: 'strict',
    base_ref: 'main', base_sha: null, head_sha: 'deadbeef'.repeat(5),
    allowed_paths: allowedPaths,
    resolved_at: new Date().toISOString(),
    refresh_history: [],
  };
}

function readSkippedByScope(session) {
  return JSON.parse(fs.readFileSync(path.join(session, 'archive', 'skipped_by_scope.anatomy-park.json'), 'utf-8'));
}

// Runs `fn` with activity writes sandboxed to a private data root; returns the recorded event names.
function withActivityCapture(fn) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-scope-data-'));
  const prior = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    fn();
    const dir = path.join(dataRoot, 'activity');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    return files
      .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf-8').split('\n').filter(Boolean))
      .map((line) => JSON.parse(line));
  } finally {
    if (prior === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prior;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

test('AC-7: a doc-only scope skips as empty_scope, emits its event, and records no unmapped code', () => {
  const session = makeSession();
  const target = makeExtensionTarget();
  try {
    let result;
    const events = withActivityCapture(() => {
      result = setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {}, {
        allowedPaths: ['prds/x.md'], repoRoot: target,
      });
    });
    assert.deepStrictEqual(result, { skipReason: 'empty_scope' });
    assert.ok(
      events.some((e) => e.event === 'anatomy_park_empty_scope_skip'
        && JSON.stringify(e.gate_payload.in_scope_paths) === JSON.stringify(['prds/x.md'])),
      'the skip event must still fire',
    );
    writeSkippedByScope(session, 'anatomy-park', scopeJson(['prds/x.md']), target, target);
    assert.deepStrictEqual(readSkippedByScope(session).files_unmapped, [], 'a .md file is not code, so nothing is unmapped');
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('AC-7: a template under the extension lane is admitted by the remainder lane extension/.', () => {
  const session = makeSession();
  const target = makeExtensionTarget();
  try {
    const result = setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {}, {
      allowedPaths: ['extension/templates/_pickle-manager-prompt.md'], repoRoot: target,
    });
    assert.equal(result, true);
    assert.deepStrictEqual(readAnatomyPark(session).subsystems, ['extension/.']);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('AC-7: repo-root install.sh beside a lane-admitted file is recorded in files_unmapped and logged', () => {
  const session = makeSession();
  const target = makeExtensionTarget();
  try {
    const logs = [];
    const allowedPaths = ['install.sh', 'extension/src/bin/setup.ts'];
    const result = setupAnatomyPark(session, target, 3, EXTENSION_ROOT, (m) => logs.push(m), {
      allowedPaths, repoRoot: target,
    });
    assert.equal(result, true, 'reporting must not skip or halt the phase');
    assert.deepStrictEqual(readAnatomyPark(session).subsystems, ['extension/src/bin']);
    assert.match(logs.join('\n'), /1 changed code path\(s\) belong to no lane \(files_unmapped\): install\.sh/);

    writeSkippedByScope(session, 'anatomy-park', scopeJson(allowedPaths), target, target);
    const record = readSkippedByScope(session);
    assert.deepStrictEqual(record.files_unmapped, ['install.sh']);
    assert.deepStrictEqual(record.subsystems_kept, ['extension/src/bin']);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('AC-7: a scope of ONLY lane-less code is empty_scope, still non-degraded, and names its unmapped files', () => {
  const session = makeSession();
  const target = makeExtensionTarget();
  try {
    const logs = [];
    const result = setupAnatomyPark(session, target, 3, EXTENSION_ROOT, (m) => logs.push(m), {
      allowedPaths: ['install.sh', 'scripts/release.py', 'README.md'], repoRoot: target,
    });
    assert.deepStrictEqual(result, { skipReason: 'empty_scope' }, 'no new skip reason');
    assert.match(logs.join('\n'), /2 changed code path\(s\) belong to no lane \(files_unmapped\): install\.sh, scripts\/release\.py/);
    writeSkippedByScope(session, 'anatomy-park', scopeJson(['install.sh', 'scripts/release.py', 'README.md']), target, target);
    assert.deepStrictEqual(readSkippedByScope(session).files_unmapped, ['install.sh', 'scripts/release.py']);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('AC-8: each lane names the nearest existing ancestor CLAUDE.md as its trap-door catalog', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'extension/src/core', 20);
    makeSubsystem(target, 'extension/tests/integration', 20);
    makeSubsystem(target, 'extension/tests/unit', 20);
    fs.writeFileSync(path.join(target, 'extension/CLAUDE.md'), '# extension catalog\n');
    fs.writeFileSync(path.join(target, 'extension/tests/unit/CLAUDE.md'), '# unit catalog\n');

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {});
    assert.deepStrictEqual(
      readAnatomyPark(session).subsystems,
      ['extension/src', 'extension/tests/integration', 'extension/tests/unit'],
    );
    const prd = fs.readFileSync(path.join(session, 'prd.md'), 'utf-8');
    assert.match(prd, /extension\/tests\/integration → extension\/CLAUDE\.md/, 'no swept catalog of its own: nearest ancestor');
    assert.match(prd, /extension\/src → extension\/CLAUDE\.md/);
    assert.match(prd, /extension\/tests\/unit → extension\/tests\/unit\/CLAUDE\.md/, 'a lane that owns a catalog keeps it');
    assert.doesNotMatch(prd, /extension\/tests\/integration → extension\/tests\/integration\/CLAUDE\.md/);
    assert.match(prd, /never create a new CLAUDE\.md/i);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('R-PSSS-1: anatomy-park scope excluding all subsystems skips with a structured WARN', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');

    const logs = [];
    // allowed_paths touch only docs — they match no discovered subsystem.
    const ok = setupAnatomyPark(session, target, 3, EXTENSION_ROOT, (m) => logs.push(m), {
      allowedPaths: ['docs/guide.md', 'README.md'],
      repoRoot: target,
    });

    assert.deepStrictEqual(ok, { skipReason: 'empty_scope' }, 'setup must skip with an empty_scope disposition');
    const warn = logs.join('\n');
    assert.match(warn, /⚠ anatomy-park did not run/);
    assert.match(warn, /scope filter excluded all subsystems/);
    assert.match(warn, /docs\/guide\.md/, 'WARN must name the in-scope diff paths');
    assert.equal(
      fs.existsSync(path.join(session, 'anatomy-park.json')), false,
      'no anatomy-park.json must be written on an empty-scope skip',
    );
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('R-PSSS-3: anatomy-park with no subsystems returns a no_subsystems skip disposition', () => {
  const session = makeSession();
  const target = makeTarget(); // empty target — no subsystem directories
  try {
    const ok = setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {});
    assert.deepStrictEqual(ok, { skipReason: 'no_subsystems' });
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

// AP-EXT-ITER320-01 — an UNLISTABLE target was reported as a repo with no subsystems.
//
// `subsystemRoots` swallows a failed listing into `[]`, so `discoverSubsystems` returns
// an empty roster for both "no subsystem directories" and "the target could not be read".
// `no_subsystems` is deliberately OUTSIDE `DEGRADED_PHASE_SKIP_REASONS`, so a missing or
// relocated target skipped anatomy-park AND kept the success verdict — a review phase
// certifying a tree nobody listed. The ACCEPT control is the case directly above: an empty
// but LISTABLE target must still resolve to `no_subsystems`, so the discriminator cannot
// be satisfied by refusing everything. The reason -> verdict half is already pinned by
// AP-EXT-ITER289-01 in pipeline-runner-phase-fail-continue.test.js.
//
// Both causes are root-independent on purpose: a mode-based fixture is vacuous under uid 0.
test('AP-EXT-ITER320-01: a target that cannot be listed is a setup_error, not no_subsystems', () => {
  const session = makeSession();
  const absent = path.join(os.tmpdir(), `ap-scope-absent-${process.pid}-${Date.now()}`);
  try {
    assert.equal(fs.existsSync(absent), false, 'fixture precondition: the target must not exist');
    const logs = [];
    const ok = setupAnatomyPark(session, absent, 3, EXTENSION_ROOT, (m) => logs.push(m));
    assert.deepStrictEqual(
      ok, { skipReason: 'setup_error' },
      'a target that does not exist was never listed — the phase skip must withhold success',
    );
    assert.match(
      logs.join('\n'), /could not be listed/,
      'the log must name the real cause, not "no subsystems"',
    );
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER320-01: a target that is a file, not a directory, is a setup_error', () => {
  const session = makeSession();
  const asFile = path.join(os.tmpdir(), `ap-scope-notdir-${process.pid}-${Date.now()}`);
  fs.writeFileSync(asFile, 'this is a file, not a subsystem tree\n');
  try {
    const ok = setupAnatomyPark(session, asFile, 3, EXTENSION_ROOT, () => {});
    assert.deepStrictEqual(
      ok, { skipReason: 'setup_error' },
      'a non-directory target cannot be listed, so the phase skip must withhold success',
    );
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(asFile, { force: true });
  }
});

test('R-PSSS-3: writePipelineStatus persists non-empty phase_skips and omits an empty map', () => {
  const dir = makeSession();
  try {
    writePipelineStatus(dir, 'running', { phase_skips: { 'anatomy-park': 'empty_scope' } });
    const withSkips = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));
    assert.deepStrictEqual(withSkips.phase_skips, { 'anatomy-park': 'empty_scope' });

    writePipelineStatus(dir, 'running', { phase_skips: {} });
    const noSkips = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));
    assert.equal('phase_skips' in noSkips, false, 'an empty phase_skips map must be omitted from the status file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pipeline setup writes anatomy-park.json through shared atomic writer before init-microverse consumes it', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');

    const compiledPipelineRunner = fs.readFileSync(
      new URL('../bin/pipeline-runner.js', import.meta.url),
      'utf-8',
    );
    assert.ok(
      compiledPipelineRunner.includes("writeStateFile(path.join(sessionDir, 'anatomy-park.json'), apState)"),
      'anatomy setup must publish anatomy-park.json through the shared tmp-rename writer',
    );

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {});

    assert.deepStrictEqual(readAnatomyPark(session).subsystems, ['alpha']);
    assert.equal(readMicroverse(session).convergence_file, 'anatomy-park.json');
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('pipeline scoped setup injects allowed_paths into microverse.json so final gate honors out-of-scope failures', async () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    writeState(session, target);
    fs.writeFileSync(
      path.join(session, 'scope.json'),
      JSON.stringify({ allowed_paths: ['alpha/f0.ts'], mode: 'branch', strategy: 'strict', head_sha: 'abc123' }),
    );

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {}, {
      allowedPaths: ['alpha/f0.ts'],
      repoRoot: target,
    });

    const mv = readMicroverse(session);
    assert.deepStrictEqual(mv.allowed_paths, ['alpha/f0.ts']);

    const gateDir = path.join(session, 'gate');
    let remediatorCalled = false;
    const code = await finalizeGateMain({
      argv: [session, 'anatomy-park'],
      env: {},
      readStateForWorkingDirFn: () => ({ workingDir: target, backend: 'claude' }),
      loadSettingsFn: () => ({
        szechuan_max_remediation_cycles: 3,
        anatomy_park_max_remediation_cycles: 1,
        remediator_timeout_s: 60,
      }),
      runGateFn: async () => ({
        status: 'red',
        failures: [{
          check: 'lint',
          file: path.join(target, 'beta/f0.ts'),
          line: 1,
          ruleOrCode: 'no-any',
          message: 'out of scope',
          severity: 'error',
          occurrence_index: 0,
        }],
        baseline_used: false,
        allowed_paths_used: false,
        elapsed_ms: 5,
        total_raw_failure_count: 1,
        new_failures_vs_baseline: 0,
      }),
      spawnGateRemediatorMainFn: async () => {
        remediatorCalled = true;
        return 0;
      },
      spawnRemediatorFn: () => {
        remediatorCalled = true;
      },
      stdout: () => {},
      stderr: () => {},
    });

    assert.equal(code, 0, 'final gate should close when every failure is out of scope');
    assert.equal(remediatorCalled, false, 'remediator must not run for out-of-scope failures');

    const gateFiles = fs.readdirSync(gateDir);
    assert.equal(gateFiles.filter(f => f.startsWith('out_of_scope_failures_')).length, 1);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('resume: persisted scope.json still filters anatomy-park when refreshScope already entered the phase', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    writeState(session, target);
    fs.writeFileSync(
      path.join(session, 'scope.json'),
      JSON.stringify({ allowed_paths: ['alpha/f0.ts'], mode: 'branch', strategy: 'strict', head_sha: 'abc123' }),
    );

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {});

    const ap = readAnatomyPark(session);
    const mv = readMicroverse(session);
    assert.deepStrictEqual(ap.subsystems, ['alpha']);
    assert.deepStrictEqual(mv.allowed_paths, ['alpha/f0.ts']);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('resume: persisted scope.json promotes newer dead tmp before filtering anatomy-park', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    writeState(session, target);
    const scopePath = path.join(session, 'scope.json');
    fs.writeFileSync(
      scopePath,
      JSON.stringify({ allowed_paths: ['beta/f0.ts'], mode: 'branch', strategy: 'strict', head_sha: 'old' }),
    );
    fs.writeFileSync(
      `${scopePath}.tmp.99999999`,
      JSON.stringify({ allowed_paths: ['alpha/f0.ts'], mode: 'branch', strategy: 'strict', head_sha: 'new' }),
    );
    fs.utimesSync(`${scopePath}.tmp.99999999`, new Date(Date.now() + 1_000), new Date(Date.now() + 1_000));

    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {});

    const ap = readAnatomyPark(session);
    const mv = readMicroverse(session);
    assert.deepStrictEqual(ap.subsystems, ['alpha']);
    assert.deepStrictEqual(mv.allowed_paths, ['alpha/f0.ts']);
    assert.equal(fs.existsSync(`${scopePath}.tmp.99999999`), false);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER321-01: the RESUME arm's scope base is a proven git toplevel.
//
// Every fixture above puts `state.working_dir` AT the target, where the working-dir and
// repo-root path spaces coincide — so none of them can fail on the defect these two cases
// pin. A real git repo and a below-toplevel `working_dir` are the only way to separate them.
// ---------------------------------------------------------------------------

function makeGitTarget() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-scope-gitrepo-'));
  for (const argv of [['init', '-q', '.'], ['config', 'user.email', 'ap@test'], ['config', 'user.name', 'AP']]) {
    const r = spawnSync('git', ['-C', root, ...argv], { encoding: 'utf-8', timeout: 5_000 });
    assert.equal(r.status, 0, `git ${argv[0]} failed: ${r.stderr}`);
  }
  return root;
}

function writeResumeScope(sessionDir, allowedPaths) {
  fs.writeFileSync(
    path.join(sessionDir, 'scope.json'),
    JSON.stringify({ allowed_paths: allowedPaths, mode: 'branch', strategy: 'strict', head_sha: 'abc123' }),
  );
}

test('AP-EXT-ITER321-01: a resume below the git toplevel keeps the SAME subsystems as the toplevel reading', () => {
  const target = makeGitTarget();
  const below = path.join(target, 'pkg', 'sub');
  const sessionTop = makeSession();
  const sessionBelow = makeSession();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    fs.mkdirSync(below, { recursive: true });

    // FIXTURE PRECONDITION: this fixture genuinely separates the two path spaces. Without
    // it the agreement assertion below could green on a fixture where they coincide.
    assert.deepStrictEqual(keptNames(['alpha'], ['alpha/f0.ts'], target, below), []);
    assert.deepStrictEqual(keptNames(['alpha'], ['alpha/f0.ts'], target, target), ['alpha']);

    writeResumeScope(sessionTop, ['alpha/f0.ts']);
    writeState(sessionTop, target);
    writeResumeScope(sessionBelow, ['alpha/f0.ts']);
    writeState(sessionBelow, below);

    const atTop = setupAnatomyPark(sessionTop, target, 3, EXTENSION_ROOT, () => {});
    const fromBelow = setupAnatomyPark(sessionBelow, target, 3, EXTENSION_ROOT, () => {});

    assert.equal(atTop, true);
    // Asserted to AGREE with the toplevel reading on the same tree, not merely to be
    // non-empty: pre-fix this was `{ skipReason: 'empty_scope' }` and the phase never ran.
    assert.equal(fromBelow, true);
    assert.deepStrictEqual(
      readAnatomyPark(sessionBelow).subsystems,
      readAnatomyPark(sessionTop).subsystems,
    );
    assert.deepStrictEqual(readAnatomyPark(sessionTop).subsystems, ['alpha']);
  } finally {
    fs.rmSync(sessionTop, { recursive: true, force: true });
    fs.rmSync(sessionBelow, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER321-01: anchoring the resume base RESOLVES it, it does not widen the kept set', () => {
  const target = makeGitTarget();
  const below = path.join(target, 'pkg', 'sub');
  const sessionKeep = makeSession();
  const sessionSkip = makeSession();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    fs.mkdirSync(below, { recursive: true });

    // ACCEPT control: from the SAME below-toplevel working_dir the filter still
    // discriminates — a scope naming only beta keeps beta and drops alpha, so the case
    // above cannot be satisfied by a base that keeps everything.
    writeResumeScope(sessionKeep, ['beta/f0.ts']);
    writeState(sessionKeep, below);
    assert.equal(setupAnatomyPark(sessionKeep, target, 3, EXTENSION_ROOT, () => {}), true);
    assert.deepStrictEqual(readAnatomyPark(sessionKeep).subsystems, ['beta']);

    // REJECT control: a scope naming no subsystem at all still skips as empty_scope, so
    // the anchor did not disarm the skip it is meant to stop MISFIRING.
    writeResumeScope(sessionSkip, ['gamma/f0.ts']);
    writeState(sessionSkip, below);
    assert.deepStrictEqual(
      setupAnatomyPark(sessionSkip, target, 3, EXTENSION_ROOT, () => {}),
      { skipReason: 'empty_scope' },
    );
  } finally {
    fs.rmSync(sessionKeep, { recursive: true, force: true });
    fs.rmSync(sessionSkip, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Standalone mode parity: filterBySubsystem with same fixture → same result
// ---------------------------------------------------------------------------

test('standalone filter parity: filterBySubsystem same fixture → identical to pipeline result', () => {
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    makeSubsystem(target, 'gamma');
    makeSubsystem(target, 'delta');

    const allowedPaths = ['alpha/f0.ts', 'gamma/f1.ts'];
    const repoRoot = target;
    const allNames = ['alpha', 'beta', 'delta', 'gamma']; // sorted

    const result = keptNames(allNames, allowedPaths, target, repoRoot);
    assert.deepStrictEqual(result, ['alpha', 'gamma']);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Phase 1 invariant: marker present — guarantees Phase 1 reads all subsystem files
// ---------------------------------------------------------------------------

test('phase-1 invariant marker present in anatomy-park.md', () => {
  const content = fs.readFileSync(ANATOMY_PARK_MD, 'utf-8');
  assert.ok(
    content.includes('<!-- scope-invariant: phase-1-reads-all-subsystem-files -->'),
    'anatomy-park.md must contain scope-invariant marker',
  );
});

// ---------------------------------------------------------------------------
// Standalone-mode ordering: scope-hook fires AFTER Step 6.5 creates scope.json
// ---------------------------------------------------------------------------

test('standalone scope-hook is placed after Step 6.5 (Resolve Scope) in anatomy-park.md', () => {
  const content = fs.readFileSync(ANATOMY_PARK_MD, 'utf-8');
  const hookIdx = content.indexOf('<!-- scope-hook: discovery-filter -->');
  const resolveStepIdx = content.indexOf('### Step 6.5: Resolve Scope');
  assert.ok(hookIdx > 0, 'scope-hook: discovery-filter marker missing from anatomy-park.md');
  assert.ok(resolveStepIdx > 0, 'Step 6.5 heading missing from anatomy-park.md');
  assert.ok(
    hookIdx > resolveStepIdx,
    'scope-hook must appear after Step 6.5 so scope.json exists when the filter fires',
  );
});

test('standalone scope-hook does not reference a nonexistent "full" mode', () => {
  const content = fs.readFileSync(ANATOMY_PARK_MD, 'utf-8');
  assert.ok(
    !/\bfull\b/.test(content.match(/<!-- scope-hook: discovery-filter -->[\s\S]*?\n\n/)?.[0] ?? ''),
    'scope-hook block must not reference a "full" mode (ScopeMode = branch|diff|paths only)',
  );
});

test('Step 7 references --allowed-paths-file after Step 6.5 (scope wiring for standalone mode)', () => {
  const content = fs.readFileSync(ANATOMY_PARK_MD, 'utf-8');
  const stepIdx = content.indexOf('### Step 6.5: Resolve Scope');
  const createIdx = content.indexOf('### Step 7: Create anatomy-park.json and microverse.json');
  const flagIdx = content.lastIndexOf('--allowed-paths-file');
  assert.ok(stepIdx > 0, 'Step 6.5 heading must exist in anatomy-park.md');
  assert.ok(createIdx > stepIdx, 'Step 7 must come after Step 6.5');
  assert.ok(
    flagIdx > createIdx,
    '--allowed-paths-file must appear in the init-microverse command after scope.json has been created',
  );
});

// ---------------------------------------------------------------------------
// Backcompat: omitted scope → all subsystems pass through unfiltered
// ---------------------------------------------------------------------------

test('backcompat: no scope arg → anatomy-park.json contains all 4 subsystems', () => {
  const session = makeSession();
  const target = makeTarget();
  try {
    makeSubsystem(target, 'alpha');
    makeSubsystem(target, 'beta');
    makeSubsystem(target, 'gamma');
    makeSubsystem(target, 'delta');

    // No scope passed — backcompat path
    setupAnatomyPark(session, target, 3, EXTENSION_ROOT, () => {});

    const ap = readAnatomyPark(session);
    const mv = readMicroverse(session);
    assert.equal(ap.subsystems.length, 4);
    assert.deepStrictEqual(ap.subsystems.sort(), ['alpha', 'beta', 'delta', 'gamma']);
    assert.equal(mv.allowed_paths, undefined);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bundle bootstrap: scope.json canonical branch-mode shape
// ---------------------------------------------------------------------------

test('bundle bootstrap scope.json: mode is branch and allowed_paths is array of 5 strings', () => {
  const session = makeSession();
  try {
    const scopePath = path.join(session, 'scope.json');
    const bundleScope = {
      mode: 'branch',
      allowed_paths: [
        'extension/src/',
        'extension/tests/',
        'extension/CLAUDE.md',
        'prds/MASTER_PLAN.md',
        'prds/p1-bug-fix-bundle-2026-05-10.md',
      ],
      subsystems: ['bin', 'lib', 'services', 'types'],
      scope_base: 'main',
    };
    fs.writeFileSync(scopePath, JSON.stringify(bundleScope, null, 2));

    const parsed = JSON.parse(fs.readFileSync(scopePath, 'utf-8'));
    assert.equal(parsed.mode, 'branch');
    assert.ok(Array.isArray(parsed.allowed_paths));
    assert.equal(parsed.allowed_paths.length, 5);
    assert.ok(parsed.allowed_paths.every((p) => typeof p === 'string'));
    const unique = [...new Set(parsed.allowed_paths)];
    assert.equal(unique.length, 5, 'all 5 allowed_paths must be unique');
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-BUNDLE-APWS-01: worker-simulation — check-scope-diff rejects out-of-scope staged paths
// ---------------------------------------------------------------------------

test('AC-BUNDLE-APWS-01: check-scope-diff rejects out-of-scope staged paths in worker simulation', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apws-scope-sim-')));
  const dataRoot = path.join(tmp, 'data');
  const ticketId = 'test-ticket-apws7';

  try {
    // Init temp git repo
    spawnSync('git', ['init', '-q'], { cwd: tmp, timeout: 5_000 });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp, timeout: 5_000 });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, timeout: 5_000 });

    // Write scope.json with three allowed prefixes
    const scopePath = path.join(tmp, 'scope.json');
    fs.writeFileSync(scopePath, JSON.stringify({ allowed_paths: ['alpha/', 'beta/', 'gamma/'] }));

    // Stage in-scope file
    fs.mkdirSync(path.join(tmp, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'alpha', 'x.ts'), 'export const x = 1;\n');
    spawnSync('git', ['add', 'alpha/x.ts'], { cwd: tmp, timeout: 5_000 });

    // Stage out-of-scope file
    fs.mkdirSync(path.join(tmp, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'outside', 'leaked.ts'), 'export const leaked = true;\n');
    spawnSync('git', ['add', 'outside/leaked.ts'], { cwd: tmp, timeout: 5_000 });

    // Spawn check-scope-diff.js against the temp repo with isolated PICKLE_DATA_ROOT
    const result = spawnSync(
      process.execPath,
      [CHECK_SCOPE_DIFF, '--scope-json', scopePath, '--ticket-id', ticketId],
      {
        encoding: 'utf-8',
        timeout: 10_000,
        cwd: tmp,
        env: { ...process.env, PICKLE_DATA_ROOT: dataRoot },
      },
    );

    // Assert 1: exit status 1 (outside_scope)
    assert.equal(result.status, 1, `expected exit 1; stderr: ${result.stderr}`);

    // Assert 2: stdout parses to outside_scope shape with outside/leaked.ts
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.status, 'outside_scope');
    assert.ok(
      Array.isArray(parsed.staged_paths_outside_scope) &&
        parsed.staged_paths_outside_scope.includes('outside/leaked.ts'),
      `staged_paths_outside_scope must include 'outside/leaked.ts'; got ${JSON.stringify(parsed.staged_paths_outside_scope)}`,
    );

    // Assert 3+4+5: worker_edit_outside_scope activity event in isolated data root
    const activityDir = path.join(dataRoot, 'activity');
    const jsonlFiles = fs.existsSync(activityDir)
      ? fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'))
      : [];
    const events = [];
    for (const f of jsonlFiles) {
      const content = fs.readFileSync(path.join(activityDir, f), 'utf-8');
      for (const line of content.split('\n').filter(Boolean)) {
        try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    }
    const scopeEvents = events.filter((e) => e.event === 'worker_edit_outside_scope');
    assert.equal(scopeEvents.length, 1, `expected 1 worker_edit_outside_scope event; got ${scopeEvents.length}`);

    const ev = scopeEvents[0];
    assert.equal(ev.ticket_id, ticketId, 'ticket_id must round-trip into the event');
    assert.ok(
      Array.isArray(ev.gate_payload?.staged_paths_outside_scope) &&
        ev.gate_payload.staged_paths_outside_scope.includes('outside/leaked.ts'),
      `gate_payload.staged_paths_outside_scope must include 'outside/leaked.ts'`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER310-01: the scope filter's two anchors must share a symlink space
//
// Production hands `filterBySubsystem` a `repoRoot` that came from
// `git rev-parse --show-toplevel` (pipeline-runner:resolveGitRepoRoot), which is
// realpath-resolved, and a `target` that is the raw operator-supplied
// `pipeline.json:target`. Under a symlinked checkout prefix the two disagree,
// `path.relative` yields a `../`-escaping path, every subsystem is dropped and
// the whole anatomy-park phase takes the `empty_scope` skip.
//
// Every pre-existing fixture in this file sets `repoRoot = target`, where the
// two spaces are identical — which is why the defect was invisible here.
// ---------------------------------------------------------------------------

function makeSymlinkedTargetFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ap310-symlink-'));
  const realDir = path.join(base, 'real');
  const linkDir = path.join(base, 'link');
  fs.mkdirSync(realDir, { recursive: true });
  fs.symlinkSync(realDir, linkDir, 'dir');

  const pkgReal = path.join(realDir, 'pkg');
  makeSubsystem(pkgReal, 'alpha');
  makeSubsystem(pkgReal, 'beta');
  makeSubsystem(pkgReal, 'gamma');

  // What production passes: the realpath-resolved git toplevel …
  const repoRoot = fs.realpathSync(realDir);
  // … against a target addressed THROUGH the symlink.
  const targetViaLink = path.join(linkDir, 'pkg');

  // The axis must actually be live, or every assertion below passes vacuously:
  // on a filesystem where the symlink did not take, this fixture proves nothing.
  assert.notEqual(
    fs.realpathSync(targetViaLink),
    targetViaLink,
    'fixture invalid: target must reach the repo through a symlink',
  );

  return { base, repoRoot, targetViaLink, targetReal: pkgReal };
}

test('AP-EXT-ITER310-01: symlinked target + realpath repoRoot still filters to the in-scope subsystem', () => {
  const { base, repoRoot, targetViaLink } = makeSymlinkedTargetFixture();
  const session = makeSession();
  try {
    const logs = [];
    const res = setupAnatomyPark(session, targetViaLink, 3, EXTENSION_ROOT, (m) => logs.push(m), {
      allowedPaths: ['pkg/alpha/f0.ts'],
      repoRoot,
    });

    assert.equal(res, true, `phase must run, not skip; logs: ${logs.join(' | ')}`);
    // Exactly the in-scope subsystem: a filter that degenerated into keep-everything
    // would return all three, so this doubles as the blast-radius control.
    assert.deepStrictEqual(readAnatomyPark(session).subsystems, ['alpha']);
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER310-01: anchoring RESOLVES the target, it does not widen the kept set', () => {
  const { base, repoRoot, targetViaLink, targetReal } = makeSymlinkedTargetFixture();
  const viaLink = makeSession();
  const direct = makeSession();
  try {
    const allowedPaths = ['pkg/alpha/f0.ts'];
    setupAnatomyPark(viaLink, targetViaLink, 3, EXTENSION_ROOT, () => {}, { allowedPaths, repoRoot });
    setupAnatomyPark(direct, targetReal, 3, EXTENSION_ROOT, () => {}, { allowedPaths, repoRoot });

    // Same tree addressed two ways → identical verdict, and `beta`/`gamma`
    // stay excluded on both readings.
    assert.deepStrictEqual(
      readAnatomyPark(viaLink).subsystems,
      readAnatomyPark(direct).subsystems,
      'the symlinked and direct readings of one tree must agree',
    );
    assert.deepStrictEqual(readAnatomyPark(direct).subsystems, ['alpha']);
  } finally {
    fs.rmSync(viaLink, { recursive: true, force: true });
    fs.rmSync(direct, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER310-01: filterBySubsystem itself anchors both sides, not just its caller', () => {
  const { base, repoRoot, targetViaLink } = makeSymlinkedTargetFixture();
  try {
    const names = ['alpha', 'beta', 'gamma'];
    const allowedPaths = ['pkg/alpha/f0.ts', 'pkg/gamma/f2.ts'];

    assert.deepStrictEqual(
      keptNames(names, allowedPaths, targetViaLink, repoRoot),
      ['alpha', 'gamma'],
      'a target reached through a symlink must resolve into repoRoot space',
    );
    // A non-existent repoRoot/target pair has no realpath to take: the helper
    // falls back to path.resolve, so the pure-fixture callers keep working.
    assert.deepStrictEqual(
      keptNames(names, ['pkg/beta/f0.ts'], '/nowhere-ap310/pkg', '/nowhere-ap310'),
      ['beta'],
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER310-01: a pair that agreed before anchoring still agrees when only one side exists', () => {
  // The anchor resolves BOTH sides or NEITHER. Resolving only the side that
  // happens to exist on disk would re-introduce the split this fix removes:
  // here `repoRoot` is realpath-resolvable and `target` is not, and the two are
  // handed over in the SAME raw spelling — so they must still relate.
  const { base } = makeSymlinkedTargetFixture();
  try {
    const rawRoot = path.join(base, 'real');          // exists, addressed raw
    const missingTarget = path.join(rawRoot, 'nope'); // never created
    assert.ok(fs.existsSync(rawRoot) && !fs.existsSync(missingTarget), 'fixture invalid');

    assert.deepStrictEqual(
      keptNames(['alpha', 'beta'], ['nope/alpha/f0.ts'], missingTarget, rawRoot),
      ['alpha'],
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
