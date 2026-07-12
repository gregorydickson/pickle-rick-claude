// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLE_ARTIFACT_SCHEMA,
  EXPECTED_BUNDLE_AC_IDS,
  verifyBundle,
} from '../../bin/verify-bundle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'verify-bundle.js');
const REFINED_PRD = path.join(
  REPO_ROOT,
  'prds/archive/bundles/p2-bundle-deploy-reversion-and-gate-baseline-diagnostic.md',
);
// The live (non-stripped) refined ACs. AC-DR-03/07/15 are absent because AC-STRIP-10
// removed them; `removed-acs-are-not-demanded` derives that set from the PRD itself so
// this list cannot silently drift back out of sync with the contract.
const REFINED_DEPLOY_REVERSION_AC_IDS = Object.freeze([
  'AC-DR-01',
  'AC-DR-02',
  'AC-DR-04a',
  'AC-DR-04b',
  'AC-DR-04c',
  'AC-DR-04d',
  'AC-DR-06',
  'AC-DR-08',
  'AC-DR-09',
  'AC-DR-10',
  'AC-DR-11',
  'AC-DR-12',
  'AC-DR-13',
  'AC-DR-14',
  'AC-DR-16',
]);

// Parses the refined PRD's AC table for rows whose status cell is REMOVED, e.g.
// `| AC-DR-03 | **REMOVED** (see ...) | status: removed | n/a | ... |`
function removedAcIdsFromRefinedPrd() {
  const prd = readFileSync(REFINED_PRD, 'utf8');
  const removed = [];
  for (const line of prd.split('\n')) {
    const match = /^\|\s*(AC-DR-[0-9a-z]+)\s*\|(.*)$/i.exec(line);
    if (match && /status:\s*removed/i.test(match[2])) removed.push(match[1]);
  }
  return removed;
}
function acFileName(acId) {
  return `${acId.toLowerCase()}.json`;
}

function artifact(acId, overrides = {}) {
  return {
    ac_id: acId,
    pass: true,
    checked_at: '2026-05-02T00:00:00.000Z',
    checker: 'verify-bundle.test',
    checker_version: 'test',
    evidence: {},
    failure_reason: null,
    remediation_hint: null,
    ...overrides,
  };
}

function makeFixture(mutator = () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-bundle-'));
  const bundleDir = path.join(dir, 'bundle');
  mkdirSync(bundleDir, { recursive: true });
  for (const acId of EXPECTED_BUNDLE_AC_IDS) {
    writeFileSync(
      path.join(bundleDir, acFileName(acId)),
      `${JSON.stringify(artifact(acId), null, 2)}\n`,
    );
  }
  mutator({ dir, bundleDir });
  return dir;
}

function runVerifier(repoRoot, args = []) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, BUNDLE_REPO_ROOT: repoRoot },
  });
}

function assertBundleArtifactShape(value, acId) {
  assert.equal(value.ac_id, acId);
  assert.equal(typeof value.pass, 'boolean');
  assert.match(value.checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.]\d{3}Z$/);
  assert.equal(typeof value.checker, 'string');
  assert.equal(typeof value.checker_version, 'string');
  assert.equal(value.evidence && typeof value.evidence, 'object');
  assert.equal(Array.isArray(value.evidence), false);
  assert.equal(value.failure_reason === null || typeof value.failure_reason === 'string', true);
  assert.equal(value.remediation_hint === null || typeof value.remediation_hint === 'string', true);
}

test('verify-bundle.ac-mapping covers every refined deploy-reversion AC exactly once', () => {
  assert.deepEqual(EXPECTED_BUNDLE_AC_IDS, REFINED_DEPLOY_REVERSION_AC_IDS);
  assert.equal(new Set(EXPECTED_BUNDLE_AC_IDS).size, EXPECTED_BUNDLE_AC_IDS.length);
});

test('verify-bundle.removed-acs-are-not-demanded by the bundle contract', () => {
  const removed = removedAcIdsFromRefinedPrd();
  // Guards the test itself: if the PRD table shape changes, this must not silently pass.
  assert.deepEqual(removed, ['AC-DR-03', 'AC-DR-07', 'AC-DR-15']);

  // A stripped AC has artifact `n/a` in the PRD, so no artifact can ever exist for it.
  // Demanding one pins the full-bundle run at INCONCLUSIVE forever.
  for (const acId of removed) {
    assert.equal(
      EXPECTED_BUNDLE_AC_IDS.includes(acId),
      false,
      `${acId} is status:removed in the refined PRD but is still demanded by EXPECTED_BUNDLE_AC_IDS`,
    );
    // AC-DR-15's artifact slot was `ac-dr-pre-flight.json`; the alias must not smuggle it back.
    const result = verifyBundle({ repoRoot: REPO_ROOT, ac: acId });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, new RegExp(`unknown AC id ${acId}`));
  }
  assert.equal(EXPECTED_BUNDLE_AC_IDS.includes('AC-DR-PRE-FLIGHT'), false);
});

test('verify-bundle.live-acs-still-demanded so unwritten evidence cannot false-green', () => {
  // The 12 ACs below have real artifact paths in the PRD but were never authored.
  // They MUST keep reporting missing — dropping them would manufacture a false PASS.
  for (const acId of ['AC-DR-01', 'AC-DR-04a', 'AC-DR-08', 'AC-DR-16']) {
    assert.equal(EXPECTED_BUNDLE_AC_IDS.includes(acId), true);
  }
  const result = verifyBundle({ repoRoot: REPO_ROOT });
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /AC-DR-16: missing bundle\/ac-dr-16\.json/);
  // ...but never for an AC the PRD stripped.
  assert.equal(/ac-dr-(03|07|pre-flight)\.json/.test(result.stderr), false);
});

test('verify-bundle.fixture-artifacts satisfy required metadata schema for every AC', () => {
  const fixture = makeFixture();
  try {
    for (const acId of EXPECTED_BUNDLE_AC_IDS) {
      const parsed = JSON.parse(readFileSync(path.join(fixture, 'bundle', acFileName(acId)), 'utf8'));
      assertBundleArtifactShape(parsed, acId);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.valid-pass exits 0 when all expected artifacts pass', () => {
  const fixture = makeFixture();
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bundle PASS/);
    assert.equal(BUNDLE_ARTIFACT_SCHEMA.required.includes('failure_reason'), true);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.all-or-pass exits 1 when any artifact has pass false', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    writeFileSync(
      path.join(bundleDir, 'ac-dr-08.json'),
      `${JSON.stringify(artifact('AC-DR-08', {
        pass: false,
        failure_reason: 'test-failure',
        remediation_hint: 'fix test fixture',
      }), null, 2)}\n`,
    );
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AC-DR-08: pass false/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.missing-inconclusive exits 2 when an artifact is missing', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    rmSync(path.join(bundleDir, 'ac-dr-09.json'));
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /AC-DR-09: missing bundle\/ac-dr-09\.json/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.malformed-fail exits 1 and names missing field', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    const bad = artifact('AC-DR-10');
    delete bad.checker_version;
    writeFileSync(path.join(bundleDir, 'ac-dr-10.json'), `${JSON.stringify(bad, null, 2)}\n`);
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing required field: checker_version/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.non-canonical-checked-at fails when artifact timestamp is not UTC ISO', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    writeFileSync(
      path.join(bundleDir, 'ac-dr-11.json'),
      `${JSON.stringify(artifact('AC-DR-11', {
        checked_at: '2026-05-02T00:00:00-05:00',
      }), null, 2)}\n`,
    );
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checked_at must be a canonical UTC ISO date string/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.invalid-calendar-checked-at fails when timestamp rolls into a different UTC day', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    writeFileSync(
      path.join(bundleDir, 'ac-dr-11.json'),
      `${JSON.stringify(artifact('AC-DR-11', {
        checked_at: '2026-02-31T00:00:00.000Z',
      }), null, 2)}\n`,
    );
  });
  try {
    const result = runVerifier(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checked_at must be a canonical UTC ISO date string/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.single-ac validates only requested artifact', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    rmSync(path.join(bundleDir, 'ac-dr-09.json'));
  });
  try {
    const result = runVerifier(fixture, ['--ac', 'AC-DR-08']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /checked=1/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.single-ac rejects a stripped AC even when an artifact file exists', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    // A stray artifact on disk must not resurrect a removed AC: the PRD contract is
    // authoritative, not the filesystem.
    writeFileSync(
      path.join(bundleDir, 'ac-dr-pre-flight.json'),
      `${JSON.stringify(artifact('AC-DR-PRE-FLIGHT'), null, 2)}\n`,
    );
  });
  try {
    for (const acId of ['AC-DR-15', 'AC-DR-PRE-FLIGHT', 'AC-DR-03', 'AC-DR-07']) {
      const result = runVerifier(fixture, ['--ac', acId]);
      assert.equal(result.status, 2, result.stdout);
      assert.match(result.stderr, new RegExp(`unknown AC id ${acId}`));
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.single-ac rejects unknown AC ids instead of validating arbitrary bundle files', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    writeFileSync(
      path.join(bundleDir, 'ac-dr-99.json'),
      `${JSON.stringify(artifact('AC-DR-99'), null, 2)}\n`,
    );
  });
  try {
    const result = runVerifier(fixture, ['--ac', 'AC-DR-99']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown AC id AC-DR-99/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.recovers newer orphan tmp bundle artifacts before reporting missing files', () => {
  const fixture = makeFixture(({ bundleDir }) => {
    const artifactPath = path.join(bundleDir, acFileName('AC-DR-01'));
    const payload = readFileSync(artifactPath, 'utf8');
    rmSync(artifactPath);
    writeFileSync(path.join(bundleDir, `${acFileName('AC-DR-01')}.tmp.999999.recovered`), payload);
  });
  try {
    const result = runVerifier(fixture, ['--ac', 'AC-DR-01']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bundle PASS/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('verify-bundle.repo-ac-dr-04d stays verifier-clean as a tracked artifact', () => {
  const result = runVerifier(REPO_ROOT, ['--ac', 'AC-DR-04d']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /bundle PASS/);
});

test('verify-bundle.exported-api defaults to repo root instead of caller cwd', () => {
  const originalCwd = process.cwd();
  try {
    process.chdir(path.join(REPO_ROOT, 'extension'));
    const result = verifyBundle({ ac: 'AC-DR-04d' });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /bundle PASS/);
  } finally {
    process.chdir(originalCwd);
  }
});
