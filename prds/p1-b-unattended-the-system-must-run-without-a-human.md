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

**Only a defect that (a) PREVENTS THE NEXT ITERATION FROM HAPPENING, or (b) makes the loop CONVERGE ON A
FALSE ANSWER, earns code. Everything else is recorded and left alone.** Every item below is placed by
that filter and nothing is here because it is annoying, untidy, or merely wrong.

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
4. **szechuan scores its own ledger — delete the measurement spawn.** `microverse-runner.ts:1999`
   already requires `score === violations.length` for count metrics, and `basis=ledger_count` exists at
   `:4332`. The judge spawns an LLM to compute a number the ledger defines. Deleting the scoring spawn
   makes `baseline_unmeasurable_*` **unreachable** for count metrics — it cannot time out, cannot be
   rejected by a config validator, cannot exhaust retries. **Verify `score === violations.length` across
   every recorded session FIRST; if it does not hold universally, STOP and report.** The judge still
   DISCOVERS — deleting the discovery spawn must redden a test, or we have built a no-op that trivially
   converges at zero. Folds in **R-JPCM** and **#7**, which both dissolve under one ledger.

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

## TIER 3 — RECORD, DO NOT FIX (fails the filter; listed so the decision is explicit, not silent)

- **GitHub #6 — auto-commit hardcodes "worker timed out" on a branch that only tests a dirty tree**
  (`microverse-runner.ts:4657`). Real, and it misled this session's reporting twice. But it changes no
  disposition, stops no iteration and falsifies no convergence — **it is a reporting defect.** Under the
  filter it earns a record, not code. *If* the TIER-1/2 work touches that line anyway, correct the
  message in passing; do not schedule a ticket for it.
- **Recording the CLI version in state.** Would have turned a four-session bisect into one log line —
  but it is diagnostic convenience, not a loop defect. Decoupling (item 3) removes the failure; this
  only labels it. Reconsider *after* item 3, if a second external break lands.
- **"Collapse 48 classifiers" as a standalone goal.** Replaced by a filter, not a target number: delete
  every predicate that CAN STOP THE LOOP (items 2, 3) and every classifier NOTHING CONSUMES. LOC down is
  the grade; the filter is the method. Do not refactor a classifier that neither halts nor lies.

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

## CUT to [[B-MEGADRAIN]] (remainder parking lot)

`B-CGCAP` `B-CGPROBE` `B-CGHARD` `B-GIMA` `B-GSUB` `B-CIINT` `R-DPMC-3` `R-GRLS` `R-LSPC` `R-APGG`
`R-TCVC` `R-HNCG` `R-MVFM` `R-RWNF` `R-FOMH` `R-PSCG`, GitHub **#5** (enhancement), and `B-OFFREPO`
(partially shipped — needs a per-site re-measure before it can be scoped at all).
