# B-ATTRIB-L — lanes measure their own work and never strand it silently (#53, lane half; `exp/b-lanes`)

Refinement: session `2026-10-01-e8b44a10`, 3 analysts × 3 cycles, read at `exp/b-lanes@266152d4`. The general half
(B-ATTRIB-G: G1 baseline-unmeasured predicate, G2 sweep replay at `start_commit`, D2 unmeasured withholds success)
lands on `main` first and merges down before this bundle runs. This PRD depends on G2's replay base and on D2.

## Field incident (numbers only)

An anatomy-park lane in a pnpm monorepo committed 3 CRITICAL fixes, then passed clean 4 times. It was ended
`no_progress`, and its commits were never integrated:
- its `archive/lanes.json` row said `"commits": []`;
- the summary said `3/4 phases`.

The lane's iteration-1 baseline had 12,534 typecheck errors before its first edit, because the lane worktree had no
workspace `node_modules`.
- 2,206 of the errors were in files changed by EARLIER pipeline phases. That count comes from filtering baseline
  failures to `start..fork` changed files.
- 23 were in files the lane touched.

## Decisions

- **D-L1.** Only the `createLaneSession` seed literal changes `start_commit`. Sequential phases keep the pipeline
  base by design (non-goal). `pinned_sha` is not changed, because no lane consumer reads it.
- **D-L2 — whole-phase serial fallback, not per-lane refusal (deliberately departs from the analysts'
  refuse-and-disclose).**
  - The depth-1 node_modules linker is a property of the REPO LAYOUT. In a pnpm workspace it fails for every lane
    alike.
  - Per-lane refusal therefore refuses every lane (`notStarted(LANE_NO_VERDICT)`). No code path reviews those
    slices, so anatomy-park covers NOTHING in exactly the repos the operator runs in production.
  - The serial path already exists and runs in the main checkout, which has the dependencies. Choosing it at the
    dispatch site is one predicate, not new machinery.
- **D-L6.** The integration check is compared against the integration worktree's own state at `phaseStartSha`.
  Fingerprints are absolute paths, so a lane baseline cannot be reused there. A target that is already red at base
  cannot arbitrate a pick: it reads `unavailable` and is disclosed. With D2 from B-ATTRIB-G, that withholds success.
- **D-R7.** Kept lane branches are force-deleted after 14 days by ANY later lanes run (`recoverLaneBranches`,
  `anatomy-lanes.ts`). The run summary states the expiry date. The expiry rule itself is unchanged (non-goal).

## Requirements

### L1 — a lane's attribution base is its fork sha (tier: medium)

- **Change.** In `createLaneSession` (`bin/pipeline-runner.ts` ~`:1959`), the seed literal gains
  `start_commit: phaseStartSha`. `phaseStartSha` is already a parameter. `resetStateForPhase` is untouched.
- **ACs.**
  - (a) A lane fixture with ≥ 2 commits between the pipeline base and the phase start sha gives
    `sm.read(lane.statePath).start_commit === phaseStartSha`. At HEAD it equals the pipeline base, so this reds.
  - (b) The parent's `start_commit` is unchanged.
  - (c) A fork followed by an internal-only edit makes the sweep return `ran:false, skipped:null`.
  - (d) A fork followed by an exported-declaration change makes the sweep run (`ran:true`).

### L2 — lanes run only where lane worktrees can reproduce the checkout's dependencies (tier: medium)

- **Predicate.** At the dispatch site in `runConfiguredPhase` (where `readAnatomyLanes` + `runAnatomyLanes` are
  chosen), compute two things:
  - the `node_modules` directories present in the target's main checkout (a bounded walk, depth ≤ 3, never
    descending into a `node_modules`);
  - what `symlinkLaneNodeModules` would link into a lane worktree, as a dry computation with no worktree created.

  If the first set is not covered by the second, lanes are not used for this phase. `executePhaseRunner` runs
  unchanged, and the log says
  `anatomy lanes: disabled for this phase — lane worktrees cannot reproduce N node_modules dir(s); running serially`.
- **No tool list.** The predicate needs no package-manager list: it compares what exists with what the linker
  reproduces.
- **ACs.**
  - A hand-built workspace fixture (root `node_modules` plus `packages/a/node_modules`; no install, no network) with
    `anatomy_max_parallel_lanes: 2` and ≥ 2 lanes runs the serial path. Assert that the serial runner was invoked with
    the parent session dir, and that no `<session>--lane-*` dir exists. At HEAD it runs lanes, so this reds.
  - Negative control: a single-package fixture with only a root `node_modules` still runs lanes.

### L6 — a target already red at the phase start sha does not red every pick (tier: medium)

- **Change.** `integrateLanes` (`services/anatomy-lanes.ts`) runs `runIntegrationTypecheck(targetDir)` ONCE, before
  the pick loop, in the integration worktree at `phaseStartSha`.

  | Pre-pick at base | Post-pick | `integration_check` | Outcome |
  |---|---|---|---|
  | green | green | `green` | `integrated` |
  | green | red | — | `integration_red`, retained (negative control) |
  | red | any | `unavailable` | `integrated`, disclosed via the existing `discloseUnmeasuredIntegration` |
  | unrunnable | — | `unavailable` | as today |

- **Cost bound.** One extra capped typecheck per phase, never per lane.
- **ACs.** A single-package fixture red at base, with a lane editing an unrelated file, ends `integrated` with
  `integration_check: 'unavailable'` and `cap_unmeasured_checks` ⊇ `['integration_typecheck']`. At HEAD it ends
  `integration_red`. A green-at-base fixture plus a lane that adds an error still ends `integration_red`.

### L4 + L5 + R7 — stranded work is listed, named, dated, and its environment recorded (tier: medium)

- **L4 — commits for every lane.** `archive/lanes.json` `commits` lists each lane's actual commits whatever its
  outcome. Compute non-integrating lanes' commits in `integrateLaneRun` (`bin/pipeline-runner.ts`) with the same
  `rev-list <phaseStartSha>..<branch>`. **Leave `integrateLanes`' input untouched**: its early return and pick loop
  key on commit-list length, so feeding non-integrating lanes' commits there would PICK them.
- **Summary line.** After `Pipeline finished:`, one line per retained lane branch that has commits:
  `kept lane branch <branch>: <n> commit(s), outcome <outcome>, exit <exit_reason> — <subject>; … (+<m> more) —
  recover before <ISO date> (deleted by any later lanes run after 14 days)`.
  - Subjects are capped at 5 and come from `git log -1 --format=%s <sha>`. A failed lookup prints the sha.
  - The date is the tip committer date + `RETAINED_BRANCH_MAX_AGE_DAYS`.
  - The data source is `archive/lanes.json`.
- **L5 — environment manifest.** Two fields on each `LaneOutcome` row:
  - `node_modules_linked: string[]` (the return value `createLaneSession` currently discards);
  - `baseline_check_status` (the lane's iteration-1 `gate/baseline.json` `check_status`, or `null`).

  A write failure logs and continues.
- **ACs.**
  - 0 integrating lanes and 1 non-convergent lane with 2 commits gives:
    - `lanes.json[i].commits.length === 2` and `outcome === 'non_convergent'`;
    - main HEAD unchanged, and no `…/integration` branch created;
    - exactly one `kept lane branch` line naming the branch, `2 commit(s)` and a `recover before` date.

    At HEAD `commits` is `[]`, so this reds.
  - Control: an `integrated` lane produces no such line.
  - A cancelled lane with commits also gets its line.

### L3 — end-to-end (tier: large; `zero_diff_intent: already-satisfied` if L1/L6/L4 and B-ATTRIB-G cover it)

One non-workspace fixture covering:
- an error in a file an earlier phase changed;
- a pre-existing error in a lane-touched file;
- a lane commit changing an exported declaration.

The lane ends either `outcome: integrated`, or with its commits listed, a `kept lane branch` line and a non-halting
reason. In no case is it `no_progress` caused by pre-existing errors. Assert `computePipelineVerdict(...).unsuccessful`
per D2.

## Non-goals

- Resetting `start_commit` for sequential phases.
- Linking workspace `node_modules` into lanes (a follow-up that would let monorepos use lanes).
- Changing `RETAINED_BRANCH_MAX_AGE_DAYS`.
- Per-package `check_status`.
- Any new halt, verdict channel or gate leg (0 new legs).

## Simplification Review

1. **Necessary?** Yes. Verified work was discarded silently.
2. **Reuse:** the serial phase path (L2), `discloseUnmeasuredIntegration` (L6), `rev-list` as `laneCommits` uses it
   (L4), and the linker's existing return value (L5).
3. **Brittle guard addressed:** the integration check's verdict on a red-at-base tree.
4. **Subtraction:** lanes are switched off where they cannot measure, rather than guarded inside every lane.
