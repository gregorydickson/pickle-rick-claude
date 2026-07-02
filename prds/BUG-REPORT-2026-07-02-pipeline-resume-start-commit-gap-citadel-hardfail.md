# BUG REPORT — paused-PRD → `/pickle-pipeline` resume strands `state.start_commit` (citadel hard-fails) — the MIRROR of the shipped R-PRPATH fix

**Filed:** 2026-07-02 (surfaced babysitting a `/pickle-pipeline` run, session `2026-07-01-04e99002`, LOA-1356 collateral-risk-score)
**Code:** R-PSCG (Pipeline Start-Commit Gap)
**Priority:** P2 — by *outcome* identical to the P1 [[R-PRPATH]] (citadel un-runnable on the standard paused-PRD → refine → pipeline path; the pipeline can NEVER reach review even on a perfectly clean build). Rated P2 only because (a) the self-heal machinery R-PRPATH added already exists — the fix is a ~3-line **symmetric extension**, not new infra — and (b) the operator workaround is trivial and now documented ([[reference_pickle_pipeline_resume_missing_start_commit]]).
**Component:** `extension/bin/pipeline-runner.js` citadel preflight (`:2062-2075`); `extension/bin/setup.js` start-commit computation (`:1308`)

## Symptom (observed)

Build phase ran flawlessly — 11/11 tickets Done, 16 commits, ~170 min, full lifecycle, zero mid-run intervention. Then at the phase boundary:

```
PHASE 2/4: CITADEL (backend=claude)
citadel: missing state.prd_path or state.start_commit — failing phase
Phase citadel exited with code 1
Phase citadel failed (exit 1) — stopping pipeline
Pipeline finished: 1/4 phases, 170m 28s
```

The whole review tail (citadel → anatomy-park → szechuan-sauce) never ran. `state.prd_path` **was** set (`…/prd_refined.md`); **`state.start_commit` was absent.**

## Root cause (verified, not guessed)

This is the **exact mirror of [[R-PRPATH]]** (B-ORSR, shipped 2026-06-11). That bug was `start_commit` present + `prd_path` unset; its fix (`pipeline-runner.js:2062-2071`, AC-R-PRPATH-2) added a **one-sided self-heal**: when `!prdPath && state.start_commit`, adopt `${SESSION_ROOT}/prd_refined.md`|`prd.md` and log `citadel: self-healed missing state.prd_path`. There is **no inverse branch.** The hard-fail directly below it —

```js
// pipeline-runner.js:2074
if (!prdPath || !state.start_commit) {
    runtime.log('citadel: missing state.prd_path or state.start_commit — failing phase');
    // → exit 1
```

— still fires for the opposite gap: `prd_path` present, `start_commit` unset. My run hit that inverse.

**Why `start_commit` was unset (the origin):** `setup.js:1308` (`state.start_commit = startCommit`) computes the base only when the working_dir is a resolvable git repo at setup time. The *initial* `setup.js --paused` for the PRD draft ran with **working_dir = `/Users/gregorydickson/loanlight`**, which is **NOT a git repo** (documented repo invariant — each subdir is its own repo). So `start_commit` was never computed. The later `setup.js --tmux --resume` did **not** recompute it (resume assumes prior state is complete), and the working_dir was subsequently repointed to the LOA-1356 worktree by hand — but nothing ever back-filled `start_commit` against that now-valid repo.

So two composing gaps:
1. **Asymmetric self-heal** — the R-PRPATH fix healed one of the two citadel-required fields; the sibling field has no self-heal.
2. **`setup.js` leaves `start_commit` silently unset** when `--paused` runs in a non-git cwd, and `--resume` never recomputes it even though resume happens in the real repo/worktree.

## Impact

- **The pipeline cannot reach ANY review phase on the paused-PRD → refine → pipeline path** whenever the paused draft was created outside a git repo (the LoanLight-normal case — the `loanlight/` root is not a repo; sessions are routinely drafted there). Build succeeds, then citadel hard-fails at the first phase boundary → citadel/anatomy-park/szechuan-sauce all skipped, "1/4 phases".
- **Same outcome-severity as the P1 R-PRPATH** it mirrors — "citadel un-runnable on the refine→pipeline path" — just on the other required field.
- **Silent until the boundary:** the whole ~170 min build completes before the halt surfaces, so the operator only discovers the un-runnable review tail after the expensive part is done.

## Reproduction

1. `setup.js --paused --task …` from a **non-git cwd** (e.g. `loanlight/` root) → drafts session, `start_commit` unset.
2. `/pickle-refine-prd` (writes `prd_refined.md`, sets `state.prd_path`).
3. `setup.js --tmux --resume <session>` + `pipeline.json` phases `[pickle, citadel, …]`, working_dir/target = a real worktree.
4. Pipeline builds all tickets, then citadel `exit 1` on `missing … state.start_commit`.

Deterministic given step 1's non-git cwd.

## Workaround applied (this run)

```
state.start_commit = git -C <worktree> merge-base origin/main HEAD   # = dce00abe…
pipeline.json.phases = ["citadel","anatomy-park","szechuan-sauce"]   # drop the finished pickle phase
relaunch launch.sh → PHASE 1/3 CITADEL, scope-setup mode=branch strict base=origin/main allowed=23  ✅
```

## Fix direction (reuse-first; extends the existing R-PRPATH self-heal — no new machinery)

- **AC-R-PSCG-1 (symmetric self-heal — smallest, highest-value):** in the citadel preflight, when `prdPath` is present but `state.start_commit` is unset AND the target repo is a git repo, adopt a computed base rather than hard-failing — `git merge-base <default-branch> HEAD` (or `--fork-point`), log `citadel: self-healed missing state.start_commit — adopted <sha>`, mirroring the `prd_path` self-heal at `:2062-2071`. Assert: a session with `prd_path` set, `start_commit` unset, worktree on a feature branch runs citadel instead of `exit 1`.
- **AC-R-PSCG-2 (fix at the origin):** `setup.js --resume` MUST recompute `state.start_commit` when it is unset and the (possibly newly-set) working_dir/target IS a git repo. Assert: after `--paused` in a non-git cwd → `--resume <session>` in a worktree, `jq -r .start_commit state.json` is a valid commit.
- **AC-R-PSCG-3 (loud, not silent):** when `setup.js --paused` runs in a non-git working_dir, WARN that `start_commit` is deferred (do not leave it silently unset). Assert: the warn fires; a later resume in a git repo clears it.
- **AC-R-PSCG-4 (regression):** scripted `--paused`(non-git cwd) → refine → `--resume` fixture reaches PHASE 2 CITADEL without the `missing state.start_commit` failure.

## Cross-links

- **Mirror of [[R-PRPATH]]** (B-ORSR, `archive/bug-reports/BUG-REPORT-2026-06-11-pipeline-resume-prdpath-gap-and-crash-strands-tree.md`) — same paused-refine→resume citadel-required-field gap, opposite field; the R-PRPATH fix should arguably have healed BOTH fields. Also related to [[B-LERD]] ("citadel handoff missing state.prd_path").
- Same shared-worktree / multi-repo context as [[reference_loanlight_api_shared_checkout_branch_race]] and the scope-resolver [[R-SSBR]] (both surfaced babysitting `/pickle-pipeline`).
- Operator memory: [[reference_pickle_pipeline_resume_missing_start_commit]] (the workaround).

**Capture-only** (per the babysitter bug-capture practice — filed, registered in `MASTER_PLAN.md` + `BUG-INDEX.md`, not fixed in this session).
