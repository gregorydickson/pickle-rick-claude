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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    const result = await runWorkerGateTestCommand('test:fast', tmpDir, 500);
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
    const result = await runWorkerGateTestCommand('test:fast', tmpDir, 300);
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
    const result = await runWorkerGateTestCommand('test:fast', tmpDir, 500);
    assert.equal(result.ok, false, 'silence after an initial burst is still a stall');
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].name, '__timeout__');
    assert.match(result.failures[0].message, /^stalled: no output growth for 500ms;/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
