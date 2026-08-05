// @tier: fast
//
// B-OFFREPO ticket 40 (69cdb73b) — the closing verification ticket of the B-OFFREPO bundle.
//
// The prior acceptance criterion for "prove the off-repo gate runs" was `test -f` plus prose —
// unfalsifiable, because a worker could hand-author a markdown file that merely LOOKED right
// and pass. This file asserts the machine-readable replacement,
// `prds/research/offrepo-field-result.json` (emitted by
// `extension/scripts/emit-offrepo-field-result.mjs` from a REAL execution of `runWorkerGate`
// against temp-dir fixtures with no `extension/` directory — see that script and
// `research_2026-08-04.md` for how the artifact was produced).
//
// This test does NOT re-run the harness. It asserts the checked-in artifact's SHAPE and its
// central invariant. A `checkRecords` helper is shared between the real-file test and an inline
// fabricated fixture so the fabricated case proves the checker actually rejects the exact
// failure this ticket exists to prevent: an artifact where every record claims a pass with no
// execution.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = path.join(__dirname, '..', '..', 'prds', 'research', 'offrepo-field-result.json');

const REQUIRED_KEYS = ['working_dir', 'project_type', 'gate_executed', 'checks_run', 'verdict'];

/**
 * Load and parse the artifact at `filePath`. Throws (does not return null/undefined) on any
 * absence or malformation — an absent or unparsable artifact must fail this test, not silently
 * produce an empty pass.
 */
function loadArtifact(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8'); // throws ENOENT if absent — intentional
  const parsed = JSON.parse(raw); // throws SyntaxError if malformed — intentional
  if (!Array.isArray(parsed)) {
    throw new Error(`offrepo-field-result.json must be a JSON array, got ${typeof parsed}`);
  }
  return parsed;
}

/**
 * Assert all four invariants the ticket's Interface Contracts / Acceptance Criteria demand.
 * Throws with a descriptive message on the first violation.
 */
function checkRecords(records) {
  if (records.length < 1) {
    throw new Error('offrepo-field-result.json must contain at least one record');
  }

  for (const [i, record] of records.entries()) {
    for (const key of REQUIRED_KEYS) {
      if (!(key in record)) {
        throw new Error(`record ${i} is missing required key "${key}"`);
      }
    }
    if (typeof record.working_dir !== 'string' || record.working_dir.length === 0) {
      throw new Error(`record ${i} has a non-string or empty working_dir`);
    }
    if (!Array.isArray(record.checks_run)) {
      throw new Error(`record ${i}.checks_run must be an array`);
    }
    if (!['green', 'red', 'not_run'].includes(record.verdict)) {
      throw new Error(`record ${i} has an unrecognized verdict "${record.verdict}"`);
    }
  }

  // (b) no recorded working_dir may be pickle-rick's own tree — the whole point of this
  // ticket is that the gate ran against a repo with NO `extension/` directory.
  for (const [i, record] of records.entries()) {
    const segments = record.working_dir.split(path.sep);
    if (segments.includes('extension')) {
      throw new Error(`record ${i}.working_dir ("${record.working_dir}") contains an "extension" segment — this must be a non-pickle-rick fixture`);
    }
  }

  // (c) at least one record proves the gate genuinely executed something.
  const executedWithChecks = records.some(r => r.gate_executed === true && Array.isArray(r.checks_run) && r.checks_run.length > 0);
  if (!executedWithChecks) {
    throw new Error('no record has gate_executed:true with a non-empty checks_run — the artifact does not prove the gate ran');
  }

  // (d) the invariant: gate_executed:false can never coexist with verdict:'green'.
  const violatesInvariant = records.some(r => r.gate_executed === false && r.verdict === 'green');
  if (violatesInvariant) {
    throw new Error('at least one record has gate_executed:false AND verdict:green — a gate that did not run must never report a pass');
  }
}

test('offrepo-field-result.json exists and parses as a non-empty JSON array', () => {
  const records = loadArtifact(ARTIFACT_PATH);
  assert.ok(Array.isArray(records) && records.length >= 1);
});

test('offrepo-field-result.json: every recorded working_dir is off-repo (no extension/ segment)', () => {
  const records = loadArtifact(ARTIFACT_PATH);
  for (const record of records) {
    assert.ok(
      !record.working_dir.split(path.sep).includes('extension'),
      `working_dir "${record.working_dir}" must not contain an "extension" segment`,
    );
  }
});

test('offrepo-field-result.json: at least one record proves the gate actually executed', () => {
  const records = loadArtifact(ARTIFACT_PATH);
  const hit = records.find(r => r.gate_executed === true && r.checks_run.length > 0);
  assert.ok(hit, 'expected at least one record with gate_executed:true and non-empty checks_run');
});

test('offrepo-field-result.json: no record has gate_executed:false with verdict:green', () => {
  const records = loadArtifact(ARTIFACT_PATH);
  const offender = records.find(r => r.gate_executed === false && r.verdict === 'green');
  assert.equal(offender, undefined, `found a record claiming a pass with no execution: ${JSON.stringify(offender)}`);
});

test('offrepo-field-result.json: full checker (all four invariants) accepts the real artifact', () => {
  const records = loadArtifact(ARTIFACT_PATH);
  assert.doesNotThrow(() => checkRecords(records));
});

// --- Falsifiability proof -------------------------------------------------------------------
//
// The ticket requires the test to FAIL on a fabricated artifact where every verdict is 'green'
// with no gate execution — the exact failure this ticket exists to prevent. This fixture is
// exercised inline (never written to disk in place of the real artifact) so the falsifiability
// proof does not depend on corrupting checked-in evidence during a normal test run. The live
// mutation round-trip against the REAL file on disk (RED, then restored to GREEN) is performed
// manually and recorded verbatim in conformance_2026-08-04.md, per the ticket's explicit
// instruction to "prove the test's teeth by mutation."

const FABRICATED_ALL_GREEN_NO_EXECUTION = [
  { working_dir: '/tmp/some-fake-target-repo', project_type: 'npm', gate_executed: false, checks_run: [], verdict: 'green' },
  { working_dir: '/tmp/another-fake-target-repo', project_type: 'npm', gate_executed: false, checks_run: [], verdict: 'green' },
];

// This is the literal shape the ticket names: "a fabricated artifact in which every verdict
// is green with no gate execution". The checker rejects it — via the earliest invariant it
// trips, check (c) (no proof of execution at all) — which is sufficient per the ticket's
// wording ("the assertion test FAILS"). The NEXT test isolates invariant (d) specifically.
test('checker REJECTS the ticket-specified fabricated artifact (every verdict green, no execution)', () => {
  assert.throws(() => checkRecords(FABRICATED_ALL_GREEN_NO_EXECUTION));
});

test('checker REJECTS an artifact with no gate_executed:true record at all (no proof of execution)', () => {
  const noExecutionButHonest = [
    { working_dir: '/tmp/some-fake-target-repo', project_type: null, gate_executed: false, checks_run: [], verdict: 'not_run' },
  ];
  assert.throws(
    () => checkRecords(noExecutionButHonest),
    /no record has gate_executed:true/,
  );
});

// Isolates invariant (d) specifically: one record proves real execution (so check (c) is
// satisfied), but a SECOND record still smuggles a pass with no execution behind it. The
// invariant must catch this even when the artifact is not uniformly fabricated.
test('checker REJECTS a mixed artifact where one record smuggles gate_executed:false + verdict:green past a legitimate one', () => {
  const mixed = [
    { working_dir: '/tmp/legit-target-repo', project_type: 'npm', gate_executed: true, checks_run: ['typecheck', 'lint', 'test'], verdict: 'green' },
    { working_dir: '/tmp/smuggled-fake-repo', project_type: 'npm', gate_executed: false, checks_run: [], verdict: 'green' },
  ];
  assert.throws(
    () => checkRecords(mixed),
    /gate_executed:false AND verdict:green/,
  );
});

test('checker REJECTS an empty array', () => {
  assert.throws(() => checkRecords([]), /at least one record/);
});

test('checker REJECTS a record recorded against pickle-rick\'s own extension/ tree', () => {
  const selfRepoRecord = [
    { working_dir: '/Users/someone/repo/extension', project_type: 'npm', gate_executed: true, checks_run: ['typecheck'], verdict: 'green' },
  ];
  assert.throws(() => checkRecords(selfRepoRecord), /extension" segment/);
});

test('loadArtifact THROWS (does not silently pass) on an absent file', () => {
  const missingPath = path.join(__dirname, '..', '..', 'prds', 'research', 'does-not-exist-offrepo-field-result.json');
  assert.throws(() => loadArtifact(missingPath), /ENOENT/);
});

test('loadArtifact THROWS (does not silently pass) on malformed JSON', () => {
  const badPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'offrepo-bad-')), 'bad.json');
  fs.writeFileSync(badPath, '{ not valid json');
  assert.throws(() => loadArtifact(badPath), SyntaxError);
});
