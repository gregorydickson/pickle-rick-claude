// @tier: fast
// AP-EXT-ITER317-01 — a criterion command killed by an external signal has no exit
// status. `spawnSync` reports it as `status: null` with `error` UNDEFINED (only the
// timeout kill sets `error`), so collapsing that null onto 1 made a killed command
// byte-identical to one that ran and exited 1. The signal deaths below are produced
// by the OS, not simulated: `runCriterion` is module-private and has no spawn seam.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAcPhaseGate, AC_PHASE_MANIFEST } from '../../services/ac-phase-gate.js';

function withTempSession(fn) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-gate-signal-'));
  try {
    return fn(sessionDir);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

function runWithCriterion(criterion) {
  return withTempSession((sessionDir) => {
    fs.writeFileSync(
      path.join(sessionDir, AC_PHASE_MANIFEST),
      JSON.stringify({ acceptance_criteria: [criterion] }),
    );
    return runAcPhaseGate({ sessionDir, evaluationPhase: 'bundle-end', cwd: sessionDir });
  });
}

// The whole finding: a criterion that expects a REJECTION (exit 1) is the arm where
// the phantom 1 reads as agreement, so a command that never ran certifies the AC.
test('AP-EXT-ITER317-01: a SIGKILLed command does not satisfy expected_exit_code 1', () => {
  const result = runWithCriterion({
    id: 'sigkill-expects-one',
    evaluation_phase: 'bundle-end',
    expected_exit_code: 1,
    command: ['/bin/sh', '-c', 'kill -KILL $$'],
  });

  assert.equal(result.status, 'fail', `expected fail, got ${JSON.stringify(result)}`);
  const failure = result.failures.find((f) => f.id === 'sigkill-expects-one');
  assert.ok(failure, 'expected a failure for sigkill-expects-one');
  assert.match(failure.reason, /killed by signal SIGKILL/);
});

// The unconditional half: even where the verdict was already fail-closed, the REASON
// asserted an exit code the process never produced.
test('AP-EXT-ITER317-01: a SIGTERMed command reports the signal, not a phantom exit 1', () => {
  const result = runWithCriterion({
    id: 'sigterm-default-expected',
    evaluation_phase: 'bundle-end',
    command: ['/bin/sh', '-c', 'kill -TERM $$'],
  });

  assert.equal(result.status, 'fail');
  const failure = result.failures.find((f) => f.id === 'sigterm-default-expected');
  assert.ok(failure, 'expected a failure for sigterm-default-expected');
  assert.match(failure.reason, /killed by signal SIGTERM/);
  assert.doesNotMatch(
    failure.reason,
    /got 1/,
    'a process killed by a signal never exited 1; the reason must not claim it did',
  );
});

// Over-trigger control: the arm the fix must NOT disturb. A command that really ran
// and exited 1 still satisfies expected_exit_code 1 — without this, a blanket
// always-fail mutant would pass the two rejection cases above.
test('AP-EXT-ITER317-01 control: a real exit 1 still satisfies expected_exit_code 1', () => {
  const result = runWithCriterion({
    id: 'real-exit-one',
    evaluation_phase: 'bundle-end',
    expected_exit_code: 1,
    command: ['/bin/sh', '-c', 'exit 1'],
  });

  assert.equal(result.status, 'pass', `expected pass, got ${JSON.stringify(result.failures)}`);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.evaluated, ['real-exit-one']);
});
