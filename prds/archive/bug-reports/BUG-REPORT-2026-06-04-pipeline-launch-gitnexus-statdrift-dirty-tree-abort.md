---
title: BUG REPORT — 2026-06-04 — setup.js's GitNexus graph-preflight rewrites tracked CLAUDE.md/AGENTS.md index-stats, dirtying the tree, and the SAME launch path's pipeline-runner dirty-tree preflight then FATAL-aborts; re-running setup.js re-creates the dirtiness, so the canonical /pickle-pipeline launch self-bricks on any GitNexus-indexed repo. Secondary: the preflight ignore-prefix matches only top-level docs/prds, missing nested packages/api/docs/prd/.
status: Draft
filed: 2026-06-04
priority: P2
type: bug-incident
r_code: R-GNDT
secondary_r_code: R-PFNP
companion_r_code: R-PRNF
bundle: unbundled
related:
  - prds/MASTER_PLAN.md                                                          # finding #96 (R-GNDT, this report) + #97 (R-PFNP secondary); Drain Queue row 27 (B-GNDT)
  - prds/archive/bug-reports/BUG-REPORT-2026-06-02-scoped-microverse-out-of-scope-autofix-dirty-tree-abort.md  # R-SMAF (#91) — adjacent dirty-tree-abort class, DIFFERENT mutator (lint --fix vs gitnexus stat-drift)
  - prds/archive/bug-reports/p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md             # #80, Done ea3cb135 — adjacent dirty-tree-guard class, different trigger
  - extension/src/bin/setup.ts                                                   # graph-preflight invokes `gitnexus analyze` (writes CLAUDE.md/AGENTS.md index stats)
  - extension/src/bin/pipeline-runner.ts                                         # dirty-tree preflight ("ignored prefixes: prds, docs") + the FATAL abort site
incident_sessions:
  - /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-06-04-0204150f  # LOA-907 appraisal→LangGraph pipeline (loanlight-api monorepo, codex backend) — primary repro; FATAL twice before recovery
---

# R-GNDT — GitNexus index-stat drift from setup.js dirties the tree, then pipeline-runner's own preflight FATAL-aborts the launch

## Status

**Open.** Directly observed this session (loanlight-api LOA-907 pipeline launch via `/pickle-pipeline --backend codex`). The mechanism is reproducible in the runtime; does NOT pre-commit to a fix — confirm with one regression before changing the preflight/graph-preflight logic.

## TL;DR

Launching `/pickle-pipeline` (or any path that runs `setup.js --tmux --resume` immediately followed by `pipeline-runner.js`, which is the canonical flow) against a repo indexed by GitNexus, the pipeline-runner aborted on startup with:

```
[FATAL] Working tree at /Users/gregorydickson/loanlight/loanlight-api is dirty (ignored prefixes: prds, docs). Dirty files:
CLAUDE.md
packages/api/docs/prd/
Commit, stash, or discard changes before starting the pipeline.
```

Two distinct defects compound here:

- **R-GNDT (primary):** `setup.js`'s graph-preflight runs `gitnexus analyze`, which **rewrites tracked `CLAUDE.md` and `AGENTS.md`** with updated index statistics (observed: the "indexed by GitNexus as **loanlight-api** (NNNNN symbols, NNNNN relationships, …)" line — `42548 symbols / 76357 relationships` → `44381 / 79631`). This leaves the working tree dirty. The very next step in the same launch path is `pipeline-runner.js`, whose dirty-tree preflight FATAL-aborts because `CLAUDE.md` is dirty. `CLAUDE.md`/`AGENTS.md` are **not** in the preflight ignore set (only `prds`, `docs`). **Re-running `setup.js` to "re-arm" RE-CREATES the dirtiness** — so the obvious recovery (re-run setup, relaunch) loops forever. The launch path self-bricks on any GitNexus-indexed repo.

- **R-PFNP (secondary):** the preflight's ignore-prefix matching only matches **top-level** path prefixes (`docs/`, `prds/`). A PRD authored at a **nested** path — here `packages/api/docs/prd/LOA-907-…md` — is NOT matched by the `docs` prefix and so blocks the launch, even though it is exactly the docs/PRD churn the ignore set exists to exempt.

## Mechanism

1. `/pickle-pipeline` → `setup.js --tmux --resume …`. setup's graph-preflight calls `gitnexus analyze`. (Note: on the FIRST launch this session it logged `[graph-preflight] gitnexus analyze failed: spawnSync gitnexus ETIMEDOUT`, but a subsequent run succeeded and rewrote the stat line.) The analyze step writes new symbol/relationship counts into tracked `CLAUDE.md` + `AGENTS.md`.
2. The same `launch.sh` then runs `pipeline-runner.js`. Its preflight enumerates the dirty tree, subtracts only top-level `prds/` + `docs/` prefixes, finds `CLAUDE.md` (and `packages/api/docs/prd/`) still dirty, and `[FATAL]` aborts before any phase/ticket work begins (`state.json`: `active:false`, `exit_reason:"fatal"`, `iteration:0`).
3. Recovery attempt "re-run `setup.js --resume` then relaunch" re-triggers the gitnexus stat rewrite → `CLAUDE.md` dirty again → identical FATAL. The loop only breaks by **NOT** re-running setup.js: `git restore CLAUDE.md AGENTS.md` (discard the stat-only churn) + commit/stash the real PRD, then relaunch via `launch.sh` directly (which runs `pipeline-runner.js`, never `gitnexus analyze`).

## Evidence (this session — 2026-06-04-0204150f)

- Launch 1 (22:09:28Z): runner started, `backend resolved: codex`, then `[FATAL] … dirty … CLAUDE.md / packages/api/docs/prd/`. `state.json` frozen at launch, `exit_reason:fatal`, zero ticket artifacts.
- Recovery: `git restore CLAUDE.md AGENTS.md`; `git commit` the PRD (`a6b80cd7d`). Tree clean.
- Launch 2 (23:45:02Z, via `setup.js --resume` + relaunch): FATAL **again**, now dirty file = `CLAUDE.md` only — i.e. `setup.js` had just re-dirtied it via gitnexus. Confirms the self-dirty loop.
- Launch 3 (23:46:09Z, `git restore CLAUDE.md AGENTS.md` then `launch.sh` ONLY, no setup.js): preflight passed; `mux-runner` started; `state.json` → `active:true`, `iteration:1`, `exit_reason:null`, phase `pickle`, phantom-Done watcher installed=17. Pipeline progressing.

This is the SAME GitNexus stat-drift already noted as a manual-cleanup nuisance in the MASTER_PLAN HS-SWEEP drain protocol ("sweep up GitNexus AGENTS.md/CLAUDE.md stat-drift, which must be dropped/restored") — but there it dirties post-convergence; here it **bricks the launch itself**, and the standard re-arm recovery makes it worse.

## Proposed fixes (machine-checkable ACs — confirm with a regression first)

- **AC-R-GNDT-1:** `setup.js` graph-preflight must NOT leave tracked files dirty. Run `gitnexus analyze` in a non-mutating mode, OR `git restore` the index-stat-only churn to `CLAUDE.md`/`AGENTS.md` after analyze, OR add GitNexus-managed files to the launch-path's ignore set. Verify: after `setup.js --tmux --resume <session>` on a GitNexus-indexed repo, `git status --porcelain` shows no `CLAUDE.md`/`AGENTS.md` modification attributable to the stat bump.
- **AC-R-GNDT-2:** the `setup.js → pipeline-runner.js` launch path must not self-brick: a clean tree before `/pickle-pipeline` stays clean through the runner preflight. Verify: a regression that runs setup-then-runner on a GitNexus-indexed fixture repo reaches `iteration:1` (pickle phase) without a dirty-tree FATAL.
- **AC-R-PFNP-1:** the pipeline-runner dirty-tree preflight ignore-prefix matches the path **segment** `docs/`/`prds/` at **any depth** (or is configurable), so `packages/api/docs/prd/foo.md` is ignored. Verify: with only `packages/api/docs/prd/foo.md` dirty, `pipeline-runner.js` passes preflight.

## NOT in scope

Changing what GitNexus writes (that's its index format). Removing the dirty-tree preflight entirely (it correctly protects against uncommitted-work loss for non-doc files). The R-SMAF lint-`--fix` mutator (separate finding #91).

---

# R-PRNF (companion, same incident) — pipeline-runner treats a readiness-HALTED pickle phase as a recoverable partial build and runs citadel/anatomy/szechuan over an EMPTY diff, reporting the pipeline "complete" having built nothing

## Status

**Open.** Directly observed this session (2026-06-04-0204150f, LOA-907) immediately after the R-GNDT recovery. P2 (escalates to P1 when it causes a believed-shipped no-op — false-success masking of a total build failure).

## TL;DR

After the dirty-tree blocker (R-GNDT) was cleared and the pipeline relaunched, the **pickle phase halted at the readiness gate** — `mux-runner.log`: `READINESS HALT: check-readiness exited 2; no manager spawn attempted` → `mux-runner finished. 1 iterations, 0m 25s`. **No manager spawned, no worker ran, zero of the 17 tickets built.**

The pipeline-runner then logged:

```
[recoverable_phase_failure] phase=pickle exit_code=1 fatal=false
  reason="non-fatal pickle exit, commits present"
  decision="continue"  downstream=[citadel, anatomy-park, szechuan-sauce]
[pipeline-runner] Phase pickle exited with code 1 (non-fatal) — continuing to citadel for automated remediation
[pipeline-runner] Phase pickle completed successfully
```

— and ran **PHASE 2 citadel** (7 findings, 0 remediable, over an empty diff), then **PHASE 3 anatomy-park**, then would have run szechuan and **exited reporting all 4 phases complete** — having implemented nothing. A readiness-halted (zero-work) build was laundered into a "successful pipeline."

## Mechanism

1. The readiness gate (`check-readiness`) is a hard pre-spawn gate: on `exit 2` the mux-runner halts WITHOUT spawning the manager and exits the pickle phase with code 1 — **no ticket work, no new commits**.
2. The pipeline-runner's pickle-exit handler classifies `exit_code=1` as `recoverable_phase_failure` with `reason="non-fatal pickle exit, commits present"` and `decision="continue"`. **The "commits present" heuristic is satisfied by PRE-EXISTING commits on the branch** (here: the operator's PRD commit `a6b80cd7d`, which predates the build) — it does NOT distinguish "the build produced ticket commits" from "the branch already had commits." A readiness halt produces ZERO build commits, yet the heuristic reads `commits present` and continues.
3. Worse, it does not distinguish a **readiness HALT (zero workers ever spawned)** from a **partial build that errored after doing real work** — only the latter is a legitimate "continue to citadel for remediation" case. A readiness halt means there is nothing to remediate.
4. Net: the review phases (citadel/anatomy/szechuan) run over an empty diff and the pipeline reports success. An operator (or babysitter) watching phase progression sees "pickle ✓ → citadel ✓ → anatomy-park…" and reasonably believes the build happened.

## Evidence (session 2026-06-04-0204150f)

- `mux-runner.log`: `READINESS HALT: check-readiness exited 2; no manager spawn attempted` / `mux-runner finished. 1 iterations, 0m 25s`.
- `tmux_iteration_1.log` activity event: `recoverable_phase_failure … reason:"non-fatal pickle exit, commits present" … decision:"continue"`.
- `pipeline-runner.log`: `Phase pickle exited with code 1 (non-fatal) — continuing to citadel` → `Phase pickle completed successfully` → `PHASE 2/4: CITADEL` (7 findings, 0 remediable) → `PHASE 3/4: ANATOMY-PARK`.
- All 17 tickets remained `status: Todo`; no per-ticket research/plan/worker artifacts; no ticket commits on the branch (only the pre-build PRD commit).
- The readiness exit-2 was itself a GOOD catch (it found a HIGH-confidence PRD contract-drift: sharing the field-aware 3-arg `valuesMatch` with the golden-baseline harness would change GATE-3 pass/fail semantics) — so the gate worked; the runner's post-halt handling is the bug.

## Proposed fixes (machine-checkable ACs — confirm with a regression first)

- **AC-R-PRNF-1:** the pickle-exit "recoverable, continue" decision must require **build progress**, not merely "commits present." Gate `continue` on ticket-commits-since-`start_commit` (or worker artifacts produced this run), NOT on the branch having any commit. Verify: a regression where pickle exits non-zero with zero commits-since-start_commit yields `decision != continue`.
- **AC-R-PRNF-2:** a readiness HALT (`check-readiness exited 2`, no manager spawned) must be treated as a **hard pickle failure** that stops the pipeline (or surfaces for an explicit skip), NOT a recoverable partial build — there is nothing to remediate downstream. Verify: a readiness-halt pickle phase does NOT advance to citadel; the runner exits with a distinct `exit_reason` (e.g. `pickle_readiness_halt`).
- **AC-R-PRNF-3:** when the pipeline-runner skips/continues past a non-green pickle phase, it must record an honest terminal status so a "complete" pipeline over an empty build is never reported as success. Verify: final state for a zero-build run reads e.g. `pipeline_incomplete: build_did_not_run`, not `completed`.

## NOT in scope

The readiness gate's own logic (it worked — it caught a real defect). The documented `state.flags.skip_quality_gates_reason` escape hatch (that is the operator-sanctioned way to bypass readiness; this finding is about the runner mis-handling a halt the operator did NOT choose to skip).
