// @tier: fast
//
// AC-V4 (ticket dc205237) — a ticket DROPPED because the pickle phase exhausted its
// iteration cap must be reported DISTINCTLY from an ordinary incomplete phase.
//
// The defect this pins: `B-CGSHIP` composed 8 tickets, pickle hit its cap, and ticket
// `f2b3cf76` was never built — zero commits, no code. The runtime behaved CORRECTLY per
// the PRIME DIRECTIVE (reported incomplete, advanced, did not halt) and these tests
// preserve that. The defect was in the REPORTING: `incomplete` is the same word the
// phase uses for many milder outcomes, so a reader of a finished 4/4 pipeline never
// learned a ticket vanished. Measurement A (dropped unbuilt at the cap) was reported in
// the vocabulary of measurement B (generic phase incompleteness) — the epic's thesis.
//
// THIS IS A DISPOSITION PLUS A REPORT, NEVER A GATE. Test 2 is the standing proof: the
// run still advances, and the phase accounting is byte-identical to the generic path.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizePhaseSuccess } from '../bin/pipeline-runner.js';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'src/types/activity-events.schema.json');
const TYPES_TS_PATH = path.join(ROOT, 'src/types/index.ts');
const TYPES_JS_PATH = path.join(ROOT, 'types/index.js');

const EVENT = 'phase_cap_dropped_tickets';
const DISPOSITION = 'tickets_dropped_at_cap';
const CAP_EXIT_REASON = 'iteration_cap_exhausted';

/** The exact generic line the cap-drop path must NOT change for milder causes. */
function genericIncompleteMessage(pendingCount, ticketCount, doneCount) {
  return `Phase pickle exited but ${pendingCount}/${ticketCount} tickets remain pending (${doneCount} Done) — not all-tickets-terminal, reporting phase incomplete, advancing`;
}

// --- activity-log capture ------------------------------------------------------
// `logActivity` resolves its root through `getDataRoot()` at call time, so pointing
// PICKLE_DATA_ROOT at a temp dir isolates every emission this file provokes.
let dataRoot;
let priorDataRoot;

before(() => {
  priorDataRoot = process.env.PICKLE_DATA_ROOT;
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-dropped-data-'));
  process.env.PICKLE_DATA_ROOT = dataRoot;
});

after(() => {
  if (priorDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
  else process.env.PICKLE_DATA_ROOT = priorDataRoot;
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

/** Every activity event emitted so far, newest-inclusive, across all daily files. */
function readActivityEvents() {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  return fs.readdirSync(activityDir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(activityDir, f), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
}

function clearActivityEvents() {
  fs.rmSync(path.join(dataRoot, 'activity'), { recursive: true, force: true });
}

// --- session fixture -----------------------------------------------------------
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cap-dropped-ticket-'));
}

function writeState(statePath, exitReason) {
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    working_dir: '/tmp',
    step: 'completed',
    iteration: 500,
    max_iterations: 500,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: path.dirname(statePath),
    tmux_mode: true,
    exit_reason: exitReason,
  }));
}

function makeRuntime(dir) {
  const statePath = path.join(dir, 'state.json');
  return {
    runtime: {
      sessionDir: dir,
      statePath,
      // workingDir is a non-repo path on purpose: the completion oracle finds no
      // commit for the pending ticket, so it stays genuinely unfinished (the
      // `f2b3cf76` shape — zero commits, no code).
      workingDir: '/tmp',
      config: { phases: [{}, {}, {}, {}] },
      log: () => {},
    },
    statePath,
    cancelMarker: path.join(dir, 'pipeline-cancel'),
  };
}

function writeTicket(sessionDir, ticketId, status, order) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${ticketId}.md`),
    ['---', `id: ${ticketId}`, `title: "${ticketId}"`, `status: ${status}`, `order: ${order}`, '---', '', `# ${ticketId}`, ''].join('\n'),
  );
}

function makeCounters() {
  return { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
}

/** The B-CGSHIP roster verbatim: 8 tickets, 7 Done, `f2b3cf76` (order 80) never built. */
const DROPPED_ID = 'f2b3cf76';
const DONE_IDS = ['a1111111', 'a2222222', 'a3333333', 'a4444444', 'a5555555', 'a6666666', 'a7777777'];

function writeCgshipRoster(dir) {
  DONE_IDS.forEach((id, i) => writeTicket(dir, id, 'Done', (i + 1) * 10));
  writeTicket(dir, DROPPED_ID, 'Todo', 80);
}

/**
 * Drive the pickle phase-exit seam over the B-CGSHIP roster with the given
 * `exit_reason`, returning everything the four pins assert against.
 */
function runPhaseExit(exitReason) {
  clearActivityEvents();
  const dir = tmpDir();
  try {
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, exitReason);
    writeCgshipRoster(dir);
    const logs = [];
    runtime.log = (m) => logs.push(m);
    const counters = makeCounters();
    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);
    return { outcome, counters, logs, events: readActivityEvents() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('AC-V4: a cap-dropped ticket gets a distinct disposition (dc205237)', () => {
  test('AC-V4-1: a cap-exhausted exit names the disposition and carries the dropped ticket ids', () => {
    const { outcome, counters, logs, events } = runPhaseExit(CAP_EXIT_REASON);

    // The named disposition, in the existing `name:<comma-joined-ids>` vocabulary.
    assert.equal(
      counters.phaseDispositions.pickle,
      `${DISPOSITION}:${DROPPED_ID}`,
      'the cap-drop must be NAMED in phaseDispositions, not left as generic incompleteness',
    );

    // The activity event, carrying the ids — the machine-readable arm.
    const capEvents = events.filter((e) => e.event === EVENT);
    assert.equal(capEvents.length, 1, `exactly one ${EVENT} event must be emitted`);
    const payload = capEvents[0];
    assert.equal(payload.source, 'pickle');
    assert.equal(payload.phase, 'pickle');
    assert.deepEqual(
      payload.gate_payload.dropped_ticket_ids,
      [DROPPED_ID],
      'the event must carry the ids of the tickets that were never built',
    );
    assert.equal(payload.gate_payload.dropped_count, 1);
    assert.equal(payload.gate_payload.done_count, DONE_IDS.length);
    assert.equal(payload.gate_payload.ticket_count, DONE_IDS.length + 1);

    // The human-readable arm: the log NAMES the cap and the dropped ticket, and the
    // generic line — which would let the drop pass as ordinary incompleteness — is gone.
    assert.ok(
      logs.some((l) => l.includes('hit its iteration cap') && l.includes(`dropped at cap: ${DROPPED_ID}`)),
      `the log must name the cap and the dropped ticket; got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      !logs.includes(genericIncompleteMessage(1, 8, 7)),
      'the generic incomplete line must be SUPPRESSED on the cap path — reporting it too would re-blur the two measurements',
    );

    // Still a report, not a halt.
    assert.equal(outcome.action, 'continue');
    assert.equal(outcome.phaseIncomplete, true);
  });

  test('AC-V4-2: the run still advances — phase accounting is unchanged versus the generic path', () => {
    const capRun = runPhaseExit(CAP_EXIT_REASON);
    const genericRun = runPhaseExit(null);

    // This criterion exists to prove the fix is not a stopping gate.
    assert.equal(capRun.outcome.action, 'continue', 'a cap-dropped ticket must never break the phase loop');
    assert.equal(genericRun.outcome.action, 'continue');
    assert.deepEqual(
      capRun.outcome,
      genericRun.outcome,
      'the cap path must return the SAME outcome as the generic path — the disposition changes the report, never the disposition of the run',
    );

    // Phase counts identical: naming the drop costs the run no phase, no convergence
    // term, and no skip. Only `phaseDispositions` — the report channel — differs.
    for (const key of ['completed', 'skipped', 'nonConvergent']) {
      assert.equal(
        capRun.counters[key],
        genericRun.counters[key],
        `counters.${key} must be unchanged versus the generic incomplete path`,
      );
    }
    assert.deepEqual(capRun.counters.phaseSkips, genericRun.counters.phaseSkips);
  });

  test('AC-V4-3: an ordinary incomplete phase is unaffected — same message, no cap-drop event', () => {
    const { outcome, counters, logs, events } = runPhaseExit(null);

    assert.ok(
      logs.includes(genericIncompleteMessage(1, 8, 7)),
      `today's exact generic message must survive verbatim; got: ${JSON.stringify(logs)}`,
    );
    assert.equal(
      counters.phaseDispositions.pickle,
      undefined,
      'a milder incomplete cause must record NO cap-drop disposition',
    );
    assert.equal(
      events.filter((e) => e.event === EVENT).length,
      0,
      'no cap-drop event may be emitted when cap-exhaustion was not established — a false alarm on every ordinary run would be worse than the defect',
    );
    assert.ok(
      !logs.some((l) => l.includes('dropped at cap')),
      'the cap vocabulary must not leak onto the milder path',
    );
    assert.equal(outcome.action, 'continue');
  });

  test('AC-V4-4: the emitted event validates against activity-events.schema.json and the registries agree', () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

    // Definition present, with the event/ts/session/gate_payload contract.
    const def = schema.definitions[EVENT];
    assert.ok(def, `activity-events.schema.json must define ${EVENT}`);
    assert.equal(def.type, 'object');
    assert.deepEqual(def.required.slice().sort(), ['event', 'gate_payload', 'session', 'ts']);
    assert.equal(def.properties.event.const, EVENT);
    assert.deepEqual(def.properties.gate_payload.required, ['dropped_ticket_ids']);

    // R-PDD-oneOf: the classic silent half-registration is a definition with no
    // top-level `oneOf` $ref — payload validation would simply never cover it.
    assert.ok(
      schema.oneOf.some((entry) => entry.$ref === `#/definitions/${EVENT}`),
      `oneOf must reference ${EVENT} so payload validation covers it`,
    );

    // Registry: the runtime enum plus both tracked mirrors.
    assert.ok(VALID_ACTIVITY_EVENTS.includes(EVENT), `VALID_ACTIVITY_EVENTS must register ${EVENT}`);
    const re = new RegExp(`['"]${EVENT}['"]`);
    assert.ok(re.test(fs.readFileSync(TYPES_TS_PATH, 'utf8')), 'src/types/index.ts must list the event');
    assert.ok(re.test(fs.readFileSync(TYPES_JS_PATH, 'utf8')), 'types/index.js mirror must list the event');

    // The REAL emission — not a hand-built fixture — satisfies that definition.
    const payload = runPhaseExit(CAP_EXIT_REASON).events.find((e) => e.event === EVENT);
    assert.ok(payload, 'the seam must actually emit the event');
    for (const field of def.required) {
      assert.ok(field in payload, `emitted payload is missing required field ${field}`);
    }
    assert.equal(typeof payload.ts, 'string');
    assert.equal(typeof payload.session, 'string');
    assert.equal(payload.event, def.properties.event.const);
    const gp = def.properties.gate_payload.properties;
    assert.ok(Array.isArray(payload.gate_payload.dropped_ticket_ids));
    assert.equal(gp.dropped_ticket_ids.items.type, 'string');
    assert.ok(payload.gate_payload.dropped_ticket_ids.every((id) => typeof id === 'string'));
    for (const numeric of ['dropped_count', 'done_count', 'ticket_count']) {
      assert.equal(gp[numeric].type, 'number');
      assert.equal(typeof payload.gate_payload[numeric], 'number');
    }
  });
});
