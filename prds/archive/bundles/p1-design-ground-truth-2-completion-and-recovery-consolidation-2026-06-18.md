---
title: P1 Design Deepening — B-GROUND2 — completion-authority + recovery-transition single-choke-point consolidation (R-DSAN follow-through)
status: APPROVED 2026-06-18 — operator greenlit; refining + building via /pickle-pipeline
priority: P1
filed: 2026-06-18
updated: 2026-06-18 (folded in #124 R-DPMC-2 + by-invariant WS1 reframing)
r_code_prefix: R-GROUND2
backend_constraint: any
parent_thesis: prds/p1-design-simplification-and-autonomy-2026-06-13.md  # R-DSAN
peer_prds:
  related:
    - prds/archive/bundles/p2-bug-fix-bundle-b-resh-pipeline-resume-gate-parity-hardening.md  # the point-fixes this generalizes (SHIPPED beta.15)
    - prds/archive/bug-reports/BUG-REPORT-2026-06-18-pipeline-unresumable-after-partial-completion.md  # #122
    - prds/archive/bug-reports/BUG-REPORT-2026-06-18-decomp-nestjs-provider-module-coscope-deadlock.md  # #124 R-DPMC (WS1 folds in -2; -1/-3 → B-DECOMP-SAT)
    - prds/archive/bug-reports/BUG-REPORT-2026-06-17-large-tier-manager-turn-builds-but-does-not-commit.md  # #121
    - prds/archive/bug-reports/BUG-REPORT-2026-06-17-audit-ticket-bundle-extension-relative-path-false-fatal.md  # #120
  spawns:
    # B-DECOMP-SAT (R-DPMC-1/-3, decomposition layer D4) — TO BE AUTHORED, not yet tracked
---

# B-GROUND2 — completion-authority + recovery-transition consolidation

**APPROVED FOR BUILD (2026-06-18, operator greenlit).** R-DSAN follow-through. The findings from B-WPEX-AUTO + the unresumable-pipeline report + the NestJS-decomp deadlock are **not new bugs — they are D2 recurrences of the structural defects R-DSAN named**, because R-DSAN shipped the right primitives but did not wire them to the completion seams, and its build-failing enforcement spine has no proxy for them. This PRD makes the proven W4a single-choke-point + build-failing-audit pattern reach those seams, **defined by invariant rather than by enumerated call-site**, so seam N+1 inherits the behavior for free instead of becoming the next point-fix.

## Thesis — R-DSAN was right and incomplete; the regress is now measured 4×

R-DSAN (shipped beta.3) named D1 (validation overreach), D2 (wrong-signal completion → work discard), D3 (simplification debt) and the north star: *trust ground truth, validate proportionally, never discard verified work, subtract a guard before adding an escape hatch.* It shipped the primitives — `reconcileTicketTruth`, `salvageTicket`, `routeRecoveryBeforeTerminal`, `pickle-recover` — and **one** build-failing spine, `audit-design-ground-truth.sh`. The W4a single-choke-point pattern (proven: `halt-or-recover-choke-point.test.js` green) consolidated the **halt/recovery-decision** seam only.

**Four findings since (all post-R-DSAN, post-beta.3) are the same family — "proceed/finalize as complete while work is genuinely incomplete" — each at a DIFFERENT seam:**

| Finding | Class | Seam | Mechanism | Why it slipped |
|---|---|---|---|---|
| #120 R-ATPR | **D1** | audit gate | `audit-ticket-bundle` false-fatals extension-relative paths; first reflex was a skip-flag | gate-parity not consolidated — audit and readiness resolve paths differently |
| #121 R-LTMC | **D2** | EPIC finalize | manager builds large ticket in-turn, completion keyed on turn-return not tree-truth | the "ground truth at completion" generalization never reached the **finalize-terminal** seam |
| #122 R-PRESUME | **D2** | un-terminalize | false-completion → sticky terminal → unresumable; no sanctioned un-terminalize | the `pickle-recover` keystone covers resume/salvage/reattach/reset but NOT un-terminalize |
| **#124 R-DPMC-2** | **D2** | **phase-graduate** | breaker-tripped pickle phase **silently graduated to anatomy-park with 14/24 tickets Todo** | phase-graduation is `shouldHaltAfterPhase` (R-PHC-6 continue-on-non-fatal) — **NOT a `finalizeTerminalState` call**, so even WS1-as-originally-scoped would miss it |

**#124 R-DPMC-2 is the sharpest evidence yet — it exposes a gap inside this very PRD.** WS1 was originally scoped to "route all 17 `finalizeTerminalState` sites through the choke point." But a phase-graduation after a breaker trip is **not** a `finalizeTerminalState` call — it is the pipeline-runner deciding to advance to the next phase. So the original WS1 would have shipped and **still let R-DPMC-2 through.** The meta-pattern (a fix exists, the next seam bypasses it) reproduced itself *against the fix's own plan*. The lesson: **define the choke point by its invariant, not by an enumerated list of known call sites** — because the list is never complete.

### The two phase-exit paths disagree (the R-DPMC-2 root cause)

pipeline-runner makes the same "are tickets still pending?" decision in **two inconsistent places**:

- **Clean pickle exit (code 0) + pending tickets** → already does *"exited clean but N/M pending — marking phase incomplete, not advancing"* (verified firing correctly during the B-RESH build).
- **Breaker/error exit + pending tickets** → routes through `shouldHaltAfterPhase`, which under **R-PHC-6** *deliberately continues* to remediation on non-fatal pickle exits.

Same condition, opposite outcomes, keyed on exit code. R-DPMC-2 fell into the second path: a breaker trip with 14/24 unbuilt was treated as "non-fatal, proceed to polish." **The fix is to unify both phase-exit paths through one ground-truth-gated graduation decision** — not to add a third guard.

### The R-PHC-6 tension — resolve it, don't revert it

R-PHC-6 exists for a real reason: don't discard anatomy/szechuan remediation because pickle had a *minor* partial failure. So the graduation gate **cannot be binary** ("any pending → halt") — that reverts R-PHC-6. It must be **proportional**: distinguish "47/49 done, 2 skipped — proceed to polish" from "breaker-tripped, majority unbuilt — halt incomplete." The graduation decision keys on *how much real progress the phase made* (built-vs-pending ratio and/or breaker-trip-with-majority-pending), via the same `reconcileTicketTruth` signal — not on the exit code alone.

**Ground-truth measurement (2026-06-18):** 17 `finalizeTerminalState(` sites (`pipeline-runner.ts` 2 with **zero** `reconcileTicketTruth` coverage; `mux-runner.ts` 13 with 7 reconcile refs, not 1:1, not enforced) **PLUS** the phase-graduation seam (`pipeline-runner.ts:shouldHaltAfterPhase` + the clean-exit pending-check — two divergent paths). `audit-design-ground-truth.sh` pins 3 proxies — **none** asserts "no transition to a more-complete state without a tree-truth pending-scan." The guard that would have *prevented* #121/#122/#124-2 does not exist.

## Design principles (the law this enforces — inherited from R-DSAN, extended)

1. **One completion authority, enforced — by invariant.** *No transition to a more-complete state — terminal `step:'completed'` **OR** phase-graduation (advance to the next pipeline phase) — happens without a ground-truth frontmatter pending-scan via `reconcileTicketTruth`.* Never a turn-return signal, exit code, or inferred status. A build-failing audit proves **every** such transition (current + future) routes through the one choke point.
2. **One recovery command, complete.** Every terminal↔runnable transition — including **un-terminalize** — routes through `pickle-recover`'s primitives. No operator hand-edit of `state.json` is ever the only path.
3. **Gate parity (D1).** Sibling gates (readiness ↔ ticket-audit) resolve the same reference through ONE shared resolver. Loosen-or-share, never add a per-gate skip-flag.
4. **Subtract before add.** Each workstream consolidates existing point-fixes into an enforced choke point and DELETES the bypass risk (and, for WS1, collapses two divergent decision paths into one) — it does not add a parallel guard.

## Workstreams (PLAN — refine into atomic tickets when greenlit)

### WS1 — Completion-authority single choke point, by-invariant *(D2 keystone; generalizes B-RESH W2; folds in #124 R-DPMC-2)*
B-RESH shipped the false-completion guard at the EPIC/all-done finalize seam. WS1's delta is **universalization + enforcement, defined by invariant**:
- Route **every transition to a more-complete state** through one authority: (a) all 17 `finalizeTerminalState({step:'completed'})` sites, AND (b) the **phase-graduation decision** in `pipeline-runner.ts` (both the clean-exit pending-check and `shouldHaltAfterPhase`'s continue-to-remediation path). Each re-scans frontmatter via `reconcileTicketTruth` and refuses to advance/finalize when tickets are pending — excluding legitimate `exit_reason:'limit'`/operator-cap terminals.
- **Resolve the R-PHC-6 tension proportionally:** phase-graduation continues to remediation only when the phase substantially completed; a breaker-trip / error exit with a majority of tickets still `Todo` emits `pickle_phase_incomplete` and halts (reusing the existing clean-exit pending-check logic — *unify* the two paths, don't add a third).
- **4th proxy in `audit-design-ground-truth.sh`:** a raw `finalizeTerminalState({step:'completed'})` **or** a raw phase-advance not routed through the authority FAILS the build. Single-choke-point `git grep` + a `completion-finalize-choke-point.test.js` lint (mirroring `halt-or-recover-choke-point.test.js`), incl. synthetic-bypass red cases for BOTH the finalize seam and the phase-graduate seam.

### WS2 — Recovery-transition single command *(closes the un-terminalize gap; generalizes B-RESH W3)*
B-RESH shipped `pickle-recover --reactivate`. WS2's delta: make it the **ONLY** un-terminalize path + enforcement. Audit/lint proves no `state.json` `active`/`step` un-terminalize write exists outside `pickle-recover` + the sanctioned setup/resume path. Document the full recovery-transition matrix (the 5 babysitter recipes → one command) in `extension/CLAUDE.md`.

### WS3 — Gate-parity shared resolver *(D1; generalizes B-RESH W1 + closes #120 class)*
B-RESH shipped the audit hallucinated-premise suffix-match. WS3's delta: `check-readiness` and `audit-ticket-bundle` resolve a path/symbol reference through ONE shared module (extend `forward-ref-annotation.ts` / the R-RTRC-4 normalizer) so gate parity is structural, not two matchers that drift. Lint: no inline path-resolution regex in either consumer.

### WS4 — Recurrence dashboard wired to the classes *(D3; makes the next regress visible)*
Extend the `/pickle-metrics` skip-flag dashboard to also count **finalize-refused**, **phase-graduation-refused**, and **gate-parity-divergence** events, so the *data* — not a human's session-end reflection — surfaces the next seam before it becomes a P0.

## Out of scope — spawned to B-DECOMP-SAT (#124 R-DPMC-1/-3, the D4 decomposition layer)

R-DPMC-1 (refiner under-scoped a ticket → unsatisfiable under the scope fence) and R-DPMC-3 (unsatisfiable-ticket fast-fail) are a **distinct defect class** — *decomposition produces an unsatisfiable unit* (call it **D4**) — that lives **upstream of the runtime completion-authority** this PRD consolidates. Folding them here would break bundle thesis cohesion. They move to `prds/archive/bundles/p2-bug-fix-bundle-b-decomp-sat-decomposition-satisfiability-2026-06-18.md`. Only **R-DPMC-2** (phase-graduation) belongs here, folded into WS1 above.

## Reconciliation with B-RESH (shipped) — no rework

B-RESH (shipped v2.0.0-beta.15) landed the **point-fixes**. B-GROUND2 builds the **consolidation + enforcement on top** — it re-implements no B-RESH AC.

| B-RESH point-fix (shipped beta.15) | B-GROUND2 generalization |
|---|---|
| W2 false-completion guard (EPIC finalize seam) | WS1: universalize to all finalize sites **+ the phase-graduation seam (#124 R-DPMC-2)** + by-invariant build-failing proxy |
| W3 `pickle-recover --reactivate` | WS2: make it the ONLY un-terminalize path + lint |
| W1 audit hallucinated-premise suffix-match | WS3: shared resolver (delete the second copy) |
| W4 wedge on iteration-log mtime | — (standalone; no consolidation needed) |

## Simplification Review (subtract-before-add)
1. **Necessary?** Yes — the recurrence is now measured **4×** (#120/#121/#122/#124-2), not vibes. Scoped to a FOCUSED deepening (extend a proven pattern to the completion seams), NOT a full re-derivation.
2. **Reuse not add?** Every WS reuses a shipped primitive (`reconcileTicketTruth`, `pickle-recover`, the R-RTRC-4 normalizer, the `audit-design-ground-truth.sh` spine, the `/pickle-metrics` dashboard, **and the pipeline-runner's existing clean-exit pending-check** — WS1 unifies the breaker/error path INTO it rather than writing a new checker). The only net-new code is the choke-point helper + audit proxies, which exist to DELETE bypass risk.
3. **Guards brittle complexity?** WS1 SUBTRACTS the sticky-terminal, silent-graduate, and divergent-phase-exit-path failure modes; WS2 subtracts the no-un-terminalize mode; WS3 collapses two path resolvers to one; none adds a skip-flag. R-PHC-6 is *reconciled* (proportional), not reverted or guarded-around.
4. **Subtract?** Net removal: every ad-hoc finalize/graduate site → 1 choke point; **2 divergent phase-exit decision paths → 1**; 2 path resolvers → 1; the 5 babysitter recovery recipes → 1 command; the per-gate skip-flag reflex → enforced parity.

**APPROVED — refine into atomic tickets + build via /pickle-pipeline (operator greenlit 2026-06-18).** Build B-DECOMP-SAT (#124 R-DPMC-1/-3) separately — no file overlap with this bundle's runtime seams except the shared `reconcileTicketTruth` read, so ordering between the two is flexible. Lead with collapse-not-gate: prefer unifying duplicate finalize/graduate sites (which dissolves the audit-proxy/lint need) over gating N sites.

## Implementation Task Breakdown
*(refined: 3-analyst × 3-cycle team + collapse-not-gate operator steer; lean decomposition — wiring skipped (consolidation; WS1 IS the integration), hardening 4→2 (downstream citadel/anatomy/szechuan cover test-quality + cross-ref))*

| Order | ID | Title | Priority | Tier |
|---|---|---|---|---|
| 10 | ce5d1cc8 | Route all completion + phase-graduation transitions through one by-invariant ground-truth authority (WS1 keystone) | High | medium |
| 20 | 005c63c9 | Make pickle-recover --reactivate the only sanctioned un-terminalize path (WS2) | High | small |
| 30 | 7e6f9259 | Gate-parity: one shared path/symbol resolver for check-readiness + audit-ticket-bundle (WS3) | High | small |
| 40 | b7cc6081 | Recurrence dashboard: finalize/phase-graduation/gate-parity event counts (WS4) | High | small |
| 50 | 226f1604 | Harden: code quality review of B-GROUND2 consolidation | High | large |
| 60 | a1942f72 | Audit: data flow integrity for B-GROUND2 consolidation | High | large |
