---
title: "R-MWMO defect 2 — the done_without_commit_evidence halt must exit NON-ZERO"
priority: P1
r_codes: [R-MWMO]
status: BUILD-READY
build_protocol: PIPELINE
line: release/v2.1-beta
composes: []
bug: prds/BUG-REPORT-2026-07-14-pipeline-max-iterations-zero-stops-after-one-plus-orphaned-worker.md
---

# R-MWMO defect 2 — a recorded FAILURE currently exits 0 and reports as benign

**Thesis: three `guardCompletionCommitBeforeDone` failure sites in `mux-runner.ts` do a bare `return`
that leaves the `while (true)` loop's own exit path unreached. The run has already RECORDED
`done_without_commit_evidence` — a failure reason — but Node falls off the end of the function and
exits with its default code **0**. `pipeline-runner`'s graduation gate reads 0 as benign and prints a
success-shaped `Pipeline finished: 0/4 phases`. Make the three sites use the loop's canonical exit
pattern so the recorded failure becomes an HONEST non-zero exit.**

This is a **honesty fix, not a recovery fix.** It does not rescue an orphaned worker and does not
change *whether* the guard fires. It changes only what the process reports when the guard has
already decided to halt. Scope is deliberately narrow.

## Scope fence — defect 2 ONLY

Defect 1 from the bug report ("port the R-MWBG worker-spawn guard to the pickle-manager path") is a
**NO-OP and is OUT OF SCOPE.** Source-verified 2026-07-16: the guard is already present at
`extension/templates/_pickle-manager-prompt.md:155` ("Worker-spawn discipline (mandatory — R-MWBG).
Run spawn-morty.js in the FOREGROUND. NEVER background it…"). At LOA-1763 the *harness*
auto-backgrounded the spawn despite the prompt forbidding it — that residual is a harness behavior,
not a missing instruction, and is not prompt-fixable. **Do not add a second copy of the guard.**

Also explicitly OUT OF SCOPE: any `max_iterations = 0` change. **That bug does not exist** —
`max_iterations=0` is already unlimited at every loop seam (`mux-runner.ts:9426` reads
`if (globalMaxIter > 0 && …)`, so `0` skips the cap). The bug report carries a correction banner.
A ticket "make max_iterations=0 unlimited" fixes nothing and must not be created.

## The defect — source-verified on `release/v2.1-beta` (2026-07-16)

`done_without_commit_evidence` is already classified as a failure:

- `mux-runner.ts:4376` — `FAILURE_EXIT_REASONS` contains `'done_without_commit_evidence'`
- `mux-runner.ts:4379` — `export const isFailureExit = (r: ExitReason): boolean => FAILURE_EXIT_REASONS.has(r);`

The post-loop exit map (`mux-runner.ts:~11302-11351`) would therefore map it to exit **1**:

```ts
const isFailedExit = isFailureExit(exitReason);   // :11306
...
let exitCode: number;
if (exitReason === 'iteration_cap_exhausted') exitCode = 3;
else if (isFailedExit) exitCode = 1;
else exitCode = 0;
closePhantomDoneWatchers();
process.exit(exitCode);
```

But the three guard sites never reach it. All three are inside the `while (true)` loop opened at
`mux-runner.ts:9287` and closed at `:~11300`, and all three read (identically):

```ts
if (!guard.ok) {
  const msg = `[fatal] ${new Date().toISOString()} ${guard.reason}`;
  log(msg);
  process.stderr.write(`${msg}\n`);
  recordExitReason(statePath, 'done_without_commit_evidence');
  safeDeactivate(statePath);
  return;                    // ← bypasses everything below the loop
}
```

**Sites (verify exact lines at build time — they drift):**

| # | Site (approx.) | Context |
|---|---|---|
| 1 | `mux-runner.ts:~10456-10462` | prev-ticket already-Done-by-model path |
| 2 | `mux-runner.ts:~10947-10953` | `recover_advance` path |
| 3 | `mux-runner.ts:~11022-11028` | final-ticket path |

The bare `return` skips, in order: `emitCgSessionSummary()` (`:11302`), `closeCgService()` (`:11303`),
the `session_end` activity event (`:11307`, which carries `error: exitReason` for failure exits), the
completion panel, the tmux/mac notification, and the exit-code map. Net effect: **a fatal halt is
reported as a clean exit 0, with no `session_end` event.**

`recordExitReason(statePath, …)` writes the reason to `state.json`, which is why the operator-visible
log line still says `exit_reason=done_without_commit_evidence` while the *process* says 0. The state
is honest; the exit code is not. `pipeline-runner` trusts the exit code.

### The fix — use the loop's own canonical exit pattern

The same function already demonstrates the correct in-loop exit ~200 lines below the last guard site
(`mux-runner.ts:~11296-11301`):

```ts
log('Subprocess error. Exiting loop.');
recordExitReason(statePath, 'error');
safeDeactivate(statePath);
removeRunnerSessionMapEntry(statePath, log);
exitReason = 'error';
break;
```

`exitReason` is a module-scope `let` declared at `mux-runner.ts:9220`, so it is assignable from all
three sites. The change per site is:

```ts
-  return;
+  exitReason = 'done_without_commit_evidence';
+  break;
```

**Verified safe:** the post-loop code the `return` currently skips is cleanup that SHOULD run on this
path — service teardown, the `session_end` event, and the exit map. Reaching it is strictly more
correct than skipping it. `done_without_commit_evidence` is already in `isHaltExit` (`:4370`) and
`isFailureExit` (`:4376`), so no classification change is needed — the reason is already correctly
typed; only the control flow is wrong.

**Research must confirm** (do not assume): that each of the three sites is lexically inside the
`while (true)` at `:9287` and **not** inside a nested loop (e.g. the sleep-poll `while` at `:~10638`),
so that `break` targets the outer loop. If any site sits in a nested loop, that site needs a
labelled break or an equivalent — flag it rather than silently changing semantics.

## Acceptance criteria (machine-checkable)

- **AC-MWMO-D2-1** — No `guardCompletionCommitBeforeDone` failure branch in
  `extension/src/bin/mux-runner.ts` exits via a bare `return`. Pinned by a test that asserts each of
  the three `!guard.ok` blocks assigns `exitReason = 'done_without_commit_evidence'` and `break`s.
- **AC-MWMO-D2-2** — A unit/integration test drives a mux run to a commit-less Done on each of the
  three paths and asserts the process exit code is **1** (not 0). If driving all three end-to-end is
  disproportionate, at minimum one is driven end-to-end and the other two are pinned structurally
  per AC-MWMO-D2-1; the test names which is which.
- **AC-MWMO-D2-3** — On a `done_without_commit_evidence` halt, a `session_end` activity event IS
  emitted and carries `error: 'done_without_commit_evidence'` (today: no event at all).
- **AC-MWMO-D2-4** — `isFailureExit('done_without_commit_evidence') === true` and the exit map yields
  `1`; pinned so a future reclassification cannot silently re-mask the failure.
- **AC-MWMO-D2-5** — A regression guard (test or audit) asserts no NEW bare-`return` failure exit is
  added inside the `mux-runner.ts` main loop after a `recordExitReason(...)` call — i.e. every
  `recordExitReason` inside the loop is followed by an `exitReason = …; break;`, not a `return`.
  Scope this to the main loop; do not make it a repo-wide grep that false-positives.
- **AC-MWMO-D2-6** — Full release gate green from `extension/` (the CLAUDE.md release-gate command).
- **AC-MWMO-D2-7** — No behavior change to *whether* the guard fires: the guard's own predicate
  (`guardCompletionCommitBeforeDone`) is NOT modified. Diff touches control flow + tests only.

## Simplification Review (subtract-before-add — required)

1. **What does this DELETE?** It deletes a divergence: three sites that invented their own exit path
   instead of using the loop's one canonical exit. Net LOC is ~+2/site, but it removes a *second way
   to leave the loop* — the seam that produced the bug. Fewer exit paths, not more.
2. **Could this be fixed by subtracting instead of adding?** This IS the subtractive shape available:
   collapse the ad-hoc exits onto the existing pattern. The additive alternative — teaching
   `pipeline-runner` to re-read `state.json`'s `exit_reason` rather than trusting the exit code —
   was **rejected**: it would paper over a broken contract (a failing process must exit non-zero) and
   add a second source of truth for phase success. Fix the liar, not the listener.
3. **What guard is being added, and has its failure ever fired?** AC-MWMO-D2-5 adds one regression
   guard. Justified: this exact class (in-loop `return` bypassing the exit map) fired in the field at
   LOA-1763 and exists at three independent sites — i.e. it has already recurred twice on its own.
4. **What is the smallest diff that satisfies the thesis?** Three 2-line changes + tests. Anything
   larger — new state, new event types, a manager-path guard, a `max_iterations` change — is out of
   scope and must be rejected in refinement.

## Build protocol

**PIPELINE — `/pickle-pipeline`.** Not hand-built. Per the standing operator directive (MASTER_PLAN
§B build protocol, 2026-07-16) the R-PSRB hand-build reflex is retired.

**Does the deployed bug bite the build worker?** Analysis: **no.** This fix changes only the exit
code reported *after* the guard has already decided to halt; it does not change whether the guard
fires, nor any salvage/Done-flip predicate. A build worker on this bundle is not made more likely to
lose work by the deployed (unfixed) runtime than by the fixed one. Therefore incremental
`install.sh` mid-bundle is **not required** for worker safety. Deploy at the closer as usual.

## Out of scope (explicit — reject in refinement)

- Any `max_iterations` / `--max-iterations 0` change (the bug does not exist).
- Porting/duplicating the R-MWBG worker-spawn guard into the manager path (already present; NO-OP).
- Changing `guardCompletionCommitBeforeDone`'s predicate or any completion-evidence logic.
- Making `pipeline-runner` read `exit_reason` from `state.json` instead of trusting the exit code.
- Recovering the orphaned worker (a real but separate problem — needs its own diagnosis).
