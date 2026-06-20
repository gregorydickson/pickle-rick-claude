---
title: P1 — Bug-fix bundle B-FRA 2026-05-23 — forward-ref annotation enforcement (composes 4 source PRDs, 5th recurrence)
status: Draft
filed: 2026-05-23
priority: P1
type: bug-bundle
r_code_prefix: R-FRA
composes:
  - prds/archive/bug-reports/p2-refined-tickets-trip-readiness-contract-resolver.md
  - prds/archive/bug-reports/p2-refine-prd-skill-missing-rtrc7-annotation-reminder.md
  - prds/archive/bug-reports/p2-forward-ref-annotation-readiness-vs-audit-bundle-drift.md
  - prds/archive/bug-reports/BUG-REPORT-2026-05-23-readiness-rejects-forward-created-tickets.md
related:
  - prds/MASTER_PLAN.md
backend_constraint: any
refine: true
unattended: true
remediation_phases_required: ["citadel", "anatomy-park", "szechuan-sauce"]
---

# PRD — Bug-Fix Bundle B-FRA 2026-05-23 — Forward-Ref Annotation Enforcement

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Why this bundle

Fifth recurrence of the same halt class in 21 days. Every creation-heavy pipeline launch trips `check-readiness.ts`'s `extractContractReferences` on forward-created paths, throws 30+ `file_path` findings, and halts pickle phase before a single worker spawns. Operator unblocks via `state.flags.skip_quality_gates_reason` every time (see `prds/archive/bug-reports/BUG-REPORT-2026-05-23-readiness-rejects-forward-created-tickets.md:35`).

| Date | Session | Bundle | Workaround |
|---|---|---|---|
| 2026-05-02 | `2026-05-02-fca7952b` | mega bundle | `skip_readiness_reason` |
| 2026-05-03 | `2026-05-03-7d9ee8cc` | reliability-and-test-coverage | filed PRD #1 of composes |
| 2026-05-10 | `2026-05-10-84ad0873` | R-SLLJ / R-MDS | filed PRD #2 of composes |
| 2026-05-13 | `2026-05-13-b54f2143` | R-TSPF | filed PRD #3 of composes |
| **2026-05-23** | **`2026-05-23-17b2f716`** | **B-PROJECT-AUDIT (46 tickets)** | **`skip_quality_gates_reason` + filed PRD #4** |

Root cause is shipped where the gate runs (`check-readiness.ts` annotation grammar — see `extension/CLAUDE.md` R-RTRC-1..7 trap doors, line 48 onward: `extractContractReferences`, `createResolverCache`, `resolvePathRef`, `loadReadinessAllowlist`, fixture coverage). Gap is ticket-author-side: refinement skill never reminds ticket authors to add the annotation, and no pre-flight script audits ticket bodies before launch. Bundle closes the author + pre-flight gap so operators stop needing the skip flag for legitimate forward-creating bundles.

The 4 source PRDs stay Draft. This bundle is what ships. Source PRDs are registered as Open Findings #66 / #67 / #68 / #69 in `prds/MASTER_PLAN.md` and will be closed by this bundle's closer.

| Section | Source PRD | Open Finding |
|---|---|---|
| **B** | prds/archive/bug-reports/p2-refined-tickets-trip-readiness-contract-resolver.md (parent root-cause, 2026-05-03) | #66 |
| **C** | prds/archive/bug-reports/p2-refine-prd-skill-missing-rtrc7-annotation-reminder.md (ticket-author gap, 2026-05-10) | #67 |
| **D** | prds/archive/bug-reports/p2-forward-ref-annotation-readiness-vs-audit-bundle-drift.md (gate parity, 2026-05-14) | #68 |
| **E** | prds/archive/bug-reports/BUG-REPORT-2026-05-23-readiness-rejects-forward-created-tickets.md (5th recurrence attestation, 2026-05-23) | #69 |

## Bundle thesis

> "A creation-heavy bundle MUST pass readiness pre-flight without the operator setting `state.flags.skip_quality_gates_reason` — either the ticket carries the canonical annotation (refinement skill reminder + pre-flight audit), or persona auto-sets the skip flag with a finding-count-cited reason, and both gates share one predicate."

If a section's fix isn't structurally aligned with that thesis, drop it. `bash extension/scripts/audit-bundle-thesis.sh` enforces.

## Drift sweep (verified at HEAD `59810646`)

The 4 source PRDs predate substantial shipping. Drift sweep against HEAD before refinement:

**CONFIRMED SHIPPED — do NOT re-include as work:**
- `extension/src/bin/check-readiness.ts` already enforces R-RTRC-1..7: `extractForwardRefAnnotations`, `FORWARD_REF_ANNOTATION_RE`, tests/ in `trackedSourceFiles`, `git ls-files` suffix-match fallback, `loadReadinessAllowlist(repoRoot)` reads `extension/.readiness-allowlist.json`, 3-fixture coverage in `extension/tests/check-readiness-forward-ref-fixture.test.js` (pinned by `extension/CLAUDE.md` trap-door entries).
- `extension/src/bin/audit-ticket-bundle.ts` `checkPathDrift` accepts the same annotations as readiness (R-RTRC-7 path-parity trap door, `extension/CLAUDE.md:25`).
- `extension/src/bin/spawn-refinement-team.ts:188` `PATH_VERIFICATION_PROMPT_SECTION` exports analyst-side wording starting `## Path Verification & Forward-reference hygiene` (R-RTRC-1).
- `extension/scripts/audit-readiness-allowlist.sh` exists.
- `state.flags.skip_quality_gates_reason` unified flag (R-QGSK-2) is the supported override path.

**OPEN — this bundle's work (HEAD verified):**
- `.claude/commands/pickle-refine-prd.md` Step 7c contains zero matches for `Forward-reference`, `🚦`, `R-RTRC-7`, or `forward-ref` (grep at HEAD: 0 hits). Ticket authors get no reminder. → R-FRA-1.
- `extension/scripts/audit-ticket-forward-refs.sh` does not exist at HEAD. No pre-flight enforcement. → R-FRA-2.
- `extension/src/bin/check-readiness.ts` does not look for `Files to create` / `Files to modify` section markers (grep at HEAD: 0 hits). The structural-declaration heuristic from `p2-forward-ref-annotation-readiness-vs-audit-bundle-drift.md` AC-3 is not shipped. → R-FRA-3 alternative (subsumed into persona auto-set heuristic below).
- `extension/src/services/forward-ref-annotation.ts` does not exist at HEAD. Both gates carry independent inline regex (drift risk per source PRD #3). → optional R-FRA-6 if shared module is preferred over two-call drift audit.

## Bundle-level acceptance criteria

Wrapper-level checks. Per-ticket acceptance bars live in each refined ticket. R-codes use the `R-FRA-N` namespace claimed by source PRD #4.

- [ ] **AC-FRA-01** — `.claude/commands/pickle-refine-prd.md` contains the literal token `🚦 Forward-reference hygiene` in Step 7c. Verify: `grep -c "🚦 Forward-reference hygiene" .claude/commands/pickle-refine-prd.md` ≥ 1.
- [ ] **AC-FRA-02** — `extension/scripts/audit-ticket-forward-refs.sh` exists, is executable (`test -x`), exits 0 on a fixture bundle with all forward-refs annotated, exits non-zero (≠0) on a fixture bundle with at least one bare backticked forward-created path.
- [ ] **AC-FRA-03** — `extension/tests/audit-ticket-forward-refs.test.js` exists, is fixture-driven, and is registered in the `test:fast` tier via `extension/scripts/audit-test-tiers.sh`.
- [ ] **AC-FRA-04** — `extension/tests/spawn-refinement-team-step7c-annotation-reminder.test.js` exists and asserts the literal token from AC-FRA-01 is present in the deployed `pickle-refine-prd.md` skill prompt.
- [ ] **AC-FRA-05** — A creation-heavy fixture bundle of ≥10 tickets (≥80% forward-creating files under `extension/tests/` or `extension/scripts/`) passes `node ~/.claude/pickle-rick/extension/bin/check-readiness.js` with exit 0 AND with `state.flags.skip_quality_gates_reason` unset OR auto-set by persona Step 0 with a reason string that cites a numeric finding-count threshold.
- [ ] **AC-FRA-06** — `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0. All existing R-RTRC-1..7 trap doors in `extension/CLAUDE.md` remain pinned and green; new R-FRA trap doors (see below) are pinned with ENFORCE + PATTERN_SHAPE rows.
- [ ] **AC-FRA-07** — Closer commit body lists Open Findings #66, #67, #68, #69 closed in `prds/MASTER_PLAN.md`; active queue renumbered; new R-FRA trap-door count reflected in the trap-door summary line.
- [ ] **AC-FRA-08** — `prds/CLAUDE.md` documents the canonical annotation grammar with one worked example per accepted form (`(forward-created)`, `(created by ticket <hash>)`, `(introduced by ticket <hash>)`). Verify: `grep -c "forward-created" prds/CLAUDE.md` ≥ 1 AND `grep -c "created by ticket" prds/CLAUDE.md` ≥ 1.
- [ ] **AC-FRA-09** — Bundle thesis check (`bash extension/scripts/audit-bundle-thesis.sh`) exits 0; no ticket adds a feature, refactor, or gate relaxation outside the thesis.

## Trap-door touchpoints

This bundle TOUCHES (must not break) the following pinned trap-door entries in `extension/CLAUDE.md`:

- **R-RTRC-1** — `PATH_VERIFICATION_PROMPT_SECTION` in `extension/src/bin/spawn-refinement-team.ts:188`. R-FRA-1 (skill prompt reminder) MUST stay structurally aligned with this analyst-side wording; the operator-side Step 7c reminder is the same canonical grammar.
- **R-RTRC-2 / R-RTRC-7** — `extractForwardRefAnnotations` + `FORWARD_REF_ANNOTATION_RE` in `check-readiness.ts`. Annotation grammar is frozen; no R-FRA ticket may widen or narrow it.
- **R-RTRC-3** — `createResolverCache` includes `extension/tests/**` in `trackedSourceFiles`. R-FRA-3 (persona auto-set heuristic) MUST NOT remove tests/ from the resolver scope.
- **R-RTRC-4** — `resolvePathRef` `git ls-files` suffix-match fallback. R-FRA-2 (audit script) MUST NOT shadow or duplicate this fallback in its own resolver.
- **R-RTRC-5** — `loadReadinessAllowlist(repoRoot)` + `extension/.readiness-allowlist.json`. R-FRA-2 audit script MAY consult the allowlist but MUST NOT bypass it.
- **R-RTRC-6** — Three-fixture coverage in `extension/tests/check-readiness-forward-ref-fixture.test.js`. R-FRA-2's new fixtures live under a NEW test file; they MUST NOT mutate the existing fixture set.
- **R-RTRC-7** — `audit-ticket-bundle.ts` `checkPathDrift` path-parity. If R-FRA-6 lands (shared predicate module), `audit-ticket-bundle.ts` MUST be migrated to import from it to preserve parity.

This bundle ADDS the following trap-door entries (worker MUST pin these in `extension/CLAUDE.md` before commit):

- **R-FRA-1 trap door** — Pin Step 7c reminder text at `.claude/commands/pickle-refine-prd.md`. ENFORCE: `extension/tests/spawn-refinement-team-step7c-annotation-reminder.test.js`. PATTERN_SHAPE: `🚦 Forward-reference hygiene|Forward-reference hygiene`.
- **R-FRA-2 trap door** — Pin pre-flight audit at `extension/scripts/audit-ticket-forward-refs.sh`. ENFORCE: `extension/tests/audit-ticket-forward-refs.test.js`. PATTERN_SHAPE: canonical annotation grammar `\\((forward-created|created by ticket [a-f0-9]+|introduced by ticket [a-f0-9]+)\\)`.
- **R-FRA-6 trap door (conditional)** — Only if R-FRA-6 lands. Pin `extension/src/services/forward-ref-annotation.ts` as single source of truth. ENFORCE: `extension/tests/forward-ref-annotation-shared-predicate.test.js`. PATTERN_SHAPE: imports MUST appear in BOTH `check-readiness.ts` and `audit-ticket-bundle.ts`; inline `FORWARD_REF_ANNOTATION_RE` literals MUST NOT appear in either consumer.

## Ticket sizing (sketch — refinement produces the final atomic set)

All tickets MUST be <30min worker time, <5 files, <4 ACs, single-touchpoint. Refinement is responsible for splitting any ticket that drifts past those limits.

| ID | Size | Scope |
|---|---|---|
| **R-FRA-1** | S (~15min) | `.claude/commands/pickle-refine-prd.md` Step 7c prepends `🚦 Forward-reference hygiene` reminder block with one canonical annotation example per accepted form. Trap door pinned. Test: `extension/tests/spawn-refinement-team-step7c-annotation-reminder.test.js`. |
| **R-FRA-2** | M (~25min) | New `extension/scripts/audit-ticket-forward-refs.sh` pre-flight audit + fixture set + `extension/tests/audit-ticket-forward-refs.test.js`. Audit scans `${SESSION_ROOT}/<ticket>/ticket.md` files, greps backticked paths, flags unannotated forward-refs. Exit-2 contract matches `check-readiness.ts`. Trap door pinned. |
| **R-FRA-3** | M (~25min) | Persona Step 0 auto-sets `state.flags.skip_quality_gates_reason` for creation-heavy bundles. Heuristic: ticket count > 10 AND > 50% of post-refinement tickets declare forward-creating files under `extension/tests/` or `extension/scripts/`. Reason string MUST cite the numeric thresholds it tripped (e.g. `"creation-heavy bundle: 46 tickets, 38/46 forward-creating under extension/tests/"`). Test: persona-step0-creation-heavy-skip.test.js. |
| **R-FRA-4** | S (~15min) | `prds/CLAUDE.md` documents the canonical annotation grammar with one worked example per accepted form. Satisfies source PRD #3 AC-4 and AC-FRA-08. |
| **R-FRA-5-CLOSER** | S (~15min) | MASTER_PLAN bookkeeping — close Open Findings #66, #67, #68, #69; renumber Active Queue; bump trap-door count in the summary line. Closer commit body lists each closed finding. (See Closer behavior below for release-gate run.) |
| **R-FRA-6** (OPTIONAL) | M (~30min) | Extract `extension/src/services/forward-ref-annotation.ts` shared predicate module. Migrate both `check-readiness.ts` and `audit-ticket-bundle.ts` to import from it. New trap door pins single source of truth. Refinement decides whether to include based on drift-risk severity and time budget. |

## Pre-flight checklist

1. Working tree clean. Only untracked PRDs and refinement artifacts tolerated; no in-flight worker edits to `extension/src/`.
2. HEAD on `main` (no feature-branch operation).
3. No prior pipeline session attached: `tmux ls 2>/dev/null | grep -E '^(pipeline|monitor-aux|refine)-' | head -1` returns empty.
4. `extension/scripts/audit-trap-door-enforcement.sh` exits 0 at preflight (existing R-RTRC-1..7 entries already green — verified at HEAD `59810646`).
5. `PLUMBUS_GENERATIVE_AUDIT` not set to `"off"`.
6. Operator does NOT set `state.flags.skip_quality_gates_reason` at launch. Bundle's own refined ticket set is the live test for AC-FRA-05.

## Risk Register

- **R1** — Persona auto-set of `skip_quality_gates_reason` (R-FRA-3) could hide real readiness regressions if the heuristic is too loose. Mitigation: the reason string MUST cite a numeric finding-count threshold (e.g. `"creation-heavy bundle: 46 tickets, 38/46 forward-creating"`), and the threshold values MUST appear in the persona-step0 test fixtures. Auto-set is a documented downgrade, never silent.
- **R2** — R-FRA-2 audit script could mask real bugs by over-broadening its annotation regex relative to `check-readiness.ts`. Mitigation: R-FRA-6 (if landed) pins a single predicate source; if R-FRA-6 is deferred, the audit script's regex MUST be a copy-pasted literal of `FORWARD_REF_ANNOTATION_RE` and a drift test (`extension/tests/audit-ticket-forward-refs-regex-parity.test.js`) MUST assert byte-equality.
- **R3** — Refinement reminder (R-FRA-1) lands inside the same pipeline that runs B-FRA itself. THIS bundle's refinement runs on the pre-R-FRA-1 prompt and will not benefit from the reminder. Only post-bundle work benefits. Acknowledged.
- **R4** — Tests/ included in `trackedSourceFiles` (R-RTRC-3 trap door) means any widening of the resolver scope risks masking real bugs. Mitigation: existing trap door + R-FRA-3 explicitly forbidden from touching `createResolverCache`.
- **R5** — `audit-ticket-bundle.ts` path-parity (R-RTRC-7) means R-FRA-2's audit script effectively becomes a third gate. Mitigation: by design — pre-flight is intentionally redundant with both runtime gates. The audit script's exit contract MUST match readiness's exit-2 to keep operator mental model consistent.

## Closer behavior (R-FRA-5-CLOSER)

- Version bump: source `extension/package.json` minor (new operator-visible Step 7c reminder + new audit script + new persona Step 0 behavior).
- Run canonical release gate: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`.
- `bash install.sh --closer-context`; verify md5-parity between source and deploy for all compiled JS + skill prompts.
- MASTER_PLAN bookkeeping: close Open Findings #66, #67, #68, #69; archive PRD entries; renumber active queue; update trap-door count summary.
- Closer commit body lists each closed Open Finding by number and references this bundle PRD path.
- `gh release create vX.Y.0` only if the release-gate run is fully green (no inherited residuals expected — verify at preflight).

## What this bundle does NOT do

- It does NOT refactor `extension/src/bin/check-readiness.ts`. The shipped annotation grammar (R-RTRC-2/7) is frozen.
- It does NOT remove or relax the readiness gate. The gate stays loud.
- It does NOT widen, narrow, or change the annotation grammar accepted by `FORWARD_REF_ANNOTATION_RE`. Tickets MUST conform to existing grammar.
- It does NOT touch `state.flags.skip_quality_gates_reason` plumbing (R-QGSK-2 already shipped). R-FRA-3 only adds a persona-side auto-set heuristic that writes to the existing flag.
- It does NOT remediate any unrelated Open Finding. Other findings remain on MASTER_PLAN's active queue.
- It does NOT add backwards-compat shims or legacy aliases. Greenfield project, single forward grammar.

## Triggering session

`/pickle-pipeline prds/archive/bundles/p1-bug-fix-bundle-b-fra-forward-ref-annotations-2026-05-23.md`

Session ID assigned at launch as `2026-05-23-<8-char-hash>`. Backend unconstrained (`backend_constraint: any`); operator picks at launch.
