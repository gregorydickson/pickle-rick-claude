// @tier: integration
/**
 * orphan-chain-reattach.chaos.test.js — real-SIGKILL orphan-chain reattach (ticket e56ed23f).
 *
 * A real worker child commits a 2-commit chain into a tmp git repo, signals readiness, then hangs. The
 * parent simulates the gate-fail `git reset --hard` that ORPHANS the chain AND SIGKILLs the worker
 * mid-flight, then drives the SHIPPED `detectAndRecoverHeadRegression`:
 *
 *   - reattach variant: the orphan chain is a fast-forward of the regressed HEAD → recovery rediscovers it
 *     (explicit frontmatter sha → fsck), walks to the chain TIP, and `git merge --ff-only` lands HEAD at
 *     the tip (HEAD == tip, chain_length == 2, `orphan_commit_reattached`). Pure reattach, never a reset.
 *   - divergent variant: the orphan lives on a sibling line (not a fast-forward of HEAD) → recovery HOLDS:
 *     zero HEAD mutation, no history rewrite, ticket NOT flipped Failed, `orphan_commit_unreattachable`.
 *
 * Determinism: the kill is gated on a readiness token, never on a timer; the orphaning reset runs in the
 * parent AFTER the child's commits are durable. Tests only — escalate bugs, do NOT fix recovery here.
 *
 * Flake protocol: this file is serialized (`subprocess-timeout-coupling`) and runs at
 * `--test-concurrency=1` via tests/integration/.serial-tests.json. A failure observed only under a
 * c=8 parallel run is a load artifact — re-run at `--test-concurrency=4`, which is AUTHORITATIVE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { detectAndRecoverHeadRegression } from '../../../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_PATH = path.resolve(__dirname, '../../../bin/mux-runner.js');
const GIT_TIMEOUT = 30_000; // >= 30000: hang-guard on every git spawn.

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: GIT_TIMEOUT }).trim();
}

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-chaos-orphan-')));
}

function initGitRepo(repoDir) {
  git(['init', '--quiet'], repoDir);
  git(['config', 'user.email', 'chaos@test.local'], repoDir);
  git(['config', 'user.name', 'Chaos'], repoDir);
}

function gitCommit(repoDir, message) {
  fs.writeFileSync(path.join(repoDir, `seed-${message.replace(/\W+/g, '_')}.txt`), message);
  git(['add', '-A'], repoDir);
  git(['commit', '--no-gpg-sign', '-m', message], repoDir);
  return git(['rev-parse', 'HEAD'], repoDir);
}

function headSha(repoDir) {
  return git(['rev-parse', 'HEAD'], repoDir);
}

function objCount(repoDir) {
  return Number(git(['rev-list', '--all', '--count'], repoDir));
}

function makeTicketFile(sessionDir, ticketId, status, completionCommit) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const frontmatter = [
    '---',
    `id: ${ticketId}`,
    'title: Chaos ticket',
    `status: "${status}"`,
    completionCommit ? `completion_commit: ${completionCommit}` : '',
    '---',
    '# Test',
  ].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), frontmatter);
}

function makeStatePath(sessionDir) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ active: true, schema_version: 5, iteration: 1, recovery_attempts: [], activity: [] }));
  return statePath;
}

function setup() {
  const tmp = tmpRoot();
  const repoDir = path.join(tmp, 'repo');
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  initGitRepo(repoDir);
  return { tmp, repoDir, sessionDir };
}

// Child worker: makes `n` commits on the CURRENT branch of repoDir, prints each SHA, signals readiness,
// then hangs. The parent controls which branch is checked out before spawn, so commits land deterministically.
const COMMIT_CHAIN_CHILD = `
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const repoDir = process.argv[1];
  const n = Number(process.argv[2]);
  const g = (args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf-8', timeout: 30000 }).trim();
  for (let i = 1; i <= n; i++) {
    fs.writeFileSync(path.join(repoDir, 'work-' + i + '.txt'), 'worker commit ' + i);
    g(['add', '-A']);
    g(['commit', '--no-gpg-sign', '-m', 'test: worker chain commit ' + i]);
    process.stdout.write('SHA:' + g(['rev-parse', 'HEAD']) + '\\n');
  }
  process.stdout.write('COMMITTED\\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
`;

function spawnCommitChainChild(repoDir, n) {
  // timeout >= 30000: hang-guard only — the child is SIGKILLed well before this fires.
  return spawn(process.execPath, ['--input-type=module', '-e', COMMIT_CHAIN_CHILD, repoDir, String(n)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

/** Resolve with the printed SHA list once the COMMITTED token is seen; reject on early exit. */
function waitForCommits(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const cleanup = () => {
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onErr);
    };
    const onData = (d) => {
      buf += d.toString();
      if (buf.includes('COMMITTED')) {
        cleanup();
        resolve(buf.split('\n').filter((l) => l.startsWith('SHA:')).map((l) => l.slice('SHA:'.length).trim()));
      }
    };
    const onExit = (code) => { cleanup(); reject(new Error(`commit-chain child exited (code ${code}) before COMMITTED`)); };
    const onErr = (err) => { cleanup(); reject(err); };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onErr);
  });
}

async function killAndReap(child) {
  child.kill('SIGKILL');
  await once(child, 'exit');
}

test('2-commit chain orphaned by reset + worker SIGKILLed → ff-only reattach, HEAD == tip, chain_length 2', { timeout: 60_000 }, async () => {
  const { tmp, repoDir, sessionDir } = setup();
  let child;
  try {
    const startCommit = gitCommit(repoDir, 'baseline');

    // Worker commits a 2-commit chain onto HEAD, then hangs.
    child = spawnCommitChainChild(repoDir, 2);
    const [commit1, commit2] = await waitForCommits(child);
    assert.equal(headSha(repoDir), commit2, 'worker advanced HEAD to the chain tip before the kill');

    // Simulated gate-fail reset ORPHANS the durable chain, THEN the worker is SIGKILLed mid-flight.
    git(['reset', '--hard', startCommit], repoDir);
    await killAndReap(child);
    child = null;
    assert.equal(headSha(repoDir), startCommit, 'HEAD regressed to baseline (orphan dangling)');

    const ticketId = 'chaos-reattach-1';
    makeTicketFile(sessionDir, ticketId, 'Done', commit1); // frontmatter points at the INTERIOR commit
    const statePath = makeStatePath(sessionDir);

    const result = detectAndRecoverHeadRegression({
      ticketId,
      workingDir: repoDir,
      startCommit,
      completionCommitSha: commit1,
      sessionDir,
      statePath,
      iteration: 1,
      iterationStartMs: Date.now() - 5000,
      log: () => {},
    });

    assert.equal(result.detected, true);
    assert.equal(result.recovered, true);
    assert.equal(result.action, 'ff_reattached');
    assert.equal(headSha(repoDir), commit2, 'HEAD must land at the chain TIP, not the interior commit');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const event = (state.activity || []).find((e) => e.event === 'orphan_commit_reattached');
    assert.ok(event, 'orphan_commit_reattached must be emitted');
    assert.equal(event.sha, commit2, 'event.sha is the chain tip');
    assert.equal(event.chain_length, 2, 'two orphaned commits → chain_length 2');
    assert.equal(event.prev_head, startCommit, 'prev_head is the regressed HEAD');
    assert.ok(event.ts, 'ts present');
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('divergent orphan (sibling line) + worker SIGKILLed → zero mutation, held, orphan_commit_unreattachable', { timeout: 60_000 }, async () => {
  const { tmp, repoDir, sessionDir } = setup();
  let child;
  try {
    const root = gitCommit(repoDir, 'root');
    const mainBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);

    // Parent parks HEAD on a sibling line off root; the worker commits the divergent orphan there.
    git(['checkout', '-q', '-b', 'orphanline', root], repoDir);
    child = spawnCommitChainChild(repoDir, 1);
    const [orphanCommit] = await waitForCommits(child);

    // Back to main, advance to a sibling baseline, drop the branch so the orphan dangles but is NOT a
    // fast-forward of HEAD; THEN SIGKILL the still-hung worker.
    git(['checkout', '-q', mainBranch], repoDir);
    const startCommit = gitCommit(repoDir, 'baseline sibling of orphan');
    git(['branch', '-q', '-D', 'orphanline'], repoDir);
    await killAndReap(child);
    child = null;

    assert.equal(headSha(repoDir), startCommit, 'HEAD at the regression baseline');
    const headBefore = headSha(repoDir);
    const objBefore = objCount(repoDir);

    const ticketId = 'chaos-diverge-1';
    makeTicketFile(sessionDir, ticketId, 'Done', orphanCommit);
    const statePath = makeStatePath(sessionDir);

    const result = detectAndRecoverHeadRegression({
      ticketId,
      workingDir: repoDir,
      startCommit,
      completionCommitSha: orphanCommit,
      sessionDir,
      statePath,
      iteration: 1,
      iterationStartMs: Date.now() - 5000,
      log: () => {},
    });

    assert.equal(result.detected, true);
    assert.equal(result.recovered, false, 'a divergent orphan cannot ff-only reattach');
    // Zero-mutation invariant.
    assert.equal(headSha(repoDir), headBefore, 'HEAD must not move on divergence');
    assert.ok(objCount(repoDir) >= objBefore, 'history must not be rewritten on divergence');
    assert.ok(
      result.action === 'flip_suppressed' || result.action === 'suppression_cap_escalate',
      `real orphan commit = evidence → hold variant, got: ${result.action}`,
    );
    const ticketRaw = fs.readFileSync(path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`), 'utf-8');
    assert.ok(!ticketRaw.includes('status: "Failed"'), 'hold path must not flip the ticket Failed');

    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const event = (state.activity || []).find((e) => e.event === 'orphan_commit_unreattachable');
    assert.ok(event, 'orphan_commit_unreattachable must be emitted on divergence');
    assert.equal(event.sha, orphanCommit);
    assert.ok(event.ts, 'ts present');
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch { /* already dead */ } }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Reference MUX_PATH so a path typo surfaces as an explicit failure, not a silent skip.
test('fixture: compiled mux-runner module resolves', { timeout: 60_000 }, () => {
  assert.ok(fs.existsSync(fileURLToPath(pathToFileURL(MUX_PATH))), `mux-runner.js must exist at ${MUX_PATH}`);
});
