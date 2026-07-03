# BUG REPORT — szechuan-sauce per-iteration gate converged over tsc-RED / eslint-error commits; red surfaced only at the closer's full gate

**Filed:** 2026-07-03 (closer for B-SCOPESEED, session `2026-07-02-b3c45331`)
**Code:** R-SZGB (Szechuan Gate Blind spot)
**Priority:** P2 (quality-gate integrity; no data loss — the closer's full gate is the backstop and caught it)
**Component:** szechuan-sauce / microverse per-iteration convergence gate (`microverse-runner.ts` + `convergence-gate.ts`), possibly anatomy-park too

## Symptom (observed, deterministic)

The B-SCOPESEED pipeline (codex, 4/4 phases "clean", zero intervention) converged szechuan-sauce
normally — no `tsc_gate_failed`, no deferral-cap halt — yet HEAD after the run was:

- **tsc-RED: 5 type errors** in `src/bin/mux-runner.ts`, all introduced by the szechuan
  "Small Functions" commits (`d30bab01`, `14b8feab`, `b5285276`): settings bag typed as
  `HardeningSettings` (TS2739 + 2× TS2339), `lastDataAt = this.start` before param init (TS2729),
  `breakWithExitReason(reason: string)` vs `ExitReason` (TS2322).
- **eslint-ERROR** (`no-useless-assignment`) in `src/bin/pipeline-runner.ts` (WS-1 code the review
  passes had touched).
- **3 fast-tier source-pin tests broken** (`mux-runner-timer.test.js` ×2,
  `recovery-exhausted-terminal.test.js`) — invariants held, anchors moved, but the tier was never run.
- **Compiled-JS drift**: `bin/pipeline-runner.js` stale vs source at HEAD.

All of it surfaced only at the closer's full release gate (fixed forward: `65d6c04d`, `ed48092d`,
`527a2c7`).

## Why this is surprising (the gate that should have caught it)

- The per-iteration convergence gate (`runGate`) baselines and replays `typecheck` + `lint` + `tests`
  (pinned trap doors: "tests in gate", "worker convergence" — red final-iteration gates defer
  convergence).
- R-RPGT (beta.24) added the RED-tree exit gate at the deferral cap and the abort-branch typecheck.
- Yet a converged szechuan session shipped tsc-RED commits with no `tsc_gate_failed` anywhere in the
  session activity.

## Hypotheses (unverified — verify mechanism against the session before authoring a fix)

1. **Baseline capture raced the first red commit** — `gate/baseline.json` captured AFTER a red
   szechuan commit landed, so baseline-subtraction masked the failures as pre-existing
   (trap door "baseline capture" requires the clean pre-iteration tree; a worker-managed flow that
   commits before the baseline write would invert it).
2. **Project-type detection skipped the gate** in the codex worker-managed path
   (`gate_skipped: no_project_type_detected` class — target is repo root, package lives in
   `extension/`; R-APBN-1 wrote empty baselines for exactly this shape).
3. **Worker-managed convergence signal** (`handleWorkerManagedIteration`) on codex bypassed the
   final-iteration gate replay.

Session evidence to check: `~/.local/share/pickle-rick/sessions/2026-07-02-b3c45331/`
(`gate/baseline.json`, `microverse.json`, activity events `gate_skipped` /
`gate_baseline_init_failed`, per-iteration gate logs).

## Impact

Review phases can silently degrade a green tree; any consumer that trusts a converged
szechuan/anatomy exit as toolchain-green is wrong. The closer's full gate is currently the only
backstop — which re-opens the known autonomy gap (a) "per-phase gates don't run the FULL release
gate" with a sharper edge: the per-phase gate didn't even hold its OWN typecheck contract here.

## Fix direction (subtract-before-add)

Verify the mechanism first (hypotheses above). If (1): enforce baseline-before-first-commit ordering
in the worker-managed path. If (2): gate must run from the detected package root (`extension/`), not
the repo root — reuse `detectProjectType` cwd resolution, no new gate. If (3): route the
worker-managed convergence signal through the same final-iteration `runGate` replay every other exit
uses (collapse to the one seam, don't add a second gate).

## Acceptance criteria (for the eventual fix)

- [ ] A szechuan iteration that commits a tsc-RED change cannot converge: the session records
      `tsc_gate_failed` (or defers) — proven by a repro test on the worker-managed path.
- [ ] Mechanism finding documented: which hypothesis held, with the session-artifact evidence.
- [ ] No new gate/flag/state field — the fix routes through the existing `runGate` seam.
