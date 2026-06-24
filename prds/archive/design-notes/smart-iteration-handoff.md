# PRD: Smart Iteration Handoff & Autonomous Run Intelligence (Refined)

## Problem

Long automated runs (pickle-tmux, microverse, anatomy-park, szechuan-sauce) waste iterations because:

1. **Inter-iteration knowledge is thin.** `tmux-runner` clears context each iteration (by design), but the handoff carries only skeleton data. Iteration N+1 doesn't know *why* N's approach failed, what files were tricky, or what the model discovered.

2. **Stall recovery is binary.** `microverse-runner` detects stalls and does one thing: rollback and retry. But "stalled" has distinct root causes needing different recovery strategies.

3. **All tickets get equal treatment.** A trivial rename gets the same iteration budget and review depth as a multi-file architectural change.

4. **Quality passes use a single model.** Meeseeks/szechuan-sauce runs every pass with the same model.

5. **Agents game linter configs.** LLMs modify `.eslintrc`, `tsconfig.json`, etc. to suppress violations instead of fixing code.

**Target metric:** Reduce wasted iterations by 30%+ in microverse and 20%+ in tmux runs. **Definition:** A "wasted iteration" is one where `action === 'revert'` OR `postIterSha === preIterSha` (no commits produced). *(refined: risk-scope)*

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Regression in hot-path runners | Critical — all automated runs break | Medium | Feature flags per subsystem, try/catch boundaries |
| TASK_NOTES.md bloats context | High — model truncation | Medium | Hard cap 2000 chars, section-aware truncation |
| Config-protection false positives | Medium — legitimate tickets blocked | Medium | Per-ticket `config_change: true` override |
| Opus routing cost explosion | Medium — unexpected API spend | Low-Medium | `max_opus_passes` setting (default: 3) |
| `approach_exhaustion` infinite loop | Critical — run never terminates | Low | Max 1 reset per session. Second occurrence → bail |
| install.sh overwrites PreToolUse hooks | High — breaks GitNexus/RTK | Certain | Add PreToolUse merge block to install.sh |

*(refined: risk-scope)*

## Feature Flags

Each subsystem has a `pickle_settings.json` kill switch. Default: `true`. When `false`, subsystem is skipped and current behavior preserved. Each integration point wraps in try/catch so failures log but don't crash the runner.

```json
{
  "enable_task_notes": true,
  "enable_failure_classification": true,
  "enable_complexity_tiers": true,
  "enable_config_protection": true,
  "enable_model_tiers": true
}
```

*(refined: risk-scope, requirements)*

## Critical User Journeys

### CUJ 1: Microverse Stall Recovery
1. Operator launches `/pickle-microverse` targeting test coverage metric
2. Iterations 1-3 improve coverage from 40% to 55%
3. Iterations 4-6 produce identical 55% scores → `approach_exhaustion` classified
4. Runner injects recovery text into TASK_NOTES.md `## Next` section
5. Iteration 7 reads TASK_NOTES.md, tries fundamentally different approach
6. If iterations 7-8 also exhaust → bail with `exit_reason='approach_exhaustion'`
7. Final report shows failure classification distribution

### CUJ 2: Mixed-Tier Tmux Run
1. Operator runs `/pickle-tmux` with 5 tickets: 2 trivial, 2 small, 1 large
2. Trivial tickets get haiku model, 5-iteration budget
3. If trivial ticket exhausts budget → runner marks `status: 'budget_exhausted'`, moves to next
4. Final report shows per-ticket tier, iteration count, budget status

### CUJ 3: Config Protection Override
1. Ticket frontmatter includes `config_change: true`
2. Worker attempts to edit tsconfig.json
3. Config-protection handler checks frontmatter, finds override, approves edit
4. Without override: handler blocks the edit silently

### CUJ 4: Quality Pass Model Progression
1. Operator runs `/meeseeks` with 6 configured passes
2. Passes 1-2: haiku. Passes 3-4: sonnet. Passes 5+: opus (capped by `max_opus_passes`)
3. Activity log shows model used per pass

*(refined: requirements)*

---

## Scope

Five subsystems, all surgical insertions into existing infrastructure.

### Subsystem A: TASK_NOTES.md (Inter-iteration Context)

A worker-maintained markdown file that persists across context-clearing iterations. The worker reads it at start, updates it before finishing.

**Current state:** `buildMicroverseHandoff()` writes `handoff.txt` with stall counter, history entries, failed approaches. For `mux-runner.ts`, handoff is just `state.json`.

**Target state:** Workers maintain `TASK_NOTES.md` in the session directory. `mux-runner.ts` reads it at the prompt injection point (L381-394) and injects alongside `handoff.txt`. `buildMicroverseHandoff()` does NOT include TASK_NOTES.md — it generates metric/state handoff only. This prevents double injection in microverse runs. *(refined: codebase)*

#### TASK_NOTES.md Truncation

When content exceeds 2000 chars, apply section-priority truncation:
1. Keep `## Next` in full (most actionable)
2. Keep `## Dead Ends` in full (prevents re-exploration)
3. Keep `## Key Discoveries` in full (institutional knowledge)
4. Truncate `## Progress` from oldest entries first
5. If still over limit, truncate `## Key Discoveries` from oldest

*(refined: requirements)*

#### Integration Points

| File | Change |
|------|--------|
| `mux-runner.ts` L381-394 | Read `TASK_NOTES.md` from session dir, inject into prompt alongside `handoff.txt`. Apply 2000-char truncation. ONLY injection point — no injection in `buildMicroverseHandoff()` |
| `.claude/commands/send-to-morty.md` | Add instruction: "Read `TASK_NOTES.md` in your session dir at start. Update it before you finish." |
| `.claude/commands/meeseeks.md` | Same instruction |
| `.claude/commands/szechuan-sauce.md` | Same instruction |
| `templates/microverse.md` | Same instruction |

TASK_NOTES.md lives in the session root dir. No concurrent write hazard — mux-runner iterations are serial (`await runIteration()`). *(refined: codebase, requirements)*

---

### Subsystem B: Classified Failure Recovery

Replace binary stall detection with categorized failure modes and per-category recovery strategies.

#### Failure Taxonomy

```typescript
type FailureClass =
  | 'tool_failure'         // command/test errors, env issues
  | 'approach_exhaustion'  // same score plateau, variations of same idea
  | 'regression'           // score went backwards
  | 'metric_unstable'      // metric returns inconsistent scores on same code
  | 'no_progress';         // no commits produced, worker did nothing useful

// context_drift deferred to v2 — requires structured expected_files in ticket metadata
// which doesn't exist yet (refined: all three analysts converged on this)

interface ClassifiedFailure {
  failure_class: FailureClass;
  evidence: string;
  recovery_applied: string;
}
```

*(refined: requirements, codebase, risk-scope — `context_drift` deferred, unanimous finding)*

#### Classification Priority (first match wins)

1. `tool_failure` — metric command error overrides all (can't measure = can't classify further)
2. `metric_unstable` — alternating pattern across 4+ entries
3. `regression` — score went backwards
4. `approach_exhaustion` — 3+ consecutive non-improving iterations (check `stall_counter >= 3` AND no `action === 'accept'` with `classification === 'improved'` in last 3 entries)
5. `no_progress` — no commits produced (lowest priority)

Recovery actions are exclusive — apply only the highest-priority match's recovery. *(refined: requirements)*

#### `approach_exhaustion` Detection (corrected)

`MicroverseHistoryEntry.action` is typed `'accept' | 'revert'`. There is no `'held'` action value — `'held'` is a `classification` return from `compareMetric()` that gets `action: 'accept'`. To detect held-plateau, the `classification` field must be persisted on `MicroverseHistoryEntry`:

```typescript
export interface MicroverseHistoryEntry {
  // ... existing fields ...
  classification?: 'improved' | 'held' | 'regressed';  // NEW — persisted for pattern detection
  failure_class?: FailureClass;                          // NEW — orthogonal to classification
}
```

Detection: Last 3 entries have `action === 'revert'` OR `classification === 'held'`. *(refined: codebase)*

#### `approach_exhaustion` Termination Guard

`approach_exhaustion` can fire at most once per session. Track via `approach_exhaustion_fired: boolean` on `MicroverseSessionState`. Second occurrence → bail with `exit_reason='approach_exhaustion'`. This prevents infinite loops when `stall_limit <= 2`. *(refined: risk-scope)*

#### `metric_unstable` Recovery (revised)

When alternating pattern detected across 4+ entries:
1. Run metric 3x (serial, using existing per-measurement timeout from `key_metric.timeout_seconds`), take median
2. Use median as the official score for this iteration
3. Log variance to activity events
4. If variance > 20% for 2 consecutive iterations, bail with `exit_reason='metric_unstable'`

Do NOT switch `convergence_mode`. Worker-managed convergence is out of scope for v1. *(refined: requirements, codebase, risk-scope — unanimous)*

#### `measureMetric()` Error Propagation

`measureMetric()` at `microverse-runner.ts:40-68` returns `null` on failure but does NOT propagate error details to the caller (stderr goes to `process.stderr`, not the return value). For `tool_failure` classification, detection checks ONLY `result === null`. Error detail for TASK_NOTES.md injection uses a generic message: "Metric command failed." Also applies to `measureLlmMetric()` at `microverse-runner.ts:138-176` for `type: 'llm'` metrics. *(refined: codebase)*

#### `recordIteration()` Signature (corrected)

The existing `classification` parameter is SEPARATE from `FailureClass`:

```typescript
export function recordIteration(
  state: MicroverseSessionState,
  entry: MicroverseHistoryEntry,
  classification?: 'improved' | 'held' | 'regressed',  // EXISTING param
  failureClass?: FailureClass                            // NEW — appended
): MicroverseSessionState
```

*(refined: codebase)*

#### Recovery Text Templates

Injected into TASK_NOTES.md `## Next` section, replacing previous recovery text (marked with `<!-- recovery -->` HTML comment):

| FailureClass | Injected Text |
|---|---|
| `tool_failure` | `<!-- recovery -->METRIC COMMAND FAILED. Before optimizing, verify the metric runs. Check for missing deps or env issues.` |
| `approach_exhaustion` | `<!-- recovery -->APPROACH EXHAUSTED. Last {n} iterations tried variations of the same idea. You MUST try a fundamentally different strategy. See ## Dead Ends.` |
| `regression` | `<!-- recovery -->REGRESSION. Last change made the metric worse. It has been reverted. See ## Dead Ends.` |
| `metric_unstable` | `<!-- recovery -->METRIC UNSTABLE. Scores are inconsistent on the same code. Focus on changes with large, unambiguous impact.` |
| `no_progress` | `<!-- recovery -->NO PROGRESS ({n} consecutive). Focus on ONE small, testable change. Do not plan — act.` |

Previous `<!-- recovery -->` block is moved to `## Dead Ends` when replaced. *(refined: requirements)*

#### Integration Points

| File | Change |
|------|--------|
| `types/index.ts` | Add `FailureClass` (5 values), `ClassifiedFailure`. Extend `MicroverseSessionState` with `failure_history: ClassifiedFailure[]` and `approach_exhaustion_fired: boolean`. Extend `MicroverseHistoryEntry` with optional `classification` and `failure_class` |
| `services/microverse-state.ts` | Add `classifyFailure()`. Persist `classification` parameter in history entry (currently discarded at L76-78). Add `failureClass` as 4th param to `recordIteration()` |
| `bin/microverse-runner.ts` | After metric comparison, classify failure and inject recovery into TASK_NOTES.md. Handle both `measureMetric()` and `measureLlmMetric()` paths |
| `bin/microverse-runner.ts` `writeFinalReport()` | Add failure classification distribution section |

---

### Subsystem C: Complexity-Tiered Pipeline Depth

#### Tier Definitions

| Tier | Pipeline Depth | Model | Max Iterations |
|------|---------------|-------|----------------|
| `trivial` | implement → test | haiku | 5 |
| `small` | implement → test → review | sonnet | 15 |
| `medium` | research → plan → implement → test → review | sonnet | 30 |
| `large` | research → plan → implement → test → review → fix → final-review | opus | 50 |

If a ticket exhausts its tier budget, runner marks `status: 'budget_exhausted'` in state.json and continues to next ticket. Final report lists budget-exhausted tickets. Manual re-tiering via frontmatter edit + re-run is the v1 escape hatch. *(refined: requirements)*

#### Integration Points

| File | Change |
|------|--------|
| `services/pickle-utils.ts` `TicketInfo` L187 | Add `complexity_tier?: 'trivial' \| 'small' \| 'medium' \| 'large'`. **NOT in `types/index.ts`** — `TicketInfo` lives in `pickle-utils.ts` |
| `services/pickle-utils.ts` `parseTicketFrontmatter()` L198 | Parse `complexity_tier` field (1 line) |
| `bin/spawn-morty.ts` L141-150 | **NEW**: Read ticket tier, add `--model` flag to `cmdArgs`. Currently has zero `--model` support — this adds 5+ lines of new logic (read ticket, parse frontmatter, map tier to model, push to args) |
| `bin/spawn-refinement-team.ts` | Add classification instruction to refinement worker prompts |
| `bin/mux-runner.ts` | Respect tier for per-ticket iteration budget |
| `services/pickle-utils.ts` `buildHandoffSummary()` L288 | Display tier in handoff context |

Default: `medium` (backward compatible). Model shorthand (`haiku`/`sonnet`/`opus`) — `claude` CLI resolves to full IDs. *(refined: codebase)*

---

### Subsystem D: Config-Tamper Protection

A PreToolUse hook that blocks edits to config files during automated runs.

#### PreToolUse Hook Input Schema

PreToolUse hooks receive a DIFFERENT schema from `HookInput` (which is for Stop hooks):

```typescript
interface PreToolUseInput {
  tool_name: string;       // "Write" | "Edit" | "Bash" | etc.
  tool_input: {
    file_path?: string;    // Write/Edit target
    command?: string;       // Bash command
    [key: string]: unknown;
  };
  session_id?: string;
}
```

*(refined: codebase)*

#### Handler Coverage

1. **Write/Edit** — check `tool_input.file_path` against blocklist
2. **Bash** — parse `tool_input.command` for file-modifying ops (`sed`, `awk`, `echo >`, `cat >`) targeting config files
3. **All other tools** — approve

#### Config Override

Tickets with `config_change: true` in YAML frontmatter bypass config protection for ALL protected files (all-or-nothing in v1). Handler logs: "Config protection bypassed for ticket: {id}". *(refined: requirements, risk-scope)*

#### Integration Points

| File | Change |
|------|--------|
| **NEW:** `extension/src/hooks/handlers/config-protection.ts` | ~60 lines. Source path matches `stop-hook.ts` convention. Compiled JS: `extension/hooks/handlers/config-protection.js`. Handles Write, Edit, AND Bash tool detection. Only active when session state exists and `active === true` |
| `.claude/settings.json` | Add PreToolUse hook entry. Matcher: `Write\|Edit\|Bash` |
| `install.sh` | **PREREQUISITE**: Add PreToolUse merge block following existing Stop/PostToolUse pattern. Without this, deployed `~/.claude/settings.json` PreToolUse hooks (GitNexus, RTK) are destroyed |

*(refined: codebase, risk-scope)*

---

### Subsystem E: Tiered Model Routing for Quality Passes

#### Routing Logic

Uses a **meeseeks-specific pass counter** (not the outer loop iteration number):

```typescript
let meeseeksPassCount = 0;
// Inside loop, after iteration++:
if (templateName === 'meeseeks.md' || templateName === 'szechuan-sauce.md') meeseeksPassCount++;
// Use meeseeksPassCount for model tier routing
```

| Pass | Focus | Model |
|------|-------|-------|
| 1-2 | Formatting, imports, dead code | haiku |
| 3-4 | Logic, complexity, refactoring | sonnet |
| 5+ | Architecture, type system, invariants | opus (capped by `max_opus_passes`) |

*(refined: codebase, requirements)*

#### Integration Points

| File | Change |
|------|--------|
| `bin/mux-runner.ts` `loadMeeseeksModel()` | Extend to accept pass count, return tier-appropriate model. Call INSIDE loop body (currently called once outside loop at L665) |
| `bin/mux-runner.ts` main loop | Add `meeseeksPassCount`, increment when template is quality pass |
| `pickle_settings.json` | Add optional `meeseeks_model_tiers` config AND `max_opus_passes` (default: 3) |

*(refined: codebase, risk-scope)*

---

## Acceptance Criteria

### Subsystem A: TASK_NOTES.md

- [ ] **A1**: Worker prompt templates (send-to-morty.md, meeseeks.md, szechuan-sauce.md, microverse.md) include instruction to read and update `TASK_NOTES.md`
- [ ] **A2**: `mux-runner.ts` reads `TASK_NOTES.md` from session dir and injects into prompt — capped at 2000 chars with section-aware truncation (keep `## Next`, `## Dead Ends` full; trim `## Progress` from oldest)
- [ ] **A3**: Missing or empty `TASK_NOTES.md` is handled gracefully (no error, empty string)
- [ ] **A4**: `enable_task_notes` flag in `pickle_settings.json` disables injection when `false`

### Subsystem B: Classified Failure Recovery

- [ ] **B1**: `classifyFailure()` function exported from `microverse-state.ts`, handles all 5 classes
- [ ] **B2**: All 5 failure classes have unit tests — Verify: `npm test -- --grep classifyFailure`
- [ ] **B3**: `approach_exhaustion` detects 3+ consecutive non-improving via `stall_counter >= 3` AND last 3 entries lacking `classification === 'improved'`
- [ ] **B4**: `metric_unstable` runs metric 3x using `key_metric.timeout_seconds`, logs variance to activity events
- [ ] **B5**: Recovery text injected into TASK_NOTES.md `## Next` section using `<!-- recovery -->` delimiter. Previous recovery moved to `## Dead Ends`
- [ ] **B6**: `failure_history` array populated after each classified failure
- [ ] **B7**: `no_progress` bails after 3 consecutive with `exit_reason='no_progress'`
- [ ] **B8**: `approach_exhaustion` resets stall_counter to `stall_limit - 2`. Max 1 reset per session — second occurrence bails with `exit_reason='approach_exhaustion'`
- [ ] **B9**: `classification` field persisted in `MicroverseHistoryEntry` (no longer discarded)
- [ ] **B10**: `writeFinalReport()` includes failure classification distribution (count per class)
- [ ] **B11**: All new fields optional — `readMicroverseState()` defaults `failure_history` to `[]` and `approach_exhaustion_fired` to `false` when missing
- [ ] **B12**: `enable_failure_classification` flag disables classification when `false` — falls through to existing stall logic

### Subsystem C: Complexity Tiers

- [ ] **C1**: `TicketInfo` in `pickle-utils.ts` (NOT `types/index.ts`) includes optional `complexity_tier`
- [ ] **C2**: `parseTicketFrontmatter()` reads `complexity_tier`, defaults to `'medium'`
- [ ] **C3**: `spawn-morty.ts` adds `--model` flag to `cmdArgs` based on tier (NEW capability — haiku/sonnet/opus shorthand)
- [ ] **C4**: Refinement worker prompts include classification instructions
- [ ] **C5**: Tickets exhausting tier budget get `status: 'budget_exhausted'`, runner continues to next
- [ ] **C6**: `enable_complexity_tiers` flag disables tier routing when `false`

### Subsystem D: Config Protection

- [ ] **D1**: Handler at `extension/src/hooks/handlers/config-protection.ts` (~60 lines)
- [ ] **D2**: Handler reads `PreToolUseInput` (NOT `HookInput`) — checks `tool_name` and `tool_input`
- [ ] **D3**: Handles Write/Edit (file_path check) AND Bash (command parse for sed/awk/echo redirect)
- [ ] **D4**: Only activates when session state exists and `active === true`
- [ ] **D5**: Tickets with `config_change: true` frontmatter bypass protection
- [ ] **D6**: `install.sh` has PreToolUse merge block (PREREQUISITE — preserves GitNexus/RTK hooks)
- [ ] **D7**: `.claude/settings.json` includes PreToolUse hook entry with matcher `Write|Edit|Bash`
- [ ] **D8**: `enable_config_protection` flag disables handler when `false`

### Subsystem E: Model Tiers

- [ ] **E1**: `loadMeeseeksModel()` accepts pass count, returns tier-appropriate model. Called per-iteration INSIDE loop body
- [ ] **E2**: Separate `meeseeksPassCount` counter (not outer iteration number)
- [ ] **E3**: Falls back to `default_meeseeks_model` when `meeseeks_model_tiers` not configured
- [ ] **E4**: `max_opus_passes` setting (default: 3) caps opus usage, falls back to sonnet
- [ ] **E5**: Model routing logged in activity events
- [ ] **E6**: `enable_model_tiers` flag disables tier routing when `false`

### Integration

- [ ] **I1**: `npx tsc --noEmit` passes
- [ ] **I2**: `npm test` passes
- [ ] **I3**: Manual smoke test: microverse run produces TASK_NOTES.md and failure classifications
- [ ] **I4**: Feature flags all default to `true` and documented in `pickle_settings.json`

## Out of Scope

- Cross-session learning (instincts/memory persistence)
- `context_drift` failure class (requires structured `expected_files` in ticket metadata — v2)
- LLM-based post-processing of iteration logs
- Changes to tmux-runner's context-clearing behavior
- Changes to stop-hook.ts decision logic
- UI/TUI changes
- Plankton's three-phase format→lint→delegate architecture

## Files Modified

| File | Subsystem | Change |
|------|-----------|--------|
| `types/index.ts` | B | Add `FailureClass` (5 values), `ClassifiedFailure`. Extend `MicroverseSessionState` with `failure_history`, `approach_exhaustion_fired`. Extend `MicroverseHistoryEntry` with `classification`, `failure_class` |
| `services/pickle-utils.ts` | C | Add `complexity_tier` to `TicketInfo` (L187). Parse in `parseTicketFrontmatter()` (L198). Display in `buildHandoffSummary()` (L288) |
| `services/microverse-state.ts` | B | Add `classifyFailure()`. Persist `classification` in history entry. Add `failureClass` as 4th param to `recordIteration()`. Default `failure_history` to `[]` in `readMicroverseState()` |
| `bin/microverse-runner.ts` | A,B | Read TASK_NOTES.md (no — mux-runner handles injection). Classify failures, apply recovery, write recovery text to TASK_NOTES.md |
| `bin/mux-runner.ts` | A,C,E | Read/inject TASK_NOTES.md at L381-394. Respect tier for iteration budget. Tiered model routing with per-pass counter |
| `bin/spawn-morty.ts` | C | **NEW**: Add `--model` flag support based on ticket tier |
| `bin/spawn-refinement-team.ts` | C | Add tier classification instruction to refinement prompts |
| `pickle_settings.json` | ALL | Feature flags, `meeseeks_model_tiers`, `max_opus_passes` |
| `.claude/settings.json` | D | Add PreToolUse hook entry with matcher `Write\|Edit\|Bash` |
| `install.sh` | D | Add PreToolUse merge block |
| **NEW:** `extension/src/hooks/handlers/config-protection.ts` | D | ~60 lines. PreToolUseInput handler |
| `.claude/commands/send-to-morty.md` | A | TASK_NOTES.md read/update instruction |
| `.claude/commands/meeseeks.md` | A | TASK_NOTES.md read/update instruction |
| `.claude/commands/szechuan-sauce.md` | A | TASK_NOTES.md read/update instruction |
| `templates/microverse.md` | A | TASK_NOTES.md read/update instruction |

## Priority

| Subsystem | Priority | Rationale |
|-----------|----------|-----------|
| A (TASK_NOTES.md) | **P0** | Improves ALL long runs. Simplest — prompt additions + file read |
| B (Failure Classification) | **P0** | Directly reduces wasted microverse iterations |
| C (Complexity Tiers) | **P1** | Reduces waste in tmux ticket runs |
| D (Config Protection) | **P1** | Prevents known failure mode. Has install.sh prerequisite |
| E (Model Tiers) | **P2** | Cost optimization |

## Implementation Task Breakdown

### Phase 1a (parallel)

| Order | ID | Title | Priority | Files |
|-------|-----|-------|----------|-------|
| 10 | T1 | Types & interfaces: FailureClass, ClassifiedFailure, MicroverseSessionState extensions, MicroverseHistoryEntry classification field | High | `types/index.ts` |
| 20 | T2 | TASK_NOTES.md worker prompt instructions | High | `send-to-morty.md`, `meeseeks.md`, `szechuan-sauce.md`, `microverse.md` |

### Phase 1b (parallel, after 1a)

| Order | ID | Title | Priority | Files |
|-------|-----|-------|----------|-------|
| 30 | T3 | TASK_NOTES.md runner injection with truncation | High | `mux-runner.ts` |
| 40 | T4 | Failure classification function + unit tests | High | `microverse-state.ts`, tests |

### Phase 1c (serial, after 1b)

| Order | ID | Title | Priority | Files |
|-------|-----|-------|----------|-------|
| 50 | T5 | Wire failure recovery into microverse main loop | High | `microverse-runner.ts` |

### Phase 2 (after Phase 1)

| Order | ID | Title | Priority | Files |
|-------|-----|-------|----------|-------|
| 60 | T6 | Complexity tier parsing + refinement prompt instructions | Medium | `pickle-utils.ts`, `spawn-refinement-team.ts` |
| 70 | T7 | Tier-based model routing in spawn-morty | Medium | `spawn-morty.ts` |
| 80 | T8 | install.sh PreToolUse merge block | Medium | `install.sh` |
| 90 | T9 | Config protection handler + settings hook entry | Medium | `config-protection.ts`, `.claude/settings.json`, tests |

### Phase 3 (after Phase 2)

| Order | ID | Title | Priority | Files |
|-------|-----|-------|----------|-------|
| 100 | T10 | Meeseeks model tiers with pass counter | Low | `mux-runner.ts`, `pickle_settings.json` |
| 110 | T11 | Feature flags in pickle_settings.json | Medium | `pickle_settings.json`, all integration points |
| 120 | T12 | Final report failure distribution + wasted iteration metric | Low | `microverse-runner.ts` |
