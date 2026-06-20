# PRD: Microverse Runner Stall Resilience

## Problem

When a microverse worker completes an iteration and commits, the runner scores the commit via the LLM judge, then spawns a **new** worker for the next iteration. The new worker has no memory of what the previous worker did — it only receives the handoff from `buildMicroverseHandoff()`, which contains metric history and failed approaches but **not** what was fixed or what to do next.

This causes a degenerate loop:

1. Worker N commits a fix, exits
2. Runner scores it (score unchanged or improved)
3. Runner spawns Worker N+1 with the same handoff
4. Worker N+1 reads the code, sees the fix already exists, says "nothing to do," exits immediately with no commit
5. Runner sees no commit → records a stall
6. Repeat until stall limit → premature "convergence"

Observed in session `2026-03-31-647fbdc5`: Worker committed `c6c05db6` (47-point improvement), but subsequent workers kept exiting immediately. Runner stall counter hit 5 with no further progress despite the codebase still having ~161 wrong fields.

## Root Causes

### 1. No commit-awareness in stall detection (microverse-runner.js:526-537)

The runner treats "no commits" as a stall uniformly. It cannot distinguish:
- **True stall**: Worker tried to fix something but couldn't (should increment stall counter)
- **False stall**: Worker exited early because it lacked context to know what to do next (should NOT count as stall)
- **Clean pass**: Worker reviewed code and found nothing to fix (legitimate convergence signal)

### 2. Handoff lacks iteration context (microverse-runner.js:120-161)

`buildMicroverseHandoff()` includes:
- Metric description and validation command
- Recent metric history (score + action)
- Failed approaches
- PRD path and working directory

It does NOT include:
- What the previous iteration fixed (commit message, files changed)
- What the gap analysis says should be fixed next
- A diff or summary of recent commits since baseline

### 3. Gap analysis is write-once, never updated

The gap analysis (`gap_analysis.md`) is written in iteration 1 and never updated. After iteration N fixes a bug, the gap analysis still lists it as unfixed. The next worker re-discovers the same state, sees the fix is already in place, and has no guidance on what to tackle next.

## Acceptance Criteria

### AC-1: Commit-diff in handoff
- [ ] `buildMicroverseHandoff()` includes a "Recent Changes" section listing commits since baseline SHA
- [ ] Each entry shows: short SHA, commit message, files changed (from `git log --oneline --stat`)
- [ ] Limited to last 5 commits to avoid bloating the handoff

### AC-2: Smart stall detection
- [ ] When `postIterSha === preIterSha` (no commit), runner checks the iteration log for worker exit classification:
  - Worker explicitly reported "nothing to fix" or "clean pass" → count as legitimate convergence signal, not stall
  - Worker timed out or errored → count as stall
  - Worker exited with low turn count (< 5 turns) and no tool calls → flag as "amnesiac exit," don't count as stall, log warning
- [ ] New function `classifyNoCommitExit(iterLogFile): 'clean_pass' | 'stall' | 'amnesiac'` added to runner

### AC-3: Gap analysis refresh
- [ ] After each accepted iteration (score improved or held), runner appends a "fixed" marker to `gap_analysis.md` for the commit that was just scored
- [ ] Format: `## Iteration N — Fixed\n- Commit: <sha> <message>\n- Files: <list>\n`
- [ ] Worker instructions (in handoff) explicitly state: "Read gap_analysis.md — items marked 'Fixed' are done, skip them"

### AC-4: Consecutive amnesiac exit breaker
- [ ] If the runner detects 2 consecutive amnesiac exits (worker exiting in < 5 turns with no commits and no meaningful output), it forces a gap analysis re-run by setting `status: 'gap_analysis'` and resetting the gap analysis file
- [ ] This breaks the degenerate loop by giving the worker a fresh survey of the codebase

### AC-5: No regressions
- [ ] Existing microverse-runner tests pass
- [ ] Stall limit still works for true stalls (worker makes commits that regress and get reverted N times)
- [ ] Convergence target of 0 still works (score reaches 0 → exit)
- [ ] Rate limit handling unchanged

## Implementation Notes

### Files to modify
- `extension/src/bin/microverse-runner.ts` — main loop, handoff builder, stall detection
- `extension/src/services/microverse-state.ts` — possibly add `recordAmnesiacExit()`

### Key code locations
- `buildMicroverseHandoff()` at line ~120 — add recent commits section
- `postIterSha === preIterSha` block at line ~498-537 — add exit classification
- After `compareMetric` / `stateRecordIteration` — add gap analysis append

### Git log for handoff
```typescript
// Get recent commits since baseline for handoff context
const baselineSha = mvState.convergence.history[0]?.pre_iteration_sha ?? preIterSha;
const recentCommits = execFileSync('git', [
  'log', '--oneline', '--stat', `${baselineSha}..HEAD`, '--max-count=5'
], { cwd: workingDir, encoding: 'utf-8', timeout: 10_000 }).trim();
```

### Amnesiac detection heuristic
Parse the iteration log file for turn count and tool use:
```typescript
function classifyNoCommitExit(iterLogFile: string): 'clean_pass' | 'stall' | 'amnesiac' {
  const content = fs.readFileSync(iterLogFile, 'utf-8');
  const resultLine = content.split('\n').filter(l => l.includes('"type":"result"')).pop();
  if (!resultLine) return 'stall';
  const result = JSON.parse(resultLine);
  const turns = result.num_turns ?? 0;
  // Worker that exits in < 5 turns likely didn't understand what to do
  if (turns < 5) return 'amnesiac';
  // Worker with many turns but no commit = genuine clean pass or stall
  // Check if output mentions "clean" or "no violations" or "nothing to fix"
  const output = (result.result ?? '').toLowerCase();
  if (output.includes('clean') || output.includes('no violations') || output.includes('nothing to fix') || output.includes('sauce is obtained'))
    return 'clean_pass';
  return 'stall';
}
```

## Priority
P1 — this causes microverse sessions to terminate prematurely, wasting the setup cost and requiring manual intervention to restart.
