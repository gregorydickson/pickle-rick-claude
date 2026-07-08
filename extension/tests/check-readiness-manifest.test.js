// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');

function tmpDir(prefix = 'pickle-readiness-manifest-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  const ticketPath = path.join(ticketDir, `rick_ticket_${id}.md`);
  fs.writeFileSync(ticketPath, [
    '---',
    `id: ${id}`,
    'key: MAN-1',
    'dependencies: [MISSING-DEP]',
    '---',
    '',
    '# Ticket',
    '',
    '## Acceptance Criteria',
    '- [ ] AC-SRC-01 passes after implementation.',
  ].join('\n'));
  return ticketPath;
}

test('check-readiness: manifest PRD map walks peer_prds.deferred source PRDs', () => {
  const root = tmpDir();
  try {
    const sessionDir = path.join(root, 'session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const parentPrd = path.join(root, 'bundle.md');
    const sourcePrd = path.join(root, 'source.md');
    fs.writeFileSync(parentPrd, [
      '---',
      'peer_prds:',
      '  deferred:',
      '    - source.md',
      '---',
      '# Bundle',
    ].join('\n'));
    fs.writeFileSync(sourcePrd, [
      '# Source PRD',
      '',
      '## Source Section',
      '',
      '| ID | Check |',
      '|---|---|',
      '| AC-SRC-01 | Source requirement |',
    ].join('\n'));
    writeTicket(sessionDir, 'manifest01');
    fs.writeFileSync(path.join(sessionDir, 'decomposition_manifest.json'), JSON.stringify({
      prd_path: parentPrd,
      tickets: [{ id: 'manifest01', key: 'MAN-1' }],
    }, null, 2));

    const result = spawnSync(process.execPath, [
      BIN,
      '--session-dir', sessionDir,
      '--repo-root', root,
    ], {
      encoding: 'utf-8',
      timeout: 10000,
    });

    assert.equal(result.status, 2, result.stderr);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'fail');
    assert.ok(!out.findings.some((finding) => finding.kind === 'prd_map'), 'source requirement should be mapped');
    const report = fs.readFileSync(out.report, 'utf-8');
    assert.match(report, /\| manifest01 \| MAN-1 \| source\.md \| Source Section \| AC-SRC-01 \|/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
