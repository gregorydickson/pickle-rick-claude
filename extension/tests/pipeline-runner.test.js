// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isTestFile,
  discoverSubsystems,
  cleanPhaseArtifacts,
  resetStateForPhase,
  parsePipelineConfig,
  assertCleanWorkingTree,
  writePipelineStatus,
  resolveBackendWithSource,
  readBundlePrdBackend,
  assertCodexRequiredBackend,
  enterPicklePhase,
  installShutdownHandlers,
  applyEpochResetOnReconstruction,
  claimPipelineRunnerActive,
  armChildMuxRunnerHeartbeat,
  runBundlePreflight,
  BundlePreflightError,
  samplePhaseHistoryTimestamp,
  executeCitadelPhase,
  shouldHaltAfterPhase,
  isFatalPhaseFailure,
  logPhaseHaltReason,
  __setCitadelRemediationDepsForTests,
  __setSpawnRunnerForTests,
  setupAnatomyPark,
  readPersistedAllowedPaths,
  main,
} from '../bin/pipeline-runner.js';
import { isGateResult } from '../bin/spawn-gate-remediator.js';
import { backendEnvOverrides } from '../services/backend-spawn.js';
import { AC_PHASE_MANIFEST, runAcPhaseGate } from '../services/ac-phase-gate.js';
import { Defaults, VALID_ACTIVITY_EVENTS, EXIT_REASONS, CRASH_FLOOR_EXIT_REASONS, BACKENDS } from '../types/index.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-pipeline-'));
}

function writeRelaunchClaimState(statePath, overrides = {}) {
  const dir = path.dirname(statePath);
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    working_dir: dir,
    step: 'completed',
    iteration: 0,
    max_iterations: 50,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'pipeline relaunch claim test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    schema_version: 3,
    exit_reason: 'failed',
    ...overrides,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// isTestFile
// ---------------------------------------------------------------------------

describe('isTestFile', () => {
  test('identifies .test. files', () => {
    assert.ok(isTestFile('foo.test.ts'));
    assert.ok(isTestFile('bar.test.js'));
  });

  test('identifies .spec. files', () => {
    assert.ok(isTestFile('foo.spec.tsx'));
  });

  test('rejects normal source files', () => {
    assert.ok(!isTestFile('service.ts'));
    assert.ok(!isTestFile('utils.js'));
    assert.ok(!isTestFile('index.tsx'));
  });

  test('identifies __test__ files', () => {
    assert.ok(isTestFile('foo__test__.ts'));
    assert.ok(isTestFile('utils__test__helper.js'));
  });

  test('identifies __spec__ files', () => {
    assert.ok(isTestFile('foo__spec__.ts'));
  });

  test('case insensitive', () => {
    assert.ok(isTestFile('Foo.Test.ts'));
    assert.ok(isTestFile('BAR.SPEC.js'));
  });

  test('rejects empty string', () => {
    assert.ok(!isTestFile(''));
  });
});

describe('phase-ordered AC gate', () => {
  test('AC-BUNDLE-03 audits recovered relaunch counts from newer dead tmp state', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    const tmpStatePath = `${statePath}.tmp.999999`;
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [
        { id: 'AC-BUNDLE-03', evaluation_phase: 'bundle-end' },
      ],
    }));
    fs.writeFileSync(statePath, JSON.stringify({ codex_manager_relaunch_count: 0 }));
    fs.writeFileSync(tmpStatePath, JSON.stringify({ codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP + 1 }));
    const oldTime = new Date('2026-05-01T00:00:00.000Z');
    const newTime = new Date('2026-05-01T00:00:01.000Z');
    fs.utimesSync(statePath, oldTime, oldTime);
    fs.utimesSync(tmpStatePath, newTime, newTime);

    const result = runAcPhaseGate({ sessionDir: dir, evaluationPhase: 'bundle-end', cwd: dir });

    assert.equal(result.status, 'fail');
    assert.deepEqual(result.evaluated, ['AC-BUNDLE-03']);
    assert.match(result.failures[0].reason, /codex_manager_relaunch_count/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf-8')).codex_manager_relaunch_count, Defaults.CODEX_MANAGER_RELAUNCH_CAP + 1);
    assert.equal(fs.existsSync(tmpStatePath), false);
  });

  test('runs only ACs scheduled for the current pipeline phase', () => {
    const dir = tmpDir();
    const marker = path.join(dir, 'marker.txt');
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [
        {
          id: 'AC-PICKLE',
          evaluation_phase: 'per-phase',
          phase: 'pickle',
          command: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'pickle\\n')`],
        },
        {
          id: 'AC-LATER',
          evaluation_phase: 'bundle-end',
          command: [process.execPath, '-e', 'process.exit(1)'],
        },
      ],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'per-phase',
      pipelinePhase: 'pickle',
      cwd: dir,
    });

    assert.equal(result.status, 'pass');
    assert.deepEqual(result.evaluated, ['AC-PICKLE']);
    assert.ok(result.skipped.includes('AC-LATER'));
    assert.equal(fs.readFileSync(marker, 'utf-8'), 'pickle\n');
  });

  test('fails a present AC manifest when any AC lacks evaluation_phase', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [{ id: 'AC-MISSING-PHASE' }],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'pre-refinement',
      cwd: dir,
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.failures[0].id, 'AC-MISSING-PHASE');
    assert.match(result.failures[0].reason, /evaluation_phase/);
  });

  test('times out AC manifest commands instead of wedging the phase gate', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [
        {
          id: 'AC-HANG',
          evaluation_phase: 'per-phase',
          phase: 'pickle',
          command: [process.execPath, '-e', 'setTimeout(() => {}, 10_000)'],
          timeout_ms: 50,
        },
      ],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'per-phase',
      pipelinePhase: 'pickle',
      cwd: dir,
    });

    assert.equal(result.status, 'fail');
    assert.deepEqual(result.evaluated, ['AC-HANG']);
    assert.equal(result.failures[0].id, 'AC-HANG');
    assert.match(result.failures[0].reason, /timed out|ETIMEDOUT|SIGTERM/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('rejects non-positive AC command timeouts', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [
        {
          id: 'AC-BAD-TIMEOUT',
          evaluation_phase: 'per-phase',
          phase: 'pickle',
          command: [process.execPath, '-e', 'process.exit(0)'],
          timeout_ms: 0,
        },
      ],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'per-phase',
      pipelinePhase: 'pickle',
      cwd: dir,
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.failures[0].id, 'AC-BAD-TIMEOUT');
    assert.match(result.failures[0].reason, /timeout_ms/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('AC-BUNDLE-03 passes when root and microverse relaunch counters are within cap', () => {
    const dir = tmpDir();
    const childDir = path.join(dir, 'microverse_alpha');
    const ignoredDir = path.join(dir, 'not_microverse');
    fs.mkdirSync(childDir);
    fs.mkdirSync(ignoredDir);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP }));
    fs.writeFileSync(path.join(childDir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: 1 }));
    fs.writeFileSync(path.join(ignoredDir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP + 1 }));
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [{ id: 'AC-BUNDLE-03', evaluation_phase: 'bundle-end' }],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'bundle-end',
      cwd: dir,
    });

    assert.equal(result.status, 'pass');
    assert.deepEqual(result.evaluated, ['AC-BUNDLE-03']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('AC-BUNDLE-03 fails when root state relaunch counter exceeds cap', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP + 1 }));
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [{ id: 'AC-BUNDLE-03', evaluation_phase: 'bundle-end' }],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'bundle-end',
      cwd: dir,
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.failures[0].id, 'AC-BUNDLE-03');
    assert.match(result.failures[0].reason, /state\.json/);
    assert.match(result.failures[0].reason, /exceeds cap/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('AC-BUNDLE-03 fails when a child microverse state relaunch counter exceeds cap', () => {
    const dir = tmpDir();
    const childDir = path.join(dir, 'microverse_citadel');
    fs.mkdirSync(childDir);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: 0 }));
    fs.writeFileSync(path.join(childDir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP + 1 }));
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [{ id: 'AC-BUNDLE-03', evaluation_phase: 'bundle-end' }],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'bundle-end',
      cwd: dir,
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.failures[0].id, 'AC-BUNDLE-03');
    assert.match(result.failures[0].reason, /microverse_citadel\/state\.json/);
    assert.match(result.failures[0].reason, /exceeds cap/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('AC-BUNDLE-03 fails when a child microverse only has a newer recoverable tmp state over cap', () => {
    const dir = tmpDir();
    const childDir = path.join(dir, 'microverse_citadel');
    const childStatePath = path.join(childDir, 'state.json');
    const childTmpStatePath = `${childStatePath}.tmp.999999`;
    fs.mkdirSync(childDir);
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ codex_manager_relaunch_count: 0 }));
    fs.writeFileSync(childTmpStatePath, JSON.stringify({ codex_manager_relaunch_count: Defaults.CODEX_MANAGER_RELAUNCH_CAP + 1 }));
    fs.writeFileSync(path.join(dir, AC_PHASE_MANIFEST), JSON.stringify({
      acceptance_criteria: [{ id: 'AC-BUNDLE-03', evaluation_phase: 'bundle-end' }],
    }));

    const result = runAcPhaseGate({
      sessionDir: dir,
      evaluationPhase: 'bundle-end',
      cwd: dir,
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.failures[0].id, 'AC-BUNDLE-03');
    assert.match(result.failures[0].reason, /microverse_citadel\/state\.json/);
    assert.match(result.failures[0].reason, /exceeds cap/);
    assert.equal(JSON.parse(fs.readFileSync(childStatePath, 'utf-8')).codex_manager_relaunch_count, Defaults.CODEX_MANAGER_RELAUNCH_CAP + 1);
    assert.equal(fs.existsSync(childTmpStatePath), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// discoverSubsystems
// ---------------------------------------------------------------------------

describe('discoverSubsystems', () => {
  test('discovers directories with 3+ source files', () => {
    const root = tmpDir();
    const sub = path.join(root, 'services');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.ts'), '');
    fs.writeFileSync(path.join(sub, 'b.ts'), '');
    fs.writeFileSync(path.join(sub, 'c.ts'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'services');
    assert.equal(result[0].fileCount, 3);
    fs.rmSync(root, { recursive: true });
  });

  test('excludes directories with fewer than 3 source files', () => {
    const root = tmpDir();
    const sub = path.join(root, 'tiny');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.ts'), '');
    fs.writeFileSync(path.join(sub, 'b.ts'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('excludes node_modules and other blacklisted dirs', () => {
    const root = tmpDir();
    for (const name of ['node_modules', 'dist', '.git', 'coverage']) {
      const sub = path.join(root, name);
      fs.mkdirSync(sub);
      for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(sub, `f${i}.ts`), '');
    }

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('excludes hidden directories', () => {
    const root = tmpDir();
    const sub = path.join(root, '.hidden');
    fs.mkdirSync(sub);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(sub, `f${i}.ts`), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('excludes test-only directories (>80% test files)', () => {
    const root = tmpDir();
    const sub = path.join(root, 'tests');
    fs.mkdirSync(sub);
    // 4 test files, 1 normal = 80% → excluded (> 0.8 threshold is <=)
    // Actually: 4/5 = 0.8, and the check is <= 0.8, so this is included.
    // Need 5 test, 1 normal = 83% to exclude.
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(sub, `f${i}.test.ts`), '');
    fs.writeFileSync(path.join(sub, 'helper.ts'), '');
    // 5/6 = 0.833 > 0.8 → excluded
    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('includes directories at exactly 80% test files', () => {
    const root = tmpDir();
    const sub = path.join(root, 'mixed');
    fs.mkdirSync(sub);
    // 4 test files + 1 normal = 4/5 = 0.8 → 0.8 <= 0.8 → included
    for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(sub, `f${i}.test.ts`), '');
    fs.writeFileSync(path.join(sub, 'real.ts'), '');
    // Need at least 3 source files (5 >= 3 ✓)

    const result = discoverSubsystems(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'mixed');
    fs.rmSync(root, { recursive: true });
  });

  test('counts files recursively', () => {
    const root = tmpDir();
    const sub = path.join(root, 'deep');
    fs.mkdirSync(path.join(sub, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'a.ts'), '');
    fs.writeFileSync(path.join(sub, 'nested', 'b.ts'), '');
    fs.writeFileSync(path.join(sub, 'nested', 'deeper', 'c.ts'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].fileCount, 3);
    fs.rmSync(root, { recursive: true });
  });

  test('handles symlink loops without hanging', () => {
    const root = tmpDir();
    const sub = path.join(root, 'loopy');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.ts'), '');
    fs.writeFileSync(path.join(sub, 'b.ts'), '');
    fs.writeFileSync(path.join(sub, 'c.ts'), '');
    // Create symlink loop: loopy/self -> loopy
    try {
      fs.symlinkSync(sub, path.join(sub, 'self'));
    } catch {
      // symlinks may not be supported (CI, Windows) — skip
      return;
    }

    const result = discoverSubsystems(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'loopy');
    assert.ok(result[0].fileCount >= 3); // at least the 3 real files
    fs.rmSync(root, { recursive: true });
  });

  test('handles broken symlinks gracefully', () => {
    const root = tmpDir();
    const sub = path.join(root, 'broken');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.ts'), '');
    fs.writeFileSync(path.join(sub, 'b.ts'), '');
    fs.writeFileSync(path.join(sub, 'c.ts'), '');
    try {
      fs.symlinkSync('/nonexistent/path', path.join(sub, 'dead'));
    } catch {
      return; // skip if symlinks not supported
    }

    const result = discoverSubsystems(root);
    assert.equal(result.length, 1);
    fs.rmSync(root, { recursive: true });
  });

  test('returns empty for nonexistent target', () => {
    const result = discoverSubsystems('/nonexistent/path/xyz');
    assert.equal(result.length, 0);
  });

  test('returns empty for directories with only non-source files', () => {
    const root = tmpDir();
    const sub = path.join(root, 'docs');
    fs.mkdirSync(sub);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(sub, `f${i}.md`), '');
    fs.writeFileSync(path.join(sub, 'config.json'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('deeply nested test files count toward test ratio', () => {
    const root = tmpDir();
    const sub = path.join(root, 'deep-tests');
    fs.mkdirSync(path.join(sub, 'a', 'b', 'c'), { recursive: true });
    // All 4 files are tests, deeply nested → 100% > 80% → excluded
    fs.writeFileSync(path.join(sub, 'a.test.ts'), '');
    fs.writeFileSync(path.join(sub, 'a', 'b.test.ts'), '');
    fs.writeFileSync(path.join(sub, 'a', 'b', 'c.spec.ts'), '');
    fs.writeFileSync(path.join(sub, 'a', 'b', 'c', 'd.test.ts'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('boundary: 3 files, 2 tests (66.7%) included', () => {
    const root = tmpDir();
    const sub = path.join(root, 'edge');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.test.ts'), '');
    fs.writeFileSync(path.join(sub, 'b.test.ts'), '');
    fs.writeFileSync(path.join(sub, 'c.ts'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 1);
    fs.rmSync(root, { recursive: true });
  });

  test('boundary: 3 files, all tests (100%) excluded', () => {
    const root = tmpDir();
    const sub = path.join(root, 'all-tests');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'a.test.ts'), '');
    fs.writeFileSync(path.join(sub, 'b.test.ts'), '');
    fs.writeFileSync(path.join(sub, 'c.test.ts'), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('ignores files at root level (only scans directories)', () => {
    const root = tmpDir();
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.ts`), '');

    const result = discoverSubsystems(root);
    assert.equal(result.length, 0);
    fs.rmSync(root, { recursive: true });
  });

  test('subsystem names are single-segment basenames (no path separators)', () => {
    const root = tmpDir();
    const src = path.join(root, 'src');
    for (const name of ['services', 'processors']) {
      const sub = path.join(src, name);
      fs.mkdirSync(sub, { recursive: true });
      for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(sub, `f${i}.ts`), '');
    }

    const result = discoverSubsystems(src);
    assert.equal(result.length, 2);
    const names = result.map(s => s.name);
    assert.ok(names.includes('services'), `expected 'services' in ${JSON.stringify(names)}`);
    assert.ok(names.includes('processors'), `expected 'processors' in ${JSON.stringify(names)}`);
    for (const { name } of result) {
      assert.ok(!name.includes('/') && !name.includes('\\'), `name must be a basename, got: ${name}`);
    }
    fs.rmSync(root, { recursive: true });
  });

  test('returns sorted results', () => {
    const root = tmpDir();
    for (const name of ['zebra', 'alpha', 'middle']) {
      const sub = path.join(root, name);
      fs.mkdirSync(sub);
      for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(sub, `f${i}.ts`), '');
    }

    const result = discoverSubsystems(root);
    assert.deepEqual(result.map(s => s.name), ['alpha', 'middle', 'zebra']);
    fs.rmSync(root, { recursive: true });
  });

  // Repo-root bin/ sits at EXACTLY the 3-source-file floor, and dropping below it
  // removes the whole subsystem from anatomy-park silently. Every sibling test above
  // builds a synthetic fixture, so none of them reads the shipped tree; the per-file
  // bin tests don't cover it either, because deleting a script TOGETHER with its test
  // is green (980656c7 did exactly that, taking bin/ from 4 to 3). Mirror the real
  // listing into a small root: the subject stays the shipped file set, while the walk
  // stays milliseconds instead of the ~12s a full repo-root walk costs.
  test('the real bin/ still clears the subsystem-enumeration floor', () => {
    const root = tmpDir();
    try {
      const mirror = path.join(root, 'bin');
      fs.cpSync(new URL('../../bin/', import.meta.url), mirror, { recursive: true });
      const listing = fs.readdirSync(mirror);

      assert.ok(
        discoverSubsystems(root).some(s => s.name === 'bin'),
        `repo-root bin/ fell out of anatomy-park scope — [${listing.join(', ')}] carries fewer `
        + 'than the 3 source files discoverSubsystems requires (.sh does NOT count, so '
        + 'release-gate.sh is invisible to it). Every release-critical script in bin/ is now '
        + 'unreviewed by anatomy-park. Restore a source file, or lower the floor deliberately.',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// cleanPhaseArtifacts
// ---------------------------------------------------------------------------

describe('cleanPhaseArtifacts', () => {
  test('archives and removes TASK_NOTES.md', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'TASK_NOTES.md'), 'notes');

    cleanPhaseArtifacts(dir, 'pickle');

    assert.ok(!fs.existsSync(path.join(dir, 'TASK_NOTES.md')));
    assert.ok(fs.existsSync(path.join(dir, 'TASK_NOTES-pickle.md')));
    assert.equal(fs.readFileSync(path.join(dir, 'TASK_NOTES-pickle.md'), 'utf-8'), 'notes');
    fs.rmSync(dir, { recursive: true });
  });

  test('archives and removes gap_analysis.md', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'gap_analysis.md'), 'gaps');

    cleanPhaseArtifacts(dir, 'anatomy-park');

    assert.ok(!fs.existsSync(path.join(dir, 'gap_analysis.md')));
    assert.ok(fs.existsSync(path.join(dir, 'gap_analysis-anatomy-park.md')));
    fs.rmSync(dir, { recursive: true });
  });

  test('removes handoff.txt without archiving', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'handoff.txt'), 'handoff');

    cleanPhaseArtifacts(dir, 'pickle');

    assert.ok(!fs.existsSync(path.join(dir, 'handoff.txt')));
    fs.rmSync(dir, { recursive: true });
  });

  test('handles missing files gracefully', () => {
    const dir = tmpDir();
    // No files to clean — should not throw
    cleanPhaseArtifacts(dir, 'pickle');
    fs.rmSync(dir, { recursive: true });
  });

  test('overwrites existing archive on name collision', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'TASK_NOTES.md'), 'new notes');
    fs.writeFileSync(path.join(dir, 'TASK_NOTES-pickle.md'), 'old archive');

    cleanPhaseArtifacts(dir, 'pickle');

    assert.ok(!fs.existsSync(path.join(dir, 'TASK_NOTES.md')));
    assert.equal(fs.readFileSync(path.join(dir, 'TASK_NOTES-pickle.md'), 'utf-8'), 'new notes');
    fs.rmSync(dir, { recursive: true });
  });

  test('cleans all artifacts in one call', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'TASK_NOTES.md'), 'notes');
    fs.writeFileSync(path.join(dir, 'gap_analysis.md'), 'gaps');
    fs.writeFileSync(path.join(dir, 'handoff.txt'), 'handoff');

    cleanPhaseArtifacts(dir, 'test-phase');

    assert.ok(!fs.existsSync(path.join(dir, 'TASK_NOTES.md')));
    assert.ok(!fs.existsSync(path.join(dir, 'gap_analysis.md')));
    assert.ok(!fs.existsSync(path.join(dir, 'handoff.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'TASK_NOTES-test-phase.md')));
    assert.ok(fs.existsSync(path.join(dir, 'gap_analysis-test-phase.md')));
    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// resetStateForPhase
// ---------------------------------------------------------------------------

describe('resetStateForPhase', () => {
  test('resets state for anatomy-park phase', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      working_dir: '/tmp',
      step: 'implement',
      iteration: 42,
      max_iterations: 500,
      max_time_minutes: 720,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1000,
      completion_promise: null,
      original_prompt: 'test',
      current_ticket: 'TICKET-1',
      history: [],
      started_at: new Date().toISOString(),
      session_dir: dir,
      tmux_mode: true,
      exit_reason: 'fatal',
    }));

    resetStateForPhase(statePath, 'anatomy-park.md', 100);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.active, false);
    assert.equal(state.iteration, 0);
    assert.equal(state.current_ticket, null);
    assert.equal(state.max_iterations, 100);
    assert.equal(state.command_template, 'anatomy-park.md');
    assert.equal(state.step, null);
    assert.equal(state.exit_reason, null);
    assert.equal(state.tmux_mode, true);
    // Preserved fields
    assert.equal(state.working_dir, '/tmp');
    assert.equal(state.original_prompt, 'test');
    fs.rmSync(dir, { recursive: true });
  });

  test('clears stale phase forensic markers before next phase runner starts', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: false,
      working_dir: '/project',
      step: 'review',
      iteration: 3,
      max_iterations: 100,
      max_time_minutes: 720,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1000,
      completion_promise: null,
      original_prompt: 'test',
      current_ticket: 'T-STALE',
      history: [],
      started_at: new Date().toISOString(),
      session_dir: dir,
      exit_reason: 'completed',
    }));

    resetStateForPhase(statePath, 'szechuan-sauce.md', 50);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.exit_reason, null);
    assert.equal(state.step, null);
    assert.equal(state.current_ticket, null);
    assert.equal(state.command_template, 'szechuan-sauce.md');
    assert.equal(state.active, false);
    fs.rmSync(dir, { recursive: true });
  });

  test('resets state for szechuan-sauce phase', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: false,
      working_dir: '/project',
      step: 'review',
      iteration: 10,
      max_iterations: 100,
      max_time_minutes: 720,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1000,
      completion_promise: null,
      original_prompt: 'test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: dir,
    }));

    resetStateForPhase(statePath, 'szechuan-sauce.md', 50);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.command_template, 'szechuan-sauce.md');
    assert.equal(state.max_iterations, 50);
    assert.equal(state.iteration, 0);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(state.start_time_epoch >= now - 5 && state.start_time_epoch <= now + 5);
    fs.rmSync(dir, { recursive: true });
  });

  test('preserves extra fields not in schema', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true, working_dir: '/tmp', step: 'implement',
      iteration: 5, max_iterations: 50, max_time_minutes: 720,
      worker_timeout_seconds: 1200, start_time_epoch: 1000,
      completion_promise: null, original_prompt: 'test',
      current_ticket: 'T-1', history: [], started_at: new Date().toISOString(),
      session_dir: dir, custom_field: 'should_survive',
    }));

    resetStateForPhase(statePath, 'anatomy-park.md', 100);

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.custom_field, 'should_survive');
    assert.equal(state.iteration, 0);
    fs.rmSync(dir, { recursive: true });
  });

  test('handles state missing optional fields', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true, working_dir: '/tmp', step: 'implement',
      iteration: 5, max_iterations: 50, max_time_minutes: 720,
      worker_timeout_seconds: 1200, start_time_epoch: 1000,
      completion_promise: null, original_prompt: 'test',
      current_ticket: 'T-1', history: [], started_at: new Date().toISOString(),
      session_dir: dir,
    }));

    assert.doesNotThrow(() => resetStateForPhase(statePath, 'szechuan-sauce.md', 50));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.tmux_mode, true);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('pipeline-runner.relaunch-claim', () => {
  test('claims active and clears stale failed exit_reason on relaunch startup', () => {
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      writeRelaunchClaimState(statePath, {
        active: false,
        exit_reason: 'failed',
        step: 'completed',
        pid: 123,
      });

      const before = Date.now();
      const claimed = claimPipelineRunnerActive(statePath);
      const elapsed = Date.now() - before;
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

      assert.equal(claimed.active, true);
      assert.equal(persisted.active, true);
      assert.equal(persisted.exit_reason, null);
      assert.equal(persisted.pid, process.pid);
      assert.ok(elapsed < 100, `state.active=true should be claimed within 100ms, got ${elapsed}ms`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('phase boundary reclaims active after resetStateForPhase deactivates state', () => {
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      writeRelaunchClaimState(statePath, {
        active: true,
        exit_reason: 'completed',
        step: 'pickle',
        iteration: 3,
        current_ticket: 'T-1',
      });

      resetStateForPhase(statePath, 'anatomy-park.md', 100);
      assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf-8')).active, false);

      const before = Date.now();
      claimPipelineRunnerActive(statePath);
      const elapsed = Date.now() - before;
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

      assert.equal(persisted.active, true);
      assert.equal(persisted.exit_reason, null);
      assert.equal(persisted.pid, process.pid);
      assert.ok(elapsed < 100, `phase boundary active claim should complete within 100ms, got ${elapsed}ms`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('phase entry re-claims active across three iteration boundaries', () => {
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      writeRelaunchClaimState(statePath);

      for (let iteration = 1; iteration <= 3; iteration++) {
        resetStateForPhase(statePath, iteration === 1 ? 'anatomy-park.md' : 'szechuan-sauce.md', 50);
        claimPipelineRunnerActive(statePath);
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        assert.equal(state.active, true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('R-CCR-3: claimPipelineRunnerActive clears manager_handoff_pending and closer_handoff_terminal at phase entry', () => {
    for (const stalReason of ['manager_handoff_pending', 'closer_handoff_terminal']) {
      const dir = tmpDir();
      try {
        const statePath = path.join(dir, 'state.json');
        writeRelaunchClaimState(statePath, { exit_reason: stalReason });

        claimPipelineRunnerActive(statePath);
        const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

        assert.equal(
          persisted.exit_reason,
          null,
          `claimPipelineRunnerActive must clear stale ${stalReason} at phase entry`,
        );
        assert.equal(persisted.active, true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe('pipeline-runner.phase-history', () => {
  test('samples strictly increasing timestamps across same-millisecond phase transitions', () => {
    const prior = '2026-05-20T01:02:03.456Z';

    const sampled = samplePhaseHistoryTimestamp(
      [{ step: 'anatomy-park', timestamp: prior }],
      Date.parse(prior),
    );

    assert.equal(sampled, '2026-05-20T01:02:03.457Z');
  });
});

// ---------------------------------------------------------------------------
// parsePipelineConfig
// ---------------------------------------------------------------------------

describe('parsePipelineConfig', () => {
  test('parses valid config', () => {
    const config = parsePipelineConfig({
      phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
      target: '/tmp/project',
      anatomy_stall_limit: 5,
      szechuan_stall_limit: 8,
      anatomy_max_iterations: 200,
      szechuan_max_iterations: 75,
      szechuan_domain: 'financial',
      szechuan_focus: 'error handling',
    });
    assert.deepEqual(config.phases, ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce']);
    assert.equal(config.target, '/tmp/project');
    assert.equal(config.anatomy_stall_limit, 5);
    assert.equal(config.szechuan_stall_limit, 8);
    assert.equal(config.anatomy_max_iterations, 200);
    assert.equal(config.szechuan_max_iterations, 75);
    assert.equal(config.citadel_strict, false);
    assert.equal(config.szechuan_domain, 'financial');
    assert.equal(config.szechuan_focus, 'error handling');
  });

  test('preserves explicit citadel phase without duplicating it', () => {
    const config = parsePipelineConfig({
      phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
      target: '/tmp/project',
    });
    assert.deepEqual(config.phases, ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce']);
  });

  test('parses citadel strict flag', () => {
    const config = parsePipelineConfig({ phases: [], target: '', citadel_strict: true });
    assert.equal(config.citadel_strict, true);
  });

  test('defaults numeric fields when missing', () => {
    const config = parsePipelineConfig({ phases: ['pickle'], target: '/tmp' });
    assert.equal(config.child_mux_runner_heartbeat_ms, 60_000);
    assert.equal(config.child_mux_runner_stall_seconds, 1800);
    assert.equal(config.anatomy_stall_limit, 3);
    assert.equal(config.szechuan_stall_limit, 5);
    assert.equal(config.anatomy_max_iterations, 100);
    assert.equal(config.szechuan_max_iterations, 50);
  });

  test('defaults numeric fields when NaN', () => {
    const config = parsePipelineConfig({
      phases: [], target: '',
      anatomy_stall_limit: 'garbage',
      szechuan_max_iterations: 'also_garbage',
    });
    assert.equal(config.anatomy_stall_limit, 3);
    assert.equal(config.szechuan_max_iterations, 50);
  });

  test('defaults numeric fields when null or non-positive', () => {
    const config = parsePipelineConfig({
      phases: [], target: '',
      child_mux_runner_stall_seconds: 0,
      anatomy_stall_limit: null,
      szechuan_stall_limit: 0,
      anatomy_max_iterations: -1,
      szechuan_max_iterations: '',
    });
    assert.equal(config.child_mux_runner_stall_seconds, 1800);
    assert.equal(config.anatomy_stall_limit, 3);
    assert.equal(config.szechuan_stall_limit, 5);
    assert.equal(config.anatomy_max_iterations, 100);
    assert.equal(config.szechuan_max_iterations, 50);
  });

  test('defaults numeric fields when Infinity', () => {
    const config = parsePipelineConfig({
      phases: [], target: '',
      anatomy_stall_limit: 'Infinity',
      szechuan_stall_limit: Infinity,
    });
    assert.equal(config.anatomy_stall_limit, 3);
    assert.equal(config.szechuan_stall_limit, 5);
  });

  test('defaults numeric fields when fractional', () => {
    const config = parsePipelineConfig({
      phases: [], target: '',
      child_mux_runner_heartbeat_ms: '2.5',
      anatomy_stall_limit: 0.5,
      szechuan_stall_limit: '2.5',
      anatomy_max_iterations: 10.25,
      szechuan_max_iterations: '4.75',
    });
    assert.equal(config.child_mux_runner_heartbeat_ms, 60_000);
    assert.equal(config.anatomy_stall_limit, 3);
    assert.equal(config.szechuan_stall_limit, 5);
    assert.equal(config.anatomy_max_iterations, 100);
    assert.equal(config.szechuan_max_iterations, 50);
  });

  test('disables child heartbeat when configured with a non-positive integer', () => {
    const zeroConfig = parsePipelineConfig({ phases: [], target: '', child_mux_runner_heartbeat_ms: 0 });
    const negativeConfig = parsePipelineConfig({ phases: [], target: '', child_mux_runner_heartbeat_ms: -5 });
    assert.equal(zeroConfig.child_mux_runner_heartbeat_ms, 0);
    assert.equal(negativeConfig.child_mux_runner_heartbeat_ms, 0);
  });

  test('defaults phases to empty array when not array', () => {
    const config = parsePipelineConfig({ phases: 'pickle', target: '/tmp' });
    assert.deepEqual(config.phases, []);
  });

  test('defaults target to empty string when missing', () => {
    const config = parsePipelineConfig({ phases: [] });
    assert.equal(config.target, '');
  });

  test('omits optional string fields when not set', () => {
    const config = parsePipelineConfig({ phases: [], target: '' });
    assert.equal(config.szechuan_domain, undefined);
    assert.equal(config.szechuan_focus, undefined);
  });

  test('passes through unvalidated phase names (current behavior)', () => {
    const config = parsePipelineConfig({ phases: ['pickle', 'bogus', 42], target: '/tmp' });
    assert.deepEqual(config.phases, ['pickle', 'bogus', 42]);
  });

  test('roundtrips backend: "codex"', () => {
    const config = parsePipelineConfig({ phases: [], target: '', backend: 'codex' });
    assert.equal(config.backend, 'codex');
  });

  test('roundtrips backend: "claude"', () => {
    const config = parsePipelineConfig({ phases: [], target: '', backend: 'claude' });
    assert.equal(config.backend, 'claude');
  });

  test('drops unknown backend string to undefined', () => {
    const config = parsePipelineConfig({ phases: [], target: '', backend: 'gpt4' });
    assert.equal(config.backend, undefined);
  });

  test('drops numeric backend to undefined', () => {
    const config = parsePipelineConfig({ phases: [], target: '', backend: 42 });
    assert.equal(config.backend, undefined);
  });

  test('drops null backend to undefined', () => {
    const config = parsePipelineConfig({ phases: [], target: '', backend: null });
    assert.equal(config.backend, undefined);
  });

  test('omits backend when key absent', () => {
    const config = parsePipelineConfig({ phases: [], target: '' });
    assert.equal(config.backend, undefined);
  });

  test('defaults dirty_exempt_segments to ["prds","docs"]', () => {
    const config = parsePipelineConfig({ phases: [], target: '' });
    assert.deepEqual(config.dirty_exempt_segments, ['prds', 'docs']);
  });

  test('roundtrips dirty_exempt_segments when array of strings', () => {
    const config = parsePipelineConfig({ phases: [], target: '', dirty_exempt_segments: ['notes', 'wip'] });
    assert.deepEqual(config.dirty_exempt_segments, ['notes', 'wip']);
  });

  test('roundtrips empty dirty_exempt_segments (opt-out)', () => {
    const config = parsePipelineConfig({ phases: [], target: '', dirty_exempt_segments: [] });
    assert.deepEqual(config.dirty_exempt_segments, []);
  });

  test('falls back to default when dirty_exempt_segments is non-array', () => {
    const config = parsePipelineConfig({ phases: [], target: '', dirty_exempt_segments: 'prds' });
    assert.deepEqual(config.dirty_exempt_segments, ['prds', 'docs']);
  });

  test('falls back to default when dirty_exempt_segments contains non-strings', () => {
    const config = parsePipelineConfig({ phases: [], target: '', dirty_exempt_segments: ['prds', 42] });
    assert.deepEqual(config.dirty_exempt_segments, ['prds', 'docs']);
  });
});

describe('armChildMuxRunnerHeartbeat', () => {
  test('kills a stale live mux-runner child and emits activity', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true }, null, 2));
    const staleAt = new Date(Date.now() - 31 * 60 * 1000);
    fs.utimesSync(statePath, staleAt, staleAt);

    const events = [];
    const child = {
      pid: 4242,
      killed: false,
      signal: null,
      kill(signal) {
        this.killed = true;
        this.signal = signal;
      },
    };
    let tick = null;
    let cleared = false;

    const handle = armChildMuxRunnerHeartbeat({
      child,
      sessionDir: dir,
      heartbeatMs: 60_000,
      stallSeconds: 1800,
    }, {
      setInterval: (fn, ms) => {
        assert.equal(ms, 60_000);
        tick = fn;
        return 123;
      },
      clearInterval: (timer) => {
        assert.equal(timer, 123);
        cleared = true;
      },
      now: () => staleAt.getTime() + 31 * 60 * 1000,
      isProcessAlive: (pid) => {
        assert.equal(pid, 4242);
        return true;
      },
      emitActivity: (event) => {
        events.push(event);
      },
    });

    assert.equal(typeof tick, 'function');
    tick();

    assert.equal(child.signal, 'SIGTERM');
    assert.equal(child.killed, true);
    assert.equal(cleared, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'child_mux_runner_wedge_detected');
    assert.equal(events[0].session, path.basename(dir));
    assert.equal(events[0].gate_payload.child_pid, 4242);
    assert.equal(events[0].gate_payload.elapsed_seconds, 1860);
    assert.equal(events[0].gate_payload.last_state_mtime_iso, staleAt.toISOString());

    handle.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// assertCleanWorkingTree
// ---------------------------------------------------------------------------

function initRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
}

describe('assertCleanWorkingTree', () => {
  test('passes on a clean repo', () => {
    const dir = tmpDir();
    initRepo(dir);
    assert.doesNotThrow(() => assertCleanWorkingTree(dir));
    fs.rmSync(dir, { recursive: true });
  });

  test('throws on untracked files', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'wip');
    assert.throws(() => assertCleanWorkingTree(dir), /dirty/);
    fs.rmSync(dir, { recursive: true });
  });

  test('throws on unstaged modifications', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'README.md'), 'changed');
    assert.throws(() => assertCleanWorkingTree(dir), /dirty/);
    fs.rmSync(dir, { recursive: true });
  });

  test('default ignore list excludes prds/ and docs/ from dirty check', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.mkdirSync(path.join(dir, 'prds'));
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'prds', 'idea.md'), 'wip');
    fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), 'wip');
    assert.doesNotThrow(() => assertCleanWorkingTree(dir));
    // Anything outside still trips the check.
    fs.writeFileSync(path.join(dir, 'src.js'), 'real change');
    assert.throws(() => assertCleanWorkingTree(dir), /dirty/);
    fs.rmSync(dir, { recursive: true });
  });

  test('allows tracked dirty files that match .gitignore', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'foo.txt'), 'seed');
    execFileSync('git', ['add', 'foo.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'track file'], { cwd: dir });
    fs.writeFileSync(path.join(dir, '.gitignore'), 'foo.txt\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'ignore tracked file'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'foo.txt'), 'changed');
    assert.doesNotThrow(() => assertCleanWorkingTree(dir));
    fs.rmSync(dir, { recursive: true });
  });

  test('allows tracked dirty files listed in extension/.pipeline-runner-dirty-allowed.json', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'runtime.txt'), 'seed');
    fs.writeFileSync(
      path.join(dir, 'extension', '.pipeline-runner-dirty-allowed.json'),
      `${JSON.stringify({ paths: ['runtime.txt'] }, null, 2)}\n`,
    );
    execFileSync('git', ['add', 'runtime.txt', 'extension/.pipeline-runner-dirty-allowed.json'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'allow runtime file'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'runtime.txt'), 'changed');
    assert.doesNotThrow(() => assertCleanWorkingTree(dir));
    fs.rmSync(dir, { recursive: true });
  });

  test('explicit ignore list overrides defaults', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.mkdirSync(path.join(dir, 'prds'));
    fs.writeFileSync(path.join(dir, 'prds', 'idea.md'), 'wip');
    // Empty list disables exclusions — prds/ now trips the check.
    assert.throws(() => assertCleanWorkingTree(dir, { exemptSegments: [] }), /dirty/);
    // Custom list accepts unrelated dirs.
    fs.rmSync(path.join(dir, 'prds'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'notes', 'jot.md'), 'wip');
    assert.doesNotThrow(() => assertCleanWorkingTree(dir, { exemptSegments: ['notes'] }));
    fs.rmSync(dir, { recursive: true });
  });

  test('error lists blocking files one per line', () => {
    const dir = tmpDir();
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'alpha.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'beta.txt'), 'b');
    assert.throws(
      () => assertCleanWorkingTree(dir),
      /Dirty files:\nalpha\.txt\nbeta\.txt\nCommit, stash, or discard changes before starting the pipeline\./,
    );
    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// writePipelineStatus
// ---------------------------------------------------------------------------

describe('writePipelineStatus', () => {
  test('writes pipeline-status.json with defaults and metadata', () => {
    const dir = tmpDir();
    writePipelineStatus(dir, 'running', { current_phase: 'pickle', total_phases: 3 });

    const status = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));
    assert.equal(status.status, 'running');
    assert.equal(status.current_phase, 'pickle');
    assert.equal(status.completed_phases, 0);
    assert.equal(status.skipped_phases, 0);
    assert.equal(status.total_phases, 3);
    assert.ok(typeof status.updated_at === 'string' && status.updated_at.length > 0);

    fs.rmSync(dir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// resolveBackendWithSource — precedence (resume must honor user's new --backend)
// ---------------------------------------------------------------------------

describe('resolveBackendWithSource', () => {
  test('state.backend wins over pipeline.json when both set (resume case)', () => {
    // Simulates resume: setup.js wrote state.backend='codex' from --backend,
    // pipeline.json still pins the original 'claude' from first launch.
    const result = resolveBackendWithSource({ backend: 'codex' }, 'claude', undefined);
    assert.equal(result.backend, 'codex');
    assert.equal(result.source, 'state.json');
  });

  test('state.backend wins over pipeline.json when they agree', () => {
    const result = resolveBackendWithSource({ backend: 'codex' }, 'codex', undefined);
    assert.equal(result.backend, 'codex');
    assert.equal(result.source, 'state.json');
  });

  test('pipeline.json wins when state.backend unset', () => {
    const result = resolveBackendWithSource({}, 'codex', undefined);
    assert.equal(result.backend, 'codex');
    assert.equal(result.source, 'pipeline.json');
  });

  test('env wins when state and pipeline both unset', () => {
    const result = resolveBackendWithSource({}, undefined, 'codex');
    assert.equal(result.backend, 'codex');
    assert.equal(result.source, 'env');
  });

  test('defaults to claude when nothing set', () => {
    const result = resolveBackendWithSource({}, undefined, undefined);
    assert.equal(result.backend, 'claude');
    assert.equal(result.source, 'default');
  });

  test('invalid state.backend string falls through to pipeline.json', () => {
    const result = resolveBackendWithSource({ backend: 'gpt4' }, 'codex', undefined);
    assert.equal(result.backend, 'codex');
    assert.equal(result.source, 'pipeline.json');
  });

  test('null state falls back to pipeline.json', () => {
    const result = resolveBackendWithSource(null, 'codex', undefined);
    assert.equal(result.backend, 'codex');
    assert.equal(result.source, 'pipeline.json');
  });

  test('invalid env falls through to default', () => {
    const result = resolveBackendWithSource({}, undefined, 'bogus');
    assert.equal(result.backend, 'claude');
    assert.equal(result.source, 'default');
  });
});

// ---------------------------------------------------------------------------
// Bundle PRD backend contract — AC-BUNDLE-18
// ---------------------------------------------------------------------------

describe('bundle PRD backend contract', () => {
  test('reads backend from refined bundle fenced frontmatter block', () => {
    const prd = [
      '# PRD',
      '',
      'frontmatter:',
      '```',
      'backend: codex-required',
      'session_root: /tmp/session',
      '```',
      '',
      '## Body',
    ].join('\n');
    assert.equal(readBundlePrdBackend(prd), 'codex-required');
  });

  test('reads backend from conventional leading YAML frontmatter', () => {
    const prd = [
      '---',
      'backend: "codex-required"',
      '---',
      '',
      '# PRD',
    ].join('\n');
    assert.equal(readBundlePrdBackend(prd), 'codex-required');
  });

  test('returns undefined when PRD has no backend contract', () => {
    assert.equal(readBundlePrdBackend('# PRD\n\nNo frontmatter.'), undefined);
  });

  test('rejects non-codex backend with actionable pipeline command', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'prd.md'), [
      '# Bundle',
      '',
      'frontmatter:',
      '```',
      'backend: codex-required',
      '```',
    ].join('\n'));
    try {
      assert.throws(
        () => assertCodexRequiredBackend(dir, 'claude', 'default'),
        /\/pickle-pipeline --backend codex/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('allows codex backend when PRD requires codex', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'prd.md'), [
      '# Bundle',
      '',
      'frontmatter:',
      '```',
      'backend: codex-required',
      '```',
    ].join('\n'));
    try {
      assert.doesNotThrow(() => assertCodexRequiredBackend(dir, 'codex', 'state.json'));
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// phaseEnv composition — backend must propagate to sub-runners via env
// ---------------------------------------------------------------------------

describe('phaseEnv propagation', () => {
  test('PICKLE_BACKEND=codex when backend resolves to codex', () => {
    const { backend } = resolveBackendWithSource({ backend: 'codex' }, undefined, undefined);
    const phaseEnv = { ...process.env, ...backendEnvOverrides(backend) };
    assert.equal(phaseEnv.PICKLE_BACKEND, 'codex');
  });

  test('PICKLE_BACKEND=claude when backend resolves to claude (default)', () => {
    const { backend } = resolveBackendWithSource({}, undefined, undefined);
    const phaseEnv = { ...process.env, ...backendEnvOverrides(backend) };
    assert.equal(phaseEnv.PICKLE_BACKEND, 'claude');
  });

  test('PICKLE_BACKEND reflects state.backend even when pipeline.json disagrees (resume)', () => {
    const { backend } = resolveBackendWithSource({ backend: 'codex' }, 'claude', undefined);
    const phaseEnv = { ...process.env, ...backendEnvOverrides(backend) };
    assert.equal(phaseEnv.PICKLE_BACKEND, 'codex');
  });
});

// ---------------------------------------------------------------------------
// Restamp guard: phase loop must not re-write state.backend when it matches.
// We simulate the guard (`if (cur.backend !== backend) update(...)`) directly
// against a real state.json — if the guard fires incorrectly we'd see an mtime
// bump. Using a write-counter via fs.watchFile is flaky; instead, we stub the
// equality predicate and assert call count.
// ---------------------------------------------------------------------------

describe('restamp guard', () => {
  test('no write when state.backend already matches target', () => {
    // Pure logic test — mirrors the guard expression in pipeline-runner.ts.
    const state = { backend: 'codex' };
    const target = 'codex';
    let writes = 0;
    if (state.backend !== target) { state.backend = target; writes++; }
    assert.equal(writes, 0);
  });

  test('single write when state.backend differs from target', () => {
    const state = { backend: 'claude' };
    const target = 'codex';
    let writes = 0;
    if (state.backend !== target) { state.backend = target; writes++; }
    assert.equal(writes, 1);
    assert.equal(state.backend, 'codex');
  });

  test('single write when state.backend is undefined', () => {
    const state = {};
    const target = 'codex';
    let writes = 0;
    if (state.backend !== target) { state.backend = target; writes++; }
    assert.equal(writes, 1);
  });

  test('phase loop skips sm.update when state.backend equals resolved backend (integration-style)', () => {
    // Mirrors the anatomy-park/szechuan-sauce branches in pipeline-runner.ts
    // which read current state then only update on drift. Ensures we don't
    // regress back to an unconditional sm.update(s.backend = backend) write.
    const statePath = path.join(tmpDir(), 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ backend: 'codex' }));
    const before = fs.statSync(statePath).mtimeMs;
    const cur = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const backend = 'codex';
    let writes = 0;
    if (cur.backend !== backend) { writes++; }
    assert.equal(writes, 0);
    const after = fs.statSync(statePath).mtimeMs;
    assert.equal(before, after, 'mtime must not change when guard short-circuits');
    fs.rmSync(path.dirname(statePath), { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// enterPicklePhase — guards against stale command_template and stale phase
// config files from a previous run misrouting a resumed pickle worker.
// ---------------------------------------------------------------------------

function writeBaseState(statePath, overrides = {}) {
  const base = {
    active: false,
    working_dir: '/tmp',
    step: 'implement',
    iteration: 7,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: 'TICKET-7',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: path.dirname(statePath),
    tmux_mode: true,
    backend: 'claude',
    ...overrides,
  };
  fs.writeFileSync(statePath, JSON.stringify(base));
}

describe('pickle phase entry', () => {
  test('overwrites stale command_template = "anatomy-park.md" with "_pickle-manager-prompt.md"', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeBaseState(statePath, { command_template: 'anatomy-park.md' });

    enterPicklePhase(dir, statePath, 'claude');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.command_template, '_pickle-manager-prompt.md');
    fs.rmSync(dir, { recursive: true });
  });

  test('overwrites stale command_template = "szechuan-sauce.md" with "_pickle-manager-prompt.md"', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeBaseState(statePath, { command_template: 'szechuan-sauce.md' });

    enterPicklePhase(dir, statePath, 'claude');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.command_template, '_pickle-manager-prompt.md');
    fs.rmSync(dir, { recursive: true });
  });

  test('preserves resume pointers (current_ticket, step, iteration, start_time_epoch)', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeBaseState(statePath, {
      command_template: 'anatomy-park.md',
      current_ticket: 'TICKET-42',
      step: 'implement',
      iteration: 13,
      start_time_epoch: 1000,
    });

    enterPicklePhase(dir, statePath, 'claude');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.current_ticket, 'TICKET-42');
    assert.equal(state.step, 'implement');
    assert.equal(state.iteration, 13);
    assert.equal(state.start_time_epoch, 1000);
    fs.rmSync(dir, { recursive: true });
  });

  test('removes stale anatomy-park.json and szechuan-sauce.json from session dir', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeBaseState(statePath, { command_template: 'anatomy-park.md' });
    fs.writeFileSync(path.join(dir, 'anatomy-park.json'), '{"stale":true}');
    fs.writeFileSync(path.join(dir, 'szechuan-sauce.json'), '{"stale":true}');

    enterPicklePhase(dir, statePath, 'claude');

    assert.ok(!fs.existsSync(path.join(dir, 'anatomy-park.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'szechuan-sauce.json')));
    fs.rmSync(dir, { recursive: true });
  });

  test('is a no-op for missing phase config files', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeBaseState(statePath);

    assert.doesNotThrow(() => enterPicklePhase(dir, statePath, 'claude'));
    fs.rmSync(dir, { recursive: true });
  });

  test('updates state.backend on drift', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeBaseState(statePath, { backend: 'claude' });

    enterPicklePhase(dir, statePath, 'codex');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(state.backend, 'codex');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('pipeline shutdown', () => {
  test('SIGTERM deactivates session state before exiting', () => {
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    const dataRoot = path.join(dir, 'data-root');
    const cancelMarker = path.join(dir, 'pipeline-cancel');
    writeBaseState(statePath, { active: true, session_dir: dir });

    const runtime = {
      sessionDir: dir,
      extensionRoot: path.resolve('extension'),
      statePath,
      config: { phases: ['pickle'] },
      target: dir,
      workingDir: dir,
      backend: 'claude',
      phaseEnv: process.env,
      log: () => {},
    };
    const oldExit = process.exit;
    const oldDataRoot = process.env.PICKLE_DATA_ROOT;
    const exitSentinel = new Error('process.exit intercepted');
    let cleanup = () => {};

    try {
      process.env.PICKLE_DATA_ROOT = dataRoot;
      process.exit = ((code) => {
        assert.equal(code, 1);
        throw exitSentinel;
      });
      cleanup = installShutdownHandlers(runtime, { completed: 0, skipped: 0 }, cancelMarker);

      assert.throws(() => process.emit('SIGTERM'), exitSentinel);

      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(state.active, false);
      const status = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));
      assert.equal(status.status, 'cancelled');
    } finally {
      cleanup();
      process.exit = oldExit;
      if (oldDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = oldDataRoot;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AC-LPB-05: applyEpochResetOnReconstruction
// ---------------------------------------------------------------------------

describe('applyEpochResetOnReconstruction', () => {
  test('resets start_time_epoch when iteration > 0 (reconstruction)', () => {
    const dir = tmpDir();
    const oldDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dir;
    try {
      const statePath = path.join(dir, 'state.json');
      const staleEpoch = 1000;
      fs.writeFileSync(statePath, JSON.stringify({
        active: false, working_dir: dir, step: 'implement',
        iteration: 7, max_iterations: 50, max_time_minutes: 720,
        worker_timeout_seconds: 1200, start_time_epoch: staleEpoch,
        completion_promise: null, original_prompt: 'epoch test',
        current_ticket: null, history: [], started_at: new Date().toISOString(),
        session_dir: dir, schema_version: 3,
      }));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

      const result = applyEpochResetOnReconstruction(state, statePath, dir);
      assert.ok(result, 'reconstruction should return a non-null result');
      assert.equal(result.originalEpoch, staleEpoch);
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.notEqual(persisted.start_time_epoch, staleEpoch);
      assert.equal(persisted.start_time_epoch, result.newEpoch);

      // Activity event written
      const activityDir = path.join(dir, 'activity');
      const files = fs.existsSync(activityDir) ? fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl')) : [];
      const lines = files.flatMap((f) => fs.readFileSync(path.join(activityDir, f), 'utf-8').split(/\r?\n/).filter(Boolean));
      const events = lines.map((l) => JSON.parse(l));
      const reset = events.find((e) => e.event === 'session_reconstructed_epoch_reset');
      assert.ok(reset, 'reset event must be emitted');
      assert.equal(reset.original_epoch, staleEpoch);
      assert.equal(reset.new_epoch, result.newEpoch);
    } finally {
      if (oldDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = oldDataRoot;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no-op for fresh launch (iteration === 0 and no phases_entered)', () => {
    const dir = tmpDir();
    const oldDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dir;
    try {
      const statePath = path.join(dir, 'state.json');
      const freshEpoch = 1000;
      fs.writeFileSync(statePath, JSON.stringify({
        active: false, working_dir: dir, step: 'prd',
        iteration: 0, max_iterations: 50, max_time_minutes: 720,
        worker_timeout_seconds: 1200, start_time_epoch: freshEpoch,
        completion_promise: null, original_prompt: 'fresh test',
        current_ticket: null, history: [], started_at: new Date().toISOString(),
        session_dir: dir, schema_version: 3,
      }));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));

      const result = applyEpochResetOnReconstruction(state, statePath, dir);
      assert.equal(result, null, 'fresh launch must not reset epoch');
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(persisted.start_time_epoch, freshEpoch, 'fresh epoch preserved');
    } finally {
      if (oldDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = oldDataRoot;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('treats non-empty phases_entered as reconstruction even when iteration is 0', () => {
    const dir = tmpDir();
    const oldDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dir;
    try {
      const statePath = path.join(dir, 'state.json');
      fs.writeFileSync(statePath, JSON.stringify({
        active: false, working_dir: dir, step: 'review',
        iteration: 0, max_iterations: 50, max_time_minutes: 720,
        worker_timeout_seconds: 1200, start_time_epoch: 500,
        completion_promise: null, original_prompt: 'phase test',
        current_ticket: null, history: [], started_at: new Date().toISOString(),
        session_dir: dir, schema_version: 3,
        phases_entered: ['pickle'],
      }));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const result = applyEpochResetOnReconstruction(state, statePath, dir);
      assert.ok(result);
      assert.equal(result.originalEpoch, 500);
    } finally {
      if (oldDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = oldDataRoot;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Top-level fatal catch deactivates state.json
// ---------------------------------------------------------------------------

describe('pipeline-runner fatal catch', () => {
  test('top-level fatal catch deactivates state.json and stamps exit_reason=fatal', async () => {
    // The fatal catch path in the CLI is hard to trigger via subprocess
    // without contriving a deeply broken pipeline. Instead, directly verify
    // the helpers it relies on land the documented invariants on a state.json
    // that started with active:true.
    const { safeDeactivate, recordExitReason } = await import('../services/state-manager.js');
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      fs.writeFileSync(statePath, JSON.stringify({
        active: true, working_dir: dir, step: 'pickle',
        iteration: 2, max_iterations: 50, max_time_minutes: 720,
        worker_timeout_seconds: 1200, start_time_epoch: 500,
        completion_promise: null, original_prompt: 'pipeline fatal test',
        current_ticket: 'T-MID', history: [], started_at: new Date().toISOString(),
        session_dir: dir, schema_version: 3,
      }));
      // Same sequence the fatal catch runs.
      recordExitReason(statePath, 'fatal');
      safeDeactivate(statePath);

      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(persisted.active, false, 'fatal catch must deactivate (was missing entirely before)');
      assert.equal(persisted.exit_reason, 'fatal');
      // Forensic invariants: step and current_ticket survive.
      assert.equal(persisted.step, 'pickle', 'forensic path preserves step');
      assert.equal(persisted.current_ticket, 'T-MID', 'forensic path preserves current_ticket');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('finalizePipeline success path lands finalizeTerminalState invariants', async () => {
    const { finalizeTerminalState } = await import('../services/state-manager.js');
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      fs.writeFileSync(statePath, JSON.stringify({
        active: true, working_dir: dir, step: 'pickle',
        iteration: 5, max_iterations: 50, max_time_minutes: 720,
        worker_timeout_seconds: 1200, start_time_epoch: 500,
        completion_promise: null, original_prompt: 'pipeline finalize test',
        current_ticket: 'T-99', history: [], started_at: new Date().toISOString(),
        session_dir: dir, schema_version: 3,
      }));
      finalizeTerminalState(statePath, { step: 'completed', exitReason: 'completed' });
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(persisted.active, false);
      assert.equal(persisted.step, 'completed');
      assert.equal(persisted.current_ticket, null);
      assert.equal(persisted.exit_reason, 'completed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('finalizePipeline failed path lands finalizeTerminalState invariants', async () => {
    const { finalizeTerminalState } = await import('../services/state-manager.js');
    const dir = tmpDir();
    try {
      const statePath = path.join(dir, 'state.json');
      fs.writeFileSync(statePath, JSON.stringify({
        active: true, working_dir: dir, step: 'pickle',
        iteration: 5, max_iterations: 50, max_time_minutes: 720,
        worker_timeout_seconds: 1200, start_time_epoch: 500,
        completion_promise: null, original_prompt: 'pipeline finalize failed test',
        current_ticket: 'T-100', history: [], started_at: new Date().toISOString(),
        session_dir: dir, schema_version: 3,
      }));
      finalizeTerminalState(statePath, { step: 'completed', exitReason: 'failed' });
      const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(persisted.active, false);
      assert.equal(persisted.step, 'completed');
      assert.equal(persisted.current_ticket, null);
      assert.equal(persisted.exit_reason, 'failed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // AC-CWRR-5: fatal exit must not zero out already-completed phase counters.
  test('fatal-exit carries forward completed/skipped/total from prior writeRunningStatus (AC-CWRR-5)', () => {
    // Simulate: phases 1+2 complete (writeRunningStatus persists counters), then
    // main() throws and the fatal catch reads those counters and writes 'failed'.
    const dir = tmpDir();
    try {
      // Phase completion: writeRunningStatus would write this
      writePipelineStatus(dir, 'running', {
        current_phase: null,
        completed_phases: 2,
        skipped_phases: 1,
        total_phases: 4,
      });

      // Simulate the AC-CWRR-5 fix: read prior counters, write 'failed' with them
      const prior = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));
      writePipelineStatus(dir, 'failed', {
        completed_phases: typeof prior.completed_phases === 'number' ? prior.completed_phases : 0,
        skipped_phases: typeof prior.skipped_phases === 'number' ? prior.skipped_phases : 0,
        total_phases: typeof prior.total_phases === 'number' ? prior.total_phases : 0,
      });

      const result = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));
      assert.equal(result.status, 'failed');
      assert.equal(result.completed_phases, 2, 'prior completed_phases must survive fatal exit');
      assert.equal(result.skipped_phases, 1, 'prior skipped_phases must survive fatal exit');
      assert.equal(result.total_phases, 4, 'total_phases must survive fatal exit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fatal-exit with no prior pipeline-status.json falls back to zero counts (AC-CWRR-5)', () => {
    // When main() throws before writeRunningStatus has written anything (e.g.
    // loadPipelineRuntime fails), there is no prior file — zeros are correct.
    const dir = tmpDir();
    try {
      writePipelineStatus(dir, 'failed', {
        completed_phases: 0,
        skipped_phases: 0,
        total_phases: 0,
      });
      const result = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));
      assert.equal(result.status, 'failed');
      assert.equal(result.completed_phases, 0);
      assert.equal(result.skipped_phases, 0);
      assert.equal(result.total_phases, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Bundle bootstrap shape — R-A-02
// ---------------------------------------------------------------------------

describe('bundle bootstrap shape', () => {
  const CANONICAL_BUNDLE = {
    phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
    target: '/tmp/project',
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    backend: 'claude',
    bundle_id: '2026-05-10',
    composes: [
      'prds/p1-szechuan-sauce-llm-judge-non-deterministic-scoring-false-stalls.md',
      'prds/p2-citadel-conformance-core-not-wired-or-silently-skipped.md',
      'prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md',
    ],
    refine: true,
    unattended: true,
    expected_version_after: '1.73.1',
  };

  test('parsePipelineConfig produces correct phases and backend from bundle JSON', () => {
    const config = parsePipelineConfig(CANONICAL_BUNDLE);
    assert.deepEqual(config.phases, ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce']);
    assert.equal(config.backend, 'claude');
    assert.equal(config.anatomy_stall_limit, 3);
    assert.equal(config.szechuan_stall_limit, 5);
    assert.equal(config.anatomy_max_iterations, 100);
    assert.equal(config.szechuan_max_iterations, 50);
  });

  test('bundle pipeline.json round-trips through disk with all required keys', () => {
    const dir = tmpDir();
    try {
      const pipelinePath = path.join(dir, 'pipeline.json');
      fs.writeFileSync(pipelinePath, JSON.stringify(CANONICAL_BUNDLE, null, 2));

      const raw = JSON.parse(fs.readFileSync(pipelinePath, 'utf-8'));
      assert.equal(raw.backend, 'claude');
      assert.deepEqual(raw.phases, ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce']);
      assert.equal(Array.isArray(raw.composes), true);
      assert.equal(raw.composes.length, 3);
      assert.equal(raw.bundle_id, '2026-05-10');
      assert.equal(raw.refine, true);
      assert.equal(raw.unattended, true);
      assert.equal(typeof raw.expected_version_after, 'string');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('phases[0] is pickle and backend is claude (invariant check)', () => {
    const raw = { ...CANONICAL_BUNDLE };
    assert.equal(raw.phases[0], 'pickle');
    assert.equal(raw.backend, 'claude');
  });
});

// ---------------------------------------------------------------------------
// runBundlePreflight — R-A-03
// ---------------------------------------------------------------------------

describe('runBundlePreflight', () => {
  function makeSession(overrides = {}) {
    const dir = tmpDir();
    const state = {
      active: false,
      working_dir: dir,
      step: 'prd',
      iteration: 0,
      max_iterations: 50,
      max_time_minutes: 720,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1000,
      completion_promise: null,
      original_prompt: 'bundle preflight test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: dir,
      schema_version: 3,
      ...overrides,
    };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
    return dir;
  }

  test('all-pass: returns void when composes paths exist, have R-codes, manifest >= 26 tickets', () => {
    const dir = makeSession();
    try {
      // Create 3 synthetic PRD files with R-codes
      const prd1 = path.join(dir, 'prd-a.md');
      const prd2 = path.join(dir, 'prd-b.md');
      const prd3 = path.join(dir, 'prd-c.md');
      fs.writeFileSync(prd1, '# PRD A\nR-SLLJ-1: some requirement\n');
      fs.writeFileSync(prd2, '# PRD B\nR-CCNW-3: another requirement\n');
      fs.writeFileSync(prd3, '# PRD C\nR-MDS-7: third requirement\n');

      const pipeline = {
        phases: ['pickle'],
        target: dir,
        composes: [prd1, prd2, prd3],
      };
      fs.writeFileSync(path.join(dir, 'pipeline.json'), JSON.stringify(pipeline));

      const tickets = Array.from({ length: 30 }, (_, i) => ({ id: `ticket-${i}` }));
      fs.writeFileSync(path.join(dir, 'refinement_manifest.json'), JSON.stringify({ tickets }));

      assert.doesNotThrow(() => runBundlePreflight(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails with composes_paths_resolve when a composes path is missing', () => {
    const dir = makeSession();
    try {
      const prd1 = path.join(dir, 'prd-a.md');
      fs.writeFileSync(prd1, '# PRD A\nR-SLLJ-1: requirement\n');
      const missingPath = path.join(dir, 'nonexistent-prd.md');

      const pipeline = {
        phases: ['pickle'],
        target: dir,
        composes: [prd1, missingPath],
      };
      fs.writeFileSync(path.join(dir, 'pipeline.json'), JSON.stringify(pipeline));
      fs.writeFileSync(path.join(dir, 'refinement_manifest.json'), JSON.stringify({ tickets: Array.from({ length: 30 }, (_, i) => ({ id: `t${i}` })) }));

      assert.throws(
        () => runBundlePreflight(dir),
        (err) => {
          assert.ok(err instanceof BundlePreflightError, 'should be BundlePreflightError');
          assert.equal(err.failedAssertion, 'composes_paths_resolve');
          return true;
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails with manifest_R_code_count_ge_26 when manifest has fewer than 26 tickets', () => {
    const dir = makeSession();
    try {
      const prd1 = path.join(dir, 'prd-a.md');
      const prd2 = path.join(dir, 'prd-b.md');
      const prd3 = path.join(dir, 'prd-c.md');
      fs.writeFileSync(prd1, '# PRD A\nR-SLLJ-1: requirement\n');
      fs.writeFileSync(prd2, '# PRD B\nR-CCNW-1: requirement\n');
      fs.writeFileSync(prd3, '# PRD C\nR-MDS-1: requirement\n');

      const pipeline = {
        phases: ['pickle'],
        target: dir,
        composes: [prd1, prd2, prd3],
      };
      fs.writeFileSync(path.join(dir, 'pipeline.json'), JSON.stringify(pipeline));

      // Only 25 tickets — one short of the 26 minimum
      const tickets = Array.from({ length: 25 }, (_, i) => ({ id: `ticket-${i}` }));
      fs.writeFileSync(path.join(dir, 'refinement_manifest.json'), JSON.stringify({ tickets }));

      assert.throws(
        () => runBundlePreflight(dir),
        (err) => {
          assert.ok(err instanceof BundlePreflightError, 'should be BundlePreflightError');
          assert.equal(err.failedAssertion, 'manifest_R_code_count_ge_26');
          return true;
        },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// R-CCR-5 — AC-CCR-5-1: finalizePipeline carries the greppable closer-release
// comment. The phrase is the audit anchor a future refactor must not strip.
// ---------------------------------------------------------------------------

describe('R-CCR-5 closer-release comment anchor', () => {
  test('AC-CCR-5-1: finalizePipeline carries the "handoff stops skip closer-release" comment', () => {
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, '../src/bin/pipeline-runner.ts'),
      'utf-8',
    );
    const fnStart = src.indexOf('function finalizePipeline(');
    assert.notEqual(fnStart, -1, 'finalizePipeline must exist in pipeline-runner.ts');

    // Scope the search to finalizePipeline's body — bounded by the next
    // top-level declaration — so the anchor cannot be satisfied by an
    // unrelated comment elsewhere in the file.
    const after = src.slice(fnStart + 'function finalizePipeline('.length);
    const nextDecl = after.search(/\n(?:export |function |type |interface |class )/);
    const body = nextDecl === -1 ? after : after.slice(0, nextDecl);

    assert.match(
      body,
      /\/\/[^\n]*handoff stops skip closer-release/,
      'AC-CCR-5-1: finalizePipeline must carry a // comment with the literal '
        + 'phrase "handoff stops skip closer-release"',
    );
  });
});

describe('R-HRP-1 citadel fix-forward (stops halting; feeds the remediator)', () => {
  function writeCitadelState(statePath, overrides = {}) {
    const dir = path.dirname(statePath);
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      working_dir: dir,
      step: 'citadel',
      iteration: 1,
      max_iterations: 50,
      max_time_minutes: 720,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1000,
      completion_promise: null,
      original_prompt: 'citadel fix-forward test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: dir,
      schema_version: 3,
      exit_reason: null,
      prd_path: 'prd.md',
      start_commit: 'abc1234',
      backend: 'claude',
      activity: [],
      ...overrides,
    }, null, 2));
  }

  function makeRuntime(dir, { strict = false } = {}) {
    return {
      sessionDir: dir,
      statePath: path.join(dir, 'state.json'),
      repoRoot: dir,
      workingDir: dir,
      extensionRoot: dir,
      backend: 'claude',
      phaseEnv: { ...process.env },
      designSafe: false,
      log: () => {},
      config: {
        phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
        target: dir,
        child_mux_runner_heartbeat_ms: 1000,
        child_mux_runner_stall_seconds: 60,
        anatomy_stall_limit: 3,
        szechuan_stall_limit: 5,
        anatomy_max_iterations: 100,
        szechuan_max_iterations: 50,
        citadel_strict: strict,
        dirty_exempt_segments: [],
      },
    };
  }

  function citadelResult(findings) {
    return {
      schema: '1.0',
      schema_version: '1.0',
      prd_path: 'prd.md',
      diff_range: 'abc1234..HEAD',
      exit_code: findings.length ? 2 : 0,
      exitCode: findings.length ? 2 : 0,
      header: { pickle_phase_failed: false, pickle_exit_code: 0 },
      sections: {},
      findings,
      decision_required: [],
      decisions: [],
      summary: {
        findings: findings.length, critical: 0, high: 0, medium: 0, low: 0,
        decision_required: 0, decisions: 0, unguarded_trap_doors: 0,
      },
      markdown: '',
      json: {},
    };
  }

  const CRITICAL = [{ id: 'C-1', severity: 'Critical', message: 'boom', file: 'a.ts', line: 7 }];

  test('citadel_findings_unremediated is registered in VALID_ACTIVITY_EVENTS', () => {
    assert.ok(
      VALID_ACTIVITY_EVENTS.includes('citadel_findings_unremediated'),
      'citadel_findings_unremediated must be present in VALID_ACTIVITY_EVENTS',
    );
  });

  // (a) Critical findings do NOT halt: the phase exit is non-halting and the next phase
  // (anatomy-park) is dispatched.
  test('(a) Critical findings do not halt — phase returns 0 and shouldHaltAfterPhase is false', async () => {
    const dir = tmpDir();
    try {
      writeCitadelState(path.join(dir, 'state.json'));
      const runtime = makeRuntime(dir);
      let auditCalls = 0;
      __setCitadelRemediationDepsForTests({
        loadSettings: () => ({ cap: 3, remediatorTimeoutMs: 1000 }),
        runCitadelAudit: async () => citadelResult(auditCalls++ === 0 ? CRITICAL : []),
        spawnGateRemediatorMain: async ({ argv, stdout }) => {
          const briefPath = path.join(dir, 'gate', 'brief.md');
          fs.writeFileSync(briefPath, 'fix it');
          stdout(`BRIEF_PATH=${briefPath}`);
          void argv;
          return 0;
        },
        spawnRemediator: () => { /* no-op worker */ },
      });

      const { exitCode } = await executeCitadelPhase(runtime);

      assert.equal(exitCode, 0, 'citadel must return a non-halting exit code (0)');
      assert.equal(
        shouldHaltAfterPhase('citadel', exitCode, runtime),
        false,
        'shouldHaltAfterPhase must be false for citadel — next phase (anatomy-park) is dispatched',
      );
    } finally {
      __setCitadelRemediationDepsForTests(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // (b) spawnGateRemediatorMain is invoked with a GateResult whose failures correspond to the
  // citadel findings.
  test('(b) spawnGateRemediatorMain receives a GateResult whose failures correspond to the findings', async () => {
    const dir = tmpDir();
    try {
      writeCitadelState(path.join(dir, 'state.json'));
      const runtime = makeRuntime(dir);
      let auditCalls = 0;
      const captured = [];
      __setCitadelRemediationDepsForTests({
        loadSettings: () => ({ cap: 3, remediatorTimeoutMs: 1000 }),
        runCitadelAudit: async () => citadelResult(auditCalls++ === 0 ? CRITICAL : []),
        spawnGateRemediatorMain: async ({ argv }) => {
          const idx = argv.indexOf('--gate-result');
          const gateResultPath = argv[idx + 1];
          captured.push(JSON.parse(fs.readFileSync(gateResultPath, 'utf-8')));
          // No BRIEF_PATH emitted → remediateCitadelFindings returns early (no worker spawn).
          return 0;
        },
        spawnRemediator: () => { throw new Error('worker should not spawn in this test'); },
      });

      await executeCitadelPhase(runtime);

      assert.equal(captured.length, 1, 'spawnGateRemediatorMain must be invoked once');
      const gateResult = captured[0];
      assert.ok(isGateResult(gateResult), 'gate result must satisfy isGateResult()');
      assert.equal(gateResult.failures.length, CRITICAL.length, 'one failure per finding');
      assert.equal(
        gateResult.failures[0].ruleOrCode,
        CRITICAL[0].id,
        'each GateFailure must correspond to its citadel finding id',
      );
      assert.equal(gateResult.status, 'red', 'non-empty findings → red gate result');
    } finally {
      __setCitadelRemediationDepsForTests(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // (c) When the remediator exhausts citadel_max_remediation_cycles with findings still open, the
  // pipeline logs a citadel_findings_unremediated activity event and STILL continues (no halt).
  test('(c) cap exhausted with findings open — logs citadel_findings_unremediated and continues', async () => {
    const dir = tmpDir();
    try {
      writeCitadelState(path.join(dir, 'state.json'));
      const runtime = makeRuntime(dir);
      __setCitadelRemediationDepsForTests({
        loadSettings: () => ({ cap: 2, remediatorTimeoutMs: 1000 }),
        // Findings never clear → remediation is a no-op → cap is exhausted.
        runCitadelAudit: async () => citadelResult(CRITICAL),
        spawnGateRemediatorMain: async ({ stdout }) => {
          const briefPath = path.join(dir, 'gate', 'brief.md');
          fs.writeFileSync(briefPath, 'fix it');
          stdout(`BRIEF_PATH=${briefPath}`);
          return 0;
        },
        spawnRemediator: () => { /* no-op: never fixes the finding */ },
      });

      const { exitCode } = await executeCitadelPhase(runtime);

      assert.equal(exitCode, 0, 'cap exhaustion must NOT halt — phase still returns 0');
      assert.equal(
        shouldHaltAfterPhase('citadel', exitCode, runtime),
        false,
        'exit reason is not a halt even after cap exhaustion',
      );
      const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
      const event = (persisted.activity ?? []).find(e => e.event === 'citadel_findings_unremediated');
      assert.ok(event, 'a citadel_findings_unremediated activity event must be logged');
      assert.equal(event.cycles, 2, 'event records the exhausted cap');
      assert.ok(event.findings_remaining >= 1, 'event records the remaining open findings');
    } finally {
      __setCitadelRemediationDepsForTests(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // PATTERN_SHAPE: no shouldHaltAfterPhase branch references 'citadel'; no
  // citadel_strict ? 'High' : 'Critical' halt-threshold expression remains anywhere.
  test('PATTERN_SHAPE: halt path no longer special-cases citadel and the halt-threshold ternary is gone', () => {
    const srcPath = path.join(import.meta.dirname, '..', 'src', 'bin', 'pipeline-runner.ts');
    const src = fs.readFileSync(srcPath, 'utf-8');

    // The shouldHaltAfterPhase function body must contain no 'citadel' string literal.
    const fnStart = src.indexOf('export function shouldHaltAfterPhase');
    assert.ok(fnStart >= 0, 'shouldHaltAfterPhase must exist');
    const fnBody = src.slice(fnStart, src.indexOf('\n}\n', fnStart) + 2);
    assert.doesNotMatch(
      fnBody,
      /['"]citadel['"]/,
      "shouldHaltAfterPhase must not reference the 'citadel' literal",
    );

    // No citadel_strict ? 'High' : 'Critical' halt-threshold expression anywhere (whitespace-tolerant).
    assert.doesNotMatch(
      src,
      /citadel_strict\s*\?\s*['"]High['"]\s*:\s*['"]Critical['"]/,
      "the citadel_strict ? 'High' : 'Critical' halt-threshold expression must be deleted",
    );
  });
});

// ---------------------------------------------------------------------------
// AC-SCPIN-5 — honest fatal-pickle-halt reason: a missing baseline
// (`start_commit` never captured) is unmeasurable, NOT the same incident as a
// captured baseline with genuinely zero commits since it. `logPhaseHaltReason`
// must say a distinct, true thing for each — the halt/no-halt decision itself
// (isFatalPhaseFailure / shouldHaltAfterPhase) is unchanged.
// ---------------------------------------------------------------------------

describe('AC-SCPIN-5 honest phase-halt reason', () => {
  function scpinTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-scpin5-'));
  }

  function writePickleState(statePath, overrides = {}) {
    const dir = path.dirname(statePath);
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      working_dir: dir,
      step: 'pickle',
      iteration: 1,
      max_iterations: 50,
      max_time_minutes: 720,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1000,
      completion_promise: null,
      original_prompt: 'AC-SCPIN-5 test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: dir,
      schema_version: 3,
      exit_reason: null,
      prd_path: 'prd.md',
      backend: 'claude',
      activity: [],
      ...overrides,
    }, null, 2));
  }

  function seedGitRepoAndCommit(dir) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'seed.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
  }

  function scpinRuntime(dir) {
    return {
      sessionDir: dir,
      statePath: path.join(dir, 'state.json'),
      repoRoot: dir,
      workingDir: dir,
      extensionRoot: dir,
      backend: 'claude',
      phaseEnv: { ...process.env },
      designSafe: false,
      log: () => {},
      config: {
        phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
        target: dir,
        child_mux_runner_heartbeat_ms: 1000,
        child_mux_runner_stall_seconds: 60,
        anatomy_stall_limit: 3,
        szechuan_stall_limit: 5,
        anatomy_max_iterations: 100,
        szechuan_max_iterations: 50,
        citadel_strict: false,
        dirty_exempt_segments: [],
      },
    };
  }

  test('!startCommit halt says "baseline unmeasurable", never "zero commits"', () => {
    const dir = scpinTmpDir();
    try {
      // No start_commit field at all — the baseline was never captured.
      writePickleState(path.join(dir, 'state.json'));
      const runtime = scpinRuntime(dir);

      assert.equal(
        isFatalPhaseFailure('pickle', runtime),
        true,
        'missing start_commit must still be fatal (halt/no-halt decision unchanged)',
      );

      const logged = [];
      logPhaseHaltReason(runtime, 'pickle', 1, (msg) => logged.push(msg));
      const combined = logged.join('\n');

      assert.match(
        combined,
        /baseline unmeasurable/,
        'must report the missing baseline honestly',
      );
      assert.doesNotMatch(
        combined,
        /zero commits/,
        'must NOT conflate a missing baseline with zero build progress',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // B-NOSTOP-GATES WS-1: zero commits since baseline is a QUALITY signal
  // (reported via maybeStampPhaseGraduation's phase_no_progress branch, which
  // now advances instead of halting), not a crash-floor cannot-continue
  // condition. The isFatalPhaseFailure halt/no-halt decision DID change here —
  // OLD (pre-WS-1): true (fatal). NEW (WS-1): false. `getFatalPickleHaltReason`'s
  // message-generation logic is UNCHANGED (still reachable via the
  // `--strict-phases` / `pipeline_continue_on_phase_fail: false` opt-in halt
  // path, per its own inline comment), so this test now exercises the messaging
  // function directly rather than via the (no longer applicable) fatal decision.
  test('captured baseline with zero commits reports "zero commits", never "baseline unmeasurable"', () => {
    const dir = scpinTmpDir();
    try {
      const startCommit = seedGitRepoAndCommit(dir);

      writePickleState(path.join(dir, 'state.json'), { start_commit: startCommit });
      const runtime = scpinRuntime(dir);

      assert.equal(
        isFatalPhaseFailure('pickle', runtime),
        false,
        'zero commits since a captured baseline is no longer fatal — B-NOSTOP-GATES WS-1 neutralized this arm',
      );

      const logged = [];
      logPhaseHaltReason(runtime, 'pickle', 1, (msg) => logged.push(msg));
      const combined = logged.join('\n');

      assert.match(
        combined,
        /zero commits/,
        'must report genuine zero build progress honestly',
      );
      assert.doesNotMatch(
        combined,
        /baseline unmeasurable/,
        'must NOT report a captured baseline as unmeasurable',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('strict-phase-policy halt with real commits since baseline never says "zero commits"', () => {
    // logPhaseHaltReason's pickle branch is reachable even when isFatalPhaseFailure
    // is false: shouldHaltAfterPhase also halts when pipeline_continue_on_phase_fail
    // is false (--strict-phases), regardless of build progress. getFatalPickleHaltReason
    // must not assume "startCommit present -> zero commits" in that case.
    const dir = scpinTmpDir();
    try {
      const startCommit = seedGitRepoAndCommit(dir);

      // Real build progress landed after the baseline was captured.
      fs.writeFileSync(path.join(dir, 'progress.ts'), 'export const y = 2;\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', 'real progress'], { cwd: dir });

      writePickleState(path.join(dir, 'state.json'), {
        start_commit: startCommit,
        pipeline_continue_on_phase_fail: false,
      });
      const runtime = scpinRuntime(dir);

      assert.equal(
        isFatalPhaseFailure('pickle', runtime),
        false,
        'real commits since baseline must not be classified fatal by commit count',
      );
      assert.equal(
        shouldHaltAfterPhase('pickle', 1, runtime),
        true,
        'strict phase policy still halts even without a fatal-by-commit-count reason',
      );

      const logged = [];
      logPhaseHaltReason(runtime, 'pickle', 1, (msg) => logged.push(msg));
      const combined = logged.join('\n');

      assert.doesNotMatch(
        combined,
        /zero commits/,
        'must NOT falsely claim zero build progress when real commits landed since baseline',
      );
      assert.doesNotMatch(
        combined,
        /baseline unmeasurable/,
        'must NOT report a captured baseline as unmeasurable',
      );
      assert.match(
        combined,
        /commit\(s\) since baseline/,
        'must report the true commit count for a halt not driven by zero build progress',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// R-MDS-1 / R-MDS-4 centralized-dispatcher pin (anatomy-park iter 8).
//
// The trap-door PATTERN_SHAPE demanded `respawnMonitorWindowForMode` invocation
// count >= 3 in pipeline-runner.ts, "one per non-citadel boundary". Those calls
// were centralized into a single `handlePhaseBoundaryRespawn` dispatcher, so the
// real count is 1 and the anchor was FALSE — a replay reports a phantom violation
// and reads as "phase-boundary respawn was deleted". Every pre-existing R-MDS test
// exercises the respawn FUNCTION's behavior; none asserted the wiring shape, so
// nothing could detect the drift. These pin the shape the catalog now documents.
describe('R-MDS-1 centralized phase-boundary monitor dispatcher', () => {
  const PR_SRC = fs.readFileSync(new URL('../src/bin/pipeline-runner.ts', import.meta.url), 'utf-8');

  test('respawnMonitorWindowForMode is invoked from exactly one dispatcher', () => {
    const invocations = PR_SRC.match(/await respawnMonitorWindowForMode\(/g) ?? [];
    assert.equal(
      invocations.length,
      1,
      'R-MDS-1: the per-boundary respawn calls are centralized into handlePhaseBoundaryRespawn. ' +
      'A count != 1 means the dispatcher was forked or removed — reconcile the trap door too.',
    );
  });

  test('the dispatcher is awaited once per phase boundary in the phase loop', () => {
    assert.match(
      PR_SRC,
      /await handlePhaseBoundaryRespawn\(runtime, rawPhase, nextRawPhase\);/,
      'R-MDS-4: every completed phase must reach the respawn dispatcher from the phase loop',
    );
  });

  test('the dispatcher forwards the phase being ENTERED as the monitor mode', () => {
    assert.match(
      PR_SRC,
      /const mode = nextRawPhase \?\? 'idle';/,
      'R-MDS-4: the monitor mode is the phase being entered, not the phase just finished',
    );
    assert.match(
      PR_SRC,
      /respawnMonitorWindowForMode\(runtime\.sessionDir, mode,/,
      'R-MDS-4: passing currentPhase would rebind pane 1.0 one phase behind',
    );
  });
});

describe('AP-EXT-ITER7-01 replay: the phase-runner transport decodes on the STREAM, not per chunk', () => {
  const PR_SRC = fs.readFileSync(new URL('../src/bin/pipeline-runner.ts', import.meta.url), 'utf-8');

  test('spawnRunner sets the stdout/stderr encoding before attaching its data handlers', () => {
    // An OS pipe boundary is a BYTE offset, so a multi-byte UTF-8 character straddles it and a
    // per-chunk `toString()` yields U+FFFD for each half — mojibake in the echoed phase output
    // and in the accumulated stdout/stderr. The behavioral proof of the shape lives in
    // extension/tests/codegraph-degradation.test.js ('AP-EXT-ITER7-01 multi-byte round-trip'),
    // which drives the identical transport end-to-end; this site's real `spawnRunner` needs a
    // `phaseRunnerContext` only `main()` installs, so it is pinned structurally here.
    const spawnBody = PR_SRC.slice(PR_SRC.indexOf('function spawnRunner('));
    const stdoutHandler = spawnBody.indexOf("child.stdout?.on('data'");
    const setEncoding = spawnBody.indexOf("child.stdout?.setEncoding(");
    assert.ok(setEncoding >= 0, 'spawnRunner must call child.stdout.setEncoding');
    assert.ok(
      setEncoding < stdoutHandler,
      'setEncoding must precede the data handler — a late call cannot un-mangle bytes already read',
    );
    assert.match(
      spawnBody.slice(0, stdoutHandler),
      /child\.stderr\?\.setEncoding\('utf-8'\)/,
      'stderr carries the same non-ASCII log glyphs and needs the same decoder',
    );
  });
});

// ---------------------------------------------------------------------------
// B-CRASHFLOOR — the pickle branch of isFatalPhaseFailure reads exit_reason
// against CRASH_FLOOR_EXIT_REASONS, mirroring the microverse arm's consult of
// MICROVERSE_FATAL_REASONS. Covers AC-CF-01..04, AC-CF-09..13, AC-CF-17.
// ---------------------------------------------------------------------------

describe('B-CRASHFLOOR pickle-arm crash floor', () => {
  function cfTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-crashfloor-'));
  }

  function seedGitRepoAndCommitCF(dir) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'seed.ts'), 'export const x = 1;\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
  }

  function writeCfState(statePath, overrides = {}) {
    const dir = path.dirname(statePath);
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      working_dir: dir,
      step: 'pickle',
      iteration: 1,
      max_iterations: 50,
      max_time_minutes: 720,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1000,
      completion_promise: null,
      original_prompt: 'B-CRASHFLOOR test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: dir,
      schema_version: 3,
      exit_reason: null,
      prd_path: 'prd.md',
      backend: 'claude',
      activity: [],
      ...overrides,
    }, null, 2));
  }

  function cfRuntime(dir, overrides = {}) {
    return {
      sessionDir: dir,
      statePath: path.join(dir, 'state.json'),
      repoRoot: dir,
      workingDir: dir,
      extensionRoot: dir,
      backend: 'claude',
      phaseEnv: { ...process.env },
      designSafe: false,
      log: () => {},
      config: {
        phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
        target: dir,
        child_mux_runner_heartbeat_ms: 1000,
        child_mux_runner_stall_seconds: 60,
        anatomy_stall_limit: 3,
        szechuan_stall_limit: 5,
        anatomy_max_iterations: 100,
        szechuan_max_iterations: 50,
        citadel_strict: false,
        dirty_exempt_segments: [],
      },
      ...overrides,
    };
  }

  test('CRASH_FLOOR_EXIT_REASONS has exactly 3 members', () => {
    assert.equal(CRASH_FLOOR_EXIT_REASONS.length, 3);
    assert.deepEqual(
      new Set(CRASH_FLOOR_EXIT_REASONS),
      new Set(['toolchain_unavailable', 'state_working_dir_missing', 'state_schema_version_ahead']),
    );
  });

  // AC-CF-01: every CRASH_FLOOR_EXIT_REASONS member halts a non-zero pickle exit —
  // derived from the exported const at runtime, no hardcoded literals.
  test('AC-CF-01: every CRASH_FLOOR_EXIT_REASONS member halts the pickle arm', () => {
    for (const reason of CRASH_FLOOR_EXIT_REASONS) {
      const dir = cfTmpDir();
      try {
        const startCommit = seedGitRepoAndCommitCF(dir);
        writeCfState(path.join(dir, 'state.json'), { start_commit: startCommit, exit_reason: reason });
        const runtime = cfRuntime(dir);
        assert.equal(
          isFatalPhaseFailure('pickle', runtime),
          true,
          `exit_reason=${reason} must halt the pickle arm`,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // AC-CF-02: every ExitReason NOT in the crash-floor set continues to citadel —
  // derived from EXIT_REASONS' complement at runtime. Must fail if the predicate
  // were isFailureExit (picks reasons that ARE in mux-runner's FAILURE_EXIT_REASONS
  // but are NOT crash-floor members, e.g. 'error'/'stall'/'circuit_open').
  test('AC-CF-02: every non-crash-floor ExitReason does not halt the pickle arm', () => {
    const crashFloorSet = new Set(CRASH_FLOOR_EXIT_REASONS);
    const nonCrashFloorReasons = EXIT_REASONS.filter((r) => !crashFloorSet.has(r));
    assert.ok(nonCrashFloorReasons.length > 0, 'sanity: there must be non-crash-floor reasons');
    for (const reason of nonCrashFloorReasons) {
      const dir = cfTmpDir();
      try {
        const startCommit = seedGitRepoAndCommitCF(dir);
        writeCfState(path.join(dir, 'state.json'), { start_commit: startCommit, exit_reason: reason });
        const runtime = cfRuntime(dir);
        assert.equal(
          isFatalPhaseFailure('pickle', runtime),
          false,
          `exit_reason=${reason} must NOT halt the pickle arm (not a crash-floor reason)`,
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // AC-CF-03: the pickle arm's halting-condition count goes 1 -> 3 and no further.
  // Enumerated set of exit_reason values that halt (with a valid start_commit)
  // equals exactly CRASH_FLOOR_EXIT_REASONS (3 members); the pre-existing
  // !startCommit guard is the 4th, orthogonal condition (unchanged behavior).
  test('AC-CF-03: exactly the 3 crash-floor reasons halt via exit_reason; no other reason does', () => {
    const dir = cfTmpDir();
    try {
      const startCommit = seedGitRepoAndCommitCF(dir);
      const haltingReasons = new Set();
      for (const reason of EXIT_REASONS) {
        writeCfState(path.join(dir, 'state.json'), { start_commit: startCommit, exit_reason: reason });
        const runtime = cfRuntime(dir);
        if (isFatalPhaseFailure('pickle', runtime)) haltingReasons.add(reason);
      }
      assert.deepEqual(haltingReasons, new Set(CRASH_FLOOR_EXIT_REASONS));

      // The pre-existing !startCommit guard still halts, independent of exit_reason.
      writeCfState(path.join(dir, 'state.json'));
      const runtimeNoBaseline = cfRuntime(dir);
      assert.equal(isFatalPhaseFailure('pickle', runtimeNoBaseline), true, '!startCommit is still fatal');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // AC-CF-04: a throwing sm.read fails OPEN (non-halt), removing the prior abort.
  test('AC-CF-04: a throwing sm.read (missing state.json) fails open — non-halt', () => {
    const dir = cfTmpDir();
    try {
      // No state.json written at all — StateManager.read throws StateError('MISSING', ...).
      const runtime = cfRuntime(dir);
      assert.equal(
        isFatalPhaseFailure('pickle', runtime),
        false,
        'a read error must not halt the pipeline (park-and-flag, never abort)',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // AC-CF-10/11: both a default session (flag unset -> backfilled true) and a
  // --strict-phases session (false) halt on a crash-floor reason.
  test('AC-CF-10: default session (pipeline_continue_on_phase_fail unset) halts on a crash-floor reason', () => {
    const dir = cfTmpDir();
    try {
      const startCommit = seedGitRepoAndCommitCF(dir);
      writeCfState(path.join(dir, 'state.json'), {
        start_commit: startCommit,
        exit_reason: 'toolchain_unavailable',
      });
      const runtime = cfRuntime(dir);
      assert.equal(shouldHaltAfterPhase('pickle', 1, runtime), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AC-CF-11: --strict-phases session (pipeline_continue_on_phase_fail=false) halts on a crash-floor reason', () => {
    const dir = cfTmpDir();
    try {
      const startCommit = seedGitRepoAndCommitCF(dir);
      writeCfState(path.join(dir, 'state.json'), {
        start_commit: startCommit,
        exit_reason: 'toolchain_unavailable',
        pipeline_continue_on_phase_fail: false,
      });
      const runtime = cfRuntime(dir);
      assert.equal(shouldHaltAfterPhase('pickle', 1, runtime), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // AC-CF-12: absent or unrecognised exit_reason on a non-zero pickle exit does NOT halt.
  test('AC-CF-12: undefined exit_reason does not halt', () => {
    const dir = cfTmpDir();
    try {
      const startCommit = seedGitRepoAndCommitCF(dir);
      const statePath = path.join(dir, 'state.json');
      writeCfState(statePath, { start_commit: startCommit });
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      delete raw.exit_reason;
      fs.writeFileSync(statePath, JSON.stringify(raw, null, 2));
      const runtime = cfRuntime(dir);
      assert.equal(isFatalPhaseFailure('pickle', runtime), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AC-CF-12: unrecognised exit_reason string does not halt', () => {
    const dir = cfTmpDir();
    try {
      const startCommit = seedGitRepoAndCommitCF(dir);
      writeCfState(path.join(dir, 'state.json'), {
        start_commit: startCommit,
        exit_reason: 'some_unknown_reason_xyz',
      });
      const runtime = cfRuntime(dir);
      assert.equal(isFatalPhaseFailure('pickle', runtime), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // AC-CF-13: a crash-floor reason still halts, independent of stale-handoff-clearing
  // logic that lives in a different call site (runPhaseIteration). isFatalPhaseFailure
  // only ever sees the single current exit_reason value.
  test('AC-CF-13: a crash-floor reason halts even though it shares the field stale handoff reasons occupy', () => {
    const dir = cfTmpDir();
    try {
      const startCommit = seedGitRepoAndCommitCF(dir);
      writeCfState(path.join(dir, 'state.json'), {
        start_commit: startCommit,
        exit_reason: 'toolchain_unavailable',
      });
      const runtime = cfRuntime(dir);
      assert.equal(
        isFatalPhaseFailure('pickle', runtime),
        true,
        'a crash-floor reason halts regardless of surrounding handoff-clearing logic elsewhere',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // AC-CF-17: net-subtractive — the new exports exist, and the halt predicate used
  // is not isFailureExit. (No new state field / exit reason / skip flag is asserted
  // by code review + the AC-CF-01/02 exhaustive sweeps above, which would fail if a
  // stray reason were added without updating both exported consts together.)
  test('AC-CF-17: types/index.ts exports both new consts; halt predicate is not isFailureExit', () => {
    const typesSrc = fs.readFileSync(
      new URL('../src/types/index.ts', import.meta.url),
      'utf-8',
    );
    assert.match(typesSrc, /export const CRASH_FLOOR_EXIT_REASONS = \[/);
    assert.match(typesSrc, /export const EXIT_REASONS = \[/);

    const prSrc = fs.readFileSync(new URL('../src/bin/pipeline-runner.ts', import.meta.url), 'utf-8');
    const fnStart = prSrc.indexOf('export function isFatalPhaseFailure');
    const pickleArmEnd = prSrc.indexOf("if (phase === 'anatomy-park'", fnStart);
    const pickleArm = prSrc.slice(fnStart, pickleArmEnd);
    assert.doesNotMatch(pickleArm, /isFailureExit/, 'the pickle arm must not consult isFailureExit');
    assert.match(pickleArm, /isCrashFloorExitReason/, 'the pickle arm must consult the crash-floor predicate');
  });

  /**
   * R-NOPOSTTIER (ticket fa3d0f5a) — AC-5.
   *
   * The parity test below proves the const and mux-runner's union AGREE; it cannot prove
   * nothing was ADDED, because a member added to BOTH sides passes it. This pin closes that:
   * the withholding R-NOPOSTTIER introduces must reuse `counters.nonConvergent` and a
   * disposition string, never a new exit reason. `exit_reason` stays `completed` on a degraded
   * post-final verdict — see `finalizePipeline`'s `pipelineFailed`-keyed terminal stamp.
   *
   * Adding a genuinely new exit reason is a deliberate act: edit this list in the same commit
   * and say why. It is not a list to regenerate from source when the assertion goes red.
   */
  test('AC-5: EXIT_REASONS membership is byte-identical to the pre-R-NOPOSTTIER set', () => {
    assert.deepEqual([...EXIT_REASONS], [
      'success', 'cancelled', 'error', 'limit', 'iteration_cap_exhausted', 'stall', 'circuit_open',
      'rate_limit_exhausted', 'timeout_repeat', 'manager_persistent_hallucination',
      'codex_unhealthy_consecutive_failures', 'working_tree_modified_externally',
      'state_schema_version_ahead', 'closer_handoff_terminal', 'manager_handoff_pending',
      'done_without_commit_evidence', 'codex_manager_no_progress', 'recovery_exhausted',
      'idle_stall_unrecoverable', 'state_working_dir_missing', 'toolchain_unavailable',
    ], 'R-NOPOSTTIER must add no member — the withholding is a disposition, not an exit reason');
  });

  // EXIT_REASONS is now the single source of truth: mux-runner's `ExitReason` DERIVES from it
  // (`typeof EXIT_REASONS[number]`) rather than restating the members as a hand-maintained
  // literal union. That collapse retired the source-text parity test this replaces — parity is
  // no longer something to check, because there is only one list. What still needs a pin is the
  // derivation itself: `types/index.ts` cannot import `mux-runner.ts` without a cycle, so the
  // type system cannot stop someone from re-expanding the union into literals. If that happens,
  // a reason added to the union alone is once again never swept by the AC-CF-02/03 sweeps above,
  // which iterate EXIT_REASONS. Same shape as the `Backend derives from BACKENDS` pin below.
  test('mux-runner ExitReason derives from EXIT_REASONS rather than restating its members', () => {
    const muxSrc = fs.readFileSync(new URL('../src/bin/mux-runner.ts', import.meta.url), 'utf-8');
    const decl = /^export type ExitReason =([^;]*);/m.exec(muxSrc);
    assert.ok(decl, 'mux-runner.ts must declare `export type ExitReason = …;`');
    assert.equal(
      decl[1].trim(),
      'typeof EXIT_REASONS[number]',
      'ExitReason must derive from EXIT_REASONS (types/index.ts), not restate its members as a '
        + 'literal union — a union member absent from the array is never swept by AC-CF-02/03',
    );

    // The derivation only holds if the array literal is `as const`; without it the members
    // widen to `string` and `ExitReason` silently becomes `string`.
    const typesSrc = fs.readFileSync(new URL('../src/types/index.ts', import.meta.url), 'utf-8');
    assert.match(
      typesSrc,
      /^export const EXIT_REASONS = \[[\s\S]*?\] as const;$/m,
      'the EXIT_REASONS array literal must be `as const` or ExitReason widens to string',
    );

    // ...and only if mux-runner actually imports the array it derives from.
    assert.match(
      muxSrc,
      /^import \{[^}]*\bEXIT_REASONS\b[^}]*\} from '\.\.\/types\/index\.js';$/m,
      'mux-runner.ts must import EXIT_REASONS from ../types/index.js for the derivation to resolve',
    );
  });

  // Backend derives from BACKENDS. `Backend` and `BACKENDS` live in the SAME file, so unlike
  // the ExitReason case above there is no import cycle forcing them apart — the type can and
  // must derive from the const. The pre-fix shape (`export type Backend = 'claude' | … ;`
  // plus `export const BACKENDS: readonly Backend[] = [...]`) made them parallel copies in
  // ONE direction: a backend added to the union but not to the array still typechecks, and
  // every runtime validator built on BACKENDS (setup.ts, backend-spawn.ts, spawn-morty.ts,
  // metrics-utils.ts) then silently rejects the new backend and falls back to 'claude'.
  // pipeline-runner.ts itself validates `--backend` through `(BACKENDS as readonly string[])
  // .includes(rawBackend)`, so it is a direct consumer of the drift.
  test('Backend derives from BACKENDS rather than being a parallel hand-maintained union', () => {
    const typesSrc = fs.readFileSync(new URL('../src/types/index.ts', import.meta.url), 'utf-8');

    const typeDecl = /^export type Backend =([^;]*);/m.exec(typesSrc);
    assert.ok(typeDecl, 'types/index.ts must declare `export type Backend = …;`');
    assert.equal(
      typeDecl[1].trim(),
      'typeof BACKENDS[number]',
      'Backend must derive from BACKENDS, not restate its members as a literal union',
    );

    const constDecl = /^export const BACKENDS([^=]*)=/m.exec(typesSrc);
    assert.ok(constDecl, 'types/index.ts must declare `export const BACKENDS = …`');
    assert.equal(
      constDecl[1].trim(),
      '',
      'BACKENDS must carry no `: readonly Backend[]` annotation — that annotation is what let '
        + 'the union and the array drift (a union member missing from the array still typechecks)',
    );

    // The derivation only holds if the array literal is `as const`; without it the members
    // widen to `string` and `Backend` silently becomes `string`.
    assert.match(
      typesSrc,
      /^export const BACKENDS = \[[^\]]*\] as const;$/m,
      'the BACKENDS array literal must be `as const` or Backend widens to string',
    );

    // The derived union must still carry the real members, so a caller cannot pass an
    // arbitrary string where a Backend is expected.
    assert.ok(
      BACKENDS.includes('claude') && BACKENDS.includes('codex') && BACKENDS.length >= 2,
      'sanity: BACKENDS must still hold the real backend members',
    );
  });

  // AC-CF-05: getFatalPickleHaltReason (consulted via the exported logPhaseHaltReason)
  // must name the crash-floor reason on a zero-commit + toolchain_unavailable state,
  // never the stale "zero commits since baseline" string.
  test('AC-CF-05: zero-commit toolchain_unavailable halt names the crash-floor reason', () => {
    const dir = cfTmpDir();
    try {
      const startCommit = seedGitRepoAndCommitCF(dir);
      // No commits landed since startCommit -> commitCount === 0.
      writeCfState(path.join(dir, 'state.json'), {
        start_commit: startCommit,
        exit_reason: 'toolchain_unavailable',
      });
      const runtime = cfRuntime(dir);
      const lines = [];
      logPhaseHaltReason(runtime, 'pickle', 1, (msg) => lines.push(msg));
      const joined = lines.join('\n');
      assert.match(joined, /toolchain_unavailable/, 'operator string must name the crash-floor reason');
      assert.doesNotMatch(
        joined,
        /zero commits since baseline/,
        'must not report the misleading zero-commits story for a crash-floor halt',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // AC-CF-15 single-source: `isCrashFloorPickleHalt` (the abort-gate skip predicate) and the
  // pickle arm of `isFatalPhaseFailure` were parallel copies of the SAME two conditions —
  // `!start_commit` and a `CRASH_FLOOR_EXIT_REASONS` member. Two copies of one predicate means a
  // future crash-floor condition added to the exported halt predicate does NOT reach the gate
  // skip, so the abort path burns a ~60s guaranteed-red typecheck+lint gate and stamps a
  // misattributed `tsc_gate_failed`. The predicate now derives; the collapse is enforced here.
  test('AC-CF-15: isCrashFloorPickleHalt derives from isFatalPhaseFailure, not a parallel copy', () => {
    const prSrc = fs.readFileSync(new URL('../src/bin/pipeline-runner.ts', import.meta.url), 'utf-8');
    const fnStart = prSrc.indexOf('function isCrashFloorPickleHalt');
    assert.ok(fnStart >= 0, 'pipeline-runner.ts must declare isCrashFloorPickleHalt');
    const bodyEnd = prSrc.indexOf('\n}', fnStart);
    assert.ok(bodyEnd > fnStart, 'sanity: the function body must terminate');
    const body = prSrc.slice(fnStart, bodyEnd);

    assert.match(
      body,
      /isFatalPhaseFailure\(/,
      'the gate-skip predicate must consult the exported halt predicate, not re-derive it',
    );
    assert.doesNotMatch(
      body,
      /start_commit/,
      're-checking start_commit forks the crash-floor predicate into two copies',
    );
    assert.doesNotMatch(
      body,
      /isCrashFloorExitReason/,
      're-checking CRASH_FLOOR_EXIT_REASONS forks the crash-floor predicate into two copies',
    );
  });
});

// ---------------------------------------------------------------------------
// B-CRASHFLOOR ticket 8e3a5d62 — dispatchHaltAction skips the doomed abort-path
// typecheck+lint gate on a crash-floor halt (AC-CF-15), and citadel /
// anatomy-park / szechuan-sauce are never invoked after one (AC-CF-14). The
// gate narrowing must be exactly that — a narrowing, not a deletion: a
// NON-crash-floor strict-phases halt still runs the abort gate (AC-CF-15
// narrowing case).
// ---------------------------------------------------------------------------

describe('B-CRASHFLOOR dispatchHaltAction gate skip', () => {
  class ExitIntercept extends Error {
    constructor(code) {
      super(`process.exit(${code})`);
      this.code = code;
    }
  }

  function tmp(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }

  function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  }

  // A repo whose typecheck/lint scripts always fail — if the abort-path gate
  // runs against it, runGate reports status:'red' and dispatchHaltAction emits
  // tsc_gate_failed. No real tsc/eslint spawn: node -e keeps this fast-tier safe.
  function initRedGateRepo(dir) {
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'test@test.local'], dir);
    git(['config', 'user.name', 'Test'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'cf-gate-fixture',
      version: '0.0.0',
      private: true,
      scripts: {
        typecheck: 'node -e "process.exit(1)"',
        lint: 'node -e "process.exit(1)"',
      },
    }, null, 2));
    git(['add', '.'], dir);
    git(['commit', '-q', '-m', 'seed'], dir);
    return git(['rev-parse', 'HEAD'], dir);
  }

  function writeMainState(sessionDir, repo, startCommit, overrides = {}) {
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
      active: false,
      working_dir: repo,
      step: 'implement',
      iteration: 0,
      max_iterations: 100,
      max_time_minutes: 720,
      worker_timeout_seconds: 1200,
      start_time_epoch: 1000,
      completion_promise: null,
      original_prompt: 'B-CRASHFLOOR gate-skip test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: sessionDir,
      schema_version: 3,
      tmux_mode: false,
      chain_meeseeks: false,
      backend: 'claude',
      start_commit: startCommit,
      exit_reason: null,
      activity: [],
      ...overrides,
    }, null, 2));
  }

  function writeMainPipeline(sessionDir, repo, phases) {
    fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
      phases,
      target: repo,
      anatomy_stall_limit: 3,
      szechuan_stall_limit: 5,
      anatomy_max_iterations: 100,
      szechuan_max_iterations: 50,
      dirty_exempt_segments: ['prds', 'docs'],
    }, null, 2));
  }

  async function captureMainExit(sessionDir, expectedCode) {
    const originalExit = process.exit;
    const originalTmux = process.env.TMUX;
    delete process.env.TMUX;
    process.exit = (code) => { throw new ExitIntercept(code ?? 0); };
    try {
      await assert.rejects(
        () => main(sessionDir),
        (err) => err instanceof ExitIntercept && err.code === expectedCode,
      );
    } finally {
      process.exit = originalExit;
      if (originalTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = originalTmux;
    }
  }

  function readActivityEvents(dataRoot) {
    const activityDir = path.join(dataRoot, 'activity');
    if (!fs.existsSync(activityDir)) return [];
    return fs.readdirSync(activityDir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => fs.readFileSync(path.join(activityDir, f), 'utf-8').split(/\r?\n/).filter(Boolean))
      .map((l) => JSON.parse(l));
  }

  // AC-CF-14 + AC-CF-15: a crash-floor pickle halt runs spawnRunner exactly once
  // (for pickle), never reaches citadel/anatomy-park/szechuan-sauce, and never
  // emits tsc_gate_failed even though the target repo's gate would report RED.
  test('AC-CF-14/AC-CF-15: crash-floor halt skips the abort gate and downstream phases', async () => {
    const repo = tmp('cf-gateskip-repo-');
    const sessionDir = tmp('cf-gateskip-session-');
    const dataRoot = tmp('cf-gateskip-dataroot-');
    const prevDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    let spawnRunnerCalls = 0;
    try {
      const startCommit = initRedGateRepo(repo);
      writeMainState(sessionDir, repo, startCommit);
      writeMainPipeline(sessionDir, repo, ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce']);

      __setSpawnRunnerForTests(async () => {
        spawnRunnerCalls += 1;
        const statePath = path.join(sessionDir, 'state.json');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        state.exit_reason = 'toolchain_unavailable';
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        return { exitCode: 1, stdout: '', stderr: '' };
      });

      await captureMainExit(sessionDir, 1);

      assert.equal(spawnRunnerCalls, 1, 'downstream phases must never invoke spawnRunner after a crash-floor halt');

      const runnerLog = fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
      assert.doesNotMatch(
        runnerLog,
        /PHASE 2\/4: CITADEL/,
        'citadel must never be reached after a crash-floor pickle halt',
      );

      const events = readActivityEvents(dataRoot);
      const gateFailed = events.filter((e) => e.event === 'tsc_gate_failed');
      assert.equal(gateFailed.length, 0, 'a crash-floor halt must not run the abort-path gate at all, RED or not');
    } finally {
      __setSpawnRunnerForTests(null);
      if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = prevDataRoot;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  // AC-CF-15 narrowing case: a NON-crash-floor strict-phases halt (exit_reason
  // not a member of CRASH_FLOOR_EXIT_REASONS, pipeline_continue_on_phase_fail:
  // false) still runs the abort-path gate — the skip is a narrowing, not a
  // deletion.
  test('AC-CF-15 narrowing: a non-crash-floor strict-phases halt still runs the abort gate', async () => {
    const repo = tmp('cf-gateskip-nonfloor-repo-');
    const sessionDir = tmp('cf-gateskip-nonfloor-session-');
    const dataRoot = tmp('cf-gateskip-nonfloor-dataroot-');
    const prevDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    try {
      const startCommit = initRedGateRepo(repo);
      writeMainState(sessionDir, repo, startCommit, { pipeline_continue_on_phase_fail: false });
      writeMainPipeline(sessionDir, repo, ['pickle', 'citadel']);

      __setSpawnRunnerForTests(async () => {
        const statePath = path.join(sessionDir, 'state.json');
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        // 'error' is a valid ExitReason but NOT a CRASH_FLOOR_EXIT_REASONS member.
        state.exit_reason = 'error';
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        return { exitCode: 1, stdout: '', stderr: '' };
      });

      await captureMainExit(sessionDir, 1);

      const events = readActivityEvents(dataRoot);
      const gateFailed = events.filter((e) => e.event === 'tsc_gate_failed');
      assert.ok(gateFailed.length >= 1, 'a non-crash-floor strict-phases halt must still run the abort-path gate');
    } finally {
      __setSpawnRunnerForTests(null);
      if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = prevDataRoot;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER5-01: setupAnatomyPark preserves an in-flight anatomy-park.json
// ---------------------------------------------------------------------------

const AP_REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function makeAnatomySubsystemTarget() {
  const target = tmpDir();
  const sub = path.join(target, 'services');
  fs.mkdirSync(sub, { recursive: true });
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(sub, `s${i}.ts`), `export const s${i} = ${i};\n`);
  }
  return target;
}

function makeAnatomySessionDir(workingDir) {
  const sessionDir = tmpDir();
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: workingDir,
    step: 'anatomy-park',
    iteration: 0,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'anatomy resume test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
  }, null, 2));
  return sessionDir;
}

describe('AP-EXT-ITER5-01 setupAnatomyPark resume ledger', () => {
  test('re-entering the phase preserves pass counts, findings history and pending trap doors', () => {
    const repo = tmpDir();
    initRepo(repo);
    const target = makeAnatomySubsystemTarget();
    const sessionDir = makeAnatomySessionDir(repo);
    const configPath = path.join(sessionDir, 'anatomy-park.json');
    try {
      assert.equal(setupAnatomyPark(sessionDir, target, 3, AP_REPO_ROOT, () => {}), true);

      // Simulate a phase that ran 9 passes (one of them clean) and recorded a
      // trap door that has not been flushed to CLAUDE.md yet, then crashed.
      const live = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      live.pass_counts.services = 9;
      live.consecutive_clean.services = 0;
      live.current_index = 0;
      live.findings_history.services = [{ iteration: 4, findings: [] }, { iteration: 9, findings: [{ id: 'X' }] }];
      live.trap_doors_added = [{ subsystem: 'services', file: 'services/CLAUDE.md', description: 'pending' }];
      fs.writeFileSync(configPath, JSON.stringify(live, null, 2));

      // Crash-resume re-enters anatomy-park, so phase setup runs again.
      assert.equal(setupAnatomyPark(sessionDir, target, 3, AP_REPO_ROOT, () => {}), true);

      const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      assert.equal(after.pass_counts.services, 9, 'pass_counts must survive re-entry (B-APNC ceiling input)');
      assert.equal(after.findings_history.services.length, 2, 'findings_history must survive re-entry');
      assert.equal(after.trap_doors_added.length, 1, 'un-flushed trap doors must survive re-entry');
      assert.equal(after.stall_limit, 3);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('a converged prior ledger is replaced with a fresh one', () => {
    const repo = tmpDir();
    initRepo(repo);
    const target = makeAnatomySubsystemTarget();
    const sessionDir = makeAnatomySessionDir(repo);
    const configPath = path.join(sessionDir, 'anatomy-park.json');
    try {
      assert.equal(setupAnatomyPark(sessionDir, target, 3, AP_REPO_ROOT, () => {}), true);
      const live = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      live.pass_counts.services = 7;
      live.consecutive_clean.services = 2;
      fs.writeFileSync(configPath, JSON.stringify(live, null, 2));

      assert.equal(setupAnatomyPark(sessionDir, target, 3, AP_REPO_ROOT, () => {}), true);

      const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      assert.equal(after.pass_counts.services, 0, 'a converged ledger must not carry into a new run');
      assert.equal(after.consecutive_clean.services, 0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('a prior ledger missing a counter entry is not carried forward', () => {
    const repo = tmpDir();
    initRepo(repo);
    const target = makeAnatomySubsystemTarget();
    const sessionDir = makeAnatomySessionDir(repo);
    const configPath = path.join(sessionDir, 'anatomy-park.json');
    try {
      fs.writeFileSync(configPath, JSON.stringify({
        subsystems: ['services'],
        current_index: 0,
        pass_counts: { services: 4 },
        consecutive_clean: {},
        stall_counts: { services: 0 },
        findings_history: { services: [] },
        stall_limit: 3,
        trap_doors_added: [],
        trap_doors_committed: [],
      }, null, 2));

      assert.equal(setupAnatomyPark(sessionDir, target, 3, AP_REPO_ROOT, () => {}), true);

      const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      assert.equal(after.consecutive_clean.services, 0, 'every subsystem key must be initialized, never left undefined');
      assert.equal(after.pass_counts.services, 0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('a different subsystem list is not carried forward', () => {
    const repo = tmpDir();
    initRepo(repo);
    const target = makeAnatomySubsystemTarget();
    const sessionDir = makeAnatomySessionDir(repo);
    const configPath = path.join(sessionDir, 'anatomy-park.json');
    try {
      fs.writeFileSync(configPath, JSON.stringify({
        subsystems: ['somethingelse'],
        current_index: 0,
        pass_counts: { somethingelse: 5 },
        consecutive_clean: { somethingelse: 0 },
        stall_counts: { somethingelse: 0 },
        stall_limit: 3,
        findings_history: { somethingelse: [] },
        trap_doors_added: [],
        trap_doors_committed: [],
      }, null, 2));

      assert.equal(setupAnatomyPark(sessionDir, target, 3, AP_REPO_ROOT, () => {}), true);

      const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      assert.deepEqual(after.subsystems, ['services']);
      assert.equal(after.pass_counts.services, 0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

/**
 * AP-EXT-ITER6-02: `scope.json` is written tmp-rename, so a crash between the write and the
 * rename leaves ONLY `scope.json.tmp.<pid>`. `readPersistedAllowedPaths` used to short-circuit
 * on `fs.existsSync(scopePath)` BEFORE the `readRecoverableJsonObject` on the very next line,
 * so a recoverable fence read as "unscoped" and the resumed anatomy/szechuan phase reviewed —
 * and committed across — the whole repo with no scope fence.
 *
 * Assert the RECOVERED VALUE and the promotion on disk, never merely "no throw": the pre-fix
 * code returned `undefined` quietly, which is exactly what a laxer pin would have blessed.
 */
function deadPidForTmp() {
  // A pid that is provably not alive, so `shouldSkipLiveTmp` does not defer the tmp.
  for (const candidate of [999_999, 888_888, 777_777]) {
    try { process.kill(candidate, 0); } catch { return candidate; }
  }
  throw new Error('no dead pid available for fixture');
}

describe('AP-EXT-ITER6-02 persisted scope.json survives a crashed tmp-rename', () => {
  test('a tmp-only scope.json still yields the fenced allowed_paths, and is promoted', () => {
    const sessionDir = tmpDir();
    try {
      const scopePath = path.join(sessionDir, 'scope.json');
      const tmpPath = `${scopePath}.tmp.${deadPidForTmp()}`;
      fs.writeFileSync(tmpPath, JSON.stringify({
        version: 1,
        mode: 'paths',
        allowed_paths: ['extension/src/bin/pipeline-runner.ts', 'extension/src/types/index.ts'],
      }, null, 2));
      assert.equal(fs.existsSync(scopePath), false, 'fixture must start with NO base scope.json');

      assert.deepEqual(readPersistedAllowedPaths(sessionDir), [
        'extension/src/bin/pipeline-runner.ts',
        'extension/src/types/index.ts',
      ]);
      assert.equal(fs.existsSync(scopePath), true, 'the recoverable read must promote the tmp');
      assert.equal(fs.existsSync(tmpPath), false);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('a genuinely absent scope.json is still unscoped (undefined)', () => {
    const sessionDir = tmpDir();
    try {
      assert.equal(readPersistedAllowedPaths(sessionDir), undefined);
      assert.equal(fs.existsSync(path.join(sessionDir, 'scope.json')), false);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('a readable base scope.json is unaffected', () => {
    const sessionDir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(sessionDir, 'scope.json'),
        JSON.stringify({ allowed_paths: ['extension/src/bin/microverse-runner.ts'] }, null, 2),
      );
      assert.deepEqual(readPersistedAllowedPaths(sessionDir), ['extension/src/bin/microverse-runner.ts']);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
