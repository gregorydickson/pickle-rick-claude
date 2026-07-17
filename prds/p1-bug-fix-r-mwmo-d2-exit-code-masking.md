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

**Thesis: a `done_without_commit_evidence` halt is invisible to the operator, and it takes TWO
changes to make it visible — WS-1 (the runner must exit non-zero) and WS-2 (the runner's consumer
must treat that exit as fatal). WS-1 alone is NECESSARY BUT NOT SUFFICIENT.**

- **WS-1 — three `guardCompletionCommitBeforeDone` failure sites in `mux-runner.ts` do a bare
  `return`** that leaves the `while (true)` loop's own exit path unreached. The run has already
  RECORDED `done_without_commit_evidence` — a failure reason — but Node falls off the end of the
  function and exits with its default code **0**. Make the three sites use the loop's canonical exit
  pattern so the recorded failure becomes an HONEST non-zero exit.
- **WS-2 — `pipeline-runner` would STILL continue on that non-zero exit.** `isFatalPhaseFailure`
  (`extension/src/bin/pipeline-runner.ts:2774`) classifies a pickle-phase failure as fatal only when
  `countCommitsSince(startCommit) === 0`. A `done_without_commit_evidence` halt means **this ticket**
  has no commit — it says nothing about the session. So whenever an earlier ticket committed, the
  WS-1 exit is classified NON-fatal, `shouldHaltAfterPhase` returns false, and the runner calls
  `recordRecoverablePhaseFailure(…, 'continue')` and proceeds to citadel anyway. Add the sibling
  always-fatal check, mirroring the SHIPPED precedent one line above it.

> **⚠ AUTHORING CORRECTION (2026-07-16).** WS-2 did not exist in this PRD's first draft, which
> claimed WS-1 alone made the failure honest. **That claim was FALSE.** It was caught by the
> `requirements` analyst during refinement and then independently verified against source. The
> lesson is the session's own headline restated: *a citation is not a verification* — the first
> draft cited real functions at real lines and still reached a wrong conclusion, because it verified
> the MECHANISM (the exit code changes) without verifying the OUTCOME (what the operator sees).

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
`max_iterations=0` is already unlimited at every loop seam (`extension/src/bin/mux-runner.ts:9426` reads
`if (globalMaxIter > 0 && …)`, so `0` skips the cap). The bug report carries a correction banner.
A ticket "make max_iterations=0 unlimited" fixes nothing and must not be created.

## The defect — source-verified on `release/v2.1-beta` (2026-07-16)

`done_without_commit_evidence` is already classified as a failure:

- `extension/src/bin/mux-runner.ts:4376` — `FAILURE_EXIT_REASONS` contains `'done_without_commit_evidence'`
- `extension/src/bin/mux-runner.ts:4379` — `export const isFailureExit = (r: ExitReason): boolean => FAILURE_EXIT_REASONS.has(r);`

The post-loop exit map (`extension/src/bin/mux-runner.ts:~11302-11351`) would therefore map it to exit **1**:

```ts
const isFailedExit = isFailureExit(exitReason);   // :11306
...
let exitCode: number;
if (exitReason === 'iteration_cap_exhausted')
  exitCode = 3;
else if (isFailedExit)
  exitCode = 1;
else
  exitCode = 0;
closePhantomDoneWatchers();
process.exit(exitCode);
```

> Formatting note: the map is split one-statement-per-line to route around the R-SAFP symbol-audit
> false positive (`BUG-REPORT-2026-07-16-symbol-audit-exit-code-false-positive-blocks-refinement.md`).
> The source itself is single-line. Do NOT "fix" the source to match this formatting.

But the three guard sites never reach it. All three are inside the `while (true)` loop opened at
`extension/src/bin/mux-runner.ts:9287` and closed at `:~11300`, and all three read (identically):

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
| 1 | `extension/src/bin/mux-runner.ts:~10456-10462` | prev-ticket already-Done-by-model path |
| 2 | `extension/src/bin/mux-runner.ts:~10947-10953` | `recover_advance` path |
| 3 | `extension/src/bin/mux-runner.ts:~11022-11028` | final-ticket path |

The bare `return` skips, in order: `emitCgSessionSummary()` (`:11302`), `closeCgService()` (`:11303`),
the `session_end` activity event (`:11307`, which carries `error: exitReason` for failure exits), the
completion panel, the tmux/mac notification, and the exit-code map. Net effect: **a fatal halt is
reported as a clean exit 0, with no `session_end` event.**

`recordExitReason(statePath, …)` writes the reason to `state.json`, which is why the operator-visible
log line still says `exit_reason=done_without_commit_evidence` while the *process* says 0. The state
is honest; the exit code is not. `pipeline-runner` trusts the exit code.

### The fix — use the loop's own canonical exit pattern

The same function already demonstrates the correct in-loop exit ~200 lines below the last guard site
(`extension/src/bin/mux-runner.ts:~11296-11301`):

```ts
log('Subprocess error. Exiting loop.');
recordExitReason(statePath, 'error');
safeDeactivate(statePath);
removeRunnerSessionMapEntry(statePath, log);
exitReason = 'error';
break;
```

`exitReason` is a module-scope `let` declared at `extension/src/bin/mux-runner.ts:9220`, so it is assignable from all
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

### WS-2 — make the consumer treat the halt as fatal (source-verified 2026-07-16)

`extension/src/bin/pipeline-runner.ts:2774-2785`, the `phase === 'pickle'` branch:

```ts
// R-PRNF-9: readiness halt is always a hard failure regardless of prior-session commits.
// Checking exit_reason here covers resumed sessions where countCommitsSince > 0 (prior runs)
// but this run produced zero build progress.
if (runnerState.exit_reason === 'readiness_halt') return true;
const startCommit = runnerState.start_commit?.trim();
if (!startCommit) return true;
return countCommitsSince(startCommit, runtime.repoRoot) === 0;
```

**⚠ CORRECTION (cycle 3, source-verified — the "shipped precedent" is DEAD CODE).** Draft 2 justified
WS-2 as *"mirror the shipped `readiness_halt` precedent."* **`readiness_halt` never fires:**
- it is **NOT a member** of the `ExitReason` union (`extension/src/bin/mux-runner.ts:4367`);
- `mux-runner` **never records it** (zero `recordExitReason(…, 'readiness_halt')` call sites);
- the **deployed** `~/.claude/pickle-rick/extension/bin/mux-runner.js` contains no `readiness_halt` at all;
- yet `extension/src/bin/pipeline-runner.ts:3917-3924` comments that it "promotes **mux-runner's**
  generic `readiness_halt`" — **from a producer that does not exist.**

So the `:2781` check, and the R-PRNF-9 cluster around it (`:3662`, `:3774`, `:3917-3924`), is a guard
that **has never fired**. The honest reading: **WS-2 is not "the second exception mirroring a shipped
one" — it is the FIRST LIVE always-fatal exception**, and it sits beside dead code.

**This does NOT invalidate WS-2** — the defect it fixes is real and verified (see the
`countCommitsSince` trace above). It changes the *justification*: WS-2 must be justified on its own
evidence (LOA-1763), **not** by appeal to a precedent that never runs. Do not cite `readiness_halt`
as proof the pattern works; it is proof the pattern was never exercised.

The completion is one line:

```ts
if (runnerState.exit_reason === 'done_without_commit_evidence') return true;
```

**Follow-up finding, OUT OF SCOPE here (do NOT let refinement expand into it):** the dead
`readiness_halt` cluster is a **subtraction candidate** under the R-CCNW-2 discipline — *a gate that
has never fired is either dead weight or an unwired safety net; pick one.* Either wire it (make
`mux-runner` produce the reason) or delete it. Filed to MASTER_PLAN §C; not this bundle's work.

**Why not rely on `--strict-phases`?** `pipeline_continue_on_phase_fail === false`
(`extension/src/bin/pipeline-runner.ts:2816`) would also halt — but it is **opt-in**, it halts on
*every* non-zero exit (not this class), and the LOA-1763 launch did not use it. An honesty fix that
only works when the operator opted in is not an honesty fix.

**Consequence if WS-2 is dropped:** the bundle can go fully green and **change nothing the operator
sees** in the exact scenario the bug report cites. WS-1 and WS-2 ship together or the thesis fails.

### WS-3 — make the halt LEGIBLE (source-verified 2026-07-16, cycle 3)

WS-1 makes the process exit non-zero. WS-2 makes the pipeline halt on it. **Neither makes the
operator able to tell WHY.** Two independent defects erase/misattribute the reason:

**(a) The reason is ERASED** — `extension/src/bin/pipeline-runner.ts:3693`:
```ts
} else if (pipelineFailed) {
  finalizeTerminalState(runtime.statePath, { step: 'completed', exitReason: 'failed' });
```
The specific `done_without_commit_evidence` is overwritten with a generic `'failed'`. Note the
sibling branch immediately above (`:3688-3691`) **deliberately preserves a prior reason** and says so
in its comment — so preserve-the-reason is an established behavior in this very function; this branch
just doesn't do it.

**(b) The reason is MISATTRIBUTED** — `extension/src/bin/pipeline-runner.ts:3786-3790`:
```ts
const commitCount = countCommitsSince(startCommit, runtime.repoRoot);
if (commitCount === 0) {
  return `zero commits since baseline ${shortSha} — no build progress this run`;
}
return `${commitCount} commit(s) since baseline ${shortSha} — halted for a reason other than build progress (e.g. strict phase policy)`;
```
**This is exactly the case WS-2 creates** (a `done_without_commit_evidence` halt with
`commitCount > 0`), and it reports it as *"halted for a reason other than build progress (e.g. strict
phase policy)"* — **actively wrong**. The operator is told the opposite of the truth: the halt IS
about build progress (a ticket produced no commit); it is not strict-phase policy.

**Fix:** report the recorded `exit_reason` when one is present rather than inferring the reason from
a commit count. This is a **subtraction** — it deletes an inference in favour of the fact already on
disk. It is also the same root as the §C `R-PRNF9-DEAD` finding and the Simplification-Review Q3
note: `countCommitsSince` is being asked a question it cannot answer.

**The thesis chain:** the halt must **exit** non-zero (WS-1) → be **classified** fatal (WS-2) → be
**reported** truthfully (WS-3). Any one link missing and the operator still cannot see the failure.
**All three, or the bundle is theatre.**

## Interface Contracts

The fix changes **control flow only**. No signature, type, or payload changes. The contracts below are
the ones the change must PRESERVE (they already exist) plus the one it RESTORES.

**`ExitReason` (unchanged)** — `extension/src/bin/mux-runner.ts:4367`:
```ts
export type ExitReason = 'success' | 'cancelled' | 'error' | 'limit' | 'iteration_cap_exhausted'
  | 'stall' | 'circuit_open' | ... | 'done_without_commit_evidence' | ...;
```
`'done_without_commit_evidence'` is ALREADY a member. **Do not add, rename, or reclassify it.**

**Classifiers (unchanged — assert, don't edit):**
```ts
isHaltExit('done_without_commit_evidence')    === true   // extension/src/bin/mux-runner.ts:4370
isFailureExit('done_without_commit_evidence') === true   // extension/src/bin/mux-runner.ts:4376/4379 (FAILURE_EXIT_REASONS)
```

**The binding the fix writes (unchanged declaration)** — `extension/src/bin/mux-runner.ts:9220`:
```ts
let exitReason: ExitReason = 'error';
```
It is declared in the SAME function that opens the main loop (indent 2, not module scope), so all
three guard sites can assign it and `break` to the shared exit path below the loop.

**The process-exit contract this fix RESTORES** — `extension/src/bin/mux-runner.ts:~11345-11351`:
```
Inputs:   exitReason: ExitReason
Outputs:  process exit status —
            3  when exitReason is iteration_cap_exhausted
            1  when isFailureExit(exitReason) is true
            0  otherwise
Errors:   none (pure map)
Invariant: a run that called recordExitReason(statePath, R) where isFailureExit(R) MUST exit non-zero.
           TODAY THIS INVARIANT IS VIOLATED at the three guard sites. That is the whole bug.
```

**`guardCompletionCommitBeforeDone` (READ-ONLY for this bundle)** — its return shape
`{ ok: boolean; reason?: string; sha?: string }` and its predicate are **out of scope**. The fix
consumes `!guard.ok` exactly as today.

**Consumer contract (`pipeline-runner`, unchanged):** the graduation gate trusts the phase's
**process exit code**. It must keep doing so — do not teach it to re-read `state.json`.

## Acceptance criteria (machine-checkable)

Every criterion below is verified from `extension/` unless stated otherwise.

- **AC-MWMO-D2-1** — **For ALL three** `!guard.ok` blocks guarding
  `recordExitReason(statePath, 'done_without_commit_evidence')` in `extension/src/bin/mux-runner.ts`:
  each assigns `exitReason = 'done_without_commit_evidence'` and exits the main loop via `break`, and
  **none** exits via a bare `return`. Pin as ONE parametrized test over the three sites — iterate an
  array of the sites inside a single `test()`/`describe()`, asserting per site.
  **⚠ `describe.each` DOES NOT EXIST in `node:test`** (`typeof describe.each === 'undefined'`; it is
  a Jest/Vitest API). Do NOT use it — this is the universal-quantifier shape the AC-shape gate wants,
  expressed in the runner this repo actually uses.
  — Verify: `node --test tests/mux-runner-done-without-commit-evidence-exit.test.js` — Type: test
- **AC-MWMO-D2-2** — A test drives the runner to a commit-less Done and asserts the observed process
  exit code is **1**, not 0. At minimum ONE site is driven end-to-end; the other two may be pinned
  structurally per AC-MWMO-D2-1, and the test file MUST name which site is driven and which are
  structural (no silent coverage gap).
  — Verify: `node --test tests/mux-runner-done-without-commit-evidence-exit.test.js` — Type: test
- **AC-MWMO-D2-3** — the halt emits a `session_end` activity event.
  Its `error` payload field carries the reason value done_without_commit_evidence. Today **no such
  event is emitted at all**, so this MUST fail before the fix (assert presence, not absence).
  — Verify: `node --test tests/mux-runner-done-without-commit-evidence-exit.test.js` — Type: test
- **AC-MWMO-D2-4** — `isHaltExit('done_without_commit_evidence') === true`,
  `isFailureExit('done_without_commit_evidence') === true`, and the exit map yields `1` for it —
  pinned so a future reclassification cannot silently re-mask the failure.
  — Verify: `node --test tests/mux-runner-done-without-commit-evidence-exit.test.js` — Type: test
- **AC-MWMO-D2-5** — Regression guard: **for EVERY** `recordExitReason(...)` call inside the
  `mux-runner.ts` main loop (`while (true)` at `:9287`), the enclosing block exits via
  `exitReason = …; break;` and NOT via a bare `return`. Scoped to the main loop only — a repo-wide
  grep that false-positives on out-of-loop callers FAILS this AC.
  — Verify: `node --test tests/mux-runner-done-without-commit-evidence-exit.test.js` — Type: test
- **AC-MWMO-D2-8 (WS-2 — the thesis test)** — `isFatalPhaseFailure('pickle', …)` returns `true` when
  `exit_reason` is `done_without_commit_evidence`, **even when `countCommitsSince(startCommit) > 0`**
  (i.e. an earlier ticket committed). Today it returns `false` in that case and the pipeline
  continues to citadel. Pin the sibling `readiness_halt` case in the same test so the two always-fatal
  reasons stay symmetric.
  — Verify: `node --test tests/mux-runner-done-without-commit-evidence-exit.test.js` — Type: test
- **AC-MWMO-D2-9 (WS-1 + WS-2 end-to-end)** — the operator-visible outcome changes: a pickle phase
  that halts on `done_without_commit_evidence` with a prior ticket committed does **NOT** report
  `Phase pickle completed successfully` and does **NOT** advance to citadel.
  — Verify: `node --test tests/mux-runner-done-without-commit-evidence-exit.test.js` — Type: test
- **AC-MWMO-D2-10 (WS-3a — the reason survives)** — after a `done_without_commit_evidence` halt, the
  terminal state's `exit_reason` is still `done_without_commit_evidence`, NOT the generic `'failed'`
  (`extension/src/bin/pipeline-runner.ts:3693` overwrites it today).
  — Verify: `node --test tests/mux-runner-done-without-commit-evidence-exit.test.js` — Type: test
- **AC-MWMO-D2-11 (WS-3b — the reason is not a lie)** — for a `done_without_commit_evidence` halt with
  `countCommitsSince(startCommit) > 0`, the operator-facing reason string does **NOT** claim the phase
  "halted for a reason other than build progress (e.g. strict phase policy)"; it names the recorded
  `exit_reason`. **This assertion FAILS on today's source** (`:3790` returns exactly that string) —
  red-first is mandatory here.
  — Verify: `node --test tests/mux-runner-done-without-commit-evidence-exit.test.js` — Type: test
- **AC-MWMO-D2-6** — Full release gate green from `extension/`.
  — Verify: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && bash scripts/audit-guarded-reset.sh && bash scripts/audit-un-terminalize-single-path.sh && npm run test:fast:budget && npm run test:integration`
  — Type: test
- **AC-MWMO-D2-7** — No behavior change to *whether* the guard fires: the body of
  `guardCompletionCommitBeforeDone` is unchanged by this bundle, and the diff touches only control
  flow + the WS-2 sibling check + tests.
  **⚠ TWO vacuous-verify defects already caught here — do not add a third.** Draft 1 diffed
  `release/v2.1-beta` while checked out ON it (self-diff → always empty → passed unconditionally).
  Draft 2 then referenced `PICKLE_START_COMMIT`, which **has ZERO producers in the codebase** (an env
  var that is never set → the command expands to a bare `git diff` → also not what it claims).
  Read the bundle's `start_commit` from session state, the one place it actually lives.
  — Verify: `git diff "$(node -e 'const s=require(process.env.SESSION_ROOT+"/state.json");console.log(s.start_commit)')" -- src/bin/mux-runner.ts` — reviewer confirms no edit inside the `guardCompletionCommitBeforeDone` body. **An empty diff is NOT a pass** — if the command errors or returns empty, the AC FAILS pending a working command.
  — Type: llm-conformance

## Test Expectations

All in ONE new file: `extension/tests/mux-runner-done-without-commit-evidence-exit.test.js`
(fast tier, `node --test`, no subprocess >5s — see `scripts/audit-subprocess-heavy-tests.sh`).

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-MWMO-D2-1 | `tests/mux-runner-done-without-commit-evidence-exit.test.js` | `describe.each` over the 3 `!guard.ok` sites; parse `src/bin/mux-runner.ts` source | Each site's block contains `exitReason = 'done_without_commit_evidence'` AND `break`; matches `/\breturn;/` = **0** |
| AC-MWMO-D2-2 | same | Drive the runner to a commit-less Done on ≥1 site with a stubbed failing `guardCompletionCommitBeforeDone` | Observed process exit status `=== 1`; test names the driven site vs the structurally-pinned ones |
| AC-MWMO-D2-3 | same | Capture the events emitted during the halt | An event with `event: 'session_end'` exists AND its `error === 'done_without_commit_evidence'` |
| AC-MWMO-D2-4 | same | Call the exported classifiers + exit map directly | `isHaltExit(r) === true`; `isFailureExit(r) === true`; exit map returns `1` |
| AC-MWMO-D2-5 | same | Extract the `while (true)` main-loop body (`:9287`→ its close) and find every `recordExitReason(` | For every match, the enclosing block has `break;` and no bare `return;`; out-of-loop callers are NOT inspected |

**Red-first requirement:** AC-MWMO-D2-2 and AC-MWMO-D2-3 MUST fail against the pre-fix source
(exit `0`; no `session_end` event). A test that passes before the fix has not pinned this bug —
demonstrate red before green.

**⚠ Red-first hazard — `PICKLE_TEST_MODE=1`.** The fast tier sets it, and it gates bypasses in
`mux-runner.ts` (`:4743`, `:4967`). If the harness path used to drive AC-2/AC-3 is short-circuited by
one of those bypasses, the test can go green **without ever executing the guard sites** — a vacuous
pass that looks like a fix. **Research MUST determine whether a red-first demonstration is reachable
in the mandated tier.** If it is not, say so explicitly and choose: drive the site through a path
that is not bypassed, or move AC-2/AC-3 to the integration tier and record why. **Do NOT silently
downgrade to a structural-only pin** — that is exactly the "the gate never fired, so it passed"
failure this bundle exists to eliminate.

**WS-2 test expectations** (same file or a sibling — the author picks, but both WS need pins):

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-MWMO-D2-8 | `tests/mux-runner-done-without-commit-evidence-exit.test.js` (or a `pipeline-runner-*` sibling) | `isFatalPhaseFailure('pickle', …)` with `exit_reason='done_without_commit_evidence'` **and `countCommitsSince > 0`** (an earlier ticket committed) | returns `true` — the LOA-1763 scenario. **This is the test that fails without WS-2.** |

## Simplification Review (subtract-before-add — required)

1. **What does this DELETE?** WS-1 deletes a divergence: three sites that invented their own exit path
   instead of using the loop's one canonical exit. Net LOC is ~+2/site, but it removes a *second way
   to leave the loop* — the seam that produced the bug. Fewer exit paths, not more.
2. **Can it REUSE instead of ADD?** **Yes — both workstreams are pure reuse of shipped precedent, and
   neither adds a mechanism.** WS-1 reuses the loop's own canonical exit
   (`exitReason = …; break;`, `extension/src/bin/mux-runner.ts:~11300`). WS-2 reuses the
   `readiness_halt` always-fatal check (`extension/src/bin/pipeline-runner.ts:2781`) — same function,
   one line above, same class of halt, and its comment already describes this hole. **No new state,
   no new flag, no new event, no new enum member** (`done_without_commit_evidence` is already an
   `ExitReason` and already in `FAILURE_EXIT_REASONS`).
   The additive alternative — teaching `pipeline-runner` to re-read the `exit_reason` field out of
   `state.json` rather than trusting the process exit status — was **rejected**: it would paper over a
   broken contract (a failing process must exit non-zero) and add a second source of truth for phase
   success. Fix the liar, not the listener.
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** Partly, and this
   is worth naming: `isFatalPhaseFailure`'s `countCommitsSince(startCommit) === 0` heuristic is the
   brittle thing — it infers "did this phase fail?" from *session-wide* commit counting, which is why
   it needs a growing list of always-fatal exception reasons (`readiness_halt` was the first; this
   bundle adds the second). **The honest long-term subtraction is to stop inferring phase failure
   from commit counts and trust the phase's own exit reason.** That is a larger, separate
   re-scoping — **explicitly OUT of scope here** — but WS-2 adding the *second* exception is the
   evidence that the heuristic is wrong. **Log it as a follow-up finding; do not build it here, and
   do not let refinement expand this bundle into it.**
4. **What is the smallest diff that satisfies the thesis?** Three 2-line changes (WS-1) + one line
   (WS-2) + tests. AC-MWMO-D2-5 adds one regression guard, justified: this exact class (in-loop
   `return` bypassing the exit map) fired in the field at LOA-1763 and exists at three independent
   sites — it has already recurred twice on its own. Anything larger — new state, new event types, a
   manager-path guard, a `max_iterations` change, or re-architecting `isFatalPhaseFailure` — is out
   of scope and must be rejected in refinement.

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
- Making `pipeline-runner` read the `exit_reason` field from `state.json` instead of trusting the
  process exit status.
- Recovering the orphaned worker (a real but separate problem — needs its own diagnosis).
