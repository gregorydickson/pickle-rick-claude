---
title: "B-LOGEV — worker session-log emptiness is not evidence; 81% of logs are empty and the classifier believes them"
priority: P1
finding: B-LOGEV
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
build_mode: attended
source_assessment: "Authored 2026-08-04 from a diagnostic of session 2026-08-03-2d5b3820 (LOA-2190, 15 tickets, exit_reason: completed). All numbers measured from state.json activity + on-disk artifact mtimes."
---

# B-LOGEV — the emptiest signal in the system is load-bearing

## 0. Pre-launch checks

- **Green-tree precondition — GREEN at `5b4136a1`** (`test:fast`: 7212 tests / 0 fail / exit 0, 481
  suites, 421s, quiet box). Re-verify on the actual launch commit.
- **Stale-premise check — LIVE.** `classifyWorkerSessionLogs` maps 0-byte → `log_empty` at
  `mux-runner.ts:8007` and the `log_empty` sub-class is intact at `:7963-7964`. Nothing has fixed this.
- **Build mode: ATTENDED.** This edits the silent-death recovery path. Per `CLAUDE.md` → "NEVER
  hand-build", attended means *launch normally and watch the seam* — it is not a different build path.

## 1. The measurement

Session `2026-08-03-2d5b3820` — LOA-2190 worktree, 15 tickets, 43 worker spawns, `exit_reason:
completed`. **This is the run that WORKED.**

| Measure | Value |
|---|---|
| `worker_session_<pid>.log` files written | 43 |
| **Zero-byte** | **35 (81%)** |
| Non-empty | 8 |
| Tickets with a full lifecycle artifact set AND ≥1 zero-byte log | **11 of 15** |
| `worker_produced_nothing` breadcrumbs emitted | 10 |
| Of those, emitted for a worker that had **produced artifacts** | **10 of 10** |

**Log capture is not flaky here. It is the norm — the 8 non-empty logs are the exception.**

## 2. Proof that the breadcrumb is false, by the clock

Ticket `1029cede`, all times UTC, PID and mtime from disk:

```
02:53:46  spawn pid=28214
02:53:51  worker_session_28214.log created ................ 0 bytes
03:03:05  research_2026-08-03.md written .................. 13,455 B
03:03:11  research_review.md .............................. 554 B
03:03:51  plan_2026-08-03.md .............................. 9,535 B
03:04:39  worker_produced_nothing  pid=28214  artifact_delta=0  session_log_bytes=0
```

**The breadcrumb fired 48 seconds after that same PID wrote a 9,535-byte plan.** The runner then
respawned at 03:05:13, and the replacement wrote `plan_review.md` at 03:06:10 before being declared
unproductive in turn at 03:15:44.

Ticket `c721f502` is worse. One PID (`98785`) emitted the breadcrumb **twice** — 03:42:22 and
03:53:46 — having completed research → plan → plan_review → conformance → code_review → TASK_NOTES
between 03:32:04 and 03:37:14. The second emit timestamp is **exactly** the mtime of
`rick_ticket_c721f502.md`, i.e. the moment it was stamped `Skipped
(acceptance_criteria_not_checked)`. Two independent oracles declared a fully productive worker
unproductive, in the same second. (The skip half is [[R-ACNP]], filed separately.)

## 3. Root cause

`spawn-morty.ts:423` writes `worker_session_${process.pid}.log`. Something on that path is failing to
capture worker stdout for ~81% of spawns — **that is the defect to find**, and it is WS-1.

`classifyWorkerSessionLogs` (`mux-runner.ts:7988`) then takes the latest log by mtime and maps
**absent or 0-byte → `log_empty`** (`:8007`). That sub-class is consumed by two things:

1. `emitWorkerProductionBreadcrumb` — fires `worker_produced_nothing` on
   `plExit === null && artifactDelta === 0 && subClass === 'log_empty'`. Observability only.
2. **`worker_silent_death` → `applySilentDeathRecoveryPolicy`** — which respawns against
   `silent_death_respawn_cap`, and on exhaustion **halts with `recovery_exhausted`**. This is the only
   non-crash-floor halt path in the runtime.

**Why this run survived:** `detectSilentDeathAttributableWork` runs *first* and returns `hold` when it
finds fresh lifecycle artifacts. The artifact check is already the ground-truth oracle, it already
works, and it is already load-bearing. The system is carrying a false signal and a working signal side
by side, and paying for the false one.

**`artifactDelta` is an ITERATION delta.** A worker that finished its artifacts in an earlier iteration
reads delta 0 even though the ticket holds 30 KB of its output — which is why the breadcrumb fired 10
times rather than 35.

## 4. Workstreams

### WS-LOGEV-1 — find and fix the capture failure

Diagnose why `worker_session_<pid>.log` is 0 bytes for ~81% of spawns and fix it. Research phase must
determine whether stdout is unredirected, redirected elsewhere, buffered and lost on exit, or written
to a different PID's filename than the classifier reads.

- **AC-LOGEV-1a**: root cause named in `prds/research/logev-capture-root-cause.md`, citing the writing
  call site and the failing mechanism by `file:line`. — Verify: `test -f` and the file names a
  `src/**` path with a line number — Type: test
- **AC-LOGEV-1b**: a regression test asserts a spawned worker's session log is non-empty and contains
  its own output, exercising the real writer (not a re-derivation). — Verify: `npm run test:fast` —
  Type: test

### WS-LOGEV-2 — subtract log-emptiness as evidence (**the load-bearing subtraction**)

Even with WS-1 fixed, an empty log must never again mean "produced nothing." Ground truth is artifacts
+ git; the log is a rendering artifact.

**REUSE, do not add:** `detectSilentDeathAttributableWork` already answers "is there real work here?",
already runs first in the silent-death policy, and already saved this run. Every consumer of
`log_empty` must be gated behind it — or drop the sub-class entirely if WS-1 shows it has no
independent signal.

- **AC-LOGEV-2a**: no code path treats a 0-byte session log as sufficient evidence of no work. Every
  consumer of `log_empty` consults attributable-work evidence first and yields to it. — Verify: for
  each reference to `log_empty` in `src/`, the enclosing decision is dominated by an
  attributable-work check — Type: llm-conformance
- **AC-LOGEV-2b** *(the invariant, pinned once — not a per-site matrix)*: given a ticket with fresh
  lifecycle artifacts and a 0-byte session log, `emitWorkerProductionBreadcrumb` does **not** emit
  `worker_produced_nothing`, and `applySilentDeathRecoveryPolicy` returns `hold` — asserted against
  the real emitters, reading `state.json.activity`. — Verify: `npm run test:fast` — Type: test
- **AC-LOGEV-2c**: replaying the `1029cede` shape (artifacts at T, 0-byte log, breadcrumb window at
  T+48s) produces **zero** `worker_produced_nothing` events. — Verify: `npm run test:fast` — Type: test

### WS-LOGEV-3 — verification that runs the claim

- **AC-LOGEV-3a**: a pipeline run on this bundle records its own `worker_session_*.log` empty-rate and
  `worker_produced_nothing` count in `prds/research/logev-field-result.md`, with the session id. A run
  where the empty-rate is unchanged from 81% is a **failed** bundle, stated as such. — Verify:
  `test -f` and the file names a session id and both numbers — Type: test

## 5. Simplification Review

1. **Necessary?** WS-1 is a genuine defect fix. WS-2 adds no mechanism — it deletes a signal's
   authority. WS-3 adds no code.
2. **REUSE not ADD?** Yes, and this is the core of the design: `detectSilentDeathAttributableWork` is
   the existing, working, already-first oracle. WS-2 subordinates a bad signal to it rather than
   building a new arbiter.
3. **Guards brittle complexity that should be SUBTRACTED?** Precisely. `log_empty` is a **flaky input**
   feeding a decision, failing 81% of the time on real runs. The standing rule is to subtract the
   ill-posed input, never to add resistance around it — see the retraction below.
4. **SUBTRACTS:** the authority of `log_empty`, and potentially the sub-class itself if WS-1 finds it
   carries no independent signal. Net-negative LOC is the expected shape.

> ### ⛔ Retracted approach — recorded so it is not re-proposed
> Before this diagnostic I recommended bounding the respawns with `bounded_terminal_escape_cap`. **That
> was wrong**: it caps the *waste* while leaving the *misdiagnosis* intact, and it is textbook "add
> resistance around a flaky input." Worse, the adjacent-looking option — routing the class into
> `silent_death_respawn_cap` — would wire the one signal that has never stopped a pipeline directly to
> `recovery_exhausted`, the only non-crash-floor halt we have. **Do not bound this. Subtract it.**

## 6. Risks

- **R1 — WS-1 finds the capture failure is environmental** (tmux pane redirection, a target-repo
  quirk). Then WS-2 matters *more*, not less: the signal is not merely broken, it is unreliable by
  construction across environments. Record the finding and proceed with WS-2 regardless.
- **R2 — dropping `log_empty` blinds a genuine silent-death case.** Bounded by keeping
  `log_truncated` untouched and by the fact that attributable-work evidence, not the log, is what the
  policy already acts on. A worker that truly died produces no artifacts and is still caught.
- **R3 — attended-build wedge.** This edits the recovery path, so the deployed pre-fix runtime applies
  it to this bundle's own workers. Expect empty logs during the build; that is the bug, watched live.
  Recover and record — do not hand-build.

## 7. Implementation Task Breakdown

| Order | Title | Tier | Files |
|---|---|---|---|
| 10 | WS-LOGEV-1: find and fix the worker session-log capture failure | large | `extension/src/bin/spawn-morty.ts`, `prds/research/logev-capture-root-cause.md`, `extension/tests/**` |
| 20 | WS-LOGEV-2: subtract log-emptiness as evidence; subordinate every `log_empty` consumer to attributable-work | large | `extension/src/bin/mux-runner.ts`, `extension/bin/mux-runner.js`, `extension/tests/**` |
| 30 | WS-LOGEV-3: record the field empty-rate and breadcrumb count from this bundle's own run | small | `prds/research/logev-field-result.md` |

> **Scope note (earned by R-GADEL refinement):** ticket 20's allowlist includes the **compiled mirror**
> (`extension/bin/mux-runner.js`) alongside the `.ts` source. The tests import the mirror; a src-only
> commit is `outside_scope` at the fence and leaves the gate measuring pre-fix code.
