# Bug: paused-refine → `/pickle-pipeline --resume` strands `state.prd_path` (citadel hard-fails), and a manager-crash mid-implement bricks every relaunch on the dirty-tree FATAL

**Filed**: 2026-06-11 (babysitter interventions #1–#3, session `2026-06-11-c653c95f`, LOA-1097 staged-credit-rule-bundles build, codex backend, 12 tickets, target `loanlight-api` worktree `.wt-loa-1097`)
**Severity**: P1 — one NEW defect (R-PRPATH) makes citadel un-runnable on the refine→pipeline path; one fresh reproduction escalates an existing P3 (dirty-tree-self-cleanup) to recurring-on-every-manager-crash
**Status**: Open

## TL;DR — what is NEW vs already-filed

This session reproduced a four-part launch/recovery cascade. Three parts are ALREADY tracked and behaved largely as designed — only cross-referenced here, NOT re-filed:

- **Readiness halt on forward-created files** → `check-readiness exited 2` → `pickle_readiness_halt`. This is **R-RFCB** (`bug-readiness-forward-created-citation-blindness.md`) firing, plus **#98 R-PRNF** (v1.101.0) correctly hard-failing the phase instead of false-succeeding. Working as designed; recovered with the documented `state.flags.skip_quality_gates_reason` override (35 findings, all forward-created files/contracts the bundle creates — zero real drift).
- **Manager-process crash → `Session inactive. Exiting.`** with most tickets incomplete → **B-ORSR / #104 R-CHTS-CODEX** family (codex manager death / over-sensitive recovery).
- **Uncommitted worker output discarded on relaunch** → **#99 R-WCUC** (v1.101.0). R-WCUC commits *gate-passing* uncommitted work before failing; the crashed ticket here never reached its gate (died mid-implement), so R-WCUC correctly did NOT commit it — see the gap in D2 below.

**The genuinely NEW finding: R-PRPATH (D1).** And a **fresh, severity-escalating reproduction** of the dirty-tree-self-cleanup P3 (`p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md`) — see D2.

## Incident timeline (session `2026-06-11-c653c95f`)

The session was created `setup.js --paused` (refinement), refined inline via `/pickle-refine-prd` (12 tickets + parent written, `prd_refined.md` produced), then launched with `/pickle-pipeline --resume <session> --backend codex` (resume of an externally-refined paused session — note this is a slightly off-label invocation; the skill's first-class paths are fresh-`--task` or refine-inline).

1. **16:17 — readiness HALT (known: R-RFCB + R-PRNF).** Pickle phase exited 2 (`READINESS HALT: check-readiness exited 2; no manager spawn attempted`). `readiness_2026-06-11.md`: 35 findings, every one a forward-created file (`staged-credit-bundle.service.ts`, the e2e spec, proxy routes, `StagedCreditRulesClient`) or forward-introduced contract (`adoptDefaultRulesWithTx`, `applyBundle`, `listStagedCreditBundles`). Recovered via the documented skip-gate flag.
2. **16:21–16:37 — build ran, then manager crashed.** b8ded329 completed + committed (`7b4670799`, full lifecycle). 63f4036e went research→plan→implement (created `types.ts`/`registry.ts`/`index.ts`/`example-credit-category-a.bundle.ts`/`__tests__/` ON DISK) but never committed. Then `orphan_manager_reaped pid=44433` → `Session inactive. Exiting.` mux-runner exited; pickle phase reported **exit 0** to pipeline-runner.
3. **16:37 — citadel hard-failed (NEW: R-PRPATH).** pipeline-runner advanced PHASE 2/4 CITADEL and immediately died: `citadel: missing state.prd_path or state.start_commit — failing phase`. `start_commit` WAS set (`d7699e76…`); **`state.prd_path` was never populated** by the paused-refine→resume path. Pipeline stopped at "1/4 phases".
4. **16:48 — relaunch FATAL (repro: dirty-tree-self-cleanup P3).** After patching state (`prd_path`, re-activate), the relaunch hit `[FATAL] Working tree … is dirty … packages/api/src/modules/portal-credit-rules/staged-bundles/ … Commit, stash, or discard changes before starting`. The crashed 63f4036e's uncommitted SOURCE files (non-gate-passing, so R-WCUC didn't rescue them) bricked the relaunch. Required manual `git clean` of the in-flight ticket's files + reset-to-Todo before the pipeline would start.

## D1 (NEW) — R-PRPATH: `state.prd_path` unset after paused-refine → pipeline resume → citadel un-runnable

**Defect.** `pipeline-runner` citadel phase requires BOTH `state.prd_path` and `state.start_commit`. On the `setup.js --paused` → `/pickle-refine-prd` (inline) → `/pickle-pipeline --resume <session>` path, `state.start_commit` is populated but `state.prd_path` is **never set**. Citadel (PHASE 2/4) therefore hard-fails the moment pickle completes — i.e. the pipeline can NEVER reach review on this path, even on a perfectly clean build.

**Why it slips through.** The fresh `/pickle-pipeline` path (`setup.js --task …`) and the non-paused refine path apparently set `prd_path`; the paused-refine→resume composition does not. `prd_refined.md` exists in the session dir but nothing writes its path into `state.prd_path`.

**Fix (machine-checkable):**
- **AC-R-PRPATH-1** — `setup.js --resume <session>` (and/or the `/pickle-refine-prd` handoff) MUST persist `state.prd_path`, resolving to `${SESSION_ROOT}/prd_refined.md` when present, else `${SESSION_ROOT}/prd.md`. Assert: after a `--paused` → refine → `--resume` sequence, `jq -r .prd_path state.json` points at an existing file.
- **AC-R-PRPATH-2** — the citadel phase preflight, when `state.prd_path` is absent but `${SESSION_ROOT}/prd_refined.md`|`prd.md` exists, MUST self-heal (adopt that path + log) rather than hard-fail. Assert: a session with `start_commit` set, `prd_path` unset, and `prd_refined.md` present runs citadel instead of `exit 1`.
- **AC-R-PRPATH-3** — regression: a scripted `--paused`→refine→`--resume --backend codex` fixture reaches PHASE 2 CITADEL without the `missing state.prd_path` failure.

## D2 (REPRO, escalates existing P3) — manager-crash mid-implement strands non-gate-passing files → dirty-tree FATAL bricks relaunch

This is a fresh live reproduction of `p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md`, with a new severity argument: it now bites on **every** manager-process crash mid-ticket, not just scoped-autofix spillover.

**The gap between this and the shipped fixes.** R-WCUC (#99) commits *gate-passing* uncommitted work before a no-progress failure; R-PFNP (#97) exempts `docs/`/`prds/` at any depth. Neither covers a **manager process crash** (orphan-reaped → `Session inactive`) that leaves a half-implemented ticket's SOURCE files uncommitted and **non-gate-passing** (it never ran its conformance/review). On the next `/pickle-pipeline` launch the dirty-tree preflight FATAL-aborts and there is **no auto-recovery** — a human must `git clean`/stash the crashed ticket's files.

**Fix direction (consolidate into the P3 PRD, machine-checkable):**
- **AC-R-MCDT-1** — on launch, when the tree is dirty SOLELY within `state.current_ticket`'s declared `Files to modify/create` AND that ticket is not Done, the runner auto-quarantines (stash or `git clean` to a recoverable ref) those files and resets the ticket to Todo, instead of FATAL. Assert: relaunch after a simulated mid-implement crash proceeds past preflight without manual intervention; the quarantined diff is recoverable from a ref/stash.
- **AC-R-MCDT-2** — the quarantine is logged as a distinct `crashed_ticket_files_quarantined` activity event (not silent), naming the ticket + files + recovery ref.
- **AC-R-MCDT-3** — files dirty OUTSIDE the current ticket's declared set still FATAL (no scope creep of the guard).

## Recovery applied this incident (babysitter)

- **#1 (readiness halt):** set `state.flags.skip_quality_gates_reason` (creation-heavy bundle, 35 forward-created false-positives verified against `readiness_2026-06-11.md`); reset `step→research`, `current_ticket→b8ded329`; relaunch. → manager spawned, b8ded329 shipped.
- **#3 (compound):** set `state.prd_path=${SESSION_ROOT}/prd_refined.md` (D1 workaround); `git clean -fd` the crashed 63f4036e `staged-bundles/` files (D2 workaround); reset 63f4036e→Todo; re-activate; relaunch → PHASE 1 resumed, building 63f4036e fresh with full lifecycle.

## Cross-references

- **R-RFCB** `bug-readiness-forward-created-citation-blindness.md` — the readiness false-positives (D-pre-1); not re-filed.
- **#98 R-PRNF** (v1.101.0) — readiness-halt → hard `pickle_readiness_halt`; confirmed working this incident.
- **#99 R-WCUC** (v1.101.0) — commit gate-passing uncommitted work before failing; D2 is the *non-gate-passing crash* gap it does not cover.
- **#97 R-PFNP** (v1.101.0) — docs/prds dirty-tree exemption; D2 is the source-file crash case.
- **`p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md`** — D2 escalation target.
- **B-ORSR / #104 R-CHTS-CODEX** — codex manager-death / over-sensitive recovery family (the `Session inactive` crash).

## Master-plan registration

- **#110 R-PRPATH** → Open Findings **P1** (NEW; AC-1..3 above).
- D2 → append the 2026-06-11 reproduction + AC-R-MCDT-1..3 to the existing dirty-tree-self-cleanup P3 (severity argument: recurs on every mid-ticket manager crash).
