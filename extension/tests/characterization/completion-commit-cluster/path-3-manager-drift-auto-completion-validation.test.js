// @tier: integration
// Characterization test for Path 3: manager-drift-auto-completion-validation
// applyAutoTicketCompletionValidation called at mux-runner.js:4715 when manager
// detects drift (previousTicket was In Progress but model moved to a new ticket).
//
// Decision-matrix: path_id 3 — assert what the code DOES today.
// Uses PICKLE_TEST_MODE=1 to bypass guardCompletionCommitBeforeDone.
// Uses a local tmp git repo for validateAutoTicketCompletion evidence.
// No live git against the host repo.

// PICKLE_TEST_MODE bypasses guardCompletionCommitBeforeDone for synthetic sessions
process.env.PICKLE_TEST_MODE = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyAutoTicketCompletionValidation } from '../../../bin/mux-runner.js';
import { readFrontmatterField } from '../../../services/pickle-utils.js';
import { commitWorkerFixture } from '../../__helpers__/worker-commit-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'decision-matrix.json'), 'utf8'));
const ENTRY = MATRIX.paths.find(p => p.path_id === 3);

function makeTmp(prefix = 'char-path3-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  const opts = { cwd: dir, stdio: 'ignore' };
  execFileSync('git', ['init', '-q'], opts);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], opts);
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], opts);
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writePrevTicket(sessionDir, ticketId, status = 'In Progress') {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  // Include checked acceptance criteria so validateAutoTicketCompletion returns 'done'
  const content = [
    '---',
    `id: ${ticketId}`,
    `title: "Previous ticket"`,
    `status: "${status}"`,
    'order: 1',
    '---',
    '# Description',
    'Test body',
    '',
    '## Acceptance Criteria',
    '- [x] implementation complete',
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), content);
  return path.join(ticketDir, `rick_ticket_${ticketId}.md`);
}

function withDataRoot(dataRoot, fn) {
  const prev = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prev;
  }
}

test('path-3 manager-drift: applyAutoTicketCompletionValidation marks In-Progress ticket Done when evidence found', () => {
  const root = makeTmp();
  const dataRoot = makeTmp('char-path3-data-');
  try {
    const startCommit = initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    const ticketId = ENTRY.fixture.session_dir_skeleton['state.json'].current_ticket;
    const prevTicketPath = writePrevTicket(sessionDir, ticketId);

    // Create the statePath (needed for clearStaleDoneWithoutCommitEvidence + activity logger)
    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      active: true,
      iteration: 2,
      working_dir: root,
    }, null, 2));

    // Commit referencing the ticketId so validateAutoTicketCompletion finds evidence
    // a4e48c26 deleted subject-line inference — production attributes via a git trailer
    // that names the ticket, so this fixture stamps one instead of relying on the subject alone.
    fs.writeFileSync(path.join(root, 'work.txt'), 'ticket work\n');
    execFileSync('git', ['add', 'work.txt'], { cwd: root, stdio: 'ignore' });
    commitWorkerFixture({ cwd: root, ticketId, message: `feat(${ticketId}): implement drift ticket` });

    const logs = [];
    let result;
    withDataRoot(dataRoot, () => {
      result = applyAutoTicketCompletionValidation({
        sessionDir,
        ticketId,
        workingDir: root,
        startCommit,
        statePath,
        iteration: 2,
        log: (m) => logs.push(m),
        flags: {},
      });
    });

    // Characterize current behaviour: verdict.action='done', ticket flipped to Done
    assert.equal(result.action, 'done',
      `expected action=done, got '${result.action}' (${result.reason})`);

    const content = fs.readFileSync(prevTicketPath, 'utf8');
    const status = readFrontmatterField(content, 'status');
    assert.equal(status, 'Done', `expected status=Done after drift correction, got '${status}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('path-3 manager-drift: no AC evidence → action=skip (acceptance_criteria_not_checked)', () => {
  const root = makeTmp();
  const dataRoot = makeTmp('char-path3-data-');
  try {
    const startCommit = initGitRepo(root);
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });

    const ticketId = ENTRY.fixture.session_dir_skeleton['state.json'].current_ticket;
    // Write ticket WITHOUT checked acceptance criteria
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), [
      '---',
      `id: ${ticketId}`,
      'title: "No-AC ticket"',
      'status: "In Progress"',
      'order: 1',
      '---',
      '## Acceptance Criteria',
      '- [ ] not yet done',
    ].join('\n'));

    const statePath = path.join(sessionDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true, iteration: 1 }, null, 2));

    const logs = [];
    let result;
    withDataRoot(dataRoot, () => {
      result = applyAutoTicketCompletionValidation({
        sessionDir,
        ticketId,
        workingDir: root,
        startCommit,
        statePath,
        iteration: 1,
        log: (m) => logs.push(m),
        flags: {},
      });
    });

    // Characterize: without ACs checked, verdict is skip
    assert.equal(result.action, 'skip',
      `expected action=skip when ACs not checked, got '${result.action}'`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('path-3 manager-drift: decision-matrix evidence_source matches inferred', () => {
  assert.equal(ENTRY.evidence_source, 'inferred',
    `expected evidence_source=inferred for path 3, got '${ENTRY.evidence_source}'`);
});
