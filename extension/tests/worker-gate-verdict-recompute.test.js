// B-CWGE (R-CWGE/R-DOTR): the ABSENT worker-gate verdict recompute MUST enforce the
// SAME eslint + tsc + test:fast contract the worker gate enforces — NOT test:fast alone.
// A codex / detached / salvaged worker that never persisted `worker_gate_verdict` reaches
// this path; if it only ran test:fast, a lint-RED or tsc-RED tree whose test:fast passes
// would recompute 'green' and the Done-flip guard would ship Done-over-red on the lint/tsc
// dimensions (the 2026-06-27 codex soak class). These tests inject fake check/test runners
// so no real eslint/tsc/npm spawns are needed.
//
// R-PTSB: importing the session-writing mux-runner bin requires a sandboxed data root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PICKLE_DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwge-recompute-')));

const { recomputeAbsentWorkerGateVerdict } = await import('../bin/mux-runner.js');

// runCheck(bin, args, dir) -> boolean; the first arg of args[0] for the two checks is
// 'eslint' then 'tsc'. Build a fake keyed on that token.
function fakeCheck({ eslint = true, tsc = true } = {}) {
  const calls = [];
  const fn = (_bin, args) => {
    const tool = args[0];
    calls.push(tool);
    if (tool === 'eslint') return eslint;
    if (tool === 'tsc') return tsc;
    throw new Error(`unexpected check tool: ${tool}`);
  };
  fn.calls = calls;
  return fn;
}

test('R-CWGE recompute: all three pass => green', () => {
  const check = fakeCheck({ eslint: true, tsc: true });
  const verdict = recomputeAbsentWorkerGateVerdict('/ext', check, () => true);
  assert.equal(verdict, 'green');
  assert.deepEqual(check.calls, ['eslint', 'tsc'], 'eslint then tsc both ran');
});

test('R-CWGE recompute: lint-RED tree with passing test:fast => red (NOT green)', () => {
  const check = fakeCheck({ eslint: false });
  let testsRan = false;
  const verdict = recomputeAbsentWorkerGateVerdict('/ext', check, () => { testsRan = true; return true; });
  assert.equal(verdict, 'red', 'eslint failure must recompute red even though test:fast passes');
  assert.deepEqual(check.calls, ['eslint'], 'eslint short-circuits before tsc');
  assert.equal(testsRan, false, 'tests not reached after lint fail');
});

test('R-CWGE recompute: tsc-RED tree with passing test:fast => red (NOT green)', () => {
  const check = fakeCheck({ eslint: true, tsc: false });
  let testsRan = false;
  const verdict = recomputeAbsentWorkerGateVerdict('/ext', check, () => { testsRan = true; return true; });
  assert.equal(verdict, 'red', 'tsc failure must recompute red even though test:fast passes');
  assert.deepEqual(check.calls, ['eslint', 'tsc'], 'tsc ran after eslint passed; tests short-circuited');
  assert.equal(testsRan, false, 'tests not reached after tsc fail');
});

test('R-CWGE recompute: lint+tsc green but test:fast red => red', () => {
  const check = fakeCheck({ eslint: true, tsc: true });
  const verdict = recomputeAbsentWorkerGateVerdict('/ext', check, () => false);
  assert.equal(verdict, 'red', 'a failing test:fast still recomputes red');
});
