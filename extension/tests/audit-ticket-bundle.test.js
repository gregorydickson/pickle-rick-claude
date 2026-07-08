// @tier: fast
/**
 * audit-ticket-bundle.test.js — AC-TAQ-02-2
 *
 * Asserts checkPathDrift's basic path-drift contract:
 *   ATB-02 — path under "## Files to modify" not in git → path-drift finding
 *   ATB-03 — path under "## Files to modify" present in git → no finding
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

test('ATB-02: path under ## Files to modify not in git produces path-drift finding', () => {
  const body = `
## Implementation Details

### Files to modify

- \`extension/src/bin/mux-runner.ts\`
`;
  const gitFiles = new Set(); // empty — nothing in git
  const ticket = makeTicket('aabbccdd', body);
  const findings = checkPathDrift(ticket, gitFiles);
  const pathDrift = findings.filter((f) => f.defect_class === 'path-drift');
  assert.equal(
    pathDrift.length,
    1,
    `Expected 1 path-drift finding for missing ## Files to modify path, got: ${JSON.stringify(pathDrift)}`,
  );
  assert.ok(
    pathDrift[0].evidence.includes('extension/src/bin/mux-runner.ts'),
    `Expected evidence to mention the missing path, got: ${pathDrift[0].evidence}`,
  );
});

test('ATB-03: path under ## Files to modify present in git produces no finding', () => {
  const body = `
## Implementation Details

### Files to modify

- \`extension/src/bin/mux-runner.ts\`
`;
  const gitFiles = new Set(['extension/src/bin/mux-runner.ts']);
  const ticket = makeTicket('aabbccdd', body);
  const findings = checkPathDrift(ticket, gitFiles);
  const pathDrift = findings.filter((f) => f.defect_class === 'path-drift');
  assert.deepStrictEqual(pathDrift, [], `Expected no path-drift when path is in git, got: ${JSON.stringify(pathDrift)}`);
});
