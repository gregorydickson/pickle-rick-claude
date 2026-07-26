// @tier: fast
//
// B-NOSTOP-GATES WS-2 — a declared zero-diff ticket must never be handed a
// foreign SHA (AC-NSG-7, AC-NSG-9, AC-NSG-10).
//
// Reuses the SHAPE of `zero-diff-completion-arm.test.js`'s fixture helpers
// (medium-tier artifact set, git repo + ticket-dir writer) but duplicates the
// small helpers locally rather than importing — that file is byte-pinned
// (AC-NSG-8b) and must stay untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluateCompletionEvidence } from '../services/ticket-completion-evidence.js';

/** The medium-tier lifecycle artifact set (TIER_LIFECYCLE-derived). */
const MEDIUM_TIER_ARTIFACTS = [
  'research_2026-07-24.md',
  'research_review.md',
  'plan_2026-07-24.md',
  'plan_review.md',
  'conformance_2026-07-24.md',
  'code_review_2026-07-24.md',
];

function mkTmp(prefix) {
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

function commitWith(dir, file, message) {
  fs.writeFileSync(path.join(dir, file), `work for ${file}\n`);
  execFileSync('git', ['add', file], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', message, '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicketFile(sessionDir, ticketId, frontmatterLines, { artifacts = [] } = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${ticketId}.md`),
    `---\n${frontmatterLines.join('\n')}\n---\n\n# Fixture\n`,
  );
  for (const name of artifacts) {
    fs.writeFileSync(path.join(ticketDir, name), 'artifact\n');
  }
  return ticketDir;
}

function ticketPath(sessionDir, ticketId) {
  return path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
}

function zeroDiffIntentResolverFor(sessionDir, ticketId) {
  return () => {
    const raw = fs.readFileSync(ticketPath(sessionDir, ticketId), 'utf8');
    const m = /^zero_diff_intent:\s*(.+)$/m.exec(raw);
    return m ? m[1].trim() : null;
  };
}

// ---------------------------------------------------------------------------
// AC-NSG-7 — declared zero-diff + a scan hit that a SIBLING's commit would
// otherwise satisfy (the sibling's message names BOTH itself and this
// ticket's own id — own-attribution wins under R-OMA, so the scan-arm
// symmetric guard alone (fix b) would NOT reject it). Fix (a) — the
// zero-diff scan-borrow exclusion — is what stops the borrow here: a
// declared zero-diff ticket's scan-sourced evidence is never a promote
// target, regardless of whose commit it resolves to.
// ---------------------------------------------------------------------------

test('AC-NSG-7: declared zero-diff ticket never borrows a scan-sourced sha, even an own-attributed one', () => {
  const root = mkTmp('pickle-nsg7-');
  try {
    initGitRepo(root);
    // Names the SIBLING's own work but also touches this ticket's id — R-OMA
    // would call this "own wins" (not foreign), so fix (b) alone would still
    // let the scan arm accept it. Only fix (a) (zero-diff scan-borrow
    // exclusion) prevents this sibling-authored sha from being promoted onto
    // a ticket that declared it produces no commit of its own.
    commitWith(root, 'sibwork.txt', 'feat(ws2sib02): sibling delivers real work; touches ws2ad001 tracking doc');

    const sessionDir = path.join(root, 'session');
    writeTicketFile(sessionDir, 'ws2sib02', ['id: ws2sib02', 'status: "Done"']);
    writeTicketFile(sessionDir, 'ws2ad001', [
      'id: ws2ad001',
      'title: "WS-2 audit ticket"',
      'status: "In Progress"',
      'complexity_tier: medium',
      'zero_diff_intent: audit',
    ], { artifacts: MEDIUM_TIER_ARTIFACTS });

    const ctx = {
      sessionDir,
      ticketId: 'ws2ad001',
      workingDir: root,
      startCommit: null,
      pinnedSha: null,
      decision: 'done-flip',
      rereadBackoffMs: 0,
      workerGateVerdict: () => ({ verdict: 'green', computedVia: 'fixture' }),
      zeroDiffIntent: zeroDiffIntentResolverFor(sessionDir, 'ws2ad001'),
    };

    const decision = evaluateCompletionEvidence(ctx);
    assert.equal(decision.ok, true, `expected zero-diff accept, got reason=${decision.reason ?? 'n/a'}`);
    assert.equal(decision.via, 'zero-diff');
    assert.equal(decision.sha, undefined,
      'a zero-diff accept must carry NO sha — a borrowed sibling sha must never be stamped');

    const raw = fs.readFileSync(ticketPath(sessionDir, 'ws2ad001'), 'utf8');
    assert.equal(/^completion_commit:/m.test(raw), false,
      'no completion_commit field may be persisted for a zero-diff accept — the sibling sha must never land on disk');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-NSG-9 — R-PDUP unchanged: a genuine split original WITHOUT a
// zero_diff_intent declaration still auto-closes with the twin's sha via the
// sanctioned ownAttributionTokens borrow; the field lands EXPLICIT, never
// `_inferred` (preserves the 20MB-state infinite-loop guard).
// ---------------------------------------------------------------------------

test('AC-NSG-9: genuine split-original ticket still auto-closes via the twin sha, EXPLICIT never inferred', () => {
  const root = mkTmp('pickle-nsg9-');
  try {
    initGitRepo(root);
    const twinSha = commitWith(root, 'twin.txt', 'feat(spl1twin): twin delivers the split work');

    const sessionDir = path.join(root, 'session');
    writeTicketFile(sessionDir, 'spl1twin', ['id: spl1twin', 'status: "Done"']);
    // Mirrors maybeAutoCloseSplitOriginal's real wiring: the split-original ticket
    // is stamped with the twin's sha EXPLICITLY (mux-runner writes this directly,
    // outside ticket-completion-evidence — this fixture reproduces that
    // pre-condition), not discovered by the scan arm.
    writeTicketFile(sessionDir, 'spl1orig', [
      'id: spl1orig',
      'status: "In Progress"',
      `completion_commit: "${twinSha}"`,
    ]);

    const ctx = {
      sessionDir,
      ticketId: 'spl1orig',
      workingDir: root,
      startCommit: null,
      pinnedSha: null,
      decision: 'done-flip',
      rereadBackoffMs: 0,
      // The twin's id is injected as a sanctioned own-attribution token so
      // R-OMA does not reject the borrowed sha as foreign_attribution.
      ownAttributionTokens: ['spl1twin'],
      workerGateVerdict: () => ({ verdict: 'green', computedVia: 'fixture' }),
    };

    const decision = evaluateCompletionEvidence(ctx);
    assert.equal(decision.ok, true, `expected committed accept via the twin sha, got reason=${decision.reason ?? 'n/a'}`);
    assert.equal(decision.sha, twinSha);

    const raw = fs.readFileSync(ticketPath(sessionDir, 'spl1orig'), 'utf8');
    const explicit = /^completion_commit:\s*"?([0-9a-f]+)"?\s*$/m.exec(raw);
    assert.ok(explicit, 'the twin sha must stay in the EXPLICIT completion_commit field');
    assert.equal(explicit[1], twinSha);
    assert.equal(/^completion_commit_inferred:/m.test(raw), false,
      'R-PDUP: the twin-borrow must never write completion_commit_inferred (the 20MB-state infinite-loop guard)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC-NSG-10 — field replay: reconstruct ticket 7af891d4's real reported
// frontmatter shape. The end-to-end verdict must be committed-or-zero-diff,
// NEVER `absent` — this is the literal wedge that stopped a 4-phase pipeline
// 0/4 with 6/6 siblings Done.
// ---------------------------------------------------------------------------

test('AC-NSG-10: field replay of the reported wedge (7af891d4) resolves committed-or-zero-diff, never absent', () => {
  const root = mkTmp('pickle-nsg10-');
  try {
    initGitRepo(root);
    // Both siblings cite the same bundle-generic R-code this ticket's own
    // title also mentions, and each names itself. Newest-first git log makes
    // the "most recent match" keep shifting sibling-to-sibling as HEAD
    // advances — the literal moving-SHA observation from the incident.
    commitWith(root, 'a.txt', 'fix(33f4960b): sibling delivers work, refs R-NSGWEDGE');
    commitWith(root, 'b.txt', 'audit(ef394937): sibling audit work, refs R-NSGWEDGE');

    const sessionDir = path.join(root, 'session');
    writeTicketFile(sessionDir, '33f4960b', ['id: 33f4960b', 'status: "Done"']);
    writeTicketFile(sessionDir, 'ef394937', ['id: ef394937', 'status: "Done"']);
    writeTicketFile(sessionDir, '7af891d4', [
      'id: 7af891d4',
      'title: "WS-2 stop stamping a foreign SHA — R-NSGWEDGE bundle"',
      'status: "In Progress"',
      'complexity_tier: medium',
      'zero_diff_intent: audit',
    ], { artifacts: MEDIUM_TIER_ARTIFACTS });

    const ctx = {
      sessionDir,
      ticketId: '7af891d4',
      workingDir: root,
      startCommit: null,
      pinnedSha: null,
      decision: 'done-flip',
      rereadBackoffMs: 0,
      workerGateVerdict: () => ({ verdict: 'green', computedVia: 'fixture' }),
      zeroDiffIntent: zeroDiffIntentResolverFor(sessionDir, '7af891d4'),
    };

    const decision = evaluateCompletionEvidence(ctx);
    assert.equal(decision.ok, true,
      `field replay must resolve committed-or-zero-diff, never absent — got reason=${decision.reason ?? 'n/a'}`);
    if (!decision.ok) {
      assert.notEqual(decision.reason, 'foreign_attribution');
      assert.notEqual(decision.reason, 'baseline_sha');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
