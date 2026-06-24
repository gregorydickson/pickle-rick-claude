---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Live ledger.** The babysitter (`babysitter.md`) re-reads this each tick, so it is kept lean
on purpose. Shipped-release detail and closed-finding forensics live in
[`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) + `git log`; the full finding catalog is in
[`BUG-INDEX.md`](BUG-INDEX.md).

**Updated 2026-06-24.** Shipped + deployed through **v2.0.0-beta.24** (B-RPGT). The **known reliability
defect classes are now all code-fixed at root**: the 14-incident completion-commit/Done-flip cluster
(B-PCOMP beta.22 start/finish gates + **B-DURA beta.23** durable-iteration-boundary core, evidence-archaeology
layer deleted), AND the independent review-phase 0/4 cause (**B-RPGT beta.24**: review/cleanup phases can no
longer converge over a tsc/eslint-RED tree, and a transient 529 no longer aborts a 3-hr pipeline — both
reuse-first, no new machinery).

**Reliability scorecard.** Code/mechanism ✅ — the most-fixed it has ever been. claude field-soak 🟢 — **2 clean
hands-off runs, now incl. a live MULTI-TICKET ADDITIVE bundle** (B-RPGT: 5 tickets, 4/4 phases, 178m, ZERO
mid-run intervention, the 529-abort bug never fired, anatomy-park self-hardened the new code) — the exact run
the soak required. codex field-soak 🔴 — **still 0-for-3, NOT re-run post-fix.** The reliability *code* is
proven on claude and unproven on codex; that gap is the whole remaining GA story.

**Autonomous-development scorecard.** The build→citadel→anatomy-park→szechuan-sauce pipeline now runs a real
multi-ticket additive bundle **fully hands-off on claude** (B-RPGT). Remaining autonomy gaps, in order of bite:
(a) the **closer** (version bump · `install.sh` deploy · `gh release`) is NOT auto-run by `pipeline-runner` —
it finishes 4/4 then stops, so a babysitter still ships; (b) **recovery-machinery bundles can't self-build**
(R-PSRB) — must hand-build; (c) per-phase gates don't run the FULL release gate, so debt surfaces at the
closer (B-RPGT's closer caught pre-existing gate-parity drift + 2 over-limit trap-door entries the review
phases added — tsc/eslint-clean but tripping AC-BUNDLE-17).

**THE single highest-value next step remains the codex AC-DURA-4 field-proof** — the only thing that converts
the codex 🔴 to evidence and unblocks GA.

## Status

| Item | Value |
|---|---|
| Version (source = deployed) | **v2.0.0-beta.24** — B-RPGT review-phase typecheck gate + transient-529 park (R-RPGT + R-S529); deployed via install.sh 2026-06-23. |
| Latest GitHub release | **v2.0.0-beta.24** (B-RPGT; prerelease, NOT codex-proven). Prior: beta.23 B-DURA + reliability program · beta.22 B-PCOMP+R-WSDO · beta.21 #129 R-SSOC. |
| Test-hygiene follow-ups (non-blocking) | (1) **hardcoded-date fixture time-bombs** — beta6-ga-session-resume's `started_at: 2026-06-15` aged past `pruneOldSessions` and broke the test (fixed via dynamic date); audit for other hardcoded ISO dates in fixtures. (2) **R-OMTD test leaks subprocesses** — pipeline-runner-orphan-mux-teardown leaves `mux.js`/`grandchild.js` running on failure; needs `afterEach` cleanup (65 leaked over one session choked the local gate). |
| Codex backend | `gpt-5.4` |
| Gate posture | Ship on the **local** gate (tsc + eslint + audits + fast-c4 + integration + expensive). **CI-green = hygiene, never a release gate.** |

**Directives.** Drain bugs before features, P1 > P2 > P3. The babysitter drains the entire plan
with **zero operator interaction**, including the full release cycle (`git push` + `gh release
create`), gated only on a green local gate + clean tree. Sole permitted residue: external-event-
gated work. Every bundle PRD carries a `## Simplification Review` (subtract-before-add) — see
[`CLAUDE.md`](CLAUDE.md).

**GA path (evidence-first).** GA gate = honesty ✅ + stability-surface ✅ + completion-bugs-**code-fixed** ✅
(B-PCOMP beta.22 + **B-DURA beta.23**, the cluster root) + review-phase-gate-gaps-**code-fixed** ✅
(**B-RPGT beta.24**, the independent 0/4 cause) + **field-soak repeatability 🔴 on codex (0-for-3, NOT re-run
post-fix)** / 🟢 on claude (**2 of ~3–5, now incl. a live multi-ticket additive run**). The *code* is the
most-fixed it has ever been and is now **proven on claude**; the only missing evidence is the **codex
field-proof**. Remaining GA work: **(a) run the codex AC-DURA-4 proof** — the decisive data point (was 0/4 on
codex pre-fix); **(b) 1–2 more claude reps at low intervention** to firm up repeatability; ~~(c) close the
review-phase gate gaps~~ ✅ done (B-RPGT). Run bundles via `/pickle-pipeline --scope branch` (an unscoped
1-event bundle made anatomy/szechuan review the whole tree for 84m). Drop `-beta` once repeatability holds on
BOTH backends with no new completion-class seam.

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
**DEPLOYED + RELEASED 2026-06-23** ✅ — `install.sh` deployed the whole stack (deployed JS verified: boundary
committer + R-REIN + toolchain-fail-fast + oversized-split + subtract-before-add audit); bumped to
**`2.0.0-beta.23`** and published the GitHub **prerelease** (`b8b70b2e`; `eabf3d1d` ledger). Release-gate
note: tsc/eslint/10 audits + all changed-file tests + the load-bearing completion-commit characterization
suite (R-AFCC-DEEP invariant, 35/35) green **in isolation**; the full `test:fast`/integration suites carry
known subprocess-timing **load-flakes** (R-TFP/R-TSPF class) — proven isolation-green, none in changed files,
exacerbated by a 7-hr session's leftover machine load (65 leaked R-OMTD test subprocesses, since reaped).
**REMAINING (next-context priorities, in order):**
1. **Codex AC-DURA-4 field-proof** *(operator-deferred 2026-06-23)* — re-run a live codex multi-ticket bundle
   (LOA-1363 or LOA-1488) on the fixed runtime; **4/4 hands-off is the GA-on-codex gate** (codex 0-for-3 pre-B-DURA).
2. ~~**Review-phase gate gaps** (R-CECX run-3 follow-up #2, facets 4–6)~~ — ✅ **SHIPPED B-RPGT v2.0.0-beta.24**
   (R-RPGT review-phase hard typecheck gate on abort + R-APXG-3 cap; R-S529 529→transient park-and-retry). See drain row.
3. **R-SIGF full scope-auto-extension** (only the advisory flag shipped) + the wide oracle characterization net.
   *(Note: anatomy-park found+fixed a real HIGH in B-RPGT's own new park code (`946cd0b1`) — review phases now self-harden.)*
**Primary metric:** hands-off soak truthfulness + manual-intervention rate (trap-door count secondary).
**Self-build (old WS-4): cut** — freeze autonomous self-build for recovery bundles, formalize the hand-build
protocol; revisit post-GA only if hand-build is the bottleneck.

### GA field-soak (the metric for the above)

**The GA-readiness soak** (drop `-beta`) is the reliability metric. Run **~3–5 representative bundles**
hands-off via `/pickle-pipeline`, INCLUDING **≥1 live multi-ticket additive bundle** (R-WSDO was
single-ticket). Use `--scope branch` for small bundles (an unscoped 1-event bundle made anatomy/szechuan
review the whole tree for 84m). *Record* every intervention point (don't rescue unless data at risk) →
ranked intervention-rate report = the GA-readiness ledger. **Soak ledger: 2 clean on claude — (1) R-WSDO
(single-ticket, 4/4 hands-off, beta.22) + (2) ✅ B-RPGT (2026-06-23, claude, MULTI-TICKET ADDITIVE: 5 tickets
→ pickle/citadel/anatomy-park/szechuan-sauce, 4/4 hands-off in 178m, ZERO mid-run intervention — the first
live multi-ticket additive clean run the soak required; the 529-abort bug never fired, anatomy-park even
found+fixed a real HIGH in the new code; only closer work was pre-existing gate-parity debt + 2 oversized
trap-door trims, no recovery-class seam). codex multi-ticket still 0-for-3 (NOT re-run post-B-DURA).** —
LOA-1363 run 1 → [[R-CECX]]
(no-commit + cross-iteration corruption); LOA-1363 run 2 → [[R-PFNT]] (evidence-oracle disagreement +
`Failed` non-terminal masks a GREEN build: 12 commits / 978 tests 0-fail); LOA-1488 run 3 → R-CECX run-3
(build 12/17 durable, 11 correctly attributed; one untagged commit + premature drain at iter 49/500) +
run-3 follow-up #2 (review-phase tsc/lint-RED commits + transient-529 szechuan abort). **B-DURA (beta.23)
is built+deployed to fix R-CECX + R-PFNT facets 1/3 + the oversized-misclassification — but the codex matrix
is NOT yet re-run on the fixed runtime (AC-DURA-4 deferred), so the soak ledger is unchanged in *evidence*.**
The very next codex run on the fixed runtime is the decisive data point. Drop `-beta` when repeatability
holds on BOTH backends with no new completion-class seam.

## Drain Queue — shipped + remaining (deferred / blocked / external-gated)

| # | Item | Pri | State | Source |
|---|------|-----|-------|--------|
| **B-PCOMP** | **B-PCOMP — beta 2.0 pipeline completion** — ground-truth gates at both boundaries (WS-D1=B-RFCU start gate + WS-D2 finish gate) | **P1** | **✅ SHIPPED v2.0.0-beta.22 (2026-06-21) + LIVE-PROVEN.** First green hands-off field-proof: the R-WSDO bundle ran **4/4 phases end-to-end with ZERO intervention** (84m, `pipeline-completed`), zero salvage-loops / zero done_without_commit_evidence — the exact pathology that broke every prior run. Fixes: `400fe433` salvage clean-tree back-fill, `aff2cfd4` bystander stash-not-commit, `b20a4c1a` R-OMTD orphan-mux reap, `fae9c590` e2e mechanism proof, start-gate WS-D1 (`26125e91`/`e9e55fc8`/`c08bb0d3`), WS-D2-1 attribution (`8b4f75c6`). Agent-team hand-built (R-PSRB catch-22). Full local gate green (tsc/eslint/10 audits/integration 513+486-0/fast-c4 6637-0). **GA (drop -beta) gate = field-soak repeatability: 1 of ~3-5 representative hands-off runs done (need ≥1 live multi-ticket).** Prior state: **IN BUILD 2026-06-21.** Start gate (WS-D1) ✅ committed (26125e91/e9e55fc8/c08bb0d3). WS-D2-1 branch attribution ✅ committed (8b4f75c6). 6-agent team re-understood the build failures + re-planned for simplification: **8 remaining tickets → 4 build steps** (3f6800f3 CUT = already-shipped artifact-delta reap; 0a1ce691 narrowed to reuse the shipped `readEvidence` oracle, NOT export `scanGitLog` which would break R-AFCC-CALLER-ENUMERATION; 4 hardening → 1; R-OMTD orphan-mux teardown folded in). Build via hand-build agent team (R-PSRB catch-22 forbids autonomous self-build). **Done = 4/4 phases hands-off e2e.** All 4 build steps ✅ committed (`400fe433` salvage clean-tree back-fill / `aff2cfd4` bystander stash-not-commit / `b20a4c1a` R-OMTD orphan-mux reap / `fae9c590` 4/4-phase hands-off e2e). **Quality-closure 3-pass hardening ✅ done** (NEW-quality-closure): code+data-flow review clean (no P0/P1), +A6 headSha-null rejection test, 3 new invariants documented with enforcing trap doors + ENFORCE tests in `extension/CLAUDE.md` + `extension/src/bin/CLAUDE.md`. Pending: deploy (install.sh) + release. See "Revised Build Plan" in the PRD. | `p1-beta2-pipeline-completion-2026-06-20.md` |
| **B-DURA** | **B-DURA — durable iteration boundary** (R-CECX fix; **the cluster subtraction**). Runner commits the ticket's gate-passing work at every iteration boundary; Done-flip + context-clear gated on a durable runner-authored commit existing. Closes both R-CECX faces (committed-nothing + cross-iteration clobber) with ONE invariant, then **subtracts** the evidence-archaeology layer (`allow_inferred_completion_commit` deleted; `EvidenceKind` collapsed; R-CCRC fuzzy grep narrowed; B-PDBL backfill-loop class removed). Larger-sense thesis: 13 incidents / 49 days, 77% additive fixes; the invariant already exists at `send-to-morty.md:100` ("NEVER flip Done before the commit exists") but is **worker-side prose** — B-DURA relocates it to **runner-code**. | **P1** | **✅ SHIPPED v2.0.0-beta.23 + DEPLOYED 2026-06-23 (prerelease).** All 13 refined tickets + R-REIN + WS-2/WS-5 built, merged, gated, deployed. Load-bearing T10–T50 **hand-built on claude (R-PSRB) + independently verified** (boundary committer wired @10793; `boundary_commit_resolved` emitted+registered; `isFailedTicketTerminalExcludable` at 4 advance sites; `isPendingMuxTicket` + forbidden `*_tickets` invariants honored): T10 `e1472c37` / T20 `b032be1a` / T30 `be667dee` / T40 `f788aa43` / T50 `cda99b33`. Subtraction: T60 `05650df1` (delete `allow_inferred`) / T70 `71996fe8` (`EvidenceKind` 4→2 + shim + dead variant; R-AFCC callers 3→2) / R-REIN `3c48d7ae`. WS-2: `5ad07e3c`/`b60a112e`/`7b69f22a`/`a668687f`. WS-5: `9164f14d`. Release-gate caught + fixed 2 real regressions (`VALID_ACTIVITY_EVENTS` count guard; beta6 stale-date fixture); remaining fast-suite reds = subprocess load-flakes (isolation-green). The autonomous `/pickle-pipeline` confirmed the R-PSRB wedge (T10 Failed under pre-fix runtime) → hand-build; T60+ via parallel worktree agent-team. **RESIDUAL (NOT a code task): the codex AC-DURA-4 field-proof has not run — beta.23 is a prerelease until it does (see GA path / governing strategy).** R-SIGF shipped advisory-flag only; full scope-auto-extension deferred. | `p1-durable-iteration-boundary-2026-06-22.md` · `RELIABILITY-PLAN-2026-06-23.md` |
| R-PFNT | **R-PFNT** green build reports `0/4 phases` (codex multi-ticket) — **B-PCOMP finish-gate NOT a single oracle.** (1) phantom-Done watcher ACCEPTS `b17cc3fe` (`valid completion_commit evidence` ×3) while flip-gate `readEvidence()` FATALS it (`kind==='absent'`) on the SAME frontmatter (`completion_commit: 9adfed909` present) — two oracles, opposite verdicts; the fatal demands a `completion_commit` already there. (2) `wmw-auto-skip` flips all 3 detached `large`-tier hardening tickets → `Failed/oversized_no_progress` (misclassifies scope-fence-ambiguity stall as "oversized"). (3) `Failed` is non-terminal for phase advance → 3 failed *polish* tickets atop 10 Done verified-green *build* tickets → `Pipeline finished: 0/4 phases` and citadel/anatomy/szechuan never run. Independently verified at halt: 12 commits, typecheck clean, **978 tests 0-fail**, 22/22 files lint-clean. | P1 | **✅ CODE-FIXED in B-DURA / beta.23 — pending codex field-proof.** All three facets addressed: (1) two-oracle split → ONE `readEvidence` oracle, watcher≡flip-gate (T30 `be667dee`); (3) `Failed`-non-terminal → terminal-for-advance under the empty-window guard (T40 `f788aa43`); (2) `oversized_no_progress` misclassification → split into `scope_unresolvable`/`no_progress_timeout` (WS-2d `b60a112e`) + parseable hardening fence (`5ad07e3c`) + toolchain fail-fast (`7b69f22a`). **Not yet RE-RUN on codex** (AC-DURA-4 deferred) — closes only when a live codex multi-ticket run completes 4/4 on the fixed runtime. | `BUG-REPORT-2026-06-23-green-build-reports-0-of-4-evidence-oracle-disagreement-and-failed-nonterminal.md` |
| R-SIGF + R-REIN | **R-SIGF / R-REIN — tickets-not-completing (LOA-1488 run 3, 2026-06-23).** Two NEW root causes behind hardening tickets never completing, distinct from R-PFNT's "oversized misclassification." **R-SIGF (scope-fence signature fan-out):** ticket 60 correctly added `StatementAnalyzerHealthService` as the 14th `LangGraphService` ctor injection, but sibling spec `appraisalEvaluation/buildAppraisalEvaluationGraph.spec.ts` instantiates it positionally (13 mocks) → `tsc` RED at 6 sites. That file is **outside the bundle's MODIFIED_FILES scope fence**, so NO fenced worker could fix it; build stayed RED → the data-flow + test-quality hardening tickets failed their typecheck gates indefinitely (presenting as `oversized_no_progress`, a misleading symptom). Fence must auto-extend to positional callers of a changed injected/exported signature (or readiness must flag signature-change-without-caller-co-scope). **R-REIN (recovery-exhausted inert on reset):** flipping a Failed ticket `status → Todo` + relaunch does NOT refund the per-ticket recovery counter → phase re-exits `exit_reason=recovery_exhausted` in ~2s with no re-attempt, so the documented "reset to Todo + relaunch" recovery is INERT once the ladder is spent. **Operator recovery (verified):** hand-fix the out-of-fence arity break (commit `ccad8c39e`), pin `scope_base` to the merge-base SHA to undo the moved-`main` phantom diff (see R-CECX Run-3 follow-up facet 3), then R-PFNT drop-pickle → review phases. | P2 | **R-REIN ✅ SHIPPED beta.23 (`3c48d7ae`)** — `refundRecoveryBudgetOnReset` refunds the per-ticket recovery ledger when frontmatter is reset to Todo, wired at the iteration loop top; the documented "reset to Todo + relaunch" recovery is no longer inert. **R-SIGF ⚠️ PARTIAL** — shipped the **advisory** `signature_change_caller_gap` readiness finding (`a668687f`, non-blocking, names orphaned positional callers); the **full scope-auto-extension** (fence auto-extends to callers of a changed injected/exported signature) is **DEFERRED** — the harder, higher-risk half. | `BUG-REPORT-2026-06-22-codex-backend-completion-evidence-fatal-and-cross-iteration-work-corruption.md` |
| R-CECX | **R-CECX** codex-backend `done_without_commit_evidence` fatal + cross-iteration work corruption (multi-ticket) — **B-PCOMP recurrence on the unproven codex + multi-ticket path** (exactly the R-CECB residual: "GA soak still needs ≥1 LIVE multi-ticket run"). Codex workers committed NOTHING (`git log main..HEAD` empty) → WS-D2 finish gate has nothing to reconcile → 0/4 phases (no salvage-loop — the committed-but-unattributed path B-PCOMP fixed never triggers because there is no commit at all). Worse: a ticket flipped **Done with its code absent** and a later context-cleared ticket rewrote shared registry files from the stale base (floor → 18 while only 17 rules exist → module throws at import). | P2 | **✅ CODE-FIXED in B-DURA / beta.23 — pending codex field-proof.** The durable-boundary commit (T10 `e1472c37`) makes "committed-nothing" impossible (runner authors the commit) and makes cross-iteration clobber structurally impossible (next worker starts from a committed tree); Done-flip gated on a durable commit (T20). **Not yet RE-RUN on codex** (AC-DURA-4 deferred) — the LOA-1363 re-run on the fixed runtime is the close criterion. Recovery recipe if needed before then (verified): reset corrupted tree to clean base + status→Todo + relaunch (`allow_inferred` no longer exists post-T60 — the runner now commits at the boundary instead). | `BUG-REPORT-2026-06-22-codex-backend-completion-evidence-fatal-and-cross-iteration-work-corruption.md` |
| R-RPGT + R-S529 | **Review-phase gate gaps (R-CECX run-3 follow-up #2, 2026-06-23) — NEW, an independent 0/4 cause not addressed by B-DURA.** **R-RPGT (facets 4+6):** citadel / anatomy-park / szechuan-sauce **commit code that is tsc/lint-RED** because their convergence gates measure an LLM/quality score, NOT typecheck+lint — a review/cleanup phase can "converge" while leaving the tree build-broken (live: anatomy `.then()` closure lost TS narrowing → 3 tsc errors; szechuan dropped a `Promise.resolve` wrapper + nullable `runId` → 3 tsc errors; both slipped because the phase's own gate never ran tsc). Fix: review/cleanup phases MUST run typecheck+lint as a HARD gate before committing, even on phase-abort paths. **R-S529 (facet 5):** a transient `API Error: 529 Overloaded` in szechuan's microverse LLM-metric path exhausts 4 attempts → `baseline_unmeasurable_unrecoverable` aborts the whole 3-hr pipeline. Fix: treat 529/Overloaded in the metric path as park-and-retry (reuse the B-RRH rate-limit park), not a hard abort. | P2 | **✅ SHIPPED v2.0.0-beta.24 + DEPLOYED 2026-06-23.** Built reuse-first via `/pickle-pipeline` (3-cycle refinement → 5 tickets → 4/4 hands-off in 178m). **R-S529:** `classifyJudgeError` 529/429→`rate_limited` (`7a6ea046`); `mapJudgeMeasurementFailure`→`baseline_unmeasurable_transient` (non-fatal, shared helper covers baseline+iteration); routed via BOTH `isFatalPhaseFailure`+`classifyMicroverseHaltDecision`→`run-finalize-gate-incomplete`; judge-path park-and-retry bounded by a 1h metric-path ceiling + observable state (`b430eaff`). **R-RPGT:** abort-path + R-APXG-3-cap gate reuses `runGate`, emits `tsc_gate_failed`, best-effort/network-free, never converges over RED (`fe211cb1`); consolidated `describe.each` exit-path test + CLEAN negative control (`2d290564`). Refinement caught the R-APXG-3 cap defect (force-exits converged over RED) + retargeted the dead-code mapper. Closer reconciled pre-existing gate-parity debt (`check-wired`/`release-gate-wiring` canonical missing `audit-un-terminalize-single-path`) + trimmed 2 oversized trap-door entries (`c7eed4e4`); bump `1da40321`. Gate green; remaining test reds isolation-confirmed load-flakes. The 529-abort bug never fired during the run. | `BUG-REPORT-2026-06-22-codex-backend-completion-evidence-fatal-and-cross-iteration-work-corruption.md` · `p2-review-phase-gate-and-transient-529-2026-06-23.md` |
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
