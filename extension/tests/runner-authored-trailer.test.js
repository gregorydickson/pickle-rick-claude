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
for (const k of Object.keys(process.env)) {
  if (k.startsWith('GIT_CONFIG')) {
    delete process.env[k];
  }
}
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

/**
 * Land `message` as a commit VERBATIM. `-F -` is the only form that round-trips a rendered
 * message byte-for-byte: `-m` would re-wrap and re-paragraph it, which is precisely the
 * trailer-block structure these fixtures exist to observe.
 */
function commitMessage(dir, message) {
  fs.writeFileSync(path.join(dir, 'edit.txt'), 'x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-gpg-sign', '-F', '-'], message);
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

  commitMessage(workingDir, stamped);

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

    commitMessage(workingDir, stamped);

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

  commitMessage(workingDir, stamped);

  assert.equal(parsedTrailer(workingDir, 'Pickle-Ticket'), TICKET_ID);
});

// The degraded arm: when `interpret-trailers` cannot run, the stamp appends the trailer as its own
// paragraph rather than dropping attribution. Without a test the fallback could be reduced to
// `rendered ?? message` and nothing would go red — every other case here reaches a real repo, so
// the writer always succeeds and the arm is never taken.
//
// A non-existent `workingDir` makes `spawnSync` set `r.error`, so `silentDeathGit` returns null for
// BOTH the `--parse` probe and the writer. Reading the appended line back through
// `%(trailers:…)` — after landing it in a real repo — is the load-bearing assertion: a fallback
// that emitted the text in a shape git does not parse as a trailer would satisfy a string check
// and still leave the commit unattributable, which is the whole failure this function exists to
// prevent.
test('degraded arm: when interpret-trailers cannot run, the appended trailer is still PARSED', () => {
  const missingDir = path.join(makeTmp('ratrail-missing-'), 'no-such-subdir');
  assert.equal(fs.existsSync(missingDir), false, 'precondition: git cannot run here');
  const body = 'fix: work authored while git trailer support is unavailable\n';

  const stamped = stampPickleTicketTrailer(missingDir, body, TICKET_ID);

  assert.notEqual(stamped, body, 'the degraded arm must still stamp, not drop attribution');

  const workingDir = makeTmp('ratrail-repo-');
  initGitRepo(workingDir);
  commitMessage(workingDir, stamped);

  assert.equal(parsedTrailer(workingDir, 'Pickle-Ticket'), TICKET_ID);
  assert.match(
    git(workingDir, ['log', '-1', '--format=%s']).trim(),
    /work authored while git trailer support is unavailable/,
    'the subject survives the append',
  );
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

// --- Idempotence: the producer must never manufacture a multi-value trailer -------------------
//
// `--if-exists addIfDifferentNeighbor` tests ADJACENCY, not value. When a pre-existing
// `Pickle-Ticket` trailer is separated from the appended one by another key, git adds a SECOND
// value — even when the two values are identical. The consumer reads that shape as NO attribution
// at all: `parseTrailerLog` joins every emitted value line into one `trailerValue`, and
// `scanGitLogByTrailer` compares it whole. The producer's key-presence guard is what keeps the
// shape from existing, matching the two sibling producers (`git-trailer-hooks.ts`'s parsed-view
// grep and spawn-morty's `maybeAmendTicketTrailer`).

/** A message whose trailer block already carries the key, NOT adjacent to the append point. */
function nonNeighborTrailerMessage(ticketId) {
  return [
    'fix: work that already carries its own attribution',
    '',
    `Pickle-Ticket: ${ticketId}`,
    'Co-Authored-By: Someone <someone@example.com>',
    '',
  ].join('\n');
}

/** Every parsed `Pickle-Ticket` value on HEAD, one per array entry. */
function parsedTrailerValues(dir) {
  return parsedTrailer(dir, 'Pickle-Ticket').split('\n').filter(Boolean);
}

test('idempotence: stamping a message that already carries the trailer leaves exactly one value', () => {
  const workingDir = makeTmp('ratrail-repo-');
  initGitRepo(workingDir);
  const body = nonNeighborTrailerMessage(TICKET_ID);

  const stamped = stampPickleTicketTrailer(workingDir, body, TICKET_ID);

  assert.equal(stamped, body, 'an already-attributed message comes back untouched');

  commitMessage(workingDir, stamped);

  assert.deepEqual(parsedTrailerValues(workingDir), [TICKET_ID]);
  assert.equal(
    parsedTrailer(workingDir, 'Co-Authored-By'),
    'Someone <someone@example.com>',
    'the neighbouring trailer stays a PARSED trailer, not demoted to body prose',
  );
});

test('idempotence: the consumer still attributes the re-stamped commit', async () => {
  const { readEvidence } = await import('../services/ticket-completion-evidence.js');

  const workingDir = makeTmp('ratrail-repo-');
  const startCommit = initGitRepo(workingDir);
  const { sessionDir } = makeSession(workingDir, startCommit);

  commitMessage(workingDir, stampPickleTicketTrailer(workingDir, nonNeighborTrailerMessage(TICKET_ID), TICKET_ID));
  const sha = git(workingDir, ['rev-parse', 'HEAD']).trim();

  const evidence = readEvidence({ sessionDir, ticketId: TICKET_ID, workingDir, startCommit, pinnedSha: startCommit });

  assert.equal(evidence.kind, 'committed');
  assert.equal(evidence.sha, sha);
});

// Negative control. Without the guard the producer would have emitted THIS shape, and this is what
// the consumer does with it. Pinning the failure keeps the guard load-bearing: if someone deletes it
// AND independently teaches the consumer to read multi-value trailers, this test goes red and says so
// — rather than the two changes silently cancelling out and leaving the seam untested.
test('negative control: a two-value trailer is unreadable to the consumer', async () => {
  const { readEvidence } = await import('../services/ticket-completion-evidence.js');

  const workingDir = makeTmp('ratrail-repo-');
  const startCommit = initGitRepo(workingDir);
  const { sessionDir } = makeSession(workingDir, startCommit);

  // The pre-guard producer, reproduced verbatim: the writer call with no key-presence check.
  const duplicated = git(
    workingDir,
    ['interpret-trailers', '--if-exists', 'addIfDifferentNeighbor', '--trailer', `Pickle-Ticket: ${TICKET_ID}`],
    nonNeighborTrailerMessage(TICKET_ID),
  );
  commitMessage(workingDir, duplicated);

  assert.deepEqual(
    parsedTrailerValues(workingDir),
    [TICKET_ID, TICKET_ID],
    'the unguarded writer duplicates the value it was asked to ensure',
  );

  const evidence = readEvidence({ sessionDir, ticketId: TICKET_ID, workingDir, startCommit, pinnedSha: startCommit });

  assert.equal(evidence.kind, 'absent', 'carrying the trailer twice reads as carrying it zero times');
});
