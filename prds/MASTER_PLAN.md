---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Live ledger.** The babysitter (`babysitter.md`) re-reads this each tick, so it is kept lean
on purpose. Shipped-release detail and closed-finding forensics live in
[`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) + `git log`; the full finding catalog is in
[`BUG-INDEX.md`](BUG-INDEX.md).

**Updated 2026-06-21.** Shipped + deployed through **v2.0.0-beta.22** (B-PCOMP). The two seams that
broke *every* hands-off run — **R-RCFF** (start gate false-halts additive bundles) and **R-CECB**
(finish gate salvage-discards a committed ticket) — are **FIXED** in B-PCOMP, collapsed to ground-truth
gates (readiness reads the bundle creation set; completion reconciles against the branch). **First green
field-proof:** a real additive bundle (R-WSDO) ran **4/4 phases end-to-end hands-off, zero
intervention** (84m) on the deployed runtime — zero salvage-loops, zero `done_without_commit_evidence`.
**GA (drop `-beta`) now gates ONLY on field-soak repeatability: 1 of ~3–5 representative hands-off runs
done** — need ≥1 **live multi-ticket** additive bundle (R-WSDO was single-ticket; R-CECB recurred
*per ticket*) + 2–3 more reps at a low intervention rate. The GA-readiness ledger (next step) is the
soak. **Caveat:** B-PCOMP itself could not self-build (R-PSRB self-referential catch-22 — a bundle that
edits the recovery machinery); documented build protocol = hand-build recovery-path tickets, then deploy.

## Status

| Item | Value |
|---|---|
| Version (source = deployed) | **v2.0.0-beta.22** — B-PCOMP pipeline-completion fixes + R-WSDO; deployed via install.sh 2026-06-21. |
| Latest GitHub release | **v2.0.0-beta.22** (B-PCOMP + R-WSDO; prerelease). Prior: beta.21 #129 R-SSOC · beta.20 #128 R-TDCS · beta.19 #127 R-DEFCHURN. |
| Codex backend | `gpt-5.4` |
| Gate posture | Ship on the **local** gate (tsc + eslint + audits + fast-c4 + integration + expensive). **CI-green = hygiene, never a release gate.** |

**Directives.** Drain bugs before features, P1 > P2 > P3. The babysitter drains the entire plan
with **zero operator interaction**, including the full release cycle (`git push` + `gh release
create`), gated only on a green local gate + clean tree. Sole permitted residue: external-event-
gated work. Every bundle PRD carries a `## Simplification Review` (subtract-before-add) — see
[`CLAUDE.md`](CLAUDE.md).

**GA path (evidence-first).** GA gate = honesty ✅ + stability-surface ✅ + completion-bugs-fixed ✅
(B-PCOMP, beta.22) + **field-soak repeatability 🟡 (1 of ~3–5 done).** The two completion-breaking
seams are now collapsed to ground-truth gates and **live-proven once** (R-WSDO, 4/4 hands-off). The
remaining GA work is the **field-soak**: run ~3–5 representative bundles via `/pickle-pipeline`
(scoped — small bundles use `--scope branch`; an unscoped 1-event bundle made anatomy/szechuan review
the whole tree for 84m), INCLUDING ≥1 live multi-ticket additive bundle; record every intervention
point → ranked intervention-rate report = the GA-readiness ledger. Drop `-beta` once repeatability
holds (no new completion-class seam across the soak). Now-cheap to fix any new seam (gates deployed).

---

## ▶ Governing strategy (2026-06-23): Reliability Plan

**`prds/RELIABILITY-PLAN-2026-06-23.md`** is now the governing strategy (Codex-adversarial-reviewed;
verdict *ship with changes*, folded in). It reframes the drain queue from bug-by-bug to **5 structural
meta-defects** (completion-oracle plurality · scope-fence under/over-extend · recovery sprawl ·
guards-on-guards · self-build trap). Sequencing status (all buildable-now work **BUILT + verified on `main` `f547b22f`**, deploy held for soaks):
**(1) B-DURA core** ✅ MERGED (T10–T50: durable boundary commit + 7-site Done-flip gate + one readEvidence
oracle + Failed-terminal phase-advance + no-premature-drain). **(3) Subtraction cluster** ✅ BUILT — T60
`05650df1` (delete `allow_inferred_completion_commit`), T70 `71996fe8` (collapse `EvidenceKind` 4→2, delete
shim + dead variant, narrow Pass-1 grep), R-REIN `3c48d7ae` (recovery-budget refund on reset). **(4) WS-2
run-blockers** ✅ BUILT — refine fence `5ad07e3c`, oversized split `b60a112e`, toolchain fail-fast `7b69f22a`,
R-SIGF advisory flag `a668687f`. **(5) WS-5** ✅ BUILT — advisory subtract-before-add audit `9164f14d`
(`audit-subtract-before-add.sh`). Full post-merge gate green (tsc/eslint/audits/20 new WS tests/201 mux).
**REMAINING (deploy-gated, your soak window):** **(1-deploy)** `install.sh` the whole stack; **(2) prove on
codex** (AC-DURA-4, re-run LOA-1363/1488 — codex multi-ticket is the loudest failure, 0-for-3); then the wide
oracle characterization net + GA soak. **Primary metric:** hands-off soak truthfulness + manual-intervention
rate (trap-door count secondary). **Self-build (old WS-4): cut** — freeze autonomous self-build for recovery
bundles, formalize the hand-build protocol; revisit post-GA only if hand-build is the bottleneck.

### GA field-soak (the metric for the above)

**The GA-readiness soak** (drop `-beta`) is the reliability metric. Run **~3–5 representative bundles**
hands-off via `/pickle-pipeline`, INCLUDING **≥1 live multi-ticket additive bundle** (R-WSDO was
single-ticket). Use `--scope branch` for small bundles (an unscoped 1-event bundle made anatomy/szechuan
review the whole tree for 84m). *Record* every intervention point (don't rescue unless data at risk) →
ranked intervention-rate report = the GA-readiness ledger. **Soak ledger: 1 clean (R-WSDO, claude,
single-ticket, 4/4 hands-off) + codex multi-ticket 0-for-2** — both LOA-1363 runs finished `0/4`: run 1
→ [[R-CECX]] (no-commit + cross-iteration corruption), run 2 (post-recovery, deps installed, build
GREEN: 12 commits / 978 tests 0-fail) → [[R-PFNT]] (evidence-oracle disagreement + `Failed` non-terminal
masks a green build). **GA on codex is blocked on R-CECX + R-PFNT; the claude-backend repeatability soak
is unaffected.** Note both are post-B-PCOMP finish-gate seams on the codex/multi-ticket matrix that
B-PCOMP's R-WSDO proof (claude/single-ticket) never covered. Candidate soak PRDs: pick from the deferred/open rows below (e.g. a real
multi-ticket bug bundle) or the backlog. Drop `-beta` when repeatability holds with no new
completion-class seam.

## Drain Queue — shipped + remaining (deferred / blocked / external-gated)

| # | Item | Pri | State | Source |
|---|------|-----|-------|--------|
| **B-PCOMP** | **B-PCOMP — beta 2.0 pipeline completion** — ground-truth gates at both boundaries (WS-D1=B-RFCU start gate + WS-D2 finish gate) | **P1** | **✅ SHIPPED v2.0.0-beta.22 (2026-06-21) + LIVE-PROVEN.** First green hands-off field-proof: the R-WSDO bundle ran **4/4 phases end-to-end with ZERO intervention** (84m, `pipeline-completed`), zero salvage-loops / zero done_without_commit_evidence — the exact pathology that broke every prior run. Fixes: `400fe433` salvage clean-tree back-fill, `aff2cfd4` bystander stash-not-commit, `b20a4c1a` R-OMTD orphan-mux reap, `fae9c590` e2e mechanism proof, start-gate WS-D1 (`26125e91`/`e9e55fc8`/`c08bb0d3`), WS-D2-1 attribution (`8b4f75c6`). Agent-team hand-built (R-PSRB catch-22). Full local gate green (tsc/eslint/10 audits/integration 513+486-0/fast-c4 6637-0). **GA (drop -beta) gate = field-soak repeatability: 1 of ~3-5 representative hands-off runs done (need ≥1 live multi-ticket).** Prior state: **IN BUILD 2026-06-21.** Start gate (WS-D1) ✅ committed (26125e91/e9e55fc8/c08bb0d3). WS-D2-1 branch attribution ✅ committed (8b4f75c6). 6-agent team re-understood the build failures + re-planned for simplification: **8 remaining tickets → 4 build steps** (3f6800f3 CUT = already-shipped artifact-delta reap; 0a1ce691 narrowed to reuse the shipped `readEvidence` oracle, NOT export `scanGitLog` which would break R-AFCC-CALLER-ENUMERATION; 4 hardening → 1; R-OMTD orphan-mux teardown folded in). Build via hand-build agent team (R-PSRB catch-22 forbids autonomous self-build). **Done = 4/4 phases hands-off e2e.** All 4 build steps ✅ committed (`400fe433` salvage clean-tree back-fill / `aff2cfd4` bystander stash-not-commit / `b20a4c1a` R-OMTD orphan-mux reap / `fae9c590` 4/4-phase hands-off e2e). **Quality-closure 3-pass hardening ✅ done** (NEW-quality-closure): code+data-flow review clean (no P0/P1), +A6 headSha-null rejection test, 3 new invariants documented with enforcing trap doors + ENFORCE tests in `extension/CLAUDE.md` + `extension/src/bin/CLAUDE.md`. Pending: deploy (install.sh) + release. See "Revised Build Plan" in the PRD. | `p1-beta2-pipeline-completion-2026-06-20.md` |
| **B-DURA** | **B-DURA — durable iteration boundary** (R-CECX fix; **the cluster subtraction**). Runner commits the ticket's gate-passing work at every iteration boundary; Done-flip + context-clear gated on a durable runner-authored commit existing. Closes both R-CECX faces (committed-nothing + cross-iteration clobber) with ONE invariant, then **subtracts** the evidence-archaeology layer (`allow_inferred_completion_commit` deleted; `EvidenceKind` collapsed; R-CCRC fuzzy grep narrowed; B-PDBL backfill-loop class removed). Larger-sense thesis: 13 incidents / 49 days, 77% additive fixes; the invariant already exists at `send-to-morty.md:100` ("NEVER flip Done before the commit exists") but is **worker-side prose** — B-DURA relocates it to **runner-code**. | **P1** | **CORE BUILT + MERGED to `main` 2026-06-23 (`484ea208`).** Refined → 13 tickets; load-bearing T10–T50 **hand-built on claude (R-PSRB) + independently verified** (tsc/eslint/8 audits/238 ticket-tests green; boundary committer wired @10793; `boundary_commit_resolved` emitted; `isFailedTicketTerminalExcludable` at 4 advance sites; `isPendingMuxTicket` + forbidden `*_tickets` invariants honored): T10 `e1472c37` / T20 `b032be1a` / T30 `be667dee` / T40 `f788aa43` / T50 `cda99b33`. The autonomous `/pickle-pipeline` confirmed the R-PSRB wedge (T10 Failed under pre-fix runtime) → switched to hand-build. **PENDING:** `install.sh` deploy (held — live LOA-1363/1488 soaks); then codex AC-DURA-4 proof; then T60–T70 subtraction + R-REIN + WS-2 run-blockers per the Reliability Plan. Full fast-suite confirmation pending soak window (every completing gate green). | `p1-durable-iteration-boundary-2026-06-22.md` · `RELIABILITY-PLAN-2026-06-23.md` |
| R-PFNT | **R-PFNT** green build reports `0/4 phases` (codex multi-ticket) — **B-PCOMP finish-gate NOT a single oracle.** (1) phantom-Done watcher ACCEPTS `b17cc3fe` (`valid completion_commit evidence` ×3) while flip-gate `readEvidence()` FATALS it (`kind==='absent'`) on the SAME frontmatter (`completion_commit: 9adfed909` present) — two oracles, opposite verdicts; the fatal demands a `completion_commit` already there. (2) `wmw-auto-skip` flips all 3 detached `large`-tier hardening tickets → `Failed/oversized_no_progress` (misclassifies scope-fence-ambiguity stall as "oversized"). (3) `Failed` is non-terminal for phase advance → 3 failed *polish* tickets atop 10 Done verified-green *build* tickets → `Pipeline finished: 0/4 phases` and citadel/anatomy/szechuan never run. Independently verified at halt: 12 commits, typecheck clean, **978 tests 0-fail**, 22/22 files lint-clean. | P1 | **OPEN / capture-only (2nd GA-soak codex multi-ticket run — also 0/4 on a GREEN build; matrix 0-for-3 (run 3 = LOA-1488, 2026-06-23: build 12/17 durable + correct attribution on 11 — see R-CECX Run-3 addendum; blocker narrowed to one-off missed-tag + premature phase-queue drain at iter 49/500)).** Recovery: build is green → drop the complete `pickle` phase from `pipeline.json`, relaunch `["citadel","anatomy-park","szechuan-sauce"]`. Proposed (capture): one `readEvidence` oracle that honors `completion_commit` frontmatter as `explicit`; treat `Failed` as terminal + advance when all non-Failed Done & diff non-empty; split `oversized_no_progress`→`scope_unresolvable`/`no_progress_timeout`; Step-7e template must emit a concrete `## Files to modify/create` fence; fail-fast on absent toolchain. **GA on codex blocked on R-CECX + R-PFNT.** | `BUG-REPORT-2026-06-23-green-build-reports-0-of-4-evidence-oracle-disagreement-and-failed-nonterminal.md` |
| R-SIGF + R-REIN | **R-SIGF / R-REIN — tickets-not-completing (LOA-1488 run 3, 2026-06-23).** Two NEW root causes behind hardening tickets never completing, distinct from R-PFNT's "oversized misclassification." **R-SIGF (scope-fence signature fan-out):** ticket 60 correctly added `StatementAnalyzerHealthService` as the 14th `LangGraphService` ctor injection, but sibling spec `appraisalEvaluation/buildAppraisalEvaluationGraph.spec.ts` instantiates it positionally (13 mocks) → `tsc` RED at 6 sites. That file is **outside the bundle's MODIFIED_FILES scope fence**, so NO fenced worker could fix it; build stayed RED → the data-flow + test-quality hardening tickets failed their typecheck gates indefinitely (presenting as `oversized_no_progress`, a misleading symptom). Fence must auto-extend to positional callers of a changed injected/exported signature (or readiness must flag signature-change-without-caller-co-scope). **R-REIN (recovery-exhausted inert on reset):** flipping a Failed ticket `status → Todo` + relaunch does NOT refund the per-ticket recovery counter → phase re-exits `exit_reason=recovery_exhausted` in ~2s with no re-attempt, so the documented "reset to Todo + relaunch" recovery is INERT once the ladder is spent. **Operator recovery (verified):** hand-fix the out-of-fence arity break (commit `ccad8c39e`), pin `scope_base` to the merge-base SHA to undo the moved-`main` phantom diff (see R-CECX Run-3 follow-up facet 3), then R-PFNT drop-pickle → review phases. | P2 | **OPEN / capture-only — found while babysitting the LOA-1488 codex run; forensics in the R-CECX Run-3 follow-up.** Candidate fold-in to B-DURA (R-REIN: refund recovery budget on explicit status-reset) and a new scope-fence AC (R-SIGF: signature-change caller fan-out). | `BUG-REPORT-2026-06-22-codex-backend-completion-evidence-fatal-and-cross-iteration-work-corruption.md` |
| R-CECX | **R-CECX** codex-backend `done_without_commit_evidence` fatal + cross-iteration work corruption (multi-ticket) — **B-PCOMP recurrence on the unproven codex + multi-ticket path** (exactly the R-CECB residual: "GA soak still needs ≥1 LIVE multi-ticket run"). Codex workers committed NOTHING (`git log main..HEAD` empty) → WS-D2 finish gate has nothing to reconcile → 0/4 phases (no salvage-loop — the committed-but-unattributed path B-PCOMP fixed never triggers because there is no commit at all). Worse: a ticket flipped **Done with its code absent** and a later context-cleared ticket rewrote shared registry files from the stale base (floor → 18 while only 17 rules exist → module throws at import). | P2 | **OPEN — fix DRAFTED as B-DURA (row above).** First live **multi-ticket** + first **codex** soak run; both gaps B-PCOMP's R-WSDO proof never covered. Recovery (verified): reset corrupted tree to clean base + R1/R2 status→Todo + `state.flags.allow_inferred_completion_commit=true` + relaunch. **GA on codex must NOT drop `-beta` until B-DURA ships or codex is documented claude-only for hands-off.** | `BUG-REPORT-2026-06-22-codex-backend-completion-evidence-fatal-and-cross-iteration-work-corruption.md` |
| B-RFCU | **B-RFCU** readiness forward-created unification (= B-PCOMP **WS-D1**, start gate; R-RGO/R-RPRA/R-QGSK/**R-RCFF** family) | P2 | **✅ SHIPPED-IN-BUNDLE (committed, not yet released) 2026-06-21** as B-PCOMP WS-D1 — `26125e91`+`e9e55fc8` (contract/symbol resolver wired to creation index) + `c08bb0d3` (annotation-omission robustness + audit parity). Both start-gate tickets Done hands-off. Deploy + release rides with B-PCOMP. | `p2-readiness-forward-created-unification-2026-06-20.md` |
| R-SLEAK | **R-SLEAK** (+ R-PSRB/R-OMTD/R-WSDO context) — session/process leak + contention-gauge | P3 | **PARTIAL — R-OMTD ✅ + R-WSDO ✅ SHIPPED beta.22; R-PSRB documented; R-SLEAK OPEN.** **R-OMTD (`b20a4c1a`):** pipeline-runner spawns mux children `detached` + reaps the subtree via `reapChildSubtree`/negative-PID on teardown (no more PPID-1 orphans). **R-WSDO (`177b84a7`):** `worker_produced_nothing` breadcrumb shipped. **R-PSRB (design, documented — not a code fix):** recovery-machinery bundles can't self-build (deployed pre-fix runtime salvage-resets the ticket building the fix); build protocol = hand-build recovery-path tickets then install.sh-deploy. **R-SLEAK (OPEN, P3 hygiene):** leaked tmux sessions + orphan runners persist for days; `pgrep -f claude` over-counts (matches node runners + own shell) → real worker-contention gauge is `ps -eo command \| grep -E '/claude '`. Session-GC unbuilt. | `BUG-REPORT-2026-06-21-pipeline-self-referential-build-catch22-and-orphan-mux.md` |
| 124 | **R-DPMC-3** decomposition-satisfiability residual | P2 | **DEFERRED** — large additive machinery; needs operator sign-off (R-DPMC-1/-2 already shipped: B-DECOMP-SAT beta.17 / B-GROUND2 beta.16). | `archive/bundles/p2-bug-fix-bundle-b-decomp-sat-decomposition-satisfiability-2026-06-18.md` |
| 125 | **B-GSUB** functional seam-collapse | P2 | **DEFERRED** — the next-week GA soak ranks which seam to collapse first; pure-doc track already closed (−9). | `archive/bundles/p2-simplification-pass-guard-inventory-subtraction-2026-06-18.md` |
| 119 | **B-CIINT** integration-tier CI-env e2e failures | P3 | **OPEN** — Linux-CI-only subprocess-e2e flakiness; CI hygiene, **not a release gate**. Pass locally (macOS). | `archive/bundles/p3-bug-fix-bundle-b-ciint-integration-tier-ci-env-e2e.md` |
| — | **B-CGCAP** codegraph default-on (v2.1) | P2 | **DEFERRED post-GA** (reliability-first / capability-second). | `p2-codegraph-default-on-capability-v2.1.md` *(pinned)* |
| 13 | **B-DWF-2** retire legacy refinement subprocess | P3 | **⏸️ SHELVED** — soak-harness prereq unmet; legacy path retained for zero regression. | `archive/bundles/p3-bug-fix-bundle-b-dwf2-retire-refinement-subprocess.md` |
| 25 | **R-CSI** concurrent-session destructive-command interference (DATA-LOSS class) | P1 | **EXTERNAL-GATED** — re-activates on the next real concurrent-session incident to analyze. | `archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md` |
| — | **R-RCFF** readiness false-halts on forward-created schema field-paths (start gate) | P3 | **✅ FIXED v2.0.0-beta.22 (B-PCOMP WS-D1).** Readiness contract/symbol resolver now consults the bundle creation index + annotation-omission robustness (`26125e91`/`e9e55fc8`/`c08bb0d3`) — additive bundles pass the start gate with no skip flag. Live-confirmed: R-WSDO additive bundle passed readiness 0-blocking. R-RGO/R-RPRA/R-QGSK family closed at the start boundary. | `BUG-REPORT-2026-06-20-readiness-contract-resolver-forward-created-schema-fields.md` |
| — | **R-CECB** completion-evidence fatal on CLAUDE backend; salvage-discards a committed ticket (finish gate) | P3 | **✅ FIXED v2.0.0-beta.22 (B-PCOMP WS-D2).** Salvage clean-tree back-fill from the shipped `readEvidence` oracle (`400fe433`) — a committed-green ticket with no `completion_commit` stamp reaches `committed-done`, never the `done_without_commit_evidence` fatal/salvage-loop; bystander work stashed not discarded (`aff2cfd4`); `allow_inferred_completion_commit` advice demoted. Live-confirmed: R-WSDO ran 4/4 hands-off, zero salvage-loops. **Residual class note:** multi-ticket per-ticket behavior is mechanism-tested (e2e) but the GA soak still needs ≥1 LIVE multi-ticket run. | `BUG-REPORT-2026-06-20-completion-evidence-fatal-claude-backend-strands-bystander-ticket.md` |

> Everything else has shipped. For the chronological record of the ~60 shipped bundles and the
> ~244 closed findings, see [`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) and
> [`BUG-INDEX.md`](BUG-INDEX.md). Feature epics (R-PGI v1.83.0 · R-PIAP v1.84.0 · R-DC v1.85.0 ·
> B-DWF v1.91.0 · B-HERMES · B-CBI · B-DSEK) are all shipped or shelved.

---

## Engineering Rules

Detail in `extension/CLAUDE.md` + `citadel.md`. Quick form:

1. **Atomic PRs** — one ticket per PR, independently revertible.
2. **Full release gate** — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` (+ audit scripts + `RUN_EXPENSIVE_TESTS=1 npm run test:expensive`). Green before tag.
3. **Source-of-truth** — edit `extension/src/*.ts` + `.claude/commands/*.md`; `bash install.sh` to deploy. Never edit `~/.claude/pickle-rick/`.
4. **Trap-door preservation** — every `extension/CLAUDE.md` invariant has an enforcing test.
5. **Hook decisions** — `"approve"` / `"block"` only.
6. **CLI guard** — `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`.
7. **Error handling** — `const msg = err instanceof Error ? err.message : String(err);` at boundaries.
8. **Versioning** — semver in `extension/package.json`; single bump per bundle at the closer.
9. **No dirty release** — all changes committed before tag; compiled JS matches TS source.
10. **Greenfield** — no legacy aliases, no backward-compat shims.

---

## Quick Reference

```bash
/pickle-status                       # formatted current session
/pickle-metrics                      # token/commit/LOC report
/pickle-prd                          # interview then PRD
/pickle-refine-prd <prd>             # 3-cycle decomposition
/pickle-tmux <prd>                   # launch ticket pipeline (tmux, all sizes)
/pickle-pipeline <prd>               # pickle, citadel, anatomy-park, szechuan-sauce
gh release create vX.Y.Z             # tag + publish
```

**Resume an active loop:** `node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --resume <SESSION_ROOT>`.
Closer manager-handoff runbook: `../docs/closer-ticket-manager-handoff.md`. Babysitter: `babysitter.md`.
