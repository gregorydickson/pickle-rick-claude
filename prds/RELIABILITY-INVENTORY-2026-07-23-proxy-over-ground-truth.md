# Reliability Inventory — Proxy-over-Ground-Truth Terminalization Surface

**Date:** 2026-07-23
**Trigger:** Incident #6 (`done_without_commit_evidence` halted a real target-repo codex pipeline — loanlight-api, session `2026-07-23-e89c5c77`, after 6 clean commits).
**Method:** Six parallel read-only auditors, one per subsystem, each testing ONE invariant:

> **Git working-tree state is the SOLE authority on whether a ticket's work is complete. Every other signal — WORKER_DONE/promise token, worker exit code, stdout, log size, gate color, no-progress counter, timeout, symbol audit — is ADVISORY. A proxy may route work to RECOVERY, but must NEVER terminalize (set `exit_reason` / force terminal / mark Failed), reset/discard work, or flip status Done↔Failed WITHOUT consulting git. When a proxy disagrees with git, git wins.**

---

## Headline

The system is **already ~85% git-authoritative.** The proxy-over-git *destruction* surface is **not 94 sites — it is ~7 concrete sites**, of which today's incident is **2 lines in 2 files, both pure deletions/fall-throughs.** There are **zero work-discarding `git reset`/`resetToSha` sites in the mux-runner runtime** (grep-confirmed); every destructive-looking path archives first (`archiveBeforeDestructive` / `stashUnattributableRemainder` → `refs/pickle/salvage/<session>`).

**The 94 recovery recipes are the symptom of this handful of leaks — each historically patched with a *new proxy* instead of closing the leak.** That is why it felt infinite: we kept adding smoke detectors instead of closing the 7 gas leaks.

---

## Per-cluster verdict

| Cluster | Files | Verdict |
|---|---|---|
| **Gates** | convergence-gate, tsc-gate, circuit-breaker, finalize-gate, check-readiness | **CLEAN by construction.** None can flip status/reset/terminalize. They emit signals, block a *commit*, or route to recovery. `tsc-gate` and `circuit-breaker` are reference implementations. |
| **State primitives** | state-manager, transaction-ticket-ops, types/index | **Neutral choke-points = the enforcement seam.** All `state.json` writes funnel through `update`/`transaction`/`forceWrite`; all ticket-status flips through `updateTicketStatusInTransaction`. They carry zero git consultation — faithfully persist caller's proxy. `finalizeIfTrulyComplete` is the ONE compliant primitive (git-gated); its un-gated twin `finalizeTerminalState` sits beside it. |
| **Reconciliation/salvage** | salvage-ticket, dirty-tree-salvage, recovery-controller, reconcile-ticket-truth, divergence-reconciliation, **ticket-completion-evidence** | Mostly **COMPLIANT** — `salvage-ticket` is the model (reconcile→archive-before-reset→ff-reattach). Violations concentrate in `ticket-completion-evidence.ts`. |
| **Worker-spawn** | spawn-morty, backend-spawn, promise-tokens | `reconcileWorkerCommitAttribution` is the invariant done right. One live violation class: the timeout/no-artifact Failed-flip nulls committed work without a git probe. |
| **Pipeline/microverse** | pipeline-runner, microverse-runner, microverse-state | Microverse rollback is **COMPLIANT** (git-ancestry guarded). One live violation: `pipeline-runner.ts:2801`. |
| **mux-runner (consumer)** | mux-runner (11.4k L) | **No work-discard sites.** Heavily git-authoritative via `evaluateFailedFlipSuppression` + `evaluateCompletionEvidence` (B-1SEAM). One genuine gap: `executeBoundedEscape`. |

---

## The violation set (the entire subtraction campaign)

### Tier 1 — today's incident. 2 lines, pure subtraction. Ships now.

- **A. `pipeline-runner.ts:2801`** — `if (exit_reason === 'done_without_commit_evidence') return true;` fires the chain-fatal halt **before** the git commit-count check at line 2804 ever runs. 6 commits present in git; code never looks. **Fix: delete line 2801, let 2804 (`countCommitsSince > 0`) decide.** The fake-green concern that line guards belongs in the *graduation* check, not the chain-fatal gate. Note: `pipeline_continue_on_phase_fail:true` is read only at 2836, *after* the fatal gate at 2833 — structurally cannot cover this.
- **B. `ticket-completion-evidence.ts:603`** — when `completion_commit_inferred` is stale/unreachable, `readEvidence` returns `absent` and **skips the git-log scan.** Real committed, scannable work → declared not-done → the `done_without_commit_evidence` halt (and false phantom-Done reverts). **Fix: mirror R-AICF (line 584) — fall through to the scan instead of `return absent()`.** Strictly more git evidence; no legitimate flow breaks.

### Tier 2 — the recurring R-WDTF class. Reuse an existing guard.

- **C. `spawn-morty.ts:2468`** (`evaluateWorkerOutcome`) — git signal (`hasEdits`) is AND-gated behind `!timedOut && hasArtifact`. A worker that committed gate-green work then blew wall-clock (often *during* the `test:fast` gate) → `isSuccess=false` → `persistWorkerOutcomeStatus` (1996) writes `status:'Failed', completion_commit:null`, erasing the SHA with zero git probe. `hangGuard` (2544) is a second blinder copy. **Fix: route the timeout/no-artifact Failed-flip through the existing `evaluateFailedFlipSuppression` git check** (already wired into the gate-fail branch only). No new machinery.

### Tier 3 — invariant conflicts needing a design decision (route-to-remediation vs terminal)

- **D. `ticket-completion-evidence.ts:820-836`** — worker-gate fail-closed: a red lint/tsc/test proxy refuses the Done-flip even when git shows a reachable, attributable commit, and does so as a **terminal halt.** Load-bearing (R-CWGE: don't ship broken code as Done), so the honest fix is **route-to-remediation** (the recovery ladder's `fix-forward-trivial` already exists), not a terminal halt and not letting Done proceed.
- **E. `ticket-completion-evidence.ts:573`** — foreign-attribution reject: commit-*message* text overrides a git-reachable commit. Bounded by R-OMASD but a genuine false-refusal surface for a ticket whose own commit names a sibling.
- **F. `mux-runner.ts:6109`** (`executeBoundedEscape`) — the single site that *terminalizes* (`markTicketSkipped`) on a pure non-git proxy (the `recovery_attempts` no-progress ledger), with `salvageTicket` deps hardcoded to `gate:()=>'failing'` (6120) so it never asks whether the In-Progress ticket has committable/committed work. Load-bearing (anti-infinite-loop) and non-destructive (archives + reversible Skipped). **Fix: gate `markTicketSkipped` on `evaluateCompletionEvidence` first** — Done a clean-tree-with-commit ticket instead of Skipping it.
- **G. Fail-OPEN branches** — `evaluateFailedFlipSuppression` (mux-runner.ts:8423) proceeds-to-flip on git-probe error (proxy wins when git unavailable); `reconcile-ticket-truth.ts:61-67` collapses "git could not run" into `dirty:false`/`headSha:null` (identical to a genuinely clean tree). Both mitigated today (archive-first + reversible flip; no consumer trusts `dirty:false` alone) but are deliberate git-loses-to-proxy branches.

### Tier 4 — structural enabler (makes central enforcement possible; kills phantom docs)

- **H. Real `ExitReason` enum.** `State.exit_reason` is a freeform `string`. The `ExitReason` / `ALL_EXITS` / `isFailedExit` / `isFailureExit` / `ALL_TICKET_STATUSES` helpers that `types/CLAUDE.md` and the `index.ts` header **claim to export are defined NOWHERE in `src/`** (phantom / false-anchor). Nothing can mechanically distinguish a git-derived terminal reason (`phase_no_progress`, `pipeline_phase_incomplete`) from a proxy-derived one (`timeout_repeat`, `manager_persistent_hallucination`, `success`). **Build the real enum + classifiers**, then a single git-consultation guard can live at the `StateManager.update`/`transaction`/`forceWrite` choke-point covering *all* terminalizations. This is the leverage that stops leak #8 from being born.

---

## The load-bearing floor (the honest answer to "is reliability possible")

There is a genuine, **small, benign** class that MUST terminate without a git completion signal — and none of it flips ticket status or discards work; it deactivates the *session* for operator recovery:

- **Budget:** `iteration_cap_exhausted`, `limit`, `rate_limit_exhausted`
- **Crash / unreadable:** `fatal`, `error`, `state_schema_version_ahead`, `signal:*`
- **Broken environment:** `toolchain_unavailable`, `codex_unhealthy_consecutive_failures`
- **Anti-infinite-loop escapes:** `bounded_terminal_escape` (Tier-3-F), `timeout_repeat`, `stall`, `circuit_open`

This floor is legitimate and does not lie about completion. **Reliability is achievable:** close the 7 leaks, add the enum, and the only remaining proxy-authority is this benign session-halt floor.

---

## Recommended sequencing

1. **Tier 1 (A+B)** — ship immediately; it is today's incident and pure subtraction.
2. **Tier 2 (C)** — the highest-frequency historical pain (R-WDTF); reuse existing guard.
3. **Tier 4 (H)** — the enum, so Tier 3 fixes and all future writes can be centrally guarded.
4. **Tier 3 (D,E,F,G)** — the design-decision conflicts, once H gives us the vocabulary.
