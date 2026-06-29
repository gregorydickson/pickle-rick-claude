---
title: "B-SIGF — scope-fence signature/schema-shape caller gap: detect-and-block + bounded auto-extension (R-SIGF)"
priority: P1
finding: R-SIGF
status: ready
type: bug-fix-bundle
schema_neutral: true
self_modifying_recovery: false
backend: claude
source_bug_report: prds/archive/bug-reports/BUG-REPORT-2026-06-24-codex-fieldproof-loa1363-run4-rsigf-corroboration-and-detached-phasegate.md
---

# B-SIGF — scope-fence signature/schema-shape caller gap (R-SIGF)

## Problem

A ticket correctly changes the **signature of an exported/injected symbol** — adds a constructor
injection, adds a parameter — or changes the **shape of an exported schema/type** (e.g. a zod
`thresholdSchema`). A **sibling file outside the bundle's scope fence** (`allowed_paths` /
MODIFIED_FILES) still constructs/consumes it with the OLD arity/shape (a positional `new Service(...)`
in a `*.spec.ts`, a `makeFacts({...})` against the old schema). `tsc` goes RED at those out-of-fence
sites. **No fenced worker may touch the out-of-scope file** (`check-scope-diff` blocks the commit), so
the tree stays RED indefinitely; the affected tickets fail their typecheck gates forever, presenting
misleadingly as `no_progress_timeout` / `oversized_no_progress`. On codex this cascaded to detached
overrun → `0/N phases` with citadel/anatomy/szechuan silently skipped (LOA-1488 run 3, LOA-1363 run 4).

This is the **codex GA blocker** named in MASTER_PLAN. Two independent repros:
1. **Signature fan-out (LOA-1488):** ticket added a 14th `LangGraphService` ctor injection; sibling
   `buildAppraisalEvaluationGraph.spec.ts` instantiated it positionally (13 mocks) → tsc RED at 6 sites,
   out of fence.
2. **Schema-shape fan-out (LOA-1363 run 4, load-bearing):** a changed zod `thresholdSchema` *shape*
   (CRED_017/018/019) broke out-of-fence sibling specs (`e2e` / `summary-computer` / `credit-rule-fns` /
   `evaluator`); the data-flow audit ticket DEFERRED them verbatim → RED tree → timeout storm.

### Current state (what already shipped — DO NOT rebuild)
The **advisory** half shipped (`a668687f`): `findSignatureChangeCallerGapFindings` in
`extension/src/bin/check-readiness.ts` (with `extractAritySymbols`, `callerCandidateFiles`,
`isCallerInBundleScope`, `ARITY_ADD_CUE_RE`) emits a non-blocking `kind:'advisory'` readiness finding
that NAMES the out-of-scope positional `new <Symbol>(` callers. It is grep+markdown heuristic, signature
(arity) only, and **non-blocking — readiness still passes**, so a bundle with the gap launches anyway and
dies RED mid-build. The detector exists; what's missing is (a) the gap is not **prevented** and (b) it is
**blind to schema-shape consumers**.

## Simplification Review (subtract-before-add)

Per workstream:

- **WS-1 (promote advisory → blocking gate).** *Necessary?* Yes — the advisory is observed dead-in-practice
  (nobody reads a non-blocking line; the bundle launches and dies RED). *Reuse vs add?* Pure REUSE — the
  `findSignatureChangeCallerGapFindings` detector already exists; WS-1 changes its `kind` to blocking and
  routes it into `blockingFindings`. NO new analyzer. *Guards brittle complexity?* This ADDS a blocking
  gate, so it ships with the two mandatory W5b artifacts: the **unified** `skip_quality_gates_reason`
  escape hatch (NOT a new per-gate flag) and a stated recurrence budget in `SKIP_FLAG_BUDGETS`. *Subtract?*
  The advisory `kind` is removed (folded into the blocking finding) — net flag count unchanged.
- **WS-2 (extend detector to schema-shape consumers).** *Necessary?* Yes — the load-bearing 2nd repro is a
  schema shape, not an arity change; arity-only detection misses it. *Reuse vs add?* Extends the EXISTING
  detector with a schema-shape cue + consumer scan; no parallel mechanism. *Subtract?* none available
  (additive cue); recorded.
- **WS-3 (bounded scope auto-extension — the capability half).** *Necessary?* This is the higher-risk half:
  instead of only blocking at authoring, auto-add the detected out-of-fence callers to `allowed_paths` so a
  fenced worker CAN fix them. *Guards brittle complexity?* Scope isolation is load-bearing (R-APWS /
  `check-scope-diff` trap doors). Auto-widening the fence is the **smell** the governance warns about, so
  WS-3 is **bounded and gated**: it extends ONLY to caller files the WS-1/2 detector positively named (never
  arbitrary source), caps the count, emits a `scope_auto_extended` activity event per added path, and is
  **default-OFF behind a setting** (`scope.auto_extend_signature_callers`, default `false`) so the safe
  WS-1 block ships first and the capability is opt-in until soak validates it. *Subtract?* The auto-extension
  makes the WS-1 block a fallback (block only when auto-extension is off or over-cap), not a second hatch.

Net: WS-1+WS-2 are reuse-first and close the GA blocker safely (no bundle launches into an unfixable RED
tree). WS-3 is the capability, shipped behind a default-off flag so it does not risk scope isolation until
proven.

## Workstreams & acceptance criteria

### WS-1 — Promote the signature-caller-gap finding to blocking (reuse the shipped detector)
- **AC-SIGF-1**: `findSignatureChangeCallerGapFindings` emits `kind:'blocking'` (or an equivalent severity
  consumed by `blockingFindings`) when an out-of-scope positional caller is detected; `runReadiness` exit
  code is non-zero for such a bundle. Verify: a fixture bundle declaring an arity change to `FooService`
  with an out-of-scope `new FooService(` caller fails readiness (exit != 0); a bundle that co-scopes the
  caller passes (exit 0).
- **AC-SIGF-2**: the gate honors the **unified** `state.flags.skip_quality_gates_reason` (non-empty trimmed
  string) bypass — NOT a new per-gate flag — emitting a `readiness_skipped`-class audit event. Verify: with
  the unified flag set, the same fixture passes (exit 0) and the bypass event is recorded.
- **AC-SIGF-3**: a `SKIP_FLAG_BUDGETS` entry exists for this gate (W5b recurrence budget). Verify: the
  budget key is present in `extension/src/services/metrics-utils.ts` and surfaced by the metrics dashboard.

### WS-2 — Extend detection to schema-shape consumers
- **AC-SIGF-4**: the detector recognizes a **schema/type-shape change** cue (exported zod schema / exported
  type/interface field add-or-rename) and scans out-of-scope tracked files for consumers of that symbol
  (e.g. `<Schema>.parse(`, a typed object literal against the changed type), naming them like the arity
  callers. Verify: a fixture declaring a shape change to `thresholdSchema` with an out-of-scope consumer
  spec is detected (named in the finding) and blocks per AC-SIGF-1.
- **AC-SIGF-5**: detection stays a bounded heuristic with a finite wall budget (reuse the existing resolver
  cache / wall-budget pattern); no unbounded grep walk. Verify: the schema-consumer scan reuses
  `callerCandidateFiles`/`ResolverCache` and a test asserts it returns within budget on a large fixture.

### WS-3 — Bounded, opt-in scope auto-extension (default-OFF)
- **AC-SIGF-6**: a new resolved setting `scope.auto_extend_signature_callers` (default **false**) gates the
  behavior; when `true`, `resolveScope`/`refreshScope` add the WS-1/WS-2-detected out-of-fence caller files
  to `allowed_paths` (deduped, sorted), capped at a documented maximum, emitting a `scope_auto_extended`
  activity event naming each added path. Verify: with the flag on, a fixture's named callers appear in
  `scope.json.allowed_paths` and the event fires; with the flag off (default), `allowed_paths` is unchanged
  and WS-1 blocks instead.
- **AC-SIGF-7**: the caller-gap detection is factored into a single shared module (`forward-created`)
  imported by BOTH `check-readiness.ts` and the scope-resolution path, so the advisory/blocking finding and
  the auto-extension use ONE detector (no divergent copies). Verify: a parity test asserts both consumers
  import the shared predicate and contain no inline duplicate of `ARITY_ADD_CUE_RE`.

### Closer ticket
- **AC-SIGF-CLOSER**: full local release gate green (tsc + eslint + all audit scripts + fast-c4 +
  integration + expensive); compiled JS matches TS; version bumped (MINOR — new setting + new blocking
  gate behavior, forward-compatible) to the next beta; `bash install.sh` deployed; `git push` +
  `gh release create`; MASTER_PLAN R-SIGF row flipped to SHIPPED; this PRD swept to `prds/archive/bundles/`.

## Trap-door obligations
- WS-3 must NOT weaken the `check-scope-diff` / R-APWS scope-isolation trap doors: the fence only extends to
  detector-named caller files, never arbitrary staged paths; the existing `worker_edit_outside_scope` event
  still fires for any non-named out-of-scope edit.
- WS-1 ships with the W5b mandatory pair (unified skip hatch + recurrence budget) — no new per-gate flag.

## Non-goals
- A full type-aware (compiler-API) caller analysis — detection stays a bounded heuristic.
- Target-realism / completion-oracle changes (out of scope; separate findings).
