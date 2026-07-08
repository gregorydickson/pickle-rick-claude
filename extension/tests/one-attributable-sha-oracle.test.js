// @tier: integration
// B-RASO (AC-1/AC-1c/AC-1d/AC-3/AC-6) — ONE attributable-frontmatter-SHA oracle.
// The silent-death salvage detector (detectSilentDeathAttributableWork, via
// applySilentDeathRecoveryPolicy) and the Failed-flip suppression detector
// (hasTicketScopedCommitEvidence, via evaluateFailedFlipSuppression) MUST resolve
// a ticket's frontmatter completion sha through the SAME unexported helper
// `resolveAttributableFrontmatterSha` — a `git cat-file`-VERIFIED probe. No
// format-only twin survives: a garbage/unreachable sha is evidence at NEITHER
// detector; a real sha is evidence at BOTH; quoted and unquoted forms verify
// identically; a bad first field never suppresses a good second field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { applySilentDeathRecoveryPolicy, evaluateFailedFlipSuppression, checkPartialLifecycleExit } =
  await import('../bin/mux-runner.js');

const TICKET = 'raso1234';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 15000 }).trim();
}

function initRepo(dir) {
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'raso@test.local'], dir);
  git(['config', 'user.name', 'raso'], dir);
  writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  git(['add', 'base.txt'], dir);
  git(['commit', '-q', '-m', 'base', '--no-gpg-sign'], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

/** Session dir with an APPROVED research phase + an empty worker log (→ log_empty silent-death). */
function makeFix(frontmatter, workingDir) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-raso-'));
  const sessionDir = path.join(tmp, 'session');
  const ticketDir = path.join(sessionDir, TICKET);
  mkdirSync(ticketDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      active: true, schema_version: 5, working_dir: workingDir, step: 'implement',
      iteration: 3, max_iterations: 50, worker_timeout_seconds: 600,
      start_time_epoch: Math.floor(Date.now() / 1000), original_prompt: 'raso oracle test',
      session_dir: sessionDir, started_at: new Date().toISOString(), history: [],
      tmux_mode: false, backend: 'claude', activity: [], recovery_attempts: [],
      worker_artifact_progress: {},
    }),
  );
  writeFileSync(path.join(ticketDir, 'research_2026-07-07.md'), 'research body');
  writeFileSync(path.join(ticketDir, 'research_review.md'), '# review\n\nAPPROVED');
  writeFileSync(path.join(ticketDir, `rick_ticket_${TICKET}.md`), frontmatter);
  writeFileSync(path.join(ticketDir, 'worker_session_12321.log'), '');
  return { tmp, sessionDir, statePath, ticketDir };
}

const fm = (fields) => `---\nid: ${TICKET}\nstatus: "In Progress"\ncomplexity_tier: medium\n${fields}\n---\n# T\n`;

/**
 * The silent-death SHA arm, isolated. Future iterationStartMs → the fresh-artifact
 * arm cannot fire; no preIterSha → the scoped-commit arm cannot fire; a no-op
 * archive stub isolates the frontmatter-SHA decision. Returns true iff the SHA
 * arm attributed work (`hold` with evidence `completion_commit`).
 */
function silentDeathAttributes(fix, workingDir) {
  const cls = checkPartialLifecycleExit(fix.sessionDir, fix.statePath, TICKET);
  assert.equal(cls.subClass, 'log_empty', 'fixture must classify log_empty');
  const decision = applySilentDeathRecoveryPolicy({
    sessionDir: fix.sessionDir, statePath: fix.statePath, ticketId: TICKET, workingDir,
    iteration: 3, classification: cls, iterationStartMs: Date.now() + 60_000,
    archive: () => { /* isolate the SHA arm from the dirty-tree archive step */ },
    settings: { silent_death_respawn_cap: 1 }, log: () => {},
  });
  return decision.action === 'hold' && decision.evidence === 'completion_commit';
}

/**
 * The Failed-flip SHA arm, isolated. No windowStartMs → artifact arm inert; no
 * preSha → window-commit arm inert; non-signal interruptionCause → signal arm
 * inert. Returns true iff the SHA arm attributed work (`suppress` with evidence
 * `ticket_commit`).
 */
function failedFlipAttributes(fix, workingDir) {
  const decision = evaluateFailedFlipSuppression({
    sessionDir: fix.sessionDir, statePath: fix.statePath, ticketId: TICKET, workingDir,
    iteration: 3, callsite: 'worker_gate_fail', interruptionCause: 'timeout',
    settings: { failed_flip_suppression_cap: 2 }, log: () => {},
  });
  return decision.action === 'suppress' && decision.evidence === 'ticket_commit';
}

test('AC-1: both format-only twins are gone; exactly ONE cat-file-verified frontmatter-SHA helper remains', () => {
  const src = execFileSync('cat', [path.resolve(import.meta.dirname, '../src/bin/mux-runner.ts')], { encoding: 'utf8' });
  assert.equal((src.match(/hasFrontmatterCompletionSha/g) || []).length, 0, 'format-only twin deleted');
  assert.equal((src.match(/hasVerifiedFrontmatterCompletionSha/g) || []).length, 0, 'verified-boolean twin deleted');
  assert.equal((src.match(/function resolveAttributableFrontmatterSha\(/g) || []).length, 1, 'exactly one shared helper declared');
  // The ONLY frontmatter-SHA cat-file probe lives inside the single helper.
  assert.equal((src.match(/silentDeathGit\(\['cat-file', '-t'/g) || []).length, 1, 'exactly one frontmatter-SHA cat-file probe');
});

test('AC-3: an unresolvable frontmatter sha is evidence at NEITHER detector (SHA-arm parity)', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'pickle-raso-repo-'));
  initRepo(repo);
  const garbage = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'; // valid shape, absent object
  const fix = makeFix(fm(`completion_commit: ${garbage}`), repo);
  try {
    assert.equal(silentDeathAttributes(fix, repo), false, 'silent-death SHA arm rejects the garbage sha');
    assert.equal(failedFlipAttributes(fix, repo), false, 'Failed-flip SHA arm rejects the SAME garbage sha');
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('AC-3 (positive parity): a git-resolvable frontmatter sha is evidence at BOTH detectors', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'pickle-raso-repo-'));
  const realSha = initRepo(repo);
  const fix = makeFix(fm(`completion_commit: ${realSha}`), repo);
  try {
    assert.equal(silentDeathAttributes(fix, repo), true, 'silent-death SHA arm accepts the real sha');
    assert.equal(failedFlipAttributes(fix, repo), true, 'Failed-flip SHA arm accepts the SAME real sha');
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('AC-1c: both-field continue — a bad completion_commit does NOT suppress a good completion_commit_inferred', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'pickle-raso-repo-'));
  const realSha = initRepo(repo);
  // First field: shape-valid but UNRESOLVABLE (the cat-file miss must fall through
  // to the second field, not short-circuit the helper).
  const fix = makeFix(fm(`completion_commit: cafebabecafebabecafebabecafebabecafebabe\ncompletion_commit_inferred: ${realSha}`), repo);
  try {
    assert.equal(silentDeathAttributes(fix, repo), true, 'good inferred field resolves at silent-death detector');
    assert.equal(failedFlipAttributes(fix, repo), true, 'good inferred field resolves at Failed-flip detector');
  } finally {
    rmSync(fix.tmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('AC-1d: R-CCQF normalization — quoted full sha and unquoted short sha verify identically', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'pickle-raso-repo-'));
  const realSha = initRepo(repo);
  const quotedFull = makeFix(fm(`completion_commit: "${realSha}"`), repo);
  const unquotedShort = makeFix(fm(`completion_commit: ${realSha.slice(0, 10)}`), repo);
  try {
    assert.equal(silentDeathAttributes(quotedFull, repo), true, 'quoted full sha verifies (silent-death)');
    assert.equal(silentDeathAttributes(unquotedShort, repo), true, 'unquoted short sha verifies (silent-death)');
    assert.equal(failedFlipAttributes(quotedFull, repo), true, 'quoted full sha verifies (Failed-flip)');
    assert.equal(failedFlipAttributes(unquotedShort, repo), true, 'unquoted short sha verifies (Failed-flip)');
  } finally {
    rmSync(quotedFull.tmp, { recursive: true, force: true });
    rmSync(unquotedShort.tmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
