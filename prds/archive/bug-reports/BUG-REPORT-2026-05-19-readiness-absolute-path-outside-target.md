# Pickle Rick pipeline bug report — 2026-05-19

**Reporter:** gregory@loanlight.com
**Session:** `~/.local/share/pickle-rick/sessions/2026-05-19-65fd1881`
**Pipeline:** `/pickle-pipeline --backend codex` on `docs/prd-loa-727-rule-coverage-and-1025-hardening.md` (LOA-727/754/785 consolidated)
**Outcome:** Pickle phase died at 1m 2s on `READINESS HALT: check-readiness exited 2`. Operator set `skip_readiness_reason` and relaunched; second launch advanced past readiness into the pickle worker dispatch.
**Severity:** S3 — pipeline halts on legitimate ticket shapes (forward-created files + session-relative `source_prd` paths) that the skill prompt instructs operators to write. Existing escape hatch works but the gate's error messages are misleading.
**Relation to prior reports:** This is one fresh data point in a class already documented in `prds/BUG-REPORT-2026-05-18-pipeline-launch-friction.md` (Bug 2 + Finding #34 R-FRA "forward-create gate findings" + Finding #36+ R-RTRC-7 "readiness exit semantics"). Folding the new evidence here so R-FRA's next refinement pass has the operator-supplied repro material.

---

## What was new today

1. **`source_prd` outside `TARGET` triggers 13 false-positive findings**, one per non-hardening ticket. The agent that authored the tickets correctly stamped `source_prd: /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-19-65fd1881/prd.md` (absolute path; the session PRD lives outside `TARGET=/Users/gregorydickson/loanlight/loanlight-api-loa-727/`). The readiness verifier reported each failure as:

   ```
   - **file_path** in `28c32088/linear_ticket_28c32088.md`
     - suggested_analyst: codebase
     - Referenced ticket file path does not resolve: `Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-19-65fd1881/prd.md`
   ```

   **The leading `/` is missing from the reported path.** Either the verifier strips it before reporting (cosmetic bug) or the verifier strips it before resolving (`path.join(TARGET, 'Users/.../prd.md')` fails to find the session file — actual bug). The 13 identical findings across every ticket pollute the readiness doc and obscure the genuine forward-create gate hits below.

2. **Forward-created files that the tickets themselves CREATE register as missing**. Same R-FRA class already filed, but the fresh evidence list is worth keeping:

   - `packages/api/scripts/check-bedrooms-poisoning.ts` — created by ticket `17645edb` (WS2.5 cohort gate) but referenced as a "Files to modify/create" target in tickets `17645edb`, `1d126e81`, `671d7b56`, `a1d4adb7`, `d3b42939`.
   - `packages/api/e2e/fixtures/onestopappraisals_Unger_1346457.json` — created by ticket `1d126e81` (WS2.5 Unger fixture promotion) and referenced in the same ticket's AC.
   - `packages/api/src/lib/appraisal-pipeline/__tests__/ws6-followups-audit.spec.ts` — created by ticket `01a439b0` (WS6 follow-ups audit) and referenced in tickets `48061c59`, `a1d4adb7`.

   Each ticket explicitly declares the file under `Files to modify/create:` AND the readiness verifier still reports them as missing. The skill prompt's Step 7c says `Files to modify/create` is the correct field for new files, so the writer is following the documented shape and the gate is rejecting it.

3. **Backtick-wrapped prose paths are picked up as file references**. Ticket `01a439b0` had a Research Seeds bullet:

   ```
   - 6.1: `integration-event.dto.ts:26-31` — search the repo to find exact path (likely `packages/api/src/...modules/.../integration-event.dto.ts`).
   ```

   The backticked ellipsis path `packages/api/src/...modules/.../integration-event.dto.ts` was emitted to four hardening tickets via `MODIFIED_FILES` propagation and showed up in the readiness doc as a literal "path does not resolve" finding. Operator-supplied prose hedging (`likely`, `worker to discover`) does not signal to the verifier that the path is hypothetical.

---

## Diff vs. 2026-05-18 BUG-REPORT

| Concern | 2026-05-18 evidence | 2026-05-19 evidence |
|---|---|---|
| Forward-created contracts (R-FRA) | `FieldLocation.bbox`, `appraisal_runs.field_source_location_map`, `featureFlags.appraisal_bbox_citations`, `viewport.transform` — Zod/SQL/feature-flag symbol references | `check-bedrooms-poisoning.ts`, `onestopappraisals_Unger_1346457.json`, `ws6-followups-audit.spec.ts` — filesystem path references |
| Skip flag naming | DEPRECATION line documented: `skip_readiness_reason` is legacy, prefer unified flag (name not in this transcript) | Used legacy `skip_readiness_reason`; mux-runner accepted it without emitting the deprecation message — possibly because the source-vs-deployed parity is stale for this codepath |
| Path verifier behavior | Not surfaced | **NEW**: absolute paths outside `TARGET` get reported without leading `/` and treated as missing |
| Prose-hedged paths in backticks | Not surfaced | **NEW**: `(likely `packages/...`)` prose treated as a hard file reference |

---

## Proposed remediation (folds into R-FRA / R-RTRC-7)

These are not new R- items; they are operator-supplied refinement seeds for the existing pair.

### R-FRA refinement seeds

1. **Source-relative path recognition.** When a ticket's `source_prd` frontmatter value matches the session's `prd.md` path, skip path-resolution for it — the readiness gate already knows the PRD location from `state.json`. Today the gate treats `source_prd` like any other backticked path inside the ticket body.

2. **Honor `Files to modify/create` as forward-create signal.** If a path appears inside a `Files to modify/create:` line, do not report it as a missing-file finding. The ticket schema in `pickle-refine-prd.md` Step 7c documents this field as the conventional declaration of new files.

3. **Soften prose-hedged backticks.** Strings containing `...` (ellipsis), `<placeholder>`, `(likely ...)`, or `(worker to discover...)` should be classified as "advisory reference" rather than a hard file path. The current `check-readiness.ts` regex appears to greedily grab anything inside backticks that looks like a path.

### R-RTRC-7 refinement seeds

1. **Stable exit message.** The runner stamps the same `READINESS HALT: check-readiness exited 2` even when the operator already set `skip_readiness_reason`. The skip flag did its job on the second launch — but the second launch had to consume the flag silently because the legacy doc-generation step still ran (overwrote `readiness_2026-05-19.md` with the same findings as launch #1). Consider one of: (a) write a `readiness_<date>_skipped.md` sidecar with the skip rationale instead of overwriting, or (b) suppress the dry-run findings entirely when the skip flag is present.

2. **Leading-slash preservation in error reporting.** Whatever transformation `check-readiness.ts` applies to the reported `Referenced ticket file path does not resolve: \`...\`` line should preserve a leading `/` so operators can see whether the verifier is treating the path as absolute (correct) or relative (the bug).

---

## Repro context

```
/pickle-pipeline docs/prd-loa-727-rule-coverage-and-1025-hardening.md --backend codex
# → Step 0 auto-inference did not trigger refinement (regex too narrow)
# → operator was asked "refine or skip"; chose refine
# → /pickle-refine-prd ran 3 cycles, produced 9 analyses + manifest with 5 ac_shape_smells + 3 candidate tickets (with justification blocks)
# → general-purpose subagent authored 1 parent + 11 implementation + 4 hardening = 16 ticket files (skipped wiring per skip-gate; PRD has no application entry point)
# → state.json advanced to step=research, current_ticket=28c32088 (WS2.1 bedrooms fix, order=10)
# → /pickle-pipeline Step 3 resumed setup.js with --backend codex
# → pipeline.json written with scope=branch + backend=codex
# → tmux launch; PHASE 1/4 PICKLE started
# → 1m 2s in: READINESS HALT (this report)
# → operator set state.flags.skip_readiness_reason + cleaned ellipsis paths in 4 tickets + relaunched
# → pickle phase advanced past readiness; worker dispatch in progress at report time
```

Session preserved at `~/.local/share/pickle-rick/sessions/2026-05-19-65fd1881/` including:
- `state.json` — has `flags.skip_readiness_reason` set + history
- `readiness_2026-05-19.md` — 223 lines, all 30+ findings catalogued
- `pipeline-runner.log` — both launch attempts
- `mux-runner.log` — first launch readiness halt + second launch worker spawn
- 16 ticket files under per-hash subdirectories

---

## Operator notes on the workaround

The `skip_readiness_reason` escape hatch worked exactly as documented in `/pickle-pipeline` Step 2 ("Skip-flag overrides"). The user-facing experience improvement that would help is teaching the readiness gate to recognize the three legitimate-failure classes above so the operator doesn't need to set the skip flag every time tickets are well-formed by the documented contract.

Until R-FRA refinement lands, the skip-flag workflow remains the documented path and operators should expect to use it for every PRD-driven pipeline whose tickets create new files or live outside `TARGET`.
