// @tier: integration
// WS-A (2e77f26e): one predicate, both Done-flip authorities read
// worker_gate_tests_verdict through the single exported reader
// (readTicketWorkerGateTestsVerdict, setup.ts). guardCompletionCommitBeforeDone
// (mux-runner.ts) now consults it and records the fact on its return value
// without changing its `ok` disposition — a red test verdict never refuses a
// Done flip (root CLAUDE.md no-stopping-gates rule).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { guardCompletionCommitBeforeDone } from '../bin/mux-runner.js';
import { readTicketWorkerGateTestsVerdict } from '../bin/setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wgtv-guard-')));
}

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function initRepo(repoDir) {
  git(repoDir, ['init']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
}

function commitFile(repoDir, name, body, msg) {
  fs.writeFileSync(path.join(repoDir, name), body);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', msg]);
  return git(repoDir, ['rev-parse', 'HEAD']);
}

function writeTicket(sessionDir, ticketId, sha, testsVerdict) {
  const dir = path.join(sessionDir, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = ['---', `id: ${ticketId}`, 'status: In Progress', `completion_commit: ${sha}`];
  if (testsVerdict !== undefined && testsVerdict !== null) {
    lines.push(`worker_gate_tests_verdict: ${testsVerdict}`);
  }
  lines.push('---', '');
  fs.writeFileSync(path.join(dir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
}

function writeState(sessionDir, startCommit) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ schema_version: 5, start_commit: startCommit, pinned_sha: null }));
}

// The guard early-returns ok:true when PICKLE_TEST_MODE === '1' (sandbox bypass).
// These tests must exercise the REAL evidence path, so the var must be unset.
function withoutTestMode(fn) {
  const prev = process.env.PICKLE_TEST_MODE;
  delete process.env.PICKLE_TEST_MODE;
  try { return fn(); } finally { if (prev !== undefined) process.env.PICKLE_TEST_MODE = prev; }
}

// AC-A1: exactly one bespoke `worker_gate_tests_verdict` frontmatter-field
// literal comparison in the whole src tree — inside readTicketWorkerGateTestsVerdict
// itself (setup.ts). mux-runner.ts must never re-implement the comparison.
test('AC-A1: worker_gate_tests_verdict has exactly one literal-comparison reader', () => {
  const setupSrc = fs.readFileSync(path.join(__dirname, '../src/bin/setup.ts'), 'utf-8');
  const muxSrc = fs.readFileSync(path.join(__dirname, '../src/bin/mux-runner.ts'), 'utf-8');

  const literalComparisonSites = (setupSrc.match(/readFrontmatterField\([^)]*'worker_gate_tests_verdict'/g) ?? []).length;
  assert.equal(literalComparisonSites, 1, 'setup.ts must have exactly one raw frontmatter-field read for worker_gate_tests_verdict (inside the reader)');

  const muxBespokeComparisons = (muxSrc.match(/worker_gate_tests_verdict/g) ?? []).length;
  assert.equal(muxBespokeComparisons, 0, 'mux-runner.ts must consult the field only via the imported reader, never a bespoke literal');

  assert.match(muxSrc, /import\s*\{\s*readTicketWorkerGateTestsVerdict\s*\}\s*from\s*'\.\/setup\.js'/, 'mux-runner.ts must import the shared reader from setup.js');
});

for (const CASE of [
  { name: 'red', verdict: 'red' },
  { name: 'not_run', verdict: 'not_run' },
  { name: 'green', verdict: 'green' },
]) {
  // AC-A2 (red case is the load-bearing one — this exists to prove the fix
  // is not a stopping gate): every verdict value still lets the Done flip proceed.
  test(`AC-A2/A3: worker_gate_tests_verdict='${CASE.name}' does not block the flip and is recorded on the result`, () => {
    withoutTestMode(() => {
      const root = makeTmp();
      const sessionDir = path.join(root, 'session');
      fs.mkdirSync(sessionDir, { recursive: true });
      initRepo(root);
      const baseline = commitFile(root, 'init.txt', 'init', 'baseline');
      const real = commitFile(root, 'work.txt', 'real work', 'feat: real ticket work');

      writeTicket(sessionDir, 'abc12345', real, CASE.verdict);
      writeState(sessionDir, baseline);

      const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
      assert.equal(guard.ok, true, `a '${CASE.name}' test verdict must never refuse the Done flip`);
      assert.equal(guard.sha, real);
      assert.equal(guard.testsVerdict, CASE.verdict, 'the guard result must carry the test-dimension fact');
    });
  });
}

test('AC-A3: an absent worker_gate_tests_verdict field records testsVerdict: null on the result', () => {
  withoutTestMode(() => {
    const root = makeTmp();
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    initRepo(root);
    const baseline = commitFile(root, 'init.txt', 'init', 'baseline');
    const real = commitFile(root, 'work.txt', 'real work', 'feat: real ticket work');

    writeTicket(sessionDir, 'abc12345', real, null);
    writeState(sessionDir, baseline);

    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, true);
    assert.equal(guard.testsVerdict, null);
  });
});

// AC-A3 on the ok:false branch too — the fact is carried regardless of disposition.
test('AC-A3: a refused flip (no attributable commit) still carries the test-dimension fact', () => {
  withoutTestMode(() => {
    const root = makeTmp();
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    initRepo(root);
    const baseline = commitFile(root, 'init.txt', 'init', 'baseline');

    // Baseline-equal completion_commit collapses evidence to 'absent' (R-CXOR-2).
    writeTicket(sessionDir, 'abc12345', baseline, 'red');
    writeState(sessionDir, baseline);

    const guard = guardCompletionCommitBeforeDone({ sessionDir, ticketId: 'abc12345', workingDir: root, rereadBackoffMs: 0 });
    assert.equal(guard.ok, false);
    assert.equal(guard.testsVerdict, 'red', 'testsVerdict is present on the ok:false branch too');
  });
});

test('readTicketWorkerGateTestsVerdict: not_run is never conflated with red', () => {
  const root = makeTmp();
  const sessionDir = path.join(root, 'session');
  writeTicket(sessionDir, 'nid00001', 'deadbeef', 'not_run');
  assert.equal(readTicketWorkerGateTestsVerdict(sessionDir, 'nid00001'), 'not_run');
  assert.notEqual(readTicketWorkerGateTestsVerdict(sessionDir, 'nid00001'), 'red');
});
