# BUG: R-WGTORPH — worker-gate shim orphans re-accumulate, survive SIGTERM, and contend with every tier run

- **Date**: 2026-08-16
- **Priority**: P1 (reliability — permanent CPU oversubscription on the box that measures everything)
- **Branch**: `release/v2.1-beta`
- **Measured at**: `a001b4ee` (fast tier green: 7707 tests, 507 suites, fail 0, cancelled 0)
- **Class**: process leak. Every `test:fast` run of one test file strands children that nothing reaps.

## Problem

`extension/tests/spawn-morty-worker-gate.test.js:15-16` builds each fixture root as
`mkdtempSync(path.join(os.tmpdir(), 'pickle-spawn-morty-worker-gate-'))` and spawns a REAL
`npm run test:fast` through a shim under it. When the test's own timeout path fires, the shim child is
re-parented to pid 1 and never reaped.

**Re-accumulation is measured, not inferred.** Two censuses this session, on the same box:

| when | orphans (`ppid 1`) | oldest |
|---|---|---|
| 2026-08-15, before an operator reap | 13 | `02-03:56:21` |
| 2026-08-16, after that reap + normal use | **14** | `01-01:33:59` |

13 were SIGKILLed on 2026-08-15; 14 were resident again the next day. The leak refills.

**They ignore SIGTERM.** A plain `kill` on all 13 (each `ppid==1`-verified) returned success and changed
nothing — a re-census 25 s later showed the same pids with ages advanced. `kill -9` took all 13
immediately, and again all 14 the next day. Any reaper that sends SIGTERM and trusts the return value
will silently leave the leak in place.

**Why it matters beyond tidiness.** Every orphan is a resident process competing with the fast tier —
the measurement this whole branch depends on. It is a standing suspect for `R-TIERWEDGE` (0-CPU tier
wedge, twice-reproduced at 6126 lines) and it pushes the timeout-shaped suites (`runGate`, hang-guard,
between-ticket-gate) toward flake. This is not proof of causation and the ticket must not claim it.

## Why the existing reaper does not cover it

`extension/src/services/orphan-reaper.ts` already owns the shape: `parseWorkerProcsFromPs` (`:144`),
positive-ownership matching, a `minAgeSeconds` floor (`:243`/`:271`, default at `:318`),
`killProcessGroup` (`:55`), and the entry point `reapOrphanedWorkerProcs` (`:340`). It matches worker
*procs* by `--add-dir` session ownership. The gate shims carry no session ownership — they are npm
children under a temp prefix — so they never match.

## Solution

Extend the existing reaper; do NOT write a second one.

1. Add a positive-ownership match for the `pickle-spawn-morty-worker-gate-` temp prefix, gated by the
   SAME `minAgeSeconds` floor already in the module. Positive ownership stays the invariant: match the
   prefix under `os.tmpdir()`, never a bare process name.
2. Escalate correctly: SIGTERM, then SIGKILL, then **verify death by pid**. Never treat a kill's return
   value as proof — measured above, it lies for these processes.
3. Preferred additionally (not instead): kill the shim's process group on the test's own timeout path, so
   the orphan is never created. Reuse `killProcessGroup`.

## Acceptance criteria

- **AC-1 — the prefix is reaped.** A test plants a fake `ppid 1` process (or a stubbed `ps` output)
  matching `pickle-spawn-morty-worker-gate-` older than the min-age floor and asserts
  `reapOrphanedWorkerProcs` selects it. It must go RED if the prefix match is removed.
- **AC-2 — min-age and ownership still hold.** A same-prefix process YOUNGER than the floor is NOT
  reaped, and a process that merely mentions the prefix in an unrelated argv position is NOT reaped.
  Positive ownership is not relaxed to a substring match on the whole command line.
- **AC-3 — death is verified, not assumed.** The reap path escalates SIGTERM → SIGKILL and confirms by
  pid. A test simulates a SIGTERM-immune process and asserts the reaper escalates and reports the pid as
  reaped only after it is actually gone.
- **AC-4 — a live worker is never touched.** A running worker proc owned by a LIVE session is not reaped
  under any of the new matching. This is the invariant the R-CXHANG reaper already holds and this ticket
  must not weaken it.
- **AC-5 — the leak is closed at the source (if WS-3 is taken).** Driving the gate test's timeout path
  leaves no `ppid 1` child behind. If the bundle cannot close it at the source, say so explicitly in the
  ticket and land AC-1..AC-4 alone — do NOT silently drop it.
- **AC-6 — tier green.** `npm run test:fast` reports `fail 0` AND `cancelled 0`, measured with
  `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and a clean environment. `cancelled > 0` is inconclusive:
  re-run, never report as pass. Test count must not shrink below 7707 — read the floor from the runner's
  own summary block, never from prose.
- **AC-7 — no new terminal condition, no new operator surface.** No new `exit_reason`, no new abort site,
  no new setting key, no new flag. `PICKLE_ORPHAN_REAP=off` remains the existing kill-switch and must
  disable the new matching too.

## Out of scope

`R-TIERWEDGE` itself — this bundle may reduce contention but must not claim to fix the wedge, and must
not add a wedge-detection mechanism. `R-SJLAGMT` and `R-GBANNER` likewise.

## Simplification Review

1. **What can be subtracted instead of added?** WS-3 is the subtractive option: killing the shim's group
   on the timeout path means the orphan never exists, so nothing needs reaping. Prefer it where possible;
   the reaper extension is the safety net for orphans already stranded.
2. **Does this add a new abort condition?** No — AC-7 forbids it. A reaper kills a dead session's leftover
   process; it never stops the run.
3. **Does this add a new configuration surface?** No — AC-7 forbids it and pins the existing kill-switch.
4. **Is a fix at this seam load-bearing for anything else?** Yes — the fast tier is the instrument every
   verdict in this branch depends on, and these orphans are permanent background load on the box running
   it.
