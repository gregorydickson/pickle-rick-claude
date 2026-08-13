// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_TIMEOUT_SECONDS, HANG_GUARD_GRACE_MS } from '../bin/spawn-morty.js';
import {
    resolveSubprocessCap,
    resolveSubprocessCapFromBudgetAndMeasurement,
    resolveAssertionCap,
    MULTIPLIER,
    STARTUP_ALLOWANCE_MS,
    MAX_SUBPROCESS_CAP_MS,
    FBC15455_MEASURED_MAX_MS,
    SPAWN_MORTY_WORST_MEASURED_MS,
    WORKER_GATE_WORST_MEASURED_MS,
    CAP_SPAWN_MORTY_DEFAULT_BUDGET,
    CAP_SPAWN_MORTY_CLAMPED_BUDGET,
    CAP_SPAWN_MORTY_INDETERMINATE,
    CAP_MEASURED_ORPHAN_TMP_BACKEND,
    CAP_MEASURED_ORPHAN_TMP_SESSION_TIMEOUT,
    CAP_MEASURED_HERMES_COMPLETES,
    CAP_WORKER_GATE,
} from './__helpers__/subprocess-cap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const HELPER_PATH = path.join(__dirname, '__helpers__', 'subprocess-cap.js');
const MEASUREMENTS_PATH = path.join(REPO_ROOT, 'prds/research/fbc15455/measurements.md');
const SPAWN_MORTY_TS = path.join(REPO_ROOT, 'extension/src/bin/spawn-morty.ts');

const CONVERTED_FILES = [
    'spawn-morty.test.js',
    'spawn-morty-worker-gate.test.js',
    'flake-budget.test.js',
];

/** The single cap in the converted set that is deliberately an assertion, not a budget. */
const MARKED_ASSERTION_CAP = 'resolveAssertionCap(5000)';

// ---------------------------------------------------------------------------
// Source scanning — scoped to subprocess argument objects, so a node:test
// per-test `{ timeout: N }` option is never mistaken for a subprocess cap.
// ---------------------------------------------------------------------------

/**
 * Returns the balanced argument text of every `spawnSync(`/`execFileSync(` call in `src`,
 * skipping string and template literals and comments so their contents cannot unbalance
 * the scan.
 * @param {string} src
 * @returns {string[]}
 */
function extractSubprocessCallArgs(src) {
    /** @type {string[]} */
    const found = [];
    const callRe = /\b(?:spawnSync|execFileSync)\s*\(/g;
    let match;
    while ((match = callRe.exec(src)) !== null) {
        const open = match.index + match[0].length - 1;
        let depth = 0;
        let i = open;
        for (; i < src.length; i += 1) {
            const ch = src[i];
            const next = src[i + 1];
            if (ch === '/' && next === '/') {
                i = src.indexOf('\n', i);
                if (i === -1) break;
                continue;
            }
            if (ch === '/' && next === '*') {
                const end = src.indexOf('*/', i + 2);
                if (end === -1) break;
                i = end + 1;
                continue;
            }
            if (ch === "'" || ch === '"' || ch === '`') {
                i += 1;
                while (i < src.length && src[i] !== ch) {
                    if (src[i] === '\\') i += 1;
                    i += 1;
                }
                continue;
            }
            if (ch === '(') depth += 1;
            else if (ch === ')') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        if (depth === 0 && i > open) found.push(src.slice(open + 1, i));
    }
    return found;
}

/**
 * The command expression of a subprocess call — the text up to the first comma that is
 * not nested inside brackets, braces, parens, or a string. Skips comments and string
 * bodies for the same reason the caller does: their contents must not steer the scan.
 * @param {string} args
 * @returns {string}
 */
function firstArgumentOf(args) {
    let depth = 0;
    for (let i = 0; i < args.length; i += 1) {
        const ch = args[i];
        const next = args[i + 1];
        if (ch === '/' && next === '/') {
            const nl = args.indexOf('\n', i);
            if (nl === -1) break;
            i = nl;
            continue;
        }
        if (ch === '/' && next === '*') {
            const end = args.indexOf('*/', i + 2);
            if (end === -1) break;
            i = end + 1;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            const quote = ch;
            i += 1;
            while (i < args.length && args[i] !== quote) {
                if (args[i] === '\\') i += 1;
                i += 1;
            }
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') depth += 1;
        else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
        else if (ch === ',' && depth === 0) return args.slice(0, i).trim();
    }
    return args.trim();
}

/**
 * Every subprocess call in `src` as `{ command, timeoutValues }`. `timeoutValues` is EMPTY
 * when the call passes no `timeout:` key at all — the case a values-only scan cannot
 * represent, and therefore the case a cap guard built on one cannot police.
 * @param {string} src
 * @returns {{command: string, timeoutValues: string[]}[]}
 */
function extractSubprocessCalls(src) {
    return extractSubprocessCallArgs(src).map(args => {
        const values = [];
        const re = /\btimeout\s*:\s*([^,\n}]+)/g;
        let m;
        while ((m = re.exec(args)) !== null) values.push(m[1].trim());
        return { command: firstArgumentOf(args), timeoutValues: values };
    });
}

/** A command expression written as a single-quoted or double-quoted string literal. */
function literalCommand(command) {
    const m = /^'([^']+)'$|^"([^"]+)"$/.exec(command);
    return m ? (m[1] ?? m[2]) : null;
}

/**
 * Spawns of the subject under test: every one runs a node runtime, which is what makes it
 * a spawn of THIS repo's code rather than of a tool. Matching the runtime rather than
 * `process.execPath` alone closes the disguise — rewriting a subject spawn as
 * `spawnSync('node', [BIN, …])` must not reclassify it into the unchecked fixture lane.
 */
function isSubjectSpawn(call) {
    const literal = literalCommand(call.command);
    if (literal !== null) return /^node(\.exe)?$/.test(literal);
    return /(^|\.)execPath$/.test(call.command);
}

/** Fixture/setup spawns: `git`, `bash`, and friends — a tool, named by a string literal. */
function isFixtureSpawn(call) {
    const literal = literalCommand(call.command);
    return literal !== null && !/^node(\.exe)?$/.test(literal);
}

/** Every `timeout:` value expression appearing inside a subprocess argument object. */
function extractSubprocessTimeoutValues(src) {
    return extractSubprocessCalls(src).flatMap(call => call.timeoutValues);
}

function readConverted(file) {
    return fs.readFileSync(path.join(__dirname, file), 'utf-8');
}

/** Names imported from the cap helper by a converted file. */
function importedCapNames(src) {
    // `[^}]*` cannot cross a closing brace, so this binds to the cap-helper import itself
    // rather than lazily spanning from an earlier import statement.
    const m = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/__helpers__\/subprocess-cap\.js'/);
    assert.ok(m, 'converted file must import from ./__helpers__/subprocess-cap.js');
    return new Set(m[1].split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * Names a converted file binds to a resolver call of its own. A file whose cap has no
 * shared constant (its subject is not spawn-morty) still derives rather than guesses; the
 * binding must be to a resolver call, so an identifier holding a literal stays illegal.
 */
function locallyDerivedCapNames(src) {
    const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*resolveSubprocessCap(?:FromBudgetAndMeasurement)?\s*\(/g;
    const names = new Set();
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
    return names;
}

/** Every form in which a cap may legally reach a subprocess: derived here, or derived there. */
function isDerivedCap(value, src) {
    return value.startsWith('resolveSubprocessCap(')
        || importedCapNames(src).has(value)
        || locallyDerivedCapNames(src).has(value);
}

// ---------------------------------------------------------------------------
// AC-A1 — every heavy subprocess cap derives through the resolver
// ---------------------------------------------------------------------------

for (const file of CONVERTED_FILES) {
    test(`AC-A1: every subprocess cap in ${file} comes from the resolver`, () => {
        const src = readConverted(file);
        const values = extractSubprocessTimeoutValues(src);
        assert.ok(values.length > 0, `expected subprocess caps in ${file}`);

        for (const value of values) {
            if (value === MARKED_ASSERTION_CAP) continue;
            assert.ok(
                !/^\d/.test(value),
                `${file}: bare numeric subprocess cap "${value}" reaches spawnSync without the resolver`,
            );
            assert.ok(
                isDerivedCap(value, src),
                `${file}: cap "${value}" is neither a resolver call, a cap imported from the ` +
                'helper, nor a local constant bound to a resolver call',
            );
        }
    });
}

// A values-only scan can only judge caps that EXIST. Dropping the `timeout:` key from a
// spawn deletes the cap and every assertion about it in the same stroke, which is the one
// regression a cap guard must not sleep through. Subject spawns are separated from fixture
// spawns by the command they name, so the ~22 `execFileSync('git', …)` setup calls stay
// legal without an allowlist that would need maintaining.
for (const file of CONVERTED_FILES) {
    test(`AC-A1: every subject spawn in ${file} carries a cap`, () => {
        const src = readConverted(file);
        const subject = extractSubprocessCalls(src).filter(isSubjectSpawn);
        assert.ok(subject.length > 0, `expected subject spawns in ${file}`);

        for (const call of subject) {
            assert.ok(
                call.timeoutValues.length > 0,
                `${file}: subject spawn "${call.command}" passes no timeout — an un-capped ` +
                'subprocess can hang the tier forever, and no cap assertion can see it',
            );
            for (const value of call.timeoutValues) {
                if (value === MARKED_ASSERTION_CAP) continue;
                assert.ok(
                    isDerivedCap(value, src),
                    `${file}: subject cap "${value}" is not resolver-derived`,
                );
            }
        }
    });

    test(`AC-A1: every subprocess call in ${file} classifies as subject or fixture`, () => {
        const calls = extractSubprocessCalls(readConverted(file));
        assert.ok(calls.length > 0, `expected subprocess calls in ${file}`);
        for (const call of calls) {
            assert.equal(
                Number(isSubjectSpawn(call)) + Number(isFixtureSpawn(call)), 1,
                `${file}: subprocess command "${call.command}" is neither a node runtime ` +
                'nor a string-literal tool. Name the binary directly, or teach the ' +
                'classifier the new shape — an unclassified spawn is an uncapped spawn ' +
                'nothing checks',
            );
        }
    });
}

// Anti-vacuity for the split above: the per-file assertions can only bite while both
// populations are inhabited somewhere in the converted set. A refactor that emptied the
// fixture lane would leave the subject/fixture distinction carrying nothing, and the
// exactly-one-classification check would pass over a single degenerate population.
test('AC-A1: the converted set holds both subject and fixture spawns', () => {
    const calls = CONVERTED_FILES.flatMap(file => extractSubprocessCalls(readConverted(file)));
    assert.ok(calls.filter(isSubjectSpawn).length > 0, 'no subject spawn in the converted set');
    assert.ok(calls.filter(isFixtureSpawn).length > 0, 'no fixture spawn in the converted set');
});

test('AC-A1: exactly one marked assertion-cap survives across the converted files', () => {
    const occurrences = CONVERTED_FILES.flatMap(
        file => extractSubprocessTimeoutValues(readConverted(file)),
    ).filter(v => v.startsWith('resolveAssertionCap('));
    assert.deepEqual(occurrences, [MARKED_ASSERTION_CAP]);
});

test('AC-A1: the marked assertion-cap still bounds its own assertion', () => {
    const src = readConverted('spawn-morty.test.js');
    const idx = src.indexOf(MARKED_ASSERTION_CAP);
    assert.ok(idx > 0, 'marked assertion-cap not found');
    const following = src.slice(idx, idx + 900);
    assert.match(
        following,
        /should exit non-zero within 5s/,
        'the 5000ms cap must still be the bound its own test asserts',
    );
    assert.equal(resolveAssertionCap(5000), 5000, 'assertion caps pass through unchanged');
});

// ---------------------------------------------------------------------------
// AC-A2 — caps clear the uncensored fbc15455 durations
// ---------------------------------------------------------------------------

/** Worst recorded duration per test name, parsed from the committed measurements table. */
function parseMeasurements() {
    const rows = fs.readFileSync(MEASUREMENTS_PATH, 'utf-8')
        .split('\n')
        .filter(line => line.startsWith('|') && /\bpass\b/.test(line));
    assert.ok(rows.length >= 10, `expected the fbc15455 table rows, got ${rows.length}`);
    /** @type {Record<string, number>} */
    const worst = {};
    for (const row of rows) {
        const cells = row.split('|').map(c => c.trim());
        const name = cells[1];
        const duration = Number(cells[5]);
        assert.ok(Number.isFinite(duration), `unparseable duration in row: ${row}`);
        worst[name] = Math.max(worst[name] ?? 0, duration);
    }
    return worst;
}

test('AC-A2: helper measurements match the committed fbc15455 table', () => {
    const worst = parseMeasurements();
    for (const [name, value] of Object.entries(FBC15455_MEASURED_MAX_MS)) {
        assert.equal(
            value, worst[name],
            `${name}: helper records ${value}ms but the committed table's worst run is ${worst[name]}ms`,
        );
    }
    assert.equal(
        SPAWN_MORTY_WORST_MEASURED_MS,
        Math.max(...Object.entries(FBC15455_MEASURED_MAX_MS)
            .filter(([n]) => !n.includes('test:fast failure') && !n.includes('evidence-absent'))
            .map(([, v]) => v)),
    );
    assert.equal(
        WORKER_GATE_WORST_MEASURED_MS,
        Math.max(...Object.entries(FBC15455_MEASURED_MAX_MS)
            .filter(([n]) => n.includes('test:fast failure') || n.includes('evidence-absent'))
            .map(([, v]) => v)),
    );
});

const MEASURED_CAP_CASES = [
    {
        cap: CAP_MEASURED_ORPHAN_TMP_BACKEND,
        name: 'spawn-morty: recovers orphan tmp backend state before routing worker CLI',
    },
    {
        cap: CAP_MEASURED_ORPHAN_TMP_SESSION_TIMEOUT,
        name: 'spawn-morty: recovers orphan tmp session timeout before printing worker budget',
    },
    {
        cap: CAP_MEASURED_HERMES_COMPLETES,
        name: 'spawn-morty.hermes: spawns hermes chat with toolsets and completes',
    },
    {
        cap: CAP_WORKER_GATE,
        name: 'spawn-morty: test:fast failure with work evidence suppresses the Failed flip and preserves the commit',
    },
    {
        cap: CAP_WORKER_GATE,
        name: 'spawn-morty: evidence-absent test:fast failure still marks ticket Failed and resets HEAD',
    },
];

for (const c of MEASURED_CAP_CASES) {
    test(`AC-A2: cap ${c.cap}ms clears 3x the measured completion of "${c.name}"`, () => {
        const measured = FBC15455_MEASURED_MAX_MS[c.name];
        assert.ok(Number.isFinite(measured), `no measurement recorded for ${c.name}`);
        assert.ok(
            c.cap >= measured * 3,
            `cap ${c.cap}ms is below 3x the ${measured}ms completion for "${c.name}"`,
        );
    });
}

test('AC-A2: the indeterminate cap clears 3x the worst spawn-morty completion', () => {
    assert.ok(CAP_SPAWN_MORTY_INDETERMINATE >= SPAWN_MORTY_WORST_MEASURED_MS * 3);
});

// ---------------------------------------------------------------------------
// AC-A3 — no conversion lowers an existing cap
// ---------------------------------------------------------------------------

test('AC-A3: a clamped 5s subject yields >= 60000ms, never 15000ms', () => {
    // The clamp proof lives on the BUDGET arm. The shipped constant is the max of the
    // budget and measured arms, so asserting the clamp against the constant would pass
    // even if the clamp were deleted — the measured arm would carry it.
    const budgetArm = resolveSubprocessCap({ subjectTimeoutSeconds: 5 });
    assert.notEqual(budgetArm, 15_000, 'derived from the CLI argument instead of the effective budget');
    assert.ok(budgetArm >= 60_000, `expected >= 60000ms for a clamped subject, got ${budgetArm}`);
    assert.equal(
        budgetArm, resolveSubprocessCap({ subjectTimeoutSeconds: MIN_TIMEOUT_SECONDS }),
        'a sub-minimum --timeout must derive the same cap as the minimum it clamps to',
    );
    assert.ok(
        CAP_SPAWN_MORTY_CLAMPED_BUDGET >= budgetArm,
        `shipped clamped cap ${CAP_SPAWN_MORTY_CLAMPED_BUDGET}ms is below its own budget arm ${budgetArm}ms`,
    );
    assert.notEqual(CAP_SPAWN_MORTY_CLAMPED_BUDGET, 15_000);
    assert.ok(CAP_SPAWN_MORTY_CLAMPED_BUDGET >= 60_000);
});

// ---------------------------------------------------------------------------
// F1 — a budget-derived cap must also clear the subject's observed wall-clock.
// `--timeout` bounds only the inner child spawn, so it is a floor input and never
// a measurement of how long the subprocess runs.
// ---------------------------------------------------------------------------

const BUDGET_DERIVED_CAPS = [
    { name: 'CAP_SPAWN_MORTY_DEFAULT_BUDGET', cap: CAP_SPAWN_MORTY_DEFAULT_BUDGET, seconds: 30 },
    { name: 'CAP_SPAWN_MORTY_CLAMPED_BUDGET', cap: CAP_SPAWN_MORTY_CLAMPED_BUDGET, seconds: 5 },
];

test('F1: every budget-derived cap is the max of its budget and measured arms', () => {
    for (const { name, cap, seconds } of BUDGET_DERIVED_CAPS) {
        assert.equal(
            cap,
            resolveSubprocessCapFromBudgetAndMeasurement({
                subjectTimeoutSeconds: seconds,
                measuredMaxMs: SPAWN_MORTY_WORST_MEASURED_MS,
            }),
            `${name} does not follow the two-arm derivation`,
        );
        assert.ok(
            cap >= resolveSubprocessCap({ subjectTimeoutSeconds: seconds }),
            `${name} is below its own budget arm`,
        );
        assert.ok(
            cap >= resolveSubprocessCap({ measuredMaxMs: SPAWN_MORTY_WORST_MEASURED_MS }),
            `${name} is below its own measured arm`,
        );
    }
});

test('F1: a budget-derived cap clears 3x the file\'s worst uncensored completion', () => {
    for (const { name, cap } of BUDGET_DERIVED_CAPS) {
        assert.ok(
            cap >= SPAWN_MORTY_WORST_MEASURED_MS * MULTIPLIER,
            `${name} = ${cap}ms is below ${MULTIPLIER}x the ${SPAWN_MORTY_WORST_MEASURED_MS}ms ` +
            'worst completion recorded for this file',
        );
    }
});

// The two durations below are CENSORED — exit status `null`, i.e. the harness killed the
// subject at the cap, so they are lower bounds on the real duration, not measurements.
// They are admissible as evidence that a cap is too small and inadmissible as cap inputs.
const CENSORED_OVERRUNS_MS = [
    { test: 'spawn-morty: session working_dir controls child cwd and repo access', ms: 90_035.7 },
    { test: 'spawn-morty P2 post-flush: token + artifact + git edits + log<200B → success', ms: 90_128.7 },
];

test('F1: budget-derived caps exceed the observed 90000ms overruns', () => {
    for (const { name, cap } of BUDGET_DERIVED_CAPS) {
        for (const overrun of CENSORED_OVERRUNS_MS) {
            assert.ok(
                cap > overrun.ms,
                `${name} = ${cap}ms does not clear the ${overrun.ms}ms overrun of "${overrun.test}"`,
            );
        }
    }
});

test('F1: no censored duration feeds a cap', () => {
    for (const overrun of CENSORED_OVERRUNS_MS) {
        for (const [row, value] of Object.entries(FBC15455_MEASURED_MAX_MS)) {
            assert.notEqual(
                Math.round(value), Math.round(overrun.ms),
                `cap-input row "${row}" carries a censored (harness-killed) duration`,
            );
        }
    }
    // Every cap input must appear in the committed table as a passing row. `parseMeasurements`
    // filters to `pass` rows, so a value absent from it was never an uncensored completion.
    const uncensored = parseMeasurements();
    for (const [row, value] of Object.entries(FBC15455_MEASURED_MAX_MS)) {
        assert.equal(
            value, uncensored[row],
            `cap-input row "${row}" has no uncensored measurement backing it`,
        );
    }
});

// ---------------------------------------------------------------------------
// F3 — the caps must clear what was actually observed UNDER LOAD.
//
// Every other would-it-notice assertion in this file compares a cap either to an at-rest
// measurement or to a second derivation of its own inputs, so all of them stay green under
// a cap that is self-consistently too small — which is what shipped, and what killed two
// tests at --test-concurrency=4. The row below is the one uncensored loaded completion the
// bundle recorded: it ran to completion in 105_321.575166ms and failed on
// `expected recovered timeout near 90s, got 78s` (an assertion, since fixed by 7ca5c54c),
// NOT on its cap. Contrast the CENSORED_OVERRUNS_MS rows above, whose exit status is
// `null` — those are kills, and a kill time is a lower bound, not a measurement.
// Provenance: 94833eaf/fast_c4_tier_run.log:13478-13479.
const OBSERVED_LOADED_COMPLETIONS = [
    {
        test: 'spawn-morty: recovers orphan tmp session timeout before printing worker budget',
        ms: 105_321.575166,
        cap: CAP_MEASURED_ORPHAN_TMP_SESSION_TIMEOUT,
        capName: 'CAP_MEASURED_ORPHAN_TMP_SESSION_TIMEOUT',
        preBundleCap: 90_000,
    },
];

for (const c of OBSERVED_LOADED_COMPLETIONS) {
    test(`F3: ${c.capName} clears the loaded completion of "${c.test}"`, () => {
        assert.ok(
            c.cap > c.ms,
            `${c.capName} = ${c.cap}ms does not clear the ${c.ms}ms this test took under load`,
        );
        // Without this arm the assertion above would be satisfied by a cap that has never
        // been at risk, and would say nothing about the regression it exists to catch.
        assert.ok(
            c.preBundleCap < c.ms,
            `the pre-bundle ${c.preBundleCap}ms cap would have cleared ${c.ms}ms, so this ` +
            'assertion cannot distinguish the fix from the defect',
        );
    });

    test(`F3: the loaded completion of "${c.test}" exceeds its own at-rest measurement`, () => {
        const atRest = FBC15455_MEASURED_MAX_MS[c.test];
        assert.ok(Number.isFinite(atRest), `no at-rest measurement recorded for ${c.test}`);
        assert.ok(
            c.ms > atRest,
            `${c.ms}ms is not above the ${atRest}ms at-rest row — a loaded observation that ` +
            'does not exceed its at-rest twin is an at-rest duplicate, and pins nothing',
        );
    });
}

const PRE_CONVERSION_CAPS = [
    { name: 'CAP_SPAWN_MORTY_DEFAULT_BUDGET', cap: CAP_SPAWN_MORTY_DEFAULT_BUDGET, previous: 45_000 },
    { name: 'CAP_SPAWN_MORTY_CLAMPED_BUDGET', cap: CAP_SPAWN_MORTY_CLAMPED_BUDGET, previous: 45_000 },
    { name: 'CAP_SPAWN_MORTY_INDETERMINATE', cap: CAP_SPAWN_MORTY_INDETERMINATE, previous: 45_000 },
    { name: 'CAP_MEASURED_ORPHAN_TMP_BACKEND', cap: CAP_MEASURED_ORPHAN_TMP_BACKEND, previous: 45_000 },
    { name: 'CAP_MEASURED_ORPHAN_TMP_SESSION_TIMEOUT', cap: CAP_MEASURED_ORPHAN_TMP_SESSION_TIMEOUT, previous: 45_000 },
    { name: 'CAP_MEASURED_HERMES_COMPLETES', cap: CAP_MEASURED_HERMES_COMPLETES, previous: 45_000 },
    { name: 'CAP_WORKER_GATE', cap: CAP_WORKER_GATE, previous: 90_000 },
];

for (const c of PRE_CONVERSION_CAPS) {
    test(`AC-A3: ${c.name} does not lower its pre-conversion cap`, () => {
        assert.ok(
            c.cap >= c.previous,
            `${c.name} = ${c.cap}ms is below its pre-conversion ${c.previous}ms`,
        );
    });
}

test('AC-A3: every derived cap clears the subject hang-guard floor', () => {
    for (const { name, cap } of PRE_CONVERSION_CAPS) {
        assert.ok(
            cap > MIN_TIMEOUT_SECONDS * 1000 + HANG_GUARD_GRACE_MS,
            `${name} = ${cap}ms does not clear the subject's longest defined path`,
        );
    }
});

const AMBIGUOUS_INPUT_CASES = [
    { label: 'neither', opts: {}, field: 'neither' },
    { label: 'both', opts: { subjectTimeoutSeconds: 30, measuredMaxMs: 40_000 }, field: 'both' },
    { label: 'zero seconds', opts: { subjectTimeoutSeconds: 0 }, field: 'subjectTimeoutSeconds' },
    { label: 'negative seconds', opts: { subjectTimeoutSeconds: -1 }, field: 'subjectTimeoutSeconds' },
    { label: 'NaN seconds', opts: { subjectTimeoutSeconds: NaN }, field: 'subjectTimeoutSeconds' },
    { label: 'zero measured', opts: { measuredMaxMs: 0 }, field: 'measuredMaxMs' },
    { label: 'negative measured', opts: { measuredMaxMs: -5 }, field: 'measuredMaxMs' },
    { label: 'Infinity measured', opts: { measuredMaxMs: Infinity }, field: 'measuredMaxMs' },
];

for (const c of AMBIGUOUS_INPUT_CASES) {
    test(`AC-A3: ambiguous input rejected — ${c.label}`, () => {
        assert.throws(
            () => resolveSubprocessCap(c.opts),
            err => err instanceof TypeError && err.message.includes(c.field),
            `expected a TypeError naming ${c.field}`,
        );
    });
}

test('AC-A3: resolveAssertionCap rejects a non-positive input', () => {
    assert.throws(() => resolveAssertionCap(0), TypeError);
    assert.throws(() => resolveAssertionCap(-1), TypeError);
});

// ---------------------------------------------------------------------------
// AC-A4 — constants imported, not copied; ceiling enforced loudly
// ---------------------------------------------------------------------------

test('AC-A4: the resolver imports the subject constants rather than redeclaring them', () => {
    const helper = fs.readFileSync(HELPER_PATH, 'utf-8');
    assert.match(
        helper,
        /import\s*\{[^}]*MIN_TIMEOUT_SECONDS[^}]*HANG_GUARD_GRACE_MS[^}]*\}\s*from\s*'\.\.\/\.\.\/bin\/spawn-morty\.js'/,
        'helper must import both constants from the subject',
    );
    assert.equal(
        (helper.match(/MIN_TIMEOUT_SECONDS\s*=\s*30/g) ?? []).length, 0,
        'helper redeclares MIN_TIMEOUT_SECONDS',
    );
    assert.equal(
        (helper.match(/HANG_GUARD_GRACE_MS\s*=\s*30_?000/g) ?? []).length, 0,
        'helper redeclares the hang-guard grace',
    );
});

test('AC-A4: the subject still defines the values the resolver assumes', () => {
    const ts = fs.readFileSync(SPAWN_MORTY_TS, 'utf-8');
    assert.match(ts, /export const MIN_TIMEOUT_SECONDS = 30;/);
    assert.match(ts, /export const HANG_GUARD_GRACE_MS = 30_000;/);
    assert.equal(MIN_TIMEOUT_SECONDS, 30);
    assert.equal(HANG_GUARD_GRACE_MS, 30_000);
    assert.match(
        ts,
        /ctx\.effectiveTimeoutMs \+ HANG_GUARD_GRACE_MS/,
        'the hang guard must consume the exported constant, not a literal',
    );
});

test('AC-A4: the derivation follows the documented formula', () => {
    assert.ok(MULTIPLIER >= 3 && MULTIPLIER <= 5, `MULTIPLIER ${MULTIPLIER} outside 3..5`);
    for (const seconds of [30, 45, 60]) {
        const budget = seconds * 1000;
        const floor = budget + HANG_GUARD_GRACE_MS + STARTUP_ALLOWANCE_MS;
        assert.equal(
            resolveSubprocessCap({ subjectTimeoutSeconds: seconds }),
            Math.max(floor, budget * MULTIPLIER),
        );
    }
});

test('AC-A4: the ceiling is enforced loudly — a --timeout 600 derivation throws', () => {
    let thrown = null;
    try {
        resolveSubprocessCap({ subjectTimeoutSeconds: 600 });
    } catch (err) {
        thrown = err;
    }
    assert.ok(thrown instanceof RangeError, `expected RangeError, got ${thrown}`);
    assert.match(thrown.message, /subjectTimeoutSeconds=600/, 'must name the input');
    assert.match(
        thrown.message,
        new RegExp(`MAX_SUBPROCESS_CAP_MS=${MAX_SUBPROCESS_CAP_MS}`),
        'must name the ceiling',
    );
    assert.match(thrown.message, /at .*subprocess-cap-resolver\.test\.js/, 'must name the callsite');
});

test('AC-A4: the ceiling sits above every derived cap and below the naive 600s derivation', () => {
    for (const { name, cap } of PRE_CONVERSION_CAPS) {
        assert.ok(cap <= MAX_SUBPROCESS_CAP_MS, `${name} exceeds the ceiling`);
    }
    assert.ok(600 * 1000 * MULTIPLIER > MAX_SUBPROCESS_CAP_MS);
});
