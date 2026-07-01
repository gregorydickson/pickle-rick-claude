---
r_code: R-SIGFH
priority: P2
status: Todo
source_bug_report: prds/archive/bundles/p1-bug-fix-bundle-b-sigf-scope-auto-extension-2026-06-28.md
bundle_thesis: >
  Harden the shipped R-SIGF signature/schema-shape caller-gap detector: make its wall-budget
  real (WS-1), then safely widen its coverage (WS-2 bridge-export forms, WS-3 candidate corpus +
  cache-thread). One coherent wound — an unenforced budget and two fail-OPEN coverage holes.
---

# B-SIGFH — R-SIGF scope-fence detector hardening *(refined 2026-07-01)*

Refined from `prds/p2-bug-fix-bundle-b-sigfh-scope-fence-detector-hardening-2026-07-01.md` via the
3-analyst × 3-cycle team. Analyses in `refinement/`. Serves as the **codex GA phase-completion soak**
and the **first field-soak of the beta.35 synchronous-lifecycle collapse**.

## Problem & workstreams

Three verified gaps in `extension/src/services/signature-caller-gap.ts` (see the original PRD for the
full statement; ticket bodies carry line-anchored detail):

- **WS-1 (eda8ef25):** `detectSignatureCallerGaps` never reads `cache.deadline` / sets
  `cache.truncated`; the wall-budget is corpus-size-only.
- **WS-2 (42aac227):** `findFactoryBridgeNames` matches only `export function|const|let|var` — misses
  `export default`, `export class`, and `export { name }`/`{ name as alias }` re-exports → fail-OPEN
  on factory-mediated schema-shape gaps. *(Parametrized ticket — `describe.each` over the four forms;
  manifest `ac_shape_smells` collapse.)*
- **WS-3 (b86a1e82):** `callerCandidateFiles` scans only `.spec.ts`+factory → production callers
  invisible (fail-OPEN); widening REQUIRES threading a bounded cache into the scope-build path.

## Refinements folded in (risk-analyst-driven, Cycle 3)

1. **WS-1 framing corrected.** The readiness path (`check-readiness.ts:1204`) passes a `cache`, so
   WS-1's deadline is honored there. The scope-mutating build path
   (`pipeline-runner.ts:1635 computeScopeAutoExtension`) passes **no cache**, so WS-1 is inert there
   until WS-3 threads one. WS-1's honest value: bound the readiness scan and complete the
   budget-producer half WS-3 consumes.
2. **WS-3 cache-thread added (P0).** WS-3 MUST build a `ResolverCache` and pass it to the
   `pipeline-runner.ts:1635` call, or its widened whole-repo corpus scan is unbounded on the flag-ON
   scope path (verified latent hang). One deadline (WS-1) + one candidate-count cap (WS-3) — no second
   wall-budget.
3. **4 hardening tickets + wiring SKIPPED (documented downgrade).** This bundle IS hardening; the
   pipeline's citadel/anatomy-park/szechuan-sauce phases already provide the cross-cutting review.
   Running the 4 meta-hardening tickets would be redundant machinery (subtract-before-add) and triple
   the codex build hours. No cross-module integration → no wiring ticket.

## Analyst path warnings (resolved)
`web/zzz-controller.ts` (hallucinated example — not cited), `bin/check-readiness.ts` (real; tickets
cite the full `extension/src/bin/check-readiness.ts`), `for/break` (snippet noise — not cited).

## Simplification Review (subtract-before-add)
Unchanged from the source PRD: WS-1 completes a half-wired budget (pure reuse), WS-2 widens one regex
alternation, WS-3 reuses `callerCandidateFiles` + WS-1's single deadline and adds exactly one
candidate-count cap. No new `skip_*_reason` flag, state field, or gate. Bundle leaves the detector
more bounded and less fail-open.

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | eda8ef25 | WS-1 enforce cache.deadline in detectSignatureCallerGaps | High | clean tree | readiness scan bounded, `truncated` producible | `signature-caller-gap.ts` + deadline test |
| 20 | 42aac227 | WS-2 broaden findFactoryBridgeNames export forms (parametrized) | High | WS-1 merged | default/class/re-export bridges discovered | `signature-caller-gap.ts` + bridge-forms test |
| 30 | b86a1e82 | WS-3 widen candidate corpus + thread bounded cache into scope-build path | High | WS-1 merged | production callers seen, scan bounded both paths | `signature-caller-gap.ts`, `pipeline-runner.ts` + 2 tests |
| 40 | 4f655b57 | Closer: gate, bump, install.sh, release | High | all impl Done | shipped + deployed + released | `package.json`, `MASTER_PLAN.md`, PRD move |
