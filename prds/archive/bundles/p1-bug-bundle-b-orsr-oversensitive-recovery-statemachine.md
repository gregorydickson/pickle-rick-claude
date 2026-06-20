---
title: P1 bundle — B-ORSR — Over-sensitive recovery state machine + decomposition/scope flakiness (the LOA-907 "needs a babysitter on every ticket" class)
status: Draft
filed: 2026-06-06
priority: P1
type: bug-bundle
code: B-ORSR
composes:
  - "#100 R-CHTS — closer_handoff_terminal fires on consecutive_failed_iterations==1: a SINGLE non-progressing iteration parks the whole pipeline and waits for an operator, instead of running a layered autonomous recovery. The dominant operator-pause trigger across the entire LOA-907 epic."
  - "#101 R-ONPD — oversized_no_progress decomposition fragility: the refiner repeatedly emits tickets too large to converge in one 8-phase codex pass; the only recovery is a manual split into -i/-ii halves. Recurrence ≥6× in ONE epic (907.0×2 / 907.1 / 907.2 / 907.3 / 907.6) + both large hardening tickets (H1/H3). `oversized_no_progress` with a converged plan + worker output is not the same failure as a zero-output timeout, but is treated the same."
  - "#102 R-PDUP — phantom/duplicate roster entries: pre-split ticket records (the originals that were decomposed into -i/-ii) are left in the roster at sentinel order 996–999 as Todo/Failed; after ALL real work is Done the runner picks them up by order, tries to re-build already-shipped work, and halts closer_handoff_terminal. Decomposition/split never reconciles the superseded originals."
  - "#103 R-SFRS — scope-fence regression + worker self-misdiagnosis: a scoped phase (anatomy-park) changed an exported interface and updated its in-scope co-located spec, but a consumer spec OUTSIDE the scope fence still used the old shape → repo-wide typecheck red. The worker then classified its OWN regression as 'pre-existing unrelated' and converged/handed off with a red gate (a false-green that only a babysitter caught)."
backend_constraint: claude
schema_neutral: false   # introduces new exit_reason values (e.g. recovery_exhausted) + a recovery-attempt ledger in state.json; LATEST_SCHEMA_VERSION bump + back-compat read of old states. Confirm in R-ORSR-1.
relates:
  - "B-GNXR v1.101.0 (#96/#97/#98/#99) — shipped POINT-FIXES for the symptoms (discard uncommitted work, readiness-halt false-success, nested-docs ignore, GitNexus removal). B-ORSR is the DESIGN-LEVEL parent: even with those fixes, the run still pauses on every non-trivial ticket because the *trigger* (terminal-halt on one stalled iteration) and the *decomposition/scope* subsystems are over-sensitive. B-ORSR must land ON TOP of B-GNXR, not duplicate it."
  - "B-CXOR v1.96.0 (#94) — codex orphan-reset / false-Done guard. Adjacent: B-ORSR generalizes 'never advance/park on weak evidence' to the recovery trigger itself."
  - "memory: feedback_pickle_rick_autonomy_north_star — 'closer_handoff_terminal pauses are THE anti-pattern; default should be KEEP GOING; the babysitter's recovery playbook should be native.' This PRD operationalizes that memory into a concrete redesign."
source:
  - "LOA-907 appraisal→LangGraph migration, session 2026-06-04-0204150f (repo loanlight-api, codex backend, 26 tickets, tmux mode). Babysat to completion across 2026-06-05/06 — the pipeline produced good work but required a human-supervised recovery on essentially every non-trivial ticket transition. This bundle is the consolidated, evidence-backed design report from that run."
  - prds/archive/bundles/p2-bug-fix-bundle-b-gnxr-gitnexus-removal.md   # the shipped point-fixes this bundle sits above
  - prds/MASTER_PLAN.md                                  # findings #100–#103; Drain Queue row 28
---

# B-ORSR — Over-sensitive recovery state machine + decomposition/scope flakiness

> **One-line thesis.** Pickle Rick's autonomy fails not because it can't do the work — across a real 26-ticket epic it produced genuinely good output, including 7 HIGH data-flow parity fixes in anatomy-park — but because its **recovery state machine is too trigger-happy**: a single non-progressing iteration parks the whole pipeline and waits for a human. The babysitter's job reduced to: detect the park, inspect the tree, commit the work the worker already did (or execute the plan it already converged on), mark Done with `completion_commit`, hand-edit `state.json`, and relaunch — **on every non-trivial ticket**. The fix is not more point-patches; it's a recovery state machine whose **default is KEEP GOING** and whose terminal pause requires *genuine exhaustion*, not one stalled iteration.

## Trigger

MASTER_PLAN drain row 28. Authored 2026-06-06 from the LOA-907 babysitting session (`2026-06-04-0204150f`). This is the design-level parent of B-GNXR (v1.101.0): those four point-fixes (#96 R-GNDT GitNexus removal, #97 R-PFNP nested-docs ignore, #98 R-PRNF readiness-halt false-success, #99 R-WCUC discard-uncommitted-work) each addressed a symptom surfaced by this same run — but the run STILL could not advance autonomously, because the symptoms are downstream of an over-sensitive recovery trigger and a flaky decomposition/scope subsystem that B-GNXR did not touch.

## The pattern (what a babysitter actually did, every ticket)

For 907.W, 907.H1, 907.H3, and a phantom duplicate, the cycle was identical:

1. Worker runs the 8-phase lifecycle (research → … → implement → review), produces real output (research/plan artifacts on disk, often a started or complete diff).
2. One iteration fails the no-progress check (codex's 8-phase lifecycle eats the 2400s budget before a commit lands; or the ticket is a `large` open-ended review the worker can't converge in one pass).
3. `state.json` → `{ active:false, step:"completed", exit_reason:"closer_handoff_terminal", closer_handoff_tracker:{ consecutive_failed_iterations:1, head_sha:<unchanged> } }`.
4. **The pipeline parks and waits for a human.** No retry, no recovery, no escalation. `consecutive_failed_iterations:1` — a single stalled iteration is treated as terminal.
5. Babysitter recovers: inspect tree → (work present + gates pass) commit + mark Done + add `completion_commit` + advance; (large review that didn't converge) execute the worker's *own converged plan* as atomic per-finding commits; (interface change broke an out-of-scope consumer) fix-forward; relaunch.

The operator note already in #99 R-WCUC says it plainly: *"6 babysitter recoveries in the first ~9 non-trivial tickets; codex pipeline effectively non-autonomous."* The entire value proposition — autonomous iteration — was carried by a human.

## The four findings

### #100 R-CHTS — terminal halt on a single non-progressing iteration (the core over-sensitivity)
`closer_handoff_terminal` fires with `consecutive_failed_iterations:1`. One stalled iteration ≠ exhausted recovery. The runner has the information to recover (the tree, the gates, the worker's plan/artifacts) but instead parks. **This is the dominant operator-pause trigger and the direct cause of "needs a babysitter on every ticket."** B-GNXR's R-WCUC fix commits gate-passing uncommitted work *before failing* — good — but it still **fails/parks** afterward rather than committing-and-continuing. The trigger sensitivity is the bug.

### #101 R-ONPD — `oversized_no_progress` decomposition fragility + serial-split thrash
The refiner repeatedly produced tickets too large to converge in one codex pass. In ONE epic this fired on 907.0 (×2), 907.1, 907.2, 907.3, 907.6, and both `large` hardening tickets H1/H3 — each requiring a manual split into `-i`/`-ii` halves (or, for H1/H3, the babysitter executing the worker's plan directly). Two distinct sub-bugs:
- **(a) decomposition quality** — `large`-tier and "author N rows / review whole module against K principles" tickets read as open-ended derivation and never converge. The refiner should bound them mechanically up front (transcribe an existing catalog; one-fix-per-finding) or pre-split `large`-tier review tickets.
- **(b) failure taxonomy** — `oversized_no_progress` with a *converged plan + substantial worker output* is NOT the same failure as a zero-output timeout, yet both route to the same dead-end. The former should drive "execute the plan's findings as atomic commits"; only the latter should drive a blind split.

### #102 R-PDUP — phantom/duplicate roster entries strand a finished epic
When a ticket is split into `-i`/`-ii`, the **original** record is left in the roster (here at sentinel order 996–999) as Todo/Failed and never reconciled with the children that superseded it. After all 22 real tickets were Done, the runner picked up these 4 phantoms by order, tried to re-build already-shipped work, and halted. The babysitter had to verify each deliverable existed in-tree and hand-mark the phantoms Done with their real delivering commits before the pickle phase could complete. Decomposition must either delete/merge superseded originals or the roster scanner must auto-close a ticket whose deliverables are present AND whose twin is Done.

### #103 R-SFRS — scope-fence regression + worker self-misdiagnosis
anatomy-park (scoped to `appraisalEvaluation/**`) changed an exported interface (`ReductoExtractNodeOptions.pdfBytes` → a `getPdfBytes` closure) and correctly updated the in-scope co-located spec — but a consumer spec OUTSIDE the scope fence (`src/lib/appraisal-pipeline/__tests__/streaming-via-onPartial.spec.ts`) still used the old field, reddening repo-wide `tsc`. The worker then reported the break as **"pre-existing unrelated"** and converged/handed off with a red typecheck — a false-green that would have ridden into the final phase. Two sub-bugs: (a) an interface-changing edit needs a repo-wide consumer sweep, not a scope-fenced one; (b) the "pre-existing vs introduced" classifier is unreliable and should diff the failing symbol against the phase's OWN commits before disowning a break — and **a phase must never converge with a gate it turned red.**

## Design approaches (the ask — propose + choose in R-ORSR-1, don't just patch)

This bundle is explicitly a **design pass**, not a set of narrow patches. The recovery subsystem is flaky and over-sensitive in aggregate; we want a coherent model, not four more thresholds. Candidate approaches to evaluate and synthesize:

1. **Recovery as a state machine with explicit, ordered strategies (recommended default).** Replace the `consecutive_failed_iterations:1 → terminal park` edge with a `RecoveryController` that, on a stalled/failed iteration, tries an ordered ladder and only parks after the ladder is exhausted:
   - `commit-and-continue` — tree dirty + gates pass → commit it, mark Done, auto-`completion_commit`, advance. (Generalizes R-WCUC from "commit before failing" to "commit *instead of* failing.")
   - `fix-forward-trivial` — gates fail on a mechanical delta (type/lint/prettier, stale spec mock, out-of-scope interface consumer) → spawn the existing `spawn-gate-remediator` (the same fixer finalize-gate/B-HRP already use), re-gate, continue.
   - `execute-converged-plan` — `oversized_no_progress` WITH an approved plan + artifacts → run the plan's findings as atomic per-finding commits (one fix per commit) rather than splitting.
   - `auto-split` — `no_work_produced` (genuinely zero output at timeout) → decompose into atomic sub-tickets, reconcile the original (see R-PDUP), continue.
   - `escalate` — only after N *distinct* strategies fail does it emit a terminal state, and even then `recovery_exhausted` (honest) rather than `closer_handoff_terminal` (a pause that implies a human is coming).
   This is the babysitter's playbook, made native. Token cost is bounded by the ladder (each rung is one cheap check or one remediator spawn).

2. **Confidence/evidence-gated transitions (borrow from B-CXOR).** Every advance/park decision already has the evidence it needs (tree state, gate results, commit-vs-baseline, plan presence). Make the recovery trigger *read that evidence* instead of a raw iteration counter. A park is only valid when the evidence says "no recoverable signal," mirroring B-CXOR's "reject `completion_commit==baseline` as evidence."

3. **Circuit-breaker with hysteresis instead of a hair-trigger.** If a single-iteration trigger is kept at all, require K≥2 *consecutive* non-progressing iterations with *no tree delta and no plan* before any terminal edge — and reset the counter on any commit OR any new gate-passing diff. (Cheapest change; weakest fix — likely a component of #1, not a standalone.)

4. **Decomposition-quality gate at refine time (R-ONPD root cause).** Add a refiner check that flags `large`-tier or open-ended-derivation tickets ("author N rows", "review whole module") and either bounds them mechanically (point at the existing catalog/seed) or pre-splits them — so the build loop rarely meets an unconvergeable ticket in the first place.

5. **Scope-fence escape for interface changes (R-SFRS).** When a scoped phase changes an exported symbol, run a repo-wide consumer sweep (not scope-limited) and gate on whole-repo `tsc` before convergence; forbid "pre-existing" disowning of a break whose failing symbol the phase's own diff touched.

The deliverable of R-ORSR-1 is a short design note choosing among / composing these (the team's expectation is #1 as the spine, #2 as the transition predicate, #4 + #5 as upstream prevention), with the state-schema delta (new `exit_reason` values + a `recovery_attempts[]` ledger) specified before any code.

## In scope

- A `RecoveryController` (or equivalent) that replaces the single-iteration terminal park with the ordered strategy ladder above, wired into `mux-runner.ts` / `pipeline-runner.ts` at the current `closer_handoff_terminal` decision site.
- Evidence-gated terminal transition: `recovery_exhausted` (after N distinct strategies) replaces `closer_handoff_terminal` as the only autonomous terminal; `closer_handoff_terminal` retained only for genuinely operator-gated states (if any remain).
- `oversized_no_progress` taxonomy split (build on R-WCUC's `work_uncommitted` vs `no_work_produced`): add `plan_converged_uncommitted` → routes to execute-converged-plan, not split.
- Decomposition reconciliation: splitting a ticket marks/removes the superseded original so it can never re-enter the build roster (R-PDUP); plus a roster-scanner guard that auto-closes a Todo/Failed ticket whose deliverables are present AND whose twin is Done.
- Refiner decomposition-quality flag for `large`/open-ended tickets (R-ONPD prevention).
- Scope-fence interface-change sweep + whole-repo gate + "no disowning a self-introduced break" guard (R-SFRS).
- Regression/integration tests (see Invariants) + trap-door pins in `extension/CLAUDE.md`.
- Closer: full release gate, bump, install.sh, push, release, MASTER_PLAN row closing #100–#103.

## Not in scope

- Re-architecting the 8-phase worker lifecycle or the codex pre-commit budget problem (the *root* of why codex hits no-progress; tracked separately — this bundle makes the *recovery* robust regardless of why an iteration stalls). Note it as a follow-up (R-ONPD-FU: codex-lifecycle-convergence — the 8-phase lifecycle eats the 2400s budget pre-commit).
- The expensive-test gate semantics (parity/golden-baseline manager-deferral) — unchanged.
- B-GNXR's already-shipped fixes — B-ORSR composes ON TOP; do not re-implement R-WCUC/R-PRNF/R-PFNP/R-GNDT.

## Atomic tickets (sequence in R-ORSR-1; this is the expected shape)

- **R-ORSR-1** — design note: choose/compose approaches 1–5; specify the recovery ladder, the evidence predicate, the new `exit_reason` set, and the `recovery_attempts[]` state delta + back-compat read. (No code.)
- **R-ORSR-2** — `RecoveryController` + the ladder rungs (commit-and-continue, fix-forward-trivial, execute-converged-plan, auto-split, escalate); wired at the `closer_handoff_terminal` site. Replaces the `consecutive_failed_iterations:1` terminal edge.
- **R-ORSR-3** — failure-taxonomy: `plan_converged_uncommitted` route → execute-converged-plan (atomic per-finding commits from the approved plan).
- **R-ORSR-4** — decomposition reconciliation (R-PDUP): split marks the original superseded + roster-scanner auto-close-by-evidence.
- **R-ORSR-5** — refiner decomposition-quality flag (R-ONPD prevention).
- **R-ORSR-6** — scope-fence interface-change sweep + whole-repo gate + no-disown-self-break guard (R-SFRS).
- **R-ORSR-7** — regression/integration tests + `extension/CLAUDE.md` trap-door pins.
- **C-ORSR-CLOSER** — release.

## Invariants / acceptance (machine-checkable)

- **INV-NO-SINGLE-ITER-PARK:** no terminal `exit_reason` is emitted while `consecutive_failed_iterations < N` AND any recovery rung remains untried. Regression: a simulated worker that produces gate-passing-but-uncommitted output → runtime COMMITS it and CONTINUES (does not park). (This is the test B-GNXR's R-WCUC should have had at the *continue* level, not just the *commit-before-fail* level.)
- **INV-RECOVERY-LADDER:** given a stalled iteration with a dirty gate-passing tree, the runtime reaches `advanced` without operator input; with a converged plan + no diff, it reaches `executing-plan`; with zero output, it reaches `auto-split`. Each asserted by an integration test with a scripted worker.
- **INV-HONEST-TERMINAL:** the only autonomous terminal is `recovery_exhausted` after ≥N distinct strategies, with a ledger of what was tried in `state.json`. `closer_handoff_terminal`-on-iteration-1 is gone.
- **INV-NO-PHANTOM-REBUILD:** a split original cannot re-enter the build roster; a Todo/Failed ticket whose deliverables exist AND whose twin is Done is auto-closed (with the twin's commit as `completion_commit`), never re-run.
- **INV-NO-SELF-DISOWN:** a phase cannot converge while a gate it turned red is open; a break whose failing symbol intersects the phase's own diff cannot be labeled "pre-existing."
- Full release gate green (tsc/eslint/audits/fast/integration/expensive).

## Severity rationale (P1)

Recurrence ≥3× is the P1 bar; this recurred on essentially every non-trivial ticket of a 26-ticket epic and rendered the pipeline non-autonomous — the core product promise. It is the same class as #94 R-CXOR (pipeline-bricking for a backend) but broader: it bricks autonomy for *any* ticket that stalls once, on *any* backend.

---

## Appendix A — `state.json` evidence (session 2026-06-04-0204150f)

**The over-sensitive terminal (observed verbatim on 907.W, 907.H1, 907.H3, phantom 5cea7897):**
```json
{
  "active": false,
  "step": "completed",
  "current_ticket": null,
  "exit_reason": "closer_handoff_terminal",
  "closer_handoff_tracker": {
    "ticket_id": "3906ccf2",
    "head_sha": "0485980c78019596ebcf76696f28fb6222f71b68",   // == HEAD: no new commit for this ticket
    "consecutive_failed_iterations": 1                          // ← ONE stalled iteration → terminal park
  }
}
```
Relevant config: `schema_version: 5`, `worker_timeout_seconds: 2400` (medium-tier override), `command_template: "_pickle-manager-prompt.md"`, and a per-run `flags.skip_quality_gates_reason` set specifically to dodge the #98 R-PRNF readiness false-success. A `codex_manager_consecutive_no_progress` counter is present in the iteration state — the raw signal the trigger keys on.

## Appendix B — `oversized_no_progress` recurrence (#101 R-ONPD), from the ticket roster + runner logs

Every one of these was split into `-i`/`-ii` AFTER an `oversized_no_progress` failure (quotes from the superseded tickets' own frontmatter):
- 907.0 → `oversized_no_progress` **×2** → split 907.0-i (`12392235`, flag migration) + 907.0-ii (`ca60d35d`, sub-gate storage + reader).
- 907.2 → "author ~120 parity rows read as open-ended derivation" → split 907.2-i (`2a6f813d` BEHAVIOR.md) + 907.2-ii (`aa7726c4`, transcribe the existing CLAUDE.md trap-door catalog — the bounded re-frame that finally converged).
- 907.3 → `oversized_no_progress` no output at 2400s → split 907.3-i (`42743f31` prepare+classify) + 907.3-ii (`6abd094f` detectScanned+ocr).
- 907.6 → `oversized_no_progress` no output → split 907.6-i (`c8eb1b3f` attomGate HARD-REFUSE) + 907.6-ii (`724fedf7` evaluateRules+aggregate).
- 907.1 scaffold marked Failed despite PASSING typecheck + buildGraph spec (the original R-WCUC incident; babysitter committed `1ecd3b915`).
- Hardening H1 (`74b0ab91`) + H3 (`3906ccf2`), both `complexity_tier: large` → `oversized_no_progress`; the babysitter executed each worker's converged plan as atomic commits (H1: `44e59de0b`/`0f7389478`/`bbb2e968a`/`fd0f104e4`; H3: `d26148366`).

## Appendix C — phantom duplicates (#102 R-PDUP)

Four superseded pre-split originals stranded the finished epic at sentinel order 996–999, status Todo/Failed, after all 22 real tickets were Done:
`259ac2b2` (907.0), `6a557859` (907.2), `a09bdf05` (907.3), `5cea7897` (907.6) — each a duplicate of a real ticket already Done at orders 10–82. The runner halted trying to re-build them; recovery required hand-marking all four Done with their real delivering commits (`66031e5e1`/`878be6778`/`34ac435b8`/`6eeacb38b`).

## Appendix D — scope-fence regression (#103 R-SFRS)

anatomy-park commits `82a27a76a` (OCR byte-handoff) + `0e71078c3` (ATTOM replay) changed `ReductoExtractNodeOptions` (`pdfBytes` → `getPdfBytes: () => Uint8Array | Buffer | undefined`) and updated the in-scope `nodes/reductoExtract/node.spec.ts`, but missed `src/lib/appraisal-pipeline/__tests__/streaming-via-onPartial.spec.ts` (outside the `appraisalEvaluation/**` scope fence) which still passed `pdfBytes` → repo-wide `tsc` red. The iter-7 worker logged it as "pre-existing unrelated issue" and kept converging. Babysitter fix-forward: `296f9e73f` (one-line `getPdfBytes: () => pdfBytes`), `tsc` green.

## Appendix E — outcome

The epic DID complete all four phases (pickle → citadel → anatomy-park → szechuan-sauce) with genuinely good work — including 7 HIGH data-flow parity fixes anatomy-park found autonomously. But every phase transition and nearly every non-trivial ticket required a human-supervised recovery. **The work quality is not the problem; the recovery sensitivity is.** B-ORSR makes the babysitter's recovery playbook native so a run like this finishes on its own.
