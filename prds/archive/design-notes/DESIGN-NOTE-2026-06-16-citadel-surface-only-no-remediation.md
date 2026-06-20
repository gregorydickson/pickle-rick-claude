# DESIGN NOTE — Citadel surfaces sub-Critical findings but nothing remediates them (2026-06-16)

**Status:** OPEN — operator-flagged **design question / enhancement (capture-only)**. Filed during LOA-1156 babysitting (session `2026-06-15-38d424e1`, repo `loanlight-api`, claude backend).
**Type:** Design question, NOT a defect. **No fix is prescribed** — per operator direction, this is logged so the owner can decide whether the current behavior is intended or worth an enhancement. The runbook in `babysitter.md` (tooling-defect capture) is being used as the capture channel; this is deliberately filed as a NOTE, not a `BUG-REPORT`, because the surface-only behavior is documented and may be by design.

## Operator signal

> "I think citadel not fixing is a design question or enhancement — I don't want to suggest a fix but we should log this."

## Observed behavior (this run)

The LOA-1156 `/pickle-pipeline` ran citadel as phase 2/4. Citadel wrote `citadel_report.json` with **5 findings**, then the pipeline-runner logged:

```
citadel: cycle 1/3 — wrote citadel_report.json with 5 finding(s), 0 remediable (>= Critical)
citadel: no remediable findings — phase complete, continuing pipeline
```

The 5 findings (none actioned by any phase):

| Severity | Section | Finding |
|---|---|---|
| Medium | `trap_door_coverage` | orphan-test-file: `ab-accuracy-harness.spec.ts` has no inbound ENFORCE ref |
| Medium | `trap_door_coverage` | orphan-test-file: `mandatory-fields.spec.ts` has no inbound ENFORCE ref |
| Medium | `trap_door_coverage` | orphan-test-file: `optimized-schema-integrity.spec.ts` has no inbound ENFORCE ref |
| Medium | `banned_constructs` | brace-free `if` at `optimized-schema-integrity.spec.ts:45` — banned by CLAUDE.md |
| Low | `cross_phase` | `anatomy-park.json` absent (ordering artifact — citadel runs phase 2, anatomy-park phase 3) |

## The design question

Citadel is **surface-only by design** — `.claude/commands/citadel.md:25`: *"The command surfaces findings only; it does not auto-edit source files."* Coupled with the pipeline-runner's remediation gate, which classifies a finding as actionable **only at `>= Critical`**, the net effect is:

> **Any finding below Critical — including findings with a trivial, deterministic, single-line fix — falls through every pipeline phase and relies entirely on a human to notice and fix it.**

Concretely in this run, the `banned_constructs` finding (a CLAUDE.md-banned brace-free `if`) is a mechanical wrap-in-braces fix that a gate-remediator could apply with zero judgment, yet it survived citadel → anatomy-park → szechuan untouched. (szechuan targets coding-*principle* violations, not lint/banned-construct rules, so it does not pick these up either.)

Open questions for the owner — **not** a proposed solution, just the decision surface:

1. Is surface-only a deliberate safety boundary (citadel must never mutate source), and the gap is purely that **no downstream consumer** acts on sub-Critical mechanical findings?
2. If so, should a **separate** deterministic-remediation step (e.g. a gate-remediator pass keyed off `citadel_report.json`) own the mechanical subset — `banned_constructs`, prettier/eslint-autofixable, orphan-test ENFORCE annotations — leaving semantic findings advisory?
3. Or is the current "log-and-continue for everything < Critical" the intended contract, and the expectation is that the operator triages the report?

Note the inverse-symmetry with **#115 R-RGO RC-3** (readiness gate: *one* finding = hard halt, no graduated tier). That was about an over-aggressive halt floor; this is the opposite end — citadel's **no-action floor**. A unified "graduated finding-handling tier" design (auto-remediate mechanical / advisory semantic / halt-on-critical) would address both, but that is a synthesis for the owner to weigh, not a recommendation made here.

## Scope / non-goals

- **Capture-only.** No acceptance criteria, no implementation plan, no fix.
- This note does NOT cover the substantive anatomy-park finding from the same run (`overlays.ts` read/write asymmetry) — that was a real product bug, filed separately as **LOA-1190** in the `loanlight-api` Linear (out of pickle-rick scope).
- The `anatomy-park.json absent` Low finding is a known phase-ordering artifact (self-resolving) and is not part of this question.

## Evidence

- Session: `~/.local/share/pickle-rick/sessions/2026-06-15-38d424e1/`
  - `citadel_report.json` — the 5 findings
  - `pipeline-runner.log` — `0 remediable (>= Critical)` / `no remediable findings — phase complete`
- `.claude/commands/citadel.md:25` — surface-only contract
