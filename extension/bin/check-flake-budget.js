import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
function parseIntegerFlag(name, value, min) {
    const parsed = Number.parseInt(value, 10);
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
// R-FBTN: node --test names each failure as `✖ <name> (…ms)` or TAP `not ok N - <name>`.
// Surface WHICH tests flaked, not just how many — a bare count is unactionable.
function extractFailingTestNames(stdout, stderr) {
    const names = [];
    for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
        const trimmed = line.trim();
        const crossed = /^✖\s+(.+?)(?:\s+\(\d[\d.]*ms\))?$/.exec(trimmed);
        if (crossed) {
            names.push(crossed[1].trim());
            continue;
        }
        const tap = /^not ok\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/.exec(trimmed);
        if (tap)
            names.push(tap[1].trim());
    }
    return names;
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
    const failingTests = new Set();
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
            if (!isBudgetableTestFailure(result.stdout ?? '', result.stderr ?? '')) {
                throw new Error(`Flake-budget child failed before reporting test results: ${summarizeHarnessFailure(result.stdout ?? '', result.stderr ?? '')}`);
            }
            failures += 1;
            for (const name of extractFailingTestNames(result.stdout ?? '', result.stderr ?? '')) {
                failingTests.add(name);
            }
            if (failures > parsed.failBudget) {
                return { failures, runsCompleted: runIndex + 1, failingTests: [...failingTests] };
            }
        }
    }
    return { failures, runsCompleted: parsed.runs, failingTests: [...failingTests] };
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
            stderr(`FAIL_BUDGET_EXCEEDED failures=${summary.failures} budget=${parsed.failBudget} runs_completed=${summary.runsCompleted} runs_requested=${parsed.runs}`);
            // R-FBTN: name the flaky tests so the failure is actionable, not a bare count.
            stderr(summary.failingTests.length > 0
                ? `FLAKY_TESTS ${summary.failingTests.map((n) => `\n  - ${n}`).join('')}`
                : 'FLAKY_TESTS (none captured — child emitted no ✖/not-ok test names)');
            return 1;
        }
        stdout(`flake-budget OK failures=${summary.failures} budget=${parsed.failBudget} runs_completed=${summary.runsCompleted} runs_requested=${parsed.runs}`);
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
