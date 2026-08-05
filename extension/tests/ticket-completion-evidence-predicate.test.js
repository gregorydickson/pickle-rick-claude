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
