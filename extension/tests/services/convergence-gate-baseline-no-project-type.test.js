// @tier: fast
//
// R-APBN-1 / R-APBN-2 / R-APBN-3 regression coverage.
//
// runGate({mode:'baseline'}) MUST write a valid empty GateBaselineFile to
// `baselinePath` whenever the early-return paths fire (no project-type marker
// at workingDir, OR detected project-type has no entry in gate-commands.json).
// Without this, the trap-door at microverse-runner.capturePerIterationGateBaseline
// observes `pathExists(baselinePath) === false` after a "successful" gate
// return and kills the anatomy-park phase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runGate } from '../../services/convergence-gate.js';

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('runGate baseline (no project type at workingDir): writes empty baseline.json with project_type=null', async () => {
  const workingDir = mkTmp('apbn-no-pt-');
  const events = [];
  try {
    // No package.json, no Cargo.toml, no go.mod, etc. — detectProjectType returns null.
    const baselinePath = path.join(workingDir, 'session', 'gate', 'baseline.json');

    const result = await runGate({
      workingDir,
      mode: 'baseline',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
      baselinePath,
      onEvent: (event, data) => events.push({ event, data }),
    });

    assert.equal(result.status, 'green', 'gate result remains green on skip');
    assert.equal(result.failures.length, 0, 'no failures on no-project skip');
    assert.equal(fs.existsSync(baselinePath), true, 'baseline file MUST be on disk after no-project skip');

    // Observability preserved: gate_skipped still fires with the same reason payload.
    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(skipped, 'gate_skipped event must still fire');
    assert.equal(skipped.data.reason, 'no_project_type_detected');

    // Post-write disk-check event mirrors the existing baseline-write path.
    const postWrite = events.find(e => e.event === 'gate_baseline_disk_check' && e.data.phase === 'post_write');
    assert.ok(postWrite, 'gate_baseline_disk_check post_write must fire');
    assert.equal(postWrite.data.exists, true);

    // File contents are a valid GateBaselineFile shape with empty checks/failures.
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.equal(baseline.schema_version, 1);
    assert.equal(baseline.project_type, null, 'project_type === null when no marker present');
    assert.deepEqual(baseline.checks, [], 'checks === [] on skipped baseline');
    assert.deepEqual(baseline.failures, [], 'failures === [] on skipped baseline');
    assert.equal(baseline.working_dir, workingDir);
    assert.equal(typeof baseline.captured_at, 'string');
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('runGate baseline (project type detected but no cmdMap): writes empty baseline.json with project_type=bun', async () => {
  // bun is detected by detectProjectType (via bun.lock) but gate-commands.json
  // has no entry for it — exercises the second early-return path (line ~1019).
  const workingDir = mkTmp('apbn-no-cmdmap-');
  const events = [];
  try {
    fs.writeFileSync(path.join(workingDir, 'bun.lock'), '');
    const baselinePath = path.join(workingDir, 'session', 'gate', 'baseline.json');

    const result = await runGate({
      workingDir,
      mode: 'baseline',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
      baselinePath,
      onEvent: (event, data) => events.push({ event, data }),
    });

    assert.equal(result.status, 'green');
    assert.equal(result.failures.length, 0);
    assert.equal(fs.existsSync(baselinePath), true, 'baseline file MUST be on disk after low-confidence skip');

    const skipped = events.find(e => e.event === 'gate_skipped');
    assert.ok(skipped);
    assert.equal(skipped.data.reason, 'project_type_low_confidence');
    assert.deepEqual(skipped.data.detected_signals, ['bun']);

    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.equal(baseline.schema_version, 1);
    assert.equal(baseline.project_type, 'bun');
    assert.deepEqual(baseline.checks, []);
    assert.deepEqual(baseline.failures, []);
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('runGate baseline (existing baseline-write path): unchanged for npm project with package.json + lock', async () => {
  const workingDir = mkTmp('apbn-npm-baseline-');
  try {
    fs.writeFileSync(path.join(workingDir, 'package.json'), JSON.stringify({
      name: 'fixture',
      private: true,
      // R-SZGB-D-A: all three checks must be runnable (exit 0) so this fixture proves
      // project-type detection/baseline-write is unaffected, not the unrunnable-check path.
      scripts: {
        typecheck: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }, null, 2));
    fs.writeFileSync(path.join(workingDir, 'package-lock.json'), JSON.stringify({ name: 'fixture', lockfileVersion: 3 }));
    const baselinePath = path.join(workingDir, 'session', 'gate', 'baseline.json');

    const result = await runGate({
      workingDir,
      mode: 'baseline',
      scope: 'full',
      checks: ['typecheck', 'lint', 'tests'],
      baselinePath,
    });

    assert.equal(result.status, 'green');
    assert.equal(fs.existsSync(baselinePath), true, 'baseline file MUST exist on disk');

    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    assert.equal(baseline.schema_version, 1);
    assert.equal(baseline.project_type, 'npm', 'project_type === npm when package-lock.json present');
    assert.deepEqual(baseline.checks, ['typecheck', 'lint', 'tests'], 'checks reflect the runGate input');
    assert.ok(Array.isArray(baseline.failures), 'failures is an array');
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});
