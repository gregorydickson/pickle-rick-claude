# BUG REPORT — B-FLAKE babysitting session (2026-05-20)

**Source**: overnight babysitting of the B-FLAKE / R-TFP-W pipeline, session `2026-05-19-2b2c651c` (`/pickle-pipeline` on `prds/archive/bundles/p2-test-fast-stability-gate-widening-2026-05-19.md`, codex backend).
**Observed by**: operator-driven 30-min babysitter loop, 2026-05-19 21:00 CDT → 2026-05-20 morning.
**Outcome**: 11/13 R-TFP-W clusters shipped real commits; pickle→citadel→anatomy-park progressing; v1.76.0 NOT tagged (stability gate red, commits held local per operator). Seven distinct bugs surfaced during the run — cataloged below as Findings #58-#64.

The pipeline reached completion ONLY because the babysitter intervened ~8 times (skip-flag, rollbacks, state repair, a bespoke pickle-grind loop, residual-work commit). Each bug below is a place the pipeline could not self-recover.

---

## Bug 1 (#58 R-WTZ) — `worker_timeout_seconds: 0` poisons state.json → every pickle run exits code 2

**Severity**: P1 — pipeline-bricking. Root cause of hours of phantom "Session inactive" fast-exits.

**Symptom**: Every pickle-phase launch exited code 2 in milliseconds with:
```
Invalid state at .../state.json:
  - worker_timeout_seconds must be > 0 (got 0)
[Phase pickle exited with code 2]
```
The runner had been launched via `setup.js --resume --worker-timeout 2400` (which set 2400 correctly), but `worker_timeout_seconds` was later observed as `0`. Because pipeline-runner advances on any exit, this masqueraded as "Session inactive" / 1-iteration runs and false phase-advances for multiple babysitter ticks before the `0` was spotted.

**Root cause**: `setup.js` did not persist the `--worker-timeout` override across resume/reconstruction; a later state write landed `0`.

**Status**: **Likely fixed** by anatomy-park commit `dba05f64` "Persist setup worker timeout override contract" (`extension/src/bin/setup.ts` +8, `setup.test.js` +20). **Action**: verify `dba05f64` fully closes the `0`-write path; add a state-validation guard that rejects/repairs a `0` timeout at load rather than fatally exiting the phase.

---

## Bug 2 (#59 R-PPPA) — pipeline-runner false phase-advance on partial ticket completion

**Severity**: P1 — wastes codex budget, produces dishonest "pipeline complete".

**Symptom**: When mux-runner exits code 0 with **some but not all** tickets Done, pipeline-runner logs `Phase pickle completed successfully` and advances pickle→citadel→anatomy-park. Observed repeatedly: pickle "completed" with 2/13 and 3/13 tickets Done; anatomy-park then ran a full review against an incomplete bundle. The codex manager hallucinating `EPIC_COMPLETED` (R-CCPM class) triggers the early mux-runner exit; pipeline-runner does not cross-check ticket completion.

**Root cause**: The `phase_no_progress` gate (R-PIPE-2, Finding #48) only fires on `0 Done && 0 commits`. The N-of-M-Done case (2/13, 3/13) is not caught. pipeline-runner treats `mux-runner exit 0` as phase success unconditionally.

**Suggested fix**: After pickle's mux-runner exits, pipeline-runner must count `Done` tickets vs total in the session; if `Done < total`, stamp a transient exit_reason (`phase_incomplete_tickets`) and do NOT advance. Sibling to #48 R-PCFG.

---

## Bug 3 (#60 R-PDWR) — phantom-Done watcher reverts genuinely-complete tickets

**Severity**: P2 — causes redundant re-work; can wedge a ticket.

**Symptom**: Ticket `3d79bf7a` (R-TFP-W2) had a real completion commit (`61b7a38a`) AND `completion_commit:` stamped in its frontmatter, yet the phantom-Done watcher reverted it to `Todo` logging `Corrected phantom Done ticket 3d79bf7a back to Todo (no completion commit found)`.

**Root cause**: The phantom-Done watcher's commit-attribution check does not recognize a validly-stamped `completion_commit` frontmatter field (or requires git-attributable evidence that a recovery-stamped commit lacks). `state.flags.allow_inferred_completion_commit=true` did not suppress the watcher.

**Suggested fix**: The watcher must treat a frontmatter `completion_commit` that resolves to a real commit reachable from HEAD as valid. Honor `allow_inferred_completion_commit` in the watcher path.

---

## Bug 4 (#61 R-CCGR) — `guardCompletionCommitBeforeDone` timing race

**Severity**: P2 — fatal-exits a phase on a ticket that actually succeeded.

**Symptom**: mux-runner FATAL'd `ticket 3d79bf7a cannot flip Done: hasCompletionCommit().source === 'absent' (expected 'explicit')` — but the worker HAD committed (`61b7a38a`) and `completion_commit:` WAS in the frontmatter when inspected moments later.

**Root cause**: Race between the worker's commit + frontmatter stamp and the guard's read. The guard reads before the stamp is durably flushed.

**Suggested fix**: Re-read the ticket frontmatter once after a short backoff before declaring `absent`; or have the worker stamp `completion_commit` atomically before emitting its done-promise.

---

## Bug 5 (#62 R-SGWC) — stability-gate workflow cannot test a specific commit

**Severity**: P1 — the release gate silently verifies the wrong code.

**Symptom**: C-TFP-CLOSER dispatched `gh workflow run stability-gate.yml -f run_count=30 -f commit=<HEAD>` → HTTP 422. `.github/workflows/stability-gate.yml` declares only `run_count` as a `workflow_dispatch` input. Both closer gate runs (`26148905248`, `26149014236`) therefore executed against `origin/main` HEAD `50826a8b` — the **pre-bundle** commit — not the local bundle work. The closer "ran the gate" but the gate never saw the 11 cluster fixes.

**Root cause**: Workflow has no input to target a commit/ref; it always runs `origin/main` HEAD. Closers with un-pushed local commits cannot get a meaningful gate result.

**Suggested fix**: Add a `ref` / `commit` `workflow_dispatch` input to `stability-gate.yml` and `actions/checkout` it; OR document that the closer MUST push before dispatching. Update the C-TFP-CLOSER spec in any R-TFP-W-class PRD to drop the unsupported `-f commit=`.

---

## Bug 6 (#63 R-SDTR) — workers commit session artifacts into the source repo

**Severity**: P2 — pollutes the repo, re-trips the dirty-tree guard.

**Symptom**: `sessions/2026-05-19-a997754a/` and `sessions/2026-05-19-aff7bfe5/` (9 files) are **tracked in the pickle-rick-claude repo**. Commit `dba05f64` itself included `sessions/2026-05-19-aff7bfe5/715b3509/{research,plan,conformance,code_review,linear_ticket}_*.md` — a worker committed its own session lifecycle artifacts into the source tree. Their `state.json` files re-dirty on every run and trip pipeline-runner's dirty-tree FATAL guard. (Related: the `sessions/2026-05-19-539a718a/` test-session leak removed manually at session start.)

**Root cause**: Session dirs live under `~/.local/share/pickle-rick/sessions/`, but a relative `sessions/` path inside the repo got `git add`ed by a worker whose scope/cwd resolution was wrong. `sessions/` is not in `.gitignore`.

**Suggested fix**: Add `sessions/` to `.gitignore`; `git rm -r --cached sessions/`; add a worker-scope preflight that refuses `git add sessions/**`.

---

## Bug 7 (#64 R-RHFP) — READINESS HALT false-positive surface is broad

**Severity**: P2 — halts the pipeline pre-launch on noise; requires operator skip-flag.

**Symptom**: `check-readiness` exited 1 on **18 findings, all false positives**, halting pickle before any worker spawned:
- 4 `file_path`: R-RPRA leading-slash strips (`.github/workflows/...` → `github/workflows/...`) + prose mentions of *corrected old paths* inside ticket correction-notes ("the original PRD cited `X` — wrong, use `Y`").
- 3 legitimate forward-create targets (new files the bundle creates).
- 11 `performance`: wall-budget timeouts resolving code snippets (`t.skip()`, `t.mock.timers.enable()`, `inputs.run_count`) as if they were file/symbol references.

**Root cause**: Extends #57 R-RPRA. The readiness checker (a) strips leading `/` and leading `.`, (b) treats backtick-wrapped prose tokens as file references, (c) treats inline code snippets as contract references and times out resolving them.

**Suggested fix**: Fold into R-RPRA / R-FRA refinement-gate work — readiness must skip tokens inside `*(refined: ...)*` correction-notes and inside fenced/inline code that is obviously a snippet (`t.skip()`, `foo()`), and must not strip a leading `.` from dotfile paths.

---

## Cross-cutting note

Findings #58, #59, #62 are P1 and pipeline-reliability-critical: the pipeline cannot honestly self-complete a bundle while they exist (it false-advances, mis-times the release gate, and bricks on a zeroed timeout). #60/#61/#63/#64 are P2 friction that each cost a babysitter intervention. Recommend bundling as **B-BABYSIT-FIX** behind the current P1 drain.
