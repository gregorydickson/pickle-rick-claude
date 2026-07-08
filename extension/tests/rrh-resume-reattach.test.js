// @tier: fast
//
// B-RRH C5 (a3f87133): `setup.js --resume` self-heals an orphaned ticket commit.
//
// When a worker committed real work then the commit was orphaned before resume
// (spurious Failed-flip + HEAD reset), the ticket frontmatter still names the
// orphaned commit in `completion_commit`. On resume, if that commit ff-descends
// from HEAD, reuse the H1 reattach logic to `merge --ff-only` it and mark the
// ticket Done. A NON-ancestor commit is left untouched (no force reattach / reset
// / cherry-pick).
//
// Both tests drive the COMPILED setup.js via a real CLI invocation against a real
// temp git repo, sandboxing PICKLE_DATA_ROOT to a temp dir per the test-isolation
// contract (audit-test-isolation.sh + feedback_orphaned_own_commit_ff_recovery).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP = path.resolve(__dirname, '../bin/setup.js');

function tmpRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initRepo(dir) {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

function commit(dir, message) {
  fs.writeFileSync(path.join(dir, `f-${Date.now()}-${Math.random()}.txt`), message);
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '--no-gpg-sign', '-q', '-m', message], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

function headSha(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

function resetHard(dir, sha) {
  execFileSync('git', ['reset', '--hard', sha], { cwd: dir, stdio: 'ignore' });
}

// Bootstrap a paused session from a NEUTRAL cwd (setup writes a TASK_NOTES.md
// breadcrumb under cwd/.pickle-rick — keep that out of the repo tree so it can
// not dirty the ff-only reattach), then repoint state.working_dir at the repo.
// In production the session dir lives under the data root, never inside the repo.
function bootstrapPausedSession(dataRoot, repoDir) {
  const neutralCwd = tmpRoot('pickle-rrh-c5-cwd-');
  const out = execFileSync(process.execPath, [SETUP, '--paused', '--task', 'rrh-c5'], {
    cwd: neutralCwd,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
  });
  const match = out.match(/SESSION_ROOT=(.+)/);
  if (!match) throw new Error(`SESSION_ROOT not found in setup output:\n${out}`);
  const sessionRoot = match[1].trim();
  const statePath = path.join(sessionRoot, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  state.working_dir = repoDir;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return sessionRoot;
}

// Hand-write a ticket dir + frontmatter and point state.current_ticket at it.
function injectTicket(sessionRoot, ticketId, { status, completionCommit }) {
  const ticketDir = path.join(sessionRoot, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const ccLine = completionCommit ? `completion_commit: "${completionCommit}"\n` : '';
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\ntitle: RRH C5 ticket ${ticketId}\nstatus: "${status}"\norder: 1\n${ccLine}---\n\n# Test\n`,
  );
  const statePath = path.join(sessionRoot, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  state.current_ticket = ticketId;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function readTicketStatus(sessionRoot, ticketId) {
  const content = fs.readFileSync(
    path.join(sessionRoot, ticketId, `rick_ticket_${ticketId}.md`),
    'utf-8',
  );
  const m = content.match(/^status:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

function resume(sessionRoot, dataRoot) {
  return execFileSync(process.execPath, [SETUP, '--resume', sessionRoot, '--paused', '--task', ''], {
    cwd: sessionRoot,
    encoding: 'utf-8',
    env: { ...process.env, FORCE_COLOR: '0', PICKLE_DATA_ROOT: dataRoot },
  });
}

// ── Test 1: orphaned ff-descendant commit → reattached + marked Done ─────────
test('rrh-resume-reattach: orphaned ff-descendant commit is reattached and ticket marked Done on --resume', () => {
  const dataRoot = tmpRoot('pickle-rrh-c5-data-');
  const repoDir = tmpRoot('pickle-rrh-c5-repo-');
  try {
    initRepo(repoDir);
    const baseline = commit(repoDir, 'baseline');
    // Worker committed real ticket work on top of baseline (this is the orphan).
    const orphanSha = commit(repoDir, 'feat: ticket work (orphaned by spurious reset)');
    // Spurious Failed-flip + reset orphaned the commit: HEAD rewound to baseline.
    resetHard(repoDir, baseline);
    assert.equal(headSha(repoDir), baseline, 'precondition: HEAD reset below the orphan');

    const sessionRoot = bootstrapPausedSession(dataRoot, repoDir);
    injectTicket(sessionRoot, 'aaa11111', { status: 'Failed', completionCommit: orphanSha });

    resume(sessionRoot, dataRoot);

    assert.equal(headSha(repoDir), orphanSha, 'resume must ff-only reattach HEAD to the orphaned commit');
    assert.equal(
      (readTicketStatus(sessionRoot, 'aaa11111') || '').toLowerCase(),
      'done',
      'resume must mark the reattached ticket Done',
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

// ── Test 2: non-ancestor commit → left untouched (SAFETY) ────────────────────
test('rrh-resume-reattach: a non-ancestor completion_commit is NOT reattached and ticket stays not-Done', () => {
  const dataRoot = tmpRoot('pickle-rrh-c5-data-');
  const repoDir = tmpRoot('pickle-rrh-c5-repo-');
  try {
    initRepo(repoDir);
    const baseline = commit(repoDir, 'baseline');
    // An earlier commit that is an ANCESTOR of HEAD (not a descendant).
    const olderSha = commit(repoDir, 'older work');
    // HEAD advances past olderSha — HEAD is now AHEAD of olderSha, so olderSha is
    // NOT a descendant of HEAD. `merge-base --is-ancestor HEAD olderSha` fails.
    const newHead = commit(repoDir, 'newer work (HEAD ahead of stamped sha)');
    assert.equal(headSha(repoDir), newHead, 'precondition: HEAD ahead of the stamped sha');
    void baseline;

    const sessionRoot = bootstrapPausedSession(dataRoot, repoDir);
    injectTicket(sessionRoot, 'bbb22222', { status: 'Failed', completionCommit: olderSha });

    resume(sessionRoot, dataRoot);

    assert.equal(headSha(repoDir), newHead, 'resume must leave HEAD unchanged for a non-descendant sha');
    assert.notEqual(
      (readTicketStatus(sessionRoot, 'bbb22222') || '').toLowerCase(),
      'done',
      'non-ancestor commit must NOT flip the ticket to Done',
    );
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
