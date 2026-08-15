# BUG: R-NOPOSTTIER — no tier verdict after a bundle's final commit, and a recorded RED gate still reports success

- **Date**: 2026-08-15
- **Priority**: P1 (fake-green)
- **Branch**: `release/v2.1-beta`
- **Measured at**: `45d3081f` (fast tier green: 7647 tests, 504 suites, fail 0, cancelled 0, 835042 ms)
- **Class**: reporting defect. The run's disposition is correct; its VERDICT is not.
- **build_mode**: `attended` (R-PSRB — edits the Done-flip / completion-evidence seam)
- **Refined**: 2026-08-15, 3-analyst team (requirements / codebase / risk-scope), 1 cycle, `all_success: true`.
  Refinement corrected the Defect-1 seam attribution, caught two P0 collisions that would have shipped a
  global fake-RED (off-repo no-op, timeout-by-construction), and caught the `stop-hook` promise-string
  contract. Load-bearing citations re-verified against HEAD by the manager before amendment.

## The two defects, and they are separable

### Defect 1 — nothing measures the tree after the final commit

Session `2026-08-15-b88a6603` timeline, from its own state and git:

| when (UTC) | what |
|---|---|
| 12:36:57 | last `between_ticket_gate` recorded (`ok: false`) |
| 14:28:44 | `1bead552` lands — the bundle's LAST commit, which put HEAD red |
| 14:38:11 | `EPIC_COMPLETED / all-tickets-done`, `exit_reason: completed` |

**121 minutes** separate the last recorded gate from epic completion, and **no gate ran in the 9.5
minutes between the reddening commit and the success verdict.** Operator-run clean-env tier at
`1bead552`: 7647 tests, **fail 3**, cancelled 0, EXIT=1 — three failures, one root (a trap-door entry at
1831 chars against the 1500 cap at `extension/tests/trap-door-conformance.test.js:15`).

**Seam attribution — corrected at refinement (verified in source, 2026-08-15).** There are TWO completion
seams, and the PRD's first draft named the wrong one:

- `processTaskCompleted` (`extension/src/bin/mux-runner.ts:8004`) handles the manager-emitted
  `EPIC_COMPLETED` token and DOES call `runBetweenTicketFastGate({ nextTicketId: null, ... })` at
  `extension/src/bin/mux-runner.ts:8067` — but only inside `if (curState.current_ticket)` at
  `extension/src/bin/mux-runner.ts:8042`.
- `applyAllTicketsDoneCompletion` (`extension/src/bin/mux-runner.ts:2143`, sole caller
  `extension/src/bin/mux-runner.ts:10490`) is the seam that actually writes
  `completion_promise = {"reason":"all-tickets-done"}` at `extension/src/bin/mux-runner.ts:2184`, and it
  **calls no gate at all**. `grep -rn "all-tickets-done" src/` returns only `:2162`, `:2184`, `:2197`.

Session `b88a6603` finished with `current_ticket: null` and a promise whose reason is `all-tickets-done`,
so the **synthesis path (`:2143`) is the one that shipped the unmeasured green**. A bundle scoped only to
`:8067` would leave the defect path untouched and could turn the AC-6 oracle green by accident. The fix
MUST cover the `:2143` path; whether `:8067`'s `current_ticket` guard is also widened is a second, smaller
question. A third `evaluateEpicCompletion` call exists at `extension/src/bin/mux-runner.ts:11668`, with a
sibling swallow at `:11412` — the bundle must state whether either is affected.

The structural reason the rest of the pipeline cannot catch this: the between-ticket gate runs BETWEEN
tickets and there is no ticket after the last one; per-ticket conformance is scoped to that ticket's own
diff. **The final commit of every bundle is structurally unmeasured.** The aggravating shape is that the
reddening commit was a DOCS commit from an AUDIT ticket — the class least likely to be suspected.

### Defect 2 — a recorded RED gate does not withhold the success verdict

The same session finished with `last_between_ticket_gate.ok: false` sitting in state AND
`completion_promise: {"kind":"EPIC_COMPLETED","reason":"all-tickets-done"}` AND `exit_reason: "completed"`.
A red gate verdict was on disk and the run still reported unqualified success. Fixing Defect 1 alone
would produce a fresh red verdict that is likewise ignored — so Defect 2 must be fixed too, or the new
measurement is decorative.

This is the governing rule stated exactly: **honesty is a REPORTING property, halting is a DISPOSITION,
and they are not the same wire.** The run SHOULD complete. It MUST NOT claim success it did not measure.

## Solution

1. Ensure a **fast**-tier measurement runs after the final ticket's commit and before the completion
   promise is synthesized at `extension/src/bin/mux-runner.ts:2184`, recording its verdict in state next
   to `last_between_ticket_gate` (`extension/src/types/index.ts:132-141`).

   **Timeout (load-bearing).** The gate spawns `npm run test:fast` with
   `timeout: resolveWorkerTestGateTimeoutMs(...)` (`extension/src/bin/mux-runner.ts:638`,
   `:645`), whose shipped default is `DEFAULT_WORKER_TEST_GATE_TIMEOUT_MS = 600_000`
   (`extension/src/services/pickle-utils.ts:165`) — **below this repo's measured fast tier of 835042 ms**.
   Reusing that default verbatim would time out on every pickle-rick bundle and make degraded the steady
   state. The post-final call MUST pass an explicit timeout at the call site, sized above the measured
   tier. That is a call-site argument, not a new operator surface, so it does not violate AC-5. The
   observed `timeout_ms: 1800000` in older state came from a deployed `worker_test_gate_timeout_ms`
   settings pin that `install.sh` MANAGED_KEYS now strips every deploy (B-SSAT) — it is NOT the default
   and MUST NOT be assumed.

2. Report the verdict through the mechanism that **already exists**, rather than inventing a second wire.
   `extension/src/bin/pipeline-runner.ts:4754` (`finalizePhaseSuccess`) already implements
   "run completes, verdict withheld": it raises `counters.nonConvergent` and sets
   `counters.phaseDispositions['pickle']`, and `finalizePipeline` at
   `extension/src/bin/pipeline-runner.ts:4142` computes
   `unsuccessful = pipelineFailed || counters.nonConvergent > 0`, which suppresses the success banner and
   skips closer-release. A red or absent post-final verdict raises the same term with a new disposition
   string. `exit_reason` remains `completed`.

3. **The `completion_promise` STRING IS NOT MODIFIED.** `extension/src/hooks/handlers/stop-hook.ts:394`
   does `hasToken(transcript, state.completion_promise)` — the promise is matched **literally against the
   manager's transcript text**, and the same value round-trips through `setup.ts`
   (`config.promiseToken`). Changing its serialized shape changes what the manager must emit to be
   recognized as complete; the failure mode is a run that never terminates — a reliability regression
   traded for a reporting fix. The degraded marker lands in a **separate state field / activity event**,
   never inside the promise token string.

4. An absent verdict is NOT a pass. Silence must read as degraded, never as green — **except** where the
   measurement is not applicable to the repo under test (AC-4a), which is neither degraded nor a measured
   success.

## Acceptance criteria

- **AC-1 — a verdict exists at completion.** On a bundle whose final ticket lands a commit, the recorded
  post-final verdict's timestamp is NEWER than that final commit's timestamp when the completion promise
  is synthesized. A test drives a run to final completion and asserts the recorded verdict post-dates the
  last commit.
  - **Field is pinned, not a disjunction.** The bundle either reuses `last_between_ticket_gate` or adds
    ONE named sibling field; the ticket names it, and the test asserts that name. "or the successor field"
    is not testable and is removed.
  - **Clocks are named.** `last_between_ticket_gate.ts` is stamped at gate **START**
    (`extension/src/bin/mux-runner.ts:681`: `const ts = (input.now ?? Date.now)()` precedes the test run),
    in `Date.now()` epoch milliseconds. The comparison is against the final commit's **committer time in
    epoch ms** (`git log -1 --format=%ct` × 1000). Equal timestamps count as fresh (commit and gate can
    land in the same second).
- **AC-2 — red withholds success.** With a red post-final verdict, the run does NOT report unqualified
  `all-tickets-done` success; it carries the degraded marker and a non-empty failing-dimension list. A
  test asserts the degraded shape.
  - **No dependency on the out-of-scope parser.** The degraded marker is derived from `ok === false` /
    `timed_out` / absent — **never** from `failures[].name`, which is produced by
    `parseBetweenTicketFastGateFailures` (`extension/src/bin/mux-runner.ts:630`), the R-GBANNER surface
    this bundle must not repair. The test asserts the marker plus a non-empty list; it MUST NOT assert any
    specific dimension string, and the oracle must pass with `failures: []`.
- **AC-3 — the run still completes.** With that same red verdict: every phase still executes, the epic
  still reaches a terminal state, `exit_reason` is NOT a new abort value, no ticket is demoted, and no
  work is discarded. This AC fails if the fix stops the pipeline.
- **AC-4 — absent is degraded, not green.** The post-final measurement is treated as ABSENT, and reported
  degraded, in each of these cases, one test per case: the call **throws** and is swallowed
  (`extension/src/bin/mux-runner.ts:8071` and the sibling swallow at `:11412`); the recorded verdict
  **pre-dates** the final commit (stale); the measurement never ran at all. Reuse the existing `not_run`
  vocabulary (`extension/src/bin/setup.ts:1328`) rather than inventing a new absent-marker.
- **AC-4a — not-applicable is NOT degraded (repo-agnostic invariant).** `runBetweenTicketFastGate` returns
  `null` immediately and writes nothing when `path.join(input.workingDir, 'extension')` does not exist
  (`extension/src/bin/mux-runner.ts:676-678`). On any non-pickle-rick target repo the measurement is
  **structurally** absent, so a naive "absent ⇒ degraded" rule would mark **every successful off-repo
  bundle** degraded — replacing a fake-green with a global fake-RED and breaking the repo-agnostic
  invariant. `not_applicable` is a THIRD verdict state: neither degraded nor a measured success. A test
  drives a bundle whose `working_dir` has no `extension/` and asserts the completion is NOT marked
  degraded.
- **AC-4b — a timeout is inconclusive, not a failing dimension.** With `timed_out: true` the gate returns
  `{ok:false, failures:[{name:'__timeout__'}]}` (`extension/src/bin/mux-runner.ts:654-666`) — a red
  verdict that is not a real test failure. The run reports **unmeasured / degraded-inconclusive** and
  carries NO test name as the failing dimension (never `__timeout__` as if it were a test). A test forces
  the timeout path.
- **AC-5 — no new terminal condition, no new operator surface.** No new `exit_reason` string, no new
  abort site, no new setting key, no new flag. The pin **extends the existing `EXIT_REASONS` parity test**
  (`extension/src/types/index.ts:1371`, enforced from `pipeline-runner.test.js`); no new member is added
  to `EXIT_REASONS` or `CRASH_FLOOR_EXIT_REASONS` (`extension/src/types/index.ts:1387`).
  - **A degraded run keeps `exit_reason: "completed"`.** Both completion seams route through the single
    authority `finalizeIfTrulyComplete` with `{ exitReason: 'completed' }`
    (`extension/src/bin/mux-runner.ts:2188`, `extension/src/bin/pipeline-runner.ts:4153`). An implementer
    MUST NOT reach for `finalizeFailedPipeline` or `finalizeNonSuccessTerminal` — doing so trips AC-3.
- **AC-6 — the regression oracle.** A test reproduces the `b88a6603` shape end-to-end: all tickets Done,
  final commit reddens the tree, and asserts the run completes WITHOUT reporting success. It must go RED
  if either defect is reintroduced.
- **AC-7 — tier green.** `npm run test:fast` reports `fail 0` AND `cancelled 0`, measured with
  `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and a clean environment. `cancelled > 0` is inconclusive:
  re-run, never report as pass. Test count must not shrink below 7647.

- **AC-8 — the stop hook still terminates the loop.** With the degraded state present, the stop-hook
  completion-detection path (`extension/src/hooks/handlers/stop-hook.ts:394`) still recognizes completion.
  A test drives completion through it and asserts the `completion_promise` string is byte-identical to the
  pre-change shape. **This AC fails if the loop cannot terminate** — it is the guard against trading a
  reliability regression for a reporting fix.
- **AC-9 — degraded is bundle-relative, not absolute (baseline).** A bundle whose `start_commit` tree was
  already red with failure set F, and whose final commit leaves exactly F failing, reports **green**, not
  degraded. A bundle that adds any failure outside F reports degraded. A test pins both directions.
  Absolute semantics would make every bundle branched off a red tree report degraded regardless of its own
  quality, destroying the signal this bundle exists to create — the repo already carries the inherited-red
  failure mode.
- **AC-10 — only a FRESH verdict decides.** A recorded verdict that pre-dates the final commit is treated
  as ABSENT (⇒ AC-4), never as the verdict itself. A stale red does not by itself withhold success; a
  stale red plus no fresh measurement does, via the absent path. This resolves the Defect-2-vs-AC-1
  conflict: in `b88a6603` the red verdict was 121 minutes stale and pre-dated commits that may have fixed
  it.
- **AC-11 — a bundle with no final commit.** If the bundle produced no commits at all, the completion
  reports green (nothing changed, nothing to measure) and is NOT marked degraded. A test covers the
  zero-commit bundle. Without this, every no-op/docs-no-op bundle reports degraded via AC-4.
- **AC-12 — the operator can see it.** The degraded verdict appears in the operator-visible completion
  output (the same banner/line that today reports success), not only in `state.json`. A test asserts the
  rendered completion text carries the degraded marker. Without this AC, a conforming implementation could
  write the marker to state and display nothing — and the whole value claim is what the operator SEES.
- **AC-13 — root cause recorded, all call sites considered.** The bundle records WHY the existing
  post-final call at `extension/src/bin/mux-runner.ts:8067` produced no verdict, and states whether
  `:11412` / `:11668` are affected. A test fails against the pre-fix code path. Adding a second call site
  without a diagnosis does not satisfy this.

## Run posture

**ATTENDED (R-PSRB).** `build_mode: attended`. This bundle edits the Done-flip / completion-evidence seam
(`extension/src/bin/mux-runner.ts:8042-8075`, `:2143-2197`) — the edit sites sit immediately after
`guardCompletionCommitBeforeDone` and `markTicketDone`. The deployed pre-fix runtime applies this same
logic to the worker building the fix. Launch normally, watch the completion seam, recover a wedge if it
bites and record it. Attended is an operator posture, never a different build path — **no hand-building**.

## In-scope files (fence source)

- `extension/src/bin/mux-runner.ts` — the measurement + verdict recording (both completion seams)
- `extension/src/bin/pipeline-runner.ts` — reuse of the `nonConvergent` / `phaseDispositions` withholding
- `extension/src/types/index.ts` — the verdict field, co-scoped with any new activity event (a new event
  requires the SAME ticket to edit `VALID_ACTIVITY_EVENTS` **and**
  `extension/src/types/activity-events.schema.json`, or the per-file scope fence blocks the registration
  edit and the ticket deadlocks at zero commits)
- `extension/src/hooks/handlers/stop-hook.ts` — AC-8 only
- new tests under `extension/tests/`

**Do-not-edit surface:** `parseBetweenTicketFastGateFailures` (`extension/src/bin/mux-runner.ts:595-631`)
— that is R-GBANNER, explicitly out of scope.

**Extend, do not duplicate:** `extension/tests/pipeline-finalize-honesty.test.js` (already the honesty-gate
home; `finalizePhaseSuccess` is exported for it), `extension/tests/nostop-gates-phase-loop.test.js`
(terminal-`exit_reason` survival), `extension/tests/completion-authority-single-source.test.js:122` (counts
`applyAllTicketsDoneCompletion(` against a floor — read before editing).

## CUJ — operator reads an unattended bundle's verdict

1. Operator launches a bundle unattended and walks away.
2. All tickets reach Done; the final ticket's commit lands.
3. The pipeline measures the fast tier at that commit before synthesizing the completion promise.
4. Green ⇒ the operator sees the usual `all-tickets-done` success and ships without re-measuring.
5. Red or unmeasurable ⇒ the operator sees a degraded completion naming the failing dimension, the run has
   still finished every phase, no ticket is un-flipped, and the operator triages instead of ships.

The success condition for this bundle is **step 4**: an unattended green no longer requires a human
re-measurement to be believed.

## Assumptions

1. The repo under test has an `extension/` dir with a `test:fast` script; otherwise the measurement is
   NOT APPLICABLE, not failed (AC-4a).
2. The post-final call passes a timeout exceeding the tier's real runtime; when it does not, the verdict is
   inconclusive (AC-4b), never a named failing dimension.
3. `last_between_ticket_gate.ts` is stamped at gate START, compared against the final commit's committer
   time in epoch ms (AC-1).
4. `state.current_ticket` being null at `extension/src/bin/mux-runner.ts:8042` explains the missing verdict
   on the token path, but the `:2143` synthesis path has no gate at all — the latter is the defect path.

## Risks and mitigations

| Risk | Evidence | Mitigation |
|---|---|---|
| "Absent = degraded" fires on every off-repo bundle, breaking the repo-agnostic invariant | `runBetweenTicketFastGate` returns `null` when `<workingDir>/extension` is missing (`mux-runner.ts:676-678`) | AC-4a: `not_applicable` is a third verdict state, neither degraded nor success |
| The measurement times out by construction on this repo, making degraded the steady state | default `600_000` ms (`pickle-utils.ts:165`) vs measured tier `835042` ms | Solution §1: explicit call-site timeout above the measured tier; AC-4b reports a timeout as inconclusive |
| Promise-shape change breaks loop termination | `stop-hook.ts:394` matches `hasToken(transcript, state.completion_promise)` literally | Solution §3 + AC-8: the promise string is NOT modified; marker lives in a separate field |
| Failing-dimension text comes from the out-of-scope R-GBANNER parser | `parseBetweenTicketFastGateFailures` fallback at `mux-runner.ts:630` | AC-2: assert the marker + non-empty list only, never a dimension string; oracle passes with `failures: []` |
| A second call site is bolted on while the original dead one stays dead | Defect 1 root cause was open at authoring | AC-13: root cause recorded, test fails against the pre-fix path |
| No kill-switch (AC-5 forbids new operator surface) | AC-5 | Accepted deliberately; remedy is revert + `bash install.sh`. Stated, not accidental. |
| ~14 min added to the tail of every bundle | measured fast tier 835042 ms | Accepted; the measurement is the point. No new budget key. |

## Out of scope

`R-GBANNER` (the gate's failure parser reporting an npm banner as a test name) — this bundle must not
also fix the parser, though its oracle should not DEPEND on the parser being correct. `R-SJLAGMT` and
`R-TIERWEDGE` likewise: if the tier flakes or wedges during this work, that is those tickets, not this
one.

## Simplification Review

1. **What can be subtracted instead of added?** Defect 2 is pure subtraction: stop asserting success that
   was never measured. The success claim is the thing being removed, not a check being added.
2. **Can it REUSE instead of ADD?** Yes, and refinement found the reuse. `pipeline-runner.ts:4754`
   (`finalizePhaseSuccess`) already implements "run completes, verdict withheld" via
   `counters.nonConvergent` + `counters.phaseDispositions`, read by `finalizePipeline:4142` as
   `unsuccessful = pipelineFailed || counters.nonConvergent > 0` — its own comment says verbatim "without
   adding a new gate, field, or halt". Solution §2 raises that existing term instead of building a second
   parallel wire, which satisfies AC-2, AC-3, and AC-5 with strictly less new surface. The only genuine
   ADD is the post-final measurement itself (Defect 1) and one named verdict field.
3. **Does this add a new abort condition?** No — AC-3 and AC-5 forbid it. The verdict changes what is
   REPORTED, never whether the run continues.
4. **Does this add a new configuration surface?** No — AC-5 forbids it. The post-final timeout is a
   call-site argument, not a settings key.
5. **Is a fix at this seam load-bearing for anything else?** Yes, decisively. Every bundle's green
   currently requires an operator-run measurement to be believed — that is a human in the loop on every
   single run. This is the fix that makes an unattended green mean something.
