---
title: "Integrate /ll:deep-pr-review's review capability into anatomy-park and szechuan-sauce"
status: not-recommended
priority: P2
finding: B-DPRI
date: 2026-08-04
last_verified: 2026-08-11
verified_head: f0992812
verdict_after_reverification: "unchanged — not-recommended, on stronger evidence. §0.1's 'no cleanup phase has run since' is SUPERSEDED: 46 anatomy-park + 31 szechuan-sauce commits have since run with a live ledger (25 CRITICAL, 20 HIGH, 45 trap-doored). The deferred experiment was run and the existing phases work."
branch: release/v2.1-beta
head: 3f0b7749
build_mode: n/a — not recommended for build
pipeline_safe: yes (phase prompts + microverse-runner; NOT the salvage path)
analysis: prds/research/review-integration-value-analysis.md
---

# B-DPRI — deep-review integration into the cleanup phases

> **STATUS: NOT RECOMMENDED. Do not launch this.**
>
> This PRD exists to record the analysis and to define what *would* be built if the operator overrides
> the recommendation. The evidence says the premise is unfounded, the bundle as scoped violates three
> binding directives, and the cheaper action — one measured pipeline run — has not been taken.
> Full evidence: `prds/research/review-integration-value-analysis.md`.

---

## 0. The argument against building this

### 0.1 The premise rests on a broken instrument

The observation "anatomy-park and szechuan-sauce still miss things" was necessarily formed on runs
where the phases' metric was blind by construction (R-JPCM):

- `buildJudgePrompt` demanded a bare integer; `parseLlmJudgeOutput` demanded a JSON object.
  `JSON.parse("2")` is a number, not an object → **every** measurement hit
  `emptyJudgeResult('malformed')`, `violation_ledger` rebuilt from empty forever, `shape: "full"` was
  unreachable, and the judge re-discovered the tree from scratch each pass with zero memory.
- Underneath it (WS-4), `isConverged` returned the same bare `true` for stall-exhaustion and
  target-reached, so **a phase that ran out of runway reported `converged`**. Recorded cost: szechuan
  held flat at 4 across five iterations while landing five real reviewed fixes, then exited
  `status: "converged"` against `convergence_target: 0` (`prds/MASTER_PLAN.md:530`).

All three workstreams are **shipped and deployed** (`~/.claude/pickle-rick/extension/bin/microverse-runner.js`,
`2.1.0-beta.7`): WS-4 `9f83e2c1`/`66eb7a69` (2026-07-19), WS-1 `8a64bc5f` and WS-2
`495177d1`/`e4542828`/`3f3fd5d4` (2026-07-27). Source: `microverse-runner.ts:1670-1680`, `:1798-1813`,
`:3727`, `:4729`.

**~~And no cleanup phase has run since.~~ SUPERSEDED 2026-08-11 — the experiment was run, and it
answers the question this PRD deferred.**

*As written 2026-08-04:* `git rev-list --count 8a64bc5f..HEAD` = 23 commits: one szechuan commit from
the same blind run (`a7d6d9ec`), zero anatomy-park commits, the rest docs and hand-fix work. We have
**no** evidence about how these phases behave with a live ledger.

*Re-measured 2026-08-11 at `f0992812`:*

```
git rev-list --count 8a64bc5f..HEAD                                   189
git log --format=%s 8a64bc5f..HEAD | grep -c '^anatomy-park:'          46
git log --format=%s 8a64bc5f..HEAD | grep -c '^szechuan-sauce:'        31
  … of the 46 anatomy-park commits: 25 CRITICAL, 20 HIGH, 45 with a trap door
```

Span 2026-07-27 → 2026-08-11. The evidence gap is **closed**, and it closed in the direction that
*strengthens* this PRD's recommendation rather than weakening it: with a live ledger, the existing
phases produce a sustained stream of CRITICAL and HIGH findings, each carrying a trap-door entry.
Representative:

| Commit | Finding |
|---|---|
| `86ba58f4` | CRITICAL — a grouped command bypassed every worker-forbidden-op guard |
| `20043683` | CRITICAL — scope fence drops `-diff` text files from `allowed_paths` |
| `7509128c` | HIGH — an empty prior ledger classified every first LLM iteration as regressed |
| `b0ae7560` | szechuan — split `StateManager.read` along its read/parse/recover seams |
| `a34dc39d` | szechuan — collapse the twin demotion predicates onto one canonical-field probe |

§0.1's argument was: *the premise was formed on a blind instrument; fix the instrument and measure
before building a second engine.* The instrument was fixed, 77 cleanup-phase commits have since been
measured through it, and the phases work. **The `not-recommended` verdict stands on stronger evidence
than when it was written.**

The remaining honest caveat is unchanged: none of this compares the phases against
`/ll:deep-pr-review` on the *same* diff. It establishes that the existing phases find real defects, not
that they find everything the deep-review skill would. A head-to-head on one shared diff is still the
cheap next measurement, and is still cheaper than building the integration.

### 0.2 The method is demonstrably strong — it fixed the bug in its own scoring loop

The szechuan-sauce phase, metric blind, autonomously diagnosed and fixed R-JPCM itself, landing six
commits in one run (`8a64bc5f`, `495177d1`, `e4542828`, `3f3fd5d4`, `248c5fa9`, `a7d6d9ec`, session
`2026-07-26-013335ff`). `prds/MASTER_PLAN.md:120` records four of them as evidence the finding
"recurred UNFIXED" — because the worker edits *source* while the runner executes *deployed JS*, so the
fix landed mid-run and the running judge stayed blind. The ledger row measured the instrument, not the
work.

A review method that needs a new engine does not find the P1 defect inside its own metric and ship the
fix in the same pass. The same run's anatomy-park half landed 2 CRITICALs + 3 HIGHs with trap doors
(`5840a47a`, `62fe1ff9`, `487e7855`, `0e641f21`, `a87fa459`).

### 0.3 Almost every mechanism already exists

Of `/ll:deep-pr-review`'s mechanisms, exactly **one** is a genuine gap (an LLM-reasoning TESTS lens);
the rest are already built, mostly in citadel — and three pickle-rick mechanisms have no deep-pr-review
equivalent (anatomy Phase 2.5 pattern replay, trap-door `PATTERN_SHAPE` cataloguing, szechuan's
whole-repo contract map). Roughly half the skill is unportable by construction: steps 1, 5 and 7 need a
PR number, PR body, GitHub review comments, Linear relations and `gh pr review`. Cleanup phases run
mid-pipeline on an unpushed branch. Full table: analysis §2.

### 0.4 As scoped it is forbidden three times over

| Directive | Conflict |
|---|---|
| **2** — a gate may block a LOCAL action, never stop the pipeline | deep-pr-review's core output is a verdict gate: `changes-requested` on any Blocking finding (SKILL.md:184-193); `--strict` blocks on **any** verified issue. Porting the verdict into a phase re-creates the stopping gate B-NOSTOP-GATES subtracted in beta.7. |
| **4** — stop making the completion oracle smarter | SKILL.md:178 — *"Any criterion not fully met is a Blocking finding."* A new oracle case in the phase downstream of the oracle. The treadmill by definition. |
| **Repo-agnostic invariant** | The lens set is loanlight-specific by design: *"tenant isolation by lender_id … S3 key structure … Drizzle: journal entry, idempotent DDL … safeEnumLookup"* (SKILL.md:116-123). Importing it **is** the per-stack adapter matrix the invariant forbids. |

Strip the verdict gate, the AC-blocking rule and the stack-specific lenses — as the directives require —
and nothing remains that the phases do not already do.

### 0.5 The real defect is the signal, and the fix is subtractive

Post-R-JPCM, the mechanism that best explains "misses" is a **denominator split**:

- the **judge** scores everything in `allowed_paths` — *"Count ONLY violations located within these
  paths"* (`microverse-runner.ts:1644-1650`), ~290 files on a pipeline run;
- the **worker** discards *"Pre-existing issues on lines the current change did not touch"*
  (`extension/szechuan-sauce-principles.md`, `## False Positives — Do NOT Flag`, bullet 1).

The worker refuses to fix a class the judge keeps counting. Documented symptom:
`gap_analysis.md` reports **0 open violations while the score holds flat for 3+ iterations**
([[feedback_szechuan_judge_credited_finding_is_the_metric]]; the judge named `pickle-utils.ts:75` at
conf=100, the worker dropped it 3× as "pre-existing", the score never moved).

**A deeper review engine makes this strictly worse** — more candidates, same filter discarding them,
same 290-file denominator diluting each fix. The honest fix is one deleted bullet or one changed prompt
line: net-negative LOC, no new mechanism. This is `prds/CLAUDE.md` Simplification Review question 3 —
the bug is an existing filter dropping good findings, so the default fix is to *remove the filter*, not
to add a second review engine in front of it.

### 0.6 Recommended action instead

1. **Measure.** One `/pickle-pipeline` (or scope-fenced `/anatomy-park` + `/szechuan-sauce`) on the
   deployed beta.7 runtime. Record what the phases find with a live ledger. Cost: one run.
2. **If misses persist:** collapse the denominator split (§0.5) — subtractive.
3. **Correct the ledger** — `MASTER_PLAN.md:120`, `:530`, `BUG-INDEX.md:137` still carry R-JPCM as OPEN.
4. **Only then**, if still wanted, scope the one real gap (TESTS lens) into **citadel**, report-only.
5. **Codex:** `--backend codex` already works on both phases today. Nothing to build.

---

## 1. Scope — what would be built if the recommendation is overridden

Recorded for completeness. Each workstream is written to survive the directives; anything that could
not be is listed in §3 as explicitly out of scope.

### WS-1 — Reasoning TESTS lens in citadel (report-only)

Upgrade citadel's test-authenticity audit from regex matching to a reasoning lens answering, per
new/changed test in the diff: *"would this fail if the feature were deleted or broken?"* Hunt inert
guards, assert-nothing greens, and guards narrower than their name.

- **Seam:** `extension/src/services/citadel/test-authenticity-audit.ts` (today: `Object.keys(...)
  .toContain('Type')`, `if (false)`, `x = x`), wired via `citadel/audit-runner.ts`.
- **Severity ceiling:** `Advisory` / `Low`. Never Blocking, never halts, never stamps a completion
  verdict (Directives 2 + 4).
- **Repo-agnostic:** the question is stack-neutral; no framework-specific rules.

### WS-2 — Collapse the worker/judge denominator split

The actual "misses" fix (§0.5). Either delete the `## False Positives — Do NOT Flag` bullet
*"Pre-existing issues on lines the current change did not touch"* from
`extension/szechuan-sauce-principles.md`, **or** scope `buildJudgePrompt` to the branch diff. Pick one
denominator; do not add a reconciliation layer between two.

- **Shape:** deletion of one bullet, or one prompt line. Net-negative LOC.
- **Ordering:** WS-2 **before** WS-1. It is the cause; WS-1 is a capability.

### WS-3 — Codex adversarial pass via the EXISTING seam

No new invocation path. `--backend codex` already routes both phases through `buildCodexInvocation`
(`backend-spawn.ts:509,519`), and `microverse.judge_backend` / `judge_backend_fallback` already exist
(`pickle-utils.ts:24-25,62-69`) with `resolveJudgeBackend` + `buildJudgeEnv`.

- **Scope:** documentation of `--backend codex` for the cleanup phases, and *evaluation only* of
  promoting `judge_backend` from fallback-path to primary.
- ⚠ **Hard constraint.** `measureLlmMetricAttempt` pins the primary judge to claude on purpose
  (`microverse-runner.ts:2242-2246`): *"codex on ChatGPT accounts rejects claude-sonnet-4-6 as
  unsupported, causing silent false-convergence (BestScore: 0)."* Un-pinning it re-opens the exact
  silent-false-convergence class this bundle claims to fix. Any change here requires field evidence
  that the model-rejection cause is gone — recorded in the research artifact, per the
  contract-match rule in `prds/CLAUDE.md`.

### WS-4 — Verification ticket that RUNS the claim

Per [[feedback_add_a_verification_ticket_that_runs_the_claim]]: a ticket that executes a real
anatomy-park + szechuan-sauce pass on the built runtime, records what the phases find versus the
pre-bundle baseline captured in §2, and names the next blocker. Without it this bundle can only assert
that it helped.

---

## 2. Acceptance Criteria (machine-checkable)

Every AC below is precondition-gated on **AC-DPRI-00**, which must be satisfied *before* any other
ticket runs.

- **AC-DPRI-00 (BASELINE — blocking precondition).** A completed anatomy-park + szechuan-sauce pass
  on the **deployed beta.7 runtime** exists, with its `microverse.json` preserved. Assert:
  `convergence.history[].metric_value` parses as an object with a non-empty `violations` array for at
  least one iteration (proving the ledger is live, `shape: "full"`), and the phase's recorded
  `exit_reason` is present. **If this baseline shows the phases performing acceptably, the bundle is
  cancelled** — that is a success, not a failure.
- **AC-DPRI-01.** `extension/szechuan-sauce-principles.md` contains no
  `## False Positives — Do NOT Flag` bullet whose subject is "pre-existing" lines, **or**
  `buildJudgePrompt` emits a diff-scoped instruction. Exactly one of the two, asserted by a test that
  fails if both or neither hold.
- **AC-DPRI-02.** Worker and judge denominators are pinned equal by a unit test over
  `buildJudgePrompt` + the principles doc; the test fails if a future edit re-introduces a
  filter present on one side only.
- **AC-DPRI-03.** Every finding emitted by the WS-1 lens carries `severity` in
  `{'Low','Advisory'}`. A test asserts no code path can emit a citadel test-authenticity finding at
  `Blocking`/`Critical`/`High`.
- **AC-DPRI-04 (Directive 2 pin).** An invariant test asserts no exit reason introduced by this
  bundle reaches `dispatchHaltAction`, mirroring `AC-NSG-5b`.
- **AC-DPRI-05 (Directive 4 pin).** `git diff` for this bundle touches **zero** lines in
  `ticket-completion-evidence.ts`, `reconcile-ticket-truth.ts`, `salvage-ticket.ts`. Asserted by a
  path-scoped diff check.
- **AC-DPRI-06 (repo-agnostic pin).** No new identifier or prompt string in the bundle diff matches
  `lender_id|Drizzle|safeEnumLookup|S3 key|_journal\.json`. Asserted by grep over the diff.
- **AC-DPRI-07 (no parallel codex seam).** The diff adds no new process-spawn call site for `codex`.
  Asserted by grep: every codex invocation still routes through `buildCodexInvocation`.
- **AC-DPRI-08 (LOC shape).** WS-2's diff is net-negative in LOC. Asserted by
  `git diff --shortstat` on the WS-2 commits.
- **AC-DPRI-09 (WS-4).** A recorded post-build anatomy-park + szechuan-sauce pass exists with its
  `microverse.json`, and a written comparison against the AC-DPRI-00 baseline naming the next blocker.

---

## 3. Explicitly OUT of scope

- Any verdict gate, `--strict` mode, or `changes-requested` disposition inside a pipeline phase
  (Directive 2).
- Any AC-conformance blocking rule (Directive 4). AC reconciliation already exists in
  `citadel/ac-coverage-scorecard.ts` + `citadel/prd-parser.ts` and is not re-implemented.
- deep-pr-review's stack-specific lenses — tenant isolation, Drizzle migration checks, S3 key
  structure, `safeEnumLookup`, packaging-contract checks (repo-agnostic invariant).
- Steps 1 / 5-deferral / 7-posting of the skill: they require a PR, PR body, GitHub review comments and
  Linear relations. No input exists mid-pipeline.
- Per-PR worktree fan-out. The phases already run scope-fenced under one session
  (`pipeline-runner.ts:2121, 2279`).
- Any new parallel review engine beside citadel.

---

## 4. Simplification Review

**WS-1 — reasoning TESTS lens (citadel).**
1. *Necessary?* Adds a reasoning lens where a regex lens exists. It is the **only** genuine capability
   gap found (analysis §2) — but it is not what the operator's complaint is about, and it is not
   necessary until AC-DPRI-00 shows a miss it would have caught.
2. *Reuse?* **Yes, entirely.** Replaces the body of `citadel/test-authenticity-audit.ts` through the
   existing `audit-runner.ts` wiring. No new module, no new phase, no new report surface.
3. *Guards brittle complexity?* No — it replaces a weak check rather than wrapping one.
4. *Subtracts?* The regex battery (`VACUOUS_TYPE_PRESENCE_RE` and siblings) is deleted when the
   reasoning lens subsumes it. Net LOC roughly flat.

**WS-2 — denominator collapse.**
1. *Necessary?* **Pure removal.** Adds no code, flag, or state field.
2. *Reuse?* N/A — deletion.
3. *Guards brittle complexity?* **This is precisely question 3's case.** An existing filter
   false-drops good findings; the honest fix is to remove it, not to add a second review engine in
   front of it. Two filters in series on one signal is the smell.
4. *Subtracts?* One `## False Positives` bullet (or one contradictory prompt scope). **The bundle's
   real deliverable.**

**WS-3 — codex adversarial.**
1. *Necessary?* **No new mechanism at all** — `--backend codex` already works on both phases.
   Reduces to documentation plus an evaluation.
2. *Reuse?* `buildCodexInvocation`, `resolveBackend`, `resolveJudgeBackend`, `buildJudgeEnv` — all
   existing. A parallel path would be the smell; AC-DPRI-07 forbids it.
3. *Guards brittle complexity?* Promoting `judge_backend` to primary would **remove a deliberate
   guard** whose recorded reason is silent false convergence. That is subtraction in the wrong
   direction; hence evaluation-only.
4. *Subtracts?* Potentially the claude pin — **only** on field evidence, per §1 WS-3.

**WS-4 — verification.** Pure evidence; adds no runtime code.

**Bundle-level.** The only workstream that addresses the operator's stated complaint is WS-2, and WS-2
is a deletion. That is the tell: **if the answer is one deleted bullet, the bundle is not a review-engine
integration.** Which is why this PRD's own recommendation is not to build it.

---

## 5. Risks

- **R1 — building on an unmeasured premise.** Highest risk, and the reason for the status. AC-DPRI-00
  is the mitigation and is a hard precondition.
- **R2 — adding candidates upstream of the filters that discard them.** A deeper engine without WS-2
  raises finding volume and moves the metric not at all; the phase looks *more* broken. Mitigated by
  the WS-2-before-WS-1 ordering.
- **R3 — directive drift under implementation.** A worker reading the source skill will import the
  verdict gate, because that is what the skill is organized around. AC-DPRI-03/04/05/06 are the pins.
- **R4 — codex judge re-opens silent false convergence.** The claude pin exists for a recorded reason.
  Mitigated by evaluation-only scope in WS-3.
- **R5 — stale-ledger rebuild.** `MASTER_PLAN.md:120`, `:530`, `BUG-INDEX.md:137` still describe
  R-JPCM as OPEN. A refinement team reading those will re-derive a premise that shipped 8 days ago.
  Correct the ledger before any launch ([[feedback_reground_the_ledger_before_building_from_it]]).

---

## 6. Evidence index

| Claim | Citation |
|---|---|
| R-JPCM WS-1 shipped | `8a64bc5f` (2026-07-27); `microverse-runner.ts:1662-1680` |
| R-JPCM WS-2 shipped | `495177d1`, `e4542828`, `3f3fd5d4`; `microverse-runner.ts:1798-1813` |
| WS-4 (`converged` on stall) shipped | `9f83e2c1`, `66eb7a69` (2026-07-19); `microverse-runner.ts:3727`, `:4729` |
| All three deployed | `~/.claude/pickle-rick/extension/bin/microverse-runner.js`, `2.1.0-beta.7` |
| ~~No cleanup phase since the fix~~ **SUPERSEDED 2026-08-11** | *Was:* `git rev-list --count 8a64bc5f..HEAD` = 23; 1 szechuan (same blind run), 0 anatomy. *Now, at `f0992812`:* 189 commits — 46 anatomy-park (25 CRITICAL, 20 HIGH, 45 trap-doored) + 31 szechuan-sauce, spanning 2026-07-27→08-11. Gap closed; see §0.1 |
| szechuan fixed its own judge | 6 commits, session `2026-07-26-013335ff` |
| Ledger says otherwise (stale) | `prds/MASTER_PLAN.md:120`, `:530`; `prds/BUG-INDEX.md:137` |
| Judge scores all `allowed_paths` | `microverse-runner.ts:1644-1650` |
| Worker drops pre-existing lines | `extension/szechuan-sauce-principles.md`, `## False Positives`, bullet 1 |
| Both phases scope-fenced | `pipeline-runner.ts:2121`, `:2279` |
| Codex already a phase backend | `anatomy-park.md:59`, `szechuan-sauce.md:59`; `backend-spawn.ts:509`, `:519` |
| Judge pinned to claude on purpose | `microverse-runner.ts:2242-2246` |
| deep-pr-review verdict gate | `SKILL.md:184-193` |
| deep-pr-review AC blocking rule | `SKILL.md:178` |
| deep-pr-review stack-specific lenses | `SKILL.md:116-123` |
| citadel already does AC reconciliation | `citadel/ac-coverage-scorecard.ts`, `citadel/prd-parser.ts` |
| citadel TESTS lens is regex-only | `citadel/test-authenticity-audit.ts`, `citadel/skeptic-lens.ts` |
