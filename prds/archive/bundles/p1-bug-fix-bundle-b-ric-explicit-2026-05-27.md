---
title: P1 — B-RIC-EXPLICIT bundle: hasCompletionCommit misreads explicit linear_ticket_<id>.md completion_commit as 'inferred'
status: Draft
filed: 2026-05-27
priority: P1
type: bug-bundle
finding_id: 83
---

# PRD — B-RIC-EXPLICIT bundle

**Trigger**: 2026-05-26 21:55Z, B-RELEASE-DRIFT session `pickle-ea04b6f8` was bricked mid-bundle by `[fatal] ticket 110f51bd cannot flip Done: hasCompletionCommit().source === 'inferred' (expected 'explicit')`. The ticket file `<sessionDir>/110f51bd/linear_ticket_110f51bd.md` HAD an explicit `completion_commit: "6ef59f22dd25e94817b704225e80a92efe9cba31"` line; the matching commit (`docs(110f51bd): R-SMTEST-3 — add R-SMTEST early-exit invariant docstrings…`) was present at HEAD; R-CCQF (#70) shipped `normalizeCompletionCommitField` 2026-05-24 to accept both quoted and unquoted SHA forms. Yet `hasCompletionCommit` still returned `source: 'inferred'` and `guardCompletionCommitBeforeDone` raised fatal, exiting mux-runner with `exit_reason: done_without_commit_evidence`.

Operator bypass via `state.flags.allow_inferred_completion_commit = true` (R-PDWR) unblocked the pipeline at 21:58Z, but the bypass is one-shot and must be set per-session. **Until this is fixed, every bundle is one manager-kill away from this fatal** — a serious risk to the cron-driven babysitter pattern that depends on `kill -TERM <wedged-pid>` being safe.

**Source-of-truth grep** (2026-05-26):
- `extension/src/services/pickle-utils.ts` exports `hasCompletionCommit`, `ticketFilePath`, `readFrontmatterField`, `CompletionCommitEvidence`
- `extension/src/bin/mux-runner.ts:1714, 2888` call `hasCompletionCommit({sessionDir, ticketId, workingDir})`
- `extension/src/bin/mux-runner.ts:2880` checks `allow_inferred_completion_commit` to bypass
- `extension/src/bin/mux-runner.ts:2927` raises the fatal error
- R-CCQF (#70) shipped `normalizeCompletionCommitField` for quote-form normalization

## Acceptance Criteria

- **AC-BRIC-00**: a session where ticket `<id>/linear_ticket_<id>.md` has explicit `completion_commit: "<full-or-short-sha>"` frontmatter AND the corresponding commit exists at HEAD MUST cause `hasCompletionCommit({sessionDir, ticketId, workingDir})` to return `source === 'explicit'`. Both quoted and unquoted SHA forms (full or short) MUST resolve to 'explicit'.
- **AC-BRIC-01**: regression test reproduces the 2026-05-26 ea04b6f8 incident with a golden fixture (frontmatter + git history mock) and asserts `source === 'explicit'`.
- **AC-BRIC-02**: full release gate (`cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`) exits 0 from a clean clone.

## Tickets

### R-RIC-EXPLICIT-1 — Diagnose & reproduce

Write `extension/tests/has-completion-commit-explicit-source.test.js` (forward-created) that:

1. Creates a tmp session dir with `<sessionDir>/110f51bd/linear_ticket_110f51bd.md` whose frontmatter contains `completion_commit: "6ef59f22dd25e94817b704225e80a92efe9cba31"` (quoted form, matching the ea04b6f8 incident exactly).
2. Initializes a tmp git repo with a commit whose message contains the ticket id `110f51bd` and whose SHA matches the frontmatter.
3. Calls `hasCompletionCommit({sessionDir, ticketId: '110f51bd', workingDir})`.
4. Asserts `evidence.source === 'explicit'` — this **MUST fail** initially (matches the 2026-05-26 ea04b6f8 fatal). Test commit must include this red-state output.
5. Also asserts coverage for unquoted-short, unquoted-full, and quoted-short SHA forms (per R-CCQF normalization contract).

Output: bug commit + ticket-dir artifacts documenting which code path returns 'inferred' for the explicit case (likely `ticketFilePath(sessionDir, ticketId)` resolves to a path different from `<sessionDir>/<ticketId>/linear_ticket_<ticketId>.md`, OR `readFrontmatterField` doesn't recognize the field name, OR the explicit branch is bypassed because the file doesn't exist at the canonical path).

### R-RIC-EXPLICIT-2 — Fix root cause

Update `hasCompletionCommit` in `extension/src/services/pickle-utils.ts` so the resolver checks `<sessionDir>/<ticketId>/linear_ticket_<ticketId>.md` for an explicit `completion_commit:` frontmatter field (in addition to wherever it currently looks). On match, `source === 'explicit'` MUST be returned regardless of whether the commit is also discoverable via grep-on-message-body. Use the existing `normalizeCompletionCommitField` helper (R-CCQF) for quote-form normalization.

Acceptance: the test from R-RIC-EXPLICIT-1 flips red→green. No regression in existing `extension/tests/has-completion-commit-quoted-form.test.js` (R-CCQF coverage) — both old and new test files MUST pass.

### R-RIC-EXPLICIT-3 — Trap door + closer

Add a trap door entry in `extension/src/services/CLAUDE.md` (under the `pickle-utils.ts` section) documenting the new INVARIANT: `hasCompletionCommit` MUST honor explicit `completion_commit:` frontmatter in `<sessionDir>/<ticketId>/linear_ticket_<ticketId>.md`. BREAKS: returns `source: 'inferred'` when explicit, causing `guardCompletionCommitBeforeDone` to fatal mid-bundle (R-RIC regression filed as MASTER_PLAN #83). ENFORCE: `extension/tests/has-completion-commit-explicit-source.test.js`. PATTERN_SHAPE: `readFrontmatterField` call against `linear_ticket_<id>.md` before falling back to grep-on-message.

Closer: bump version 1.80.2 → 1.80.3, run install.sh (set `state.flags.allow_install_sh_reason` then clear per `feedback_closer_install_sh_bypass`), `gh release create v1.80.3`.

## Closer

`R-RIC-EXPLICIT-CLOSER` — final release gate, version bump 1.80.2 → 1.80.3, install.sh deploy, `gh release create v1.80.3 --notes 'B-RIC-EXPLICIT bundle (finding #83): hasCompletionCommit now honors explicit completion_commit frontmatter in linear_ticket_<id>.md, preventing pipeline-brick after manager kill.'`. Closes finding #83.
