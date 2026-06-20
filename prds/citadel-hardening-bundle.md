# PRD: Citadel + Hardening Bundle (Refined)

> **Refined manifest** — original at `prd.md`, source at `prds/citadel-hardening-bundle.md` (commit `120eb40`).
> 3-cycle / 3-analyst refinement complete (see `refinement_manifest.json`, `refinement_summary.md`).
> Decomposition strategy: **compact tickets pointing to source PRDs**. Worker reads ticket file PLUS cited source PRD §section at execution time.
> Backend: **codex-required** (frontmatter below). Refinement was claude per skill contract; implementation + review use codex.

---

frontmatter:
```
backend: codex-required
session_root: /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-04-29-1204204c
working_dir: /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
```

---

## Background

Three PRDs sat queued after the god-fn epic and anatomy-park overnight runs. Two are tactical hardening of recently-shipped runtime (`anatomy-park-followups`, `watcher-pane-recovery`); one is a strategic new audit skill (`citadel`). They are coupled in one direction:

- Citadel's audit subskill spawns workers and may invoke the microverse-runner. `anatomy-park-followups` B-T3 (extend codex-manager-relaunch from `mux-runner.ts` to `microverse-runner.ts`) closes a wall the audit will hit on long runs.
- A ~70-ticket pipeline must be observable. `watcher-pane-recovery` is the dashboard fix for the bundle's own long run — without it, three of four monitor panes go silent after every phase transition.

Bundling them lets refinement deduplicate the small overlap (anatomy-park-followups B-T3 ↔ citadel's audit-subskill spawn assumptions; watcher-pane-recovery ↔ pipeline-runner phase-transition ownership) and produces one tmux session instead of three.

**Refinement verdict (3 cycles, 3 analysts):** scope locked to **Option B** (BMAD appendix in-scope). Six refinement-derived corrections folded into ticket queue (see §Refinement Corrections below). Six NEW tickets (NEW-T1..T6) added.

## Scope (LOCKED — Option B)

This bundle delivers the union of the three source PRDs **plus the BMAD appendix from `prds/citadel.md`** in one ticket queue, executed in one `/pickle-pipeline --backend codex` session.

- **Section A — Watcher Pane Recovery**: 4 tickets, source `prds/archive/features/watcher-pane-recovery.md` §Atomic Tickets (T1–T4). **Do NOT add a new T5** — see Refinement Correction #1.
- **Section B — Anatomy-Park Followups**: 3 tickets, source `prds/anatomy-park-followups.md` §Atomic Tickets (B-T1, B-T2, B-T3).
- **Section C — Citadel Core + Cross-Skill**: 25 tickets, source `prds/citadel.md` §Tasks (T0–T17 + T10.5/T10.7/T10.8/T10.9/T11.5/T11.7 + T13.5 + T20–T23).
- **Section D — BMAD Appendix (in-scope)**: 28 tickets, source `prds/citadel.md` §Appendix Implementation Task Breakdown (BMAD-T01..BMAD-T28).
- **Section E — NEW (refinement-derived)**: 6 tickets (NEW-T1..NEW-T6) — see §New Refinement-Derived Tickets.

**Total implementation tickets**: ~66. Plus 1 wiring + 4 hardening = ~71 tickets total.

## Refinement Corrections (apply when decomposing)

These P0 corrections from refinement analysis are folded into all source-PRD tickets. The decomposed ticket files reference this section.

1. **Drop the proposed A-T5 ticket.** Adding a fifth `ensureMonitorWindow()` call site would violate AC-WPR-04's "exactly once" rule. `pipeline-runner.ts:1001`, `mux-runner.ts:1542`, `microverse-runner.ts:1512` already call it. Once T1+T2 wire `restartDeadWatcherPanes` into the "exists" branch of `pickle-utils.ts:1027`, all three call sites start working. Do NOT add a new call to pipeline-runner.

2. **AC-WPR-07 mode names.** Source PRD says `'refine'`; the actual `MonitorMode` union at `pickle-utils.ts:881` says `'refinement'`. Watcher-pane-recovery tickets must use `'refinement'` not `'refine'`. Note in ticket body.

3. **B-T2 (recoverable-json.test.js).** Drive only the public `readRecoverableJsonObject`. `parseDeadTmp` / `parseJsonObjectFile` / `listEntries` are module-private. Construct real on-disk fixtures with controlled mtime + alive/dead PIDs.

4. **Sequencing fix:** B-T1 (trap-door catalog hygiene) MUST land before citadel T0 (which amends `extension/CLAUDE.md` trap-door entry for `setup.ts`). They race for the same paragraph. Order: B-T1=10, citadel-T0=200.

5. **AC-BUNDLE-03 cap scope.** `codex_manager_relaunch_count` cap (now `Defaults.CODEX_MANAGER_RELAUNCH_CAP = 10`) is enforced **per state.json file**, including child `microverse_*/state.json` spawned during citadel phase.

6. **B-T3 (microverse codex-relaunch) ordering.** B-T3 ships at order 20. Citadel's audit subskill may invoke `microverse-runner`; B-T3 must land first. Reuses `Defaults.CODEX_MANAGER_RELAUNCH_CAP` (now 10), `state.codex_manager_relaunch_count`, `codex_manager_relaunch` activity event.

## New Refinement-Derived Tickets

| ID | Order | Title | Why |
|---|---|---|---|
| NEW-T3 | 5 | Anchor re-grounding orchestrator step | Pre-step under `spawn-refinement-team.ts` resolves every file:line citation in source PRDs against current HEAD before fan-out. Emits warnings for stale anchors. Ships before any source-PRD-cited ticket runs. |
| NEW-T5 | 30 | codex-required frontmatter check | Implements AC-BUNDLE-18. `pipeline-runner` reads bundle PRD frontmatter `backend: codex-required` at startup; invocation without `--backend codex` rejected with actionable error. |
| NEW-T1 | 250 | citadel-cross-phase-fixture authoring | Create `extension/tests/fixtures/citadel-cross-phase-fixture/` with canonical `anatomy-park.json` (3 findings: Critical/High/Low) + `szechuan-sauce.json` (2 findings, including a duplicate-id case). Test asserts `findings[].id` uniqueness across merged report. Ordered before citadel T10.7 / T10.9. |
| NEW-T2 | 300 | v2→v3 state migration rollback path | Add to `extension/src/services/state-manager.ts`: detect v3-shape on a v2-aware deployment, emit actionable error. Test: `state-manager.test.js` v3-on-v2 regression. Ordered BEFORE citadel T0 schema additions. |
| NEW-T4 | 350 | Phase-ordered AC firing enforcement | Implements AC-BUNDLE-15. Refinement gate, pipeline-runner per-phase boundary, and bundle-end finalizer each consult `evaluation_phase` field on each AC and fire only the ACs scheduled for that phase. |
| NEW-T6 | 400 | Linear ticket integration | Implements AC-BUNDLE-19. Per-ticket Linear creation/transitions via existing Linear MCP. Bundle-end emits comment per Linear ticket linking back to session log. |

## Sequencing (LOCKED — refiner produced this)

1. **NEW-T3 (anchor re-grounding)** order=5 — runs first, validates all citations resolve.
2. **B-T1 (trap-door catalog hygiene)** order=10 — must precede citadel T0.
3. **B-T3 (microverse codex-relaunch)** order=20 — citadel's audit may invoke microverse.
4. **NEW-T5 (codex-required frontmatter check)** order=30 — gate blocks rest of pipeline if backend wrong.
5. **Section A — watcher-pane-recovery (T1–T4)** orders 40–70 — observability for the long run.
6. **B-T2 (recoverable-json.test.js)** order=80 — independent, parallelizable.
7. **Citadel core (T0–T17)** orders 200–360, with **NEW-T1 inserted at 250** (before T10.7/T10.9) and **NEW-T2 inserted at 300** (before T0's schema additions — but T0 itself is at 200, so NEW-T2 actually slots before that; see below).
8. **Citadel cross-skill (T20–T23, T13.5)** orders 370–420.
9. **NEW-T4 (phase-ordered AC firing)** order 350 (interleaved into core sequence).
10. **NEW-T6 (Linear integration)** order 400 (interleaved with cross-skill).
11. **BMAD-T01..BMAD-T28** orders 430–700.
12. **Wiring** order 800.
13. **Hardening (Code Quality, Data Flow, Test Quality, Cross-Reference)** orders 810/820/830/840.

> Note: NEW-T2 is intentionally placed at order=300 in the table but should be evaluated as a hard prerequisite of citadel-T0 by `pipeline-runner` (sequencing-aware enqueuer). The order-number alone is informational; explicit `links: [parent: citadel-T0]` carries the dependency.

## Acceptance Criteria

This bundle is **Done** when every AC from the three source PRDs + AC-BUNDLE-01..19 is met.

### Section A — Watcher Pane Recovery (7 ACs)
**AC-WPR-01..07** verbatim from `prds/archive/features/watcher-pane-recovery.md` §Acceptance Criteria. Apply Refinement Correction #2 (`'refinement'` not `'refine'`).

### Section B — Anatomy-Park Followups (13 ACs)
**AC-APF-A1..A4** (catalog hygiene) | **AC-APF-B1..B3** (recoverable-json tests) | **AC-APF-C1..C6** (microverse codex-relaunch)
Verbatim from `prds/anatomy-park-followups.md` §Acceptance Criteria.

### Section C — Citadel Core + Cross-Skill (18 ACs)
**AC-CIT-01..18** verbatim from `prds/citadel.md` §Acceptance Criteria.

### Section D — BMAD Appendix
Per-task ACs preserved verbatim in `prds/citadel.md` §Appendix as `P0.N` / `P1.N` / `P2.N` / `P3.N` / `P4.N` / `R##` / `T0##` (do NOT collide with `AC-CIT-NN`).

### Bundle-Level Integration ACs

- **AC-BUNDLE-01** Single tmux session runs the full ticket queue end-to-end on `--backend codex` without watcher panes going silent at any phase transition.
- **AC-BUNDLE-02** `pipeline-runner.ts` Citadel phase reads `<session>/anatomy-park.json` and `<session>/szechuan-sauce.json` correctly when present, exits clean when absent — no double-counting or orphaned-finding errors. Validated against `citadel-cross-phase-fixture` (NEW-T1).
- **AC-BUNDLE-03** During the bundle's own run, no `state.json` (root or any `microverse_*/`) ever shows `codex_manager_relaunch_count > Defaults.CODEX_MANAGER_RELAUNCH_CAP` (= 10 after this bundle's deploy).
- **AC-BUNDLE-04** Refinement deduplicates the codex-manager-relaunch overlap: refined ticket queue contains exactly one ticket implementing the microverse relaunch (B-T3).
- **AC-BUNDLE-15** ACs are evaluated in 4 explicit phases (`pre-refinement` / `post-refinement` / `per-phase` / `bundle-end`); each AC carries an `evaluation_phase` field; failures at phase N halt before phase N+1. (NEW-T4)
- **AC-BUNDLE-16** v3-on-v2 incompatibility produces a recoverable, operator-actionable error (not silent corruption or crash). (NEW-T2)
- **AC-BUNDLE-17** After bundle ships, no trap-door entry in `extension/CLAUDE.md` exceeds 1500 chars AND every `state.json` field is named in exactly one INVARIANT clause.
- **AC-BUNDLE-18** `pipeline-runner` reads bundle PRD frontmatter `backend: codex-required` at startup; invocation without `--backend codex` is rejected with actionable error. (NEW-T5)
- **AC-BUNDLE-19** Each implementation ticket creates a Linear ticket on first execution and mirrors transitions; bundle-end emits Linear comments linking back to session. (NEW-T6)

## Non-goals

- `god-functions-remediation-phase-2.md` (separate pipeline).
- `large-tier-stall-recovery.md` (stale, needs PRD rewrite).
- `deepseek-integration.md` and the three unindexed PRDs.
- Refactoring source PRDs themselves — refined corrections override at decomposition time only.

## Verification Plan

1. **Refinement pass** — DONE (3 cycles, 3 analysts, all_success: true). Manifest at `refinement_manifest.json`.
2. **Decomposition** — produces compact tickets pointing to source PRDs. Worker reads ticket + source section at execution time.
3. **Pipeline run** — `/pickle-pipeline prds/citadel-hardening-bundle.md --backend codex` builds → anatomy-park → szechuan-sauce on the unified queue.
4. **Per-section validation** — each source PRD's verification plan applies in full. Bundle adds AC-BUNDLE-01..19.
5. **Toolchain gate** (v1.58+) — convergence-toolchain-gate runs at finalize-time on every phase. Zero new failures vs. baseline required for clean exit.

## Risks (refined)

| ID | Risk | Mitigation |
|---|---|---|
| RB1 | Refinement produces duplicate tickets for codex-manager-relaunch overlap | AC-BUNDLE-04 + explicit dedup directive in §Sequencing |
| RB2 | Citadel scope dominates and hardening tickets get scheduled last | §Sequencing forces tactical fixes first |
| RB3 | Watcher panes go silent during the bundle's own run before AC-WPR-01 lands | Section A before Section C. AC-BUNDLE-01 validates empirically |
| RB4 | Total ticket count exceeds tmux session token budget on codex backend | Bundle approved for codex (~5–10× faster than claude). Single session feasible; `CODEX_MANAGER_RELAUNCH_CAP` raised 5→10 |
| RB5 | Citadel's `pipeline-runner` phase integration conflicts with watcher-pane-recovery's phase-transition ownership changes | §Sequencing puts Section A before Section C |
| **RB6** | **Cap exhaustion during long codex runs** | **Mitigated by `CODEX_MANAGER_RELAUNCH_CAP=10` deploy** (committed `extension/src/types/index.ts:160`, recompiled, installed at `~/.claude/pickle-rick/extension/types/index.js:61`). Per-state-file scope (Refinement Correction #5). |

## Linked context

- Source PRDs: `prds/citadel.md`, `prds/anatomy-park-followups.md`, `prds/archive/features/watcher-pane-recovery.md`
- Bundle PRD: `prds/citadel-hardening-bundle.md` (commit `120eb40`)
- Refinement artifacts: `refinement/analysis_requirements.md`, `refinement/analysis_codebase.md`, `refinement/analysis_risk-scope.md`
- Master plan reference: `prds/MASTER_PLAN.md` §1
- Predecessor work: god-fn epic, convergence-toolchain-gates v1.58.0, anatomy-park overnight (59 commits)
- LOA-618 post-mortem: drives citadel's design (`prds/citadel.md` §Background)

---

## Implementation Task Breakdown

> Generated by decomposition step. Reference: `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md` for each ticket below.

| Order | ID | Source PRD | §Section | Title | ACs |
|---|---|---|---|---|---|
| Order | Key | ID | Source PRD | §Section | Title | ACs |
|---|---|---|---|---|---|---|
| 5 | NEW-T3 | 74d2bb64 | `prd_refined.md` | New Refinement-Derived Tickets > NEW-T3 | Anchor re-grounding orchestrator step | AC-BUNDLE-15 |
| 10 | B-T1 | 9dd914da | `prds/anatomy-park-followups.md` | Atomic Tickets > T1 | Trap-door catalog hygiene (split oversized entries + standardize ENFORCE) | AC-APF-A1, AC-APF-A2, AC-APF-A3, AC-APF-A4 |
| 20 | B-T3 | 02f70776 | `prds/anatomy-park-followups.md` | Atomic Tickets > T3 | microverse-runner.ts codex-manager relaunch wiring | AC-APF-C1, AC-APF-C2, AC-APF-C3, AC-APF-C4, AC-APF-C5, AC-APF-C6 |
| 30 | NEW-T5 | a1f185d9 | `prd_refined.md` | New Refinement-Derived Tickets > NEW-T5 | codex-required frontmatter check in pipeline-runner | AC-BUNDLE-18 |
| 40 | A-T1 | 34966885 | `prds/archive/features/watcher-pane-recovery.md` | Atomic Tickets > T1 | Pane-level dead-watcher detection + respawn helper | AC-WPR-01, AC-WPR-02, AC-WPR-03, AC-WPR-06, AC-WPR-07 |
| 50 | A-T2 | 9d35f0da | `prds/archive/features/watcher-pane-recovery.md` | Atomic Tickets > T2 | Wire restartDeadWatcherPanes into ensureMonitorWindow | AC-WPR-04, AC-WPR-05 |
| 60 | A-T3 | e8892588 | `prds/archive/features/watcher-pane-recovery.md` | Atomic Tickets > T3 | Regression test ensure-monitor-window.test.js | AC-WPR-01, AC-WPR-02, AC-WPR-03, AC-WPR-07 |
| 70 | A-T4 | 1e16304a | `prds/archive/features/watcher-pane-recovery.md` | Atomic Tickets > T4 | Trap-door entry for restartDeadWatcherPanes | AC-BUNDLE-17 |
| 80 | B-T2 | 11c29665 | `prds/anatomy-park-followups.md` | Atomic Tickets > T2 | extension/tests/recoverable-json.test.js (≥6 cases) | AC-APF-B1, AC-APF-B2, AC-APF-B3 |
| 200 | C-T0 | 0971b9c9 | `prds/citadel.md` | Tasks > T0 | Citadel: Session-state schema migration | AC-CIT-01 |
| 210 | C-T1 | 2375b777 | `prds/citadel.md` | Tasks > T1 | Citadel: PRD ID parser | AC-CIT-02 |
| 215 | C-T2 | bbcee7b2 | `prds/citadel.md` | Tasks > T2 | Citadel: Diff walker | AC-CIT-03 |
| 220 | C-T3 | bd9c6306 | `prds/citadel.md` | Tasks > T3 | Citadel: AC coverage scorecard | AC-CIT-04 |
| 225 | C-T4 | 0a427622 | `prds/citadel.md` | Tasks > T4 | Citadel: Allowlist dead-entry detector | AC-CIT-05 |
| 228 | C-T5 | eb3266b4 | `prds/citadel.md` | Tasks > T5 | Citadel: Endpoint contract conformance | AC-CIT-06 |
| 230 | C-T6 | fdd79e0c | `prds/citadel.md` | Tasks > T6 | Citadel: Trap door coverage gate (presence + enforcement) | AC-CIT-07 |
| 235 | C-T7 | cdf93514 | `prds/citadel.md` | Tasks > T7 | Citadel: Sibling proxy-route divergence audit | AC-CIT-08 |
| 240 | C-T8 | 57bf4271 | `prds/citadel.md` | Tasks > T8 | Citadel: State-machine transition audit | AC-CIT-09 |
| 245 | C-T9 | e7a8735c | `prds/citadel.md` | Tasks > T9 | Citadel: Sibling auth/precondition audit + destructive-role lint | AC-CIT-10 |
| 248 | C-T10 | c20c8212 | `prds/citadel.md` | Tasks > T10 | Citadel: Frontend prop drift audit | AC-CIT-11 |
| 249 | C-T10.5 | e5cb3c81 | `prds/citadel.md` | Tasks > T10.5 | Citadel: Resource-module guard parity (cross-route) | AC-CIT-12 |
| 250 | NEW-T1 | 9f70b7b8 | `prd_refined.md` | New Refinement-Derived Tickets > NEW-T1 | citadel-cross-phase-fixture authoring | AC-BUNDLE-02 |
| 252 | C-T10.7 | c50012d4 | `prds/citadel.md` | Tasks > T10.7 | Citadel: Pattern-replay enforcement (overlap with anatomy-park) | AC-CIT-13 |
| 255 | C-T10.8 | 506ec618 | `prds/citadel.md` | Tasks > T10.8 | Citadel: Rule-set / state-machine invariant checker | AC-CIT-14 |
| 258 | C-T10.9 | 1a3d2733 | `prds/citadel.md` | Tasks > T10.9 | Citadel: Diff-shape / orphan-file gate (overlap with szechuan-sauce) | AC-CIT-15 |
| 260 | C-T11 | 5ecf8587 | `prds/citadel.md` | Tasks > T11 | Citadel: Divergence reconciliation reporter | AC-CIT-16 |
| 265 | C-T11.5 | 6d52dd64 | `prds/citadel.md` | Tasks > T11.5 | Citadel: (Optional) LLM-assisted entity extraction | — |
| 270 | C-T11.7 | 96a0bc84 | `prds/citadel.md` | Tasks > T11.7 | Citadel: AC-shape smell (overlap with /pickle-refine-prd) | AC-CIT-17 |
| 275 | C-T12 | adc4dc3f | `prds/citadel.md` | Tasks > T12 | Citadel: Findings ranker + JSON reporter | AC-CIT-18 |
| 280 | C-T13 | bcac9453 | `prds/citadel.md` | Tasks > T13 | Citadel: pipeline-runner integration | — |
| 285 | C-T14 | 6734d9b7 | `prds/citadel.md` | Tasks > T14 | Citadel: Slash command + help | — |
| 290 | C-T15 | 930a36ca | `prds/citadel.md` | Tasks > T15 | Citadel: Self-test fixtures | — |
| 295 | C-T16 | e2582e7e | `prds/citadel.md` | Tasks > T16 | Citadel: Pipeline regression smoke test | — |
| 300 | NEW-T2 | 3f555312 | `prd_refined.md` | New Refinement-Derived Tickets > NEW-T2 | v2→v3 state migration rollback path | AC-BUNDLE-16 |
| 320 | C-T17 | 9e0ef762 | `prds/citadel.md` | Tasks > T17 | Citadel: Refinement-time AC-verifiability + contract-resolution hard gate (BMAD P0) | AC-CIT-18 |
| 350 | NEW-T4 | cda355bd | `prd_refined.md` | New Refinement-Derived Tickets > NEW-T4 | Phase-ordered AC firing enforcement | AC-BUNDLE-15 |
| 370 | C-T20 | c6a66946 | `prds/citadel.md` | Cross-Skill Tasks > T20 | Cross-skill: /pickle-refine-prd AC-shape collapse-or-justify | AC-CIT-18 |
| 380 | C-T13.5 | 39602e28 | `prds/citadel.md` | Tasks > T13.5 | Citadel: /cronenberg integration | — |
| 390 | C-T21 | 1339b880 | `prds/citadel.md` | Cross-Skill Tasks > T21 | Cross-skill: anatomy-park phase-2 pattern-replay sweep | — |
| 400 | NEW-T6 | f474b5eb | `prd_refined.md` | New Refinement-Derived Tickets > NEW-T6 | Linear ticket integration (per-ticket lifecycle) | AC-BUNDLE-19 |
| 410 | C-T22 | 1965a31f | `prds/citadel.md` | Cross-Skill Tasks > T22 | Cross-skill: szechuan-sauce diff-hygiene gate | — |
| 420 | C-T23 | 10fc563a | `prds/citadel.md` | Cross-Skill Tasks > T23 | Cross-skill: szechuan-sauce trap-door-as-test enforcement sweep | — |
| 430 | BMAD-T01 | 27b85b2a | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T01) | BMAD: Promote findMissingPrefixes to artifact-validation.ts | — |
| 440 | BMAD-T02 | 62f1c225 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T02) | BMAD: Promote extractAssistantContent to classifier-utils.ts | — |
| 450 | BMAD-T03 | 889f08ec | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T03) | BMAD: Schema migration v2→v3 (all new fields) | — |
| 460 | BMAD-T04 | 37cd3580 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T04) | BMAD: check-readiness.ts with 5 alignment checks | — |
| 470 | BMAD-T05 | 5bb9d427 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T05) | BMAD: Wire P0 into 3 integration points + delta-mode | — |
| 480 | BMAD-T06 | aa1b91ce | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T06) | BMAD: /pickle-readiness --history + cycle cap | — |
| 490 | BMAD-T07 | 76872ae9 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T07) | BMAD: project-types.csv + project-type-classifier service | — |
| 500 | BMAD-T08 | 3df456f3 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T08) | BMAD: archaeology.ts bin + project-context.md schema | — |
| 510 | BMAD-T09 | 7363338c | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T09) | BMAD: Archaeology dual-path injection (subprocess + brief) | — |
| 520 | BMAD-T10 | ecf46d42 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T10) | BMAD: Archaeology auto-refresh + flags | — |
| 530 | BMAD-T11 | 9d919d9c | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T11) | BMAD: phase-personas.json + 6 agent-md files | — |
| 540 | BMAD-T12 | 99a795da | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T12) | BMAD: agent-md-loader service + .pickle-managed overlay + install migration | — |
| 550 | BMAD-T13 | 88eb1868 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T13) | BMAD: spawn-morty.ts persona injection (insertion order) | — |
| 560 | BMAD-T14 | 04fc9092 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T14) | BMAD: pickle.md Phase 3.B per-phase dispatcher | — |
| 570 | BMAD-T15 | 673c37af | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T15) | BMAD: PICKLE_PHASE_PERSONAS env flag + behavioral falsifiability | — |
| 580 | BMAD-T16 | 9d72a694 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T16) | BMAD: morty-course-corrector.md + correct-course.ts brief-prep | — |
| 590 | BMAD-T17 | ed66980f | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T17) | BMAD: transaction-ticket-ops service | — |
| 600 | BMAD-T18 | fc320a07 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T18) | BMAD: Composite lock + tickets_version fence + apply-ledger | — |
| 610 | BMAD-T19 | e7afe86b | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T19) | BMAD: --recover-from-ledger + --recover --force + CUJ-6 | — |
| 620 | BMAD-T20 | c96c2734 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T20) | BMAD: Structural confidence (4 predicates) + current_ticket invariants + circuit breaker | — |
| 630 | BMAD-T21 | 556f05e7 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T21) | BMAD: 4 debater agent-md files + generation script | — |
| 640 | BMAD-T22 | 7849f8ed | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T22) | BMAD: debate.ts brief-prep + pickle-debate.md orchestrator | — |
| 650 | BMAD-T23 | 7f8652ca | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T23) | BMAD: --solo + --strict-teams persistence + auto-promote | — |
| 660 | BMAD-T24 | d779369c | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T24) | BMAD: --continue multi-round + R29/R26 caps | — |
| 670 | BMAD-T25 | 5ccc48c2 | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T25) | BMAD: Hang guards (4 hang-guard tests) + Configuration Reference docs | — |
| 680 | BMAD-T26 | 039bef8a | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T26) | BMAD: Codex format pin smoke check (P0.10) | — |
| 690 | BMAD-T27 | fdc7a7bf | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T27) | BMAD: Calibration corpus governance + drift detection | — |
| 700 | BMAD-T28 | 3aa8484f | `prds/citadel.md` | Appendix Implementation Task Breakdown > (T28) | BMAD: Flag interaction matrix test | — |
| 800 | W | 8b781b76 | `prds/citadel.md` | How to Ship This | Wire all modules into working /citadel command + cross-skill integration | AC-BUNDLE-01, AC-BUNDLE-02 |
| 810 | H1 | 1c8ebc1c | `prds/citadel.md` | Implementation Guidance | Hardening: Code Quality review of feature area | AC-BUNDLE-17 |
| 820 | H2 | 9a32ec1a | `prds/citadel.md` | Implementation Guidance | Hardening: Data Flow integrity audit | AC-BUNDLE-03 |
| 830 | H3 | e8ea5e4a | `prds/citadel.md` | Implementation Guidance | Hardening: Test Quality review | — |
| 840 | H4 | 7091e9e1 | `prds/citadel.md` | Implementation Guidance | Hardening: Cross-Reference Consistency audit | AC-BUNDLE-04, AC-BUNDLE-17, AC-BUNDLE-19 |
