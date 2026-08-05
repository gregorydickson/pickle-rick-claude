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
