// @tier: integration
/**
 * spark-smoke-gate.test.js — R-CNAR-6: Spark codex smoke-run gate.
 *
 * SSG-1 (gate-enforced first-2-must-pass):
 *   Gate active (backend=codex, codex_model=gpt-5.3-codex-spark).
 *   - First 2 tickets Done → action=allow.
 *   - Ticket[1] Failed with codex-CLI error → action=halt, rule=first_two_failed.
 *
 * SSG-2 (halt-on-3-consecutive-codex-failures):
 *   First 2 tickets Done; 3 consecutive Failed-with-codex-error tickets
 *   → action=halt, rule=three_consecutive_failed.
 *
 * SSG-3 (bypass-via-skip-flag):
 *   Same scaffold that would halt, but state.flags.skip_smoke_gate_reason='testing'
 *   → action=bypass, reason='testing'.
 *
 * SSG-4 (sanity — gate inactive on claude backend):
 *   Halting scaffold with backend=claude → action=allow, rule=gate_inactive.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateSparkSmokeGate } from '../../bin/mux-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

function makeTmpDir(prefix = 'ssg-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, status, order) {
  const dir = path.join(sessionDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `rick_ticket_${id}.md`),
    `---\nid: ${id}\ntitle: "Ticket ${id}"\nstatus: ${status}\norder: ${order}\n---\n# Description\nTest.\n`,
  );
  return dir;
}

function writeWorkerLogWithCodexError(ticketDir, pid = 1234) {
  fs.writeFileSync(
    path.join(ticketDir, `worker_session_${pid}.log`),
    [
      '[12:00:00] worker spawn',
      '[12:00:01] codex error: stream disconnected',
      '[12:00:02] HTTP 429 Too Many Requests',
    ].join('\n') + '\n',
  );
}

function makeState(overrides = {}) {
  return {
    backend: 'codex',
    codex_model: 'gpt-5.3-codex-spark',
    flags: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SSG-1: gate-enforced first-2-must-pass
// ---------------------------------------------------------------------------

test('SSG-1a: first 2 Done → allow', () => {
  const tmp = makeTmpDir('ssg1a-');
  try {
    writeTicket(tmp, 't1', 'Done', 10);
    writeTicket(tmp, 't2', 'Done', 20);
    writeTicket(tmp, 't3', 'Todo', 30);
    writeTicket(tmp, 't4', 'Todo', 40);
    writeTicket(tmp, 't5', 'Todo', 50);

    const decision = evaluateSparkSmokeGate(makeState(), tmp);
    assert.equal(decision.action, 'allow');
    assert.equal(decision.rule, 'allow');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SSG-1b: ticket[1] Failed with codex-CLI error → halt rule=first_two_failed', () => {
  const tmp = makeTmpDir('ssg1b-');
  try {
    writeTicket(tmp, 't1', 'Done', 10);
    const t2Dir = writeTicket(tmp, 't2', 'Failed', 20);
    writeWorkerLogWithCodexError(t2Dir);
    writeTicket(tmp, 't3', 'Todo', 30);

    const decision = evaluateSparkSmokeGate(makeState(), tmp);
    assert.equal(decision.action, 'halt');
    assert.equal(decision.rule, 'first_two_failed');
    assert.match(decision.reason, /first 2 tickets must complete/);
    assert.match(decision.reason, /t2/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SSG-1c: ticket[0] Failed without codex-CLI error → no halt (criterion needs breadcrumb)', () => {
  const tmp = makeTmpDir('ssg1c-');
  try {
    writeTicket(tmp, 't1', 'Failed', 10);
    writeTicket(tmp, 't2', 'Todo', 20);
    writeTicket(tmp, 't3', 'Todo', 30);

    const decision = evaluateSparkSmokeGate(makeState(), tmp);
    assert.equal(decision.action, 'allow');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SSG-2: halt-on-3-consecutive-codex-failures
// ---------------------------------------------------------------------------

test('SSG-2a: 3 consecutive failures with codex errors → halt rule=three_consecutive_failed', () => {
  const tmp = makeTmpDir('ssg2a-');
  try {
    writeTicket(tmp, 't1', 'Done', 10);
    writeTicket(tmp, 't2', 'Done', 20);
    const t3Dir = writeTicket(tmp, 't3', 'Failed', 30);
    writeWorkerLogWithCodexError(t3Dir, 1001);
    const t4Dir = writeTicket(tmp, 't4', 'Failed', 40);
    writeWorkerLogWithCodexError(t4Dir, 1002);
    const t5Dir = writeTicket(tmp, 't5', 'Failed', 50);
    writeWorkerLogWithCodexError(t5Dir, 1003);

    const decision = evaluateSparkSmokeGate(makeState(), tmp);
    assert.equal(decision.action, 'halt');
    assert.equal(decision.rule, 'three_consecutive_failed');
    assert.match(decision.reason, /3 consecutive ticket failures/);
    assert.match(decision.reason, /t5/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SSG-2b: 2 consecutive failures + 1 Done + 1 failure → no halt (run reset)', () => {
  const tmp = makeTmpDir('ssg2b-');
  try {
    writeTicket(tmp, 't1', 'Done', 10);
    writeTicket(tmp, 't2', 'Done', 20);
    const t3Dir = writeTicket(tmp, 't3', 'Failed', 30);
    writeWorkerLogWithCodexError(t3Dir, 1001);
    const t4Dir = writeTicket(tmp, 't4', 'Failed', 40);
    writeWorkerLogWithCodexError(t4Dir, 1002);
    writeTicket(tmp, 't5', 'Done', 50);
    const t6Dir = writeTicket(tmp, 't6', 'Failed', 60);
    writeWorkerLogWithCodexError(t6Dir, 1003);

    const decision = evaluateSparkSmokeGate(makeState(), tmp);
    assert.equal(decision.action, 'allow');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SSG-2c: 3 consecutive failures WITHOUT codex error breadcrumbs → no halt', () => {
  const tmp = makeTmpDir('ssg2c-');
  try {
    writeTicket(tmp, 't1', 'Done', 10);
    writeTicket(tmp, 't2', 'Done', 20);
    writeTicket(tmp, 't3', 'Failed', 30);
    writeTicket(tmp, 't4', 'Failed', 40);
    writeTicket(tmp, 't5', 'Failed', 50);

    const decision = evaluateSparkSmokeGate(makeState(), tmp);
    assert.equal(decision.action, 'allow');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SSG-3: bypass-via-skip-flag
// ---------------------------------------------------------------------------

test('SSG-3: skip_smoke_gate_reason short-circuits to bypass', () => {
  const tmp = makeTmpDir('ssg3-');
  try {
    writeTicket(tmp, 't1', 'Done', 10);
    const t2Dir = writeTicket(tmp, 't2', 'Failed', 20);
    writeWorkerLogWithCodexError(t2Dir);

    const state = makeState({ flags: { skip_smoke_gate_reason: 'testing' } });
    const decision = evaluateSparkSmokeGate(state, tmp);
    assert.equal(decision.action, 'bypass');
    assert.equal(decision.reason, 'testing');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SSG-3b: empty/whitespace skip_smoke_gate_reason does NOT bypass', () => {
  const tmp = makeTmpDir('ssg3b-');
  try {
    writeTicket(tmp, 't1', 'Done', 10);
    const t2Dir = writeTicket(tmp, 't2', 'Failed', 20);
    writeWorkerLogWithCodexError(t2Dir);

    const state = makeState({ flags: { skip_smoke_gate_reason: '   ' } });
    const decision = evaluateSparkSmokeGate(state, tmp);
    assert.equal(decision.action, 'halt');
    assert.equal(decision.rule, 'first_two_failed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SSG-4: gate inactive on non-codex / non-spark sessions
// ---------------------------------------------------------------------------

test('SSG-4a: backend=claude → gate inactive (allow)', () => {
  const tmp = makeTmpDir('ssg4a-');
  try {
    writeTicket(tmp, 't1', 'Done', 10);
    const t2Dir = writeTicket(tmp, 't2', 'Failed', 20);
    writeWorkerLogWithCodexError(t2Dir);

    const state = makeState({ backend: 'claude' });
    const decision = evaluateSparkSmokeGate(state, tmp);
    assert.equal(decision.action, 'allow');
    assert.equal(decision.rule, 'gate_inactive');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SSG-4b: backend=codex but non-spark model → gate inactive', () => {
  const tmp = makeTmpDir('ssg4b-');
  try {
    writeTicket(tmp, 't1', 'Done', 10);
    const t2Dir = writeTicket(tmp, 't2', 'Failed', 20);
    writeWorkerLogWithCodexError(t2Dir);

    const state = makeState({ codex_model: 'gpt-5.4-codex' });
    const decision = evaluateSparkSmokeGate(state, tmp);
    assert.equal(decision.action, 'allow');
    assert.equal(decision.rule, 'gate_inactive');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SSG-4c: spark variant model (gpt-5.3-codex-spark-mini) → gate active', () => {
  const tmp = makeTmpDir('ssg4c-');
  try {
    writeTicket(tmp, 't1', 'Done', 10);
    const t2Dir = writeTicket(tmp, 't2', 'Failed', 20);
    writeWorkerLogWithCodexError(t2Dir);

    const state = makeState({ codex_model: 'gpt-5.3-codex-spark-mini' });
    const decision = evaluateSparkSmokeGate(state, tmp);
    assert.equal(decision.action, 'halt');
    assert.equal(decision.rule, 'first_two_failed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
