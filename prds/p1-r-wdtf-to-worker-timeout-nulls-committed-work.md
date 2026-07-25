---
title: "R-WDTF-TO — a worker timeout must not erase committed git work"
priority: P1
finding: R-WDTF-TO
composes: []
status: ready
type: bug-fix-bundle
schema_neutral: true
self_modifying_recovery: true   # edits persistWorkerOutcomeStatus (R-PSRB completion-evidence path) + reuses evaluateFailedFlipSuppression; pipelined + attended per B-RASO, NOT hand-built
target_version: v2.1.0
branch: release/v2.1-beta
source_assessment: "Reliability review 2026-07-25 regrounded the ledger: the RELIABILITY-INVENTORY Tier-2-C leak was MIS-TRACKED as shipped (B-WDSUB subtracted the tokenPresent/ANALYSIS_DONE conjuncts, NOT the timeout conjunct). Grep-verified still-live at HEAD 4ed6e945. Highest-frequency historical leak; bites target repos; subtractive fix reusing an existing guard."
---

# R-WDTF-TO — the timeout proxy must not outrank committed git work

## The single leak (reliability inventory Tier-2-C)

`git working-tree state is the sole authority on whether a ticket's work is complete.` A worker that
**committed gate-green work and then blew its wall-clock budget** (often *during* the `test:fast` gate)
has its committed SHA erased with **zero git probe**. This is the inventory's highest-frequency
historical leak — the root of the entire "recover a timed-out worker's committed work" recovery-recipe
family ([[feedback_commit_before_respawn]], [[project_spawn_morty_false_failed_over_completed_work]]).

**Not fixed by B-WDSUB.** B-WDSUB subtracted the *narrative-token* conjuncts (`tokenPresent`,
`ANALYSIS_DONE`). The **timeout** conjunct is a separate blinder and is still live.

## The defect — grounded at HEAD (`4ed6e945`)

`evaluateWorkerOutcome` (`bin/spawn-morty.ts`):

```ts
const hasEdits = checkGitEdits(ctx.sessionWorkingDir, Math.floor(startTime / 1000)); // the GIT signal
const isSuccess = !ctx.mutableState.timedOut && hasArtifact && (logNonTrivial || hasEdits);
//                ^^^^^^^^^^^^^^^^^^^^^^^^^^ wall-clock PROXY AND-gates the git signal
```

A timed-out worker → `isSuccess === false` **regardless of `hasEdits`**. In `runWorkerProcess` the
`if (isSuccess) { … runWorkerGate … evaluateFailedFlipSuppression … }` block is then **skipped
entirely**, so the timeout path **never reaches** the git-consultation guard
`evaluateFailedFlipSuppression` — which today is wired **only** inside the worker-gate-fail branch
(`spawn-morty.ts` ~`:1854`, `callsite: 'worker_gate_fail'`). The downstream
`persistWorkerOutcomeStatus` then writes `updateTicketFrontmatter(…, { status: 'Failed',
completion_commit: null })` — erasing a real, reachable, ticket-scoped commit.

**The guard already exists and already does the right thing** for the gate-fail branch: on evidence of
real work (fresh artifacts OR a ticket-scoped commit in the worker window) it returns
`action: 'suppress' | 'escalate'` and the gate-fail branch preserves the SHA + frontmatter status
(comment `7eb9fa20`: *"gate-fail reset and Failed flip suppressed … work preserved for triage"*). The
gap is purely that the **timeout / no-artifact** flip does not consult it.

## The fix — reuse the existing guard on the timeout path (no new machinery)

Route the `persistWorkerOutcomeStatus` Failed-flip through the **existing**
`evaluateFailedFlipSuppression` before it nulls the commit — the same call the gate-fail branch already
makes, with a distinct `callsite` (e.g. `'worker_outcome_no_success'`). When it returns
`suppress`/`escalate` (committed work found in the worker window):
- do **NOT** write `completion_commit: null`,
- do **NOT** flip `status: 'Failed'` (leave the ticket's frontmatter status runnable — the worker still
  exits non-zero, and the manager-side non-runnable hold parks it for triage, identical to the gate-fail
  path).

The `!timedOut` conjunct in `isSuccess` **may stay** (a timed-out run is legitimately non-successful —
it did not finish); what must change is the *consequence*: nulling the SHA / flipping Failed must consult
git first. Evidence-check errors **fail open** to today's behavior (matches the gate-fail branch).

## Acceptance Criteria

- [ ] AC-WDTFTO-1: a worker that **timed out** but left a ticket-scoped commit in its window → `evaluateFailedFlipSuppression(callsite:'worker_outcome_no_success')` returns `suppress`/`escalate`; the ticket's `completion_commit` is **NOT** nulled and `status` is **NOT** flipped to `Failed` — Verify: `npm run test:fast -- extension/tests/<new>-worker-timeout-preserves-commit.test.js` — Type: test
- [ ] AC-WDTFTO-2: a worker that timed out with **no commit and no artifact** still flips `Failed` (no false-preserve; the leak's negative path survives) — Type: test
- [ ] AC-WDTFTO-3: the git-consultation guard is **reused, not reimplemented** — the timeout path calls the same `evaluateFailedFlipSuppression` symbol as the gate-fail branch (grep shows exactly one definition; ≥2 callsites) — Verify: `grep -c 'function evaluateFailedFlipSuppression' extension/src/bin/mux-runner.ts` returns 1 — Type: lint
- [ ] AC-WDTFTO-4: evidence-check error **fails open** to the pre-fix flip (no new hard-fail surface) — Type: test
- [ ] AC-WDTFTO-5: the gate-fail branch's existing suppression behavior is **unchanged** (no regression to `callsite:'worker_gate_fail'`) — Verify: `npm run test:fast -- extension/tests/spawn-morty-worker-gate.test.js` — Type: test
- [ ] AC-WDTFTO-6: type + lint clean, compiled mirror regenerated — Verify: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && git diff --exit-code extension/bin/spawn-morty.js` — Type: typecheck

## Interface Contracts

**Reused:** `evaluateFailedFlipSuppression(args: { sessionDir, statePath, ticketId, workingDir, iteration, callsite, windowStartMs, windowEndMs, preSha, log }) → { action: 'suppress' | 'escalate' | 'flip' | … }`. **New callsite value only** — no signature change. **Inputs on the timeout path:** the worker window is `windowStartMs = spawnTsMs`, `windowEndMs = Date.now()`, `preSha = preWorkerHead` (identical to the gate-fail call). **Invariant:** a `Failed` flip / `completion_commit: null` write is emitted only after the guard returns non-suppress.

## Non-Goals

- **No new machinery** — no new git-probe helper, no new state field, no new predicate. Reuse `evaluateFailedFlipSuppression` verbatim.
- **`evaluateFailedFlipSuppression` internals are NOT edited** (it lives on the mux-runner side; this bundle only adds a callsite from spawn-morty).
- **The `!timedOut` conjunct in `isSuccess` is NOT required to change** — the run stays non-successful; only the destructive consequence is git-gated.
- Inventory Tier-3-F (`executeBoundedEscape`), Tier-1-B (`readEvidence` residual), and the fail-OPEN branches (Tier-3-G) are **out of scope** — separate findings.

## Simplification Review (subtract-before-add)

1. **Adds no mechanism.** The only addition is a second **callsite** of an existing function; the behavior it triggers (suppress the flip, preserve the SHA) already exists. The net effect is *removing* the timeout proxy's authority to erase git-committed work.
2. **REUSE:** `evaluateFailedFlipSuppression` — the exact guard the gate-fail branch already uses. Named, not rebuilt (AC-WDTFTO-3 enforces one definition).
3. **The brittle thing subtracted:** a wall-clock proxy outranking a reachable git commit. The fix removes that authority rather than wrapping it in a new guard.
4. **Net shape:** ~neutral LOC (one guarded callsite), net-negative *brittleness* — one fewer proxy-erases-git site. Retires a whole recovery-recipe family.

## Risks

- **Self-modifying-recovery:** edits `persistWorkerOutcomeStatus` (R-PSRB completion-evidence path). The run executes DEPLOYED (pre-fix) JS, so a timed-out worker building this fix could itself have work erased — budget one intervention, recover with the documented recipe (verify ground truth → commit before relaunch → `setup --resume` → relaunch). Pipelined + attended, NOT hand-built ([[feedback_never_hand_build_always_pipeline]]).
- **Over-preserve:** if the suppression check were too lax it could preserve a genuinely-failed ticket. Bounded — it requires a ticket-scoped commit in the worker window (the same bar the gate-fail branch already trusts), and AC-WDTFTO-2 pins the no-commit negative path.

## Build-time reminders

- Branch `release/v2.1-beta`, baseline = the beta.6 release commit.
- **Compiled-mirror co-scoping MANDATORY** — `extension/bin/spawn-morty.js` IS the deployed runtime; the ticket allowlist names both `src/bin/spawn-morty.ts` and `bin/spawn-morty.js`.
- Re-anchor on symbols (`evaluateWorkerOutcome`, `persistWorkerOutcomeStatus`, `evaluateFailedFlipSuppression`), not line numbers.
- Launch via refine→pipeline.
