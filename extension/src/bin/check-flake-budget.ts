import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import path, { basename } from 'node:path';

const DEFAULT_RUNS = 5;
const DEFAULT_FAIL_BUDGET = 2;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
// The fast tier (~5000 tests at --test-concurrency=8) emits well over spawnSync's
// 1MB default maxBuffer on CI, which surfaces as a thrown `ENOBUFS` from the child
// spawn and misreports as a harness failure before any test result is parsed.
// 256MB gives the full fast-suite stream generous headroom on every supported host.
const SPAWN_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

const USAGE = 'Usage: check-flake-budget [--runs=N] [--fail-budget=N] [--timeout=MS]';

interface ParsedArgs {
  runs: number;
  failBudget: number;
  timeoutMs: number;
}

interface CheckFlakeBudgetMainOpts {
  argv: string[];
  cwd?: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  spawnSyncFn?: typeof spawnSync;
}

interface RunFailureDetail {
  name: string;
  durationMs: number | null;
}

interface RunRecord {
  runIndex: number;
  status: number | null;
  failing: RunFailureDetail[];
  logPath: string;
}

interface RunSummary {
  failures: number;
  runsCompleted: number;
  runRecords: RunRecord[];
  /** The child argv actually measured, verbatim — see `describeMeasuredTarget` below. */
  target: string;
}

interface RunInvocation {
  args: string[];
  targetPath: string;
}

// `Number.parseInt` stops at the first non-digit and returns the prefix, so an
// unguarded parse accepts `--runs=1e3` as 1 — a gate asked for a thousand runs
// silently performs one and reports OK. The shape check is what makes the
// function's own "must be an integer" contract true; the range check below stays
// the arm a signed or out-of-bounds value falls through to, so a negative value
// still reports the more useful range message.
const DECIMAL_INTEGER_RE = /^[+-]?\d+$/;

function parseIntegerFlag(name: string, value: string, min: number): number {
  const parsed = DECIMAL_INTEGER_RE.test(value) ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}, got: ${value}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    runs: DEFAULT_RUNS,
    failBudget: DEFAULT_FAIL_BUDGET,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      throw new Error(USAGE);
    }
    if (arg.startsWith('--runs=')) {
      parsed.runs = parseIntegerFlag('--runs', arg.slice('--runs='.length), 1);
      continue;
    }
    if (arg.startsWith('--fail-budget=')) {
      parsed.failBudget = parseIntegerFlag('--fail-budget', arg.slice('--fail-budget='.length), 0);
      continue;
    }
    if (arg.startsWith('--timeout=')) {
      parsed.timeoutMs = parseIntegerFlag('--timeout', arg.slice('--timeout='.length), 1);
      continue;
    }
    throw new Error(`Unknown flag: ${arg}\n${USAGE}`);
  }

  return parsed;
}

/**
 * The scope this run actually measured, carried into BOTH verdict lines.
 *
 * `PICKLE_FLAKE_BUDGET_TEST_FILE` replaces the whole fast tier with ONE file, and it is read
 * from the ambient environment — nothing scrubs it, and `npm run test:fast:budget` is the only
 * fast-tier execution in the release gate (extension/CLAUDE.md, .github/workflows/release.yml).
 * Without the target in the verdict, `flake-budget OK failures=0 budget=2 runs_completed=5
 * runs_requested=5` is byte-identical whether ~5000 tests ran or one file did, so an exported
 * shell variable turns the gate green over an unmeasured tier and leaves no trace saying so.
 * `PICKLE_GATE_DISABLED` already announces its own effect on the verdict; this does too.
 *
 * Now that a run is TWO child invocations, the verdict names both — a target line showing only
 * the parallel half would hide a serial half that never ran, which is the same fake-green this
 * field exists to prevent.
 */
function describeMeasuredTarget(invocations: RunInvocation[]): string {
  return invocations.map((invocation) => invocation.args.join(' ')).join(' + ');
}

/** Kept in lockstep with the `--manifest` argument of `test:fast:parallel`/`test:fast:serial`. */
const FAST_SERIAL_MANIFEST = 'tests/.serial-tests.json';

/**
 * The budget must measure what CI measures. `test:fast` is a parallel/serial split, so a budget
 * run that executed the tier as one undifferentiated c=8 pool would be measuring a configuration
 * nothing ships — and would keep reproducing the very contention the split removes.
 */
function buildRunInvocations(env: NodeJS.ProcessEnv): RunInvocation[] {
  const testFile = env.PICKLE_FLAKE_BUDGET_TEST_FILE?.trim();
  if (testFile) {
    return [{
      args: ['--test', '--test-concurrency=8', testFile],
      targetPath: testFile,
    }];
  }
  return [
    {
      args: ['bin/test-runner.js', '--tier', 'fast', '--manifest', FAST_SERIAL_MANIFEST, '--manifest-mode', 'exclude', '--test-concurrency=8'],
      targetPath: 'bin/test-runner.js',
    },
    {
      args: ['bin/test-runner.js', '--tier', 'fast', '--manifest', FAST_SERIAL_MANIFEST, '--manifest-mode', 'include', '--test-concurrency=1'],
      targetPath: 'bin/test-runner.js',
    },
  ];
}

function assertInvocationTargetExists(cwd: string, invocation: RunInvocation): void {
  const resolvedTarget = path.resolve(cwd, invocation.targetPath);
  if (!existsSync(resolvedTarget)) {
    throw new Error(`Flake-budget target not found: ${invocation.targetPath}`);
  }
}

function isBudgetableTestFailure(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`;
  return /(^✖\s)|(^not ok\s)|(^ℹ tests\s+\d+)/m.test(combined);
}

// R-FBTN/WS-D: node --test names each failure as `✖ <name> (…ms)` or TAP `not ok N - <name>`.
// Surface WHICH tests flaked and HOW LONG they took, not just how many — a bare count is
// unactionable and duration is the operator's discriminator between a timeout-adjacent
// flake and a genuine regression.
function extractFailingTestDetails(stdout: string, stderr: string): RunFailureDetail[] {
  const details: RunFailureDetail[] = [];
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const trimmed = line.trim();
    const crossed = /^✖\s+(.+?)(?:\s+\((\d[\d.]*)ms\))?$/.exec(trimmed);
    if (crossed) {
      details.push({ name: crossed[1].trim(), durationMs: crossed[2] ? Number.parseFloat(crossed[2]) : null });
      continue;
    }
    const tap = /^not ok\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/.exec(trimmed);
    if (tap) details.push({ name: tap[1].trim(), durationMs: null });
  }
  return details;
}

// A single failure can match both the spec-reporter `✖` line and a TAP `not ok` line for
// the same test name (reporter-dependent); collapse to one entry per name, preferring
// whichever match captured a duration.
function dedupeFailureDetails(details: RunFailureDetail[]): RunFailureDetail[] {
  const byName = new Map<string, RunFailureDetail>();
  for (const detail of details) {
    const existing = byName.get(detail.name);
    if (!existing || (existing.durationMs === null && detail.durationMs !== null)) {
      byName.set(detail.name, detail);
    }
  }
  return [...byName.values()];
}

function formatStatus(status: number | null): string {
  return status === null ? 'null' : String(status);
}

function formatFailureDetail(detail: RunFailureDetail): string {
  const duration = detail.durationMs === null ? 'unknown' : `${detail.durationMs}ms`;
  return `  - ${detail.name} duration=${duration}`;
}

function formatRunLogContents(runIndex: number, status: number | null, details: RunFailureDetail[], stdout: string, stderr: string): string {
  return [
    `RUN ${runIndex} status=${formatStatus(status)}`,
    ...details.map(formatFailureDetail),
    '',
    '--- stdout ---',
    stdout,
    '--- stderr ---',
    stderr,
  ].join('\n');
}

// R-FBTN/WS-D: a test failing in exactly one run is contention noise; a test failing
// across two or more runs is a deterministic regression. Per-run dedupe (a Set per run)
// before counting so a test that flakes twice WITHIN one run doesn't inflate its count.
function findRepeatedFailures(runRecords: RunRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const record of runRecords) {
    for (const name of new Set(record.failing.map((detail) => detail.name))) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([name]) => name)
    .sort();
}

// WS-D: attribute failures per run — same test failing repeatedly is a regression,
// distinct single-run failures are contention. Both read differently from a union count.
// ONE shape for both reports: the within-budget and over-budget paths differ only in their
// sink and in the FAIL_BUDGET_EXCEEDED header, so building the body once is what keeps them
// from drifting into two dialects of the same attribution.
function formatRunAttributionLines(runRecords: RunRecord[]): string[] {
  const lines: string[] = [];
  for (const record of runRecords) {
    lines.push(`RUN ${record.runIndex} FAILED: status=${formatStatus(record.status)}`);
    if (record.failing.length > 0) {
      lines.push(...record.failing.map(formatFailureDetail));
    } else {
      lines.push('  (no ✖/not-ok test names captured)');
    }
  }
  const repeated = findRepeatedFailures(runRecords);
  if (repeated.length > 0) {
    lines.push('REPEATED ACROSS RUNS:', ...repeated.map((name) => `  - ${name}`));
  }
  lines.push(...runRecords.map((record) => `RUN ${record.runIndex} LOG: ${record.logPath}`));
  return lines;
}

function printExceededReport(summary: RunSummary, parsed: ParsedArgs, stderr: (msg: string) => void): void {
  stderr(
    `FAIL_BUDGET_EXCEEDED failures=${summary.failures} budget=${parsed.failBudget} runs_completed=${summary.runsCompleted} runs_requested=${parsed.runs} target=${summary.target}`,
  );
  for (const line of formatRunAttributionLines(summary.runRecords)) {
    stderr(line);
  }
}

// A run that fails WITHIN budget still has to say which test failed, how long it took, and
// where its log is. The records already carry all three; only the reporting seam dropped
// them, so a passing run reported a bare count nobody could attribute (e7c9ada3:
// `flake-budget OK failures=1 budget=2` with no way to name the marginal test).
// Routed to stdout, not stderr: within budget is not a failure, and `FAIL_BUDGET_EXCEEDED`
// on stderr must stay an unambiguous signal.
function printWithinBudgetReport(summary: RunSummary, stdout: (msg: string) => void): void {
  for (const line of formatRunAttributionLines(summary.runRecords)) {
    stdout(line);
  }
}

interface RunHalf {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Executes every half of one run and returns one record per invocation.
 *
 * Every half runs, every time — no early exit once one fails. This mirrors the
 * `p=$?; ...; s=$?` shape of `test:fast` in package.json for the same reason: an `&&`-style
 * short-circuit blanks the second half's result exactly when the first half's failure makes it
 * most worth having.
 *
 * A spawn-level error (ENOENT, ETIMEDOUT) is a harness fault, not a test result, and stays fatal
 * exactly as before. It is deliberately NOT collected-and-continued: a half that hit the per-run
 * timeout has already burned the budget, and running the other would double an already-exhausted
 * wall clock to learn nothing.
 */
function runHalves(
  invocations: RunInvocation[],
  parsed: ParsedArgs,
  opts: Required<Pick<CheckFlakeBudgetMainOpts, 'cwd' | 'env' | 'execPath' | 'spawnSyncFn'>>,
): RunHalf[] {
  return invocations.map((invocation) => {
    const result = opts.spawnSyncFn(opts.execPath, invocation.args, {
      cwd: opts.cwd,
      env: opts.env,
      encoding: 'utf8',
      timeout: parsed.timeoutMs,
      maxBuffer: SPAWN_MAX_BUFFER_BYTES,
    });

    if (result.error) {
      throw result.error;
    }

    return {
      status: result.status ?? null,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  });
}

function runIterations(
  parsed: ParsedArgs,
  opts: Required<Pick<CheckFlakeBudgetMainOpts, 'cwd' | 'env' | 'execPath' | 'spawnSyncFn'>>,
): RunSummary {
  let failures = 0;
  const runRecords: RunRecord[] = [];
  let logDir: string | null = null;
  const childEnv = { ...opts.env };
  const invocations = buildRunInvocations(opts.env);
  const target = describeMeasuredTarget(invocations);
  delete childEnv.NODE_TEST_CONTEXT;
  for (const invocation of invocations) {
    assertInvocationTargetExists(opts.cwd, invocation);
  }

  for (let runIndex = 0; runIndex < parsed.runs; runIndex += 1) {
    const halves = runHalves(invocations, parsed, { ...opts, env: childEnv });

    const failedHalves = halves.filter((half) => (half.status ?? 1) !== 0);
    if (failedHalves.length > 0) {
      const stdout = halves.map((half) => half.stdout).join('');
      const stderr = halves.map((half) => half.stderr).join('');
      const runNumber = runIndex + 1;
      const status = failedHalves[0].status;
      // Classify per FAILING half, never over the concatenation: a passing half always emits
      // `ℹ tests N`, so a combined scan would read a crashed half as budgetable purely because
      // its sibling reported results.
      const budgetable = failedHalves.every((half) => isBudgetableTestFailure(half.stdout, half.stderr));
      const failing = budgetable ? dedupeFailureDetails(extractFailingTestDetails(stdout, stderr)) : [];

      // ONE reporting seam for both branches: every non-zero exit writes its full stdout/stderr
      // to disk before classification, so a harness crash (no ✖/not-ok/ℹ-tests markers) leaves
      // the same evidence trail as a budgetable test failure. Retain only names+durations in
      // memory across runs; the full stdout/stderr for a ~5000-test tier lives on disk.
      if (!logDir) {
        logDir = mkdtempSync(path.join(os.tmpdir(), 'flake-budget-logs-'));
      }
      const logPath = path.join(logDir, `run-${runNumber}.log`);
      writeFileSync(logPath, formatRunLogContents(runNumber, status, failing, stdout, stderr), 'utf8');

      if (!budgetable) {
        throw new Error(`Flake-budget child failed before reporting test results: full output written to ${logPath}`);
      }

      failures += 1;
      runRecords.push({ runIndex: runNumber, status, failing, logPath });
      if (failures > parsed.failBudget) {
        return { failures, runsCompleted: runNumber, runRecords, target };
      }
    }
  }

  return { failures, runsCompleted: parsed.runs, runRecords, target };
}

export async function checkFlakeBudgetMain(opts: CheckFlakeBudgetMainOpts): Promise<number> {
  const stdout = opts.stdout ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const stderr = opts.stderr ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  try {
    const parsed = parseArgs(opts.argv);
    const summary = runIterations(parsed, {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
      execPath: opts.execPath ?? process.execPath,
      spawnSyncFn: opts.spawnSyncFn ?? spawnSync,
    });

    if (summary.failures > parsed.failBudget) {
      printExceededReport(summary, parsed, stderr);
      return 1;
    }

    stdout(
      `flake-budget OK failures=${summary.failures} budget=${parsed.failBudget} runs_completed=${summary.runsCompleted} runs_requested=${parsed.runs} target=${summary.target}`,
    );
    // A fully clean run stays a one-liner; a run that failed within budget gets attribution.
    if (summary.runRecords.length > 0) {
      printWithinBudgetReport(summary, stdout);
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(msg);
    return 1;
  }
}

if (process.argv[1] && basename(process.argv[1]) === 'check-flake-budget.js') {
  checkFlakeBudgetMain({ argv: process.argv.slice(2) }).then((code) => process.exit(code)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  });
}
