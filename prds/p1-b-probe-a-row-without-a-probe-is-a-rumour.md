# B-PROBE — a ledger row without a probe is a rumour

**One thesis, four roots.** This plan's open-bug rows rot green, and the rot rate is now measured far
above the documented estimate. Three releases in three days closed defects faster than the ledger
recorded them, so a row's `OPEN` label means only that nobody has re-read it.

**Measured 2026-09-14, sweeping six rows at HEAD `8522d979`:**

| row | verdict | mechanism |
|---|---|---|
| B-LINTGATE | **STALE** | `max-warnings=0` in both gate files; `eslint src/ --max-warnings=0` rc **0** |
| B-OFFREPO | **STALE** | the `extension/` path literal is a repo-shape DISCRIMINATOR routing to `runOffRepoWorkerGate` |
| R-ACNP | **STALE** | producer exists — `acceptanceCriteriaState()`; `absent` routes to `leave`, not `skip` |
| B-ONEABORT | **STALE** | `MICROVERSE_FATAL_REASONS` has **exactly one** member, its stated target |
| describe.each | probably stale | a sanctioned `describeEach` helper now exists |
| R-ORSR-2 | probably stale | `guardCompletionCommitBeforeDone` reads and honours the verdict |

**Four of six definitively stale; the documented rate was one in three.** The cost is not bookkeeping:
each of these was a candidate for scoping into a bundle, and two of them nearly were.

**Order: N1 first** — it is the root that stops this recurring; everything else is one-time debt.

---

## 🔍 ROOT N1 — every open row must carry a runnable probe

**The mechanism check that catches a stale row is always the same shape:** a grep, a predicate, a
command whose output distinguishes "still broken" from "already fixed". Today that probe lives in a
human's head and is re-derived on each sweep, which is why sweeps are rare and rows rot between them.

**B-OFFREPO is the case that proves prose is not enough.** Its row named
`path.join(args.workingDir, 'extension')` as the defect. That literal is STILL THERE at HEAD. Reading
the row and grepping the literal both say OPEN. Only reading the BRANCH shows it is now a discriminator
routing to the off-repo gate. **A probe must assert the behaviour, not the presence of a string.**

### AC-N1 (machine-checkable)
- N1-1: every `OPEN BUG` / `TOP ITEM` section in `prds/MASTER_PLAN.md` carries a fenced, runnable
  `PROBE:` block and an expected verdict (`OPEN` when the defect is live).
- N1-2: an audit RUNS each probe and FAILS when a row marked open produces the fixed verdict. A row that
  has silently been fixed reds the gate instead of waiting for a sweep.
- N1-3: a row with no probe FAILS the audit. Absence is not compliance.
- N1-4 (over-trigger control): rows already marked `✅ RESOLVED` are not probed and do not fail.
- N1-5: the audit is wired into the release gate and the workflow, and the parity test passes.
- N1-6 (mutation): mark a resolved row `OPEN BUG` again → N1-2 RED; delete a probe → N1-3 RED.

**Non-goal:** do NOT try to auto-derive probes for the existing rows from their prose. Write them by
hand for the rows that survive N4's sweep, and let N1-3 force the rest to be written or struck.

---

## 🔢 ROOT N2 — the partial-progress parser reads the wrong number (GitHub #24)

R4 recovers a ledger entry's size from the judge's description prose and keeps the **largest** match.
That is right when the other number is a ceiling (smaller) and wrong when it is the previous size
(larger) — which is how anything that just shrank gets described.

Measured over the shipped regex and `Math.max` rule:

```
ok    want=2202 got=2202  original shape
ok    want= 894 got= 894  ceiling quoted alongside
MISS  want= 894 got=1690  "runMuxRunnerMain is 894 lines, was 1690 lines before extraction"
MISS  want=  80 got= 200  "extracted 3 helpers from a 200-line function; now 80 lines"
ok    want= 130 got= 130  violation over ceiling
```

**The two cases cannot share one rule:** a ceiling is smaller than the size, a previous size is larger.
No max or min over unlabelled integers separates them. The parser is recovering structure that was
discarded when the number was written into prose.

It fails **closed** — it under-reports progress and stalls rather than fabricating convergence — but it
fires exactly when a worker is doing the extraction work partial-progress credit exists to recognise.

### AC-N2 (machine-checkable)
- N2-1: the entry's measured size is carried as a STRUCTURED field on the ledger entry, written when the
  entry is created. The number is never re-derived from a sentence.
- N2-2 (control, ceiling): a description quoting a ceiling still yields the entry's own size.
- N2-3 (control, history): a description quoting a previous size now yields the CURRENT size. Both MISS
  cases above become `ok`.
- N2-4: a legacy entry carrying no structured field degrades to today's behaviour rather than erroring.
- N2-5: the in-source comment justifying `Math.max` is corrected — it currently reasons over half the
  case space.
- N2-6 (mutation): restore prose-derived sizing → N2-3 RED, N2-2 GREEN.

---

## 🪓 ROOT N3 — halve the loop again, against the armed ratchet

`runMuxRunnerMain` is **892 code lines, complexity 173**, recorded in its marker and enforced by
`audit-recorded-ceilings.sh`. Ceilings are 120 and 15. beta.28 took it from 1690/366; this takes the
next step.

Same discipline as before, and it is the discipline that made the last one safe: extract along named
seams, behaviour-preserving only, every helper independently under the ceilings with no disable, and
update the recorded figures so the ratchet re-arms at the new floor.

### AC-N3 (machine-checkable)
- N3-1: `runMuxRunnerMain` measures **≤450 code lines and complexity ≤90**.
- N3-2: recorded figures updated; `audit-recorded-ceilings.sh` passes against them.
- N3-3 (behaviour): STRUCTURAL ONLY. No exit reason, disposition, activity event, ordering or state
  write may differ. Full fast and integration tiers pass unchanged.
- N3-4: every extracted helper is itself under 120/15 and carries NO disable.
- N3-5 (mutation): a behavioural mutation inside any extracted helper must red an existing suite. If an
  extraction is covered by nothing, SAY SO in the ticket rather than claiming it is safe.

**Non-goal:** do NOT change any decision the loop makes. File defects found; fix them in their own
ticket.

---

## 🧹 ROOT N4 — finish the sweep and strike what is dead

Two rows are *probably* stale and were not measured to a verdict: `describe.each` and `R-ORSR-2`. Both
are `capture-only`, which is how they have survived three sweeps without anyone resolving them.

### AC-N4 (machine-checkable)
- N4-1: each remaining `OPEN BUG` row is measured to a DEFINITE verdict — live or struck — with the
  mechanism cited, never the R-code.
- N4-2: every row that survives gains an N1 probe. Every row that does not is struck with its evidence.
- N4-3: the plan's open-row count is stated and matches the number of probed rows.
- N4-4: no row is struck on the presence or absence of a STRING alone. B-OFFREPO is the worked example:
  its named literal is still in the source and the row is still stale.

---

## 🛡 PRIME DIRECTIVE compliance

N1 adds an audit — a gate that refuses a COMMIT, never a run. Nothing here adds a halt or a phase-loop
break. N3 is the brittleness clause applied directly, continuing a ratchet that is already armed.

N1 and N2 are both the enumerated-liability fix: a hand-maintained claim (a prose row, a prose number)
replaced by something mechanically checked. N2 in particular deletes a heuristic rather than adding a
smarter one — the fix is to stop parsing prose, not to parse it better.

## Non-goals

- Do NOT auto-derive probes from row prose (N1 non-goal).
- Do NOT change any decision the loop makes (N3 non-goal).
- Do NOT aim `runMuxRunnerMain` at 120 in this bundle; the ratchet finishes it.
- Do NOT strike a row on a string match alone (N4-4).
- Do NOT make the partial-progress term fabricate progress; N2 must stay fail-closed.

## Simplification Review

Named subtractions: a prose-parsing heuristic deleted in favour of a structured field (N2); roughly 442
code lines and 83 complexity removed from the loop (N3); dead rows removed from the plan (N4).

N1 adds an audit, and it is the one addition. It buys the deletion of a recurring manual sweep whose
absence just produced a 4-in-6 stale rate — and it converts "someone should re-check the ledger" from a
discipline into a gate.
