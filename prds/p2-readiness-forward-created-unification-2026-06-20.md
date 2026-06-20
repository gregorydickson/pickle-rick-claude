---
title: "B-RFCU — Readiness forward-created unification: collapse the validation-overreach seam"
priority: P2
status: Draft (plan — not yet refined/launched)
schema_neutral: true
date: 2026-06-20
family: readiness-overblock / D1 validation-overreach
composes:
  - prds/BUG-REPORT-2026-06-20-readiness-contract-resolver-forward-created-schema-fields.md
---

# B-RFCU — Readiness Forward-Created Unification

**One-line thesis:** the readiness gate keeps hard-halting on references the bundle *itself
creates*; every recurrence has been "fixed" by adding another annotation grammar or widening the
coarse skip. Stop adding hatches — **derive forward-created status from the bundle's own ground
truth, apply it uniformly to every reference kind, and demote it to advisory.** Net change is a
*subtraction*: fewer author-discipline requirements, one detector instead of three grammars, and
the coarse all-or-nothing skip stops being load-bearing.

---

## 1. The recurring failure class (why this keeps happening)

This is the **D1 validation-overreach** family the design-simplification meta-PRD already named
(`archive/bundles/p1-design-simplification-and-autonomy-2026-06-13.md`: "11+ gate false-positive
bugs; 8/11 'fixed' by adding an escape hatch, not removing a check"). The readiness contract/path
resolver validates every backticked reference against `HEAD`. For an **additive** bundle (new
files, new schema fields, new symbols) those references *do not exist at HEAD yet* — by design —
so the gate reports them as unresolved and hard-halts the whole pipeline at iteration 0.

Each recurrence so far added a narrow special-case instead of removing the blind spot:

| Finding | What false-halted | "Fix" that shipped |
|---|---|---|
| R-RPRA | forward-created **files** (leading-slash) | leading-slash strip |
| R-QGSK / R-FRA-6 | forward-created files/symbols | `(forward-created)` / `(created by ticket <hash>)` **annotation grammar** |
| R-RGO RC-2 | repo-prefixed paths (`repo/CLAUDE.md`) | strip one leading segment |
| R-RTRC-4 | deep-monorepo bare paths | `git ls-files` suffix-match |
| **R-RCFF** (this) | forward-created **dotted field-paths** in Interface-Contracts Outputs | *(none — capture-only; coarse skip used)* |
| **R-RCFF #2** | **un-annotated** forward-created `*.spec.ts` | *(none — annotation-omission gap)* |

**Two structural defects drive the whole family:**

- **D-A — Author-discipline dependence.** The forward-ref signal lives in *annotations* the
  synthesizer must remember to write. R-RCFF #2 is the proof this fails: an un-annotated but
  obviously bundle-created spec file still halted. Every new reference *shape* (now: dotted
  field-paths) needs a new grammar branch — N+1 forever.
- **D-B — All-or-nothing response.** The only escape is `state.flags.skip_quality_gates_reason`,
  which disables **readiness AND ticket-audit wholesale**. In R-RCFF #2 it would have masked 2
  *real* doc-path typos mixed in with the 6 false positives. The hatch is coarser than the
  problem.

## 2. Ground truth already exists; we're just not using it

Verified in `extension/src/bin/check-readiness.ts` at HEAD (2026-06-20):

- `buildBundleCreationIndex(ticketContents)` (**:384**) already aggregates the bundle's
  `extractDeclaredCreatePaths` + `extractForwardRefAnnotations().valid`.
- It is passed to **path** findings (`findPathFindings`, **:1295**) — but **NOT** to the
  **contract/symbol** resolver loop (**:653–673**, `extractContractReferences` →
  `resolveSymbolRef`). → that omission *is* the R-RCFF field-path false-halt.
- A graduated-response mechanism already exists: `runReadiness` keys the exit code on
  `blockingFindings`, not the raw `findings` array (R-RHFP already demotes `kind:'performance'`
  out of `blockingFindings`). → the advisory tier is reusable, not new.

The bundle *declares* what it creates (schema files in "Files to create/modify", new field-paths
in each ticket's own Interface-Contracts Outputs). That declaration is **higher-authority** for
"is this forward-created?" than re-resolving against HEAD. We already compute it; we just don't
apply it to contracts, and we let annotation omission defeat it.

---

## 3. Workstreams

### WS1 — Unify forward-created detection on bundle ground truth (the core subtraction)

Make `buildBundleCreationIndex` the single forward-created authority, applied **uniformly** to
path, file, symbol, AND dotted-field-path findings, and **derive it from the bundle's own content
rather than from annotations**:

1. **Wire the existing creation index into the contract/symbol loop** (:653–673). A contract ref
   that matches the creation index is forward-created → not a blocking finding. (Closes R-RCFF
   field-path core.)
2. **Populate field-paths into the index.** A ticket whose own Interface-Contracts **Outputs**
   declares a dotted path (`improvements.has_dampness_evidence`) that does not resolve at HEAD,
   AND whose "Files to modify" includes the schema file, is creating that field — add it to the
   index. Prefer auto-detection from the bundle's schema-file diff over a new annotation grammar.
3. **Make file/path detection robust to annotation omission** (closes R-RCFF #2): a path that
   appears in *any* ticket's "Files to create" set is forward-created even if the *referencing*
   ticket forgot the `(forward-created)` annotation. Annotation becomes an optional hint, not a
   requirement.

**This SUBTRACTS:** the contract resolver stops needing a parallel forward-ref grammar; the
annotation grammar (R-FRA-6) becomes a fallback hint rather than load-bearing author discipline.
No new reference-shape grammar is added — one detector keyed on data the bundle already declares.

### WS2 — Graduated, finding-scoped response (retire the coarse skip for this class)

So the all-or-nothing skip stops being the only escape and real findings stay visible:

1. **Demote auto-detected forward-created refs to advisory.** They appear in the JSON
   `findings`/report as a coverage signal but are excluded from `blockingFindings` (reuse the
   existing R-RHFP split — do **not** build a new tier).
2. **Block only genuinely-unresolvable refs** — not in the creation index AND not at HEAD. In
   R-RCFF #2 this keeps the 2 real doc-path typos blocking while the 6 forward-created refs pass.
3. **Verify-first against R-RGO:** confirm whether the AC-RGO-3 "graduated halt" work already
   shipped a contract-class advisory path before adding one (B-DSAN2 WS-B). If it did, WS2 is a
   thin delta; if not, it's the `blockingFindings` exclusion above. Either way: **no new skip
   flag.** The coarse `skip_quality_gates_reason` remains the single break-glass, now rarely
   needed for this class.

### WS3 — Parity + regression net

1. **Resolver parity:** `audit-ticket-bundle.ts` has its own `buildBundleCreationIndex` (:374) —
   ensure both resolvers honor the same uniform detection so a ref that passes readiness can't die
   at ticket-audit (R-FRA-6 parity class).
2. **Greenfield-corpus regression fixtures** from the two real incidents: an additive-field PRD
   (4124c822 shape: net-new dotted Outputs) and an additive-contract PRD with an un-annotated
   forward-created spec file (9ab25dfa shape). Both must pass readiness with **zero** blocking
   findings and **without** any skip flag, while a genuinely-bogus ref in the same bundle still
   blocks.

---

## 4. Acceptance criteria (machine-checkable)

- **AC-1 (field-path core):** a ticket whose Interface-Contracts Output dotted path is created by
  the same bundle (declared in its schema-file "Files to modify", absent at HEAD) produces **no
  blocking** `contract` finding. Fixture: 4124c822 shape → 0 blocking findings, no skip flag.
- **AC-2 (annotation-omission):** an un-annotated forward-created file that appears in any ticket's
  "Files to create" set produces **no blocking** `file_path` finding. Fixture: 9ab25dfa
  `mashvisorFetch/node.spec.ts` → 0 blocking findings.
- **AC-3 (real findings still gate):** in a bundle mixing forward-created refs with a genuinely
  unresolvable ref (typo / wrong path like `packages/api/CLAUDE.md`), readiness **blocks on the
  real ref only** and reports the forward-created ones as advisory. (No coarse skip needed to see
  the real finding.)
- **AC-4 (parity):** any ref that passes the readiness gate as forward-created also passes
  `audit-ticket-bundle` (no `path-drift` / `hallucinated-premise` death on the same ref).
- **AC-5 (subtraction recorded):** the change removes/relaxes the annotation requirement for
  bundle-internal refs (annotation demoted to optional hint) and adds **no** new `skip_*_reason`
  flag and **no** new reference-shape grammar branch. `git diff` net for grammar/skip surfaces is
  ≤ 0.

## 5. ## Simplification Review (subtract-before-add — required)

1. **Is the addition necessary at all?** WS1 adds **no** new mechanism — it wires the *existing*
   `buildBundleCreationIndex` into a loop that doesn't yet consume it, and broadens what feeds it.
   WS2 reuses the *existing* `blockingFindings` split. The only genuinely new code is field-path
   detection from the schema diff — and that **replaces** the alternative of a third annotation
   grammar.
2. **Can it REUSE instead of ADD?** Yes — the creation index, the `extractForwardRefAnnotations`
   grammar, the R-RHFP `blockingFindings` split, and the R-RTRC-4 suffix matcher all already
   exist. Reuse all four; add no parallel mechanism.
3. **Does it guard EXISTING brittle complexity that should be SUBTRACTED?** Yes — the brittle thing
   is the **annotation-discipline dependence** and the **coarse skip**. The honest fix is to make
   them non-load-bearing (annotation → optional hint; coarse skip → rarely needed), not to add a
   field-path annotation grammar beside the file/symbol ones. We delete the dependence, not gate
   it.
4. **What does this SUBTRACT?** (a) the need for authors/synthesizers to annotate bundle-internal
   forward refs; (b) the need to reach for the all-or-nothing `skip_quality_gates_reason` on every
   additive PRD; (c) the N+1 trajectory of "new reference shape → new grammar branch." It leaves
   the readiness gate *flatter*: one ground-truth detector, one advisory tier.

## 6. Scope / risk

- `schema_neutral: true` — no state-schema change. Touch points: `check-readiness.ts`
  (contract loop + index population + blocking split), `audit-ticket-bundle.ts` (parity),
  greenfield-corpus fixtures. No runtime/state migration.
- **Risk:** over-suppression (a genuinely-bogus ref that happens to match a declared create-path).
  Mitigated by AC-3 (real ref in the same bundle still blocks) and by keeping forward-created refs
  *visible* as advisory findings rather than dropped entirely.

## 7. Relationship to the GA path / drain timing

The 2026-06-20 GA note says *don't pre-build the seam-collapse; let the field-soak rank the
seams.* R-RCFF **already ranked this one to the top** — two independent additive PRDs false-halted
on first launch the **same day**, atop a documented 6-bug family. This PRD is the *plan* for that
top-ranked seam; it is evidence-first, not speculative. **Operator decides drain timing** — fold
it into the next-week soak as the first collapse candidate, or drain standalone. It is a clean
P2 because a sanctioned workaround exists (`skip_quality_gates_reason`), so it is not release-
blocking — but it is the single highest-yield autonomy-friction subtraction currently identified.
