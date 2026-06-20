---
id: p1-closer-ticket-spins-on-r-wsrc-forbidden-acs
title: "R-CTSF — Closer ticket spins indefinitely on R-WSRC-forbidden ACs with no terminal handling"
status: "Refined"
priority: P1
filed: 2026-05-16
finding: 44
filed_against:
  - commit: aaac2d57
  - session: 2026-05-16-f712faeb
  - ticket: 8dd7774e
  - bundle: B-MRWG (R-MRWG-6 closer)
recurrence:
  - "2026-05-16 14:48 CDT — closer iter 17/18 spin observed on this session; manual tmux kill required"
  - "2026-05-16 14:53 CDT — auto-resume.sh re-spawned mux-runner post-kill; worker rollback (`resetToSha`) wiped manager-only version-bump commit AND the in-progress PRD untracked file. Operator commit lost to git reflog; PRD lost to filesystem."
---

<!-- R-CTSF compliant -->

# Problem

When the B-MRWG closer ticket `8dd7774e` (R-MRWG-6) reached its final iteration the worker self-declared `status: "Failed"` in `linear_ticket_8dd7774e.md` because two of its ACs are now structurally impossible from worker scope:

| AC | Issue | Source of forbid |
|---|---|---|
| (c) `bash install.sh --closer-context --no-confirm` | Worker scope cannot run `install.sh` | `extension/src/bin/bash-scanner.ts` + `CLAUDE.md` *Worker Forbidden Ops* row "`bash install.sh` from worker" |
| (b) Full release gate from `extension/` | Gate exits 1 on **pre-existing HEAD regressions** (Finding #32 R-TFP `audit-test-tiers` canary + 6 unrelated test files) | R-TFP open bug; not in R-MRWG-6 scope |

The closer had already shipped its single in-scope work commit (`aaac2d57 fix(8dd7774e): clear closer lint blockers`). After that, the worker correctly refused to bump `extension/package.json`, run `install.sh`, or edit `prds/MASTER_PLAN.md` because the mandated gate did not go green — so it wrote `status: "Failed"` and re-emitted handoff notes asking the manager to take over.

**The pipeline did not stop.** `extension/src/bin/mux-runner.ts` does not treat `status: "Failed"` as a terminal exit signal — `checkFailedAfterResearchApproved` (line 3275) only emits a single stderr breadcrumb. So the orchestrator kept advancing iterations (16 → 17 → 18) and would have continued to the `max_iterations: 80` ceiling, burning ≈62 more 8–10-minute iterations on out-of-scope HEAD regressions that the worker is structurally unable to fix. Operator intervention (`tmux kill-session -t pickle-f712faeb`) halted that visible spin.

**Then it got worse.** `auto-resume.sh` re-spawned mux-runner shortly after the manual kill (per R-CNAR-2 foreground-only wrapper). The new mux-runner instance re-spawned a worker on the same `Failed` ticket. The worker re-ran the gate, failed at the same pre-existing R-TFP regressions, and on failure called `resetToSha(args.preWorkerHead, ...)` per `spawn-morty.ts:1065` — which rolled the working tree back to its pre-worker HEAD. That rollback wiped:

1. The operator's `chore: bump version to 1.75.1` commit (`af0144b9`, lost to git reflog).
2. The closer worker's intermediate `fix(8dd7774e): realign codex pin and restore closer lint fixes` commit (`5352b2e2`, lost to git reflog).
3. The operator's untracked-but-staged-in-working-tree bug PRD file (lost to filesystem; recovered from operator memory).

This is the same R-CSI Finding #25 / R-PIWG-3 worktree class — a worker rollback in one logical bundle nuked an operator's parallel manager-owned commit. Cwd-collision multiplied by `auto-resume.sh` foreground-respawn.

This is two-part, three-part counting the rollback amplifier:

1. **Authoring bug (A-side).** Closer ticket templates encode ACs like "Deploy via `bash install.sh`" that R-WSRC bash-scanner already forbids from worker scope. Any worker that picks up the closer ticket is guaranteed to fail those ACs. The PRD pattern was authored before R-WSRC enforcement and has not been refreshed.
2. **Runtime bug (B-side).** Even when a worker correctly self-declares `status: "Failed"` and writes a manager-handoff conformance + handoff_notes, `mux-runner.ts` does not exit. The pipeline keeps iterating until `max_iterations` (80) is hit, the operator kills the tmux session, or the worker accidentally flips status back to a non-terminal value. There is no Failed-status terminal exit, no "handoff-to-manager" signal, no cap on iterations against the same `current_ticket` in `Failed` state.
3. **Rollback amplifier (C-side).** `auto-resume.sh` re-spawning mux-runner on a Failed-and-tmux-killed session compounds (B). Each fresh worker invocation does `resetToSha(preWorkerHead)` on gate failure, which is destructive to operator-side manager-handoff work in the same cwd.

# Why this matters

- **Operator-work data loss.** Manager-handoff commits and untracked operator-authored PRDs in the same cwd are at risk of `resetToSha` rollback by the next auto-respawned worker. Recovery requires git reflog spelunking; untracked-file rebuild requires re-typing from operator memory.
- **Token + wall-clock burn.** Each spin iteration spawns a worker subprocess that runs the same gate, hits the same R-TFP failure, writes the same conformance, and exits. Observed wall-clock: ≈8–10 min / iteration × up to 62 remaining iterations = up to ~10 hours of wasted compute on a closer that has structurally completed.
- **Operator confusion.** The pipeline looks "still alive" (state.json fresh, circuit breaker CLOSED, iterations advancing) by every mechanical wedge criterion, so handoff prompts saying "monitor unless wedged" let the spin continue. The closer is in fact **stuck waiting for manager-owned work** (version bump, install.sh, MASTER_PLAN edit, release tag) — not wedged, not in flight; in handoff.
- **Pattern, not one-off.** Every release-closer ticket in the repo (R-MRWG-6, R-WSRC-6, R-MMTR-7, R-R-MMTR closer, R-E2E closer, etc.) mandates `bash install.sh` as an AC. Each one of them is now structurally impossible from worker scope post-v1.75.0 and will spin under the same conditions.

# Solution

Three PRDs would normally split this, but they share the same root and the same failure surface so they are co-bundled.

## R-CTSF-1 — Closer-ticket AC template: split worker-AC from manager-AC

Edit closer-ticket generation prompts and existing closer-ticket markdown templates so that ACs are partitioned:

- **Worker ACs (must be runnable from worker scope):** lint, typecheck, scoped behavior verification, conformance writeup.
- **Manager ACs (explicitly tagged `[manager]`):** `bash install.sh`, version bump, MD5 parity verify on deployed JS, `prds/MASTER_PLAN.md` updates, `gh release create`.

Workers MUST NOT mark a ticket Failed because manager ACs are not met. Workers MUST emit `[manager-handoff]` in the final conformance summary and set `status: "Done"` (not `"Failed"`) when all worker ACs pass and only manager ACs remain.

Update:
- `extension/src/services/refinement-prompts.ts` (closer-ticket prompt)
- `.claude/commands/pickle-prd.md` (closer-ticket section)
- `extension/src/services/conformance-writer.ts` (recognize `[manager]` AC tag, defer evaluation)
- `extension/src/services/citadel-conformance.ts` (treat `[manager]` ACs as N/A in worker scope)

**Acceptance**
- New closer tickets generated by `/pickle-prd` partition ACs with explicit `[worker]` and `[manager]` tags.
- `conformance-writer` records `[manager]` ACs in a separate "Manager handoff" section with status `DEFERRED-MANAGER`, not `F`.
- Worker scope writes `status: "Done"` + `completion_commit:` + a top-of-file `## Manager Handoff` block listing the deferred ACs.
- Updated regression: `extension/tests/services/refinement-prompts.test.js` asserts the `[manager]` tag survives prompt rendering.

## R-CTSF-2 — `mux-runner.ts` terminal handling for `status: "Failed"` + `status: "Done"` with manager-handoff

Add a terminal-exit pathway in the iteration loop:

- At the **start** of each iteration (after `getTicketStatus`), if the current ticket's status is `"Failed"` and the conformance verdict is `FAIL` for ≥2 consecutive iterations on the same ticket+head_sha, write `state.exit_reason = 'closer_handoff_terminal'`, emit `activity.event = 'closer_handoff_terminal'`, and exit the tmux outer loop. Operator handles the manager work.
- Symmetrically, if status is `"Done"` AND the most recent conformance file contains `## Manager Handoff` block, write `state.exit_reason = 'manager_handoff_pending'` and exit the loop.
- New CLI flag `--closer-handoff-iter-budget N` (default `2`) for the consecutive-iteration threshold, overridable per session for debugging.

Update:
- `extension/src/bin/mux-runner.ts` — new function `detectCloserHandoffTerminal(sessionDir, ticketId, headSha)` invoked from the main iteration head; new exit_reason values `closer_handoff_terminal` and `manager_handoff_pending`.
- `extension/src/types/index.ts` — extend `ExitReason` union.
- Test: `extension/tests/integration/closer-handoff-terminal.test.js` — fixture with closer ticket Failed across 2 iters; assert mux-runner exits with new exit_reason.

**Acceptance**
- Closer ticket with `status: "Failed"` for 2 consecutive iters terminates the mux loop within 3 iters (1 detection + 1 grace + 1 exit at most).
- Closer ticket with `status: "Done"` + `## Manager Handoff` block terminates immediately.
- New integration test passes deterministically (no flake).
- `state.json:exit_reason` records the terminal cause for `pickle-status` to surface.

## R-CTSF-3 — `auto-resume.sh` stop-on-`closer_handoff_terminal` (R-CNAR-4(c) extension)

`auto-resume.sh` already halts on `exit_reason ≠ 'pipeline_phase_incomplete'` per R-CNAR-4(c). Extend that contract so the two new exit_reasons `closer_handoff_terminal` and `manager_handoff_pending` (added by R-CTSF-2) are unambiguously terminal — they MUST NOT trigger a re-spawn, even with retries remaining. Add explicit stop conditions:

- `extension/scripts/auto-resume.sh` — extend R-CNAR-4 stop-condition block to grep `state.exit_reason` for `closer_handoff_terminal` OR `manager_handoff_pending` and print a clear `[stop] manager handoff required` line before exiting.
- Trap-door: `extension/tests/auto-resume-stop-conditions.test.js` adds a case asserting auto-resume.sh stops immediately on `state.exit_reason='closer_handoff_terminal'`, no retry.

**Acceptance**
- Auto-resume.sh recognizes both new exit_reasons as terminal.
- Trap-door test passes; existing R-CNAR-4 tests unaffected.

## R-CTSF-4 — Audit + refresh existing closer-ticket templates in PRDs

One-shot sweep: grep `prds/` for any closer ticket that lists `bash install.sh` or `gh release create` as a worker AC. Edit those PRDs in place to apply the worker/manager split (R-CTSF-1 format). Add a top-of-PRD comment block `<!-- R-CTSF compliant -->` so future grep-audits can detect drift.

Affected PRDs (verified 2026-05-16):
- `prds/archive/bug-reports/p1-mux-runner-wedges-13h-on-unbounded-between-ticket-gate-spawnsync.md` (R-MRWG-6) — already shipped, only retroactive tag
- `prds/p1-worker-source-state-recursion-contamination.md` (R-WSRC-6) — already shipped, only retroactive tag
- Any open closer ticket in active queue (R-MMTR-7, R-E2E closer, R-R-MMTR closer)

**Acceptance**
- All PRDs in `prds/` with a closer ticket carry `<!-- R-CTSF compliant -->` or `<!-- R-CTSF retroactive (shipped pre-R-CTSF) -->`.
- Audit script `extension/scripts/audit-closer-template-compliance.sh` runs in `npm run test:integration` and exits non-zero on any closer ticket missing the marker or referencing `bash install.sh` outside a `[manager]` block.

## R-CTSF-5 — Closer ticket runbook: operator-facing manager-handoff doc

Add `docs/closer-ticket-manager-handoff.md` covering:

1. What `state.exit_reason = closer_handoff_terminal` means.
2. The five manager-owned steps: version bump → commit → `bash install.sh` → MASTER_PLAN edit → commit + push → `gh release create vX.Y.Z`.
3. The "verify gate failures are pre-existing" heuristic (cross-reference Finding #32 R-TFP, B-FLAKE) so operators don't get scared into reverting the bundle.
4. Recovery if mux-runner does NOT exit cleanly (operator `tmux kill-session`, then state.json `active: false` flip if needed).
5. **Lockout protocol** — after killing a closer ticket's tmux session, operators MUST verify no `auto-resume.sh` is running (`pgrep -af auto-resume`) before doing manager work, OR they MUST `git push` immediately after each commit to lock changes against future rollback. The C-side rollback amplifier observed 2026-05-16 will eat uncommitted/unpushed work.

**Acceptance**
- `docs/closer-ticket-manager-handoff.md` exists, linked from `prds/MASTER_PLAN.md` State of the world, and from `CLAUDE.md` Worker Forbidden Ops table.

## R-CTSF-6 — Closer ticket for R-CTSF bundle

Authored per R-CTSF-1 with explicit ownership tags:

- [worker] Run the R-CTSF source-scope validation bundle: `bash scripts/audit-test-tiers.sh`, `bash scripts/audit-test-isolation.sh`, `bash extension/scripts/audit-closer-template-compliance.sh`, and the targeted closer audit integration test. If residual release-gate failures are inherited, capture them in the handoff instead of failing on manager-only work.
- [worker] Prepare the manager handoff package: exact PRDs swept for compliance, the runbook/doc links landed, and the expected parity/bookkeeping commands for closeout.
- [manager] Bump `extension/package.json` for the R-CTSF ship if the operator chooses to release this bundle.
- [manager] Deploy via `bash install.sh --closer-context --no-confirm`.
- [manager] MD5 parity verify on the compiled files touched by the R-CTSF bundle.
- [manager] Update `prds/MASTER_PLAN.md` and perform release/bookkeeping steps, including any optional `gh release create vX.Y.Z` action.

# Out of scope

- Pre-existing R-TFP test:fast flakes (Finding #32) are not closed by this PRD — they continue to block the worker's exact release gate from going green. Worker handling under R-CTSF lets the closer correctly hand off without spinning; R-TFP closure is independent.
- Authoring a single shared closer-ticket macro (templating system) — would help, but expanding scope; deferred to a future authoring-quality PRD.
- Fixing `resetToSha` so it never reaches operator-untracked files — discussed but out of scope; the better fix is to never auto-respawn the worker on a `Failed` closer (R-CTSF-2/3).

# Risk / counter-arguments

- **Why not just let workers run `install.sh`?** R-WSRC enforcement is load-bearing: install.sh from worker scope is the exact recursion-contamination vector R-WSRC closed. Re-opening it for closer scope would re-introduce the bug class.
- **Why not auto-execute manager ACs from mux-runner?** Mux-runner runs as a long-lived background process under the same user identity that authored R-WSRC. Auto-running `bash install.sh` from the orchestrator would just relocate the forbidden op. Manager handoff to an interactive operator (or to a higher-trust automation layer outside the worker sandbox) is the safer pattern.
- **Iteration budget false-positive risk.** If a worker legitimately fixes a Failed status on a later iter, the 2-iter window would still exit. Mitigation: the detection key includes `head_sha` — if the worker advances HEAD between iters, the counter resets.

# Trap doors

Each ticket's `conformance_*.md` MUST include explicit evidence for:
- R-CTSF-1: rendered closer prompt with `[worker]` + `[manager]` tags
- R-CTSF-2: integration test exits with new `closer_handoff_terminal` exit_reason
- R-CTSF-3: auto-resume.sh test stops on new exit_reason
- R-CTSF-4: `audit-closer-template-compliance.sh` exit code 0 on all current PRDs
- R-CTSF-5: doc exists + linked from CLAUDE.md
- R-CTSF-6: closer authored per R-CTSF-1 (self-referentially proves it works)
