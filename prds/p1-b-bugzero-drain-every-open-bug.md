# B-BUGZERO — drain every open bug

**Operator-set scope (2026-09-14): this bundle is every open bug and nothing else.** After it lands the
queue is enhancements only. Three roots, each re-measured at HEAD `5e81b78f` this pass — none inherited
from the ledger.

**Order: Z1 first.** It is the only open bug that can ship work that was never written.

---

## 🚨 ROOT Z1 — a recovery commit is accepted as proof of completion (R-ORSR-2, HIGH)

**Field observation (LOA-1763 B6b, order 610, "delete both FIRSTCOLONY gates"):** the ticket flipped
`status: Done` with `worker_gate_verdict: green` and **zero implementation committed**. The only
ticket-tagged commit was `fix(adb35445): commit-and-continue recovery (R-ORSR-2)` — a salvage commit,
not the edit. Both gates were still in `appraisal.processor.ts` (`grep '"FIRSTCOLONY"' src` = **2**,
the ticket's own AC demanded **0**). Ten worker-session logs, every handoff note saying *"Next focus:
real B6b impl"*. The worker never edited; the recovery commit was read as the work.

**Re-measured at HEAD.** `guardCompletionCommitBeforeDone` exists and `commitAndContinueDoneFlip` is one
of its callers, so a guard IS present. The gap is narrower and sharper than the row states:

- `acceptanceCriteriaCheckboxes` (`mux-runner.ts:3115`) reads the ticket's **checkbox STATE**
- the done action reason is `commit_and_acceptance_checked` (`:3087`)
- **nothing executes the assertion a checkbox describes**

So a ticket whose AC reads *"`grep '\"FIRSTCOLONY\"' src` returns 0"* flips Done when the box is ticked,
regardless of what the grep returns. **A ticked box is a claim; the grep is the measurement.** This is
the bundle's own recurring thesis applied to ticket completion.

### AC-Z1 (machine-checkable)
- Z1-1: when a ticket's acceptance criteria contain an EXECUTABLE assertion (a command, a grep, an
  expected exit code), the Done-flip RUNS it and refuses the flip when it fails — regardless of
  checkbox state.
- Z1-2: refusal is LOCAL. The ticket is parked and flagged, the disposition is named, and **the phase
  loop continues**. No halt, no abort condition. (PRIME DIRECTIVE: a gate may refuse a local action and
  must never stop the run.)
- Z1-3: a ticket whose criteria carry NO executable assertion behaves exactly as today. This must not
  become a blanket new gate on every ticket.
- Z1-4 (the field case, as a pinned regression): a ticket whose sole ticket-tagged commit is a
  `commit-and-continue recovery` commit AND whose grep AC is demonstrably false does NOT reach Done.
- Z1-5 (over-trigger control): a ticket with real work committed and a TRUE executable AC still flips
  Done on the first attempt. A fix that parks healthy tickets fails this AC.
- Z1-6 (mutation): make the executable AC pass; Z1-4 goes GREEN and Z1-5 stays GREEN. Remove the
  execution; Z1-4 goes RED.

**Non-goal:** do NOT attempt to execute prose criteria, or to infer a command from a sentence. Only
criteria that already carry an explicit runnable assertion are in scope. Inference is how this class of
bug is created, not fixed.

---

## 🏷 ROOT Z2 — an iteration failure is stamped with the baseline's name (GitHub #25, MEDIUM)

**Measured, session `2026-09-14-ec274d75`:**

```
12:18:39  LLM baseline metric: 3                    <- the baseline SUCCEEDED
12:30:01  ERROR: Metric measurement failed (baseline_unmeasurable_unrecoverable)
          after 4 attempt(s): judge output did not contain a numeric score
12:30:01  exit: baseline_unmeasurable_unrecoverable
```

`mapJudgeMeasurementFailure` is one shared mapper whose every non-timeout result is `baseline`-prefixed,
and it has exactly two call sites in DIFFERENT phases: `measureLlmBaseline` (`:4098`) and
`measureLlmIteration` (`:4445`). Sharing the mapper is correct — the failure kinds are identical.
**Naming the shared result after one of the two callers is what makes the label lie.**

**Consequence beyond one run:** every earlier run recorded under `baseline_unmeasurable_*`, B-MEGADRAIN
included, now carries a suspect attribution. The historical record cannot distinguish a real baseline
failure from an iteration failure wearing its name.

### AC-Z2 (machine-checkable)
- Z2-1: the shared reason is renamed to describe the FAILURE, not the caller
  (`metric_unmeasurable_unrecoverable` / `_transient`), and the PHASE (`baseline` | `iteration`) is
  recorded as a separate field.
- Z2-2 (control, baseline): a genuine baseline failure records phase `baseline`.
- Z2-3 (control, iteration): an iteration failure records phase `iteration` and does NOT borrow the
  baseline's name. The measured session above is the worked case.
- Z2-4 (legacy migration): a persisted `baseline_unmeasurable_unrecoverable` from an older run still
  reads and classifies identically. This touches the `ExitReason` schema — the migration is part of the
  ticket, not a follow-up.
- Z2-5: the DISPOSITION is unchanged in kind — still non-fatal, still routes to the finalize gate,
  still withholds success. This root renames a label; it must not move a wire.
- Z2-6 (mutation): restore the baseline-prefixed name on the iteration path; Z2-3 goes RED.

---

## 🔤 ROOT Z3 — the universal-quantifier gate cannot see a negative universal (MEDIUM-LOW)

`UNIVERSAL_QUANTIFIER_RE` (`spawn-refinement-team.ts:1626`):

```ts
const UNIVERSAL_QUANTIFIER_RE = /\b(?:all|every|for any|each)\b/i;
```

Probed at HEAD over five acceptance-criteria titles:

```
matched   All rules emit valid responses
matched   Every rule emits valid responses
MISSED    NO rule emits an invalid response
MISSED    A FAIL never renders below a PASS
MISSED    any handler that throws is retried
```

Three of five missed. `for any` is covered; bare `any` is not. **The missed shapes are the ones most
safety criteria take** — a safety property is usually stated as something that never happens.

Field cost (LOA-1763): five refinement rounds, the gate blocked all five, and six of nine
analyst-authored tickets failed the collapse check **while being more correct than the shape the gate
wanted**. The run proceeded only by overriding the gate with a documented reason.

**Half of this row is already fixed and is NOT in scope:** the derived-array rejection is gone —
`DESCRIBE_EACH_RE` now accepts an identifier, verified by running the real gate over three manifests.
Only the negative-universal half survives.

### AC-Z3 (machine-checkable)
- Z3-1: `no`, `never` and bare `any` are recognised as universal quantifiers. All five probe titles
  above are matched.
- Z3-2 (over-trigger control): the widening does not fire on ordinary prose that merely contains those
  words in a non-quantifying sense. Assert on a corpus of real criteria, not on invented strings.
- Z3-3: the existing four quantifiers still match unchanged; no currently-passing criterion starts
  failing.
- Z3-4: the gate's exit code for a real negative-universal criterion changes from blocking to passing,
  driven through the REAL `evaluateAcShapeEnforcement` / `runAcShapeEnforcement` path, not a unit stub.
- Z3-5 (mutation): revert the pattern; Z3-1 goes RED and Z3-3 stays GREEN.

---

## 🛡 PRIME DIRECTIVE compliance

Z1 adds a refusal that is explicitly LOCAL (Z1-2): park the ticket, name the disposition, continue the
phase loop. No new halt, no abort condition, no phase-loop break anywhere in this bundle.

Z2 renames a label and moves no wire (Z2-5). Z3 widens a pattern so a correct criterion stops being
blocked — it makes a gate less obstructive, not more.

Z1 and Z3 are both the same subtraction in spirit: stop treating a proxy as the measurement. A ticked
checkbox is not a passing grep; a missing keyword is not an absent quantifier.

## Non-goals

- Do NOT infer runnable commands from prose criteria (Z1 non-goal).
- Do NOT make Z1 a blanket gate on every ticket; Z1-3 fails such a diff.
- Do NOT change any disposition wire in Z2; it is a rename plus a recorded field.
- Do NOT re-open the derived-array half of Z3. It is fixed and verified.
- Do NOT add unrelated work. This bundle is the open-bug queue and nothing else, by operator scope.

## Simplification Review

Named subtractions: Z2 deletes a misleading name rather than documenting it; Z3 deletes a blind spot
from a pattern rather than adding a second pattern beside it.

Z1 is the one addition, and it is the smallest form of its kind: it executes assertions that ALREADY
EXIST in the ticket rather than introducing a new verification layer. The alternative — trusting a
checkbox — is the proxy-over-ground-truth shape this codebase has spent four releases removing.

**After this bundle the open-bug count is zero and the queue is enhancements only.** That is the
operator's stated reason for the scope, and it is the bundle's definition of done.
