import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { conformanceVerdictIsFail, runIteration } from '../../bin/mux-runner.js';
import { type State } from '../../types/index.js';

function makeExecutableNodeScript(filePath: string, source: string): void {
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${source}`);
  fs.chmodSync(filePath, 0o755);
}

function buildState(sessionDir: string): State {
  return {
    active: true,
    // Live pid so the R-PTSB-3 phantom-demotion guard does not flip this active
    // fixture to inactive on read (the timeout classifier would then return
    // 'inactive' instead of 'continue').
    pid: process.pid,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 0,
    max_iterations: 5,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1_700_000_000,
    completion_promise: null,
    original_prompt: 'R-APMW-6 test',
    current_ticket: null,
    history: [],
    started_at: '2026-05-12T00:00:00.000Z',
    session_dir: sessionDir,
    backend: 'claude',
    schema_version: 3,
  };
}

function makeScenarioSession(prefix: string): {
  sessionDir: string;
  fakeBin: string;
  signalFile: string;
  markerFile: string;
} {
  const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(sessionDir, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'templates', '_pickle-manager-prompt.md'), '# Pickle\n\n$ARGUMENTS\n');
  // eslint-disable-next-line pickle/no-raw-state-write -- isolated test fixture bootstrap before any runner lock exists
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(buildState(sessionDir)));

  const fakeBin = path.join(sessionDir, 'fake-bin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const signalFile = path.join(sessionDir, 'signals.log');
  const markerFile = path.join(sessionDir, 'marker.log');

  makeExecutableNodeScript(path.join(fakeBin, 'claude'), `
const fs = require('node:fs');

const scenario = process.env.R_APMW6_SCENARIO;
const signalFile = process.env.R_APMW6_SIGNAL_FILE;
const markerFile = process.env.R_APMW6_MARKER_FILE;

function note(line) {
  if (!markerFile) return;
  fs.appendFileSync(markerFile, line + '\\n');
}

function emit(line) {
  process.stdout.write(line + '\\n');
  note('emit:' + line);
}

process.on('SIGTERM', () => {
  if (scenario === 'output-stall-delayed-sigterm') return;
  if (signalFile) fs.appendFileSync(signalFile, 'SIGTERM\\n');
  process.exit(0);
});

if (scenario === 'output-stall') {
  emit('start');
  let count = 0;
  let keepAlive = null;
  const timer = setInterval(() => {
    count += 1;
    emit('progress-' + count);
    if (count >= 5) {
      clearInterval(timer);
      keepAlive = setTimeout(() => {
        note('unexpected-exit');
        process.exit(0);
      }, 60_000);
    }
  }, 60);
  process.on('exit', () => {
    if (keepAlive) clearTimeout(keepAlive);
  });
} else if (scenario === 'output-stall-delayed-sigterm') {
  emit('start');
  let count = 0;
  let keepAlive = null;
  const timer = setInterval(() => {
    count += 1;
    emit('progress-' + count);
    if (count >= 3) {
      clearInterval(timer);
      keepAlive = setTimeout(() => {
        note('unexpected-exit');
        process.exit(0);
      }, 60_000);
    }
  }, 60);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    if (keepAlive) clearTimeout(keepAlive);
    setTimeout(() => {
      if (signalFile) fs.appendFileSync(signalFile, 'SIGTERM\\n');
      emit('shutdown-complete');
      process.exit(0);
    }, 75);
  });
  process.on('exit', () => {
    clearInterval(timer);
    if (keepAlive) clearTimeout(keepAlive);
  });
} else if (scenario === 'wall-clock') {
  emit('start');
  const timer = setInterval(() => {
    emit('progress');
  }, 10);
  process.on('exit', () => clearInterval(timer));
} else if (scenario === 'success') {
  emit('ready');
  setTimeout(() => {
    note('success-exit');
    process.exit(0);
  }, 20);
} else {
  process.exit(2);
}
`);

  return { sessionDir, fakeBin, signalFile, markerFile };
}

async function runScenario(
  scenario: 'output-stall' | 'output-stall-delayed-sigterm' | 'wall-clock' | 'success',
  overrides: { MAX_ITERATION_SECONDS: number; OUTPUT_STALL_SECONDS: number },
) {
  const { sessionDir, fakeBin, signalFile, markerFile } = makeScenarioSession(`pickle-rapmw6-${scenario}-`);

  try {
    const outcome = await runIteration(sessionDir, 1, sessionDir, '', {
      envOverrides: {
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
        PICKLE_BACKEND: 'claude',
        R_APMW6_SCENARIO: scenario,
        R_APMW6_SIGNAL_FILE: signalFile,
        R_APMW6_MARKER_FILE: markerFile,
      },
      maxIterationSeconds: overrides.MAX_ITERATION_SECONDS,
      outputStallSeconds: overrides.OUTPUT_STALL_SECONDS,
    });

    return { outcome, sessionDir, signalFile, markerFile };
  } finally {
    // env overrides are scoped to runIteration; only the temp session needs cleanup here.
  }
}

// R-TSPF residual: the OUTPUT_STALL guard inside runIteration starts counting
// from subprocess spawn (`lastDataAt = start`). Under full-suite
// `--test-concurrency=8` load, a fresh `node` fake-claude cold-start can take
// many seconds before it emits its first byte — if that cold-start exceeds
// the stall budget the guard fires against startup jitter rather than a
// genuine output gap, killing the child before it can emit (`tmux_iteration`
// log empty). The invariant under test is "stall fires AFTER output goes
// silent", not the absolute budget, so the stall budget is widened well past
// worst-case cold-start while staying far below the iteration budget — the
// `wallSeconds` assertions still prove the stall, not the wall-clock guard,
// did the work.
const STALL_BUDGET_SECONDS = 12;
const ITERATION_BUDGET_SECONDS = 30;

test('R-APMW-6: output every 60s for 5 cycles then silence - fires at OUTPUT_STALL_SECONDS', async () => {
  const scenario = await runScenario('output-stall', {
    MAX_ITERATION_SECONDS: ITERATION_BUDGET_SECONDS,
    OUTPUT_STALL_SECONDS: STALL_BUDGET_SECONDS,
  });

  try {
    assert.equal(scenario.outcome.completion, 'error');
    assert.equal(scenario.outcome.timedOut, true);
    assert.equal(scenario.outcome.stallReason, 'output_stall');
    assert.equal(scenario.outcome.exitCode, null);
    assert.ok(scenario.outcome.wallSeconds >= STALL_BUDGET_SECONDS - 0.05);
    assert.ok(scenario.outcome.wallSeconds < ITERATION_BUDGET_SECONDS);
  } finally {
    fs.rmSync(scenario.sessionDir, { recursive: true, force: true });
  }
});

test('R-APMW-6: output every 10s for 4h - wall-clock guard fires', async () => {
  // wall-clock scenario emits every 10ms forever, so the stall guard must
  // never fire — the wall-clock budget must exceed worst-case `node`
  // cold-start under full-suite load so the subprocess is genuinely running
  // (and re-arming the stall guard on every emit) before the wall-clock guard
  // trips it.
  const scenario = await runScenario('wall-clock', {
    MAX_ITERATION_SECONDS: 20,
    OUTPUT_STALL_SECONDS: STALL_BUDGET_SECONDS,
  });

  try {
    assert.equal(scenario.outcome.completion, 'error');
    assert.equal(scenario.outcome.timedOut, true);
    assert.equal(scenario.outcome.stallReason, 'wall_clock');
    assert.equal(scenario.outcome.exitCode, null);
  } finally {
    fs.rmSync(scenario.sessionDir, { recursive: true, force: true });
  }
});

test('R-APMW-6: timeout waits for delayed SIGTERM cleanup before resolving', async () => {
  const scenario = await runScenario('output-stall-delayed-sigterm', {
    MAX_ITERATION_SECONDS: ITERATION_BUDGET_SECONDS,
    OUTPUT_STALL_SECONDS: STALL_BUDGET_SECONDS,
  });

  try {
    assert.equal(scenario.outcome.completion, 'error');
    assert.equal(scenario.outcome.timedOut, true);
    assert.equal(scenario.outcome.stallReason, 'output_stall');
    assert.match(await fs.promises.readFile(path.join(scenario.sessionDir, 'tmux_iteration_1.log'), 'utf-8'), /shutdown-complete/);
    assert.match(await fs.promises.readFile(scenario.signalFile, 'utf-8'), /SIGTERM/);
  } finally {
    fs.rmSync(scenario.sessionDir, { recursive: true, force: true });
  }
});

test('R-APMW-6: normal subprocess clears both timers on success', async () => {
  const timeoutCountBefore = process.getActiveResourcesInfo().filter((entry) => entry === 'Timeout').length;
  // R-TSPF residual: the `success` scenario exits ~20ms after first output,
  // so it should always resolve `continue` — but a 3s wall-clock budget was
  // shorter than worst-case fake-claude `node` cold-start under full-suite
  // 8-way load, letting the hang guard win and flip completion to `error`.
  // Both budgets are widened past cold-start jitter; the subprocess still
  // exits in ~20ms once running, so timer-cleanup coverage is intact.
  const scenario = await runScenario('success', {
    MAX_ITERATION_SECONDS: ITERATION_BUDGET_SECONDS,
    OUTPUT_STALL_SECONDS: ITERATION_BUDGET_SECONDS,
  });

  try {
    assert.equal(scenario.outcome.completion, 'continue');
    assert.equal(scenario.outcome.timedOut, false);
    assert.equal(scenario.outcome.stallReason, undefined);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const timeoutCountAfter = process.getActiveResourcesInfo().filter((entry) => entry === 'Timeout').length;
    assert.ok(timeoutCountAfter <= timeoutCountBefore + 1);
    await assert.rejects(fs.promises.access(scenario.signalFile), { code: 'ENOENT' });
  } finally {
    fs.rmSync(scenario.sessionDir, { recursive: true, force: true });
  }
});

// AP-BIN-ITER257-01: the verdict token sits on the first NON-BLANK line after the heading. 4 of 48
// live conformance artifacts write `## 6. Verdict`, a blank line, then `**FAIL**`/`**ALL_PASS**`;
// reading only the very next line saw the blank and refused nothing, so a FAIL self-flip shipped Done.
test('AP-BIN-ITER257-01: a verdict separated from its heading by blank lines is read', () => {
  assert.equal(conformanceVerdictIsFail('# Conformance\n\n## 6. Verdict\n\n**FAIL**\n\n- criterion 2\n'), true);
  assert.equal(conformanceVerdictIsFail('# Conformance\n\n## 6. Verdict\n\n\n**FAIL**\n'), true);
  // Controls: the same layout with ALL_PASS, the template line, and a heading followed only by prose.
  assert.equal(conformanceVerdictIsFail('# Conformance\n\n## 6. Verdict\n\n**ALL_PASS**\n'), false);
  assert.equal(conformanceVerdictIsFail('6. **Verdict**: ALL_PASS / FAIL (failures with file:line refs)\n'), false);
  assert.equal(conformanceVerdictIsFail('## Verdict\n\nSee notes.\n\nFAIL\n'), false);
});
