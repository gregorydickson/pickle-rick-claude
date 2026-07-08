// @tier: integration
/**
 * worker-silent-death.test.js — real-SIGKILL silent-death recovery (ticket 90574654).
 *
 * A real worker child opens its own `worker_session_<pid>.log` in the ticket dir, produces one of the
 * two silent-death log shapes, signals readiness, then hangs holding nothing. The parent SIGKILLs it and
 * drives the SHIPPED post-mortem analyzers against the on-disk residue:
 *
 *   - log_truncated (nonzero log, NO terminal `<promise>I AM DONE</promise>`) → `checkPartialLifecycleExit`
 *     emits the EXISTING `worker_partial_lifecycle_exit`; the 90574654 policy engages
 *     (salvage check → bounded respawn → halt at cap=1 with `recovery_exhausted`).
 *   - log_empty (0-byte log) → the NEW `worker_silent_death` event + the SAME policy.
 *   - mutual exclusion: exactly ONE of the two events fires per exit, never both.
 *
 * Determinism: the kill is gated on a readiness token, never on a timer; the worker PID-named log uses the
 * child's own `process.pid`. Tests only — escalate bugs, do NOT fix recovery behavior here.
 *
 * Flake protocol: this file is serialized (`subprocess-timeout-coupling`) and runs at
 * `--test-concurrency=1` via tests/integration/.serial-tests.json. A failure observed only under a
 * c=8 parallel run is a load artifact — re-run at `--test-concurrency=4`, which is AUTHORITATIVE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { checkPartialLifecycleExit, applySilentDeathRecoveryPolicy, isFailureExit } from '../../../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_PATH = path.resolve(__dirname, '../../../bin/mux-runner.js');
const TICKET = 'chaos623c';
// Cap pinned in-test so the respawn→halt boundary is independent of the deployed pickle_settings.json.
const RESPAWN_CAP = 1;

function makeSession() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-chaos-sd-')));
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      active: true,
      schema_version: 5,
      working_dir: tmp,
      step: 'implement',
      iteration: 3,
      max_iterations: 50,
      worker_timeout_seconds: 600,
      start_time_epoch: Math.floor(Date.now() / 1000),
      original_prompt: 'chaos silent-death',
      session_dir: sessionDir,
      started_at: new Date().toISOString(),
      history: [],
      tmux_mode: false,
      backend: 'claude',
      activity: [],
      recovery_attempts: [],
      worker_artifact_progress: {},
    }),
  );
  const ticketDir = path.join(sessionDir, TICKET);
  fs.mkdirSync(ticketDir, { recursive: true });
  // Medium-tier partial-lifecycle precondition: research APPROVED, downstream artifacts absent.
  fs.writeFileSync(path.join(ticketDir, 'research_2026-06-11.md'), 'research body');
  fs.writeFileSync(path.join(ticketDir, 'research_review.md'), '# review\n\nAPPROVED');
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${TICKET}.md`),
    `---\nid: ${TICKET}\nstatus: "In Progress"\ncomplexity_tier: medium\n---\n# T\n`,
  );
  return { tmp, sessionDir, statePath, ticketDir };
}

// Child worker: writes its own `worker_session_<pid>.log` in the ticket dir, signals readiness, then hangs.
// mode 'truncated' → nonzero bytes with NO terminal promise token; mode 'empty' → a 0-byte log.
const WORKER_CHILD = `
  const fs = await import('node:fs');
  const path = await import('node:path');
  const ticketDir = process.argv[1];
  const mode = process.argv[2];
  const logPath = path.join(ticketDir, 'worker_session_' + process.pid + '.log');
  if (mode === 'truncated') {
    fs.writeFileSync(logPath, 'partial research output, killed mid-flight — no promise token\\n');
  } else {
    fs.writeFileSync(logPath, '');
  }
  process.stdout.write('LOG_WRITTEN\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`;

function spawnWorkerChild(ticketDir, mode) {
  // timeout >= 30000: hang-guard only — the child is SIGKILLed well before this fires.
  return spawn(process.execPath, ['--input-type=module', '-e', WORKER_CHILD, ticketDir, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function waitForToken(child, token) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onErr);
    };
    const onData = (d) => { buf += d.toString(); if (buf.includes(token)) { cleanup(); resolve(); } };
    const onExit = (code) => { cleanup(); reject(new Error(`child exited (code ${code}) before token "${token}"`)); };
    const onErr = (err) => { cleanup(); reject(err); };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onErr);
  });
}

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
}

function eventsOf(statePath, name) {
  const s = readState(statePath);
  return (Array.isArray(s.activity) ? s.activity : []).filter((e) => e.event === name);
}

function policyInput(fix, classification) {
  return {
    sessionDir: fix.sessionDir,
    statePath: fix.statePath,
    ticketId: TICKET,
    workingDir: readState(fix.statePath).working_dir,
    iteration: 3,
    classification,
    // Future window + no preIterSha + no completion sha → NO salvage evidence → respawn path.
    iterationStartMs: Date.now() + 1000,
    settings: { silent_death_respawn_cap: RESPAWN_CAP },
    log: () => {},
  };
}

/** Drive the shared 90574654 policy with no salvage evidence: bounded respawns then halt at cap. */
function drivePolicyToCap(fix, cls) {
  const first = applySilentDeathRecoveryPolicy(policyInput(fix, cls));
  assert.equal(first.action, 'respawn', 'first evidence-absent decision must respawn');
  assert.equal(first.attempt, 1, 'first respawn is attempt 1');
  assert.equal(first.cap, RESPAWN_CAP);
  const second = applySilentDeathRecoveryPolicy(policyInput(fix, cls));
  assert.equal(second.action, 'halt', 'cap exhausted → halt');
  assert.equal(second.exitReason, 'recovery_exhausted');
  assert.equal(isFailureExit(second.exitReason), true, 'recovery_exhausted is a failure-class exit');
  // Cap is shared + persisted: exactly RESPAWN_CAP success entries drawn from state.recovery_attempts.
  const successes = readState(fix.statePath).recovery_attempts.filter(
    (a) => a.strategy === 'silent_death_respawn' && a.outcome === 'success',
  );
  assert.equal(successes.length, RESPAWN_CAP, 'bounded respawn drew down exactly the cap');
}

test('log_truncated SIGKILL → worker_partial_lifecycle_exit + bounded-respawn/halt policy; never worker_silent_death', { timeout: 60_000 }, async () => {
  const fix = makeSession();
  let child;
  try {
    child = spawnWorkerChild(fix.ticketDir, 'truncated');
    await waitForToken(child, 'LOG_WRITTEN');

    const logs = fs.readdirSync(fix.ticketDir).filter((f) => /^worker_session_\d+\.log$/.test(f));
    assert.equal(logs.length, 1, 'child wrote exactly one PID-named session log');
    assert.ok(fs.statSync(path.join(fix.ticketDir, logs[0])).size > 0, 'truncated shape is a nonzero log');

    child.kill('SIGKILL');
    await once(child, 'exit');
    child = null;

    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    assert.ok(cls, 'a partial-lifecycle exit must be classified');
    assert.equal(cls.subClass, 'log_truncated');

    const legacy = eventsOf(fix.statePath, 'worker_partial_lifecycle_exit');
    assert.equal(legacy.length, 1, 'exactly one worker_partial_lifecycle_exit');
    assert.equal(eventsOf(fix.statePath, 'worker_silent_death').length, 0, 'mutual exclusion: never worker_silent_death');
    assert.ok(Array.isArray(legacy[0].gate_payload.artifacts_missing));
    assert.ok(legacy[0].gate_payload.session_log_size > 0);

    drivePolicyToCap(fix, cls);
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
    fs.rmSync(fix.tmp, { recursive: true, force: true });
  }
});

test('log_empty SIGKILL → worker_silent_death + same policy; never worker_partial_lifecycle_exit', { timeout: 60_000 }, async () => {
  const fix = makeSession();
  let child;
  try {
    child = spawnWorkerChild(fix.ticketDir, 'empty');
    await waitForToken(child, 'LOG_WRITTEN');

    const logs = fs.readdirSync(fix.ticketDir).filter((f) => /^worker_session_\d+\.log$/.test(f));
    assert.equal(logs.length, 1, 'child wrote exactly one PID-named session log');
    assert.equal(fs.statSync(path.join(fix.ticketDir, logs[0])).size, 0, 'empty shape is a 0-byte log');

    child.kill('SIGKILL');
    await once(child, 'exit');
    child = null;

    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    assert.ok(cls, 'a partial-lifecycle exit must be classified');
    assert.equal(cls.subClass, 'log_empty');

    const silent = eventsOf(fix.statePath, 'worker_silent_death');
    assert.equal(silent.length, 1, 'exactly one worker_silent_death');
    assert.equal(eventsOf(fix.statePath, 'worker_partial_lifecycle_exit').length, 0, 'mutual exclusion: never worker_partial_lifecycle_exit');
    assert.equal(silent[0].sub_class, 'log_empty');
    assert.equal(silent[0].ticket, TICKET);

    drivePolicyToCap(fix, cls);
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
    fs.rmSync(fix.tmp, { recursive: true, force: true });
  }
});

test('mutual exclusion holds for one SIGKILL exit: exactly one silent-death event per exit', { timeout: 60_000 }, async () => {
  for (const mode of ['truncated', 'empty']) {
    const fix = makeSession();
    let child;
    try {
      child = spawnWorkerChild(fix.ticketDir, mode);
      await waitForToken(child, 'LOG_WRITTEN');
      child.kill('SIGKILL');
      await once(child, 'exit');
      child = null;

      checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
      const total = eventsOf(fix.statePath, 'worker_silent_death').length
        + eventsOf(fix.statePath, 'worker_partial_lifecycle_exit').length;
      assert.equal(total, 1, `exactly one silent-death event for a single ${mode} exit`);
    } finally {
      if (child) { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
      fs.rmSync(fix.tmp, { recursive: true, force: true });
    }
  }
});

// Reference MUX_PATH so a path typo surfaces as an explicit failure, not a silent skip.
test('fixture: compiled mux-runner module resolves', { timeout: 60_000 }, () => {
  assert.ok(fs.existsSync(fileURLToPath(pathToFileURL(MUX_PATH))), `mux-runner.js must exist at ${MUX_PATH}`);
});
