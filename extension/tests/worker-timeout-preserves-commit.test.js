// @tier: fast
// R-WDTF-TO WS-1: persistWorkerOutcomeStatus's non-success path must never
// null a real, git-attributable window commit. It now probes the worker
// window (windowShas -> pickAttributionCommit, via reconcileWorkerCommitAttribution)
// for a verified ticket-scoped sha instead of writing `completion_commit: null`.
// All ctx fixtures below are SYNTHESIZED with `mutableState.timedOut: true` —
// no wall-clock waiting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateWorkerOutcome,
  resolveFailurePathCommitSha,
  persistWorkerOutcomeStatus,
} from '../bin/spawn-morty.js';

const TICKET_ID = '4404d032';
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    timeout: 8000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function commitFile(repoDir, name, body, msg) {
  fs.writeFileSync(path.join(repoDir, name), body);
  git(repoDir, ['add', '--', name]);
  git(repoDir, ['commit', '-m', msg, '--no-gpg-sign']);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function makeTmpGitRepo(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'morty@example.com']);
  git(dir, ['config', 'user.name', 'Morty']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function makeTicketDir(prefix, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  return dir;
}

// Synthesized timedOut:true ctx — the only sub-second lever documented on
// the ticket (tier_cap_override) is for real worker spawns, not this unit;
// mutableState.timedOut is set directly instead of wall-clock waiting.
function makeCtx({ ticketPath, sessionWorkingDir, preWorkerHead, ticketFilePath = null }) {
  return {
    args: { isReviewTicket: false, ticketFilePath },
    prompt: '',
    ticketPath,
    ticketId: TICKET_ID,
    sessionRoot: '/tmp/does-not-matter',
    sessionLog: null,
    sessionLogPath: '/tmp/does-not-matter.log',
    sessionWorkingDir,
    timeoutStatePath: null,
    workerStatePath: '/tmp/does-not-matter-state.json',
    effectiveTimeoutMs: 60000,
    mutableState: { finalized: false, timedOut: true },
    preWorkerHead,
  };
}

function writeTicketFile(dir, ticketId, extraFrontmatter = '') {
  const file = path.join(dir, `rick_ticket_${ticketId}.md`);
  fs.writeFileSync(
    file,
    `---\nid: ${ticketId}\nstatus: In Progress\ncomplexity_tier: medium\norder: 1\n${extraFrontmatter}---\n# ${ticketId}\n`,
  );
  return file;
}

function readField(body, key) {
  return body.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim()?.replace(/^["']|["']$/g, '');
}

test('AC-WDTFTO-1-1: timed-out worker WITH a window commit preserves the sha (Failed, not null)', () => {
  const sessionWorkingDir = makeTmpGitRepo('wdtf-to-preserve-repo-');
  const ticketPath = makeTicketDir('wdtf-to-preserve-ticket-', ['research_x.md', 'plan_x.md']);
  try {
    const base = commitFile(sessionWorkingDir, 'base.txt', 'base\n', 'base commit');
    const windowSha = commitFile(sessionWorkingDir, 'work.txt', 'worker output before timeout\n', `feat(${TICKET_ID}): partial work`);

    const ctx = makeCtx({ ticketPath, sessionWorkingDir, preWorkerHead: base });
    const { isSuccess } = evaluateWorkerOutcome({ ctx, logContent: 'x'.repeat(300), startTime: Date.now() - 5000 });
    assert.equal(isSuccess, false, 'a timed-out worker is never success, regardless of everything else');

    const sha = resolveFailurePathCommitSha(ctx);
    assert.match(sha ?? '', FULL_SHA_RE, 'a verified window sha is returned');
    assert.equal(sha, windowSha);

    const ticketFile = writeTicketFile(ticketPath, TICKET_ID);
    persistWorkerOutcomeStatus({
      ticketId: TICKET_ID,
      sessionRoot: ticketPath,
      sessionWorkingDir,
      isSuccess: false,
      flipSuppressed: false,
      completionCommitSha: sha,
    });

    const body = fs.readFileSync(ticketFile, 'utf-8');
    assert.equal(readField(body, 'status'), 'Failed');
    assert.equal(readField(body, 'completion_commit'), windowSha, 'completion_commit preserves the window sha — never null');
  } finally {
    fs.rmSync(sessionWorkingDir, { recursive: true, force: true });
    fs.rmSync(ticketPath, { recursive: true, force: true });
  }
});

test('AC-WDTFTO-1-2: timed-out worker with NO commit leaves completion_commit untouched (no invented sha)', () => {
  const sessionWorkingDir = makeTmpGitRepo('wdtf-to-nocommit-repo-');
  const ticketPath = makeTicketDir('wdtf-to-nocommit-ticket-', ['research_x.md']);
  try {
    const base = commitFile(sessionWorkingDir, 'base.txt', 'base\n', 'base commit');
    // No further commits — HEAD === preWorkerHead, so the window is empty.

    const ctx = makeCtx({ ticketPath, sessionWorkingDir, preWorkerHead: base });
    const { isSuccess } = evaluateWorkerOutcome({ ctx, logContent: 'x'.repeat(300), startTime: Date.now() - 5000 });
    assert.equal(isSuccess, false);

    const sha = resolveFailurePathCommitSha(ctx);
    assert.equal(sha, null, 'no window commit exists — never invent a sha');

    // Ticket already carries a prior completion_commit stamp (e.g. from an
    // earlier iteration) to prove the "untouched" contract — the new write
    // must not clear a pre-existing field it has no evidence to touch.
    const priorSha = 'abc1234abc1234abc1234abc1234abc1234abcd';
    const ticketFile = writeTicketFile(ticketPath, TICKET_ID, `completion_commit: ${priorSha}\n`);
    persistWorkerOutcomeStatus({
      ticketId: TICKET_ID,
      sessionRoot: ticketPath,
      sessionWorkingDir,
      isSuccess: false,
      flipSuppressed: false,
      completionCommitSha: sha,
    });

    const body = fs.readFileSync(ticketFile, 'utf-8');
    assert.equal(readField(body, 'status'), 'Failed');
    assert.equal(readField(body, 'completion_commit'), priorSha, 'completion_commit is left UNTOUCHED, never nulled');
  } finally {
    fs.rmSync(sessionWorkingDir, { recursive: true, force: true });
    fs.rmSync(ticketPath, { recursive: true, force: true });
  }
});

test('AC-WDTFTO-1-3: the Failed ticket stays selectable (frontmatter status is neither done nor skipped)', () => {
  const sessionWorkingDir = makeTmpGitRepo('wdtf-to-selectable-repo-');
  const ticketPath = makeTicketDir('wdtf-to-selectable-ticket-', ['research_x.md']);
  try {
    const base = commitFile(sessionWorkingDir, 'base.txt', 'base\n', 'base commit');
    const windowSha = commitFile(sessionWorkingDir, 'work.txt', 'worker output\n', `feat(${TICKET_ID}): partial`);

    const ctx = makeCtx({ ticketPath, sessionWorkingDir, preWorkerHead: base });
    evaluateWorkerOutcome({ ctx, logContent: 'x'.repeat(300), startTime: Date.now() - 5000 });
    const sha = resolveFailurePathCommitSha(ctx);
    assert.equal(sha, windowSha);

    const ticketFile = writeTicketFile(ticketPath, TICKET_ID);
    persistWorkerOutcomeStatus({
      ticketId: TICKET_ID,
      sessionRoot: ticketPath,
      sessionWorkingDir,
      isSuccess: false,
      flipSuppressed: false,
      completionCommitSha: sha,
    });

    // isPendingMuxTicket's entire runnability predicate is
    // `status !== 'done' && status !== 'skipped'` over the frontmatter
    // status — mirrored here since the function is not exported.
    const status = readField(fs.readFileSync(ticketFile, 'utf-8'), 'status')?.toLowerCase();
    assert.equal(status, 'failed');
    assert.notEqual(status, 'done');
    assert.notEqual(status, 'skipped');
  } finally {
    fs.rmSync(sessionWorkingDir, { recursive: true, force: true });
    fs.rmSync(ticketPath, { recursive: true, force: true });
  }
});

test('resolveFailurePathCommitSha: git probe failure (non-repo workingDir) returns null, never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdtf-to-nonrepo-'));
  try {
    const ctx = makeCtx({
      ticketPath: dir,
      sessionWorkingDir: dir,
      preWorkerHead: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    assert.equal(resolveFailurePathCommitSha(ctx), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('persistWorkerOutcomeStatus: flipSuppressed keeps the prior status and never writes completion_commit', () => {
  const sessionWorkingDir = makeTmpGitRepo('wdtf-to-suppressed-repo-');
  const ticketPath = makeTicketDir('wdtf-to-suppressed-ticket-', []);
  try {
    const ticketFile = writeTicketFile(ticketPath, TICKET_ID);
    persistWorkerOutcomeStatus({
      ticketId: TICKET_ID,
      sessionRoot: ticketPath,
      sessionWorkingDir,
      isSuccess: false,
      flipSuppressed: true,
      completionCommitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });

    const body = fs.readFileSync(ticketFile, 'utf-8');
    assert.equal(readField(body, 'status'), 'In Progress', 'a suppressed flip must not touch status');
    assert.equal(readField(body, 'completion_commit'), undefined, 'a suppressed flip must not write completion_commit');
  } finally {
    fs.rmSync(sessionWorkingDir, { recursive: true, force: true });
    fs.rmSync(ticketPath, { recursive: true, force: true });
  }
});
