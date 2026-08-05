// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// e9b2381a (AC-A3): Per-ticket completion MUST key on the deterministic
// runWorkerGate (tsc + eslint + single-pass test:fast), NEVER the c=8 flake
// budget. The flake budget (`check-flake-budget` / `test:fast:budget`, 5 reruns,
// --fail-budget=2) is the once-per-bundle release/CI gate — it has NO place in
// any per-ticket or between-ticket completion path.
//
// This is a source-level lock-absent regression. There is no per-ticket
// flake-budget call site to remove (confirmed absent); this test proves the
// absence stays absent. Assertions key on the CONCEPT (flake-budget wiring),
// not brittle line numbers.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const muxRunnerSrcPath = path.resolve(__dirname, '../src/bin/mux-runner.ts');
const spawnMortySrcPath = path.resolve(__dirname, '../src/bin/spawn-morty.ts');
const flakeBudgetSrcPath = path.resolve(__dirname, '../src/bin/check-flake-budget.ts');

// The tokens that mark a flake-BUDGET (reruns) rather than a single pass.
// `test:fast` (single pass, c=8 parallelism) is allowed; the budget is not.
const FLAKE_BUDGET_TOKENS = ['check-flake-budget', 'test:fast:budget', 'checkFlakeBudget'];
const CONCURRENCY_BUDGET_TOKEN = '--test-concurrency=8';

function readSrc(p) {
  return readFileSync(p, 'utf8');
}

test('per-ticket completion path (mux-runner.ts) has NO flake-budget wiring', () => {
  const src = readSrc(muxRunnerSrcPath);
  for (const token of FLAKE_BUDGET_TOKENS) {
    assert.ok(
      !src.includes(token),
      `mux-runner.ts must NOT reference the flake budget token "${token}" — per-ticket completion keys on runWorkerGate / single-pass test:fast, not the c=8 flake budget`,
    );
  }
  // `--test-concurrency=8` is the budget's rerun flag; it must not be inlined
  // into the per-ticket path. (npm's test:fast script carries it, but mux-runner
  // shells `npm run test:fast` — it never spells out the concurrency flag.)
  assert.ok(
    !src.includes(CONCURRENCY_BUDGET_TOKEN),
    `mux-runner.ts must NOT inline "${CONCURRENCY_BUDGET_TOKEN}" — the per-ticket path delegates to "npm run test:fast", never a hand-spelled flake-budget invocation`,
  );
});

test('between-ticket gate (runBetweenTicketFastTests) runs a single deterministic test:fast pass', () => {
  const src = readSrc(muxRunnerSrcPath);
  assert.ok(
    src.includes('runBetweenTicketFastTests'),
    'runBetweenTicketFastTests must exist as the between-ticket gate seam in mux-runner.ts',
  );
  // B-OFFREPO ticket 20 — ANCHOR CORRECTED, invariant unchanged.
  //
  // This guards that the between-ticket gate is a SINGLE deterministic
  // `run test:fast` pass rather than the c=8 flake-budget rerun. It used to
  // anchor on the literal `spawnSync('npm', ...)`, which also pinned the
  // hardcoded package manager — the exact hardcode AC-OFFREPO-2d removes. The
  // binary is now resolved from the detected project type (`npm` for this repo,
  // so what runs is unchanged); the single-pass invariant is what matters and is
  // what is pinned here. The flake-budget token checks below are untouched.
  assert.ok(
    /spawnSync\(packageManager, \['run', 'test:fast'\]/.test(src),
    'between-ticket gate must spawn a SINGLE `run test:fast` pass (package manager resolved, not hardcoded), not the flake budget',
  );
});

test('worker gate (runWorkerGate) uses test:fast / test:integration, never the flake budget', () => {
  const src = readSrc(spawnMortySrcPath);
  assert.ok(
    src.includes('runWorkerGate'),
    'runWorkerGate must exist as the deterministic per-ticket gate in spawn-morty.ts',
  );
  assert.ok(
    src.includes("'test:fast'") && src.includes("'test:integration'"),
    "runWorkerGate's test path must reference 'test:fast' and 'test:integration'",
  );
  for (const token of FLAKE_BUDGET_TOKENS) {
    assert.ok(
      !src.includes(token),
      `spawn-morty.ts must NOT reference the flake budget token "${token}" — the worker gate is deterministic (single pass)`,
    );
  }
  assert.ok(
    !src.includes(CONCURRENCY_BUDGET_TOKEN),
    `spawn-morty.ts must NOT inline "${CONCURRENCY_BUDGET_TOKEN}" in the worker gate`,
  );
});

test('the flake budget still lives isolated in its own CLI (not globally deleted)', () => {
  // Guard against a false-green where someone deletes the budget entirely:
  // the once-per-bundle release/CI gate is legitimate and must keep existing,
  // just isolated from the per-ticket path.
  const src = readSrc(flakeBudgetSrcPath);
  assert.ok(
    src.includes('checkFlakeBudgetMain'),
    'check-flake-budget.ts must retain the once-per-bundle flake-budget CLI (checkFlakeBudgetMain)',
  );
  assert.ok(
    src.includes(CONCURRENCY_BUDGET_TOKEN),
    'check-flake-budget.ts is the legitimate home of the c=8 flake-budget rerun invocation',
  );
});
