---
title: "B-ONEABORT — two termination channels, one subtraction: reduce the pipeline to a single abort condition"
priority: P1
finding: B-ONEABORT
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
build_mode: attended
supersedes_findings: [R-JUNS]
source_assessment: "Authored 2026-08-06 from the B-OFFREPO run (session 2026-08-04-183319b4) that aborted at 590m. Every citation grep-verified at HEAD with matching content."
---

# B-ONEABORT — the halt subtraction was applied to one of two channels

**Operator directive, 2026-08-06:** *"our reliability goes to zero every time a pipeline stops… we
really should have almost zero abort conditions."*

## 0. Pre-launch checks

- **Green-tree precondition** — `cd extension && npm run test:fast` on the launch commit, **on a quiet
  box**. A second pipeline (`2026-08-05-db2c6665`, working dir `loanlight-api`) was live at authoring
  time; overlapping runs produce timing-shaped flakes (a `withLock` 10ms-margin assertion already
  false-failed once this session). Re-run at rest before believing a red.
- **Stale-premise check — LIVE.** All ten cited lines verified at HEAD with matching source content.
- **Build mode: ATTENDED** — edits the phase-termination path.

## 1. The diagnosis: two channels, one subtraction

A pipeline can terminate through **two independent paths**. [[B-NOSTOP-GATES]] subtracted halts from
exactly one of them.

| Channel | Path | State |
|---|---|---|
| **1 — pickle phase loop** | `shouldHaltAfterPhase` → `dispatchHaltAction` (`extension/src/bin/pipeline-runner.ts:4131`) | ✅ subtracted by B-NOSTOP-GATES, and it **works** |
| **2 — microverse phases** (anatomy-park, szechuan-sauce) | `classifyMicroverseHaltDecision` (`:4315`) → `{action:'abort'}` → `:4049` | ❌ **never enumerated, never subtracted** |

Channel 1 is demonstrably healthy — the same run logged `non-fatal pickle exit, commits present` and
`citadel: remediation cap (3) exhausted with 17 finding(s) still open — continuing pipeline (no halt)`.
Three opportunities to stop; it took none.

Channel 2 killed the run: `Phase szechuan-sauce: microverse exited with
baseline_unmeasurable_unrecoverable — pipeline aborting (no finalize-gate)` /
`Pipeline finished: 2/4 phases, 590m 40s`.

### Why channel 2 drifted — the invariant is scoped to channel 1

```js
describe('AC-NSG-5b — ONE RULE: quality-verdict exit_reasons never halt pickle', …
  assert.equal(shouldHaltAfterPhase('pickle', …), false)
```
`extension/tests/nostop-gates-invariant.test.js:221`

`grep -c "microverse\|MICROVERSE_FATAL\|baseline_unmeasurable"` on that file returns **0**. The
invariant built to make the subtraction permanent pins only the channel that was already fixed. **An
unpinned channel drifts, and this one did.**

There is precedent *inside channel 2 itself*: a prior fix (`B-NS / B-APNC WS-1`, AC-NS-4) already
rescued `limit_reached`, `no_progress`, `stopped`, and `approach_exhaustion` from this same abort,
recording that the literal chain had **"silently desynchronized from the map."** Same defect, one layer
up — and it will recur until the invariant covers the channel rather than the symptom.

## 2. What channel 2 aborts on today

From `classifyMicroverseHaltDecision` (`:4315`):

| Abort trigger | Site | Genuine crash floor? |
|---|---|---|
| non-string `exit_reason` | `:4319` — **unattributed** | ❌ absent ≠ corrupt |
| `judge_cli_missing` | `:4340` via `MICROVERSE_FATAL_REASONS` | ❌ the *phase* is inert, the run is not unsafe |
| `session_state_corrupted` | `:4340` | ✅ **the only one** |
| `baseline_unmeasurable_unrecoverable` | `:4340` | ❌ measurement failure ([[R-JUNS]]) |
| `error` | `:4340` via `MICROVERSE_FAILURE_REASONS` (`extension/src/types/index.ts:1304`) | ❌ generic |
| `rate_limit_exhausted` | `:4340` | ❌ **we built a park for this** (B-RRH) |
| `judge_unreachable` | `:4340` | ❌ transient/external |
| fallthrough | `:4345` — **unattributed** | ❌ |

**Eight triggers. One is a genuine floor.** Two abort without naming a reason at all, which is the worst
available shape — the run ends and nothing says why.

## 3. The target — exactly ONE abort condition

> **A pipeline may terminate only when it cannot safely read or write its own state.**

Everything else ends the **phase** honestly and lets the pipeline reach its finalize-gate. That includes
a missing judge CLI: a review phase that cannot run is an *inert phase*, not an unsafe run.

**This is REUSE, not new machinery.** `run-finalize-gate-incomplete` already exists, already means
exactly this, and is already the disposition for `baseline_unmeasurable_transient`,
`all_judge_backends_exhausted`, and every non-convergent Template-A reason. Four-plus reasons simply
aren't wired to the honest wire that is already there.

⛔ **Do NOT build a halt-classification table.** Directive 4 is explicit that *"a halt-classification
table would BE the treadmill,"* and B-NOSTOP-GATES deliberately chose ONE invariant over a per-site
matrix. The shape here is **one predicate + one invariant**, consumed by both channels — two policies
collapsing into one, not a new matrix.

## 4. Workstreams

### WS-ONEABORT-1 — one predicate, consumed by both channels

Introduce a single termination predicate that answers *"may this reason stop the pipeline?"* and route
**both** `dispatchHaltAction` and `classifyMicroverseHaltDecision` through it. Channel 1 keeps its
existing sanctioned crash-floor set; channel 2's set collapses to the state floor. The point is that the
question is answered in **one place**.

- **AC-OA-1a**: exactly one code path can terminate the pipeline for a microverse phase, and it fires
  only on the state floor. — Verify: `cd extension && npm run test:fast` with a `describe.each` over all
  `MICROVERSE_EXIT_REASONS`; every reason except the state floor yields a non-abort action — Type: test
- **AC-OA-1b** *(invariant — universally quantified, NOT an enumeration)*: **for every** member of the
  exported `MICROVERSE_EXIT_REASONS` union **except** the single state floor, the resolved action is
  `run-finalize-gate-incomplete` **and** a named residual is emitted. The test derives its subject list
  **from the exported union at runtime**, never from a hand-copied list — so adding a reason to the union
  without giving it behaviour makes the suite red. — Verify: `cd extension && npm run test:fast` —
  Type: test
- **AC-OA-1c**: no new classification table is introduced; the diff adds no new literal array or map of
  exit reasons beyond the existing ones, and net LOC across `pipeline-runner.ts` + `types/index.ts` is
  **negative**. — Verify: `git diff --stat` + inspection — Type: llm-conformance

### WS-ONEABORT-2 — no unattributed termination

Both `:4319` (non-string `exit_reason`) and `:4345` (fallthrough) abort with
`recognizedExitReason: null`. An absent field is not proof state is corrupt.

- **AC-OA-2a** *(invariant — universally quantified)*: **for any** `exit_reason` value that is not a
  recognized member of the exported union — of **any** type, including `undefined`, `null`, non-strings,
  and unrecognized strings — the resolved action is **not** `abort` and carries a non-empty reason.
  Expressed as one property over arbitrary input, not a list of sampled values. — Verify:
  `cd extension && npm run test:fast` — Type: test
- **AC-OA-2b**: **no pipeline termination is ever unattributed** — every terminating path logs a
  non-empty reason. — Verify: `cd extension && npm run test:fast` asserts no reachable abort carries
  `recognizedExitReason: null` — Type: test

### WS-ONEABORT-3 — widen the invariant to both channels (**the durability half**)

Without this the next channel drifts identically. Parameterize AC-NSG-5b over the termination function
instead of pinning `shouldHaltAfterPhase('pickle', …)`.

- **AC-OA-3a**: the invariant runs against **both** channel-1 and channel-2 termination and fails if
  either admits a non-floor reason. — Verify: `cd extension && npm run test:fast` — Type: test
- **AC-OA-3b**: the invariant is **exhaustive by construction** — it enumerates from the exported
  `MICROVERSE_EXIT_REASONS` / exit-reason unions rather than a hand-copied list, so a newly added reason
  is covered without editing the test. — Verify: adding a synthetic reason to the union makes the suite
  red without touching the test file — Type: test
- **AC-OA-3c**: `grep -c "microverse" extension/tests/nostop-gates-invariant.test.js` is **> 0** (the
  literal gap this bundle closes). — Verify: shell — Type: test

### WS-ONEABORT-4 — verification that runs the claim

- **AC-OA-4a** *(invariant — universally quantified)*: a run or harness drives a microverse phase to
  **every** non-floor member of the exported union and records, per reason, that the pipeline **reached
  its finalize-gate** — `prds/research/oneabort-termination-matrix.json`, entries of
  `{reason, action, pipeline_reached_finalize: bool, residual_logged: bool}`. The assertion derives its
  **expected key set from the exported union at runtime**, so a union member missing from the matrix is
  a FAILURE, not a silent gap; and **any** record with `action: "abort"` outside the state floor fails.
  — Verify: `cd extension && npm run test:fast` parses and asserts it — Type: test
- **AC-OA-4b**: `cd extension && npm run test:integration` is measured and its result recorded. ⚠️ Per
  [[R-ISSC]], `test:integration` is `parallel && serial` and short-circuits — **measure both sub-tiers
  separately** and record both, or the serial half is invisible. — Type: test

## 4.5 Authoring retraction — the AC-shape gate caught the bug inside the fix

The first draft of AC-OA-1b, AC-OA-2a and AC-OA-4a **enumerated** their subjects: five named exit
reasons, two named arms, "each non-floor reason." `spawn-refinement-team.js` exited **2** with 7
`ac_shape_smells` and refused to proceed.

It was right, and the reason matters more than the fix: **an AC that hardcodes five members of a set
goes stale the moment a sixth is added — which is precisely the drift this bundle exists to remove.**
AC-NSG-5b failed exactly that way (a hand-copied list that never grew to cover channel 2), and the first
draft would have reproduced it inside the acceptance criteria of the fix for it.

All three are now universally quantified and **derive their subject list from the exported union at
runtime**, so a newly added reason without behaviour reddens the suite instead of escaping it. That is
the same property AC-OA-3b demands of the invariant; it now holds across the whole PRD.

## 5. Simplification Review

1. **Necessary?** WS-1 removes reasons from an abort set and routes them to an existing wire. WS-2
   deletes two unattributed abort arms. WS-3 widens an existing test's scope. WS-4 adds no production
   code. **Net-negative LOC is the expected shape and is pinned by AC-OA-1c.**
2. **REUSE not ADD?** Entirely reuse: `run-finalize-gate-incomplete` already exists and is already the
   honest disposition for the transient/non-convergent reasons. This bundle moves four-plus reasons onto
   a wire that already carries their siblings.
3. **Guards brittle complexity that should be SUBTRACTED?** Yes — **two parallel termination policies**
   are the brittle thing. One was subtracted and pinned; the other drifted because nothing pinned it.
   Collapsing to one predicate + one invariant removes the divergence *class*, not this instance of it.
4. **SUBTRACTS:** seven of eight microverse abort triggers, two unattributed abort arms, and one of the
   two termination policies. [[R-JUNS]] is **absorbed** — it becomes one member of the set rather than
   its own fix.

## 6. Risks

- **R1 — a genuinely unsafe run continues.** Bounded by keeping the state floor: if state cannot be read
  or written, the pipeline still aborts. Everything else is a phase that could not do its job, which is
  a reporting fact, not a safety fact.
- **R2 — silent degradation.** If phases stop aborting, a broken judge could go unnoticed. Mitigated by
  AC-OA-1b's **named residual** requirement — the reason must be logged, and `SKIP_FLAG_BUDGETS`
  (`extension/src/services/metrics-utils.ts:96`) already treats an accumulating skip reason as a
  removal candidate rather than a budget to raise.
- **R3 — scope creep into channel 1.** Channel 1's sanctioned set is out of scope; this bundle only
  routes it through the shared predicate. Do not renegotiate its members here.
- **R4 — the table temptation.** AC-OA-1c exists because "collapse two policies" reads to an
  implementer like "write a mapping table." It is not. One predicate.

## 7. Implementation Task Breakdown

| Order | Title | Tier | Files |
|---|---|---|---|
| 10 | WS-1: one termination predicate; collapse channel 2's abort set to the state floor | large | `extension/src/bin/pipeline-runner.ts`, `extension/bin/pipeline-runner.js`, `extension/src/types/index.ts`, `extension/types/index.js`, `extension/tests/**` |
| 20 | WS-2: no unattributed termination — both `null`-reason arms continue and flag | medium | `extension/src/bin/pipeline-runner.ts`, `extension/bin/pipeline-runner.js`, `extension/tests/**` |
| 30 | WS-3: widen AC-NSG-5b to both channels, exhaustive from the exported unions | large | `extension/tests/nostop-gates-invariant.test.js` |
| 40 | WS-4: termination matrix — record that each non-floor reason reaches the finalize-gate | medium | `prds/research/oneabort-termination-matrix.json`, `extension/tests/**` |

> **Scope note:** tickets 10/20 include the **compiled mirrors** (`extension/bin/*.js`,
> `extension/types/*.js`). Tests import the mirror; a src-only commit is `outside_scope` at the fence
> and leaves the gate measuring pre-fix code.
