# B-PBUILD — run file-disjoint build tickets concurrently (#43) — EXPERIMENTAL, branch `exp/b-parallel-build`

**Operator decision (2026-09-26):** build #43 on an experimental branch. It is cut from `exp/b-lanes`
(`v2.2.0-beta.1`) to reuse the lane machinery. It is not merged or deployed until measured on field runs.

## Why — field evidence (operator, `prds/research/tools/field-timing-results-2026-09-26.md`)

- In 3 field pipeline runs the build (pickle) phase is **74% of wall-clock** (600 of 811 min), at 20–27 min per
  ticket, one ticket at a time. Review phases are small by comparison (anatomy 13–57 min, szechuan 6–37 min).
- Build parallelism has a measured ceiling in this repo's history: file-disjoint "waves" give a median best-case
  **~1.5–2×** on the build share, and never more than 3× (spike report §3). On a 4-hour build that is 1–2 hours.
- Declared file lists are a safe scheduling input (spike report, gap 6): median recall 1.00, and they OVER-declare
  (precision 0.80). Undeclared touches were only tests, `.claude/**` prompts and `CLAUDE.md` catalogs, never source.
  0 of 11 same-wave pairs overlapped in actual diffs.
- External evidence (spike report #43): the knee is at 2–3 concurrent writers. Coordination/merge cost grows with
  N; agents on separate real PRs interfered 1 time in 834. **Start at 2.**

## What already exists to reuse (on this branch, `extension/src/services/anatomy-lanes.ts`)

Per-unit sibling session dirs (`laneSessionDir`), a worktree per unit on its own branch (`createLaneWorktree`,
`laneBranchName`), `node_modules` symlinking, a narrowed `scope.json` per unit, runner env with `PICKLE_STATE_FILE`
so the R-WSRC hooks resolve (`laneRunnerEnv`), one aggregated verdict (`aggregateLaneExitReason`), integration on a
throwaway integration worktree (cherry-pick in order, typecheck, ff-only; `integrateLanes`), branch retention via `-d`
only (`releaseLaneBranches`), and crash recovery (`recoverLaneBranches`). **Reuse them. Generalise "lane" to "unit"
where needed; do not write a second copy.**

## Design (refinement confirms and details)

1. **Scheduler: waves from declared files.** Among pending tickets, in `order`, a ticket joins the current wave iff its
   declared "Files to modify/create" set is disjoint from every ticket already in the wave, after normalising
   compiled mirrors to their source. **Shared files are treated as overlapping everything:** `CLAUDE.md` catalogs and
   `.claude/**`. A ticket with no parseable file list runs alone. Hardening/audit tickets declare the whole modified
   set, so they serialise naturally, with no name list. The wave size is capped by `max_parallel_tickets`.
2. **Execution:** each ticket in a wave runs its normal worker lifecycle in its own worktree, sibling session and
   narrowed scope, via the reused lane machinery. Worker gates and commits happen in the ticket's worktree.
3. **Integration:** when a wave ends, integrate the finished tickets' commits in `order` on the integration worktree
   (cherry-pick, typecheck, ff-only), exactly as lanes do. A conflicting or integration-red ticket is **re-queued to
   `Todo`**, to re-run on the new HEAD in a later wave. It is not failed, and the run continues. Its branch is retained,
   and the retry count is bounded by the existing per-ticket recovery budget.
4. **State:** "the current ticket" becomes a set of in-flight tickets. Keep `state.current_ticket` meaning "the
   lowest-order in-flight ticket" so existing readers keep working (B-CURTIX made it derivable from frontmatter),
   and add the in-flight set as ONE new field. Research decides whether this is a schema bump; if it is, a
   schema-migration ticket follows the R-WSRC rules.
5. **Knob:** `max_parallel_tickets` in `pipeline.json`, default **1** = today's code path unchanged in the main checkout.
6. **Cancel, verdict, hooks:** reuse the lane versions: parent `active=false` mirrored into every unit, one
   verdict, `PICKLE_STATE_FILE`.

## Refined design (refinement cycle 3, 2026-09-27) — SUPERSEDES Design §1–§4 above where they differ

Session `2026-09-26-2937549d`, all three analysts concurring. Measured at `exp/b-parallel-build@5bf1852a`.

1. **Eligibility is opt-in, not inferred.** A ticket may share a wave only if its frontmatter has `parallel_safe: true`.
   The refinement template stamps it on implementation tickets only, never on Wire/Harden/Audit closers. `order` stays
   the dependency graph; Dependencies prose is never parsed. Reason: 32/70 live tickets are tail closers, 30/32 carry no
   Dependencies line, and several are file-disjoint from what they depend on, so a disjointness-only rule co-schedules
   a Wire ticket with the code it wires. Absent marker = today's serial behaviour, so legacy tickets are safe.
2. **Wave rule.** From pending tickets in `order`: the lowest pending ticket starts the wave. If it is not eligible, the
   wave is that ticket alone. Otherwise add following tickets while each is eligible and its `readDeclaredFiles` set does
   not overlap a member, up to the cap; stop at the first that fails. Overlap: compiled mirrors normalised to source; a
   `/`-terminated token contains its prefix; a slash-less token matches by basename; an empty list, `CLAUDE.md` or
   `.claude/**` overlaps everything.
3. **Two execution paths, chosen per run.** `max_parallel_tickets < 2` (default 1): `executePhaseRunner` byte-for-byte
   as today. `≥ 2`: EVERY wave, including a wave of one, runs as unit sessions (mux-runner has no single-ticket mode;
   the manager takes the lowest-order non-Done ticket).
4. **Unit session.** Dir `<session>--unit-<ticketId>`; worktree `<unitDir>/wt` on branch
   `pickle-lane/<session>/unit-<ticketId>` at the wave-start sha (both inside `recoverLaneBranches`' prefixes, and
   disjoint from anatomy's numeric lanes). State is seeded through the PICKLE transition (`enterPicklePhase` + step
   stamping, not `resetStateForPhase`), then overwritten: `working_dir`, `session_dir`,
   `start_commit = pinned_sha = <wave sha>`, `pinned_branch = <unit branch>`. The parent's `scope.json` is copied
   unchanged. Only this ticket's dir plus `prd.md`/`prd_refined.md` are copied. It runs `mux-runner.js <unitDir>` with
   `laneRunnerEnv`, registered in `laneChildren` under the ticket id.
5. **Heartbeat watches the unit.** `SpawnRunnerOpts` gains an optional `sessionDir`, which
   `armPhaseChildMuxRunnerHeartbeat` prefers over `phaseRunnerContext.sessionDir`. Without it, every unit running more
   than `child_mux_runner_stall_seconds` (1800) is SIGTERMed, because the parent dir is idle during a wave.
6. **Wave end.** The barrier waits for every member, including a rate-limit-parked one: this is an accepted cost at
   cap 2. Worktrees are removed, then Done members are integrated in `order` via `integrateLanes`. Write-back runs for
   EVERY member: an integrated member → parent ticket `Done` + `completion_commit` = the integrated sha; any other →
   parent `Todo`.
7. **Re-queue is bounded by construction.** A member that conflicts or reds integration is re-queued once, and its
   next wave is a wave of one from current HEAD. Its second outcome is final under serial rules. This does not use
   `recovery_attempts`.
8. **Zero-progress fallback (list-free loop bound).** A wave that integrates zero tickets and marks none terminal ends
   parallel mode for the phase. The remaining tickets run through serial `executePhaseRunner`, and the log names the
   fallback with each member's reason.
9. **Crash and cancel.** At phase entry, before wave 1, any live unit runner from a prior run is SIGTERMed and awaited,
   and `recoverLaneBranches` prunes unit worktrees and renames unmerged unit branches aside. Parent `active=false` is
   mirrored into every unit, as lanes do.
10. **Concurrent worker gates are accepted.** The worker spawn lock wraps the whole worker, so re-keying it would remove
    all parallelism. Each unit's gate runs in its own worktree. The in-flight unit count is logged with every wave.
11. **No schema change.** `state.current_ticket` keeps its meaning in the parent. In-flight tickets are derived from the
    parent's `In Progress` rows, and no new state field is added.

## Risks (accepted for the experiment)
R1 concurrent gates (CPU / `ps`-scanning cross-talk; logged). R2 the corpus is this repo's. R3 monorepo `node_modules`
deeper than depth 1: integration typecheck `unavailable` is logged per wave. R4 manifest/lockfile tickets: the template
withholds `parallel_safe`. R5 a parked unit holds the barrier. R6 deploy isolation: this branch is never deployed
without the operator. Before any field run, grep the deployed `pipeline-runner.js` for `max_parallel_tickets`; revert
with `install.sh` from the soak branch. R7 N× iteration budget at cap 2 is accepted.

## Acceptance criteria (refinement measures each at branch HEAD before breakdown)

1. **Default unchanged:** with `max_parallel_tickets` absent, a 3-ticket fixture runs serially in the main checkout,
   and existing mux-runner tests pass.
2. **Waves:** 3 tickets with disjoint declared files plus 1 overlapping, with cap 2 → waves of {A,B} then {C,…}. The
   overlapping ticket never shares a wave with its overlap; a ticket with no file list runs alone; a ticket declaring a
   `CLAUDE.md` never shares a wave.
3. **Concurrency observed:** in the fixture, wave members' worker intervals overlap, and all commits land on the working
   branch by fast-forward.
4. **Conflict re-queues, never halts:** two tickets whose actual diffs collide despite disjoint declarations → one
   integrates; the other is reset to `Todo` and completes in a later wave; the run completes.
5. **Cancel:** parent `active=false` → every unit stops, and no worktree remains.
6. `tsc --noEmit`, eslint, and the touched tests pass under Node 24 and Node 22.

## Merge criterion (experimental) — restated 2026-09-27 (operator decision)

Refinement measured a structural ceiling: at cap 2 with PERFECT disjointness, 70 live tickets form 55 waves (1.27×),
because the template's Wire/Harden/Audit closers (32/70) must run serially at the tail. A whole-bundle ≥25% cut is
unreachable by arithmetic. **The criterion is therefore scoped to the implementation sub-phase:**

At least 3 field runs with `max_parallel_tickets: 2` in which at least one wave had 2 members. Median wall-clock from
the first to the last IMPLEMENTATION ticket (`parallel_safe: true`) reaching Done is ≥ 25% lower than comparable
serial field runs. Whole-pickle-phase wall-clock is reported, not scored. Safety, read from `pipeline-runner.log`
(not `state.json`): pickle-phase Failed+Skipped not above baseline, no pickle-phase halt `exit_reason`, and every
`child_mux_runner_wedge_detected` or parallel-fallback event explained in the run report. The anatomy finalize-gate
result is excluded (it failed 3/3 at baseline). Evidence tool: `field-timing.py` at `main@78d861a7`. The operator decides.

## Simplification Review

Reuses the lane machinery instead of adding a second concurrency system. It adds a scheduler (one predicate over
declared files) and one state field. The default path is untouched.

## Out of scope

Concurrent review lanes (B-LANES, done); refinement parallelism; any change to the worker lifecycle itself.
