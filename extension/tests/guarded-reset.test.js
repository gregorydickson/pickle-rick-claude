// @tier: fast
// Ticket 0780b805 (H3/CUJ-9): archiveBeforeDestructive — fail-closed pre-reset
// archival of staged + unstaged + untracked work, .codegraph exclusion, and the
// extended resetToSha archive context.
// Ticket 0d1590f4 (H3): callsite adoption (spawn-morty gate-fail reset,
// microverse rollback) + audit-guarded-reset.sh enforcement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  archiveBeforeDestructive,
  ArchiveAbortError,
  isCodegraphArtifact,
  resetToSha,
} from '../services/git-utils.js';

function initGitRepo(repoDir) {
  execFileSync('git', ['init', '--quiet'], { cwd: repoDir, timeout: 8000 });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: repoDir, timeout: 5000 });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, timeout: 5000 });
}

function gitCommit(repoDir, message) {
  execFileSync('git', ['add', '-A'], { cwd: repoDir, timeout: 8000 });
  execFileSync('git', ['commit', '--no-gpg-sign', '--allow-empty', '-m', message], { cwd: repoDir, timeout: 8000 });
  return headSha(repoDir);
}

function headSha(repoDir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8', timeout: 5000 }).trim();
}

function gitStatusPorcelain(repoDir) {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf-8', timeout: 5000 });
}

/**
 * Fixture: tmp git repo with one committed file, plus a session dir with a
 * minimal recoverable state.json and a ticket dir for archive destinations.
 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-guarded-reset-'));
  const repo = path.join(root, 'repo');
  const sessionDir = path.join(root, 'session');
  const ticketDir = path.join(sessionDir, 'tkt0780b805');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(ticketDir, { recursive: true });
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'base content\n');
  const baseline = gitCommit(repo, 'baseline');
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({ active: true, schema_version: 5, iteration: 1 }));
  return { root, repo, sessionDir, ticketDir, statePath, baseline };
}

function readActivity(statePath) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  return Array.isArray(state.activity) ? state.activity : [];
}

function cleanupFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function ctxFor(f, overrides = {}) {
  return { cwd: f.repo, sessionDir: f.sessionDir, ticketDir: f.ticketDir, reason: 'pre_reset', ...overrides };
}

const patchFilesIn = (dir) => fs.readdirSync(dir).filter((n) => /^pre_reset_diff_\d+\.patch$/.test(n));

// --- AC-1: dirty tree → patch with staged+unstaged+untracked content BEFORE clean ---

test('dirty tree: patch archives staged, unstaged, and untracked content before resetToSha cleans the tree', () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'staged.txt'), 'STAGED-MARKER\n');
    execFileSync('git', ['add', 'staged.txt'], { cwd: f.repo, timeout: 8000 });
    fs.appendFileSync(path.join(f.repo, 'tracked.txt'), 'UNSTAGED-MARKER\n');
    fs.writeFileSync(path.join(f.repo, 'untracked.txt'), 'UNTRACKED-MARKER\n');

    resetToSha(f.baseline, f.repo, undefined, ctxFor(f));

    const patches = patchFilesIn(f.ticketDir);
    assert.equal(patches.length, 1, 'exactly one patch in ticketDir');
    const patch = fs.readFileSync(path.join(f.ticketDir, patches[0]), 'utf-8');
    assert.match(patch, /STAGED-MARKER/);
    assert.match(patch, /UNSTAGED-MARKER/);
    assert.match(patch, /UNTRACKED-MARKER/);

    assert.equal(gitStatusPorcelain(f.repo), '', 'tree cleaned after archival');
    assert.equal(headSha(f.repo), f.baseline);

    const events = readActivity(f.statePath).filter((e) => e.event === 'pre_reset_diff_archived');
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.ticket, 'tkt0780b805');
    assert.equal(ev.patch_path, path.join(f.ticketDir, patches[0]));
    assert.equal(ev.files_truncated, false);
    assert.equal(ev.reason, 'pre_reset');
    assert.equal(typeof ev.ts, 'string');
    assert.deepEqual([...ev.files].sort(), ['staged.txt', 'tracked.txt', 'untracked.txt']);
  } finally {
    cleanupFixture(f.root);
  }
});

// --- AC-2: untracked content round-trips byte-exact ---

test('untracked file round-trips byte-exact through archive → reset → git apply', () => {
  const f = makeFixture();
  try {
    // unicode + no trailing newline: the hostile case for diff round-trips
    const original = Buffer.from('héllo → pickle\nline two without trailing newline', 'utf-8');
    const rel = 'untracked-roundtrip.txt';
    fs.writeFileSync(path.join(f.repo, rel), original);

    const result = archiveBeforeDestructive(ctxFor(f));
    assert.ok(result, 'dirty tree must archive');
    resetToSha(f.baseline, f.repo);
    assert.ok(!fs.existsSync(path.join(f.repo, rel)), 'untracked file destroyed by reset');

    execFileSync('git', ['apply', result.patchPath], { cwd: f.repo, timeout: 8000 });
    const restored = fs.readFileSync(path.join(f.repo, rel));
    assert.ok(restored.equals(original), 'restored bytes identical to original');
  } finally {
    cleanupFixture(f.root);
  }
});

// --- AC-3: archive failure → fail-closed: op aborted, event emitted, tree untouched ---

test('unwritable archive dir: ArchiveAbortError, pre_reset_archive_failed emitted, destructive op aborted', () => {
  const f = makeFixture();
  try {
    const work = path.join(f.repo, 'precious.txt');
    fs.writeFileSync(work, 'do not lose me\n');
    fs.chmodSync(f.ticketDir, 0o500);

    assert.throws(
      () => resetToSha(f.baseline, f.repo, undefined, ctxFor(f)),
      (err) => err instanceof ArchiveAbortError && err.name === 'ArchiveAbortError',
    );

    assert.ok(fs.existsSync(work), 'tree untouched: uncommitted work survives');
    assert.match(gitStatusPorcelain(f.repo), /precious\.txt/);
    assert.equal(headSha(f.repo), f.baseline, 'no reset ran');

    const events = readActivity(f.statePath).filter((e) => e.event === 'pre_reset_archive_failed');
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'pre_reset');
    assert.equal(events[0].ticket, 'tkt0780b805');
    assert.equal(typeof events[0].error, 'string');
    assert.ok(events[0].error.length > 0);
    assert.equal(typeof events[0].ts, 'string');
  } finally {
    fs.chmodSync(f.ticketDir, 0o700);
    cleanupFixture(f.root);
  }
});

// --- AC-4: clean tree → no patch, no event ---

test('clean tree: returns null, writes no patch, emits no event', () => {
  const f = makeFixture();
  try {
    const result = archiveBeforeDestructive(ctxFor(f));
    assert.equal(result, null);
    assert.equal(patchFilesIn(f.ticketDir).length, 0);
    assert.equal(patchFilesIn(f.sessionDir).length, 0);
    const events = readActivity(f.statePath).filter(
      (e) => e.event === 'pre_reset_diff_archived' || e.event === 'pre_reset_archive_failed',
    );
    assert.equal(events.length, 0);
  } finally {
    cleanupFixture(f.root);
  }
});

// --- AC-5: .codegraph exclusion from dirty-check and archive ---

test('.codegraph-only dirt: tree treated as clean (no patch, no event)', () => {
  const f = makeFixture();
  try {
    fs.mkdirSync(path.join(f.repo, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(f.repo, '.codegraph', 'index.json'), '{"CODEGRAPH-MARKER":1}\n');
    const result = archiveBeforeDestructive(ctxFor(f));
    assert.equal(result, null);
    assert.equal(patchFilesIn(f.ticketDir).length, 0);
    assert.equal(readActivity(f.statePath).filter((e) => String(e.event).startsWith('pre_reset')).length, 0);
  } finally {
    cleanupFixture(f.root);
  }
});

test('.codegraph excluded from a mixed archive: patch and files omit codegraph paths', () => {
  const f = makeFixture();
  try {
    fs.mkdirSync(path.join(f.repo, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(f.repo, '.codegraph', 'index.json'), '{"CODEGRAPH-MARKER":1}\n');
    fs.writeFileSync(path.join(f.repo, 'real-work.txt'), 'REAL-WORK\n');

    const result = archiveBeforeDestructive(ctxFor(f));
    assert.ok(result);
    assert.deepEqual(result.files, ['real-work.txt']);
    const patch = fs.readFileSync(result.patchPath, 'utf-8');
    assert.match(patch, /REAL-WORK/);
    assert.ok(!patch.includes('CODEGRAPH-MARKER'), 'codegraph content not archived');
    assert.ok(!patch.includes('.codegraph'), 'codegraph paths not archived');
  } finally {
    cleanupFixture(f.root);
  }
});

test('isCodegraphArtifact matrix: .codegraph/** true, siblings and nested false', () => {
  for (const p of ['.codegraph', '.codegraph/index.json', '.codegraph/a/b.json', './.codegraph/x', '.codegraph\\win.json']) {
    assert.equal(isCodegraphArtifact(p), true, `expected true: ${p}`);
  }
  for (const p of ['.codegraphx/a', 'src/.codegraph/a', 'codegraph/a', 'a/.codegraph', 'codegraph', '']) {
    assert.equal(isCodegraphArtifact(p), false, `expected false: ${p}`);
  }
});

// --- byte cap → files_truncated ---

test('byte cap exceeded: filesTruncated flag set on result and event, files list intact', () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'big-a.txt'), 'A'.repeat(256) + '\n');
    fs.writeFileSync(path.join(f.repo, 'big-b.txt'), 'B'.repeat(256) + '\n');

    const result = archiveBeforeDestructive(ctxFor(f), 16);
    assert.ok(result);
    assert.equal(result.filesTruncated, true);
    assert.deepEqual([...result.files].sort(), ['big-a.txt', 'big-b.txt']);

    const events = readActivity(f.statePath).filter((e) => e.event === 'pre_reset_diff_archived');
    assert.equal(events.length, 1);
    assert.equal(events[0].files_truncated, true);
  } finally {
    cleanupFixture(f.root);
  }
});

// --- AP-EXT-ITER32-01: a truncated archive REFUSES the destructive reset ---

test('AP-EXT-ITER32-01: byte-cap truncation refuses the reset and the unarchivable work survives', () => {
  const f = makeFixture();
  try {
    // resetToSha archives at the compiled ARCHIVE_UNTRACKED_BYTE_CAP (10 MiB), so the
    // fixture has to actually cross it — a smaller cap is not reachable through this seam.
    const rel = 'huge-untracked.txt';
    const line = 'A'.repeat(79) + '\n';
    const oversize = line.repeat(Math.ceil((10 * 1024 * 1024 + 4096) / line.length));
    fs.writeFileSync(path.join(f.repo, rel), oversize);
    fs.appendFileSync(path.join(f.repo, 'tracked.txt'), 'UNSTAGED-MARKER\n');

    assert.throws(
      () => resetToSha(f.baseline, f.repo, undefined, ctxFor(f)),
      (err) => err instanceof ArchiveAbortError && /TRUNCATED/.test(err.message),
    );

    // The destructive half must not have run: `git clean -fd` would have deleted the
    // untracked file the patch could not hold, and `reset --hard` the tracked edit.
    assert.equal(fs.existsSync(path.join(f.repo, rel)), true, 'unarchivable untracked file survives');
    assert.equal(fs.statSync(path.join(f.repo, rel)).size, Buffer.byteLength(oversize));
    assert.match(fs.readFileSync(path.join(f.repo, 'tracked.txt'), 'utf-8'), /UNSTAGED-MARKER/);
    assert.notEqual(gitStatusPorcelain(f.repo), '', 'tree left dirty for triage');
    assert.equal(headSha(f.repo), f.baseline);

    const failed = readActivity(f.statePath).filter((e) => e.event === 'pre_reset_archive_failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].error, /TRUNCATED/);
    assert.equal(failed[0].reason, 'pre_reset');
    assert.equal(failed[0].ticket, 'tkt0780b805');
    // the partial patch is still written and still reports itself truncated — the
    // refusal is what stops it being treated as a complete backup.
    const archived = readActivity(f.statePath).filter((e) => e.event === 'pre_reset_diff_archived');
    assert.equal(archived.length, 1);
    assert.equal(archived[0].files_truncated, true);
  } finally {
    cleanupFixture(f.root);
  }
});

// --- sessionDir fallback for non-ticket callers ---

test('no ticketDir: patch falls back to sessionDir and event ticket is null', () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'loose-end.txt'), 'SESSION-LEVEL\n');
    const result = archiveBeforeDestructive(ctxFor(f, { ticketDir: null }));
    assert.ok(result);
    assert.equal(path.dirname(result.patchPath), f.sessionDir);
    assert.equal(patchFilesIn(f.sessionDir).length, 1);
    const events = readActivity(f.statePath).filter((e) => e.event === 'pre_reset_diff_archived');
    assert.equal(events.length, 1);
    assert.equal(events[0].ticket, null);
  } finally {
    cleanupFixture(f.root);
  }
});

// --- AC-6 adjunct: extended resetToSha stays compatible with legacy call shapes ---

test('resetToSha without archive context behaves as before (no patch, no event)', () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'unarchived.txt'), 'gone\n');
    resetToSha(f.baseline, f.repo);
    assert.equal(gitStatusPorcelain(f.repo), '');
    assert.equal(patchFilesIn(f.ticketDir).length, 0);
    assert.equal(readActivity(f.statePath).filter((e) => String(e.event).startsWith('pre_reset')).length, 0);
  } finally {
    cleanupFixture(f.root);
  }
});

// ===========================================================================
// Ticket 0d1590f4 — callsite adoption + audit-guarded-reset.sh
// ===========================================================================

const extensionRoot = fileURLToPath(new URL('..', import.meta.url));
const auditScript = path.join(extensionRoot, 'scripts', 'audit-guarded-reset.sh');

function readSourcePair(relTs, relJs) {
  return {
    ts: fs.readFileSync(path.join(extensionRoot, relTs), 'utf-8'),
    js: fs.readFileSync(path.join(extensionRoot, relJs), 'utf-8'),
  };
}

// --- adoption: spawn-morty gate-fail reset is archive-first, ticket-scoped ---

test('adoption: spawn-morty gate-fail resetToSha passes ticket-scoped archive context with reason pre_reset (source + compiled mirror)', () => {
  const { ts, js } = readSourcePair('src/bin/spawn-morty.ts', 'bin/spawn-morty.js');
  const callShape = /resetToSha\(args\.preWorkerHead, args\.workingDir, preservePrefixes, \{[\s\S]{0,400}?reason: 'pre_reset',?[\s\S]{0,100}?\}\)/;
  assert.match(ts, callShape, 'TS source: gate-fail reset must pass an archive context');
  assert.match(js, callShape, 'compiled mirror: gate-fail reset must pass an archive context');
  // ticket-scoped: ticketDir derived from sessionDir + ticketId, sessionDir from statePath
  assert.match(ts, /const sessionDir = path\.dirname\(args\.statePath\);\s*\n\s*const ticketDir = path\.join\(sessionDir, args\.ticketId\);/);
  // fail-closed handling stays visible: ArchiveAbortError branch in the catch
  assert.match(ts, /catch \(err\) \{\s*\n\s*if \(err instanceof ArchiveAbortError\)/);
  assert.match(js, /err instanceof ArchiveAbortError/);
});

// --- adoption: microverse rollback archives to session-level fallback ---

test('adoption: microverse rollback resetToSha passes session-level archive context with reason microverse_rollback (source + compiled mirror)', () => {
  const { ts, js } = readSourcePair('src/bin/microverse-runner.ts', 'bin/microverse-runner.js');
  // B-RRH C4 (84f79bfc): guardedMicroverseRollback hoists `const target = ctx.preIterSha ?? ''`
  // for the is-ancestor orphan guard, then passes `target` into resetToSha. Semantically identical
  // to the prior inline `ctx.preIterSha ?? ''`; the session-level archive context is unchanged.
  const callShape = /_deps\.resetToSha\(target, ctx\.workingDir, undefined, \{[\s\S]{0,200}?sessionDir: ctx\.sessionDir,[\s\S]{0,100}?ticketDir: null,[\s\S]{0,100}?reason: 'microverse_rollback',?[\s\S]{0,50}?\}\)/;
  assert.match(ts, callShape, 'TS source: rollback must pass a session-level archive context');
  assert.match(js, callShape, 'compiled mirror: rollback must pass a session-level archive context');
});

// --- behavior: microverse-shaped context — session-level patch, rollback reason ---

test('microverse-shaped context: patch lands in sessionDir with reason microverse_rollback before the reset destroys the work', () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'iteration-work.txt'), 'ROLLBACK-MARKER\n');
    resetToSha(f.baseline, f.repo, undefined, {
      cwd: f.repo,
      sessionDir: f.sessionDir,
      ticketDir: null,
      reason: 'microverse_rollback',
    });

    assert.equal(gitStatusPorcelain(f.repo), '', 'tree reset after archival');
    const patches = patchFilesIn(f.sessionDir);
    assert.equal(patches.length, 1, 'patch archived at session level');
    assert.match(fs.readFileSync(path.join(f.sessionDir, patches[0]), 'utf-8'), /ROLLBACK-MARKER/);

    const events = readActivity(f.statePath).filter((e) => e.event === 'pre_reset_diff_archived');
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'microverse_rollback');
    assert.equal(events[0].ticket, null);
  } finally {
    cleanupFixture(f.root);
  }
});

// --- audit-guarded-reset.sh ---

function runAudit(srcOverride) {
  const env = { ...process.env };
  delete env.GUARDED_RESET_SRC_OVERRIDE;
  if (srcOverride) env.GUARDED_RESET_SRC_OVERRIDE = srcOverride;
  return spawnSync('bash', [auditScript], { encoding: 'utf-8', timeout: 30000, env });
}

function makeAuditFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-guarded-audit-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, 'src', rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { root, srcDir: path.join(root, 'src') };
}

test('audit: exits 0 against the real src/ tree (adopted HEAD)', () => {
  const result = runAudit(null);
  assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  assert.match(result.stdout, /no unguarded destructive callsites/);
});

test('audit: seeded raw git reset --hard → exit 1 naming file:line', () => {
  const f = makeAuditFixture({
    'bin/bad.ts': "import { runGit } from '../services/git-utils.js';\nexport function nuke(cwd: string): void {\n  runGit(['reset', '--hard', 'HEAD~1'], cwd);\n}\n",
  });
  try {
    const result = runAudit(f.srcDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bin\/bad\.ts:3: raw `git reset --hard`/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('audit: seeded shell-string git reset --hard → exit 1 naming file:line', () => {
  const f = makeAuditFixture({
    'services/sneaky.ts': "export const cmd = `git reset --hard ${'HEAD'}`;\n",
  });
  try {
    const result = runAudit(f.srcDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /services\/sneaky\.ts:1: raw `git reset --hard`/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('audit: seeded resetToSha without archive context → exit 1 naming file:line', () => {
  const f = makeAuditFixture({
    'bin/unguarded.ts': "import { resetToSha } from '../services/git-utils.js';\nexport function rollback(sha: string, cwd: string): void {\n  resetToSha(sha, cwd);\n}\n",
  });
  try {
    const result = runAudit(f.srcDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bin\/unguarded\.ts:3: resetToSha\(\) without archive context/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('audit: seeded directory-scoped git restore and git clean → exit 1 naming each file:line', () => {
  const f = makeAuditFixture({
    'bin/restore-dir.ts': "export const a = 'git restore extension/';\n",
    'bin/cleaner.ts': "import { runGit } from '../services/git-utils.js';\nexport const wipe = (cwd: string) => runGit(['clean', '-fd'], cwd);\n",
  });
  try {
    const result = runAudit(f.srcDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bin\/restore-dir\.ts:1: directory-scoped `git restore`/);
    assert.match(result.stderr, /bin\/cleaner\.ts:2: raw `git clean`/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('audit: guarded call, path-scoped ops, comments, and allowlisted helper internals → exit 0', () => {
  const f = makeAuditFixture({
    // guarded resetToSha call (multi-line archive context)
    'bin/guarded.ts': "import { resetToSha } from '../services/git-utils.js';\nexport function safeRollback(sha: string, cwd: string, sessionDir: string): void {\n  resetToSha(sha, cwd, undefined, {\n    cwd,\n    sessionDir,\n    ticketDir: null,\n    reason: 'pre_reset',\n  });\n}\n",
    // path-scoped checkout (R-WSRC-GR allowed form) + path-scoped restore message
    'bin/path-scoped.ts': "export const recover = (paths: string[]) => ['checkout', '--', ...paths];\nexport const msg = 'use git restore <paths> instead';\n",
    // comment mentions must not trip
    'bin/commented.ts': "// a worker may `git reset --hard` to the pre-ticket sha\n/* never run git clean here */\nexport const x = 1;\n",
    // helper internals are allowlisted
    'services/git-utils.ts': "export function resetToSha(sha: string, cwd: string): void {\n  runGit(['reset', '--hard', sha], cwd);\n  runGit(['clean', '-fd'], cwd);\n}\n",
  });
  try {
    const result = runAudit(f.srcDir);
    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
