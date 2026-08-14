// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scriptPath = path.resolve(__dirname, '../scripts/census-worker-gate-red-tests.js');

const { runCensus, formatReportMarkdown } = await import(scriptPath);

function writeTicket(dataRoot, session, ticketId, frontmatterLines) {
  const ticketDir = path.join(dataRoot, 'sessions', session, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const content = ['---', `id: ${ticketId}`, ...frontmatterLines, '---', '# Description', ''].join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), content);
}

describe('census-worker-gate-red-tests', () => {
  test('red under green is included', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
    try {
      writeTicket(tmp, 'sess-a', 'tkt-red', [
        'worker_gate_verdict: "green"',
        'worker_gate_tests_verdict: "red"',
        'completion_commit: deadbeef',
      ]);
      const result = runCensus(tmp);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].ticket_id, 'tkt-red');
      assert.equal(result.rows[0].worker_gate_tests_verdict, 'red');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('not_run under green is NOT counted as red', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
    try {
      writeTicket(tmp, 'sess-a', 'tkt-notrun', [
        'worker_gate_verdict: "green"',
        'worker_gate_tests_verdict: "not_run"',
      ]);
      const result = runCensus(tmp);
      assert.equal(result.rows.length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('green under green is excluded', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
    try {
      writeTicket(tmp, 'sess-a', 'tkt-green', [
        'worker_gate_verdict: "green"',
        'worker_gate_tests_verdict: "green"',
      ]);
      const result = runCensus(tmp);
      assert.equal(result.rows.length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('absent tests-verdict field is excluded', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
    try {
      writeTicket(tmp, 'sess-a', 'tkt-absent', ['worker_gate_verdict: "green"']);
      const result = runCensus(tmp);
      assert.equal(result.rows.length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('missing working_dir is stated unmeasurable, not dropped', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
    try {
      writeTicket(tmp, 'sess-a', 'tkt-nowd', [
        'worker_gate_verdict: "green"',
        'worker_gate_tests_verdict: "red"',
        'completion_commit: deadbeef',
      ]);
      const result = runCensus(tmp);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].branch_reachable, 'unmeasurable');
      assert.equal(result.unmeasurable_count, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('missing completion_commit is stated unmeasurable, not dropped', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
    try {
      writeTicket(tmp, 'sess-a', 'tkt-nosha', ['worker_gate_verdict: "green"', 'worker_gate_tests_verdict: "red"']);
      const result = runCensus(tmp);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].completion_commit, null);
      assert.equal(result.rows[0].branch_reachable, 'unmeasurable');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reachable commit in a real repo resolves branch_reachable: reachable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
    try {
      const repoDir = path.join(tmp, 'repo');
      fs.mkdirSync(repoDir, { recursive: true });
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir, timeout: 5000 });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, timeout: 5000 });
      spawnSync('git', ['config', 'user.name', 'test'], { cwd: repoDir, timeout: 5000 });
      fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi');
      spawnSync('git', ['add', 'a.txt'], { cwd: repoDir, timeout: 5000 });
      spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir, timeout: 5000 });
      const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, timeout: 5000, encoding: 'utf-8' })
        .stdout.trim();

      writeTicket(tmp, 'sess-a', 'tkt-reachable', [
        'worker_gate_verdict: "green"',
        'worker_gate_tests_verdict: "red"',
        `completion_commit: ${sha}`,
        `working_dir: ${repoDir}`,
      ]);
      const result = runCensus(tmp);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].branch_reachable, 'reachable');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('unreachable commit (dangling, no branch) resolves branch_reachable: unreachable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
    try {
      const repoDir = path.join(tmp, 'repo');
      fs.mkdirSync(repoDir, { recursive: true });
      spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir, timeout: 5000 });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, timeout: 5000 });
      spawnSync('git', ['config', 'user.name', 'test'], { cwd: repoDir, timeout: 5000 });
      fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hi');
      spawnSync('git', ['add', 'a.txt'], { cwd: repoDir, timeout: 5000 });
      spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir, timeout: 5000 });
      fs.writeFileSync(path.join(repoDir, 'b.txt'), 'bye');
      spawnSync('git', ['add', 'b.txt'], { cwd: repoDir, timeout: 5000 });
      spawnSync('git', ['commit', '-q', '-m', 'orphan'], { cwd: repoDir, timeout: 5000 });
      const danglingSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, timeout: 5000, encoding: 'utf-8' })
        .stdout.trim();
      spawnSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: repoDir, timeout: 5000 });

      writeTicket(tmp, 'sess-a', 'tkt-unreachable', [
        'worker_gate_verdict: "green"',
        'worker_gate_tests_verdict: "red"',
        `completion_commit: ${danglingSha}`,
        `working_dir: ${repoDir}`,
      ]);
      const result = runCensus(tmp);
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].branch_reachable, 'unreachable');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('CLI --data-root and --out write a report file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
    try {
      writeTicket(tmp, 'sess-a', 'tkt-cli', [
        'worker_gate_verdict: "green"',
        'worker_gate_tests_verdict: "red"',
        'completion_commit: deadbeef',
      ]);
      const outPath = path.join(tmp, 'report.md');
      const result = spawnSync(process.execPath, [scriptPath, '--data-root', tmp, '--out', outPath], {
        encoding: 'utf-8',
        timeout: 10000,
      });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const report = fs.readFileSync(outPath, 'utf-8');
      assert.match(report, /tkt-cli/);
      assert.match(report, /does NOT by itself prove the commit is bad/);
      assert.match(report, /pruned\/deleted session state/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('formatReportMarkdown includes AC-D2 overclaim caveat', () => {
    const result = { rows: [], scanned_session_count: 0, unmeasurable_count: 0 };
    const report = formatReportMarkdown(result);
    assert.match(report, /does NOT by itself prove the commit is bad/);
  });
});
