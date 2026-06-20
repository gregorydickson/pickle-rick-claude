---
title: BUG REPORT — 2026-05-27 — refine-prd AC-shape collapse-or-justify gate oscillates, false-rejects properly-consolidated analyst tickets
status: Draft
filed: 2026-05-27
priority: P2
type: bug-incident
r_code: R-ACSG
related:
  - prds/MASTER_PLAN.md                                                          # finding #84 (this report)
  - prds/archive/bug-reports/p2-refined-tickets-trip-readiness-contract-resolver.md                  # adjacent refine-skill defect family
  - prds/archive/bug-reports/BUG-REPORT-2026-05-23-readiness-rejects-forward-created-tickets.md      # adjacent: gate matcher brittleness pattern
  - prds/archive/bug-reports/p2-refine-prd-skill-missing-rtrc7-annotation-reminder.md                # adjacent: refine-skill side
incident_sessions:
  - /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-27-aeb6ec52  # LOA-727 post-review-hardening PRD refinement (3 attempts)
---

# R-ACSG — AC-shape collapse-or-justify gate oscillates, false-rejects properly-consolidated analyst tickets

## Status

**Open.** This bug report does NOT pre-commit to a fix. It enumerates four competing root-cause hypotheses with evidence, and a decision tree for the fixer to use. Four candidate fixes are sketched; the right one likely combines elements.

## TL;DR

`spawn-refinement-team.js`'s AC-shape collapse-or-justify gate (exit code 2 path) rejected a properly-shaped LOA-727 PRD across two refinement attempts before passing on attempt 3 — *after* the operator burned ~30 min and ~9 worker quotas reshaping the PRD into table-driven invariant form. The analysts themselves had already done the right consolidation on attempt 1; the gate didn't recognize it because (depending on hypothesis) the matcher is too literal, the convergence cycle oscillates, the gate conflates PRD shape with ticket shape, or all three. Workaround exists (aggressive table-driven reshape or `--no-refine`), but neither is obvious to a new user. Recurring trigger: any PRD with ≥3 similar workstreams.

## Incident timeline — LOA-727 post-review-hardening (session `2026-05-27-aeb6ec52`)

| Attempt | PRD shape | Workers / cycles | Gate result | Smells flagged | Operator cost |
|---|---|---|---|---|---|
| 1 | Original: 7 sub-workstreams (WS1.1–WS1.7) each with own `[ ] Verify: grep ... returns non-zero` AC, plus WS2.3 with 3 separate throw-path bullets | 3/3 workers OK, 3/3 cycles | **REJECT** (exit 2) | 2 (WS1, WS2.3) | ~10 min wall + 3 worker quotas |
| 2 | Added WS1.0 top-level universal AC; kept WS1.1–WS1.7 subsections; reshaped WS2.3 with "Every throw path" title + describe.each table | 3/3 workers OK, 3/3 cycles | **REJECT** (exit 2) | **9** (WS1.0, WS2.2, WS2.3, WS3.4×2, WS4.1, WS1.0-trap-door-rows, WS3.4-drop-exports, top-level-meta-ac) | ~10 min wall + 3 worker quotas |
| 3 | Aggressive collapse: WS1 → single universal AC + 7-row data appendix (no per-row checkboxes); WS2.2 → 7-row describe.each table; WS3.4 → 9-row export-status truth table; WS4.1 → 4-row verdict truth table | 3/3 workers OK, 3/3 cycles | **PASS** (`status:pass, findings:[]`) | 0 | ~10 min wall + 3 worker quotas |

**Total burn:** ~30 min wall, ~9 claude worker quotas, three PRD rewrites. Zero progress on actual LOA-727 hardening code during this window.

## Symptom catalog (what the operator saw)

1. **Gate runs AFTER successful refinement.** `all_success: true`, `cycles_completed: 3`, every `analysis_*.md` file present and substantive (15–37 KB per file across cycles), `path_not_verified` warnings logged as advisory — then exit 2 with `AC-shape collapse-or-justify gate failed`.
2. **Smell count increases with each attempt.** Attempt 1: 2 smells. Attempt 2: 9 smells. There's no monotonic-progress guarantee — fixes don't reduce the smell count, they can ADD new ones surfaced by stricter cross-cycle analysis.
3. **Analyst's manifest IS well-shaped.** Attempt 2's manifest had:
   - Universal-quantifier ticket titles ("All 7 LOA-727 invariants...", "Every throw path...", "Every test-only export...")
   - `justification_present: true` on EVERY ticket
   - `acceptance_test` fields explicitly mentioning `describe.each([...])` syntax
   - Gate STILL rejected with `single-ticket collapse lacks a universal-quantifier title or describe.each([...]) acceptance test`.
4. **Analyst-vs-analyst disagreements emit as competing tickets.** Attempt 2's WS3.4 produced TWO tickets (`ws3-4-test-only-exports-as-trap-door` AND `ws3-4-test-only-exports`) because Risk Auditor preferred a CLAUDE.md trap-door entry and Codebase Analyst preferred inline export comments. The runner saw both and flagged it as ambiguous "lacks // JUSTIFICATION:" — even though both tickets DID have justifications.
5. **Operator-side iteration is the only path forward.** The skill prompt's Step 5 says "Rewrite each AC as one invariant-shaped acceptance criterion, OR add // JUSTIFICATION: blocks to every intentionally split ticket." Both paths require the OPERATOR to rewrite the PRD; there's no "trust the analyst's consolidation" path. The justifications already in the manifest don't satisfy the gate.

## Four competing root-cause hypotheses

The fixer should evaluate evidence under each and pick the dominant cause (or layer fixes across multiple). Hypotheses are NOT mutually exclusive.

### Hypothesis H1 — Matcher too literal / regex-brittle

**Claim:** The gate's smell-detection matcher checks for specific syntax patterns (e.g. universal-quantifier word at specific position; literal `describe.each([` syntax in a specific field) rather than semantic intent. It fails to recognize equivalent forms.

**Evidence FOR:**
- Attempt 2 ticket title was `"All 7 LOA-727 invariants get schema-conforming trap-door entries via describe.each over WS1.x table"` — contains BOTH `"All"` and `"describe.each"` in plain text. Gate still flagged it as `lacks a universal-quantifier title or describe.each([...]) acceptance test`.
- Attempt 3 passed only after the PRD's prose was rewritten to put `**Every**` in `**bold**` at sentence start AND the `describe.each` syntax outside backticks AND in the AC body (not just in a `acceptance_test` manifest field).

**Evidence AGAINST:**
- Without source-read access to the matcher logic in `spawn-refinement-team.js` (or wherever the gate lives), the exact regex isn't confirmed — could be matching something more sensible than I infer.
- Attempt 3 DID pass with a structurally similar shape — so the matcher does recognize valid forms, just narrowly.

**Implied fix (if H1 is dominant):**
- Loosen the matcher: instead of regex, use an LLM-judge prompt (one cheap call: "does this ticket bundle correctly consolidate the smelly AC? yes/no/justify") to evaluate analyst output.
- OR: document the exact matcher contract in the skill prompt so operators know what to write.
- Cheap iteration: keep regex but widen the patterns; add a debug flag to print which regex failed against which field.

**Counter-fix risk:** Loosening too far means the gate stops catching real defects. The matcher's brittleness IS preventing actual enumeration-disguised-as-tests; loosen carefully.

### Hypothesis H2 — Cycle-3 oscillation / monotonicity violation

**Claim:** Each refinement cycle cross-references prior cycles' analyses. Cycle 2/3 analysts can find NEW smells the cycle-1 analyst didn't see (because the cycle-2 analyst is reading cycle-1's tickets and re-evaluating). The gate has no oscillation detection — every cycle's output is re-judged from scratch, and there's no convergence guarantee.

**Evidence FOR:**
- Attempt 1: 2 smells. Attempt 2 (with a refined PRD): 9 smells. Strictly INCREASING smell count across iteration boundaries despite operator addressing the prior smells.
- Cycle 3 of attempt 2 surfaced disagreements between analysts (WS3.4 split-vs-trap-door) that cycle 1 hadn't flagged.
- The 70 `path_not_verified` warnings in attempt 3 are a related symptom: each cycle's analyst names slightly different "expected" paths, and the warning count grows.

**Evidence AGAINST:**
- The smells in attempt 2 WERE legitimate (e.g. WS2.2's 5-helper enumeration was real). Operator just hadn't reshaped those workstreams yet.
- Attempt 3 converged to 0 — so cycles DO converge once the PRD is reshaped enough.

**Implied fix (if H2 is dominant):**
- Snapshot smells at cycle 1. Subsequent cycles can RESOLVE smells (by emitting consolidated tickets) but cannot ADD new ones — the smell set is frozen after cycle 1.
- OR: cap convergence cost — if cycle N+1 has more smells than cycle N, abort with a "gate is oscillating; operator must reshape PRD or pass `--no-refine`" message.
- OR: only re-evaluate the gate against the DIFF between PRD versions, not the whole PRD.

**Counter-fix risk:** Freezing smells too early means cycle 2/3's deeper analysis is wasted. Snapshot timing matters.

### Hypothesis H3 — PRD/ticket conflation

**Claim:** The gate checks BOTH the PRD's own AC shape AND the analyst's emitted ticket shape, treating them as the same artifact. But the PRD is operator-authored documentation; the ticket is analyst-emitted execution plan. The analyst should be allowed to consolidate enumerated PRD ACs into one parametrized ticket without forcing the PRD itself to be rewritten.

**Evidence FOR:**
- Attempt 2 had well-shaped tickets in the manifest (`ws1-trap-doors` with `source_ac_ids: ["WS1.1"..."WS1.7"]`, universal-quantifier title, justification block) AND the gate still rejected.
- The skill's own Step 5 guidance treats "rewrite the PRD" and "add justification to tickets" as equivalent paths — but in practice, only PRD rewrites consistently pass.
- The PRD is the human-authored intent doc; the ticket is the execution plan. Different concerns, different shapes.

**Evidence AGAINST:**
- Workers downstream of refinement read the PRD (via `prd_refined.md`), not the analyst's manifest. If the PRD enumerates 7 sub-points, a worker reading just one ticket's research seed may interpret the predicate enumeratively and write per-row tests anyway.
- Decoupling PRD shape from ticket shape may let enumeration-disguised-as-tests through the front door.

**Implied fix (if H3 is dominant):**
- Decouple: gate checks ticket shape (normative — workers consume it), warns on PRD shape (advisory — humans consume it).
- OR: refined PRD is auto-rewritten from analyst tickets at Step 6, so PRD shape always matches ticket shape and operator-authored PRD shape is irrelevant after refinement.

**Counter-fix risk:** Auto-rewriting the operator's PRD voids author intent; analyst consolidation may delete useful per-row context the operator wrote for human readers.

### Hypothesis H4 — Convergence cost too high (no early-exit)

**Claim:** Even when the gate is doing the right thing, full 3-cycle refinement (3 parallel workers × 3 cycles = 9 worker invocations × ~10 min wall = ~10 min total) is too expensive for the diagnostic feedback it provides. Each attempt costs ~10 min + 3 worker quotas; three attempts × ~10 min = 30 min before convergence on a 12-workstream PRD. Larger PRDs proportionally.

**Evidence FOR:**
- ~30 min and ~9 worker quotas burned on this LOA-727 PRD before convergence, with no code progress in that window.
- The 70 `path_not_verified` warnings suggest analysts spend tokens chasing path verification that the gate doesn't care about — pure overhead.
- Operator workaround `--no-refine` exists but skips ALL the analyst value, not just the gate.

**Evidence AGAINST:**
- Refinement IS valuable when it works — the analysts found real consolidation opportunities the operator might have missed.
- 10 min per cycle is bounded; for a PRD that ships 8+ tickets of real work, the cost is amortized.

**Implied fix (if H4 is dominant):**
- Cache prior cycle's gate ruling; only re-evaluate ACs whose PRD prose intersects a smell flag.
- OR: add a `--gate-only` mode that runs JUST the gate against an existing refinement (no new workers spawned).
- OR: short-circuit cycles when convergence is detected (current code may already do this — verify).

**Counter-fix risk:** Caching too aggressively means stale rulings. Analyst output changes between cycles even when the PRD doesn't; the gate's correct verdict may legitimately change.

## Decision tree for the fixer

```
Question 1: Did this bug block real work?
├── YES (LOA-727 evidence) → P2 minimum; consider P1 if recurrence rate > 1/week
└── NO → P3 / advisory only

Question 2: Pick dominant root cause
├── H1 (matcher) → Fix shape: loosen regex OR LLM-judge OR document contract
├── H2 (oscillation) → Fix shape: snapshot smells at cycle 1 OR abort on increase
├── H3 (PRD/ticket conflation) → Fix shape: decouple checks; gate normative on tickets, advisory on PRD
└── H4 (cost) → Fix shape: gate-only mode OR cache OR diff-based re-eval

Question 3: Combined fix? (likely)
├── H1 + H3 most likely combo — analyst tickets are correct, gate's PRD check is wrong shape AND regex is brittle
├── H2 + H4 combo also plausible — convergence is the meta-problem
└── Single-cause fixes risk patching symptoms; combined fixes risk over-engineering

Question 4: Scope of fix?
├── Narrow (just the gate matcher) — ~3 tickets, contained blast radius
├── Wide (refinement convergence architecture) — ~8 tickets, touches spawn-refinement-team.js + skill prompt + state machine
└── Recommend NARROW first; revisit if narrow doesn't kill recurrence
```

## Workarounds (what got us through this time)

1. **Aggressive table-driven PRD reshape.** Replace enumerated subsections with one `**For every** row in the truth table` AC + a markdown table of rows. Put `describe.each` in plain prose (not just backticks). Bold the universal-quantifier word. Cost: ~10 min per workstream + 1 refinement cycle to re-evaluate.
2. **`--no-refine` flag.** Skip refinement entirely; pipeline runs on the original PRD. Cost: workers get less consistent ticket templates, but the LOA-727 PRD was actionable enough that this would have worked too.
3. **Skip-gate override.** `state.flags.skip_quality_gates_reason` exists for the launch-time readiness gate but does NOT cover the refinement AC-shape gate (verify whether it should). The skill's Step 5 only documents the rewrite path.

## Severity / impact data

| Metric | Value (LOA-727 incident) | Notes |
|---|---|---|
| Wall time burned | ~30 min | Three refinement cycles, two PRD reshapes |
| Worker quotas burned | ~9 claude invocations | 3 cycles × 3 parallel analysts |
| Code progress during burn | **zero** | Operator was reshaping the PRD, not writing LOA-727 code |
| Recurrence likelihood | **HIGH** | Triggers on any PRD with ≥3 similar workstreams; LOA-727 had 4 |
| Operator-known workaround obvious? | NO | Requires reading the skill prompt's Step 5 + understanding analyst manifest internals |
| User-facing severity (P-scale) | **P2** | Recurring, blocking, with non-obvious workarounds; not data-loss but high friction |
| Data loss risk | None | Pure friction |

## Test plan (what would need to be true for any fix to ship)

Regardless of which hypothesis the fix targets, a successful fix MUST satisfy ALL of these:

1. **Regression fixture: LOA-727 PRD attempt 1.** Replay the original `docs/prd-loa-727-post-review-hardening.md` (preserved at `${SESSION_ROOT}/prd.md` for session `2026-05-27-aeb6ec52` until cleanup) through refinement. Either:
   - Gate accepts the analyst's consolidated tickets without operator reshape, OR
   - Gate produces a CLEAR, ACTIONABLE error message identifying exactly which AC and exactly which fix shape would satisfy it (no operator inference required), with the same shape consistent across cycles.
2. **Monotonicity test:** running refinement twice in a row on the SAME PRD produces the SAME smell count. No oscillation.
3. **Operator UX:** if the gate rejects, the error message tells the operator either (a) "rewrite this specific AC in this specific way" with a copy-pasteable template, OR (b) "the analyst's tickets are correct; advance state with `node update-state.js gate_override`".
4. **Fast feedback loop:** gate verdict is available within 30s of running the matcher (whether via existing manifest re-read or a new `--gate-only` mode). Don't require a full 3-cycle re-spawn to test a fix.
5. **No regressions:** existing legitimate-defect detection (enumerated ACs that would actually mislead workers) still fires. Use the bug-incident corpus in `prds/BUG-REPORT-2026-05-*` for negative test cases.

## Open questions / unknowns

1. **What exactly does the matcher check?** Operator can't see the matcher source from outside the skill. A debug flag (`PICKLE_AC_GATE_DEBUG=1`) that prints `matcher: regex=<pattern>, field=<title|acceptance_test|body>, value=<extracted>, result=<match|no-match>` would let the operator self-diagnose without filing a bug.
2. **Does the gate read `manifest.tickets[].justification`?** Attempt 2 had `justification_present: true` on every ticket and the gate still rejected with `lacks // JUSTIFICATION: blocks` — suggesting the matcher reads the BODY of the justification, not just the presence of the field.
3. **Is `--no-refine` the intended workaround?** If so, the skill prompt should say "if the gate keeps rejecting and your PRD seems actionable, retry with `--no-refine`" — it currently doesn't.
4. **Is there a way to skip JUST the AC-shape gate while keeping the rest of refinement?** A `--skip-ac-shape-gate <reason>` flag would let operators bypass when they've judged the gate wrong, with an audit-log breadcrumb.
5. **Is the master-plan finding R-RSU (#30) — `refinement collapses composes: bundle PRDs to N section-umbrellas` — related?** R-RSU is the inverse problem (over-collapse); R-ACSG is under-acceptance of correct consolidation. They may share root cause in the same matcher.

## Cross-references

- **`prds/archive/bug-reports/p2-refine-prd-skill-missing-rtrc7-annotation-reminder.md`** — adjacent refine-skill side defect (annotation-shape matcher).
- **`prds/archive/bug-reports/BUG-REPORT-2026-05-23-readiness-rejects-forward-created-tickets.md`** — adjacent matcher-brittleness pattern in the readiness gate (not refinement, but same class of problem: matcher rejects valid forms).
- **MASTER_PLAN.md finding #30 R-RSU** — refinement collapses bundle PRDs (inverse problem; check if same matcher).
- **MASTER_PLAN.md finding #29 R-MWCL** — monitor inferMonitorMode brittleness (sibling matcher class).

## Operator note (for the fixer)

This bug report intentionally does NOT pick a winning hypothesis or fix shape. The four hypotheses are preserved as a decision tree so the next person to touch this can make a judgment call with full evidence. Recommend the fixer:

1. Read `spawn-refinement-team.js`'s gate logic (likely in `extension/src/bin/spawn-refinement-team.ts`) and confirm/refute each hypothesis with source-level evidence.
2. Read attempt 1/2/3 manifests at `/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-27-aeb6ec52/refinement_manifest.json{,.attempt1,.attempt2}` for primary-source data.
3. Pick the narrowest fix that addresses the dominant hypothesis. Combined fixes only if narrow fix demonstrably fails to kill recurrence.
4. Add at least one regression fixture (attempt 1's PRD) before shipping.

*Stop being a J-Jerry, fixer. Read the evidence, pick the right cause, ship the right fix. Don't just patch what you see — look at all four angles. Burp.*
