// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const RUNNER_JS = path.join(EXTENSION_ROOT, 'bin', 'test-runner.js');
const SERIAL_MANIFEST = path.join(EXTENSION_ROOT, 'tests', 'expensive', '.serial-tests.json');
const SOAK_SECONDS_DEFAULT = 1800;
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');
const PIPELINE_SKILL = path.join(REPO_ROOT, '.claude', 'commands', 'pickle-pipeline.md');
const PICKLE_SETTINGS = path.join(REPO_ROOT, 'pickle_settings.json');
const EXTENSION_CLAUDE_MD = path.join(EXTENSION_ROOT, 'CLAUDE.md');

/** Reads a `→ <NAME> (default: <N>)` cap out of the /pickle-pipeline skill doc. */
function readSkillCap(source, name) {
  const match = new RegExp(`→ ${name} \\(default: (\\d+)\\)`).exec(source);
  assert.ok(match, `${name} must declare a default in .claude/commands/pickle-pipeline.md`);
  return Number(match[1]);
}

function readNumericConst(source, name) {
  const match = new RegExp(`const ${name} = ([^;]+);`).exec(source);
  assert.ok(match, `${name} must be present in the compiled runner`);
  return match[1];
}

function readDefaultTimeoutMs() {
  const source = readFileSync(RUNNER_JS, 'utf8');
  const soakSecondsExpr = readNumericConst(source, 'SOAK_SECONDS_DEFAULT');
  const serialEntryCountExpr = readNumericConst(source, 'SERIAL_MANIFEST_WORST_CASE_ENTRY_COUNT');
  const defaultTimeoutExpr = readNumericConst(source, 'DEFAULT_TEST_RUNNER_TIMEOUT_MS');
  // eslint-disable-next-line no-new-func
  return Function(
    `const SOAK_SECONDS_DEFAULT = (${soakSecondsExpr});
     const SERIAL_MANIFEST_WORST_CASE_ENTRY_COUNT = (${serialEntryCountExpr});
     return (${defaultTimeoutExpr});`,
  )();
}

test('DEFAULT_TEST_RUNNER_TIMEOUT_MS exceeds the serial-manifest worst-case sum', () => {
  const manifest = JSON.parse(readFileSync(SERIAL_MANIFEST, 'utf8'));
  const serialEntryCount = manifest.entries.length;
  const worstCaseSumMs = SOAK_SECONDS_DEFAULT * 1000 * serialEntryCount;

  const defaultTimeoutMs = readDefaultTimeoutMs();

  assert.ok(
    defaultTimeoutMs > worstCaseSumMs,
    `DEFAULT_TEST_RUNNER_TIMEOUT_MS (${defaultTimeoutMs}) must strictly exceed the serial-manifest worst-case sum (${worstCaseSumMs} = ${SOAK_SECONDS_DEFAULT}s * 1000 * ${serialEntryCount} entries)`,
  );
});

// ---------------------------------------------------------------------------
// AC-NS-7 (caps) — the raised iteration budgets. These values are the whole point of
// B-NONSTOP: SZ_MAX_ITER=50 was the default-reachable mechanism behind the "szechuan hit a
// timeout" field report — a large deslop exhausted 50 iterations, stopped short, and was
// reported as success. Nothing pinned them, so a revert to 50 would ship green.
// ---------------------------------------------------------------------------

test('AC-NS-7: the /pickle-pipeline skill declares anatomy + szechuan iteration caps >= 500', () => {
  const source = readFileSync(PIPELINE_SKILL, 'utf8');
  for (const name of ['AP_MAX_ITER', 'SZ_MAX_ITER']) {
    const cap = readSkillCap(source, name);
    assert.ok(cap >= 500, `${name} default (${cap}) must be >= 500 — a runaway-backstop-scale budget`);
  }
});

test('AC-NS-7: iteration_budget_per_backend meets the per-backend floors', () => {
  const budgets = JSON.parse(readFileSync(PICKLE_SETTINGS, 'utf8')).iteration_budget_per_backend;
  assert.ok(budgets, 'pickle_settings.json must declare iteration_budget_per_backend');
  assert.ok(budgets.claude >= 500, `claude budget (${budgets.claude}) must be >= 500`);
  // codex iteration semantics are coarser, so its floor is deliberately lower.
  assert.ok(budgets.codex >= 400, `codex budget (${budgets.codex}) must be >= 400`);
});

test('AC-NS-7: no cap is 0/unlimited — every budget stays a finite positive integer', () => {
  // The PRD explicitly DELETED the "or 0/unlimited" option: it removes the runaway backstop
  // R3 requires. Generous and finite, not infinite.
  const skill = readFileSync(PIPELINE_SKILL, 'utf8');
  const budgets = JSON.parse(readFileSync(PICKLE_SETTINGS, 'utf8')).iteration_budget_per_backend;
  const caps = {
    AP_MAX_ITER: readSkillCap(skill, 'AP_MAX_ITER'),
    SZ_MAX_ITER: readSkillCap(skill, 'SZ_MAX_ITER'),
    'iteration_budget_per_backend.claude': budgets.claude,
    'iteration_budget_per_backend.codex': budgets.codex,
  };
  for (const [name, value] of Object.entries(caps)) {
    assert.ok(Number.isInteger(value) && value > 0, `${name} (${value}) must be a finite positive integer`);
  }
});

// AC-NS-8 second clause. The numeric half is covered above; this pins the operator-facing
// half. The release gate is documented as unpassable without this override (the runner's
// default timeout equals SOAK_SECONDS, so the soak eats the whole budget), which makes the
// mention load-bearing rather than decorative.
test('AC-NS-8: extension/CLAUDE.md documents the PICKLE_TEST_RUNNER_TIMEOUT_MS override', () => {
  assert.match(readFileSync(EXTENSION_CLAUDE_MD, 'utf8'), /PICKLE_TEST_RUNNER_TIMEOUT_MS/);
});

test('DEFAULT_TEST_RUNNER_TIMEOUT_MS stays within MAX_TEST_RUNNER_TIMEOUT_MS', () => {
  const source = readFileSync(RUNNER_JS, 'utf8');
  const match = /const MAX_TEST_RUNNER_TIMEOUT_MS = ([^;]+);/.exec(source);
  assert.ok(match, 'MAX_TEST_RUNNER_TIMEOUT_MS must be present in the compiled runner');
  // eslint-disable-next-line no-new-func
  const maxTimeoutMs = Function(`return (${match[1]});`)();

  const defaultTimeoutMs = readDefaultTimeoutMs();
  assert.ok(defaultTimeoutMs <= maxTimeoutMs, 'default must not exceed the runner clamp ceiling');
});
