// @tier: fast
/**
 * Ticket 7eb9fa20 (H4) — Failed-flip evidence suppression with bounded
 * non-runnable hold at the three real callsites.
 *
 * Covers:
 *  - OR-predicate 4-cell matrix (artifacts-only / commit-only / both / neither),
 *    parametrized across all three callsites (head_regression, wmw_auto_skip,
 *    worker_gate_fail) — they share ONE policy function
 *  - stale-artifact fixture (mtimes outside [spawn, exit] window) → flip proceeds
 *  - garbage frontmatter sha (regex-valid, not a real commit) is NOT evidence
 *  - evidence-check error → fail-open (proceed with existing flip behavior)
 *  - suppression bookkeeping: failed_flip_suppressed activity event (schema
 *    quintet), recovery_attempts ledger entry (strategy failed_flip_suppressed),
 *    suppression_count ≤ cap
 *  - cap reached → escalate (existing no-progress halt at the callsite); cap 0
 *    disables suppression
 *  - non-runnable hold: held ticket excluded from a scheduling pass
 *    (resolvePreTicket selects past it; held current_ticket never re-engaged);
 *    operator re-queue (status: Todo) releases the hold
 *  - head-regression integration: unreattachable-but-real orphan → flip
 *    suppressed (status preserved); cap → suppression_cap_escalate (no flip);
 *    evidence-absent dirty tree → archival THEN flip
 *  - no new state.json top-level field (only recovery_attempts + activity)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const {
  evaluateFailedFlipSuppression,
  readActiveFailedFlipHolds,
  resolvePreTicket,
  detectAndRecoverHeadRegression,
} = await import('../bin/mux-runner.js');

const TICKET = 'ff123456';
const CALLSITES = ['head_regression', 'wmw_auto_skip', 'worker_gate_fail'];
const SETTINGS = { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 2 };

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 15000 }).trim();
}

function initRepo(dir) {
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'ffs@test.local'], dir);
  git(['config', 'user.name', 'ffs'], dir);
  writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(['add', 'base.txt'], dir);
  git(['commit', '-q', '--no-gpg-sign', '-m', 'base'], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

function makeFixture(opts = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-ffs-'));
  const sessionDir = path.join(tmp, 'session');
  const workingDir = path.join(tmp, 'repo');
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(workingDir, { recursive: true });
  const baseSha = initRepo(workingDir);
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({
    active: true,
    schema_version: 5,
    working_dir: workingDir,
    step: 'implement',
    iteration: 4,
    max_iterations: 50,
    worker_timeout_seconds: 600,
    start_time_epoch: Math.floor(Date.now() / 1000),
    original_prompt: 'failed-flip suppression test',
    session_dir: sessionDir,
    started_at: new Date().toISOString(),
    history: [],
    tmux_mode: false,
    backend: 'claude',
    activity: [],
    recovery_attempts: opts.recoveryAttempts ?? [],
  }));
  const ticketDir = path.join(sessionDir, TICKET);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(
    path.join(ticketDir, `rick_ticket_${TICKET}.md`),
    opts.ticketFrontmatter ?? `---\nid: ${TICKET}\nstatus: "In Progress"\norder: 1\ncomplexity_tier: medium\n---\n# T\n`,
  );
  writeFileSync(path.join(ticketDir, 'plan_2026-06-11.md'), 'plan body\n');
  return { tmp, sessionDir, statePath, ticketDir, workingDir, baseSha };
}

/** Age every lifecycle artifact one hour so a now-opening window excludes them. */
function ageArtifacts(ticketDir) {
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  for (const f of readdirSync(ticketDir)) {
    if (/^(research|plan|conformance|code_review).*\.md$/.test(f)) {
      utimesSync(path.join(ticketDir, f), old, old);
    }
  }
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function eventsOf(statePath, name) {
  const s = readState(statePath);
  return (Array.isArray(s.activity) ? s.activity : []).filter((e) => e.event === name);
}

function ledgerOf(statePath) {
  const s = readState(statePath);
  return (Array.isArray(s.recovery_attempts) ? s.recovery_attempts : [])
    .filter((a) => a.strategy === 'failed_flip_suppressed');
}

function policyInput(fix, callsite, overrides = {}) {
  return {
    sessionDir: fix.sessionDir,
    statePath: fix.statePath,
    ticketId: TICKET,
    workingDir: fix.workingDir,
    iteration: 4,
    callsite,
    windowStartMs: Date.now() - 30_000,
    windowEndMs: Date.now(),
    preSha: fix.baseSha,
    settings: SETTINGS,
    log: () => {},
    ...overrides,
  };
}

function commitWork(fix) {
  writeFileSync(path.join(fix.workingDir, 'work.txt'), 'worker output\n');
  git(['add', 'work.txt'], fix.workingDir);
  git(['commit', '-q', '--no-gpg-sign', '-m', `feat(${TICKET}): work`], fix.workingDir);
  return git(['rev-parse', 'HEAD'], fix.workingDir);
}

// ─── OR-predicate 4-cell matrix, parametrized across the three callsites ─────

for (const callsite of CALLSITES) {
  test(`[${callsite}] artifacts-only → suppress (fresh_artifacts) with event + ledger entry`, () => {
    const fix = makeFixture();
    try {
      // plan_*.md was just written → inside window; no commit beyond preSha.
      const decision = evaluateFailedFlipSuppression(policyInput(fix, callsite));
      assert.deepEqual(decision, { action: 'suppress', evidence: 'fresh_artifacts', suppressionCount: 1 });

      const events = eventsOf(fix.statePath, 'failed_flip_suppressed');
      assert.equal(events.length, 1, 'exactly one failed_flip_suppressed event');
      const e = events[0];
      assert.equal(e.ticket, TICKET);
      assert.equal(e.evidence, 'fresh_artifacts');
      assert.equal(e.suppression_count, 1);
      assert.equal(typeof e.ts, 'string', 'explicit ts stamped (writeActivityEntry never stamps ts)');

      const ledger = ledgerOf(fix.statePath);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].outcome, 'success');
      assert.equal(ledger[0].ticket, TICKET);
      assert.ok(ledger[0].reason.includes(callsite), 'ledger reason names the callsite');
    } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
  });

  test(`[${callsite}] commit-only → suppress (ticket_commit)`, () => {
    const fix = makeFixture();
    try {
      ageArtifacts(fix.ticketDir);
      commitWork(fix); // unscoped session: any window commit counts
      const decision = evaluateFailedFlipSuppression(policyInput(fix, callsite));
      assert.deepEqual(decision, { action: 'suppress', evidence: 'ticket_commit', suppressionCount: 1 });
      assert.equal(eventsOf(fix.statePath, 'failed_flip_suppressed')[0].evidence, 'ticket_commit');
    } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
  });

  test(`[${callsite}] both arms → suppress (both) — OR-predicate, not AND`, () => {
    const fix = makeFixture();
    try {
      commitWork(fix); // fresh plan artifact AND a window commit
      const decision = evaluateFailedFlipSuppression(policyInput(fix, callsite));
      assert.deepEqual(decision, { action: 'suppress', evidence: 'both', suppressionCount: 1 });
    } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
  });

  test(`[${callsite}] neither arm → proceed (no_evidence): flip behavior preserved`, () => {
    const fix = makeFixture();
    try {
      ageArtifacts(fix.ticketDir); // stale artifacts, no commit beyond preSha
      const decision = evaluateFailedFlipSuppression(policyInput(fix, callsite));
      assert.deepEqual(decision, { action: 'proceed', reason: 'no_evidence' });
      assert.equal(eventsOf(fix.statePath, 'failed_flip_suppressed').length, 0, 'no event on proceed');
      assert.equal(ledgerOf(fix.statePath).length, 0, 'no ledger entry on proceed');
    } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
  });
}

// ─── Stale-artifact + evidence-edge fixtures ─────────────────────────────────

test('stale artifacts (mtimes outside window) → flip proceeds', () => {
  const fix = makeFixture();
  try {
    ageArtifacts(fix.ticketDir);
    // Window opens NOW — the hour-old plan artifact is outside even with skew.
    const decision = evaluateFailedFlipSuppression(policyInput(fix, 'wmw_auto_skip', {
      windowStartMs: Date.now(),
      windowEndMs: Date.now() + 1000,
    }));
    assert.deepEqual(decision, { action: 'proceed', reason: 'no_evidence' });
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('artifact window disabled (windowStartMs null) → artifact arm contributes nothing', () => {
  const fix = makeFixture();
  try {
    const decision = evaluateFailedFlipSuppression(policyInput(fix, 'worker_gate_fail', { windowStartMs: null }));
    assert.deepEqual(decision, { action: 'proceed', reason: 'no_evidence' });
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('garbage frontmatter completion sha (regex-valid, not a commit) is NOT evidence', () => {
  const fix = makeFixture({
    ticketFrontmatter: `---\nid: ${TICKET}\nstatus: "In Progress"\norder: 1\ncompletion_commit: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n---\n# T\n`,
  });
  try {
    ageArtifacts(fix.ticketDir);
    const decision = evaluateFailedFlipSuppression(policyInput(fix, 'head_regression'));
    assert.deepEqual(decision, { action: 'proceed', reason: 'no_evidence' });
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('verified frontmatter completion sha is authoritative ticket_commit evidence', () => {
  const fix = makeFixture();
  try {
    ageArtifacts(fix.ticketDir);
    const sha = commitWork(fix);
    // preSha == HEAD (no window commit) so ONLY the frontmatter sha arm fires.
    const fm = `---\nid: ${TICKET}\nstatus: "Done"\norder: 1\ncompletion_commit: "${sha}"\n---\n# T\n`;
    writeFileSync(path.join(fix.ticketDir, `rick_ticket_${TICKET}.md`), fm);
    const decision = evaluateFailedFlipSuppression(policyInput(fix, 'head_regression', { preSha: sha }));
    assert.deepEqual(decision, { action: 'suppress', evidence: 'ticket_commit', suppressionCount: 1 });
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('scoped session: window commit outside allowed_paths is NOT evidence; inside IS', () => {
  const fix = makeFixture();
  try {
    ageArtifacts(fix.ticketDir);
    commitWork(fix); // touches work.txt
    writeFileSync(path.join(fix.sessionDir, 'scope.json'), JSON.stringify({ allowed_paths: ['src/'] }));
    let decision = evaluateFailedFlipSuppression(policyInput(fix, 'wmw_auto_skip'));
    assert.deepEqual(decision, { action: 'proceed', reason: 'no_evidence' }, 'out-of-scope commit must not suppress');

    writeFileSync(path.join(fix.sessionDir, 'scope.json'), JSON.stringify({ allowed_paths: ['work.txt'] }));
    decision = evaluateFailedFlipSuppression(policyInput(fix, 'wmw_auto_skip'));
    assert.deepEqual(decision, { action: 'suppress', evidence: 'ticket_commit', suppressionCount: 1 });
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('evidence-check error → fail-open proceed (evidence_check_error), no flip suppression', () => {
  const fix = makeFixture();
  try {
    // Force a throw inside the evidence check: artifact arm armed but the
    // ticket dir is gone (readdirSync throws).
    rmSync(fix.ticketDir, { recursive: true, force: true });
    const decision = evaluateFailedFlipSuppression(policyInput(fix, 'worker_gate_fail'));
    assert.deepEqual(decision, { action: 'proceed', reason: 'evidence_check_error' });
    assert.equal(ledgerOf(fix.statePath).length, 0);
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

// ─── Cap semantics ───────────────────────────────────────────────────────────

function suppressionEntry(n) {
  return {
    strategy: 'failed_flip_suppressed',
    outcome: 'success',
    reason: `wmw_auto_skip flip suppressed ${n}/2 (fresh_artifacts) for ${TICKET}`,
    iteration: n,
    ticket: TICKET,
  };
}

test('second suppression draws count 2/2; persisted ledger survives a fresh evaluation', () => {
  const fix = makeFixture({ recoveryAttempts: [suppressionEntry(1)] });
  try {
    const decision = evaluateFailedFlipSuppression(policyInput(fix, 'head_regression'));
    assert.deepEqual(decision, { action: 'suppress', evidence: 'fresh_artifacts', suppressionCount: 2 });
    assert.equal(eventsOf(fix.statePath, 'failed_flip_suppressed')[0].suppression_count, 2);
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('cap reached → escalate: cap_exhausted ledger entry, NO suppression event, count never exceeds cap', () => {
  const fix = makeFixture({ recoveryAttempts: [suppressionEntry(1), suppressionEntry(2)] });
  try {
    const decision = evaluateFailedFlipSuppression(policyInput(fix, 'wmw_auto_skip'));
    assert.deepEqual(decision, { action: 'escalate', cap: 2 });
    assert.equal(eventsOf(fix.statePath, 'failed_flip_suppressed').length, 0, 'no event at escalate');
    const ledger = ledgerOf(fix.statePath);
    assert.equal(ledger.length, 3);
    const last = ledger[2];
    assert.equal(last.outcome, 'failed');
    assert.match(last.reason, /cap_exhausted \(2\/2\)/);
    assert.equal(ledger.filter((a) => a.outcome === 'success').length, 2, 'suppression_count ≤ cap invariant');
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('cap 0 disables suppression: evidence-backed flip-intent escalates immediately', () => {
  const fix = makeFixture();
  try {
    const decision = evaluateFailedFlipSuppression(policyInput(fix, 'worker_gate_fail', {
      settings: { silent_death_respawn_cap: 1, failed_flip_suppression_cap: 0 },
    }));
    assert.deepEqual(decision, { action: 'escalate', cap: 0 });
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

// ─── Non-runnable hold + scheduling pass ─────────────────────────────────────

function addTicket(sessionDir, id, status, order) {
  const dir = path.join(sessionDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `rick_ticket_${id}.md`),
    `---\nid: ${id}\nstatus: "${status}"\norder: ${order}\n---\n# ${id}\n`,
  );
}

test('held ticket is excluded from the scheduling pass: runner selects past it', () => {
  const fix = makeFixture({ recoveryAttempts: [suppressionEntry(1)] });
  try {
    addTicket(fix.sessionDir, 'bbbb2222', 'Todo', 2);

    const holds = readActiveFailedFlipHolds(fix.sessionDir);
    assert.ok(holds.has(TICKET), 'suppressed ticket is held');

    // Scheduling pass with no current ticket: selects past the held ticket.
    assert.equal(resolvePreTicket(fix.sessionDir, null), 'bbbb2222');
    // A held current_ticket is never re-engaged with stale evidence.
    assert.equal(resolvePreTicket(fix.sessionDir, TICKET), 'bbbb2222');
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('operator re-queue (status: Todo) releases the hold — heal flow preserved', () => {
  const fix = makeFixture({
    recoveryAttempts: [suppressionEntry(1)],
    ticketFrontmatter: `---\nid: ${TICKET}\nstatus: "Todo"\norder: 1\n---\n# T\n`,
  });
  try {
    assert.ok(!readActiveFailedFlipHolds(fix.sessionDir).has(TICKET), 'Todo releases the hold');
    assert.equal(resolvePreTicket(fix.sessionDir, null), TICKET, 're-queued ticket is selectable again');
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('no holds → empty set; unreadable state fails open to empty set', () => {
  const fix = makeFixture();
  try {
    assert.equal(readActiveFailedFlipHolds(fix.sessionDir).size, 0);
    assert.equal(readActiveFailedFlipHolds(path.join(fix.tmp, 'nope')).size, 0);
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

// ─── Callsite integration: detectAndRecoverHeadRegression ────────────────────

/** Build the unreattachable-orphan shape: HEAD at start, orphan on a diverged lineage. */
function makeDivergedOrphanFixture() {
  const fix = makeFixture();
  const repo = fix.workingDir;
  // base (fix.baseSha) → orphan O; then diverge: reset to base, commit start.
  writeFileSync(path.join(repo, 'orphan.txt'), 'orphan work\n');
  git(['add', 'orphan.txt'], repo);
  git(['commit', '-q', '--no-gpg-sign', '-m', `feat(${TICKET}): orphan work`], repo);
  const orphanSha = git(['rev-parse', 'HEAD'], repo);
  git(['reset', '-q', '--hard', fix.baseSha], repo);
  writeFileSync(path.join(repo, 'diverge.txt'), 'diverged\n');
  git(['add', 'diverge.txt'], repo);
  git(['commit', '-q', '--no-gpg-sign', '-m', 'diverged start'], repo);
  const startCommit = git(['rev-parse', 'HEAD'], repo);
  return { ...fix, orphanSha, startCommit };
}

test('head-regression: unreattachable-but-real orphan → flip suppressed, status preserved, event emitted', () => {
  const fix = makeDivergedOrphanFixture();
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(
      path.join(fix.ticketDir, `rick_ticket_${TICKET}.md`),
      `---\nid: ${TICKET}\nstatus: "Done"\norder: 1\ncompletion_commit: ${fix.orphanSha}\n---\n# T\n`,
    );
    const result = detectAndRecoverHeadRegression({
      ticketId: TICKET,
      workingDir: fix.workingDir,
      startCommit: fix.startCommit,
      completionCommitSha: fix.orphanSha,
      sessionDir: fix.sessionDir,
      statePath: fix.statePath,
      iteration: 4,
      log: () => {},
    });
    assert.equal(result.detected, true);
    assert.equal(result.recovered, false);
    assert.equal(result.action, 'flip_suppressed');

    const raw = readFileSync(path.join(fix.ticketDir, `rick_ticket_${TICKET}.md`), 'utf-8');
    assert.match(raw, /status: "Done"/, 'frontmatter status preserved — no Failed flip');
    assert.match(raw, new RegExp(fix.orphanSha), 'completion_commit preserved');
    assert.equal(eventsOf(fix.statePath, 'failed_flip_suppressed').length, 1);
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('head-regression: suppression cap reached → suppression_cap_escalate, still no flip', () => {
  const fix = makeDivergedOrphanFixture();
  try {
    ageArtifacts(fix.ticketDir);
    writeFileSync(
      path.join(fix.ticketDir, `rick_ticket_${TICKET}.md`),
      `---\nid: ${TICKET}\nstatus: "Done"\norder: 1\ncompletion_commit: ${fix.orphanSha}\n---\n# T\n`,
    );
    // Pre-seed the persisted ledger at the compiled default cap (2).
    const s = readState(fix.statePath);
    s.recovery_attempts = [suppressionEntry(1), suppressionEntry(2)];
    writeFileSync(fix.statePath, JSON.stringify(s));

    const result = detectAndRecoverHeadRegression({
      ticketId: TICKET,
      workingDir: fix.workingDir,
      startCommit: fix.startCommit,
      completionCommitSha: fix.orphanSha,
      sessionDir: fix.sessionDir,
      statePath: fix.statePath,
      iteration: 4,
      log: () => {},
    });
    assert.equal(result.action, 'suppression_cap_escalate');
    const raw = readFileSync(path.join(fix.ticketDir, `rick_ticket_${TICKET}.md`), 'utf-8');
    assert.match(raw, /status: "Done"/, 'a ticket is only ever flipped Failed with evidence absent');
    const ledger = ledgerOf(fix.statePath);
    assert.equal(ledger[ledger.length - 1].outcome, 'failed');
    assert.match(ledger[ledger.length - 1].reason, /cap_exhausted/);
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('head-regression: evidence absent + dirty tree → archival runs BEFORE the flip proceeds', () => {
  const fix = makeFixture();
  try {
    ageArtifacts(fix.ticketDir);
    // HEAD == startCommit, no orphan sha, no fresh artifacts → evidence absent.
    writeFileSync(path.join(fix.workingDir, 'base.txt'), 'uncommitted edit\n'); // dirty tree
    const result = detectAndRecoverHeadRegression({
      ticketId: TICKET,
      workingDir: fix.workingDir,
      startCommit: fix.baseSha,
      completionCommitSha: null,
      sessionDir: fix.sessionDir,
      statePath: fix.statePath,
      iteration: 4,
      log: () => {},
    });
    assert.equal(result.action, 'marked_failed', 'legitimate evidence-absent failure still flips');
    const raw = readFileSync(path.join(fix.ticketDir, `rick_ticket_${TICKET}.md`), 'utf-8');
    assert.match(raw, /status: "Failed"/);
    const patches = readdirSync(fix.ticketDir).filter((f) => /^pre_reset_diff_\d+\.patch$/.test(f));
    assert.equal(patches.length, 1, 'dirty tree archived before the flip');
    assert.ok(readFileSync(path.join(fix.ticketDir, patches[0]), 'utf-8').includes('uncommitted edit'));
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

// ─── B-RRH C3: never Failed-flip a COMMITTED ticket on signal teardown ───────

/**
 * Build a committed ticket whose window/scope arms are all SILENT, so only the
 * C3 signal_committed arm can fire: stale artifacts, preSha == HEAD, and a
 * present completion_commit (no real-commit resolution required for this arm).
 */
function makeSignalCommittedFixture(opts = {}) {
  const fix = makeFixture({
    ticketFrontmatter:
      opts.ticketFrontmatter ??
      `---\nid: ${TICKET}\nstatus: "Done"\norder: 1\ncomplexity_tier: medium\n${opts.commitField ?? 'completion_commit'}: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"\n---\n# T\n`,
  });
  ageArtifacts(fix.ticketDir); // artifact arm silent
  return fix;
}

test('[head_regression] committed ticket + SIGTERM → suppress (signal_committed) — AC1', () => {
  const fix = makeSignalCommittedFixture();
  try {
    // preSha == HEAD (no window commit) + stale artifacts + garbage sha (not a
    // real commit) → artifact AND verified-sha arms are silent. ONLY the C3
    // signal_committed arm can fire.
    const decision = evaluateFailedFlipSuppression(
      policyInput(fix, 'head_regression', { interruptionCause: 'signal' }),
    );
    assert.deepEqual(decision, { action: 'suppress', evidence: 'signal_committed', suppressionCount: 1 });

    const events = eventsOf(fix.statePath, 'failed_flip_suppressed');
    assert.equal(events.length, 1);
    assert.equal(events[0].evidence, 'signal_committed');
    assert.equal(ledgerOf(fix.statePath).length, 1);
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('[wmw_auto_skip] committed ticket + SIGTERM → suppress (signal_committed) — AC2', () => {
  const fix = makeSignalCommittedFixture();
  try {
    const decision = evaluateFailedFlipSuppression(
      policyInput(fix, 'wmw_auto_skip', { interruptionCause: 'signal' }),
    );
    assert.deepEqual(decision, { action: 'suppress', evidence: 'signal_committed', suppressionCount: 1 });
    assert.equal(eventsOf(fix.statePath, 'failed_flip_suppressed')[0].evidence, 'signal_committed');
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('C3: inferred completion_commit + SIGTERM also suppresses (committed = explicit OR inferred)', () => {
  const fix = makeSignalCommittedFixture({ commitField: 'completion_commit_inferred' });
  try {
    const decision = evaluateFailedFlipSuppression(
      policyInput(fix, 'wmw_auto_skip', { interruptionCause: 'signal' }),
    );
    assert.deepEqual(decision, { action: 'suppress', evidence: 'signal_committed', suppressionCount: 1 });
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('C3: future signal:SIGTERM-style cause still enables the arm', () => {
  const fix = makeSignalCommittedFixture();
  try {
    const decision = evaluateFailedFlipSuppression(
      policyInput(fix, 'head_regression', { interruptionCause: 'signal:SIGTERM' }),
    );
    assert.equal(decision.action, 'suppress');
    assert.equal(decision.evidence, 'signal_committed');
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('C3: committed ticket WITHOUT signal cause does NOT fire signal_committed (arm is signal-gated)', () => {
  const fix = makeSignalCommittedFixture();
  try {
    // No interruptionCause and no state.exit_reason: signal arm inert. Garbage
    // sha is not verified-commit evidence, artifacts stale → no_evidence.
    const decision = evaluateFailedFlipSuppression(
      policyInput(fix, 'head_regression', { interruptionCause: null }),
    );
    assert.deepEqual(decision, { action: 'proceed', reason: 'no_evidence' });
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('C3: interruptionCause defaults to state.exit_reason (signal) when input absent', () => {
  const fix = makeSignalCommittedFixture();
  try {
    // Stamp exit_reason: 'signal' (the signal handler's stamp) and omit the
    // explicit input — the arm must read it from recoverable state.
    const s = readState(fix.statePath);
    s.exit_reason = 'signal';
    writeFileSync(fix.statePath, JSON.stringify(s));
    const input = policyInput(fix, 'wmw_auto_skip');
    delete input.interruptionCause;
    const decision = evaluateFailedFlipSuppression(input);
    assert.deepEqual(decision, { action: 'suppress', evidence: 'signal_committed', suppressionCount: 1 });
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('C3: real verified-sha evidence takes precedence over signal_committed (ticket_commit label)', () => {
  const fix = makeFixture();
  try {
    ageArtifacts(fix.ticketDir);
    const sha = commitWork(fix);
    const fm = `---\nid: ${TICKET}\nstatus: "Done"\norder: 1\ncompletion_commit: "${sha}"\n---\n# T\n`;
    writeFileSync(path.join(fix.ticketDir, `rick_ticket_${TICKET}.md`), fm);
    // Even with a signal cause, a verified sha resolves the descriptive label to
    // ticket_commit (the stronger, git-resolved arm wins the OR-combine).
    const decision = evaluateFailedFlipSuppression(
      policyInput(fix, 'head_regression', { preSha: sha, interruptionCause: 'signal' }),
    );
    assert.deepEqual(decision, { action: 'suppress', evidence: 'ticket_commit', suppressionCount: 1 });
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

test('C3/git-utils invariant: genuine evidence-absent flip still clears completion_commit_inferred — AC3', () => {
  // No signal (exit_reason absent), HEAD == startCommit, stale artifacts, and a
  // STALE completion_commit_inferred that does NOT resolve to a real commit →
  // evidence absent → marked_failed. The flip must clear completion_commit_inferred.
  const fix = makeFixture({
    ticketFrontmatter: `---\nid: ${TICKET}\nstatus: "Done"\norder: 1\ncompletion_commit_inferred: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"\n---\n# T\n`,
  });
  try {
    ageArtifacts(fix.ticketDir);
    const result = detectAndRecoverHeadRegression({
      ticketId: TICKET,
      workingDir: fix.workingDir,
      startCommit: fix.baseSha, // HEAD == startCommit
      completionCommitSha: null,
      sessionDir: fix.sessionDir,
      statePath: fix.statePath,
      iteration: 4,
      log: () => {},
    });
    assert.equal(result.action, 'marked_failed', 'no signal + no real commit → genuine evidence-absent flip');
    const raw = readFileSync(path.join(fix.ticketDir, `rick_ticket_${TICKET}.md`), 'utf-8');
    assert.match(raw, /status: "Failed"/);
    // git-utils invariant: status:Failed + completion_commit:null clears inferred.
    assert.doesNotMatch(
      raw,
      /completion_commit_inferred:\s*["']?deadbeef/,
      'stale completion_commit_inferred must be cleared on a genuine evidence-absent flip',
    );
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});

// ─── Contract: no new state.json top-level field ─────────────────────────────

test('suppression writes only recovery_attempts + activity — no new state.json top-level field', async () => {
  const fix = makeFixture();
  try {
    // Normalize the baseline through StateManager first so schema-default
    // fields (archaeology, tickets_version, ...) are not misattributed to the
    // suppression write.
    const { StateManager } = await import('../services/state-manager.js');
    new StateManager().update(fix.statePath, () => { /* no-op normalize */ });
    const before = new Set(Object.keys(readState(fix.statePath)));

    const decision = evaluateFailedFlipSuppression(policyInput(fix, 'wmw_auto_skip'));
    assert.equal(decision.action, 'suppress');

    const after = readState(fix.statePath);
    for (const key of Object.keys(after)) {
      assert.ok(before.has(key), `unexpected new state.json top-level field: ${key}`);
    }
    assert.ok(!('failed_tickets' in after) && !('blocked_tickets' in after) && !('skipped_tickets' in after));
    assert.equal(ledgerOf(fix.statePath).length, 1, 'suppression persisted in recovery_attempts');
    assert.equal(eventsOf(fix.statePath, 'failed_flip_suppressed').length, 1, 'event persisted in activity');
  } finally { rmSync(fix.tmp, { recursive: true, force: true }); }
});
