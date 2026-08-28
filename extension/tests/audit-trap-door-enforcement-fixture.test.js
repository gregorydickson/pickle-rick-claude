// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');

// Resolves `bin` via `command -v` under the given PATH and removes exactly that
// directory, looping to handle multiple resolvable installs. Deterministic
// regardless of where the tool is installed (mirrors install-bun-probe.test.js's
// simulateBunAbsent, generalized to an arbitrary binary name).
function simulateBinaryAbsent(pathEnv, bin) {
  let currentPath = pathEnv;
  for (let i = 0; i < 10; i++) {
    const which = spawnSync('bash', ['-c', `command -v ${bin}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: currentPath },
      timeout: 30_000,
    });
    if (which.status !== 0 || !which.stdout.trim()) { break; }
    const binDir = path.dirname(which.stdout.trim());
    const next = currentPath
      .split(path.delimiter)
      .filter(p => p !== binDir)
      .join(path.delimiter);
    if (next === currentPath) { break; }
    currentPath = next;
  }
  return currentPath;
}

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
