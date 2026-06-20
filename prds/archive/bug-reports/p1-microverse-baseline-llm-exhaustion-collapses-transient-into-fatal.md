---
title: P1 — Microverse baseline LLM exhaustion collapses transient timeout into structurally-fatal class
status: Draft
filed: 2026-05-11
priority: P1
type: bug
finding: 26
r_codes:
  - R-MBLE-1
  - R-MBLE-2
  - R-MBLE-3
  - R-MBLE-4
  - R-MBLE-5
  - R-MBLE-6
  - R-MBLE-7
sister_prds:
  - prds/archive/bug-reports/p1-pipeline-runner-aborts-on-judge-timeout-no-finalize-gate.md
  - prds/archive/bug-reports/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md
  - prds/archive/bug-reports/p1-pipeline-runner-halts-on-pickle-fail-blocks-remediation-phases.md
  - prds/archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md
related:
  - prds/MASTER_PLAN.md
---

# PRD — Microverse Baseline LLM Exhaustion (R-MBLE)

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Problem

### Symptom

Szechuan-sauce phase 4/4 aborts the entire pipeline on the first iteration when the LLM judge baseline measurement times out, even though every per-attempt classifier in the surrounding backoff loop already distinguishes transient timeout from structural unrecoverable failure. Smoking-gun log line (session 2026-05-11-b7aad50b at 18:02:47Z):

```
ERROR: Could not measure LLM baseline (baseline_unmeasurable) after 4 attempt(s): spawnSync claude ETIMEDOUT
microverse-runner exit: baseline_unmeasurable (spawnSync claude ETIMEDOUT)
Phase szechuan-sauce: microverse exited with baseline_unmeasurable — pipeline aborting (no finalize-gate)
```

The pipeline ran ~3h13m through pickle (1h54m, 5 R-MMTR tickets shipped) + citadel (1 LOW informational finding) + anatomy-park (54m, 9 iterations, converged with 4 HIGH trap-door fixes) before szechuan-sauce died at iter 1 with `baseline_unmeasurable` after 26m24s and 4 backoff attempts. All four attempts hit `spawnSync claude ETIMEDOUT`. Pipeline-runner saw `baseline_unmeasurable` on the fatal allowlist and aborted with no finalize-gate.

### Root cause

`extension/src/bin/microverse-runner.ts:1927-1929` collapses every non-CLI-missing exit class into the structurally-fatal `baseline_unmeasurable` token via a binary ternary:

```ts
const exitReason: ExitReason = measured.exitReason === 'judge_cli_missing'
  ? 'judge_cli_missing'
  : 'baseline_unmeasurable';
```

The per-attempt classifier inside `measureLlmMetricAttempt` (`microverse-runner.ts:1346-1349`) already distinguishes three classes:

```ts
exitReason: isMissingCliError(err) ? 'cli_missing'
          : /ETIMEDOUT/.test(msg) ? 'timeout'
          : 'failed'
```

The all-attempts-exhausted aggregation discards `timeout` and routes it to `baseline_unmeasurable`, which is on the fatal allowlist at `extension/src/types/index.ts:677-680`:

```ts
const MICROVERSE_FAILURE_REASONS = new Set<MicroverseExitReason>([
  'error', 'rate_limit_exhausted', 'judge_unreachable',
  'baseline_unmeasurable', 'judge_cli_missing',
]);
```

Pipeline-runner consults this allowlist at `extension/src/bin/pipeline-runner.ts` line ~1670 via `isMicroverseFailureExit(exitReason)`. `baseline_unmeasurable` returns `true` → no finalize-gate, abort.

### Why this is structurally a transient class

Four sequential `spawnSync claude ETIMEDOUT`s in a single 26-minute window are the canonical fingerprint of API contention, cold-start latency, network blip, or concurrent-Claude-session rate sharing (the contention class Finding #25 R-CSI separately addresses). All four are recoverable on a subsequent attempt or via the finalize-gate's remediation phases. None are structurally unrecoverable.

The correct mapping is `judge_timeout` (transient — already OFF the fatal allowlist as of HEAD inspection 2026-05-11 PM) for the all-attempts-time-out case, with `baseline_unmeasurable` reserved for genuinely unrecoverable cases: judge CLI absent (covered by `judge_cli_missing`), judge model unsupported (`prds/archive/bug-reports/szechuan-sauce-codex-judge-model-mismatch.md` separately), schema invalid, or measurement function itself throwing non-timeout errors.

### Severity

P1 — szechuan-sauce is the pipeline's tail-phase remediation engine. A baseline-stage abort discards every remediation commit the phase was queued to ship. Recurrence is timing-sensitive (cold-start + API load + concurrent-session contention), matching the "when, not if" footing of Finding #13 (R-MJCP) and Finding #16 (R-PRJT). One confirmed incident in production (session 2026-05-11-b7aad50b); zero remediation commits beyond pre-phase HEAD.

### Sister-PRD landscape

| Finding | R-code | Layer | Status | Sister kind |
|---|---|---|---|---|
| #13 | R-MJCP | probe stage (claude --version short timeout) | Open (queue slot 6) | Upstream — probe-class fix, lets timeout fall through to backoff loop |
| #16 | R-PRJT | pipeline-runner fatal allowlist | Open (queue slot 9) | Same-file pair — sibling fix; bundle together |
| #22 | R-PHC | pipeline-runner halt-vs-continue policy | Open (queue slot 13, in-flight quintet) | Adjacent — anticipates a `baseline_unmeasurable_unrecoverable` split |
| #25 | R-CSI | concurrent-session destructive-command coordination | Open (queue, post-quintet) | Possible contributor to the 4 ETIMEDOUTs; R-MBLE-7 attribution event correlates |

## Scope

### Objective

One measurable goal: when all backoff-loop attempts of the LLM baseline measurement time out, the aggregated exit reason propagates the per-attempt classifier's `timeout` class up to pipeline-runner as a transient `judge_timeout`. Pipeline-runner runs finalize-gate against this class. Genuinely-unrecoverable baseline failures (CLI missing, model unsupported, schema invalid) continue to abort with no finalize-gate, via a split allowlist.

### Done looks like

- Running the szechuan-sauce phase against a working tree where every spawned `claude` call deliberately fails with ETIMEDOUT produces exit reason `judge_timeout` (transient) and runs the finalize-gate. Pipeline does not abort.
- Running the same phase against a working tree where every spawned `claude` call deliberately fails with ENOENT produces exit reason `judge_cli_missing` (structurally fatal) and pipeline aborts with no finalize-gate. Behavior unchanged from today.
- Running the same phase against a working tree where the judge model is unsupported produces a new `baseline_unmeasurable_unrecoverable` class on the fatal allowlist (split out from bare `baseline_unmeasurable`). Pipeline aborts with no finalize-gate. Behavior preserved for true unrecoverables.
- Loading a state.json file from a prior session whose `exit_reason` reads bare `baseline_unmeasurable` does not crash the state-manager and upgrades the value to `baseline_unmeasurable_unrecoverable` on read.
- `extension/CLAUDE.md` trap-door section pins both the aggregator switch and the allowlist split with ENFORCE entries verified by `bash extension/scripts/audit-trap-door-enforcement.sh` exiting 0.
- A regression test asserts the four classification cases above (4× ETIMEDOUT → `judge_timeout`; 1× ENOENT → `judge_cli_missing`; 1× UNSUPPORTED_MODEL → `baseline_unmeasurable_unrecoverable`; 1× SCHEMA_INVALID → `baseline_unmeasurable_unrecoverable`).
- Per-attempt observability: every timed-out attempt of the backoff loop emits a structured activity event so operators can correlate against `prds/archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md`'s destructive-command audit log when that lands.

### In-scope (this PRD)

- `extension/src/bin/microverse-runner.ts` aggregator at the all-attempts-exhausted exit site (currently lines 1927-1929).
- `extension/src/types/index.ts` `MicroverseExitReason` union and `MICROVERSE_FAILURE_REASONS` allowlist (currently lines 675-680).
- `extension/src/lib/state-manager.ts` backward-compat read-upgrade for legacy bare `baseline_unmeasurable` values.
- `extension/src/lib/activity-events.ts` (or wherever activity events are registered) addition of one new per-attempt event.
- `extension/CLAUDE.md` trap-door section.
- One new regression test under `extension/tests/`.

### Not-in-scope (filed for follow-up)

- Probe-stage classification (R-MJCP, separate PRD).
- Pipeline-runner fatal-allowlist `judge_timeout` removal (R-PRJT, separate PRD; sister fix bundles with R-MBLE).
- Concurrent-session destructive-command coordination (R-CSI, separate PRD).
- Replacing `claude` CLI spawning with a long-lived process pool (out of scope; separate research surface).
- Driving per-attempt timeout to zero by tuning the backoff schedule (the schedule itself is correct; the bug is classification, not duration).

## Functional Requirements

### R-MBLE-1 — Aggregator switch over per-attempt classifier output

The all-attempts-exhausted aggregation site in `microverse-runner.ts` switches over `measured.exitReason` (per-attempt classifier output) and maps `'cli_missing'` → `'judge_cli_missing'`, `'timeout'` → `'judge_timeout'`, every other class → `'baseline_unmeasurable_unrecoverable'`. The binary ternary at lines 1927-1929 is replaced.

Acceptance: a unit test that calls the aggregator with three mocked classifier outputs verifies the three-way mapping.

### R-MBLE-2 — Split fatal allowlist into transient and unrecoverable

`extension/src/types/index.ts` declares two new members of `MicroverseExitReason`: `'baseline_unmeasurable_transient'` and `'baseline_unmeasurable_unrecoverable'`. The legacy `'baseline_unmeasurable'` is retained in the union for backward-compat read but removed from `MICROVERSE_FAILURE_REASONS`. Only `'baseline_unmeasurable_unrecoverable'` is added to `MICROVERSE_FAILURE_REASONS`; `'baseline_unmeasurable_transient'` stays off the fatal allowlist (analogous to `'judge_timeout'`'s current position).

Acceptance: a unit test calls `isMicroverseFailureExit` against every member of `MicroverseExitReason` and asserts the new split. Set-equality on the allowlist, not hardcoded numbers (per Class A lesson from bundle 2026-05-10).

### R-MBLE-3 — Backward-compat read-upgrade in state-manager

`extension/src/lib/state-manager.ts` upgrades any `state.exit_reason === 'baseline_unmeasurable'` read from disk to `'baseline_unmeasurable_unrecoverable'` on the read path. Write path emits only the new tokens. No migration script needed; legacy state.json files load without crash.

Acceptance: a regression test loads a state.json fixture containing bare `'baseline_unmeasurable'` and asserts the in-memory value is the new unrecoverable token.

### R-MBLE-4 — Regression test for the four classification cases

A new test file under `extension/tests/` exercises four scenarios end-to-end (or with the smallest possible test double over the backoff loop):

1. All attempts hit ETIMEDOUT → exit reason `'judge_timeout'`, pipeline-runner does not abort (asserted via the existing `isMicroverseFailureExit` check returning false).
2. First attempt hits ENOENT → exit reason `'judge_cli_missing'`, pipeline-runner aborts (asserted via `isMicroverseFailureExit` returning true).
3. All attempts hit an unsupported-model error → exit reason `'baseline_unmeasurable_unrecoverable'`, pipeline-runner aborts.
4. All attempts hit a schema-invalid error → exit reason `'baseline_unmeasurable_unrecoverable'`, pipeline-runner aborts.

Acceptance: the test passes; `npm run test:fast` exit code 0.

### R-MBLE-5 — Trap-door pin

`extension/CLAUDE.md` adds two trap-door entries: one ENFORCE on the aggregator switch shape (no return to binary ternary); one ENFORCE on the allowlist composition (transient stays off, unrecoverable stays on). Both verified by `bash extension/scripts/audit-trap-door-enforcement.sh`.

Acceptance: the audit script exits 0; the two new ENFORCE entries are counted in its summary.

### R-MBLE-6 — Closer

Ticket that:
- Bumps version (delegated to bundle closer if this PRD ships inside a bundle).
- Closes Finding #26 in MASTER_PLAN; moves the entry to MASTER_PLAN-archive.
- Updates Finding #16 R-PRJT's MASTER_PLAN entry to reflect the sibling ship (or closes #16 outright if R-PRJT shipped in the same bundle).
- Auto-skips the version bump + release-gate if running inside a bundle whose closer handles those steps (per `prds/archive/bundles/p1-bug-fix-bundle-2026-05-12-mega.md` Section G if applicable).

Acceptance: MASTER_PLAN no longer lists Finding #26 in Open Findings; archive contains the entry verbatim.

### R-MBLE-7 (R-MAY) — Per-attempt activity event

Every iteration of the backoff loop that exits via ETIMEDOUT emits a structured activity event capturing attempt number, elapsed milliseconds, and the per-attempt classifier output. Event name: `baseline_attempt_timeout`. Sister observability hook for Finding #25 R-CSI's destructive-command audit log — when both ship, an operator can correlate sibling-session emissions against the 4 ETIMEDOUTs of a given szechuan baseline failure and either confirm or rule out concurrent-session contention as the root cause.

Acceptance: a unit test mocks four ETIMEDOUT attempts and asserts four `baseline_attempt_timeout` events are recorded. Event is registered in the canonical event registry (whatever symbol the surrounding code uses to maintain that registry — verification is set-equality against `Object.keys`, never a hardcoded count).

R-MAY: optional. Ships if straightforward; skipped if it adds material refactor cost.

## Interface Contracts

### Contract 1 — Aggregator return type

The aggregator at `microverse-runner.ts:1927-1929` returns a value drawn from `{'judge_cli_missing', 'judge_timeout', 'baseline_unmeasurable_unrecoverable'}` only. It never returns bare `'baseline_unmeasurable'`.

### Contract 2 — Allowlist composition

`MICROVERSE_FAILURE_REASONS` contains `'judge_cli_missing'` and `'baseline_unmeasurable_unrecoverable'` (among the existing members). It does not contain `'judge_timeout'` or `'baseline_unmeasurable_transient'` or bare `'baseline_unmeasurable'`.

### Contract 3 — State-manager backward-compat

`state-manager.ts` read path accepts state.json files written by any prior version. Bare `'baseline_unmeasurable'` is upgraded to `'baseline_unmeasurable_unrecoverable'` on read. Write path emits only the new tokens.

### Contract 4 — Per-attempt event registration (if R-MBLE-7 ships)

The new event is registered in the canonical activity-event registry. Verification asserts the registry's set of keys equals the canonical set plus this one new member.

## Verification Strategy

- Unit tests for the three-way aggregator switch.
- Unit test for the allowlist composition via set-equality.
- Regression test for the four classification cases.
- Backward-compat test for state-manager read-upgrade.
- Audit script (`audit-trap-door-enforcement.sh`) verifies the two new ENFORCE entries.
- `npm run test:fast` and `npm run test:integration` both pass.

## Test Expectations

- 1 new unit test file or 4 new test cases inside an existing nearby unit test file (`microverse-runner.test.js` or sibling).
- 1 new regression test file or 4 new cases in an existing regression suite.
- 1 new backward-compat test case in `state-manager.test.js`.
- Net new tests: 6-10. All in fast tier.

## Out-of-Band Concerns

- This PRD does NOT modify the backoff loop's retry count or per-attempt timeout. Those values are correct; the bug is purely in the exit-classification path above the loop.
- This PRD does NOT change pipeline-runner's `isMicroverseFailureExit` consumer. That consumer's behavior is correct given the new allowlist; only the type-level inputs change.
- If R-PRJT (Finding #16) ships in the same bundle, both PRDs touch `types/index.ts:MICROVERSE_FAILURE_REASONS`. Refinement orders the tickets so the set-equality assertions in each PRD's test match the post-edit state.

## Risk Register

- **R1**: Renaming `'baseline_unmeasurable'` could break monitor/log-parsing consumers that grep for the literal string. Mitigation: backward-compat read-upgrade in state-manager (R-MBLE-3); any monitor.js render template gets a one-line aliasing helper if needed.
- **R2**: Set-equality assertions over `MICROVERSE_FAILURE_REASONS` in this PRD's tests can conflict with the assertion in R-PRJT's test if they run against intermediate states during refinement. Mitigation: refinement orders the two PRDs so R-PRJT lands first (removing `judge_timeout` from the allowlist — already done at HEAD), then R-MBLE lands the split. Both PRDs' tests pass at the final state.
- **R3**: The new per-attempt event (R-MBLE-7) raises log volume during slow szechuan baselines. Mitigation: R-MBLE-7 is R-MAY; ship only if straightforward. The high-value event is the aggregated exit class change (R-MBLE-1), not per-attempt telemetry.

## Sister-PRD bundling recommendation

Bundle R-MBLE with R-PRJT (Finding #16, queue slot 9). Both touch `microverse-runner.ts` + `types/index.ts`, both close the same misclassification family ("transient subprocess class collapsed into structurally-fatal"), and both ship as a single closing-loop commit. Refinement should order R-PRJT's tickets ahead of R-MBLE's per-allowlist tests, so each test asserts against its post-edit state.

R-MBLE-7's activity event is the natural correlation surface for R-CSI Phase 1 (Finding #25); if R-CSI Phase 1 ships in the same bundle, the audit log + per-attempt event together attribute or rule out concurrent-session contention as a contributor to baseline ETIMEDOUTs.
