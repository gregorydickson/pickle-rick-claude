#!/usr/bin/env node
/**
 * Standalone sweep entry point for the R-CXHANG orphaned-worker-proc reaper
 * (`services/orphan-reaper.ts`). The pipeline-scoped call sites
 * (`setup.ts:runSetupOrphanReap`, `mux-runner.ts` runner-startup and
 * iteration-start) only fire inside a pipeline launch, so a developer running
 * `npm test` outside a pipeline never triggers a sweep and leaked fixtures
 * accumulate. This script gives `posttest` (and any other local invocation)
 * a way to reap the same population without a pipeline session.
 *
 * Best-effort by design, mirroring `runSetupOrphanReap` — this script does not throw and
 * always exits 0, so a reaper failure can never redden a green test run.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { getDataRoot } from '../services/pickle-utils.js';
import { reapOrphanedWorkerProcs, FIXTURE_TMPDIR_MAX_AGE_MS } from '../services/orphan-reaper.js';
/**
 * D6 (R-ORCG): fixture prefix for the TMPDIR directory backlog sweep. The staleness window is
 * NOT redeclared here — it is `FIXTURE_TMPDIR_MAX_AGE_MS` from `services/orphan-reaper.ts`, the
 * one floor shared with `sweepDerivedTmpDirFixtures`. Both sweeps run in the same `posttest`
 * hook over the same `os.tmpdir()` and both attribute `pickle-`, so a second local copy of this
 * number is a second policy, and the looser of two policies is the only one that has effect.
 */
const FIXTURE_TMPDIR_PREFIX = 'pickle-';
/**
 * Age-based backlog sweep for `pickle-*` directories left in TMPDIR by test fixtures whose
 * own cleanup (a per-test `finally`/`after()`) never ran — timeout, SIGKILL, OOM, or a
 * suite that never adopted `tests/helpers/fixture-tmpdir.js`. Unlike a PID-owned process, a
 * bare leftover directory has no liveness signal to probe, so staleness is decided by
 * mtime: anything older than `maxAgeMs` (default 24h, matching the existing fixture-registry
 * staleness convention) is stale by construction — no single-run test tier takes anywhere
 * near that long. Best-effort: a read/stat/rm failure on one entry is swallowed and the
 * sweep continues over the rest; it must never throw into the `posttest` hook it runs under.
 */
export function sweepStaleFixtureTmpDirs(tmpDir = os.tmpdir(), maxAgeMs = FIXTURE_TMPDIR_MAX_AGE_MS) {
    let entries;
    try {
        entries = fs.readdirSync(tmpDir);
    }
    catch {
        return { scanned: 0, removed: 0, skipped: 'sweep_failed' };
    }
    const now = Date.now();
    let scanned = 0;
    let removed = 0;
    for (const name of entries) {
        if (!name.startsWith(FIXTURE_TMPDIR_PREFIX))
            continue;
        const fullPath = path.join(tmpDir, name);
        let stat;
        try {
            stat = fs.statSync(fullPath);
        }
        catch {
            continue;
        }
        if (!stat.isDirectory())
            continue;
        scanned += 1;
        if (now - stat.mtimeMs < maxAgeMs)
            continue;
        try {
            fs.rmSync(fullPath, { recursive: true, force: true });
            removed += 1;
        }
        catch {
            /* best-effort — a locked/in-use directory is left for the next sweep */
        }
    }
    return { scanned, removed, skipped: null };
}
export function runStandaloneOrphanReap(sessionsRoot, deps = {}) {
    try {
        const reap = deps.reap ?? reapOrphanedWorkerProcs;
        const result = reap({ sessionsRoot });
        // AC6: every sweep reports, including zero-reap — a zero-reap sweep prints its
        // scanned count so "nothing matched" is distinguishable from "nothing to do".
        // A sweep that never RAN has no census at all: its zero counts are not a reading,
        // so it says so rather than borrowing the quiet-box line.
        if (result.skipped) {
            console.log(`[reap-orphans] sweep did not run (${result.skipped}) — no census`);
        }
        else if (result.reaped > 0) {
            const c = result.by_match_class;
            console.log(`[reap-orphans] scanned=${result.scanned} reaped=${result.reaped} unverified=${result.unverified} `
                + `session_owned=${c.session_owned} tmp_prefix_fixture=${c.tmp_prefix_fixture} repo_fixture_path=${c.repo_fixture_path}`);
        }
        else {
            console.log(`[reap-orphans] scanned=${result.scanned} reaped=0 (nothing to reap)`);
        }
        return result;
    }
    catch {
        // Best-effort session-GC — never block a test run.
        return null;
    }
}
/**
 * Operator line for the fixture-TMPDIR census. Exported and dep-injectable for the same
 * reason `runStandaloneOrphanReap` above is: the two printers in this file answer the same
 * did-we-count question and must be provable the same way. Keeping this one module-private
 * is what let its `removed > 0` gate ship untested (AP-EXT-ITER149-02).
 */
export function runStandaloneFixtureTmpDirSweep(deps = {}) {
    try {
        const result = (deps.sweep ?? sweepStaleFixtureTmpDirs)();
        // AC6, the same contract `runStandaloneOrphanReap` above already applies to the sibling
        // census: branch on `skipped` BEFORE rendering counts, then report on EVERY sweep
        // including a zero one. The `removed > 0` gate made one silence mean three things at
        // once — the TMPDIR was clean, the TMPDIR held only fresh fixtures, and the sweep never
        // ran — which is the reading that lets the leak this hook exists to bound grow unobserved.
        if (result.skipped) {
            console.log(`[reap-orphans] fixture-tmpdir sweep did not run (${result.skipped}) — no census`);
        }
        else {
            console.log(`[reap-orphans] fixture-tmpdir sweep: scanned=${result.scanned} removed=${result.removed}`);
        }
    }
    catch (err) {
        // Best-effort session-GC — never block a test run. But a swallowed throw is still a
        // sweep with no census, so it SAYS so rather than borrowing the quiet-box line.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[reap-orphans] fixture-tmpdir sweep did not run (sweep_failed) — no census: ${msg}`);
    }
}
function main() {
    const sessionsRoot = path.join(getDataRoot(), 'sessions');
    runStandaloneOrphanReap(sessionsRoot);
    runStandaloneFixtureTmpDirSweep();
    process.exit(0);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'reap-orphans.js') {
    main();
}
