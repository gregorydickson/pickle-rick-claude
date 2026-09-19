// @tier: fast
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  buildCitadelAuditReport,
  __setAnalyzerOverridesForTests,
} from '../services/citadel/audit-runner.js';
import { parseWithComposes } from '../services/citadel/prd-parser.js';
import { detectProjectShapes } from '../services/citadel/project-shape.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const AUDIT_RUNNER_SRC = path.resolve(__dirname, '../src/services/citadel/audit-runner.ts');
const PRDS_DIR = path.resolve(REPO_ROOT, 'prds');

const EXPECTED_IMPORTS = [
  "from './ac-coverage-scorecard",
  "from './allowlist-dead-entry-detector",
  "from './state-transition-audit",
  "from './trap-door-coverage-audit",
];

const NEW_SECTION_KEYS = ['ac_coverage', 'allowlist_dead', 'state_transitions', 'trap_door_coverage'];

afterEach(() => {
  __setAnalyzerOverridesForTests(null);
});

describe('citadel audit-runner wiring', () => {
  test('all 4 new analyzers are imported in audit-runner.ts source', () => {
    const src = fs.readFileSync(AUDIT_RUNNER_SRC, 'utf-8');
    for (const importFragment of EXPECTED_IMPORTS) {
      assert.ok(
        src.includes(importFragment),
        `Expected import not found: ${importFragment}`,
      );
    }
  });

  test('all 4 new sections present in report from clean HEAD..HEAD diff', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    assert.ok(prdFiles.length > 0, 'need at least one PRD file in prds/');
    const prdPath = path.join('prds', prdFiles[0]);

    const report = buildCitadelAuditReport({
      prdPath,
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });

    for (const key of NEW_SECTION_KEYS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(report.sections, key),
        `sections missing key: ${key}`,
      );
    }
  });

  test('per-analyzer error isolation: one throws, other 3 sections still present with correct shapes', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    const prdPath = path.join('prds', prdFiles[0]);

    __setAnalyzerOverridesForTests(new Map([
      ['citadel-ac-coverage', () => { throw new Error('injected ac-coverage failure'); }],
    ]));

    const report = buildCitadelAuditReport({
      prdPath,
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });

    // Failed section has analyzer_threw
    const failedSection = report.sections['ac_coverage'];
    assert.ok(failedSection, 'ac_coverage section should exist even when analyzer throws');
    assert.ok(
      Array.isArray(failedSection.findings) && failedSection.findings.length > 0,
      'failed section should have at least one finding',
    );
    assert.equal(failedSection.findings[0].analyzer_threw, true, 'finding should have analyzer_threw=true');
    assert.equal(failedSection.findings[0].severity, 'Low');

    // Other 3 sections still present
    const otherKeys = NEW_SECTION_KEYS.filter((k) => k !== 'ac_coverage');
    for (const key of otherKeys) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(report.sections, key),
        `sections missing key after ac_coverage throw: ${key}`,
      );
    }
  });
});

describe('citadel project-shape gate', () => {
  test('frontend_prop_drift is skipped on pickle-rick-claude (non-React repo)', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    const prdPath = path.join('prds', prdFiles[0]);

    const report = buildCitadelAuditReport({
      prdPath,
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });

    const section = report.sections['frontend_prop_drift'];
    assert.ok(section, 'frontend_prop_drift section must exist');
    assert.equal(
      section.skipped,
      'project_shape_mismatch',
      `expected skipped='project_shape_mismatch', got ${JSON.stringify(section.skipped)}`,
    );
    assert.ok(typeof section.reason === 'string' && section.reason.length > 0, 'reason must be non-empty string');
    assert.deepStrictEqual(section.findings, [], 'skipped section must have empty findings');
  });

  test('endpoint_contract_conformance is skipped on pickle-rick-claude (non-NestJS repo)', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    const prdPath = path.join('prds', prdFiles[0]);

    const report = buildCitadelAuditReport({
      prdPath,
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });

    const section = report.sections['endpoint_contract_conformance'];
    assert.ok(section, 'endpoint_contract_conformance section must exist');
    assert.equal(
      section.skipped,
      'project_shape_mismatch',
      `expected skipped='project_shape_mismatch', got ${JSON.stringify(section.skipped)}`,
    );
    assert.ok(typeof section.reason === 'string' && section.reason.length > 0, 'reason must be non-empty string');
    assert.deepStrictEqual(section.findings, [], 'skipped section must have empty findings');
  });

  test('universal analyzer (trap_door_coverage) fires normally on pickle-rick-claude', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    const prdPath = path.join('prds', prdFiles[0]);

    const report = buildCitadelAuditReport({
      prdPath,
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });

    const section = report.sections['trap_door_coverage'];
    assert.ok(section, 'trap_door_coverage section must exist');
    assert.ok(section.skipped !== 'project_shape_mismatch', 'universal analyzer must not be shape-gated');
    assert.ok(Array.isArray(section.findings), 'universal analyzer must have findings array');
  });

  test('skipped section is distinguishable from clean-run section', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    const prdPath = path.join('prds', prdFiles[0]);

    const report = buildCitadelAuditReport({
      prdPath,
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });

    const skipped = report.sections['frontend_prop_drift'];
    const clean = report.sections['trap_door_coverage'];

    // skipped has skipped='project_shape_mismatch'
    assert.equal(skipped.skipped, 'project_shape_mismatch');
    // clean has skipped=false or undefined — either way, not 'project_shape_mismatch'
    assert.notEqual(clean.skipped, 'project_shape_mismatch');
  });

  test('detectProjectShapes import is wired (project-shape module loadable)', () => {
    // Ensure the module exports the function and is callable from test context
    const shapes = detectProjectShapes(REPO_ROOT);
    assert.ok(Array.isArray(shapes) && shapes.length > 0, 'detectProjectShapes must return non-empty array');
  });
});

// ticket 98dc9bed F3.1: audit-runner must walk the composes: chain so
// parsedPrd.composedRcodes is non-empty when the PRD lists composed sources.
// Pre-fix: audit-runner called parsePrdMarkdown (no composes walk) and
// composedRcodes stayed an empty Map forever.
/**
 * AP-EXT-ITER287-01: a REAL one-commit repo, because the degrade under test lets the run reach
 * `walkDiff` — a bare `.git` directory would fail there instead, and the case would pass for the
 * wrong reason.
 */
function makeCommittedRepo(prefix, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const run = (args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 't@example.com']);
  run(['config', 'user.name', 'T']);
  run(['config', 'commit.gpgsign', 'false']);
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(root, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  run(['add', '.']);
  run(['commit', '-qm', 'base']);
  return root;
}

describe('citadel audit-runner composes: wiring (ticket 98dc9bed)', () => {
  test('audit-runner.ts source imports parseWithComposes', () => {
    const src = fs.readFileSync(AUDIT_RUNNER_SRC, 'utf-8');
    assert.ok(
      src.includes('parseWithComposes'),
      'audit-runner.ts must import parseWithComposes for composes: chain walking',
    );
  });

  test('parseWithComposes populates composedRcodes when PRD has composes: front-matter', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-runner-composes-'));
    fs.mkdirSync(path.join(tmpRoot, '.git'), { recursive: true });
    const sourcePrd = path.join(tmpRoot, 'source.md');
    const composerPrd = path.join(tmpRoot, 'composer.md');
    fs.writeFileSync(sourcePrd, '# Source\nR-CHAIN-1 lives here.\nR-CHAIN-2 lives here.\n');
    fs.writeFileSync(composerPrd, '---\ncomposes:\n  - source.md\n---\n# Composer\n');

    const parsed = parseWithComposes(composerPrd, { repoRoot: tmpRoot });
    assert.ok(parsed.composedRcodes.size > 0, 'composedRcodes must be populated');
    const allRcodes = [...parsed.composedRcodes.values()].flat().map((e) => e.id);
    assert.ok(allRcodes.includes('R-CHAIN-1'), 'expected R-CHAIN-1 from composed source');
    assert.ok(allRcodes.includes('R-CHAIN-2'), 'expected R-CHAIN-2 from composed source');

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('buildCitadelAuditReport: no throw on PRDs without composes: front-matter', () => {
    const prdFiles = fs.readdirSync(PRDS_DIR).filter((f) => f.endsWith('.md'));
    const prdPath = path.join('prds', prdFiles[0]);
    const report = buildCitadelAuditReport({
      prdPath,
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });
    assert.ok(report.sections, 'report must have sections');
    // Pre-existing analyzers must still produce their sections after the
    // parser switch.
    for (const key of ['ac_coverage', 'allowlist_dead', 'state_transitions', 'trap_door_coverage']) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(report.sections, key),
        `sections missing key after parseWithComposes switch: ${key}`,
      );
    }
  });

  // AP-EXT-ITER287-01: ticket 98dc9bed's intent — a malformed compose graph must never be
  // SILENTLY audited as the wrong scope — is kept; only its disposition changes. It used to
  // throw, and nothing between here and the CLI catches (not buildCitadelAuditReport, not
  // executeCitadelPhase, not runPhaseIteration, not runPipelinePhaseLoop), so the throw reached
  // pipeline-runner's fatal handler and ended the run with anatomy-park and szechuan-sauce never
  // run. Honesty is a reporting property, halting is a disposition; this pins the report.
  test('AP-EXT-ITER287-01: a malformed composes: path is REPORTED, not thrown — the audit still returns', () => {
    const tmpRoot = makeCommittedRepo('audit-runner-bad-composes-', {
      'composer.md': '---\ncomposes:\n  - ../escape.md\n---\n# Composer\n',
    });

    try {
      const report = buildCitadelAuditReport({
        prdPath: 'composer.md',
        diffRange: 'HEAD..HEAD',
        repoRoot: tmpRoot,
      });
      const breadcrumb = report.findings.find((finding) => finding.id === 'citadel-prd-parse');
      assert.ok(breadcrumb, 'the unresolved compose graph must be reported as a finding');
      assert.equal(breadcrumb.analyzer_threw, true);
      assert.equal(breadcrumb.severity, 'Low');
      assert.match(breadcrumb.message, /Invalid composes: path "\.\.\/escape\.md"/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // The live-repo family: 35 of this repo's 466 PRDs made parseWithComposes throw when measured
  // on 2026-09-18, and the largest cause is the QUOTED block-list entry that several committed
  // PRDs use — the quotes are not stripped, so `path.join` resolves a path nobody wrote. The
  // composed sibling here EXISTS; only the quoting is at fault, which is why this case proves
  // the degrade rather than a missing file.
  test('AP-EXT-ITER287-01: a quoted composes: entry degrades the audit instead of ending the run', () => {
    const tmpRoot = makeCommittedRepo('audit-runner-quoted-composes-', {
      'prds/child.md': '# Child\n\nAC-QUOTED-1 child acceptance criterion.\n',
      'prds/bundle.md': '---\ncomposes:\n  - "prds/child.md"\n---\n# Bundle\n',
    });

    try {
      const report = buildCitadelAuditReport({
        prdPath: 'prds/bundle.md',
        diffRange: 'HEAD..HEAD',
        repoRoot: tmpRoot,
      });
      const breadcrumb = report.findings.find((finding) => finding.id === 'citadel-prd-parse');
      assert.ok(breadcrumb, 'a quoted composes: entry must leave a named breadcrumb');
      assert.equal(
        report.sections.ac_coverage.findings[0].id,
        'citadel-prd-parse',
        'the breadcrumb rides the section whose population the failed parse emptied',
      );
      assert.equal(
        report.sections.ac_coverage.rows,
        undefined,
        'a degraded ac_coverage must not report rows it never scored',
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('buildCitadelAuditReport consumes composed child AC and transition inputs', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-runner-composed-inputs-'));
    const run = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

    try {
      run(['init'], tmpRoot);
      run(['config', 'user.email', 't@example.com'], tmpRoot);
      run(['config', 'user.name', 'T'], tmpRoot);
      fs.mkdirSync(path.join(tmpRoot, 'prds'), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tmpRoot, 'prds', 'bundle.md'), '# baseline\n');
      run(['add', '.'], tmpRoot);
      run(['commit', '-m', 'baseline'], tmpRoot);

      fs.writeFileSync(
        path.join(tmpRoot, 'prds', 'child.md'),
        [
          '# Child',
          '',
          'AC-CHILD-1 child acceptance criterion.',
          '',
          '| Transition | Audit | Expected Call Site |',
          '| child->done | logChildTransition | childRunner |',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(tmpRoot, 'prds', 'bundle.md'),
        [
          '---',
          'composes:',
          '  - prds/child.md',
          '---',
          '# Bundle',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(tmpRoot, 'src', 'child-runner.ts'),
        [
          'export function childRunner() {',
          "  logChildTransition('child->done');",
          '}',
        ].join('\n'),
      );
      run(['add', '.'], tmpRoot);
      run(['commit', '-m', 'feature'], tmpRoot);

      const report = buildCitadelAuditReport({
        prdPath: 'prds/bundle.md',
        diffRange: 'HEAD~1..HEAD',
        repoRoot: tmpRoot,
      });

      // AP-EXT-ITER287-01 over-trigger control: a compose graph that DOES resolve must leave no
      // degrade breadcrumb and must still carry the composed child's AC. A fix that degraded
      // unconditionally would pass the two cases above and fail here.
      assert.equal(
        report.findings.some((finding) => finding.id === 'citadel-prd-parse'),
        false,
        'a resolvable composes: graph must not be reported as unresolved',
      );
      assert.equal(
        report.sections.ac_coverage.rows.some((row) => row.id === 'AC-CHILD-1'),
        true,
        'composed child AC must reach ac_coverage',
      );
      assert.equal(
        report.sections.state_transitions.rows.some((row) => row.auditAction === 'logChildTransition'),
        true,
        'composed child transition rows must reach state_transitions',
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
