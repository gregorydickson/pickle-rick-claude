// @tier: integration
// B-RATRAIL WS-A — the two commits the runner authors IN-PROCESS under a ticket id must
// carry a parsed `Pickle-Ticket` trailer. `readEvidence`'s only git-log arm is
// `scanGitLogByTrailer`, an exact match against git's PARSED trailer view
// (`%(trailers:key=Pickle-Ticket,valueonly)`) — a ticket id in the SUBJECT is exactly the
// signal B-GITATTR WS-3 deleted, so an unstamped runner commit is unattributable and
// `commitAndContinueDoneFlip`'s own guard refuses the Done flip over a commit that landed.
//
// Every assertion here reads the PARSED view. A `%B` substring grep cannot see trailer
// demotion (an appended line opens a new paragraph; the text is still in `%B`, but
// `%(trailers:…)` — the reader the runtime uses — no longer sees the pre-existing keys).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A deployed `prepare-commit-msg` trailer hook inherited through the worker's env would
// stamp ITS ticket id into these fixtures' commits. Drop the wiring so the fixtures observe
// only what the code under test writes.
delete process.env.PICKLE_TICKET_ID;
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_CONFIG')) delete process.env[k];
// PICKLE_TEST_MODE=1 is deliberately NOT set: it short-circuits
// `guardCompletionCommitBeforeDone` to `{ok:true, sha:'pickle-test-mode-bypass'}`, which
// would green these fixtures without ever consulting the trailer. The fixtures use real
// temp git repos, so the production guard runs against real evidence.
delete process.env.PICKLE_TEST_MODE;

const { commitAndContinueDoneFlip, executeConvergedPlanAdapter, stampPickleTicketTrailer } =
  await import('../bin/mux-runner.js');

// Deliberately NOT this ticket's own id: a hook or scanner contaminating the fixture would
// stamp a different value, and equality against this one would fail rather than false-green.
const TICKET_ID = 'a1b2c3d4';

function makeTmp(prefix = 'ratrail-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(dir, args, input) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
  });
}

function initGitRepo(dir) {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'initial', '--no-gpg-sign']);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

/** git's PARSED trailer view for `key` on HEAD — never a `%B` substring. */
function parsedTrailer(dir, key) {
  return git(dir, ['log', '-1', `--format=%(trailers:key=${key},valueonly)`]).trim();
}

/** A session dir with one In Progress ticket plus the state.json the guard reads. */
function makeSession(workingDir, startCommit) {
  const sessionDir = makeTmp('ratrail-session-');
  const ticketDir = path.join(sessionDir, TICKET_ID);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${TICKET_ID}.md`),
    [
      '---',
      `id: "${TICKET_ID}"`,
      'title: "fixture"',
      'status: "In Progress"',
      'complexity_tier: small',
      'order: 1',
      `working_dir: ${workingDir}`,
      '---',
      '# Body',
      '',
    ].join('\n'),
  );
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      session_dir: sessionDir,
      working_dir: workingDir,
      active: true,
      start_commit: startCommit,
      pinned_sha: startCommit,
      start_time_epoch: Math.floor(Date.now() / 1000) - 600,
      current_ticket: TICKET_ID,
      activity: [],
    }),
  );
  return { sessionDir, ticketDir, statePath };
}

function site1Input(sessionDir, statePath, workingDir) {
  return { sessionDir, statePath, workingDir, ticketId: TICKET_ID, flags: null, log: () => {} };
}

test('site 1: commitAndContinueDoneFlip stamps a parsed Pickle-Ticket trailer', () => {
  const workingDir = makeTmp('ratrail-repo-');
  const startCommit = initGitRepo(workingDir);
  const { sessionDir, statePath } = makeSession(workingDir, startCommit);
  fs.writeFileSync(path.join(workingDir, 'worker-edit.txt'), 'deliverable\n');

  const result = commitAndContinueDoneFlip(site1Input(sessionDir, statePath, workingDir));

  assert.notEqual(git(workingDir, ['rev-parse', 'HEAD']).trim(), startCommit, 'a commit must have landed');
  assert.equal(parsedTrailer(workingDir, 'Pickle-Ticket'), TICKET_ID);
  assert.equal(result.ok, true, 'the commit is attributable, so the guard must not refuse');
});

test('site 1: the completion guard is now satisfiable — evidence is committed, not absent', () => {
  const workingDir = makeTmp('ratrail-repo-');
  const startCommit = initGitRepo(workingDir);
  const { sessionDir, ticketDir, statePath } = makeSession(workingDir, startCommit);
  fs.writeFileSync(path.join(workingDir, 'worker-edit.txt'), 'deliverable\n');

  const result = commitAndContinueDoneFlip(site1Input(sessionDir, statePath, workingDir));

  assert.equal(result.ok, true);
  assert.ok(result.sha, 'the guard resolved a completion sha from the trailer scan');
  const head = git(workingDir, ['rev-parse', 'HEAD']).trim();
  assert.ok(head.startsWith(result.sha) || result.sha.startsWith(head), `sha ${result.sha} vs HEAD ${head}`);

  const ticket = fs.readFileSync(path.join(ticketDir, `rick_ticket_${TICKET_ID}.md`), 'utf8');
  assert.match(ticket, /status:\s*"?Done"?/i, 'the Done flip completes');
  assert.match(ticket, /completion_commit:/, 'and stamps its completion_commit');
});

test('a pre-existing Co-Authored-By trailer survives the stamp as a PARSED trailer', () => {
  const workingDir = makeTmp('ratrail-repo-');
  initGitRepo(workingDir);
  const coAuthor = 'Co-Authored-By: Someone Else <someone@example.com>';

  const stamped = stampPickleTicketTrailer(
    workingDir,
    `fix(${TICKET_ID}): a message that already carries a trailer\n\n${coAuthor}\n`,
    TICKET_ID,
  );

  fs.writeFileSync(path.join(workingDir, 'edit.txt'), 'x\n');
  git(workingDir, ['add', '-A']);
  git(workingDir, ['commit', '-q', '--no-gpg-sign', '-F', '-'], stamped);

  assert.equal(parsedTrailer(workingDir, 'Pickle-Ticket'), TICKET_ID);
  assert.equal(
    parsedTrailer(workingDir, 'Co-Authored-By'),
    'Someone Else <someone@example.com>',
    'the stamp must not demote a pre-existing trailer to body prose',
  );
});

// An empty or whitespace-only ticket id must write NO trailer line at all. Both arms of the
// stamp would otherwise emit a valueless `Pickle-Ticket:` — `interpret-trailers` emits the bare
// key for `--trailer 'Pickle-Ticket: '`, and the degraded append does the same by construction.
// The hook producer already no-ops on this shape (`git-trailer-hooks.ts` `_pickle_ticket_id_probe`,
// whose comment records the valueless line as a shipped defect); the runner-authored sites must
// agree.
//
// The `%B` assertion is the load-bearing one. `%(trailers:key=…,valueonly)` reports an EMPTY
// string for a valueless `Pickle-Ticket:` line, so a parsed-view check alone reads identically
// before and after the guard — it cannot fail. The raw-body check is what goes RED on a revert.
for (const [label, blankId] of [['an empty', ''], ['a whitespace-only', '   ']]) {
  test(`${label} ticket id writes NO valueless Pickle-Ticket line`, () => {
    const workingDir = makeTmp('ratrail-repo-');
    initGitRepo(workingDir);
    const body = 'fix: a message authored with no resolvable ticket id\n';

    const stamped = stampPickleTicketTrailer(workingDir, body, blankId);

    assert.equal(stamped, body, 'the guard is a no-op on the message, not a rewrite of it');

    fs.writeFileSync(path.join(workingDir, 'edit.txt'), 'x\n');
    git(workingDir, ['add', '-A']);
    git(workingDir, ['commit', '-q', '--no-gpg-sign', '-F', '-'], stamped);

    const raw = git(workingDir, ['log', '-1', '--format=%B']);
    assert.doesNotMatch(raw, /^Pickle-Ticket:/m, 'no valueless trailer line may reach history');
    assert.equal(parsedTrailer(workingDir, 'Pickle-Ticket'), '');
    assert.match(raw, /a message authored with no resolvable ticket id/, 'the body survives');
  });
}

test('the blank-id guard is narrow — a real ticket id still stamps', () => {
  const workingDir = makeTmp('ratrail-repo-');
  initGitRepo(workingDir);

  const stamped = stampPickleTicketTrailer(workingDir, 'fix: real work\n', TICKET_ID);

  fs.writeFileSync(path.join(workingDir, 'edit.txt'), 'x\n');
  git(workingDir, ['add', '-A']);
  git(workingDir, ['commit', '-q', '--no-gpg-sign', '-F', '-'], stamped);

  assert.equal(parsedTrailer(workingDir, 'Pickle-Ticket'), TICKET_ID);
});

test('site 2: executeConvergedPlanAdapter phase commits stamp the trailer', () => {
  const workingDir = makeTmp('ratrail-repo-');
  const startCommit = initGitRepo(workingDir);
  const { sessionDir, ticketDir, statePath } = makeSession(workingDir, startCommit);
  fs.writeFileSync(
    path.join(ticketDir, 'plan_2026-08-09.md'),
    ['# Plan', '', '## Phase 1 — stamped phase', '', '**Verify:** `true`', ''].join('\n'),
  );
  fs.writeFileSync(path.join(workingDir, 'phase-edit.txt'), 'phase work\n');

  const result = executeConvergedPlanAdapter({
    sessionDir,
    statePath,
    workingDir,
    ticketId: TICKET_ID,
    log: () => {},
  });

  assert.equal(result.ok, true);
  assert.notEqual(git(workingDir, ['rev-parse', 'HEAD']).trim(), startCommit, 'the phase commit must have landed');
  assert.match(git(workingDir, ['log', '-1', '--format=%s']).trim(), /execute-converged-plan phase 1/);
  assert.equal(parsedTrailer(workingDir, 'Pickle-Ticket'), TICKET_ID);
});
