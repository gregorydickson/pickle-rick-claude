# PRD: God Function Remediation — Phase 2 (non-T-tickets)

**Status**: Draft (2026-04-28)
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Predecessor**: `prds/archive/bundles/god-functions-remediation.md` (Phase 1, T0–T15) — shipped autonomously by codex on 2026-04-28 across ~9.5K LOC of refactor diff. See MASTER_PLAN §1.

---

## Problem

T14 of the Phase 1 epic ("Epic closer") promoted the ESLint `complexity` (max 15) and `max-lines-per-function` (max 120) rules from **warning** to **error**. The ratchet exposed **34 violations in 27 functions across 24 files** that were OUTSIDE the Phase 1 refactor scope. These are pre-existing god-functions — they were already over the ceiling before this session, just hidden by the lower severity.

Commit `7bf3263 chore(lint): add eslint-disable carve-outs for 27 pre-existing god-functions` landed scoped `// eslint-disable-next-line complexity[, max-lines-per-function]` annotations directly above each offending function with the justification *"pre-existing — outside T0–T15 god-fn refactor scope; defer to follow-up epic"*. That unblocked the green gate and let v1.59.x ship, but it deliberately punted the actual remediation.

This PRD is that follow-up epic.

---

## Scope

The 27 functions, ordered by severity (highest complexity first). Each row points to the existing `eslint-disable-next-line` annotation that this epic must remove after refactoring.

| # | File | Line | Function | Cyclomatic | Lines | Severity |
|---|---|---|---|---|---|---|
| 1 | `services/convergence-gate.ts` | 503 | `runGate` | **65** | **305** | CRITICAL |
| 2 | `bin/monitor.ts` | 288 | `render` | 40 | 124 | HIGH |
| 3 | `bin/standup.ts` | 280 | `formatOutput` | 39 | 131 | HIGH |
| 4 | `bin/finalize-gate.ts` | 120 | `finalizeGateMain` | 36 | 162 | HIGH |
| 5 | `bin/council-publish.ts` | 258 | `publishCouncilStack` | 30 | 199 | HIGH |
| 6 | `bin/check-gate.ts` | 43 | `checkGateMain` | 30 | — | HIGH |
| 7 | `bin/spawn-gate-remediator.ts` | 148 | `spawnGateRemediatorMain` | 28 | 127 | HIGH |
| 8 | `lib/context-key-matrix.ts` | 16 | `buildContextKeyMatrix` | 28 | — | HIGH |
| 9 | `bin/refinement-watcher.ts` | 63 | `main` | 27 | — | HIGH |
| 10 | `bin/log-watcher.ts` | 30 | `processLine` | 26 | — | HIGH |
| 11 | `bin/raw-morty.ts` | 70 | `processLineRaw` | 26 | — | HIGH |
| 12 | `hooks/dispatch.ts` | 51 | `main` | 24 | 134 | HIGH |
| 13 | `bin/monitor.ts` | 16 | `summarizeLine` | 23 | — | MEDIUM |
| 14 | `lib/diamond-routing.ts` | 87 | `buildDiamondRouting` | 22 | — | MEDIUM |
| 15 | `hooks/handlers/config-protection.ts` | 60 | `main` | 22 | — | MEDIUM |
| 16 | `services/circuit-breaker.ts` | 175 | `initCircuitBreaker` | 21 | — | MEDIUM |
| 17 | `services/metrics-utils.ts` | 240 | `scanSessionFiles` | 21 | — | MEDIUM |
| 18 | `services/microverse-state.ts` | 20 | `readRecoverableJsonObject` | 21 | — | MEDIUM |
| 19 | `lib/tarjan-scc.ts` | 98 | `detectConvergenceSignal` | 21 | — | MEDIUM |
| 20 | `services/council-schema.ts` | 240 | `validateSubagentPayload` | 19 | — | MEDIUM |
| 21 | `services/microverse-state.ts` | 193 | `classifyFailure` | 17 | — | MEDIUM |
| 22 | `bin/monitor.ts` | 149 | `buildTicketLines` | 17 | — | MEDIUM |
| 23 | `bin/log-commit.ts` | 19 | `main` | 16 | — | LOW |
| 24 | `bin/retry-ticket.ts` | 10 | `retryTicket` | 16 | — | LOW |
| 25 | `bin/status.ts` | 10 | `showStatus` | 16 | — | LOW |
| 26 | `lib/tarjan-scc.ts` | 145 | `buildCycles` | 16 | — | LOW |
| 27 | `scripts/check-scope-schema-parity.ts` | 9 | `deepEqual` | 16 | — | LOW |
| 28 | `bin/microverse-runner.ts` | 870 | `buildMicroverseHandoff` | 16 | — | LOW |
| 29 | `bin/microverse-runner.ts` | 1290 | `measureAndClassifyIteration` | 17 | — | LOW |

Total: 29 functions, 24 files, ~3,500–5,000 LOC of touched code (estimated based on average function size).

Rows 28-29 added 2026-05-01 — surfaced by the v1.64.0 release-gate run. Both functions grew past the cyclomatic ceiling during the v1.63.0 overnight bundle (commits `c5cdb6e` codex-relaunch extraction and `53948c0` stall-resilience routing). Defer to phase-2 — they ride along with the existing microverse-runner extraction work in T10–T19's medium/low grouping.

---

## Solution Approach (mirrors Phase 1)

Same playbook that worked for T0–T15:

1. **Atomic PRs / tickets**: one extraction per ticket. Aim for ≤5 helpers per god-function, all named, signature-pre-declared in the ticket body.
2. **Discriminated unions over booleans** (per Phase 1 helper-signature spec rule). No `Ref<T>` mutations.
3. **Per-ticket `min_new_tests`**: nontrivial extractions get a minimum test count (e.g. CRITICAL = 6+, HIGH = 3+, MEDIUM = 2+, LOW = 1+).
4. **Trap-door preservation**: extension/CLAUDE.md lists invariants for several of the targeted files (`monitor.ts`, `metrics-utils.ts`, `microverse-state.ts`, `circuit-breaker.ts`). Those invariants must hold post-refactor. ENFORCE via existing regression tests.
5. **Carve-out removal**: each ticket's done condition is `eslint passes WITHOUT the existing eslint-disable annotation in that file/function` — the pre-existing carve-out gets DELETED, not preserved.
6. **Phase 2 closer ticket**: similar to Phase 1's T14 — verify ESLint passes with zero carve-outs across the 27 sites.

---

## Acceptance Criteria

- **AC-GFR2-01** All 27 `eslint-disable-next-line complexity[, max-lines-per-function]` annotations introduced by commit `7bf3263` are deleted; ESLint still passes (`npx eslint src/ --max-warnings=-1`) with `0 errors`.
- **AC-GFR2-02** No new carve-outs introduced. Helper functions also stay under the ceilings (cyclomatic ≤ 15, lines ≤ 120). Per master plan §6 rule 12: files may grow 5–15% from helper boilerplate; that's allowed.
- **AC-GFR2-03** Behavioral parity: every god-function's pre-refactor behavior preserved. Verified by both existing tests (no regressions) and per-ticket new tests (`min_new_tests`).
- **AC-GFR2-04** Trap-door invariants in `extension/CLAUDE.md` for the touched files still hold; the catalog is updated where helper names need to change.
- **AC-GFR2-05** Test gate green: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test`. No drop in test count.
- **AC-GFR2-06** Single version bump at the closer ticket — minor (e.g. v1.61.0 if v1.60.x has been tagged).

## Non-goals

- Refactoring functions that already comply with the ceilings.
- Changing the cyclomatic-15 / max-lines-120 rule values themselves.
- Removing `pickle/no-sync-in-async` warnings (separate concern; advisory).
- Bundling a large rewrite of `runGate` (the worst offender) with adjacent logic changes — extraction must stay pure.

---

## Atomic Tickets (proposed groupings)

Refinement (`/pickle-refine-prd`) will produce the final ticket breakdown. Initial sketch:

### Critical (1 ticket, large-tier)

- **T1 — Split `runGate`** (`services/convergence-gate.ts:503`, complexity 65, 305 LOC). The 800-pound gorilla. Plan ~8–12 helpers covering: command spec resolution, baseline/current measurement, scope filtering, regression classification, finalize logging, and result struct assembly. **min_new_tests: 8**.

### High (8 tickets, large-tier)

- **T2 — Split `render`** in `bin/monitor.ts:288` (dashboard layout). **min_new_tests: 5**.
- **T3 — Split `formatOutput`** in `bin/standup.ts:280` (standup formatting). **min_new_tests: 5**.
- **T4 — Split `finalizeGateMain`** in `bin/finalize-gate.ts:120` (gate orchestrator). **min_new_tests: 4**. Touches a trap-door (synthetic-failure scope handling); preserve.
- **T5 — Split `publishCouncilStack`** in `bin/council-publish.ts:258` (council publisher). **min_new_tests: 5**. Trap-door: gh timeout invariants must hold.
- **T6 — Split `checkGateMain`** in `bin/check-gate.ts:43`. **min_new_tests: 3**.
- **T7 — Split `spawnGateRemediatorMain`** in `bin/spawn-gate-remediator.ts:148`. **min_new_tests: 3**.
- **T8 — Split `buildContextKeyMatrix`** in `lib/context-key-matrix.ts:16`. **min_new_tests: 3**.
- **T9 — Split `dispatch.ts main`** + `config-protection.ts main` (both small-but-tangled hook entry points). **min_new_tests: 4** combined.

### Medium / Low (≈10 tickets, small-tier)

- **T10–T19** — bundle the remaining ≤25-complexity functions into 2–3 small-tier tickets (group by domain: monitor helpers, scope/parity helpers, microverse-state helpers, tarjan-scc helpers, log/raw watchers, retry/log-commit/status). Each ticket extracts 1–2 helpers per function. **min_new_tests: 1–2** per function.

### Closer

- **T20 — Phase 2 closer**: verify all 27 carve-outs are gone, gate is green, version bumped. Trivial-tier, **min_new_tests: 0**.

Final atomic ticket count, types, and helper signatures land in `/pickle-refine-prd` output.

---

## Verification Plan

1. **Per-ticket gate** (same as Phase 1):
   ```bash
   cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test
   ```
2. **Carve-out removal proof**: each ticket's diff includes the deletion of the `// eslint-disable-next-line ...` line that protects its target function. Grep proof: `grep -c "eslint-disable-next-line.*outside T0–T15"` decreases by exactly 1 per ticket (or by the count of removed carve-outs in that file).
3. **Trap-door regression replay**: run all existing `*.test.js` files that touch the affected modules — no regressions.
4. **Final closer**: zero carve-outs match the marker string. ESLint config left at `error` severity.

---

## Files Likely Touched (deep diff scope)

```
extension/src/services/convergence-gate.ts          # T1 (largest)
extension/src/bin/monitor.ts                        # T2 + medium tickets
extension/src/bin/standup.ts                        # T3
extension/src/bin/finalize-gate.ts                  # T4
extension/src/bin/council-publish.ts                # T5
extension/src/bin/check-gate.ts                     # T6
extension/src/bin/spawn-gate-remediator.ts          # T7
extension/src/lib/context-key-matrix.ts             # T8
extension/src/hooks/dispatch.ts                     # T9
extension/src/hooks/handlers/config-protection.ts   # T9
extension/src/lib/diamond-routing.ts
extension/src/lib/tarjan-scc.ts
extension/src/services/circuit-breaker.ts
extension/src/services/metrics-utils.ts
extension/src/services/microverse-state.ts
extension/src/services/council-schema.ts
extension/src/bin/refinement-watcher.ts
extension/src/bin/log-watcher.ts
extension/src/bin/raw-morty.ts
extension/src/bin/log-commit.ts
extension/src/bin/retry-ticket.ts
extension/src/bin/status.ts
extension/src/scripts/check-scope-schema-parity.ts
extension/CLAUDE.md                                 # trap-door catalog updates per T1, T4, T5
```

Plus new test files per ticket; Phase 1 averaged ~80 LOC of new tests per large-tier ticket and ~50 per medium/small.

---

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | `runGate` (T1, complexity 65) is too large to refactor in one ticket without behavioral drift | Phase 1 successfully refactored similarly-large functions on codex backend with the v1.59.x stall hardening; same machinery applies here. If T1 stalls, split into T1a (command/scope resolution) + T1b (measurement/classification) + T1c (finalize) before refinement |
| R2 | Touching trap-door files (`finalize-gate.ts`, `council-publish.ts`, `monitor.ts`) breaks invariants | Refactor must preserve trap-door enforcement points; existing tests cover them; add targeted regression tests per ticket |
| R3 | Helper extraction inflates files by >15% (master plan §6 rule 12 ceiling) | Acceptable up to 15%; if a file blows past, split helpers into a sibling module instead of inline |
| R4 | T20 closer can't find the marker text because formatting drifted | Use a precise grep (`eslint-disable-next-line.*outside T0–T15`) and document the exact phrase as the closer's verification |
| R5 | Codex backend stalls on a CRITICAL / HIGH ticket | Use `--effort high` for those; the v1.59.x relaunch path now handles 4h subprocess error gracefully |
| R6 | Future code reintroduces a complexity violation under cover of a fresh carve-out | Phase 2 closer adds an ESLint config override that **forbids `eslint-disable-next-line complexity` justifications matching `outside T0–T15`** specifically — fresh carve-outs need fresh justifications subject to review |

---

## Linked context

- Phase 1 PRD: `prds/archive/bundles/god-functions-remediation.md` (refined SHA `1658d81`, shipped on session `2026-04-25-9152e64b`)
- Carve-out commit: `7bf3263 chore(lint): add eslint-disable carve-outs for 27 pre-existing god-functions`
- v1.59.x release notes: codex backend stall hardening — confirms the codex pipeline can ship epics of this size autonomously
- Master plan: `prds/MASTER_PLAN.md` §1 (PRD index) and §5 (cross-cutting rules — same constraints apply)
