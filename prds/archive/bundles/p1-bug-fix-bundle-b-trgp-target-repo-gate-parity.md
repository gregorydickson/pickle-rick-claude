---
title: "B-TRGP (re-scoped ②-tight) — Subtract the off-repo fake-green gate special-case"
priority: P1
r_codes: [B-TRGP]
status: SUPERSEDED-DO-NOT-BUILD
build_protocol: PIPELINE
line: release/v2.1-beta
composes: []
---

> ## ⛔ CONCLUSION 2026-07-16 — DO NOT BUILD THIS PRD. B-TRGP is PROVEN NON-SUBTRACTIVE.
> A 4-round `/pickle-refine-prd` dogfood (④ run-the-portable-gate → ③ unverified-state → ②-tight → ②-tight-bounded)
> proved the off-repo fake green is **LOAD-BEARING**: `workerGateRefusal` (`ticket-completion-evidence.ts:812`)
> proceeds ONLY on `verdict==='green'`, so removing the fabrication refuses every target-repo Done (bricks the
> build); the fabrication lives at 7 sites incl. a durable persisted one (`persistRunnerAuthoredGreenVerdict:4988`);
> and the honest fix is ADDITIVE + collides with the `bin/CLAUDE.md:80` trap-door. **Options: ① LEAVE
> (recommended — the review/closer portable gate already verifies target repos) · ② full-remove (loses on-repo
> fail-fast) · ③ additive honest fix.** The ②-tight body below is RETAINED as the design record; it is
> superseded by this conclusion. See `MASTER_PLAN §B.2` + memory `project_btrgp_fakegreen_is_loadbearing_no_subtractive_fix`.

# B-TRGP — Delete the off-repo fake-green gating (option ②-tight: subtract, don't add) [SUPERSEDED — see banner]

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

## The defect — a BOUNDED set of sites answering "is there an `extension/` dir?" with fabricated constants

The refinement ran the exhaustive sweep the first draft did not (`grep -rn existsSync src | grep -i extension`
→ 4 hits; `grep "join(.*'extension'"` → 42 triaged); the table is **stable at seven and can be closed**:

| # | Site | `file:line` | Off-repo constant today |
|---|---|---|---|
| 1 | `runWorkerGate` | `spawn-morty.ts:1538-1553` | `{ok:true}` (fake pass) |
| 2 | `resolveWorkerGateVerdict` (Done-flip authority) | `mux-runner.ts:4643-4647` | `'green'` (fake pass) |
| 3 | `extensionGreenGate` | `mux-runner.ts:4669-4672` | `'failing'` (contradicts #2) |
| 4 | `commitGatePassingDeliverableOnExitPath` | `mux-runner.ts:5153-5154` | `'no-extension-dir'` (declines) |
| 5 | `runBetweenTicketFastGate` | `mux-runner.ts:670-671` | `null` (skipped) |
| 6 | `recomputeAbsentWorkerGateVerdict` (recompute path) | `mux-runner.ts` | runs `tsc` over a missing `extension/` |
| 7 | **`runArmedGate` → `persistRunnerAuthoredGreenVerdict`** | `mux-runner.ts:4988` (called `:1521`/`:5020`) | **PERSISTS `worker_gate_verdict:'green'` to ticket frontmatter** |

**⚠ #7 is the site that BREAKS a naive fix (verified).** On the recovery/armed-gate path, `runArmedGate`
returns a fabricated `{ok:true}` off-repo (site #1's twin), and `commitAndContinueDoneFlip` calls
`persistRunnerAuthoredGreenVerdict` which WRITES `green` into the ticket file. `resolveWorkerGateVerdict:4641`
reads that persisted verdict FIRST (`if (persisted !== 'absent') return persisted`) — **before** the `:4647`
`existsSync` branch. So deleting `:4647` alone leaves the off-repo fake green fully intact on the recovery
path, now DURABLE ON DISK. The fix must gate the fabrication at its SOURCE (the gate functions #1/#7 and the
persist), not at the read site. Also: `recovery-controller.ts:91` records `'committed gate-passing tree for
<ticket>'` into persisted `state.recovery_attempts[]` off-repo — a fabricated CREDIT about a tree nothing
examined (violates AC-2-3's "never credited to").

Seven hardcoded off-repo answers, #2/#3 mutually contradictory, and #7 durably persisted. R-CWGE's invariant
("Done requires a GREEN worker-gate verdict") is satisfied VACUOUSLY off-repo — the lie, at multiple sites.

## Workstreams

### WS-1 — one applicability predicate [the single seam]
Introduce `isWorkerGateApplicable(workingDir): boolean` = `fs.existsSync(path.join(workingDir, 'extension'))`
— naming the check that today lives inline at five sites. This is the ONE seam every site routes through
(the R-AFCC-CALLER-ENUMERATION pattern), pinned by an audit so a future divergence fails the gate.

### WS-2 — gate the fabrication at its SOURCE, so no fake green is produced OR persisted [SUBTRACT]
The lie must die where it is MADE (the gate functions #1/#7), not only where it is read (#2) — else the
recovery path persists it to disk and reads it back (verified). All routed through `isWorkerGateApplicable`:
- `runWorkerGate` (#1) AND `runArmedGate` (#7): when not applicable, return a value the caller reads as
  "not gated" — NEVER a fabricated `{ok:true}` pass.
- `persistRunnerAuthoredGreenVerdict` (#7, `mux-runner.ts:4988`): MUST NOT write `worker_gate_verdict:'green'`
  when the gate is not applicable — the highest-severity site (durable on-disk fake green). With #1/#7's
  source fixed it is never called with a fabricated pass; belt-and-suspenders, gate the write too.
- `resolveWorkerGateVerdict` (#2): delete the `return {verdict:'green'}` off-repo branch; when not applicable
  the worker-gate conjunct is dropped and `guardCompletionCommitBeforeDone` proceeds on commit-evidence.
- Reconcile #3 `extensionGreenGate` / #4 / #5 to the same "not applicable → does not gate" semantics, so the
  seven constants collapse to one honest answer and the #2/#3 contradiction disappears. **Verify each site's
  consumers first** — #3 feeds the R-CECB attribution oracle; "not applicable" must be correct for THAT
  consumer too, not merely for the Done-flip.
- `recovery-controller.ts:91`: do not record a `'gate-passing tree'` CREDIT into `state.recovery_attempts[]`
  when no gate ran; reword to the truthful "committed tree (gate not applicable)" off-repo.

### WS-3 — the recompute path is applicability-gated too (#6) [reuse the seam]
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
- **AC-2-1 (universal)** — `it("off a pickle-rick checkout (no extension/), NO worker-gate PASS is fabricated at ANY of the seven bounded sites — not a returned ok:true/'green', and not a PERSISTED worker_gate_verdict:'green' in ticket frontmatter")`. Property over the bounded set, not an enumerated five.
- **AC-2-7 (the recovery path — the site that breaks a naive fix)** — `it("on the armed-gate/commit-and-continue recovery path off-repo, persistRunnerAuthoredGreenVerdict does NOT write green to frontmatter, so resolveWorkerGateVerdict:4641 cannot read back a fabricated verdict")`.
- **AC-2-8** — `it("recovery-controller records no 'gate-passing tree' credit into state.recovery_attempts when the gate is not applicable")`.
- **AC-2-2** — `it("all seven sites derive their applicability from the single isWorkerGateApplicable seam; no bare off-repo constant (ok:true / 'green' / 'failing' / null / 'no-extension-dir' / the persisted green) survives")` — call-site audit.
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
