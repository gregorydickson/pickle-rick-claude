// @tier: integration
//
// B-RRH Workstream A (ticket 3d540d6c): make the no-progress charge logic
// status/scope/phase/rate-limit aware. Covers A1 (Done-guard), A2 (per-ticket
// ladder exhaustion advances while runnable), A3 (scoped source signature),
// A4 (early-phase credit bounded by N), A5 (rate-limit / breaker-recovery grace
// suppresses the increment). Throwaway temp fixtures only — never the live
// orchestration state.json.

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

function writeTicket(sessionDir, id, frontmatter) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${id}.md`),
    `---\n${lines}\n---\n# ${id}\n`,
  );
  return ticketDir;
}

function readProgress(statePath, ticketId) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return s.worker_artifact_progress?.[ticketId] ?? null;
}

function readActivity(statePath, event) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return (s.activity ?? []).filter((e) => e.event === event);
}

function getTicketStatus(sessionDir, id) {
  const raw = fs.readFileSync(path.join(sessionDir, id, `rick_ticket_${id}.md`), 'utf-8');
  const v = /^status:\s*(.+)$/m.exec(raw)?.[1]?.trim() ?? null;
  return v ? v.replace(/^["']|["']$/g, '') : null;
}

// ───────────────────────── A1 — Done-guard ─────────────────────────
//
// B-1SEAM WS-1: the done-guard is predicate-backed (evaluateCompletionEvidence)
// — a stamped sha must be GIT-VERIFIABLE in the spawn's workingDir; a bare
// non-empty field no longer triggers the guard (the live accept-here-revert-there
// split). Guarded cases therefore need a real repo + a reachable sha.

function initA1GitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'work.txt'), 'work\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'work', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

test('A1: Done ticket with reachable explicit completion_commit is NOT charged (advance, count==0)', async () => {
  const { recordWorkerArtifactProgress } = await import('../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('rrh-a1-explicit-');
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrh-a1-explicit-work-'));
  const id = 'a1explic';
  try {
    const sha = initA1GitRepo(workingDir);
    writeTicket(sessionDir, id, { id, status: 'Done', title: 'done ticket', completion_commit: sha });
    // Three zero-artifact spawns in a row — without the guard each would charge.
    let r;
    for (let i = 0; i < 3; i++) r = recordWorkerArtifactProgress(statePath, sessionDir, id, 0, { workingDir });
    assert.equal(r.doneGuard, true, 'Done + reachable completion_commit must trigger the done-guard');
    assert.equal(r.zeroProgressCount, 0, 'a Done ticket is never charged');
    assert.equal(readProgress(statePath, id).zero_progress_count, 0);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('A1: Done ticket with git-verified INFERRED completion_commit is also guarded', async () => {
  const { recordWorkerArtifactProgress } = await import('../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('rrh-a1-inferred-');
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrh-a1-inferred-work-'));
  const id = 'a1infer';
  try {
    const sha = initA1GitRepo(workingDir);
    writeTicket(sessionDir, id, { id, status: 'Done', title: 't', completion_commit_inferred: sha });
    const r = recordWorkerArtifactProgress(statePath, sessionDir, id, 0, { workingDir });
    assert.equal(r.doneGuard, true);
    assert.equal(r.zeroProgressCount, 0);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('A1 (B-1SEAM): Done ticket with UNREACHABLE completion_commit is NOT guarded — bare field presence no longer accepts', async () => {
  const { recordWorkerArtifactProgress } = await import('../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('rrh-a1-unreach-');
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrh-a1-unreach-work-'));
  const id = 'a1unreach';
  try {
    initA1GitRepo(workingDir);
    writeTicket(sessionDir, id, { id, status: 'Done', title: 't', completion_commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
    const r = recordWorkerArtifactProgress(statePath, sessionDir, id, 0, { workingDir });
    assert.equal(r.doneGuard, false, 'a hallucinated/unreachable stamp must not trigger the done-guard');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('A1: a non-Done ticket WITH completion_commit is still charged (status gates the guard)', async () => {
  const { recordWorkerArtifactProgress } = await import('../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('rrh-a1-todo-');
  const id = 'a1todo00';
  writeTicket(sessionDir, id, { id, status: 'Todo', title: 't', completion_commit: 'deadbeef' });
  try {
    const r = recordWorkerArtifactProgress(statePath, sessionDir, id, 0);
    assert.equal(r.doneGuard, false, 'Todo status must NOT trigger the done-guard');
    assert.equal(r.zeroProgressCount, 1, 'a non-Done ticket still charges');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ───────────────────── A2 — ladder exhaustion advances ─────────────────────

test('A2: per-ticket ladder exhaustion ADVANCES while a runnable Todo remains, emitting ticket_ladder_exhausted', async () => {
  const { advanceOrExitOnLadderExhaustion } = await import('../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('rrh-a2-advance-');
  const exhausted = 'a2exhaus';
  const runnable = 'a2todo00';
  writeTicket(sessionDir, exhausted, { id: exhausted, status: 'In Progress', title: 'stuck', order: 1 });
  writeTicket(sessionDir, runnable, { id: runnable, status: 'Todo', title: 'next', order: 2 });
  try {
    const action = advanceOrExitOnLadderExhaustion({
      // AC-WMFF-2A: workingDir is required — the flip now archives a dirty tree first.
      // sessionDir is not a git repo, so archiveBeforeDestructive self-fails (best-effort).
      sessionDir, statePath, workingDir: sessionDir, ticketId: exhausted, reason: 'recovery_exhausted: test', log: () => {},
    });
    assert.equal(action, 'advance', 'a remaining runnable Todo → advance, not run-exit');
    assert.equal(getTicketStatus(sessionDir, exhausted), 'Failed', 'exhausted ticket is flipped Failed');
    const ev = readActivity(statePath, 'ticket_ladder_exhausted');
    assert.equal(ev.length, 1, 'emits exactly one ticket_ladder_exhausted');
    assert.equal(ev[0].ticket, exhausted);
    const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    assert.equal(s.current_ticket, null, 'current_ticket cleared so the next iteration selects past it');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('A2: ladder exhaustion EXITS when no runnable ticket remains', async () => {
  const { advanceOrExitOnLadderExhaustion } = await import('../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('rrh-a2-exit-');
  const only = 'a2only00';
  writeTicket(sessionDir, only, { id: only, status: 'In Progress', title: 'last', order: 1 });
  try {
    const action = advanceOrExitOnLadderExhaustion({
      sessionDir, statePath, workingDir: sessionDir, ticketId: only, reason: 'recovery_exhausted: test', log: () => {},
    });
    assert.equal(action, 'exit', 'no runnable ticket remains → run-exit');
    assert.equal(getTicketStatus(sessionDir, only), 'Failed');
    assert.equal(readActivity(statePath, 'ticket_ladder_exhausted').length, 1);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ───────────────────── A3 — scoped source signature ─────────────────────

test('A3: scoped signature over scope.json:allowed_paths excludes a peer-dirty prds/ file', async () => {
  const { computeScopedSourceTreeSignature, computeSourceTreeSignature } = await import('../bin/mux-runner.js');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rrh-a3-'));
  // Isolation: sandbox PICKLE_DATA_ROOT so no imported helper can reach live orchestration state.
  process.env.PICKLE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rrh-a3-dataroot-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'prds'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'prds', 'p.md'), 'baseline\n');
    git('add', '-A');
    git('commit', '-qm', 'base');

    const scopePath = path.join(repo, 'scope.json');
    fs.writeFileSync(scopePath, JSON.stringify({ allowed_paths: ['src/'] }));

    const clean = computeScopedSourceTreeSignature(repo, scopePath);

    // Peer session dirties an OUT-OF-SCOPE prds/ file — scoped signature must NOT move.
    fs.writeFileSync(path.join(repo, 'prds', 'p.md'), 'peer session dirtied me\n');
    const afterPeerDirt = computeScopedSourceTreeSignature(repo, scopePath);
    assert.equal(afterPeerDirt, clean, 'a peer-dirty prds/ file is absent from the scoped signature');

    // Whole-tree signature DOES see the prds/ change — proves the scoping is real.
    assert.notEqual(
      computeSourceTreeSignature(repo),
      computeScopedSourceTreeSignature(repo, scopePath),
      'whole-tree signature differs from scoped once a peer prds/ file is dirty',
    );

    // An IN-SCOPE change DOES move the scoped signature.
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 2;\n');
    assert.notEqual(computeScopedSourceTreeSignature(repo, scopePath), clean, 'in-scope change moves the scoped signature');

    // Missing/absent scope.json → unscoped fallback (delegates to whole-tree).
    assert.equal(
      computeScopedSourceTreeSignature(repo, path.join(repo, 'nope.json')),
      computeSourceTreeSignature(repo),
      'absent scope.json falls back to the whole-tree signature',
    );
    // Non-repo dir → null (same fail-open contract as computeSourceTreeSignature).
    assert.equal(computeScopedSourceTreeSignature(path.join(repo, 'missing')), null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ───────────────────── A4 — early-phase credit bounded by N ─────────────────────

test('A4: countWorkerArtifacts credits research/plan only under creditEarlyPhases', async () => {
  const { countWorkerArtifacts } = await import('../bin/mux-runner.js');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rrh-a4-count-'));
  try {
    fs.writeFileSync(path.join(d, 'research_2026-06-12.md'), 'x');
    fs.writeFileSync(path.join(d, 'plan_2026-06-12.md'), 'x');
    assert.equal(countWorkerArtifacts(d), 0, 'default: research/plan do NOT count');
    assert.equal(countWorkerArtifacts(d, { creditEarlyPhases: true }), 2, 'creditEarlyPhases: research+plan count');
    fs.writeFileSync(path.join(d, 'conformance_2026-06-12.md'), 'x');
    assert.equal(countWorkerArtifacts(d), 1, 'conformance always counts');
    assert.equal(countWorkerArtifacts(d, { creditEarlyPhases: true }), 3);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('A4: resolveCreditEarlyPhases — large tier inside window true, past N or non-large false', async () => {
  const { resolveCreditEarlyPhases, resolveWmwEarlyPhaseK, WMW_EARLY_PHASE_K_DEFAULT } = await import('../bin/mux-runner.js');
  assert.equal(WMW_EARLY_PHASE_K_DEFAULT, 4);
  assert.ok(WMW_EARLY_PHASE_K_DEFAULT < 5, 'N must stay below the default skip threshold (5)');
  assert.equal(resolveWmwEarlyPhaseK({}), 4);
  assert.equal(resolveWmwEarlyPhaseK({ PICKLE_WMW_EARLY_PHASE_K: '3' }), 3);
  assert.equal(resolveWmwEarlyPhaseK({ PICKLE_WMW_EARLY_PHASE_K: '0' }), 4, 'non-positive → default');

  const { sessionDir } = setupSession('rrh-a4-credit-');
  const big = 'a4large0';
  const small = 'a4small0';
  writeTicket(sessionDir, big, { id: big, status: 'Todo', title: 't', complexity_tier: 'large' });
  writeTicket(sessionDir, small, { id: small, status: 'Todo', title: 't', complexity_tier: 'medium' });
  const n = 4;
  try {
    assert.equal(resolveCreditEarlyPhases(sessionDir, big, 0, n), true, 'large tier, spawn 0 < N → credit');
    assert.equal(resolveCreditEarlyPhases(sessionDir, big, 3, n), true, 'large tier, spawn 3 < N → credit');
    assert.equal(resolveCreditEarlyPhases(sessionDir, big, 4, n), false, 'large tier, spawn 4 >= N → past window, no credit (still auto-skips)');
    assert.equal(resolveCreditEarlyPhases(sessionDir, small, 0, n), false, 'non-large tier never credits');
    assert.equal(resolveCreditEarlyPhases(sessionDir, 'missing', 0, n), false, 'missing ticket → fail-open false');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('A4: large-tier early phase credit resets the counter; churn PAST N still charges toward auto-skip', async () => {
  const { recordWorkerArtifactProgress } = await import('../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('rrh-a4-flow-');
  const id = 'a4flow00';
  const ticketDir = writeTicket(sessionDir, id, { id, status: 'In Progress', title: 't', complexity_tier: 'large' });
  try {
    // Spawn 1 (in window): worker produces research → with credit, delta>0 → progress, count 0.
    fs.writeFileSync(path.join(ticketDir, 'research_x.md'), 'x');
    let r = recordWorkerArtifactProgress(statePath, sessionDir, id, 0, { creditEarlyPhases: true });
    assert.equal(r.zeroProgressCount, 0, 'early-phase research credits progress in-window');

    // Past the window (creditEarlyPhases false): research/plan no longer count.
    // before==after==0 (only conformance/code_review counted, none present) → charges.
    r = recordWorkerArtifactProgress(statePath, sessionDir, id, 0, { creditEarlyPhases: false });
    assert.equal(r.zeroProgressCount, 1, 'past-N phase churn charges (heads toward auto-skip)');
    r = recordWorkerArtifactProgress(statePath, sessionDir, id, 0, { creditEarlyPhases: false });
    assert.equal(r.zeroProgressCount, 2);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ───────────────────── A5 — rate-limit / breaker-recovery suppression ─────────────────────

test('A5: suppressIncrement HOLDS the counter (never increments)', async () => {
  const { recordWorkerArtifactProgress } = await import('../bin/mux-runner.js');
  const { sessionDir, statePath } = setupSession('rrh-a5-suppress-');
  const id = 'a5supp00';
  writeTicket(sessionDir, id, { id, status: 'In Progress', title: 't' });
  try {
    // First a normal charge → count 1.
    let r = recordWorkerArtifactProgress(statePath, sessionDir, id, 0);
    assert.equal(r.zeroProgressCount, 1);
    // Rate-limited / breaker-recovery spawns: held at 1, never incremented.
    r = recordWorkerArtifactProgress(statePath, sessionDir, id, 0, { suppressIncrement: true });
    assert.equal(r.zeroProgressCount, 1, 'suppressed spawn does not increment');
    assert.equal(r.incrementSuppressed, true);
    r = recordWorkerArtifactProgress(statePath, sessionDir, id, 0, { suppressIncrement: true });
    assert.equal(r.zeroProgressCount, 1, 'still held');
    // Suppression lifted → charges again.
    r = recordWorkerArtifactProgress(statePath, sessionDir, id, 0);
    assert.equal(r.zeroProgressCount, 2);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('A5: resolveHardeningSettings().breaker_recovery_grace_seconds + isWithinBreakerRecoveryGrace', async () => {
  const { isWithinBreakerRecoveryGrace } = await import('../bin/mux-runner.js');
  // R-RRPC-1: resolveBreakerRecoveryGraceSeconds was folded into the canonical
  // resolveHardeningSettings (services/pickle-utils.js) — the duplicate mux-runner.js
  // resolver + its DEFAULT_BREAKER_RECOVERY_GRACE_SECONDS const are gone.
  const { resolveHardeningSettings } = await import('../services/pickle-utils.js');
  const grace = (bag) => resolveHardeningSettings(bag).breaker_recovery_grace_seconds;
  assert.equal(grace(null), 30);
  assert.equal(grace({}), 30, 'absent hardening block → default');
  assert.equal(grace({ hardening: { breaker_recovery_grace_seconds: 45 } }), 45);
  assert.equal(grace({ hardening: { breaker_recovery_grace_seconds: -1 } }), 30, 'negative → default');
  assert.equal(grace({ hardening: { breaker_recovery_grace_seconds: 1.5 } }), 30, 'non-integer → default');
  assert.equal(grace({ hardening: 'nope' }), 30, 'malformed block → default');

  const now = Date.parse('2026-06-12T12:00:00Z');
  assert.equal(isWithinBreakerRecoveryGrace(null, 30, now), false, 'no breaker → false');
  assert.equal(isWithinBreakerRecoveryGrace({ state: 'OPEN', total_opens: 1, last_change: new Date(now).toISOString() }, 30, now), false, 'OPEN is not a recovery');
  assert.equal(isWithinBreakerRecoveryGrace({ state: 'HALF_OPEN', total_opens: 1, last_change: new Date(now).toISOString() }, 30, now), true, 'HALF_OPEN is actively recovering');
  assert.equal(
    isWithinBreakerRecoveryGrace({ state: 'CLOSED', total_opens: 1, last_change: new Date(now - 10_000).toISOString() }, 30, now),
    true,
    'CLOSED within grace after a real trip → true',
  );
  assert.equal(
    isWithinBreakerRecoveryGrace({ state: 'CLOSED', total_opens: 1, last_change: new Date(now - 40_000).toISOString() }, 30, now),
    false,
    'CLOSED past grace → false',
  );
  assert.equal(
    isWithinBreakerRecoveryGrace({ state: 'CLOSED', total_opens: 0, last_change: new Date(now).toISOString() }, 30, now),
    false,
    'never-tripped breaker → false',
  );
  assert.equal(
    isWithinBreakerRecoveryGrace({ state: 'CLOSED', total_opens: 1, last_change: 'not-a-date' }, 30, now),
    false,
    'unparseable last_change → fail-open false',
  );
});
