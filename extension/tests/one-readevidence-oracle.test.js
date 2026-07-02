// @tier: integration
// B-DURA T30 (AC-DURA-6) — ONE readEvidence oracle. The phantom-Done watcher
// (gateForPhantomDoneRevert) and the Done-flip gate (guardCompletionCommitBeforeDone)
// MUST return the SAME verdict for the SAME frontmatter — no accept-here-fatal-there
// split (R-PFNT). A present, git-reachable completion_commit reads `committed`
// (kept/ok) at BOTH; a present-but-unreachable SHA reads `absent` (revert/refuse)
// at BOTH; a completion_commit equal to the session baseline reads `absent` at BOTH
// (R-CXOR-2 parity, the residual split T30 closes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { guardCompletionCommitBeforeDone } from '../bin/mux-runner.js';
import { gateForPhantomDoneRevert } from '../services/ticket-completion-evidence.js';

function mkTmp(prefix = 'dura-t30-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
}

function head(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, status, completionCommit) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = [
    '---',
    `id: "${ticketId}"`,
    `title: "Test ${ticketId}"`,
    `status: "${status}"`,
    'order: 1',
    ...(completionCommit ? [`completion_commit: "${completionCommit}"`] : []),
    '---',
    '# Body',
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), fm);
}

const cleanup = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

const T = 'aaaa1111';

// The watcher's verdict, projected onto a {committed|absent} axis.
function watcherVerdict(sessionDir, ticketId, workingDir, startCommit, pinnedSha) {
  const decision = gateForPhantomDoneRevert(
    { sessionDir, ticketId, workingDir, startCommit, pinnedSha },
    { flags: null },
  );
  // keep → committed; revert → absent.
  return decision.action === 'revert' ? 'absent' : 'committed';
}

// The gate's verdict, projected onto the same axis.
function gateVerdict(sessionDir, ticketId, workingDir) {
  const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId, workingDir, flags: null, rereadBackoffMs: 0 });
  return guard.ok ? 'committed' : 'absent';
}

test('AC-DURA-6: present + git-reachable completion_commit reads `committed` at BOTH watcher and gate', () => {
  const workingDir = mkTmp('dura-t30-reach-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t30-reach-sess-');
  try {
    // A real, reachable commit.
    fs.writeFileSync(path.join(workingDir, 'x.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'real work', '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
    const realSha = head(workingDir);
    writeTicket(sessionDir, T, 'Done', realSha);
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ schema_version: 5, activity: [] }));

    const w = watcherVerdict(sessionDir, T, workingDir, null, null);
    const g = gateVerdict(sessionDir, T, workingDir);
    assert.equal(w, 'committed', 'watcher must read committed for a present+reachable completion_commit');
    assert.equal(g, 'committed', 'gate must read committed for a present+reachable completion_commit');
    assert.equal(w, g, 'watcher verdict ≡ gate verdict (no accept-vs-fatal split)');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

test('AC-DURA-6 absent agreement: present-but-unreachable completion_commit reads `absent` at BOTH', () => {
  const workingDir = mkTmp('dura-t30-unreach-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t30-unreach-sess-');
  try {
    // A SHA that does not exist in this repo.
    writeTicket(sessionDir, T, 'Done', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ schema_version: 5, activity: [] }));

    const w = watcherVerdict(sessionDir, T, workingDir, null, null);
    const g = gateVerdict(sessionDir, T, workingDir);
    assert.equal(w, 'absent', 'watcher must read absent for an unreachable completion_commit');
    assert.equal(g, 'absent', 'gate must read absent for an unreachable completion_commit');
    assert.equal(w, g, 'watcher verdict ≡ gate verdict (no split)');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

test('AC-DURA-6 baseline parity: completion_commit === start_commit reads `absent` at BOTH (R-CXOR-2 parity, residual split closed)', () => {
  const workingDir = mkTmp('dura-t30-base-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t30-base-sess-');
  try {
    const baseline = head(workingDir); // session start_commit
    // Ticket "completed" at the session baseline — did no real work.
    writeTicket(sessionDir, T, 'Done', baseline);
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ schema_version: 5, activity: [], start_commit: baseline, pinned_sha: baseline }),
    );

    // Watcher now sources the same baseline SHAs the gate does (T30 wiring).
    const w = watcherVerdict(sessionDir, T, workingDir, baseline, baseline);
    const g = gateVerdict(sessionDir, T, workingDir);
    assert.equal(g, 'absent', 'gate must reject a baseline-equal completion_commit');
    assert.equal(w, 'absent', 'watcher must reject the SAME baseline-equal completion_commit (no split)');
    assert.equal(w, g, 'watcher verdict ≡ gate verdict for baseline-equal frontmatter');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

test('T30 source pin: batchLoopPhantomDoneKind sources baseline SHAs via buildCompletionCtx (single-oracle parity)', () => {
  // B-1SEAM WS-1: baseline wiring moved into the shared buildCompletionCtx
  // helper — every decision site (watcher included) sources the SAME baseline
  // SHAs there, so the watcher's predicate ctx matches the gate's by construction.
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../src/bin/mux-runner.ts'), 'utf8');
  const fnStart = src.indexOf('function batchLoopPhantomDoneKind');
  const fnBody = src.slice(fnStart, fnStart + 1400);
  assert.ok(/buildCompletionCtx\(/.test(fnBody),
    'batchLoopPhantomDoneKind must build its predicate ctx via buildCompletionCtx');
  const helperStart = src.indexOf('function buildCompletionCtx');
  const helperBody = src.slice(helperStart, helperStart + 1600);
  assert.ok(/resolveSessionBaselineShas\(args\.sessionDir\)/.test(helperBody),
    'buildCompletionCtx must source baseline SHAs so every decision site matches the gate');
  assert.ok(/startCommit,\s*\n?\s*pinnedSha/.test(helperBody),
    'the shared CompletionDecisionCtx must carry startCommit/pinnedSha');
});
