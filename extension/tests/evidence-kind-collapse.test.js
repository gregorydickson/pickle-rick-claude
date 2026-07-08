// @tier: fast
//
// B-DURA T70: EvidenceKind collapse to { committed, absent }.
//
// Asserts the net-negative subtraction:
//   - EvidenceKind has exactly 2 variants (committed, absent); no inferred-*.
//   - Pass-2 scanGitLogByFileTouch (R-CECB) still attributes a declared-file commit.
//   - The deprecated hasCompletionCommit shim is gone from pickle-utils.ts.
//   - The dead 'unreachable' variant of CompletionCommitEvidence['source'] is gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readEvidence } from '../services/ticket-completion-evidence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src');

function mkTmp(prefix = 'pickle-ekc-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
}

test('EvidenceKind union is exactly committed | absent (no inferred-* variants)', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'ticket-completion-evidence.ts'), 'utf8');
  const m = src.match(/export type EvidenceKind\s*=\s*([^;]+);/);
  assert.ok(m, 'EvidenceKind type declaration must be present');
  const variants = m[1]
    .split('|')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
    .sort();
  assert.deepEqual(variants, ['absent', 'committed'], `EvidenceKind must be exactly committed|absent, got: ${variants.join(', ')}`);
  assert.ok(!src.includes("'inferred-fresh'"), 'inferred-fresh variant must be gone');
  assert.ok(!src.includes("'inferred-stale'"), 'inferred-stale variant must be gone');
});

test('Pass-2 scanGitLogByFileTouch (R-CECB) still attributes a declared-file commit', () => {
  const root = mkTmp();
  try {
    initGitRepo(root);
    const declared = 'extension/src/services/ekc-feature.ts';
    const abs = path.join(root, declared);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'feature work\n');
    execFileSync('git', ['add', declared], { cwd: root });
    // Subject carries NO ticket-id and NO r_code — only the declared-file-touch
    // (Pass-2) can attribute it.
    execFileSync('git', ['commit', '-q', '-m', 'feat: implement the feature (LOA-9999)', '--no-gpg-sign'],
      { cwd: root, stdio: 'ignore' });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

    const sessionDir = path.join(root, 'session');
    const ticketDir = path.join(sessionDir, 'fac12345');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(path.join(ticketDir, 'rick_ticket_fac12345.md'), [
      '---', 'id: fac12345', 'title: "feature"', 'status: "Done"', '---',
      '# Body', '## Files to modify', `- \`${declared}\``,
    ].join('\n'));

    const ev = readEvidence({ sessionDir, ticketId: 'fac12345', workingDir: root, greenGate: () => 'passing' });
    assert.equal(ev.kind, 'committed', 'declared-file-touch must attribute as committed');
    assert.equal(ev.sha, sha);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hasCompletionCommit shim is deleted from pickle-utils.ts', () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'pickle-utils.ts'), 'utf8');
  assert.ok(
    !/export function hasCompletionCommit\b/.test(src),
    'the deprecated hasCompletionCommit shim must be deleted (B-DURA T70)',
  );
});

test("dead 'unreachable' variant of CompletionCommitEvidence['source'] is deleted", () => {
  const src = fs.readFileSync(path.join(SRC, 'services', 'pickle-utils.ts'), 'utf8');
  const m = src.match(/source:\s*('explicit-reachable'[^;]*);/);
  assert.ok(m, "CompletionCommitEvidence['source'] union must be present");
  assert.ok(!m[1].includes('unreachable'), "the dead 'unreachable' source variant must be deleted");
});
