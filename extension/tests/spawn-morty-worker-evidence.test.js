// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateWorkerOutcome } from '../bin/spawn-morty.js';

// No seed commit — an empty (commit-less) repo makes checkGitEdits() deterministically false
// (no HEAD to diff or log), avoiding any race against the wall-clock startTime cutoff.
function makeTmpGitRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'morty@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Morty'], { cwd: dir });
  return dir;
}

function makeTicketDir(prefix, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x');
  return dir;
}

function makeCtx({ timedOut, ticketPath, sessionWorkingDir }) {
  return {
    args: { isReviewTicket: false },
    prompt: '',
    ticketPath,
    ticketId: 'test-ticket',
    sessionRoot: '/tmp/does-not-matter',
    sessionLog: null,
    sessionLogPath: '/tmp/does-not-matter.log',
    sessionWorkingDir,
    timeoutStatePath: null,
    workerStatePath: '/tmp/does-not-matter-state.json',
    effectiveTimeoutMs: 60000,
    mutableState: { finalized: false, timedOut },
    preWorkerHead: null,
  };
}

const CHATTY_LOG = `worker did a lot of stuff\n${'x'.repeat(250)}\n`;
const SHORT_LOG = 'too short';

const CASES = [
  {
    name: 'row1: no token, full artifacts, chatty log, no edits needed — success (token-less worker)',
    timedOut: false,
    ticketFiles: ['research_x.md', 'plan_x.md', 'conformance_x.md', 'code_review_x.md'],
    log: CHATTY_LOG,
    commitAfterStart: false,
    expected: true,
  },
  {
    name: 'row2: no lifecycle artifact — failure',
    timedOut: false,
    ticketFiles: [],
    log: CHATTY_LOG,
    commitAfterStart: false,
    expected: false,
  },
  {
    name: 'row3: timed out — failure regardless of everything else',
    timedOut: true,
    ticketFiles: ['research_x.md', 'plan_x.md', 'conformance_x.md', 'code_review_x.md'],
    log: CHATTY_LOG,
    commitAfterStart: true,
    expected: false,
  },
  {
    name: 'row4: log <200B and no git edits — failure',
    timedOut: false,
    ticketFiles: ['research_x.md', 'plan_x.md', 'conformance_x.md', 'code_review_x.md'],
    log: SHORT_LOG,
    commitAfterStart: false,
    expected: false,
  },
  {
    name: 'row5 (CHARACTERIZATION): research-only implementation artifact + chatty log, no edits — success',
    timedOut: false,
    ticketFiles: ['research_x.md'],
    log: CHATTY_LOG,
    commitAfterStart: false,
    expected: true,
  },
];

test('evaluateWorkerOutcome — ground-truth predicate (no narrative-token conjunct)', () => {
  for (const c of CASES) {
    const sessionWorkingDir = makeTmpGitRepo('pickle-worker-evidence-repo-');
    const ticketPath = makeTicketDir('pickle-worker-evidence-ticket-', c.ticketFiles);
    const startTime = Date.now() - 10_000;

    if (c.commitAfterStart) {
      fs.writeFileSync(path.join(sessionWorkingDir, 'work.txt'), 'worker output\n');
      execFileSync('git', ['add', '.'], { cwd: sessionWorkingDir });
      execFileSync('git', ['commit', '-q', '-m', 'worker commit'], { cwd: sessionWorkingDir });
    }

    const ctx = makeCtx({ timedOut: c.timedOut, ticketPath, sessionWorkingDir });
    const { isSuccess } = evaluateWorkerOutcome({ ctx, logContent: c.log, startTime });

    assert.equal(isSuccess, c.expected, c.name);

    fs.rmSync(sessionWorkingDir, { recursive: true, force: true });
    fs.rmSync(ticketPath, { recursive: true, force: true });
  }
});

test('evaluateWorkerOutcome — artifact-less failure reasons exclude the WORKER_DONE token reason', () => {
  const sessionWorkingDir = makeTmpGitRepo('pickle-worker-evidence-reasons-repo-');
  const ticketPath = makeTicketDir('pickle-worker-evidence-reasons-ticket-', []);
  const ctx = makeCtx({ timedOut: false, ticketPath, sessionWorkingDir });
  const startTime = Date.now();

  const originalError = console.error;
  let captured = '';
  console.error = (msg) => { captured += String(msg); };
  try {
    evaluateWorkerOutcome({ ctx, logContent: CHATTY_LOG, startTime });
  } finally {
    console.error = originalError;
  }

  assert.doesNotMatch(captured, /no WORKER_DONE token/);
  assert.match(captured, /no implementation lifecycle artifact/);

  fs.rmSync(sessionWorkingDir, { recursive: true, force: true });
  fs.rmSync(ticketPath, { recursive: true, force: true });
});
