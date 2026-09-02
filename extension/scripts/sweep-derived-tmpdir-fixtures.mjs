#!/usr/bin/env node
/**
 * Ticket C2 — posttest TMPDIR sweep for the long tail of `mkdtempSync` producers that never
 * adopted `tests/helpers/fixture-tmpdir.js`'s crash-surviving registry (the two dominant
 * producers, `cp-git-`/`cp-state-`, were already converted by ticket 40).
 *
 * The prefix set this sweep removes is DERIVED from test source at run time
 * (`deriveTestOwnedTmpPrefixes` in `../services/orphan-reaper.js`) — never a hand-maintained
 * list — so a newly added `mkdtempSync(path.join(os.tmpdir(), '<prefix>'))` call site is
 * covered automatically, with no edit here.
 *
 * Best-effort by design, mirroring `bin/reap-orphans.js`: this script does not throw and
 * always exits 0, so a sweep failure can never redden a green test run.
 */
import { sweepDerivedTmpDirFixtures } from '../services/orphan-reaper.js';

try {
  const result = sweepDerivedTmpDirFixtures();
  // AP-EXT-ITER149-01: branch on `skipped` BEFORE rendering counts, and report on every
  // sweep including a zero one — the same AC6 contract `bin/reap-orphans.ts` applies to the
  // sibling census. Printing only when `scanned > 0` made silence mean two things at once:
  // "the TMPDIR was clean" and "this sweep never produced a census", which is the one
  // reading that lets the leak this hook exists to bound grow unobserved.
  if (result.skipped) {
    console.log(`sweep-derived-tmpdir-fixtures: sweep did not run (${result.skipped}) — no census`);
  } else {
    console.log(`sweep-derived-tmpdir-fixtures: scanned=${result.scanned} removed=${result.removed} prefixes=${result.prefixes_used.length}`);
  }
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`sweep-derived-tmpdir-fixtures: best-effort sweep failed: ${msg}`);
}
process.exit(0);
