---
title: P1 bug-fix bundle — B-CXOR — codex-backend orphan-reset (git-boundary hook bypass → false-Done at baseline)
status: NEXT (P1 drain-queue row 1)
filed: 2026-06-03
priority: P1
type: bug-bundle
code: B-CXOR
composes:
  - "#94 R-CXOR — codex-backend workers/managers bypass the R-WSRC-GR git-boundary PreToolUse hook; a `git reset` to baseline on gate/validation failure orphans all per-ticket commits, and the manager marks the ticket Done with completion_commit==start_commit (false-Done). Pipeline 'advances' landing ZERO work."
backend_constraint: any
schema_neutral: true   # adds detection/guard logic + (likely) a new activity event; no LATEST_SCHEMA_VERSION change
source:
  - prds/MASTER_PLAN.md   # finding #94
  - "incident: session 2026-06-03-0ff3f112 (death-crystal-deepening, --backend codex)"
  - "memory: project_codex_pipeline_deterministic_orphan_reset"
---

# B-CXOR — codex-backend orphan-reset

## Trigger

Finding #94 (R-CXOR). Live incident 2026-06-03, session `0ff3f112` (`/pickle-pipeline ... --backend codex` on the death-crystal-deepening PRD). The pipeline ran 9 iterations, marked 4 tickets Done, and landed **zero** work in HEAD:

- HEAD stayed **frozen** at the pre-launch baseline `82cbb4ad` (= `state.start_commit` == `state.pinned_sha`) across all 9 iterations.
- `git fsck --no-reflogs` showed **10+ dangling commits** — each worker committed real work, then a `git reset` threw it off HEAD.
- **All 4 "Done" tickets carried `completion_commit: 82cbb4ad`** (the baseline) — false-Done markers; the real work was orphaned.
- `mux-runner.log` showed `between-ticket fast gate for <ticket>: failed (1 failure(s))` immediately before the reset.

The babysitter recovered by killing the run and `git merge --ff-only origin/main` (work was safe on origin). But the runtime should never have let this happen, and a re-launched codex pipeline will re-wedge.

## Root cause (per the incident; confirm exact reset call site in research)

1. The R-WSRC-GR **git-boundary enforcement** (`git reset`/`checkout`/`stash`/`rebase` → `{decision:'block'}`) lives in `extension/src/hooks/handlers/config-protection.ts`, dispatched by `extension/src/hooks/dispatch.ts` as a **Claude Code PreToolUse hook**.
2. That hook fires only for the **claude** process's tool calls. A **codex** backend runs the worker/manager as a `codex exec` subprocess (see `backend-spawn.ts`); its bash calls do **not** route through Claude Code's hook dispatch — so the `git reset` block is **bypassed**.
3. On a between-ticket gate / validation failure the codex agent runs `git reset` (to "clean" the failed tree) instead of a path-scoped `git restore`, orphaning its own commit. Claude workers can't do this (the hook blocks them); codex workers can.
4. The Done-marking path accepts `completion_commit == start_commit` as valid evidence, so the orphaned ticket is recorded Done against the baseline sha — a false-Done. The pipeline advances with HEAD never moving.

## In scope

- **Backend-agnostic git-boundary enforcement**: codex (and any non-claude subprocess) must be prevented from — or detected-and-recovered after — a HEAD-regressing `git reset`.
- **False-Done guard**: reject `completion_commit == start_commit`/`pinned_sha` as completion evidence.
- **Post-iteration HEAD-regression detection + recovery**: ff-reattach the orphaned commit or fail the ticket honestly.
- Regression tests + trap-door pins.
- Closer (gate, bump, install.sh, push, release, MASTER_PLAN repoint closing #94).

## Not in scope

- Re-running the death-crystal-deepening pipeline (separate; relaunch on claude per operator).
- Sandboxing codex's filesystem wholesale (a wrapper-git or post-hoc audit suffices).
- Claude-backend behavior (already protected by the PreToolUse hook).

## Atomic tickets

> Each ticket's research phase MUST confirm the exact reset call site (worker vs manager vs between-ticket cleanup) and the cleanest enforcement point before editing.

### R-CXOR-1 (medium) — Post-iteration HEAD-regression detection + recovery
- **Scope:** in `mux-runner.ts` (per-ticket completion path), after a worker/manager iteration, compare current HEAD to the iteration's recorded pre-iteration commit. If HEAD has **regressed at or below `start_commit`/`pinned_sha`** while the ticket claims Done, the worker's commits are orphaned: locate the orphaned tip (reflog/`fsck`) and **`git merge --ff-only <orphan>`** to reattach, OR if unrecoverable mark the ticket **Failed** (never Done). Emit a `worker_head_regression_detected` activity event.
- **AC-CXOR-1-1:** a regression test simulating a worker that commits then `git reset`s to baseline asserts the orchestrator detects the regression and (a) reattaches the orphaned commit (HEAD advances past baseline) OR (b) marks the ticket Failed — and NEVER leaves it Done at baseline.
- **AC-CXOR-1-2:** `grep -c "worker_head_regression_detected" extension/src/types/index.ts` ≥ 1 (event registered + schema entry; payload passes `activity-event-payload.test.js`).

### R-CXOR-2 (small) — False-Done guard (completion_commit ≠ baseline)
- **Scope:** in the Done-marking / `ticket-completion-evidence.ts` path, reject `completion_commit` equal to `state.start_commit` or `state.pinned_sha` as invalid completion evidence (a ticket whose only "commit" is the baseline did no work). Surface it as not-Done (re-attempt or Failed), with a clear log line.
- **AC-CXOR-2-1:** a unit test asserts `completion_commit == start_commit` is rejected as evidence (ticket does NOT flip Done); a distinct real commit is accepted.
- **AC-CXOR-2-2:** `grep -niE "start_commit|pinned_sha|baseline" extension/src/services/ticket-completion-evidence.ts` shows the guard exists.

### R-CXOR-3 (medium) — Backend-agnostic git-boundary parity for codex
- **Scope:** since the PreToolUse hook cannot reach a `codex exec` subprocess, enforce the git boundary for codex another way — research the cleanest option: (a) a post-iteration audit (built in R-CXOR-1) treated as the authoritative guard, (b) a `GIT_*`-env / wrapper-git on the PATH for codex spawns that blocks `reset`/`checkout`, or (c) a pre-commit/`reference-transaction` git hook installed for the session. Implement the option research selects; document why in `extension/src/services/CLAUDE.md`.
- **AC-CXOR-3-1:** a test asserts a codex-spawn-shaped invocation that attempts `git reset --hard <baseline>` is either blocked or detected+recovered (no silent orphan); claude-backend behavior is unchanged (hook still authoritative).
- **AC-CXOR-3-2:** trap-door pin added in `extension/src/services/CLAUDE.md` (or `hooks/CLAUDE.md`) for the backend-agnostic boundary, enforced by `audit-trap-door-enforcement.sh`.

### C-CXOR-CLOSER [manager] — Ship B-CXOR
- **Scope:** FULL release gate from `extension/`, bump per semver (**MINOR** if a new event/flag lands — `worker_head_regression_detected` does → MINOR; else PATCH), `bash install.sh`, push, `gh release create`, repoint MASTER_PLAN closing #94.
- **AC-CLOSER-1:** Full gate GREEN (tsc --noEmit, eslint --max-warnings=-1, tsc, all audit-*.sh, test:fast, test:integration, RUN_EXPENSIVE_TESTS=1 test:expensive) — READ + confirm before bump/tag.
- **AC-CLOSER-2:** `extension/package.json:version` bumped (single bump); commit subject `chore(C-CXOR-CLOSER): ship B-CXOR — bump X.Y.Z + close #94`.
- **AC-CLOSER-3:** `bash install.sh` exits 0; `git status` clean at tag time; compiled JS matches TS.
- **AC-CLOSER-4:** `git push` succeeds; `gh release create vX.Y.Z` succeeds (verify with `gh release list`).
- **AC-CLOSER-5:** `prds/MASTER_PLAN.md` marks B-CXOR SHIPPED + closes #94. Verify: `grep -c "B-CXOR.*SHIPPED" prds/MASTER_PLAN.md` ≥ 1.

## Acceptance (bundle-level)

- A codex-backend worker/manager can no longer silently orphan its commits via `git reset`: the runtime either blocks it or detects the HEAD regression and reattaches/fails honestly; a ticket can never be marked Done with `completion_commit == baseline`; regression-tested; trap-door pinned; release gate green; shipped; MASTER_PLAN repointed (#94 closed). After this lands, a codex `/pickle-pipeline` lands real work in HEAD or fails loudly — it never "advances" into orphan-land.

— Pickle Rick out. *belch*
