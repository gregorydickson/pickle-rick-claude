// @tier: integration
// SERIAL: subprocess-heavy — the audit script streams `git show` over every
// extension/src file at the base ref; cheap but git-bound, so isolate it.
// WS-5 (lightweight): the subtract-before-add net-delta audit is ADVISORY — it
// prints a one-line trend summary and ALWAYS exits 0. It never gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/audit-subtract-before-add.sh');
const REPO_ROOT = path.resolve(__dirname, '../..');

const SUMMARY_RE =
  /SUBTRACT_BEFORE_ADD net_trapdoors=[+-]\d+ net_flags=[+-]\d+ net_audits=[+-]\d+ \(base=[^;]+; advisory\)/;

test('audit-subtract-before-add: prints the net-delta summary and exits 0 (default base)', () => {
  const result = spawnSync('bash', [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, `advisory audit must exit 0; stderr=${result.stderr}`);
  assert.match(result.stdout, SUMMARY_RE, `expected summary line; got ${result.stdout}`);
});

test('audit-subtract-before-add: explicit --base HEAD exits 0 with signed deltas', () => {
  const result = spawnSync('bash', [SCRIPT, '--base', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, `advisory audit must exit 0; stderr=${result.stderr}`);
  assert.match(result.stdout, /base=HEAD; advisory/);
  assert.match(result.stdout, SUMMARY_RE);
});

test('audit-subtract-before-add: unknown base falls back gracefully and still exits 0', () => {
  const result = spawnSync('bash', [SCRIPT, '--base', 'no-such-ref-xyz-9999'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, `must never block on an unknown base; stderr=${result.stderr}`);
  assert.match(result.stdout, SUMMARY_RE);
});
