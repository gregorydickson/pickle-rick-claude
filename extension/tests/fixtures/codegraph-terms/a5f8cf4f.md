---
id: a5f8cf4f
title: "WS-2: treat a done_without_commit_evidence halt as fatal when all tickets are terminal"
status: "Done"
completion_commit: c4f0e5a8
priority: High
complexity_tier: medium
order: 40
working_dir: /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
source_prd: prds/p1-bug-fix-r-mwmo-d2-exit-code-masking.md
source_section: "WS-2 — make the consumer treat the halt as fatal"
mapped_requirements: [AC-MWMO-D2-8, AC-MWMO-D2-9]
created: 2026-07-16
updated: "2026-07-17"
links:
  - url: ../rick_ticket_parent.md
    title: Parent
---
# Description

## Problem
`isFatalPhaseFailure` (`extension/src/bin/pipeline-runner.ts:2774`) decides a pickle-phase failure is
fatal only when `countCommitsSince(startCommit) === 0`:
```ts
if (runnerState.exit_reason === 'readiness_halt') return true;
const startCommit = runnerState.start_commit?.trim();
if (!startCommit) return true;
return countCommitsSince(startCommit, runtime.repoRoot) === 0;
```
A `done_without_commit_evidence` halt means **THIS ticket** has no commit — it says nothing about the
session. So the halt is inferred non-fatal from a **session-wide** commit count.

**⚠ READ THIS BEFORE SCOPING — the obvious framing is WRONG, and a naive AC here is VACUOUS.**
An earlier draft justified this ticket as "otherwise the pipeline proceeds to citadel anyway." **That
is false in the common case.** `finalizePhaseSuccess` (`:4115-4133`) runs two pickle-only guards, and
`maybeStampPhaseGraduation` (`:3586+`) returns `null` **only** when the verdict is `'graduate'`; on
any refusal **both** branches `return { action: 'break', phaseIncomplete: true }`. That is why
LOA-1763 printed *"not advancing"* / *"65/66 remain unfinished"* despite exit 0. **With tickets
pending, the graduation gate already stops the advance — WS-2 changes nothing there.**

**The case that actually matters is ALL-TERMINAL:** when every ticket IS terminal but one lacks a
commit, graduation **succeeds** → `maybeStampPhaseGraduation` returns `null` → falls through to
`counters.completed++` → **`Phase pickle completed successfully`** and advance. That is exactly the
**final-ticket path** (the `mux-runner.ts:~11026` site: last ticket marked Done, no commit).
**This ticket is the only thing between that and a fake-green pipeline.**

Ordering note (an analyst got this backwards; the source is authoritative): `shouldHaltAfterPhase` →
`isFatalPhaseFailure` is called at `:4011`, **BEFORE** `finalizePhaseSuccess` at `:4033`. The seam IS
reachable.

## Solution
Make a `done_without_commit_evidence` halt always-fatal for the pickle phase, independent of the
session-wide commit count.

## Entry Conditions
Fast tier green. Logically depends on de25ce90 (without WS-1 the phase exits 0 and
`shouldHaltAfterPhase` short-circuits at `if (exitCode === 0) return false;`).

## Research Seeds
- **Files**: `extension/src/bin/pipeline-runner.ts:2774-2785` (`isFatalPhaseFailure`), `:2808`
  (`shouldHaltAfterPhase`), `:4011-4033` (call order), `:4115-4133` (`finalizePhaseSuccess` +
  the two pickle-only guards), `:3586+` (`maybeStampPhaseGraduation`), `graduationDecision`
- **Patterns**: `grep -n "isFatalPhaseFailure\|maybeStampPhaseGraduation\|graduationDecision" extension/src/bin/pipeline-runner.ts`
- **APIs/types**: `PipelineRuntime`, `GraduationCounts`, `runnerState.exit_reason`

## Implementation Details
**Files to modify/create**: `extension/src/bin/pipeline-runner.ts`,
`extension/tests/mux-runner-done-without-commit-evidence-exit.test.js` (shared) or a
`pipeline-runner-*` sibling test file — the author picks; state which.

**Dependencies**: de25ce90 (WS-1).

**⚠ DO NOT cite `readiness_halt` as precedent.** It is **DEAD CODE**: `readiness_halt` is NOT a
member of the `ExitReason` union (`extension/src/bin/mux-runner.ts:4367`), `mux-runner` never records
it (zero call sites), and the DEPLOYED `mux-runner.js` contains no `readiness_halt` at all — while
`pipeline-runner.ts:3917-3924` claims to "promote mux-runner's generic `readiness_halt`" from a
producer that does not exist. **Do NOT pin `readiness_halt` symmetry in a test** (you would be
pinning dead code). Filed separately as `R-PRNF9-DEAD` (MASTER_PLAN §C) — **do not fix it here.**

**⚠ SCOPE FENCE — do NOT re-architect `isFatalPhaseFailure`.** Its session-wide
`countCommitsSince` heuristic IS the brittle root (this ticket is its SECOND always-fatal exception,
which is evidence the heuristic is wrong). **That subtraction is explicitly OUT OF SCOPE and logged
as a follow-up.** Add the one check; do not grow the bundle.

## Interface Contracts
**Inputs**: `phase: PhaseName`, `runtime: PipelineRuntime` (reads `runnerState.exit_reason`,
`start_commit`)
**Outputs**: `boolean` — fatal or not
**Errors**: none (existing `try/catch` retained)
**Invariants**: a `done_without_commit_evidence` pickle halt is fatal **regardless of
`countCommitsSince`**, and the phase does not report success or advance.

## Acceptance Criteria
- [ ] AC-MWMO-D2-8 — with `exit_reason` = `done_without_commit_evidence` and **ALL tickets terminal**
  (so graduation would otherwise `graduate`), the pickle phase does NOT report
  `completed successfully` and does NOT advance. **⚠ Do NOT pin the `countCommitsSince > 0` +
  tickets-pending case — that passes TODAY via the graduation gate and proves nothing.**
  — Verify: `cd extension && node --test tests/mux-runner-done-without-commit-evidence-exit.test.js` — Type: test
- [ ] AC-MWMO-D2-9 — the assertion is on the **operator-visible outcome** (no
  `Phase pickle completed successfully`, no advance to citadel), NOT merely that
  `isFatalPhaseFailure` returns `true`. A `true` that nothing acts on changes nothing.
  — Verify: `cd extension && node --test tests/mux-runner-done-without-commit-evidence-exit.test.js` — Type: test
- [ ] The all-terminal AC FAILS on pre-fix source (red-first demonstrated and recorded).
  — Verify: `cd extension && node --test tests/mux-runner-done-without-commit-evidence-exit.test.js` — Type: test
- [ ] Type checker passes. — Verify: `cd extension && npx tsc --noEmit` — Type: typecheck

## Test Expectations
| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-MWMO-D2-8 | `extension/tests/mux-runner-done-without-commit-evidence-exit.test.js` | All tickets terminal, one without a commit, `exit_reason=done_without_commit_evidence` | phase does NOT report `completed successfully`; does NOT advance. **Fails pre-fix.** |
| AC-MWMO-D2-9 | same | Assert the operator-visible outcome, not the boolean | no `Phase pickle completed successfully` in output; citadel not reached |
| non-vacuity | same | Document why the pending-tickets case is NOT pinned | comment names the graduation gate as the reason that case passes without WS-2 |

## Conformance Check
- [ ] Type checker passes — no new errors
- [ ] Test runner passes — all acceptance tests
- [ ] No `readiness_halt` symmetry pinned (it is dead code)
- [ ] `isFatalPhaseFailure` is NOT re-architected — one check added
<!-- audit: 7-class checked 2026-07-16 -->

## Exit State
An all-terminal bundle with a commit-less ticket can no longer graduate to a fake-green
`Phase pickle completed successfully`.

## NOT in Scope
Re-architecting `isFatalPhaseFailure` off `countCommitsSince` (logged follow-up). Fixing or deleting
the dead `readiness_halt` cluster (`R-PRNF9-DEAD`). `--strict-phases`. mux-runner exit paths
(de25ce90 / a3812edd / c0293300). Reason reporting (be604d1d).
