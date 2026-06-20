# Bug: inferred completion_commit drives a phantom-Done backfill loop (1.9MB state.json); the state-trim recovery is then blocked by a dirty-tree relaunch FATAL

**Filed**: 2026-06-12 (babysitter intervention #11, session 2026-06-10-f50e5c11, v2.0.0-beta.1 bundle)
**Severity**: P1 — unbounded state.json growth heads to a hard freeze; the recovery is itself blocked by an unrelated dirty-tree guard
**Status**: Open

## Incident

### D1 — phantom-Done backfill loop on `completion_commit_inferred`
C9 (361e8bd9) landed Done but its frontmatter carried `completion_commit_inferred: "85b45d75…"` (inferred from git, not an explicit `completion_commit`). The phantom-Done watcher treats inferred-completion as "needs backfill" and re-backfilled it EVERY pass, each emitting two activity events (`phantom_done_backfilled` + `completion_commit_inferred_from_git`). By detection: `state.activity` had **7021 entries / 1.55MB**, of which **3433 + 3433** were the backfill spam — state.json at **1.9MB** and climbing toward the documented 20MB freeze (`project_phantom_done_backfill_infinite_loop_recovery`).

### D2 — dirty-tree FATAL blocks the trim-and-relaunch recovery
The recovery (freeze → make C9 completion explicit → trim activity → relaunch) stopped the pipeline, but the relaunch FATAL'd at the pipeline-runner dirty-tree preflight: `Commit, stash, or discard changes before starting the pipeline`. The blocker was C10's (620698a5) in-flight, uncommitted docs work (CLAUDE.md, README.md, ci.yml, release.yml, a test) — left dirty by the freeze. So the state-trim recovery could not relaunch until the unrelated dirty C10 work was resolved. This is the same dirty-tree-self-cleanup gap the peer session filed (R-PRPATH D2 / `p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md`).

## Recovery applied

- D1: rewrote C9 frontmatter `completion_commit_inferred` → explicit `completion_commit: 85b45d75` (stops the backfill); trimmed `state.activity` from 7322→156 (dropped both backfill event types), state.json 1.9MB→229KB.
- D2: verified C10's dirty work was its complete docs deliverable (README+CLAUDE.md codegraph/hardening/PICKLE_CODEGRAPH blocks present; ci.yml+release.yml correctly add `audit-guarded-reset.sh` to the gate; parity test 2/2; tsc green) → committed as `d6e4732a`, marked C10 Done → clean tree → relaunch took. Iter 9, R1 (e6a2bdfc) In Progress. 19/25 Done.

## Fix proposal (machine-checkable)

1. **AC-1 — never backfill on an already-Done ticket with a resolvable commit.** The phantom-Done watcher must, when a ticket is Done and an inferred OR explicit commit exists in git, PROMOTE `completion_commit_inferred`→`completion_commit` ONCE and stop re-emitting. Assert: a Done ticket with `completion_commit_inferred` produces exactly one promotion event, never a growing `phantom_done_backfilled` count.
2. **AC-2 — bound the activity log.** `state.activity` must be capped (ring buffer / size ceiling) so a misbehaving emitter cannot grow state.json unbounded. Assert: N backfill attempts → `activity.length` stays ≤ cap.
3. **AC-3 — dirty-tree relaunch must self-heal a single in-flight ticket's files** (adopt R-PRPATH D2 / AC-R-MCDT-1): when the tree is dirty solely within the current In-Progress ticket's declared files, the runner quarantines/commits-WIP rather than FATAL. Assert: relaunch after a freeze with the current ticket's docs dirty proceeds past preflight.
4. Cross-refs: `project_phantom_done_backfill_infinite_loop_recovery` (memory), R-PRPATH / `p3-pipeline-runner-dirty-tree-guard-blocks-self-cleanup.md` (peer), B-XSPA (the SIGTERM phase-skip that created the inferred-completion conditions).

## Verification of recovery

- C9 explicit `completion_commit: 85b45d75`; state.activity 156; state.json 229KB.
- C10 `d6e4732a` Done; tree clean; mux iter 9, current_ticket=e6a2bdfc (R1); 19 Done / 6 Todo.
