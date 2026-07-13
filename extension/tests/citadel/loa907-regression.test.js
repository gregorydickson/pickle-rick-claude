// @tier: fast
//
// AC-6 regression proof for the citadel review-efficacy work delivered in T1–T4.
// Reconstructs PR #1707 as a synthetic git repo: a fixed baseline tree + the
// `loa907-dirty.diff` / `loa907-clean.diff` fixtures applied to the working tree
// via real `git apply` (so the .diff is load-bearing — git parses & applies it).
// HEAD stays at the baseline commit so stale-reference's `git grep <id> HEAD`
// sees the pre-PR tree; the analyzers read the post-PR working-tree content.
//
// Four invariants:
//   M1 (deterministic floor, EXACT): #6, #9, #10, #14 surface with pinned CitadelSeverity.
//   M2 (structural, presence-only):   skeptic_findings.json names #1/#2/#3/#7/#11/#13/#15 symbols.
//   G2 (no false positives):          the clean fixture yields ZERO findings per detector.
//   G1 (no new halt):                 a finding-bearing run does not change terminal exit behavior.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditPatternConformance } from '../../services/citadel/pattern-conformance-audit.js';
import { auditBannedCasts } from '../../services/citadel/banned-casts-audit.js';
import { auditBannedConstructs } from '../../services/citadel/banned-constructs-audit.js';
import { auditStaleReferences } from '../../services/citadel/stale-reference-audit.js';
import { auditSiblingAuthPreconditions } from '../../services/citadel/sibling-auth-audit.js';
import { runSkepticLens } from '../../services/citadel/skeptic-lens.js';
import { Reporter } from '../../services/citadel/reporter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const DIRTY_DIFF = path.join(FIXTURES_DIR, 'loa907-dirty.diff');
const CLEAN_DIFF = path.join(FIXTURES_DIR, 'loa907-clean.diff');

// CitadelSeverity is a TYPE in reporter.ts (erased at runtime) — there is no runtime
// enum symbol to import. The four-member set is the contract the type encodes; we pin
// each emitted severity against it and assert no analyzer emits outside it.
const CITADEL_SEVERITIES = new Set(['Critical', 'High', 'Medium', 'Low']);

// The pre-PR (baseline) tree both fixtures apply onto. The PATTERN_SHAPE-bearing
// CLAUDE.md MUST live at extension/CLAUDE.md (pattern-conformance harvests only
// <repoRoot>/extension/CLAUDE.md and <repoRoot>/extension/src/**/CLAUDE.md).
const BASELINE_FILES = {
  'extension/CLAUDE.md':
    '# Target repo CLAUDE.md (synthetic)\n\n## Trap Doors\n\n'
    + '- `appraisal/jest-config-guard.ts` (LOA-MIG-1) — INVARIANT: a new migration spec '
    + 'MUST be registered in all three places; the guard file MUST list every place. '
    + 'PATTERN_SHAPE: `testPathIgnorePatterns`.\n',
  'appraisal/jest-config-guard.ts':
    "export const registeredPlaces = [\n  'jest.containers.config.json',\n  'ci.yml',\n  'testPathIgnorePatterns',\n];\n",
  'appraisal/processor.ts':
    'export function runProcessor(lenderCode: string): void {\n  trace(lenderCode);\n}\n',
  'appraisal/langgraph.service.ts':
    'export function invokeGraph(state: GraphState): void {\n  app.invoke(state);\n}\n',
  'appraisal/attom-node.ts':
    'export function attomFetch(form: string): void {\n  doFetch(form);\n}\n',
  'appraisal/form-node-a.ts':
    'export function helperA(x: number): number { return x; }\n',
  'appraisal/form-node-b.ts':
    'export function helperB(x: number): number { return x; }\n',
};

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, timeout: 15_000, encoding: 'utf-8' });
}

/** Build the synthetic baseline repo, then `git apply` the fixture to the working tree.
 *  HEAD remains the baseline commit; the post-PR content lives only in the working tree. */
function buildRepoWithFixture(diffPath) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loa907-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  for (const [rel, content] of Object.entries(BASELINE_FILES)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'baseline');
  // Apply the fixture to the working tree. If the .diff is malformed or drifts from
  // the baseline context, git apply throws and the test fails — the .diff is load-bearing.
  git(repo, 'apply', diffPath);
  return repo;
}

function changedFile(p, start, end, { kind = 'production', status = 'M' } = {}) {
  return { path: p, status, kind, changedLines: [{ start, end }], blame: [] };
}

// changedLines envelopes covering every post-PR hunk in each fixture.
const DIRTY_CHANGED = [
  changedFile('appraisal/jest-config-guard.ts', 1, 4),
  changedFile('appraisal/langgraph.service.ts', 1, 3),
  changedFile('appraisal/processor.ts', 1, 6),
  changedFile('appraisal/attom-node.ts', 1, 5),
  changedFile('appraisal/form-node-a.ts', 1, 3),
  changedFile('appraisal/form-node-b.ts', 1, 3),
  changedFile('db/migrations/0154_appraisal.sql', 1, 3, { status: 'A' }),
];
const CLEAN_CHANGED = [
  changedFile('appraisal/jest-config-guard.ts', 1, 6),
  changedFile('appraisal/langgraph.service.ts', 1, 3),
  changedFile('appraisal/processor.ts', 1, 6),
  changedFile('appraisal/attom-node.ts', 1, 5),
  changedFile('appraisal/form-node-a.ts', 1, 3),
  changedFile('appraisal/form-node-b.ts', 1, 3),
  changedFile('db/migrations/0155_appraisal_safe.sql', 1, 3, { status: 'A' }),
];

function diffSummary(repo, changedFiles) {
  return { range: 'HEAD..HEAD', base: 'HEAD', head: 'HEAD', repoRoot: repo, changedFiles, claudeFiles: [] };
}

/** Run every NEW/EXTENDED deterministic detector over a DiffSummary and merge findings. */
function runDeterministicDetectors(diff) {
  return [
    ...auditPatternConformance(diff).findings,
    ...auditBannedCasts(diff).findings,
    ...auditBannedConstructs(diff).findings,
    ...auditStaleReferences(diff).findings,
    ...auditSiblingAuthPreconditions(diff, { projectShapes: [] }).findings,
  ];
}

function firstWithPrefix(findings, prefix) {
  return findings.find((f) => typeof f.id === 'string' && f.id.startsWith(prefix));
}

describe('loa907-regression: M1 deterministic floor (dirty fixture)', () => {
  let repo;
  let findings;
  before(() => {
    repo = buildRepoWithFixture(DIRTY_DIFF);
    findings = runDeterministicDetectors(diffSummary(repo, DIRTY_CHANGED));
  });
  after(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  // Each defect pins the EXACT emitted CitadelSeverity (reporter.ts CitadelSeverity union).
  const FLOOR = [
    // R-PCPS: defect '#10 PATTERN_SHAPE violation' was dropped from the floor — the citadel
    // grep arm that emitted it was unsound (it inverted MUST-NOT assertions and reported
    // literally-present code as absent). Trap-door PATTERN_SHAPE enforcement now lives in
    // extension/scripts/audit-trap-door-enforcement.sh, which is in the release gate.
    { defect: '#6 SQL ON CONFLICT clobber', prefix: 'sql-conflict-clobber:', severity: 'High' },
    { defect: '#9 `as never` cast', prefix: 'banned-cast:as-never:', severity: 'Medium' },
    { defect: '#14 stale cited symbol', prefix: 'stale-reference:', severity: 'Low' },
  ];

  for (const { defect, prefix, severity } of FLOOR) {
    test(`surfaces ${defect} with pinned severity ${severity}`, () => {
      const hit = firstWithPrefix(findings, prefix);
      assert.ok(hit, `expected a finding with id prefix "${prefix}" (defect ${defect}); got: ${findings.map((f) => f.id).join(', ')}`);
      assert.ok(CITADEL_SEVERITIES.has(hit.severity), `${defect}: severity "${hit.severity}" is outside the CitadelSeverity union`);
      assert.equal(hit.severity, severity, `${defect}: emitted severity must be pinned to ${severity}`);
    });
  }

  test('all floor defects fire together on a single dirty run', () => {
    const present = FLOOR.filter(({ prefix }) => firstWithPrefix(findings, prefix));
    assert.equal(present.length, FLOOR.length, `expected all ${FLOOR.length} floor defects; got ${present.map((p) => p.defect).join(', ')}`);
  });

  test('every emitted severity is a member of the CitadelSeverity union', () => {
    for (const f of findings) {
      assert.ok(CITADEL_SEVERITIES.has(f.severity), `finding ${f.id} emits "${f.severity}" outside the CitadelSeverity union`);
    }
  });
});

describe('loa907-regression: M2 structural set (dirty fixture, presence-only)', () => {
  let repo;
  let sink;
  let sinkJson;
  before(() => {
    repo = buildRepoWithFixture(DIRTY_DIFF);
    sink = runSkepticLens(DIRTY_CHANGED, repo);
    sinkJson = JSON.stringify(sink, null, 2);
  });
  after(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  test('skeptic_findings sink is non-empty', () => {
    assert.ok(Array.isArray(sink.findings), 'sink must have a findings array');
    assert.ok(sink.findings.length > 0, 'skeptic sink must be non-empty on the dirty fixture');
  });

  // Presence-only: the sink must NAME the expected symbol for each structural defect.
  // (Content correctness is validated by prompt iteration, not a deterministic CI assertion.)
  const STRUCTURAL_SYMBOLS = [
    { defect: '#1 semantic identity', symbol: 'lenderCode' },
    { defect: '#1 semantic identity', symbol: 'lenderId' },
    { defect: '#2 fallback null-flow', symbol: 'coverage_pct' },
    { defect: '#3 resource lifecycle', symbol: 'PoolConnection' },
    { defect: '#7 blocking IO on hot path', symbol: 'rdsCaBundle' },
    { defect: '#11 cross-file repetition', symbol: 'normalizeFormType' },
    { defect: '#15 dead guard', symbol: 'attomSecondPassExceedsLockBudget' },
    { defect: '#15 no-op flag', symbol: 'ENABLE_ATTOM_ENRICHMENT' },
  ];

  for (const { defect, symbol } of STRUCTURAL_SYMBOLS) {
    test(`sink names ${symbol} (${defect})`, () => {
      assert.ok(sinkJson.includes(symbol), `skeptic sink must name "${symbol}" for ${defect}`);
    });
  }

  test('#13 exhaustiveness defect class is present (cross-file-repetition-exhaustiveness)', () => {
    const exhaustive = sink.findings.find((f) => f.defect === 'cross-file-repetition-exhaustiveness');
    assert.ok(exhaustive, 'expected the exhaustiveness/repetition skeptic defect for #11/#13');
    assert.match(exhaustive.why, /exhaustiveness/, 'why must name the exhaustiveness concern (#13)');
  });

  test('AC-5b barrier: skeptic findings carry no severity (cannot enter GateResult / convergence)', () => {
    for (const f of sink.findings) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(f, 'severity'),
        `skeptic finding for "${f.defect}" must not carry severity — that absence is the report-only barrier`,
      );
    }
  });
});

describe('loa907-regression: G2 no false positives (clean fixture)', () => {
  let repo;
  before(() => {
    repo = buildRepoWithFixture(CLEAN_DIFF);
  });
  after(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  test('every new/extended deterministic detector yields ZERO findings', () => {
    const findings = runDeterministicDetectors(diffSummary(repo, CLEAN_CHANGED));
    assert.deepEqual(findings, [], `clean fixture must produce zero deterministic findings; got: ${findings.map((f) => f.id).join(', ')}`);
  });

  test('per-detector empty cases each yield zero findings', () => {
    const diff = diffSummary(repo, CLEAN_CHANGED);
    assert.equal(auditPatternConformance(diff).findings.length, 0, 'PATTERN_SHAPE present + safe EXCLUDED.col SQL → no-op');
    assert.equal(auditBannedCasts(diff).findings.length, 0, 'no banned cast in clean fixture');
    assert.equal(auditStaleReferences(diff).findings.length, 0, 'no HEAD-absent cited symbol in clean comments');
    assert.equal(auditSiblingAuthPreconditions(diff, { projectShapes: [] }).findings.length, 0, 'no documented sibling → no fabricated parity');
  });

  test('skeptic lens is silent on the clean fixture (#15-style guard with no in-scope constants)', () => {
    const sink = runSkepticLens(CLEAN_CHANGED, repo);
    assert.equal(sink.findings.length, 0, `clean fixture must yield zero skeptic findings; got: ${JSON.stringify(sink.findings)}`);
  });
});

describe('loa907-regression: G1 no new halt (finding-bearing run keeps terminal exit unchanged)', () => {
  let dirtyRepo;
  let cleanRepo;
  before(() => {
    dirtyRepo = buildRepoWithFixture(DIRTY_DIFF);
    cleanRepo = buildRepoWithFixture(CLEAN_DIFF);
  });
  after(() => {
    if (dirtyRepo) fs.rmSync(dirtyRepo, { recursive: true, force: true });
    if (cleanRepo) fs.rmSync(cleanRepo, { recursive: true, force: true });
  });

  function exitCodeFor(findings) {
    const reporter = new Reporter();
    const built = reporter.build({
      prdPath: '',
      diffRange: 'HEAD..HEAD',
      header: { pickle_phase_failed: false, pickle_exit_code: null },
      sections: {},
      findings,
      decisions: [],
    });
    return built.exit_code;
  }

  test('the dirty (finding-bearing) run exits 0, identical to the clean run', () => {
    const dirtyFindings = runDeterministicDetectors(diffSummary(dirtyRepo, DIRTY_CHANGED));
    const cleanFindings = runDeterministicDetectors(diffSummary(cleanRepo, CLEAN_CHANGED));
    assert.ok(dirtyFindings.length > 0, 'precondition: dirty run must be finding-bearing');
    assert.equal(cleanFindings.length, 0, 'precondition: clean run has no findings');

    const dirtyExit = exitCodeFor(dirtyFindings);
    const cleanExit = exitCodeFor(cleanFindings);
    // None of the floor defects (#6 High, #9 Medium, #10 High, #14 Low) is Critical, and the
    // default (non-strict) reporter raises exit to 1 only on Critical — so report-only findings
    // ride B-HRP's no-halt rail without changing terminal exit behavior.
    assert.equal(cleanExit, 0, 'clean run must exit 0');
    assert.equal(dirtyExit, 0, 'finding-bearing dirty run must STILL exit 0 — report-only, no new halt');
    assert.equal(dirtyExit, cleanExit, 'finding-bearing run must not change terminal exit vs the clean run');
  });

  test('no floor finding is Critical (the only severity that would raise exit)', () => {
    const dirtyFindings = runDeterministicDetectors(diffSummary(dirtyRepo, DIRTY_CHANGED));
    const critical = dirtyFindings.filter((f) => f.severity === 'Critical');
    assert.deepEqual(critical, [], `no deterministic floor finding may be Critical; got: ${critical.map((f) => f.id).join(', ')}`);
  });
});
