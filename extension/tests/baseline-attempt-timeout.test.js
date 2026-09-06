// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import {
  _deps,
  measureLlmMetricWithBackoff,
} from '../bin/microverse-runner.js';
import { ACTIVITY_EVENT_SCHEMA_SECTION } from '../bin/spawn-refinement-team.js';
import { VALID_ACTIVITY_EVENTS } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../src/types/activity-events.schema.json'), 'utf8'),
);

function makeEtimedoutError() {
  const err = new Error('spawnSync claude ETIMEDOUT');
  err.code = 'ETIMEDOUT';
  return err;
}

test('judge_measurement_attempted and baseline_attempt_timeout emit per attempt', async () => {
  process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = '1';
  const origExecFileSync = _deps.execFileSync;
  const origSleep = _deps.sleep;
  const origLogActivity = _deps.logActivity;
  const events = [];

  _deps.execFileSync = () => {
    throw makeEtimedoutError();
  };
  _deps.sleep = async () => {};
  _deps.logActivity = (event) => {
    events.push({ ts: new Date().toISOString(), ...event });
  };

  try {
    const result = await measureLlmMetricWithBackoff(
      'fix bugs',
      30,
      '/tmp',
      undefined,
      undefined,
      undefined,
      undefined,
      'claude',
      [],
      { session: 'session-1', iteration: 7, spawnContext: 'baseline' },
    );

    assert.equal(result.metric, null);
    assert.equal(result.exitReason, 'judge_timeout');
    assert.equal(result.attempts, 4);

    const attemptedEvents = events.filter((event) => event.event === 'judge_measurement_attempted');
    const timeoutEvents = events.filter((event) => event.event === 'baseline_attempt_timeout');

    assert.equal(attemptedEvents.length, 4, 'ETIMEDOUT attempts should emit four measurement-attempt events');
    attemptedEvents.forEach((event, index) => {
      assert.equal(typeof event.ts, 'string');
      assert.equal(event.session, 'session-1');
      assert.equal(event.iteration, 7);
      assert.equal(event.backend, 'claude');
      assert.equal(event.judge_backend, 'claude');
      assert.equal(event.model, 'claude-sonnet-4-6');
      assert.equal(event.fallback_activated, true);
      assert.equal(event.spawn_context, 'baseline');
      assert.equal(event.gate_payload.attempt, index + 1);
      assert.equal(Number.isInteger(event.gate_payload.elapsed_ms), true);
      assert.equal(event.gate_payload.elapsed_ms >= 0, true);
      assert.equal(event.gate_payload.outcome, 'timeout');
      assert.equal(event.gate_payload.timeout_class, 'probe_timeout');
      assert.equal(event.gate_payload.probe_kind, 'timeout');
    });

    assert.equal(timeoutEvents.length, 4, 'ETIMEDOUT attempts should emit four timeout events');
    timeoutEvents.forEach((event, index) => {
      assert.equal(event.event, 'baseline_attempt_timeout');
      assert.equal(typeof event.ts, 'string');
      assert.equal(event.session, 'session-1');
      assert.equal(event.iteration, 7);
      assert.deepEqual(event.gate_payload.classifier, 'timeout');
      assert.equal(event.gate_payload.attempt, index + 1);
      assert.equal(Number.isInteger(event.gate_payload.elapsed_ms), true);
      assert.equal(event.gate_payload.elapsed_ms >= 0, true);
    });

    const definitionKeys = Object.keys(schema.definitions);
    assert.equal(definitionKeys.includes('baseline_attempt_timeout'), true);
    assert.equal(definitionKeys.includes('judge_measurement_attempted'), true);

    const oneOfRefs = schema.oneOf.map((entry) => entry.$ref);
    assert.equal(oneOfRefs.includes('#/definitions/baseline_attempt_timeout'), true);
    assert.equal(oneOfRefs.includes('#/definitions/judge_measurement_attempted'), true);
  } finally {
    delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
    _deps.execFileSync = origExecFileSync;
    _deps.sleep = origSleep;
    _deps.logActivity = origLogActivity;
  }
});

test('VALID_ACTIVITY_EVENTS includes baseline_attempt_timeout', () => {
  assert.equal(
    VALID_ACTIVITY_EVENTS.includes('baseline_attempt_timeout'),
    true,
    'baseline_attempt_timeout must be registered in VALID_ACTIVITY_EVENTS',
  );
});

test('VALID_ACTIVITY_EVENTS includes judge_measurement_attempted', () => {
  assert.equal(
    VALID_ACTIVITY_EVENTS.includes('judge_measurement_attempted'),
    true,
    'judge_measurement_attempted must be registered in VALID_ACTIVITY_EVENTS',
  );
});

test('spawn-refinement-team documents baseline_attempt_timeout schema fields', () => {
  const rowMatch = ACTIVITY_EVENT_SCHEMA_SECTION.match(
    /\|\s*`baseline_attempt_timeout`\s*\|\s*([^|]+)\|/,
  );
  assert.ok(
    rowMatch,
    'ACTIVITY_EVENT_SCHEMA_SECTION must include baseline_attempt_timeout',
  );
  const row = rowMatch[1];
  for (const field of ['session', 'gate_payload.attempt', 'gate_payload.elapsed_ms', 'gate_payload.classifier']) {
    assert.match(
      row,
      new RegExp(String.raw`\`${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``),
      `baseline_attempt_timeout row missing required field ${field}`,
    );
  }
});

test('spawn-refinement-team documents judge_measurement_attempted schema fields', () => {
  const rowMatch = ACTIVITY_EVENT_SCHEMA_SECTION.match(
    /\|\s*`judge_measurement_attempted`\s*\|\s*([^|]+)\|/,
  );
  assert.ok(
    rowMatch,
    'ACTIVITY_EVENT_SCHEMA_SECTION must include judge_measurement_attempted',
  );
  const row = rowMatch[1];
  for (const field of [
    'session',
    'iteration',
    'backend',
    'judge_backend',
    'model',
    'fallback_activated',
    'spawn_context',
    'gate_payload.attempt',
    'gate_payload.elapsed_ms',
    'gate_payload.outcome',
    'gate_payload.timeout_class',
    'gate_payload.probe_kind',
  ]) {
    assert.match(
      row,
      new RegExp(String.raw`\`${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``),
      `judge_measurement_attempted row missing required field ${field}`,
    );
  }
});


// ---------------------------------------------------------------------------
// B-CLIBRITTLE AC-2 — a STARTUP rejection costs one attempt, a real timeout still retries.
//
// Both directions are pinned deliberately: a test that only proves the under-trigger case would
// pass a classify-anything bug that swallowed the retry path entirely. Direction C additionally
// pins the ORDERING against the rate-limit branch, which two directions alone would still miss.
// ---------------------------------------------------------------------------

function makeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = { end() {} };
  child.kill = () => true;
  return child;
}

// Fakes both spawns measureLlmMetricWithBackoff makes: the `--version` availability probe
// (always healthy) and the judge measurement itself (scripted per test).
function installJudgeSpawnFake(scriptJudge) {
  const judgeCalls = [];
  _deps.spawn = (cmd, args) => {
    const child = makeChild();
    if (args.includes('--version')) {
      queueMicrotask(() => {
        child.stdout.emit('data', '2.1.260\n');
        child.emit('close', 0);
      });
      return child;
    }
    judgeCalls.push({ cmd, args });
    scriptJudge(child);
    return child;
  };
  return judgeCalls;
}

async function runBackoff(timeoutSeconds) {
  return measureLlmMetricWithBackoff(
    'fix bugs', timeoutSeconds, '/tmp',
    undefined, undefined, undefined, undefined, 'claude', [],
    { session: 'clibrittle', iteration: 1, spawnContext: 'baseline' },
  );
}

function withJudgeDeps(fn) {
  const saved = {
    spawn: _deps.spawn,
    sleep: _deps.sleep,
    logActivity: _deps.logActivity,
    metricParkMaxMs: _deps.metricParkMaxMs,
    judgeStartupRejectionWindowMs: _deps.judgeStartupRejectionWindowMs,
  };
  const legacy = process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
  // These tests exercise the spawn transport, not the legacy execFileSync one.
  delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
  const sleeps = [];
  _deps.sleep = async (ms) => { sleeps.push(ms); };
  _deps.logActivity = () => {};
  // Keep a rate-limited round from parking for real wall-clock in direction C.
  _deps.metricParkMaxMs = 0;
  return (async () => {
    try {
      return await fn(sleeps);
    } finally {
      Object.assign(_deps, saved);
      if (legacy === undefined) delete process.env['PICKLE_JUDGE_LEGACY_SPAWN'];
      else process.env['PICKLE_JUDGE_LEGACY_SPAWN'] = legacy;
    }
  })();
}

test('AC-2 direction A: a startup rejection reports in ONE attempt and does not consume the retry budget', async () => {
  await withJudgeDeps(async (sleeps) => {
    const judgeCalls = installJudgeSpawnFake((child) => {
      queueMicrotask(() => {
        // The measured shape: rejection text on stderr, NO stdout, non-zero exit, immediately.
        child.stderr.emit('data', "error: unknown option '--setting-sources'\n");
        child.emit('close', 1);
      });
    });

    const result = await runBackoff(600);

    assert.equal(judgeCalls.length, 1, 'the judge must be spawned exactly ONCE, not four times');
    assert.equal(result.attempts, 1);
    assert.deepEqual(sleeps, [], 'no backoff sleep may be spent on a deterministic startup rejection');
    // Reuses an EXISTING non-fatal exit reason — no new abort condition (AC-4 / AC-G2).
    assert.equal(result.exitReason, 'judge_unreachable');
    assert.match(result.lastError, /unknown option/, 'the CLI’s own rejection text must be reported');
  });
});

test('AC-1 wiring: the REAL judge invocation carries the ambient-settings decoupling flag', async () => {
  await withJudgeDeps(async () => {
    // These are the args buildJudgeAttemptInvocation actually produced — asserting on them pins
    // the CALL SITE, not just the helper. Without this the helper could be correct and unwired.
    const judgeCalls = installJudgeSpawnFake((child) => {
      queueMicrotask(() => {
        child.stderr.emit('data', "error: unknown option '--x'\n");
        child.emit('close', 1);
      });
    });

    await runBackoff(600);

    assert.equal(judgeCalls.length, 1);
    const args = judgeCalls[0].args;
    const i = args.indexOf('--setting-sources');
    assert.notEqual(i, -1, 'the judge spawn must be decoupled from ambient settings sources');
    assert.equal(args[i + 1], '', 'the decoupled value must load NO ambient source');
  });
});

test('AC-2 direction B: a genuine timeout STILL consumes the full retry budget', async () => {
  await withJudgeDeps(async (sleeps) => {
    // Never settles: the only way out is the timeout timer.
    const judgeCalls = installJudgeSpawnFake(() => {});

    const result = await runBackoff(1);

    assert.equal(judgeCalls.length, 4, 'a real timeout must still be retried across the full budget');
    assert.equal(result.attempts, 4);
    assert.equal(sleeps.length, 3, 'all three backoff sleeps must still be spent');
    assert.equal(result.exitReason, 'judge_timeout');
  });
});

test('AC-2 direction C: a fast non-zero exit carrying a rate-limit signal is still RETRIED', async () => {
  await withJudgeDeps(async () => {
    const judgeCalls = installJudgeSpawnFake((child) => {
      queueMicrotask(() => {
        // Fast + non-zero + no stdout, exactly like a startup rejection — but it is a 429, which
        // must keep winning, or rate limits would stop being retried and parked.
        child.stderr.emit('data', 'API Error: 429 rate limit exceeded\n');
        child.emit('close', 1);
      });
    });

    const result = await runBackoff(600);

    assert.equal(judgeCalls.length, 4, 'a 429 must not be misread as a configuration rejection');
    assert.notEqual(result.exitReason, 'judge_unreachable');
  });
});

test('AC-2: a non-zero exit that produced stdout is NOT a startup rejection', async () => {
  await withJudgeDeps(async () => {
    const judgeCalls = installJudgeSpawnFake((child) => {
      queueMicrotask(() => {
        // The CLI got far enough to emit a work product, so it did not die at startup.
        child.stdout.emit('data', 'partial work\n');
        child.stderr.emit('data', 'something went wrong later\n');
        child.emit('close', 1);
      });
    });

    const result = await runBackoff(600);

    assert.equal(judgeCalls.length, 4, 'only a spawn that produced NO stdout may be treated as terminal');
    assert.notEqual(result.exitReason, 'judge_unreachable');
  });
});


test('AC-2: a non-zero exit that arrives AFTER the startup window is NOT a startup rejection', async () => {
  await withJudgeDeps(async () => {
    // Pins the startup-WINDOW conjunct specifically. Injected rather than waited out so the
    // direction costs milliseconds instead of the real 5s window — same reason metricParkMaxMs
    // is injectable. Without this test, deleting the window check entirely survives every other
    // assertion in this file (measured: it did).
    _deps.judgeStartupRejectionWindowMs = 20;

    const judgeCalls = installJudgeSpawnFake((child) => {
      // No stdout and a non-zero exit — but far too late to be a startup rejection. A judge that
      // ran for a while and then failed may well succeed on retry, so the budget must be spent.
      setTimeout(() => {
        child.stderr.emit('data', 'failed after doing real work\n');
        child.emit('close', 1);
      }, 80);
    });

    const result = await runBackoff(600);

    assert.equal(judgeCalls.length, 4, 'a late failure must still be retried across the full budget');
    assert.notEqual(result.exitReason, 'judge_unreachable');
  });
});
