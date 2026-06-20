# Codex worker commits real work WITHOUT the ticket hash → completion-evidence `kind:'absent'` → FATAL halt of pickle phase

**Status**: Draft (P2, capture-only) — captured by babysitter during a live `/pickle-pipeline --backend codex` run. NOT yet dispatched to a fix bundle.

**Severity**: P2 — fatally halts the pickle phase (pipeline reports 0/4 phases, never reaches citadel), BUT the worker's commit lands in the tree (no work lost) and recovery is a single flag / one frontmatter line. Recurs on every codex run where a worker omits the ticket hash from its commit message.

**Class**: D2 (wrong-signal completion — "completion keys on commits-landed / inferred instead of tree-passing-gates + frontmatter", per R-DSAN #114). Codex-backend variant of completion-evidence attribution. Sibling to the closed **#94 R-CXOR** (codex false-Done / `completion_commit==start_commit`) — but the inverse failure: here the work IS committed, yet the gate FALSE-HALTS instead of false-advancing.

## Symptom

```
[fatal] 2026-06-19T15:11:24.673Z ticket cdf8c371 cannot flip Done: readEvidence().kind === 'absent'
(expected 'explicit'); worker did not produce an attributable git commit.
Set state.flags.allow_inferred_completion_commit=true to bypass, or edit ticket frontmatter to
include completion_commit: <sha>.
[2026-06-19T15:11:24.680Z] Phase pickle exited with code 0
[2026-06-19T15:11:24.691Z] Phase pickle exited but 12/14 tickets remain pending (2 Done) —
not all-tickets-terminal, marking phase incomplete (not advancing)
[2026-06-19T15:11:24.692Z] Phase pickle exited (exit_reason=done_without_commit_evidence); 12/14 unfinished.
🧪 Pipeline Complete  Phases: 0/4
```

## Reproduction (concrete, observed once)

- Repo: `loanlight-api` @ branch `gregory/loa-1387-bank-statement-failed`
- Invocation: `/pickle-pipeline packages/api/docs/loa-1387-bank-statement-extraction-resilience-prd.md --backend codex --refine` (LOA-1387 bank-statement resilience, 14 tickets: 9 impl + wiring + 4 hardening)
- Pipeline session: `2026-06-19-2b1e2707` (preserved at `~/.local/share/pickle-rick/sessions/2026-06-19-2b1e2707/`)
- Pickle phase ran **8 iterations / 18m**, completed **2 tickets**, then FATAL-halted at the completion-evidence gate while trying to flip ticket `cdf8c371` (W5, trivial prompt change) to Done.
- Git truth at halt (branch HEAD):
  - `1381d1db8 fix: forbid null for required bank statement metadata` ← **THIS IS the W5/cdf8c371 work** — the change is present and correct at `packages/api/src/lib/bank-statement/llm-structuring.ts:64`. The commit message **does NOT contain the ticket hash `cdf8c371`**.
  - `21febf784 fix(63bc7f69): preserve zod error identity` ← ticket `63bc7f69`, flipped Done with `completion_commit: 21febf784…` — its message **embeds the hash**, so `readEvidence` resolved `explicit` and it passed.

## Root cause

The completion-evidence reader (`readEvidence()`) attributes a ticket's Done-flip to a git commit by matching the **ticket hash in the commit message** (and/or `completion_commit` frontmatter). Codex-backend workers are **inconsistent** about embedding the hash:

- `63bc7f69` → `fix(63bc7f69): …` → attributable → `kind:'explicit'` → Done OK.
- `cdf8c371` → `fix: forbid null …` (no hash) → not attributable → `kind:'absent'` → **FATAL**, even though the commit exists, is on HEAD, and contains exactly the ticket's deliverable.

Because the gate is fatal (not per-ticket-skip), one mis-messaged codex commit halts the entire pickle phase. The pipeline-runner then correctly declines to advance (12/14 pending) — the **non-advance is right**; the **fatal-on-present-work is the defect**.

## Impact

- Every codex `/pickle-pipeline` run is one mis-messaged worker commit away from a fatal pickle-phase halt that requires operator/babysitter intervention, despite the work being committed and gate-clean.
- The `claude` backend embeds the hash reliably (per #94 R-CXOR history), so this is codex-specific.

## Workaround (applied this incident, capture-only — no fix shipped)

1. Added `completion_commit: "1381d1db8834fa356fcaedfecc73b2e56e5b2be0"` to `cdf8c371` frontmatter (the documented per-ticket escape).
2. Set `state.flags.allow_inferred_completion_commit=true` so subsequent codex tickets whose commits omit the hash infer attribution from the per-iteration commit rather than re-fataling.
3. Relaunched — pipeline resumed from ticket `1332026c`.

## Proposed direction (capture-only — to be refined if dispatched)

- **AC-1 (codex commit attribution):** codex worker/manager commit-message construction MUST embed the ticket hash (mirror the claude backend), e.g. `fix(<hash>): …`, so `readEvidence` resolves `explicit` without operator flags.
- **AC-2 (proportional fallback, D2 north-star):** when a ticket's frontmatter says Done AND the tree passes its gates, completion should attribute to the iteration's landed commit (tree-truth) rather than fatally requiring a hash in the message — i.e. prefer ground-truth (commit-on-HEAD-since-iteration-start) over message-string matching. This is the D2 "key on tree-passing-gates + frontmatter, not commit-message tokens" principle.
- **AC-3 (non-fatal degrade):** a single unattributable Done-flip should mark that one ticket for re-verification, not FATAL-halt the whole phase.

## Cross-references

- **#94 R-CXOR** (closed, v1.96.0) — codex completion attribution / false-Done guard; same machinery, opposite failure direction.
- **#114 R-DSAN / D2** — wrong-signal completion structural defect; this is a fresh D2 recurrence on the codex backend.
- **#123 B-GROUND2 / #124 R-DPMC-2** — completion-authority consolidation; the `readEvidence` fatal is a completion-authority seam.
