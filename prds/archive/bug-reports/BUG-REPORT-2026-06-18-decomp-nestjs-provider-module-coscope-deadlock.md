# BUG REPORT 2026-06-18 — refine-prd decomposition omits the NestJS module file from a ticket that adds a provider → scope-fence deadlock → silent build truncation

**Finding:** R-DPMC (decomp provider/module co-scope). **Reporter:** operator babysitting `/pickle-pipeline --backend codex` on an external app repo (loanlight-api, ticket LOA-1359 credit rule-authoring + production-eval; **NOT** pickle-rick-claude). **Severity as reported:** P1 — a single unsatisfiable ticket silently stranded 14/24 tickets (the entire frontend + tests + wiring + 4 hardening) and the pipeline advanced to anatomy-park on the partial without flagging it.

## Symptom signature

- Build phase ran cleanly to **9/24 Done**, then ticket `3829966b` (order 100: "credit split-drafts table 0174 + service + 4 endpoints") went `InProgress` and **never produced `conformance_*.md` / `code_review_*.md`** — it cleared research + plan (plan `APPROVED`) but **implementation never landed a commit**.
- **9 worker respawns** for that one ticket (`worker_session_{17088,18287,26894,40282,47321,50193,59979,96563,98239}.log`) across iterations **39→46**, zero commit progress → **`Circuit breaker tripped: No progress in 5 iterations (tier: medium, budget: 5)`** (`mux-runner.log` 18:17:48Z) → `mux-runner finished. 46 iterations`.
- `pipeline-runner` then **advanced to PHASE anatomy-park** on the 9/24 partial (already committed a HIGH fix), with **no distinct "build incomplete / 14 tickets Todo" alert**. Operator only caught it via the babysitter ticket-count check.

## Root cause (code-confirmed from the worker logs)

The ticket's `Files to modify/create` allowlist named **5 files** — the migration, `_journal.json`, the new schema file, the new service file, and `portal-credit-rules.controller.ts` — but **omitted `portal-credit-rules.module.ts`**. Registering a new NestJS injectable (`CreditSplitDraftsService`) so the **same-ticket controller** can inject it **requires** editing the module's `providers` array. The recurring worker note (×7 across respawns):

> "Nest DI wiring for a real provider cannot be completed inside this ticket because `packages/api/src/modules/portal-credit-rules/portal-credit-rules.module.ts` is out of scope and still contains a local stub provider."

The scope fence (`check-scope-diff.ts` preflight + the R-PIPE-4 prompt fence) **correctly** blocked the out-of-scope module edit (9× `SCOPE FENCE` / `SCOPE_VIOLATION` hits). The result was an **unsatisfiable ticket**: the controller cannot typecheck/wire its endpoints without the provider, the provider cannot be registered without the module, and the module is fenced out. The worker faithfully kept inside scope and could never reach `I AM DONE` → respawn loop → circuit breaker.

This is the **same trap-door class** as the existing "FK target change requires a *simultaneous* `relations.ts` edit" co-location rule (loan-programs-decoupling trap door), but for NestJS DI: **a new provider + its same-ticket consumer + the module that wires them must be co-scoped in one ticket.** The decomposer instead deferred all DI registration to a separate downstream wiring ticket (`7ba3a97f`, order 200), which makes every intermediate per-service ticket unsatisfiable under the fence.

(Adjacent evidence the decomposition under-scoped DI generally: the preview ticket `9c4a3d31` shipped a **stub provider** in the module, and `3829966b` then inherited the unresolved stub — confirming the module was treated as out-of-scope across the per-service tickets.)

## Two distinct findings

- **R-DPMC-1 (primary, decomposition).** `/pickle-refine-prd` Step 7 / `spawn-refinement-team` must apply a **DI co-location rule**: when a ticket introduces a NestJS `@Injectable()` that a controller/service *in the same ticket* consumes, the ticket's file allowlist MUST include the owning `*.module.ts` (provider registration). Deferring provider registration to a later "wiring" ticket strands the per-service ticket behind the scope fence. Mirror the existing schema↔`relations.ts` co-location guidance.
- **R-DPMC-2 (secondary, orchestration).** Circuit-breaker termination of the pickle phase advanced the pipeline to the next phase (anatomy-park) with **14/24 tickets still `Todo`**, surfacing no distinct "build incomplete" signal to the operator. A stalled/breaker-terminated build phase should not silently graduate to review/deslop as if complete. **Likely the same class as the existing `AC-R-PRESUME-1` false-completion guard** (`BUG-REPORT-2026-06-18-pipeline-unresumable-after-partial-completion.md`) — cross-reference, don't duplicate.

## Proposed fix (capture-only — not implemented)

- [ ] **AC-R-DPMC-1 — DI co-location in decomposition (P1).** Extend the refiner's co-location heuristic (the schema↔`relations.ts` rule) so a ticket that forward-creates a NestJS provider consumed by a same-ticket controller auto-includes the owning `*.module.ts` in its allowlist. Add a decomposition failure-mode-checklist row ("provider added but module not co-scoped"). — Type: test
- [ ] **AC-R-DPMC-2 — breaker-terminated build must not silently graduate (P1).** Before `pipeline-runner` advances past the pickle phase, if the breaker tripped with non-`Done`/`Skipped` tickets remaining, emit a distinct `pickle_phase_incomplete` halt/alert (count of unbuilt tickets) rather than proceeding to anatomy-park as if the phase completed. Reuse the `reconcileTicketTruth` / `AC-R-PRESUME-1` machinery if it lands first. — Type: integration
- [ ] **AC-R-DPMC-3 — unsatisfiable-ticket fast-fail (P2).** When a ticket records ≥N consecutive scope-fence blocks on the *same* out-of-scope path with zero commits, mark it `Skipped` with `scope_fence_blocks_required_path:<path>` and continue to the next ticket instead of burning the whole breaker budget on one deadlocked ticket (fail-one, not stall-all). — Type: integration

## Repro
External-repo decomposition (codex backend) where a ticket adds a NestJS service + its controller endpoints but lists the controller (not the module) in the allowlist; the scope fence blocks the `*.module.ts` provider edit; worker respawns until the medium-tier breaker (budget 5) trips. Session artifacts: `~/.local/share/pickle-rick/sessions/2026-06-18-31cdca19/3829966b/` (9 `worker_session_*.log`, no `conformance_*.md`).

## Simplification Review (subtract-before-add)

1. **Necessary at all?** AC-1 is a decomposition-heuristic change (no new runtime gate) — necessary; it's the root cause. AC-2 adds a guard but should REUSE the `AC-R-PRESUME-1` false-completion machinery. AC-3 is the only net-new runtime branch and is optional/P2.
2. **Reuse not add?** YES — AC-1 extends the **existing** schema↔`relations.ts` co-location rule rather than inventing a new mechanism. AC-2 reuses `reconcileTicketTruth` / the `AC-R-PRESUME-1` guard (do not build a parallel completeness checker). AC-3 reuses the existing `Skipped` + `scope_fence_unclear` precedent (a sibling reason code, not new state machinery).
3. **Guards existing brittle complexity?** The scope fence is **not** brittle here — it behaved correctly. The defect is upstream (decomposition under-scoped the ticket). Do **NOT** loosen the fence to "fix" this; that would re-open the cross-ticket-contamination class the fence exists to prevent. The honest fix is correct co-scoping at decomposition time.
4. **What can this SUBTRACT?** AC-3 SUBTRACTS the "one deadlocked ticket consumes the entire breaker budget and strands all downstream work" failure mode (fail-one replaces stall-all). AC-1 SUBTRACTS a class of unsatisfiable tickets at the source. No flag/state-field additions required for AC-1/AC-2.

## Cross-links
- Sibling: `BUG-REPORT-2026-06-18-pipeline-unresumable-after-partial-completion.md` (`AC-R-PRESUME-1` false-completion guard) — AC-R-DPMC-2 is the same theme (don't terminal/graduate on pending tickets).
- Trap-door analog: schema↔`relations.ts` simultaneous-edit co-location (loan-programs-decoupling); R-DPMC-1 is its NestJS-DI counterpart.
- Scope fence: `check-scope-diff.ts` preflight + R-PIPE-4 prompt fence (behaved correctly — not the bug).
- Operator workaround used this run: none yet (build left at 9/24; awaiting decision to retry `3829966b` with `portal-credit-rules.module.ts` added to scope + complete the remaining 14).
