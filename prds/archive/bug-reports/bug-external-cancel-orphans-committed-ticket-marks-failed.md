# Bug: an external SIGTERM to pipeline-runner cancels the run, marks the in-flight (already-committed) ticket Failed, and resets HEAD off its good commit

**Filed**: 2026-06-12 (babysitter intervention #9, session 2026-06-10-f50e5c11, v2.0.0-beta.1 bundle, ticket 4ca418e9 / C3)
**Severity**: P2 — operator/external-signal-triggered, but silently orphans a fully-committed, gate-green ticket and strands the whole phase
**Status**: Open

## Incident

At 23:42:47Z (210m into the pickle phase) pipeline-runner (pid 99097) received an EXTERNAL signal. Its shutdown handler (`pipeline-runner.js:2004` `fs.writeFileSync(cancelMarker, signal)`) wrote `${sessionDir}/pipeline-cancel`, propagated SIGTERM to the mux (99165), and exited: `Phase pickle exited with code 0` → `Pipeline cancelled (cancel marker found) — stopping` → `Pipeline finished: 1/4 phases, 210m 0s`. (The "210m 0s" is elapsed phase-1 time from the 20:12Z relaunch, NOT a configured budget — grep confirms no 210/12600/phaseTimeout in pipeline-runner.)

Collateral damage to the in-flight ticket C3 (4ca418e9), which had just FINISHED its full lifecycle:
- C3 produced research→plan→conformance→code_review→**simplify** and **committed as `ac5c4f51`** (setup.ts +86, compiled setup.js +77, 10 forward-created integration tests).
- The cancel-driven teardown marked C3 **Failed** and **reset HEAD from `ac5c4f51` back to `c2b572ed`** (C1), orphaning C3's good commit. reflog: `HEAD@{0}: reset: moving to c2b572ed` / `HEAD@{1}: commit: feat(4ca418e9)…`.
- Net: state `active=false, step=completed`, 13 effectively-done tickets showing 12 Done + 1 Failed, 12 Todo unbuilt, HEAD silently rewound past a conformant commit.

This is the **orphaned-commit-after-spurious-Failed** class (memory `feedback_orphaned_own_commit_ff_recovery`) — and notably the EXACT failure mode that THIS bundle's H1 ticket (`detectAndRecoverHeadRegression`, shipped `c79a0d84` earlier this run) is built to auto-reattach. The runtime fix exists in source but is not yet deployed (no install.sh mid-bundle), so the babysitter performed the reattach by hand.

## Recovery applied

- `git merge-base --is-ancestor c2b572ed ac5c4f51` → ff-safe; `git merge --ff-only ac5c4f51` reattached C3's commit; tsc green; C3's 10 integration tests 10/10 green.
- Marked C3 Done with `completion_commit: ac5c4f51`.
- Cancel marker already auto-unlinked on exit (no stale re-cancel risk); reset `state.step` completed→research, `active=true`, cleared `current_ticket`; relaunched. Iter 80 advanced to C4 (e7e46cb5). 13 Done.

## Fix proposal (machine-checkable)

1. **AC-1 — don't mark a committed ticket Failed on external cancel.** When pipeline-runner cancels (signal/marker), the mux teardown MUST NOT flip the in-flight ticket Failed if it has a completion commit / full artifact set; leave it Done (or In Progress) so resume doesn't treat conformant work as a failure. Assert: SIGTERM during a ticket that has already committed → ticket status not Failed, HEAD unchanged.
2. **AC-2 — cancel teardown must NEVER reset HEAD off a ticket's own commit.** The reset-on-Failed path must be guarded by `git merge-base --is-ancestor HEAD <ticket_commit>` (H1's detectAndRecoverHeadRegression logic) and ff-reattach rather than rewind. Assert: a fixture where the in-flight ticket committed then the run is cancelled → HEAD remains at the ticket commit, no orphan.
3. **AC-3 — resume self-heals an orphaned ticket commit.** On `setup.js --resume`, if a Failed ticket's frontmatter/reflog names a commit that ff-descends from HEAD, auto-reattach + mark Done (deploy H1's path to the resume seam). Composes with the shipped H1 runtime once install.sh deploys it.
4. Cross-refs: H1 (`e56ed23f`, the built-but-undeployed auto-reattach), `feedback_orphaned_own_commit_ff_recovery`, B-LERD (run-strand-on-single-ticket-failure family).

## Verification of recovery

- HEAD `ac5c4f51` (C3 reattached); tsc + 10/10 C3 tests green.
- mux-runner.log 00:13:13Z: Iteration 80, current_ticket=e7e46cb5 (C4); 13 Done / 1 In Progress / 11 Todo.
