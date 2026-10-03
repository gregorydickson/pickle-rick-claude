// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALIBRATION_SUITES,
  checkCalibrationDrift,
  calibrationBaselinePath,
  loadCalibrationThresholdPct,
} from '../services/calibration-corpus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const EXPECTED_TRIGGERS = {
  readiness: 'extension/src/bin/check-readiness.ts heuristic or fixture changes',
  'correct-course': 'extension/src/bin/correct-course.ts proposal validator changes',
};

test('calibration baselines are versioned and governed by recalibration triggers', () => {
  for (const suite of CALIBRATION_SUITES) {
    const baselinePath = calibrationBaselinePath(EXTENSION_ROOT, suite);
    assert.ok(fs.existsSync(baselinePath), `${suite} baseline.json must exist`);
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));

    assert.equal(baseline.schema_version, 1);
    assert.equal(baseline.suite, suite);
    assert.equal(baseline.generator.command, `npm run calibrate:${suite}`);
    assert.equal(baseline.threshold_pct, loadCalibrationThresholdPct(EXTENSION_ROOT));
    assert.ok(baseline.recalibration_triggers.includes(EXPECTED_TRIGGERS[suite]));
    assert.ok(Object.keys(baseline.metrics).length > 0);
    assert.ok(baseline.fixture_results.length > 0);
  }
});

test('calibration baseline drift stays within configured threshold', () => {
  for (const suite of CALIBRATION_SUITES) {
    const report = checkCalibrationDrift(EXTENSION_ROOT, suite);
    assert.equal(report.thresholdPct, 5);
    assert.ok(
      report.passed,
      `${suite} drift ${report.maxDriftPct}% exceeded ${report.thresholdPct}%: ${JSON.stringify(report.entries)}`,
    );
  }
});
