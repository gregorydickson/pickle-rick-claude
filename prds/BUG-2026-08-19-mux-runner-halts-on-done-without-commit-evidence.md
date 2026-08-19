# BUG-2026-08-19 (P0) — mux-runner HALTS on `done_without_commit_evidence`; pipeline-runner already park-and-flags it

## Status

Open. Branch `release/v2.1-beta`, HEAD `08415a3e`. **This is a PRIME-DIRECTIVE violation: a quality
verdict stopped the pipeline.**

## What happened

Session `2026-08-19-541c0275` (4 tickets) ran 8 iterations / 256m, landed 3 of 4 tickets with real
commits, and then **terminated** instead of completing:

```
[fatal] ticket 400fcac0 cannot flip Done: readEvidence().kind === 'absent' (expected 'committed');
worker did not produce an attributable git commit. Edit ticket frontmatter to include completion_commit: <sha>.
[mux-runner] finished. 8 iterations, 256m 2s
```

Terminal state: `active: false`, `step: "review"`, `exit_reason: "done_without_commit_evidence"`,
**`completion_promise: null`** — no `EPIC_COMPLETED`, no post-final measurement, no reconciliation.

**The ticket was correct to have no commit.** `400fcac0` is titled *"Verification: run all three
tiers at the bundle's final sha and fix what they surface"*. Its worker completed all 8 lifecycle
phases, wrote research / plan / conformance / review artifacts, set `worker_gate_verdict: "green"`,
and reported: *"implement found zero in-scope regression … simplify has nothing to touch (no diff)"*,
then emitted `<promise>I AM DONE</promise>`. A verification ticket that finds nothing to fix has, by
construction, no attributable commit. The guard demanded a SHA that must not exist and killed the run.

## Root cause — the fix exists at one layer and was never applied at the other

- `extension/src/bin/pipeline-runner.ts:4556-4560` (WS-B, `f8559470`) already classifies this reason
  as non-fatal: *"`done_without_commit_evidence` is a per-ticket verdict, not a cannot-continue halt —
  advancing, reporting incomplete for reconciliation"*.
- `extension/src/bin/mux-runner.ts:5561-5567` still returns `{ ok: false, source: 'absent' }` on the
  same condition, and that refusal reaches the `[fatal]` path and ends the run.

`/pickle-tmux` launches `mux-runner.js` **directly**, so pipeline-runner's park-and-flag never
executes for a tmux-mode bundle. Every tmux run therefore still carries the halt that was supposedly
removed. Note the sibling refusal at `:5551-5558` (`worker_gate_red` / `worker_gate_unavailable`) is a
DIFFERENT class and is out of scope here.

## Impact

A 4-ticket bundle that was 4/4 complete on the work produced a halted run with no completion promise
and no tier verdict. Per the ratchet, a halted run takes reliability AND quality to zero: the three
landed commits (`7e6b8254`, `140e79c2`, `08415a3e`) shipped without the bundle's own verification
ticket ever being reconciled. This is also the SECOND time this class has bitten (`B-GTRUTH`'s
`done_without_commit_evidence` work, `f8559470`), which is why the fix must be the general one, not a
new special case for verification tickets.

## Acceptance criteria

- **AC-1** A ticket whose Done-flip fails with evidence `kind === 'absent'` **parks and the phase loop CONTINUES**. `mux-runner` must not terminate on this condition. The run proceeds to the next ticket, synthesizes its completion promise, and runs the post-final measurement.
- **AC-2** The run still REFUSES the local Done-flip and records the residual: the ticket does not silently become Done, and `exit_reason` / a per-ticket residual still names `done_without_commit_evidence` so the honesty signal survives. Continuing is not claiming success — the success verdict is WITHHELD for that bundle (`nostop-gates` semantics).
- **AC-3** The behaviour matches `pipeline-runner.ts:4556-4560` exactly — one shared classification of this reason, not two divergent copies. If a shared helper is the natural seam, use it; do NOT add a third policy site.
- **AC-4** A test drives `mux-runner` through a ticket with a lifecycle-complete worker, `worker_gate_verdict: green`, and NO commit, and asserts: the loop advances to the next ticket, the run reaches its terminal promise, and the ticket is NOT flipped Done. It must fail if the fatal is reintroduced.
- **AC-5** A test asserts the sibling `worker_gate_red` / `worker_gate_unavailable` refusal at `mux-runner.ts:5551` is UNCHANGED and still fail-closed (R-CWGE). This bundle must not widen the no-stop treatment to the gate-verdict class.
- **AC-6** `grep -rn "done_without_commit_evidence" extension/src/bin/mux-runner.ts` shows no remaining path that ends the phase loop on this reason.
- **AC-7** No new `exit_reason` value is introduced, and no new abort condition is added anywhere. Every new halt path is a new way for reliability to reach zero.
- **AC-8** `cd extension && bash scripts/audit-subprocess-heavy-tests.sh` exits 0.
- **AC-9** `npm run test:fast` reports `fail 0` / `cancelled 0`, tests >= 7737, suites >= 508. A shrinking count is a regression, not a fix.
- **AC-10** `npm run test:integration:parallel` reports `fail 0` / `cancelled 0`, tests >= 622, suites >= 21.

## Non-goals

- Making a zero-diff verification ticket flip Done. It should park, not pass. The defect is the HALT,
  not the refusal.
- Re-litigating the `zero_diff_intent` declaration machinery (`evaluateCompletionEvidence`). If a
  declared zero-diff accept would have covered this ticket, say so in the ticket, but do not extend
  that arm here — AC-1 fixes the disposition, which is the reliability property.
- Any capability work.

## Execution posture

**ATTENDED.** This bundle edits the completion-evidence / Done-flip path, so the deployed pre-fix
runtime applies the same buggy logic to the worker building the fix (the R-PSRB catch-22). That is
the hazard being tested, not an excuse to hand-build: launch normally, watch the Done-flip seam, and
recover the run if it bites. Precedent: `B-RASO` (beta.43) shipped a salvage-path fix this way.

## Simplification Review

1. **What can be deleted instead of added?** The fatal itself. This is a subtraction: one refusal path
   stops ending the loop.
2. **Is there an existing seam?** Yes — `pipeline-runner.ts:4556-4560` already encodes the correct
   policy. Reuse it rather than writing a second one.
3. **Does this add a new abort condition?** No, and AC-7 forbids it.
4. **What accretion does this remove?** A divergence between two runners that made the documented
   no-stop guarantee false for every tmux-mode run.
