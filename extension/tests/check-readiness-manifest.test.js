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

function runC3(prdLines, ticketBody) {
  const root = tmpDir();
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const prd = path.join(root, 'bundle.md');
  fs.writeFileSync(prd, prdLines.join('\n'));
  const ticketDir = path.join(sessionDir, 'c3tick01');
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, 'rick_ticket_c3tick01.md'), ['---', 'id: c3tick01', 'key: C3-1', '---', '', '# Ticket', '', ticketBody].join('\n'));
  fs.writeFileSync(path.join(sessionDir, 'decomposition_manifest.json'), JSON.stringify({ prd_path: prd, tickets: [{ id: 'c3tick01', key: 'C3-1' }] }));
  const result = spawnSync(process.execPath, [BIN, '--session-dir', sessionDir, '--repo-root', root], { encoding: 'utf-8', timeout: 10000 });
  fs.rmSync(root, { recursive: true, force: true });
  return { result, out: JSON.parse(result.stdout) };
}

const C3_PRD = [
  '# Bundle', '', '## Requirements', '', '- AC-1: something nobody owns', '- AC-2: owned requirement', '',
  '## NOT in Scope', '', '- AC-DR-1: deferred thing', '- AC-DR-2: deferred but named by a ticket',
];

test('C3-1: unowned and NOT-in-scope-only ids are advisory and exit 0', () => {
  const { result, out } = runC3(C3_PRD, 'AC-2 and AC-DR-2 are covered here.');
  assert.equal(result.status, 0, result.stderr);
  const details = out.findings.map((f) => f.detail);
  assert.ok(details.includes('AC-DR-1: not-in-scope-only'), details.join(','));
  assert.ok(details.includes('AC-1: unmapped'), details.join(','));
  assert.ok(!details.some((d) => d.startsWith('AC-2:') || d.startsWith('AC-DR-2:')), 'owned ids are silent');
  assert.ok(out.findings.filter((f) => /: (unmapped|not-in-scope-only)$/.test(f.detail)).every((f) => f.kind === 'advisory' && f.ticket === 'manifest' && f.analyst === 'gaps'));
});

test('C3-2: an in-scope AC-DR id owned by nothing stays a blocking prd_map finding, not an advisory', () => {
  const { result, out } = runC3(['# Bundle', '', '## Requirements', '', '- AC-DR-9: unowned'], 'nothing relevant');
  assert.equal(result.status, 2);
  assert.ok(out.findings.some((f) => f.kind === 'prd_map' && f.detail === 'AC-DR-9'));
  assert.ok(!out.findings.some((f) => /^AC-DR-9: /.test(f.detail)), 'prd_map only');
});
