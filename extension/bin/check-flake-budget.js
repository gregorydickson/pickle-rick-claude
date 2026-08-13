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
// `Number.parseInt` stops at the first non-digit and returns the prefix, so an
// unguarded parse accepts `--runs=1e3` as 1 — a gate asked for a thousand runs
// silently performs one and reports OK. The shape check is what makes the
// function's own "must be an integer" contract true; the range check below stays
// the arm a signed or out-of-bounds value falls through to, so a negative value
// still reports the more useful range message.
const DECIMAL_INTEGER_RE = /^[+-]?\d+$/;
function parseIntegerFlag(name, value, min) {
    const parsed = DECIMAL_INTEGER_RE.test(value) ? Number.parseInt(value, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed < min) {
        throw new Error(`${name} must be an integer >= ${min}, got: ${value}`);
    }
    return parsed;
}
function parseArgs(argv) {
    const parsed = {
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
function buildRunInvocation(env) {
    const testFile = env.PICKLE_FLAKE_BUDGET_TEST_FILE?.trim();
    if (testFile) {
        return {
            args: ['--test', '--test-concurrency=8', testFile],
            targetPath: testFile,
        };
    }
    return {
        args: ['bin/test-runner.js', '--tier', 'fast', '--test-concurrency=8'],
        targetPath: 'bin/test-runner.js',
    };
}
function assertInvocationTargetExists(cwd, invocation) {
    const resolvedTarget = path.resolve(cwd, invocation.targetPath);
    if (!existsSync(resolvedTarget)) {
        throw new Error(`Flake-budget target not found: ${invocation.targetPath}`);
    }
}
function isBudgetableTestFailure(stdout, stderr) {
    const combined = `${stdout}\n${stderr}`;
    return /(^✖\s)|(^not ok\s)|(^ℹ tests\s+\d+)/m.test(combined);
}
// R-FBTN/WS-D: node --test names each failure as `✖ <name> (…ms)` or TAP `not ok N - <name>`.
// Surface WHICH tests flaked and HOW LONG they took, not just how many — a bare count is
// unactionable and duration is the operator's discriminator between a timeout-adjacent
// flake and a genuine regression.
function extractFailingTestDetails(stdout, stderr) {
    const details = [];
    for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
        const trimmed = line.trim();
        const crossed = /^✖\s+(.+?)(?:\s+\((\d[\d.]*)ms\))?$/.exec(trimmed);
        if (crossed) {
            details.push({ name: crossed[1].trim(), durationMs: crossed[2] ? Number.parseFloat(crossed[2]) : null });
            continue;
        }
        const tap = /^not ok\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/.exec(trimmed);
        if (tap)
            details.push({ name: tap[1].trim(), durationMs: null });
    }
    return details;
}
// A single failure can match both the spec-reporter `✖` line and a TAP `not ok` line for
// the same test name (reporter-dependent); collapse to one entry per name, preferring
// whichever match captured a duration.
function dedupeFailureDetails(details) {
    const byName = new Map();
    for (const detail of details) {
        const existing = byName.get(detail.name);
        if (!existing || (existing.durationMs === null && detail.durationMs !== null)) {
            byName.set(detail.name, detail);
        }
    }
    return [...byName.values()];
}
function formatStatus(status) {
    return status === null ? 'null' : String(status);
}
function formatFailureDetail(detail) {
    const duration = detail.durationMs === null ? 'unknown' : `${detail.durationMs}ms`;
    return `  - ${detail.name} duration=${duration}`;
}
function formatRunLogContents(runIndex, status, details, stdout, stderr) {
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
function findRepeatedFailures(runRecords) {
    const counts = new Map();
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
function printExceededReport(summary, parsed, stderr) {
    stderr(`FAIL_BUDGET_EXCEEDED failures=${summary.failures} budget=${parsed.failBudget} runs_completed=${summary.runsCompleted} runs_requested=${parsed.runs}`);
    // WS-D: attribute failures per run — same test failing repeatedly is a regression,
    // distinct single-run failures are contention. Both read differently from a union count.
    for (const record of summary.runRecords) {
        stderr(`RUN ${record.runIndex} FAILED: status=${formatStatus(record.status)}`);
        if (record.failing.length > 0) {
            for (const detail of record.failing) {
                stderr(formatFailureDetail(detail));
            }
        }
        else {
            stderr('  (no ✖/not-ok test names captured)');
        }
    }
    const repeated = findRepeatedFailures(summary.runRecords);
    if (repeated.length > 0) {
        stderr('REPEATED ACROSS RUNS:');
        for (const name of repeated) {
            stderr(`  - ${name}`);
        }
    }
    for (const record of summary.runRecords) {
        stderr(`RUN ${record.runIndex} LOG: ${record.logPath}`);
    }
}
// A run that fails WITHIN budget still has to say which test failed, how long it took, and
// where its log is. The records already carry all three; only the reporting seam dropped
// them, so a passing run reported a bare count nobody could attribute (e7c9ada3:
// `flake-budget OK failures=1 budget=2` with no way to name the marginal test).
// Routed to stdout, not stderr: within budget is not a failure, and `FAIL_BUDGET_EXCEEDED`
// on stderr must stay an unambiguous signal.
function printWithinBudgetReport(summary, stdout) {
    for (const record of summary.runRecords) {
        stdout(`RUN ${record.runIndex} FAILED: status=${formatStatus(record.status)}`);
        if (record.failing.length > 0) {
            for (const detail of record.failing) {
                stdout(formatFailureDetail(detail));
            }
        }
        else {
            stdout('  (no ✖/not-ok test names captured)');
        }
    }
    const repeated = findRepeatedFailures(summary.runRecords);
    if (repeated.length > 0) {
        stdout('REPEATED ACROSS RUNS:');
        for (const name of repeated) {
            stdout(`  - ${name}`);
        }
    }
    for (const record of summary.runRecords) {
        stdout(`RUN ${record.runIndex} LOG: ${record.logPath}`);
    }
}
function summarizeHarnessFailure(stdout, stderr) {
    const firstLine = `${stderr}\n${stdout}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
    return firstLine ?? 'child test runner exited without test output';
}
function runIterations(parsed, opts) {
    let failures = 0;
    const runRecords = [];
    let logDir = null;
    const childEnv = { ...opts.env };
    const invocation = buildRunInvocation(opts.env);
    delete childEnv.NODE_TEST_CONTEXT;
    assertInvocationTargetExists(opts.cwd, invocation);
    for (let runIndex = 0; runIndex < parsed.runs; runIndex += 1) {
        const result = opts.spawnSyncFn(opts.execPath, invocation.args, {
            cwd: opts.cwd,
            env: childEnv,
            encoding: 'utf8',
            timeout: parsed.timeoutMs,
            maxBuffer: SPAWN_MAX_BUFFER_BYTES,
        });
        if (result.error) {
            throw result.error;
        }
        if ((result.status ?? 1) !== 0) {
            const stdout = result.stdout ?? '';
            const stderr = result.stderr ?? '';
            if (!isBudgetableTestFailure(stdout, stderr)) {
                throw new Error(`Flake-budget child failed before reporting test results: ${summarizeHarnessFailure(stdout, stderr)}`);
            }
            failures += 1;
            const runNumber = runIndex + 1;
            const status = result.status ?? null;
            const failing = dedupeFailureDetails(extractFailingTestDetails(stdout, stderr));
            // Retain only names+durations in memory across runs; the full stdout/stderr for a
            // ~5000-test tier is written straight to disk and never held past this iteration.
            if (!logDir) {
                logDir = mkdtempSync(path.join(os.tmpdir(), 'flake-budget-logs-'));
            }
            const logPath = path.join(logDir, `run-${runNumber}.log`);
            writeFileSync(logPath, formatRunLogContents(runNumber, status, failing, stdout, stderr), 'utf8');
            runRecords.push({ runIndex: runNumber, status, failing, logPath });
            if (failures > parsed.failBudget) {
                return { failures, runsCompleted: runNumber, runRecords };
            }
        }
    }
    return { failures, runsCompleted: parsed.runs, runRecords };
}
export async function checkFlakeBudgetMain(opts) {
    const stdout = opts.stdout ?? ((msg) => process.stdout.write(`${msg}\n`));
    const stderr = opts.stderr ?? ((msg) => process.stderr.write(`${msg}\n`));
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
        stdout(`flake-budget OK failures=${summary.failures} budget=${parsed.failBudget} runs_completed=${summary.runsCompleted} runs_requested=${parsed.runs}`);
        // A fully clean run stays a one-liner; a run that failed within budget gets attribution.
        if (summary.runRecords.length > 0) {
            printWithinBudgetReport(summary, stdout);
        }
        return 0;
    }
    catch (err) {
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
