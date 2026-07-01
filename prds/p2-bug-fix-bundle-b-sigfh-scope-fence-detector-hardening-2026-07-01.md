---
r_code: R-SIGFH
priority: P2
status: Todo
source_bug_report: prds/archive/bundles/p1-bug-fix-bundle-b-sigf-scope-auto-extension-2026-06-28.md
bundle_thesis: >
  Harden the shipped R-SIGF signature/schema-shape caller-gap detector
  (extension/src/services/signature-caller-gap.ts). One coherent wound: the
  detector's wall-budget is NOT actually enforced inside the shared module, and
  its coverage is under-inclusive in two fail-OPEN ways (bridge-export forms and
  candidate corpus). WS-1 makes the wall-budget real; WS-2 + WS-3 then safely
  widen coverage behind that now-enforced budget.
---

# B-SIGFH — R-SIGF scope-fence detector hardening (deferred B-SIGF fast-follow)

## Problem

R-SIGF (shipped v2.0.0-beta.29) added `detectSignatureCallerGaps` — a bounded heuristic
that detects out-of-scope callers of a symbol whose signature/schema-shape a ticket changes,
so the scope fence blocks (or, opt-in, auto-extends to) those callers. The four in-pickle
hardening passes flagged during the B-SIGF build did NOT complete (large-tier worker
silent-death, since subtracted by B-WSPU beta.35). This bundle is the fast-follow, re-grounded
in the actual shipped detector code rather than the lost in-pickle findings.

Three concrete gaps survive review of `signature-caller-gap.ts`:

1. **The wall-budget is not enforced inside the shared detector.** `ResolverCache` carries
   `deadline` (`Date.now() + maxWallMs`) and a `truncated` flag, and `check-readiness.ts`
   self-reports a `kind:'performance'` finding + suppresses blocking when `cache.truncated`
   is set (check-readiness.ts:1073, :1265). But `detectSignatureCallerGaps`
   (signature-caller-gap.ts:171-208) never reads `cache.deadline` and never sets
   `cache.truncated`. On a large target repo the arity + schema-shape scans read every
   candidate file with no wall-clock stop — AC-SIGF-5's "finite wall budget" is enforced
   only by corpus *size*, never by *time*. The `truncated` self-report the readiness gate
   depends on therefore never fires from the detector.

2. **Bridge-export forms are under-matched → fail-OPEN on the fence.** `findFactoryBridgeNames`
   (signature-caller-gap.ts:106-123) resolves a factory that references a changed
   `<Name>Schema` by grepping in-fence declared files for `export (async)? function|const|let|var <name>`.
   It MISSES `export default function makeX`, `export class XFactory`, and re-export
   `export { makeX }` forms. A factory declared in one of those forms bridges the schema-shape
   change but is not discovered, so its out-of-fence callers are never flagged — the fence
   silently fails open on exactly the factory-mediated case R-SIGF WS-2 was built to close.

3. **The candidate corpus excludes production callers → fail-OPEN on the fence.**
   `callerCandidateFiles` (signature-caller-gap.ts:139-143) bounds the scan to `.spec.ts`
   plus `factory|factories|builder*.ts`. An out-of-fence *production* positional caller
   (e.g. `new FooService(` in `foo-controller.ts`) is invisible to the detector — the arity
   gap it exists to catch is missed whenever the caller is ordinary source rather than a spec
   or a factory. Widening the corpus is safe ONLY once WS-1 makes the wall-budget real, so
   this workstream depends on WS-1.

## Current state (what already shipped — DO NOT rebuild)

- The `SCOPE_AUTO_EXTEND_MAX = 8` cap IS enforced fail-closed: `applyBoundedScopeExtension`
  extends nothing when `merged.length > SCOPE_AUTO_EXTEND_MAX` (pipeline-runner.ts:1647), and
  `shouldSuppressBlocking` returns `false` (→ blocking finding FIRES) when
  `callerCount > SCOPE_AUTO_EXTEND_MAX` (check-readiness.ts:1143). **This is correct — do NOT touch it.**
- `SCHEMA_SHAPE_CUE_RE` / `ARITY_ADD_CUE_RE` cue detection, `isOptionalCompatibleChange`
  optional-field skip, and the single shared-module home of the detector (imported by both
  `check-readiness.ts` and `pipeline-runner.ts`, no divergent copies) are shipped and correct.
- `scope.auto_extend_signature_callers` default-OFF gating is shipped and correct.

## Simplification Review (subtract-before-add)

- **WS-1 (enforce the deadline in the detector).** *Necessary?* Yes — the budget fields exist
  and a downstream consumer already depends on `truncated`, but the producer never sets it;
  this is completing a half-wired contract, not adding machinery. *Reuse not add?* Pure reuse —
  reads the existing `cache.deadline`, sets the existing `cache.truncated`; no new field, flag,
  or state. *Guards brittle complexity?* No — it makes an existing (unenforced) budget real.
  *Subtracts?* Removes an unbounded-scan latent hang; net behavior is *more* bounded.
- **WS-2 (broaden bridge-export forms).** *Necessary?* Yes — a fail-open fence hole. *Reuse not
  add?* Extends the existing `exportDeclRe` alternation in place; no new function/module. *Guards
  brittle?* No. *Subtracts?* No new surface — one regex widened; record "no subtraction available,
  the fix is a regex broadening that removes a false-negative class."
- **WS-3 (widen candidate corpus, gated on WS-1).** *Necessary?* Yes — the detector is blind to
  production callers. *Reuse not add?* Reuses `callerCandidateFiles` + the WS-1-enforced deadline;
  adds one bounded candidate-count constant, no new scan machinery. *Guards brittle?* No — it does
  NOT add a second budget; it relies on WS-1's single enforced budget (subtract-before-add: one
  budget, not two). *Subtracts?* Removes the spec/factory-only blind spot. The candidate-count cap
  is the bound that keeps the widen safe, paired 1:1 with WS-1's time bound.

No workstream adds a new `skip_*_reason` flag, state field, or gate. The whole bundle is
correctness hardening of one shipped module behind its already-shipped default-OFF gate.

## Interface Contracts

**`detectSignatureCallerGaps` (WS-1)** — signature unchanged. New INTERNAL behavior: when a
`cache` is provided, each candidate-scanning loop MUST check `Date.now() > cache.deadline`
before reading the next candidate file; on exceed it MUST set `cache.truncated = true` and stop
scanning further candidates for that symbol, returning the partial gap set discovered so far.
With no `cache` (callers that pass none), behavior is unchanged (no deadline to honor).

**`findFactoryBridgeNames` (WS-2)** — signature unchanged. `exportDeclRe` MUST additionally match
`export default (async)? function <name>`, `export (abstract)? class <name>`, and
`export { <name> (as <alias>)? }` re-export forms, harvesting `<name>` (and `<alias>` when
present) as a bridge name.

**`callerCandidateFiles` (WS-3)** — signature unchanged. The corpus MUST additionally include
tracked non-spec source files (`.ts`/`.tsx`, excluding `.d.ts`), deduped with the existing
spec/factory set, capped at a new `CALLER_CANDIDATE_MAX` constant (documented, homed in the
shared module beside `SCOPE_AUTO_EXTEND_MAX`); over the cap it returns the first
`CALLER_CANDIDATE_MAX` in deterministic `git ls-files` order and relies on WS-1's deadline for
the wall bound (no second time budget).

## Workstreams & acceptance criteria

### WS-1 — Enforce the wall-clock deadline inside the shared detector
- **AC-SIGFH-1**: `detectSignatureCallerGaps` reads `input.cache.deadline` and, in BOTH the
  arity-caller loop and the schema-shape-caller loop, stops scanning further candidate files and
  sets `input.cache.truncated = true` once `Date.now() > cache.deadline`. Verify: a unit test
  constructs a `ResolverCache` with `deadline` already in the past and asserts (a) the returned
  gap array is empty-or-partial, (b) `cache.truncated === true`, and (c) no candidate file beyond
  the deadline was read (spy/counter on `readCachedFile` or a large fixture corpus).
- **AC-SIGFH-2**: with a generous (future) `deadline`, detection results are byte-identical to
  the pre-change detector on the existing R-SIGF fixtures (no behavior change on the happy path).
  Verify: the existing `check-readiness` arity + schema-shape fixtures still produce the same
  findings; `cache.truncated` stays `false`.

### WS-2 — Broaden factory-bridge export forms
- **AC-SIGFH-3**: `findFactoryBridgeNames` discovers a bridge factory declared as
  `export default function makeFacts`, `export class FactsFactory`, and
  `export { makeFacts }` / `export { makeFacts as makeF }`, in addition to the existing
  `export function|const|let|var` forms. Verify: three fixtures, one per new form, each declaring
  a factory that references a changed `<Name>Schema` with an out-of-fence caller of the factory —
  each is named in a `kind:'schema-shape'` gap; a control fixture with an unrelated
  `export default function` (no schema reference) is NOT flagged.

### WS-3 — Widen the candidate corpus to production callers (depends on WS-1)
- **AC-SIGFH-4**: `callerCandidateFiles` additionally includes tracked `.ts`/`.tsx` source files
  (excluding `.d.ts`) so an out-of-fence production positional caller (`new FooService(` in a
  non-spec, non-factory file) is detected as an `arity` gap. Verify: a fixture with the arity cue
  in-ticket and `new FooService(` in an out-of-fence `foo-controller.ts` produces an `arity` gap
  naming that file; the same caller co-scoped in the bundle is NOT flagged.
- **AC-SIGFH-5**: the widened corpus is bounded — `callerCandidateFiles` returns at most
  `CALLER_CANDIDATE_MAX` files in deterministic order, and the widened scan honors WS-1's
  deadline (no new second time budget). Verify: a test with a candidate corpus larger than
  `CALLER_CANDIDATE_MAX` asserts the returned length is capped and deterministic across two calls;
  a test with a past deadline asserts the widened scan stops early and sets `truncated`.

### Closer ticket
- **AC-SIGFH-CLOSER**: full local release gate green (tsc + eslint + all audit scripts + fast-c4
  + integration + `RUN_EXPENSIVE_TESTS=1` expensive); compiled JS matches TS; version bumped
  (PATCH — behavior-preserving detector hardening behind the shipped default-OFF gate) to the
  next beta; `bash install.sh` deployed; `git push` + `gh release create`; MASTER_PLAN R-SIGF
  hardening fast-follow row flipped to SHIPPED; this PRD swept to `prds/archive/bundles/`.

## Trap-door obligations
- WS-1 MUST NOT change results when no `cache` is passed or the deadline is in the future — the
  deadline is a ceiling, never a floor; a detector that truncates early on a generous budget is a
  regression worse than the unbounded scan.
- WS-3 MUST NOT introduce a second wall-budget — the bundle's whole point is ONE enforced budget
  (WS-1) plus ONE candidate-count cap; two time budgets is the subtract-before-add smell.
- No workstream may weaken the `SCOPE_AUTO_EXTEND_MAX` fail-closed cap or the
  `worker_edit_outside_scope` / R-APWS scope-isolation trap doors.

## Non-goals
- A full type-aware (compiler-API) caller analysis — detection stays a bounded heuristic.
- Broadening schema-symbol recognition beyond `<name>Schema` (separate FN class; out of scope).
- Any change to the default-OFF `scope.auto_extend_signature_callers` gating or the cap value.
