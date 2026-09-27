// @tier: integration
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnGateRemediatorMain } from '../../bin/spawn-gate-remediator.js';
import { runRemediatorForIteration } from '../../bin/microverse-runner.js';

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sgr-concurrent-')));
}

function makeGateResult(overrides = {}) {
  return {
    status: 'red',
    failures: [
      { check: 'lint', file: 'src/bar.ts', line: 5, ruleOrCode: 'no-unnecessary-type-assertion', message: 'assertion is unnecessary', severity: 'error', occurrence_index: 0 },
    ],
    baseline_used: false,
    allowed_paths_used: false,
    elapsed_ms: 200,
    total_raw_failure_count: 1,
    new_failures_vs_baseline: 1,
    ...overrides,
  };
}

describe('concurrent-gate-remediation', () => {
  // ---------------------------------------------------------------------------
  // Second concurrent invocation writes lockout file and exits 0
  // ---------------------------------------------------------------------------

  test('second call while lockfile held writes lockout file + exits 0', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult()), 'utf-8');

    const sessionRoot = path.join(tmpDir, 'session');
    fs.mkdirSync(path.join(sessionRoot, 'gate'), { recursive: true });

    const lockfilePath = path.join(sessionRoot, 'gate', 'remediator.lockfile');
    const iso = '2026-04-27T13-42-01Z';

    // Simulate a concurrent holder: write the lockfile ourselves
    fs.writeFileSync(lockfilePath, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf-8');

    const stdoutLines = [];
    const stderrLines = [];
    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
      isoOverride: iso,
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stdout: (m) => stdoutLines.push(m),
      stderr: (m) => stderrLines.push(m),
    });

    // Second invocation exits 0 (clean exit, not error)
    assert.equal(code, 0, `Expected exit 0, got ${code}. stderr: ${stderrLines.join('\n')}`);

    // Lockout file written
    const gateDir = path.join(sessionRoot, 'gate');
    const gateFiles = fs.readdirSync(gateDir);
    const lockoutFiles = gateFiles.filter(f => f.startsWith('remediator_concurrent_lockout_'));
    assert.ok(lockoutFiles.length >= 1, `Expected at least one lockout file, found: ${JSON.stringify(gateFiles)}`);

    // LOCKOUT_PATH echoed to stdout
    assert.ok(stdoutLines.some(l => l.startsWith('LOCKOUT_PATH=')), `Expected LOCKOUT_PATH on stdout, got: ${JSON.stringify(stdoutLines)}`);

    // Brief NOT written (we were locked out)
    const briefFiles = gateFiles.filter(f => f.startsWith('remediation_') && f.endsWith('_brief.md'));
    assert.equal(briefFiles.length, 0, `Brief must not be written when locked out, found: ${JSON.stringify(briefFiles)}`);

    // Lockout file content is meaningful
    const lockoutContent = fs.readFileSync(path.join(gateDir, lockoutFiles[0]), 'utf-8');
    assert.ok(lockoutContent.includes('concurrent'), 'Lockout file must mention concurrent');
    assert.ok(lockoutContent.includes(sessionRoot) || lockoutContent.includes('lockfile'), 'Lockout file must reference lockfile path');

    // Cleanup: remove our fake lockfile
    fs.unlinkSync(lockfilePath);
    fs.rmSync(tmpDir, { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // First invocation succeeds when no lockfile exists
  // ---------------------------------------------------------------------------

  test('first call with no existing lockfile succeeds and releases lock', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult()), 'utf-8');
    const sessionRoot = path.join(tmpDir, 'session');
    const iso = '2026-04-27T14-00-00Z';

    const code = await spawnGateRemediatorMain({
      argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'per-iteration'],
      isoOverride: iso,
      extensionClaudeMdContent: '## Trap Doors\nNone.',
      stdout: () => {},
      stderr: () => {},
    });

    assert.equal(code, 0);

    const gateDir = path.join(sessionRoot, 'gate');
    const lockfilePath = path.join(gateDir, 'remediator.lockfile');
    const briefPath = path.join(gateDir, `remediation_${iso}_brief.md`);

    // Lockfile cleaned up
    assert.ok(!fs.existsSync(lockfilePath), 'Lockfile must be released after successful run');

    // Brief written
    assert.ok(fs.existsSync(briefPath), 'Brief must be written on success');

    fs.rmSync(tmpDir, { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // Sequential runs — second run after first completes succeeds (no leftover lock)
  // ---------------------------------------------------------------------------

  test('sequential runs both succeed — no stale lockfile between them', async () => {
    const tmpDir = makeTmpDir();
    const grPath = path.join(tmpDir, 'gate-result.json');
    fs.writeFileSync(grPath, JSON.stringify(makeGateResult()), 'utf-8');
    const sessionRoot = path.join(tmpDir, 'session');

    for (const [i, iso] of [['0', '2026-04-27T10-00-00Z'], ['1', '2026-04-27T10-01-00Z']]) {
      void i;
      const code = await spawnGateRemediatorMain({
        argv: ['--gate-result', grPath, '--session-root', sessionRoot, '--reason', 'strict'],
        isoOverride: iso,
        extensionClaudeMdContent: '## Trap Doors\nNone.',
        stdout: () => {},
        stderr: () => {},
      });
      assert.equal(code, 0, `Run ${iso} should succeed`);
    }

    const gateDir = path.join(sessionRoot, 'gate');
    const briefFiles = fs.readdirSync(gateDir).filter(f => f.endsWith('_brief.md'));
    assert.equal(briefFiles.length, 2, 'Both sequential runs must produce a brief');

    fs.rmSync(tmpDir, { recursive: true });
  });

  // ---------------------------------------------------------------------------
  // result.json verdict — the runner's reader, not a write/read of the test's own JSON
  // ---------------------------------------------------------------------------

  test('runRemediatorForIteration reads result.json: aborted or failures_out>0 is not success', async () => {
    const cases = [
      [{ aborted: false, failures_out: 0 }, true],
      [{ aborted: true, failures_out: 0 }, false],
      [{ aborted: false, failures_out: 3 }, false],
    ];
    for (const [written, expected] of cases) {
      const tmpDir = makeTmpDir();
      const sessionDir = path.join(tmpDir, 'session');
      const workingDir = path.join(tmpDir, 'work');
      const binDir = path.join(tmpDir, 'bin');
      const gateDir = path.join(sessionDir, 'gate');
      fs.mkdirSync(workingDir, { recursive: true });
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        path.join(binDir, 'claude'),
        [
          '#!/usr/bin/env node',
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          `const gateDir = ${JSON.stringify(gateDir)};`,
          'fs.mkdirSync(gateDir, { recursive: true });',
          `fs.writeFileSync(path.join(gateDir, \`remediation_\${Date.now()}_result.json\`), ${JSON.stringify(JSON.stringify(written))}, 'utf-8');`,
          'process.exit(0);',
        ].join('\n'),
        { mode: 0o755 },
      );
      const oldPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ''}`;
      try {
        const result = await runRemediatorForIteration(makeGateResult(), sessionDir, workingDir, 'claude', 60, {
          logActivityFn: () => {},
        });
        assert.ok(
          fs.readdirSync(gateDir).some((f) => f.endsWith('_result.json')),
          'stub remediator must have run and written its result file',
        );
        assert.deepEqual(result, { success: expected }, `result ${JSON.stringify(written)}`);
      } finally {
        process.env.PATH = oldPath;
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });
});
