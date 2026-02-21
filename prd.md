# High-Impact Quick Wins PRD

| High-Impact Quick Wins PRD |  | Four low-effort features that close obvious gaps in the Pickle Rick lifecycle |
| :---- | :---- | :---- |
| **Author**: Pickle Rick **Intended audience**: Engineering | **Status**: Draft **Created**: 2026-02-20 | **Visibility**: Internal |

## Introduction

Four features with disproportionate impact relative to their implementation cost. Each is either a missing wire-up of existing code (`pr-factory.js`), a single new script (`pickle-status`, `pickle-retry`), or a four-line shell call (`notify`). None require changes to the stop hook, state schema, or Morty lifecycle.

## Problem Statement

**Current Process:** Users run `/pickle` and receive no visibility into session state without manually reading `state.json`. Epic completion silently drops without creating a PR. Night Shift jar runs finish with no signal. Failed or hung tickets require full session restarts.

**Primary Users:** Developers using Pickle Rick for autonomous multi-ticket feature development.

**Pain Points:**
- No at-a-glance session status — phase, iteration, ticket health invisible without manual inspection
- `pr-factory.js` is deployed and functional but wired to nothing — PRs must be created manually after every epic
- Jar / Night Shift runs are silent — no completion signal when running unattended
- A single bad ticket requires cancelling and restarting the entire epic rather than retrying the offending ticket

**Importance:** These gaps break the "sit back, Rick handles it" promise. The user must stay involved to know what's happening and to recover from failures.

## Objective & Scope

**Objective:** Close four specific operational gaps with minimal new code — one status command, one PR wire-up, one notification call, one retry command.

**Ideal Outcome:** After this work, a user can: check session health at any time, receive a PR automatically after epic completion, get a macOS notification when a Night Shift batch finishes, and re-run a single failed ticket without restarting.

### In-scope or Goals

- `/pickle-status` slash command that prints current session state from `state.json` and ticket frontmatter
- Auto-PR creation at the end of epic completion using existing `pr-factory.js`
- macOS notification (`osascript`) fired from `jar-runner.js` when all jar tasks are processed
- `/pickle-retry <ticket-id>` slash command that resets a ticket to Todo and re-spawns a Morty for it

### Not-in-scope or Non-Goals

- Linux/Windows notification systems (macOS `osascript` only for now)
- Parallel Morty workers — separate feature, separate PRD
- Changes to the stop hook, state schema, or Morty lifecycle
- PR body enrichment (ticket list, diff summary) — out of scope for this pass

## Product Requirements

### Critical User Journeys (CUJs)

1. **Status Check**: User runs `/pickle-status` mid-epic. Output shows current phase, iteration x/N, active ticket, and a tick-list of all tickets with their statuses. No state mutations.

2. **Auto-PR**: Rick finishes the final ticket, announces "Epic complete," checks the current branch name, and if it is not `main` or `master`, automatically calls `pr-factory.js` with the session directory. A PR URL is printed to the terminal. No manual `gh pr create` required. If the branch is `main`/`master`, Rick prints a warning and skips PR creation.

3. **Night Shift Notification**: User queues 3 tasks with `/add-to-pickle-jar`, runs `/pickle-jar-open`, walks away. When `jar-runner.js` finishes processing all entries, a macOS notification appears: "🥒 Pickle Rick — Jar complete. N tasks processed."

4. **Ticket Retry**: A Morty worker times out or produces invalid output. User runs `/pickle-retry abc123` (using the ticket hash). The script resets the ticket status to `Todo`, sets `active: true` in `state.json` (re-activating the session if it was cancelled), and prints a ready-to-run `spawn-morty.js` command. Rick executes that command, then validates and commits as normal.

### Functional Requirements

| Priority | Requirement | User Story |
| :---- | :---- | :---- |
| P0 | `/pickle-status` prints session phase, iteration, and ticket list | As a user, I want to check what Rick is doing without reading JSON |
| P0 | Epic completion triggers `pr-factory.js` automatically | As a user, I want a PR created without any manual steps |
| P0 | `jar-runner.js` fires `osascript` notification on completion | As a user running Night Shift unattended, I want to know when it's done |
| P0 | `/pickle-retry <ticket-id>` resets ticket and re-spawns Morty | As a user, I want to recover a failed ticket without restarting the epic |
| P1 | Status command exits gracefully with helpful message if no active session found | As a user in a project without a session, I want a clear "no active session" message |
| P1 | Retry command validates ticket-id exists before mutating state | As a user, I want an error if I typo a ticket id |
| P1 | Auto-PR is skipped gracefully (with warning) if `gh` is not on PATH or repo has no remote | As a user without gh CLI, the epic should still complete without hard failure |
| P1 | Auto-PR is skipped gracefully (with warning) if current branch is `main` or `master` | As a user working on main, I get a clear message rather than a `gh` error |

## Implementation Notes

### Shared: Extract `collectTickets()` to `pickle-utils.js` (do this first)

- Move `statusSymbol()`, `parseTicketFrontmatter()`, and `collectTickets()` from `stop-hook.js` into `extension/services/pickle-utils.js` as named exports
- Update `stop-hook.js` to import them from `pickle-utils.js` (no behavior change)
- `status.js` then imports from `pickle-utils.js` — no duplication
- This is a P0 prerequisite for the status command; do it before writing `status.js`

### `/pickle-status`

- New file: `extension/bin/status.js`
- Resolves session via `current_sessions.json` keyed on `process.cwd()` — no `$ARGUMENTS` needed
- Reads `state.json` for phase/iteration/prompt
- Imports `collectTickets()` from `pickle-utils.js` to build ticket list
- Prints formatted output to stdout; no JSON, no state mutation
- New file: `.claude/commands/pickle-status.md` — runs `node $HOME/.claude/pickle-rick/extension/bin/status.js` (no arguments)
- Add to `install.sh`: copy command + chmod status.js

### Auto-PR

- Location: `pickle.md` orchestration section, after "mark Parent Ticket Done"
- Before calling `pr-factory.js`, Rick runs `git branch --show-current` and checks the output:
  - If branch is `main` or `master`: print "⚠️ On main branch — skipping auto-PR. Create one manually." and continue
  - Otherwise: run `node ${EXTENSION_ROOT}/extension/bin/pr-factory.js ${SESSION_ROOT}`
- `pr-factory.js` already has a working CLI entrypoint — no changes to the script needed
- Guard: if the script exits non-zero for any other reason, Rick prints a warning and continues (epic is already done)

### macOS Notification

- Location: `extension/bin/jar-runner.js`, after the final task loop completes
- Call: `spawnSync('osascript', ['-e', `display notification "X succeeded, Y failed" with title "🥒 Pickle Rick" subtitle "Jar complete"`])` where X and Y are the counts tracked during the task loop
- Guard with `process.platform === 'darwin'` — skip silently on non-macOS

### `/pickle-retry`

- New file: `extension/bin/retry-ticket.js`
  - Args: `<ticket-id>` (session-dir resolved from `current_sessions.json` via `process.cwd()`)
  - Validates ticket directory and ticket file exist; exits with error message if not found
  - Updates ticket frontmatter `status: Todo`
  - Sets `active: true` in `state.json` (re-activates session if it was previously cancelled)
  - Calls `update-state.js current_ticket <ticket-id> <session-dir>` to set the active ticket
  - Prints a ready-to-run `spawn-morty.js` command to stdout (Rick reads this output and executes it)
- New file: `.claude/commands/pickle-retry.md`
  - Runs `retry-ticket.js $ARGUMENTS`
  - Instructs Rick: read the printed `spawn-morty.js` command from the output, execute it, then proceed with the standard validation and commit flow from the Orchestration phase
- Add to `install.sh`: copy command + chmod retry-ticket.js

## Assumptions

- `gh` CLI is available in the user's environment for auto-PR; failures are non-fatal
- macOS is the target platform for notifications; Linux/Windows users get no notification but no error
- `pr-factory.js` creates PRs against the current branch — no branch management needed
- Ticket hash is sufficient to identify a ticket for retry (user copies it from `/pickle-status` output)

## Risks & Mitigations

- **Risk**: Auto-PR fires on a detached HEAD or repo with no remote → **Mitigation**: `pr-factory.js` already catches `gh` errors and throws; Rick guards with non-fatal warning
- **Risk**: `/pickle-retry` on a ticket with uncommitted partial work from the failed Morty → **Mitigation**: Command instructs Rick to run `git status` first and optionally `git stash` before re-spawning
- **Risk**: `collectTickets()` logic duplicated between `status.js` and `stop-hook.js` → **Mitigation**: Extraction to `pickle-utils.js` is a P0 prerequisite step before `status.js` is written (see Implementation Notes)

## Business Benefits/Impact/Metrics

**Success Metrics:**

| Metric | Current State | Future State | Savings/Impacts |
| :---- | :---- | :---- | :---- |
| *Manual steps after epic* | 1 (gh pr create) | 0 | Eliminates context switch |
| *Session visibility* | 0 (read state.json manually) | Instant via /pickle-status | Reduces confusion mid-loop |
| *Recovery from failed ticket* | Full restart | Single command | Saves N-1 ticket re-runs |
| *Night Shift awareness* | Poll terminal manually | Push notification | Enables truly unattended runs |
