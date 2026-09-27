// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager } from '../../services/state-manager.js';

const sm = new StateManager();
const STALE_AGE_MS = 400_000; // 400s > 300s threshold
const FRESH_AGE_MS = 60_000;  // 60s < 300s threshold
const DEAD_PID = 99999999;    // too large to ever be a real PID

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Creates:  <dataRoot>/current_sessions.json (optional)
//           <dataRoot>/sessions/session-1/state.json
// Layout matches what readSessionsMapForState expects:
//   sessionDir  = dirname(statePath)
//   sessionsDir = dirname(sessionDir)
//   dataRoot    = dirname(sessionsDir)
//   mapPath     = dataRoot/current_sessions.json
function makeTestSession() {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-orphan-'));
  const sessionDir = path.join(dataRoot, 'sessions', 'session-1');
  fs.mkdirSync(sessionDir, { recursive: true });
  const stateFile = path.join(sessionDir, 'state.json');
  return { dataRoot, sessionDir, stateFile };
}

function writeSessionsMap(dataRoot, sessionDir, pid) {
  fs.writeFileSync(
    path.join(dataRoot, 'current_sessions.json'),
    JSON.stringify({ [process.cwd()]: { sessionPath: sessionDir, pid } }),
  );
}

function baseState(overrides = {}) {
  return {
    active: true,
    pid: null,
    working_dir: process.cwd(),
    step: 'prd',
    iteration: 1, // >0 so phantom-demotion (iteration===0 && history===[]) doesn't fire here
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test',
    ...overrides,
  };
}

function writeStaleMtime(stateFile) {
  const staleTime = new Date(Date.now() - STALE_AGE_MS);
  fs.utimesSync(stateFile, staleTime, staleTime);
}

function writeFreshMtime(stateFile) {
  const freshTime = new Date(Date.now() - FRESH_AGE_MS);
  fs.utimesSync(stateFile, freshTime, freshTime);
}

// ---------------------------------------------------------------------------
// Case 1: (null, true, stale) + dead mapped PID → demoted
// ---------------------------------------------------------------------------

test('paused-orphan: (null,true,stale) demotes active to false with orphan-paused-no-claim', () => {
  const { dataRoot, sessionDir, stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ active: true, pid: null })));
    writeSessionsMap(dataRoot, sessionDir, DEAD_PID);
    writeStaleMtime(stateFile);

    const state = sm.read(stateFile);

    assert.equal(state.active, false, 'active must be false after demotion');
    assert.equal(state.exit_reason, 'orphan-paused-no-claim');
    assert.ok(Array.isArray(state.activity), 'activity must be an array');
    const demoted = state.activity.filter(a => a.kind === 'paused_session_orphan_demoted');
    assert.equal(demoted.length, 1, 'exactly one demotion event');
    assert.equal(demoted[0].event, 'paused_session_orphan_demoted');
    assert.equal(demoted[0].pid_orig, null);
    assert.ok(typeof demoted[0].mtime_age_seconds === 'number' && demoted[0].mtime_age_seconds >= 400);
    assert.ok(typeof demoted[0].ts === 'string');

    // Persisted to disk
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(persisted.active, false, 'disk must reflect active=false');
  } finally {
    fs.rmSync(dataRoot, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Case 2: (null, true, fresh) → no-op
// ---------------------------------------------------------------------------

test('paused-orphan: (null,true,fresh) leaves active untouched', () => {
  const { dataRoot, sessionDir, stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ active: true, pid: null })));
    writeFreshMtime(stateFile);

    const state = sm.read(stateFile);

    assert.equal(state.active, true, 'fresh mtime must not trigger demotion');
    assert.ok(
      !Array.isArray(state.activity) ||
        state.activity.every(a => a.kind !== 'paused_session_orphan_demoted'),
      'no demotion event for fresh state',
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Case 3: (null, false, stale) → no-op
// ---------------------------------------------------------------------------

test('paused-orphan: (null,false,stale) does not re-demote already-inactive session', () => {
  const { dataRoot, sessionDir, stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ active: false, pid: null })));
    // Stale + dead mapped PID is the full Cell D demote condition, so only the
    // active!==true guard can keep this case quiet — without the map it is vacuous.
    writeSessionsMap(dataRoot, sessionDir, DEAD_PID);
    writeStaleMtime(stateFile);

    const state = sm.read(stateFile);

    assert.equal(state.active, false);
    assert.equal(state.exit_reason, undefined, 'already-inactive session must keep its exit_reason');
    assert.ok(
      !Array.isArray(state.activity) ||
        state.activity.every(a => a.kind !== 'paused_session_orphan_demoted'),
      'no demotion event when already inactive',
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Case 4: idempotent — run twice, only one event emitted
// ---------------------------------------------------------------------------

test('paused-orphan: idempotent — pre-existing demotion event suppresses re-emit', () => {
  const { dataRoot, sessionDir, stateFile } = makeTestSession();
  try {
    const existingEvent = {
      event: 'paused_session_orphan_demoted',
      kind: 'paused_session_orphan_demoted',
      pid_orig: null,
      mtime_age_seconds: 500,
      ts: new Date(Date.now() - 500_000).toISOString(),
    };
    fs.writeFileSync(stateFile, JSON.stringify(baseState({
      active: true,
      pid: null,
      activity: [existingEvent],
    })));
    writeSessionsMap(dataRoot, sessionDir, DEAD_PID);
    writeStaleMtime(stateFile);

    const state = sm.read(stateFile);

    const demotions = (state.activity ?? []).filter(a => a.kind === 'paused_session_orphan_demoted');
    assert.equal(demotions.length, 1, 'must not double-emit the demotion event');
  } finally {
    fs.rmSync(dataRoot, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Case 5: boundary — mtime === now - 300s (exactly threshold) demotes
// ---------------------------------------------------------------------------

test('paused-orphan: (null,true,boundary) at exactly 300s mtime fires demotion (inclusive boundary)', () => {
  const { dataRoot, sessionDir, stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(baseState({ active: true, pid: null })));
    writeSessionsMap(dataRoot, sessionDir, DEAD_PID);
    const boundaryTime = new Date(Date.now() - 300_000);
    fs.utimesSync(stateFile, boundaryTime, boundaryTime);

    const state = sm.read(stateFile);

    assert.equal(state.active, false, 'boundary mtime (300s) must demote');
    assert.equal(state.exit_reason, 'orphan-paused-no-claim');
    const demoted = (state.activity ?? []).filter(a => a.kind === 'paused_session_orphan_demoted');
    assert.equal(demoted.length, 1, 'exactly one demotion at boundary');
    assert.ok(
      typeof demoted[0].mtime_age_seconds === 'number' && demoted[0].mtime_age_seconds >= 300,
      'mtime_age_seconds must be >= 300 at boundary',
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// R-POD-2: 2×2 matrix — (age fresh|stale) × (mapped pid alive|dead)
// ---------------------------------------------------------------------------

// Cell A: fresh + live → keep (demotion requires BOTH age-stale AND dead-pid)
test('Cell A: fresh state + live mapped PID returns keep', () => {
  const { dataRoot, sessionDir, stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(baseState()));
    writeSessionsMap(dataRoot, sessionDir, process.pid); // current process is alive
    writeFreshMtime(stateFile);

    const state = sm.read(stateFile);

    assert.equal(state.active, true, 'Cell A: fresh + live must not demote');
    assert.ok(
      !Array.isArray(state.activity) ||
        state.activity.every(a => a.kind !== 'paused_session_orphan_demoted'),
      'Cell A: no demotion event',
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true });
  }
});

// Cell B: fresh + dead → keep (the regression case — fresh age alone must prevent demotion)
test('Cell B: fresh state + dead mapped PID returns keep', () => {
  const { dataRoot, sessionDir, stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(baseState()));
    writeSessionsMap(dataRoot, sessionDir, DEAD_PID);
    writeFreshMtime(stateFile);

    const state = sm.read(stateFile);

    assert.equal(state.active, true, 'Cell B: fresh state must NOT demote even with dead mapped PID');
    assert.ok(
      !Array.isArray(state.activity) ||
        state.activity.every(a => a.kind !== 'paused_session_orphan_demoted'),
      'Cell B: no demotion event for fresh state',
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true });
  }
});

// Cell C: stale + live → keep (live owner, demotion must not fire)
test('Cell C: stale state + live mapped PID returns keep', () => {
  const { dataRoot, sessionDir, stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(baseState()));
    writeSessionsMap(dataRoot, sessionDir, process.pid); // current process is alive
    writeStaleMtime(stateFile);

    const state = sm.read(stateFile);

    assert.equal(state.active, true, 'Cell C: live owner must not be demoted even when stale');
    assert.ok(
      !Array.isArray(state.activity) ||
        state.activity.every(a => a.kind !== 'paused_session_orphan_demoted'),
      'Cell C: no demotion event when owner is alive',
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true });
  }
});

// Cell D: stale + dead → demote (true orphan — both conditions met)
test('Cell D: stale state + dead mapped PID returns demote', () => {
  const { dataRoot, sessionDir, stateFile } = makeTestSession();
  try {
    fs.writeFileSync(stateFile, JSON.stringify(baseState()));
    writeSessionsMap(dataRoot, sessionDir, DEAD_PID);
    writeStaleMtime(stateFile);

    const state = sm.read(stateFile);

    assert.equal(state.active, false, 'Cell D: stale + dead mapped PID must demote');
    assert.equal(state.exit_reason, 'orphan-paused-no-claim');
    const demoted = (state.activity ?? []).filter(a => a.kind === 'paused_session_orphan_demoted');
    assert.equal(demoted.length, 1, 'Cell D: exactly one demotion event');
    assert.ok(typeof demoted[0].mtime_age_seconds === 'number' && demoted[0].mtime_age_seconds >= 400);
    assert.equal(demoted[0].mapped_pid, DEAD_PID);
  } finally {
    fs.rmSync(dataRoot, { recursive: true });
  }
});
