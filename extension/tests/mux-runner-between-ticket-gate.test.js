// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runBetweenTicketFastGate, runBetweenTicketFastTests, parseBetweenTicketFastGateFailures } from '../bin/mux-runner.js';

function makeRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeSession(root) {
  const sessionDir = path.join(root, 'session');
  mkdirSync(sessionDir, { recursive: true });
  const statePath = path.join(sessionDir, 'state.json');
  writeFileSync(statePath, JSON.stringify({
    schema_version: 3,
    active: true,
    working_dir: root,
    step: 'implement',
    iteration: 1,
    max_iterations: 10,
    worker_timeout_seconds: 1200,
    start_time_epoch: 0,
    completion_promise: null,
    original_prompt: 'between-ticket gate',
    current_ticket: 'bbbb2222',
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: sessionDir,
    activity: [],
  }, null, 2));
  mkdirSync(path.join(root, 'extension', 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'extension', 'bin', 'log-watcher.js'), '');
  return { sessionDir, statePath };
}

function makeTicket(sessionDir, id, status) {
  const ticketDir = path.join(sessionDir, id);
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), [
    '---',
    `id: ${id}`,
    `title: "Ticket ${id}"`,
    `status: "${status}"`,
    'order: 1',
    '---',
    '',
    '# Body',
  ].join('\n'));
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function withPathPrefix(prefix, fn) {
  const original = process.env.PATH;
  process.env.PATH = `${prefix}${path.delimiter}${original ?? ''}`;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
}

// runBetweenTicketFastTests resolves its gate timeout via resolveWorkerTestGateTimeoutMs's
// default `env = process.env` param, so a launching shell that already exports
// PICKLE_WORKER_TEST_FAST_TIMEOUT_MS overrides the pickle_settings.json fixture value these
// tests pin against. Strip it for the duration of the call, same shape as withPathPrefix.
function withCleanGateTimeoutEnv(fn) {
  const original = process.env.PICKLE_WORKER_TEST_FAST_TIMEOUT_MS;
  delete process.env.PICKLE_WORKER_TEST_FAST_TIMEOUT_MS;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.PICKLE_WORKER_TEST_FAST_TIMEOUT_MS;
    else process.env.PICKLE_WORKER_TEST_FAST_TIMEOUT_MS = original;
  }
}

test('mux-runner-between-ticket-gate: Done prior ticket emits cross_ticket_regression_detected and persists state', () => {
  const root = makeRoot('pickle-mux-between-done-');
  try {
    const { sessionDir, statePath } = makeSession(root);
    makeTicket(sessionDir, 'aaaa1111', 'Done');
    makeTicket(sessionDir, 'bbbb2222', 'Todo');

    const result = runBetweenTicketFastGate({
      statePath,
      workingDir: root,
      completedTicketId: 'aaaa1111',
      nextTicketId: 'bbbb2222',
      landedStatus: 'Done',
      log: () => {},
      now: () => 1234,
      runTestFast: () => ({
        ok: false,
        timed_out: false,
        timeout_ms: 240000,
        failures: [{
          name: 'boundary detection fires',
          file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
        }],
      }),
    });

    assert.deepEqual(result, {
      ok: false,
      timed_out: false,
      timeout_ms: 240000,
      failures: [{
        name: 'boundary detection fires',
        file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
      }],
    });

    const state = readState(statePath);
    assert.deepEqual(state.last_between_ticket_gate, {
      ts: 1234,
      ok: false,
      timed_out: false,
      timeout_ms: 240000,
      failures: [{
        name: 'boundary detection fires',
        file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
      }],
    });

    const event = state.activity.find((entry) => entry.event === 'cross_ticket_regression_detected');
    assert.deepEqual(event, {
      event: 'cross_ticket_regression_detected',
      ts: new Date(1234).toISOString(),
      ticket_id: 'bbbb2222',
      prior_ticket_id: 'aaaa1111',
      failing_tests: [{
        name: 'boundary detection fires',
        file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
      }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// R-GBANNER: a real TAP failure with an EMPTY file field (e.g. no `location:` line in the
// TAP output) must still fire the cross-ticket attribution — the guard must key on the
// explicit `script_failure` marker, never on `file === ''` alone.
test('mux-runner-between-ticket-gate: Done prior ticket with a real failure and an empty file field still emits cross_ticket_regression_detected', () => {
  const root = makeRoot('pickle-mux-between-emptyfile-');
  try {
    const { sessionDir, statePath } = makeSession(root);
    makeTicket(sessionDir, 'aaaa1111', 'Done');
    makeTicket(sessionDir, 'bbbb2222', 'Todo');

    runBetweenTicketFastGate({
      statePath,
      workingDir: root,
      completedTicketId: 'aaaa1111',
      nextTicketId: 'bbbb2222',
      landedStatus: 'Done',
      log: () => {},
      now: () => 4321,
      runTestFast: () => ({
        ok: false,
        timed_out: false,
        timeout_ms: 240000,
        failures: [{
          name: 'a real failing test with no location line',
          file: '',
        }],
      }),
    });

    const state = readState(statePath);
    const event = state.activity.find((entry) => entry.event === 'cross_ticket_regression_detected');
    assert.deepEqual(event, {
      event: 'cross_ticket_regression_detected',
      ts: new Date(4321).toISOString(),
      ticket_id: 'bbbb2222',
      prior_ticket_id: 'aaaa1111',
      failing_tests: [{
        name: 'a real failing test with no location line',
        file: '',
      }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// R-GBANNER: a `script_failure` entry (npm lifecycle banner death, e.g. in `pretest:fast`) must
// never seed a cross-ticket attribution — an already-Done ("green") ticket must not be accused
// of a regression it did not cause. Fixture shape mirrors the real synthetic entry
// `parseBetweenTicketFastGateFailures` produces (see the AC-1/AC-2/AC-3 test below).
test('mux-runner-between-ticket-gate: a script_failure (npm lifecycle banner death) does not seed cross_ticket_regression_detected', () => {
  const root = makeRoot('pickle-mux-between-scriptfail-');
  try {
    const { sessionDir, statePath } = makeSession(root);
    makeTicket(sessionDir, 'aaaa1111', 'Done');
    makeTicket(sessionDir, 'bbbb2222', 'Todo');

    runBetweenTicketFastGate({
      statePath,
      workingDir: root,
      completedTicketId: 'aaaa1111',
      nextTicketId: 'bbbb2222',
      landedStatus: 'Done',
      log: () => {},
      now: () => 9999,
      runTestFast: () => ({
        ok: false,
        timed_out: false,
        timeout_ms: 240000,
        failures: [{
          name: 'script failure: pretest:fast',
          file: '',
          script_failure: true,
          message: 'audit-test-tiers.sh: FAIL — tests/foo.test.js missing @tier header',
        }],
      }),
    });

    const state = readState(statePath);
    // The gate RESULT is still persisted verbatim — only the cross-ticket ATTRIBUTION is
    // suppressed.
    assert.deepEqual(state.last_between_ticket_gate.failures, [{
      name: 'script failure: pretest:fast',
      file: '',
      script_failure: true,
      message: 'audit-test-tiers.sh: FAIL — tests/foo.test.js missing @tier header',
    }]);
    assert.equal(
      state.activity.some((entry) => entry.event === 'cross_ticket_regression_detected'),
      false,
      `unexpected cross_ticket_regression_detected in ${JSON.stringify(state.activity)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mux-runner-between-ticket-gate: Failed prior ticket does not emit cross_ticket_regression_detected', () => {
  const root = makeRoot('pickle-mux-between-failed-');
  try {
    const { sessionDir, statePath } = makeSession(root);
    makeTicket(sessionDir, 'aaaa1111', 'Failed');
    makeTicket(sessionDir, 'bbbb2222', 'Todo');

    runBetweenTicketFastGate({
      statePath,
      workingDir: root,
      completedTicketId: 'aaaa1111',
      nextTicketId: 'bbbb2222',
      landedStatus: 'Failed',
      log: () => {},
      now: () => 5678,
      runTestFast: () => ({
        ok: false,
        timed_out: false,
        timeout_ms: 240000,
        failures: [{
          name: 'no false fire when prior Failed',
          file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
        }],
      }),
    });

    const state = readState(statePath);
    assert.deepEqual(state.last_between_ticket_gate, {
      ts: 5678,
      ok: false,
      timed_out: false,
      timeout_ms: 240000,
      failures: [{
        name: 'no false fire when prior Failed',
        file: 'extension/tests/mux-runner-between-ticket-gate.test.js',
      }],
    });
    assert.equal(
      state.activity.some((entry) => entry.event === 'cross_ticket_regression_detected'),
      false,
      `unexpected cross_ticket_regression_detected in ${JSON.stringify(state.activity)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mux-runner-between-ticket-gate: timeout emits dedicated timeout event and persists timeout metadata', () => {
  const root = makeRoot('pickle-mux-between-timeout-');
  const originalExtensionDir = process.env.EXTENSION_DIR;
  try {
    const { sessionDir, statePath } = makeSession(root);
    makeTicket(sessionDir, 'aaaa1111', 'Done');
    makeTicket(sessionDir, 'bbbb2222', 'Todo');

    writeFileSync(path.join(root, 'pickle_settings.json'), JSON.stringify({
      worker_test_gate_timeout_ms: 50,
    }, null, 2));

    const shimDir = path.join(root, 'bin');
    mkdirSync(shimDir, { recursive: true });
    const npmShim = path.join(shimDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    writeFileSync(
      npmShim,
      process.platform === 'win32'
        ? '@echo off\r\nnode -e "setTimeout(() => {}, 1000)"\r\n'
        : '#!/bin/sh\nnode -e "setTimeout(() => {}, 1000)"\n',
    );
    chmodSync(npmShim, 0o755);

    process.env.EXTENSION_DIR = root;
    const result = withCleanGateTimeoutEnv(() => withPathPrefix(shimDir, () => runBetweenTicketFastGate({
      statePath,
      workingDir: root,
      completedTicketId: 'aaaa1111',
      nextTicketId: 'bbbb2222',
      landedStatus: 'Done',
      log: () => {},
      now: () => 7777,
      runTestFast: undefined,
    })));

    assert.deepEqual(result, {
      ok: false,
      timed_out: true,
      timeout_ms: 50,
      failures: [{
        name: '__timeout__',
        file: 'npm run test:fast',
      }],
    });

    const state = readState(statePath);
    assert.deepEqual(state.last_between_ticket_gate, {
      ts: 7777,
      ok: false,
      timed_out: true,
      timeout_ms: 50,
      failures: [{
        name: '__timeout__',
        file: 'npm run test:fast',
      }],
    });

    const timeoutEvent = state.activity.find((entry) => entry.event === 'between_ticket_gate_timeout');
    assert.deepEqual(timeoutEvent, {
      event: 'between_ticket_gate_timeout',
      ts: new Date(7777).toISOString(),
      ticket_id: 'bbbb2222',
      prior_ticket_id: 'aaaa1111',
      gate_payload: {
        command: 'npm run test:fast',
        timeout_ms: 50,
      },
    });
  } finally {
    if (originalExtensionDir === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = originalExtensionDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('mux-runner-between-ticket-gate: runBetweenTicketFastTests returns timeout failure for hanging npm shim', () => {
  const root = makeRoot('pickle-mux-between-fast-timeout-');
  const originalExtensionDir = process.env.EXTENSION_DIR;
  try {
    const extensionDir = path.join(root, 'extension');
    mkdirSync(path.join(extensionDir, 'bin'), { recursive: true });
    writeFileSync(path.join(extensionDir, 'bin', 'log-watcher.js'), '');
    writeFileSync(path.join(root, 'pickle_settings.json'), JSON.stringify({
      worker_test_gate_timeout_ms: 50,
    }, null, 2));

    const shimDir = path.join(root, 'bin');
    mkdirSync(shimDir, { recursive: true });
    const npmShim = path.join(shimDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    writeFileSync(
      npmShim,
      process.platform === 'win32'
        ? '@echo off\r\nnode -e "setTimeout(() => {}, 1000)"\r\n'
        : '#!/bin/sh\nnode -e "setTimeout(() => {}, 1000)"\n',
    );
    chmodSync(npmShim, 0o755);

    process.env.EXTENSION_DIR = root;
    const result = withCleanGateTimeoutEnv(() => withPathPrefix(shimDir, () => runBetweenTicketFastTests(extensionDir)));

    assert.deepEqual(result, {
      ok: false,
      timed_out: true,
      timeout_ms: 50,
      failures: [{
        name: '__timeout__',
        file: 'npm run test:fast',
      }],
    });
  } finally {
    if (originalExtensionDir === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = originalExtensionDir;
    rmSync(root, { recursive: true, force: true });
  }
});

// AC-1/AC-2/AC-3: gate output whose only content is an npm lifecycle banner plus a failing
// audit, drawn from the exact observed shape (sessions 2026-08-14/15/16).
test('mux-runner-between-ticket-gate: parseBetweenTicketFastGateFailures attributes a pretest script failure, not the npm banner', () => {
  const output = [
    '> pickle-rick-scripts@2.1.0-beta.9 pretest:fast',
    '> bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh',
    '',
    'audit-test-tiers.sh: FAIL — tests/foo.test.js missing @tier header',
  ].join('\n');

  const failures = parseBetweenTicketFastGateFailures(output, '/repo');

  assert.equal(failures.length, 1);
  assert.equal(/^> \S+@\S+ \S+$/.test(failures[0].name), false, `name matched npm banner shape: ${failures[0].name}`);
  assert.match(failures[0].name, /pretest:fast/);
  assert.equal(failures[0].file, '');
  assert.equal(failures[0].script_failure, true);
  assert.match(failures[0].message, /audit-test-tiers\.sh: FAIL/);
});

// AC-4: real `not ok` TAP output is parsed byte-for-byte identically — no script_failure marker,
// same location normalization as before.
test('mux-runner-between-ticket-gate: parseBetweenTicketFastGateFailures leaves real TAP failures unchanged', () => {
  const output = [
    'not ok 1 - some real test',
    "  location: '/repo/extension/tests/foo.test.js'",
    '  ...',
  ].join('\n');

  const failures = parseBetweenTicketFastGateFailures(output, '/repo');

  assert.deepEqual(failures, [{
    name: 'some real test',
    file: 'extension/tests/foo.test.js',
  }]);
  assert.equal(failures[0].script_failure, undefined);
});

// AP-EXT-ITER55-01 regression. Measured ground truth on this repo: `npm run test:fast`
// emits 1,338,798 bytes, and a `spawnSync` of that exact command with the default
// `maxBuffer` returns `error.code === 'ENOBUFS'`, `status === null`, `signal === 'SIGTERM'`
// with stdout truncated to 1,004,953 bytes. `status === null` is not `0`, so the gate
// reported RED on a tier where every test PASSED, and named the phantom
// `script failure: test:fast` scraped off the truncated buffer.
//
// The shim reproduces the data flow, not the function in isolation: a real `npm` on PATH
// that streams >1MB of passing TAP and exits 0. Exercising the true 14-minute tier here
// is not an option, and a source grep for `maxBuffer` could not be reddened by a
// regression that re-forked its own smaller constant.
test('mux-runner-between-ticket-gate: runBetweenTicketFastTests stays GREEN when the tier streams past spawnSync\'s 1MB default maxBuffer', () => {
  const root = makeRoot('pickle-mux-between-fast-maxbuffer-');
  const originalExtensionDir = process.env.EXTENSION_DIR;
  try {
    const extensionDir = path.join(root, 'extension');
    mkdirSync(path.join(extensionDir, 'bin'), { recursive: true });
    writeFileSync(path.join(extensionDir, 'bin', 'log-watcher.js'), '');
    writeFileSync(path.join(root, 'pickle_settings.json'), JSON.stringify({
      worker_test_gate_timeout_ms: 120000,
    }, null, 2));

    const shimDir = path.join(root, 'bin');
    mkdirSync(shimDir, { recursive: true });
    // ~1.4MB of passing TAP — over the 1MB default, under the shared 64MB cap. The emitter
    // lives in its own file rather than a `node -e` string: the payload contains quotes, and
    // an inline form is one shell-quoting slip away from a shim that fails for the WRONG
    // reason and greens/reds this case on a ReferenceError instead of on buffer size.
    const emitterPath = path.join(shimDir, 'emit-tap.js');
    writeFileSync(emitterPath, [
      "const line = 'ok %I% - a passing fast-tier case with a realistically long name\\n';",
      "let out = '';",
      "for (let i = 0; i < 20000; i++) out += line.replace('%I%', String(i + 1));",
      "process.stdout.write('TAP version 13\\n1..20000\\n' + out + '# pass 20000\\n# fail 0\\n');",
      // NO `process.exit(0)` here. stdout is a PIPE, so writes are async and a bare
      // `write(...); process.exit(0)` truncates at the 64KB pipe buffer — the emitter would
      // deliver 65536 bytes, never overflow the cap, and this case would pass against the
      // defect. (Caught by mutation-verifying it; same trap as the `codegraph-query-runner.ts`
      // R-CGST flush invariant.) Let the process end naturally once the stream drains.
      '',
    ].join('\n'));
    const npmShim = path.join(shimDir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    writeFileSync(
      npmShim,
      process.platform === 'win32'
        ? `@echo off\r\nnode "${emitterPath}"\r\n`
        : `#!/bin/sh\nexec node "${emitterPath}"\n`,
    );
    chmodSync(npmShim, 0o755);

    process.env.EXTENSION_DIR = root;
    const result = withCleanGateTimeoutEnv(() => withPathPrefix(shimDir, () => runBetweenTicketFastTests(extensionDir)));

    // The whole defect in one assertion pair: a passing tier must be GREEN with an EMPTY
    // failure list. Pre-fix this was `ok: false` + a synthetic `script_failure` entry.
    assert.equal(result.ok, true, `gate must be green for a passing tier; got failures: ${JSON.stringify(result.failures)}`);
    assert.deepEqual(result.failures, []);
    assert.equal(result.timed_out, false);
  } finally {
    if (originalExtensionDir === undefined) delete process.env.EXTENSION_DIR;
    else process.env.EXTENSION_DIR = originalExtensionDir;
    rmSync(root, { recursive: true, force: true });
  }
});
