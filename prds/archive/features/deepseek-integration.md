# DeepSeek Backend Integration PRD
| DeepSeek Backend Integration PRD | | Add `deepseek` as a third backend by routing the existing `claude` CLI through DeepSeek's Anthropic-compatible shim, while preserving honest backend identity in state, logs, and metrics |
|:---|:---|:---|
| **Author**: Gregory Dickson **Contributors**: Claude (Pickle Rick) | **Status**: Draft **Created**: 2026-04-27 | **Visibility**: Internal |

## Completion Checklist
- [x] Introduction - [x] Problem - [x] Scope - [x] CUJs - [x] Requirements - [x] Contracts - [x] Verification - [x] Tests - [x] Assumptions - [x] Risks - [x] Impact - [x] Stakeholders

## Introduction

Add `deepseek` as a first-class backend value alongside `claude` and `codex`. Unlike codex (which ships a real CLI binary), DeepSeek has no first-party CLI — their official "coding agents" guide instructs users to install Claude Code and re-point it at `https://api.deepseek.com/anthropic` via `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`. We adopt that pattern: deepseek invocations spawn `claude -p ...` with overlay env vars, but every other surface (state, logs, metrics, jar queue, refinement lock) sees `'deepseek'` honestly.

Source: https://api-docs.deepseek.com/guides/coding_agents (lists Claude Code, OpenCode, OpenClaw as the three recommended harnesses).

## Problem Statement

**Current Process**: Pickle Rick supports two backends: `claude` (default) and `codex`. Both follow a clean dispatch contract — `buildWorkerInvocation(backend)` returns `{ cmd, args, backend }`, callers spawn the cmd. Adding a third backend that shipped its own CLI would be ~50 LOC.

DeepSeek does not ship a CLI. Three integration shapes were considered:
- **Shape A** (this PRD): Ride the `claude` binary via DeepSeek's Anthropic-compat shim with env-var overlay. Track identity separately in `state.backend` so the rest of the runtime is unaware of the transport detail.
- **Shape B**: Adopt OpenCode/OpenClaw as a third subprocess CLI. Mirrors codex pattern but inherits a third-party CLI's prompt format and bugs.
- **Shape C**: Native HTTP loop with OpenAI-style `tool_calls`. Largest blast radius; introduces a new spawning paradigm.

**Users**: Pickle Rick loop runners (mux-runner, microverse-runner, jar-runner) and the humans who select backends per epic.

**Pain Points**:
- No way to run a Pickle epic on DeepSeek today
- Codex gives one alternative to claude, but the dispatch contract assumes "backend == CLI binary," which doesn't generalize to API-only providers
- Shape A risks dishonest identity (logs say "claude" while requests hit DeepSeek) unless we explicitly separate `backend` from `cmd`

**Importance**: DeepSeek's coding models are materially cheaper than premium Claude tiers for comparable output on rote coding tasks. (Specific rates are deliberately not quoted here — they go stale; check DeepSeek's current pricing page for live figures.) Adding the backend turns a Pickle epic from premium-only into a real cost-tier choice.

## Objective & Scope

**Objective**: Add `'deepseek'` to the `Backend` type and dispatch system. Spawn the `claude` CLI binary, but route requests to DeepSeek's Anthropic-compat endpoint via env vars, and persist truthful backend identity throughout state and logs.

**Ideal Outcome**: `setup.js --backend deepseek --task "..."` works exactly like `--backend codex` from the user's perspective. State, jar queue, mux-runner logs, and metrics all show `'deepseek'`. Refinement still forces claude (existing constraint). Output parser, promise tokens, judge sandbox all work unchanged because the shim returns Anthropic-shaped responses.

### In-scope

- Extend `Backend = 'claude' | 'codex' | 'deepseek'` in `extension/src/types/index.ts`
- Extend `SpawnInvocation` to carry an optional `env?: Record<string, string>` overlay
- Add `buildDeepseekInvocation()` in `extension/src/services/backend-spawn.ts` (worker, manager, judge variants)
- Extend `resolveBackend()` and `isBackend()` to accept the new value
- Wire all four spawn sites (`spawn-morty.ts`, `mux-runner.ts`, `jar-runner.ts`, `microverse-runner.ts`) to spread `invocation.env` alongside existing `backendEnvOverrides()`
- Pre-flight guard in `setup.ts`: `--backend deepseek` requires `DEEPSEEK_API_KEY` env var; fail fast with actionable error message
- Extend the existing `--teams + codex` conflict guard to also reject `--teams + deepseek`
- Update command docs (`pickle.md`, `pickle-jar-open.md`, `pickle-microverse.md`) to list `--backend <claude|codex|deepseek>` and document the `DEEPSEEK_API_KEY` requirement
- Tests mirroring existing codex coverage in `extension/tests/backend-spawn.test.js`

### Not-in-scope

- Per-token cost reporting in metrics. Pickle Rick tracks total tokens and LOC, not $/token. No rate table.
- Output parser changes. The Anthropic-compat shim returns stream-json shape; existing mode-1 extraction works unchanged.
- Promise token translation. `EPIC_COMPLETED` / `TASK_COMPLETED` / `WORKER_DONE` / `EXISTENCE_IS_PAIN` are prompt-driven and model-agnostic.
- Refinement support. `PICKLE_REFINEMENT_LOCK=1` already forces claude regardless of parent backend; deepseek inherits the same constraint codex has.
- Teams mode support. Teams primitives (`TeamCreate` + `Agent` + `TaskUpdate`) are harness-bound; deepseek inherits codex's incompatibility.
- DeepSeek model selection beyond `deepseek-v4-pro` default. Users can override via `ANTHROPIC_MODEL` env var if needed; we do not expose a `--model` translation layer.
- Native OpenAI-style `tool_calls` integration (Shape C). If we ever want a generic OpenAI-compat lane, it gets its own PRD.
- Subprocess integration with OpenCode/OpenClaw (Shape B).
- Caching configuration. DeepSeek's KV cache is automatic; no `cache_control` to manage.
- Rate-limit handling beyond what mux-runner already does. DeepSeek does not publish quotas; the existing 10-min stall tolerance in mux-runner is assumed sufficient.

## Product Requirements

### Critical User Journeys (CUJs)

**CUJ-1: Run an epic on DeepSeek**

User exports `DEEPSEEK_API_KEY=sk-...`, runs `node ~/.claude/pickle-rick/extension/bin/setup.js --backend deepseek --task "refactor auth module"`. Setup writes `state.backend = 'deepseek'` to `state.json`. The first iteration spawns `claude -p "..."` with `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY`, `ANTHROPIC_MODEL=deepseek-v4-pro`, `PICKLE_BACKEND=deepseek` in the child env. Output streams in stream-json, mux-runner extracts content via mode-1, classifies completion normally. `state.json` and `tmux-runner.log` both show `'deepseek'` for the duration of the epic.

**CUJ-2: Missing API key fails fast**

User runs `--backend deepseek` without `DEEPSEEK_API_KEY` set. Setup exits non-zero before any session directory is created, with stderr: `Error: --backend deepseek requires DEEPSEEK_API_KEY environment variable. Get a key at https://platform.deepseek.com/api_keys.` No partial state is written.

**CUJ-3: Mixed-backend jar batch**

User queues three tasks: one with `--backend claude`, one `--backend codex`, one `--backend deepseek`. `pickle-jar-open` walks the queue, reading `state.backend` per task. Each task spawns the right CLI with the right env overlay. `jar-runner.log` shows three distinct backend values across the run. ENOENT handling for the `claude` binary applies equally to the deepseek case (since deepseek rides claude).

**CUJ-4: Resume across context boundaries**

User starts a deepseek epic, hits the 5-iteration limit, resumes via `--resume`. `loadBackendFromSession()` reads `'deepseek'` from `state.json`, `buildWorkerInvocation('deepseek')` reconstructs the same env overlay. No re-prompt for `--backend`, no env override required at resume time (the shim env is rebuilt from state + process env).

**CUJ-5: Refinement still uses claude**

User runs `/pickle-refine-prd` from a session where `state.backend = 'deepseek'`. `spawn-refinement-team.ts` logs `"Parent backend was deepseek but PRD refinement forces backend=claude"`, sets `REFINEMENT_BACKEND='claude'`, spawns the claude CLI with no DeepSeek env overlay. Refinement workers run on real Anthropic API.

### Functional Requirements

**FR-1**: `Backend` type accepts the literal `'deepseek'`. `BACKENDS` constant array includes it. `isBackend(value)` returns `true` for `'deepseek'`.

**FR-2**: `resolveBackend(source)` returns `'deepseek'` when `state.backend === 'deepseek'` or `PICKLE_BACKEND === 'deepseek'`, with the same priority order as existing backends. The `PICKLE_REFINEMENT_LOCK=1` sentinel still forces claude.

**FR-3**: `SpawnInvocation` interface gains an optional `env?: Record<string, string>` field. Existing claude and codex invocations leave it undefined. Deepseek invocations populate it.

**FR-4**: `buildDeepseekInvocation(opts)` returns:
- `cmd: 'claude'`
- `args`: identical to `buildClaudeWorkerInvocation(opts)` for the worker variant; same parity for manager and judge variants
- `backend: 'deepseek'`
- `env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL }` populated from process env + opts

**FR-5**: `buildWorkerInvocation`, `buildManagerInvocation`, and `buildJudgeInvocation` all dispatch to the deepseek builder when `backend === 'deepseek'`. Judge variant honors the existing read-only sandbox contract (`--allowedTools Read,Glob,Grep` + `--no-session-persistence`) inherited from claude.

**FR-6**: All four spawn sites — `spawn-morty.ts`, `mux-runner.ts`, `jar-runner.ts`, `microverse-runner.ts` — spread `invocation.env` (when defined) into the child process env, alongside `backendEnvOverrides(backend)`. The merge order is: `process.env` → `backendEnvOverrides(backend)` → `invocation.env`. `PICKLE_BACKEND` always wins over any overlay.

**FR-7**: `setup.ts` validates that `DEEPSEEK_API_KEY` is set when `--backend deepseek` is parsed. On failure, exits non-zero before creating session state, with a single-line stderr message naming the missing variable and linking to the API-keys page.

**FR-8**: `setup.ts` extends the existing `--teams` + `codex` conflict guard to also reject `--teams` + `deepseek` with the same error wording.

**FR-9**: Default `ANTHROPIC_MODEL` for deepseek invocations is `'deepseek-v4-pro'`. Users can override by exporting `ANTHROPIC_MODEL` in their shell before launch; the deepseek builder honors `process.env.ANTHROPIC_MODEL` if set, else uses the default.

**FR-10**: Output parsing in `mux-runner.ts:241-328` is unchanged. Mode-1 (stream-json) handles deepseek responses because the Anthropic-compat shim mirrors Anthropic's response shape.

### Non-Functional Requirements

**NFR-1**: Compilation correctness. Adding `'deepseek'` to the `Backend` enum must produce TS errors at every dispatch site that currently switches on backend, ensuring no silent fall-through to claude.

**NFR-2**: Honest identity. `state.backend`, `tmux-runner.log` per-iteration banners, `jar-runner.log` per-task banners, and `metrics.js` session attribution must all report `'deepseek'` — never `'claude'` — when the deepseek backend is selected.

**NFR-3**: Zero pollution of the claude code path. The deepseek env overlay must be confined to `buildDeepseekInvocation()`. No call site should ever read `ANTHROPIC_BASE_URL` or `DEEPSEEK_API_KEY` directly.

**NFR-4**: Failure isolation. A missing `DEEPSEEK_API_KEY` at setup time must not corrupt the session state directory; it must fail before any file is written.

## Technical Design

### Type & Constant Changes

`extension/src/types/index.ts:53-55`:
```ts
export type Backend = 'claude' | 'codex' | 'deepseek';
export const BACKENDS: readonly Backend[] = ['claude', 'codex', 'deepseek'] as const;
```

`extension/src/services/backend-spawn.ts` (~line 28-32) — extend invocation contract:
```ts
export interface SpawnInvocation {
  cmd: string;
  args: string[];
  backend: Backend;
  env?: Record<string, string>;
}
```

### New Builder

`extension/src/services/backend-spawn.ts` (new function, ~line 140):
```ts
function buildDeepseekInvocation(opts: WorkerOpts): SpawnInvocation {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('buildDeepseekInvocation called without DEEPSEEK_API_KEY (setup.ts should have rejected earlier)');
  }
  const claude = buildClaudeWorkerInvocation(opts);
  return {
    cmd: claude.cmd,
    args: claude.args,
    backend: 'deepseek',
    env: {
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? 'deepseek-v4-pro',
    },
  };
}
```

Manager and judge variants follow the same pattern: build the claude invocation, copy `cmd`/`args`, swap `backend`, attach env overlay.

### Spawn Site Wiring

Each of `spawn-morty.ts`, `mux-runner.ts`, `jar-runner.ts`, `microverse-runner.ts` already does something like:
```ts
const child = spawn(invocation.cmd, invocation.args, {
  env: { ...process.env, ...backendEnvOverrides(invocation.backend) },
});
```

One-line change per site:
```ts
env: { ...process.env, ...backendEnvOverrides(invocation.backend), ...(invocation.env ?? {}) },
```

### Setup Guard

`extension/src/bin/setup.ts:145-179`, after the existing backend validation block:
```ts
if (parsed.backend === 'deepseek' && !process.env.DEEPSEEK_API_KEY) {
  console.error('Error: --backend deepseek requires DEEPSEEK_API_KEY environment variable.');
  console.error('Get a key at https://platform.deepseek.com/api_keys.');
  process.exit(1);
}
```

Teams conflict at `setup.ts:177-179`:
```ts
if (parsed.teams && (parsed.backend === 'codex' || parsed.backend === 'deepseek')) {
  console.error(`Error: --teams is incompatible with --backend ${parsed.backend}.`);
  process.exit(1);
}
```

## Verification

### Manual Verification

1. **Smoke test**: `DEEPSEEK_API_KEY=sk-... node extension/bin/setup.js --backend deepseek --task "add a one-line console.log to README.md"`. Confirm `state.json.backend === 'deepseek'`, mux iteration logs show "[backend=deepseek]", a real DeepSeek response arrives.
2. **Missing key**: unset `DEEPSEEK_API_KEY`, run the same command, confirm exit code 1 + actionable stderr + no session dir created under `~/.local/share/pickle-rick/sessions/`.
3. **Teams conflict**: `--backend deepseek --teams 3`, confirm exit code 1 + correct error wording.
4. **Resume**: kill an active deepseek session mid-iteration, run with `--resume`, confirm the next iteration spawns with the same env overlay (verify via `ps eww` on the child claude process during iteration).
5. **Refinement override**: from a deepseek session, run `/pickle-refine-prd`, tail `refinement/worker_*.log`, confirm the warning message and that the worker process env shows `ANTHROPIC_BASE_URL=api.anthropic.com` (not deepseek).
6. **Mixed jar**: queue claude + codex + deepseek tasks, run `/pickle-jar-open`, confirm `jar-runner.log` shows three distinct backend values and three correct env overlays.

### Automated Verification

`extension/tests/backend-spawn.test.js` — extend with a `describe('deepseek backend')` block:
- `resolveBackend()` returns `'deepseek'` from state and from env
- `isBackend('deepseek')` returns `true`
- `buildWorkerInvocation('deepseek', opts)` returns `{ cmd: 'claude', args: [...claude args...], backend: 'deepseek', env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL } }` with the right values when `DEEPSEEK_API_KEY` is in the test env
- `buildWorkerInvocation('deepseek', opts)` throws when `DEEPSEEK_API_KEY` is unset
- `buildJudgeInvocation('deepseek', opts)` produces a read-only sandbox invocation (same allowedTools as claude) plus the env overlay
- Manager builder parity check
- `PICKLE_REFINEMENT_LOCK=1` still forces `'claude'` even when state says `'deepseek'`

`extension/tests/spawn-morty.test.js` — extend the env-spread fixture to assert that when invocation has an env overlay, the child env contains those keys.

`extension/tests/setup.test.js` — add cases for the missing-API-key guard and the teams-conflict guard.

### Tests

| Test | Purpose | File |
|---|---|---|
| `resolveBackend deepseek from state` | Confirms enum extension reaches resolution layer | `tests/backend-spawn.test.js` |
| `resolveBackend deepseek from env` | Confirms `PICKLE_BACKEND=deepseek` propagates | `tests/backend-spawn.test.js` |
| `buildWorkerInvocation deepseek shape` | Confirms `cmd:'claude'`, `backend:'deepseek'`, env overlay correct | `tests/backend-spawn.test.js` |
| `buildWorkerInvocation deepseek missing key` | Confirms throw when `DEEPSEEK_API_KEY` unset | `tests/backend-spawn.test.js` |
| `buildJudgeInvocation deepseek read-only` | Confirms judge sandbox + env overlay both present | `tests/backend-spawn.test.js` |
| `refinement lock forces claude over deepseek` | Confirms `PICKLE_REFINEMENT_LOCK=1` precedence | `tests/spawn-refinement-claude-only.test.js` |
| `setup rejects deepseek without API key` | Confirms pre-flight guard | `tests/setup.test.js` |
| `setup rejects --teams + deepseek` | Confirms teams conflict guard extension | `tests/setup.test.js` |
| `spawn-morty spreads invocation.env` | Confirms env overlay reaches child process | `tests/spawn-morty.test.js` |

## Assumptions

- DeepSeek's Anthropic-compat shim at `https://api.deepseek.com/anthropic` mirrors Anthropic's API closely enough that `claude -p` works without prompt-format adaptation. The DeepSeek docs claim this; we accept it on faith and rely on smoke testing to falsify.
- Stream-json output from the shim is byte-compatible with what `mux-runner.ts:extractAssistantContent()` expects in mode-1. If DeepSeek's shim ever drifts (e.g., omits the `message.content[].text` block shape), output parsing breaks; we accept that risk.
- `claude` CLI is installed and on PATH for any user selecting `--backend deepseek`. The shim does not replace claude; it redirects it.
- DeepSeek's automatic KV cache produces meaningful hit rates for our workload (long stable system prompts + appended turns). If cache hit rate is low, costs are higher than expected; users see this in their DeepSeek dashboard (Pickle does not track $/token).
- Promise tokens (`EPIC_COMPLETED`, `TASK_COMPLETED`, etc.) are reproduced verbatim by deepseek-v4-pro when prompted in the same way. Codex already validated this pattern across model families; deepseek is assumed similar.
- DeepSeek model identifiers in `ANTHROPIC_MODEL` are passed through opaquely by the shim. We use `'deepseek-v4-pro'` based on DeepSeek's current model listings; if DeepSeek renames, users override via env.
- The `--model` flag on `claude` (haiku/sonnet/opus tier) is ignored or harmlessly overridden by the shim when `ANTHROPIC_MODEL` is set. Smoke testing confirms.

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Shim drift — DeepSeek's `/anthropic` endpoint diverges from Anthropic's response shape, breaking `extractAssistantContent()` | Med | Smoke test on every release; if it breaks, add a deepseek-specific output mode (similar to codex-delimiter mode) |
| API key in process env leaks into child logs | Low | `claude` CLI does not log env vars; we never write `ANTHROPIC_AUTH_TOKEN` to disk; same exposure as any user running claude with env-based auth |
| 10-minute server-side stall before inference starts (documented DeepSeek behavior) | Med | mux-runner already tolerates long-running children; circuit-breaker iteration timeouts cap blast radius |
| Adaptive rate limiting returns 429s under load | Med | mux-runner retry logic already handles transient failures; if 429s become endemic, add a deepseek-specific backoff |
| User confuses "claude backend" with "deepseek backend riding claude CLI" and reports a "claude bug" that's actually deepseek | Low | Per-iteration banner in mux-runner explicitly logs `[backend=deepseek]`; jar log + state file agree |
| Teams mode silently fails if guard regresses | Low | Test coverage on the guard; same failure mode as existing codex case |
| Refinement lock regression sends planning traffic to deepseek | Med | Existing test (`spawn-refinement-claude-only.test.js`) already covers this; extend to assert deepseek is also forced to claude |
| `ANTHROPIC_MODEL` already set in shell from unrelated work bleeds into the deepseek invocation | Low | Document in `pickle.md`: "deepseek backend honors ANTHROPIC_MODEL if set, else defaults to deepseek-v4-pro" |

## Impact

**Code touched**: `extension/src/types/index.ts`, `extension/src/services/backend-spawn.ts`, `extension/src/bin/setup.ts`, `extension/src/bin/spawn-morty.ts`, `extension/src/bin/mux-runner.ts`, `extension/src/bin/jar-runner.ts`, `extension/src/services/microverse-runner.ts`, `extension/tests/backend-spawn.test.js`, `extension/tests/spawn-morty.test.js`, `extension/tests/setup.test.js`, `extension/tests/spawn-refinement-claude-only.test.js`, `.claude/commands/pickle.md`, `.claude/commands/pickle-jar-open.md`, `.claude/commands/pickle-microverse.md`, `README.md` (per CLAUDE.md docs rule).

**LOC estimate**: ~80 source + ~120 test + ~30 docs = ~230 LOC.

**Behavior changes for existing backends**: None. `claude` and `codex` paths are byte-identical pre/post-change because the env overlay field is optional and unused on those paths.

**Versioning**: Minor bump (new feature, new flag value). Backend type extension is additive; no state migration required because old sessions never wrote `'deepseek'`. Per CLAUDE.md: bump `extension/package.json`, commit `chore: bump version to X.Y.Z`, tag release after the gate (`npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test`) is green.

## Stakeholders

- **Owner**: Gregory Dickson
- **Implementer**: Pickle Rick (Claude / via Pickle Rick loop)
- **Reviewer**: Gregory Dickson
- **Affected users**: Anyone running Pickle Rick epics; specifically those wanting cheaper models for rote work
- **External dependency owner**: DeepSeek (Anthropic-compat shim availability + behavior)

## Acceptance Criteria

- [ ] `Backend` type and `BACKENDS` constant include `'deepseek'`
- [ ] `buildDeepseekInvocation()` exists and is dispatched from `buildWorkerInvocation`, `buildManagerInvocation`, `buildJudgeInvocation`
- [ ] `SpawnInvocation.env` is spread into the child process env at all four spawn sites
- [ ] `setup.js --backend deepseek` without `DEEPSEEK_API_KEY` exits non-zero before any session state is created
- [ ] `setup.js --backend deepseek --teams N` exits non-zero with the same wording as the existing codex case
- [ ] A real session run with `--backend deepseek` completes at least one iteration and writes `'deepseek'` to `state.json.backend`, `tmux-runner.log`, and any per-task jar log
- [ ] `/pickle-refine-prd` from a deepseek parent session forces `'claude'` and logs the override warning
- [ ] `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test` passes from `extension/`
- [ ] All three command docs and `README.md` reflect the new backend value and the `DEEPSEEK_API_KEY` requirement
