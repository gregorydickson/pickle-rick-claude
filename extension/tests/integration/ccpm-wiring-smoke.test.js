// @tier: expensive
/**
 * R-CCPM-WH-1: End-to-end wiring smoke test for R-CCPM-1..5.
 *
 * Exercises the 5 R-CCPM trap-door behaviors together as a system:
 *  (a) R-CCPM-1 — Role Framing + scrub: checkIterationLogForCodexSelfBootstrap
 *      is detection-only (returns events array, does not spawn subprocess).
 *      Claude backend short-circuits to []; codex stream-json triggers detection.
 *  (b) R-CCPM-2 — a codex manager iteration whose output invokes setup.js emits
 *      codex_manager_self_bootstrap_attempted through runIteration's own emitter
 *      (fake `codex` on PATH); a claude iteration with the same output emits none.
 *  (c) R-CCPM-4 — Colliding session-map write with alive PID is rejected
 *      (spawns real setup.js subprocess).
 *  (d) R-CCPM-3 — Parent's orphans_detected surfaces a spawned-orphan within
 *      one iteration; subsequent iterations dedup (no double-emit).
 *  (e) R-CCPM-5 — The 3 new activity events are registered in
 *      VALID_ACTIVITY_EVENTS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { checkIterationLogForCodexSelfBootstrap, detectOrphanSessions, runIteration } from '../../bin/mux-runner.js';
import { _setRetryDelayMs } from '../../services/activity-logger.js';
import { StateManager } from '../../services/state-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SETUP_JS = path.join(ROOT, 'bin/setup.js');
const TYPES_INDEX_JS = path.join(ROOT, 'types/index.js');

function readActivityEvents(dataRoot, eventName) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  return fs.readdirSync(activityDir)
    .flatMap((f) =>
      fs.readFileSync(path.join(activityDir, f), 'utf-8')
        .trim().split('\n').filter(Boolean)
        .map((l) => JSON.parse(l)),
    )
    .filter((e) => e.event === eventName);
}

function makeMinimalState(sessionDir, workingDir, overrides = {}) {
  return {
    active: true,
    working_dir: workingDir,
    step: 'pickle',
    iteration: 1,
    max_iterations: 50,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'ccpm wiring smoke test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: false,
    min_iterations: 0,
    command_template: null,
    chain_meeseeks: false,
    schema_version: 4,
    backend: 'claude',
    worker_backend: null,
    pipeline_continue_on_phase_fail: true,
    teams_mode: false,
    max_parallel: undefined,
    archaeology: null,
    tickets_version: 0,
    last_course_correction: null,
    phase_personas_active: false,
    flags: {},
    readiness: { cycle_history: [] },
    codex_version_seen: null,
    orphans_detected: [],
    invocation_source: 'operator',
    parent_session_hash: null,
    ...overrides,
  };
}

// ── (a) R-CCPM-1 detection-only ──────────────────────────────────────────────

test('ccpm-wh1: (a) R-CCPM-1 — detection scrubs claude, codex detects', () => {
  // Synthetic stream-json log carrying a Bash tool_use that invokes setup.js.
  const setupCmd = `node ${SETUP_JS} --task 'spawned by codex manager'`;
  const streamJsonLog = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: setupCmd } }] },
  });

  // Claude backend returns [] immediately — no detection, no subprocess spawn.
  const claudeResults = checkIterationLogForCodexSelfBootstrap(streamJsonLog, 'claude', 'T1', 1);
  assert.equal(claudeResults.length, 0, 'claude backend must return [] (scrubbed)');

  // Codex backend on the same log surfaces the setup.js invocation.
  const codexResults = checkIterationLogForCodexSelfBootstrap(streamJsonLog, 'codex', 'T1', 1);
  assert.equal(codexResults.length, 1, 'codex backend must detect 1 setup.js call');
  assert.ok(Array.isArray(codexResults[0].attempted_argv), 'attempted_argv must be an array');
  assert.equal(codexResults[0].ticket, 'T1');
  assert.equal(codexResults[0].iteration, 1);
});

// ── (b) R-CCPM-2 production emitter via runIteration ─────────────────────────

// Fake manager binary: prints one stream-json line whose Bash tool_use invokes
// setup.js, then exits 0. Installed as both `codex` and `claude`.
const FAKE_MANAGER_SOURCE = `#!/usr/bin/env node
process.stdout.write(process.env.CCPM_FAKE_LINE + '\\n');
process.exit(0);
`;

async function runManagerIteration(backend) {
  const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ccpm-wh1-b-${backend}-`)));
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ccpm-wh1-b-data-${backend}-`)));
  fs.mkdirSync(path.join(sessionDir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'templates', '_pickle-manager-prompt.md'), '# Pickle\n\n$ARGUMENTS\n');
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(makeMinimalState(sessionDir, sessionDir, {
    pid: process.pid,
    backend,
    current_ticket: 'T1',
  })));
  const fakeBin = path.join(sessionDir, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const name of ['codex', 'claude']) {
    fs.writeFileSync(path.join(fakeBin, name), FAKE_MANAGER_SOURCE);
    fs.chmodSync(path.join(fakeBin, name), 0o755);
  }
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `node ${SETUP_JS} --task 'spawned by manager'` } }] },
  });

  const prevDataRoot = process.env.PICKLE_DATA_ROOT;
  const prevParentHash = process.env.PICKLE_PARENT_SESSION_HASH;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  _setRetryDelayMs(0);
  try {
    const outcome = await runIteration(sessionDir, 1, sessionDir, '', {
      envOverrides: {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
        PICKLE_BACKEND: backend,
        PICKLE_DATA_ROOT: dataRoot,
        CCPM_FAKE_LINE: line,
      },
      maxIterationSeconds: 30,
      outputStallSeconds: 30,
    });
    const log = fs.readFileSync(path.join(sessionDir, 'tmux_iteration_1.log'), 'utf-8');
    return { outcome, log, events: readActivityEvents(dataRoot, 'codex_manager_self_bootstrap_attempted') };
  } finally {
    if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    if (prevParentHash === undefined) delete process.env.PICKLE_PARENT_SESSION_HASH;
    else process.env.PICKLE_PARENT_SESSION_HASH = prevParentHash;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

test('ccpm-wh1: (b) R-CCPM-2 — codex iteration invoking setup.js emits codex_manager_self_bootstrap_attempted', async () => {
  const { outcome, log, events } = await runManagerIteration('codex');
  assert.equal(outcome.timedOut, false, 'fake codex exit must be observed, not timed out');
  assert.ok(log.includes('setup.js'), `fake codex must have run and written its line; log=${JSON.stringify(log)}`);
  assert.equal(events.length, 1, 'exactly one codex_manager_self_bootstrap_attempted event from the production emitter');
  assert.equal(events[0].action_taken, 'logged', 'action_taken must be "logged" (detection-only)');
  assert.equal(events[0].ticket, 'T1');
  assert.equal(events[0].iteration, 1);
  assert.equal(events[0].source, 'pickle');
  assert.ok(events[0].attempted_argv.some((a) => a.endsWith('setup.js')), 'attempted_argv carries the setup.js path');
  assert.equal(typeof events[0].ts, 'string');
});

test('ccpm-wh1: (b) R-CCPM-2 control — claude iteration with the same output emits no bootstrap event', async () => {
  const { log, events } = await runManagerIteration('claude');
  assert.ok(log.includes('setup.js'), 'control must have run the fake manager too');
  assert.equal(events.length, 0, 'claude backend must not emit codex_manager_self_bootstrap_attempted');
});

// ── (c) R-CCPM-4 alive-PID collision blocks setup.js ─────────────────────────

test('ccpm-wh1: (c) R-CCPM-4 — alive-PID collision blocks setup.js + emits session_map_collision_blocked', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpm-wh1-c-'));
  const sessionsDir = path.join(dataRoot, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  try {
    const cwd = process.cwd();
    const parentSessionPath = path.join(sessionsDir, 'parent-session');

    // Map cwd → parent-session with the current test process PID (alive).
    fs.writeFileSync(
      path.join(dataRoot, 'current_sessions.json'),
      JSON.stringify({ [cwd]: { sessionPath: parentSessionPath, pid: process.pid } }),
    );

    const result = spawnSync(process.execPath, [SETUP_JS, '--tmux', '--task', 'orphan attempt'], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
      encoding: 'utf-8',
      timeout: 30_000,
    });

    assert.notEqual(
      result.status, 0,
      `orphan setup.js must exit non-zero on alive-PID collision; got ${result.status}\nstderr: ${result.stderr}`,
    );

    const events = readActivityEvents(dataRoot, 'session_map_collision_blocked');
    assert.equal(events.length, 1, `expected 1 collision event, got ${events.length}`);
    assert.equal(events[0].cwd, cwd);
    assert.equal(events[0].existing_session_path, parentSessionPath);
    assert.equal(events[0].existing_pid, process.pid);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ── (d) R-CCPM-3 detectOrphanSessions + dedup ────────────────────────────────

test('ccpm-wh1: (d) R-CCPM-3 — detectOrphanSessions surfaces 1 orphan; sm.update yields dedup on next call', () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccpm-wh1-d-'));

  try {
    const parentSessionDir = path.join(dataRoot, 'sessions', 'parent-session');
    fs.mkdirSync(parentSessionDir, { recursive: true });
    const parentStatePath = path.join(parentSessionDir, 'state.json');
    fs.writeFileSync(parentStatePath, JSON.stringify(makeMinimalState(parentSessionDir, '/proj/myapp', {
      pid: process.pid,
    })));

    const orphanSessionDir = path.join(dataRoot, 'sessions', 'orphan-session');
    fs.mkdirSync(orphanSessionDir, { recursive: true });
    fs.writeFileSync(path.join(orphanSessionDir, 'state.json'), JSON.stringify(makeMinimalState(orphanSessionDir, '/proj/myapp', {
      parent_session_hash: 'cafef00d',
      invocation_source: 'manager_subprocess',
      pid: 99999,
    })));

    const sm = new StateManager();
    const parentState = sm.read(parentStatePath);

    // First call surfaces the orphan.
    const first = detectOrphanSessions(parentState, dataRoot, parentSessionDir);
    assert.equal(first.length, 1, 'exactly one orphan detected on first call');
    assert.equal(first[0].orphan_session_path, orphanSessionDir);
    assert.equal(first[0].parent_session_hash, 'cafef00d');

    // Simulate mux-runner appending the orphan's basename into parent's
    // orphans_detected ledger (dedup key is the session directory basename,
    // not the absolute path — see mux-runner.js:detectOrphanSessions:52).
    const orphanBasename = path.basename(orphanSessionDir);
    const updated = sm.update(parentStatePath, (s) => {
      s.orphans_detected = [orphanBasename];
      return s;
    });
    assert.deepEqual(updated.orphans_detected, [orphanBasename]);

    // Second call must dedup: same orphan is already in the ledger.
    const second = detectOrphanSessions(updated, dataRoot, parentSessionDir);
    assert.equal(second.length, 0, 'dedup — same orphan must not re-surface');
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ── (e) R-CCPM-5 all 3 events registered in VALID_ACTIVITY_EVENTS ────────────

test('ccpm-wh1: (e) R-CCPM-5 — 3 new activity events present in VALID_ACTIVITY_EVENTS', () => {
  const source = fs.readFileSync(TYPES_INDEX_JS, 'utf-8');
  const expected = [
    'codex_manager_self_bootstrap_attempted',
    'orphan_session_detected',
    'session_map_collision_blocked',
  ];
  for (const evt of expected) {
    assert.ok(
      source.includes(`'${evt}'`) || source.includes(`"${evt}"`),
      `types/index.js must register VALID_ACTIVITY_EVENTS entry for ${evt}`,
    );
  }
});
