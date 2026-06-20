---
title: P1 — B-CCRC — `hasCompletionCommit` ref-code coverage + gate-bypass closure
status: Draft
filed: 2026-05-24
priority: P1
type: bug-bundle
r_code_prefix: R-CCRC
related:
  - prds/MASTER_PLAN.md
  - prds/p2-completion-commit-quoted-form-and-exit-reason-2026-05-24.md
backend_constraint: any
refine: false
unattended: true
remediation_phases_required: ["citadel"]
---

# PRD — B-CCRC — `hasCompletionCommit` ref-code coverage + gate-bypass closure

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Why this bundle

MASTER_PLAN Finding #73 R-CCRC: `hasCompletionCommit` lookup keyed on ticket-id (`1511a4bc`) finds nothing when commit message uses R-code (`test(R-APWS-7):`). Surfaced **4 times** during B-APWS + B-WSRC-GR:

| Date | Session | Ticket | R-code | Commit msg | cc field after Done-flip |
|---|---|---|---|---|---|
| 2026-05-24 | pickle-28d81d50 | 1511a4bc | R-APWS-7 | `test(R-APWS-7): ...` | EMPTY (patched 69aaa442) |
| 2026-05-24 | pickle-28d81d50 | 27aedb81 | R-APWS-8 | `fix(b39913f4): recover R-APWS-8 ...` | EMPTY (patched 45223a06) |
| 2026-05-24 | pickle-28d81d50 | 0fee5b66 | R-APWS-9 | `fix(98b7cf2d): recover R-APWS-9 ...` | EMPTY (patched e80eaed5) |
| 2026-05-24 | pickle-01199cf9 | eee90f16 | R-WSRC-GR-1 | `feat(eee90f16): R-WSRC-GR-1 ...` **← ticket-id IS in subject** | EMPTY (patched 1dd1e8da) |

The 4th case is the smoking gun: commit `1dd1e8da feat(eee90f16):` DOES contain the ticket-id `eee90f16`. `hasCompletionCommit({ticketId:'eee90f16'})` should grep this and find it. But the frontmatter `completion_commit:` was empty after the Done-flip. **So the issue is broader than commit-msg/ticket-id mismatch — some Done-flip code path is bypassing `guardCompletionCommitBeforeDone` entirely.**

Two distinct bugs in one finding:

1. **R-CCRC-NARROW**: gate's ticket-id grep doesn't fall back to R-code (`r_code:` value from frontmatter). When the commit message uses R-code only (e.g. recovery commits cite a different SHA), gate finds nothing.
2. **R-CCRC-BYPASS**: some Done-flip path doesn't call `guardCompletionCommitBeforeDone` at all. Even when the commit DOES match the ticket-id, the gate isn't invoked, so the auto-promote never fires, and `completion_commit:` stays empty.

Operator manually patched 4 tickets today. The pattern will recur on every bundle until both are fixed.

## Bundle thesis

> "The completion-commit gate is the load-bearing check that proves work shipped. Every Done-flip path must invoke it; every invocation must match BOTH ticket-id AND R-code conventions. Today neither invariant holds."

## Bundle-level acceptance criteria

- [ ] **AC-CCRC-01** — `hasCompletionCommit` extends its scan to also grep for the ticket's `r_code:` value (if present in frontmatter) in addition to the ticket-id. Returns the first match. PATTERN_SHAPE: scan for both `<ticket-id>` AND the frontmatter's `r_code:` value in commit subject lines. If multiple commits match, return the most recent (HEAD-closest).
- [ ] **AC-CCRC-02** — Regression test `extension/tests/has-completion-commit-ref-code.test.js`: synthesize a fixture git repo with commits using (a) `feat(<ticket-id>):`, (b) `test(R-CODE):`, (c) `fix(<other-sha>): recover R-CODE ...` (recovery shape). Assert hasCompletionCommit returns `source:'inferred'` + correct SHA for each case. With NO matching commit, returns `source:'absent'`.
- [ ] **AC-CCRC-03** — Audit the codebase for ALL Done-flip code paths (grep `updateTicketStatus.*Done\|status.*Done.*ticket\|flipTicketToDone`). Identify any path that does NOT call `guardCompletionCommitBeforeDone` first. Document each path in the PRD body for the worker.
- [ ] **AC-CCRC-04** — For every Done-flip path identified in AC-CCRC-03, inject a `guardCompletionCommitBeforeDone` call (or document why it's safe to bypass). The R-WUWC SOFT-variant auto-promote (`f0f2e838`) already fires from `guardCompletionCommitBeforeDone`, so this is sufficient.
- [ ] **AC-CCRC-05** — Regression test `extension/tests/done-flip-paths-call-guard.test.js`: enumerate the canonical Done-flip entrypoints (manager respawn, transaction batch, recovery commit) and assert each routes through `guardCompletionCommitBeforeDone`. Use jest-style mock or test-double to verify the call.
- [ ] **AC-CCRC-06** — Trap doors added/updated in `extension/CLAUDE.md`: (a) new entry for the R-code fallback in `hasCompletionCommit`; (b) new entry pinning the "every Done-flip MUST route through `guardCompletionCommitBeforeDone`" invariant with ENFORCE pointing at the new test.
- [ ] **AC-CCRC-07** — Replay test for the 4 live incidents: load each ticket's frontmatter snapshot (pre-patch state) into a fixture repo with the same commit shapes; assert `hasCompletionCommit` now returns `source:'inferred'` with the correct SHA for all 4. (Forensic regression coverage.)
- [ ] **AC-CCRC-08** — Closer commit body: `Closed: MASTER_PLAN #73 R-CCRC via hasCompletionCommit ref-code fallback + done-flip-guard audit`.

## Trap-door touchpoints

### TOUCHES (must stay green)

- `src/services/pickle-utils.ts` `hasCompletionCommit` — R-CCQF parser normalization (just shipped in `e3f510fd`). The new R-code scan extends the LOOKUP path; the parser path stays unchanged.
- `src/services/pickle-utils.ts` `autoFillCompletionCommit` — R-WUWC SOFT-variant auto-promote. Must continue to fire from `guardCompletionCommitBeforeDone` after the gate finds an R-code match.
- `src/bin/mux-runner.ts` `guardCompletionCommitBeforeDone` — R-WUWC trap door + R-PEDC clear-on-recovery. The new gate-bypass audit may add new callsites; do not regress the existing 4 callsites (final-completion, post-iteration validation, recover_advance, final-ticket epic-complete per `e3f510fd`).

### ADDS

- `src/services/pickle-utils.ts` `hasCompletionCommit` (R-CCRC R-code fallback) — INVARIANT: scan extends to match `<ticket-id>` OR the frontmatter's `r_code:` value, returning the most-recent matching commit. BREAKS: regressing to ticket-id-only re-opens the R-CCRC class for recovery commits and R-code-style commit subjects. ENFORCE: `extension/tests/has-completion-commit-ref-code.test.js`. PATTERN_SHAPE: gate scan reads `r_code:` from frontmatter AND includes it in the git-log grep.
- `src/bin/mux-runner.ts` (R-CCRC gate-routing) — INVARIANT: every Done-flip code path MUST route through `guardCompletionCommitBeforeDone` before persisting `status: Done`. BREAKS: dropping a path re-opens the silent Done-without-evidence class that R-WUWC was supposed to close. ENFORCE: `extension/tests/done-flip-paths-call-guard.test.js`. PATTERN_SHAPE: any `updateTicketStatusInTransaction` / `flipTicketToDone` / equivalent helper MUST be preceded by `guardCompletionCommitBeforeDone` in the same call frame.

## Ticket sizing (~3 atomic tickets)

| Code | Effort | Files | ACs |
|---|---|---|---|
| **R-CCRC-1** | M (~25min) | `extension/src/services/pickle-utils.ts` + new test file | AC-CCRC-01, 02, 07 |
| **R-CCRC-2** | M (~30min) | `extension/src/bin/mux-runner.ts` + new test file | AC-CCRC-03, 04, 05 |
| **R-CCRC-3-CLOSER** | S (~20min) | `extension/CLAUDE.md` trap doors, `prds/MASTER_PLAN.md` (close #73), version bump + install.sh + tag | AC-CCRC-06, 08 |

## Pre-flight checklist

1. Working tree clean. HEAD on `main`. No active pipeline.
2. R-CCQF parser (`e3f510fd`) green: existing `has-completion-commit-quoted-form.test.js` exits 0.
3. R-WUWC SOFT-variant auto-promote (`f0f2e838`) green: existing `guard-completion-commit-auto-promote.test.js` exits 0.
4. R-PEDC clear-on-recovery green: `exit-reason-clears-on-recovery.test.js` exits 0.

## Risk register

- **R1**: Audit for Done-flip paths (AC-CCRC-03) may surface paths the original R-WUWC PRD assumed were already routed through the gate. If so, the bundle scope grows. Mitigation: if audit reveals >2 unrouted paths, file a follow-up R-CCRC-2-EXTRA ticket per path; do NOT block the bundle on each.
- **R2**: R-code fallback might over-match when multiple commits share an R-code prefix (e.g. R-APWS-1 vs R-APWS-10). Mitigation: scan order is `<ticket-id> exact` first, `r_code: exact` second (with word boundary); returns first match.
- **R3**: The R-code fallback may grep transient commits in `git log` that aren't actually for this ticket (cross-bundle reuse). Mitigation: scan limit window (e.g. last 500 commits, or `--since=<bundle-start>`); the existing `hasCompletionCommit` likely already bounds this — match the existing convention.

## Closer behavior (R-CCRC-3-CLOSER)

- Version bump: patch (e.g., `1.79.2 → 1.79.3`). New behavior is widened gate scan + new enforcement test — no operator-visible API change.
- Release gate: full canonical.
- Deploy: `bash install.sh`; verify md5-parity.
- MASTER_PLAN bookkeeping: close Finding #73 R-CCRC with closure SHA. Remove "Surfaced 4x" note.
- Closer commit body: `Closed: MASTER_PLAN #73 R-CCRC via hasCompletionCommit ref-code fallback + done-flip-guard audit`.

## What this bundle does NOT do

- Does NOT change the commit message convention for workers. Workers may continue to use either `feat(<ticket-id>):` or `feat(R-CODE):` styles; the gate now accepts both.
- Does NOT replace the existing R-WUWC SOFT-variant auto-promote (`f0f2e838`). Augments it by ensuring the gate is actually invoked (R-CCRC-2) and finds matches more broadly (R-CCRC-1).
- Does NOT touch the existing R-CCQF parser (`e3f510fd`) or R-PEDC clear-on-recovery (`e3f510fd`). Different layer.
- Does NOT extend coverage to non-git VCS (mercurial, etc). The scan is git-specific.

## Triggering session

To be assigned at launch via `/pickle-tmux prds/archive/bundles/p1-b-ccrc-completion-commit-ref-code-2026-05-24.md`. Expected duration: ~60-90 min (3 tickets).
