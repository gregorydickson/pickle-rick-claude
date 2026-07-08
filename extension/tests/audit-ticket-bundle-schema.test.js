// @tier: fast
/**
 * audit-ticket-bundle-schema.test.js — R-TAQ-2b
 *
 * Validates extension/src/types/audit-ticket-bundle.schema.json:
 *   ABS-1 — schema file exists and schema_version === 1
 *   ABS-2 — clean fixture (zero findings) passes structural validation
 *   ABS-3 — defective fixture (missing required field) fails structural validation
 *   ABS-4 — fixture with one finding of each severity passes structural validation
 *   ABS-5 — fixture with invalid defect_class fails structural validation
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '..', 'src', 'types', 'audit-ticket-bundle.schema.json');

const VALID_DEFECT_CLASSES = new Set([
  'path-drift',
  'self-reference',
  'missing-deps',
  'wrong-HEAD-assumptions',
  'cross-doc-naming',
  'cross-doc-naming-drift',
  'hallucinated-premise',
  'literal-value-drift',
]);

const VALID_SEVERITIES = new Set(['fatal', 'warning', 'info']);
const VALID_EXIT_CODES = new Set([0, 1, 2]);
const TICKET_HASH_RE = /^[0-9a-f]{8}$/;

function validateManifest(manifest) {
  const errors = [];

  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return ['root must be an object'];
  }

  const required = ['schema_version', 'session_hash', 'audited_at', 'ticket_count', 'findings', 'exit_code'];
  for (const key of required) {
    if (!(key in manifest)) errors.push(`missing required field: ${key}`);
  }
  if (errors.length > 0) return errors;

  if (manifest.schema_version !== 1) errors.push(`schema_version must be 1, got ${manifest.schema_version}`);
  if (typeof manifest.session_hash !== 'string' || manifest.session_hash.length === 0) {
    errors.push('session_hash must be a non-empty string');
  }
  if (typeof manifest.audited_at !== 'string' || isNaN(Date.parse(manifest.audited_at))) {
    errors.push('audited_at must be an ISO date-time string');
  }
  if (!Number.isInteger(manifest.ticket_count) || manifest.ticket_count < 0) {
    errors.push('ticket_count must be a non-negative integer');
  }
  if (!Array.isArray(manifest.findings)) {
    errors.push('findings must be an array');
  } else {
    for (let i = 0; i < manifest.findings.length; i++) {
      const f = manifest.findings[i];
      if (typeof f !== 'object' || f === null) {
        errors.push(`findings[${i}] must be an object`);
        continue;
      }
      for (const key of ['ticket_id', 'ticket_path', 'defect_class', 'severity', 'evidence', 'remediation_hint']) {
        if (!(key in f)) errors.push(`findings[${i}] missing required field: ${key}`);
      }
      if ('ticket_id' in f && !TICKET_HASH_RE.test(f.ticket_id)) {
        errors.push(`findings[${i}].ticket_id must be 8 hex chars, got ${f.ticket_id}`);
      }
      if ('defect_class' in f && !VALID_DEFECT_CLASSES.has(f.defect_class)) {
        errors.push(`findings[${i}].defect_class invalid: ${f.defect_class}`);
      }
      if ('severity' in f && !VALID_SEVERITIES.has(f.severity)) {
        errors.push(`findings[${i}].severity invalid: ${f.severity}`);
      }
    }
  }
  if (!VALID_EXIT_CODES.has(manifest.exit_code)) {
    errors.push(`exit_code must be 0, 1, or 2, got ${manifest.exit_code}`);
  }

  return errors;
}

const CLEAN_FIXTURE = {
  schema_version: 1,
  session_hash: '2026-05-04-f416c6cc',
  audited_at: '2026-05-04T12:00:00.000Z',
  ticket_count: 3,
  findings: [],
  exit_code: 0,
};

const ALL_SEVERITY_FIXTURE = {
  schema_version: 1,
  session_hash: '2026-05-04-f416c6cc',
  audited_at: '2026-05-04T12:00:00.000Z',
  ticket_count: 3,
  findings: [
    {
      ticket_id: 'aabbccdd',
      ticket_path: 'aabbccdd/rick_ticket_aabbccdd.md',
      defect_class: 'path-drift',
      severity: 'fatal',
      evidence: 'cited path `extension/src/missing.ts` not found in git ls-files',
      remediation_hint: 'verify path or annotate per R-RTRC-7 (`(forward-created)` or `(created|introduced) by ticket <hash>`)',
    },
    {
      ticket_id: '11223344',
      ticket_path: '11223344/rick_ticket_11223344.md',
      defect_class: 'literal-value-drift',
      severity: 'info',
      evidence: 'version literal(s) ["1.60.0"] differ from package.json version `1.69.0`',
      remediation_hint: 'update cited version or confirm the literal references a different artifact',
    },
    {
      ticket_id: 'deadbeef',
      ticket_path: 'deadbeef/rick_ticket_deadbeef.md',
      defect_class: 'self-reference',
      severity: 'warning',
      evidence: 'body cites own hash in: `deadbeef`',
      remediation_hint: 'remove self-reference or rephrase without ticket hash',
    },
  ],
  exit_code: 1,
};

test('ABS-1: schema file exists and schema_version === 1', () => {
  assert.ok(existsSync(SCHEMA_PATH), `schema file missing: ${SCHEMA_PATH}`);
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  assert.equal(schema.schema_version, 1);
  assert.equal(schema.title, 'AuditTicketBundleManifest');
});

test('ABS-2: clean fixture (zero findings) passes structural validation', () => {
  const errors = validateManifest(CLEAN_FIXTURE);
  assert.deepStrictEqual(errors, [], `Unexpected errors: ${errors.join('; ')}`);
});

test('ABS-3: defective fixture missing required field fails validation', () => {
  const defective = { ...CLEAN_FIXTURE };
  delete defective.session_hash;
  const errors = validateManifest(defective);
  assert.ok(errors.some((e) => e.includes('session_hash')), `Expected session_hash error, got: ${errors}`);
});

test('ABS-4: fixture with one finding of each severity passes validation', () => {
  const errors = validateManifest(ALL_SEVERITY_FIXTURE);
  assert.deepStrictEqual(errors, [], `Unexpected errors: ${errors.join('; ')}`);
});

test('ABS-5: fixture with invalid defect_class fails validation', () => {
  const bad = {
    ...CLEAN_FIXTURE,
    findings: [
      {
        ticket_id: 'aabbccdd',
        ticket_path: 'aabbccdd/rick_ticket_aabbccdd.md',
        defect_class: 'not-a-real-class',
        severity: 'fatal',
        evidence: 'test evidence',
        remediation_hint: 'test hint',
      },
    ],
    exit_code: 1,
  };
  const errors = validateManifest(bad);
  assert.ok(
    errors.some((e) => e.includes('defect_class')),
    `Expected defect_class error, got: ${errors}`,
  );
});
