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

## Merge criterion (experimental)

At least 3 field runs with `max_parallel_tickets: 2`. Median pickle-phase wall-clock is ≥ 25% lower than comparable
field runs (use `field-timing.py`), with tickets Done not lower and no increase in failed or halted runs. The operator decides.

## Simplification Review

Reuses the lane machinery instead of adding a second concurrency system. It adds a scheduler (one predicate over
declared files) and one state field. The default path is untouched.

## Out of scope

Concurrent review lanes (B-LANES, done); refinement parallelism; any change to the worker lifecycle itself.
