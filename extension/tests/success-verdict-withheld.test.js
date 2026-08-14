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

function writeState(statePath, iteration = 1) {
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
  }));
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
    writeState(statePath);
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
    writeState(statePath);
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
    writeState(statePath);
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
