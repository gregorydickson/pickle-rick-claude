// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { simulateBinaryAbsent } from './helpers/simulate-binary-absent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');

test('audit-trap-door-enforcement exits 0 at HEAD', () => {
  const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test('audit-trap-door-enforcement fails when R-CNAR-7 PATTERN_SHAPE is blanked in fixture CLAUDE.md', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-trap-door-'));

  try {
    const sourcePath = path.join(EXTENSION_ROOT, 'CLAUDE.md');
    const fixturePath = path.join(tmpDir, 'CLAUDE.md');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const fixture = source.replace(
      /(R-CNAR-1 part 2 cap split\)[\s\S]*?)PATTERN_SHAPE:\s*[\s\S]*?(?=\sBREAKS:)/,
      '$1PATTERN_SHAPE: '
    );

    assert.notEqual(fixture, source, 'fixture must remove the PATTERN_SHAPE clause body');
    fs.writeFileSync(fixturePath, fixture);

    const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PATH_OVERRIDE: fixturePath,
      },
    });

    assert.notEqual(result.status, 0, 'audit should fail when PATTERN_SHAPE is blank');
    assert.match(result.stderr, /PATTERN_SHAPE/, `stderr: ${result.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// AC-M4 / B-CIGREEN ROOT A: an unrunnable check (missing `rg`, or any absent tool)
// must FAIL, never print OK. beta.21 CI proved the opposite — `rg: command not
// found` on stderr, yet the audit exited 0. Simulate the exact CI condition (rg
// absent from PATH, everything else present) and assert the audit now fails
// closed with an explicit unrunnable reason instead of silently no-oping.
test('audit-trap-door-enforcement fails closed when rg is absent from PATH (never reports OK)', () => {
  const filteredPath = simulateBinaryAbsent(process.env.PATH || '', 'rg');

  // Only `rg` may go missing. The predecessor simulation deleted the whole directory that resolved
  // it, which on Linux is /usr/bin (with /bin symlinked to it) — so `bash` itself became
  // unresolvable, the audit was never spawned, and every assertion below graded a failed spawn
  // rather than the audit's verdict. Assert the survivors FIRST so that regression reports
  // "bash no longer resolves" instead of passing the rg precondition for the wrong reason.
  for (const bin of ['bash', 'env', 'git']) {
    const probe = spawnSync('bash', ['-c', `command -v ${bin}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: filteredPath },
      timeout: 30_000,
    });
    assert.equal(
      probe.status,
      0,
      `${bin} must still resolve under the simulated-absent PATH (got exit ${probe.status}); ` +
        'without it the audit never runs and this test measures nothing',
    );
  }

  const which = spawnSync('bash', ['-c', 'command -v rg'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: filteredPath },
    timeout: 30_000,
  });
  assert.notEqual(which.status, 0, 'precondition: rg must be unresolvable under the filtered PATH');

  const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: filteredPath },
    timeout: 60_000,
  });

  assert.notEqual(result.status, 0, `audit must FAIL when rg is unrunnable, got exit ${result.status}; stderr: ${result.stderr}`);
  assert.match(
    result.stderr,
    /tool not installed: rg/,
    `stderr must name the unrunnable reason, got: ${result.stderr}`
  );
  assert.doesNotMatch(
    result.stderr,
    /command not found/,
    `a raw shell "command not found" leak means the check no-oped instead of failing closed: ${result.stderr}`
  );
});
