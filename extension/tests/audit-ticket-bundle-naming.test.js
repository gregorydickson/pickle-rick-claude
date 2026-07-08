// @tier: fast
/**
 * audit-ticket-bundle-naming.test.js — AC-ATBG-3 + AC-ATBG-5 regression
 *
 * AC-ATBG-5: YAML block-list mapped_requirements parses to same set as inline scalar form.
 * AC-ATBG-3: title-mentions-requirement finding is severity:info (not warning).
 * Real defect preserved: dir != id still produces a fatal cross-doc-naming finding.
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
const SCRIPT_DIR = path.dirname(BUNDLE);

const { auditSession } = await import(BUNDLE);

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function runGit(dir, args) {
  const res = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createWorkingRepo() {
  const root = tmpDir('pickle-atbg-naming-repo-');
  runGit(root, ['init']);
  runGit(root, ['config', 'user.email', 'test@example.com']);
  runGit(root, ['config', 'user.name', 'Test User']);
  writeFile(path.join(root, 'extension', 'package.json'), JSON.stringify({ version: '2.0.0' }, null, 2) + '\n');
  runGit(root, ['add', '.']);
  runGit(root, ['commit', '-m', 'fixture', '--allow-empty-message']);
  return root;
}

function createSessionRoot(workingDir) {
  const sessionDir = tmpDir('pickle-atbg-naming-session-');
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({ working_dir: workingDir, start_commit: null }, null, 2) + '\n',
  );
  return sessionDir;
}

/**
 * Write a ticket to the session dir. The ticket dir name IS the ticketId so dir-vs-id matches.
 */
function writeTicket(sessionDir, ticketId, title, mappedRequirementsFrontmatter) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const raw = [
    '---',
    `id: ${ticketId}`,
    `title: ${title}`,
    'status: In Progress',
    mappedRequirementsFrontmatter,
    '---',
    '',
    '## Conformance Check',
    '',
    '<!-- audit: 7-class checked 2026-06-16 -->',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), raw);
}

/**
 * Write a ticket where the ticket dir hash does NOT match the frontmatter id.
 */
function writeTicketWithDirMismatch(sessionDir, dirHash, frontmatterId) {
  const ticketDir = path.join(sessionDir, dirHash);
  fs.mkdirSync(ticketDir, { recursive: true });
  const raw = [
    '---',
    `id: ${frontmatterId}`,
    `title: Dir mismatch fixture`,
    'status: In Progress',
    '---',
    '',
    '## Conformance Check',
    '',
    '<!-- audit: 7-class checked 2026-06-16 -->',
    '',
  ].join('\n');
  // File must be named after the dir hash so findTicketFiles can discover it;
  // the frontmatter id intentionally differs to trigger the dir-vs-id fatal check.
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${dirHash}.md`), raw);
}

// AC-ATBG-5 + AC-ATBG-3: YAML block-list and inline scalar both yield an info finding
test('AC-ATBG-5: YAML block-list mapped_requirements produces info finding identical to inline scalar form', () => {
  const workingDir = createWorkingRepo();
  const inlineSession = createSessionRoot(workingDir);
  const blockListSession = createSessionRoot(workingDir);
  try {
    // Inline scalar form: mapped_requirements: AC-ATBG-5
    writeTicket(
      inlineSession,
      'aabbccdd',
      'Fix some bug without mentioning AC id',
      'mapped_requirements: AC-ATBG-5',
    );

    // YAML block-list form: same requirement, no title mention
    writeTicket(
      blockListSession,
      'aabbccdd',
      'Fix some bug without mentioning AC id',
      'mapped_requirements:\n  - AC-ATBG-5',
    );

    const inlineManifest = auditSession(inlineSession, SCRIPT_DIR);
    const blockListManifest = auditSession(blockListSession, SCRIPT_DIR);

    // Both should find a cross-doc-naming finding for the title mismatch
    const inlineFinding = inlineManifest.findings.find(
      (f) => f.defect_class === 'cross-doc-naming' && f.evidence.includes('AC-ATBG-5'),
    );
    const blockFinding = blockListManifest.findings.find(
      (f) => f.defect_class === 'cross-doc-naming' && f.evidence.includes('AC-ATBG-5'),
    );

    assert.ok(
      inlineFinding,
      `Expected inline scalar to produce a cross-doc-naming finding; got: ${JSON.stringify(inlineManifest.findings)}`,
    );
    assert.ok(
      blockFinding,
      `Expected YAML block-list to produce a cross-doc-naming finding; got: ${JSON.stringify(blockListManifest.findings)}`,
    );

    // AC-ATBG-3: both findings must be severity:info, not warning
    assert.equal(inlineFinding.severity, 'info', `inline scalar finding severity must be 'info', got '${inlineFinding.severity}'`);
    assert.equal(blockFinding.severity, 'info', `block-list finding severity must be 'info', got '${blockFinding.severity}'`);

    // Both should produce the same exit code (0, since info is not gate-blocking)
    assert.equal(inlineManifest.exit_code, 0, `Inline scalar session should exit 0 (info only), got ${inlineManifest.exit_code}`);
    assert.equal(blockListManifest.exit_code, 0, `Block-list session should exit 0 (info only), got ${blockListManifest.exit_code}`);
  } finally {
    fs.rmSync(inlineSession, { recursive: true, force: true });
    fs.rmSync(blockListSession, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

// AC-ATBG-3: a title that mentions its mapped requirement produces NO cross-doc-naming finding
test('AC-ATBG-3: title that includes mapped requirement ID produces no cross-doc-naming finding', () => {
  const workingDir = createWorkingRepo();
  const sessionDir = createSessionRoot(workingDir);
  try {
    writeTicket(
      sessionDir,
      'aabbccdd',
      'Fix AC-ATBG-5 parser bug', // title mentions the requirement
      'mapped_requirements: AC-ATBG-5',
    );
    const manifest = auditSession(sessionDir, SCRIPT_DIR);
    const namingFinding = manifest.findings.find(
      (f) => f.defect_class === 'cross-doc-naming' && f.evidence.includes('mentions none'),
    );
    assert.equal(
      namingFinding,
      undefined,
      `Expected no title-mismatch finding when title includes requirement; got: ${JSON.stringify(namingFinding)}`,
    );
    assert.equal(manifest.exit_code, 0, `Expected exit 0, got ${manifest.exit_code}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});

// Real defect preserved: dir != id still produces a fatal finding
test('dir-vs-id mismatch still produces a fatal cross-doc-naming finding', () => {
  const workingDir = createWorkingRepo();
  const sessionDir = createSessionRoot(workingDir);
  try {
    // Dir is 'aabbccdd' but frontmatter id is '11223344'
    writeTicketWithDirMismatch(sessionDir, 'aabbccdd', '11223344');

    const manifest = auditSession(sessionDir, SCRIPT_DIR);
    const fatalFinding = manifest.findings.find(
      (f) => f.defect_class === 'cross-doc-naming' && f.severity === 'fatal',
    );
    assert.ok(
      fatalFinding,
      `Expected fatal cross-doc-naming finding for dir/id mismatch; got: ${JSON.stringify(manifest.findings)}`,
    );
    assert.ok(
      fatalFinding.evidence.includes('11223344'),
      `Fatal finding evidence should mention frontmatter id '11223344'; got: ${fatalFinding.evidence}`,
    );
    assert.ok(
      fatalFinding.evidence.includes('aabbccdd'),
      `Fatal finding evidence should mention dir 'aabbccdd'; got: ${fatalFinding.evidence}`,
    );
    assert.equal(manifest.exit_code, 1, `Expected exit 1 for fatal finding, got ${manifest.exit_code}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});
