# BUG REPORT — R-WDTF: `no WORKER_DONE token` flips a COMPLETED worker's ticket to Failed

**Found**: 2026-07-12, session `2026-07-11-255ad373` (R-SCPIN bundle, attended)
**Severity**: P1 — strands or destroys delivered work in unattended pipelines
**Class**: validation overreach / wrong-signal discard (north-star defect #1 and #2)

## Symptom

`spawn-morty` validates worker completion on the presence of a `WORKER_DONE` token in the
worker's stdout. When the token is absent it writes `status: "Failed"` to the ticket
frontmatter — **unconditionally, and last**. It therefore *overwrites* a `Done` that the
worker itself already wrote.

Observed twice in one bundle:

| Ticket | Worker outcome | spawn-morty verdict |
|---|---|---|
| `6309e498` | exit 0, full artifact set, mutation-tested the suite, **work left uncommitted** | `Failed` — "no WORKER_DONE token" |
| `695e4fb4` | exit 0, full artifact set, **committed `f75bc76a`, self-flipped ticket to `Done` with `completion_commit`** | `Failed` — overwrote the worker's own `Done` |

In both cases the worker had demonstrably completed. `695e4fb4` is the sharper case: the
ticket on disk said `Done` with a real `completion_commit`, and spawn-morty stomped it to
`Failed` anyway.

## Why it matters

The token is a *narrative* signal (did the model emit a string?). The ticket's
`status` + `completion_commit` + artifact set + the commit in `git log` are *ground truth*.
Today the narrative signal outranks ground truth and can only ever destroy information.

Downstream, a `Failed` ticket is a respawn/salvage trigger. In an unattended run this means:
- a delivered ticket gets re-attempted (wasted tokens, duplicate commits), or
- the salvage path resets over the worker's uncommitted verified work (`6309e498` would have
  lost the entire mutation-hardening diff — 183 lines that took the worker ~25 minutes and a
  mutant build to derive).

Both tickets here were hand-recovered by the manager. Unattended, both would have regressed.

## Root cause

`spawn-morty`'s post-run validation treats a missing token as *proof of failure* rather than
*absence of evidence*. It never consults the ground truth the worker already wrote to disk.
The two workers that tripped it were both long-running (`large` tier) and ended their final
turn while awaiting a test suite — so they never got a turn in which to emit the token, even
though the work was done and (in one case) committed.

## Fix direction — subtractive, trust ground truth

Before writing `Failed` on a missing token, read the ground truth the worker left:

1. If the ticket frontmatter already says `Done` **and** carries a `completion_commit` that
   resolves to a real commit → leave it `Done`. The token adds nothing.
2. Else if the full artifact set is present and the working tree has a real diff → do NOT
   write `Failed` (which invites a destructive salvage). Surface an honest, distinct status
   (e.g. `Needs Review` / manager handoff) so the delivered work is preserved, not reset.
3. Reserve `Failed` for the case it actually names: no artifacts, no diff, no commit.

This is a subtraction: it removes a signal that can only lose information, and defers to the
signals that cannot. It aligns with the standing rule *"`I AM DONE` is a claim, not a fact —
validate from the artifacts and the diff on disk"* — which today the **manager** obeys and
**spawn-morty** does not.

## Acceptance criteria

- **AC-WDTF-1** — a worker that exits without a `WORKER_DONE` token but whose ticket says
  `Done` with a resolvable `completion_commit` is left `Done`; spawn-morty does not overwrite it.
- **AC-WDTF-2** — a worker that exits without the token, with a full artifact set and a
  non-empty working-tree diff, is NOT flipped to `Failed`.
- **AC-WDTF-3** — a worker that exits with no artifacts, no diff and no commit is still
  flipped to `Failed` (the true-negative case is preserved).
- **AC-WDTF-4** — regression test reproduces the `695e4fb4` shape: worker self-flips `Done` +
  `completion_commit`, emits no token; assert the ticket is still `Done` after spawn-morty's
  validation.

## Simplification Review (subtract-before-add)

- **What is being added?** Nothing net-new — a ground-truth check *replaces* an unconditional write.
- **What can be removed?** The unconditional `Failed` write on missing-token.
- **Is there an existing seam?** Yes — the manager's own validation already does exactly this
  (artifacts + diff + commit). This makes spawn-morty agree with it instead of contradicting it.
- **Does this add brittleness?** No — it strictly narrows a destructive write.

## Routing

Pipeline-safe? **NO — R-PSRB hand-build.** The `Failed` flip feeds the salvage / Done-flip
path, and the deployed buggy runtime would apply this exact logic to the worker building the
fix. Hand-build per the narrow R-PSRB exception.
