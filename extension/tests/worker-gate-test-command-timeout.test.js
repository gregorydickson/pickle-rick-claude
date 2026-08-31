// @tier: integration
// SERIAL: real npm spawn with sub-5s timeout (subprocess-timeout-coupling)
//
// AC-CWGE-2: runWorkerGateTestCommand (spawn-morty.ts) builds, on a test:fast timeout,
// exactly one failure { name: '__timeout__', file: 'npm run test:fast', message } and
// returns ok:false. This regression-guards that the timeout-failure shape is stable.
//
// R-TIERWEDGE (D3): runWorkerGateTestCommand waits on the tier run through a STALL
// detector (no output growth for the configured window), never a flat wall-clock
// timeout. The three cases below pin the whole operational rule: (1) a genuinely
// silent/hung run is still caught, (2) a run that keeps emitting output survives no
// matter how long it runs in total (mutation-verify: a wall-clock-only design would
// kill it), and (3) a run that goes silent only AFTER an initial burst is still caught
// — proof the detector tracks RECENT growth, not merely "produced output once ever".
//
// R-TIERWEDGE (FR-B1): N is now argument FOUR, resolved by
// `resolveTierStallThresholdMs()` when omitted. Argument three stays the gate
// wall-clock budget, which no longer governs this wait. The cases below pass BOTH
// so the injected stall window is explicit — omitting the fourth argument would
// silently fall back to the 600_000 ms default and park each hung-child case for
// ten minutes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { runWorkerGateTestCommand } = await import('../bin/spawn-morty.js');

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwge-timeout-')));
}

test('R-CWGE WS-1: test:fast timeout yields exactly one __timeout__ failure and ok:false', async () => {
  const tmpDir = makeTmpDir();
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { 'test:fast': 'node -e "setTimeout(()=>{}, 10000)"' } }),
    );
    const result = await runWorkerGateTestCommand('test:fast', tmpDir, 500, 500);
    assert.equal(result.ok, false, 'a timed-out test:fast gate is not ok');
    assert.equal(result.failures.length, 1, 'exactly one synthetic failure on timeout');
    assert.equal(result.failures[0].name, '__timeout__', 'failure is the timeout sentinel');
    assert.equal(result.failures[0].file, 'npm run test:fast', 'failure file names the timed-out command');
    assert.match(
      result.failures[0].message,
      /^stalled: no output growth for 500ms;/,
      'the report names the stall, not a generic wall-clock timeout',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R-TIERWEDGE: a slow-but-progressing test:fast run is NOT killed', async () => {
  const tmpDir = makeTmpDir();
  try {
    // Ticks every 150ms, 6 times (~900ms total) — comfortably longer than the 300ms
    // stall window, but no single gap between ticks exceeds it. A wall-clock-only
    // timeout of 300ms would kill this well before it finishes; the stall detector
    // must let it run to completion because output keeps growing.
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        scripts: {
          'test:fast': 'node -e "let n=0;const t=setInterval(()=>{process.stdout.write(String(n)+\'\\n\');n++;if(n>=6){clearInterval(t);process.exit(0);}},150)"',
        },
      }),
    );
    const result = await runWorkerGateTestCommand('test:fast', tmpDir, 300, 300);
    assert.equal(result.ok, true, 'a run that keeps producing output must survive past the stall window');
    assert.deepEqual(result.failures, [], 'no synthetic failure for a run that completed on its own');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R-TIERWEDGE: an initial burst followed by silence is still caught as a stall', async () => {
  const tmpDir = makeTmpDir();
  try {
    // Emits once immediately, then goes silent forever — proving the detector tracks
    // the MOST RECENT growth, not merely whether output was ever produced at all.
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({
        scripts: {
          'test:fast': 'node -e "process.stdout.write(\'started\\n\');setTimeout(()=>{}, 10000)"',
        },
      }),
    );
    const result = await runWorkerGateTestCommand('test:fast', tmpDir, 500, 500);
    assert.equal(result.ok, false, 'silence after an initial burst is still a stall');
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].name, '__timeout__');
    assert.match(result.failures[0].message, /^stalled: no output growth for 500ms;/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R-TIERWEDGE FR-B1: the gate wall-clock budget does NOT govern the stall window', async () => {
  const tmpDir = makeTmpDir();
  try {
    // The operator has followed root CLAUDE.md "Tune-Back CUJs" #1 and raised the per-machine
    // gate budget to 3h, so argument three carries 3h exactly as the production thread would.
    // Before N was split out, argument three WAS the stall window and this hung child would
    // have been waited on for three hours. Only argument four may govern the wait now.
    //
    // No env var is set here on purpose: argument four is explicit, so nothing in this path
    // would read one, and setting it would only imply a mechanism that is not in play. The
    // resolver-level half of this decoupling is covered by `worker-test-fast-timeout.test.js`.
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { 'test:fast': 'node -e "setTimeout(()=>{}, 10000)"' } }),
    );
    const startedAt = Date.now();
    const result = await runWorkerGateTestCommand('test:fast', tmpDir, 10_800_000, 500);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.ok, false, 'a stalled tier run is not ok');
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].name, '__timeout__');
    assert.match(
      result.failures[0].message,
      /^stalled: no output growth for 500ms;/,
      'the report must name the stall window, not the gate budget',
    );
    assert.ok(
      elapsedMs < 60_000,
      `stall must be detected in seconds, not at the 3h budget (took ${elapsedMs}ms)`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R-TIERWEDGE FR-B1: with N omitted, a SHORT gate budget still bounds the stall window', async () => {
  const tmpDir = makeTmpDir();
  try {
    // Production (spawn-morty.ts :1820/:1829) passes THREE arguments, so the defaulted
    // fourth is the production path and must be exercised without one. A budget shorter
    // than `resolveTierStallThresholdMs()` has to win, which is what
    // `spawn-morty-worker-gate.test.js:855` depends on. This case fails closed against a
    // mutation that drops `workerTestGateTimeoutMs` from the cap: the window would become
    // the 600_000 ms default and this hung child would park for ten minutes.
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ scripts: { 'test:fast': 'node -e "setTimeout(()=>{}, 10000)"' } }),
    );
    const result = await runWorkerGateTestCommand('test:fast', tmpDir, 500);
    assert.equal(result.ok, false);
    assert.match(
      result.failures[0]?.message ?? '',
      /^stalled: no output growth for 500ms;/,
      'the defaulted window must take the SHORTER of the budget and N',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('R-TIERWEDGE FR-B1: the default caps the budget with resolveTierStallThresholdMs', async () => {
  // The other half of the cap — a budget LONGER than N must not widen the window — cannot be
  // observed at runtime cheaply: the correct outcome is a 600_000 ms wait and the defective
  // one is a 10_800_000 ms wait, so both exceed any sane test budget. Pin the default
  // EXPRESSION instead, read off the compiled mirror the runtime actually loads.
  //
  // Anchored on the `export async function` signature line specifically, so a mere mention of
  // the resolver in a comment or JSDoc cannot satisfy it (verified: the expression occurs
  // exactly once in the compiled file, on this line).
  const compiled = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'spawn-morty.js'),
    'utf8',
  );
  const signature = compiled
    .split('\n')
    .find(line => line.startsWith('export async function runWorkerGateTestCommand('));
  assert.ok(signature, 'runWorkerGateTestCommand must be exported from the compiled mirror');
  assert.match(
    signature,
    /stallThresholdMs = Math\.min\(workerTestGateTimeoutMs, resolveTierStallThresholdMs\(\)\)/,
    'N must default to the MINIMUM of the gate budget and the resolved stall threshold — '
      + 'defaulting to the budget alone is the R-TIERWEDGE defect (a raised per-machine '
      + 'tune-back would push hang detection out to three hours)',
  );

  assert.equal(
    runWorkerGateTestCommand.length,
    3,
    'the fourth parameter must stay OPTIONAL so production keeps passing three arguments',
  );
});
