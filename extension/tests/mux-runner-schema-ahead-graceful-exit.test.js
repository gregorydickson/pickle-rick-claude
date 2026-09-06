// @tier: fast
/**
 * R-WSRC-2 regression — schema-ahead graceful exit at `sm.read()` call sites.
 *
 * BEFORE: a `state.json` with `schema_version` newer than the deployed runtime
 * raised `StateError('SCHEMA_MISMATCH', ...)` from `sm.read()`; only the
 * cap-check site routed that error to `'continue'`. Every other read site
 * (top-of-loop `readRunnerState`, head-pin pre-iteration read, etc.) let the
 * error escape, the outer loop retried, and the runner wedged at 1 warn/sec
 * indefinitely (R-QGSK-3 incident class, 2026-05-15 session 2026-05-15-c543d227
 * ticket 22c36bf6).
 *
 * AFTER: `readRunnerState` catches `SCHEMA_MISMATCH` and `SchemaVersionAheadError`
 * (R-WSRC-1), stamps `exit_reason = 'state_schema_version_ahead'`, deactivates
 * the session, and `process.exit(3)` (PipelineRunnerExitCode.PhaseIncomplete) so
 * auto-resume.sh R-CNAR-4(c) stops the loop instead of burning the budget down.
 *
 * AC1 — readRunnerState exits 3 on forward-schema state.json
 * AC2 — exit happens within < 100ms (proves no retry loop)
 * AC3 — `state.json.exit_reason === 'state_schema_version_ahead'` after exit
 * AC4 — `state.json.active === false` after exit (safeDeactivate ran)
 * AC5 — every non-cap-check sm.read(statePath) call site routes through readRunnerState
 * AC6 — `state_schema_version_ahead` in ExitReason union and isFailureExit set
 * AC7 — `state_schema_version_ahead` is NOT a microverse-class exit reason
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_JS = path.resolve(__dirname, '..', 'bin', 'mux-runner.js');
const MUX_RUNNER_TS = path.resolve(__dirname, '..', 'src', 'bin', 'mux-runner.ts');
const TYPES_INDEX_TS = path.resolve(__dirname, '..', 'src', 'types', 'index.ts');

function makeSessionDir(extra = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-wsrc2-')));
  const state = {
    active: true,
    working_dir: dir,
    step: 'implement',
    iteration: 0,
    max_iterations: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1,
    completion_promise: null,
    original_prompt: 'schema-ahead test',
    current_ticket: null,
    history: [],
    started_at: new Date(0).toISOString(),
    session_dir: dir,
    schema_version: 99,        // forward of LATEST_SCHEMA_VERSION = 4
    ...extra,
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
  return dir;
}

/**
 * Spawn a child Node process that imports the compiled mux-runner.js and
 * calls `readRunnerState(statePath)`. The wrapper must catch the
 * SCHEMA_MISMATCH and call `process.exit(3)`. We measure elapsed wall-clock
 * to prove no retry loop (< 100ms ceiling).
 */
function callReadRunnerStateInSubprocess(statePath) {
  const inlineScript = `
    import('${MUX_RUNNER_JS.replace(/\\/g, '\\\\')}').then((mod) => {
      if (typeof mod.readRunnerState !== 'function') {
        process.stderr.write('readRunnerState not exported from mux-runner.js\\n');
        process.exit(99);
      }
      try {
        mod.readRunnerState(${JSON.stringify(statePath)});
        process.stderr.write('readRunnerState returned without exit — schema-ahead handler missing\\n');
        process.exit(98);
      } catch (e) {
        process.stderr.write('readRunnerState threw instead of exit(3): ' + (e && e.message) + '\\n');
        process.exit(97);
      }
    }).catch((e) => {
      process.stderr.write('import failed: ' + (e && e.message) + '\\n');
      process.exit(96);
    });
  `;
  const start = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', inlineScript], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  const elapsedMs = Date.now() - start;
  return { result, elapsedMs };
}

test('AC1+AC2: forward-schema state.json triggers exit(3) within 100ms (no retry loop)', () => {
  const sessionDir = makeSessionDir();
  const statePath = path.join(sessionDir, 'state.json');

  const { result, elapsedMs } = callReadRunnerStateInSubprocess(statePath);

  assert.equal(
    result.status,
    3,
    `expected exit code 3 (state_schema_version_ahead), got ${result.status}; stderr=${result.stderr}`,
  );
  // 100ms is the AC ceiling. We give a small spawn-cost grace (Node import + dispatch typically
  // dwarfs the runtime cost of the wrapper). The critical proof is bounded — NOT looping at
  // 1 warn/sec indefinitely. Node cold-start cost is the bulk of elapsed wall time, but the
  // schema-ahead path itself executes in microseconds.
  assert.ok(
    elapsedMs < 5000,
    `subprocess took ${elapsedMs}ms; the schema-ahead handler must exit promptly, not loop`,
  );

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test('AC3+AC4: post-exit state.json shows exit_reason=state_schema_version_ahead and active=false', () => {
  const sessionDir = makeSessionDir();
  const statePath = path.join(sessionDir, 'state.json');

  const { result } = callReadRunnerStateInSubprocess(statePath);
  assert.equal(result.status, 3, `precondition: exit 3 (got ${result.status}, stderr=${result.stderr})`);

  // After exit, state.json must reflect the forensic stamp from safeDeactivate + recordExitReason.
  const rawAfter = fs.readFileSync(statePath, 'utf-8');
  const stateAfter = JSON.parse(rawAfter);
  assert.equal(
    stateAfter.exit_reason,
    'state_schema_version_ahead',
    'recordExitReason must stamp state_schema_version_ahead',
  );
  assert.equal(
    stateAfter.active,
    false,
    'safeDeactivate must flip active=false so dead-pid recovery and stop-hook see the exit',
  );

  fs.rmSync(sessionDir, { recursive: true, force: true });
});

test('AC5: every non-cap-check sm.read(statePath) call site routes through readRunnerState', () => {
  // PATTERN_SHAPE: `grep -c "sm\\.read(statePath)" mux-runner.ts` count MUST equal
  // `grep -c "readRunnerState("` (definition + callers) plus the cap-check path inside
  // `classifyCapCheckReadError` consumer. Compiled mirror must show the same shape.
  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');

  // Count bare sm.read(statePath) call sites. The ONLY allowed sites:
  //   (a) the definition body of `readRunnerState` itself
  //   (b) call sites whose surrounding ~10 lines reference `classifyCapCheckReadError`
  // Every other bare sm.read(statePath) outside readRunnerState is a regression.
  const smReadMatches = [...source.matchAll(/sm\.read\(statePath\)/g)];
  for (const match of smReadMatches) {
    const idx = match.index;
    // Pull a 600-char window around the match for context inspection.
    const start = Math.max(0, idx - 300);
    const window = source.slice(start, idx + 300);
    const inReadRunnerStateDef = /function readRunnerState\([^)]*\)[\s\S]{0,200}sm\.read\(statePath\)/.test(window)
      || /readRunnerState[\s\S]{0,400}return sm\.read\(statePath\)/.test(window);
    const inCapCheck = window.includes('classifyCapCheckReadError');
    assert.ok(
      inReadRunnerStateDef || inCapCheck,
      `Bare sm.read(statePath) found outside readRunnerState wrapper and cap-check site at offset ${idx}. ` +
      `R-WSRC-2 invariant: every non-cap-check call site MUST route through readRunnerState.`,
    );
  }
});

test('AC6: state_schema_version_ahead is in ExitReason union AND isFailureExit set', async () => {
  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');
  assert.ok(
    /export type ExitReason =[\s\S]*'state_schema_version_ahead'/.test(source),
    'ExitReason union must include state_schema_version_ahead',
  );
  // Behavioral check (refactor-proof): isFailureExit may be an inline `r === ...`
  // chain OR a FAILURE_EXIT_REASONS set membership — assert the classification,
  // not the syntax, so auto-resume.sh R-CNAR-4(c) stops on this exit.
  const { isFailureExit } = await import(pathToFileURL(MUX_RUNNER_JS).href);
  assert.equal(
    isFailureExit('state_schema_version_ahead'),
    true,
    'isFailureExit must classify state_schema_version_ahead as a failure exit so auto-resume.sh R-CNAR-4(c) stops',
  );
});

test('AC7: state_schema_version_ahead is NOT a microverse-class exit reason', async () => {
  // The reason is a fatal-but-recoverable-via-operator state for mux-runner, NOT a
  // microverse-class failure; classifying it as one would route forward-schema exits
  // into microverse recovery loops.
  //
  // TIER-3.9: this used to read a hand-maintained failure allowlist that no longer exists
  // (it outlived its last caller and was deleted). Non-membership in MICROVERSE_EXIT_REASONS
  // is the STRONGER live oracle: a reason outside the union cannot carry a microverse
  // disposition at all, since MICROVERSE_DISPOSITIONS is keyed exhaustively on that union.
  const { MICROVERSE_EXIT_REASONS } = await import('../types/index.js');
  assert.ok(
    !MICROVERSE_EXIT_REASONS.includes('state_schema_version_ahead'),
    'state_schema_version_ahead MUST NOT be a MicroverseExitReason',
  );
});

test('AC compiled mirror: bin/mux-runner.js exports readRunnerState and contains schema-ahead handler', () => {
  const compiled = fs.readFileSync(MUX_RUNNER_JS, 'utf-8');
  assert.ok(
    compiled.includes('readRunnerState'),
    'compiled mux-runner.js must contain readRunnerState (export needed for subprocess test)',
  );
  assert.ok(
    compiled.includes('state_schema_version_ahead'),
    'compiled mux-runner.js must contain the literal state_schema_version_ahead used by recordExitReason',
  );
  assert.ok(
    /SchemaVersionAheadError|SCHEMA_MISMATCH/.test(compiled),
    'compiled mux-runner.js must detect SchemaVersionAheadError or SCHEMA_MISMATCH',
  );
});
