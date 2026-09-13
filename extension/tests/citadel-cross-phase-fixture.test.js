// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';

const __dirname = import.meta.dirname;
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/citadel-cross-phase-fixture');

function writeFile(root, filePath, content) {
  const fullPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function makeRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cross-phase-repo-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  writeFile(repoRoot, 'prd.md', '# PRD\n\n## Acceptance Criteria\n\n**AC-TEST-01**: Stable.\n');
  writeFile(repoRoot, 'src/index.ts', '// AC-TEST-01\nexport const before = true;\n');
  writeFile(repoRoot, 'tests/index.test.ts', '// AC-TEST-01\nimport { describe } from "node:test";\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  const base = git(repoRoot, ['rev-parse', 'HEAD']);
  writeFile(repoRoot, 'src/index.ts', '// AC-TEST-01\nexport const after = true;\n');
  writeFile(repoRoot, 'tests/index.test.ts', '// AC-TEST-01 covered\nimport { describe } from "node:test";\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'head']);
  return { repoRoot, base };
}

function copyFixture(sessionDir) {
  fs.copyFileSync(
    path.join(FIXTURE_DIR, 'anatomy-park.json'),
    path.join(sessionDir, 'anatomy-park.json'),
  );
  fs.copyFileSync(
    path.join(FIXTURE_DIR, 'szechuan-sauce.json'),
    path.join(sessionDir, 'szechuan-sauce.json'),
  );
}

function writeArtifact(sessionDir, fileName, value) {
  fs.writeFileSync(path.join(sessionDir, fileName), JSON.stringify(value, null, 2));
}

describe('citadel cross-phase fixture', () => {
  test('merges anatomy-park and szechuan-sauce findings without double-counting duplicate ids', async () => {
    const { repoRoot, base } = makeRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cross-phase-session-'));
    try {
      copyFixture(sessionDir);

      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
      });

      const crossPhaseFindings = report.findings.filter(
        (f) => f.source === 'anatomy-park' || f.source === 'szechuan-sauce'
      );
      const ids = crossPhaseFindings.map((finding) => finding.id);
      const severities = crossPhaseFindings.map((finding) => finding.severity);
      assert.equal(report.sections.cross_phase.findings.length, 4);
      assert.equal(new Set(ids).size, ids.length);
      assert.deepEqual(severities, ['Critical', 'High', 'Medium', 'Low']);
      assert.equal(report.sections.cross_phase.summary.anatomy_park, 3);
      assert.equal(report.sections.cross_phase.summary.szechuan_sauce, 2);
      assert.equal(report.sections.cross_phase.summary.duplicate_ids_deduped, 1);
      assert.equal(report.sections.cross_phase.summary.duplicate_ids_renamed, 0);
      assert.equal(report.sections.cross_phase.summary.anatomy_park_missing, false);
      assert.equal(ids.filter((id) => id === 'cross-phase-shared-id').length, 1);
      assert.ok(!ids.includes('szechuan-sauce:cross-phase-shared-id'));
      assert.equal(report.summary.critical, 1);
      assert.ok(report.summary.low >= 1);
      assert.equal(report.exit_code, 1);
      assert.equal(report.schema, '1.0');
      assert.equal(report.findings[0].severity, 'Critical');
      // Cross-phase fixture asserts cross-phase merging only; other analyzers may add additional findings
      // for the synthetic repo shape. Severity counts are restricted to cross-phase findings here.
      const xSeverities = report.sections.cross_phase.findings.map((f) => f.severity);
      assert.equal(xSeverities.filter((s) => s === 'Critical').length, 1);
      assert.equal(xSeverities.filter((s) => s === 'High').length, 1);
      assert.equal(xSeverities.filter((s) => s === 'Medium').length, 1);
      assert.equal(xSeverities.filter((s) => s === 'Low').length, 1);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('citadel report header records pickle_phase_failed and pickle_exit_code from recoverable activity', async () => {
    const { repoRoot, base } = makeRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cross-phase-header-'));
    try {
      fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
        activity: [
          {
            event: 'recoverable_phase_failure',
            phase: 'pickle',
            exit_code: 1,
            fatal: false,
            reason: 'non-fatal pickle exit',
          },
        ],
      }, null, 2));

      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
      });

      assert.equal(report.header.pickle_phase_failed, true);
      assert.equal(report.header.pickle_exit_code, 1);
      const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel_report.json'), 'utf-8'));
      assert.equal(persisted.header.pickle_phase_failed, true);
      assert.equal(persisted.header.pickle_exit_code, 1);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('citadel report header promotes recoverable state tmp before reading pickle failure activity', async () => {
    const { repoRoot, base } = makeRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cross-phase-header-tmp-'));
    try {
      const statePath = path.join(sessionDir, 'state.json');
      fs.writeFileSync(`${statePath}.tmp.999999.1`, JSON.stringify({
        activity: [
          {
            event: 'recoverable_phase_failure',
            phase: 'pickle',
            exit_code: 17,
            fatal: false,
            reason: 'tmp promoted pickle exit',
          },
        ],
      }, null, 2));

      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
      });

      assert.equal(report.header.pickle_phase_failed, true);
      assert.equal(report.header.pickle_exit_code, 17);
      const promotedState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(promotedState.activity[0].exit_code, 17);
      const persisted = JSON.parse(fs.readFileSync(path.join(sessionDir, 'citadel_report.json'), 'utf-8'));
      assert.equal(persisted.header.pickle_phase_failed, true);
      assert.equal(persisted.header.pickle_exit_code, 17);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('exits cleanly when sibling phase artifacts are absent', async () => {
    const { repoRoot, base } = makeRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cross-phase-empty-'));
    try {
      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
      });

      assert.equal(report.sections.cross_phase.findings.length, 1);
      assert.equal(report.sections.cross_phase.findings[0].id, 'anatomy-park:missing');
      assert.equal(report.sections.cross_phase.findings[0].severity, 'Low');
      assert.equal(report.sections.cross_phase.summary.anatomy_park, 0);
      assert.equal(report.sections.cross_phase.summary.szechuan_sauce, 0);
      assert.equal(report.sections.cross_phase.summary.duplicate_ids_deduped, 0);
      assert.equal(report.sections.cross_phase.summary.duplicate_ids_renamed, 0);
      assert.equal(report.sections.cross_phase.summary.anatomy_park_missing, true);
      // Cross-phase emits a single anatomy-park:missing Low finding when both artifacts are absent.
      // Other analyzers may add findings for the synthetic repo shape, but exit_code must remain 0
      // (no Critical/High findings).
      const crossPhaseIds = report.findings.filter(
        (f) => f.source === 'anatomy-park' || f.source === 'szechuan-sauce'
      ).map((f) => f.id);
      assert.deepEqual(crossPhaseIds, ['anatomy-park:missing']);
      assert.equal(report.exit_code, 0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('ignores corrupt anatomy artifact without synthesizing a missing-artifact finding', async () => {
    const { repoRoot, base } = makeRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cross-phase-corrupt-'));
    try {
      fs.writeFileSync(path.join(sessionDir, 'anatomy-park.json'), '{not json');
      fs.copyFileSync(
        path.join(FIXTURE_DIR, 'szechuan-sauce.json'),
        path.join(sessionDir, 'szechuan-sauce.json'),
      );

      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
      });

      const ids = report.sections.cross_phase.findings.map((finding) => finding.id);
      assert.deepEqual(ids, ['cross-phase-shared-id', 'szechuan-phase-medium']);
      assert.equal(report.sections.cross_phase.summary.anatomy_park, 0);
      assert.equal(report.sections.cross_phase.summary.szechuan_sauce, 2);
      assert.equal(report.sections.cross_phase.summary.anatomy_park_missing, false);
      assert.equal(report.sections.cross_phase.summary.duplicate_ids_deduped, 0);
      assert.equal(ids.includes('anatomy-park:missing'), false);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('filters malformed phase findings while preserving valid findings', async () => {
    const { repoRoot, base } = makeRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cross-phase-malformed-'));
    try {
      writeArtifact(sessionDir, 'anatomy-park.json', {
        findings: [
          { id: 'valid-anatomy', severity: 'High', message: 'valid anatomy finding' },
          { id: 'missing-severity' },
          { id: 'bad-severity', severity: 'Urgent' },
          { severity: 'Low' },
          null,
        ],
      });
      writeArtifact(sessionDir, 'szechuan-sauce.json', {
        findings: [
          { id: 'valid-szechuan', severity: 'Medium', message: 'valid szechuan finding' },
          ['not', 'an', 'object'],
        ],
      });

      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
      });

      assert.deepEqual(
        report.sections.cross_phase.findings.map((finding) => finding.id),
        ['valid-anatomy', 'valid-szechuan'],
      );
      assert.deepEqual(
        report.sections.cross_phase.findings.map((finding) => finding.source_file),
        ['anatomy-park.json', 'szechuan-sauce.json'],
      );
      assert.equal(report.sections.cross_phase.summary.anatomy_park, 1);
      assert.equal(report.sections.cross_phase.summary.szechuan_sauce, 1);
      assert.equal(report.sections.cross_phase.summary.duplicate_ids_deduped, 0);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  test('promotes newer dead tmp cross-phase artifacts before reading findings', async () => {
    const { repoRoot, base } = makeRepo();
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-cross-phase-artifact-tmp-'));
    try {
      fs.writeFileSync(
        path.join(sessionDir, 'anatomy-park.json.tmp.999999.1'),
        JSON.stringify({
          findings: [
            { id: 'tmp-anatomy', severity: 'High', message: 'recoverable anatomy finding' },
          ],
        }, null, 2),
      );
      fs.writeFileSync(
        path.join(sessionDir, 'szechuan-sauce.json.tmp.999999.2'),
        JSON.stringify({
          findings: [
            { id: 'tmp-szechuan', severity: 'Medium', message: 'recoverable szechuan finding' },
          ],
        }, null, 2),
      );

      const report = await runCitadelAudit({
        prdPath: 'prd.md',
        diffRange: `${base}..HEAD`,
        repoRoot,
        sessionDir,
      });

      assert.deepEqual(
        report.sections.cross_phase.findings.map((finding) => finding.id),
        ['tmp-anatomy', 'tmp-szechuan'],
      );
      assert.equal(report.sections.cross_phase.summary.anatomy_park, 1);
      assert.equal(report.sections.cross_phase.summary.szechuan_sauce, 1);
      assert.equal(report.sections.cross_phase.summary.anatomy_park_missing, false);
      assert.equal(fs.existsSync(path.join(sessionDir, 'anatomy-park.json')), true);
      assert.equal(fs.existsSync(path.join(sessionDir, 'szechuan-sauce.json')), true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
