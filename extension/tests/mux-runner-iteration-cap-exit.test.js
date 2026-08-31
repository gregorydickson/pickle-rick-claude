// @tier: fast
/**
 * AC-ICP-01 — mux-runner exits with code 3 when iteration cap is hit without
 * EPIC_COMPLETED. Exit code 3 is distinct from success (0) and generic
 * failure (1), letting pipeline-runner call reportPhaseIncomplete instead of
 * logPhaseHaltReason and stamp pipeline_phase_incomplete on state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUX_RUNNER_JS = path.resolve(__dirname, '..', 'bin', 'mux-runner.js');
const MUX_RUNNER_TS = path.resolve(__dirname, '..', 'src', 'bin', 'mux-runner.ts');

const { buildTmuxNotification } = await import('../bin/mux-runner.js');
const { parseArguments } = await import('../bin/setup.js');

test('mux-runner.iteration-cap-distinct-exit', () => {
  const compiled = fs.readFileSync(MUX_RUNNER_JS, 'utf-8');
  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');

  // TS source: explicit branch maps iteration_cap_exhausted to exitCode 3
  assert.ok(
    source.includes("if (exitReason === 'iteration_cap_exhausted') exitCode = 3;"),
    'TS source must have: if (exitReason === \'iteration_cap_exhausted\') exitCode = 3;',
  );

  // Compiled: exitCode 3 branch appears before the isFailedExit=1 branch
  const cap3Idx = compiled.indexOf('exitCode = 3');
  const cap1Idx = compiled.indexOf('exitCode = 1');
  const cap0Idx = compiled.indexOf('exitCode = 0');
  assert.ok(cap3Idx !== -1, 'compiled code must assign exitCode = 3');
  assert.ok(cap1Idx !== -1, 'compiled code must assign exitCode = 1');
  assert.ok(cap0Idx !== -1, 'compiled code must assign exitCode = 0');
  assert.ok(cap3Idx < cap1Idx, 'code-3 branch must precede the isFailedExit=1 branch');
  assert.ok(cap1Idx < cap0Idx, 'code-1 branch must precede the success=0 branch');

  // All three exit codes are at distinct byte positions (not the same branch)
  const unique = new Set([cap3Idx, cap1Idx, cap0Idx]);
  assert.equal(unique.size, 3, 'exitCode 0, 1, and 3 must be at three distinct code sites');

  // buildTmuxNotification classifies iteration_cap_exhausted as a failure
  const notif = buildTmuxNotification('iteration_cap_exhausted', 'implement', 5, 300);
  assert.ok(notif.title.includes('Failed'), 'notification title must indicate failure for cap-exit');
  assert.ok(
    notif.subtitle.includes('iteration_cap_exhausted'),
    'subtitle must name the exit reason so operators can identify cap-hit',
  );

  // Contrast: success and limit exits produce non-failure titles and do NOT get code 3
  const successNotif = buildTmuxNotification('success', 'completed', 10, 600);
  assert.ok(successNotif.title.includes('Complete'), 'success exit must not be flagged as failure');
});

// `--max-iterations 0` regression pin (ticket 38892302, FR-D3). Disposition: STALE.
//
// The filed defect: `--max-iterations 0` stops the run after ONE ticket. That would require
// the flag value to reach a bare `while (i < max)`-style comparison. It does not.
//
// Measured END-TO-END before writing this pin, by running the REAL compiled bin/mux-runner.js
// as a subprocess over three states differing ONLY in max_iterations, with iteration: 5:
//   max_iterations=5  -> exit 3, exit_reason=iteration_cap_exhausted, "Max iterations reached" (control)
//   max_iterations=0  -> exit 0, cap never fired
//   max_iterations=99 -> exit 0, cap never fired (control)
// i.e. 0 behaves identically to abundant runway, NOT like an exhausted cap.
//
// The pin is deliberately subprocess-free: this file is absent from the DERIVED
// tests/.serial-tests.json, and audit-subprocess-heavy-tests.sh would then require a manifest
// edit. So the two halves below pin (a) the flag genuinely passing 0 through, and (b) the
// `> 0` guard that makes 0 mean "no cap" — in BOTH the .ts source and the compiled mirror, so
// a stale mirror cannot hide a change. Same source+compiled idiom as the test above.
test('mux-runner.max-iterations-zero-means-uncapped', () => {
  // (a) The flag passes 0 through rather than rejecting-and-defaulting.
  // If 0 were rejected and defaulted, loopLimit would come back as the 100 default.
  const zero = parseArguments(['--max-iterations', '0', '--task', 'cap-zero-pin']);
  assert.equal(zero.loopLimit, 0, '--max-iterations 0 must pass 0 through, not default');
  const five = parseArguments(['--max-iterations', '5', '--task', 'cap-five-pin']);
  assert.equal(five.loopLimit, 5, 'control: a positive value round-trips unchanged');

  // (b) The consumer treats 0 as "no cap". Both cap-checks are `> 0`-guarded, so a zero
  // budget can never satisfy them — this is what makes 0 unlimited rather than instantly
  // exhausted. Pinned in source AND compiled.
  const source = fs.readFileSync(MUX_RUNNER_TS, 'utf-8');
  const compiled = fs.readFileSync(MUX_RUNNER_JS, 'utf-8');
  const GLOBAL_CAP_GUARD = 'globalMaxIter > 0 && curIter >= globalMaxIter';
  const TICKET_CAP_GUARD = 'ticketMaxIter > 0 && budgetIter >= ticketMaxIter';
  for (const [label, text] of [['TS source', source], ['compiled', compiled]]) {
    assert.ok(
      text.includes(GLOBAL_CAP_GUARD),
      `${label} global cap must stay "> 0"-guarded so max_iterations=0 means uncapped`,
    );
    assert.ok(
      text.includes(TICKET_CAP_GUARD),
      `${label} per-ticket cap must stay "> 0"-guarded`,
    );
  }

  // A bare `curIter >= globalMaxIter` with no positivity guard is the shape that would make
  // 0 halt immediately — assert that ungated form is absent from both.
  for (const [label, text] of [['TS source', source], ['compiled', compiled]]) {
    const guarded = text.split(GLOBAL_CAP_GUARD).length - 1;
    const total = text.split('curIter >= globalMaxIter').length - 1;
    assert.equal(
      total, guarded,
      `${label} must have no unguarded "curIter >= globalMaxIter" comparison`,
    );
  }
});
