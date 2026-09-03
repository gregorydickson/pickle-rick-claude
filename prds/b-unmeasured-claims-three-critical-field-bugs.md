# B-UNMEASURED — three field-reported CRITICALs, one root — PRD

**Branch:** `release/v2.1-beta`  **Build mode:** unattended
**Source:** operator-filed GitHub issues **#6, #7, #8** (all 2026-09-03, all observed live on
`v2.1.0-beta.24`, session `2026-09-02-eaa3e492`, against a NestJS/pnpm monorepo — NOT this repo).
**Launch AFTER B-CIGREEN4 completes.** Re-verify every premise at launch; these were measured
2026-09-03 against HEAD `c76e6f10`.

## The one root

All three are the same defect this repo has been mining for 40 hours in B-CIGREEN4's anatomy-park:
**a positive claim published without the measurement that would justify it.**

| Issue | The claim | The missing measurement |
|---|---|---|
| **#8** | "converged (2 consecutive clean passes)" | one of those passes carried *"no INV-NO-SELF-DISOWN evidence in either direction"* |
| **#7** | "held" / `stalled_below_target` | the metric scored a ledger the worker never touched; iteration 2 compared an LLM score to a ledger count |
| **#6** | commit message "worker timed out before committing" | the branch tests only *"no commits but dirty tree"*; nothing on it inspects timeout state |

B-CIGREEN4 fixed ~20 instances of this class inside the runner's gates. These three are the same
class in the **phase controllers**, found in the field rather than by review.

## Exposure measured on THIS repo, 2026-09-03

- **#8 — NOT currently hit here, by accident of layout.** `resolveProjectRootOneLevelDown` refuses
  to guess on 2+ child markers. This repo has exactly **one** (`extension/package.json`) and no root
  `package.json`, so the typecheck resolves. Issue #8 says it outright: this repo is *"one added
  `package.json` away from disarming its own guard."* **A 40-hour anatomy-park convergence claim
  currently rests on a directory-layout coincidence.** That is the real finding.
- **#6 — mechanism live at `microverse-runner.ts:4657`. TEN false-attribution commits already in
  this repo's history**, oldest `f484ace9` (2026-05-01), most recent `586f6617` (2026-06-14). Zero
  in the B-CIGREEN4 run so far.
- **#7 — LIVE RISK TO THE RUN IN FLIGHT.** szechuan-sauce is the phase B-CIGREEN4 enters next. If it
  reproduces, expect ~111 min burned and `stalled_below_target` with a frozen metric while the
  worker commits real fixes.

---

## FR-1 (CRITICAL, #8) — an unmeasured iteration must not count toward convergence

`typecheck_unmeasurable` returns `{ ran: false, skipped: 'typecheck_unmeasurable' }`
(`microverse-runner.ts:1212`), and that iteration is still counted toward the consecutive-clean
streak that justifies `converged`. Convergence is a **positive** claim; an absent measurement is not
a measured pass.

⛔ **Do NOT make `typecheck_unmeasurable` fatal.** The non-fatal disposition is deliberate and
correct — an absent measurement is not a measured regression either, and making it fatal creates a
new abort condition on any monorepo, violating the PRIME DIRECTIVE. The fix is that such an
iteration **does not increment `consecutive_clean`** — it neither passes nor fails. Prefer deleting
the ambiguity over adding a third state if that is expressible.

**Also fix the layout dependence:** the guard must not work here purely because this repo happens to
have one child marker. Either `resolveProjectRootOneLevelDown` handles the multi-marker case, or the
unmeasurable result must be visible in the convergence verdict rather than silently absorbed.

**Files (scope fence):** `extension/src/bin/microverse-runner.ts` + compiled
`extension/bin/microverse-runner.js`, `extension/src/services/CLAUDE.md` (AP-EXT-ITER7-02 entry),
existing anatomy-park/convergence tests.

## FR-2 (CRITICAL, #7a) — the worker must work the ledger the metric scores

The metric scores a fixed violation ledger; the worker selects its own targets. Measured in the
field: five genuine quality commits during the held iterations, and **zero** commits touching either
ledger file, so `held` was guaranteed and the stall was structural rather than a worker failure.

The fix is to close the loop between what is scored and what is worked — the worker's brief must
carry the ledger items, or the metric must score what the worker was actually asked to do. Decide
which at research time and state the choice.

⛔ Do NOT "fix" this by loosening the stall threshold or raising the iteration budget; that hides a
structural mismatch behind a longer run.

**Files (scope fence):** `extension/src/bin/microverse-runner.ts` + compiled, szechuan prompt
templates under `extension/templates/`, existing szechuan tests.

## FR-3 (HIGH, #7b) — iteration 2 compares two different units

`classifyMicroverseMetric` reports `basis=ledger_count` on one iteration and `basis=set_ops` on the
next (`microverse-runner.ts:4331-4333`). Field evidence: an LLM baseline of **16** was compared
against a ledger count of **5** and classified `improved`, setting a target that later iterations
could never move. Two units, one comparison.

**Files (scope fence):** `extension/src/bin/microverse-runner.ts` + compiled, existing metric
classification tests.

## FR-4 (HIGH, #6) — state the condition the branch actually tested

`microverse-runner.ts:4657` commits `microverse: auto-commit (worker timed out before committing)`
on a branch whose only condition is *"no commits but dirty tree"*. The `ctx.log` line one line above
states the real condition correctly. Field evidence: worker timeout was **explicitly disabled** 82
minutes before the auto-commit fired, and 710 changed lines landed under a false cause.

Fix: the commit message states the observed condition, not an unobserved cause. This is the smallest
fix in the bundle and the one with permanent artifacts — commit messages are not editable after the
fact.

⛔ **NEVER rewrite the 10 existing false-attribution commits.** They are reachable from published
tags. Fix forward only. Optionally record the count and sha range in `prds/MASTER_PLAN.md` so the
history is interpretable.

**Files (scope fence):** `extension/src/bin/microverse-runner.ts` + compiled, existing
auto-commit tests, `prds/MASTER_PLAN.md`.

---

## Bundle-wide rules

- **PRIME DIRECTIVE:** no new abort condition in any ticket. FR-1 in particular must not convert an
  unmeasurable typecheck into a halt — it must stop counting, not start failing.
- **A claim must carry its measurement.** That is the shared thesis; each fix should make the
  verdict name what it actually observed.
- Verify against the FIELD evidence in the issues, not only against this repo — this repo does not
  reproduce #8 and has not yet reproduced #6 in the current run. A macOS single-marker pass is not
  acceptance; use `extension/scripts/ci-repro.sh` and, where a monorepo shape is needed, construct
  the 2+ marker fixture rather than assuming.
- Tests go in EXISTING test files. Tests import COMPILED JS — run `./node_modules/.bin/tsc` first.
- ⛔ NEVER raise the flake budget. ⛔ NEVER move CI off Node 22. ⛔ NEVER rewrite published tags.

## Definition of done

Each of #6, #7, #8 is either FIXED with a regression pin plus a control arm, or disposed by
measurement with the evidence recorded. The GitHub issues are updated with the disposition and the
commit that closed them.
