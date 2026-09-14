// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapBaselineMeasureExitReason } from '../bin/microverse-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const runnerSourcePath = path.join(extensionRoot, 'src', 'bin', 'microverse-runner.ts');

function readRunnerSource() {
  return fs.readFileSync(runnerSourcePath, 'utf8');
}

test('aggregator 3-way mapping source uses switch over measured.exitReason', () => {
  const source = readRunnerSource();
  assert.match(source, /switch\s*\(\s*measured\.exitReason\s*\)/);
  assert.doesNotMatch(
    source,
    /const exitReason: ExitReason = measured\.exitReason === 'judge_cli_missing'[\s\S]*?: 'baseline_unmeasurable';/,
  );
});

test('aggregator 3-way mapping', () => {
  assert.equal(mapBaselineMeasureExitReason('judge_cli_missing'), 'judge_cli_missing');
  assert.equal(mapBaselineMeasureExitReason('judge_timeout'), 'judge_timeout');
  assert.equal(mapBaselineMeasureExitReason('failed'), 'metric_unmeasurable_unrecoverable');
});
