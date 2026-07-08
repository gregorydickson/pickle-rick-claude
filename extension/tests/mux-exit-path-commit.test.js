// @tier: integration
// AC-R-MWIS-3 — the worker-exit / idle-stall recovery path commits a gate-passing
// uncommitted deliverable via the existing #99 R-WCUC commit path
// (commitAndContinueDoneFlip), so a clean-tree relaunch cannot strand completed work.
//
// Unit coverage of the wiring helper `commitGatePassingDeliverableOnExitPath`. The #99
// armed gate (`runBetweenTicketFastTests`, which shells out to `npm run test:fast`) is
// injected via the `runGate` test seam so the behavioral branches are deterministic and
// fast — the production default IS the real #99 gate. The temp-git fixture mirrors the
// pattern in tests/characterization/completion-commit-cluster/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commitGatePassingDeliverableOnExitPath } from '../bin/mux-runner.js';

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mwis3-exit-commit-')));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  // extension/ subdir must exist — the helper gates on `path.join(workingDir,'extension')`.
  fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension', 'README.md'), 'fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function writeTicket(sessionDir, ticketId, status) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const fm = ['---', `id: "${ticketId}"`, `status: "${status}"`, 'order: 1', '---', '# Body'].join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), fm);
}

function porcelain(dir) {
  return execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
}

function makeDirtyDeliverable(workingDir) {
  // Uncommitted gate-passing deliverable left in the tree by a silent worker exit.
  fs.writeFileSync(path.join(workingDir, 'extension', 'deliverable.txt'), 'shipped work\n');
}

// Real runtime keeps sessionDir (data root, holds ticket files) distinct from
// workingDir (the git repo). Mirror that so writing the ticket file does not dirty
// the repo under test.
function makeFixture() {
  const sessionDir = makeTmp();
  const workingDir = makeTmp();
  initGitRepo(workingDir);
  return { sessionDir, workingDir };
}

function baseInput(sessionDir, workingDir, ticketId, runGate) {
  return {
    sessionDir,
    statePath: path.join(sessionDir, 'state.json'),
    workingDir,
    ticketId,
    extensionRoot: path.join(workingDir, 'extension'),
    flags: null,
    log: () => {},
    runGate,
  };
}

const TICKET = 'aabbccdd';
const cleanup = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

test('AC-R-MWIS-3 Case A: gate-passing dirty deliverable is COMMITTED (work not stranded)', () => {
  const { sessionDir, workingDir } = makeFixture();
  try {
    writeTicket(sessionDir, TICKET, 'In Progress');
    makeDirtyDeliverable(workingDir);
    assert.notEqual(porcelain(workingDir), '', 'precondition: tree is dirty');

    const result = commitGatePassingDeliverableOnExitPath(
      baseInput(sessionDir, workingDir, TICKET, () => ({ ok: true, failures: [], timed_out: false, timeout_ms: 0 })),
    );

    assert.equal(result.committed, true, `expected committed, got reason=${result.reason}`);
    assert.equal(result.reason, 'committed');
    assert.equal(porcelain(workingDir), '', 'tree must be clean after commit (work not stranded)');
    // The reused #99 committer references the ticket id in the commit subject.
    const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: workingDir, encoding: 'utf8' });
    assert.match(subject, new RegExp(TICKET), 'commit subject must reference the ticket id');
  } finally {
    cleanup(sessionDir, workingDir);
  }
});

test('AC-R-MWIS-3 Case B: gate-FAILING dirty work is NOT committed (preserved for failure path)', () => {
  const { sessionDir, workingDir } = makeFixture();
  try {
    writeTicket(sessionDir, TICKET, 'In Progress');
    makeDirtyDeliverable(workingDir);

    const result = commitGatePassingDeliverableOnExitPath(
      baseInput(sessionDir, workingDir, TICKET, () => ({ ok: false, failures: [], timed_out: false, timeout_ms: 0 })),
    );

    assert.equal(result.committed, false);
    assert.equal(result.reason, 'gate-failed');
    assert.notEqual(porcelain(workingDir), '', 'gate-failing work must remain uncommitted (preserved)');
  } finally {
    cleanup(sessionDir, workingDir);
  }
});

test('AC-R-MWIS-3 Case C: clean tree is a no-op (nothing to strand)', () => {
  const { sessionDir, workingDir } = makeFixture();
  try {
    writeTicket(sessionDir, TICKET, 'In Progress');
    let gateCalled = false;

    const result = commitGatePassingDeliverableOnExitPath(
      baseInput(sessionDir, workingDir, TICKET, () => { gateCalled = true; return { ok: true, failures: [], timed_out: false, timeout_ms: 0 }; }),
    );

    assert.equal(result.committed, false);
    assert.equal(result.reason, 'clean-tree');
    assert.equal(gateCalled, false, 'gate must not run when the tree is clean');
  } finally {
    cleanup(sessionDir, workingDir);
  }
});

test('AC-R-MWIS-3 Case D: already-terminal ticket is a no-op (model Done flip owns it)', () => {
  const { sessionDir, workingDir } = makeFixture();
  try {
    writeTicket(sessionDir, TICKET, 'Done');
    makeDirtyDeliverable(workingDir);

    const result = commitGatePassingDeliverableOnExitPath(
      baseInput(sessionDir, workingDir, TICKET, () => ({ ok: true, failures: [], timed_out: false, timeout_ms: 0 })),
    );

    assert.equal(result.committed, false);
    assert.equal(result.reason, 'already-terminal');
    assert.notEqual(porcelain(workingDir), '', 'no commit when ticket already terminal');
  } finally {
    cleanup(sessionDir, workingDir);
  }
});

test('AC-R-MWIS-3: no ticket → no-op', () => {
  const { sessionDir, workingDir } = makeFixture();
  try {
    const result = commitGatePassingDeliverableOnExitPath(
      baseInput(sessionDir, workingDir, null, () => ({ ok: true, failures: [], timed_out: false, timeout_ms: 0 })),
    );
    assert.equal(result.committed, false);
    assert.equal(result.reason, 'no-ticket');
  } finally {
    cleanup(sessionDir, workingDir);
  }
});
