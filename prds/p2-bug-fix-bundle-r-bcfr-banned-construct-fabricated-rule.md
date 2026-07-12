---
title: "R-BCFR (subtractive) — the citadel banned-construct arms cite a CLAUDE.md rule that does not exist; subtract them"
priority: P2
finding: R-BCFR
status: "open — filed 2026-07-12 from live citadel loop (session 2026-07-11-255ad373)"
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
depends_on: "none (deploy-agnostic BUILD; pipeline-safe — see Routing)"
source_assessment: "Live field evidence: citadel ran 3 cycles, produced 43 findings ALL of one class, remediated 0, and the gate remediator refused twice with loop_detected:true. Every claim below re-verified independently against source, not inherited from the remediator's abort doc."
---

# P2 Bug-Fix Bundle — R-BCFR: subtract the fabricated `banned-construct` arms

## Context

`/pickle-pipeline` session `2026-07-11-255ad373` (R-SCPIN bundle), citadel phase, 2026-07-12:

- Citadel ran its full **3 remediation cycles** and ended with **43 findings remaining, 0 remediated**.
- All 43 are one class: `banned-construct:brace-free-if`, across `bin/setup.ts` (1), `services/pickle-utils.ts` (4), `services/state-manager.ts` (38).
- The gate remediator **refused, twice, identically** — `gate/remediation_2026-07-12T19-06-49Z_result.json` records
  `outcome:"aborted"`, `reason:"fix_outside_permitted_classes"`, `consecutive_abort_count:2`, `loop_detected:true`,
  `failures_remediated:0`, `files_edited:[]`. The gate regenerated a byte-identical brief 73s after the first abort.
- The pipeline continued (`pipeline_continue_on_phase_fail`) and stamped `citadel_findings_unremediated` ×2 into
  `state.activity`, then proceeded to anatomy-park.

The remediator was **right to refuse**. The finding class is not a defect in the flagged code — it is a defect in the
analyzer.

## Root cause — the cited rule does not exist

Verified independently (2026-07-12, branch `experiment/fable-operating-manual`):

1. **The citation is a hardcoded string literal, not a rule.**
   `extension/src/services/citadel/banned-constructs-audit.ts:129` emits
   `` `Brace-free if at ${file}:${no} is banned by CLAUDE.md; wrap the statement in a \`{ ... }\` block.` ``
   Grepping every `CLAUDE.md` in the repo (root, `extension/`, `extension/src/bin/`, `extension/src/hooks/`,
   `extension/src/services/`, `prds/`, and `~/.claude/`) for a brace-free-`if` ban returns **zero** rules. The single
   hit is `prds/CLAUDE.md:46`, which rules the **opposite**: "the subtraction is to leave brace-free-`if` to
   **eslint/prettier autofix** (existing tooling)."

2. **The real lint gate is clean on the flagged files.** `extension/eslint.config.js` configures **no `curly` rule**.
   `npx eslint` over all four flagged source files exits **0** with empty output. Citadel is the only thing that
   objects, and it objects by citing a document that does not say what it claims.

3. **It is the house style, and the analyzer violates its own rule.** Brace-free `if` is pervasive in `extension/src`
   — including **inside `banned-constructs-audit.ts` itself** (13 occurrences by an anchored matcher; the remediator's
   looser matcher counted 11 in-file and 2,673 repo-wide). Either count makes the same point: remediating 43 leaves
   the flagged files internally inconsistent with the analyzer enforcing the rule.

4. **The gate cannot converge, by construction.** `collectChangedCodeLines` (`banned-constructs-audit.ts:47`) scans
   only **changed diff lines**. Wrapping these 43 fixes nothing durably: the next bundle that touches
   `state-manager.ts` re-pays the tax, forever. This is a guard that false-blocks beyond any budget — which
   `extension/CLAUDE.md` (W5b, subtract-before-add) says is "loosened or removed, never given a second escape hatch."

5. **The sibling arm has the identical defect.** `banned-constructs-audit.ts:118` (`isNestedTernary`, `:74`) emits
   `Nested/chained ternary at ... is banned by CLAUDE.md` — the same fabricated citation. No `CLAUDE.md` carries a
   general ternary ban; the only `ternary` hits in `extension/CLAUDE.md` are two **narrow** invariants (R-SCJM-5
   judge-spawn backend ternary, R-MBLE-1 aggregator 3-way switch), neither of which is a construct-wide ban.

6. **Precedent: the same shape was already resolved by subtraction.** The R-PCPS trap door records
   `citadel/pattern-conformance-audit.ts` emitting "41/41 false High findings on a clean tree"; the resolution was to
   **subtract the arm**, not remediate. This is 43/43 of the same shape.

### Why this is not B-CSOR

B-CSOR ✅ **shipped at beta.11** (`750e3f58`): `mechanical-finding-classifier.ts` plus the `remediable ∪ mechanical`
union in `executeCitadelPhase` exist precisely so that `banned-construct:brace-free-if` **does** reach the remediator.
The machinery works exactly as designed. B-CSOR was de-queued as stale on 2026-07-11.

This run proves the de-queue was right for the wrong reason. The residual was never "citadel doesn't commit its own
remediation" — it is that **the finding class should not exist**. B-CSOR built a delivery pipe for a rule nobody wrote.

## WS-1 — delete the `isBraceFreeIf` arm (SHIP)

### Changes

- `extension/src/services/citadel/banned-constructs-audit.ts`: delete `isBraceFreeIf` and its finding-emission branch
  (the `:129` message block). Delete any now-orphaned helper reachable only from it.
- Delete the `banned-construct:brace-free-if` entry from `mechanical-finding-classifier.ts`'s mechanical set (it
  becomes an empty/absent class — see the note in WS-2 about the set's remaining members).
- Prune the corresponding fixtures/assertions in the citadel test surface.

### Acceptance criteria (machine-checkable)

- `AC-BCFR-1`: `grep -c "isBraceFreeIf" extension/src/services/citadel/banned-constructs-audit.ts` == `0`.
- `AC-BCFR-2`: `grep -rc "banned-construct:brace-free-if" extension/src/` == `0`.
- `AC-BCFR-3`: `grep -rc "is banned by CLAUDE.md" extension/src/` == `0` (WS-1 + WS-2 together; WS-1 alone reduces it
  from 2 to 1).
- `AC-BCFR-4`: a citadel run over a diff containing a brace-free `if` produces **zero** findings of that class
  (regression test, `extension/tests/citadel/`).
- `AC-BCFR-5`: `npx tsc --noEmit` and `npx eslint src/ --max-warnings=-1` both exit 0 from `extension/`.
- `AC-BCFR-6`: the citadel analyzer-wiring test (`citadel-analyzer-wiring.test.js`, R-CCNW-2) still passes —
  `banned-constructs-audit.ts` must remain wired and invoked by `audit-runner.ts` if any arm survives WS-2; if **no**
  arm survives, the module is deleted and removed from `audit-runner.ts` in the same change (the wiring invariant
  forbids an on-disk-but-uninvoked analyzer).

### Simplification Review (subtract-before-add) — WS-1

1. **Is the addition necessary at all?** WS-1 adds **nothing**. It is pure removal — the ideal case.
2. **Can it REUSE instead of ADD?** N/A (no addition). The style question, if the operator ever wants it enforced, is
   already served by existing tooling: eslint `curly` + `--fix`. See "Out of scope."
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** Yes, and subtraction is exactly
   what this does. The brittle thing is the arm itself: it false-blocks 43/43 on a tree the real gate calls clean, it
   cannot converge (changed-lines-only scan), and B-CSOR already built one escape hatch (the mechanical hand-fix
   class) *around* it. A second hatch would be the smell W5b names; the guard is simply wrong.
4. **What can this issue SUBTRACT?** The `isBraceFreeIf` arm, its finding class, its mechanical-classifier entry, its
   fixtures — and the permanent per-bundle remediation tax it levied on every future diff touching these files.

## WS-2 — re-ground or delete the `isNestedTernary` arm (SHIP)

The sibling arm rests on the same fabricated citation. Verify, then act — do not assume.

### Changes

- Grep every `CLAUDE.md` for a general nested/chained-ternary ban.
  - **If none exists** (expected): delete `isNestedTernary` and its `:118` emission, same shape as WS-1.
  - **If one exists**: keep the arm but rewrite the message to cite the **actual** file and line of the rule, and add
    the rule's path to the finding payload so the citation is falsifiable.
- If both arms are deleted, delete `banned-constructs-audit.ts` entirely and unwire it from `audit-runner.ts`
  (R-CCNW-2 forbids an analyzer that exists but never runs).

### Acceptance criteria (machine-checkable)

- `AC-BCFR-7`: no source file under `extension/src/` emits a finding message containing the substring
  `banned by CLAUDE.md` unless the same finding payload carries a `rule_source` field naming an existing file:line
  that contains the rule.
- `AC-BCFR-8`: if `banned-constructs-audit.ts` is deleted, `grep -c "banned-constructs-audit" extension/src/services/citadel/audit-runner.ts` == `0`
  and `citadel-analyzer-wiring.test.js` passes.
- `AC-BCFR-9`: full release gate green from `extension/` (tsc + eslint + 9 audits + `test:fast:budget` + `test:integration`).

### Simplification Review (subtract-before-add) — WS-2

1. **Is the addition necessary at all?** In the expected branch, WS-2 adds nothing — second pure removal. In the
   contingent branch it adds exactly one field (`rule_source`), which exists to make a citation **falsifiable** — the
   property whose absence produced this bug.
2. **Can it REUSE instead of ADD?** Yes — the contingent branch reuses the existing `Finding` payload shape rather
   than introducing a parallel provenance mechanism.
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** No new guard. It removes (or
   grounds) an existing one.
4. **What can this issue SUBTRACT?** The second fabricated citation, and — if both arms go — an entire analyzer module
   plus its wiring.

## Risks

- **Losing a rule someone actually wanted.** Mitigated: WS-2 requires the grep before the delete, and "Out of scope"
  below records the honest path to adopting the style if the operator wants it. Nothing about deleting a *fabricated*
  citation prevents adding a *real* rule later.
- **The mechanical set becomes empty.** B-CSOR's mechanical set is exactly `{banned-construct:brace-free-if}`. Removing
  it empties the set. That is acceptable — the union floor in `executeCitadelPhase` degrades to the plain severity
  threshold, which is its pre-B-CSOR behavior — but the ticket must decide explicitly whether `mechanical-finding-classifier.ts`
  survives as dead scaffolding (it should not) or is subtracted with its last member. **Prefer subtracting it.**

## Out of scope

- **Adopting the brace style honestly.** If the house genuinely wants braces: add `curly` to `extension/eslint.config.js`,
  run `eslint --fix` repo-wide (all occurrences, not 43), and document the rule in `extension/CLAUDE.md` so the citation
  becomes true. That is a separate, operator-owned decision — and it is a *lint* change, not a citadel change.
- Any change to the citadel severity threshold or the remediation-cycle count. The remediator behaved correctly here;
  the cycles were wasted on a bad input, not misspent by a bad loop.
- The gate remediator's silently-dead lock strand — filed separately as **[[R-GRLS]]**.

## Routing

**Pipeline-safe (NOT R-PSRB).** This bundle touches the citadel analyzer surface only — not `mux-runner.ts` salvage /
no-progress logic, not `salvage-ticket.ts`, `reconcile-ticket-truth.ts`, or `ticket-completion-evidence.ts`. The run
executes the **deployed** JS, so source edits here cannot perturb the worker building them. Drain via `/pickle-pipeline`.
