# B-LANES-FIX — five gate reds left by B-LANES on `exp/b-lanes`

**EXPERIMENTAL BRANCH `exp/b-lanes` ONLY.** Never touch `main`, never run `install.sh`, never tag.

The B-LANES pipeline (session `2026-09-24-7287b60e`) finished with `post_final_tier_degraded:red`. The full gate
on `exp/b-lanes` at `c2f92b63` (run `20260925T051520Z-26736`) is **red on 2 of 22 legs**. Every failure below is
deterministic (identical in all flake-budget runs) and caused by code this bundle added. Measured 2026-09-25.

## The reds and the intended fix (fix the cause; do not loosen the checks)

1. **`audit-guarded-reset` leg + `tests/guarded-reset.test.js` "audit: exits 0 against the real src/ tree".**
   `extension/src/services/anatomy-lanes.ts:308` calls `resetToSha(before, worktree, preserve)` without the
   4th `archive` argument (`ArchiveContext`, `git-utils.ts:268`). Pass a real archive context
   `{ cwd, sessionDir, ticketDir, reason }` for the integration-worktree reset. The reset must still target the
   **integration worktree only**, never the main checkout.
2. **`tests/ac6-operator-surface-guard.test.js`** (the ":never call sites", "AC-6: Operator/terminal surface
   guard" and "extractor output at HEAD and at BASE_SHA is byte-identical" cases). A new
   `bin/resolve-scope.ts::reportScopeError(err: unknown): never` (`:15`) enters the terminal-call-site set.
   Remove the `: never` function. Put `process.exit` at each call site's catch instead (`:68`, `:86`, `:120`),
   which is the established pattern for this guard. Do not edit the guard's baseline.
3. **`tests/activity-event-payload.test.js`:** `anatomy_lanes_integrated` and `anatomy_lane_branches_reported`
   are in `VALID_ACTIVITY_EVENTS` but have no definition in `extension/src/types/activity-events.schema.json`.
   Add both definitions, with payload fields matching what `anatomy-lanes.ts` emits.
4. **`tests/activity-logger.test.js` "VALID_ACTIVITY_EVENTS contains all expected event types":** expected 246,
   actual 248. Add the two event names to the test's expected set, rather than only bumping the number, so the
   count stays derived from named members.
5. **`tests/scope-backcompat.test.js` "backcompat (b): anatomy-park.json deep-equals baseline fixture when no
   scope":** `anatomy-park.json` now carries the additive `lanes` field, which the refined PRD requires. Readers
   ignore unknown fields. Update `tests/fixtures/backcompat-baseline-anatomy-park.json` to include `lanes`, and
   add a one-line comment in the test saying the field is intentionally additive. Every other field must still
   deep-equal the old baseline.

## Acceptance criteria

1. `cd extension && bash scripts/audit-guarded-reset.sh` exits 0 (HEAD `c2f92b63`: exits 1).
2. `cd extension && ./node_modules/.bin/tsc && node --test tests/ac6-operator-surface-guard.test.js
   tests/activity-event-payload.test.js tests/activity-logger.test.js tests/scope-backcompat.test.js
   tests/guarded-reset.test.js` exits 0 (HEAD: all five files red).
3. `grep -c "): never" extension/src/bin/resolve-scope.ts` returns 0 (HEAD: 1).
4. `cd extension && ./node_modules/.bin/tsc --noEmit && npx eslint src/ --max-warnings=0` exits 0.
5. `cd extension && npm run test:fast` passes on a quiet machine. Run it once, and do not overlap it with other tiers.

## Simplification Review

Pure repair of this bundle's own reds: one missing argument, one removed `: never` function, two schema
definitions, two test-set members and one additive fixture field. No gate, guard or baseline is loosened.

## Out of scope

Any new behaviour; anything on `main`.
