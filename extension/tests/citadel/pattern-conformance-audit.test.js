// @tier: fast
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = path.resolve(__dirname, '../../services/citadel');

const { auditPatternConformance } = await import(
  path.join(SERVICES_DIR, 'pattern-conformance-audit.js')
);

function makeDiff(repoRoot, changedFiles) {
  return {
    range: 'HEAD..HEAD',
    base: 'HEAD',
    head: 'HEAD',
    repoRoot,
    changedFiles,
    claudeFiles: [],
  };
}

describe('pattern-conformance-audit: PATTERN_SHAPE violations', () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-'));
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('flags a diff hunk that violates a harvested PATTERN_SHAPE', () => {
    const targetFile = 'extension/src/some-service.ts';
    fs.mkdirSync(path.join(tmpDir, 'extension', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'extension', 'CLAUDE.md'),
      `## Trap Doors\n\n- \`${targetFile}\` (TEST-1) — INVARIANT: test. PATTERN_SHAPE: \`REQUIRED_SENTINEL_XYZ\`.\n`,
    );
    // Write target file WITHOUT the required pattern
    fs.writeFileSync(
      path.join(tmpDir, targetFile),
      'export function doSomething() { return 42; }\n',
    );

    const diff = makeDiff(tmpDir, [
      { path: targetFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
    ]);
    const result = auditPatternConformance(diff);

    const violations = result.findings.filter((f) => f.id.startsWith('pattern-shape-violation:'));
    assert.ok(violations.length >= 1, `Expected PATTERN_SHAPE violation; got ${JSON.stringify(result.findings)}`);
    assert.strictEqual(violations[0].severity, 'High', 'finding must have High severity');
  });

  test('no finding when PATTERN_SHAPE is satisfied', () => {
    const targetFile = 'extension/src/satisfied-service.ts';
    fs.mkdirSync(path.join(tmpDir, 'extension', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'extension', 'CLAUDE.md'),
      `## Trap Doors\n\n- \`${targetFile}\` (TEST-2) — INVARIANT: test. PATTERN_SHAPE: \`REQUIRED_SENTINEL_XYZ\`.\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, targetFile),
      'export const REQUIRED_SENTINEL_XYZ = true;\n',
    );

    const diff = makeDiff(tmpDir, [
      { path: targetFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
    ]);
    const result = auditPatternConformance(diff);

    const violations = result.findings.filter((f) => f.id.startsWith('pattern-shape-violation:'));
    assert.strictEqual(violations.length, 0, 'Expected no violations when pattern present');
  });

  test('regex-form PATTERN_SHAPE is checked with RegExp', () => {
    const targetFile = 'extension/src/regex-service.ts';
    fs.mkdirSync(path.join(tmpDir, 'extension', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'extension', 'CLAUDE.md'),
      // Pattern uses a regex alternation
      `## Trap Doors\n\n- \`${targetFile}\` (TEST-3) — INVARIANT: test. PATTERN_SHAPE: \`GUARD_A|GUARD_B\`.\n`,
    );
    // File contains GUARD_B → regex matches → no violation
    fs.writeFileSync(path.join(tmpDir, targetFile), 'const x = GUARD_B;\n');

    const diff = makeDiff(tmpDir, [
      { path: targetFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
    ]);
    const result = auditPatternConformance(diff);

    const violations = result.findings.filter((f) => f.id.startsWith('pattern-shape-violation:'));
    assert.strictEqual(violations.length, 0, 'Regex alternation: GUARD_B satisfies GUARD_A|GUARD_B');
  });

  test('literal fallback when backtick string is invalid regex', () => {
    const targetFile = 'extension/src/literal-service.ts';
    fs.mkdirSync(path.join(tmpDir, 'extension', 'src'), { recursive: true });
    // Pattern has unmatched paren — invalid regex; falls back to literal string match
    const pattern = 'someFunc(arg1, arg2';
    fs.writeFileSync(
      path.join(tmpDir, 'extension', 'CLAUDE.md'),
      `## Trap Doors\n\n- \`${targetFile}\` (TEST-4) — INVARIANT: test. PATTERN_SHAPE: \`${pattern}\`.\n`,
    );
    // File contains the literal string
    fs.writeFileSync(path.join(tmpDir, targetFile), `const x = ${pattern}; /* something */\n`);

    const diff = makeDiff(tmpDir, [
      { path: targetFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
    ]);
    const result = auditPatternConformance(diff);

    const violations = result.findings.filter((f) => f.id.startsWith('pattern-shape-violation:'));
    assert.strictEqual(violations.length, 0, 'Literal fallback: function call string satisfies pattern');
  });

  test('deleted file is not checked for PATTERN_SHAPE', () => {
    const targetFile = 'extension/src/deleted-service.ts';
    fs.mkdirSync(path.join(tmpDir, 'extension', 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'extension', 'CLAUDE.md'),
      `## Trap Doors\n\n- \`${targetFile}\` (TEST-5) — INVARIANT: test. PATTERN_SHAPE: \`SENTINEL_DEL\`.\n`,
    );

    const diff = makeDiff(tmpDir, [
      { path: targetFile, status: 'D', kind: 'production', changedLines: [], blame: [] },
    ]);
    const result = auditPatternConformance(diff);

    const violations = result.findings.filter((f) => f.id.startsWith('pattern-shape-violation:'));
    assert.strictEqual(violations.length, 0, 'Deleted file must not be checked');
  });
});

describe('pattern-conformance-audit: SQL ON CONFLICT clobber', () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-sql-'));
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('flags .sql file with ON CONFLICT DO UPDATE SET col=const', () => {
    const sqlFile = 'db/migrations/001_test.sql';
    fs.mkdirSync(path.join(tmpDir, 'db', 'migrations'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, sqlFile),
      "INSERT INTO items (id, status)\nVALUES (1, 'active')\nON CONFLICT (id) DO UPDATE SET status = 'active';\n",
    );

    const diff = makeDiff(tmpDir, [
      { path: sqlFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 4 }], blame: [] },
    ]);
    const result = auditPatternConformance(diff);

    const sqlFindings = result.findings.filter((f) => f.id.startsWith('sql-conflict-clobber:'));
    assert.ok(sqlFindings.length >= 1, `Expected SQL clobber finding; got ${JSON.stringify(result.findings)}`);
    assert.strictEqual(sqlFindings[0].severity, 'High');
  });

  test('no finding for ON CONFLICT DO UPDATE SET col=EXCLUDED.col (safe)', () => {
    const sqlFile = 'db/migrations/002_safe.sql';
    fs.mkdirSync(path.join(tmpDir, 'db', 'migrations'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, sqlFile),
      "INSERT INTO items (id, status)\nVALUES (1, 'active')\nON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;\n",
    );

    const diff = makeDiff(tmpDir, [
      { path: sqlFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 4 }], blame: [] },
    ]);
    const result = auditPatternConformance(diff);

    const sqlFindings = result.findings.filter((f) => f.id.startsWith('sql-conflict-clobber:'));
    assert.strictEqual(sqlFindings.length, 0, 'EXCLUDED.col must not be flagged');
  });

  test('filters by path.endsWith(.sql) not by kind', () => {
    const sqlFile = 'db/migrations/003_kind_test.sql';
    fs.mkdirSync(path.join(tmpDir, 'db', 'migrations'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, sqlFile),
      "ON CONFLICT (id) DO UPDATE SET value = 'constant';\n",
    );

    // Deliberately use kind: 'test' — SQL path filter must still catch it
    const diff = makeDiff(tmpDir, [
      { path: sqlFile, status: 'M', kind: 'test', changedLines: [{ start: 1, end: 1 }], blame: [] },
    ]);
    const result = auditPatternConformance(diff);

    const sqlFindings = result.findings.filter((f) => f.id.startsWith('sql-conflict-clobber:'));
    assert.ok(sqlFindings.length >= 1, 'kind:test .sql file must still be checked for SQL clobber');
  });

  test('non-.sql changed file does not trigger SQL check', () => {
    const diff = makeDiff(tmpDir, [
      { path: 'src/index.ts', status: 'M', kind: 'production', changedLines: [], blame: [] },
    ]);
    const result = auditPatternConformance(diff);

    const sqlFindings = result.findings.filter((f) => f.id.startsWith('sql-conflict-clobber:'));
    assert.strictEqual(sqlFindings.length, 0, 'No SQL findings for non-.sql files');
  });
});

describe('pattern-conformance-audit: empty/malformed declarations', () => {
  test('empty changedFiles and no CLAUDE.md → zero findings, no throw', () => {
    const diff = makeDiff(os.tmpdir(), []);
    let result;
    assert.doesNotThrow(() => {
      result = auditPatternConformance(diff);
    });
    assert.strictEqual(result.findings.length, 0);
  });

  test('CLAUDE.md with no Trap Doors section → zero findings', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-notd-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'extension'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'extension', 'CLAUDE.md'), '# Extension\n\nNo trap doors.\n');

      const diff = makeDiff(tmpDir, []);
      const result = auditPatternConformance(diff);

      assert.strictEqual(result.findings.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('bullet with no PATTERN_SHAPE: → zero findings for that bullet', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-nops-'));
    try {
      const targetFile = 'extension/src/no-ps.ts';
      fs.mkdirSync(path.join(tmpDir, 'extension', 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'extension', 'CLAUDE.md'),
        `## Trap Doors\n\n- \`${targetFile}\` (TEST) — INVARIANT: test. ENFORCE: some.test.js.\n`,
      );
      fs.writeFileSync(path.join(tmpDir, targetFile), 'export const x = 1;\n');

      const diff = makeDiff(tmpDir, [
        { path: targetFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
      ]);
      const result = auditPatternConformance(diff);

      assert.strictEqual(result.findings.length, 0, 'No PATTERN_SHAPE → no findings');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('lowercase pattern_shape marker is harvested like PATTERN_SHAPE', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-lowercase-'));
    try {
      const targetFile = 'extension/src/lowercase-pattern.ts';
      fs.mkdirSync(path.join(tmpDir, 'extension', 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'extension', 'CLAUDE.md'),
        `## Trap Doors\n\n- \`${targetFile}\` (TEST) — INVARIANT: test. pattern_shape: \`LOWERCASE_SENTINEL\`.\n`,
      );
      fs.writeFileSync(path.join(tmpDir, targetFile), 'export const x = 1;\n');

      const diff = makeDiff(tmpDir, [
        { path: targetFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
      ]);
      const result = auditPatternConformance(diff);

      const violations = result.findings.filter((f) => f.id.startsWith('pattern-shape-violation:'));
      assert.strictEqual(violations.length, 1, 'lowercase marker must still enforce the pattern');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('target file not in changedFiles → no violation even if pattern absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-notchanged-'));
    try {
      const targetFile = 'extension/src/not-changed.ts';
      fs.mkdirSync(path.join(tmpDir, 'extension', 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'extension', 'CLAUDE.md'),
        `## Trap Doors\n\n- \`${targetFile}\` (TEST) — INVARIANT: test. PATTERN_SHAPE: \`SENTINEL_NOTCHANGED\`.\n`,
      );
      fs.writeFileSync(path.join(tmpDir, targetFile), 'export const x = 1;\n');

      // diff only touches a different file
      const diff = makeDiff(tmpDir, [
        { path: 'extension/src/other.ts', status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
      ]);
      const result = auditPatternConformance(diff);

      const violations = result.findings.filter((f) => f.id.startsWith('pattern-shape-violation:'));
      assert.strictEqual(violations.length, 0, 'Unchanged file must not be checked');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
