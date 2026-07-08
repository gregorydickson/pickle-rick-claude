# B-CSHYG-a — DEFER evidence: the `salvageCleanTree` clean-tree back-fill branch is a live forward-seam, not dead code

| Field | Value |
|:---|:---|
| **Classification** | **DEFER** (verify-first, not delete-on-faith) |
| **Bundle** | B-RASO (`prds/p2-bug-fix-bundle-b-raso-recovery-attributable-work-single-oracle-2026-07-07.md`), WS-2 / ticket `fc4c29c9` |
| **Subject** | `extension/src/lib/salvage-ticket.ts` → `salvageCleanTree` / `deps.backfillDone` / `SalvageTicketInput.completionCommitSha` |
| **Source analysis** | `prds/RECOVERY-SPRAWL-COLLAPSE-ANALYSIS-2026-07-07.md` (flagged the branch as *possibly*-dead) |
| **Decision** | Ship **no** `salvage-ticket.ts` change. The branch stays. |
| **Date** | 2026-07-07 |

## Why this is DEFER, not DELETE

The recovery-sprawl analysis flagged `salvageCleanTree`'s `backfillDone` dep
(`extension/src/lib/salvage-ticket.ts:141`) as a possibly-dead clean-tree back-fill branch. The
grep evidence below confirms **zero production callers wire `deps.backfillDone`** — so the branch
does not fire in production today. But it is **not** dead code to delete: it is an intentional
forward-seam actively pinned by a trap door and tests. Deleting it would be **B-GSUB
over-subtraction** of a documented seam whose only current adapter lives in a test — exactly the
"one-adapter-rule: one adapter means a hypothetical seam" case, and the seam is deliberately kept
for the B-PCOMP clean-tree completion back-fill contract (`#0a1ce691`).

Production attribution of a clean-tree, HEAD-moved ticket routes through
`attributeBoundaryHeadMoved` (`extension/src/bin/mux-runner.ts:5242`, invoked `:5337`) →
`evaluateCompletionEvidence` (the B-1SEAM predicate) — **NOT** through `salvageCleanTree`. The
`salvageCleanTree` branch is the alternate seam reserved for a future wiring; until a production
caller wires a real `backfillDone`, it stays inert-but-pinned.

## AC-7 — the `salvageTicket(`-caller grep, with per-caller wiring

Command: `grep -rn "salvageTicket(" extension/src/ | grep -v test`

The three **production** call sites (excluding comment/doc/definition lines), each with its
`backfillDone` and `completionCommitSha` wiring:

| # | Caller | Location | wires `deps.backfillDone`? | passes `input.completionCommitSha`? | Clean-tree branch reachable? |
|:--|:---|:---|:---|:---|:---|
| 1 | `routeExitPathSalvage` | `extension/src/bin/mux-runner.ts:5405` | **No** — deps = `{commitScoped, archive, resetTodo, ffReattach}` | **No** — input = `{sessionDir, workingDir, ticketId, log}` | No (`!!deps.backfillDone` is false) |
| 2 | `executeBoundedEscape` | `extension/src/bin/mux-runner.ts:6076` | **No** — deps = `{archive, resetTodo, ffReattach}` | **No** — input = `{sessionDir, workingDir, ticketId, log}` | No (`!!deps.backfillDone` is false) |
| 3 | `salvage` adapter (`pickle-recover`) | `extension/src/bin/pickle-recover.ts:88` → runRecover call sites | see sub-rows | see sub-rows | No |

`pickle-recover`'s `:88` adapter — `salvage: (input, deps) => salvageTicket(input, deps)` — is a
pass-through. Its two runRecover call sites:

- **`resetTicketViaSalvage` (`pickle-recover.ts:178`)** — `salvageDeps = {reconcile, gate: () => 'failing'}`;
  input `{sessionDir, workingDir, ticketId}`. No `backfillDone`, no `completionCommitSha`, and
  `gate → 'failing'` routes `salvageTicket` into its archive-then-resetTodo branch, never the
  clean-tree branch. Dead for this purpose by construction.
- **`salvage` case (`pickle-recover.ts:323`)** — `deps.salvage({sessionDir, workingDir, ticketId, startCommit, completionCommitSha: null})`
  with **no** explicit `deps` arg, so `salvageTicket` falls back to `defaultDeps`. `defaultDeps`
  DOES define `backfillDone` — but as a **no-op returning `{done: false}`**
  (`salvage-ticket.ts:124`) — and `completionCommitSha` is explicitly `null`, so the guard's
  `!!attributedSha` short-circuits to false. Even if the guard were reached, the no-op returns
  `done: false` → the branch yields `{disposition: 'no-op', reason: 'clean_tree'}`. No back-fill.

**Conclusion:** no production path produces the `committed-done` / `backfilled_clean_tree`
disposition. The sole caller that wires a real `backfillDone` (and thereby exercises the branch)
is the pin `extension/tests/salvage-backfilled-done.test.js`.

## Zero-production-wiring confirmation

Command: `grep -rn backfillDone extension/src/ | grep -v test`

```
extension/src/lib/salvage-ticket.ts:94:  backfillDone?: (input: SalvageTicketInput, sha: string) => { done: boolean; sha?: string | null };
extension/src/lib/salvage-ticket.ts:124:  backfillDone: () => ({ done: false }),
extension/src/lib/salvage-ticket.ts:150:    && !!deps.backfillDone
extension/src/lib/salvage-ticket.ts:153:    const r = deps.backfillDone!(input, attributedSha!);
```

All four hits are `salvage-ticket.ts` internals — the optional dep **type** (`:94`), the no-op
**default** (`:124`), and the branch **guard** (`:150` / `:153`). No production caller wires it.

## AC-8 — default DEFER honored (no source change)

Command:
`git -C /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude status --porcelain extension/src/lib/salvage-ticket.ts extension/lib/salvage-ticket.js`

Prints nothing. Neither `salvage-ticket.ts` nor its compiled mirror is modified by this ticket.

## Pins left untouched (and expected green)

- `extension/tests/salvage-backfilled-done.test.js` — the only adapter wiring a real `backfillDone`.
- `extension/tests/integration/pipeline-completion-handsoff-e2e.test.js`.
- The B-PCOMP `#0a1ce691` "clean-tree completion back-fill" trap door in `extension/CLAUDE.md`.

## Reopen criteria

Revisit B-CSHYG-a **only** under an explicit operator override that enumerates the full blast
radius. If a future change makes a production caller wire `deps.backfillDone` **and** pass a real
`input.completionCommitSha`, the branch becomes LIVE — record that finding and **still** treat any
removal as out of scope for a sprawl-collapse pass. The clean-tree back-fill seam is a documented
forward contract, not incidental dead code.
