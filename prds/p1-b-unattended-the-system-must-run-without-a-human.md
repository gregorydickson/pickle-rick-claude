# B-UNATTENDED — replanned against the loop principle

---
title: "B-UNATTENDED — delete what stops the loop; fix what makes it converge falsely; record the rest"
status: draft
priority: P1
type: mega-bundle
composes: [gh-9, gh-11, gh-8, gh-10, B-CLIBRITTLE-decoupling, B-SZLEDGER, R-JPCM, gh-7, soak-self-skip, deploy-drift]
supersedes_scope_of: B-MEGADRAIN
---

## The filter (root `CLAUDE.md` → autonomous continuous loops)

**The filter ORDERS the work; it does not EXCLUDE it.** (a) Does it PREVENT THE NEXT ITERATION? (b) Does
it make the loop CONVERGE ON A FALSE ANSWER? Those come first and second. Everything else we have decided
to remediate comes third — **in this same bundle**, because the ~300-minute review toll is paid PER
BUNDLE, so deferring a row costs a whole second toll while carrying it costs almost nothing.

**No parking lot.** An earlier draft cut sixteen rows to a "remainder" bundle. That is how this plan
accumulated stale rows in the first place — a deferred row is a forgotten row. Everything we intend to
remediate is below.

**Two consequences, stated up front because they are counter-intuitive:**
- **Most of this bundle is DELETION.** Three of the four TIER-1 items are removals. A guard added per
  finding is how the verdict layer reached 26,327 lines against 5,238 for the workers, +31% LOC and
  +41% classifiers in nine weeks, **while build failures stayed at ZERO**.
- **TIER 3 is real work we are deliberately NOT doing.** Including one of the operator's own filed
  issues. Recording that honestly is the point of the filter.

---

## TIER 1 — PREVENTS THE NEXT ITERATION (order first; all four are deletions or near-deletions)

1. **GitHub #9 — `$1` rewritten in emitted `launch.sh` templates.** Rendered prompt carried
   `SESSION_ROOT="--refine"`; hand-patched at **three** launches on 2026-09-05. Uncorrected, every
   artifact lands under a session root named after a flag and the loop has nowhere to write. Five phase
   launchers share the shape. Cheapest item here, highest blast radius.
2. **GitHub #11 — `manager_handoff_pending` halts the run at 0/4.** Live-corpus replay of the SHIPPED
   predicate: 41 conformance artifacts, 26 carry the header, **10 halt — 24% of all tickets** across
   five sessions. **Fix by DELETING the halt, not by adding a third denylist arm.** The gate tests
   whether a worker WROTE something, not whether an operator must ACT. Also census
   `hasSubstantiveManagerHandoff`'s second consumer (`mux-runner.ts:2121`), which short-circuits one
   line before `batchLoopPhantomDoneKind` — the real evidence oracle. If it changes no outcome that
   oracle would not reach, the predicate deletes entirely.
3. **CLI coupling — stop inheriting ambient `.claude/settings*.json` in phase-critical spawns.** A
   `claude` auto-update (2.1.252 → 2.1.260, 2026-09-04 12:57 CDT) disabled szechuan for five days: every
   run before succeeded, every run after failed, nothing in this repo changed. A five-month-old benign
   permission rule became fatal. **The fix is decoupling (subtraction), not detection.** Plus: a spawn
   that fails at STARTUP must not burn 4 × 600s before reporting.
**⚠ THIRD CAUSE MEASURED 2026-09-06 — one disposition, THREE unrelated messages.** szechuan failed a
third time, again as `baseline_unmeasurable_unrecoverable`, again for a new reason:

| bundle | message |
|---|---|
| B-ARGMAX | `judge timed out after 600s` |
| B-FRESHWIN | `Permission allow rule … Write(.claude/commands/**)` rejected |
| **B-CIGREEN** | **`Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window.`** |

All three post-date the CLI upgrade (2.1.252 → 2.1.260, 2026-09-04 12:57 CDT). This is the single
strongest piece of evidence in this bundle: **one bucket has now absorbed three distinct failures**, and
that is precisely why two of them read as one recurring defect for two ticks.

**CORRECTION to an earlier claim of mine, published as measured.** I wrote that "the cost theory is
falsified" on the basis that the judge's scoped surface grew only 600 → 612 allowed_paths (2%) and
`extension/src` only 4.8% in bytes. **I measured the wrong size.** The size that matters is the judge's
CONTEXT consumption, which I never measured — and the autocompact message names exactly that. Cost is
back in play, in a form the earlier measurement could not see. Treat the earlier "falsified" line as
withdrawn.

**Which makes item 4 below the fix for all three at once:** no scoring spawn → no context to overflow,
no timeout to exceed, no ambient config to be rejected.

4. **szechuan scores its own ledger — delete the measurement spawn.** `microverse-runner.ts:1999`
   already requires `score === violations.length` for count metrics, and `basis=ledger_count` exists at
   `:4332`. The judge spawns an LLM to compute a number the ledger defines. Deleting the scoring spawn
   makes `baseline_unmeasurable_*` **unreachable** for count metrics — it cannot time out, cannot be
   rejected by a config validator, cannot exhaust retries. **Verify `score === violations.length` across
   every recorded session FIRST; if it does not hold universally, STOP and report.** The judge still
   DISCOVERS — deleting the discovery spawn must redden a test, or we have built a no-op that trivially
   converges at zero. Folds in **R-JPCM** and **#7**, which both dissolve under one ledger.

**4b. DELETE `services/pr-factory.ts` — it produced a destructive artifact and has no caller.**
Measured 2026-09-06: it is the **only** `gh pr create` in the tree, it passes **no `--base`**, and it
opened PR #12 from `release/v2.1-beta` into `main` (+160,042 / −17,687 across 643 files) — the stale 2.0
line, 1530 commits behind. Merging would have been destructive; the PR is closed. It has **no production
caller** (only its own test and the `services/CLAUDE.md` export-catalog row), it is referenced by zero
commands, skills or prompts, and a worker triggered its CLI guard while sweeping dead code — so it can
fire again on any run. **Delete the module, its test, and its catalog row.** Do NOT "fix" it by adding
`--base`: this repo does not use PRs (root `CLAUDE.md` → NO PULL REQUESTS), so the correct fix is
removal, not a correct argument.

**Sweep the class in the same ticket, and state the count:** every `git`/`gh` invocation that can
default to the repository default branch must name its target explicitly. Measured now: `release create`
sites already carry `--target` (B-RELTAG), and `pr-factory.ts:38` was the sole remaining offender — but
re-derive that rather than trusting this line.

## TIER 2 — MAKES THE LOOP CONVERGE ON A FALSE ANSWER

5. **GitHub #8 — anatomy-park declares convergence on an iteration with no INV-NO-SELF-DISOWN evidence.**
   A convergence verdict is exactly the loop's terminating answer; reaching it without evidence is
   textbook (b). It reported `completed successfully` twice this session.
6. **GitHub #10 — `refinement_manifest.tickets` drops requirements with `all_success: true`** (2 of 9).
   A success verdict over an incomplete enumeration; the loop converges having never seen the work.
7. **Deploy drift has no content check.** Source and runtime diverged silently and were closed by hand.
   Iterations then measure one tree while another ships. The installer does not bump the version, so a
   version match proves nothing — compare BY CONTENT.
8. **The soak self-skips** (`refuses to mutate $HOME settings.json`); a 16-second pass is not an 1800s
   soak. A green over an unrun leg is a false answer at release scale. Make it run, or make the skip
   loud and machine-visible — never a silent green.

## TIER 3 — THE REST OF THE BRITTLE CODE WE INTEND TO REMEDIATE (same bundle, lower order)

These neither stop the loop nor falsify convergence, so they do not gate TIER 1/2 — but they are brittle
code we have decided to fix, and a second bundle for them would cost a second full review toll.

**Every TIER-3 row is CANDIDATE, not verified.** An automated pass over the plan's status cells was
attempted and **misclassified six sweep-verified-fixed rows as live**. So each ticket re-runs the
mechanism check against HEAD — grep the MECHANISM, never the `R-` code — and declares
`zero_diff_intent: already-satisfied` in frontmatter up front when the premise proves stale. B-DRAIN13
closed two of thirteen that way; a stale row closed cheaply is a success, not waste.

**9. The classifier sweep.** Delete every predicate that CAN STOP THE LOOP and every classifier NOTHING
CONSUMES. 48 `classify*` + 7 boolean halt predicates (~50 refs) + four overlapping state sets
(18 + 5 + 1 + 5). This is a filter, not a target number — do not refactor a classifier that neither
halts nor lies. Report the before/after counts.

**10. GitHub #6** — auto-commit hardcodes `"worker timed out"` on a branch that only tests a dirty tree
(`microverse-runner.ts:4657`). A reporting defect: it changes no disposition and stops no iteration, but
it wrote a cause into git history that misled this session's own reporting twice. Name the condition the
branch actually tests.

**11. CLI version in session state** — `codex_version_seen` exists; `claude_version` appears nowhere in
`src/`. Diagnosing the 2.1.252 → 2.1.260 break took a four-session bisect. Decoupling (item 3) removes
the failure; this makes the next external change legible in the first log.

**12. `B-OFFREPO`** — PARTIALLY shipped. `AC-OFFREPO-1/-2a/-2c/-2d` are live across 8 files, but the
`<workingDir>/extension` keying still stands at 8+ sites in `mux-runner.ts` (`:917 :1170 :5716 :5947
:6698 :7800`). **Re-measure the five cited sites individually** — scoping it as written rebuilds shipped
work; closing it drops the live keying.

**13. The deferred drain-queue rows**, each verify-first: `B-CIINT` `R-GRLS` `R-LSPC` `R-APGG`
`R-DPMC-3` `B-GSUB` `R-TCVC` `R-HNCG` `R-FOMH` `R-RWNF` `R-MVFM` `R-PSCG`, and the codegraph cluster
`B-CGCAP` `B-CGPROBE` `B-CGHARD` `B-GIMA`.

**Still OUT:** GitHub **#5** (adopt Genesis's persistent-knowledge model) — an *enhancement*, and
dispatch order is bugs before feature epics. It is the only deliberate exclusion.

## Global ACs

- **AC-G1 Behaviour parity where anything is deleted:** build the `(exit_reason × phase) → action` table
  from shipped code and from post-change code and **diff them**. Differences are absent or named as
  intentional fixes with evidence.
- **AC-G2** No new abort condition. `MICROVERSE_FATAL_REASONS` stays at ONE member. Mutation-verify.
- **AC-G3** Net LOC across `mux-runner` + `pipeline-runner` + `microverse-runner` goes **DOWN**, stated
  as a number. Nine weeks of bundles added +6,194 lines while closing findings; if this bundle closes
  every root and that number is positive, **it failed.**
- **AC-G4 Acceptance is a live run, not a gate:** a pipeline completes **4/4 with zero human
  interventions**. Plus the full release gate with the soak genuinely run and a `ci-repro.sh` run naming
  the sha.

## [[B-MEGADRAIN]] is ABSORBED, not deferred

Its live roots are carried above. It is retired as a queued bundle rather than left as a remainder
parking lot, because a deferred row is a forgotten row and this plan already proved that.

## Global AC results — measured 2026-09-06 (ticket a375c09f)

Base = `13d96e1e` (bundle start commit). Head = `2ea102db`. Every number below is a measurement;
the command that produced it is named beside it.

### AC-G1 — behaviour parity: **MET**

Generator: `extension/scripts/audit-exit-reason-parity.mjs`. Neither table is written down — both
are derived by EXECUTING each ref's own committed, compiled `bin/pipeline-runner.js` and
`bin/mux-runner.js` (`git archive` the tree, import it, ask it). Six wires per cell:
`isFatalPhaseFailure`, `shouldHaltAfterPhase` at exit code 1 and 0,
`classifyMicroverseHaltDecision(...).action`, `isHaltExit`, `isFailureExit`.

The domain is the **UNION** of both refs' reason sets (39 reasons, incl. an `<absent>`
`exit_reason` row) × 4 phases = **156 cells** per ref. The union is load-bearing: a reason deleted
at head must still be probed at head, or this bundle's own deletion would be invisible to the very
check meant to catch it.

**4 of 156 cells differ, all four the same reason, and it is named:**

| exit_reason | phases | base | head |
|---|---|---|---|
| `manager_handoff_pending` | all 4 | `haltExit=true` | `haltExit=false` |

Evidence: TIER-1.2 gh-11 (`d304bd36`) — mux-runner no longer stamps `manager_handoff_pending` as
an exit_reason; it is a non-halting residual. Removed from `EXIT_REASONS` (`types/index.ts`), from
`isHaltExit` (`mux-runner.ts`, `:5347` at base) and from `PIPELINE_HANDOFF_EXIT_REASONS`
(`pipeline-runner.ts:4413`). `claimPipelineRunnerActive` still CLEARS the legacy value so a session
resumed across the upgrade is not stranded. This is the intended fix: a handoff residual must not
halt the pipeline. **Every other cell is byte-identical across the two refs.**

The audit is mutation-verified in both directions, so its green is not vacuous: emptying the
named-difference ledger reds it with 4 UNNAMED findings; declaring a difference that does not occur
reds it with 1 STALE finding. A named entry that stops occurring fails the same as an unnamed
difference — the ledger cannot rot green.

`cd extension && node scripts/audit-exit-reason-parity.mjs --base 13d96e1e --head HEAD` → exit 0.

### AC-G2 — no new abort condition: **MET**

`MICROVERSE_FATAL_REASONS` is unchanged between the refs and still has exactly ONE member,
`session_state_corrupted` (`extension/src/types/index.ts:1522-1524`).

Pinned in two fast-tier suites — `tests/nostop-gates-invariant.test.js:434` and
`tests/oneabort-termination-invariant.test.js:207` (plus AC-M7 at `:398-403`). No third copy was
added; the pins already exist and duplicating them would add a case rather than collapse one.

**Mutation-verified.** Adding a second member to the array and recompiling (the suites import the
compiled `../types/index.js`, so recompiling is what makes the probe real):
- `./node_modules/.bin/tsc` still exits **0** — the type system alone does NOT catch a widened
  crash floor. The pin is the only thing that does.
- the suites go **113 pass / 0 fail → 109 pass / 4 fail**, and the one-member pin fires by name in
  BOTH suites, plus two collateral assertions (`the effective set is 10 reasons`, `the null score
  maps to baseline_unmeasurable_unrecoverable, never the crash floor`).
- restored from a file backup and recompiled → **113/113 green**, `git diff` on
  `src/types/index.ts` and `types/index.js` empty.

### AC-G3 — net LOC: **NOT MET**

| file | 13d96e1e | 2ea102db | delta |
|---|---|---|---|
| `extension/src/bin/mux-runner.ts` | 14,849 | 14,878 | +29 |
| `extension/src/bin/pipeline-runner.ts` | 5,614 | 5,619 | +5 |
| `extension/src/bin/microverse-runner.ts` | 5,864 | 6,004 | +140 |
| **total** | **26,327** | **26,501** | **+174** |

The 26,327 baseline was RE-DERIVED at `13d96e1e`, not copied from the plan, and matched exactly —
so the delta is admissible.

**The number is +174. It is POSITIVE. By this PRD's own standard, AC-G3 FAILED.** Recording it
rather than reframing it: a degraded run reports its degradation and withholds the success verdict.

Attribution (`git show --numstat` per commit over the three files; sums to +174 exactly):

| commit | net | what |
|---|---|---|
| `ba977db6` | **+104** | TIER-1.3 B-CLIBRITTLE — decouple judge spawn from ambient CLI settings |
| `328fb2e2` | **+36** | TIER-2.5 gh-8 — anatomy-park INV-NO-SELF-DISOWN convergence evidence |
| `d304bd36` | **+33** | TIER-1.2 gh-11 — delete the `manager_handoff_pending` halt |
| `da7779cd` | +1 | TIER-3.9 — delete `MICROVERSE_FAILURE_REASONS` + `isMicroverseFailureExit` |
| `9dcde2f2` | 0 | TIER-3.10 — auto-commit message states the observed condition |
| `b5d885c4` | 0 | TIER-1.4 — derive judge score from `violations.length` |

The honest reading: the two deletion tickets (`da7779cd`, `d304bd36`) did remove enumerated sets,
but each replaced them with prose and guard code that cost more lines than the members it removed —
`d304bd36` is net **+33** despite "delete" in its subject. The +174 is dominated by `ba977db6`
(+104), which added capability rather than removing a distinction. **The bundle closed roots but did
not subtract**; the growth-against-findings pattern this PRD names is NOT broken by this bundle.

### AC-G4 — live 4/4 unattended run: **OPERATOR-OWNED, not observed from here**

Acceptance is a live pipeline completing 4/4 with zero human interventions, plus a full release
gate with the soak genuinely run and a `ci-repro.sh` run naming the sha. That is observed by the
operator from the run this ticket executes inside; a worker cannot see its own run's intervention
count. **Status reported, not simulated.** No claim is made here in either direction.
