// @tier: integration
// B-PCOMP (#b736337f) — at phase exit, commitGatePassingDeliverableOnExitPath must
// commit ONLY paths positively attributable to the exiting ticket. Any dirty
// gate-green remainder that is NOT positively attributable (a lagging sibling
// ticket's work, OR everything when the ownership probe throws) is STASHED to a
// self-describing ref refs/pickle/salvage/<session> via `git stash create` +
// `git update-ref` — never committed-as-Done under the exiting ticket, never a
// state.json write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  commitGatePassingDeliverableOnExitPath,
  stashUnattributableRemainder,
} from '../bin/mux-runner.js';

function makeTmp(prefix = 'pcomp-stash-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension', 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
}

function writeTicket(sessionDir, ticketId, status, order = 1) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = ['---', `id: "${ticketId}"`, `status: "${status}"`, `order: ${order}`, '---', '# Body'].join('\n');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), fm);
}

function porcelain(dir) {
  return execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
}

const passGate = () => ({ ok: true, failures: [], timed_out: false, timeout_ms: 0 });

function baseInput(sessionDir, workingDir, ticketId, runGate) {
  return {
    sessionDir,
    statePath: path.join(sessionDir, 'state.json'),
    workingDir,
    ticketId,
    extensionRoot: path.join(workingDir, 'extension'),
    flags: null,
    log: () => {},
    runGate,
  };
}

const cleanup = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

const N = 'aaaa1111';
const NPLUS1 = 'bbbb2222';

test('AC-1/AC-2/AC-3: forced fatal on ticket N with N+1 dirty green work → N+1 stashed to ref, N commit excludes N+1, no state write', () => {
  // sessionDir lives INSIDE the repo so a sibling ticket dir shows up in the dirty set.
  const workingDir = makeTmp('pcomp-stash-nplus1-');
  initGitRepo(workingDir);
  const sessionDir = path.join(workingDir, 'sessiondata');
  const session = path.basename(sessionDir);
  const ref = `refs/pickle/salvage/${session}`;
  try {
    writeTicket(sessionDir, N, 'In Progress', 1);
    writeTicket(sessionDir, NPLUS1, 'In Progress', 2);
    // Commit the baseline ticket files so they are NOT dirty.
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'baseline tickets', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });

    // N's OWNED deliverable (source file — attributable to the exiting ticket).
    fs.writeFileSync(path.join(workingDir, 'extension', 'owned-by-N.txt'), 'N shipped work\n');
    // N+1's FOREIGN green work (under the sibling ticket's session dir).
    fs.writeFileSync(path.join(sessionDir, NPLUS1, 'plan_nplus1.md'), 'N+1 bystander work\n');
    assert.notEqual(porcelain(workingDir), '', 'precondition: tree dirty (owned + foreign)');

    // state.json byte snapshot (AC-3: schema_neutral — no state write for the stash pointer).
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ schema_version: 5 }));
    const stateBefore = fs.readFileSync(statePath);

    const result = commitGatePassingDeliverableOnExitPath(baseInput(sessionDir, workingDir, N, passGate));

    assert.equal(result.committed, true, `expected N committed, got reason=${result.reason}`);

    // AC-1: N+1's diff is recoverable at the salvage ref.
    const refDiff = execFileSync('git', ['show', '--name-only', '--pretty=format:', ref], { cwd: workingDir, encoding: 'utf8' });
    assert.match(refDiff, /plan_nplus1\.md/, 'N+1 diff must be recoverable at refs/pickle/salvage/<session>');

    // AC-2: the exiting ticket's commit does NOT contain N+1's files.
    const committedFiles = execFileSync('git', ['show', '--name-only', '--pretty=format:', 'HEAD'], { cwd: workingDir, encoding: 'utf8' });
    assert.match(committedFiles, /owned-by-N\.txt/, "N's commit must contain its own owned work");
    assert.doesNotMatch(committedFiles, /plan_nplus1\.md/, "N's commit must NOT contain N+1's bystander files (no false Done)");

    // AC-3: no state.json write for the stash pointer.
    assert.deepEqual(fs.readFileSync(statePath), stateBefore, 'state.json must be byte-identical (schema_neutral)');
  } finally {
    cleanup(workingDir);
  }
});

test('AC-4: probe-error fallback — stashUnattributableRemainder snapshots the WHOLE dirty remainder to the ref without mutating the worktree or state', () => {
  // The git-probe-error branch calls stashUnattributableRemainder(workingDir, sessionDir, log)
  // then returns clean-ticket-tree (no whole-tree commit). Cover the helper directly:
  // it is the load-bearing primitive both fallbacks share.
  const workingDir = makeTmp('pcomp-stash-probe-err-');
  initGitRepo(workingDir);
  const sessionDir = path.join(workingDir, 'sessiondata');
  fs.mkdirSync(sessionDir, { recursive: true });
  const session = path.basename(sessionDir);
  const ref = `refs/pickle/salvage/${session}`;
  try {
    fs.writeFileSync(path.join(workingDir, 'extension', 'unattributable.txt'), 'probe-failed remainder\n');
    const beforePorcelain = porcelain(workingDir);
    assert.notEqual(beforePorcelain, '', 'precondition: tree dirty');

    const retRef = stashUnattributableRemainder(workingDir, sessionDir, () => {});
    assert.equal(retRef, ref, 'helper returns the salvage ref name');
    // Worktree is UNCHANGED — `git stash create` does not mutate the worktree.
    assert.equal(porcelain(workingDir), beforePorcelain, 'stash create must not mutate the worktree (no whole-tree add)');
    const refDiff = execFileSync('git', ['show', '--name-only', '--pretty=format:', ref], { cwd: workingDir, encoding: 'utf8' });
    assert.match(refDiff, /unattributable\.txt/, 'remainder recoverable at the salvage ref');
  } finally {
    cleanup(workingDir);
  }
});

test('stashUnattributableRemainder is a no-op (returns null) on a clean tree', () => {
  const workingDir = makeTmp('pcomp-stash-clean-');
  initGitRepo(workingDir);
  const sessionDir = path.join(workingDir, 'sessiondata');
  fs.mkdirSync(sessionDir, { recursive: true });
  try {
    assert.equal(porcelain(workingDir), '', 'precondition: clean tree');
    const ret = stashUnattributableRemainder(workingDir, sessionDir, () => {});
    assert.equal(ret, null, 'clean tree → nothing to stash');
  } finally {
    cleanup(workingDir);
  }
});
