---
title: P1 — Bug-fix bundle 2026-05-05 (local-only, mega)
status: Draft
date: 2026-05-05
priority: P1
type: bug-bundle
scope: local-only  # no release intent; closer/release-gate dropped
peer_prds:
  composes:
    - prds/archive/features/p1-worker-backend-split-from-manager.md
    - prds/archive/bug-reports/p2-codex-spark-worker-completion-commit-contract-violation.md
    - prds/archive/bug-reports/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md  # R-CNAR-7 addendum (slot 1g residual)
    - prds/archive/bug-reports/anatomy-park-judge-unreachable-on-worker-convergence.md
    - prds/archive/bug-reports/p2-remove-pipeline-wall-clock-time-cap.md
    - prds/archive/bug-reports/p2-manager-stop-hook-nudge-cadence-wastes-turns.md
    - prds/archive/bug-reports/p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md
    - prds/archive/bug-reports/p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md
    - prds/archive/bug-reports/p3-test-flakes-council-publish-and-scope-resolver.md
  shipped_already:
    - prds/archive/bug-reports/p2-install-sh-types-index-stale-on-fast-reinstall.md  # slot 1q shipped 2026-05-05 in commit f6909d78 (Section C ALREADY-SHIPPED below)
  carry_forward_from:
    - prds/archive/bundles/p1-bug-fix-bundle-2026-05-04.md  # 9 unshipped tickets folded in as Section CF
  related:
    - prds/archive/bundles/large-pipeline-time-budget-undersized.md  # AC-LPB-07 superseded by 1t
refinement:
  cycles: 3
  workers: [requirements, codebase, risk-scope]
  notes: |
    Local-only mega bundle. Refinement should expect ~55-75 atomic tickets:
    1o..1u (skip 1q) + 9 carry-forwards from 2026-05-04. No closer ticket;
    no `gh release create`; audit-canary-flip removed from gate (commit 244b4c51).
---

# PRD — Bug-fix bundle 2026-05-05 (local-only mega)

**LAUNCH PRECONDITIONS**:
- Slot 1q shipped (commit `f6909d78`, 2026-05-05). install.sh now has force-rebuild + md5-parity probe.
- audit-canary-flip removed from gate (commit `244b4c51`). No `gh release create` in this bundle's scope.
- Working tree clean; no active sessions; mux-runner orphans cleared.

## Why one bundle

Bundle 2026-05-04 shipped 33 of 46 atomic tickets (Section A cross-backend leak class + most of B/C/D/E hardening). 9 carry-forwards remain unshipped — pickle-rick's bundle bootstrap machinery + Section H code-quality hardening. New findings 1o through 1u span overlapping subsystems and would re-traverse the same code paths if shipped separately.

- **Slots 1o + 1p + 1r/1s** are about backend hybrid mode and convergence-judge reliability — both touch worker spawn paths and convergence semantics.
- **Slot 1q** (install.sh deploy parity) shipped solo before this bundle launched. Section C in this PRD is now ALREADY-SHIPPED; refinement converts it to REGRESSION-TEST-ONLY.
- **Slots 1m + 1n** are operational/lifecycle papercuts: dirty-tree guard residuals, stop-hook orphan-shadow.
- **Slot 1d** is pre-existing test flakes — local-only goal still wants a green gate, so they land here.
- **Slot 1t** removes a wall-clock cap that almost killed run #5 of the prior bundle; quick LOC, big reliability win.
- **Section CF carry-forwards** are bundle bootstrap machinery (R-BUNDLE-1/2/DISPO-1), Section H code-quality hardening (Wire×1, Harden×2, Audit×2), and AC-TAQ-09 defective fixture. The closer ticket + R-CLOSER-1 from the prior bundle are DROPPED (local-only scope; no release).

Estimated ticket count after refinement: **55-75 atomic tickets**.

## Composition

| Section | Source PRD | Slot | Priority | Tickets (est.) | Lead requirement |
|---------|-----------|------|----------|----------------|------------------|
| **A** | `p1-worker-backend-split-from-manager.md` | 1o | P1 | 8-10 | R-WBS-1: `state.worker_backend` field + spawn-site precedence |
| **B** | `p2-codex-spark-worker-completion-commit-contract-violation.md` | 1p | P2 | 6-8 | R-CCC-2: post-commit auto-fill helper |
| **B-2** | `p1-deploy-typescript-symlink-and-cap-no-auto-resume.md` (R-CNAR-7 addendum) | 1g residual | P1 | 3-4 | R-CNAR-7: cap-check guard + self-heal stale per-ticket cache when `current_ticket=null` (fixes resume-stall trap) |
| **C** | `p2-install-sh-types-index-stale-on-fast-reinstall.md` | 1q | **ALREADY-SHIPPED** | 1 (regression-only) | Shipped via `f6909d78` 2026-05-05. Refinement → REGRESSION-TEST-ONLY: assert install.sh has `INSTALL_SKIP_PARITY` + `md5_file` helper + force-rebuild block. |
| **D** | `anatomy-park-judge-unreachable-on-worker-convergence.md` | 1r+1s | P1 | 8-10 | R-AJUR-1: skip guard when metric_type='none'; R-MJU-1: judge_timeout vs stall distinction |
| **E** | `p2-remove-pipeline-wall-clock-time-cap.md` | 1t | P2 | 8-10 | R-NTC-1: stop writing default; R-NTC-2: state-field invariant flip |
| **F** | `p2-manager-stop-hook-nudge-cadence-wastes-turns.md` | 1u | P2 | 5-6 | R-MSCN-1: WAIT_PATTERN_REGEXES; R-MSCN-2: idle-backoff state machine |
| **G** | `p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md` | 1n | P2 | 4-5 | R-SHB-1: stop-hook tmux_mode default-fallthrough fix |
| **H** | `p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md` | 1m | P3 | 4-5 | R-PDT-1: dirty-allowed list; R-PDT-2: stable verify-recapture digest |
| **I** | `p3-test-flakes-council-publish-and-scope-resolver.md` | 1d | P3 | 3-4 | flake-stabilization on the two failing tests |
| **J** | Bundle thesis matrix update | — | — | 1 | bundle thesis matrix entry only (no closer; local-only) |
| **CF** | Carry-forwards from bundle 2026-05-04 (see Section CF below) | — | mixed | 9 | AC-TAQ-09 + R-BUNDLE-1/2/DISPO-1 + 5 Section H hardening tickets |

**Total estimate: 56-72 atomic tickets** (refinement may merge or split).

## Section CF — Carry-forwards from bundle 2026-05-04

These 9 tickets were Todo at v1.70.0 close. They land in this bundle. The closer ticket and R-CLOSER-1 from the prior bundle are **DROPPED** — local-only scope; no `gh release create` in this bundle.

| Ticket | Source | Priority | Size | Notes |
|--------|--------|----------|------|-------|
| **AC-TAQ-09** | 2026-05-04 / order 470 | Medium | small | Defective + clean fixture sessions in `extension/tests/fixtures/audit-ticket-bundle/`. 8 fixtures, one per defect class. Fixture dir already exists with one expected.json — needs the rest. |
| **R-BUNDLE-1** | 2026-05-04 / order 660 | High | small | `state.flags.bundle_bootstrap_mode` flag with hardcoded session-hash allowlist. Auto-applies BOTH `skip_readiness_reason` + `skip_ticket_audit_reason`. Activity event `bundle_bootstrap_exemption_applied`. **Unshipped — no implementation found in `extension/src/` for `bundle_bootstrap_mode`.** |
| **R-BUNDLE-2** | 2026-05-04 / order 670 | High | small | Snapshot `~/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/` to `extension/tests/fixtures/baseline-2026-05-03-7d9ee8cc/`. **Partial — fixture dir exists with sub-dirs `aa001122/`, `bb112233/`, `cc223344/`; refinement should validate completeness against R-XBL-6 + R-TAQ-6 ACs.** |
| **R-BUNDLE-DISPO-1** | 2026-05-04 / order 680 | High | small | Disposition table JSON at `extension/src/data/bundle-disposition-2026-05-04.json` (52 IMPL + 1 DROP + 1 RTO entries). Read by refinement-team analyst prompts (R-TAQ-1, R-XBL-9) and audit-ticket-bundle (R-TAQ-2). **Unshipped — file is missing.** |
| **CF-WIRE** (was order 700) | 2026-05-04 / order 700 | High | large | Wire: integrate bundle subsystems (auto-resume + smoke-gate + audit + bootstrap-mode + watchdog) into a coherent end-to-end path. |
| **CF-HARDEN-CODE** (was order 710) | 2026-05-04 / order 710 | High | large | Harden: code-quality review of bundle subsystems. |
| **CF-AUDIT-DATAFLOW** (was order 720) | 2026-05-04 / order 720 | High | large | Audit: data-flow integrity for bundle subsystems. |
| **CF-HARDEN-TESTS** (was order 730) | 2026-05-04 / order 730 | High | large | Harden: test-quality review of bundle subsystems. |
| **CF-AUDIT-XREF** (was order 740) | 2026-05-04 / order 740 | High | large | Audit: cross-reference consistency for bundle subsystems. |

**Dropped from carry-forward** (local-only scope):
- ~~R-CLOSER-1~~ (closer-release-gate.sh script for `gh release create`) — no release intent in this bundle
- ~~Closer ticket~~ (bump v1.70.0 → v1.71.0 + push 74+ commits + tag) — out of scope

If a future release is desired, R-CLOSER-1 and Closer can be filed as a standalone P1 release-gate PRD; not part of this local-only mega bundle.

## Composition rationale (Risk Register)

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| **R1 — Slot 1q must land first** | ~~High~~ **MITIGATED** | Slot 1q shipped solo via `f6909d78` 2026-05-05 BEFORE this bundle launches. install.sh now has force-rebuild + md5-parity probe; activity events guaranteed live. Section C is REGRESSION-TEST-ONLY in this bundle. |
| **R2 — Slot 1o (worker_backend) interacts with R-XBL-3 pre-spawn assertion** | Medium | R-XBL-3 currently asserts `state.backend` matches resolved backend. With 1o, the assertion needs updating to match `worker_backend ?? backend`. Section A early ticket: update assertion + add regression test. |
| **R3 — Slot 1t (no wall-clock cap) for this very bundle** | Low | The bundle itself benefits from 1t — long bundles won't trip a wall-clock cap mid-run. But we MUST NOT regress the opt-in path; section E first ticket covers regression test. |
| **R4 — Slot 1p ACK token may pollute manager log parsing** | Medium | The `COMPLETION_COMMIT_RECORDED:` token must NOT match any existing manager log pattern. Refinement Cycle 2 codebase-analyst confirms pattern is unique. |
| **R5 — Slot 1m R-PDT-2 stable digest may regress on file-list ordering** | Low | `verify-recapture-fired` test sorts file paths before hashing. Add explicit ordering test as part of R-PDT-2. |
| **R6 — Bundle ships during operator off-hours; no live monitoring** | Low | New `worker_backend_resolved` event + parity events + `manager_idle_backoff_engaged` events provide enough forensic trail for postmortem. R-NTC-9's `time_cap_disabled_default` event also helps. |
| **R7 — Closer fails because pre-existing test flakes (1d) are not yet stable** | High | Section I lands 1d test stabilization BEFORE the closer ticket. Closer's release-gate runs full `npm test` and depends on Section I green. |
| **R8 — Section F idle-backoff regex misses some degenerate manager replies** | Medium | Cycle 2 codebase-analyst expands `WAIT_PATTERN_REGEXES` from `tmux_iteration_*.log` corpus across recent runs. R-MSCN-1 ACs assert ≥80% degenerate-reply coverage. |
| **R9 — Section F + Section G merge conflict in `stop-hook.ts`** | Medium | Both Sections touch `extension/src/hooks/handlers/stop-hook.ts`. Ordering constraint enforces F-before-G; refinement Cycle 1 confirms no overlapping line ranges. |

## Dispositions table (carry forward)

Same R-BUNDLE-DISPO-1 disposition table format from prior bundle:

| Code | Meaning |
|------|---------|
| ALREADY-SHIPPED | Existing code already satisfies; ticket converts to REGRESSION-TEST-ONLY |
| REGRESSION-TEST-ONLY | Implementation already exists; only a test asserting current behavior |
| DROP | Refinement determined the requirement is unnecessary or already covered |
| SUPERSEDED | A different requirement closes this gap; reference the superseder |
| RTO | Replaces an obsolete approach with a new one (Replace-To-Other) |

## Ordering constraints

1. ~~**Section C MUST come first.**~~ N/A — slot 1q shipped solo via `f6909d78`; Section C is REGRESSION-TEST-ONLY.
2. **Section CF R-BUNDLE-DISPO-1 MUST come first.** The disposition-table JSON is read by refinement analyst prompts on Cycles 2 and 3 — must exist before any refinement of this bundle's tickets.
3. **Section A before Section B.** R-WBS-1 (worker_backend field) enables R-CCC-* worker-side mitigations to be applied without affecting manager.
4. **Section D + Section E independent.** No ordering between judge-unreachable fix and wall-clock cap removal.
5. **Section F (stop-hook nudge cadence) + Section G (stop-hook orphan-shadow) — sister Sections, both touch `stop-hook.ts`.** Land Section F before Section G to avoid merge conflicts in the same handler. Both are P2.
6. **Section H (dirty-tree-guard) independent of all others.**
7. **Section CF Wire/Harden/Audit run LAST** (orders 700-740 from prior bundle). They do code-quality + cross-reference + dataflow validation across ALL preceding sections — must run after the implementation tickets land.
8. **No closer ticket.** Local-only bundle; no `gh release create`. Final commit on `main` is the last Section CF ticket; operator decides whether to push and release later.

## Refinement directives

When `/pickle-refine-prd prds/archive/bundles/p1-bug-fix-bundle-2026-05-05.md` runs:

- **Cycle 1 (requirements)**: validate AC machine-checkability of every R-* requirement above. Flag any that read like prose.
- **Cycle 2 (codebase)**: enumerate every file each section touches; flag overlaps with bundle 2026-05-04's commits since they may not yet be deployed at refinement time. Confirm R-WBS-2 spawn-site list against current `mux-runner.ts` line numbers.
- **Cycle 3 (risk-scope)**: stress-test the bundle thesis — could any section be safely DEFERRED to a v1.72.0 follow-up? (Recommendation: 1d test flakes are P3; could defer if the closer's release-gate test_floor is already met without them.)

## Acceptance Criteria

- **AC-BUNDLE-2026-05-05-01** — All 7 source PRDs (1o, 1p, 1r/1s, 1t, 1n, 1m, 1d) plus 9 carry-forwards have refined `R-*` requirements with machine-checkable ACs. Bundle's `refinement_manifest.json` produces atomic tickets matching the section table above. Slot 1q is REGRESSION-TEST-ONLY (already shipped).
- **AC-BUNDLE-2026-05-05-02** — `bundle-thesis-matrix.md` is updated with this bundle's row; per-source-PRD AC->ticket coverage is 100%.
- **AC-BUNDLE-2026-05-05-03** — Bundle ends with a clean working tree on local `main` and a green local gate (lint + tsc + audits + `npm test:fast` + `npm test:integration` — `audit-canary-flip` is no longer in the gate per commit `244b4c51`). NO `gh release create`; NO version bump; NO push. Closer ticket is explicitly absent.
- **AC-BUNDLE-2026-05-05-04** — Post-bundle audit confirms: every Section's lead trap-door entry exists in `extension/CLAUDE.md`; every new activity event (`worker_backend_resolved`, `completion_commit_auto_filled`, `completion_commit_inferred_from_git`, `time_cap_disabled_default`, `bundle_bootstrap_exemption_applied`, etc.) is registered in `VALID_ACTIVITY_EVENTS` + `activity-events.schema.json` and the peripheral count assertion in `tests/activity-event-payload.test.js` is updated.
- **AC-BUNDLE-2026-05-05-05** — Bundle ran end-to-end with no operator manual reset of `start_time_epoch`, no manual install.sh re-run, and no phantom-Done false reverts. (Live validation; bundle is its own integration test.)
- **AC-BUNDLE-2026-05-05-06a** — All 9 Section CF carry-forwards from bundle 2026-05-04 are marked either `status: Done` or `status: REGRESSION-TEST-ONLY` in their respective ticket files at bundle close.
- **AC-BUNDLE-2026-05-05-06b** — `extension/src/data/bundle-disposition-2026-05-04.json` exists, is valid JSON, and contains exactly one entry per R-* requirement from the prior bundle (52 IMPL + 1 DROP + 1 RTO per R-BUNDLE-DISPO-1). The path `extension/src/data/` — NOT `extension/data/` — was selected because `src/data` is the home for refinement-team config (analyst prompts read it via path before any compile step).
- **AC-BUNDLE-2026-05-05-07** — Every lead R-ID in the Composition table has its full AC body lifted from the peer PRD inline in this bundle PRD, with `*(refined: prds/<peer-path>)*` attribution. Verify: `grep -c "(refined: prds/" prds/archive/bundles/p1-bug-fix-bundle-2026-05-05.md` ≥ 11; `grep -c "## Section .* — Local ACs" prds/archive/bundles/p1-bug-fix-bundle-2026-05-05.md` ≥ 9. Type: lint.

## Notes & open questions

- **Filename convention**: this bundle is filed today (2026-05-05) and launches today (post slot-1q ship). Local-only — no release coupling.
- **Open question**: should slot 1t (wall-clock cap removal) ship in THIS bundle or be a standalone release? If 1t lands in this bundle, the bundle benefits from its own removed cap. Recommendation: keep in bundle; the bundle's risk profile already includes long-running runs.
- **Open question**: ~~slot 1q hotfix~~ RESOLVED — slot 1q shipped solo as `f6909d78` 2026-05-05. Section C in this PRD is REGRESSION-TEST-ONLY.
- **Pre-flight checklist** (verified at compose time 2026-05-05; path decision: R-BUNDLE-DISPO-1 JSON at `extension/src/data/bundle-disposition-2026-05-04.json`, NOT `extension/data/` — `src/data` is refinement-team config home, read before compile):
  1. ✅ `git log` shows commit `f6909d78 fix(install-parity)` shipping slot 1q solo
  2. ✅ `bash install.sh` runs cleanly with new R-ITS-2 parity probe — exercised twice at compose time, all 5 hot files md5-match
  3. ✅ `audit-canary-flip` removed from gate (`244b4c51`); `release-gate-parity` test passes 2/2
  4. ✅ `trap-door-conformance.test.js` 62/62 pass (`49e0ff84` fixed 5 grep-only ENFORCE entries)
  5. ✅ `activity-event-payload.test.js` count assertion updated to 12 events (`1949c6a4`, follow-up to slot 1q)
  6. ⚠️ Pre-existing fast-tier hang: `node --test tests/activity-event-payload.test.js` runs in 67ms standalone but DEADLOCKS under `npm run test:fast` parallel-worker pool. Slot 1q's worker hit this mid-flight; recovery via `pkill -9 -f 'node --test'` worked. Refinement should treat this as an additional finding — OR refine into a new section once root-cause is known.
  7. Working tree clean; no active sessions; orphan tmux sessions present but harmless.

**Pipeline risk on launch:** the activity-event-payload.test.js fast-tier deadlock is the highest known risk. Workers running `npm run test:fast` may hang. Mitigations:
  - Workers' targeted tests typically don't run full fast-tier (gate is per-ticket).
  - If a worker does spawn fast-tier and hangs, mux-runner's worker_timeout_seconds (1200s default) eventually kills it, but burns ~20 min per occurrence.
  - Operator-level mitigation: `pkill -9 -f 'node --test'` to free a hung worker.
  - Section CF could include a new ticket: "diagnose + fix activity-event-payload deadlock under parallel test runner" — recommend refinement Cycle 2 add this if root-cause not in scope of any other ticket.

---

## Section A — Local ACs *(lifted from prds/archive/features/p1-worker-backend-split-from-manager.md)*

*(refined: prds/archive/features/p1-worker-backend-split-from-manager.md)*

Lead requirements: **R-WBS-1** (field definition), **R-WBS-2** (spawn-site resolution), **R-WBS-3** (`--worker-backend` CLI flag), **R-WBS-4** (activity event), **R-WBS-5** (state-field invariant + trap-door), **R-WBS-6** (tests).

Source files at HEAD: `extension/src/types/index.ts`, `extension/src/bin/spawn-morty.ts`, `extension/src/bin/microverse-runner.ts`, `extension/src/bin/mux-runner.ts:2078-2086`, `extension/src/bin/spawn-refinement-team.ts`, `extension/src/services/backend-spawn.ts`, `extension/src/bin/setup.ts`, `extension/CLAUDE.md`.

Test files (forward-created by Section A tickets): `extension/tests/state-field-invariants.test.js` (extend), `extension/tests/integration/worker-backend-split.test.js` (new), `extension/tests/spawn-morty-backend-resolution.test.js` (extend) — note: `extension/tests/integration/spawn-morty-backend-resolution.test.js` exists at HEAD.

- **AC-WBS-01** — `extension/src/types/index.ts` `State` type contains `worker_backend?: string`.
- **AC-WBS-02** — `setup.ts` accepts `--worker-backend <name>`; absence keeps state.worker_backend unset; presence writes the validated value.
- **AC-WBS-03** — `spawn-morty.ts` resolution: worker_backend precedence test asserts that when `state.worker_backend='codex' state.backend='claude'`, the spawn command uses codex.
- **AC-WBS-04** — Manager spawn at `mux-runner.ts:2078-2086` ignores `worker_backend` (always uses `state.backend`); regression test asserts manager spawn always uses `state.backend` regardless of `worker_backend`.
- **AC-WBS-05** — `spawn-refinement-team.ts` ignores `worker_backend` (refinement-only invariant); PICKLE_REFINEMENT_LOCK=1 path test asserts claude regardless of state.
- **AC-WBS-06** — `worker_backend_resolved` event emitted with `{ worker_backend, backend, source }` payload, registered in `VALID_ACTIVITY_EVENTS` and `activity-events.schema.json`.
- **AC-WBS-07** — `extension/CLAUDE.md` contains the state-field invariant for `worker_backend` and the new spawn-morty trap-door entry.
- **AC-WBS-08** — `audit-worker-backends.ts` (R-XBL-6) recognizes `worker_backend` resolution as legitimate (not a mismatch); informational events excluded from leak-count count.

---

## Section B — Local ACs *(lifted from prds/archive/bug-reports/p2-codex-spark-worker-completion-commit-contract-violation.md)*

*(refined: prds/archive/bug-reports/p2-codex-spark-worker-completion-commit-contract-violation.md)*

Lead requirement: **R-CCC-2** (post-commit frontmatter auto-fill helper). Also includes sibling requirements R-CCC-1, R-CCC-3, R-CCC-4, R-CCC-5 per the PRD's layered mitigation design.

Source files at HEAD: `extension/src/bin/spawn-morty.ts:436`, `extension/src/bin/mux-runner.ts:243,545`.

Forward-created files: `extension/src/bin/auto-fill-completion-commit.ts` (new — R-CCC-2), `extension/src/services/pickle-utils.ts` `hasCompletionCommit` helper (new — R-CCC-5).

Test files (forward-created): `extension/tests/auto-fill-completion-commit.test.js`, `extension/tests/phantom-done-cross-check.test.js`, `extension/tests/spawn-morty-completion-commit-prompt.test.js`, `extension/tests/integration/codex-spark-worker-completion-commit.test.js`.

Forensic data at `~/.local/share/pickle-rick/sessions/2026-05-04-f416c6cc/state.json.run6-handoff-snapshot` and `mux-runner.log.run6-handoff-snapshot`.

- **AC-CCC-01** — Worker prompt template at `spawn-morty.ts:436` contains the `COMPLETION_COMMIT_RECORDED:` ACK directive.
- **AC-CCC-02** — Worker stdout containing the ACK token emits `worker_completion_commit_announced` activity event.
- **AC-CCC-03** — `auto-fill-completion-commit.ts` (forward-created) exists, is wired into the worker turn-end path, and idempotently writes `completion_commit:` for `status: Done` tickets where git has a session-author commit.
- **AC-CCC-04** — Auto-fill emits `completion_commit_auto_filled` activity event registered in `VALID_ACTIVITY_EVENTS` + schema.
- **AC-CCC-05** — Phantom-Done watcher cross-checks git log and writes `completion_commit_inferred: <sha>` instead of reverting when the inference holds.
- **AC-CCC-06** — Inference logic emits `completion_commit_inferred_from_git` activity event.
- **AC-CCC-07** — Run #2 forensic replay test (fixtures from `tests/fixtures/baseline-2026-05-03-7d9ee8cc/` pattern) asserts no false revert under the new flow.
- **AC-CCC-08** — `hasCompletionCommit` helper (forward-created) exists in `pickle-utils.ts` with the three-state return type (`'explicit'|'inferred'|'absent'`). Unit-tested for all three branches.
- **AC-CCC-09** — Every phantom-Done revert path proven by codebase grep + audit script to call the helper as the first gate. Audit script wired into `extension/scripts/audit-trap-door-enforcement.sh` (or a new `audit-phantom-done-call-sites.sh`).
- **AC-CCC-10** — Replay test using run #6 forensic state: with operator-backfilled `completion_commit:` SHAs and bundle commit messages using R-* codes (not ticket hashes), zero false reverts occur.

---

## Section B-2 — Local ACs *(lifted from prds/archive/bug-reports/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md)*

*(refined: prds/archive/bug-reports/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md)*

Lead requirement: **R-CNAR-7** (cap-check guard + self-heal stale per-ticket cache when `current_ticket=null`, fixes resume-stall trap).

Source files at HEAD: `extension/src/bin/mux-runner.ts:2917-2934` (stale-cache guard + self-heal), `extension/src/types/index.ts:457` (`cap_check_skipped_stale_cache` event), `extension/tests/mux-runner-cap-split.test.js:138-190` (R-CNAR-7 tests already at HEAD).

Cycle 3 analysis (§G-CRIT-3) confirmed: **AC-CNAR-7-01 through AC-CNAR-7-04 are ALREADY-SHIPPED at HEAD**. Only AC-CNAR-7-05 (trap-door update) is OPEN.

- **AC-CNAR-7-01** *(ALREADY-SHIPPED — verified at `mux-runner.ts:2917-2935`)* — Test that simulates `state.current_ticket=null` + stale `current_ticket_max_iterations=10` + `state.iteration=18` confirms cap-check is SKIPPED (not tripped) and the runner proceeds to manager turn.
- **AC-CNAR-7-02** *(ALREADY-SHIPPED — verified at `extension/src/types/index.ts:457`)* — `cap_check_skipped_stale_cache` event is registered in `VALID_ACTIVITY_EVENTS` and emitted with the four cache-field values in payload.
- **AC-CNAR-7-03** *(ALREADY-SHIPPED — verified at `mux-runner.ts:2933`)* — Self-healing iteration_start clears stale cache fields when `current_ticket=null`; verified by test that asserts post-iteration_start state has all four cache fields = null.
- **AC-CNAR-7-04** *(ALREADY-SHIPPED — verified at `extension/tests/mux-runner-cap-split.test.js:138-190`)* — `mux-runner-cap-split.test.js` extended with the resume-with-stale-cache fixture (the exact 2026-05-05 reproducer state).
- **AC-CNAR-7-05** *(OPEN — `R-CNAR-7` has zero hits in `extension/CLAUDE.md` at HEAD)* — Trap-door entry for `mux-runner.ts (R-CNAR-1 part 2 cap split)` updated to add the stale-cache guard invariant.

**Refinement directive**: Section B-2 should collapse to ONE trap-door doc ticket (AC-CNAR-7-05 only); ACs 01-04 are REGRESSION-TEST-ONLY.

---

## Section C — Local ACs *(lifted from prds/archive/bug-reports/p2-install-sh-types-index-stale-on-fast-reinstall.md)*

*(refined: prds/archive/bug-reports/p2-install-sh-types-index-stale-on-fast-reinstall.md)*

**STATUS: ALREADY-SHIPPED** via commit `f6909d78` 2026-05-05. Refinement converts to REGRESSION-TEST-ONLY: assert install.sh has `INSTALL_SKIP_PARITY` + `md5_file` helper + force-rebuild block.

Lead requirements: **R-ITS-1** (force-rebuild before deploy), **R-ITS-2** (post-rsync md5-parity probe).

Source file at HEAD: `install.sh`.

- **AC-ITS-01** *(REGRESSION-TEST-ONLY)* — `install.sh` removes compiled JS files before `npx tsc`; verified by inspecting the script and by a test that introspects `install.sh` content.
- **AC-ITS-02** *(REGRESSION-TEST-ONLY)* — Post-rsync md5-parity probe runs and exits 1 on mismatch; verified by simulation test that mocks one of the 5 files with stale content.
- **AC-ITS-03** *(REGRESSION-TEST-ONLY)* — `INSTALL_SKIP_PARITY=1` opt-out works (parity probe skipped); verified by env-flag test.
- **AC-ITS-04** *(REGRESSION-TEST-ONLY)* — `install_sh_parity_check` event registered in `VALID_ACTIVITY_EVENTS` and `activity-events.schema.json`.
- **AC-ITS-05** *(REGRESSION-TEST-ONLY)* — Trap-door entry exists for `install.sh (parity gate)` with INVARIANT/BREAKS/ENFORCE.
- **AC-ITS-06** *(REGRESSION-TEST-ONLY)* — Regression: a synthetic test that replays the run #2 conditions (stale deployed `types/index.js`) asserts install.sh refuses to complete + flags the mismatch.

---

## Section D — Local ACs *(lifted from prds/archive/bug-reports/anatomy-park-judge-unreachable-on-worker-convergence.md)*

*(refined: prds/archive/bug-reports/anatomy-park-judge-unreachable-on-worker-convergence.md)*

Lead requirements: **R-AJUR-1** (skip guard when `metric_type='none'`) and **R-MJU-1** (`judge_timeout` vs stall distinction). Source file at HEAD: `extension/src/bin/microverse-runner.ts:447-474` (`validateWorkerConvergenceHistory`), `extension/src/bin/microverse-runner.ts:793-833` (`measureLlmMetric`).

Test files at HEAD: `extension/tests/microverse-runner-baseline-init.test.js`, `extension/tests/microverse-runner-finalizer.test.js`, `extension/tests/integration/pipeline-e2e.test.js`, `extension/tests/integration/microverse-runner-judge-failure.test.js`, `extension/tests/integration/anatomy-park-microverse-runner-no-key-metric.test.js`.

**Section D.1 — R-AJUR-1: skip guard when metric_type='none' (slot 1r)**

- **AC-AJUR-1** (AC1) — When `metric_type === 'none'` and worker writes `converged: true`, `handleWorkerManagedIteration` returns `converged: true`. Verify: unit spec `validateWorkerConvergenceHistory skips on metric_type=none` passes.
- **AC-AJUR-2** (AC2) — When `metric_type === 'perf'` and `convergence.history` is empty after worker convergence, the existing `judge_unreachable` guard still fires. Verify: unit spec `validateWorkerConvergenceHistory still guards metric mode` passes.
- **AC-AJUR-3** (AC3) — Anatomy-park completes with exit 0 when the worker writes `converged: true` and 2+ clean iterations. Verify: integration spec replays a fixture matching `pipeline-2026-05-04-8aecd4c7/anatomy-park.json` and asserts exit 0.
- **AC-AJUR-4** (AC4) — Szechuan-sauce phase runs in the pipeline-e2e fixture after anatomy-park converges. Verify: `tests/integration/pipeline-e2e.test.js` asserts `pipeline-status.json.completed_phases === 4`.
- **AC-AJUR-5** (AC5) — Existing finalizer-history guard still passes (regression check on the v1.63.0 sibling fix). Verify: `tests/microverse-runner-finalizer.test.js` and `tests/services/convergence-gate.test.js` green.
- **AC-AJUR-6** (AC6) — The `judge_unreachable` activity-log event still fires for legitimate metric-mode failures (not over-suppressed). Verify: unit spec assertions on `logActivityFn.calls` for metric-mode case.

**Section D.2 — R-MJU-1: judge_timeout vs stall distinction (slot 1s)**

- **AC-MJU-1** (AC7) — Two consecutive `measureLlmMetric` timeouts exit with `exit_reason: 'judge_timeout'`, not `converged`. Verify: unit spec `measureLlmMetric timeout escalates to judge_timeout exit` passes.
- **AC-MJU-2** (AC8) — Baseline timeout exits with `exit_reason: 'baseline_unmeasurable'`, not `defaulting to 0`. Verify: unit spec `baseline measurement failure exits non-zero` passes.
- **AC-MJU-3** (AC9) — Retry uses `[10s, 30s, 60s]` exponential backoff with 3 attempts max. Verify: unit spec `measureLlmMetricWithBackoff schedule matches [10000, 30000, 60000]` passes.
- **AC-MJU-4** (AC10) — Worker-managed phases (anatomy-park, szechuan-sauce) propagate `judge_timeout` to pipeline-runner as exit code 1. Verify: integration spec `pipeline-runner halts on judge_timeout from worker phase` passes.
- **AC-MJU-5** (AC11) — `state.json` and `microverse.json` record the timeout reason in `exit_reason` distinctly from `converged`. Verify: spec asserts `exit_reason ∈ {'judge_timeout','baseline_unmeasurable'}` for the timeout cases.
- **AC-MJU-6** (AC12) — `claude --version` and `codex --version` smoke-call probe runs before the first judge invocation; absence fails fast with `exit_reason: 'judge_cli_missing'`. Verify: unit spec `judge CLI presence is verified at session start` passes.

---

## Section E — Local ACs *(lifted from prds/archive/bug-reports/p2-remove-pipeline-wall-clock-time-cap.md)*

*(refined: prds/archive/bug-reports/p2-remove-pipeline-wall-clock-time-cap.md)*

Lead requirements: **R-NTC-1** (stop writing default), **R-NTC-2** (state-field invariant flip). Source files at HEAD: `extension/src/bin/setup.ts:107` (timeLimit default), `extension/src/bin/mux-runner.ts:1911,2625,2876`, `extension/src/bin/microverse-runner.ts:1417`, `extension/src/hooks/handlers/stop-hook.ts:134,260`, `extension/src/services/codex-manager-relaunch.ts:75`. `pickle_settings.json` (root).

- **AC-NTC-01** — `grep -rn 'default_max_time_minutes' extension/src/ pickle_settings.json` returns zero matches.
- **AC-NTC-02** — Fresh `setup.js` invocation without `--max-time` produces a `state.json` with no `max_time_minutes` key.
- **AC-NTC-03** — Mux-runner started with no `state.max_time_minutes` runs for at least 60 minutes simulated wall-clock without emitting `exit_reason='limit'`.
- **AC-NTC-04** — Microverse-runner same.
- **AC-NTC-05** — Stop-hook returns approve at 13 simulated hours elapsed when no cap set.
- **AC-NTC-06** — Rate-limit wait of 4h completes uninterrupted when no cap set.
- **AC-NTC-07** — `state-field-invariants.test.js` asserts `max_time_minutes` is optional non-negative integer.
- **AC-NTC-08** — `extension/CLAUDE.md` `## state.json Field Invariants` entry for `max_time_minutes` and `mux-runner.ts (deactivation)` trap-door reflect the new contract.
- **AC-NTC-09** — `time_cap_disabled_default` activity event registered in `VALID_ACTIVITY_EVENTS` and emitted on fresh-session no-cap setup.
- **AC-NTC-10** — Existing test that asserts cap-fires-at-N-min preserved by explicitly setting `state.max_time_minutes` in test setup; coverage for opt-in path unchanged.
- **AC-NTC-11** — Resumed session with persisted `max_time_minutes > 0` still enforces (regression test resumes a session with cap=120min and asserts `limit` exit at 120min).
- **AC-NTC-12** — `prds/archive/bundles/large-pipeline-time-budget-undersized.md` AC-LPB-07 footer updated to SUPERSEDED.

---

## Section F — Local ACs *(lifted from prds/archive/bug-reports/p2-manager-stop-hook-nudge-cadence-wastes-turns.md)*

*(refined: prds/archive/bug-reports/p2-manager-stop-hook-nudge-cadence-wastes-turns.md)*

Lead requirements: **R-MSCN-1** (`WAIT_PATTERN_REGEXES`), **R-MSCN-2** (idle-backoff state machine). Source file at HEAD: `extension/src/hooks/handlers/stop-hook.ts` (554 lines). New symbols `WAIT_PATTERN_REGEXES` and `detectDegenerateResponse` are forward-created (zero hits at HEAD via `git grep -n 'WAIT_PATTERN_REGEXES' extension/src/`). `pickle_settings.json` gains `manager_idle_backoff_fallback_ms`.

Test files (forward-created): `extension/tests/stop-hook-idle-backoff.test.js`, `extension/tests/integration/manager-turn-budget-large-worker.test.js`. Extension: `extension/tests/stop-hook-state-matrix.test.js` (exists at HEAD).

- **AC-MSCN-01** — `stop-hook.ts` detects ≥3 consecutive wait-pattern turns and enters idle-backoff mode.
- **AC-MSCN-02** — Idle-backoff exits on state.json mtime change. Verified by unit test that touches state.json mid-backoff.
- **AC-MSCN-03** — Idle-backoff exits on worker artifact landing. Verified by test that creates a `conformance_*.md` mid-backoff.
- **AC-MSCN-04** — Idle-backoff exits on worker PID exit. Verified by test that mock-kills a worker PID.
- **AC-MSCN-05** — Idle-backoff exits on fallback timer (60s default). Verified by simulated-clock test.
- **AC-MSCN-06** — `manager_idle_backoff_engaged` + `_released` events registered + emitted with correct payloads.
- **AC-MSCN-07** — Forensic replay test: 60min simulated worker wait keeps manager turn count ≤ 80 (down from ~270).
- **AC-MSCN-08** — Trap-door entry exists for `stop-hook.ts (idle backoff)` with INVARIANT/BREAKS/ENFORCE.
- **AC-MSCN-09** — `manager_idle_backoff_fallback_ms` setting reads/writes correctly + validates via `setup.ts`.

---

## Section G — Local ACs *(lifted from prds/archive/bug-reports/p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md)*

*(refined: prds/archive/bug-reports/p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md)*

Lead requirement: **R-SHB-1** (stop-hook tmux_mode default-fallthrough fix). Source files at HEAD: `extension/src/hooks/handlers/stop-hook.ts:198-203` (default-fallthrough), `extension/src/services/state-manager.ts` (`recoverStaleActiveFlag`), `extension/src/hooks/resolve-state.ts` (mapped-session filter).

Test files (forward-created): `extension/tests/stop-hook-tmux-passthrough.test.js` (R-SHB-4), `extension/tests/services/recover-stale-active-flag-mapped-orphan.test.js` (R-SHB-2). Extension: `extension/tests/resolve-state.test.js` (exists at HEAD), `extension/tests/services/resolve-state-paused-orphan.test.js` (exists at HEAD).

- **AC-SHB-01** — Launcher conversation for a tmux-owned loop receives APPROVE decision on stop. Type: test. Fixture: `state.tmux_mode=true`, `state.active=true`, no tokens in transcript → result.decision === 'approve'.
- **AC-SHB-02** — Orphan session with `state.active=true`, `state.pid=null`, mapped PID dead → demoted on next state read. Verify: regression fixture in `extension/tests/services/recover-stale-active-flag-mapped-orphan.test.js` (forward-created). Type: test.
- **AC-SHB-03** — Mapped-session filter skips orphan + ranks live-same-cwd fallback above. Verify: extend `extension/tests/resolve-state.test.js` with mapped-orphan fixture. Type: test.
- **AC-SHB-04** — Trap-door enforced. Type: lint.
- **AC-SHB-05** — E2E: launch a fresh tmux pipeline session, observe launcher chat NOT blocked by stop-hook. Type: integration.

---

## Section H — Local ACs *(lifted from prds/archive/bug-reports/p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md)*

*(refined: prds/archive/bug-reports/p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md)*

Lead requirements: **R-PDT-1** (dirty-allowed list — stop writing ephemeral data to tracked evidence file), **R-PDT-2** (stable verify-recapture digest — pipeline-runner consults `.gitignore` + config list). Source file at HEAD: `extension/src/bin/pipeline-runner.ts:75` (`DEFAULT_IGNORE_DIRTY_PATHS: readonly string[] = ['prds', 'docs']`).

Note: `extension/src/services/verify-recapture-fired.ts` does NOT exist at HEAD; actual recapture event symbols are at `extension/src/bin/microverse-runner.ts:340,427-459` (`baseline_recapture_attempted`, `baseline_recapture_succeeded`, `baseline_recapture_failed`). R5 risk row's reference to `verify-recapture-fired` is a forward-reference (forward-created by R-PDT-1 or a sibling ticket).

Test files (forward-created): `extension/tests/integration/pipeline-runner-dirty-tree-guard.test.js` (R-PDT-4).

- **AC-PDT-01** — After R-PDT-1 lands, `bundle/ac-dr-02.json` is no longer modified by a clean test run. Verify: `cd extension && npm run test:fast && git diff --quiet bundle/ac-dr-02.json`. Type: integration.
- **AC-PDT-02** — Dirty-tree guard ignore list consults `.gitignore`. Verify: regression fixture adds a tracked file `foo.txt`, gitignores it, leaves it dirty, launches pipeline-runner; runner exits 0 (not FATAL). Type: test.
- **AC-PDT-03** — Stderr on FATAL dirty-tree includes specific file list (one filename per line). Type: test.
- **AC-PDT-04** — Trap-door enforced. Type: lint.

---

## Section I — Local ACs *(lifted from prds/archive/bug-reports/p3-test-flakes-council-publish-and-scope-resolver.md)*

*(refined: prds/archive/bug-reports/p3-test-flakes-council-publish-and-scope-resolver.md)*

Lead requirement: **flake-stabilization** on two failing tests. Source test files at HEAD: `extension/tests/council-publish.test.js:867`, `extension/tests/scope-resolver-import-walks.test.js:111`.

Note: F2 (`scope-resolver-import-walks.test.js`) was resolved in commit `e331fab7` per the PRD; refinement should confirm current green status at HEAD before authoring tickets, as the AC may already be ALREADY-SHIPPED.

- **AC-TF-1** — F1 passes: hung call counted as 1 failed, second call as 1 posted; elapsed < 10s. Verify by running the test in isolation 10× consecutively — must be 10/10 green.
- **AC-TF-2** — F2 passes: `rg/fail` warning emitted, result is `['a.ts', 'b.ts']`. Verify by running the parent `computeOneHop import walks` suite — must be 4/4 green.
- **AC-TF-3** — Full release gate is clean: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` exits 0.
- **AC-TF-4** — Diagnose root cause first (don't just bump timeouts again). Document the actual fix in commit message: what was misclassified / what warning was dropped, why prior timing-bump fixes missed it.

---

## Section J — Local ACs

*(No peer PRD — bundle thesis matrix update only; no implementation tickets; no ACs to lift.)*

Section J is a documentation-only task: update `prds/bundle-thesis-matrix.md` with this bundle's row and confirm per-source-PRD AC→ticket coverage is 100% per AC-BUNDLE-2026-05-05-02. Refinement authors this as a single small doc ticket.

---

## Section CF — Local ACs *(lifted from prds/archive/bundles/p1-bug-fix-bundle-2026-05-04.md)*

*(refined: prds/archive/bundles/p1-bug-fix-bundle-2026-05-04.md)*

Lead requirements from carry-forward bundle: **AC-TAQ-09**, **R-BUNDLE-1**, **R-BUNDLE-2**, **R-BUNDLE-DISPO-1** (plus CF-WIRE, CF-HARDEN-CODE, CF-AUDIT-DATAFLOW, CF-HARDEN-TESTS, CF-AUDIT-XREF which are described inline in the bundle PRD above and have no separate AC blocks in the source PRD).

Source files: `extension/src/bin/audit-ticket-bundle.ts:19-27` (DefectClass enum — 8 classes), `extension/tests/fixtures/audit-ticket-bundle/` (1 fixture at HEAD), `extension/src/bin/mux-runner.ts:3034,3056` (`skip_readiness_reason`, `skip_ticket_audit_reason`), `extension/src/types/index.ts:136,141` (same flags). Forward-created: `extension/src/data/bundle-disposition-2026-05-04.json`.

**AC-TAQ-09** *(from p1-bug-fix-bundle-2026-05-04.md:280)*
- **AC-TAQ-09** — Defective fixture in `extension/tests/fixtures/audit-ticket-bundle/defective/` (forward-created) enumerates exactly one ticket per defect class (8 fixtures per `audit-ticket-bundle.ts:19-27` enum: `path-drift`, `self-reference`, `missing-deps`, `wrong-HEAD-assumptions`, `cross-doc-naming`, `cross-doc-naming-drift`, `hallucinated-premise`, `literal-value-drift`); audit produces 8 findings, severity `fatal`. Clean fixture → zero findings. Type: test.

**R-BUNDLE-1** *(from p1-bug-fix-bundle-2026-05-04.md — Bundle-level requirements, line 351)*
- Implementation requirement: `state.flags.bundle_bootstrap_mode` flag with hardcoded session-hash allowlist. Auto-applies BOTH `skip_readiness_reason` + `skip_ticket_audit_reason`. Activity event `bundle_bootstrap_exemption_applied`.
- **Acceptance**: `bundle_bootstrap_exemption_applied` event emitted with payload `{skip_readiness_reason, skip_ticket_audit_reason}` (schema at `activity-events.schema.json`); `state.flags.bundle_bootstrap_mode` present in `State` type; mux-runner early-init path wires auto-apply. Verify: unit test for bootstrap-mode flag auto-application + event emission.

**R-BUNDLE-2** *(from p1-bug-fix-bundle-2026-05-04.md — Bundle-level requirements, line 352)*
- Implementation requirement: Snapshot `~/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/` to `extension/tests/fixtures/baseline-2026-05-03-7d9ee8cc/`. Partial — fixture dir exists with sub-dirs `aa001122/`, `bb112233/`, `cc223344/`; refinement should validate completeness against R-XBL-6 + R-TAQ-6 ACs.
- **Acceptance**: `git ls-files extension/tests/fixtures/baseline-2026-05-03-7d9ee8cc/` returns the expected sub-dirs; R-XBL-6 and R-TAQ-6 audit scripts run against the snapshot successfully.

**R-BUNDLE-DISPO-1** *(from p1-bug-fix-bundle-2026-05-04.md — Bundle-level requirements, line 353)*
- Implementation requirement: Disposition table JSON at `extension/src/data/bundle-disposition-2026-05-04.json` (forward-created; 52 IMPL + 1 DROP + 1 RTO entries per prior bundle). Read by refinement-team analyst prompts (R-TAQ-1, R-XBL-9) and audit-ticket-bundle (R-TAQ-2).
- **Acceptance**: `git ls-files extension/src/data/bundle-disposition-2026-05-04.json` returns one hit; `audit-ticket-bundle.ts` reads the file and exempts `REGRESSION-TEST-ONLY`/`DROP` tickets from `hallucinated-premise` check.
