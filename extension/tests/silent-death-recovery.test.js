// @tier: fast
/**
 * Ticket 90574654 — Silent-death recovery: salvage-first respawn with persistent
 * shared cap, as a delta over checkPartialLifecycleExit.
 *
 * Covers:
 *  - sub-classification: log_empty → worker_silent_death; log_truncated →
 *    worker_partial_lifecycle_exit; never both for one exit (mutual exclusion)
 *  - salvage-first policy ordering (attributable work suppresses respawn)
 *  - shared cap drawdown across both sub-classes, persisted in
 *    state.recovery_attempts (strategy 'silent_death_respawn') — survives a
 *    fresh policy instantiation against the same state.json
 *  - cap exhausted → halt with a HALT-class exit reason (set membership)
 *  - resolveHardeningSettings absent/partial/malformed matrix
 *  - respawns do NOT touch worker_artifact_progress.zero_progress_count
 *  - dirty tree → archiveBeforeDestructive(reason 'silent_death'); archive
 *    failure suppresses respawn (fail-closed for the destructive op)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { checkPartialLifecycleExit, applySilentDeathRecoveryPolicy, isFailureExit } = await import('../bin/mux-runner.js');
const { resolveHardeningSettings } = await import('../services/pickle-utils.js');

const TICKET = 'sd123456';

function makeSession(opts = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-sdr-'));
  const sessionDir = path.join(tmp, 'session');
  mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      active: true,
      schema_version: 5,
      working_dir: opts.workingDir ?? tmp,
      step: 'implement',
      iteration: 3,
      max_iterations: 50,
      worker_timeout_seconds: 600,
      start_time_epoch: Math.floor(Date.now() / 1000),
      original_prompt: 'silent-death recovery test',
      session_dir: sessionDir,
      started_at: new Date().toISOString(),
      history: [],
      tmux_mode: false,
      backend: 'claude',
      activity: [],
      recovery_attempts: opts.recoveryAttempts ?? [],
      worker_artifact_progress: opts.workerArtifactProgress ?? {},
    }),
  );
  const ticketDir = path.join(sessionDir, TICKET);
  mkdirSync(ticketDir, { recursive: true });
  // Medium-tier gate: research APPROVED, downstream artifacts missing.
  writeFileSync(path.join(ticketDir, 'research_2026-06-11.md'), 'research body');
  writeFileSync(path.join(ticketDir, 'research_review.md'), '# review\n\nAPPROVED');
  writeFileSync(
    path.join(ticketDir, `linear_ticket_${TICKET}.md`),
    opts.ticketFrontmatter ?? `---\nid: ${TICKET}\nstatus: "In Progress"\ncomplexity_tier: medium\n---\n# T\n`,
  );
  return { tmp, sessionDir, statePath, ticketDir };
}

/** Age every lifecycle artifact so a future iterationStartMs window excludes them. */
function ageArtifacts(ticketDir) {
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  for (const f of ['research_2026-06-11.md', 'research_review.md']) {
    utimesSync(path.join(ticketDir, f), old, old);
  }
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function eventsOf(statePath, name) {
  const s = readState(statePath);
  return (Array.isArray(s.activity) ? s.activity : []).filter((e) => e.event === name);
}

function policyInput(fix, classification, overrides = {}) {
  return {
    sessionDir: fix.sessionDir,
    statePath: fix.statePath,
    ticketId: TICKET,
    workingDir: readState(fix.statePath).working_dir,
    iteration: 3,
    classification,
    iterationStartMs: Date.now() + 1000, // future window → no fresh-artifact salvage unless test arranges it
    log: () => {},
    ...overrides,
  };
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 15000 }).trim();
}

function initRepo(dir) {
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'sdr@test.local'], dir);
  git(['config', 'user.name', 'sdr'], dir);
  writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(['add', 'base.txt'], dir);
  git(['commit', '-q', '-m', 'base'], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

// ─── Sub-classification + event mutual exclusion ──────────────────────────────

test('log_empty (0-byte log) emits exactly one worker_silent_death and never worker_partial_lifecycle_exit', () => {
  const fix = makeSession();
  try {
    writeFileSync(path.join(fix.ticketDir, 'worker_session_11111.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    assert.ok(cls, 'classification must be returned for a partial lifecycle exit');
    assert.equal(cls.subClass, 'log_empty');
    const silent = eventsOf(fix.statePath, 'worker_silent_death');
    assert.equal(silent.length, 1, 'exactly one worker_silent_death');
    assert.equal(eventsOf(fix.statePath, 'worker_partial_lifecycle_exit').length, 0, 'mutual exclusion');
    const ev = silent[0];
    assert.equal(ev.ticket, TICKET);
    assert.equal(ev.pid, 11111);
    assert.equal(ev.sub_class, 'log_empty');
    assert.equal(ev.respawn_attempt, 0);
    assert.equal(typeof ev.log_path, 'string');
    assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

test('absent worker log classifies log_empty with pid null', () => {
  const fix = makeSession();
  try {
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    assert.equal(cls.subClass, 'log_empty');
    assert.equal(cls.pid, null);
    assert.equal(eventsOf(fix.statePath, 'worker_silent_death').length, 1);
    assert.equal(eventsOf(fix.statePath, 'worker_silent_death')[0].pid, null);
    assert.equal(eventsOf(fix.statePath, 'worker_partial_lifecycle_exit').length, 0);
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

test('log_truncated (nonzero log, no terminal promise token) keeps worker_partial_lifecycle_exit and never worker_silent_death', () => {
  const fix = makeSession();
  try {
    writeFileSync(path.join(fix.ticketDir, 'worker_session_22222.log'), 'partial output, killed mid-flight\n');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    assert.equal(cls.subClass, 'log_truncated');
    const legacy = eventsOf(fix.statePath, 'worker_partial_lifecycle_exit');
    assert.equal(legacy.length, 1, 'exactly one worker_partial_lifecycle_exit');
    assert.equal(eventsOf(fix.statePath, 'worker_silent_death').length, 0, 'mutual exclusion');
    assert.ok(Array.isArray(legacy[0].gate_payload.artifacts_missing));
    assert.ok(legacy[0].gate_payload.session_log_size > 0);
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

test('graceful exit (terminal promise token in latest log) keeps the existing event and policy takes no action', () => {
  const fix = makeSession();
  try {
    writeFileSync(
      path.join(fix.ticketDir, 'worker_session_33333.log'),
      'work work\n<promise>I AM DONE</promise>\n',
    );
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    assert.equal(cls.subClass, null, 'graceful exit is not a silent-death sub-class');
    assert.equal(eventsOf(fix.statePath, 'worker_partial_lifecycle_exit').length, 1);
    assert.equal(eventsOf(fix.statePath, 'worker_silent_death').length, 0);
    const decision = applySilentDeathRecoveryPolicy(policyInput(fix, cls, { settings: { silent_death_respawn_cap: 1 } }));
    assert.equal(decision.action, 'none');
    assert.equal(readState(fix.statePath).recovery_attempts.length, 0);
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

// ─── Salvage-first ────────────────────────────────────────────────────────────

test('AC-2 (B-RASO): UNRESOLVABLE frontmatter sha in non-repo tmp + 0-byte log → respawn, NOT a false hold', () => {
  // The garbage-SHA false-hold this bundle closes: a format-valid but
  // git-unverifiable `completion_commit` must NOT suppress respawn. The old
  // format-only detector held here forever; the collapsed verified oracle
  // rejects the stamp and the ticket respawns like any no-work exit.
  const fix = makeSession({
    ticketFrontmatter: `---\nid: ${TICKET}\nstatus: "In Progress"\ncomplexity_tier: medium\ncompletion_commit: abc1234def\n---\n# T\n`,
  });
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_44444.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    assert.equal(cls.subClass, 'log_empty');
    const decision = applySilentDeathRecoveryPolicy(policyInput(fix, cls, { settings: { silent_death_respawn_cap: 1 } }));
    assert.equal(decision.action, 'respawn', 'unresolvable sha is not attributable work → respawn');
    assert.equal(decision.attempt, 1);
    assert.equal(decision.cap, 1);
    const ledger = readState(fix.statePath).recovery_attempts;
    assert.equal(ledger.length, 1, 'exactly one respawn charged');
    assert.equal(ledger[0].strategy, 'silent_death_respawn', 'strategy === SILENT_DEATH_RESPAWN_STRATEGY');
    assert.equal(ledger[0].outcome, 'success');
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

test('AC-2b (B-RASO): SHA-arm survival — git-resolvable completion sha, no window commit, aged artifacts → hold (completion_commit), cap untouched', () => {
  // Genuine-work behavior is UNCHANGED: a real, git-verifiable completion sha
  // still holds the ticket (no respawn, no cap drawdown) even with no
  // iteration-window commit and no fresh artifacts.
  const repo = mkdtempSync(path.join(tmpdir(), 'pickle-sdr-repo-'));
  const realSha = initRepo(repo);
  const fix = makeSession({
    workingDir: repo,
    ticketFrontmatter: `---\nid: ${TICKET}\nstatus: "In Progress"\ncomplexity_tier: medium\ncompletion_commit: ${realSha}\n---\n# T\n`,
  });
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_44445.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    assert.equal(cls.subClass, 'log_empty');
    // No preIterSha → the scoped-commit window arm cannot fire; the SHA arm must.
    const decision = applySilentDeathRecoveryPolicy(
      policyInput(fix, cls, { workingDir: repo, settings: { silent_death_respawn_cap: 1 } }),
    );
    assert.equal(decision.action, 'hold');
    assert.equal(decision.evidence, 'completion_commit');
    assert.equal(readState(fix.statePath).recovery_attempts.length, 0, 'hold must not draw down the cap');
    const ticketRaw = readFileSync(path.join(fix.ticketDir, `linear_ticket_${TICKET}.md`), 'utf-8');
    assert.match(ticketRaw, /status: "In Progress"/, 'ticket status untouched');
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('salvage-first: fresh lifecycle artifacts inside the iteration window → hold', () => {
  const fix = makeSession();
  try {
    writeFileSync(path.join(fix.ticketDir, 'worker_session_55555.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    // research artifacts were written "now" — window starting in the past catches them
    const decision = applySilentDeathRecoveryPolicy(
      policyInput(fix, cls, { iterationStartMs: Date.now() - 60_000, settings: { silent_death_respawn_cap: 1 } }),
    );
    assert.equal(decision.action, 'hold');
    assert.equal(decision.evidence, 'fresh_artifacts');
    assert.equal(readState(fix.statePath).recovery_attempts.length, 0);
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

test('salvage-first: commit in the iteration window touching only allowed_paths → hold (scoped_commit)', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'pickle-sdr-repo-'));
  const preSha = initRepo(repo);
  const fix = makeSession({ workingDir: repo });
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.sessionDir, 'scope.json'), JSON.stringify({ allowed_paths: ['src/'] }));
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src', 'work.ts'), 'export const x = 1;\n');
    git(['add', 'src/work.ts'], repo);
    git(['commit', '-q', '-m', `feat(${TICKET}): worker landed work`], repo);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_66666.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    const decision = applySilentDeathRecoveryPolicy(
      policyInput(fix, cls, { workingDir: repo, preIterSha: preSha, settings: { silent_death_respawn_cap: 1 } }),
    );
    assert.equal(decision.action, 'hold');
    assert.equal(decision.evidence, 'scoped_commit');
    assert.equal(readState(fix.statePath).recovery_attempts.length, 0);
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('commit touching paths OUTSIDE allowed_paths is not attributable → respawn', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'pickle-sdr-repo-'));
  const preSha = initRepo(repo);
  const fix = makeSession({ workingDir: repo });
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.sessionDir, 'scope.json'), JSON.stringify({ allowed_paths: ['src/'] }));
    writeFileSync(path.join(repo, 'rogue.txt'), 'outside scope\n');
    git(['add', 'rogue.txt'], repo);
    git(['commit', '-q', '-m', 'rogue commit'], repo);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_66667.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    const decision = applySilentDeathRecoveryPolicy(
      policyInput(fix, cls, { workingDir: repo, preIterSha: preSha, settings: { silent_death_respawn_cap: 1 } }),
    );
    assert.equal(decision.action, 'respawn');
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── Respawn cap: drawdown, persistence, halt ─────────────────────────────────

test('respawn-lives: 0-byte exit, no work → exactly one worker_silent_death, one respawn, no halt', () => {
  const fix = makeSession();
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_77777.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    assert.equal(eventsOf(fix.statePath, 'worker_silent_death').length, 1);
    const decision = applySilentDeathRecoveryPolicy(policyInput(fix, cls, { settings: { silent_death_respawn_cap: 1 } }));
    assert.equal(decision.action, 'respawn');
    assert.equal(decision.attempt, 1);
    assert.equal(decision.cap, 1);
    const ledger = readState(fix.statePath).recovery_attempts;
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].strategy, 'silent_death_respawn');
    assert.equal(ledger[0].outcome, 'success');
    assert.equal(typeof ledger[0].reason, 'string');
    assert.equal(ledger[0].iteration, 3);
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

test('respawn-dies: cap reached → halt with HALT-class exit reason (set membership); ledger monotonic', () => {
  const fix = makeSession({
    recoveryAttempts: [{ strategy: 'silent_death_respawn', outcome: 'success', reason: 'prior respawn', iteration: 2, ticket: TICKET }],
  });
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_88888.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    assert.equal(eventsOf(fix.statePath, 'worker_silent_death')[0].respawn_attempt, 1, 'event reflects prior ledger count');
    const decision = applySilentDeathRecoveryPolicy(policyInput(fix, cls, { settings: { silent_death_respawn_cap: 1 } }));
    assert.equal(decision.action, 'halt');
    assert.ok(isFailureExit(decision.exitReason), `exit reason ${decision.exitReason} must be HALT-class by set membership`);
    const ledger = readState(fix.statePath).recovery_attempts;
    assert.ok(ledger.length >= 2, 'ledger is monotonic — exhaustion is recorded, prior entries preserved');
    assert.equal(ledger[0].outcome, 'success');
    assert.equal(ledger.filter((a) => a.strategy === 'silent_death_respawn' && a.outcome === 'success').length, 1, 'no extra respawn charged');
    const ticketRaw = readFileSync(path.join(fix.ticketDir, `linear_ticket_${TICKET}.md`), 'utf-8');
    assert.doesNotMatch(ticketRaw, /status:\s*"?Failed/, 'ticket status must NOT be flipped Failed by this path');
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

test('relaunch persistence: fresh policy invocation against the SAME state.json after one respawn → zero further respawns', () => {
  const fix = makeSession();
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_99990.log'), '');
    const cls1 = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    const d1 = applySilentDeathRecoveryPolicy(policyInput(fix, cls1, { settings: { silent_death_respawn_cap: 1 } }));
    assert.equal(d1.action, 'respawn');
    // Simulate relaunch/resume: a brand-new invocation reading the same persisted state.
    const cls2 = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    const d2 = applySilentDeathRecoveryPolicy(policyInput(fix, cls2, { settings: { silent_death_respawn_cap: 1 } }));
    assert.equal(d2.action, 'halt', 'cap persisted in state.recovery_attempts must survive re-instantiation');
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

test('shared cap: a log_truncated respawn draws from the SAME budget as log_empty', () => {
  const fix = makeSession({
    recoveryAttempts: [{ strategy: 'silent_death_respawn', outcome: 'success', reason: 'log_empty respawn', iteration: 1, ticket: TICKET }],
  });
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_99991.log'), 'truncated output, no token\n');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    assert.equal(cls.subClass, 'log_truncated');
    const decision = applySilentDeathRecoveryPolicy(policyInput(fix, cls, { settings: { silent_death_respawn_cap: 1 } }));
    assert.equal(decision.action, 'halt', 'one shared budget across both sub-classes');
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

test('cap is per ticket: another ticket’s prior respawn does not drain this ticket’s budget', () => {
  const fix = makeSession({
    recoveryAttempts: [{ strategy: 'silent_death_respawn', outcome: 'success', reason: 'other ticket respawn', iteration: 1, ticket: 'feedbeef' }],
  });
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_99996.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    assert.equal(eventsOf(fix.statePath, 'worker_silent_death')[0].respawn_attempt, 0, 'event count is per-ticket');
    const decision = applySilentDeathRecoveryPolicy(policyInput(fix, cls, { settings: { silent_death_respawn_cap: 1 } }));
    assert.equal(decision.action, 'respawn', 'ticket B’s silent death must not be charged against ticket A’s budget');
    const ledger = readState(fix.statePath).recovery_attempts;
    assert.equal(ledger.length, 2);
    assert.equal(ledger[1].ticket, TICKET, 'new entries stamp the ticket for per-ticket counting');
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

// ─── worker_artifact_progress isolation (R-WMW-5 precedence) ─────────────────

test('silent-death respawns do not increment worker_artifact_progress.zero_progress_count', () => {
  const fix = makeSession({
    workerArtifactProgress: { [TICKET]: { spawn_count: 2, last_artifact_count: 2, zero_progress_count: 1 } },
  });
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_99992.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    const decision = applySilentDeathRecoveryPolicy(policyInput(fix, cls, { settings: { silent_death_respawn_cap: 1 } }));
    assert.equal(decision.action, 'respawn');
    const wap = readState(fix.statePath).worker_artifact_progress[TICKET];
    assert.equal(wap.zero_progress_count, 1, 'zero_progress_count untouched by the respawn');
    assert.equal(wap.spawn_count, 2);
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

// ─── Dirty tree → archiveBeforeDestructive ───────────────────────────────────

test('dirty tree before respawn → archive invoked with reason silent_death; respawn proceeds after archive', () => {
  const fix = makeSession();
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_99993.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    const archived = [];
    const decision = applySilentDeathRecoveryPolicy(policyInput(fix, cls, {
      settings: { silent_death_respawn_cap: 1 },
      archive: (ctx) => { archived.push(ctx); return { patchPath: '/tmp/x.patch', files: ['a'], filesTruncated: false }; },
    }));
    assert.equal(decision.action, 'respawn');
    assert.equal(archived.length, 1);
    assert.equal(archived[0].reason, 'silent_death');
    assert.equal(archived[0].sessionDir, fix.sessionDir);
    assert.equal(archived[0].ticketDir, fix.ticketDir);
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

test('ArchiveAbortError suppresses respawn (fail-closed for the destructive op), no cap drawdown', () => {
  const fix = makeSession();
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_99994.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    const abort = new Error('archive failed');
    abort.name = 'ArchiveAbortError';
    const decision = applySilentDeathRecoveryPolicy(policyInput(fix, cls, {
      settings: { silent_death_respawn_cap: 1 },
      archive: () => { throw abort; },
    }));
    assert.equal(decision.action, 'hold');
    assert.equal(decision.evidence, 'archive_failed');
    assert.equal(readState(fix.statePath).recovery_attempts.length, 0, 'no cap drawn when respawn suppressed');
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});

// ─── resolveHardeningSettings matrix ─────────────────────────────────────────

test('resolveHardeningSettings: absent/partial/malformed → compiled defaults; valid override honored', () => {
  // documented compiled default
  assert.deepEqual(resolveHardeningSettings(null), { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
  assert.deepEqual(resolveHardeningSettings(undefined), { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
  assert.deepEqual(resolveHardeningSettings({}), { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
  assert.deepEqual(resolveHardeningSettings({ hardening: null }), { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
  assert.deepEqual(resolveHardeningSettings({ hardening: 'nope' }), { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
  assert.deepEqual(resolveHardeningSettings({ hardening: [] }), { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
  assert.deepEqual(resolveHardeningSettings({ hardening: {} }), { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
  // malformed cap values fall back
  assert.deepEqual(resolveHardeningSettings({ hardening: { silent_death_respawn_cap: 'two' } }), { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
  assert.deepEqual(resolveHardeningSettings({ hardening: { silent_death_respawn_cap: -3 } }), { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
  assert.deepEqual(resolveHardeningSettings({ hardening: { silent_death_respawn_cap: 1.5 } }), { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
  assert.deepEqual(resolveHardeningSettings({ hardening: { silent_death_respawn_cap: NaN } }), { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
  // valid overrides honored (0 disables respawn)
  assert.deepEqual(resolveHardeningSettings({ hardening: { silent_death_respawn_cap: 3 } }), { silent_death_respawn_cap: 3, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
  assert.deepEqual(resolveHardeningSettings({ hardening: { silent_death_respawn_cap: 0 } }), { silent_death_respawn_cap: 0, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
});

test('repo-source pickle_settings.json carries the additive hardening block and schema_version 2 untouched', () => {
  const settingsPath = new URL('../../pickle_settings.json', import.meta.url).pathname;
  const bag = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  assert.equal(bag.schema_version, 2, 'settings schema_version must stay 2');
  assert.ok(bag.hardening && typeof bag.hardening === 'object', 'additive hardening block present');
  assert.equal(bag.hardening.silent_death_respawn_cap, 1);
  assert.ok(bag.bmad_hardening, 'distinct bmad_hardening block untouched');
  assert.deepEqual(resolveHardeningSettings(bag), { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2, breaker_recovery_grace_seconds: 30, bounded_terminal_escape_cap: 3 });
});

test('cap 0 disables respawn entirely → first silent death halts', () => {
  const fix = makeSession();
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(path.join(fix.ticketDir, 'worker_session_99995.log'), '');
    const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
    const decision = applySilentDeathRecoveryPolicy(policyInput(fix, cls, { settings: { silent_death_respawn_cap: 0 } }));
    assert.equal(decision.action, 'halt');
    assert.ok(isFailureExit(decision.exitReason));
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
  }
});
