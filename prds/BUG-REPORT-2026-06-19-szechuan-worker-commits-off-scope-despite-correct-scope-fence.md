# BUG REPORT — szechuan-sauce worker commits off-scope files despite a correct, injected strict scope

**Filed:** 2026-06-19 (capture-only, babysitter)
**Code:** R-SSOC (Szechuan Scope Off-scope Commits)
**Priority:** P2 (pollutes the target branch with unrelated commits; silent — no violation event)
**Deployed runtime:** v2.0.0-beta.18
**Backend:** codex (`gpt-5.4`)
**Source incident:** session `2026-06-19-2b1e2707` (LOA-1387 bank-statement resilience, `/pickle-pipeline --backend codex`), szechuan-sauce phase.
**Operator-flagged:** Gregory observed "szechuan has historically stayed on focus" — i.e. this off-scope behavior is a regression, NOT the documented soft-scope-escape. Investigation confirms him.
**Siblings:** #95 B-SJWT (judge whole-tree scoring — shipped v1.98.0, apparently ineffective here); #126 R-CCEM / #127 R-DEFCHURN (codex-backend prompt-level gate adherence, same session).

## Summary

szechuan-sauce committed **7 commits touching only out-of-scope files** (appraisal-pipeline XML + LOS auth) onto the LOA-1387 branch, even though the scope was set correctly and strictly. The scope fence — both the judge-scoping (R-SJWT) and the per-commit preflight (`check-scope-diff.js`) — failed to keep the worker on the bank-statement scope. No `worker_edit_outside_scope` event was emitted, so the drift was **silent**.

## Evidence

1. **scope.json was correct and strict** — `strategy: strict, mode: branch`, 12 `allowed_paths`, all under `packages/api/.../bank-statement` (+ migration, prd, borrower-files schema). ZERO appraisal-pipeline or LOS paths.
2. **allowed_paths was injected** — `microverse.json.allowed_paths` = 12 paths (so Override 3's read-clamp had the data it needed).
3. **7 off-scope commits landed** (`8f5822326..9a5202abc`), touching only:
   - `src/lib/appraisal-pipeline/xml/**` (16 files)
   - `src/los/services/authentication.service.{ts,spec.ts}`
   - bank-statement files touched: **0**
   Commit subjects: `szechuan-sauce: DRY — deduplicate XML path traversal`, `… Fail-Fast — normalize LOS auth header arrays`, `… KISS — remove dead document form fallback`, etc.
4. **0 `worker_edit_outside_scope` events** in `state.json.activity` — the preflight (`check-scope-diff.js`, which emits this event on exit 1) never blocked the commits. The `check-scope-diff` strings present in the iteration logs are the **prompt text echoed**, not executions.
5. **Judge scored whole-tree** — baseline metric = **24** on a 12-file scope that anatomy-park had just driven to convergence (clean). A scope-correct judge would score ~0; 24 is a whole-repo slop count → the judge ignored `allowed_paths` (the R-SJWT symptom) and **directed the worker off-scope**.
6. **R-SJWT IS deployed** — beta.18's `microverse-runner.js` references `allowed_paths`; the v1.98.0 judge-scoping fix is present yet ineffective here.

## Root cause (two layers)

**L1 — judge whole-tree scoring (R-SJWT regression / codex gap).** The szechuan judge scored the entire repo (baseline 24) instead of the 12 `allowed_paths`, surfacing slop in appraisal-pipeline + LOS and steering the worker to "fix" it. R-SJWT-1 (scope judge prompt to allowed_paths) is in the deployed code but did not take effect for this codex run.

**L2 — commit preflight is prompt-level, not a hard hook.** `check-scope-diff.js` runs only because the szechuan-sauce.md worker prompt (line ~417) instructs the worker to run it before each `git commit`. There is **no runtime hook** enforcing it for microverse/szechuan workers (unlike the config-protection hooks that hard-block state.json / pickle_settings.json / install.sh). The codex worker, following the judge's off-scope findings, committed without running the preflight → drift was silent (0 events).

**Why anatomy-park (same backend, same session) stayed in scope:** its findings were genuinely in the bank-statement files, so it never tried to commit off-scope — when it DID hit scope (the trap-door catalog flush), it was correctly blocked (see #128 R-TDCS). szechuan's whole-tree judge is what pushed its worker out of bounds.

## Impact

- Off-scope commits silently pollute the target branch (here: 7 unrelated appraisal/LOS refactors mixed into an LOA-1387 PR). Caught only by manual `git log` inspection at the ship gate.
- Wasted codex tokens (52m / 7 iterations of off-scope deslop).
- Silent: no `worker_edit_outside_scope` event means `/pickle-status` and any drift dashboard show nothing.
- The operator's prior mental model ("szechuan stays on focus") is now false on the codex backend — escalates from cosmetic to branch-integrity.

## Proposed fix directions (capture-only — owner decides)

1. **Make the commit-preflight a hard hook, not a prompt instruction.** Enforce `check-scope-diff.js` in the bash-scanner / config-protection layer for any worker whose session has a `scope.json` — block the `git commit` if outside-scope paths are staged, regardless of backend prompt adherence. This is the durable fix (R-WSRC precedent: "prose alone failed; runtime hooks enforce").
2. **Verify/repair R-SJWT judge-scoping on the codex backend.** Confirm the judge prompt actually receives `allowed_paths` when the backend is codex; a baseline of 24 on a clean 12-file scope is the regression signal. Add a `judge_scope_applied` activity event so whole-tree scoring is observable.
3. **Emit a violation event even when the worker self-blocks or skips** — a post-iteration diff check (`git diff --name-only` vs `allowed_paths`) in the runner that fires `worker_edit_outside_scope` independent of the worker running the preflight. Closes the silent-drift gap.

Recommended: **#1 + #3** (hard enforcement + independent observability); #2 separately to stop the judge steering off-scope in the first place.

## Reproduction

1. `/pickle-pipeline --backend codex` on a branch with a small/clean in-scope diff (in-scope code already principled).
2. Let it reach szechuan-sauce with a strict `scope.json`.
3. Observe the judge baseline >> 0 (whole-tree) and szechuan committing files outside `allowed_paths`, with no `worker_edit_outside_scope` events.

## Recovery (what was done this incident)

Stripped the 7 off-scope commits via `git reset --hard <anatomy-HEAD>`; preserved them on branch `szechuan-offscope-backup-loa1387` first. Branch returned to pure in-scope state before PR.

## NOT in scope

- The #128 R-TDCS anatomy trap-door-flush-blocked-by-scope bug (opposite direction: over-fenced vs under-fenced).
- The LOA-1387 product work itself (shipped via PR #2284).
