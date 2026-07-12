#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRecoverableJsonObject } from '../extension/services/recoverable-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

export const BUNDLE_ARTIFACT_SCHEMA = Object.freeze({
  required: Object.freeze([
    'ac_id',
    'pass',
    'checked_at',
    'checker',
    'checker_version',
    'evidence',
    'failure_reason',
    'remediation_hint',
  ]),
});

// AC-DR-03 (24h soak), AC-DR-07 (1h soak), and AC-DR-15 (PRE-FLIGHT) are absent by
// contract, not by omission: AC-STRIP-10 stripped them and the refined PRD marks each
// `status: removed` with artifact `n/a`. A removed AC has no artifact to demand.
export const EXPECTED_BUNDLE_AC_IDS = Object.freeze([
  'AC-DR-01', 'AC-DR-02', 'AC-DR-04a', 'AC-DR-04b',
  'AC-DR-04c', 'AC-DR-04d', 'AC-DR-06',
  'AC-DR-08', 'AC-DR-09', 'AC-DR-10', 'AC-DR-11', 'AC-DR-12',
  'AC-DR-13', 'AC-DR-14', 'AC-DR-16',
]);

function acIdToFileName(acId) {
  return `${acId.toLowerCase()}.json`;
}

function artifactPath(repoRoot, acId) {
  return path.join(repoRoot, 'bundle', acIdToFileName(acId));
}

function isKnownBundleArtifactAcId(acId) {
  return EXPECTED_BUNDLE_AC_IDS.includes(acId);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCanonicalUtcIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString() === value;
}

export function validateBundleArtifact(artifact) {
  const errors = [];
  if (!isObject(artifact)) return ['artifact must be an object'];
  for (const field of BUNDLE_ARTIFACT_SCHEMA.required) {
    if (!(field in artifact)) errors.push(`missing required field: ${field}`);
  }
  if ('ac_id' in artifact && typeof artifact.ac_id !== 'string') errors.push('ac_id must be a string');
  if ('pass' in artifact && typeof artifact.pass !== 'boolean') errors.push('pass must be a boolean');
  if ('checked_at' in artifact && !isCanonicalUtcIsoTimestamp(artifact.checked_at)) {
    errors.push('checked_at must be a canonical UTC ISO date string');
  }
  if ('checker' in artifact && typeof artifact.checker !== 'string') errors.push('checker must be a string');
  if ('checker_version' in artifact && typeof artifact.checker_version !== 'string') {
    errors.push('checker_version must be a string');
  }
  if ('evidence' in artifact && !isObject(artifact.evidence)) errors.push('evidence must be an object');
  for (const field of ['failure_reason', 'remediation_hint']) {
    if (field in artifact && artifact[field] !== null && typeof artifact[field] !== 'string') {
      errors.push(`${field} must be a string or null`);
    }
  }
  return errors;
}

export function verifyBundle(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const requestedAcId = options.ac ?? null;
  if (requestedAcId && !isKnownBundleArtifactAcId(requestedAcId)) {
    return {
      exitCode: 2,
      stdout: 'bundle INCONCLUSIVE checked=0 missing=0 failures=0\n',
      stderr: `verify-bundle: unknown AC id ${requestedAcId}\n`,
    };
  }
  const expectedIds = requestedAcId ? [requestedAcId] : [...EXPECTED_BUNDLE_AC_IDS];
  const failures = [];
  const missing = [];

  for (const acId of expectedIds) {
    const filePath = artifactPath(repoRoot, acId);
    const recoveredArtifact = readRecoverableJsonObject(filePath);
    if (!fs.existsSync(filePath) && !recoveredArtifact) {
      missing.push(`${acId}: missing ${path.relative(repoRoot, filePath)}`);
      continue;
    }
    try {
      const artifact = recoveredArtifact ?? JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const errors = validateBundleArtifact(artifact);
      if (artifact.ac_id !== acId) errors.push(`ac_id must equal ${acId}`);
      if (errors.length > 0) failures.push(`${acId}: ${errors.join('; ')}`);
      if (artifact.pass === false) {
        failures.push(`${acId}: pass false${artifact.failure_reason ? ` (${artifact.failure_reason})` : ''}`);
      }
    } catch (err) {
      failures.push(`${acId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const exitCode = missing.length > 0 ? 2 : failures.length > 0 ? 1 : 0;
  return {
    exitCode,
    stdout: `bundle ${exitCode === 0 ? 'PASS' : exitCode === 1 ? 'FAIL' : 'INCONCLUSIVE'} checked=${expectedIds.length} missing=${missing.length} failures=${failures.length}\n`,
    stderr: [...missing, ...failures].map((line) => `verify-bundle: ${line}\n`).join(''),
  };
}

function parseArgs(argv) {
  if (argv.length === 0) return {};
  if (argv.length === 2 && argv[0] === '--ac') return { ac: argv[1] };
  throw new Error('usage: bin/verify-bundle.js [--ac <id>]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(DEFAULT_REPO_ROOT, 'bin', 'verify-bundle.js')) {
  try {
    const result = verifyBundle({
      repoRoot: process.env.BUNDLE_REPO_ROOT ?? DEFAULT_REPO_ROOT,
      ...parseArgs(process.argv.slice(2)),
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}
