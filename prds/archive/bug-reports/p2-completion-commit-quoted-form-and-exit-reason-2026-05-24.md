---
title: P2 — Quoted-full-SHA completion_commit not recognized + `done_without_commit_evidence` exit_reason fires after all-Done ship
status: Draft
filed: 2026-05-24
priority: P2
type: bug
r_code_prefix: R-CCQF
related:
  - prds/p1-bug-fix-bundle-b-wuwc-reproducer-2026-05-23.md
  - prds/MASTER_PLAN.md
---

# P2 — `hasCompletionCommit` rejects quoted-full-SHA form, then pipeline mis-classifies exit_reason

## Symptom

Two distinct gaps surfaced together on session `pickle-48e6309a` (B-WUWC re-dispatch, 2026-05-23..24) closer ticket `26301c6a`. Bundle shipped 3/3 tickets cleanly (commits `d9bdb589`, `4b38893c`, `724f69d4`), but the pipeline exited with `exit_reason: done_without_commit_evidence` instead of `completed`.

| Gap | Symptom | Severity |
|---|---|---|
| **R-CCQF-1** | `hasCompletionCommit` reads ticket frontmatter `completion_commit: "724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8"` (quoted full SHA, 40 chars) as `source: 'inferred'` instead of `'explicit'`. The auto-promote helper (`autoFillCompletionCommit`, R-WUWC SOFT-variant fix `f0f2e838`) writes UNquoted short SHAs (e.g. `completion_commit: 4b38893c`) and those ARE recognized. The closer worker wrote the quoted full form manually and the gate refused. | P2 — work shipped; the gate ran twice with the auto-promote re-write between, but the second classification still failed because the existing field was a quoted full SHA that doesn't match the helper's read regex. |
| **R-PEDC-1** | Pipeline `state.exit_reason = 'done_without_commit_evidence'` is set when only ONE ticket out of N trips the SOFT-variant gate, even when all other tickets shipped Done. The closer DID land its commit, and 3/3 ticket frontmatters end at `status: Done` with `completion_commit` set — yet the pipeline reports a failure exit code. Operators looking at `pipeline-status.json` see `status: failed` even though every ticket shipped. | P3 — cosmetic but corrosive: false-negative exit signal trains operators to ignore `done_without_commit_evidence` as "probably fine" when it should mean "one ticket genuinely failed." |

## Root cause

### R-CCQF-1 (gate read regex)

`hasCompletionCommit` (at `extension/src/services/pickle-utils.ts:872` per `extension/CLAUDE.md` trap door inventory) parses the ticket frontmatter line for the explicit `completion_commit:` value. The parse must accept all three documented serialization shapes:

1. Unquoted short SHA (8 char): `completion_commit: 4b38893c`
2. Unquoted full SHA (40 char): `completion_commit: 4b38893c123...` (untested)
3. Quoted full SHA (40 char): `completion_commit: "724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8"`

The auto-promote helper writes shape #1. The closer worker — manually crafting the frontmatter via codex's edit primitive — wrote shape #3. The gate's `hasCompletionCommit` regex apparently matches shape #1 only.

### R-PEDC-1 (exit_reason classifier)

`mux-runner` records `state.exit_reason = 'done_without_commit_evidence'` on EVERY iteration where `guardCompletionCommitBeforeDone` returns `ok: false`. The exit_reason is not cleared on a subsequent successful pass. When the final iteration's gate eventually classifies `ok: true` (because auto-promote landed during the iteration), the prior iteration's `done_without_commit_evidence` exit_reason persists, and `finalizePipeline` uses it as the terminal classification.

The pipeline-status writer then stamps `status: failed` on `pipeline-status.json` based on the non-`completed` exit_reason. Operator-visible: pipeline ran 7 iterations, 3/3 tickets Done, BUT status shows failed.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| R-CCQF-1 | `hasCompletionCommit` parser MUST accept all three frontmatter serializations: (a) unquoted short SHA (≥7 chars), (b) unquoted full SHA (40 chars), (c) quoted (single OR double) short OR full SHA. Strip quotes before SHA validation. | P0 |
| R-CCQF-2 | Regression test `extension/tests/has-completion-commit-quoted-form.test.js`: 3 frontmatter fixture variants per shape (a/b/c) + 2 corruption cases (truncated SHA, non-hex chars) — all 5 cases assert correct `source` classification (`explicit` for valid; `absent`/`inferred` for corrupt). | P0 |
| R-PEDC-1 | `mux-runner` `recordExitReason` for `done_without_commit_evidence` MUST be CLEARED at the start of each iteration if the prior iteration's stamp survived. Alternative: use a per-iteration `last_iteration_exit_reason` field so the terminal classifier only reads the FINAL iteration's value, not the earliest non-zero one. | P1 |
| R-PEDC-2 | Regression test `extension/tests/exit-reason-clears-on-recovery.test.js`: synthesize a 2-iteration session where iter 1 trips the SOFT-variant fatal and iter 2 auto-promotes successfully. Assert: final `state.exit_reason === 'completed'` (NOT `done_without_commit_evidence`); `pipeline-status.json:status === 'succeeded'`. | P1 |

## Acceptance Criteria (machine-checkable)

- [ ] **AC-CCQF-01** — `hasCompletionCommit` accepts quoted full SHA — Verify: contract-level test asserts `parseFrontmatter('completion_commit: "724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8"').completion_commit === '724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8'` — Type: test
- [ ] **AC-CCQF-02** — `hasCompletionCommit` accepts unquoted full SHA — same shape, no quotes — Type: test
- [ ] **AC-CCQF-03** — `hasCompletionCommit` accepts single-quoted short SHA — Type: test
- [ ] **AC-CCQF-04** — Replay session `2026-05-23-48e6309a/26301c6a/linear_ticket_26301c6a.md` against the fixed gate → `source === 'explicit'` — Type: integration
- [ ] **AC-PEDC-01** — `done_without_commit_evidence` is cleared on next iteration's clean pass — Verify: regression test exit_reason check — Type: test
- [ ] **AC-PEDC-02** — Pipeline exit_reason on B-WUWC re-replay is `completed` not `done_without_commit_evidence` — Type: integration

## Trap-door touchpoints

- **TOUCHES**: `src/services/pickle-utils.ts` `hasCompletionCommit` (existing in extension/CLAUDE.md trap-door inventory at line 872); `src/bin/mux-runner.ts` R-WUWC SOFT-variant auto-promote (added `f0f2e838`/`13d44e2e`).
- **ADDS**: new INVARIANT for `hasCompletionCommit` quoted-form parser tolerance, ENFORCE `extension/tests/has-completion-commit-quoted-form.test.js`, PATTERN_SHAPE the regex accepting `["']?[0-9a-f]{7,40}["']?`.

## Ticket sizing (~3 atomic tickets)

| Code | Effort | Files | ACs |
|---|---|---|---|
| **R-CCQF-1** | S (~20min) | `extension/src/services/pickle-utils.ts` + new test file | AC-CCQF-01..04 |
| **R-PEDC-1** | M (~30min) | `extension/src/bin/mux-runner.ts` + new test file + trap-door update | AC-PEDC-01..02 |
| **R-CCQF-CLOSER** | S (~15min) | `prds/MASTER_PLAN.md` (close R-CCQF + R-PEDC findings) + version bump | bookkeeping |

## Forensic evidence

- Session: `~/.local/share/pickle-rick/sessions/2026-05-23-48e6309a/` retained
- Ticket: `26301c6a/linear_ticket_26301c6a.md` — frontmatter has `completion_commit: "724f69d4db8aae9b5f8e4ab7f3abfa0a72c5f6c8"` (quoted full SHA) post-closer-worker edit
- Pane capture (`tmux capture-pane -t pickle-48e6309a:0 -p`) shows the fatal at `2026-05-24T00:50:28.210Z`
- Auto-promote helper output (sibling tickets `efe52e45` / `31580bde`): unquoted short SHA (`d9bdb589`, `4b38893c`) → accepted by gate
- Commit shipped: `724f69d4 chore(26301c6a): v1.78.2 — close MASTER_PLAN #52 R-WUWC, archive B-WUWC-REPRODUCER bundle` (in `gregorydickson/pickle-rick-claude` `main`)
- Final state: 3/3 tickets Done, version bumped to 1.78.2 in source, but `pipeline-status.json:status === "failed"` due to stale exit_reason

## Out of scope

- Changing the auto-promote helper's serialization format. The unquoted short SHA is correct; the GATE should be the place that accepts both forms. Closing the gap by tightening the writer would break interop with humans/codex who naturally write quoted forms.
- Re-tagging `v1.78.2` (closer skipped `gh release create`). Operator-driven decision.

## Why P2 (not P1)

R-CCQF: work SHIPPED — the gate fired the fatal but the auto-promote re-write happened, the commit landed in git, and the next iteration's gate eventually classified `ok: true` (the third iteration ran on a fresh gate cycle). No data loss. The pipeline halted "noisily" but operationally cleared.

R-PEDC: cosmetic — `pipeline-status.json:status === "failed"` when 3/3 tickets are Done is a misleading signal but operators can grep `state.json:history` for the truth.

Bumped to P1 if combined with a real-bug ticket failure (operator skips the fatal noise and ships a real bug).
