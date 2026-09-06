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
