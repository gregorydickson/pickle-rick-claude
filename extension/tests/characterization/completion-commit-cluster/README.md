# Completion-Commit Cluster — Characterization Safety Net

PRD: `prds/archive/bundles/p1-bug-fix-bundle-b-afcc-deep-autofill-done-flip-cluster-2026-05-28.md`  
AC ref: `AC-AFCC-DEEP-01`

This directory contains the characterization fixture for the `B-AFCC-DEEP` bundle. The characterization test suite (**R-AFCC-DEEP-1B**) uses these fixtures to assert current observable behaviour before any deletion (Phase 3) or refactor (Phase 4) ships. If the suite still passes after those phases, the behaviour was preserved.

---

## The problem: 8 paths, 3 evidence sources, 4 SHA quote-forms

Six ticket completion-commit bugs shipped in 30 days. Each fix was correct. Each was followed by an adjacent-mode discovery within days. The root cause (per three parallel analysis agents) is that **"is this ticket attributably done?"** is a single conceptual question answered by 8 distinct code paths with divergent invariants.

---

## The 8 Done-stamping paths

| ID | Label | Triggering function | File:line | Evidence required | autoFill? |
|----|-------|--------------------|-----------|--------------------|-----------|
| 1 | `worker-explicit-stamp` | `updateTicketFrontmatter` | `spawn-morty.js:956` | explicit (written) | — |
| 2 | `worker-autofill-belt-and-suspenders` | `autoFillCompletionCommit` | `auto-fill-completion-commit.js:36` | inferred (git-log) | yes |
| 3 | `manager-drift-auto-completion-validation` | `applyAutoTicketCompletionValidation` | `mux-runner.js:1635` (called at `4715`) | inferred (`allow_inferred=true`) | yes (post-mark) |
| 4 | `process-task-completed-guard` | `processTaskCompleted` | `mux-runner.js:3603` | explicit | no |
| 5a | `guard-worker-self-attested` | `guardCompletionCommitBeforeDone` | `mux-runner.js:4694` | explicit | no (already Done) |
| 5b | `guard-false-epic-recover-advance` | `guardCompletionCommitBeforeDone` | `mux-runner.js:5083` | explicit | no |
| 5c | `guard-genuine-epic-final-ticket` | `guardCompletionCommitBeforeDone` | `mux-runner.js:5159` | explicit | no |
| 6 | `phantom-done-watcher-revert` | `correctPhantomDoneTickets` | `mux-runner.js:1007` | absent → **revert** | — |
| 7 | `phantom-done-watcher-backfill` | `inspectPhantomDoneTicketFile` | `mux-runner.js:1089` | inferred (writes `_inferred`) | — |
| 8 | `operator-salvage-edit` | n/a (manual) | n/a | explicit (post-edit) | — |

Paths 5a/5b/5c are grouped as path 5 in the PRD enumeration ("Three more guard-routed Done flips").

### How each path can fail

**Path 1** — `completionCommitSha` is null AND `getHeadSha` fails → `completion_commit` absent → watcher reverts next scan.

**Path 2** — `stageTicketFile` throws outside a git repo (`R-AFCC-STAGE`): the `action='filled'` signal is swallowed and the staged file is never committed. Also: bare `readFrontmatterField` on line 53 (not `normalizeCompletionCommitField`) means a quoted SHA at path 1 is invisible to path 2's already-present check — path 2 re-fills unnecessarily (`R-CCQF`).

**Path 3** — If the guard call is removed or `allow_inferred_completion_commit` is false: gate blocks with `done_without_commit_evidence` for any manager-drift ticket (`R-CCRC-2`). If `clearStaleDoneWithoutCommitEvidence` is not called: stale exit_reason survives into `finalizePipeline`, mislabelling a successful bundle as failed (`R-PEDC`).

**Path 4** — Quoted SHA in `completion_commit` without `normalizeCompletionCommitField`: classified as absent, guard exits with `done_without_commit_evidence` (`R-CCQF`). No `autoFillCompletionCommit` follows this path — if the SHA is missing at guard time, the pipeline halts.

**Paths 5a/5b/5c** — Any of the three guard callsites bypassed: Done flip without evidence check (`R-CCRC-2`). Missing `clearStaleDoneWithoutCommitEvidence`: stale exit_reason (`R-PEDC`).

**Path 6** — `start_time_epoch` not passed to `hasCompletionCommit`: `findMatchingCommit` scans all commits, finds a cross-session SHA from a prior session, keeps ticket Done when it should revert (`R-AFCC-STALE`). Explicit SHA present but `gitCommitExists` check skipped (R-RIC-EXPLICIT-4): valid Done incorrectly reverted.

**Path 7** — Paths 2 and 7 are functionally identical inferred-backfill helpers separated only by the field name they write (`completion_commit` vs `completion_commit_inferred`). Divergent invariants between them are the source of several recurrence bugs. The `priorStatus` default of `'Todo'` may not match the last known good status if the caller doesn't pass it.

**Path 8** — Operator writes a quoted SHA without knowing that a bare `readFrontmatterField` caller (path 2 line 53) won't recognize it. Watcher correctly handles all 4 quote-forms via `normalizeCompletionCommitField`, but ad-hoc callers may not.

---

## The 3 evidence sources

| Kind | Read site | Description |
|------|-----------|-------------|
| `explicit` | `pickle-utils.js:786` | `completion_commit:` field present and valid (any quote-form, stripped by `normalizeCompletionCommitField`) |
| `inferred` | `pickle-utils.js:790–803` | `completion_commit_inferred:` + `gitCommitExists`, OR `findMatchingCommit` via git-log scan |
| `absent` | `pickle-utils.js:804` | Neither field present; git-log scan returns null |

The `source` field of `hasCompletionCommit`'s return value drives all downstream decisions: guard `ok/fail`, watcher `keep/revert/backfill`.

---

## The 4 SHA quote-forms

All four forms are valid inputs to `normalizeCompletionCommitField` (`pickle-utils.js`). The normalizer strips leading/trailing single or double quotes (paired or unpaired) before hex validation.

| Form | Example | Written by |
|------|---------|-----------|
| Bare short SHA | `4b38893c` | `autoFillCompletionCommit` via `upsertFrontmatterField` |
| Double-quoted short SHA | `"4b38893c"` | Codex tool-call (short ref) |
| Double-quoted full SHA | `"724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8"` | Codex tool-call (full SHA) — caused `R-CCQF` live incident |
| Single-quoted full SHA | `'724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8'` | Human edit |

---

## Related tests

- `R-AFCC-DEEP-1B` — characterization tests (one file per path, `@tier: integration`)
- `extension/tests/has-completion-commit.test.js` — `hasCompletionCommit` unit tests
- `extension/tests/has-completion-commit-quoted-form.test.js` — R-CCQF quote-form tests
- `extension/tests/guard-completion-commit-auto-promote.test.js` — R-WUWC SOFT-variant guard
- `extension/tests/done-flip-paths-call-guard.test.js` — R-CCRC-2 routing tests
- `extension/tests/exit-reason-clears-on-recovery.test.js` — R-PEDC clear-on-recovery tests
