// @tier: fast
/**
 * 84c209ae D1 — Promote-once completion (B-PDBL D1).
 *
 * A Done ticket carrying `completion_commit_inferred` was re-backfilled on EVERY
 * phantom-Done pass, each emitting two activity events, growing state.activity
 * unbounded. The fix promotes the git-verified inferred SHA to an EXPLICIT
 * `completion_commit` field and DELETES `completion_commit_inferred` exactly once,
 * so the next re-scan classifies `explicit` (oracle → keep) and is a no-op.
 *
 * Tests:
 *  - D1a: N phantom-Done passes → EXACTLY ONE backfill (count stable, not N),
 *    `completion_commit_inferred` GONE after pass 1, `completion_commit` present.
 *  - D1b: keep/revert routes through `gateForPhantomDoneRevert` (the oracle),
 *    not a bespoke inline check — proven by the oracle's decision actions driving
 *    the watcher result (keep → has_completion_commit, revert → reverted).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { inspectPhantomDoneTicketFile } from '../bin/mux-runner.js';
import { gateForPhantomDoneRevert } from '../services/ticket-completion-evidence.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(dir) {
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.local'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'seed.ts'), 'export const x = 1;\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'seed commit'], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

function writeTicket(sessionDir, id, frontmatterLines) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fp = path.join(ticketDir, `rick_ticket_${id}.md`);
  fs.writeFileSync(fp, `---\n${frontmatterLines.join('\n')}\n---\n\n# Test ${id}\n`);
  return fp;
}

function withSandbox(fn) {
  const dataRoot = tmpDir('pickle-d1-data-');
  const prev = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    fn(dataRoot);
  } finally {
    if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prev;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

test('D1a: inferred Done ticket is promoted EXACTLY ONCE across N passes', () => {
  withSandbox(() => {
    const repo = tmpDir('pickle-d1-repo-');
    try {
      const sha = initRepo(repo);
      const sessionDir = path.join(repo, 'session');
      fs.mkdirSync(sessionDir, { recursive: true });

      // Done ticket with completion_commit_inferred pointing at a REAL commit,
      // so readEvidence classifies committed → oracle keep → watcher promotes once.
      const id = 'ticketd1a';
      const fp = writeTicket(sessionDir, id, [
        `id: ${id}`,
        `title: D1 promote-once ${id}`,
        'status: Done',
        `completion_commit_inferred: "${sha}"`,
      ]);

      const N = 5;
      const reasons = [];
      for (let i = 0; i < N; i++) {
        const r = inspectPhantomDoneTicketFile(fp, sessionDir, repo, 'Todo');
        reasons.push(r.reason);
      }

      // Exactly ONE backfill (the first promotion); the rest are no-ops.
      const backfills = reasons.filter((r) => r === 'backfilled');
      assert.equal(backfills.length, 1, `expected exactly 1 backfill across ${N} passes, got reasons=${JSON.stringify(reasons)}`);
      // After pass 1, every subsequent pass sees the explicit field → no change.
      for (let i = 1; i < N; i++) {
        assert.equal(reasons[i], 'has_completion_commit', `pass ${i} should be has_completion_commit`);
      }

      // Field state: completion_commit present, completion_commit_inferred GONE.
      const content = fs.readFileSync(fp, 'utf8');
      assert.match(content, /^completion_commit:\s*"?[0-9a-f]{7,40}"?\s*$/m, 'explicit completion_commit must be present');
      assert.doesNotMatch(content, /^completion_commit_inferred:/m, 'completion_commit_inferred must be deleted after promotion');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test('D1a: backfill count does NOT grow with the number of passes (stable, not N)', () => {
  withSandbox(() => {
    const repo = tmpDir('pickle-d1-repo2-');
    try {
      const sha = initRepo(repo);
      const sessionDir = path.join(repo, 'session');
      fs.mkdirSync(sessionDir, { recursive: true });
      const id = 'ticketgrow';
      const fp = writeTicket(sessionDir, id, [
        `id: ${id}`,
        `title: D1 stable count ${id}`,
        'status: Done',
        `completion_commit_inferred: "${sha}"`,
      ]);

      const countBackfills = (passes) => {
        let c = 0;
        for (let i = 0; i < passes; i++) {
          if (inspectPhantomDoneTicketFile(fp, sessionDir, repo, 'Todo').reason === 'backfilled') c++;
        }
        return c;
      };
      // 10 passes still yields exactly 1 backfill — count is independent of N.
      assert.equal(countBackfills(10), 1);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

test('D1b: keep/revert routes through gateForPhantomDoneRevert oracle (not a bespoke check)', () => {
  withSandbox(() => {
    const repo = tmpDir('pickle-d1-repo3-');
    try {
      const sha = initRepo(repo);
      const sessionDir = path.join(repo, 'session');
      fs.mkdirSync(sessionDir, { recursive: true });

      // Case 1: absent evidence → oracle returns action:'revert' → watcher reverts.
      const absentId = 'ticketabsent';
      const absentFp = writeTicket(sessionDir, absentId, [
        `id: ${absentId}`,
        `title: D1 absent ${absentId}`,
        'status: Done',
      ]);
      const absentDecision = gateForPhantomDoneRevert({ sessionDir, ticketId: absentId, ticketPath: absentFp, workingDir: repo });
      assert.equal(absentDecision.action, 'revert', 'oracle must classify absent evidence as revert');
      const absentResult = inspectPhantomDoneTicketFile(absentFp, sessionDir, repo, 'Todo');
      assert.equal(absentResult.reason, 'reverted', 'watcher must follow the oracle revert action');

      // Case 2: explicit reachable SHA → oracle returns action:'keep' → watcher keeps.
      const explicitId = 'ticketexplicit';
      const explicitFp = writeTicket(sessionDir, explicitId, [
        `id: ${explicitId}`,
        `title: D1 explicit ${explicitId}`,
        'status: Done',
        `completion_commit: "${sha}"`,
      ]);
      const keepDecision = gateForPhantomDoneRevert({ sessionDir, ticketId: explicitId, ticketPath: explicitFp, workingDir: repo });
      assert.equal(keepDecision.action, 'keep', 'oracle must classify explicit reachable SHA as keep');
      const keepResult = inspectPhantomDoneTicketFile(explicitFp, sessionDir, repo, 'Todo');
      assert.equal(keepResult.reason, 'has_completion_commit', 'watcher must keep when oracle says keep');

      // Case 3 (B-DURA T70): a git-verified completion_commit_inferred SHA is
      // `committed` → oracle returns action:'keep'; the watcher promotes it once.
      // B-1SEAM: the predicate itself promote-once-persists on EVERY decision
      // kind (R-WUWC trap door), so the watcher inspect runs FIRST here — a
      // prior direct oracle call would already stamp the explicit field and the
      // inspect would correctly classify 'has_completion_commit'.
      const inferredId = 'ticketinferred';
      const inferredFp = writeTicket(sessionDir, inferredId, [
        `id: ${inferredId}`,
        `title: D1 inferred ${inferredId}`,
        'status: Done',
        `completion_commit_inferred: "${sha}"`,
      ]);
      const inferredResult = inspectPhantomDoneTicketFile(inferredFp, sessionDir, repo, 'Todo');
      assert.equal(inferredResult.reason, 'backfilled', 'watcher promotes the committed inferred SHA to the explicit field');
      const keepInferredDecision = gateForPhantomDoneRevert({ sessionDir, ticketId: inferredId, ticketPath: inferredFp, workingDir: repo });
      assert.equal(keepInferredDecision.action, 'keep', 'oracle must classify the promoted explicit SHA as keep (committed)');
      assert.equal(keepInferredDecision.kind, 'committed', 'oracle kind must be committed');
      assert.ok(/^completion_commit:/m.test(fs.readFileSync(inferredFp, 'utf8')), 'explicit completion_commit stamped after promote-once');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
