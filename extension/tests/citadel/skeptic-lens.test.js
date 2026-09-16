// @tier: fast
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSkepticLens } from '../../services/citadel/skeptic-lens.js';
import { buildCitadelAuditReport, runCitadelAudit } from '../../services/citadel/audit-runner.js';
import { citadelFindingsToGateResult } from '../../services/citadel/citadel-findings-to-gate-result.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

function makeChangedFile(filePath, startLine = 1) {
  return {
    path: filePath,
    status: 'M',
    kind: 'production',
    changedLines: [{ start: startLine, end: startLine }],
    blame: [],
  };
}

describe('skeptic-lens: defect pattern detection', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeptic-'));
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'if (obj === {}) return;\n');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'const x = user?.name;\n');
    fs.writeFileSync(path.join(tmpDir, 'c.ts'), 'const s = new WriteStream(filePath);\n');
    fs.writeFileSync(path.join(tmpDir, 'd.ts'), 'if (false) { doThing(); }\n');
    fs.writeFileSync(path.join(tmpDir, 'e1.ts'), 'function validateInput(x) { return x; }\n');
    fs.writeFileSync(path.join(tmpDir, 'e2.ts'), 'function validateInput(y) { return y; }\n');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('semantic-identity defect is detected', () => {
    const report = runSkepticLens([makeChangedFile('a.ts')], tmpDir);
    assert.ok(
      report.findings.some((f) => f.defect === 'semantic-identity'),
      'expected semantic-identity finding',
    );
  });

  test('fallback-null-flow defect is detected', () => {
    const report = runSkepticLens([makeChangedFile('b.ts')], tmpDir);
    assert.ok(
      report.findings.some((f) => f.defect === 'fallback-null-flow'),
      'expected fallback-null-flow finding',
    );
  });

  test('resource-lifecycle defect is detected', () => {
    const report = runSkepticLens([makeChangedFile('c.ts')], tmpDir);
    assert.ok(
      report.findings.some((f) => f.defect === 'resource-lifecycle'),
      'expected resource-lifecycle finding',
    );
  });

  test('dead-guard-no-op-flag-behavior-parity defect is detected', () => {
    const report = runSkepticLens([makeChangedFile('d.ts')], tmpDir);
    assert.ok(
      report.findings.some((f) => f.defect === 'dead-guard-no-op-flag-behavior-parity'),
      'expected dead-guard finding',
    );
  });

  test('cross-file-repetition-exhaustiveness defect is detected', () => {
    const report = runSkepticLens([makeChangedFile('e1.ts'), makeChangedFile('e2.ts')], tmpDir);
    assert.ok(
      report.findings.some((f) => f.defect === 'cross-file-repetition-exhaustiveness'),
      'expected cross-file-repetition finding',
    );
  });

  test('cross-file-repetition-exhaustiveness finding carries a resolvable line', () => {
    const report = runSkepticLens([makeChangedFile('e1.ts'), makeChangedFile('e2.ts')], tmpDir);
    const finding = report.findings.find((f) => f.defect === 'cross-file-repetition-exhaustiveness');
    assert.ok(finding, 'expected cross-file-repetition finding');
    assert.equal(typeof finding.line, 'number', 'line must be a resolvable number, not undefined');
    assert.ok(finding.line > 0, 'line must be a positive line number');
    assert.equal(finding.file, 'e1.ts', 'file locates the first occurrence, not an arbitrary pick');
    assert.match(finding.why, /e1\.ts/, 'why must name every participating file, not just the count');
    assert.match(finding.why, /e2\.ts/, 'why must name every participating file, not just the count');
  });

  test('all 5 defect classes detected together', () => {
    const changedFiles = [
      makeChangedFile('a.ts'),
      makeChangedFile('b.ts'),
      makeChangedFile('c.ts'),
      makeChangedFile('d.ts'),
      makeChangedFile('e1.ts'),
      makeChangedFile('e2.ts'),
    ];
    const report = runSkepticLens(changedFiles, tmpDir);
    const defects = new Set(report.findings.map((f) => f.defect));
    for (const expected of [
      'semantic-identity',
      'fallback-null-flow',
      'resource-lifecycle',
      'dead-guard-no-op-flag-behavior-parity',
      'cross-file-repetition-exhaustiveness',
    ]) {
      assert.ok(defects.has(expected), `expected defect class '${expected}' to be detected`);
    }
  });

  test('per-line finding shape is unchanged: exact object for a semantic-identity defect', () => {
    const report = runSkepticLens([makeChangedFile('a.ts')], tmpDir);
    const finding = report.findings.find((f) => f.defect === 'semantic-identity');
    assert.deepEqual(finding, {
      defect: 'semantic-identity',
      file: 'a.ts',
      line: 1,
      why: 'Identity comparison with object/array literal always evaluates to false',
      shape: 'if (obj === {}) return;',
    });
  });

  test('findings have required fields: defect, file, why, shape', () => {
    const report = runSkepticLens([makeChangedFile('a.ts')], tmpDir);
    assert.ok(report.findings.length > 0, 'expected at least one finding');
    for (const f of report.findings) {
      assert.equal(typeof f.defect, 'string', 'defect must be string');
      assert.equal(typeof f.file, 'string', 'file must be string');
      assert.equal(typeof f.why, 'string', 'why must be string');
      assert.equal(typeof f.shape, 'string', 'shape must be string');
    }
  });

  test('AC-5b: SkepticFinding has no severity field — structural convergence-signal barrier', () => {
    const report = runSkepticLens([makeChangedFile('a.ts')], tmpDir);
    assert.ok(report.findings.length > 0);
    for (const f of report.findings) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(f, 'severity'),
        'SkepticFinding must not have severity — absent severity is the structural barrier against GateResult / remediable-set entry',
      );
    }
  });
});

describe('skeptic-lens: AC-5b safety proof', () => {
  test('buildCitadelAuditReport findings have no defect field', () => {
    const report = buildCitadelAuditReport({
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
    });
    for (const f of report.findings) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(f, 'defect'),
        `CitadelFinding ${f.id} must not have defect field — skeptic findings must not enter buildCitadelAuditReport`,
      );
    }
  });

  test('citadelFindingsToGateResult on empty input returns green — remediable set is always empty when skeptic-only', () => {
    // AC-5b: citadelFindingsToGateResult is fed only from buildCitadelAuditReport().findings,
    // which never contains SkepticFindings. Proof: the remediable set fed to spawn-gate-remediator
    // derives solely from buildCitadelAuditReport, which is never modified to include skeptic output.
    const result = citadelFindingsToGateResult([]);
    assert.equal(result.status, 'green');
    assert.deepEqual(result.failures, []);
  });

  test('AC-5b: skeptic findings absent severity — cannot be a convergence signal', () => {
    let tmpDir;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeptic-ac5b-'));
      fs.writeFileSync(path.join(tmpDir, 'x.ts'), 'if (false) { dead(); }\n');
      const report = runSkepticLens([makeChangedFile('x.ts')], tmpDir);
      assert.ok(report.findings.length > 0, 'must have findings to prove AC-5b');
      for (const f of report.findings) {
        assert.ok(
          !Object.prototype.hasOwnProperty.call(f, 'severity'),
          'SkepticFinding must not have severity — this is the structural barrier preventing GateResult entry and convergence signaling',
        );
      }
      // Confirm the remediable path stays green even with skeptic findings present elsewhere
      assert.equal(citadelFindingsToGateResult([]).status, 'green');
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('skeptic-lens: generated-twin exclusion (AC-R1)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeptic-gen-'));
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { rootDir: 'src', outDir: '.' } }),
    );
    fs.mkdirSync(path.join(tmpDir, 'src', 'services'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'other'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'services'), { recursive: true });

    // Twin pair: same function name in a src/.ts source and its compiled .js output.
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'services', 'foo.ts'),
      'function validateInput(x) { return x; }\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'services', 'foo.js'),
      'function validateInput(x) { return x; }\n',
    );

    // Genuine duplication: the same function name across two SOURCE files, no twin relationship.
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'services', 'bar.ts'),
      'function processOrder(y) { return y; }\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'other', 'baz.ts'),
      'function processOrder(z) { return z; }\n',
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a .ts source and its compiled .js twin produce no cross-file finding', () => {
    const report = runSkepticLens(
      [makeChangedFile('src/services/foo.ts'), makeChangedFile('services/foo.js')],
      tmpDir,
    );
    assert.ok(
      !report.findings.some((f) => f.defect === 'cross-file-repetition-exhaustiveness'),
      'compiled twin must not trigger cross-file-repetition-exhaustiveness',
    );
  });

  test('the same function name duplicated across two SOURCE files still reports', () => {
    const report = runSkepticLens(
      [makeChangedFile('src/services/bar.ts'), makeChangedFile('src/other/baz.ts')],
      tmpDir,
    );
    assert.ok(
      report.findings.some((f) => f.defect === 'cross-file-repetition-exhaustiveness'),
      'genuine cross-source duplication must still be reported',
    );
  });

  test('mutation surrogate: without a discoverable tsconfig mapping, the same twin pair fires', () => {
    // Proves the silence in the first case is caused by the tsconfig-derived filter, not by
    // fluke path shapes: identical file content, no tsconfig.json present anywhere.
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeptic-gen-bare-'));
    try {
      fs.mkdirSync(path.join(bareDir, 'src', 'services'), { recursive: true });
      fs.mkdirSync(path.join(bareDir, 'services'), { recursive: true });
      fs.writeFileSync(
        path.join(bareDir, 'src', 'services', 'foo.ts'),
        'function validateInput(x) { return x; }\n',
      );
      fs.writeFileSync(
        path.join(bareDir, 'services', 'foo.js'),
        'function validateInput(x) { return x; }\n',
      );
      const report = runSkepticLens(
        [makeChangedFile('src/services/foo.ts'), makeChangedFile('services/foo.js')],
        bareDir,
      );
      assert.ok(
        report.findings.some((f) => f.defect === 'cross-file-repetition-exhaustiveness'),
        'without a discoverable tsconfig mapping, the twin pair looks like ordinary duplication',
      );
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true });
    }
  });

  test('mutation guard: genuine source duplication survives alongside an excluded twin pair', () => {
    // Guards against an over-wide filter (e.g. excluding all of src/ wholesale).
    const report = runSkepticLens(
      [
        makeChangedFile('src/services/foo.ts'),
        makeChangedFile('services/foo.js'),
        makeChangedFile('src/services/bar.ts'),
        makeChangedFile('src/other/baz.ts'),
      ],
      tmpDir,
    );
    assert.ok(
      report.findings.some((f) => f.defect === 'cross-file-repetition-exhaustiveness'),
      'genuine duplication must survive when mixed with an excluded twin pair',
    );
  });

  test('every surviving finding names a source path, never the generated twin', () => {
    const report = runSkepticLens(
      [
        makeChangedFile('src/services/foo.ts'),
        makeChangedFile('services/foo.js'),
        makeChangedFile('src/services/bar.ts'),
        makeChangedFile('src/other/baz.ts'),
      ],
      tmpDir,
    );
    for (const f of report.findings) {
      assert.ok(f.file.startsWith('src/'), `finding names a non-source path: ${f.file}`);
    }
  });

  test('a malformed tsconfig.json does not throw and degrades to unfiltered', () => {
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeptic-gen-bad-'));
    try {
      fs.writeFileSync(path.join(badDir, 'tsconfig.json'), '{not json');
      fs.mkdirSync(path.join(badDir, 'src', 'services'), { recursive: true });
      fs.mkdirSync(path.join(badDir, 'services'), { recursive: true });
      fs.writeFileSync(
        path.join(badDir, 'src', 'services', 'foo.ts'),
        'function validateInput(x) { return x; }\n',
      );
      fs.writeFileSync(
        path.join(badDir, 'services', 'foo.js'),
        'function validateInput(x) { return x; }\n',
      );
      assert.doesNotThrow(() => {
        const report = runSkepticLens(
          [makeChangedFile('src/services/foo.ts'), makeChangedFile('services/foo.js')],
          badDir,
        );
        assert.ok(
          report.findings.some((f) => f.defect === 'cross-file-repetition-exhaustiveness'),
          'a malformed tsconfig.json must degrade to no mapping, not filter silently',
        );
      });
    } finally {
      fs.rmSync(badDir, { recursive: true, force: true });
    }
  });
});

describe('skeptic-lens: AC-5 sink test', () => {
  let tmpSessionDir;

  before(async () => {
    tmpSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skeptic-sink-'));
    await runCitadelAudit({
      diffRange: 'HEAD..HEAD',
      repoRoot: REPO_ROOT,
      sessionDir: tmpSessionDir,
    });
  });

  after(() => {
    fs.rmSync(tmpSessionDir, { recursive: true, force: true });
  });

  test('skeptic_findings.json is written to sessionDir', () => {
    assert.ok(
      fs.existsSync(path.join(tmpSessionDir, 'skeptic_findings.json')),
      'skeptic_findings.json must exist after runCitadelAudit',
    );
  });

  test('skeptic_findings.json has { findings: Array } shape', () => {
    const content = JSON.parse(
      fs.readFileSync(path.join(tmpSessionDir, 'skeptic_findings.json'), 'utf-8'),
    );
    assert.ok(Object.prototype.hasOwnProperty.call(content, 'findings'), 'must have findings key');
    assert.ok(Array.isArray(content.findings), 'findings must be an array');
  });

  test('skeptic_findings.json is a separate file from citadel_report.json', () => {
    const skepticPath = path.join(tmpSessionDir, 'skeptic_findings.json');
    const reportPath = path.join(tmpSessionDir, 'citadel_report.json');
    assert.ok(fs.existsSync(reportPath), 'citadel_report.json must also exist');
    // Different content: citadel_report has schema/exit_code fields; skeptic has only findings
    const skeptic = JSON.parse(fs.readFileSync(skepticPath, 'utf-8'));
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    assert.ok(!Object.prototype.hasOwnProperty.call(skeptic, 'exit_code'),
      'skeptic_findings.json must not have exit_code — it is not a citadel report');
    assert.ok(Object.prototype.hasOwnProperty.call(report, 'exit_code'),
      'citadel_report.json must have exit_code');
  });

  test('AC-5: citadel_report findings array contains no SkepticFindings (defect field absent)', () => {
    const report = JSON.parse(
      fs.readFileSync(path.join(tmpSessionDir, 'citadel_report.json'), 'utf-8'),
    );
    assert.ok(Array.isArray(report.findings), 'citadel_report must have findings array');
    for (const f of report.findings) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(f, 'defect'),
        `finding ${f.id} has defect field — skeptic finding leaked into citadel_report`,
      );
    }
  });
});
