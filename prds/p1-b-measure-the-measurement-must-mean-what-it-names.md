# B-MEASURE — a measurement must measure what it names, carry the evidence it computed, and not be silenced

**One thesis, five roots.** Every item below was measured at HEAD `3c4c0e4b` on `release/v2.1-beta`
between 2026-09-13 09:45Z and 12:00Z, from the v2.1.0-beta.26 run's own artifacts. None is inherited
from the ledger.

**Why now.** beta.26 shipped the verdict layer's *disposition* defects (B-RELVERD: derive, never latch;
continue, never break). This bundle is the other half of the same problem: the verdicts and metrics that
layer consumes are themselves unreliable — one throws away its evidence, one is scored on two different
wires, one is silenced outright, one measures a unit nothing enforces, and one will not say how it
decided.

**Composition.** Two source files carry four of five roots (`bin/mux-runner.ts`,
`bin/microverse-runner.ts`), plus `eslint.config.js` and the audit scripts. One review rotation.

**Order: M3 first.** It is the only root that makes a currently-invisible defect visible, and M4's
negative control depends on knowing the enforced ceiling.

---

## 🔇 ROOT M3 — two rule-less eslint disables hide complexity 366 from a `--max-warnings=0` gate (GitHub #21)

Census of `src/`: **49** eslint-disable comments, **47** name an explicit rule, **2** name none. A
rule-less disable silences every rule on that line, including rules that do not exist yet.

Neutralising only those two comments and re-running the project's own config, unchanged otherwise:

```
2171:8   error  Function 'correctPhantomDoneTickets' has a complexity of 16. Maximum allowed is 15
12911:1  error  Async function 'runMuxRunnerMain' has too many lines (1690). Maximum allowed is 120
12911:1  error  Async function 'runMuxRunnerMain' has a complexity of 366. Maximum allowed is 15
```

Source restored byte-identical after the probe. `runMuxRunnerMain` is the iteration loop that decides
ticket lifecycle, salvage and Done-flips: complexity 366 in the function most responsible for whether a
run reports the truth.

**This is #18's shape one level over.** beta.26 fixed a flag that disabled the check it appeared to
tighten. This is a comment that does the same thing, and it is invisible to the flag fix.

### AC-M3 (machine-checkable)
- M3-1: neither remaining disable is rule-less. Each names exactly the rules it trades away, so the gate
  reports what is suppressed.
- M3-2: an audit or lint rule FAILS on any `eslint-disable` carrying no rule list. Adding a fresh
  rule-less disable reds the gate.
- M3-3 (over-trigger control): all 47 existing scoped disables still pass, untouched. A diff that
  rewrites them fails this AC.
- M3-4: the three suppressed findings are RECORDED — in the trap-door catalog or an explicit ceiling —
  so they are tracked rather than re-hidden under a scoped disable.
- M3-5 (mutation): restore a rule-less disable; M3-2 goes RED and M3-3 stays GREEN.

**NON-GOAL, stated so no worker attempts it:** do **not** decompose `runMuxRunnerMain` in this bundle. A
1690-line, complexity-366 refactor of the salvage and Done-flip path is not a side effect of making it
visible. Make it visible, record the number, and let a later bundle ratchet it down against a ceiling
that only exists because M3 landed.

---

## 📏 ROOT M4 — the szechuan judge measures span against a limit nothing enforces (GitHub #22)

Three limits are in circulation: root `CLAUDE.md` prose says **50**, `eslint.config.js` enforces **120**
code lines with `skipBlankLines` + `skipComments` (200 for two files), and the judge cites "50-line hard
limit" while measuring **span**.

AST measurement of the last run's ledger, code lines against span:

| function | judge said | span | **code** | over the enforced 120? |
|---|---|---|---|---|
| `runMuxRunnerMain` | ~2202, high | 2202 | **1690** | yes |
| `buildCitadelAuditReport` | ~122, med | 122 | **119** | no, one under |
| `checkPartialLifecycleExit` | ~68, low | 68 | **46** | no |
| `reapOrphanedManagersAtIterationStart` | ~64, low | 64 | **49** | no |
| `bootstrapSessionResources` | ~61, low | 61 | **47** | no |

**Three of six ledger entries are false** — each is under 50 code lines, filed for violating a 50-line
limit. The metric is the ledger count, so the score was inflated 6 against a true count of 1, the worker
was pointed at three refactors that are not violations, and the one real finding was buried.

### AC-M4 (machine-checkable)
- M4-1: the judge is given the ENFORCED ceiling (120, with the two 200-line exceptions named), not a
  prose number.
- M4-2: the judge counts CODE lines, matching `skipBlankLines` + `skipComments`. Replaying the five
  functions above yields exactly ONE violation, not five.
- M4-3 (negative control): `runMuxRunnerMain` at 1690 code lines is STILL filed. Tightening the
  measurement must not silence the real finding.
- M4-4: root `CLAUDE.md`'s 50-line prose either matches the enforced number or cites it. A grep for a
  function-size limit returns one number, not three.
- M4-5 (mutation): restore span counting; M4-2 goes RED and M4-3 stays GREEN.

---

## 🗑 ROOT M1 — the post-final verdict discards the diagnostic it already computed (GitHub #19)

`post_final_tier_degraded` withheld the beta.26 bundle's success verdict, recording only:

```json
{ "state": "red", "degraded": true, "dimensions": ["script failure: test:fast:serial"] }
```

**The red does not reproduce.** `test:fast:serial` at HEAD is 403 tests / 401 pass / **0 fail** / exit 0;
the full 19-leg gate is green; the flake budget is `failures=0 runs 5/5 tests=9844`. The only test-file
delta since that run is in the PARALLEL half, so nothing that landed explains a serial red.

What it WAS cannot be recovered. `mux-runner.ts:1096` does `gate.failures.map(f => f.name)`, dropping
`f.message` — the tail `buildScriptFailureMessage(lines)` had already built at `:770`.
`persistPostFinalVerdict` then stores only `{state, degraded, dimensions}`.

**This is root V3's defect one function over.** V3 shipped in beta.26 and stopped the remediator
truncating a test diagnostic; the identical loss survives here.

### AC-M1 (machine-checkable)
- M1-1: a `script_failure: true` entry's `message` reaches the persisted verdict. Given a gate that dies
  in `pretest:fast`, the record names the failing script AND carries its diagnostic tail.
- M1-2: `dimensions` keeps its current shape as a stable parseable attribution. The tail goes somewhere
  of its own, not concatenated into a free-text blob.
- M1-3 (negative control): a red gate that DID parse real test names still names them, and is not
  replaced by a tail.
- M1-4: the verdict reader stays fail-closed — an absent, unreadable or malformed record still yields no
  withholding.
- M1-5 (mutation): restore the name-only map; M1-1 goes RED and M1-3 stays GREEN.

**Hypothesis, NOT measured, do not build on it:** whether the post-final tier should run against a
quiescent tree at all, given `pretest:fast`'s audits read a tree workers may still be editing. Needs its
own measurement.

---

## ⚖️ ROOT M2 — baseline and iterations score the same judge answer on two different wires (GitHub #20)

The iteration path overrides the judge's self-reported score with the ledger count
(`microverse-runner.ts:4566`), carrying a comment on why the self-report is untrustworthy:
*"never the judge's self-reported integer ... One array, one number derived from it, one wire."*

`measureLlmBaseline` takes `baseline.score` as-is. Grepping that whole function for `shape`,
`violations.length`, `parseLlmJudgeOutput` or `updateViolationLedger` returns **0 matches**. The fix
landed on the iteration wire and not the baseline wire.

Observed on the beta.26 run:

```
03:58:57  LLM baseline metric: 2
04:07:10  Metric: 6 (raw: {"score": 6, "violations":[6], "resolved":[], "new":[6 ids], "remaining":[]})
04:07:10  Classification: regressed (previous=2, tolerance=0)
04:09:31  stalled_below_target (stall limit reached with no new commits)
```

`resolved: []`, `remaining: []`, all six `new`. **Nothing regressed** — the baseline had simply never
built a ledger for anything to carry over from. This is the second defect reported in GitHub #7, which
was closed on verification of the first half only.

### AC-M2 (machine-checkable)
- M2-1: a full-shape baseline judge answer is scored by `violations.length`, the same wire as iterations.
- M2-2: it SEEDS `state.violation_ledger`, so iteration 2 classifies on `set_ops`, not `numeric`.
- M2-3 (back-compat): a legacy bare-integer baseline answer still works, still scores its integer.
- M2-4 (negative control): a genuine regression between baseline and iteration 2 is still reported as
  one. The fix must not make regressions unreportable.
- M2-5 (mutation): restore the as-is baseline score; M2-2 goes RED and M2-3 stays GREEN.

---

## 🏷 ROOT M5 — the one comparison basis that will not name itself is the one that misfired

`formatMetricComparisonFigures` names its basis in two arms and not the third:

```ts
case 'set_ops':      return `basis=set_ops, resolved=..., new=..., remaining=...`;
case 'ledger_count': return `basis=ledger_count, violations=..., previous=...`;
case 'numeric':      return `previous=${figures.previous}, tolerance=${figures.tolerance}`;
```

B-VERDICT (beta.18) shipped "the named deciding basis" precisely so an operator could tell how a
classification was reached. It landed on two of three arms. The unnamed arm is the one that produced
`Classification: regressed (previous=2, tolerance=0)` in M2 above — so the log could not say that the
comparison had silently fallen back to numeric.

### AC-M5 (machine-checkable)
- M5-1: the numeric arm emits `basis=numeric` alongside its figures.
- M5-2: a test enumerates ALL members of the basis union and asserts each output begins with `basis=`,
  so a fourth basis cannot be added unnamed.
- M5-3: the two existing arms' output is UNCHANGED. Log-shape consumers keep parsing.
- M5-4 (mutation): drop `basis=` from any arm; M5-2 goes RED.

---

## 🛡 PRIME DIRECTIVE compliance

No root adds a halt, an abort condition, or a stopping gate. M3 and M4 make gates STRICTER and M1, M2,
M5 make reports MORE INFORMATIVE — none changes what stops a run.

M3 and M4 each remove an enumerated-liability: a rule-less disable is an unbounded exemption list, and a
hand-copied limit number is a list of one that has already drifted three ways.

## Non-goals

- Do NOT decompose `runMuxRunnerMain` (M3 non-goal above). Make it visible; ratchet later.
- Do NOT reach M3 green by deleting rules or widening ceilings.
- Do NOT reach M4 green by dropping the real 1690-line finding; M4-3 fails such a diff.
- Do NOT touch the post-final verdict READER's fail-closed behaviour (M1-4).
- Do NOT act on the quiescent-tree hypothesis; it is unmeasured.

## Simplification Review

Named subtractions: two unbounded exemptions replaced by scoped ones (M3); three false ledger entries
that will stop being generated (M4); one discarded diagnostic that stops being discarded (M1); one of
two scoring wires removed (M2). M5 is net-zero in mechanism, adding one token to one log arm.

The recurring shape this bundle exists to stop: **a fix landing where it was filed while its twin sits
in a sibling.** M1 is V3's twin, M2 is #7's untouched half, M3 is #18's twin, M5 is B-VERDICT's missed
arm. Four of five roots are the same omission. Sweep the CLASS, not the cited call site.
