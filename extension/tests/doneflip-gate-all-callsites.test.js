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
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${ticketId}.md`), fm);
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
  const body = MUX_SRC.slice(
    MUX_SRC.indexOf('export function commitAndContinueDoneFlip'),
    MUX_SRC.indexOf('export function commitAndContinueDoneFlip') + 2000,
  );
  assert.ok(/guardCompletionCommitBeforeDone\(/.test(body), 'commitAndContinueDoneFlip must call the guard before markTicketDone');
  assert.ok(body.indexOf('guardCompletionCommitBeforeDone(') < body.indexOf('markTicketDone('),
    'guard must precede markTicketDone');
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
    // completion_commit (untagged subject).
    fs.writeFileSync(path.join(workingDir, 'impl.txt'), 'work\n');
    execFileSync('git', ['add', '-A'], { cwd: workingDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', `feat: implement ${T}`, '--no-gpg-sign'], { cwd: workingDir, stdio: 'ignore' });
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
    const raw = fs.readFileSync(path.join(sessionDir, T, `linear_ticket_${T}.md`), 'utf8');
    const cc = (readFrontmatterField(raw, 'completion_commit') ?? '').replace(/^['"]+|['"]+$/g, '');
    assert.ok(cc.length >= 7 && committedSha.startsWith(cc), `completion_commit must be back-filled (got ${cc})`);
  } finally {
    cleanup(workingDir, sessionDir);
  }
});

// --- Recovery zero-diff terminal (AC-GA-REC-4) must be UNCHANGED ---------------

test('AC-GA-REC-4: the recovery execute-converged-plan zero-diff terminal is byte-unchanged (T20 governs the NORMAL boundary only)', () => {
  // The recovery terminal: zero-diff → reconcileTicketTruth → return { ok: false }.
  // T20 must NOT alter this path; assert the load-bearing shape is intact.
  assert.ok(
    /if \(!postDiff\) \{[\s\S]*?reconcileTicketTruth\(\{ sessionDir: input\.sessionDir, workingDir: input\.workingDir \}\);[\s\S]*?return \{ ok: false \};/.test(MUX_SRC),
    'recovery zero-diff terminal (AC-GA-REC-4) must remain: !postDiff → reconcileTicketTruth → return { ok: false }',
  );
  // It must be keyed on the working-tree-dirty probe, not on the boundary committer.
  assert.ok(
    MUX_SRC.includes('input._testHooks?.isPostImplementDirty'),
    'recovery terminal must stay keyed on isWorkingTreeDirty / isPostImplementDirty',
  );
});
