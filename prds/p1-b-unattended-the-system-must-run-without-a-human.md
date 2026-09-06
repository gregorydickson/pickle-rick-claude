# B-UNATTENDED — everything required to run hands-off, and nothing else

---
title: "B-UNATTENDED — remove every reason a human must touch a running pipeline, and the verdict layer that keeps creating them"
status: draft
priority: P1
type: mega-bundle
composes: [gh-9, gh-11, gh-6, gh-8, gh-10, B-CLIBRITTLE, B-SZLEDGER, R-JPCM, verdict-layer-collapse, soak-self-skip, deploy-drift]
supersedes_scope_of: B-MEGADRAIN
---

## The bar

**A run completes, reports honestly, and needs no human.** Measured against that bar the system has not
been usable for months, and the evidence is specific, not atmospheric:

- **Releases beta.18–21 shipped `assets=0`** — the auto-updater had nothing to download. Fixed at
  beta.22; distribution is no longer the problem.
- **Across three bundles on 2026-09-04/05 a human intervened at least seven times**: hand-patching
  `SESSION_ROOT="$1"` at **every** launch (×3), committing an interrupted worker's tree, fixing a
  permission rule that had killed szechuan, re-running the self-skipping soak, closing deploy drift,
  starting Docker.
- **One operator run halted at 0 of 4 phases** on an informative note and needed a manual re-attach.
- **The verdict layer grew +31% LOC and +41% classifiers in nine weeks** (20,133 → 26,327 lines;
  34 → 48 `classify*`). Every fix added structure; nothing shrank.

**Ordering rule for this bundle: by what forces a human into the loop.** Not by priority tier, not by
elegance. ROOT 1 items were each performed BY HAND this week.

---

## ROOT 1 — THE PIPELINE CANNOT RUN WITHOUT A HUMAN (order FIRST)

1. **GitHub #9 — command-argument substitution rewrites `$1` in emitted `launch.sh` templates.**
   `pickle-pipeline.md:237` on disk is correct; the RENDERED prompt carried `SESSION_ROOT="--refine"`.
   Hand-corrected at **three** launches this session. Uncorrected, every artifact lands under a session
   root named after a flag. Five phase launchers share the shape. **Cheapest, highest-impact item here.**
2. **GitHub #11 — `manager_handoff_pending` halts the whole pipeline on an INFORMATIVE note.**
   Measured by replaying the shipped predicate over the live corpus: 41 conformance artifacts, 26 carry
   the header, **10 would halt — 24% of all tickets**, across five sessions. The gate tests whether a
   worker WROTE something, not whether an operator MUST ACT. Fix by subtraction: no third denylist arm.
3. **The deploy-lifecycle soak self-skips** (`refuses to mutate $HOME settings.json`) and a 16-second
   pass is not an 1800s soak. Every release currently needs a manual second run. Make it run, or make
   its skip loud and machine-visible — never a silent green.
4. **Deploy drift has no check.** Source and the deployed runtime diverged silently and were closed by
   hand. The installer does not bump the version, so a version match proves nothing: compare BY CONTENT.

## ROOT 2 — THE VERDICT LAYER THAT KEEPS CREATING ROOT 1

**26,327 lines vs 5,238 for the phase workers. 48 `classify*` predicates. Four overlapping state sets
(18 + 5 + 1 + 5). Seven boolean halt predicates, ~50 refs.** Across six recorded runs there were **zero
build failures** — every shortfall came from this layer.

A phase outcome has three shapes: **made progress · did not · could not measure**, plus the crash floor.

- **AC-2a** One disposition vocabulary; every surviving predicate derives from it. State before/after counts.
- **AC-2b** **Behaviour parity, exhaustively proven**: build the `(exit_reason × phase) → action` table
  from shipped code and from collapsed code and **diff them**. Differences are absent or named as
  intentional fixes with evidence. This is what stops a simplification silently changing halt behaviour.
- **AC-2c** No new abort condition. `MICROVERSE_FATAL_REASONS` stays at ONE member. Mutation-verify.
- **AC-2d** Net LOC across the three runners goes **DOWN**, stated as a number. **This is the grade.**
- **AC-2e** Instances that dissolve here, each verified rather than assumed — close
  `zero_diff_intent: already-satisfied` if the collapse already fixed them:
  **#6** (auto-commit hardcodes "worker timed out" on a branch that only tests a dirty tree —
  `microverse-runner.ts:4657`), **#8** (anatomy-park converges without INV-NO-SELF-DISOWN evidence),
  **#10** (`refinement_manifest.tickets` drops requirements with `all_success: true`).

## ROOT 3 — EXTERNAL COUPLING, UNOBSERVED

A `claude` CLI auto-update (**2.1.252 → 2.1.260, 2026-09-04 12:57 CDT**) disabled szechuan for five
days. Every run before it succeeded; every run after failed; nothing in this repo changed. Diagnosing it
took a four-session bisect because **`claude_version` appears nowhere in `src/`** while
`codex_version_seen` does.

- **AC-3a** Record the resolved CLI version in state at setup and at every backend spawn resolution.
- **AC-3b** A spawn that fails at STARTUP is detected as such, does not consume the full timeout, and
  does not burn all retries. (It burned 4 × 600s.) State measured before/after.
- **AC-3c** A startup/config failure is distinguishable from a measurement that ran and timed out.
- **AC-3d** Decide by measurement whether phase-critical spawns need ambient `.claude/settings*.json`
  at all. If not, stop inheriting it — that removes the coupling class.
- **AC-3e** Census every `claude` spawn site; each covered or recorded inert with the bound.
- **Non-goal:** pinning the CLI. That hides the coupling; the next upgrade is not optional forever.

## ROOT 4 — SZECHUAN: SPLIT THE GENERATOR FROM THE LOOP

`microverse-runner.ts:1999` already requires that for a count-type metric **`score` MUST equal
`violations.length`**, and `basis=ledger_count` exists at `:4332`. The judge spawns an LLM to produce a
number the ledger defines. **Discovery is real and stays; scoring is a tautology and goes.**

- **AC-4a** Verify `score === violations.length` across every recorded session **before relying on it**.
  State the sample size. **If it does not hold universally, STOP and report.**
- **AC-4b** Count-type score computed from the ledger, **no subprocess on the scoring path**.
- **AC-4c** `baseline_unmeasurable_*` unreachable for count metrics; enumerate the paths and show each gone.
- **AC-4d** The judge still DISCOVERS — deleting the discovery spawn must redden a test. Without this the
  redesign turns szechuan into a no-op that trivially converges at zero.
- **AC-4e** Folds in **R-JPCM** (prompt demands a bare number, parser demands JSON → ledger always empty)
  and **#7** (the worker never works the ledger the metric scores) — both dissolve under one ledger.
- **Non-goals:** do not delete the judge; do not retune a timeout on a path being removed; **do not touch
  anatomy-park's loop** — it works (423 commits, converged 2/2).

## Closer

Full release gate green with the soak **genuinely run**, a `ci-repro.sh --runner-release 24.04` run
naming the sha, **and a live pipeline run that completes 4/4 with zero human interventions** — that last
one is the bundle's actual acceptance.

## DELIBERATELY CUT — "exactly what we need"

Not lost; deferred to [[B-MEGADRAIN]] as the remainder parking lot. Cut because none blocks unattended
operation: `B-CGCAP` `B-CGPROBE` `B-CGHARD` `B-GIMA` `B-GSUB` `B-CIINT` `R-DPMC-3` `R-GRLS` `R-LSPC`
`R-APGG` `R-TCVC` `R-HNCG` `R-MVFM` `R-RWNF` `R-FOMH` `R-PSCG`, and GitHub **#5** (enhancement — bugs
before feature epics). `B-OFFREPO` also stays out: it is PARTIALLY shipped and needs a per-site
re-measure before it can be scoped at all.

**Every root above is either something a human did by hand this week, or the machinery that made them
necessary. If an item does not meet that bar, it does not belong in this bundle.**
