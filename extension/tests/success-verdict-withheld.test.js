// @tier: fast
//
// WS-B (f8559470): a ticket that flipped Done over a red `worker_gate_tests_verdict`
// must withhold the pipeline's success verdict — raise the existing
// `counters.nonConvergent` term so `unsuccessful` becomes true, pipeline-status is
// not `completed`, and closer-release is skipped. The run still executes every
// remaining phase (park-and-flag, no new abort). A clean run with no red test
// verdicts is unaffected.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { finalizePhaseSuccess } from '../bin/pipeline-runner.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'success-verdict-withheld-'));
}

function writeState(statePath, iteration = 1, activity = []) {
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    working_dir: '/tmp',
    step: 'completed',
    iteration,
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
    exit_reason: null,
    activity,
  }));
}

// ROOT G2 (ticket 6445c637): `worker_gate_tests_verdict` persists only the three-valued
// disposition string — the failure list itself lives in the `worker_gate_failed` activity
// event's `failures` array (spawn-morty.ts:finalizeFailedWorkerGate/flagOffRepoGateRed),
// appended to `state.json.activity`. A red ticket corroborated by a non-empty failure list
// there is a MEASURED red; every fixture below that means "this ticket really failed its
// gate" must carry one, or the withhold this suite exists to prove now correctly declines.
function workerGateFailedEvent(ticketId, failures) {
  return {
    event: 'worker_gate_failed',
    ticket_id: ticketId,
    gate_phase: 'test:fast',
    failures,
    retry_count: 0,
    ts: new Date().toISOString(),
  };
}

function makeRuntime(dir) {
  const statePath = path.join(dir, 'state.json');
  return {
    runtime: {
      sessionDir: dir,
      statePath,
      config: { phases: [{}, {}, {}, {}] },
      workingDir: '/tmp',
      log: () => {},
    },
    statePath,
    cancelMarker: path.join(dir, 'pipeline-cancel'),
  };
}

function writeTicket(sessionDir, ticketId, { status, testsVerdict, title } = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = [
    '---',
    `id: ${ticketId}`,
    `title: "${title || ticketId}"`,
    `status: ${status}`,
    'order: 1',
  ];
  if (testsVerdict !== undefined) lines.push(`worker_gate_tests_verdict: ${testsVerdict}`);
  lines.push('---', '', `# ${title || ticketId}`, '');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
}

function readStatus(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));
}

function makeCounters() {
  return { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
}

describe('WS-B success-verdict-withheld (pickle phase, Done over red test verdict)', () => {
  test('AC-B1: a ticket Done over worker_gate_tests_verdict: red raises nonConvergent and names it', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('aaaaaaaa', [{ name: 'not ok 1 - real test', file: 'foo.test.js', message: 'AssertionError' }]),
    ]);
    writeTicket(dir, 'aaaaaaaa', { status: 'Done', testsVerdict: 'red', title: 'red ticket' });
    const logs = [];
    runtime.log = (m) => logs.push(m);
    const counters = makeCounters();

    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);

    assert.equal(outcome.action, 'continue');
    assert.equal(counters.nonConvergent, 1, 'nonConvergent must be raised for the red-test Done ticket');
    assert.ok(
      counters.phaseDispositions.pickle && counters.phaseDispositions.pickle.includes('aaaaaaaa'),
      'the offending ticket id must be named in the disposition',
    );
    assert.ok(
      logs.some((l) => l.includes('aaaaaaaa') && l.includes('red')),
      'the run summary log must name the offending ticket and its verdict',
    );

    fs.rmSync(dir, { recursive: true });
  });

  test('AC-B2: phase count is unchanged versus a clean run — the phase still counts completed', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('bbbbbbbb', [{ name: 'not ok 1 - real test', file: 'foo.test.js', message: 'AssertionError' }]),
    ]);
    writeTicket(dir, 'bbbbbbbb', { status: 'Done', testsVerdict: 'red' });
    const counters = makeCounters();

    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);

    assert.equal(outcome.action, 'continue', 'the run must still execute every remaining phase');
    assert.equal(counters.completed, 1, 'the pickle phase still counts completed — no new abort');
    fs.rmSync(dir, { recursive: true });
  });

  test('AC-B4: a bundle with no red test verdicts is unaffected — success reported, release plan runs', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath);
    writeTicket(dir, 'cccccccc', { status: 'Done', testsVerdict: 'green' });
    writeTicket(dir, 'dddddddd', { status: 'Done' }); // no verdict field at all
    const counters = makeCounters();

    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);

    assert.equal(outcome.action, 'continue');
    assert.equal(counters.completed, 1);
    assert.equal(counters.nonConvergent, 0, 'a clean run must not be flagged non-convergent');
    assert.equal(counters.phaseDispositions.pickle, undefined);

    const status = readStatus(dir);
    assert.equal(status.status, 'running');
    fs.rmSync(dir, { recursive: true });
  });

  test('multiple red-test Done tickets are all named and counted', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('eeeeeeee', [{ name: 'not ok 1 - real test', file: 'foo.test.js', message: 'AssertionError' }]),
      workerGateFailedEvent('ffffffff', [{ name: 'not ok 1 - real test', file: 'bar.test.js', message: 'AssertionError' }]),
    ]);
    writeTicket(dir, 'eeeeeeee', { status: 'Done', testsVerdict: 'red' });
    writeTicket(dir, 'ffffffff', { status: 'Done', testsVerdict: 'red' });
    writeTicket(dir, 'gggggggg', { status: 'Done', testsVerdict: 'green' });
    const logs = [];
    runtime.log = (m) => logs.push(m);
    const counters = makeCounters();

    finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);

    assert.equal(counters.nonConvergent, 2);
    assert.ok(counters.phaseDispositions.pickle.includes('eeeeeeee'));
    assert.ok(counters.phaseDispositions.pickle.includes('ffffffff'));
    assert.ok(!counters.phaseDispositions.pickle.includes('gggggggg'));
    fs.rmSync(dir, { recursive: true });
  });

  test('non-pickle phases are unaffected by the red-test check', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath);
    writeTicket(dir, 'hhhhhhhh', { status: 'Done', testsVerdict: 'red' });
    const counters = makeCounters();

    // citadel has its own exit-code-only path and never scans tickets for this check.
    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'citadel', 1, runtime.log);

    assert.equal(outcome.action, 'continue');
    assert.equal(counters.nonConvergent, 0);
    fs.rmSync(dir, { recursive: true });
  });
});

// ROOT G2 (ticket 6445c637): an EMPTY worker gate failure list may not read as red. Only a
// MEASURED red — a `worker_gate_tests_verdict: red` corroborated by a non-empty
// `worker_gate_failed.failures` list in `state.json.activity` — may withhold the success
// verdict. An empty-because-unmeasured verdict (no corroborating event, or one with an empty
// failure list) is reported as a DISTINCT `done_over_unmeasured_worker_gate_tests` disposition
// and the phase loop continues — never a halt, never an abort condition.
describe('ROOT G2: an empty worker gate failure list may not read as red', () => {
  test('positive control: a genuine measured red (non-empty failure list) still withholds', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('aaa11111', [{ name: 'not ok 1 - some real test', file: 'foo.test.js', message: 'AssertionError' }]),
    ]);
    writeTicket(dir, 'aaa11111', { status: 'Done', testsVerdict: 'red' });
    const counters = makeCounters();

    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);

    assert.equal(counters.nonConvergent, 1, 'a measured red must still withhold the success verdict');
    assert.equal(counters.phaseDispositions.pickle, 'done_over_red_worker_gate_tests:aaa11111');
    assert.equal(outcome.action, 'continue', 'withholding is not a halt');
    assert.equal(counters.completed, 1, 'the phase still executed to completion');
    fs.rmSync(dir, { recursive: true });
  });

  test('negative control: a red with NO corroborating worker_gate_failed event does not withhold', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 1, []); // no worker_gate_failed event for this ticket at all
    writeTicket(dir, 'bbb22222', { status: 'Done', testsVerdict: 'red' });
    const counters = makeCounters();

    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);

    assert.equal(counters.nonConvergent, 0, 'an unmeasured red must not withhold the success verdict');
    assert.equal(counters.phaseDispositions.pickle, 'done_over_unmeasured_worker_gate_tests:bbb22222');
    assert.equal(outcome.action, 'continue', 'an unmeasured red is never a halt or abort condition');
    assert.equal(counters.completed, 1, 'the phase loop must continue on an unmeasured red');
    fs.rmSync(dir, { recursive: true });
  });

  test('negative control: a red whose worker_gate_failed event carries an EMPTY failure list does not withhold', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 1, [workerGateFailedEvent('ccc33333', [])]);
    writeTicket(dir, 'ccc33333', { status: 'Done', testsVerdict: 'red' });
    const counters = makeCounters();

    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);

    assert.equal(counters.nonConvergent, 0, 'an empty failure list must not read as a measured red');
    assert.equal(counters.phaseDispositions.pickle, 'done_over_unmeasured_worker_gate_tests:ccc33333');
    assert.equal(outcome.action, 'continue');
    fs.rmSync(dir, { recursive: true });
  });

  test('the LATEST worker_gate_failed entry for a ticket is authoritative, not the first', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    // First attempt was genuinely measured; the retry that produced the CURRENT
    // frontmatter verdict reported no evidence — the current verdict is unmeasured.
    writeState(statePath, 1, [
      workerGateFailedEvent('ddd44444', [{ name: 'not ok 1 - real', file: 'foo.test.js', message: 'boom' }]),
      workerGateFailedEvent('ddd44444', []),
    ]);
    writeTicket(dir, 'ddd44444', { status: 'Done', testsVerdict: 'red' });
    const counters = makeCounters();

    finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);

    assert.equal(counters.nonConvergent, 0, 'the latest (empty) entry must govern, not the earlier measured one');
    assert.equal(counters.phaseDispositions.pickle, 'done_over_unmeasured_worker_gate_tests:ddd44444');
    fs.rmSync(dir, { recursive: true });
  });

  test('mixed roster: measured and unmeasured offenders are reported distinctly, and only the measured one withholds', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('eee55555', [{ name: 'not ok 1 - real', file: 'foo.test.js', message: 'boom' }]),
      workerGateFailedEvent('fff66666', []),
    ]);
    writeTicket(dir, 'eee55555', { status: 'Done', testsVerdict: 'red' });
    writeTicket(dir, 'fff66666', { status: 'Done', testsVerdict: 'red' });
    const counters = makeCounters();

    finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);

    assert.equal(counters.nonConvergent, 1, 'only the measured offender counts toward withholding');
    assert.equal(
      counters.phaseDispositions.pickle,
      'done_over_unmeasured_worker_gate_tests:fff66666; done_over_red_worker_gate_tests:eee55555',
      'both dispositions must be named, distinctly',
    );
    fs.rmSync(dir, { recursive: true });
  });

  test('a green or not_run verdict is unaffected by activity contents', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 1, []);
    writeTicket(dir, 'ggg77777', { status: 'Done', testsVerdict: 'green' });
    const counters = makeCounters();

    finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);

    assert.equal(counters.nonConvergent, 0);
    assert.equal(counters.phaseDispositions.pickle, undefined);
    fs.rmSync(dir, { recursive: true });
  });
});
