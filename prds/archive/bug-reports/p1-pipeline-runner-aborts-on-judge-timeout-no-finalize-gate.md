# PRD: Pipeline-Runner Aborts on `judge_timeout` Despite Documented Recovery Contract — Recurrent Pipeline-Killer

**Status**: Bug PRD (2026-05-09) — pipeline-killer in `pipeline-runner.ts:1670`. After R-MJCP-1..8 shipped (commit `6851f41f`, this bundle's Section J) the probe path correctly distinguishes ETIMEDOUT from ENOENT. But a measurement-loop timeout (4 attempts, 60s/30s/60s backoff) STILL kills the pipeline because `pipeline-runner.ts` treats `judge_timeout` exactly like `judge_cli_missing` — both go through `isMicroverseFailureExit` → no-finalize-gate abort. The R-MJCP source PRD explicitly claimed `judge_timeout` already had correct downstream handling at line 1670 ("does NOT short-circuit no-finalize-gate for `judge_timeout`; the finalize-gate path runs normally"). It was wrong; the runtime says otherwise. Bit us today in session `2026-05-09-7ff82595` Phase 4/4 (szechuan-sauce) at iter 4.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**: `prds/archive/bug-reports/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md` (Open Finding #13, R-MJCP-1..8 — shipped `6851f41f`). That fix correctly classified the probe's ETIMEDOUT as `timeout` (not `cli_missing`), letting it fall through to the 4-attempt backoff loop. After the loop also exhausts, `judge_timeout` is the runner's exit. **R-MJCP-4 in that PRD claimed pipeline-runner.ts:1670 does NOT short-circuit no-finalize-gate for `judge_timeout`; the finalize-gate path runs normally and remediation cycles can recover the iteration.** That claim is contradicted by the actual `isMicroverseFailureExit` allowlist, which includes `judge_timeout`.
**Triggering session**: `2026-05-09-7ff82595` — `/pickle-pipeline --no-refine --backend claude prds/archive/bundles/p1-bug-fix-bundle-2026-05-08-mega.md`. Phase 4/4 (szechuan-sauce) baseline measured fine (history.len=1), iteration 1's metric measurement spent ~1h30m attempting + backing off, finally returned `judge_timeout`. Pipeline aborted at 22:33 UTC after 654m total runtime. Anatomy-park's 9 HIGH commits + szechuan's 1 DRY commit (`e14ca028`) survived in HEAD; the rest of szechuan's would-be deslop work is lost.

---

## Severity: P1

- **Pipeline-killer.** Same blast-radius class as Finding #13: anatomy-park converged work survives, szechuan-sauce is unrecoverable post-failure.
- **Recurrent.** This same code path bit session `2026-05-08-33d10614` (LOA-763) and now session `2026-05-09-7ff82595` (mega-bundle). Two pipelines in two days. Recurrence is timing-sensitive (cold-start LLM latency under load); same "when, not if" footing as Finding #13.
- **The R-MJCP fix didn't actually close the recovery gap** — it cleaned up classification but the downstream gate still slams.
- **Cost in session `2026-05-09-7ff82595`:** ~1h30m of szechuan-sauce worker time + 4 judge attempts wasted, plus the run's intended deslop work permanently un-shipped (only `e14ca028` lib/is-record extraction landed before the timeout).

---

## What was missed

### Smoking gun — pipeline-runner.log

```
[2026-05-09T21:02:16.128Z] PHASE 4/4: SZECHUAN-SAUCE (backend=claude)
[2026-05-09T21:02:16.131Z] szechuan-sauce: read citadel_report.json with 1 finding(s)
[2026-05-09T21:02:16.268Z] Szechuan Sauce setup complete
[2026-05-09T22:33:09.387Z] Phase szechuan-sauce exited with code 1
[2026-05-09T22:33:09.387Z] Phase szechuan-sauce: microverse exited with judge_timeout — pipeline aborting (no finalize-gate)
[2026-05-09T22:33:09.388Z] Pipeline finished: 3/4 phases, 654m 19s
```

`judge_timeout` produced verbatim per the R-MJCP-1 fix's improved classifier. Pipeline-runner consumed it and routed straight to `pipeline aborting (no finalize-gate)`.

### The disagreement between R-MJCP-4 (the spec) and the code

**R-MJCP-4 spec text** (from `prds/archive/bug-reports/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md`):

> Pipeline-runner unchanged; no new exit reasons. The fix lives entirely upstream of the `exit_reason` that `pipeline-runner.ts` consumes. After the fix, only a *real* missing CLI produces `judge_cli_missing`; a slow probe falls through to `judge_timeout` (after the 4-attempt backoff loop). `judge_timeout` already has correct downstream handling — `pipeline-runner.ts:1670` does NOT short-circuit no-finalize-gate for `judge_timeout`; the finalize-gate path runs normally and remediation cycles can recover the iteration.

**The actual code at `pipeline-runner.ts:1670`:**

```ts
const exitReason = runnerState.exit_reason as MicroverseExitReason | null | undefined;
if (exitReason && isMicroverseFailureExit(exitReason)) {
  log(`Phase ${rawPhase}: microverse exited with ${exitReason} — pipeline aborting (no finalize-gate)`);
} else {
  log(haltMsg);
}
```

**The allowlist `isMicroverseFailureExit` consumes** (`types/index.ts:648`):

```ts
const MICROVERSE_FAILURE_REASONS = new Set<MicroverseExitReason>([
  'error', 'rate_limit_exhausted', 'judge_unreachable', 'judge_timeout',
  'baseline_unmeasurable', 'judge_cli_missing',
]);
```

`judge_timeout` is in the allowlist. So R-MJCP-4's normative claim is wrong about the actual current behavior. Whether it was wrong-at-write-time or wrong-after-some-prior-change, the result is the same: a `judge_timeout` exit aborts the pipeline.

### Why baseline-vs-iteration matters here

Two call sites of `measureLlmMetricWithBackoff` in `microverse-runner.ts`:

- **Baseline** (line 1819-1832): coerces `judge_timeout` → `baseline_unmeasurable` before it reaches `state.exit_reason`. So a baseline-time timeout produces `baseline_unmeasurable`, which IS in the failure allowlist (correctly: no anchor → can't measure iterations).
- **Iteration** (line 2038-2064 in `measureLlmIteration`): preserves `judge_timeout` AS-IS via `return { kind: 'failed', exitReason }`. This propagates up to `state.exit_reason = exitReason`, hits `isMicroverseFailureExit` → no-finalize-gate.

This session: szechuan-sauce baseline measured fine (history.len=1 in microverse.json), then iteration measurement died after 4 retries. So we exit through the iteration-side path, with `judge_timeout` preserved.

---

## Root causes

### RC-1 — `judge_timeout` is in the failure allowlist alongside structurally-unrecoverable reasons

`MICROVERSE_FAILURE_REASONS` (types/index.ts:648) groups six reasons that prevent finalize-gate:

| Reason | Recoverable? | Why no-finalize-gate? |
|---|---|---|
| `error` | sometimes | catch-all; conservatively block finalize-gate |
| `rate_limit_exhausted` | yes (after wait) | LLM service issue |
| `judge_unreachable` | structural | judge LLM cannot be reached at all |
| `judge_timeout` | **yes — transient** | LLM degradation / network / load |
| `baseline_unmeasurable` | structural | no anchor → no comparison possible |
| `judge_cli_missing` | structural | binary not on PATH |

`judge_timeout` is structurally different from the other five. It's a transient resource issue: the judge IS reachable (the binary started, the API responded), it just took too long. The right recovery action is "wait, retry, or raise timeout" — not "abort pipeline irrevocably". The four other recoverable-but-blocked reasons (`error`, `rate_limit_exhausted`, `baseline_unmeasurable`, `judge_unreachable`) all warrant the conservative no-finalize-gate. `judge_timeout` does not.

### RC-2 — Finalize-gate would also probably time out

A counter-argument: if measurement timed out 4× in a row, finalize-gate's own LLM judge call probably also times out. So no-finalize-gate IS the right call.

But finalize-gate has different semantics:
- It runs ONCE (not 4 attempts).
- It uses a different prompt (final score, not per-iteration delta).
- It often has different timeout settings (operator-controlled).
- A timeout there fails ONE final measurement, not the whole pipeline.

The cost asymmetry: aborting on `judge_timeout` discards anatomy-park's hours of converged work AND the iteration commits szechuan made before the timeout. Running finalize-gate (and accepting it might also fail) at worst wastes ~1 more LLM call. The expected value of NOT aborting strictly dominates.

### RC-3 — No retry-with-escalating-timeout for `judge_timeout`

Even before deciding what pipeline-runner should do, microverse-runner could attempt one more measurement with a 2× timeout before declaring `judge_timeout`. The current 4-attempt loop uses fixed backoff between attempts (10s/30s/60s) but the per-attempt timeout (`measured.timeout_seconds`) stays constant. After 4 timeouts, an escalation to `2 × timeout_seconds` for one more attempt would catch transient LLM degradation that a 5x retry can't.

### RC-4 — Spec drift between R-MJCP PRD and `pipeline-runner.ts`

The R-MJCP-4 spec was authored under a working assumption that turned out to be wrong. Either the author read pipeline-runner's behavior at one point, the file changed later, or the assumption was theoretical without verification. Without a regression test asserting "pipeline-runner does NOT short-circuit on `judge_timeout`", future spec/code drift in this area is unguarded.

---

## Requirements

### R-PRJT-1 — Remove `judge_timeout` from `MICROVERSE_FAILURE_REASONS` allowlist

Edit `extension/src/types/index.ts:648`:

```ts
const MICROVERSE_FAILURE_REASONS = new Set<MicroverseExitReason>([
  'error', 'rate_limit_exhausted', 'judge_unreachable',
  'baseline_unmeasurable', 'judge_cli_missing',
]);  // 'judge_timeout' removed — transient, finalize-gate can recover
```

The `MicroverseExitReason` type itself still includes `judge_timeout`; only the failure-allowlist membership changes. Pipeline-runner's `else` branch (line 1672-1674) becomes the path for `judge_timeout` — it logs `haltMsg` (which includes the exit reason) and falls through to finalize-gate.

### R-PRJT-2 — Pipeline-runner explicit comment + log line for "judge_timeout — running finalize-gate anyway"

Edit `pipeline-runner.ts:1670` to handle `judge_timeout` distinctly:

```ts
if (exitReason && isMicroverseFailureExit(exitReason)) {
  log(`Phase ${rawPhase}: microverse exited with ${exitReason} — pipeline aborting (no finalize-gate)`);
} else if (exitReason === 'judge_timeout') {
  log(`Phase ${rawPhase}: microverse exited with judge_timeout — running finalize-gate anyway (transient measurement timeout, recoverable per R-PRJT-2)`);
} else {
  log(haltMsg);
}
```

This makes the recoverable-vs-structural distinction explicit at the call site, matching the spec language from R-MJCP-4.

### R-PRJT-3 — Trap-door entry pinned in `extension/CLAUDE.md`

> `bin/pipeline-runner.ts` (microverse exit-reason routing) — INVARIANT: `judge_timeout` is a TRANSIENT failure (LLM measurement exceeded timeout); pipeline-runner MUST run finalize-gate after `judge_timeout`. Other reasons in `MICROVERSE_FAILURE_REASONS` (judge_unreachable / baseline_unmeasurable / judge_cli_missing / rate_limit_exhausted / error) are structural — no-finalize-gate is correct for those. BREAKS: aborting on `judge_timeout` discards converged anatomy-park work + szechuan-sauce iteration commits over a transient LLM hiccup; cost ~hours of work + multi-hour wall clock per recurrence. ENFORCE: extension/tests/integration/pipeline-runner-judge-timeout-recovery.test.js.

### R-PRJT-4 — Regression test asserting pipeline-runner runs finalize-gate after `judge_timeout`

`extension/tests/integration/pipeline-runner-judge-timeout-recovery.test.js` (NEW) launches a synthetic 1-phase pipeline, stubs `microverse-runner` to exit with `state.exit_reason = 'judge_timeout'` after 1 iteration, and asserts:

1. `pipeline-runner.log` contains the `R-PRJT-2` log line ("running finalize-gate anyway").
2. `pipeline-runner.log` does NOT contain `aborting (no finalize-gate)`.
3. Finalize-gate process spawn is observed (mock or real).
4. Pipeline exits with the finalize-gate's exit code, NOT 1.

### R-PRJT-5 — Update R-MJCP-4 spec annotation in source PRD (closing-loop fix)

Append a follow-up note to `prds/archive/bug-reports/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md` § R-MJCP-4 noting that the assumption about pipeline-runner's behavior was wrong-at-write-time; this PRD is the closing-loop fix that makes the spec true. (Documentation hygiene; non-blocking for the fix itself.)

### R-PRJT-6 — Optional: per-attempt timeout escalation in `measureLlmMetricWithBackoff`

(OUT OF SCOPE for this PRD's atomic ship — track as follow-up.) After the 4-attempt backoff loop with fixed per-attempt timeout fails, microverse-runner could attempt one more measurement with `2 × timeout_seconds`. This would catch transient degradation that 5x retries can't. Filed for future bundle.

### R-PRJT-7 — Activity event for transient-recovery vs structural-abort distinction

`microverse-runner.ts` already emits an activity event with `event: exitReason` when measurement fails (line 2055-2063). Pipeline-runner should emit a complementary `pipeline_judge_timeout_recovery_attempted` event when it picks up `judge_timeout` and proceeds to finalize-gate per R-PRJT-2. Payload: `{phase, attempts, fall_through_to_finalize_gate: true}`. Standard event-registration quartet.

---

## Acceptance Criteria

- **AC-PRJT-01** — `MICROVERSE_FAILURE_REASONS` set in `types/index.ts` no longer contains `judge_timeout`. Verified by snapshot test.
- **AC-PRJT-02** — `pipeline-runner.ts:1670` handles `judge_timeout` distinctly with the R-PRJT-2 log line; `if/else if/else` shape committed verbatim.
- **AC-PRJT-03** — Regression test `extension/tests/integration/pipeline-runner-judge-timeout-recovery.test.js` passes per R-PRJT-4.
- **AC-PRJT-04** — Trap-door entry per R-PRJT-3 lives in `extension/CLAUDE.md` and is found by `extension/tests/trap-door-conformance.test.js`.
- **AC-PRJT-05** — Activity event `pipeline_judge_timeout_recovery_attempted` registered through full quartet (types + schema + fixture + count-assertion + deployed mirror).
- **AC-PRJT-06** — Manual reproduction: with stubbed `judge_model` that always times out, launch `/pickle-pipeline` against any small bundle PRD; pipeline-runner.log contains `running finalize-gate anyway`; finalize-gate executes; pipeline exits non-zero with finalize-gate's exit code.
- **AC-PRJT-07** — Forensic re-test: replay session `2026-05-09-7ff82595`'s exit signal against the patched binary; pipeline-runner.log shows `running finalize-gate anyway` instead of `aborting (no finalize-gate)`.
- **AC-PRJT-08** — Source PRD R-MJCP-4 annotated per R-PRJT-5 (documentation closing-loop).

---

## Out of scope

- Per-attempt timeout escalation (R-PRJT-6) — separate follow-up.
- Restructuring `MICROVERSE_FAILURE_REASONS` into a tagged enum with `recoverable: boolean` — overengineering for a 1-line allowlist edit.
- Finalize-gate retry / fallback logic — finalize-gate's own resilience is a separate concern.
- The R-MJCP fix that landed in `6851f41f` — that fix is correct as far as it goes; this PRD is the downstream closing-loop.

---

## Cross-references

- Predecessor (cleanup paired): `prds/archive/bug-reports/p1-microverse-judge-probe-misclassifies-timeout-as-cli-missing.md` (R-MJCP-1..8, shipped 6851f41f). R-MJCP-4 is the line item this PRD closes the loop on.
- Triggering session: `2026-05-09-7ff82595` running `prds/archive/bundles/p1-bug-fix-bundle-2026-05-08-mega.md`. Pipeline finished `failed` with 3/4 phases at 22:33 UTC after 654m.
- Code references:
  - `extension/src/types/index.ts:648` — `MICROVERSE_FAILURE_REASONS` allowlist (R-PRJT-1 edit site).
  - `extension/src/bin/pipeline-runner.ts:1669-1677` — exit-reason routing (R-PRJT-2 edit site).
  - `extension/src/bin/microverse-runner.ts:1448` — `judge_timeout` emit site (no change).
  - `extension/src/bin/microverse-runner.ts:2038-2064` — iteration-path exit propagation (no change; `judge_timeout` flows through correctly here).
  - `extension/src/bin/microverse-runner.ts:1819-1832` — baseline-path coercion to `baseline_unmeasurable` (no change; correct already).

---

## How to ship

Atomic ~1-2h fix:

1. R-PRJT-1: 1-line removal from `types/index.ts` set.
2. R-PRJT-2: 4-line edit to `pipeline-runner.ts` exit-reason routing.
3. R-PRJT-3: trap-door bullet in `extension/CLAUDE.md`.
4. R-PRJT-4: regression test (60-100 LOC; mocks microverse-runner exit).
5. R-PRJT-7: activity event registration quartet (~30 LOC across 5 files).
6. R-PRJT-5: documentation update to source PRD (5-min edit, atomic with this commit).

Worker time: 1-2h. Single commit. Bumps would-be deslop work that died in szechuan from "permanently lost" to "recoverable on next pipeline run".
