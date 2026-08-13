// Derives the millisecond cap a test may put on a `spawn-morty.js` subprocess from the
// subject's own effective budget, rather than from a hand-picked literal.
//
// A cap written beside a `--timeout N` callsite encodes a margin nobody chose and nothing
// re-checks when either number moves. Two facts make the naive derivation wrong:
//
//   1. The CLI argument is not the budget. `resolveEffectiveTimeout`
//      (src/bin/spawn-morty.ts:446-460) clamps the configured value down to the parent
//      session's remaining wall-clock and up to MIN_TIMEOUT_SECONDS, so a `--timeout 5`
//      callsite can be running a 30-second subject.
//   2. The subject's longest defined path is not its timeout. The hang guard
//      (src/bin/spawn-morty.ts:3095-3101) fires at effectiveTimeoutMs + HANG_GUARD_GRACE_MS,
//      and process startup, state-manager schema migration, and teardown all sit outside
//      that window.
//
// Both constants are imported from the subject, never re-declared here: a copy would
// recreate the magic-number defect one layer up.
import { MIN_TIMEOUT_SECONDS, HANG_GUARD_GRACE_MS } from '../../bin/spawn-morty.js';

/** Node startup + state-manager schema migration + teardown, outside the hang-guard window. */
export const STARTUP_ALLOWANCE_MS = 15_000;

/** Headroom over the subject's own worst case. Ticket invariant: 3 <= MULTIPLIER <= 5. */
export const MULTIPLIER = 3;

/**
 * A fast-tier subprocess needing more than this is a design error, not a slow machine.
 * Sits above the largest legitimate derived cap (154_527 ms) and below the derivation a
 * `--timeout 600` fixture would produce (1_800_000 ms), so that case throws instead of
 * silently becoming a 30-minute cap.
 */
export const MAX_SUBPROCESS_CAP_MS = 300_000;

/**
 * Worst uncensored completion recorded per test by fbc15455 (WS-A0), from
 * `prds/research/fbc15455/measurements.md`. Every row is a completion, never a kill, so
 * no cap below is derived from a harness kill time.
 */
export const FBC15455_MEASURED_MAX_MS = {
    'spawn-morty: recovers orphan tmp backend state before routing worker CLI': 40_350,
    'spawn-morty: recovers orphan tmp session timeout before printing worker budget': 41_753,
    'spawn-morty.hermes: spawns hermes chat with toolsets and completes': 28_326,
    'spawn-morty: test:fast failure with work evidence suppresses the Failed flip and preserves the commit': 51_509,
    'spawn-morty: evidence-absent test:fast failure still marks ticket Failed and resets HEAD': 47_120,
};

/** Worst completion observed anywhere in tests/spawn-morty.test.js. */
export const SPAWN_MORTY_WORST_MEASURED_MS = 41_753;

/** Worst completion observed anywhere in tests/spawn-morty-worker-gate.test.js. */
export const WORKER_GATE_WORST_MEASURED_MS = 51_509;

function describeCallsite() {
    const frames = (new Error().stack ?? '').split('\n');
    // [0] 'Error', [1] describeCallsite, [2] the resolver, [3] the callsite that asked.
    const frame = frames[3] ?? frames[frames.length - 1] ?? '';
    return frame.trim().replace(/^at\s+/, '') || 'unknown callsite';
}

function assertPositiveFinite(value, field) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new TypeError(
            `subprocess-cap: ${field} must be a positive finite number, got ${String(value)}`,
        );
    }
}

/**
 * @param {{ subjectTimeoutSeconds?: number, measuredMaxMs?: number }} opts
 *   Exactly one of `subjectTimeoutSeconds` (the value the callsite passes as `--timeout`)
 *   or `measuredMaxMs` (an uncensored completion duration, for callsites whose subject
 *   budget is indeterminate or whose `--timeout` is a fixture rather than a real budget).
 * @returns {number} integer millisecond cap
 */
export function resolveSubprocessCap(opts = {}) {
    const { subjectTimeoutSeconds, measuredMaxMs } = opts;
    const hasTimeout = subjectTimeoutSeconds !== undefined && subjectTimeoutSeconds !== null;
    const hasMeasured = measuredMaxMs !== undefined && measuredMaxMs !== null;

    if (hasTimeout && hasMeasured) {
        throw new TypeError(
            'subprocess-cap: pass exactly one of subjectTimeoutSeconds or measuredMaxMs, got both',
        );
    }
    if (!hasTimeout && !hasMeasured) {
        throw new TypeError(
            'subprocess-cap: pass exactly one of subjectTimeoutSeconds or measuredMaxMs, got neither',
        );
    }

    let observedMs;
    if (hasTimeout) {
        assertPositiveFinite(subjectTimeoutSeconds, 'subjectTimeoutSeconds');
        observedMs = subjectTimeoutSeconds * 1000;
    } else {
        assertPositiveFinite(measuredMaxMs, 'measuredMaxMs');
        observedMs = measuredMaxMs;
    }

    // The clamp at src/bin/spawn-morty.ts:458-459 floors the subject at MIN_TIMEOUT_SECONDS,
    // so a `--timeout 5` callsite is budgeted as the 30-second subject it actually runs.
    const effectiveBudgetMs = Math.max(MIN_TIMEOUT_SECONDS * 1000, observedMs);
    const floorMs = effectiveBudgetMs + HANG_GUARD_GRACE_MS + STARTUP_ALLOWANCE_MS;
    const cap = Math.ceil(Math.max(floorMs, effectiveBudgetMs * MULTIPLIER));

    if (cap > MAX_SUBPROCESS_CAP_MS) {
        const input = hasTimeout
            ? `subjectTimeoutSeconds=${subjectTimeoutSeconds}`
            : `measuredMaxMs=${measuredMaxMs}`;
        throw new RangeError(
            `subprocess-cap: derived cap ${cap}ms from ${input} exceeds ` +
            `MAX_SUBPROCESS_CAP_MS=${MAX_SUBPROCESS_CAP_MS} at ${describeCallsite()}. ` +
            'The input is not a real subprocess budget — pass a measured duration instead.',
        );
    }
    return cap;
}

/**
 * A cap must clear BOTH derivations: the subject's own budget-plus-hang-guard floor AND
 * its observed worst elapsed wall-clock.
 *
 * `--timeout` bounds only the inner child spawn (`ctx.effectiveTimeoutMs`,
 * src/bin/spawn-morty.ts:3089); the subprocess's total elapsed time additionally contains
 * node startup, state-manager schema migration, git fixture work and teardown, none of
 * which that budget bounds. So the budget is a floor input, never a measurement of how
 * long the subprocess runs — treating it as one is the same category error as reading the
 * raw CLI argument, one layer down. The file's own uncensored measurements settle it:
 * a spawn-morty subprocess reaches 41_753ms at rest, 1.39x its 30_000ms nominal budget.
 *
 * Two independent single-input calls rather than one relaxed call: `resolveSubprocessCap`
 * rejects both-inputs on purpose, and keeping that rejection means the budget arm still
 * runs the MIN_TIMEOUT_SECONDS clamp on its own instead of having it masked by a larger
 * measured value. Each arm enforces MAX_SUBPROCESS_CAP_MS separately.
 *
 * @param {{ subjectTimeoutSeconds: number, measuredMaxMs: number }} opts
 * @returns {number} integer millisecond cap
 */
export function resolveSubprocessCapFromBudgetAndMeasurement({ subjectTimeoutSeconds, measuredMaxMs }) {
    return Math.max(
        resolveSubprocessCap({ subjectTimeoutSeconds }),
        resolveSubprocessCap({ measuredMaxMs }),
    );
}

/**
 * Marks a cap that IS the assertion — a test proving the subject exits within N ms needs
 * that N, and deriving it would delete the test's meaning. Returns its input unchanged so
 * a deliberate cap and a stray literal are distinguishable by reading the callsite.
 * @param {number} ms
 * @returns {number}
 */
export function resolveAssertionCap(ms) {
    assertPositiveFinite(ms, 'ms');
    return ms;
}

// --- Caps consumed by the converted test files -----------------------------------------
// Each measured cap cites its fbc15455 row; budget-derived caps cite the subject's
// `--timeout` argument.

/**
 * `--timeout 30` callsites. Capped above `3 x 30_000` on purpose: the budget bounds the
 * inner child spawn, not the subprocess, and this file's own uncensored worst completion
 * is 41_753ms. Deriving from the budget alone yielded 90_000ms, which is what killed
 * `session working_dir controls child cwd and repo access` (90_035.7ms) and
 * `P2 post-flush: token + artifact + git edits + log<200B -> success` (90_128.7ms) under
 * `--test-concurrency=4` — both exit status `null`, i.e. harness kills, not subject bugs.
 */
export const CAP_SPAWN_MORTY_DEFAULT_BUDGET = resolveSubprocessCapFromBudgetAndMeasurement({
    subjectTimeoutSeconds: 30,
    measuredMaxMs: SPAWN_MORTY_WORST_MEASURED_MS,
});

/**
 * `--timeout 5` callsites — the subject clamps up to 30s, so the cap must not be cut. The
 * budget arm still proves that clamp on its own; the measured arm then raises the result
 * for the same reason as the default-budget cap above.
 */
export const CAP_SPAWN_MORTY_CLAMPED_BUDGET = resolveSubprocessCapFromBudgetAndMeasurement({
    subjectTimeoutSeconds: 5,
    measuredMaxMs: SPAWN_MORTY_WORST_MEASURED_MS,
});

/**
 * Callsites whose subject budget cannot be read off the CLI argument: the shared `run()`
 * helper, spawns with no `--timeout`, malformed-value fixtures, and the `--timeout 600`
 * fixtures whose subject exits early and never consumes 600s.
 */
export const CAP_SPAWN_MORTY_INDETERMINATE = resolveSubprocessCap({
    measuredMaxMs: SPAWN_MORTY_WORST_MEASURED_MS,
});

/** fbc15455 row: 'recovers orphan tmp backend state before routing worker CLI', loaded. */
export const CAP_MEASURED_ORPHAN_TMP_BACKEND = resolveSubprocessCap({
    measuredMaxMs: FBC15455_MEASURED_MAX_MS[
        'spawn-morty: recovers orphan tmp backend state before routing worker CLI'],
});

/** fbc15455 row: 'recovers orphan tmp session timeout before printing worker budget', loaded. */
export const CAP_MEASURED_ORPHAN_TMP_SESSION_TIMEOUT = resolveSubprocessCap({
    measuredMaxMs: FBC15455_MEASURED_MAX_MS[
        'spawn-morty: recovers orphan tmp session timeout before printing worker budget'],
});

/** fbc15455 row: 'spawn-morty.hermes: spawns hermes chat with toolsets and completes', loaded. */
export const CAP_MEASURED_HERMES_COMPLETES = resolveSubprocessCap({
    measuredMaxMs: FBC15455_MEASURED_MAX_MS[
        'spawn-morty.hermes: spawns hermes chat with toolsets and completes'],
});

/** Shared by the three worker-gate spawns; clears the worst row in that file. */
export const CAP_WORKER_GATE = resolveSubprocessCap({
    measuredMaxMs: WORKER_GATE_WORST_MEASURED_MS,
});
