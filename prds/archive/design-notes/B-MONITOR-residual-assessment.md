# B-MONITOR (#29 R-MWCL) — Residual Assessment

**Verdict: ALREADY CLOSED. No bundle to author.** The MASTER_PLAN finding #29 note
("R-MWCL-1 shipped; 3..7 residual") is **stale**. All seven R-MWCL tickets
(R-MWCL-1 … R-MWCL-7) shipped together in **v1.80.2**, alongside the adjacent
R-MDS / R-MWR monitor-respawn fixes. The monitor layout is correct during
`/pickle-pipeline` anatomy-park / szechuan-sauce phases today.

---

## The key question — answered

> During `/pickle-pipeline`, `state.command_template` stays `_pickle-manager-prompt.md`
> for ALL phases. Does `inferMonitorMode` (which reads `command_template`) still return
> `'pickle'` during the anatomy / szechuan phases — i.e. is the monitor layout wrong?

**`inferMonitorMode` DOES return `'pickle'` for the whole pipeline — but that is
irrelevant to the live dashboard, because two independent R-MDS/R-MWCL paths
re-drive the monitor off `state.step`, not `command_template`.**

### Why `command_template` stays `pickle` (confirmed)

`pipeline-runner.ts:1078` (`enterPicklePhase`) hard-pins
`s.command_template = '_pickle-manager-prompt.md'`. It is the manager-prompt replay
template, not the per-phase skill. So `inferMonitorMode(sessionDir)`
(`pickle-utils.ts:1959`, glob `pickle*→pickle`) correctly returns `'pickle'` for
every pipeline phase. `inferMonitorMode` is the **window-creation / re-attach**
selector (`monitor.ts:966`, `ensureMonitorWindow`) — it picks the layout once when
the monitor window is (re)spawned. It was never the live phase tracker.

### Path 1 — phase-boundary respawn keys off the PHASE, not command_template (R-MDS-1/4)

At every non-citadel phase boundary, `pipeline-runner.ts:2926` calls
`respawnMonitorWindowForMode(runtime.sessionDir, phase, ...)`. The phase→mode map is in
`monitor-respawn.ts:10` `phaseToMode`:

```ts
if (phase === 'anatomy-park' || phase === 'szechuan-sauce') return 'microverse';
```

so the dashboard pane is respawned as `node monitor.js --mode microverse <sessionDir>`
(`monitor-respawn.ts:66`) for both microverse phases — independent of
`command_template`. (`pipeline-runner.ts` trap door R-MDS-1/R-MDS-4 in
`extension/CLAUDE.md` pins `respawnMonitorWindowForMode` invocation count ≥ 3.)

### Path 2 — defense-in-depth render-tick re-check off `state.step` (R-MDS-3 / R-MWCL-2)

Even if the respawn races or the operator reattaches, `monitor.ts:1087` calls
`checkAndSwapMode(sessionDir, mode)` on **every render tick** (the 2 s loop). That
helper (`monitor.ts:348`) reads `state.step` and maps it via
`inferModeFromStep(step)` (`monitor.ts:327`):

```ts
if (step === 'anatomy-park' || step === 'szechuan-sauce') return 'microverse';
```

`pipeline-runner.ts` writes `state.step = '<phase>'` at each phase boundary (phase-step
write trap door). So the live dashboard hot-swaps to the microverse layout off
`state.step` within one tick regardless of `command_template`. R-MWCL-2 additionally
made `render()` treat a transient mode mismatch as recoverable (`{active:false}`+retry)
rather than `process.exit(2)`, so the start-up race can no longer kill the dashboard.

**Net:** the monitor shows the phase-correct (microverse) layout during pipeline
anatomy-park / szechuan-sauce. The `command_template==pickle` fall-through is by design
and inert.

---

## What R-MWCL-1..7 actually shipped (all in v1.80.2)

Source PRD: `prds/archive/bug-reports/p3-monitor-watcher-collapsed-layout-repair-gap.md` (tickets at lines
138–172). Earliest tag containing every commit: **v1.80.2** (`git tag --contains 7a22bfe1`).

| Ticket | Commit | What landed |
|---|---|---|
| R-MWCL-1 | `4fab22d1` | `inferMonitorMode` reads `command_template` (was hard `'pickle'`) for the window-creation selector |
| R-MWCL-2 | `24085561` | `monitor.render()` mode-mismatch tolerant — `{active:false}`+retry, no `process.exit(2)` |
| R-MWCL-3 | `21615c26` | `restartDeadWatcherPanes` collapsed-layout fallback (`split-window`/`select-layout tiled`, `collapsed-layout-repair` tag) |
| R-MWCL-4 | `103264bc` | monitor pane stderr captured to session-local log |
| R-MWCL-5 | `0c483011` | watchdog fires first tick synchronously (`monitor.ts:997` `tick()` before returning the interval handle) |
| R-MWCL-6 | `5ac3dedc` + `189d4d2f` | integration regression `tests/integration/monitor-collapsed-layout-respawn.test.js` + `monitor-mode-resilience` suite |
| R-MWCL-7 | `7a22bfe1` | trap-door entries in `extension/src/services/CLAUDE.md` (R-MWCL-1, R-MWCL-3, R-MWCL bundle) |

Adjacent already-shipped support: R-MDS-1/3/4 (phase-boundary respawn + render-tick
re-check), R-MWR (continuous watchdog), R-MMRT (#27, `sessionDir` validation, v1.80.1).

---

## Test coverage proving the pipeline-phase case is green

- `extension/tests/integration/monitor-mode-transition.test.js` — asserts
  `inferModeFromStep('anatomy-park') === 'microverse'` and
  `inferModeFromStep('szechuan-sauce') === 'microverse'`, and that
  `pipeline-runner.ts` references `respawnMonitorWindowForMode`.
- `extension/tests/integration/monitor-collapsed-layout-respawn.test.js` — R-MWCL-6
  scenario (kill panes, assert layout repair within first-tick + 1 s).
- `extension/tests/monitor-mode-resilience.test.js`,
  `extension/tests/monitor-mode-swap.test.js`,
  `extension/tests/monitor-render-mode-mismatch.test.js`,
  `extension/tests/monitor-stderr-capture.test.js`,
  `extension/tests/monitor-watchdog-first-tick.test.js` — per-ticket guards for
  R-MWCL-1..5.

The layout-selector `MonitorMode` union and the render-mode union are deliberately
distinct (trap door in `services/CLAUDE.md`): the layout selector carries
`'szechuan-sauce'|'anatomy-park'`; the render path collapses both to `'microverse'`.
No regression there.

---

## Recommended #29 disposition (MASTER_PLAN repoint)

Strike B-MONITOR from the drain (row 9) and mark watch-only finding #29 CLOSED. Suggested
text for the watch-only row:

> **CLOSED — SHIPPED v1.80.2.** All R-MWCL-1..7 landed together (commits `4fab22d1`…`7a22bfe1`,
> regression `189d4d2f`). The `inferMonitorMode`→`'pickle'` fall-through during pipeline
> anatomy/szechuan phases is inert by design: `command_template` is the manager-prompt
> replay template and stays pinned to `_pickle-manager-prompt.md` (`pipeline-runner.ts:1078`),
> while the live dashboard tracks the phase via R-MDS-1/4 `respawnMonitorWindowForMode`
> (phase→`microverse`) and the R-MDS-3 / R-MWCL-2 render-tick `checkAndSwapMode`→
> `inferModeFromStep(state.step)`→`microverse`. The "3..7 residual" note was stale.

No code, no tests, no doc gaps remain. There is no tiny-residual carve-out worth a bundle —
the only action is the MASTER_PLAN repoint above (a docs-only edit on the plan, not a
shipped change).
