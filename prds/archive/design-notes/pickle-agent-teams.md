# Pickle Agent Teams PRD

Replace `/pickle`'s subprocess-based Morty spawn (`spawn-morty.js` calling `claude -p`) with the Claude Code harness's native team primitives (`TeamCreate` / `Agent` with `team_name` / `SendMessage` / `TaskCreate`+`TaskUpdate`) when running on the claude backend.

## Problem

**Current Process**: `/pickle` Phase 3 orchestrates one ticket at a time by shelling out to `node spawn-morty.js`, which `spawn`s `claude -p` as a subprocess and watches its log file for a `<promise>I AM DONE</promise>` token plus a non-trivial log size plus a lifecycle artifact.

**Users**: Anyone running `/pickle <task>` against a multi-ticket epic on the claude backend.

**Pain Points**:
1. **~400 LOC of subprocess plumbing in `spawn-morty.ts`** — pipe management, hang guards, log-flush race handling, ghost-ticket validation, `WORKER_DONE` token sniffing. Five separate hardening passes (see `extension/CLAUDE.md` trap doors) and the class still bites.
2. **No bidirectional comms** — manager can't ask the worker a clarifying question; the only feedback channel is the log file post-mortem.
3. **Sequential ticket execution** — even when tickets are independent, `pickle.md` Phase 3 processes them one at a time because each spawn blocks until exit.
4. **Brittle completion signal** — Morty must emit a literal token AND produce >200B of log AND drop a lifecycle artifact, or the ticket gets marked Failed even when the work succeeded (see `feedback_morty_validation_log_heuristic.md`).

**Importance**: `spawn-morty.js` is a trap-door surface; every code path that talks to `claude -p` is a potential silent-failure class. The harness now exposes first-class agent/team primitives that make most of this scaffolding redundant.

## Goal

`/pickle --teams <task>` runs a complete epic against the claude backend using `TeamCreate` + `Agent` + `TaskUpdate` + `SendMessage` instead of `spawn-morty.js`, with the same 8-phase ticket lifecycle and the same lifecycle-artifact validation, and the legacy spawn path remains intact for the codex backend and for users who don't pass the flag.

## Scope

**Objective**: Add an opt-in `--teams` execution path to `/pickle` that uses harness-native team primitives for worker spawning on the claude backend.

**Done looks like**: A user can run `/pickle --teams "build feature X"` against a 3-ticket PRD and the epic completes with three `morty-implementer` teammates spawned via the `Agent` tool, each ticket marked Done, all lifecycle artifacts present, and zero invocations of `spawn-morty.js`.

### In-scope

- New `--teams` flag on `setup.js`, persisted to `state.json` as `teams_mode: true`.
- New Phase 3 branch in `.claude/commands/pickle.md` that, when `teams_mode === true`, calls `TeamCreate`, then for each ticket creates a task and spawns an `Agent` teammate with `team_name` and a per-ticket `name`, then waits for `TaskUpdate(status="completed")` notifications instead of subprocess exit.
- Two new agent definitions: `.claude/agents/morty-implementer.md` (full-tool, runs the existing `send-to-morty.md` 8-phase lifecycle) and `.claude/agents/morty-reviewer.md` (full-tool, runs the existing `send-to-morty-review.md` 4-phase lifecycle).
- `install.sh` rsyncs `.claude/agents/` into `~/.claude/agents/`.
- Lifecycle-artifact validation (`research_*.md`, `plan_*.md`, `conformance_*.md`, `code_review_*.md`) still runs after the teammate signals completion.
- `TeamDelete` called when the epic finishes (after `<promise>EPIC_COMPLETED</promise>`).
- Hard error when `--teams` is combined with `--backend codex`: setup.js exits non-zero with a message saying teams mode is claude-only.
- Documentation: README.md flag table updated, PRD_GUIDE.md unchanged (no PRD shape changes), help-pickle.md mentions the flag.
- Unit tests for setup.js flag parsing and state.json persistence.

### Not-in-scope

- `/pickle-tmux`, `/pickle-zellij`, `/pickle-microverse`, `/pickle-pipeline`, `/pickle-jar-open`, `/council-of-ricks`, `/anatomy-park`, `/szechuan-sauce`, `/meeseeks` — none of these change. They continue to use `spawn-morty.js` and `mux-runner.js`.
- Codex backend — `--backend codex` is incompatible with `--teams`; the codex path keeps `spawn-morty.js` as-is. No abstraction layer over both.
- Removing `spawn-morty.js` or deprecating the subprocess path — both stay. This PRD is purely additive.
- Parallel ticket execution — even with teams, this PRD ships sequential ticket processing. Parallelism is enabled by the new architecture but is a follow-up.
- Refinement team (`spawn-refinement-team.js`) — out of scope for this iteration.
- Modifying the 8-phase ticket lifecycle, the `send-to-morty.md` template, or the lifecycle-artifact validator.
- Token/cost accounting changes — accept that team-mode worker tokens roll up under the parent harness session rather than appearing as separate `claude -p` invocations.

## Critical User Journeys

**CUJ-1: Happy path on claude backend.**
User runs `/pickle --teams "add a /healthz endpoint"`. setup.js writes `teams_mode: true` to `state.json`. Pickle drafts the PRD, breaks it into N tickets, then in Phase 3 calls `TeamCreate`, spawns N `morty-implementer` agents in sequence, each completes its ticket and calls `TaskUpdate(completed)`, manager validates lifecycle artifacts, marks tickets Done, finally calls `TeamDelete` and outputs `<promise>EPIC_COMPLETED</promise>`.

**CUJ-2: Codex rejection.**
User runs `/pickle --teams --backend codex "..."`. setup.js exits non-zero with `Error: --teams is incompatible with --backend codex` and does NOT create a session.

**CUJ-3: Resume.**
User runs `/pickle --teams "..."`, ctrl-c's mid-epic, then runs `/pickle --resume <SESSION>`. teams_mode persists; resumed session reads it from state.json and continues with team primitives. (Note: any in-flight `Agent` teammates from the previous harness session are gone; resume picks up at the next non-Done ticket.)

**CUJ-4: Default behavior unchanged.**
User runs `/pickle "..."` (no `--teams` flag). Behavior is byte-for-byte identical to today: `spawn-morty.js` is invoked per ticket, no `TeamCreate` is called.

## Functional Requirements

| Priority | Requirement | Verification |
|:---|:---|:---|
| P0 | `setup.js` accepts `--teams` flag and writes `teams_mode: true` to `state.json` | `node extension/bin/setup.js --teams --task "x" /tmp/test-session && jq -e '.teams_mode == true' /tmp/test-session/state.json` |
| P0 | `setup.js` rejects `--teams --backend codex` with non-zero exit and clear error | `node extension/bin/setup.js --teams --backend codex --task "x" /tmp/test-session; test $? -ne 0` |
| P0 | Default behavior (no flag) leaves `teams_mode` falsy | `node extension/bin/setup.js --task "x" /tmp/test-session && jq -e '(.teams_mode // false) == false' /tmp/test-session/state.json` |
| P0 | `teams_mode` survives `--resume` | `node extension/bin/setup.js --teams --task "x" /tmp/s && node extension/bin/setup.js --resume /tmp/s && jq -e '.teams_mode == true' /tmp/s/state.json` |
| P0 | `pickle.md` Phase 3 contains a `teams_mode === true` branch that uses `TeamCreate`/`Agent`/`TaskUpdate`/`TeamDelete` and does NOT call `spawn-morty.js` | `grep -E 'teams_mode' .claude/commands/pickle.md && grep -q 'TeamCreate' .claude/commands/pickle.md && grep -q 'TeamDelete' .claude/commands/pickle.md` |
| P0 | `pickle.md` legacy branch (no `--teams`) is unchanged from current `spawn-morty.js` invocation | `diff <(git show HEAD:.claude/commands/pickle.md \| sed -n '/Phase 3/,/EPIC_COMPLETED/p') <(sed -n '/Phase 3/,/EPIC_COMPLETED/p' .claude/commands/pickle.md \| grep -v teams_mode)` is empty for the non-teams subset |
| P0 | `.claude/agents/morty-implementer.md` exists with valid frontmatter and includes the `send-to-morty.md` lifecycle | `test -f .claude/agents/morty-implementer.md && head -20 .claude/agents/morty-implementer.md \| grep -q 'description:' && grep -q '8-Phase' .claude/agents/morty-implementer.md` |
| P0 | `.claude/agents/morty-reviewer.md` exists with valid frontmatter | `test -f .claude/agents/morty-reviewer.md && head -20 .claude/agents/morty-reviewer.md \| grep -q 'description:'` |
| P0 | `install.sh` deploys `.claude/agents/*.md` to `~/.claude/agents/` | `bash install.sh && test -f ~/.claude/agents/morty-implementer.md && test -f ~/.claude/agents/morty-reviewer.md` |
| P0 | Lifecycle-artifact validation logic from `spawn-morty.ts` (the `hasLifecycleArtifact` check) is reused in the teams branch — no second copy | `grep -c 'hasLifecycleArtifact' extension/src/**/*.ts` returns ≥2 (declaration + at least one consumer) and the teams branch in `pickle.md` references it via a helper script, not via inlined logic |
| P1 | New helper `extension/bin/validate-teams-ticket.js` exposes lifecycle-artifact check as a CLI for `pickle.md` to call | `node extension/bin/validate-teams-ticket.js --ticket-path /tmp/fixtures/done-ticket && test $? -eq 0; node extension/bin/validate-teams-ticket.js --ticket-path /tmp/fixtures/empty-ticket; test $? -ne 0` |
| P1 | Tests pass after the change | `cd extension && npx tsc --noEmit && npx tsc && npm test` |
| P1 | ESLint clean | `cd extension && npx eslint src/ --max-warnings=-1` |
| P1 | README.md flag table includes `--teams` | `grep -q '\-\-teams' README.md` |
| P1 | `help-pickle.md` mentions `--teams` | `grep -q '\-\-teams' .claude/commands/help-pickle.md` |
| P2 | `pickle_settings.json` adds `enable_teams_mode_default` (boolean, default false) so users can flip the default without passing the flag | `jq -e '.enable_teams_mode_default == false' pickle_settings.json` |

## Interface Contracts

| Boundary | Input | Output | Error |
|:---|:---|:---|:---|
| `setup.js --teams` | argv flag | `state.json.teams_mode = true` | exit 1 if combined with `--backend codex` |
| `pickle.md` Phase 3 (teams branch) reading state | `state.json.teams_mode` | branch selector | n/a — falsy → legacy path |
| `Agent` teammate spawn | `{ team_name, name: "morty-impl-<ticket-id>", subagent_type: "morty-implementer", prompt: <ticket-content + EXECUTION CONTEXT> }` | teammate runs lifecycle, drops artifacts in `${SESSION_ROOT}/<id>/`, calls `TaskUpdate(status="completed")` | teammate failure → task stays in_progress; manager retries or marks ticket Failed after timeout |
| `validate-teams-ticket.js` | `--ticket-path <dir> --role <implementation\|review>` | exit 0 if all required lifecycle artifacts present, exit 1 otherwise | stderr lists missing artifacts |

## Verification Strategy

- **Type**: `npx tsc --noEmit` from `extension/` passes.
- **Test**: `npm test` passes; new tests cover (a) setup.js flag parsing including the codex-rejection case, (b) `validate-teams-ticket.js` exit codes against fixtures, (c) `pickle.md` static checks (greppable assertions about teams branch presence).
- **Contract**: state.json schema gains an optional `teams_mode: boolean` field; types/index.js State type is updated.
- **LLM**: Out of scope — `pickle.md` is a prompt template, not testable code; the static greppable checks above are the verification surface.
- **Manual**: One end-to-end run of `/pickle --teams "<trivial 1-ticket task>"` on the claude backend to confirm the teammate spawns, completes, and TeamDelete fires. This is required before merge but is not part of CI.

## Test Expectations

| Requirement | Test File | Description | Assertion |
|:---|:---|:---|:---|
| `--teams` flag parsing | `extension/tests/setup-teams-flag.test.js` | spawns setup.js with `--teams` against tmpdir, reads state.json | `teams_mode === true` |
| codex rejection | `extension/tests/setup-teams-codex-conflict.test.js` | spawns setup.js with `--teams --backend codex` | non-zero exit, stderr contains "claude-only" or similar |
| default falsy | `extension/tests/setup-teams-default-off.test.js` | spawns setup.js without flag | `teams_mode` falsy |
| resume preserves flag | `extension/tests/setup-teams-resume.test.js` | setup with `--teams`, then `--resume`, re-read state | `teams_mode === true` after resume |
| validator: artifacts present | `extension/tests/validate-teams-ticket.test.js` | fixture dir with all lifecycle files | exit 0 |
| validator: artifacts missing | `extension/tests/validate-teams-ticket.test.js` | fixture dir missing `plan_*.md` | exit 1, stderr names missing file |
| `pickle.md` teams branch present | `extension/tests/pickle-md-teams-branch.test.js` | reads `.claude/commands/pickle.md` | contains `TeamCreate`, `TeamDelete`, `Agent`, references `morty-implementer` |

## Technical Constraints

- **No changes to** `spawn-morty.js`, `spawn-refinement-team.js`, `mux-runner.js`, `pipeline-runner.js`, `microverse-runner.js`, the 8-phase `send-to-morty.md` template, or the codex backend path. This PRD is strictly additive.
- **State schema migration**: `teams_mode` is an optional new field on `state.json`. State files written before this change must continue to load (treat missing as `false`).
- **No `Agent` calls inside `spawn-morty.js`** — the manager (`pickle.md`) is the only caller of `Agent`/`TeamCreate`/`SendMessage`. Workers don't spawn sub-teams.
- **Trap door discipline**: any new shell-out in the validator must pass `timeout` per the `extension/CLAUDE.md` Trap Doors policy.
- **`pickle.md` stays under 300 lines** after the teams branch is added. If it grows beyond that, factor static helper scripts out into `extension/bin/`.

## Codebase Context

Files this PRD will touch:
- `extension/src/bin/setup.ts` (compile target: `extension/bin/setup.js`) — flag parsing, state.json write, codex-conflict check.
- `extension/src/types/index.ts` — extend `State` type with optional `teams_mode?: boolean`.
- `extension/src/bin/validate-teams-ticket.ts` (new) — CLI wrapper around `hasLifecycleArtifact` from `extension/src/types/index.ts`.
- `.claude/commands/pickle.md` — Phase 3 teams branch.
- `.claude/agents/morty-implementer.md` (new), `.claude/agents/morty-reviewer.md` (new).
- `install.sh` — rsync agents dir.
- `extension/tests/setup-teams-*.test.js`, `extension/tests/validate-teams-ticket.test.js`, `extension/tests/pickle-md-teams-branch.test.js`.
- `README.md`, `.claude/commands/help-pickle.md` — flag docs.

Patterns to follow:
- CLI guard: `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }` (per project CLAUDE.md).
- Error handling: `const msg = err instanceof Error ? err.message : String(err);`.
- State writes go through `state-manager.js` atomic locks, NOT direct `fs.writeFileSync`.
- Tests use `node --test` (no vitest, no jest).

## Assumptions

- Harness team primitives (`TeamCreate`, `Agent` with `team_name`, `SendMessage`, `TaskUpdate`, `TeamDelete`) behave per the schemas surfaced via `ToolSearch`. Specifically: spawning an `Agent` with `team_name` adds it to the team; the agent can call `TaskUpdate` to signal completion; that update arrives in the manager's session as a notification.
- `subagent_type` referencing a custom `.claude/agents/morty-implementer.md` definition resolves correctly when the manager runs from any cwd (the agent is a user-level definition, not project-scoped).
- One pickle session ↔ one harness team is acceptable. We don't need to share teams across sessions or persist them beyond `EPIC_COMPLETED`.

## Risks & Mitigations

| Risk | Mitigation |
|:---|:---|
| Custom agent definition not picked up by harness when manager spawns Agent | Verify `~/.claude/agents/morty-implementer.md` resolves via the manual end-to-end run before merge; fallback is to inline the prompt into the Agent call rather than rely on `subagent_type` |
| Teammate fails silently (no TaskUpdate, no notification) | Manager-side timeout: if a `morty-impl-<id>` task stays `in_progress` past `worker_timeout_seconds`, manager runs `validate-teams-ticket.js` against the ticket dir; pass → mark Done, fail → mark Failed and move on (mirrors the existing safety net) |
| State.json schema drift breaks legacy sessions | `teams_mode` is optional; missing field reads as `false`; no migration needed |
| Token cost shows up under the wrong session in `/pickle-metrics` | Acceptable for v1; document in README that teams-mode token usage rolls up under the parent harness session and the metrics reporter does not separate them |
| `pickle.md` becomes unreadable due to dual-branch logic | Cap at 300 lines, factor any non-trivial logic out to `extension/bin/` helpers, keep the prompt declarative |

## Business Benefits

- Removes ~400 LOC of subprocess scaffolding from the hot path on the claude backend (still present for codex, still present for legacy).
- Eliminates the `WORKER_DONE` token + log-size + artifact triple-check ghost-ticket validation class — replaced by an explicit `TaskUpdate` signal.
- Enables future parallel ticket execution (out of scope for v1, but the architecture supports it).
- Removes one trap-door class (subprocess pipe/log-flush races) from the claude path.
