// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { autoFillCompletionCommit } from '../bin/auto-fill-completion-commit.js';

function makeTmpRoot(prefix = 'pickle-auto-fill-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial fixture', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
}

function writeTicket(sessionDir, ticketId, status = 'Done') {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
  fs.writeFileSync(ticketPath, [
    '---',
    `id: ${ticketId}`,
    'title: R-CCC-5 Auto-fill test',
    `status: "${status}"`,
    'order: 1',
    '---',
    '# R-CCC-5 Auto-fill test',
  ].join('\n'));
  return ticketPath;
}

function readActivityEvents(statePath) {
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return Array.isArray(raw.activity) ? raw.activity : [];
}

test('autoFillCompletionCommit: fills missing completion_commit, stages the ticket file, and is idempotent', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const ticketId = '167fcaf9';
    const ticketPath = writeTicket(sessionDir, ticketId);
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      start_time_epoch: Math.floor(Date.now() / 1000) - 60,
      activity: [],
    }, null, 2));

    fs.writeFileSync(path.join(root, 'worker-output.txt'), 'worker changes\n');
    execFileSync('git', ['add', 'worker-output.txt'], { cwd: root });
    execFileSync(
      'git',
      ['commit', '-m', 'close completion gap', '--trailer', `Pickle-Ticket: ${ticketId}`, '--no-gpg-sign'],
      { cwd: root, stdio: 'ignore' },
    );
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const first = autoFillCompletionCommit({
      sessionDir,
      workingDir: root,
      ticketId,
      statePath,
    });
    assert.deepEqual(first, [{ ticketId, sha, action: 'filled' }]);
    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.match(updated, new RegExp(`completion_commit:\\s+"${sha}"`));

    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' });
    assert.match(staged, new RegExp(`rick_ticket_${ticketId}\\.md`));

    const second = autoFillCompletionCommit({
      sessionDir,
      workingDir: root,
      ticketId,
      statePath,
    });
    assert.deepEqual(second, [{ ticketId, sha, action: 'already_present' }]);

    const events = readActivityEvents(statePath).filter((entry) => entry.event === 'completion_commit_auto_filled');
    assert.equal(events.length, 1);
    assert.equal(events[0].ticket_id, ticketId);
    assert.equal(events[0].sha, sha);
    assert.equal(events[0].helper, 'auto_fill');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER11-01: a session dir OUTSIDE the repo still fills every ticket in the batch', () => {
  // Production layout: the session root lives under getDataRoot()/sessions/,
  // NOT inside workingDir, so `git add -- <ticketPath>` exits 128 ("is outside
  // repository"). Staging is best-effort (R-AFCC-STAGE); it must not abort the
  // batch after the frontmatter write has already landed.
  const root = makeTmpRoot();
  try {
    const repo = path.join(root, 'repo');
    const sessionDir = path.join(root, 'sessions', '2026-08-09-outside');
    fs.mkdirSync(repo, { recursive: true });
    initGitRepo(repo);

    const ticketIds = ['a1b2c3d4', 'e5f6a7b8'];
    const ticketPaths = ticketIds.map((id) => writeTicket(sessionDir, id));
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      start_time_epoch: Math.floor(Date.now() / 1000) - 60,
      activity: [],
    }, null, 2));

    const shas = ticketIds.map((id, i) => {
      fs.writeFileSync(path.join(repo, `worker-${i}.txt`), 'worker changes\n');
      execFileSync('git', ['add', `worker-${i}.txt`], { cwd: repo });
      execFileSync(
        'git',
        ['commit', '-m', `close gap ${i}`, '--trailer', `Pickle-Ticket: ${id}`, '--no-gpg-sign'],
        { cwd: repo, stdio: 'ignore' },
      );
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    });

    // Pre-fix this THREW out of the loop on the first ticket.
    const result = autoFillCompletionCommit({ sessionDir, workingDir: repo, statePath });

    assert.deepEqual(
      [...result].sort((a, b) => a.ticketId.localeCompare(b.ticketId)),
      ticketIds
        .map((id, i) => ({ ticketId: id, sha: shas[i], action: 'filled' }))
        .sort((a, b) => a.ticketId.localeCompare(b.ticketId)),
    );
    // The un-stageable write still landed on disk, for EVERY ticket.
    ticketPaths.forEach((p, i) => {
      assert.match(fs.readFileSync(p, 'utf8'), new RegExp(`completion_commit:\\s+"${shas[i]}"`));
    });
    // Nothing from the session dir was staged — staging genuinely failed.
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' });
    assert.doesNotMatch(staged, /rick_ticket_/);

    const events = readActivityEvents(statePath).filter((e) => e.event === 'completion_commit_auto_filled');
    assert.equal(events.length, ticketIds.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('autoFillCompletionCommit: promotes recoverable state tmp before inferring completion evidence', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const ticketId = '4b5f3f21';
    const ticketPath = writeTicket(sessionDir, ticketId);
    const statePath = path.join(sessionDir, 'state.json');
    const oldEpoch = 1_700_000_000;
    const commitEpoch = oldEpoch + 60;
    const recoveredEpoch = oldEpoch + 120;

    fs.writeFileSync(statePath, JSON.stringify({
      start_time_epoch: oldEpoch,
      activity: [],
    }, null, 2));

    fs.writeFileSync(path.join(root, 'worker-output.txt'), 'worker changes\n');
    execFileSync('git', ['add', 'worker-output.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', `fix(${ticketId}): stale session evidence`, '--no-gpg-sign'], {
      cwd: root,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `${commitEpoch} +0000`,
        GIT_COMMITTER_DATE: `${commitEpoch} +0000`,
      },
    });

    fs.writeFileSync(
      `${statePath}.tmp.999999999.1`,
      JSON.stringify({
        start_time_epoch: recoveredEpoch,
        activity: [],
      }, null, 2),
    );

    const result = autoFillCompletionCommit({
      sessionDir,
      workingDir: root,
      ticketId,
      statePath,
    });

    assert.deepEqual(result, [{ ticketId, sha: null, action: 'no_evidence' }]);
    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.doesNotMatch(updated, /completion_commit:/);
    const recoveredState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(recoveredState.start_time_epoch, recoveredEpoch);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('autoFillCompletionCommit: recovers tmp-only state before filtering completion evidence', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const ticketId = '8ac24b3e';
    const ticketPath = writeTicket(sessionDir, ticketId);
    const statePath = path.join(sessionDir, 'state.json');
    const recoveredEpoch = 1_700_000_120;
    const commitEpoch = recoveredEpoch - 60;

    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      `${statePath}.tmp.999999999.1`,
      JSON.stringify({
        start_time_epoch: recoveredEpoch,
        activity: [],
      }, null, 2),
    );

    fs.writeFileSync(path.join(root, 'worker-output.txt'), 'worker changes\n');
    execFileSync('git', ['add', 'worker-output.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', `fix(${ticketId}): stale session evidence`, '--no-gpg-sign'], {
      cwd: root,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: `${commitEpoch} +0000`,
        GIT_COMMITTER_DATE: `${commitEpoch} +0000`,
      },
    });

    const result = autoFillCompletionCommit({
      sessionDir,
      workingDir: root,
      ticketId,
      statePath,
    });

    assert.deepEqual(result, [{ ticketId, sha: null, action: 'no_evidence' }]);
    const updated = fs.readFileSync(ticketPath, 'utf8');
    assert.doesNotMatch(updated, /completion_commit:/);
    const recoveredState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(recoveredState.start_time_epoch, recoveredEpoch);
    assert.equal(fs.existsSync(`${statePath}.tmp.999999999.1`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('autoFillCompletionCommit: a persist failure reports unwritable, not unreadable', () => {
  // The ticket file READS fine and the evidence resolves — only the write-back
  // fails. Labelling that `unreadable` told the operator to go look at a read
  // path that worked, so the output-side failure gets its own verdict.
  const root = makeTmpRoot();
  try {
    const repo = path.join(root, 'repo');
    const sessionDir = path.join(root, 'sessions', '2026-08-09-unwritable');
    fs.mkdirSync(repo, { recursive: true });
    initGitRepo(repo);

    const ticketId = 'c0ffee01';
    const ticketPath = writeTicket(sessionDir, ticketId);
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      start_time_epoch: Math.floor(Date.now() / 1000) - 60,
      activity: [],
    }, null, 2));

    fs.writeFileSync(path.join(repo, 'worker.txt'), 'worker changes\n');
    execFileSync('git', ['add', 'worker.txt'], { cwd: repo });
    execFileSync(
      'git',
      ['commit', '-m', 'close gap', '--trailer', `Pickle-Ticket: ${ticketId}`, '--no-gpg-sign'],
      { cwd: repo, stdio: 'ignore' },
    );

    fs.chmodSync(ticketPath, 0o444);
    try {
      const result = autoFillCompletionCommit({ sessionDir, workingDir: repo, statePath });
      assert.deepEqual(result, [{ ticketId, sha: null, action: 'unwritable' }]);
    } finally {
      fs.chmodSync(ticketPath, 0o644);
    }
    // The read-only file is unchanged: no completion_commit was persisted.
    assert.doesNotMatch(fs.readFileSync(ticketPath, 'utf8'), /completion_commit/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AP-EXT-ITER4-02 (subsystem contract #1, replay of AP-EXT-ITER4-01): the CLI entry guard must
// survive a symlinked install root. Node realpaths `import.meta.url` but leaves `process.argv[1]`
// exactly as written, so the pre-fix `import.meta.url === new URL('file://' + argv[1]).href` compare
// disagreed with itself whenever argv[1] carried a link — a `--prefix`-relocated install root, or a
// relocated `$HOME`. The CLI then printed nothing and exited 0, so an operator running it to back-fill
// a missing `completion_commit` got a silent no-op that reads as success.
//
// Every other test in this file imports `autoFillCompletionCommit` directly and therefore never
// evaluates the guard at all. This one SPAWNS the shipped entry and asserts on its EMITTED output;
// a source-shape oracle is deliberately avoided, since grepping for the guard text greens the
// moment someone swaps one realpath-exact spelling for another.
const SHIPPED_AUTO_FILL_CLI = path.join(import.meta.dirname, '..', 'bin', 'auto-fill-completion-commit.js');

/** Runs the shipped CLI entry and returns its trimmed stdout ('' when the entry never fired). */
function runShippedAutoFillCli(scriptPath, sessionDir, workingDir) {
  return execFileSync(
    process.execPath,
    [scriptPath, '--session-dir', sessionDir, '--working-dir', workingDir],
    { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

test('AP-EXT-ITER4-02: the CLI entry still emits its result through a symlinked install root', () => {
  const root = makeTmpRoot('auto-fill-symlink-root-');
  try {
    const sessionDir = path.join(root, 'session');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    initGitRepo(repo);

    // A symlinked bin dir reproduces the relocated-root relationship on ANY platform:
    // argv[1] carries the link, `import.meta.url` resolves to the target.
    const linkedBin = path.join(root, 'bin-link');
    fs.symlinkSync(path.dirname(SHIPPED_AUTO_FILL_CLI), linkedBin);

    const throughSymlink = runShippedAutoFillCli(
      path.join(linkedBin, 'auto-fill-completion-commit.js'),
      sessionDir,
      repo,
    );
    assert.notEqual(
      throughSymlink,
      '',
      'CLI produced NO output through a symlinked install root — the entry guard never fired and the run is a silent exit-0 no-op',
    );

    // Control: the real path must produce the identical result, so a future regression is
    // attributable to the symlink axis rather than to the fixture.
    const throughRealPath = runShippedAutoFillCli(SHIPPED_AUTO_FILL_CLI, sessionDir, repo);
    assert.deepEqual(JSON.parse(throughSymlink), JSON.parse(throughRealPath));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The guard fires on argv[1]'s BASENAME, so it must not fire for a sibling module that merely
// imports this one — `spawn-morty.js` does exactly that, and a false fire there would run the
// deprecated upsert (and print the banner) on every worker spawn.
test('AP-EXT-ITER4-02: importing the module does not fire the CLI entry', () => {
  const root = makeTmpRoot('auto-fill-import-no-fire-');
  try {
    const importer = path.join(root, 'importer.mjs');
    fs.writeFileSync(
      importer,
      `import { autoFillCompletionCommit } from ${JSON.stringify(SHIPPED_AUTO_FILL_CLI)};\n`
      + 'process.stdout.write(typeof autoFillCompletionCommit);\n',
    );
    const out = execFileSync(process.execPath, [importer], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(out, 'function', 'import must resolve the export without running the CLI entry');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// AP-EXT-ITER6-01: the completion-attribution window is fenced by the START COMMIT's
// date, never by `state.start_time_epoch`.
//
// Both answer "when did this session begin?", but `start_time_epoch` is the wall-clock
// origin the budget consumers measure `now - startEpoch` against, and THREE producers
// advance it FORWARD mid-session on purpose: `mux-runner.ts` adds the parked wall of a
// rate-limit park, `setup.ts:applyResumeConfig` resets it to the resume time (AC-LPB-05),
// and `pipeline-runner.ts` resets it on reconstruction. Fed into
// `scanGitLogByTrailer`'s `--since` / `e.epoch < startEpoch` fence, each one retroactively
// pushes the session's OWN commits behind its own start.
//
// Drive the REAL git repo and the REAL predicate, and assert the ON-DISK STAMP: the only
// difference between the two cases below is a number in state.json, and the pre-fix code
// answered `no_evidence` quietly.
function commitAt({ cwd, epoch, message, ticketId }) {
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: `${epoch} +0000`,
    GIT_COMMITTER_DATE: `${epoch} +0000`,
  };
  const args = ['commit', '-m', message, '--no-gpg-sign'];
  if (ticketId) args.push('--trailer', `Pickle-Ticket: ${ticketId}`);
  execFileSync('git', args, { cwd, stdio: 'ignore', env, timeout: 30_000 });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 30_000 }).trim();
}

test('AP-EXT-ITER6-01: a rate-limit park moves start_time_epoch past the session\'s own commit — attribution still lands', () => {
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const ticketId = 'a17c0de1';
    const ticketPath = writeTicket(sessionDir, ticketId);
    const statePath = path.join(sessionDir, 'state.json');

    const baseEpoch = 1_700_000_000;
    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    execFileSync('git', ['add', 'base.txt'], { cwd: root, timeout: 30_000 });
    const startCommit = commitAt({ cwd: root, epoch: baseEpoch, message: 'session base' });

    // The worker's real, correctly-trailered delivery, made DURING the session.
    fs.writeFileSync(path.join(root, 'worker.txt'), 'worker changes\n');
    execFileSync('git', ['add', 'worker.txt'], { cwd: root, timeout: 30_000 });
    const workerSha = commitAt({ cwd: root, epoch: baseEpoch + 600, message: 'deliver the ticket', ticketId });

    // ...then a 6h rate-limit park advances start_time_epoch past that commit
    // (`max_park_minutes` default 360). Measured live: real sessions carry gaps of
    // up to 43,312s between a ticket's own completion commit and start_time_epoch.
    fs.writeFileSync(statePath, JSON.stringify({
      start_commit: startCommit,
      start_time_epoch: baseEpoch + 600 + 21_600,
      activity: [],
    }, null, 2));

    const result = autoFillCompletionCommit({ sessionDir, workingDir: root, ticketId, statePath });

    assert.deepEqual(result, [{ ticketId, sha: workerSha, action: 'filled' }]);
    assert.match(
      fs.readFileSync(ticketPath, 'utf8'),
      new RegExp(`completion_commit:\\s*"?${workerSha}"?`),
      'the durable completion_commit stamp must land despite the advanced epoch',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER6-01: the fence still holds — a commit older than start_commit is not attributed', () => {
  // The negative control. Widening the window origin from wall-clock-start to the start
  // commit's date must not admit PRE-session work: without this, "fixed" and "fence
  // removed" are indistinguishable.
  const root = makeTmpRoot();
  try {
    initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    const ticketId = 'b22e1d02';
    const ticketPath = writeTicket(sessionDir, ticketId);
    const statePath = path.join(sessionDir, 'state.json');

    const baseEpoch = 1_700_000_000;

    // A trailered commit that predates the session baseline.
    fs.writeFileSync(path.join(root, 'earlier.txt'), 'earlier\n');
    execFileSync('git', ['add', 'earlier.txt'], { cwd: root, timeout: 30_000 });
    commitAt({ cwd: root, epoch: baseEpoch - 1_000, message: 'pre-session work', ticketId });

    fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
    execFileSync('git', ['add', 'base.txt'], { cwd: root, timeout: 30_000 });
    const startCommit = commitAt({ cwd: root, epoch: baseEpoch, message: 'session base' });

    fs.writeFileSync(statePath, JSON.stringify({
      start_commit: startCommit,
      start_time_epoch: baseEpoch,
      activity: [],
    }, null, 2));

    const result = autoFillCompletionCommit({ sessionDir, workingDir: root, ticketId, statePath });

    assert.deepEqual(result, [{ ticketId, sha: null, action: 'no_evidence' }]);
    assert.doesNotMatch(fs.readFileSync(ticketPath, 'utf8'), /completion_commit:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
