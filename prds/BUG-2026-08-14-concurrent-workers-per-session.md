# BUG-2026-08-14 — "one worker per session" is prose, and workers outlive the ceiling

**Status:** ready to launch
**Priority:** P1 (reliability)
**Branch:** release/v2.1-beta
**Supersedes:** `prds/BUG-2026-08-14-fast-tier-wall-clock-exceeds-worker-gate-cap.md` (its premise was a
symptom of this)

---

## Problem

A worker whose Bash call is cut off at the manager's 600s ceiling **keeps running**. The manager,
following its documented instruction, advances — and now two `spawn-morty` processes are live in one
session, each running its own full `npm run test:fast` at `--test-concurrency=8`.

Nothing prevents this. `spawn-morty.ts` contains no lock of any kind:

```
grep -n "withRetryLock\|acquireLockFile\|withLock\|lockfile" extension/src/bin/spawn-morty.ts   ->   0 matches
```

The single-worker invariant exists only as prose in the manager prompt
(`_pickle-manager-prompt.md:155`), which tells the manager that a ceiling-cut worker can simply be
re-spawned because it "RESUMES from its on-disk artifacts". That is true of the artifacts and false
of the process: the old worker is still executing, still holding CPU, still running a test tier.

## Evidence

Session `2026-08-13-1a29993f`, activity timeline:

```
01:16:04  worker_spawn_backend_resolved  2e77f26e
01:26:39  worker_spawn_backend_resolved  f8559470     <- 10.6m later; 2e77f26e still live
01:52:45  worker_gate_failed             2e77f26e     <- 36m after its own spawn
01:57:33  worker_spawn_backend_resolved  119acf6a
02:17:05  worker_spawn_backend_resolved  185a93ee     <- 19.5m; 119acf6a still live
02:31:17  worker_gate_failed             119acf6a
```

The 10.6-minute gap is the 600s Bash ceiling plus spawn overhead. `2e77f26e` reported its gate result
26 minutes *after* the next worker had already started.

**Consequences measured on this box (24 cores):**

| condition | fast-tier wall clock |
|---|---|
| quiet box, clean env | 712 s |
| quiet box, worker-contaminated env | 747 s |
| under the worker gate, overlapping workers | > 1800 s (timed out) |

The first two rows are within 5% of each other, which rules out env contamination as the slowdown.
The third is the concurrency. Two tiers at c=8 plus two `claude -p` workers plus codegraph is ~16 test
processes and two model subprocesses on 24 cores.

**Both prior fixes failed for this reason.** The gate cap was raised 600000 -> 1800000 ms via
`PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` and the gate still reported `__timeout__` on all three tickets:

```
2e77f26e | timed out after 1800000ms; sent SIGTERM to process tree
f8559470 | timed out after 1800000ms; sent SIGTERM to process tree
119acf6a | timed out after 1800000ms; sent SIGTERM to process tree
```

A bigger bucket does not help when the tap scales with worker count.

## Why this is the root, not another symptom

This one defect produces several previously-separate incident classes:

- **Worker gate timeouts.** The gate cannot fit inside any cap while N tiers run at once.
- **The suppression ladder spent on arithmetic.** `failed_flip_suppressed` absorbed 3/3 gate failures
  in this session and 3 more in `2026-08-13-e4ab0833`, consuming budget meant for real failures.
- **Contention silent death.** Detached workers dying at 4-way contention is the same overload.
- **Dual-spawn brittleness.** The dual-spawn model was collapsed onto synchronous re-spawn-resume
  precisely because concurrent worker spawns are the brittleness root; this is the residue that
  collapse did not reach, because it lives in process lifetime rather than in the spawn path.

## Thesis

**Make the invariant structural instead of prosaic: one live worker per session, enforced by a lock.**

The primitives already exist and are already hardened for exactly this shape — `acquireLockFile` /
`releaseLockFile` (inode + nonce identity), `withStealRight` (serialized steal), `isDeadPidPayload`
(proof-of-death only, never age-based). `state-manager.ts` uses them for the state lock, the gate
lock, and the session-map lock; `spawn-gate-remediator.ts` was moved onto them by R-GRLS. A worker
lock is the fourth instance of a pattern this codebase has already gotten right three times.

Behavior on contention is the design question the bundle must answer, and the safe default is:
**a second spawn for the same session detects the live holder and exits non-fatally**, letting the
manager re-spawn on its next turn — no kill, no wait, no halt. Killing the incumbent risks
destroying verified-but-uncommitted work, which is the one outcome worse than slowness.

## Simplification Review

**1. Is the addition necessary at all?**
A lock is new, but it *replaces* a prose invariant with an enforced one — the same trade the codebase
already made for `state.json` writes, settings writes, and the gate. The alternative (keep trusting
the prompt) has now been measured failing in two consecutive sessions.

**2. Can it REUSE instead of ADD?**
Yes, and it must. `acquireLockFile` / `releaseLockFile` / `withStealRight` / `isDeadPidPayload` in
`extension/src/services/state-manager.ts` are the exact primitives, including the dead-holder reclaim
this needs (a worker killed by SIGKILL must not strand the session forever). **Do not hand-roll**
`openSync(O_CREAT|O_EXCL)` + `process.on('exit')` cleanup — that is precisely the shape R-GRLS had to
remove from `spawn-gate-remediator.ts` after one abrupt death stranded a session's gate permanently.
Payload MUST be the bare pid string, the encoding `isDeadPidPayload` reads.

**3. Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?**
It removes load-bearing weight from several existing guards rather than adding a layer over them: the
suppression ladder stops absorbing arithmetic, the gate cap stops needing per-machine tuning, and the
orphan reaper's live-session blind spot stops mattering for this case. No second escape hatch is
introduced.

**4. What can this issue SUBTRACT?**
- The standing need for `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` on this repo's own bundles.
- The entire cost-class-sharding bundle, which becomes unnecessary if one tier runs at a time —
  712 s fits inside the compiled 600000 ms default with headroom to spare once it is not competing
  with itself. That PRD should be retired, not implemented.
- Candidate follow-on: the prose worker-spawn-discipline paragraph shrinks once the runtime enforces
  what it currently only asks for.

## Scope

**In:** enforcing at most one live `spawn-morty` process per session, and making a superseded or
contending spawn exit non-fatally.

**Out:**
- Killing or reaping the incumbent worker. Explicitly excluded — it risks uncommitted verified work.
- Changing the 600s ceiling, the manager re-spawn-resume model, or the gate's contents.
- Cross-session concurrency. Two different sessions on one box remain the operator's business.
- The env-contamination failures below (separate ticket).

## Acceptance criteria

- **AC-1 — the lock exists and reuses the primitives.**
  `grep -c "acquireLockFile\|releaseLockFile" extension/src/bin/spawn-morty.ts` >= 2, and
  `grep -c "O_EXCL" extension/src/bin/spawn-morty.ts` is 0.
- **AC-2 — the payload is reclaimable.** The lock is written with a bare-pid payload and a strand is
  reclaimed through `withStealRight` + `isDeadPidPayload`; a lock held by a *live* pid is never
  stolen, and no age-based steal arm exists (a worker legitimately holds for up to its full
  `worker_timeout_seconds`, currently 3600).
- **AC-3 — contention is non-fatal.** A second spawn against a live holder exits with a distinct
  non-zero code and an activity event naming the incumbent pid and ticket; it MUST NOT halt the
  pipeline, flip a ticket Failed, or write ticket frontmatter.
- **AC-4 — a SIGKILLed worker does not strand the session.** Kill a holder with SIGKILL; the next
  spawn reclaims the lock and proceeds. This is the R-GRLS regression in a new home and is the AC most
  likely to be quietly skipped.
- **AC-5 — the gate fits.** With the lock in place and no `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS`
  override, one bundle produces zero `worker_gate_failed` events carrying `__timeout__`. This is the
  ticket that runs the claim.
- **AC-6 — no overlap in the timeline.** For that same bundle, no two `worker_spawn_backend_resolved`
  events for different tickets bracket an intervening `worker_gate_failed` belonging to the earlier
  ticket — the exact shape quoted in Evidence. Assert it against the session's activity log.

## Risks

- **A worker legitimately runs for up to an hour** (`worker_timeout_seconds: 3600`). Any timeout or
  age heuristic on this lock will evict a live, working worker. Proof-of-death only.
- **Serializing workers may lengthen wall clock per bundle.** That is the correct trade: the current
  parallelism is not producing parallel progress, it is producing gate timeouts and suppression-budget
  burn. Measure and report the delta rather than treating a slower bundle as a regression.
- **The manager may spin** if it re-spawns against a held lock every turn. AC-3's event is what makes
  that visible; watch for it in the AC-5 bundle before declaring success.

## Separate ticket (do not fold into this bundle)

The worker gate inherits the worker's env, including the `core.hooksPath` trailer-hook stamp
(`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`, `backend-spawn.ts:823-826`) and
`PICKLE_TICKET_ID` — `runCommand` (`spawn-morty.ts:1315`) spawns with no `env` option. Under that env
the fast tier reports **8 failures** that are green on a clean env:

```
backendEnvOverrides: materialization failure emits neither key and logs once
setup --resume: a REAL orphaned commit is still ff-reattached and flipped Done
setup --resume: a TARGET-repo RED is advisory - reattached, flipped Done, residual recorded
runWorkerGate: honors worker_test_gate_timeout_ms, reports timeout details, kills npm descendants
AC-1 site: mux-runner.ts attemptRecoveryBeforeTerminal.runArmedGate - an unrunnable gate
AC-3: a not_run verdict flips Done and emits a residual naming the ticket and reason
AC-WDTFTO-1-1: timed-out worker WITH a window commit preserves the sha (Failed, not null)
AC-WDTFTO-1-3: the Failed ticket stays selectable
```

Every one reads `GIT_CONFIG_*` out of the ambient env; `backendEnvOverrides` composes `n+1` off an
inherited count and the assertions break. This is a correctness bug in the gate's own signal — it
makes a healthy worker's gate go red — but it produces failures, not timeouts, so it is not the cause
of this PRD's problem and must not be bundled with it.

## References

- Timeline and gate failures: session `2026-08-13-1a29993f`; prior instance `2026-08-13-e4ab0833`
- `extension/src/bin/spawn-morty.ts` — `runCommand` (:1315), `runWorkerGateTestCommand` (:1502)
- `extension/src/services/state-manager.ts` — `acquireLockFile`, `releaseLockFile`, `withStealRight`,
  `isDeadPidPayload`, and the three lock trap doors documenting proof-of-death-only reclaim
- `extension/src/bin/spawn-gate-remediator.ts` — R-GRLS, the precedent for moving a hand-rolled lock
  onto these primitives
- `_pickle-manager-prompt.md:155` — the prose invariant this bundle makes structural
