# P3 Subtraction Bundle — B-RRPC: recovery resolver-plumbing consistency + dead-overload / orphan-scanner removal (pipeline-safe)

**Priority:** P3 (simplification / subtract-before-add — the pipeline-safe half of the B-GSUB recovery-sprawl
residual mapped by `RECOVERY-SPRAWL-COLLAPSE-ANALYSIS-2026-07-07.md`. No reliability regression risk; pure
plumbing consistency + dead-code removal.)
**Code:** B-RRPC (Recovery Resolver-Plumbing Consistency)
**Backend:** claude.
**Build-safety note:** **Pipeline-safe — NOT the R-PSRB salvage/completion/Done-flip path.** Every edit is a
*resolver / config / dead-overload / orphaned-export* change — where a number is read from, or the deletion of
unreachable code. None alters salvage/no-progress *behavior* applied to a running worker (the pipeline executes
DEPLOYED JS; these land at `install.sh`). Explicitly OUT of scope: `lib/salvage-ticket.ts`,
`reconcile-ticket-truth.ts`, `ticket-completion-evidence.ts`, and the mux-runner salvage/no-progress decision
bodies — those are the R-PSRB surface and are handled by the separate **[[B-RASO]]** hand-build.
**Source anchor:** verified against HEAD `29fe2794` (2026-07-07). Refresh line refs before build if HEAD moved.

> **Scope note (verified 2026-07-07):** The recovery-sprawl analysis proposed B-RRPC + B-CSHYG. On source
> verification, **B-CSHYG-a** (the dead `salvageCleanTree` back-fill branch) edits `lib/salvage-ticket.ts` — an
> R-PSRB salvage-path file — so it was moved to the **B-RASO** hand-build (same file, one session). This bundle
> carries the four unambiguously pipeline-safe items only.

---

## Context

The `RECOVERY-SPRAWL-COLLAPSE-ANALYSIS-2026-07-07.md` (4-agent read-only analysis) established that the ~38-guard
manager-loop-continuation cluster is a FALSE mechanical-collapse target (earned distinct detection signals). The
honest yield is a few bounded items. This bundle is the pipeline-safe subset: three plumbing/dead-code
subtractions in `mux-runner.ts` + `manager-relaunch.ts`, plus one verify-before-remove of an orphaned scanner in
`pickle-utils.ts`. All behavior-preserving; the goal is a smaller, flatter recovery surface.

---

## WS-1 — B-RRPC-1: fold `resolveBreakerRecoveryGraceSeconds` into `resolveHardeningSettings`

**complexity_tier: medium** (touches the recovery iteration accounting consumer; must run `test:fast` at the
worker gate — a `small` gate would skip it).

### Problem
`hardening.breaker_recovery_grace_seconds` is a field of the SAME `hardening:` JSON block that
`resolveHardeningSettings` (`services/pickle-utils.ts:758`) already resolves (beside `silent_death_respawn_cap` /
`failed_flip_suppression_cap`), yet it is read by a **second, hand-duplicated resolver**
`resolveBreakerRecoveryGraceSeconds` (`mux-runner.ts:7619`) carrying its own copy of the "absent/malformed →
compiled default, never throw" doctrine. `extension/CLAUDE.md`'s settings table already flags this as a
documented irregularity ("resolved by `resolveBreakerRecoveryGraceSeconds` in `mux-runner.ts` (NOT
`resolveHardeningSettings`)").

### Fix (reuse — collapse two resolvers to one)
1. Add `breaker_recovery_grace_seconds` to the `HardeningSettings` type + `resolveHardeningSettings`
   (`pickle-utils.ts`), with the same compiled default (30) + per-field fallback doctrine the other two hardening
   fields use.
2. Replace the consumer call at `mux-runner.ts:9884` — `resolveBreakerRecoveryGraceSeconds(loadPickleSettingsBag(...))`
   → read the field off the already-resolved `HardeningSettings` (the consumer `isWithinBreakerRecoveryGrace`
   signature is unchanged).
3. DELETE `resolveBreakerRecoveryGraceSeconds` (`mux-runner.ts:7606-7626`) and its now-redundant compiled-default
   const.
4. Update the `extension/CLAUDE.md` settings-table row to remove the "NOT `resolveHardeningSettings`" irregularity
   note (it's now folded in).

### Acceptance criteria (machine-checkable)
- **AC-RRPC-1a** `grep -c "function resolveBreakerRecoveryGraceSeconds" extension/src/bin/mux-runner.ts` → **0** (resolver deleted).
- **AC-RRPC-1b** `grep -c "breaker_recovery_grace_seconds" extension/src/services/pickle-utils.ts` → **≥1** (field now resolved there); `HardeningSettings` type carries the field.
- **AC-RRPC-1c** existing behavior preserved: a test asserts the resolved grace equals the compiled default (30) on an absent/malformed block and the configured value when present (reuse/extend `recovery-controller-foundation.test.js`).
- **AC-RRPC-1d** `extension/CLAUDE.md` no longer contains the "NOT `resolveHardeningSettings`" note for `breaker_recovery_grace_seconds`.
- **AC-RRPC-1e** worker gate green (`tsc --noEmit` + `eslint` + `test:fast`).

### Files
`extension/src/services/pickle-utils.ts`, `extension/src/bin/mux-runner.ts`, `extension/CLAUDE.md`, `extension/tests/recovery-controller-foundation.test.js` (or the hardening-settings test that pins the resolver).

---

## WS-2 — B-RRPC-2: collapse the dead `evaluateManagerRelaunch` boolean overload

**complexity_tier: medium** (manager-relaunch feeds the loop-continuation decision; regression-sensitive → `test:fast`).

### Problem
`evaluateManagerRelaunch` (`services/manager-relaunch.ts:171/176/182`) is a 3-signature overload whose body
dispatches to `evaluateSimpleManagerRelaunch` (boolean `hasPendingWork` form, `:81` → `:189`) or
`evaluateTicketManagerRelaunch` (ticket-array form, `:96` → `:194`). **All 7 production call sites use the
ticket-array form** (verified: `mux-runner.ts` ×6 + `microverse-runner.ts` ×1); the boolean branch has zero
production callers and zero direct test references. It is dead duplication kept alive only by the overload.

### Fix (subtract — the dead branch)
1. **Confirm zero boolean-form callers** first: grep all `evaluateManagerRelaunch(` call sites in `src/` and verify
   none pass the boolean `hasPendingWork` signature. (If ANY does, STOP and keep the branch — record why.)
2. Delete `evaluateSimpleManagerRelaunch` (`:81`), the boolean overload signature, and the `:189` dispatch branch;
   collapse `evaluateManagerRelaunch` to the single ticket-array signature (or inline `evaluateTicketManagerRelaunch`
   if that leaves a trivial passthrough).
3. Delete the now-unused `RelaunchEvaluation` return type / `below_cap|at_cap|wrong_backend|no_pending_work` reason
   union **iff** nothing else references them (grep first).
4. Reconcile any test asserting the old overload shape.

### Acceptance criteria (machine-checkable)
- **AC-RRPC-2a** `grep -c "evaluateSimpleManagerRelaunch" extension/src/` (recursive) → **0**.
- **AC-RRPC-2b** `evaluateManagerRelaunch` has a single signature; all 7 prod call sites compile unchanged (`tsc --noEmit`).
- **AC-RRPC-2c** a test proves the ticket-array relaunch decision still returns the documented reasons (`eligible/no_pending/cap_exceeded/circuit_open/time_limit`) — reuse `manager-relaunch.test.js`.
- **AC-RRPC-2d** worker gate green.

### Files
`extension/src/services/manager-relaunch.ts`, `extension/tests/manager-relaunch.test.js` (+ any test referencing the boolean form; none found at HEAD).

---

## WS-3 — B-RRPC-3: settings-ize `BOUNDED_ESCAPE_CAP`

**complexity_tier: small** (single const → resolver field; no behavior change at the default).

### Problem
`BOUNDED_ESCAPE_CAP = 3` (`mux-runner.ts:5897`) is a bare hardcoded const, while its two ledger siblings
(`silent_death_respawn_cap`, `failed_flip_suppression_cap`) are operator-tunable via `hardening.*`. Operators can
tune two of the three recovery-ladder rungs but not the third — an inconsistency, not a feature.

### Fix (uniformity — same doctrine as its siblings)
1. Add `bounded_terminal_escape_cap` to `HardeningSettings` + `resolveHardeningSettings` (default 3, non-negative-int
   per-field fallback — identical shape to the other two caps).
2. Thread the resolved value into `evaluateBoundedEscape` (`mux-runner.ts:5931`, currently `cap = BOUNDED_ESCAPE_CAP`)
   at its call site, keeping the compiled default 3 so behavior is unchanged when unconfigured.
3. Keep `BOUNDED_ESCAPE_CAP = 3` only as the compiled-default constant referenced by the resolver (or inline it into
   the resolver default), and update the two log lines (`:6100`, `:10909`) to read the resolved value.

### Acceptance criteria (machine-checkable)
- **AC-RRPC-3a** `grep -c "bounded_terminal_escape_cap" extension/src/services/pickle-utils.ts` → **≥1** (field resolved).
- **AC-RRPC-3b** default unchanged: with no `hardening.bounded_terminal_escape_cap` set, `evaluateBoundedEscape` uses cap 3 (test asserts default + a configured override, e.g. 2).
- **AC-RRPC-3c** worker gate green.

### Files
`extension/src/services/pickle-utils.ts`, `extension/src/bin/mux-runner.ts`, `extension/tests/recovery-controller-foundation.test.js`.

---

## WS-4 — B-CSHYG-b: verify-before-remove the orphaned attribution scanner

**complexity_tier: medium** (5 test references incl. the completion-commit characterization suite → verify carefully).

### Problem
`hasCommitReferencingTicketSince` + its helper `findMatchingCommit` (`services/pickle-utils.ts:1103-1165`) is a
second, independent git-log ticket-attribution scanner sitting alongside `ticket-completion-evidence.ts`'s own
`scanGitLog`. It has **zero runtime callers** in `src/` (verified) — but **5 test references**
(`mux-runner.test.js`, `has-completion-commit-explicit-source.test.js`, and the `completion-commit-cluster`
characterization path-6/path-7 + `decision-matrix.json`) and is listed in the `services/CLAUDE.md` export catalog.
It's the "second implementation of the same judgment" a future edit could accidentally re-wire past the seam.

### Fix (verify-before-remove — B-GSUB WS4 discipline; this may end as "leave it, documented")
1. **Verify genuinely dead:** grep every `src/` path for a runtime call to `hasCommitReferencingTicketSince` /
   `findMatchingCommit`. Confirm the 5 test references are direct unit/characterization tests of the function
   itself (not runtime behavior that flows through it).
2. **If genuinely unreachable at runtime:** delete both functions, remove the `services/CLAUDE.md` export-catalog
   entry (or the subsystem-audit flags drift), and delete/repoint the 5 test references. If a characterization test
   (`path-6`/`path-7`) documents behavior that is actually produced by the LIVE phantom-Done watcher (via
   `evaluateCompletionEvidence`, not this scanner), repoint it to the live path; if it only exercised this dead
   function, delete that test case.
3. **If ANY runtime path reaches it, or a characterization test encodes it as expected live behavior:** LEAVE the
   function in place and record "not free to remove — [reason]" in the ticket exit state (honest non-removal, per
   B-GSUB's verify-before-remove doctrine — do NOT force the deletion).

### Acceptance criteria (machine-checkable)
- **AC-RRPC-4a** EITHER: `grep -rc "hasCommitReferencingTicketSince\|findMatchingCommit" extension/src/ extension/tests/` → **0** and the `services/CLAUDE.md` catalog line is removed; OR: the ticket exit-state records a concrete reason the function is load-bearing and it is left untouched (both outcomes are acceptable — this is verify-before-remove).
- **AC-RRPC-4b** if deleted: the subsystem export-catalog audit (`audit-*` / `check-wired`) is green (no export-drift).
- **AC-RRPC-4c** worker gate green + full audit set green.

### Files (if removed)
`extension/src/services/pickle-utils.ts`, `extension/src/services/CLAUDE.md`, and the 5 test files referencing the scanner.

---

## Simplification Review (subtract-before-add)
1. **Necessary?** Every WS is pure subtraction/consolidation — no new runtime code, gate, or state field. WS-1/WS-3
   add resolver *fields* (config surface), not machinery; WS-2/WS-4 delete code.
2. **Reuse not add?** WS-1 folds a duplicate resolver into the EXISTING `resolveHardeningSettings`; WS-3 reuses its
   per-field-fallback doctrine; WS-2 collapses onto the one live overload form; WS-4 removes a duplicate of the
   existing `scanGitLog` judgment. Nothing new is built.
3. **Guards brittle complexity?** It REMOVES a duplicate resolver, a dead overload branch, and (conditionally) an
   orphaned scanner — the opposite of guarding.
4. **Subtract?** Yes: −1 resolver (WS-1), −1 overload branch + helper + possibly a reason-union (WS-2), and −2
   functions + catalog entry (WS-4, if verified dead). WS-3 is uniformity (net-neutral LOC, removes an
   inconsistency). Behavior-preserving throughout.

## Non-goals / out of scope
- **B-CSHYG-a** (dead `salvageCleanTree` back-fill branch in `lib/salvage-ticket.ts`) → moved to the **[[B-RASO]]**
  R-PSRB hand-build (same salvage-path file).
- The ~38-guard manager-loop-continuation "collapse" — DEFERRED (earned distinct signals; not a mechanical target).
- The dead-pid/orphan liveness-probe unification — DEFERRED (revisit after this bundle).
- Changing ANY recovery *behavior* (caps, grace windows, escalation) — this bundle only changes where values are
  read from, never their compiled defaults.

## Build / verify
Build on claude via `/pickle-pipeline` (pipeline-safe). Deploy `install.sh`. The closer's full release gate is the
backstop. Field-proof: none needed beyond the gate — this is behavior-preserving plumbing; the resolver tests +
`recovery-controller-foundation.test.js` pin the defaults.
