// @tier: integration
// B-CWGE WS-2 (R-CWGE): the recorded worker-gate verdict is authoritative on EVERY
// Done-flip path. guardCompletionCommitBeforeDone (mux-runner.ts) fail-CLOSES on a
// red OR absent/unverifiable verdict.
//
// For a NORMAL committed ticket with NO recorded worker-gate verdict, WS-2 computes one
// via the between-ticket fast gate. This temp-repo harness builds an off-repo fixture by
// DEFAULT — no `extension/` dir — so the JS worker gate is NOT APPLICABLE (a non-pickle-rick
// target, e.g. loanlight-api) -> Done flips (NOT universally fail-closed). The core
// fail-closed behavior is pinned by the explicit `worker_gate_verdict: red` case below,
// which opts INTO the on-repo shape via `setup({ onRepo: true })` because fail-closed is an
// ON-repo contract (see that test's comment); `worker_gate_verdict: green` flips Done.
//
// B-OFFREPO (AC-OFFREPO-1) — THE MECHANISM CHANGED, THE OUTCOME DID NOT. This premise
// used to read "=> verdict 'green'". That was the bug, written down as an expectation:
// the resolver returned `{verdict:'green', computedVia:'worker_gate'}` for a gate that
// issued no command, asserting AUTHORSHIP over a verdict no gate produced. The Done flip
// is still permitted — refusing it would fail-close every non-pickle-rick target, i.e. a
// gate stopping the pipeline — but the permission now comes from the Done-flip POLICY
// (`not_run` routes through the gate-exempt evaluation) rather than from a manufactured
// pass. The two assertions below are UNCHANGED in subject: `guard.ok === true` and the
// sha is still attributed. Only the message naming the mechanism was corrected, and the
// new assertions pin the honest disposition the outcome now rests on.
//
// Harness mirrors guard-completion-commit-tsc-gate.test.js: real git repo + temp
// session dir, explicit git-reachable completion_commit, PICKLE_TEST_MODE UNSET so the
// real evidence + verdict path runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwge-data-')));
process.env.PICKLE_DATA_ROOT = DATA_ROOT;

const {
  guardCompletionCommitBeforeDone,
  resolveWorkerGateVerdict,
  WORKER_GATE_NOT_RUN_REASON,
} = await import('../../bin/mux-runner.js');

/** B-OFFREPO: the `gate_skipped` residuals a did-not-run gate records into state.json. */
function readNotRunResiduals(sessionDir) {
  const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
  return (Array.isArray(state.activity) ? state.activity : [])
    .filter(entry => entry.event === 'gate_skipped' && entry.gate_payload?.reason === WORKER_GATE_NOT_RUN_REASON);
}

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwge-guard-')));
}

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function initRepo(repoDir) {
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
}

function commitFile(repoDir, name, body, msg) {
  fs.writeFileSync(path.join(repoDir, name), body);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', msg]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

// A NORMAL committed ticket: explicit completion_commit, NO failed_reason. The optional
// `verdict` adds a `worker_gate_verdict` frontmatter field; omitted => absent.
function writeTicket(sessionDir, ticketId, sha, { verdict } = {}) {
  const dir = path.join(sessionDir, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `id: ${ticketId}`, 'status: In Progress', `completion_commit: ${sha}`];
  if (verdict !== undefined) { lines.push(`worker_gate_verdict: ${verdict}`); }
  lines.push('---', '');
  fs.writeFileSync(path.join(dir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
}

function writeState(sessionDir, startCommit) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ schema_version: 5, start_commit: startCommit, pinned_sha: null }));
}

// The guard early-returns ok:true under PICKLE_TEST_MODE=1 — this test MUST exercise
// the REAL evidence + disposition path, so the var must be unset and restored after.
function withoutTestMode(fn) {
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  try { return fn(); } finally { if (prev !== undefined) { process.env.PICKLE_TEST_MODE = prev; } }
}

// `onRepo` opts the fixture into the PICKLE-RICK shape by creating the `extension/` tree.
// That directory is exactly what `isAdvisoryWorkerGateVerdict` (mux-runner.ts) probes to
// tell "our own repo" from "a target repo", so it is load-bearing for any assertion about a
// RED verdict. Default OFF: the off-repo shape is the one the not-applicable cases need.
function setup({ verdict, onRepo = false } = {}) {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  if (onRepo) { fs.mkdirSync(path.join(root, 'extension'), { recursive: true }); }
  initRepo(root);
  const baseline = commitFile(root, 'init.txt', 'init', 'baseline');
  const real = commitFile(root, 'work.txt', 'real work', 'feat: real ticket work');
  writeTicket(sessionDir, 'abc12345', real, { verdict });
  writeState(sessionDir, baseline);
  return { root, sessionDir, real };
}

// AC-CWGE-6 (gate not applicable): a normally-committed ticket with NO recorded
// worker-gate verdict computes one via the between-ticket fast gate. The temp-repo harness
// has no `extension/` dir (a non-pickle-rick target), so the JS worker gate is NOT
// applicable -> verdict 'not_run' -> Done flips. This pins that fail-closed does NOT
// universally refuse Done-flips on non-pickle-rick repos (regression guard).
test('R-CWGE WS-2: absent verdict on a non-pickle-rick target (no extension/) flips Done (gate not applicable)', () => {
  withoutTestMode(() => {
    const { root, sessionDir, real } = setup();
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true, 'no extension/ dir => worker gate not applicable => verdict not_run => Done flips');
    assert.equal(guard.sha, real, 'the committed sha is attributed');

    // B-OFFREPO: the disposition the flip now rests on. `not_run` is the honest
    // third verdict, and `computedVia` names no gate — nothing measured this tree.
    const resolved = resolveWorkerGateVerdict(sessionDir, 'abc12345', root);
    assert.equal(resolved.verdict, 'not_run', 'a gate that could not run reports not_run, never green');
    assert.equal(resolved.computedVia, 'not_applicable', 'no gate may be named as the author of an unrun verdict');

    // The permissiveness is no longer silent: the unverified state is recorded.
    const residuals = readNotRunResiduals(sessionDir);
    assert.equal(residuals.length, 1, 'the unrun gate leaves exactly one residual');
    assert.equal(residuals[0].ticket_id, 'abc12345', 'the residual names the ticket');
  });
});

// AC-CWGE-3: an explicit GREEN verdict preserves the happy path.
test('R-CWGE WS-2: explicit worker_gate_verdict=green flips Done (happy path preserved)', () => {
  withoutTestMode(() => {
    const { root, sessionDir, real } = setup({ verdict: 'green' });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true, 'a recorded green verdict flips Done');
    assert.equal(guard.sha, real, 'the committed sha is attributed');
  });
});

// AC-CWGE-4: an explicit RED verdict on PICKLE-RICK'S OWN repo is fail-closed.
//
// B-OFFREPO: this fixture must be ON-repo (`onRepo: true`). `isAdvisoryWorkerGateVerdict`
// (mux-runner.ts) reads a red as ADVISORY when `<workingDir>/extension` is absent, because a
// red authored by a target repo's own toolchain is a finding to flag, not a refusal to issue
// — otherwise one failing test in a target repo would refuse the Done flip on every ticket
// and halt the pipeline. The `extension/` tree is what makes this fixture pickle-rick rather
// than a target, and pickle-rick's OWN red still fail-closes. Left off-repo (as it was
// written), this assertion would be pinning the advisory path while claiming to pin
// fail-closed — it would green over its own subject. The off-repo disposition of a red is
// pinned separately in tests/worker-gate-offrepo-runs.test.js; the same distinction is drawn
// at the sibling Done-flip authority in tests/setup.test.js.
test('R-CWGE WS-2: explicit worker_gate_verdict=red on pickle-rick itself is fail-CLOSED', () => {
  withoutTestMode(() => {
    const { root, sessionDir } = setup({ verdict: 'red', onRepo: true });
    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, false, 'a recorded red verdict on our own repo must NOT flip Done (R-CWGE fail-closed)');
  });
});
