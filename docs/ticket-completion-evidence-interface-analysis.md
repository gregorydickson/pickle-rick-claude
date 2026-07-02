# Interface Analysis: ticket-completion-evidence.ts

**Ticket:** R-AFCC-DEEP-4B  
**Analyst:** morty-debater-architect subagent (PRD Risk #1 fallback; /death-crystal not shipped)  
**Date:** 2026-05-28  
**Module:** `extension/src/services/ticket-completion-evidence.ts`

> **STALE-FLAG NOTE (2026-07-02):** this is a dated analysis snapshot. The `allow_inferred_completion_commit` flag (and the `allowInferred` gate option) it references was DELETED from source by B-DURA T60 (beta.23); inferred-completion acceptance is not a flag surface. Its absence in `src/` is pinned by `extension/scripts/check-no-inferred-completion-flag.sh` and `extension/tests/allow-inferred-completion-commit-deleted.test.js`. Code excerpts below describe the pre-deletion source.

---

## Context

R-AFCC-DEEP-4A created `ticket-completion-evidence.ts` as a unified "is this ticket attributably done?" module to supersede the divergent invariants previously split across `hasCompletionCommit` (pickle-utils), the inlined `guardCompletionCommitBeforeDone` upsert, and the collapsed phantom-done batch loop.

The module exports 5 entry points:

| Entry Point | Signature | External Callers |
|---|---|---|
| `readEvidence` | `(ctx) → EvidenceResult` | 5 (pickle-utils shim, auto-fill, mux-runner×3) |
| `persistEvidence` | `(ctx, sha, opts) → PersistResult` | 1 (mux-runner inline guard) |
| `gateForDoneFlip` | `(ctx, policy?) → GateDecision` | **0 — dead export** |
| `gateForPhantomDoneRevert` | `(ctx, policy?) → RevertDecision` | 2 (mux-runner) |
| `recordPostGateOutcome` | `(statePath, decision) → void` | **0 — dead export** |

### Why Two Exports Are Dead

R-AFCC-DEEP-4A migrated *some* callsites but left `guardCompletionCommitBeforeDone` inline in
`mux-runner.ts` (lines ~3007–3071). That function reimplements the same read-backoff-persist-
re-probe sequence as `gateForDoneFlip` by calling `readEvidence` + `persistEvidence` directly.

There is also a type-seam: `guardCompletionCommitBeforeDone` returns
`{ ok: false; source: CompletionCommitEvidence['source'] }` (legacy type from pickle-utils),
while `gateForDoneFlip` returns `{ ok: false; reason: string; kind: EvidenceKind }`. Multiple
mux-runner callers inspect `.source`, so migration requires a shim.

A trap door in `extension/CLAUDE.md` locks the inline function by name:
> "INVARIANT: `guardCompletionCommitBeforeDone` MUST, when post-backoff evidence is
> `{ source: 'inferred', sha: <SHA> }`, invoke `autoFillCompletionCommit`..."

The enforce clause points at `guard-completion-commit-auto-promote.test.js` with a
`PATTERN_SHAPE` that greps inside `guardCompletionCommitBeforeDone` by name.

---

## Alternatives Analyzed

### Alternative 1 — Complete the Migration (Route Through gateForDoneFlip)

Keep all 5 EPs. Replace `guardCompletionCommitBeforeDone`'s body with a thin call to
`gateForDoneFlip`, mapping `kind → source` for existing callers:

```typescript
// mux-runner.ts thin shim after migration
export function guardCompletionCommitBeforeDone(args): ... {
  const decision = gateForDoneFlip(
    { sessionDir: args.sessionDir, ticketId: args.ticketId, workingDir: args.workingDir },
    { allowInferred: (args.flags ?? {})['allow_inferred_completion_commit'] === true,
      rereadBackoffMs: args.rereadBackoffMs }
  );
  if (decision.ok) return decision;
  return { ok: false, reason: decision.reason, source: kindToLegacySource(decision.kind) };
}
```

**Pros:**  
- Eliminates duplicated backoff-persist-reprobe logic  
- `gateForDoneFlip` becomes live; one canonical gate implementation  
- `recordPostGateOutcome` can be wired to `clearStaleDoneWithoutCommitEvidence`  

**Cons:**  
- Trap door in `extension/CLAUDE.md` (R-WUWC SOFT-variant) must be updated: the PATTERN_SHAPE
  references `guardCompletionCommitBeforeDone` by name  
- `guard-completion-commit-auto-promote.test.js` PATTERN_SHAPE assertion must be updated  
- The R-PEDC trap door's `clearStaleDoneWithoutCommitEvidence` count invariant must be verified
  after `recordPostGateOutcome` integration  
- Type-seam shim adds surface to test  

**Complexity:** Medium-high. Code change is small; trap door + test updates are load-bearing.

---

### Alternative 2 — Prune Dead Exports (Contract Reduction)

Remove `gateForDoneFlip` and `recordPostGateOutcome`. Narrow to 3 EPs:

```typescript
export function readEvidence(ctx: EvidenceCtx): EvidenceResult
export function persistEvidence(ctx: EvidenceCtx, sha: string, opts: PersistOpts): PersistResult
export function gateForPhantomDoneRevert(ctx: EvidenceCtx, policy?: RevertPolicy): RevertDecision
```

Remove associated dead internals: `DoneFlipPolicy`, `GateDecision`, `sleepSyncMs`,
`defaultRereadBackoffMs`. Update `services/CLAUDE.md` Module Export Catalog.

**Pros:**  
- Honest interface — only exports what is actually called  
- No zombie exports that rot silently or invite misuse  
- Zero trap door churn  
- Low risk: characterization tests do not exercise `gateForDoneFlip` or `recordPostGateOutcome`  

**Cons:**  
- Accepts the backoff-persist-reprobe duplication as permanent  
- Future changes to gate logic require two edits  

**Complexity:** Low. Delete exports + types + private helpers, update catalog. No trap door changes.

---

### Alternative 3 — Explicit Primitives Layer (Identical to Alternative 2, Different Framing)

Same mechanics as Alternative 2, but framed as intentional design: the module is a *primitives
layer* (data access), not a *policy layer* (gate decisions). Policy lives in the caller that owns
the context (mux-runner owns PICKLE_GUARD_REREAD_BACKOFF_MS, `allow_inferred_completion_commit`
flag, and `CompletionCommitEvidence['source']` legacy type mapping).

This framing makes the current duplication a feature: `guardCompletionCommitBeforeDone` owns its
policy, the module owns data access, and they are not entangled.

**Complexity:** Identical to Alternative 2.

---

## Synthesis Decision

**Chosen: Alternative 2 / 3 — Prune dead exports.**

### Reasoning

Alternative 1 is architecturally elegant but has non-trivial trap door friction. The R-WUWC
SOFT-variant trap door in `extension/CLAUDE.md` has a PATTERN_SHAPE that greps for
`autoFillCompletionCommit\(` inside `guardCompletionCommitBeforeDone` by function name.
Migrating the body to a `gateForDoneFlip` call breaks that PATTERN_SHAPE. The trap door update
plus `guard-completion-commit-auto-promote.test.js` PATTERN_SHAPE update must land atomically
with the code change or there is a test gap — that is non-trivial cost for a correctness-neutral
refactor.

The type-seam problem (`.source` vs `.kind`) adds a shim that must itself be tested.

By contrast, the duplication is currently *static*: both implementations delegate to the same
`readEvidence` and `persistEvidence` primitives. They are behaviorally identical. The risk
of drift exists but is low while the gate logic is frozen.

**Future trigger for Alternative 1:** When the backoff logic (PICKLE_GUARD_REREAD_BACKOFF_MS
handling) or the `inferred-fresh` promotion semantics evolve, the two implementations will
diverge. At that point, completing the migration becomes mandatory, trap door churn included.

### Applied Changes

1. Deleted from `ticket-completion-evidence.ts`:
   - `gateForDoneFlip` (export)
   - `recordPostGateOutcome` (export)
   - `DoneFlipPolicy` (interface)
   - `GateDecision` (type)
   - `sleepSyncMs` (private helper, only used by gateForDoneFlip)
   - `defaultRereadBackoffMs` (private helper, only used by gateForDoneFlip)

2. Updated `extension/src/services/CLAUDE.md` Module Export Catalog entry for
   `ticket-completion-evidence.ts` to reflect the 3-EP interface.

3. No changes to: mux-runner.ts, characterization tests, CLAUDE.md trap doors.

### Post-Refactor Interface

```typescript
// Public types
export type EvidenceKind = 'explicit' | 'inferred-fresh' | 'inferred-stale' | 'absent';
export interface EvidenceResult { kind: EvidenceKind; sha?: string; usedFallback?: boolean; }
export interface EvidenceCtx { ... }
export interface PersistOpts { stage: 'best-effort' | 'required'; }
export interface PersistResult { action: 'written' | 'already_present' | 'no_file' | 'unwritable'; ... }
export interface RevertPolicy { flags?: Record<string, unknown> | null; }
export type RevertDecision = { action: 'keep' | 'revert' | 'persist-inferred'; kind: EvidenceKind; sha?: string; fallbackFired?: boolean; };

// Entry points (3)
export function readEvidence(ctx: EvidenceCtx): EvidenceResult
export function persistEvidence(ctx: EvidenceCtx, sha: string, opts: PersistOpts): PersistResult
export function gateForPhantomDoneRevert(ctx: EvidenceCtx, policy?: RevertPolicy): RevertDecision
```
