// @tier: fast
/**
 * audit-ticket-bundle-path-norm.test.js — AC-ATBG-1
 *
 * Regression tests for path-drift normalization parity:
 *   ATB-NORM-1 — real file cited with :line suffix → no path-drift finding
 *   ATB-NORM-2 — bare trailing-slash directory → no path-drift finding
 *   ATB-NORM-3 — glob token → no path-drift finding
 *   ATB-NORM-4 — genuine phantom path → fatal path-drift finding (teeth preserved)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(__dirname, '..', 'bin', 'audit-ticket-bundle.js');

const { checkPathDrift } = await import(BUNDLE);

function makeTicket(id, body) {
  return {
    id,
    title: `Test ticket ${id}`,
    filePath: `/fake/session/${id}/rick_ticket_${id}.md`,
    relPath: `${id}/rick_ticket_${id}.md`,
    mappedRequirements: [],
    body,
    problemSection: '',
    dependenciesLine: '',
  };
}

test('ATB-NORM-1: real file cited with :line suffix produces no path-drift finding', () => {
  const body = `
## Files to modify

- \`extension/src/bin/mux-runner.ts:4754\`
`;
  const gitFiles = new Set(['extension/src/bin/mux-runner.ts']);
  const ticket = makeTicket('aabbccdd', body);
  const findings = checkPathDrift(ticket, gitFiles);
  const pathDrift = findings.filter((f) => f.defect_class === 'path-drift');
  assert.deepStrictEqual(
    pathDrift,
    [],
    `Expected no path-drift for file cited with :line suffix, got: ${JSON.stringify(pathDrift)}`,
  );
});

test('ATB-NORM-2: bare trailing-slash directory produces no path-drift finding', () => {
  const body = `
## Files to modify

- \`extension/tests/\`
`;
  const gitFiles = new Set(); // empty — directory entries not in git ls-files
  const ticket = makeTicket('aabbccdd', body);
  const findings = checkPathDrift(ticket, gitFiles);
  const pathDrift = findings.filter((f) => f.defect_class === 'path-drift');
  assert.deepStrictEqual(
    pathDrift,
    [],
    `Expected no path-drift for bare trailing-slash directory, got: ${JSON.stringify(pathDrift)}`,
  );
});

test('ATB-NORM-3: glob token produces no path-drift finding', () => {
  const body = `
## Files to modify

- \`extension/scripts/*.sh\`
`;
  const gitFiles = new Set(); // empty — no literal glob path in git
  const ticket = makeTicket('aabbccdd', body);
  const findings = checkPathDrift(ticket, gitFiles);
  const pathDrift = findings.filter((f) => f.defect_class === 'path-drift');
  assert.deepStrictEqual(
    pathDrift,
    [],
    `Expected no path-drift for glob token, got: ${JSON.stringify(pathDrift)}`,
  );
});

test('ATB-NORM-4: genuine phantom path still produces fatal path-drift finding', () => {
  const body = `
## Files to modify

- \`extension/src/bin/does-not-exist.ts\`
`;
  const gitFiles = new Set(['extension/src/bin/mux-runner.ts']); // real file, not the phantom
  const ticket = makeTicket('aabbccdd', body);
  const findings = checkPathDrift(ticket, gitFiles);
  const pathDrift = findings.filter((f) => f.defect_class === 'path-drift');
  assert.equal(
    pathDrift.length,
    1,
    `Expected 1 fatal path-drift for genuine phantom, got: ${JSON.stringify(pathDrift)}`,
  );
  assert.equal(pathDrift[0].severity, 'fatal');
  assert.ok(
    pathDrift[0].evidence.includes('does-not-exist.ts'),
    `Expected evidence to name the phantom path, got: ${pathDrift[0].evidence}`,
  );
});
