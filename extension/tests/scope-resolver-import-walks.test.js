// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// 750ms → 2500ms → 5000ms → 15_000ms → 40_000ms: under heavy 8-way full-suite
// concurrency on a loaded host, the SUT's findImportersTimeoutMs needs enough
// wall-clock to (a) fire SIGKILL on a hanging shim and execute the grep
// fallback, AND (b) NOT accidentally fire on a fast-exiting shim whose spawn
// was delayed by scheduler pressure (this manifested as `_runRgImportWalk`
// writing "rg timeout" instead of "rg fail", OR a slow-cold-started SUCCESS
// grep being SIGKILL'd before it could emit `./b.ts`, dropping b.ts from the
// result). The HANG_SCRIPT sleeps 60s so any value < 60_000 still validates
// the timeout-bound contract — bumping just absorbs scheduler jitter on both
// ends, and 40s leaves a clear 20s margin below the 60s hang sleep.
const HANG_TIMEOUT_MS = 40_000;
// Outer subprocess wall-clock cap. Must cover the worst case: both rg and grep
// time out at HANG_TIMEOUT_MS plus Node ESM cold-start and spawnSync overhead.
// HANG_TIMEOUT_MS*2 + 40s slack keeps the outer cap from SIGKILL'ing the child
// before the SUT's own per-tool timeouts have both fired and recovered.
const RUNNER_SPAWN_TIMEOUT_MS = HANG_TIMEOUT_MS * 2 + 40_000;

const FAIL_SCRIPT = (code) => `#!/bin/sh
exit ${code}
`;

const SUCCESS_SCRIPT = `#!/bin/sh
printf './b.ts\\n'
exit 0
`;

const HANG_SCRIPT = `#!/bin/sh
/bin/sleep 60
`;

// rg's "ran fine, found zero matches" exit code. Distinct from a tool failure
// (exit 2). The SUT MUST treat this as the authoritative empty answer and NOT
// fall through to the gitignore-blind grep fallback.
const RG_EMPTY_SUCCESS_SCRIPT = `#!/bin/sh
exit 1
`;

function makeRepo() {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-import-walk-')));
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export function foo() {}\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), "import { foo } from './a';\n");
    return repo;
}

function withToolShims(scripts, fn) {
    const shimDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-import-tools-')));
    try {
        for (const [tool, script] of Object.entries(scripts)) {
            const shimPath = path.join(shimDir, tool);
            fs.writeFileSync(shimPath, script);
            fs.chmodSync(shimPath, 0o755);
        }
        return fn(shimDir);
    } finally {
        fs.rmSync(shimDir, { recursive: true, force: true });
    }
}

function runComputeOneHop(repo, scripts) {
    return withToolShims(scripts, (shimDir) => {
        const script = `
import { computeOneHop } from './services/scope-resolver.js';
const warnings = [];
console.warn = (message) => warnings.push(String(message));
const result = computeOneHop(['a.ts'], ${JSON.stringify(repo)}, { findImportersTimeoutMs: ${HANG_TIMEOUT_MS} });
process.stdout.write(JSON.stringify({ result, warnings }));
`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: path.resolve(import.meta.dirname, '..'),
            encoding: 'utf-8',
            env: {
                ...process.env,
                PATH: shimDir,
            },
            timeout: RUNNER_SPAWN_TIMEOUT_MS,
        });

        assert.equal(result.status, 0, result.stderr || result.stdout);
        return JSON.parse(result.stdout);
    });
}

function runTimedComputeOneHop(repo, scripts) {
    const start = Date.now();
    const output = runComputeOneHop(repo, scripts);
    return {
        ...output,
        elapsed: Date.now() - start,
    };
}

function hasWarning(warnings, tool, category) {
    const pattern = new RegExp(`\\b${tool}\\b[^\\n]*\\b${category}\\b`);
    return warnings.some((line) => pattern.test(line));
}

// Either-category form for fail-class tests under heavy load: a fast-exit-2
// shim CAN race against the parent timeout and be SIGKILL'd before the child
// returns status=2, causing the SUT to log "<tool> timeout" instead of
// "<tool> fail". Both are valid "non-success" categories — the recovery
// contract only requires that the SUT noticed the tool didn't produce
// importers and emitted a distinguishable warning.
function hasFailureWarning(warnings, tool) {
    return hasWarning(warnings, tool, 'fail') || hasWarning(warnings, tool, 'timeout');
}

function warningCategoryCount(warnings, category) {
    const pattern = new RegExp(`\\b${category}\\b`);
    return warnings.filter((line) => pattern.test(line)).length;
}

function assertFinishedWithin(elapsed, label) {
    // Ceiling = HANG_TIMEOUT_MS + scheduler-jitter slack (10s under full-suite
    // concurrency). The contract this test enforces is that elapsed << 60s
    // (the HANG_SCRIPT sleep) — any value well under the 60s sleep proves the
    // timeout fired and the fallback ran.
    assert.ok(elapsed < HANG_TIMEOUT_MS + 10_000, `${label} took ${elapsed}ms`);
}

function runInRepo(scripts) {
    const repo = makeRepo();
    try {
        return runTimedComputeOneHop(repo, scripts);
    } finally {
        cleanup(repo);
    }
}

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

// Resolves a REAL binary's absolute path without depending on any inherited
// PATH or shell alias (spawnSync bypasses shell functions/aliases already,
// but `which`/`command -v` still need a shell and a PATH to search — this
// avoids both by checking known install locations directly).
function resolveRealBinary(name) {
    const candidates = [`/usr/bin/${name}`, `/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) { return candidate; }
    }
    throw new Error(`scope-resolver-import-walks test: cannot resolve real ${name} binary for ENOENT fixture`);
}

// Builds a PATH-only directory containing symlinks to REAL binaries for only
// the named tools, then invokes fn(shimDir). Any tool NOT named is genuinely
// absent (ENOENT) when this directory is used as an exclusive PATH override
// (`env: { ...process.env, PATH: shimDir }` — full override, not a prepend),
// regardless of what is actually installed on the host. This is required
// because `rg` is genuinely present on some dev hosts, so a prepend-style
// PATH (used by the .mjs/.cjs parity test above) cannot guarantee ENOENT.
function withRealBinariesOnPath(names, fn) {
    const shimDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-real-bin-')));
    try {
        for (const name of names) {
            fs.symlinkSync(resolveRealBinary(name), path.join(shimDir, name));
        }
        return fn(shimDir);
    } finally {
        fs.rmSync(shimDir, { recursive: true, force: true });
    }
}

// A real (not shimmed) git repo fixture, staged (not committed — `git grep`
// reads tracked/staged content) with a seed export file and one importer.
function makeGitRepo() {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-import-walk-git-')));
    const git = resolveRealBinary('git');
    const run = (args) => {
        const result = spawnSync(git, args, { cwd: repo, encoding: 'utf-8', timeout: 15_000 });
        assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    };
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export function foo() {}\n');
    fs.writeFileSync(path.join(repo, 'b.ts'), "import { foo } from './a';\n");
    run(['init', '-q']);
    run(['add', '-A']);
    return repo;
}

// `prepend: true` puts shimDir AHEAD of the real PATH, so shimmed tools win while
// unshimmed ones still resolve to the host binary. The default is an EXCLUSIVE
// override (shimDir alone), which is what guarantees ENOENT for anything absent
// from shimDir regardless of what the host has installed.
function runComputeOneHopWithPathOverride(repo, shimDir, { prepend = false } = {}) {
    const script = `
import { computeOneHop } from './services/scope-resolver.js';
const warnings = [];
console.warn = (message) => warnings.push(String(message));
const result = computeOneHop(['a.ts'], ${JSON.stringify(repo)}, { findImportersTimeoutMs: ${HANG_TIMEOUT_MS} });
process.stdout.write(JSON.stringify({ result, warnings }));
`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: path.resolve(import.meta.dirname, '..'),
        encoding: 'utf-8',
        env: { ...process.env, PATH: prepend ? `${shimDir}${path.delimiter}${process.env.PATH}` : shimDir },
        timeout: RUNNER_SPAWN_TIMEOUT_MS,
    });
    assert.equal(out.status, 0, out.stderr || out.stdout);
    return JSON.parse(out.stdout);
}

test('computeOneHop import walks', async (t) => {
    await t.test('rg fails and grep recovers', () => {
        const output = runInRepo({ rg: FAIL_SCRIPT(2), grep: SUCCESS_SCRIPT });
        assert.deepStrictEqual(output.result, ['a.ts', 'b.ts']);
        assert.equal(hasFailureWarning(output.warnings, 'rg'), true);
        assert.equal(hasFailureWarning(output.warnings, 'grep'), false);
    });

    await t.test('grep failure is logged distinctly', () => {
        const output = runInRepo({ rg: FAIL_SCRIPT(2), grep: FAIL_SCRIPT(3) });
        assert.deepStrictEqual(output.result, ['a.ts']);
        assert.equal(hasFailureWarning(output.warnings, 'rg'), true);
        assert.equal(hasFailureWarning(output.warnings, 'grep'), true);
    });

    await t.test('both tools fail and importer expansion is empty', () => {
        const output = runInRepo({ rg: FAIL_SCRIPT(4), grep: FAIL_SCRIPT(5) });
        assert.deepStrictEqual(output.result, ['a.ts']);
        // Either both shims exited with non-zero status (`fail`) or were
        // SIGKILL'd by the parent timeout (`timeout`) under heavy load — both
        // are valid non-success categories, and the warning count contract
        // (one per tool) holds for either.
        const failureCount =
            warningCategoryCount(output.warnings, 'fail') +
            warningCategoryCount(output.warnings, 'timeout');
        assert.equal(failureCount, 2);
    });

    await t.test('rg success with zero matches does NOT fall through to grep', () => {
        // rg ran fine (exit 1 = no matches) — that is the authoritative empty
        // answer. grep would print ./b.ts if (wrongly) consulted, so its
        // absence from the result proves the fallback was not taken. This
        // guards the rg-empty-vs-rg-failure conflation: rg honors .gitignore,
        // grep -rl does not, so a spurious grep fallback both double-spawns and
        // can pull ignored importers into the one-hop set.
        const output = runInRepo({ rg: RG_EMPTY_SUCCESS_SCRIPT, grep: SUCCESS_SCRIPT });
        assert.deepStrictEqual(output.result, ['a.ts']);
        assert.equal(hasFailureWarning(output.warnings, 'rg'), false);
        assert.equal(hasFailureWarning(output.warnings, 'grep'), false);
    });

    await t.test('rg hang is bounded by findImportersTimeoutMs', () => {
        const output = runInRepo({ rg: HANG_SCRIPT, grep: SUCCESS_SCRIPT });
        assert.deepStrictEqual(output.result, ['a.ts', 'b.ts']);
        assertFinishedWithin(output.elapsed, 'rg hang');
        assert.equal(hasWarning(output.warnings, 'rg', 'timeout'), true);
    });

    await t.test('grep hang is bounded by findImportersTimeoutMs', () => {
        const output = runInRepo({ rg: FAIL_SCRIPT(2), grep: HANG_SCRIPT });
        assert.deepStrictEqual(output.result, ['a.ts']);
        assertFinishedWithin(output.elapsed, 'grep hang');
        assert.equal(hasWarning(output.warnings, 'rg', 'fail'), true);
        assert.equal(hasWarning(output.warnings, 'grep', 'timeout'), true);
    });

    await t.test('grep fallback honors .mjs/.cjs extensions (rg/grep parity)', () => {
        // Real grep, shimmed-failing rg → exercises the fallback path against the
        // actual `--include` flags. A .mjs importer of the changed export MUST be
        // in the one-hop set, matching the rg glob's mjs/cjs coverage. Without
        // the --include=*.mjs/*.cjs flags this returns ['a.ts'] only.
        const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-import-mjs-')));
        try {
            fs.writeFileSync(path.join(repo, 'a.ts'), 'export function foo() {}\n');
            fs.writeFileSync(path.join(repo, 'consumer.mjs'), "import { foo } from './a.js';\n");
            const shimDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-rg-fail-')));
            try {
                const rgShim = path.join(shimDir, 'rg');
                fs.writeFileSync(rgShim, FAIL_SCRIPT(2));
                fs.chmodSync(rgShim, 0o755);
                // Prepend shimDir so rg resolves to the failing shim while grep
                // resolves to the real system binary (the SUT under test).
                const script = `
import { computeOneHop } from './services/scope-resolver.js';
const result = computeOneHop(['a.ts'], ${JSON.stringify(repo)}, { findImportersTimeoutMs: ${HANG_TIMEOUT_MS} });
process.stdout.write(JSON.stringify({ result }));
`;
                const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
                    cwd: path.resolve(import.meta.dirname, '..'),
                    encoding: 'utf-8',
                    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
                    timeout: RUNNER_SPAWN_TIMEOUT_MS,
                });
                assert.equal(out.status, 0, out.stderr || out.stdout);
                const { result } = JSON.parse(out.stdout);
                assert.ok(
                    result.includes('consumer.mjs'),
                    `expected consumer.mjs in one-hop set, got ${JSON.stringify(result)}`,
                );
            } finally {
                fs.rmSync(shimDir, { recursive: true, force: true });
            }
        } finally {
            cleanup(repo);
        }
    });

    await t.test('rg ENOENT (true missing binary) degrades to git grep, not just grep -rl', () => {
        // Real git repo + real git/grep binaries via symlink, PATH fully
        // overridden so `rg` is genuinely absent — no shim script, no
        // inherited real PATH. Proves the ENOENT branch reaches git grep
        // (which honors .gitignore) rather than jumping straight to the
        // gitignore-blind grep -rl last resort.
        const repo = makeGitRepo();
        try {
            const output = withRealBinariesOnPath(['git', 'grep'], (shimDir) =>
                runComputeOneHopWithPathOverride(repo, shimDir));
            assert.deepStrictEqual(output.result, ['a.ts', 'b.ts']);
            assert.equal(hasWarning(output.warnings, 'rg', 'missing'), true);
            // grep -rl (the last resort) must NOT have been invoked — git
            // grep already satisfied the walk, so no "grep fail"/"grep
            // timeout" warning should appear.
            assert.equal(hasFailureWarning(output.warnings, 'grep'), false);
        } finally {
            cleanup(repo);
        }
    });

    await t.test('rg, git, and grep all ENOENT returns the empty-but-successful shape without throwing', () => {
        // No binaries at all on the exclusive PATH — every tier is genuinely
        // absent. AC-6: this must never throw, never propagate a non-zero
        // exit, and must return the SAME shape as an authoritative
        // no-importers-found result (['a.ts'] — the seed file only), not
        // null or a crash.
        const repo = makeRepo();
        try {
            const output = withRealBinariesOnPath([], (shimDir) =>
                runComputeOneHopWithPathOverride(repo, shimDir));
            assert.deepStrictEqual(output.result, ['a.ts']);
            assert.equal(hasWarning(output.warnings, 'rg', 'missing'), true);
        } finally {
            cleanup(repo);
        }
    });
});


// --- the ONE completion predicate the three degrade tiers share ---------------
// rg / git grep / grep all decide "this match list is an answer" identically, and
// the copies drifted: the last-resort `grep` arm tested `status` alone while its two
// siblings already ORed in `.error`. Homing the decision once removes the drift by
// construction; these cases pin the decision itself, including the row that was
// missing from the arm that regressed.
//
// Note this family deliberately CANNOT use `types/index.ts:enumerationCompleted` —
// that predicate demands `status === 0`, and a match tool exits **1** for "ran fine,
// found zero matches", which is an authoritative empty answer that must NOT degrade
// to the next tier.
test('_matchListCompleted: exit 0 (matches) and exit 1 (no matches) are BOTH authoritative answers', async () => {
    const { _matchListCompleted } = await import('../services/scope-resolver.js');
    assert.equal(_matchListCompleted({ status: 0 }), true);
    assert.equal(_matchListCompleted({ status: 1 }), true, 'exit 1 is "ran fine, zero matches", not a failure');
});

test('_matchListCompleted: a tool failure or a kill is not an answer', async () => {
    const { _matchListCompleted } = await import('../services/scope-resolver.js');
    assert.equal(_matchListCompleted({ status: 2 }), false, 'rg exit 2 is a real tool error');
    assert.equal(_matchListCompleted({ status: null }), false, 'SIGTERM/SIGKILL leaves status null');
});

test('_matchListCompleted: a maxBuffer overflow that still EXITS 0 or 1 is not an answer either', async () => {
    // The shape a status-only guard cannot see: the child exits before Node's
    // overflow kill lands, so `spawnSync` returns a normal-looking status with
    // `error.code === 'ENOBUFS'` and a TRUNCATED match list. Read as complete, that
    // list silently drops importers from the one-hop set and under-includes the
    // scope fence — the exact harm UNBOUNDED_READ_MAX_BUFFER is declared to prevent.
    const { _matchListCompleted } = await import('../services/scope-resolver.js');
    const enobufs = Object.assign(new Error('spawnSync grep ENOBUFS'), { code: 'ENOBUFS' });
    assert.equal(_matchListCompleted({ status: 0, error: enobufs }), false);
    assert.equal(_matchListCompleted({ status: 1, error: enobufs }), false);
});

// ---------------------------------------------------------------------------
// A2 / e8e71b7a — the rg arm must compute the SAME importer set the other two
// tiers compute.
//
// beta.22's CI failed `computeOneHop: basic one-hop` 3/3 while the same test
// passed on macOS and in a `node:22` container. The variable was the ripgrep
// VERSION, nothing in this repo: `ubuntu-latest` installs rg 14.1.0, whose
// Unicode matcher returns ZERO matches for the alternation `findImporters`
// builds even though each branch matches alone. rg 13.0.0 (Debian bookworm,
// which `scripts/ci-repro.sh` provisions) and rg 15.2.0 (current homebrew) are
// both outside that window, so every local environment was blind to it.
//
// Two pins, because either alone leaves a hole:
//   A — the invocation carries `--no-unicode`. Holds on every host, including
//       the ones where the engine defect is absent, and observes the argv the
//       SUT actually passes rather than the text of the source.
//   B — the host's real rg, driven through the SUT, still finds the importer.
//       This is the pin that would have caught beta.22. It can only fire on an
//       affected host; on rg 13/15 it passes before and after the fix, which is
//       the honest reading — the engine defect genuinely is not there.
// ---------------------------------------------------------------------------

// Records argv rather than answering, so the assertion is about the invocation
// the SUT makes. Exits 1 = "ran fine, zero matches", the authoritative-empty
// code, so the SUT accepts the answer and does NOT degrade to git grep/grep —
// that keeps this pin measuring the rg arm and nothing else.
const RG_ARGV_RECORDING_SCRIPT = (argvPath) => `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argvPath)}
exit 1
`;

test('A2: the rg import walk passes --no-unicode (rg 14.x returns zero matches for the alternation without it)', () => {
    const repo = makeRepo();
    const shimDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-rg-argv-')));
    try {
        const argvPath = path.join(shimDir, 'rg-argv.txt');
        const rgShim = path.join(shimDir, 'rg');
        fs.writeFileSync(rgShim, RG_ARGV_RECORDING_SCRIPT(argvPath));
        fs.chmodSync(rgShim, 0o755);

        // Prepend so `rg` resolves to the recorder while git/grep stay real.
        runComputeOneHopWithPathOverride(repo, shimDir, { prepend: true });

        assert.ok(fs.existsSync(argvPath), 'rg shim was never invoked — the walk did not reach the rg arm');
        const argv = fs.readFileSync(argvPath, 'utf-8').split('\n').filter((s) => s.length > 0);
        assert.ok(
            argv.includes('--no-unicode'),
            `expected --no-unicode in the rg invocation, got ${JSON.stringify(argv)}`,
        );
    } finally {
        fs.rmSync(shimDir, { recursive: true, force: true });
        cleanup(repo);
    }
});

test('A2: the host rg finds the importer — the union of the pattern branches is not empty', (t) => {
    let realRg;
    try {
        realRg = resolveRealBinary('rg');
    } catch {
        // Named out loud rather than silently self-skipping: rg is a
        // non-guaranteed tool, and a suite that quietly skips has verified
        // nothing. CI installs ripgrep, so this does not skip there.
        t.skip('ripgrep is not installed on this host — the rg arm cannot be exercised');
        return;
    }

    const repo = makeRepo();
    try {
        // Exclusive PATH override: rg only. git and grep are ABSENT, so the
        // degrade chain cannot answer for the rg arm and mask a wrong result.
        const output = withRealBinariesOnPath(['rg'], (shimDir) =>
            runComputeOneHopWithPathOverride(repo, shimDir));

        assert.deepStrictEqual(
            output.result,
            ['a.ts', 'b.ts'],
            `the rg arm dropped the importer (rg at ${realRg}). This is the beta.22 ` +
            'CI failure: ripgrep 14.x returns zero matches for an alternation whose ' +
            'branches each match. Expected --no-unicode to avoid it.',
        );
    } finally {
        cleanup(repo);
    }
});
