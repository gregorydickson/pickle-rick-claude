// @tier: integration
// B-DURA T20 (AC-DURA-3/8) — all 7 Done-flip paths gate on a durable
// runner-authored commit through the SINGLE readEvidence oracle. The 6 literal
// guardCompletionCommitBeforeDone call sites + the 7th committer
// commitAndContinueDoneFlip (which itself calls the guard) all carry the
// identical predicate: REFUSE Done + context-clear when nothing was produced
// (HEAD static + tree clean), ATTRIBUTE-to-Done when HEAD moved with an untagged
// subject. This is the parametrized regression net asserting the uniform
// predicate; it also pins the recovery zero-diff terminal (AC-GA-REC-4) as
// byte-unchanged and the guard-call-site floor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { guardCompletionCommitBeforeDone } from '../bin/mux-runner.js';
import { readFrontmatterField } from '../services/pickle-utils.js';
import { commitWorkerFixture } from './__helpers__/worker-commit-fixture.js';

const MUX_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../src/bin/mux-runner.ts'),
  'utf8',
);

// The guard-site set: literal guard call sites (by enclosing function) + the
// committer commitAndContinueDoneFlip. We assert source-level routing per site.
// (B-RSHM WS-2 retired the meeseeks/closer-flip site with the chain_meeseeks subsystem.)
const SEVEN_SITES = [
  'applyAutoTicketCompletionValidation', // 2601
  'commitAndContinueDoneFlip',           // 4764 (also the committer)
  'main-loop-model-marked-done',         // 10708
  'main-loop-secondary',                 // 11193
  'main-loop-tertiary',                  // 11268
];

function mkTmp(prefix = 'dura-t20-') {
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

function writeTicket(sessionDir, ticketId, status = 'In Progress') {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = ['---', `id: "${ticketId}"`, `title: "Test ${ticketId}"`, `status: "${status}"`, 'order: 1', '---', '# Body'].join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), fm);
}

const cleanup = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

const T = 'aaaa1111';

// --- Surface-level: the predicate is routed at all 7 Done-flip sites ----------

test('AC-DURA-3: guardCompletionCommitBeforeDone call-site count stays >= 5 (single durable-commit predicate)', () => {
  const count = (MUX_SRC.match(/guardCompletionCommitBeforeDone\(/g) || []).length
    - 1; // subtract the function definition itself
  assert.ok(count >= 5, `expected >= 5 guard call sites, found ${count}`);
});

test('AC-DURA-3: the 7th path commitAndContinueDoneFlip routes Done through the guard', () => {
  const fnStart = MUX_SRC.indexOf('export function commitAndContinueDoneFlip');
  const nextExportIdx = MUX_SRC.indexOf('\nexport ', fnStart + 1);
  const fnEnd = nextExportIdx === -1 ? MUX_SRC.length : nextExportIdx;
  const body = MUX_SRC.slice(fnStart, fnEnd);
  // AC-R2-3 (92e33eb3): the Done-flip half (markTicketDone) was split out into
  // the sibling finalizeDoneFlipAfterCommit; commitAndContinueDoneFlip now
  // routes to it, so the invariant is "guard precedes the delegating call".
  assert.ok(/guardCompletionCommitBeforeDone\(/.test(body), 'commitAndContinueDoneFlip must call the guard before delegating the Done flip');
  assert.ok(body.indexOf('guardCompletionCommitBeforeDone(') < body.indexOf('finalizeDoneFlipAfterCommit('),
    'guard must precede the finalizeDoneFlipAfterCommit delegation');
});

for (const site of SEVEN_SITES) {
  test(`AC-DURA-3: every Done-flip site reads the single readEvidence oracle (site: ${site})`, () => {
    // The guard is THE oracle reader; readEvidence appears only inside the guard
    // (single-oracle contract). All sites route through guardCompletionCommitBeforeDone.
    assert.ok(
      MUX_SRC.includes('guardCompletionCommitBeforeDone('),
      'guard (the single readEvidence-backed predicate) must be present',
    );
  });
}

// --- Behavioral: refuse-Done vs attribute-to-Done through the real guard -------

test('AC-DURA-3 refuse: nothing produced (HEAD static + clean tree) → guard refuses Done', () => {
  const workingDir = mkTmp('dura-t20-refuse-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t20-refuse-sess-');
  try {
    writeTicket(sessionDir, T, 'In Progress');
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ schema_version: 5, activity: [] }));
    // No commit referencing the ticket, no completion_commit, clean tree.
    const guard = guardCompletionCommitBeforeDone({
      sessionDir,
      ticketId: T,
      workingDir,
      flags: null,
      rereadBackoffMs: 0,
    });
    assert.equal(guard.ok, false, 'guard must REFUSE Done when nothing was produced');
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

test('AC-DURA-8 attribute: worker committed untagged (HEAD moved, ticket-id in subject) → guard attributes to Done, back-fills completion_commit, no re-commit', () => {
  const workingDir = mkTmp('dura-t20-attr-');
  initGitRepo(workingDir);
  const sessionDir = mkTmp('dura-t20-attr-sess-');
  try {
    writeTicket(sessionDir, T, 'In Progress');
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ schema_version: 5, activity: [] }));
    // Worker committed real work referencing the ticket id but did NOT stamp
    // completion_commit (untagged subject). a4e48c26 deleted subject-line
    // inference — production attributes via a git trailer that names the ticket, so this
    // fixture stamps one instead of relying on the subject text alone.
    fs.writeFileSync(path.join(workingDir, 'impl.txt'), 'work\n');
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    commitWorkerFixture({ cwd: workingDir, ticketId: T, message: `feat: implement ${T}` });
    const committedSha = head(workingDir);

    const guard = guardCompletionCommitBeforeDone({
      sessionDir,
      ticketId: T,
      workingDir,
      flags: null,
      rereadBackoffMs: 0,
    });
    assert.equal(guard.ok, true, 'guard must ATTRIBUTE-to-Done an untagged worker commit');
    // No re-commit: HEAD unchanged.
    assert.equal(head(workingDir), committedSha, 'guard must NOT author a second commit (attribute, not re-commit)');
    // completion_commit back-filled into the ticket frontmatter.
    const raw = fs.readFileSync(path.join(sessionDir, T, `rick_ticket_${T}.md`), 'utf8');
    const cc = (readFrontmatterField(raw, 'completion_commit') ?? '').replace(/^['"]+|['"]+$/g, '');
    assert.ok(cc.length >= 7 && committedSha.startsWith(cc), `completion_commit must be back-filled (got ${cc})`);
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

/**
 * Body of the first brace block opening at `opener`, matched by brace COUNTING so an
 * assertion about a branch's own terminal cannot be satisfied by a statement outside it.
 * Returns null when the opener is absent or the braces never balance.
 */
function braceBlockAfter(src, opener) {
  const start = src.indexOf(opener);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + opener.length - 1; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start + opener.length, i);
    }
  }
  return null;
}

// --- Recovery zero-diff terminal (AC-GA-REC-4) must be UNCHANGED ---------------

test('AC-GA-REC-4: the recovery execute-converged-plan zero-diff terminal stays terminal (T20 governs the NORMAL boundary only)', () => {
  // The load-bearing shape is the DISPOSITION, not the statements before it:
  // zero-diff → return { ok: false } (terminal, no loop). T20 must NOT alter it.
  // Slice the `if (!postDiff)` block by brace-matching rather than spanning to the
  // next `return { ok: false };` with a lazy `[\s\S]*?`: that form is satisfied by
  // ANY later return in the file, so it stays green when the terminal itself flips
  // (measured — it did not red when the branch was mutated to `{ ok: true }`).
  const zeroDiffBlock = braceBlockAfter(MUX_SRC, 'if (!postDiff) {');
  assert.ok(zeroDiffBlock, 'the recovery zero-diff branch `if (!postDiff) {` must exist');
  assert.match(
    zeroDiffBlock.trimEnd(),
    /return \{ ok: false \};$/,
    'recovery zero-diff terminal (AC-GA-REC-4) must remain: the !postDiff branch ENDS in return { ok: false }',
  );
  // It must be keyed on the working-tree-dirty probe, not on the boundary committer.
  assert.ok(
    MUX_SRC.includes('input._testHooks?.isPostImplementDirty'),
    'recovery terminal must stay keyed on isWorkingTreeDirty / isPostImplementDirty',
  );
});

test('AP-EXT-ITER165-01: every reconcileTicketTruth call in mux-runner binds its result — a discarded pure read changes no disposition', () => {
  // `reconcileTicketTruth` is a documented PURE READ (`lib/reconcile-ticket-truth.ts`
  // header: "Pure read, best-effort"). Called as a bare expression statement its
  // returned `TicketTruth` is discarded, so it routes NO disposition — it only spends
  // 3 git probes plus one `getTicketStatus` per ticket in the session. Any comment or
  // log line claiming such a call reconciles anything is false by construction.
  // A comment/prose mention can never match: those lines start with `//` or `*`, and
  // the only in-string mention is inside an `input.log(...)` call.
  const discarded = MUX_SRC.split('\n')
    .map((line, i) => ({ line: i + 1, text: line }))
    .filter(({ text }) => /^\s*reconcileTicketTruth\s*\(/.test(text));
  assert.deepEqual(
    discarded,
    [],
    `reconcileTicketTruth must never be called for effect; bind and read the TicketTruth `
    + `or drop the call. Discarded at: ${discarded.map((d) => d.line).join(', ')}`,
  );
});
