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

const { detectAndRecoverHeadRegression, isFailedTicketTerminalExcludable, wouldResetOrphanCommit } =
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

    // The OTHER T40 failure mode the PRD names: on the HEAD-floor baseline the
    // window `start_commit..HEAD` is EMPTY, so no ticket's declared files can ever
    // look touched and the guard degenerates into a rubber stamp — every Failed
    // ticket is silently excludable, including the one it just correctly REFUSED
    // above. This is the assertion that proves T40's correctness is baseline-
    // DEPENDENT, which is the whole reason a wrong start_commit is a safety bug
    // and not merely a cosmetic one. Read-only on mux-runner.ts.
    const headFloorCtx = { sessionDir, workingDir: repo, startCommit: git(['rev-parse', 'HEAD'], repo) };
    assert.equal(
      isFailedTicketTerminalExcludable(headFloorCtx, touchedId),
      true,
      'HEAD-floor baseline -> empty window -> the guard rubber-stamps the ticket it correctly refused under the true baseline',
    );
  } finally {
    if (sessionTmp) rmSync(sessionTmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// AP-EXT-ITER103-01 — the fsck-tip scope filter inside `detectAndRecoverHeadRegression`
// decides whether a DANGLING commit is `git merge --ff-only`'d onto the branch. Its whole
// claim is "touched paths ⊆ scope.json:allowed_paths", so it must enumerate those paths
// through the same git contract the fence was built from. Both arms below are contract
// arms, and each is pinned separately: dropping either flag from `listRangeTouchedPaths`
// reddens exactly one of them.

/** Commit `files` (path -> contents) on `repo` and return the resulting sha. */
function commitFiles(repo, files, message) {
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), contents);
  }
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', message, '--no-gpg-sign'], repo);
  return git(['rev-parse', 'HEAD'], repo);
}

/**
 * Build a DANGLING descendant of HEAD by committing on a throwaway branch and deleting it.
 * `git fsck --no-reflogs` — the discovery the runtime uses — then reports it as a dangling
 * tip, and because it descends from HEAD the runtime's `merge --ff-only` can reach it.
 */
function makeDanglingTip(repo, mutate, message) {
  const branch = git(['symbolic-ref', '--short', 'HEAD'], repo);
  git(['checkout', '-q', '-b', 'ap103orphan'], repo);
  mutate();
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', message, '--no-gpg-sign'], repo);
  const tip = git(['rev-parse', 'HEAD'], repo);
  git(['checkout', '-q', branch], repo);
  git(['branch', '-qD', 'ap103orphan'], repo);
  return tip;
}

function runHeadRegression(repo, startCommit, allowedPaths, ticketId) {
  const sessionFix = makeSessionDir(repo);
  const { sessionDir, statePath } = sessionFix;
  writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({ allowed_paths: allowedPaths }));
  mkdirSync(path.join(sessionDir, ticketId), { recursive: true });
  writeFileSync(
    path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`),
    ['---', `id: ${ticketId}`, 'title: "ap103 fixture"', 'status: In Progress', '---'].join('\n'),
  );
  const result = detectAndRecoverHeadRegression({
    ticketId, workingDir: repo, startCommit, completionCommitSha: null,
    sessionDir, statePath, iteration: 1, log: () => {},
  });
  return { result, sessionTmp: sessionFix.tmp };
}

test('AP-EXT-ITER103-01(a): a rename-hidden out-of-scope deletion is not ff-reattached', () => {
  const repo = initRepo();
  let sessionTmp;
  try {
    // Eight similar lines so git's default -M50% rename detection fires on the move below.
    const START = commitFiles(repo, {
      'outofscope/legacy.ts': 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n',
      'extension/src/keep.ts': 'keep\n',
    }, 'base');

    const tip = makeDanglingTip(
      repo,
      () => git(['mv', 'outofscope/legacy.ts', 'extension/src/moved.ts'], repo),
      'worker: move legacy into src',
    );

    // Fixture precondition — without this the case pins nothing. Rename detection is ON by
    // default, so the pre-fix reader sees ONLY the in-scope destination and is blind to the
    // out-of-scope source the commit DELETES.
    assert.equal(
      git(['diff', '--name-only', `HEAD..${tip}`], repo),
      'extension/src/moved.ts',
      'fixture precondition: rename detection hides the out-of-scope source path',
    );

    const { result, sessionTmp: tmp } = runHeadRegression(repo, START, ['extension/src/'], 'ap103ren');
    sessionTmp = tmp;

    assert.equal(result.detected, true, 'the regressed HEAD is still detected');
    assert.notEqual(
      result.action, 'ff_reattached',
      'a tip whose rename DELETES a path outside allowed_paths must not be grafted onto the branch',
    );
    assert.equal(result.recovered, false);
    assert.equal(git(['rev-parse', 'HEAD'], repo), START, 'HEAD must not move');
    assert.equal(
      git(['cat-file', '-t', 'HEAD:outofscope/legacy.ts'], repo), 'blob',
      'the out-of-scope file the tip deletes is still on the branch',
    );
  } finally {
    if (sessionTmp) rmSync(sessionTmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER103-01(b): an in-scope-only tip is still ff-reattached (positive control)', () => {
  const repo = initRepo();
  let sessionTmp;
  try {
    const START = commitFiles(repo, { 'extension/src/keep.ts': 'keep\n' }, 'base');
    const tip = makeDanglingTip(
      repo,
      () => writeFileSync(path.join(repo, 'extension', 'src', 'added.ts'), 'added\n'),
      'worker: in-scope work',
    );

    const { result, sessionTmp: tmp } = runHeadRegression(repo, START, ['extension/src/'], 'ap103ctl');
    sessionTmp = tmp;

    assert.equal(result.action, 'ff_reattached', 'the fix must not disable reattach for a legitimately in-scope tip');
    assert.equal(result.recovered, true);
    assert.equal(git(['rev-parse', 'HEAD'], repo), tip);
  } finally {
    if (sessionTmp) rmSync(sessionTmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER103-01(c): a C-quoted in-scope path is still ff-reattached (the -z arm)', () => {
  const repo = initRepo();
  let sessionTmp;
  try {
    const START = commitFiles(repo, { 'extension/src/keep.ts': 'keep\n' }, 'base');
    // A TAB, not a non-ASCII character: `core.quotePath` C-quotes both, but a tab-bearing
    // name is byte-identical on every platform, while a `café.ts` fixture would be stored
    // NFD on macOS and NFC on Linux and the assertion would drift with the filesystem.
    const quoted = 'extension/src/tab\tname.ts';
    const tip = makeDanglingTip(
      repo,
      () => writeFileSync(path.join(repo, quoted), 'quoted\n'),
      'worker: in-scope path git C-quotes',
    );

    // Fixture precondition: the pre-fix reader really does see a quote-wrapped path, which
    // matches nothing in allowed_paths and denies a legitimately in-scope recovery.
    assert.equal(
      git(['diff', '--name-only', `HEAD..${tip}`], repo),
      '"extension/src/tab\\tname.ts"',
      'fixture precondition: core.quotePath C-quotes the in-scope path without -z',
    );

    const { result, sessionTmp: tmp } = runHeadRegression(repo, START, ['extension/src/'], 'ap103qtd');
    sessionTmp = tmp;

    assert.equal(result.action, 'ff_reattached', 'a C-quotable in-scope path must not deny the reattach');
    assert.equal(result.recovered, true);
    assert.equal(git(['rev-parse', 'HEAD'], repo), tip);
  } finally {
    if (sessionTmp) rmSync(sessionTmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});


// --- AP-EXT-ITER202-01 -------------------------------------------------------
// `wouldResetOrphanCommit` is the LAST guard before `guardedMicroverseRollback`
// runs `resetToSha` -> `git reset --hard`. Its ancestry probe is
// `git merge-base --is-ancestor`, which exits 0 for yes, 1 for no and 128 for an
// unresolvable ref, and leaves `status` null on a spawn error or on its own 5s
// timeout. The pre-fix probe returned `r.status === 0`, mapping that entire
// error space onto "provably NOT an ancestor" -> "the reset orphans nothing" ->
// the destructive reset proceeds and destroys the commit the guard exists to
// protect. The asymmetry that makes it reachable: the guard runs under a 5,000 ms
// deadline while the `git reset --hard` it gates runs under runCmd's 30,000 ms
// one, so any git slow enough to miss the guard's deadline is still fast enough
// to complete the reset.
//
// These cases drive the probe's error space through a PATH shim rather than
// asserting on source text, so they fail against the pre-fix runtime and cannot
// be satisfied by a comment. The negative control is not optional: a guard that
// answered `true` unconditionally would also pass the three fail-closed cases
// while permanently disabling every legitimate rollback.

/**
 * A `git` on PATH that faithfully delegates, except `merge-base` exits `code`.
 * Delegation restores the CALLER's PATH rather than resolving git's absolute
 * path with a `which` subprocess — no extra spawn, and no self-recursion (the
 * shim dir is not on the restored PATH).
 */
function makeGitShim(code) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-scsg-gitshim-'));
  const callerPath = process.env.PATH ?? '';
  writeFileSync(
    path.join(dir, 'git'),
    `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "merge-base" ]; then\n    echo "fatal: simulated probe failure" >&2\n    exit ${code}\n  fi\ndone\nPATH='${callerPath}' exec git "$@"\n`,
    { mode: 0o755 },
  );
  return dir;
}

function withPath(dir, fn) {
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

test('AP-EXT-ITER202-01: an ancestry probe that cannot answer preserves HEAD instead of reporting "no orphan"', () => {
  const repo = initRepo();
  const shim128 = makeGitShim(128);
  const emptyPath = mkdtempSync(path.join(tmpdir(), 'pickle-scsg-nogit-'));
  try {
    const target = commit(repo, 'base.txt', 'base'); // preIterSha, the reset destination
    const protectedSha = commit(repo, 'work.txt', 'gate-green ticket commit'); // postIterSha

    // Fixture precondition: resetting to `target` genuinely WOULD orphan
    // `protectedSha`, so the only correct verdict in every case below is `true`.
    assert.equal(
      execFileSync('git', ['merge-base', '--is-ancestor', target, protectedSha], {
        cwd: repo, encoding: 'utf-8', timeout: 15000,
      }) === '' ,
      true,
      'fixture precondition: target is a strict ancestor of protectedSha (reset would orphan)',
    );

    // Control: with a working probe the guard flags the orphan.
    assert.equal(
      wouldResetOrphanCommit({ workingDir: repo, target, protectedSha }),
      true,
      'control: a resolvable probe must flag the ff-descendant',
    );

    // (a) The probe errors (exit 128 — an unresolvable ref). Pre-fix: false.
    assert.equal(
      withPath(shim128, () => wouldResetOrphanCommit({ workingDir: repo, target, protectedSha })),
      true,
      'a probe exiting 128 proves nothing — it must not read as "no orphan"',
    );

    // (b) The probe cannot spawn at all (git absent -> status null, the same
    //     shape the 5s timeout produces). Pre-fix: false.
    assert.equal(
      withPath(emptyPath, () => wouldResetOrphanCommit({ workingDir: repo, target, protectedSha })),
      true,
      'an unspawnable probe proves nothing — it must not read as "no orphan"',
    );

    // Negative control: a genuinely divergent target orphans nothing, and the
    // guard must still say so. Without this, "return true always" passes above.
    git(['checkout', '-q', '-b', 'divergent', target], repo);
    const divergent = commit(repo, 'other.txt', 'divergent line');
    assert.equal(
      wouldResetOrphanCommit({ workingDir: repo, target: divergent, protectedSha }),
      false,
      'negative control: a provably non-ancestor target must still permit the reset',
    );
  } finally {
    rmSync(shim128, { recursive: true, force: true });
    rmSync(emptyPath, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});


// --- AP-EXT-ITER202-02 -------------------------------------------------------
// The twin of AP-EXT-ITER202-01, found by its Phase 2.5 replay: `resolveChainTip`
// repeated the same `git merge-base --is-ancestor` collapse INLINE (`r.status === 0`)
// instead of reusing the tri-state probe. A tip whose probe cannot answer is
// therefore dropped from `matching`, and dropping members silently changes the
// answer in two directions:
//
//   1 -> 0  the real chain TIP disappears and the candidate (an INTERIOR commit
//           of the chain) is returned as its own tip. HEAD ff-only reattaches to
//           the interior commit, the descendant work stays orphaned, and the run
//           still reports `ff_reattached` — a fake-green over lost commits.
//   2 -> 0  the `ambiguous` operator hold, which exists precisely because the
//           chain shape is unknowable, collapses into a confident wrong tip.
//
// Reached here through the exported `detectAndRecoverHeadRegression`, whose own
// ancestry check takes `isHeadAtOrBelowCommit`'s equality branch (HEAD === the
// pinned start_commit after the worker's reset) and so never spawns a probe of
// its own — the shim below reaches ONLY the chain-tip probe.

/** BASE -> START -> WORK1 -> WORK2, then a worker `reset --hard` back to START. */
function makeOrphanChainRepo() {
  const repo = initRepo();
  commit(repo, 'base.txt', 'base');
  const START = commit(repo, 'start.txt', 'start');
  const WORK1 = commit(repo, 'work1.txt', 'work one'); // recorded completion commit (interior)
  const WORK2 = commit(repo, 'work2.txt', 'work two'); // real chain TIP
  git(['reset', '--hard', START], repo);
  return { repo, START, WORK1, WORK2 };
}

test('AP-EXT-ITER202-02: a chain-tip probe that cannot answer holds instead of reattaching to the interior commit', () => {
  const { repo, START, WORK1, WORK2 } = makeOrphanChainRepo();
  const shim128 = makeGitShim(128);
  let sessionTmp;
  try {
    const fix = makeSessionDir(repo);
    sessionTmp = fix.tmp;

    // Control: with a resolvable probe the chain tip is found and HEAD lands on
    // WORK2, not on the recorded interior candidate WORK1. Without this case an
    // implementation that returned "unprovable" unconditionally would pass the
    // fail-closed assertions below while disabling every legitimate reattach.
    const control = detectAndRecoverHeadRegression({
      ticketId: 'ap20202a',
      workingDir: repo,
      startCommit: START,
      completionCommitSha: WORK1,
      sessionDir: fix.sessionDir,
      statePath: fix.statePath,
      iteration: 1,
      log: () => {},
    });
    assert.equal(control.detected, true, 'control: the reset-to-start regression is detected');
    assert.equal(control.recovered, true, 'control: a resolvable chain is reattachable');
    assert.equal(control.action, 'ff_reattached');
    assert.equal(git(['rev-parse', 'HEAD'], repo), WORK2, 'control: HEAD reattaches to the chain TIP');

    // Now the same regression with the chain-tip probe unable to answer.
    git(['reset', '--hard', START], repo);
    assert.equal(git(['rev-parse', 'HEAD'], repo), START);

    const blind = withPath(shim128, () => detectAndRecoverHeadRegression({
      ticketId: 'ap20202b',
      workingDir: repo,
      startCommit: START,
      completionCommitSha: WORK1,
      sessionDir: fix.sessionDir,
      statePath: fix.statePath,
      iteration: 2,
      log: () => {},
    }));

    // Pre-fix this asserted `true` / 'ff_reattached' with HEAD at WORK1: the tip
    // was dropped, the interior commit was mistaken for the tip, and WORK2 was
    // left on the floor under a success verdict.
    assert.equal(blind.detected, true, 'detection is unaffected (equality branch, no probe)');
    assert.equal(blind.recovered, false, 'an unprovable chain shape must not be reported recovered');
    assert.notEqual(blind.action, 'ff_reattached');
    assert.equal(
      git(['rev-parse', 'HEAD'], repo),
      START,
      'HEAD must stay put — never ff to an interior commit on an unproven chain shape',
    );
  } finally {
    rmSync(shim128, { recursive: true, force: true });
    if (sessionTmp) rmSync(sessionTmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER202-02(b): an unanswerable probe does not collapse the >1-tip ambiguous hold into a confident tip', () => {
  const repo = initRepo();
  const shim128 = makeGitShim(128);
  let sessionTmp;
  try {
    commit(repo, 'base.txt', 'base');
    const START = commit(repo, 'start.txt', 'start');
    const WORK1 = commit(repo, 'work1.txt', 'work one'); // interior, ancestor of BOTH tips
    commit(repo, 'tip-a.txt', 'tip a');
    git(['reset', '--hard', WORK1], repo);
    commit(repo, 'tip-b.txt', 'tip b');
    git(['reset', '--hard', START], repo);

    const fix = makeSessionDir(repo);
    sessionTmp = fix.tmp;

    // Control: two dangling tips both descend from WORK1 -> ambiguous -> hold.
    const control = detectAndRecoverHeadRegression({
      ticketId: 'ap20202c',
      workingDir: repo,
      startCommit: START,
      completionCommitSha: WORK1,
      sessionDir: fix.sessionDir,
      statePath: fix.statePath,
      iteration: 1,
      log: () => {},
    });
    assert.equal(control.recovered, false, 'control: an ambiguous chain holds for the operator');
    assert.equal(git(['rev-parse', 'HEAD'], repo), START);

    // Same fork, probe unable to answer. Pre-fix BOTH tips dropped out of
    // `matching`, so the hold became a confident ff to the interior WORK1.
    const blind = withPath(shim128, () => detectAndRecoverHeadRegression({
      ticketId: 'ap20202d',
      workingDir: repo,
      startCommit: START,
      completionCommitSha: WORK1,
      sessionDir: fix.sessionDir,
      statePath: fix.statePath,
      iteration: 2,
      log: () => {},
    }));
    assert.equal(blind.recovered, false, 'an unprovable fork must stay a hold, not become a tip');
    assert.notEqual(blind.action, 'ff_reattached');
    assert.equal(git(['rev-parse', 'HEAD'], repo), START, 'HEAD must stay put on an unprovable fork');
  } finally {
    rmSync(shim128, { recursive: true, force: true });
    if (sessionTmp) rmSync(sessionTmp, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
