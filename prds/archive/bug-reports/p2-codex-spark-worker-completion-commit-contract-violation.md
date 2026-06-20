---
status: draft
priority: P2
filed: 2026-05-05
slot: 1p
forensic_origin: bundle session 2026-05-04-f416c6cc run #2 forensics
related: prds/archive/features/p1-worker-backend-split-from-manager.md
---

# PRD: Codex-Spark Workers Skip `completion_commit:` Frontmatter — Phantom-Done False Reverts

**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`

## Problem

Codex-spark workers commit code to git successfully, then **skip writing the `completion_commit: <sha>` field** into the ticket frontmatter. The phantom-Done watcher (correctly per the documented contract) reads tickets with `status: Done` but no `completion_commit` field, treats them as phantom-Done, and reverts the ticket to `Todo`. The manager re-spawns. The worker fast-loops with no apparent progress (because git already has the commit and the worker thinks the work is done). Per-ticket circuit breaker trips.

Run #2 of bundle `2026-05-04-f416c6cc` lost commits **`8224fc7f`**, **`160e8816`**, and **`4d7c4cfa`** to this pattern even though all three were real, valid, in-tree fixes. The reliability-bundle armoring effort (Section A keystones) prevented further loss after deploy, but the underlying contract violation in codex-spark workers is unfixed.

The contract is documented in `extension/src/bin/spawn-morty.ts:436` as a worker prompt directive:

> `**MUST** write completion_commit: <sha> into ticket frontmatter immediately after committing. NEVER flip status: Done before the commit exists.`

Codex-spark **ignores this directive** ~30% of the time on the bundle's tier=small tickets. Claude follows it reliably. The disposition isn't quirky-LLM; it's a structural prompt-adherence gap that the worker prompt cannot close from inside the worker context window alone.

## Proposal

Three independent mitigations, layered:

1. **Worker prompt strengthening** (cheapest, lowest impact alone) — add a structured ACK line the worker must echo before/after each commit.
2. **Post-commit wrapper that auto-fills frontmatter** (mid cost, fully eliminates the bug) — git post-commit hook OR worker tool wrapper inspects `git log -1 --format=%H -- <ticket-path>` and writes the field if missing.
3. **Phantom-Done watcher cross-checks git log** (defense in depth) — when frontmatter lacks `completion_commit` but git has a recent commit touching the ticket file with worker-author attribution, treat as `completion_commit_inferred: <sha>` instead of reverting.

Mitigation 2 is the keystone. Mitigations 1 and 3 are belt-and-suspenders.

## Requirements

### R-CCC-1 — Worker prompt: structured ACK
- `extension/src/bin/spawn-morty.ts:436` (the worker prompt block) gets a new ACK directive:
  > `After every git commit, you MUST output the literal line `COMPLETION_COMMIT_RECORDED: <sha>` to stdout. The runner watches for this token and will retry if it's missing.`
- Runner (`mux-runner.ts` or worker output parser) reads the token from worker stdout into `state.activity` event `worker_completion_commit_announced`.

### R-CCC-2 — Post-commit frontmatter auto-fill
- New helper script `extension/src/bin/auto-fill-completion-commit.ts` runs at the end of each worker turn (or as a git post-commit hook installed by spawn-morty into the worker's git config).
- For every ticket file that has `status: Done` but no `completion_commit:`, run `git log -1 --format=%H -- <ticket-path>`; if the head commit's author is the current worker (matches `state.session_id` or `current_ticket`), write the SHA into the frontmatter and stage the change.
- The wrapper runs IDEMPOTENTLY (existing `completion_commit:` lines are preserved).
- New activity event `completion_commit_auto_filled` with payload `{ ticket, sha, source: 'auto_fill' }`.

### R-CCC-3 — Phantom-Done watcher: git-log cross-check
- The phantom-Done watcher (currently at `extension/src/services/phantom-done-watcher.ts` if separate, or inline in `mux-runner.ts`) treats absent `completion_commit:` as **inferred from git log** when:
  - `git log -1 --format=%H -- <ticket-path>` returns a SHA, AND
  - That SHA's commit message references the ticket ID, AND
  - The commit is newer than `state.session.start_time`.
- When inferred, the watcher writes `completion_commit_inferred: <sha>` to the frontmatter instead of reverting the ticket.
- Distinct from R-CCC-2 in that this fires *defensively* when the auto-fill missed (e.g., wrapper not installed, worker shell exited before post-commit).

### R-CCC-4 — Tests
- `extension/tests/auto-fill-completion-commit.test.js` — integration test: simulate worker commit + missing frontmatter; auto-fill helper writes the SHA; idempotent re-run is no-op.
- `extension/tests/phantom-done-cross-check.test.js` — integration test: missing `completion_commit:`, but git log shows a fresh ticket-touching commit by the session worker → watcher writes `completion_commit_inferred:` instead of reverting status.
- `extension/tests/spawn-morty-completion-commit-prompt.test.js` — assert the ACK directive is present in the worker prompt template.
- Regression: `extension/tests/integration/codex-spark-worker-completion-commit.test.js` — replay of the run #2 forensic state where the bug occurred; assert auto-fill closes the gap.

## Acceptance Criteria

- **AC-CCC-01** — Worker prompt template at `spawn-morty.ts:436` contains the `COMPLETION_COMMIT_RECORDED:` ACK directive.
- **AC-CCC-02** — Worker stdout containing the ACK token emits `worker_completion_commit_announced` activity event.
- **AC-CCC-03** — `auto-fill-completion-commit.ts` exists, is wired into the worker turn-end path, and idempotently writes `completion_commit:` for `status: Done` tickets where git has a session-author commit.
- **AC-CCC-04** — Auto-fill emits `completion_commit_auto_filled` activity event registered in `VALID_ACTIVITY_EVENTS` + schema.
- **AC-CCC-05** — Phantom-Done watcher cross-checks git log and writes `completion_commit_inferred: <sha>` instead of reverting when the inference holds.
- **AC-CCC-06** — Inference logic emits `completion_commit_inferred_from_git` activity event.
- **AC-CCC-07** — Run #2 forensic replay test (fixtures from `tests/fixtures/baseline-2026-05-03-7d9ee8cc/` pattern) asserts no false revert under the new flow.

## Notes

- This bug compounds with slot 1o (manager/worker backend split). With 1o landed, claude can be the manager (no hallucinated edits) while codex-spark is the worker (subject to this contract violation). With 1p ALSO landed, the hybrid is fully reliable.
- Cycle 1 should confirm that the auto-fill helper runs on the worker side (not the manager side) — running it on the manager risks cross-ticket contamination.
- Cycle 2 should enumerate every place phantom-Done logic lives and confirm a single source of truth.
- Mitigation order matters: R-CCC-2 alone closes the bug; R-CCC-1 and R-CCC-3 are belt-and-suspenders. Refinement may collapse R-CCC-1 if auto-fill is judged sufficient.

---

## Forensic addendum — 2026-05-05 mid-day, run #6 of bundle session `2026-05-04-f416c6cc`

Run #6 attempts 1, 2, and 3 each tripped phantom-Done false-revert despite the operator manually backfilling `completion_commit:` SHAs into 30 ticket frontmatters via R-* code matching against `git log` (workaround #7 in `CONTEXT_2026-05-05_PM.md`). Attempt 3 reverted ticket `58fac5e3` from Done back to Todo even though:

1. The ticket frontmatter had `completion_commit: <valid-sha>` written.
2. The SHA exists in `git log` and references the ticket via R-* code.
3. An operator hotfix was applied to deployed `mux-runner.js` — patched `correctPhantomDoneTickets` and `validateAutoTicketCompletion` to honor `completion_commit:`.

The hotfix did NOT take effect. Two hypotheses (only one need be true to explain the symptom):

**Hypothesis A — patch landed in source TS but not deployed JS.** The hotfix was edited into `extension/bin/mux-runner.js` (deployed copy), but a subsequent `npm run build` / `tsc` from source recompiled `extension/bin/mux-runner.js` (in-tree copy) WITHOUT the patch, then `bash install.sh` overwrote the deployed copy. md5 parity check at 10:46 confirms `bin/mux-runner.js` source ≠ deploy now (source `f6a9831c` vs deploy `1e92078d`), suggesting an even later worker compile that left the deploy stale in the OPPOSITE direction. Net: hotfix patches are in some intermediate state that no path on disk matches.

**Hypothesis B — separate phantom-Done code path uses a cached `getTicketStatus` result.** The patched call sites (`correctPhantomDoneTickets:243`, `validateAutoTicketCompletion:545`) are NOT the only readers of ticket status. A third path — likely `getTicketStatus()` helper in `services/pickle-utils.ts` or the `iteration_start` hook in `mux-runner.ts` — reads frontmatter via a cached / non-patched function that returns "no completion_commit" → triggers the revert. The hotfix only patched the visible branches.

Either hypothesis demands the same architectural fix: **`completion_commit:` frontmatter must be honored at every gate, not just two of them**, AND the gate logic must live in a single helper (eliminating the cached-second-path failure mode by construction).

### R-CCC-5 — Phantom-Done watcher: `completion_commit:` is the FIRST gate everywhere (NEW)

- Introduce a single shared helper `hasCompletionCommit(ticketFrontmatter): { sha: string | null, source: 'explicit' | 'inferred' | 'absent' }` in `extension/src/services/pickle-utils.ts`.
- Helper returns:
  - `'explicit'` when frontmatter has `completion_commit: <sha>` AND the SHA is reachable in `git log` from `HEAD` (fast `git cat-file -e <sha>^{commit}` check).
  - `'inferred'` when frontmatter lacks `completion_commit:` BUT R-CCC-3 cross-check succeeds (commit message references ticket ID OR R-* code listed in ticket title, newer than `state.session.start_time`).
  - `'absent'` only when both fail.
- ALL phantom-Done call sites — `correctPhantomDoneTickets` (mux-runner.ts:243), `validateAutoTicketCompletion` (mux-runner.ts:545), AND any `getTicketStatus` cached path — MUST call this helper as their FIRST check.
- Reverting Done→Todo is permitted ONLY when helper returns `'absent'`.
- Refactor existing `hasCommitReferencingTicketSince(workingDir, ticket.id, startCommit)` to be a **subroutine** of the helper, not a parallel call site. The current pattern at mux-runner.ts:243 (which searches commit messages for the ticket hash like `51d826c9` while bundle commits use `R-*` codes — 100% miss rate) is the proximate cause of run #6's revert cascade.
- Audit script `extension/scripts/audit-phantom-done-call-sites.sh` greps the codebase for any `status === 'Done'` + revert-without-helper pattern; CI fails on new instances.

### Additional acceptance criteria

- **AC-CCC-08** — `hasCompletionCommit` helper exists in `pickle-utils.ts` with the three-state return type. Unit-tested for all three branches.
- **AC-CCC-09** — Every phantom-Done revert path proven by codebase grep + audit script to call the helper as the first gate. Audit script wired into `extension/scripts/audit-trap-door-enforcement.sh` (or a new `audit-phantom-done-call-sites.sh`).
- **AC-CCC-10** — Replay test using run #6 forensic state (`state.json.run6-handoff-snapshot` + `mux-runner.log.run6-handoff-snapshot` from session `2026-05-04-f416c6cc`): with operator-backfilled `completion_commit:` SHAs and bundle commit messages using R-* codes (not ticket hashes), zero false reverts occur.

### Forensic data preserved

- `~/.local/share/pickle-rick/sessions/2026-05-04-f416c6cc/state.json.run6-handoff-snapshot` — frozen at `step=research iteration=2 current_ticket=f8153c03 active=false exit_reason=signal`.
- `~/.local/share/pickle-rick/sessions/2026-05-04-f416c6cc/mux-runner.log.run6-handoff-snapshot` — captures hotfix-defeated revert sequence on ticket `58fac5e3`.
