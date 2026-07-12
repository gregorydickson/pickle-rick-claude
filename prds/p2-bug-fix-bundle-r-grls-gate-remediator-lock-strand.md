---
title: "R-GRLS (reuse-first) — the gate remediator's hand-rolled lock strands on SIGKILL and makes every later remediator exit CLEAN without remediating"
priority: P2
finding: R-GRLS
status: "open — filed 2026-07-12; latent (code-verified + anatomy-park OPEN GAP), not yet field-fired"
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
depends_on: "none (deploy-agnostic BUILD; pipeline-safe — see Routing)"
source_assessment: "Surfaced by anatomy-park (session 2026-07-11-255ad373, iterations 9 + 13) as AP-EXT-REMEDIATOR-LOCK-EMPTY-PAYLOAD-SILENT-NOOP; recorded as an OPEN GAP on the state-manager gate-lock trap door in extension/CLAUDE.md and left unfixed because bin/spawn-gate-remediator.ts is outside that run's scope.json allowed_paths. Source re-verified independently 2026-07-12."
---

# P2 Bug-Fix Bundle — R-GRLS: the last un-reclaimed lock is a false-GREEN gate

## Context

Anatomy-park found and fixed a **dead-holder recovery gap** in three separate locks during session
`2026-07-11-255ad373`:

- `withRetryLock` — dead-holder steal via `isDeadPidPayload` (`stealStaleLock`).
- `withLock` (the gate lock) — `reclaimDeadGateLock` (`withStealRight` + `isDeadPidPayload` + `stealLockFile`), commit `ae0e1a88`.
- the restructure lock — same shape, commit `498efe04`.

Each had the same failure: one `SIGKILL` stranded the lockfile and wedged every later acquirer, forever.

**`bin/spawn-gate-remediator.ts` has the same lock and did not get fixed** — it sits outside the run's `scope.json`
`allowed_paths`, so the run could only catalog it. It is recorded verbatim as an `OPEN GAP` on the `state-manager.ts`
gate-lock trap door in `extension/CLAUDE.md`:

> OPEN GAP: `bin/spawn-gate-remediator.ts:240` `acquireLockfile` (out of fence) writes NO payload at all and cleans up
> only via `process.on('exit')`, which SIGKILL skips — a strand makes every later remediator exit CLEAN without
> remediating. Unfixed.

This one is worse than its siblings, because it does not wedge. **It fails silently green.**

## Root cause

`extension/src/bin/spawn-gate-remediator.ts:232-265`, `acquireLockfile`, verified 2026-07-12:

1. **The lock carries no payload.** It acquires with
   `openSync(lockfilePath, O_CREAT | O_EXCL | O_WRONLY)` then immediately `closeSync(fd)` — **nothing is ever written
   into the file**. Every sibling lock in the codebase writes at least a bare pid (`acquireLockFile(lp, String(process.pid))`).

2. **Cleanup is `process.on('exit')`-only.** `SIGKILL`, OOM, and a hard crash all skip it. The lockfile survives the
   process that made it.

3. **A strand makes the remediator a silent no-op.** On `EEXIST` the function writes a
   `remediator_concurrent_lockout_<iso>.md` doc, prints `LOCKOUT_PATH=…`, and returns **`{ ok: false, exitCode: 0 }`**
   — the process exits **0** having remediated nothing. The doc itself says the quiet part out loud:
   *"This invocation exited cleanly without performing any work."*

So after one abrupt death, **every subsequent remediator invocation for that session exits 0, edits nothing, and the
caller cannot tell it apart from a successful remediation.** A red gate is reported as handled. That is the
false-GREEN class — the exact class this park kept finding, in the one component nobody could reach.

4. **The empty payload would silently defeat a naive fix.** `isDeadPidPayload` parses an empty payload to `NaN`, so a
   steal bolted onto the current lock would **never fire**. Any fix must write a real pid payload — which is precisely
   what the shared primitives already do.

**Not yet observed firing in the field.** No `remediator_concurrent_lockout_*.md` exists in the session; this run's
remediator aborts were R-BCFR refusals, not lockouts. R-GRLS is filed as a **latent** defect on code evidence plus the
anatomy-park OPEN GAP — deliberately, before it costs a bundle.

## WS-1 — reclaim a dead holder via the shared primitives (SHIP)

The fix is **not new machinery**. Three exported primitives already solve exactly this problem for the sibling gate
lock, landed by `ae0e1a88` in this very session. Reuse them.

### Changes

- `extension/src/bin/spawn-gate-remediator.ts`: delete the hand-rolled `acquireLockfile` body
  (`openSync`/`O_EXCL`/`closeSync`/`EEXIST` branch/`process.on('exit')` cleanup) and route through:
  - `acquireLockFile(lockfilePath, String(process.pid))` — a **real pid payload**, so death is provable;
  - `reclaimDeadGateLock(...)` on contention — `withStealRight` + `isDeadPidPayload` + `stealLockFile`; steals **only a
    provably dead holder**, never a live one;
  - `releaseLockFile(lockfilePath, ino)` — inode-bound, so no process removes a lock it did not create.
- Do **not** add the age-based steal arm `withRetryLock` carries: a remediator legitimately holds for minutes, and an
  age verdict would evict a live holder mid-toolchain. (This is the same reasoning the `withLock` trap door pins.)

### Acceptance criteria (machine-checkable)

- `AC-GRLS-1`: `grep -c "O_EXCL\|process.on('exit')" extension/src/bin/spawn-gate-remediator.ts` == `0`.
- `AC-GRLS-2`: `spawn-gate-remediator.ts` contains `acquireLockFile(`, `reclaimDeadGateLock(`, and `releaseLockFile(`,
  each exactly once on the lock path; it defines **no** local lock primitive of its own.
- `AC-GRLS-3`: the lockfile written by a running remediator contains a parseable positive-integer pid
  (`isDeadPidPayload` on it returns `false` while the holder lives).
- `AC-GRLS-4`: **regression test** — a remediator is `SIGKILL`ed mid-run (stranding its lock), then a second remediator
  is invoked on the same session: it **reclaims** the dead holder and **performs the remediation**. Pre-fix this test
  must fail (second invocation exits 0 having edited nothing).
- `AC-GRLS-5`: a lock held by a **live** holder is never stolen (the second invocation defers, does not remediate, and
  reports it — see WS-2).
- `AC-GRLS-6`: full release gate green from `extension/`.

### Simplification Review (subtract-before-add) — WS-1

1. **Is the addition necessary at all?** WS-1 adds **no new primitive**. It *deletes* a hand-rolled lock and calls three
   functions that already exist. Net LOC is negative.
2. **Can it REUSE instead of ADD?** Yes — that is the whole workstream. `acquireLockFile` / `reclaimDeadGateLock` /
   `releaseLockFile` already ship, already carry the dead-holder logic, and already have the ENFORCE tests
   (`lock-steal-live-holder.test.js`). Writing a bespoke steal here would make this the **fourth** parallel lock
   implementation in the codebase — the one-adapter-rule smell, and the exact accretion that produced this bug.
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** The brittle thing *is* the
   hand-rolled lock. We delete it rather than wrap it.
4. **What can this issue SUBTRACT?** The hand-rolled `acquireLockfile` body, the payload-less lockfile convention, and
   the `process.on('exit')` cleanup that never fires on the one path that matters. Fourth divergent lock → zero.

## WS-2 — a lockout must not read as a remediation (SHIP)

WS-1 closes the *strand*. It does not, on its own, close the *honesty* gap: a genuinely concurrent **live** holder still
makes the second invocation exit 0 with zero work done, and the caller still reads exit 0 as "gate remediated."

### Changes

- Reuse the **existing** result-artifact contract rather than inventing an exit code: the lockout path writes the same
  `remediation_<iso>_result.json` the abort path already writes, with `outcome: "locked_out"`, `failures_remediated: 0`,
  `files_edited: []`.
- The caller (`pipeline-runner` / `microverse-runner` remediation-result reader) must classify `locked_out` as
  **"no remediation performed"**, never as success. It already reads this artifact for the `aborted` outcome — this is
  one more member of an existing enum, not a new channel.

### Acceptance criteria (machine-checkable)

- `AC-GRLS-7`: a lockout invocation writes `remediation_<iso>_result.json` with `outcome: "locked_out"` and
  `failures_remediated: 0`.
- `AC-GRLS-8`: the caller's remediation-result reader does **not** classify `outcome: "locked_out"` as a successful
  remediation; a red gate whose only remediator attempt was locked out stays red (test-asserted).
- `AC-GRLS-9`: `grep -c "exitCode: 0" ` on the EEXIST branch — the lockout return must be distinguishable from a
  completed remediation by the **artifact**, and the ticket states explicitly whether the exit code stays 0 (a live
  concurrent holder is not an *error*) or changes; if it stays 0, AC-GRLS-8 is the only thing standing between us and
  the false-GREEN, so it is **not optional**.

### Simplification Review (subtract-before-add) — WS-2

1. **Is the addition necessary at all?** It adds exactly one **enum member** (`locked_out`) on an artifact that already
   exists and is already read. Without it, WS-1's fix still leaves "no work done" indistinguishable from "work done" on
   the live-holder path — the defect this bundle exists to close.
2. **Can it REUSE instead of ADD?** Yes, and it does: the `remediation_*_result.json` contract, its writer, and its
   reader all already exist for `outcome: "aborted"`. No new file, no new exit-code convention, no new gate.
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** No. It makes an existing signal
   honest rather than adding a guard around a dishonest one.
4. **What can this issue SUBTRACT?** The bespoke `remediator_concurrent_lockout_<iso>.md` markdown doc — it exists only
   because there was no structured way to say "locked out." Once the result-json carries `locked_out`, the prose doc is
   redundant: **delete it** and let the one artifact carry the truth.

## Risks

- **Stealing a live holder.** The single worst outcome — two remediators editing one tree. Mitigated by construction:
  `reclaimDeadGateLock` steals only on `isDeadPidPayload` (positive-integer pid **and** `!isProcessAlive`), under
  `withStealRight`, and we deliberately do **not** port `withRetryLock`'s age-based arm. AC-GRLS-5 pins it.
- **The reader change ripples.** `outcome: "locked_out"` reaches whatever consumes remediation results. The ticket must
  enumerate the consumers (the R-CLOSER-ADJACENCY-AUDIT step-4 cross-module importer check) rather than patching the
  first one it finds.

## Out of scope

- The fabricated `banned-construct` rule that produced this session's 43 unremediated findings — filed separately as
  **[[R-BCFR]]**. The two are independent: R-BCFR is a bad *input* to a correctly-behaving remediator; R-GRLS is a
  latent false-GREEN in the remediator's *lock*.
- Any change to `withRetryLock` / `withLock` / the restructure lock. Those three shipped their dead-holder recovery this
  session (`ae0e1a88`, `498efe04`); this bundle brings the fourth into line with them, and changes nothing about them.

## Routing

**Pipeline-safe (NOT R-PSRB).** Touches `bin/spawn-gate-remediator.ts` plus a result-reader callsite — not the
salvage / completion-evidence / Done-flip path (`mux-runner.ts` salvage logic, `salvage-ticket.ts`,
`reconcile-ticket-truth.ts`, `ticket-completion-evidence.ts`). The build worker runs the **deployed** remediator, not
this source diff, so the fix cannot sabotage the run that produces it. Drain via `/pickle-pipeline`.
