<!-- R-CTSF retroactive (shipped pre-R-CTSF) -->
# P1: mux-runner wedges 13h on unbounded between-ticket gate spawnSync

**Bundle code**: `R-MRWG` (Mux Runner Wedge Gate)
**Priority**: P1 — pipeline-bricking, recurrence-prone, observed twice in 24h on the same active bundle.
**Filed**: 2026-05-16 CDT
**Filed by**: operator-assisted post-incident analysis (session 2026-05-15-c543d227 post-wedge recovery)

## Incident Summary

Session `2026-05-15-c543d227` (B2 operational-trifecta bundle, codex backend, 26 tickets) wedged for ~13 hours overnight (2026-05-15 20:28 CDT → 2026-05-16 09:35 CDT).

At kill-time:
- `state.json` last-mtime 2026-05-15 20:28:20 CDT (= 2026-05-16 01:28:20Z)
- `state.active = true`, `state.pid = 3897` (mux-runner) — still alive but blocked
- mux-runner pid 3897 stuck in `spawnSync('npm', ['run', 'test:fast'])` for 13h
- 3 `node --test` processes alive: 1 attached to mux-runner, **2 orphaned to launchd** (worker-gate timeouts fired but SIGTERM did not propagate to grandchildren)
- 22 iteration logs produced, iter 22 was the wedge boundary
- 1d385443's implementation work was complete on disk (conformance ALL PASS, all AC files modified, new test file uncommitted) but no commit because mux-runner wedged before reaching the commit step

Operator recovery cost: ~2h diagnostic + heal-via-edit-then-resume (commit `b2ddf584`).

This is the **second occurrence in 24h** of the same exact stall pattern on the same bundle:
- 2026-05-15 PM: ticket `8240fdca` — worker burned 6 spawns + 5 circuit-breaker iterations polling `test:fast` that never returned cleanly; healed via commit `189d4d2f`
- 2026-05-16 AM: ticket `1d385443` — mux-runner wedged 13h on between-ticket gate; healed via commit `b2ddf584`

## Root Cause

Two defects in the same surface (gate execution paths that shell out to `npm run test:fast`):

### Defect 1 — `runBetweenTicketFastTests` has no timeout

`extension/src/bin/mux-runner.ts:257-269`:

```ts
export function runBetweenTicketFastTests(extensionDir: string): BetweenTicketGateResult {
  const result = spawnSync('npm', ['run', 'test:fast'], {
    cwd: extensionDir,
    encoding: 'utf-8',
  });
  // ... no timeout option passed
}
```

If `npm run test:fast` does not return (test deadlock, auth-prompt-on-stdin, deadlock on shared resource between concurrent runs), mux-runner is blocked indefinitely. Both call sites at `mux-runner.ts:2875` and `:3919` catch the error and treat it as `(ignored)`, so the gate is documented as non-fatal — but it can never `error` if it never returns. The gate's "non-fatal" property is silently inverted into "infinitely fatal" by a missing timeout.

**Compare** `runWorkerGateTestCommand` (`spawn-morty.ts:719-740`) which threads `workerTestGateTimeoutMs` through `runCommand` → `spawnSync({ timeout: opts.timeoutMs ?? 120_000 })`. The pattern exists; it just wasn't applied here.

### Defect 2 — `runCommand` timeout doesn't propagate to npm grandchildren

`extension/src/bin/spawn-morty.ts:599-614`:

```ts
function runCommand(cmd: string, args: string[], cwd: string, opts: { timeoutMs?: number } = {}): CommandResult {
  const result = spawnSync(cmd, args, {
    cwd, encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // ...
}
```

Node's `spawnSync` timeout sends SIGTERM to the **direct child only**. When `cmd === 'npm'`, the npm wrapper is the child; the actual `node --test ...` it spawned is a grandchild. On timeout, the npm wrapper is killed but the test-runner is reparented to launchd and continues running forever. Each worker-gate timeout leaks a grandchild.

In the 2026-05-16 incident, two such orphans were observed:
- pid 26505 etime 13h23m (started 2026-05-16 01:07Z, worker-gate for ticket pre-1d385443)
- pid 82284 etime 13h03m (started 2026-05-16 01:27Z, worker-gate for 1d385443)

Three concurrent `node --test` processes against the same fixtures **deadlocked on shared resources** (likely shared tmpdir naming or session-map files used by `services/state-manager.test.js`, `services/recover-stale-active-flag-mapped-orphan.test.js`, `bin/setup.test.js`, etc.) — this is plausibly what caused the attached one (mux-runner's gate) to also hang despite no individual test being broken.

### Trigger: Claude auth expiry overnight

Pickle-rick CLAUDE.md notes the user lost Claude auth overnight (re-authed 2026-05-16 AM). Integration tests that spawn the real `claude` CLI (10 such tests under `extension/tests/integration/`, e.g. `spawn-morty-actual-session-bug.test.js`, `microverse-runner-judge-failure.test.js`, `mega-bundle-e2e.test.js`) can hang waiting on stdin if `claude` prompts for re-auth in a subprocess context. This was the proximate trigger but not the root cause — even without auth loss, Defect 2 guarantees orphan accumulation, and Defect 1 guarantees that any future trigger will wedge mux-runner indefinitely.

## Atomic Tickets

### R-MRWG-1 — Add timeout to `runBetweenTicketFastTests`

**File**: `extension/src/bin/mux-runner.ts:257-269`
**Change**: Add `timeout: BETWEEN_TICKET_GATE_TIMEOUT_MS` (default `600_000` = 10min) to the `spawnSync` options. Default reachable via `pickle_settings.between_ticket_gate_timeout_ms` with positive-integer validation, falling back to `Defaults.BETWEEN_TICKET_GATE_TIMEOUT_MS = 600_000`.

**Acceptance criteria**:
- [ ] `spawnSync('npm', ['run', 'test:fast'], { ... timeout: <ms>, ... })` invocation present
- [ ] Timeout sourced via helper that reads `pickle_settings.between_ticket_gate_timeout_ms`, positive-integer-validated, default 600000
- [ ] On timeout, `result.error?.code === 'ETIMEDOUT'` is surfaced as `{ ok: false, failures: [{ name: '__timeout__', file: 'npm run test:fast', message: 'killed after Xms' }] }` so the gate's non-fatal logging captures the timeout in `last_between_ticket_gate.failures`
- [ ] Activity event `between_ticket_gate_timeout` emitted with `{ ticket_id, timeout_ms, elapsed_ms }` payload; registered in `VALID_ACTIVITY_EVENTS` and `activity-events.schema.json` definitions + oneOf per R-PDD-oneOf
- [ ] Regression test: a fake `npm` shim that sleeps forever causes `runBetweenTicketFastTests` to return with `__timeout__` failure inside 12s (10s timeout + 2s slack)

**Trap door** (`extension/src/bin/mux-runner.ts` invariant):
> Every `spawnSync('npm', ['run', 'test:fast'], ...)` callsite in `mux-runner.ts` MUST include a finite positive `timeout` option resolved through `pickle_settings.between_ticket_gate_timeout_ms` (default 600000). BREAKS: any unbounded npm gate spawn can wedge mux-runner indefinitely; the gate's "non-fatal logging" property silently inverts to "infinitely fatal". ENFORCE: `extension/tests/mux-runner-between-ticket-gate-timeout.test.js`. PATTERN_SHAPE: `spawnSync\\('npm',\\s*\\['run',\\s*'test:fast'\\][^)]*\\)` MUST include `timeout:` within the options object.

### R-MRWG-2 — Propagate SIGTERM to npm grandchildren in `runCommand`

**File**: `extension/src/bin/spawn-morty.ts:599-614`
**Change**: Replace `spawnSync` with `spawn` + `setTimeout(killTree, opts.timeoutMs)`, where `killTree` walks the descendant process group and sends SIGTERM to each. Fall back to SIGKILL after a 5s grace.

**Implementation outline**:
```ts
function runCommand(cmd: string, args: string[], cwd: string, opts: { timeoutMs?: number } = {}): CommandResult {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  // capture stdout/stderr
  const killTimer = setTimeout(() => killProcessTree(child.pid, 'SIGTERM'), timeoutMs);
  const sigkillTimer = setTimeout(() => killProcessTree(child.pid, 'SIGKILL'), timeoutMs + 5000);
  // ... await child exit, clearTimeout both ...
}
```

`killProcessTree` enumerates descendants via `ps -o pid,ppid` and sends the signal to each.

**Acceptance criteria**:
- [ ] `runCommand` no longer uses `spawnSync`; uses async `spawn` + explicit SIGTERM/SIGKILL ladder
- [ ] On timeout, ALL descendant pids (the npm wrapper AND its `node --test` child AND grandchildren) receive SIGTERM within `timeoutMs + 100ms` and SIGKILL within `timeoutMs + 5000ms`
- [ ] Regression test: a fake `npm` shim that spawns a `sleep 1000` grandchild and exits the npm wrapper immediately; `runCommand` with `timeoutMs=2000` is observed to kill BOTH the npm wrapper and the sleep grandchild within 7s (5s SIGKILL grace + 2s slack)
- [ ] Existing worker-gate timeout tests still pass

**Trap door** (`extension/src/bin/spawn-morty.ts` invariant):
> `runCommand` MUST kill the entire descendant process tree on timeout, not just the direct child. BREAKS: npm wrapper timeouts leak `node --test` grandchildren reparented to launchd, accumulating zombies that contend for shared test fixtures and can wedge later gate runs. ENFORCE: `extension/tests/spawn-morty-run-command-tree-kill.test.js`. PATTERN_SHAPE: `runCommand` body MUST NOT use `spawnSync` for timeout-bearing calls; MUST use async `spawn` + descendant-aware kill helper.

### R-MRWG-3 — Wedge detector: stale-state-active reaper

**File**: `extension/src/bin/mux-runner.ts` (new iteration_start guard)
**Change**: At every iteration_start, check `state.json` mtime + iteration number staleness. If `state.active === true` AND `state.pid` is alive AND `state.json` has not been written for > `MUX_RUNNER_STALL_SECONDS` (default 1800s = 30min) AND `state.iteration` has not advanced, emit a `mux_runner_stall_detected` activity event with full process-tree snapshot, then proceed to deactivate via the safeDeactivate path (`exit_reason='mux_runner_wedged'`).

**Acceptance criteria**:
- [ ] Stall detector runs at each iteration_start under `state.tmux_mode === true` only
- [ ] Threshold reads from `pickle_settings.mux_runner_stall_seconds`, positive integer, default 1800
- [ ] On stall: emits `mux_runner_stall_detected` with `{ since_iso, iteration, current_ticket, alive_child_pids: number[] }`
- [ ] On stall: writes `exit_reason='mux_runner_wedged'`, calls `safeDeactivate`, exits 3 (PhaseIncomplete) so pipeline-runner can recover or auto-resume.sh can take over
- [ ] Regression test: simulate stale state.json (mtime 31min ago, iteration unchanged) → detector fires within next iteration_start

**Trap door** (`extension/src/bin/mux-runner.ts` invariant):
> Every `iteration_start` slot MUST run the stall detector before continuing. BREAKS: a wedged mux-runner with `state.active=true` shadows live recovery for hours, blocks subsequent sessions in the same cwd, and burns operator triage time. ENFORCE: `extension/tests/mux-runner-stall-detector.test.js`. PATTERN_SHAPE: `iteration_start` path in `runMuxLoop` MUST call `evaluateMuxRunnerStall(state, statePath, opts.now)` before any worker spawn.

### R-MRWG-4 — Orphan reaper at mux-runner startup

**File**: `extension/src/bin/mux-runner.ts` startup (after `phantom-Done watcher: installed`)
**Change**: On mux-runner startup, scan for orphan `node --test` and `npm` processes whose ppid is launchd (1) AND whose argv references the current `extensionDir` (`/Users/.../extension`) AND etime > 600s. SIGKILL each, emitting `orphan_test_runner_reaped` activity events with `{ pid, etime_seconds, argv_summary }`.

**Acceptance criteria**:
- [ ] Reaper runs once per mux-runner main() startup, after the watchdog install
- [ ] Match criteria: ppid === 1 AND argv contains current `extensionDir` AND argv matches `node --test|npm run test:fast|test-runner.js` AND etime ≥ ORPHAN_REAP_AGE_SECONDS (default 600)
- [ ] Each reaped process emits `orphan_test_runner_reaped` activity event (registered + schema + oneOf per R-PDD-oneOf)
- [ ] Regression test: stub the scanner to return 2 fake-orphan pids; assert reaper logs reaped count and emits 2 events
- [ ] Best-effort try/catch — reaper failure NEVER blocks mux-runner startup

**Trap door** (`extension/src/bin/mux-runner.ts` invariant):
> mux-runner startup MUST attempt orphan-test-runner reaping in a best-effort try/catch BEFORE spawning the first iteration's worker. BREAKS: orphan accumulation over many sessions slows test runs and induces shared-resource deadlocks. ENFORCE: `extension/tests/mux-runner-orphan-reaper.test.js`. PATTERN_SHAPE: `mux-runner.ts:main()` body MUST include `reapOrphanTestRunners(extensionDir).catch(...)` between watcher install and iteration loop.

### R-MRWG-5 — Pipeline-runner stale-mux-runner detector

**File**: `extension/src/bin/pipeline-runner.ts` (between phase iterations / per-iteration heartbeat)
**Change**: When pipeline-runner is the active parent of a mux-runner child, periodically (every 60s) check whether the child's `state.json` is being updated. If not for > `PIPELINE_RUNNER_CHILD_STALL_SECONDS` (default 1800s), send SIGTERM to the mux-runner pid and record `child_mux_runner_wedge_detected` activity event. This is the safety net for R-MRWG-3 — if mux-runner's own stall detector also fails (e.g., wedged before reaching iteration_start), pipeline-runner reaps it externally.

**Acceptance criteria**:
- [ ] Heartbeat fires every `PIPELINE_RUNNER_CHILD_HEARTBEAT_MS` (default 60000) while a mux-runner child is active
- [ ] Heartbeat reads child `state.json` mtime; if (now - mtime) > `PIPELINE_RUNNER_CHILD_STALL_SECONDS` AND child pid is alive, send SIGTERM
- [ ] Emit `child_mux_runner_wedge_detected` event with `{ child_pid, last_state_mtime_iso, elapsed_seconds }`
- [ ] Defaults validated as positive integers; non-positive `PIPELINE_RUNNER_CHILD_HEARTBEAT_MS` disables the heartbeat
- [ ] Regression test: mock child whose state.json is stale 31min → heartbeat sends SIGTERM and logs event within 65s

**Trap door** (`extension/src/bin/pipeline-runner.ts` invariant):
> pipeline-runner MUST arm a child-mux-runner stall heartbeat for any active mux-runner subprocess. BREAKS: if mux-runner's own R-MRWG-3 detector also wedges, only an external watcher can recover the pipeline; without it, sessions can stall overnight unattended. ENFORCE: `extension/tests/pipeline-runner-child-stall-heartbeat.test.js`. PATTERN_SHAPE: `pipeline-runner.ts:runPhaseIteration` MUST `armChildStallHeartbeat(child, statePath)` before awaiting the child's exit.

### R-MRWG-6 — Closer: version bump + release-gate verify + deploy + MASTER_PLAN update

**Atomic closer ticket** (large tier, worker_timeout_seconds 4800, retroactive R-CTSF split):
- [worker] Run the source-scope verification pass from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`; record whether failures are inherited vs newly introduced.
- [worker] Prepare the manager handoff package: touched compiled-file parity targets, Finding #42 closeout summary, and the exact shipped-table rows to update once manager-only steps complete.
- [manager] Patch bump `extension/package.json` (3 of 5 changes are pure additions; behavior change is the timeout default — not a schema change, so patch is appropriate).
- [manager] Deploy via `bash install.sh --closer-context --no-confirm`.
- [manager] MD5 parity verify on the 5 most-trafficked compiled files per AC-RVN-08.
- [manager] Update `prds/MASTER_PLAN.md`: move R-MRWG row from `### Open (P1)` to `### Closed`; bump `## Recently Shipped` table; close any related slots in `### Open (P3)` (R-TFP may partially overlap).

## Out of Scope

- Auth-loss handling for tests that spawn the real `claude` / `codex` CLI. Separate concern; tests should mock external CLIs or set `stdio: ['ignore', 'pipe', 'pipe']` to fail-fast instead of waiting on stdin. File as **R-TASR** (Test Auth-Subprocess Robustness) follow-up, ~3 tickets.
- Migrating `npm run test:fast` to a faster runner (vitest, etc.) — separate epic.
- Fixing the underlying tests that hang (the 9 known unrelated baselines: plumbus-frame-analyzer-hang-guard, scope-resolver-import-walks, citadel-cross-phase-fixture, etc.). R-MRWG only addresses the gate framework, not the test content.

## Dependencies

- Builds on R-WTB tier-budget infra (already landed `b5f9242b`)
- Builds on R-PHC continue_on_phase_fail (already landed)
- No deps on the in-flight B2 bundle; can ship as standalone B-MRWG

## Risk

- Aggressive descendant-tree killing could SIGTERM legitimate concurrent test:fast runs (e.g., operator manually running `npm test` in another shell). Mitigation: scope orphan reaping to ppid=1 AND etime > 600s — operator-run tests have a live shell ppid, not launchd.
- Stall detector + heartbeat both at 30min default; for slow test:fast on cold machines, this could false-positive. Mitigation: positive-integer settings overrides for both, advertised in MASTER_PLAN.

## Recurrence Evidence

| Date | Ticket | Symptom | Recovery cost |
|---|---|---|---|
| 2026-05-15 PM | `8240fdca` | Worker spawned 6 times polling `test:fast`; circuit breaker tripped at iter 14; pipeline halted | ~5min heal commit `189d4d2f` |
| 2026-05-16 AM | `1d385443` | mux-runner blocked in `spawnSync('npm', ['run', 'test:fast'])` for 13h; 2 orphan grandchild processes; state.json stale; pipeline appeared alive | ~2h diagnostic + heal commit `b2ddf584` |

Both incidents on same bundle session, same root cause class. Without R-MRWG, every future codex-backend bundle is at risk on macOS+npm.

## Test Fixtures Required

- `extension/tests/__fixtures__/npm-shim-hang-forever/npm` — shell shim that `sleep infinity` and ignores SIGTERM
- `extension/tests/__fixtures__/npm-shim-leaks-grandchild/npm` — shell shim that spawns `sleep 1000` as a backgrounded grandchild then `exec sh -c 'exit 0'`
- `extension/tests/__fixtures__/fake-orphan-ps-output.txt` — captured `ps -axo pid,ppid,etime,command` showing two orphan `node --test` rows with ppid=1
