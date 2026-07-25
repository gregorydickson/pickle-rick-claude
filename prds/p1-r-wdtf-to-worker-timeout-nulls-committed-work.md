---
title: "R-WDTF-TO — a worker timeout must not erase committed git work"
priority: P1
finding: R-WDTF-TO
composes: []
status: ready
type: bug-fix-bundle
schema_neutral: true
self_modifying_recovery: true
target_version: v2.1.0
branch: release/v2.1-beta
source_assessment: "Reliability review 2026-07-25 (inventory Tier-2-C, mis-tracked as shipped). Refinement 2026-07-25 REJECTED the original evaluateFailedFlipSuppression route and reshaped to the subtractive route + auto-promote guard — see §0."
---

# R-WDTF-TO — the timeout proxy must not outrank committed git work

## §0 — AUTHOR'S RETRACTION (what refinement corrected)

The original PRD proposed routing the timeout Failed-flip through `evaluateFailedFlipSuppression`. All three
analysts, grep-verified at HEAD `a56c9e85`, converged on rejecting that and on a cleaner subtractive route.

| # | Original premise | Verdict | Correction (build follows THIS) |
|---|---|---|---|
| R1 | "Route the timeout flip through `evaluateFailedFlipSuppression` (reuse the guard)." | **REJECTED.** Suppression skips the frontmatter write, imposing a `readActiveFailedFlipHolds` park excluded from **both** selection sites (`mux-runner.ts:1144`, `:1182`), released only momentarily and **self-revoking**: `refundRecoveryBudgetOnReset` (`:6122`) refunds only `BOUNDED_ESCAPE_STRATEGY`/`outcome:'failed'`, never the suppression entry, so "reset to Todo + relaunch" buys exactly ONE spawn then re-parks. Every terminal reachable from a permanent hold (`manager_persistent_hallucination`/`recovery_exhausted`/`iteration_cap_exhausted`) is a **failure exit** (`:4422-4424`) that **stops auto-resume** — converting a single-ticket data-loss bug into a session-level halt of unattended operation. | **Subtractive route:** keep the `Failed` flip (a timed-out run genuinely did not finish; `Failed` stays **selectable** via `isPendingMuxTicket` → preserves liveness, no halt), and **stop writing `completion_commit: null`** — reuse `reconcileWorkerCommitAttribution` to probe the worker window and write the ticket-scoped SHA; absent a commit, leave the field untouched. Do NOT route through suppression. |
| R2 | (implicit) "preserving the SHA is safe." | **HAZARD — verified.** A `completion_commit` present on a `Failed` timeout ticket auto-promotes to **terminal `Done`** on the next `setup.js --resume`: `tryResumeOrphanReattach` (`setup.ts:1284`) ff-reattaches an orphaned window commit and flips `status:'Done'` (`:1322`) whenever `resolveWorkerGateVerdict(...).verdict === 'green'` (`:1314`) — **with no check of the current status** (grep confirmed). On a timeout the verdict is `absent` and `resolveWorkerGateVerdict` **recomputes** it via `recomputeAbsentWorkerGateVerdict` = **eslint+tsc only (test:fast excluded, R-WGFR)**. Since timeouts land *during* test:fast, the stamp would ship **unverified work as terminal Done, bypassing every later gate** — inverting the bundle's value on the dominant path. | **Close it in-bundle (WS-2):** add a clause to `tryResumeOrphanReattach`'s existing fail-closed guard so a **recomputed** (test:fast-excluded) green verdict does NOT authorize the terminal Done. Leave the reattached ticket at `Failed` (commit preserved, selectable) so the runner re-runs the full lifecycle including test:fast. |
| R3 | ACs simulate a timeout at sub-second budgets. | **Possibly unbuildable** — the minimum real worker timeout is 300s; the only sub-second lever is `state.flags.tier_cap_override.<tier>.worker_timeout_seconds`. | ACs name that lever (or unit-test `evaluateWorkerOutcome`/`persistWorkerOutcomeStatus` directly with a synthesized `timedOut:true` ctx, avoiding a real wall-clock wait). |
| R4 | "Blocking pre-adoption check: does anything pin `Failed ⇒ completion_commit:null`?" | **CLEARED (verified 4 ways).** No release-gate audit pins it; `audit-trap-door-enforcement.sh` has zero matches; the AC-D4 scanner's `TERMINAL_STATUS_WRITE_RE` spares `status:'Failed'` **by design** and ships a false-positive **decoy** at `tests/completion-authority-single-source.test.js:226`; `git-utils.ts:114` early-returns before the `completion_commit_inferred` clear when the SHA is non-null. `spawn-morty.ts` is already on the AC-D4 allowlist. | The subtractive write is legal. No AC-D4 change needed. |

---

# TRACK A — the fix (ordered: WS-2 guard first, then WS-1 stamp)

## WS-2 — close the resume-time auto-promote (guard first, standalone-safe)

`tryResumeOrphanReattach` (`bin/setup.ts`) flips a reattached ticket to terminal `Done` on
`resolveWorkerGateVerdict(...).verdict === 'green'` (`:1314`) regardless of current status. The verdict may
be **recomputed** from eslint+tsc only (test:fast excluded) via `recomputeAbsentWorkerGateVerdict`. Add a
clause to the existing fail-closed guard: a verdict whose `computedVia` indicates it was **recomputed**
(not a persisted verdict from a real worker-gate run that included the tier's test gate) MUST NOT authorize
the terminal `Done` flip — leave the ticket at its current status (selectable), log the reason. This is a
tightening of an existing guard, no new machinery, and is safe to land independently.

| AC | Assertion |
|---|---|
| AC-WDTFTO-2-1 | `tryResumeOrphanReattach` on a ticket whose `worker_gate_verdict` was **recomputed** (eslint+tsc-only, `computedVia` = the recompute value read from `resolveWorkerGateVerdict`'s return) leaves `status` **non-`Done`** and preserves the reattached `completion_commit` — Verify: `npm run test:fast -- extension/tests/<new>-resume-reattach-recomputed-verdict.test.js` — Type: test |
| AC-WDTFTO-2-2 | a ticket with a **persisted** green verdict from a real gate run still flips `Done` (no regression to the legitimate reattach) — Type: test |
| AC-WDTFTO-2-3 | type + lint clean; compiled mirror `bin/setup.js` regenerated — Verify: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && git diff --exit-code extension/bin/setup.js` — Type: typecheck |

## WS-1 — stop the timeout flip from erasing the SHA (subtractive stamp)

`persistWorkerOutcomeStatus` (`bin/spawn-morty.ts:2072`) writes `{ status:'Failed', completion_commit: null }`
on the non-success path with zero git probe. Replace the `null` write: call the existing
`reconcileWorkerCommitAttribution` (`:2039` — probes the worker window `windowShas` → `pickAttributionCommit`
→ verified ticket-scoped SHA) and, if it returns a SHA, write `{ status:'Failed', completion_commit: <sha> }`;
if it returns `null` (no commit), write `{ status:'Failed' }` leaving `completion_commit` untouched. Keep the
`Failed` flip. Do NOT route through `evaluateFailedFlipSuppression`. The `!timedOut` conjunct in
`evaluateWorkerOutcome`'s `isSuccess` may remain (the run is legitimately non-successful) — only the
destructive `null` write is removed.

| AC | Assertion |
|---|---|
| AC-WDTFTO-1-1 | a timed-out worker with a ticket-scoped commit in its window → `persistWorkerOutcomeStatus` writes `status:'Failed'` with `completion_commit === <the window SHA>` (NOT null). Simulate via a synthesized `timedOut:true` ctx (or `state.flags.tier_cap_override.<tier>.worker_timeout_seconds`), not a real wall-clock wait — Verify: `npm run test:fast -- extension/tests/<new>-worker-timeout-preserves-commit.test.js` — Type: test |
| AC-WDTFTO-1-2 | a timed-out worker with **no** commit → writes `status:'Failed'` and does NOT invent a `completion_commit` (field untouched/absent) — Type: test |
| AC-WDTFTO-1-3 | the ticket remains **selectable** after the flip (`isPendingMuxTicket` true for `Failed`) — no session halt — Type: test |
| AC-WDTFTO-1-4 | end-to-end (guard from WS-2 present): a preserved-SHA `Failed` timeout ticket is NOT auto-promoted to `Done` on `--resume` when the verdict is recomputed (test:fast never ran) — Type: test |
| AC-WDTFTO-1-5 | `evaluateFailedFlipSuppression` is NOT called from the timeout path — Verify: `git diff <base>..HEAD -- extension/src/bin/spawn-morty.ts` shows no new `evaluateFailedFlipSuppression` callsite — Type: lint |
| AC-WDTFTO-1-6 | type + lint clean; compiled mirror `bin/spawn-morty.js` regenerated — Type: typecheck |

## Non-Goals
- `evaluateFailedFlipSuppression` is NOT edited and NOT newly called (the rejected route). `FailedFlipCallsite` untouched.
- The `!timedOut` conjunct in `evaluateWorkerOutcome` is NOT required to change — only the `null` write is removed.
- No AC-D4 / `completion-authority-single-source` change (the scanner spares `Failed` by design).
- Inventory Tier-3-F (`executeBoundedEscape`), Tier-1-B (`readEvidence`), Tier-3-G (fail-open) — separate findings.

## Simplification Review (subtract-before-add)
1. **WS-1 removes a destructive write** (the `null` erasure) and REUSES `reconcileWorkerCommitAttribution` (the attribution helper the inventory calls "done right") — no new probe. WS-2 adds one clause to an existing fail-closed guard — no new mechanism.
2. **REUSE:** `reconcileWorkerCommitAttribution` (WS-1); the existing `tryResumeOrphanReattach` fail-closed guard + `resolveWorkerGateVerdict.computedVia` (WS-2).
3. **Brittle thing subtracted:** a wall-clock proxy erasing a reachable git commit (WS-1); an eslint+tsc-only proxy authorizing terminal Done over an unrun test tier (WS-2). Both remove a proxy's authority over git/gate ground truth.
4. **Net shape:** WS-1 net-negative (deletes the null write). WS-2 net-neutral (one guard clause). No new state field, no new predicate, no suppression callsite.

## Risks
- **Self-modifying-recovery:** edits `persistWorkerOutcomeStatus` (R-PSRB completion-evidence path). Runs on DEPLOYED beta.6 JS — the `done_without_commit_evidence` wedge is now fixed (WS-A2 deployed), but R-WDTF-TO's OWN leak (timeout nulls committed work) is still live until this ships, so a timed-out worker building this fix could still have work erased. Budget one intervention; recover with the documented recipe. Pipelined + attended, NOT hand-built.
- **Ordering:** WS-2 (guard) must land before/with WS-1 (stamp) — a stamped SHA without the guard ships the auto-promote hazard. Within one bundle/release this is guaranteed (deploy is at install.sh after the whole bundle); ticket order = WS-2 (10) → WS-1 (20).
- **Over-preserve:** WS-1 writes a SHA only when `reconcileWorkerCommitAttribution` verifies a ticket-scoped window commit (the same bar the gate-fail branch trusts). AC-WDTFTO-1-2 pins the no-commit negative path.

## Build-time reminders
- Branch `release/v2.1-beta`, baseline = beta.6 (`165a1a43`) + doc commits.
- **Compiled-mirror co-scoping MANDATORY** — ticket allowlists name both `src/bin/{spawn-morty,setup}.ts` and `bin/{spawn-morty,setup}.js`.
- Re-anchor on symbols (`persistWorkerOutcomeStatus`, `reconcileWorkerCommitAttribution`, `tryResumeOrphanReattach`, `resolveWorkerGateVerdict`).
- Order WS-2 before WS-1. Launch `--szechuan-max-iterations 500 --anatomy-max-iterations 500`.

## Implementation Task Breakdown

| Order | ID | Title | Tier | Entry | Exit |
|---|---|---|---|---|---|
| 10 | 47ddf936 | WS-2 guard: no auto-Done on recomputed verdict (`setup.ts`) | medium | green @beta.6 | recomputed verdict can't terminal-Done a reattach |
| 20 | 4404d032 | WS-1 stamp: stop nulling SHA, reuse `reconcileWorkerCommitAttribution` (`spawn-morty.ts`) | medium | 47ddf936 done | timeout preserves SHA, stays Failed-selectable |
| 30 | 89da513d | Harden: code quality | medium | impl done | zero P0-P1 in diff |
| 40 | 33f4960b | Audit: data flow (SHA path end-to-end) | medium | 89da513d done | zero CRITICAL+HIGH |
| 50 | 7af891d4 | Harden: test quality (synthesized timeouts, exact-SHA) | medium | 33f4960b done | every AC mapped |
| 60 | ef394937 | Audit: cross-ref (trap-door docs vs code) | medium | 7af891d4 done | docs match new behavior |

Wiring skipped (≤2 impl tickets).
