// @tier: fast
// R-TFP-C2 extension: missing-timeout predicate over the whole child_process
// family (exec/execSync/execFile/execFileSync/spawn/spawnSync/fork), scanned
// via `--scan-root`. The fixture lives under `fs.mkdtemp` — NEVER under
// `extension/tests/` — so this test cannot itself trip AC-4 (the baseline is
// keyed to the committed `extension/tests` corpus and would never grandfather
// a tmp-dir path anyway).
//
// Fixture source is assembled from split tokens (`FN + '('`) rather than a
// literal `execFileSync(`/`spawnSync(` substring so THIS file — which lives
// in the real extension/tests/ corpus — never itself reads as a missing-
// timeout candidate to the very audit it is testing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/audit-subprocess-heavy-tests.sh');

function tmpScanRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'missing-timeout-scan-root-'));
}

function runAudit(scanRoot) {
  return spawnSync('bash', [SCRIPT, '--scan-root', scanRoot], {
    encoding: 'utf-8',
    timeout: 15000,
  });
}

function fixtureSource(fn, callArgs, withTimeout) {
  const opts = withTimeout
    ? "{ cwd, encoding: 'utf-8', timeout: 15000 }"
    : "{ cwd, encoding: 'utf-8' }";
  return [
    '// @tier: fast',
    `import { ${fn} } from 'node:child_process';`,
    'export function run(cwd) {',
    `  return ${fn}(${callArgs}, ${opts});`,
    '}',
    '',
  ].join('\n');
}

test('audit-subprocess-heavy-tests --scan-root: missing-timeout callsite fails, adding timeout fixes it (AC-5)', () => {
  const dir = tmpScanRoot();
  try {
    const fixturePath = path.join(dir, 'missing-timeout.test.js');
    fs.writeFileSync(fixturePath, fixtureSource('execFileSync', "'git', ['status']", false));

    const before = runAudit(dir);
    assert.equal(
      before.status,
      1,
      `expected exit 1 for missing-timeout callsite; stderr=${before.stderr}`,
    );
    assert.match(before.stderr, /new missing-timeout execFileSync\(\.\.\.\) callsite not in baseline/);

    fs.writeFileSync(fixturePath, fixtureSource('execFileSync', "'git', ['status']", true));

    const after = runAudit(dir);
    assert.equal(
      after.status,
      0,
      `expected exit 0 once timeout is added; stderr=${after.stderr}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit-subprocess-heavy-tests --scan-root: spawnSync without timeout is also caught (child_process family coverage)', () => {
  const dir = tmpScanRoot();
  try {
    const fixturePath = path.join(dir, 'missing-timeout-spawn.test.js');
    fs.writeFileSync(fixturePath, fixtureSource('spawnSync', "'node', ['-v']", false));

    const result = runAudit(dir);
    assert.equal(
      result.status,
      1,
      `expected exit 1 for missing-timeout spawnSync callsite; stderr=${result.stderr}`,
    );
    assert.match(result.stderr, /new missing-timeout spawnSync\(\.\.\.\) callsite not in baseline/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit-subprocess-heavy-tests --scan-root: clean scan root (no candidates) exits 0', () => {
  const dir = tmpScanRoot();
  try {
    fs.writeFileSync(
      path.join(dir, 'clean.test.js'),
      fixtureSource('execFileSync', "'git', ['status']", true),
    );

    const result = runAudit(dir);
    assert.equal(result.status, 0, `expected exit 0 for a clean scan root; stderr=${result.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
