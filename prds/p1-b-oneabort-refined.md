---
title: "B-ONEABORT — one termination policy across ALL channels [REFINED]"
priority: P1
finding: B-ONEABORT
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
build_mode: attended
source_assessment: "Refined 2026-08-06 by the 3-role x 3-cycle team (session 2026-08-06-c044bdc6), all_success=true. Two refinement passes; the AC-shape gate exited 2 on the first. Nine premises corrected; one blocking decision surfaced."
---

# B-ONEABORT *(refined)*

## 0. AUTHOR'S RETRACTION

I spot-verified every claim below at HEAD before adopting it. All held.

| # | My claim | Corrected finding |
|---|---|---|
| **R1** | **Two** termination channels; channel 2 is the unsubtracted one | **FIVE** sites can terminate a microverse phase, and **this bundle touched one**: HEAD-mismatch abort (`extension/src/bin/pipeline-runner.ts:4025`, fires *above* the phase-type gate) · classifier abort (`:4049`) ← the only one I found · red finalize gate (`:4092`, `:4127`, both `{action:'break'}`) · **AC-phase gate** (`:4303`) · cancel marker (`:4436`). The "two channels" frame was my search boundary, not the system's. |
| **R2** | ACs verified by `describe.each` over the union | **`describe.each` does not exist in `node:test`** — verified: `typeof test.describe.each === 'undefined'`. All 8 repo occurrences are quoted fixtures inside `refinement-ac-shape-gate.test.js`. Keep the `describe.each(` **token** (the shape gate greps for it) but implement as a runtime `for…of`, per `extension/tests/microverse-disposition-map.test.js:28-36`. |
| **R3** | "every member of `MICROVERSE_EXIT_REASONS` **except the state floor**" | **The exception selects nothing.** `session_state_corrupted` is in `MICROVERSE_FATAL_REASONS` (`extension/src/types/index.ts:1296-1300`) and **not** in `MICROVERSE_EXIT_REASONS` (`:1285-1293`). The clause is vacuous as written. |
| **R4** | Routing reasons to `run-finalize-gate-incomplete` is obviously safe | ⚠️ **See the blocking decision below.** That disposition runs `counters.completed++` (`:4122`), and `pipelineFailed = (completed + skipped) < phases.length` (`:3894`) drives the RED banner (`:3843`), `process.exit(1)` (`:3954`), and the **only** call site of `executeCloserReleasePlan` (`:3928`). |
| **R5** | "emits a named residual" is a sufficient AC | **Satisfiable by a MISNAMED residual.** The destination hardcodes one event — `pipeline_all_backends_exhausted_recovery_attempted` (`:4109`) — with **no `reason` field**, and log strings at `:4124`/`:4127`. It also collapses the `SKIP_FLAG_BUDGETS` ledger key (`extension/src/services/metrics-utils.ts:97`) for all five reasons into one. |
| **R6** | AC-OA-2b pins "no unattributed termination" | **Escapes mechanically.** It quantifies over the `MicroverseHaltDecision` return object, and the two surviving sites (`:4052`, `:4055`) **never construct one**. Re-quantify over termination **SITES**, not over the return type. |
| **R7** | `extension/tests/**` in a Files column | **Consumed as a literal, never glob-expanded** — and worse: `buildDeclaredFilesByTicket` (`:927`) feeds `quarantineCrashedTicketFilesOrFatal` (`:826`) with `Set.has()` exact equality, so on an **unscoped** launch a crashed ticket's test-file dirt classifies `unowned_quarantine` (`:820`), is left in place, and `assertCleanWorkingTree` (`:3260`) **FATALs**. Declare concrete test paths. |
| **R8** | AC-OA-2a's two arms are the unattributed aborts to fix | **Both are unreachable from the sole production caller under default settings** — `isFatalPhaseFailure` (`:2824`) guards `typeof reason === 'string'`; reachable only when `pipeline_continue_on_phase_fail === false`. The **reachable** unattributed abort is `logPhaseHaltReason`'s catch at `:4050-4052`: *"Phase X failed (exit N) — stopping pipeline"*, no reason. |
| **R9** | — *(not claimed; found by refinement)* | The **AC-phase gate** (`:4303`, *"Phase X AC gate failed — stopping pipeline"*) has **zero test coverage repo-wide** — verified — and is fail-open today only because nothing in-repo writes `ac-phase-manifest.json`. A latent halt with no pin. |

**On the AC-shape gate.** My first draft enumerated its subjects; the gate exited 2 with 7 smells and
refused. It was right — an AC hardcoding five members of a set goes stale the moment a sixth appears,
which is the exact drift this bundle removes. **A caution for the next reader:** the smells' `headline`
field is *carried forward verbatim from earlier cycles* and quotes text that no longer exists in the
PRD. I nearly dismissed the second pass as fabrication on that basis. **The `evidence` array is the
current content** — R2 through R7 all arrived as appended evidence lines under a stale headline.

---

## ⛔ BLOCKING — one variable decides whether this bundle manufactures green

**Does a degraded phase increment `counters.completed`?** The PRD never ruled on it, and everything
operator-visible hangs on it:

```
run-finalize-gate-incomplete  →  counters.completed++            (:4122)
pipelineFailed = (completed + skipped) < phases.length           (:3894)
   → RED banner (:3843) · process.exit(1) (:3954)
   → the ONLY call site of executeCloserReleasePlan (:3928)
```

If routing four-plus reasons onto that wire increments `completed`, a run where **every phase
degraded** reports **success**, exits 0, and **triggers the closer release plan.** That is not
reliability; it is fake-green with a nicer log line — and the whole session's evidence says the
measurement layer is exactly where we keep deceiving ourselves.

| Option | Consequence |
|---|---|
| **(a) Degraded counts as completed** | Pipeline exits 0 and may auto-release a run in which nothing converged. **Rejected on sight** unless someone can argue it. |
| **(b) ⭐ Degraded runs the gate, finishes the pipeline, but does NOT count as completed** | All phases execute; the run reports honestly (`pipelineFailed` true, named residual per phase); no auto-release. **"Ran to completion" and "reported success" stay different facts.** |
| **(c) Split the counter** | Add `counters.degraded` so the banner can say *4/4 ran, 2 degraded*. Strictly better reporting, but it is **new state** — weigh against directive 4. |

### ✅ OPERATOR DECISION 2026-08-06 — option (b)

> *"b seems like the best option because it keeps the system running. The first ratchet is always
> reliability/autonomy, then we ratchet up quality."*

**Binding.** A degraded phase **runs its finalize-gate and the pipeline continues to its next phase**,
and it **does not contribute to a success verdict**. Stated as an outcome invariant so the
implementation is free to choose the mechanism:

> **If any phase degraded, the pipeline's success verdict is false.** All phases still execute; the run
> reports honestly; `executeCloserReleasePlan` does not fire on a degraded run.

⚠️ **Implementation caution (from R4):** `run-finalize-gate-incomplete` already carries
`baseline_unmeasurable_transient`, `all_judge_backends_exhausted`, and the non-convergent Template-A
reasons. Changing its counter behaviour wholesale changes those existing paths too — decide that
deliberately in the plan artifact and pin whichever way it lands. Do NOT discover it at the closer.

Option **(c)** (`counters.degraded`) remains a stretch only if it costs no new state; directive 4 governs.

**Superseded recommendation retained for provenance:** (b), with (c) as a stretch only if it costs no new mechanism. Directive 2 says a
gate may never stop the pipeline; it does **not** say a degraded run must claim success. This is the
same distinction B-NOSTOP-GATES drew: *honesty is a REPORTING property, halting is a DISPOSITION.*

---

## Amendments carried into the workstreams

- **Scope honestly.** The bundle fixes the **classifier abort** (`:4049`) and the **reachable
  unattributed abort** (`:4050-4052`). The other three sites (HEAD-mismatch, red finalize gate,
  AC-phase gate, cancel marker) are **named and left**, with the AC-phase gate's zero coverage filed as
  a follow-up. ⛔ Do not silently widen — R1 is the reason this bundle exists.
- **AC-OA-1a is withdrawn as written** ("exactly one code path can terminate") — false by count. Replaced
  with: *no reason in the exported union resolves to `abort` at the classifier site.*
- **Quantify over SITES, not return types** (R6) for the no-unattributed-termination invariant.
- **Residual must carry the reason** (R5) — a distinct `reason` field, so five reasons yield five ledger
  keys, not one.
- **`describe.each` token, `for…of` implementation** (R2).
- **Concrete test paths in every Files column** (R7) — no `**` globs.
- **Drop the vacuous exception clause** (R3); the floor lives in a different union and must be named
  explicitly if it is to be excepted at all.

## Unchanged

The core thesis — collapse termination policy to one predicate, pin it with ONE invariant that
enumerates from the exported unions rather than a hand-copied list — stands, and R1 strengthens it: with
five sites, a per-site matrix is even more clearly the wrong shape. §5's Simplification Review, the
net-negative-LOC pin, and the ATTENDED build mode all stand.
