// @tier: integration
/**
 * R-WUWC reproducer — worker-uncommitted-work-class data loss (HARD + SOFT variants).
 *
 * Trap-door anchor: this test exercises worker_partial_lifecycle_exit signal class,
 * verifies that ticket failed AFTER research APPROVED triggers the warning breadcrumb,
 * and asserts that the pipeline stamps phase_no_progress on a 0-Done/0-commit phase exit.
 *
 * PATTERN_SHAPE: worker_partial_lifecycle_exit[\s\S]*failed[\s\S]*AFTER[\s\S]*research[\s\S]*APPROVED[\s\S]*phase_no_progress
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  checkPartialLifecycleExit,
  checkFailedAfterResearchApproved,
  guardCompletionCommitBeforeDone,
} from '../bin/mux-runner.js';
import {
  markTicketDone,
  getTicketStatus,
} from '../services/pickle-utils.js';
import { readEvidence } from '../services/ticket-completion-evidence.js';
import { __setSpawnRunnerForTests, main as pipelineMain } from '../bin/pipeline-runner.js';
import { PipelineRunnerExitCode } from '../types/index.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function mktemp(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(dir) {
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'wuwc@test.local'], dir);
  git(['config', 'user.name', 'WUWC Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  // Ensure a default branch name for portability
  try { git(['checkout', '-b', 'main'], dir); } catch { /* already on a branch */ }
  fs.writeFileSync(path.join(dir, 'seed.ts'), 'export const x = 1;\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'seed'], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

function writeState(sessionDir, repo, startCommit) {
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    start_commit: startCommit,
    completion_promise: null,
    original_prompt: 'wuwc-reproducer test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    schema_version: 3,
    tmux_mode: false,
    chain_meeseeks: false,
    backend: 'claude',
    activity: [],
  }, null, 2));
  return statePath;
}

function writePipeline(sessionDir, repo) {
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases: ['pickle'],
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    dirty_exempt_segments: ['prds', 'docs'],
  }, null, 2));
}

function writeTicket(sessionDir, id, status) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `linear_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: WUWC reproducer\nstatus: ${status}\norder: 1\n---\n\n# Test\n`,
  );
  return ticketDir;
}

class ExitIntercept extends Error {
  constructor(code) { super(`exit(${code})`); this.code = code; }
}

async function captureMainExit(sessionDir, expectedCode) {
  const orig = process.exit;
  const origTmux = process.env.TMUX;
  delete process.env.TMUX;
  process.exit = (code) => { throw new ExitIntercept(code ?? 0); };
  try {
    await assert.rejects(
      () => pipelineMain(sessionDir),
      (e) => e instanceof ExitIntercept && e.code === expectedCode,
    );
  } finally {
    process.exit = orig;
    if (origTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = origTmux;
  }
}

function captureStderr(fn) {
  const buf = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c) => { buf.push(String(c)); return true; };
  try { fn(); } finally { process.stderr.write = orig; }
  return buf.join('');
}

function readActivity(statePath) {
  const s = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return Array.isArray(s.activity) ? s.activity : [];
}

function withoutTestMode(fn) {
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  try { return fn(); }
  finally { if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev; }
}

// ─── Case A — HARD: untracked files, partial lifecycle, no commit ─────────────

describe('R-WUWC Case A — HARD: untracked files, research APPROVED, no completion commit', () => {
  let repo, sessionDir, statePath, ticketId, syntheticFiles;

  before(() => {
    repo = mktemp('wuwc-hard-repo-');
    sessionDir = mktemp('wuwc-hard-session-');
    ticketId = 'hard1111';
    const startCommit = initRepo(repo);
    statePath = writeState(sessionDir, repo, startCommit);
    writePipeline(sessionDir, repo);
    const ticketDir = writeTicket(sessionDir, ticketId, 'Failed');

    // Research artifacts: *.md + research_review.md ending in APPROVED
    fs.writeFileSync(path.join(ticketDir, 'research_2026-05-23.md'), '# Research\n\nFindings.\n');
    fs.writeFileSync(path.join(ticketDir, 'research_review.md'), '# Research Review\n\nAPPROVED');
    // 90574654: a NONZERO worker log without the terminal promise token keeps this
    // exit in the log_truncated sub-class, so AC-WUWC-04's worker_partial_lifecycle_exit
    // assertion stays on the legacy event (0-byte/absent logs now emit worker_silent_death).
    fs.writeFileSync(
      path.join(ticketDir, 'worker_session_31337.log'),
      'worker output truncated mid-lifecycle — no terminal token\n',
    );

    // ≥2 synthetic source files (>100 LOC combined) — these represent the worker's
    // untracked work that was lost when the ticket flipped to Failed without a commit.
    const lotsOfCode = Array.from(
      { length: 60 },
      (_, i) => `export const synthesizedLine${i} = ${i}; // R-WUWC test fixture\n`,
    ).join('');
    const fileA = path.join(ticketDir, 'synthetic_impl_a.ts');
    const fileB = path.join(ticketDir, 'synthetic_impl_b.ts');
    fs.writeFileSync(fileA, lotsOfCode);
    fs.writeFileSync(fileB, lotsOfCode);
    syntheticFiles = [
      { path: fileA, size: fs.statSync(fileA).size },
      { path: fileB, size: fs.statSync(fileB).size },
    ];
  });

  after(() => {
    __setSpawnRunnerForTests(null);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it('AC-WUWC-03: guardCompletionCommitBeforeDone refuses Done flip when no commit evidence', () => {
    withoutTestMode(() => {
      const result = guardCompletionCommitBeforeDone({
        sessionDir, ticketId, workingDir: repo, flags: null, rereadBackoffMs: 0,
      });
      assert.equal(result.ok, false, 'guard must refuse Done flip when no commit exists');
      assert.equal(result.source, 'absent', 'source must be absent when no commit was made');
      const status = getTicketStatus(sessionDir, ticketId);
      assert.notEqual(status, 'done', `ticket must not flip to Done; got: ${status}`);
    });
  });

  it('AC-WUWC-04/AC-WUWC-08: checkPartialLifecycleExit emits worker_partial_lifecycle_exit event', () => {
    checkPartialLifecycleExit(sessionDir, statePath, ticketId);
    const events = readActivity(statePath).filter(e => e.event === 'worker_partial_lifecycle_exit');
    assert.ok(events.length >= 1, 'must emit at least one worker_partial_lifecycle_exit event');
    const ev = events[0];
    assert.equal(ev.event, 'worker_partial_lifecycle_exit');
    assert.equal(ev.ticket, ticketId);
    assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T/, 'ts must be ISO-8601');
    assert.ok(
      Array.isArray(ev.gate_payload.artifacts_missing) && ev.gate_payload.artifacts_missing.length > 0,
      'gate_payload.artifacts_missing must be non-empty',
    );
    assert.ok(
      typeof ev.gate_payload.session_log_size === 'number' && ev.gate_payload.session_log_size >= 0,
      'gate_payload.session_log_size must be a non-negative number',
    );
  });

  it('AC-WUWC-05: checkFailedAfterResearchApproved emits stderr breadcrumb matching pinned format', () => {
    // ticket failed AFTER research APPROVED — the canonical breadcrumb phrase
    const stderr = captureStderr(() => checkFailedAfterResearchApproved(sessionDir, ticketId));
    assert.ok(stderr.length > 0, 'must emit stderr breadcrumb line');
    assert.match(
      stderr,
      /\[warn\] \[\d{4}-\d{2}-\d{2}T[^\]]+\] ⚠ ticket \S+ failed AFTER research APPROVED — see [^\s]+\//,
      `breadcrumb must match pinned format; got: ${stderr}`,
    );
    assert.ok(stderr.includes(ticketId), 'breadcrumb must include ticket id');
    assert.ok(stderr.includes(sessionDir), 'breadcrumb must include session dir path');
  });

  it('AC-WUWC-06: pipeline-runner stamps phase_no_progress on 0-Done/0-commit phase exit', async () => {
    // Stub: mux-runner exits clean (0) with 0 Done tickets and 0 commits — the
    // hallucinated-completion pattern that triggers the phase_no_progress gate.
    __setSpawnRunnerForTests(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    await captureMainExit(sessionDir, PipelineRunnerExitCode.PhaseIncomplete);
    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(
      state.exit_reason,
      'phase_no_progress',
      'state must carry phase_no_progress after 0-Done/0-commit phase exit (AC-WUWC-06)',
    );
  });

  it('AC-WUWC-07: ≥2 synthetic source files survive the failure path with original byte sizes', () => {
    // The load-bearing data-loss assertion: untracked worker files must not be
    // destroyed by the pipeline failure path.
    assert.equal(syntheticFiles.length, 2, 'fixture must provide at least 2 synthetic files');
    for (const { path: filePath, size: originalSize } of syntheticFiles) {
      assert.ok(fs.existsSync(filePath), `synthetic file must still exist: ${path.basename(filePath)}`);
      const currentSize = fs.statSync(filePath).size;
      assert.equal(
        currentSize, originalSize,
        `${path.basename(filePath)} byte-size unchanged (was ${originalSize}, now ${currentSize})`,
      );
    }
  });
});

// ─── Case B — SOFT: commit exists, inferred source, no completion_commit field ─

describe('R-WUWC Case B — SOFT: worker commits with ticket-id, no completion_commit field', () => {
  let repo, sessionDir, ticketId, commitSha;

  before(() => {
    repo = mktemp('wuwc-soft-repo-');
    // sessionDir is a SEPARATE tmpdir from repo so that autoFillCompletionCommit's
    // git-add of the ticket file (path outside workingDir) reliably fails, letting
    // the guard fall through to the {ok: false} classification for AC-WUWC-11b.
    sessionDir = mktemp('wuwc-soft-session-');
    ticketId = 'soft9999';
    initRepo(repo);

    // Worker writes a file, commits with ticket-id in the message (SOFT-variant
    // failure condition: commit references ticket but no completion_commit: field).
    fs.writeFileSync(path.join(repo, 'worker.ts'), `export const impl = 'soft-variant-test';\n`);
    git(['add', 'worker.ts'], repo);
    git(['commit', '-q', '-m', `${ticketId} implement soft-variant reproducer`, '--no-gpg-sign'], repo);
    commitSha = git(['rev-parse', 'HEAD'], repo);

    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    // Ticket frontmatter: status Done, NO completion_commit field
    fs.writeFileSync(
      path.join(ticketDir, `linear_ticket_${ticketId}.md`),
      [
        '---',
        `id: ${ticketId}`,
        'title: "R-WUWC SOFT-variant reproducer"',
        'status: Done',
        'order: 1',
        '---',
        '# SOFT-variant reproducer',
      ].join('\n'),
    );
  });

  after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it('AC-WUWC-11a: readEvidence returns { kind: "committed", sha } before explicit field', () => {
    const ticketFile = path.join(sessionDir, ticketId, `linear_ticket_${ticketId}.md`);
    const content = fs.readFileSync(ticketFile, 'utf-8');
    assert.ok(!content.includes('completion_commit:'), 'precondition: no explicit field yet');

    const evidence = readEvidence({ sessionDir, ticketId, workingDir: repo });
    assert.equal(evidence.kind, 'committed', 'must infer commit from git log scan matching ticket-id (B-DURA T70: committed)');
    assert.equal(evidence.sha, commitSha, 'inferred sha must match the actual commit');
  });

  it('AC-WUWC-11b: guard error message surfaces both bypass paths (auto-fill fails outside-repo)', () => {
    // The ticket file is in sessionDir (a tmpdir separate from repo). When
    // autoFillCompletionCommit writes the SHA then calls `git -C repo add -- /tmp/.../ticket.md`,
    // git rejects the path as outside the repository and throws. The guard's best-effort
    // catch block falls through to {ok: false} with the pinned reason message.
    // If the tmpdir happens to be nested inside a parent git repo (unusual), the auto-fill
    // succeeds — the test handles both outcomes.
    withoutTestMode(() => {
      const result = guardCompletionCommitBeforeDone({
        sessionDir, ticketId, workingDir: repo, flags: null, rereadBackoffMs: 0,
      });

      if (result.ok === false) {
        // Auto-fill git-add failed — verify the canonical error message format.
        assert.match(
          result.reason,
          /cannot flip Done: readEvidence\(\)\.kind === '[^']+' \(expected 'committed'\); worker did not produce an attributable git commit/,
          `guard error must match pinned format; got: ${result.reason}`,
        );
        assert.ok(
          result.reason.includes('completion_commit: <sha>'),
          'error must surface the frontmatter recovery path',
        );
      } else {
        // Auto-fill succeeded (post-fix auto-promote path). The guard passes and
        // the SHA is auto-filled — this is the runtime equivalent of the operator workaround.
        assert.equal(result.ok, true);
        assert.ok(typeof result.sha === 'string' && result.sha.length >= 7, 'promoted sha is a git sha');
      }
    });
  });

  it('AC-WUWC-12: writing completion_commit to frontmatter keeps kind committed and allows Done flip', () => {
    // After AC-WUWC-11b, autoFillCompletionCommit may have already written completion_commit
    // to the ticket file (it writes the file before the git-add fails). Ensure the field
    // is present — if the auto-fill succeeded OR wrote before failing, we verify it now;
    // if neither, write it manually to simulate the operator recovery workaround.
    const ticketFile = path.join(sessionDir, ticketId, `linear_ticket_${ticketId}.md`);
    let content = fs.readFileSync(ticketFile, 'utf-8');
    if (!content.includes('completion_commit:')) {
      // Manual operator recovery: insert completion_commit before the closing '---'
      content = content.replace(
        /^(---\n[\s\S]*?)(---)/m,
        `$1completion_commit: "${commitSha}"\n$2`,
      );
      fs.writeFileSync(ticketFile, content);
    }

    // Re-probe: kind must now be committed via the explicit field (AC-WUWC-12 step 1)
    const evidence = readEvidence({ sessionDir, ticketId, workingDir: repo });
    assert.equal(
      evidence.kind, 'committed',
      'after writing completion_commit field, kind must be committed',
    );
    assert.equal(evidence.sha, commitSha);

    // Guard must now pass (AC-WUWC-12 step 2)
    withoutTestMode(() => {
      const guard = guardCompletionCommitBeforeDone({
        sessionDir, ticketId, workingDir: repo, flags: null, rereadBackoffMs: 0,
      });
      assert.equal(guard.ok, true, 'guard must pass when completion_commit is explicitly set');
      assert.equal(guard.sha, commitSha);
    });

    // markTicketDone succeeds — Done flip is now allowed (AC-WUWC-12 step 3)
    const flipped = markTicketDone(sessionDir, ticketId);
    assert.equal(flipped, true, 'markTicketDone must succeed after explicit completion_commit');
  });
});
