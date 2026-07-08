// @tier: integration
// Characterization test for Path 8: operator-salvage-edit
// Manual frontmatter write: operator adds completion_commit:<sha> to a Done ticket.
// Watcher sees explicit SHA and keeps the ticket Done.
//
// Observable behaviour characterized via:
//   inspectPhantomDoneTicketFile: explicit REACHABLE completion_commit →
//   {changed:false, reason:'has_completion_commit'}. B-1SEAM WS-1 tightened the
//   watcher to git-probe the stamped SHA through the ONE predicate (bare field
//   presence no longer keeps — same tightening as path-7), so the operator's
//   salvage SHA must be a real reachable commit.
//   All 4 SHA quote-forms produce the same observable: the normalizer strips
//   quotes and returns a valid hex SHA which the git probe then verifies.
//
// Decision-matrix: path_id 8 — assert what the code DOES today.
// Quote-form keeps use a local tmp git repo. No live git against the host repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectPhantomDoneTicketFile } from '../../../bin/mux-runner.js';
import { normalizeCompletionCommitField } from '../../../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'decision-matrix.json'), 'utf8'));
const ENTRY = MATRIX.paths.find(p => p.path_id === 8);

function makeTmp(prefix = 'char-path8-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Init a git repo and return { fullSha, shortSha } of its first commit. */
function initGitRepo(dir) {
  const opts = { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'salvaged work', '--no-gpg-sign'], { cwd: dir });
  const fullSha = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();
  const shortSha = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], opts).trim();
  return { fullSha, shortSha };
}

/** Render the operator's raw frontmatter value for a quote-form over a REAL sha. */
function renderShaForm(formId, shortSha, fullSha) {
  switch (formId) {
    case 1: return shortSha;
    case 2: return `"${shortSha}"`;
    case 3: return `"${fullSha}"`;
    case 4: return `'${fullSha}'`;
    default: throw new Error(`unknown sha quote-form id ${formId}`);
  }
}

function writeTicketWithRawFrontmatter(sessionDir, ticketId, completionCommitLine) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = [
    '---',
    `id: ${ticketId}`,
    'title: "Salvaged ticket"',
    'status: Done',
    'order: 1',
  ];
  if (completionCommitLine) lines.push(completionCommitLine);
  lines.push('---', '# Body');
  const ticketPath = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
  fs.writeFileSync(ticketPath, lines.join('\n'));
  return ticketPath;
}

// Extract ticket ID from fixture skeleton keys (path-8 fixture doesn't have current_ticket in state.json)
const ticketId = Object.keys(ENTRY.fixture.session_dir_skeleton).find(k => /^[a-f0-9]+\/rick_ticket/.test(k))?.split('/')[0] ?? 'aabbccdd';

// The 4 SHA quote-forms from the decision-matrix
const SHA_QUOTE_FORMS = MATRIX.sha_quote_forms;

// ---
// All 4 quote-forms: inspectPhantomDoneTicketFile returns has_completion_commit
// ---
for (const form of SHA_QUOTE_FORMS) {
  const { form_id, label } = form;

  test(`path-8 operator-salvage: sha form ${form_id} (${label}) → watcher keeps Done`, () => {
    const root = makeTmp();
    try {
      // B-1SEAM WS-1: the watcher git-probes the stamp, so the salvage SHA must
      // be a real reachable commit — render the quote-form over the repo's sha.
      const { fullSha, shortSha } = initGitRepo(root);
      const example = renderShaForm(form_id, shortSha, fullSha);
      // Write ticket with the raw completion_commit value as the operator would type it
      const ticketPath = writeTicketWithRawFrontmatter(
        root, ticketId, `completion_commit: ${example}`
      );

      const result = inspectPhantomDoneTicketFile(ticketPath, root, root, 'In Progress');

      // Characterize: watcher sees explicit SHA (any quote-form) and does not revert
      assert.equal(result.changed, false,
        `form ${form_id} (${label}): expected changed=false, got ${result.changed}`);
      assert.equal(result.reason, 'has_completion_commit',
        `form ${form_id} (${label}): expected reason=has_completion_commit, got '${result.reason}'`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

// ---
// normalizeCompletionCommitField handles all 4 SHA forms
// ---
test('path-8 normalizeCompletionCommitField: all 4 quote-forms normalize to bare hex', () => {
  const BARE_SHORT_HEX = '4b38893c';
  const BARE_FULL_HEX = '724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8';

  // Form 1: bare short
  assert.equal(normalizeCompletionCommitField('4b38893c'), BARE_SHORT_HEX,
    'form 1 bare short should normalize');
  // Form 2: double-quoted short
  assert.equal(normalizeCompletionCommitField('"4b38893c"'), BARE_SHORT_HEX,
    'form 2 double-quoted short should strip quotes');
  // Form 3: double-quoted full
  assert.equal(
    normalizeCompletionCommitField('"724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8"'),
    BARE_FULL_HEX,
    'form 3 double-quoted full should strip quotes',
  );
  // Form 4: single-quoted full
  assert.equal(
    normalizeCompletionCommitField("'724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8'"),
    BARE_FULL_HEX,
    'form 4 single-quoted full should strip quotes',
  );
});

// ---
// Absent completion_commit → NOT kept (observable: reverted by inspectPhantomDoneTicketFile)
// ---
test('path-8 operator-salvage: absent completion_commit → inspectPhantomDoneTicketFile reverts', () => {
  const root = makeTmp();
  const workingDir = makeTmp('char-path8-notgit-');
  try {
    // Write ticket with no completion_commit (operator didn't add it yet)
    const ticketPath = writeTicketWithRawFrontmatter(root, ticketId, null);

    const result = inspectPhantomDoneTicketFile(ticketPath, root, workingDir, 'Todo');

    // Characterize: absent evidence → reverted (the case BEFORE operator salvage)
    assert.equal(result.changed, true,
      'expected changed=true when no completion_commit (pre-salvage state)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

test('path-8: decision-matrix evidence_source matches explicit', () => {
  assert.equal(ENTRY.evidence_source, 'explicit',
    `expected evidence_source=explicit for path 8, got '${ENTRY.evidence_source}'`);
});
