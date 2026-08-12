# BUG-2026-08-12 — Fast-tier subprocess tests fail on marginal spawn timeouts, and three separate mechanisms hide it

## Summary

The release gate is red at `npm run test:fast:budget` with `FAIL_BUDGET_EXCEEDED failures=3 budget=2 runs_completed=4 runs_requested=5`. Every one of the 13 pre-test gate steps is green, and `tsc`, `eslint`, and all ten audit scripts pass. The failure is confined to the fast tier's subprocess-heavy tests.

The failures are not logic errors. They are `spawnSync` timeout kills: the harness SIGTERMs a child that has not finished, `result.status` comes back `null` instead of the expected exit code, and the assertion reports a value mismatch that reads like a behavioural regression but is really a scheduling one.

Three separate mechanisms conspire to make this class both recurrent and unattributable:

1. Per-callsite `spawnSync` timeouts in the fast tier sit within seconds of the measured runtime of the very subprocess they bound.
2. `scripts/audit-subprocess-heavy-tests.sh` is structurally blind to this class — twice over.
3. `bin/check-flake-budget.js` discards each run's output, so its failure report is a union of test names across runs with no per-run attribution.

This PRD covers all three. Nothing here changes production runtime behaviour; the scope is the test harness and its audits.

## Evidence

Two instrumented fast-tier runs at `--test-concurrency=8`, worker environment scrubbed (`env -u PICKLE_TICKET_ID -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_COUNT`), on a 24-core host at load average 10–15:

| Run | Failing test | Duration | Callsite cap |
|---|---|---|---|
| 1 | `spawn-morty: recovers orphan tmp backend state before routing worker CLI` | 45037 ms | 45000 ms |
| 2 | `spawn-morty: recovers orphan tmp backend state before routing worker CLI` | 45036 ms | 45000 ms |
| 2 | `spawn-morty: test:fast failure with work evidence suppresses the Failed flip and preserves the commit` | 90187 ms | 90000 ms |
| 2 | `spawn-morty.hermes: spawns hermes chat with toolsets and completes` | 45044 ms | 45000 ms |
| 2 | `spawn-morty: recovers orphan tmp session timeout before printing worker budget` | 45031 ms | 45000 ms |

Every duration lands within 50 ms above its callsite cap. The assertion text confirms the mechanism rather than a behaviour change:

```
AssertionError [ERR_ASSERTION]: expected validation failure after codex shim exit
  actual: null
  expected: 1
  operator: 'strictEqual'
  at TestContext.<anonymous> (extension/tests/spawn-morty.test.js:735:16)
```

`actual: null` is `spawnSync`'s signal-kill result, not an exit code the subject produced.

The decisive datum is a passing test, not a failing one. In run 1, `spawn-morty.hermes: spawns hermes chat with toolsets and completes` **passed** at 43829 ms against its own 45000 ms cap — 1171 ms of headroom, 2.6% of the budget. In run 2 the same test failed at 45044 ms. The caps are not merely tight under exceptional load; at rest they are already within a rounding error of the observed runtime.

The subject in the most-repeated failure is invoked with `--timeout 30` (a 30-second worker budget) and bounded by a 45000 ms harness cap — a 15-second allowance for process startup, state-manager schema migration, and teardown, all of which the captured output shows occurring inside that window.

### Population

Across `extension/tests/*.test.js`, excluding `@tier: expensive`, there are **119 `spawnSync` callsites in 56 files** carrying an explicit timeout above 15000 ms. The concentration is uneven:

| File | Tier | Callsites > 15000 ms | Cap range |
|---|---|---|---|
| `extension/tests/spawn-morty.test.js` | fast | 24 | 45000 |
| `extension/tests/greenfield-corpus.test.js` | fast | 7 | 60000 |
| `extension/tests/mux-runner.test.js` | fast | 7 | 30000–150000 |
| `extension/tests/rrh-forward-ref-coverage.test.js` | fast | 7 | 20000 |
| `extension/tests/jar-codex.test.js` | fast | 6 | 25000 |
| `extension/tests/standup.test.js` | fast | 5 | 30000 |

`extension/tests/spawn-morty.test.js` carries every observed failure in this episode and is **not** listed in `extension/tests/integration/.serial-tests.json`, so all 24 of its heavy spawns run inside the `c=8` parallel surface.

**This census is an undercount, and the undercount is itself part of the defect.** It was produced by scanning for a numeric literal near a `spawnSync` callsite, so it sees only caps written inline. Caps bound to a named constant are invisible to it. Verified examples:

```
extension/tests/spawn-morty-worker-gate.test.js:13   const WORKER_TIMEOUT_MS = 90_000;
extension/tests/node-modules-reuse.test.js:12        const WORKER_TIMEOUT_MS = 90_000;
extension/tests/spawn-refinement-team.test.js:33     const REFINEMENT_SPAWN_TIMEOUT_MS = 120000;
extension/tests/auto-resume-stop-conditions.test.js:157  const WARN_BANNER_TIMEOUT_MS = 45000;
extension/tests/session-map-lock-release.test.js:24  const SPAWN_TIMEOUT_MS = 60_000;
```

`grep -rnE "^const [A-Z_]+_MS\s*=\s*[0-9_]{5,}" extension/tests/*.test.js` returns 19 such constants. The 90187 ms failure in this PRD's Evidence table is bounded by one of them — `WORKER_TIMEOUT_MS` in `extension/tests/spawn-morty-worker-gate.test.js` — which the literal census never reported.

Consequence for WS-A: an acceptance criterion phrased as "no five-digit literals remain" is satisfiable by moving a literal into a constant, which changes nothing about the margin. The criterion must be phrased over the derivation, not over the syntax. This is why AC-A1 below is an invariant rather than a grep count.

### Blind spot 1 — the audit cannot match these callsites

`extension/scripts/audit-subprocess-heavy-tests.sh:88` matches only:

```
/\bspawnSync\s*\(\s*['"](?:bash|sh)['"]\s*,\s*\[(?!\s*['"][^'"]*-)/g
```

Every failing callsite in this episode is `spawnSync(process.execPath, [...])` — a Node spawn, not `bash` or `sh`. The pattern never fires. All 119 callsites above are outside the audit's matchable set regardless of their timeout value.

### Blind spot 2 — the bands stop below the failing range

Even for callsites the pattern *can* match, `extension/scripts/audit-subprocess-heavy-tests.sh:23,27` define `SUBPROCESS_HEAVY_TIMEOUT_MS=5000` (FAIL) and `SUBPROCESS_HEAVY_WARN_MS=15000` (WARN). A timeout above 15000 ms exits as "not a candidate" — silently. The observed failures are at 45000 ms and 90000 ms, three to six times above the top of the WARN band. The audit's own comment claims it closes "the 10s blind spot"; it opened a 45s one.

Note that the two bands encode a real and correct intuition — a *low* cap on a subprocess spawn is dangerous. What is missing is the symmetric case: a cap that is high in absolute terms but low relative to what the subprocess actually takes. Absolute milliseconds cannot express that; the ratio can.

### Blind spot 3 — the budget runner destroys attribution

`extension/src/bin/check-flake-budget.ts:139-160` spawns each run, and on failure keeps only the extracted test names, accumulating them into a single `Set` (`failingTests.add(name)`, line 158). Neither `result.stdout` nor `result.stderr` is retained per run. The reported `FLAKY_TESTS` list is therefore a **union across all failing runs**, and cannot distinguish:

- the same test failing three times (a deterministic regression), from
- three different tests failing once each (contention).

Those two situations demand opposite responses, and the gate's own output cannot tell them apart. Reproducing the attribution by hand cost two full fast-tier runs — roughly 31 minutes — for information the gate already had in hand and threw away.

## Non-goals

- No change to any production code path under `extension/src/` other than `check-flake-budget.ts`, whose only consumer is the gate.
- Not a revert of the install.sh bundle. Nothing in this episode implicates it; all thirteen pre-test steps including the install audits are green.
- Not raising `--fail-budget`. Widening the tolerance for flakes is the opposite of fixing them, and would mask a future real regression.
- Not adding a second watchdog, retry wrapper, or auto-rerun layer over the test runner. Retries convert an attributable failure into an unattributable one.

## Workstreams

### WS-A — Derive spawn caps from the subject's own budget instead of hardcoding them

The 119 magic numbers are the defect, not their specific values. A cap of `45000` written next to a subject invoked with `--timeout 30` encodes a 15-second margin that no one chose deliberately and nothing re-checks when either number moves.

Replace the per-callsite literals in the fast tier with a single shared helper in the test-support layer that computes a cap from the subject's declared budget and a documented multiplier, so that a subject-timeout change propagates to its harness cap automatically.

Apply the helper to `extension/tests/spawn-morty.test.js` first — it holds 24 of the callsites and 100% of the observed failures. Then extend to the remaining fast-tier files enumerated above.

Where a callsite has no declared subject budget to derive from, the cap must be set from a measured value with explicit headroom, and the measurement recorded in a comment at the callsite.

This is a subtraction: 119 unrelated literals collapse to one resolver plus its callers.

**Acceptance criteria**

- `AC-A1` — **Every** heavy subprocess spawn in the converted files derives its cap through `resolveSubprocessCap`, with no cap — literal or named-constant — reaching `spawnSync` by any other route. Verified by a `describe.each` acceptance test parametrized over the converted file set, asserting per file that no `spawnSync` call receives a `timeout` that is not a resolver call result. The criterion is deliberately phrased over derivation rather than over syntax: a grep for numeric literals is satisfiable by hoisting a literal into a constant, which leaves the margin exactly as marginal as before (see Evidence → census undercount).
- `AC-A2` — For every callsite converted, the resulting cap is at least 3× the maximum duration observed for that test across the two runs recorded in this PRD's Evidence table.
- `AC-A3` — A test asserts the helper's derivation: given a subject budget of 30 s it returns a cap of at least 90000 ms, and the assertion names the ratio rather than the literal.
- `AC-A4` — `npx tsc --noEmit` and `npx eslint src/ --max-warnings=-1` are green.

### WS-B — Serialize the concentrated offender

`extension/tests/spawn-morty.test.js` runs 24 heavy Node spawns inside the `c=8` parallel surface and is absent from the serial manifest. Its siblings with the same shape — `tests/integration/spawn-morty-backend-resolution.test.js`, `tests/integration/spawn-morty-actual-session-bug.test.js` — are already listed.

Add it to `extension/tests/integration/.serial-tests.json`, or mark it with the `// SERIAL: <reason>` comment marker the audit already honours, whichever the runner's manifest semantics support for a non-`integration/` path. Verify which by reading `extension/bin/test-runner.js`, not by assuming.

**Acceptance criteria**

- `AC-B1` — `extension/tests/spawn-morty.test.js` is serialized by whichever mechanism the runner actually enforces, and a test asserts it is excluded from the parallel surface.
- `AC-B2` — The serialization is verified by observation, not declaration: a fast-tier run shows the file's tests not overlapping in wall-clock with each other.

### WS-C — Give the audit a ratio band and a Node-spawn pattern

Two changes to `extension/scripts/audit-subprocess-heavy-tests.sh`:

1. Extend `SUBPROCESS_HEAVY_PATTERN` to match `spawnSync(process.execPath, [...])` and equivalent Node-binary spawns, not only `bash`/`sh`.
2. Add a band that flags a cap by its **ratio to the subject's declared budget**, not by absolute milliseconds. A callsite invoking a subject with `--timeout 30` under a 45000 ms cap must be flagged; the same 45000 ms cap over a 5-second subject must not be.

The existing 5000 ms FAIL and 15000 ms WARN bands stay — they catch a different and real failure mode.

**Acceptance criteria**

- `AC-C1` — Running the audit against a fixture containing `spawnSync(process.execPath, [...], { timeout: 45000 })` over a `--timeout 30` subject exits non-zero and names the ratio.
- `AC-C2` — Running it against the same spawn over a `--timeout 5` subject exits zero.
- `AC-C3` — The audit is green against the tree as left by WS-A and WS-B.
- `AC-C4` — A test asserts both the positive and negative case, so the band cannot be silently widened to vacuity later.

### WS-D — Make the budget runner attribute failures per run

`extension/src/bin/check-flake-budget.ts` must report, for each failing run, which tests failed in *that* run — not a union. The report must make "same test N times" visually distinct from "N different tests once each".

Retaining full stdout for five runs of a ~5000-test tier is not acceptable in memory; retain per-run failing-test *names* (already extracted by `extractFailingTestNames`) keyed by run index, and write full per-run output to files under a temp directory whose paths are printed on failure.

**Acceptance criteria**

- `AC-D1` — **For every** failing run, the report emits that run's own failing-test names, that run's log path, and — across runs — an explicit repeated-failure marking. All three blocks are emitted from the single exceedance branch and cannot land independently, so they are one criterion, not three. Verified by a `describe.each` acceptance test parametrized over the report-shape cases `[['RUN <i> FAILED'], ['REPEATED ACROSS RUNS'], ['RUN <i> LOG']]`, each driven through a stubbed `spawnSyncFn`.
- `AC-D2` — A test drives the runner with a stubbed `spawnSyncFn` producing the same failing test in three runs and asserts it appears under `REPEATED ACROSS RUNS`; a second drives three distinct single-run failures and asserts the block is absent entirely.

### WS-E — Verification: run the claim

This bundle claims the fast tier stops exceeding its flake budget under load. A ticket must run that claim rather than assert it.

Re-run `npm run test:fast:budget` on this host under a synthetic load comparable to the one recorded in Evidence (load average 10–15 on 24 cores), and record the result. The bundle is not complete on a green run at rest — at rest was never the failing condition.

**Acceptance criteria**

- `AC-E1` — `npm run test:fast:budget` exits 0 with `runs_completed=5`, executed while host load average is at or above 10, and the measured load is recorded in the ticket artifact alongside the result.
- `AC-E2` — The captured output of that run is committed to the ticket's artifact directory, including the observed maximum duration for each test named in this PRD's Evidence table.
- `AC-E3` — For each such test, the recorded duration is at most one third of its post-WS-A cap.

## Interface Contracts

### WS-A — the cap resolver

Exported from the test-support layer (`extension/tests/helpers/` or the existing equivalent; the implementing ticket picks the file by reading what is already there, and states which).

```
resolveSubprocessCap(opts: {
  subjectTimeoutSeconds?: number;   // the subject's own --timeout, in seconds
  measuredMaxMs?: number;           // observed worst-case duration, when no subject budget exists
}): number                          // milliseconds, for spawnSync's `timeout`
```

- **Inputs**: exactly one of `subjectTimeoutSeconds` or `measuredMaxMs` must be supplied.
- **Outputs**: an integer millisecond cap. For `subjectTimeoutSeconds`, the result is `subjectTimeoutSeconds * 1000 * MULTIPLIER` with `MULTIPLIER >= 3`. For `measuredMaxMs`, the result is `measuredMaxMs * MULTIPLIER`.
- **Errors**: supplying neither, both, or a non-positive value throws a `TypeError` naming the offending field. A silent fallback to a default cap is forbidden — that would reintroduce the invisible-margin defect in a new form.
- **Invariants**: the returned cap is strictly greater than the input budget in every case; `MULTIPLIER` is defined once and is the only tunable.

### WS-C — audit ratio band

The audit gains one band expressed as a ratio, alongside the existing absolute bands.

- **Inputs**: a test file path.
- **Outputs**: on stderr, `RATIO-FAIL: <file>: cap <N>ms is <R>x subject budget <S>s (minimum 3x)` and process exit 1; or silence and the file's existing pass path.
- **Errors**: a callsite whose subject budget cannot be determined is not flagged by the ratio band (it remains the absolute bands' business); the audit must not guess a budget.
- **Invariants**: the existing 5000 ms FAIL and 15000 ms WARN behaviour is byte-identical for every file that does not trip the new band.

### WS-D — budget runner report

- **Inputs**: unchanged (`--runs`, `--fail-budget`, `--timeout`).
- **Outputs**: on budget exceedance, the existing `FAIL_BUDGET_EXCEEDED` line, then one `RUN <i> FAILED:` block per failing run listing that run's failing test names, then a `REPEATED ACROSS RUNS:` block naming every test that failed in two or more runs (omitted entirely when none did), then one `RUN <i> LOG: <path>` line per failing run.
- **Errors**: unchanged — a child that fails before producing test output still throws with its first output line.
- **Invariants**: exit code semantics are unchanged (0 within budget, 1 over). A test failing in exactly one run never appears in the `REPEATED ACROSS RUNS` block.

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-A3 | `extension/tests/subprocess-cap-resolver.test.js` | Resolver derives a cap from a subject budget | 30 s subject yields a cap ≥ 90000 ms; assertion references the multiplier constant, not the literal |
| AC-A3 | `extension/tests/subprocess-cap-resolver.test.js` | Resolver rejects ambiguous input | Neither / both / non-positive inputs each throw `TypeError` naming the field |
| AC-A1 | `extension/tests/subprocess-cap-resolver.test.js` | `describe.each` over the converted file set: every heavy spawn derives its cap | For each file, no `spawnSync` receives a `timeout` that is not a `resolveSubprocessCap` result — catches named constants, not only inline literals |
| AC-B1 | `extension/tests/bin/test-runner-tier-discovery.test.js` | Runner excludes the serialized file from the parallel surface | `spawn-morty.test.js` is absent from the parallel file set the runner builds |
| AC-C1 | `extension/tests/audit-subprocess-heavy-tests.test.js` | Ratio band flags a Node spawn with a marginal cap | Fixture with 45000 ms cap over a `--timeout 30` subject exits 1, stderr matches `RATIO-FAIL` |
| AC-C2 | `extension/tests/audit-subprocess-heavy-tests.test.js` | Ratio band does not flag a generous cap | Same 45000 ms cap over a `--timeout 5` subject exits 0 |
| AC-C4 | `extension/tests/audit-subprocess-heavy-tests.test.js` | Existing bands unchanged | A 4000 ms `spawnSync('bash', [script])` fixture still exits 1 with the pre-existing message |
| AC-D1 | `extension/tests/flake-budget.test.js` | `describe.each` over the three report blocks | For each of `RUN <i> FAILED`, `REPEATED ACROSS RUNS`, `RUN <i> LOG`, the exceedance branch emits the block; per-run names are that run's own, and each log path exists on disk |
| AC-D2 | `extension/tests/flake-budget.test.js` | Repeated vs distinct failures are distinguished | Same test failing runs 1–3 appears under `REPEATED ACROSS RUNS`; three distinct single-run failures produce no such block |

## Simplification Review

**What is being removed rather than added?** 119 hardcoded timeout literals collapse into one derivation helper (WS-A). The net line count of the test tree is expected to fall.

**Is any workstream adding a guard over a broken mechanism instead of fixing it?** WS-C adds an audit band, which is a guard. It is justified because the mechanism it guards — choosing a cap proportional to the subject — is being fixed in WS-A, and WS-C exists to stop the fix regressing. An audit that guards a fixed mechanism is a ratchet; an audit that guards a broken one is a fig leaf. This is the former, and WS-C's `AC-C3` (green against the WS-A tree) is what makes the distinction checkable.

**Could the problem be solved by deleting something instead?** Considered and rejected: deleting the marginal tests would remove real coverage of backend recovery and worker-evidence handling. Considered and adopted in part: `--fail-budget` was *not* raised, because tolerance-widening is deletion of the signal rather than of the defect.

**Does this add a new abort or halt condition?** No. WS-C's audit runs pre-test in the release gate, which is a gate on tagging, not a pipeline halt. No runtime code path gains a new terminal state.

## Residuals

- The remaining 32 fast-tier files with single heavy callsites (30000–150000 ms) are enumerated in Evidence but only reached by WS-A's second phase. If WS-A lands only the `spawn-morty.test.js` conversion, the rest stay on literals and this bug's class survives in them. Whichever ticket closes WS-A must state explicitly which files were converted and which were not.
- `INV-CODEX-RECOVERY-ADVANCED` remains a genuine red integration test, undiagnosed across three bundles. Out of scope here; it belongs in the beta.10 release notes rather than shipping quietly.
- Host load in this repository's environment comes substantially from other repositories' pipeline processes. This bundle makes the tests robust to that load; it does not reduce the load, and no acceptance criterion here should be read as claiming it does.

## Build constraints

- Build via `/pickle-tmux`. This bundle edits the test harness and its audits, not the orchestrator's salvage or completion-evidence path, so it runs unattended.
- The release gate must be green from `extension/` before any tag. This bundle's own WS-E is the measurement that establishes that for the fast tier.
