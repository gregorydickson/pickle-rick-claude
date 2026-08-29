// @tier: integration
//
// R-WSWA-2 (R-WMW-2) AC-WSWA-02: per-ticket artifact-progress tracking must
// (a) persist across a simulated manager relaunch (R-MMTR boundary), and
// (b) emit worker_artifact_progress_zero at EXACTLY K=3 consecutive zero-delta
// spawns. Throwaway temp fixtures only — never the live orchestration state.json.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeV5RawState(dir) {
  return {
    active: true,
    working_dir: dir,
    step: 'implement',
    iteration: 1,
    max_iterations: 10,
    max_time_minutes: 0,
    worker_timeout_seconds: 3600,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    schema_version: 5,
    worker_artifact_progress: {},
  };
}

function setupSession(prefix) {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify(makeV5RawState(sessionDir), null, 2));
  return { sessionDir, statePath };
}

function readProgress(statePath, ticketId) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return s.worker_artifact_progress?.[ticketId] ?? null;
}

function countEmissions(statePath) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return (s.activity ?? []).filter((e) => e.event === 'worker_artifact_progress_zero');
}

test('R-WSWA-2 helpers: resolveWmwObserveK + countWorkerArtifacts', async () => {
  const { resolveWmwObserveK, countWorkerArtifacts, WMW_OBSERVE_K_DEFAULT } = await import('../../bin/mux-runner.js');
  assert.equal(resolveWmwObserveK({}), WMW_OBSERVE_K_DEFAULT);
  assert.equal(resolveWmwObserveK({ PICKLE_WMW_OBSERVE_K: '5' }), 5);
  assert.equal(resolveWmwObserveK({ PICKLE_WMW_OBSERVE_K: '0' }), WMW_OBSERVE_K_DEFAULT, 'non-positive falls back');
  assert.equal(resolveWmwObserveK({ PICKLE_WMW_OBSERVE_K: 'x' }), WMW_OBSERVE_K_DEFAULT, 'non-integer falls back');

  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wswa-count-'));
  try {
    assert.equal(countWorkerArtifacts(d), 0);
    fs.writeFileSync(path.join(d, 'code_review_2026-05-30.md'), 'x');
    fs.writeFileSync(path.join(d, 'conformance_2026-05-30.md'), 'x');
    fs.writeFileSync(path.join(d, 'research_2026-05-30.md'), 'x'); // not tracked
    fs.writeFileSync(path.join(d, 'code_review_notes.txt'), 'x');  // not .md
    assert.equal(countWorkerArtifacts(d), 2, 'only code_review_* + conformance_* markdown count');
    assert.equal(countWorkerArtifacts(path.join(d, 'missing')), 0, 'missing dir → 0');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('R-WSWA-2 AC-WSWA-02: counter persists across manager relaunch and fires at exactly K=3', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('wswa-relaunch-');
  const ticketId = 'b2c3d4e5';
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  try {
    // Spawn 1 — no new artifacts (dir empty): zero_progress_count → 1
    let r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0);
    assert.equal(r.zeroProgressCount, 1);
    assert.equal(r.spawnCount, 1);
    assert.equal(r.fired, false);

    // Spawn 2 — still no new artifacts: → 2
    r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0);
    assert.equal(r.zeroProgressCount, 2);
    assert.equal(r.spawnCount, 2);
    assert.equal(r.fired, false);

    // ---- Simulate manager relaunch: drop ALL in-memory state, re-read from disk.
    const persisted = readProgress(statePath, ticketId);
    assert.equal(persisted.zero_progress_count, 2, 'zero_progress_count must survive relaunch on disk');
    assert.equal(persisted.spawn_count, 2, 'spawn_count must survive relaunch on disk');
    assert.equal(countEmissions(statePath).length, 0, 'no emission before K reached');

    // Spawn 3 (post-relaunch) — reaches K=3: fires exactly once.
    r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0);
    assert.equal(r.zeroProgressCount, 3);
    assert.equal(r.spawnCount, 3);
    assert.equal(r.fired, true, 'fires at exactly K=3');

    const emissions = countEmissions(statePath);
    assert.equal(emissions.length, 1, 'exactly one worker_artifact_progress_zero emission at K=3');
    const ev = emissions[0];
    assert.equal(ev.ticket, ticketId);
    assert.equal(ev.gate_payload.observe_k, 3);
    assert.equal(ev.gate_payload.zero_progress_count, 3);
    assert.equal(ev.gate_payload.spawn_count, 3);
    assert.ok(typeof ev.ts === 'string' && ev.ts.length > 0, 'ts explicitly stamped');

    // Spawn 4 — still zero: counter climbs to 4 but does NOT re-emit (=== K only).
    r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0);
    assert.equal(r.zeroProgressCount, 4);
    assert.equal(r.fired, false, 'does not re-fire past K');
    assert.equal(countEmissions(statePath).length, 1, 'still exactly one emission after K+1');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-WSWA-2: forward progress resets zero_progress_count and re-arms the K threshold', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('wswa-reset-');
  const ticketId = 'deadbeef';
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  try {
    recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0); // zpc 1
    let r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0); // zpc 2
    assert.equal(r.zeroProgressCount, 2);

    // Worker produced a new artifact during this spawn: before=0, after=1 → delta>0 → reset.
    fs.writeFileSync(path.join(ticketDir, 'code_review_2026-05-30.md'), 'x');
    r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0);
    assert.equal(r.zeroProgressCount, 0, 'forward progress resets the counter');
    assert.equal(r.spawnCount, 3, 'spawn_count keeps climbing across reset');
    assert.equal(r.lastArtifactCount, 1);
    assert.equal(countEmissions(statePath).length, 0, 'no emission — never reached K consecutively');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-WSWA-2: honors PICKLE_WMW_OBSERVE_K override via opts.k', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('wswa-kovr-');
  const ticketId = 'cafef00d';
  fs.mkdirSync(path.join(sessionDir, ticketId), { recursive: true });
  try {
    let r;
    for (let i = 0; i < 2; i++) r = recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, { k: 2 });
    assert.equal(r.zeroProgressCount, 2);
    assert.equal(r.fired, true, 'fires at K=2 when overridden');
    assert.equal(countEmissions(statePath)[0].gate_payload.observe_k, 2);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// --- R-HNCG: mechanical handoff-notes fallback on a zero-artifact-progress spawn ---

test('R-HNCG AC-TCHN-2A: a zero-progress spawn appends a machine-tagged continuity block', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('hncg-append-');
  const ticketId = 'aabb1122';
  const ticketDir = path.join(sessionDir, ticketId);
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncg-wd-'));
  fs.mkdirSync(ticketDir, { recursive: true });
  const logLines = Array.from({ length: 30 }, (_, i) => `log line ${i}`);
  fs.writeFileSync(path.join(ticketDir, 'worker_session_4242.log'), `${logLines.join('\n')}\n`);
  fs.writeFileSync(path.join(ticketDir, 'plan_2026-08-29.md'), 'plan body');
  try {
    recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, { workingDir });

    const notesPath = path.join(ticketDir, 'handoff_notes.md');
    assert.ok(fs.existsSync(notesPath), 'handoff_notes.md must be created');
    const notes = fs.readFileSync(notesPath, 'utf-8');
    assert.match(notes, /<!-- auto-handoff spawn 4242 -->/, 'marker names the spawn pid');
    assert.match(notes, /Phase reached: plan/, 'phase derived from the newest lifecycle artifact prefix');
    const tail = logLines.slice(-20);
    for (const line of tail) assert.ok(notes.includes(line), `log tail must include "${line}"`);
    assert.ok(!notes.includes(logLines[0]), 'only the LAST 20 lines are included, not the first');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('R-HNCG AC-TCHN-2B: the auto-handoff append is idempotent per spawn pid', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('hncg-idempotent-');
  const ticketId = 'ccdd3344';
  const ticketDir = path.join(sessionDir, ticketId);
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncg-wd-'));
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, 'worker_session_5555.log'), 'one line\n');
  try {
    // Two spawns charged against the SAME on-disk session log (same pid) — the
    // marker must appear exactly once, never duplicated.
    recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, { workingDir });
    recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, { workingDir });

    const notes = fs.readFileSync(path.join(ticketDir, 'handoff_notes.md'), 'utf-8');
    const marker = '<!-- auto-handoff spawn 5555 -->';
    assert.equal(notes.split(marker).length - 1, 1, 'marker appears exactly once despite two charging spawns');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('R-HNCG: the append is append-only — a worker-authored note is preserved verbatim', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('hncg-append-only-');
  const ticketId = 'eeff5566';
  const ticketDir = path.join(sessionDir, ticketId);
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncg-wd-'));
  fs.mkdirSync(ticketDir, { recursive: true });
  const authored = '## 2026-08-29T00:00:00.000Z iteration handoff\nTried: X\nFailed: none\n';
  fs.writeFileSync(path.join(ticketDir, 'handoff_notes.md'), authored);
  fs.writeFileSync(path.join(ticketDir, 'worker_session_7777.log'), 'a log line\n');
  try {
    recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, { workingDir });

    const notes = fs.readFileSync(path.join(ticketDir, 'handoff_notes.md'), 'utf-8');
    assert.ok(notes.startsWith(authored), 'worker-authored content survives verbatim at the head of the file');
    assert.match(notes, /<!-- auto-handoff spawn 7777 -->/, 'auto block appended after the authored note');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('R-HNCG: a spawn that PROGRESSES does not append an auto-handoff block', async () => {
  const { recordWorkerArtifactProgress } = await import('../../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('hncg-no-append-on-progress-');
  const ticketId = '99887766';
  const ticketDir = path.join(sessionDir, ticketId);
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hncg-wd-'));
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, 'worker_session_8888.log'), 'a log line\n');
  try {
    // before=0, after=1 (a code_review artifact exists) → delta>0 → progressed,
    // never charged as zero-progress, so no fallback note is written.
    fs.writeFileSync(path.join(ticketDir, 'code_review_2026-08-29.md'), 'x');
    recordWorkerArtifactProgress(statePath, sessionDir, ticketId, 0, { workingDir });

    assert.ok(!fs.existsSync(path.join(ticketDir, 'handoff_notes.md')), 'no fallback note on a progressing spawn');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});
