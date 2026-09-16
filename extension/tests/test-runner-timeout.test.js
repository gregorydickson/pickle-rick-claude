// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
const TYPES_INDEX_TS = path.join(EXTENSION_ROOT, 'src', 'types', 'index.ts');

/**
 * Finds the pid of test-runner.js's direct spawnSync child (the `node --test <file>`
 * invocation) by scanning for a live process whose ppid matches the outer runner's pid.
 * Polled because the inner spawnSync call happens a moment after the outer process starts.
 */
function findInnerChildPid(outerPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = execFileSync('ps', ['-o', 'pid,ppid,command', '-ax'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    for (const line of out.split('\n').slice(1)) {
      const match = /^\s*(\d+)\s+(\d+)\s/.exec(line);
      if (match && Number(match[2]) === outerPid) return Number(match[1]);
    }
    sleepSync(50);
  }
  return null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    sleepSync(20);
  }
  return false;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    sleepSync(50);
  }
  return !isProcessAlive(pid);
}

/** The marker is created before its pid is written, so poll until it parses. */
function waitForMarkerPid(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = Number(readFileSync(filePath, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) return pid;
    sleepSync(20);
  }
  return null;
}

function spawnRunner(args) {
  // Scrub NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID: this file runs under `node --test`
  // itself, and those two vars leaking into the spawned `node --test <fixture>`
  // child change its exit-code/reporting behavior (it starts acting as a nested
  // test-runner worker instead of a standalone run).
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const child = spawn(process.execPath, [RUNNER_JS, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000,
    env,
  });
  const captured = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { captured.stdout += chunk; });
  child.stderr.on('data', (chunk) => { captured.stderr += chunk; });
  return { child, captured };
}

function waitForClose(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

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

// ---------------------------------------------------------------------------
// AC-T1 (B-TRUTHEXIT ROOT T1) — carry the child signal through exit reporting.
// A child killed by a signal must be attributed on stderr, distinctly from a
// genuine test-failure exit, while the exit code stays non-zero either way.
// ---------------------------------------------------------------------------

test('AC-T1-1/AC-T1-3: a SIGKILLed child is reported as signal-terminated and still exits non-zero', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-test-runner-signal-'));
  const marker = path.join(dir, 'marker');
  const fixture = path.join(dir, 'slow.test.js');
  let grandchildPid = null;
  try {
    writeFileSync(
      fixture,
      [
        "import { test } from 'node:test';",
        "import { writeFileSync } from 'node:fs';",
        `test('slow', async () => {`,
        // The marker carries the pid of the process running the test body: under node --test's
        // per-file process isolation that is a GRANDCHILD of the runner, not the pid we kill.
        `  writeFileSync(${JSON.stringify(marker)}, String(process.pid));`,
        `  await new Promise((resolve) => setTimeout(resolve, 30000));`,
        `});`,
      ].join('\n'),
    );

    const { child, captured } = spawnRunner([fixture]);
    const closed = waitForClose(child);

    assert.ok(waitForFile(marker, 10000), 'fixture test must start and write its marker');
    grandchildPid = waitForMarkerPid(marker, 5000);
    const innerPid = findInnerChildPid(child.pid, 10000);
    assert.ok(innerPid, "must resolve the runner's direct spawnSync child pid");
    process.kill(innerPid, 'SIGKILL');

    const code = await closed;

    assert.notEqual(code, 0, 'a signal-terminated child must exit non-zero');
    assert.match(
      captured.stderr,
      /\[test-runner\] child terminated by signal SIGKILL/,
      'stderr must name the terminating signal',
    );
    assert.ok(grandchildPid, 'marker must carry the test-body pid');
    assert.ok(
      waitForProcessExit(grandchildPid, 5000),
      `the runner must reap its test group when the child dies by signal; test-body pid ${grandchildPid} survived as an orphan`,
    );
  } finally {
    if (grandchildPid && isProcessAlive(grandchildPid)) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-T1-2/AC-T1-4: a genuinely failing child exits and outputs exactly as before — no signal attribution', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pickle-test-runner-fail-'));
  const fixture = path.join(dir, 'fail.test.js');
  try {
    writeFileSync(
      fixture,
      [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        `test('fails', () => { assert.fail('boom'); });`,
      ].join('\n'),
    );

    const { child, captured } = spawnRunner([fixture]);
    const code = await waitForClose(child);

    assert.equal(code, 1, 'a genuinely failing tier must exit exactly as before (status 1)');
    assert.doesNotMatch(
      captured.stderr,
      /\[test-runner\] child terminated by signal/,
      'a genuine test failure must carry no signal attribution',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-T1-5: EXIT_REASONS.length is unchanged by this fix (this ticket touches no halt path)', () => {
  const source = readFileSync(TYPES_INDEX_TS, 'utf8');
  const match = /export const EXIT_REASONS = \[([\s\S]*?)\] as const;/.exec(source);
  assert.ok(match, 'EXIT_REASONS array literal must be present in src/types/index.ts');
  const count = match[1].match(/'[^']+'/g)?.length ?? 0;
  assert.equal(count, 20, 'EXIT_REASONS member count must stay at its pre-fix value (20)');
});
