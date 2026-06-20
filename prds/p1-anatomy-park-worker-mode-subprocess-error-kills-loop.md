# PRD: Anatomy-Park Worker-Mode — Single 4h Subprocess Timeout Kills Entire Loop (P1)

**Status**: Bug PRD (2026-05-11) — anatomy-park (worker-convergence mode, `--backend codex`) silently terminates the **entire** session when **one** iteration's codex subprocess hits the `MAX_ITERATION_SECONDS=14_400` hang-guard, discarding 18+ hours of perfect progress.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**:
- `prds/p1-szechuan-sauce-llm-judge-non-deterministic-scoring-false-stalls.md` — szechuan false-stall via non-deterministic judge. Same `microverse-runner` family, different code path (judge result classification vs. subprocess error handling).
- `prds/archive/bug-reports/p2-szechuan-anatomy-finalize-gate-npmrc-warn-pollution-masks-real-failures.md` — finalize-gate WARN/FAIL conflation. Same lifecycle (worker-convergence + codex backend) but at a different stage (post-loop gate vs. mid-loop).
- `prds/archive/bug-reports/anatomy-park-judge-unreachable-on-worker-convergence.md` — judge unreachable on worker mode. Related: worker-mode loops have several places where the existing manager-mode assumptions leak through and cause spurious terminal exits.
- `prds/anatomy-park-followups.md` — running list of anatomy-park orchestrator hardening.

**Triggering session**: `2026-05-10-6ed7182b` — `/anatomy-park --backend codex` on `loanlight-api@gregory/1025-appraisal-epic`. R3 of pipeline. Hit on iter 111/200 at `2026-05-11T10:28:15.694Z` after 19h25m wall clock.

---

## Severity: P1

**Why P1, not P2:**
- A single slow iteration kills a multi-hour worker-convergence loop. R3 produced **86 trap-door commits + 101 cataloged findings** before the kill — none lost (commits persisted), but the loop itself unrecoverable without manual relaunch and full-session re-warmup.
- Codex/gpt-5.4 produces variable-latency output. Output starvation events (long-tail slow streaming) are NOT pathological backend failures — they're an expected part of the latency distribution. The runner currently treats them as fatal.
- Worker-convergence-mode loops (anatomy-park, szechuan-sauce, microverse, plumbus) all run on the same `microverse-runner.ts` and inherit this terminal exit on any single iteration error. Impact surface is the entire convergence family.
- The kill path is **silent** — `state.json.exit_reason = "error"`, `last_error: null`. Operator only learns about it by manual log archaeology.

---

## Reproduction

**Conditions:**
1. Backend = `codex` (`--backend codex` or `PICKLE_BACKEND=codex`)
2. Convergence mode = `worker` (anatomy-park, szechuan-sauce when worker-managed)
3. Single iteration codex subprocess takes >= 14_400 seconds (4h) wall clock — either genuine hang OR slow output streaming
4. Session has no ticket queue (anatomy-park subsystems are NOT tickets)

**Observed signal:**
```
[2026-05-11T06:28:15.661Z] --- Iteration 111 ---
[2026-05-11T10:28:15.694Z] Subprocess error. Exiting loop.
[2026-05-11T10:28:15.697Z] microverse-runner finished. 111 iterations, 1165m 23s, exit: error
```
Iter 111 produced **1,137 lines in 4 hours** vs. neighbors:
- iter 108: 9,832 lines / ~5 min
- iter 109: 16,481 lines / ~5 min
- iter 110: 11,258 lines / ~6 min

Output never stopped — just slowed to ~0.08 lines/sec. No useful progress visible in the partial log (codex appears wedged dumping cached JSON findings).

---

## Root Cause Analysis

### Proximate cause
`mux-runner.ts:1387-1398` — wall-clock hang-guard:
```ts
const hangGuardMs = Defaults.MAX_ITERATION_SECONDS * 1000;  // 14_400_000 = 4h
const hangGuard = setTimeout(() => {
  if (settled) return;
  settled = true;
  didTimeout = true;
  try { proc.kill('SIGTERM'); } catch { /* already dead */ }
  // ...
  resolve({ completion: 'error', timedOut: true, exitCode: null, wallSeconds: ... });
}, hangGuardMs);
```

Fires at exactly 4h. Subprocess is SIGTERM'd. Outcome resolves with `completion: 'error'` AND `timedOut: true`.

### Routing failure
`microverse-runner.ts:2580-2624` — `handleIterationOutcome`:
```ts
if (exitResult.type === 'timeout' && outcome.completion !== 'error') {
  ctx.log('Worker timeout. Exiting loop.');
  return 'error';
}
// ... falls through ...
if (outcome.completion === 'error') {
  return handleManagerErrorOutcome(ctx);
}
```

Branch at line 2610 **skips** the worker-timeout exit because completion IS `'error'` (set by the hang-guard). Falls through to line 2618 `handleManagerErrorOutcome`.

### Relaunch evaluator wrong-mode mismatch
`microverse-runner.ts:2557-2578` — `handleManagerErrorOutcome`:
```ts
const decision = evaluateCodexManagerRelaunch(
  postState,
  collectTickets(ctx.sessionDir),  // ← anatomy-park has NO tickets
  null,
);
if (decision.shouldRelaunch) { /* relaunch */ }
ctx.log('Subprocess error. Exiting loop.');
return 'error';
```

`collectTickets(ctx.sessionDir)` is a file-system walk for ticket directories (`<session>/<ticket-slug>/`). anatomy-park stores convergence state in `anatomy-park.json` — there is no per-iteration ticket directory. The walk returns `[]`.

`evaluateCodexManagerRelaunch` (`services/codex-manager-relaunch.ts:75-78`):
```ts
const pending = pendingInput.filter(ticketIsPending);
if (pending.length === 0) {
  return { shouldRelaunch: false, ..., reason: 'no_pending' };
}
```

Returns `no_pending` before even checking the relaunch cap. **The relaunch escape hatch literally cannot fire for any worker-convergence-mode loop.**

### Why this is a design bug, not a config bug

The relaunch path was designed for `mux-runner` codex tmux_mode (`extension/src/types/index.ts:316-323`):

> Codex tmux_mode runs ONE long-lived manager that loops across many tickets internally; the 4h `MAX_ITERATION_SECONDS` hang-guard SIGTERMs that subprocess and resolves `{ completion: 'error', timedOut: true }`, which the loop would otherwise treat as terminal.

The comment correctly identifies the failure mode for the **manager+tickets** case and built a relaunch escape hatch. But `microverse-runner.ts` reuses the same path for **worker+subsystems** without the equivalent escape hatch:
- Worker-convergence loops have their own per-subsystem `stall_counts` model
- A single iteration timeout should advance the subsystem rotation and increment the stall counter
- Bail only after N **consecutive** subprocess errors (matching the existing stall semantics)

### Contributing factors

1. **No output-progress detection**: hang-guard watches wall clock only. 4h of slow streaming and 4h of total silence are indistinguishable. iter 111 was producing 1137 lines of output — the subprocess was alive, just slow.
2. **Worker timeout disabled for these loops**: `microverse-runner.ts:2634` explicitly logs `"Worker timeout disabled — session time limit is the only gate"` and clamps `worker_timeout_seconds = 0`. The shorter 20-min worker timeout (`Defaults.WORKER_TIMEOUT_SECONDS=1200`) which WOULD have caught this earlier and routed through the `completion !== 'error'` branch (graceful exit) is intentionally bypassed.
3. **Silent failure mode**: `state.json` records `exit_reason: "error"` but `last_error: null`, `last_finalize_gate: null`, `last_remediator: null`. Operator must read tmux-runner/microverse-runner log files to learn what happened.
4. **No exit notification**: no monitor banner, no `logActivity` event tagged for operator visibility, no slack/email/desktop notification. Session just dies in the night.

---

## Acceptance Criteria

### R-APMW-1: Reproduce and characterize the failure path
- **Test**: unit test in `extension/src/bin/__tests__/microverse-runner.handleIterationOutcome.spec.ts`
- Construct an `IterationRunOutcome` with `completion: 'error'`, `timedOut: true`
- Mock `collectTickets()` to return `[]`
- Mock state with `convergence_mode: 'worker'` and backend `codex`
- Assert: `handleIterationOutcome` currently returns `'error'` (failing case captured)

### R-APMW-2: Add `handleWorkerSubprocessError` path
- **Code**: `microverse-runner.ts` — new branch in `handleIterationOutcome` BEFORE `handleManagerErrorOutcome`:
```ts
if (outcome.completion === 'error' && state.convergence_mode === 'worker') {
  return handleWorkerSubprocessError(state, ctx, outcome, stallClassification);
}
```
- `handleWorkerSubprocessError`:
  - Increments `consecutive_subprocess_errors` in state
  - If `>= Defaults.WORKER_CONSECUTIVE_ERROR_CAP` (new constant, default 3) → exit `'error'` with explicit log
  - Otherwise: marks the active subsystem as stalled (if `worker_convergence_file` exposes one), logs `"Worker iteration N errored — advancing rotation (count K/CAP)"`, returns `'continue'`
- **Test**: 3 sub-tests: returns `'continue'` on first/second error, returns `'error'` on third
- **Test**: state's `consecutive_subprocess_errors` resets to 0 after a successful iteration

### R-APMW-3: Define `Defaults.WORKER_CONSECUTIVE_ERROR_CAP`
- **Code**: `extension/src/types/index.ts`
```ts
/** Worker-convergence-mode: bail after N consecutive subprocess errors. */
WORKER_CONSECUTIVE_ERROR_CAP: 3,
```
- **Test**: type-level test that constant is `>= 2 && <= 10`

### R-APMW-4: Wire `consecutive_subprocess_errors` into MicroverseState
- **Code**: `extension/src/types/index.ts` — add field
- **Code**: `microverse-runner.ts` — reset to 0 on `exitResult.type === 'success'`
- **Test**: state persistence round-trip preserves field across reads/writes

### R-APMW-5: Surface error visibility
- **Code**: `microverse-runner.ts` — on subprocess error, write to `state.json`:
  - `last_error: { iteration, timestamp, completion, timedOut, wallSeconds }`
  - `last_subprocess_error: { ... }`
- **Code**: emit `logActivity({ event: 'subprocess_error', iteration, completion, timedOut })` so it shows up in `/pickle-metrics`
- **Test**: assert `state.json` contains both fields after the failure path

### R-APMW-6: Add output-progress hang detection (separate from wall clock)
- **Code**: `mux-runner.ts:1380-1445` — track `lastDataAt` timestamp inside data handlers. Add second `setTimeout` that fires after `Defaults.OUTPUT_STALL_SECONDS` (new, default 1800 = 30 min) of zero output → SIGTERM with a distinct reason.
- **Code**: extend `IterationRunOutcome` with `stallReason?: 'wall_clock' | 'output_stall'`
- **Test**: unit test with a mocked subprocess that emits output every 60s for 5 cycles, then stops → assert hang-guard fires at OUTPUT_STALL_SECONDS+epsilon, not at MAX_ITERATION_SECONDS
- **Test**: unit test with a mocked subprocess that emits output every 10s for the full 4h → wall-clock hang-guard fires at MAX_ITERATION_SECONDS

### R-APMW-7: Document the new state machine
- **Code**: add diagram comment to `handleIterationOutcome` showing the new branching
- **Code**: update `extension/CLAUDE.md` worker-convergence section with the new error-handling contract

### R-APMW-8: Integration test — full anatomy-park loop with injected timeout
- **Test**: spawn a real microverse-runner against a tiny fixture session. Inject a mock backend that emits `{ completion: 'error', timedOut: true }` once at iter 5, then resumes normally.
- Assert: session continues past iter 5, completes naturally, final state shows `consecutive_subprocess_errors: 0` and `last_subprocess_error.iteration: 5`

### R-APMW-9: Operator notification (optional, P2)
- On `handleWorkerSubprocessError` returning `'error'` (cap exhausted), trigger a notification: desktop notification on macOS via `osascript`, or write to `~/.claude/pickle-rick/notifications.log`. Gated by `PICKLE_NOTIFY_ON_ERROR=1`.
- **Test**: env var off → no notification; env var on → notification written to log

---

## Non-Goals

- **Not** raising `MAX_ITERATION_SECONDS`. 4h is already generous; the bug is in how the timeout is handled, not its value.
- **Not** rewriting `evaluateCodexManagerRelaunch`. That function is correct for its mux-runner manager+tickets use case. The fix is to add a sibling path for worker-convergence mode.
- **Not** implementing automatic session-resume (`/pickle-retry` already exists for that). This PRD only addresses **in-session** error recovery.

---

## Evidence Bundle

**Session**: `~/.local/share/pickle-rick/sessions/2026-05-10-6ed7182b`
**Key files**:
- `state.json` — `{ active: false, iteration: 111, exit_reason: "error", last_error: null }`
- `microverse-runner.log` (last 5 lines):
  ```
  [2026-05-11T06:28:15.661Z] --- Iteration 111 ---
  [2026-05-11T10:28:15.694Z] Subprocess error. Exiting loop.
  [2026-05-11T10:28:15.697Z] microverse-runner finished. 111 iterations, 1165m 23s, exit: error
  ```
- `tmux_iteration_111.log` — 1137 lines, 76K, ends mid-token inside a JSON array (codex was streaming when killed)
- `anatomy-park.json` — final ledger: 86 trap_doors_committed, 101 findings, `schemas` converged, `xml` sealed (scope-blocked), 3 subsystems still finding HIGH issues

**Code references** (pickle-rick-claude@main):
- `extension/src/bin/mux-runner.ts:1387-1398` — hang-guard
- `extension/src/bin/microverse-runner.ts:2557-2578` — `handleManagerErrorOutcome`
- `extension/src/bin/microverse-runner.ts:2580-2624` — `handleIterationOutcome` routing
- `extension/src/services/codex-manager-relaunch.ts:75-78` — `no_pending` early return
- `extension/src/types/index.ts:312` — `MAX_ITERATION_SECONDS: 14_400`
- `extension/src/types/index.ts:315-325` — relaunch comment ack'ing the failure mode for mux-runner case

---

## Open Questions

1. **Should `consecutive_subprocess_errors` reset on subsystem rotation, or only on success?**
   Suggested: reset only on success. Rotating doesn't prove the backend is healthy.

2. **Should `WORKER_CONSECUTIVE_ERROR_CAP` differ between codex and claude backends?**
   Suggested: same value. Codex hang is the dominant failure mode but the recovery semantics are identical.

3. **Should we trigger an output-stall SIGTERM at 30 min, or use the 20-min worker timeout if it's enabled?**
   Suggested: introduce `OUTPUT_STALL_SECONDS = 1800` as separate from worker_timeout. Worker timeout governs total elapsed; output stall governs *responsiveness*.

4. **What happens to the in-flight iteration's partial work?**
   Currently: dirty working tree, 17 files modified, no commit. Suggested: leave as-is (operator's choice to salvage), but emit a clear log line `"Iteration N left N files modified; inspect with 'git status' before next run"`.
