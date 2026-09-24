# B-LANES — review lanes one level deeper; delete the dead `--teams` mode

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

**CLI behaviour:** `setup.js --teams` / `--max-parallel` now fail at argument parsing with a message that names
the removal and points to this PRD. That is a launch-time error, not a mid-run halt.

**Tests:** delete the files that exist only for teams mode (`tests/setup-teams.test.js`,
`tests/validate-teams-ticket.test.js`, `tests/pickle-md-teams-branch.test.js`,
`tests/integration/pntr-teams-tmux.test.js`) after confirming each tests nothing else. In the other files that
mention teams (`grep -rl "teams_mode\|--teams\|max-parallel\|validate-teams-ticket\|morty-implementer\|morty-reviewer\|Phase 3.B" extension/tests`),
remove only the teams cases. Update `tests/fixtures/setup/state-schema.json`.

**Deploy residue:** `install.sh` copies `.claude/agents/*.md` into `~/.claude/agents` without `--delete`
(`install.sh:652-688`). Research must measure whether a deploy leaves the two deleted agent files behind. If
it does, remove them through whatever stale-file cleanup `install.sh` already has; if there is none, record
it as a residual and do not add a new mechanism.

## WS-2 — review lanes one level deeper

**Measured 2026-09-24:** `discoverSubsystems(<repo root>)` returns `[{"name":"bin","fileCount":3},{"name":"extension","fileCount":1268}]`.
The worst measured bundle spent 34 anatomy-park passes / 995 min on the single `extension` lane. The
`v2.1.0..HEAD` diff touches **2** lanes, although its files spread across `extension/tests` (105 files),
`extension/src/services` (30), `extension/src/bin` (17), `extension/src/hooks` (5), `extension/src/types` (4),
`extension/src/lib` (2), `extension/scripts` (2) and top-level `bin` (3).

**Goal:** a large root is split into its real units, without a hand-maintained directory list.
`subsystemRoots` (`pipeline-runner.ts`) already does this for workspace monorepos. Extend the same idea to a
flat repo whose one top-level directory holds the whole codebase. Rotation stays sequential. Concurrent
lanes are step 3 of the plan and out of scope here.

**Constraints the rule must satisfy (measured):**
1. **Compiled mirrors are not lanes.** `extension/tsconfig.json` has `rootDir: "src"`, `outDir: "."`, so
   `extension/bin`, `extension/services`, `extension/hooks`, `extension/lib` and `extension/types` are tracked
   build output of `extension/src/*`. Reviewing them as lanes duplicates review and invites fixes to generated
   files. Derive them from the tsconfig (`outDir` + the children of `rootDir`); do not list them.
2. **No reviewed file drops out.** Today every changed file under `extension/` is in some lane. The existing
   test-only exclusion (>80% test files, `discoverSubsystems`) would drop `extension/tests` (875 of 1,135
   tracked files are `*.test.js`) if it became its own lane. Test changes are reviewed today and must stay
   reviewed.
3. **Lane names stay relative paths with POSIX separators**, so `filterBySubsystem` and the persisted
   anatomy-park per-lane state (`pass_counts`, `consecutive_clean`) keep resolving.
4. **Discovery stays total.** An unreadable tsconfig or directory degrades to today's reading; it never
   throws.

## Acceptance criteria

1. **Deeper lanes.** The files changed in `git diff --name-only v2.1.0..HEAD` (at this PRD's commit) map
   onto **≥ 5** lanes of `discoverSubsystems(<repo root>)` (measured at HEAD: 2).
2. **Full coverage.** Every file in that diff under `extension/src/` or `extension/tests/` maps to exactly one
   lane. This is a negative control: it holds at HEAD, and a correct fix must keep it.
3. **No mirror lanes.** None of `extension/bin`, `extension/services`, `extension/hooks`, `extension/lib`,
   `extension/types` is a lane. The test may list them; the implementation must derive them.
4. **Flat and workspace repos unchanged.** Existing `discoverSubsystems` / `subsystemRoots` tests pass
   unchanged (`tests/anatomy-park-resolveSubsystems-bin.test.js`, `tests/scope-filters.test.js`,
   `tests/anatomy-park-scope.test.js`, `tests/pipeline-runner.test.js`).
5. **Teams gone.** `grep -rln 'teams_mode\|teamsMode\|maxParallel' extension/src --include='*.ts' | grep -v state-manager.ts | wc -l`
   returns 0 (HEAD: 2); the three files `.claude/agents/morty-implementer.md`, `.claude/agents/morty-reviewer.md`,
   `extension/src/bin/validate-teams-ticket.ts` do not exist; `grep -c "Phase 3.B" extension/templates/_pickle-manager-prompt.md`
   returns 0 (HEAD: 1).
6. **CLI.** `node extension/bin/setup.js --tmux --teams --task x` exits non-zero with a message containing
   "removed" (HEAD: exit 0, no such message; run with a throwaway `HOME`).
7. `cd extension && ./node_modules/.bin/tsc --noEmit && npx eslint src/ --max-warnings=0` exits 0; touched
   test files pass under Node 24 and `/opt/homebrew/opt/node@22/bin/node --test`.

## Simplification Review

- **WS-1:** pure subtraction. It removes a mode, two CLI flags, two state fields, one bin, two agents, one
  prompt branch and four test files, and adds nothing.
- **WS-2:** reuses the existing root-splitting seam (`subsystemRoots`) and derives the mirror set from the
  build config instead of listing it. It adds one rule. The cost it removes is measured: 34 serial passes on
  one lane.

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
