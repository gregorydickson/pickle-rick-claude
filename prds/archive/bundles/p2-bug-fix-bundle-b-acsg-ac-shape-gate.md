---
title: P2 — B-ACSG bundle: refine-prd AC-shape collapse-or-justify gate false-rejects properly-consolidated analyst tickets
status: Draft
filed: 2026-05-31
priority: P2
type: bug-bundle
code: B-ACSG
r_code: R-ACSG
backend_constraint: any
composes:
  - 84   # R-ACSG — AC-shape collapse-or-justify gate (exit 2) oscillates, false-rejects correctly-consolidated analyst tickets
source_report: prds/archive/bug-reports/BUG-REPORT-2026-05-27-refine-prd-ac-shape-gate-oscillation.md
related:
  - extension/src/bin/spawn-refinement-team.ts            # the gate: isParametrizedTicket / hasJustificationBlock / evaluateAcShapeEnforcement / runAcShapeEnforcement
  - extension/tests/spawn-refinement-team.test.js         # existing coverage of evaluateAcShapeEnforcement
  - .claude/commands/pickle-refine-prd.md                 # operator-facing skill Step 5 (the "rewrite the PRD or justify" guidance)
incident_sessions:
  - /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-27-aeb6ec52  # LOA-727 post-review-hardening — 3 refinement attempts, ~30 min + ~9 worker quotas burned
schema_neutral: true   # no state.json schema field; no LATEST_SCHEMA_VERSION bump. The --skip-ac-shape-gate reason lands in state.flags (existing flags object) only if a flag is needed; preferred path is a CLI flag.
---

# PRD — B-ACSG bundle

> Drains MASTER_PLAN row 7 (#84 R-ACSG). Scope is **NARROW** per the source report's decision tree Q4 ("Recommend NARROW first"): fix the gate matcher only — **not** the wide refinement-convergence-architecture rewrite. Root cause is the **H1 + H3 combo** per Q3 ("analyst tickets are correct, gate's PRD check is wrong shape AND regex is brittle").
>
> **Launch posture**: this bundle modifies the refinement gate but is launched **WITHOUT** refinement (mux-runner build loop only, e.g. `--no-refine`), so it will not trip its own gate.

## Trigger

`spawn-refinement-team.ts`'s AC-shape "collapse-or-justify" gate (the `process.exit(2)` path at `extension/src/bin/spawn-refinement-team.ts:2131-2132`) rejected a properly-shaped LOA-727 PRD across two refinement attempts before passing on attempt 3 — **after** the operator burned ~30 min and ~9 worker quotas reshaping the PRD into aggressive table-driven invariant form. The analysts had already done the correct consolidation on attempt 1; the gate didn't recognize it.

Recurring trigger: any PRD with ≥3 similar workstreams (LOA-727 had 4). The smell count is non-monotonic across attempts (attempt 1: 2 smells; attempt 2: 9 smells) — fixes can ADD new smells rather than reduce them. The only consistently-passing path is an operator PRD rewrite; there is no "trust the analyst's consolidation" path and no bypass. Zero code progress during the burn window. Data loss risk: none — pure friction. (See incident timeline in the source report.)

## Root cause (H1 + H3, confirmed by direct code reading)

**Two functions decide the verdict.** `evaluateAcShapeEnforcement(manifest)` (`spawn-refinement-team.ts:1550-1583`) iterates each `ac_shape_smell`, finds the tickets that map to it via `ticketsForSmell` (`:1372-1378`, matches on explicit `ticket_ids` or `source_ac_ids.includes(smell.ac_id)`), and applies the collapse-or-justify rule. `runAcShapeEnforcement(manifest)` (`:1585-1595`) prints the stderr block `[pickle-rick] AC-shape collapse-or-justify gate failed.` (`:1588`) plus per-violation lines and returns exit code `2`; the caller exits at `:2131-2132`.

### H1 — matcher too literal / regex-brittle (CONFIRMED)

`isParametrizedTicket(ticket)` (`spawn-refinement-team.ts:1546-1548`) is:

```ts
return UNIVERSAL_QUANTIFIER_RE.test(ticket.title) && DESCRIBE_EACH_RE.test(ticket.acceptance_test ?? '');
```

with the constants at `:1250-1252`:

```ts
const UNIVERSAL_QUANTIFIER_RE = /\b(?:all|every|for any|each)\b/i;
const DESCRIBE_EACH_RE = /describe\.each\s*\(\s*\[/s;
```

The brittleness is positional and field-bound:

- The universal-quantifier check runs **only against `ticket.title`** — a quantifier in the `acceptance_test` or `justification` body is invisible.
- The `describe.each([` check runs **only against `ticket.acceptance_test`** — a `describe.each` cited in the title or justification body is invisible.
- Both must be present **simultaneously and in their respective fields**. Attempt 2's ticket title `"All 7 LOA-727 invariants get schema-conforming trap-door entries via describe.each over WS1.x table"` contains BOTH `All` and `describe.each` in plain text — but `describe.each` was in the TITLE, not in `acceptance_test`, so `DESCRIBE_EACH_RE.test(ticket.acceptance_test)` failed and the gate emitted `single-ticket collapse lacks a universal-quantifier title or describe.each([...]) acceptance test` (`:1567`).

The single-ticket-collapse violation (`:1562-1571`) fires whenever exactly one ticket maps to a smell and `isParametrizedTicket` returns false — exactly the LOA-727 failure mode.

### H3 — PRD/ticket conflation (CONFIRMED)

The gate is purely a function of analyst-emitted manifest data (`ac_shape_smells` + `tickets`, parsed from each analyst's `analysis_<role>.md` `## ac_shape_smells` JSON section via `parseAcShapeSection` at `:1341-1357`). It never distinguishes:

- **operator-authored PRD shape** (advisory — humans read the PRD), from
- **analyst-emitted ticket shape** (normative — workers consume tickets downstream).

The runner offers no "the analyst's consolidation is correct; advance anyway" path. The operator's only consistently-working remedy is to rewrite the PRD prose until the analysts re-emit a manifest the literal matcher happens to accept — even though the tickets were already well-shaped (universal-quantifier titles, `justification_present: true`, `describe.each([...])` mentioned). The skill's Step 5 in `.claude/commands/pickle-refine-prd.md` treats "rewrite the PRD" and "add justification" as equivalent, but only PRD rewrites pass. There is also no `--skip-ac-shape-gate` bypass: the unified `state.flags.skip_quality_gates_reason` (per `prds/CLAUDE.md` Skip-Flag Conventions) covers the launch-time readiness gate and ticket-audit gate, NOT this refinement-time AC-shape gate.

**H2 (cycle-3 oscillation) and H4 (convergence cost / gate-only mode) are real symptoms but are explicitly OUT of scope** (see below) — the narrow H1+H3 fix resolves the LOA-727 false-reject without them.

## In scope (NARROW)

1. **Loosen the matcher (H1)** — recognize a universal-quantifier title (`All`/`Every`/`each`/`for any`) and `describe.each([...])` in **ANY** field/position (title, `acceptance_test`, OR `justification` body), and read the justification **body** correctly (not mere field presence). Add a `PICKLE_AC_GATE_DEBUG=1` debug flag.
2. **Decouple PRD-advisory from ticket-normative (H3)** — make the gate NORMATIVE on analyst-emitted ticket shape (it is what workers consume) and ADVISORY (warn-not-fail) on operator-authored PRD shape. Add a `--skip-ac-shape-gate <reason>` bypass with an audit-log breadcrumb. Improve the rejection error message to be CLEAR + ACTIONABLE.
3. **Regression + monotonicity coverage** — a fixture replaying the LOA-727 attempt-1/attempt-2 manifests, plus a determinism test, plus a negative-corpus no-regression check.
4. **Trap-door pin** — lock the loosened-matcher + decoupled-verdict invariants so a future refactor cannot silently re-narrow them.

## Not in scope (explicitly excluded — possible follow-ups)

- **H2 — cycle-3 oscillation / smell-snapshot-at-cycle-1 / monotonicity freeze across cycles.** B-ACSG adds a *same-input determinism* test (R-ACSG-3) but does NOT change cross-cycle convergence behavior (snapshot/abort-on-increase). Follow-up candidate.
- **H4 — convergence cost / `--gate-only` mode / cache / diff-based re-eval.** No new gate-only runner, no caching layer. Follow-up candidate.
- **Wide convergence-architecture rewrite** (decision tree Q4 "Wide ~8 tickets" — `spawn-refinement-team.ts` + skill prompt + state machine). Explicitly deferred; revisit only if the narrow fix fails to kill recurrence.
- **#30 R-RSU (over-collapse)** — the inverse problem (B-WEDGE, row 8). May share the same matcher; B-ACSG does not touch it.

## Scope / version

- **PATCH** (1.89.3 → 1.89.4) — fixes only. No new command, no new state.json schema field, no `LATEST_SCHEMA_VERSION` bump. The `--skip-ac-shape-gate <reason>` is a CLI flag on the existing `spawn-refinement-team.js` entry-point; if a persisted breadcrumb is needed it lands in the EXISTING `state.flags` object (schema-neutral, like `skip_quality_gates_reason`), never a new top-level field. The closer confirms the bump from the landed diff per semver — a new activity event alone (`ac_shape_gate_bypassed`) does not force MINOR here because it is a bug-fix bypass breadcrumb, but the closer makes the final call.
- Schema-neutral guard: confirm no new top-level `state.json` field and no `LATEST_SCHEMA_VERSION` change (R-WSRC / #74 R-WSWA).

## Atomic tickets

### R-ACSG-1 (medium) — Loosen the AC-shape matcher + `PICKLE_AC_GATE_DEBUG` flag (H1)
- In `extension/src/bin/spawn-refinement-team.ts`, rewrite `isParametrizedTicket` (`:1546-1548`) so the universal-quantifier check AND the `describe.each([...])` check each run against the **joined text of all three fields** (`title` + `acceptance_test` + `justification`) — not `title`-only and `acceptance_test`-only respectively. Reuse the same field-join shape already used at `:1308` (`[entry.title, entry.acceptance_test, entry.justification].filter(Boolean).join(' ')`); extract a small `ticketShapeText(ticket)` helper so both `isParametrizedTicket` and `hasJustificationBlock` read from one place.
- `hasJustificationBlock` (`:1542-1544`) MUST read the justification **body**: keep `JUSTIFICATION_RE` (`/\/\/\s*JUSTIFICATION:/i`, `:1251`) matching against `ticket.justification` content, but ALSO accept the case where a justification is present as prose in the body without the literal `// JUSTIFICATION:` token IF the analyst supplied a non-empty `justification` field — i.e. presence of a substantive justification body satisfies the multi-ticket rule (`:1573-1580`), not just the `//` comment sigil. Do not regress: an empty/whitespace-only justification still fails.
- Add `PICKLE_AC_GATE_DEBUG=1`: when set, `runAcShapeEnforcement` (and the per-ticket matcher) prints to stderr exactly `matcher: regex=<pattern>, field=<title|acceptance_test|justification|joined>, value=<extracted>, result=<match|no-match>` for each smell→ticket evaluation (per source report Open Question 1). Off by default; only the literal `1` enables.
- **AC-ACSG-1a** *(machine-checkable)*: `node --test extension/tests/refinement-ac-shape-gate.test.js` (forward-created) passes a case where a single ticket has the universal quantifier in its TITLE and `describe.each([` ONLY in `acceptance_test` → `evaluateAcShapeEnforcement` returns `[]` (no violation). A second case with the quantifier in `acceptance_test` and `describe.each([` in `title` → also `[]`. Type: test.
- **AC-ACSG-1b** *(machine-checkable)*: same test asserts `isParametrizedTicket` returns `true` when the quantifier + `describe.each([` appear across DIFFERENT fields (cross-field recognition), and `false` for a ticket with neither token in any field. Type: test.
- **AC-ACSG-1c** *(machine-checkable)*: `PICKLE_AC_GATE_DEBUG=1 node extension/bin/spawn-refinement-team.js` (or a unit harness invoking `runAcShapeEnforcement`) emits a stderr line matching `/^matcher: regex=.*, field=.*, value=.*, result=(match|no-match)$/m` for each evaluated smell; with the flag unset, NO `matcher:` line is printed. Verify: `grep -c "PICKLE_AC_GATE_DEBUG" extension/src/bin/spawn-refinement-team.ts` ≥ 1 AND test asserts presence/absence of the line by env. Type: test+lint.

### R-ACSG-2 (medium) — Decouple PRD-advisory vs ticket-normative + `--skip-ac-shape-gate` + actionable error (H3)
- **Ticket-normative / PRD-advisory split**: `evaluateAcShapeEnforcement` continues to evaluate analyst-emitted **ticket** shape as NORMATIVE (workers consume tickets). Any check that is driven by operator-authored PRD prose shape (rather than the analyst manifest's `tickets`/`ac_shape_smells`) must be downgraded to ADVISORY: emit a warning to stderr and into `refinement_manifest.json` (alongside the existing `ticket_quality_warnings` channel) but MUST NOT contribute to the exit-2 verdict. Net effect: a manifest whose tickets correctly consolidate the smells passes even if the operator's original PRD prose still enumerates per-row sub-points.
- **`--skip-ac-shape-gate <reason>` bypass** (source report Open Question 4): add the flag to `parseAndValidateArgs`. A non-empty trimmed reason short-circuits `runAcShapeEnforcement` to return `0`, emits an `ac_shape_gate_bypassed` activity event with `gate_payload: { reason }` + ISO `ts` (register in `VALID_ACTIVITY_EVENTS` in `extension/src/types/index.ts` AND the `extension/types/index.js` mirror AND `extension/src/types/activity-events.schema.json` AND `ACTIVITY_EVENT_SCHEMA_SECTION` in `spawn-refinement-team.ts` — the 4-touchpoint contract). Missing/blank/`--`-prefixed reason → exit 64 (mirror the `--skip-readiness` reason-required contract in `check-readiness.ts`). The reason is the audit breadcrumb.
- **Actionable error message**: replace the generic block at `runAcShapeEnforcement` (`:1588-1593`). For each violation, the message MUST name (a) the exact failing `ac_id` AND ticket id(s), and (b) EITHER a copy-pasteable fix template (the exact universal-quantifier-title + `describe.each([...])`-acceptance-test shape, or the `// JUSTIFICATION:` block shape for multi-ticket splits) OR the override path: the literal `--skip-ac-shape-gate "<reason>"` invocation telling the operator the analyst tickets may already be correct and how to bypass. No operator inference required (source report Test plan #3).
- **AC-ACSG-2a** *(machine-checkable)*: `node --test extension/tests/refinement-ac-shape-gate.test.js` asserts that a manifest with correctly-consolidated tickets but a PRD-prose-shaped advisory concern produces `evaluateAcShapeEnforcement(...) === []` (no exit-2 violation) AND a warning string is surfaced (advisory channel non-empty). Type: test.
- **AC-ACSG-2b** *(machine-checkable)*: `node --test` asserts `--skip-ac-shape-gate "operator: analyst tickets verified correct"` makes `runAcShapeEnforcement` return `0` on a manifest that would otherwise return `2`, and emits exactly one `ac_shape_gate_bypassed` event; `--skip-ac-shape-gate` with no reason (or `--skip-ac-shape-gate --next-flag`) exits 64. Verify also: `grep -c "ac_shape_gate_bypassed" extension/src/types/index.ts extension/types/index.js extension/src/types/activity-events.schema.json` ≥ 3 (one per touchpoint). Type: test+lint.
- **AC-ACSG-2c** *(machine-checkable, operator UX)*: on a genuine violation, the stderr from `runAcShapeEnforcement` contains BOTH the offending `ac_id`+ticket id AND at least one of: the literal substring `describe.each([` (fix template) OR the literal substring `--skip-ac-shape-gate` (override path). Verify: test captures stderr and asserts the regex `/<ac_id>.*ticket/` plus `/(describe\.each\(\[|--skip-ac-shape-gate)/`. Type: test.

### R-ACSG-3 (medium) — Regression fixture (LOA-727 case) + monotonicity + negative-corpus no-regression
- **Regression fixture (source report Test plan #1)**: build a fixture manifest reproducing the LOA-727 **attempt-2** shape — single ticket per smell with universal-quantifier title + `describe.each([...])` cited in `acceptance_test` OR title, `justification_present: true` — and assert the loosened gate ACCEPTS it (`evaluateAcShapeEnforcement === []`), OR, if it still rejects, that the error is the clear+actionable shape from R-ACSG-2c. Place under `extension/tests/fixtures/ac-shape-gate/loa-727-attempt2-manifest.json` (forward-created) and load it in `refinement-ac-shape-gate.test.js`.
- **Monotonicity (source report Test plan #2)**: running `evaluateAcShapeEnforcement` twice on the SAME fixture manifest produces the SAME violation count and the SAME violation `ac_id` set — deterministic, no oscillation across repeated evaluation. (Bounded to same-input determinism; cross-cycle freeze is H2, out of scope.)
- **No-regression negative corpus (source report Test plan #5)**: a fixture with a GENUINELY enumerated AC — one smell mapped to one ticket that has NO universal-quantifier token and NO `describe.each([` in any field, and NO justification — STILL produces a violation (the gate must keep catching enumeration-disguised-as-tests). Plus a multi-ticket split where one ticket has an empty justification → still a violation. Source the negative cases from the `prds/BUG-REPORT-2026-05-*` incident corpus shape.
- **AC-ACSG-3a** *(machine-checkable)*: `node --test extension/tests/refinement-ac-shape-gate.test.js` loads the LOA-727 attempt-2 fixture and asserts acceptance (or clear-error per R-ACSG-2c). `extension/tests/fixtures/ac-shape-gate/loa-727-attempt2-manifest.json` exists (forward-created). Type: test.
- **AC-ACSG-3b** *(machine-checkable, monotonicity)*: the test calls `evaluateAcShapeEnforcement(fixture)` twice and asserts `JSON.stringify(run1.map(v=>v.ac_id).sort()) === JSON.stringify(run2.map(v=>v.ac_id).sort())` AND `run1.length === run2.length`. Type: test.
- **AC-ACSG-3c** *(machine-checkable, no-regression)*: a `negative-corpus` fixture case asserts `evaluateAcShapeEnforcement(...).length >= 1` for a truly-enumerated single ticket AND for a multi-ticket split with one empty justification — proving real-defect detection still fires (fast feedback: pure in-memory evaluation, no worker respawn, per Test plan #4). Type: test.

### R-ACSG-TD (small) — Trap-door pin
- Add a `## Trap Doors` entry in `extension/src/bin/CLAUDE.md` for `spawn-refinement-team.ts (R-ACSG matcher + verdict shape)`: INVARIANT — `isParametrizedTicket` and `hasJustificationBlock` MUST read the JOINED text of `title`+`acceptance_test`+`justification` (cross-field), NOT a single hard-coded field each; `runAcShapeEnforcement` MUST honor `--skip-ac-shape-gate <reason>` (emitting `ac_shape_gate_bypassed`) and its rejection message MUST name the `ac_id`+ticket id plus a fix template or the override path; the gate is NORMATIVE on analyst ticket shape and ADVISORY on operator PRD prose shape. BREAKS — reverting to `title`-only quantifier / `acceptance_test`-only `describe.each` re-opens the LOA-727 false-reject (~30 min + ~9 worker quotas burned per incident); removing the bypass strands operators when the gate is wrong. ENFORCE — `extension/tests/refinement-ac-shape-gate.test.js`, `bash extension/scripts/audit-trap-door-enforcement.sh`. PATTERN_SHAPE — `ticketShapeText(` (or equivalent joined-field helper) consumed by BOTH `isParametrizedTicket` and `hasJustificationBlock`; `--skip-ac-shape-gate` parsed in `parseAndValidateArgs`.
- **AC-ACSG-TDa** *(machine-checkable)*: `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0 with the new pin present; `grep -c "R-ACSG" extension/src/bin/CLAUDE.md` ≥ 1; the ENFORCE-cited test file `extension/tests/refinement-ac-shape-gate.test.js` exists. Type: lint+test.

### C-ACSG-CLOSER [manager] — Ship
- Run the FULL release gate from `extension/` (`cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`). Confirm GREEN before any bump/commit/tag (per MEMORY feedback: READ the gate result first; never batch the tag with the gate read).
- Confirm schema-neutral: no new top-level `state.json` field, no `LATEST_SCHEMA_VERSION` change. Determine the bump from the landed diff (PATCH unless the diff justifies otherwise), bump `extension/package.json`, commit `chore(C-ACSG-CLOSER): ship B-ACSG — bump X.Y.Z + repoint MASTER_PLAN #84`.
- `bash install.sh`, verify clean working tree + deployed JS matches source (parity gate), `git push`, then `gh release create vX.Y.Z`.
- Repoint `prds/MASTER_PLAN.md`: strike the B-ACSG dispatch line (row 7), mark `#84 R-ACSG` Closed, add a "Recently Shipped" entry with the closer commit SHA + version.
- **AC-ACSG-00** *(machine-checkable)*: full release gate exits 0 from a clean tree; `git status --porcelain` empty at tag time; `gh release view vX.Y.Z` succeeds. Type: integration.

## Acceptance (bundle-level)

- LOA-727 attempt-2-shaped manifest is ACCEPTED by the loosened gate, OR rejected with a clear+actionable message (R-ACSG-1, R-ACSG-3).
- Same-input evaluation is deterministic — same smell/violation count twice (R-ACSG-3 monotonicity).
- Operator has an actionable error (name + fix template or override) and a `--skip-ac-shape-gate <reason>` bypass with an `ac_shape_gate_bypassed` breadcrumb (R-ACSG-2).
- The gate still fires on genuinely-enumerated ACs (negative corpus, R-ACSG-3c) — no false-green regression.
- Matcher + verdict shape pinned by trap door (R-ACSG-TD).
- Schema-neutral; release gate green; clean tree; shipped through `gh release create` (C-ACSG-CLOSER).
