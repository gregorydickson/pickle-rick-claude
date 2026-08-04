---
title: "Does integrating /ll:deep-pr-review into anatomy-park + szechuan-sauce add value?"
date: 2026-08-04
branch: release/v2.1-beta
head: 3f0b7749
status: analysis-complete
recommendation: DO NOT BUILD AS SCOPED — measure first, then subtract
related_prd: p2-review-integration-deep-review-into-anatomy-and-szechuan.md
---

# Value analysis — deep-review integration into the cleanup phases

**Question put by the operator:** anatomy-park and szechuan-sauce "still seem to miss things." Should
we port the review capability of `/ll:deep-pr-review` into those phases, optionally with a codex
adversarial pass?

**Answer: no — not as scoped, and not yet.** The phases' review *method* is demonstrably strong. Their
*metric* was structurally blind until 8 days ago, and **not one anatomy-park or szechuan-sauce phase
has run since it was repaired.** Every observation behind "they miss things" was made through a broken
instrument. Building a deeper review engine on top of that is machinery on an unmeasured signal — and,
as scoped, it violates three binding operator directives.

---

## 1. The crux: was it the JUDGE or the METHOD?

**It was the judge. This is settled by source, by commit history, and by the deployed tree.**

### 1.1 The judge had no memory, no ledger, and lied about convergence

`R-JPCM` — `buildJudgePrompt` demanded a bare integer while `parseLlmJudgeOutput` demanded a JSON
object. `JSON.parse("2")` yields a *number*, not an object, so **every** measurement fell to
`emptyJudgeResult('malformed')`. Consequences, all confirmed at source:

- `violation_ledger` rebuilt from empty forever → the judge re-discovered the whole tree each pass with
  zero cross-iteration memory.
- `compareMetric` never reached its R-SLLJ-4 set-ops branch → real fixes scored `held`.
- The `## Prior violations (DO NOT re-report)` prompt block is gated on a non-empty ledger → never emitted.
- `JudgeResult.shape: "full"` was unreachable **by construction**.

It was silent because `extractScore` tries `JSON.parse(...).score` and *then* falls back to line
scanning — the integer kept working while the payload was dropped
(`extension/src/bin/microverse-runner.ts:1662-1668`, the fix's own comment, states this verbatim).

Underneath it, `R-JPCM/WS-4`: `isConverged` returned a bare `true` for both stall-exhaustion and
target-reached, and `handleMetricMode` returned `'converged'` unconditionally. **A phase that ran out of
runway reported success.** Recorded field cost: szechuan held flat at 4 for five iterations while
landing five real reviewed fixes, hit the stall limit, and exited `status: "converged"` against
`convergence_target: 0` (`prds/MASTER_PLAN.md:530`).

### 1.2 All of it is FIXED and DEPLOYED

| Defect | Fix | Landed | In deployed tree? |
|---|---|---|---|
| WS-4 — `converged` on stall-exhaustion | branch-discriminated `isConverged` + honest disposition | `9f83e2c1`, `66eb7a69` (2026-07-19) | ✅ `stalled_below_target` ×2 |
| WS-1 — prompt/parser contract split | one contract; prompt emits `{score, violations[], resolved, new, remaining}` | `8a64bc5f` (2026-07-27) | ✅ |
| WS-2 — dead-ledger alarm had no producer | `emitJudgeParseDiagnostic` + live-ledger receipt + legacy-fallback notice | `495177d1`, `e4542828`, `3f3fd5d4` (2026-07-27) | ✅ ×4 |

Verified in `~/.claude/pickle-rick/extension/bin/microverse-runner.js` (deployed `2.1.0-beta.7`) — this
is the mandated `prds/CLAUDE.md` stale-premise check against **both** HEAD and the deployed tree.
Source: `extension/src/bin/microverse-runner.ts:1670-1680` (the JSON contract),
`:1798-1813` (the emitter), `:3727` + `:4729` (`stalled_below_target`).

### 1.3 THE STRONGEST PIECE OF EVIDENCE

**The szechuan-sauce phase, running with its own metric blind, autonomously diagnosed and fixed
R-JPCM — the P1 defect causing that blindness — and landed six commits doing it.**

```
8a64bc5f  szechuan-sauce: Single Source of Truth — the judge's prompt and its parser want one contract
495177d1  szechuan-sauce: Observability — the judge's dead-ledger alarm had no producer
e4542828  szechuan-sauce: Observability — the live-ledger receipt had no producer
3f3fd5d4  szechuan-sauce: Observability — the legacy-fallback notice had no producer
248c5fa9  szechuan-sauce: Single Source of Truth — one convergence verdict, read two ways
a7d6d9ec  szechuan-sauce: Single Source of Truth — hooks live in the COMMON dir, not the worktree's
```

All six from one phase, session `2026-07-26-013335ff`, 2026-07-27. `prds/MASTER_PLAN.md:120` records
four of these as *"4 real subtractions landed while the metric sat flat at 2 … all `Classification:
held`"* — filed as proof the finding **recurred unfixed**. It reads that way because the worker edits
*source* while the runner executes *deployed JS*: the fix landed mid-run and the running judge stayed
blind for the remaining iterations. The ledger row is measuring the instrument, not the work.

**A review method weak enough to justify a new engine does not find the P1 bug inside its own scoring
loop and ship the fix in the same pass.** The method is not the problem.

The same run's anatomy-park half landed two CRITICALs and three HIGHs with trap doors (`5840a47a`
"escaped-quote nest bypassed every worker-forbidden-op guard", `62fe1ff9` "bash -c payload skipped the
R-WACT tsc gate", `487e7855`, `0e641f21`, `a87fa459`). The prior release run: anatomy-park converged
6 iters / 110m, both subsystems 2/2 clean, zero stall-sealed, 2 HIGH fixes + 4 trap doors; szechuan
converged 4 iters / 49m with 3 subtractions (`prds/MASTER_PLAN.md:108`).

### 1.4 The decisive fact about the premise

```
$ git rev-list --count 8a64bc5f..HEAD     # 23
```

Of those 23 commits: **one** szechuan commit (`a7d6d9ec`, same run, same blind judge), **zero**
anatomy-park commits. Everything after `507ed91f` is docs and hand-fix work.

> **No anatomy-park or szechuan-sauce phase has ever run on the repaired judge.**

The operator's "they still seem to miss things" is therefore, of necessity, an observation of the
pre-`8a64bc5f` phases: no cross-iteration memory, `held` on every real fix, and `converged` reported
against an unmet target. Memory [[project_microverse_judge_ledger_dead_until_8a64bc5f]] states the
rule directly — *never read a pre-`8a64bc5f` score delta as evidence a change helped or hurt.* The
same caution applies to a qualitative impression formed from those runs.

**We have zero field evidence about how these phases behave today.** That is the gap to close, and it
costs one pipeline run, not a new review engine.

---

## 2. What `/ll:deep-pr-review` actually adds — mechanism by mechanism

Skill source: `~/.claude/plugins/cache/loanlight/ll/98222a403836/skills/deep-pr-review/SKILL.md`.

| Mechanism (SKILL.md step) | Already in pickle-rick? | Where |
|---|---|---|
| Diff triage: hand-authored / generated / lockfile (2) | **Partial** — scope-fencing gives the same budget effect | `resolve-scope.ts`; `pipeline-runner.ts:2121, 2279` pass `--allowed-paths-file` to **both** phases |
| Multi-lens orthogonal fan-out (4) | **Yes, as code** — ~20 lenses | `extension/src/services/citadel/` |
| Per-AC reconciliation, Met/Partial/Not-met (6) | **Yes** | `citadel/ac-coverage-scorecard.ts`, `citadel/prd-parser.ts` |
| Deferral / disclosure reconciliation (5) | **Yes** | `citadel/divergence-reconciliation.ts` |
| Adversarial verification, drop the unverifiable (5) | **Yes** — confidence rubric, conf<80 drop | `szechuan-sauce-principles.md` `## Confidence Scoring`; anatomy Override 1.5 |
| TESTS lens: "would this fail if the feature were deleted?" (4) | **Weakly** — regex-based, not a reasoning lens | `citadel/test-authenticity-audit.ts`, `citadel/skeptic-lens.ts` |
| One Codex adversarial pass (3) | **Yes** — already a first-class backend | `--backend codex` on **both** commands (`anatomy-park.md:59`, `szechuan-sauce.md:59`); `backend-spawn.ts:509,519` |
| Pattern replay across the full scope | **pickle-rick has this; deep-pr-review does NOT** | anatomy-park Phase 2.5 |
| Trap-door cataloguing with `PATTERN_SHAPE` | **pickle-rick has this; deep-pr-review does NOT** | anatomy-park Override 3 |
| Contract map: grep every importer of every export | **pickle-rick has this; deep-pr-review does NOT** | szechuan Override 2 |

**Net: one genuine capability gap** — an LLM-reasoning TESTS lens ("would this test fail if the feature
were deleted?"). pickle-rick's equivalent is regex matching on `Object.keys(...).toContain('Type')`,
`if (false)`, `x = x`. That gap is real. **It belongs to citadel**, which owns the test-authenticity
audit — not to anatomy-park or szechuan-sauce.

Also: a large fraction of the skill's machinery has **no input available in-phase**. Steps 1, 5 and 7
require a PR number, a PR body, GitHub review comments, Linear `blocks`/`blockedBy` relations, and
`gh pr review`. A cleanup phase runs mid-pipeline on an unpushed branch with none of those. Roughly
half the skill is unportable by construction.

---

## 3. Directive conflicts — as scoped, the port is forbidden three times over

Binding source: `prds/MASTER_PLAN.md:11-29` (Operator Directives 2026-07-25).

1. **Directive 2 — a gate may block a LOCAL action but must NEVER stop the pipeline.**
   deep-pr-review's core output is a *verdict gate*: `changes-requested` when any Blocking finding
   exists (SKILL.md:184-193), and under `--strict`, **any** verified issue of any severity blocks.
   Porting the verdict into a pipeline phase creates exactly the stopping gate B-NOSTOP-GATES
   (beta.7) was built to subtract. Directive 2 calls a stopping quality gate *anti-quality*.

2. **Directive 4 — stop making the completion oracle smarter.**
   SKILL.md:178: *"Any criterion not fully met is a Blocking finding."* That is a new oracle case,
   in the phase downstream of the completion oracle. Directive 4 names this as the treadmill and asks
   for one subtraction instead.

3. **Repo-agnostic invariant** (`CLAUDE.md`; [[feedback_pickle_rick_must_be_repo_agnostic_invariant]]).
   deep-pr-review's lenses are loanlight-specific by design: *"tenant isolation by lender_id … S3 key
   structure … Drizzle: journal entry, idempotent DDL, when-ordering, ADD VALUE IF NOT EXISTS … repo
   guards (no hardcoded LLM models, resilience module for vendor calls, safeEnumLookup)"*
   (SKILL.md:116-123). Importing that lens set **is** the per-stack adapter matrix the invariant
   forbids. pickle-rick's own principle set is deliberately stack-neutral.

Any buildable version would have to strip the verdict gate, the AC-blocking rule, and the stack-specific
lenses — which is to say, strip everything that distinguishes it from what the phases already do.

---

## 4. What actually still causes misses (post-judge-fix), with the subtractive fix

These survive the R-JPCM fix and are the real candidates. All three are **signal** defects, not method
defects — and every fix is net-negative LOC.

### 4.1 The worker and the judge use different denominators (highest confidence)

- The **judge** scores everything in `allowed_paths`: *"Count ONLY violations located within these
  paths"* (`microverse-runner.ts:1644-1650`) — ~290 files on a pipeline run.
- The **worker** discards *"Pre-existing issues on lines the current change did not touch"*
  (`extension/szechuan-sauce-principles.md`, `## False Positives — Do NOT Flag`, first bullet).

So the worker systematically refuses to fix a class of finding the judge keeps counting. Documented
symptom, unmistakable: **`gap_analysis.md` reports 0 open violations while the score holds flat for 3+
iterations** ([[feedback_szechuan_judge_credited_finding_is_the_metric]]). Concrete case: the judge
named `pickle-utils.ts:75` at **conf=100** in its iter-3 rationale; the worker dropped it three times
as "pre-existing" and the score never moved.

**Subtractive fix:** make worker and judge share ONE denominator — either delete that false-positives
bullet, or scope the judge prompt to the branch diff. One bullet or one prompt line. **This is the
mechanism that best matches "they miss things," and a deeper review engine makes it strictly worse:
more candidates, same filter discarding them.**

### 4.2 `convergence_target: 0` over ~290 files is unreachable

`szechuan-sauce.md` Step 8 passes `--convergence-target 0`. Zero principle violations across a 290-file
scope is not attainable, so szechuan exits by **stall**, never by target — its stopping condition is
budget, not quality. Post-WS-4 this is at least *honestly reported* (`stalled_below_target` →
`reportAs: 'non-convergent'`, `microverse-runner.ts:4729`) rather than laundered as `converged`. Fix is
a parameter decision, not code.

### 4.3 Two independent confidence rubrics

The judge scores with its own rubric; the worker re-filters at conf<80 with its own. A judge-credited
conf=100 finding the worker drops at conf<80 is re-credited every iteration and never fixed. Same
memory, same root shape as 4.1: two filters in series on one signal.

---

## 5. Codex — the seam already exists; do not add a parallel one

- Plugin **installed**: `codex@openai-codex` 1.0.6 (`~/.claude/plugins/installed_plugins.json`),
  binary at `/opt/homebrew/bin/codex`.
- `--backend codex` is already a documented flag on **both** commands (`anatomy-park.md:59`,
  `szechuan-sauce.md:59`), routed through `backend-spawn.ts` (`buildCodexInvocation`, `:509`, `:519`),
  resolvable from `state.backend` or `PICKLE_BACKEND` (`resolveBackend`, `:220`).
- A judge-side seam also already exists: `microverse.judge_backend` / `judge_backend_fallback`
  (`pickle-utils.ts:24-25,62-69`, defaults `claude` / fallback `codex`), `resolveJudgeBackend`,
  `buildJudgeEnv` (`judge-spawn-env.ts`, `JudgeBackend = 'claude' | 'codex' | 'auto'`).

**One caveat that must not be lost.** `measureLlmMetricAttempt` deliberately **pins the primary
measurement to claude**, with the reason in-source (`microverse-runner.ts:2242-2246`):

> *"The judge always runs via the claude binary, even when state.backend=codex. codex on ChatGPT
> accounts rejects claude-sonnet-4-6 as unsupported, causing silent false-convergence (BestScore: 0)."*

`judge_backend` today governs the **fallback/probe** path only. An "adversarial codex judge" therefore
means un-pinning a guard that exists because codex-as-judge previously produced silent false
convergence — the exact failure class this whole analysis is about. If it is wanted, it is a settings
change plus removing that pin, gated on evidence the model-rejection cause is gone. It is not a new
mechanism, and it is not free.

---

## 6. Recommendation

**DO NOT BUILD the deep-review integration.** In priority order:

1. **MEASURE (do this first, it is the whole answer).** Run one `/pickle-pipeline` — or standalone
   `/anatomy-park` + `/szechuan-sauce`, scope-fenced — on the **deployed beta.7 runtime**, and record
   what the phases now find with a live violation ledger, cross-iteration memory, and an honest
   `stalled_below_target` disposition. Cost: one run. There is currently **no** evidence about their
   post-fix behavior, and every claim in the "they miss things" premise predates the repair. This is
   [[feedback_verify_the_outcome_not_the_mechanism]] and the standing verification-ticket discipline
   applied to the premise itself.

2. **If misses persist, fix the denominator split (§4.1), subtractively.** Delete the
   "pre-existing issues on unmodified lines" false-positives bullet, or scope the judge prompt to the
   branch diff, so worker and judge count the same things. Net-negative LOC, no new mechanism, and it
   directly targets the documented flat-score-with-zero-open-violations symptom.

3. **Correct the stale ledger** (free, prevents a rebuild of shipped work). `prds/MASTER_PLAN.md:120`,
   `:530`, and `prds/BUG-INDEX.md:137` all carry R-JPCM as OPEN / "recurred UNFIXED." WS-1, WS-2 and
   WS-4 are all shipped **and deployed**. Per [[feedback_reground_the_ledger_before_building_from_it]]
   the ledger drifts ~2-in-6; this is one of them. *(Not touched by this analysis — outside the
   permitted write scope.)*

4. **If a deeper review is still wanted after (1), scope it to citadel's TESTS lens** — the single
   genuine capability gap (§2). citadel already owns test authenticity; the upgrade is regex →
   reasoning lens, in the phase that already does AC reconciliation. Report-only, advisory, never
   blocking (Directive 2).

5. **Codex adversarial: use `--backend codex`, which already works on both phases.** Do not build a
   parallel invocation path. A codex *judge* requires un-pinning a deliberate guard (§5) and should be
   gated on evidence, not enthusiasm.

**The one-line version:** the review method found the P1 bug in its own scoring loop and shipped the
fix; the metric that was supposed to notice reported `held`. Fix the signal, measure, and only then ask
whether the method needs help.
