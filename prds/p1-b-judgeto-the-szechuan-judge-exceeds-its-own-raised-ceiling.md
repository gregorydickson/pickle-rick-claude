# B-JUDGETO — the szechuan judge times out at the ceiling that was raised to stop it timing out

---
title: "B-JUDGETO — a 600s judge baseline that cannot measure, degrading every run and blocking every release"
status: draft
priority: P1
type: bug-bundle
composes: [szechuan-baseline-judge-timeout, R-SJWT-regression-or-insufficiency]
---

## Trigger — three bundles completed, zero released

`szechuan-sauce` has degraded on **every** bundle this session, and a degraded run stamps
`run cannot report success`, which under root `CLAUDE.md` withholds the release verdict. The result is
a system that builds and reviews correctly and then never ships.

**Two DIFFERENT causes wore the same disposition** — recorded because the collapse is the reason this
looked like one recurring defect for two ticks:

| bundle | disposition | actual cause |
|---|---|---|
| B-ARGMAX (`2026-09-04-b71e8f4f`) | `baseline_unmeasurable_unrecoverable` | **`judge timed out after 600s`**, 4 attempts, 1 iteration / 44m 2s |
| B-FRESHWIN (`2026-09-05-afe6cf89`) | `baseline_unmeasurable_unrecoverable` | a malformed `Write(.claude/commands/**)` permission rule — **fixed** `e4edb6f9` |

This bundle owns the FIRST row only. The second is closed.

## Root cause — the remedy that shipped for this exact class has been consumed

`R-SJWT` (#95, archived) diagnosed this in June: the scoped szechuan judge scored the **whole** target
tree rather than `scope.json:allowed_paths`, producing both timeout and score inflation. `B-SJWT`
shipped v1.98.0 (2026-06-04) with three parts — **R-SJWT-1** scope the judge prompt to `allowed_paths`,
**R-SJWT-2** raise `DEFAULT_METRIC.timeout_seconds` 300 → 600, R-SJWT-3 regression pin + trap door.

**Measured at HEAD:** `init-microverse.ts:10` reads `timeout_seconds: 600` — R-SJWT-2's remedy is
present — and the failing run's `microverse.json` confirms it used exactly `600`. The judge exceeded it
anyway. **Raising the ceiling bought roughly three months.**

## The question this bundle must answer FIRST, by measurement

**Is R-SJWT-1 still effective — is the judge prompt actually scoped to `allowed_paths`, or is it
scoring the whole tree again?** If the prompt is unscoped, the timeout is a SYMPTOM and the ceiling is
irrelevant: cost scales with repo size, and the repo has grown by three bundles since June. If the
prompt IS scoped and 600s still fails, the cost model is different and must be named before anything is
changed.

Do not begin by adjusting a number. `R-SJWT` already tried that and this PRD is the receipt.

## Acceptance criteria (machine-checkable)

- **AC-1** State, with the probe, whether the judge prompt at HEAD is scoped to `allowed_paths`. If it
  is not, that is the defect; if it is, name what the 600s is actually being spent on (prompt bytes,
  file count, or model latency) with a measurement, not an estimate.
- **AC-2** A szechuan baseline measures successfully on this repo at its current size, demonstrated by
  a real phase run reaching at least iteration 1 with a scored baseline — not by a unit test.
- **AC-3** The fix does NOT consist of raising `timeout_seconds` again. A ceiling raise is the
  one-more-member shape root `CLAUDE.md` forbids; if the honest fix genuinely requires a larger budget,
  it must ship together with the cost reduction that makes the budget stable, and the PRD must say why
  the new number will not be consumed the way 600 was.
- **AC-4** An unmeasurable baseline is distinguishable in the logs from a baseline that measured and
  scored badly. Today both land on `baseline_unmeasurable_unrecoverable`; a timeout and a malformed
  permission rule reached the identical string, which is what made two unrelated failures look like one.
- **AC-5** Negative control: a genuinely unmeasurable baseline (judge binary absent) still degrades
  honestly and still does not halt the pipeline — B-NOSTOP-GATES is preserved, no new abort condition.
- **AC-6** Closer: full release gate green with the soak leg genuinely RUN (set `PICKLE_INSTALL_ROOT`
  to a non-`$HOME` path — it self-skips otherwise and a 16-second pass is not a 1800s soak), plus a
  `ci-repro.sh --runner-release 24.04` run naming the sha.

## Explicit non-goals

- Do NOT raise `timeout_seconds` as the fix (see AC-3).
- Do NOT make szechuan's degradation non-degrading to unblock releases. The verdict is honest; the
  measurement is what is broken. Faking the verdict is the fake-green this codebase exists to prevent.
- Do NOT re-open the B-FRESHWIN permission cause — closed at `e4edb6f9`.

## Ticket classes

1. Measure and state the R-SJWT-1 scoping status + the real cost driver (research/evidence).
2. The cost fix itself (behavioural).
3. AC-4 disposition split so an unmeasurable baseline names its own cause (behavioural).
4. Closer: gate with a genuinely-run soak + ci-repro evidence.
