// @tier: fast
// B-CWGE (R-CWGE/R-DOTR) + R-WGFR: the ABSENT worker-gate verdict recompute MUST enforce
// the DETERMINISTIC eslint + tsc dimensions. A codex / detached / salvaged worker that never
// persisted `worker_gate_verdict` reaches this path; a lint-RED or tsc-RED tree (stale
// compiled JS hides the tsc-RED entirely) must recompute 'red' so the Done-flip guard cannot
// ship Done-over-red on the lint/tsc dimensions (the 2026-06-27 codex soak class).
//
// R-WGFR (SUBTRACTION): the `test:fast` dimension is DROPPED — eslint/tsc are deterministic;
// only `test:fast` flakes (a single c=8 timeout-flake false-red the recompute and killed a
// GREEN bundle FATAL). The recompute takes NO test seam: eslint+tsc green => green, no spawn.
// These tests inject a fake check runner so no real eslint/tsc spawns are needed.
//
// R-PTSB: importing the session-writing mux-runner bin requires a sandboxed data root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PICKLE_DATA_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwge-recompute-')));

const { recomputeAbsentWorkerGateVerdict } = await import('../bin/mux-runner.js');

// runCheck(bin, args, dir) -> boolean; args[0] is 'eslint' then 'tsc'.
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

test('R-WGFR recompute: eslint+tsc green => green with NO test invocation', () => {
  const check = fakeCheck({ eslint: true, tsc: true });
  // Only two args: the recompute has no runTests seam to inject.
  const verdict = recomputeAbsentWorkerGateVerdict('/ext', check);
  assert.equal(verdict, 'green');
  assert.deepEqual(check.calls, ['eslint', 'tsc'], 'eslint then tsc both ran; nothing else');
  // Arity proof: the third (test) parameter is gone — the signature is (dir, runCheck).
  assert.equal(
    recomputeAbsentWorkerGateVerdict.length,
    1,
    'only extensionDir is required (runCheck defaulted); no runTests param',
  );
});

test('R-CWGE recompute: lint-RED tree => red (eslint short-circuits tsc)', () => {
  const check = fakeCheck({ eslint: false });
  const verdict = recomputeAbsentWorkerGateVerdict('/ext', check);
  assert.equal(verdict, 'red', 'eslint failure must recompute red');
  assert.deepEqual(check.calls, ['eslint'], 'eslint short-circuits before tsc');
});

test('R-CWGE recompute: tsc-RED tree => red (tsc ran after eslint passed)', () => {
  const check = fakeCheck({ eslint: true, tsc: false });
  const verdict = recomputeAbsentWorkerGateVerdict('/ext', check);
  assert.equal(verdict, 'red', 'tsc failure must recompute red');
  assert.deepEqual(check.calls, ['eslint', 'tsc'], 'tsc ran after eslint passed');
});
