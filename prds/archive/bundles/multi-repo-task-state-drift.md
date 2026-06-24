# PRD: Fix Multi-Repo Task State Drift (Refined)

## Problem

When Pickle Rick runs tasks that span multiple repositories (e.g., parent `loanlight/` with subtasks targeting `loanlight-api/`, `octy/`, etc.), the task state machine drifts out of sync. Symptoms:

1. **Premature completion marking** — tickets marked `[x]` Done without actual work completed
2. **Indicator desync** — `[~]` In Progress shown on one ticket while `state.current_ticket` points to another
3. **Phantom ticket advancement** — model picks up next ticket, believes it's already done, skips it
4. **Duplicate task creation** — model creates new tickets from PRD content because existing ones appear incorrectly finished
5. **State machine drift** — cumulative effect of above causes the session to diverge from reality

## Root Causes

### RC-1: Auto-mark-done on ticket transition has no completion validation

**File**: `extension/src/bin/mux-runner.ts:549-558`

When the model changes `current_ticket` in `state.json` — for any reason, including confusion about which directory it's in — the mux-runner blindly marks the previous ticket as Done. No validation that actual work was performed. *(refined: all three analysts, all three cycles)*

### RC-2: No per-ticket working directory

**File**: `extension/src/services/pickle-utils.ts:170-176`

Tickets have no `working_dir` field. The session has one global `working_dir` set at setup time. When tasks span repos, the model must infer which directory each ticket belongs to from ticket content alone — unreliable after context clearing. *(refined: codebase analyst)*

### RC-3: Handoff summary lacks directory context per ticket

**File**: `extension/src/services/pickle-utils.ts:274-283`

Between iterations (context clearing), the new Claude instance receives a handoff summary with ticket statuses but zero information about which repo/directory each ticket targets. *(refined: codebase analyst)*

### RC-4: Stop-hook bails on CWD mismatch (inline mode only)

**File**: `extension/src/hooks/handlers/stop-hook.ts:71-74`

Safe in tmux mode — mux-runner controls lifecycle, stop-hook's `approve()` only exits the inner Claude subprocess which gets respawned. In inline mode, CWD mismatch exits the loop. Inline mode is not recommended for multi-repo tasks. No code change required — documented as known limitation. *(refined: risk auditor cycle 3)*

## Scope

Harden the single-repo constraint (primary) with groundwork for future multi-repo support (secondary).

**Rationale**: The CLAUDE.md already says "NEVER work across multiple repositories simultaneously." Rather than building a complex multi-repo orchestrator, we enforce this rule at the system level and make the failure mode obvious and recoverable.

## Critical Design Decision: Dual-Validation Architecture

*(refined: all three analysts, cycle 2-3 consensus)*

Two distinct validation moments exist:

1. **Prompt-driven** (`pickle.md:121-123`): Model checks artifacts, runs `git status`/`git diff`/tests/build, commits if pass, marks Done in frontmatter. Has full context. Runs BEFORE `current_ticket` changes.
2. **Code-driven** (`mux-runner.ts:549-558`): Detects `current_ticket` already changed (post-hoc). Only has iteration log + git state. Can only mark Done or Skipped.

**Precedence**: The code-driven check is a SAFETY NET for drift scenarios where the model skips its prompt-driven validation. It does NOT replace `pickle.md:121-123`. If the ticket's frontmatter already says "Done" when the transition check runs, skip `classifyTicketCompletion()` entirely — the model's validation is authoritative.

**Why this matters**: `pickle.md:122` instructs "pass → commit" BEFORE transitioning. By the time the mux-runner fires, `git diff --stat` is empty (committed) AND `TASK_COMPLETED` is never emitted in the per-ticket prompt flow. Without the frontmatter-first check, `classifyTicketCompletion()` would return `'skipped'` for EVERY correctly-completed ticket — the safety net becomes the failure mode.

## Known Limitations

*(refined: risk auditor, codebase analyst)*

- **`runIteration()` spawns Claude with `cwd: state.working_dir` (mux-runner.ts:326)**. Per-ticket `working_dir` from Ticket 2 appears in the handoff summary but does not change subprocess CWD. The model must navigate to the correct directory based on handoff context. Changing subprocess CWD per-ticket is deferred to a future multi-repo orchestration PRD.
- **RC-4 (stop-hook CWD mismatch)** is safe in tmux mode but breaks inline mode for multi-repo tasks. No code change — inline mode is not recommended for multi-repo.

## Ticket Dependencies

*(refined: all three analysts, unanimous across all cycles)*

```
T2 (working_dir schema) → T4 (status utilities) → T1 (completion validation) → T3 (multi-repo warning)
```

- **T2**: Independent — schema + prompt template changes. Implement FIRST.
- **T4**: Independent — utility functions + status taxonomy. Implement SECOND.
- **T1**: Depends on T4 (`markTicketSkipped()`), soft-depends on T2 (`working_dir` for scoped git checks — falls back to `state.working_dir`).
- **T3**: Depends on T2 (needs `working_dir` to detect multi-repo).

## Interface Contracts

### `classifyTicketCompletion()` *(refined: requirements + codebase analysts)*

```typescript
/**
 * Validates whether a ticket had real work performed before marking Done.
 * Safety net for drift scenarios — only fires when the model changed
 * current_ticket without following pickle.md:121-123 validation protocol.
 *
 * Located in mux-runner.ts alongside classifyCompletion() (line 78).
 */
export function classifyTicketCompletion(
  iterLogFile: string,
  workingDir: string
): 'completed' | 'skipped'
```

**Inputs**: `iterLogFile` — path to `tmux_iteration_N.log` for the current iteration. `workingDir` — ticket's `working_dir` from frontmatter, or `state.working_dir` fallback.

**Outputs**: `'completed'` (evidence of work found) or `'skipped'` (no evidence — drift detected).

**Errors**: All internal failures (file read, git command) → log warning, return `'skipped'` (fail-safe).

**Algorithm**:
1. Read `iterLogFile`, call `extractAssistantContent()` (from `mux-runner.ts:39`)
2. If `hasToken(content, PromiseTokens.TASK_COMPLETED)` → return `'completed'`
3. Git three-signal check in `workingDir` (mirrors `circuit-breaker.ts:227-236`):
   - `git diff --stat` (uncommitted) — non-empty → `'completed'`
   - `git diff --stat --cached` (staged) — non-empty → `'completed'`
   - HEAD comparison deferred (requires `ticket_start_commit` baseline — future enhancement)
4. If `workingDir` is not a git repo (git commands fail) → rely solely on token
5. Return `'skipped'`

**IMPORTANT**: `result` from `runIteration()` (line 547) is a classification string (`'continue'|'task_completed'|'review_clean'`), NOT raw iteration output. `classifyTicketCompletion()` must read the iteration log file directly. *(refined: codebase analyst)*

### `markTicketSkipped()` *(refined: risk auditor)*

```typescript
export function markTicketSkipped(sessionDir: string, ticketId: string): boolean
```

Same pattern as `markTicketDone()`. Writes `status: "Skipped"` (title-case, quoted, matching `"Done"` convention). Adds `skipped_at: <ISO timestamp>` to frontmatter (inserted before closing `---` using `extractFrontmatter()` offsets).

### `statusSymbol()` update

```typescript
// Add before the default return at pickle-utils.ts:150
if (s === 'skipped') return '[!]';
```

### `TicketInfo` interface extension

```typescript
export interface TicketInfo {
  id: string | null;
  title: string | null;
  status: string | null;
  order: number;
  type: string | null;
  working_dir: string | null;    // NEW — per-ticket target directory
  completed_at: string | null;   // NEW — ISO timestamp when marked Done
  skipped_at: string | null;     // NEW — ISO timestamp when marked Skipped
}
```

`completed_by` cut — no runtime consumer. *(refined: risk auditor + codebase analyst consensus)*

## Verification Strategy

**Build gate**: `npx tsc --noEmit && npx tsc && npm test` from `extension/`

**Test convention**: `.test.js` files using `node:test`, `assert from 'node:assert/strict'`, temp dirs via `fs.mkdtempSync`. *(refined: codebase analyst)*

### Per-ticket verify commands

| Ticket | Verify Command |
|--------|---------------|
| T2 | `node --test extension/tests/pickle-utils.test.js` — new tests for `parseTicketFrontmatter()` with `working_dir`, `buildHandoffSummary()` with directory context |
| T4 | `node --test extension/tests/pickle-utils.test.js` — new tests for `markTicketSkipped()`, `statusSymbol('Skipped')`, `markTicketDone()` with `completed_at` |
| T1 | `node --test extension/tests/mux-runner.test.js` — new tests for `classifyTicketCompletion()`, restructured transition block |
| T3 | `node --test extension/tests/mux-runner.test.js` — new tests for multi-repo detection, `npx tsc --noEmit` for `VALID_ACTIVITY_EVENTS` type check |

### Symptom coverage *(refined: requirements analyst)*

| Symptom | Ticket | Test |
|---------|--------|------|
| 1. Premature Done | T1 | Transition without evidence → Skipped not Done |
| 2. Indicator desync | T4 | `statusSymbol('Skipped')` returns `[!]` (distinct from `[ ]`) |
| 3. Phantom advancement | T1 | Skipped ticket re-selectable; handoff shows `[!]` with re-attempt note |
| 4. Duplicate creation | T1 | Handoff for Skipped ticket includes context preventing PRD re-creation |
| 5. Cumulative drift | T1 | 3 iterations, ticket transitions with no evidence → remains Skipped each time |

## Changes

### Ticket T2 (b0c016c6): Add `working_dir` to ticket frontmatter schema

**Files**:
- `extension/src/services/pickle-utils.ts` — `TicketInfo` interface, `parseTicketFrontmatter()`, `buildHandoffSummary()`
- `extension/src/types/index.ts` — no changes needed (TicketInfo lives in pickle-utils)
- `.claude/commands/pickle.md:85-97` — add `working_dir` field to ticket template
- `.claude/commands/pickle-refine-prd.md:123-136` — add `working_dir` field (preserve existing `depends_on` which `pickle.md` lacks)

*(refined: codebase analyst — prompt templates were missing from original file list)*

**Implementation**:
1. Add `working_dir: string | null` to `TicketInfo` interface
2. Add `get('working_dir')` in `parseTicketFrontmatter()` (existing `get()` helper handles arbitrary fields)
3. Add `working_dir` to ticket frontmatter template in `pickle.md:91` (after `order`):
   ```yaml
   working_dir: [relative-path-to-target-repo or omit if same as session root]
   ```
4. Add instruction to `pickle.md:81`: "If the PRD targets a specific subdirectory that is its own git repo, set `working_dir` to that path relative to the session root. Omit if the ticket targets the same directory as the session."
5. Add `working_dir` to `pickle-refine-prd.md:131` (after `order`, before `depends_on`)
6. Update `buildHandoffSummary()` to show per-ticket directory:
   ```
     [x] ticket-1: "Add API endpoint..." (loanlight-api/)
     [ ] ticket-2: "Update frontend..."
   ```
   Display rules: `null` → omit parenthetical; equals session `working_dir` → omit; otherwise show relative path.

**Acceptance Criteria**:
- [ ] `TicketInfo.working_dir` parsed from frontmatter — Verify: `node --test extension/tests/pickle-utils.test.js` — Type: test
- [ ] Tickets without `working_dir` return `null` (backward compatible) — Verify: `node --test extension/tests/pickle-utils.test.js` — Type: test
- [ ] Handoff summary shows directory context per ticket when present — Verify: `node --test extension/tests/pickle-utils.test.js` — Type: test
- [ ] `pickle.md` ticket template includes `working_dir` field — Verify: `grep -c working_dir .claude/commands/pickle.md` returns ≥1 — Type: lint
- [ ] `pickle-refine-prd.md` ticket template includes `working_dir` field — Verify: `grep -c working_dir .claude/commands/pickle-refine-prd.md` returns ≥1 — Type: lint
- [ ] Type checker passes — Verify: `npx tsc --noEmit` — Type: typecheck

### Ticket T4 (dd877802): Add `Skipped` status taxonomy and audit trail

**Files**:
- `extension/src/services/pickle-utils.ts` — `statusSymbol()`, `markTicketDone()`, new `markTicketSkipped()`

**Implementation**:
1. Add `if (s === 'skipped') return '[!]';` before default return in `statusSymbol()` (line 150)
2. Add `completed_at` timestamp to `markTicketDone()`: insert `completed_at: "<ISO>"` before closing `---` delimiter using `extractFrontmatter()` offsets. No signature change.
3. Add `markTicketSkipped(sessionDir, ticketId)`: same pattern as `markTicketDone()` — replace status line with `"Skipped"`, insert `skipped_at: "<ISO>"` before closing `---`
4. Guard: `markTicketDone()` on a `Skipped` ticket requires the status line to be present and non-Done (existing regex handles this — `"Skipped"` → `"Done"` is a valid replace)
5. Add `completed_at`, `skipped_at` to `TicketInfo` interface and `parseTicketFrontmatter()`
6. Shared helper `setTicketStatus(sessionDir, ticketId, status, timestampField)` to reduce duplication between `markTicketDone` and `markTicketSkipped` *(refined: risk auditor)*

**Acceptance Criteria**:
- [ ] `statusSymbol('Skipped')` returns `'[!]'` — Verify: `node --test extension/tests/pickle-utils.test.js` — Type: test
- [ ] `statusSymbol('skipped')` returns `'[!]'` (case-insensitive) — Verify: `node --test extension/tests/pickle-utils.test.js` — Type: test
- [ ] `markTicketSkipped()` writes `status: "Skipped"` to frontmatter — Verify: `node --test extension/tests/pickle-utils.test.js` — Type: test
- [ ] `markTicketSkipped()` inserts `skipped_at` ISO timestamp — Verify: `node --test extension/tests/pickle-utils.test.js` — Type: test
- [ ] `markTicketDone()` inserts `completed_at` ISO timestamp — Verify: `node --test extension/tests/pickle-utils.test.js` — Type: test
- [ ] `parseTicketFrontmatter()` reads `completed_at` and `skipped_at` — Verify: `node --test extension/tests/pickle-utils.test.js` — Type: test
- [ ] Old tickets without `completed_at`/`skipped_at` return `null` — Verify: `node --test extension/tests/pickle-utils.test.js` — Type: test
- [ ] Type checker passes — Verify: `npx tsc --noEmit` — Type: typecheck

### Ticket T1 (c16b3f98): Validate completion before marking ticket Done

**Files**:
- `extension/src/bin/mux-runner.ts` — `classifyTicketCompletion()`, restructured transition block
- `.claude/commands/pickle.md:121-123` — add `TASK_COMPLETED` emission instruction

**Depends on**: T4 (calls `markTicketSkipped()`), soft-depends on T2 (`working_dir` for scoped git checks)

**Implementation**:

1. Add `classifyTicketCompletion(iterLogFile, workingDir)` to `mux-runner.ts` (see Interface Contracts above)

2. Add `TASK_COMPLETED` emission to `pickle.md:123` *(refined: requirements analyst — without this, the primary validation signal is dead)*:
   ```markdown
   5. **Update**: mark ticket Done in frontmatter
   6. **Signal**: output `<promise>TASK_COMPLETED</promise>` to confirm ticket completion
   ```

3. Restructure transition block at `mux-runner.ts:549-559` *(refined: codebase analyst)*:
   - Move `iterLogFile` computation (currently line 562) to BEFORE the transition block (line 548)
   - Add frontmatter-first check: if ticket already marked Done by model, skip `classifyTicketCompletion()`
   - On `classifyTicketCompletion() === 'skipped'` → call `markTicketSkipped()` instead of `markTicketDone()`

4. Add `Skipped` ticket context to handoff summary in `buildHandoffSummary()`:
   - For `[!]` tickets, append "(no verified completion — re-attempt)"
   - Add prompt guidance to `pickle.md:119`: "Tickets marked `[!]` Skipped were not verified as complete by the safety net. Re-attempt Skipped tickets before starting new Todo tickets."

5. Document: the `markTicketDone` call at `mux-runner.ts:719-722` (EPIC_COMPLETED path) does NOT require `classifyTicketCompletion()` because `EPIC_COMPLETED` is an explicit model assertion that all tickets are done. *(refined: codebase analyst + risk auditor)*

**Acceptance Criteria**:
- [ ] `classifyTicketCompletion()` returns `'completed'` when `TASK_COMPLETED` token found in log — Verify: `node --test extension/tests/mux-runner.test.js` — Type: test
- [ ] `classifyTicketCompletion()` returns `'completed'` when uncommitted git changes detected — Verify: `node --test extension/tests/mux-runner.test.js` — Type: test
- [ ] `classifyTicketCompletion()` returns `'completed'` when staged git changes detected — Verify: `node --test extension/tests/mux-runner.test.js` — Type: test
- [ ] `classifyTicketCompletion()` returns `'skipped'` when no evidence found — Verify: `node --test extension/tests/mux-runner.test.js` — Type: test
- [ ] `classifyTicketCompletion()` returns `'skipped'` on log read failure (fail-safe) — Verify: `node --test extension/tests/mux-runner.test.js` — Type: test
- [ ] Frontmatter-first check: ticket already Done → skip validation — Verify: `node --test extension/tests/mux-runner.test.js` — Type: test
- [ ] `pickle.md` includes `TASK_COMPLETED` emission instruction — Verify: `grep -c TASK_COMPLETED .claude/commands/pickle.md` returns ≥1 — Type: lint
- [ ] `pickle.md:119` includes Skipped ticket re-attempt guidance — Verify: `grep -c 'Skipped' .claude/commands/pickle.md` returns ≥1 — Type: lint
- [ ] `iterLogFile` computed before transition block (no undefined reference) — Verify: `npx tsc --noEmit` — Type: typecheck
- [ ] EPIC_COMPLETED path (line ~720) unchanged — no validation added — Verify: code review — Type: llm-conformance
- [ ] Type checker passes — Verify: `npx tsc --noEmit` — Type: typecheck

### Ticket T3 (588121aa): Warn on multi-repo ticket set

**Files**:
- `extension/src/bin/mux-runner.ts` — multi-repo detection after `collectTickets()`
- `extension/src/types/index.ts` — add `'multi_repo_warning'` to `VALID_ACTIVITY_EVENTS`
- `extension/src/services/pickle-utils.ts` — optional: inject warning into handoff summary

**Depends on**: T2 (needs `working_dir` to detect multi-repo)

**Implementation**:

1. Add `'multi_repo_warning'` to `VALID_ACTIVITY_EVENTS` tuple at `types/index.ts:82-89` *(refined: risk auditor — without this, TypeScript rejects `logActivity({ event: 'multi_repo_warning' })`)*

2. Programmatic check in `mux-runner.ts` (NOT prompt instruction) *(refined: requirements analyst)*:
   - After first iteration where `collectTickets()` returns results, check for 2+ distinct non-null `working_dir` values
   - If multi-repo detected: `logActivity({ event: 'multi_repo_warning', ... })`
   - Log warning: `⚠️  MULTI-REPO DETECTED: Tickets span [dir1, dir2]. Pickle Rick works best with single-repo sessions.`

3. Inject warning into `buildHandoffSummary()` when multi-repo detected (so it persists across context clearing)

4. Do NOT block execution — advisory only

**Acceptance Criteria**:
- [ ] `'multi_repo_warning'` in `VALID_ACTIVITY_EVENTS` — Verify: `npx tsc --noEmit` — Type: typecheck
- [ ] Warning emitted when tickets have 2+ distinct `working_dir` values — Verify: `node --test extension/tests/mux-runner.test.js` — Type: test
- [ ] No warning when all tickets share `working_dir` or `working_dir` is null — Verify: `node --test extension/tests/mux-runner.test.js` — Type: test
- [ ] Warning visible in handoff summary — Verify: `node --test extension/tests/pickle-utils.test.js` — Type: test
- [ ] Execution not blocked — advisory only — Verify: `node --test extension/tests/mux-runner.test.js` — Type: test
- [ ] Type checker passes — Verify: `npx tsc --noEmit` — Type: typecheck

## Out of Scope

- Full multi-repo orchestration (spawning separate sessions per repo, cross-repo dependency graphs)
- Changing subprocess CWD per-ticket in `runIteration()` (requires multi-repo orchestrator)
- `ticket_start_commit` baseline SHA tracking (future enhancement for HEAD comparison)
- `completed_by` field (no runtime consumer)
- Stop-hook CWD mismatch fix for inline mode (tmux mode is unaffected; inline not recommended for multi-repo)
- `depends_on` schema divergence between `pickle.md` and `pickle-refine-prd.md` (pre-existing, separate concern)
- Circuit breaker progress detection changes (separate concern)
- Changes to `spawn-morty.ts` worker subprocess CWD handling (workers already inherit `process.cwd()` correctly)

## Priority

Medium-High — the auto-mark-done bug (RC-1) fires in ALL sessions where `current_ticket` changes, not just multi-repo. Single-repo sessions with model confusion are also affected. *(refined: risk auditor — original "Medium" understated)*

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|-------|-----|-------|----------|-------|------|-------|
| 10 | b0c016c6 | Add `working_dir` to ticket frontmatter schema | High | Clean main | Tests pass, templates updated | pickle-utils.ts, pickle.md, pickle-refine-prd.md |
| 20 | dd877802 | Add `Skipped` status taxonomy and audit trail | High | Clean main | Tests pass, `[!]` renders | pickle-utils.ts |
| 30 | c16b3f98 | Validate completion before marking ticket Done | High | T4+T2 merged | Tests pass, transition block restructured | mux-runner.ts, pickle.md |
| 40 | 588121aa | Warn on multi-repo ticket set | Medium | T2 merged | Tests pass, warning visible | mux-runner.ts, types/index.ts, pickle-utils.ts |
