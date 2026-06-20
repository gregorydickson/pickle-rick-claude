# Bug Report — B-RRH external SIGTERM mid-bundle kill + manual salvage (2026-06-12)

**Session:** `2026-06-10-...`? NO — `2026-06-12-8f02855b` (B-RRH, v2.0.0-beta.2/3 bundle).
**Class:** recurrence of B-XSPA (external SIGTERM mid-bundle) — row 36, consolidated into B-RRH.
**Severity:** P2 (residual gap; the dangerous half was already fixed).

## What happened

At `2026-06-12T21:49:06Z` an **external** signal (`signal_received` activity event; not operator-issued, the recurring environmental SIGTERM/SIGINT class) killed the mux-runner (pid 76997) mid-bundle, **after E9b (`612217e2`) landed**. State froze at `active=false`, `step=completed`, `exit_reason=failed`, iter 17. All **16 implementation tickets were Done and committed on HEAD** (`b980e0fc`); only the **4 hardening tickets (71001154/ed840487/5495bee2/1cf82fe7) + closer (00fa0662)** remained Todo.

Two **verified-green** uncommitted edits were stranded in the working tree (a worker WIP when the signal hit):
- `extension/tests/rrh-forward-ref-coverage.test.js` — relaxed an over-strict `contract`-finding assertion to match actual R-FRA-6 resolver behavior (path teeth preserved; 7/7 green).
- `extension/CLAUDE.md` — documented the `rate_limit_park` INVARIANT (Workstream B / e9bdac75).

## What worked (positive signal)

The deployed **C1/C2 phase-gate fix (beta.2)** did its job: the runner did **NOT** prematurely advance pickle→citadel on the partial build. `pipeline-status.json` showed `completed_phases:1` from the signal teardown, but the main phase loop (`pipeline-runner.ts:3519`) re-evaluates ticket statuses on relaunch and has no `completed_phases`-based skip — so it correctly re-entered PHASE 1 PICKLE.

## Residual gap (the actual bug)

This interactive tmux session had **no auto-resume wrapper armed**, so an external signal requires **manual babysitter salvage**: commit verified work reset-proof → reset `step=research`/clear `exit_reason` → kill stale tmux → relaunch. The recurring environmental signal will keep costing a manual intervention per occurrence until either (a) the session is launched under `auto-resume.sh` (R-CNAR foreground wrapper), or (b) the environmental signal source is identified and removed.

## Recovery applied (babysitter, this session)

1. Verified all 16 impl tickets Done + committed on HEAD; orphan scan clean (no Failed-flip orphans).
2. Ran the affected test → 7/7 green; committed the 2 salvaged edits reset-proof as `97065d0e` (`fix(b-rrh): salvage interrupted test-correctness + rate_limit_park invariant doc`).
3. Reset `step=research`, `current_ticket=null`, cleared `exit_reason` via node StateManager (R-WSRC hook can't see inside node).
4. Killed stale tmux, relaunched via `launch.sh`. Runner re-entered PHASE 1 PICKLE, claimed lowest Todo `71001154`, new pid 27162 with live worker 27988.

## Proposed ACs (if promoted to a bundle)

- **R-XSIG-1:** when a B-RRH-class long bundle is launched in interactive tmux, document (or default) the `auto-resume.sh` wrapper so an external signal auto-recovers without manual salvage.
- **R-XSIG-2:** identify the recurring environmental SIGTERM/SIGINT source (cron? IDE? OS power event?) — file separately if reproducible.

Escalate to P1 only on a third manual-salvage recurrence in one bundle.

---

## ADDENDUM 2026-06-12 23:00Z — R-XSPA-2: signal-shutdown exit-0 DEFEATS the C1/C2 incomplete-bundle guard (PREMATURE ADVANCE, P1)

A **third** external signal (`signal_received` 22:52:37.955Z) hit the pickle mux-runner. This time the consequence was worse than a clean kill — the pipeline **prematurely advanced two phases on an incomplete bundle**:

```
signal_received                      22:52:37.955Z
Phase pickle exited with code 0      22:52:37.971Z   ← signal handler exits 0
Phase pickle completed successfully                  ← pipeline-runner advances
PHASE 2/4: CITADEL → PHASE 3/4: ANATOMY-PARK
```

At advance time only **16/21** tickets were Done (71001154 In Progress, 5495bee2/1cf82fe7/ed840487/closer 00fa0662 Todo). anatomy-park (microverse-runner pid 42992) ran on an incomplete bundle; the **closer never executed and nothing shipped**.

### Root cause (the C1/C2 gap)

The deployed C1/C2 / R-ICP-2 / R-PHC-6 incomplete-bundle guard fires on a **non-zero** pickle exit (`PipelineRunnerExitCode.PhaseIncomplete = 3`). But the mux-runner **signal-shutdown handler exits 0** (graceful). So a SIGTERM during pickle with pending tickets produces a clean exit-0 that `pipeline-runner` reads as "Phase pickle completed successfully" → advances. The guard never sees a non-zero code. This is the residual half of B-XSPA that the beta.2 fix did **not** close.

### Proposed AC (P1)

- **R-XSPA-2:** the mux-runner signal-shutdown path MUST, when pending (Todo/In-Progress) tickets remain in the bundle, exit with `PipelineRunnerExitCode.PhaseIncomplete (3)` (or stamp `exit_reason='pipeline_phase_incomplete'` that `pipeline-runner` honors) instead of exit 0 — so the incomplete-bundle guard fires and the pipeline does NOT advance pickle→citadel on a signal-truncated build. ENFORCE: an integration test that SIGTERMs the pickle mux-runner mid-bundle and asserts pipeline-runner does NOT enter citadel/anatomy-park.

### Recovery applied (2nd salvage this bundle)

1. Froze the whole session tree (2 pipeline-runners 27054/14425, 2 microverse-runners 42992/46183, worker) — killed.
2. Reconciled: 71001154 work is committed reset-proof (`1b2697d3` + 6 lines swept into anatomy auto-commit `9a1ccf9a`); tree clean; no orphans.
3. Kept 71001154 In Progress (full research+plan+impl artifacts present → resume, not restart); reset `step=research`/`current_ticket=null`/cleared `exit_reason`; killed stale tmux; relaunched.
4. Runner re-entered PHASE 1 PICKLE (pid 53498, worker 53945), resumed 71001154 at `step=implement`.

**Escalating R-XSIG/R-XSPA-2 to P1** — this is the 2nd manual salvage in one bundle AND it exposed a premature-advance code gap, not just a missing wrapper.

---

## RECURRENCE LOG

- **#4 — 2026-06-13T00:10:45Z (3rd salvage).** External SIGTERM during pickle (building ed840487, after 71001154 reached Done). This time the **cancel-marker path caught it cleanly** — `Phase pickle exited code 0` → `Pipeline cancelled (cancel marker found) — stopping` → finished 1/4 phases, NO premature advance (contrast the 22:52 exit-0 advance). Strays left behind: a duplicate pipeline-runner (21344) + idle launch.sh (53388) — killed. No cancel marker persisted. ed840487 auto-reset Todo; tree clean; no work lost. Recovered: reset state → relaunch → pid 38204 resumed pickle on ed840487. **NOTE: `auto-resume.sh` (R-XSIG-1) does NOT fix this class — it STOPS on `exit_reason=failed` (R-CNAR-4c), which is exactly what these signal kills produce. Only the R-XSPA-2 code fix (signal-shutdown exits `pipeline_phase_incomplete`) would make the run auto-recoverable.** Signal cadence ~hourly; manual salvage required per occurrence until R-XSPA-2 ships. State: 17/21 done, 3 hardening + closer remain.

- **#5 — 2026-06-13 ~02:00Z (4th salvage) — MULTI-RUNNER CONTAMINATION.** Repeated signal+relaunch cycles accumulated **stray runners that did not die**: at this tick the session had 3 pipeline-runners (51773/42423/38081), a stray mux-runner (38204), a microverse-runner (21766) + 3 orphaned `node --test` runners, all alive and **fighting over one state.json**. state.pid=21766 was an ANATOMY-PARK microverse-runner (premature-advance artifact) while state.step said `research`/closer — **state was incoherent because competing runners overwrote each other**. The premature-advance check was fooled (read stale `step=research`). 20/21 had completed (hardening ed840487/5495bee2/1cf82fe7 Done, anatomy committed a real release-gate SIGPIPE fix `d5603a28`); closer In Progress. A persisted `pipeline-cancel` marker was also present. Recovered: froze the entire tangle (TERM then SIGKILL), removed cancel marker, reset state, relaunched ONE clean runner (chain 27557→27563→28117→29117) on the closer. **Two process lessons:** (i) the babysitter relaunch recipe must kill ALL prior strays scoped to the SESSION (a single missed stray compounds across signal cycles into N competing runners); (ii) **scope process kills to the session dir, NEVER bare binary names** — a broad `pkill mux-runner|pipeline-runner` SIGKILL pass in this recovery also killed pid 15054, the out-of-scope `c653c95f` orphan (benign — that session was already `active=false`, but a scope violation). **R-XSPA-2 + a new R-XSMR (stray-runner reaping on relaunch) are the real fixes.** State: 20/21 done, closer In Progress under clean single runner pid 28117.
