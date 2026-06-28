// @tier: integration
// SERIAL: real npm spawn with sub-5s timeout (subprocess-timeout-coupling)
//
// AC-CWGE-2: runWorkerGateTestCommand (spawn-morty.ts) builds, on a test:fast timeout,
// exactly one failure { name: '__timeout__', file: 'npm run test:fast', message } and
// returns ok:false. This regression-guards that the timeout-failure shape is stable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { runWorkerGateTestCommand } = await import('../bin/spawn-morty.js');

test('R-CWGE WS-1: test:fast timeout yields exactly one __timeout__ failure and ok:false', async () => {
  const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwge-timeout-')));
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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
