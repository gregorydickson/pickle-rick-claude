// @tier: fast
//
// R-WSDO (30aa2e0d): worker_produced_nothing breadcrumb.
//
// The emitter lives deep inside runMuxRunnerMain at the recordWorkerArtifactProgress
// site; this suite proves the THREE-condition predicate + payload contract at the
// decision-function level using the EXPORTED checkPartialLifecycleExit (the carve-out
// gate) and countWorkerArtifacts (the count-delta source) over real on-disk fixtures,
// and schema-validates the constructed payload. It covers all three acceptance cases:
//   (a) fires        — no research_review.md + log_empty + 0 delta
//   (b) carve-out    — APPROVED research_review.md + a required prefix missing + 0-byte
//                      log → worker_silent_death (plExit non-null) → NO double-emit
//   (c) negative     — positive artifact delta → neither event
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { checkPartialLifecycleExit, countWorkerArtifacts } from '../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '../src/types/activity-events.schema.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

// Minimal validator mirroring activity-event-payload.test.js: required-field + const +
// type checks over the worker_produced_nothing definition (incl. nested gate_payload).
function validate(payload, defName) {
  const def = schema.definitions[defName];
  assert.ok(def, `no schema definition for '${defName}'`);
  return validateAgainst(payload, def);
}
function validateAgainst(payload, def) {
  for (const field of def.required || []) {
    if (!(field in payload)) { return { valid: false, error: `missing required field: ${field}` }; }
  }
  for (const [field, raw] of Object.entries(def.properties || {})) {
    if (!(field in payload)) { continue; }
    const types = Array.isArray(raw.type) ? raw.type : [raw.type].filter(Boolean);
    const value = payload[field];
    if (Object.prototype.hasOwnProperty.call(raw, 'const') && value !== raw.const) {
      return { valid: false, error: `${field} must equal ${String(raw.const)}` };
    }
    if (types.includes('object') && raw.required) {
      if (typeof value !== 'object' || value === null) { return { valid: false, error: `${field} must be an object` }; }
      const nested = validateAgainst(value, raw);
      if (!nested.valid) { return { valid: false, error: `${field}.${nested.error}` }; }
    }
    if (types.includes('integer') && value !== null && !Number.isInteger(value)) {
      return { valid: false, error: `${field} must be an integer` };
    }
    if (types.includes('string') && value !== null && typeof value !== 'string') {
      return { valid: false, error: `${field} must be a string` };
    }
  }
  return { valid: true };
}

function makeSession() {
  const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'r-wsdo-'));
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ active: true, schema_version: 5, session_dir: sessionDir, activity: [] }));
  return { sessionDir, statePath };
}

function makeTicket(sessionDir, ticketId, { tier = 'medium', files = {} } = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(
    path.join(ticketDir, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\ncomplexity_tier: ${tier}\n---\n# ${ticketId}\n`,
  );
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(ticketDir, name), content);
  }
  return ticketDir;
}

// Mirror of the runtime predicate (mux-runner.ts R-WSDO block). countWorkerArtifacts
// stands in for the apProgressResult.lastArtifactCount AFTER snapshot.
function logEmptyFromDir(ticketDir) {
  const logs = readdirSync(ticketDir).filter((f) => /^worker_session_\d+\.log$/.test(f));
  // log_empty iff there is no session log OR the latest one is 0 bytes.
  if (logs.length === 0) { return true; }
  return logs.every((f) => readFileSync(path.join(ticketDir, f)).length === 0);
}
function breadcrumbFires(sessionDir, statePath, ticketId, beforeCount) {
  const plExit = checkPartialLifecycleExit(sessionDir, statePath, ticketId);
  const ticketDir = path.join(sessionDir, ticketId);
  const afterCount = countWorkerArtifacts(ticketDir);
  return plExit === null && logEmptyFromDir(ticketDir) && afterCount - beforeCount === 0;
}

test('R-WSDO (a): no research_review.md + 0-byte log + 0 delta — breadcrumb fires with conformant payload', () => {
  const { sessionDir, statePath } = makeSession();
  try {
    const ticketId = 'aaaa1111';
    // Medium tier, NO research_review.md → checkPartialLifecycleExit short-circuits to
    // null (genuinely-uncovered "produced nothing at all"). 0-byte session log.
    makeTicket(sessionDir, ticketId, {
      tier: 'medium',
      files: { 'worker_session_4242.log': '' },
    });
    const beforeCount = countWorkerArtifacts(path.join(sessionDir, ticketId));

    assert.equal(beforeCount, 0, 'no gated artifacts present');
    assert.equal(breadcrumbFires(sessionDir, statePath, ticketId, beforeCount), true);

    // The runtime would now construct + emit this payload — it must be schema-conformant.
    const payload = {
      event: 'worker_produced_nothing',
      ts: new Date().toISOString(),
      ticket: ticketId,
      gate_payload: { spawn_pid: 4242, session_log_bytes: 0, artifact_delta: 0 },
    };
    const res = validate(payload, 'worker_produced_nothing');
    assert.equal(res.valid, true, res.error);
    // spawn_pid may also be null (absent log).
    assert.equal(validate({ ...payload, gate_payload: { ...payload.gate_payload, spawn_pid: null } }, 'worker_produced_nothing').valid, true);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-WSDO (b): carve-out — APPROVED research_review + missing prefix + 0-byte log emits worker_silent_death, NOT worker_produced_nothing (no double-emit)', () => {
  const { sessionDir, statePath } = makeSession();
  try {
    const ticketId = 'bbbb2222';
    // Medium tier WITH an APPROVED research_review.md but a missing downstream required
    // prefix (no plan/conformance/code_review) + 0-byte log → checkPartialLifecycleExit
    // reaches the log_empty branch and emits worker_silent_death (returns NON-null).
    makeTicket(sessionDir, ticketId, {
      tier: 'medium',
      files: {
        'research_2026.md': 'research body',
        'research_review.md': 'looks good\nAPPROVED',
        'worker_session_5555.log': '',
      },
    });
    const beforeCount = countWorkerArtifacts(path.join(sessionDir, ticketId));

    const plExit = checkPartialLifecycleExit(sessionDir, statePath, ticketId);
    assert.notEqual(plExit, null, 'carve-out: partial-lifecycle exit must be classified (worker_silent_death path)');
    assert.equal(plExit.subClass, 'log_empty');

    // Breadcrumb predicate is FALSE because plExit is non-null — no double-emit.
    assert.equal(breadcrumbFires(sessionDir, statePath, ticketId, beforeCount), false);

    // And it really emitted worker_silent_death (not worker_produced_nothing).
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const events = (state.activity || []).map((e) => e.event);
    assert.ok(events.includes('worker_silent_death'), 'worker_silent_death must be the emitted event');
    assert.ok(!events.includes('worker_produced_nothing'), 'worker_produced_nothing must NOT be emitted in the carve-out');
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('R-WSDO (c): negative — positive artifact delta emits neither event', () => {
  const { sessionDir, statePath } = makeSession();
  try {
    const ticketId = 'cccc3333';
    // A worker that produced a new gated artifact AFTER the before-snapshot: before=0,
    // after>0 → delta>0 → predicate FALSE.
    makeTicket(sessionDir, ticketId, { tier: 'medium', files: { 'worker_session_6666.log': '' } });
    const beforeCount = countWorkerArtifacts(path.join(sessionDir, ticketId));
    assert.equal(beforeCount, 0);

    // Worker produced a gated artifact this iteration (countWorkerArtifacts credits
    // code_review*/conformance* by default).
    writeFileSync(path.join(sessionDir, ticketId, 'conformance_2026.md'), 'new conformance');
    const afterCount = countWorkerArtifacts(path.join(sessionDir, ticketId));
    assert.ok(afterCount - beforeCount > 0, 'positive delta');

    assert.equal(breadcrumbFires(sessionDir, statePath, ticketId, beforeCount), false);
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
