# BUG REPORT — Premature phase-advance on partial build + green-ticket gate-starvation (2026-06-14)

**Status:** OPEN. Filed from the B-CGH babysitting session (`2026-06-14-a0321981`).
**Severity:** P1. The pipeline declared a bundle "✅ 4/4 phases complete" when only **2 of 11 tickets** were actually built — and would have shipped a codegraph-hardening bundle that **never turned codegraph on** if the babysitter had trusted the phase count instead of reading deliverables.
**Bundle:** B-PPA — two causally-linked root causes (R-PPA-1 premature advance, R-PPA-2 gate-starvation).
**Relates to (extends, does NOT duplicate):** Open Finding #113 **R-XSPA-2** (signal-triggered premature advance). R-PPA-1 is the SAME guard gap reached via a *clean exit-0*, not an external SIGTERM — so it generalizes the R-XSPA-2 fix. Sibling of B-RGO #115 (validation/over-sensitivity class).

## Incident

B-CGH (11 tickets) launched, built CGH-1 + CGH-2 cleanly, then on the `large`-tier CGH-3a (`61d02c4e`) the mux-runner **exited code 0 with 9 tickets still pending** (CGH-3a In Progress; CGH-3b…CGH-6 + 4 hardening all Todo). `pipeline-runner` read the 0 exit as success and ran citadel → anatomy-park → szechuan-sauce on the 2/11 build, then logged `Pipeline finished: 4/4 phases, 162m 28s`. `pipeline-status.json` = `{status: completed, completed_phases: 4}`.

The babysitter caught it only by **verifying deliverables** (CGH-6 default flip never happened — `resolveCodegraphSettings` still `enabled:false`; CGH-3b corpus dir had 0 fixtures), not by trusting the phase count. Recovery: reset state → re-run pickle; CGH-3a then re-stuck at the same gate for ~45 min despite its code being complete (`tsc` 0 errors, probe test 7/0, event-payload test 181/0). Babysitter froze, hand-marked CGH-3a Done (`a9603394`), advanced.

## Root cause R-PPA-1 — pickle completion is keyed on the mux exit code, not on all-tickets-terminal

`Phase pickle exited with code 0` with pending tickets advanced the pipeline. The incomplete-bundle guards (C1/C2, R-ICP-2 `PhaseIncomplete`=3, R-PHC-6) all key on a **NON-zero** pickle exit — so a *clean* mux exit-0 while Todo/In-Progress tickets remain sails straight through, exactly as Open Finding #113 R-XSPA-2 documents for the signal-shutdown path. The mux exited 0 because its manager subprocess (`claude -p`, `--max-turns 400`) ended cleanly (end_turn / turn-exhaustion) on the long large ticket and the mux classified that as completion rather than relaunching (R-MMTR-3 should relaunch on max-turns-with-pending; here it exited 0).

**Fix directions (R-PPA-1):**
- **AC-PPA-1-1:** `pipeline-runner` MUST gate pickle-phase success on **all tickets terminal** (every ticket `Done` or `Skipped`; zero `Todo`/`In Progress`), independent of the mux exit code. If the mux exits 0 but pending tickets remain, treat as `PhaseIncomplete` (exit 3 / `pipeline_phase_incomplete`), NOT success — generalizing the R-XSPA-2 fix from the signal path to the clean-exit path.
- **AC-PPA-1-2:** `mux-runner` MUST NOT exit 0 when pending tickets remain. A clean manager exit (end_turn / max-turns) with `Todo`/`In Progress` tickets routes through the existing relaunch ladder (R-MMTR-3 / `evaluateManagerRelaunch`); only genuine all-terminal completion exits 0.
- **AC-PPA-1-3:** regression test — a mux that returns exit 0 with ≥1 pending ticket causes `pipeline-runner` to stamp `pipeline_phase_incomplete` and NOT advance to citadel.

## Root cause R-PPA-2 — a worker cannot self-complete a GREEN ticket when its gate flakes/times out

CGH-3a's code was complete and committed (`tsc` 0 errors, probe test 7/0, event-payload 181/0), yet the ticket stayed `In Progress` across ~45 min because the per-ticket loop ran the **flake-budget gate** ("Run fast-tier flake budget gate" — `check-flake-budget`: `node --test --test-concurrency=8 --runs=5`) and that gate is **known-flaky at c=8** (release-gate `test:fast` flakes at c=8; documented fix is c=4). A non-deterministic, 5×-fast-suite gate inside the per-ticket loop means a large ticket can't reliably pass it → no clean completion → the manager spins → turn exhaustion → R-PPA-1 premature advance. The flake-budget is a *release/CI* concern (run once per bundle), not a per-ticket worker-gate concern.

**Fix directions (R-PPA-2):**
- **AC-PPA-2-1:** the per-ticket worker/manager completion gate MUST NOT invoke the c=8 `check-flake-budget` run. Per-ticket runs the standard worker gate only (`tsc` + `eslint` + a single `test:fast` at the serialized concurrency, c=4 per the R-TFP precedent). The flake budget stays a once-per-bundle release/CI gate.
- **AC-PPA-2-2:** when a worker's deterministic gate (`tsc` + `test:fast`) is green, the worker completes the ticket (commits + marks Done) even if a separate non-deterministic budget probe is noisy — completion keys on the deterministic gate, never on the flake probe.
- **AC-PPA-2-3:** regression test — a ticket whose `tsc` + `test:fast` pass completes (status→Done, completion_commit stamped) without depending on a c=8 flake-budget pass.

## Why this matters (north-star alignment)

This is the D2 class (wrong-signal completion → work discard) from `prds/p1-design-simplification-and-autonomy-2026-06-13.md`, twinned with D1 (validation overreach). R-PPA-1 lets a *false* completion signal (exit code) advance a partial build; R-PPA-2 lets a *flaky* gate withhold completion from genuinely-done work. The fix is to ground both decisions in **ground truth** — all-tickets-terminal for phase completion, and the deterministic gate for ticket completion — not in proxies (exit code, flake probe). Without it, every multi-ticket bundle with ≥1 large ticket risks silently shipping partial, and the babysitter must verify deliverables by hand on every "complete" (as it did here).

## Acceptance / verification anchors

- `extension/src/bin/pipeline-runner.ts` — `shouldHaltAfterPhase`, `runPhaseIteration`, the pickle→citadel boundary; R-ICP-2 (`PipelineRunnerExitCode.PhaseIncomplete`), R-PHC-6 (continue-by-default), R-XSPA-2 (#113) signal-path fix.
- `extension/src/bin/mux-runner.ts` — the exit-0 path, `evaluateManagerRelaunch` / R-MMTR-3, `evaluateEpicCompletion`, pending-ticket detection (`findPendingNonCurrentTickets` / `isPendingMuxTicket`).
- `extension/src/bin/check-flake-budget.ts` (`--test-concurrency=8 --runs=5`), and the worker gate in `spawn-morty.ts` (`runWorkerGate`) — confirm the flake budget is NOT in the per-ticket path.
- Incident evidence: session `2026-06-14-a0321981`, `pipeline-runner.log` (`Phase pickle exited with code 0` at 19:48Z), CGH-3a `61d02c4e` In Progress with green code.
