// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/spawn-refinement-team.js');

const {
  evaluateSymbolAudit,
  writeSymbolAudit,
} = await import('../bin/spawn-refinement-team.js');

function makeTmpDir(prefix = 'pickle-symbol-audit-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function validPrd() {
  return `# Bundle PRD

## Activity Events

Activity events: \`session_start\`, \`iteration_start\`, \`gate_run_complete\`, \`readiness_skipped\`, \`halt\`.

## Pipeline Runner Contracts

Exit codes: \`Success\`, \`Failure\`, \`AuditFailure\`.

## Files Touched

- NEW \`extension/src/services/symbol-one.ts\`
- NEW \`extension/src/services/symbol-two.ts\`
- NEW \`extension/tests/symbol-one.test.js\`
- NEW \`extension/tests/symbol-two.test.js\`

## Decomposition

### T1 - Symbol one service

Files: \`extension/src/services/symbol-one.ts\`, \`extension/tests/symbol-one.test.js\`

### T2 - Symbol two service

Files: \`extension/src/services/symbol-two.ts\`, \`extension/tests/symbol-two.test.js\`

## Helpers And Sentinels

Helpers: \`knownHelper\`, \`KNOWN_SENTINEL\`.
`;
}

function seedSource(repoDir) {
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'symbols.ts'), [
    'export function knownHelper() { return true; }',
    'export const KNOWN_SENTINEL = "ready";',
  ].join('\n'));
}

test('symbol audit passes grounded activity events, NEW files, and helpers', () => {
  const repo = makeTmpDir();
  try {
    seedSource(repo);
    const report = evaluateSymbolAudit(validPrd(), repo, { tickets: [] });

    assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
    assert.equal(report.activityEvents.length, 5);
    assert.equal(report.newFiles.length, 4);
    assert.equal(report.helperSentinels.length, 2);
    assert.deepEqual(report.findings, []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('symbol audit writes symbol_audit.md in the refinement directory', async () => {
  const repo = makeTmpDir();
  const refinementDir = makeTmpDir('pickle-symbol-refinement-');
  try {
    seedSource(repo);
    const report = await writeSymbolAudit(refinementDir, validPrd(), repo, { tickets: [] });
    const auditPath = path.join(refinementDir, 'symbol_audit.md');

    assert.equal(report.ok, true);
    assert.ok(fs.existsSync(auditPath), 'symbol_audit.md should exist');
    const audit = fs.readFileSync(auditPath, 'utf-8');
    assert.match(audit, /Status: PASS/);
    assert.match(audit, /knownHelper/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(refinementDir, { recursive: true, force: true });
  }
});

test('symbol audit fails a phantom activity event with the named field', () => {
  const repo = makeTmpDir();
  try {
    seedSource(repo);
    const prd = validPrd().replace('`session_start`', '`phantom_event`');
    const report = evaluateSymbolAudit(prd, repo, { tickets: [] });

    assert.equal(report.ok, false);
    assert.ok(report.findings.some((finding) =>
      finding.category === 'activity_event' &&
      finding.symbol === 'phantom_event' &&
      finding.reason.includes('VALID_ACTIVITY_EVENTS')
    ), JSON.stringify(report.findings, null, 2));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('spawn-refinement-team emits symbol_audit.md during a refinement run', () => {
  const tmp = makeTmpDir();
  const fakeBin = makeTmpDir('pickle-symbol-fake-bin-');
  try {
    const prd = path.join(tmp, 'prd.md');
    fs.writeFileSync(prd, '# PRD\nNo operator-facing symbol references.\n');
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

    const result = spawnSync(
      process.execPath,
      [BIN, '--prd', prd, '--session-dir', tmp, '--cycles', '1', '--max-turns', '15', '--timeout', '5'],
      {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
        encoding: 'utf-8',
        timeout: 45000,
      }
    );

    assert.equal(result.status, 0, `expected success, got: ${(result.stdout || '') + (result.stderr || '')}`);
    const auditPath = path.join(tmp, 'refinement', 'symbol_audit.md');
    assert.ok(fs.existsSync(auditPath), 'refinement run should emit symbol_audit.md');
    assert.match(fs.readFileSync(auditPath, 'utf-8'), /Status: PASS/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});
