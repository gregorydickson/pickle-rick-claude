// @tier: integration
/**
 * R-WSE-2 / AC-WSE-02 — checkPartialLifecycleExit emits worker_partial_lifecycle_exit
 * when research-review APPROVED but downstream artifacts (plan / conformance / code_review)
 * are missing from the ticket directory. Payload includes ticket, artifacts_missing[],
 * and session_log_size.
 *
 * AC-WSE-05 forensic regression — replays the silent-exit signature from
 * 2026-05-04-f416c6cc/018f32d2: 4 artifacts present (research, research_review, plan,
 * plan_review) + 0-byte worker_session_*.log + missing conformance/code_review.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { checkPartialLifecycleExit } = await import('../../bin/mux-runner.js');

function makeSession() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-wse2-'));
  const sessionDir = path.join(tmp, 'session');
  mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      active: true,
      schema_version: 3,
      working_dir: tmp,
      step: 'research',
      iteration: 0,
      max_iterations: 10,
      worker_timeout_seconds: 600,
      start_time_epoch: Math.floor(Date.now() / 1000),
      original_prompt: 'wse2 test',
      session_dir: sessionDir,
      tmux_mode: false,
      backend: 'claude',
      schema_versionprev: 0,
      activity: [],
    }),
  );
  return { tmp, sessionDir, statePath };
}

function readActivity(statePath) {
  const state = JSON.parse(readFileSync(statePath, 'utf-8'));
  return Array.isArray(state.activity) ? state.activity : [];
}

test('AC-WSE-02 (90574654 delta): research APPROVED + missing plan + 0-byte log emits worker_silent_death (log_empty), never the legacy event', () => {
  const { tmp, sessionDir, statePath } = makeSession();
  try {
    const ticketId = 'aaaa1111';
    const ticketDir = path.join(sessionDir, ticketId);
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(path.join(ticketDir, 'research_review.md'), '# review\n\nAPPROVED');
    writeFileSync(path.join(ticketDir, 'research_2026-05-07.md'), 'research body');
    writeFileSync(path.join(ticketDir, 'worker_session_99999.log'), '');

    checkPartialLifecycleExit(sessionDir, statePath, ticketId);

    const events = readActivity(statePath).filter((e) => e.event === 'worker_silent_death');
    assert.equal(events.length, 1, `expected 1 worker_silent_death event, got ${events.length}`);
    const ev = events[0];
    assert.equal(ev.ticket, ticketId);
    assert.equal(typeof ev.ts, 'string', 'schema-required ts must be present');
    assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'ts must be ISO 8601 UTC');
    assert.equal(ev.sub_class, 'log_empty');
    assert.equal(ev.pid, 99999);
    assert.equal(typeof ev.log_path, 'string');
    assert.equal(ev.respawn_attempt, 0);
    // 90574654 mutual exclusion: the two events must NEVER both fire for one exit.
    assert.equal(
      readActivity(statePath).filter((e) => e.event === 'worker_partial_lifecycle_exit').length,
      0,
      'log_empty exits must not also emit worker_partial_lifecycle_exit',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-WSE-02: research APPROVED + missing plan + TRUNCATED log keeps worker_partial_lifecycle_exit', () => {
  const { tmp, sessionDir, statePath } = makeSession();
  try {
    const ticketId = 'aaaa1112';
    const ticketDir = path.join(sessionDir, ticketId);
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(path.join(ticketDir, 'research_review.md'), '# review\n\nAPPROVED');
    writeFileSync(path.join(ticketDir, 'research_2026-05-07.md'), 'research body');
    writeFileSync(path.join(ticketDir, 'worker_session_99998.log'), 'partial output — no terminal promise token\n');

    checkPartialLifecycleExit(sessionDir, statePath, ticketId);

    const events = readActivity(statePath).filter((e) => e.event === 'worker_partial_lifecycle_exit');
    assert.equal(events.length, 1, `expected 1 partial-lifecycle event, got ${events.length}`);
    const ev = events[0];
    assert.equal(ev.ticket, ticketId);
    assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'ts must be ISO 8601 UTC');
    // R-PIAP-A4: medium required set is derived from TIER_LIFECYCLE[medium] and
    // now includes plan_review (plan → plan_*.md + plan_review.md).
    assert.deepStrictEqual(ev.gate_payload.artifacts_missing.sort(), ['code_review', 'conformance', 'plan', 'plan_review']);
    assert.ok(ev.gate_payload.session_log_size > 0, 'truncated log has nonzero size');
    assert.equal(
      readActivity(statePath).filter((e) => e.event === 'worker_silent_death').length,
      0,
      'log_truncated exits must not also emit worker_silent_death',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-WSE-02: all downstream artifacts present → no event', () => {
  const { tmp, sessionDir, statePath } = makeSession();
  try {
    const ticketId = 'bbbb2222';
    const ticketDir = path.join(sessionDir, ticketId);
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(path.join(ticketDir, 'research_review.md'), 'APPROVED');
    writeFileSync(path.join(ticketDir, 'plan_2026-05-07.md'), 'plan');
    writeFileSync(path.join(ticketDir, 'plan_review.md'), 'APPROVED'); // R-PIAP-A4: medium lifecycle requires plan_review
    writeFileSync(path.join(ticketDir, 'conformance_2026-05-07.md'), 'conformance');
    writeFileSync(path.join(ticketDir, 'code_review_2026-05-07.md'), 'review');

    // No log fixture: were this guard removed, the exit would classify log_empty and emit
    // worker_silent_death — so assert the null return and an EMPTY activity, not one event name.
    assert.equal(checkPartialLifecycleExit(sessionDir, statePath, ticketId), null);
    assert.deepStrictEqual(readActivity(statePath), [], 'expected no event of any kind when all artifacts present');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-WSE-02: research review NOT APPROVED → no event even with missing artifacts', () => {
  const { tmp, sessionDir, statePath } = makeSession();
  try {
    const ticketId = 'cccc3333';
    const ticketDir = path.join(sessionDir, ticketId);
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(path.join(ticketDir, 'research_review.md'), 'REJECTED');

    assert.equal(checkPartialLifecycleExit(sessionDir, statePath, ticketId), null);
    assert.deepStrictEqual(readActivity(statePath), [], 'expected no event of any kind when research review is not APPROVED');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-WSE-05 (90574654 delta): silent-exit-018f32d2 forensic replay — 4 artifacts + 0-byte log now fires worker_silent_death', () => {
  // Replays the exact signature from session 2026-05-04-f416c6cc ticket 018f32d2:
  //   - research_2026-05-04.md, research_review.md (APPROVED), plan_*.md, plan_review.md present
  //   - worker_session_<pid>.log exists at 0 bytes
  //   - conformance_*.md and code_review_*.md MISSING
  // Pre-R-WSE-2: mux-runner moved on silently. Post-90574654: the 0-byte log is
  // sub-classified log_empty and emits worker_silent_death (the legacy event is
  // reserved for log_truncated / graceful partial exits — mutual exclusion).
  const { tmp, sessionDir, statePath } = makeSession();
  try {
    const ticketId = '018f32d2';
    const ticketDir = path.join(sessionDir, ticketId);
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(path.join(ticketDir, 'research_2026-05-04.md'), 'research body');
    writeFileSync(path.join(ticketDir, 'research_review.md'), '# Research Review\n\nAPPROVED');
    writeFileSync(path.join(ticketDir, 'plan_2026-05-04.md'), 'plan body');
    writeFileSync(path.join(ticketDir, 'plan_review.md'), '# Plan Review\n\nAPPROVED');
    writeFileSync(path.join(ticketDir, 'worker_session_94069.log'), ''); // 0-byte log — the smoking gun

    const cls = checkPartialLifecycleExit(sessionDir, statePath, ticketId);

    assert.ok(cls, 'classification must be returned');
    assert.equal(cls.subClass, 'log_empty');
    assert.deepStrictEqual(
      cls.artifactsMissing.sort(),
      ['code_review', 'conformance'],
      'expected exactly conformance + code_review missing (plan present)',
    );
    const events = readActivity(statePath).filter((e) => e.event === 'worker_silent_death');
    assert.equal(events.length, 1, 'forensic replay must fire exactly one worker_silent_death');
    const ev = events[0];
    assert.equal(ev.ticket, '018f32d2');
    assert.equal(typeof ev.ts, 'string', 'schema-required ts must be present');
    assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'ts must be ISO 8601 UTC');
    assert.equal(ev.sub_class, 'log_empty');
    assert.equal(ev.pid, 94069);
    assert.equal(
      readActivity(statePath).filter((e) => e.event === 'worker_partial_lifecycle_exit').length,
      0,
      '0-byte exits must not also emit worker_partial_lifecycle_exit',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
