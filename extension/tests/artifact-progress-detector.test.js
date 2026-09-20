// @tier: fast
//
// R-WTB-A1 unit tests for artifact-progress-detector service.
// Verifies env-var parsing, mtime scanning, and detectArtifactProgress logic
// using synthetic files and a real git repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  NO_PROGRESS_WINDOW_ENV,
  NO_PROGRESS_WINDOW_DEFAULT_S,
  resolveNoProgressWindowSeconds,
  getLatestArtifactMtime,
  getLatestCommitInScope,
  detectArtifactProgress,
} from '../services/artifact-progress-detector.js';

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'apd-test-')));
}

function initGit(dir) {
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'base.md'), 'baseline\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

// AP-EXT-ITER313-01: a REAL repo whose only commit is far outside any window, so
// "git answered: nothing landed" is reachable without depending on a non-repo cwd.
function initGitBackdated(dir) {
  const env = { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' };
  execFileSync('git', ['init', '--quiet'], { cwd: dir, timeout: 30_000 });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: dir, timeout: 30_000 });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, timeout: 30_000 });
  fs.writeFileSync(path.join(dir, 'base.md'), 'baseline\n');
  execFileSync('git', ['add', '.'], { cwd: dir, timeout: 30_000 });
  execFileSync('git', ['commit', '-m', 'baseline', '--quiet'], { cwd: dir, env, timeout: 30_000 });
}

function gitCommit(dir, file, msg) {
  const fullPath = path.join(dir, file);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `content ${Date.now()}\n`);
  execFileSync('git', ['add', file], { cwd: dir });
  execFileSync('git', ['commit', '-m', msg, '--quiet'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim();
}

// --- resolveNoProgressWindowSeconds ---

test('R-WTB-A1 default window is 1500s', () => {
  assert.equal(NO_PROGRESS_WINDOW_DEFAULT_S, 1500);
});

test('R-WTB-A1 env name is PICKLE_TIMEOUT_NO_PROGRESS_WINDOW_SECONDS', () => {
  assert.equal(NO_PROGRESS_WINDOW_ENV, 'PICKLE_TIMEOUT_NO_PROGRESS_WINDOW_SECONDS');
});

test('R-WTB-A1 resolveNoProgressWindowSeconds: no env → default', () => {
  assert.equal(resolveNoProgressWindowSeconds({}), NO_PROGRESS_WINDOW_DEFAULT_S);
});

test('R-WTB-A1 resolveNoProgressWindowSeconds: valid integer', () => {
  assert.equal(resolveNoProgressWindowSeconds({ [NO_PROGRESS_WINDOW_ENV]: '300' }), 300);
});

test('R-WTB-A1 resolveNoProgressWindowSeconds: non-integer float → default', () => {
  assert.equal(resolveNoProgressWindowSeconds({ [NO_PROGRESS_WINDOW_ENV]: '300.5' }), NO_PROGRESS_WINDOW_DEFAULT_S);
});

test('R-WTB-A1 resolveNoProgressWindowSeconds: zero → default', () => {
  assert.equal(resolveNoProgressWindowSeconds({ [NO_PROGRESS_WINDOW_ENV]: '0' }), NO_PROGRESS_WINDOW_DEFAULT_S);
});

test('R-WTB-A1 resolveNoProgressWindowSeconds: negative → default', () => {
  assert.equal(resolveNoProgressWindowSeconds({ [NO_PROGRESS_WINDOW_ENV]: '-60' }), NO_PROGRESS_WINDOW_DEFAULT_S);
});

test('R-WTB-A1 resolveNoProgressWindowSeconds: non-numeric → default', () => {
  assert.equal(resolveNoProgressWindowSeconds({ [NO_PROGRESS_WINDOW_ENV]: 'foo' }), NO_PROGRESS_WINDOW_DEFAULT_S);
});

// --- getLatestArtifactMtime ---

test('R-WTB-A1 getLatestArtifactMtime: missing dir → 0', () => {
  assert.equal(getLatestArtifactMtime('/no/such/dir/xyz99'), 0);
});

test('R-WTB-A1 getLatestArtifactMtime: empty dir → 0', () => {
  const dir = makeTmpDir();
  assert.equal(getLatestArtifactMtime(dir), 0);
  fs.rmdirSync(dir);
});

test('R-WTB-A1 getLatestArtifactMtime: only .md files counted', () => {
  const dir = makeTmpDir();
  const before = Math.floor(Date.now() / 1000) - 10;
  fs.writeFileSync(path.join(dir, 'research_abc.md'), 'r1');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'txt'); // not .md
  const latest = getLatestArtifactMtime(dir);
  assert.ok(latest >= before, `expected mtime ${latest} >= ${before}`);
  // txt file must not affect result - mtime should equal the md file
  const txtStat = fs.statSync(path.join(dir, 'notes.txt'));
  const mdStat = fs.statSync(path.join(dir, 'research_abc.md'));
  assert.equal(latest, Math.floor(mdStat.mtimeMs / 1000));
  fs.rmSync(dir, { recursive: true });
});

test('R-WTB-A1 getLatestArtifactMtime: returns max mtime across multiple .md files', () => {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'research_a.md'), 'r1');
  // Briefly wait to ensure mtime ordering, then write second file
  const t1 = Math.floor(fs.statSync(path.join(dir, 'research_a.md')).mtimeMs / 1000);
  // Manually set the second file mtime to t1+2
  fs.writeFileSync(path.join(dir, 'plan_b.md'), 'p1');
  const futureTime = new Date((t1 + 2) * 1000);
  fs.utimesSync(path.join(dir, 'plan_b.md'), futureTime, futureTime);
  assert.equal(getLatestArtifactMtime(dir), t1 + 2);
  fs.rmSync(dir, { recursive: true });
});

// --- getLatestCommitInScope ---

test('R-WTB-A1 getLatestCommitInScope: recent commit in last window → returns SHA', () => {
  const dir = makeTmpDir();
  initGit(dir);
  const sha = gitCommit(dir, 'work.ts', 'feat: add work');
  const result = getLatestCommitInScope(dir, 3600); // 1h window
  assert.equal(result.measured, true, 'git answered');
  assert.ok(result.sha !== null, 'expected a SHA');
  assert.ok(sha.startsWith(result.sha ?? ''), `expected ${sha} to start with ${result.sha}`);
  fs.rmSync(dir, { recursive: true });
});

test('R-WTB-A1 getLatestCommitInScope: old commit before window → null', () => {
  const dir = makeTmpDir();
  initGit(dir);
  // window of 1 second — the initial commit is older
  const result = getLatestCommitInScope(dir, 1);
  // This might report null or a very recent commit; either way git ANSWERED.
  assert.equal(result.measured, true);
  assert.ok(result.sha === null || typeof result.sha === 'string');
  fs.rmSync(dir, { recursive: true });
});

test('R-WTB-A1 getLatestCommitInScope: with scope.json paths → uses path filter', () => {
  const dir = makeTmpDir();
  initGit(dir);
  // commit a file inside scope
  const sha = gitCommit(dir, 'src/main.ts', 'feat: main');
  // write scope.json
  const scopePath = path.join(dir, 'scope.json');
  fs.writeFileSync(scopePath, JSON.stringify({ allowed_paths: ['src/'] }));
  const result = getLatestCommitInScope(dir, 3600, scopePath);
  assert.equal(result.measured, true);
  assert.ok(result.sha !== null, 'expected SHA from scoped commit');
  assert.ok(sha.startsWith(result.sha ?? ''));
  fs.rmSync(dir, { recursive: true });
});

// --- detectArtifactProgress ---

test('R-WTB-A1 detectArtifactProgress: no files, no commits → not progressed', () => {
  const dir = makeTmpDir();
  // AP-EXT-ITER313-01: a REAL repo with nothing in the window. This case previously ran
  // against a non-repo cwd, where git exits 128 — it was asserting the collapse, not the
  // empty window, and could never have distinguished the two.
  initGitBackdated(dir);
  fs.unlinkSync(path.join(dir, 'base.md'));
  const snapshot = { latestMtimeEpoch: 0, latestCommitSha: null };
  const result = detectArtifactProgress(dir, snapshot, { workingDir: dir, windowSeconds: 60 });
  assert.equal(result.commitProbeMeasured, true, 'fixture guard: git must have ANSWERED');
  assert.equal(result.progressed, false);
  assert.equal(result.latestMtimeEpoch, 0);
  assert.equal(result.latestCommitSha, null);
  fs.rmSync(dir, { recursive: true });
});

test('R-WTB-A1 detectArtifactProgress: mtime advance → progressed', () => {
  const dir = makeTmpDir();
  const ticketDir = path.join(dir, 'ticket1');
  fs.mkdirSync(ticketDir);
  initGit(dir);
  const snapshot = { latestMtimeEpoch: 0, latestCommitSha: null };
  fs.writeFileSync(path.join(ticketDir, 'research_abc.md'), 'content');
  const result = detectArtifactProgress(ticketDir, snapshot, { workingDir: dir, windowSeconds: 1 });
  assert.equal(result.progressed, true);
  assert.ok(result.latestMtimeEpoch > 0);
  fs.rmSync(dir, { recursive: true });
});

test('R-WTB-A1 detectArtifactProgress: mtime unchanged, same sha → not progressed', () => {
  const dir = makeTmpDir();
  const ticketDir = path.join(dir, 'ticket1');
  fs.mkdirSync(ticketDir);
  initGit(dir);
  fs.writeFileSync(path.join(ticketDir, 'plan_abc.md'), 'content');
  const mtime = Math.floor(fs.statSync(path.join(ticketDir, 'plan_abc.md')).mtimeMs / 1000);
  // Snapshot holds the current HEAD SHA — nothing new since this snapshot
  const currentSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim().slice(0, 7);
  // Use a large window but snapshot already knows the current commit → not progressed
  const snapshot = { latestMtimeEpoch: mtime, latestCommitSha: currentSha };
  const result = detectArtifactProgress(ticketDir, snapshot, { workingDir: dir, windowSeconds: 3600 });
  // mtime same, sha same → not progressed
  assert.equal(result.progressed, false);
  fs.rmSync(dir, { recursive: true });
});

test('R-WTB-A1 detectArtifactProgress: new commit SHA → progressed', () => {
  const dir = makeTmpDir();
  const ticketDir = path.join(dir, 'ticket1');
  fs.mkdirSync(ticketDir);
  initGit(dir);
  const mtime = 0;
  const oldSha = 'aaabbbccc';
  const newSha = gitCommit(dir, 'work.ts', 'feat: new commit');
  const snapshot = { latestMtimeEpoch: mtime, latestCommitSha: oldSha };
  const result = detectArtifactProgress(ticketDir, snapshot, { workingDir: dir, windowSeconds: 3600 });
  assert.equal(result.progressed, true);
  assert.ok(result.latestCommitSha !== null);
  assert.notEqual(result.latestCommitSha, oldSha);
  fs.rmSync(dir, { recursive: true });
});

// --- AP-EXT-ITER312-01: allowed_paths are repo-root-relative, the probe must read them there ---

test('AP-EXT-ITER312-01 getLatestCommitInScope: a subdirectory workingDir AGREES with the toplevel reading', () => {
  const dir = makeTmpDir();
  initGit(dir);
  const sha = gitCommit(dir, 'pkg/a.txt', 'feat: in-scope change');
  const subDir = path.join(dir, 'pkg');

  // `allowed_paths` is repo-root-relative (R-RSBI-2), exactly as scope-resolver writes it.
  const scopePath = path.join(dir, 'scope.json');
  fs.writeFileSync(scopePath, JSON.stringify({ allowed_paths: ['pkg/a.txt'] }));

  const atTop = getLatestCommitInScope(dir, 3600, scopePath);
  const atSub = getLatestCommitInScope(subDir, 3600, scopePath);

  assert.ok(atTop.sha !== null, 'expected a SHA at the git toplevel');
  assert.ok(sha.startsWith(atTop.sha ?? ''), `expected ${sha} to start with ${atTop.sha}`);
  // The reading must not depend on where the session was launched from.
  assert.deepStrictEqual(atSub, atTop, 'a workingDir below the toplevel must read the same commit');

  // Over-trigger control: the scoping still FENCES. A fix that simply dropped the
  // pathspecs would satisfy the assertions above and red here.
  const fencePath = path.join(dir, 'scope-fence.json');
  fs.writeFileSync(fencePath, JSON.stringify({ allowed_paths: ['nonexistent/z.txt'] }));
  assert.deepStrictEqual(getLatestCommitInScope(dir, 3600, fencePath), { measured: true, sha: null },
    'an out-of-scope-only window is a MEASURED empty at the toplevel');
  assert.deepStrictEqual(getLatestCommitInScope(subDir, 3600, fencePath), { measured: true, sha: null },
    'an out-of-scope-only window is a MEASURED empty below the toplevel too');

  fs.rmSync(dir, { recursive: true });
});

test('AP-EXT-ITER312-01 detectArtifactProgress: a committing worker below the toplevel is not charged zero progress', () => {
  const dir = makeTmpDir();
  const ticketDir = path.join(dir, 'ticket1');
  fs.mkdirSync(ticketDir);
  initGit(dir);
  const sha = gitCommit(dir, 'pkg/a.txt', 'feat: worker committed in-scope work');
  const scopePath = path.join(dir, 'scope.json');
  fs.writeFileSync(scopePath, JSON.stringify({ allowed_paths: ['pkg/a.txt'] }));

  // No .md artifacts in the ticket dir, so the mtime arm is frozen at 0 and the
  // commit arm is the ONLY progress signal — the production timeout-probe shape.
  const snapshot = { latestMtimeEpoch: 0, latestCommitSha: 'aaabbbccc' };
  const result = detectArtifactProgress(ticketDir, snapshot, {
    workingDir: path.join(dir, 'pkg'),
    scopeJsonPath: scopePath,
    windowSeconds: 3600,
  });

  assert.equal(result.latestMtimeEpoch, 0, 'fixture guard: the mtime arm must be inert');
  assert.ok(result.latestCommitSha !== null, 'the commit arm must see the worker commit');
  assert.ok(sha.startsWith(result.latestCommitSha ?? ''));
  assert.equal(result.progressed, true);

  fs.rmSync(dir, { recursive: true });
});

// --- AP-EXT-ITER313-01: git DECLINING to answer is not git answering "nothing landed" ---

test('AP-EXT-ITER313-01 getLatestCommitInScope: an unanswered probe is measured:false, an empty window is measured:true', () => {
  const dir = makeTmpDir();
  initGit(dir);
  const sha = gitCommit(dir, 'work.ts', 'feat: real work');

  // Positive control: git answered and there IS a commit.
  const answered = getLatestCommitInScope(dir, 3600);
  assert.equal(answered.measured, true);
  assert.ok(sha.startsWith(answered.sha ?? ''), 'fixture guard: the probe can see a real commit');

  // Answered, and the answer is "nothing in the window" — the only shape that may vote
  // no-progress. Its `sha: null` is the SAME null the unmeasurable arms produce, which is
  // exactly why the boolean and not the sha carries the distinction.
  const empty = makeTmpDir();
  initGitBackdated(empty);
  assert.deepStrictEqual(getLatestCommitInScope(empty, 60), { measured: true, sha: null });

  // Unanswered, non-zero exit: workingDir is not a git repository (git exits 128).
  const notARepo = makeTmpDir();
  assert.deepStrictEqual(getLatestCommitInScope(notARepo, 3600), { measured: false, sha: null });

  // Unanswered, spawn failure: the cwd does not exist, so `status` is null and `error` is
  // ENOENT — the same result shape an absent `git` binary and the 10s timeout produce, and
  // the shape the retired `(result.status ?? 1)` reading mapped onto a plain no-commit.
  assert.deepStrictEqual(
    getLatestCommitInScope(path.join(notARepo, 'gone'), 3600),
    { measured: false, sha: null },
  );

  fs.rmSync(dir, { recursive: true });
  fs.rmSync(empty, { recursive: true });
  fs.rmSync(notARepo, { recursive: true });
});

test('AP-EXT-ITER313-01 detectArtifactProgress: an unanswered probe extends instead of voting the run-ending halt', () => {
  const dir = makeTmpDir();
  const ticketDir = path.join(dir, 'ticket1');
  fs.mkdirSync(ticketDir);

  // No .md in the ticket dir, so the mtime arm is inert and the commit probe is the ONLY
  // signal — the production timeout-probe shape during Implement, which writes no .md.
  const priorSha = 'aaabbbccc';
  const snapshot = { latestMtimeEpoch: 0, latestCommitSha: priorSha };

  // Answered, empty window: this is the ONE reading allowed to reach
  // `routeTimeoutNoProgress`, which stamps `ticket_timeout_halted_no_progress` and breaks
  // the mux loop with `exit_reason: timeout_repeat`. It doubles as the over-trigger control
  // — a fix that simply returned `progressed: true` for everything reds here.
  const answeredEmpty = makeTmpDir();
  initGitBackdated(answeredEmpty);
  const measured = detectArtifactProgress(ticketDir, snapshot, {
    workingDir: answeredEmpty, windowSeconds: 60,
  });
  assert.equal(measured.commitProbeMeasured, true);
  assert.equal(measured.progressed, false, 'a measured empty window still votes no-progress');

  // Unanswered: the same `sha: null`, but the run must NOT end on an unknown.
  const unanswered = detectArtifactProgress(ticketDir, snapshot, {
    workingDir: path.join(dir, 'no-such-dir'), windowSeconds: 60,
  });
  assert.equal(unanswered.commitProbeMeasured, false);
  assert.equal(unanswered.progressed, true, 'an unanswered probe must not vote the halt');
  assert.equal(unanswered.latestCommitSha, priorSha,
    'the prior sha is carried forward, never overwritten with a fabricated null');

  fs.rmSync(dir, { recursive: true });
  fs.rmSync(answeredEmpty, { recursive: true });
});
