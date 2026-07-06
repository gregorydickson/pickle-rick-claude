# P2 Bug-Fix Bundle — R-MPGD: microverse dirty-tree git detection must use the work-tree signal, not a naive `.git`-direct-child test

**Priority:** P2 (HIGH — reliability + honesty. No data loss: the build commits survive. But on **any
monorepo package subdir** — the common case, `packages/api`, `packages/app` — the two most expensive
review phases [anatomy-park, szechuan-sauce] are **silently skipped** and the pipeline reports
`4/4 completed successfully` on a green ledger. The recovery the operator expects *already exists* and
simply mis-fires.)
**Code:** R-MPGD (Microverse Preflight Git-Detection false-negative)
**Backend:** claude (repairs the review-phase microverse dirty-tree seam; codex irrelevant to the mechanism).
**Build-safety note:** **Pipeline-safe — NOT the R-PSRB salvage/completion/Done-flip path.** Edits live in
`extension/src/bin/microverse-runner.ts` (the dirty-tree preflight + auto-rescue seam) and the
phase-outcome classifier in `extension/src/bin/pipeline-runner.ts`. Neither touches
`salvage-ticket.ts` / `reconcile-ticket-truth.ts` / `ticket-completion-evidence.ts` / the mux-runner
Done-flip — the running pipeline executes DEPLOYED JS, so this builds normally on its own pipeline; the
closer's full gate is the authoritative backstop.
**Complexity tier:** WS-1 `complexity_tier: medium` (core review-phase runner; must run `test:fast` at
the worker gate — a `small`-tier gate fix would SKIP `test:fast` and can re-introduce exactly this
class). WS-2 `complexity_tier: small` (pipeline-runner labeling seam, cheap greppable verify).

---

## Context

Live forensics of pipeline session `2026-07-05-f923a9c4` (target `loanlight-api`, LOA-1570 Phase 5,
build→citadel→anatomy-park→szechuan-sauce, "4/4 completed", 124m). PICKLE committed 4/4 tickets clean;
CITADEL remediated 2 mechanical findings and **left them uncommitted** ([[B-CSOR]]), so the tree was
dirty entering the review phases. Then **both** microverse phases exited in **under one second, zero
passes**:

```
PHASE 3/4: ANATOMY-PARK … Anatomy Park setup complete
  microverse-runner: ERROR: Working tree is dirty — uncommitted in-scope changes detected. Aborting.
  microverse-runner: ERROR: No .git repository found at working directory. Cannot auto-commit.
Phase anatomy-park exited with code 1 (non-fatal) — continuing to szechuan-sauce for automated remediation
Phase anatomy-park completed successfully          ← reported as success
PHASE 4/4: SZECHUAN-SAUCE … (identical abort)
Pipeline finished: 4/4 phases, 124m 2s
```

`anatomy-park.json`: `pass_counts:{packages:0}`, `findings_history:{packages:[]}`. `pipeline-status.json`:
`{"status":"completed","completed_phases":4,"skipped_phases":0}`. The skip was invisible without reading
`microverse-runner.log`.

**Root cause (one sentence):** the microverse dirty-tree recovery gates on
`fs.existsSync(path.join(workingDir, '.git'))` — a naive direct-child test that only holds when `.git` is
an immediate child of `workingDir`, so it false-negatives on a monorepo package subdir (git root one
level up), git worktrees, and submodules, defeating a recovery path that already exists.

**Verified against source at `a7b8a7ef` (HEAD):**
- `microverse-runner.ts:2935` — `if (!fs.existsSync(path.join(workingDir, '.git'))) {` — the **setup
  preflight** (`preflightAutoCommit`). On false-negative it THROWS → the whole phase aborts at setup
  (`pass_counts:0`).
- `microverse-runner.ts:3619` — `if (!fs.existsSync(path.join(ctx.workingDir, '.git'))) {` — the
  **worker-timeout auto-rescue** (`autoRescueDirtyTree`). On false-negative it RETURNS/skips
  (`"Auto-commit skipped: not a git repository"`) → a timed-out worker's dirty in-scope output is
  **silently discarded** rather than salvaged (adjacent to the [[R-MACB]] salvage machinery this path
  already uses just below). So D1 has TWO failure modes on monorepo subdirs, not one.
- Precedent for the correct test already lives in-repo: `circuit-breaker.ts:225` uses
  `git rev-parse --is-inside-work-tree` with `cwd: workingDir`; `pipeline-runner.ts:655`/`:3273`,
  `mux-runner.ts:814`, `resolve-scope.ts:18` use `git rev-parse --show-toplevel`. This bundle REUSES that
  established signal.

Control only *reaches* `:2935` because `listWorkingTreeDirtyPaths(workingDir)` (`:2927`) already ran
`git status` from `workingDir` successfully — proving `workingDir` IS inside a work tree. Every other git
call in the file uses `cwd: workingDir` and works. **Only the two `existsSync` short-circuits are naive.**

Distinct from [[R-MACB]] (auto-rescue *scope-leak* — what gets staged), [[B-GNDT]] (launch-time
pre-pipeline preflight), and [[B-GNXR]] (no-progress discards uncommitted output). Source of the
inter-phase dirt is [[B-CSOR]] (citadel remediation left uncommitted) — a separate, deeper fix; this
bundle is the safety net that makes the *existing* recovery fire.

---

## WS-1 — R-MPGD-A: one shared work-tree test at BOTH microverse git-detect sites

### Problem
Two sites gate the microverse dirty-tree recovery on `fs.existsSync(path.join(<dir>, '.git'))`, a test
that is not a git-repo test — it false-negatives on monorepo subdirs / worktrees / submodules and
true-positives for a stray `.git` file. A partial fix touching only `:2935` leaves the `:3619` rescue
path broken and still losing timed-out work.

### Fix (reuse-first, net-subtraction: 2 naive checks → 1 correct helper)
1. **Extract ONE shared helper** in `microverse-runner.ts` (module-local, near the other git helpers,
   e.g. beside `getGitRestoreArgs`):
   ```ts
   function isInsideWorkTree(dir: string): boolean {
     // reuse the signal the file's dirty-detection already trusts; finite timeout, never throws
     try {
       const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
         cwd: dir, encoding: 'utf8', timeout: <existing git-timeout const>, stdio: ['ignore', 'pipe', 'ignore'],
       });
       return out.trim() === 'true';
     } catch { return false; }
   }
   ```
   Match the exact `execFileSync`/`runCmd` idiom + timeout constant already used in this file (do not
   invent a new subprocess wrapper — R-OMTD/subprocess-audit require a finite timeout on every spawn).
2. **Replace BOTH gates** with `if (!isInsideWorkTree(<dir>)) {` — `:2935` (workingDir, keeps the THROW:
   genuinely-not-a-repo is a real abort) and `:3619` (ctx.workingDir, keeps the RETURN/skip). Behavior on
   a genuine non-repo is UNCHANGED; only the false-negative on a real work tree is corrected, so the
   by-design auto-commit (`:2940`–`:2946`) and the auto-rescue salvage (`:3623`+) now fire in the
   monorepo-subdir case.
3. **DELETE** the now-dead naive checks (no fallback to `existsSync` — the work-tree signal subsumes it).

### Acceptance criteria (machine-checkable)
- **AC-MPGD-A1** `grep -c "existsSync(path.join(workingDir, '.git'))\|existsSync(path.join(ctx.workingDir, '.git'))" extension/src/bin/microverse-runner.ts` → **0** (both naive gates removed).
- **AC-MPGD-A2** `grep -c "function isInsideWorkTree" extension/src/bin/microverse-runner.ts` → **1**; both former gate sites call it.
- **AC-MPGD-A3** unit test: `preflightAutoCommit` invoked with `workingDir` = a subdir INSIDE a git repo (no direct-child `.git`) and one dirty in-scope file **auto-commits** (does not throw "not a git repo"); invoked with a genuinely-non-git tmp dir still **throws**.
- **AC-MPGD-A4** unit test: `autoRescueDirtyTree` on a monorepo-subdir `ctx.workingDir` with dirty in-scope output **stages/salvages** (does not log "not a git repository" / skip).
- **AC-MPGD-A5** `isInsideWorkTree` passes a finite `timeout` to its git spawn (subprocess-audit clean).
- **AC-MPGD-A6** full worker gate green (`tsc --noEmit` + `eslint` + `test:fast`).

---

## WS-2 — R-MPGD-B: a 0-pass setup-abort is `skipped`/`setup_aborted`, not `completed successfully`

### Problem
`pipeline-runner.ts` treats the exit-1 as non-fatal and then unconditionally logs
`Phase … completed successfully` (`:4137`) with `skipped_phases:0`. A phase that aborted at setup with
**zero passes / no gap-analysis started** is indistinguishable in the ledger from one that ran fully and
found nothing. The non-fatal *continue* policy is correct; the *labeling* is a honesty defect — a green
ledger that hides silently-deleted phases is exactly the GA-bar honesty gate.

### Fix (labeling only — keep the non-fatal continue policy)
1. At the `getPhaseExitReason` seam (`pipeline-runner.ts:2873`–`:2889`, which already discriminates
   `non-fatal … exit_reason=…`), classify a microverse phase that exited non-zero **with `pass_counts`
   all 0 / no gap-analysis started** as `setup_aborted` (a distinct `exit_reason`), NOT the ran-and-clean
   success path. Read the already-persisted `anatomy-park.json` / `<phase>.json` `pass_counts` the runner
   already writes — no new state field.
2. Count a `setup_aborted` phase toward `skipped_phases` (increment the existing `counters.skipped`
   already threaded to `skipped_phases` at `:3086`/`:3311`/`:3375`/`:3772`), and surface it in
   `pipeline-status.json` and the final banner (`… 4/4 phases (N setup-aborted)`).
3. Do NOT log `Phase … completed successfully` for a `setup_aborted` phase — log
   `Phase … setup-aborted (0 passes) — review did not run` instead. No new activity event (event
   registration is a recurring closer-bug class); reuse the existing exit-reason log line.

### Acceptance criteria (machine-checkable)
- **AC-MPGD-B1** unit/integration test: a microverse phase exiting non-zero with `pass_counts` all 0 yields `exit_reason` containing `setup_aborted` and increments `skipped_phases` (NOT `completed_phases` as a success).
- **AC-MPGD-B2** the same test asserts the banner / `pipeline-status.json` surfaces the skip (`skipped_phases >= 1`), and the phase is NOT logged `completed successfully`.
- **AC-MPGD-B3** regression guard: a microverse phase that RAN and found nothing (non-zero exit, `pass_counts >= 1`) is STILL `completed successfully` with `skipped_phases` unchanged — the fix separates "never ran" from "ran, clean," it does not re-classify clean runs.
- **AC-MPGD-B4** full worker gate green.

---

## Simplification Review (subtract-before-add)

**WS-1 (R-MPGD-A).**
1. *Necessary?* Yes — the false-negative silently deletes two review phases and loses timed-out work on
   the common monorepo-subdir case.
2. *Reuse vs add?* **Reuse.** `git rev-parse --is-inside-work-tree` is already the signal the file's own
   dirty-detection (`git status` from `workingDir`) relies on, and is used verbatim at
   `circuit-breaker.ts:225`. No new dependency, no new state field. One module-local helper.
3. *Guards a brittle thing?* Yes — it removes a naive guard rather than wrapping it. The `existsSync`
   check is deleted, not band-aided with a second fallback.
4. *Subtracts?* **Yes — net-subtraction: 2 divergent naive checks → 1 correct shared helper.** Collapses
   a duplicated wrong-test seam (the [[feedback_analyze_failures_then_subtract_not_add_guards]] "collapse
   seams, don't gate them" move).

**WS-2 (R-MPGD-B).**
1. *Necessary?* Yes — a green ledger hiding a silently-deleted phase is a honesty defect on the GA bar.
2. *Reuse vs add?* **Reuse** the existing `getPhaseExitReason` discriminator, the existing
   `counters.skipped`→`skipped_phases` thread, and the already-persisted `<phase>.json` `pass_counts`. No
   new state field, **no new activity event**.
3. *Guards a brittle thing?* It corrects an over-broad "non-fatal ⇒ success" label; it narrows an
   existing seam, adds no new gate.
4. *Subtracts?* Removes the unconditional `completed successfully` on the setup-abort path — one honest
   label replaces one dishonest one; no machinery added.

---

## Non-goals / out of scope
- **B-CSOR** (citadel remediation left uncommitted — the *source* of the inter-phase dirt) is a separate,
  deeper fix. This bundle is the safety net that makes the existing recovery fire regardless.
- Changing the non-fatal *continue* policy (a failed review phase should still not abort the pipeline).
- **R-MACB** auto-rescue scope-leak (WHAT gets staged) — already shipped beta.37; this fixes WHETHER the
  rescue runs at all on a monorepo subdir.

## Build / verify
Build on claude via `/pickle-tmux` or `/pickle-pipeline`. Deploy `bash install.sh`. The closer's full
release gate (`tsc --noEmit && eslint && tsc && audits && test:fast:budget && test:integration &&
RUN_EXPENSIVE_TESTS=1 test:expensive`) is the authoritative backstop. Field-proof: re-run a
build→citadel→anatomy-park→szechuan pipeline whose ticket `working_dir` is a monorepo package subdir and
confirm anatomy-park/szechuan actually run their loops (`pass_counts >= 1`) instead of aborting <1s.
