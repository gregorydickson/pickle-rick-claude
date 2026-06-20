---
title: BUG REPORT — 2026-06-05 — the mux-runner no-progress detector fails a ticket `oversized_no_progress` and hands off terminal even when the worker has ALREADY produced complete, gate-passing output in the working tree — it just never reached its commit step; the completed+verified work is discarded (and blown away by the next clean-tree relaunch) instead of being committed and the ticket marked Done.
status: Draft
filed: 2026-06-05
priority: P2
type: bug-incident
r_code: R-WCUC
bundle: B-GNXR
related:
  - prds/MASTER_PLAN.md                                                          # finding #99 (R-WCUC); Drain Queue row 27 (B-GNXR, ticket R-WCUC-10)
  - prds/archive/bug-reports/BUG-REPORT-2026-06-04-pipeline-launch-gitnexus-statdrift-dirty-tree-abort.md  # R-PRNF (#98) — adjacent run-integrity class (runner mis-handles a non-green pickle exit); same LOA-907 incident
  - extension/src/bin/mux-runner.ts                                              # no-progress detector + oversized_no_progress + closer_handoff_terminal
incident_sessions:
  - /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-06-04-0204150f  # LOA-907 appraisal→LangGraph build (codex). Ticket 907.1 (f3f27767) — primary repro.
---

# R-WCUC — no-progress detector discards completed, gate-passing-but-uncommitted worker output instead of committing it

## Status

**Open.** Directly observed 2026-06-05 (LOA-907 build, codex). The completed work was recovered manually (babysitter verified + committed); pickle-rick itself discarded it. P2 — escalates toward work-loss (P1) because the next launch's clean-tree precondition would blow the uncommitted work away if nothing rescues it.

## TL;DR

The mux-runner's no-progress detector flags a ticket `oversized_no_progress` (→ `closer_handoff_terminal`, pipeline pauses) when no **commit** lands across 2 consecutive iterations. But a worker can fully COMPLETE a ticket — write all the files, pass typecheck AND the ticket's own acceptance spec — and simply never reach its commit step within the iteration/timeout budget (slow commit phase, implement↔review cycling, or timeout before commit). The detector keys on *commits landed*, not on *working-tree changes that pass the ticket's gates*, so it marks the ticket **Failed** and hands off terminal — **discarding completed, verified work**. The work sits uncommitted in the tree and is then wiped by the next launch's mandatory clean-tree restore.

A human/babysitter had to manually `git restore`-protect, verify (typecheck + spec), and commit the worker's output to salvage it and advance.

## Evidence (session 2026-06-04-0204150f, ticket 907.1 / f3f27767)

- `state.json`: `failure_reason: "oversized_no_progress"`, `reason: "ticket f3f27767 remained Failed on HEAD 7ed8c4085... for 2/2 consecutive iterations"`, `terminal_exit_reason: "closer_handoff_terminal"`; `pipeline-runner.log`: `Phase pickle stopped for manager handoff ... paused for operator/closer work` after 58m.
- BUT the worker had produced the **entire** deliverable, uncommitted, in the working tree:
  - `?? packages/api/src/langgraph/agents/appraisalEvaluation/` — `buildAppraisalEvaluationGraph.ts`, `state.ts`, `CLAUDE.md`, `buildAppraisalEvaluationGraph.spec.ts`, and all **14** `nodes/*/` dirs.
  - `M packages/api/src/langgraph/langgraph.service.ts`, `M .../utils/langsmith-anonymizer.ts`.
- The output PASSED its gates: `pnpm typecheck` clean; `buildAppraisalEvaluationGraph.spec.ts` → 4/4 passed (14 node IDs pinned, conditional edges + ATTOM back-edge, no-binary-channels-in-state, options-object factory). i.e. the ticket's acceptance criteria were objectively met — it was Done in everything but the commit.
- pickle-rick marked it **Failed** and paused. The babysitter recovered it manually: verified the gates, committed the scaffold (`1ecd3b915`), marked the ticket Done, advanced to the next ticket. Pickle-rick contributed nothing to the recovery.

## Mechanism

1. The pickle worker lifecycle is research → review → plan → review → implement → spec-conformance → code-review → simplify → **commit**. The no-progress detector measures progress as *new commits between iterations*.
2. A worker that does all the work but cycles in implement↔review (or is killed by the worker-timeout before the commit phase) lands **zero commits** even though the working tree now contains complete, gate-passing changes.
3. After 2 such iterations the detector fires `oversized_no_progress` → `closer_handoff_terminal` → pipeline pause. The completed diff is never committed.
4. Because every relaunch requires a clean tree (and restores/discards uncommitted changes), the work is **lost** unless a human/babysitter intervenes first.

This is adjacent to **R-PRNF (#98)** — both are the runner/mux-runner mishandling a non-green pickle outcome — but distinct: R-PRNF is the *runner* laundering a zero-work halt into a false "continue"; R-WCUC is the *no-progress detector* discarding **real, completed, verified** work as a failure.

## Proposed fixes (machine-checkable ACs — confirm with a regression first)

- **AC-R-WCUC-1:** before declaring `oversized_no_progress`/Failed, the detector must inspect the working tree for uncommitted changes attributable to the ticket; if present AND the ticket's gate (typecheck + its acceptance spec(s)) passes, **commit the worker output and mark the ticket Done** instead of Failed. Verify: a regression where a worker writes gate-passing files but never commits → the ticket ends `Done` with a commit, not `Failed`.
- **AC-R-WCUC-2:** if uncommitted changes are present but gates FAIL, do NOT silently discard them on the next clean-tree relaunch — record the diff (stash ref / patch file in the session dir) in the failure record. Verify: the failed-ticket record references the preserved diff; relaunch does not destroy it unrecorded.
- **AC-R-WCUC-3:** split the `failure_reason` taxonomy so `no_work_produced` (true no-progress) is distinct from `work_uncommitted` (tree has gate-passing changes). Verify: the 907.1-shaped case reports `work_uncommitted`, not `oversized_no_progress`, so downstream recovery chooses commit-vs-split correctly.

## Update 2026-06-05 — frequency/severity (this is the DOMINANT failure mode on codex, not an edge case)

Across the LOA-907 codex build, `oversized_no_progress` is the **dominant outcome for every non-trivial ticket**, not a rare edge case:
- **Failed `oversized_no_progress`:** 907.0 (combined), 907.1 (scaffold — work present, uncommitted → R-WCUC), 907.2 (combined docs), 907.2-ii (parity table — 340B stub), 907.3 (4 node wraps — **no output, nodes still stubs**).
- **Converged normally (worker committed):** only the trivial single-file tickets — 907.0-i (flag migration), 907.0-ii (reader), 907.0b (preconditions), 907.2-i (BEHAVIOR.md).

So the codex worker reliably converges trivial single-file tickets but **systematically fails to reach its commit/implement-completion step within the lifecycle budget for anything larger** — the no-progress detector then fails the ticket. Net effect: the pipeline is **effectively non-autonomous on codex** — a human/babysitter had to split / commit-present-work / generate-the-doc / split-again on ~every non-trivial ticket to make forward progress (5 manual recoveries in the first 8 non-trivial tickets).

Implications: (1) raises the priority of **AC-R-WCUC-1/-3** (commit gate-passing present work; split the failure taxonomy) — without them, codex builds stall on nearly every real ticket. (2) Suggests a deeper **codex-lifecycle convergence investigation** (separate finding candidate): why does the codex worker not reach implement-write/commit within `worker_timeout=2400s` for moderate tickets, when claude-backed workers presumably do? Likely the multi-phase lifecycle (research→review→plan→review→implement→conformance→review→simplify→commit) consumes the budget before the commit step on codex. (3) A pragmatic mitigation is aggressive auto-decomposition (one-file-per-ticket) for codex builds, or a "commit what's verified at timeout" behavior.

## Update 2026-06-05b — gate-FAILING variant (907.5) validates AC-R-WCUC-2 + a worker last-mile design flaw

907.1/907.3-ii were the **gate-passing** variant (work present, would compile/test-pass — babysitter just committed). 907.5 (5d40a47d, spatial/resolve/normalize/coverage/agentic) is the **gate-FAILING** variant and is more dangerous:
- The worker fully implemented all **5 nodes + 5 spec files** (spatialGenerate 54 / resolveFields 83 / normalizeAdapter 55 / computeCoverage 42 / agenticRefine 61 lines) — runtime specs **9/9 PASS** — but left **9 `tsc` errors** (boundary `enrichmentData: Record<string,unknown> → AttomAppraisalData` casts in 2 nodes; un-annotated candidate fixtures inferring `source: string` instead of `CandidateSource` in 1 spec).
- The worker burned its budget cycling implement↔conformance on these last-mile type-casts, never converged, never committed → `oversized_no_progress` → terminal handoff.
- **The work was ~9 mechanical casts from green, yet pickle-rick would have DISCARDED all 5 nodes** on the next clean-tree relaunch. It was saved only because the babysitter inspected the uncommitted tree, fix-forwarded the casts (`as PipelineInput["enrichmentData"]`, `as Parameters<typeof runAgenticPipeline>[0]["enrichmentData"]`, `: CandidateMap` fixture annotations), confirmed `tsc` green + specs 9/9, and committed (`be289122d`).

**This is the concrete proof for AC-R-WCUC-2** (previously speculative): gate-failing uncommitted work must be PRESERVED (stash/patch in the session dir), never silently discarded. And it sharpens a **worker last-mile design flaw**: the codex worker has no "I'm 9 casts away but out of budget" escape — it neither preserves the diff, nor commits-with-a-failing-flag, nor surfaces the specific errors for fix-forward; it just times out and the whole ticket's work evaporates. A "preserve + emit the failing `tsc`/test output to the failure record" behavior would let an automated fixer (or the next iteration) finish the last mile instead of redoing the ticket from scratch. (Running tally: 907.5 is the **6th** non-trivial ticket needing manual recovery; see the frequency update above.)

## NOT in scope

The worker lifecycle itself (why the commit step didn't fire — could be timeout or implement↔review cycling; a separate investigation). True oversized tickets that produce no convergent work (those correctly fail/split — see 907.0 in the same session, which produced no files and was correctly split). The R-PRNF runner-continue defect (#98).
