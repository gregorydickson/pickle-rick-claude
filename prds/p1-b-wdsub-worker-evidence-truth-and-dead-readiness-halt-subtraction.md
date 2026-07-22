---
title: "B-WDSUB — worker-evidence truth + dead readiness_halt cluster subtraction (v2.1)"
priority: P1
finding: B-WDSUB
composes: [R-WDTF, R-PRNF9-DEAD]
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
source_assessment: "MASTER_PLAN NEXT STEPS #3 + #5, both re-grounded at HEAD a17e9258 (post-B-NONSTOP, 39 commits) on 2026-07-22. Queue items #2 (R-RPFL) and #4a (B.5 finalizePhaseSuccess) were re-grounded in the same pass and found ALREADY FIXED by this bundle's predecessor commits (2de40025, 22dcccd7) — they are dropped, not built."
---

# B-WDSUB — ground truth outranks narration, and dead code stops pretending to be a guard

Two independent subtractions, batched into one build so a single release gate covers both.
Neither adds a mechanism. Both remove one.

**Why batched:** the release gate is the expensive serialized step (soak + integration + expensive
tiers). The build is parallel per-ticket; the gate is not. Batching amortizes the gate.

---

## WS-1 — R-WDTF: subtract the narrative-token conjunct (P1, repo-agnostic)

**The defect.** A worker's success is decided by an AND-chain in which a *narrative token the model
must remember to print* is a hard conjunct, outranking ground truth (artifacts on disk, git edits).
A worker that did the work, wrote the artifact, and committed — but did not print the token — is
declared **Failed**, and its verified work is destroyed by the downstream reset. This is the
single most expensive false-negative class in the runtime and it bites **every target repo**, not
just self-builds.

### Site 1 — `extension/src/bin/spawn-morty.ts:2471` (CONFIRMED LIVE at HEAD)

```ts
const isSuccess = !ctx.mutableState.timedOut && tokenPresent && hasArtifact && (logNonTrivial || hasEdits);
```

`tokenPresent` (`:2467`) is `hasToken(logContent, PromiseTokens.WORKER_DONE)`. Ground truth
(`hasArtifact`, `hasEdits`) is already in the chain — the token adds nothing a real completion
does not already prove, and subtracts everything when the model forgets to narrate.

**Take the subtractive arm: delete the conjunct.** The "hoist/suppress the failure" arm is
ADDITIVE and is explicitly REJECTED — do not add a guard around a bad guard.

Collateral that must go with it (or the log lies about a non-failure): the `tokenPresent` field in
`buildValidationFailureReasons`' `checks` struct and its `'no WORKER_DONE token'` reason string
(`:2398-2412`).

### Site 2 — `extension/src/bin/spawn-refinement-team.ts:968` (CONFIRMED LIVE, worse than filed)

```ts
const success = !workerTimedOut && hasToken(logContent, PromiseTokens.ANALYSIS_DONE);
```

Here the token is the **only** positive evidence — there is no artifact or edit fallback at all.
A blind `tokenPresent`-deletion leaves `success = !workerTimedOut`, i.e. "success == didn't time
out", which is a different and possibly worse lie.

**REQUIRED DECISION (research phase must resolve with evidence, and the ticket must record which
arm it took and why):**

- **Arm A (preferred if it holds):** replace the token with ground-truth evidence that *already
  exists on disk* for a refinement analyst — the per-role artifact this worker is contracted to
  produce. Grep what `spawn-refinement-team.ts` actually writes and what the manifest builder
  actually reads. This is a substitution, not an addition: no new file, no new field, no new write.
- **Arm B (fallback):** drop to `!workerTimedOut` **only if** the downstream consumer
  (`enrichManifestTicketsFromSourcePrds` / manifest build) already handles an empty analyst result
  honestly. If it does, emptiness is caught downstream and the conjunct here is redundant.

**Arm B is only permissible with a cited line proving the downstream handles it.** If neither arm
holds, say so in the ticket and leave site 2 unchanged rather than guessing — a half-fix here is
worse than none.

### WS-1 Acceptance Criteria

- **AC-WDSUB-1** — `grep -c "tokenPresent" extension/src/bin/spawn-morty.ts` returns `0`.
- **AC-WDSUB-2** — regression test: `evaluateWorkerOutcome` returns `isSuccess: true` for a worker
  that did **not** time out, has a lifecycle artifact, has git edits, and whose log contains **no**
  `WORKER_DONE` token. This test must FAIL against HEAD before the fix (red-green proof recorded in
  the ticket).
- **AC-WDSUB-3** — over-subtraction guard: `evaluateWorkerOutcome` still returns `isSuccess: false`
  when the lifecycle artifact is absent, and when `timedOut` is true. The remaining conjuncts are
  ground truth and MUST survive (B-GSUB guardrail: do not strip earned signal).
- **AC-WDSUB-4** — `buildValidationFailureReasons` no longer emits `'no WORKER_DONE token'`, and
  its `checks` parameter type no longer declares `tokenPresent`.
- **AC-WDSUB-5** — site 2: the ticket records **Arm A**, **Arm B + the cited downstream line**, or
  **unchanged + why**, and ships a test pinning whichever holds.
- **AC-WDSUB-6** — no new file, field, flag, setting, or state key is introduced by WS-1.

---

## WS-2 — R-PRNF9-DEAD: delete the `readiness_halt` cluster (pure subtraction)

**The defect.** A four-site reader cluster guards on an `exit_reason` value **no code anywhere
writes**. Re-grounded at HEAD 2026-07-22 across `extension/src/` **and** the deployed runtime
`~/.claude/pickle-rick/extension/`: zero producers of `'readiness_halt'`. The chain is dead
end-to-end:

1. `pipeline-runner.ts:4047` reads `readiness_halt` → never true, so
2. `:4048` never writes `pickle_readiness_halt`, so
3. `:3719`'s `exit_reason === 'pickle_readiness_halt'` predicate is never true, and
4. `:2799` (`isFatalPhaseFailure`) + `:3890` (`getFatalPickleHaltReason`) never fire.

Confirmed sites: `pipeline-runner.ts:2799, 3719, 3789 (comment), 3890, 4043-4050`.
Test surface: `tests/pipeline-runner-prnf9.test.js` (220 lines), `tests/mux-runner.test.js:1067`.

### MANDATORY research gate before deleting anything

**Was there ever a producer, and was its removal intentional?** Run `git log -S"readiness_halt"`
across the full history. If a producer once existed and was deleted **by accident**, then deleting
the readers cements a lost capability — the correct fix would be to restore the producer, and this
workstream must STOP and report that instead. Only proceed to delete if the record shows the
producer was intentionally removed or never existed. Record the git evidence in the ticket.

### Deletion boundary — what must NOT be touched

- `isFatalPhaseFailure`'s `done_without_commit_evidence` check (`:2802`, AC-MWMO-D2-8) is **live and
  load-bearing**. Delete only the `readiness_halt` line above it.
- `getFatalPickleHaltReason`'s `start_commit` / baseline-unmeasurable branches are live. Delete only
  the `readiness_halt` branch.
- `tests/pipeline-runner-prnf9.test.js` must be **triaged, not blanket-deleted**: AC-PRNF-9-4
  ("partial build with commits, exit_reason NOT readiness_halt") may still pin live behavior. Keep
  what pins a live path; delete only assertions whose subject is the dead cluster.
- `tests/mux-runner.test.js:1067` asserts `notEqual(exit_reason, 'readiness_halt')` — tautological
  once nothing writes it. Triage it the same way.
- `tests/fixtures/codegraph-terms/a5f8cf4f.md` is an inert fixture. Leave it.

### WS-2 Acceptance Criteria

- **AC-WDSUB-7** — `grep -rn "readiness_halt" extension/src/` returns `0` hits (covers both
  `readiness_halt` and `pickle_readiness_halt`).
- **AC-WDSUB-8** — the git-history producer question is answered in the ticket with a cited
  `git log -S` result.
- **AC-WDSUB-9** — `done_without_commit_evidence` still returns `true` from `isFatalPhaseFailure`
  (test pins it) — proof the deletion did not over-reach.
- **AC-WDSUB-10** — full `npm run test:fast` green with no skipped/quarantined test added to
  compensate for a deletion.

---

## WS-3 — Verification: RUN the claim, don't cite it

Per [[feedback_verify_the_outcome_not_the_mechanism]] and
[[feedback_add_a_verification_ticket_that_runs_the_claim]] — this bundle claims two outcomes. A
ticket must **execute** each and record the observed result. **If an observation contradicts the
claim, retract the claim in the ticket rather than restating the prediction.**

- **AC-WDSUB-11 (WS-1 outcome)** — drive a worker end-to-end (real spawn, or a harness faithful to
  `evaluateWorkerOutcome`'s real inputs) that completes its work and writes its artifact **without
  emitting `WORKER_DONE`**. Observe and record: is it Done, or Failed? Claim holds only if Done.
- **AC-WDSUB-12 (WS-2 outcome — the B-GSUB guardrail)** — a readiness halt is a real incident. With
  the cluster deleted, **name the code path that now catches it** and demonstrate the pipeline still
  halts fatally on that scenario. If NO path catches it, the cluster was dead-but-load-bearing-by-
  intent and WS-2 must be reduced to a comment correction instead of a deletion. This AC is the one
  that decides whether WS-2 ships at all.
- **AC-WDSUB-13** — net LOC across the bundle is **negative** (`git diff --stat` vs `a17e9258`).

---

## Simplification Review (subtract-before-add)

(1) **Adds nothing.** No gate, flag, state field, setting, or file. WS-1 removes a conjunct and a
reason string; WS-2 removes four reader sites and a promotion block. Every AC that could tempt an
additive fix (site 2's Arm B, WS-2's over-reach guard) is explicitly bounded to reuse-or-stop.
(2) **REUSE:** WS-1 reuses the ground-truth evidence *already computed* in the same function
(`hasArtifact`, `hasEdits`, `logNonTrivial`) — no new evidence source. Site 2 Arm A must reuse an
artifact the analyst already writes; inventing one is out of scope. WS-2's over-reach test reuses
the existing `pipeline-runner-prnf9.test.js` harness.
(3) **The brittle thing is the narrative token as a hard conjunct** — a model-memory dependency
sitting upstream of work destruction. This bundle DELETES that dependency rather than wrapping it
in a suppression (the rejected additive arm). The system ends up less able to false-fail, which is
the stated bar.
(4) **Subtraction:** one conjunct + one reason string + one struct field (WS-1); four reader sites,
one promotion block, one dead predicate, and their now-tautological tests (WS-2). Expected shape is
net-negative LOC — pinned by AC-WDSUB-13.

## Risks

- **Over-subtraction (WS-1).** Dropping too much would let a genuinely-failed worker read as Done —
  strictly worse than the bug being fixed. Mitigated by AC-WDSUB-3 pinning that artifact-absent and
  timed-out still fail, and by leaving the ground-truth conjuncts intact.
- **Site 2 has no ground truth to fall back on.** Mitigated by making Arm B conditional on a cited
  downstream line and permitting "leave unchanged + explain" as a legitimate outcome.
- **WS-2 deletes a guard that a future producer was meant to feed.** Mitigated by the mandatory
  `git log -S` producer archaeology and AC-WDSUB-12, which can downgrade WS-2 to a comment fix.
- **WS-1 edits the worker Done-flip predicate.** The old R-PSRB hand-build reflex is RETIRED
  ([[feedback_never_hand_build_always_pipeline]]): the build executes the DEPLOYED beta.4 runtime,
  so source edits cannot affect the worker building them. Build via `/pickle-pipeline`.

## Build-time reminders

- Branch `release/v2.1-beta`, baseline `a17e9258`. This bundle stacks on 39 un-gated B-NONSTOP
  commits — the release gate at the end covers **both**.
- Launch with generous caps (`--szechuan-max-iterations 500 --anatomy-max-iterations 500`) per the
  B-NONSTOP precedent, so the phases are not strangled by the caps that bundle just raised.
- Do not bump the version mid-build; the closer/operator bumps to `2.1.0-beta.5` after the gate.
