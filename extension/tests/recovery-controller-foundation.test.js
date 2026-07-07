// @tier: fast
//
// R-ORSR-1: Recovery type/schema foundation + terminal disposition table.
// INV-RECOVERY-EXHAUSTED-IS-FAILURE: recovery_exhausted is a failure exit (stops
//   auto-resume.sh R-CNAR-4(c)) and NOT a halt exit.
// Back-compat: v5 state without recovery_attempts normalizes to [] via
//   normalizeV5StateDefaults; LATEST_SCHEMA_VERSION stays at 5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

test('INV-RECOVERY-EXHAUSTED-IS-FAILURE: isFailureExit(recovery_exhausted) === true', async () => {
  const { isFailureExit } = await import('../bin/mux-runner.js');
  assert.equal(isFailureExit('recovery_exhausted'), true,
    'recovery_exhausted must be a failure exit (stops auto-resume.sh)');
});

test('INV-RECOVERY-EXHAUSTED-IS-FAILURE: isHaltExit(recovery_exhausted) === false', async () => {
  const { isHaltExit } = await import('../bin/mux-runner.js');
  assert.equal(isHaltExit('recovery_exhausted'), false,
    'recovery_exhausted must NOT be a halt exit (it is fatal, not deferrable)');
});

test('R-ORSR-1 back-compat: v5 state without recovery_attempts normalizes to []', async () => {
  const { StateManager } = await import('../services/state-manager.js');
  const { LATEST_SCHEMA_VERSION } = await import('../types/index.js');
  const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'orsr1-bc-'));
  try {
    assert.equal(LATEST_SCHEMA_VERSION, 5, 'LATEST_SCHEMA_VERSION must stay at 5 (no schema bump for R-ORSR-1)');

    const raw = {
      schema_version: 5,
      active: false,
      working_dir: tmpD,
      step: 'research',
      iteration: 0,
      max_iterations: 15,
      max_time_minutes: 0,
      worker_timeout_seconds: 3600,
      start_time_epoch: Date.now(),
      original_prompt: 'test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: tmpD,
      tmux_mode: false,
      backend: 'claude',
      flags: {},
      activity: [],
      // Deliberately absent: recovery_attempts
    };
    const sp = path.join(tmpD, 'state.json');
    fs.writeFileSync(sp, JSON.stringify(raw, null, 2));

    const sm = new StateManager();
    const state = sm.read(sp);
    assert.ok(Array.isArray(state.recovery_attempts),
      'recovery_attempts must be an array after read (schema-neutral v5 default)');
    assert.deepEqual(state.recovery_attempts, [],
      'recovery_attempts must default to [] when absent from state.json');
    assert.equal(LATEST_SCHEMA_VERSION, 5,
      'LATEST_SCHEMA_VERSION must remain 5 after reading a state with recovery_attempts defaulted');
  } finally {
    fs.rmSync(tmpD, { recursive: true, force: true });
  }
});

test('R-ORSR-1 back-compat: existing recovery_attempts entries are preserved', async () => {
  const { StateManager } = await import('../services/state-manager.js');
  const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'orsr1-pres-'));
  try {
    const existing = [
      { strategy: 'reset_no_progress_counter', outcome: 'failed', reason: 'counter reset but no progress', iteration: 3 },
    ];
    const raw = {
      schema_version: 5,
      active: false,
      working_dir: tmpD,
      step: 'research',
      iteration: 0,
      max_iterations: 15,
      max_time_minutes: 0,
      worker_timeout_seconds: 3600,
      start_time_epoch: Date.now(),
      original_prompt: 'test',
      current_ticket: null,
      history: [],
      started_at: new Date().toISOString(),
      session_dir: tmpD,
      tmux_mode: false,
      backend: 'claude',
      flags: {},
      activity: [],
      recovery_attempts: existing,
    };
    const sp = path.join(tmpD, 'state.json');
    fs.writeFileSync(sp, JSON.stringify(raw, null, 2));

    const sm = new StateManager();
    const state = sm.read(sp);
    assert.deepEqual(state.recovery_attempts, existing,
      'populated recovery_attempts must survive migration untouched');
  } finally {
    fs.rmSync(tmpD, { recursive: true, force: true });
  }
});

// R-RRPC-1/3: breaker-grace + bounded-escape caps consolidated into the single
// resolveHardeningSettings resolver (services/pickle-utils.ts) — one resolver,
// one compiled default per field (30 / 3).

test('R-RRPC-1: resolveHardeningSettings resolves breaker_recovery_grace_seconds (default + override)', async () => {
  const { resolveHardeningSettings } = await import('../services/pickle-utils.js');
  assert.equal(resolveHardeningSettings(null).breaker_recovery_grace_seconds, 30,
    'absent bag → compiled default 30');
  assert.equal(resolveHardeningSettings({}).breaker_recovery_grace_seconds, 30,
    'absent hardening block → compiled default 30');
  assert.equal(
    resolveHardeningSettings({ hardening: { breaker_recovery_grace_seconds: 45 } }).breaker_recovery_grace_seconds,
    45,
    'configured value honored',
  );
});

test('R-RRPC-3: resolveHardeningSettings resolves bounded_terminal_escape_cap (default + override)', async () => {
  const { resolveHardeningSettings } = await import('../services/pickle-utils.js');
  assert.equal(resolveHardeningSettings(null).bounded_terminal_escape_cap, 3,
    'absent bag → compiled default 3');
  assert.equal(resolveHardeningSettings({}).bounded_terminal_escape_cap, 3,
    'absent hardening block → compiled default 3');
  assert.equal(
    resolveHardeningSettings({ hardening: { bounded_terminal_escape_cap: 2 } }).bounded_terminal_escape_cap,
    2,
    'configured value honored',
  );
});

test('R-RRPC-3d: a resolved bounded_terminal_escape_cap=2 fires the decision one relaunch earlier AND the log reads "across 2"', async () => {
  const { evaluateBoundedEscape, executeBoundedEscape, BOUNDED_ESCAPE_STRATEGY } = await import('../bin/mux-runner.js');
  const { StateManager } = await import('../services/state-manager.js');

  const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), 'orsr1-rrpc3d-'));
  try {
    const ticketId = 't1';
    const ticketDir = path.join(tmpD, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, `linear_ticket_${ticketId}.md`),
      ['---', `id: ${ticketId}`, 'title: R-RRPC-3d fixture', 'status: In Progress', 'order: 1', '---', '', '# Test'].join('\n'),
    );

    const recoveryAttempts = Array.from({ length: 2 }, (_, i) => ({
      strategy: BOUNDED_ESCAPE_STRATEGY,
      outcome: 'failed',
      reason: 'no_progress_relaunch',
      iteration: i,
      ticket: ticketId,
    }));
    const state = {
      active: true,
      working_dir: '/nonexistent-non-repo',
      step: 'implement',
      iteration: 5,
      max_iterations: 60,
      max_time_minutes: 0,
      worker_timeout_seconds: 99,
      start_time_epoch: 1,
      completion_promise: null,
      original_prompt: 'R-RRPC-3d test',
      current_ticket: ticketId,
      history: [],
      started_at: new Date(0).toISOString(),
      session_dir: '',
      recovery_attempts: recoveryAttempts,
    };
    const statePath = path.join(tmpD, 'state.json');
    const sm = new StateManager();
    sm.forceWrite(statePath, state);

    // Resolved cap=2: fires one relaunch earlier than the compiled default (3) would.
    const resolvedCap = 2;
    const evalDefault = evaluateBoundedEscape(state, tmpD, 3);
    assert.equal(evalDefault.escape, false, 'at the compiled default cap (3), 2 prior attempts do NOT yet escape');

    const evalResolved = evaluateBoundedEscape(state, tmpD, resolvedCap);
    assert.equal(evalResolved.escape, true, 'at the resolved cap (2), 2 prior attempts DO escape — fires one relaunch earlier');

    const logLines = [];
    executeBoundedEscape(statePath, tmpD, state.working_dir, ticketId, 9, resolvedCap, (msg) => logLines.push(msg));
    const escapeLog = logLines.find(l => l.startsWith('bounded escape:'));
    assert.ok(escapeLog, 'executeBoundedEscape must log a bounded-escape message');
    assert.ok(escapeLog.includes('across 2'), `log must read "across 2" (resolved cap), not the const 3: ${escapeLog}`);
    assert.ok(!escapeLog.includes('across 3'), `log must NOT read "across 3" (stale const): ${escapeLog}`);
  } finally {
    fs.rmSync(tmpD, { recursive: true, force: true });
  }
});
