# BUG — the 4-phase orchestrator hangs between phases and reports `running` while dead

**Status:** ready to refine
**Branch:** `release/v2.1-beta`
**Launch commit:** `e4b5bf03`
**Build mode:** unattended, via `/pickle-tmux` — **NOT** `/pickle-pipeline`
**Priority:** P0 (reliability)

> **Build-path note.** This bundle fixes `pipeline-runner.ts`, the 4-phase orchestrator. Building it
> through `/pickle-pipeline` would run the broken orchestrator to fix the broken orchestrator. The
> single-phase path (`/pickle-tmux` → `mux-runner`) is unaffected by every defect below — it ran 14
> iterations over 306 minutes and exited cleanly during the incident. This is a routing choice, not a
> hand-build exception: the work is still built by a pipeline.

---

## Problem

On 2026-08-11 a 4-phase run completed phase 1 and then hung for **18 hours** without advancing,
without erroring, and while reporting `"status": "running"`.

### Measured facts (session `2026-08-10-3d58fed2`)

```
pipeline-runner.log   last line 13:43:41Z  "PHASE 1/4: PICKLE (backend=claude)"   (never logged phase 2)
pipeline-status.json  {"status":"running","current_phase":"pickle","completed_phases":0,
                       "updated_at":"2026-08-11T13:43:41.713Z"}                   (frozen at phase-1 START)
mux-runner.log        18:50:20Z  "mux-runner finished. 14 iterations, 306m 38s"   (clean child exit)
ps                    99886  99590  Z  <defunct>                                  (zombie, 18h)
ps                    99590      1  S  23:23:07  pipeline-runner.js .../3d58fed2  (orphaned, 0% CPU)
tmux                  pipeline-3d58fed2 GONE; 7 sibling pickle sessions survive
```

**The zombie is the load-bearing evidence.** A zombie persists only until its parent reaps it, and
Node reaps automatically when it delivers `'exit'`. `spawnRunner` resolves its promise from
`child.on('exit')` (`extension/src/bin/pipeline-runner.ts:1329-1336`). Therefore the `'exit'` handler
**never ran** — for 18 hours — while the parent sat in state `S` at 0% CPU.

Phases 2-4 (citadel, anatomy-park, szechuan-sauce) never started.

### This is a regression, not a design flaw

Phase completion across every session carrying a `pipeline-status.json`:

| Session | Status | Phases completed |
|---|---|---|
| 2026-08-05 | **completed** | **4/4** |
| 2026-08-06 | failed | 3 |
| 2026-08-07 | cancelled | 2 |
| 2026-08-08 | failed | 3 |
| 2026-08-09 | failed | 3 |
| 2026-08-10 (`b5ae9d8a`) | failed | 1 |
| 2026-08-10 (`3d58fed2`) | cancelled | **0** |

Last clean 4-phase run: **2026-08-05**. 14 commits have touched `pipeline-runner.ts` since
(`git log --since=2026-08-05 -- extension/src/bin/pipeline-runner.ts`), the majority authored by the
anatomy-park and szechuan-sauce phases themselves.

### What is NOT yet known

**The mechanism is unproven.** Candidate hypotheses, none confirmed:

1. The `'exit'` event was never delivered (event-loop or handle state).
2. `armChildMuxRunnerHeartbeat` (`:1226`, armed at `:1305`) should have caught a stalled child and did
   not — so a watchdog already exists and failed.
3. The launch shell was killed by a group signal. `killProcessGroup` (`services/orphan-reaper.ts:55-63`)
   issues `process.kill(-pid, signal)`; `mux-runner.log` records two reaps (`13:56:20 pid=23455`,
   `18:39:11 pid=7015`) but logs **no PGID and no member list**, so the blast radius is unrecorded and
   the hypothesis is untestable from existing artifacts.

Ruled out by inspection: the test suite (no `pkill`, `killall`, or `tmux kill-session` anywhere under
`extension/tests/`); a stdio-drain stall (`spawnRunner` resolves on `'exit'`, not `'close'`);
`e714c3c5` (`setEncoding`, decode-only) and `190c03a7` (`maxBuffer` on git calls).

**WS-A is deliberately written to survive an unproven cause.** Per the root `CLAUDE.md` ratchet —
reliability first, quality second — a run that completes with flags beats a correct diagnosis of a run
that hung.

---

## Secondary defect, same incident

A **zero-diff ticket fabricated its completion evidence.**

`3afa92b0` is the verification ticket: *"Files to modify/create: none. This ticket measures and writes
an artifact."* It cannot produce a commit by construction. The guard rejected it:

```
[fatal] ticket 3afa92b0 cannot flip Done: readEvidence().kind === 'absent'
        (expected 'committed'); worker did not produce an attributable git commit.
```

It was then stamped with **two different foreign SHAs in succession** — first `4d289582`
(`7e3b9ef5`'s commit), then `f0992812` (`c6fe78ec`'s commit). Neither is its own work. Whatever
resolved the fatal did so by borrowing the current tip.

---

## Interface Contracts

`pipeline-runner` is a process orchestrator. Its contract is stated as observable invariants.

**Inputs** — `pipeline.json` (`phases`, `target`, per-phase limits, optional `scope`), a session dir.

**Outputs** — `pipeline-status.json`, `pipeline-runner.log`, per-phase child processes, exit code.

**Invariants**

- **P1 — bounded wait.** No phase may block indefinitely on a child process that is no longer running.
  For any phase, if the child PID is unreachable (`kill(pid, 0)` throws `ESRCH`) the orchestrator
  reaches a terminal disposition for that phase within a bounded window.
- **P2 — status truthfulness.** `pipeline-status.json` never reports `"running"` when no phase child is
  alive. A consumer can distinguish *running*, *stalled*, and *finished* from the file alone.
- **P3 — attributable completion.** A ticket's `completion_commit`, when present, is a commit produced
  by that ticket's own work — never another ticket's SHA.
- **P4 — forensic sufficiency.** Every process-group signal records the PGID it targeted and the
  members it reached, sufficient to attribute a later unexplained process death.

---

## WS-A — No phase may wait unbounded (P0, tier `medium`)

**Not "add a watchdog" — a watchdog already exists and did not fire.** `armChildMuxRunnerHeartbeat`
(`:1226`) is armed at `:1305` when `isMuxRunnerInvocation(args)`. The research phase must establish
why it did not resolve this hang **before** any new mechanism is added; if the existing heartbeat can
be repaired, that is the fix, and no second mechanism ships. Adding a parallel watchdog beside a
broken one is the exact anti-pattern this repo's subtract-before-add rule names.

- **AC-A0** — the ticket states, with citations, why `armChildMuxRunnerHeartbeat` did not terminate
  this hang: whether it was armed, whether its interval fired, and what its no-progress predicate
  evaluated to with a dead child and a live parent. This gates AC-A1.
- **AC-A1** — a phase whose child process has exited but whose promise has not settled reaches a
  terminal disposition within a bounded window. Preference order, stated in the ticket with a reason:
  (a) repair the existing heartbeat; (b) a liveness probe in `spawnRunner` itself; (c) a new timer.
- **AC-A2** — a test drives a real child that exits without its `'exit'` handler running (simulate by
  detaching the listener after spawn, or by injecting a `spawnRunner` whose promise never settles) and
  asserts the pipeline advances or terminates rather than hanging. **Must fail against `e4b5bf03`.**
- **AC-A3** — the resolution is observable: a distinct activity event or log line names the condition
  (child gone, promise unsettled), so the next occurrence is attributable from artifacts alone.
- **AC-A4** — the bounded window is a named constant with an env override, following the
  `PICKLE_EXIT_DRAIN_FALLBACK_MS` precedent (`mux-runner.ts`), not a literal.
- **AC-A5 — disposition (binding).** The bounded escape parks the phase, flags it, and **continues**;
  it does not halt the pipeline. A phase that cannot complete is recorded as a residual and the run
  proceeds to the next phase. Halting is reserved for the crash floor.

## WS-B — `pipeline-status.json` must not be able to lie (P0, tier `small`)

An 18-hour-old `"status":"running"` with a dead child is fake-green: the failure mode the root
`CLAUDE.md` names as this codebase's most frequent.

- **AC-B1** — `pipeline-status.json` carries enough state to distinguish *running* from *stalled*
  without consulting `ps`. Either a heartbeat (`updated_at` refreshed on a timer while a phase is
  genuinely alive) or an explicit liveness field. The ticket picks one and states why.
- **AC-B2** — a test writes a status file whose `updated_at` is older than the staleness threshold with
  no live child and asserts a reader classifies it stalled, not running. **Must fail against `e4b5bf03`.**
- **AC-B3** — `/pickle-status` surfaces the stalled disposition. A truthful file nobody reads is not the
  fix.
- **AC-B4** — no change to `pipeline-status.json`'s existing keys or their meanings; additive only
  (`writePipelineStatus`, `:1366-1389`, already carries optional-key precedent).

## WS-C — Zero-diff tickets need a legitimate completion disposition (P1, tier `medium`)

A measurement-only ticket cannot produce a commit. The guard is correct to reject an absent commit; the
bug is what happens next.

- **AC-C1** — a ticket that legitimately produces no diff reaches a terminal status without being
  stamped with another ticket's SHA. The mechanism is the ticket's choice — a `no-diff` disposition, an
  explicit frontmatter declaration, or an artifact-based evidence kind — but a foreign SHA is never it.
- **AC-C2** — a test constructs a zero-diff ticket, drives it to terminal, and asserts its
  `completion_commit` is either absent or its own; specifically that it does **not** equal any other
  ticket's `completion_commit`. **Must fail against `e4b5bf03`** (reproduce: `3afa92b0` carried
  `f0992812`, which is `c6fe78ec`'s).
- **AC-C3** — the fix does not weaken `readEvidence` for tickets that *should* have produced a commit.
  A test asserts a code-producing ticket with no commit is still refused.
- **AC-C4** — the existing 8-path completion-commit characterization suite
  (`extension/tests/characterization/completion-commit-cluster/`) stays green.

## WS-D — Group kills must record their blast radius (P1, tier `small`)

`killProcessGroup` (`services/orphan-reaper.ts:55-63`) sends `process.kill(-pid, signal)` and logs
nothing about scope. Two reaps fired during the incident; neither can be attributed.

- **AC-D1** — every `killProcessGroup` call records the PGID signalled and the signal sent.
- **AC-D2** — where cheap, the member PIDs are enumerated before signalling and recorded. If the
  enumeration cost is judged too high, the ticket states that and records the PGID alone.
- **AC-D3** — **`launch_shell_pid` gains a consumer.** It is declared at `types/index.ts:30` and read by
  **nothing** (`grep -rn 'launch_shell_pid' extension/src/` returns one hit: the declaration). It is
  written by every session's `launch.sh`. A liveness check on it, surfaced in `/pickle-status` and in
  the WS-A residual, would have answered this incident's central open question — *did the launch shell
  die, and when* — in one probe. This is pure activation of an existing field, not new machinery.
- **AC-D4** — logging only; no change to kill behaviour, targeting, or timing. A test asserts the
  signal sent and PGID targeted are unchanged from `e4b5bf03`.

## WS-E — Name the regression (P1, tier `medium`, investigation)

The decay is dated but not attributed. This workstream **runs the claim** rather than asserting it.

- **AC-E1** — enumerate every commit touching `pipeline-runner.ts` in `45cda0bd`..`e4b5bf03` and, for
  each, state whether it could affect child-process lifecycle, phase transition, or halt
  classification. Recorded as a table in the ticket artifact.
- **AC-E2** — for the two 2026-08-06 commits at the inflection — `f7381297` ("collapse the classifier
  abort to the crash floor") and `81a44676` ("name the reason at every logPhaseHaltReason termination
  site") — state whether either changes whether a phase transition is reached. The `B-ONEABORT` trap
  door in `src/bin/CLAUDE.md` already records "two fix commits in a row here" as a known hazard.
- **AC-E3** — if a specific commit is identified, a regression test pins the behaviour it broke.
  If none is, the ticket says so plainly. **A named suspect without a reproducing test is not an
  answer** — record it as an open residual rather than closing the workstream.
- **AC-E4** — this workstream may NOT revert anything. WS-A makes the failure survivable; reverting a
  cleanup-phase fix to chase a hypothesis risks reintroducing whatever it fixed.

---

## Verification ticket (tier `medium`)

- **AC-V1** — a 4-phase pipeline runs end-to-end on a small bundle and reaches
  `completed_phases: 4`. This is the claim the bundle exists to restore, and nothing short of running
  it verifies it.
- **AC-V2** — with a phase child killed mid-run (SIGKILL to the mux child), the pipeline reaches a
  terminal disposition within the WS-A bounded window rather than hanging. Record the observed window.
- **AC-V3** — `pipeline-status.json` at every point during AC-V2 is classifiable as running or stalled;
  at no point does it report `running` with no live child.
- **AC-V4** — no zombie child survives the run: `ps -o stat= -p <child>` shows no `Z` after the
  pipeline exits.
- **AC-V5** — record `uptime`, core count, and whether other repos' runners were live, alongside every
  measurement. This box routinely runs 15-20 `pipeline-runner.js` processes belonging to other repos;
  **any process predicate must be scoped to the session path, never the binary name** (a bare
  `pipeline-runner.js` match cost a full gate window on 2026-08-12).

---

## Simplification Review

### WS-A
1. **Necessary?** Yes — an unbounded wait converted a 4-phase pipeline into a 1-phase pipeline silently.
2. **Reuse instead of add?** **Mandated.** A watchdog already exists (`armChildMuxRunnerHeartbeat`);
   AC-A0 forces the repair-vs-replace question before any new mechanism. `PICKLE_EXIT_DRAIN_FALLBACK_MS`
   is the precedent for the constant.
3. **Guards existing brittle complexity?** It guards a child-lifecycle path whose failure mode is not
   yet understood. That is a deliberate, stated trade: reliability first, root cause second.
4. **Subtract?** If AC-A0 finds the existing heartbeat is unrepairable dead weight, deleting it while
   adding the probe is a net-zero line change and a net subtraction in mechanisms.

### WS-B
1. **Necessary?** Additive fields only.
2. **Reuse instead of add?** Reuses `writePipelineStatus`'s existing optional-key pattern (`:1381-1388`).
3. **Guards brittle complexity?** No — it makes an existing artifact honest.
4. **Subtract?** Subtracts a *lie*, which is the highest-value subtraction available: every downstream
   consumer currently trusts a field that can be 18 hours stale.

### WS-C
1. **Necessary?** A disposition for zero-diff tickets. Small.
2. **Reuse instead of add?** Prefer an existing `EvidenceKind` or the salvage disposition set over a new
   enum member; the ticket must try reuse first and justify a new member if it adds one.
3. **Guards brittle complexity?** No — it corrects a workaround (foreign-SHA stamping) that is worse
   than the fatal it was routing around.
4. **Subtract?** Subtracts the foreign-SHA path entirely.

### WS-D
1. **Necessary?** Logging only.
2. **Reuse instead of add?** AC-D3 is **pure activation of an existing field** — `launch_shell_pid` is
   already declared and already written; only the reader is missing.
3. **Guards brittle complexity?** No.
4. **Subtract?** No subtraction. Justified by an unanswerable question in this very incident: without
   it, the launch-shell hypothesis stays permanently untestable.

### WS-E
1. **Necessary?** Adds no code.
2. **Reuse instead of add?** Uses git history and existing tests.
3. **Guards brittle complexity?** No — it names it.
4. **Subtract?** May identify a revert candidate, but AC-E4 forbids acting on it in this bundle.

### The question this review must not dodge

**Does the 4-phase orchestrator earn its existence?** Running `/pickle-tmux`, `/citadel`,
`/anatomy-park`, `/szechuan-sauce` as four invocations has no cross-phase hand-off to hang, and the
hand-off is exactly what broke.

**Answer: yes, keep it — and the evidence is the decay table, not preference.** It completed 4/4 as
recently as 2026-08-05. A module that worked and regressed is a regression to fix, not a design to
delete; deleting it would discard working sequencing, scope refresh, and status reporting to avoid a
defect introduced in a 14-commit window. Revisit only if WS-E finds the hand-off is unfixable.

### A governance question this bundle raises but does not answer

Of the 14 commits that touched `pipeline-runner.ts` during the decay window, most were authored by
anatomy-park and szechuan-sauce — **the cleanup phases editing their own orchestrator.** Reliability
went 4→3→2→3→3→1→0 across that window. This may be coincidence; the sample is small and no causal link
is established. It is recorded here because it is the kind of pattern that is invisible unless written
down, and because deciding whether cleanup phases should be scope-fenced away from
`pipeline-runner.ts` is an operator decision, not a worker's. **Out of scope for this bundle.**

---

## Residuals (recorded, not fixed)

1. **Mechanism of the missed `'exit'` event** — unproven. WS-A makes it survivable; WS-E may name it.
   If neither does, this stays open.
2. **The launch-shell death** — `tmux` session `pipeline-3d58fed2` vanished while 7 siblings survived.
   The group-kill hypothesis is untestable until WS-D lands.
3. **`INV-CODEX-RECOVERY-ADVANCED`** — the one genuine red integration test, undiagnosed across three
   bundles. Unrelated to this incident; named so a green run is not mistaken for a clean tier.

---

## Pre-launch checks

- **Stale-premise** — `spawnRunner`'s `child.on('exit')` resolution (`:1329-1336`), the zero
  `launch_shell_pid` readers, and `killProcessGroup`'s unlogged blast radius were each verified at
  `e4b5bf03` on 2026-08-12. Re-grep before launch.
- **Green-tree** — the release gate must be green on the launch commit. When running it, scope
  `RUN_EXPENSIVE_TESTS=1` to the `test:expensive` step only: exporting it for the whole gate makes
  `audit-bundle-thesis.sh`'s canary inherit a 30-minute soak inside a short timeout and die
  `Terminated: 15` (observed 2026-08-12).
- **Build path** — `/pickle-tmux`, not `/pickle-pipeline`. See the note at the top.
