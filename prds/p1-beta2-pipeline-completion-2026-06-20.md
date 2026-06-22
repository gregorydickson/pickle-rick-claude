---
title: "B-PCOMP — beta 2.0 pipeline completion: ground-truth gates at both pipeline boundaries"
priority: P1
status: Shipped v2.0.0-beta.22 (live-proven 4/4 hands-off)
schema_neutral: true
date: 2026-06-20
goal: "A representative multi-ticket additive bundle completes 4/4 phases hands-off (zero babysitter intervention)."
composes:
  - prds/p2-readiness-forward-created-unification-2026-06-20.md            # WS-D1 (start gate)
  - prds/BUG-REPORT-2026-06-20-completion-evidence-fatal-claude-backend-strands-bystander-ticket.md  # WS-D2 source
  - prds/BUG-REPORT-2026-06-20-readiness-contract-resolver-forward-created-schema-fields.md          # WS-D1 source
---

# B-PCOMP — beta 2.0 Pipeline Completion

**Release goal:** ship the beta that can run a real multi-ticket bundle **start → finish, hands-off.**
Today it cannot — not because of many scattered bugs, but because of **one structural defect that
shows up at the two pipeline boundaries.**

---

## 1. The structural defect (one root, two faces)

> **The gates validate a bookkeeping *artifact* against a strict grammar, instead of deriving truth
> from the actual *repo state*. The artifact is produced by an LLM worker and is reliably
> missing or mis-shaped — so the gate false-halts (start) or discards verified work (finish).**

This is the autonomy north-star inverted (`archive/.../feedback`-tracked: *trust ground truth,
validate proportionally, never discard verified work*). Both this-week blockers are the same defect:

| Boundary | Gate | Artifact it demands | Ground truth it ignores | Failure |
|---|---|---|---|---|
| **START** | readiness (`check-readiness.ts`) | a forward-ref **annotation** on every new file/symbol/field | the bundle's own "Files to create" + schema diff | **R-RCFF**: additive bundle hard-halts at iter 0 (2 sessions, 2026-06-20) |
| **FINISH** | completion-evidence (`ticket-completion-evidence.ts` → mux-runner salvage/Done-flip) | a `completion_commit:` stamp **or** a hash/r_code-attributable subject | the actual commit sitting on the branch since ticket-start | **R-CECB**: a committed, green ticket is salvage-looped + fataled; bystander work stranded (3 sessions, 2026-06-20) |

The prior fixes for each face added a *grammar* (R-FRA-6 annotation grammar; R-CCRC ticket-id/r_code
attribution) or a *coarse hatch* (`skip_quality_gates_reason`; `allow_inferred_completion_commit`).
Both hatches **provably don't work** for the real input: R-RCFF #2 false-halted an *un-annotated*
file; R-CECB proved `allow_inferred_completion_commit=true` **recurs once per ticket** because the
worker's `feat: 1.C — … (LOA-1369)` subject carries neither the dir-hash nor the r_code. Adding a
third grammar branch is the N+1 trap. **The fix is to stop trusting the artifact and reconcile
against the branch.**

Mapping to the long-standing design-simplification meta-PRD: this is **D1 (validation overreach)** +
**D2 (wrong-signal completion → work discard)**. The meta-PRD already proposed collapsing these into
shared primitives (`reconcileTicketTruth` / `salvageTicket`); the GA soak was meant to *rank* which
seam to collapse first. **R-RCFF + R-CECB ranked them — both, to the top, with multi-session
same-day evidence.** This bundle is that collapse, scoped to exactly what unblocks pipeline
completion.

---

## 2. Workstreams

### WS-D1 — Start gate: readiness derives forward-created from ground truth
**= the already-drafted `B-RFCU`** (`p2-readiness-forward-created-unification-2026-06-20.md`). Wire
the existing `buildBundleCreationIndex` into the contract/symbol resolver, populate dotted
field-paths from the schema diff, make file detection robust to annotation omission, demote
forward-created refs to advisory. **Drain B-RFCU as WS-D1 — no new content here.**

### WS-D2 — Finish gate: completion derives from the branch, never discards committed work
The new work. Four sub-fixes, all **reconcile-against-ground-truth**, anchored to real symbols:

- **D2-1 — Attribute completion from the branch, not just the stamp.** `scanGitLog`
  (`ticket-completion-evidence.ts:187`) currently matches a commit to a ticket only by the
  lowercased ticket-id and `r_code:`. Extend attribution to the ticket's **external ref** — read
  the ticket's `linear_id` / `(LOA-####)` / group ref (`1.C`) from frontmatter and match it in the
  commit subject. A commit that closes the ticket is then attributable regardless of the worker's
  subject style. *(Reuse `scanGitLog`; add ref sources, not a new resolver.)*
- **D2-2 — Salvage must not archive/reset a committed ticket.** Before the salvage path
  (`salvageTicket` / the `[salvage] … reset Todo` branch in `mux-runner.ts`) archives + resets,
  it MUST consult D2-1's branch scan: if an attributable green commit exists since ticket-start,
  **back-fill `completion_commit:` and keep the ticket** instead of archiving. This is the
  `reconcileTicketTruth`-before-`salvageTicket` ordering the meta-PRD specified. Kills the
  salvage-loop and the per-ticket recurrence.
- **D2-3 — Never strand a bystander.** When a phase is about to terminate (fatal or cap), any
  ticket with **uncommitted green work** in the tree must be committed (or stashed to a recoverable
  ref) before exit — extend the existing `commitGatePassingDeliverableOnExitPath` / R-WUWC
  preservation so ticket N+1's work survives a fatal on ticket N.
- **D2-4 — Don't reap an in-progress worker.** The salvage/no-progress signal must key on
  **artifact production** (the existing `recordWorkerArtifactProgress` / `worker_artifact_progress`
  ledger), not `worker_session_*.log` size — a worker streaming to the manager pane writes a 0-byte
  log while producing real research. Route salvage through the artifact-delta check before reset.
  *(Reuse the R-WMW artifact-progress mechanism; consult it at the salvage boundary.)*

> **Worker contract is necessary but not sufficient.** `send-to-morty.md:100` already mandates the
> worker write `completion_commit:` — yet claude workers don't reliably do it. We will *reinforce*
> the contract (D2-5, below) but the gate **must not depend on it**: the branch is the source of
> truth. Belt: D2-5 strengthen the worker prompt so the common case writes the stamp; suspenders:
> D2-1/-2 make the gate correct even when it doesn't.

- **D2-5 — Reinforce (not rely on) the worker stamp.** Make the `completion_commit` write
  backend-agnostic and adjacent to the commit (so the happy path needs no reconciliation). This is
  the cheap prevention; D2-1..4 are the load-bearing correctness.

---

## 3. Definition of done — the actual release gate

**B-PCOMP ships only when a representative multi-ticket additive bundle completes 4/4 phases with
zero babysitter intervention.** Concretely:

- **AC-PCOMP-1 (start):** the R-RCFF repro bundles (additive dotted fields; additive contract +
  un-annotated spec) pass readiness with **0 blocking findings, no skip flag** (B-RFCU ACs).
- **AC-PCOMP-2 (finish):** a ≥4-ticket additive bundle whose workers commit with human/LOA subjects
  and **omit** `completion_commit:` frontmatter runs to **all-tickets-Done** with **0 salvage-loops
  and 0 `done_without_commit_evidence` fatals** — the gate back-fills attribution from the branch.
- **AC-PCOMP-3 (no loss):** a forced fatal on ticket N leaves ticket N+1's green uncommitted work
  **committed or recoverable** (never archived/lost).
- **AC-PCOMP-4 (hands-off e2e):** an integration test drives a synthetic multi-ticket pipeline
  end-to-end (pickle → citadel → anatomy → szechuan) to `4/4 phases` with **no operator/babysitter
  state edits** — the regression net that proves "can complete a pipeline."
- **AC-PCOMP-5 (subtraction):** net `skip_*_reason` flags and forward-ref/attribution grammar
  branches added ≤ 0; `allow_inferred_completion_commit` is **demoted** (no longer advertised in
  the fatal message as a sufficient fix, since D2-1 makes it unnecessary).

## 4. ## Simplification Review (subtract-before-add — required)

1. **Necessary at all?** WS-D1 adds no mechanism (wires existing index). WS-D2 adds branch
   attribution sources to an existing scanner + reorders salvage to reconcile-first; the only new
   surface is the e2e completion test (AC-PCOMP-4) — and that is the *point* (we cannot currently
   prove pipeline completion).
2. **Reuse vs add?** Reuse everything: `buildBundleCreationIndex`, `scanGitLog`,
   `reconcileTicketTruth`/`salvageTicket`, `recordWorkerArtifactProgress`,
   `commitGatePassingDeliverableOnExitPath`, the `blockingFindings` advisory split. No parallel
   mechanism.
3. **Guarding brittle complexity that should be subtracted?** Yes — the two coarse hatches
   (`skip_quality_gates_reason` for D1, `allow_inferred_completion_commit` for D2) are the brittle
   things. We make them **non-load-bearing** and demote the inferred-flag, rather than adding a
   third attribution grammar around them.
4. **What does it subtract?** Author/worker-discipline dependence at both boundaries; the per-ticket
   back-fill recovery ritual; the N+1 "new ref shape → new grammar" trajectory; the misleading
   "set the flag" advice in the fatal message. The pipeline gets **flatter**: each boundary trusts
   the repo, not a bookkeeping artifact.

## 5. Sequencing & risk

- **Order:** WS-D1 (B-RFCU) and WS-D2 are independent (start vs finish) and can land in either
  order; ship both before claiming AC-PCOMP-4. WS-D2-1/-2 are the highest-yield (kill the
  per-ticket recurrence); D2-3/-4 are loss-prevention; D2-5 is cheap prevention.
- `schema_neutral: true` — no state-schema change. Touch points: `check-readiness.ts`,
  `audit-ticket-bundle.ts` (D1); `ticket-completion-evidence.ts`, `mux-runner.ts` salvage/Done-flip
  paths, `spawn-morty.ts`/`send-to-morty.md` (D2); integration test harness (AC-PCOMP-4).
- **Risk — over-attribution (D2-1):** a branch commit wrongly attributed to a ticket would mark it
  Done prematurely. Mitigate: require the attributable commit to be **green** (the work is already
  gated) AND touch the ticket's declared files; keep the match conservative (exact ref token, not
  fuzzy). The asymmetry favors this: today's failure (discarding committed work) is worse than the
  mitigated risk (a green, file-matching commit attributed to its ticket).
- **CI-green stays hygiene, not a release gate** (standing principle) — AC-PCOMP-4 runs on the
  local gate.

## 6. Why this is the GA path, now

beta.14–21 all shipped via babysitter takeover; the GA blocker is **field-proof of hands-off
autonomy.** R-RCFF + R-CECB are not new scattered bugs — they are the **two seams that break every
hands-off run**, confirmed across 5 sessions in one day. Collapsing them to ground-truth gates is
the smallest change that turns "ships via babysitter" into "completes a pipeline on its own." That
*is* the GA-readiness ledger, derived from evidence instead of deferred to a future soak.

---

## Revised Build Plan (post-agent-team understand+replan, 2026-06-21)

A 6-agent team (4 investigators → synthesis → adversarial skeptic, all HEAD-grounded) re-understood the
failures and re-planned for **simplification + reliability**. Findings changed the plan materially.

### Failure understanding (why 0a1ce691 couldn't be built)
Two compounding causes: **(1) R-PSRB self-referential catch-22** — the deployed beta.21 runtime runs the
same salvage/no-progress machinery the ticket edits; the worker's iterations hit the artifact-delta reap
(`PICKLE_WMW_SKIP_K=5` consecutive zero-delta spawns, `mux-runner.ts:~10098`) and the ladder exhausted,
with 0-byte logs giving no signal (R-WSDO). **(2) A spec defect the first refinement missed** — the
ticket's "export `scanGitLog` + import it from `reconcile-ticket-truth.ts`" step would add a **4th caller**
to `ticket-completion-evidence.ts`, violating the **R-AFCC-CALLER-ENUMERATION** trap door
(`audit-trap-door-enforcement.sh:467-506` pins it to exactly 3 callers) → the worker gate fails → no commit
possible *even on a fixed runtime*. The correct, simpler design **reuses the already-shipped `readEvidence`
oracle** (declared-file-touch + greenGate attribution landed by `8b4f75c6`) via the already-permitted
callers — never exporting `scanGitLog`.

### Corrections to the original WS-D2 plan (verified at HEAD)
- **D2-4 (3f6800f3) is ALREADY SHIPPED → CUT.** The reap already keys on `recordWorkerArtifactProgress`
  artifact-delta, never `worker_session` log size (`mux-runner.ts:10073/10098`). My R-CECB "salvage reads
  log size" premise was wrong. Replaced by a regression-lock AC inside the salvage ticket.
- **D2-1/D2-2 are partly already shipped.** `guardCompletionCommitBeforeDone` already auto-promotes
  inferred-fresh evidence (R-WUWC); `readEvidence` already does branch attribution (`8b4f75c6`). The only
  genuinely-uncovered seam is salvage's **clean-tree no-op** return (`salvage-ticket.ts:127-130`) for a
  ticket whose work is committed but never Done-flipped — reuse the existing `completionCommitSha` input +
  `reconcile` headSha; no new `attribute()` dep, no `scanGitLog` export.
- **File-path drift fixed:** the oracle is `extension/src/services/ticket-completion-evidence.ts`;
  `salvage-ticket.ts` + `reconcile-ticket-truth.ts` are in `extension/src/lib/`.

### Final build set — 8 remaining tickets → 4 build steps (sequential; mux-runner.ts overlap)
1. **0a1ce691 (revise, narrow):** salvage clean-tree back-fill via the existing oracle (`salvage-ticket.ts`
   + the permitted `mux-runner.ts` caller); demote `allow_inferred_completion_commit` from the fatal advice
   string only (`mux-runner.ts:~4526`; keep the runtime read `:4516` + manager-drift sets `:2605/:4745`);
   regression-lock the already-shipped artifact-delta reap. ACs assert R-CCRC-2
   (`done-flip-paths-call-guard.test.js`) + R-WUWC (`guard-completion-commit-auto-promote.test.js`) +
   R-AFCC-CALLER-ENUMERATION still pass.
2. **b736337f (keep):** stash un-attributable bystander remainder to `refs/pickle/salvage/<session>` at
   phase exit (replace the two whole-tree `git add` over-stage fallbacks at `mux-runner.ts:~4853/4882/4887`);
   never commit-as-Done under the exiting ticket; no `state.json` write.
3. **NEW-omtd (fold in R-OMTD):** `pipeline-runner` spawns mux-runner `detached:true` (own group,
   `:1166`) AND `handleShutdown` reaps the group via `process.kill(-pid, 'SIGTERM')` (`:2987`); fork test
   asserts the child exits within N s.
4. **b7b22750 (keep):** hands-off 4/4-phase e2e proof — **must force the worker-died-post-commit-pre-Done-flip
   ordering** so it exercises salvage's clean-tree back-fill (not the guard's auto-promote), plus the
   bystander-stash + reap-skip paths. Runs BEFORE hardening.
5. **NEW-quality-closure (merge 4 hardening → 1):** single 3-pass (code → test → doc) over the small
   MODIFIED_FILES union; hardening is a quality gate, not a release blocker.

**Deferred (logged, off the completion-correctness path):** R-SLEAK session-GC, R-WSDO observability
breadcrumb. **Build protocol (R-PSRB):** hand-build with atomic per-ticket commits; never re-spawn the
salvage/no-progress machinery under itself; `install.sh`-deploy after the salvage-path tickets land.
