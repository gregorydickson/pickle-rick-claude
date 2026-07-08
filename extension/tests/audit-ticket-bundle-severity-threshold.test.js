// @tier: fast

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
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createWorkingRepo() {
  const root = tmpDir('pickle-audit-threshold-repo-');
  runGit(root, ['init']);
  runGit(root, ['config', 'user.email', 'test@example.com']);
  runGit(root, ['config', 'user.name', 'Test User']);
  writeFile(path.join(root, 'extension', 'package.json'), JSON.stringify({ version: '1.74.0' }, null, 2) + '\n');
  return root;
}

function createSessionRoot(workingDir) {
  const sessionDir = tmpDir('pickle-audit-threshold-session-');
  fs.writeFileSync(
    path.join(sessionDir, 'state.json'),
    JSON.stringify({ working_dir: workingDir, start_commit: null }, null, 2) + '\n',
  );
  return sessionDir;
}

function writeTicket(sessionDir, ticketId, body, frontmatterExtras = '') {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const raw = `---\nid: ${ticketId}\ntitle: Threshold fixture ${ticketId}\nstatus: In Progress\n${frontmatterExtras}---\n${body}`;
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), raw);
}

function runCli(sessionDir) {
  return spawnSync('node', [BUNDLE, sessionDir], { encoding: 'utf8' });
}

test('cross-doc-naming-drift at info does not force exit_code 1, while self-reference warning still does', () => {
  const workingDir = createWorkingRepo();
  const driftSession = createSessionRoot(workingDir);
  const selfRefSession = createSessionRoot(workingDir);
  try {
    writeFile(path.join(workingDir, 'extension', 'src', 'services', 'my-service.ts'), 'export const value = 1;\n');
    writeFile(
      path.join(workingDir, 'docs', 'superpowers', 'specs', 'historical.md'),
      'Historical doc cites `src/services/my-service.ts`.\n',
    );
    runGit(workingDir, ['add', '.']);
    runGit(workingDir, ['commit', '-m', 'fixture']);

    writeTicket(
      driftSession,
      'a1b2c3d4',
      '\n## Problem\nTicket cites `extension/src/services/my-service.ts`.\n\n## Conformance Check\n- none\n',
    );
    writeTicket(
      selfRefSession,
      'deadbeef',
      '\n## Problem\nThis ticket mentions `deadbeef`.\n\n## Conformance Check\n- none\n',
    );

    const driftManifest = auditSession(driftSession, SCRIPT_DIR);
    const driftFinding = driftManifest.findings.find((f) => f.defect_class === 'cross-doc-naming-drift');
    assert.ok(driftFinding, `Expected cross-doc-naming-drift finding, got ${JSON.stringify(driftManifest.findings)}`);
    assert.equal(driftFinding.severity, 'info');
    assert.equal(driftManifest.exit_code, 0, `Expected info-only drift bundle to exit 0, got ${driftManifest.exit_code}`);

    const driftCli = runCli(driftSession);
    assert.equal(driftCli.status, 0, `Expected CLI exit 0 for info-only drift, got ${driftCli.status}: ${driftCli.stderr}`);

    const selfRefManifest = auditSession(selfRefSession, SCRIPT_DIR);
    const selfRefFinding = selfRefManifest.findings.find((f) => f.defect_class === 'self-reference');
    assert.ok(selfRefFinding, `Expected self-reference finding, got ${JSON.stringify(selfRefManifest.findings)}`);
    assert.equal(selfRefFinding.severity, 'warning');
    assert.equal(selfRefManifest.exit_code, 1, `Expected warning bundle to exit 1, got ${selfRefManifest.exit_code}`);

    const selfRefCli = runCli(selfRefSession);
    assert.equal(selfRefCli.status, 1, `Expected CLI exit 1 for self-reference warning, got ${selfRefCli.status}`);
  } finally {
    fs.rmSync(driftSession, { recursive: true, force: true });
    fs.rmSync(selfRefSession, { recursive: true, force: true });
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
});
