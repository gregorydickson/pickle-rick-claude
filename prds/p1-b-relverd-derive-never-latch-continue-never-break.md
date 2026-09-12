# B-RELVERD — the verdict layer: DERIVE, never latch; CONTINUE, never break

**One root.** A non-crash disposition must not doom the run verdict, and must not stop the phase loop.
Every item below is the same defect wearing a different name, and every item is measured at HEAD
`c741ce4f` on `release/v2.1-beta`, not inherited from the ledger.

**Why this bundle now.** Four consecutive bundles ran their phases and reported `failed`. The branch
they produced measures GREEN on every static leg, zero JS/TS drift, and 9/9 audits. The blocker is the
verdict layer, not the code. Nothing has been released since 2026-09-04; 273 commits stand unreleased.

**Composition.** Two source files (`bin/pipeline-runner.ts`, `bin/mux-runner.ts`) and their pins. Same
subsystem surface, so the ANATOMY-PARK + SZECHUAN toll is paid once for all four roots.

---

## 🔒 ROOT V1 — `nonConvergent` is a one-way latch (GitHub #16)

**Census at `c741ce4f`, `extension/src/bin/pipeline-runner.ts`:**

```
RAISE      5 sites: 4938, 5369, 5415, 5461, 5510   (+ 4016 seeds from phaseDispositions on crash-resume)
DECREMENT  0 sites  — grep 'nonConvergent(--|-=)' matches nothing
VERDICT    4618: const unsuccessful = pipelineFailed || counters.nonConvergent > 0;
```

Nothing in a run can lower it. Not a converged anatomy-park, not a clean szechuan, not a green gate.
ROOT G2's done-over-red withhold raises it at the **pickle boundary, phase 1 of 4**.

| bundle | session | tickets | tripped it | verdict |
|---|---|---|---|---|
| B-UNATTENDED | `2026-09-06-f625727a` | 17 | anatomy + szechuan | failed 2/4 |
| B-MEGADRAIN | `2026-09-06-27819a21` | 32 | 4 | failed 4/4, dead at phase 1 |
| B-CIGREEN | `2026-09-08-f365390b` | 10 | **1** | failed 3/4, dead at phase 1 |
| B-MEGADRAIN cont. | `2026-09-09-e959390b` | 23 | 3 dispositions | failed 4/4 |

One ticket in ten foreclosed a four-phase run. The withhold is a **per-ticket, repairable** condition
wired to a **run-level, monotonic** counter. A fact that can become false was stored in a variable that
can only go up.

**This is not a request to weaken the honesty gate.** Ran-to-completion and reported-success are
different wires and a genuinely red bundle must not release. The defect is that the verdict is latched
at the moment of the flip rather than derived at finalize from the tickets' FINAL state. Deriving is
strictly more honest: it answers "is this bundle red NOW?" instead of "was any ticket ever red?".

### AC-V1 (machine-checkable)
- V1-1: `unsuccessful`'s done-over-red term is re-derived at finalize from each Done ticket's CURRENT
  `worker_gate_tests_verdict`, not from a counter incremented mid-run. A ticket whose verdict is no
  longer red does not contribute.
- V1-2 (positive control): a bundle whose ticket is STILL red at finalize withholds exactly as today.
  Pinned, so the fix cannot become a fake-green.
- V1-3 (negative control): a bundle whose ticket was red at flip and is measurably green at finalize
  reports success. This is the case all four live bundles hit and none could express.
- V1-4: the other four raise sites are UNCHANGED. A test enumerates all five so a future collapse of
  the counter is a deliberate act, not a silent one.
- V1-5 (mutation): restore the latched increment; V1-3 goes RED and V1-2 stays GREEN.

**Do NOT fix this by resetting the counter.** A decrement is the same enumerated-liability shape one
level down: it needs a list of who may lower it. Derive the term at finalize and the counter is never
the source of truth, so it needs no reset.

---

## 🛑 ROOT V2 — a failed finalize gate breaks the phase loop unconditionally (GitHub #15)

`runAllBackendsExhaustedFinalizeGate` (`pipeline-runner.ts:4914`) ends:

```ts
log(`Phase ${rawPhase} finalize-gate failed after ${reason} (exit ${gateResult.exitCode})`);
return { action: 'break' };
```

and the caller at `:5621` is `if (outcome.action === 'break') break;` — **unconditional**. It does not
consult `pipeline_continue_on_phase_fail`, which the reporter's run had set to `true`.

Measured consequence, from the field report: a szechuan judge measurement failed, its fallback
finalization gate timed out, and a 22h 40m run stopped at 3 of 4 phases. A measurement failure took the
remaining phase to zero. That is the precise inversion the PRIME DIRECTIVE forbids: a quality verdict
is never a crash floor.

Note the shape of the sibling arm directly above it. On `exitCode === 0` the function already does the
right thing — raises `nonConvergent`, names the disposition, writes status, and returns `continue`. The
failure arm is the same situation with worse evidence, and it is the only one that stops.

### AC-V2 (machine-checkable)
- V2-1: the failed-gate arm returns `{ action: 'continue' }`, records a named phase disposition, and
  withholds the success verdict by the same term the passing arm uses.
- V2-2: with `pipeline_continue_on_phase_fail: true` and a finalize gate exiting non-zero, the run
  reaches the NEXT phase. Assert on the phase index reached, not on the exit code.
- V2-3: `--strict-phases` / `pipeline_continue_on_phase_fail: false` still stops. The opt-in is the
  only way to get the old behaviour.
- V2-4: the run still reports `failed` and still does not auto-release. Honesty is unchanged; only the
  disposition moves.
- V2-5 (mutation): restore `{ action: 'break' }`; V2-2 goes RED and V2-3 stays GREEN.

---

## 🔁 ROOT V3 — the remediator burns its budget on sentinels it cannot edit (GitHub #15, second half)

From the same run, three gate cycles in a row:

```
22:42:56  Remediator aborts: empty failing-files list (only `<timeout>` sentinels).
22:50:54  Remediator aborts: out-of-class fix, no editable target or usable test diagnostic.
22:57:54  Remediator again aborts: empty failing-files list.
```

A `<timeout>` pseudo-file matches no real path, so the remediator has nothing to act on and aborts,
having consumed a finalization cycle. Three cycles produced zero fixes and then exhausted the cap. The
second cycle additionally recorded a real non-zero test exit against a package directory with **only
the first ~500 characters of startup output**, discarding the diagnostic that would identify the
failure.

This is the "measurement destroys its own evidence" class: a timeout is a *known* non-actionable
outcome, and spending a remediation cycle rediscovering that is the loop failing to advance.

### AC-V3 (machine-checkable)
- V3-1: a failing-files list consisting solely of pseudo-file sentinels (`/^<[^>]+>$/`) does not
  consume a finalization cycle. It is classified as unmeasured and reported as such.
- V3-2: the distinction is drawn from the EXISTING unmeasured-check predicate rather than a new
  sentinel list. No second enumeration of pseudo-file spellings.
- V3-3: a non-zero test exit retains enough captured output to name the failure. Assert that a known
  failing test's name survives into the recorded diagnostic; a truncation that drops it is the defect.
- V3-4: a genuine failing file still consumes a cycle and is still remediated. Over-triggering V3-1
  would silently disable remediation.
- V3-5 (mutation): restore the sentinel-blind path; V3-1 goes RED and V3-4 stays GREEN.

---

## 📉 ROOT V4 — a downgraded anatomy crash reports GREEN (AP-EXT-ITER5-01 residual, fence-blocked)

`runPhaseIteration`'s `shouldSkipAnatomyPhaseWithWarning` branch returns `{action:'continue'}` with
`counters.skipped++` and **no** `nonConvergent++` and **no** `counters.phaseSkips[rawPhase]`. The
EVIDENCE half of this gap was closed (the `recordRecoverablePhaseFailure` call now lands). The
DISPOSITION half is still open: a crashed anatomy-park phase is downgraded to a skip whose reason is
unnamed in the summary, while a benign empty-scope skip IS named.

**Why it was deferred and how to land it.** `nonConvergent > 0` flips `unsuccessful` and therefore the
process exit code, and `extension/tests/pipeline-runner-anatomy-park.test.js:147` asserts
`expectMainExit(sessionDir, 0)` on exactly that scenario while sitting outside `scope.json:allowed_paths`.
**Scope this ticket to include that test file** so the assertion and the disposition land together.
`PhaseSkipReason` additionally needs widening past its four members; do that alongside the schema
mirror, not ahead of it.

**Sequencing note:** V4 interacts with V1. Land V1 first, then V4, so the new raise is added to a term
that is already derived rather than to a latch.

### AC-V4 (machine-checkable)
- V4-1: the downgraded-anatomy-crash branch names its disposition in `counters.phaseSkips[rawPhase]`
  and withholds success by the V1-derived term.
- V4-2: `pipeline-runner-anatomy-park.test.js:147` is updated in the same commit, with its new expected
  exit code justified in the test body.
- V4-3: a benign empty-scope skip is still a skip and still reports success. The widening must not
  make an ordinary skip look like a crash.
- V4-4 (mutation): remove the disposition write; V4-1 goes RED and V4-3 stays GREEN.

---

## 🛡 PRIME DIRECTIVE compliance

Every root here REMOVES a stopping or dooming path and adds no new one. V2 deletes a `break`. V1
replaces a latch with a derivation, which is fewer states a reader must hold, not more. V3 removes a
wasted cycle rather than adding a guard around it. V4 names an existing unnamed disposition.

No item asks a gate to stop the pipeline. No item weakens honest reporting: in all four, a genuinely
degraded run still reports `failed` and still does not auto-release.

## Non-goals

- Do NOT add a decrement to `nonConvergent`.
- Do NOT touch `APNC_MAX_PASSES_WITHOUT_CLEAN`, `anatomy_max_iterations`, `szechuan_max_iterations`, or
  `stall_limit`. Different bounds on different axes.
- Do NOT change the done-over-red withhold's TRIGGER. V1 changes when and from what the verdict is
  computed, not what counts as red.
- Do NOT touch `rate_limit_exhausted`. It is already `haltEligible: false` and the R-MVPARK cumulative
  park ceiling is wired. The last run's anatomy-park exit on that reason was the design working.

## Simplification Review

Named subtractions: one `return { action: 'break' }` deleted (V2); one mid-run counter removed from the
verdict path (V1); one remediation cycle removed from a known non-actionable input (V3). V4 is net-zero
in mechanism, converting an unnamed skip into a named one.

The enumerated-set liability to watch: V3-2 explicitly forbids a second list of sentinel spellings.
Reuse the existing unmeasured-check predicate or the fix schedules its own next bypass.
