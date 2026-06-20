# PRD: Microverse Judge-CLI Availability Probe Misclassifies ETIMEDOUT as `judge_cli_missing` (Pipeline-Killer)

**Status**: Bug PRD (2026-05-08) — pipeline-killer in `microverse-runner.ts`. The pre-measurement probe `probeJudgeCliAvailability` runs `claude --version` with a **50ms** timeout and treats ANY failure as "CLI missing" — including `ETIMEDOUT`, which is the dominant failure mode on macOS cold-start under load. The runner then exits with `judge_cli_missing`, and `pipeline-runner.ts:1670` honors that as a hard no-finalize-gate fail. Result: a single 50ms cold-start miss drops 30+ minutes of converged work.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**:
- `prds/archive/bug-reports/anatomy-park-judge-unreachable-on-worker-convergence.md` — judge unreachable on the *worker-managed convergence* path (different code path, same outcome family).
- Slot 1r/1s (`0d528507`, R-AJUR / R-MJU) — distinguishes `judge_timeout` from `stall` and exits `baseline_unmeasurable` for baseline failure. THAT fix did NOT cover the **probe** path that runs *before* `measureLlmMetricAttempt`.
**Triggering session**: `2026-05-08-33d10614` — `/pickle-pipeline docs/prd-shadow-audit-equivalence-diff.md --skip-refine` for LOA-763 (loanlight-api). Phase 2/2 (szechuan-sauce) baseline measurement aborted at iter 1 after probe `spawnSync claude ETIMEDOUT`.

---

## Severity: P1

- **Pipeline-killer**: silent false positive that classifies a *recoverable* timeout as an *unrecoverable* "missing CLI" condition.
- **Drops converged work**: anatomy-park had just shipped 7 CRITICAL fixes (URLA / red-flags / doc-expiration heap-order leaks, naturalKey under-discrimination, watermark advance on shadow_only insert error, watermark advance past DISCOVERY_LIMIT tied boundary, watermark advance past unexpired-grace deferred row, orphan-detection LIMIT without SQL dedup) over 33m 03s, converged at iter 3 with 2 consecutive clean passes. Szechuan-sauce was queued to consume that work. **It never started its first iteration** — it died inside its baseline measurement.
- **Timing-sensitive**: a 50ms cap on a Node child_process exec on macOS will fire spuriously under load. Recurrence is a question of *when*, not *if*.
- **No retry, no fallback**: `pipeline-runner.ts` short-circuits to `pipeline aborting (no finalize-gate)` for `judge_cli_missing`, intentionally avoiding remediation cycles. That contract is correct *only when the CLI is actually missing* — which the probe fails to verify.

---

## What was missed

### Symptom in the runner log

`/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-08-33d10614/microverse-runner.log` last lines:

```
[2026-05-08T21:21:13.659Z] Converged (worker-managed: All subsystems achieved 2 consecutive clean passes ...)
[2026-05-08T21:21:13.661Z] microverse-runner finished. 3 iterations, 33m 3s, exit: converged
[2026-05-08T21:21:13.950Z] microverse-runner started               # ← szechuan-sauce phase begins
[2026-05-08T21:21:14.030Z] Starting gap analysis phase
[2026-05-08T21:31:27.959Z] ERROR: Could not measure LLM baseline (judge_cli_missing) after 0 attempt(s): spawnSync claude ETIMEDOUT
[2026-05-08T21:31:27.960Z] microverse-runner exit: judge_cli_missing (spawnSync claude ETIMEDOUT)
[2026-05-08T21:31:27.962Z] microverse-runner finished. 1 iterations, 10m 13s, exit: judge_cli_missing
```

Pipeline-runner log:

```
[2026-05-08T21:31:27.965Z] Phase szechuan-sauce exited with code 1
[2026-05-08T21:31:27.965Z] Phase szechuan-sauce: microverse exited with judge_cli_missing — pipeline aborting (no finalize-gate)
[2026-05-08T21:31:27.966Z] Pipeline finished: 1/2 phases, 43m 23s
```

`microverse.json` ended:

```json
{
  "status": "stopped",
  "exit_reason": "judge_cli_missing",
  "baseline_score": 0,
  "convergence": { "stall_limit": 5, "stall_counter": 0, "history": [] }
}
```

The error message **literally says `spawnSync claude ETIMEDOUT`** — Node returned `ETIMEDOUT` because `execFileSync` exceeded its `timeout`. The classifier still labeled it `judge_cli_missing`.

### The misclassification

`measureLlmMetricAttempt` at `extension/src/bin/microverse-runner.ts:1326–1351` correctly distinguishes the failure modes:

```ts
const failureKind =
  isMissingCliError(err) ? 'cli_missing'           // ENOENT / "not found"
    : /\bETIMEDOUT\b/i.test(msg) ? 'timeout'       // exec timed out
      : 'failed';                                  // anything else
```

But the probe at `extension/src/bin/microverse-runner.ts:1354–1367` does NOT:

```ts
function probeJudgeCliAvailability(cwd: string): { ok: true } | { ok: false; message: string } {
  try {
    _deps.execFileSync('claude', ['--version'], {
      cwd,
      timeout: 50,                                  // ← 50 ms (!)
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...backendEnvOverrides('claude') },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: safeErrorMessage(err) };  // ← all errors collapsed
  }
}
```

And the caller at lines 1378–1387 promotes that single boolean into the most punitive of the three exit reasons:

```ts
const probe = probeJudgeCliAvailability(cwd);
if (!probe.ok) {
  return {
    metric: null,
    exitReason: 'judge_cli_missing',                // ← always cli_missing
    attempts: 0,
    lastError: probe.message,
  };
}
```

`exitReason: 'judge_cli_missing'` then propagates to `microverse.json:exit_reason`, which `pipeline-runner.ts:logPhaseHaltReason` (lines 1656–1678) treats as the no-finalize-gate condition.

### Why a 50ms probe misfires on macOS

`claude` is a Node CLI shipped via npm-installed JS bundle. A cold `execFileSync` on macOS pays:

1. **PATH lookup** — `which claude` against $PATH (often 20+ entries when nvm/asdf/homebrew/etc. all stack).
2. **dyld setup** — load Node binary + linked libs.
3. **V8 startup** — JIT init.
4. **CLI bootstrap** — Node parses Claude Code's index.js, reads env, registers signal handlers.
5. **`--version` print** — read package.json, write to stdout.

A warm `claude --version` on this box measures ~120–250ms; a cold one after 33 minutes of pipeline activity (during which `/var/folders/.../T` may have grown to 70k+ entries — see `67ae0348` from the post-Theme-A hardening sweep, same root cause family) can spike past 1s.

50ms is **below the floor** of "dyld + V8 init" on macOS even when nothing else is happening on the machine. The probe is structurally guaranteed to misfire under load.

### Why the existing retry-with-backoff loop doesn't save us

`measureLlmMetricWithBackoff` (lines 1369–1425) has a 4-attempt loop with `[10s, 30s, 60s]` backoffs that correctly distinguishes `cli_missing` (early-exit) from `timeout` (retry). But that loop runs ONLY if the probe says `ok: true`. The probe is a gate ahead of the resilient loop:

```
probe (50ms, no classification)
  → if !ok: exit 'judge_cli_missing' immediately, attempts: 0
  → if  ok: enter 4-attempt backoff loop with proper classification
```

The probe was added to fail-fast when `claude` is genuinely not installed (e.g. on a fresh VM where the operator forgot to install Claude Code). That intent is correct. The 50ms timeout AND the all-errors-are-missing classification are the implementation bugs.

---

## Root causes

### RC-1 — Probe timeout is below the macOS cold-start floor

`microverse-runner.ts:1358` hardcodes `timeout: 50` (milliseconds). For a Node CLI cold-start on macOS this is below the realistic floor by an order of magnitude. The probe was likely calibrated against a warm `claude --version` benchmark that doesn't represent the post-33-minute-pipeline state where the probe actually runs.

### RC-2 — Probe error path collapses ENOENT and ETIMEDOUT into one bucket

`probeJudgeCliAvailability` returns `{ ok: boolean }` — a single discriminator. The caller uses that boolean to choose `judge_cli_missing` unconditionally, even though the *actual* `execFileSync` error code distinguishes ENOENT (binary not on PATH), ETIMEDOUT (binary started but didn't reply in time), and other cases (permission, EAGAIN, etc.). Three failure modes squeezed into one exit reason.

### RC-3 — Pipeline-runner has no escape hatch for "judge probe was just slow"

`pipeline-runner.ts:1656–1678` correctly treats `judge_cli_missing` as a no-finalize-gate condition — there's no point running remediation cycles if the judge CLI is genuinely absent. But the runner has no separate handling for "the probe says missing but the underlying error was a timeout" — because the runner only sees the post-classification `exit_reason`, not the raw error. The misclassification is upstream; the runner faithfully amplifies it.

### RC-4 — No regression test for the probe error-classification contract

`extension/tests/bin/microverse-runner.test.js` has coverage for `measureLlmMetricAttempt` failure-kind classification (judge timeout vs cli_missing vs failed), but **no test that exercises `probeJudgeCliAvailability` against a stubbed `execFileSync` returning ETIMEDOUT**. The misclassification is therefore invisible to CI.

### RC-5 — No operator-facing diagnostic distinguishes "probe timed out" from "CLI missing"

When the probe fails, the operator sees `judge_cli_missing` in `microverse.json` and `microverse-runner.log`. Nothing in the logs says "the probe timed out at 50ms; the actual error was ETIMEDOUT, which means your CLI is installed but slow to start — try setting `PICKLE_JUDGE_PROBE_TIMEOUT_MS=5000`." The operator's first instinct is to verify `claude --version` manually, which obviously works (warm cache), making the bug look intermittent and hard to reproduce.

---

## Requirements

### R-MJCP-1 — Probe must classify ENOENT separately from ETIMEDOUT and other failures

`probeJudgeCliAvailability` must return a discriminated union, not a boolean:

```ts
type ProbeResult =
  | { kind: 'ok' }
  | { kind: 'missing'; message: string }      // ENOENT / "not found"
  | { kind: 'timeout'; message: string }      // ETIMEDOUT / SIGTERM
  | { kind: 'failed'; message: string };      // anything else
```

The caller (`measureLlmMetricWithBackoff`) must short-circuit to `judge_cli_missing` ONLY for `kind: 'missing'`. For `kind: 'timeout'` or `kind: 'failed'`, the caller MUST proceed to the existing 4-attempt backoff loop with its own (longer, more realistic) timeouts. If the loop also fails, it returns its own classification (`judge_timeout` or `judge_unreachable`), which `pipeline-runner.ts` already handles correctly.

### R-MJCP-2 — Probe timeout must be ≥ realistic cold-start floor; configurable

Default the probe timeout to **5000 ms** (5 seconds) — enough for a macOS cold-start `claude --version` even under load. Make it configurable via `PICKLE_JUDGE_PROBE_TIMEOUT_MS` for operators on slower hosts. Validate the env var (positive integer; clamp absurd values; log when override is in effect).

The probe is supposed to fail-fast when the CLI is genuinely absent. ENOENT returns ~10ms even on slow hosts — a 5000ms cap doesn't slow that path. It only changes behavior in the timeout-misclassification class this PRD addresses.

### R-MJCP-3 — Probe must use the same classifier as `measureLlmMetricAttempt`

Extract the classification logic that currently lives at `microverse-runner.ts:1346–1349` into a shared helper:

```ts
function classifyJudgeError(err: unknown): 'missing' | 'timeout' | 'failed' {
  if (isMissingCliError(err)) return 'missing';
  if (/\bETIMEDOUT\b/i.test(safeErrorMessage(err))) return 'timeout';
  return 'failed';
}
```

`probeJudgeCliAvailability` and `measureLlmMetricAttempt` MUST both consume this helper. No duplicate classifier branches.

### R-MJCP-4 — Pipeline-runner unchanged; no new exit reasons

The fix lives entirely upstream of the `exit_reason` that `pipeline-runner.ts` consumes. After the fix, only a *real* missing CLI produces `judge_cli_missing`; a slow probe falls through to `judge_timeout` (after the 4-attempt backoff loop). `judge_timeout` already has correct downstream handling — `pipeline-runner.ts:1670` does NOT short-circuit no-finalize-gate for `judge_timeout`; the finalize-gate path runs normally and remediation cycles can recover the iteration.

This requirement is explicit because previous fixes in this area (R-AJUR / R-MJU in slot 1r/1s, `0d528507`) added new exit reasons. THIS fix MUST NOT — the reasons are correct; only the classification feeding them is wrong.

#### R-MJCP-4 Closing Loop (R-PRJT-5, ticket `dcd17932`, 2026-05-09)

**The assertion above was wrong at write-time.** At the time this PRD was written, `judge_timeout` was a member of `MICROVERSE_FAILURE_REASONS` in `extension/src/types/index.ts:648`. That meant `isMicroverseFailureExit('judge_timeout') === true`, and `pipeline-runner.ts:1670` routed it to `pipeline aborting (no finalize-gate)` — the exact abort path this requirement claimed did not exist.

Ticket `dcd17932` is the closing fix:
- Removes `'judge_timeout'` from `MICROVERSE_FAILURE_REASONS`.
- Adds an explicit `else if (exitReason === 'judge_timeout')` branch in `logPhaseHaltReason` that returns `'run-finalize-gate'` instead of `'abort'`.
- `runPhaseIteration` now spawns `finalize-gate.js` when that signal is received.
- Regression test: `extension/tests/integration/pipeline-runner-judge-timeout-recovery.test.js`.

### R-MJCP-5 — Operator-facing diagnostic for timeout-class probe failures

When `classifyJudgeError` returns `'timeout'` in the probe path, the runner MUST log:

```
[microverse] judge probe timed out at <NNN>ms (claude --version exceeded probe timeout); falling back to measurement loop with 10s/30s/60s backoff. If this recurs, set PICKLE_JUDGE_PROBE_TIMEOUT_MS=10000 or higher.
```

This log line MUST go to both `microverse-runner.log` and stderr. Operators reading `microverse-runner.log` after a recovered run see the diagnostic; operators watching the live tmux pane see it inline.

### R-MJCP-6 — Regression test: stub ETIMEDOUT, assert no fast-fail

`extension/tests/bin/microverse-runner.test.js` (or a new `microverse-judge-probe.test.js`) MUST stub `_deps.execFileSync` for the probe to throw an `ETIMEDOUT`-class error and assert:

1. `probeJudgeCliAvailability` returns `{ kind: 'timeout', message: ... }`, NOT `{ kind: 'missing' }`.
2. `measureLlmMetricWithBackoff` does NOT return `exitReason: 'judge_cli_missing'` for that case.
3. `measureLlmMetricWithBackoff` enters the 4-attempt backoff loop and returns `exitReason: 'judge_timeout'` if the loop also fails.
4. Symmetric test for ENOENT — probe returns `{ kind: 'missing' }`, caller short-circuits to `judge_cli_missing` with `attempts: 0`.

### R-MJCP-7 — Trap-door entry pinned in `extension/src/bin/CLAUDE.md` (or `extension/CLAUDE.md`)

> `src/bin/microverse-runner.ts` (probe path) — INVARIANT: `probeJudgeCliAvailability` MUST classify ENOENT, ETIMEDOUT, and other errors via `classifyJudgeError`; only ENOENT-class produces `judge_cli_missing`. BREAKS: cold-start probe timeouts on macOS misclassified as missing CLI, killing pipelines that have completed converged phases. ENFORCE: extension/tests/bin/microverse-judge-probe.test.js.

### R-MJCP-8 — Document the probe-timeout-vs-measurement-timeout distinction

`extension/src/bin/CLAUDE.md` (or microverse subsystem doc) gains a short section explaining that `probeJudgeCliAvailability` is a fail-fast existence check (≥5s, ENOENT-only), distinct from `measureLlmMetricAttempt`'s correctness-check timeout (long, retry-with-backoff). Operators reading the source MUST be able to find this distinction without spelunking through git history.

---

## Acceptance Criteria

- **AC-MJCP-01** — `probeJudgeCliAvailability` returns a discriminated union with `kind: 'ok' | 'missing' | 'timeout' | 'failed'`. Default probe timeout is 5000 ms. `PICKLE_JUDGE_PROBE_TIMEOUT_MS` honored when set to a positive integer; logged when override applied.
- **AC-MJCP-02** — `measureLlmMetricWithBackoff` returns `exitReason: 'judge_cli_missing'` ONLY when probe returns `kind: 'missing'`. For `kind: 'timeout'` or `kind: 'failed'`, the function enters the existing backoff loop and returns the loop's classification.
- **AC-MJCP-03** — `classifyJudgeError` helper exists at module scope; both `probeJudgeCliAvailability` and `measureLlmMetricAttempt` call it. No duplicate `isMissingCliError(...) ? ... : /ETIMEDOUT/.test(...) ? ...` branches in the file.
- **AC-MJCP-04** — Regression test in `extension/tests/bin/` covers all four probe classifications + the caller's downstream behavior. Stubbed `execFileSync` for both ENOENT and ETIMEDOUT cases. Test name includes `judge_probe_classification`.
- **AC-MJCP-05** — Operator diagnostic log line emitted on timeout-class probe failure (verbatim per R-MJCP-5). Asserted by a test that captures stderr.
- **AC-MJCP-06** — Trap-door entry per R-MJCP-7 lives in the appropriate CLAUDE.md and is found by `extension/tests/trap-door-conformance.test.js`.
- **AC-MJCP-07** — `pipeline-runner.ts` is NOT modified. Pipeline-runner exit-reason handling remains identical (verified by `extension/tests/process-iteration-outcome.test.js` still passing without changes).
- **AC-MJCP-08** — Manual reproduction: with `PICKLE_JUDGE_PROBE_TIMEOUT_MS=1` (force the failure), launch `/szechuan-sauce` against any target. Pipeline logs the diagnostic from R-MJCP-5, falls through to the backoff loop, and (assuming claude is installed) proceeds to baseline measurement. With `PICKLE_JUDGE_PROBE_TIMEOUT_MS=5000` (default), reproduction is impossible on this box.

---

## Implementation sketch

```ts
// microverse-runner.ts

const DEFAULT_JUDGE_PROBE_TIMEOUT_MS = 5_000;

function resolveJudgeProbeTimeoutMs(): number {
  const raw = process.env.PICKLE_JUDGE_PROBE_TIMEOUT_MS;
  if (!raw) return DEFAULT_JUDGE_PROBE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 60_000) {
    process.stderr.write(`[microverse] PICKLE_JUDGE_PROBE_TIMEOUT_MS=${raw} ignored; using default ${DEFAULT_JUDGE_PROBE_TIMEOUT_MS}ms\n`);
    return DEFAULT_JUDGE_PROBE_TIMEOUT_MS;
  }
  return Math.floor(n);
}

function classifyJudgeError(err: unknown): 'missing' | 'timeout' | 'failed' {
  if (isMissingCliError(err)) return 'missing';
  if (/\bETIMEDOUT\b/i.test(safeErrorMessage(err))) return 'timeout';
  return 'failed';
}

type ProbeResult =
  | { kind: 'ok' }
  | { kind: 'missing'; message: string }
  | { kind: 'timeout'; message: string }
  | { kind: 'failed'; message: string };

function probeJudgeCliAvailability(cwd: string): ProbeResult {
  const timeoutMs = resolveJudgeProbeTimeoutMs();
  try {
    _deps.execFileSync('claude', ['--version'], {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...backendEnvOverrides('claude') },
    });
    return { kind: 'ok' };
  } catch (err) {
    const kind = classifyJudgeError(err);
    return { kind, message: safeErrorMessage(err) } as ProbeResult;
  }
}

async function measureLlmMetricWithBackoff(...): Promise<JudgeMeasurementResult> {
  const probe = probeJudgeCliAvailability(cwd);
  if (probe.kind === 'missing') {
    return { metric: null, exitReason: 'judge_cli_missing', attempts: 0, lastError: probe.message };
  }
  if (probe.kind === 'timeout') {
    process.stderr.write(
      `[microverse] judge probe timed out at ${resolveJudgeProbeTimeoutMs()}ms ` +
      `(claude --version exceeded probe timeout); falling back to measurement loop ` +
      `with 10s/30s/60s backoff. If this recurs, set PICKLE_JUDGE_PROBE_TIMEOUT_MS=10000 or higher.\n`
    );
  }
  // probe was 'ok', 'timeout', or 'failed' — fall through to existing backoff loop
  // (existing code from line 1389 onward unchanged)
  ...
}
```

---

## Out of scope

- Changing `measureLlmMetricAttempt`'s 4-attempt backoff schedule or per-attempt timeouts (already correct per R-AJUR / R-MJU).
- Adding a new exit reason for "probe timeout but measurement also failed" — `judge_timeout` is the correct downstream classification.
- Pipeline-runner changes — explicitly excluded by R-MJCP-4.
- Refactoring `microverse-runner.ts` god-function (separate followup; tracked under `prds/god-functions-remediation-phase-2.md`).

---

## Forensic appendix — session `2026-05-08-33d10614` timeline

```
20:48:04  pipeline-runner started (reconstruction after SIGINT recovery)
20:48:04  Phase 1/2 ANATOMY-PARK begins; scope locked to 58 paths on branch gregory/loa-763-shadow-audit-diff-writer
20:48:05  microverse-runner started (anatomy-park)
20:48:10  Starting gap analysis phase
21:04:36  Gap analysis complete — transitioning to iterating
21:04:36  --- Iteration 2 ---
21:14:23  Iteration 2 — worker convergence: not yet
21:14:24  --- Iteration 3 ---
21:21:13  Iteration 3 — worker convergence signaled; running per-iteration gate before exit
21:21:13  Converged (worker-managed: 2 consecutive clean passes; 7 CRITICAL fixes shipped)
21:21:13  microverse-runner finished. 3 iterations, 33m 3s, exit: converged
21:21:13  Phase anatomy-park completed successfully
21:21:13  Phase 2/2 SZECHUAN-SAUCE begins
21:21:13  microverse-runner started (szechuan-sauce)
21:21:14  Starting gap analysis phase
21:31:27  ERROR: Could not measure LLM baseline (judge_cli_missing) after 0 attempt(s): spawnSync claude ETIMEDOUT
21:31:27  microverse-runner exit: judge_cli_missing (spawnSync claude ETIMEDOUT)
21:31:27  Phase szechuan-sauce: microverse exited with judge_cli_missing — pipeline aborting (no finalize-gate)
21:31:27  Pipeline finished: 1/2 phases, 43m 23s
```

Note: `attempts: 0` is the smoking gun. The 4-attempt backoff loop *never executed*. The probe killed it before the resilient retry path could engage.

---

## Related work

- **R-AJUR / R-MJU** (slot 1r/1s, `0d528507`, 2026-05-06) — distinguishes `judge_timeout` from `stall`; exits `baseline_unmeasurable` for baseline failure. **Did not cover the probe path.** This PRD closes that gap.
- **`b0f5ceca`** (2026-05-07 hardening sweep) — defers stale-baseline refresh failures to post-commit recapture. **Different code path** (gate baseline, not judge baseline).
- **`67ae0348`** (2026-05-07 hardening sweep) — preloaded state to avoid redundant `readdirSync` hangs on macOS where `/var/folders/.../T` has 70k+ entries. **Same root cause family** (macOS slowness under load); orthogonal fix.
- **`prds/archive/bug-reports/anatomy-park-judge-unreachable-on-worker-convergence.md`** — judge unreachable on the worker-managed convergence path; sibling of this PRD on a different lifecycle phase.

---

## How to ship

1. **Standalone ticket** (recommended): file via `/pickle-tmux` or `/pickle` — single-file change in `microverse-runner.ts` + one new test file + one trap-door entry. Estimated 30–60 min worker time.
2. **Bundle** (alternative): fold into `prds/archive/bundles/p1-bug-fix-bundle-2026-05-08-mega.md` as Section K (currently Section J = closer; shift J → K and insert this as J). Operator decides at queue time.

Either path: regression test (R-MJCP-6) MUST be in the same commit as the production code change. Trap-door (R-MJCP-7) MUST be in the same commit. No separate "test follow-up" ticket — the entire fix is small enough to land atomically.
