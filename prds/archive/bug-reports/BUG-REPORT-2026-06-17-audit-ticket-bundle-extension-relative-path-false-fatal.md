# BUG REPORT 2026-06-17 — audit-ticket-bundle flags extension-relative paths as `hallucinated-premise` fatal (gate-parity gap with check-readiness)

**Finding:** #120 R-ATPR (audit-ticket-bundle path-resolution parity). **Priority:** P2 (pipeline-friction — fatal-blocks bundle launch at iteration 0; recoverable via the unified `skip_quality_gates_reason`). **Class:** D1 validation-overreach (`feedback_pickle_rick_autonomy_north_star`).

## Live incident

B-WPEX-AUTO build, session `2026-06-17-ba399c8e`. mux-runner halted at **iteration 0** with `exit_reason: ticket_audit_failed` before spawning any worker. The blocking finding (`audit-ticket-bundle.json`):

```json
{ "ticket_id": "0cc63223", "defect_class": "hallucinated-premise", "severity": "fatal",
  "evidence": "Problem section cites nonexistent code path `src/lib/salvage-ticket.ts`" }
```

The path is **real** — `git ls-files extension/src/lib/salvage-ticket.ts` resolves; the file defines `salvageTicket`. It is cited extension-relative (`src/lib/salvage-ticket.ts`), the convention every ticket in the bundle uses.

## Root cause — gate-parity gap

`audit-ticket-bundle.ts` resolves ticket paths via `gitListFiles(workingDir)` with `workingDir` = the session's `working_dir` = **repo root** (`pickle-rick-claude/`). `git ls-files` there returns `extension/src/lib/salvage-ticket.ts`; the ticket cites `src/lib/...` → no match → `hallucinated-premise` fatal.

Meanwhile `check-readiness.ts` (run by mux's `runMuxReadinessGate`) **PASSED** the same bundle (`status:pass, findings:[]`) on the same extension-relative paths — it resolves with extension-aware handling (and a suffix-match fallback, R-RTRC-4). So the two pre-flight gates disagree on path resolution for the same ticket bodies: **readiness green, ticket-audit fatal.**

Secondary asymmetry: other tickets cite `src/bin/mux-runner.ts` etc. and got only `info` `cross-doc-naming-drift` (not fatal) — because those basenames appear in cross-referenced docs (CLAUDE.md), so the naming-drift softener catches them. `salvage-ticket.ts`'s basename is not in the docs the audit reads, so it escalated straight to fatal. The softener is incidental, not a real resolver.

## Impact

Any future bundle that cites an extension-relative path whose basename is not mentioned in a cross-referenced doc will fatal-block at iteration 0 — a false-block on a correctly-authored, readiness-green bundle. This is the recurring "tooling resolves from repo root, but the code lives in `extension/`" class (cf. #115 R-CIFB EXTENSION_DIR, the readiness `path_not_verified` noise).

## Workaround applied (this incident)

Set the unified `state.flags.skip_quality_gates_reason` (W1a sanctioned bypass) with an evidence-cited justification after confirming the file is real, then relaunched. The bundle then ran. **This is a band-aid** — per the north-star, a gate that false-blocks legitimate work should be fixed, not permanently skip-flagged.

## Acceptance criteria (fix the gate, do not add a second escape hatch)

- [ ] **AC-R-ATPR-1 — extension-aware path resolution parity.** `audit-ticket-bundle.ts` resolves a ticket's backticked paths with the SAME root/suffix handling `check-readiness.ts` uses (reuse the R-RTRC-4 path normalizer / suffix-match against `git ls-files`), so an extension-relative path to a real file does NOT produce `hallucinated-premise`. — Verify: a fixture ticket citing `src/lib/salvage-ticket.ts` (real at `extension/src/lib/salvage-ticket.ts`) audits clean. — Type: test
- [ ] **AC-R-ATPR-2 — `hallucinated-premise` requires real non-resolution, not basename-absent-from-docs.** The escalation to fatal fires only when the cited path resolves under NEITHER repo-root NOR extension-relative NOR suffix-match — never merely because the basename is absent from cross-referenced docs. — Verify: a real-but-doc-unmentioned path audits clean; a genuinely fake path still fatals. — Type: test
- [ ] **AC-R-ATPR-3 — gate-parity regression.** A fixture bundle that `check-readiness` passes MUST NOT be `hallucinated-premise`-fataled by `audit-ticket-bundle` on path grounds. — Verify: parity test over a shared fixture. — Type: test

## Simplification Review (subtract-before-add)

1. **Necessary?** Yes — fixes a false-fatal that blocks legitimate launches.
2. **Reuse not add?** YES — reuse the existing R-RTRC-4 path normalizer / `forward-ref-annotation.ts` resolver that `check-readiness` already uses. Do NOT build a second path resolver in `audit-ticket-bundle`.
3. **Guards brittle complexity that should be subtracted?** The `hallucinated-premise` check's reliance on the incidental "basename-in-docs" naming-drift softener is the brittle part — replace it with real resolution, removing the accidental softener dependency.
4. **Subtract?** Removes the band-aid path (a future bundle no longer needs `skip_quality_gates_reason` to dodge this) and collapses two divergent path resolvers toward one shared resolver.
