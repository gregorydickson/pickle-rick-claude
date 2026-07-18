// @tier: fast
/**
 * AC-SAFP-4 (ticket 724a0f33): the refinement symbol audit must FAIL OPEN.
 * Findings are appended to the existing `ticket_quality_warnings` manifest
 * channel (statement move + append, mirroring the over-collapse precedent at
 * spawn-refinement-team.ts:2379) instead of terminating the process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/spawn-refinement-team.js');
const SRC_PATH = path.resolve(__dirname, '../src/bin/spawn-refinement-team.ts');

function tmpDir(prefix = 'pickle-symbol-audit-fail-open-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// Synthetic-validator harness matching refinement-manifest.schema.json's
// ticket_quality_warnings item shape (additionalProperties: false).
function validateWarningEntry(entry) {
  const failures = [];
  const required = ['ticket_id', 'defect_class', 'evidence'];
  for (const k of required) {
    if (typeof entry[k] !== 'string' || entry[k].length === 0) {
      failures.push(`${k} must be non-empty string`);
    }
  }
  if (entry.source !== undefined && !['analyst', 'post-decomp'].includes(entry.source)) {
    failures.push(`source must be 'analyst' or 'post-decomp'`);
  }
  if (entry.file_line !== undefined && entry.file_line !== null && typeof entry.file_line !== 'string') {
    failures.push(`file_line must be string or null`);
  }
  const allowed = new Set(['ticket_id', 'defect_class', 'evidence', 'source', 'file_line']);
  for (const k of Object.keys(entry)) {
    if (!allowed.has(k)) failures.push(`unexpected property: ${k}`);
  }
  return failures;
}

function phantomEventPrd() {
  return '# Bundle PRD\n\nActivity events: `phantom_event_never_registered`.\n';
}

function writeFakeClaude(fakeBin) {
  fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const idx = process.argv.indexOf('-p');
const prompt = idx === -1 ? '' : process.argv[idx + 1];
const match = /Write ALL findings to this file: (.+)/.exec(prompt);
if (match) {
  fs.writeFileSync(match[1], '## ac_shape_smells\\n\\n\`\`\`json\\n{ "ac_shape_smells": [], "tickets": [] }\\n\`\`\`\\n');
}
process.stdout.write('<promise>ANALYSIS_DONE</promise>\\n');
process.exit(0);
`);
  fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
}

test('AC-SAFP-4: :2401 termination line is gone from source', () => {
  const src = fs.readFileSync(SRC_PATH, 'utf-8');
  assert.ok(!src.includes('symbolAuditStatus !== 0'), 'the single symbol-audit process.exit must be deleted');
});

test('AC-SAFP-4: refinement with symbol-audit findings does not terminate at 0 tickets and reaches the next gate', () => {
  const tmp = tmpDir();
  const fakeBin = tmpDir('pickle-symbol-fail-open-fake-bin-');
  try {
    const prd = path.join(tmp, 'prd.md');
    fs.writeFileSync(prd, phantomEventPrd());
    writeFakeClaude(fakeBin);

    const result = spawnSync(
      process.execPath,
      [BIN, '--prd', prd, '--session-dir', tmp, '--cycles', '1', '--max-turns', '15', '--timeout', '5'],
      {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
        encoding: 'utf-8',
        timeout: 45000,
      }
    );

    assert.equal(result.status, 0, `expected fail-open success, got: ${(result.stdout || '') + (result.stderr || '')}`);
    assert.match(result.stdout || '', /MANIFEST=/, 'run must reach the end (past runAcShapeEnforcement and beyond)');

    // Symbol audit still reports (stderr) even though it does not terminate.
    assert.match(result.stderr || '', /symbol audit failed/);

    const auditPath = path.join(tmp, 'refinement', 'symbol_audit.md');
    assert.ok(fs.existsSync(auditPath), 'symbol_audit.md should still be written');
    assert.match(fs.readFileSync(auditPath, 'utf-8'), /Status: FAIL/);

    const manifestPath = path.join(tmp, 'refinement_manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'refinement_manifest.json should be written exactly once');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    assert.ok(Array.isArray(manifest.ticket_quality_warnings), 'ticket_quality_warnings must be populated');
    const symbolWarnings = manifest.ticket_quality_warnings.filter((w) => w.defect_class === 'symbol_audit_finding');
    assert.ok(symbolWarnings.length > 0, 'a symbol_audit_finding warning must be appended');

    for (const warning of symbolWarnings) {
      const failures = validateWarningEntry(warning);
      assert.deepEqual(failures, [], `warning must be schema-legal: ${JSON.stringify(warning)}`);
      assert.equal(warning.ticket_id, '<prd>', 'ticket_id must be the sentinel, never empty string');
      assert.equal(warning.source, 'post-decomp');
      assert.match(warning.evidence, /phantom_event_never_registered/);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});
