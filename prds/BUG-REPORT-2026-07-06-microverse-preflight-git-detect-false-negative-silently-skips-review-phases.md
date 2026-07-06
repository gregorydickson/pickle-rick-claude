# BUG REPORT — microverse `preflightAutoCommit` git-repo detection is a naive `.git`-direct-child check; false-negatives in a monorepo package subdir, so the dirty-tree auto-commit recovery never fires and anatomy-park + szechuan silently no-op (reported as "completed successfully")

**Filed:** 2026-07-06 (live forensics of pipeline session `2026-07-05-f923a9c4`, target `loanlight-api`, LOA-1570 Phase 5 — build→citadel→anatomy-park→szechuan-sauce, 4/4 phases "completed", 124m)
**Code:** R-MPGD (Microverse Preflight Git-Detection false-negative)
**Priority:** P2 (reliability/observability — no data loss; the build commits survive, but two requested review phases are **silently skipped** and the pipeline reports success. The recovery machinery the operator expects *already exists* and simply mis-fires.)
**Component:** `preflightAutoCommit` (`extension/src/bin/microverse-runner.ts:2926`, esp. the `.git` existence gate at `:2935`); phase-outcome reporting (`extension/src/bin/pipeline-runner.ts:2930`/`:2933`/`:4137`)

## Symptom (observed)

A full pipeline ran clean through PICKLE (4/4 tickets committed: `fe7b0d84a`, `c679e806f`, `6c6a73acb`, `65f0ce8fa`) and CITADEL (2 cycles; remediated 2 mechanical findings; 7 advisory left; exit 0). Then **both** review phases exited in **under one second** with **zero passes**:

```
PHASE 3/4: ANATOMY-PARK … Anatomy Park setup complete
  microverse-runner: ERROR: Working tree is dirty — uncommitted in-scope changes detected. Aborting.
  microverse-runner: ERROR: No .git repository found at working directory. Cannot auto-commit.
Phase anatomy-park exited with code 1 (non-fatal) — continuing to szechuan-sauce for automated remediation
Phase anatomy-park completed successfully          ← reported as success
PHASE 4/4: SZECHUAN-SAUCE … (identical abort)
Phase szechuan-sauce completed successfully
Pipeline finished: 4/4 phases, 124m 2s
```

`anatomy-park.json` confirms the no-op: `pass_counts:{packages:0}`, `findings_history:{packages:[]}`, `trap_doors_added:[]`. The two deep-review phases the operator asked for **never ran their loops** — yet `pipeline-status.json` reads `{"status":"completed","completed_phases":4,"skipped_phases":0}`. The skip was invisible without reading `microverse-runner.log`.

**What made the tree dirty between phases:** CITADEL's mechanical remediator ([[B-CSOR]] graduated remediation) edited two FR-E1 files (`appraisal.processor.ts`, `ssr-eval-injection.spec.ts` — ESLint `curly` brace-blocking) and **left them uncommitted**. So PICKLE's clean tree became dirty *during* citadel, and the next phase inherited it.

## Root cause

Two coupled defects. The primary one **defeats a recovery path that already exists.**

### D1 (primary) — `.git`-as-direct-child is the wrong git-repo test

`preflightAutoCommit` (`microverse-runner.ts:2926`) is *designed* to auto-commit a dirty in-scope tree before the microverse loop starts (`:2940` `"Working tree is dirty — auto-committing before microverse start"` → `:2946` `git commit -m 'microverse: auto-commit dirty tree before start'`). The recovery the operator expects is right there. But it is gated at `:2935`:

```ts
if (!fs.existsSync(path.join(workingDir, '.git'))) {
  log('ERROR: Working tree is dirty — uncommitted in-scope changes detected. Aborting.');
  log('ERROR: No .git repository found at working directory. Cannot auto-commit.');
  throw new Error('Working tree is dirty — not a git repo, cannot auto-commit');
}
```

`fs.existsSync(path.join(workingDir, '.git'))` only holds when `.git` is a **direct child** of `workingDir`. In this run `workingDir` was the package subdir `packages/api` (the tickets' `working_dir`), a monorepo package whose git root is one level up:

- `/Users/gregorydickson/loanlight/loanlight-api/.git` — exists (directory)
- `packages/api/.git` — **does not exist**
- `git rev-parse --show-toplevel` from `packages/api` → `…/loanlight-api` (git works fine from the subdir)

Proof it is inside a work tree: control only *reached* `:2935` because `listWorkingTreeDirtyPaths(workingDir)` (`:2927`) returned dirty paths — i.e. `git status` succeeded from `workingDir`. Every other git call in the file (`getGitRestoreArgs:422`, `stageOwnedPaths`, `git commit`) uses `cwd: workingDir` and would have worked. **Only the `existsSync` short-circuit is naive.** It also false-negatives for git worktrees/submodules (where `.git` is a file, not always at `workingDir`), and true-positives for a stray `.git` file placed anywhere — it is simply not a git-repo test.

### D2 (secondary) — a 0-pass setup-abort is reported as "completed successfully"

`pipeline-runner.ts` treats the exit-1 as non-fatal (`:2930` "continuing … for automated remediation", `:2933` "pipeline complete with non-zero phase exits") and then unconditionally logs `Phase … completed successfully` (`:4137`) and writes `skipped_phases:0`. A phase that aborted at setup with **zero passes** is indistinguishable in the ledger from one that ran fully and found nothing. The non-fatal policy is correct for "review ran, found nothing"; it is wrong for "review never ran." There is no signal that separates the two.

## Impact

Any pipeline whose `workingDir` is a monorepo package subdir (the common case — `packages/api`, `packages/app`, etc.) will:
1. Have CITADEL (or any prior phase) leave uncommitted in-scope changes, then
2. Hit D1 → **every** downstream microverse phase (anatomy-park, szechuan-sauce, and by the same path microverse/death-crystal) aborts at setup instead of auto-committing, and
3. Hit D2 → the pipeline reports `4/4 completed successfully`.

Net: the two most expensive review/deslop phases are **silently deleted** from every monorepo-subdir run, with a green ledger. This is exactly the "should recover, doesn't" class the operator flagged. It is adjacent to but distinct from [[R-MACB]] (microverse auto-rescue *scope-leak*), [[B-GNDT]] (launch-time gitnexus dirty-tree self-brick — a *different*, pre-launch preflight in `pipeline-runner`), and [[B-GNXR]] (no-progress discards uncommitted output).

## Fix direction (subtract-before-add)

**D1 — reuse the git detection the file already relies on; delete the naive check.** Replace the `fs.existsSync(path.join(workingDir, '.git'))` gate at `:2935` with the same signal the dirty-detection already trusts — `git rev-parse --is-inside-work-tree` (or `--show-toplevel`) executed with `cwd: workingDir`. No new dependency, no new state: `preflightAutoCommit` already shells git from `workingDir` three lines later. If that command succeeds, auto-commit (as designed); only if it genuinely fails (not a work tree at all) do we abort. This single-line correction makes the existing recovery fire in the monorepo-subdir case — which *is* the recovery the operator expects.
- Consider committing the citadel remediation under a citadel-attributed message rather than the generic `microverse: auto-commit dirty tree before start`, OR (cleaner, at the source) have CITADEL's remediator commit its own mechanical fixes ([[B-CSOR]]) so no phase inherits a dirty tree in the first place. Prefer fixing the source; D1 is the safety net.

**D2 — make "never ran" a distinct, loud phase outcome.** When a microverse phase exits non-zero **with `pass_counts` all 0 / no gap-analysis started**, classify it as `skipped`/`setup_aborted`, not `completed successfully`: increment `skipped_phases`, surface it in `pipeline-status.json` and the final banner. Do not silently fold a setup-abort into the "ran, found nothing" success path. (The `getPhaseExitReason` seam at `pipeline-runner.ts:2873`–`:2889` is the natural home — it already discriminates `non-fatal … exit_reason=…`.)

## Repro (deterministic)

1. Run `build→citadel→anatomy-park→szechuan-sauce` on any monorepo where the ticket `working_dir` is a package subdir (git root one level up).
2. Ensure citadel produces ≥1 mechanical remediation (it left the edits uncommitted).
3. Observe anatomy-park + szechuan abort <1s at `preflightAutoCommit:2935` with "No .git repository found", `pass_counts:0`, and a green `4/4 completed` ledger.

Minimal unit repro for D1: call `preflightAutoCommit(subdirInsideRepo, log)` with one dirty in-scope file, where `subdirInsideRepo` has no direct-child `.git`; today it throws "not a git repo", should auto-commit.

---

## Review addendum (2026-07-06 — verified against source at HEAD `8f94f620`)

**D1 core claim VERIFIED** — `microverse-runner.ts:2935` is exactly `if (!fs.existsSync(path.join(workingDir, '.git')))`, gating the by-design auto-commit at `:2940`–`:2946`. Diagnosis and the `git rev-parse --is-inside-work-tree` fix direction are correct and reuse-first (pure subtraction: delete the naive check, reuse the git signal the file's dirty-detection already trusts).

**⚠️ Blast radius undercounted — the SAME naive check exists at a SECOND site the report missed:** `autoRescueDirtyTree` (`microverse-runner.ts:3610`) gates its worker-timeout dirty-tree RESCUE on the identical `if (!fs.existsSync(path.join(ctx.workingDir, '.git')))` at `:3619`. There it **returns/skips** (`"Auto-commit skipped: not a git repository"`) rather than throwing — so on a monorepo package subdir a timed-out worker's dirty in-scope output is **silently discarded** instead of salvaged (adjacent to the [[R-MACB]] salvage machinery this path already uses at `:3623`+). So D1 has TWO failure modes on monorepo subdirs: setup-abort (`:2935`, skips the whole phase) AND rescue-skip (`:3619`, loses timed-out work).

**Fix refinement:** extract ONE shared `isInsideWorkTree(dir)` helper (`git rev-parse --is-inside-work-tree`, `cwd: dir`, finite timeout) and use it at BOTH `:2935` and `:3619` — a partial fix that only touches `:2935` leaves the rescue path broken. Still reuse-first / net-subtraction (2 naive checks → 1 correct helper). This is a shared-seam refactor across 2 sites + the D2 classification, NOT the "single-line" the body implies.

**D2 sound + honesty-relevant.** "0-pass setup-abort reported as `completed successfully` on a green ledger" is not just observability — it is the **honesty** gate the GA bar rides on (a green ledger that hides silently-deleted phases). The `getPhaseExitReason` seam (`pipeline-runner.ts:2873`) is the right home. Keep the non-fatal *continue* policy (correct); only fix the *labeling* (setup-abort ≠ ran-and-clean).

**Priority:** P2 confirmed (no data loss — build commits survive), but it is a HIGH P2: every monorepo-subdir pipeline (the common case) silently deletes its two most expensive review phases with a green ledger. Recommend building alongside — or ahead of — lower-impact P2s.

**Verdict: ACCEPT.** Real, verified, reuse-first. Ready to scope into a fix PRD covering both call sites (D1 shared helper) + the D2 phase-outcome classification. Pipeline-safe (NOT R-PSRB — `preflightAutoCommit`/`autoRescueDirtyTree` are the microverse dirty-tree seam, not the salvage/completion/Done-flip path; the running pipeline executes deployed JS).
