// @tier: fast
/**
 * audit-ticket-bundle-noise.test.js — AC-ATBG-2 regression
 *
 * (a) detectCrossDocNamingDrift must return at most one finding per ticket-path,
 *     regardless of how many doc files reference the same basename.
 * (b) printSummary must always show all fatal/warning findings even when
 *     info findings exceed 50.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(__dirname, '..', 'bin', 'audit-ticket-bundle.js');

const { detectCrossDocNamingDrift } = await import(BUNDLE);

function tmpDir(prefix = 'pickle-atbg2-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function initGitRepo(dir) {
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' });
}

function gitAdd(dir, ...files) {
  spawnSync('git', ['add', ...files], { cwd: dir, encoding: 'utf8' });
}

function gitCommit(dir, msg) {
  spawnSync('git', ['commit', '-m', msg, '--allow-empty-message'], { cwd: dir, encoding: 'utf8' });
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

// ---------------------------------------------------------------------------
// Test 1: detectCrossDocNamingDrift caps to one finding per ticket-path
// ---------------------------------------------------------------------------
test('AC-ATBG-2: detectCrossDocNamingDrift returns at most one entry per ticket-path even with multiple doc files', () => {
  const root = tmpDir('atbg2-dedup-');
  try {
    initGitRepo(root);

    // One ticket path referenced differently in 3 separate .md files
    const ticketPath = 'extension/src/services/my-service.ts';
    const docContent = 'See `src/services/my-service.ts` for details.\n';
    writeFile(path.join(root, 'doc1.md'), docContent);
    writeFile(path.join(root, 'doc2.md'), docContent);
    writeFile(path.join(root, 'doc3.md'), docContent);
    gitAdd(root, 'doc1.md', 'doc2.md', 'doc3.md');
    gitCommit(root, 'add doc files');

    const drifts = detectCrossDocNamingDrift([ticketPath], root);

    // Must be exactly 1 entry — not 3 (one per doc file)
    const ticketEntries = drifts.filter((d) => d.ticketPath === ticketPath);
    assert.equal(
      ticketEntries.length,
      1,
      `Expected exactly 1 drift entry for ticket path, got ${ticketEntries.length}: ${JSON.stringify(ticketEntries)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC-ATBG-2: detectCrossDocNamingDrift with multiple distinct ticket-paths each gets at most one entry', () => {
  const root = tmpDir('atbg2-multi-');
  try {
    initGitRepo(root);

    const ticketPaths = [
      'extension/src/services/alpha.ts',
      'extension/src/services/beta.ts',
    ];
    // Both referenced differently across 5 docs
    const doc = (i) =>
      `See \`src/services/alpha.ts\` and \`src/services/beta.ts\` — doc ${i}.\n`;
    for (let i = 1; i <= 5; i++) {
      writeFile(path.join(root, `doc${i}.md`), doc(i));
      gitAdd(root, `doc${i}.md`);
    }
    gitCommit(root, 'add docs');

    const drifts = detectCrossDocNamingDrift(ticketPaths, root);

    const alphaEntries = drifts.filter((d) => d.ticketPath === ticketPaths[0]);
    const betaEntries = drifts.filter((d) => d.ticketPath === ticketPaths[1]);
    assert.ok(alphaEntries.length <= 1, `alpha: expected <= 1 entry, got ${alphaEntries.length}`);
    assert.ok(betaEntries.length <= 1, `beta: expected <= 1 entry, got ${betaEntries.length}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: printSummary always shows blocking (fatal/warning) findings even
//         when info findings exceed 50
// ---------------------------------------------------------------------------
test('AC-ATBG-2: blocking findings visible in CLI stdout even when info findings exceed 50', () => {
  const workingDir = tmpDir('atbg2-wdir-');
  const sessionDir = tmpDir('atbg2-sess-');
  try {
    // Set up a minimal git repo so drift checks don't explode
    initGitRepo(workingDir);
    writeFile(path.join(workingDir, 'extension', 'package.json'), '{"version":"1.0.0"}\n');
    // Add 51 markdown doc files each referencing the same basename via a drift path
    // so we get >= 51 info (drift) findings for the one ticket path
    for (let i = 1; i <= 51; i++) {
      writeFile(path.join(workingDir, `doc${i}.md`), `See \`src/bin/my-script.ts\` (drift doc ${i}).\n`);
    }
    gitAdd(workingDir, 'extension', ...Array.from({ length: 51 }, (_, i) => `doc${i + 1}.md`));
    gitCommit(workingDir, 'fixture');

    // Session state
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({ working_dir: workingDir, start_commit: null }) + '\n',
    );

    // Ticket that produces:
    //   - 1 self-reference warning (ticket id in problem body)
    //   - cross-doc-naming-drift info finding(s) (one ticket path, 51 docs)
    const ticketId = 'deadbeef';
    const ticketDir = path.join(sessionDir, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });
    const ticketBody = [
      '---',
      `id: ${ticketId}`,
      'title: Noise test fixture',
      'status: In Progress',
      '---',
      '',
      '## Problem',
      // self-reference warning: mentions own ticket id
      `This ticket \`${ticketId}\` has a self-reference.`,
      // drift trigger: deep path that docs reference via shorter form
      'Also see `extension/src/bin/my-script.ts`.',
      '',
      '## Conformance Check',
      '<!-- audit: 7-class checked 2026-06-16 -->',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), ticketBody);

    const result = spawnSync('node', [BUNDLE, sessionDir], { encoding: 'utf8', timeout: 30_000 });
    const stdout = result.stdout;

    // The self-reference warning MUST appear in stdout
    assert.ok(
      stdout.includes('self-reference'),
      `Expected 'self-reference' warning in stdout, but it was absent.\nStdout:\n${stdout}`,
    );

    // Confirm the warning line has severity 'warning'
    const warnLine = stdout.split('\n').find((l) => l.includes('self-reference'));
    assert.ok(warnLine, 'Should find the self-reference line in stdout');
    assert.ok(warnLine.includes('warning'), `Expected 'warning' severity on self-reference line: ${warnLine}`);
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
