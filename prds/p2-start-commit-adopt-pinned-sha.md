---
title: "R-SCPIN — start_commit adopts pinned_sha; delete the merge-base guess (supersedes the defective shipped B-PSCG heals)"
priority: P2
finding: R-SCPIN
status: "partially-shipped 2026-07-12 (core fix + 3/4 hardening/audit tickets landed, session 2026-07-11-255ad373; remaining: 695e4fb4 cross-reference-consistency, in progress)"
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
depends_on: "none (deploy-agnostic BUILD; pipeline-safe — see Routing)"
source_assessment: "3-analyst × 3-cycle refinement of B-PSCG (session 2026-07-11-255ad373, 2026-07-12): shipped heal 2bbf5770 stamps the WRONG quantity; synthesis of the analysts' R-SCBASE + R-1SEAM + R-PSCGP stubs (each individually insufficient — cross-refuted in the analyses)."
---

# R-SCPIN — adopt the baseline that is already in state

## 0. Contract (everything below is a consequence of it)

`state.start_commit` is the repo HEAD at the instant the session began work — the newest commit
NOT produced by this session. Invariant: for every commit `C` this session produces,
`start_commit` is a proper ancestor of `C`, and `rev-list --count start_commit..HEAD` equals the
number of commits the session made. It is a TIMESTAMPED fact: it must be stamped before the
first build commit; computing it afterward is guessing. Corollary invariant (true by
construction on the normal path, `setup.ts:1414` + `:1432`): **`start_commit === pinned_sha`**
at stamp time — the two fields are co-stamped from one `resolveStartCommit()` value.

## 1. The defect (shipped in 2bbf5770, live in deployed beta.1+)

Both B-PSCG heal sites adopt `computeBaselineStartCommit` (`services/scope-resolver.ts:652-667`)
= `merge-base(<default>, HEAD)` — a REVIEW-base primitive whose docblock calls HEAD "the
documented degenerate floor". For `start_commit` the contract is inverted: HEAD is the right
answer, merge-base is 97 commits / 154 files early on this branch (measured at `6d340241`).
Verified consequences (analyst cycle 3, all at HEAD):
- **Citadel is a WRITER, not a review**: `executeCitadelPhase` spawns a code-writing remediator
  (`spawnRemediator`, cwd = repo, `pipeline-runner.ts:2535-2575`) and "ALWAYS returns success"
  (`:2682-2683`) — a wrong base aims it at 154 files the session never touched, unfailable.
- **T40 wedge**: `isFailedTicketTerminalExcludable` (`mux-runner.ts:2056-2085`) fails CLOSED on
  a too-wide window (Failed tickets never excludable → epic cannot finalize) and becomes a
  rubber stamp on the HEAD-floor (empty window → every Failed ticket silently dropped).
- **Orphan-reset blindness**: `detectHeadRegression` gates on `isHeadAtOrBelowCommit(HEAD,
  start_commit)` (`mux-runner.ts:2699`) — with a merge-base baseline a full session wipe lands
  ABOVE the baseline and is invisible (proven: `merge-base --is-ancestor HEAD~3 578cbf96` →
  exit 1). The single most-recurring incident class loses its safety net during PHASE 1.
- **The guess was never needed**: `repinFromHeadOnResume` (`setup.ts:1029`, unconditional, ONE
  line above the resume heal at `:1035`) stamps `pinned_sha` from working-dir HEAD pre-build.
  The true baseline is IN STATE at every heal seam.

## 2. Workstreams

- **AC-SCPIN-1 — adopt, don't guess (both heal sites).** The resume heal (`setup.ts:~1036`)
  and the citadel heal (`healPipelineRequiredFields`, `pipeline-runner.ts:~2624-2631`) adopt
  `state.pinned_sha` when `start_commit` is unset and `pinned_sha` is present — the
  `computeBaselineStartCommit` calls are DELETED from both heal paths. Both-unset at citadel →
  the honest hard-fail stands (it audits neither a 97-commit diff nor an empty one). Never
  overwrite a set value (existing pin `tests/setup.test.js:~424` stays green). — Type: test
  (fixture: feature branch ≥2 commits past main, pinned_sha set, start_commit unset → healed
  value === pinned_sha AND !== merge-base(main, HEAD))
- **AC-SCPIN-2 — the invariant, asserted.** After any heal: `state.start_commit ===
  state.pinned_sha`. Plus the discriminating oracle on the e2e fixture: `rev-list --count
  start_commit..HEAD` == commits-the-build-made (ancestor-of-HEAD and !=HEAD are PROVEN
  non-discriminating — both pass on the 97-commit-wrong base). — Type: test (integration;
  `// @tier: integration` + `.serial-tests.json` entry + sidecar reason MANDATORY — spawns
  setup.js twice against a git fixture)
- **AC-SCPIN-3 — ordering pin.** `repinFromHeadOnResume` runs BEFORE the start_commit heal in
  `applyResumeConfig` — today comment-asserted, untested, and TWO features now depend on it. —
  Type: test
- **AC-SCPIN-4 — salvage guards re-arm (READ-ONLY on mux-runner).** Regression tests assert,
  against fixtures with the CORRECT baseline: (a) a worker HEAD-reset to session start is
  DETECTED (`isHeadAtOrBelowCommit` true → orphan reattach fires); (b)
  `isFailedTicketTerminalExcludable` is neither permanently-blocking nor a rubber stamp.
  Assert against `mux-runner.ts` — do NOT edit it (routing). — Type: test
- **AC-SCPIN-5 — honest phase-halt reason + warn truth.** (a) `isFatalPhaseFailure`'s
  `!startCommit` branch (`pipeline-runner.ts:~2783`) reports "baseline unmeasurable", never
  "zero commits" (conflation mis-triages the next incident); (b) the `setup.ts:~1423` deferral
  WARN branches on `rev-parse --git-dir`: non-repo vs unborn-HEAD get distinct, TRUE messages.
  — Type: test (stderr asserted for both cases)
- **AC-SCPIN-6 — rename the trap door.** `computeBaselineStartCommit` → `computeReviewBase`;
  drop the `setup.ts:11` import entirely; the one remaining caller
  (`pipeline-runner.ts:~629`, a merge-base fallback for a merge-base) is contract-correct.
  Rename `tests/compute-baseline-start-commit.test.js` accordingly — its assertions are CORRECT
  for the primitive; do not weaken them. The NAME is what let a review-base primitive pass four
  ACs and three analysts as a session baseline. — Type: test
  (`! grep -rn computeBaselineStartCommit extension/src/` after rename)

## 3. Explicitly rejected (subtract-before-add, with reasons)

- **Remediator spawn-refusal guard** (Risk AC-3): with both guess sites deleted, every writer
  stamps HEAD/pinned_sha or hard-fails — the mis-aim window closes at the source; a refusal
  guard would be a second hatch for a deleted hole.
- **Second stamping seam at pipeline entry** (R-1SEAM AC-1's third site): `pinned_sha` adoption
  covers the resume and citadel seams; adding a third writer re-creates the multi-producer
  problem this bundle deletes.
- **"Fixing" the primitive's HEAD floor**: deliberate, documented, tested contract
  (`scope-resolver.ts:640-651` clause (d)) with a legitimate caller. The adoption was the bug.

## Routing (⚠ read before decomposition)

Pipeline-safe, NOT an R-PSRB hand-build: the diff edits `setup.ts`, `pipeline-runner.ts`,
`scope-resolver.ts` (rename) — it changes a VALUE the salvage path consumes, not the salvage
logic; the run executes deployed JS. Per `feedback_rpsrb_is_narrow_not_anything_touching_mux_runner`.
CONSTRAINT: no ticket allowlist may include `mux-runner.ts`, `salvage-ticket.ts`, or
`ticket-completion-evidence.ts` as EDITABLE (AC-SCPIN-4 asserts read-only).

## Simplification Review (subtract-before-add)

(1) Necessary: the shipped value corrupts three R-PSRB-named consumers. (2) REUSE: adopts an
existing co-stamped field; deletes both computed-guess call sites; contract-match performed
side-by-side THIS time (primitive answers "review base", field asks "session start" — mismatch
proven). (3) The brittle thing (two producers, two semantics, no contract) is SUBTRACTED to one
producer + a written contract. (4) Net: deletes two `computeBaselineStartCommit` calls + one
import; renames the foot-gun; adds zero flags/gates/fields.

## Risks

- Legacy sessions with a merge-base-stamped `start_commit` already in state: out of scope
  (value already stamped; the no-overwrite rule preserves it; only NEW heals change).
- The rename touches a shared primitive's name — grep other-export pins before deleting
  (beta.33 lesson); the export catalog in `services/CLAUDE.md` must be updated in the same
  ticket.
- Template lessons (recoverability line, contract-match artifact, premise-may-be-shipped grep)
  land in `prds/CLAUDE.md` in this bundle's docs ticket — authoring-time discipline, no runtime
  machinery.
