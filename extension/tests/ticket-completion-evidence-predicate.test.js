// @tier: fast
//
// B-1SEAM WS-1a — the ONE completion predicate (evaluateCompletionEvidence) +
// the R-AICF unreachable-explicit→scan-fallback fix inside readEvidence.
//
// Live repro (session 2026-07-01-9e922602, ticket c46045a6, codex): the worker
// committed real UNTAGGED work, then stamped a HALLUCINATED full sha into
// `completion_commit:`. The old readEvidence explicit-SHA-wins short-circuit
// hard-returned `absent` for the unreachable sha with NO fallback to the
// inferred/scan branches — done-guard accepted, watcher reverted, Done-flip
// guard FATAL'd (`done_without_commit_evidence`). After R-AICF an unreachable
// explicit sha falls through to the inferred-field and git-log-scan branches;
// baseline-rejected and foreign-attributed explicit SHAs stay hard-absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateCompletionEvidence,
  gateForPhantomDoneRevert,
  readEvidence,
} from '../services/ticket-completion-evidence.js';

// 40 valid hex chars that exist in no fixture repo (hallucinated-stamp shape).
const HALLUCINATED_SHA = '224678f39759e1da0000000000000000deadbeef';

function mkTmp(prefix = 'pickle-1seam-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
}

function head(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function commitFile(dir, rel, message) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `work in ${rel}\n`);
  execFileSync('git', ['add', rel], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message, '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return head(dir);
}

/** WS-2: a commit carrying a `Pickle-Ticket: <ticketId>` trailer (the git-authoritative attribution path). */
function commitFileWithTrailer(dir, rel, message, ticketId) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `work in ${rel}\n`);
  execFileSync('git', ['add', rel], { cwd: dir });
  execFileSync(
    'git',
    ['commit', '-q', '-m', message, '--trailer', `Pickle-Ticket: ${ticketId}`, '--no-gpg-sign'],
    { cwd: dir, stdio: 'ignore' },
  );
  return head(dir);
}

function writeTicket(sessionDir, ticketId, { completionCommit, declaredFiles = [], title = `Test ${ticketId}` } = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = [
    '---',
    `id: ${ticketId}`,
    `title: "${title}"`,
    'status: "Done"',
    ...(completionCommit ? [`completion_commit: "${completionCommit}"`] : []),
    '---',
    '# Body',
    ...(declaredFiles.length > 0
      ? ['## Files to modify', ...declaredFiles.map((f) => `- \`${f}\``)]
      : []),
  ];
  const fp = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
  fs.writeFileSync(fp, lines.join('\n'));
  return fp;
}

function readTicket(fp) {
  return fs.readFileSync(fp, 'utf8');
}

const baseCtx = (sessionDir, ticketId, workingDir, extra = {}) => ({
  sessionDir,
  ticketId,
  workingDir,
  startCommit: null,
  pinnedSha: null,
  rereadBackoffMs: 0,
  ...extra,
});

// ── R-AICF: unreachable-explicit falls through to the scan branches ──────────

test('R-AICF: readEvidence — hallucinated explicit sha + real trailer-attributed commit → committed via scan', () => {
  const root = mkTmp('pickle-1seam-aicf-');
  try {
    initGitRepo(root);
    const declared = 'src/circuit-store.ts';
    // Real work, message carries NO ticket id / r-code (codex untagged commit) —
    // only the Pickle-Ticket trailer attributes it.
    const realSha = commitFileWithTrailer(root, declared, 'Add Reducto Redis circuit store', 'c46045a6');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'c46045a6', { completionCommit: HALLUCINATED_SHA, declaredFiles: [declared] });

    const ev = readEvidence({
      sessionDir,
      ticketId: 'c46045a6',
      workingDir: root,
    });
    assert.equal(ev.kind, 'committed', 'unreachable explicit sha must fall through to the scan branches (R-AICF)');
    assert.equal(ev.sha, realSha, 'scan fallback must attribute the real trailer-stamped commit');
    assert.equal(ev.via, 'scan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-AICF: readEvidence — unreachable explicit sha with NO attributable commit stays absent (unreachable_explicit_unattributable)', () => {
  const root = mkTmp('pickle-1seam-unattr-');
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'aaaa1111', { completionCommit: HALLUCINATED_SHA });

    const ev = readEvidence({ sessionDir, ticketId: 'aaaa1111', workingDir: root });
    assert.equal(ev.kind, 'absent');
    assert.equal(ev.absentReason, 'unreachable_explicit_unattributable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-AICF: baseline-rejected explicit sha stays HARD-absent — no scan fallback even with an attributable commit', () => {
  const root = mkTmp('pickle-1seam-base-');
  try {
    initGitRepo(root);
    const baseline = head(root);
    // An attributable commit exists (ticket id in subject) — must NOT rescue a baseline stamp.
    commitFile(root, 'x.txt', 'fix(bbbb2222): real work');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'bbbb2222', { completionCommit: baseline });

    const ev = readEvidence({ sessionDir, ticketId: 'bbbb2222', workingDir: root, startCommit: baseline });
    assert.equal(ev.kind, 'absent', 'baseline sha must stay hard-absent (R-CXOR-2)');
    assert.equal(ev.absentReason, 'baseline_sha');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('R-AICF: foreign-attributed explicit sha stays HARD-absent — no scan fallback', () => {
  const root = mkTmp('pickle-1seam-foreign-');
  try {
    initGitRepo(root);
    // Commit positively attributed to sibling ticket e2efeat1.
    const foreignSha = commitFile(root, 'e2e.txt', 'feat(e2efeat1): add e2e coverage');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'e2efeat1', {});
    writeTicket(sessionDir, 'noop0001', { completionCommit: foreignSha, title: 'clean audit no-op' });

    const ev = readEvidence({ sessionDir, ticketId: 'noop0001', workingDir: root });
    assert.equal(ev.kind, 'absent', 'foreign-attributed explicit sha must stay hard-absent (R-OMA)');
    assert.equal(ev.absentReason, 'foreign_attribution');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── evaluateCompletionEvidence — the ONE predicate ───────────────────────────

test('predicate: done-flip with GREEN worker-gate verdict → ok:true via explicit', () => {
  const root = mkTmp('pickle-1seam-green-');
  try {
    initGitRepo(root);
    const sha = commitFile(root, 'w.txt', 'real work');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'cccc3333', { completionCommit: sha });

    const d = evaluateCompletionEvidence(baseCtx(sessionDir, 'cccc3333', root, {
      decision: 'done-flip',
      workerGateVerdict: () => ({ verdict: 'green', computedVia: 'worker_gate' }),
    }));
    assert.equal(d.ok, true);
    assert.equal(d.sha, sha);
    assert.equal(d.via, 'explicit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('predicate: done-flip with RED verdict is fail-closed → worker_gate_red', () => {
  const root = mkTmp('pickle-1seam-red-');
  try {
    initGitRepo(root);
    const sha = commitFile(root, 'w.txt', 'real work');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'dddd4444', { completionCommit: sha });

    const d = evaluateCompletionEvidence(baseCtx(sessionDir, 'dddd4444', root, {
      decision: 'done-flip',
      workerGateVerdict: () => ({ verdict: 'red', computedVia: 'worker_gate' }),
    }));
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'worker_gate_red');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('predicate: done-flip with ABSENT verdict is fail-closed → worker_gate_unavailable', () => {
  const root = mkTmp('pickle-1seam-absent-');
  try {
    initGitRepo(root);
    const sha = commitFile(root, 'w.txt', 'real work');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'eeee5555', { completionCommit: sha });

    const d = evaluateCompletionEvidence(baseCtx(sessionDir, 'eeee5555', root, {
      decision: 'done-flip',
      workerGateVerdict: () => ({ verdict: 'absent', computedVia: 'unavailable' }),
    }));
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'worker_gate_unavailable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('predicate: done-flip with NO injected verdict dep is fail-closed → worker_gate_unavailable', () => {
  const root = mkTmp('pickle-1seam-nodep-');
  try {
    initGitRepo(root);
    const sha = commitFile(root, 'w.txt', 'real work');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'ffff6666', { completionCommit: sha });

    const d = evaluateCompletionEvidence(baseCtx(sessionDir, 'ffff6666', root, { decision: 'done-flip' }));
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'worker_gate_unavailable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('predicate: phantom-watch and attribution decisions NEVER consult the worker-gate verdict (R-DSAN never-discard)', () => {
  const root = mkTmp('pickle-1seam-watch-');
  try {
    initGitRepo(root);
    const sha = commitFile(root, 'w.txt', 'real work');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abab7777', { completionCommit: sha });

    for (const decision of ['phantom-watch', 'attribution']) {
      let verdictConsulted = false;
      const d = evaluateCompletionEvidence(baseCtx(sessionDir, 'abab7777', root, {
        decision,
        workerGateVerdict: () => { verdictConsulted = true; return { verdict: 'red', computedVia: 'worker_gate' }; },
      }));
      assert.equal(d.ok, true, `${decision} must keep committed evidence regardless of verdict`);
      assert.equal(d.sha, sha);
      assert.equal(verdictConsulted, false, `${decision} must not invoke the verdict dep`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('predicate: announcement recovery — absent evidence + announced sha → committed via announcement, inferred field persisted', () => {
  const root = mkTmp('pickle-1seam-ann-');
  try {
    initGitRepo(root);
    // Untagged commit, no declared files, no ticket-id in message → base readEvidence is absent.
    const realSha = commitFile(root, 'w.txt', 'untagged worker commit');
    const sessionDir = path.join(root, 'session');
    const fp = writeTicket(sessionDir, 'baba8888', {});

    const d = evaluateCompletionEvidence(baseCtx(sessionDir, 'baba8888', root, {
      decision: 'phantom-watch',
      announcedSha: () => realSha,
    }));
    assert.equal(d.ok, true, 'announced sha must recover absent evidence');
    assert.equal(d.sha, realSha);
    assert.equal(d.via, 'announcement');
    // Promote-once: the explicit field is stamped after acceptance.
    const raw = readTicket(fp);
    assert.match(raw, new RegExp(`completion_commit:\\s*"?${realSha}`), 'promote-once must stamp completion_commit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('predicate: scan-attributed evidence is promoted once into explicit completion_commit (via stays scan)', () => {
  const root = mkTmp('pickle-1seam-scan-');
  try {
    initGitRepo(root);
    const realSha = commitFileWithTrailer(root, 'w.txt', 'tagged work', 'cdcd9999');
    const sessionDir = path.join(root, 'session');
    const fp = writeTicket(sessionDir, 'cdcd9999', {});

    const d = evaluateCompletionEvidence(baseCtx(sessionDir, 'cdcd9999', root, { decision: 'attribution' }));
    assert.equal(d.ok, true);
    assert.equal(d.sha, realSha);
    assert.equal(d.via, 'scan');
    const raw = readTicket(fp);
    assert.match(raw, new RegExp(`completion_commit:\\s*"?${realSha}`), 'promote-once must stamp completion_commit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('predicate: no evidence at all → ok:false reason no_evidence', () => {
  const root = mkTmp('pickle-1seam-noev-');
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'dede0000', {});

    const d = evaluateCompletionEvidence(baseCtx(sessionDir, 'dede0000', root, { decision: 'phantom-watch' }));
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'no_evidence');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('predicate: baseline-stamped ticket refuses with reason baseline_sha', () => {
  const root = mkTmp('pickle-1seam-basep-');
  try {
    initGitRepo(root);
    const baseline = head(root);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'efef1111', { completionCommit: baseline });

    const d = evaluateCompletionEvidence(baseCtx(sessionDir, 'efef1111', root, {
      decision: 'phantom-watch',
      startCommit: baseline,
    }));
    assert.equal(d.ok, false);
    assert.equal(d.reason, 'baseline_sha');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── gateForPhantomDoneRevert — thin adapter over the predicate ───────────────

test('adapter: gateForPhantomDoneRevert keeps a hallucinated-stamp ticket whose real work is scan-attributable (live-repro parity)', () => {
  const root = mkTmp('pickle-1seam-adapter-');
  try {
    initGitRepo(root);
    const declared = 'src/circuit-store.ts';
    const realSha = commitFileWithTrailer(root, declared, 'Add Reducto Redis circuit store', 'c46045a6');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'c46045a6', { completionCommit: HALLUCINATED_SHA, declaredFiles: [declared] });

    const decision = gateForPhantomDoneRevert({
      sessionDir,
      ticketId: 'c46045a6',
      workingDir: root,
    });
    assert.equal(decision.action, 'keep', 'watcher must not revert real scan-attributable work (R-AICF)');
    assert.equal(decision.kind, 'committed');
    assert.equal(decision.sha, realSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter: gateForPhantomDoneRevert still reverts when no usable evidence exists', () => {
  const root = mkTmp('pickle-1seam-revert-');
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fafa2222', {});

    const decision = gateForPhantomDoneRevert({ sessionDir, ticketId: 'fafa2222', workingDir: root });
    assert.equal(decision.action, 'revert');
    assert.equal(decision.kind, 'absent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
