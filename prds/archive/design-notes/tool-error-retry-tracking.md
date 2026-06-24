# Tool Error Retry Tracking PRD
| Tool Error Retry Tracking PRD | | Intra-session tool failure tracking with escalating pivot guidance, inspired by OMC's Ralph mode |
|:---|:---|:---|
| **Author**: Gregory Dickson **Contributors**: Claude (Pickle Rick) | **Status**: Draft **Created**: 2026-03-31 | **Visibility**: Internal |

## Completion Checklist
- [x] Introduction - [x] Problem - [x] Scope - [x] CUJs - [x] Requirements - [x] Contracts - [x] Verification - [x] Tests - [x] Assumptions - [x] Risks - [x] Impact - [x] Stakeholders

## Introduction

Add intra-session tool error retry tracking to Pickle Rick. When a Claude worker hits the same tool failure repeatedly within a single session, persist retry state so the next worker spawn injects escalating guidance: first "analyze and fix before retrying," then "STOP — try a completely different approach." Mirrors OMC's `last-tool-error.json` pattern, adapted to our hook architecture using the `PostToolUseFailure` hook event.

## Bundle Implementation Notes (2026-05-03)

The P2 mega bundle implemented this PRD with a smaller public surface than the original draft:

- Handler: `extension/src/hooks/handlers/tool-error.ts`, dispatched by `node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js tool-error`.
- State file: `last-tool-error.json` in the active session directory.
- State type: `LastToolErrorState` with `{ ts, tool, error_signature, retry_count }`.
- Tests: `extension/tests/tool-error-retry.test.js`, plus worker-guidance coverage in `extension/tests/spawn-morty.test.js`.
- Guidance injection happens in `spawn-morty.ts` by reading `last-tool-error.json` before spawning the next worker; the hook response remains advisory and only returns `decision: 'approve'`.

## Problem Statement

**Current Process**: When a Morty worker or loop runner (tmux, microverse, szechuan-sauce, anatomy-park) encounters a tool failure — bad bash command, failed edit, broken test — Claude will often retry the exact same failing approach multiple times within a single iteration. Our circuit breaker only operates at the iteration boundary (post-hoc NDJSON log analysis in mux-runner), so by the time it detects repeated failures, we've burned entire iteration budgets on identical retries.

**Users**: Pickle Rick loop runners and their spawned workers.

**Pain Points**: Wasted tokens/time on identical retries within a single Claude session. A Morty worker can `npm test` the same broken test 5+ times before the iteration ends and the circuit breaker gets a chance to see it.

**Importance**: Token cost scales linearly with retries. A 5-retry waste per iteration across 10 iterations = 50 wasted tool calls.

## Objective & Scope

**Objective**: Detect repeated tool failures within a Claude session and inject behavioral nudges that escalate from "retry smarter" to "pivot your approach."

**Ideal Outcome**: Workers self-correct after 1-2 retries instead of 5+. The outer-loop circuit breaker trips less often because inner-loop nudges resolve the issue first.

### In-scope

- New `PostToolUseFailure` hook handler that tracks tool errors per-session
- Error state file (`last-tool-error.json`) written in the active session directory
- Escalating guidance injected into the next worker prompt by `spawn-morty.ts`
- Active-session isolation to prevent cross-session bleed
- Integration with existing dispatch.ts hook routing
- Registration in `settings.json` hook config

### Not-in-scope

- Changes to the circuit breaker (stays as outer-loop kill switch)
- Changes to mux-runner, microverse-runner, spawn-morty (they don't need modification — the hook fires at the Claude Code level, not the runner level)
- Tracking tool successes (only failures)
- Per-runner threshold tuning (use OMC's defaults, tune later from production data)

## Product Requirements

### Critical User Journeys (CUJs)

**CUJ-1: Worker hits same bash error 3 times**
A Morty worker runs `npm test`, gets a compilation error, retries twice more without fixing the root cause. On the 3rd failure, the hook injects: "You've hit this error 3 times. Analyze the root cause before retrying."

**CUJ-2: Worker hits same error 5+ times**
After 5 identical failures, the hook escalates: "STOP RETRYING. Try a completely different approach, check dependencies, or break down the task differently."

**CUJ-3: Worker hits a different error**
Worker fails `npm test` (compilation), then fails `npm test` (runtime error). The count resets because the error changed. No escalation.

**CUJ-4: Stale error file from previous session**
A `last-tool-error.json` exists from a previous session. The active-session resolver ensures only the current session's file is read.

### Functional Requirements

| Priority | Requirement | User Story | Verification |
|:---|:---|:---|:---|
| P0 | Write `last-tool-error.json` on PostToolUseFailure | As a hook, I capture tool failures for downstream nudging | `node --test` — unit test writes file with correct schema on simulated failure |
| P0 | Track retry count per tool_name | As a hook, I increment count when same tool fails with same error signature | Unit test: 3 sequential same-error calls → count=3 |
| P0 | Reset count on error change | As a hook, I reset count when error signature changes | Unit test: error A then error B → count=1 |
| P0 | Inject "retry smarter" guidance at count < 5 | As the next worker spawn, I add prompt guidance nudging the LLM to analyze before retrying | Unit test: count=3 → prompt contains "Analyze and fix" |
| P0 | Inject "pivot approach" guidance at count >= 5 | As the next worker spawn, I add prompt guidance telling the LLM to stop retrying | Unit test: count=5 → prompt contains "TOOL RETRY CIRCUIT OPEN" |
| P1 | Active-session isolation | As a hook, I only read/write the active session's error file | Unit test: no active session → approve with no side effects |
| P1 | Normalize error signatures | As a hook, I strip paths, timestamps, UUIDs from errors before comparison | Unit test: same error with different paths → same signature |
| P1 | Register hook in settings.json install | As install.sh, I add PostToolUseFailure hook config | `bash install.sh` adds hook entry; `jq` verifies |

## Interface Contracts

### Hook Input Contract (PostToolUseFailure)

Claude Code sends this JSON on stdin:

```typescript
interface PostToolUseFailureInput {
  session_id: string;
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;           // e.g. "Bash", "Edit", "Write"
  tool_input: Record<string, unknown>;  // tool arguments
  error: string;               // e.g. "Command exited with non-zero status code 1"
  is_interrupt?: boolean;
  tool_use_id: string;
  cwd: string;
  transcript_path?: string;
}
```

### Hook Output Contract

```typescript
// On error tracking (non-blocking — always approve, inject guidance)
interface ToolErrorHookResponse {
  decision: 'approve';
  additionalContext?: string;  // Not used by the bundle implementation; guidance is injected by spawn-morty.ts
}
```

### Error State File Contract (`last-tool-error.json`)

Written to ticket directory (if active session) or session directory.

```typescript
interface LastToolErrorState {
  ts: string;                   // ISO 8601
  tool: string;
  error_signature: string;     // Normalized error (paths/timestamps stripped)
  retry_count: number;
}
```

### State Transitions

| From | Event | To | Side Effects | Invariants |
|:---|:---|:---|:---|:---|
| No file | PostToolUseFailure | count=1 | Write last-tool-error.json | File has valid schema |
| count=N, same sig | PostToolUseFailure (same sig) | count=N+1 | Update file, inject guidance if N+1 >= 3 | Count monotonically increases for same sig |
| count=N, diff sig | PostToolUseFailure (new sig) | count=1 | Overwrite file with new sig | Old signature discarded |

## Verification Strategy

- **Type**: `npx tsc --noEmit` passes, no new type escapes
- **Lint**: `npx eslint src/ --max-warnings=-1` passes
- **Test**: All new + existing tests pass via `npm test` from `extension/`
- **Contract**: Hook input/output shapes match Claude Code's PostToolUseFailure schema

### Verification Commands

| Check | Command | Expected |
|:---|:---|:---|
| Type check | `cd extension && npx tsc --noEmit` | Exit 0, no errors |
| Lint | `cd extension && npx eslint src/ --max-warnings=-1` | Exit 0 |
| Unit tests | `cd extension && npm test` | All tests pass |
| Hook registration | `jq '.hooks.PostToolUseFailure' ~/.claude/settings.json` | Contains tool-error dispatcher entry |
| Build | `cd extension && npx tsc` | Compiles to extension/hooks/handlers/tool-error.js |

## Test Expectations

### Unit Tests

Test file: `extension/tests/tool-error-retry.test.js`

| Requirement | Test File | Description | Assertion |
|:---|:---|:---|:---|
| Write error file | tool-error-retry.test.js | First failure writes last-tool-error.json | File exists, schema matches LastToolErrorState |
| Increment count | tool-error-retry.test.js | Same tool+signature → count increments | count === previous + 1 |
| Reset on new sig | tool-error-retry.test.js | Different error signature → count resets to 1 | count === 1, new signature stored |
| Signature normalization | tool-error-retry.test.js | Errors differing only in paths/timestamps → same signature | normalizeErrorSignature(a) === normalizeErrorSignature(b) |
| No session → no-op | tool-error-retry.test.js | No active Pickle session → approve with no side effects | No file written, decision: approve |
| Always approves | tool-error-retry.test.js | Hook never blocks tool execution | decision === 'approve' in all cases |
| Worker guidance | spawn-morty.test.js | retry count 3/5 reaches worker prompt | prompt contains guidance/circuit-open text |

### Edge Cases

| Condition | Behavior | Test |
|:---|:---|:---|
| Corrupt last-tool-error.json | Treat as fresh (count=1) | Parse failure → fresh file |
| Empty error string | Use "unknown" as signature | Normalize empty → "unknown" |
| is_interrupt: true | Skip tracking (user cancelled) | No file write on interrupt |
| File write fails (permissions) | Log warning, approve with no guidance | try-catch, non-fatal |
| Concurrent writes (parallel agents) | Last-writer-wins (acceptable — per-ticket dirs isolate) | N/A — no locking needed |

## Assumptions

- Claude Code fires PostToolUseFailure for Bash non-zero exits, Edit failures, and Write failures
- The `error` field contains enough information to create a meaningful signature
- The next worker spawn is the reliable guidance injection point for persisted retry state.
- 60-second staleness threshold is appropriate (matches OMC's value)
- Threshold of 5 before "pivot" guidance is appropriate (matches OMC's value, tunable later via pickle_settings.json)

## Risks & Mitigations

| Risk | Impact | Mitigation |
|:---|:---|:---|
| PostToolUseFailure doesn't support additionalContext | Hook cannot directly nudge current turn | Persist `last-tool-error.json`; inject guidance on next worker spawn |
| Hook adds latency to every tool failure | Slows down Claude sessions | File I/O only, no network. Watchdog timeout in dispatch.ts already covers hangs |
| False signature matches (different errors normalize to same) | Premature pivot guidance | Use circuit-breaker's proven normalizeErrorSignature (paths, timestamps, UUIDs stripped, exit codes preserved) |
| Error file left on disk across sessions | Stale guidance on next session | Active-session state resolution keeps reads scoped to the current session |

## Tradeoffs

| Decision | Alternative | Why |
|:---|:---|:---|
| Reuse circuit-breaker's normalizeErrorSignature | Write new normalizer | Proven, tested, handles paths/timestamps/UUIDs. DRY. |
| Per-ticket directory for error file | Per-session directory | Isolates parallel workers on different tickets |
| Always approve (advisory, not blocking) | Block on repeated failures | Blocking tool execution is dangerous — could prevent recovery. Advisory nudges are safer. |
| Copy OMC's thresholds (5 retries) | Custom thresholds | No production data to justify different values. Start with OMC's battle-tested defaults. |

## Business Impact

| Metric | Current | Target | Impact |
|:---|:---|:---|:---|
| Wasted tool calls per iteration | ~5 (on failure loops) | ~2 | 60% reduction in retry waste |
| Circuit breaker trips per epic | Variable | Fewer | Inner-loop nudges resolve before outer-loop kills |
| Token cost per failed iteration | High (full retries) | Lower | Earlier pivot = fewer tokens burned |

## Stakeholders

| Name | Team | Role | Note |
|:---|:---|:---|:---|
| Gregory Dickson | Pickle Rick | Author/Maintainer | Final approval |

## Implementation Notes

### New Files
- `extension/src/hooks/handlers/tool-error.ts` — PostToolUseFailure handler
- `extension/tests/tool-error-retry.test.js` — Unit tests

### Modified Files
- `extension/src/types/index.ts` — Add `LastToolErrorState` and `PostToolUseFailureInput` interfaces
- `install.sh` — Register PostToolUseFailure hook in settings.json

### Reused
- `normalizeErrorSignature` from `extension/src/services/circuit-breaker.ts` — export already exists
- `resolveStateFile` / `loadActiveState` from `extension/src/hooks/resolve-state.ts`
- `safeErrorMessage` from `extension/src/services/pickle-utils.ts`
