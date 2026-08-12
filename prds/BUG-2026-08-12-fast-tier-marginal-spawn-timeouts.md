# BUG-2026-08-12 — Fast-tier subprocess caps sit below the subject's own defined worst case

## Summary

The release gate is red at `npm run test:fast:budget` with `FAIL_BUDGET_EXCEEDED failures=3 budget=2 runs_completed=4 runs_requested=5`. All 13 pre-test gate steps are green — `tsc`, `eslint`, and all ten audit scripts pass. The failure is confined to the fast tier's subprocess-heavy tests.

The failures are not logic errors. They are `spawnSync` timeout kills: the harness SIGTERMs a child that has not finished, `result.status` comes back `null` instead of the expected exit code, and the assertion reports a value mismatch that reads like a behavioural regression but is a scheduling one.

The first draft of this PRD framed the caps as "marginal — within a rounding error of observed runtime". Three refinement cycles established something stronger and more actionable: **the caps are below a documented code path's completion time.** `extension/src/bin/spawn-morty.ts:3099` arms a hang guard at `effectiveTimeoutMs + 30_000`, so a subject invoked with `--timeout 30` has a defined worst case of ~60 s *before* process startup, state-manager schema migration, and teardown — against a 45000 ms harness cap. The cap cannot bound the subject's longest defined path. That is a provable defect, not a tuning complaint.

Two further mechanisms make the class recurrent and unattributable, and are in scope here. A third — the audit's blindness to it — is deferred, with reasons.

## Evidence

Two instrumented fast-tier runs at `--test-concurrency=8`, worker environment scrubbed (`env -u PICKLE_TICKET_ID -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_COUNT`), on a 24-core host at load average 10–15:

| Run | Failing test | File | Recorded | Cap | Censored? |
|---|---|---|---|---|---|
| 1 | `recovers orphan tmp backend state before routing worker CLI` | `extension/tests/spawn-morty.test.js` | 45037 ms | 45000 | yes |
| 2 | `recovers orphan tmp backend state before routing worker CLI` | `extension/tests/spawn-morty.test.js` | 45036 ms | 45000 | yes |
| 2 | `test:fast failure with work evidence suppresses the Failed flip and preserves the commit` | `extension/tests/spawn-morty-worker-gate.test.js:579` | 90187 ms | 90000 | yes |
| 2 | `spawn-morty.hermes: spawns hermes chat with toolsets and completes` | `extension/tests/spawn-morty.test.js` | 45044 ms | 45000 | yes |
| 2 | `recovers orphan tmp session timeout before printing worker budget` | `extension/tests/spawn-morty.test.js` | 45031 ms | 45000 | yes |

Assertion text confirms the mechanism rather than a behaviour change:

```
AssertionError [ERR_ASSERTION]: expected validation failure after codex shim exit
  actual: null
  expected: 1
  at TestContext.<anonymous> (extension/tests/spawn-morty.test.js:735:16)
```

`actual: null` is `spawnSync`'s signal-kill result, not an exit code the subject produced.

**Four of the five rows are right-censored.** They are kill times, so each test's true duration is *unknown and strictly greater* than the number recorded. Only the one passing observation is a real measurement: in run 1, `spawn-morty.hermes: spawns hermes chat with toolsets and completes` **passed** at 43829 ms against its 45000 ms cap — 1171 ms of headroom, 2.6% of budget. In run 2 the same test failed at 45044 ms.

This censoring is load-bearing, and the first draft of this PRD got it wrong: it derived caps from "3× the maximum duration observed", which is 3× a *lower bound* and therefore bounds nothing. WS-A0 exists to replace those bounds with measurements.

**Four of five failures are in `extension/tests/spawn-morty.test.js`; the fifth and largest is not.** The 90187 ms row is `extension/tests/spawn-morty-worker-gate.test.js:579` (`@tier: fast`), bounded by `const WORKER_TIMEOUT_MS = 90_000` at `:13`, consumed at `:613`, `:698`, `:745`. Both files are in scope.

### The subject's real budget is not its `--timeout` argument

`extension/src/bin/spawn-morty.ts:444-459`, `resolveEffectiveTimeout`, clamps the configured timeout **down** to the parent session's remaining wall-clock and **up** to `MIN_TIMEOUT_SECONDS` (`= 30`, `src/bin/spawn-morty.ts:64`) — but only when parent state carries a usable `max_time_minutes` and `start_time_epoch`; otherwise the configured value passes through unchanged. Where the clamp does apply, a `--timeout 5` callsite runs a **30-second** subject. The test tree states this directly: `extension/tests/spawn-morty.test.js:583` is named `'spawn-morty F15: 5s remaining is clamped to 30s minimum'`, and `:668` carries the comment `// With remaining<=0 and --timeout 5, effectiveTimeout = max(30, 5) = 30`.

A resolver keyed on the CLI argument would therefore **cut** `extension/tests/spawn-morty.test.js:563` and `:662` from 45000 ms to 15000 ms — manufacturing new flakes in the very file this bundle exists to stabilize.

### Census, corrected twice

The original census scanned for a numeric literal near a `spawnSync` callsite: 119 callsites across 56 files above 15000 ms. That method cannot see a cap bound to a named constant, and the largest failure in the Evidence table is bound to one. `grep -rnE "^const [A-Z_]+_MS\s*=\s*[0-9_]{5,}" extension/tests/*.test.js` returns **18** such constants (the first revision of this PRD said 19; it was wrong). The anchored `^const` form still misses indented and non-`_MS`-suffixed constants, so **18 is a floor, not a count** — as 119 was.

`extension/tests/spawn-morty.test.js` holds 25 `timeout:` literals — 24 × `45000` and 1 × `5000`. The 5000 ms one at `:347` must not be converted: its enclosing test asserts the subject *exits non-zero within 5 s*, so there the cap **is** the assertion.

### Attribution is destroyed by the reporter

`extension/src/bin/check-flake-budget.ts:139-160` keeps only extracted test names on failure, accumulating them into one `Set` (`failingTests.add(name)`, `:158`). Neither `stdout` nor `stderr` is retained per run. The reported `FLAKY_TESTS` list is a **union across failing runs** and cannot distinguish the same test failing three times (a regression) from three tests failing once each (contention) — opposite situations demanding opposite responses. Reproducing that attribution by hand cost two full fast-tier runs, roughly 31 minutes, for information the gate held and discarded.

## Non-goals

- No change to production behaviour. The only `extension/src/` file in scope is `check-flake-budget.ts`, whose sole consumer is the gate. `spawn-morty.ts` is read (and possibly gains an `export`) but its logic is untouched.
- Not a revert of the install.sh bundle. Nothing here implicates it; all pre-test steps including the install audits are green.
- Not raising `--fail-budget`. Widening flake tolerance deletes the signal instead of the defect, and would mask a future real regression.
- No retry or auto-rerun wrapper. Retries convert an attributable failure into an unattributable one.
- **Not extending `audit-subprocess-heavy-tests.sh`.** See Deferred.

## Deferred, with reasons

**The audit extension (former WS-C) is deferred to a follow-up bundle.** It remains true that the audit is blind to this class twice over: its pattern matches only `spawnSync('bash'|'sh', ...)` (`extension/scripts/audit-subprocess-heavy-tests.sh:88`) and never `spawnSync(process.execPath, ...)`; and its bands stop at `SUBPROCESS_HEAVY_WARN_MS=15000` (`:27`) while these failures occur at 45000–90000 ms.

It is deferred because refinement established that the change cannot land cleanly in this bundle:

1. Extending the matcher to Node spawns applies the **existing** 5000 ms FAIL band to seven currently-green files, reddening `pretest:integration` on its own — a red gate produced by the bundle meant to green it.
2. `extension/scripts/audit-subprocess-heavy-tests.sh:131-140` allowlists silence **both** bands, so any serialization allowlisting silences the new band on the file carrying the evidence — the new criterion would pass *because* the file was exempted.
3. `find_heavy_candidate` (`:57-63`) is file-granular and single-candidate, so per-callsite criteria are written against a mechanism that does not exist.

This is the "does this workstream add brittleness?" test, and it fails it. The root fix (WS-A) is subtractive; the audit is a guard over it and belongs after the thing it guards is correct. Deferring is not dropping — a residual records it.

**Serialization (former WS-B) is dropped outright.** It was specified as adding `extension/tests/spawn-morty.test.js` to `extension/tests/integration/.serial-tests.json`. Verified: `extension/package.json:22` is `node bin/test-runner.js --tier fast --test-concurrency=8` — **no `--manifest` flag**. The manifest is consulted only by `test:integration:parallel` and `test:integration:serial` (`:28-29`). There is no mechanism that serializes a `@tier: fast` file, so the workstream was a no-op wearing a mechanism's name.

Building a new fast-tier serial manifest to fix a cap-derivation bug would add a scheduling mechanism to work around caps that are simply wrong. Fix the caps. If correctly-derived caps still flake under load, serialization becomes a *measured* follow-up rather than a guess.

## Workstreams

### WS-A0 — Re-measure the named tests without censoring (blocks WS-A)

Every cap in WS-A derives from a duration, and four of five durations on hand are kill times. Before any cap is chosen, re-measure each test named in the Evidence table with a deliberately generous cap (600000 ms) so the run terminates naturally, and record the **completion** duration together with the observed `result.status`.

A non-`null` `status` is the proof the measurement is uncensored. That check is the ticket's whole point — a re-measurement that itself gets killed produces another lower bound and must be re-run at a higher cap, not recorded.

Measure both at rest and under load comparable to Evidence (load average ≥ 10), and record both.

**Acceptance criteria**

- `AC-A0-1` — For **every** test named in the Evidence table, an uncensored completion duration is recorded, each with its observed non-`null` `result.status`. A recorded row whose `status` is `null` fails this criterion.
- `AC-A0-2` — Measurements are recorded at rest and under load average ≥ 10, both stamped with the observed load.
- `AC-A0-3` — The results are committed to the ticket's artifact directory as the derivation input WS-A cites.

### WS-A — Derive caps from the subject's effective budget and its hang-guard floor

The 119-plus magic numbers are the defect, not their values. A cap of `45000` beside a subject invoked with `--timeout 30` encodes a margin nobody chose and nothing re-checks when either number moves — and, per Evidence, encodes it *below* the subject's own defined worst case.

Replace the per-callsite literals in `extension/tests/spawn-morty.test.js` and `extension/tests/spawn-morty-worker-gate.test.js` with one shared resolver in `extension/tests/__helpers__/` (that directory exists — `codex-shim.js`, `dot-parse.js`, `worker-commit-fixture.js`; `tests/helpers/` does **not** exist).

The resolver's input is the subject's **effective** budget, not its CLI argument, and the floor accounts for the hang guard:

```
effectiveBudgetMs = max(MIN_TIMEOUT_SECONDS, subjectTimeoutSeconds) * 1000
floorMs           = effectiveBudgetMs + HANG_GUARD_GRACE_MS + STARTUP_ALLOWANCE_MS
cap               = max(floorMs, effectiveBudgetMs * MULTIPLIER)
```

`MIN_TIMEOUT_SECONDS` (`extension/src/bin/spawn-morty.ts:64`) and the 30_000 ms hang-guard grace (`:3099`) must be **imported** from the subject's source, not re-declared — otherwise the bundle recreates the magic-number defect one layer up. Both are currently module-private `const`s; exporting them is in scope and is the only permitted edit to `spawn-morty.ts`.

Do **not** convert `extension/tests/spawn-morty.test.js:347` (5000 ms): its test asserts the subject exits non-zero *within 5 s*, so the cap is the assertion. Any conversion rule must leave assertion-caps alone, and the resolver needs a distinct entry point for them.

**Acceptance criteria**

- `AC-A1` — **Every** heavy subprocess spawn in the two converted files derives its cap through the resolver, with no cap — literal or named constant — reaching `spawnSync` by another route, except the documented assertion-cap at `:347`. A table-driven acceptance test iterates the converted file set and asserts this per file. Phrased over derivation, not syntax: a grep for numeric literals is satisfied by hoisting a literal into a constant, which leaves the margin exactly as marginal (see Evidence → census).
- `AC-A2` — Each converted cap is at least 3× an **uncensored** WS-A0 duration for that test. Deriving from any Evidence-table kill time is forbidden.
- `AC-A3` — **No conversion lowers an existing cap.** For every converted callsite the new cap is `>=` the pre-conversion value, unless the ticket records a WS-A0 measurement justifying the reduction. A test asserts a `--timeout 5` subject yields at least 60000 ms (30 s effective + 30 s hang-guard grace), never 15000 ms. Counterexamples that must not break: `extension/tests/spawn-morty.test.js:563`, `:662`.
- `AC-A4` — The resolver imports `MIN_TIMEOUT_SECONDS` and the hang-guard grace from `extension/src/bin/spawn-morty.ts` rather than redeclaring either; a test fails if the imported value drifts from the resolver's assumption.
- `AC-A5` — `npx tsc --noEmit` and `npx eslint src/ --max-warnings=-1` are green.

### WS-D — Make the budget runner attribute failures per run

`extension/src/bin/check-flake-budget.ts` must report, per failing run, which tests failed in *that* run, and must make "same test N times" visually distinct from "N different tests once each".

Retaining full stdout for five runs of a ~5000-test tier is too large for memory: retain per-run failing-test names in memory, and write full per-run output to files whose paths are printed on failure.

Each per-run log must additionally retain **per-test durations** and each failing test's **`result.status`**. Those are the operator's only two discriminators between this defect class and a real regression, and both are already in hand at the point of capture (Evidence: 43829 ms pass vs 45044 ms fail, same test, same cap; `actual: null` vs `expected: 1`).

**Acceptance criteria**

- `AC-D1` — **For every** failing run the report emits that run's own failing-test names, that run's log path, and — across runs — an explicit repeated-failure marking. All three blocks are emitted from the single exceedance branch and cannot land independently, so this is one criterion. Verified by a table-driven test over the three report-shape cases, each driven through a stubbed `spawnSyncFn`.
- `AC-D2` — A stubbed run failing the same test three times marks it under `REPEATED ACROSS RUNS`; three distinct single-run failures omit that block entirely.
- `AC-D3` — Each per-run log records per-test durations and the failing test's `result.status`, with `null` rendered distinguishably from a numeric exit code.
- `AC-D4` — Exit-code semantics are unchanged: 0 within budget, 1 over.

### WS-E — Verification: run the claim under load

This bundle claims the fast tier stops exceeding its flake budget under load. A ticket must run that claim, not assert it. Green at rest was never the failing condition.

**Acceptance criteria**

- `AC-E1` — `npm run test:fast:budget` exits 0 with `runs_completed=5`, executed while host load average is ≥ 10, with the measured load recorded in the ticket artifact.
- `AC-E2` — The run's captured output is committed to the ticket's artifact directory, including the observed maximum duration for each test named in Evidence.
- `AC-E3` — For each such test the recorded duration is at most one third of its post-WS-A cap. **Conflict rule:** if AC-E3 fails against an AC-A2-conformant cap, the WS-E measurement supersedes WS-A0's, the caps are re-derived from it, and WS-A0's table is annotated as superseded. The bundle does **not** resolve this conflict by relaxing AC-E3.
- `AC-E4` — WS-E generates host load ≥ 10 and must not run concurrently with another pipeline in another repository. The ticket states this in its Entry Conditions.

## Interface Contracts

### WS-A resolver — `extension/tests/__helpers__/subprocess-cap.js`

```
resolveSubprocessCap(opts: {
  subjectTimeoutSeconds?: number;  // the subject's CLI --timeout, in seconds
  measuredMaxMs?: number;          // an uncensored WS-A0 completion duration
}): number                         // milliseconds, for spawnSync's `timeout`

resolveAssertionCap(ms: number): number  // identity, for caps that ARE the assertion
```

- **Inputs**: exactly one of `subjectTimeoutSeconds` or `measuredMaxMs`.
- **Outputs**: an integer millisecond cap computed by the formula above. `resolveAssertionCap` returns its input unchanged and exists so an assertion-cap is *marked* rather than merely exempted — a bare literal and a deliberate one must be distinguishable.
- **Errors**: neither, both, or a non-positive input throws a `TypeError` naming the offending field. A result above `MAX_SUBPROCESS_CAP_MS` throws a `RangeError` naming the input, the ceiling, and the callsite. Silent defaulting and silent clamping are both forbidden — either would reintroduce the invisible-margin defect in a new form.
- **Invariants**: the cap is strictly greater than the subject's **effective** budget plus hang-guard grace — not merely greater than the CLI argument. `3 <= MULTIPLIER <= 5`.

### WS-D report

- **Inputs**: unchanged (`--runs`, `--fail-budget`, `--timeout`).
- **Outputs**: the existing `FAIL_BUDGET_EXCEEDED` line; then per failing run a `RUN <i> FAILED:` block naming that run's failures with each one's duration and `result.status`; then `REPEATED ACROSS RUNS:` listing tests that failed in ≥ 2 runs (omitted when none did); then one `RUN <i> LOG: <path>` line per failing run.
- **Errors**: unchanged — a child failing before producing test output still throws with its first output line.
- **Invariants**: exit-code semantics unchanged. A test failing in exactly one run never appears under `REPEATED ACROSS RUNS`.

## Test Expectations

Note: `node:test` has **no** `describe.each` or `test.each` — both are `undefined` on this runtime. Table-driven cases use `for (const c of CASES) test(\`…${c}\`, …)`. Do not introduce a test framework to obtain `.each`; a dependency change inside a release-gate bundle is out of scope.

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-A0-1 | ticket artifact | Re-measurement is uncensored | Every recorded row has non-`null` `status`; a `null` row is re-run, not recorded |
| AC-A1 | `extension/tests/subprocess-cap-resolver.test.js` | Loop over converted files: every heavy spawn derives its cap | No `spawnSync` receives a `timeout` that is not a resolver result, except the marked assertion-cap |
| AC-A2 | `extension/tests/subprocess-cap-resolver.test.js` | Caps clear uncensored durations | Each converted cap ≥ 3× its WS-A0 completion duration |
| AC-A3 | `extension/tests/subprocess-cap-resolver.test.js` | Clamped subjects are not cut | `subjectTimeoutSeconds: 5` yields ≥ 60000 ms; no converted cap is below its pre-conversion value |
| AC-A3 | `extension/tests/subprocess-cap-resolver.test.js` | Resolver rejects ambiguous input | Neither / both / non-positive inputs each throw `TypeError` naming the field |
| AC-A4 | `extension/tests/subprocess-cap-resolver.test.js` | Constants are imported, not copied | Resolver's assumed `MIN_TIMEOUT_SECONDS` and hang-guard grace equal the values exported by `spawn-morty.ts` |
| AC-D1 | `extension/tests/flake-budget.test.js` | Loop over the three report blocks | Each of `RUN <i> FAILED`, `REPEATED ACROSS RUNS`, `RUN <i> LOG` is emitted; per-run names are that run's own; each log path exists |
| AC-D2 | `extension/tests/flake-budget.test.js` | Repeated vs distinct failures | Same test in runs 1–3 appears under `REPEATED ACROSS RUNS`; three distinct failures produce no such block |
| AC-D3 | `extension/tests/flake-budget.test.js` | Logs carry the discriminators | Each failing entry records a duration and a `status`, with `null` distinguishable from a numeric code |

## CUJ — operator triages a red `test:fast:budget`

1. Gate prints `FAIL_BUDGET_EXCEEDED failures=N budget=2 runs_completed=M runs_requested=5`.
2. Operator reads `REPEATED ACROSS RUNS:`. Present → candidate deterministic regression. Absent → candidate contention.
3. Operator opens `RUN <i> LOG: <path>` for the first failing run and finds the named test's duration and exit disposition.
4. Duration within 5% of its cap **and** `status: null` → this defect class; the cap is wrong, not the code.
5. Duration well under cap, or a real non-zero status → behavioural regression; bisect.

Steps 3–5 are why AC-D3 exists. Without durations and `status`, the operator's first branch point is a guess.

## Simplification Review

**What is removed rather than added?** 119-plus hardcoded literals collapse into one resolver. One workstream (serialization) is deleted as a verified no-op; another (the audit extension) is deferred rather than forced. The bundle got smaller as it got more correct.

**Is any workstream a guard over a broken mechanism instead of a fix?** That was exactly WS-C, and it is why WS-C is deferred: it guards a derivation that WS-A has not yet corrected, and would have reddened `pretest:integration` on its own. A guard belongs after the thing it guards is right.

**Could deletion solve it instead?** Adopted twice — serialization deleted, audit deferred. Rejected once: deleting the marginal tests would remove real coverage of backend recovery and worker-evidence handling. Also rejected: raising `--fail-budget`, which deletes the signal rather than the defect.

**Does this add an abort or halt condition?** No. The audit that would have gated pre-test is deferred. No runtime path gains a terminal state.

## Residuals

1. **The audit remains blind to Node-spawn callsites and to caps above 15000 ms.** Deferred here for three verified reasons (see Deferred). A follow-up bundle must sequence it as: fix the 5000 ms-band spill across the seven affected files → make `find_heavy_candidate` per-callsite → split the allowlist so serialization does not silence a ratio band → only then add the ratio band. Until then this defect class is detectable only by the gate going red.
2. **Only two of the 56-plus files are converted by WS-A.** The rest keep their literals and the class survives in them. The closing ticket must state which files were converted and which were not.
3. **`MAX_SUBPROCESS_CAP_MS` is a new ceiling with no measured basis.** It is a guard against a resolver returning something absurd (`--timeout 600` callsites at `extension/tests/spawn-morty.test.js:606`, `:963` would derive 1,800,000 ms). The value is a judgement call, not a measurement, and should be revisited once WS-A0 data exists.
4. **`extension/tests/spawn-morty.test.js:460`** passes `'--timeout'` followed by a spread of `['30junk'], ['3.5'], []` — including an absent value. Any budget-extraction rule must treat these as indeterminate rather than guessing.
5. **`INV-CODEX-RECOVERY-ADVANCED`** remains a genuine red integration test, undiagnosed across three bundles. Out of scope; belongs in the beta.10 notes rather than shipping quietly.
6. **Host load here comes substantially from other repositories' pipelines.** This bundle makes tests robust to that load; it does not reduce it, and no criterion here should be read as claiming otherwise.

## Build constraints

- Build via `/pickle-tmux`. This bundle edits the test harness and one gate-only source file, not the orchestrator's salvage or completion-evidence path, so it runs unattended — **except** that WS-E generates host load ≥ 10 and must not overlap another repository's pipeline.
- WS-A0 blocks WS-A. WS-A blocks WS-E. WS-D is independent.
- The release gate must be green from `extension/` before any tag; WS-E is the measurement that establishes that for the fast tier.
