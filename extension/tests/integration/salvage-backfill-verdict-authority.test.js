// @tier: integration
//
// R-CWGE replay (anatomy-park): the clean-tree salvage back-fill is a Done-flip
// path and MUST honor the authoritative worker-gate verdict, fail-closed on
// red/absent — exactly like guardCompletionCommitBeforeDone.
//
// Gap closed: routeDeadDetachedWorkerDisposition's PRODUCTION backfillDone closure
// flipped a dead-detached clean-tree ticket to Done from an attributable commit
// WITHOUT consulting worker_gate_verdict. readEvidence attributes an explicit /
// id-matched commit without re-checking green (greenGate gates only the
// declared-file-touch pass), so a codex large-tier-detached worker that committed
// a gate-RED tree then died pre-Done-flip would be back-filled to Done over red —
// the R-DOTR/R-CWGE Done-over-red class.
//
// These tests drive the REAL production wiring (no `deps` injection, real git repo,
// real readEvidence attribution) so the new verdict gate inside the production
// backfillDone closure is exercised end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { routeDeadDetachedWorkerDisposition } from '../../bin/mux-runner.js';

const DEAD_PID = 424242; // reaped pid

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/**
 * Build a real git repo (workingDir) with a clean tree + an attributable commit,
 * and a sibling sessionDir (outside the repo so it never dirties the tree) holding
 * a single ticket whose frontmatter carries the given worker_gate_verdict and an
 * explicit completion_commit pointing at the real commit sha.
 */
function makeFixture(ticketId, verdict) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-sbva-'));
  const workingDir = path.join(tmp, 'repo');
  const sessionDir = path.join(tmp, 'session');
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(ticketDir, { recursive: true });

  git(['init', '-q'], workingDir);
  git(['config', 'user.email', 'test@example.com'], workingDir);
  git(['config', 'user.name', 'Test User'], workingDir);
  writeFileSync(path.join(workingDir, 'f.txt'), 'work\n');
  git(['add', 'f.txt'], workingDir);
  execFileSync('git', ['commit', '-q', '-m', `feat(${ticketId}): work`, '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workingDir }).toString().trim();

  const verdictLine = verdict ? `worker_gate_verdict: ${verdict}\n` : '';
  writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\nstatus: "In Progress"\ncomplexity_tier: large\ncompletion_commit: ${sha}\n${verdictLine}---\n# Ticket\n`);

  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({
    active: true, schema_version: 5, working_dir: workingDir, step: 'implement',
    iteration: 0, max_iterations: 10, worker_timeout_seconds: 4800,
    start_time_epoch: Math.floor(Date.now() / 1000) - 3600, original_prompt: 'test',
    session_dir: sessionDir, tmux_mode: false, backend: 'codex',
    current_ticket: ticketId, current_ticket_tier: 'large',
    detached_worker: {
      worker_pid: DEAD_PID, ticket_id: ticketId,
      spawned_at_epoch: Date.now(),
      worker_log_path: path.join(ticketDir, `worker_session_${DEAD_PID}.log`),
    },
    activity: [],
  }));
  return { tmp, workingDir, sessionDir, ticketDir, statePath, sha };
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function ticketStatus(ticketDir, ticketId) {
  const raw = readFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), 'utf-8');
  return raw.match(/^status:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim() ?? null;
}

function callDisposition(ctx) {
  const state = readState(ctx.statePath);
  return routeDeadDetachedWorkerDisposition({
    sessionDir: ctx.sessionDir,
    statePath: ctx.statePath,
    extensionRoot: ctx.tmp,
    workingDir: state.working_dir,
    ticketId: ctx.ticketIdValue,
    iteration: state.iteration,
    flags: null,
    log: () => {},
    progress: { spawnCount: 1, zeroProgressCount: 2 },
    // NO `deps` — exercise the production salvage wiring + the new verdict gate.
  });
}

function withEnv(fn) {
  const prevTest = process.env.PICKLE_TEST_MODE;
  const prevRecov = process.env.PICKLE_RECOVERY_CONSOLIDATION;
  delete process.env.PICKLE_TEST_MODE; // resolveCleanTreeAttribution must run
  process.env.PICKLE_RECOVERY_CONSOLIDATION = 'off'; // deterministic clean_tree fall_through
  try { return fn(); } finally {
    if (prevTest === undefined) delete process.env.PICKLE_TEST_MODE; else process.env.PICKLE_TEST_MODE = prevTest;
    if (prevRecov === undefined) delete process.env.PICKLE_RECOVERY_CONSOLIDATION; else process.env.PICKLE_RECOVERY_CONSOLIDATION = prevRecov;
  }
}

test('R-CWGE: clean-tree back-fill REFUSES Done over a red worker_gate_verdict + emits fail-closed event', () => {
  const ticketId = 'deadredvd';
  const ctx = { ...makeFixture(ticketId, 'red'), ticketIdValue: ticketId };
  try {
    withEnv(() => callDisposition(ctx));
    // Fail-closed: the ticket MUST NOT be Done.
    assert.notEqual(ticketStatus(ctx.ticketDir, ticketId), 'Done', 'red verdict must not back-fill Done');
    const state = readState(ctx.statePath);
    const failClosed = state.activity.filter(e => e.event === 'worker_gate_verdict_fail_closed');
    assert.equal(failClosed.length, 1, 'exactly one worker_gate_verdict_fail_closed event emitted');
    assert.equal(failClosed[0].gate_payload.verdict, 'red', 'event records the red verdict');
    assert.equal(failClosed[0].ticket_id, ticketId, 'event records the ticket id');
  } finally {
    rmSync(ctx.tmp, { recursive: true, force: true });
  }
});

test('R-CWGE: clean-tree back-fill ALLOWS Done on a green worker_gate_verdict (happy path not false-blocked)', () => {
  const ticketId = 'deadgrnvd';
  const ctx = { ...makeFixture(ticketId, 'green'), ticketIdValue: ticketId };
  try {
    const disp = withEnv(() => callDisposition(ctx));
    assert.equal(disp.action, 'continue', 'green verdict advances (continue)');
    assert.equal(ticketStatus(ctx.ticketDir, ticketId), 'Done', 'green verdict back-fills Done');
    const state = readState(ctx.statePath);
    assert.equal(state.activity.filter(e => e.event === 'worker_gate_verdict_fail_closed').length, 0,
      'green verdict emits no fail-closed event');
    assert.equal(state.current_ticket, null, 'green committed-done advances current_ticket=null');
  } finally {
    rmSync(ctx.tmp, { recursive: true, force: true });
  }
});
