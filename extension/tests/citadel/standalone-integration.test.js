// @tier: fast
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCitadelStandalone } from '../../services/citadel/audit-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const ALL_EXPECTED_SECTIONS = [
  'sibling_auth_preconditions',
  'frontend_prop_drift',
  'ac_shape',
  'rule_set_invariants',
  'diff_hygiene',
  'divergence_reconciliation',
  'cross_phase',
  'ac_coverage',
  'allowlist_dead',
  'state_transitions',
  'trap_door_coverage',
  'endpoint_contract_conformance',
  'schema_registry_drift',
  'test_authenticity',
  'stale_reference',
  'banned_constructs',
  'banned_casts',
  'pattern_conformance',
];

describe('standalone-integration: full surface', () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-standalone-integration-'));
    result = await runCitadelStandalone(
      { workingDir: REPO_ROOT, diffRange: 'HEAD..HEAD' },
      tmpDir,
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('M1 citadel_report.json is written', () => {
    const reportPath = path.join(tmpDir, 'citadel_report.json');
    assert.ok(fs.existsSync(reportPath), 'citadel_report.json must be written');
    const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    assert.strictEqual(parsed.schema, '1.0', 'M1 must have schema: "1.0"');
    assert.ok(Array.isArray(parsed.findings), 'M1 must have findings array');
  });

  test('M2 skeptic_findings.json is written', () => {
    const m2Path = path.join(tmpDir, 'skeptic_findings.json');
    assert.ok(fs.existsSync(m2Path), 'skeptic_findings.json must be written');
    const parsed = JSON.parse(fs.readFileSync(m2Path, 'utf-8'));
    assert.ok(Array.isArray(parsed.findings), 'M2 must have findings array');
  });

  test('pattern_conformance section is present in M1', () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(result.sections, 'pattern_conformance'),
      'pattern_conformance section must be present in citadel_report',
    );
  });

  test('all expected section keys present in M1', () => {
    const missing = ALL_EXPECTED_SECTIONS.filter(
      (k) => !Object.prototype.hasOwnProperty.call(result.sections, k),
    );
    assert.deepStrictEqual(missing, [], `Missing sections: ${missing.join(', ')}`);
  });

  test('M2 findings are NOT in the M1 remediable set (report-only invariant)', () => {
    // skeptic_findings.json is written separately and must never appear as a section in M1
    assert.ok(
      !Object.prototype.hasOwnProperty.call(result.sections, 'skeptic_findings'),
      'skeptic_findings must NOT be a section in citadel_report (M2 is report-only)',
    );
  });

  test('standalone result has correct exit_code shape', () => {
    assert.ok(typeof result.exit_code === 'number', 'result.exit_code must be numeric');
    assert.strictEqual(result.schema, '1.0');
  });
});
