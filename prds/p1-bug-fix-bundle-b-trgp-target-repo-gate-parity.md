---
title: "B-TRGP (re-scoped ②-tight) — Subtract the off-repo fake-green gate special-case"
priority: P1
r_codes: [B-TRGP]
status: build-ready
build_protocol: PIPELINE
line: release/v2.1-beta
composes: []
---

# B-TRGP — Delete the off-repo fake-green gating (option ②-tight: subtract, don't add)

**Thesis: the per-ticket worker gate is NOT APPLICABLE off a pickle-rick checkout — its commands are
hardcoded to `extension/` (eslint `extension/src`, `tsc`, `npm run test:fast`). Today it fabricates a
`green` verdict there and every Done-flip trusts the lie. SUBTRACT the fabrication: name applicability once,
and where the gate is not applicable, the worker-gate verdict simply DOES NOT GATE the Done-flip — no fake
green, no new state. Off-repo Done rests on commit-evidence; the portable review/closer gate
(`runGate`/`detectProjectType`), which already verifies target repos, is the verification authority.**

This is the subtractive answer, chosen over ③ (add an `unverified` state) and ④ (run the portable gate
per-ticket). It removes the lie by removing the mechanism that tells it, and it **collapses five divergent
off-repo constants onto ONE applicability predicate** — it moves both operator needles (less brittleness,
genuinely simpler), unlike ③ (honest but net-additive) or ④ (a large parallel-verification build).

## Why ②-tight, not ③ / ④ (decision trail, 2026-07-16)

- **④ (run `runGate` per-ticket) — REJECTED.** A 3×3 refinement mapped it as a large
  completion-authority-entangled build (scope/since decision, repo-vs-diff scoping, 600s-cap + timeout →
  red on healthy code, a verdict adapter that cannot be written against the current `GateResult`) that
  DUPLICATES the review/closer verification.
- **③ (return `unverified`) — REJECTED as net-additive.** It removes the lie but ADDS a third verdict state,
  persistence widening, a Done-flip branch, and an event. Honest, but not simplification.
- **②-tight — CHOSEN.** Delete the fake-green special-case; make the worker-gate conjunct CONDITIONAL on
  applicability. No new state, no event, no portable-gate machinery. Subtraction.

**Born-in, not a regression (git-verified):** the off-repo no-op is in the gate's FIRST commit (`4e2e8bf8`,
2026-05-06 — `if (!fs.existsSync(extensionDir)) return { ok: true }`), a correct self-hosting-era assumption
that became a defect at the build-other-repos pivot. B-CWGE (`c4291522`, 2026-06-28) deferred the off-repo
green with a "NOT fail-closed" comment. Foundational debt.

## The defect — five sites answering "is there an `extension/` dir?" with fabricated constants

| # | Site | `file:line` | Off-repo constant today |
|---|---|---|---|
| 1 | `runWorkerGate` | `spawn-morty.ts:1538-1553` | `{ok:true}` (fake pass) |
| 2 | `resolveWorkerGateVerdict` (Done-flip authority) | `mux-runner.ts:4643-4647` | `'green'` (fake pass) |
| 3 | `extensionGreenGate` | `mux-runner.ts:4669-4672` | `'failing'` (contradicts #2) |
| 4 | `commitGatePassingDeliverableOnExitPath` | `mux-runner.ts:5153-5154` | `'no-extension-dir'` (declines) |
| 5 | `runBetweenTicketFastGate` | `mux-runner.ts:670-671` | `null` (skipped) |

Five hardcoded off-repo answers, two of them (#2, #3) mutually contradictory. R-CWGE's invariant ("Done
requires a GREEN worker-gate verdict") is satisfied VACUOUSLY by #2 off-repo — the lie. Also note the
`absent`→recompute path: `recomputeAbsentWorkerGateVerdict` runs `tsc` over `extensionDir` and must not fire
where that dir is absent (analyst finding: `absent` is a live "recompute" sentinel).

## Workstreams

### WS-1 — one applicability predicate [the single seam]
Introduce `isWorkerGateApplicable(workingDir): boolean` = `fs.existsSync(path.join(workingDir, 'extension'))`
— naming the check that today lives inline at five sites. This is the ONE seam every site routes through
(the R-AFCC-CALLER-ENUMERATION pattern), pinned by an audit so a future divergence fails the gate.

### WS-2 — where the gate is not applicable, it DOES NOT GATE [SUBTRACT the fabrications]
- `resolveWorkerGateVerdict` (#2): when not applicable, it is NOT consulted — `guardCompletionCommitBeforeDone`
  drops the worker-gate conjunct entirely (Done proceeds on commit-evidence). Delete the `return {verdict:'green'}`.
- `runWorkerGate` (#1): when not applicable, return a value the caller reads as "not gated" — NOT a fake pass
  that downstream mistakes for verification.
- Reconcile #3/#4/#5 to the SAME "not applicable → does not gate" semantics through `isWorkerGateApplicable`,
  so the five constants collapse to one honest answer and the fail-open⇄fail-closed contradiction (#2 vs #3)
  disappears. (Verify each site's consumers first — #3 `extensionGreenGate` feeds the R-CECB attribution
  oracle; "not applicable" must be correct for that consumer too, not merely for the Done-flip.)

### WS-3 — the recompute path is applicability-gated too [reuse the seam]
`recomputeAbsentWorkerGateVerdict` must not run `tsc`/eslint over a non-existent `extension/`; gate it on
`isWorkerGateApplicable`. When not applicable, an `absent` verdict stays "not gated," never a recompute that
errors or a fall-through to fake green.

### WS-4 — redefine the R-CWGE invariant honestly [doc + lockstep tests]
"A Done-flip requires a GREEN worker-gate verdict WHEN the worker gate is applicable (a pickle-rick
checkout with `extension/`); off a pickle-rick checkout the per-ticket worker gate does not apply and does
not gate — the portable review/closer gate is the verification authority." Update the R-CWGE trap-door text
+ `completion-authority-single-source.test.js` + `codex-worker-gate-fail-closed.test.js` in lockstep.

## Simplification Review (subtract-before-add — REQUIRED, per WS)

- **WS-1.** (1) Necessary — one seam. (2) Reuse — it NAMES an existing inline check, adds no new logic. (3)
  Collapses five divergent inline checks. (4) Subtraction of duplication. ✓
- **WS-2.** (1) Necessary — remove the fabrications. (2) Reuse the guard/verdict seam. (3) **Directly
  subtracts** the fake-green fail-open AND the #2/#3 contradiction. (4) Five hardcoded off-repo constants →
  ONE "not applicable → does not gate." Net **−branches, −contradiction, −lie**. ✓ ideal.
- **WS-3.** (1) Necessary — the recompute path must respect applicability. (2) Reuse the WS-1 predicate. (3)
  Subtracts an off-repo error/fall-through path. (4) −1 latent failure mode.
- **WS-4.** Doc + honest invariant; no new mechanism.
- **No new verdict state, no persisted field, no event, no portable-gate call.** This is the version that
  reduces brittleness (kills the lie + the contradiction) AND simplifies (five constants → one predicate).

## Explicitly NOT in scope
- ④ (run the portable gate per-ticket) — rejected; duplicates review/closer verification.
- ③ (`unverified` state + event) — rejected as net-additive.
- **[[R-ORSR-2]]** (own PRD) — re-running a ticket's own `acceptance_test` at Done needs a NEW AC-execution
  helper (none exists); additive, distinct.

## Build protocol: `/pickle-pipeline` (PIPELINE-SAFE — no hand-build)
The change only affects the OFF-repo branch. The pipeline builds B-TRGP with `working_dir` =
pickle-rick-claude (HAS `extension/`), so every build worker's deployed runtime takes the UNCHANGED,
applicable, on-repo path — the deleted off-repo branch never fires on the build worker. Per operator
directive (2026-07-16): NOTHING hand-built — always `/pickle-pipeline`. **Lockstep trap-doors/tests:** the
R-CWGE entry in `extension/CLAUDE.md`, `completion-authority-single-source.test.js`,
`integration/codex-worker-gate-fail-closed.test.js`, `bash scripts/audit-trap-door-enforcement.sh`.

## Acceptance Criteria (machine-checkable)
- **AC-2-1** — `it("off a pickle-rick checkout (no extension/), the Done-flip does NOT consult a worker-gate verdict — no 'green' is fabricated at any of the five sites")`.
- **AC-2-2** — `it("all five sites derive their applicability from the single isWorkerGateApplicable seam; no bare off-repo constant (ok:true / 'green' / 'failing' / null / 'no-extension-dir') survives")` — call-site audit.
- **AC-2-3** — `it("a Done-flip off-repo PROCEEDS on commit-evidence alone — it is never blocked by, and never credited to, the per-ticket worker gate")`.
- **AC-2-4** — `it("recomputeAbsentWorkerGateVerdict does not run tsc/eslint when the worker gate is not applicable")`.
- **AC-2-5** — `it("on a pickle-rick checkout (extension/ present) the native gate behavior — green/red and its Done-flip gating — is byte-identical to pre-fix")`.
- **AC-2-6** — `it("the R-CWGE trap-door + tests encode the applicability-scoped invariant")`.

## Risks
- **#3 `extensionGreenGate` has a non-Done-flip consumer (R-CECB attribution)** — "not applicable" must be
  correct for THAT consumer, not only the Done-flip. WS-2 requires reading each site's consumers first.
- **Predicate correctness** — `isWorkerGateApplicable` must be TRUE on every real pickle-rick checkout, or
  the on-repo gate silently stops gating (a regression the wrong way). AC-2-5 pins on-repo byte-identity.
- **Off-repo Done is now un-gated by the per-ticket gate (by design)** — same functional behavior as today
  (Done proceeds) minus the false green; real target-repo verification lives at the review/closer portable
  gate. If per-ticket fail-fast on target repos later proves load-bearing, that is a separate ④ decision.
- **Completion-authority trap-doors (R-CWGE / B-1SEAM)** — update in lockstep; verify the full release gate.
