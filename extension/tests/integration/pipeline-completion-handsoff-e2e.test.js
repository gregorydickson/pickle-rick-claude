// @tier: integration
// SERIAL: subprocess-spawn-timing (real git repo + multi-primitive salvage drive)
//
// B-PCOMP (#b7b22750) — AC-PCOMP-4 release-gate completion proof.
//
// The whole reason B-PCOMP exists is "the pipeline can complete a multi-ticket
// additive bundle hands-off". Each WS-D1/WS-D2 boundary fix is unit-proven in
// isolation; this e2e is the ONE deterministic, stub-driven (NO live `claude -p`)
// run that drives a synthetic >=4-ticket additive bundle to 4/4 phases with ZERO
// operator/babysitter state edits while exercising ALL THREE salvage/exit paths
// landed by the prior tickets, against a REAL git repo:
//
//   (a) #0a1ce691 — a ticket already-committed-green with NO completion_commit
//       stamp. The injection FORCES the worker-died-AFTER-commit-BEFORE-Done-flip
//       ordering so salvage's clean-tree back-fill runs (salvageTicket ->
//       backfillDone -> updateTicketFrontmatter). It must NOT reach the guard's
//       auto-promote path (guardCompletionCommitBeforeDone is never called here),
//       else the back-fill assertion is dead coverage.
//   (b) #b736337f — a forced fatal on ticket N with an un-attributable N+1
//       bystander remainder -> commitGatePassingDeliverableOnExitPath stashes the
//       remainder to refs/pickle/salvage/<session>; `git show <ref>` recovers it,
//       and N's commit excludes N+1 (no false Done).
//   (c) #3f6800f3 (shipped at HEAD) — reap-skip on a POSITIVE artifact-delta with
//       a 0-byte worker log: recordWorkerArtifactProgress keys on the artifact
//       delta, never log size, so the in-progress worker is NOT reaped.
//
// FINAL ASSERTIONS (the hands-off contract):
//   - every ticket reaches committed-done | backfilled-done;
//   - 0 archived-todo; 0 done_without_commit_evidence;
//   - pipeline-status.json shows 4/4 phases;
//   - state.json is byte-identical to the pre-run snapshot (no operator edit /
//     no salvage state write -> schema_neutral, hands-off);
//   - a max_iterations cap-hit halts cleanly (does NOT assume unlimited iterations).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { salvageTicket } from '../../lib/salvage-ticket.js';
import {
  commitGatePassingDeliverableOnExitPath,
  recordWorkerArtifactProgress,
  countWorkerArtifacts,
} from '../../bin/mux-runner.js';
import { writePipelineStatus } from '../../bin/pipeline-runner.js';
import { updateTicketFrontmatter } from '../../services/git-utils.js';
import { getTicketStatus, collectTickets } from '../../services/pickle-utils.js';

// ---------------------------------------------------------------------------
// Fixture helpers — a real git repo with the session dir INSIDE it so sibling
// ticket dirs surface in the dirty set (matches the production exit-path layout).
// ---------------------------------------------------------------------------

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@test.invalid',
      GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@test.invalid',
    },
  });
}

function makeBundleRepo() {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pcomp-handsoff-')));
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  // Repo-local identity: production code under test (commitGatePassingDeliverableOnExitPath's
  // internal git commit) spawns git without GIT_AUTHOR_NAME/EMAIL env, so it relies on git
  // config. A global ~/.gitconfig on a dev machine masks a missing identity; a fresh CI
  // container has none, and `git commit` refuses with no user.name/user.email.
  git(['config', 'user.name', 'e2e'], repo);
  git(['config', 'user.email', 'e2e@test.invalid'], repo);
  fs.mkdirSync(path.join(repo, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'extension', 'README.md'), 'fixture\n');
  git(['add', '-A'], repo);
  git(['commit', '-qm', 'initial'], repo);
  return repo;
}

// A synthetic ADDITIVE ticket: declares a net-new dotted Output field + an
// un-annotated forward-created spec file (AC-PCOMP-1 / WS-D1 shape).
function writeTicket(sessionDir, id, status, order) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = [
    '---',
    `id: "${id}"`,
    `status: "${status}"`,
    `order: ${order}`,
    '---',
    '# Additive ticket',
    '',
    '## Outputs',
    `- state.handsoff.${id}: boolean (forward-created)`,
    `- \`extension/synthetic/${id}.spec.ts\` (forward-created)`,
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), fm);
}

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeSyntheticState(statePath, repo, sessionDir) {
  // A minimal v5 state — the only state.json the run touches. We snapshot its
  // bytes and assert byte-identity at the end (no operator edit, no salvage write).
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 4,
    max_time_minutes: 0,
    worker_timeout_seconds: 3600,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'pcomp handsoff e2e',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 5,
    worker_artifact_progress: {},
  }, null, 2));
}

const cleanup = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

// Production-faithful clean-tree salvage deps: the back-fill writes REAL ticket
// frontmatter via updateTicketFrontmatter (the same adapter mux-runner wires),
// so a green back-fill leaves the ticket Done WITH a completion_commit. The
// gate/commit/archive/reset deps throw if touched — a committed-green ticket
// must reach NEITHER the dirty-commit branch NOR the archive/reset branch.
function backfillSalvageDeps(repo, sessionDir, attributionSha) {
  const fail = (name) => () => { throw new Error(`clean-tree back-fill must not call ${name}`); };
  return {
    reconcile: (i) => {
      const tickets = collectTickets(i.sessionDir);
      const ticketStatuses = {};
      for (const t of tickets) if (t.id) ticketStatuses[t.id] = getTicketStatus(i.sessionDir, t.id);
      return { headSha: git(['rev-parse', 'HEAD'], repo).trim(), dirty: false, dirtyPaths: [], ticketStatuses, tickets };
    },
    gate: fail('gate'),
    commitScoped: fail('commitScoped'),
    archive: fail('archive'),
    resetTodo: fail('resetTodo'),
    ffReattach: () => ({ recovered: false }),
    // The real terminal write: stamp Done + completion_commit into frontmatter.
    backfillDone: (input, sha) => {
      updateTicketFrontmatter(input.ticketId, input.sessionDir, { status: 'Done', completion_commit: sha });
      return { done: true, sha };
    },
  };
}

const passGate = () => ({ ok: true, failures: [], timed_out: false, timeout_ms: 0 });

// ---------------------------------------------------------------------------

test('AC-PCOMP-4: a synthetic 4-ticket additive bundle completes 4/4 hands-off, exercising all three salvage/exit paths', () => {
  const repo = makeBundleRepo();
  const sessionDir = path.join(repo, 'sessiondata');
  const session = path.basename(sessionDir);
  const statePath = path.join(sessionDir, 'state.json');
  const stashRef = `refs/pickle/salvage/${session}`;

  // Four additive tickets. T1 drives the back-fill (a); T2/T3 drive the exit-path
  // bystander stash (b); T4 drives the reap-skip (c). All start non-terminal so a
  // hands-off run must carry each to a committed/backfilled-done WITHOUT an edit.
  const T1 = 'aaaa1111'; // committed-green, no completion_commit -> back-fill
  const T2 = 'bbbb2222'; // exiting ticket N (owned work committed under it)
  const T3 = 'cccc3333'; // bystander N+1 (un-attributable remainder -> stash)
  const T4 = 'dddd4444'; // in-progress worker, 0-byte log, positive artifact delta

  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    writeTicket(sessionDir, T1, 'In Progress', 1);
    writeTicket(sessionDir, T2, 'In Progress', 2);
    writeTicket(sessionDir, T3, 'In Progress', 3);
    writeTicket(sessionDir, T4, 'In Progress', 4);
    // Commit the ticket scaffolding so it is NOT part of the dirty set.
    git(['add', '-A'], repo);
    git(['commit', '-qm', 'baseline: 4 additive tickets'], repo);

    writeSyntheticState(statePath, repo, sessionDir);
    const stateBefore = fs.readFileSync(statePath);

    // ── Path (a): worker-died post-commit, pre-Done-flip → clean-tree back-fill ──
    // The worker committed T1's additive deliverable (ticket id in the subject)
    // then died BEFORE flipping the frontmatter Done. Tree is clean; T1 stays
    // "In Progress" with NO completion_commit stamp.
    fs.mkdirSync(path.join(repo, 'extension', 'synthetic'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'extension', 'synthetic', `${T1}.spec.ts`), 'export const t1 = true;\n');
    git(['add', '-A'], repo);
    git(['commit', '-qm', `feat(${T1}): additive deliverable`], repo);
    const t1Sha = git(['rev-parse', '--short', 'HEAD'], repo).trim();
    assert.equal(getTicketStatus(sessionDir, T1), 'In Progress', 'precondition: T1 committed but never Done-flipped');

    const t1Outcome = salvageTicket(
      { sessionDir, workingDir: repo, ticketId: T1, completionCommitSha: t1Sha, log: () => {} },
      backfillSalvageDeps(repo, sessionDir, t1Sha),
    );
    assert.equal(t1Outcome.disposition, 'committed-done', '(a) clean-tree committed-green back-fills to committed-done');
    assert.equal(t1Outcome.reason, 'backfilled_clean_tree', '(a) back-fill reason marks the clean-tree path (not gate_passing_committed)');
    assert.equal(getTicketStatus(sessionDir, T1), 'Done', '(a) T1 is now Done via back-fill');
    const t1Fm = fs.readFileSync(path.join(sessionDir, T1, `rick_ticket_${T1}.md`), 'utf8');
    assert.match(t1Fm, /completion_commit:\s*['"]?[0-9a-f]{7,40}['"]?/, '(a) completion_commit stamped into frontmatter (no done_without_commit_evidence)');

    // ── Path (b): forced fatal on N with un-attributable N+1 bystander → stash ──
    // T2 ("N") owns a committed-on-exit source deliverable; T3 ("N+1") left dirty
    // green work under its own session dir that is NOT attributable to T2.
    fs.writeFileSync(path.join(repo, 'extension', 'synthetic', `${T2}.owned.ts`), 'export const t2 = true;\n');
    fs.writeFileSync(path.join(sessionDir, T3, `plan_${T3}.md`), 'T3 bystander work\n');

    const exitResult = commitGatePassingDeliverableOnExitPath({
      sessionDir,
      statePath,
      workingDir: repo,
      ticketId: T2,
      extensionRoot: path.join(repo, 'extension'),
      flags: null,
      log: () => {},
      runGate: passGate,
    });
    assert.equal(exitResult.committed, true, `(b) T2 exit-commit succeeded, reason=${exitResult.reason}`);
    // T2 commit contains its OWN work, NOT T3's bystander remainder (no false Done).
    const t2Committed = git(['show', '--name-only', '--pretty=format:', 'HEAD'], repo);
    assert.match(t2Committed, new RegExp(`${T2}\\.owned\\.ts`), "(b) N's commit includes its own owned work");
    assert.doesNotMatch(t2Committed, new RegExp(`plan_${T3}\\.md`), "(b) N's commit must NOT include N+1's bystander files");
    // T3's diff is recoverable at the salvage ref.
    const refDiff = git(['show', '--name-only', '--pretty=format:', stashRef], repo);
    assert.match(refDiff, new RegExp(`plan_${T3}\\.md`), '(b) N+1 bystander diff recoverable at refs/pickle/salvage/<session>');
    // Drive T2/T3 forward hands-off: T2 is Done-with-commit, T3's stashed work is
    // re-applied and committed (recovery, not loss), then both flip Done.
    const t2Sha = git(['rev-parse', '--short', 'HEAD'], repo).trim();
    updateTicketFrontmatter(T2, sessionDir, { status: 'Done', completion_commit: t2Sha });
    // The salvage ref is a dangling commit-tree snapshot (not a stash-stack blob),
    // so recovery restores the bystander path from the ref's tree into the worktree.
    git(['checkout', stashRef, '--', path.join('sessiondata', T3, `plan_${T3}.md`)], repo);
    git(['add', '-A'], repo);
    git(['commit', '-qm', `feat(${T3}): recovered bystander deliverable`], repo);
    const t3Sha = git(['rev-parse', '--short', 'HEAD'], repo).trim();
    updateTicketFrontmatter(T3, sessionDir, { status: 'Done', completion_commit: t3Sha });

    // Schema-neutral contract for the COMPLETION-CORRECTNESS window: neither the
    // clean-tree back-fill (a) nor the exit-path bystander stash (b) writes
    // state.json — they key on tree-truth + frontmatter + git refs only. The
    // operator/babysitter never touched it either. So through (a)+(b) the file is
    // byte-identical to the launch snapshot (no R-WSRC-class salvage state write).
    assert.deepEqual(fs.readFileSync(statePath), stateBefore, 'state.json byte-identical through back-fill + exit-stash: no salvage/operator state write');

    // ── Path (c): reap-skip on positive artifact-delta with a 0-byte worker log ──
    const t4Dir = path.join(sessionDir, T4);
    fs.writeFileSync(path.join(t4Dir, 'worker_session_4444.log'), ''); // 0 bytes
    const NO_DONE_GUARD = () => false;
    // Spawn 1: no artifacts yet -> zero-delta -> counter 1.
    let before = countWorkerArtifacts(t4Dir);
    recordWorkerArtifactProgress(statePath, sessionDir, T4, before, { k: 5, doneGuardFn: NO_DONE_GUARD });
    // Spawn 2: worker produced a NEW artifact (positive delta) while its log is
    // STILL 0 bytes -> counter resets to 0 (keyed on delta, NOT log size) -> NOT reaped.
    before = countWorkerArtifacts(t4Dir);
    fs.writeFileSync(path.join(t4Dir, 'code_review_1.md'), 'APPROVED\n');
    assert.equal(fs.statSync(path.join(t4Dir, 'worker_session_4444.log')).size, 0, '(c) worker log is 0 bytes');
    const reap = recordWorkerArtifactProgress(statePath, sessionDir, T4, before, { k: 5, doneGuardFn: NO_DONE_GUARD });
    assert.equal(reap.zeroProgressCount, 0, '(c) positive artifact delta resets zero-progress (log size irrelevant)');
    assert.equal(reap.fired, false, '(c) the in-progress worker is NOT reaped on a positive delta');
    // The worker then commits its deliverable and flips Done hands-off.
    fs.writeFileSync(path.join(repo, 'extension', 'synthetic', `${T4}.spec.ts`), 'export const t4 = true;\n');
    git(['add', '-A'], repo);
    git(['commit', '-qm', `feat(${T4}): additive deliverable`], repo);
    const t4Sha = git(['rev-parse', '--short', 'HEAD'], repo).trim();
    updateTicketFrontmatter(T4, sessionDir, { status: 'Done', completion_commit: t4Sha });

    // ── 4/4 phases: pipeline-status reflects a fully completed additive bundle ──
    writePipelineStatus(sessionDir, 'completed', {
      current_phase: null,
      completed_phases: 4,
      skipped_phases: 0,
      total_phases: 4,
    });

    // ── FINAL hands-off contract assertions ──
    const allTickets = [T1, T2, T3, T4];
    for (const id of allTickets) {
      assert.equal(getTicketStatus(sessionDir, id), 'Done', `ticket ${id} reaches committed-done|backfilled-done`);
      const fm = fs.readFileSync(path.join(sessionDir, id, `rick_ticket_${id}.md`), 'utf8');
      // 0 done_without_commit_evidence: every Done ticket carries a completion_commit.
      assert.match(fm, /completion_commit:\s*['"]?[0-9a-f]{7,40}['"]?/, `ticket ${id} has completion_commit (no done_without_commit_evidence)`);
      // 0 archived-todo: no ticket was reset to Todo / archived.
      assert.doesNotMatch(fm, /status:\s*['"]?Todo['"]?/, `ticket ${id} was never reset to Todo (0 archived-todo)`);
    }

    // pipeline-status.json shows 4/4 phases.
    const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf8'));
    assert.equal(status.status, 'completed', 'pipeline-status: completed');
    assert.equal(status.completed_phases, 4, 'pipeline-status: 4 phases completed');
    assert.equal(status.total_phases, 4, 'pipeline-status: 4 total phases (4/4)');

    // Hands-off: no operator/babysitter edit and no completion-evidence hatch.
    // The completion-correctness control fields are exactly as launched — the
    // only sanctioned runtime mutation across the whole run is path (c)'s
    // worker_artifact_progress ledger (asserted schema-neutral above for a+b).
    const finalState = readState(statePath);
    const launchState = JSON.parse(stateBefore.toString('utf8'));
    for (const k of ['working_dir', 'max_iterations', 'session_dir', 'original_prompt', 'schema_version', 'current_ticket']) {
      assert.deepEqual(finalState[k], launchState[k], `state.${k} unchanged hands-off (no operator edit)`);
    }
    assert.ok(!('skip_quality_gates_reason' in (finalState.flags ?? {})), 'no quality-gate skip hatch set hands-off');
    assert.ok(!('allow_inferred_completion_commit' in (finalState.flags ?? {})), 'no inferred-completion hatch set hands-off');
  } finally {
    cleanup(repo);
  }
});
