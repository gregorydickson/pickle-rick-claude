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

function slug(text) {
  return text.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
}

// R-PCPS: the PATTERN_SHAPE grep arm was subtracted. These fixtures reproduce the three
// corpus shapes that made it emit 41/41 false High findings on a clean tree. Each fixture's
// target file FULLY honors its trap door, so a conformance-correct analyzer must stay silent.
// Before the subtraction every one of these emitted `pattern-shape-violation:` at High.
describe('pattern-conformance-audit: PATTERN_SHAPE prose is never enforced as a literal (R-PCPS)', () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-pcps-'));
    fs.mkdirSync(path.join(tmpDir, 'extension', 'src'), { recursive: true });
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runAgainst(targetFile, trapDoorBullet, source) {
    fs.writeFileSync(
      path.join(tmpDir, 'extension', 'CLAUDE.md'),
      `## Trap Doors\n\n${trapDoorBullet}\n`,
    );
    fs.writeFileSync(path.join(tmpDir, targetFile), source);
    const diff = makeDiff(tmpDir, [
      { path: targetFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 1 }], blame: [] },
    ]);
    return auditPatternConformance(diff)
      .findings.filter((f) => f.id.startsWith('pattern-shape-violation:'));
  }

  test('literal code pattern that IS present: `(` and `.` must not be read as regex metachars', () => {
    // Regex-first evaluation made `if (counterNext.halt)` unable to match itself: the parens
    // parse as a capture group and `.` as a wildcard, so the required text never matched.
    const targetFile = 'extension/src/halt-guard.ts';
    const violations = runAgainst(
      targetFile,
      `- \`${targetFile}\` (R-WTB-A1) — INVARIANT: halt only without progress. PATTERN_SHAPE: \`if (counterNext.halt)\`.`,
      'export function run(counterNext) {\n  if (counterNext.halt) { return "halt"; }\n  return "go";\n}\n',
    );
    assert.deepEqual(violations, [], 'pattern is literally present — must not be reported absent');
  });

  test('negative assertion: a MUST-NOT-CONTAIN pattern is not a required pattern', () => {
    // The inversion hazard: R-CNAR-1 requires `applyTicketTierBudget` to NOT contain this
    // assignment (it truncated the operator's global cap). Requiring it PRESENT meant the
    // check only went green once the known-shipped bug was reintroduced.
    const targetFile = 'extension/src/tier-budget.ts';
    const violations = runAgainst(
      targetFile,
      `- \`${targetFile}\` (R-CNAR-1) — INVARIANT: the per-ticket ceiling never overwrites the global cap. PATTERN_SHAPE: \`applyTicketTierBudget\` MUST NOT contain \`state.max_iterations = budget.max_iterations\`.`,
      'export function applyTicketTierBudget(state, budget) {\n  state.current_ticket_max_iterations = budget.max_iterations;\n}\n',
    );
    assert.deepEqual(violations, [], 'code correctly omits the forbidden assignment — must not be flagged');
  });

  test('shell-command / cross-file PATTERN_SHAPE is not grepped into the target file', () => {
    // Corpus carries `grep -c "..." <path> == 0` and `node -e "..."` as PATTERN_SHAPE prose,
    // plus symbols that live in a sibling file. None can ever appear in the target source.
    const targetFile = 'extension/src/oracle.ts';
    const violations = runAgainst(
      targetFile,
      `- \`${targetFile}\` (R-RASO) — INVARIANT: one oracle. PATTERN_SHAPE: \`grep -c "hasFrontmatterCompletionSha" src/bin/mux-runner.ts\` == 0 AND \`persistWorkerGateVerdict(\` in spawn-morty.ts.`,
      'export function resolveAttributableFrontmatterSha() { return null; }\n',
    );
    assert.deepEqual(violations, [], 'shell commands and sibling-file symbols are not target-file literals');
  });

  test('no pattern-shape finding is emitted for any input', () => {
    const targetFile = 'extension/src/absent-guard.ts';
    // Even the historical happy path — a bare sentinel genuinely missing from the file —
    // no longer produces a citadel finding. PATTERN_SHAPE enforcement moved to
    // extension/scripts/audit-trap-door-enforcement.sh (curated, in the release gate).
    const violations = runAgainst(
      targetFile,
      `- \`${targetFile}\` (TEST) — INVARIANT: test. PATTERN_SHAPE: \`REQUIRED_SENTINEL_XYZ\`.`,
      'export function doSomething() { return 42; }\n',
    );
    assert.deepEqual(violations, [], 'the PATTERN_SHAPE arm is subtracted — citadel emits no pattern-shape findings');
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

  // The pre-fix regex anchored `\w+\s*=` directly to `DO UPDATE SET`, so `\w+` could only ever
  // bind the FIRST column. A correct EXCLUDED.<col> in position 1 made the whole file read clean
  // and every clobber in columns 2..N was invisible — i.e. the canonical upsert (propagate most
  // columns from EXCLUDED, clobber one) was exactly the shape the analyzer could not see.
  const multiColumnClobbers = [
    ['clobber in column 2 after a correct column 1', "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = 'x@y.z';\n", 'email'],
    ['NULL clobber in column 2', 'ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a, b = NULL;\n', 'b'],
    ['clobber in column 3 after two correct columns', 'ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a, b = EXCLUDED.b, c = 0;\n', 'c'],
    ['clobber in a multiline SET list', 'ON CONFLICT (id) DO UPDATE SET\n  a = EXCLUDED.a,\n  b = 0;\n', 'b'],
  ];

  for (const [label, sql, expectedColumn] of multiColumnClobbers) {
    test(`flags ${label}`, () => {
      const sqlFile = `db/migrations/multi_${expectedColumn}_${slug(label)}.sql`;
      fs.mkdirSync(path.join(tmpDir, 'db', 'migrations'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, sqlFile), `INSERT INTO t (id) VALUES (1)\n${sql}`);

      const diff = makeDiff(tmpDir, [
        { path: sqlFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 4 }], blame: [] },
      ]);
      const sqlFindings = auditPatternConformance(diff)
        .findings.filter((f) => f.id.startsWith('sql-conflict-clobber:'));

      assert.strictEqual(sqlFindings.length, 1, `Expected a clobber finding for ${label}`);
      assert.match(sqlFindings[0].message, new RegExp(`\\b${expectedColumn}\\b`), 'finding must name the clobbered column');
    });
  }

  test('every column correctly assigned from EXCLUDED is clean, whatever the list length', () => {
    const sqlFile = 'db/migrations/005_all_excluded.sql';
    fs.mkdirSync(path.join(tmpDir, 'db', 'migrations'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, sqlFile),
      'INSERT INTO t (id) VALUES (1)\nON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a, b = EXCLUDED.b, c = EXCLUDED.c;\n',
    );

    const diff = makeDiff(tmpDir, [
      { path: sqlFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 3 }], blame: [] },
    ]);
    const sqlFindings = auditPatternConformance(diff)
      .findings.filter((f) => f.id.startsWith('sql-conflict-clobber:'));

    assert.strictEqual(sqlFindings.length, 0, 'a fully-EXCLUDED SET list must not be flagged');
  });

  test('a function call argument comma does not split an assignment', () => {
    const sqlFile = 'db/migrations/006_coalesce.sql';
    fs.mkdirSync(path.join(tmpDir, 'db', 'migrations'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, sqlFile),
      "INSERT INTO t (id) VALUES (1)\nON CONFLICT (id) DO UPDATE SET a = COALESCE(EXCLUDED.a, t.a), b = EXCLUDED.b, c = 'const';\n",
    );

    const diff = makeDiff(tmpDir, [
      { path: sqlFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 3 }], blame: [] },
    ]);
    const sqlFindings = auditPatternConformance(diff)
      .findings.filter((f) => f.id.startsWith('sql-conflict-clobber:'));

    // `c` is the only const clobber. COALESCE(EXCLUDED.a, t.a) consumes the incoming row, so it is
    // not one — and it must be read as ONE assignment, never split at the argument comma into a
    // bogus `t` column. Pin the whole column list: a split would widen it.
    assert.strictEqual(sqlFindings.length, 1);
    assert.match(sqlFindings[0].message, /\(c\)/, 'the finding must name exactly the const-clobbered column');
  });

  // The clobber RHS is matched POSITIVELY against the literal-constant set. Matching it negatively
  // ("anything that is not EXCLUDED.<col>") swept in every function-valued assignment: it fired a
  // High on `updated_at = NOW()` — the single most common CORRECT upsert idiom — advising
  // "use EXCLUDED.updated_at instead", which is precisely what you must NOT write there. Same
  // false-High class the R-PCPS subtraction above deleted the PATTERN_SHAPE arm for.
  const functionValuedRhs = [
    ['NOW() timestamp stamp', 'ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v, updated_at = NOW();\n'],
    ['CURRENT_TIMESTAMP stamp', 'ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v, updated_at = CURRENT_TIMESTAMP;\n'],
    ['NULLIF — must not match on the NULL prefix', 'ON CONFLICT (id) DO UPDATE SET n = NULLIF(t.n, 0);\n'],
  ];

  for (const [label, sql] of functionValuedRhs) {
    test(`function-valued RHS is not a const clobber: ${label}`, () => {
      const sqlFile = `db/migrations/fn_${slug(label)}.sql`;
      fs.mkdirSync(path.join(tmpDir, 'db', 'migrations'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, sqlFile), `INSERT INTO t (id) VALUES (1)\n${sql}`);

      const diff = makeDiff(tmpDir, [
        { path: sqlFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 3 }], blame: [] },
      ]);
      const sqlFindings = auditPatternConformance(diff)
        .findings.filter((f) => f.id.startsWith('sql-conflict-clobber:'));

      assert.deepEqual(sqlFindings, [], 'a computed value is not a discarded value — must not be flagged');
    });
  }

  test('narrowing the RHS does not blind the scan: a const clobber beside a NOW() stamp still fires', () => {
    const sqlFile = 'db/migrations/007_const_beside_now.sql';
    fs.mkdirSync(path.join(tmpDir, 'db', 'migrations'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, sqlFile),
      "INSERT INTO t (id) VALUES (1)\nON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v, updated_at = NOW(), status = 'pending';\n",
    );

    const diff = makeDiff(tmpDir, [
      { path: sqlFile, status: 'M', kind: 'production', changedLines: [{ start: 1, end: 3 }], blame: [] },
    ]);
    const sqlFindings = auditPatternConformance(diff)
      .findings.filter((f) => f.id.startsWith('sql-conflict-clobber:'));

    assert.strictEqual(sqlFindings.length, 1, 'the real clobber in column 3 must still be caught');
    assert.match(sqlFindings[0].message, /\(status\)/, 'the finding must name status');
    assert.doesNotMatch(sqlFindings[0].message, /updated_at/, 'the NOW() stamp must not ride along in the column list');
  });

  test('deleted .sql file is not checked', () => {
    const diff = makeDiff(tmpDir, [
      { path: 'db/migrations/004_gone.sql', status: 'D', kind: 'production', changedLines: [], blame: [] },
    ]);
    const result = auditPatternConformance(diff);

    const sqlFindings = result.findings.filter((f) => f.id.startsWith('sql-conflict-clobber:'));
    assert.strictEqual(sqlFindings.length, 0, 'Deleted file must not be checked');
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

  test('unreadable target file → zero findings, no throw', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pca-unreadable-'));
    try {
      // Path is declared changed but never written to disk.
      const diff = makeDiff(tmpDir, [
        { path: 'db/migrations/nonexistent.sql', status: 'M', kind: 'production', changedLines: [], blame: [] },
      ]);
      let result;
      assert.doesNotThrow(() => {
        result = auditPatternConformance(diff);
      });
      assert.strictEqual(result.findings.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
