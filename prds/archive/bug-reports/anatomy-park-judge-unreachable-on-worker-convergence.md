# PRD: `validateWorkerConvergenceHistory` Returns `judge_unreachable` After Successful Worker-Managed Convergence (anatomy-park, szechuan-sauce)

**Status**: Bug PRD (2026-05-05) — production-blocking for any `/pickle-pipeline` run that includes anatomy-park or szechuan-sauce. Reproduced live during `pipeline-2026-05-04-8aecd4c7` (`/pickle-pipeline` over `INCOME_EXPANSION_FIX_PRD.md` in `loanlight-api-income-expansion`).
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**: `anatomy-park-finalizer-history-crash.md` (shipped v1.63.0, T1). Same root cause class — code that assumes `mvState.convergence.history` is populated under worker-managed convergence — different code path.

**Bundle scope**: This PRD now covers TWO related judge-unreachable defects in `microverse-runner.js`. Section 1 is the original anatomy-park `validateWorkerConvergenceHistory` bug (slot 1r). Section 2 is the `measureLlmMetric` timeout-as-stall conflation (slot 1s, surfaced 2026-05-05 in szechuan-sauce session `2026-05-05-af779f40`). Both share the same file and the same flawed assumption — that the judge can be silently bypassed without breaking convergence semantics. Bundling them keeps the fix coherent.

---

## Problem

`microverse-runner.js:validateWorkerConvergenceHistory()` (lines 447–474) is invoked from `handleWorkerManagedIteration()` (line 521) **after** the worker has signaled `converged: true` in its convergence file. The guard requires:

```js
const history = currentMv.convergence?.history?.filter(Boolean) ?? [];
const hasEnoughHistory = history.length >= requiredHistoryLength;
const hasScoredHistory = history.some(entry => entry.score !== null && entry.score !== undefined);
if (hasEnoughHistory && hasScoredHistory) return null;
```

For worker-managed phases (anatomy-park, szechuan-sauce) the metric type is `'none'` and the runner explicitly logs `Baseline measurement skipped — metric type 'none' has no measurement branch`. Nothing populates `mvState.convergence.history`. The guard's invariant cannot be satisfied. Result:

- `history.length === 0` and `hasScoredHistory === false`
- guard returns `{ converged: false, reason: 'judge unreachable: ...', exitReason: 'judge_unreachable' }`
- `handleWorkerManagedIteration()` returns `converged: false` despite the worker writing `converged: true`
- microverse-runner reaches max iterations (or stalls) and exits 1
- `pipeline-runner.js` sees the non-zero exit and aborts subsequent phases (`Phase anatomy-park failed (exit 1) — stopping pipeline`)
- **Szechuan-sauce never runs.**

The work was correct: the worker recorded 2 clean iterations, `consecutive_clean=3`, `converged: true`, 0 trap doors. The orchestrator threw it away.

### Live evidence (`pipeline-2026-05-04-8aecd4c7`)

`anatomy-park.json`:
```json
{
  "subsystems": ["packages"],
  "consecutive_clean": { "packages": 3 },
  "converged": true,
  "reason": "Confirmed across two iterations. ... no trap doors pending."
}
```

`microverse-runner.log`:
```
[02:10:24] Baseline measurement skipped — metric type 'none' has no measurement branch
[02:11:43] [anatomy-park] initialized per-iteration gate baseline (captured 4 pre-existing failure(s))
[02:11:43] --- Iteration 2 ---
[02:15:38] Iteration 2 — worker convergence signaled; running per-iteration gate before exit
[02:15:38] Iteration 2 — judge unreachable: convergence history length 0/1, scored=false
```

`pipeline-runner.log`:
```
[02:15:39] Phase anatomy-park exited with code 1
[02:15:39] Phase anatomy-park failed (exit 1) — stopping pipeline
[02:15:39] Pipeline finished: 2/4 phases, 186m 21s
```

---

## Root cause

The same architectural assumption that produced `anatomy-park-finalizer-history-crash` (shipped v1.63.0) reappeared in a guard added afterwards. Worker-managed convergence intentionally bypasses the `metric` track — the worker is the judge — but `validateWorkerConvergenceHistory` was written as if `convergence.history` is universally populated.

Two facts about the runtime that the guard ignores:

1. **Metric type `'none'`** disables `measureMetric()` entirely. Nothing writes to `convergence.history`. This is documented behavior, not a bug to compensate for.
2. **The worker's convergence file** (`anatomy-park.json` / `szechuan-sauce.json`) is the authoritative judge for worker-mode phases. It already encodes the audit trail (`findings_history`, `consecutive_clean`, `pass_counts`).

The guard belongs to the metric track, not the worker track.

---

## Fix

Skip `validateWorkerConvergenceHistory` when the microverse `metric_type` is `'none'` (or, equivalently, when the phase is one of the worker-managed phases). The worker's own convergence file is the source of truth — if it says `converged: true`, the orchestrator must honor it.

### Implementation outline (`extension/src/bin/microverse-runner.ts`)

```ts
// Before line 521 in handleWorkerManagedIteration():
if (converged) {
  const metricType = currentMv.metric?.type ?? currentMv.metric_type ?? 'none';
  if (metricType === 'none') {
    // Worker-managed phase: convergence file is authoritative; skip the metric-track guard.
    return { currentMv, converged: true, reason };
  }
  const guardResult = validateWorkerConvergenceHistory({ ... });
  if (guardResult) return { currentMv, ...guardResult };
}
```

Alternative gate: pin the guard to a known set of metric-mode microverse phases via an explicit allowlist (`['perf', 'coverage', 'lint']`) rather than excluding `'none'`. Either is acceptable; the test contract is identical.

---

## Acceptance Criteria (machine-checkable)

| ID | Criterion | Verify |
|----|-----------|--------|
| AC1 | When `metric_type === 'none'` and worker writes `converged: true`, `handleWorkerManagedIteration` returns `converged: true` | unit spec `validateWorkerConvergenceHistory skips on metric_type=none` passes |
| AC2 | When `metric_type === 'perf'` and `convergence.history` is empty after worker convergence, the existing `judge_unreachable` guard still fires | unit spec `validateWorkerConvergenceHistory still guards metric mode` passes |
| AC3 | Anatomy-park completes with exit 0 when the worker writes `converged: true` and 2+ clean iterations | integration spec replays a fixture matching `pipeline-2026-05-04-8aecd4c7/anatomy-park.json` and asserts exit 0 |
| AC4 | Szechuan-sauce phase runs in the pipeline-e2e fixture after anatomy-park converges | `tests/integration/pipeline-e2e.test.js` asserts `pipeline-status.json.completed_phases === 4` |
| AC5 | Existing finalizer-history guard still passes (regression check on the v1.63.0 sibling fix) | `tests/microverse-runner.test.js` and `tests/services/convergence-gate.test.js` green |
| AC6 | The `judge_unreachable` activity-log event still fires for legitimate metric-mode failures (not over-suppressed) | unit spec assertions on `logActivityFn.calls` for metric-mode case |

---

## Trap doors / known traps

1. **`metric_type` source-of-truth drift.** The microverse object exposes both `metric.type` (newer schema) and a top-level `metric_type` (older fixtures). The guard must read both with a deterministic precedence — recommend `currentMv.metric?.type ?? currentMv.metric_type ?? 'none'`.
2. **Default of `'none'`.** If `metric` is missing entirely, the safest default is `'none'` (worker-managed). Any phase running in metric mode sets it explicitly.
3. **Activity-log event parity.** Tests in `tests/services/activity-logger-gate-payload.test.js` may assert `judge_unreachable` is emitted on the original failure path. Update those tests so the worker-mode skip does NOT emit `judge_unreachable` — that event must remain a real-failure signal.
4. **Per-iteration gate independence.** The per-iteration gate hook (`runPerIterationGateHook`) runs before this guard and sets `iteration_regressions`. The fix must NOT skip the gate hook — only the post-hook history check. The order in `handleWorkerManagedIteration` already runs the hook first; preserve that.
5. **Phase-runner downstream.** `pipeline-runner.js:phase anatomy-park exited with code N` decides pipeline halt on `code !== 0`. Confirm the runner's exit code path returns 0 on legitimate worker convergence after the fix — test by inspecting `process.exitCode` at end of `runConvergenceLoop()` (microverse-runner.js).

---

## Verification commands (post-fix)

```bash
cd /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
npm test -- tests/microverse-runner.test.js
npm test -- tests/services/convergence-gate.test.js
npm test -- tests/integration/pipeline-e2e.test.js
npm test -- tests/anatomy-park-scope.test.js
bash install.sh
# Then re-run the failed pipeline (or a fixture replay):
node "$HOME/.claude/pickle-rick/extension/bin/pipeline-runner.js" \
  /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-04-8aecd4c7
# Expect: 4/4 phases completed, exit 0.
```

---

## Out of scope

- Refactoring the metric-track / worker-track split into clearly separated files (the right long-term fix; out of scope for this hotfix).
- Persisting a synthetic `convergence.history` entry from the worker's `findings_history` (not necessary; only delays the inevitable conflation).
- Backporting to older deployed versions — fix-forward via `bash install.sh`.

---

## Related

- `anatomy-park-finalizer-history-crash.md` (shipped v1.63.0, T1) — direct sibling.

---

# Section 2 — `measureLlmMetric` ETIMEDOUT silently bypasses the judge (slot 1s)

**Surfaced**: 2026-05-05 in szechuan-sauce session `2026-05-05-af779f40` (`/szechuan-sauce` over `loanlight-api-income-expansion` post-pipeline). Worker shipped 2 fixes (`06638de8`, `d8cdd846`) and self-reported "no actionable violations remain". Runner converged with `score=0` — but the judge **never produced a score** for either the baseline or iteration 2. Two consecutive `spawnSync claude ETIMEDOUT` failures were silently treated as a stall, and the runner declared convergence on the worker's word alone.

## Problem

`microverse-runner.js:measureLlmMetric()` (lines 793–833) shells out to `claude` (or `codex`) via `execFileSync` with a 300s timeout. On timeout, the function logs a single stderr line and returns `null`. The caller (`handleStandardIteration` / baseline measurement) then:

1. Logs `WARNING: Metric measurement failed — retrying once after 10s`.
2. Sleeps 10s, calls `measureLlmMetric` again.
3. On second timeout: logs `WARNING: Metric measurement failed twice — treating as stall (commit preserved)`.
4. Increments `stall_counter` and exits as **converged**.

Two consecutive timeouts reach the same exit path as a clean convergence: `exit_reason: "converged"`, `best_score: 0`. There is no signal in `state.json` or `microverse.json` distinguishing "judge agreed score=0" from "judge unreachable, fell back to last-known-score". The activity log gets a `WARNING:` line; nothing else.

### Live evidence (`2026-05-05-af779f40`)

`microverse-runner.log`:
```
[06:24:24] WARNING: Could not measure LLM baseline — defaulting to 0
[06:24:24] Gap analysis complete — transitioning to iterating
[06:34:20] WARNING: Metric measurement failed — retrying once after 10s
[microverse] measureLlmMetric failed (backend=claude, model=claude-sonnet-4-6): spawnSync claude ETIMEDOUT
[06:39:32] WARNING: Metric measurement failed twice — treating as stall (commit preserved)
[06:39:32] Converged after 2 iterations (stall_counter=1)
[06:39:32] microverse-runner finished. 2 iterations, 32m 48s, exit: converged
```

The baseline ALSO timed out (`Could not measure LLM baseline — defaulting to 0`). So no judge call ever returned a score in this entire session; the runner converged on the worker's TASK_NOTES.md self-report. In our case the worker happened to be right (post-hoc gate run confirmed the worktree is clean), but the runner had no way to verify.

## Why this is dangerous

The judge is the **only independent check** on worker self-reports. If a worker hallucinates "no violations remain" and the judge is unavailable, the runner accepts the hallucination. A future codebase change makes claude CLI cold-starts slower, every szechuan-sauce session converges on iteration 2 regardless of remaining violations, and the regression is invisible until a downstream phase fails.

## Root cause

Three composing flaws:

1. **Timeout-as-stall conflation.** A timed-out judge call should be treated as **inconclusive**, not as **stall** (which today is a path to convergence). The two outcomes are categorically different and must not share an exit branch.
2. **Insufficient retry budget.** One retry with a fixed 10s sleep is brittle for any 300s+ judge call. Exponential backoff (10s → 30s → 60s) with at least 3 attempts is the minimum for a process that takes 5+ minutes per call.
3. **No baseline-failure escalation.** When the baseline measurement fails (`defaulting to 0`), the entire metric track becomes meaningless: every subsequent score "matches" the baseline. The runner should fail-fast or block-on-baseline rather than silently zeroing it.

## Fix

Three changes in `microverse-runner.js`:

1. **Distinguish judge-unreachable from stall.** Add `exit_reason: 'judge_timeout'` (or reuse the existing `judge_unreachable` from Section 1). Two consecutive timeouts should exit non-zero with `exit_reason: 'judge_timeout'`, NOT `converged`. `pipeline-runner.js` halts on non-zero exit, which is the correct behavior — surface the failure, don't paper over it.
2. **Retry budget.** Replace the fixed-10s single retry with: `[10s, 30s, 60s]` exponential backoff, max 3 attempts. Total worst-case added latency: 100s (acceptable; the alternative is silent convergence on noise).
3. **Block-on-baseline.** If baseline measurement fails after retries, exit with `exit_reason: 'baseline_unmeasurable'`. Do NOT default to 0 — the entire metric track is invalid without a baseline.

### Implementation sketch (`extension/src/bin/microverse-runner.ts`)

```ts
async function measureLlmMetricWithBackoff(...args): Promise<JudgeResult | null> {
  const backoffsMs = [10_000, 30_000, 60_000];
  for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
    const result = measureLlmMetric(...args);
    if (result !== null) return result;
    if (attempt === backoffsMs.length) return null;
    await sleep(backoffsMs[attempt]);
  }
  return null;
}

// At baseline measurement site:
const baseline = await measureLlmMetricWithBackoff(...);
if (baseline === null) {
  return finalizeMicroverseRun({ exitReason: 'baseline_unmeasurable', exitCode: 1 });
}

// At iteration measurement site:
const score = await measureLlmMetricWithBackoff(...);
if (score === null) {
  return finalizeMicroverseRun({ exitReason: 'judge_timeout', exitCode: 1 });
}
```

## Acceptance Criteria (machine-checkable) — Section 2

| ID | Criterion | Verify |
|----|-----------|--------|
| AC7 | Two consecutive `measureLlmMetric` timeouts exit with `exit_reason: 'judge_timeout'`, not `converged` | unit spec `measureLlmMetric timeout escalates to judge_timeout exit` passes |
| AC8 | Baseline timeout exits with `exit_reason: 'baseline_unmeasurable'`, not `defaulting to 0` | unit spec `baseline measurement failure exits non-zero` passes |
| AC9 | Retry uses `[10s, 30s, 60s]` exponential backoff with 3 attempts max | unit spec `measureLlmMetricWithBackoff schedule matches [10000, 30000, 60000]` passes |
| AC10 | Worker-managed phases (anatomy-park, szechuan-sauce) propagate `judge_timeout` to pipeline-runner as exit code 1 | integration spec `pipeline-runner halts on judge_timeout from worker phase` passes |
| AC11 | `state.json` and `microverse.json` record the timeout reason in `exit_reason` distinctly from `converged` | spec asserts `exit_reason ∈ {'judge_timeout','baseline_unmeasurable'}` for the timeout cases |
| AC12 | `claude --version` and `codex --version` smoke-call probe runs before the first judge invocation; absence fails fast with `exit_reason: 'judge_cli_missing'` | unit spec `judge CLI presence is verified at session start` passes |

## Trap doors / known traps — Section 2

1. **Total wall-time growth.** Worst case the runner spends an extra 100s per iteration on retries before declaring `judge_timeout`. Multiply by `max_iterations` (50 default for szechuan-sauce) and the upper bound is ~83min added latency in pure-failure mode. The fix is correct; the operator should tune `max_iterations` accordingly.
2. **`exit_reason: 'judge_timeout'` is a NEW exit reason.** Audit `pipeline-runner.js`, `state-manager.js`, and any activity-log schemas for hardcoded enums. Add the new reason to `extension/types/index.js` activity events.
3. **Baseline-fail under worker-managed phases.** Section 1's fix already skips `validateWorkerConvergenceHistory` for `metric_type='none'`. The baseline-fail path here similarly should not fire on `metric_type='none'` (worker phases don't measure a baseline). Gate the new `baseline_unmeasurable` exit on `metric_type !== 'none'`.
4. **Activity-log line vs. structured signal.** Today's stderr `WARNING:` lines are unparseable by downstream tools. The new exit reasons must also emit structured `judge_timeout` / `baseline_unmeasurable` events via `logActivityFn` so dashboards and alerting can detect them.
5. **CLI-presence smoke (AC12).** A common cause of `ETIMEDOUT` on cold start is `claude` or `codex` binary not on PATH. A 50ms `--version` probe at session start fails fast instead of waiting 300s for the first measurement.

## Verification commands (post-fix) — Section 2

```bash
cd /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
npm test -- tests/microverse-runner.test.js
npm test -- tests/microverse-codex.test.js
npm test -- tests/integration/microverse-runner-judge-failure.test.js
bash install.sh
# Manual repro: induce timeout via PATH=/empty:$PATH (no claude binary).
# Expect: exit_reason='baseline_unmeasurable' or 'judge_cli_missing', exit code 1.
```

## Out of scope — Section 2

- Replacing the LLM judge with a deterministic toolchain gate. The judge is principle-driven; toolchain gates are syntactic. Both layers exist for a reason.
- Backporting `judge_timeout` to legacy session schemas — fix-forward via `bash install.sh`.

## Why bundle Sections 1 + 2

Both bugs live in `microverse-runner.js`. Both involve the judge being unreachable under worker-managed convergence. Both ship as a single PR touching the same file with overlapping test surface (`microverse-runner.test.js`, `convergence-gate.test.js`). Splitting them would force an arbitrary commit boundary in a single function's flow graph.
- `microverse-runner-stall-resilience.md` (shipped v1.63.0, T5).
- `anatomy-park-followups.md` Sub-fix A+C (shipped v1.63.0, T6+T2).
