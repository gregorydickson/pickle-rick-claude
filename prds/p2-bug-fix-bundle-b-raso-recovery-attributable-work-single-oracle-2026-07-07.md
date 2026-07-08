---
title: "B-RASO — recovery attributable-work single oracle"
r_code: B-RASO
priority: P2
kind: bug-fix-bundle
build_protocol: R-PSRB-HAND-BUILD
source: RECOVERY-SPRAWL-COLLAPSE-ANALYSIS-2026-07-07.md
composes: []
---

# B-RASO — Recovery Attributable-Work Single Oracle

## Problem (verified against HEAD `132fa287`)

The recovery surface has **two independent detectors answering the same question** —
*"is there salvageable work for this ticket?"* — at **divergent SHA-verification strictness**.
This is the B-1SEAM completion-oracle collapse **one level down**: B-1SEAM unified *"is this ticket
DONE"* onto one predicate; the *"is there SALVAGEABLE WORK"* sibling question was never unified.

| Detector | Callsite | Frontmatter-SHA arm | Strictness |
|---|---|---|---|
| `detectSilentDeathAttributableWork` | `mux-runner.ts:8090` → `hasFrontmatterCompletionSha:8040` | `completion_commit` / `completion_commit_inferred` | **regex format only** (`/^[0-9a-f]{7,40}$/i`) — **never `git cat-file`-verified** |
| `detectFailedFlipEvidence` | `mux-runner.ts:8326` → `hasVerifiedFrontmatterCompletionSha:8264` | same fields | regex **AND** `git cat-file -t <sha> === 'commit'` |

### The latent false-hold bug

`applySilentDeathRecoveryPolicy` (`mux-runner.ts:8119`) treats any detector hit as
`action: 'hold'` — **NO respawn, no cap drawdown, ticket status untouched**. Because the
silent-death SHA arm is format-only, a worker that silent-died after stamping a
**garbage / hallucinated / unreachable** `completion_commit` (the exact R-AICF class — a
format-valid SHA that resolves to nothing) makes silent-death **HOLD** — suppressing the respawn
that would recover the ticket — while the Failed-flip path over the *same* stamp correctly
**rejects** it. The ticket stalls: never respawned, never Done, never Failed. A latent
correctness defect, not merely sprawl.

The two detectors are **not** otherwise identical, and the collapse must preserve their distinct,
earned arms:
- Silent-death arms: verified-SHA · scoped iteration-window commit (`hasScopedIterationWindowCommit:8052`) · fresh lifecycle artifacts (`hasFreshLifecycleArtifacts:8066`).
- Failed-flip arms: verified-SHA · ticket-scoped commit (window-scope) · **`signal_committed`** (`resolveInterruptionIsSignal` + `hasPresentCompletionCommitField:8298` — a SIGTERM teardown over a committed ticket where HEAD moved out from under the commit; intentionally present-field-not-git-verified, earned by B-RRH C3).

The defect is **only** the SHA-verification-strictness divergence. The `signal_committed` arm's
present-field semantics are deliberate and stay.

## ⚠ Build protocol — R-PSRB HAND-BUILD (attended pipeline soak)

Both consumers sit on the silent-death / Failed-flip → respawn-suppression boundary — the deployed
runtime applies this exact logic to the worker building the fix. Per `prds/CLAUDE.md`
"Self-modifying-recovery bundles" this is a genuine salvage-path bundle. **The bug being fixed is a
low-base-rate latent false-hold** (requires a build-worker to silent-die AND carry a garbage
completion SHA), so the pipeline-build risk is low-but-silent. Operator decision (2026-07-07): run
this **attended** through `/pickle-pipeline` as a soak rep, with a hand-finish fallback if the
false-hold fires mid-build. If unattended, hand-build in-process then `install.sh`.

## Workstreams

### WS-1 (P2, correctness) — collapse both detectors onto one verified-SHA oracle

Introduce ONE shared helper both detectors consume for the frontmatter-SHA arm:

```
resolveAttributableFrontmatterSha(sessionDir, ticketId, workingDir): { sha: string; kind: 'verified' } | null
```

- Reads `completion_commit` / `completion_commit_inferred`, normalizes quotes/whitespace, validates
  the `/^[0-9a-f]{7,40}$/i` shape, **then verifies `git cat-file -t <sha> === 'commit'`** (reusing
  the existing `silentDeathGit` finite-timeout git wrapper). Returns null on any failure
  (unreadable file, bad shape, unresolvable SHA).
- `hasFrontmatterCompletionSha` (silent-death) is **deleted**; its callsite in
  `detectSilentDeathAttributableWork` routes through the shared helper. The silent-death detector's
  other two arms (scoped-window-commit, fresh-artifacts) are **unchanged** — a genuine worker with
  fresh artifacts still holds even when the SHA is unresolvable, so the fix never loses a legitimate
  hold; it only closes the garbage-SHA false-hold.
- `hasVerifiedFrontmatterCompletionSha` (Failed-flip) is **deleted**; its callsite in
  `hasTicketScopedCommitEvidence` routes through the same shared helper. All other Failed-flip arms
  (window-scope commit, `signal_committed`) are **unchanged**.

**Acceptance criteria (machine-checkable):**
- AC-1: `extension/src/bin/mux-runner.ts` contains exactly ONE function performing a
  `git cat-file -t` verification of a frontmatter completion SHA; `grep -c "hasFrontmatterCompletionSha\|hasVerifiedFrontmatterCompletionSha" extension/src/bin/mux-runner.ts == 0` (both dead helpers removed).
- AC-2: A ticket with a format-valid but **unresolvable** `completion_commit` and NO other evidence
  (no window commit, no fresh artifacts) → `detectSilentDeathAttributableWork` returns `null` (was
  `'completion_commit'` pre-fix), so `applySilentDeathRecoveryPolicy` proceeds to respawn/archive
  rather than `hold`. New test asserts the pre-fix `hold` is now a respawn.
- AC-3: The SAME unresolvable SHA yields `null` from `detectFailedFlipEvidence`'s SHA arm — parity
  test proves both detectors agree on the garbage-SHA verdict.
- AC-4: A ticket with a **git-resolvable** `completion_commit` still holds (silent-death) / suppresses
  (Failed-flip) exactly as before — no behavior change on the genuine-work path.
- AC-5: The `signal_committed` Failed-flip arm still fires for a signal teardown over a
  present-but-HEAD-moved completion field (present-field semantics preserved; existing
  `evaluateFailedFlipSuppression` tests stay green).
- AC-6 (trap door): a new `extension/CLAUDE.md` trap door pins the single-verified-SHA-oracle collapse
  (one `git cat-file`-verified SHA helper consumed by both detectors; reintroducing a format-only SHA
  acceptance on the silent-death path BREAKS), with an ENFORCE test.

### WS-2 (P3, subtraction — VERIFY-FIRST) — dead `salvageCleanTree` back-fill branch (B-CSHYG-a)

The analysis flags `salvageCleanTree`'s `backfillDone` dep (`lib/salvage-ticket.ts:141`) as a
never-wired-in-production clean-tree back-fill branch. **This is contradicted by the active trap door
"B-PCOMP #0a1ce691 clean-tree completion back-fill" + ENFORCE test `salvage-backfilled-done.test.js`,
which pin `salvageCleanTree` as a live path.** WS-2 is therefore **verify-first, not delete-on-faith**:

1. Grep every production `salvageTicket(` caller in `extension/src/` and confirm whether ANY wires
   `deps.backfillDone` AND passes `input.completionCommitSha`.
2. **If zero production callers wire it** → delete the `salvageCleanTree` back-fill branch + the
   `backfillDone` dep + reconcile the trap door and `salvage-backfilled-done.test.js` to the reduced
   surface. Net subtraction.
3. **If any production caller wires it** → the branch is LIVE, not dead. **DEFER WS-2**, record the
   wiring evidence in the ticket, and reclassify B-CSHYG-a. Do not force-delete a pinned live path
   (the B-GSUB over-subtraction lesson).

**Acceptance criteria:**
- AC-7: The ticket records the `salvageTicket(`-caller grep result (caller files + whether each wires
  `backfillDone`/`completionCommitSha`).
- AC-8: EITHER the branch + dep + its trap door + `salvage-backfilled-done.test.js` are removed and the
  full gate stays green, OR a DEFER note with the concrete production-wiring evidence is recorded and
  no salvage-ticket.ts source changes ship.

## Simplification Review (subtract-before-add)

**WS-1:**
1. *Necessary?* Yes — collapses two parallel SHA-verification implementations into one and fixes a
   correctness defect. Adds ONE helper, **deletes TWO** (`hasFrontmatterCompletionSha` +
   `hasVerifiedFrontmatterCompletionSha`). Net −1 function, −1 strictness divergence.
2. *Reuse not add?* Reuses the existing `silentDeathGit` finite-timeout git wrapper and the existing
   quote/shape normalization; the helper is the intersection of the two dead functions, not new
   machinery. This is the B-1SEAM `evaluateCompletionEvidence` pattern applied one level down.
3. *Guards existing brittle complexity?* No new guard. It **removes** a divergence: the honest fix is
   to make the two detectors share one verified check, not to add a third reconciler.
4. *Subtracts?* Yes — one detector function deleted, one strictness class collapsed. The trap door
   (AC-6) is doc-discipline pinning the collapse, not a runtime gate.

**WS-2:**
1. *Necessary?* Pure removal if dead; nothing if live. No addition either way.
2. *Reuse not add?* N/A (removal).
3. *Guards brittle complexity?* Removes a dead/near-dead branch + its trap door if confirmed dead.
4. *Subtracts?* Yes if confirmed dead (branch + dep + trap door + test); explicit DEFER-with-evidence
   if live. No new code.

## Must-survive (do NOT collapse)
`evaluateCompletionEvidence` (B-1SEAM) · `salvageTicket`/`reconcileTicketTruth` · the `signal_committed`
present-field arm (B-RRH C3, earned) · the silent-death scoped-window + fresh-artifacts arms · the
`state.recovery_attempts` ledger + caps · `evaluateFailedFlipSuppression` cap/escalate policy.
