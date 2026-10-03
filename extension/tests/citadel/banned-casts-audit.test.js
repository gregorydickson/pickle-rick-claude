// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasAsErrorCast,
  hasAsAnyCast,
  hasAsNeverCast,
  findBannedCasts,
  auditBannedCasts,
} from '../../services/citadel/banned-casts-audit.js';
import { buildCitadelAuditReport } from '../../services/citadel/audit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PRDS_DIR = path.resolve(REPO_ROOT, 'prds');

describe('banned-casts: detectors', () => {
  test('fires on (x as Error). access and as any', () => {
    assert.ok(hasAsErrorCast('const m = (err as Error).message;'));
    assert.ok(hasAsErrorCast('return (e.cause as Error).stack;'));
    assert.ok(hasAsAnyCast('const obj = payload as any;'));
    assert.ok(hasAsAnyCast('return { ...state } as any;'));
  });
  test('silent on the CLAUDE.md-prescribed safe forms and strings', () => {
    assert.ok(!hasAsErrorCast('const m = err instanceof Error ? err.message : String(err);'));
    assert.ok(!hasAsAnyCast('const v = raw as unknown as Foo;'));
    assert.ok(!hasAsAnyCast('const company = "Anatomy Park as any place";'));
  });
});

describe('banned-casts: as-never detector (#9)', () => {
  test('hasAsNeverCast fires on a real as never cast', () => {
    assert.ok(hasAsNeverCast('const x = foo as never;'));
    assert.ok(hasAsNeverCast('return value as never;'));
  });
  test('hasAsNeverCast is silent on safe and string-literal forms', () => {
    // The line-level detector strips string literals but is comment-agnostic by
    // design — comment exclusion is findBannedCasts's job (via isCommentLine),
    // mirroring hasAsAnyCast/hasAsErrorCast.
    assert.ok(!hasAsNeverCast('const x = foo as Foo;'));
    assert.ok(!hasAsNeverCast('const label = "treat it as never below";'));
  });
  test('findBannedCasts emits an as-never finding with an enum-valid severity', () => {
    const ENUM = new Set(['Critical', 'High', 'Medium', 'Low']);
    const findings = findBannedCasts([{
      file: 'src/z.ts',
      lines: [
        { no: 11, text: 'const x = foo as never;' },
        { no: 12, text: 'const safe = bar as Foo;' },
        { no: 13, text: '// const c = baz as never; — comment ignored' },
      ],
    }]);
    const hit = findings.find((f) => f.id.startsWith('banned-cast:as-never:'));
    assert.ok(hit, 'as-never finding must be emitted');
    assert.ok(ENUM.has(hit.severity), `severity ${hit.severity} must be an enum value`);
    // Only the real cast on line 11 fires (safe form + comment are silent).
    assert.equal(findings.filter((f) => f.id.startsWith('banned-cast:as-never:')).length, 1);
  });
});

describe('banned-casts: findBannedCasts', () => {
  test('flags both classes on a positive fixture and is silent on clean lines', () => {
    const findings = findBannedCasts([{
      file: 'src/y.ts',
      lines: [
        { no: 5, text: 'const m = (err as Error).message;' },
        { no: 6, text: 'const o = blob as any;' },
        { no: 7, text: 'const msg = err instanceof Error ? err.message : String(err);' },
        { no: 8, text: '// (x as Error).message  — comment ignored' },
      ],
    }]);
    assert.equal(findings.length, 2);
    assert.ok(findings.some((f) => f.id.startsWith('banned-cast:as-error:')));
    assert.ok(findings.some((f) => f.id.startsWith('banned-cast:as-any:')));
    for (const f of findings) assert.equal(f.severity, 'Medium');
  });

  test('end-to-end wired read via auditBannedCasts on a temp file', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bcast-'));
    try {
      fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, 'eslint.config.js'), "export default [{ rules: { '@typescript-eslint/no-explicit-any': 'warn' } }];\n");
      fs.writeFileSync(path.join(repoRoot, 'src/y.ts'), 'export const m = (err as Error).message;\n');
      const result = auditBannedCasts({
        range: 'BASE..HEAD', base: 'BASE', head: 'HEAD', repoRoot,
        changedFiles: [{ path: 'src/y.ts', status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] }],
        claudeFiles: [],
      });
      assert.ok(result.findings.some((f) => f.id.startsWith('banned-cast:as-error:')));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

function castFindings(cfgDir, cfgText, file) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bcast-b2-'));
  try {
    fs.mkdirSync(path.join(repoRoot, path.dirname(file)), { recursive: true });
    if (cfgText !== null) {
      fs.mkdirSync(path.join(repoRoot, cfgDir), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, cfgDir, 'eslint.config.js'), cfgText);
    }
    fs.writeFileSync(path.join(repoRoot, file), 'const a = (b as any);\nconst m = (err as Error).message;\n');
    return auditBannedCasts({
      range: 'BASE..HEAD', base: 'BASE', head: 'HEAD', repoRoot,
      changedFiles: [{ path: file, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 2 }], blame: [] }],
      claudeFiles: [],
    }).findings;
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

describe('MREL-B2 banned-casts gated on target eslint config', () => {
  test('MREL-B2-1 config-less target gets no cast findings', () => {
    assert.equal(castFindings('.', null, 'src/y.ts').length, 0);
  });
  test('MREL-B2-2 nearest config enabling no-explicit-any keeps both findings', () => {
    const f = castFindings('extension', "export default [{ rules: { '@typescript-eslint/no-explicit-any': 'warn' } }];\n", 'extension/src/y.ts');
    assert.ok(f.some((x) => x.id.startsWith('banned-cast:as-any:')));
    assert.ok(f.some((x) => x.id.startsWith('banned-cast:as-error:')));
    assert.equal(f.length, 2);
  });
  test('MREL-B2-3 config setting no-explicit-any off gets no findings', () => {
    assert.equal(castFindings('.', "export default [{ rules: { '@typescript-eslint/no-explicit-any': 'off' } }];\n", 'src/y.ts').length, 0);
  });
});

describe('banned-casts: clean tree', () => {
  test('emits ZERO findings on the current pickle-rick-claude tree (HEAD..HEAD)', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(prdFiles.length > 0, 'need at least one PRD file');
    const report = buildCitadelAuditReport({
      prdPath: path.join('prds', prdFiles[0]),
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });
    const section = report.sections.banned_casts;
    assert.ok(section, 'banned_casts section must exist');
    assert.deepEqual(section.findings, []);
    const leaked = report.findings.filter((f) => f.source_section === 'banned_casts');
    assert.deepEqual(leaked, []);
  });
});
