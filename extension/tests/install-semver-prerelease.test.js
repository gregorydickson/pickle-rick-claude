// @tier: fast
// R-ISVP: install.sh's compare_semver must understand prerelease tags (2.0.0-beta.N)
// and stay in lockstep with the check-update.ts:compareSemver oracle. This file
// extracts the REAL compare_semver body from install.sh (no hand-copied fixture)
// and exercises it directly, plus asserts sign-parity against the compiled oracle.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { compareSemver } from '../bin/check-update.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = path.resolve(__dirname, '..', '..', 'install.sh');

/**
 * Extract the real `compare_semver` function body verbatim from install.sh
 * by scanning brace depth from the `compare_semver() {` marker to its
 * matching closing brace. `${...}` parameter expansions inside the body are
 * individually balanced, so a flat brace-depth counter finds the right
 * boundary without a full bash parser.
 */
function extractCompareSemverSource() {
  const src = readFileSync(INSTALL_SH, 'utf8');
  const marker = 'compare_semver() {';
  const start = src.indexOf(marker);
  if (start === -1) {
    throw new Error('compare_semver() not found in install.sh');
  }
  let depth = 0;
  let pos = start;
  for (; pos < src.length; pos++) {
    const ch = src[pos];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        pos++;
        break;
      }
    }
  }
  return src.slice(start, pos);
}

const runnerDir = mkdtempSync(path.join(tmpdir(), 'install-semver-prerelease-'));
const runnerScriptPath = path.join(runnerDir, 'run-compare-semver.sh');
writeFileSync(
  runnerScriptPath,
  `#!/bin/bash
set -euo pipefail
${extractCompareSemverSource()}
if cmp="$(compare_semver "$1" "$2")"; then
  echo "$cmp"
  exit 0
else
  exit 1
fi
`,
  { mode: 0o755 },
);

after(() => {
  rmSync(runnerDir, { recursive: true, force: true });
});

function runCompareSemver(a, b) {
  const result = spawnSync('bash', [runnerScriptPath, a, b], { encoding: 'utf8', timeout: 30000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('install.sh compare_semver — prerelease matrix (R-ISVP)', () => {
  test('extracted compare_semver source is balanced and prerelease-aware', () => {
    const extracted = extractCompareSemverSource();
    assert.match(extracted, /^compare_semver\(\) \{[\s\S]*\}$/, 'extraction must be a balanced function body');
    assert.match(extracted, /a_ident/, 'extracted source must be the prerelease-aware implementation');
    assert.match(extracted, /b_ident/, 'extracted source must be the prerelease-aware implementation');
  });

  describe('bare acceptance-criteria matrix', () => {
    const cases = [
      ['2.0.0-beta.31', '2.0.0-beta.30', '1'],
      ['2.0.0-beta.30', '2.0.0-beta.31', '-1'],
      ['2.0.0-beta.31', '2.0.0-beta.31', '0'],
      ['2.0.0', '2.0.0-beta.31', '1'],
      ['2.0.0-beta.31', '2.0.0', '-1'],
      ['2.0.0-rc.1', '2.0.0-beta.31', '1'],
      ['2.0.0-beta.31', '2.0.0-rc.1', '-1'],
    ];
    for (const [a, b, expected] of cases) {
      test(`compare_semver ${a} ${b} => ${expected}`, () => {
        const result = runCompareSemver(a, b);
        assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
        assert.strictEqual(result.stdout.trim(), expected);
      });
    }
  });

  describe('oracle parity vs check-update.ts:compareSemver', () => {
    const pairs = [
      ['2.0.0-beta.31', '2.0.0-beta.30'],
      ['2.0.0-beta.30', '2.0.0-beta.31'],
      ['2.0.0-beta.31', '2.0.0-beta.31'],
      ['2.0.0-rc.1', '2.0.0-beta.31'],
      ['2.0.0-beta.31', '2.0.0-rc.1'],
      ['2.0.0', '2.0.0-beta.31'],
      ['2.0.0-beta.31', '2.0.0'],
      ['2.0.0', '2.0.0'],
      ['1.9.9', '2.0.0-beta.1'],
      ['2.0.0-alpha.5', '2.0.0-alpha.5'],
    ];
    for (const [a, b] of pairs) {
      test(`sign(${a}, ${b}) matches oracle`, () => {
        const result = runCompareSemver(a, b);
        assert.strictEqual(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
        const bashSign = Number(result.stdout.trim());
        const oracleSign = compareSemver(a, b);
        assert.strictEqual(bashSign, oracleSign, `bash=${bashSign} oracle=${oracleSign} for (${a}, ${b})`);
      });
    }
  });

  describe('malformed path (the original bug)', () => {
    test('compare_semver foo 2.0.0 returns non-zero with no integer-parseable stdout', () => {
      const result = runCompareSemver('foo', '2.0.0');
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(result.stdout.trim(), '');
      assert.match(result.stderr, /Invalid semver comparison/);
      assert.doesNotMatch(result.stderr, /integer expression expected/);
    });

    test('compare_semver 2.0.0-beta 2.0.0-beta.1 (numberless prerelease) returns non-zero', () => {
      const result = runCompareSemver('2.0.0-beta', '2.0.0-beta.1');
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(result.stdout.trim(), '');
      assert.match(result.stderr, /Invalid semver comparison/);
      assert.doesNotMatch(result.stderr, /integer expression expected/);
    });
  });
});
