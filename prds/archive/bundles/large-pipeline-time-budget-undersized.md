# PRD: Large Pipeline Time Budget Undersized + Enforcement Drift

**Status**: SHIPPED via v1.62.1 (2026-04-30) — AC-LPB-01,02,05,08 shipped via `2319cee` (pickle-utils topo-sort + setup launch sizing + epoch reset + throughput config + Step 0.5); AC-LPB-03,04 shipped via `202ac7b` (mux-runner time_limit cap-gate + schema-mismatch escalation); AC-LPB-06 shipped via `643caa5` (monitor EXCEEDED indicator). AC-LPB-07 is SUPERSEDED by slot `1t` / ticket `bb08867f`, which removes the implicit wall-clock default entirely instead of sizing it from the manifest.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Origin**: live during the Citadel + Hardening Bundle pipeline run (`pipeline-1204204c`, session `2026-04-29-1204204c`). At iteration 36 / 49 of 75 tickets done, the pipeline has been running for **881 minutes (14h41m)** — already 161 minutes past the configured `max_time_minutes: 720` wall — and is still going. Two distinct bugs surfaced.

---

## Problem

### Bug 1: Default `max_time_minutes: 720` is undersized for any pipeline above ~25 tickets

Observed throughput on this run: **3.34 tickets/hour** (49 done in 881 min) on `--backend codex`. The current Citadel + Hardening Bundle has **75 implementation tickets**, putting wall-clock estimate at **~22.5 hours just for the `pickle` phase**. Then phases 2 (`anatomy-park`) and 3 (`szechuan-sauce`) still need to run.

`pickle_settings.json` defaults:
```json
"default_max_time_minutes": 720,
"iteration_budget_per_backend": { "claude": 100, "codex": 80 }
```

The 720 budget was sized for ~10–20 ticket epics. The bundle PRD's refinement explicitly produced **75 tickets** (see `prds/citadel-hardening-bundle.md`), but neither `pickle-pipeline.md` nor `mux-runner.ts` adjusts the time budget based on the ticket count read from `decomposition_manifest.json`. The user has to remember to pass `--max-time 4320` (or larger) at launch.

In this run, the launch was `--max-time 720` (default). The pipeline-runner kept advancing tickets past the wall because of Bug 2 (below), which masked the undersized budget. If Bug 2 were correctly enforced, the pipeline would have died at 720m with 26 tickets unshipped.

### Bug 2: `max_time_minutes` enforcement is leaky — 161+ minutes past the wall, still running

`mux-runner.ts:1123–1125` and `mux-runner.ts:1630–1633` both check `elapsed >= maxTimeMins * 60` and trip exit conditions. Yet at the time of writing, `state.start_time_epoch = 1777488056` (2026-04-29T18:40:56Z, the ORIGINAL launch timestamp) and current time is 2026-04-30T08:41Z — 881 minutes elapsed against a 720-minute cap. Pipeline still actively shipping tickets. Mux-runner is not enforcing the cap.

Hypotheses (need investigation, not yet confirmed):

1. **Resume drift**: when state.json was reconstructed after the 23:33Z crash (see `prds/archive/incidents/state-schema-version-ordering-incident.md`), `start_time_epoch` was preserved as the ORIGINAL launch (18:40Z) rather than reset to the relaunch time (23:53Z). A fresh mux-runner picks up the old timestamp. The cap check fires once, but the loop keeps going because of fall-through in the check structure.
2. **Schema-mismatch silencing**: every ~hour the deployed `STATE_MANAGER_DEFAULTS.schemaVersion` reverts to v2 (separate incident, separate PRD). When the cap-check `StateManager.read()` throws `SCHEMA_MISMATCH`, the code path swallows the error and continues without enforcing the cap. The watchdog auto-bumps schema back to v3 each hour, but in the window where reads throw, max-time is unchecked.
3. **Per-iteration vs per-loop check**: 1123–1125 is one branch (`recordIterationOutcome`), 1630–1633 is another (`runIteration`). One may be the only path that fires the exit, and the other is merely a counter update. If the exit-firing branch is never reached during normal codex-manager-relaunch flow, the cap is never enforced.

The safe-default behavior for a long-running pipeline is to RESPECT the cap and exit cleanly — it's an operator tool to bound resource usage. Today, the cap is informational, not enforced.

---

## Symptoms

1. **Run launched with default 720m budget** → bundle has 75 tickets → arithmetic says 22+ hours needed → user has to either know to override at launch OR rely on Bug 2 leaking enforcement.
2. **Pipeline continues past `max_time_minutes`** → no telemetry message logged when crossing the wall → no operator feedback that the budget was exceeded.
3. **State.json `start_time_epoch` doesn't reset on resume** → resumed runs inherit the original wall, not a fresh window. Long crashes + reconstructions accumulate elapsed time.
4. **Watchdog log shows `elapsed 763m / 720m`, `823m / 720m`, `881m / 720m` over consecutive hourly ticks**, all with `active=true` and tickets still advancing. The monitor pane displays the wall numerator beyond denominator without any visual "exceeded" indicator.

---

## Root Cause (the parts that are crisp)

### B1 root cause — sizing math is missing from launch path

`pickle-pipeline.md` and `setup.js` accept `--max-time <minutes>` but neither reads the decomposition manifest's ticket count and warns when the budget is obviously insufficient. There's no formula like `recommended_max_time_minutes = ceil(ticket_count / observed_throughput_per_hour) * 60 * safety_factor`. The user is expected to estimate manually.

For this codebase's observed throughput (3.34 t/h on codex, ~5 t/h on claude per `convergence-toolchain-gates.md` v1.58.0 retrospective), the formula could be:
- codex: `max_time_minutes = ceil(ticket_count / 3.0) * 60` (≈20 min/ticket)
- claude: `max_time_minutes = ceil(ticket_count / 5.0) * 60` (≈12 min/ticket)
- safety factor: 1.5×

For 75 tickets on codex: `ceil(75 / 3.0) * 60 * 1.5 = 2250 min = ~37.5 hours` to be safe.

This says the bundle launch should have used `--max-time 2250` minimum, not the default 720.

### B2 root cause — enforcement is best-effort, not blocking

The cap is checked but the exit path is not the only loop terminator. When the cap fires, mux-runner sets an internal flag, but if the iteration is mid-codex-manager-subprocess (which can run for the full 4-hour MAX_ITERATION_SECONDS internally before yielding back), the cap-check doesn't run again until that subprocess returns. Then the codex-manager-relaunch path may re-spawn a fresh manager, resetting the local "we're past cap" state.

In practice: every codex-manager-relaunch is a "second wind" past the cap. There's no global gate that says "you've crossed `max_time_minutes`, refuse to spawn another manager."

---

## Fix (proposed)

### F1 — Manifest-aware default at launch

`setup.ts` reads `decomposition_manifest.json` (when present in the session dir) and warns if `--max-time` is unset or below the formula's recommendation:

```
WARN: 75 tickets in decomposition_manifest.json + codex throughput baseline = recommended --max-time 2250.
      You passed --max-time 720. Run will likely exit before completion.
      Override with --max-time 2250 to silence this warning, or --max-time 720 --acknowledge-undersized to proceed.
```

`pickle-pipeline.md` does the same one level up — checks the bundle's child decomposition once decomposition completes.

The throughput baselines should live in `pickle_settings.json`:

```json
"throughput_baselines": {
  "codex": { "tickets_per_hour": 3.0, "safety_factor": 1.5 },
  "claude": { "tickets_per_hour": 5.0, "safety_factor": 1.5 }
}
```

Operators can override per project. Calibration against historical sessions could update these automatically (small ML-free regression — see calibration-corpus governance from BMAD-T27).

### F2 — Hard cap-gate in codex-manager-relaunch path

Before each `evaluateCodexManagerRelaunch` call, check `elapsed >= maxTimeMins * 60`. If true, refuse to relaunch — exit with `'time_limit'`. Add a regression test in `mux-runner.test.js`:

```js
test('codex-manager-relaunch refuses past max_time_minutes', () => {
  // ... fixture with elapsed > maxTime ...
  assert.equal(evaluateCodexManagerRelaunch(state, settings), { allowed: false, reason: 'time_limit' });
});
```

Audit all `state.json.read()` call paths in mux-runner that check `elapsed`: ensure schema-mismatch exception bubbles to a fatal exit rather than being swallowed by a try-catch that lets the loop continue.

### F3 — `start_time_epoch` reset on `--resume` after reconstruction

When `setup.js --resume <session>` is called and the session is being reconstructed (state.json has fewer than ~5 fields, indicating reconstruction), reset `start_time_epoch` to current time. Document this behavior in the trap-door catalog. Genuine resume of a still-active session keeps the original epoch. Reconstruction post-crash starts a fresh wall.

Concrete trigger: state.json missing any of `iteration`, `current_ticket`, `step` after recovery → treat as reconstruction → reset epoch + log `session_reconstructed_epoch_reset` activity event.

### F4 — Live cap warnings in monitor + watchdog

Monitor pane (`monitor.js`) renders `Elapsed: 881m 47s / 720m` today. Add a "⚠️ EXCEEDED" suffix when `elapsed > maxTimeMins * 60`. Watchdog rules: extend the whitelist (4) to log a WARN when `elapsed > 1.1 * maxTimeMins * 60` (10% past wall) — surfaces enforcement leak quickly.

### F5 — `pickle-pipeline.md` skill prompt addition

Add a Step 0.5 between PRD refinement and tmux launch:

> Before launching the pipeline, read `${SESSION_ROOT}/decomposition_manifest.json`. If `tickets.length > 25`, recompute `--max-time` per the throughput baseline formula and either pass it explicitly or halt with a single confirmation prompt.

---

## Acceptance Criteria

- **AC-LPB-01** Launch path emits a WARN (or halts with confirmation) when `--max-time` is below the throughput-baseline formula's recommendation for the ticket count read from `decomposition_manifest.json`.
- **AC-LPB-02** `pickle_settings.json` has a `throughput_baselines` block with per-backend tickets-per-hour + safety factor. Operators can override.
- **AC-LPB-03** When `elapsed >= maxTimeMins * 60`, codex-manager-relaunch refuses with `reason: 'time_limit'`. Regression test in `mux-runner.test.js`.
- **AC-LPB-04** Schema-mismatch exceptions during cap-check do not silently swallow — error escalates to fatal exit OR is logged loudly with `cap_check_failed_schema_mismatch` activity event.
- **AC-LPB-05** `setup.js --resume` on a reconstructed session resets `start_time_epoch`. New activity event `session_reconstructed_epoch_reset`. Test in `setup.test.js`.
- **AC-LPB-06** Monitor pane renders `⚠️ EXCEEDED` when wall is past, both in initial render and on `state.json` polling refresh. Test in `monitor.test.js`.
- **AC-LPB-07** Watchdog skill (this file's user) gains a 4(e) entry for elapsed > 1.1× wall — log WARN only, no auto-action.
- **AC-LPB-08** `pickle-pipeline.md` skill Step 0.5 is documented and exercised by a fixture session.

## Verification Plan

1. **AC-LPB-01..02** — write `extension/tests/setup-throughput-baseline.test.js` that constructs a fixture session with `decomposition_manifest.json` containing 75 tickets, runs setup.js with `--max-time 720`, asserts stderr contains `recommended --max-time` and exit code (warn OR 2 with confirmation prompt).
2. **AC-LPB-03** — `mux-runner.test.js` adds: fixture state with `elapsed = (maxTimeMins + 1) * 60`, call `evaluateCodexManagerRelaunch`, expect `{ allowed: false, reason: 'time_limit' }`.
3. **AC-LPB-04** — fixture: deployed schemaVersion=2, state.json schema_version=3, run mux-runner cap-check, assert: not silent.
4. **AC-LPB-05** — `setup.test.js`: write reconstructed-shape state.json (only 5 fields), call `setup.js --resume`, assert `start_time_epoch == Date.now() / 1000` (within 5 sec).
5. **AC-LPB-06** — `monitor.test.js`: render with `elapsed > maxTime * 60`, assert output contains `EXCEEDED`.
6. **AC-LPB-07** — manual check: watchdog tick prompt extended.
7. **AC-LPB-08** — manual check: `pickle-pipeline.md` Step 0.5 documented.

## Non-goals

- Adaptive ticket scheduling (running fast tickets first to maximize completion under cap). Out of scope; F1–F5 just teach the system to size correctly upfront and enforce the wall.
- Per-ticket time budgets. Existing `worker_timeout_seconds` plays that role; this PRD is about pipeline-level wall.
- Auto-extending `max_time_minutes` mid-run. Operator's call. F4 makes the breach visible.

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-LPB-1 | Throughput baselines drift between codebases (heavier tickets = lower throughput) | F1 makes the baseline configurable. Long-term: calibrate per-project from historical sessions (BMAD-T27 calibration-corpus governance). |
| R-LPB-2 | F2's hard gate breaks legitimate resume runs that genuinely need more wall after a crash | F3's reconstruction-aware epoch reset catches that case. Genuine resume of a healthy session keeps the original epoch and the cap fires correctly. |
| R-LPB-3 | F4's "EXCEEDED" indicator visible during normal phase transitions if start_time_epoch isn't updated per phase | Confirm: `pipeline-runner` does NOT advance `start_time_epoch` between phases — it's pipeline-wide. So phase transitions don't create false exceedances. Document. |
| R-LPB-4 | F1's WARN at launch is just text and operators ignore it | F5's Step 0.5 escalates to a confirmation prompt when budget is more than 50% under the recommendation. Hard halt at 75% under. |

## Files Likely Touched

```
extension/src/bin/setup.ts                         # F1, F3
extension/src/bin/mux-runner.ts                    # F2, F4
extension/src/bin/monitor.ts                       # F4
.claude/commands/pickle-pipeline.md                # F5
pickle_settings.json                                # F1 (throughput_baselines block)
extension/tests/setup-throughput-baseline.test.js   # F1, F2
extension/tests/setup.test.js                       # F3
extension/tests/mux-runner.test.js                  # F2, F4
extension/tests/monitor.test.js                     # F4
prds/MASTER_PLAN.md                                 # mention this PRD in §1
```

---

## Linked Context

- Active pipeline: `~/.local/share/pickle-rick/sessions/2026-04-29-1204204c/`. tmux session `pipeline-1204204c`.
- Reconstruction event: `prds/archive/incidents/state-schema-version-ordering-incident.md` §"Recovery Options" → "Option D" — that recovery preserved `start_time_epoch` (Bug B2 cause).
- Watchdog log: `${SESSION}/watchdog.log` — see entries from 2026-04-30T03:24Z onward showing elapsed > 720m with no exit.
- Throughput data: 3.34 t/h on codex (this run, 49 tickets in 881 min). Compare to ~5 t/h on claude per `convergence-toolchain-gates.md` v1.58.0.
- Bundle PRD: `prds/citadel-hardening-bundle.md` — 75 tickets, refined and decomposed.
- Calibration corpus precedent: BMAD appendix T27 in `prds/citadel.md` §Appendix Implementation Task Breakdown — same governance pattern applies here.

---

## Operator workaround for the active run

The current pipeline is running past its wall thanks to Bug 2 (silently leaky cap). It's shipping ~3.3 tickets/hour and has shipped 49/75 in 881 min. Projected total: ~22.5 hours for phase 1. Two phases remain after.

Practical options for the user:

1. **Let it run** — Bug 2 keeps it going; the watchdog auto-fixes the schema reversions hourly. ~7.5 more hours to finish the pickle phase. Cleanest, slowest.
2. **Increase `max_time_minutes` proactively** — write `state.max_time_minutes = 4320` (72h) into state.json before mux-runner notices. Same outcome as #1 but legitimate.
3. **Stop after pickle, defer phases 2/3** — kill the tmux session after the last ticket ships, queue anatomy-park + szechuan-sauce as a separate `/pickle-pipeline` run with proper budget.

This PRD's fixes prevent the same surprise on next launch. They do not unblock the current run beyond what's already happening.
