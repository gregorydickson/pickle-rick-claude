// @tier: fast
// R-RCFF (ticket 96443088): the readiness contract/symbol resolver consults the
// bundle creation index. A net-new dotted Output field-path whose owning schema
// file is in the ticket's `## Files to modify` is forward-created → advisory, NOT
// a blocking `contract` finding (exit 0). A dotted ref absent everywhere (not in
// the creation set, unresolvable at HEAD) STILL blocks (exit 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');
const REPO_ROOT = path.resolve(__dirname, '..');

function tmpDir(prefix = 'pickle-rcff-fixture-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, body) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), body);
}

function runReadiness(sessionDir) {
  return spawnSync(process.execPath, [
    BIN,
    '--session-dir', sessionDir,
    '--repo-root', REPO_ROOT,
    '--contract-only',
  ], { encoding: 'utf-8', timeout: 15000 });
}

test('R-RCFF positive: net-new dotted Output field-path is advisory, not blocking (exit 0)', () => {
  const sessionDir = tmpDir();
  try {
    // `PickleForwardFieldFixture.netNewField` does NOT resolve at HEAD. Its owning
    // schema file (a REAL file at HEAD, so it is not itself a phantom file_path —
    // out-of-scope per ticket f5a935dd) is declared in `## Files to modify`, so
    // Step 2 seeds the dotted token into the creation index → Step 3 → advisory.
    writeTicket(sessionDir, 'rcffpos1', [
      '---',
      'id: rcffpos1',
      'key: RCFF-POS',
      'ac_ids: []',
      '---',
      '',
      '# RCFF positive — forward-created Output field',
      '',
      '## Interface Contracts',
      '',
      '**Outputs**: a new field `PickleForwardFieldFixture.netNewField` on the schema.',
      '',
      '## Files to modify',
      '',
      '- `extension/src/types/index.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] Command writes a JSON file whose field `kind` equals exactly `bundle`.',
      '',
    ].join('\n'));
    const result = runReadiness(sessionDir);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    // The forward-created ref must NOT be a blocking finding. (Advisory findings
    // may surface in the JSON `findings` array; none may be kind:'contract'.)
    const blocking = (out.findings ?? []).filter((f) => f.kind === 'contract' || f.kind === 'file_path');
    assert.deepEqual(blocking, [], `no blocking contract/file_path finding expected; got ${JSON.stringify(out.findings)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-RCFF negative: a dotted ref absent everywhere STILL blocks (exit 2)', () => {
  const sessionDir = tmpDir();
  // The phantom BASE symbol must not appear as a literal token in ANY tracked
  // source file — INCLUDING this test. The R-RTRC-3 resolver scans tracked test
  // files, so a hardcoded phantom name would resolve to its own fixture string
  // here and the "genuinely unresolvable" negative case would silently pass for
  // the wrong reason. Assemble the base from fragments so the contiguous
  // identifier exists only in the generated ticket on disk (never in this file).
  const phantomBase = ['Pickle', 'Unresolvable', 'Phantom', 'Sym'].join('');
  const phantomRef = `${phantomBase}.absentField`;
  try {
    // No `## Files to modify` section → nothing seeds the creation index, and the
    // dotted token does not resolve at HEAD → genuinely-unresolvable → blocks.
    writeTicket(sessionDir, 'rcffneg1', [
      '---',
      'id: rcffneg1',
      'key: RCFF-NEG',
      'ac_ids: []',
      '---',
      '',
      '# RCFF negative — genuinely unresolvable contract',
      '',
      '## Interface Contracts',
      '',
      `**Outputs**: depends on \`${phantomRef}\` which exists nowhere.`,
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] Command exits with status code exactly `0`.',
      '',
    ].join('\n'));
    const result = runReadiness(sessionDir);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}; stderr=${result.stderr}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'fail');
    const blocking = (out.findings ?? []).filter(
      (f) => f.kind === 'contract' && f.detail === phantomRef,
    );
    assert.equal(blocking.length, 1, `expected a blocking contract finding for the phantom ref; got ${JSON.stringify(out.findings)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});
