// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateBundleArtifact, verifyBundle } from '../../bin/verify-bundle.js';
import { formatLocalDateKey } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'bin', 'verify-recapture-fired.js');
const ACTIVITY_LOGGER = path.join(REPO_ROOT, 'extension', 'services', 'activity-logger.js');
// There is deliberately NO tracked bundle/ac-dr-02.json — see the trap door in bin/CLAUDE.md.
const TRACKED_ARTIFACT = path.join(REPO_ROOT, 'bundle', 'ac-dr-02.json');

// R-CIFB: hermetic base env — strip data-root/extension-root vars so a runner-set
// EXTENSION_DIR (CI = github.workspace) cannot override the no-session test's fake
// HOME. verify-recapture-fired.js resolves its default runtime artifact via
// getDataRoot(), which consults EXTENSION_DIR before HOME/.local/share/pickle-rick.
const { EXTENSION_DIR: _ed, PICKLE_DATA_ROOT: _pdr, PICKLE_DATA_DIR: _pdd, ...HERMETIC_ENV } = process.env;
const DEAD_TMP_PID = 99_999_999;
const SPAWN_TIMEOUT_MS = 30_000;

const RECAPTURE_TS = '2026-05-02T11:15:00.000Z';

// The verifier's ONLY use of state.json is the anatomy window it derives from `history`.
// HIT brackets RECAPTURE_TS; MISS does not — so which history the verifier ends up reading
// is observable in the verdict. That is what makes these two the discriminator for every
// orphan-tmp / schema-guard recovery case below.
const HISTORY_WINDOW_HIT = [
  { step: 'pickle', timestamp: '2026-05-02T10:00:00.000Z' },
  { step: 'anatomy-park', timestamp: '2026-05-02T11:00:00.000Z' },
  { step: 'szechuan-sauce', timestamp: '2026-05-02T12:00:00.000Z' },
];
const HISTORY_WINDOW_MISS = [
  { step: 'pickle', timestamp: '2026-05-02T08:00:00.000Z' },
  { step: 'anatomy-park', timestamp: '2026-05-02T13:00:00.000Z' },
  { step: 'szechuan-sauce', timestamp: '2026-05-02T14:00:00.000Z' },
];

function makeSession(state) {
  const session = realpathSync(mkdtempSync(path.join(tmpdir(), 'verify-recapture-')));
  if (state !== null) {
    writeFileSync(path.join(session, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  }
  return session;
}

function makeDataRoot() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'verify-recapture-data-')));
}

function recaptureEvent(sessionName, overrides = {}) {
  return {
    ts: RECAPTURE_TS,
    event: 'baseline_recapture_attempted',
    source: 'pickle',
    session: sessionName,
    iteration: 3,
    ...overrides,
  };
}

// Returns the producer's logActivityFn({...}) call text for the recapture event, so the
// assertion reads that call's own properties instead of grepping the whole file — a `session:`
// belonging to some other emission must not satisfy this pin.
function extractRecaptureEmission(source) {
  const eventIdx = source.indexOf("event: 'baseline_recapture_attempted'");
  if (eventIdx === -1) return null;
  const callStart = source.lastIndexOf('logActivityFn({', eventIdx);
  const callEnd = source.indexOf('});', eventIdx);
  if (callStart === -1 || callEnd === -1) return null;
  return source.slice(callStart, callEnd);
}

// Mirrors logActivity's sink exactly: getDataRoot()/activity/<local-day>.jsonl, keyed off the
// event's own ts. Same day-key helper the producer uses, so this holds in any TZ.
function writeActivityEvents(dataRoot, events) {
  const activityDir = path.join(dataRoot, 'activity');
  mkdirSync(activityDir, { recursive: true });
  for (const event of events) {
    const dayKey = formatLocalDateKey(new Date(event.ts));
    appendFileSync(path.join(activityDir, `${dayKey}.jsonl`), `${JSON.stringify(event)}\n`);
  }
  return activityDir;
}

function runVerifier(session, dataRoot) {
  const runtimeArtifactPathForSession = path.join(session, 'bundle', 'ac-dr-02.runtime.json');
  const result = spawnSync(process.execPath, [CLI, session], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...HERMETIC_ENV, ...(dataRoot ? { PICKLE_DATA_ROOT: dataRoot } : {}) },
  });
  return {
    ...result,
    runtimeArtifactPath: runtimeArtifactPathForSession,
    runtimeArtifact: JSON.parse(readFileSync(runtimeArtifactPathForSession, 'utf8')),
  };
}

function readOptionalFile(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
}

function baseState(history = HISTORY_WINDOW_HIT, extra = {}) {
  return { history, ...extra };
}

function recoverableState(history, extra = {}) {
  return {
    active: false,
    working_dir: REPO_ROOT,
    step: 'anatomy-park',
    iteration: 7,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'verify recapture orphan recovery',
    history,
    activity: [],
    started_at: '2026-05-02T10:00:00.000Z',
    session_dir: REPO_ROOT,
    schema_version: 4,
    ...extra,
  };
}

// KEYSTONE: drives the REAL producer. microverse-runner emits the recapture event through
// logActivity(), so this test emits it the same way — in a child process, against a sandboxed
// PICKLE_DATA_ROOT — and then asks the verifier for a verdict. Nothing hand-places the event in
// the sink the verifier reads. If producer and consumer ever disagree on the sink again, this
// is the test that goes red (the previous suite wrote the event straight into state.json.activity,
// so it only ever proved the consumer reads what the test wrote).
test('verify-recapture.pass — an event emitted through the real logActivity producer satisfies the AC', () => {
  const session = makeSession(baseState());
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  try {
    const emit = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { logActivity } from ${JSON.stringify(pathToFileURL(ACTIVITY_LOGGER).href)};\n`
      + `logActivity(${JSON.stringify(recaptureEvent(sessionName))});\n`,
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      env: { ...HERMETIC_ENV, PICKLE_DATA_ROOT: dataRoot },
    });
    assert.equal(emit.status, 0, emit.stderr);

    const dayKey = formatLocalDateKey(new Date(RECAPTURE_TS));
    assert.equal(
      existsSync(path.join(dataRoot, 'activity', `${dayKey}.jsonl`)),
      true,
      'the producer must write to getDataRoot()/activity/<day>.jsonl — the sink the verifier reads',
    );

    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AC-DR-02 PASS/);
    assert.equal(existsSync(TRACKED_ARTIFACT), false, 'a verifier run must never fabricate a tracked artifact');
    assert.deepEqual(validateBundleArtifact(result.runtimeArtifact), []);
    assert.equal(result.runtimeArtifact.checker_version, '3');
    assert.equal(result.runtimeArtifact.pass, true);
    assert.equal(result.runtimeArtifact.failure_reason, null);
    assert.equal(result.runtimeArtifact.evidence.matched_event.session, sessionName);
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// The bug this bundle fixes: the verifier used to read state.json.activity, a sink
// logActivity NEVER writes. An event parked there alone must NOT satisfy the AC — otherwise
// the consumer has drifted back onto the wrong table.
test('verify-recapture.state-activity-only does NOT satisfy the AC (wrong sink)', () => {
  const session = makeSession(null);
  const dataRoot = makeDataRoot();
  // Correctly attributed, inside the latest window — the event is wrong in exactly one way:
  // it sits in state.json.activity, the sink logActivity never writes.
  writeFileSync(
    path.join(session, 'state.json'),
    `${JSON.stringify(baseState(HISTORY_WINDOW_HIT, {
      activity: [recaptureEvent(path.basename(session))],
    }), null, 2)}\n`,
  );
  try {
    writeActivityEvents(dataRoot, []);
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 1, 'state.json.activity is not the producer sink and must not be credited');
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'recapture-event-missing');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// The activity dir is shared by every session on the host — attribution is load-bearing.
test('verify-recapture.foreign-session event does not satisfy this session AC', () => {
  const session = makeSession(baseState());
  const dataRoot = makeDataRoot();
  try {
    writeActivityEvents(dataRoot, [recaptureEvent('2026-01-01-deadbeef')]);
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'recapture-event-missing');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// The PRODUCER half of that same join. `attemptStrictBaselineRecapture` is unexported, the two
// integration tests that drive it assert only event/ordering, and every consumer fixture here
// hand-stamps `session` — so deleting the producer's stamp left AC-DR-02 a permanent false-RED
// with the whole suite green. Pin both halves together: the stamp in the producer that actually
// runs, and the verdict flip that proves the consumer joins on exactly that field.
test('verify-recapture.producer stamps the session the consumer joins on (AC-DR-02 join)', () => {
  for (const [label, producerPath] of [
    ['source', path.join(REPO_ROOT, 'extension', 'src', 'bin', 'microverse-runner.ts')],
    ['compiled', path.join(REPO_ROOT, 'extension', 'bin', 'microverse-runner.js')],
  ]) {
    const emission = extractRecaptureEmission(readFileSync(producerPath, 'utf8'));
    assert.ok(emission, `${label} producer must emit baseline_recapture_attempted via logActivityFn`);
    assert.match(
      emission,
      /session:\s*path\.basename\(opts\.sessionDir\)/,
      `${label} producer must stamp session=basename(sessionDir) — the consumer requires session equality`,
    );
  }

  const session = makeSession(baseState());
  const dataRoot = makeDataRoot();
  try {
    const { session: _unstamped, ...withoutSession } = recaptureEvent(path.basename(session));
    writeActivityEvents(dataRoot, [withoutSession]);
    const unattributed = runVerifier(session, dataRoot);
    assert.equal(unattributed.status, 1, 'an unstamped recapture event must not satisfy AC-DR-02');
    assert.equal(unattributed.runtimeArtifact.pass, false);
    assert.equal(unattributed.runtimeArtifact.failure_reason, 'recapture-event-missing');

    writeActivityEvents(dataRoot, [recaptureEvent(path.basename(session))]);
    const attributed = runVerifier(session, dataRoot);
    assert.equal(attributed.status, 0, attributed.stderr);
    assert.equal(attributed.runtimeArtifact.pass, true);
    assert.equal(attributed.runtimeArtifact.failure_reason, null);
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.no-event writes failing artifact when the activity log has no recapture event', () => {
  const session = makeSession(baseState());
  const dataRoot = makeDataRoot();
  try {
    writeActivityEvents(dataRoot, []);
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'recapture-event-missing');
    assert.match(result.runtimeArtifact.remediation_hint, /baseline_recapture_attempted/);
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.activity-missing is reported when the activity log directory is absent', () => {
  const session = makeSession(baseState());
  const dataRoot = makeDataRoot();
  try {
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'activity-missing');
    assert.match(result.runtimeArtifact.remediation_hint, /activity/);
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.wrong-phase fails when event timestamp is outside the anatomy-park window', () => {
  const session = makeSession(baseState(HISTORY_WINDOW_MISS));
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  try {
    writeActivityEvents(dataRoot, [recaptureEvent(sessionName, { iteration: 1 })]);
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'recapture-event-missing');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.stale-earlier-anatomy-window does not satisfy the latest anatomy run', () => {
  const session = makeSession(baseState([
    { step: 'pickle', timestamp: '2026-05-02T10:00:00.000Z' },
    { step: 'anatomy-park', timestamp: '2026-05-02T11:00:00.000Z' },
    { step: 'szechuan-sauce', timestamp: '2026-05-02T12:00:00.000Z' },
    { step: 'anatomy-park', timestamp: '2026-05-02T13:00:00.000Z' },
    { step: 'szechuan-sauce', timestamp: '2026-05-02T14:00:00.000Z' },
  ]));
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  try {
    // Lands in the FIRST anatomy window, not the latest.
    writeActivityEvents(dataRoot, [recaptureEvent(sessionName, { iteration: 1 })]);
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'recapture-event-missing');
    assert.deepEqual(result.runtimeArtifact.evidence.anatomy_windows, [
      { start: Date.parse('2026-05-02T13:00:00.000Z'), end: Date.parse('2026-05-02T14:00:00.000Z') },
    ]);
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.ignores timestamp-only history entries when closing the anatomy window', () => {
  const session = makeSession(baseState([
    { step: 'pickle', timestamp: '2026-05-02T10:00:00.000Z' },
    { step: 'anatomy-park', timestamp: '2026-05-02T11:00:00.000Z' },
    {
      timestamp: '2026-05-02T11:05:00.000Z',
      iteration: 3,
      from: 'OPEN',
      to: 'HALF_OPEN',
      reason: 'no_progress',
    },
    { step: 'szechuan-sauce', timestamp: '2026-05-02T12:00:00.000Z' },
  ]));
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  try {
    writeActivityEvents(dataRoot, [recaptureEvent(sessionName)]);
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runtimeArtifact.pass, true);
    assert.equal(result.runtimeArtifact.failure_reason, null);
    assert.deepEqual(result.runtimeArtifact.evidence.anatomy_windows, [
      { start: Date.parse('2026-05-02T11:00:00.000Z'), end: Date.parse('2026-05-02T12:00:00.000Z') },
    ]);
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// The phase-window arm is the ONLY thing separating "anatomy-park never recorded a phase
// transition" from "the recapture event never fired": both are pass:false / exit 1, so the
// failure_reason and its paired hint are the entire observable. Two trap doors (extension/CLAUDE.md
// `history`, src/bin/CLAUDE.md `pipeline-runner.ts`) name `phase-window-missing` as THE diagnostic
// for a regressed history append — and nothing pinned it: deleting the arm left the suite 75/75
// GREEN while every such regression reported as a missing event instead.
// A/B on ONE session — same name, same activity log, only the anatomy marker changes — so the
// event is provably findable in both halves and the phase marker is the sole cause.
test('verify-recapture.phase-window-missing is distinguished from a missing recapture event', () => {
  const session = makeSession(baseState([
    { step: 'pickle', timestamp: '2026-05-02T10:00:00.000Z' },
    { step: 'szechuan-sauce', timestamp: '2026-05-02T12:00:00.000Z' },
  ]));
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  try {
    // Present, attributed to THIS session, and inside the window the anatomy entry would open.
    writeActivityEvents(dataRoot, [recaptureEvent(sessionName)]);

    const noWindow = runVerifier(session, dataRoot);
    assert.equal(noWindow.status, 1);
    assert.equal(noWindow.runtimeArtifact.pass, false);
    assert.equal(noWindow.runtimeArtifact.failure_reason, 'phase-window-missing');
    assert.match(
      noWindow.runtimeArtifact.remediation_hint,
      /anatomy-park phase transitions are appended to state\.history/,
    );
    assert.deepEqual(noWindow.runtimeArtifact.evidence.anatomy_windows, []);

    // Same session, same event — only the anatomy-park marker is restored. This passes, which
    // proves the event was findable all along and the missing marker was the sole cause above.
    writeFileSync(
      path.join(session, 'state.json'),
      `${JSON.stringify(baseState(HISTORY_WINDOW_HIT), null, 2)}\n`,
    );
    const withWindow = runVerifier(session, dataRoot);
    assert.equal(withWindow.status, 0, withWindow.stderr);
    assert.equal(withWindow.runtimeArtifact.pass, true);
    assert.equal(withWindow.runtimeArtifact.failure_reason, null);
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.state-missing exits 2 and writes state-missing artifact', () => {
  const session = makeSession(null);
  const dataRoot = makeDataRoot();
  try {
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 2);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'state-missing');
    assert.match(result.runtimeArtifact.remediation_hint, /state\.json exists|recoverable state\.json\.tmp/);
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.unreadable-state exits 1 and writes state-unreadable artifact when state.json exists but cannot be read', () => {
  const session = makeSession(baseState());
  const dataRoot = makeDataRoot();
  const statePath = path.join(session, 'state.json');
  try {
    chmodSync(statePath, 0o000);
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'state-unreadable');
    assert.match(result.runtimeArtifact.remediation_hint, /StateManager\.read can parse/);
  } finally {
    chmodSync(statePath, 0o644);
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.corrupt-state writes unreadable-state artifact instead of leaving stale runtime evidence', () => {
  const session = makeSession(null);
  const dataRoot = makeDataRoot();
  writeFileSync(path.join(session, 'state.json'), '{bad json\n');
  try {
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'state-unreadable');
    assert.match(result.runtimeArtifact.remediation_hint, /StateManager\.read can parse/);
    assert.equal(result.runtimeArtifact.evidence.state_path, path.join(session, 'state.json'));
    assert.match(result.runtimeArtifact.evidence.read_error, /Expected property name|JSON/i);
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.unreadable-orphan-tmp is preserved instead of being deleted as invalid recovery input', () => {
  const session = makeSession(null);
  const dataRoot = makeDataRoot();
  const statePath = path.join(session, 'state.json');
  const orphanPath = `${statePath}.tmp.${DEAD_TMP_PID}`;
  writeFileSync(statePath, '{bad json\n');
  writeFileSync(orphanPath, `${JSON.stringify(recoverableState(HISTORY_WINDOW_HIT), null, 2)}\n`);
  try {
    chmodSync(orphanPath, 0o000);
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.pass, false);
    assert.equal(result.runtimeArtifact.failure_reason, 'state-unreadable');
    assert.equal(existsSync(orphanPath), true, 'unreadable orphan tmp must remain available for operator recovery');
  } finally {
    chmodSync(orphanPath, 0o644);
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.recovers orphan tmp state before evaluating the latest anatomy window', () => {
  const session = makeSession(null);
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  const statePath = path.join(session, 'state.json');
  const orphanPath = `${statePath}.tmp.${DEAD_TMP_PID}`;
  writeFileSync(statePath, '{bad json\n');
  // Only the tmp carries a window that brackets the event — a pass proves it was promoted.
  writeFileSync(orphanPath, `${JSON.stringify(recoverableState(HISTORY_WINDOW_HIT), null, 2)}\n`);
  writeActivityEvents(dataRoot, [recaptureEvent(sessionName, { iteration: 7 })]);
  try {
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runtimeArtifact.pass, true);
    assert.equal(result.runtimeArtifact.failure_reason, null);
    assert.equal(existsSync(orphanPath), false, 'orphan tmp should be consumed during recovery');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.recovers corrupt-base orphan tmp state even when the tmp pid has been reused by a live process', () => {
  const session = makeSession(null);
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  const statePath = path.join(session, 'state.json');
  const orphanPath = `${statePath}.tmp.${process.pid}`;
  writeFileSync(statePath, '{bad json\n');
  writeFileSync(orphanPath, `${JSON.stringify(recoverableState(HISTORY_WINDOW_HIT), null, 2)}\n`);
  utimesSync(statePath, new Date(500), new Date(500));
  utimesSync(orphanPath, new Date(1_000), new Date(1_000));
  writeActivityEvents(dataRoot, [recaptureEvent(sessionName, { iteration: 7 })]);
  try {
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runtimeArtifact.pass, true);
    assert.equal(result.runtimeArtifact.failure_reason, null);
    assert.equal(existsSync(orphanPath), false, 'reused live pid tmp should still be promoted when it predates the current process');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.promotes an equal-mtime dead orphan tmp over a readable base (R-CIFB-B tie-to-tmp)', () => {
  const session = makeSession(null);
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  const statePath = path.join(session, 'state.json');
  const orphanPath = `${statePath}.tmp.${DEAD_TMP_PID}`;
  // Readable base — its anatomy window does NOT bracket the event → would FAIL alone.
  writeFileSync(statePath, `${JSON.stringify(recoverableState(HISTORY_WINDOW_MISS), null, 2)}\n`);
  // Dead-pid orphan tmp — its window DOES bracket the event → would PASS.
  writeFileSync(orphanPath, `${JSON.stringify(recoverableState(HISTORY_WINDOW_HIT), null, 2)}\n`);
  // IDENTICAL forced mtime — the Linux coarse-mtime tie the fix must promote.
  utimesSync(statePath, new Date(1_000), new Date(1_000));
  utimesSync(orphanPath, new Date(1_000), new Date(1_000));
  writeActivityEvents(dataRoot, [recaptureEvent(sessionName, { iteration: 7 })]);
  try {
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runtimeArtifact.pass, true, 'equal-mtime tmp must be promoted, yielding a pass');
    assert.equal(result.runtimeArtifact.failure_reason, null);
    assert.equal(existsSync(orphanPath), false, 'promoted equal-mtime tmp should be consumed');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.does NOT clobber a good readable base with a future-schema orphan tmp (state-candidacy guard)', () => {
  const session = makeSession(null);
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  const statePath = path.join(session, 'state.json');
  const orphanPath = `${statePath}.tmp.${DEAD_TMP_PID}`;
  // Good, readable, current-schema base whose window brackets the event → PASS on its own.
  writeFileSync(statePath, `${JSON.stringify(recoverableState(HISTORY_WINDOW_HIT), null, 2)}\n`);
  // Dead-pid orphan tmp whose schema_version is ahead of the runtime (a deploy-reversion
  // residue), carrying a window that would MISS. StateManager's guarded recovery rejects it;
  // the unguarded generic promotion would renameSync it over the good base, destroying live
  // session state — and the verdict would flip to FAIL.
  writeFileSync(orphanPath, `${JSON.stringify(recoverableState(HISTORY_WINDOW_MISS, { schema_version: 6 }), null, 2)}\n`);
  // Equal (coarse) mtime — the tie under which the generic helper promotes the tmp.
  utimesSync(statePath, new Date(1_000), new Date(1_000));
  utimesSync(orphanPath, new Date(1_000), new Date(1_000));
  writeActivityEvents(dataRoot, [recaptureEvent(sessionName, { iteration: 7 })]);
  try {
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runtimeArtifact.pass, true, 'good base must be evaluated, not clobbered');
    assert.equal(result.runtimeArtifact.failure_reason, null);
    const preserved = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.notEqual(preserved.schema_version, 6, 'the future-schema tmp must NOT overwrite the good base');
    assert.deepEqual(preserved.history, HISTORY_WINDOW_HIT, 'the good base and its anatomy window must survive');
    assert.equal(existsSync(orphanPath), false, 'future-schema orphan tmp must be rejected, not left behind');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.preserves an UNREADABLE orphan tmp alongside a readable base (delete authority needs proof of garbage)', () => {
  const session = makeSession(null);
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  const statePath = path.join(session, 'state.json');
  const orphanPath = `${statePath}.tmp.${DEAD_TMP_PID}`;
  // Readable, valid base — so recovery takes the readable-base scanner, not the corrupt-base
  // one. The corrupt-base sibling of this case is already covered above; this path was not.
  writeFileSync(statePath, `${JSON.stringify(recoverableState(HISTORY_WINDOW_MISS, { iteration: 1 }), null, 2)}\n`);
  // A dead-pid orphan carrying a NEWER write. We cannot read it (EACCES), so we cannot know
  // that — which is exactly why it must survive: it may be the only copy, and an operator
  // can only repair permissions on a file that still exists.
  writeFileSync(orphanPath, `${JSON.stringify(recoverableState(HISTORY_WINDOW_HIT, { iteration: 99 }), null, 2)}\n`);
  writeActivityEvents(dataRoot, [recaptureEvent(sessionName, { iteration: 7 })]);
  try {
    chmodSync(orphanPath, 0o000);
    const result = runVerifier(session, dataRoot);
    // Unreadable ⇒ un-promotable: the verdict must come from the base's MISS window.
    assert.equal(result.runtimeArtifact.pass, false, 'an unreadable tmp must not be promoted over the base');
    assert.equal(
      existsSync(orphanPath),
      true,
      'unreadable orphan tmp must remain available for operator recovery, not be reaped as invalid',
    );
  } finally {
    chmodSync(orphanPath, 0o644);
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.recovers orphan tmp state when state.json is missing entirely', () => {
  const session = makeSession(null);
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  const statePath = path.join(session, 'state.json');
  const orphanPath = `${statePath}.tmp.${DEAD_TMP_PID}`;
  writeFileSync(orphanPath, `${JSON.stringify(recoverableState(HISTORY_WINDOW_HIT), null, 2)}\n`);
  writeActivityEvents(dataRoot, [recaptureEvent(sessionName, { iteration: 7 })]);
  try {
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runtimeArtifact.pass, true);
    assert.equal(result.runtimeArtifact.failure_reason, null);
    assert.equal(existsSync(statePath), true, 'missing base state should be recreated from orphan tmp');
    assert.equal(existsSync(orphanPath), false, 'orphan tmp should be consumed during recovery');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.recovers missing-base orphan tmp state even when the tmp pid has been reused by a live process', () => {
  const session = makeSession(null);
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  const statePath = path.join(session, 'state.json');
  const orphanPath = `${statePath}.tmp.${process.pid}`;
  writeFileSync(orphanPath, `${JSON.stringify(recoverableState(HISTORY_WINDOW_HIT), null, 2)}\n`);
  utimesSync(orphanPath, new Date(1_000), new Date(1_000));
  writeActivityEvents(dataRoot, [recaptureEvent(sessionName, { iteration: 7 })]);
  try {
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runtimeArtifact.pass, true);
    assert.equal(result.runtimeArtifact.failure_reason, null);
    assert.equal(existsSync(statePath), true, 'missing base state should be recreated from a reused-live-pid tmp snapshot');
    assert.equal(existsSync(orphanPath), false, 'reused live pid tmp should be consumed during recovery');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.session-runtime-artifacts do not overwrite evidence from another session', () => {
  const repoRuntimeArtifact = path.join(REPO_ROOT, 'bundle', 'ac-dr-02.runtime.json');
  const repoRuntimeBaseline = readOptionalFile(repoRuntimeArtifact);
  const passSession = makeSession(baseState());
  const failSession = makeSession(baseState());
  const dataRoot = makeDataRoot();
  try {
    writeActivityEvents(dataRoot, [recaptureEvent(path.basename(passSession))]);

    const passResult = runVerifier(passSession, dataRoot);
    assert.equal(passResult.status, 0, passResult.stderr);
    assert.equal(passResult.runtimeArtifact.pass, true);

    const passArtifactSnapshot = readFileSync(passResult.runtimeArtifactPath, 'utf8');
    // Same activity log, same window — only the session attribution differs.
    const failResult = runVerifier(failSession, dataRoot);
    assert.equal(failResult.status, 1, failResult.stderr);
    assert.equal(failResult.runtimeArtifact.pass, false);
    assert.equal(failResult.runtimeArtifact.failure_reason, 'recapture-event-missing');

    assert.equal(readFileSync(passResult.runtimeArtifactPath, 'utf8'), passArtifactSnapshot);
    assert.equal(
      readOptionalFile(repoRuntimeArtifact),
      repoRuntimeBaseline,
      'repo-global runtime artifact must remain untouched when a session root is provided',
    );
  } finally {
    rmSync(passSession, { recursive: true, force: true });
    rmSync(failSession, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// The tracked bundle/ac-dr-02.json used to be rewritten with a hardcoded `pass: true` on
// every run, so verify-bundle reported AC-DR-02 PASS even while this verifier reported FAIL
// for the very same session. Neither gate may claim AC-DR-02 passed when recapture never fired.
test('verify-recapture.failing-run-cannot-false-green-the-AC-DR-02-bundle-gate', () => {
  const failSession = makeSession(baseState());
  const dataRoot = makeDataRoot();
  try {
    writeActivityEvents(dataRoot, []);
    const failResult = runVerifier(failSession, dataRoot);
    assert.equal(failResult.status, 1, failResult.stderr);
    assert.equal(failResult.runtimeArtifact.pass, false);
    assert.equal(failResult.runtimeArtifact.failure_reason, 'recapture-event-missing');

    assert.equal(existsSync(TRACKED_ARTIFACT), false, 'a failing run must not leave passing tracked evidence');

    const bundle = verifyBundle({ repoRoot: REPO_ROOT, ac: 'AC-DR-02' });
    assert.notEqual(bundle.exitCode, 0, 'AC-DR-02 must not PASS the bundle gate while recapture verification fails');
    assert.match(bundle.stderr, /AC-DR-02: missing bundle\/ac-dr-02\.json/);
  } finally {
    rmSync(failSession, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

test('verify-recapture.no-session writes runtime artifact outside the tracked repo bundle tree', () => {
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'verify-recapture-home-'));
  const repoRuntimeArtifact = path.join(REPO_ROOT, 'bundle', 'ac-dr-02.runtime.json');
  const repoRuntimeBaseline = readOptionalFile(repoRuntimeArtifact);
  const runtimeArtifact = path.join(fakeHome, '.local', 'share', 'pickle-rick', 'bundle', 'ac-dr-02.runtime.json');

  try {
    const result = spawnSync(process.execPath, [CLI], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
      env: {
        ...HERMETIC_ENV,
        HOME: fakeHome,
      },
    });

    assert.equal(result.status, 2);
    assert.equal(existsSync(TRACKED_ARTIFACT), false);
    assert.equal(readOptionalFile(repoRuntimeArtifact), repoRuntimeBaseline);
    assert.equal(runtimeArtifact.startsWith(path.join(REPO_ROOT, 'bundle')), false);

    const artifact = JSON.parse(readFileSync(runtimeArtifact, 'utf8'));
    assert.equal(artifact.pass, false);
    assert.equal(artifact.failure_reason, 'state-missing');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Orphan-tmp delete authority — THIRD scanner (scope.json).
//
// The invariant above ("an orphan .tmp.<pid> may be unlinked ONLY when positively
// proven garbage") is a property of the SHARED recovery primitive, not of any one
// caller. scope-resolver.ts hand-rolled its own scan and re-forked BOTH halves of
// the delete rule: it unlinked on a catch that also wrapped the tmp's own
// readFileSync (so an EACCES tmp read as garbage), and it discarded on `<=`
// baseMtimeMs (so an equal-mtime tmp — the coarse-mtime tie R-CIFB-B says the tmp
// WINS — was deleted). Both destroy the only valid copy of the scope.
//
// These two cases pin scope.json to the same primitive. refreshScope() is the only
// caller of that read.
// ---------------------------------------------------------------------------

function makeScopeRepo() {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'verify-recapture-scope-repo-')));
  const git = (...args) => execFileSync('git', args, { cwd: repo, timeout: SPAWN_TIMEOUT_MS });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@test.local');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repo, 'seed.txt'), 'seed');
  git('add', '-A');
  git('commit', '--no-gpg-sign', '-q', '-m', 'seed');
  return repo;
}

function scopeJson(allowedPaths) {
  return {
    version: 1,
    mode: 'paths',
    strategy: 'strict',
    base_ref: null,
    base_sha: null,
    head_sha: null,
    allowed_paths: allowedPaths,
    resolved_at: '2026-05-02T10:00:00.000Z',
    refresh_history: [],
  };
}

test('scope.json orphan tmp: an UNREADABLE tmp is preserved, not reaped as garbage', async () => {
  const { refreshScope } = await import('../services/scope-resolver.js');
  const session = realpathSync(mkdtempSync(path.join(tmpdir(), 'verify-recapture-scope-')));
  const repo = makeScopeRepo();
  const scopePath = path.join(session, 'scope.json');
  const orphanPath = `${scopePath}.tmp.${DEAD_TMP_PID}`;
  try {
    writeFileSync(scopePath, `${JSON.stringify(scopeJson(['base.ts']), null, 2)}\n`);
    writeFileSync(orphanPath, `${JSON.stringify(scopeJson(['orphan.ts']), null, 2)}\n`);
    // Unreadable is NOT garbage — it is a snapshot behind a permissions problem an
    // operator can still repair. A scan that deletes it destroys the only copy.
    chmodSync(orphanPath, 0o000);

    refreshScope(session, 'anatomy-park', { repoRoot: repo, log: () => {} });

    assert.equal(existsSync(orphanPath), true, 'unreadable orphan tmp must survive the scan');
  } finally {
    chmodSync(orphanPath, 0o644);
    rmSync(session, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('scope.json orphan tmp: an equal-mtime dead tmp is promoted over a readable base', async () => {
  const { refreshScope } = await import('../services/scope-resolver.js');
  const session = realpathSync(mkdtempSync(path.join(tmpdir(), 'verify-recapture-scope-tie-')));
  const repo = makeScopeRepo();
  const scopePath = path.join(session, 'scope.json');
  const orphanPath = `${scopePath}.tmp.${DEAD_TMP_PID}`;
  try {
    writeFileSync(scopePath, `${JSON.stringify(scopeJson(['base.ts']), null, 2)}\n`);
    writeFileSync(orphanPath, `${JSON.stringify(scopeJson(['orphan.ts']), null, 2)}\n`);
    // Force the coarse-mtime tie (Linux ext4 granularity). The tmp is written AFTER
    // its base, so on a tie the tmp is the more-recent intent and MUST win.
    const tie = new Date(1_700_000_000_000);
    utimesSync(scopePath, tie, tie);
    utimesSync(orphanPath, tie, tie);

    const refreshed = refreshScope(session, 'anatomy-park', { repoRoot: repo, log: () => {} });

    assert.deepEqual(refreshed.allowed_paths, ['orphan.ts'], 'equal-mtime tmp must win the tie');
    assert.equal(existsSync(orphanPath), false, 'the winning tmp is consumed by promotion');
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// AP-BIN-ITER16-01. `phase-window-missing` is settled by state.history alone, but the verifier
// used to scan the activity log first anyway — and it passed `NaN` as the day bound, which
// DISABLES the bound, so the FAILURE path read every retained activity file on the host
// (measured: 7 files / 381,795 events / 1358MB heap / 3.4s after six days). The A/B below is one
// fixture with four events split across two days; only the anatomy-park marker changes.
//   no window -> activity_count null   (nothing was read, and the artifact says so)
//   window    -> activity_count 2      (read, and the pre-window DAY was bounded out of the scan)
// Reverting the guard reddens the first half with `activity_count: 4` — the two pre-window-day
// events reappear, which is the unbounded scan showing itself. The second half is what stops the
// pin decaying into "the count is always null".
const PRE_WINDOW_DAY_TS = '2026-04-29T12:00:00.000Z'; // ~47h before the window: earlier local day in every TZ
test('verify-recapture.no anatomy window skips the activity scan instead of reading every retained day', () => {
  const session = makeSession(baseState([
    { step: 'pickle', timestamp: '2026-05-02T10:00:00.000Z' },
    { step: 'szechuan-sauce', timestamp: '2026-05-02T12:00:00.000Z' },
  ]));
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  try {
    writeActivityEvents(dataRoot, [
      recaptureEvent(sessionName, { ts: PRE_WINDOW_DAY_TS, iteration: 1 }),
      { ts: PRE_WINDOW_DAY_TS, event: 'iteration_start', source: 'pickle', session: sessionName },
      recaptureEvent(sessionName),
      { ts: '2026-05-02T11:20:00.000Z', event: 'iteration_start', source: 'pickle', session: sessionName },
    ]);

    const noWindow = runVerifier(session, dataRoot);
    assert.equal(noWindow.status, 1);
    assert.equal(noWindow.runtimeArtifact.failure_reason, 'phase-window-missing');
    assert.equal(
      noWindow.runtimeArtifact.evidence.activity_count,
      null,
      'a verdict fixed by state.history must not scan the activity log at all',
    );

    // Same session, same four events — only the anatomy-park marker is restored.
    writeFileSync(
      path.join(session, 'state.json'),
      `${JSON.stringify(baseState(HISTORY_WINDOW_HIT), null, 2)}\n`,
    );
    const withWindow = runVerifier(session, dataRoot);
    assert.equal(withWindow.status, 0, withWindow.stderr);
    assert.equal(withWindow.runtimeArtifact.pass, true);
    assert.equal(
      withWindow.runtimeArtifact.evidence.activity_count,
      2,
      'the windowed scan reads the window day only — the pre-window day stays bounded out',
    );
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// The activity-missing arm outranks phase-window-missing, and the guard above rewrote the
// predicate that decides that order (`activity === null` -> `activityFiles === null`). With both
// inputs absent at once the old expression would now read `activity === null` as activity-missing
// for a session whose real defect is the missing phase marker, so pin the cell directly.
test('verify-recapture.absent activity dir still outranks a missing anatomy window', () => {
  const session = makeSession(baseState([
    { step: 'pickle', timestamp: '2026-05-02T10:00:00.000Z' },
  ]));
  const dataRoot = makeDataRoot();
  try {
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 1);
    assert.equal(result.runtimeArtifact.failure_reason, 'activity-missing');
    assert.deepEqual(result.runtimeArtifact.evidence.anatomy_windows, []);
  } finally {
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// AP-BIN-ITER17-01. `readActivityEventsSince` swallowed a per-file read error with `catch
// { continue; }`, so an in-window day the verifier could NOT read was scored as a day that
// held no match: the artifact reported `recapture-event-missing` with `activity_count: 0` —
// an affirmative claim that a complete scan found nothing — and pointed the operator at the
// PRODUCER ("ensure anatomy-park logs baseline_recapture_attempted") when anatomy-park had
// logged it and the real repair was the log's permissions. The same file already draws this
// distinction twice (`failureReasonForStateReadError` for state.json, `activity-missing` for
// an unlistable activity DIR); only the day-file read dropped it.
//
// A/B on ONE session, ONE event, ONE day file — only the file's MODE changes between halves.
// The readable half proves the event is genuinely findable, so the unreadable half cannot
// decay into "this fixture never had a match in the first place".
test('verify-recapture.an unreadable in-window activity day reports no-measurement, not a missing recapture', () => {
  const session = makeSession(baseState(HISTORY_WINDOW_HIT));
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  const activityDir = writeActivityEvents(dataRoot, [recaptureEvent(sessionName)]);
  const windowDay = path.join(activityDir, `${formatLocalDateKey(new Date(RECAPTURE_TS))}.jsonl`);
  try {
    const readable = runVerifier(session, dataRoot);
    assert.equal(readable.status, 0, readable.stderr);
    assert.equal(readable.runtimeArtifact.pass, true);
    assert.equal(
      readable.runtimeArtifact.evidence.activity_count,
      1,
      'the readable half must actually find the event, or the unreadable half proves nothing',
    );

    chmodSync(windowDay, 0o000);
    const unreadable = runVerifier(session, dataRoot);
    assert.equal(unreadable.status, 1);
    assert.equal(unreadable.runtimeArtifact.pass, false);
    assert.notEqual(
      unreadable.runtimeArtifact.failure_reason,
      'recapture-event-missing',
      'a day we could not read is the absence of evidence, not evidence of absence',
    );
    assert.equal(unreadable.runtimeArtifact.failure_reason, 'activity-missing');
    assert.equal(
      unreadable.runtimeArtifact.evidence.activity_count,
      null,
      'nothing was measured, and the artifact must say so instead of reporting a count of 0',
    );
    assert.match(unreadable.runtimeArtifact.remediation_hint, /activity log directory .* readable/);
  } finally {
    chmodSync(windowDay, 0o644);
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

// The bound still runs BEFORE the read, so an unreadable day the verdict does not need stays
// irrelevant — AP-BIN-ITER16-01's day bound must not be turned into a no-measurement tripwire
// by the guard above. Pre-window day unreadable + in-window day readable => the AC still passes.
test('verify-recapture.an unreadable PRE-window day is bounded out and cannot force no-measurement', () => {
  const session = makeSession(baseState(HISTORY_WINDOW_HIT));
  const dataRoot = makeDataRoot();
  const sessionName = path.basename(session);
  const activityDir = writeActivityEvents(dataRoot, [
    { ts: PRE_WINDOW_DAY_TS, event: 'iteration_start', source: 'pickle', session: sessionName },
    recaptureEvent(sessionName),
  ]);
  const preWindowDay = path.join(activityDir, `${formatLocalDateKey(new Date(PRE_WINDOW_DAY_TS))}.jsonl`);
  try {
    chmodSync(preWindowDay, 0o000);
    const result = runVerifier(session, dataRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.runtimeArtifact.pass, true);
    assert.equal(result.runtimeArtifact.failure_reason, null);
    assert.equal(result.runtimeArtifact.evidence.activity_count, 1);
  } finally {
    chmodSync(preWindowDay, 0o644);
    rmSync(session, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
