---
title: "B-GTRUTH — ground truth over proxy signals + codegraph enablement (v2.1)"
priority: P1
finding: B-GTRUTH
composes: []   # was [B-CGEN, R-AICF, R-WGFR] — all shipped/inline; see AUTHOR'S RETRACTION §0
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
self_modifying_recovery: true   # WS-A1 edits ticket-completion-evidence.ts (R-PSRB completion path) — pipelined + attended per B-RASO precedent, NOT hand-built
source_assessment: "Operator direction 2026-07-23 plus the empirical failure record measured the same day. Combined with B-CGEN (operator-set headline feature) into ONE PRD; Track C soak DEFERRED to a post-deploy follow-on per operator decision 2026-07-24 (see §Scope after refinement)."
---

# B-GTRUTH — a proxy signal may never outrank recoverable ground truth

*(refined 2026-07-24 from the 3-analyst refinement team; original preserved at `prd.md`. Every WS below carries corrected edit sites — the hand-authored PRD's premises were re-derived against the shipped runtime and several were wrong. See §0.)*

## §0 — AUTHOR'S RETRACTION (what refinement corrected)

All three analysts converged, across three cycles, on the following corrections. Each is grounded in the shipped code, not the ledger. The build set below is derived from the **corrected** premises.

| # | Hand-authored premise | Verdict | Correction (the build follows THIS) |
|---|---|---|---|
| R1 | WS-A1: "`ticket-completion-evidence.ts` is CONSUMED, not edited — keeps this bundle off the R-PSRB path." | **FALSE (type-level).** `CompletionDecision`'s success arm carries non-nullable `sha: string` (`ticket-completion-evidence.ts:715`); `guardCompletionCommitBeforeDone` (`mux-runner.ts:4754`) holds **zero policy** ("the ladder lives in `evaluateCompletionEvidence`"). A zero-diff ticket has no sha, so it is unrepresentable without editing the oracle. | **Strike the Non-Goal.** WS-A1 **widens** `evaluateCompletionEvidence` with a zero-diff arm (operator decision 2026-07-24: "widen the oracle, attended"). Bundle is `self_modifying_recovery: true` — pipelined + attended per [[feedback_never_hand_build_always_pipeline]] / B-RASO, interventions budgeted. NOT reclassified as hand-build. |
| R2 | WS-A2: "the defect is one line, `pipeline-runner.ts:2801`; narrow `isHaltExit`." | **Wrong sites.** `isHaltExit` (`mux-runner.ts:4398`) has exactly ONE consumer — the rate-limit park loop (`:10683`) — irrelevant to the phase halt. The decisive set is `FAILURE_EXIT_REASONS` (`:4404`). And `recordRecoverablePhaseFailure(...,'continue')` **graduates the phase** (`:4106-4113` falls through to `finalizePhaseSuccess`) → advances over unbuilt tickets = fake-green. | WS-A2 routes to the existing **`PhaseIncomplete` contract** (`reportPhaseIncomplete` + `{action:'break', phaseIncomplete:true}`, per `maybeStampPickleIncompleteRobust:4198`). Demote in lockstep across all three sets so the session doesn't render RED. |
| R3 | WS-A3: "`worker_gate_verdict: red` fired on pnpm absent from PATH." | **Two gates conflated.** The 10/10-red metric is `worker_gate_verdict` (worker gate: `npx eslint`/`npx tsc`/`npm run test:fast` — **no pnpm**). pnpm lives only in `convergence-gate.ts`. The pnpm probe would move **zero** of those 10 verdicts. | Split **A3a** (subtractive: finish R-WGFR — drop the flaky `test:fast` dimension from the *primary* `runWorkerGate`, matching the fallback at `mux-runner.ts:4656`; prefer wiring the existing `classifyUnrunnableCheck`/`isUnrunnableCheckResult` over a new PATH probe) + **A3b** (report-only measurement, acceptance = "the number is recorded"). |
| R4 | WS-B3: "drop the `.codegraph.*` clauses from MANAGED_KEYS." | **Inert on every upgrade.** `install.sh:509` merges source×deployed with **deployed winning per-key** (`:511-513`). Every existing install carries deployed `enabled:false`; dropping the clauses lets the stale `false` win → codegraph ships OFF on every upgrade, silently. | **Flip the managed value:** `jq 'del(.worker_test_gate_timeout_ms) \| .codegraph.enabled = true \| .codegraph.index_at_setup = true \| .auto_update_enabled = false'`, and update the two `!= "false"` warning blocks (`:536-541`) to report `-> true`. Preserves the source-authoritative property + keeps `install-script.test.js:767` checkable (`false -> true`). |
| R5 | WS-B3: "invert two guard tests." | **Undercounts.** ≥3 files, ~19 assertions, incl. `install-script.test.js` (never named), a must-NOT-invert MCP-lane subset, and one negative assertion where "invert" is undefined. Also a scope-fence deadlock if split. | **ONE `medium` ticket**, 7-file allowlist, per-assertion flip/survive table (WS-B3 below). |
| R6 | WS-B2: "call `sync()` at post-ticket-commit and phase transitions." | **Already ships** at `mux-runner.ts:10105`; `pipeline-runner.ts` holds **zero** `CodegraphService` refs (grep=0). Each phase spawns a fresh mux-runner child that runs its own setup index + per-iteration sync. | **DROP** (B-CGHARD precedent: already-satisfied WS are dropped, not built). |
| R7 | `composes: [B-CGEN, R-AICF, R-WGFR]` | **Stale.** R-WGFR shipped both lines (`ebb33a6c`/`cad28cb2`); R-AICF folded into B-1SEAM (shipped, premise corrected — flag deleted beta.23); B-CGEN is the inline Track B decision, not a PRD. Composing shipped work → zero-diff tickets that trip the very WS-A1 wedge. | `composes: []`. No ticket for R-AICF/R-WGFR. |
| R8 | Field-occurrence flags: `allow_inferred_completion_commit` + `pipeline_continue_on_phase_fail` "does not cover the build phase". | **Both wrong.** The first was deleted beta.23 (absent from `src/`). The second is a strict-only lever (`pipeline-runner.ts:2838`, reached only *after* `isFatalPhaseFailure` returns) — no phase-coverage dimension. Conclusions survive, mechanisms don't. | Both reframed as operator-habit notes. **No AC may cite either flag** (build-time reminder). |
| R9 | WS-B1: "delete the `!isResume` shortcut, let freshness govern." | **Replaces one proxy with another** — mtime is a proxy; the ground truth for "does this index describe this tree" is indexed-HEAD == current-HEAD. mtime can't detect a branch switch. | WS-B1 adds a **HEAD-sha equality check** as the freshness ground truth (mtime as cheap pre-filter) — coherent with this PRD's own thesis. |
| R10 | WS-C1 precondition 3: "confirm degradation." | `codegraph-degradation.test.js` **already exists** (17.8K, `enabled:true` fixture). | Reworded to verification; Track C **deferred** to post-deploy follow-on anyway (operator 2026-07-24). |

**Non-goal correction that SURVIVES:** the anti-fake-green guard AC-MWMO-D2-8 must survive — an *undeclared* zero-commit ordinary ticket still `refuseAbsent`s (WS-A1 AC-A1-2). Do not weaken the commit requirement for ordinary tickets.

---

## The measured failure record (2026-07-23, unchanged — the symptoms are real; only the mechanism attributions in §0/R8 were wrong)

| Measurement | Value |
|---|---|
| Tickets carrying a `worker_gate_verdict` | 22 (12 green / **10 red**) |
| Red-gate tickets that ended `Done` anyway | **10 / 10 — 100%** |
| Phase halts recorded | 2, both `done_without_commit_evidence`, both wrong |
| Field occurrence (loanlight-api codex, `2026-07-23-e89c5c77`) | 3rd `done_without_commit_evidence`, first on a real target repo — operator-attested; the *code* claim (ticket-scoped reason → phase-fatal classifier) is independently verified |

**A verdict overridden 100% of the time is not a gate.** B-WDSUB closed two instances (`tokenPresent`/`ANALYSIS_DONE`). This bundle closes the class, then ships codegraph on top of it. **Coverage-and-residual:** WS-A1 closes the zero-diff flavor; WS-A2 closes committed-but-unflipped + genuinely-in-flight; any 4th flavor STILL halts loudly by design (negative AC in the coupled ticket).

## Scope after refinement (operator 2026-07-24: auto-correct + launch, Track C deferred)

**Build + ship in THIS bundle:** Track A (WS-A1+A2 coupled, WS-A3a, WS-A3b) + Track B enablement (WS-B3, WS-B1). **Track A tickets ordered before Track B.**
**Deferred to a post-deploy follow-on PRD:** Track C soak (WS-C1) — it must run on the deployed repaired runtime; carry its precondition AC-GTRUTH-C1-0 forward. WS-B2 (already-satisfied), WS-B4 (numberless, baseline shifted).

---

# TRACK A — reliability (subtractive; self-modifying-recovery; ordered first)

## WS-A1 — make "complete, no diff" a representable outcome (widen the oracle)

**Write-site (mandatory, operator-chosen):** edit `services/ticket-completion-evidence.ts`, widening the ONE predicate (B-1SEAM WS-1) `evaluateCompletionEvidence` with a zero-diff arm + a ctx resolver alongside the existing `workerGateVerdict?` / `announcedSha?` fields (`:698-704`), for `decision === 'done-flip'` (the only decision kind that consults the R-CWGE verdict, `:820-836`). `guardCompletionCommitBeforeDone` stays policy-free (ctx wiring + shape mapping only). Name the existing `clearStaleDoneWithoutCommitEvidence` clear-path (`mux-runner.ts:2896/4493/7356/10493/11085`) so no redundant clear is added.

| AC | Assertion |
|---|---|
| AC-GTRUTH-A1-1 | A ticket declaring `zero_diff_intent ∈ {verification, audit, already-satisfied}`, with lifecycle artifacts present and `worker_gate_verdict === green` (eslint+tsc per R-WGFR — **never** test:fast), yields `evaluateCompletionEvidence(...).ok === true` with **no sha** (new arm), for `decision === 'done-flip'`. |
| AC-GTRUTH-A1-2 | A ticket **without** the declaration and with no sha still `refuseAbsent`s — **AC-MWMO-D2-8 survives**. |
| AC-GTRUTH-A1-3 | **No sentinel sha.** `grep -n "sha: '"` over the branch diff yields only the pre-existing `pickle-test-mode-bypass` (`mux-runner.ts:4772`). Fabricating a sentinel is the marker-commit forgery moved into a string — forbidden. |
| AC-GTRUTH-A1-4 | No empty-marker commit on any zero-diff path (grep the branch diff for empty-tree commits). |
| AC-GTRUTH-A1-5 | Policy remains single-seam: `guardCompletionCommitBeforeDone`'s diff adds **no** decision logic. |

## WS-A2 — route `done_without_commit_evidence` to the existing PhaseIncomplete contract

Route into the `PhaseIncomplete` contract (`reportPhaseIncomplete(runtime, rawPhase)` + `{action:'break', phaseIncomplete:true}`, per `maybeStampPickleIncompleteRobust:4198`), NOT `recordRecoverablePhaseFailure(...,'continue')`. Its `resolveUnfinishedTickets` oracle exclusion (`:3483` via `isTicketOracleCommitted`) — now consulting WS-A1's widened oracle — distinguishes committed-but-unflipped from genuinely-unfinished with no new predicate. Demote in lockstep across `isHaltExit`(`4398`)/`FAILURE_EXIT_REASONS`(`4404`)/`isFatalPhaseFailure`(`2801`) so the session does not render RED.

| AC | Assertion |
|---|---|
| AC-GTRUTH-A2-1 | done-on-disk-unflipped (self-build shape): N-1 terminal + Nth committed-but-unflipped → `statusUnfinished>0 && unfinished.length===0` → NO `pipeline_phase_incomplete` stamp, pickle graduates, pipeline advances. |
| AC-GTRUTH-A2-2 | genuinely-incomplete-in-flight (loanlight shape: 14 tickets / 7 committed / R9 In Progress, clean tree — others NOT all terminal) → pipeline does NOT advance to anatomy-park; `exit_reason=pipeline_phase_incomplete`; unfinished roster logged; **every non-terminal ticket's frontmatter status UNCHANGED** (stays runnable — no flip to Failed/Skipped). |
| AC-GTRUTH-A2-3 | `isHaltExit` returns true for EXACTLY `{cancelled, limit, timeout_repeat, closer_handoff_terminal, manager_handoff_pending}` and false for `done_without_commit_evidence`. `state_schema_version_ahead` is NOT a member (do not add). |
| AC-GTRUTH-A2-4 | Lockstep demotion: `isHaltExit`, `isFailureExit` (`FAILURE_EXIT_REASONS`), `isFatalPhaseFailure` agree; `deriveCompletionVerdict('done_without_commit_evidence').colorName !== 'RED'` on the recovered path. |
| AC-GTRUTH-A2-5 | `isFatalPhaseFailure`'s `!startCommit` guard (`:2803`) still returns true — untouched. `getFatalPickleHaltReason` (`:3868`) + `getRecoverablePhaseFailureReason` (`:2844`) untouched (telemetry-only). |
| AC-GTRUTH-A2-6 | `pipeline_continue_on_phase_fail` is NOT modified (tightening-only switch, `:2838`). |
| AC-GTRUTH-A2-7 | Synthetic 4th-flavor case (neither zero-diff-declared nor committed-but-unflipped) still returns **fatal** — "closes the class" is bounded, not universal. |

### WS-A1+A2 are ONE coupled `large` ticket. Track-A red-test table (INVERT, do not delete):

| Test file | Currently asserts | Post-fix expected | Action |
|---|---|---|---|
| `pipeline-runner-done-without-commit-evidence-fatal.test.js` | `:214` fatal regardless of countCommitsSince; `:195` pipeline-status==failed | non-fatal on declared/all-terminal path; UNDECLARED zero-commit still fatal | **INVERT** |
| `mux-runner-done-without-commit-evidence-exit.test.js` | ticket-scoped exit mapping | demoted mapping | **INVERT** |
| `pipeline-runner-done-without-commit-evidence-reason-report.test.js` | halt-reason report string | recovery-path report | **RECONCILE** |
| `completion-decision-3way-parity.test.js` | 3-way oracle parity | parity preserved under demotion | **MUST STAY GREEN** |
| `characterization/completion-commit-cluster/path-5-*.test.js` | direct guard calls | unchanged | **MUST STAY GREEN — release-gate invariant; needs an R-AFCC-DEEP-CONSOLIDATED exception record to touch** |
| `pipeline-runner-phase-fail-continue.test.js` (cases 1,3,7) | R-PHC-6 continue-by-default | still green (same-direction) | **CO-SCOPE, verify** |

## WS-A3a — finish the R-WGFR subtraction (subtractive)

Drop the flaky `test:fast` dimension from the **primary** `runWorkerGate` that writes the persisted `worker_gate_verdict`, matching the fallback recompute (`mux-runner.ts:4656`) that R-WGFR already subtracted. Prefer wiring the existing `classifyUnrunnableCheck`/`isUnrunnableCheckResult` (`convergence-gate.ts:727-746`, exported with zero external consumers) over adding a session-start PATH probe. Do NOT touch `runWorkerGate:1673` (off-repo fake-green — out of scope).

## WS-A3b — report-only measurement (acceptance = the number is recorded)

Compute the worker-gate true-positive rate from a **checked-in fixture** (not the mutable sessions dir), with a pre-declared repair-vs-retire threshold, reported regardless of sign. Un-gateable on outcome by construction — acceptance is that the number is recorded and the threshold stated. (Candidate zero-diff ticket per WS-A1.)

---

# TRACK B — codegraph enablement (additive by operator decision; ordered after Track A)

## WS-B3 — the enablement (ONE `medium` ticket)

Allowlist (+ compiled mirrors): `install.sh`, `pickle_settings.json`, `CLAUDE.md`, `README.md`, `extension/tests/codegraph-default-optin.test.js`, `extension/tests/codegraph-docs-optin-parity.test.js`, `extension/tests/install-script.test.js`.

| AC | Assertion |
|---|---|
| AC-GTRUTH-B3-1 | Deploy over a pre-existing deployed settings containing `codegraph.enabled=false` → post-install **DEPLOYED** `codegraph.enabled===true && index_at_setup===true` (**upgrade path**, not just fresh install). |
| AC-GTRUTH-B3-2 | Sibling tunables survive: deployed `staleness_max_age_minutes===15`, all `*_timeout_ms` unchanged (AC-SSAT-3/6), `expose_mcp_to_workers===false`. |
| AC-GTRUTH-B3-3 | install.sh stderr prints `MANAGED_KEYS forced codegraph.enabled: false -> true` (both `!= "false"` warning blocks + install-script.test.js:767 updated, not deleted). |
| AC-GTRUTH-B3-4 | Enumerated flip/survive: `codegraph-default-optin` (2 flip / 1 survive incl. all 6 sibling tunables + expose_mcp_to_workers false); `codegraph-docs-optin-parity` (3 flip / 2 MCP-lane survive: `/injected-context lane/`, `/dormant by default/`, `/gated OFF unless .expose_mcp_to_workers === true./`). Do NOT assert `Default-ON since B-CGH` (enabled on the 2.1 line, not since B-CGH). No test file deleted. |
| AC-GTRUTH-B3-5 | CLAUDE.md codegraph row + README lane text match NEW exact strings; docs-parity regexes updated in the same commit. Retire Tune-Back CUJ #2. Keep `PICKLE_CODEGRAPH=off`. |
| AC-GTRUTH-C1-0 | *(carried to the Track C follow-on)* Soak precondition: deployed `codegraph.enabled===true` AND `codegraph_context_injected > 0` before any efficacy number is recorded; a zero-injection run is `feature_not_enabled`, never an efficacy result. |

*Note in the ticket:* `install-*` tests fail in the MAIN REPO and pass in a worktree at **every** commit ([[project_install_tests_fail_in_main_repo_pass_in_worktree]]) — do not misread a pre-existing failure as a regression; tier `medium` (not small: skips test:fast; not large: red-main resetToSha wipes doc edits).

## WS-B1 — freshness by ground truth, not mtime

`cgResolveIndexAction` (`bin/setup.ts:173-185`) currently returns before service creation on `'noop'` (`:217`), and deleting the `!isResume` shortcut would make **mtime** the sole arbiter — a proxy that can't detect a branch switch. Add an **indexed-HEAD == current-HEAD** equality check as the freshness ground truth (mtime as cheap pre-filter); requires HEAD-sha tracking in `codegraph-service.ts` (none exists today). Cold repo / sha-mismatch → `full`; sha-match + fresh mtime → `noop`; sha-match + stale → `sync`.

---

## Non-Goals (with negative-assertion ACs)

- `persistWorkerOutcomeStatus` (`spawn-morty.ts:1996`) NOT edited — diff empty.
- `src/lib/salvage-ticket.ts` NOT edited — diff empty. `reconcile-ticket-truth.ts` NOT edited — diff empty. (WS-A1 lands in `ticket-completion-evidence.ts`, NOT these.)
- `runWorkerGate:1673` off-repo fake-green NOT fixed here.
- `expose_mcp_to_workers` stays `false` — separate C0-gated flip.
- No AC cites `allow_inferred_completion_commit` or `pipeline_continue_on_phase_fail` (R8).

## Simplification Review (subtract-before-add)

1. **Track A adds no mechanism it can avoid.** WS-A1 widens ONE existing predicate (not a new one) + deletes the marker-commit ritual; WS-A2 reuses the existing `PhaseIncomplete` contract (deletes a bespoke continue-branch) and shrinks the halt sets; WS-A3a is a pure dimension **subtraction** (finish R-WGFR). Track B is additive by declared operator decision; WS-B3's install.sh change is a value-flip (not new machinery), WS-B1 adds sha-tracking (minimal, thesis-coherent).
2. **REUSE:** WS-A1 widens `evaluateCompletionEvidence`; WS-A2 reuses `reportPhaseIncomplete`/`resolveUnfinishedTickets`; WS-A3a wires existing `classifyUnrunnableCheck`; WS-B3 reuses the MANAGED_KEYS block; Track C reuses 3 existing probes.
3. **Brittle thing subtracted:** the proxy-over-ground-truth family — a commit count and an ambient test dimension each outranking evidence on disk. Removes the proxy's authority, does not wrap it.
4. **Net shape:** Track A net-negative except WS-A1's one widened arm. WS-B2/B4 dropped as already-satisfied. Track C deferred. **Do not delete a guard that fires correctly** — AC-MWMO-D2-8 survives (AC-A1-2); WS-A3b reports its number even if it argues for keeping the gate.

## Risks

- **Track A's fixes do not protect this bundle's own run** (deployed JS executes; source lands at `install.sh`). Expect the same `done_without_commit_evidence`/zero-diff wedges — recover with: verify ground truth → flip → clear `exit_reason` → relaunch. Attended.
- **Bundle size** ~10 tickets (≥ B-WDSUB's 6, which needed 2 interventions). Track C deferred to hold the line.
- **WS-A1 over-subtraction** — declaration must be explicit; artifacts + non-failing gate still required (AC-A1-2).
- **WS-A2 under-halting** — phase-level reasons stay fatal; only ticket-scoped demoted; rerouted ticket never flipped.
- **Codegraph on-by-default makes the native dep load-bearing** on every platform (degradation oracle already covers it).

## Build-time reminders

- Branch `release/v2.1-beta`. Baseline = the beta.5 release commit.
- **Compiled-mirror co-scoping MANDATORY** — `install.sh:389` rsyncs `--exclude='src'`, so `extension/bin/*.js` IS the deployed runtime. Every ticket allowlist names both `src/` and the compiled mirror.
- Re-anchor on **symbols**, not line numbers (drift present): `isHaltExit` (`4398`), `FAILURE_EXIT_REASONS` (`4404`), `shouldHaltAfterPhase`, `isFatalPhaseFailure`, `evaluateCompletionEvidence` (`838`), `CompletionDecision` (`715`), `cgResolveIndexAction` (`173-185`), `targetToolchainMissing`.
- Track A tickets ordered before Track B. WS-C1 is a post-deploy follow-on — NOT in this build.
- Launch `--szechuan-max-iterations 500 --anatomy-max-iterations 500`.

## Implementation Task Breakdown

| Order | ID | Title | Priority | Tier | Entry | Exit |
|---|---|---|---|---|---|---|
| 10 | a7e9b33b | Zero-diff completion + reroute to PhaseIncomplete (WS-A1+A2 coupled) | High | large | green tree @beta.5 | zero-diff representable; reroute live; class closed |
| 20 | 003aca59 | Finish R-WGFR: drop flaky test:fast from primary worker gate (WS-A3a) | High | medium | a7e9b33b done | gate measures code not environment |
| 30 | 0b3202e0 | Record worker-gate TP-rate (WS-A3b, report-only) | Medium | small | a7e9b33b+003aca59 | number recorded from fixture |
| 40 | 1754b642 | Enable codegraph via managed-value flip (WS-B3) | High | medium | Track A done | codegraph ON fresh+upgrade; guards enforce |
| 50 | 28fb378e | Freshness by HEAD-sha ground truth (WS-B1) | Medium | medium | 1754b642 done | stale-branch index never noop |
| 60 | 08e2c7a2 | Wire + verify coupled behaviors end-to-end | High | medium | all impl done | fast+integration green, seams live |
| 70 | 5121a116 | Harden: code quality | High | large | wiring done | zero P0-P1 in diff |
| 80 | 26ac413e | Audit: data flow integrity | High | large | 5121a116 done | zero CRITICAL+HIGH |
| 90 | 265e89b5 | Harden: test quality | High | large | 26ac413e done | every AC mapped; zero P0-P1 gaps |
| 100 | 6521404c | Audit: cross-reference consistency | High | medium | 265e89b5 done | docs match reality |

**Deferred (post-deploy follow-on PRD):** WS-C1 codegraph efficacy soak (precondition AC-GTRUTH-C1-0 carried forward), WS-B2 (already ships), WS-B4 (baseline shifted).
