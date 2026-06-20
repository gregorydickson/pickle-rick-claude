---
backend: codex-required
bundle: true
target_release: v1.63.0
refined_at: 2026-04-30T20:30:00Z
refinement_session: /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-04-30-bc104e78
all_success: false
---

# PRD (REFINED): Overnight Bug Bundle — Verified-Unshipped Scope Only

**Status**: Refined manifest (2026-04-30 PM) — trimmed after refinement-team grep audit found 5 of 6 sub-bundles partially or fully shipped in v1.62.0/.1/.2.

**Pre-refinement preserved at**: `${SESSION_ROOT}/prd.md` (the original 24-ticket bundle).

---

## Refinement Verdict — what changed and why

The original manifest assumed the 6 source PRDs were all open work. Grep against HEAD c07c757 found this is wrong:

### DROPPED (already shipped — no work)

| Sub-bundle | Evidence at HEAD | Verdict |
|---|---|---|
| **WPR** (4 tickets) | `extension/tests/ensure-monitor-window.test.js` exists (31K, written 2026-04-30) | DROP entire sub-bundle — including T1 helper, T2 wire, T3 regression, T4 trap-door |
| **APF-AB Sub-fix B** (recoverable-json tests) | `extension/tests/recoverable-json.test.js` exists (6.8K, ≥9 tests) | DROP |
| **MRD T1** (`classifyTicketCompletion`) | `extension/src/bin/mux-runner.ts:274` exports it; `:1846` calls it | DROP |
| **MRD T2** (`working_dir` field on TicketInfo) | `extension/src/services/pickle-utils.ts:250, 322` | DROP |
| **MRD T3** (`multi_repo_warning` event) | `extension/src/types/index.ts:328` | DROP |
| **MRD T4** (`markTicketSkipped`, `[!]` symbol) | `pickle-utils.ts:213, 347` | DROP |
| **APH F6** (`convergence_mode` field) | `types/index.ts:536` | DROP |
| **APH F1 partial** (`writeFinalReport` `hasHistory` guard) | `microverse-runner.ts:1043` `const hasHistory = state.convergence?.history?.length > 0;` | DROP F1 specifically |

### KEPT — verified unshipped or partially-shipped

| Sub-bundle | What's missing | New ticket |
|---|---|---|
| **APH residual** | 5 bare `.convergence.history` sites still throw on worker-mode (`microverse-runner.ts:859, 890, 938, 1022, 1216`); `markMicroverseFatalError:1699` hardcodes `exit_reason='error'` (F5 unshipped); F8 lint rule absent; AC-APH-01..05 + AC-APH-06 test files missing | T1 |
| **APF-C** | `extension/src/services/codex-manager-relaunch.ts` does not exist; `microverse-runner.ts` lacks the relaunch wiring | T2 |
| **LTS T-A** | `getCircuitBreakerBudget` not in `mux-runner.ts`; `current_ticket_tier` / `current_ticket_budget` not on State type | T3 |
| **LTS T-B** | `Resume Detection` block absent from `send-to-morty.md` | T4 |
| **MRS** (all 4 ACs) | No "Recent Changes" section in `buildMicroverseHandoff`; no `classifyNoCommitExit`; no gap analysis refresh; no amnesiac breaker | T5 |
| **APF-A** catalog hygiene | `extension/CLAUDE.md` is 139 lines — needs entry-size audit (originally claimed 56 entries with 3 oversized) | T6 |

### NEW (refiner-derived corrections)

| Ticket | Source AC | Reason |
|---|---|---|
| **OBB-test-floor-aggregator** | AC-OBB-08 | Bundle's static "≥3404+N" floor invalidated by phantom-work; replace with refinement-time baseline + scheduled-ticket deltas | T7 |
| **OBB-trap-door-conformance** | AC-OBB-07 (broadened) | Parametrized check over `git diff` hunks vs added-entries-only; covers edits per Risk Analyst cycle 3 | T8 |
| **OBB-symbol-audit** | AC-OBB-16 (NEW) | Refiner cycle 3 found 7 phantom symbols in 3 cycles of analyst output; mechanical refinement-time audit needed | T9 |

### NON-PROMOTED items (deferred / not in this bundle)

- **AC-OBB-12** bundle summary roundtrip — drop to nice-to-have; bundle close summary stays prose-only for v1.63.0
- **APH F7** `init-microverse.ts` populating `convergence_mode` from `--convergence-mode` flag — fold into T1 if cheap; otherwise defer
- **MRD** Sub-bundle as a whole — 4/4 source tickets shipped; sub-bundle removed

---

## Bundle-Level ACs (revised — only what survives)

- **AC-OBB-A** All 5 remaining bare `.convergence.history` sites in `microverse-runner.ts` are guarded OR confirmed unreachable in worker mode (T1 deliverable)
- **AC-OBB-B** `markMicroverseFatalError` does not overwrite a successful `exit_reason` (T1)
- **AC-OBB-C** `codex-manager-relaunch.ts` is the single source of truth — `mux-runner.ts` and `microverse-runner.ts` both import it; no copy-paste duplication (T2)
- **AC-OBB-D** Tier-aware circuit-breaker budget honors `complexity_tier` from ticket frontmatter; cached on state; trip log includes tier+budget (T3)
- **AC-OBB-E** Worker prompt Resume Detection block routes to correct lifecycle step based on artifacts on disk; stale-mtime guard fires (T4)
- **AC-OBB-F** Microverse handoff includes recent commit context; `classifyNoCommitExit` distinguishes clean_pass / stall / amnesiac; gap analysis refreshed on accept (T5)
- **AC-OBB-G** `extension/CLAUDE.md` trap-door entries audited; oversized entries split; ENFORCE clauses name `.test.js` files (T6)
- **AC-OBB-H** Bundle close emits a per-sub-bundle test-delta count and asserts `total_delta >= refinement_baseline` (T7)
- **AC-OBB-I** Parametrized trap-door conformance lint over `git diff v1.62.2..HEAD -- extension/CLAUDE.md` (T8)
- **AC-OBB-J** Refiner emits `symbol_audit.md` validating activity-events, exit codes, file paths, helpers (T9)
- **AC-OBB-K** Bundle's own anatomy-park phase converges cleanly — proves T1 fix end-to-end via dogfooding
- **AC-OBB-L** Bundle's szechuan-sauce phase reaches Phase 3 — proves pipeline-runner advances past anatomy-park
- **AC-OBB-M** Single version bump v1.62.2 → v1.63.0 at bundle close
- **AC-OBB-N** `tsc --noEmit` clean, `eslint --max-warnings=-1` clean, `npm test` green at bundle close

---

## Implementation Task Breakdown

| Order | ID | Title | Tier | Files | AC |
|---|---|---|---|---|---|
| 10 | T1 | APH residual: guard remaining `.convergence.history` sites + F5 success-preserve + F8 lint + 2 test files | large | `microverse-runner.ts`, `eslint-plugin-pickle/index.js`, 2 new test files | AC-OBB-A,B |
| 20 | T2 | APF-C: extract `codex-manager-relaunch.ts` + wire microverse-runner | medium | new `services/codex-manager-relaunch.ts`, `mux-runner.ts`, `microverse-runner.ts`, `microverse.test.js`, new `codex-manager-relaunch.test.js` | AC-OBB-C |
| 30 | T3 | LTS T-A: tier-aware circuit-breaker budget | medium | `mux-runner.ts`, `types/index.ts`, new `mux-runner-circuit-breaker.test.js` | AC-OBB-D |
| 40 | T4 | LTS T-B: Resume Detection block in send-to-morty + review | medium | `.claude/commands/send-to-morty.md`, `.claude/commands/send-to-morty-review.md`, new `send-to-morty-resume.test.js` | AC-OBB-E |
| 50 | T5 | MRS: stall resilience (handoff commits + classifyNoCommitExit + gap refresh + amnesiac breaker) | large | `microverse-runner.ts`, `microverse-state.ts`, microverse tests | AC-OBB-F |
| 60 | T6 | APF-A: trap-door catalog hygiene audit | small | `extension/CLAUDE.md` | AC-OBB-G |
| 70 | T7 | OBB-test-floor-aggregator: dynamic baseline + delta floor | small | new `bundle-test-floor.test.js` | AC-OBB-H |
| 80 | T8 | OBB-trap-door-conformance: parametrized lint over git diff | small | new `trap-door-conformance.test.js` | AC-OBB-I |
| 90 | T9 | OBB-symbol-audit: refinement-time mechanical identifier audit | small | new `refinement-symbol-audit.test.js`, `spawn-refinement-team.ts` (audit step) | AC-OBB-J |

**9 tickets total.** No wiring ticket — these are independent atomic fixes (skip gate from skill: applied for library-style projects). No hardening tickets — bundle exit gate via AC-OBB-K..N covers cross-cutting verification at finalize-time.

---

## Sequencing

Linear order. T1 first (P0 finalizer crash residual). T2 second (extracts shared helper before T3 edits the same file). T3 next (tier budgets help T5 land — large tier). T4 next (worker prompt change). T5 (microverse stall — independent of T1's microverse-runner edits because T1 only adds defensive guards). T6 (catalog hygiene). T7-T9 (refinement infrastructure improvements).

No hard fence required — most file overlaps avoided by the trim. T1 + T2 + T5 all touch `microverse-runner.ts`; sequence T1→T2→T5 in linear order so each rebases forward cleanly.

---

## Backend / Resources

- **Backend**: codex (per manifest frontmatter `backend: codex-required`)
- **CAP**: 10 (already raised in `932ac54`)
- **max_iterations**: 500
- **max_time_minutes**: 720 (sized at 9 tickets × ~40m avg ≈ 6h on codex)
- **worker_timeout**: 1200s
- **Phases**: pickle → anatomy-park → szechuan-sauce
