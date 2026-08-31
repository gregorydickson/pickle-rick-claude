// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findBannedConstructs,
  auditBannedConstructs,
} from '../../services/citadel/banned-constructs-audit.js';
import * as bannedConstructsAudit from '../../services/citadel/banned-constructs-audit.js';
import { buildCitadelAuditReport } from '../../services/citadel/audit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PRDS_DIR = path.resolve(REPO_ROOT, 'prds');

describe('banned-constructs: fabricated arms stay deleted (R-BCFR regression pin)', () => {
  test('isBraceFreeIf is not exported — the fabricated brace-free-if rule was deleted, not reworked', () => {
    assert.equal(bannedConstructsAudit.isBraceFreeIf, undefined);
  });
  test('isNever is not exported — this arm never existed in the shipped audit and must stay absent', () => {
    assert.equal(bannedConstructsAudit.isNever, undefined);
  });
  test('isNestedTernary is not exported — the fabricated nested-ternary rule was deleted, its CLAUDE.md citation never existed', () => {
    assert.equal(bannedConstructsAudit.isNestedTernary, undefined);
  });
  test('the module survives: banned-casts-audit.ts shared imports are still exported functions, distinguishing "arm deleted" from "module gutted"', () => {
    assert.equal(typeof bannedConstructsAudit.collectChangedCodeLines, 'function');
    assert.equal(typeof bannedConstructsAudit.isCommentLine, 'function');
    assert.equal(typeof bannedConstructsAudit.stripStringLiterals, 'function');
  });
  test('the brace-free-if finding id is never emitted, even for the shape that used to trigger it', () => {
    const findings = findBannedConstructs([{
      file: 'src/x.ts',
      lines: [{ no: 11, text: 'if (ready) launch();' }],
    }]);
    assert.deepEqual(findings, []);
  });
  test('the nested-ternary finding id is never emitted, even for the shape that used to trigger it', () => {
    const findings = findBannedConstructs([{
      file: 'src/x.ts',
      lines: [{ no: 10, text: 'const z = a ? b ? c : d : e;' }],
    }]);
    assert.deepEqual(findings, []);
  });
});

describe('banned-constructs: findBannedConstructs', () => {
  test('emits no findings for any input — no construct arm remains', () => {
    const findings = findBannedConstructs([{
      file: 'src/x.ts',
      lines: [
        { no: 10, text: 'const z = a ? b ? c : d : e;' },
        { no: 11, text: 'if (ready) launch();' },
        { no: 12, text: 'const ok = a ? b : c;' },
        { no: 13, text: '// if (x) return;  comment line is ignored' },
      ],
    }]);
    assert.deepEqual(findings, []);
  });

  test('end-to-end wired read via auditBannedConstructs on a temp file emits no findings', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-'));
    try {
      fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'src/x.ts'), 'export const z = a ? b ? c : d : e;\n');
      const result = auditBannedConstructs({
        range: 'BASE..HEAD', base: 'BASE', head: 'HEAD', repoRoot,
        changedFiles: [{ path: 'src/x.ts', status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] }],
        claudeFiles: [],
      });
      assert.deepEqual(result.findings, []);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('banned-constructs: clean tree', () => {
  test('emits ZERO findings on the current pickle-rick-claude tree (HEAD..HEAD)', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(prdFiles.length > 0, 'need at least one PRD file');
    const report = buildCitadelAuditReport({
      prdPath: path.join('prds', prdFiles[0]),
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });
    const section = report.sections.banned_constructs;
    assert.ok(section, 'banned_constructs section must exist');
    assert.deepEqual(section.findings, []);
    const leaked = report.findings.filter((f) => f.source_section === 'banned_constructs');
    assert.deepEqual(leaked, []);
  });
});
