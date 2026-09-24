# B-LANES — finer review lanes, run concurrently; delete the dead `--teams` mode (EXPERIMENTAL, branch `exp/b-lanes`)

**Step 2 of the parallelism plan** (`prds/MASTER_PLAN.md` → "PARALLELISM PLAN", operator-approved
2026-09-24). Evidence: `prds/research/2026-09-agent-systems-spike.md`. Two workstreams, bundled because both
land in the single `extension` review lane and would otherwise each pay the ~300-minute review toll.

## WS-1 — delete the dead `--teams` mode (subtraction; closes #43 on evidence)

**Measured 2026-09-24:**
- **Not parallel.** `extension/templates/_pickle-manager-prompt.md` Phase 3.B instructs "Per ticket
  (sequential — `state.max_parallel` is plumbed for a follow-up … today, treat as 1)". The `max_parallel`
  type comment (`extension/src/types/index.ts:61`) says "v1 ships sequential".
- **Not runnable.** The runner launches the manager with `claude -p` (`extension/src/services/backend-spawn.ts`,
  `args.push('-p', opts.prompt)`). In that mode, Claude Code 2.1.281 exposes no `TeamCreate`, `TeamDelete`,
  `TaskCreate`, `TaskUpdate`, `TaskList` or `Agent` tool, also with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
  (probe: first stream-json line of `claude -p "reply ok" --output-format stream-json --verbose --max-turns 1`,
  field `tools`).
- **Never used.** 0 of 13 session `state.json` files on disk carry `teams_mode: true`.

**Delete:**
- manager prompt Phase 3.B (`_pickle-manager-prompt.md`) and any other `state.teams_mode` branch in it;
- `setup.ts` `--teams` / `--max-parallel` parsing, validation, persistence and banner (`teamsMode`,
  `maxParallel`, `explicitFlags` handling, the `Teams:` banner line, the `:1787` branch);
- `teams_mode` / `max_parallel` from the `State` type (`types/index.ts:60-62`);
- `extension/src/bin/validate-teams-ticket.ts` (+ compiled `extension/bin/validate-teams-ticket.js`);
- `.claude/agents/morty-implementer.md`, `.claude/agents/morty-reviewer.md`;
- docs: `.claude/commands/pickle-tmux.md` "Teams Mode" section, `help-pickle.md`, `pickle-refine-prd.md`
  (its `/pickle-tmux --teams` mentions), `README.md`, `extension/CLAUDE.md`.

**Keep:** the strings `'teams_mode'` and `'max_parallel'` in `V3_STATE_SHAPE_MARKERS`
(`state-manager.ts:555-556`). They recognise the legacy v3 state shape, and old state files may still carry the
keys; after this change those keys are inert on read. The attractor `max_parallel` node attribute
(`dot-builder.ts`, `attractor-schema.fallback.ts`) is unrelated and stays.

**Retain:** the `morty-phase-*` agents and `extension/data/phase-personas.json`. `spawn-morty.ts`
(`readPhasePersonaEntry` / `readActivePersonaBlock`) still injects them as `## Active Persona`
*(refined: codebase c2–c3)*.

**CLI behaviour:** unknown arguments fall through to `taskArgs` (`setup.ts:820-832`), so removing the handlers
would silently turn `--teams` into task text. Keep **two tombstone `ARG_HANDLERS`** that fail at argument
parsing, with stderr naming the flag and `B-LANES`. No session directory is created. A legacy `state.json`
with `teams_mode: true` still resumes and exits 0. This is a launch-time error, not a mid-run halt.

**Also remove** *(refined: all analysts c3)*: the `teams_mode` INVARIANT bullet in `extension/CLAUDE.md`
(~`:498`; re-run the fast tier afterwards, since catalog counts are read there), the Module Export Catalog row in
`extension/src/bin/CLAUDE.md` (~`:268`), `COMMANDS.md` mentions, and subprocess-heavy baseline JSON keys for
deleted tests. Do not edit historical corpora under `extension/tests/fixtures/microverse-corpora/**`, or the
synthetic agent fixture in `tests/install-agent-overlay.test.js`.

**Semver:** root `CLAUDE.md` classifies CLI-arg removal as **Major**. The flags never had a working path
(0 sessions); the operator decides at release. There is no `LATEST_SCHEMA_VERSION` bump.

**Tests:** delete the files that exist only for teams mode (`tests/setup-teams.test.js`,
`tests/validate-teams-ticket.test.js`, `tests/pickle-md-teams-branch.test.js`,
`tests/integration/pntr-teams-tmux.test.js`) after confirming each tests nothing else. In the other files that
mention teams (`grep -rl "teams_mode\|--teams\|max-parallel\|validate-teams-ticket\|morty-implementer\|morty-reviewer\|Phase 3.B" extension/tests`),
remove only the teams cases. Update `tests/fixtures/setup/state-schema.json`.

**Deploy residue:** the agents deploy to `~/.claude/agents/.pickle-managed/` (`install.sh:652-688`, rsync without
`--delete`), and both files are present there on the authoring box. Remove them by adding them to the existing
`rm -f` stale-file lines in `install.sh` (the block near `:697`). Add no new mechanism.

## WS-2 — finer review lanes for ANY repo, not just this one

**Why (operator, 2026-09-24):** field runs on other repos show long anatomy-park and szechuan-sauce phases
**even when scoped to the branch**. All local measurements come from this repo building itself, so they
cannot confirm or deny that. The lane rule must therefore work for any language and layout. A
TypeScript-only trigger is not enough.

**Measured in this repo (biased corpus; context only):**
- `discoverSubsystems(<repo root>)` returns `[{"name":"bin","fileCount":3},{"name":"extension","fileCount":1268}]`.
- Unscoped runs: 34 and 50 passes on `extension` (996 and 1,962 min). Scoped runs: 2 passes and 1–20 min
  (6 sessions). *(refined: requirements c3; re-measured)*
- `v2.1.0..5fdd4262` touches 2 lanes, while its files spread across `extension/tests` (105),
  `extension/src/services` (30), `extension/src/bin` (17), `extension/src/hooks` (5), `extension/src/types` (4),
  `extension/src/lib` (2), `extension/scripts` (2) and top-level `bin` (3).
- `extension/tests` holds 662 source files directly at its top level; its 17 subdirectories hold the rest.

**Goal:** a lane that holds most of a repo's source is split into smaller lanes. The rule knows no language,
directory name or build tool by name. Workspace manifests (`subsystemRoots`, via `getWorkspacePackages`)
stay the first choice. The new rule applies when a flat reading still leaves one dominant lane.

**Lane record and membership (refined, round 2 — all three analysts):** a lane is `{ name, dir, excludes }`.
When a dominant lane `D` splits, each qualifying child `C` becomes `{ name: 'D/C', dir: 'D/C', excludes: [] }`,
and `D` becomes the remainder `{ name: 'D/.', dir: 'D', excludes: [qualifying children] }`. A tracked file
belongs to the lane whose `dir` contains it and whose `excludes` do not, **whatever its extension**:
`SOURCE_EXTS` only SIZES lanes, and never decides membership. **ONE membership function** serves every
consumer: `filterBySubsystem` (`scope-resolver.ts:468`, widened from `string[]` names to lane records),
`writeSkippedByScope`, `resolveAnatomySubsystems`, `buildAnatomyPrd` (which prints a remainder lane's
`excludes`) and the ledger keys. A remainder's `dir` is never `''` (`scope-resolver.ts:483` prefix `''` matches
everything).

**Split trigger:** repeatedly split a lane holding ≥ half of the target's non-generated source files, while it
has ≥ 1 qualifying child. Measured at `fbd0db74` (git ls-files == disk walk): `extension` = 1,268 source files
raw, **1,101** non-generated; `extension/tests` has **659** `SOURCE_EXTS` files at its top level (662 counted
`.mjs`, which discovery does not). The loose `extension/tests/.` lane (≈60%) has no children, so no directory
rule can split it: an accepted residual.

1. **Generated output is decided PER FILE, never per directory.** A tracked `R/<outDir>/<p>.js` is generated
   iff `R/<rootDir>/<p>.ts` exists, reading `tsconfig.json` with comments and trailing commas stripped; any read
   or parse failure means nothing is generated. At HEAD: exactly **167** generated files under `extension/`.
   Directory-level exclusion would drop 6 hand-written files (`bin/parse-coverage-exception.js`,
   `bin/replay-bundle-iter-stats.js`, `bin/_test-chmod-fixture.js`, `types/attractor-schema.js`,
   `scripts/audit-citadel-wiring.js`, `scripts/census-worker-gate-red-tests.js`). Generated files belong to
   **no lane**, including the remainder.
2. **Order: split first, test-only filter last, and only on roots.** The >80% test-only exclusion runs once
   per root returned by `subsystemRoots`, on counts that exclude generated files, and ONLY when the root is
   final (not split). Every lane produced by a split carries `testRatioApplies: false`. Measured reasons:
   re-applying the filter per child drops ~873 of 919 test files (`tests/.` 659/659, `tests/integration`
   123/127, …); and non-generated `extension` is 878/1,101 = 79.7% tests, 15 files from the cutoff, so
   filtering the parent before the split would drop the whole lane.
3. **Lanes never nest**, and names stay relative POSIX paths (`filterBySubsystem`, persisted per-lane state).
4. **Discovery stays total.** An unreadable manifest, config or directory degrades to today's reading.
5. **Catalog home.** Anatomy-park writes trap doors to "subsystem CLAUDE.md". `audit-trap-door-enforcement.sh`
   `CATALOG_ROOTS` sweeps `extension/src/*/CLAUDE.md` and top-level catalogs, and skips `extension/*`, so a new
   `extension/tests/CLAUDE.md` would never be verified. A lane without its own swept catalog writes to its
   nearest ancestor catalog. Workers never create a new lane `CLAUDE.md`. *(refined: all analysts c3)*
6. **Lane-less code is REPORTED, never silently green.** `empty_scope` stays outside
   `DEGRADED_PHASE_SKIP_REASONS`. `archive/skipped_by_scope.anatomy-park.json` gains `files_unmapped`: the
   in-scope paths with `isCodePath === true` that no lane admits (e.g. repo-root `install.sh` today). This
   reports only; it adds no halt and no skip reason.
7. **One copy of the rule.** `.claude/commands/anatomy-park.md` Step 3 (`:66-71`, "Do NOT descend further")
   and its Step 7 prose filter (`:134`) are the standalone path's copies. Replace both with a call to a new
   `resolve-scope.js --print-subsystems` mode that prints the filtered lane records. The prose and the bin
   change in the SAME ticket, so no deploy carries one without the other.
8. **szechuan-sauce is out of scope (measured).** It runs `microverse-runner` in metric mode with an LLM
   judge, and has no subsystem rotation (`pipeline-runner.ts:2855-2860`). Its long field runs are a
   follow-up, not part of this rule.

**Cost, stated not hidden:** a scoped run's minimum becomes 2 passes per lane touched, not 2 in total. An
unscoped run rotates every lane. The APNC ceiling (`PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN`) becomes per lane.

## WS-3 — run lanes concurrently, one worktree per lane

**Why:** finer lanes alone do not cut wall-clock. Lanes rotate sequentially, and a scoped run's minimum rises
from 2 passes in total to 2 per lane touched. The speedup exists only if lanes run at the same time
(operator decision 2026-09-24: build WS-2 and concurrency together).

**Measured constraints (single-checkout assumptions at HEAD; exploration 2026-09-24):**
- One lane rotation is driven by the worker (`anatomy-park.md` Override 1/5 advance `current_index`); the
  runner loop is serial (`executeMainLoop`, `microverse-runner.ts:6572`).
- Shared per-session files every pass writes: `anatomy-park.json` (the worker rewrites the whole object),
  `microverse.json`, `state.json.iteration`, `handoff.txt`, `gate/baseline.json`, `tmux_iteration_<n>.log`.
- Commit attribution uses `preIterSha..HEAD` (per-iteration gate, scope audit, complexity check).
- Workers stage with `git add -u`, and `autoRescueDirtyTree` commits whatever is dirty.
- Worker-side and runner-side test tiers would overlap; the repo already records load-induced reds
  (`extension/CLAUDE.md` R-TFP/R-TSPF, the `.serial-tests.json` manifests).

**Design (collapse the races instead of guarding each one):** each kept lane runs **today's single-lane
anatomy-park loop, unchanged**, in its own `git worktree` (pattern: `did-we-count-replay.ts:358-430`,
including its `node_modules` symlink) on a lane branch cut from the phase's start HEAD, with its own session
subdirectory holding its own `anatomy-park.json`, `microverse.json`, handoff, gate baseline and logs. Spawn and
kill lanes as detached process groups (pattern: `spawn-refinement-team.ts` `spawnAnalystProcess` /
`terminateWorkerProcess`). Nothing is shared at pass time, so no lock is added.

1. **Concurrency cap** `anatomy_max_parallel_lanes`, default **3** (research CAID knee 2–4), read from
   `pipeline.json` and set per run. With `1`, the phase behaves exactly as today (same code path as a
   single-lane run, in the main checkout).
2. **Integration:** when a lane converges, stalls or hits its ceiling, cherry-pick its commits onto the main
   working branch **one lane at a time**, in lane order. A conflicting lane's commits are left on its lane
   branch and reported (activity event plus `archive/lanes.json`); the phase CONTINUES. The known conflict
   source is shared catalogs (Constraint 5 sends trap doors from many lanes to `extension/CLAUDE.md`).
   Research must measure how often that conflicts on a replayed bundle and choose: append-only merge of
   catalog sections, or an integration step that re-applies catalog edits. Do not halt.
3. **Test-tier load:** lanes share one machine. Use the existing serial manifests and gate lock; research
   measures fast-tier wall-clock and red rate at 1 vs 3 concurrent lanes before picking the default.
4. **Aggregate result:** the phase converges when every lane has; `anatomy_non_convergent` stays non-fatal and
   per lane; the phase summary lists per-lane passes, wall-clock and integration outcome.
5. **Cleanup is total:** worktrees and lane branches are removed on success, failure and cancel
   (`git worktree prune`). A crashed run leaves nothing that blocks the next.
6. **Monitor:** the subsystem-watcher pane shows all active lanes (it reads one `current_subsystem` today).

## Acceptance criteria

Pin every reference diff to `v2.1.0..5fdd4262`; `HEAD` moves as the bundle lands.

1. **This repo splits.** `discoverSubsystems(<repo root>)` returns a roster onto which the reference diff's
   files map across ≥ 5 lanes (HEAD: 2). Research records the exact roster at breakdown and pins it.
2. **Full coverage.** Every source file of the reference diff outside generated output that still exists maps
   to exactly one lane under `filterBySubsystem`, including `extension/scripts/audit-citadel-wiring.js` and
   `extension/tests/*` (negative control: holds at HEAD).
3. **Generated per file.** Exactly 167 files under `extension/` are generated at HEAD. No lane admits
   `extension/bin/pipeline-runner.js` or `extension/scripts/check-scope-schema-parity.js` (HEAD: `extension`
   admits both). Each of the 6 hand-written files named in Constraint 1 maps to exactly one lane.
   Negative control: directory-level exclusion drops them.
3b. **Tests survive the split.** Lanes exist that admit `extension/tests/integration/*.test.js` and loose
   `extension/tests/*.test.js`, and neither is dropped for its test ratio (HEAD: both inside `extension`).
   Negative control: re-applying the ratio filter to split lanes reds this.
4. **Not TypeScript-specific.** Two fixture repos with no tsconfig and no workspace manifest, one
   Python-shaped (`app/` holding ≥ 90% of sources across ≥ 3 subpackages plus loose modules) and one
   Go-shaped (`internal/<pkg>/…`), each split into ≥ 3 lanes, with their loose top-level files in a lane.
   HEAD: 1 dominant lane each.
5. **Existing behaviour holds.** Every test file returned by
   `grep -rl 'discoverSubsystems\|filterBySubsystem\|resolveAnatomySubsystems' extension/tests` passes,
   including the test-only-exclusion cases for unsplit roots.
6. **Degrade.** A missing, malformed or JSONC build config returns a roster without throwing.
7. **Lane-less scope.** A scope of only `prds/x.md` returns `empty_scope` and emits
   `anatomy_park_empty_scope_skip` (HEAD: same). A scope of only `extension/templates/_pickle-manager-prompt.md`
   keeps the lane that admits it (HEAD: `[extension]`; no coverage reduction). A scope of
   `['install.sh','extension/src/bin/setup.ts']` records `files_unmapped: ['install.sh']` (HEAD: field absent).
8. **Catalog home.** `git ls-files 'extension/*/CLAUDE.md' | grep -v '^extension/src/' | wc -l` returns 0 after
   the bundle. Mutation control: adding `extension/tests/CLAUDE.md` makes it 1.
9. **Teams gone.** `grep -rln 'teams_mode\|teamsMode\|maxParallel' extension/src --include='*.ts' | grep -v state-manager.ts | wc -l`
   returns 0 (HEAD: 2); `.claude/agents/morty-implementer.md`, `.claude/agents/morty-reviewer.md`,
   `extension/src/bin/validate-teams-ticket.ts` and `extension/bin/validate-teams-ticket.js` are absent;
   `grep -c "Phase 3.B" extension/templates/_pickle-manager-prompt.md` returns 0 (HEAD: 1).
10. **Tombstones.** `setup.js --tmux --teams --task x` and `--max-parallel 3` each exit non-zero with stderr
    containing the flag and `B-LANES`, under a throwaway `HOME`, and create no session directory
    (HEAD: exit 0). Resuming a `state.json` with `teams_mode: true` exits 0.
11. **Deploy residue.** After `bash install.sh --prefix <tmp>` with a sandbox `HOME`, neither deleted agent
    file exists under the managed agents directory.
12. `cd extension && ./node_modules/.bin/tsc --noEmit` and `npx eslint src/ --max-warnings=0` exit 0; touched
    test files pass under Node 24 and `/opt/homebrew/opt/node@22/bin/node --test`.

13. **Concurrent lanes, fixture repo.** A fixture target with 3 disjoint lanes, each seeded with one defect
    a stubbed lane worker fixes and commits: with `anatomy_max_parallel_lanes: 3`, all three lanes run in
    separate worktrees at overlapping times (their recorded start/end intervals overlap), all three fixes land
    on the main branch, and no worktree or lane branch remains afterwards. With `1`, the same fixture runs
    lanes serially in the main checkout, as today.
14. **Conflict does not halt.** Two lanes whose commits both edit the same catalog line: one integrates, the
    other is reported in `archive/lanes.json` with its lane branch named, and the phase completes.
15. **One copy.** `grep -c "Do NOT descend further" .claude/commands/anatomy-park.md` returns 0 (HEAD: 1), and
    `node extension/bin/resolve-scope.js --print-subsystems` prints the lane records for the repo root.

**Revert and merge criterion (experimental branch):** the branch merges to `main` only on operator decision,
after deploying it from `exp/b-lanes` and running field or self bundles. The metric is **anatomy-park phase
wall-clock and findings fixed**, compared with runs of similar changed-file count (±25%). Pass count is NOT the
metric, because finer lanes raise it by construction. A session counts only if the deployed
`pipeline-runner.js` contains the lane membership function at its start (grep the deployed file).

## Simplification Review

- **WS-1:** subtraction. It removes a mode, two state fields, one bin, two agents, one prompt branch and four
  test files. It adds two tombstone flag handlers, because without them the removed flags would silently become
  task text.
- **WS-2:** reuses the root-splitting seam (`subsystemRoots`) and derives generated output per file instead
  of listing it. It adds one rule that knows no language by name, and ONE membership function replaces the
  name-prefix matching. The benefit is an operator field report, not a measurement.
- **WS-3:** reuses the unchanged single-lane loop, the existing worktree pattern and the refinement
  process-group pattern. Isolation per lane removes every shared-file race instead of adding a lock per race.
  It adds one setting (`anatomy_max_parallel_lanes`) and an integration step.

## Risks

- **More lanes, more rotation overhead.** Each lane pays at least one pass. Lanes outside the scope diff are
  skipped (`filterBySubsystem`), so an idle lane costs nothing. Record per-lane passes on the next bundles
  (experiment E1).
- **Changes to compiled files are still in the diff.** They belong to no lane after the split; their source is
  reviewed instead. Confirm that anatomy-park's scope handling does not treat a lane-less changed file as an
  error.
- **Semver.** Removing `--teams` / `--max-parallel` is a CLI change. The flags never had a working path
  (0 sessions used them); the operator decides patch vs major at release time.

## Out of scope

Concurrent anatomy-park lanes (plan step 3); a parallel build; changing szechuan-sauce partitioning.
