// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(EXTENSION_ROOT, 'tests', 'behavioral', 'phase-personas', 'baseline.json');

test('phase persona feature flag baseline exists and is strong enough to flip on', () => {
  assert.ok(fs.existsSync(BASELINE_PATH), 'baseline.json must be committed before enabling phase personas');

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
  assert.equal(baseline.feature, 'phase-personas');
  assert.equal(baseline.flag, 'PICKLE_PHASE_PERSONAS');
  assert.equal(baseline.default, 'off');
  assert.equal(baseline.enabledValue, 'on');
  assert.equal(baseline.personas.length, 6);
  assert.ok(baseline.minDistinctness >= 0.30, 'baseline must meet the PRD 30% Jaccard distinctness threshold');
  assert.ok(baseline.measuredDistinctness >= baseline.minDistinctness);
  assert.ok(baseline.pairwiseDistinctness.every((entry) => entry.distinctness >= baseline.minDistinctness));
});
