// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeEach } from '../helpers/describe-each.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '../..');
const LEDGER_PATH = path.join(EXTENSION_ROOT, 'bundle', 'bundle_ac_ledger.json');
const SECTIONS = Object.freeze([
  ['A', 'prds/p1-strip-excessive-defense-deploy-reversion.md'],
  ['B', 'prds/multi-repo-task-state-drift.md'],
  ['C', 'prds/tool-error-retry-tracking.md'],
  ['D', 'prds/smart-iteration-handoff.md'],
  ['E', 'prds/hermes-integration.md'],
  ['F', 'prds/god-functions-remediation-phase-2.md'],
]);

function readLedger() {
  return JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
}

function findSectionEntry(ledger, section, sourcePrd) {
  return ledger.find((entry) => (
    entry.section === section && entry.source_prd === sourcePrd
  ));
}

describeEach(SECTIONS)('Section %s source PRD ACs', (section, sourcePrd) => {
  test('report all ACs green in the rollup ledger', () => {
    const ledger = readLedger();
    const entry = findSectionEntry(ledger, section, sourcePrd);

    assert.ok(entry, `missing ledger entry for Section ${section}`);
    assert.equal(entry.all_acs_green, true);
  });
});
