# B-MERGE-REL — merge the experimental line, close every non-floor phase-stop path, then ratchet (v2)

Revised plan. v1 was synthesized from four read-only investigations; v2 resolves the blocking and should-fix
problems raised by two adversarial reviews (complexity skeptic, measurement verifier). Every resolution was
re-checked against `origin/exp/b-parallel-build@d9767fcb`, `origin/main@0e41cf8e` and the deployed runtime
`1bacc67a`, read with `git show`. Code ran only in a throwaway worktree, since removed. Nothing was edited in the main
checkout. Each claim is MEASURED (with its command or file:line) or marked HYPOTHESIS.

**Ratchet order.** Part 1 is job 1 (autonomy). Part 2 is the merge. Part 3 is quality. Part 4 is speed. Within
Part 1, stop paths come first, then instruments, then honesty items. Nothing in Part 3 or 4 may take a Part 1 slot.

**Invariants kept.**
- No new gate leg, verdict, classifier, lint or halt. Gate legs stay 22 → 22.
- No client data in any artifact.
- Every disposition this plan writes reuses an existing name: `crash_downgraded`, `setup_error`,
  `empty_branch_diff`, `nonConvergent`, `phaseDispositions`.

## The phase failure this week (numbers only)

**HYPOTHESIS, high confidence: #53.** That run was a degraded completion (`Pipeline finished: 3/4`), not a halt.

**The chain**, reconstructed from the issue text plus code at `fc9e05dd`. The session dir is absent locally.
1. The lane sweep refused 3× on ~2,250 errors misattributed to itself. Its `start_commit` was the pipeline base, it
   subtracted no baseline, and its worktree lacked its environment.
2. The R-ORSR-6 refusal bound then saw a RED cap gate and returned `no_progress`.
3. `integrate: isLaneSuccess(reason)` stranded the lane's 3 commits.
4. `aggregateLaneExitReason` reported the phase as non-convergent, giving 3/4.

**Inputs fixed at the branch head and pinned:**
- L1: `start_commit: phaseStartSha`.
- G2: the sweep replays a typecheck at `start_commit`.
- L2: the run falls back to serial on a node_modules gap.
- L4: stranded commits are listed.
- Pins: pipeline-runner.test.js L1-a :4875, A2-4 :5283, L4 :5404, L2 :5892, L3-e2e :5973.

**The tail is unchanged.** A RED gate at the bound still means `no_progress`, still means not integrated, and the
phase is still non-convergent (microverse-post-convergence-gate-bound.test.js:242). That is the stranded-work class
that Number 2 below counts and that WS-A4 addresses.

## Reliability metric — two numbers, both computed by existing tools over existing data

v1's headline HC counted #53's 3/4 as a success, and its 65/74 baseline was hand-classified. The verifier measured
that `census.py` prints a listing and does not compute the split, so it cannot be reproduced. v2 uses two numbers.
Both come from per-session artifacts every pipeline already writes: `pipeline-runner.log`, `pipeline-status.json`,
`archive/lanes.json` and `spawn-refinement.out`.

| # | Name | A run counts as a success iff | Answers |
|---|---|---|---|
| N1 | **Hands-off completion** | It is a pipeline whose `pipeline-runner.log` has `Pipeline finished:` and exactly one `pipeline-runner started`, or a refinement whose `spawn-refinement.out` has `MANIFEST=`. | Did the loop run to its end with no human relaunch? (job 1, the autonomy floor) |
| N2 | **Converged, nothing stranded** | It is a pipeline that is an N1 success, has `completed_phases + skipped_phases == total_phases` in `pipeline-status.json`, and has 0 commits in `archive/lanes.json` rows whose `outcome != "integrated"`. | Did every phase converge with no verified work left behind? |

- **#53 counts as an N2 failure** (3 < 4 completed, and its lane was not integrated) and as an N1 success. That is
  correct: it did not stop, but job 1's kind of failure still happened.
- **Withheld-success causes stay out of N2.** Tier red and done-over-red only withhold success. That is the separate
  honesty wire, and mixing it in would make N2 a quality number.

**Baseline (MEASURED 2026-10-03 over `~/.local/share/pickle-rick/sessions`, the 17 top-level session dirs).**
Commands: `grep -c` over each file named above, and one inline `python3 -c json.load` over `pipeline-status.json` and
`archive/lanes.json`.
- **N1 = 16/17.** Pipelines are 14/14: all logged `Pipeline finished:` and all have 1 start. Refinements are 2/3:
  `2026-09-26-d2d766d2` was killed and has no `MANIFEST=`.
- **N2 = 13/14.** The one failure is `2026-09-27-03d1f8d2`: completed 3/4, szechuan `stalled_below_target`.
  Stranded lane commits: 0 in all 14.

**Denominator limits, stated rather than hidden.**
- The activity log is not usable as a denominator. It holds 76 distinct `session_start` events, but 182,269
  `session_end` events, which is test traffic (F10). Only 17 of the 76 sessions still have a dir.
- Launch crashes that never create a dir, such as 2026-09-25-ec211f95, are invisible to both numbers. The ledger
  therefore records a row **at run end**, while the dir exists (WS-A11). It does not rely on a retrospective census.
- Field runs are counted the same way, on the field machine, with numbers only.

**Recording.** WS-A11 makes `field-timing.py --json` emit N1/N2 inputs per row. Each row goes into the MASTER_PLAN
ledger, which v1 proposed renaming to "completion ledger". It carries a `population` column (`local` | `field`).
- There is no hand-marked `hands-off` column. Hands-off is measured as `launches == 1`.
- A row is credited to a build only after a deployed-content grep.
- These are numbers in the ledger and the release note, never a gate leg.

**99.9999% is not countable.** With zero failures at 95% confidence it needs n ≈ 3.0M consecutive runs. It is
approached structurally: every non-floor stop path at HEAD gets a ticket (below), and N1/N2 are tracked per release.

**Non-floor stop paths at HEAD (code census, for Part 1 scope — not a release number):**
1. An uncaught exception anywhere in `runPhaseIteration`. This includes the `SCOPE_EMPTY_POST_BUILD` rethrow and a
   lane exception rejecting `Promise.all`. → WS-A1b, WS-A1.
2. The `closer_handoff_terminal` break (:6682). → WS-A2.
3. `isFatalPhaseFailure`'s default `return true` (:4739), which halts on any non-zero citadel exit. → WS-A12.
4. F7, a microverse child hang with no exit. This is not a stop but a non-exit. → WS-A3.

**Branch A (pickle iteration cap with unfinished tickets, :6633) is NOT on this list.** The root CLAUDE.md crash
floor names "budget/iteration cap", so v1's O-4 is settled by the existing rule and needs no operator decision.

## Decisions

- **D-1 — merge source first; keep the deployed runtime at `1bacc67a` while Part 1 runs; deploy afterwards.**
  - **Why merge first.** After the merge there is one line, so rule P's merge-down step disappears. Building Part 1
    on main and merging down would land every item on `pipeline-runner.ts`, which differs by +1306/−69 (`git diff
    --numstat origin/main origin/exp/b-parallel-build`).
  - **Why not deploy first** (skeptic should-fix, accepted). `1bacc67a` has the evidence: 14/14 pipelines finished
    and 53/53 lanes integrated. `d9767fcb` adds 52 commits that have never run deployed. The job-1 bundle should run
    on the most-evidenced runtime. Source and runtime are isolated, so merging source does not require deploying it.
  - **The bundle's ledger row is credited to `1bacc67a`**, by content grep.
- **D-2 — merge `exp/b-parallel-build` alone.** `git rev-list --count origin/exp/b-parallel-build..origin/exp/b-lanes`
  = 0, so merging lanes first buys nothing and costs a second gate.
- **D-3 — parallel defaults stay at 1.**
  - Both settings fall back to 1 (pipeline-runner.ts:325-326) and are read from the session pipeline.json only.
  - The Part 1 bundle runs with `anatomy_max_parallel_lanes: 2` and `max_parallel_tickets: 1`.
  - Scope of the evidence: 8 soak ledger rows and 36 lanes integrated (the ledger rows), while on disk there are 12
    `lanes.json` files and 53/53 lanes integrated.
- **D-4 — #53's tail is answered by correcting a predicate (WS-A4), never a new verdict.** WS-A4 is conditional on
  the operator reversing the pinned R-ORSR-6 intent. WS-A4 is also the list-free answer to environment gaps (see
  WS-A5 below): the integration typecheck runs in the main checkout, which has the full environment.
- **D-5 — one boundary catch closes the exception class**, but only after lane and unit children can no longer
  outlive a phase (WS-A1b precedes WS-A1).
- **D-6 — gate leg count 22 → 22.** Nothing adds a leg, verdict, lint, classifier or halt. field-timing.py and the
  ledger are instruments outside the gate.
- **D-7 — one bundle (Part 1 + Part 3).** CLAUDE.md says to compose large bundles, and the review toll is paid per
  bundle. This is a composition choice, not an operator decision (it was v1's O-11).
- **D-8 — #63 pane holds are deleted outright, with no bounded hold.** Subtraction. Completion is read from
  `Pipeline finished:`. This was v1's O-12.

## Part 1 — job 1: tier-1 autonomy

Every AC follows "an AC is a measurement instrument": **at breakdown, run the predicate against HEAD, confirm it
reds, and confirm the expected literal is the measured one.** "MEASURED red" means it was run. "Predicted red" means
it was read, and the breakdown must run it.

### Surface S1 — `extension/src/bin/pipeline-runner.ts` (phase loop, lanes, waves)

**WS-A1b — a lane or unit exception is an outcome; lanes always settle and are always reaped (tier: medium)**
- **Why.** `runLaneSession` calls `setupAnatomyPark` outside any try (:2207). A throw rejects the worker, so
  `await Promise.all` (:2281) rejects. Its `finally` only clears the poll, so the following are all skipped:
  - `reapCancelledLanes`;
  - `removeLaneWorktrees`;
  - `integrateLaneRun`.

  The sibling workers keep running after the rejection. Today that exit is fatal. Under WS-A1 it would `continue`
  into szechuan with live lane runners. That is unsafe (skeptic blocking #2, verified at :2180-2286).
  `runTicketWave` has the same shape (`Promise.all` at :2664, reap after it).
- **Change.** Reuse the existing mechanisms; add none.
  1. `runOneLane` widens its existing `createLaneSession` catch to cover `runLaneSession`, so a throw becomes
     `notStarted(LANE_NO_VERDICT)` plus a log line. `runTicketUnit` does the same for its post-runner read and
     returns `notRun`.
  2. `runAnatomyLanes` and `runTicketWave` use `Promise.allSettled`. In `finally`: a rejected settle calls the
     existing `cancelLaneRun(run)` (SIGTERM), then `reapCancelledLanes(run)` (SIGKILL after grace), then
     `removeLaneWorktrees`, whatever the settle outcome. A rejected slot maps to `LANE_NO_VERDICT` / `not_done`.
- **AC-1b-1.** Roster of 2 lanes, cap 2; lane 1's setup throws (fixture chosen at breakdown, e.g. the EISDIR
  technique documented at `runPhaseSetup`, root-independent). The following must all hold:
  - `runAnatomyLanes` resolves;
  - lane 1's outcome is `LANE_NO_VERDICT`;
  - lane 2 integrates normally;
  - before the function returns, 0 spawned lane pids are alive and 0 `--lane-` entries remain in
    `git worktree list`.

  Predicted red at HEAD (rejects).
- **AC-1b-2 (control).** A roster where no lane throws produces lanes.json byte-identical to HEAD's for the same
  stub.
- **Pins.** pipeline-runner.test.js L1-a/L2/L3-e2e/L4 must stay green unchanged.

**WS-A1 — one catch at the phase-iteration boundary; the floor is a measured fact, not a class (tier: medium)**
- **Why.** `runPipelinePhaseLoop` (:7177) has no catch around `runPhaseIteration`, so any throw ends the run `fatal`.
  - v1 proposed rethrowing on `StateError`. That keeps the transient path fatal, because
    `LockError extends StateError` (types/index.ts:541) and `TransactionError extends StateError` (:552). MEASURED.
  - `CRASH_FLOOR_EXIT_REASONS` is a list of exit_reason strings, not exception types, so v1's "reuse the existing
    classification" had nothing to reuse for a thrown error.
- **Change.**
  - Catch around `runPhaseIteration`.
  - **The floor probe is the disposition write itself.** It is one un-swallowed `sm.update(statePath)` that appends
    the `recoverable_phase_failure` activity entry with the error message. If that write throws, state is
    unreadable or unwritable, so rethrow the ORIGINAL error. That is the floor the root CLAUDE.md lists.
    - Otherwise, set `counters.skipped++`, `phaseSkips[phase] = 'crash_downgraded'` (the existing name; it already
      withholds success via `DEGRADED_PHASE_SKIP_REASONS`), `writeRunningStatus`, then
      `cancelledOutcome(...) ?? continue`.
    - There is no class list. A `LockError` whose lock has cleared continues. A lock still held after
      `maxLockRetries` makes the probe throw, so the run halts.
    - `SchemaVersionMismatchError` re-throws on the probe's read, so the floor is kept.
  - Note: `recordRecoverablePhaseFailure` swallows its own write error (:4826), so the probe cannot be that helper
    unchanged. Either add a non-swallowing variant used only here, or inline the `sm.update`.
- **Empty post-build scope — actual routing** (both reviewers' should-fix). `refreshPhaseScope`'s catch ends in an
  unconditional `throw err` (:4989-5000), and `refreshScope` throws `SCOPE_EMPTY_POST_BUILD` at anatomy-park only
  (scope-resolver.ts:336). Deleting the field alone would land in the new catch as `crash_downgraded`, which is
  wrong. Instead:
  - `refreshPhaseScope` returns a skip result in place of throwing. `ScopeError` code `SCOPE_EMPTY_POST_BUILD` maps
    to `{ skipReason: 'empty_branch_diff' }`: "this run authored no reviewable change", a benign existing member
    outside `DEGRADED_PHASE_SKIP_REASONS`. Update that member's comment, which today says "unscoped run". Any other
    refresh error maps to `{ skipReason: 'setup_error' }` (existing, degraded).
  - `runConfiguredPhase` returns the skip exactly as it does for a setup skip.
  - Delete `throwOnEmptyScope` (:241, 4 literals at :4158-4213), the arm's `writePipelineStatus('failed')`, and the
    rethrow.
  - `refreshScope` itself is unchanged. Deleting its throw would hand anatomy-park `allowed_paths: []`, which
    `resolveAnatomySubsystems` (:3715) treats as UNSCOPED and reviews every subsystem.
- **AC-1a.** Use the in-process seam `__setSpawnRunnerForTests` and the harness of
  pipeline-runner-phase-fail-continue.test.js. With phases `[anatomy-park, szechuan-sauce]`, the anatomy spawn rejects
  with a plain `Error`. Expected:
  - szechuan is spawned;
  - `Pipeline finished:` is logged;
  - `phase_skips['anatomy-park'] === 'crash_downgraded'`;
  - pipeline-status is `failed` (withheld);
  - `exit_reason !== 'fatal'`.

  **MEASURED red at HEAD** by the verifier: main() rejected, there was 1 spawn, and no `Pipeline finished`.
- **AC-1b.** Fixture of pipeline-runner-dispatch.test.js:495 ("main preserves anatomy-park empty scope failure").
  `main` resolves, with `phase_skips['anatomy-park'] === 'empty_branch_diff'` and pipeline-status `completed`.
  **MEASURED red at HEAD**: that test pins the rejection plus `status: failed` (:517-521).
- **AC-1c (control).** Mid-phase, `state.json` is replaced by a directory (root-independent), and the spawn stub
  throws. The probe write fails, the original error is rethrown, and the CLI stamps `fatal`.
- **AC-1e (LockError control).** The spawn stub rejects with `new LockError(...)` while state is writable. The next
  phase runs. This is the skeptic's requested control.
- **Pins to invert or update in this ticket.**
  - pipeline-runner-dispatch.test.js:229/237/244/251: the `throwOnEmptyScope` asserts are deleted with the field.
  - pipeline-runner-dispatch.test.js:495-521: inverted to AC-1b.
  - Comment-only, because they describe the deleted fatal arm: scope-filters.test.js:150-151 and :255,
    scope-refresh.test.js:499, pipeline-runner-phase-fail-continue.test.js:916/929/1084-1085, and
    pipeline-finalize-honesty.test.js:864/928. That last test calls `writePipelineStatus` directly and stays green.
  - Must stay green unchanged: scope-refresh.test.js:333 and scope-pipeline.test.js:183, because `refreshScope`
    still throws.

**WS-A12 — no phase halts by default; citadel's missing inputs park instead of stopping (tier: small)**
- **Why** (skeptic blocking #3, verified). `isFatalPhaseFailure` ends `return true` (:4739) for any phase other
  than pickle, anatomy-park and szechuan. A non-zero citadel exit therefore halts. `executeCitadelPhase` returns 1
  when `resolveCitadelPhaseInputs` fails (:4558), for example on a missing `state.prd_path`, and a missing PRD is not
  on the floor list.
- **Change.** Both parts are subtractions.
  1. In `isFatalPhaseFailure`, drop the `phase === 'pickle'` condition. Every non-microverse phase then shares the
     floor checks: missing `start_commit`, or `isCrashFloorExitReason`. Three arms become two, and a future phase
     cannot halt by omission.
  2. `finalizePhaseSuccess`'s honesty test keys on the exit code rather than the phase name. A non-pickle phase that
     exits non-zero is `nonConvergent++`, with `phaseDispositions[phase]` set to its string `exit_reason`, else
     `exit_<code>`. The AP-EXT-ITER5-01 comment already establishes that, for microverse phases, exit ≠ 0 ⟺ not
     success. This widens one predicate and deletes the anatomy/szechuan name test. Without it, a non-zero citadel
     would fall through to `completed++` and fake-green.
- **AC-12a.** Phases `[citadel, anatomy-park]`, `start_commit` present, and `prd_path` absent and unhealable (verify
  against `healPipelineRequiredFields` at breakdown). Expected:
  - anatomy-park runs;
  - `Pipeline finished:` is logged;
  - pipeline-status is `failed` (withheld);
  - `phase_dispositions.citadel` is set.

  Predicted red at HEAD (`dispatchHaltAction` breaks).
- **AC-12b (control).** `start_commit` absent: citadel still halts. That is the floor.
- **Pins.** pipeline-runner-done-without-commit-evidence-fatal.test.js:319 ("AC-GTRUTH-A2-7: a non-pickle,
  non-microverse phase failure is STILL fatal") is inverted. oneabort-termination-invariant.test.js:451 tests
  `logPhaseHaltReason` directly and stays green.

**WS-A2 — remove the `closer_handoff_terminal` break (tier: small)**
- **Change.** Delete the `exitCode === 0 → break` arm (:6680-6683). In its place, reuse the
  `withholdForFailedAcGate` shape: `counters.nonConvergent++`,
  `phaseDispositions[phase] = 'closer_handoff_terminal'`, a log line, then `continue`.
- **Why this is the withhold** (verifier should-fix, verified). Once the break is gone, `claimPipelineRunnerActive`
  clears `closer_handoff_terminal` at the next phase entry (:1957). `handoffStop` (:6154) then reads false. Without
  the `nonConvergent++`, nothing would withhold success.
- **Not deleted.** `PIPELINE_HANDOFF_EXIT_REASONS` / `readHandoffExitReason` have a second reader (:6154,
  `effectiveFailed`), which still governs a pickle-only pipeline. v1's "may go" is withdrawn.
- **AC-2a.** Phases `[pickle, citadel, anatomy-park, szechuan-sauce]`, and the pickle stub exits 0 with
  `closer_handoff_terminal`. All 4 phases run, `phase_dispositions.pickle === 'closer_handoff_terminal'`, status is
  `failed`, and install/tag are not invoked. Predicted red at HEAD (break).
- **AC-2b (control).** A pickle `toolchain_unavailable` still halts.
- **Pins.**
  - Inverted: pipeline-runner-phase-no-progress.test.js:391 (R-CCR-10 asserts "stopped for manager handoff" and the
    preserved reason).
  - Must stay green: pipeline-runner-phase-no-progress.test.js:519 (R-CCR-5: pickle-only, handoff still read at
    finalize, so install/tag are still skipped), pipeline-runner.test.js:1204 (R-CCR-3 clear at entry), :2745
    (AC-CCR-5-1 comment anchor), and tests/integration/closer-handoff-terminal.test.js (mux-runner side, untouched).
    v1's verifier listed all of these as inversions; only R-CCR-10 inverts.

**WS-A3 — heartbeat for microverse-runner children (F7) (tier: medium, Step-0 gated)**
- **Step 0.** Measure whether microverse-runner bounds a single hung iteration (gap analysis, worker spawn, judge).
  If it does, close with `zero_diff_intent: already-satisfied`.
- **Change if it does not.** Widen `armPhaseChildMuxRunnerHeartbeat`'s predicate (:1749) to any phase runner, lane
  runners included, using the progress signal the mux heartbeat already reads. No second watchdog.
- **The window stays `child_mux_runner_stall_seconds`, 1800 s by default** (:313). That is above the longest
  documented silent interval inside an iteration: the tier stall window (600 s) plus the judge cap (120 s). Step 0
  must also measure the longest gap between progress-signal writes across the local microverse logs, and confirm it
  is under 1800 s, before arming.
- **AC-3.** A microverse child stub that writes nothing for longer than the window is reaped, the phase records a
  disposition, and the next phase runs. Predicted red at HEAD (:1749 returns null for non-mux args).

**WS-A4 — a non-convergent lane's commits go through the existing pick (tier: medium, CONDITIONAL on operator
decision 4)**
- **Change.** `integrateLaneRun` (:2474) uses `integrate: commits > 0 && reason is not cancel/crash` in place of
  `isLaneSuccess(reason)`. The integration typecheck runs in the main checkout, which has the full environment, so it
  decides. The phase disposition still reports `non_convergent`.
- **Test.** Add an L3 variant that runs the REAL `handleSelfRedRefusalBound` / cap-gate path (L3-e2e stubs it,
  MEASURED).
- **AC-4.** A `no_progress` lane with 2 commits that typecheck clean at integration ends `outcome: 'integrated'`,
  main advances by 2, and the phase is still non-convergent. A lane whose pick reds integration is retained
  (control). Predicted red at HEAD.
- **Pins.** microverse-post-convergence-gate-bound.test.js:242 stays green: the runner still ends `no_progress`.

### Surface S5 — instruments and templates

**WS-A9 — finished runners exit: all 9 pane holds (#63) (tier: small)**
- **Change.** Delete every pane-hold `read`:
  - `read -r _` in pickle-pipeline.md:259, anatomy-park.md:275, szechuan-sauce.md:262, pickle-microverse.md:137 and
    plumbus.md:233, each with its "Pipeline finished. Ctrl+B…" echo;
  - the trailing `; read` in pickle-tmux.md:65, pickle-refine-prd.md:842, council-of-ricks.md:186 and
    portal-gun.md:661.

  Update README if it documents the hold.
- **AC-9.** `git grep -nE '(; |^)read( -r _)?("|$)' -- .claude/commands` returns 0 lines. MEASURED 9 at HEAD; the
  zellij `IFS='.' read -r ZMJ…` line is not matched.

**WS-A10 — refinement records how it ended (tier: small)**
- **Change.** `handleShutdownSignal` (spawn-refinement-team.ts:1412) already writes "Received SIGTERM — killing N
  worker(s)" to `.out`. That half exists (MEASURED in 2026-09-26-d2d766d2). Add the activity event: reuse the
  `signal_received` shape, naming the signal and the cycle.
- **AC-10.** SIGTERM to a refinement stub writes a `signal_received` activity event with `signal` and `cycle`.
  Predicted red: d2d766d2's activity holds only `session_start` and `time_cap_disabled_default`.

**WS-A11 — field-timing.py emits the N1/N2 inputs and keeps every session (tier: small)**
- **Change.**
  - Delete the `phases_min or tickets` drop filter.
  - Copy, without interpreting:
    - `finished`: `Pipeline finished:` present;
    - `launches`: count of `pipeline-runner started`;
    - `status`, `completed_phases`, `skipped_phases`, `total_phases` from `pipeline-status.json`;
    - `stranded_lane_commits`: the sum of `len(commits)` over lanes.json rows with `outcome != "integrated"`;
    - `refinement_manifest`: `MANIFEST=` in `spawn-refinement.out`.
  - Print N1 and N2 as two count lines.
  - No hand-marked column and no enumerated event list.
  - Rename the MASTER_PLAN ledger and add `population`.
- **AC-11.** Run over the local sessions dir, it emits 17 rows, including 2026-09-26-d2d766d2, and prints
  `N1 16/17` and `N2 13/14`.
  - MEASURED at HEAD: 14 rows, d2d766d2 absent.
  - The expected literals are the values measured above with the stand-in commands; re-measure them at breakdown,
    because the corpus grows.
  - Replaces v1's AC-11, which depended on a session dir that does not exist (2026-09-25-ec211f95) and on a 65/74
    split that no tool computes.

### Part 1 tail — honesty items (cannot stop a run; ordered after the autonomy items)

**WS-A6 — szechuan cannot converge on a regressed HEAD (#67) (tier: medium)**
- **Mechanism.** `guardedMicroverseRollback` refuses whenever the worker committed (microverse-runner.ts:5289-5294).
  The history entry still says `action: 'revert'`, and `getLastAcceptedScore` (microverse-state.ts:477) skips it.
  - The discriminator is **HEAD itself**, not a new field. The caller already holds HEAD (`_deps.getHeadSha`) and
    passes it to `isConverged(state, headSha)`.
  - When the last entry is a `revert` and `headSha !== entry.pre_iteration_sha`, the rollback did not happen. The
    current score is then `entry.score`. Otherwise use `getLastAcceptedScore` as today.
- **AC-6.** Fixture: `convergence_target: 0`, `key_metric.direction: 'lower'`, `baseline_score: 0`, and history
  `[{action:'revert', classification:'regressed', score:1, pre_iteration_sha:'X'}]`.
  - `isConverged(state, 'Y')` must not be `'target'`.
  - Control: `isConverged(state, 'X')` (rollback executed) stays `'target'`.
  - **MEASURED at HEAD in the throwaway worktree:** HEAD=Y gives `target` (red); HEAD=X gives `target`; and with
    `convergence_target: null` it gives `null`. So a fixture without the target set passes before any fix, which
    is why the target is set. Mutation: revert the predicate and it must red.

**WS-A7 — an uncertifiable baseline is disclosed with its true cause (#66) (tier: small)**
- **Step 0.** Build the fixture first: baseline `tests: failed` (timeout), then 2 clean no-commit passes. It is
  predicted to converge with empty `cap_unmeasured_checks` (HYPOTHESIS).
- **Change.** `recordUncertifiableBaselineDefer` (microverse-runner.ts:880) calls the existing
  `discloseCapUnmeasured` (:857) with the baseline's failed or unrun checks. The log text is derived from
  `check_status`, replacing the hard-coded "no project type detected" (:881).
- **AC-7.** The fixture ends `converged_with_unmeasured`, with `cap_unmeasured_checks ⊇ ['tests']`.

**WS-A8 — Skipped/Failed tickets are disclosed (#65) (tier: small) — disclosure only**
- **Change.** One line after `Pipeline finished:` (in `writeFinalPipelineActivity`, :5524) lists Skipped and Failed
  tickets with their reasons. **No success withhold:** v1's "any Skipped ticket withholds success" was a new verdict
  case and is dropped, per the operator rule. One informational template line: verification-only tickets declare
  `zero_diff_intent: verification` (existing enum).
- **AC-8a.** An epic with 1 Skipped ticket of 3 logs the line naming it. Pipeline status is whatever HEAD gives.
- **AC-8b.** `grep -c zero_diff_intent .claude/commands/pickle-refine-prd.md` ≥ 1. MEASURED 0 at HEAD.

**WS-A5′ — node_modules discovery without a depth constant (F4) (tier: small)**
- **What v1 proposed, and why it is out.** v1 counted every ignored path. On this repo,
  `git ls-files -o -i --exclude-standard --directory` gives 9 entries (MEASURED 2026-10-03), and 7 are not
  node_modules: `.claude/scheduled_tasks.lock`, `.codegraph/`, `.pickle-rick/`, `activity/`, `extension/.codegraph/`,
  `extension/.pickle-rick/` and `extension/mux-runner.log`. Lanes and waves would go serial here and in nearly every
  repo. That would cancel D-3 and be a de facto default change.
  - **List-free alternatives, measured and rejected.**
    - "Ignored paths a tracked file references": tracked files mentioning them number `.codegraph` 61,
      `.pickle-rick` 24, `activity` 607 and `mux-runner.log` 71. It over-triggers identically.
    - "Lane baseline red vs main baseline green": in lanes mode the main checkout takes no baseline at
      `phaseStartSha`, so this needs a new per-phase gate spawn.
  - An exclusion list is not allowed.
  - **So the widened F3 predicate stays out.** F3 (ignored build output such as `dist/`) is handled by WS-A4
    (main-checkout integration typecheck) when the operator approves it. Otherwise it is disclosed as stranded work
    and counted in N2.
  - v1's example `extension/bin` was wrong: it is tracked (63 files; `git check-ignore` rc=1).
- **What ships instead.** Replace the `findNodeModulesDirs(repoRoot, maxDepth = 3)` walk (anatomy-lanes.ts:97) with
  the git ignored listing filtered to basename `node_modules`. This is the same membership rule the walk already
  applies (:108), with no depth constant. It feeds both the count (:137) and replication (:173).
  - MEASURED on this repo: both methods give `node_modules/` and `extension/node_modules/`, both under tracked dirs,
    so the gap is 0 and lanes are unchanged here.
- **AC-5b.** Fixture `a/b/c/d/node_modules/x` with a tracked `a/b/c/d/src/f.ts` gives gap 0 and the dir is
  replicated. MEASURED red at HEAD by the forensics probe: `findNodeModulesDirs → []`.
- **AC-5c (control, widened per the verifier).** A repo with a root `node_modules` plus a gitignored `*.log` and a
  `.cache/` dir still runs lanes (gap 0).

## Part 2 — the merge (before Part 1 runs; operator-driven; deploy is NOT part of it)

1. **Pre-merge (read-only).**
   - Gate green at `d9767fcb` (MEASURED 22/22).
   - The client-identity count does not rise (MEASURED 145 on main, exp and the merged tree).
   - **List the default-on changes with their effect on a user who sets nothing.** These are v1's 3(c): refinement,
     citadel, scope and check-readiness. Read `git diff origin/main origin/exp/b-parallel-build` for each file in
     merge finding M3. Today they are named but not measured: UNMEASURED.
2. **Fast-forward local `main` to `origin/main` (`0e41cf8e`).** Local `main` is `06af73a4`, 7 behind. Record that sha
   as the rollback ref.
3. **`git merge --no-ff origin/exp/b-parallel-build`.** Predicted tree `464e6d7a`, rc=0 (MEASURED with
   `git merge-tree`).
4. **Merge commit and README disclose the user-visible changes:**
   - (a) The unscoped serial anatomy rotation is 11 lanes vs 2. The remedy is scoping.
   - (b) **`--teams` / `--max-parallel` now exit with `removedFlagMessage`.** main's setup.ts:775/780 accepts them,
     and main's help-pickle.md:31 and pickle-tmux.md:42-55 document them. Any script that passes them stops at
     launch, before any work.
     - **This is a breaking CLI-args change**, which the root CLAUDE.md semver rule classifies as **Major**.
     - The version consequence goes to the operator (decision 3). It is not hidden as a beta increment.
   - (c) The default-on list from step 1.
   - CLAUDE.md versioning lines: "releases are v2.1.X patch tags" and "Next tag: v2.1.1" are stale (origin/main
     CLAUDE.md:296-297). After the merge, main carries `2.2.0-beta.1` from exp; origin/main itself is `2.1.1`. The
     next tag name follows decision 3.
5. **Full gate on the merged tree.**
   - `prds/gate-runner.sh`, 22 legs. Green only if every `LEG_RC` is 0.
   - OS axis: `ci-repro.sh --ref "$(git rev-parse HEAD)"` on the touched test files, or recorded UNRUN.
6. **Push `main`.** Do not run `install.sh`. The deployed runtime stays `1bacc67a` (D-1).
7. **Run the B-MERGE-REL-1 bundle on `main`** with lanes 2 and tickets 1. Record its ledger row against `1bacc67a`.
8. **Deploy (operator decision 2), after the bundle lands.**
   - `bash install.sh` from merged `main` plus Part 1.
   - **Content check:** `unreproducibleNodeModulesGap` in bin/pipeline-runner.js and `replicateLaneNodeModules` in
     services/anatomy-lanes.js. Both MEASURED 0 in the deployed build and ≥ 2 at `d9767fcb`. `runPickleWaves` is
     dropped from the check because the deployed build already has 2 hits.
     - `throwOnEmptyScope` must read 0 (MEASURED 5 deployed today).
   - **Rollback trigger:** the first bundle on the new build produces no `Pipeline finished:` line, an
     `exit_reason: fatal`, or a phase-loop break outside the floor. Then reinstall `1bacc67a` (`install.sh` from a
     worktree at that sha).
9. **Then** the closures and deletions in decision 5. Release only at cadence; the soak is required at release.

**Rule P after the merge:** there is one line, so there is nothing to merge down. If an exp branch is kept, rule P
resumes for it unchanged.

## Part 3 — tier-2 quality (small, subtraction first)

| WS | Item | Change | Surface |
|---|---|---|---|
| B1 | #61 | Delete refine Step 8 when `realpath(<PRD_PATH>)` is the session's own prd.md, and delete the false "preserved at" sentence (pickle-refine-prd.md:806-807). | prompts |
| B2 | #62 | Delete the two `bash install.sh` AC lines from the template (:771, :783). The size criterion becomes "the target's enforced max-lines-per-function, if any". banned-casts-audit.ts:28-66 applies only when the target's eslint config bans those casts. | prompts, citadel |
| B3 | #59, #64 | Two information sentences in the worker lifecycle prompt: "name the behaviour, not the PRD clause" and "follow the target repo's CLAUDE.md test rules". | spawn-morty prompt |
| B4 | #58 | Measure first whether the trailer alone attributes (ticket-completion-evidence.ts:452, :491). If it does, delete the subject-scope requirement (spawn-morty.ts:1125, :1743). Otherwise record only. | spawn-morty, evidence |
| B5 | #60 | Pass this cycle's successful role set into `archiveCycleResults`. Delete `countWrittenAnalyses` (:2807). | refinement |
| B6 | #56 | One `review convergence: not measured` disclosure line in `writeFinalPipelineActivity`. Disclosure only; shares S4 with WS-A8. | S4 |

Rejected as new gates: the #65 scheduler fields, the #58 post-commit key check, the #59 citadel grep, the #64
mutation-record gate, the #66 per-target timeouts, and #57 fence tightening.

## Part 4 — tier-3 speed (composition, not machinery)

No runtime tickets.
- B-LANES needs ≥ 3 serial-arm sessions of comparable size; MEASURED 0. The multi-lane median is 20.35 min, n=6.
- B-PBUILD needs ≥ 3 field runs at width 2; MEASURED 0.
- The levers are file-disjoint, same-surface bundles and scoped runs (scoped single-lane anatomy 1.6–1.9 min vs
  unscoped 135 min).

## Composition and ticket list — B-MERGE-REL-1 (one bundle, runs on merged `main` under deployed `1bacc67a`)

Order: autonomy, then instruments, then honesty, then quality.

| # | Id | Title | Tier | Files |
|---|---|---|---|---|
| 1 | A1b | Lane/unit exceptions become outcomes; settle-all + always reap/remove | medium | src/bin/pipeline-runner.ts; tests/pipeline-runner.test.js |
| 2 | A1 | Phase-boundary catch, probe-write floor; empty post-build scope → `empty_branch_diff` skip; delete `throwOnEmptyScope` | medium | src/bin/pipeline-runner.ts; tests/pipeline-runner-dispatch.test.js, pipeline-runner-phase-fail-continue.test.js (+ comment-only: scope-filters, scope-refresh, pipeline-finalize-honesty) |
| 3 | A12 | No phase halts by default; non-zero non-pickle exit withholds via exit code | small | src/bin/pipeline-runner.ts; tests/pipeline-runner-done-without-commit-evidence-fatal.test.js, pipeline-runner-phase-fail-continue.test.js |
| 4 | A2 | Remove `closer_handoff_terminal` break; withhold via `nonConvergent` | small | src/bin/pipeline-runner.ts; tests/pipeline-runner-phase-no-progress.test.js |
| 5 | A3 | Heartbeat for microverse children (Step 0 may close zero-diff) | medium | src/bin/pipeline-runner.ts (+ heartbeat service if the signal lives there); a pipeline-runner test |
| 6 | A4 | Integrate a non-convergent lane's commits through the pick (**only if decision 4 = yes**) | medium | src/bin/pipeline-runner.ts; tests/pipeline-runner.test.js |
| 7 | A9 | Delete all 9 pane holds | small | .claude/commands/{pickle-pipeline,anatomy-park,szechuan-sauce,pickle-microverse,plumbus,pickle-tmux,pickle-refine-prd,council-of-ricks,portal-gun}.md; README.md if documented |
| 8 | A10 | Refinement `signal_received` activity event with cycle | small | src/bin/spawn-refinement-team.ts; its test |
| 9 | A11 | field-timing.py keeps every session, emits N1/N2 inputs | small | prds/research/tools/field-timing.py, prds/research/tools/fixtures/; prds/MASTER_PLAN.md (ledger rename) |
| 10 | A6 | Converge on what HEAD carries (HEAD vs `pre_iteration_sha`) | medium | src/services/microverse-state.ts, src/bin/microverse-runner.ts; a microverse-state test |
| 11 | A7 | Uncertifiable baseline → `discloseCapUnmeasured` with true cause | small | src/bin/microverse-runner.ts; a microverse test |
| 12 | A8 | Skipped/Failed ticket disclosure line (no withhold) + template line | small | src/bin/pipeline-runner.ts; .claude/commands/pickle-refine-prd.md |
| 13 | A5′ | node_modules discovery via git ignored listing, no depth constant | small | src/services/anatomy-lanes.ts; tests/pipeline-runner.test.js (L2 family) |
| 14–19 | B1–B6 | Part 3 table above | small each | per table |

- **Count.** 19 tickets: 13 in Part 1, of which A4 is conditional and A3 may close zero-diff, plus 6 in Part 3.
  Raise the pickle iteration cap accordingly.
- **Already-fixed rows** declare `zero_diff_intent: already-satisfied` up front.
- **Standing vehicle:** `prds/p1-b-megadrain-forty-open-items-by-root.md`, if composed into it.

## Simplification Review

| WS | Necessary? | Reuses | Subtracted |
|---|---|---|---|
| A1b | yes; makes A1 safe | `cancelLaneRun`, `reapCancelledLanes`, `removeLaneWorktrees`, `LANE_NO_VERDICT` | the reject-skips-reap path |
| A1 | yes | `crash_downgraded`, `setup_error`, `empty_branch_diff`, `DEGRADED_PHASE_SKIP_REASONS` | `throwOnEmptyScope` + 4 literals + a fatal arm; no class list |
| A12 | yes | the pickle floor checks | the default-true arm and a phase-name test |
| A2 | removal | `withholdForFailedAcGate` shape | the handoff break |
| A3 | only if Step 0 finds no bound | the existing heartbeat | the mux-only predicate |
| A4 | conditional | existing pick + integration typecheck | `isLaneSuccess` as an integration gate |
| A9 | removal | `Pipeline finished:` | 9 holds |
| A10 | one event | `signal_received` shape | none (disclosure) |
| A11 | yes | widens an existing tool | the survivorship filter; v1's 6 enumerated columns and hand-marked column |
| A6 | yes | HEAD as the record | the accepted-only read; no new field |
| A7 | yes | `discloseCapUnmeasured` | a literal that lies |
| A8 | one line | final-report helpers | v1's new withhold case |
| A5′ | small | the walk's own membership rule | a depth constant |

## Record-only (no code)

- **F1** — the #53 chain (above).
- **F3** — ignored build output is not reproduced in lane worktrees. Answered by A4 if approved; otherwise disclosed
  (L4) and counted in N2. Revisit trigger: a field `lanes.json` row whose `baseline_check_status` is red on
  typecheck in a run whose pickle phase reported it green.
- **F8** — halt inventory after Part 1. Every remaining break is on the floor:
  - the `start_commit` / crash-floor exit_reason checks;
  - the iteration-cap Branch A;
  - cancel;
  - `--strict-phases`;
  - launch preflight;
  - the state probe.
- **F9** — the non-success reporting paths are unchanged.
- **F10** — the activity log carries test traffic (HYPOTHESIS about the source). That is why N1/N2 use session dirs.
- **v1's hand-classified 65/74 activity census is withdrawn as a baseline.** No tool computes it, and nothing in this
  plan cites it.

## Non-goals

- No new gate leg, verdict, classifier, lint or halt.
- No release or tag.
- No change to `RETAINED_BRANCH_MAX_AGE_DAYS` without decision 5.
- No per-target timeouts.
- No lane or wave default change.
- No code sanitizing public issues.
- No client data.

## Operator decisions (only what belongs to the operator)

1. **Merge into main.** *Recommended: yes.* Merge `exp/b-parallel-build` into `main` (`--no-ff`) before Part 1.
   This accepts the user-visible changes (11 serial lanes unscoped; `--teams`/`--max-parallel` refused; the measured
   default-on list) and waives the unmet B-LANES and B-PBUILD merge rules, with that evidence collected on `main`.
   *Alternative:* build Part 1 on exp and merge after. That keeps two lines and rule P's merge-down step.
2. **Deploy.** *Recommended:* keep `1bacc67a` deployed while the Part 1 bundle runs, then deploy merged `main` plus
   Part 1 in one step, using the content check and the rollback trigger. *Alternative:* deploy at the merge (v1),
   which makes the job-1 bundle the first soak of 52 never-deployed commits.
3. **Version / tag.** *Recommended:* call the flag removal what CLAUDE.md's semver rule calls it, a breaking CLI
   change, so the next pre-release is `3.0.0-beta.1`. Fix CLAUDE.md's stale v2.1.X lines in the merge docs commit.
   Tag only at cadence, with an explicit `--target`. *Alternative:* add a small ticket that makes both flags
   warn-and-continue, which removes the break and the stop at launch, and keep `2.2.0-beta.2`.
4. **Reverse a pinned rule (R-ORSR-6).** *Recommended: yes.* Let a non-convergent lane's commits go through the
   normal pick and integration typecheck (WS-A4). The phase still reports non-convergent. This rescues verified work
   that is otherwise stranded, and it is the list-free answer to lane environment gaps. *Alternative: no.* A4 is
   dropped, and stranded work stays disclosed and counted in N2.
5. **Deletions and closures.** *Recommended, after the deploy in Part 2 step 8:*
   - retire `exp/b-lanes` and `exp/b-parallel-build`;
   - delete the three never-run `__tests__/*.spec.ts` files;
   - close #52/#53/#54/#55/#5 with evidence;
   - edit client identity out of #52/#53;
   - keep the 14-day auto-deletion of kept lane branches only if A4 is approved. If it is not, stop auto-deleting
     branches that hold stranded verified commits.

Requests (not decisions): field rows from the field machine via the widened field-timing.py, numbers only, kept
outside the public repo. Without them N1/N2 say nothing about the monorepo population where #52/#53 happened.
