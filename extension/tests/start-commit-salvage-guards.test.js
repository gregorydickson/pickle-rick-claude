// @tier: fast
// AC-SCPIN-4 — salvage-guard re-arm regression tests (READ-ONLY on mux-runner.ts).
//
// Pins two invariants that depend on the SESSION-START baseline being correct
// (the literal pinned `start_commit`, not a merge-base-style stand-in):
//
//  1. `detectAndRecoverHeadRegression` detects a worker's `git reset --hard`
//     back to the session-start commit when given the correct pinned baseline,
//     and is BLIND to the identical regressed HEAD when given an older,
//     merge-base-style baseline instead (the exact class the PRD describes as
//     "invisible to detectHeadRegression").
//  2. T40 `isFailedTicketTerminalExcludable` correctly excludes a Failed ticket
//     whose declared files were untouched in the `start_commit..HEAD` window,
//     and correctly refuses to exclude a ticket whose declared file WAS
//     touched — both signs of the conjunctive false-green guard.
//
// `isHeadAtOrBelowCommit` itself (mux-runner.ts:2468) is NOT exported, and this
// ticket is forbidden from adding an export or otherwise editing mux-runner.ts.
// `detectAndRecoverHeadRegression` (exported, mux-runner.ts:2684) calls it
// unconditionally at its top (mux-runner.ts:2699) with no short-circuit, unlike
// the exported `wouldResetOrphanCommit` wrapper which short-circuits on
// `protectedSha === target` and would mask the equality-branch scenario this
// test needs. See research_2026-07-12.md / plan_2026-07-12.md for the full
// reachability analysis.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

// R-PTSB: mux-runner.js is a session-writing bin, and this file loads it IN-PROCESS, so
// it shares this process's env. `getDataRoot()` reads PICKLE_DATA_ROOT at call time and
// otherwise resolves the operator's real ~/.local/share/pickle-rick, so the sandbox below
// is what keeps a fast-tier test off live session state. The import must stay DYNAMIC: a
// static one is hoisted above this assignment and would evaluate mux-runner.js unsandboxed.
const dataRoot = mkdtempSync(path.join(tmpdir(), 'pickle-scsg-dataroot-'));
process.env.PICKLE_DATA_ROOT = dataRoot;
after(() => rmSync(dataRoot, { recursive: true, force: true }));

const { detectAndRecoverHeadRegression, isFailedTicketTerminalExcludable } =
  await import('../bin/mux-runner.js');

function makeSessionDir(workingDir) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'pickle-scsg-session-'));
  const sessionDir = path.join(tmp, 'session');
  mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(
    statePath,
    JSON.stringify({
      active: true, schema_version: 5, working_dir: workingDir, step: 'implement',
      iteration: 1, max_iterations: 50, worker_timeout_seconds: 600,
      start_time_epoch: Math.floor(Date.now() / 1000), original_prompt: 'scsg test',
      session_dir: sessionDir, started_at: new Date().toISOString(), history: [],
      tmux_mode: false, backend: 'claude', activity: [], recovery_attempts: [],
    }),
  );
  return { tmp, sessionDir, statePath };
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 15000 }).trim();
}

function commit(repo, file, message) {
  writeFileSync(path.join(repo, file), `${message}\n`);
  git(['add', file], repo);
  git(['commit', '-q', '-m', message, '--no-gpg-sign'], repo);
  return git(['rev-parse', 'HEAD'], repo);
}

function initRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'pickle-scsg-repo-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 'scsg@test.local'], repo);
  git(['config', 'user.name', 'scsg'], repo);
  return repo;
}

test('AC-SCPIN-4(a): reset-to-session-start detected under correct baseline, blinded under merge-base baseline', () => {
  const repo = initRepo();
  let sessionTmp;
  try {
    const BASE = commit(repo, 'base.txt', 'base');
    const START = commit(repo, 'start.txt', 'start'); // pinned session-start commit
    const WORK = commit(repo, 'work.txt', 'work'); // worker's ticket-scoped commit
    git(['reset', '--hard', START], repo); // simulated worker regression: HEAD -> START, WORK now dangling
    assert.equal(git(['rev-parse', 'HEAD'], repo), START);

    const sessionFix = makeSessionDir(repo);
    sessionTmp = sessionFix.tmp;
    const { sessionDir, statePath } = sessionFix;

    // Blinded under a merge-base-style (older, wrong) baseline: isHeadAtOrBelowCommit(START,
    // BASE, repo) is neither equal nor "START is an ancestor of BASE" (BASE is OLDER than
    // START, so the ancestor direction fails) -> the regression goes undetected.
    const blinded = detectAndRecoverHeadRegression({
      ticketId: 'scsgblnd',
      workingDir: repo,
      startCommit: BASE,
      completionCommitSha: null,
      sessionDir,
      statePath,
      iteration: 1,
      log: () => {},
    });
    assert.equal(blinded.detected, false, 'merge-base-style baseline must NOT detect the reset');
    assert.equal(blinded.recovered, false);
    assert.equal(blinded.action, 'none');
    // Non-mutating: HEAD must be untouched by the blinded (early-return) call.
    assert.equal(git(['rev-parse', 'HEAD'], repo), START);

    // Detected under the correct pinned baseline: isHeadAtOrBelowCommit(START, START, repo) is
    // true via the equality branch. detectAndRecoverHeadRegression has no short-circuit ahead of
    // that check, so this reaches (and proves) the exact production code path.
    const detected = detectAndRecoverHeadRegression({
      ticketId: 'scsgdtct',
      workingDir: repo,
      startCommit: START,
      completionCommitSha: null,
      sessionDir,
      statePath,
      iteration: 1,
      log: () => {},
    });
    assert.equal(detected.detected, true, 'correct pinned baseline must detect the reset');
    // Corroboration that detection was real, not stubbed: the runtime's own ff-reattach fired
    // and moved HEAD back onto the discovered dangling WORK tip.
    assert.equal(detected.recovered, true);
    assert.equal(detected.action, 'ff_reattached');
    assert.equal(git(['rev-parse', 'HEAD'], repo), WORK);
  } finally {
    if (sessionTmp) rmSync(sessionTmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('AC-SCPIN-4(b): T40 isFailedTicketTerminalExcludable — empty-window excludable, declared-file-touched not excludable', () => {
  const repo = initRepo();
  let sessionTmp;
  try {
    const startCommit = commit(repo, 'init.txt', 'init');

    const sessionFix = makeSessionDir(repo);
    sessionTmp = sessionFix.tmp;
    const { sessionDir } = sessionFix;

    // Excludable case: ticket declares an untouched file; the window's one commit touches a
    // DIFFERENT file, so the window is non-empty in general but empty for THIS ticket.
    const excludableId = 'scsgexcl';
    mkdirSync(path.join(sessionDir, excludableId), { recursive: true });
    writeFileSync(
      path.join(sessionDir, excludableId, `rick_ticket_${excludableId}.md`),
      [
        '---',
        `id: ${excludableId}`,
        'title: "excludable fixture"',
        'status: Failed',
        '---',
        '## Files to modify/create',
        '- `extension/src/some/untouched-file.ts`',
      ].join('\n'),
    );

    // Not-excludable case: ticket declares the file that WAS touched in the window.
    const touchedId = 'scsgtchd';
    mkdirSync(path.join(sessionDir, touchedId), { recursive: true });
    writeFileSync(
      path.join(sessionDir, touchedId, `rick_ticket_${touchedId}.md`),
      [
        '---',
        `id: ${touchedId}`,
        'title: "not-excludable fixture"',
        'status: Failed',
        '---',
        '## Files to modify/create',
        '- `other.ts`',
      ].join('\n'),
    );

    // Advance the window with a commit that touches `other.ts` only.
    commit(repo, 'other.ts', 'touch other');
    assert.equal(git(['status', '--porcelain'], repo), ''); // clean tree at assertion time

    const ctx = { sessionDir, workingDir: repo, startCommit };
    assert.equal(
      isFailedTicketTerminalExcludable(ctx, excludableId),
      true,
      'declared file untouched in the window -> excludable',
    );
    assert.equal(
      isFailedTicketTerminalExcludable(ctx, touchedId),
      false,
      'declared file touched in the window -> NOT excludable',
    );
  } finally {
    if (sessionTmp) rmSync(sessionTmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
