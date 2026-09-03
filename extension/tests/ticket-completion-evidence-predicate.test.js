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

function writeTicket(sessionDir, ticketId, {
  completionCommit,
  completionCommitInferred,
  declaredFiles = [],
  title = `Test ${ticketId}`,
} = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = [
    '---',
    `id: ${ticketId}`,
    `title: "${title}"`,
    'status: "Done"',
    ...(completionCommit ? [`completion_commit: "${completionCommit}"`] : []),
    ...(completionCommitInferred ? [`completion_commit_inferred: "${completionCommitInferred}"`] : []),
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

// ── AP-EXT-ITER195-01: the INFERRED arm obeys the same R-AICF fall-through ───
// The explicit arm above falls through to the scan when its stamp is
// unresolvable. Its stamped-field sibling used to return absent() instead, on
// the theory that "the scan would fail for the same reason" — false, since the
// scan asks an independent question (does a commit carry this ticket's
// Pickle-Ticket trailer?). One stale inferred stamp therefore made real,
// correctly-trailered, shipped work permanently unattributable.

test('AP-EXT-ITER195-01: readEvidence — unresolvable INFERRED sha + real trailer-attributed commit → committed via scan', () => {
  const root = mkTmp('pickle-aicf-inferred-');
  try {
    initGitRepo(root);
    const declared = 'src/circuit-store.ts';
    const realSha = commitFileWithTrailer(root, declared, 'Add Reducto Redis circuit store', 'c46045a6');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'c46045a6', { completionCommitInferred: HALLUCINATED_SHA, declaredFiles: [declared] });

    const ev = readEvidence({ sessionDir, ticketId: 'c46045a6', workingDir: root });
    assert.equal(ev.kind, 'committed', 'unresolvable inferred sha must fall through to the scan branches (R-AICF parity)');
    assert.equal(ev.sha, realSha, 'scan fallback must attribute the real trailer-stamped commit');
    assert.equal(ev.via, 'scan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER195-01: readEvidence — unresolvable INFERRED sha with NO attributable commit stays absent', () => {
  const root = mkTmp('pickle-aicf-inf-unattr-');
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'cccc3333', { completionCommitInferred: HALLUCINATED_SHA });

    const ev = readEvidence({ sessionDir, ticketId: 'cccc3333', workingDir: root });
    assert.equal(ev.kind, 'absent', 'no stamp resolves and no trailered commit exists → absent');
    assert.equal(ev.absentReason, 'no_evidence');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER195-01: a baseline-rejected INFERRED sha stays HARD-absent — the fall-through never launders a rejection', () => {
  const root = mkTmp('pickle-aicf-inf-base-');
  try {
    initGitRepo(root);
    const baseline = head(root);
    // A real trailered commit exists — it must NOT rescue a baseline-stamped inferred field.
    commitFileWithTrailer(root, 'x.txt', 'real work', 'dddd4444');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'dddd4444', { completionCommitInferred: baseline });

    const ev = readEvidence({ sessionDir, ticketId: 'dddd4444', workingDir: root, startCommit: baseline });
    assert.equal(ev.kind, 'absent', 'baseline inferred sha must stay hard-absent (R-CXOR-2)');
    assert.equal(ev.absentReason, 'baseline_sha');
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

// ---------------------------------------------------------------------------
// AP-EXT-ITER16-01 — the R-CXOR-2 baseline rejection reaches the INFERRED arm.
//
// `isBaselineSha` was wired into only 2 of readEvidence's 3 accept arms
// (explicit, scan). The inferred arm gated on `commitExists` alone — and a
// baseline SHA is git-reachable by construction, so an announced baseline
// classified `committed`. The Done-flip was then saved only by accident: the
// predicate's promote-once wrote the SHA into the explicit field and the
// RE-PROBE's explicit arm rejected it. By then the damage was durable — a
// baseline `completion_commit:` stamp on a ticket that did no work, which
// `mux-runner.resolveAttributableFrontmatterSha` (R-RASO silent-death
// respawn suppression) and `hasPresentCompletionCommitField` (B-RRH
// signal_committed) both read with NO baseline awareness.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER16-01: a BASELINE sha in completion_commit_inferred is absent, not committed', () => {
  const root = mkTmp('pickle-iter16-inferred-base-');
  try {
    initGitRepo(root);
    const baseline = head(root);
    // Session moves on; the baseline stays reachable — which is precisely why
    // `commitExists` can never catch this on its own.
    commitFile(root, 'later.txt', 'chore: unrelated later work');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'infb0001', { completionCommitInferred: baseline });

    const ev = readEvidence({
      sessionDir, ticketId: 'infb0001', workingDir: root, startCommit: baseline,
    });
    assert.equal(ev.kind, 'absent', 'a baseline sha must never be accepted via the inferred arm (R-CXOR-2)');
    assert.equal(ev.absentReason, 'baseline_sha', 'inferred is a STAMPED field — it reports the hard reason, like explicit');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER16-01: the predicate never PERSISTS a baseline sha into completion_commit', () => {
  const root = mkTmp('pickle-iter16-nopersist-');
  try {
    initGitRepo(root);
    const baseline = head(root);
    commitFile(root, 'later.txt', 'chore: unrelated later work');

    const sessionDir = path.join(root, 'session');
    const fp = writeTicket(sessionDir, 'infb0002', { completionCommitInferred: baseline });

    const decision = evaluateCompletionEvidence({
      sessionDir,
      ticketId: 'infb0002',
      workingDir: root,
      startCommit: baseline,
      pinnedSha: null,
      decision: 'done-flip',
      rereadBackoffMs: 0,
      workerGateVerdict: () => ({ verdict: 'green', computedVia: 'worker_gate' }),
    });

    assert.equal(decision.ok, false, 'a baseline-only ticket must not pass the Done-flip gate');
    assert.equal(decision.reason, 'baseline_sha');

    // The OUTCOME that matters: no false stamp reaches disk. Pre-fix the
    // promote-once wrote `completion_commit: "<baseline>"` here before the
    // re-probe caught it, leaving durable evidence the R-RASO detector trusts.
    const after = readTicket(fp);
    assert.ok(
      !/^completion_commit:/m.test(after),
      `predicate must not persist a baseline sha as completion evidence; got:\n${after}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER16-01 control: a NON-baseline inferred sha is still accepted via the inferred arm', () => {
  const root = mkTmp('pickle-iter16-control-');
  try {
    initGitRepo(root);
    const baseline = head(root);
    const realSha = commitFile(root, 'real.txt', 'feat: genuine worker output');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'infb0003', { completionCommitInferred: realSha });

    const ev = readEvidence({
      sessionDir, ticketId: 'infb0003', workingDir: root, startCommit: baseline,
    });
    assert.equal(ev.kind, 'committed', 'the fix must not blind the inferred arm to real work');
    assert.equal(ev.via, 'inferred');
    assert.equal(ev.sha, realSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER16-02 — the R-OMA foreign-attribution rejection reaches the
// INFERRED arm.
//
// Sibling of AP-EXT-ITER16-01, same shape one rule over: the foreign-attribution
// gate was wired into 2 of readEvidence's 3 accept arms (explicit, scan) and the
// inferred arm skipped it, so ONE sha got THREE verdicts depending on which field
// carried it. `commitExists` cannot catch this either — a foreign-attributed sha
// is a real, reachable commit, just someone else's. The damage is the same
// durable false stamp AP-EXT-ITER16-01 describes: promote-once writes the
// borrowed sha into `completion_commit:`, which `resolveAttributableFrontmatterSha`
// (R-RASO) and `hasPresentCompletionCommitField` (B-RRH) both read with no
// attribution awareness.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER16-02: a SIBLING-attributed sha in completion_commit_inferred is absent, not committed', () => {
  const root = mkTmp('pickle-iter16-inferred-foreign-');
  try {
    initGitRepo(root);
    // Positively attributed to the sibling ticket, and NOT to the reader's own id.
    const siblingSha = commitFile(root, 'sib.txt', 'feat(fgsib002): sibling ticket work');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fgsib002', {});
    writeTicket(sessionDir, 'infb0004', { completionCommitInferred: siblingSha });

    const ev = readEvidence({ sessionDir, ticketId: 'infb0004', workingDir: root });
    assert.equal(ev.kind, 'absent', 'a sibling-attributed sha must never be accepted via the inferred arm (R-OMA)');
    assert.equal(ev.absentReason, 'foreign_attribution', 'inferred is a STAMPED field — it reports the hard reason, like explicit');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER16-02: the explicit and inferred arms agree on one foreign sha', () => {
  const root = mkTmp('pickle-iter16-arm-agreement-');
  try {
    initGitRepo(root);
    const siblingSha = commitFile(root, 'sib.txt', 'feat(fgsib003): sibling ticket work');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fgsib003', {});
    writeTicket(sessionDir, 'expl0001', { completionCommit: siblingSha });
    writeTicket(sessionDir, 'infr0001', { completionCommitInferred: siblingSha });

    const viaExplicit = readEvidence({ sessionDir, ticketId: 'expl0001', workingDir: root });
    const viaInferred = readEvidence({ sessionDir, ticketId: 'infr0001', workingDir: root });

    // The point of the shared gate: one sha, one verdict, whichever field carries it.
    assert.deepEqual(
      { kind: viaInferred.kind, absentReason: viaInferred.absentReason },
      { kind: viaExplicit.kind, absentReason: viaExplicit.absentReason },
      'the inferred arm must reach the same verdict as its explicit sibling for the same sha',
    );
    assert.equal(viaExplicit.kind, 'absent');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER16-02 control: an OWN-attributed inferred sha is still accepted', () => {
  const root = mkTmp('pickle-iter16-foreign-control-');
  try {
    initGitRepo(root);
    const ownSha = commitFile(root, 'own.txt', 'feat(infb0005): this ticket\'s own work');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fgsib004', {});
    writeTicket(sessionDir, 'infb0005', { completionCommitInferred: ownSha });

    const ev = readEvidence({ sessionDir, ticketId: 'infb0005', workingDir: root });
    assert.equal(ev.kind, 'committed', 'own-attribution wins — the fix must not blind the inferred arm to real work');
    assert.equal(ev.via, 'inferred');
    assert.equal(ev.sha, ownSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── AP-EXT-ITER23-01: the announcement arm judges BEFORE it persists ─────────
//
// The pre-fix predicate already REFUSED both cases below — it wrote the stamp,
// then re-probed and classified `absent`. So the verdict alone cannot redden:
// these assert on the DURABLE ON-DISK STAMP, which is what the ungated
// mux-runner oracles (`resolveAttributableFrontmatterSha`,
// `hasPresentCompletionCommitField`) actually read. A surviving stamp makes a
// baseline/borrowed sha suppress both the silent-death respawn and the
// Failed-flip, wedging a ticket that did no work.

function announcedCtx(sessionDir, ticketId, workingDir, announced, extra = {}) {
  return baseCtx(sessionDir, ticketId, workingDir, {
    decision: 'done-flip',
    workerGateVerdict: () => ({ verdict: 'green', computedVia: 'worker_gate' }),
    announcedSha: () => announced,
    ...extra,
  });
}

test('AP-EXT-ITER23-01: an announced BASELINE sha is never persisted as inferred evidence', () => {
  const root = mkTmp('pickle-iter23-baseline-');
  try {
    initGitRepo(root);
    const baseline = head(root);
    const sessionDir = path.join(root, 'session');
    const fp = writeTicket(sessionDir, 'annb0001', {});

    const d = evaluateCompletionEvidence(
      announcedCtx(sessionDir, 'annb0001', root, baseline, { startCommit: baseline }),
    );

    assert.equal(d.ok, false);
    assert.equal(d.reason, 'baseline_sha', 'the hard reason must survive, not degrade to no_evidence');
    assert.doesNotMatch(
      readTicket(fp),
      /completion_commit_inferred:/,
      'a baseline sha must never reach disk — the git-only oracles would read it back as attributable work (R-CXOR-2)',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER23-01: an announced FOREIGN-attributed sha is never persisted as inferred evidence', () => {
  const root = mkTmp('pickle-iter23-foreign-');
  try {
    initGitRepo(root);
    const foreignSha = commitFile(root, 'sib.txt', 'feat(annsib02): sibling ticket work');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'annsib02', {});
    const fp = writeTicket(sessionDir, 'annf0001', { title: 'clean audit no-op' });

    const d = evaluateCompletionEvidence(announcedCtx(sessionDir, 'annf0001', root, foreignSha));

    assert.equal(d.ok, false);
    assert.equal(d.reason, 'foreign_attribution');
    assert.doesNotMatch(
      readTicket(fp),
      /completion_commit_inferred:/,
      'a borrowed sibling sha must never reach disk — it is a real commit, so the git-only oracles accept it (R-OMA)',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER23-01 control: an announced OWN sha is still recovered and persisted', () => {
  const root = mkTmp('pickle-iter23-control-');
  try {
    initGitRepo(root);
    const ownSha = commitFile(root, 'own.txt', 'real untagged work');
    const sessionDir = path.join(root, 'session');
    const fp = writeTicket(sessionDir, 'anno0001', {});

    const d = evaluateCompletionEvidence(announcedCtx(sessionDir, 'anno0001', root, ownSha));

    assert.equal(d.ok, true, 'the gate must not blind R-CCEM recovery to a legitimate announcement');
    assert.equal(d.sha, ownSha);
    assert.equal(d.via, 'announcement');
    assert.match(readTicket(fp), /completion_commit:/, 'promote-once must still persist the recovered sha');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── AP-EXT-ITER27-01: the trailer scan's window is bounded on the epoch axis ──
//
// The scan was capped at `git log -n 50`. That is a DIFFERENT axis from the
// `startTimeEpoch` filter the entries are then tested against, so an early
// ticket's correctly-trailered commit falls out of the window as soon as the
// bundle authors 50 more commits — evidence reads `absent` and the Done flip is
// refused over work that shipped. Real bundles clear that bar easily (this repo
// has logged 143 commits in a single day). Assert the ATTRIBUTION of a commit
// pushed deep into history, never the scan's arg list.

test('AP-EXT-ITER27-01: a trailered commit past the old 50-commit window is still attributed', () => {
  const root = mkTmp('pickle-iter27-window-');
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const startEpoch = Math.floor(Date.now() / 1000) - 60;

    const realSha = commitFileWithTrailer(root, 'src/early.ts', 'early ticket work', 'win00001');
    // The rest of the bundle: 60 sibling commits authored after it, pushing the
    // attributed commit past the former window.
    for (let i = 0; i < 55; i += 1) {
      commitEmpty(root, `sibling ticket work ${i}`);
    }

    writeTicket(sessionDir, 'win00001', {});
    const ev = readEvidence({
      sessionDir,
      ticketId: 'win00001',
      workingDir: root,
      startCommit: null,
      pinnedSha: null,
      startTimeEpoch: startEpoch,
    });

    assert.equal(ev.kind, 'committed', 'a trailered in-session commit must stay attributable past 50 siblings');
    assert.equal(ev.sha, realSha);
    assert.equal(ev.via, 'scan');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER27-01: pre-session commits stay OUT of the window (the epoch bound still fences)', () => {
  const root = mkTmp('pickle-iter27-fence-');
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');

    commitFileWithTrailer(root, 'src/stale.ts', 'work from a PRIOR session', 'win00002');
    // Session starts strictly after that commit's committer date.
    const startEpoch = Math.floor(Date.now() / 1000) + 60;

    writeTicket(sessionDir, 'win00002', {});
    const ev = readEvidence({
      sessionDir,
      ticketId: 'win00002',
      workingDir: root,
      startCommit: null,
      pinnedSha: null,
      startTimeEpoch: startEpoch,
    });

    assert.equal(ev.kind, 'absent', 'widening the window must not admit a pre-session commit');
    assert.equal(ev.absentReason, 'no_evidence');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER27-01: with no startTimeEpoch the count ceiling still admits deep history', () => {
  const root = mkTmp('pickle-iter27-noepoch-');
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');

    const realSha = commitFileWithTrailer(root, 'src/early.ts', 'early ticket work', 'win00003');
    for (let i = 0; i < 55; i += 1) {
      commitEmpty(root, `sibling ticket work ${i}`);
    }

    writeTicket(sessionDir, 'win00003', {});
    const ev = readEvidence({
      sessionDir,
      ticketId: 'win00003',
      workingDir: root,
      startCommit: null,
      pinnedSha: null,
    });

    assert.equal(ev.kind, 'committed', 'the no-epoch arm must not inherit the old 50-commit cap');
    assert.equal(ev.sha, realSha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** AP-EXT-ITER27-01: a cheap sibling commit — the trailer scan counts commits, not trees. */
function commitEmpty(dir, message) {
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message, '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return head(dir);
}

// ---------------------------------------------------------------------------
// AP-EXT-ITER5-01 — the R-CXOR-2 baseline join compared SPELLING, not identity.
//
// Every prior fix in this area (487e7855, AP-EXT-ITER16-01/-02) asked WHICH ARMS
// call the baseline rule, and the answer is now correctly "all three, via
// `rejectsAccept`". Nobody asked whether the rule's own COMPARISON is right.
//
// The two sides of the join arrive in different widths by construction: a stamped
// field is normalized by `normalizeCompletionCommitField`, which accepts
// `[0-9a-f]{7,40}` and returns it verbatim, while `start_commit`/`pinned_sha` are
// read RAW from state.json where setup always writes a full 40-char OID. The
// `sha === ctx.startCommit` therefore answered "same spelling". An 8-char stamp of
// the session baseline — the `git log --oneline` shape, and 5 of 39 real stamps on
// the box this was found on — missed the rejection, resolved fine under
// `git cat-file -e <sha>^{commit}` (git abbreviates by prefix), and classified
// `committed`/`explicit`. A ticket that did NO WORK BEYOND SESSION START got its
// Done flip: exactly the fake-green R-CXOR-2 exists to prevent, reached by
// retyping the same commit shorter.
// ---------------------------------------------------------------------------

/** The `git log --oneline` shape a worker copies into a stamp. */
function shortSha(dir, sha) {
  return execFileSync('git', ['rev-parse', `--short=8`, sha], { cwd: dir, encoding: 'utf8', timeout: 30_000 }).trim();
}

test('AP-EXT-ITER5-01: an ABBREVIATED baseline sha is absent — identity, not spelling (R-CXOR-2)', () => {
  const root = mkTmp('pickle-iter5-abbrev-base-');
  try {
    initGitRepo(root);
    const baseline = head(root);
    // The baseline stays reachable as the session moves on — which is why
    // `commitExists` can never catch this and only the baseline rule can.
    commitFile(root, 'later.txt', 'chore: unrelated later work');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abrv0001', { completionCommit: shortSha(root, baseline) });

    const ev = readEvidence({
      sessionDir, ticketId: 'abrv0001', workingDir: root, startCommit: baseline,
    });
    assert.equal(ev.kind, 'absent', 'an 8-char stamp of the baseline is the SAME COMMIT — it must be rejected');
    assert.equal(ev.absentReason, 'baseline_sha');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER5-01: an abbreviated PINNED_SHA is rejected too — both baselines share the comparison', () => {
  const root = mkTmp('pickle-iter5-abbrev-pinned-');
  try {
    initGitRepo(root);
    const pinned = head(root);
    commitFile(root, 'later.txt', 'chore: unrelated later work');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abrv0002', { completionCommit: shortSha(root, pinned) });

    const ev = readEvidence({
      sessionDir, ticketId: 'abrv0002', workingDir: root, startCommit: null, pinnedSha: pinned,
    });
    assert.equal(ev.kind, 'absent');
    assert.equal(ev.absentReason, 'baseline_sha');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER5-01: an abbreviated baseline is rejected on the INFERRED arm as well (shared rejectsAccept gate)', () => {
  const root = mkTmp('pickle-iter5-abbrev-inferred-');
  try {
    initGitRepo(root);
    const baseline = head(root);
    commitFile(root, 'later.txt', 'chore: unrelated later work');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abrv0003', { completionCommitInferred: shortSha(root, baseline) });

    const ev = readEvidence({
      sessionDir, ticketId: 'abrv0003', workingDir: root, startCommit: baseline,
    });
    assert.equal(ev.kind, 'absent', 'the fix lives in the shared gate, so every arm inherits it');
    assert.equal(ev.absentReason, 'baseline_sha');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER5-01: an UPPERCASE baseline stamp is rejected — normalize preserves case, the join must fold it', () => {
  const root = mkTmp('pickle-iter5-upper-base-');
  try {
    initGitRepo(root);
    const baseline = head(root);
    commitFile(root, 'later.txt', 'chore: unrelated later work');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abrv0004', { completionCommit: baseline.toUpperCase() });

    const ev = readEvidence({
      sessionDir, ticketId: 'abrv0004', workingDir: root, startCommit: baseline,
    });
    assert.equal(ev.kind, 'absent');
    assert.equal(ev.absentReason, 'baseline_sha');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER5-01: the predicate never PERSISTS an abbreviated baseline into completion_commit', () => {
  const root = mkTmp('pickle-iter5-nopersist-');
  try {
    initGitRepo(root);
    const baseline = head(root);
    commitFile(root, 'later.txt', 'chore: unrelated later work');
    const sessionDir = path.join(root, 'session');
    const fp = writeTicket(sessionDir, 'abrv0005', { completionCommitInferred: shortSha(root, baseline) });

    const decision = evaluateCompletionEvidence({
      sessionDir,
      ticketId: 'abrv0005',
      workingDir: root,
      startCommit: baseline,
      pinnedSha: null,
      decision: 'phantom-watch',
      rereadBackoffMs: 0,
    });
    assert.equal(decision.ok, false, 'a no-work ticket must not complete on an abbreviated baseline');
    assert.equal(decision.reason, 'baseline_sha');
    assert.ok(
      !/^completion_commit:/m.test(readTicket(fp)),
      'promote-once must never write a durable baseline stamp the R-RASO/B-RRH readers trust blindly',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- Controls: the fix must reject baselines WITHOUT over-rejecting ----------

test('AP-EXT-ITER5-01 control: an abbreviated NON-baseline sha is still ACCEPTED (13% of real stamps are abbreviated)', () => {
  const root = mkTmp('pickle-iter5-ctl-abbrev-ok-');
  try {
    initGitRepo(root);
    const baseline = head(root);
    const real = commitFile(root, 'work.txt', 'feat: real work this ticket did');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abrv0006', { completionCommit: shortSha(root, real) });

    const ev = readEvidence({
      sessionDir, ticketId: 'abrv0006', workingDir: root, startCommit: baseline, pinnedSha: baseline,
    });
    assert.equal(ev.kind, 'committed', 'prefix-identity must not swallow legitimate abbreviated stamps');
    assert.equal(ev.via, 'explicit');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER5-01 control: a truncated/garbage baseline never becomes a prefix that rejects every sha', () => {
  const root = mkTmp('pickle-iter5-ctl-floor-');
  try {
    initGitRepo(root);
    const real = commitFile(root, 'work.txt', 'feat: real work this ticket did');
    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'abrv0007', { completionCommit: real });

    // state.json holds a sub-minimum start_commit; below MIN_ABBREV_SHA_LEN it
    // must match NOTHING rather than every sha sharing its leading nibble.
    const ev = readEvidence({
      sessionDir, ticketId: 'abrv0007', workingDir: root, startCommit: real.slice(0, 4),
    });
    assert.equal(ev.kind, 'committed', 'a too-short baseline must not reject real evidence');
    assert.equal(ev.sha, real);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER76-01 — the rejection gate is uniform on the DIR axis, not just
// the arm axis.
//
// AP-EXT-ITER16-01/-02 unified `rejectsAccept` across readEvidence's three
// ACCEPT ARMS. The same divergence survived one axis over: the explicit arm's
// accept probe walks a TWO-dir ladder (`probeExplicitSha`: workingDir, then the
// R-CCR-1 `fallbackDir`), while the R-OMA read asked ONE dir. The two conditions
// are the same condition — `probeExplicitSha` consults `fallbackDir` only when
// the primary probe returns 'git-could-not-run', and `git show` in that same dir
// fails for the same reason — so `usedFallback: true` IMPLIED R-OMA never ran.
// Reachable on the ordinary path, not just a broken checkout: `git cat-file -e
// <sha>^{commit}` exits 128 (not 1) for an object the repo does not have, so a
// per-ticket `working_dir` that simply lacks the stamped commit takes the
// fallback rung. The fix collapses both readers onto one `gitDirLadder`.
// ---------------------------------------------------------------------------

test('AP-EXT-ITER76-01: a foreign sha accepted via the R-CCR-1 fallbackDir is still rejected (non-repo workingDir)', () => {
  const root = mkTmp('pickle-iter76-fallback-foreign-');
  try {
    initGitRepo(root);
    const siblingSha = commitFile(root, 'sib.txt', 'feat(fgsib076): sibling ticket work');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fgsib076', {});
    writeTicket(sessionDir, 'fbdr0076', { completionCommit: siblingSha });

    // The per-ticket working_dir is not a git repo at all: `git cat-file -e` and
    // `git show` both exit 128 there, so the accept is decided entirely by
    // fallbackDir. R-OMA must be asked in the dir that decided the accept.
    // OUTSIDE `root`: a dir nested inside the fixture repo would resolve through
    // the parent `.git` and never exercise the fallback rung at all.
    const notRepo = mkTmp('pickle-iter76-notrepo-');

    const ev = readEvidence({
      sessionDir, ticketId: 'fbdr0076', workingDir: notRepo, fallbackDir: root,
    });
    assert.equal(ev.kind, 'absent', 'the fallback dir must not launder a foreign-attributed sha into an accept');
    assert.equal(ev.absentReason, 'foreign_attribution', 'explicit is a STAMPED field — it reports the hard reason');
    assert.equal(ev.sha, undefined);
    fs.rmSync(notRepo, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER76-01: same rejection when workingDir is a VALID repo that lacks the sha', () => {
  const root = mkTmp('pickle-iter76-fallback-otherrepo-');
  try {
    initGitRepo(root);
    const siblingSha = commitFile(root, 'sib.txt', 'feat(fgsib077): sibling ticket work');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fgsib077', {});
    writeTicket(sessionDir, 'fbdr0077', { completionCommit: siblingSha });

    // A real repo with unrelated history. `git cat-file -e <sha>^{commit}` exits
    // 128 ("Not a valid object name") for an absent object, which probeCatFile
    // reads as 'git-could-not-run' — so this ORDINARY case takes the fallback rung.
    const otherRepo = mkTmp('pickle-iter76-otherrepo-');
    initGitRepo(otherRepo);

    const ev = readEvidence({
      sessionDir, ticketId: 'fbdr0077', workingDir: otherRepo, fallbackDir: root,
    });
    assert.equal(ev.kind, 'absent', 'a per-ticket repo that lacks the sha must not disable R-OMA');
    assert.equal(ev.absentReason, 'foreign_attribution');
    fs.rmSync(otherRepo, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER76-01: the dir ladder yields ONE verdict — fallback accept agrees with the direct accept', () => {
  const root = mkTmp('pickle-iter76-dir-agreement-');
  try {
    initGitRepo(root);
    const siblingSha = commitFile(root, 'sib.txt', 'feat(fgsib078): sibling ticket work');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fgsib078', {});
    writeTicket(sessionDir, 'fbdr0078', { completionCommit: siblingSha });

    // OUTSIDE `root`: a dir nested inside the fixture repo would resolve through
    // the parent `.git` and never exercise the fallback rung at all.
    const notRepo = mkTmp('pickle-iter76-notrepo-');

    const direct = readEvidence({ sessionDir, ticketId: 'fbdr0078', workingDir: root });
    const viaFallback = readEvidence({
      sessionDir, ticketId: 'fbdr0078', workingDir: notRepo, fallbackDir: root,
    });

    // The arm-agreement assertion of AP-EXT-ITER16-02, restated on the dir axis:
    // one sha, one verdict, whichever DIR resolved it.
    assert.deepEqual(
      { kind: viaFallback.kind, absentReason: viaFallback.absentReason },
      { kind: direct.kind, absentReason: direct.absentReason },
      'the fallback dir must reach the same verdict as the primary dir for the same sha',
    );
    fs.rmSync(notRepo, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER76-01 control: an OWN-attributed sha still accepts through the fallbackDir (usedFallback intact)', () => {
  const root = mkTmp('pickle-iter76-ctl-own-');
  try {
    initGitRepo(root);
    const ownSha = commitFile(root, 'own.txt', 'fix(ownt0076): the work this ticket actually did');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fgsib079', {});
    writeTicket(sessionDir, 'ownt0076', { completionCommit: ownSha });

    // OUTSIDE `root`: a dir nested inside the fixture repo would resolve through
    // the parent `.git` and never exercise the fallback rung at all.
    const notRepo = mkTmp('pickle-iter76-notrepo-');

    const ev = readEvidence({
      sessionDir, ticketId: 'ownt0076', workingDir: notRepo, fallbackDir: root,
    });
    assert.equal(ev.kind, 'committed', 'R-CCR-1 fallback recovery must keep working for legitimate evidence');
    assert.equal(ev.sha, ownSha);
    assert.equal(ev.usedFallback, true);
    assert.equal(ev.via, 'explicit');
    fs.rmSync(notRepo, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- AP-EXT-ITER111-01: only exit 1 proves a commit is absent -------------------
//
// `probeCatFile` used to enumerate the failures that do NOT prove absence
// (ETIMEDOUT / SIGTERM / exit 128 / ENOENT) and DEFAULT to a definite
// 'not-exists'. Any unaccountable failure therefore fabricated "this repo does
// not have that commit" — and because 'not-exists' is the one verdict
// `probeExplicitSha` treats as final (`if (primary !== 'git-could-not-run')
// return null`), the fabrication ALSO skipped the R-CCR-1 `fallbackDir` rung.
// The commit was right there in the fallback repo and the ticket read `absent`.
//
// Oracle: a `git` shim on PATH that fails with exit 3 — a status that is neither
// the exit-1 proof of absence nor any listed survivor — but ONLY for the primary
// dir, delegating to the real git everywhere else. That is the shape of a
// transient, dir-local inability to answer (EACCES/EAGAIN under load), and it is
// exactly the case the old survivor list mapped to a definite verdict.
// Assert the EVIDENCE, not the probe: pre-fix this returns `absent`.
function withGitFailingForDir(primaryDir, fn) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8', timeout: 5000 }).trim();
  const shimDir = mkTmp('pickle-iter111-shim-');
  const shim = path.join(shimDir, 'git');
  fs.writeFileSync(
    shim,
    ['#!/bin/sh',
     'prev=""',
     'for a in "$@"; do',
     `  if [ "$prev" = "-C" ] && [ "$a" = ${JSON.stringify(primaryDir)} ]; then exit 3; fi`,
     '  prev="$a"',
     'done',
     `exec ${JSON.stringify(realGit)} "$@"`,
     ''].join('\n'),
  );
  fs.chmodSync(shim, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${savedPath}`;
  try {
    return fn();
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER111-01: an unaccountable git failure is not proof the commit is absent (fallbackDir still consulted)', () => {
  const root = mkTmp('pickle-iter111-');
  try {
    initGitRepo(root);
    const ownSha = commitFile(root, 'own.txt', 'fix(unac1110): the work this ticket actually did');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fgsib111', {});
    writeTicket(sessionDir, 'unac1110', { completionCommit: ownSha });

    // OUTSIDE `root` so the fallback rung is genuinely exercised.
    const primary = mkTmp('pickle-iter111-primary-');

    const ev = withGitFailingForDir(primary, () => readEvidence({
      sessionDir, ticketId: 'unac1110', workingDir: primary, fallbackDir: root,
    }));

    assert.equal(
      ev.kind, 'committed',
      'an unaccountable git failure on the primary dir must not fabricate absence — the fallbackDir has the commit',
    );
    assert.equal(ev.sha, ownSha);
    assert.equal(ev.usedFallback, true, 'the fallbackDir rung must still fire when the primary probe could not answer');
    assert.equal(ev.via, 'explicit');
    fs.rmSync(primary, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER111-01 negative control: exit 1 IS proof of absence and does not reach the fallbackDir', () => {
  const root = mkTmp('pickle-iter111-neg-');
  try {
    initGitRepo(root);
    const ownSha = commitFile(root, 'own.txt', 'fix(neg11101): real work');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fgsib112', {});
    writeTicket(sessionDir, 'neg11101', { completionCommit: ownSha });

    const primary = mkTmp('pickle-iter111-neg-primary-');
    // Same shim shape, but exit 1 — git's contractual "object is not here".
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8', timeout: 5000 }).trim();
    const shimDir = mkTmp('pickle-iter111-neg-shim-');
    const shim = path.join(shimDir, 'git');
    fs.writeFileSync(
      shim,
      ['#!/bin/sh',
       'prev=""',
       'for a in "$@"; do',
       `  if [ "$prev" = "-C" ] && [ "$a" = ${JSON.stringify(primary)} ]; then exit 1; fi`,
       '  prev="$a"',
       'done',
       `exec ${JSON.stringify(realGit)} "$@"`,
       ''].join('\n'),
    );
    fs.chmodSync(shim, 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${savedPath}`;
    let ev;
    try {
      ev = readEvidence({ sessionDir, ticketId: 'neg11101', workingDir: primary, fallbackDir: root });
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(shimDir, { recursive: true, force: true });
    }

    // Exit 1 is a definite answer, so the explicit rung does NOT borrow the
    // fallback dir. This is the arm that keeps the fix from degrading into
    // "always try the fallback", which would erase the 3-state distinction.
    assert.notEqual(ev.usedFallback, true, 'exit 1 is a definite absence — the fallbackDir must not be consulted');
    fs.rmSync(primary, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER76-01 control: a GENERIC commit message still accepts through the fallbackDir', () => {
  const root = mkTmp('pickle-iter76-ctl-generic-');
  try {
    initGitRepo(root);
    const genericSha = commitFile(root, 'chore.txt', 'chore: bump deps');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fgsib080', {});
    writeTicket(sessionDir, 'genr0076', { completionCommit: genericSha });

    // OUTSIDE `root`: a dir nested inside the fixture repo would resolve through
    // the parent `.git` and never exercise the fallback rung at all.
    const notRepo = mkTmp('pickle-iter76-notrepo-');

    // R-RIC-EXPLICIT: absence of a matching message is NEVER grounds for
    // rejection. Widening the dir ladder must not turn accept-by-default into
    // reject-by-default.
    const ev = readEvidence({
      sessionDir, ticketId: 'genr0076', workingDir: notRepo, fallbackDir: root,
    });
    assert.equal(ev.kind, 'committed', 'a generic message is not a positive foreign attribution');
    assert.equal(ev.sha, genericSha);
    assert.equal(ev.usedFallback, true);
    fs.rmSync(notRepo, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER123-01 — the dir ladder governs EVERY accept arm, not just the
// explicit one.
//
// AP-EXT-ITER76-01 collapsed the R-OMA *rejection* read onto `gitDirLadder` and
// stated the doctrine outright: any rule that must hold for an accept has to
// hold on the fallback dir too. It wired two of the four probe sites. The two
// it left behind were ACCEPT arms: the inferred arm gated on a bare
// `commitExists(ctx.workingDir, …)` and the scan arm passed `ctx.workingDir`
// straight to the trailer scan, so both resolved over ONE dir while the explicit
// arm resolved over two.
//
// Consequence, measured on the shipped module before the fix: for ONE sha in ONE
// repo for ONE ticket, an unusable per-ticket `working_dir` made the explicit arm
// keep the ticket Done via the fallback rung while the inferred and scan arms
// reverted it to Todo (`correctPhantomDoneTickets` → `writeTicketStatus(…,'Todo')`).
// That is shipped work discarded on the dir axis alone — the R-DSAN never-discard
// failure the R-CCR-1 fallback was built to remove, still open on 2 of 3 arms.
//
// The fix is a COLLAPSE: `commitExists` and `probeExplicitSha`'s bespoke two-rung
// logic are both deleted in favour of ONE `probeShaOverLadder` walking
// `gitDirLadder`, so there is no per-arm dir policy left to diverge.
// ---------------------------------------------------------------------------

/**
 * Fixture for the ladder-parity cases: a real repo holding the delivering commit
 * (the R-CCR-1 `fallbackDir`) plus a per-ticket `working_dir` that is not a repo
 * at all. Created OUTSIDE the fixture repo — a dir nested inside it would resolve
 * through the parent `.git` and never exercise the fallback rung.
 */
function mkLadderFixture(tag, ticketId) {
  const root = mkTmp(`pickle-iter123-${tag}-`);
  initGitRepo(root);
  const sha = commitFileWithTrailer(root, `${tag}.txt`, `feat(${ticketId}): delivered work`, ticketId);
  const sessionDir = path.join(root, 'session');
  const notRepo = mkTmp(`pickle-iter123-${tag}-notrepo-`);
  return {
    root, sessionDir, notRepo, sha,
    cleanup: () => {
      fs.rmSync(notRepo, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('AP-EXT-ITER123-01: the INFERRED arm accepts over the R-CCR-1 fallbackDir, like its explicit sibling', () => {
  const f = mkLadderFixture('inferred', 'infl0123');
  try {
    writeTicket(f.sessionDir, 'infl0123', { completionCommitInferred: f.sha });

    const ev = readEvidence({
      sessionDir: f.sessionDir, ticketId: 'infl0123', workingDir: f.notRepo, fallbackDir: f.root,
    });
    assert.equal(ev.kind, 'committed', 'a stamped inferred sha the fallback repo can name is evidence');
    assert.equal(ev.sha, f.sha);
    assert.equal(ev.via, 'inferred', 'the arm identity survives the ladder collapse');
    assert.equal(ev.usedFallback, true, 'the accept was decided by the fallback rung');
  } finally {
    f.cleanup();
  }
});

test('AP-EXT-ITER123-01: the SCAN arm accepts over the R-CCR-1 fallbackDir, like its explicit sibling', () => {
  const f = mkLadderFixture('scan', 'scan0123');
  try {
    // No stamped field at all — attribution rests entirely on the Pickle-Ticket
    // trailer, which only the fallback repo can be asked about.
    writeTicket(f.sessionDir, 'scan0123', {});

    const ev = readEvidence({
      sessionDir: f.sessionDir, ticketId: 'scan0123', workingDir: f.notRepo, fallbackDir: f.root,
    });
    assert.equal(ev.kind, 'committed', 'a trailer-attributed commit in the fallback repo is evidence');
    assert.equal(ev.sha, f.sha);
    assert.equal(ev.via, 'scan');
  } finally {
    f.cleanup();
  }
});

test('AP-EXT-ITER123-01: the phantom-Done watcher KEEPS an inferred-stamped ticket whose working_dir is unusable', () => {
  const f = mkLadderFixture('watcher', 'wtch0123');
  try {
    writeTicket(f.sessionDir, 'wtch0123', { completionCommitInferred: f.sha });

    // The full data flow the defect reached through: gateForPhantomDoneRevert is
    // what `correctPhantomDoneTickets` consults before flipping Done → Todo.
    const decision = gateForPhantomDoneRevert({
      sessionDir: f.sessionDir, ticketId: 'wtch0123', workingDir: f.notRepo, fallbackDir: f.root,
    });
    assert.equal(decision.action, 'keep', 'shipped work must not be reverted on the dir axis alone');
    assert.equal(decision.sha, f.sha);
  } finally {
    f.cleanup();
  }
});

test('AP-EXT-ITER123-01: widening the accept arms does NOT launder a foreign-attributed inferred sha', () => {
  const root = mkTmp('pickle-iter123-foreign-');
  const notRepo = mkTmp('pickle-iter123-foreign-notrepo-');
  try {
    initGitRepo(root);
    const siblingSha = commitFile(root, 'sib.txt', 'feat(fgsib123): sibling ticket work');

    const sessionDir = path.join(root, 'session');
    writeTicket(sessionDir, 'fgsib123', {});
    writeTicket(sessionDir, 'infr0123', { completionCommitInferred: siblingSha });

    // Teeth control: the rejection gate runs BEFORE the ladder probe, and R-OMA
    // reads the message over the same ladder — so reaching the fallback rung must
    // not turn a sibling's commit into this ticket's evidence.
    const ev = readEvidence({
      sessionDir, ticketId: 'infr0123', workingDir: notRepo, fallbackDir: root,
    });
    assert.equal(ev.kind, 'absent', 'a foreign-attributed sha stays absent on every rung');
    assert.equal(ev.absentReason, 'foreign_attribution', 'inferred is a STAMPED field — hard reason');
    assert.equal(ev.sha, undefined);
  } finally {
    fs.rmSync(notRepo, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER123-01: a definite not-exists on the primary rung is still FINAL (no always-try-the-fallback degrade)', () => {
  const f = mkLadderFixture('final', 'finl0123');
  try {
    writeTicket(f.sessionDir, 'finl0123', { completionCommitInferred: HALLUCINATED_SHA });

    // The sha exists in NO repo on the ladder. Widening the arm must not invent
    // evidence: no rung may accept the hallucinated stamp itself.
    //
    // AP-EXT-ITER195-01 re-anchored the assertion from `kind === 'absent'` onto
    // the ARM. `mkLadderFixture` gives this ticket a real `Pickle-Ticket`-trailered
    // delivery commit, so the old expectation held only because an unresolvable
    // inferred stamp short-circuited the scan — the very defect that made shipped,
    // correctly-trailered work permanently unattributable. The ladder teeth are
    // unchanged and now cannot be satisfied by the short-circuit: the stamp must
    // not be accepted, and the accept that DOES land must come from the scan.
    // The genuinely-unattributable control lives in the AP-EXT-ITER195-01 block.
    const ev = readEvidence({
      sessionDir: f.sessionDir, ticketId: 'finl0123', workingDir: f.root, fallbackDir: f.root,
    });
    assert.notEqual(ev.via, 'inferred', 'no rung may accept an unresolvable stamped sha');
    assert.notEqual(ev.sha, HALLUCINATED_SHA, 'the hallucinated sha must never become evidence');
    assert.equal(ev.sha, f.sha, 'attribution falls through to the real trailered commit');
    assert.equal(ev.via, 'scan');
  } finally {
    f.cleanup();
  }
});
