# Resume-Flow Heal + Git Safety Bundle (2026-05-14)

**Bundle ID:** R-RHGS (Resume Heal + Git Safety)
**Source findings:** Master Plan #36 R-SRTS, #37 R-PIWG, #38 R-PRCR, #41 R-RMBS
**Priority:** P1 (mixed P1/P2/P3 across tickets; bundle floor set by #37 P1 S1)
**Target:** pickle-rick-claude HEAD `b6bb789c..` (post-R-PPPG + anatomy-park R-RPPPG cleanup)
**Why this bundle:** Operator recovery is currently broken (R-PPPG ship hit #36 mid-stream and could not heal T7 without manual `state.json` edits) AND concurrent-session HEAD switches can silently corrupt pipeline state with no detection (S1, recurrence "when, not if" for any multi-AI operator). All four findings cluster in `setup.ts` resume path + worker prompt templates + `cancel.ts`, making refinement coherence high.

---

## Scope

8 tickets, single-PRD bundle (per current 1-PRD/8-ticket cap until R-MBSR ships).

| # | Ticket | Finding | Surface |
|---|---|---|---|
| 1 | R-SRTS-1 | #36 | `extension/src/bin/setup.ts` resume path |
| 2 | R-PIWG-1 | #37 | `extension/src/bin/setup.ts`, `extension/src/bin/mux-runner.ts` HEAD pin + re-check |
| 3 | R-PIWG-2 | #37 | `.claude/commands/pickle.md`, `pickle-tmux.md`, `anatomy-park.md` worker prompts |
| 4 | R-PIWG-4 | #37 | `extension/src/bin/cancel.ts` lock cleanup |
| 5 | R-PIWG-6 | #37 | `extension/src/types/activity-events.schema.json` + emitter wiring |
| 6 | R-PRCR-1 | #38 | `extension/src/bin/setup.ts` `validateResumeCompatibility` |
| 7 | R-RMBS-1 | #41 | Discovery: `mux-runner.ts`, `pipeline-runner.ts`, `state-manager.ts` runnable-set computation; document in `extension/src/bin/CLAUDE.md` |
| 8 | R-RMBS-3 | #41 | Ticket frontmatter `status:` as single source of truth for runnability |

**Deferred to next bundle:** R-PIWG-3 (worktree isolation — durable but larger scope), R-PIWG-5 (concurrent-access probe), R-PIWG-7/8 (trap-door + regression-test consolidation rolls into per-ticket Phase 2), R-SRTS continuation tickets, R-RMBS-4 (`pickle-retry --ticket` CLI).

---

## Tickets

### Ticket 1 — R-SRTS-1: Gate `setup.js --resume` ticket-status auto-correction behind explicit flag

**Why:** Master Plan Finding #36. Operator stops pipeline (operator rule #7), edits T7 frontmatter `status: "In Progress"` → `"Skipped"` + `skipped_reason` + `completion_commit`, then runs `setup.js --tmux --resume ${SESSION_ROOT}`. `setup.js` silently rewrites the file back to `status: "In Progress"` because `state.current_ticket === <T7>`. The auto-correction defeats the documented heal-via-edit-then-resume workflow.

**Acceptance criteria:**
1. **AC-SRTS-1.a** — Add CLI flag `--force-ticket-status-sync` (default `false`) to `setup.js`. When `false` AND `--resume <SESSION_ROOT>` is passed AND `state.current_ticket` is set AND the resolved ticket file's frontmatter `status:` value disagrees with `state.current_ticket`'s expected status, the rewrite path MUST be skipped. Resume proceeds with the operator's edited frontmatter intact.
2. **AC-SRTS-1.b** — When the auto-correction is skipped per AC-SRTS-1.a, emit schema-conformant activity event `setup_resume_ticket_status_preserved` with payload `{ ticket_id, observed_status, expected_status, reason: "operator_edit" }`.
3. **AC-SRTS-1.c** — When `--force-ticket-status-sync` IS passed, the legacy auto-correction runs unchanged AND emits a NEW activity event `setup_resume_overrode_ticket_status` with payload `{ ticket_id, prior_status, new_status, source: "force_flag" }`.
4. **AC-SRTS-1.d** — Document the heal flow in `extension/src/bin/CLAUDE.md`: "To heal a stuck ticket: (1) stop the pipeline first, (2) edit the ticket frontmatter, (3) re-run `setup.js --resume <SESSION_ROOT>` without `--force-ticket-status-sync`. The auto-correction is OFF by default; only pass the flag if you intentionally want runtime to overwrite operator edits."
5. **AC-SRTS-1.e** — Regression test in `extension/tests/setup-resume-ticket-status-preserved.test.js`: simulate (a) operator edits T1 status from In Progress → Skipped with completion_commit, (b) runs `setup.js --resume`, (c) assert ticket frontmatter retains Skipped, (d) assert `setup_resume_ticket_status_preserved` activity event fired. Second test for `--force-ticket-status-sync` path asserts rewrite + override event.

**Files:** `extension/src/bin/setup.ts`, `extension/src/types/activity-events.schema.json`, `extension/src/bin/CLAUDE.md`, `extension/tests/setup-resume-ticket-status-preserved.test.js` (new), deployed `extension/bin/setup.js` (post-tsc).

---

### Ticket 2 — R-PIWG-1: HEAD pinning at session bootstrap + pre-ticket re-check

**Why:** Master Plan Finding #37 sub-claim (a)+(b). `setup.ts:110,275` declares `worktreesRoot` but never consumes it; no HEAD pinning anywhere. A parallel Claude/IDE session can `git checkout main` underneath a running pipeline and workers continue committing to the wrong branch with zero detection. Reporter's reflog evidence shows real-world recurrence.

**Acceptance criteria:**
1. **AC-PIWG-1.a** — At session bootstrap in `setup.ts`, capture `state.pinned_branch = git symbolic-ref --short HEAD` and `state.pinned_sha = git rev-parse HEAD`. If `git symbolic-ref` fails (detached HEAD), set `pinned_branch = null` and pin only the SHA.
2. **AC-PIWG-1.b** — In `mux-runner.ts`, before selecting the next ticket for each iteration, re-run `git symbolic-ref --short HEAD` and `git rev-parse HEAD`. If `pinned_branch !== null` AND the current `symbolic-ref` differs from `pinned_branch`, OR if `pinned_branch === null` AND the current SHA differs from `pinned_sha` (no commit was recorded by the pipeline itself in `state.history`), abort the iteration and write `state.exit_reason = 'working_tree_modified_externally'`.
3. **AC-PIWG-1.c** — Emit schema-conformant activity event `head_mismatch_detected` with payload `{ pinned_branch, observed_branch, pinned_sha, observed_sha, detected_at_phase }`. Pipeline-runner surfaces this in the `Park closed but gate exhausted remediation cycles` style error to the operator with the exact mismatched values.
4. **AC-PIWG-1.d** — The pre-ticket check accounts for legitimate pipeline-internal commits: `state.history` already records every phase commit, so the check is "SHA changed AND `state.history` does not record the change". A `git restore`/`git commit` performed by a worker within the iteration that completed cleanly updates `state.history` and is not a mismatch.
5. **AC-PIWG-1.e** — Regression test in `extension/tests/integration/head-pin-mismatch-detection.test.js`: bootstrap a session, simulate an external `git checkout` between iterations, assert mux-runner aborts on the next iteration with `working_tree_modified_externally` and emits the activity event.

**Files:** `extension/src/bin/setup.ts`, `extension/src/bin/mux-runner.ts`, `extension/src/bin/pipeline-runner.ts` (error surfacing), `extension/src/types/index.ts` (State schema extension), `extension/src/types/activity-events.schema.json`, `extension/tests/integration/head-pin-mismatch-detection.test.js` (new).

---

### Ticket 3 — R-PIWG-2: Worker prompt hardening against destructive git

**Why:** Master Plan Finding #37 sub-claim (c). `.claude/commands/pickle.md:145` actively instructs `git stash + git checkout .` on validation failure; `.claude/commands/anatomy-park.md:412` instructs `git reset --hard <pre-iteration-SHA>` on revert. These instructions are themselves vectors for the bug class — they run destructive git on the shared tree.

**Acceptance criteria:**
1. **AC-PIWG-2.a** — Add a top-level "Git boundary rules" block to `.claude/commands/pickle.md`, `.claude/commands/pickle-tmux.md`, and `.claude/commands/anatomy-park.md` containing the verbatim string: *"Do NOT run `git checkout`, `git switch`, `git reset`, `git push`, `git pull`, `git stash`, `git rebase`, or modify `.git/`. You are pinned to the current branch. To inspect another ref, use `git show <ref>:<path>` or `git log <ref>`. The only allowed mutating git commands are `git add` (paths inside your ticket's scope), `git commit`, and `git restore <paths>` (path-scoped, non-destructive)."*
2. **AC-PIWG-2.b** — Replace `pickle.md` line 145's `git stash + git checkout .` instruction with `git restore <paths-to-discard>` (path-scoped, non-destructive). Operators who relied on the broader sweep can pass explicit paths.
3. **AC-PIWG-2.c** — Replace `anatomy-park.md` Phase 3 revert protocol's `git reset --hard <pre-iteration-SHA>` with `git restore --source <pre-iteration-SHA> --staged --worktree <paths-touched-this-iteration>` where `<paths-touched>` is the set from `git diff --name-only <pre-iteration-SHA> HEAD`. This restores only the iteration's edits without rewinding HEAD.
4. **AC-PIWG-2.d** — `bash install.sh` rsync to `~/.claude/commands/` propagates the edits (no source-vs-deployed drift).
5. **AC-PIWG-2.e** — Regression test in `extension/tests/skill-prompt-shape/git-boundary-prompts.test.js`: read each of the three command files and assert (a) the verbatim Git boundary rules block is present, (b) zero occurrences of `git stash`, `git checkout`, `git reset --hard`, `git pull`, `git push`, `git rebase`, (c) at least one occurrence of `git restore` per file as the replacement.

**Files:** `.claude/commands/pickle.md`, `.claude/commands/pickle-tmux.md`, `.claude/commands/anatomy-park.md`, `extension/tests/skill-prompt-shape/git-boundary-prompts.test.js` (new). No TS source changes.

---

### Ticket 4 — R-PIWG-4: Stale `.git/index.lock` cleanup in `cancel.ts`

**Why:** Master Plan Finding #37 sub-claim (d). `extension/src/bin/cancel.ts` only flips `state.active=false` and prunes `current_sessions.json`. Reporter's incident left `.git/index.lock` orphaned at 16:01:25 after the parallel session was SIGINT'd mid-`git pull`; operator had to manually `rm` it before `git` would work again. cancel.ts should detect orphaned locks and clean them up.

**Acceptance criteria:**
1. **AC-PIWG-4.a** — In `cancel.ts`, after writing `state.active=false`, check for `.git/index.lock` in `state.working_dir`. If present, compare its mtime to `state.last_activity_at` (already tracked in `state.json`).
2. **AC-PIWG-4.b** — If `index.lock.mtime > state.last_activity_at + 5 minutes` (lock predates last pipeline activity by 5+ min — clearly external), skip cleanup; the lock belongs to something else.
3. **AC-PIWG-4.c** — Otherwise, run `lsof <repo>/.git/index.lock` (or `pgrep -f 'git -C <repo>'`). If no live process holds the lock, `fs.unlinkSync` it and emit `stale_index_lock_cleaned` activity event with `{ path, mtime, age_seconds }`.
4. **AC-PIWG-4.d** — If a live process IS holding the lock, log to stderr: *"`<repo>/.git/index.lock` is held by PID `<pid>` (`<command>`). Refusing to clean up. Wait for that process to finish or kill it manually."* — emit `stale_index_lock_held_by_live_process` event with the PID.
5. **AC-PIWG-4.e** — Regression test in `extension/tests/cancel-index-lock-cleanup.test.js`: (a) bootstrap a session, (b) create a fake `.git/index.lock` file with mtime within the activity window, (c) run cancel, (d) assert lock removed + cleanup event fired. Second case asserts the held-by-live-process branch warns without removing.

**Files:** `extension/src/bin/cancel.ts`, `extension/src/types/activity-events.schema.json`, `extension/tests/cancel-index-lock-cleanup.test.js` (new).

---

### Ticket 5 — R-PIWG-6: Schema-conformant activity events for all PIWG paths

**Why:** Master Plan Finding #37 cleanup. R-PIWG-1 emits `head_mismatch_detected`, R-PIWG-4 emits `stale_index_lock_cleaned` + `stale_index_lock_held_by_live_process`. All three plus future PIWG-3 events (`worktree_session_created`) must have schema definitions in `activity-events.schema.json`, EVENT_CASES entries in `activity-event-payload.test.js`, and rows in `spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION`.

**Acceptance criteria:**
1. **AC-PIWG-6.a** — `extension/src/types/activity-events.schema.json` `oneOf` array contains definitions for `head_mismatch_detected`, `stale_index_lock_cleaned`, `stale_index_lock_held_by_live_process`, `setup_resume_ticket_status_preserved`, `setup_resume_overrode_ticket_status`, `setup_resume_chdir_applied` (last one from R-PRCR-1).
2. **AC-PIWG-6.b** — `extension/tests/activity-event-payload.test.js` EVENT_CASES table contains a row for each new event asserting required fields per the schema definition.
3. **AC-PIWG-6.c** — `extension/src/bin/spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION` (the symbol audit grounding section) lists the new event names so future refinement runs ground them correctly.
4. **AC-PIWG-6.d** — Regression-conformance test in `extension/tests/activity-events-piwg-conformance.test.js` asserts the schema/EVENT_CASES/spawn-refinement triangle is in sync for each of the new event names (no event is in two but missing the third).

**Files:** `extension/src/types/activity-events.schema.json`, `extension/tests/activity-event-payload.test.js`, `extension/src/bin/spawn-refinement-team.ts`, `extension/tests/activity-events-piwg-conformance.test.js` (new).

---

### Ticket 6 — R-PRCR-1: `setup.js --resume` honors stored `working_dir` via `process.chdir`

**Why:** Master Plan Finding #38. `extension/src/bin/setup.ts:595-606` `validateResumeCompatibility` calls `die('--resume session belongs to ${resumeWorkingDir}, not ${currentWorkingDir}. Refusing cross-repo resume.')` when cwd mismatches. The recorded `working_dir` IS the authoritative value — resume should `cd` into it instead of refusing.

**Acceptance criteria:**
1. **AC-PRCR-1.a** — When `setup.ts --resume <SESSION_ROOT>` runs and `path.resolve(process.cwd()) !== preState.working_dir`, FIRST verify `preState.working_dir` exists as a directory (`fs.statSync(working_dir).isDirectory()`). If yes, `process.chdir(preState.working_dir)` and emit `setup_resume_chdir_applied` activity event with `{ from: original_cwd, to: working_dir }`.
2. **AC-PRCR-1.b** — If `preState.working_dir` does not exist or is not a directory, retain the existing `die()` error path with a clearer message: *"`--resume` session's `working_dir` (`${working_dir}`) no longer exists or is not a directory. The original checkout was likely moved or removed. Restore it or start a new session."*
3. **AC-PRCR-1.c** — When the `chdir` happens, all subsequent setup.ts logic (HEAD pin capture in R-PIWG-1, scope.json reads, etc.) MUST use the new cwd. This is automatic since `process.chdir` mutates the process's `process.cwd()`, but the test must assert it: bootstrap-time `git symbolic-ref` runs in `preState.working_dir`, not in the operator's launch dir.
4. **AC-PRCR-1.d** — Regression test in `extension/tests/setup-resume-cross-cwd-chdir.test.js`: (a) bootstrap a session in `/tmp/repo-A`, (b) `cd /tmp/somewhere-else`, (c) run `setup.js --resume <SESSION_ROOT>`, (d) assert `process.cwd()` becomes `/tmp/repo-A` after setup completes, (e) assert `setup_resume_chdir_applied` event fired. Second test for missing-working_dir path asserts existing `die` message.

**Files:** `extension/src/bin/setup.ts`, `extension/src/types/activity-events.schema.json`, `extension/tests/setup-resume-cross-cwd-chdir.test.js` (new).

---

### Ticket 7 — R-RMBS-1: Locate and document the runner's runnable-set computation

**Why:** Master Plan Finding #41. Reporter's symptom: edit `refinement_manifest.json.tickets[0].status: "Blocked" → "Pending"` + resume → ticket still skipped. The 3-agent audit found `'Blocked'` is not in `TicketStatus` enum at HEAD, so the surface name from the report doesn't match this codebase. The runner must compute "runnable tickets" from SOMEWHERE — this ticket finds where and documents the contract.

**Acceptance criteria:**
1. **AC-RMBS-1.a** — Discovery: grep `extension/src/bin/mux-runner.ts`, `pipeline-runner.ts`, `state-manager.ts`, `setup.ts`, and `services/` for: `runnable`, `done=`, `blocked=`, `Runnable Tickets`, `failed_tickets`, `manifest.tickets.filter`, `collectTickets`. Identify every code path that influences whether a given ticket is selected on the next iteration.
2. **AC-RMBS-1.b** — Write the documented contract to a new section in `extension/src/bin/CLAUDE.md` titled `## Resume-time ticket runnability contract`: explicit precedence order between ticket frontmatter `status:`, `state.current_ticket`, any persisted `failed_tickets` / `skipped_tickets` set, `refinement_manifest.json[].status`, and `pipeline.json.completed_phases`. Include a "Heal flow recipe" sub-section: "To make a previously-failed ticket runnable again, edit X (not Y)."
3. **AC-RMBS-1.c** — If the discovery in AC-RMBS-1.a finds MULTIPLE conflicting sources of truth (e.g., a `state.failed_tickets` set AND ticket frontmatter both consulted), file a follow-up ticket reference at the bottom of the doc: *"Future work: collapse to single source (R-RMBS-3, this bundle Ticket 8)."*
4. **AC-RMBS-1.d** — Regression test in `extension/tests/runnability-contract-doc-shape.test.js` asserts the new CLAUDE.md section exists, contains a `Precedence:` line, contains a `Heal flow recipe:` line, and references at least three of: `frontmatter status`, `state.current_ticket`, `manifest.tickets[].status`, `pipeline.json.completed_phases`. (Doc-shape gate, not behavior gate — Ticket 8 owns behavior.)

**Files:** `extension/src/bin/CLAUDE.md`, `extension/tests/runnability-contract-doc-shape.test.js` (new). No source code changes — this is the discovery ticket.

---

### Ticket 8 — R-RMBS-3: Ticket frontmatter `status:` is the single source of truth for runnability

**Why:** Master Plan Finding #41 follow-through. Per the contract documented in Ticket 7, this ticket collapses any parallel runnability tracking to a single source.

**Acceptance criteria:**
1. **AC-RMBS-3.a** — Audit the discovery from Ticket 7: if `state.json` carries any `failed_tickets` / `blocked_tickets` / `skipped_tickets` set that is consulted independently of ticket frontmatter, REMOVE that set. The runner's runnability check must read frontmatter via `getTicketStatus(sessionDir, ticketId)` (existing API) and nothing else.
2. **AC-RMBS-3.b** — If `refinement_manifest.json[].status` is consulted at runtime (vs only at bootstrap to write ticket files), make it advisory — the authoritative status is the ticket file's frontmatter. The manifest's `status` field becomes informational metadata, not a runner-consulted gate.
3. **AC-RMBS-3.c** — Update `extension/src/bin/CLAUDE.md` "Resume-time ticket runnability contract" section to reflect the simplification: precedence becomes "ticket frontmatter `status:` is authoritative; all other sources are advisory."
4. **AC-RMBS-3.d** — Emit a NEW activity event `ticket_runnability_resolved` per iteration with payload `{ ticket_id, frontmatter_status, runnable: boolean, reason }` so observability surfaces the runner's decision.
5. **AC-RMBS-3.e** — Regression test in `extension/tests/integration/runnability-frontmatter-authoritative.test.js`: (a) bootstrap a session with 3 tickets, (b) mark ticket-2 status `Skipped`, (c) manually edit ticket-2 frontmatter back to `Todo`, (d) run a mux-runner iteration, (e) assert ticket-2 is selected (NOT skipped); assert `ticket_runnability_resolved` event recorded `runnable: true` for ticket-2 with the new frontmatter status.

**Files:** `extension/src/bin/mux-runner.ts`, possibly `extension/src/bin/pipeline-runner.ts`, possibly `extension/src/services/state-manager.ts` (remove parallel set if found), `extension/src/types/index.ts` (State schema change if removing field), `extension/src/types/activity-events.schema.json` (new event), `extension/src/bin/CLAUDE.md`, `extension/tests/integration/runnability-frontmatter-authoritative.test.js` (new).

---

## Bundle-level acceptance criteria

- **AC-BUNDLE-01** — `cd extension && npm run test:fast && npm run test:integration` exits 0 after all 8 tickets land.
- **AC-BUNDLE-02** — `npx tsc --noEmit && npx eslint src/ --max-warnings=-1` exits 0.
- **AC-BUNDLE-03** — `bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh` all exit 0.
- **AC-BUNDLE-04** — Trap-door entries added to `extension/src/bin/CLAUDE.md` for each new event family and each enforced invariant (R-SRTS heal preservation, R-PIWG HEAD pin, R-PIWG prompt boundary, R-PIWG lock cleanup, R-PRCR chdir, R-RMBS frontmatter authority). Each entry has the labeled triple INVARIANT / BREAKS / ENFORCE plus PATTERN_SHAPE.
- **AC-BUNDLE-05** — All new activity events present in `extension/src/types/activity-events.schema.json` `oneOf`, in `extension/tests/activity-event-payload.test.js` EVENT_CASES, and in `extension/src/bin/spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION` (the three-way symbol-audit grounding triangle).
- **AC-BUNDLE-06** — After all tickets land, `bash install.sh` deploys to `~/.claude/pickle-rick/` and `~/.claude/commands/` without errors; deployed `.claude/commands/pickle.md` / `pickle-tmux.md` / `anatomy-park.md` contain the verbatim "Git boundary rules" block from R-PIWG-2.

---

## Pre-flight risks

- **R-APMW-6 SIGTERM-cleanup flake** still present on HEAD (`extension/tests/.../timeout` delayed-cleanup). Worker test:fast runs may flake on this — refinement should annotate the affected tickets so the gate-baseline subtraction handles it. If the flake reproducibly bites the bundle, file a sister ticket inside the bundle, otherwise treat as pre-existing.
- **Test reliability prereq (master plan rule 3)** holds since R-ARSF shipped. Verify `npm run test:fast` is 10/10 green before launching the pipeline.
- **Concurrent sessions** — operator should NOT have other pickle sessions running against this checkout while this bundle ships, OR if they do, those sessions must be in worktrees (they aren't yet — R-PIWG-3 worktree isolation is deferred to the next bundle).
- **R-PIWG-2 prompt edits change worker behavior on validation failure / anatomy-park revert.** Existing pipelines depend on the `git stash + git checkout .` semantics. Carefully audit existing test expectations against the new `git restore <paths>` instruction — some tests may assert the prior stash behavior.

---

## Out of scope for this bundle

- R-PIWG-3 (worktree isolation via `git worktree add`) — durable fix, larger surface, next bundle
- R-PIWG-5 (concurrent-access probe via `lsof` at session launch) — defer
- R-RMBS-4 (`pickle-retry --ticket <id>` CLI) — UX add, next bundle
- All Tier-0 LLM-judge findings (#13, #16, #17, #26, #28) — separate bundle, different code-path family
- #19 R-MMTR claude max-turns relaunch — separate bundle, mux-runner internals
