---
title: P2 — Forward-reference annotation parity drift between readiness gate and audit-ticket-bundle
status: Draft
filed: 2026-05-14
priority: P2
type: bug
r_code_prefix: R-FRA
backend_constraint: any
related:
  - prds/archive/bug-reports/p2-refine-prd-skill-missing-rtrc7-annotation-reminder.md  # R-RTRC-7 refinement-skill side (related, not duplicate)
---

# P2 — Forward-reference annotation regexes diverge between readiness gate and audit-ticket-bundle gate

## Symptom

When launching a refined bundle whose tickets legitimately reference forward-created paths (e.g. R-TSPF-1's `extension/tests/.serial-tests-fast.json`, R-TSPF-7's `.github/workflows/stability-gate.yml`), pipeline launch fails with TWO independent gate halts that require TWO independent operator skip flags:

1. `READINESS HALT: check-readiness exited 2; no manager spawn attempted` — annotated path with `(created by R-TSPF-1)` rejected by `check-readiness.js` because its regex expects `(forward-created)` literal OR `(created|introduced) by ticket <8-12-char-hash>` OR `(created by R-<CODE>-N)`. Operator must set `state.flags.skip_readiness_reason`.
2. `TICKET AUDIT HALT: audit-ticket-bundle exited 1; defects found — no manager spawn attempted` — same paths rejected by `audit-ticket-bundle.js` as `path-drift` fatals. Operator must additionally set `state.flags.skip_ticket_audit_reason`.

Witnessed in pipeline `2026-05-13-b54f2143` launching the R-TSPF bundle:
- First launch: hit gate (1), set `skip_readiness_reason`, relaunched.
- Second launch: hit gate (2), set `skip_ticket_audit_reason`, relaunched.
- Both flag bodies contained the same justification text — "refinement team pre-validated; forward-references are intentional".

R-RTRC-7 (`prds/archive/bug-reports/p2-refine-prd-skill-missing-rtrc7-annotation-reminder.md`) addresses the *refinement-skill* side (worker prompt now reminds authors to use the canonical annotation). This PRD addresses the *gate-side* parity: the audit-bundle regex and the readiness regex MUST accept the same annotation grammar, OR a single skip flag MUST cover both gates.

## Root cause (hypothesis to verify)

`extension/src/bin/audit-ticket-bundle.ts::checkPathDrift` parses ticket bodies looking for paths and compares them against `git ls-files`. R-RTRC-7 was supposed to align this with the prompt + readiness grammar (`prds/audit-ticket-bundle-r-rtrc-7-path-annotation-parity.md` or similar — verify name), but the actual deployed regex was not verified against the readiness regex symmetrically. Possible drifts:
- Readiness accepts `(created by R-TSPF-1)`; audit-bundle does not.
- Annotation must be inside backticks for one gate, outside for the other.
- Hash length range differs (`6-12` vs `8-12`).
- "Forward-created" requires hyphenation in one, not the other.

## Functional requirements (verified post-implementation)

- **FR-1**: A single PRD-author-friendly annotation form is documented in `prds/CLAUDE.md` (or wherever bundle conventions live) and accepted by BOTH `check-readiness.js` AND `audit-ticket-bundle.js` with byte-identical predicate. Reference implementation: `extension/src/services/forward-ref-annotation.ts` exporting `isForwardReferenceAnnotation(path: string, body: string): boolean` — both gates call it.
- **FR-2**: Operator no longer needs to set BOTH `skip_readiness_reason` AND `skip_ticket_audit_reason` for a bundle whose forward-references are correctly annotated.
- **FR-3**: A regression test in `extension/tests/forward-ref-annotation-parity.test.js` constructs a fixture ticket body with one of each accepted annotation form and asserts both gates accept it.

## Acceptance criteria

- **AC-1**: A bundle whose tickets use `` `<path>` (forward-created) ``, `` `<path>` (created by R-<CODE>-N) ``, OR `` `<path>` (created by ticket <8-12-char-hash>) `` for every cited forward-path passes BOTH gates with NO `skip_*_reason` flags set — Verify: launch the R-TSPF bundle re-test fixture, gate exit codes are 0/0 — Type: integration
- **AC-2**: A bundle whose tickets use an *invalid* annotation (typo, wrong hash format, missing parens) fails BOTH gates identically — Verify: same fixture with corrupted annotation; both gates exit non-zero with byte-identical findings — Type: integration
- **AC-3**: Shared predicate module `extension/src/services/forward-ref-annotation.ts` is the SINGLE source of truth — Verify: `grep -E "forward.?created|created (by ticket|by R-)" extension/src/bin/check-readiness.ts extension/src/bin/audit-ticket-bundle.ts` shows no inline regex matches (only imports of the shared module) — Type: lint
- **AC-4**: `prds/CLAUDE.md` documents the canonical annotation grammar with one example per accepted form — Verify: grep — Type: lint
- **AC-5**: Release gate passes — Verify: `cd extension && npx tsc --noEmit && npm run test:fast && npm run test:integration` — Type: test

## Out of scope

- Removing the gates themselves (both are load-bearing — they catch real path drift).
- Changing the annotation grammar (use whatever the readiness gate already accepts; audit-bundle aligns to it).
- Refactoring `audit-ticket-bundle.ts` beyond the predicate-extraction.

## Why this is P2 (not P1)

The bundle CAN ship — operator sets two flags and relaunches. The cost is ~5 minutes per bundle. Compare to R-CCPL (slot G) which costs ~80 min per ticket and recurs 3-8× per bundle. This is friction, not blocker. But it's cheap to fix (~half-day) and removes operator-as-the-integration-test friction from every codex pipeline.

## Implementation order

- **R-FRA-1**: Extract `isForwardReferenceAnnotation()` predicate from both gate files into `extension/src/services/forward-ref-annotation.ts`.
- **R-FRA-2**: Wire both gates to import the shared predicate.
- **R-FRA-3**: Regression test fixture covering all three accepted forms + corruption negative cases.
- **R-FRA-4**: Document grammar in `prds/CLAUDE.md`.

## Downstream when shipped

- Operator unattended runs (like `2026-05-13-b54f2143`) launch without the two-flag-set friction.
- New PRDs that include forward-references no longer trip gate-asymmetry on their first launch.
- Sister PRD R-RTRC-7 + this PRD together close the prompt→readiness→audit-bundle annotation chain.
