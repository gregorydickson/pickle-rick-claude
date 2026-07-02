# Recovery Controller Design (R-ORSR-1)

Terminal-authority disposition table and three-wiring-authority map for the recovery controller scaffolding.

## 1. HEAD-vs-Appendix-A Reconciliation

`recovery_exhausted` is a **fatal non-recoverable** exit reason: `isFailureExit=true`, `isHaltExit=false`.
- `auto-resume.sh` R-CNAR-4(c) stops unconditionally on any failure exit (including `recovery_exhausted`).
- It is NOT in `PIPELINE_HANDOFF_EXIT_REASONS` — it is a terminal failure, not an operator handoff.
- `CloserTerminalDecision` admits `'recovery_exhausted'` in the Extract union so it can be emitted by `evaluateCloserTerminalState` when recovery strategies are exhausted.

Budget reference (per PRD): `recovery_attempts` ledger field uses timeout 3600s / budget 4800s worker tier.

## 2. ExitReason Disposition Table

Every member of the `ExitReason` union classified into one of three disposition categories.

| ExitReason | Disposition | isFailureExit | isHaltExit | auto-resume stops? |
|---|---|---|---|---|
| `success` | retained-operator (clean) | false | false | N/A — success |
| `cancelled` | retained-operator (halt) | false | true | no — may retry |
| `limit` | retained-operator (halt) | false | true | no — may retry |
| `timeout_repeat` | retained-operator (halt) | false | true | no — may retry |
| `closer_handoff_terminal` | retained-operator (halt) | false | true | no — may retry |
| `manager_handoff_pending` | retained-operator (halt) | false | true | no — may retry |
| `done_without_commit_evidence` | retained-operator (halt) | false | true | no — may retry |
| `error` | retained-fatal (failure) | true | false | yes |
| `stall` | retained-fatal (failure) | true | false | yes |
| `circuit_open` | retained-fatal (failure) | true | false | yes |
| `rate_limit_exhausted` | retained-fatal (failure) | true | false | yes |
| `readiness_failed` | retained-fatal (failure) | true | false | yes |
| `iteration_cap_exhausted` | retained-fatal (failure) | true | false | yes |
| `pipeline_phase_incomplete` | retained-fatal (failure) | true | false | yes |
| `working_tree_modified_externally` | retained-fatal (failure) | true | false | yes |
| `state_schema_version_ahead` | retained-fatal (failure) | true | false | yes |
| `codex_unhealthy_consecutive_failures` | retained-fatal (failure) | true | false | yes |
| `codex_manager_no_progress` | retained-fatal (failure) | true | false | yes |
| `recovery_exhausted` | **retained-fatal (NEW — R-ORSR-1)** | **true** | **false** | **yes** |

Disposition categories:
- **subsumed** — N/A here (no exit reason is deprecated/merged in this change)
- **retained-operator** — halt exits; auto-resume.sh may retry; operator action resolves
- **retained-fatal** — failure exits; auto-resume.sh stops; requires investigation

## 3. Three Wiring Authorities

The three sites that currently emit closer/fatal terminal decisions in mux-runner.ts:

### Authority 1: `evaluateCloserTerminalState` — closer handoff detection (×2)

File: `extension/src/bin/mux-runner.ts`, approx lines 3209+

This function evaluates whether a closer session has reached a terminal state (manager signaling it is done or stuck). It emits `CloserTerminalDecision` which now admits `'recovery_exhausted'` via the Extract type. Call sites:
1. First call — evaluates current closer iteration output for terminal markers
2. Second call — re-evaluates after recovery attempt to confirm terminal vs continue

`recovery_exhausted` should be emitted here when a recovery strategy has been applied the maximum allowed times without success.

### Authority 2: Codex circuit-breaker halt

File: `extension/src/bin/mux-runner.ts`, approx line 3405

The codex circuit-breaker halt path. Currently emits `codex_unhealthy_consecutive_failures`. Future recovery controller may intercept here before declaring fatal exit, decrementing to `recovery_exhausted` after strategy budget exhausted.

### Authority 3: `codex_manager_no_progress` halt (×6)

File: `extension/src/bin/mux-runner.ts`, approx lines 4111, 4114, 4174, 4177, 6101, 6153

The R-CMWL-4 no-progress guard. Checks `state.codex_manager_consecutive_no_progress >= 2` and exits with `codex_manager_no_progress`. The recovery controller (future R-ORSR tickets) may intercept this path to attempt a strategy from `recovery_attempts` ledger before declaring fatal.

## 4. `recovery_attempts` Ledger

Schema-neutral v5 field (no `LATEST_SCHEMA_VERSION` bump). Defaulted to `[]` by `normalizeV5StateDefaults`.

Per-entry shape (`RecoveryAttempt` interface in `extension/src/types/index.ts`):

```typescript
{
  strategy: string;       // e.g. 'reset_no_progress_counter', 'force_ticket_retry'
  outcome: 'success' | 'failed';
  reason: string;         // human-readable description of what happened
  iteration: number;      // state.iteration when this attempt was made
}
```

The ledger is append-only during a session. Future recovery controller reads ledger length to determine whether the strategy budget is exhausted and `recovery_exhausted` should be emitted.
