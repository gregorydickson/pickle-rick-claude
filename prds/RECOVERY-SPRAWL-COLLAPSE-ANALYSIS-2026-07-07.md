# Recovery-Sprawl Collapse Analysis (2026-07-07)

**The B-GSUB functional residual — the 5th and last structural meta-defect ("recovery sprawl").**
Produced by a 4-agent read-only analysis of the recovery/disposition surface (`mux-runner.ts` +
`salvage-ticket.ts` / `reconcile-ticket-truth.ts` / `manager-relaunch.ts` / `ticket-completion-evidence.ts`
/ `circuit-breaker.ts` / `pickle-utils.ts` hardening resolvers). Verified against HEAD `0dc0d6b4`.

## The map (four angles, one picture)

- **~50 distinct disposition branches** govern what happens after a worker spawn/exit (Agent A): ff-reattach,
  Failed-flip (+suppress/escalate), salvage (commit/archive/no-op), silent-death (hold/respawn/halt),
  timeout, circuit-breaker, manager-relaunch, codex-no-progress, bounded-escape, recovery-ladder,
  idle-stall, phantom-Done, EPIC-completion, closer-handoff, rate-limit park, worker-gate-verdict, WMW.
- **~38 of the guards** sit on the *manager-loop-continuation* decision (Agent D) — the biggest guard cluster.
- **The bookkeeping is ONE ledger + inconsistent plumbing** (Agent C): three strategies
  (`bounded_terminal_escape` / `silent_death_respawn` / `failed_flip_suppressed`) already share
  `state.recovery_attempts[]`, but their caps come from three different places.
- **The completion seam is already collapsed** (Agent B): all 15 live Done-flip/phantom-revert/salvage
  sites route through the single `evaluateCompletionEvidence` predicate (B-1SEAM). `salvage-ticket.ts`
  carries zero independent completion-truth logic.

## The load-bearing lesson (this REPEATS B-GSUB's original finding)

**The biggest guard cluster (D's ~38 manager-loop guards) is NOT a mechanical collapse target.** Agent A
proves those guards sit on *distinct detection signals* — worker wall-clock timeout vs.
no-progress-across-N-iterations vs. zero-CPU idle-stall vs. artifact-zero-delta vs. codex pending-count
stagnation — that already funnel into *shared* termination plumbing (`routeRecoveryBeforeTerminal` /
`executeTimeoutHalt` / `safeDeactivate`). The detection logic is earned, not duplicated. Wholesale
"collapse the loop decision" would be exactly the mistake B-GSUB warned against (the 2026-06-18 inventory
overstated free subtraction 3–5×). **So the guard-density metric points at a false target; the real value
is in the small, bounded divergences below.**

## Ranked collapse candidates

### ★ C1 — Recovery attributable-work single oracle (B-RASO) — TIER 1, correctness-bearing
Two independent "is there salvageable work for this ticket?" detectors exist with **divergent strictness**:
- `detectSilentDeathAttributableWork` (`mux-runner.ts:8117`) → `hasFrontmatterCompletionSha:8067` —
  regex-validates the sha *format only*, **never verifies it resolves to a real git commit**.
- `detectFailedFlipEvidence` (`mux-runner.ts:8353`) → `hasVerifiedFrontmatterCompletionSha:8291` —
  regex-validates **and** `git cat-file -t` verifies the sha is a real commit, plus a `signal_committed` arm.

Same underlying question, two strictness levels → the silent-death path can **HOLD (suppress a respawn) on a
garbage/hallucinated sha** the failed-flip path would correctly reject. This is a **latent false-hold bug**,
not just sprawl. Collapse to one `resolveAttributableWorkEvidence(...)` helper (verified-sha + scoped-commit
+ fresh-artifact + optional signal arms) consumed by both `applySilentDeathRecoveryPolicy` and
`evaluateFailedFlipSuppression`. This is the B-1SEAM pattern one level down: B-1SEAM unified "is this ticket
DONE"; this unifies "is there SALVAGEABLE WORK" — the sibling question recovery paths ask.
- **Value:** HIGH (fixes a real strictness divergence + collapses a seam + dissolves its guards).
- **Risk:** ⚠️ **R-PSRB HAND-BUILD** — both consumers sit on the silent-death/Failed-flip → Done-flip/salvage
  boundary (the deployed buggy runtime applies this logic to the worker building the fix).
- **Effort:** medium (one helper + two consumers + strictness reconciliation + tests).

### C2 — Delete the dead manager-relaunch overload + resolver-plumbing consistency (B-RRPC) — TIER 1/2, pipeline-safe subtraction
- **Dead overload:** `evaluateSimpleManagerRelaunch` (boolean form, `manager-relaunch.ts:171-195`) has **zero
  production callers** — every one of the 7 live sites uses `evaluateTicketManagerRelaunch`. Kept alive only by
  tests pinning an unused shape. **Delete it + its tests** (pure subtraction).
- **Duplicate resolver:** `resolveBreakerRecoveryGraceSeconds` (`mux-runner.ts:7619`) is a hand-duplicated
  resolver for `hardening.breaker_recovery_grace_seconds` — a field of the *same* `hardening:` JSON block
  `resolveHardeningSettings` (`pickle-utils.ts:758`) already reads. Fold it in (consumer `isWithinBreakerRecoveryGrace`
  unchanged). A documented irregularity in `extension/CLAUDE.md`.
- **Also:** `BOUNDED_ESCAPE_CAP` (`mux-runner.ts:5897`) is a bare hardcoded const while its two ledger siblings
  are settings-tunable — move it onto `hardening.bounded_terminal_escape_cap` for uniformity.
- **Value:** MEDIUM (delete dead code, collapse a duplicate resolver, config uniformity).
- **Risk:** LOW — resolver-layer only; does NOT touch the salvage path itself. **Pipeline-safe.**
- **Effort:** small.

### C3 — Completion-seam hygiene (B-CSHYG) — TIER 2, pipeline-safe
Agent B's two residuals of the (otherwise complete) completion collapse:
- `salvageCleanTree`'s `backfillDone` dep (`lib/salvage-ticket.ts:141`) is **never wired in production** — no
  caller passes `completionCommitSha`/`backfillDone`, so the documented `committed-done` clean-tree disposition
  is permanently dead (fails safe, but drifted from its own docstring + trap door). Either wire
  `attributeBoundaryHeadMoved`'s result through, or delete the branch + reconcile the docs.
- `pickle-utils.ts:hasCommitReferencingTicketSince`/`findMatchingCommit` (`~1103-1165`) is an **orphaned
  duplicate git-log ticket-attribution scanner with zero callers** → delete (a "second implementation of the
  same judgment" a future edit could accidentally re-wire past the seam).
- **Value:** MEDIUM (delete dead code + close doc drift). **Risk:** LOW, pipeline-safe. **Effort:** small.

### DEFER — the two big/operator-scoped items
- **Manager-loop-continuation decision unification (D's #1, ~38 guards):** DEFER. The guards are earned
  (distinct detection signals). If ever pursued, scope it to unifying only the *disposition dispatch*, NOT the
  detection — operator sign-off + R-PSRB. Do not chase the guard count.
- **Dead-pid/orphan liveness-probe unification (D's #3, ~13 guards):** three ownership-probe implementations
  (`orphan-reaper.ts` R-CXHANG, R-OMTD subtree reap, R-PTSB/R-POD demotion) could fold to one positive-ownership
  liveness probe. Medium value (the `killProcessGroup` primitive is already shared; only *detection* is
  triplicated). Revisit after C1–C3.

## Must-survive (do NOT collapse — high-recurrence, earned)
`evaluateCompletionEvidence` (B-1SEAM WS-1) · `salvageTicket`/`reconcileTicketTruth` · `dirty-tree-salvage`
(B-1SEAM WS-3, no whole-tree `add -A`) · the boundary HEAD-moved/static trichotomy (AC-DURA-8) · the three
distinct stall detectors (timeout / breaker / idle-stall) · worker-gate-verdict fail-closed (R-CWGE) ·
R-WSRC-1/2/GR (schema-ahead + git-verb block) · un-terminalize single-path · AC-D4 completion-authority
single-source · R-CNAR-2/4 (foreground-only auto-resume + stop conditions) · R-CIFB-A/B (dead-pid mtime tie-break)
· `rate_limit_park` kept separate by design (429-poison guard) · bounded-escape vs codex-ladder (parallel by design).

## Recommended sequence
1. **B-RRPC + B-CSHYG first** (one pipeline-safe subtraction bundle — dead code + resolver consistency + seam
   hygiene; near-zero risk, dogfoodable). 2. **B-RASO** (the correctness-bearing collapse; R-PSRB hand-build; the
   real win). 3. Defer the two big items to operator-scoped follow-ups.

This closes the B-GSUB functional residual as **mapped and ranked** — the honest yield is one correctness fix
(B-RASO) + two small subtraction bundles, NOT a sweeping manager-loop collapse (which the guard density falsely
suggested and A/D jointly disproved).
