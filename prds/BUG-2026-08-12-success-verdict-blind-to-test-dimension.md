# BUG-2026-08-12 — The success verdict is structurally blind to the test dimension

## Summary

Across the surviving session corpus, **28 tickets carry `worker_gate_tests_verdict: red` and every one of them carries `worker_gate_verdict: green`.** Zero counterexamples. The aggregate the Done-flip authority reads cannot express a test failure, so a ticket whose own test run went red flips Done, the bundle finalizes, and the pipeline reports success.

This is not a missing check. The truth is already recorded on disk, correctly, on every one of those 28 tickets. A second field records it and a second authority reads it — just not the one that decides.

Two tickets in the corpus are from the run that was in flight when this was found, including the ticket that authored that bundle's central change.

## Evidence

`computeWorkerGateVerdict` (`extension/src/bin/spawn-morty.ts:1719-1746`) accepts exactly six inputs:

```
lintOk, tscOk, lintRan, lintUnrunnable, tscUnrunnable, applicable
```

There is no test parameter. The final line returns `lintVerified || result.tscOk ? 'green' : 'red'`. The comment immediately below states the consequence in the codebase's own words:

> `WORKER_GATE_VERDICT_FIELD` is eslint+tsc-only (R-WGFR) even on a REAL (non-recomputed) worker turn

Census over `~/.local/share/pickle-rick/sessions/*/*/rick_ticket_*.md`:

| `worker_gate_tests_verdict` | `worker_gate_verdict` | Tickets |
|---|---|---|
| `red` | `green` | **28** |
| `red` | anything else | **0** |

A live instance from the run in flight at discovery time:

```
d3654991   status: "Done"   completion_commit: 90b81564
           worker_gate_verdict: "green"
           worker_gate_tests_verdict: "red"
```

### The honest field already has an authoritative reader — one

`extension/src/bin/setup.ts:1227` reads `worker_gate_tests_verdict`, and `extension/src/bin/CLAUDE.md:102` documents the resume-reattach Done flip as gated on three sequential guards, the third being:

> R-WDTF-TO WS-3 — `readTicketWorkerGateTestsVerdict(...) !== 'red'` … a clean lint/tsc reading must not resurrect a real test failure to Done

That same invariant insists the two Done-flip authorities must branch on one shared predicate rather than bespoke checks. On the advisory dimension they do. On the test dimension they do not: `guardCompletionCommitBeforeDone` (`extension/src/bin/mux-runner.ts:5075`) never reads the field.

So the system already knows that a persisted lint/tsc green must not overrule a real test failure. It enforces that at the rarely-taken resume path and not at the path every normal flip takes.

## The trap in the obvious fix

The obvious fix — make `guardCompletionCommitBeforeDone` refuse Done on `worker_gate_tests_verdict: red` — is wrong, and the reason is recorded in this repo's history.

R-WGFR removed `test:fast` from the verdict deliberately, because a `--test-concurrency=8` flake false-redded a bundle. The fast tier is *currently* flaky; that is the subject of `prds/BUG-2026-08-12-fast-tier-marginal-spawn-timeouts.md`, whose measurements show four of five failures landing within 50 ms of their caps. Making a flaky signal authoritative over Done would strand every ticket on noise — trading a false green for a false red, and taking output to zero.

The operator's rule resolves this without a trade. From `CLAUDE.md`:

> honesty is a REPORTING property, halting is a DISPOSITION, and they are not the same wire

Done may still flip. What must change is that the **run stops calling itself successful** when a ticket's tests went red.

## Non-goals

- **Not** blocking the Done flip on a red test verdict. That is the trap above.
- **Not** re-adding `test:fast` to `computeWorkerGateVerdict`. R-WGFR removed it for a good reason; this PRD does not reverse it.
- **Not** adding a new gate, field, or verdict. Every fact needed already exists on disk.
- **Not** halting anything. No new abort condition, no new terminal state.

## Prerequisite

`prds/BUG-2026-08-12-fast-tier-marginal-spawn-timeouts.md` must land first. Until the fast tier's caps are derived rather than guessed, `worker_gate_tests_verdict: red` carries too much noise to drive a release decision, even a non-blocking one. This PRD makes the signal *visible*; that one makes it *trustworthy*. In the wrong order, the visibility is just alarm fatigue.

## Workstreams

### WS-A — One predicate, both authorities

`setup.ts` resolves the honest field through `readTicketWorkerGateTestsVerdict`. Export that reader (or the predicate wrapping it) and have `guardCompletionCommitBeforeDone` consult the same one, so the two Done-flip authorities agree on what the field means.

`guardCompletionCommitBeforeDone` does **not** refuse on red. It records the fact on its return value so callers can act, preserving park-and-flag.

This is subtractive in the sense that matters: it deletes a second, implicit policy (the mux path's "tests don't exist") rather than adding a check.

**Acceptance criteria**

- `AC-A1` — Both Done-flip authorities read `worker_gate_tests_verdict` through **one** exported reader; `grep -c` for a bespoke `worker_gate_tests_verdict` literal comparison outside that reader returns `0`.
- `AC-A2` — A ticket with `worker_gate_tests_verdict: red` still flips Done. A test asserts the flip proceeds — this criterion exists to prevent the fix from becoming a stopping gate.
- `AC-A3` — `guardCompletionCommitBeforeDone`'s result carries the test-dimension fact for callers.
- `AC-A4` — `npx tsc --noEmit` and `npx eslint src/ --max-warnings=-1` green.

### WS-B — Withhold the success verdict

A run in which any ticket flipped Done over a red test verdict must not report success and must not auto-release.

`fakegreen-audit` traced the mechanism: `counters.nonConvergent` is raised only at `extension/src/bin/pipeline-runner.ts:4251` and `:4567`, both microverse paths, never from a gate residual — so `unsuccessful` stays false, `pipeline-status` reads `completed`, and `executeCloserReleasePlan` runs `install()` + `tag()`. Raise the existing term from the residual path rather than introducing a new one.

**Acceptance criteria**

- `AC-B1` — A bundle with ≥1 ticket Done over `worker_gate_tests_verdict: red` finalizes with `unsuccessful: true`, `pipeline-status` not `completed`, and closer-release skipped.
- `AC-B2` — The run still executes every remaining phase — degraded, not halted. A test asserts phase count is unchanged versus a clean run.
- `AC-B3` — The withheld verdict names the offending tickets and their test verdicts in the run summary, so the operator sees which ticket and why.
- `AC-B4` — A bundle with no red test verdicts is unaffected: success reported, release plan runs. Guards against the fix reddening every run.

### WS-C — Route the residual to the sink that is read

The advisory residual currently uses `writeActivityEntry` → `state.json.activity` (`extension/src/bin/mux-runner.ts:4914-4931`), but `scanSkipFlagEvents` reads `getDataRoot()/activity/*.jsonl` only (`extension/src/services/metrics-utils.ts:86`). So `worker_gate_target_repo_red` counts zero forever in `/pickle-metrics`. `extension/src/services/state-manager.ts:1506-1511` states the rule, and `emitCompletionFinalizeRefused` already obeys it with an inlined jsonl append.

Copy that append. One sink swap.

**Acceptance criteria**

- `AC-C1` — The residual is written to the jsonl sink; `/pickle-metrics` reports a non-zero count for a run that produced one.
- `AC-C2` — A test asserts the event lands in `getDataRoot()/activity/*.jsonl`, not only in `state.json.activity`.

### WS-D — Backfill the corpus verdict

The 28 known tickets were reported as delivered under a green that did not cover tests. Produce a one-off report listing every ticket in the session corpus with `worker_gate_tests_verdict: red`, its session, its `completion_commit`, and whether that commit is still on a branch — so the operator can see the blast radius rather than infer it.

Report only. This workstream changes no ticket state and reverts nothing.

**Acceptance criteria**

- `AC-D1` — A committed report enumerates every affected ticket with session, commit, and branch reachability.
- `AC-D2` — The report states plainly that a red test verdict does not by itself prove the commit is bad — only that it was never verified. Overclaiming here would be the same failure in the other direction.

## Interface Contracts

**`readTicketWorkerGateTestsVerdict(sessionDir, ticketId)`** (existing, to be exported)
- Inputs: session dir, ticket id.
- Outputs: `'red' | 'green' | 'not_run' | null`. `null` for absent/unreadable/unrecognised.
- Errors: never throws; unreadable maps to `null`.
- Invariants: the sole reader of the field. `not_run` is not `red` and must not be treated as one — an off-repo gate that never ran persists `not_run`.

**`guardCompletionCommitBeforeDone`** (existing, extended)
- Outputs: adds the test-dimension fact to its existing result.
- Invariants: its `ok` disposition is unchanged by this dimension. A red test verdict never flips `ok` to false — that is `AC-A2`, asserted by test.

## Test Expectations

`node:test` has no `describe.each`/`test.each`; use `for (const c of CASES) test(...)`.

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-A1 | `extension/tests/worker-gate-tests-verdict-single-reader.test.js` | One reader, two authorities | No bespoke `worker_gate_tests_verdict` comparison outside the shared reader |
| AC-A2 | `extension/tests/worker-gate-tests-verdict-single-reader.test.js` | Red tests do not block Done | Ticket with red tests still reaches Done |
| AC-A3 | `extension/tests/worker-gate-tests-verdict-single-reader.test.js` | Fact reaches callers | Guard result carries the test verdict |
| AC-B1 | `extension/tests/success-verdict-withheld.test.js` | Degraded run withholds success | `unsuccessful: true`, status not `completed`, release skipped |
| AC-B2 | `extension/tests/success-verdict-withheld.test.js` | Degraded ≠ halted | Phase count equals a clean run's |
| AC-B4 | `extension/tests/success-verdict-withheld.test.js` | Clean run unaffected | Success reported, release plan runs |
| AC-C2 | `extension/tests/advisory-residual-sink.test.js` | Residual reaches the read sink | Event present in `activity/*.jsonl` |

## Simplification Review

**What is removed rather than added?** The mux path's implicit second policy that tests do not exist. After this, one reader owns the field and both authorities consult it — replacing two divergent behaviours with one.

**Is any workstream a guard over a broken mechanism?** WS-B is a reporting change, not a guard: it raises an existing counter from a path that already produces the fact. No new gate is introduced anywhere in this PRD.

**Could deletion solve it instead?** Considered: delete `worker_gate_tests_verdict` entirely and accept lint+tsc as the verdict. Rejected — that deletes the only honest record of the test dimension and makes the fake-green permanent. The subtraction that *is* adopted is deleting the divergent policy, not the data.

**Does this add an abort or halt condition?** No. `AC-A2` and `AC-B2` exist specifically to prove it does not, and both are asserted by test rather than by prose.

## Residuals

1. The foreign-SHA borrow is live and unexplained: session `2026-08-10-3d58fed2`, ticket `3afa92b0`, `completion_commit: f0992812` — a commit whose subject and `Pickle-Ticket` trailer both name sibling `c6fe78ec`, which is Done and stamped with the same commit. `isForeignAttributedExplicitSha` should have rejected it. Three candidate explanations (stamp written after the flip by promote-once; `ownAttributionTokens` suppressing rejection; a gate-exempt phantom-watch route) — none verified. Out of scope here; this is the open zero-diff/foreign-SHA bug with a reproducible artifact attached.
2. `extension/src/services/convergence-gate.ts:1343-1356` returns `status: 'green'` for a gate that never ran (unrecognised project type, or a monorepo package deeper than one level). Same not-run-as-green class B-OFFREPO fixed in the worker gate; the convergence gate never got it. Separate bundle.
3. An empty commit is valid completion evidence — `commitExists` is `git cat-file -e <sha>^{commit}` with no diff-emptiness probe, and `--allow-empty` is not among the blocked git verbs. Separate bundle.
4. The 28-ticket census covers only surviving session dirs. June/July `state.json` files were pruned, so the true historical count is unmeasurable and is certainly higher.

## Build constraints

- Build via `/pickle-tmux`. This edits the Done-flip and finalize paths — the completion-evidence seam — so per `CLAUDE.md` it runs **ATTENDED**: the deployed pre-fix runtime applies this same logic to the worker building the fix.
- Sequenced after `prds/BUG-2026-08-12-fast-tier-marginal-spawn-timeouts.md`.
