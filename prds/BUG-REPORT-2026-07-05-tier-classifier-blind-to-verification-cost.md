# BUG REPORT — tier classifier has no signal for acceptance-criteria verification cost; medium/large tickets with expensive verify commands get the same budget as cheap ones

**Filed:** 2026-07-05 (forensics review of session `2026-07-04-4f50b896`, ticket `43e8f1a9`)
**Code:** R-TCVC (Tier Classifier blind to Verification Cost)
**Priority:** P3 (efficiency/reliability; no data loss — the recovery ladder already salvages the eventual result)
**Component:** `classifyTicketTier` (`extension/src/services/pickle-utils.ts`), ticket authoring path (`/pickle-refine-prd` → ticket AC generation)

## Symptom (observed)

Ticket `43e8f1a9` ("Audit: data-flow integrity for Plaid Enrich cutover", codex backend, session
`2026-07-04-4f50b896`) took 6 consecutive spawns with zero counted artifact progress before
`commit-and-continue` (R-ORSR-2) salvaged a real, gate-passing diff from the working tree. The ticket
was classified `medium` tier. One of its four acceptance criteria was `Verify: pnpm test:migration` —
a container-based DB migration suite, materially more expensive than the other three ACs (`grep`,
`pnpm test`, `pnpm run typecheck`).

## Root cause

`classifyTicketTier` (`extension/src/services/pickle-utils.ts:591`) is a pure function of `fileCount`,
`acCount`, `locEstimate`, plus a ±1 keyword adjustment from a 9-word list
(`integrate|migrate|schema|cross-cutting|refactor` vs `padding|typo|rename|delete|copy|label|color`).
It has **no signal for the cost of the `Verify:` commands themselves** — a ticket whose four ACs are
all instant greps and one whose four ACs include a slow container-based test suite are scored
identically as long as file/AC/LOC counts match.

Two compounding misses:
1. The keyword bonus checks for the exact word `migrate` (`\bmigrate\b`); the ticket's AC text says
   `pnpm test:migration`, which does not match that word boundary — so even the keyword heuristic
   would not have caught this shape by accident.
2. This session additionally applied `state.flags.tier_cap_override.medium.worker_timeout_seconds =
   1800` (half the compiled 3600s default) — an operator/session-level choice that compounds the
   problem but is NOT the root cause: forensics showed each of the 6 spawns actually completed in
   2-5 minutes, nowhere near either the 1800s or the 3600s ceiling. The tickets were never timing
   out — see R-HNCG for the real mechanism behind the repeated churn. This finding is about budget
   *sizing*, a separate, real gap regardless of what actually caused this specific ticket's spawn
   count.

## Impact

Any ticket whose acceptance criteria bundle a slow verification command (container-based
migration/e2e suites, full builds, etc.) is under-recognized by the tier classifier and refinement
process — sized the same as a ticket with only cheap checks. This doesn't cause incorrect ticket
dispositions (the recovery ladder already salvages real work), but it means "expensive-to-verify"
tickets are structurally invisible to the one part of the system whose whole job is to size tickets
correctly.

## Fix direction (subtract-before-add)

Reuse, don't add a parallel signal: `classifyTicketTier`'s `acCount`/keyword inputs are already
derived from ticket text during refinement (`/pickle-refine-prd`) — extend the existing
keyword/dimension extraction to recognize known-expensive verify-command shapes (`test:migration`,
`test:e2e`, `docker`, `testcontainers`, etc.) already present in the ticket's own
`## Acceptance Criteria` / `## Test Expectations` verify commands, and bump tier (or specifically
`worker_timeout_seconds`) accordingly — no new state field, no new gate, just a richer classification
input already sourced from data the ticket already carries.

## Acceptance criteria (for the eventual fix)

- [ ] `classifyTicketTier` (or its caller during refinement) detects at least one class of known-expensive
      verify command in a ticket's ACs and produces a tier/timeout that accounts for it — proven by a
      unit test fixture matching this ticket's shape (4 ACs, one `test:migration`-class verify).
- [ ] No new state field, gate, or flag — reuses existing tier/timeout resolution
      (`getTicketTierBudgetWithOverrides`).
- [ ] Existing classifier tests (`ticket-tier.test.js`, `classify-ticket-tier.test.js`) remain green
      with only additive fixtures.
