---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Live ledger.** The babysitter (`babysitter.md`) re-reads this each tick, so it is kept lean
on purpose. Shipped-release detail and closed-finding forensics live in
[`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) + `git log`; the full finding catalog is in
[`BUG-INDEX.md`](BUG-INDEX.md).

**Updated 2026-07-04 (v5 — beta.38 B-SCOPESEED shipped+deployed; FIRST clean hands-off codex pipeline banked; [[R-SZGB]] mechanism-VERIFIED (Hypothesis 2 — repo-root-above-package → null project_type → empty fail-open gate baseline) + 2-WS fix PRD authored, ready to build on claude).** ✅ **THE SIMPLIFICATION DROP SHIPPED — v2.0.0-beta.37 RELEASED + DEPLOYED 2026-07-02 (install.sh, MD5 parity OK on all hot files; gate: tsc/eslint/9-audits/fast-c4/expensive green, budget-c8 + 4 integration reds proven isolation-green load-flakes per posture).** One ultracode session executed `SIMPLIFICATION-AND-FIX-PLAN-2026-07-02.md` end-to-end: **B-1SEAM all 3 WS** (`7b52789d` WS-1 ONE completion predicate `evaluateCompletionEvidence` routing ALL 8 former divergent decision sites [not 3 oracles — 7 sites/3 policy shapes + the bare-field `defaultDoneGuard`] + spawn-morty verified-sha/`Pickle-Ticket`-trailer reconciliation killing the codex untagged/hallucinated-sha trigger at the source; `2bbf5770` WS-2 `healPipelineRequiredFields` symmetric prd_path+start_commit self-heal; WS-3 in `885efb73` — ONE dirty-tree salvage seam, `stageAutoCommitPaths` empty-excludes sweep deleted) + **R-CXHANG orphan reaper + B-RSHM subtraction** (`885efb73`: stop-hook dead branches + whole chain_meeseeks subsystem retired) + **the guard-layer prune** (`2957f0c2`: 4 orphan audits + 2 advisory audits DELETED, design-ground-truth demoted [canonical gate now 9 audits], ONE quality-gate bypass surface, legacy kill-switches PICKLE_CITADEL_MECHANICAL/PICKLE_RECOVERY_CONSOLIDATION removed, codex-manager-relaunch shim collapsed). R-AICF/R-PSCG/R-MACB/R-CXHANG all closed; net ~−3,650 LOC. Shipped + deployed + released through **v2.0.0-beta.36** (✅ **B-SIGFH** scope-fence detector hardening — codex GA soak, DEPLOYED 2026-07-02; prior **B-WSPU — the DUAL WORKER-SPAWN MODEL COLLAPSED**: the entire detached lifecycle DELETED (~1000+ LOC pure subtraction), all tiers now run one synchronous re-spawn-resume path; the operator-flagged #1 structural subtraction, DONE + DEPLOYED 2026-07-01 — the R-LTDM/R-WPEX/R-MWBG failure-mode class is gone. Field evidence FOR the collapse: a detached worker silent-died building its own deletion while the synchronous path built it clean). beta.34 ✅ **B-SSVR** (R-SSBR scope-resolver fail-CLOSED + R-ISVP install.sh prerelease semver, both DEPLOYED). beta.33 (✅ **gate-overreach subtraction** — Phase 1 made the iteration-0 readiness + ticket-audit gates ADVISORY, Phase 2 DELETED the forward-ref annotation grammar, the top recurring bug source [R-RTRC ×8 + R-FRA ×7]; ~35 files of pure subtraction, KEPT resolution fixes R-RTRC-3/4/5 / R-RHFP / R-RCEX / R-RTPS; commit `9a5c047e`). beta.32 ✅ **[[R-LTDM]]** detached-poll throttle (R-MWBG RE-CLOSED). Operator flagged the underlying brittleness — the dual worker-spawn model — logged as **[[B-WSPU]]** and now ✅ SHIPPED+DEPLOYED beta.35 — the real subtraction, done. (R-MWBG runtime half:
explicit-tier detached-routing gate — R-MWBG now FULLY closed; beta.30 B-RELHYG; beta.29 R-SIGF scope-fence +
R-MWBG half-1; beta.28 R-WPEX; beta.27 B-APNC; beta.26 B-CWGE; beta.25 B-PXBO). **The historical reliability
defect classes are code-fixed at root** — the completion-commit/Done-flip cluster (B-PCOMP beta.22 + B-DURA
beta.23), the review-phase 0/4 cause (B-RPGT beta.24), the codex worker-gate (B-CWGE beta.26), the phase-exit
oracle (B-PXBO beta.25), the codex scope-fence GA blocker (R-SIGF beta.29), and the medium-tier ceiling-survival
gap (R-MWBG beta.31). **OBSERVATION mode is now producing new evidence-backed work, as designed:** two fresh
bugs surfaced this window — **[[R-SSBR]] (P2, scope-resolver trusts a stale `origin/main` → false
`SCOPE_EMPTY_DIFF` → review phases run UNSCOPED, fail-open on the scope boundary; surfaced babysitting the
LOA-1614 pipeline)** and **[[R-ISVP]] (P3, install.sh `compare_semver` rejects prerelease → downgrade guard dead
for the `beta.*` line)**. Both R-SSBR and R-ISVP ✅ SHIPPED+DEPLOYED beta.34, and the detached-spawn brittleness they exposed is now SUBTRACTED (B-WSPU beta.35). GA gate
remains field-soak repeatability (esp. codex) — now on the simpler single-lifecycle runtime. See `## ⏯ RESUME HERE`.

**Autonomous-development scorecard.** The build→citadel→anatomy-park→szechuan-sauce pipeline now runs a real
multi-ticket additive bundle **fully hands-off on claude** (B-RPGT). Remaining autonomy gaps, in order of bite:
(a) the **closer** (version bump · `install.sh` deploy · `gh release`) is NOT auto-run by `pipeline-runner` —
it finishes 4/4 then stops, so a babysitter still ships; (b) **recovery-machinery bundles can't self-build**
(R-PSRB) — must hand-build; (c) per-phase gates don't run the FULL release gate, so debt surfaces at the
closer (B-RPGT's closer caught pre-existing gate-parity drift + 2 over-limit trap-door entries the review
phases added — tsc/eslint-clean but tripping AC-BUNDLE-17).

## ▶▶ NEXT FIX RUN (2026-07-02) — B-1SEAM: collapse the asymmetric-fix siblings [✅ BUILT 2026-07-02 — `7b52789d`/`2bbf5770`/`885efb73`; retained as the design record]

**The three fresh 2026-07-02 bug reports are ONE antipattern, not three unrelated bugs.** Each is an
**asymmetric / incomplete fix** — a defect repaired at ONE site/field/oracle/path but not its
symmetric twin, so the *same* bug re-surfaced on the sibling. This is the operator's "recurring /
failed fixes" signal, and R-AICF specifically **re-opens the Reliability-Plan #1 meta-defect
(completion-oracle plurality)** that B-DURA/B-PXBO/R-CWGE were believed to have collapsed to one
oracle — it was never actually single.

| Bug | Pri | Fixed at ONE site / NOT at its twin | Twin of |
|---|---|---|---|
| [[R-AICF]] | **P1** | `allow_inferred_completion_commit` honored by `done-guard` but NOT by the phantom-Done watcher NOR `readEvidence()` Done-flip fatal → **3 oracles disagree**, strand a clean codex bundle 0/4 | reopens [[R-CCC]] / [[B-PDBL]] — the "single oracle" is still 3 |
| [[R-PSCG]] | P2 | citadel self-heal added for `prd_path`, absent for the sibling `start_commit` → citadel hard-fails 1/4 after a clean 11/11 build | mirror of shipped [[R-PRPATH]] |
| [[R-MACB]] | P2 | bystander-stash (owned-paths-only) on the mux-runner exit path, never ported to the microverse auto-rescue path → foreign session's doc swept onto the feature branch | twin of B-PCOMP `#b736337f` |

**Simplification + reliability re-think (the meta-lesson the operator asked for):** we keep *patching
one instance* of a defect class and leaving its twin, because these fixes live as **parallel
implementations** (3 completion oracles · 2 citadel self-heal branches · 2 staging call-sites) instead
of ONE shared predicate/helper every site routes through. The durable move is NOT three more patches —
it is to **collapse each defect's sibling-sites onto a single seam and PIN the collapse** with a
call-site-count audit (the R-AFCC-CALLER-ENUMERATION pattern) so a future divergence fails the gate.
"Collapse seams, don't gate them" — [[feedback_analyze_failures_then_subtract_not_add_guards]]. This
also sharpens the standing GA question: the completion-oracle plurality is the ROOT that keeps
re-surfacing on codex; **B-1SEAM WS-1 is the real codex-GA completion fix, ahead of any further soak.**

**⚠ PREMISE CORRECTION (2026-07-02, source-verified — read before authoring):**
`allow_inferred_completion_commit` **does not exist in source** — deleted by B-DURA T60 (beta.23,
`05650df1`); `check-no-inferred-completion-flag.sh` + `allow-inferred-completion-commit-deleted.test.js`
pin its absence. The flag set at LOA-1078 launch was inert JSON; the R-AICF report's flag attribution is
impossible. The REAL divergence: `readEvidence()` is already the single evidence *function*, but its **6
decision call-sites apply different policy** — only `guardCompletionCommitBeforeDone` (`mux-runner.ts:4697`)
applies baseline-SHA rejection (`:4714`) + worker-gate fail-closed verdict (`:4769`); the phantom-Done
watcher (`ticket-completion-evidence.ts:626`), R-PDUP twin auto-close (`mux-runner.ts:1427`), salvage
attribution (`mux-runner.ts:5358`), auto-fill (`auto-fill-completion-commit.ts:75`), and
`validateAutoTicketCompletion` (`mux-runner.ts:2792`) apply none of it. WS-1 = route all 6 sites through
ONE predicate (baseline + gate verdict + frontmatter-sha resolution) + deterministic post-commit hash-tag
trailer injection in the worker wrapper (kills the codex untagged-commit trigger, no flag) — do NOT "teach
the flag" to anything. WS-1 must open with a mechanism trace of session `2026-07-01-9e922602` against the 6
sites. Full analysis + phased simplification plan: `SIMPLIFICATION-AND-FIX-PLAN-2026-07-02.md`.

**THE BUNDLE — B-1SEAM (author the PRD next context from the 3 bug reports, then build):** one thesis
— *fix at the seam, not the site.*
- **WS-1 (R-AICF, P1) — collapse the completion oracles onto one predicate.** The phantom-Done
  watcher AND the `readEvidence()` Done-flip fatal MUST consult the SAME predicate `done-guard` uses;
  with `allow_inferred_completion_commit=true`, a frontmatter `completion_commit` sha resolving to a
  real in-scope commit counts as `committed` even without the message hash-tag. Pin the call-site
  collapse with an audit so no oracle can diverge again. **Preferred root-cause alt (subtract, don't
  flag):** deterministic post-commit hash-tag trailer injection in the worker wrapper so all oracles
  agree WITHOUT the flag. **⚠ R-PSRB — HAND-BUILD** (touches `ticket-completion-evidence.ts` /
  `reconcile-ticket-truth.ts` / mux-runner Done-flip; the deployed buggy runtime applies this logic
  to the very worker building the fix).
- **WS-2 (R-PSCG, P2) — symmetric citadel self-heal.** Extend the `pipeline-runner.ts:2062-2071`
  self-heal to also heal `start_commit` (`git merge-base <default> HEAD` when unset + repo is git);
  `setup.js --resume` recomputes `start_commit` when unset and cwd is now a git repo; WARN on
  `--paused` in a non-git cwd. Pipeline-safe.
- **WS-3 (R-MACB, P2) — port the bystander-stash to microverse auto-rescue.** `autoRescueDirtyTree` →
  `stageAutoCommitPaths` must stage only session-owned paths (reuse `stashUnattributableRemainder`),
  never `git add -A`/empty-excludes; pin the `microverse-runner.ts:~3628` call-site with a test.
  Pipeline-safe.

**Build strategy:** WS-1 forces HAND-BUILD (R-PSRB salvage/completion path); WS-2+WS-3 are pipeline-safe
but small → **hand-build all three in one session** is cleanest (WS-1 dominates), or hand-build WS-1 +
pipeline WS-2/WS-3. **Build on claude** (codex is the SOURCE of R-AICF and carries the R-CXHANG hang).
**Sequencing:** B-1SEAM is the new top of the queue (P1 R-AICF, completion-oracle root); then
[[R-CXHANG]] (codex reaper, unblocks a clean codex soak); then [[B-RSHM]] (subtraction). Each WS closes
its bug AND collapses a sibling-seam — reliability + simplification in the same cut.

---

## ▶▶ STRATEGIC SHIFT (2026-06-30) — SUBTRACT THE BRITTLE FEATURES (read this first; supersedes the drain-queue posture below)

**North star (operator, 2026-06-30):** *"We had a version that ran completely autonomously and reliably; it only became brittle as we added features. Autonomous is the first goal, quality output is the second goal."* Reliability is goal #1, quality #2 — when a feature trades reliability for output quality, cut the feature. The reliable baseline was **~v1.5, before codex (`--backend codex` landed v1.51.0 / 2026-04-24)**. We do NOT roll back (a month of real value sits on top); we **subtract the specific small additions that broke it.** The reliability bar is empirical: **build N real bundles hands-off, in a row** — not green tests. See [[feedback_autonomous_first_subtract_features_back_to_reliable_baseline]].

**Brittle-feature attribution (data-grounded, BUG-INDEX + trap-door catalog).** Ranked by RECURRENCE (the real signal):
| Feature | Brittleness evidence | Operator decision |
|---|---|---|
| Multi-backend / codex (v1.51) | ~25 findings; codex manager-wall re-filed 4×; worker-gate reverted; infects completion/scope/judge | **KEEP — we need codex** |
| Review phases (microverse/anatomy/szechuan/council/death-crystal) | largest guard cluster (~59 trap-doors) but post-build polish | **KEEP — anatomy-park/szechuan are reliable + valued** |
| **Gate overreach** (readiness/forward-ref/scope/audit) | **R-RTRC ×8 + R-FRA ×7 = 15 sub-fixes, ~99 commits; R-ATBG = "guard around a brittle guard" archetype** | **★ THE TARGET — cut the small over-strict guards** |
| Detached large-tier spawn | was newest + still-failing (R-LTDM, R-MWBG, R-WPEX) | ✅ **SUBTRACTED — B-WSPU beta.35, DEPLOYED 2026-07-01**: the whole detached lifecycle deleted, all tiers unified on synchronous re-spawn-resume. The failure-mode class is gone. |
| Monitor/watchdog TUI | ~19 trap-doors for a cosmetic dashboard | candidate, low priority |

**✅ SHIPPED v2.0.0-beta.33 (2026-06-30) — the gate-overreach subtraction (Phase 1 + Phase 2 bundled). Commit `9a5c047e`, deployed via `install.sh`, released.**
- **Phase 1 ✅ R-GATE-ADVISORY (`87d837f6`).** The iteration-0 readiness + ticket-audit gates **log findings and PROCEED instead of halting**. A genuinely-bad bundle surfaces at the build/review phases, not via a heuristic pre-flight false-killing good runs. `ticket_audit_failed`/`readiness_halt` retained-but-unemitted.
- **Phase 2 ✅ DELETED the forward-ref annotation grammar (`9a5c047e`)** — the top recurring bug source (R-RTRC ×8 + R-FRA ×7 = 15 sub-fixes), made inert by Phase 1's advisory gates. Pure subtraction across ~35 files. **KEPT** the separate resolution/allowlist fixes (R-RTRC-3/4/5, R-RHFP/R-RCEX/R-RTPS) and the shared gate-parity resolver `resolveExtensionDir`/`resolveExtensionRelativePath`. **HARD-WON LESSONS (encode):**
  - The plan said "DELETE `forward-ref-annotation.ts`" but `gate-parity-shared-resolver.test.js` (NOT in the deletion list) pins `resolveExtensionDir`/`resolveExtensionRelativePath` to that module — deleting the file would have red-gated. Correct move: strip the grammar IN PLACE, keep the resolvers. **When a plan says "delete file X," grep for tests/consumers pinning OTHER exports of X first.**
  - The forward-create suppression spanned annotation grammar AND the "Files to create" declared-path index (`buildBundleCreationIndex`/`extractForwardCreatePaths`, R-RCFF) AND `isForwardCreated`; removed the whole feature (all inert post-advisory), kept pure resolution. `audit-design-ground-truth.sh` CHECK(iii) REQUIRED `isForwardCreated` — had to remove that check too.
  - **A delegated `fork` came back role-confused** (inherited my context, returned a meta-summary of the overall task instead of doing the 9 test-trims). Verified via `git status` it had done nothing useful; did the trims myself. **Don't trust a fork's self-report — diff the filesystem.**
  - **Phase 1 left two obsolete tests red** (`mux-runner-halt-error-format.test.js` asserting the removed halt-with-skip-flag behavior) — only surfaced at the full fast-tier gate. Deleted them; advisory behavior is covered by `mux-runner.test.js audit-bundle-advisory`. The c=8 `test:fast:budget` WEDGED (0% CPU whole-suite load-flake) — re-ran at c=4 for the authoritative 6648/0; integration's lone fail was the known isolation-green lockdown-downgrade flake.

**Other open (post-subtraction) — ⚠ 2026-07-02 NOTE: the three "NEW capture-only" findings below (R-PSCG / R-AICF / R-MACB) are now ✅ CLOSED in beta.37 (B-1SEAM); the paragraph is retained as the capture record, and R-AICF's flag attribution was later disproven (flag deleted beta.23 — see the premise correction above).** R-LTDM ✅ shipped beta.32 (detached-poll throttle). [[B-WSPU]] dual-spawn-model collapse — DEFERRED (operator keeps the structure). Detached-worker-dies-at-~10min (the SECOND B-SSVR failure, distinct from R-LTDM) — uninvestigated, deferred. **B-SSVR** (R-SSBR + R-ISVP) PRD+2 tickets READY on main, session `2026-06-30-38285dba`, hand-build or pipeline-build once stable. **NEW [[R-PSCG]] (P2, capture-only, 2026-07-02)** — paused-PRD → `/pickle-pipeline` resume leaves `state.start_commit` unset → **citadel hard-fails, pipeline stops 1/4** (built 11/11 tickets clean first). The **exact mirror of the shipped [[R-PRPATH]]**: that fix self-heals a missing `prd_path` but NOT the sibling `start_commit`; origin is `setup.js` computing `start_commit` only for a git-repo cwd (the `loanlight/` root is not one) and `--resume` never recomputing it. Fix = symmetric self-heal + recompute-on-resume (`BUG-REPORT-2026-07-02-pipeline-resume-start-commit-gap-citadel-hardfail.md`). Surfaced babysitting LOA-1356. **NEW [[R-AICF]] (P1, capture-only, 2026-07-02)** — codex bundle stranded **0/4 phases (4/16 tickets committed, clean)** by a live **3-oracle disagreement**: `allow_inferred_completion_commit=true` is honored by `done-guard` (accepts) but NOT by the `phantom-Done watcher` (reverts to Todo) nor `readEvidence()` (FATAL) — the latter two git-log-scan for the `(<hash>)` tag and ignore both the frontmatter `completion_commit` sha AND the flag. Trigger = a codex worker committed real in-scope work WITHOUT the hash tag (~1-in-4 empirically; 3/4 tagged). **Corroborates + reopens [[R-CCC]]** (marked fixed 2026-05-05 — did NOT survive codex + inferred-flag) **and [[B-PDBL]]**. Salvage-path fix = **R-PSRB hand-build** (touches `ticket-completion-evidence.ts` / `reconcile-ticket-truth.ts` / phantom-Done watcher — unify all three oracles behind one predicate). Surfaced babysitting LOA-1078 (`BUG-REPORT-2026-07-02-codex-inferred-commit-flag-unhonored-3oracle-disagreement.md`). **NEW [[R-MACB]] (P2, capture-only, 2026-07-02)** — the microverse **worker-timeout auto-rescue** (`autoRescueDirtyTree` → `stageAutoCommitPaths(ctx.workingDir)` at `microverse-runner.ts:~3628`) is called with **empty `excludePrefixes`**, so it `git add -u` + stages **every** untracked `?? ` path with no docs/prds exclude and no attribution check — sweeping a **foreign** session's pre-existing untracked `docs/prd-statement-analyzer-*.md` (LOA-1365 WIP) onto the LOA-1570 feature branch under `microverse: auto-commit (worker timed out before committing)` (`6272304fc`). **Violates the module's own documented invariant** ("auto-commit rescue … honoring docs/prds exclusions") — the pre-flight call site (`:2947`) passes `PREFLIGHT_DIRT_EXCLUDES`, the rescue site passes none. **Exact microverse-side twin of the already-fixed [[B-PCOMP]] `#b736337f` bystander-stash** (mux-runner exit path stages only positively-owned paths + `stashUnattributableRemainder`) — never ported to the microverse rescue path; adjacent to R-APWS/R-APXG. Fix = port the bystander pattern (owned-paths-only + stash remainder) or minimally pass the docs/prds excludes; ENFORCE pins the `:3628` call site to a non-empty exclude/owned arg. Surfaced babysitting LOA-1570 First Colony Phase 2/3 (`BUG-REPORT-2026-07-02-microverse-autorescue-bystander-untracked-sweep.md`). The drain-queue / OBSERVATION posture is SUPERSEDED by this subtraction strategy (the OBSERVATION block was swept to `MASTER_PLAN-archive.md` → "Swept 2026-07-02").

---

## ⏯ RESUME HERE (updated 2026-07-03 — beta.38 B-SCOPESEED shipped+deployed; codex soak rep #1 CLEAN)

**▶ STATE: `origin/main` = v2.0.0-beta.38 (bump `34da04ca`); tree clean; no active pickle-rick pipeline; deployed runtime = beta.38 (install.sh 2026-07-03, MD5 parity OK on all 5 hot files). beta.38 = B-SCOPESEED (R-SSPB pickle-phase scope seeding `621ce1b2` + R-PSAM standup author fix `219f0a3d`), built by `/pickle-pipeline --backend codex` session `2026-07-02-b3c45331` — 4/4 phases, 139m, ZERO intervention: the FIRST clean hands-off codex multi-phase run (the track-C soak rep). The R-CXHANG reaper, spawn-morty sha-reconciliation, and the B-1SEAM predicate all held under real codex load (no phantom reverts / orphan resets / oracle churn). Closer caught + fixed forward: 5 tsc errors + 1 eslint error from the szechuan Small-Functions splits (`65d6c04d`/`ed48092d`) + 3 moved source-pin anchors (`527a2c7`) → NEW capture [[R-SZGB]] (the per-iteration gate CONVERGED over tsc-RED commits — drain before trusting review-phase exits as toolchain-green). Gate: tsc/eslint/9-audits/fast-c4 6641-0/expensive green; budget-c8 + 6 integration reds ALL proven isolation-green load-flakes (posture: c=4/isolation authoritative). The full simplification plan (`SIMPLIFICATION-AND-FIX-PLAN-2026-07-02.md`) is EXECUTED: Phase 0 record hygiene `f34addaf` · B-1SEAM WS-1 `7b52789d` + WS-2 `2bbf5770` · WS-3+R-CXHANG+B-RSHM `885efb73` · guard prune `2957f0c2` · ledger `0f05865c` · bump `ad624cdd`. Built via ultracode in-process workflows (R-PSRB-compliant hand-build for the salvage-path work; adversarial verify per WS; full gate the arbiter). Gate record: tsc/eslint/9-audits/fast-c4/expensive GREEN; budget-c8 FAIL_BUDGET(3/2) + 4 integration reds ALL proven isolation-green load-flakes (posture: c=4 authoritative). Canonical gate is now 9 audits (design-ground-truth demoted). NOTE for next contexts: `PICKLE_SIGF`, `PICKLE_CITADEL_MECHANICAL`, `PICKLE_RECOVERY_CONSOLIDATION`, `skip_readiness_reason`/`skip_ticket_audit_reason`, chain_meeseeks, and `evaluateCodexManagerRelaunch` NO LONGER EXIST — do not cite them.**
**✅ B-SSVR SHIPPED beta.34** (via /pickle-pipeline + babysitter closer-takeover): **[[R-SSBR]] scope-resolver fail-CLOSED**
on a stale/ahead base ref (`9592eb46`) — `resolveAllowedFromDiffMode` now detects `baseSha===headSha` with a differing
baseRef tip and either recomputes via `resolveForkPointBase` or throws `SCOPE_BASE_AHEAD_OF_HEAD` (never a false
`SCOPE_EMPTY_DIFF` → no more unscoped review runs); **[[R-ISVP]] install.sh prerelease semver** (`d260012e`) — widened
`compare_semver` mirrors `check-update.ts:compareSemver` (release > prerelease, ident-lexical then num), re-arming the
downgrade guard for the `beta.*` line. The **build's own pickle phase false-failed `phase_no_progress`** (late-flushing
detached workers landed both workstreams' green output AFTER the no-progress verdict — R-WPEX/B-WSPU class); babysitter
verified + committed both, then ran citadel/anatomy/szechuan 3/3 clean. The **full release gate caught 2 real bugs the
review phases missed**: WS-1's trap-door entry was multi-line (citadel `rule-set-invariant-audit` parser is line-oriented
→ `73f780bf` collapse to one line) and **beta.33 shipped `gate-ergonomics-keystone.test.js` RED** (its forward-ref
grammar deletion left the fixture relying on deleted `(forward-created)` handling → synced fixture `8e987d87`). The
historical completion/scope/recovery/ceiling defect classes are all code-fixed and shipped. Per the GA path the gate
remains field-soak **repeatability** (esp. codex).

**▶ NEXT ACTION — priority order per the standing directive: RELIABILITY-FIX → SIMPLIFICATION → capability/evidence
(operator-steerable).** Both the reliability-fix queue AND the major simplification levers are largely SHIPPED — the
residuals below are narrow and each carries a blocker to a clean autonomous launch. None is blindly auto-launchable.

**A. Reliability-fix queue — drained through beta.38 (2026-07-03); ONE new open: [[R-SZGB]] (P2).**
beta.38 (B-SCOPESEED, clean codex pipeline) closed **[[R-SSPB]]** (pickle-phase scope seeding) +
**[[R-PSAM]]** (standup author scan); its closer surfaced **[[R-SZGB]]** — the szechuan per-iteration
gate converged over tsc-RED commits — the ONLY open actionable reliability fix. **✅ Mechanism VERIFIED
2026-07-04 (Hypothesis 2):** the gate targeted the repo root; `detectProjectType` inspects only that
dir (no walk), found no `package.json` (it lives in `extension/`), and `emitSkippedAndReturn` persisted
an EMPTY baseline (`project_type:null, checks:[]`) — so every replay subtracted against zero checks and
tsc-RED converged as clean; anatomy-park shared the same empty gate that run. **Fix PRD authored**
(`prds/p2-bug-fix-bundle-r-szgb-periteration-gate-fail-open-2026-07-04.md`): WS-1 bounded package-root
resolution + WS-2 fail-CLOSED on an uncertifiable baseline — reuse-first, routes through `runGate`, no
new gate/flag/state field. Pipeline-safe (NOT R-PSRB). Build on claude → deploy → prove via the R-SIGF
hardening run. Prior window (beta.37): the three 2026-07-02 capture-only bugs
(**[[R-AICF]]** P1 completion-oracle plurality → ONE `evaluateCompletionEvidence` predicate at all 8 decision
sites + spawn-morty verified-sha/trailer reconciliation; **[[R-PSCG]]** → `healPipelineRequiredFields`
symmetric self-heal; **[[R-MACB]]** → ONE dirty-tree salvage seam) are CLOSED, plus **[[R-CXHANG]]** (orphan
reaper — the codex-soak unblocker) and the B-RSHM + guard-layer subtractions. Prior window:
**[[R-LTDM]]** detached-poll throttle (beta.32) → **[[R-SSBR]]** scope-resolver fail-CLOSED + **[[R-ISVP]]** install.sh
prerelease semver (beta.34, DEPLOYED) → **[[B-WSPU]]** the DUAL WORKER-SPAWN MODEL COLLAPSED (beta.35, DEPLOYED):
the entire detached lifecycle deleted, all tiers unified on synchronous re-spawn-resume. The detached-spawn
failure-mode class (R-LTDM / R-WPEX / R-MWBG runtime half) is now **subtracted at the root, not patched** — the
operator's #1 north-star move, live. Residuals after beta.38: **[[R-SZGB]]** (above), the [[R-SIGF]]
hardening fast-follow (track C, unblocked), and external-gated items.

**▶ THE IMMEDIATE NEXT STEP is now BUILD R-SZGB, ahead of banking more soak reps** (operator decision
2026-07-04): a leaky review gate makes every future "hands-off 4/4" soak rep FALSE-green evidence, so
the gate fix gates the soak. Sequence: (1) build R-SZGB on claude (refine-or-build-direct, 2 WS) →
`install.sh` deploy; (2) run `/szechuan-sauce` over a known-RED tree / the R-SIGF diff as the LIVE proof
the gate now bites (doubles as the R-SIGF hardening pass + a soak rep on the FIXED gate); (3) resume
soak: ≥1 claude rep with a genuine >600s ticket + ≥1 more codex rep for repeatability. ✅ codex rep #1
already BANKED CLEAN (B-SCOPESEED 2026-07-02: 4/4 hands-off, 139m) — but it shipped tsc-RED under the
blind gate, so it counts for phase-completion, NOT toolchain-green. The GA bar stays N bundles hands-off
in a row.

**B. Simplification (subtract-before-add — the major levers already shipped).** The Reliability Plan's 5 structural
meta-defects are 4-of-5 substantially addressed: completion-oracle plurality → ONE `readEvidence` oracle
(B-DURA/B-PXBO/R-CWGE) ✅; scope-fence under/over-extend → R-SIGF ✅; guards-on-guards → B-GSUB doc track CLOSED
(−9) + B-GROUND2 functional collapse ✅; self-build trap → R-PSRB hand-build protocol ✅. **B-WSPU (beta.35) just subtracted the biggest chunk of the
5th (recovery sprawl) — the entire detached recovery/disposition half is gone.** The narrower residual:
2. **Recovery-sprawl functional seam-collapse — the remaining simplification lever (operator-scoped, soak-ranked).**
   Per B-GSUB's own empirical conclusion, pure doc-guard deletion is NOT the lever; B-GROUND2-style **functional**
   collapse is. The next seam to collapse (e.g. [[R-DPMC-3]] decomposition-satisfiability / recovery-transition
   sprawl) needs operator sign-off on WHICH seam and is ranked by what the field-soak surfaces. Pure subtraction,
   no new machinery.
3. **[[B-GIMA]] guard-inventory & finding-shape mining (report-only)** — operationalizes subtract-before-add
   (DELETE never-fired guards / calibrate conf<80 judge-drops). Stays DEFERRED — design dependency on codegraph
   (v2.1), not calendar.

**C. Capability / GA-evidence (parallel track / last).**
4. **Codex GA field-soak — the #1 GA-evidence gate** (a *run*, not a fix). ✅ **Rep #1 BANKED CLEAN**
   (B-SCOPESEED beta.38, 2026-07-02: 4/4 phases, 139m, zero intervention — the first clean hands-off codex
   multi-phase run; completion-evidence was already codex-proven LOA-1363 run4, this adds phase-completion).
   Remaining: ≥1 more codex rep for REPEATABILITY + [[R-SZGB]] drained so a converged run is toolchain-green.
5. **[[R-SIGF]] hardening fast-follow** — 4 deferred B-SIGF hardening passes over the R-SIGF diff. The old
   R-MWBG gating is GONE (B-WSPU beta.35 — all tiers survive via synchronous re-spawn-resume), so this is
   unblocked. Fold into a codex soak or run as fresh `/anatomy-park` + `/szechuan-sauce` over the diff.
6. **[[B-CGCAP]] codegraph default-on (v2.1)** / **[[B-ARBR]]** (idea, not a fix) — capability, DEFERRED post-GA
   (reliability-first / capability-second).

Other open residuals (all blocked from clean autonomous launch): **R-SLEAK** (P3 — session/process GC; new
machinery that conflicts with subtract-before-add, build only if leaks actually bite); **B-CIINT** (P3 —
Linux-CI-only, not locally verifiable); **#25 R-CSI** (P1 — external-event-gated).

**▶ HARD-WON LESSONS this session (encode before clearing):**
- **A fix touching the iteration loop / orchestrator MUST be built ≥`medium` tier** — a `small`-tier worker gate
  SKIPS `test:fast`, so the B-MWBG regression slipped past the build and only surfaced at the closer's full gate.
- **Do NOT token-optimize the project `CLAUDE.md`** — it carries test-pinned literal phrases; the beta.30
  token-optimize broke `release-gate-parity` + `codegraph-docs-optin-parity` (restored at the closer).
- **A null-diff audit ticket** (e.g. WS-2 found zero time-bombs) can't satisfy the commit-evidence gate → the
  manager correctly resolved it by committing the audit findings as a durable repo doc. Pre-stage that recovery.
- **Closer compile-drift**: a worker can commit `.ts` source but a stale compiled `.js` → run `npx tsc` and
  `git status` before bump; commit the recompile (and commit it EARLY, before `test:integration`, which can
  delete the compiled tree and a `git restore` would revert your fresh `.js`).
- **R-SLEAK symptom seen**: a `node require` looping over ALL session `state.json`s timed out on an old
  slow/locked one → use `timeout 3 node -e ...` per-file for phantom scans.

Rate note: the babysitter cron is **session-only** (dies when this Claude process exits) and the 5-hour rate
window cycles ~04:13/09:13/14:13/19:13 CDT — heavy work (pipelines, gates) should run with headroom, not near a
window edge.

**✅ R-SIGF / B-SIGF SHIPPED v2.0.0-beta.29 (2026-06-29, claude, babysitter pipeline + closer-takeover).** Closes
**[[R-SIGF]] full scope-auto-extension — the codex GA blocker.** Built via `/pickle-pipeline --scope branch` from
a cron babysitter; recovered through two mid-build stalls (R-MWBG medium then large-tier worker deaths). All 5
functional tickets shipped — shared detector (`18f2ccc1`), WS-1 advisory→conditional-blocking finding
(`e4c23a27`), WS-2 schema-shape consumers (`c138b29f`), WS-3 bounded opt-in auto-extension behind default-OFF
`scope.auto_extend_signature_callers` (`e5401758`), wiring (`74a7f852`) + schema-shape-aware message hardening
(`555ef2b9`); + R-MWBG half-1 (`795e539e`). Full local gate GREEN (the one real fast-c4 fail — `scope_auto_extended`
missing from the activity-logger expected-count array — fixed `b67abbad`; c=8 budget + dispatch-watchdog fails were
proven R-CIFB/R-TSPF load-flakes, isolation-green). **Hardening-deferred (honest):** the 4 in-pickle hardening
tickets did NOT complete (large-tier worker silent-death = R-MWBG runtime half) → fast-follow above.

**✅ B-CWGE SHIPPED v2.0.0-beta.26 (2026-06-28, on CLAUDE, via babysitter closer-takeover).** Closes
**[[R-CWGE]] (P1)** — the codex worker quality gate is now fail-CLOSED. Root cause confirmed: `runWorkerGate`
ran at a single callsite inside spawn-morty's `if(isSuccess)` finalize, and NO orchestrator Done-flip path
re-ran it — so codex's detached/no_progress/salvage path committed work that never reached the clean finalize,
and the oracle-based Done-flip shipped lint/tsc/test-RED. Fix: spawn-morty persists ONE `worker_gate_verdict`
(`green|red|absent`, eslint+tsc+test) frontmatter field (subsumes B-PXBO's tsc-only field); the Done-flip guard
`guardCompletionCommitBeforeDone` consults it on EVERY genuine worker Done-flip and is fail-closed — an `absent`
verdict is RECOMPUTED over the full eslint+tsc+test:fast contract (a tsc-RED tree hides from test:fast behind
stale compiled JS). The build ran a clean `/pickle-pipeline --scope branch` 4/4 (pickle→citadel→anatomy-park→
szechuan), with anatomy-park self-hardening 3 CRITICAL gaps in the new code.

**Closer-takeover note (8 commits `e804775b`..`e526edc2`):** the full release gate (which the per-phase pipeline
gates do NOT run) caught **6 issues none of which were a core B-CWGE design fault**: (1) the verdict gate
**over-reached** into the runner-authored `commitGatePassingDeliverableOnExitPath`/boundary/salvage commit path,
recomputing a real 71s gate on fixture repos → `commit-failed` (fixed `aed8e831`: scope the verdict to GENUINE
worker Done-flips — runner-authored commits already proved green via their own armed #99 gate, so persist
green and skip the recompute); (2) its AC-DURA-3 follow-on — a 2000-char source-slice test broke when the fix
comment pushed the guard+markTicketDone past the window (`2980e5e6`); (3) R-TAQ-6 subprocess-heavy load-flake
serialized (`2980e5e6`); and **(4–6) THREE pre-existing `f009608d` sweep-drift casualties** — that "sweep 35
shipped PRDs to archive/" commit orphaned three LIVE gate inputs whose audit/test paths still pointed at
`prds/` (bundle-thesis matrix+PRD `fba57e47`, closer-template PRD `82650a5e`, readiness-bundle-prd fixture
`574a4ff1`). **Lesson: when a doc-sweep moves a PRD that a gate reads, the audit/test path must follow it to
`prds/archive/<sub>/` — and the doc-sweep commit must re-run the FULL gate.** The c=8 `test:fast:budget`
FAIL_BUDGET(3) was a confirmed R-CIFB load-flake (c=4 green, 6711/6714) — non-blocking per posture.

**✅ B-APNC SHIPPED v2.0.0-beta.27 (2026-06-28, claude, babysitter closer-takeover)** — closes **[[R-APNC]] (P2)**:
anatomy-park now halts-and-reports a non-convergent subsystem (`APNC_MAX_PASSES_WITHOUT_CLEAN`, exit_reason
`anatomy_non_convergent` → non-fatal continue) + treats a complexity-regressing pass as non-progress + a
subtract-pass discipline section in `anatomy-park.md`. Mid-build the **R-WPEX detached-`claude -p` log-flush
worker death recurred** (workers died at flush, artifacts intact) → pickle hit `pipeline_phase_incomplete` 0/4;
babysitter recovered (hand-committed the verified WS-3 doc work `080e7e60` + Done-flip + relaunch → 4/4). Closer
caught + fixed the 2 new convergence-guard activity events missing from `activity-logger`'s expected list (same
event-registration class as B-CWGE; `anatomy_non_convergent` is the exit_reason, correctly NOT in the events array).

**✅ R-WPEX↻ SHIPPED v2.0.0-beta.28 (2026-06-28, claude, hand-built in-process via ultracode Workflow).** Closes
**[[R-WPEX]] (P2)**. ROOT CAUSE (sharpened to a **durability** gap, not a buffer-drain race): the spawn-morty
success/close drain awaited `sessionLog.once('finish')` (bytes → OS page cache) but **never fsynced** before the
detached, unref'd large-tier worker exits. mux-runner spawns spawn-morty `detached:true` + `unref()` +
`stdio:'ignore'`, so spawn-morty SOLELY owns the `worker_session` log; it could exit before durable persist and
the poll-reattach side then reads a **0-byte/truncated log while artifacts are intact** — exactly the B-APNC
idle-box flush-death signature (distinct from the R-WSE-2 SIGKILL/OOM 0-byte class). FIX (subtract-before-add,
`a4400e80`): reuse the existing `bestEffortFdatasync(sessionLogPath)` helper (already used by the hangGuard) on
the `once('finish')` success drain + the 5s degraded fallback — no new state field/gate/flag; the pinned
`flushAndExit` trap door (`end()` → `await once('close')` → `exit`) is UNCHANGED. A deterministic worker-shutdown
repro proved the missing fsync (RED→GREEN) + a production-source trap-door guard pins the success-drain fsync so a
revert goes RED. Secondary (`a4400e80`): manager-prompt per-ticket recovery-atomicity note (commit+Done each
recovered ticket individually, never batch across a turn) — the gap that turned the recoverable flush-death into
the B-APNC 0/4. Built on the IMMUNE in-process path (no detached `claude -p` spawned during the build); full
local gate green (tsc/eslint/10 audits + fast-c4 6727/6730 0-fail + integration 495/496 [F22-1 isolation-green
load-flake] + expensive 0-fail).

## Status

| Item | Value |
|---|---|
| Version (source = deployed) | **v2.0.0-beta.38** — B-SCOPESEED (WS-1 `621ce1b2` · WS-2 `219f0a3d` · closer fixes `65d6c04d`/`ed48092d`/`527a2c7` · bump `34da04ca`); pushed + released + ✅ DEPLOYED via install.sh 2026-07-03 (MD5 parity OK). First clean hands-off codex pipeline. Prior: **v2.0.0-beta.37** — the simplification drop (B-1SEAM `7b52789d`/`2bbf5770` · WS-3+R-CXHANG+B-RSHM `885efb73` · guard prune `2957f0c2` · bump `ad624cdd`); pushed + released + ✅ DEPLOYED via install.sh 2026-07-02. Prior: **v2.0.0-beta.36** — B-SIGFH scope-fence detector hardening (WS-1 deadline `1d095e06`/`7f3a5b66` · WS-2 bridge export forms `87e8188a` · WS-3 corpus-widen + cache-thread `b9513e45` · bump `103af4be`); pushed + GitHub-released + **✅ DEPLOYED via install.sh 2026-07-02** (MD5 parity OK on all 5 hot files; deferred one day behind the concurrent LOA-1570 session `6b10b3f7`, now cleared). Full local gate green (tsc+eslint+13 audits+fast-c4 6671/6674+integration [known lockdown flake isolation-green]+expensive). Prior: beta.35 B-WSPU (deployed) · beta.34 B-SSVR · beta.33 gate-overreach subtraction. |
| Latest GitHub release | **v2.0.0-beta.38** (B-SCOPESEED; prerelease). Prior: **v2.0.0-beta.37** (simplification drop; prerelease). Prior: **v2.0.0-beta.35** (B-WSPU dual-spawn collapse; prerelease). Prior: beta.34 B-SSVR · beta.33 gate-overreach subtraction · beta.32 R-LTDM · beta.31 R-MWBG runtime half · beta.30 B-RELHYG · beta.29 R-SIGF. |
| Test-hygiene follow-ups | ✅ **BOTH SHIPPED beta.30 (B-RELHYG).** (1) hardcoded-date fixture time-bombs — audited all 35 fixtures, **zero genuine wall-clock time-bombs** (only beta6-ga-session-resume ever qualified, already fixed); durable audit record `84464f6f`. (2) R-OMTD afterEach subprocess reap `b9bccd1a`. |
| Subsystem CLAUDE.md audit | ✅ OK (2026-05-23, `93fd5690`) — `extension/src/bin/CLAUDE.md` + `extension/src/services/CLAUDE.md` each carry a module export catalog bringing subsystem audit coverage above the script threshold. |
| Codex backend | `gpt-5.4` |
| Gate posture | Ship on the **local** gate (tsc + eslint + audits + fast-c4 + integration + expensive). **CI-green = hygiene, never a release gate.** |

### B-SIGFH codex GA field-soak — findings (2026-07-01)

Ran B-SIGFH (scope-fence detector hardening) as a `--backend codex` soak. **Verdict: codex is viable-but-fragile.** On a clean machine it completed WS-2 + WS-3 autonomously — **including the subtle cross-file cache-thread AC** (threaded `ResolverCache` into `pipeline-runner.ts:1638`) — and the completion-authority + phase-graduation guards held throughout (`phase_graduation_refused` correctly blocked false-done). But three real findings surfaced:
- **[[R-CXHANG]] codex CLI hangs in uninterruptible (D-state) sleep and accumulates unkillably across sessions (R-SLEAK amplified on codex).** 8 orphans from prior days' runs (16h–2d old) survived SIGKILL, saturated the machine, and starved my workers into 0-byte hangs — **this killed run 1.** Only an operator kill/reboot cleared them. P2, codex-GA-relevant. Needs: reap-on-exit / a session-GC that force-kills codex subtrees, or a codex-spawn watchdog. *(No PRD yet — author before the next codex soak.)*
- **codex non-convergence under load:** the WS-1 worker shipped an inconsistent deliverable (a *correct* test that caught its own incomplete code — schema-shape deadline gap) and could not converge it in 6 iterations under the degraded machine. Hand-finished (`1d095e06`).
- **[[R-SSPB]] on-`main` `--scope branch` mis-scopes the pickle phase** to the pre-build diff (the build's own commits don't exist yet at setup → workers fenced out of their target files). Patched live by broadening `scope.json`; the review-phase refresh is correct. Fix: seed pickle-phase branch-scope from the ticket file-impact set. P3. **✅ FIXED beta.38** (B-SCOPESEED WS-1 `621ce1b2`).

**POSITIVE (banked):** beta.35 synchronous re-spawn-resume held across WS-1's 6 iterations *and* preserved uncommitted work through a Failed-flip (no git-reset) — the collapse is validated under real load. **Operator lesson:** never hand-complete a ticket then resume the same pipeline — it churns the completion oracle (phantom-revert, `false_epic ×4`, duplicate commit); let the pipeline own completion, or reset fully first.

**Directives.** Drain bugs before features, P1 > P2 > P3. The babysitter drains the entire plan
with **zero operator interaction**, including the full release cycle (`git push` + `gh release
create`), gated only on a green local gate + clean tree. Sole permitted residue: external-event-
gated work. Every bundle PRD carries a `## Simplification Review` (subtract-before-add) — see
[`CLAUDE.md`](CLAUDE.md). **Log every real incident as a bug-PRD in `prds/` + a drain row** (the
loop-failure directive).

---

## ▶ Governing strategy (2026-06-23): Reliability Plan — resolved; pointer only

**`prds/RELIABILITY-PLAN-2026-06-23.md`** reframed the queue as **5 structural meta-defects**
(completion-oracle plurality · scope-fence under/over-extend · recovery sprawl · guards-on-guards ·
self-build trap) — 4-of-5 substantially shipped (see track B above); the residual is the operator-scoped
recovery-sprawl seam-collapse. The full beta.23 build/deploy narrative, the shipped REMAINING list, and the
GA field-soak proof ledger (claude: 2 clean hands-off incl. the multi-ticket additive B-RPGT run; codex:
completion-evidence PROVEN, LOA-1363 run 4) are preserved in
[`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) → "Swept 2026-07-02". The live GA bar is in
`## ⏯ RESUME HERE`: N bundles hands-off in a row, both backends.

## Drain Queue — shipped + remaining (deferred / blocked / external-gated)

> **Consolidating bundle authored (2026-06-26):** [[R-DPGT]] + [[R-DOTR]] + [[R-CRSR]] (Facets A+B) + the LOA-1588
> foreign-hash sub-finding are one wound — the **pickle phase-exit / per-ticket-budget boundary does not read the
> single `readEvidence` oracle.** PRD: `archive/bundles/p2-bug-fix-bundle-b-pxbo-phase-exit-boundary-oracle-2026-06-26.md`
> (**B-PXBO**, reuse-first, no new oracle/state). ⚠️ **SELF-MODIFYING-RECOVERY (R-PSRB)** — hand-build the
> mux-runner/completion-evidence tickets; cannot run a clean autonomous pipeline. **R-SIGF stays a separate
> parallel track** (scope-fence auto-extension — different subsystem, the other codex GA blocker).

| # | Item | Pri | State | Source |
|---|------|-----|-------|--------|
| B-1SEAM | **B-1SEAM** (P1) — collapse the 3 asymmetric-fix siblings into single seams (R-AICF + R-PSCG + R-MACB). | P1 | ✅ **BUILT 2026-07-02** (ultracode hand-build on claude per R-PSRB): WS-1 `7b52789d` (ONE predicate `evaluateCompletionEvidence`, all 8 decision sites routed, call-site audit pinned, spawn-morty verified-sha + `Pickle-Ticket` trailer reconciliation), WS-2 `2bbf5770` (`healPipelineRequiredFields` symmetric self-heal), WS-3 in `885efb73` (ONE dirty-tree salvage seam, empty-excludes sweep deleted). Premise correction: the R-AICF flag attribution was impossible (flag deleted beta.23) — see `SIMPLIFICATION-AND-FIX-PLAN-2026-07-02.md`. Ships in beta.37. | 3× `BUG-REPORT-2026-07-02-*.md` + the plan doc |
| R-CXHANG | **R-CXHANG** (codex orphaned-worker-proc reaper). | P2 | ✅ **BUILT 2026-07-02** (`885efb73`): `services/orphan-reaper.ts` — positive-ownership-mandatory reap (argv `--add-dir` under sessions root + owning session not-live), min-age 600s, SIGTERM→SIGKILL escalation, `PICKLE_ORPHAN_REAP=off`, both prior negative-PID kill sites collapsed onto shared `killProcessGroup`. Ships in beta.37; PRD archived. | `archive/bundles/p2-bug-fix-bundle-r-cxhang-codex-orphan-proc-reaper-2026-07-01.md` |
| B-RSHM | **B-RSHM** subtraction — stop-hook dead-code + chain_meeseeks retirement. | P2 | ✅ **BUILT 2026-07-02** (`885efb73`): stop-hook non-tmux continuation/checkpoint/degenerate-nudge/session-end machinery deleted (idle-backoff + update-check + tmux-passthrough KEPT); whole chain_meeseeks subsystem retired (transitionToMeeseeks, ~15 template branches, MonitorMode, settings, 2 command files; `morty-reviewer` agents + `meeseeks_pass` event untouched; no schema bump). Ships in beta.37; PRD archived. | `archive/bundles/p2-subtraction-retire-stophook-deadcode-and-chain-meeseeks-2026-07-01.md` |
| R-PSAM | **R-PSAM** (Pickle Standup Author-`@me`) — `/pickle-standup` Step 2.5 commit scan uses `git log --author="@me"`, which git never resolves (it's a `gh` idiom); the author filter matches nothing so every un-PR'd local-branch ticket is silently dropped from Y:. Proven on LOA-1570: `@me`→0 commits, real email→28. Fix = resolve `@me` to `git config user.email` per-`$repo` in the `git log` line only (leave the `gh pr list --author "@me"` lines). Prompt-only change in `.claude/commands/pickle-standup.md`. | P3 | ✅ **SHIPPED v2.0.0-beta.38** (2026-07-03, B-SCOPESEED WS-2 `219f0a3d`, clean codex pipeline): Step 2.5 resolves `git config user.email` per-`$repo`; `gh pr list --author "@me"` lines unchanged; empty-identity guard added. | `BUG-REPORT-2026-07-01-standup-git-author-me-drops-local-branch-tickets.md` |
| R-SSPB | **R-SSPB** — on-`main` `--scope branch` mis-scopes the PICKLE phase to the pre-build diff (the build's own commits don't exist at setup → workers fenced out of their own target files; the review-phase scope refresh is correct). Fix = seed the pickle-phase branch-scope from the ticket file-impact set. | P3 | ✅ **SHIPPED v2.0.0-beta.38** (2026-07-03, B-SCOPESEED WS-1 `621ce1b2`): `setupScope` seeds an empty/pre-build branch scope from the ticket file-impact set (`persistSeededBranchScope` + `pipeline-scope-ticket-seed.test.js`); review-phase refresh + scope-resolver fail-closed invariants untouched; anatomy-park self-hardened the new test (`41e554bc`). | B-SIGFH soak findings + `archive/bundles/p3-bug-fix-bundle-b-scopeseed-rsspb-rpsam-2026-07-02.md` |
| R-SZGB | **R-SZGB** — szechuan per-iteration gate CONVERGED over tsc-RED commits: the Small-Functions pass shipped 5 tsc errors + 1 eslint error + 3 broken source-pin tests + compiled-JS drift, all invisible until the closer's full gate. ✅ **Mechanism VERIFIED 2026-07-04 (Hypothesis 2)** vs session `2026-07-02-b3c45331`: repo-root target → `detectProjectType` (single-dir, no walk) → null → `emitSkippedAndReturn` persists EMPTY baseline (`project_type:null, checks:[]`) → replay subtracts vs zero checks → tsc-RED converges clean; anatomy-park shared it. Fix = WS-1 bounded package-root resolution + WS-2 fail-CLOSED on an uncertifiable baseline; reuse-first via `runGate`, no new gate/flag/state field. | P2 | ✅ **BOTH WS BUILT + COMMITTED on `main` 2026-07-05 (session `2026-07-05-5865291f`, claude, dogfooded /pickle loop) — RELEASE/DEPLOY PENDING closer (no bump/tag/install.sh yet).** WS-1 R-SZGB-A (`e284c7ca`, bounded package-root walk). WS-2 R-SZGB-B (`cceef8b4`, fail-CLOSED on `project_type:null` uncertifiable baseline via `runChangedPerIterationGate` — covers BOTH per-iteration replay + worker-managed convergence seams; conformance ALL_PASS, code review PASS, tsc/eslint clean, fast-c4 6642-0, no new field/flag/event). Code review surfaced follow-up **[[R-SZGB-C]]** (below). | `BUG-REPORT-2026-07-03-szechuan-periteration-gate-converges-tsc-red-commits.md` + PRD `p2-bug-fix-bundle-r-szgb-periteration-gate-fail-open-2026-07-04.md` |
| R-SZGB-C | **R-SZGB-C** (follow-up surfaced by R-SZGB-B code review, session `2026-07-05-5865291f`) — the WS-2 uncertifiable-baseline defer does NOT set `selfRedOpen: true`, so `handlePostConvergenceGateDeferral`'s existing "never force-converge by attrition" latch (`microverse-runner.ts:3667-3681`) does NOT protect this class. A target that stays uncertifiable across ≥`POST_CONVERGENCE_GATE_DEFERRAL_LIMIT` (3) consecutive worker-signaled-convergence iterations will silently converge despite a tsc-RED tree — the exact defect R-SZGB-B closes for the single/few-iteration case, reopened at iteration 3+. Fix = set `selfRedOpen: true` on the uncertifiable-baseline defer path (`handleWorkerManagedIteration`'s `iterationLeftRegression` branch, `:1173-1184`) so the existing attrition latch engages — REUSE the existing latch, no new state field/gate. Pipeline-safe (gate-decision seam, NOT R-PSRB salvage path). | P2 | **FILED 2026-07-05 — not yet scoped into a PRD.** | R-SZGB-B `code_review_2026-07-05.md` (session `2026-07-05-5865291f/93ea5281/`) |
| R-LTNC | **R-LTNC** — pickle-rick's internal ticket artifact `linear_ticket_<hash>.md` collides in name with the real Linear.app tracker (accessed via Linear MCP); pipeline-internal tickets (incl. hardening tickets) have been mistakenly created as real Linear issues at least once. Fix: rename the internal artifact to `rick_ticket_<hash>.md` across `.ts` source + compiled `.js` + tests + command/agent prompts (real Linear-facing code — `LinearTicketFields`/`syncLinearTicketStatus`/`linear_issue_id`/`PICKLE_LINEAR_COMMAND` — explicitly preserved), + carve out `~/loanlight/CLAUDE.md`'s "Use Linear MCP for tickets" rule to scope it to PRD-level epics only. Verified zero runtime-correctness risk (no shared variables/IDs between the two systems) — pure process-confusion/vocabulary fix, not a reliability defect. Pipeline-safe (not R-PSRB) — no salvage/completion-evidence/Done-flip path touched. | P3 | **PRD AUTHORED 2026-07-05 — ready to refine/build.** | session `2026-07-05-90457593/prd.md` |
| R-TCVC | **R-TCVC** — `classifyTicketTier` has no signal for acceptance-criteria verification cost (pure fileCount/acCount/LOC + 9-word keyword list); a ticket whose ACs bundle a slow container-based verify command (e.g. `test:migration`) is sized identically to one with only cheap greps. Surfaced forensically reviewing session `2026-07-04-4f50b896` ticket `43e8f1a9` (6 zero-progress spawns before `commit-and-continue` salvaged real work). Fix: extend the existing keyword/dimension extraction (already sourced from ticket AC text during `/pickle-refine-prd`) to recognize known-expensive verify-command shapes and bump tier/timeout accordingly — no new state field/gate. | P3 | **BUG FILED 2026-07-05 — not yet scoped into a PRD.** | `BUG-REPORT-2026-07-05-tier-classifier-blind-to-verification-cost.md` |
| R-HNCG | **R-HNCG** — worker `handoff_notes.md` continuity has no enforcement/fallback: it's written only as a "before you finish" step, so a spawn that runs out of turns mid-verification (audit/verification-heavy tickets have no natural implement-phase pause point) loses ALL progress memory for the next spawn, which then re-derives everything from scratch. Same session/ticket as R-TCVC: `43e8f1a9/handoff_notes.md` never existed across 6 spawns despite escalating real progress (5→38→6 diff hunks, a full passing 262/262 test run at spawn 6) that never got written up or committed. Fix: either make handoff-notes a forced per-AC-confirmed checkpoint, or have spawn-morty mechanically append a minimal fallback note on a zero-artifact exit (reuses existing `worker_artifact_progress` signal) — no new state field/gate. | P3 | **BUG FILED 2026-07-05 — not yet scoped into a PRD.** | `BUG-REPORT-2026-07-05-handoff-notes-continuity-gap-on-verification-heavy-tickets.md` |
| R-SLEAK | **R-SLEAK** (+ R-PSRB/R-OMTD/R-WSDO context) — session/process leak + contention-gauge | P3 | **PARTIAL — R-OMTD ✅ + R-WSDO ✅ SHIPPED beta.22; R-PSRB documented; R-SLEAK OPEN.** **R-OMTD (`b20a4c1a`):** pipeline-runner spawns mux children `detached` + reaps the subtree via `reapChildSubtree`/negative-PID on teardown (no more PPID-1 orphans). **R-WSDO (`177b84a7`):** `worker_produced_nothing` breadcrumb shipped. **R-PSRB (design, documented — not a code fix):** recovery-machinery bundles can't self-build (deployed pre-fix runtime salvage-resets the ticket building the fix); build protocol = hand-build recovery-path tickets then install.sh-deploy. **R-SLEAK (OPEN, P3 hygiene):** leaked tmux sessions + orphan runners persist for days; `pgrep -f claude` over-counts (matches node runners + own shell) → real worker-contention gauge is `ps -eo command \| grep -E '/claude '`. Session-GC unbuilt. | `BUG-REPORT-2026-06-21-pipeline-self-referential-build-catch22-and-orphan-mux.md` |
| B-ARBR | **B-ARBR (IDEA — 2026-06-29, captured from a LoanLight Arbor-fit review, LOA-1651)** explore using Arbor (keyless MCP autonomous metric-optimizer; HTR Idea Tree + held-out merge margin) to **tune the szechuan-sauce + anatomy-park review prompts** against a review-quality harness. Fit rationale: the prompts are a fully-ours, unconstrained tunable surface; prompt-tuning is Arbor's strongest mode; Arbor's git-worktree isolation is exactly right for parallel code-mutating review runs. **Inverse of [[R-MVFM]]** — there PR *borrows* HTR for the microverse loop; here Arbor *optimizes* PR's own prompts (complementary, not contradictory). **Make-or-break is the metric, not the ~50-line wiring:** review quality must be a **balanced, held-out** score (defect recall + regression rate + scope-adherence); a one-sided metric self-games instantly (optimize recall → flag-everything reviewer-noise; optimize safety → change-nothing). Taste ("is this code worthy") does not quantify and stays human. **Cheapest PoC:** tune szechuan to drive **off-scope-commit rate → 0** ([[reference_szechuan_soft_scope_escape]] / R-SSOC soft-scope-escape; objective, non-gameable, currently failing → real headroom) while holding deslop value at a floor. | P3 | **IDEA — capture-only, NOT scoped.** Deferred behind the reliability queue (R-MWBG runtime half P1, then R-MVFM P3). Subtractive cross-link: R-MVFM already recovers ~90% of HTR's *microverse* benefit cheaply — this is a **different surface** (review prompts), so it does not subsume R-MVFM and vice-versa. No PRD yet; author one (with the harness/metric spec) only if pursued. | capture-only — LoanLight Arbor review 2026-06-29 (Linear LOA-1651) |
| 124 | **R-DPMC-3** decomposition-satisfiability residual | P2 | **DEFERRED** — large additive machinery; needs operator sign-off (R-DPMC-1/-2 already shipped: B-DECOMP-SAT beta.17 / B-GROUND2 beta.16). | `archive/bundles/p2-bug-fix-bundle-b-decomp-sat-decomposition-satisfiability-2026-06-18.md` |
| 125 | **B-GSUB** functional seam-collapse (the simplification track) | P2 | **DOC TRACK CLOSED (−9); functional lever LARGELY SHIPPED.** B-GSUB's own empirical conclusion: pure doc-guard deletion is NOT the lever — B-GROUND2-style **functional** seam-collapse is, which has largely shipped (B-GROUND2 beta.16 + B-DURA single-oracle beta.23 + B-PXBO beta.25 + R-CWGE beta.26 = 4-of-5 Reliability-Plan meta-defects). **Residual = recovery sprawl (the 5th)**: the next seam to collapse (e.g. [[R-DPMC-3]]) is operator-scoped + soak-ranked, needs sign-off on WHICH seam. Pure subtraction, no new machinery. | `archive/bundles/p2-simplification-pass-guard-inventory-subtraction-2026-06-18.md` |
| 119 | **B-CIINT** integration-tier CI-env e2e failures | P3 | **OPEN** — Linux-CI-only subprocess-e2e flakiness; CI hygiene, **not a release gate**. Pass locally (macOS). | `archive/bundles/p3-bug-fix-bundle-b-ciint-integration-tier-ci-env-e2e.md` |
| — | **B-CGCAP** codegraph default-on (v2.1) | P2 | **DEFERRED post-GA** (reliability-first / capability-second). | `p2-codegraph-default-on-capability-v2.1.md` *(pinned)* |
| — | **B-GIMA** guard-inventory & finding-shape mining audit (v2.2) | P2 | **DEFERRED post-reliability + post-codegraph.** Sole survivor of the slop-gate comparative review: an inert, report-only tool that operationalizes subtract-before-add (DELETE never-fired-guards / JUDGE-CALIBRATION conf<80 drops / ADD sort-hints). REUSES codegraph (v2.1) as code-liveness substrate — design dependency, not calendar. Kill-criteria baked in: report-only or dead. Evidence-gating insight from the same review → release-2 R-CWGE/R-DOTR, NOT here. | `p2-guard-inventory-mining-audit-v2.2.md` |
| 13 | **B-DWF-2** retire legacy refinement subprocess | P3 | **⏸️ SHELVED** — soak-harness prereq unmet; legacy path retained for zero regression. | `archive/bundles/p3-bug-fix-bundle-b-dwf2-retire-refinement-subprocess.md` |
| 25 | **R-CSI** concurrent-session destructive-command interference (DATA-LOSS class) | P1 | **EXTERNAL-GATED** — re-activates on the next real concurrent-session incident to analyze. | `archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md` |

> **Recently shipped + swept to `archive/`:** **B-SCOPESEED (beta.38, 2026-07-03)** — R-SSPB pickle-phase
> scope seeding (`setupScope`/`persistSeededBranchScope` + seed test) + R-PSAM standup author resolution;
> built by the FIRST clean hands-off codex `/pickle-pipeline` (4/4, 139m, zero intervention — soak rep #1).
> **Lessons:** push local-ahead commits BEFORE an on-`main` `--scope branch` launch (a local docs diff scopes
> the build to `prds/`); the closer caught 9 review-phase escapes → [[R-SZGB]] capture (szechuan gate converged
> over tsc-RED); source-pin tests broken by a refactor = verify the invariant survived, then sync anchors
> (timer params → constructor parameter properties; exhausted-seam count = 7 direct + 1 via helper). PRD →
> `archive/bundles/`. · **THE SIMPLIFICATION DROP (beta.37, 2026-07-02)** — B-1SEAM (ONE completion predicate at all 8 decision sites + call-site audit + spawn-morty verified-sha/`Pickle-Ticket`-trailer reconciliation; symmetric `prd_path`+`start_commit` self-heal; ONE dirty-tree salvage seam) + R-CXHANG positive-ownership orphan reaper + B-RSHM (stop-hook dead branches + chain_meeseeks retired) + guard-layer prune (4 orphan + 2 advisory audits deleted, design-ground-truth demoted → 9-audit gate, ONE bypass surface, legacy kill-switches removed, codex-manager-relaunch shim collapsed). Net ~−3,650 LOC. **Lessons:** verify a bug report's mechanism against source BEFORE authoring the fix (R-AICF's flag was deleted beta.23 — the live defect was per-call-site policy divergence); subagent background test runs die at agent turn-end — run gates from the orchestrator; trap-door entries are one line ≤1500 chars; a predicate that persists on every decision kind makes direct-oracle-call test fixtures order-sensitive; two prune items honestly no-go'd on evidence (trap-door audit is a superset; "write-only" flags had readers). PRDs: R-CXHANG + B-RSHM → `archive/bundles/`; B-1SEAM's authoring artifact is `SIMPLIFICATION-AND-FIX-PLAN-2026-07-02.md`. · **B-WSPU (beta.35, 2026-07-01)** — collapse the dual worker-spawn model: DELETE the detached lifecycle (spawn arm + poll + disposition + `state.detached_worker` + `large_tier_*` events + ~11 test files + trap doors), route all tiers through synchronous re-spawn-resume. ~1000+ LOC pure subtraction. **Lessons:** the 600s ceiling is an unremovable harness cap but synchronous re-spawn-resume already survives it, so detached was optimization-not-correctness; a detached fix-worker silent-died building its own deletion (re-tier small→synchronous to dodge); review-phase subprocesses SIGHUP-unstable this session (closer-direct on the full gate); do NOT misread a long manager turn (frozen state.json mtime) as a stall — check real process liveness first. Deployed 2026-07-01 (operator-authorized). · **B-SSVR (beta.34, 2026-06-30)** — R-SSBR scope-resolver
> fail-CLOSED on a stale/ahead base ref (`9592eb46`) + R-ISVP install.sh prerelease semver (`d260012e`); closer caught
> 2 gate-missed bugs (WS-1 multi-line trap-door → citadel line-parser `73f780bf`; beta.33-left-red keystone stale-test
> `8e987d87`). **Lessons:** trap-door catalog entries MUST be a SINGLE physical line (the citadel
> `rule-set-invariant-audit` parser is line-oriented — a wrapped INVARIANT/BREAKS reads as no-BREAKS); a grammar-deletion
> subtraction (beta.33 forward-ref) must grep every test/fixture that RELIED on the deleted grammar (keystone shipped red);
> late-flushing detached workers can land green output AFTER a `phase_no_progress` verdict (verify FS before trusting the
> flip — B-WSPU field evidence). · **R-SIGF / B-SIGF (beta.29, 2026-06-29)** — scope-fence
> caller-gap detect-and-block + bounded opt-in auto-extension + schema-shape consumers (the codex GA blocker); +
> R-MWBG half-1 (manager foreground-spawn fix). Shipped via babysitter recovery through an R-MWBG mid-build stall;
> 4 in-pickle hardening tickets deferred (large-tier worker silent-death → R-MWBG runtime half). · **R-WPEX (beta.28, 2026-06-28)** — detached-worker
> session-log fsync on the success/close drain (reuse `bestEffortFdatasync`); hand-built in-process via an
> ultracode Workflow (repro-first), full local gate green, no recovery-path pipeline needed. · **B-APNC
> (R-APNC, beta.27, 2026-06-28)** — anatomy-park
> convergence/complexity halt guard + subtract-pass discipline; built on claude, shipped via babysitter
> closer-takeover (recovered an R-WPEX log-flush 0/4 stall mid-build; closer fixed the 2 new guard activity
> events' registration). · **B-CWGE (R-CWGE, beta.26, 2026-06-28)** — codex worker-gate
> verdict authority, fail-closed; built on claude, shipped via babysitter closer-takeover (the closer's full
> gate caught 1 verdict over-reach into the runner-authored commit path + 3 pre-existing `f009608d` sweep-drift
> audit/test path casualties). · **B-PXBO (R-DPGT + R-DOTR + R-CRSR + R-OMA, beta.25)** ·
> B-PCOMP · B-RFCU · R-WSDO · R-CECB · R-RCFF (beta.22) ·
> B-DURA + R-REIN + WS-2/WS-5 (beta.23) · **B-RPGT (R-RPGT + R-S529, beta.24)** — drain rows removed; source PRDs
> moved to `archive/bundles` + `archive/bug-reports`. **R-PFNT facets 1+2 / R-CECX are now codex-PROVEN HELD
> (LOA-1363 run 4, 2026-06-24)** — completion-evidence class closes on codex; they stay above only as the
> proof record. The LIVE residuals are now **[[R-SIGF]] (load-bearing, 2nd repro)** + **[[R-DPGT]] (new)** +
> **[[R-DOTR]] (new — Done over committed-red on the timeout path)** — the phase-completion + completion-
> correctness blockers. The 2026-06-24 sweep also archived ~30 older shipped PRDs/design-notes.
>
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
