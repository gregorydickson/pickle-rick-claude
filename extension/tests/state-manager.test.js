// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateManager, inspectLockFile, writeActivityEntry, safeDeactivate, finalizeTerminalState, recordExitReason, clearExitReason, assertSchemaVersionDeployParity, SchemaVersionDeployDriftError, InvalidActivityEventError } from '../services/state-manager.js';
import {
  StateError,
  LockError,
  TransactionError,
  SchemaVersionMismatchError,
  STATE_MANAGER_DEFAULTS,
  LATEST_SCHEMA_VERSION,
  VALID_ACTIVITY_EVENTS,
  LEGACY_MICROVERSE_EXIT_REASON_RENAMES,
} from '../types/index.js';
import { writeStateFile } from '../services/pickle-utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sm-'));
}

function makeState(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/test',
    step: 'prd',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'test prompt',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: 1,
    ...overrides,
  };
}

function withDir(fn) {
  const dir = tmpDir();
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertV3Defaults(state) {
  assert.equal(state.archaeology, null);
  assert.equal(state.tickets_version, 0);
  assert.equal(state.last_course_correction, null);
  assert.equal(state.phase_personas_active, false);
  assert.deepEqual(state.flags, {});
  assert.deepEqual(state.readiness, { cycle_history: [] });
  assert.equal(state.codex_version_seen, null);
}

function captureStderr(fn) {
  const writes = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = function patchedWrite(chunk, ...args) {
    writes.push(String(chunk));
    if (typeof args[args.length - 1] === 'function') args[args.length - 1]();
    return true;
  };

  try {
    return { result: fn(), writes };
  } finally {
    process.stderr.write = originalWrite;
  }
}

// ---------------------------------------------------------------------------
// read — valid state
// ---------------------------------------------------------------------------

test('StateManager.read: reads valid state file', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    const state = makeState();
    writeStateFile(sp, state);
    const result = sm.read(sp);
    assert.equal(result.active, true);
    assert.equal(result.iteration, 1);
    assert.equal(result.schema_version, LATEST_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// read — missing file
// ---------------------------------------------------------------------------

test('StateManager.read: throws MISSING for non-existent file', () => {
  const sm = new StateManager();
  try {
    sm.read('/tmp/nonexistent-pickle-state-99999.json');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof StateError);
    assert.equal(err.code, 'MISSING');
  }
});

// ---------------------------------------------------------------------------
// read — corrupt JSON
// ---------------------------------------------------------------------------

test('StateManager.read: throws CORRUPT for invalid JSON', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, '{invalid json!!!');
    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'CORRUPT');
    }
  });
});

test('StateManager.read: throws CORRUPT for JSON array', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, '[1,2,3]');
    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'CORRUPT');
    }
  });
});

test('StateManager.read: throws CORRUPT for JSON null', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, 'null');
    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'CORRUPT');
    }
  });
});

test('StateManager.read: ignores newer dead tmp snapshots that are missing required state fields', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    const state = makeState({ schema_version: 3, session_dir: dir });
    writeStateFile(sp, state);

    const orphanTmp = `${sp}.tmp.99999999`;
    fs.writeFileSync(orphanTmp, JSON.stringify({ iteration: 2 }));
    const baseTime = new Date('2026-05-07T12:00:00.000Z');
    const tmpTime = new Date('2026-05-07T12:00:05.000Z');
    fs.utimesSync(sp, baseTime, baseTime);
    fs.utimesSync(orphanTmp, tmpTime, tmpTime);

    const recovered = sm.read(sp);
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));

    assert.equal(recovered.iteration, 1, 'in-memory state must stay on the valid base snapshot');
    assert.equal(recovered.working_dir, '/tmp/test');
    assert.equal(onDisk.iteration, 1, 'invalid orphan tmp must not replace state.json on disk');
    assert.equal(onDisk.working_dir, '/tmp/test');
    assert.equal(fs.existsSync(orphanTmp), false, 'invalid orphan tmp should be discarded after recovery');
  });
});

test('StateManager.read: ignores newer dead tmp snapshots that require a newer schema version than this runtime supports', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    const state = makeState({ schema_version: LATEST_SCHEMA_VERSION, session_dir: dir });
    writeStateFile(sp, state);

    const orphanTmp = `${sp}.tmp.99999999`;
    fs.writeFileSync(
      orphanTmp,
      JSON.stringify(makeState({ iteration: 2, schema_version: LATEST_SCHEMA_VERSION + 1, session_dir: dir })),
    );
    const baseTime = new Date('2026-05-07T12:00:00.000Z');
    const tmpTime = new Date('2026-05-07T12:00:05.000Z');
    fs.utimesSync(sp, baseTime, baseTime);
    fs.utimesSync(orphanTmp, tmpTime, tmpTime);

    const recovered = sm.read(sp);
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));

    assert.equal(recovered.iteration, 1, 'current runtime must keep the readable base snapshot');
    assert.equal(recovered.schema_version, LATEST_SCHEMA_VERSION);
    assert.equal(onDisk.iteration, 1, 'future-schema orphan tmp must not replace state.json on disk');
    assert.equal(onDisk.schema_version, LATEST_SCHEMA_VERSION);
    assert.equal(fs.existsSync(orphanTmp), false, 'future-schema orphan tmp should be discarded after recovery');
  });
});

test('StateManager.read: recovers a newer dead tmp snapshot produced by resetStep transitions', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    const snapshotSource = path.join(dir, 'snapshot-source.json');
    writeStateFile(sp, makeState({ schema_version: LATEST_SCHEMA_VERSION, session_dir: dir }));
    writeStateFile(snapshotSource, makeState({
      schema_version: LATEST_SCHEMA_VERSION,
      session_dir: dir,
      step: 'review',
      current_ticket: 'T-100',
      exit_reason: 'completed',
      command_template: 'pickle-pipeline.md',
    }));

    clearExitReason(snapshotSource, { resetStep: true, resetCurrentTicket: true });
    const resetSnapshot = JSON.parse(fs.readFileSync(snapshotSource, 'utf-8'));
    assert.equal(resetSnapshot.step, null, 'fixture must mirror resetStateForPhase / clearExitReason output');

    const orphanTmp = `${sp}.tmp.99999999`;
    fs.writeFileSync(orphanTmp, JSON.stringify({ ...resetSnapshot, iteration: 2 }, null, 2));
    fs.writeFileSync(sp, '{invalid json!!!');
    const baseTime = new Date('2026-05-07T12:00:00.000Z');
    const tmpTime = new Date('2026-05-07T12:00:05.000Z');
    fs.utimesSync(sp, baseTime, baseTime);
    fs.utimesSync(orphanTmp, tmpTime, tmpTime);

    const recovered = sm.read(sp);
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));

    assert.equal(recovered.iteration, 2);
    assert.equal(recovered.step, null, 'reset-step tmp snapshots must be treated as recoverable state');
    assert.equal(recovered.current_ticket, null);
    assert.equal(onDisk.step, null);
    assert.equal(onDisk.current_ticket, null);
    assert.equal(fs.existsSync(orphanTmp), false, 'promoted orphan tmp should replace the corrupt base');
  });
});

// ---------------------------------------------------------------------------
// read — schema migration
// ---------------------------------------------------------------------------

test('StateManager.read: migrates undefined schema_version to current schema', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    const state = makeState();
    delete state.schema_version;
    fs.writeFileSync(sp, JSON.stringify(state, null, 2));
    const result = sm.read(sp);
    assert.equal(result.schema_version, LATEST_SCHEMA_VERSION);
    assertV3Defaults(result);
    // Persisted to disk
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.schema_version, LATEST_SCHEMA_VERSION);
    assertV3Defaults(onDisk);
  });
});

test('StateManager.read: legacy baseline_unmeasurable upgraded', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      schema_version: LATEST_SCHEMA_VERSION,
      session_dir: dir,
      exit_reason: 'baseline_unmeasurable',
    }));

    const result = sm.read(sp);

    assert.equal(result.exit_reason, 'metric_unmeasurable_unrecoverable');
  });
});

test('StateManager.read: baseline_unmeasurable upgrade idempotent', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      schema_version: LATEST_SCHEMA_VERSION,
      session_dir: dir,
      exit_reason: 'metric_unmeasurable_unrecoverable',
    }));

    const first = sm.read(sp);
    const second = sm.read(sp);

    assert.equal(first.exit_reason, 'metric_unmeasurable_unrecoverable');
    assert.equal(second.exit_reason, 'metric_unmeasurable_unrecoverable');
  });
});

test('StateManager.read: baseline_unmeasurable upgrade null safe', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      schema_version: LATEST_SCHEMA_VERSION,
      session_dir: dir,
      exit_reason: null,
    }));

    const result = sm.read(sp);

    assert.equal(result.exit_reason, null);
  });
});

test('StateManager.read: baseline_unmeasurable upgrade leaves unrelated value untouched', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      schema_version: LATEST_SCHEMA_VERSION,
      session_dir: dir,
      exit_reason: 'converged',
    }));

    const result = sm.read(sp);

    assert.equal(result.exit_reason, 'converged');
  });
});

test('StateManager.read: Z2-4 every legacy baseline_unmeasurable_* reads back as its renamed reason', () => {
  // Derived from the exported rename map, so a fourth legacy spelling cannot be added without a row.
  for (const [legacy, current] of Object.entries(LEGACY_MICROVERSE_EXIT_REASON_RENAMES)) {
    withDir((dir) => {
      const sm = new StateManager();
      const sp = path.join(dir, 'state.json');
      writeStateFile(sp, makeState({ schema_version: LATEST_SCHEMA_VERSION, session_dir: dir, exit_reason: legacy }));

      const first = sm.read(sp);
      const second = sm.read(sp);

      assert.equal(first.exit_reason, current, `${legacy} must read back as ${current}`);
      assert.equal(second.exit_reason, current, `${legacy} rename must be idempotent`);
      assert.notEqual(current, legacy);
      assert.equal(current.startsWith('baseline_'), false, `${current} must not carry the baseline_ prefix`);
    });
  }
});

test('StateManager.read: Z2-4 the rename map covers exactly the three legacy spellings', () => {
  assert.deepEqual(Object.keys(LEGACY_MICROVERSE_EXIT_REASON_RENAMES).sort(), [
    'baseline_unmeasurable', 'baseline_unmeasurable_transient', 'baseline_unmeasurable_unrecoverable',
  ]);
});

test('StateManager.read: throws SCHEMA_MISMATCH for future schema version', () => {
  withDir((dir) => {
    // State file claims schema_version 2, but this binary only understands version 1
    const sm = new StateManager({ schemaVersion: 1 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ schema_version: 2 }));
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({ iteration: 10, schema_version: 1 })));
    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'SCHEMA_MISMATCH');
    }
    assert.equal(fs.existsSync(tmpFile), true, 'future-schema base must fail before tmp recovery mutates siblings');
  });
});

test('StateManager.read: v3-shaped missing schema fails recoverably on v2-aware deployment', () => {
  withDir((dir) => {
    const sm = new StateManager({ schemaVersion: 2 });
    const sp = path.join(dir, 'state.json');
    const state = makeState({
      prd_path: path.join(dir, 'prd.md'),
      start_commit: 'abc123',
    });
    delete state.schema_version;
    fs.writeFileSync(sp, JSON.stringify(state, null, 2));

    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({ iteration: 10, schema_version: 2 })));

    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'SCHEMA_MISMATCH');
      assert.match(err.message, /schema v3 fields/);
      assert.match(err.message, /prd_path/);
      assert.match(err.message, /start_commit/);
      assert.match(err.message, /supports schema_version 2/);
      assert.match(err.message, /Recover by running a current Pickle Rick runtime or restoring a pre-v3 state backup/);
    }

    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.schema_version, undefined, 'v2-aware read must not stamp schema_version on v3-shaped state');
    assert.equal(fs.existsSync(tmpFile), true, 'v3-shaped base must fail before tmp recovery mutates siblings');
  });
});

test('StateManager.read: any v3 marker without schema fails recoverably on v2-aware deployment', () => {
  const cases = [
    ['tickets_version', { tickets_version: 1 }],
    ['phase_personas_active', { phase_personas_active: true }],
    ['flags', { flags: { strict_teams: true } }],
    ['readiness', { readiness: { cycle_history: [] } }],
    ['codex_version_seen', { codex_version_seen: '0.42.0' }],
  ];

  for (const [marker, override] of cases) {
    withDir((dir) => {
      const sm = new StateManager({ schemaVersion: 2 });
      const sp = path.join(dir, 'state.json');
      const state = makeState(override);
      delete state.schema_version;
      fs.writeFileSync(sp, JSON.stringify(state, null, 2));

      try {
        sm.read(sp);
        assert.fail(`should have thrown for ${marker}`);
      } catch (err) {
        assert.ok(err instanceof StateError);
        assert.equal(err.code, 'SCHEMA_MISMATCH');
        assert.match(err.message, /schema v3 fields/);
        assert.match(err.message, new RegExp(String(marker)));
        assert.match(err.message, /supports schema_version 2/);
      }

      const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
      assert.equal(onDisk.schema_version, undefined, `${marker} read must not stamp schema_version`);
    });
  }
});

test('StateManager.read: migrates past schema version to current schema', () => {
  withDir((dir) => {
    const sm = new StateManager({ schemaVersion: 3 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ schema_version: 2 }));
    const result = sm.read(sp);
    assert.equal(result.schema_version, 3);
    assertV3Defaults(result);
    assert.equal(result.prd_path, undefined);
    assert.equal(result.start_commit, undefined);
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.schema_version, 3);
    assertV3Defaults(onDisk);
    assert.equal('prd_path' in onDisk, false);
    assert.equal('start_commit' in onDisk, false);
  });
});

test('StateManager.read: preserves existing v3 values while hydrating missing defaults', () => {
  withDir((dir) => {
    const sm = new StateManager({ schemaVersion: 3 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      schema_version: 2,
      tickets_version: 7,
      phase_personas_active: true,
      flags: { strict_teams: true, custom: 'yes' },
      readiness: { cycle_history: [{ cycle: 1, status: 'pass', suggested_analyst: null, user_action: null, timestamp: '2026-04-30T00:00:00Z' }] },
      codex_version_seen: '0.42.0',
    }));

    const result = sm.read(sp);

    assert.equal(result.schema_version, 3);
    assert.equal(result.tickets_version, 7);
    assert.equal(result.phase_personas_active, true);
    assert.deepEqual(result.flags, { strict_teams: true, custom: 'yes' });
    assert.equal(result.readiness.cycle_history.length, 1);
    assert.equal(result.codex_version_seen, '0.42.0');
    assert.equal(result.archaeology, null);
    assert.equal(result.last_course_correction, null);
  });
});

test('StateManager.read: state pipeline_continue_on_phase_fail default hydrates to true when omitted', () => {
  withDir((dir) => {
    const sm = new StateManager({ schemaVersion: 3 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ schema_version: 3 }));

    const result = sm.read(sp);
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));

    assert.equal(result.pipeline_continue_on_phase_fail, true);
    assert.equal(onDisk.pipeline_continue_on_phase_fail, true);
  });
});

test('StateManager.read: logs to stderr on undefined schema_version migration', () => {
  withDir((dir) => {
    const messages = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (msg) => { messages.push(String(msg)); return true; };
    try {
      const sm = new StateManager();
      const sp = path.join(dir, 'state.json');
      const state = makeState();
      delete state.schema_version;
      fs.writeFileSync(sp, JSON.stringify(state, null, 2));
      sm.read(sp);
      assert.ok(
        messages.some((m) => m.includes('migrating to 1')),
        `expected migration log, got: ${JSON.stringify(messages)}`,
      );
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

test('StateManager.read: failed migration write is non-fatal but leaves a stderr breadcrumb', (t) => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    const state = makeState();
    delete state.schema_version;
    fs.writeFileSync(sp, JSON.stringify(state, null, 2));
    fs.chmodSync(dir, 0o555);
    const messages = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    try {
      // Self-check: chmod does not bind uid 0, so the write-failure arm would be vacuous there.
      const probe = path.join(dir, 'probe');
      try { fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe); t.skip('directory still writable (root?)'); return; } catch { /* unwritable, as intended */ }
      process.stderr.write = (msg) => { messages.push(String(msg)); return true; };
      const result = new StateManager().read(sp);
      process.stderr.write = origWrite;
      assert.equal(typeof result.schema_version, 'number');
      assert.ok(
        messages.some((m) => m.includes('migration write failed') && m.includes(sp)),
        `expected migration-write-failure breadcrumb, got: ${JSON.stringify(messages)}`,
      );
    } finally {
      process.stderr.write = origWrite;
      fs.chmodSync(dir, 0o755);
    }
  });
});

// ---------------------------------------------------------------------------
// read — recovery: orphan tmp files
// ---------------------------------------------------------------------------

test('StateManager.read: cleans up orphan tmp file with dead PID', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 5 }));
    // Create orphan tmp file with a dead PID (99999999)
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify({ iteration: 3 }));
    sm.read(sp);
    assert.equal(fs.existsSync(tmpFile), false, 'orphan tmp should be deleted');
  });
});

test('StateManager.read: promotes orphan tmp file with higher iteration', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 5 }));
    // Create orphan tmp with higher iteration
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({ iteration: 10 })));
    const result = sm.read(sp);
    assert.equal(result.iteration, 10, 'should promote higher iteration');
    assert.equal(fs.existsSync(tmpFile), false, 'tmp file should be consumed');
  });
});

test('StateManager.read: promotes same-iteration orphan tmp before legacy schema migration touches base mtime', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    const base = makeState({ iteration: 5, active: true, current_ticket: 'T-BASE' });
    delete base.schema_version;
    fs.writeFileSync(sp, JSON.stringify(base, null, 2));

    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({
      iteration: 5,
      active: false,
      current_ticket: 'T-RECOVERED',
      schema_version: 1,
    }), null, 2));
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(tmpFile, future, future);

    const result = sm.read(sp);

    assert.equal(result.iteration, 5);
    assert.equal(result.active, false);
    assert.equal(result.current_ticket, 'T-RECOVERED');
    assert.equal(fs.existsSync(tmpFile), false, 'same-iteration tmp should be consumed');

    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.active, false);
    assert.equal(onDisk.current_ticket, 'T-RECOVERED');
    assert.equal(onDisk.schema_version, LATEST_SCHEMA_VERSION);
  });
});

test('StateManager.read: promotes orphan tmp when base state.json is corrupt', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, '{invalid json!!!');
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({
      iteration: 9,
      current_ticket: 'T-RECOVERED',
      step: 'review',
    })));

    const result = sm.read(sp);

    assert.equal(result.iteration, 9, 'recovered tmp iteration should win when base is corrupt');
    assert.equal(result.current_ticket, 'T-RECOVERED');
    assert.equal(result.step, 'review');
    assert.equal(fs.existsSync(tmpFile), false, 'recovered tmp should be consumed');

    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.iteration, 9, 'promoted tmp should replace the corrupt base file');
    assert.equal(onDisk.current_ticket, 'T-RECOVERED');
  });
});

test('StateManager.read: does not promote future-schema orphan tmp when base state.json is corrupt', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    fs.writeFileSync(sp, '{invalid json!!!');
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(
      tmpFile,
      JSON.stringify(makeState({
        iteration: 9,
        current_ticket: 'T-RECOVERED',
        step: 'review',
        schema_version: LATEST_SCHEMA_VERSION + 1,
        session_dir: dir,
      })),
    );

    try {
      sm.read(sp);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof StateError);
      assert.equal(err.code, 'CORRUPT');
    }

    assert.equal(fs.existsSync(tmpFile), true, 'unsupported tmp should remain for a newer runtime to inspect');
    assert.equal(fs.readFileSync(sp, 'utf-8'), '{invalid json!!!', 'corrupt base should remain untouched when recovery candidate is unsupported');
  });
});

test('StateManager.read: deletes orphan tmp with invalid JSON', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, 'NOT VALID JSON');
    sm.read(sp);
    assert.equal(fs.existsSync(tmpFile), false, 'invalid tmp should be deleted');
  });
});

test('StateManager.read: leaves tmp file from live process alone', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Use current PID — definitely alive
    const tmpFile = `${sp}.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify({ iteration: 99 }));
    sm.read(sp);
    assert.equal(fs.existsSync(tmpFile), true, 'tmp from live process should remain');
    fs.unlinkSync(tmpFile);
  });
});

test('StateManager.read: promotes equal-mtime same-iteration orphan tmp (R-CIFB-B tie-to-candidate)', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 5, active: true, current_ticket: 'T-BASE' }));

    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({
      iteration: 5,
      active: false,
      current_ticket: 'T-RECOVERED',
    }), null, 2));
    // IDENTICAL forced mtime — the Linux coarse-mtime tie the fix must promote.
    const t = new Date(1_700_000_000_000);
    fs.utimesSync(sp, t, t);
    fs.utimesSync(tmpFile, t, t);

    const result = sm.read(sp);

    assert.equal(result.iteration, 5);
    assert.equal(result.current_ticket, 'T-RECOVERED', 'equal-mtime tmp should win the tie');
    assert.equal(fs.existsSync(tmpFile), false, 'promoted tmp should be consumed');

    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.current_ticket, 'T-RECOVERED');
  });
});

test('StateManager.read: does NOT promote equal-mtime tmp from a live writer (shouldSkipLiveTmp preserved)', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 5, current_ticket: 'T-BASE' }));

    // Live PID (this process) — the live-writer guard must skip it even on an mtime tie.
    const tmpFile = `${sp}.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({
      iteration: 5,
      current_ticket: 'T-LIVE',
    }), null, 2));
    // Stamp the tmp at/after process start (now) so shouldSkipLiveTmp treats it as in-flight,
    // and stamp the base at the same instant to force the mtime tie.
    const t = new Date();
    fs.utimesSync(sp, t, t);
    fs.utimesSync(tmpFile, t, t);

    const result = sm.read(sp);

    assert.equal(result.current_ticket, 'T-BASE', 'live-writer tmp must not be promoted on a tie');
    assert.equal(fs.existsSync(tmpFile), true, 'live tmp must remain untouched');
    fs.unlinkSync(tmpFile);
  });
});

// ---------------------------------------------------------------------------
// read — recovery: stale active flag
// ---------------------------------------------------------------------------

test('StateManager.read: clears active flag when pid is dead', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ active: true, pid: 99999999 }));
    const result = sm.read(sp);
    assert.equal(result.active, false, 'active should be cleared for dead PID');
  });
});

test('StateManager.read: failed dead-pid demotion write is non-fatal but leaves a stderr breadcrumb', (t) => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ active: true, pid: 99999999 }));
    fs.chmodSync(dir, 0o555);
    const messages = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    try {
      // Self-check: chmod does not bind uid 0, so the write-failure arm would be vacuous there.
      const probe = path.join(dir, 'probe');
      try { fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe); t.skip('directory still writable (root?)'); return; } catch { /* unwritable, as intended */ }
      process.stderr.write = (msg) => { messages.push(String(msg)); return true; };
      const result = new StateManager().read(sp);
      process.stderr.write = origWrite;
      assert.equal(result.active, false);
      assert.ok(
        messages.some((m) => m.includes('demotion write failed') && m.includes(sp)),
        `expected demotion-write-failure breadcrumb, got: ${JSON.stringify(messages)}`,
      );
    } finally {
      process.stderr.write = origWrite;
      fs.chmodSync(dir, 0o755);
    }
  });
});

test('inspectLockFile: an unreadable lock is null WITH a breadcrumb; an absent lock is null silently', () => {
  withDir((dir) => {
    const messages = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // A directory at the lock path fails the read with EISDIR regardless of uid.
    const unreadable = path.join(dir, 'held.lock');
    fs.mkdirSync(unreadable);
    const absent = path.join(dir, 'absent.lock');
    try {
      process.stderr.write = (msg) => { messages.push(String(msg)); return true; };
      assert.equal(inspectLockFile(absent), null);
      assert.equal(messages.length, 0, `ENOENT must stay silent, got: ${JSON.stringify(messages)}`);
      assert.equal(inspectLockFile(unreadable), null);
    } finally {
      process.stderr.write = origWrite;
    }
    assert.ok(
      messages.some((m) => m.includes('lock inspect failed') && m.includes(unreadable)),
      `expected lock-inspect-failure breadcrumb, got: ${JSON.stringify(messages)}`,
    );
  });
});

test('StateManager.read: preserves active flag when no pid set', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ active: true }));
    const result = sm.read(sp);
    assert.equal(result.active, true, 'active should be preserved when no pid');
  });
});

test('StateManager.read: preserves active flag for live pid', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ active: true, pid: process.pid }));
    const result = sm.read(sp);
    assert.equal(result.active, true, 'active should be preserved for live PID');
  });
});

// ---------------------------------------------------------------------------
// update — basic mutation with lock
// ---------------------------------------------------------------------------

test('StateManager.update: applies mutator and persists', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 1 }));
    const result = sm.update(sp, (s) => { s.iteration = 42; });
    assert.equal(result.iteration, 42);
    // Persisted
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.iteration, 42);
  });
});

test('StateManager.update: no lock file left after success', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    sm.update(sp, (s) => { s.step = 'research'; });
    assert.equal(fs.existsSync(`${sp}.lock`), false, 'lock should be released');
  });
});

test('StateManager.update: releases lock even when mutator throws', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    try {
      sm.update(sp, () => { throw new Error('mutator boom'); });
    } catch { /* expected */ }
    assert.equal(fs.existsSync(`${sp}.lock`), false, 'lock should be released on error');
  });
});

// ---------------------------------------------------------------------------
// forceWrite — best effort, no lock
// ---------------------------------------------------------------------------

test('StateManager.forceWrite: writes state without lock', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    sm.forceWrite(sp, makeState({ iteration: 99 }));
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.iteration, 99);
  });
});

test('StateManager.forceWrite: succeeds even when lock file exists', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Create a lock file
    fs.writeFileSync(`${sp}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    sm.forceWrite(sp, makeState({ iteration: 77 }));
    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.iteration, 77);
    // Cleanup
    try { fs.unlinkSync(`${sp}.lock`); } catch { /* ok */ }
  });
});

test('StateManager.forceWrite: never throws even on bad path', () => {
  const sm = new StateManager();
  // This should not throw
  sm.forceWrite('/nonexistent/path/state.json', makeState());
});

test('StateManager.forceWrite: emits stderr breadcrumb on write failure', () => {
  const sm = new StateManager();
  const originalWrite = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    return originalWrite(chunk, ...rest);
  };
  try {
    sm.forceWrite('/nonexistent/path/state.json', makeState());
  } finally {
    process.stderr.write = originalWrite;
  }
  const joined = captured.join('');
  assert.ok(
    joined.includes('[state-manager] forceWrite failed'),
    `expected forceWrite failure breadcrumb in stderr, got: ${joined}`,
  );
  assert.ok(
    joined.includes('/nonexistent/path/state.json'),
    `expected target path in stderr breadcrumb, got: ${joined}`,
  );
});

// ---------------------------------------------------------------------------
// transaction — success
// ---------------------------------------------------------------------------

test('StateManager.transaction: mutates multiple files atomically', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp1 = path.join(dir, 'state1.json');
    const sp2 = path.join(dir, 'state2.json');
    writeStateFile(sp1, makeState({ iteration: 1 }));
    writeStateFile(sp2, makeState({ iteration: 2 }));

    const results = sm.transaction([sp1, sp2], (states) => {
      states[0].iteration = 10;
      states[1].iteration = 20;
    });

    assert.equal(results[0].iteration, 10);
    assert.equal(results[1].iteration, 20);

    // Persisted
    const d1 = JSON.parse(fs.readFileSync(sp1, 'utf-8'));
    const d2 = JSON.parse(fs.readFileSync(sp2, 'utf-8'));
    assert.equal(d1.iteration, 10);
    assert.equal(d2.iteration, 20);
  });
});

test('StateManager.transaction: no lock files left after success', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp1 = path.join(dir, 'state1.json');
    const sp2 = path.join(dir, 'state2.json');
    writeStateFile(sp1, makeState());
    writeStateFile(sp2, makeState());

    sm.transaction([sp1, sp2], () => { /* no-op */ });

    assert.equal(fs.existsSync(`${sp1}.lock`), false);
    assert.equal(fs.existsSync(`${sp2}.lock`), false);
  });
});

// ---------------------------------------------------------------------------
// transaction — rollback
// ---------------------------------------------------------------------------

test('StateManager.transaction: rolls back on write failure', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp1 = path.join(dir, 'state1.json');
    const sp2 = path.join(dir, 'state2.json');
    writeStateFile(sp1, makeState({ iteration: 1 }));
    writeStateFile(sp2, makeState({ iteration: 2 }));

    // Make sp2 unwritable after backup is taken
    // We'll do this by having the mutator set a circular reference on states[1]
    // which will cause JSON.stringify to fail during write
    try {
      sm.transaction([sp1, sp2], (states) => {
        states[0].iteration = 100;
        // Create a circular reference to break JSON.stringify
        const circ = {};
        circ.self = circ;
        Object.assign(states[1], { bad: circ });
      });
      assert.fail('should have thrown TransactionError');
    } catch (err) {
      assert.ok(err instanceof TransactionError, `expected TransactionError, got ${err.constructor.name}`);
    }

    // sp1 should be rolled back to original value
    const d1 = JSON.parse(fs.readFileSync(sp1, 'utf-8'));
    assert.equal(d1.iteration, 1, 'sp1 should be rolled back');

    // sp2 should still have original value
    const d2 = JSON.parse(fs.readFileSync(sp2, 'utf-8'));
    assert.equal(d2.iteration, 2, 'sp2 should be unchanged');
  });
});

test('StateManager.transaction: releases locks on failure', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp1 = path.join(dir, 'state1.json');
    writeStateFile(sp1, makeState());

    try {
      sm.transaction([sp1], (states) => {
        const circ = {};
        circ.self = circ;
        Object.assign(states[0], { bad: circ });
      });
    } catch { /* expected */ }

    assert.equal(fs.existsSync(`${sp1}.lock`), false, 'lock should be released');
  });
});

test('StateManager.transaction: refuses write when on-disk schema advances after read', () => {
  withDir((dir) => {
    const sm = new StateManager({ schemaVersion: 3 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ schema_version: 3, iteration: 1 }));

    assert.throws(
      () => sm.transaction([sp], (states) => {
        states[0].iteration = 2;
        fs.writeFileSync(sp, JSON.stringify(makeState({ schema_version: 4, iteration: 99 }), null, 2));
      }),
      (err) => {
        assert.ok(err instanceof SchemaVersionMismatchError);
        assert.equal(err.code, 'SCHEMA_MISMATCH');
        assert.equal(err.onDiskVersion, 4);
        assert.equal(err.cachedVersion, 3);
        return true;
      },
    );

    const onDisk = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(onDisk.schema_version, 4);
    assert.equal(onDisk.iteration, 99);
  });
});

// ---------------------------------------------------------------------------
// Lock — stale lock stealing
// ---------------------------------------------------------------------------

test('StateManager.update: steals stale lock from dead process', () => {
  withDir((dir) => {
    const sm = new StateManager({ staleLockTimeoutMs: 100 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Create stale lock from dead PID
    fs.writeFileSync(`${sp}.lock`, JSON.stringify({ pid: 99999999, ts: Date.now() - 200 }));
    // Should succeed by stealing the stale lock
    const result = sm.update(sp, (s) => { s.iteration = 7; });
    assert.equal(result.iteration, 7);
  });
});

test('StateManager.update: steals lock with corrupt JSON', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    fs.writeFileSync(`${sp}.lock`, 'NOT JSON AT ALL');
    const result = sm.update(sp, (s) => { s.iteration = 8; });
    assert.equal(result.iteration, 8);
  });
});

// ---------------------------------------------------------------------------
// Lock — failure after max retries
// ---------------------------------------------------------------------------

test('StateManager.update: throws LockError after max retries', () => {
  withDir((dir) => {
    const sm = new StateManager({ maxLockRetries: 1, baseLockDelayMs: 10, staleLockTimeoutMs: 999_999 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Create lock held by current process (alive, not stale)
    fs.writeFileSync(`${sp}.lock`, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    try {
      sm.update(sp, () => {});
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof LockError, `expected LockError, got ${err.constructor.name}`);
      assert.ok(err.code === 'LOCK_FAILED');
    } finally {
      fs.unlinkSync(`${sp}.lock`);
    }
  });
});

// ---------------------------------------------------------------------------
// Error class hierarchy
// ---------------------------------------------------------------------------

test('StateError: has correct name and code', () => {
  const err = new StateError('CORRUPT', 'bad data');
  assert.equal(err.name, 'StateError');
  assert.equal(err.code, 'CORRUPT');
  assert.equal(err.message, 'bad data');
  assert.ok(err instanceof Error);
});

test('LockError: inherits from StateError with LOCK_FAILED code', () => {
  const err = new LockError('lock test');
  assert.equal(err.name, 'LockError');
  assert.equal(err.code, 'LOCK_FAILED');
  assert.ok(err instanceof StateError);
  assert.ok(err instanceof Error);
});

test('TransactionError: carries rollback errors', () => {
  const rbErr = new Error('rollback failed');
  const err = new TransactionError('tx failed', [rbErr]);
  assert.equal(err.name, 'TransactionError');
  assert.equal(err.code, 'WRITE_FAILED');
  assert.equal(err.rollbackErrors.length, 1);
  assert.equal(err.rollbackErrors[0].message, 'rollback failed');
  assert.ok(err instanceof StateError);
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test('STATE_MANAGER_DEFAULTS: has expected values', () => {
  assert.equal(STATE_MANAGER_DEFAULTS.maxLockRetries, 10);
  assert.equal(STATE_MANAGER_DEFAULTS.baseLockDelayMs, 100);
  assert.equal(STATE_MANAGER_DEFAULTS.lockJitter, true);
  assert.equal(STATE_MANAGER_DEFAULTS.staleLockTimeoutMs, 30_000);
  assert.equal(STATE_MANAGER_DEFAULTS.schemaVersion, LATEST_SCHEMA_VERSION);
});

// ---------------------------------------------------------------------------
// Constructor: custom options override defaults
// ---------------------------------------------------------------------------

test('StateManager: custom options override defaults', () => {
  withDir((dir) => {
    const sm = new StateManager({ maxLockRetries: 3, baseLockDelayMs: 50 });
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    // Should work with custom options
    const result = sm.read(sp);
    assert.equal(result.schema_version, LATEST_SCHEMA_VERSION);
  });
});

// ---------------------------------------------------------------------------
// transaction: returns states in original path order
// ---------------------------------------------------------------------------

test('StateManager.transaction: returns states in caller path order (not sorted)', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const spZ = path.join(dir, 'z-state.json');
    const spA = path.join(dir, 'a-state.json');
    writeStateFile(spZ, makeState({ iteration: 100 }));
    writeStateFile(spA, makeState({ iteration: 200 }));

    // Pass in Z before A — results should match that order
    const results = sm.transaction([spZ, spA], () => { /* no-op */ });
    assert.equal(results[0].iteration, 100, 'first result should be Z');
    assert.equal(results[1].iteration, 200, 'second result should be A');
  });
});

// ---------------------------------------------------------------------------
// forceWriteMutate fallback path (via exported helpers)
// ---------------------------------------------------------------------------

test('writeActivityEntry: appends entry via locked update path', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState());
    writeActivityEntry(sp, { ts: '2026-04-23T00:00:00Z', event: 'halt', detail: 'one' });
    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.activity.length, 1);
    assert.equal(read.activity[0].detail, 'one');
  });
});

test('writeActivityEntry: swallows silently when file missing and no fallback', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    // No file, no lock — update throws StateError, read throws ENOENT, no fallback factory → no write
    assert.doesNotThrow(() => writeActivityEntry(sp, { ts: 't', event: 'halt', detail: 'd' }));
    assert.equal(fs.existsSync(sp), false, 'no file should be created');
  });
});

test('state-manager.read-unknown-event: preserves future activity event and warns without throwing', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      schema_version: STATE_MANAGER_DEFAULTS.schemaVersion,
      activity: [{ ts: '2026-05-02T00:00:00Z', event: 'future_event', detail: 'from newer runtime' }],
    }));

    const { writes } = captureStderr(() => {
      let read;
      assert.doesNotThrow(() => { read = sm.read(sp); });
      assert.equal(read.activity.length, 1);
      assert.equal(read.activity[0].event, 'future_event');
    });

    assert.match(writes.join(''), /WARN: ignoring unknown activity event future_event/);
  });
});

test('state-manager.write-rejects-unknown: throws InvalidActivityEventError for future activity event', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ schema_version: STATE_MANAGER_DEFAULTS.schemaVersion }));

    assert.throws(
      () => writeActivityEntry(sp, { ts: '2026-05-02T00:00:00Z', event: 'future_event', detail: 'reject me' }),
      InvalidActivityEventError,
    );

    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.activity, undefined);
  });
});

test('state-manager.read-pre-bundle-state: returns existing known activity without warning', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      schema_version: STATE_MANAGER_DEFAULTS.schemaVersion,
      activity: [{ ts: '2026-04-23T00:00:00Z', event: 'halt', detail: 'old bundle event' }],
    }));

    const { writes } = captureStderr(() => {
      const read = sm.read(sp);
      assert.equal(read.activity.length, 1);
      assert.equal(read.activity[0].event, 'halt');
    });

    assert.doesNotMatch(writes.join(''), /unknown activity event/);
  });
});

test('state-manager.whitelist-not-cached: re-imported types mutation affects later writes', async () => {
  const types = await import('../types/index.js');
  const liveEvent = 'future_event_live_reload';
  assert.equal(VALID_ACTIVITY_EVENTS.includes(liveEvent), false);
  assert.equal(types.VALID_ACTIVITY_EVENTS.includes(liveEvent), false);

  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ schema_version: STATE_MANAGER_DEFAULTS.schemaVersion }));

    assert.throws(
      () => writeActivityEntry(sp, { ts: '2026-05-02T00:00:00Z', event: liveEvent }),
      InvalidActivityEventError,
    );

    types.VALID_ACTIVITY_EVENTS.push(liveEvent);
    try {
      assert.doesNotThrow(() => writeActivityEntry(sp, { ts: '2026-05-02T00:00:01Z', event: liveEvent }));
      const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
      assert.equal(read.activity.length, 1);
      assert.equal(read.activity[0].event, liveEvent);
    } finally {
      const idx = types.VALID_ACTIVITY_EVENTS.indexOf(liveEvent);
      if (idx !== -1) types.VALID_ACTIVITY_EVENTS.splice(idx, 1);
    }
  });
});

test('safeDeactivate: falls back to {active:false} seed when file unreadable', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    // No file exists — update throws, read fails → fallbackFactory seeds minimal state
    safeDeactivate(sp);
    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.active, false);
  });
});

test('safeDeactivate: fallback preserves crash-recovered tmp state before deactivating', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 1, current_ticket: 'T-BASE' }));
    const tmpFile = `${sp}.tmp.99999999`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({
      iteration: 2,
      current_ticket: 'T-RECOVERED',
      command_template: 'council-of-ricks.md',
    })));

    const originalUpdate = StateManager.prototype.update;
    StateManager.prototype.update = () => {
      throw new LockError('forced fallback');
    };

    try {
      safeDeactivate(sp);
    } finally {
      StateManager.prototype.update = originalUpdate;
    }

    const recovered = new StateManager().read(sp);
    assert.equal(recovered.iteration, 2, 'fallback must preserve the promoted iteration');
    assert.equal(recovered.current_ticket, 'T-RECOVERED');
    assert.equal(recovered.command_template, 'council-of-ricks.md');
    assert.equal(recovered.active, false);
    assert.equal(fs.existsSync(tmpFile), false, 'recovered tmp should be consumed');
  });
});

// ---------------------------------------------------------------------------
// finalizeTerminalState — clean-success exit finalize
// ---------------------------------------------------------------------------

test('finalizeTerminalState: deactivates, sets step=completed, nulls current_ticket, reconciles iteration, stamps exit_reason', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      active: true,
      step: 'research',
      iteration: 4,
      current_ticket: 'T-99',
    }));
    finalizeTerminalState(sp, { step: 'completed', runnerIteration: 7, exitReason: 'success' });
    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.active, false);
    assert.equal(read.step, 'completed');
    assert.equal(read.current_ticket, null);
    assert.equal(read.iteration, 7);
    assert.equal(read.exit_reason, 'success');
  });
});

test('finalizeTerminalState: never throws on missing state.json (seeds fallback)', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    assert.doesNotThrow(() => finalizeTerminalState(sp, { step: 'completed', exitReason: 'limit' }));
    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.active, false);
    assert.equal(read.step, 'completed');
    assert.equal(read.current_ticket, null);
  });
});

test('finalizeTerminalState: preserves crash-recovered tmp state before finalizing', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 1, current_ticket: 'T-BASE' }));
    const tmpFile = `${sp}.tmp.99999998`;
    fs.writeFileSync(tmpFile, JSON.stringify(makeState({
      iteration: 2,
      current_ticket: 'T-RECOVERED',
      command_template: 'pickle.md',
    })));

    const originalUpdate = StateManager.prototype.update;
    StateManager.prototype.update = () => {
      throw new LockError('forced fallback');
    };

    try {
      finalizeTerminalState(sp, { step: 'completed', runnerIteration: 5, exitReason: 'success' });
    } finally {
      StateManager.prototype.update = originalUpdate;
    }

    const recovered = new StateManager().read(sp);
    assert.equal(recovered.command_template, 'pickle.md', 'fallback must preserve recovered fields');
    assert.equal(recovered.active, false);
    assert.equal(recovered.step, 'completed');
    assert.equal(recovered.current_ticket, null);
    assert.equal(recovered.iteration, 5);
    assert.equal(recovered.exit_reason, 'success');
    assert.equal(fs.existsSync(tmpFile), false, 'recovered tmp should be consumed');
  });
});

test('finalizeTerminalState: ignores non-finite runnerIteration', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({ iteration: 3 }));
    finalizeTerminalState(sp, { step: 'completed', runnerIteration: NaN, exitReason: 'limit' });
    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.iteration, 3, 'NaN runnerIteration must not corrupt iteration');
  });
});

test('R-CNAR-8: finalizeTerminalState clears all 5 current_ticket cache fields', () => {
  // Forensic: bundle session 2026-05-04-f416c6cc run #6 attempt 1 — finalize
  // from a prior clean-success exit left the cache populated; --resume of the
  // same session tripped iteration_cap_exhausted on iteration 1 because the
  // per-ticket cap-check saw stale current_ticket_max_iterations.
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      active: true,
      step: 'implement',
      iteration: 9,
      current_ticket: 'T-99',
      current_ticket_tier: 'medium',
      current_ticket_budget: 30,
      current_ticket_max_iterations: 30,
      current_ticket_worker_timeout_seconds: 1200,
      current_ticket_budget_start_iteration: 5,
    }));

    finalizeTerminalState(sp, { step: 'completed', exitReason: 'success' });

    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.current_ticket, null);
    assert.equal(read.current_ticket_tier, undefined);
    assert.equal(read.current_ticket_budget, undefined);
    assert.equal(read.current_ticket_max_iterations, undefined);
    assert.equal(read.current_ticket_worker_timeout_seconds, undefined);
    assert.equal(read.current_ticket_budget_start_iteration, undefined);
  });
});

test('R-CNAR-8: clearExitReason with resetCurrentTicket clears all 5 cache fields', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      active: false,
      exit_reason: 'iteration_cap_exhausted',
      current_ticket: 'T-50',
      current_ticket_tier: 'large',
      current_ticket_budget: 60,
      current_ticket_max_iterations: 60,
      current_ticket_worker_timeout_seconds: 4800,
      current_ticket_budget_start_iteration: 12,
    }));

    clearExitReason(sp, { resetCurrentTicket: true });

    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.current_ticket, null);
    assert.equal(read.exit_reason, null);
    assert.equal(read.current_ticket_tier, undefined);
    assert.equal(read.current_ticket_budget, undefined);
    assert.equal(read.current_ticket_max_iterations, undefined);
    assert.equal(read.current_ticket_worker_timeout_seconds, undefined);
    assert.equal(read.current_ticket_budget_start_iteration, undefined);
  });
});

test('R-CNAR-8: clearExitReason without resetCurrentTicket preserves cache fields', () => {
  // Negative case — clearing exit_reason alone (e.g., reactivation path) must
  // NOT touch the per-ticket cache. The cache is current_ticket-scoped; if the
  // ticket isn't being reset, the cache stays.
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      exit_reason: 'circuit_open',
      current_ticket: 'T-50',
      current_ticket_tier: 'medium',
      current_ticket_max_iterations: 30,
    }));

    clearExitReason(sp, {});

    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.exit_reason, null);
    assert.equal(read.current_ticket, 'T-50');
    assert.equal(read.current_ticket_tier, 'medium');
    assert.equal(read.current_ticket_max_iterations, 30);
  });
});

// ---------------------------------------------------------------------------
// recordExitReason — forensic stamp without disturbing other fields
// ---------------------------------------------------------------------------

test('recordExitReason: writes exit_reason without changing step/current_ticket/iteration', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      active: true,
      step: 'research',
      iteration: 4,
      current_ticket: 'T-99',
    }));
    recordExitReason(sp, 'circuit_open');
    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    // Only exit_reason changed — caller is responsible for safeDeactivate
    assert.equal(read.step, 'research');
    assert.equal(read.iteration, 4);
    assert.equal(read.current_ticket, 'T-99');
    assert.equal(read.exit_reason, 'circuit_open');
    // Note: active not touched by recordExitReason — caller pairs with safeDeactivate
    assert.equal(read.active, true);
  });
});

test('recordExitReason: never throws on missing state.json (no-op when no fallback factory)', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    assert.doesNotThrow(() => recordExitReason(sp, 'fatal'));
    // No file should be created (recordExitReason has no fallback factory).
    assert.equal(fs.existsSync(sp), false);
  });
});

test('clearExitReason: clears only exit_reason by default', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      active: true,
      step: 'implement',
      iteration: 4,
      current_ticket: 'T-99',
      exit_reason: 'signal',
      command_template: 'pickle.md',
    }));

    clearExitReason(sp);

    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.exit_reason, null);
    assert.equal(read.step, 'implement');
    assert.equal(read.current_ticket, 'T-99');
    assert.equal(read.iteration, 4);
    assert.equal(read.active, true);
    assert.equal(read.command_template, 'pickle.md');
  });
});

test('clearExitReason: optionally resets step and current_ticket while preserving unrelated fields', () => {
  withDir((dir) => {
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      active: true,
      step: 'review',
      iteration: 8,
      current_ticket: 'T-100',
      exit_reason: 'circuit_open',
      command_template: 'pickle-pipeline.md',
      backend: 'codex',
    }));

    clearExitReason(sp, { resetStep: true, resetCurrentTicket: true });

    const read = JSON.parse(fs.readFileSync(sp, 'utf-8'));
    assert.equal(read.exit_reason, null);
    assert.equal(read.step, null);
    assert.equal(read.current_ticket, null);
    assert.equal(read.iteration, 8);
    assert.equal(read.active, true);
    assert.equal(read.command_template, 'pickle-pipeline.md');
    assert.equal(read.backend, 'codex');
  });
});

// ---------------------------------------------------------------------------
// assertSchemaVersionDeployParity — fail-fast deploy drift guard
// ---------------------------------------------------------------------------

test('assertSchemaVersionDeployParity: returns normally when versions match', () => {
  // The shipped state-manager and types/index agree by construction; calling
  // the function in the current process must be a no-op (no throw, no exit).
  assert.equal(STATE_MANAGER_DEFAULTS.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.doesNotThrow(() => assertSchemaVersionDeployParity());
});

test('SchemaVersionDeployDriftError: message contains no absolute or home-relative path', () => {
  const err = new SchemaVersionDeployDriftError(2, 3);
  // Must not ship any user-specific absolute path or home-dir shorthand.
  assert.doesNotMatch(err.message, /\/Users\//, 'message must not contain /Users/');
  assert.doesNotMatch(err.message, /~\//, 'message must not contain ~/');
  assert.doesNotMatch(err.message, /\$HOME/, 'message must not contain $HOME');
  // The portable guidance must still be present.
  assert.match(err.message, /bash install\.sh/);
});

test('assertSchemaVersionDeployParity: exits 1 with actionable stderr on drift', () => {
  // Spawn a subprocess that imports state-manager.js with monkey-patched
  // STATE_MANAGER_DEFAULTS so we can simulate stale-deploy drift without
  // mutating the real module for the rest of the suite.
  const __filename = fileURLToPath(import.meta.url);
  const testsDir = path.dirname(__filename);
  const stateManagerUrl = new URL('../services/state-manager.js', import.meta.url).href;
  const typesUrl = new URL('../types/index.js', import.meta.url).href;

  const driver = `
    import { STATE_MANAGER_DEFAULTS } from ${JSON.stringify(typesUrl)};
    // Simulate stale-deploy drift: deployed defaults stuck at 3 while a newer
    // LATEST_SCHEMA_VERSION (4) is what the parity check expects.
    STATE_MANAGER_DEFAULTS.schemaVersion = 3;
    const sm = await import(${JSON.stringify(stateManagerUrl)});
    // Override the bound LATEST_SCHEMA_VERSION the function compares against
    // by re-defining the module's view via a local replacement check. Since
    // the function reads LATEST_SCHEMA_VERSION via closure on its imported
    // binding, we instead force the inverse: bump defaults above the latest.
    STATE_MANAGER_DEFAULTS.schemaVersion = 999;
    sm.assertSchemaVersionDeployParity();
    // Should never reach here.
    process.exit(0);
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
    cwd: testsDir,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  assert.equal(result.status, 1, `expected exit 1, got ${result.status}; stderr=${result.stderr}`);
  assert.match(result.stderr, /stale deploy/);
  assert.match(result.stderr, /bash install\.sh/);
});

// ---------------------------------------------------------------------------
// R-MDS-6: monitor_panes schema migration
// ---------------------------------------------------------------------------

test('R-MDS-6 schema migration: monitor_panes initialized to 4 false entries when absent', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    // Old state.json without monitor_panes field
    writeStateFile(sp, makeState({ schema_version: 3 }));

    const state = sm.read(sp);
    assert.ok(Array.isArray(state.monitor_panes), 'monitor_panes should be an array');
    assert.equal(state.monitor_panes.length, 4, 'monitor_panes should have 4 entries');
    for (let i = 0; i < 4; i++) {
      assert.equal(state.monitor_panes[i].producer_done, false, `entry ${i} should default to false`);
    }
  });
});

test('R-MDS-6 schema migration: monitor_panes preserved when already set correctly', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    writeStateFile(sp, makeState({
      schema_version: 3,
      monitor_panes: [
        { producer_done: false },
        { producer_done: false },
        { producer_done: true },
        { producer_done: false },
      ],
    }));

    const state = sm.read(sp);
    assert.equal(state.monitor_panes[2].producer_done, true, 'existing true value should be preserved');
    assert.equal(state.monitor_panes[0].producer_done, false);
    assert.equal(state.monitor_panes[3].producer_done, false);
  });
});

test('R-MDS-6 crash recovery: missing monitor_panes field defaults to false (safe)', () => {
  withDir((dir) => {
    const sm = new StateManager();
    const sp = path.join(dir, 'state.json');
    // Simulate crash recovery: raw state without monitor_panes
    fs.writeFileSync(sp, JSON.stringify(makeState({ schema_version: 3 }), null, 2));

    const state = sm.read(sp);
    // All entries must default to false — no false-suppression of warnings
    assert.ok(Array.isArray(state.monitor_panes));
    assert.equal(state.monitor_panes.every((e) => e.producer_done === false), true,
      'crash-recovery default must be false for all panes');
  });
});
