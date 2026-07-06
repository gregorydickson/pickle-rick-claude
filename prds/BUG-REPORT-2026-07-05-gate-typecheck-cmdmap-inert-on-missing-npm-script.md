# Bug Report — 2026-07-05 — convergence-gate `typecheck` check is INERT when the repo has no `typecheck` npm script (tsc-RED still escapes on pickle-rick itself)

**Code:** R-SZGB-D (Szechuan Gate Blind spot — per-check unrunnable-command residual)
**Priority:** P2 (quality-gate integrity — same fail-OPEN *class* as R-SZGB-B, one level down: per-CHECK, not per-PROJECT)
**Surfaced by:** the R-SZGB live-proof — `/szechuan-sauce` over the R-SIGF `signature-caller-gap` module,
session `2026-07-05-9fb9a10b` (beta.39 deployed runtime), 2026-07-05.

## Summary

R-SZGB-A correctly resolves the package root (`extension/`) when the gate targets the repo root — the
finalize-gate result for session `2026-07-05-9fb9a10b` proves it (`file: .../extension`). **But the
`typecheck` check then runs `npm run typecheck`, and `extension/package.json` has NO `typecheck` script**
(this repo typechecks via `npx tsc --noEmit`, wired directly in the release gate, not as an npm script).

`gate-commands.json` hardcodes the npm cmdMap:
```json
"npm": { "typecheck": "npm run typecheck", "lint": "npm run lint", "test": "npm test" }
```
So `npm run typecheck` errors with `Missing script: "typecheck"` — it **never runs tsc**. The gate cannot
distinguish "typecheck passed" from "typecheck could not run":

- **Baseline mode:** the "Missing script" error is captured as a baseline failure.
- **Per-iteration replay:** a tsc-RED commit ALSO yields only `npm run typecheck → Missing script` (tsc
  never runs), an identical failure signature → `new_failures_vs_baseline = 0` → **the gate reports
  clean and converges over the tsc-RED tree.**

Net: on the pickle-rick repo itself, R-SZGB-A/B/C fixed the *empty-baseline* (per-project) fail-OPEN, but
the `typecheck` check remains **structurally inert** — the exact regression class the original R-SZGB
incident shipped (5 tsc errors, B-SCOPESEED) would STILL escape the per-iteration gate. `lint` and `test`
checks DO run for real (`lint`/`test` scripts exist), so eslint-RED and test-RED are now caught; only
tsc-RED escapes.

## Evidence

- `session 2026-07-05-9fb9a10b/gate/gate_result_cycle_*.json`: `status: red`, sole failure
  `{check: typecheck, file: .../extension, message: "npm error Missing script: \"typecheck\""}`,
  `baseline_used: false`. The resolution to `extension/` worked (R-SZGB-A ✓); the check itself is inert.
- `extension/package.json` scripts: `lint, test, test:fast, ...` — **no `typecheck`**.
- `npx tsc --noEmit` on the same tree: `No errors found` — the tree IS clean; the gate's RED was a
  "couldn't-run" artifact, not a real type error.
- `extension/src/data/gate-commands.json` (deployed `extension/data/gate-commands.json`):
  `npm.typecheck = "npm run typecheck"`.

## Root cause

An unrunnable check command (`npm run <script>` for a script that does not exist) is treated as a
**subtractable baseline failure** rather than a **fail-CLOSED uncertifiable signal**. This is the same
fail-OPEN principle R-SZGB-B closed at the per-PROJECT level ("no project type must not certify"), one
level down: **"a check whose command cannot run must not be certifiable / subtractable."**

## Fix options (decide in PRD — reuse-first)

1. **Per-check fail-closed (preferred, generalizes R-SZGB-B):** when a check command exits with a
   "missing script / command not found" class error (not a real check failure), mark the check — and
   thus the baseline — **uncertifiable** for that check, so it cannot be subtracted to green. Reuses the
   R-SZGB-B uncertifiable-baseline machinery at per-check granularity. No new gate/flag.
2. **cmdMap fallback:** when `npm run typecheck` is missing, fall back to `npx tsc --noEmit` (and
   analogous lint fallback). Generalizes to any npm repo that typechecks via tsc directly. Touches
   `convergence-gate.ts` check-execution + `gate-commands.json`.
3. **Repo-local (narrowest):** add `"typecheck": "tsc --noEmit"` to `extension/package.json`. One line,
   immediately makes the gate bite on THIS repo, but does not fix other tsc-via-npx repos. Additive/safe
   (the release gate uses `npx tsc --noEmit` directly, unaffected).

Recommendation: **(1) + (3)** — the fail-closed invariant is the durable fix (any repo, any missing
check), and adding the repo's own `typecheck` script is a cheap, conventional alignment that makes the
gate fully bite on pickle-rick immediately.

## Simplification Review (subtract-before-add) — sketch (full version in the fix PRD)

- Option 1 adds NO new gate/flag/state — it reuses the R-SZGB-B uncertifiable-baseline signal at
  per-check granularity (subtract-before-add: the honest fix to the fail-OPEN, not a second hatch).
- Option 3 is pure config (a package.json script), no machinery.

## Not a regression of R-SZGB

R-SZGB-A/B/C are correct and shipped. This is a *distinct, adjacent* blind spot the live-proof was
designed to surface (per MASTER_PLAN track C.5). The per-project empty-baseline path is closed; this is
the per-check unrunnable-command path.

## Live-proof byproduct (separate from the finding)

The same session produced 7 legitimate deslop commits on `signature-caller-gap.ts` (`96dd310c`..`f0db59da`
— escapeRegExp extraction, GapCallerScanInput unification, guard-clause/CQS refactors), tree tsc+eslint
green, module tests 23/23. Valid R-SIGF hardening; currently local-only (unpushed), pending a decision to
fold into the R-SZGB-D release or a full gate.
