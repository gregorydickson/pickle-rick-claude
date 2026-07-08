// @tier: fast
//
// R-RRH C8: Dirty-tree relaunch self-heals the crashed ticket's files
// (truncation-safe). Covers all four acceptance criteria against real temp git
// repos with a PICKLE_DATA_ROOT sandbox:
//   AC1  large (>cap) crashed tree → archive truncates → FATAL +
//        crashed_ticket_files_quarantine_truncated; tree NOT cleaned.
//   AC2  small in-scope crashed tree → archived (patch round-trip RECOVERABLE) +
//        ticket reset to Todo + preflight proceeds.
//   AC3  current_ticket==null → scopes against the UNION of In-Progress/Todo
//        declared files; empty-set-because-null never FATALs.
//   AC4  dirty OUTSIDE working_dir → still FATAL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  quarantineCrashedTicketFilesOrFatal,
  classifyDirtyTreeBranch,
} from '../bin/pipeline-runner.js';
import { ARCHIVE_UNTRACKED_BYTE_CAP } from '../services/git-utils.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rrh-dirty-quarantine-')));
}

function initGitRepo(repoDir) {
  execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
}

function gitCommitAll(repoDir, message) {
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '--no-gpg-sign', '-m', message], { cwd: repoDir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' }).trim();
}

/** Write a ticket dir + frontmatter with a declared `Files to modify/create` line. */
function writeTicket(sessionDir, ticketId, status, declaredFiles) {
  const dir = path.join(sessionDir, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const declared = declaredFiles.map((f) => `\`${f}\``).join(', ');
  const md = [
    '---',
    `id: ${ticketId}`,
    `status: ${status}`,
    'order: 1',
    '---',
    '# Description',
    '## Implementation Details',
    `**Files to modify/create**: ${declared}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, `rick_ticket_${ticketId}.md`), md);
  return dir;
}

function ticketStatus(sessionDir, ticketId) {
  const md = fs.readFileSync(path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`), 'utf-8');
  const m = md.match(/^status:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

const NO_OP_LOG = () => {};

// ---------------------------------------------------------------------------
// Pure decision (unit) — branch classification
// ---------------------------------------------------------------------------

test('classifyDirtyTreeBranch: clean tree → branch=clean', () => {
  const d = classifyDirtyTreeBranch('/repo', '/repo', [], 't1', new Map([['t1', ['src/a.ts']]]));
  assert.equal(d.branch, 'clean');
});

test('classifyDirtyTreeBranch: empty-set-because-null → never outside/fatal', () => {
  // current_ticket null + empty declared map + no dirt → clean, no FATAL classification.
  const d = classifyDirtyTreeBranch('/repo', '/repo', [], null, new Map());
  assert.equal(d.branch, 'clean');
});

test('classifyDirtyTreeBranch: union scope when current_ticket==null', () => {
  const decl = new Map([['t1', ['src/a.ts']], ['t2', ['src/b.ts']]]);
  const d = classifyDirtyTreeBranch('/repo', '/repo', ['src/b.ts'], null, decl);
  assert.equal(d.branch, 'in_scope');
  assert.deepEqual(d.inScope, ['src/b.ts']);
});

test('classifyDirtyTreeBranch: unowned dirt → quarantine branch', () => {
  const decl = new Map([['t1', ['src/a.ts']]]);
  const d = classifyDirtyTreeBranch('/repo', '/repo', ['src/unowned.ts'], 't1', decl);
  assert.equal(d.branch, 'unowned_quarantine');
  assert.deepEqual(d.unowned, ['src/unowned.ts']);
});

test('classifyDirtyTreeBranch: repo-relative path above workingDir subdir → outside_working_dir', () => {
  // repoRoot=/repo, workingDir=/repo/sub; a repo-relative 'outside.txt' resolves
  // to /repo/outside.txt which is NOT under /repo/sub → Branch 4.
  const d = classifyDirtyTreeBranch('/repo', '/repo/sub', ['outside.txt'], null, new Map());
  assert.equal(d.branch, 'outside_working_dir');
  assert.deepEqual(d.outside, ['outside.txt']);
});

// ---------------------------------------------------------------------------
// AC1: large (>cap) crashed tree → archive truncates → FATAL, tree NOT cleaned.
// ---------------------------------------------------------------------------

test('AC1: archive truncated → FATAL + crashed_ticket_files_quarantine_truncated, tree NOT cleaned', () => {
  const tmp = tmpRoot();
  const dataRoot = path.join(tmp, 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const repoDir = path.join(tmp, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'base\n');
  gitCommitAll(repoDir, 'baseline');

  const ticketId = 'aaaa1111';
  writeTicket(sessionDir, ticketId, 'In Progress', ['big.bin']);

  // Untracked crashed-ticket file just over a deliberately tiny cap → truncation.
  const tinyCap = 64;
  const bigFile = path.join(repoDir, 'big.bin');
  fs.writeFileSync(bigFile, 'X'.repeat(tinyCap + 4096));

  // The REAL cap is exported (we use a tiny injected cap for determinism, but
  // prove the constant is reachable so callers/tests need not guess a size).
  assert.equal(typeof ARCHIVE_UNTRACKED_BYTE_CAP, 'number');
  assert.ok(ARCHIVE_UNTRACKED_BYTE_CAP > tinyCap);

  const prevRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    assert.throws(
      () => quarantineCrashedTicketFilesOrFatal({
        workingDir: repoDir,
        sessionDir,
        statePath: path.join(sessionDir, 'state.json'),
        currentTicket: ticketId,
        declaredFilesByTicket: new Map([[ticketId, ['big.bin']]]),
        log: NO_OP_LOG,
        byteCap: tinyCap,
      }),
      /TRUNCATED/,
      'truncated archive must FATAL',
    );
  } finally {
    if (prevRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevRoot;
  }

  // Tree NOT cleaned — the un-archivable file is still present with full content.
  assert.ok(fs.existsSync(bigFile), 'truncated tree must NOT be cleaned');
  assert.equal(fs.readFileSync(bigFile, 'utf-8').length, tinyCap + 4096, 'file content preserved intact');

  // Truncation event emitted.
  const activityDir = path.join(dataRoot, 'activity');
  const files = fs.existsSync(activityDir) ? fs.readdirSync(activityDir) : [];
  const allLines = files.flatMap((f) => fs.readFileSync(path.join(activityDir, f), 'utf-8').split('\n')).filter(Boolean);
  const truncEvents = allLines.filter((l) => l.includes('crashed_ticket_files_quarantine_truncated'));
  assert.ok(truncEvents.length >= 1, 'crashed_ticket_files_quarantine_truncated must be emitted');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC2: small in-scope crashed tree → archived (patch round-trip RECOVERABLE) +
//      ticket reset to Todo + preflight proceeds.
// ---------------------------------------------------------------------------

test('AC2: small in-scope → archived patch is round-trip recoverable + ticket → Todo + proceeds', () => {
  const tmp = tmpRoot();
  const dataRoot = path.join(tmp, 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const repoDir = path.join(tmp, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'base\n');
  // src/ is already tracked (a real repo dir) so a new file shows at file
  // granularity (git collapses a wholly-untracked dir to the dir prefix).
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'keep.ts'), 'export const keep = 0;\n');
  gitCommitAll(repoDir, 'baseline');

  const ticketId = 'bbbb2222';
  const ticketDir = writeTicket(sessionDir, ticketId, 'In Progress', ['src/crashed.ts']);

  // Crashed-ticket untracked source file (small — well under the real cap).
  const CONTENT = 'export const halfImplemented = 42;\n';
  fs.writeFileSync(path.join(repoDir, 'src', 'crashed.ts'), CONTENT);

  const prevRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    quarantineCrashedTicketFilesOrFatal({
      workingDir: repoDir,
      sessionDir,
      statePath: path.join(sessionDir, 'state.json'),
      currentTicket: ticketId,
      declaredFilesByTicket: new Map([[ticketId, ['src/crashed.ts']]]),
      log: NO_OP_LOG,
    });
  } finally {
    if (prevRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevRoot;
  }

  // Ticket reset to Todo.
  assert.equal(ticketStatus(sessionDir, ticketId), 'Todo', 'crashed ticket must be reset to Todo');

  // In-scope dirt cleaned → preflight would now proceed (tree clean for that path).
  assert.ok(!fs.existsSync(path.join(repoDir, 'src', 'crashed.ts')), 'in-scope untracked file removed by clean');

  // TRAP-DOOR round-trip: the pre_reset_diff_*.patch RESTORES the content.
  const patches = fs.readdirSync(ticketDir).filter((f) => f.startsWith('pre_reset_diff_') && f.endsWith('.patch'));
  assert.ok(patches.length >= 1, 'a pre_reset_diff_*.patch must be written');
  const patchPath = path.join(ticketDir, patches[0]);
  // Apply the archived patch back onto the clean tree and assert content restored.
  execFileSync('git', ['apply', '--whitespace=nowarn', patchPath], { cwd: repoDir });
  const restored = fs.readFileSync(path.join(repoDir, 'src', 'crashed.ts'), 'utf-8');
  assert.equal(restored, CONTENT, 'archived patch must round-trip-restore the crashed file content');

  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC3: current_ticket==null → union scope; empty-set-because-null never FATALs.
// ---------------------------------------------------------------------------

test('AC3: current_ticket==null scopes against the UNION of In-Progress/Todo declared files', () => {
  const tmp = tmpRoot();
  const dataRoot = path.join(tmp, 'data');
  fs.mkdirSync(dataRoot, { recursive: true });
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const repoDir = path.join(tmp, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'base\n');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'keep.ts'), 'export const keep = 0;\n');
  gitCommitAll(repoDir, 'baseline');

  writeTicket(sessionDir, 'cccc3333', 'Todo', ['src/one.ts']);
  writeTicket(sessionDir, 'dddd4444', 'In Progress', ['src/two.ts']);

  // Dirt belongs to the SECOND ticket's declared files (in the union, not current).
  fs.writeFileSync(path.join(repoDir, 'src', 'two.ts'), 'export const x = 1;\n');

  const decl = new Map([['cccc3333', ['src/one.ts']], ['dddd4444', ['src/two.ts']]]);

  const prevRoot = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    // Must NOT throw — dirt is in the union scope; current_ticket null is healed, not FATAL.
    quarantineCrashedTicketFilesOrFatal({
      workingDir: repoDir,
      sessionDir,
      statePath: path.join(sessionDir, 'state.json'),
      currentTicket: null,
      declaredFilesByTicket: decl,
      log: NO_OP_LOG,
    });
  } finally {
    if (prevRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prevRoot;
  }
  assert.ok(!fs.existsSync(path.join(repoDir, 'src', 'two.ts')), 'union-scoped dirt cleaned');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('AC3b: empty-set-because-null (no tickets, no dirt) never FATALs', () => {
  const tmp = tmpRoot();
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const repoDir = path.join(tmp, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  initGitRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'base\n');
  gitCommitAll(repoDir, 'baseline');

  // current_ticket null, no declared files, clean tree → must return, never throw.
  assert.doesNotThrow(() => quarantineCrashedTicketFilesOrFatal({
    workingDir: repoDir,
    sessionDir,
    statePath: path.join(sessionDir, 'state.json'),
    currentTicket: null,
    declaredFilesByTicket: new Map(),
    log: NO_OP_LOG,
  }));

  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC4: dirty OUTSIDE working_dir → still FATAL (no scope creep).
// ---------------------------------------------------------------------------

test('AC4: dirty path OUTSIDE working_dir → FATAL (no scope creep)', () => {
  const tmp = tmpRoot();
  const sessionDir = path.join(tmp, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  // Repo root is the parent; workingDir is a SUBDIR. A dirty file at the repo
  // root resolves OUTSIDE workingDir.
  const repoRoot = path.join(tmp, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  initGitRepo(repoRoot);
  const workingDir = path.join(repoRoot, 'sub');
  fs.mkdirSync(workingDir, { recursive: true });
  fs.writeFileSync(path.join(workingDir, 'kept.txt'), 'inside\n');
  gitCommitAll(repoRoot, 'baseline');

  // Dirty a file at the repo ROOT (above workingDir) → blocking path '../outside.txt'
  // relative to workingDir resolves outside it.
  fs.writeFileSync(path.join(repoRoot, 'outside.txt'), 'crashed-elsewhere\n');

  assert.throws(
    () => quarantineCrashedTicketFilesOrFatal({
      workingDir,
      sessionDir,
      statePath: path.join(sessionDir, 'state.json'),
      currentTicket: null,
      declaredFilesByTicket: new Map(),
      // Empty exempt-segments so the repo-root-relative outside path is in the blocking set
      // (the default '-- .' subdir pathspec would otherwise scope it away).
      exemptSegments: [],
      log: NO_OP_LOG,
    }),
    /OUTSIDE working_dir/,
    'dirt outside working_dir must FATAL',
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});
