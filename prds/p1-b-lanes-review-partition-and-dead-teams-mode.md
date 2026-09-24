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

**Candidate rule (refinement may improve it, but must keep the constraints):** repeatedly replace a lane
that holds ≥ half of the target's source files with (i) a lane per qualifying child directory and (ii) one
lane for the source files sitting directly in that directory, when there are any. Stop when no lane
qualifies or the lane has no qualifying children.

**Constraints (measured; each needs a test):**
1. **Generated output is not a lane.** Untracked output (`dist`, `build`, …) is already skipped by
   `EXCLUDED_DIRS`. This repo also TRACKS its compiled output: `extension/tsconfig.json` has `rootDir: "src"`,
   `outDir: "."`, so `extension/{bin,services,hooks,lib,types}` mirror `extension/src/*`. Derive mirrors from
   build config where present, and never from a directory-name list. Refinement cycle 3 measured two
   derivations: "`R/<rootDir>/<c>` exists" wrongly makes `extension/scripts` (47 hand-written audit files) a
   mirror; "`c` is a lane of `discoverSubsystems(R/<rootDir>)`" gives the right set. That second one has a
   floor coupling: 3 source files in `src/scripts` would flip `extension/scripts` to a mirror. Pin it with a test.
2. **No reviewed source file drops out.** Every changed source file outside generated output maps to exactly
   one lane. The >80% test-only exclusion must not drop the tests of a split lane. Carry a per-root flag
   (e.g. `{ dir, testRatioApplies }`) rather than special-casing a name. Five `pipeline-runner.test.js` cases pin
   the exclusion for unsplit roots and stay green. *(refined: codebase c3)*
3. **Lanes never nest**, and names stay relative POSIX paths (`filterBySubsystem`, persisted per-lane state).
4. **Discovery stays total.** An unreadable manifest, config or directory degrades to today's reading.
5. **Catalog home.** Anatomy-park writes trap doors to "subsystem CLAUDE.md". `audit-trap-door-enforcement.sh`
   `CATALOG_ROOTS` sweeps `extension/src/*/CLAUDE.md` and top-level catalogs, and skips `extension/*`, so a new
   `extension/tests/CLAUDE.md` would never be verified. A lane without its own swept catalog writes to its
   nearest ancestor catalog. Workers never create a new lane `CLAUDE.md`. *(refined: all analysts c3)*
6. **Lane-less scope.** A scope that touches only non-source files (templates, docs, JSON) resolves as it does
   for `.claude/` and `prds/` today: the existing `empty_scope` skip plus its `anatomy_park_empty_scope_skip`
   event. No fallback and no new skip reason.
7. **Both copies of the rule change together.** `.claude/commands/anatomy-park.md` Step 3 (`:66-71`,
   "immediate subdirectories … Do NOT descend further") is the standalone path's copy. It must run the compiled
   discovery, or state the same rule, so pipeline and standalone runs discover the same lanes.
8. **szechuan-sauce** partitioning: research must state whether it shares this discovery. If it does, the
   change covers it; if not, record where its unit comes from as a follow-up. Do not build a second rule.

**Cost, stated not hidden:** a scoped run's minimum becomes 2 passes per lane touched, not 2 in total. An
unscoped run rotates every lane. The APNC ceiling (`PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN`) becomes per lane.

## Acceptance criteria

Pin every reference diff to `v2.1.0..5fdd4262`; `HEAD` moves as the bundle lands.

1. **This repo splits.** `discoverSubsystems(<repo root>)` returns a roster onto which the reference diff's
   files map across ≥ 5 lanes (HEAD: 2). Research records the exact roster at breakdown and pins it.
2. **Full coverage.** Every source file of the reference diff outside generated output that still exists maps
   to exactly one lane under `filterBySubsystem`, including `extension/scripts/audit-citadel-wiring.js` and
   `extension/tests/*` (negative control: holds at HEAD).
3. **No mirror lanes**, derived (the test may list `extension/{bin,services,hooks,lib,types}`).
4. **Not TypeScript-specific.** Two fixture repos with no tsconfig and no workspace manifest, one
   Python-shaped (`app/` holding ≥ 90% of sources across ≥ 3 subpackages plus loose modules) and one
   Go-shaped (`internal/<pkg>/…`), each split into ≥ 3 lanes, with their loose top-level files in a lane.
   HEAD: 1 dominant lane each.
5. **Existing behaviour holds.** Every test file returned by
   `grep -rl 'discoverSubsystems\|filterBySubsystem\|resolveAnatomySubsystems' extension/tests` passes,
   including the test-only-exclusion cases for unsplit roots.
6. **Degrade.** A missing, malformed or JSONC build config returns a roster without throwing.
7. **Lane-less scope.** `resolveAnatomySubsystems` with only `extension/templates/_pickle-manager-prompt.md`
   in scope returns `empty_scope` and emits `anatomy_park_empty_scope_skip`.
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

**Revert criterion (WS-2 lands as one behavioural commit):** on the next two field or self bundles with
≥ 20 changed source files, revert if total anatomy passes rise above the pre-change run of comparable size
without more findings fixed.

## Simplification Review

- **WS-1:** subtraction. It removes a mode, two state fields, one bin, two agents, one prompt branch and four
  test files. It adds two tombstone flag handlers, because without them the removed flags would silently become
  task text.
- **WS-2:** reuses the existing root-splitting seam (`subsystemRoots`) and derives generated output instead
  of listing it. It adds one rule that knows no language by name. The benefit is an operator field report,
  not a measurement; the revert criterion keeps it honest.

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
