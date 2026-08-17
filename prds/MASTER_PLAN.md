---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Live ledger.** The babysitter (`babysitter.md`) re-reads this each tick, so it is kept lean
on purpose. Shipped-release detail and closed-finding forensics live in
[`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) + `git log`; the full finding catalog is in
[`BUG-INDEX.md`](BUG-INDEX.md).

---

## ⛳ OPERATOR DIRECTIVES 2026-07-25 (BINDING — read FIRST, supersede on conflict)

Set by the operator after the B-GTRUTH + R-WDTF-TO runs each wedged in the pipeline's own
completion/gate layer. Memory: [[feedback_reliability_first_stop_the_fix_treadmill]].

1. **RELIABILITY FIRST, quality output SECOND.** The bar is: the system COMPLETES hands-off runs. A
   correct-but-halted run is a failure; an imperfect-but-completed run is a success.
2. **A quality GATE that STOPS the system takes quality to ZERO.** No output = no quality. A gate may
   block a **LOCAL** action (don't flip THIS ticket Done, don't ship THIS commit) but MUST NEVER stop the
   pipeline — the run parks the item, flags it for a human, and CONTINUES. Output-with-flags ≫ no-output.
   This makes a stopping gate *anti-quality*, not a reliability/quality trade.
3. **ALWAYS dogfood the FULL pipeline** (`/pickle-pipeline`) — it is the only real test of the system. Do
   NOT bypass it with a lean build→gate→ship. When the pipeline wedges, that is the TEST surfacing the
   halt-brittleness to fix — the answer is to make the pipeline non-stopping (directive 2), never to skip it.
4. **Stop the fix-treadmill.** We keep making the completion ORACLE smarter (zero-diff arm, PhaseIncomplete
   reroute, recomputed-verdict guard, …) and each new case is a new way to STOP. STOP adding oracle cases.
   The next reliability work is ONE subtraction: find every path that halts/stamps-incomplete a pipeline on
   a completion/disposition/quality-gate verdict and make it **continue-and-flag**. Reserve halting for the
   genuine crash floor only (`fatal`, `state_schema_version_ahead`, budget cap). See [[B-NOSTOP-GATES]] below.

## 📦 SHIP STATE (newest first — the release-ready + in-flight ledger)

> ### ▶▶ RESUME HERE — 2026-08-14 (supersedes the 2026-08-12 block below)
>
> **The loop closed on itself. `c916b3da` — the bundle that makes the success verdict stop being blind
> to tests — was itself shipped under a verdict that did not exist.** All three of its worker gates
> reported `__timeout__` and all three were absorbed by `failed_flip_suppressed`, so the tier never
> reached a verdict on any of its tickets. An incomplete consumer migration walked straight through and
> HEAD went red. This is the strongest available argument for the worker-lock bundle: **until one
> worker runs at a time, no bundle's gate result means anything.**
>
> **✅ `c916b3da` SHIPPED — session `2026-08-13-1a29993f`, 4/4 Done, `EPIC_COMPLETED/all-tickets-done`
> 02:36:47Z, iteration 6, `exit_reason: completed`.** Commits: `2cbc11b0` unify the test-dimension
> reader for both Done-flip authorities · `5b43f4f1` withhold the success verdict on Done-over-red-tests
> and park `done_without_commit_evidence` · `40e07bde` route the advisory worker-gate residual to the
> jsonl sink · `c4f71b8d`+`4d865402` corpus census script. `5b43f4f1` also absorbed queue item 2
> (`done_without_commit_evidence`) as a side effect of touching the same seam.
>
> **🚨 ROOT CAUSE FOUND — concurrent workers per session. This is the gate-timeout root, and it
> subsumes four previously-separate incident classes.** A worker whose Bash call is cut at the manager's
> 600s ceiling **keeps running**; the manager follows its documented instruction and advances; two
> `spawn-morty` processes are now live in one session, each running a full `test:fast` at c=8. Nothing
> prevents it — `grep "withRetryLock\|acquireLockFile\|withLock\|lockfile" extension/src/bin/spawn-morty.ts`
> returns **0**. One-worker-per-session is prose in `_pickle-manager-prompt.md:155`, not an invariant.
> Timeline from `1a29993f`: `2e77f26e` spawned 01:16:04, `f8559470` spawned 01:26:39 (the 600s ceiling,
> to the second), `2e77f26e`'s gate failed 01:52:45 — 26 minutes AFTER its successor started. Subsumes:
> worker-gate timeouts, suppression budget spent on arithmetic, contention silent death, and the
> dual-spawn brittleness the B-WSPU collapse could not reach (it lives in process LIFETIME, not the
> spawn path). PRD `9a7cbdaf`: session-scoped lock reusing `acquireLockFile`/`withStealRight`/
> `isDeadPidPayload`, contention NON-FATAL (never kill the incumbent — it may hold uncommitted verified
> work), proof-of-death-only reclaim (a worker legitimately holds up to `worker_timeout_seconds: 3600`).
>
> **📏 Four measurements, and they rule out the two obvious explanations.**
>
> | condition | wall clock | verdict |
> |---|---|---|
> | quiet box, clean env, `d0099e58` | 712 s | fail 0, cancelled 0 |
> | quiet box, worker-contaminated env | 747 s | fail 8 |
> | quiet box, clean env, `9a7cbdaf` | 760 s | **fail 4** |
> | under the worker gate, overlapping workers | > 1800 s | `__timeout__` |
>
> Rows 1-2 are within 5%, so **env contamination is NOT the slowdown**. Raising the cap 600000 →
> 1800000 ms did NOT help — a bigger bucket under a tap that scales with worker count. The override
> DID take effect (`timed out after 1800000ms` on all three tickets); it simply cannot win.
>
> **🚨 HEAD IS RED — 4 clean-env failures, and they are `40e07bde`'s stranded consumers.** `119acf6a`
> moved the advisory residual to the jsonl sink and shipped `advisory-residual-sink.test.js` proving the
> new behavior, but never updated the four pre-existing tests reading the OLD sink
> (`setup.test.js:1932`, `worker-gate-not-run-invariant.test.js:94`). Repro: `an advisory Done flip must
> leave a residual — actual: undefined, expected: true`. **The re-route is CORRECT** — `/pickle-metrics`
> reads `getDataRoot()/activity/*.jsonl` and the W5c scanner ignores the state.json sink, already pinned
> by the `pipeline-runner.ts` `gate_skipped` trap door. So this is consumer migration, NOT a revert.
> PRD `e179db37`, tests-only, with a mutation AC (assertions must go RED when the producer's emission is
> removed) so a migration cannot become a rubber stamp.
>
> **✅ HEAD IS GREEN AGAIN — `390049c8`, recovered by operator measurement out of a FAILED run.** Session
> `2026-08-14-d9f472a4` terminated `recovery_exhausted` after 101m/3 iterations with HEAD unmoved, yet the
> worker's diff on disk was complete and correct: four files, all `extension/tests/`, one shared helper
> `extension/tests/__helpers__/activity-sink.js` with 3 callers, all 5 residual reads migrated,
> `readActivity` deleted, the `state.activity`-emptiness assertion kept. Its gate reported `__timeout__`
> at 1800000 ms — the concurrency symptom, not a test failure. **Operator-run clean-tier measurement of
> the same tree: 7616 tests, 504 suites, fail 0, cancelled 0, skipped 2, todo 1, 736520 ms.** Count and
> wall clock both on baseline, no shrink. That is the `c916b3da` lesson paying for itself: the bundle's
> own verdict said red, the tree was green, and only the operator measurement could tell them apart.
>
> **🐞 NEW P1 from that run's terminal path — `BUG-2026-08-14-salvage-reset-desync-empty-roster-terminal.md`.**
> `mux-runner.log` logged `[salvage] 4f831a16: failing -> archived diff + reset Todo`, but the ticket's
> frontmatter still reads `status: "In Progress"` — the announced write never landed. Iteration 3 then
> declared `empty roster (all-Failed, no runnable ticket)` while holding one runnable ticket with 28 of 30
> per-ticket iterations unspent, and terminated. Two independent root causes: the salvage reset is
> announced rather than confirmed, and the roster-emptiness predicate mis-classifies `In Progress`. A
> local gate refusal escalated into a terminal disposition — the exact shape the no-stop-gates rule
> forbids. Queue this AFTER the worker lock; it is terminal-reducing only (AC-3 forbids a new
> `exit_reason`).
>
> **Sequence: green tier → worker lock (`9a7cbdaf`) onto ground that is actually solid.** The ordering
> matters more than usual: the worker-lock bundle is what makes every SUBSEQUENT bundle's gate mean
> something.
>
> **✅ B-CWPS SHIPPED AND OPERATOR-VERIFIED — session `2026-08-14-0807d986`, 3/3 Done,
> `EPIC_COMPLETED/all-tickets-done` 03:20:40Z, `exit_reason: completed`, 12 iterations / 330m17s.**
> Commits: `e4df9cce` serialize per-session worker spawn via the state-manager lock · `113f8405` teach the
> manager prompt the contention sentinel · `f0fb36cf` overlap predicate + gate-completion verifier ·
> `1554ed3d` register `worker_spawn_lock_contended` in the event fixture · `c56e1cfb` the two findings
> below. **Operator-run clean-tier measurement at `c56e1cfb`: 7635 tests, 504 suites, fail 0, cancelled 0,
> skipped 2, todo 1, 734742 ms, EXIT=0.** The count GREW 7616 → 7635, so nothing was traded away for the
> pass. This is a hands-off run that both completed and verified — the ratchet in the intended order.
>
> Per-ticket honesty caveats, recorded so the green is not read as broader than it is: `13467b6b` flipped
> Done with `tier_phase_skipped: ["test:fast"]` (small tier, lint gate only), and `063b991c` needed 4
> spawns — one `worker_produced_nothing` (silent-death shape, `spawn_pid: null`, `session_log_bytes: 0`)
> and two `[salvage] failing -> archived diff + reset Todo` cycles before converging. The salvage reset
> fired twice WITHOUT wedging the run, which bounds the
> `BUG-2026-08-14-salvage-reset-desync-empty-roster-terminal.md` P1: it only bites when the roster is
> left with nothing else runnable.
>
> Also observed and dismissed: `cross_ticket_regression_detected` named a failing test
> `> pickle-rick-scripts@2.1.0-beta.9 pretest:fast` — an npm lifecycle BANNER line, not a test — and
> attributed it to already-shipped ticket `70a67ccb`. Both `pretest:fast` audits (`audit-test-tiers.sh`,
> `audit-test-isolation.sh`) exit 0 on demand. The red was real but transient (mid-flight worker files);
> the failure PARSER surfaces a banner as a test name and the attribution pins it on the wrong ticket.
>
> **✅ QUEUE A/B/C ALL SHIPPED AND HEAD IS GREEN — measured `5dba30c5`: 7647 tests, 504 suites, pass 7644,
> fail 0, cancelled 0, skipped 2, todo 1, 835042 ms, EXIT=0.** Count grew 7616 → 7635 → 7647 across the
> three bundles, so nothing was traded away for a pass. Sequence: `390049c8` (advisory-residual sink) →
> `e4df9cce`+2 (worker lock, DEPLOYED) → `684ddbc9`+9 (gate-env scrub, 8/8) → `a5edb12f` (trap-door trim
> that un-reddened C's own docs commit). Four bundles, four `EPIC_COMPLETED`, zero hand-built fixes.
>
> **The loop's real yield was five findings, not three bundles.** `R-NOPOSTTIER` (P1) is the one that
> matters: a bundle can pass every per-ticket gate and hand back a red tree, and it did. Also filed:
> `R-GBANNER` (banner parsed as a test name, 2 sessions), `R-SJLAGMT` (float-`mtimeMs` flake),
> `R-TIERWEDGE` (0-CPU tier wedge under a plain operator run), and the `R-WGTORPH` escalation (the filed
> reap did not hold; the orphans ignore SIGTERM). Until `R-NOPOSTTIER` is built, **every bundle's green
> needs an operator-run tier measurement to be believed** — that is not a posture, it is now a measured
> fact with a commit behind it.
>
> **✅ R-NOPOSTTIER SHIPPED + ITS P0 REGRESSION FIXED + BOTH DEPLOYED — 2026-08-16.** Two sessions:
> `2026-08-15-29b48a40` (10/10 Done, `EPIC_COMPLETED`, `exit_reason: completed`, 13 iterations / 525m, 25
> commits) built the fix at BOTH promise-synthesis seams — `runPostFinalMeasurement`
> (`mux-runner.ts:851`, wired at `:959` and `:2432`), the classifier + state field, and `4514ebb0`'s
> withholding change shipped alongside `nostop-gates-phase-loop.test.js` (+86) and
> `pipeline-finalize-honesty.test.js` (+171) so AC-3 is pinned by the same commit that created the risk.
> Then `2026-08-15-6ecbeaad` (4/4 Done, 11 iterations / 176m) fixed the P0 that bundle introduced.
> **Operator-run clean-env tier at `3216370c`: 7707 tests, 507 suites, pass 7704, fail 0, cancelled 0,
> 982717 ms, EXIT=0** — count grew 7647 → 7707, and the run walked straight through the old wedge point.
> `bash install.sh` deployed; `runPostFinalMeasurement` ×7 and `POST_FINAL_DEGRADED_MARKER` ×2 confirmed
> present in the deployed runtime. **The NEXT bundle is the first whose completion promise will carry a
> measured verdict — that observation is still owed.**
>
> **🔬 Mutation-verified, and the first probe was misleading.** Removing `counters.nonConvergent > 0` from
> `finalizePipeline`'s `unsuccessful` term, recompiling, and CONFIRMING the mutation live in
> `extension/bin/pipeline-runner.js:3474` leaves `post-final-verdict-oracle.test.js` GREEN — that file
> targets the mux-runner promise seam, not `finalizePipeline`. `nostop-gates-phase-loop.test.js` is the
> one with teeth: it goes red on *"a degraded post-final verdict withholds the verdict, not the run"* plus
> the 6/6-Done-with-red-verdict case. Lesson for the next mutation check: **an oracle named for the bug is
> not necessarily the oracle covering the line** — mutate, then find which file screams.
>
> **❌ TWO OPERATOR ERRORS CORRECTED, recorded because the ledger is worth more than the ego.** (1) The
> nested-tier wedge attribution was **FALSE**: I claimed the wedge came from a real tier firing at the
> completion seam inside `mux-runner.test.js`; the bundle refuted it and source confirms the refutation —
> `runBetweenTicketFastGate` opened with `if (!fs.existsSync(extensionDir)) return null;` at `41575226`,
> BEFORE the bundle, and that test file's working dirs are bare `mkdtempSync` with no `extension/` child.
> (2) The bundle then retracted AC-1's `7647` floor in favour of `5899` — **also wrong**, and re-retracted
> in `3216370c`: `5899` was the `✔`-line count from a throwaway operator scrape, not a tier count. A floor
> comes from the runner's own summary block, never from a number quoted in prose.
>
> **⚠️ R-TIERWEDGE IS NOT CLOSED.** It was twice-reproduced at exactly 6126 lines and has now not recurred
> across two full runs. One clean run cannot distinguish *fixed* from *did not recur*, and the bundle said
> so itself rather than claiming the kill. Treat it as live until several consecutive tiers complete.
>
> **📦 RELEASE GATE MEASURED 2026-08-16 (reduced — expensive tier deliberately skipped).** Operator ran it
> in STAGES so no failure could hide behind one exit code. `tsc --noEmit` OK · `eslint --max-warnings=-1`
> OK · `tsc` OK · 9 audits OK (after `53d4ca74`) · `test:fast` **7723 tests / 507 suites / fail 0 /
> cancelled 0 / 923019 ms** · `test:fast:budget` **OK failures=1 budget=2 runs 5/5**.
>
> **The gate blocker was self-inflicted and instructive.** `audit-subprocess-heavy-tests` — taught to
> catch missing-timeout spawns BY the R-WGTORPH bundle — failed on three callsites from that same bundle:
> two in `orphan-worker-reaper-tmp-prefix-drain.test.js`, one in `spawn-morty-worker-gate.test.js`. All
> three are `spawn(..., { detached: true, stdio: 'ignore' })` orphan FIXTURES whose whole purpose is to
> outlive the parent; a timeout would defeat the test. Registered in the audit's own missing-timeout
> baseline (`53d4ca74`, 4 insertions, baseline file only).
> **`pretest:integration` runs that audit, so `test:integration` had been exiting 1 without executing a
> single test** — `pretest:fast` runs a different pair, which is why the fast tier read green throughout.
>
> **Flake cluster characterised, not mysterious.** `test:fast:budget` ran the tier 5× and the one failing
> run named the SAME trio seen in an earlier red tier: `node-modules-reuse`, `withLock: different-key
> calls run in parallel` (a literal wall-clock budget: `< 110ms`, got 139/183ms), and `AC-3/AC-9/AC-10: a
> real spawn contends on a pre-held lock`. ~1-in-5, all on the lock/spawn seam, all timing-sensitive. The
> repetition budget absorbs it by design — this is what that mechanism is for.
>
> **Operator method correction (cost a false alarm, worth recording).** "Parent CPU flat + log not
> growing = hung" is only valid for a command that STREAMS output. `test:fast` streams `✔` lines, so an
> 8-minute frozen log there is a genuine hang (4 occurrences, all at the `mux-runner` suite boundary —
> `BUG-2026-08-16-tier-hangs-at-mux-runner-suite.md`). `test:fast:budget` buffers everything until the
> end, so silence there means nothing; its true signal is descendant churn. A stall detector was nearly
> used to kill a healthy 13-minute run.
>
> **▶ NEXT: queue C, the env-contamination PRD — and R-GENVL WIDENS it.** The original scope was the
> trailer-hook family (`PICKLE_TICKET_ID`, `GIT_CONFIG_*`, 8 tests). R-GENVL adds a SECOND leaked
> variable in the same seam: `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS`, read by `resolveWorkerTestFastTimeoutMs`
> at TEST time, 8 failures present vs 1 with `env -u`. One PRD must cover both variables, or fixing one
> leaves the manager still reading a false red.
>
> **Separate ticket, do NOT bundle:** the worker gate inherits the worker's env (`runCommand`,
> `spawn-morty.ts:1315`, spawns with no `env` option), including the `core.hooksPath` trailer stamp and
> `PICKLE_TICKET_ID`. Under it, 8 tests fail that are green clean — all read `GIT_CONFIG_*` from the
> ambient env and `backendEnvOverrides` composes `n+1` off the inherited count. Real, but it produces
> FAILURES not timeouts, so it is not this root cause.
>
> **🗑️ RETIRED — the fast-tier sharding PRD.** Its premise (712s vs a 600s cap is arithmetic) was a
> symptom of the concurrency root. Marked SUPERSEDED in place; the measured profile is still good data,
> the thesis is not. Recorded there: on a single box, sharding IS a concurrency increase (N shards × c=8
> = 8N processes), and a heavy+light split running concurrently would make overlapping workers strictly
> worse.
>
> ### ▶▶ RESUME HERE — 2026-08-12 (supersedes the 2026-07-27 block below)
>
> **Reliability-only session, operator-directed.** Four read-only audits ran against the corpus + HEAD.
> The headline: **two of the three things we "knew" were wrong**, and the measurement that made this look
> catastrophic is itself broken.
>
> **The operator's claim is MEASURED AND TRUE.** Mux completion by week: `2026-06-01` **72%** → every week
> since `2026-06-15` **≤20%** (n=116 runs, reconstructed from `~/.local/share/pickle-rick/activity/*.jsonl`;
> the `state.json` corpus was pruned and only **8** session dirs survive, all ≥ 2026-08-06). 8.5 weeks =
> "over two months". Runs also got LONGER while completing LESS: median 1.1h → 5.4h → 17.8h.
>
> **🚨 NEW P1 — the success verdict is BLIND to tests. 28/28 confirmed.** Every ticket in the corpus with
> `worker_gate_tests_verdict: red` also carries `worker_gate_verdict: green` — zero counterexamples.
> `computeWorkerGateVerdict` (`extension/src/bin/spawn-morty.ts:1719-1746`) takes six inputs and none is a
> test result; it returns green on `lintVerified || tscOk`. `guardCompletionCommitBeforeDone`
> (`extension/src/bin/mux-runner.ts:4995`) reads only that aggregate. The honest field IS authoritative — at
> exactly one site (`extension/src/bin/setup.ts:1227`, documented `extension/src/bin/CLAUDE.md:102` guard 3).
> **PRD `c916b3da`.** The naive fix (refuse Done on red) is WRONG — R-WGFR dropped `test:fast` because a c=8
> flake false-redded a bundle. Done keeps flipping; the RUN withholds success. Sequenced AFTER the fast-tier
> cap bundle, which is what makes the signal trustworthy.
>
> **🚨 NEW P1 — `wasted_iter` measures the DESIGN as failure, so improvement is invisible.** The 92%
> "wasted" figure conflates three things: (a) the DESIGNED re-spawn-resume turn — the manager prompt
> documents the 600s Bash ceiling and states re-spawn resumes from on-disk artifacts (`600000` appears
> NOWHERE in `extension/src`; it is the agent harness's cap, while `pickle_settings.json:33` budgets workers
> **2400s**), (b) 25% legitimately-clean passes with nothing to fix, (c) real defects. **Fix the metric
> before shipping anything else — an unmeasurable baseline is how the last two months happened.**
>
> **▶ ORDERING PIN LANDED (in-tree, uncommitted) — the P0 that would have silently NOT fixed.**
> `makeRepo` now captures `startCommit` BEFORE authoring the follow-up commit, and carries the assertion
> refinement demanded (`assert.notEqual(startCommit, head)` with the flag set) plus a comment naming
> `empty_branch_diff` for the next fixture author. Had the contract only constrained output *shape* — as
> my first draft did — a worker could have authored the commit first, rev-parsed after, and shipped a
> fixture that looks fixed while the diff stays empty and the test stays red.
>
> **`c916b3da` is launch-ready and BLOCKED only on the green-tree precondition.** Census re-measured at
> **32/32** (`tests=red` + `gate=green`, zero counterexamples, four bundles later). Stale-premise check run
> against HEAD *and* the deployed tree per `prds/CLAUDE.md`: the predicate is live in both, and deployed
> `mux-runner.js` has **zero** occurrences of `worker_gate_tests_verdict`. Its prerequisite (fast-tier caps)
> is satisfied — validated under load. Launch the moment the tier reads 0 fail / 0 cancelled.
>
> **✅ BUNDLE COMPLETE 2026-08-13 17:32 — `2026-08-13-e4ab0833`, 4/4 Done, `EPIC_COMPLETED/all-tickets-done`,
> `exit_reason: null`, iteration 5.** Every ticket carries a real commit: `c5b81af7`→`14d0f54e`,
> `4f860deb`→`980d125f`, `b68b273b`→`398d0e86`, `3dc65ea1`→`d0099e58`. No wedge, no salvage, clean tree.
>
> **✅ GREEN-TREE PRECONDITION MET 2026-08-14 — 7600 tests, 7597 pass, fail 0, CANCELLED 0, 2 skipped,
> 1 todo, `EXIT=0`.** Full tier, no `--grep`, `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000`, `env -u
> PICKLE_TICKET_ID -u GIT_CONFIG_*`. This is the launch ground for `c916b3da`.
>
> **🚨 THE 600s WORKER GATE CAP IS ARITHMETIC, NOT FLAKE — the tier takes 712s.** All three
> `worker_gate_failed __timeout__` events in `e4ab0833` (`c5b81af7` ×2, `4f860deb` ×1) were the gate cap
> sitting *below* the suite's real runtime; `failed_flip_suppressed` absorbed them and the run continued
> (B-NOSTOP-GATES working), but ~36 min was burned and `c5b81af7` consumed its full 2/2 suppression budget.
> The gate could never have passed. `c916b3da` launches with `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS=1800000`
> (env-only per B-SSAT — do NOT re-add the settings key).
>
> **▶ NEXT: SHARD THE FAST TIER (wall-clock only).** Profile at c=8 on a 24-core box: 712s wall, cost is a
> heavy tail of subprocess suites — `W4a choke-point matrix` 128.7s, `relational oracle` 104.8s,
> `command_template forward slash` 96.3s, `node-modules-reuse` 94.0s, `computeOneHop` 82.3s. **128.7s is the
> hard floor** — no shard goes below the slowest unit. Raising `--test-concurrency` is the WRONG lever: c=8
> already yields timeout-shaped flakes and c=4 is what reads authoritative, so more concurrency buys
> wall-clock by degrading the signal. Reuse, do not add: `test-runner.js` already partitions via
> `--manifest <path> --manifest-mode include|exclude` (how `test:integration` splits parallel from serial),
> so N shards = N generated manifests + N processes, not a new runner subsystem. Scope is wall clock only —
> the worker gate keeps running the FULL tier, no scope-selected shard, no missed-breakage risk.
>
> **▶ FIX BUNDLE LAUNCHED 10:13 — session `2026-08-13-e4ab0833`, tmux `pickle-e4ab0833`, 4 tickets.**
> PRD `730effe1`. `c5b81af7` restore reachability in the 2 fixtures · `4f860deb` survey all 45
> `start_commit` fixtures · `b68b273b` test-quality harden · `3dc65ea1` cross-ref. Two hardening tickets
> not four — the bundle writes only test fixtures and one report, so code-quality and data-flow have no
> surface; stated rather than silently dropped.
>
> **Authoritative tier verdict before launch: 7598 tests, 7593 pass, 2 fail, 0 CANCELLED.** The two known
> regressions are the only red in the entire tier. An earlier run reported `fail 0 / cancelled 304` — a
> runner timeout aborting mid-run, which reads like green at a glance. `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000`
> is now required by AC, and "0 cancelled" is part of the pass condition.
>
> **Refinement found 5 P0s; the worst would have let the fix silently NOT fix.** The `makeRepo` contract
> said outputs were "unchanged in shape" — but shape does not constrain ORDERING, and the ordering IS the
> fix: the sibling captures `startCommit` at `:54` and authors the follow-up commit at `:55-59`, in that
> order. Author first and rev-parse after and `start_commit == HEAD` again — fixture looks fixed, diff
> still empty, test still red. Now pinned by an asserted invariant.
>
> **Prior session's `exit_reason` was `done_without_commit_evidence`** — the guard DID detect that
> `514bd4a7`'s Done was unsupported. It halted the run and left the ticket Done anyway. Detection works;
> the disposition and the flag are both wrong. That is one of the 15 accretion halts observed FIRING in
> the field, and a sharper argument for `c916b3da` than source reading alone: the information needed to
> withhold the success verdict was already computed, and sent to the wrong wire.
>
> **🔬 ROOT-CAUSED 08:15 — the 2 red tests are UNREACHED FIXTURES, not wrong assertions. Fix PRD `dd72c588`.**
> `makeRepo()` in `extension/tests/oneabort-termination-invariant.test.js` returns `startCommit` = HEAD
> right after its seed commit, so `start_commit..HEAD` is empty, the new skip correctly fires, the phase
> never runs, and the assertion never executes. That fixture's own comment shows its author had already
> defended against the PREVIOUS skip (*"seed one so the microverse phases find a real subsystem instead of
> skipping for empty scope"*) — `empty_branch_diff` is a SECOND skip that postdates it.
>
> **The fix idiom already exists in the repo**: `extension/tests/pipeline-runner-phase-fail-continue.test.js:40`
> is `makeRepo({ createFollowupCommit = false })`, with a test at `:190` named *"shouldHaltAfterPhase pickle
> continue when commits exist after start_commit"*. The failing case just does not pass it. So the fix is
> restoring reachability via an established idiom, NOT relaxing a guard — and `AC-OA-1c` pins *"continuing
> is NOT claiming success"*, so weakening it to go green would delete the guard against the very fake-green
> this project is eliminating.
>
> **🚨 FAKE-GREEN IS LIVE IN THIS BUNDLE — 5 of 6 Done tickets are `gate=green tests=red`** (`0aff6be2`,
> `7addedbf`, `129c61c4`, `2ed9a852`, `6625e3ed`), and `514bd4a7` is Done with **NO gate verdict at all**,
> stamped with `880f6baa` — the MANAGER's preservation commit — over the regression it introduced. The
> 28/28 census is now 33. **`c916b3da` must be re-sequenced AHEAD of the remaining queue**: this bundle is
> its proof case, not a hypothesis.
>
> **⚠ CORRECTION 06:40 — the `514bd4a7` Failed flag was CORRECT, and the tree is RED because of my**
> **preservation commit.** Bisected in an isolated worktree, identical `--grep` both sides:
> `08a14a55~1` = **648 pass / 0 fail**; HEAD = **647 pass / 2 fail**. The empty-diff work regresses
> `AC-OA-1c: a degraded phase never claims success` (sibling: *every phase degraded ⇒ non-zero exit,
> failed status, and NO closer release plan*) and `anatomy-park judge_timeout runs finalize-gate instead
> of halting pipeline`. Both concern phase DISPOSITION — a phase skipping for `empty_branch_diff` is
> apparently counted as a non-degraded outcome, so a run that should withhold the closer release plan no
> longer does. **That is the same degraded-vs-success distinction the parent PRD exists to protect.**
>
> Preserving the work was still right — it was uncommitted and one restore from destruction, and it is
> 90%% correct with valuable notes. But **Done must not be claimed and the tree is not green.** Bisect
> evidence written to the ticket's `handoff_notes.md` so the worker sees it on re-spawn, with an explicit
> instruction NOT to fix it by relaxing either test and NOT to re-simplify the `start_commit`-only base.
>
> **The lesson generalises:** the worker's `ALL_PASS` was against its own acceptance criteria, which do
> pass. The full tier caught what those criteria structurally cannot see — and the worker's own notes had
> already recorded that exact lesson from an earlier iteration (*"found by the full fast tier, not by the
> acceptance tests"*). A per-ticket conformance verdict is not a tree verdict.
>
> **🚨 FALSE FAILED RECOVERED 2026-08-13 06:12 — `514bd4a7`, 391 lines of completed work were sitting**
> **UNCOMMITTED under a `Failed` flag.** The worker's own `conformance_2026-08-13.md` reads
> `## 6. Verdict — ALL_PASS` and its `handoff_notes.md` records `Failed: none`; its stated next step was
> the full fast tier (backgrounded as `bn660zna1`) then commit. The ticket was flipped Failed while it
> waited on that backgrounded run — the documented worker-idles-on-its-own-bg-run class — leaving the
> work one `git restore` from destruction (R-WUWC).
>
> Manager preserved it: `08a14a55` (6 files) + `880f6baa` (the untracked AC-B3 test the path-scoped add
> missed). **Done was NOT claimed** — the full-tier verdict was still pending and is running now.
>
> **The work itself is good, and its own notes carry a warning worth keeping.** Base resolution went
> through three iterations, recorded in `TASK_NOTES.md` as *"do NOT re-simplify this back"*: branch refs
> alone reddened the citadel smoke (fixture repo has all history on `main`, so `merge-base(main, HEAD)`
> IS HEAD and a session with a real diff read empty); `start_commit` with branch fallback reddened 17
> fast cases; FINAL is `start_commit` and only `start_commit`, with undeterminable → RUN. Mutation-verified:
> forcing `isBranchDiffEmpty` to null reddens AC-B1 and AC-B3 and nothing else.
>
> **▶ BUNDLE PROGRESS 2026-08-13 04:11 — 2/8 Done, both metric predicates landed and VERIFIED in source.**
> `microverse-runner.ts:3404` is now `action === 'revert' || (action !== 'worker' && postIterSha === preIterSha)`
> — the one-token fix exactly as specified, no liveness probe. `mux-runner.ts:2814` returns
> `{ wasted: false, reason: 'worker_handoff' }` against a closed vocabulary with ONE definition site
> (`extension/src/types/index.ts:948`). **`AC-A7`'s split-brain risk is closed**:
> `buildEfficiencySection` (`extension/src/bin/microverse-runner.ts:2931`) now calls the shared
> `classifyMuxIteration`, so the printed percentage and the replay cannot diverge.
>
> Simplify-phase check: `8c500806` "drop the unread reason field" was inspected — it removed
> `CorpusEvent.reason` from the REPLAY's local type (never read) and added a comment explaining why the
> replay ignores it. The emitted reason from `7addedbf` is untouched, so `AC-A4` survives. Recorded
> because a simplify pass deleting a deliverable is a real class and this one looked like it at first read.
>
> **▶ NEXT BUNDLE LAUNCHED 2026-08-13 — session `2026-08-13-71ecebb6`, 8 tickets, tmux `pickle-71ecebb6`.**
> PRD `1f3935c2` `prds/BUG-2026-08-12-iteration-accounting-and-empty-diff-spin.md`. Drain items #1 and #2.
> `0aff6be2` microverse handoff label · `7addedbf` mux disposition + closed reason vocabulary ·
> `129c61c4` corpus recount + efficiency-report reconciliation · `514bd4a7` empty-diff phase exit ·
> 4 hardening.
>
> **Refinement found FIVE P0s in the PRD, all verified in source before adoption.** Two would have caused
> real damage: (a) `AC-B4` was satisfiable by doing NOTHING — `PhaseSkipReason`'s docstring
> (`extension/src/bin/pipeline-runner.ts:127-129`) already claims `empty_scope` covers *"the scope filter /
> branch diff"*, so reusing it passes the letter and fails the purpose; the AC now mandates a distinct
> value AND co-scopes the docstring + `extension/src/types/CLAUDE.md:22` edits. (b) `AC-A1` prescribed ONE
> mechanism for two runners, but microverse already emits `action: 'worker'` for exactly the handoff
> iteration (`extension/src/bin/microverse-runner.ts:4224`) — a one-token fix — while mux has no such
> label. The old wording would have forced a liveness probe onto the runner that needs none.
>
> **⚠ The prior bundle's `exit_reason` is `recovery_exhausted` despite delivering 7 Done + a green gate.**
> A failure-shaped terminal state over a successful bundle — a live instance of exactly the accounting
> dishonesty this bundle fixes, and a reminder that the 10%% completion figure counts runs like this one
> as failures.
>
> **🟡 GATE RESULT 2026-08-13 — 14/15 steps GREEN, one PRE-EXISTING red. `GATE_EXIT=1`.**
> `<scratchpad>/relgate2.sh`, log `/tmp/relgate2.log`, per-step wall-clock recorded.
> **`test:fast:budget` rc=0 in 3739s — the gate ITSELF confirms the fast-tier cap fix**, independent of
> `e7c9ada3`'s own measurement. tsc / eslint / tsc-build / all 9 audits / test:expensive all rc=0.
>
> Sole failure: **`INV-CODEX-RECOVERY-ADVANCED`** (`extension/tests/integration/codex-authority-recovery.test.js`),
> 610 pass / 1 fail. **NOT a regression from this bundle** — none of the bundle's 17 commits touch that
> file (`git log --since` on it = 0); last touched by `4317939c` (R-CHTS-CODEX) and `2028aeb0`. This is the
> same undiagnosed red carried across three prior bundles. It belongs in the beta.10 notes as a named
> residual, NOT shipped quietly.
>
> **✅ SERIAL TIER MEASURED SEPARATELY 2026-08-13: 602 tests, 602 pass, 0 fail.** So the FULL gate
> picture is **exactly one failing test** across every tier — `INV-CODEX-RECOVERY-ADVANCED`, pre-existing
> and untouched by this bundle. Tree is green but for that one named red.
>
> Original caveat, kept because the reasoning matters:
>
> **⚠ It failed in the PARALLEL sub-tier, so `test:integration:serial` NEVER RAN** (`test:integration` is
> `parallel && serial`). The serial tier is being measured separately; until it reports, the integration
> tier is only PARTLY known. Do not read 14/15 as "one known failure" until that lands.
>
> **✅ BUNDLE COMPLETE 2026-08-12 — 7 Done + 1 Parked, 17 commits, tree clean.** Fast-tier cap fix
> validated under load (see below). PRD for the next chunk written: `85a8df61`
> `prds/BUG-2026-08-12-iteration-accounting-and-empty-diff-spin.md` (WS-A metric honesty, WS-B empty-diff
> phase exit). Full release gate running to verify — 2 of the 7 Done tickets carry `tests=red`, so the
> Done flags do NOT prove their tests (the 28/28 class below).
>
> **⚠ CORRECTED 2026-08-12 22:55 — the empty-scope claim below was WRONG in an important way.** The
> empty-scope skip DOES exist and is well-built (R-PSSS Finding #49): `shouldSkipSzechuanForEmptyScope`
> (`extension/src/bin/pipeline-runner.ts:2001-2016`) emits the WARN + activity event + `skipReason`. The
> real gap is one uncovered case: it returns false for an UNSCOPED run **by design** (docstring + the
> invariant at `extension/src/bin/CLAUDE.md:85`: *"An UNSCOPED szechuan run … MUST still run"*), and an
> empty branch diff produces exactly an unscoped run. So the fix is ONE new condition in an existing
> predicate — empty scope BECAUSE the diff is empty skips; empty scope with a real diff still runs
> unscoped — NOT a new empty-scope exit. Do not build a second mechanism.
>
> **🚨 NEW P2 — empty-scope spin: a run with nothing to do can only die by EXTERNAL KILL.** Session
> `2026-08-07-35088221` spun 9 consecutive ~15s turns on an empty diff (`same wall as 21 prior iterations`,
> HEAD == tip of main, worker correctly emitting `TASK_COMPLETED` each time; the real blocker was an unset
> `GITHUB_PACKAGES_TOKEN`). No empty-scope phase exit exists, so the run ended `exit_reason: signal:SIGHUP`.
> Cheap, subtractive, converts kill-halts into clean completions.
>
> **P2 — 15 halts on MEASUREMENT verdicts, each with a subtractive fix.** `extension/src/types/index.ts:1358-1360`
> already says so in its own comment; `CRASH_FLOOR_EXIT_REASONS` has exactly 3 members. Worst offenders:
> `extension/src/bin/mux-runner.ts:11215` (`done_without_commit_evidence`), `extension/src/bin/pipeline-runner.ts:4445`
> (per-phase AC gate), `extension/src/bin/pipeline-runner.ts:1826` (`SCOPE_BASE_AHEAD_OF_HEAD` rethrow),
> `extension/src/bin/spawn-refinement-team.ts:2447-2457` (4 exits before any ticket exists).
> Doctrine-correct, but will NOT move completion rate — sequence it accordingly.
>
> **P2 — inert machinery, all VERIFIED.** The `tsc-gate` handler has **zero** registrations (0 hits across
> `.claude/settings.json` + the installer; `config-protection` has 1) — CLAUDE.md's Worker Forbidden Ops
> table promises tsc enforcement that cannot fire. `launch_shell_pid` (`extension/src/types/index.ts:30`):
> 5 writers, **zero readers**. `extension/src/bin/subsystem-watcher.ts`: no spawn site. 5 audit scripts with
> no invoker. 13 distinct no-progress mechanisms, 7 added in a 10-day burst 2026-06-05 → 06-14; collapse to 2.
>
> **❌ FALSIFIED — do not rebuild these.** The 2026-06-17 detached-worker/dual-spawn conversion is NOT the
> regression: `37c8e648` (2026-07-01) already subtracted the detached-spawn class, and July and August both
> sat at **10%**. Removing the suspected cause did not move the number. Also falsified: `signal:SIGHUP` as
> "terminal hangup" — it is the empty-scope spin above.
>
> **✅ THESIS VALIDATED 2026-08-12 21:43 — the fast-tier fix WORKS.** `e7c9ada3` attempt 3, manager-run
> under load (PRE 11.34 / POST 16.42, 1-min avg 9.53-52.60 across the run):
> `flake-budget OK failures=1 budget=2 runs_completed=5 runs_requested=5`, `EXIT=0`. Baseline this
> morning was `FAIL_BUDGET_EXCEEDED failures=3 budget=2 runs_completed=4`. Commit `6d277249`.
> The ticket is `Parked` not Done: `AC-E4` (no concurrent other-repo pipeline) was violated — 3 foreign
> pipeline procs — so the worker refused to claim the win. **The violation runs in the HARDER direction**
> (more contention than specified), so the pass is stronger evidence than the AC required, not weaker.
> AC-E4 as written has no arm for "passed under MORE adversity than specified"; fix the AC, not the run.
>
> **Data-flow audit `38ee7e86` is finding real defects in the delivered work** — `82b69384` CRITICAL
> (budget-derived caps must clear the measured arm), `7ca5c54c` CRITICAL (recovered-timeout band must
> allow subject startup drift), `158c5413` HIGH (flake-budget emitted no attribution on within-budget
> runs — the pass-path blindness, fixed by the pipeline itself).
>
> **In flight:** session `2026-08-12-a6d319ba`, fast-tier cap bundle,
> `prds/BUG-2026-08-12-fast-tier-marginal-spawn-timeouts.md`. 4/8 Done with verified completion commits
> (`fbc15455` → `8874a5c5`; `d3654991` → `56fb4da2` + `90b81564`; `5f110c7d` → `d01657ca`; `94833eaf`).
> `e7c9ada3` (load verification) PARKED itself honestly rather than fake a pass — *"NO RESULT … This is NOT
> a pass"* — and is being retried. **The gate stays RED until `e7c9ada3` produces a clean 5-run pass under
> load ≥10.** Note `d3654991` is Done under exactly the 28/28 fake-green above: its commits are real, its
> green never covered tests.
>
> **Drain order from here:** (1) `wasted_iter` metric honesty → (2) empty-scope exit → (3) finish the
> fast-tier cap bundle + verify → (4) test-verdict fake-green (`c916b3da`) → (5) the 15 halts →
> (6) inert machinery. **Re-measure after (1); nothing before it is provably an improvement.**
>
> **Corpus caveats that bound every number above:** no June/July `state.json`, and **no June/July
> `tmux_iteration_*.log` at all** — the composition question across the decline is unanswerable, not merely
> unanswered. Raw activity counts are dominated by test fixtures (`ticket_auto_skip_no_evidence`: 24,166 raw
> → **36** real); any ranking built on raw counts measured the test suite, not the product.


> ### ▶▶ RESUME HERE — 2026-07-27 end of day
>
> **Nothing is shippable. beta.8 is NOT taggable: the release gate is RED.**
>
> **Where the work stands.** [[R-GTDT-LAND]] ✅ **BUILT + its blocker CLOSED and field-proven** (session
> `2026-07-27-5b2cefc5`, `Pipeline finished: 2/2 phases, 167m`, `exit_reason: completed` — the first fully
> clean run in this line). Deploy landed. The natural A/B on its own commits:
> `b4dbd528` (pre-deploy, prose subject) → `trailer=[]`; `c457e943` (post-deploy, same shape) →
> `trailer=[ce0a4f46]`. The trailer channel works.
>
> **What blocks the tag.** 🚨 [[R-GADEL]] — the full gate at `c457e943` came back
> `GATE_RESULT=RED / FAILED_STAGE=test-integration / 10 failures`, **bisected to B-GITATTR, not to
> R-GTDT-LAND**: `00765390` 5/5 pass → `a7d6d9ec` 3 fail. WS-3 deleted message inference, which was the
> **fallback** for a commit carrying no parsed trailer, and the completion-commit characterization suite —
> *"the primary regression guard for the 8 Done-stamping paths"* — says so. Report:
> `prds/BUG-REPORT-2026-07-27-gitattr-ws3-deletion-left-no-attribution-fallback.md`.
>
> **First thing tomorrow — answer ONE question before touching any test:** *does the trailer channel
> actually cover every case message inference covered?* Enumerate the deleted passes' cases; for each,
> state whether the trailer covers it and how. Then either (a) the tests assert a dead contract and get
> updated **with the reasoning recorded per test**, or (b) a fallback is restored — a partial WS-3 revert,
> stated as such. **Do NOT reflexively rewrite the guard suite**: two failures (`guard must ATTRIBUTE-to-Done
> an untagged worker commit`, and `commit-failed` rather than an attribution miss) look substantive, and
> rewriting guards to match current behaviour is exactly how R-GTDT was born.
>
> **State on disk:** main tree CLEAN at `0087afdc`, no worktrees, no live pipelines, nothing reverted, no
> test rewritten, **50 commits unpushed**. Gate log: `<scratchpad>/gate2.log`.
>
> ### ⚠️ THE DEPLOYED RUNTIME IS THE R-GADEL STATE — read before launching anything
>
> `install.sh` ran **twice** on 2026-07-27 (R-GTDT-LAND ticket 20's manager-owned deploy, then again
> inside the gate at 23:06Z). Deployed is in **full parity** with source HEAD (5/5 hot files MD5-match),
> version string `2.1.0-beta.7`. So the code every pipeline now runs is **untagged, red-gate code**:
>
> | Component | Deployed state |
> |---|---|
> | Trailer fix (R-GTDT-LAND) | ✅ `readParsedTicketTrailers` ×2, `buildTrailerAmendedMessage` ×3 |
> | `prepare-commit-msg` hook | ✅ **live for the first time** — stamps every worker commit |
> | Message inference (the fallback) | ❌ **GONE** — `scanGitLogByRefToken` / `scanGitLogByFileTouch` / `extractRCodeTokens` all `0` |
>
> **Bounded, not alarming:** the hook stamps at commit time, the amend fallback is fixed and field-proven
> (`c457e943` → `trailer=[ce0a4f46]`), and the explicit `completion_commit` path is untouched (it carried
> 8/10 tickets in B-GITATTR). R-GTDT-LAND's rollback condition — absent/empty/multi-valued trailers
> post-deploy — did **not** trigger. What is gone is the *safety net beneath* a working channel.
>
> **Recommendation: leave it deployed.** Rolling back to pre-B-GITATTR would also revert the amend-guard
> fix, reintroducing R-GTDT — a defect we have proven bites. Net worse.
>
> ### 🧪 If you launch a test pipeline on this runtime, it IS the field test for the hook
>
> The hook has never run in a real multi-ticket pipeline. Collect this — it is the evidence R-GADEL's
> fix decision needs, and it is cheap to gather while the run happens anyway:
>
> 1. **Per-commit trailer coverage** — `git log --format='%h %(trailers:key=Pickle-Ticket,valueonly) | %s'`
>    over the run. **Every** worker commit should carry exactly one trailer naming its ticket.
> 2. **Any `trailer=[]` on a worker commit is the finding** — it means the hook did not fire, and with
>    message inference gone there is now no scan fallback. Note the commit shape that produced it.
> 3. **Any multi-valued trailer** → that IS R-GTDT-LAND's rollback trigger; halt and re-deploy the prior
>    tree rather than continuing on an unvalidated commit path.
> 4. **Watch for `done_without_commit_evidence` / `ticket_phantom_done_corrected`** — treat these as
>    signal, not noise, on this runtime.
> 5. **Do NOT run the full release gate from the test chat** while another pipeline is live — contention
>    produces timeout-shaped flakes that read as regressions.
>
> A clean run with 100% trailer coverage is real evidence that the trailer channel covers the common
> paths, and it narrows R-GADEL's open question. A run with gaps names the exact uncovered case — which is
> more valuable still.
>
> **Also open, none blocking the tag:** ~~[[R-JPCM]] (P1, 2nd occurrence)~~ **← CLOSED, see the corrected row below**, [[R-MVPARK]] (P2), [[R-DSPW]] (P2),
> and one UNFILED observation — `b4dbd528` edited outside the 4-path allowlist with **no**
> `worker_edit_outside_scope` event; the allowlist was too narrow (a 2nd test file encoded the same bug),
> but the fence not firing is a separate question I did not file pending a call on ledger volume.

- ✅ **v2.1.0-beta.7 RELEASED 2026-07-26** ([[B-NOSTOP-GATES]] + folded [[R-WDTF-TO]], per Operator Decision 1 — ONE gate/tag ships both) — `gh release` prerelease, tag `v2.1.0-beta.7`, bump `50aa9a14`, gate run at `62657aff`. Session `2026-07-25-aa87fa74`, `release/v2.1-beta`. **Full release gate GREEN, all 17 stages, all tiers measured:** tsc/eslint/tsc-build, all 9 audit scripts, fast tier **5/5 runs at 0 failures** (`flake-budget OK failures=0 budget=2 runs_completed=5` — the c=8 flake did NOT materialize, so no c=4 escalation was needed), integration green, expensive 21/22 pass + 1 vacuous-precondition skip (`quarantine-validation: … # No Done-status entries in quarantine catalog`), and a **real 32.5-min deploy-lifecycle soak** (`1947984ms` — proving it did NOT self-skip; `PICKLE_INSTALL_ROOT` off `$HOME` + `SOAK_SECONDS=1800`). `install.sh` was run BEFORE the integration tier so the tier exercised `62657aff`, not the 5-commit-stale deploy.
  - 🔑 **The thesis validated in the field, unattended — the whole point of the bundle.** Pre-fix, the identical roster stopped at 0/4 phases three times on `not all-tickets-terminal, marking phase incomplete (not advancing)`. Post-deploy it logged **`reporting phase incomplete, advancing`** and ran all four phases in 195m: pickle (7/8 Done, `a3c75c96` parked) → citadel → anatomy-park → szechuan-sauce. Citadel independently corroborated on a SECOND gate: remediation cap exhausted with 13 findings still open → **`continuing pipeline (no halt)`**. WS-4's replay measured 0/4 → 4/4; WS-3's residual fired for real (`ticket_auto_skip_no_evidence`, ticket `a3c75c96`, reason `parked_at_phase_pickle`). Final state is the honest one: `Pipeline finished: 3/4 phases` with `exit_reason: pipeline_phase_incomplete` — reported, not halted.
  - **Cleanup phases earned their keep** (the argument against cutting them short to reach the tag): anatomy-park **converged** 6 iters / 110m, both subsystems 2/2 clean, ZERO stall-sealed, landing 2 HIGH fixes — codegraph staleness line-count off-by-one (`1036f6c5`) and **R-GRLS gate-remediator lock strand** (`5a651929`) — plus 4 trap doors catalogued (`dfb56a78`). szechuan-sauce **converged** 4 iters / 49m with 3 subtractions (`98b5ff74`, `42a25cfd`, `62657aff`). Both phases ran scope-fenced (`scope-refresh: allowed=290`), so the unscoped-judge revert class never opened.
  - **Accounting for the record (carried forward unchanged):** this bundle *introduced* 2 CRITICALs, both in WS-1's own code, and **its own data-flow audit ticket caught and fixed both pre-release** (`0d4d0041`, `b23b6759`). Everything else this run surfaced is a **pre-existing defect it exposed**, not one it created.
  - **Residuals to carry:** (1) **deployed version string lags** — the deployed runtime carries the beta.7 CODE (`install.sh` ran at `62657aff` during the gate) but its `package.json` still reads `2.1.0-beta.6`; re-run `install.sh` to sync the string. (2) 🆕 **the Release workflow has never published a tarball asset on the v2.1 line** — beta.4/5/6/7 runs all fail at the `Install and compile` step on Linux (the known macOS-vs-Linux gap, [[project_chronic_ci_red_is_cross_platform_gap]]), so the asset-upload step never runs, `bin/release-gate.sh --post-tag` is **unsatisfiable by construction**, and `check-update.ts` (`gh release download -p '*.tar.gz'`) has **no artifact to fetch for the whole beta line** — the auto-update path is untested end-to-end. Pre-existing, not introduced here; worth its own row if auto-update matters. (3) [[B-GITATTR]] + rider [[R-NSG-DUAL]] / R-NSG-ATTR remain open as filed below ([[R-NSG-AJBE]] ✅ shipped, ticket `6dc7d243`).
- ✅ **v2.1.0-beta.6 RELEASED + DEPLOYED 2026-07-25** ([[B-GTRUTH]]) — `gh release` prerelease, deployed runtime carries beta.6 (verified: `codegraph.enabled:true` live, WS-A1 arm + WS-A2 reroute in deployed `.js`). **Full release gate GREEN, all tiers measured** incl. the previously-unmeasured expensive+soak (21/0, soak ran its full ~32 min; fast:budget 0/5, integration 548/0). Session `2026-07-24-45c31610`, `release/v2.1-beta`, 26 commits, 4/4 phases, 340 min. Built via `/pickle-pipeline` (refine→pipeline). **Refinement corrected 10 wrong premises** in the hand-authored PRD (see `prd_refined.md` §0 AUTHOR'S RETRACTION): WS-A1 was type-level unbuildable as scoped → widen the oracle (attended, R-PSRB); WS-A2 named the wrong sites (`isHaltExit` irrelevant; decisive set is `FAILURE_EXIT_REASONS`) → route to the existing PhaseIncomplete contract; WS-A3 conflated worker-gate vs convergence-gate → split A3a (finish R-WGFR subtraction) + A3b (report-only); WS-B3 would have shipped codegraph OFF on every upgrade → **flip the managed value**, not drop the clauses; WS-B2 already-satisfied (dropped); `composes:` stale (emptied); Track C soak DEFERRED post-deploy. Citadel 0 critical; szechuan converged (judged the diff "mostly good," landed the F7 green-panel fix). Audits caught real self-build bugs: a CRITICAL fake-green (`worker gate reports green when no dimension ran`, `c61d1d18`) + a HIGH README staleness.
  - **🔑 Recovery log (1 wedge, `done_without_commit_evidence` on `5121a116` — the 4th occurrence, FIRST on the bundle's own self-build):** the deployed pre-fix runtime hit exactly the WS-A2 bug it ships the fix for (`pipeline-runner.ts:2801` ticket-scoped→phase-fatal, `0/4 phases, 274m`). Recovered clean: verify ground truth (uncommitted refactor was tsc+eslint green) → **commit before relaunch** (`1cb490e2`) → `setup --resume` clears `exit_reason` (`update-state.js` cannot — not in its whitelist) → relaunch. Zero work lost. Memory [[project_bgtruth_selfbuild_hit_own_wsa2_wedge_recovered]]. Strong aim-corroboration; log field-occurrence in the beta.6 ship-state at release.
  - **Residuals to carry:** expensive tier UNMEASURED (gating now); `install.sh` deploy pending (ends the wedge class); P2 trap doors F4/F8/F9 (F9 = zero-diff arm has **no producer wired yet** — latent P1, forward-pinned by a test); the unbounded-`git log` maxBuffer is a **CLASS** (only 1 site fixed) → own PRD.
- 🆕 **[[B-RGATE]] QUEUED 2026-07-25 (P2, next after B-GTRUTH ships) — the RELEASE gate measures the environment, not the code.** This is the WS-A3 sibling the beta.5 ledger explicitly flagged (line 18: *"WS-A3 must name the RELEASE gate, not just the worker gate"*) and that B-GTRUTH refinement scoped OUT — A3a fixed only the *worker* gate. Same proxy-over-ground-truth thesis, one level up. **Evidence — REGROUNDED 2026-07-25 at HEAD (drops the runner-timeout leg):** the runner-timeout leg is **already root-fixed** — `test-runner.ts:41` `DEFAULT_TEST_RUNNER_TIMEOUT_MS = 1800·1000·3·2` (~3h, ×6 over a single soak; comment: *"headroom, rather than shortening the soak"*), so B-NONSTOP WS-4 landed and `PICKLE_TEST_RUNNER_TIMEOUT_MS` is an override, NOT required (I set it out of habit while gating B-GTRUTH). **Live legs only:** install-* tests red in the MAIN repo / green in a worktree at every commit ([[project_install_tests_fail_in_main_repo_pass_in_worktree]]); deploy-soak self-skips on `$HOME` ([[project_deploy_lifecycle_soak_self_skips_without_install_root]]); fast:budget flakes at c=8, authoritative at c=4 ([[feedback_release_gate_fast_suite_concurrency_flakes]]); pnpm off-PATH via nvm lazy-load ([[project_gate_red_from_wrong_node_version_pnpm_shim]]). **The core defect (beta.5 line 18): the gate cannot distinguish contention from breakage → a human classifies reds for hours.** **Fix per THE LENS (subtractive):** remove environment-dependent inputs from the pass/fail verdict (make the gate fail *loud and attributable* on a missing binary / self-skipped soak / killed-by-load run — a distinct "unrunnable" class, NOT `red`), decouple the runner budget from `SOAK_SECONDS`, and either make install-* tests location-hermetic or run them in a worktree by construction. Do NOT add retries/budgets around a flaky gate — subtract the ill-posed inputs ([[feedback_subtract_flaky_gate_input_not_add_resistance]]). Author the PRD, then refine→pipeline.
- ✅ **[[B-NOSTOP-GATES]] SHIPPED 2026-07-26 as v2.1.0-beta.7** (P1 — the directive-4 subtraction; tickets 10–70 Done on `release/v2.1-beta`, session `2026-07-25-aa87fa74`; gate GREEN + tagged — see the beta.7 SHIP STATE entry at the top for gate evidence and field validation) — `prds/p1-b-nostop-gates-honest-verdicts-must-not-halt-the-pipeline.md`. **Regrounded at HEAD `f9739caa` against the live wedge (session `2026-07-25-38095284`) — the full causal chain is grep-verified and quoted from disk in the PRD; TWO ledger premises were CORRECTED (PRD §0).** Thesis sharpened: **[[B-NONSTOP]] made the runner honest, and every honest negative verdict was wired to `{action:'break'}` — the runner stopped lying and started stopping.** Fix reduces to ONE RULE: *honesty is a REPORTING property, halting is a DISPOSITION, they are not the same wire.* A quality/completion verdict may stamp `exit_reason`, refuse a LOCAL action, and must log a residual — it may never break the phase loop. Halting is a **closed** set (cannot-physically-continue: `!start_commit`, unreadable state, `state_schema_version_ahead`, `state_working_dir_missing`, `toolchain_unavailable`, budget/iteration cap, operator cancel, explicit `--strict-phases`). Pinned by ONE invariant test (AC-NSG-5b: no reason in `INCOMPLETE_EXIT_REASONS` ∪ {`pipeline_phase_incomplete`,`phase_no_progress`} reaches `dispatchHaltAction`) rather than a per-site matrix — **a halt-classification table would BE the treadmill**. WS-1 phase-loop subtraction (pipeline-safe, ordered FIRST) → WS-3 residual surface (reuse `logActivity`, no new machinery) → WS-2 stop stamping a foreign SHA on a declared-zero-diff ticket (R-PSRB salvage path → **attended pipeline** per B-RASO, NOT hand-built) → WS-4 verification that RUNS a pipeline and names the next blocker. **Anti-fake-green guards are NOT relaxed** — re-pinned against the verdict + panel (`deriveCompletionVerdict`) instead of against the `break`. R1's residual risk (a scope-locked downstream phase could still, in principle, revert a commit belonging to a parked ticket) is **ACCEPTED, not pinned** — see PRD Risks R1; the stronger cross-phase mechanism was deliberately not built (would contradict the bundle's subtractive thesis). **All of that shipped:** the audit/hardening tail closed out, citadel/anatomy-park/szechuan-sauce all ran on the repaired runtime, the release gate went green, and beta.7 was tagged folding R-WDTF-TO per Operator Decision 1.
  - 🔑 **The measured wedge, verbatim (this is the whole pipeline log):** `Phase pickle exited with code 3` / `Phase pickle exited (exit_reason=done_without_commit_evidence); 0/6 tickets remain unfinished.` — **0/6 unfinished, all six tickets `status: "Done"` on disk, and it stamped `pipeline_phase_incomplete` and broke anyway.** Cause: `reportPhaseIncomplete`'s oracle-exclusion skip is gated on `statusUnfinished > 0` (`pipeline-runner.ts:3527`), so **an all-Done roster — the healthiest possible state — is the one state that cannot reach the skip.** Five stacked refinements of that one predicate (status filter → B-PXBO oracle re-resolution → `statusUnfinished` gate → WS-A2 observable boolean → roster re-check), each adding a new way to STOP. Directive 4 in one function.
  - ⛳ **OPERATOR DECISIONS 2026-07-25:** (1) **R-WDTF-TO FOLDED in — ONE gate ships both as beta.7**; this bundle builds on top of its 6 commits, and its review phases get relaunched on the repaired runtime rather than skipped. (2) **Launch NOW, unattended, WS-1 FIRST** — WS-1/WS-3 are pipeline-safe (deployed JS runs, not the source diff), so a WS-2 wedge still leaves the core halt subtraction landed. Refinement MUST NOT reorder WS-2 ahead of WS-1.
  - ⚠️ **LEDGER CORRECTION 1 — F9's premise is TRUE, its inference "latent/inert/parked" is FALSE.** "Producer" = a **WRITER** of `zero_diff_intent`, and there genuinely is none in production — deliberately, pinned by `tests/zero-diff-completion-arm.test.js:397` ("READ-ONLY in production"), because a runtime writer would let a worker **self-certify a commit-less Done** (both corroborating conditions are worker-producible). **Keep that premise.** But the declaration arrives from a human/refinement author — which is what makes the arm safe — so the arm is **routinely reached**: ticket `7af891d4` declared `zero_diff_intent: audit`, the arm was reached, and its CORRECT refusal **stopped a 4-phase pipeline at 0/4.** Not latent, not inert. **Hard constraint on any fix: add no production writer of the field; both F9 pins stay green unmodified.**
  - ⚠️ **LEDGER CORRECTION 2 — the oracle was RIGHT; do not "fix" it.** `zeroDiffAccept` refusing on `foreign_attribution` is deliberate (`ticket-completion-evidence.ts:961-971`: *"a zero-diff ticket has no business carrying a stamp at all"*). The real defect is a **stamper**: `maybeAutoCloseSplitOriginal` (`extension/src/bin/mux-runner.ts:1504`) wrote ticket `ef394937`'s commit `0bde4711` (`audit(ef394937): …`) onto the declared-zero-diff ticket `7af891d4`, **manufacturing** the R-OMA hard-absent that stopped the run. Already filed: [[project_zero_diff_ticket_stamped_foreign_completion_commit]] — which predicted this exact refusal. **Laundering it via `ownAttributionTokens` is the wrong fix** (a second hatch around one guard).
- 🔺 **[[R-JPCM]] REOPENED 2026-08-06 — the repaired judge STILL fails in the field.** The 2026-08-04 correction below is accurate about WS-1/WS-2/WS-4 being shipped and deployed, and its central point stands: every prior "the cleanup phases miss things" observation predated the repair. **But the measurement it called for has now been taken, and it failed.** The FIRST cleanup-phase run on the repaired judge (B-OFFREPO szechuan-sauce, session `2026-08-04-183319b4`, 2026-08-06) ended with *"judge output did not contain a numeric score"* after **4 attempts** → [[R-JUNS]], which aborted a 590-minute pipeline. So the prompt/parser contract is fixed and something downstream still cannot get a score out of the judge. **Do NOT treat R-JPCM as closed.** The review-integration verdict is unaffected — `prds/research/review-integration-value-analysis.md`'s recommendation was *fix the instrument, then measure*, and this is the instrument still being broken, not an argument for a new review engine. Original correction retained below for provenance:
- ✅ **[[R-JPCM]] shipped-and-deployed correction 2026-08-04 (SUPERSEDED by the reopen above).** WS-1 (`8a64bc5f`) and WS-2
  (`495177d1`, `e4542828`, `3f3fd5d4`) are both landed and live; WS-4's honest-convergence split shipped at
  `9f83e2c1` + `66eb7a69`. Verified at HEAD (`buildJudgePrompt` now emits
  `{score, violations[], resolved, new, remaining}` — the shape `parseLlmJudgeOutput` always wanted;
  `emitJudgeParseDiagnostic` ×4) **and in the deployed tree** (`stalled_below_target` ×2,
  `emitJudgeParseDiagnostic` ×4 in `~/.claude/pickle-rick/extension/bin/microverse-runner.js`).
  **Why the row below read "recurred UNFIXED": the fix landed MID-RUN.** The worker edits *source* while
  the runner executes *deployed JS*, so the szechuan phase that shipped the repair kept measuring with the
  broken judge for its remaining iterations. The four "subtractions landed while the metric sat flat" **are
  the fix itself.** The row was measuring the instrument, not the work.
  ⚠️ **No anatomy-park or szechuan-sauce phase has run on the repaired judge** (23 commits since
  `8a64bc5f`: one szechuan commit from that same blind run, zero anatomy-park). Any impression that the
  cleanup phases "miss things" is an observation of the PRE-fix instrument — see
  `prds/research/review-integration-value-analysis.md`. **Next action is one MEASURED run, not a new
  review engine.** Original row retained below for provenance:
- 🔺 ~~**[[R-JPCM]] SECOND FIELD OCCURRENCE 2026-07-27 — recurred UNFIXED 14 days after filing; escalate P2 → P1.**~~ *(superseded — see correction above)* `prds/p2-bug-fix-bundle-r-jpcm-judge-prompt-parser-contract-mismatch.md` (filed 2026-07-13 from session `2026-07-11-255ad373`). Recurred identically in the szechuan-sauce phase of B-GITATTR (session `2026-07-26-013335ff`): **4 real subtractions landed while the metric sat flat at 2** (`495177d1`, `e4542828`, `3f3fd5d4`, `248c5fa9` across iterations 4–7, all `Classification: held`). The workers were working; the metric was blind — verbatim the 2026-07-13 conclusion.
  - **Confirmed at source this run:** the judge emits a **bare number** (`Metric: 2 (raw: 2)`); `JSON.parse("2")` succeeds but yields a number, so `parseLlmJudgeOutput` returns `degradedJudgeResult('malformed')`; the ledger update is guarded by `if (judgeResult.shape === 'full')` (`microverse-runner.ts:3543`) so `updateViolationLedger` is **never reached**; `compareMetric(…, undefined, undefined)` falls to the pure-numeric branch and the whole R-SLLJ set-ops fix is unreachable. **13 `judge_json_parse_failed` events on 2026-07-27**, zero on every prior day this week.
  - 🆕 **The telemetry works; nobody reads it.** All 13 events fired correctly, but `degradedJudgeResult` writes to **stderr** and the operator-visible `microverse-runner.log` has **zero** occurrences — it shows only `Classification: held`. The one signal that says the ledger is dead is absent from the log an operator actually reads. Cheap separable fix: also route it through `ctx.log`.
  - ⚠️ **STALE TRAP DOOR actively misleads triage.** `extension/CLAUDE.md`'s ticket-98dc9bed entry claims "no production caller invokes them" — **FALSE at HEAD**: `parseLlmJudgeOutput` (`:3540`), `updateViolationLedger` (`:3545`) and the 6-arg `compareMetric` (`:3569`) are all wired. I triaged from that trap door first and reached the wrong hypothesis (dead code) before reading source; the real defect is the contract mismatch. **Correct the trap door as part of the fix** — this is the [[feedback_reground_the_ledger_before_building_from_it]] failure mode landing on a live diagnosis.
  - **Escalation basis:** two live occurrences in 14 days, both silent, both on the TERMINAL phase (szechuan is 4/4, so it silently caps deslop quality on every `/pickle-pipeline` run and can self-report `converged` against an unmet target). Bites TARGET repos. Fix is subtractive — make prompt and parser agree on ONE contract; do NOT add a second parser.
- 🔴 **[[R-MVPARK]] FILED 2026-07-27 (P2 — the microverse park has NO cumulative ceiling; B-RRH applied to one caller, missed in its sibling).** Report: `prds/BUG-REPORT-2026-07-27-microverse-rate-limit-park-unbounded.md`. Verified by grep at HEAD `6d9d9faf`; observed live when anatomy-park parked **exactly 6h** mid-run (session `2026-07-26-013335ff`, 05:44→11:44Z) and resumed correctly. Parking beats dying and the stale-baseline recapture on resume was right — **the bug is that nothing bounds how many times it can park.**
  - **The divergence:** `computeRateLimitAction` (exported `extension/src/bin/mux-runner.ts:3183`) takes `maxParkMinutes: number = DEFAULT_MAX_PARK_MINUTES` as a **defaulted 5th arg**. `extension/src/bin/mux-runner.ts:6911`/`:10660` pass it (5 args) and own the persistent `state.rate_limit_park` accumulator (11 refs to `isParkExhausted`/`cumulative_parked_ms`). `microverse-runner.ts:4132` passes **4 args** and has **ZERO** refs to `rate_limit_park`, `resolveRateLimitSettings`, or `max_park_minutes`. The defaulted param makes the omission invisible at the type level — the sibling compiles, runs, and silently gets different semantics.
  - **(a) LOAD-BEARING — unbounded cumulative park on phases 3–4.** Per the B5 trap door, `computeRateLimitAction` clamps only ONE wait; `isParkExhausted` fires on the **cumulative** term, which microverse never tracks. Its only bound is the consecutive **count** (`>= maxRetries` 3), and that counter **resets to 0 on any successful iteration** (`microverse-runner.ts:4363`, `:3208`). Unbounded pattern: `park 6h → success → counter resets → park 6h → …`, bounded only by `max_iterations` (500). `max_time_minutes` is disabled BY DEFAULT (this session ran `Max Time: ∞`), so there is no wall-clock backstop. **Bites TARGET repos** — any pipeline reaching anatomy-park/szechuan-sauce on a rate-limited account can park overnight, the exact failure B-RRH was built to end.
  - **(b) LATENT, currently invisible — operator `max_park_minutes` ignored on those phases.** microverse uses the compiled default. Shipped setting is `{"max_park_minutes": 360}` — **identical to `DEFAULT_MAX_PARK_MINUTES = 360`** (`pickle-utils.ts:843`), so today no divergence is observable and the observed 360min park is consistent with either path. Becomes real the moment an operator changes the setting: pickle honors it, anatomy-park/szechuan silently keep 6h. Recorded separately so the two legs are not conflated.
  - **Fix subtractively:** route microverse through the EXISTING `state.rate_limit_park` accumulator rather than growing a second ledger — two park implementations with two budgets is the duplicated-mechanism smell, and deleting one is the win. Passing the 5th arg alone fixes only leg (b) and leaves the unbounded leg untouched — **do not stop at the arg.** Then pin an invariant that **every** `computeRateLimitAction` call site passes the cumulative-bounding argument, enumerated structurally, or a fourth caller repeats this.
  - ⚠️ **Second instance today of "the fix landed on the callers we enumerated"** (see [[R-NSG-AJBE]], same shape, same run). The deliverable is an invariant with reach, not a set of patched sites.
- 🔴 **[[R-GTDT]] + [[R-DSPW]] FILED 2026-07-26 — two defects observed LIVE during the B-GITATTR self-build** (session `2026-07-26-013335ff`, pickle phase, 8/10 Done). Report: `prds/BUG-REPORT-2026-07-26-gitattr-double-trailer-and-duplicate-worker-spawn.md`. Neither fixed; run deliberately NOT interrupted.
  - 🚨 **[[R-GTDT]] ROOT CAUSE CONFIRMED 2026-07-27 — RELEASE BLOCKER; my 2026-07-26 "suspected mechanism" was WRONG.** Anatomy-park iter 4 found it independently (`71d75cc8`), verified at HEAD. **Producer and consumer read two different oracles:** `maybeAmendTicketTrailer`'s already-attributed guard tests a word-boundary regex over **raw `%B`**, while `scanGitLogByTrailer` reads git's **PARSED trailer view** — and git parses trailers from the **last paragraph only**. A ticket id appearing as **prose** satisfies the guard → stamp skipped → no parsed trailer → evidence `absent` → `done_without_commit_evidence`. **The exact failure this bundle exists to eliminate, reproduced by its own fix.** Verified live: 7 consecutive commits (`316a84e0 1f6e9005 ad78ab07 9c549191 732aaf44 3c3499ac cea3c316`) each carry prose `(ticket 6b7c3b82)` with an **EMPTY** parsed trailer. This is the COMMON case — worker conventions routinely put `(ticket <hash>)`/`fix(<hash>):` in the subject. **Why 8/10 still went Done, and why that's the dangerous part:** after ticket 50 deleted message inference, the explicit `completion_commit` field (R-RIC-EXPLICIT) **silently covered** for the inert trailer channel — an older mechanism masked the new one's failure, so every green signal in that run overstates how well the trailer works. Second half of the theme: the `-m message -m trailer` amend opens a new paragraph, **demoting pre-existing trailers** (`Co-Authored-By`) to prose — the true source of the `271587ae` double-trailer symptom. **The fix (one uniform oracle: parsed-view guard + `git interpret-trailers`) is implemented and each half mutation-verified RED, but CANNOT LAND:** `tests/spawn-morty-commit-attribution.test.js:116` asserts the bug as the contract (`test('tip already word-boundary-tagged with the ticket id is NOT amended')`) and that file is **absent from all 313 `allowed_paths`**. Worker correctly refused to edit out-of-scope and cataloged an honest OPEN GAP with `ENFORCE: none`. Patch preserved: `<SESSION_ROOT>/extension/AP-EXT-ITER4-01-verified-fix.patch` (15KB). **Remaining work is LANDING it, not designing it** — the scope fence, not the engineering, is the blocker.
  - **[[R-GTDT]] original symptom filing (mechanism superseded above) — a commit can carry TWO `Pickle-Ticket` trailers, the second one garbage.** 7 of 8 trailered commits are clean; `271587ae` carries `Pickle-Ticket: a026c5cc` **and** `Pickle-Ticket: ticket-model-recovered-off`. The second value is not a ticket id and appears **nowhere in `extension/src/`**, so it is not a leaked code identifier — something wrote a flag/state-shaped string into `PICKLE_TICKET_ID`. Violates the bundle's own AC-GA-1 (exactly one) and AC-GA-2 (idempotence). **Suspected but UNCONFIRMED mechanism:** `git commit --trailer` applies via `interpret-trailers` AFTER `prepare-commit-msg`, so the hook's `^Pickle-Ticket:` guard is structurally blind to it. **Half of this may already be self-fixed** by `2717dd7f` (CRITICAL) + `c3f82776` in the same run — grep HEAD before building. **The unexplained residual is the garbage VALUE**: a double-stamp explains two trailers, not a non-hash one. A trailer the consumer believes but can never match is strictly worse than the inference it replaced. Fix subtractively — constrain the `PICKLE_TICKET_ID` writer at source rather than sanitizing at the hook, and make ≥2 trailers **ambiguous → attribute to NEITHER** (mirroring the existing file-touch ambiguity rule).
  - **[[R-DSPW]] — the manager re-spawns a worker for a ticket whose worker is still alive.** Two concurrent `spawn-morty.js` on ticket `6b7c3b82` (pids 8332 @13m40s and 4478 @3m04s), both descending from the **same** manager → mux-runner → pipeline-runner chain, so this is NOT the dual-runner/orphan class ([[project_dual_pipeline_runner_orphan_contends_on_shared_state]] — there the trees are separate; here one manager knowingly created the second). Pane shows the decision verbatim: `description: "Re-spawn Morty for 6b7c3b82 to resume"`. Two live workers race the ticket frontmatter, lifecycle artifacts, the git index, and `PICKLE_TICKET_ID` stamping. **Open question the fix must answer first:** why did the manager judge a 10-minute-old live worker as needing resume? Check whether the liveness probe keys on artifact mtime rather than `isProcessAlive`. Subtractive fix: remove whatever heuristic declared the live worker dead, rather than adding an "is there already a worker" guard beside it.
  - ⚠️ **Diagnostic false trail to avoid:** `pgrep -c -f "pipeline-runner.js"` returned `0` against a **healthy** 5h30m-old chain, and `pipeline-runner.log` frozen at the `PHASE 1/4` header is **normal** (it only writes on phase transitions). Walk the process ancestry before declaring a runner dead — both signals lied here.
  - 🔴 **[[R-SITC]] FILED 2026-07-26 — the integration tier asserts BOTH that message-inference is deleted AND that it still works.** Escalated by ticket `6b7c3b82` (test-quality review), then independently re-verified by the manager. `npm run test:integration` → EXIT=1, **587 tests / 577 pass / 10 fail**, across 8 files: `boundary-commit-at-iteration` (3), `wuwc-reproducer`, `doneflip-gate-all-callsites`, `mux-exit-path-commit`, `exit-path-bystander-stash`, and `characterization/completion-commit-cluster/path-{2,3,7}` (1 each). **Inherited, not caused by `6b7c3b82`** (per the Green-tree precondition, naming the commit): `a4e48c26` (ticket `769690b1`) deleted `scanGitLogByRefToken` + `extractRCodeTokens` — both now grep to **0 files in `extension/src/`** — and these 8 files were never reconciled. `6b7c3b82`'s diff is **test-only across 6 gitattr/nostop-gates files + 2 PRDs, touching no `src/` file and none of the 8**, so it cannot have moved this needle. Manager repro at HEAD: `wuwc-reproducer` fails on `must infer commit from git log scan matching ticket-id (B-DURA T70: committed)`, while `gitattr-inference-deleted.test.js` is **14/14 green** asserting those same symbols are absent — a suite in direct self-contradiction. ⚠️ **Note the tier split: `test:fast` is GREEN (7135 tests, 0 fail); only `test:integration` is red**, so a fast-tier-only precondition check will not see this. **Fix is subtractive** — delete/rewrite the stale assertions to pin the *post-deletion* contract; do NOT restore the inference to make them pass (that would undo the bundle's whole thesis). Cluster B (~4 of the 10) shows `expected committed, got honest_failure/commit-failed` and is a **distinct undiagnosed symptom** — triage separately, do not assume one root cause. ⚠️ Also filed by `6b7c3b82`: **AC-5's own verify command is vacuous** — `audit-subprocess-heavy-tests.sh` matches only `spawnSync('bash'|'sh')`, but every git spawn on this surface is `execFileSync('git')`, so its green was never evidence.
- 🟡 **[[B-GITATTR]] BUILT 2026-07-27 — 10/10 tickets Done, all 4 phases ran, NOT shipped: blocked on [[R-GTDT]] (its own deliverable is inert).** Session `2026-07-26-013335ff`, `release/v2.1-beta`, ~22h wall (~6h of it a rate-limit park). Built via refine→`/pickle-pipeline`, `--scope branch` (313 allowed paths).
  - **Phase outcomes.** pickle **10/10 Done, exit 0, "completed successfully"** (cleaner than beta.7, which finished 3/4 with a parked ticket). citadel: 3 cycles, 26 findings still open → **"continuing pipeline (no halt)"**. anatomy-park: **did NOT converge** — see below. szechuan-sauce: ran, metric blind (→ [[R-JPCM]]).
  - 🆕 **anatomy-park honest non-convergence (`anatomy_non_convergent`, non-fatal) — the B-NONSTOP + B-NOSTOP-GATES theses COMPOSING.** `[B-APNC] subsystem 'extension' ran 8 pass(es) with no clean pass — halting as non-convergent (non-fatal; pipeline continues)`; 16 iterations, 660m, `consecutive_clean` bin=1/ext=0, `stall_counts` 0/0, **17 trap doors added / 15 committed**. It reported non-convergence truthfully instead of claiming success **and** handed off to szechuan instead of halting. **The signal worth keeping: `extension` never earned a clean pass in 8 tries** — it kept surfacing new CRITICALs (two `bash -c`/escaped-quote nests that bypassed EVERY worker-forbidden-op guard; the pre-reset archive emitting an unappliable binary stub; the trailer-oracle divergence). That subsystem carries more latent defect than one review cycle can drain — information, not failure.
  - 🚨 **Release blocker: the bundle's central deliverable does not work for the common commit shape** ([[R-GTDT]] row above — producer reads raw `%B`, consumer reads git's parsed trailer view). 8/10 tickets still flipped Done **because the explicit `completion_commit` path silently covered for the inert trailer channel** — an older mechanism masking the new one's failure, which is why every green signal in this run overstates the trailer's health. Follow-up bundle **[[R-GTDT-LAND]] AUTHORED 2026-07-27** (`prds/p1-r-gtdt-land-the-scope-blocked-trailer-oracle-fix.md`, P1): the fix is already written and each half mutation-verified RED by anatomy-park iter 4; it was correctly reverted per the scope-preflight protocol because the test asserting the bug is outside `allowed_paths`. **The remaining work is LANDING it, not designing it.** Launch with the test file in scope, verified BEFORE the first ticket runs.
  - **Four findings this run surfaced** (detail in their own rows above, not repeated here): [[R-GTDT]] (release blocker), [[R-DSPW]], [[R-MVPARK]], [[R-JPCM]] (2nd occurrence → P1). **Three of the four are the same shape — a fix that landed on the callers someone enumerated** (R-NSG-AJBE's 6th halt site, R-MVPARK's 3rd `computeRateLimitAction` caller, R-GTDT's divergent producer/consumer oracles). *The deliverable is an invariant with reach, not a set of patched sites.*
  - **Original filing (2026-07-26, P2 — superseded by the BUILT entry above):** *Collapsed from 5 separately-filed rows on operator instruction: "5 rows → 2 root causes, and one subtraction kills 3." Filing 5 P2s onto a 120KB ledger IS the accretion the north star warns about — the count was misleading, not the defects.*
  - **Root cause: completion attribution is MESSAGE-MATCHED, not git-authoritative.** The oracle decides "did this ticket produce this commit?" by string-matching the commit message (ticket-hash tokens, `r_code`, recovery-commit shapes) and by frontmatter *declarations*. That is the proxy. **Make attribution git-authoritative — a runtime-written trailer at commit time, or attribution derived from the files the ticket declared — and all three of the following dissolve at once.** Same shape as B-NOSTOP-GATES itself: the fix was never 12 halt sites, it was one rule.
  - Dissolved (1) — **unattributable audit/harden commits.** `refine-prd`'s hardening templates specify `audit: [CRITICAL/HIGH] cross-ref — …` / `harden: [principle] — …` with **no ticket-hash component**, unlike `fix(pipeline-runner): 822bb80e — …`. Chain observed **3× on `a3c75c96`**: 4 real commits land → oracle can't attribute → evidence absent → phantom-Done watcher reverts the Done flip (`ticket_phantom_done_corrected` + `ticket_state_desync_detected`) → manager reopens → killed mid-verification → parked. **Every operator Done-flip there was correctly undone by a working guard.** Template-level, so it **recurs on every bundle** until fixed.
  - Dissolved (2) — **foreign-SHA borrowing.** Recurred on an **UNDECLARED** ticket one ticket after its own fix landed: `7cd194b6` came back Done carrying `1baadd17` — `e350ab05`'s own commit, i.e. the WS-2 fix commit itself. Immediate cause **source ≠ deployed** (live mux-runner executes `~/.claude/pickle-rick/**` until `install.sh`; **a self-fixing bundle does not protect its own remaining tickets**), but the borrow is only *possible* because attribution is message-shaped. Detail: [[project_zero_diff_ticket_stamped_foreign_completion_commit]].
  - Dissolved (3) — **the `zero_diff_intent` authorship pin is blind to agent-authored frontmatter.** `tests/zero-diff-completion-arm.test.js:397` scans `src/` for code *writers*; it cannot catch a MANAGER (an LLM) editing frontmatter. Observed live: a `zero_diff_intent: verification` line appeared on `7cd194b6` that the PRD author did not write. Git-authoritative attribution removes most of the *need* for a rescuing declaration.
  - ✅ **[[R-NSG-AJBE]] SHIPPED — ticket `6dc7d243`, commit `f6e0ba44`.** `runAllBackendsExhaustedFinalizeGate` (`pipeline-runner.ts:4101`) used to return `{action:'break', phaseIncomplete:true}` on a **PASSING** recovery gate while its sibling `runJudgeTimeoutFinalizeGate` returned `{action:'continue'}` — one more instance of the class WS-1 already fixed, in the 6th function WS-1's 5-site surface never named. Found by AC-NSG-16 (the AC written to assume the PRD's own inventory was wrong; it was), independently re-derived by the session manager. Now matches its sibling: `counters.completed++`, `writeRunningStatus`, `{action:'continue'}` on pass; the failing branch is unchanged. `AC-NSG-5b`'s invariant test was widened to structurally enumerate all 8 `PhaseIterationOutcome` producers (`nostop-gates-invariant.test.js`), plus a new `nostop-gates-sibling-parity.test.js` for direct behavioral coverage of both recovery-gate functions.
  - **Standalone, small:** **[[R-NSG-DUAL]]** — a relaunch can spawn a SECOND `pipeline-runner` while the first is alive-but-orphaned (`ppid=1`, its mux still running `npm run test:fast`) → two trees on one `state.json` → overlapping `test:fast` + racing gate verdicts; reaping the orphan poisons shared state (`exit_reason: "signal:SIGHUP"`, `active:false`) while the survivor works. Launch supervision, not attribution. Recipe: [[project_dual_pipeline_runner_orphan_contends_on_shared_state]].
  - **Scope observation (no row needed):** citadel spent 3 remediation cycles / 32 findings / **0 remediable / 0 commits** on `AP-RMS-*` anchors in `extension/tests/spawn-refinement-team-checker.test.js`. It correctly did NOT halt. Cross-ref: [[project_bcfr_brace_free_if_is_fabricated_rule_loop]].
    - ⚠️ **PREMISE CORRECTED 2026-07-26 (verified at `62657aff` before tagging beta.7).** This row previously read *"a file absent from this bundle's 19-file diff"* — **both halves are false.** The branch diff vs `origin/main` is **298 files**, and that test file **IS in it** (as are `pipeline-runner.ts`, `ticket-completion-evidence.ts`, and the `nostop-gates-*` tests the other findings anchor to). "Outside the diff" was never the reason the findings were non-blocking. **The sound reason: ZERO findings reach Critical** (6 High / 23 Medium / 3 Low) and the remediator only auto-fixes ≥ Critical — which is exactly why 13 stayed open. All **6 Highs are one class**, `orphan-test-case`, on that single file: its cases are anchored to `AP-RMS-{3,6,8,9,10,12}`, an AC namespace belonging to **another bundle** (`AP-RMS` appears in `src/bin/CLAUDE.md` and this ledger, in **no** `prds/p*.md` AC list), so citadel auditing *this* bundle cannot resolve them. Cross-bundle anchor bookkeeping, not a code defect; the file is green in the fast tier. Keep the conclusion, discard the reasoning.
  - **Accounting for the record:** this bundle *introduced* 2 CRITICALs (both in WS-1's own code — terminal `exit_reason` clobbered by a later phase's finalize `0d4d0041`; inventing `pipeline_phase_incomplete` when nothing was stamped `b23b6759`), and **its own data-flow audit ticket caught and fixed both pre-release**. The 3+2 above are **pre-existing defects this run exposed**, not defects it created.
- ✅ **[[R-WDTF-TO]] SHIPPED 2026-07-26 as v2.1.0-beta.7 (folded into [[B-NOSTOP-GATES]], one gate/tag for both — its review phases DID relaunch on the repaired runtime and reached citadel/anatomy-park/szechuan-sauce).** Original entry, retained for the wedge forensics: `prds/p1-r-wdtf-to-worker-timeout-nulls-committed-work.md` (inventory Tier-2-C, was mis-tracked as shipped). Session `2026-07-25-38095284`, 6/6 tickets Done, 6 commits (WS-2 guard `169bb331` + WS-1 SHA-preserve `910c7eff` + audit fixes incl. a CRITICAL `fc4f44f1` [guard trusted a non-test-inclusive verdict] and a HIGH `0bde4711`). **The substantive fix (stop nulling a committed SHA on timeout + guard the resume auto-Done) is DONE and audited; tsc/eslint green.** BUT the pickle phase then **stamped `pipeline_phase_incomplete` and stopped (0/4 phases)** — blocked by the **F9 zero-diff gap**: the test-quality hardening ticket `7af891d4` did a legitimate zero-diff audit (conformance ALL_PASS, `zero_diff_intent: audit`, no commit of its own), got a **borrowed `completion_commit`** (ef394937's `0bde4711`) written to its frontmatter, which routed the oracle to sha-verification (absent) instead of the zero-diff arm. **This wedge IS the evidence for the OPERATOR DIRECTIVES above** — a quality gate (the completion oracle) stopped a pipeline whose work was done, taking the review-phase quality to zero. **Decision RESOLVED 2026-07-25 (option c, per Operator Decision 1 above): folded into [[B-NOSTOP-GATES]] — one release gate ships both as beta.7.** F9's borrowed-SHA confusion is fixed by B-NOSTOP-GATES WS-2 (ticket `e350ab05`, commit `1baadd17`); R-WDTF-TO's review phases relaunch on the repaired runtime once the bundle reaches citadel/anatomy-park/szechuan-sauce.
- 🔻 **[[R-WDTF-TO]] original queue note (superseded by the BUILT entry above):** The reliability inventory's Tier-2-C leak, MIS-TRACKED as shipped. The ledger records "R-WDTF → shipped B-WDSUB," but B-WDSUB subtracted the `tokenPresent`/`ANALYSIS_DONE` narrative-token conjuncts — NOT the **timeout** conjunct. **Regrounded at HEAD 2026-07-25:** `spawn-morty.ts` `evaluateWorkerOutcome` still computes `isSuccess = !ctx.mutableState.timedOut && hasArtifact && (logNonTrivial || hasEdits)` — a wall-clock proxy still AND-gating the `hasEdits` **git** signal — and `:2084` still writes `status:'Failed', completion_commit: null`, erasing a real committed SHA. This is the reliability inventory's **highest-frequency historical leak** (`RELIABILITY-INVENTORY` Tier 2), it **bites TARGET repos** (any long worker that blows wall-clock *during* the test:fast gate after committing green work), and the fix is **subtractive**: drop the `!timedOut` blinder / route the timeout Failed-flip through the existing `evaluateFailedFlipSuppression` git-check (already wired into the gate-fail branch only — no new machinery). **Strongest next reliability target by the ledger's own criteria.** Sibling still-open inventory leaks: Tier-3-F `mux-runner executeBoundedEscape` (`:6190 gate:()=>'failing'` + `markTicketSkipped` with no git probe) and Tier-1-B `readEvidence` absent-skip (largely closed — verify the last `return absent`). Roadmap: `RELIABILITY-INVENTORY-2026-07-23-proxy-over-ground-truth.md` (leaks A–H; B-GTRUTH closed Tier-1-A).
- ✅ **v2.1.0-beta.5 RELEASED + DEPLOYED 2026-07-23** (`gh release`, prerelease; deployed runtime carries beta.5). **63 commits since beta.4**, one release gate covering two bundles + anatomy hardening:
  - **[[B-NONSTOP]]** — honest non-convergence + disposition→(exit,report,continue) map + WS-4 runner-timeout-at-root. **Validated LIVE**: this release's own pipeline logged anatomy as *"did NOT converge"* where the pre-fix runtime logged the same exit as *"completed successfully."* Built via `/pickle-pipeline` (session `2026-07-19-afe23e5b`), shipped this session.
  - **[[B-WDSUB]]** — subtract `tokenPresent`/`ANALYSIS_DONE` conjuncts (both sites) + delete dead `readiness_halt` cluster. WS-1 claim VERIFIED against a recorded baseline (`Failed`/null → `Done`/real-SHA, routing change confirmed). Built via `/pickle-pipeline` (session `2026-07-22-3d839159`), 6 tickets. **Refinement caught 5 wrong premises in the hand-authored PRD** — see its `## AUTHOR'S RETRACTION`.
  - **9 anatomy-park fixes** (2 CRITICAL: unreachable rate-limit ceiling `113b9c73`; launch-blocking stray audit artifacts `f1948f74`).
  - **🔑 Recovery log (2 wedges, both `done_without_commit_evidence`, both WRONG):** `bcd9ce96` backgrounded a test and idled; `8784c6cb` (mirror-parity) correctly had NOTHING to commit. Recovered each: verify ground truth → flip Done → clear `exit_reason` → relaunch. Root cause is one line (`pipeline-runner.ts:2801` classifies a ticket-scoped reason as phase-fatal) → [[B-GTRUTH]] WS-A2.
  - **🔑 Gate honesty tax:** 4 gate attempts, ALL reds were environment/operator-error, code was clean throughout — fast:budget flaked c=8 (green c=4 7023/0), 8 integration reds all isolation-green, soak killed by external `vitest`+`claude` load on a load-13 box, one `RUN_EXPENSIVE_TESTS=1` slip of mine. **The release gate cannot distinguish contention from breakage → a human classifies for hours.** This IS the reliability problem, one level up → [[B-GTRUTH]] WS-A3 must name the RELEASE gate, not just the worker gate. Memory: [[project_gate_red_from_wrong_node_version_pnpm_shim]] (pnpm off-PATH via nvm lazy-load; symlinked into `~/.local/bin` this session as the durable fix).
- 🆕 **[[B-GTRUTH]] AUTHORED + QUEUED 2026-07-23 (P1, next up)** — `prds/p1-b-gtruth-ground-truth-over-proxies-and-codegraph-enablement.md`. ONE PRD, 3 tracks: **A** reliability subtractions (A1 zero-diff completion representable; A2 one-line halt reclassification — NOT new machinery, 3 recovery layers already exist+work; A3 gate measures code not environment; A4 external liveness DEFERRED); **B** codegraph enablement (the v2.1 headline feature, additive by operator decision); **C** efficacy soak POST-DEPLOY. Measured basis: **10/10 red-gate tickets ended Done** — a verdict overridden 100% is not a gate. Launch on the beta.5 base via refine→pipeline.
  - 🔑 **3rd `done_without_commit_evidence` occurrence — 2026-07-23, FIRST on a real target-repo codex pipeline** (not a self-build): a `/pickle-pipeline --backend codex` run against **loanlight-api** (session `2026-07-23-e89c5c77`) halted all 4 phases after 6 clean commits; the in-flight ticket was genuinely mid-work (committed clean on resume, `b224c6c25`), and `allow_inferred_completion_commit:true` did NOT prevent it. Corroborates WS-A2 (not self-build-specific), confirms WS-A1 alone insufficient for the manager-declared-done-early flavor. Field detail in the B-GTRUTH PRD `## Field occurrence — 2026-07-23`.

### 📦 Prior ship state (2026-07-22)

- 🟡 **[[B-NONSTOP]] BUILT, NOT SHIPPED — 39 commits on `release/v2.1-beta`, un-gated, unpushed, undeployed.** Session `2026-07-19-afe23e5b`, **4/4 phases, 736 min**, finished 2026-07-20 07:59Z. WS-1 disposition map (`81820cc4`/`9f83e2c1`/`66eb7a69`), WS-2 non-pickle honesty gate (`22dcccd7`/`340f1313`), WS-4 release-gate runner timeout fixed at root (`b8616545` — retires the `PICKLE_TEST_RUNNER_TIMEOUT_MS` workaround), + 9 anatomy-park CRITICAL/HIGH fixes + 5 szechuan subtractions. Tree clean, `tsc` + `eslint` green. **Version NOT bumped (still `2.1.0-beta.4`, an already-released tag).**
  - **Closer correctly refused the tag:** `Closer: prior phase non-zero exit detected — skipping install and tag` (anatomy-park exited 1, `converged:false`, extension subsystem 8 passes / 0 consecutive-clean; szechuan held at metric 8 for 5 iterations).
  - **🔑 The run logged its own defect verbatim:** `Phase anatomy-park exited with code 1 (non-fatal)` immediately followed by `Phase anatomy-park completed successfully` — emitted by the beta.4 runtime *while building the fix for exactly that lie*. Evidence B-NONSTOP was aimed correctly; the fix is in the un-deployed source.
  - **Build ran with quality gates DOWNGRADED** — `skip_quality_gates_reason: "creation-heavy bundle: 12 tickets, 7/12 forward-creating under extension/tests/"`. The full release gate has **never run** against this bundle.
- 🆕 **[[B-WDSUB]] QUEUED 2026-07-22 (P1, composes R-WDTF + R-PRNF9-DEAD)** — `prds/p1-b-wdsub-worker-evidence-truth-and-dead-readiness-halt-subtraction.md`. Batched onto the 39 B-NONSTOP commits **so one release gate covers both** (the gate is the expensive serialized step; the build is not).
- ✅ **v2.1.0-beta.4 RELEASED + DEPLOYED 2026-07-19** (`gh release`, prerelease; deployed runtime carries beta.4). One bundle: **[[R-SAFP]]** — subtract the refinement symbol audit's false-positive categories (enum-membership category deleted [11 findings / 0 real lifetime], sibling made claim-shaped, fail-open, fence-aware). **Net −144 LOC.** Built hands-off via `/pickle-pipeline` (session `2026-07-18-c06fd902`, 4/4 phases). Full gate green 5/5 (fast-budget 0 failures, integration 582+531/0, expensive 13+8/0, soak ran its full 32min). **Release notes explicitly RETRACT any B-NONSTOP unblock claim** (R11, below). Deployed via `--override-active` after confirming the blast radius was one file the live build never executed + a state snapshot — the URAR target-repo build had already finished during a pause, so the override was risk-free in the event.
  - **🔑 R11 verification (ticket `630b7aca`) caught TWO of my own wrong predictions:** (1) the PRD asserted "unblocks B-NONSTOP" as fact; (2) it predicted the next block would be a downstream gate. **Both wrong** — running the real refinement showed B-NONSTOP crashes *upstream* at manifest build ([[R-RPFL]]), gates never reached. Ticket retracted the claim. [[feedback_verify_the_outcome_not_the_mechanism]] enforced on our own work; memory [[feedback_add_a_verification_ticket_that_runs_the_claim]].
- ✅ **v2.1.0-beta.3 RELEASED + DEPLOYED 2026-07-18.** Three bundles: **B-SSAT** (settings source-authoritative + worker-gate timeout — R-WTFT was inert since May, now `resolveWorkerTestGateTimeoutMs()` returns 600000 live), **R-MWMO d2** (exit-code masking), **B-CGHARD** (codegraph input harvester + soak enable-path docs; WS-CGH-A/B were found already-shipped and dropped). Two gate-infra caps fixed while running it (see [[project_release_gate_runner_timeout_equals_soak_duration]]).
- 🆕 **[[R-RPFL]] FILED 2026-07-18 (P2, unbuilt)** — `prds/BUG-REPORT-2026-07-18-refinement-relative-prd-fail-late-manifest-crash.md`. A **relative** `--prd` runs all 3 analyst cycles then crashes at `enrichManifestTicketsFromSourcePrds` (`spawn-refinement-team.ts:1646`). Fix subtractive: resolve at argv-parse. **The normal pipeline flow DODGES it** (setup.js mints absolute session dirs), so B-NONSTOP built via `/pickle-pipeline` is NOT blocked.

---

## ▶▶ NEXT STEPS — scored by THE LENS (reliability through LESS). Drain in this order.

> ### ▶ CURRENT DRAIN ORDER (regrounded 2026-07-25 at HEAD `855a6259`, post-beta.6) — SUPERSEDES the 2026-07-22 block below
>
> B-NONSTOP + B-WDSUB (beta.5) and B-GTRUTH (beta.6) all **shipped**. The reliability queue below is
> regrounded against code (not the ledger); roadmap = `RELIABILITY-INVENTORY-2026-07-23` leaks A–H,
> of which B-GTRUTH closed Tier-1-A. Every item is grep-verified STILL-OPEN at HEAD. Drain in order:
>
> **⛳ Order revised 2026-07-25 by OPERATOR DIRECTIVES (top of file): [[B-NOSTOP-GATES]] was #1 — make gates continue-and-flag, never stop the pipeline. ✅ BOTH SHIPPED 2026-07-26 as v2.1.0-beta.7 ([[R-WDTF-TO]] folded in, one gate/tag) — rows 1 and 1b below are CLOSED; the live head of the queue is row 2 onward.**
>
> | # | Finding | Pri | Why (bites a TARGET repo? + subtractive?) |
> |---|---|---|---|
> | 1 | **[[B-NOSTOP-GATES]]** — gates park-and-flag, never stop the pipeline (directive 4) | **P1** | ✅ every run (the halt-brittleness that wedged both this session's pipelines) · ✅ subtractive (remove halt paths). ✅ **SHIPPED 2026-07-26 as v2.1.0-beta.7** (`p1-b-nostop-gates-…md`; WS-1/WS-3/WS-2/WS-4 + 3 hardening tickets Done, session `2026-07-25-aa87fa74`; all 4 phases ran, full gate GREEN, tagged). **CLOSED — thesis validated in the field: the identical roster that stopped 0/4 three times now logs `reporting phase incomplete, advancing`.** |
> | 1b | **[[R-WDTF-TO]]** — timeout nulls committed work (inventory Tier-2-C) | **P1** | ✅ **SHIPPED 2026-07-26 as v2.1.0-beta.7 — FOLDED into [[B-NOSTOP-GATES]], one release gate shipped both** (beta.5 B-NONSTOP+B-WDSUB precedent). Its review phases were NOT skipped — they relaunched on the repaired runtime and reached citadel/anatomy-park/szechuan-sauce. **CLOSED.** |
> | 1c-0 | **[[R-GADEL]]** — WS-3 deleted message inference and left NO attribution fallback | **P1** | 🚨 **RELEASE BLOCKER for beta.8 — drain FIRST.** Gate RED at `c457e943`: 10 integration failures incl. the completion-commit characterization suite (*"primary regression guard for the 8 Done-stamping paths"*, release-gate invariant *"MUST pass on every release"*). **Bisected: `00765390` 5/5 pass → `a7d6d9ec` 3 fail** — B-GITATTR introduced it; R-GTDT-LAND is exonerated. **Structurally invisible to every worker**: all failing files are `@tier: integration` while the worker gate runs `test:fast`, and B-GITATTR never ran a full gate. **Answer first:** does the trailer cover every case message inference covered? Then update tests (with per-test reasoning) OR restore a fallback (a stated partial WS-3 revert). **Do NOT reflexively rewrite the guard suite.** |
> | 1c-i | **[[R-GTDT-LAND]]** — land the scope-blocked trailer-oracle fix | ✅ **BUILT, blocker CLOSED** | Session `2026-07-27-5b2cefc5`, 2/2 phases, 167m, `exit_reason: completed`. Fix deployed and **field-proven** by an A/B on its own commits (`b4dbd528` pre-deploy `trailer=[]` → `c457e943` post-deploy `trailer=[ce0a4f46]`, same prose-subject shape). Fast tier 5/5 runs 0 failures, 9/9 audits green, citadel 0 remediable. **Not shippable only because 1c-0 reddens the gate.** Original framing: |
> | ~~1c-i~~ | ~~land the scope-blocked trailer-oracle fix~~ | ~~P1~~ | 🚨 **RELEASE BLOCKER for [[B-GITATTR]] — drain FIRST.** Producer guards on raw `%B`, consumer reads git's parsed trailer view; git parses trailers from the LAST paragraph only, so a prose ticket id suppresses the stamp → evidence `absent` → `done_without_commit_evidence`. Verified live: 7 consecutive commits with prose `(ticket 6b7c3b82)` and an EMPTY parsed trailer. **The fix is written and each half mutation-verified RED** (anatomy-park iter 4); it was correctly reverted because the test asserting the bug is outside `allowed_paths`. Work = LANDING it. PRD: `p1-r-gtdt-land-…md`. |
> | 1c-ii | **[[R-JPCM]]** — judge prompt demands a bare number, parser demands JSON | **P1** *(was P2)* | ✅ target repos · ✅ subtractive (ONE contract, not a second parser). **2nd live occurrence in 14 days**, both silent, both on the TERMINAL phase — 4 real subtractions landed while the metric sat flat; 13 `judge_json_parse_failed` events on 2026-07-27. Silently caps deslop quality on EVERY pipeline run and can self-report `converged` against an unmet target. **Also correct the stale `extension/CLAUDE.md` trap door that misroutes triage to a dead-code hypothesis.** |
> | 1c-iii | **[[R-MVPARK]]** — microverse rate-limit park has no cumulative ceiling | P2 | ✅ target repos (any pipeline reaching anatomy-park/szechuan on a rate-limited account can park overnight) · ✅ subtractive (route through the EXISTING `state.rate_limit_park` accumulator; don't grow a second ledger). B-RRH landed on mux-runner's 2 call sites and missed `microverse-runner.ts:4132`. |
> | 1c-iv | **[[R-DSPW]]** — manager re-spawns a worker whose worker is still alive | P2 | Two live `spawn-morty` on one ticket under the SAME manager chain; they race ticket frontmatter, artifacts, the git index and trailer stamping. Likely root cause now known: the `rtk` filter empties `ps\|grep`, so a live worker reads as dead ([[project_rtk_filter_empties_grep_pipes_causing_false_death_reads]]). Fix subtractively — remove the heuristic that declared it dead, don't add an "is there already a worker" guard beside it. |
> | 1c | **[[B-GITATTR]]** — completion attribution is message-matched, not git-authoritative | ✅ **BUILT** | ✅ **10/10 Done, 4 phases ran, NOT shipped — blocked on 1c-i.** See SHIP STATE. | ✅ target repos (unattributable commits → phantom-Done reopen loops on every bundle) · ✅ **subtractive, and ONE fix dissolves THREE field-observed defects** (unattributable audit commits + foreign-SHA borrowing + the agent-authored-declaration hole). Collapsed 2026-07-26 from 5 separately-filed rows. Carries one open rider, [[R-NSG-DUAL]] (launch supervision, standalone); the other, [[R-NSG-AJBE]], is ✅ shipped (ticket `6dc7d243`). |
> | 2 | **[[B-RGATE]]** — release gate measures environment not code (re-scoped: runner-timeout leg already root-fixed) | P2 | ✅ target-repo release gates · ✅ subtractive (unrunnable ≠ red). Live legs: install-* hermeticity + soak-`$HOME` self-skip + contention-vs-breakage. Author PRD. |
> | 3 | **git-log maxBuffer CLASS** — `standup.ts:224` + `pipeline-runner.ts:3588` unbounded | P2 | ✅ any repo w/ a large commit window (ENOBUFS → phase crash) · small hardening. Own PRD. |
> | 4 | **Tier-3-F** `executeBoundedEscape` (`mux-runner.ts:6190 gate:()=>'failing'`) | P2 | ✅ target repos · ✅ subtractive (gate `markTicketSkipped` on `evaluateCompletionEvidence` first). |
> | 5 | **B.5(b)** convergence-gate `null`-projectType skip (`:1329`) | P2 | ⚠ scope vs R-SZGB-B's per-iteration fail-closed FIRST (likely a narrow finalize/check-gate residual). |
>
> **Deprioritized despite clean subtraction:** [[R-RWNF]] (dead review seam) — self-build-only, inert on
> target repos → low autonomy payoff. ~~**Parked latent:** B-GTRUTH F9 (zero-diff arm has no producer) —
> inert-by-construction (refuses safely).~~ **UN-PARKED 2026-07-25 — the no-runtime-WRITER premise is
> true and must be kept (pinned: `zero-diff-completion-arm.test.js:397`), but "inert" is false:**
> human/refinement authors supply the declaration, so the arm is routinely reached, and it **fired in
> the field**, stopping a 4-phase pipeline at 0/4. Its real defect is a foreign-SHA **stamper** (scan
> arm accepts what the explicit arm rejects), now [[B-NOSTOP-GATES]] WS-2. **Deferred:** Track C codegraph efficacy soak (post-deploy,
> now runnable on the beta.6 base). **Tier-4-H** (real `ExitReason` enum) — LEDGER DRIFT: the type now
> exists at `extension/src/bin/mux-runner.ts:4395`; reground fully before treating the inventory's "phantom" premise as live.

> ### ⚠ REGROUND 2026-07-22 — SUPERSEDES items 1–5 below
>
> All six queue items were re-grepped against HEAD `a17e9258` (post-B-NONSTOP) **and** the deployed
> tree. **Two of six were already fixed by the 39 landed commits** — the ~2-in-6 ledger-drift rate,
> confirmed again. [[feedback_reground_the_ledger_before_building_from_it]] earns its keep.
>
> | # | Item | Verdict at HEAD |
> |---|---|---|
> | 1 | **B-NONSTOP** | ✅ **BUILT** — see SHIP STATE. Not shipped: gate + bump + tag + deploy pending. |
> | 2 | **R-RPFL** | ❌ **DEAD — already fixed** by `2de40025` (`path.resolve(prdPath)` at argv-parse, `spawn-refinement-team.ts:1039`). Dropped, not built. |
> | 3 | **R-WDTF** | ✅ **LIVE, both sites, worse than filed** → [[B-WDSUB]] WS-1. `extension/src/bin/spawn-morty.ts:2471` has the `tokenPresent &&` conjunct; `spawn-refinement-team.ts:968` is `!workerTimedOut && hasToken(ANALYSIS_DONE)` — the token is the **only** positive evidence there, no artifact fallback. |
> | 4a | **B.5 `finalizePhaseSuccess`** | ❌ **DEAD — already fixed** by B-NONSTOP WS-2 / AC-NS-6 (`22dcccd7`), `pipeline-runner.ts:4275`. Dropped. |
> | 4b | **B.5 convergence-gate `null` projectType** | ⚠️ still live (`convergence-gate.ts:1329` returns `emitSkippedAndReturn(opts, null, 'no_project_type_detected')`) but the skip-reads-as-pass claim needs its own scoping. **Deferred — not in B-WDSUB.** |
> | 5 | **R-PRNF9-DEAD** | ✅ **CONFIRMED DEAD end-to-end** → [[B-WDSUB]] WS-2. Zero producers of `'readiness_halt'` in src **or** deployed. Chain: `:4047` reader never true → `:4048` never writes `pickle_readiness_halt` → `:3719` predicate never true → `:2799` + `:3890` never fire. |
> | 6 | **B-CGCAP** | 🔄 **SUPERSEDED by operator decision 2026-07-22** — codegraph is the v2.1 headline feature. The keep-vs-subtract question is closed in favour of **KEEP + ENABLE**. See [[B-CGEN]] below. |
>
> **Drain order now (revised 2026-07-23):** (a) full release gate on the B-NONSTOP + B-WDSUB stack →
> bump `2.1.0-beta.5` → tag → deploy; (b) **[[B-GTRUTH]] — ONE PRD combining the reliability
> subtractions with [[B-CGEN]] codegraph enablement** (`prds/p1-b-gtruth-ground-truth-over-proxies-and-codegraph-enablement.md`);
> (c) then B.5(b) scoping. **[[B-CGCAP]]'s subtract arm is retired by operator decision.**
>
> **Why one PRD** (operator decision 2026-07-23): the codegraph efficacy soak is only trustworthy on the
> repaired runtime. Track A (reliability) must be built, gated **and deployed** before Track C (the soak)
> runs — one PRD makes that a hard ordering constraint rather than a hope, and one release gate covers both.
>
> **The measured case for Track A** (scanned across all sessions, 2026-07-23): **10/10 red-gate tickets
> ended `Done`** — a verdict overridden 100% of the time is not a gate. Both recorded phase halts were
> `done_without_commit_evidence`, and **both were wrong**. One 6-ticket bundle required **2 operator
> interventions**. Five distinct incidents, **one shape**: a proxy signal outranking recoverable ground
> truth. B-WDSUB closed two instances; B-GTRUTH closes the class.

**Drain order = the REGROUND table above.** The prior numbered items 1–6 (and their §B/§C source-grounding) are superseded — all shipped, dead, or folded into [[B-GTRUTH]]/[[B-CGEN]] — and were swept to `MASTER_PLAN-archive.md` → "Swept 2026-07-24".

---

---

## 🚀 v2.1 HEADLINE FEATURE — [[B-CGEN]] ENABLE CODEGRAPH (operator-set 2026-07-22)

**Operator decision:** codegraph is the key new feature for the v2.1 release. Enablement is the next
step once the B-NONSTOP + B-WDSUB stack ships. **This supersedes [[B-CGCAP]]'s keep-vs-subtract
framing — the subtract arm is OFF the table.**

> ⚠ **This is an ADDITIVE item on a list whose stated selection criterion is "every item is a
> SUBTRACTION or a de-brittler."** It is admitted by explicit **operator decision** as the v2.1
> headline feature, not by THE LENS. Recorded as a declared exception so the queue does not silently
> violate its own rule. THE LENS still governs *how* it lands: no new mechanism beyond the flip.

### ⛔ The trap — flipping the source setting is INERT

`install.sh:529` MANAGED_KEYS force-resets **both** keys on **every** deploy:

```
jq 'del(.worker_test_gate_timeout_ms) | .codegraph.enabled = false | .codegraph.index_at_setup = false | .auto_update_enabled = false'
```

A source flip alone ships a **disabled** feature to every install. **Amending that line is the
load-bearing change** — not the setting. There is also no env-on counterpart: `PICKLE_CODEGRAPH=off`
only ever disables.

### The real work (every line verified at HEAD, 2026-07-22)

| # | Change | Why |
|---|---|---|
| 1 | **`install.sh:529`** — drop `.codegraph.enabled = false \| .codegraph.index_at_setup = false` from the MANAGED_KEYS jq | **Load-bearing.** Without it every deploy re-disables the feature. Keep the other two managed keys intact. |
| 2 | `pickle_settings.json` — `enabled: true`, `index_at_setup: true` | The flip itself |
| 3 | **Invert two guard tests** — `codegraph-default-optin.test.js` (AC-GA-CG-1 asserts both `false`) + `codegraph-docs-optin-parity.test.js` (AC-GA-CG-2 requires CLAUDE.md read *"Opt-in / disabled by default"*) | Both **WILL red** on the flip. **Invert, do not delete** — they become the guard that codegraph stays ON. |
| 4 | Docs — CLAUDE.md settings row + README two-lane split | AC-GA-CG-2 parity is test-enforced |
| 5 | **Retire Tune-Back CUJ #2** (CLAUDE.md) | Its entire purpose was working around MANAGED_KEYS; obsolete once #1 lands |
| 6 | **Keep `PICKLE_CODEGRAPH=off`** | The kill-switch is the escape hatch — do NOT remove it |
| 7 | **`expose_mcp_to_workers` stays `false`** | Two-lane split (`4e641a88`): the injected-context lane keys on `codegraph.enabled`; the interactive MCP lane is a separate C0-gated flip. Enabling the first is NOT enabling the second. |

### Indexing workstreams (added 2026-07-23 — grounded in `cgResolveIndexAction`, `bin/setup.ts`)

**The freshness check is dead code on the launch path:**

```ts
function cgResolveIndexAction(isResume, dbPath, staleMs): 'full' | 'sync' | 'noop' {
  if (!isResume) return 'full';                  // <- every fresh session: FULL index
  const ageMs = Date.now() - fs.statSync(dbPath).mtimeMs;
  return ageMs >= staleMs ? 'sync' : 'noop';     // <- only ever reached on --resume
}
```

A fresh pipeline in a repo holding a ten-minute-old `.codegraph/codegraph.db` still pays a **full**
re-index. `staleness_max_age_minutes: 30` only does work on `--resume`.

| WS | Change | Shape |
|---|---|---|
| **WS-CGEN-A** | **Delete the `!isResume` shortcut** — let the freshness check govern every path. Cold repo → `full`; recent db → `sync` (30 s cap) or `noop` (free). | **SUBTRACTIVE** — removes a special case, adds no scheduler. **Do this first.** |
| **WS-CGEN-B** | **`sync()` at key points** — post-ticket-commit and phase transitions. `CodegraphService.sync()` already exists and is already bounded by `sync_timeout_ms` (30 s). | Additive, but reuses an existing bounded op. **The accuracy fix — see below.** |
| **WS-CGEN-C** *(only if A+B leave setup too slow)* | Move the initial warm index into the session-scoped service `extension/src/bin/mux-runner.ts:9268` **already creates** — documented *"fail-open — never blocks session start"* — and let it run concurrently with ticket 1. `spawn-morty`'s `buildContext` already degrades when the graph isn't ready. | Async **without a new lifecycle** — in-process, on a process that already outlives the run. |

**WS-CGEN-B carries the real value, and it is about correctness, not latency.** A pipeline mutates the
repo it is indexing: the B-WDSUB run landed **6 commits in ~3 hours**. An index taken once at setup is
stale by ticket three, so every later worker receives context describing a repo that no longer exists.
The staleness is **silent** — `buildContext` still returns something, so nothing looks wrong.

> ⛔ **Do NOT spawn a detached indexer.** That reintroduces the exact failure class [[B-WSPU]] deleted
> (~1000 LOC — detached workers silently died; the field evidence was a detached worker dying while
> building its own deletion). A background index racing `buildContext`'s 5 s query also fails
> *quietly*: the service degrades rather than crashes, so workers silently get thinner context.
> WS-CGEN-C is safe **only** because it runs in-process on the already-long-lived mux-runner.

### Prior art — it was ON before, and why it went off

`3bab38f2` (2026-06-14) flipped codegraph default-ON. `b5a4f5b0` (2026-06-16, **B-GA**) flipped it back
to opt-in — rationale verbatim: *"matching deployed reality."* **No defect forced it off**; it was a
source/deployed consistency fix during **2.0** GA-readiness. Re-enabling on the **2.1** line is
therefore coherent with that decision, not a reversal of a safety call. It ran default-ON for two days
with no recorded failure.

### Evidence status — the soak still matters

Codegraph **has** run: **91 `codegraph_context_injected`** + 19 `codegraph_sync_completed` across 5
sessions (2026-07-16/17), then silence once beta.3 turned the arm off. **All of it predates the
2026-07-18 B-CGHARD harvester fix**, so none of it measures the shipping configuration. Reuse the
probes that already exist: `codegraph-efficacy-probe.test.js`, `codegraph-index-cost.test.js`.
**Sequencing:** land #1–#7, then soak on the shipped base. Do not soak before the stack ships — a run
that stalls on an iteration cap and reads as "converged" measures nothing.

### Risks to own

- **Setup-time cost — corrected 2026-07-23, was overstated here.** `index_at_setup: true` costs up to
  `index_timeout_ms` (**120 s**) on every **non-resume** setup — i.e. one full index per pipeline
  launch, then `noop`/`sync` on resumes. For a 12-hour run that is ~0.3% overhead and is **not** the
  real problem. The real problems are WS-CGEN-A and WS-CGEN-B above: the freshness check never runs at
  launch, and the graph goes stale mid-run. `codegraph-index-cost.test.js` exists to bound the observed
  cost — pin it before shipping.
- **Native dependency.** `@colbymchenry/codegraph@0.9.9` is platform-specific and symlinked per-platform
  by `install.sh:473-491`. Confirm a missing/incompatible binary **degrades** rather than crashes
  (`codegraph-degradation.test.js` covers the degraded path) — turning this on by default makes that
  path load-bearing for every install, on every platform we ship to.
- **Surface being switched on:** 507 LOC service across 14 files in `src/`.

## ⚖ OPERATING PRINCIPLES (operator-set 2026-07-18, sharpened 2026-07-19 — BINDING, supersede prior framings on conflict)

**🎯 THE LENS (operator-set 2026-07-19, applies to EVERY item below):** the goal is **reliability
through LESS**, not reliability through more. Two directives, and they are the same directive:
1. **Reliability while REDUCING COMPLEXITY** — the fix that removes a mechanism beats the fix that adds
   one. A PRD whose `## Simplification Review` cannot name a subtraction is suspect. Net-negative LOC is
   the expected shape of a reliability fix here, not the exception.
2. **REDUCE BRITTLENESS** — every fix must leave the system *less* able to false-fail, not more. Adding a
   guard around a brittle guard makes both worse ([[feedback_analyze_failures_then_subtract_not_add_guards]]).
   When something false-fails, **subtract the ill-posed input**, do not add resistance around it.

**This session (2026-07-17→19) is the proof these two are one lens.** Every fix that shipped or queued was
a subtraction, and each removed a *class* of brittleness:
- **B-SSAT** — deleted the stale settings pin; R-WTFT stopped being inert (−1 pin, made 600_000 reachable).
- **B-CGHARD** — the harvester now emits fewer, real terms; an all-noise ticket emits *nothing* (−8KB junk).
- **R-SAFP** — deleted an audit category with an **11-findings / 0-real** lifetime record (net −144 LOC).
- **B-NONSTOP (queued)** — subtracts the five-dispositions-into-one-boolean `successfulReasons` list.
- **The defect class this session named 5×:** *a cap set below the real runtime is a guaranteed false
  failure, not a safety net* (worker gate 240s vs 402s suite; szechuan iter 50; runner timeout == soak;
  soak install 120s vs 95s; and the readiness-vs-convergence exits). **De-brittling = generous backstops +
  honest dispositions, never tighter caps.** See [[B-NONSTOP]] and
  [[project_release_gate_runner_timeout_equals_soak_duration]].

**What "reduce complexity" does NOT license (the B-GSUB guardrail):** subtraction is the DEFAULT, not a
mandate to strip earned signal. Do not delete a guard that fires correctly, and do not chase the
low-ROV clusters (the ~38-guard manager-loop and dead-pid triplication — the [[B-GSUB]] over-subtraction lesson). Reducing complexity means removing the mechanism that
*causes* false-fails, not removing the mechanism that *catches real ones*. When unsure which a given
guard is, the [[feedback_verify_the_outcome_not_the_mechanism]] test decides it: *has it ever caught a
real defect?* (R-SAFP's category: no, 0/11 — delete. R-CWGE's on-repo gate: yes — keep.)

Every queue item, PRD, and workstream is scored against these two, **in this order**:

### 1. Reliable autonomous NONSTOP operation
**The pipeline MUST NOT halt under any circumstance — it always continues.** A phase that cannot
finish its work runs its finalize gate over the work that *did* converge and hands off to the next
phase. Halting is never the answer; **an honest non-convergent continuation is.**

Three corollaries, each machine-checkable:
- **(1a) Caps are runaway backstops, not schedulers.** Iteration/time budgets must be **generous
  enough that a large PRD never hits them in normal operation**. Hitting a cap is an *anomaly to be
  reported*, not a routine exit path. Wall-clock (`max_time_minutes`) stays **opt-in / disabled by
  default** (already true). Iteration budgets are the binding caps today and are **too small** — see [[B-NONSTOP]].
- **(1b) A give-up MUST NEVER report as success.** Exiting on a cap, a stall, or exhaustion is a
  distinct, named, observable disposition — never `converged`, never "completed successfully."
  *Silence is not success.*
- **(1c) Nonstop and honest are NOT in tension — the machinery already exists.** Verified 2026-07-18:
  `shouldHaltAfterPhase` (`pipeline-runner.ts`) halts ONLY on a fatal failure or explicit
  `pipeline_continue_on_phase_fail:false`; the default `true` **continues on any non-zero exit**. And
  `anatomy_non_convergent` is the **shipped working template** — `pipeline-runner.ts:4086` states it
  outright: *"a non-convergent subsystem halt is a NON-FATAL phase end — run the finalize gate over
  the converged work and continue to szechuan, never abort."* ⇒ **An honest disposition does not cost
  us nonstop operation. Copy anatomy's pattern; do NOT reach for `exit 1`-to-halt.**

### 2. Quality — deslopping, tests, simplification
Convergent quality work (szechuan deslop, test strength, subtraction) is the second axis. It is
subordinate to (1): a quality phase that cannot converge **continues honestly**, it does not block
the run. Prefer the **subtractive** fix; a PRD's `## Simplification Review` is mandatory.

**Observability is the shared precondition for both.** We must be able to see **where** a run fell
short — which phase, which subsystem, which criterion, and whether it converged or gave up. Any fix
that improves a disposition MUST also make that disposition *visible in the artifact an operator
actually reads* (`pipeline-status.json` / phase summary / `state.json.activity`), not only in a log
line. A discriminant computed and thrown away is the defect, not the fix.

---

## Superseded planning strata (2026-06-30 → 2026-07-15) — swept 2026-07-24

The 2026-07-16/17 "STEP B / STEP A / do B then A" reliability-queue saga (incl. §A v2.0-GA-prep, the §B/§C source-grounded queue, the retracted INHERITED RED, the `worker_test_gate_timeout_ms` row), the B-1SEAM design record, the 2026-06-30 STRATEGIC SHIFT, the autonomous-dev scorecard, and the 2026-07-08 RESUME-HERE + B-FOMC TOP-ITEM region are all shipped/superseded. Full text in `MASTER_PLAN-archive.md` → "Swept 2026-07-24". Live queue = the SHIP STATE + NEXT STEPS blocks at the top of this file; binding north star = OPERATING PRINCIPLES above.

## Status

| Item | Value |
|---|---|
| Version (source ≠ deployed string) | **v2.1.0-beta.7** — B-NOSTOP-GATES + folded R-WDTF-TO (bump `50aa9a14`, gate at `62657aff`; released `gh release` prerelease 2026-07-26). **Deployed runtime carries the beta.7 CODE** (`install.sh` ran at `62657aff` mid-gate, WS-1 continue path / WS-2 `isZeroDiffScanBorrowExcluded` / WS-3 `ticket_auto_skip_no_evidence` verified live) **but its `package.json` still reads `2.1.0-beta.6`** — re-run `install.sh` to sync the string. Prior: beta.6 B-GTRUTH (`165a1a43`), beta.5 B-NONSTOP + B-WDSUB. Per-bundle detail: SHIP STATE block above. Full beta.3→6 (v2.1) and beta.33→47 (v2.0) release history: `git log` + `MASTER_PLAN-archive.md`. |
| Latest GitHub release | **v2.1.0-beta.6** (B-GTRUTH; prerelease). v2.0 ship line latest tag: **v2.0.0-beta.47**. |
| **Version lines (operator decision 2026-07-10)** | **TWO LINES.** `main` = the **v2.0** ship line (currently `2.0.0-beta.NN`, hardening to v2.0 GA on the reliability queue — R-WGFR first). Branch **`release/v2.1-beta`** (renamed 2026-07-16 from `experiment/fable-operating-manual`; local+remote+docs cutover, old remote deleted) = the **v2.1 beta** line (`2.1.0-beta.2`): FOM manual + all-surface prompt infusion + W5b sig-gap demotion; ship-review-validated (3 modalities, ~90 agents, 2 P1 + 4 P2 found-and-fixed, test:fast 6673/0). v2.1 merges to main only after v2.0 GA. **Cherry-picks LANDED on main 2026-07-10** (operator-approved; byte-exact with branch, merge auto-resolves; main test:fast 6669/0 post-pick; unpushed, deploys at next install.sh/beta.45): `477e1916` pickle-retry blind-stash→verify-and-commit + step-2/3 gate; `aa286a9b` config-protection R-WSRC-GR block message; `c8f00119` recovery-matrix `--flag` forms + pipeline/tmux `--max-time` opt-in + stale defaults + env-var StateManager recipe. Deliberately left for v2.1: dead PRD/spec path refs (CLAUDE.md/AGENTS.md/COMMANDS.md/README.md/persona.md). **CROSS-LINE SEQUENCE (operator-ratified 2026-07-11; updated post-①/② revalidation):** ✅ **① R-WGFR SHIPPED (subtractive) both lines** (v2.1 `ebb33a6c` + main back-port `cad28cb2`, unpushed; recompute verifies eslint+tsc only) → ~~② B-CSOR~~ **DE-QUEUED as stale/obviated** (revalidation 2026-07-11: the graduated-remediation core is already SHIPPED at beta.11 — `750e3f58`, #118 struck; `mechanical-finding-classifier.ts` + the `remediable ∪ mechanical` union are live in `executeCitadelPhase:2733-2738`. The remaining "citadel commits its own remediation" residual is obviated by [[R-MPGD]] WS-1's `preflightAutoCommit` (commits the dirt downstream) and its safety-net can't be fully subtracted [worker-timeout-rescue arm stays], so building it would ADD a commit without a clean subtraction — against simplify-first. The autofix-instead angle is blocked: brace-free-`if` is not default-eslint-autofixable, which is WHY #118 exists) → **▶ NEXT: ③ [[B-CGPROBE]]** BUILD via pipeline with working_dir = v2.1 checkout (deploy-agnostic, dual-purpose: dogfoods the fable prompts) → ④ v2.0 GA on the soak streak → ⑤ B-CGPROBE RUN in a codegraph-enabled window (needs the deploy; post-GA) → ⑥ [[B-CGCAP]] verdict: flip / subtract / stay-opt-in → ⑦ v2.1 merge to main + deploy (FOM infusion + codegraph verdict ship together) → ⑧ [[R-RWNF]] decision (wire the dead review seam OR judge-panel at Done-flip — the in-loop verification architecture) → ⑨ [[B-GIMA]] (v2.2), contingent on ⑥'s verdict. P3 residuals (R-FOMH, R-TCVC+R-HNCG bundle, monitor-TUI subtraction) drain opportunistically as rep payloads. Constraint driving the order: ONE deployed runtime — v2.0 soak reps and the v2.1 probe RUN both need it and must not perturb each other; builds are deploy-agnostic and interleave freely. |
| Test-hygiene follow-ups | ✅ **BOTH SHIPPED beta.30 (B-RELHYG).** (1) hardcoded-date fixture time-bombs — audited all 35 fixtures, **zero genuine wall-clock time-bombs** (only beta6-ga-session-resume ever qualified, already fixed); durable audit record `84464f6f`. (2) R-OMTD afterEach subprocess reap `b9bccd1a`. |
| Subsystem CLAUDE.md audit | ✅ OK (2026-05-23, `93fd5690`) — `extension/src/bin/CLAUDE.md` + `extension/src/services/CLAUDE.md` each carry a module export catalog bringing subsystem audit coverage above the script threshold. |
| Codex backend | `gpt-5.4` |
| Gate posture | Ship on the **local** gate (tsc + eslint + audits + fast-c4 + integration + expensive). **CI-green = hygiene, never a release gate.** |

**Directives.** Drain bugs before features, P1 > P2 > P3. The babysitter drains the entire plan
with **zero operator interaction**, including the full release cycle (`git push` + `gh release
create`), gated only on a green local gate + clean tree. Sole permitted residue: external-event-
gated work. Every bundle PRD carries a `## Simplification Review` (subtract-before-add) — see
[`CLAUDE.md`](CLAUDE.md). **Log every real incident as a bug-PRD in `prds/` + a drain row** (the
loop-failure directive).

---

## ▶ Governing strategy (2026-06-23): Reliability Plan — resolved; pointer only

**`prds/RELIABILITY-PLAN-2026-06-23.md`** reframed the queue as **5 structural meta-defects**
(completion-oracle plurality · scope-fence under/over-extend · recovery sprawl · guards-on-guards ·
self-build trap) — 4-of-5 substantially shipped (see track B above); the residual is the operator-scoped
recovery-sprawl seam-collapse. The full beta.23 build/deploy narrative, the shipped REMAINING list, and the
GA field-soak proof ledger (claude: 2 clean hands-off incl. the multi-ticket additive B-RPGT run; codex:
completion-evidence PROVEN, LOA-1363 run 4) are preserved in
[`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) → "Swept 2026-07-02". The live GA bar is N bundles hands-off in a row, both backends — see the SHIP STATE + NEXT STEPS blocks at the top of this file.

## Drain Queue — shipped + remaining (deferred / blocked / external-gated)

> **⚠ NEW (2026-07-14) — two findings surfaced BY the B-FOMC run itself, both about not knowing the ground was red:**
>
> | Finding | Pri | What | PRD |
> |---|---|---|---|
> | [[R-WGVI]] | **P1** | **The worker gate verdict carries no information about the ticket.** A `small`-tier ticket **skips `test:fast`** (`extension/src/bin/spawn-morty.ts:1405`) and persists `worker_gate_verdict: "green"` — a **vacuous green** while the tier was actually RED (`a460cad3`, measured). A `medium`-tier ticket runs the **whole** tier, so it goes **red for inherited debt it never touched**, and flipped **Done over red** anyway (`c4ee67ff`, `worker_gate_verdict: "red"` + `status: "Done"`). Green can mean "never ran"; red can mean "someone else's". **Fix = REUSE `convergence-gate.ts`'s baseline subtraction** (judge the delta vs `start_commit`), and never emit `green` from a gate that did not run (`"not_run"`). ⛔ Do NOT add a skip flag; do NOT fail-closed on raw red (it would deadlock every ticket on inherited debt). | `BUG-REPORT-2026-07-14-worker-gate-verdict-is-information-free.md` |
> | [[R-PLGR]] | P2 | **The mandated pre-launch check asks "is the fix still needed?" and never "is the tree green?"** B-FOMC's stale-premise check passed cleanly and the branch was **already red** (`extension/CLAUDE.md` trap-door entry 1662 chars vs a 1500 cap, over-cap since `69829ec5`; on the release gate via `trap-door-conformance.test.js` + `audit-trap-door-enforcement.sh`). **R-PLGR is what put the red there; R-WGVI is why nobody could tell.** Fix = a **doc-only** green-tree precondition in `prds/CLAUDE.md` + record the launch-commit tier result as the baseline R-WGVI subtracts. ⛔ NOT a blocking launch gate (it would false-block on the ENOBUFS flake already in that tier). | `BUG-REPORT-2026-07-14-prelaunch-check-never-asks-if-the-tree-is-green.md` |
>
> **The poetry, recorded because it is evidence and not a joke:** `a460cad3`'s vacuous green is a live violation of
> the exact rule that ticket's own bundle shipped — *"Silence is not success. A fast clean pass may mean the gate
> never fired, not that it passed."* (`FOM_HONEST_REPORTING_RULES`). The runtime that built the honesty bundle
> violated the honesty bundle, in the same session, while the ink was wet.
>
> The pre-existing trap-door red itself is **FIXED** (`ff584d84` — compressed 1651→1433 chars, no constraint dropped;
> `trap-door-conformance` 177/177, audit PASS).
>
> **STATUS UPDATE (2026-07-15, babysitter drain loop):**
> - **[[R-PLGR]] ✅ SHIPPED** (`a67ca3d6`) — green-tree precondition added to `prds/CLAUDE.md`'s pre-launch protocol
>   (run `test:fast` on the launch commit; red = HARD STOP; doc-discipline, not a blocking gate).
> - **[[R-WGVI]] — POLICY APPROVED + REFINED, build-ready, ATTENDED build deferred.** Operator approved the
>   subtractive parity (drop `test:fast` from the worker-gate writer → eslint+tsc). On hand-build the scope proved
>   bigger than framed (2 release-gate trap-door invariants + ~10 tests, R-PSRB Done-flip subsystem), so refine-first
>   was run (session `70dc13b8`, citations hand-verified). **Refinement found the approved fix INCOMPLETE:** THREE
>   verdict writers exist — `extension/src/bin/spawn-morty.ts:1608`, `extension/src/bin/mux-runner.ts:4658` (already eslint+tsc), and
>   `mux-runner.ts:4988 persistRunnerAuthoredGreenVerdict` = **UNCONDITIONAL green** (scoped as a documented
>   Non-Goal). Reshaped ACs **AC-WGVI-P1..P6** committed (`80b0c20a` + scope `d70be6c8`) supersede the rejected
>   `not_run`/baseline AC-WGVI-1..4. `red`+`Done` via a Done-*flip* is unreachable on HEAD (Done callsites
>   green-gated); `c4ee67ff` was a write-after-Done relabel → AC-WGVI-4 → temporal invariant AC-WGVI-P5. **Routing:
>   ATTENDED `/pickle-pipeline`** *(updated 2026-08-04: was "attended hand-build, NOT pipeline"; the
>   hand-build exception is deleted — see `CLAUDE.md` → "NEVER hand-build")*. **North-star: self-build-only
>   (inert on target repos) — real but not autonomy-urgent, hence deferred.**


> **Consolidating bundle authored (2026-06-26):** [[R-DPGT]] + [[R-DOTR]] + [[R-CRSR]] (Facets A+B) + the LOA-1588
> foreign-hash sub-finding are one wound — the **pickle phase-exit / per-ticket-budget boundary does not read the
> single `readEvidence` oracle.** PRD: `archive/bundles/p2-bug-fix-bundle-b-pxbo-phase-exit-boundary-oracle-2026-06-26.md`
> (**B-PXBO**, reuse-first, no new oracle/state). ⚠️ **SELF-MODIFYING-RECOVERY (R-PSRB)** — the
> mux-runner/completion-evidence tickets run **ATTENDED**, watching the salvage seam; a wedge is recovered
> and recorded, not dodged *(updated 2026-08-04: was "hand-build … cannot run a clean autonomous
> pipeline")*. **R-SIGF stays a separate
> parallel track** (scope-fence auto-extension — different subsystem, the other codex GA blocker).

| # | Item | Pri | State | Source |
|---|------|-----|-------|--------|
| R-SJLAGMT | **R-SJLAGMT** — `extension/tests/sjlag-state-heartbeat.test.js:60` asserts `mtimeAfter >= mtimeBefore` on `fs.statSync(...).mtimeMs`, a **float** millisecond derived from the filesystem's nanosecond timestamp. When both stat calls land inside the same millisecond, the float conversion does not preserve ordering and a `>=` on non-decreasing wall-clock time can read as FALSE. Observed 2026-08-15: `state.json mtime must advance: before=1786814171970.9998 after=1786814171970.999` — same millisecond, "after" smaller by 0.0008 ms. Confirmed **flaky, not deterministic**: `fail 1` on one run, `fail 0` on a clean re-run of the same tree (`7647 tests, 504 suites, fail 0, cancelled 0, 835042 ms, EXIT=0`). Pre-existing — the test shipped with `24cb85d0` (R-SJLAG), NOT with any 2026-08-15 bundle, so it has been failing at a low rate since. Fix = compare `fs.statSync(path, {bigint: true}).mtimeNs` (BigInt, lossless) or assert with an explicit tolerance; do NOT relax the assertion to `>` or delete it — the heartbeat it guards is real. | P2 | 🆕 **FILED 2026-08-15, unbuilt.** Costs a full ~800 s tier re-run each time it fires, and it fires with `cancelled 0`, so it reads as a genuine red rather than an obvious flake. | tier logs at `a5edb12f` (fail 1) vs the clean re-run (fail 0) |
| R-TIERWEDGE | **R-TIERWEDGE** — an operator-run `npm run test:fast` can **wedge at zero CPU** rather than fail or finish. Observed 2026-08-15 on `a5edb12f`: log frozen at 6138 lines for 8+ minutes, ~12 min elapsed against a ~730 s baseline, and the whole tree parked — runner `bin/test-runner.js` at `0:00.10` CPU unchanged across a 20 s sample, its child at `0:02.68` unchanged across 25 s, its grandchild at `0:00.47` over 10:47. No summary block is ever emitted, so a wedged run cannot produce a false green — but it also never returns, and `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` means a naive waiter blocks for 2 h. Same 0-CPU shape as the post-completion gate wedge, but here under a PLAIN operator tier with no worker gate involved, which widens the class. Recovery: kill the tree by pid (`kill -9` leaf-up) and re-run — the re-run completed normally, so the wedge is intermittent. **Operational rule: any wait on a tier run needs a STALL detector (no log growth for N minutes), not a timeout.** | P2 | 🆕 **FILED 2026-08-15, unbuilt.** Recovery is mechanical and costs one full tier re-run. | tier run at `a5edb12f`, process census 2026-08-15 12:31-12:40 |
| R-GBANNER | **R-GBANNER** — the between-ticket / cross-ticket gate's failure parser reports an **npm lifecycle BANNER line as a failing test name**. Observed verbatim failure entry: `{ "name": "> pickle-rick-scripts@2.1.0-beta.9 pretest:fast", "file": "" }` — a `> pkg@ver script` echo line, with an EMPTY `file`, which is the tell. Seen in **two independent sessions**: `2026-08-14-0807d986` (as `cross_ticket_regression_detected`, attributed to `prior_ticket_id: 70a67ccb` — a ticket that had already shipped clean) and `2026-08-15-b88a6603` (as `last_between_ticket_gate.ok: false`, `timed_out: false`, 1 failure, for `d35f4c61`). So it is systematic, not a one-off. Two distinct harms: (1) the "failing test" name is unactionable, so a manager handed this list dispatches a worker at a phantom; (2) the cross-ticket variant **attributes it to the wrong ticket**, manufacturing a regression against work that is already green. Underlying red is real but transient — `pretest:fast` is `audit-test-tiers.sh && audit-test-isolation.sh`, which react to mid-flight worker files; both exited 0 on demand minutes later. Fix = when a parsed failure has an empty `file` AND the name matches the `^> \S+@\S+ \S+$` npm banner shape, attribute the failure to the SCRIPT (a pretest/audit failure) rather than emitting it as a test, and never let it seed a cross-ticket attribution. | P2 | 🆕 **FILED 2026-08-15, unbuilt.** Both sightings were non-fatal — the phantom-Done watcher kept the affected tickets on valid completion-commit evidence, so the gate parked rather than stopped. Harm is misdirection, not a wedge. | sessions `2026-08-14-0807d986` (`cross_ticket_regression_detected`) + `2026-08-15-b88a6603` (`last_between_ticket_gate`) |
| R-NOPOSTTIER | **R-NOPOSTTIER** — **no phase measures the tier AFTER a bundle's final commit**, so a run can pass every per-ticket gate and hand back a red tree. Demonstrated end-to-end 2026-08-15: session `2026-08-15-b88a6603` reported **8/8 Done, `EPIC_COMPLETED/all-tickets-done`, `exit_reason: completed`**, and its LAST commit `1bead552` (the bundle's own cross-reference audit ticket) expanded the R-WTFT trap-door entry at `extension/CLAUDE.md:191` to 1831 chars against the 1500 cap at `extension/tests/trap-door-conformance.test.js:15`. Operator-run clean-env tier at that commit: **7647 tests, fail 3, cancelled 0, EXIT=1** — three failures, one root. Nothing in the run was positioned to see it: the between-ticket gate runs BETWEEN tickets (there is no ticket after the last one), and per-ticket conformance is scoped to that ticket's own diff. This is the standing lesson with a mechanism attached: *a per-ticket ALL_PASS verdict is not a tree verdict.* Note the aggravating shape — the reddening commit was a DOCS commit from an AUDIT ticket, the class least likely to be suspected. Fix candidates: run one tier measurement after the final ticket flips Done and BEFORE synthesizing `EPIC_COMPLETED`, recording the verdict in the completion promise (report-only — per the no-stop-gates rule it must NOT block the epic, only withhold the success verdict); or extend the existing closer to own it. | P1 | 🆕 **FILED 2026-08-15, unbuilt.** Recovered by launching a fix bundle (`eff4ccbd` PRD → `a5edb12f`, 1831 → 1448 chars, cap untouched); no hand-build. Until built, EVERY bundle's green needs an operator-run tier measurement to be believed. **▶ 2026-08-16, ticket `4a25e6ca`: the fix bundle's own tier is MEASURED GREEN at `c688f9ab` — 7707 tests, 507 suites, pass 7704, fail 0, cancelled 0, skipped 2, todo 1, 1442185 ms, `EXIT=0`**, clearing both the measured 5899 floor (`5dba30c5`) and the retracted 7647. The `BUG-2026-08-16-post-final-measurement-wedges-the-tier` nested-tier hypothesis is **FALSIFIED**: both seams (`extension/src/bin/mux-runner.ts:708`, `:941`) return early unless `<working_dir>/extension` exists and that guard predates the bundle, while every `mux-runner.test.js` working dir is a bare `mkdtempSync` — the nested tier could not have fired from that file. The `e57bac7a` wedge was real but belongs to `R-TIERWEDGE`, not to this seam; the run walked through the old 6126-line wedge point (`mux-runner: exits with code 1 and prints Usage when no args provided` passes at line 6132) to 14089 lines. | session `2026-08-15-b88a6603`; tier logs at `1bead552` (fail 3) and `a5edb12f` (fail 1, unrelated); `c688f9ab` tier log 2026-08-16 |
| R-GENVL | **R-GENVL** — a gate run inherits the manager/worker process env, and `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` (exported by the mux manager, `1800000` in the observed session) is read by `resolveWorkerTestFastTimeoutMs` at TEST time, so the whole `worker_test_gate_timeout_ms` cluster asserts against the leaked value instead of the compiled default. Measured 2026-08-14 (session `2026-08-14-0807d986`, iteration 10): the same tree ran **EXIT=1 with 8 failures** with the variable present and **EXIT=1 with exactly 1 failure** after `env -u PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` — 7 of 8 failures were pure contamination (`settings-loader` ×2, `runWorkerGate`, `showStatus`, `mux-runner-between-ticket-gate` ×2, `install.sh MANAGED_KEYS force`/`AC-SSAT-4`). Same family as the deployed-trailer-hook contamination (`env -u PICKLE_TICKET_ID -u GIT_CONFIG_*`) — a manager that runs the tier on a worker's behalf reads a **false red** and then hands the worker a fabricated fix list. Fix candidates: scrub the pickle env in the gate spawn (reuse the existing trailer-env scrub seam), or make the resolver ignore the env under `NODE_TEST_CONTEXT`. | P2 | 🆕 **FILED 2026-08-14, unbuilt.** Measured on `release/v2.1-beta` @ `f0fb36cf`; no code written. Manager workaround in use: `env -u PICKLE_WORKER_TEST_FAST_TIMEOUT_MS -u PICKLE_TICKET_ID -u GIT_CONFIG_*` before any manager-run `npm run test:fast`. | session `2026-08-14-0807d986` iteration 10; `/tmp/gate-063b991c.log` (dirty, 8 fails) vs `/tmp/gate2-063b991c.log` (clean, 1 fail) |
| R-WGTORPH | **R-WGTORPH** — `tests/spawn-morty-worker-gate.test.js` spawns REAL `npm run test:fast` runs through a temp shim (`$TMPDIR/pickle-spawn-morty-worker-gate-*/bin/npm`), and when the test's own timeout path fires the shim child is **re-parented to pid 1 and never reaped**. Live census 2026-08-14: **13 orphaned gate runs**, ages `03:00:22` to `02-01:10:22` (>2 days), all `ppid 1`, all still resident — permanent CPU oversubscription that makes every subsequent real gate slower and pushes the timeout-shaped suites (`runGate`, hang-guard, between-ticket-gate) toward flake. The existing `orphan-reaper.ts` (R-CXHANG) targets worker *procs* by `--add-dir` ownership and does not match these shims; `mux-runner-orphan-test-runner-reaper.test.js` covers the runner, not the worker-gate shim. Fix = extend the reaper's positive-ownership match to the `pickle-spawn-morty-worker-gate-*` temp-prefix (min-age gated), or kill the shim's process group on the test's timeout path. | P2 | 🆕 **FILED 2026-08-14, unbuilt. ESCALATED 2026-08-15 by an independent census — two facts the original row got wrong.** (1) **The reap did not hold.** A census taken AFTER the run's hand-reap found **13 orphans still resident**, ages `01:58:42` to `02-03:56:21` (>2 days) — so either the reap missed or the leak re-accumulated inside one session. Either way the row's "13 reaped by hand" cannot be read as "currently clean". (2) **They resist SIGTERM.** A plain `kill` on all 13 (ppid==1 verified per pid) reported success and changed nothing — a re-census 25s later showed the same 13 pids with ages advanced. `kill -9` took all 13 immediately. So a reaper that sends SIGTERM and assumes death will silently leave the leak in place; the fix MUST escalate to SIGKILL and then VERIFY by pid, never trust the kill's return. Operational note: they contend with any concurrent `test:fast` — the 2026-08-15 tier measurement ran its first ~12 minutes against all 13 and still landed on baseline (734742 ms), so the contention cost is real but not the dominant term. | session `2026-08-14-0807d986` iteration 10 process census; independent re-census + SIGTERM/SIGKILL escalation 2026-08-15 |
| R-MPVU | **R-MPVU** — the manager prompt ships `${EXTENSION_ROOT}` **unbound**, so the manager has to guess where `spawn-morty.js` lives. `extension/templates/_pickle-manager-prompt.md:142` emits `node "${EXTENSION_ROOT}/extension/bin/spawn-morty.js" …`; the delivered prompt carries **8 literal `${EXTENSION_ROOT}` + 28 literal `${SESSION_ROOT}`**, `grep EXTENSION_ROOT mux-runner.ts` is **zero hits**, and `backendEnvOverrides` (`backend-spawn.ts:819`) does not add it — nothing in the process tree defines it. **Claude infers the path and proceeds; codex searches the filesystem** and binds `~/.codex/pickle-rick` (v0.2.17-beta.3, `STATE_SCHEMA_VERSION=1`), whose different v1 CLI it adopts verbatim from the usage string, then dies on `State schema 5 … newer than supported 1`. Failure is a **polite no-op** — queue check completes, `<promise>I AM DONE</promise>`, iteration bumps, no fatal, no `exit_reason` — so it looks like progress. Live: session `2026-08-03-2d5b3820`, 2 iterations, ~38K codex tokens each, **zero artifacts**. **The fix is already written and unwired:** `getExtensionRoot()` (`pickle-utils.ts:301`) resolves `CANONICAL_EXTENSION_ROOT` (`:221`) and sentinel-validates overrides (`:222`) — and the sentinel **rejects** `~/.codex/pickle-rick` (`log-watcher.js` ABSENT) while accepting `~/.claude/pickle-rick` (PRESENT). WS-1 substitute at render time (backend-agnostic; preferred), WS-2 export via `backendEnvOverrides`, WS-3 fail loud on an out-of-root `spawn-morty.js`. Pipeline-safe (not R-PSRB). **The foreign install is a contributing factor, not the bug** — removing it only changes which way the guess fails. | P2 | 🆕 **FILED 2026-08-03, unbuilt.** Blocks `--backend codex` entirely (100% failure at first worker spawn); claude unaffected. One premise unmeasured — that Claude resolves by inference (AC-MPVU-4 measures it; if Claude also mis-resolves, priority rises). Workaround (unverified): export `EXTENSION_ROOT` + `SESSION_ROOT` before launching the runner. **Build on claude — this bundle cannot build itself on codex.** | PRD `p2-bug-fix-bundle-r-mpvu-manager-prompt-extension-root-unbound.md`; session `2026-08-03-2d5b3820` `tmux_iteration_1.log` |
| R-WGFR | **R-WGFR** — the between-ticket worker-gate verifies with a SINGLE raw `npm run test:fast` (`extension/src/bin/mux-runner.ts:638`; `recomputeAbsentWorkerGateVerdict` `:4593`), so a c=8 timeout-flake (R-CIFB, amplified by codex R-CXHANG/R-SLEAK orphan contention) yields a false-red verdict and R-CWGE fail-closes **fatal on a GREEN bundle** (killed the R-LTNC codex soak 0/4; tree proven green via `test:fast:budget` 5/5). **RESOLVED BY SUBTRACTION (not the additive c=4 path).** Refinement (3 analysts) proved the additive `test:fast:gate`@c=4 fix carries a 5-file blast radius (schema `const`, `pretest:fast` hook, 2 command-pin tests) AND doesn't close the class (single run vs unchanged 600s timeout; the release gate resists flake via a repetition **budget**, not c=4). Call-graph: the ONLY green-bundle-fatal path is the Done-flip guard's absent-verdict recompute (`recomputeAbsentWorkerGateVerdict`); its eslint+tsc dimensions are deterministic, only `test:fast` flakes, and that run is redundant with the next worker gate + the closer. Fix = **subtract**: recompute verifies eslint+tsc only. Preserves B-CWGE's lint/tsc-RED-behind-passing-test protection; genuine boundary test-red → closer (quality #3). Pipeline-safe (gate-verdict seam, NOT R-PSRB). | P2 | ✅ **SHIPPED (subtractive) 2026-07-11 on BOTH lines.** v2.1 branch `ebb33a6c` (dogfooded /pickle-pipeline 4/4 phases 32m, closer-verified). Back-ported to `main` (v2.0) `cad28cb2` (byte-identical sites, recompiled on main). Core release gate GREEN on branch (tsc+eslint+9 audits+test:fast:budget+integration 489/0); `worker-gate-verdict-recompute.test.js` 3/3 both lines. **Unpushed both lines (operator holds push); expensive deploy-soak tier deferred to release-tag time.** WS-2 (R-CXHANG `codex app-server` reaper) DEFERRED — contention amplifier, not root; tensions with the positive-ownership invariant (R-MPGD WS-2 precedent). | `BUG-REPORT-2026-07-08-worker-gate-single-flaky-testfast-false-red-fatal.md` + PRD `p2-bug-fix-bundle-r-wgfr-worker-gate-single-flaky-testfast-false-red-fatal.md` |
| B-1SEAM | **B-1SEAM** (P1) — collapse the 3 asymmetric-fix siblings into single seams (R-AICF + R-PSCG + R-MACB). | P1 | ✅ **BUILT 2026-07-02** (ultracode hand-build on claude per R-PSRB): WS-1 `7b52789d` (ONE predicate `evaluateCompletionEvidence`, all 8 decision sites routed, call-site audit pinned, spawn-morty verified-sha + `Pickle-Ticket` trailer reconciliation), WS-2 `2bbf5770` (`healPipelineRequiredFields` symmetric self-heal), WS-3 in `885efb73` (ONE dirty-tree salvage seam, empty-excludes sweep deleted). Premise correction: the R-AICF flag attribution was impossible (flag deleted beta.23) — see `SIMPLIFICATION-AND-FIX-PLAN-2026-07-02.md`. Ships in beta.37. | 3× `BUG-REPORT-2026-07-02-*.md` + the plan doc |
| R-CXHANG | **R-CXHANG** (codex orphaned-worker-proc reaper). | P2 | ✅ **BUILT 2026-07-02** (`885efb73`): `services/orphan-reaper.ts` — positive-ownership-mandatory reap (argv `--add-dir` under sessions root + owning session not-live), min-age 600s, SIGTERM→SIGKILL escalation, `PICKLE_ORPHAN_REAP=off`, both prior negative-PID kill sites collapsed onto shared `killProcessGroup`. Ships in beta.37; PRD archived. | `archive/bundles/p2-bug-fix-bundle-r-cxhang-codex-orphan-proc-reaper-2026-07-01.md` |
| B-RSHM | **B-RSHM** subtraction — stop-hook dead-code + chain_meeseeks retirement. | P2 | ✅ **BUILT 2026-07-02** (`885efb73`): stop-hook non-tmux continuation/checkpoint/degenerate-nudge/session-end machinery deleted (idle-backoff + update-check + tmux-passthrough KEPT); whole chain_meeseeks subsystem retired (transitionToMeeseeks, ~15 template branches, MonitorMode, settings, 2 command files; `morty-reviewer` agents + `meeseeks_pass` event untouched; no schema bump). Ships in beta.37; PRD archived. | `archive/bundles/p2-subtraction-retire-stophook-deadcode-and-chain-meeseeks-2026-07-01.md` |
| R-PSAM | **R-PSAM** (Pickle Standup Author-`@me`) — `/pickle-standup` Step 2.5 commit scan uses `git log --author="@me"`, which git never resolves (it's a `gh` idiom); the author filter matches nothing so every un-PR'd local-branch ticket is silently dropped from Y:. Proven on LOA-1570: `@me`→0 commits, real email→28. Fix = resolve `@me` to `git config user.email` per-`$repo` in the `git log` line only (leave the `gh pr list --author "@me"` lines). Prompt-only change in `.claude/commands/pickle-standup.md`. | P3 | ✅ **SHIPPED v2.0.0-beta.38** (2026-07-03, B-SCOPESEED WS-2 `219f0a3d`, clean codex pipeline): Step 2.5 resolves `git config user.email` per-`$repo`; `gh pr list --author "@me"` lines unchanged; empty-identity guard added. | `BUG-REPORT-2026-07-01-standup-git-author-me-drops-local-branch-tickets.md` |
| R-SSPB | **R-SSPB** — on-`main` `--scope branch` mis-scopes the PICKLE phase to the pre-build diff (the build's own commits don't exist at setup → workers fenced out of their own target files; the review-phase scope refresh is correct). Fix = seed the pickle-phase branch-scope from the ticket file-impact set. | P3 | ✅ **SHIPPED v2.0.0-beta.38** (2026-07-03, B-SCOPESEED WS-1 `621ce1b2`): `setupScope` seeds an empty/pre-build branch scope from the ticket file-impact set (`persistSeededBranchScope` + `pipeline-scope-ticket-seed.test.js`); review-phase refresh + scope-resolver fail-closed invariants untouched; anatomy-park self-hardened the new test (`41e554bc`). | B-SIGFH soak findings + `archive/bundles/p3-bug-fix-bundle-b-scopeseed-rsspb-rpsam-2026-07-02.md` |
| R-SZGB | **R-SZGB** — szechuan per-iteration gate CONVERGED over tsc-RED commits: the Small-Functions pass shipped 5 tsc errors + 1 eslint error + 3 broken source-pin tests + compiled-JS drift, all invisible until the closer's full gate. ✅ **Mechanism VERIFIED 2026-07-04 (Hypothesis 2)** vs session `2026-07-02-b3c45331`: repo-root target → `detectProjectType` (single-dir, no walk) → null → `emitSkippedAndReturn` persists EMPTY baseline (`project_type:null, checks:[]`) → replay subtracts vs zero checks → tsc-RED converges clean; anatomy-park shared it. Fix = WS-1 bounded package-root resolution + WS-2 fail-CLOSED on an uncertifiable baseline; reuse-first via `runGate`, no new gate/flag/state field. | P2 | ✅ **SHIPPED + DEPLOYED v2.0.0-beta.39 (2026-07-05, claude, dogfooded /pickle loop + closer).** WS-1 R-SZGB-A (`e284c7ca`, bounded package-root walk). WS-2 R-SZGB-B (`cceef8b4`, fail-CLOSED on `project_type:null` uncertifiable baseline via `runChangedPerIterationGate` — covers BOTH per-iteration replay + worker-managed convergence seams). Follow-up **[[R-SZGB-C]]** folded in same release. Full release gate GREEN (tsc+eslint+all audits+test:fast:budget+integration+expensive); closer reconciled stale R-APBN-5 integration test (`81812857`) to landed root-resolution behavior; deploy parity verified. **Remaining: the live-proof `/szechuan-sauce` over a known-RED tree / R-SIGF diff (track C.5) to demonstrate the fixed gate now bites.** | `BUG-REPORT-2026-07-03-szechuan-periteration-gate-converges-tsc-red-commits.md` + PRD `p2-bug-fix-bundle-r-szgb-periteration-gate-fail-open-2026-07-04.md` |
| R-SZGB-C | **R-SZGB-C** (follow-up surfaced by R-SZGB-B code review, session `2026-07-05-5865291f`) — the WS-2 uncertifiable-baseline defer does NOT set `selfRedOpen: true`, so `handlePostConvergenceGateDeferral`'s existing "never force-converge by attrition" latch (`microverse-runner.ts:3667-3681`) does NOT protect this class. A target that stays uncertifiable across ≥`POST_CONVERGENCE_GATE_DEFERRAL_LIMIT` (3) consecutive worker-signaled-convergence iterations will silently converge despite a tsc-RED tree — the exact defect R-SZGB-B closes for the single/few-iteration case, reopened at iteration 3+. Fix = set `selfRedOpen: true` on the uncertifiable-baseline defer path (`handleWorkerManagedIteration`'s `iterationLeftRegression` branch, `:1173-1184`) so the existing attrition latch engages — REUSE the existing latch, no new state field/gate. Pipeline-safe (gate-decision seam, NOT R-PSRB salvage path). | P2 | ✅ **SHIPPED + DEPLOYED v2.0.0-beta.39 (2026-07-05, claude, dogfooded /pickle loop).** Fix `80ec8ab8` (R-SZGB-C-A) threads the uncertifiable-baseline defer signal through `runPerIterationGateHook` → `handleWorkerManagedIteration` return contract so it sets `selfRedOpen:true`, arming the existing `postConvergenceSelfRedOpen` latch; +367-line test. PRD `p2-bug-fix-bundle-r-szgb-c-uncertifiable-baseline-attrition-latch-2026-07-05.md`. | R-SZGB-B `code_review_2026-07-05.md` (session `2026-07-05-5865291f/93ea5281/`) |
| R-SZGB-D | **R-SZGB-D** (surfaced by the R-SZGB live-proof, session `2026-07-05-9fb9a10b`) — convergence-gate `typecheck` check is INERT on repos with no `typecheck` npm script. `gate-commands.json` hardcodes `npm.typecheck = "npm run typecheck"`; pickle-rick's `extension/` typechecks via `npx tsc --noEmit` (no such script), so the check errors `Missing script` and NEVER runs tsc. In per-iteration baseline/replay the identical "Missing script" failure subtracts to zero → tsc-RED still escapes even after R-SZGB-A resolves `extension/`. Same fail-OPEN *class* as R-SZGB-B, one level down (per-CHECK, not per-PROJECT). `lint`/`test` checks DO run (scripts exist) — only tsc-RED escapes. Fix (reuse-first): (1) per-check fail-CLOSED — an unrunnable/"missing script" check makes the baseline uncertifiable for that check (reuse R-SZGB-B machinery); AND/OR (3) add `"typecheck": "tsc --noEmit"` to `extension/package.json`. Pipeline-safe (gate-decision seam, NOT R-PSRB). | P2 | ✅ **SHIPPED + DEPLOYED v2.0.0-beta.40 (2026-07-05, claude, dogfooded /pickle loop + closer).** Option-1 general fail-closed `46900269` (`isUnrunnableCheckResult` threaded `runGateCheck → collectGateFailures → runGate → handleBaselineMode`, reuses R-SZGB-B `project_type:null` uncertifiable refusal, +2 tests, 3 adjacent tests reconciled by the loop). Option-3 `typecheck` script `c5c7125f`. Full gate green; loop self-recovered a wedged worker mid-build. Completes the R-SZGB fail-OPEN closure at per-check granularity. PRD `p2-bug-fix-bundle-r-szgb-d-unrunnable-check-fail-closed-2026-07-05.md`. | `BUG-REPORT-2026-07-05-gate-typecheck-cmdmap-inert-on-missing-npm-script.md` |
| R-MPGD | **R-MPGD** (field-surfaced 2026-07-06, LOA-1570 Phase-5, session `2026-07-05-f923a9c4`) — microverse dirty-tree auto-commit/rescue gates on `fs.existsSync(path.join(workingDir,'.git'))`, a naive direct-child `.git` test that false-negatives on a monorepo package subdir (git root one level up), worktrees, and submodules. TWO sites: `preflightAutoCommit:2935` (throws → whole phase aborts at setup, `pass_counts:0`) AND `autoRescueDirtyTree:3619` (returns → silently discards a timed-out worker's dirty in-scope output). So on any monorepo-subdir run, CITADEL leaves uncommitted remediation ([[B-CSOR]]) → anatomy-park + szechuan abort <1s and `pipeline-runner` logs both "completed successfully" (`:4137`, `skipped_phases:0`) — silent deletion of the two most expensive review phases on a green ledger. Fix (reuse-first, net-subtraction): D1 extract ONE shared `isInsideWorkTree(dir)` helper (`git rev-parse --is-inside-work-tree`, cwd:dir, finite timeout) at BOTH sites (the signal the file's dirty-detection already trusts); D2 classify a 0-pass non-zero microverse phase exit as `skipped`/`setup_aborted` (not `completed`) at `getPhaseExitReason` (`pipeline-runner.ts:2873`) + surface in `pipeline-status.json`/banner. Keep the non-fatal continue policy; fix only the labeling. Pipeline-safe (NOT R-PSRB — dirty-tree seam, not salvage/completion/Done-flip). D2 is honesty-relevant (GA bar). | P2 | ✅ **WS-1 SHIPPED + DEPLOYED v2.0.0-beta.41 (2026-07-07, claude, clean hands-off `/pickle-pipeline` — 4/4 phases, 56m, ZERO interventions; a banked soak rep).** WS-1 (`fbde530c`): both git-detect sites (`preflightAutoCommit:2935` + `autoRescueDirtyTree:3619`) route through ONE `isInsideWorkTree` helper (`git rev-parse --is-inside-work-tree`, `GIT_REV_PARSE_TIMEOUT_MS=5000`) — net-subtraction (2 naive `.git`-existsSync checks → 1 helper); + companion `toTopLevelPathspecs` (`:/` magic pathspec) so the newly-reachable subdir auto-commit stages only the owned file (R1). New test 4/4 + preflight-scope 5/5; full release gate GREEN (tsc/eslint-0-err/9-audits/fast-budget-0×5/integration 573+489-0/expensive-19-0/deploy-soak-31m-1-1). The runtime SELF-RECOVERED a spurious Failed-flip (worker backgrounded its own gate → turn-end) hands-off → completion-reconciliation held. **WS-2 DEFERRED** (operator, reliability-first): zero runtime-behavior change (goal #2 honesty), adds a `pass_counts` cross-process-keyed classifier + closed-union extension (the brittleness class we subtract); once WS-1 lands the abort no longer fires on subdirs, so WS-2 defends a door WS-1 locked → prefer the subtractive root fix [[B-CSOR]]. PRD `archive/bundles/p2-bug-fix-bundle-r-mpgd-microverse-git-detect-false-negative-2026-07-06.md`. | `BUG-REPORT-2026-07-06-microverse-preflight-git-detect-false-negative-silently-skips-review-phases.md` |
| R-LTNC | **R-LTNC** — pickle-rick's internal ticket artifact `linear_ticket_<hash>.md` collides in name with the real Linear.app tracker (accessed via Linear MCP); pipeline-internal tickets (incl. hardening tickets) have been mistakenly created as real Linear issues at least once. Fix: rename the internal artifact to `rick_ticket_<hash>.md` across `.ts` source + compiled `.js` + tests + command/agent prompts (real Linear-facing code — `LinearTicketFields`/`syncLinearTicketStatus`/`linear_issue_id`/`PICKLE_LINEAR_COMMAND` — explicitly preserved), + carve out `~/loanlight/CLAUDE.md`'s "Use Linear MCP for tickets" rule to scope it to PRD-level epics only. Verified zero runtime-correctness risk (no shared variables/IDs between the two systems) — pure process-confusion/vocabulary fix, not a reliability defect. Pipeline-safe (not R-PSRB) — no salvage/completion-evidence/Done-flip path touched. | P3 | ✅ **SHIPPED + DEPLOYED v2.0.0-beta.44 (2026-07-08, CODEX build via `/pickle-pipeline` + babysitter closer-takeover).** Codex autonomously executed the 225-file rename (`2028aeb0`) + hermetic backfill test (`88a49eea`) + prompts/globs incl. the `:25` vacuous-completion fix (`98b3df84`) + glob↔writer regression guard (`598e1a74`); the FIRST codex build to complete the substantive work self-recovering a wedge. Closer's full gate caught 6 real rename-gap escapes the worker/scoped gates missed — 4 non-underscore `.find()` regexes in `completion-commit-cluster` (`e0349c4b`), 2 `extension/scripts/` writers (`9db3b934`) — the completeness ACs used `linear_ticket_` (trailing-underscore) and missed the non-underscore form. The build hit a FLAKY R-CWGE gate (→ [[R-WGFR]] filed) and a phantom gate-ergonomics "regression" that was actually a STALE DEPLOY ([[project_gate_ergonomics_resolves_deployed_tree_install_before_integration]] — gate-ergonomics resolves the DEPLOYED check-readiness via getExtensionRoot; `install.sh` fixed it). Full gate GREEN (tsc/eslint/audits/fast-6666-0/integration-580-0/expensive-deploy-soak-7-7). | session `2026-07-05-90457593/prd.md`; refined `2026-07-08-b89bb506` |
| R-TCVC | **R-TCVC** — `classifyTicketTier` has no signal for acceptance-criteria verification cost (pure fileCount/acCount/LOC + 9-word keyword list); a ticket whose ACs bundle a slow container-based verify command (e.g. `test:migration`) is sized identically to one with only cheap greps. Surfaced forensically reviewing session `2026-07-04-4f50b896` ticket `43e8f1a9` (6 zero-progress spawns before `commit-and-continue` salvaged real work). Fix: extend the existing keyword/dimension extraction (already sourced from ticket AC text during `/pickle-refine-prd`) to recognize known-expensive verify-command shapes and bump tier/timeout accordingly — no new state field/gate. | P3 | **BUG FILED 2026-07-05 — not yet scoped into a PRD.** | `BUG-REPORT-2026-07-05-tier-classifier-blind-to-verification-cost.md` |
| R-HNCG | **R-HNCG** — worker `handoff_notes.md` continuity has no enforcement/fallback: it's written only as a "before you finish" step, so a spawn that runs out of turns mid-verification (audit/verification-heavy tickets have no natural implement-phase pause point) loses ALL progress memory for the next spawn, which then re-derives everything from scratch. Same session/ticket as R-TCVC: `43e8f1a9/handoff_notes.md` never existed across 6 spawns despite escalating real progress (5→38→6 diff hunks, a full passing 262/262 test run at spawn 6) that never got written up or committed. Fix: either make handoff-notes a forced per-AC-confirmed checkpoint, or have spawn-morty mechanically append a minimal fallback note on a zero-artifact exit (reuses existing `worker_artifact_progress` signal) — no new state field/gate. | P3 | **BUG FILED 2026-07-05 — not yet scoped into a PRD. Prompt-level mitigation LANDED 2026-07-10 (fable-infusion):** send-to-morty.md + szechuan-sauce.md now instruct checkpoint-BEFORE-risky-ops / record-Dead-Ends-the-moment-an-approach-fails, citing R-HNCG. The mechanical fallback (zero-artifact-exit auto-note) remains unbuilt. | `BUG-REPORT-2026-07-05-handoff-notes-continuity-gap-on-verification-heavy-tickets.md` |
| R-SLEAK | **R-SLEAK** (+ R-PSRB/R-OMTD/R-WSDO context) — session/process leak + contention-gauge | P3 | **PARTIAL — R-OMTD ✅ + R-WSDO ✅ SHIPPED beta.22; R-PSRB documented; R-SLEAK OPEN.** **R-OMTD (`b20a4c1a`):** pipeline-runner spawns mux children `detached` + reaps the subtree via `reapChildSubtree`/negative-PID on teardown (no more PPID-1 orphans). **R-WSDO (`177b84a7`):** `worker_produced_nothing` breadcrumb shipped. **R-PSRB (design, documented — not a code fix):** recovery-machinery bundles can't self-build (deployed pre-fix runtime salvage-resets the ticket building the fix); build protocol = hand-build recovery-path tickets then install.sh-deploy. **R-SLEAK (OPEN, P3 hygiene):** leaked tmux sessions + orphan runners persist for days; `pgrep -f claude` over-counts (matches node runners + own shell) → real worker-contention gauge is `ps -eo command \| grep -E '/claude '`. Session-GC unbuilt. | `BUG-REPORT-2026-06-21-pipeline-self-referential-build-catch22-and-orphan-mux.md` |
| B-ARBR | **B-ARBR (IDEA — 2026-06-29, captured from a LoanLight Arbor-fit review, LOA-1651)** explore using Arbor (keyless MCP autonomous metric-optimizer; HTR Idea Tree + held-out merge margin) to **tune the szechuan-sauce + anatomy-park review prompts** against a review-quality harness. Fit rationale: the prompts are a fully-ours, unconstrained tunable surface; prompt-tuning is Arbor's strongest mode; Arbor's git-worktree isolation is exactly right for parallel code-mutating review runs. **Inverse of [[R-MVFM]]** — there PR *borrows* HTR for the microverse loop; here Arbor *optimizes* PR's own prompts (complementary, not contradictory). **Make-or-break is the metric, not the ~50-line wiring:** review quality must be a **balanced, held-out** score (defect recall + regression rate + scope-adherence); a one-sided metric self-games instantly (optimize recall → flag-everything reviewer-noise; optimize safety → change-nothing). Taste ("is this code worthy") does not quantify and stays human. **Cheapest PoC:** tune szechuan to drive **off-scope-commit rate → 0** ([[reference_szechuan_soft_scope_escape]] / R-SSOC soft-scope-escape; objective, non-gameable, currently failing → real headroom) while holding deslop value at a floor. | P3 | **IDEA — capture-only, NOT scoped.** Deferred behind the reliability queue (R-MWBG runtime half P1, then R-MVFM P3). Subtractive cross-link: R-MVFM already recovers ~90% of HTR's *microverse* benefit cheaply — this is a **different surface** (review prompts), so it does not subsume R-MVFM and vice-versa. No PRD yet; author one (with the harness/metric spec) only if pursued. | capture-only — LoanLight Arbor review 2026-06-29 (Linear LOA-1651) |
| 124 | **R-DPMC-3** decomposition-satisfiability residual | P2 | **DEFERRED** — large additive machinery; needs operator sign-off (R-DPMC-1/-2 already shipped: B-DECOMP-SAT beta.17 / B-GROUND2 beta.16). | `archive/bundles/p2-bug-fix-bundle-b-decomp-sat-decomposition-satisfiability-2026-06-18.md` |
| 125 | **B-GSUB** functional seam-collapse (the simplification track) | P2 | **DOC TRACK CLOSED (−9); functional lever 4-of-5 SHIPPED; the 5th (recovery sprawl) now MAPPED + RANKED (2026-07-07, 4-agent analysis).** B-GSUB's empirical conclusion held again: the biggest guard cluster (~38 manager-loop-continuation guards) is a FALSE collapse target — those guards sit on distinct earned detection signals (timeout/breaker/idle-stall/WMW/codex) that already share termination plumbing; collapsing them wholesale is the exact mistake B-GSUB warned against. The honest residual is THREE bounded items (not one sweeping collapse): **[[B-RASO]]** (correctness-bearing), **[[B-RRPC]]** + **[[B-CSHYG]]** (pipeline-safe subtraction). Completion seam confirmed already collapsed (B-1SEAM, all 15 sites). Full map + ranking: `RECOVERY-SPRAWL-COLLAPSE-ANALYSIS-2026-07-07.md`. | `archive/bundles/p2-simplification-pass-guard-inventory-subtraction-2026-06-18.md` + `RECOVERY-SPRAWL-COLLAPSE-ANALYSIS-2026-07-07.md` |
| B-RASO | **B-RASO** — recovery attributable-work single oracle *(the real recovery-sprawl win; correctness-bearing)*. `detectSilentDeathAttributableWork` (`extension/src/bin/mux-runner.ts:8117` → `hasFrontmatterCompletionSha:8067`, regex-only) and `detectFailedFlipEvidence` (`:8353` → `hasVerifiedFrontmatterCompletionSha:8291`, `git cat-file`-verified + `signal_committed` arm) are two parallel "is there salvageable work?" detectors with DIVERGENT strictness → silent-death can HOLD (suppress respawn) on a garbage/hallucinated sha the failed-flip path rejects (**latent false-hold bug**). Collapse to one `resolveAttributableWorkEvidence` both consume — the B-1SEAM pattern one level down ("is there SALVAGEABLE WORK", the sibling of "is this ticket DONE"). **Also carries B-CSHYG-a** (the dead `salvageCleanTree` back-fill branch — verified DEFER, see below). | P2 | ✅ **SHIPPED + DEPLOYED v2.0.0-beta.43 (2026-07-07, claude, ATTENDED `/pickle-pipeline` — 4/4, ~28m, ZERO interventions; soak rep #3; the FIRST R-PSRB salvage-path RELIABILITY FIX shipped via pipeline, not hand-built — the deployed false-hold never fired on the build worker).** Impl collapsed the FRONTMATTER-SHA arm specifically: one unexported `resolveAttributableFrontmatterSha` (`git cat-file`-verified, both-field continue, R-CCQF-normalized) consumed by both `detectSilentDeathAttributableWork` + `hasTicketScopedCommitEvidence`; `hasFrontmatterCompletionSha`+`hasVerifiedFrontmatterCompletionSha` DELETED; `signal_committed` present-field arm + silent-death backstop arms unchanged. Pinned by new `one-attributable-sha-oracle.test.js` + CLAUDE.md trap door + audit block. **B-CSHYG-a → DEFER** (not deleted — pinned forward-seam, 0 production wirings; `prds/BUG-REPORT-2026-07-07-b-cshyg-a-defer-evidence.md`). Closer caught 3 escapes (mirror drift / 2141-char trap-door line / stale `v2-E2E-9` pre-fix-hold test). PRD `archive/bundles/p2-bug-fix-bundle-b-raso-recovery-attributable-work-single-oracle-2026-07-07.md`. | `RECOVERY-SPRAWL-COLLAPSE-ANALYSIS-2026-07-07.md` |
| B-RRPC | **B-RRPC** — recovery resolver-plumbing consistency *(pipeline-safe subtraction)*. (a) DELETE the dead `evaluateSimpleManagerRelaunch` boolean overload (`manager-relaunch.ts:171-195`, zero production callers, test-pinned only); (b) fold the hand-duplicated `resolveBreakerRecoveryGraceSeconds` (`extension/src/bin/mux-runner.ts:7619`) into `resolveHardeningSettings` (same `hardening:` JSON block — a documented irregularity); (c) move the bare `BOUNDED_ESCAPE_CAP` const (`extension/src/bin/mux-runner.ts:5897`) onto `hardening.bounded_terminal_escape_cap` for uniformity with its two ledger siblings. Resolver-layer only, does NOT touch the salvage path. | P3 | ✅ **SHIPPED + DEPLOYED v2.0.0-beta.42 (2026-07-07, claude, clean hands-off `/pickle-pipeline` — 4/4 phases, 103m, ZERO interventions; soak rep #2).** WS-1+3 `b6d0c44a` (both caps → one `resolveHardeningSettings`, dup resolver + dup default consts deleted), WS-2 `f2b5cf16` (collapsed the overload AND migrated the 3 `hermes-lifecycle.test.js` boolean-form callers — the analysts' "0 test refs" MISSED them; the pipeline's build-time GUARD caught it, declined the first pass, then self-completed the migration on re-spawn), WS-4 `c3bacd88` (deleted the orphaned scanner, −195 LOC, reconciled both CLAUDE.md catalogs + 5 tests). Anatomy-park added 3 export-catalog-hygiene fixes (`559f7e30`/`6d792d5f`/`5fcaf2d7`, incl. dropping the phantom `RelaunchEvaluation` catalog entry WS-2 left). Full gate GREEN (tsc-parity/eslint-0-err/9-audits+`audit-subsystem-claude-md`/fast-budget-0×5/integration 570-0 [3 isolation-green load-flakes]/expensive-19-0/deploy-soak-31m-1/1). PRD `archive/bundles/p3-subtraction-bundle-b-rrpc-recovery-resolver-plumbing-2026-07-07.md`. | `RECOVERY-SPRAWL-COLLAPSE-ANALYSIS-2026-07-07.md` |
| B-CSHYG | **B-CSHYG** — completion-seam hygiene (the B-1SEAM residual). **SPLIT on source verification (2026-07-07):** (a) dead `salvageCleanTree` `backfillDone` branch (`lib/salvage-ticket.ts:141`, 0 callers pass `backfillDone`) edits the R-PSRB salvage-path file → **folded into [[B-RASO]]** (same file, one hand-build session); (b) orphaned zero-runtime-caller scanner `hasCommitReferencingTicketSince`/`findMatchingCommit` (`pickle-utils.ts:1103-1165`, but 5 TEST refs incl. characterization) → **folded into [[B-RRPC]] WS-4** as a verify-before-remove. | P3 | **(b) ✅ SHIPPED beta.42** (B-RRPC WS-4 `c3bacd88` — scanner deleted, verified prod-dead). **(a) ✅ RESOLVED beta.43 as DEFER** (B-RASO WS-2 `6fc22e9c`): source-verified the `salvageCleanTree` `backfillDone` branch is a PINNED forward-seam with 0 production wirings (all 3 `salvageTicket(` callers pass `completionCommitSha: null`); deletion rejected as B-GSUB over-subtraction; DEFER evidence in `prds/BUG-REPORT-2026-07-07-b-cshyg-a-defer-evidence.md`, no `salvage-ticket.ts` change. **B-CSHYG fully closed.** | `RECOVERY-SPRAWL-COLLAPSE-ANALYSIS-2026-07-07.md` |
| 119 | **B-CIINT** integration-tier CI-env e2e failures | P3 | **OPEN** — Linux-CI-only subprocess-e2e flakiness; CI hygiene, **not a release gate**. Pass locally (macOS). | `archive/bundles/p3-bug-fix-bundle-b-ciint-integration-tier-ci-env-e2e.md` |
| — | **B-CGHARD** codegraph harden-then-soak (v2.1 — supersedes the B-CGPROBE build; operator keep-and-refine ruling 2026-07-11) | P2 | **QUEUED — LAUNCHED via `/pickle-pipeline` 2026-07-11.** Scope: WS-A bound the query hang surface (no unraceable sync query reachable from the spawn path — `runSyncQuery` codegraph-service.ts:260 deleted or isolated behind a killable finite-timeout boundary; SUBTRACT `CodegraphService.getImpactRadius`, zero production callers: spawn-morty uses searchNodes/getCallers/buildContext, check-scope-diff's `ImpactRadiusService` is an injected test seam the CLI never wires, the MCP lane is a separate process) · WS-B verify-before-inject (each rendered `file:line` must resolve against the working tree at injection time; all-dropped → `stale_refs` productive skip, preserves b1089e97 injection truthfulness; injected payload gains `dropped_stale`) · WS-C soak protocol doc + `prds/research/codegraph-soak-baseline.md` (forward-created at RUN). BUILD deploy-agnostic on the v2.1 checkout; **SOAK RUN post-GA in a deliberate codegraph-enabled window (≥5 real bundle reps, live telemetry — replaces the synthetic A/B as the [[B-CGCAP]] evidence input)**. Verdict tree: help → B-CGCAP proceeds on live evidence · harm → revisit subtraction · neutral → stays opt-in. | `p2-codegraph-harden-then-soak-v2.1.md` |
| — | **B-CGPROBE** codegraph efficacy instrument + verdict run (v2.1 branch) | P2 | **DEMOTED to OPTIONAL follow-up (operator keep-and-refine decision 2026-07-11 — [[B-CGHARD]] supersedes the build).** The stub + corpus stay as-is (not finished, not deleted). Revisit ONLY if the B-CGHARD soak telemetry is ambiguous. Prior build scope retained below for that contingency: Scope: (1) implement the probe's WITH/WITHOUT spawn-and-score loop (`runProbe` is a stub — codegraph-efficacy-probe.ts:173); (2) replace the oracle-leaked corpus (tickets must NOT name `expected_consumer_files` in `### Files to modify` — ambiguous-scope tickets only); (3) point `hallucinatedRefCount` at research/plan ARTIFACTS (the hallucinated-premise class), not the final diff; (4) verify each WITH-arm run actually injected via `codegraph_context_injected` events (arm-label trust gap); (5) wire `gate_pass` to `runWorkerGate`. Then RUN it (≥5 tickets × 2 arms × ≥3 reps + A/A control) and record `prds/research/codegraph-efficacy-baseline.md`. **Sequencing:** BUILD via `/pickle-pipeline` with working_dir = the v2.1 branch checkout — pipeline-safe on the deployed v2.0 runtime (no salvage-path edits) and DUAL-PURPOSE: each build rep dogfoods the fable-infused v2.1 prompts, so proving codegraph simultaneously proves the branch. The probe RUN needs a deliberate codegraph-enabled window on the deployed runtime → serialize behind v2.0 GA (single deployed tree; don't perturb GA soak reps). Verdict tree: measured win → B-CGCAP flips default-on in v2.1 · measured loss → SUBTRACT codegraph (~1.3k LOC + native dep) AND shelve B-GIMA · inconclusive → stays opt-in, B-GIMA revalidates against a weaker substrate claim. | PRD to author at launch (auto-author per babysitter protocol); evidence audit in the [[B-CGCAP]] row |
| — | **Soak RUN** — post-GA operator execution of the [[B-CGHARD]] WS-C soak protocol | P2 | **NOT YET RUN — owner: operator; trigger: post v2.0 GA, serialized behind GA soak reps (do not perturb GA soak with a codegraph-enabled window).** Runbook: README `### Soak protocol` (under Code Graph). Produces `prds/research/codegraph-soak-baseline.md` (forward-created at RUN); verdict consumed by [[B-CGCAP]]. | README `### Soak protocol` + `p2-codegraph-harden-then-soak-v2.1.md` |
| — | **R-WMFF** worker monitor-wait Failed-flip orphans verified work (BUILT 2026-07-11) | P2 | ✅ **BUILT 2026-07-11** (B-WMFF, 5 tickets landed: `8327c4d8` prompt-layer, `9da93c73` durability+breadcrumb, `5fee5953`/`8f699e78`/`83610ab9` harden/audit/test-quality; ticket `76ee2195` closes the doc audit). Originally **CAPTURED during the B-CGHARD pipeline** (session `2026-07-11-a19aa731`, ticket 6317933b): worker completed a verified diff, parked "waiting on the test:fast monitor event" (no waker exists inside `claude -p`), burned budget → Failed flip with the work UNCOMMITTED (R-WSE-2 correctly silent — artifacts complete; exit-path salvage correctly refused — no gate verdict). Babysitter recovery: committed the verified diff (`3d36ff2c`) pre-respawn per the standing rule; loop self-recovered. **Refinement (2+1 cycles) REFUTED two capture claims and re-scoped a third** — see the bug report's `## Refinement corrections`: (1) "ZERO activity-event trail" was accurate for the incident's own flip class, not a class-wide gap (the 3 mux-runner-side flip sites — `worker_head_regression_detected`, `ticket_ladder_exhausted`, `worker_auto_skip_oversized` — already emit their own events); (2) "runner gate owns verification" was wrong on this exact path (`runWorkerGate` runs in the worker exit path and never completes at budget death); (3) the breadcrumb was re-scoped from an implicit every-flip-site design to the worker-flip class only. **Corrected + shipped fix legs:** (1) prompt-layer — `buildTierLifecycleSections` + both `send-to-morty*.md` carry synchronous-gate-confirmation + commit-first-when-green (`8327c4d8`); (2) `archiveDirtyTreeBeforeFlip` archive-consistency — `advanceOrExitOnLadderExhaustion` was the ONE Failed-flip site never archiving; all 3 Failed-flip sites now archive before their frontmatter write (`9da93c73`); (3) `worker_produced_everything_but_commit` breadcrumb, worker-flip class only, structural `else if` below R-WSDO, full registration + capped payload (`9da93c73`). T10 (`commitGatePassingDeliverableAtBoundary` terminal-guard reorder) explicitly DEFERRED (R-PSRB adjacency — boundary-commit/terminal path); salvage-widening REJECTED per subtract-before-add (both unchanged from capture). | `BUG-REPORT-2026-07-11-worker-monitor-wait-failed-flip-orphans-verified-work.md` |
| — | **B-CGCAP** codegraph default-on (v2.1) | P2 | **EVIDENCE-GATED behind [[B-CGPROBE]] — NO-GO for default-on as of the 2026-07-10 4-agent evidence audit (v2.1 branch).** The benefit side is empirically EMPTY: zero `codegraph_context_injected`/`skipped`/`efficacy_sample` events across every session + activity log on this machine (all 9 telemetry sessions read injected:0); the A/B probe `runProbe` is a STUB (both PRDs admit it) and its corpus has ORACLE LEAKAGE — every ticket names the expected files in `### Files to modify`, pre-saturating the headline Jaccard (~1.0 both arms, near-zero discrimination); the probe also scores the final diff, not research/plan artifacts, so even built it answers a weaker question than the hallucinated-premise class. Enablement costs are real: up to 120s indexAll per fresh setup; an UNRACEABLE sync-query hang surface (`searchNodes`/`getCallers` are sync upstream — a wedged native call burns a full worker-timeout iteration, codegraph-service.ts:260-269 forfeited-claim note); ≤30-min-stale `file:line` refs injected into worker prompts can point at moved code — hallucination-INDUCING on a fast-moving repo. **Feature stays opt-in (unproven, not disproven — SUBTRACTION also rejected: B-GIMA v2.2 hard-depends on codegraph as its code-liveness substrate, AC-GIMA-A5).** Two latent defects found by the audit FIXED on the v2.1 branch: compiled resolver default was enabled:true (missing/malformed settings file silently activated codegraph — 97 leaked test-harness index events proved it fires; now false/false, test pins updated) + mux-runner created the CodegraphService unconditionally (leftover .codegraph db kept native lib loading + 30-min re-syncs while disabled; now gated on settings.enabled). **Path to default-on = fix the instrument first:** rebuild the probe (implement the WITH/WITHOUT spawn-and-score loop), fix corpus oracle leakage (tickets must NOT name expected files), point the hallucinated-ref scorer at research/plan artifacts, add arm-verification via codegraph_context_injected events — a good pipeline dogfood bundle; flip only on a measured win. | `p2-codegraph-default-on-capability-v2.1.md` *(pinned)* + evidence audit this branch |
| — | **B-GIMA** guard-inventory & finding-shape mining audit (v2.2) | P2 | **DEFERRED post-reliability + post-codegraph — now CONTINGENT on the [[B-CGPROBE]] verdict, not just calendar.** Sole survivor of the slop-gate comparative review: an inert, report-only tool that operationalizes subtract-before-add (DELETE never-fired-guards / JUDGE-CALIBRATION conf<80 drops / ADD sort-hints). REUSES codegraph (v2.1) as code-liveness substrate — design dependency (AC-GIMA-A5 "build NO new scanner"). **Contingency (2026-07-11):** probe verdict WIN → B-GIMA proceeds as designed on the proven substrate · probe verdict LOSS → codegraph subtracted, B-GIMA loses its substrate → SHELVE or redesign around the existing trap-door extractor alone (do NOT build the throwaway scanner the PRD warns against) · INCONCLUSIVE → revalidate whether an unproven-but-present substrate still satisfies A5's reuse intent before building on it. Kill-criteria baked in: report-only or dead. Evidence-gating insight from the same review → release-2 R-CWGE/R-DOTR, NOT here. | `p2-guard-inventory-mining-audit-v2.2.md` |
| 13 | **B-DWF-2** retire legacy refinement subprocess | P3 | **⏸️ SHELVED** — soak-harness prereq unmet; legacy path retained for zero regression. | `archive/bundles/p3-bug-fix-bundle-b-dwf2-retire-refinement-subprocess.md` |
| R-FOMH | **R-FOMH** — residuals from the fable orthogonal-surfaces survey (2026-07-10), filed not fixed: (a) `ui-test-worker.md` exists ONLY in the deployed tree (`~/.claude/commands/`, 5.7K) with NO repo source — a Source-of-Truth violation; adopt into `.claude/commands/` then add its convergence honesty fix (converged:true must declare verified-vs-attrition with pass/fail/env_error counts — a dead dev server currently converges instantly, R-SZGB shape); (b) tsc-gate block message reports its own budget expiry (`cold_cache_timeout`) as a compile failure with no first-line output and no redirect — workers rewrite correct code or flip Failed on gate noise; add per-kind suffix in `formatBlockReason` ("gate budget expired, NOT proof of a compile error — warm cache with `npx tsc --noEmit`, retry once"); (c) config-protection state/config block messages refuse without redirecting (R-WSRC bypass-retry iteration burn) — add proceed-without-it guidance + the StateManager.update override path; (d) `pickle-microverse.md` interactive steps 5a.7/5b.7 `git add -A` conflicts with the repo-wide bystander-sweep prohibition, and the metric read has no inert-check guidance (non-numeric/garbage score can revert good work). All message-text/prompt-only; (b)(c) need per-string pin surgery in hook tests. Ship-review additions (2026-07-10): (e) the mirrored FOM-injection prose families (checkpoint / zero-findings / inert-check / bare-PASS / path-scoped-revert) shipped UNPINNED except the GIT_BOUNDARY PROHIBITED list — the branch itself proved hand-mirrored copies drift; decide pin-vs-single-source per family; (f) live-run watch: reduced-tier "RUN each AC verify command" vs small-tier budget interaction (mitigated by the verification-cost tier rule; confirm on first soaks). | P3 | **FILED 2026-07-10 (fable orthogonal survey).** The worst sibling (R-WSRC-GR message teaching unguarded `git restore <paths>`) was fixed on the spot (`experiment/fable-operating-manual`). | fable orthogonal-surfaces survey (this branch) |
| R-RWNF | **R-RWNF — VERIFIED DEAD + SCOPED (2026-07-15, `1c84b520`; attended removal, NOT pipeline — woven through the worker-spawn core, `spawn-morty.ts` 8 sites + ~5 tests). Spec: `prds/BUG-REPORT-2026-07-15-rwnf-...md`.** Finding: the entire review-worker path appears never-fired in production: `send-to-morty-review.md` is selected only via spawn-morty's `--review` flag, which no production caller passes (mux-runner/jar-runner/pipeline-runner: 0 hits; only spawn-morty.test.js), and its input contract — a ticket with `review_group` frontmatter — has ZERO producers anywhere. Retired-meeseeks scaffolding surviving as a parser flag + prompt + `WorkerRole 'review'` type surface. Subtraction would remove the prompt file, the `--review` branch, `WorkerRole 'review'` + `ARTIFACT_PREFIXES.review`, and `validate-teams-ticket --role review` — multiply pinned (types, template-no-bare-tokens, send-to-morty-resume REVIEW_COMMAND, spawn-morty tests), so this is a deliberate PRD-level verify-before-remove subtraction per B-GSUB discipline, not a quick kill. | P3 | **FILED 2026-07-10 (fable-infusion prompt-corpus audit).** Not scoped into a PRD. The prompt itself was meanwhile de-meeseeksed + given FOM calibration injections so it is correct if ever fired. | fable-infusion gap analysis 2026-07-10 (this branch) |
| 25 | **R-CSI** concurrent-session destructive-command interference (DATA-LOSS class) | P1 | **EXTERNAL-GATED** — re-activates on the next real concurrent-session incident to analyze. | `archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md` |
| — | **R-SCPIN** — start_commit adopts `pinned_sha`; delete the `computeBaselineStartCommit` guess. **Supersedes shipped-defective [[R-PSCG]]/B-PSCG** (`2bbf5770`'s `healPipelineRequiredFields` self-heal stamped a REVIEW-base primitive — `merge-base(<default>, HEAD)` — as the session baseline; 97 commits/154 files wrong on this branch, unfailable citadel remediation + a blind orphan-reset guard). Adopts the co-stamped `pinned_sha` at both heal seams, deletes both `computeBaselineStartCommit` guesses, adds an honest baseline-unmeasurable-vs-zero-commits phase-halt reason + truthful deferral WARN branches, renames the primitive `computeBaselineStartCommit`→`computeReviewBase`, and pins salvage-guard re-arm regression coverage (orphan-reset detection + T40 exclusion sanity). Pipeline-safe (heal-seam/gate edits — `mux-runner.ts`/`salvage-ticket.ts`/`ticket-completion-evidence.ts` are forbidden edit targets in every ticket's scope allowlist, NOT the R-PSRB salvage path). | P2 | 🔶 **CORE FIX BUILT 2026-07-12** (session `2026-07-11-255ad373`, hand-decomposed): `3010d66f` (0aff9d30 — pinned_sha adoption at both heal seams), `be386f98`+`e421c3f8`+`f53371a5` (fbdfd121 — honest halt reason + truthful WARN branches + AC-SCPIN-5 test dedup), `0cab9ec5`+`52c4a076` (4947e0d3 — `computeBaselineStartCommit`→`computeReviewBase` rename), `f535cd40`+`f470fe6a` (468a91b1 — salvage-guard re-arm regression tests). **All 4 hardening/audit tickets SHIPPED:** `5df5ac9e` (59a0948f — code-quality/test-isolation; caught a **P0 that would have failed the release gate** — the new salvage-guard test loaded a session-writing bin with no `PICKLE_DATA_ROOT` sandbox), `73aa1970` (1d9ba69c — [HIGH] data-flow-integrity), `c07cf4ec` (6309e498 — test-quality; **the suite was BLIND — 70/70 green against a reverted heal, because the fixtures seeded a single-branch `main` where merge-base == HEAD == pinned_sha and all three candidate baselines collapse. Re-seeded onto a divergent branch; mutation-killing tests 2→7, independently re-verified by the manager: a rebuilt mutant is killed by 5 tests**), `f75bc76a` (695e4fb4 — cross-reference-consistency; caught this row itself claiming 3 shipped tickets "remain Todo"). ✅ **BUNDLE COMPLETE 2026-07-12** — release gate green (tsc + eslint + 9 audits + fast-tier budget 5 runs/0 failures + integration 522/522); `test:expensive` deploy-soak NOT run (only required before tagging). | `prds/p2-start-commit-adopt-pinned-sha.md` + superseded `prds/p2-pipeline-resume-start-commit-selfheal.md` + `prds/BUG-REPORT-2026-07-02-pipeline-resume-start-commit-gap-citadel-hardfail.md` |
| — | **R-WDTF** — `spawn-morty`'s `no WORKER_DONE token` check writes `status: "Failed"` **unconditionally and last**, overwriting a `Done` the worker already wrote. Hit TWICE in the R-SCPIN bundle: `6309e498` (exit 0, full artifacts, work left UNCOMMITTED — a salvage reset would have destroyed 183 lines of mutation-hardening) and `695e4fb4` (exit 0, **committed `f75bc76a` and self-flipped the ticket to `Done` with a real `completion_commit`** — stomped to `Failed` anyway). Both workers were long-running and ended their final turn awaiting a test suite, so never got a turn to emit the token. A narrative signal (did the model emit a string?) outranks ground truth (frontmatter + `completion_commit` + artifacts + `git log`) and can only ever DESTROY information. Downstream a `Failed` ticket triggers respawn/salvage → duplicate work, or reset over verified uncommitted work. Both were hand-recovered by the manager; unattended, both regress. Fix is **subtractive**: consult ground truth before writing `Failed`; reserve `Failed` for no-artifacts + no-diff + no-commit. Makes spawn-morty agree with the manager's own "`I AM DONE` is a claim, not a fact" rule, which it currently contradicts. **PIPELINE** (hand-build reflex retired 2026-07-16). | P1 | ✅ **SHIPPED beta.5** (B-WDSUB WS-1 — subtracted the token conjunct at both sites; VERIFIED `Failed`/null → `Done`/real-SHA). | `prds/BUG-REPORT-2026-07-12-worker-done-token-false-failed-flip.md` |
| R-BCFR | **R-BCFR** (field-surfaced 2026-07-12, session `2026-07-11-255ad373` citadel phase) — the citadel `banned-construct` arms cite a CLAUDE.md rule that **does not exist**. `banned-constructs-audit.ts:129` hardcodes the string "is banned by CLAUDE.md" for brace-free-`if`; grepping every CLAUDE.md returns ZERO such rule — the only hit is `prds/CLAUDE.md:46`, which rules the OPPOSITE (leave it to eslint/prettier autofix). eslint configures no `curly` rule and exits 0 on all flagged files; brace-free `if` is the house style (pervasive in `extension/src`, incl. **inside the analyzer itself**); and `collectChangedCodeLines:47` scans changed lines only, so the gate **cannot converge** — every future bundle touching these files re-pays the tax. Live cost: citadel ran 3 cycles → **43 findings, 0 remediated**; the gate remediator refused TWICE (`consecutive_abort_count:2`, `loop_detected:true`) and was RIGHT to. Sibling arm `:118` (nested ternary) carries the identical fabricated citation. **NOT B-CSOR** — B-CSOR (beta.11, `750e3f58`) shipped the delivery pipe (`mechanical-finding-classifier` + `remediable ∪ mechanical` union) precisely so this class WOULD reach the remediator; the machinery works, the rule it feeds is fabricated. Fix = **pure subtraction** (R-PCPS precedent: 41/41 false-High → subtract the arm; this is 43/43 of the same shape). Pipeline-safe (NOT R-PSRB — citadel analyzer surface). | P2 | **OPEN** — filed 2026-07-12. WS-1 delete `isBraceFreeIf` arm; WS-2 verify-then-delete the `isNestedTernary` sibling; if both go, delete the module + unwire from `audit-runner.ts` (R-CCNW-2 forbids an on-disk-but-uninvoked analyzer). Adopting the brace style HONESTLY (eslint `curly` + `--fix` + document it) is out of scope / operator-owned. | PRD `p2-bug-fix-bundle-r-bcfr-banned-construct-fabricated-rule.md` |
| R-GRLS | **R-GRLS** (code-verified 2026-07-12; anatomy-park OPEN GAP, session `2026-07-11-255ad373` iters 9+13, `AP-EXT-REMEDIATOR-LOCK-EMPTY-PAYLOAD-SILENT-NOOP`) — `bin/spawn-gate-remediator.ts:232-265` `acquireLockfile` is a hand-rolled lock that (a) writes **NO payload** (`openSync(O_CREAT|O_EXCL|O_WRONLY)` + immediate `closeSync`), (b) cleans up only via `process.on("exit")` — which **SIGKILL skips** — and (c) on `EEXIST` writes a lockout doc and returns **`{ok:false, exitCode:0}`**, i.e. exits CLEAN having remediated nothing. So one abrupt death strands the lock and **every later remediator exits 0, edits nothing, and is indistinguishable from a successful remediation** — a red gate reported as handled. This is the **false-GREEN** class, in the one component the run could not reach (out of `scope.json` fence). The empty payload would also silently defeat a naive steal (`isDeadPidPayload` parses empty → NaN → never fires). Its THREE sibling locks all shipped dead-holder recovery THIS session (`withRetryLock` steal; `withLock` `reclaimDeadGateLock` `ae0e1a88`; restructure lock `498efe04`) — this is the last un-reclaimed lock. Fix = **REUSE, not new machinery**: `acquireLockFile(lp, String(process.pid))` + `reclaimDeadGateLock` + inode-bound `releaseLockFile` (byte-for-byte the `ae0e1a88` shape); do NOT port `withRetryLock`s age-based arm (a remediator legitimately holds for minutes → an age verdict evicts a LIVE holder). Pipeline-safe (NOT R-PSRB). | P2 | **OPEN (latent — not yet field-fired)** — filed 2026-07-12. WS-1 route the lock through the 3 shared primitives (net-subtractive: 4th divergent lock → 0); WS-2 a lockout must not READ as a remediation — reuse the existing `remediation_*_result.json` contract with `outcome:"locked_out"`, `failures_remediated:0`, and make the caller refuse to score it as success (else WS-1 still leaves the live-holder false-GREEN open). | PRD `p2-bug-fix-bundle-r-grls-gate-remediator-lock-strand.md` |
| R-JPCM | **R-JPCM** (field-surfaced 2026-07-13, session `2026-07-11-255ad373` szechuan phase) — the judge PROMPT and the judge PARSER disagree, and the violation ledger dies in the gap. `buildJudgePrompt:1656-1661` demands **"Output ONLY a single integer or decimal number on the LAST line"**; `parseLlmJudgeOutput:1771` runs `JSON.parse` and expects an **object** with `score` + a `violations` array. Prose-ending-in-a-number is not a JSON object → `catch` → `emptyJudgeResult("malformed")` → `violations: []`. **Silent by construction:** `extractScore:1735` falls back to line-oriented parsing, so the SCORE is captured correctly and nothing looks broken — only the payload is dropped. Smoking gun: **5 × `judge_json_parse_failed`** this session (stderr-only; `:1769` admits event registration is still "pending R-SLLJ-6 / ticket 96402c0a", so the one signal that the ledger is dead is invisible to `/pickle-status` + metrics). **Blast radius — R-SLLJ is inert:** `updateViolationLedger:3423` IS wired but is handed an empty array (and a full result REPLACES the ledger, so it stays `[]` forever); `compareMetric:3446` needs both ledgers populated to take the **R-SLLJ-4 set-ops branch**, so it falls to bare-numeric; the prompt`s own `## Prior violations (DO NOT re-report)` block (`:1664`) is gated on a non-empty ledger and never fires; `JudgeResult.shape: "full"` is **unreachable**. R-SLLJ-1/3/4 were built to kill exactly this false-stall class — they are present, wired, and have **never once run**. **Live cost:** szechuan measured baseline 5, improved to 4, then held at 4 for **five consecutive iterations while landing five real reviewed fixes** (`1cc46bb0` `981a16b2` `9f19370b` `ce79c1bf` `72280dac` `b5db1afc`), hit the stall limit, and exited **`status: "converged"` at score 4 against `convergence_target: 0`**. The workers were working; the metric was blind. Fix = **make the prompt ask for the shape the parser already parses** (no new code path; the parser/ledger/set-ops/prior-violations block are all already built). Pipeline-safe (NOT R-PSRB). | P2 | **OPEN** — filed 2026-07-13. WS-1 prompt emits `{score, violations:[…]}`; KEEP `extractScore`s legacy fallback (AC-JPCM-5) — do NOT subtract the safety net in the same change that starts depending on new judge behavior. WS-2 register `judge_json_parse_failed` as a real activity event (the R-SLLJ-6 residual, finally paid) + stop labeling a flat-score/empty-ledger stall as `converged` (it is `stalled_unmeasurable`, not convergence). | PRD `p2-bug-fix-bundle-r-jpcm-judge-prompt-parser-contract-mismatch.md` |
| B-APRP | **B-APRP** — **re-pass queue for the two phases session `2026-07-11-255ad373` did not finish.** (a) **anatomy-park `extension` + `bin`**: the phase exited **NON-convergent** (`exit_code:1`, `exit_reason: anatomy_non_convergent`, logged `recoverable_phase_failure` → `decision: continue`). It ran 16 iterations, reached `pass_counts {bin:7, extension:8}`, and **never got a single clean pass on either subsystem** (`consecutive_clean {bin:0, extension:0}`, stall 0/3) — it did not converge, it **ran out of runway while still surfacing CRITICALs** (it landed 11 commits incl. a release-gate symlink-target escape `4f748e00`, `setup --resume` flipping a RED-gated ticket to terminal Done `ea502a49`, and three dead-holder lock recoveries). There is more in that subsystem than it had iterations to reach; re-queue for another pass. (b) **szechuan-sauce**: stalled flat at 4/0 — **BLOCKED on [[R-JPCM]]**; re-running it before the judge-contract fix ships would reproduce the identical false-stall (the ledger would be empty again and every real fix would score `held`). **Sequencing: R-JPCM → szechuan re-pass. The anatomy re-pass is independent and can run any time.** | P2 | **QUEUED** 2026-07-13. Verify-first per the standing drain rule — re-confirm the non-convergent exit and the open CRITICAL surface before launching. | this row + `p2-bug-fix-bundle-r-jpcm-judge-prompt-parser-contract-mismatch.md` |
| B-RLH | **B-RLH — review-loop honesty (composes [[R-BCFR]] + [[R-GRLS]] + [[R-JPCM]]).** One thesis, three defects: **a review phase reporting success it did not earn.** citadel reports 43 findings it can never remediate (fabricated `banned by CLAUDE.md` rule — the string is a hardcoded literal, no CLAUDE.md carries it, eslint exits 0 on every flagged file, and the changed-lines-only scan can never converge); the gate remediator exits **0** having done nothing when its payload-less lock is stranded (**false-GREEN**); szechuan reports `converged` at score 4 against a target of 0 because the judge PROMPT demands a bare integer while the PARSER demands JSON, so the violation ledger is **always empty** and five real landed fixes scored `held`. Disjoint files, all subtract-or-reuse, all pipeline-safe. PRD `p2-bug-fix-bundle-b-rlh-review-loop-honesty.md` (all 3 `composes:` paths verified to resolve). | P2 | **READY TO LAUNCH** — all three re-verified STILL OPEN against HEAD 2026-07-14. Deployed runtime is `2.1.0-beta.2` (fixed locks + tmux guard), so the run is no longer exposed to the wedge classes. Refine ONE ticket per R-code — do NOT collapse into an umbrella. `/pickle-pipeline prds/p2-bug-fix-bundle-b-rlh-review-loop-honesty.md` | PRD + the 3 composed PRDs |
| R-LSPC-2 | **R-LSPC-2** — `stealLockFile`/`releaseLockFile` treated the **inode NUMBER** as durable identity. **ext4 recycles inode numbers**, so a rival's brand-new lock lands on the dead holder's number, the check reads "still the file I judged", and it **EVICTS A LIVE HOLDER** — both writers then enter the critical section. That is the precise catastrophe the lock redesign exists to prevent: the fix re-opened, one layer down, the hole it was closing. APFS does not recycle eagerly ⇒ green on macOS, red on Linux CI, and it **SHIPPED IN beta.45**. Identity is now `sameLock` = inode **AND** raw bytes, the bytes carrying a per-acquisition nonce written by `acquireLockFile` (which now returns a `LockHandle {ino, raw}`); `LockSnapshot.payload` still returns exactly the caller's bytes so every caller's decoder is untouched. The regression test reproduces it **deterministically on ANY filesystem** — it hands `stealLockFile` the verdict it formed wearing the LIVE file's inode, byte-for-byte what a recycled inode looks like from the code's side — and was verified to FAIL against an ino-only comparison. The old test's `assert.notEqual(liveIno, snapshot.ino)` precondition was itself the bug in the suite: it asserted WHICH FILESYSTEM you were on, so when Linux answered honestly the test errored in setup instead of exercising the behaviour. | P2 | ✅ **FIXED BOTH LINES.** main `224805e9` (shipped v2.0.0-beta.46) · v2.1 `130215c7`. Lock suites 92/92 both lines. Also corrected the trap door, which still TAUGHT inode identity (`lockInodes`, `proven to be snapshot.ino`) — the catalog meant to prevent this class was instructing the next reader to reintroduce it. | `BACKPORT-2026-07-13-v2.0-ledger.md` |
| R-IWGM | **R-IWGM** — `install.sh` could not install from a git **worktree**. Git mode was detected with `[ -d "$SCRIPT_DIR/.git" ]`, but in a worktree `.git` is a `gitdir:` **POINTER FILE**, not a directory — so it silently fell through to **tarball** mode, which skips the codegraph symlinks and lets the deploy-root `npm install --omit=dev` prune the `typescript` symlink as extraneous, leaving the deployed `pipeline-runner` unloadable (`ERR_MODULE_NOT_FOUND: typescript`). It failed LOUDLY in the tests but **SILENTLY for an operator installing from a worktree**. Nothing had ever covered it — it surfaced only because a v2.1 gate run happened to execute inside one. | P2 | ✅ **FIXED BOTH LINES** (`[ -e ]`), with a source pin verified to redden against `[ -d ]`. main `4e3939bb` (shipped v2.0.0-beta.46) · v2.1 `69829ec5`. | `BACKPORT-2026-07-13-v2.0-ledger.md` |
| R-RNTA | **R-RNTA** — **every GitHub release since beta.43 has ZERO assets, so the auto-updater has had nothing to download for four releases.** `release.yml` orders the steps `Install and compile` (the FULL GATE) → `Build tarball` → `Create release`. The gate step fails on Linux (the chronic cross-platform class), so the workflow **dies before `Build tarball` ever runs** and no `.tar.gz` is attached. `check-update.ts:207` fetches updates with `gh release download -p '*.tar.gz'` — with no asset it can fetch nothing. Invisible because everyone deploys with `bash install.sh` locally. Verified: `assets=0` on beta.43, beta.44, beta.45, beta.46 AND v2.1.0-beta.2. This reframes "CI-green is not a release gate" (true) into **"CI-red currently means no artifact ships"** (also true, and nobody knew). | P2 | **OPEN** — filed 2026-07-14. Fix is a workflow reorder (build+attach the tarball independent of the Linux gate verdict, or gate asset upload on the LOCAL gate that is the documented source of truth). Cheap, and it restores the distribution channel. | this row |
| R-FBTN | **R-FBTN ✅ SHIPPED (2026-07-15, `495d5e50`)** — now emits a `FLAKY_TESTS` block naming the offending tests after the count. Original: `check-flake-budget` reports a **COUNT, never the test names.** Its entire CI output is `FAIL_BUDGET_EXCEEDED failures=N budget=2 runs_completed=N` — it pipes the child's stdout/stderr and prints only a tally, so the identity of what failed is destroyed. Consequences seen this session: (a) a **deterministic** Linux failure (3 failures in 3 runs — one per run, every run) was mislabeled as *flakiness* by a guard literally named "flake budget" and hidden for **three releases**, calcifying into "chronic CI red" folklore instead of a fixed bug — it was [[R-LSPC-2]], a live-holder eviction; (b) the same guard hid a self-inflicted trap-door length failure until the suite was re-run directly to get names. A gate that can fail the build but cannot say what failed is an observability defect, not a gate. | P3 | **OPEN** — filed 2026-07-14. Fix: on failure, surface the failing test names (echo the child's `✖`/`not ok` lines) — the information already exists and is being thrown away. Pairs naturally with [[R-APGG]]. | this row |
| R-LSPC | **R-LSPC** (found 2026-07-13 by back-porting the lock cluster to main; FIXED both lines) — `acquireLockFile` named its staging file `${lockPath}.acq.${process.pid}` — keyed on **pid ALONE** — and `stealLockFile`s tombstone was `${lockPath}.tomb.${pid}.${Date.now()}` (ms clock). `acquireLockFile` is synchronous so two attempts cannot interleave WITHIN a thread, but **worker threads share a pid**: two open the SAME staging path, the loser truncates the winners payload and unlinks it underneath them. Symptom: `ENOENT` on the `linkSync` publish. **Worse, silently:** the surviving `linkSync` can publish a lock **naming the WRONG pid** — a LIVE holder advertising an already-dead pid, which `isDeadPidPayload` will happily reclaim out from under it. That is exactly the live-holder eviction the lock redesign (`d374c2c0`/`da1a6470`/`981a16b2`) exists to prevent — the fix re-opened, one layer down, the hole it was closing. **LATENT, not live:** production has ZERO `worker_threads` in `src/` (one process per writer → distinct pids); `tests/integration/concurrent-state.test.js` drives real concurrency with threads and reproduced it ~50% of runs. Both scratch names now carry `pid + threadId + monotonic attempt counter`. Independent pre-fix baseline on v2.1 (unfixed primitive, test-side change already applied): **3/4 runs FAILED** — confirming the bug was live here AND that the test-side change alone does not fix it. | P2 | ✅ **FIXED BOTH LINES, UNPUSHED.** v2.1 `0ce62c6c` · main `ab937a6f`. Each line: reproducer **10/10 clean** (was ~4/8 failing), `lock-steal-live-holder` + `state-manager` **91/91**, tsc + eslint clean. | `BACKPORT-2026-07-13-v2.0-ledger.md` |
| R-APGG | **R-APGG** (process gap, 2026-07-13 — the reason [[R-LSPC]] shipped unnoticed) — **anatomy-park and szechuan-sauce can land CRITICAL changes to the most safety-critical code in the system and never run the gate that would catch them.** The full release gate runs at the **pickle** phase; anatomy-park and szechuan run only their own per-iteration convergence gate (scoped typecheck/lint/tests), never `test:integration`. Session `2026-07-11-255ad373` proved the consequence: anatomy-park rewrote **all four lock primitives** (`d374c2c0` shared primitives, `ae0e1a88` gate-lock reclaim, `498efe04` restructure-lock reclaim, `da1a6470` payload-publish ordering, `981a16b2` inode-verified steal) AFTER the last full gate ran — and shipped [[R-LSPC]], a defect its OWN `concurrent-state` suite reproduces ~50% of the time. The branch was never asked. It was caught only because the code was back-ported to main and gated there. **So this line still carries an unknown amount of post-pickle-phase work that has never seen `test:integration`.** | P2 | **OPEN** — filed 2026-07-13. Cheapest honest fix: run the full gate (or at minimum `test:integration`) at the END of the pipeline, after szechuan — a bundle is not shippable evidence until the tier that catches cross-module regressions has run over the FINAL tree. This is a gate-PLACEMENT fix, not a new gate (subtract-before-add: nothing new is built; an existing gate runs at the true exit). | `BACKPORT-2026-07-13-v2.0-ledger.md` |
| B-V20BP | **B-V20BP — v2.1 → main (v2.0) reliability back-port, 2026-07-13.** `main` was **135 commits** behind this line. Per-commit triage (2 parallel agents): **30 GA-FIX** (security / data-loss / false-Done / reliability) + **11 companions** (prerequisites without which the GA fixes do not build or do not test) **TAKEN to main**; ~48 QUALITY, 22 V21-ONLY (FOM + codegraph — the codegraph chain creates a file main lacks and cannot graft), 29 LEDGER, 5 SUPERSEDED **stay here**. Landed on the ship line: config-protection APPROVING `sed -i`/`perl -i` in-place edits of live `state.json` + `~/.claude/pickle-rick/**` (SECURITY); the release-gate tar scan blind to symlink TARGETS, through which the auto-updater writes and escapes the install prefix (SECURITY); orphan-tmp scans destroying an UNREADABLE newer snapshot (DATA LOSS); `setup --resume` resurrecting a RED-gated ticket to terminal Done; the 4-lock dead-holder-recovery cluster; the ambient-`#S` tmux hijack (measured 30 mutating calls into a STRANGERs live session → 0). | P2 | ✅ **LANDED on main, UNPUSHED** (45 commits on `cad28cb2`; safety ref `backup/main-pre-backport-2026-07-13`). main gate GREEN: tsc + eslint + **9/9 audits** + `test:fast` **6731/0** + `test:integration` **1088/0**. ⚠ **v2.0 GA BLOCKER: `4fcc02fc` (the config-protection SECURITY fix) is on main with NO TESTS** — its 7 regression tests were refused by this branchs scope fence and parked in a patch file that no longer exists; coverage must be rewritten. `test:expensive` (deploy soak) not run — tag-time only. Branch→main SHA mapping + the 5 hand-resolved picks: see the ledger (the `-x` provenance line did not survive the commit method). | `BACKPORT-2026-07-13-v2.0-ledger.md` |

> **Recently shipped + swept to `archive/`:** **B-SCOPESEED (beta.38, 2026-07-03)** — R-SSPB pickle-phase
> scope seeding (`setupScope`/`persistSeededBranchScope` + seed test) + R-PSAM standup author resolution;
> built by the FIRST clean hands-off codex `/pickle-pipeline` (4/4, 139m, zero intervention — soak rep #1).
> **Lessons:** push local-ahead commits BEFORE an on-`main` `--scope branch` launch (a local docs diff scopes
> the build to `prds/`); the closer caught 9 review-phase escapes → [[R-SZGB]] capture (szechuan gate converged
> over tsc-RED); source-pin tests broken by a refactor = verify the invariant survived, then sync anchors
> (timer params → constructor parameter properties; exhausted-seam count = 7 direct + 1 via helper). PRD →
> `archive/bundles/`. · **THE SIMPLIFICATION DROP (beta.37, 2026-07-02)** — B-1SEAM (ONE completion predicate at all 8 decision sites + call-site audit + spawn-morty verified-sha/`Pickle-Ticket`-trailer reconciliation; symmetric `prd_path`+`start_commit` self-heal; ONE dirty-tree salvage seam) + R-CXHANG positive-ownership orphan reaper + B-RSHM (stop-hook dead branches + chain_meeseeks retired) + guard-layer prune (4 orphan + 2 advisory audits deleted, design-ground-truth demoted → 9-audit gate, ONE bypass surface, legacy kill-switches removed, codex-manager-relaunch shim collapsed). Net ~−3,650 LOC. **Lessons:** verify a bug report's mechanism against source BEFORE authoring the fix (R-AICF's flag was deleted beta.23 — the live defect was per-call-site policy divergence); subagent background test runs die at agent turn-end — run gates from the orchestrator; trap-door entries are one line ≤1500 chars; a predicate that persists on every decision kind makes direct-oracle-call test fixtures order-sensitive; two prune items honestly no-go'd on evidence (trap-door audit is a superset; "write-only" flags had readers). PRDs: R-CXHANG + B-RSHM → `archive/bundles/`; B-1SEAM's authoring artifact is `SIMPLIFICATION-AND-FIX-PLAN-2026-07-02.md`. · **B-WSPU (beta.35, 2026-07-01)** — collapse the dual worker-spawn model: DELETE the detached lifecycle (spawn arm + poll + disposition + `state.detached_worker` + `large_tier_*` events + ~11 test files + trap doors), route all tiers through synchronous re-spawn-resume. ~1000+ LOC pure subtraction. **Lessons:** the 600s ceiling is an unremovable harness cap but synchronous re-spawn-resume already survives it, so detached was optimization-not-correctness; a detached fix-worker silent-died building its own deletion (re-tier small→synchronous to dodge); review-phase subprocesses SIGHUP-unstable this session (closer-direct on the full gate); do NOT misread a long manager turn (frozen state.json mtime) as a stall — check real process liveness first. Deployed 2026-07-01 (operator-authorized). · **B-SSVR (beta.34, 2026-06-30)** — R-SSBR scope-resolver
> fail-CLOSED on a stale/ahead base ref (`9592eb46`) + R-ISVP install.sh prerelease semver (`d260012e`); closer caught
> 2 gate-missed bugs (WS-1 multi-line trap-door → citadel line-parser `73f780bf`; beta.33-left-red keystone stale-test
> `8e987d87`). **Lessons:** trap-door catalog entries MUST be a SINGLE physical line (the citadel
> `rule-set-invariant-audit` parser is line-oriented — a wrapped INVARIANT/BREAKS reads as no-BREAKS); a grammar-deletion
> subtraction (beta.33 forward-ref) must grep every test/fixture that RELIED on the deleted grammar (keystone shipped red);
> late-flushing detached workers can land green output AFTER a `phase_no_progress` verdict (verify FS before trusting the
> flip — B-WSPU field evidence). · **R-SIGF / B-SIGF (beta.29, 2026-06-29)** — scope-fence
> caller-gap detect-and-block + bounded opt-in auto-extension + schema-shape consumers (the codex GA blocker); +
> R-MWBG half-1 (manager foreground-spawn fix). Shipped via babysitter recovery through an R-MWBG mid-build stall;
> 4 in-pickle hardening tickets deferred (large-tier worker silent-death → R-MWBG runtime half). · **R-WPEX (beta.28, 2026-06-28)** — detached-worker
> session-log fsync on the success/close drain (reuse `bestEffortFdatasync`); hand-built in-process via an
> ultracode Workflow (repro-first), full local gate green, no recovery-path pipeline needed. · **B-APNC
> (R-APNC, beta.27, 2026-06-28)** — anatomy-park
> convergence/complexity halt guard + subtract-pass discipline; built on claude, shipped via babysitter
> closer-takeover (recovered an R-WPEX log-flush 0/4 stall mid-build; closer fixed the 2 new guard activity
> events' registration). · **B-CWGE (R-CWGE, beta.26, 2026-06-28)** — codex worker-gate
> verdict authority, fail-closed; built on claude, shipped via babysitter closer-takeover (the closer's full
> gate caught 1 verdict over-reach into the runner-authored commit path + 3 pre-existing `f009608d` sweep-drift
> audit/test path casualties). · **B-PXBO (R-DPGT + R-DOTR + R-CRSR + R-OMA, beta.25)** ·
> B-PCOMP · B-RFCU · R-WSDO · R-CECB · R-RCFF (beta.22) ·
> B-DURA + R-REIN + WS-2/WS-5 (beta.23) · **B-RPGT (R-RPGT + R-S529, beta.24)** — drain rows removed; source PRDs
> moved to `archive/bundles` + `archive/bug-reports`. **R-PFNT facets 1+2 / R-CECX are now codex-PROVEN HELD
> (LOA-1363 run 4, 2026-06-24)** — completion-evidence class closes on codex; they stay above only as the
> proof record. The LIVE residuals are now **[[R-SIGF]] (load-bearing, 2nd repro)** + **[[R-DPGT]] (new)** +
> **[[R-DOTR]] (new — Done over committed-red on the timeout path)** — the phase-completion + completion-
> correctness blockers. The 2026-06-24 sweep also archived ~30 older shipped PRDs/design-notes.
>
> Everything else has shipped. For the chronological record of the ~60 shipped bundles and the
> ~244 closed findings, see [`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) and
> [`BUG-INDEX.md`](BUG-INDEX.md). Feature epics (R-PGI v1.83.0 · R-PIAP v1.84.0 · R-DC v1.85.0 ·
> B-DWF v1.91.0 · B-HERMES · B-CBI · B-DSEK) are all shipped or shelved.

---

## Engineering Rules

Detail in `extension/CLAUDE.md` + `citadel.md`. Quick form:

1. **Atomic PRs** — one ticket per PR, independently revertible.
2. **Full release gate** — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` (+ audit scripts + `RUN_EXPENSIVE_TESTS=1 npm run test:expensive`). Green before tag.
3. **Source-of-truth** — edit `extension/src/*.ts` + `.claude/commands/*.md`; `bash install.sh` to deploy. Never edit `~/.claude/pickle-rick/`.
4. **Trap-door preservation** — every `extension/CLAUDE.md` invariant has an enforcing test.
5. **Hook decisions** — `"approve"` / `"block"` only.
6. **CLI guard** — `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`.
7. **Error handling** — `const msg = err instanceof Error ? err.message : String(err);` at boundaries.
8. **Versioning** — semver in `extension/package.json`; single bump per bundle at the closer.
9. **No dirty release** — all changes committed before tag; compiled JS matches TS source.
10. **Greenfield** — no legacy aliases, no backward-compat shims.

---

## Quick Reference

```bash
/pickle-status                       # formatted current session
/pickle-metrics                      # token/commit/LOC report
/pickle-prd                          # interview then PRD
/pickle-refine-prd <prd>             # 3-cycle decomposition
/pickle-tmux <prd>                   # launch ticket pipeline (tmux, all sizes)
/pickle-pipeline <prd>               # pickle, citadel, anatomy-park, szechuan-sauce
gh release create vX.Y.Z             # tag + publish
```

**Resume an active loop:** `node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --resume <SESSION_ROOT>`.
Closer manager-handoff runbook: `../docs/closer-ticket-manager-handoff.md`. Babysitter: `babysitter.md`.

---

## OPEN BUG — AC-shape gate rejects DERIVED `describe.each` (2026-07-14, capture-only)

**`prds/BUG-REPORT-2026-07-14-ac-shape-gate-rejects-derived-describe-each.md`**

`DESCRIBE_EACH_RE = /describe\.each\s*\(\s*\[/s` (`spawn-refinement-team.js:943`) requires an **inline array
literal**, so it **rejects `describe.each(EXPORTED_CONST)`** — the derived form, which is strictly better and is
what the gate's own purpose demands. Satisfying the gate means **hand-copying the target set into the spec**,
which is the exact drift-prone enumeration the gate exists to stamp out.

Also: `UNIVERSAL_QUANTIFIER_RE` (`:941`) omits `no` / `never` / bare `any`, so it misses **negative universals**
("NO rule emits…", "a FAIL never renders below a PASS") — the shape most safety ACs take.

**Consequence:** the gate's stated pass condition is **unreachable** for a correctly-written PRD, so *"refine
until the gate passes clean"* does not terminate. Hit on LOA-1763 (loanlight-api): five rounds, gate blocked all
five, six of nine analyst-authored tickets failed the collapse check **while being more correct than the shape
the gate wanted**. The blocking was still valuable — rounds 4–5 surfaced real correctness bugs — but the run had
to override the gate with a documented reason to proceed.

---

## OPEN BUG — pipeline `--max-iterations 0` stops after ONE ticket + manager orphans its worker (2026-07-14, capture-only)

**`prds/BUG-REPORT-2026-07-14-pipeline-max-iterations-zero-stops-after-one-plus-orphaned-worker.md`**

Two compounding defects, hit on a 66-ticket LOA-1763 build via `/pickle-pipeline`:
(1) `pipeline-runner` pickle phase treats `--max-iterations 0` as **stop-after-one** (guard
`iteration <= max_iterations` fails at `2 <= 0`), while `--max-time 0` means **unlimited** — the two
flags interpret `0` oppositely, and the skill's Step 11b documents `--max-iterations 0 --max-time 0` as
the "unlimited" auto-launch form. So the documented unlimited launch caps the build at ONE ticket.
(2) Within its one iteration the tmux manager spawned ticket 20's worker as a **harness-backgrounded
task**, then `end_turn`-exited while the worker was mid-Implement → worker orphaned (PID died with
parent), ticket left `In Progress` with **no commit** → `exit_reason=done_without_commit_evidence` →
`Pipeline finished: 0/4`. `allow_inferred_completion_commit=true` was set and could NOT help — there was
no commit to infer. Adjacent to R-MWBG / R-AICF; trigger is manager-exit-with-live-worker.
Result: a 66-ticket launch-critical bundle built ~1.5 tickets and reported terminal success-shaped state
in 8 min. Workaround: relaunch with explicit `--max-iterations 500` (the non-auto default).

---

## OPEN BUG — R-ORSR-2 recovery flips a ticket Done without the impl landing (2026-07-16, capture-only)

**`prds/BUG-REPORT-2026-07-16-r-orsr2-recovery-flips-ticket-done-without-impl.md`**

LOA-1763 B6b (order 610, "delete both FIRSTCOLONY gates") flipped `status: Done` /
`worker_gate_verdict: green` with ZERO impl committed: the only ticket-tagged commit is
`fix(adb35445): commit-and-continue recovery (R-ORSR-2)` — a salvage commit, not the edit. Both gates
still in `appraisal.processor.ts` (`grep '"FIRSTCOLONY"' src` = 2, AC demanded 0). 10 worker_session
logs; every handoff note says "Tried: launch smoke test … Next focus: real B6b impl" — the worker burned
all 10 turns re-probing and never edited. Defect: an R-ORSR-2 recovery commit is accepted as completion
evidence, and the Done-flip does not re-run the ticket's own machine-checkable grep/e2e ACs (a FALSE grep
AC should block Done). Adjacent to R-AICF/R-CECX but distinct — the commit exists and is hash-tagged, so
inferred-completion accepts it, but it is a RECOVERY commit and the ACs are verifiably unmet.
Workaround: the 2-line gate deletion is a trivial manual fix, tracked for hand-application after the
pipeline's citadel/anatomy/szechuan phases complete.

## 🎯 TOP ITEM — [[B-ONEABORT]]: two termination channels, one subtraction (2026-08-06, P1)

**`prds/p1-b-oneabort-one-termination-policy-across-both-channels.md`** — **operator directive
2026-08-06:** *"our reliability goes to zero every time a pipeline stops… we really should have almost
zero abort conditions."*

**The diagnosis: a pipeline can terminate through TWO independent channels, and [[B-NOSTOP-GATES]]
subtracted exactly one.** Channel 1 (pickle phase loop, `shouldHaltAfterPhase` →
`dispatchHaltAction`, `extension/src/bin/pipeline-runner.ts:4131`) is subtracted and **demonstrably
works** — the same run logged `non-fatal pickle exit, commits present` and `citadel: remediation cap
exhausted … continuing pipeline (no halt)`. Channel 2 (microverse phases —
anatomy-park, szechuan-sauce — `classifyMicroverseHaltDecision`, `:4315` → abort at `:4049`) was
**never enumerated**, and it killed a 590-minute run at `2/4 phases`.

**Why it drifted:** AC-NSG-5b (`extension/tests/nostop-gates-invariant.test.js:221`) pins only
`shouldHaltAfterPhase('pickle', …)` — `grep -c "microverse"` on that file returns **0**. The invariant
built to make the subtraction permanent covers only the channel that was already fixed. Precedent
*inside* channel 2: `B-NS / B-APNC WS-1` already rescued `limit_reached`/`no_progress`/`stopped`/
`approach_exhaustion` from this same abort, recording that the literal chain had *"silently
desynchronized from the map."* Same defect, one layer up.

**Channel 2 aborts on 8 triggers; exactly ONE is a genuine floor** (`session_state_corrupted`). Two
abort **unattributed** (`:4319` non-string exit_reason, `:4345` fallthrough) — the run ends and nothing
says why. `rate_limit_exhausted` aborts despite B-RRH having built a park for it; `judge_cli_missing`
aborts although an inert review phase is not an unsafe run.

**Target: exactly ONE abort condition — the pipeline may terminate only when it cannot safely read or
write its own state.** Everything else ends the PHASE honestly and reaches the finalize-gate.
**REUSE, not new machinery:** `run-finalize-gate-incomplete` already exists and already carries
`baseline_unmeasurable_transient`, `all_judge_backends_exhausted`, and every non-convergent Template-A
reason. ⛔ **Do NOT build a halt-classification table** (directive 4: *"a halt-classification table
would BE the treadmill"*) — the shape is **one predicate + one invariant** consumed by both channels,
i.e. two policies collapsing into one. Net-negative LOC is pinned by AC-OA-1c.

**Absorbs [[R-JUNS]]** (it becomes one member of the set). Related but separate: [[R-EROS]]
(mis-stamped roster reason), [[R-ISSC]] (gate hides half its surface — WS-4 must measure both
integration sub-tiers separately).

## 🚨 OPEN BUG — R-JUNS: an unparseable judge answer is "unrecoverable" and aborts the pipeline (2026-08-06, P1)

**`prds/BUG-REPORT-2026-08-06-judge-parse-failure-classified-unrecoverable-aborts-the-pipeline.md`** —
killed a **590-minute** B-OFFREPO run at the last phase: *"Metric measurement failed
(`baseline_unmeasurable_unrecoverable`) after 4 attempt(s): judge output did not contain a numeric
score"* → `pipeline aborting (no finalize-gate)` → `Pipeline finished: 2/4 phases`. Path:
`extractScore` returns null → `failureKind: 'failed'` (`extension/src/bin/microverse-runner.ts:2303`) →
matches no case and falls to **`default:` → `baseline_unmeasurable_unrecoverable`** (`:3005`, `:3025`) →
∈ `MICROVERSE_FATAL_REASONS` (`extension/src/types/index.ts:1296`) → abort at
`extension/src/bin/pipeline-runner.ts:4049`. **The asymmetry IS the defect:** timeouts and rate-limits
are explicitly routed to recoverable classes, while a malformed-but-present LLM answer — the most
obviously re-promptable failure there is — gets the harshest classification purely by landing on
`default:`. **Directive-2 tension:** this reason is NOT in [[B-NOSTOP-GATES]]' sanctioned halt set; a
measurement failure should park the PHASE and let the pipeline finish (`stalled_below_target` already
exists as the honest non-convergent disposition). **Nothing announced it** — R-JPCM WS-2's
`emitJudgeParseDiagnostic` ("a dead ledger must be loud") logged **0** entries for the judge-parse
failure that killed the run. **Fix (subtractive, two halves):** route `'failed'` to
`baseline_unmeasurable_transient` via an explicit case; and drop
`baseline_unmeasurable_unrecoverable` from the fatal set. ⛔ Do NOT add retry budget — the 4 attempts
are not the problem, the classification of their outcome is.

## 🔺 OPEN BUG — a deployed crash-floor halt verdict is discarded at the phase boundary; the amnesiac breaker zeroes its own bound, $13.21 burned (2026-08-07, P2)

**`prds/BUG-REPORT-2026-08-07-toolchain-unavailable-not-treated-as-halt-stall-detection-blind-to-identical-verdicts.md`**
— `/pickle-pipeline` session `2026-08-07-35088221` launched against a fresh worktree with no
`node_modules`/`.env.local` (target `loa-2188-worktree/packages/api`). **Diagnosis revised 2026-08-07
against source + session artifacts — both original root causes were wrong, and both corrections make
the fix smaller and net-subtractive.**

**V1 — the halt fired correctly; the phase boundary threw the verdict away.** `toolchain_unavailable`
is NOT missing: it is an `ExitReason` (`mux-runner.ts:4434`), is in the terminal set (`:4464`), has a
live predicate `targetToolchainMissing` (`:4505`) and the R-PFNT preflight (`:9967`), and ships in the
deployed tree. It fired **268 ms into phase 1**, wrote a `session_end` activity record, called
`recordExitReason` + `safeDeactivate`, and exited. `shouldHaltAfterPhase` then read only the exit
**code** — `1` is non-fatal for a non-citadel phase under R-PHC-6 continue-by-default — discarded the
crash-floor `exit_reason` persisted 200 ms earlier, and logged *"continuing to citadel"*. **This is a
stated-but-unwired policy:** the root `CLAUDE.md` halt set names "toolchain unavailable" as a genuine
crash floor, R-PHC-6 mandates continuing on non-fatal non-zero `pickle` exits, neither references the
other, and no code reconciles them — so the crash floor is unreachable through the phase boundary no
matter how well the detector works. **Fix = one wire, not a mechanism:** read `state.exit_reason`
against the existing terminal set at the boundary. Precedent at that exact seam: R-CCR-3 and R-ICP-2
already read `exit_reason` in `runPhaseIteration`. A prose-signature detector is explicitly NOT needed.

**V2 — stall detection was bypassed, and the loop is unbounded by construction.**
`classifyNoCommitExit` (`microverse-runner.ts:1518`) evaluates `if (turns !== null && turns < 5) return
'amnesiac'` at `:1530` **ahead of every content check**. A correctly-blocked worker concludes fast
(being right is fast), so a decisive correct verdict is labelled `amnesiac`; the handler at `:3749`
logs *"not counting as stall"* and never touches `stall_counter` — confirmed by the session's final
`microverse.json`: `stall_counter: 0`, `convergence.history: []` after 22 iterations. Stall detection
was never blind to identical verdicts; it was handed nothing to count. Worse, at 2 strikes
`resetGapAnalysisForAmnesiacBreaker` (`:3670`) returns `consecutive_amnesiac_exits: 0` — **the breaker
zeroes the counter that is supposed to bound it** — and sets `status: 'gap_analysis'`, paying a fresh
LLM baseline measurement each cycle. `consecutive_amnesiac_exits` can never exceed 2. **Cost
attribution corrected:** ~11 gap-analysis + judge cycles, not 22 worker iterations. **Fix = two
removals, no new state:** demote or delete the `num_turns < 5` proxy below the empty-diff /
unchanged-`HEAD` truth checks, and stop the breaker zeroing its own counter (a one-line deletion).

**Spun-off finding:** across those ~11 cycles against a provably unchanged **empty** diff the judge
returned `3, 2, 4, 1, … 0`. An empty diff should score constant. Adjacent to reopened R-JPCM and the
R-SLLJ ledger work; a non-deterministic baseline defeats amnesiac-threshold tuning by construction, so
it must be understood before anyone tunes those thresholds.

**Bundle is net-subtractive:** no new state field, no new detector, no new gate, no new skip flag.
Verified root causes, corrected ACs, and the superseded original inference are all in the bug report.

## 🚨 OPEN BUG — R-ISSC: `test:integration` short-circuits; the serial sub-tier is never measured when parallel fails (2026-08-05, P1)

**`prds/BUG-REPORT-2026-08-05-test-integration-short-circuits-serial-subtier-never-measured.md`** —
found BY ticket `a6af84ea` while measuring its own AC. `test:integration` is
`npm run test:integration:parallel && npm run test:integration:serial` (`extension/package.json`), and
`&&` short-circuits — so a parallel failure means **the serial half never runs**, while
`npm run test:integration` is the release-gate command named twice in `CLAUDE.md`. **Consequence: every
red-tier attribution we have made is a parallel-only partial measurement.** The serial sub-tier is
measured *only* on runs where parallel is already green — i.e. never when it matters. `a6af84ea`
measured the halves separately and found the serial sub-tier had **never been measured**, surfacing 4
unseen failures. This retroactively qualifies the *"10 failures"* count in the [[R-GADEL]] report (a
parallel-only figure). **Fix is SUBTRACTIVE:** run both halves unconditionally and aggregate exit codes —
⛔ do NOT add a fourth `test:integration:all` script beside the broken composite; `bin/test-runner.js`
already takes `--manifest-mode`/`--test-concurrency`, so one runner call owning both passes is the
smaller change. Same family as the rest of 2026-08: **the instrument, not the thing measured.**

## 🔺 OPEN BUG — R-EROS: an In-Progress ticket is reported "all-Failed" and stamped `recovery_exhausted` (2026-08-05, P1)

**`prds/BUG-REPORT-2026-08-05-empty-roster-overstamps-recovery-exhausted-on-a-3of4-done-roster.md`** —
found BY the [[B-OFFREPO]] build (session `2026-08-04-183319b4`). The pickle phase ended **3/4 Done**
with the fourth `In Progress`, and stamped `exit_reason: recovery_exhausted` — an `isFailureExit` member,
so `auto-resume.sh` stops. **The roster contained ZERO Failed tickets**, and the runtime said so itself
173 ms earlier (`Phantom-Done watcher kept ticket … Done — valid completion_commit evidence` ×3).
`noRunnableTicketsRemain` (`extension/src/bin/mux-runner.ts:1245`) proves exactly one thing —
`findNextPendingTicketId(...) === null`, i.e. **no PENDING ticket** — but the call site (`:9903`) infers
*"all-Done exited earlier, therefore what remains is all-Failed"*. That disjunction is incomplete:
**`In Progress` is neither Done nor pending.** Underneath it is the real defect — a ticket left
`In Progress` with a `completion_commit` and fresh artifacts is **neither runnable nor terminal**: no
selector re-enters it, no terminal path claims it. Same shape as [[R-ACNP]] (a status the selector cannot
reach), inverted. **Second finding — ESCALATED, the gate MANUFACTURES REDS (measured 2026-08-05):** all three
`worker_gate_failed` payloads carry `message: "> pickle-rick-scripts@2.1.0-beta.7 pretest:fast"` —
**npm's banner line, not the failure**. And the verdict is not merely uninformative, it is **WRONG**:
ticket `69cdb73b` persisted `worker_gate_tests_verdict: "red"`, but the same tier at the same HEAD on a
quiet box returns **`tests 7250 / pass 7247 / fail 0`, EXIT=0, zero `not ok`**. A phantom red is what
`failed_flip_suppressed` had to defend two tickets against; absent `fresh_artifacts` evidence, a false
Failed flip follows. **4th occurrence 2026-08-05T17:53:33Z** — after the B-OFFREPO relaunch, ticket `69cdb73b` was re-stamped `red` with the identical banner-line evidence, 25 minutes after the fast tier was measured GREEN (7250/7247/0) at the same HEAD. The phantom red had been stripped by hand before the relaunch and the gate manufactured it again. Any consumer treating `worker_gate_tests_verdict` as ground truth is reading noise
([[R-WGVI]] recurring in the failure payload, now with a false-positive verdict on top). **Fix is SUBTRACTIVE** (directive 4 — do not add an in-progress ladder branch):
make the message and reason match what the predicate proves, and reconcile In-Progress-with-evidence via
the existing `evaluateCompletionEvidence`/`reconcileTicketTruth` oracles before judging the roster.
⛔ Do NOT make the roster check fail-closed or halt earlier. **NOT a halt:** the pipeline continued
correctly through all 4 phases (`non-fatal pickle exit, commits present`; citadel `remediation cap
exhausted … continuing pipeline (no halt)`), 489m, 23 commits, clean tree — [[B-NOSTOP-GATES]] worked.

## 🚨 OPEN BUG — B-OFFREPO: the worker quality gate does not exist on any repo that is not pickle-rick (2026-08-04, P1)

**`prds/p1-b-offrepo-gate-the-worker-gate-does-not-exist-off-repo.md`** — **five** sites key the quality
gate on `<workingDir>/extension`, pickle-rick's OWN layout. On every other repo the gate does not run,
and three of the five return **green**:
`extension/src/bin/spawn-morty.ts:1786` `runWorkerGate` → `{ok:true, lintErrors:0, tscErrors:0, testFailures:[]}` ·
`extension/src/bin/mux-runner.ts:4718` `resolveWorkerGateVerdict` → `{verdict:'green', computedVia:'worker_gate'}`
(**false attribution — asserts a gate produced it**; the source comment admits the reasoning: *"NOT
fail-closed: a non-pickle-rick target would otherwise have every Done-flip refused"*) ·
`extension/src/bin/mux-runner.ts:5834` recovery `runArmedGate` → `{ok:true}` · plus a silent `null` skip
(`:670`) and an honest refusal that strands work (`:5238`). `worker_gate_verdict` gates the Done flip at
`extension/src/bin/mux-runner.ts:4861`. **Field:** session `2026-08-03-2d5b3820` — our ONE clean hands-off
run on a real target repo (LOA-2190, 14/15 Done, `exit_reason: completed`) — ran in a worktree with **no
`extension/` dir**, so **every worker skipped the whole lint/tsc/test gate and reported green.** That run
proves the system COMPLETES; it proves nothing was CHECKED. Largest instance of [[R-WGVI]]; confirmed
member of [[project_offrepo_fakegreen_is_a_family_not_one_site]]. **Fix is REUSE + subtraction:**
`detectProjectType` (`extension/src/services/convergence-gate.ts:362`) and `canRunTestScript` (`:911`) are
already exported and already repo-agnostic — the worker gate never asks. ⛔ Do NOT build a per-stack
adapter matrix (repo-agnostic invariant). ⛔ Do NOT fail-closed on raw red (deadlocks every ticket on
inherited debt). A gate that cannot run reports **`not_run`**, never `green`, and never halts (directive 2).
⚠️ **The self-build cannot exercise this bug** — pickle-rick HAS `extension/` — so WS-4's off-repo field
run is mandatory, not optional. Build **ATTENDED**.

## 🔺 OPEN BUG — B-LOGEV: 81% of worker session logs are EMPTY, and the classifier believes them (2026-08-04, P1)

**`prds/p1-b-logev-session-log-emptiness-is-not-evidence.md`** — measured on session `2026-08-03-2d5b3820`
(LOA-2190, 15 tickets, `exit_reason: completed` — **the run that WORKED**): **35 of 43**
`worker_session_<pid>.log` files are **0 bytes** (81%), and **11 of 15 tickets** hold a full lifecycle
artifact set alongside ≥1 empty log. `classifyWorkerSessionLogs` (`extension/src/bin/mux-runner.ts:8007`) maps 0-byte →
`log_empty`, which feeds (a) the `worker_produced_nothing` breadcrumb and (b) `worker_silent_death` →
`applySilentDeathRecoveryPolicy`, whose cap-exhaustion arm is **`recovery_exhausted` — the only
non-crash-floor HALT in the runtime**. All **10/10** `worker_produced_nothing` emissions in that session
fired on workers that had produced artifacts; proof by clock: ticket `1029cede`'s breadcrumb fired **48
seconds after that same PID wrote a 9,535-byte plan**. Ticket `c721f502` double-emitted from one PID, the
second emit landing in the same second its ticket file was stamped `Skipped
(acceptance_criteria_not_checked)` — [[R-ACNP]] and this bug condemning one productive worker together.
**Why the run survived:** `detectSilentDeathAttributableWork` runs first and returns `hold` on fresh
artifacts — the ground-truth oracle already exists, already works, and is already load-bearing. **Fix is
SUBTRACTIVE:** log-emptiness is a rendering artifact, not evidence; subordinate every `log_empty` consumer
to attributable-work, and fix the capture failure. ⛔ **Do NOT bound the respawns** — that caps the waste
and leaves the misdiagnosis, and routing the class into `silent_death_respawn_cap` would wire the one
signal that has never stopped a pipeline straight to the halt. Build **ATTENDED** (recovery path).

## OPEN BUG — R-ACNP acceptance-criteria checkbox gate is a consumer with no producer (2026-08-04, capture-only)

**`prds/BUG-REPORT-2026-08-04-r-acnp-acceptance-criteria-checkbox-no-producer.md`**

`hasCheckedAcceptanceCriteria` (`extension/src/bin/mux-runner.ts:2450`) requires every non-`[manager]` AC checkbox to be
ticked, but **nothing ticks them**: the symbol has exactly 2 refs in `extension/src/` (its definition +
its one call site at `:2840`), no runtime writes `[x]` into a ticket's `## Acceptance Criteria`, and no
prompt instructs the worker to — `extension/src/bin/spawn-morty.ts:1114` covers AC *ownership* only, `send-to-morty.md:110`
says criteria must **pass**, not be ticked. So `validateAutoTicketCompletion`'s `{action:'done'}` arm is
unreachable in practice: it is a one-way valve that can only `leave` or `skip`. Perverse corollary —
`[].every()` is true, so the ONE shape that auto-completes is a ticket whose ACs are *entirely*
`[manager]`-tagged. Live proof, session `2026-08-03-2d5b3820` (LOA-2190, 15 tickets, ran to
`exit_reason: completed`): **90 AC checkboxes, 0 ticked, 14/15 shipped Done anyway** via the explicit
`completion_commit` path (`guardCompletionCommitBeforeDone`, which never consults this predicate). The
single ticket nobody flipped Done (`c721f502` — its residual ACs needed a live paid Reducto run the worker
is barred from executing) fell to the safety net and got
`Marked ticket c721f502 as Skipped (acceptance_criteria_not_checked)` — a reason **true of all fifteen
tickets** and therefore diagnostically worthless; the real disposition sat in that ticket's
`conformance_*.md` `## Manager Handoff` block. NOT a halt (directive-2 compliant: parked, flagged,
continued). Per directive 4 the candidate fix is a **subtraction** — delete the predicate + call site, not
teach it new cases or add a skip flag; AC satisfaction is already owned by producers that exist
(`worker_gate_verdict`, `completion_commit` attribution, `hasSubstantiveManagerHandoff` at `:4873`).
Escalation to P2 if ever observed on a ticket whose impl landed but whose Done-flip was missed: that
ticket is stamped Skipped, and Skipped is terminal (`isTerminalTicketStatus:2412`), so
`isPendingMuxTicket:1063` never re-selects it — real committed work permanently mislabelled. Not observed
in this session (`c721f502`'s work genuinely was incomplete); filed as trigger, not occurrence.
**Fix bundle runs ATTENDED** (touches the Done-flip/completion path) — launch it via `/pickle-pipeline`
like everything else and watch the salvage seam. *(Superseded 2026-08-04: this row originally read "R-PSRB
hand-build — do NOT dogfood it." The hand-build exception was deleted by operator decision; see
`CLAUDE.md` → "NEVER hand-build" and `prds/CLAUDE.md` → "R-PSRB attended protocol".)*
