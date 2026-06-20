# BUG REPORT — Readiness contract-resolver false-halts on forward-created schema field-paths

**Date:** 2026-06-20
**Finding code:** R-RCFF (Readiness Contract-resolver Forward-created Fields)
**Priority:** P3 (capture-only — clean sanctioned workaround exists: `skip_quality_gates_reason`)
**Status:** OPEN / capture-only (filed while babysitting a real run)
**Family:** instance of the readiness-over-block cluster — [[R-RGO]] (hard-halt on false-positive path-form findings, no graduated response), [[R-RPRA]] (forward-created *files*), [[R-QGSK]] (readiness-rejects-forward-created-tickets / unified skip flag).

## Summary
For a PRD whose entire purpose is to **add new schema fields**, the pickle build phase's
`check-readiness.js` resolves each ticket's `## Interface Contracts` **Outputs** against the
codebase at HEAD and reports every net-new dotted field-path as `contract does not resolve`.
This hard-halts the whole pipeline (`READINESS HALT: check-readiness exited 2`, pickle phase
exit 1, 0/4 phases) on its first launch. The prior forward-created exemption work (R-RPRA
leading-slash strip; R-QGSK forward-created **tickets/files**) does **not** cover dotted
**field-paths** in Interface Contracts Outputs — that is the gap.

## Repro (real run)
- Session: `2026-06-20-4124c822` (pipeline-4124c822), target = loanlight-api worktree
  `deephaven-phase-1.5-worktree`, scope=branch, 6 serial additive-extraction tickets
  (LOA-1367..1372), each adding new `appraisal-data.ts` schema fields.
- Pickle phase exited 1 in ~21s. `readiness_2026-06-20.md` → **14 findings, all of type
  `contract` → "Referenced contract does not resolve"**, each one a net-new field the ticket
  itself creates, e.g.:
  - `improvements.has_dampness_evidence` (ticket 4059a948)
  - `site.is_in_lava_zone_1_or_2` (a4c721f2)
  - `condo_project_info.project_status` (d61fa934)
  - `condo_project_info.is_condo_hotel`, `improvements.is_site_condo` (eeae8feb)
  - `reconciliation.final_opinion_within_adjusted_range`, `…land_value_total_ratio`, etc. (2fa59e50)
  - `subject.is_income_producing`, `improvements.has_kitchen`, `…solar_ownership_status` (a962086f)
- The **AC verifiability matrix in the same report was entirely `SKIP_POST` (healthy)** — only
  the Contract resolution table FAILed. So the gate blocked purely on forward-created contracts.

## Root cause
`check-readiness.js` contract resolution treats Interface-Contracts Outputs as references that
must exist at HEAD. There is no forward-created annotation channel for dotted field-paths
(unlike backticked file paths / symbols, which have the `(forward-created)` / `(created by
ticket <hash>)` grammar). An additive-field PRD therefore **always** false-halts on first
launch, and the only escape is the all-or-nothing `state.flags.skip_quality_gates_reason`,
which disables **both** readiness AND ticket-audit — not just the bogus contract findings.

## Impact
- Every additive-schema-field PRD (a common shape — new extraction fields, new DTO fields)
  hard-halts on first launch with zero phases run. Confusing for hands-off/babysat runs.
- Bypass is coarse: suppressing the whole quality-gate to clear contract-resolution false
  positives also suppresses any *real* readiness/ticket-audit finding in the same run.

## Proposed remediation (not done — capture only)
1. **Forward-created field-path exemption:** when a ticket's Interface-Contracts Output dotted
   path is *created by the same bundle* (it appears in that ticket's "Files to modify/create"
   schema file and not at HEAD), treat it like a forward-created artifact — do not FAIL it.
   Mirror the existing `(forward-created)` grammar for field-paths, OR auto-detect via the
   bundle's schema-file diff.
2. **Finding-scoped skip:** allow `skip_quality_gates_reason` (or a narrower flag) to suppress
   only `contract`-class findings, so genuine readiness/ticket-audit findings still gate.
   (Partial overlap with R-RGO graduated-response work — verify whether that already covers
   contract-class findings.)
3. **Pre-set ergonomics:** document/auto-suggest pre-setting the skip flag at launch for
   additive-field PRDs (the babysitter now does this).

## Secondary observations (low severity, likely benign — not filed)
- `mux-runner.log`: `[ensureMonitorWindow] unrecognized command_template '_pickle-manager-prompt.md'; defaulting to pickle`.
- `restartDeadWatcherPanes WARN: pane N command 'zsh' is not node` ×4 on resume (panes were
  respawned successfully right after).

## Workaround used (sanctioned)
Set `state.flags.skip_quality_gates_reason` citing the forward-created fields + that the AC
matrix was all SKIP_POST, reset `step=research` / `current_ticket`, relaunch. Pipeline then
proceeded normally (now building). Correctness still enforced by per-ticket typecheck/lint/
coerce/sync ACs + citadel/anatomy-park/szechuan.

---

## Second occurrence — 2026-06-20, session `2026-06-20-9ab25dfa` (LOA-1449 Mashvisor)

Same defect, **different bundle, same day** — confirms it is not specific to one PRD shape.

- Session: `2026-06-20-9ab25dfa` (pipeline-9ab25dfa), target = loanlight-api worktree
  `loa-1449-worktree`, scope=branch, 11 tickets (STR/LTR Mashvisor rental enrichment — adds a
  new `RentalDataResult` contract, a `rental_data` jsonb column, a `mashvisorFetch` node).
- Pickle phase exited 1 in ~2s on first launch: `READINESS HALT: check-readiness exited 2`,
  `pipeline-status` → `failed`, 0/4 phases.
- `check-readiness` → **8 findings**, of which **6 were forward-created false-positives**:
  - **4 `contract` (the core R-RCFF gap):** `state.rentalData` (ticket a4f0b3f3, graph-state
    annotation it adds), `detail.rentalData` (d70df640, getRunDetail DTO field it adds),
    `_errors.mashvisorTimeout` (60e03bb0), `strPerformance.annualRevenue` (ed7d6bd8, a field in
    the new `RentalDataResult` type the bundle's 010 ticket creates).
  - **2 `file_path` — NEW data point:** `mashvisorFetch/node.spec.ts` (tickets 60e03bb0,
    e6f0cd3c) — a **forward-created test file** the 050 ticket creates, yet it still FAILed as
    `file_path "does not resolve"`. The existing forward-ref grammar (R-RTRC-2 / R-FRA-6) is
    supposed to cover file paths; here it did **not** suppress these. Likely cause: the refined
    tickets referenced the spec file in `## Test Expectations` / Research Seeds **without** the
    `(forward-created)` / `(created by ticket <hash>)` annotation (synthesizer omission), so the
    resolver had nothing to key off. Open question for the fix: should the resolver auto-detect a
    forward-created file from the bundle's own "Files to create" set (mirror of the proposed
    field-path auto-detect in remediation #1), so an un-annotated but clearly bundle-created file
    doesn't false-halt? That would make the file-path path robust to annotation omission, not
    just the field-path path.
- **2 findings were genuine** (not R-RCFF): two tickets cited `packages/api/CLAUDE.md`, but this
  repo's CLAUDE.md is at the **repo root** (`CLAUDE.md`, no `packages/api/` copy). Fixed the refs
  in-place; re-ran readiness → only the 6 forward-created false-positives remained. (Lesson: the
  halt usefully surfaced 2 real doc-path typos mixed in with the noise — argues for the
  **finding-scoped** skip / graduated response of remediation #2 over the all-or-nothing flag, so
  the real findings aren't masked.)

**Workaround:** identical sanctioned path — fixed the 2 real refs, set
`skip_quality_gates_reason` citing the 6 forward-created artifacts, reset `step=research` /
`current_ticket`, relaunched. Build then proceeded normally (2/11 tickets Done + committed at
time of writing).

**Why this strengthens the case:** two independent additive PRDs (additive extraction fields;
additive rental contract/column/node) false-halted on first launch the same day. The field-path
auto-detect (remediation #1) and the finding-scoped skip (remediation #2) would each have
avoided a babysitter intervention; #2 would *additionally* have kept the 2 real doc-path findings
visible instead of being swept under the coarse skip.
