// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePrdFile, parsePrdMarkdown } from '../services/citadel/prd-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(__dirname, '../../prds/fixtures/citadel/loa-618-prd.md');

describe('parsePrdMarkdown', () => {
  test('extracts T1 Citadel PRD entities from markdown', () => {
    const markdown = readFileSync(fixturePath, 'utf-8');
    const parsed = parsePrdMarkdown(markdown);

    assert.deepEqual(
      parsed.decisions.map((decision) => decision.id),
      ['A1', 'A11', 'A12'],
    );
    assert.deepEqual(
      parsed.acceptanceCriteria.map((criterion) => criterion.id),
      ['AC-FF-01', 'AC-CIT-ABC-9'],
    );
    assert.deepEqual(
      parsed.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
      ['GET /api/runs/{runId}/comparison', 'POST /api/runs/{runId}/retry'],
    );
    assert(parsed.allowlistEntries.some((entry) => entry.kind === 'valid_action' && entry.value === 'retry_child_extraction'));
    assert(parsed.allowlistEntries.some((entry) => entry.kind === 'lender_feature_flag' && entry.name === 'comparison_retry_enabled'));
    assert(parsed.allowlistEntries.some((entry) => entry.kind === 'enum_value' && entry.name === 'RunAction' && entry.value === 'create_updated_run'));
    assert.deepEqual(
      parsed.statusCodeRows.map((row) => [row.endpointMethod, row.endpointPath, row.statusCode, row.errorMessage]),
      [
        ['GET', '/api/runs/{runId}/comparison', 404, 'Comparison not found'],
        ['POST', '/api/runs/{runId}/retry', 409, 'Retry is already running'],
      ],
    );
  });

  test('deduplicates IDs while preserving first-seen order', () => {
    const parsed = parsePrdMarkdown('A2. First\nA2 repeated\nAC-ONE-1 and AC-ONE-1\n');

    assert.deepEqual(parsed.decisions.map((decision) => decision.id), ['A2']);
    assert.deepEqual(parsed.acceptanceCriteria.map((criterion) => criterion.id), ['AC-ONE-1']);
  });
});

describe('parsePrdFile', () => {
  test('loads and parses a PRD fixture from disk', () => {
    const parsed = parsePrdFile(fixturePath);

    assert.equal(parsed.endpoints.length, 2);
    assert.equal(parsed.statusCodeRows.length, 2);
  });
});

// E4: the citadel parser shares the refinement/readiness requirement-id rule. A PRD that defines
// no `AC-*` id is read in the generic `<UPPER>-<n>` form; one that defines any keeps the legacy
// `AC-*` scan byte-for-byte.
describe('E4 shared requirement-id rule', () => {
  test('E4-1: an FR-only PRD yields its defined FR ids as acceptance criteria', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'pickle-e4-prd-parser-'));
    try {
      const prdPath = path.join(dir, 'prd.md');
      writeFileSync(prdPath, '# PRD\n\n- FR-1 first\n- **FR-2** second\nprose citing FR-9 mid-sentence\n');

      const parsed = parsePrdFile(prdPath);

      assert.ok(parsed.acceptanceCriteria.length >= 1);
      assert.deepEqual(parsed.acceptanceCriteria.map((criterion) => criterion.id), ['FR-1', 'FR-2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('E4-2: an AC-* PRD keeps the legacy scan — cited AC ids and FR-looking leads are unchanged', () => {
    const parsed = parsePrdMarkdown('- AC-1 first\n- FR-7 not a criterion here\nsee AC-OTHER-2 cited\n');

    assert.deepEqual(parsed.acceptanceCriteria.map((criterion) => criterion.id), ['AC-1', 'AC-OTHER-2']);
  });

  test('E4-3: self-hosting control — AC-1/AC-3/AC-DR-1 mentioned only in prose define 0 criteria', () => {
    const parsed = parsePrdMarkdown('The control mentions AC-1 and AC-3 and AC-DR-1 in prose only.\n');

    assert.equal(parsed.acceptanceCriteria.length, 0);
  });
});
