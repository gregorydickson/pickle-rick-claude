---
# MASTER_PLAN — Pickle Rick Engineering Lifecycle

**Live ledger.** The babysitter (`babysitter.md`) re-reads this each tick, so it is kept lean
on purpose. Shipped-release detail and closed-finding forensics live in
[`MASTER_PLAN-archive.md`](MASTER_PLAN-archive.md) + `git log`; the full finding catalog is in
[`BUG-INDEX.md`](BUG-INDEX.md).

**Updated 2026-06-28.** Shipped + deployed through **v2.0.0-beta.27** (B-APNC anatomy-park convergence guard;
beta.26 B-CWGE codex worker-gate verdict authority; beta.25 B-PXBO phase-exit oracle). The **known reliability
defect classes are now all code-fixed at root**: the 14-incident completion-commit/Done-flip cluster
(B-PCOMP beta.22 start/finish gates + **B-DURA beta.23** durable-iteration-boundary core, evidence-archaeology
layer deleted), AND the independent review-phase 0/4 cause (**B-RPGT beta.24**: review/cleanup phases can no
longer converge over a tsc/eslint-RED tree, and a transient 529 no longer aborts a 3-hr pipeline — both
reuse-first, no new machinery).

**Reliability scorecard.** Code/mechanism ✅ — the most-fixed it has ever been. claude field-soak 🟢 — **2 clean
hands-off runs, now incl. a live MULTI-TICKET ADDITIVE bundle** (B-RPGT: 5 tickets, 4/4 phases, 178m, ZERO
mid-run intervention, the 529-abort bug never fired, anatomy-park self-hardened the new code) — the exact run
the soak required. codex field-soak 🟡 — **the AC-DURA-4 field-proof RAN (LOA-1363 run 4, beta.24, 2026-06-24):
completion-evidence facets PROVEN on codex — R-CECX + R-PFNT facets 1+2 HELD (14/14 durable, 0×
`oversized_no_progress`, single oracle).** But that run finished **0/2 phases (citadel skipped)** — blocked NOT
by the fixed facets but by [[R-SIGF]] (2nd independent repro) cascading into a NEW detached-phase-gate seam
[[R-DPGT]] + completion-*correctness* gap [[R-DOTR]] (a `no_progress_timeout` ticket flipped `Done` over
non-compiling committed code — the inverse of the R-CECX fix). So on codex: *completion-evidence* soak ✅ /
*completion-correctness* 🔴 / *phase-completion* soak 🔴. The reliability *code* (oracle/label/durability) is
proven on claude AND now on codex; the remaining GA gap is R-SIGF + R-DPGT + R-DOTR, not the completion oracle.

**Autonomous-development scorecard.** The build→citadel→anatomy-park→szechuan-sauce pipeline now runs a real
multi-ticket additive bundle **fully hands-off on claude** (B-RPGT). Remaining autonomy gaps, in order of bite:
(a) the **closer** (version bump · `install.sh` deploy · `gh release`) is NOT auto-run by `pipeline-runner` —
it finishes 4/4 then stops, so a babysitter still ships; (b) **recovery-machinery bundles can't self-build**
(R-PSRB) — must hand-build; (c) per-phase gates don't run the FULL release gate, so debt surfaces at the
closer (B-RPGT's closer caught pre-existing gate-parity drift + 2 over-limit trap-door entries the review
phases added — tsc/eslint-clean but tripping AC-BUNDLE-17).

**The codex AC-DURA-4 field-proof RAN (LOA-1363 run 4, beta.24, 2026-06-24)** — it converts the
completion-evidence classes (R-CECX, R-PFNT facets 1+2) to **codex-proven ✅** and re-points the GA blocker:
the highest-value next step is now **[[R-SIGF]] full scope-auto-extension (must cover schema-shape consumers,
not just signature/type callers)** + the new **[[R-DPGT]] detached-phase-gate grace** + **[[R-DOTR]] Done-flip
green gate on the timeout path** — together they own the residual `0/N phases → downstream skipped` AND
`Done-over-red`. See
`BUG-REPORT-2026-06-24-codex-fieldproof-loa1363-run4-rsigf-corroboration-and-detached-phasegate.md`.

## ⏯ RESUME HERE (updated 2026-06-29 — R-SIGF SHIPPED beta.29; R-MWBG runtime-half NEXT)

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

**▶ IN FLIGHT: [[R-SIGF]] → B-SIGF (P1, the codex GA blocker).** PRD authored 2026-06-29 by the babysitter:
`prds/p1-bug-fix-bundle-b-sigf-scope-auto-extension-2026-06-28.md`. Reuse-first design (the advisory detector
`findSignatureChangeCallerGapFindings` already ships, `a668687f`): **WS-1** promote it advisory→blocking (reuse,
unified skip hatch + W5b budget), **WS-2** extend to schema-shape consumers (2nd repro: changed zod
`thresholdSchema` shape broke out-of-fence sibling specs), **WS-3** bounded scope auto-extension behind a
default-OFF `scope.auto_extend_signature_callers` setting so the safe block ships first and the
isolation-touching capability is opt-in until soak. Scope-fence subsystem, NOT recovery-path (R-PSRB N/A) →
pipeline-safe. **✅ SHIPPED v2.0.0-beta.29 (2026-06-29, claude, babysitter-recovered + closer-takeover).** Closes
**[[R-SIGF]] full scope-auto-extension (P1, the codex GA blocker).** All 5 functional tickets shipped — shared
detector module (`18f2ccc1`), WS-1 conditional-blocking finding (`e4c23a27`), WS-2 schema-shape consumers
(`c138b29f`), WS-3 bounded opt-in auto-extension behind default-OFF `scope.auto_extend_signature_callers`
(`e5401758`), wiring (`74a7f852`) + schema-shape-aware finding-message hardening (`555ef2b9`). The R-MWBG
manager-prompt fix (`795e539e`, half-1) un-stalled the medium-tier build mid-run. Full local gate GREEN
(tsc/eslint/10 audits + integration 0-fail + expensive 0-fail + fast-c4: 1 real fail = `scope_auto_extended`
event-count sync, fixed `b67abbad`; residual dispatch-watchdog fail is a proven R-TSPF load-flake, isolation-green,
non-B-SIGF file). **⚠️ Hardening-deferred (honest):** the 4 in-pickle hardening tickets (data-flow / test-quality /
cross-ref + part of code-quality) **did NOT complete** — their large-tier workers died on the [[R-MWBG]]
silent-death class (0-byte/116-byte logs, pre-success-drain, NOT covered by beta.28's R-WPEX fsync fix). The full
release gate (deterministic correctness + all test tiers) is the substitute correctness floor; the LLM hardening
review passes are a **fast-follow** gated on the R-MWBG runtime half (large-tier detached lifecycle fix).

## Status

| Item | Value |
|---|---|
| Version (source = deployed) | **v2.0.0-beta.29** — R-SIGF scope-fence caller-gap detect-and-block + bounded opt-in auto-extension (+ R-MWBG manager foreground-spawn fix half-1); built on claude (babysitter-recovered through an R-MWBG mid-build stall), deployed via install.sh 2026-06-29. |
| Latest GitHub release | **v2.0.0-beta.29** (R-SIGF + R-MWBG half-1; prerelease). Prior: beta.28 R-WPEX · beta.27 B-APNC · beta.26 B-CWGE · beta.25 B-PXBO · beta.24 B-RPGT. |
| Test-hygiene follow-ups (non-blocking) | (1) **hardcoded-date fixture time-bombs** — beta6-ga-session-resume's `started_at: 2026-06-15` aged past `pruneOldSessions` and broke the test (fixed via dynamic date); audit for other hardcoded ISO dates in fixtures. (2) **R-OMTD test leaks subprocesses** — pipeline-runner-orphan-mux-teardown leaves `mux.js`/`grandchild.js` running on failure; needs `afterEach` cleanup (65 leaked over one session choked the local gate). |
| Codex backend | `gpt-5.4` |
| Gate posture | Ship on the **local** gate (tsc + eslint + audits + fast-c4 + integration + expensive). **CI-green = hygiene, never a release gate.** |

**Directives.** Drain bugs before features, P1 > P2 > P3. The babysitter drains the entire plan
with **zero operator interaction**, including the full release cycle (`git push` + `gh release
create`), gated only on a green local gate + clean tree. Sole permitted residue: external-event-
gated work. Every bundle PRD carries a `## Simplification Review` (subtract-before-add) — see
[`CLAUDE.md`](CLAUDE.md).

**⏱️ Operating mode (2026-06-24): OBSERVATION.** The known reliability defect classes are code-fixed and the
drain queue is short. We are now **running Pickle Rick live for a few days to collect field data** on the two
goals (reliability + autonomous development) rather than draining the remaining deferred/external-gated work.
Per the loop-failure directive: **log every real incident as a bug-PRD in `prds/` + a drain row** — those
become the next evidence-backed work. The codex AC-DURA-4 field-proof is the one high-value run that can be
done during this window; everything else open is deferred-by-design or external-gated.

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
1. ~~**Codex AC-DURA-4 field-proof**~~ — ✅ **RAN 2026-06-24 (LOA-1363 run 4, beta.24).** Completion-evidence
   class PROVEN on codex (R-CECX + R-PFNT 1+2 held, 14/14 durable); but **phase-completion FAILED 0/2 (citadel
   skipped)** via [[R-SIGF]] → [[R-DPGT]]. GA-on-codex now gated on those two, NOT the completion oracle. Next
   codex rep should land AFTER R-SIGF schema-shape auto-extension + R-DPGT detached grace ship.
2. ~~**Review-phase gate gaps** (R-CECX run-3 follow-up #2, facets 4–6)~~ — ✅ **SHIPPED B-RPGT v2.0.0-beta.24**
   (R-RPGT review-phase hard typecheck gate on abort + R-APXG-3 cap; R-S529 529→transient park-and-retry). See drain row.
3. **▶ B-PXBO (NEXT — authored 2026-06-26, `4437395a`)** — phase-exit boundary reads the `readEvidence` oracle:
   closes [[R-DPGT]] + [[R-DOTR]] + [[R-CRSR]] + LOA-1588 foreign-hash. Reuse-first, no new oracle/state.
   **R-PSRB self-modifying-recovery → hand-build.** See the RESUME HERE block at the top.
4. **R-SIGF full scope-auto-extension** (only the advisory flag shipped) + the wide oracle characterization net.
   Separate parallel track from B-PXBO (scope-fence subsystem, not the phase-exit oracle).
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
run-3 follow-up #2 (review-phase tsc/lint-RED commits + transient-529 szechuan abort). **LOA-1363 run 4
(2026-06-24, beta.24) IS the codex re-run on the fixed runtime** → [[R-DPGT]]: R-CECX + R-PFNT facets 1+2 ✅
PROVEN HELD (14/14 durable, 0× `oversized_no_progress`, single oracle), but it finished **0/2 phases (citadel
skipped)** via [[R-SIGF]] 2nd-repro (out-of-fence schema-shape RED) cascading into a NEW detached-phase-gate
seam — so the *completion-evidence* soak passes on codex while the *phase-completion* soak does not. Net: the
completion-class is now codex-proven; phase-completion is blocked on R-SIGF + R-DPGT. Drop `-beta` when
repeatability holds on BOTH backends with no new completion-class seam.

## Drain Queue — shipped + remaining (deferred / blocked / external-gated)

> **Consolidating bundle authored (2026-06-26):** [[R-DPGT]] + [[R-DOTR]] + [[R-CRSR]] (Facets A+B) + the LOA-1588
> foreign-hash sub-finding are one wound — the **pickle phase-exit / per-ticket-budget boundary does not read the
> single `readEvidence` oracle.** PRD: `p2-bug-fix-bundle-b-pxbo-phase-exit-boundary-oracle-2026-06-26.md`
> (**B-PXBO**, reuse-first, no new oracle/state). ⚠️ **SELF-MODIFYING-RECOVERY (R-PSRB)** — hand-build the
> mux-runner/completion-evidence tickets; cannot run a clean autonomous pipeline. **R-SIGF stays a separate
> parallel track** (scope-fence auto-extension — different subsystem, the other codex GA blocker).

| # | Item | Pri | State | Source |
|---|------|-----|-------|--------|
| R-MWBG | **R-MWBG (NEW — 2026-06-29, B-SIGF pickle stall) — pickle manager backgrounds a medium-tier worker spawn and ends its `-p` turn → worker killed at turn-end → 0-byte log → `pipeline_phase_incomplete` 0/4.** The `claude -p` manager mis-applied the top-level agent's "Bash `run_in_background` + harness re-invokes me" pattern; a `-p` subprocess gets no re-invoke and its backgrounded child dies at turn-end (`task status:killed` stamped at the manager result epoch). Trigger: medium worker `worker_timeout=1200s` > the 600s Bash ceiling, with NO sanctioned ceiling-survival path for medium tier (only LARGE has the detached lifecycle). Distinct from [[R-WPEX]] (flush-death, artifacts intact) + R-WSE-2 (SIGKILL). Blocks autonomous medium-tier bundles non-deterministically. **⬆ LARGE-TIER evidence (B-SIGF 2026-06-29):** the 4 large-tier hardening workers ALSO died (0-byte/116-byte logs, `no_progress_timeout`) — so the death is NOT medium-only; the LARGE detached lifecycle is ALSO failing pre-success-drain (uncovered by beta.28). | P1 (NEXT) | **half-1 ✅ SHIPPED beta.29 (`795e539e`** — manager-prompt foreground-spawn discipline; validated end-to-end, un-stalled B-SIGF medium tickets mid-build). **Runtime half OPEN (P1 NEXT):** Fix (subtract-before-add, two halves): (1) **manager-prompt forbid** Bash-`run_in_background` for worker spawns (state the `-p`-turn-end-kills-background fact; build in-process via `morty-implementer` or use the detached lifecycle) — cheap, buildable normally; (2) **runtime**: extend `routeLargeTierTicket`/`state.detached_worker` (B-WPEX-AUTO) to ANY tier whose `worker_timeout` > Bash ceiling, not just `large` — **R-PSRB hand-build** (edits mux-runner worker-spawn lifecycle). Ship half (1) before relaunching B-SIGF. | `BUG-REPORT-2026-06-29-manager-backgrounds-medium-worker-killed-at-turn-end.md` |
| R-WPEX↻ | **R-WPEX RECURRENCE + inline-recovery gap (2026-06-28 B-APNC build; initially mis-filed R-WUDC, corrected)** pickle exited `pipeline_phase_incomplete` 0/4. ROOT CAUSE: the detached `claude -p` spawn-morty workers **died on log-flush** (manager: "worker died on log-flush, not on the work") — the KNOWN R-WPEX/worker-silent-exit class, previously MONITOR-only ([[project_wpex_worker_silent_death_monitor]]), now a fresh non-load repro. Manager inline-recovered both tickets (committed `5dc68f98`→`4ad6d2d9` Done; delivered WS-3 `6803d887` via in-process morty-implementer) but the pickle loop EXITED after committing only 1/2 → WS-3 left uncommitted+Todo → 0/4. NOT a new doc-only/B-DURA-boundary bug (that hypothesis retracted). | P2 | **✅ SHIPPED v2.0.0-beta.28 (2026-06-28, claude, hand-built in-process via ultracode Workflow).** Root cause sharpened to a DURABILITY gap: the spawn-morty success/close drain awaited `once('finish')` (page cache) but never fsynced before the detached unref'd worker exits → 0-byte/truncated log, artifacts intact. FIX (`a4400e80`, subtract-before-add): reuse `bestEffortFdatasync(sessionLogPath)` on the `once('finish')` success drain + 5s fallback; no new field/gate/flag; pinned `flushAndExit` trap door unchanged. Deterministic repro RED→GREEN + production-source trap-door guard added. Secondary: manager-prompt per-ticket recovery-atomicity note. Built on the immune in-process path; full local gate green. Bug report swept to `archive/bug-reports/`. | `archive/bug-reports/BUG-REPORT-2026-06-28-rwpex-detached-worker-logflush-recurrence.md` |
| R-PFNT | **R-PFNT** green build reports `0/4 phases` (codex multi-ticket) — **B-PCOMP finish-gate NOT a single oracle.** (1) phantom-Done watcher ACCEPTS `b17cc3fe` (`valid completion_commit evidence` ×3) while flip-gate `readEvidence()` FATALS it (`kind==='absent'`) on the SAME frontmatter (`completion_commit: 9adfed909` present) — two oracles, opposite verdicts; the fatal demands a `completion_commit` already there. (2) `wmw-auto-skip` flips all 3 detached `large`-tier hardening tickets → `Failed/oversized_no_progress` (misclassifies scope-fence-ambiguity stall as "oversized"). (3) `Failed` is non-terminal for phase advance → 3 failed *polish* tickets atop 10 Done verified-green *build* tickets → `Pipeline finished: 0/4 phases` and citadel/anatomy/szechuan never run. Independently verified at halt: 12 commits, typecheck clean, **978 tests 0-fail**, 22/22 files lint-clean. | P1 | **✅ CODE-FIXED in B-DURA / beta.23 — pending codex field-proof.** All three facets addressed: (1) two-oracle split → ONE `readEvidence` oracle, watcher≡flip-gate (T30 `be667dee`); (3) `Failed`-non-terminal → terminal-for-advance under the empty-window guard (T40 `f788aa43`); (2) `oversized_no_progress` misclassification → split into `scope_unresolvable`/`no_progress_timeout` (WS-2d `b60a112e`) + parseable hardening fence (`5ad07e3c`) + toolchain fail-fast (`7b69f22a`). **✅ RE-RUN on codex 2026-06-24 (LOA-1363 run 4, beta.24): facets 1+2 PROVEN HELD** — 0× `oversized_no_progress` (7× `no_progress_timeout`), single oracle, 14/14 durable. Facet 3's empty-window fix held for `Failed`-non-terminal, but a **NEW variant surfaced → [[R-DPGT]]**: detached large-tier tickets non-terminal at the pickle iteration/detached-poll cap → `0/2 phases`, citadel skipped, while their commits landed 4–10 min later. Root driver = [[R-SIGF]]. AC-DURA-4: *completion-evidence* met, *phase-completion* NOT. See `BUG-REPORT-2026-06-24-codex-fieldproof-loa1363-run4-rsigf-corroboration-and-detached-phasegate.md`. | `BUG-REPORT-2026-06-23-green-build-reports-0-of-4-evidence-oracle-disagreement-and-failed-nonterminal.md` |
| R-SIGF + R-REIN | **R-SIGF / R-REIN — tickets-not-completing (LOA-1488 run 3, 2026-06-23).** Two NEW root causes behind hardening tickets never completing, distinct from R-PFNT's "oversized misclassification." **R-SIGF (scope-fence signature fan-out):** ticket 60 correctly added `StatementAnalyzerHealthService` as the 14th `LangGraphService` ctor injection, but sibling spec `appraisalEvaluation/buildAppraisalEvaluationGraph.spec.ts` instantiates it positionally (13 mocks) → `tsc` RED at 6 sites. That file is **outside the bundle's MODIFIED_FILES scope fence**, so NO fenced worker could fix it; build stayed RED → the data-flow + test-quality hardening tickets failed their typecheck gates indefinitely (presenting as `oversized_no_progress`, a misleading symptom). Fence must auto-extend to positional callers of a changed injected/exported signature (or readiness must flag signature-change-without-caller-co-scope). **R-REIN (recovery-exhausted inert on reset):** flipping a Failed ticket `status → Todo` + relaunch does NOT refund the per-ticket recovery counter → phase re-exits `exit_reason=recovery_exhausted` in ~2s with no re-attempt, so the documented "reset to Todo + relaunch" recovery is INERT once the ladder is spent. **Operator recovery (verified):** hand-fix the out-of-fence arity break (commit `ccad8c39e`), pin `scope_base` to the merge-base SHA to undo the moved-`main` phantom diff (see R-CECX Run-3 follow-up facet 3), then R-PFNT drop-pickle → review phases. | P1 | **✅ R-SIGF FULL SHIPPED v2.0.0-beta.29 (B-SIGF, 2026-06-29)** — scope-fence caller-gap detect-and-block + bounded opt-in auto-extension (default-OFF `scope.auto_extend_signature_callers`) + schema-shape consumers; the codex GA blocker is closed. R-REIN ✅ SHIPPED beta.23 (`3c48d7ae`)** — `refundRecoveryBudgetOnReset` refunds the per-ticket recovery ledger when frontmatter is reset to Todo, wired at the iteration loop top; the documented "reset to Todo + relaunch" recovery is no longer inert. **R-SIGF ⚠️ PARTIAL** — shipped the **advisory** `signature_change_caller_gap` readiness finding (`a668687f`, non-blocking, names orphaned positional callers); the **full scope-auto-extension** (fence auto-extends to callers of a changed injected/exported signature) is **DEFERRED** — the harder, higher-risk half. **⬆ 2nd INDEPENDENT REPRO — now load-bearing (LOA-1363 run 4, 2026-06-24):** a changed zod `thresholdSchema` *shape* (CRED_017/018/019) broke out-of-fence sibling specs (`e2e`/`summary-computer`/`credit-rule-fns`/`evaluator`); the data-flow audit ticket DEFERRED them verbatim ("no scoped CRITICAL/HIGH audit fix was warranted in the seven editable source files"); RED tree → `no_progress_timeout` storm → detached overrun → `0/2 phases`, citadel skipped. **Auto-extension MUST cover schema-shape consumers, not just signature/type callers. Promote toward P1.** See `BUG-REPORT-2026-06-24-codex-fieldproof-loa1363-run4-…`. | `BUG-REPORT-2026-06-22-codex-backend-completion-evidence-fatal-and-cross-iteration-work-corruption.md` |
| R-CECX | **R-CECX** codex-backend `done_without_commit_evidence` fatal + cross-iteration work corruption (multi-ticket) — **B-PCOMP recurrence on the unproven codex + multi-ticket path** (exactly the R-CECB residual: "GA soak still needs ≥1 LIVE multi-ticket run"). Codex workers committed NOTHING (`git log main..HEAD` empty) → WS-D2 finish gate has nothing to reconcile → 0/4 phases (no salvage-loop — the committed-but-unattributed path B-PCOMP fixed never triggers because there is no commit at all). Worse: a ticket flipped **Done with its code absent** and a later context-cleared ticket rewrote shared registry files from the stale base (floor → 18 while only 17 rules exist → module throws at import). | P2 | **✅ CODE-FIXED in B-DURA / beta.23 — pending codex field-proof.** The durable-boundary commit (T10 `e1472c37`) makes "committed-nothing" impossible (runner authors the commit) and makes cross-iteration clobber structurally impossible (next worker starts from a committed tree); Done-flip gated on a durable commit (T20). **✅ codex-PROVEN HELD (LOA-1363 run 4, 2026-06-24, beta.24):** committed-nothing did NOT recur — 86 branch commits / 34 ticket-attributed, every one of 14 tickets has a durable `completion_commit`; no cross-iteration clobber; no `done_without_commit_evidence` fatal. The R-CECX completion-evidence class **closes on codex** (the durable-boundary committer works on the unproven path). | `BUG-REPORT-2026-06-22-codex-backend-completion-evidence-fatal-and-cross-iteration-work-corruption.md` |
| R-DPGT | **R-DPGT (NEW — LOA-1363 run 4, 2026-06-24)** detached-ticket phase-gate non-terminal timing. The pickle phase exits `code 3` / reports `0/N phases` when its "unfinished" set is entirely **detached + actively advancing** large-tier tickets (`recovery: … advanced detached 54d89f21 before terminal disposition — continuing`, ~1.3s loop) at the iteration/detached-poll cap — which fired at **iter 149/500, NOT the session budget**. The 3 "unfinished" tickets' durable commits landed **4–10 min AFTER** the `0/2 phases` declaration (16:13–16:19Z vs 16:09:43Z) → citadel silently skipped over a build that actually completed **14/14**. Distinct from the shipped facet-3 empty-window fix (`f788aa43`), which makes `Failed` terminal-for-advance but does NOT cover detached-in-flight-at-cap. Machinery: B-WPEX-AUTO large-tier detached lifecycle (`largeTierDetachedEnabled` / `state.detached_worker` / `PICKLE_EXIT_DRAIN_FALLBACK_MS`). | P2 | **✅ SHIPPED v2.0.0-beta.25 (B-PXBO WS-1, 2026-06-28).** Fix direction (reuse-first, subtract-before-add): before exiting `0/N` on "unfinished," if the set is entirely detached+advancing, grant a bounded grace-drain keyed to the existing detached poll; OR treat a detached ticket that subsequently acquires a durable `completion_commit` as retroactively terminal-for-advance (reuse the SAME single `readEvidence` oracle that already gates the Done-flip — no new oracle). No new machinery; extend the existing detached lifecycle + evidence oracle. **⬆ 2nd INDEPENDENT REPRO (LOA-1588 CRED_017, 2026-06-24, beta.24) — SAME detached-overrun mechanism:** `0/4 phases`, anatomy-park+szechuan skipped. Runner declared `3/9 tickets remain pending … 0/4 phases` at **22:37:50Z**; the 3 trailing **large-tier** hardening tickets were detached workers still in-flight, which committed **green** work **7–12 min AFTER** the declaration (`4a8bb626` @22:44:50Z, `f5c58f4b` @22:50:03Z — a 648+/497− refactor) and flipped to `Done`. **HEAD `tsc --noEmit` exit 0** → R-DOTR did NOT recur. (The momentary `Failed` at the cap was transient, not terminal — an earlier same-day mis-file calling this the "T40 Failed-non-terminal" variant was wrong and is retracted.) **NEW adjacent finding:** the no-op audit ticket `ca933c63` flipped `Done` with `completion_commit c253c6c6` — which is **`89c654f7`'s** e2e commit, a *foreign* hash → evidence-oracle should reject another ticket's commit as a no-op ticket's evidence. Also: `recovery_attempts` ×3 route through "no_work_produced → oversized_no_progress Failed-flip" while frontmatter records `no_progress_timeout` (label seam). | `BUG-REPORT-2026-06-24-codex-loa1588-rdpgt-detached-overrun-2nd-repro.md` · `BUG-REPORT-2026-06-24-codex-fieldproof-loa1363-run4-rsigf-corroboration-and-detached-phasegate.md` |
| R-DOTR | **R-DOTR (NEW — LOA-1363 run 4, 2026-06-24)** Done-flip over committed-RED work on the `no_progress_timeout` path — **the inverse of the R-CECX fix.** Ticket 100 (`54d89f21`) is `Done` with `completion_commit 8bc4e4fa4` + `failed_reason: no_progress_timeout`, but that commit's own file does **not compile**: `test/credit-rules-loa-1363.e2e-spec.ts(415,5) TS1136` (missing object-literal brace in the `auShortfall` `makeFacts({…})`). Tree clean → the red is **committed at HEAD**, inside the recorded completion_commit. Mechanism: B-DURA's durable-boundary committer (`e1472c37`) commits the worker's **partial output** when its budget expires; the Done-flip keys on **durability** (B-PCOMP: "no diff" → catches code-*absent*) but **NOT** on **green** — and B-RPGT's hard `tsc` gate is **review-phase only**, with NO per-ticket tsc gate in the pickle build loop. So the R-CECX fix (committed-*nothing* impossible) opened committed-*something-broken*. Confirmed for 1 ticket; structural for all `no_progress_timeout` salvage-commits (tsc fails fast at the first error so the other 6 can't be individually assessed). Distinct from [[R-DPGT]] (phase mis-report) and [[R-SIGF]] (this break is IN-fence). | P2 | **✅ SHIPPED v2.0.0-beta.25 (B-PXBO WS-2, 2026-06-28).** Fix (reuse-first, subtract-before-add): gate the Done-flip on the toolchain signal the per-ticket loop already computes (toolchain-fail-fast `7b69f22a`) — if a salvage/timeout commit leaves `tsc` RED on the ticket's own declared files, disposition is `Failed`/retry, NOT `Done`. No new gate; reuse the existing tsc result. Closes the gap R-CECX opened. | `BUG-REPORT-2026-06-24-codex-fieldproof-loa1363-run4-rsigf-corroboration-and-detached-phasegate.md` |
| R-CRSR | **R-CRSR (NEW — 2026-06-25, claude, LOA standalone-loanless full pipeline)** crash-resume relaunch restarts from phase 1 + re-opens Done tickets. The tmux **server** died mid-PHASE-3 (anatomy-park) — external (sleep/OOM), NOT a pipeline bug — but the **relaunch corrupted a fully-complete build**. `pipeline-status.json` recorded `completed_phases:2, current_phase:"anatomy-park"`, yet relaunching `launch.sh` **restarted at PHASE 1/4** and **reset that file to `completed_phases:0`** (Facet A: the phase ledger is write-only telemetry, not a resume oracle). On the pickle re-entry the runner re-selected an **already-`Done` large-tier ticket** (`84636f7e`) via the `execute-converged-plan` detached/recovery path; its per-ticket budget was stale-exhausted (`60/60, tier=large`) so it gave up in **17s / 61 iters with zero work**, flipping `84636f7e` `Done→Failed` + `2a0e630a` `Done→Todo` and declaring **`0/4 phases`** (Facet B: Done-w/-durable-commit tickets must be skipped *before* budget accounting; per-ticket budget must reset on a new process). Code intact (16 commits, all 14 tickets committed); only ticket-status + pipeline-status files corrupted. Distinct from [[R-REIN]] (refund on *manual* `→Todo` reset only) and [[R-DPGT]] (detached overrun during a *first* run). | P2 | **✅ SHIPPED v2.0.0-beta.25 (B-PXBO WS-3, 2026-06-28).** Fix (reuse-first): (A) on launch, if `pipeline-status.json` shows `status:"running"` + `completed_phases>0` for this session, **resume at `current_phase`** (don't reset the counter, don't re-run completed phases). (B) skip tickets already `Done` with a durable `completion_commit` (reuse the existing `readEvidence` oracle) *before* per-ticket budget accounting on (re)entry, AND reset the per-ticket budget on a fresh process start. Operator recovery (verified): kill the relaunched session, repair the 2 statuses → `Done`, finish phases 3–4 via standalone `/anatomy-park` + `/szechuan-sauce` (NOT a full-pipeline relaunch). | `BUG-REPORT-2026-06-25-crash-resume-relaunch-restarts-from-phase1-and-reopens-done-tickets.md` |
| R-SLEAK | **R-SLEAK** (+ R-PSRB/R-OMTD/R-WSDO context) — session/process leak + contention-gauge | P3 | **PARTIAL — R-OMTD ✅ + R-WSDO ✅ SHIPPED beta.22; R-PSRB documented; R-SLEAK OPEN.** **R-OMTD (`b20a4c1a`):** pipeline-runner spawns mux children `detached` + reaps the subtree via `reapChildSubtree`/negative-PID on teardown (no more PPID-1 orphans). **R-WSDO (`177b84a7`):** `worker_produced_nothing` breadcrumb shipped. **R-PSRB (design, documented — not a code fix):** recovery-machinery bundles can't self-build (deployed pre-fix runtime salvage-resets the ticket building the fix); build protocol = hand-build recovery-path tickets then install.sh-deploy. **R-SLEAK (OPEN, P3 hygiene):** leaked tmux sessions + orphan runners persist for days; `pgrep -f claude` over-counts (matches node runners + own shell) → real worker-contention gauge is `ps -eo command \| grep -E '/claude '`. Session-GC unbuilt. | `BUG-REPORT-2026-06-21-pipeline-self-referential-build-catch22-and-orphan-mux.md` |
| R-MVFM | **R-MVFM (NEW — 2026-06-28, claude; surfaced while evaluating Arbor/HTR for the microverse loop)** microverse failure-memory records only **regressions**, never **plateaus** → the `## Failed Approaches (DO NOT RETRY)` denylist is **dead on the dominant stall**. `recordFailedApproach` fires from exactly one trigger — `if (classification === 'regressed')` (`microverse-runner.ts:3408`); a `held` iteration (worker changed code, metric didn't move) is never recorded, so the next worker gets an empty denylist (`appendFailedApproachesHandoff`, `:2566`) and can re-propose the same ineffective move. **Live ground truth:** all 4 microverse runs with real iterations show `failed_approaches:0` despite `held×5` plateaus (27298c24 7→4 held×5; b6b75d07 17→13 held×5) — the loop already logs `no_progress` into `failure_history` but never routes it into `failed_approaches`, the one field the worker reads. This is the **subtractive alternative to importing Arbor/HTR**: ~90% of HTR's relevant benefit for our loop is recovered by re-pointing the existing trigger; HTR's genuine residual (branching/competing live hypotheses) is DEFERRED. Caveat: all 4 runs are the same szechuan principle-violation metric (defect is code-universal, plateau shape for numeric metrics unobserved). Secondary note-only: `target:0` on an LLM-judged count is ~unreachable (don't fold target-realism in). | P3 | **OPEN — small, subtractive, single ticket; standard build (NOT recovery-path, R-PSRB does not apply).** Route `held`/`no_progress` into `failed_approaches` with a specific description + dedupe guard (bound prompt growth on long plateaus). Reuse existing `recordFailedApproach`/`failed_approaches`/`appendFailedApproachesHandoff` — no new field, no schema bump, no tree. Deferred behind the reliability queue (R-WPEX↻ P2, R-SIGF). | `BUG-REPORT-2026-06-28-microverse-failure-memory-records-regressions-not-plateaus.md` |
| 124 | **R-DPMC-3** decomposition-satisfiability residual | P2 | **DEFERRED** — large additive machinery; needs operator sign-off (R-DPMC-1/-2 already shipped: B-DECOMP-SAT beta.17 / B-GROUND2 beta.16). | `archive/bundles/p2-bug-fix-bundle-b-decomp-sat-decomposition-satisfiability-2026-06-18.md` |
| 125 | **B-GSUB** functional seam-collapse | P2 | **DEFERRED** — the next-week GA soak ranks which seam to collapse first; pure-doc track already closed (−9). | `archive/bundles/p2-simplification-pass-guard-inventory-subtraction-2026-06-18.md` |
| 119 | **B-CIINT** integration-tier CI-env e2e failures | P3 | **OPEN** — Linux-CI-only subprocess-e2e flakiness; CI hygiene, **not a release gate**. Pass locally (macOS). | `archive/bundles/p3-bug-fix-bundle-b-ciint-integration-tier-ci-env-e2e.md` |
| — | **B-CGCAP** codegraph default-on (v2.1) | P2 | **DEFERRED post-GA** (reliability-first / capability-second). | `p2-codegraph-default-on-capability-v2.1.md` *(pinned)* |
| — | **B-GIMA** guard-inventory & finding-shape mining audit (v2.2) | P2 | **DEFERRED post-reliability + post-codegraph.** Sole survivor of the slop-gate comparative review: an inert, report-only tool that operationalizes subtract-before-add (DELETE never-fired-guards / JUDGE-CALIBRATION conf<80 drops / ADD sort-hints). REUSES codegraph (v2.1) as code-liveness substrate — design dependency, not calendar. Kill-criteria baked in: report-only or dead. Evidence-gating insight from the same review → release-2 R-CWGE/R-DOTR, NOT here. | `p2-guard-inventory-mining-audit-v2.2.md` |
| 13 | **B-DWF-2** retire legacy refinement subprocess | P3 | **⏸️ SHELVED** — soak-harness prereq unmet; legacy path retained for zero regression. | `archive/bundles/p3-bug-fix-bundle-b-dwf2-retire-refinement-subprocess.md` |
| 25 | **R-CSI** concurrent-session destructive-command interference (DATA-LOSS class) | P1 | **EXTERNAL-GATED** — re-activates on the next real concurrent-session incident to analyze. | `archive/bug-reports/p1-concurrent-claude-session-interference-with-running-pipelines.md` |

> **Recently shipped + swept to `archive/`:** **R-SIGF / B-SIGF (beta.29, 2026-06-29)** — scope-fence
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
