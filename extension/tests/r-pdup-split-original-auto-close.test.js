// @tier: integration
/**
 * INV-NO-PHANTOM-REBUILD (R-PDUP)
 *
 * A split original (Todo/Failed ticket whose children carry a -i/-ii roman-
 * numeral suffix) must be auto-closed with the twin's EXPLICIT completion_commit
 * once ALL twins are Done — and must be HELD when only some twins are Done.
 *
 * Each test that needs readEvidence to return non-absent (i.e. 'explicit')
 * creates a minimal git repo so that SHA reachability probing works.
 *
 * Invariants asserted:
 *   1. Auto-closed: a Todo/Failed ticket whose BOTH twins are Done and have
 *      reachable completion_commit SHAs is auto-closed with an EXPLICIT
 *      completion_commit = twin's SHA, and is NOT re-run by the roster.
 *   2. EXPLICIT: the written field is `completion_commit:` (never _inferred).
 *   3. HELD: only -i Done but not -ii → original NOT closed.
 *   4. No twins found → original NOT touched.
 *   5. Done original with explicit SHA → untouched by auto-close path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { correctPhantomDoneTickets } from '../bin/mux-runner.js';
import { readFrontmatterField } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmp(prefix = 'r-pdup-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Init a bare git repo and return the first commit SHA. */
function initGitRepo(dir) {
  const opts = { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  const result = execFileSync(
    'git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'],
    { cwd: dir, encoding: 'utf8' },
  );
  void result;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();
  return sha;
}

/**
 * Write a ticket file into the session dir.
 * `order` defaults to 1. `extra` is an object of additional frontmatter fields.
 */
function writeTicket(sessionDir, ticketId, { status, title, order = 1, completion_commit, completion_commit_inferred } = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = ['---'];
  lines.push(`id: "${ticketId}"`);
  if (title !== undefined) lines.push(`title: "${title}"`);
  if (status !== undefined) lines.push(`status: "${status}"`);
  lines.push(`order: ${order}`);
  if (completion_commit !== undefined) lines.push(`completion_commit: "${completion_commit}"`);
  if (completion_commit_inferred !== undefined) lines.push(`completion_commit_inferred: "${completion_commit_inferred}"`);
  lines.push('---', '# Body');
  const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
  fs.writeFileSync(ticketPath, lines.join('\n'));
  return ticketPath;
}

function readTicketContent(sessionDir, ticketId) {
  const ticketPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
  return fs.readFileSync(ticketPath, 'utf8');
}

// ---------------------------------------------------------------------------
// Test 1: INV-NO-PHANTOM-REBUILD — both twins Done → original auto-closed
// ---------------------------------------------------------------------------
test('R-PDUP: Todo split original with both twins Done → auto-closed with EXPLICIT completion_commit', () => {
  const root = makeTmp();
  try {
    // Create a real git repo so readEvidence can verify the SHA via git probe.
    const deliveringSha = initGitRepo(root);

    // Session lives as a subdirectory so ticket dirs don't pollute the git root.
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    // Twin -i: Done with an explicit completion_commit pointing at the real commit.
    const twinIId = 'aa000001';
    writeTicket(sessionDir, twinIId, {
      status: 'Done',
      title: 'R-FOO-1-i',
      order: 10,
      completion_commit: deliveringSha,
    });

    // Twin -ii: Done with the same SHA (both point at the single git commit).
    const twinIIId = 'aa000002';
    writeTicket(sessionDir, twinIIId, {
      status: 'Done',
      title: 'R-FOO-1-ii',
      order: 11,
      completion_commit: deliveringSha,
    });

    // Original: Todo at sentinel order 996.
    const origId = 'aa000000';
    writeTicket(sessionDir, origId, {
      status: 'Todo',
      title: 'R-FOO-1',
      order: 996,
    });

    const logs = [];
    const count = correctPhantomDoneTickets({
      sessionDir,
      workingDir: root,
      startCommit: null,
      iteration: 1,
      log: (m) => logs.push(m),
    });

    // At least the original was auto-closed.
    assert.ok(count >= 1, `expected at least 1 auto-close, got ${count}`);

    const content = readTicketContent(sessionDir, origId);
    const status = readFrontmatterField(content, 'status');
    assert.equal(status, 'Done', `expected status=Done after auto-close, got '${status}'`);

    // EXPLICIT completion_commit written (never _inferred).
    const cc = readFrontmatterField(content, 'completion_commit');
    assert.ok(cc, 'expected completion_commit to be set on auto-closed original');
    assert.equal(cc, deliveringSha,
      `expected completion_commit=${deliveringSha} (twin -i's SHA), got '${cc}'`);

    // Must NOT have written _inferred.
    const inferred = readFrontmatterField(content, 'completion_commit_inferred');
    assert.ok(!inferred, `expected completion_commit_inferred absent, got '${inferred}'`);

    // Log line must mention R-PDUP auto-close.
    const autoCloseLog = logs.find(l => l.includes('R-PDUP') && l.includes('auto-closed'));
    assert.ok(autoCloseLog, `expected an R-PDUP auto-close log line; got: ${JSON.stringify(logs)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: Failed split original → same auto-close behavior
// ---------------------------------------------------------------------------
test('R-PDUP: Failed split original with both twins Done → auto-closed', () => {
  const root = makeTmp();
  try {
    const sha = initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    writeTicket(sessionDir, 'bb000001', {
      status: 'Done', title: 'R-BAR-2-i', order: 10, completion_commit: sha,
    });
    writeTicket(sessionDir, 'bb000002', {
      status: 'Done', title: 'R-BAR-2-ii', order: 11, completion_commit: sha,
    });
    const origId = 'bb000000';
    writeTicket(sessionDir, origId, {
      status: 'Failed', title: 'R-BAR-2', order: 997,
    });

    const count = correctPhantomDoneTickets({
      sessionDir,
      workingDir: root,
      startCommit: null,
      iteration: 1,
    });

    assert.ok(count >= 1, `expected at least 1 auto-close for Failed original, got ${count}`);

    const content = readTicketContent(sessionDir, origId);
    const status = readFrontmatterField(content, 'status');
    assert.equal(status, 'Done', `expected status=Done for auto-closed Failed original, got '${status}'`);

    const cc = readFrontmatterField(content, 'completion_commit');
    assert.ok(cc, 'expected completion_commit set on auto-closed Failed original');
    assert.equal(cc, sha, `expected completion_commit=${sha}, got '${cc}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: HELD — only -i Done, -ii not Done → original NOT closed
// ---------------------------------------------------------------------------
test('R-PDUP: Todo split original with only -i Done (not -ii) → HELD, original unchanged', () => {
  const root = makeTmp();
  try {
    const sha = initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    // Twin -i: Done.
    writeTicket(sessionDir, 'cc000001', {
      status: 'Done', title: 'R-BAZ-3-i', order: 10, completion_commit: sha,
    });
    // Twin -ii: NOT Done (still Todo) → original must be held.
    writeTicket(sessionDir, 'cc000002', {
      status: 'Todo', title: 'R-BAZ-3-ii', order: 11,
    });
    // Original: Todo at sentinel order.
    const origId = 'cc000000';
    writeTicket(sessionDir, origId, {
      status: 'Todo', title: 'R-BAZ-3', order: 998,
    });

    const logs = [];
    correctPhantomDoneTickets({
      sessionDir,
      workingDir: root,
      startCommit: null,
      iteration: 1,
      log: (m) => logs.push(m),
    });

    const content = readTicketContent(sessionDir, origId);
    const status = readFrontmatterField(content, 'status');
    assert.equal(status, 'Todo',
      `expected original to remain Todo (held) when -ii not Done, got '${status}'`);

    const cc = readFrontmatterField(content, 'completion_commit');
    assert.ok(!cc, `expected no completion_commit on held original, got '${cc}'`);

    // Log should mention the hold reason.
    const holdLog = logs.find(l => l.includes('R-PDUP') && l.includes('holding'));
    assert.ok(holdLog, `expected a holding log line; got: ${JSON.stringify(logs)}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4: No twins → not a split original, nothing changes
// ---------------------------------------------------------------------------
test('R-PDUP: Todo ticket with no -i/-ii twins → not touched (not a split original)', () => {
  const root = makeTmp();
  try {
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    const origId = 'dd000000';
    writeTicket(sessionDir, origId, {
      status: 'Todo', title: 'R-QUX-4', order: 1,
    });

    const count = correctPhantomDoneTickets({
      sessionDir,
      workingDir: root,
      startCommit: null,
      iteration: 1,
    });

    // count could be 0 (the lone Todo ticket must not be counted as corrected).
    const content = readTicketContent(sessionDir, origId);
    const status = readFrontmatterField(content, 'status');
    assert.equal(status, 'Todo', 'lone Todo ticket with no twins must remain Todo');
    assert.equal(count, 0, `expected 0 corrections for lone Todo ticket, got ${count}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 5: Done original with explicit SHA → NOT re-touched by auto-close
// ---------------------------------------------------------------------------
test('R-PDUP: Done original already has completion_commit → auto-close does not overwrite', () => {
  const root = makeTmp();
  try {
    const sha = initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    writeTicket(sessionDir, 'ee000001', {
      status: 'Done', title: 'R-QUUX-5-i', order: 10, completion_commit: sha,
    });
    writeTicket(sessionDir, 'ee000002', {
      status: 'Done', title: 'R-QUUX-5-ii', order: 11, completion_commit: sha,
    });
    const origId = 'ee000000';
    // Original already Done with the SAME sha — persistEvidence returns 'already_present'
    // and writeTicketStatus is never called by the auto-close path (not Todo/Failed).
    writeTicket(sessionDir, origId, {
      status: 'Done', title: 'R-QUUX-5', order: 999, completion_commit: sha,
    });

    correctPhantomDoneTickets({
      sessionDir,
      workingDir: root,
      startCommit: null,
      iteration: 1,
    });

    const content = readTicketContent(sessionDir, origId);
    const cc = readFrontmatterField(content, 'completion_commit');
    // The auto-close path only runs for Todo/Failed tickets; a Done original with
    // an explicit SHA goes through the existing phantom-revert path. Either way
    // the completion_commit must remain set (not cleared).
    assert.ok(cc, 'completion_commit must remain set on Done original with explicit SHA');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 6: PRODUCTION-SHAPED commits — twin commits tagged `fix(<twinId>): ...`
// must NOT trip the R-OMA foreign-attribution check on the auto-close path.
// The borrowed twin sha's message word-boundary-names the TWIN (a sibling dir
// of the original); the sanctioned twin-borrow injects the twin ids as own-
// attribution tokens so the guard accepts the evidence and the original closes.
// (Regression: with untagged fixture commits this bug was invisible — the
// guard refused every production-tagged twin sha and the original stayed Todo
// forever, re-entering the phantom-rebuild class R-PDUP exists to prevent.)
// ---------------------------------------------------------------------------
test('R-PDUP: twin commits tagged fix(<twinId>) → original still auto-closes (R-OMA twin-borrow sanctioned)', () => {
  const root = makeTmp();
  const prevTestMode = process.env.PICKLE_TEST_MODE;
  // The guard's PICKLE_TEST_MODE bypass would mask the R-OMA path — force it off.
  delete process.env.PICKLE_TEST_MODE;
  try {
    initGitRepo(root);
    const gitOpts = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };

    // Per-twin delivering commits using the PRODUCTION commit-message
    // convention: the message names the TWIN's ticket id, never the original's.
    fs.writeFileSync(path.join(root, 'part-i.txt'), 'split part i\n');
    execFileSync('git', ['add', 'part-i.txt'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'fix(ff000001): implement split part i', '--no-gpg-sign'], { cwd: root });
    const shaI = execFileSync('git', ['rev-parse', 'HEAD'], gitOpts).trim();

    fs.writeFileSync(path.join(root, 'part-ii.txt'), 'split part ii\n');
    execFileSync('git', ['add', 'part-ii.txt'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'fix(ff000002): implement split part ii', '--no-gpg-sign'], { cwd: root });
    const shaII = execFileSync('git', ['rev-parse', 'HEAD'], gitOpts).trim();

    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    writeTicket(sessionDir, 'ff000001', {
      status: 'Done', title: 'R-PROD-6-i', order: 10, completion_commit: shaI,
    });
    writeTicket(sessionDir, 'ff000002', {
      status: 'Done', title: 'R-PROD-6-ii', order: 11, completion_commit: shaII,
    });
    const origId = 'ff000000';
    writeTicket(sessionDir, origId, {
      status: 'Todo', title: 'R-PROD-6', order: 996,
    });

    const logs = [];
    const count = correctPhantomDoneTickets({
      sessionDir,
      workingDir: root,
      startCommit: null,
      iteration: 1,
      log: (m) => logs.push(m),
    });

    const content = readTicketContent(sessionDir, origId);
    const status = readFrontmatterField(content, 'status');
    assert.equal(status, 'Done',
      `expected production-tagged split original to auto-close (status=Done), got '${status}'; logs: ${JSON.stringify(logs)}`);
    assert.ok(count >= 1, `expected at least 1 auto-close, got ${count}`);

    // Canonical sha is a twin's delivering commit (first-found twin is stable).
    const cc = readFrontmatterField(content, 'completion_commit');
    assert.ok([shaI, shaII].includes(cc),
      `expected completion_commit to be a twin sha (${shaI} or ${shaII}), got '${cc}'`);

    // The guard must NOT have refused with the R-OMA foreign-attribution reason.
    const refusal = logs.find(l => l.includes('auto-close guard refused'));
    assert.ok(!refusal, `guard refused the sanctioned twin-borrow: ${refusal}`);

    const autoCloseLog = logs.find(l => l.includes('R-PDUP') && l.includes('auto-closed'));
    assert.ok(autoCloseLog, `expected an R-PDUP auto-close log line; got: ${JSON.stringify(logs)}`);
  } finally {
    if (prevTestMode === undefined) delete process.env.PICKLE_TEST_MODE;
    else process.env.PICKLE_TEST_MODE = prevTestMode;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
