---
title: P2 Bug-Fix Bundle — B-DECOMP-SAT — decomposition satisfiability (R-DPMC-1)
status: APPROVED
priority: P2
filed: 2026-06-18
replanned: 2026-06-19
r_code_prefix: R-DPMC
backend_constraint: any
source_bug_report: prds/archive/bug-reports/BUG-REPORT-2026-06-18-decomp-nestjs-provider-module-coscope-deadlock.md
parent_thesis: prds/p1-design-simplification-and-autonomy-2026-06-13.md  # R-DSAN D1/D2/D3 — gate-creates-a-failure-mode + subtract-don't-add
peer_prds:
  shipped:
    - prds/archive/bundles/p1-design-ground-truth-2-completion-and-recovery-consolidation-2026-06-18.md  # B-GROUND2 — closed R-DPMC-2 (the orchestration/graduation half)
basis: 2026-06-18 codex-backend /pickle-pipeline on loanlight-api LOA-1359 (external repo); code-confirmed from worker logs; refined 2026-06-19 (3 analysts × 3 cycles)
---

# B-DECOMP-SAT — decomposition satisfiability

The **D4 "decomposition produces an unsatisfiable ticket"** class: `/pickle-refine-prd` cut a ticket
that forward-creates a NestJS provider its **same-ticket** controller consumes, but omitted the owning
`*.module.ts` from the ticket's file allowlist. Registering the provider requires editing the module's
`providers` array; the module was out of scope; the scope fence (correctly) blocked the edit → the
ticket `3829966b` was **unsatisfiable** → 9 worker respawns / 0 commits → terminated at 9/24.

**The fence is NOT the bug.** The per-file scope fence behaved exactly as designed. Do **NOT** loosen it.
The defect is upstream, at decomposition time: the ticket was cut without the registration site it
structurally needs. This is the `R-DSAN` D1 pattern — *a correct guard exposing a missing upstream
invariant* — so the honest fix is upstream co-scoping, **not** a second escape hatch around the fence.

## Scope (replanned 2026-06-19 after refinement)

**This bundle ships R-DPMC-1 only.** R-DPMC-2 already shipped in B-GROUND2 v2.0.0-beta.16. R-DPMC-3 is
**deferred to an evidenced fast-follow** (see the Deferred section below) — refinement proved it is not
the "pure subtraction" the original plan assumed but a *large additive guard* in the most-guarded file,
which contradicts this arc's explicit subtract-don't-add goal. R-DPMC-1 is the root-cause, subtraction-
aligned fix; it prevents the unsatisfiable tickets at the source, so R-DPMC-3's safety-net rarely fires.

## Ground truth (verified 2026-06-19, this repo, HEAD 2ba722c4 — 3-analyst consensus)

| Fact | Location | Implication |
|---|---|---|
| There is **no codified "co-location" rule** today | `extension/src/bin/spawn-refinement-team.ts` analyst prompts; `.claude/commands/pickle-refine-prd.md` Step 7a checklist (7 defect classes) | The bug report's "mirror the existing rule" is aspirational — the rule lives only in analyst judgment. R-DPMC-1 adds **one general rule** to the existing 7-class checklist, not a new mechanism. |
| `7-class` is a **frozen opaque token** | `AUDIT_COMMENT_RE = /<!--\s*audit:\s*7-class\s+checked\s+\d{4}-\d{2}-\d{2}\s*-->/` at `extension/src/bin/audit-ticket-bundle.ts:601`; the literal `7-class` appears at `:599`, `:611`, `:612` plus ~30 fixtures/tests | Add the new checklist row but do **NOT** renumber `7-class` → `8-class`. The coordinated rename across the regex + ~30 fixtures is explicitly OUT of scope and far larger than the feature. `7-class` becomes an accepted permanent misnomer. |
| Codegraph is default-on but the refiner does **not** import it; a forward-created symbol is **not in the graph yet** | `extension/src/services/codegraph-service.ts` (`searchNodes`/`getCallers`/`getImpactRadius`) | Graph-derivation would add machinery and has a feasibility gap for forward-created symbols. It is **OUT of scope** for this bundle (not a soft "deferred"). |

## Acceptance criteria — R-DPMC-1 (P1) registration co-location in decomposition

**Invariant:** *when a ticket forward-creates a "registerable" symbol — one whose usability requires
enrollment in a separate container/registry file (a NestJS `@Injectable()` provider, a Drizzle schema
table needing a `relations.ts` entry, a route handler needing a router registration) — AND a
**same-ticket** file consumes it, the ticket's file allowlist MUST include the registration site.*
State this as **one general coupling rule with a decidable recognition predicate**, not a per-framework
enumeration. NestJS-DI / Drizzle-`relations.ts` / router are **worked examples** of the one rule.

**Decidable predicate (must appear in the rule text so two analysts classify identically):** *"a symbol
imported or instantiated by a same-ticket file whose usability requires enrollment in a separate
container/registry file."*

**Changes:**
1. Add a **new failure-mode-checklist row** ("registration co-location") to the Step 7a table in
   `.claude/commands/pickle-refine-prd.md`, placed **above** the frozen `<!-- audit: 7-class checked … -->`
   token. Do NOT renumber the audit literal.
2. Add the same general rule (with the decidable predicate + worked examples) to the analyst prompt in
   `extension/src/bin/spawn-refinement-team.ts`.

**Verification (machine-checkable, deterministic):**
- A presence/structural test asserts the registration-coupling rule text (with its decidable predicate)
  is present in BOTH the analyst prompt and the Step 7a checklist. — Type: test
- A test asserts the Step 7a failure-mode checklist gained the new row AND that the `7-class` audit
  literal is unchanged (no `8-class` renumber regression). — Type: test
- `npx tsc --noEmit` + `eslint` clean; the compiled mirror `extension/bin/spawn-refinement-team.js`
  matches source. — Type: typecheck

**Efficacy note (advisory, not a deterministic gate):** an end-to-end "feed refinement a LOA-1359-shaped
fixture and assert the emitted allowlist includes the registration site" check is **llm-conformance**
(refinement is analyst-driven, non-deterministic) — it belongs in manual review, not the fast tier.
The deterministic floor is the presence/structural tests above.

**Out of scope for R-DPMC-1:** loosening the fence; renumbering `7-class`; per-framework enumeration;
a provider/registry parser; codegraph graph-assist (the forward-created symbol is not in the graph and
wiring codegraph into the refiner is new machinery — excluded).

## Deferred — R-DPMC-3 (evidenced fast-follow, NOT in beta.17)

Refinement (3 analysts × 3 cycles, 2026-06-19) proved R-DPMC-3 is **large additive machinery**, not the
"pure subtraction" the original plan assumed. It is deferred and will be revisited **only on evidence**
— i.e. if unsatisfiable-ticket deadlocks recur after R-DPMC-1 ships. The analysis is preserved here so
the fast-follow does not re-derive it:

- **Backend-split terminal mechanisms (4, verified at HEAD).** A no-progress In-Progress ticket is
  terminated by different mechanisms per backend: claude `executeBoundedEscape` (cap 3, `Skipped`,
  gated `!= codex_session_inactive`); **codex** `checkAndUpdateCodexManagerNoProgress` (cap 2, **HALTS
  the whole pipeline** — and LOA-1359 was codex, so this is the actual "stall-all" symptom); the
  per-ticket circuit breaker (`CIRCUIT_BREAKER_TIER_BUDGETS = {trivial:3, small:4, medium:5, large:12}`,
  the surface common to both backends); WMW oversized (artifact-keyed, never climbed in the incident).
- **`PICKLE_WMW_SKIP_K`=5 is provably defeated** — it ties the medium breaker (5) and loses to
  trivial(3)/small(4), so the D4 class stays unfixed for 3 of 4 tiers. A correct threshold is N < 2
  **with** backend-agnostic pre-emption ordering (evaluate before the codex cap-2 halt and the breaker
  record), via a new env `PICKLE_SCOPE_FENCE_SKIP_K`.
- **"same-path" deadlocks** on multi-site unsatisfiable tickets (oscillates A→B→A); must be path-agnostic
  (count any `worker_edit_outside_scope` on a zero-commit spawn, reset on commit, record the union).
- **Net-new cross-sink reader required** — `worker_edit_outside_scope` lands only in the JSONL day-file
  sink (`getActivityDir()/<date>.jsonl`), NOT `state.activity`; no orchestrator code reads it today.
  A correlation reader (filter by `ticket_id`, handle midnight date-rollover) is 100% net-new.
- **Silent-graduation hazard.** A 0-commit `Skipped` finalizes cleanly (`findPendingNonCurrentTickets`
  excludes `skipped`); R-DPMC-2 does NOT catch it (it guards the breaker-terminated path). So R-DPMC-3
  would **trade a loud, R-DPMC-2-caught failure for a quiet skip** that then needs a loud
  `pickle_ticket_skipped_unsatisfiable` event + `manager_handoff` enrichment to stay safe.

**Why deferred:** building a 5th disposition mechanism ordered ahead of 4 backend-split guards in
`mux-runner.ts` (the most-guarded file) is the "gate seams instead of reducing them" accretion this arc
exists to remove. Current behavior without R-DPMC-3 is *safe* (loud failure, caught by R-DPMC-2).
R-DPMC-1 removes the upstream cause. Reliability-first + subtract-don't-add ⇒ ship R-DPMC-1, defer the
safety-net to an evidenced fast-follow.

## Simplification Review (subtract-before-add)

1. **Necessary at all?** R-DPMC-1 is the root-cause fix — a decomposition heuristic in an existing
   prompt/checklist, no new runtime gate, flag, or state-field. Necessary and minimal. R-DPMC-3
   (deferred) was the only net-new runtime machinery; deferring it is the subtraction.
2. **Reuse not add?** R-DPMC-1 extends the **existing** 7-class checklist + analyst prompt with **one
   general rule** — deliberately not a per-framework list (the operator-named anti-pattern). No parallel
   mechanism, no new module, no new event.
3. **Guards existing brittle complexity?** The fence is correct, so "loosen the false-blocking gate"
   does not apply — the fix is the upstream invariant the fence exposed. We explicitly **declined** to
   add the R-DPMC-3 guard (which would have been a guard creating the need for more guards).
4. **What can this SUBTRACT?** R-DPMC-1 subtracts a class of unsatisfiable tickets at the source (fewer
   respawn loops, fewer breaker trips, fewer babysitter recoveries). Deferring R-DPMC-3 subtracts a
   whole would-be 5th terminal mechanism + cross-sink reader + new event from this arc. Net: the bundle
   leaves the system flatter, not deeper.

## Cross-links
- Source: `prds/archive/bug-reports/BUG-REPORT-2026-06-18-decomp-nestjs-provider-module-coscope-deadlock.md`
- R-DPMC-2 (shipped): `prds/archive/bundles/p1-design-ground-truth-2-completion-and-recovery-consolidation-2026-06-18.md`
- Refinement analyses: session `2026-06-19-0a2b98af` (`refinement/analysis_{requirements,codebase,risk-scope}_c3.md`)
- Design thesis: `feedback_analyze_failures_then_subtract_not_add_guards` (one mechanism not a growing list; collapse seams don't gate them); `feedback_release_reliability_first_capability_second` (reliability GA, capability fast-follow)
