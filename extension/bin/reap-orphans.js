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
import { getDataRoot } from '../services/pickle-utils.js';
import { reapOrphanedWorkerProcs } from '../services/orphan-reaper.js';
export function runStandaloneOrphanReap(sessionsRoot, deps = {}) {
    try {
        const reap = deps.reap ?? reapOrphanedWorkerProcs;
        const result = reap({ sessionsRoot });
        // AC5: a zero-reap sweep stays quiet; a non-zero sweep prints what it collected.
        if (result.reaped > 0) {
            const c = result.by_match_class;
            console.log(`[reap-orphans] scanned=${result.scanned} reaped=${result.reaped} unverified=${result.unverified} `
                + `session_owned=${c.session_owned} tmp_prefix_fixture=${c.tmp_prefix_fixture} repo_fixture_path=${c.repo_fixture_path}`);
        }
        return result;
    }
    catch {
        // Best-effort session-GC — never block a test run.
        return null;
    }
}
function main() {
    const sessionsRoot = path.join(getDataRoot(), 'sessions');
    runStandaloneOrphanReap(sessionsRoot);
    process.exit(0);
}
if (process.argv[1] && path.basename(process.argv[1]) === 'reap-orphans.js') {
    main();
}
