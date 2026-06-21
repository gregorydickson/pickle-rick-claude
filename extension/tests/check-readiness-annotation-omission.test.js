// @tier: fast
// R-RCFF #2 (ticket f5a935dd): a file path that appears in ANY bundle ticket's
// "Files to create" set is forward-created — it must NOT produce a blocking `file_path`
// finding (readiness) / fatal `path-drift` (audit) EVEN WHEN the *referencing* ticket
// omitted the `(forward-created)` annotation. Annotation is an OPTIONAL hint, not a
// requirement; the bundle creation index is the load-bearing suppressor.
//
// Teeth: a path absent from BOTH the creation set AND HEAD still blocks.
// Gate parity: readiness (`check-readiness.ts`) and `audit-ticket-bundle.ts` MUST apply
// the SAME forward-created creation set so a ref that passes readiness cannot die at
// ticket-audit as path-drift.
//
// Fixture shape mirrors the real incident 9ab25dfa (`mashvisor*/node.spec.ts`).
// Asserts against the COMPILED mirror (bin/*.js), matching the sibling readiness tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.resolve(here, '..');
const repoRoot = path.resolve(extRoot, '..');
const readinessBin = path.join(extRoot, 'bin', 'check-readiness.js');
const cr = await import(path.join(extRoot, 'bin', 'check-readiness.js'));
const atb = await import(path.join(extRoot, 'bin', 'audit-ticket-bundle.js'));
const fra = await import(path.join(extRoot, 'services', 'forward-ref-annotation.js'));

const SPEC = 'extension/tests/mashvisor-node-rcff2.spec.ts';
const BOGUS = 'extension/tests/genuinely-bogus-typo-rcff2-xyz.spec.ts';

// Sibling ticket CREATES the spec via "## Files to create"; carries NO annotation.
const SIBLING = ['# Sibling that creates the spec', '', '## Files to create', '', `- \`${SPEC}\``, ''].join('\n');
// Referencing ticket cites the spec UN-annotated.
const REFERENCING = ['# Referencing ticket', '', `Add coverage in \`${SPEC}\` (no annotation).`, ''].join('\n');

function tmpSession(prefix = 'rcff2-omission-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
function writeTicket(sessionDir, id, body) {
  const dir = path.join(sessionDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `linear_ticket_${id}.md`), `---\nid: ${id}\n---\n\n${body}`);
}
function runReadiness(sessionDir) {
  return spawnSync(process.execPath, [readinessBin, '--session-dir', sessionDir, '--repo-root', repoRoot, '--contract-only'], {
    encoding: 'utf-8',
    timeout: 20000,
  });
}
function auditTicket(id, body) {
  return { id, relPath: `x/${id}.md`, body };
}
function pathDriftOf(findings) {
  return findings.filter((f) => f.defect_class === 'path-drift');
}

test('R-RCFF #2 AC-2 (readiness e2e): un-annotated forward-created create-set path yields NO blocking file_path finding, while a genuine phantom still blocks', () => {
  const sessionDir = tmpSession();
  try {
    writeTicket(sessionDir, 'sib00001', SIBLING);
    writeTicket(
      sessionDir,
      'ref00002',
      ['# Referencing ticket', '', '## Acceptance Criteria', '', `- [ ] \`${SPEC}\` exists.`, `- [ ] \`${BOGUS}\` exists.`, ''].join('\n'),
    );
    const result = runReadiness(sessionDir);
    const out = JSON.parse(result.stdout);
    const filePathFindings = out.findings.filter((f) => f.kind === 'file_path');
    const specFindings = filePathFindings.filter((f) => f.detail && f.detail.includes('mashvisor-node-rcff2'));
    assert.deepStrictEqual(specFindings, [], `un-annotated create-set spec must not block; got ${JSON.stringify(specFindings)}`);
    const bogusFindings = filePathFindings.filter((f) => f.detail && f.detail.includes('genuinely-bogus-typo-rcff2'));
    assert.ok(bogusFindings.length > 0, `genuinely-bogus path must still block; findings=${JSON.stringify(out.findings)}`);
    assert.equal(result.status, 2, `expected exit 2 (the phantom blocks); stdout=${result.stdout}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-RCFF #2 AC-2 (readiness predicate): bundle creation index contains the un-annotated create-set path', () => {
  const idx = cr.buildBundleCreationIndex([SIBLING, REFERENCING]);
  assert.ok(idx.has(SPEC), 'bundle creation index must contain the sibling-declared create-section spec');
  assert.equal(fra.isForwardCreated(SPEC, idx), true, 'un-annotated forward-created path must satisfy the readiness predicate');
});

test('R-RCFF #2 audit parity: same un-annotated path passes checkPathDrift with the bundle index — no path-drift', () => {
  const idx = atb.buildBundleCreationIndex([auditTicket('sib00001', SIBLING), auditTicket('ref00002', REFERENCING)]);
  const findings = atb.checkPathDrift(auditTicket('ref00002', REFERENCING), new Set(), idx);
  assert.deepStrictEqual(pathDriftOf(findings), [], `expected no path-drift for bundle-forward-created path; got ${JSON.stringify(pathDriftOf(findings))}`);
});

test('R-RCFF #2 audit teeth: the SAME reference WITHOUT the bundle index DOES drift (the index is what suppresses)', () => {
  const findings = atb.checkPathDrift(auditTicket('ref00002', REFERENCING), new Set(), new Set());
  assert.equal(pathDriftOf(findings).length, 1, `without the bundle index the un-annotated path must drift; got ${JSON.stringify(pathDriftOf(findings))}`);
});

test('R-RCFF #2 AC-3 NEGATIVE: a path absent from the creation set AND HEAD still blocks (teeth)', () => {
  const referencing = `Reference \`${BOGUS}\` declared in no create section.`;
  const idx = atb.buildBundleCreationIndex([auditTicket('phantom01', referencing)]);
  assert.ok(!idx.has(BOGUS), 'phantom path must NOT be in the creation index');
  assert.equal(fra.isForwardCreated(BOGUS, idx), false, 'a path in no create section must NOT be forward-created');
  const findings = atb.checkPathDrift(auditTicket('phantom01', referencing), new Set(), idx);
  assert.equal(pathDriftOf(findings).length, 1, `the phantom path must still produce a path-drift finding; got ${JSON.stringify(pathDriftOf(findings))}`);
});

test('R-RCFF #2 PARITY: readiness and audit buildBundleCreationIndex produce the SAME forward-created set', () => {
  const crIdx = [...cr.buildBundleCreationIndex([SIBLING, REFERENCING])].sort();
  const atbIdx = [...atb.buildBundleCreationIndex([auditTicket('sib00001', SIBLING), auditTicket('ref00002', REFERENCING)])].sort();
  assert.deepStrictEqual(crIdx, atbIdx, 'check-readiness and audit-ticket-bundle must share the same forward-created creation set (gate parity)');
});
