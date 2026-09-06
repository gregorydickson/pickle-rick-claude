// @tier: integration
// SERIAL: see tests/integration/.serial-tests.json (R-TFP) — subprocess-heavy (spawns auto-resume.sh child processes); flakes at --test-concurrency=8
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTO_RESUME_SH = path.resolve(__dirname, '..', 'scripts', 'auto-resume.sh');

function makeTmpDir() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), 'ar-sc-')));
}

function makeFixture({ ticket = 'abc123' } = {}) {
  const tmp = makeTmpDir();
  const extRoot = path.join(tmp, 'ext');
  const sessionDir = path.join(tmp, 'session');
  const muxRunnerFile = path.join(extRoot, 'extension', 'bin', 'mux-runner.js');
  const stateFile = path.join(sessionDir, 'state.json');
  const counterFile = path.join(sessionDir, '.n');
  const traceFile = path.join(sessionDir, 'runner-trace.jsonl');
  mkdirSync(path.dirname(muxRunnerFile), { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({
    active: false,
    current_ticket: ticket,
    exit_reason: null,
    session_dir: sessionDir,
  }));
  return { tmp, extRoot, sessionDir, muxRunnerFile, stateFile, counterFile, traceFile };
}

function readIfExists(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function waitMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listFixtureProcessPids(sessionDir) {
  const psResult = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (psResult.status !== 0) return [];
  return psResult.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (!match) return null;
      const [, pid, command] = match;
      if (!command.includes(sessionDir)) return null;
      if (!command.includes('auto-resume.sh') && !command.includes('mux-runner.js')) return null;
      return Number(pid);
    })
    .filter((pid) => Number.isInteger(pid));
}

function reapFixtureProcesses(sessionDir) {
  const terminate = (signal) => {
    for (const pid of listFixtureProcessPids(sessionDir)) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
  };

  terminate('SIGTERM');
  waitMs(150);
  terminate('SIGKILL');
  waitMs(50);
}

function formatResultDiagnostics(result) {
  const stateJson = readIfExists(result.fixture.stateFile);
  const counter = readIfExists(result.fixture.counterFile);
  const trace = readIfExists(result.fixture.traceFile);
  const livePids = listFixtureProcessPids(result.fixture.sessionDir);
  return [
    `tmp=${result.fixture.tmp}`,
    `status=${result.status} signal=${result.signal} error=${result.error?.message ?? 'null'}`,
    `live_pids=${livePids.length ? livePids.join(',') : '<none>'}`,
    `stdout:`,
    result.stdout || '<empty>',
    `stderr:`,
    result.stderr || '<empty>',
    `state.json:`,
    stateJson || '<missing>',
    `.n:`,
    counter || '<missing>',
    `runner-trace.jsonl:`,
    trace || '<missing>',
  ].join('\n');
}

function cleanupFixture(fixture, preserve) {
  reapFixtureProcesses(fixture.sessionDir);
  if (!preserve) {
    rmSync(fixture.tmp, { recursive: true, force: true });
  }
}

function runFixtureTest(fn, fixtureOptions) {
  const fixture = makeFixture(fixtureOptions);
  let preserve = false;
  try {
    fn(fixture);
  } catch (error) {
    preserve = true;
    if (error instanceof Error) {
      error.message += `\nfixture-preserved-at: ${fixture.tmp}`;
    }
    throw error;
  } finally {
    cleanupFixture(fixture, preserve);
  }
}

function writeMuxRunner(fixture, cjsBody) {
  writeFileSync(fixture.muxRunnerFile, cjsBody);
}

function runScript(fixture, envOverrides = {}, timeout = 30000) {
  const result = spawnSync('bash', [AUTO_RESUME_SH, fixture.sessionDir], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PICKLE_AUTO_RESUME_ON_CAP_HIT: '1',
      PICKLE_INSTALL_ROOT: fixture.extRoot,
      ...envOverrides,
    },
    timeout,
  });
  return {
    ...result,
    fixture,
    stderrLines: result.stderr.split('\n').filter(Boolean),
    stdoutLines: result.stdout.split('\n').filter(Boolean),
  };
}

function assertCompleted(result) {
  assert.equal(result.status, 0, formatResultDiagnostics(result));
  assert.equal(result.signal, null, formatResultDiagnostics(result));
}

function readTraceEntries(fixture) {
  return (readIfExists(fixture.traceFile)?.trim().split('\n').filter(Boolean) ?? []).map(line => JSON.parse(line));
}

const WARN_BANNER_TIMEOUT_MS = 45000;
const LOAD_TIMEOUT_REGRESSION_MS = 18000;
// R-TSPF residual (load-dependent-timeout): the no-progress halt needs three
// real mux-runner launches (each a fresh `node` cold-start) before the
// PROGRESS_THRESHOLD=3 stop fires. The shared `runScript` default of 30s was
// shorter than three cold-starts plus the auto-resume loop's poll sleeps under
// full-suite `--test-concurrency=8` load, so the outer `spawnSync` SIGTERM'd
// the bash loop at retry 2 (status 143) before it could reach the stop
// condition. The contract is the no-progress halt itself, not the wall-clock
// budget, so the timeout is widened to match the warn-banner test's headroom.
const NO_PROGRESS_TIMEOUT_MS = 45000;

// CJS mock: always sets exit_reason to the given value
function incompleteRunner() {
  return `const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[2] + '/state.json', 'utf8'));
s.exit_reason = 'pipeline_phase_incomplete';
fs.writeFileSync(process.argv[2] + '/state.json', JSON.stringify(s));
`;
}

function singleExitReasonRunner(exitReason) {
  return `const fs = require('fs');
const counterFile = process.argv[2] + '/.n';
let n = 0;
try { n = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync(counterFile, String(n));
const s = JSON.parse(fs.readFileSync(process.argv[2] + '/state.json', 'utf8'));
s.exit_reason = '${exitReason}';
fs.writeFileSync(process.argv[2] + '/state.json', JSON.stringify(s));
`;
}

describe('auto-resume.stop-conditions', () => {
  test('--help exits 0', () => {
    const result = spawnSync('bash', [AUTO_RESUME_SH, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('PICKLE_AUTO_RESUME_MAX_RETRIES'), 'help text missing MAX_RETRIES env');
    assert.ok(result.stdout.includes('pipeline_phase_incomplete'), 'help text missing stop-condition mention');
  });

  test('halts on non-pipeline_phase_incomplete exit_reason', () => {
    runFixtureTest((fixture) => {
      writeMuxRunner(fixture, singleExitReasonRunner('circuit_open'));
      const result = runScript(fixture);
      assertCompleted(result);
      assert.ok(
        result.stderr.includes("exit_reason='circuit_open'"),
        `expected stop on non-incomplete reason\n${formatResultDiagnostics(result)}`,
      );
    });
  });

  test('halts immediately on manager handoff exit reasons without consuming retries', () => {
    const exitReason = 'closer_handoff_terminal';
    runFixtureTest((fixture) => {
      writeMuxRunner(fixture, singleExitReasonRunner(exitReason));
      const result = runScript(fixture, { PICKLE_AUTO_RESUME_MAX_RETRIES: '5' });
      assertCompleted(result);
      assert.ok(
        result.stderr.includes(`manager handoff required (exit_reason='${exitReason}')`),
        `expected manager-handoff stop banner\n${formatResultDiagnostics(result)}`,
      );
      assert.equal(
        readIfExists(fixture.counterFile),
        '1',
        `expected manager handoff to stop after first launch\n${formatResultDiagnostics(result)}`,
      );
      assert.equal(
        result.stderrLines.some(line => /\[auto-resume\] retry \d+\//.test(line)),
        false,
        `expected manager handoff to avoid retry consumption\n${formatResultDiagnostics(result)}`,
      );
      assert.equal(
        result.stderr.includes('[warn] auto-resume retry'),
        false,
        `expected no retry warning banner on manager handoff stop\n${formatResultDiagnostics(result)}`,
      );
    });
  });

  test('TIER-1.2 gh-11: manager_handoff_pending is no longer a named handoff stop condition — it halts via the generic non-incomplete path', () => {
    runFixtureTest((fixture) => {
      writeMuxRunner(fixture, singleExitReasonRunner('manager_handoff_pending'));
      const result = runScript(fixture, { PICKLE_AUTO_RESUME_MAX_RETRIES: '5' });
      assertCompleted(result);
      assert.equal(
        result.stderr.includes("manager handoff required (exit_reason='manager_handoff_pending')"),
        false,
        `manager_handoff_pending must not print the named handoff banner\n${formatResultDiagnostics(result)}`,
      );
      assert.ok(
        result.stderr.includes("exit_reason='manager_handoff_pending'"),
        `expected the generic stop line to still name the reason\n${formatResultDiagnostics(result)}`,
      );
    });
  });

  test('halts when MAX_RETRIES exhausted', () => {
    runFixtureTest((fixture) => {
      writeMuxRunner(fixture, incompleteRunner());
      const result = runScript(fixture, { PICKLE_AUTO_RESUME_MAX_RETRIES: '2' });
      assertCompleted(result);
      assert.ok(
        result.stderr.includes('exhausted max retries (2)'),
        `expected max-retries stop\n${formatResultDiagnostics(result)}`,
      );
    });
  });

  test('halts on no-progress past PROGRESS_THRESHOLD', () => {
    // PROGRESS_THRESHOLD=3 hardcoded; same ticket + 0 done → fires at retry 3
    runFixtureTest((fixture) => {
      writeMuxRunner(fixture, `const fs = require('fs');
const s = JSON.parse(fs.readFileSync(process.argv[2] + '/state.json', 'utf8'));
s.exit_reason = 'pipeline_phase_incomplete';
s.current_ticket = 'stuck-ticket';
fs.writeFileSync(process.argv[2] + '/state.json', JSON.stringify(s));
`);
      const result = runScript(fixture, { PICKLE_AUTO_RESUME_MAX_RETRIES: '20' }, NO_PROGRESS_TIMEOUT_MS);
      assertCompleted(result);
      assert.ok(
        result.stderr.includes('no progress'),
        `expected no-progress stop\n${formatResultDiagnostics(result)}`,
      );
    }, { ticket: 'stuck-ticket' });
  });

  test('prints [warn] banner past retry 3', () => {
    // Repeat the prior ticket on the third launch so retry 4 reaches the warning
    // and no-progress halt in the same loop instead of waiting for a fifth launch.
    runFixtureTest((fixture) => {
      writeMuxRunner(fixture, `const fs = require('fs');
const path = require('path');
const sessionDir = process.argv[2];
const stateFile = path.join(sessionDir, 'state.json');
const cf = process.argv[2] + '/.n';
const traceFile = path.join(sessionDir, 'runner-trace.jsonl');
let n = 0;
try { n = parseInt(fs.readFileSync(cf, 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync(cf, String(n));
const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
s.exit_reason = 'pipeline_phase_incomplete';
const nextTicket = n === 3 ? 'ticket_2' : 'ticket_' + n;
s.current_ticket = nextTicket;
fs.writeFileSync(stateFile, JSON.stringify(s));
fs.appendFileSync(traceFile, JSON.stringify({
  run: n,
  current_ticket: s.current_ticket,
  exit_reason: s.exit_reason,
}) + '\\n');
`);
      // MAX_RETRIES stays above the banner threshold while retry-state progression
      // forces the stop after the retry-4 warning.
      const result = runScript(fixture, { PICKLE_AUTO_RESUME_MAX_RETRIES: '5' }, WARN_BANNER_TIMEOUT_MS);
      assertCompleted(result);
      assert.ok(
        result.stderr.includes('[warn] auto-resume retry'),
        `expected [warn] banner\n${formatResultDiagnostics(result)}`,
      );
      const bannerLines = result.stderrLines.filter(line => line.includes('[warn] auto-resume retry'));
      assert.equal(bannerLines.length, 1, `expected exactly one warning banner\n${formatResultDiagnostics(result)}`);
      assert.match(
        bannerLines[0],
        /\[warn\] auto-resume retry 4\/5 \(no progress for 1 cycles\)/,
        `banner format mismatch\n${formatResultDiagnostics(result)}`,
      );
      assert.ok(
        result.stderr.includes('stopped: no progress for 1 consecutive retries'),
        `expected retry-state stop after warning banner\n${formatResultDiagnostics(result)}`,
      );
      assert.equal(readIfExists(fixture.counterFile), '4', `expected retry counter to persist across four launches\n${formatResultDiagnostics(result)}`);
      assert.deepEqual(
        readTraceEntries(fixture).map(entry => [entry.run, entry.current_ticket]),
        [
          [1, 'ticket_1'],
          [2, 'ticket_2'],
          [3, 'ticket_2'],
          [4, 'ticket_4'],
        ],
        `expected retry-state progression trace\n${formatResultDiagnostics(result)}`,
      );
    });
  });

  test('prints [warn] banner past retry 3 — regression for load-dependent-timeout', () => {
    runFixtureTest((fixture) => {
      writeMuxRunner(fixture, `const fs = require('fs');
const path = require('path');
const sessionDir = process.argv[2];
const stateFile = path.join(sessionDir, 'state.json');
const cf = process.argv[2] + '/.n';
const traceFile = path.join(sessionDir, 'runner-trace.jsonl');
let n = 0;
try { n = parseInt(fs.readFileSync(cf, 'utf8'), 10) || 0; } catch {}
n++;
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
fs.writeFileSync(cf, String(n));
const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
s.exit_reason = 'pipeline_phase_incomplete';
const nextTicket = n === 3 ? 'ticket_2' : 'ticket_' + n;
s.current_ticket = nextTicket;
fs.writeFileSync(stateFile, JSON.stringify(s));
fs.appendFileSync(traceFile, JSON.stringify({
  run: n,
  current_ticket: s.current_ticket,
  exit_reason: s.exit_reason,
}) + '\\n');
`);
      const result = runScript(fixture, { PICKLE_AUTO_RESUME_MAX_RETRIES: '5' }, LOAD_TIMEOUT_REGRESSION_MS);
      assertCompleted(result);
      const bannerLines = result.stderrLines.filter(line => line.includes('[warn] auto-resume retry'));
      assert.equal(bannerLines.length, 1, `expected one delayed warning banner\n${formatResultDiagnostics(result)}`);
      assert.match(
        bannerLines[0],
        /\[warn\] auto-resume retry 4\/5 \(no progress for 1 cycles\)/,
        `delayed banner format mismatch\n${formatResultDiagnostics(result)}`,
      );
      assert.ok(
        result.stderr.includes('stopped: no progress for 1 consecutive retries'),
        `expected delayed retry-state stop\n${formatResultDiagnostics(result)}`,
      );
      assert.equal(readIfExists(fixture.counterFile), '4', `expected delayed fixture to stop after four launches\n${formatResultDiagnostics(result)}`);
      assert.deepEqual(
        readTraceEntries(fixture).map(entry => [entry.run, entry.current_ticket]),
        [
          [1, 'ticket_1'],
          [2, 'ticket_2'],
          [3, 'ticket_2'],
          [4, 'ticket_4'],
        ],
        `expected delayed retry-state progression trace\n${formatResultDiagnostics(result)}`,
      );
    });
  });

  test('reaps timed-out auto-resume children during fixture cleanup', () => {
    let sessionDir = '';
    runFixtureTest((fixture) => {
      sessionDir = fixture.sessionDir;
      writeMuxRunner(fixture, `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
`);
      const result = runScript(fixture, {}, 200);
      assert.equal(result.error?.code, 'ETIMEDOUT', formatResultDiagnostics(result));
    });
    assert.deepEqual(
      listFixtureProcessPids(sessionDir),
      [],
      `expected fixture cleanup to reap lingering auto-resume processes for ${sessionDir}`,
    );
  });
});
