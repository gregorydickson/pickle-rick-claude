---
title: "B-PCOMP — beta 2.0 pipeline completion: ground-truth gates at both pipeline boundaries"
priority: P1
status: Draft (release-track plan — not yet refined/launched)
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
