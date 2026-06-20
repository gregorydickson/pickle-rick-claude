---
title: P2 Simplification Pass — B-GSUB — guard-inventory subtraction (data-driven, low-risk)
status: APPROVED
priority: P2
filed: 2026-06-18
r_code_prefix: R-GSUB
backend_constraint: any
parent_thesis: prds/p1-design-simplification-and-autonomy-2026-06-13.md  # R-DSAN D3 (simplification debt)
peer_prds:
  related:
    - prds/archive/bundles/p1-design-ground-truth-2-completion-and-recovery-consolidation-2026-06-18.md  # B-GROUND2 — functional collapse that DISSOLVES another batch of guards
basis: 2026-06-18 failure-history + guard-inventory analysis (two agents)
---

# B-GSUB — guard-inventory subtraction pass

**PLAN ONLY.** Operator steer 2026-06-18: *"we are somewhat fighting complexity; analyze the failures, then apply simplification where needed."* Two analyses ran. This PRD is the **data-driven, low-risk** half of the response — remove redundant/stale/one-incident guards. The **functional** half (collapse the bug-generating seams) is B-GROUND2; the two are sequenced so neither documents-then-deletes the other's guards.

## Evidence (measured 2026-06-18, not asserted)

- **~205 documented guards** (~140 file-targeted trap doors + ~58 state.json field invariants). **Only ~44% demonstrably load-bearing**; ~39% one-incident (single dated session, no recurrence); ~16% advisory/duplicate.
- **Fix-shape ratio across ~150 findings: ADDED : SUBTRACTED ≈ 4.6 : 1** — the accretion this pass reverses (the D3 simplification-debt R-DSAN named).
- **Guard density tracks bug density:** the top-3 most-guarded files (`mux-runner.ts` ~34, `microverse-runner.ts` ~28, `check-readiness.ts` ~13) are also the top bug hot-spots. The guard burden is concentrated exactly where complexity already hurts.

## Principle

A guard earns its place only if it prevents a class that **recurred** (or carries a concrete, documented multi-incident consequence). One-incident band-aids, per-site restatements of an already-enforced subsystem contract, and meta-guards-on-tests are **carrying cost**: cognitive load + brittleness surface + test burden, with no recurrence evidence. This pass removes them. Per W5b it is **data-driven, not memory-driven** — every removal cites the analysis basis, and nothing load-bearing is touched.

## Workstreams (all SUBTRACTION; risk-tiered; refine into atomic tickets when greenlit)

### WS1 — Finish the two half-done consolidations *(near-zero risk — the single-source module ALREADY exists)*
The single-source modules were shipped; the docs still carry the pre-consolidation per-symptom trap doors.
- **Forward-ref grammar (Cluster C):** `forward-ref-annotation.ts` (R-FRA-6) is already the one predicate. Collapse the ~9 trap doors (R-RTRC-1/2/3/4/5/6/7, R-FRA-1/2, R-SAOV-7) to **three**: shared-predicate, readiness-consumer, audit-consumer. Delete R-RTRC-6 (a meta-guard whose content is "the test ships 3 fixtures").
- **Completion-evidence Done-flip (Cluster D):** `ticket-completion-evidence.ts` (R-AFCC-DEEP-CONSOLIDATED) is already declared the single oracle. Demote R-CCQF/R-CCRC-1/2/R-AFCC-STAGE/-WRITE-OBS from top-level trap doors to **oracle-internal behavior notes** of `readEvidence`; keep single-oracle + caller-enumeration + completion-authority-single-source.
- **Net:** ~12 trap doors removed; behavior unchanged (tests already enforce the real contracts).

### WS2 — Demote per-site restatements to their subsystem contract *(low risk — contract + audit already exist)*
- **Cluster A — "all `state.json` readers use `StateManager.read()` / `readRecoverableJsonObject()`" (~30 trap doors):** this is **already** bin/CLAUDE.md subsystem contract #2 + enforced by `audit-trap-door-enforcement.sh`. Replace the ~30 per-file restatements with one "readers covered" table under the contract. *Largest single subtraction available.*
- **Cluster B — "every subprocess spawn passes a finite `timeout`" (~10 trap doors):** already subsystem contract #3 + audit grep. Same demotion.
- **Cluster F — session ranking / dead-pid demotion (~9 trap doors in pickle-utils + the 5 identical resolve-state mirrors):** one ranking-contract guard + one test surface; collapse resolve-state's 5 → 1.
- **Net:** ~40 trap doors → ~4 contracts + their existing audit scripts. No behavior change.

### WS3 — Remove dead / one-incident / unobservable guards *(low–moderate risk, per-item)*
Per-candidate, with the analysis-cited risk:
- **R-TFP-C3 3× regression loop** (`regression-test-fast-integration-3x.sh`) — created to *close* R-TFP by collecting 3 greens; if R-TFP is confirmed closed it's a permanently-`RUN_REGRESSION_3X`-gated artifact earning nothing. **Delete after confirming R-TFP closed.** (low)
- **R-MWR-4 EOF resilience** triplicated across log-watcher/morty-watcher/raw-morty — collapse to the one shared-primitive trap door (`detectLogTruncation`). (very low)
- **R-MDS-3** (monitor inline mode re-check) — explicitly "defense-in-depth" behind R-MDS-1/4 which already respawn at every boundary; redundant backstop. (low–moderate, cosmetic)
- **R-MUXQG** (`_resetQualityGateSkipDeprecation` prod-must-not-call) — guards a one-line process-local flag; make the flag module-private and drop the trap door + audit entry. (very low)
- **`producer_done` window** (pipeline-runner F2.2 + `monitor_panes` + reader caveats) — the guard itself admits the signal is unobservable and consumers must poll liveness anyway; drop the transient flag, keep the liveness poll. (moderate, monitor UX only)
- **~50 boilerplate state.json field-shape invariants** — collapse identical per-backend (`grok_model`/`kimi_model`/`gemini_model`/`hermes_*`) and per-cache-field lines into parameterized invariants; `state-field-invariants.test.js` already parameterizes. (very low)

### WS4 — Verify-before-remove gate (the one guard this pass ADDS — and it's temporary)
Before removing any guard, confirm its ENFORCE test still passes WITHOUT it being a no-op, and grep the incident basis. Removal tickets run the full gate. (This is process, not a runtime guard — no new machinery ships.)

## Explicitly OUT of scope (leave alone — evidence says so)
- **The scope fence** — the analysis shows it behaved *correctly*; the bug is upstream decomposition (#124 R-DPMC-1). Do NOT loosen it.
- **The per-site finalize / phase-graduate guards** — those dissolve under **B-GROUND2 WS1** (one `finalizeIfTrulyComplete`). Do NOT pre-remove or pre-document them here; let the functional collapse delete them so we don't churn twice.
- **Capability surfaces** (extra backends, teams mode, detached workers) — backends are only ~7 findings, not a top cluster; no evidence basis for removal yet. Revisit with usage data + operator sign-off.
- **High-recurrence load-bearing guards** — schema-ahead wedge (R-WSRC-1), cap split (R-CNAR-1), foreground-only auto-resume (R-CNAR-2), completion-authority-single-source — all cite multi-incident budget-burn/wedge consequences. Keep.

## Simplification Review (subtract-before-add)
1. **Necessary?** This PRD is pure subtraction — it adds no runtime code, no flag, no gate. WS4 is a process step, not machinery.
2. **Reuse not add?** Every WS demotes per-site guards to an **already-existing** subsystem contract + **already-existing** audit script / single-source module. Nothing new is built.
3. **Guards brittle complexity?** It REMOVES brittle complexity (one-incident guards, duplicate restatements, unobservable signals) — the opposite of guarding it.
4. **Subtract?** Target: **~50–70 of ~205 guards removed** (WS1 ~12, WS2 ~40, WS3 ~10 + ~50 field-lines collapsed), behavior-preserving, with the bug-generating-seam guards deferred to B-GROUND2's functional collapse.

## Sequencing
B-GSUB (this, low-risk hygiene) and B-GROUND2 (functional collapse) are complementary. Recommended order: **B-GROUND2 WS1/WS3 first** (collapse the finalize + resolver seams → dissolves the per-site guards as a side effect), **then B-GSUB** sweeps the independent redundancy (Clusters A/B/F + WS3 dead guards). Running B-GSUB's WS1/WS2 first is also fine since they touch docs/contracts only — but do NOT remove finalize/readiness per-site guards in B-GSUB; that's B-GROUND2's job.

## Empirical Result (2026-06-20 — WS1 + WS2 executed under verify-before-remove)

**The inventory OVERSTATED free subtraction by ~3–5×. Honest yield: −9 trap doors (WS1 −1, WS2 −8), vs the projected ~13 for those two clusters (and ~50 for the whole pass).** Both passes ran the per-guard verify-before-remove gate (full audit set + ENFORCE tests green; behavior-preserving; ENFORCE-reachability 195 refs unchanged).

- **WS1 (forward-ref cluster):** projected 9→3; actual **−1** (only `R-RTRC-6`, a pure "the test ships 3 fixtures" meta-guard). R-RTRC-1/2/3/4/5/7, R-FRA-1/2, R-SAOV-7 are **distinct load-bearing guards** (separate false-positive RCs, each with its own PATTERN_SHAPE anchor) — not grammar restatements. Committed `3e6f887`.
- **WS2 Cluster A (state.json readers):** projected ~30→1; actual **−8** (9 pure `StateManager.read()` one-liners → one *State-reader coverage* bullet preserving all 12 ENFORCE refs). The other ~16 "state-reads" entries each carry a distinct invariant (R-MWR-4 EOF, R-PEDC, R-WSRC-2, crash-fallback, …) and stay. Committed `aa3ad29`.
- **WS2 Cluster B (finite spawn timeout):** projected ~10→1; actual **0 free** — every timeout invariant is embedded in a distinct named trap door (R-APMW-6 close-ordering, test-runner runner-timeout, plumbus `BUN_TIMEOUT_MS`, spawn-morty timeout-CLI). Nothing collapsible without losing coverage.

**Strategic conclusion (recalibrates the parent thesis D3 "simplification debt"):** the guard surface is **substantially more load-bearing than the density metric implied** — the 44%-load-bearing / 4.6:1 add:subtract figures counted distinct-invariant guards as redundant. This is, counter-intuitively, **good news for stability/GA**: the guards are mostly *earned* (real tested invariants), not dead weight. **Pure doc-level guard deletion is NOT the simplification lever.** The real complexity-reduction lever is **B-GROUND2-style functional seam-collapse** — removing the bug-generating code paths, which dissolves their guards as a side effect.

**WS3 DEPRIORITIZED** (diminishing returns): the remaining items (R-TFP-C3 loop, triplicated-EOF, R-MDS-3, R-MUXQG, ~50 field-invariant parameterization) are low-stability-value cosmetic doc/line reductions; the same "turns out distinct" surprise is likely. Revisit only if a specific item is independently justified (e.g. R-TFP-C3 deletion after confirming R-TFP closed).

**STATUS: WS1+WS2 DONE (−9, doc-only, no runtime change → no release/deploy). WS3 deprioritized. Pure-doc-subtraction track CLOSED.** The simplification budget redirects to functional seam-collapse (operator-scoped) and the field-proof GA gate.
