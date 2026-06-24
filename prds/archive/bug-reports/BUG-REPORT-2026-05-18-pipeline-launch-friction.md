# Pickle Rick pipeline bug report — 2026-05-18

**Reporter:** gregory@loanlight.com
**Session:** `~/.local/share/pickle-rick/sessions/2026-05-18-6108815e`
**Pipeline:** `/pickle-pipeline` with `--refine`, `--scope branch`, 13 tickets (8 impl + 1 wiring + 4 hardening) for LOA-701 (Reducto bounding boxes)
**Outcome:** Operator-cancelled after second relaunch. Pickle phase **never ran a worker**; anatomy-park silently skipped; szechuan-sauce ran against a docs-only branch diff (no-op).
**Severity:** S2 — pipeline reports success while doing nothing useful. Operator must read raw logs to discover failure.

---

## Context

`/pickle-pipeline --refine docs/prd-loa-701-reducto-bounding-boxes.md` launched cleanly. Refinement (`/pickle-refine-prd`) ran the 3 analyst cycles successfully and produced `prd_refined.md` + 13 tickets. Branch `gregory/loa-701-...` was freshly checked out off `main` with no commits.

First launch (20:56:07Z): died at 1m 2s on `READINESS HALT: check-readiness exited 2`. Inspection of `readiness_2026-05-18.md` showed 25 findings, all "Referenced contract does not resolve" for symbols that the tickets intentionally CREATE (`FieldLocation.bbox`, `FieldLocation.coordSystem`, `AppraisalRunDetail.fieldSourceLocationMap`, `DocumentViewerProps.fieldLocationMap`, `appraisal_runs.field_source_location_map`, `ReductoCitation.field_path`, `appraisal.reducto.citation_coverage` log event, `featureFlags.appraisal_bbox_citations`, `viewport.transform`).

Per the runner's own hint, set `state.flags.skip_readiness_reason` and relaunched.

Second launch (21:36:13Z): readiness bypassed correctly. Hit a SECOND pre-flight gate the skill prompt did not warn about: `TICKET AUDIT HALT: audit-ticket-bundle exited 1; defects found — no manager spawn attempted`. Pickle exited code 1 in **1.5 seconds**. Runner classified this as "non-fatal" and proceeded to citadel → anatomy-park → szechuan-sauce — but pickle never spawned a worker, so no tickets were implemented. Anatomy-park silently skipped ("scope filter excluded all subsystems"). Szechuan ran against the commit-of-just-the-PRD-doc — a no-op.

This report covers 4 findings observed today. They overlap with existing master plan items (R-FRA, R-RTRC-7, R-QGSK) but add new data points and surface 3 unfiled UX/observability bugs.

---

## Bug 1 — `/pickle-pipeline` skill prompt documents deprecated skip flag names; new unified flag is undocumented

**What happened:** Skill prompt at `extension/.claude/commands/pickle-pipeline.md` § "Skip-flag overrides" reads:

> If pipeline launch halts at the readiness or ticket-audit pre-flight gate, edit `${SESSION_ROOT}/state.json` before relaunching and set:
> - `state.flags.skip_readiness_reason`
> - `state.flags.skip_ticket_audit_reason`

I set `skip_readiness_reason` and relaunched. Runtime emitted:
```
[2026-05-18T21:36:13.998Z] DEPRECATION: state.flags.skip_readiness_reason is legacy; prefer state.flags.skip_quality_gates_reason for unified quality-gate bypasses.
```

I had no idea `skip_quality_gates_reason` existed because the skill prompt never mentions it. Re-reading the master plan today (line 34 + line 134) confirms R-QGSK is the in-flight unification work, partial-shipped via `b2ddf584` and the rest "🔴 NEXT (P1, await operator)" as B-QSRC.

**Impact:** Operators following the skill prompt today will:
1. Set the legacy flag, eat a deprecation warning, work fine.
2. Hit the ticket-audit gate too (because that's a separate gate today) and have to set a SECOND legacy flag.
3. Have no idea the unified flag exists until they read MASTER_PLAN.

**Recommended fix (cheap):** Update `extension/.claude/commands/pickle-pipeline.md` § "Skip-flag overrides" to read:

> If pipeline launch halts at a quality gate, edit `${SESSION_ROOT}/state.json` and add:
>
> ```json
> "flags": { "skip_quality_gates_reason": "<reason string>" }
> ```
>
> Legacy: `skip_readiness_reason` and `skip_ticket_audit_reason` are still honored but emit a deprecation warning. Use the unified flag.

This is a 5-minute doc-only change that can land before B-QSRC.

**Cross-ref:** Master Plan B-QSRC (Finding #34 residuals).

---

## Bug 2 — `scope-resolver` import walk loops on grep timeout when branch diff is empty

**What happened:** First launch (`--scope branch` with 0 commits ahead of `main`) flooded window 0 with this message dozens of times before pickle was killed by the readiness halt:

```
scope-resolver import walk: grep timeout status=null signal=SIGTERM error=ETIMEDOUT
scope-resolver import walk: grep timeout status=null signal=SIGTERM error=ETIMEDOUT
scope-resolver import walk: grep timeout status=null signal=SIGTERM error=ETIMEDOUT
...
```

The pipeline-runner logged:
```
[2026-05-18T20:56:07.125Z] scope-setup WARN: SCOPE_EMPTY_DIFF — No files changed between origin/main and HEAD for mode=branch (continuing; build phase may produce diff)
```

So `scope-setup` correctly detected empty diff and warned — but then the import-walk pass apparently kept running and spawning grep subprocesses that timed out. ETIMEDOUT, retry, ETIMEDOUT, retry, for many seconds of CPU + log spam.

**Hypothesis:** `scope-resolver` does a 2-pass walk: (1) build initial file set from git diff, (2) "import walk" — follow imports from changed files transitively to expand scope. With an empty diff, step 2 should be a no-op (empty input → empty output). Instead it appears to be grepping something (possibly all of `node_modules/`?) and timing out per invocation, repeatedly.

After committing the PRD (giving the branch 1 commit ahead), the second launch's scope-setup ran clean: `scope-setup: mode=branch strategy=strict base=origin/main allowed=1`. No grep timeouts. So the bug specifically reproduces when the branch diff is empty.

**Recommended fix:**
1. `scope-resolver`: if the initial diff set is empty, short-circuit the import walk and return `allowed=0` (with a clear log). Don't grep at all.
2. Add a per-grep timeout cap (e.g. 5s) AND a total retry cap (e.g. 3 attempts) so a degenerate case can't burn unbounded wall-clock time.
3. `pipeline-runner` SCOPE_EMPTY_DIFF warning should ALSO advise: *"Tip: with `--scope branch` and 0 commits ahead, anatomy-park and szechuan-sauce may have nothing to operate on. Consider committing PRD/scaffolding before launch."*

**Severity:** S3 (UX + waste, not data loss).

---

## Bug 3 — Runner logs `Phase pickle completed successfully` immediately after `Phase pickle exited with code 1`

**What happened:** Second launch's runner log:

```
[2026-05-18T21:36:15.302Z] Phase pickle exited with code 1
[2026-05-18T21:36:15.319Z] Phase pickle exited with code 1 (non-fatal) — continuing to citadel for automated remediation
[2026-05-18T21:36:15.319Z] Phase pickle completed successfully
```

The third line is dishonest. Pickle exited with code 1 and never spawned a worker (ticket-audit gate halted before manager spawn — see `mux-runner.log` line `[2026-05-18T21:36:15.176Z] TICKET AUDIT HALT: audit-ticket-bundle exited 1; defects found — no manager spawn attempted`). 13 tickets remained in `Todo` status. Yet `pipeline-status.json` final state read `status: "failed"` only because szechuan also bailed; if szechuan had completed, the pipeline would have reported `status: "succeeded"` despite pickle having done literally nothing.

**Impact:** Operator who detaches and trusts the runner summary will miss that pickle did 0 work. Whole pipeline can show green with 0 tickets implemented.

**Recommended fix:** When `pipeline_continue_on_phase_fail` causes a non-fatal phase-1 exit, log:

```
Phase pickle FAILED (exit 1); pipeline_continue_on_phase_fail=true — proceeding to citadel for remediation
```

Do NOT log "completed successfully". Track distinct exit dispositions in `pipeline-status.json`:
- `phases_completed_successfully` (workers ran, work shipped)
- `phases_completed_with_remediation` (workers ran, remediation kicked in)
- `phases_skipped_no_work` (workers never spawned, e.g. gate halt + continue_on_fail)

A pipeline where pickle is in the third category should NOT report `status: "succeeded"` overall.

---

## Bug 4 — `anatomy-park` silently skips entire phase when scope filter excludes all subsystems

**What happened:**

```
[2026-05-18T21:36:17.008Z] scope-refresh: phase=anatomy-park head=5a45c371... allowed=1
[2026-05-18T21:36:17.128Z] anatomy-park: scope filter excluded all subsystems — skipping phase
[2026-05-18T21:36:17.129Z] Phase anatomy-park skipped (setup returned false)
```

The only file in the branch diff was `docs/prd-loa-701-reducto-bounding-boxes.md` (a markdown doc). Anatomy-park's subsystem registry presumably doesn't include `docs/`, so the scope filter returned empty, and the phase silently became a no-op.

This is partially correct behavior (anatomy-park genuinely has nothing to inspect), but the operator got no warning that one of their three requested phases didn't run. The final pipeline report counted it as a "skipped" phase in `pipeline-status.json` but did not surface it as a warning.

**Recommended fix:**
1. When `anatomy-park` / `szechuan-sauce` setup returns false because the scope filter is empty, emit a top-level WARN that surfaces in the final pipeline report:
   ```
   ⚠ anatomy-park did not run: scope=branch produced 0 in-scope subsystems.
     Branch diff was: docs/prd-loa-701-reducto-bounding-boxes.md
     Hint: this phase inspects code subsystems; doc-only diffs do not qualify.
   ```
2. Pipeline `Phases:` line in the report should distinguish: `pickle ✓ | citadel ✓ | anatomy-park 0/0 (scope empty) | szechuan ✓` — not just count of complete/skipped.

---

## Cross-ref to existing Master Plan items

- **Finding #34 (R-FRA / forward-create gate findings)** — readiness gate flagged my 25 forward-create contracts as ghost refs (`FieldLocation.bbox` etc.). Acknowledged; B-QSRC owns the fix.
- **Finding #34 residuals (R-QGSK / unified skip flag)** — partial-shipped via `b2ddf584`. Deprecation warning fires in production but unified flag not yet documented in `/pickle-pipeline.md` skill prompt → see Bug 1.
- **Finding #36+ (R-RTRC-7 / readiness exit semantics)** — readiness exited 2 with all 25 findings being legitimate future contracts. The gate succeeded in *flagging* them; it lacks an "expected-to-be-created" annotation so the operator must apply a blanket bypass.

These are not new — they confirm the operator-facing severity of the friction with concrete numbers (1 minute lost on first launch + skip-flag dance + 25-finding read to understand the gate output).

---

## Suggested filings

- **Bug 1** → trivially actionable; fix in `extension/.claude/commands/pickle-pipeline.md` doc edit. Could land alongside B-QSRC or before. **S3 / cli-ergonomics**.
- **Bug 2** → `scope-resolver` defensive coding. **S3 / pipeline-correctness**.
- **Bug 3** → runner log + status semantics. **S2 / observability** (false-green pipeline reports).
- **Bug 4** → silent-skip pattern across `anatomy-park` (and presumably `szechuan-sauce` and `citadel` when their scope inputs are empty). **S2 / observability**.

## Forensics retained

- Session: `~/.local/share/pickle-rick/sessions/2026-05-18-6108815e/` (kept; includes both `readiness_2026-05-18.md` + `audit-ticket-bundle.json` + `pipeline-runner.log` + `mux-runner.log`).
- LOA-701 branch: `gregory/loa-701-use-bounding-boxes-in-reducto-to-show-field-locations-in-doc` at commit `5a45c371a` (PRD-only).
- Operator decision pending: how to actually ship LOA-701 implementation work given the gate friction (skip both flags, or wait for B-QSRC, or run `/pickle-tmux` directly bypassing the pipeline orchestrator).

---

# Addendum — 2026-05-18 PM (post-launch execution failures)

Same session (`2026-05-18-6108815e`, LOA-701). After bypassing the launch-friction gates documented above, T01 worker ran 48m 45s across 3 iterations and produced **357 lines of real, on-spec spike code** (`citation-spike.ts` 141 LOC + `cost-latency-measure.ts` 216 LOC) that compile against the existing `reductoai@0.15.0` SDK and import the project's actual `schemas/reducto-1025.json`. Pickle orchestrator dropped both files on the floor uncommitted, marked T01 Failed, and the runner logged `Phase pickle completed successfully`. Then anatomy-park crashed on a stale scope-archive file from the previous launch.

Final state before operator salvage: T01 Failed, 0 commits, pipeline halted, **357 lines of usable Phase 0 work sitting untracked in the working tree** and almost lost. Operator salvaged via `git add` + `git commit` manually as `dbec6699d` and flipped T01 to Done in the session manifest, then relaunched at iteration 0 against T02. The same execution failures may recur on T02.

## Bug 5 — Worker produces real on-spec code but pickle orchestrator never commits; ticket wedges at Failed (Finding #2 class recurrence)

**What happened:** T01 worker (`fb4b547f`) completed Research and Plan phases cleanly (artifacts `research_2026-05-18.md`, `plan_2026-05-18.md` present in session dir). During Implement phase, worker wrote two files to the working tree:

- `packages/api/src/lib/appraisal-pipeline/citation-spike.ts` — 141 LOC, complete; uses Reducto SDK + the project's `schemas/reducto-1025.json`; runnable via `pnpm exec tsx`.
- `packages/api/src/lib/appraisal-pipeline/cost-latency-measure.ts` — 216 LOC, complete; 5-PDF p50/p95 latency + credit cost harness; matches AC-COST-1 mechanism.

Worker NEVER ran `git add` + `git commit`. T01 marked Failed. Iterations 2 and 3 verified Failed status (same HEAD = `5a45c371ad80671dadcca2d403e8d0d7548485ad`, no new commits) and the closer terminated:

```
[2026-05-18T22:31:28.783Z] closer_handoff_terminal: ticket fb4b547f remained Failed
on HEAD 5a45c371ad80671dadcca2d403e8d0d7548485ad for 2/2 consecutive iterations.
Exiting at iteration 3.
```

Pickle's wrapper then logged the false-green:
```
[2026-05-18T22:31:28.882Z] Phase pickle exited with code 0
[2026-05-18T22:31:28.884Z] Phase pickle completed successfully
```

Worker's final message in window 0 acknowledged the lost work:
> "The untracked `citation-spike.ts` and `cost-latency-measure.ts` remain in the working tree from iteration 1 — keep or `git restore`-equivalent at your discretion."

**Root cause hypothesis:** The R-WSRC `bash install.sh` ban + R-CTSF closer-handoff guards (v1.75.0-v1.75.2) + F1-F3+F5 surgical sweep (v1.75.5) introduce a closer/manager handoff contract that, when violated, prevents the worker from writing the completion commit. Worker writes code → worker tries to mark Done → markTicketDone gate refuses because `guardCompletionCommitBeforeDone` requires `completion_commit` evidence that doesn't exist yet → worker enters limbo → next iteration sees Failed and gives up.

The exact failure point requires a manager-side log dump from iteration 1 — worker_session_44321.log (116 bytes) and worker_session_76639.log (0 bytes) are nearly empty in T01's dir, which itself is a separate observability bug.

**Impact:** B-PIPE-FIX (Finding #34 + R-PIPE-2 family) is the explicit hardening for this class. This session is a fresh, post-v1.75.5 reproducer with full forensic artifacts retained. Use it to validate whatever R-PIPE-2 / R-PIPE-3 / R-PIPE-4 ship.

**Forensic data:**
- Session: `~/.local/share/pickle-rick/sessions/2026-05-18-6108815e/fb4b547f/`
- 357 LOC of recovered worker output: `git show dbec6699d:packages/api/src/lib/appraisal-pipeline/citation-spike.ts` + `git show dbec6699d:packages/api/src/lib/appraisal-pipeline/cost-latency-measure.ts`
- Iteration timeline: launch 21:42:43Z → iteration 1 done ~22:07Z (worker_session_76639.log empty) → iteration 2 done ~22:31Z (worker_session_44321.log near-empty) → iteration 3 closer_handoff_terminal at 22:31:28Z
- Total wasted wall-clock: 48m 45s

**Severity:** S2 — work IS being lost without operator intervention. Salvage requires reading window 0 capture-pane to discover what the worker actually did.

**Recommended fix:**
1. Master Plan's planned R-PIPE-2 `phase_no_progress` exit_reason directly addresses this.
2. Plus: when a worker writes files to the working tree but `markTicketDone` is blocked, the runner should auto-commit the worker's tree changes with a stub message before terminating the ticket as Failed. Lost work is worse than a noisy git history.
3. Plus: surface the working-tree diff prominently in pipeline-status.json when a phase exits non-zero with uncommitted changes. The current ASCII pane-capture method is not discoverable.

## Bug 6 — `refreshScope: archive already exists (refusing overwrite)` is fatal on pipeline relaunch

**What happened:** Second launch (`21:42:43Z` → pickle ran → citadel ran → anatomy-park hit). Anatomy-park's setup tried to write `archive/scope.anatomy-park.json` but the file already existed from the FIRST launch. Window 0:

```
🧪 Pipeline Phase: anatomy-park
  Phase:  3/4
  Target: /Users/gregorydickson/loanlight/loanlight-api

[FATAL] refreshScope: archive already exists (refusing overwrite):
  /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-18-6108815e/archive/scope.anatomy-park.json

Pipeline finished. Ctrl+B 1 → monitor | Ctrl+B D → detach
```

Exit. Pipeline state went to `exit_reason: "fatal"`, `active: false`. The archive directory at that point contained:
```
scope.anatomy-park.json
scope.szechuan-sauce.json
skipped_by_scope.anatomy-park.json
skipped_by_scope.szechuan-sauce.json
```

— all from launch #1 (or earlier).

**Root cause:** `refreshScope` (or equivalent in pipeline-runner) refuses to overwrite the scope-archive file as a safety check, but does not consider that a pipeline RELAUNCH legitimately should overwrite. There's no "this is a fresh run, archive the previous result" path.

**Impact:** Every pipeline relaunch against a previously-run session hits this. Operator must manually `rm -f $SESSION/archive/scope.*.json` between runs. Combined with Bug 5, an operator who hits a worker-commit failure cannot relaunch without also knowing to clean the scope archive.

**Severity:** S2 — undocumented manual cleanup step required for every relaunch.

**Recommended fix:**
1. `refreshScope` should either: (a) overwrite with previous file rotated to `scope.anatomy-park.<timestamp>.json`, or (b) emit a clear WARN naming the exact `rm` command an operator can run.
2. Better: `pipeline-runner` on startup should detect `exit_reason: "fatal"` in state.json and proactively clean the archive directory after warning.
3. Best: Pipeline launch should be idempotent against prior failed runs. Rotate-and-overwrite by default.

## Bug 7 — `MULTI-REPO DETECTED` warning on monorepo with workspaces (false positive)

**What happened:** Every launch logs:
```
⚠️  MULTI-REPO DETECTED: Tickets span [/Users/gregorydickson/loanlight/loanlight-api/packages/api,
  /Users/gregorydickson/loanlight/loanlight-api/packages/app,
  /Users/gregorydickson/loanlight/loanlight-api].
  Pickle Rick works best with single-repo sessions.
```

All three paths are the SAME monorepo (loanlight-api) at different `packages/` workspaces. The runner appears to compute "repos" from `working_dir:` frontmatter on each ticket without walking up to find a common `.git`.

**Severity:** S3 — cosmetic/false-alarm noise. Does not block execution.

**Recommended fix:** In the multi-repo detector, walk each `working_dir` up to its containing `.git` and dedupe. Only WARN if the resulting set has cardinality > 1.

## Updated finding numbers proposed for MASTER_PLAN

- **#52 R-WUWC** (Worker-Uncommitted-Work-Crash) — Bug 5 above. P2 (data-loss class). Use the LOA-701 T01 session as the regression fixture for R-PIPE-2/3/4 validation.
- **#53 R-SRAA** (Scope-Refresh-Archive-Already-exists) — Bug 6 above. P2 (every relaunch hits it).
- **#54 R-MRFP** (Multi-Repo False-Positive on monorepo) — Bug 7 above. P3 (noise).

