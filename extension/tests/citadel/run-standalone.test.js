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

describe('runCitadelStandalone', () => {
  let tmpDir;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-standalone-'));
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes citadel_report.json with correct shape', async () => {
    const result = await runCitadelStandalone(
      { workingDir: REPO_ROOT, diffRange: 'HEAD..HEAD' },
      tmpDir,
    );

    const reportPath = path.join(tmpDir, 'citadel_report.json');
    assert.ok(fs.existsSync(reportPath), 'citadel_report.json must be written');

    const raw = fs.readFileSync(reportPath, 'utf-8');
    const parsed = JSON.parse(raw);

    assert.strictEqual(parsed.schema, '1.0', 'report must have schema: "1.0"');
    assert.ok(parsed.sections && typeof parsed.sections === 'object', 'report must have sections');
    assert.ok(Array.isArray(parsed.findings), 'report must have findings array');
    assert.ok(typeof parsed.exit_code === 'number', 'report must have numeric exit_code');

    assert.strictEqual(result.schema, '1.0');
  });

  test('all expected section keys present in standalone run', async () => {
    const result = await runCitadelStandalone(
      { workingDir: REPO_ROOT, diffRange: 'HEAD..HEAD' },
      tmpDir,
    );

    const EXPECTED_SECTIONS = [
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

    const missing = EXPECTED_SECTIONS.filter(
      (k) => !Object.prototype.hasOwnProperty.call(result.sections, k),
    );
    assert.deepStrictEqual(missing, [], `Missing sections: ${missing.join(', ')}`);
  });

  test('no state.json required — succeeds without one in workingDir', async () => {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-no-state-'));
    try {
      // no state.json in isolatedDir; standalone must not throw
      const result = await runCitadelStandalone(
        { workingDir: REPO_ROOT, diffRange: 'HEAD..HEAD' },
        isolatedDir,
      );
      assert.ok(result, 'result must be returned without state.json in outputDir');
    } finally {
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
  });

  test('PRD-dependent sections skipped with no_prd when no prdPath', async () => {
    const result = await runCitadelStandalone(
      { workingDir: REPO_ROOT, diffRange: 'HEAD..HEAD' },
      tmpDir,
    );

    // PRD-dependent sections must be skipped with 'no_prd' reason
    const skippedSections = ['ac_coverage', 'state_transitions', 'endpoint_contract_conformance'];
    for (const key of skippedSections) {
      const section = result.sections[key];
      assert.ok(section, `section ${key} must be present`);
      assert.strictEqual(section.skipped, 'no_prd', `section ${key} must have skipped: 'no_prd'`);
    }
  });
});
