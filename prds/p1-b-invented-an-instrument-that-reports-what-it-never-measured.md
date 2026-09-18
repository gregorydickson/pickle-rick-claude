# B-INVENTED — four instruments that report a state they never measured

**Bundle thesis:** every root here is one shape — *a decision point emits a status its own inputs
cannot support.* The judge scores against a ceiling nobody gave it; `install.sh` reports a decline as
a deploy; `recordStall` collapses two distinct stall causes into one counter; and `runMuxRunnerMain`'s
"behaviour-preserving" claims rest on source-text pins that confirm shape and are read as behaviour.
This is the dominant defect class named in root `CLAUDE.md` clause 6 — the defect is in the
INSTRUMENT, not the logic.

**All four mechanisms were re-grepped at `0a7e689f` before scoping.** None is stale.

| root | kind | source | surface |
|---|---|---|---|
| **I1** the judge compares against a threshold it invented | fix | #32 Cause A | `microverse-runner.ts` |
| **I2** `recordStall` cannot say which of its two causes fired | fix | #32 Cause B | `microverse-state.ts` |
| **I3** `install.sh` exits 0 on a refusal to deploy | fix | #40 | `install.sh` |
| **I4** `runMuxRunnerMain` is undrivable, so no pin is behavioural | fix | #29 | `mux-runner.ts` |

---

## 🚧 ROOT I1 — the judge scores against a ceiling nobody gave it (#32 Cause A)

Session `2026-09-12-a4d141e1` scored `6` against `baseline_score: 2`, `action: "revert"`. The judge's
six violations cite **"the 50-line hard limit"** four times. **This repo has no 50-line limit.** The
enforced ceiling is `max-lines-per-function` in `extension/eslint.config.js` — **120** code lines, 200
in the two override files — and `extension/szechuan-sauce-principles.md:113` says exactly that.

**The judge's measurements were accurate; only the threshold was invented.** It reported
`runMuxRunnerMain` at span 2202 and the AST agrees. Strip the 4 of 6 flagged functions that are under
120 and the score is **2**, equal to baseline, so `compareMetric` returns `held`, not `regressed`, and
**the revert never happens**. That revert discarded an iteration's work and the run stalled out.

**Re-grepped at HEAD and LIVE:** `buildJudgePrompt`'s assembly in `src/bin/microverse-runner.ts` contains
**zero** references to `szechuan-sauce-principles` and no function-size ceiling. The only
`max-lines-per-function` occurrence in the file is `COMPLEXITY_RULE_IDS` at `:5814-5815`, a different
code path that never reaches the prompt. The judge is asked to score function size and is told no limit.

**Do NOT hardcode 120.** A number copied into a prompt is an enumerated-set liability that rots
silently the moment `eslint.config.js` changes — root `CLAUDE.md` clause 1 and the
`audit-recorded-ceilings.sh` leg both exist because of this exact shape. Derive it from the config.

### AC-I1
- **AC-I1-1 (executable, FALSE at HEAD):** the assembled judge prompt contains the repo's real enforced
  function-size ceiling, and that value is **read from `eslint.config.js`**, not a literal in the prompt
  builder. Assert the prompt contains the ceiling AND that mutating the rule's configured value in a
  fixture config changes the value the prompt carries.
- **AC-I1-2 (over-trigger control):** a fixture config whose `max-lines-per-function` is absent must not
  yield a prompt asserting a fabricated ceiling — it must omit the claim rather than invent one.
- **AC-I1-3:** the override files' higher ceiling (200) is not silently presented as the global one.

---

## 🚧 ROOT I2 — a stall counter that cannot name its cause (#32 Cause B)

Session `2026-09-15-c5a7eb48`: `stall_counter` **5/5** with `convergence.history` **empty**. That is not
corruption. `recordIteration` (`microverse-state.ts:376-392`) appends history and increments the counter
together, so a full counter with empty history means every increment came from the other writer,
`recordStall` (`:401`) — whose own docblock says it increments *"without adding a history entry"* for
**"no commits or metric unmeasurable."** Two causes, one counter, no way to tell them apart from state.

Only `microverse-runner.log` prose says which fired (`No commits made — stall (no rollback)`, ×5). A
prose log line is not a measurement — it is the same information loss as #33 and #35.

**The second-order finding stays open and is NOT in scope:** why the worker committed nothing in
iterations of 61s/33s/31s/28s. That is a worker-productivity question; this root only makes the stall
path able to say which branch it took, which is the prerequisite for ever answering it.

### AC-I2
- **AC-I2-1 (executable, FALSE at HEAD):** a stall recorded for *no commits* and a stall recorded for
  *metric unmeasurable* are distinguishable **from persisted state alone**, with no log parsing.
- **AC-I2-2 (over-trigger control):** the counter's existing arithmetic is unchanged — a run that stalls
  N times still reaches the same limit at the same iteration. This is a widening, not a new state.
- **AC-I2-3:** legacy persisted state written before this field still loads (probe the old shape).

---

## 🚧 ROOT I3 — `install.sh` reports a refusal as success (#40)

Measured this session, exit code captured directly:

```
$ bash install.sh --allow-downgrade < /dev/null; echo "EXIT=$?"
Downgrade 2.2.0-beta.1 → 2.1.1 — proceed? [y/N] EXIT=0
$ grep -m1 '"version"' ~/.claude/pickle-rick/extension/package.json
  "version": "2.2.0-beta.1",     # unchanged — nothing was deployed
```

`install.sh:207` does `IFS= read -r answer || true`; EOF leaves `answer` empty, the `[y/N]` default
declines, and `:209` does `exit 0`. **Both sibling refusals in the same guard chain exit non-zero** —
`:225` exits 1 (source older than deployed), `:200` exits 2 (active session). Only the decline claims
success, so a caller reading the exit code cannot separate *deployed* from *declined to deploy*, and
the runtime then executes stale JS invisibly for every subsequent run.

**Prefer the subtraction:** make the three refusals in this chain agree rather than adding a fourth
state. Distinguishing "typed n" from "no TTY" is optional and probably not worth a case.

### AC-I3
- **AC-I3-1 (executable, FALSE at HEAD):** `install.sh --allow-downgrade` with non-TTY stdin exits
  **non-zero** and deploys nothing.
- **AC-I3-2 (over-trigger control):** `--allow-downgrade --no-confirm` still exits 0 **and** deploys —
  assert the deployed `package.json` version actually changed, not merely that the exit code is 0. A
  fix that reds the working path is worse than the defect.
- **AC-I3-3:** an interactive `y` still proceeds; an interactive `n` exits non-zero.

---

## 🚧 ROOT I4 — the most-refactored function in the codebase is undrivable (#29)

`runMuxRunnerMain` decides ticket lifecycle, salvage and Done-flips. **Re-grepped at HEAD: it is
`async function runMuxRunnerMain({ runIteration, sleep, exit }: MuxRunnerMainDeps)` at
`src/bin/mux-runner.ts:16438` and `grep -c "export .*runMuxRunnerMain"` returns `0`.**

The premise has moved since #29 was filed and the move matters: **the dependency-injection seam now
exists** (`MuxRunnerMainDeps` — `runIteration`, `sleep`, `exit` are all injectable), so the expensive
half of the work is already done. What is missing is the `export`. Five test files name the function
and **none calls it** — `mux-runner-exit-pending-guard.test.js:5` and
`mux-runner-extracted-helpers-behaviour.test.js:4` reference it only in comments, which is precisely the
"pins confirm shape, not behaviour" this issue reported.

### AC-I4
- **AC-I4-1 (executable, FALSE at HEAD):** a suite imports `runMuxRunnerMain` and drives it through
  injected deps, asserting one real loop decision (not a source-text match).
- **AC-I4-2 (over-trigger control, REQUIRED):** mutate the asserted decision in the source and show the
  new test **reds**; restore and show it greens. A pin that cannot fail is a green light wired to
  nothing. Do not `git checkout` to restore — copy the file aside first.
- **AC-I4-3:** exporting it changes no runtime behaviour — the CLI guard still governs execution.

---

## NOT in Scope
- Why the worker produced no commits in `2026-09-15-c5a7eb48` (#32's second-order question).
- #5 (architecture enhancement).
- Any new release-gate leg. All four roots are covered by existing legs; see the four gate-leg
  questions in root `CLAUDE.md` — none of these earns a new one.

## Exit State
Four instruments can each express the state they actually observed, and the claim that they can is
pinned by a test with an over-trigger control.
