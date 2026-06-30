# Completion / Validation Seam-Coverage Map

> Source of truth for AC-D1 (PRD `p1-design-ground-truth-efficacy-followup-2026-06-14.md`, WS-D).
>
> R-DSAN's promise — "consolidate the seams so seam N+1 inherits the fix" — only holds if every
> completion/validation seam is enumerated and proven to route through a single canonical authority
> rather than re-implementing the decision (a doc-only exception). This file is that enumeration.

## Disposition legend

Each seam below carries exactly one disposition:

- **`routed-through-canonical-authority`** — the seam delegates its completion/validation decision to a
  named shared primitive (no local re-implementation). A fix to the primitive is inherited automatically.
- **`documented-exception`** — the seam intentionally does NOT route through a shared primitive; the
  reason is documented inline. (None of the three incident seams may carry this disposition.)

The **three incident seams** are `pickle clean-exit`, `readiness forward-ref`, and
`config-protection read`. All three are `routed-through-canonical-authority` with ZERO doc-only exits.

Every "canonical function" named below is grep-verified to exist in source (see
`research_*` artifact / the AC #2 grep). There is NO general `haltOrRecover` primitive — the only
halt/recover primitive is `haltOrRecoverCodexNoProgress`, which is `codex-only` (see the caveat section).

---

## WS-A — completion authority (mux-runner.ts / pipeline-runner.ts / lib)

### Seam: `pickle clean-exit` completion — `routed-through-canonical-authority`
Canonical decision is computed once and reused. No seam re-derives "is the epic done".
- `evaluateEpicCompletion` (`extension/src/bin/mux-runner.ts:1929`) — the completion state machine;
  call sites `mux-runner.ts:6256` and `:9517`.
- `applyAllTicketsDoneCompletion` (`extension/src/bin/mux-runner.ts:1812`) — the all-terminal
  short-circuit completion; call site `mux-runner.ts:8272`.
- AC-A1/A2 exit-0 gate: mux exit-0 is gated on all-terminal (commits `508cb144`, `a339b491`,
  `750cfb03` / `d3a22538`) and reuses `evaluateEpicCompletion` rather than a parallel guard.
- AC-A4 bounded escape: `evaluateBoundedEscape` (`mux-runner.ts:4995`) /
  `executeBoundedEscape` (`mux-runner.ts:5047`) force an unreclaimable In Progress ticket terminal via
  `salvageTicket` (`extension/src/lib/salvage-ticket.ts:117`) → `reconcileTicketTruth`
  (`extension/src/lib/reconcile-ticket-truth.ts:84`); call sites `mux-runner.ts:6127/:6129` and
  `:9796/:9798`.

### Seam: pipeline phase-incomplete halt — `routed-through-canonical-authority`
- `reportPhaseIncomplete` (`extension/src/bin/pipeline-runner.ts:2962`) — the single
  `pipeline_phase_incomplete` exit-reason stamp; call sites `pipeline-runner.ts:3132`, `:3353`,
  `:3441`, `:3535`. All phase-halt paths reuse it (no parallel completion guard).

### Seam: bounded terminal escape ledger — `routed-through-canonical-authority`
- `evaluateBoundedEscape` / `executeBoundedEscape` (`mux-runner.ts:4995` / `:5047`) — the per-ticket
  capped escape that draws down `state.recovery_attempts`; the only generic (non-codex) path that
  forces terminal, and it does so through the same `salvageTicket` → `reconcileTicketTruth` authority
  as the clean-exit seam above.

---

## WS-B — readiness validation (check-readiness.ts)

### Seam: `readiness path resolution` — `routed-through-canonical-authority`
Path resolution is decided by a single shared resolver; the hard-halt predicate is one named
expression, not a per-call-site copy. (The forward-ref annotation grammar was subtracted in
v2.0.0-beta.33 — readiness is advisory, so the suppression machinery it fed is gone.)
- `resolvePathRef` (`extension/src/bin/check-readiness.ts:findPathFindings`) — AC-B2
  repo-basename-prefix strip + R-RTRC-4 HEAD git-ls-files suffix-match (commit `e395a0bb`).
- AC-B4 observability: `readiness_false_positive_suppressed` activity event — non-blocking counter,
  never alters exit code.

---

## WS-C — config-protection read (hooks/handlers/config-protection.ts)

### Seam: `config-protection read` gate — `routed-through-canonical-authority`
The Bash config-file gate is write-aware (reads are approved) and reuses the existing state
write-detection rather than a second tokenizer.
- `detectTargetedConfigFile` (`extension/src/hooks/handlers/config-protection.ts:435`) — the entry
  detector; call site `config-protection.ts:938`. Its Bash branch returns
  `bashWritesProtectedConfig` (`config-protection.ts:444`).
- `bashWritesProtectedConfig` (`config-protection.ts:288`) — the write-aware detector (AC-C1, commit
  `983b3de8`): returns a config basename only when a WRITE targets it, `null` for reads.
- `detectBashStateWriteTarget` (`config-protection.ts:362`) — the canonical write-detection authority;
  `bashWritesProtectedConfig` reuses its shared `REDIRECT_DEST_COMMANDS` set so the two gates share one
  source of write-command truth (no duplicated parser).

---

## Caveat — there is no general `haltOrRecover` primitive

`haltOrRecoverCodexNoProgress` (`extension/src/bin/mux-runner.ts:4896`) is `codex-only`: it serves the
four codex no-progress halt sites (`mux-runner.ts:6077`, `:6203`, `:9737`, `:9866`) and nothing else.
Do NOT cite a fictional general `haltOrRecover` — the generic (non-codex) terminal-forcing authority is
the bounded escape (`evaluateBoundedEscape` / `executeBoundedEscape` → `salvageTicket` →
`reconcileTicketTruth`) documented under WS-A, not a halt/recover primitive.

---

## Coverage summary

| WS | Seam | Disposition | Canonical authority |
|:---|:---|:---|:---|
| A | `pickle clean-exit` completion | `routed-through-canonical-authority` | evaluateEpicCompletion / applyAllTicketsDoneCompletion / evaluateBoundedEscape+executeBoundedEscape → salvageTicket → reconcileTicketTruth |
| A | pipeline phase-incomplete halt | `routed-through-canonical-authority` | reportPhaseIncomplete |
| A | bounded terminal escape ledger | `routed-through-canonical-authority` | evaluateBoundedEscape / executeBoundedEscape |
| B | `readiness path resolution` | `routed-through-canonical-authority` | resolvePathRef (+ readiness_false_positive_suppressed) |
| C | `config-protection read` gate | `routed-through-canonical-authority` | detectTargetedConfigFile → bashWritesProtectedConfig → detectBashStateWriteTarget |

Doc-only exceptions: **none**. Every enumerated WS-A/B/C seam routes through canonical authority.
