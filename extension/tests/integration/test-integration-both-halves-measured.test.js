// @tier: integration
// A8 (R-ISSC / R-APGG): npm run test:integration must measure BOTH the parallel and serial
// halves independently -- a failing parallel half must never prevent the serial half from
// running, and both outcomes must be explicitly reported, never silently absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const PACKAGE_JSON_PATH = path.join(EXTENSION_ROOT, 'package.json');
const SPAWN_TIMEOUT_MS = 60_000;

function realScript(name) {
  const scripts = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')).scripts;
  assert.ok(typeof scripts[name] === 'string' && scripts[name].length > 0, `package.json is missing script "${name}"`);
  return scripts[name];
}

// The real script must never gate the serial half behind the parallel half's exit code --
// a bare `&&` between the two `npm run` sub-invocations is exactly the short-circuit this
// ticket fixes.
function assertNoShortCircuitBetweenHalves(scriptText, parallelName, serialName) {
  const parallelIdx = scriptText.indexOf(`npm run ${parallelName}`);
  const serialIdx = scriptText.indexOf(`npm run ${serialName}`);
  assert.ok(parallelIdx !== -1, `script does not invoke npm run ${parallelName}`);
  assert.ok(serialIdx !== -1, `script does not invoke npm run ${serialName}`);
  const between = scriptText.slice(parallelIdx, serialIdx);
  assert.ok(!between.includes('&&'), `"&&" between ${parallelName} and ${serialName} short-circuits the serial half: ${scriptText}`);
}

function runStubbedGate(realScriptText, { parallelExit, serialExit, targetName }) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'pr-a8-both-halves-'));
  try {
    const markerPath = path.join(tmpDir, 'serial-ran.marker');
    const stubPackageJson = {
      name: 'pr-a8-stub',
      scripts: {
        [targetName]: realScriptText,
        [`${targetName}:parallel`]: `node -e "process.exit(${parallelExit})"`,
        [`${targetName}:serial`]: `node -e "require('fs').writeFileSync('${markerPath}', '1'); process.exit(${serialExit})"`,
      },
    };
    writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(stubPackageJson, null, 2));

    const result = spawnSync('npm', ['run', targetName], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });

    return {
      exitCode: result.status,
      serialRan: existsSync(markerPath),
      output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('test:integration script has no && short-circuit between parallel and serial halves', () => {
  assertNoShortCircuitBetweenHalves(realScript('test:integration'), 'test:integration:parallel', 'test:integration:serial');
});

test('test:expensive script has no && short-circuit between parallel and serial halves', () => {
  assertNoShortCircuitBetweenHalves(realScript('test:expensive'), 'test:expensive:parallel', 'test:expensive:serial');
});

test('test:integration: a failing parallel half still runs and reports the serial half', () => {
  const scriptText = realScript('test:integration');
  const { exitCode, serialRan, output } = runStubbedGate(scriptText, {
    parallelExit: 1,
    serialExit: 0,
    targetName: 'test:integration',
  });

  assert.ok(serialRan, 'serial half never ran despite the parallel half failing -- the short-circuit regressed');
  assert.notEqual(exitCode, 0, 'overall exit must be non-zero when the parallel half failed');
  assert.match(output, /parallel_exit=1/, 'output must explicitly report the parallel half exit code');
  assert.match(output, /serial_exit=0/, 'output must explicitly report the serial half exit code, distinguishing "ran and passed" from "never ran"');
});

test('test:integration: a failing serial half (parallel passes) still fails the aggregate', () => {
  const scriptText = realScript('test:integration');
  const { exitCode, serialRan, output } = runStubbedGate(scriptText, {
    parallelExit: 0,
    serialExit: 1,
    targetName: 'test:integration',
  });

  assert.ok(serialRan, 'serial half should have run');
  assert.notEqual(exitCode, 0, 'overall exit must be non-zero when the serial half failed, even though parallel passed');
  assert.match(output, /parallel_exit=0/);
  assert.match(output, /serial_exit=1/);
});

test('test:integration: both halves passing yields overall success', () => {
  const scriptText = realScript('test:integration');
  const { exitCode, serialRan, output } = runStubbedGate(scriptText, {
    parallelExit: 0,
    serialExit: 0,
    targetName: 'test:integration',
  });

  assert.ok(serialRan, 'serial half should have run');
  assert.equal(exitCode, 0, 'overall exit must be zero when both halves passed');
  assert.match(output, /parallel_exit=0/);
  assert.match(output, /serial_exit=0/);
});

test('test:expensive: a failing parallel half still runs and reports the serial half', () => {
  const scriptText = realScript('test:expensive');
  const { exitCode, serialRan, output } = runStubbedGate(scriptText, {
    parallelExit: 1,
    serialExit: 0,
    targetName: 'test:expensive',
  });

  assert.ok(serialRan, 'serial half never ran despite the parallel half failing -- the short-circuit regressed');
  assert.notEqual(exitCode, 0, 'overall exit must be non-zero when the parallel half failed');
  assert.match(output, /parallel_exit=1/);
  assert.match(output, /serial_exit=0/);
});
