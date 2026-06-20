---
title: BUG REPORT — 2026-05-23 — readiness gate rejects forward-created test/script files (5th known recurrence)
status: Draft
filed: 2026-05-23
priority: P2
type: bug-incident
r_code: R-FRA
related:
  - prds/archive/bug-reports/p2-refined-tickets-trip-readiness-contract-resolver.md   # parent root-cause PRD (2026-05-03)
  - prds/archive/bug-reports/p2-refine-prd-skill-missing-rtrc7-annotation-reminder.md  # refinement-skill side (2026-05-10)
  - prds/archive/bug-reports/p2-forward-ref-annotation-readiness-vs-audit-bundle-drift.md  # gate-side parity (2026-05-14)
  - prds/archive/bug-reports/BUG-REPORT-2026-05-21-readiness-contract-resolver-wall-budget-false-positives.md
---

# Bug Report — 2026-05-23 — readiness gate rejects forward-created tickets

## Incident

Pipeline session `2026-05-23-17b2f716` (`B-PROJECT-AUDIT-2026-05-23`, 46-ticket bundle) failed at iter 1 with `READINESS HALT: check-readiness exited 2; no manager spawn attempted`. Pickle phase exited 25s after launch, citadel ran and flagged 8 findings (1 Critical: `AC-AUDIT-V2 has no production implementation evidence in changed files` — naturally, because no worker ran), pipeline halted at phase 2/4.

Forensics: `readiness_2026-05-23.md` lists **34 `file_path` findings**, all for paths that the tickets THEMSELVES create. Examples:

| Ticket | Forward-created path flagged as `file_path` finding |
|---|---|
| `4b3ecd93` (R-RWUW) | `extension/tests/wuwc-reproducer.test.js` |
| `4ece59c9` (R-RCSI) | `extension/src/services/concurrent-session-forensics.ts` |
| `4a56278a` (R-AHMR) | `extension/tests/backend-spawn-hermes-manager.test.js` |
| `4b06b3a3` (R-AADF-1) | `extension/scripts/audit-paused-orphan-pre-aa52f83f.sh` |
| `be5a047d` (R-RVMW) | `extension/tests/microverse-codex-manager-relaunch.test.js` |
| `dde989b3` (R-AWLS) | `extension/tests/writeloopstate-schema-ceiling.test.js` |
| `c1411e8f` (R-INGS) | `extension/tests/release-workflow-uses-test-gate.test.js` |
| `a1516560` (R-STALE-AC-AUDIT-V2) | `extension/tests/stale-ac-audit-v2.test.js` + `prds/snapshots/pre-B-PROJECT-AUDIT-2026-05-23.json` |
| (...26 more...) | — |

Unblocked via `state.flags.skip_quality_gates_reason` (unified flag, R-QGSK-2) — same workaround used in every prior recurrence.

## Recurrence history

| Date | Session | Bundle | Workaround |
|---|---|---|---|
| 2026-05-02 | `2026-05-02-fca7952b` | mega bundle | `skip_readiness_reason` |
| 2026-05-03 | `2026-05-03-7d9ee8cc` | reliability-and-test-coverage | (filed PRD `p2-refined-tickets-trip-readiness-contract-resolver.md`) |
| 2026-05-10 | `2026-05-10-84ad0873` | R-SLLJ / R-MDS bundle | (filed PRD `p2-refine-prd-skill-missing-rtrc7-annotation-reminder.md`) |
| 2026-05-13 | `2026-05-13-b54f2143` | R-TSPF bundle | (filed PRD `p2-forward-ref-annotation-readiness-vs-audit-bundle-drift.md`) |
| **2026-05-23** | **`2026-05-23-17b2f716`** | **B-PROJECT-AUDIT (46 tickets)** | **`skip_quality_gates_reason` (this report)** |

The 3 prior PRDs are all in `Draft` status; **none was registered in `prds/MASTER_PLAN.md`** — so the bug class never made it onto the active bug drain. Each pipeline launch hits it cold.

## Root cause (recap from prior PRDs)

`check-readiness.ts:extractContractReferences` greps every backticked token in each ticket file. Tokens matching path or symbol shape go through `resolvePathRef` / `resolveSymbolRef`. Forward-created paths (the deliverables of the ticket) cannot resolve at readiness time because they don't exist yet.

R-RTRC-7 added an opt-in annotation grammar (`` `path` `` `(forward-created)` OR `` `path` `` `(created|introduced) by ticket <hash>`) that suppresses the finding. The grammar is documented but the gap is human/process: refinement-skill Step 7c doesn't remind the ticket author to add it, and no audit script enforces it pre-launch.

## Cluster of related PRDs (all Draft, no MASTER_PLAN row)

1. **`p2-refined-tickets-trip-readiness-contract-resolver.md`** (filed 2026-05-03, R-FRA / parent)
   - 5 false-positive classes identified; 3 fix paths (RC-1 refinement prompt, RC-2 resolver annotation, RC-3 audit script).
   - Status: Draft. Not registered.

2. **`p2-refine-prd-skill-missing-rtrc7-annotation-reminder.md`** (filed 2026-05-10, R-RTRC8)
   - R-RTRC8-1/2/3 fix requirements: Step 7c template includes 🚦 Forward-reference hygiene reminder; audit-ticket-forward-refs.sh pre-flight script.
   - Status: Draft. Not registered.

3. **`p2-forward-ref-annotation-readiness-vs-audit-bundle-drift.md`** (filed 2026-05-14, R-FRA gate side)
   - Two gates (readiness + audit-ticket-bundle) need to accept the same annotation grammar OR a single skip flag must cover both. R-QGSK-2 unified flag partially shipped; gate-side parity still open.
   - Status: Draft. Not registered.

4. **This report** (2026-05-23) — 5th recurrence attestation; cite as evidence the cluster needs a NEXT bundle.

## Fix proposal (ranked)

| ID | Effort | Coverage |
|---|---|---|
| **R-FRA-1** | S | Refinement skill Step 7c prepends 🚦 Forward-reference hygiene reminder + canonical annotation example. (R-RTRC8-1) |
| **R-FRA-2** | M | New `extension/scripts/audit-ticket-forward-refs.sh` pre-flight audit, callable from `/pickle-pipeline` Step 0 as `--strict` mode. (R-RTRC8-3) |
| **R-FRA-3** | M | `check-readiness.ts` auto-suppresses `file_path` findings whose path appears in a ticket's `## Implementation Details: Files to modify/create` section, regardless of annotation. Heuristic: "Files to create" is structurally a forward-reference declaration. (RC-2 variant) |
| **R-FRA-4** | S | Document `skip_quality_gates_reason` as the SUPPORTED workaround for creation-heavy bundles; update `/pickle-pipeline` doc + persona Step 0 to set it automatically when ticket count > 10 AND >50% of ACs reference test files under `extension/tests/`. |

## Acceptance criteria (machine-checkable)

- [ ] **AC-FRA-1**: `.claude/commands/pickle-refine-prd.md` Step 7c top section contains the literal token `🚦 Forward-reference hygiene` — Verify: `grep -c "🚦 Forward-reference hygiene" .claude/commands/pickle-refine-prd.md` ≥ 1 — Type: lint
- [ ] **AC-FRA-2**: `extension/scripts/audit-ticket-forward-refs.sh` exists, exits 0 on a fixture with annotated forward-refs, exits non-zero on a fixture without annotations — Type: integration
- [ ] **AC-FRA-3**: A bundle with ≥10 tickets, all forward-creating tests, launches `/pickle-pipeline` without operator setting `skip_quality_gates_reason` — Type: integration
- [ ] **AC-FRA-4**: `BUG-REPORT-2026-05-23` + 3 prior PRDs appear in `prds/MASTER_PLAN.md ## Open Findings` table with a bundle code in the Status column — Type: lint

## Bundle proposal

**B-FRA** (~4-6 tickets, P2)
- R-FRA-1: refinement-skill reminder (smallest delta first)
- R-FRA-2: audit-ticket-forward-refs.sh
- R-FRA-3: readiness auto-suppress for Files-to-create
- R-FRA-4: persona auto-set skip flag for creation-heavy bundles
- R-FRA-5 (closer): document supported workaround in `/pickle-pipeline.md`
