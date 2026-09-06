# Closer Ticket Manager Handoff

Use this runbook when a closer exits with `state.exit_reason = closer_handoff_terminal`, or when
an operator is asked to clear a parked Manager Handoff residual (see below).

## Meaning

- `closer_handoff_terminal`: the worker hit the configured closer-handoff stop condition and cannot complete manager-owned residuals from worker scope. This halts the run.
- **Manager Handoff residual (TIER-1.2 gh-11)**: worker-owned closer work is done and the latest conformance artifact includes a `## Manager Handoff` block. This does **not** halt the run — the ticket is parked Done and the residual is logged as a `gate_skipped` activity event (`gate_payload.reason: 'manager_handoff_pending'`, `gate_payload.file: <conformance artifact>`) so the operator can find and finish the deferred item without the pipeline stopping. There is no longer a `manager_handoff_pending` value of `state.exit_reason`.

## Manager-owned steps

1. Inspect the latest conformance artifact and confirm the remaining items are manager-owned only.
2. Run the version-bump step for `extension/package.json` if this closer is shipping a release. Before the bump: READ the gate result and confirm green as its own act — bump, commit, and tag are separate acts, never batched with the gate-read. The one time you batch the tag with the gate-read is the time the gate was red (Fable Operating Manual §8 — `docs/FABLE_OPERATING_MANUAL.md`, "FOM" below).
3. Run `bash install.sh --closer-context --no-confirm`.
4. Verify the required MD5 parity set for the touched compiled files.
5. Update [prds/MASTER_PLAN.md](/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/prds/MASTER_PLAN.md) and any release/bookkeeping notes.
6. Commit and push manager-owned changes before optional `gh release create vX.Y.Z`.

## Gate heuristic

If the worker reports release-gate failures, verify whether they are pre-existing before reverting closer work. Cross-check the open findings ledger in `prds/MASTER_PLAN.md`; inherited failures should become handoff notes, not rollback triggers.

Deploy order (FOM §8): a rename/runtime-artifact bundle needs `bash install.sh` BEFORE the integration tier — the gate exercises the deployed binary, so a source-correct change red-fails through a stale deploy. When logic passes standalone but fails via a spawned binary, suspect stale-deploy first. Commit the recompile early: the integration tier can delete the compiled tree mid-run.

## Release Gate

When the closer must run the release gate, use **only** the canonical sequence from the `## Versioning` section of the repo `CLAUDE.md` — do not reconstruct it from memory or from this runbook; the canonical list is the single source of truth and this doc deliberately does not copy it.

**Never** invoke an expensive-tier test file directly via `node --test <path>`. The `npm run test:expensive` script gates on `RUN_EXPENSIVE_TESTS=1` and controls the skip path; bypassing it with a bare `node --test` runs the full 30-minute soak unconditionally and can produce a timeout → relaunch → re-soak infinite loop.

The correct invocation is always `RUN_EXPENSIVE_TESTS=1 npm run test:expensive`, with `PICKLE_INSTALL_ROOT` set off-`$HOME` — a ~29-second expensive run means the soak SELF-SKIPPED, not passed (FOM §2: silence is not success). Read the runner's real tests/pass/fail counts; never grep-filter the runner log into the answer you wanted.

## Recovery

If mux-runner did not stop cleanly:

1. Kill the tmux session for the closer.
2. Confirm no auto-resume loop is still active: `pgrep -af auto-resume`.
3. Only if needed, flip `state.active` to `false` after the session is fully stopped.

## Lockout protocol

After killing a closer session, do not start manager-owned edits until `auto-resume.sh` is confirmed absent. If manager work must proceed before that is certain, commit and push after each manager-owned step so a later rollback cannot erase unpushed work.
