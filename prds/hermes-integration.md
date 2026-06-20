# Hermes Backend Integration PRD

| Hermes Backend Integration PRD | | Add `hermes` as a first-class backend by spawning the first-party `hermes chat -q` CLI in headless mode, with toolset routing and honest backend identity throughout state, logs, and metrics |
|:---|:---|:---|
| **Author**: Gregory Dickson **Contributors**: Pickle Rick | **Status**: Ready (research complete) **Created**: 2026-05-01 **Research**: `prds/archive/research/hermes-research.md` | **Visibility**: Internal |

## Completion Checklist
- [x] Introduction - [x] Problem - [x] Scope - [x] CUJs - [x] Requirements - [x] Contracts - [x] Verification - [x] Tests - [x] Assumptions - [x] Risks - [x] Impact - [x] Stakeholders

## Introduction

Add `hermes` as a first-class backend value alongside `claude` and `codex`. Hermes ships its own CLI binary with a headless mode (`hermes chat -q "..."`) plus toolset selection (`--toolsets terminal,file,code_execution`) and provider override (`--provider`). Integration shape is closer to codex than claude: dispatch a real binary with its own arg shape, capture stdout/stderr, parse output, classify completion.

## Bundle Implementation Notes (2026-05-03)

The P2 mega bundle shipped the Hermes backend as a state/config driven backend, not the full setup-time option surface from the draft:

- Public backend selector: `--backend hermes` and `PICKLE_BACKEND=hermes`.
- Spawn command: `hermes chat -q <prompt> -Q --ignore-rules --ignore-user-config`, with optional `--max-turns`, `--toolsets`, `--provider`, and `-m` values read from state fields.
- State fields: `hermes_toolsets`, `hermes_provider`, `hermes_model`, and `hermes_max_turns`.
- `--teams` is Claude-only and is rejected for `--backend hermes`.
- Hermes binary/version smoke checks and dedicated `--hermes-*` setup flags remain follow-up work; this bundle does not expose those flags as public CLI.

Source: hermes-agent skill section "Spawning Additional Hermes Instances" (referenced for the `hermes -w` interactive headless pattern, not used here).

## Problem Statement

**Current Process**: Pickle Rick supports two production backends (`claude`, `codex`). Each integration follows a consistent dispatch contract via `buildWorkerInvocation(backend)` returning `{ cmd, args, backend }`. Adding hermes is the third instance of this pattern, and the second one with a first-party CLI binary (after codex).

Three integration shapes considered:
- **Shape A** (this PRD): First-party `hermes chat -q` CLI, parallel to codex's `codex exec` pattern. Toolset selection via `--toolsets` is honored when present in session state.
- **Shape B**: Use `hermes -w` interactive headless sessions (long-lived). Higher complexity (would need a session-pool manager); doesn't fit the per-iteration spawn contract.
- **Shape C**: Skip CLI entirely, hit Hermes' API directly. Out of scope; we don't add native HTTP loops without a clear reason.

**Users**: Pickle Rick loop runners (mux-runner, microverse-runner, jar-runner) and the humans who select backends per epic. Toolset-aware users who want to constrain hermes to specific capabilities per task tier.

**Pain Points**:
- No way to run a Pickle epic on Hermes today
- Codex and Hermes have different strengths per task class (Hermes excels at multi-step terminal workflows; codex at large refactors); no toolchain-level A/B option
- Toolset routing is a Hermes-specific lever that other backends lack — Pickle currently has no way to express "this ticket needs only file+code_execution, not network"

**Importance**: Hermes' multi-tool agentic loop is qualitatively different from codex's tool-call shape. Some bug-class tickets (especially CLI-tooling-heavy ones — the v1.62.x sprint had several) are better fits for Hermes. Adding it gives operators a third real choice rather than the current binary "claude vs codex" axis.

## Objective & Scope

**Objective**: Add `'hermes'` to the `Backend` type and dispatch system. Spawn the first-party `hermes chat -q` CLI in headless mode, optionally pass through toolset/provider/model overrides from state, persist truthful backend identity throughout state and logs, and reuse the existing codex-manager-relaunch primitive for manager relaunch decisions.

**Ideal Outcome**: `setup.js --backend hermes --task "..."` works exactly like `--backend codex` from the user's perspective. State, jar queue, mux-runner logs, and metrics all show `'hermes'`. Refinement still forces claude (existing constraint). Output parser gets a third branch if hermes' stdout shape differs from claude/codex.

### In-scope

- Extend `Backend = 'claude' | 'codex' | 'hermes'` in `extension/src/types/index.ts`
- Add `buildHermesInvocation()` in `extension/src/services/backend-spawn.ts` (worker, manager, judge variants)
- Extend `resolveBackend()` and `isBackend()` to accept the new value
- Wire all four spawn sites (`spawn-morty.ts`, `mux-runner.ts`, `jar-runner.ts`, `microverse-runner.ts`) to dispatch hermes correctly
- Runtime spawn guard: missing `hermes` binary exits 127 and emits `hermes_binary_missing`
- Optional state fields `state.hermes_toolsets`, `state.hermes_provider`, `state.hermes_model`, and `state.hermes_max_turns` are passed through when present
- Extend the existing teams conflict guard to reject `--teams` with any non-claude backend, including hermes
- Extend `evaluateCodexManagerRelaunch` to be backend-aware for codex and hermes; keep the existing file/function/event names for compatibility
- Output classifier extension in `mux-runner.ts:extractAssistantContent` and `mux-runner.ts:classifyCompletion` for hermes' stdout shape (third mode if needed; mode-1 if hermes emits Anthropic-shaped stream-json)
- Update command docs to list `--backend <claude|codex|hermes>`
- Tests mirroring existing codex coverage in `extension/tests/backend-spawn.test.js` (~12 cases)
- Hermes version smoke test mirroring `extension/tests/codex-version-smoke.test.js`

### Not-in-scope

- Per-token cost reporting in metrics. Pickle Rick tracks total tokens and LOC, not $/token.
- Long-lived `hermes -w` interactive sessions. Out per Shape B rejection — doesn't fit per-iteration spawn contract.
- Toolset auto-selection per ticket tier (e.g. "small tier → only file+code_execution"). Toolsets stay session-level for v1; per-ticket routing is a follow-up.
- Hermes setup-time provider/model/toolset CLI flags. State fields exist for programmatic/session-driven routing; public flags remain follow-up work.
- Refinement support. `PICKLE_REFINEMENT_LOCK=1` already forces claude; hermes inherits the same constraint.
- Teams mode support. Teams primitives are harness-bound; hermes inherits codex's incompatibility.
- Promise token translation. `EPIC_COMPLETED` / `TASK_COMPLETED` / `WORKER_DONE` / `EXISTENCE_IS_PAIN` are prompt-driven and model-agnostic.
- Hermes-specific rate-limit handling beyond what mux-runner already does.
- DeepSeek's env-overlay shape (Shape A pattern). Hermes has its own CLI; no shim needed.

## Product Requirements

### Critical User Journeys (CUJs)

**CUJ-1: Run an epic on Hermes**

User runs `node ~/.claude/pickle-rick/extension/bin/setup.js --backend hermes --task "scaffold CI/CD for ~/myapp"`. Setup writes `state.backend = 'hermes'` to `state.json`. The first iteration spawns `hermes chat -q "<prompt>" -Q --ignore-rules --ignore-user-config [--toolsets <toolsets>]` with `PICKLE_BACKEND=hermes` in the child env. stdout is captured, classifier extracts assistant content, promise tokens are detected normally, and `state.json` / runner logs show `'hermes'` for the duration of the epic.

**CUJ-2: Missing hermes binary fails clearly**

User runs a Hermes-backed worker without `hermes` on PATH. The worker spawn exits 127, prints the attempted backend, marks the ticket failed, and emits `hermes_binary_missing`.

**CUJ-3: Toolset routing per epic**

Session state contains `hermes_toolsets: ['terminal','file','code_execution']`. Every Hermes worker/manager spawn passes `--toolsets terminal,file,code_execution` to `hermes chat -q`. Toolsets persist across resume because they are stored in `state.json`.

**CUJ-4: Mixed-backend jar batch**

User queues tasks backed by claude, codex, and hermes. `pickle-jar-open` walks the queue, reading `state.backend` per task. Each task spawns the right CLI. `jar-runner.log` shows distinct backend values. ENOENT handling for backend binaries applies per task.

**CUJ-5: Hermes session timeout + relaunch**

If a Hermes manager subprocess exits while work remains, `evaluateCodexManagerRelaunch` honors `state.backend === 'hermes'` and triggers the same relaunch evaluator with the same cap. Counter and event names remain `codex_manager_relaunch_count` and `codex_manager_relaunch` for compatibility.

**CUJ-6: Refinement still uses claude**

User runs `/pickle-refine-prd` from a session where `state.backend = 'hermes'`. `spawn-refinement-team.ts` logs `"Parent backend was hermes but PRD refinement forces backend=claude"`, sets `REFINEMENT_BACKEND='claude'`, spawns the claude CLI. Refinement workers run on real Anthropic API.

### Functional Requirements

**FR-1**: `Backend` type accepts the literal `'hermes'`. `BACKENDS` constant array includes it. `isBackend(value)` returns `true` for `'hermes'`.

**FR-2**: `resolveBackend(source)` returns `'hermes'` when `state.backend === 'hermes'` or `PICKLE_BACKEND === 'hermes'`, with the same priority order as existing backends. The `PICKLE_REFINEMENT_LOCK=1` sentinel still forces claude.

**FR-3**: `buildHermesInvocation(opts)` returns:
- `cmd: 'hermes'`
- `args: ['chat', '-q', opts.prompt, '-Q', '--ignore-rules', '--ignore-user-config', ...(opts.maxTurns ? ['--max-turns', String(opts.maxTurns)] : []), ...(opts.toolsets ? ['--toolsets', opts.toolsets.join(',')] : []), ...(opts.provider ? ['--provider', opts.provider] : []), ...(opts.model ? ['-m', opts.model] : [])]`
- `backend: 'hermes'`

`--ignore-rules --ignore-user-config` is mandatory: it skips `~/.hermes/AGENTS.md`, `~/.hermes/SOUL.md`, the user `config.yaml`, and preloaded skills. This defends against the same literal-bleed class codex hit in v1.59.1 (`~/.hermes/skills/pickle*` would otherwise be auto-loaded). Per Q19 of `prds/archive/research/hermes-research.md`.

`--max-turns` is passed when `state.hermes_max_turns` is positive, otherwise worker spawns fall back to `state.max_iterations`.

Manager and judge variants follow the same pattern. Hermes has no built-in read-only mode (Q15) — the **judge variant** restricts toolsets to read-only retrieval only (`search`, `web`) and explicitly omits `terminal`, `file`, `write_file`, `patch`, `code_execution`. The same `--ignore-rules --ignore-user-config` flags carry through.

**FR-4**: `buildWorkerInvocation`, `buildManagerInvocation`, and `buildJudgeInvocation` all dispatch to the hermes builder when `backend === 'hermes'`.

**FR-5**: Spawn sites handle `backend === 'hermes'` correctly and pass `PICKLE_BACKEND=hermes` through `backendEnvOverrides`.

**FR-6**: Missing Hermes binaries are surfaced at worker spawn time with exit 127 and `hermes_binary_missing`; setup-time version/API-key smoke checks remain follow-up work.

**FR-7**: State supports optional fields (`state.hermes_toolsets`, `state.hermes_provider`, `state.hermes_model`, `state.hermes_max_turns`). Spawn sites pass them through when present. Dedicated setup flags for these fields are deferred.

**FR-8**: `setup.ts` rejects `--teams` with any non-claude backend, including hermes, with the same Claude-only error wording.

**FR-9**: Hermes-specific tests are mocked; no `engines.hermes` pin is required until setup-time smoke checks ship.

**FR-10**: Output parsing in `mux-runner.ts:extractAssistantContent` and `mux-runner.ts:classifyCompletion` gets a third mode-branch. Confirmed shape (Q6–Q10): stdout = plain assistant content only, no interleaved tool calls, no ANSI in `-Q` mode. The new mode-3 path treats stdout as-is (no ANSI strip needed for stdout). Promise tokens detected via the same regex set — Q10 confirms no `[tool:...]` markers leak through.

Hermes stderr classification for provider/API failures remains follow-up work; the bundle-covered hard failure path is missing binary ENOENT.

**FR-11**: `evaluateCodexManagerRelaunch` accepts codex and hermes as relaunch-eligible backends while keeping the compatibility counter and activity-event names:

```ts
export function evaluateCodexManagerRelaunch(state: State, hasPendingWork: boolean): RelaunchEvaluation {
  if (state.backend !== 'codex' && state.backend !== 'hermes') {
    return { should_relaunch: false, reason: 'wrong_backend', current_count: 0, cap: CAP };
  }
  // ... existing codex logic unchanged
}
```

State field stays at schema v3: canonical name remains `codex_manager_relaunch_count`. Activity event remains `codex_manager_relaunch` and carries the backend in the payload.

**FR-12**: `extension/CLAUDE.md` keeps the existing `codex_manager_relaunch_count` invariant and documents Hermes-specific state fields.

### Non-Functional Requirements

**NFR-1**: Compilation correctness. Adding `'hermes'` to the `Backend` enum must produce TS errors at every dispatch site that currently switches on backend, ensuring no silent fall-through to claude. Switch statements in `backend-spawn.ts`, `spawn-morty.ts`, and `mux-runner.ts` must explicitly handle the new variant.

**NFR-2**: Honest identity. `state.backend`, `tmux-runner.log` per-iteration banners, `jar-runner.log` per-task banners, and `metrics.js` session attribution must all report `'hermes'` — never `'claude'` or `'codex'` — when the hermes backend is selected.

**NFR-3**: Failure isolation. A missing `hermes` binary at setup time must not corrupt the session state directory; it must fail before any file is written.

**NFR-4**: Toolset list integrity. State-sourced toolsets are whitespace-trimmed and empty entries are omitted before passing `--toolsets` to Hermes.

**NFR-5**: Renamed-helper backward compat. `evaluateCodexManagerRelaunch` (just shipped via T2 in v1.63.0) gets a deprecation alias for one minor cycle before removal. Callers in `mux-runner.ts` and `microverse-runner.ts` updated; old name re-exports for any out-of-tree callers.

## Technical Design

### Type & Constant Changes

`extension/src/types/index.ts:53-55`:
```ts
export type Backend = 'claude' | 'codex' | 'hermes';
export const BACKENDS: readonly Backend[] = ['claude', 'codex', 'hermes'] as const;
```

State extension:
```ts
export interface State {
  // ... existing fields ...
  hermes_toolsets?: string[];      // NEW — set at session creation when --backend hermes
  hermes_provider?: string;        // NEW — optional provider override
  hermes_model?: string;           // NEW — optional model override
  codex_manager_relaunch_count?: number; // shared compatibility counter for codex/hermes relaunch
}
```

### New Builder

`extension/src/services/backend-spawn.ts`:
```ts
function buildHermesInvocation(opts: WorkerOpts): SpawnInvocation {
  const args = ['chat', '-q', opts.prompt, '-Q'];
  if (opts.toolsets?.length) args.push('--toolsets', opts.toolsets.join(','));
  if (opts.provider) args.push('--provider', opts.provider);
  if (opts.model) args.push('-m', opts.model);
  return { cmd: 'hermes', args, backend: 'hermes' };
}
```

Manager and judge variants follow the same pattern. Judge variant restricts toolsets to read-only equivalents (TBD — see Open Question 2).

### Spawn Site Wiring

The spawn sites already dispatch via `buildWorkerInvocation(backend)` or `buildManagerInvocation(backend)` and pass backend identity through `backendEnvOverrides`.

### Output Parser Extension

Mode-3 in `mux-runner.ts:extractAssistantContent` (only added if hermes' stdout shape differs):
```ts
if (backend === 'hermes') {
  // hermes -q -Q emits plain text on stdout; strip ANSI, treat as assistant content
  return stripAnsi(stdout);
}
```

`classifyCompletion` regex set unchanged — promise tokens are prompt-driven.

### Manager Relaunch Generalization

`extension/src/services/codex-manager-relaunch.ts` remains the compatibility module. `evaluateCodexManagerRelaunch` adds Hermes to the eligible backend set:

```ts
export function evaluateCodexManagerRelaunch(state: State, hasPendingWork: boolean): RelaunchEvaluation {
  if (state.backend !== 'codex' && state.backend !== 'hermes') {
    return { should_relaunch: false, reason: 'wrong_backend', current_count: 0, cap: CAP };
  }
  // ... rest unchanged
}
```

### CLI Surface (setup.ts additions)

```
state.hermes_toolsets: ["terminal","file"]         Passed to hermes via --toolsets
state.hermes_provider: "openai"                    Passed to hermes via --provider
state.hermes_model: "gpt-5-pro"                    Passed to hermes via -m
state.hermes_max_turns: 9                          Passed to hermes via --max-turns
```

Validation:
- Empty toolset entries are omitted before spawn
- These values are honored only when `state.backend === 'hermes'`

## Verification

### Test Plan

`extension/tests/backend-spawn-hermes.test.js` (NEW):
- T1: `buildHermesInvocation` returns `{cmd: 'hermes', args: ['chat', '-q', <prompt>, '-Q']}` for minimal opts
- T2: Toolsets present → args include `-t terminal,file,code_execution`
- T3: Provider present → args include `--provider openai`
- T4: Model present → args include `-m gpt-5-pro`
- T5: All three present → all flags in args, in correct order
- T6: Empty toolsets array → no `--toolsets` flag emitted
- T7: Manager variant matches worker shape with manager-specific prompt
- T8: Judge variant restricts to read-only toolsets (per Open Question 2 resolution)

`extension/tests/setup-hermes.test.js` (NEW):
- T9: `--backend hermes` without hermes on PATH → exit non-zero, no session dir created
- T10: `--backend hermes` with version mismatch → exit non-zero, actionable error
- T11: `--backend hermes --hermes-toolsets terminal,file` → state.hermes_toolsets persisted
- T12: `--backend hermes --hermes-toolsets ""` → reject with parse error
- T13: `--backend hermes` + `--teams` → conflict error matching codex pattern

`extension/tests/hermes-version-smoke.test.js` (NEW, mirrors `codex-version-smoke.test.js`):
- T14: `engines.hermes` pin enforces caret semantics
- T15: Missing `engines.hermes` → die with named error

`extension/tests/manager-relaunch.test.js` (RENAMED from codex-manager-relaunch.test.js):
- Existing codex tests preserved
- T16: `state.backend === 'hermes'`, count below cap → should_relaunch=true
- T17: `state.backend === 'hermes'`, at cap → should_relaunch=false
- T18: Old `evaluateCodexManagerRelaunch` re-export still works (backward compat)

`extension/tests/mux-runner-hermes.test.js` (NEW, conditional on FR-10 mode-3):
- T19: stdout with ANSI → stripped, content extracted
- T20: Promise tokens detected in hermes output

### Acceptance Criteria

- [ ] `Backend` type accepts `'hermes'` — Verify: `npx tsc --noEmit` clean — Type: typecheck
- [ ] `BACKENDS` array includes `'hermes'` — Verify: `node --test extension/tests/backend-spawn-hermes.test.js` — Type: test
- [ ] `buildHermesInvocation` returns correct shape — Verify: same — Type: test
- [ ] `setup.ts` rejects missing hermes binary — Verify: `node --test extension/tests/setup-hermes.test.js` — Type: test
- [ ] `setup.ts` enforces `engines.hermes` version pin — Verify: `node --test extension/tests/hermes-version-smoke.test.js` — Type: test
- [ ] `--hermes-toolsets` parsed and persisted — Verify: same — Type: test
- [ ] `--teams + hermes` conflict rejected — Verify: same — Type: test
- [ ] `evaluateManagerRelaunch` honors hermes backend — Verify: `node --test extension/tests/manager-relaunch.test.js` — Type: test
- [ ] Backward-compat re-export works — Verify: same — Type: test
- [ ] Output classifier handles hermes stdout — Verify: `node --test extension/tests/mux-runner-hermes.test.js` (if mode-3 needed) — Type: test
- [ ] Full test suite passes — Verify: `npm test` — Type: test
- [ ] Type checker clean — Verify: `npx tsc --noEmit` — Type: typecheck
- [ ] ESLint clean — Verify: `npx eslint src/ --max-warnings=-1` — Type: lint

### Manual Verification (CUJs)

1. Run a Pickle epic with `--backend hermes` on a small ticket; confirm `state.backend === 'hermes'` and worker output captured
2. Mixed-backend jar batch with all four backends in sequence; confirm each task spawns the right CLI and ENOENT on hermes binary fails-the-task-not-the-batch
3. (If hermes has a session timeout) Verify codex-manager-relaunch (now manager-relaunch) fires for hermes the same way it fires for codex

## Assumptions

- A1: `hermes chat -q "<query>" -Q` exits cleanly when the query completes (deterministic stdout termination, not a streaming TUI). If hermes streams indefinitely, FR-10 needs revision.
- A2: `hermes chat -q -Q` returns assistant output on stdout (not stderr or a separate file). If output goes elsewhere, capture path needs adjustment.
- A3: Hermes version string is parseable by the same caret semver helper used for codex (`parseCodexVersion` → likely promote to `parseSemverVersion` for reuse).
- A4: Hermes' tool-call shape does NOT need to be parsed by Pickle — promise tokens (`<promise>TASK_COMPLETED</promise>`) are sufficient for completion detection. If hermes interrupts its own emit-token sequence with tool-call rendering, FR-10 needs a tool-call-aware extractor.
- A5: `bash install.sh` deploy parity check (`assertSchemaVersionDeployParity`) does NOT need to extend to backend-specific binaries — the user is responsible for ensuring `hermes` is on PATH on every machine.
- A6: T2 (codex-manager-relaunch extraction) ships in v1.63.0 before this PRD starts; `services/codex-manager-relaunch.ts` exists at HEAD when this work begins.

## Risks

| ID | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Hermes' `-q` mode is actually streaming with no terminator → mux-runner hangs waiting for exit | High | Pre-PRD smoke test: run `hermes chat -q "say hello" -Q; echo $?` and confirm clean exit. If streaming, add `--max-wall` flag pass-through or stdin-close trigger. |
| R2 | Hermes binary not available on all developer machines | Low | Pre-flight check (FR-6) fails fast with install instructions. CI never runs hermes (mocked). |
| R3 | `evaluateCodexManagerRelaunch` rename breaks the v1.63.0 trap-door entry shipped via T2 | Medium | Keep the old name as a re-export for one minor cycle. Update trap-door entry to reference both names with the deprecation timeline. |
| R4 | Adding `'hermes'` to `Backend` type breaks downstream switch statements that don't handle it (TS exhaustiveness) | Low (intentional) | NFR-1 — TS will error at every dispatch site. Fix-all-call-sites is the goal. |
| R5 | Toolset list locked at session creation may surprise users who change their mind mid-epic | Low | CUJ-3 documents the lock; resume error is actionable. Future PRD can lift the lock if requested. |
| R6 | Mode-3 stdout classifier diverges from claude/codex shapes; tested behavior drifts as hermes evolves | Medium | Pin `engines.hermes` and require explicit version bump on every CI run. Smoke test covers known stdout patterns. |
| R7 | Hermes' `--provider` flag may interact unexpectedly with `-m` (model override). For example, `--provider openai -m claude-sonnet-4-7` is incoherent | Low | Pre-flight validation: if `--provider` AND `-m` both present, log a warning and pass through anyway. Hermes is the source of truth for valid combinations. |
| R8 | The `state.flags.skip_readiness_reason` bypass shipped in v1.63.0 (BMAD P0.6) may be misused if hermes integration tickets reference NEW symbols that the readiness gate doesn't recognize. Same trap that v1.63.0 hit. | Medium | New tickets for this PRD MUST follow Agent B's PATH_RE-aware authoring style (no `extension/` prefix on NEW files; no backticks on NEW symbols). T9 (OBB-symbol-audit) when shipped will mechanize this. |
| R9 | **Hermes returns exit code 0 even on non-retryable API errors** (HTTP 400/404, bad provider, unknown toolset — Q3, Q14, Q24, Q25). A misconfigured hermes invocation looks identical to a successful one. | High | FR-10 mode-3 mandatorily scans stderr for `WARNING`/`ERROR` markers and promotes them to worker failure; FR-6 smoke check requires `--ignore-user-config` + provider-specific API key env var BEFORE first invocation; provider validation happens at session creation, not mid-iteration. |
| R10 | Hermes' SQLite session DB (`~/.hermes/sessions/sessions.db`) uses `threading.Lock()` + WAL mode (Q21). Heavy concurrent writes from jar-batch parallelism can hit `database is locked`. | Medium | NFR-3 caps hermes-backend jar-batch concurrency at ≤4 workers until benchmarked. Future PRD can lift the cap once SQLite contention is empirically characterized. |
| R11 | Hermes' `terminal` tool spawns subprocesses in a hidden shell, NOT the user's tmux pane (Q23). Operators won't see hermes' shell output the way they do for codex. | Low | Document in command docs (`pickle-jar-open.md`, `pickle-microverse.md`); attribute hermes-issued commits via timing or injected `[hermes]` prefix in the worker prompt (Q30). |

## Resolved Design Decisions

All four high-level design questions are resolved by `prds/archive/research/hermes-research.md`. Summary:

1. **Session-timeout wall?** **No** (Q2). Hermes has only an inactivity-based backend timeout that does not fire mid-task in headless `-q` mode. FR-11's hermes branch is a no-op early-return. The rename `evaluateCodexManagerRelaunch` → `evaluateManagerRelaunch` still ships for naming honesty.

2. **Built-in read-only mode for the judge variant?** **No** (Q15). Hermes has no `--readonly` flag. Judge variant restricts toolsets to read-only retrieval (`search`, `web`) and explicitly omits `terminal`, `file`, `write_file`, `patch`, `code_execution`. The same `--ignore-rules --ignore-user-config` flags carry through to keep the judge isolated from user config / preloaded skills.

3. **State-schema migration v3 → v4 for the rename?** **No.** Stay at schema v3. Canonical field name becomes `manager_relaunch_count`; `codex_manager_relaunch_count` is accepted as an alias at read time for one minor cycle. Recommendation in PRD draft confirmed.

4. **Activity event naming?** Emit `manager_relaunch` with `gate_payload.backend`. `codex_manager_relaunch` accepted in `VALID_ACTIVITY_EVENTS` and deprecated for one minor cycle. Recommendation in PRD draft confirmed.

## Research Questions — Hermes Behavior (ANSWERED)

✅ All 30 research questions below are answered against **Hermes Agent v0.12.0 (2026.4.30)** in `prds/archive/research/hermes-research.md`. The questions are kept here for traceability — the answers and resulting FR adjustments live in the research artifact and the §Resolved Design Decisions section above.

### Process lifecycle (Q1-Q5 → drives FR-10, FR-11, R1)

1. Does `hermes chat -q "<query>" -Q` exit cleanly (deterministic stdout terminator + exit code 0) when the query completes, or does it keep streaming/idle?
2. Is there a session-timeout wall like codex's 4-hour subprocess limit? If so, what's the trigger (idle? wall-clock? token cap?) and what's the exit signal?
3. What's the exit code on success vs different failure classes (network error, tool failure, model-side refusal, malformed query)?
4. Does `hermes` honor SIGTERM / SIGINT cleanly, or does it leak child processes (e.g. for tool execution)?
5. Does `hermes -Q` actually suppress the spinner reliably under non-TTY stdout (i.e. when our spawnSync redirects to a pipe)?

### Output format (Q6-Q10 → drives FR-10 mode-3 decision)

6. Does `hermes chat -q -Q` write assistant content to stdout, stderr, or both? If both, what's on which?
7. Is the stdout shape plain text, JSON-stream (Anthropic-style), tool-call interleaved, or something else?
8. Are tool calls and tool results interleaved with assistant text in stdout, or filtered out by `-Q`?
9. Does the output include ANSI escape sequences when stdout is a pipe (not a TTY)? If so, do we strip or accept?
10. Are there structured markers (e.g. `[tool:terminal]`) that survive into the stdout stream that our promise-token regex (`<promise>TASK_COMPLETED</promise>`) might collide with?

### CLI flags (Q11-Q17 → drives FR-3, FR-7, FR-9)

11. What does `hermes --version` output exactly? Format `hermes-cli X.Y.Z`, or just `X.Y.Z`, or something else? Drives the smoke-check regex (parallel to codex's `parseCodexVersion`).
12. Is `-t terminal,file,code_execution` the canonical toolset list, or is it a superset/subset? What's the full enumerated allowlist?
13. Does `--provider <name>` accept a closed set (`openai`, `anthropic`, `local`, ...) or an open string? What happens with unknown providers?
14. Does `-m <model>` semantics depend on the active `--provider`? Is `-m gpt-5-pro --provider anthropic` a hard error or a no-op?
15. Is there a `--readonly` / `--no-write` / sandbox flag for the judge variant?
16. Is there a `--max-turns` or `--max-tools` budget flag for the headless mode (analogous to codex's `--max-iterations`)?
17. Does `-w` interactive mode share state with `-q` headless mode (e.g. shared session history file)?

### Configuration & environment (Q18-Q20 → drives R2, defends against codex `v1.59.1` literal-bleed class)

18. Does `hermes` read a config file (`~/.hermes/config`, `~/.config/hermes/`, env-driven path)? What's the precedence order between config-file values, env vars, and CLI flags?
19. Are there `--ignore-rules` / `--ignore-user-config` equivalents (like codex `v1.59.1` needed)? Could a stale `~/.hermes/skills/pickle*` registry misdirect mid-iteration the way codex did?
20. Which env vars does `hermes` read? (`HERMES_API_KEY`? `HERMES_PROVIDER`? `OPENAI_API_KEY` pass-through?)

### Concurrency & sandbox (Q21-Q23 → drives jar-batch behavior, NFR-3)

21. Can multiple `hermes chat -q` processes run concurrently against the same working directory without locking each other out (e.g. via a session DB)?
22. Does `hermes` respect `cwd` set by the parent process (Node's `spawn({cwd})`), or does it `chdir` to its own discovered project root?
23. When `-t terminal,code_execution` is enabled, does hermes spawn its own subprocesses in our session's tmux pane (visible to the user) or in a hidden subshell?

### Failure modes (Q24-Q27 → drives error-handling design, NFR-3)

24. What happens when a toolset listed in `-t` is unrecognized? Hard error (exit nonzero) or silent skip with warning?
25. What happens when `--provider` is set but the corresponding API key env var is unset? Pre-flight error or runtime mid-stream failure?
26. What's the rate-limit behavior on the underlying provider? Does `hermes` retry internally, or does the call return a partial response with a marker?
27. When stdin is closed (EOF before query response), does hermes exit cleanly or hang?

### Comparison vs codex (Q28-Q30 → informs prompt design, defends against v1.56.x bug class)

28. Does hermes have an equivalent of codex's `MANAGER_FALSE_EPIC_COMPLETED` failure pattern (model claims completion when artifacts disagree)? If yes, the `evaluateEpicCompletion()` recovery state machine (shipped in v1.56.4) needs to be backend-agnostic.
29. Does hermes interpret prompt rules literally the way codex does (`v1.56.1` "ONLY"/"NEVER" trap)? Affects worker-prompt phrasing — if yes, `send-to-morty.md` rule rewrites apply to hermes too.
30. Are hermes-emitted commit messages structurally distinguishable in `git log` output (e.g. `[hermes]` prefix), or do we need to attribute via timing? Affects metrics attribution.

## Session Context (for resuming after `/clear`)

This PRD was drafted on 2026-05-01 during the v1.63.0 overnight bundle run. Relevant context for picking up the work:

### Why this PRD exists

- Pickle Rick currently supports two production backends: `claude` (default) + `codex`
- A third backend `deepseek` is queued at `prds/archive/features/deepseek-integration.md` (Draft, not started — uses Anthropic-compat shim, rides `claude` CLI)
- This PRD adds a fourth: `hermes` — first-party CLI, more like codex than deepseek
- User invocation pattern provided: `hermes chat -q "query" -Q [-t toolsets] [--provider X] [-m model]`

### Current state of the codebase (relevant fragments)

- `Backend` type at `extension/src/types/index.ts:87` is currently `'claude' | 'codex'`
- `BACKENDS` array on next line
- Backend dispatch in `extension/src/services/backend-spawn.ts` has `buildClaudeWorkerInvocation` and `buildCodexInvocation`
- Codex version smoke check at `extension/src/bin/setup.ts:355` — `resolveCodexVersionForSetup`
- `engines.codex` pin in `extension/package.json` (currently `^0.125.0` after engine-pin bump in commit `80d9c05`)
- `evaluateCodexManagerRelaunch` extracted as `extension/src/services/codex-manager-relaunch.ts` per **T2 of the v1.63.0 bundle** (just shipped at session `2026-04-30-bc104e78`, ticket `8ad7c134`, commit `c5cdb6e`). FR-11 of this PRD generalizes that helper to be backend-aware.

### Key dependencies between this PRD and v1.63.0

- T2 (codex-manager-relaunch extraction) MUST be in main before this PRD starts
- FR-11 renames the just-extracted helper to `manager-relaunch.ts` and parameterizes by backend
- Backward compat: keep `codex-manager-relaunch.ts` as a re-export shim for one minor cycle

### Lessons from v1.63.0 (that this PRD must heed)

- **PATH_RE word-boundary trap**: the readiness gate at `extension/src/bin/check-readiness.ts` scans tickets for paths and treats NEW files (not yet on disk) as phantom symbols. Agent B's analysis: `\b` word-boundary strips the leading dot from `.claude/commands/...` paths. Workaround for tickets in this PRD: don't prefix NEW file paths with `extension/`; use plain prose instead. R8 in §Risks captures this.
- **`--skip-readiness <reason>` flag** shipped in v1.63.0 (Agent A, commit `deac6c5`); set via `state.flags.skip_readiness_reason`. This PRD's tickets should follow Agent B's authoring style and NOT need the flag.
- **T9 (OBB-symbol-audit)** in current bundle, when shipped, will mechanize the symbol-grounding check during refinement — protects future bundles from authoring phantom-symbol tickets.

### What user asked for explicitly

- "could pickle loops support invoking hermes agent? here is how hermes is invoked: ..."
- Then: "draft it"
- Then: "give me a list of open questions for the prd in a list"
- Then: "give me the specific questions about hermes behavior to research"
- Then: "save all the hermes context and questions in the prd so I can clear context"

### Recommended next action when resumed

1. ✅ ~~Run the 30 research questions above as a structured hermes smoke test; capture answers in `prds/archive/research/hermes-research.md`~~ — DONE (2026-05-01)
2. ✅ ~~Resolve Open Questions 1-4 based on research findings~~ — DONE; see §Resolved Design Decisions
3. ✅ ~~Update FR-3, FR-10, FR-11 as needed based on actual hermes shape~~ — DONE; FR-3, FR-6, FR-7, FR-10, FR-11 all updated; FR-9 version regex specified; new R9, R10, R11 added.
4. **NEXT**: Refine PRD into atomic tickets via `/pickle-refine-prd` and bundle into the next overnight run after v1.63.0 ships.

## Impact

- **State schema**: 3 new optional fields (`hermes_toolsets`, `hermes_provider`, `hermes_model`) + 1 renamed (`manager_relaunch_count` aliased). No migration if Open Question 3 resolved as alias-only.
- **CLI surface**: 3 new flags on `setup.js`. Documented in pickle command docs.
- **Trap doors**: 1 new entry in `extension/CLAUDE.md` for `services/manager-relaunch.ts`.
- **Tests**: ~20 new tests across 4 new test files + 1 renamed file.
- **LOC estimate**: ~350-450 LOC source + ~250 LOC tests = **~600-700 LOC total**.
- **Backward compat**: Existing `codex_manager_relaunch_count` field, `evaluateCodexManagerRelaunch` function, and `codex_manager_relaunch` activity event all preserved as aliases for one minor cycle.

## Stakeholders

- **Author/Implementer**: Pickle Rick (autonomous via /pickle-pipeline)
- **Reviewer**: Gregory Dickson
- **Affected systems**: `mux-runner`, `microverse-runner`, `jar-runner`, `spawn-morty`, `setup`, `metrics`, `pickle-jar-open`
- **Documentation owners**: pickle command authors (commands in `.claude/commands/`)

## Rollout

1. Land in a follow-up bundle PRD (post-v1.63.0). Estimated 2-3 day overnight run.
2. Smoke test: a single small ticket with `--backend hermes` on a real hermes binary before promoting to default jar batch use.
3. Post-rollout: collect metrics on hermes vs codex on the same ticket class for 2 weeks; report findings.
4. If hermes stalls or hangs reproducibly → roll back via `--backend hermes` ENOENT (hermes isn't required for the existing claude/codex workflows).

## Reference Links

- Hermes invocation pattern (from user): `hermes chat -q "query" -Q [-t toolsets] [--provider X] [-m model]`
- Existing deepseek-integration PRD (Shape A pattern): `prds/archive/features/deepseek-integration.md`
- T2 codex-manager-relaunch extraction (in flight): session `2026-04-30-bc104e78` ticket `8ad7c134`
- Backend type definition: `extension/src/types/index.ts:87`
- Backend dispatch site: `extension/src/services/backend-spawn.ts`
- Setup smoke check pattern: `extension/src/bin/setup.ts:355` (`resolveCodexVersionForSetup`)
