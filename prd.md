# High-Impact Quick Wins PRD

| High-Impact Quick Wins PRD |  | Four low-effort features that close obvious gaps in the Pickle Rick lifecycle |
| :---- | :---- | :---- |
| **Author**: Pickle Rick **Intended audience**: Engineering | **Status**: Draft **Created**: 2026-02-20 | **Visibility**: Internal |

## Introduction

Four features with disproportionate impact relative to their implementation cost. Each is either a missing wire-up of existing code (`pr-factory.js`), a single new script (`pickle-status`, `pickle-retry`), or a four-line shell call (`notify`). None require changes to the state schema or Morty lifecycle. `stop-hook.js` is touched only to extract shared helpers into `pickle-utils.js` — a behavior-neutral refactor that is a prerequisite for `status.js`.

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

3. **Night Shift Notification**: User queues 3 tasks with `/add-to-pickle-jar`, runs `/pickle-jar-open`, walks away. When `jar-runner.js` finishes processing all entries, a macOS notification appears: "🥒 Pickle Rick — Jar complete. X succeeded, Y failed."

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
  - **Cleans up partial artifacts**: moves any existing `research_*.md`, `research_review.md`, `plan_*.md`, `plan_review.md` in the ticket dir to a `_retry_<timestamp>/` subdirectory — preserves history without confusing a fresh Morty
  - Updates ticket frontmatter `status: Todo`
  - Sets `active: true` in `state.json` (re-activates session if it was previously cancelled)
  - Calls `update-state.js current_ticket <ticket-id> <session-dir>` to set the active ticket
  - Prints a ready-to-run `spawn-morty.js` command to stdout (Rick reads this output and executes it)
- New file: `.claude/commands/pickle-retry.md`
  - Runs `retry-ticket.js $ARGUMENTS`
  - Instructs Rick: read the printed `spawn-morty.js` command from the output, execute it, then proceed with the standard validation and commit flow from the Orchestration phase
- Add to `install.sh`: copy command + chmod retry-ticket.js

### Documentation (do last)

After all four features are implemented:
- Update `help-pickle.md`: add `/pickle-status` and `/pickle-retry` to the command list
- Update `README.md`: add both commands to the Commands table and a Tips entry for `/pickle-retry`
- Deploy updated help file to `~/.claude/commands/help-pickle.md`

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

---

## Appendix A: Work Completed Prior to This PRD

Features already shipped that are NOT in scope above. Documented here for continuity.

### A1. Context Injection into Stop Hook (`stop-hook.js`)

The single most important architectural enhancement. The stop hook now builds a `buildHandoffSummary()` block and injects it as the `reason` field of every `decision: block` response. Claude Code injects `reason` as a system message at the start of each new iteration — surviving full context compression.

**Summary format:**
```
=== PICKLE RICK LOOP CONTEXT ===
Phase: implementation
Iteration: 4 of 10
Session: ~/.claude/pickle-rick/sessions/2026-01-15-a3f2
Ticket: abc123
Task: refactor the auth module
PRD: exists
Tickets:
  [x] def456: Set up database schema
  [~] abc123: Refactor auth module
  [ ] ghi789: Write integration tests

NEXT ACTION: Resume from current phase. Read state.json for context.
Do NOT restart from PRD. Continue where you left off.
```

Helper functions added to `stop-hook.js`: `statusSymbol()`, `parseTicketFrontmatter()`, `collectTickets()`, `buildHandoffSummary()`. These are candidates for extraction to `pickle-utils.js` (tracked in this PRD).

### A2. Jar Commands Port

Fully ported from the Gemini extension:
- `extension/services/jar-utils.js` — saves PRD + `meta.json` to `~/.claude/pickle-rick/jar/<date>/<session-id>/`, deactivates session with `completion_promise: 'JARRED'`
- `extension/bin/jar-runner.js` — iterates all "marinating" jar entries oldest-first, reactivates each session, spawns `claude --dangerously-skip-permissions --no-session-persistence -p <prompt>`, marks consumed/failed
- `.claude/commands/add-to-pickle-jar.md` — runs `jar-utils.js add`
- `.claude/commands/pickle-jar-open.md` — runs `jar-runner.js`, watches for "Signal: Jar Complete"

Key adaptation from Gemini: replaced `gemini /pickle --resume` with `claude --dangerously-skip-permissions --add-dir <sessionDir> --no-session-persistence --max-turns <N> -p <prompt>`.

### A3. `/disable-pickle` and `/enable-pickle`

Global hook silencing without uninstalling:
- `touch ~/.claude/pickle-rick/disabled` — stop-hook checks for this file as its first action and exits immediately (`process.exit(0)`) if found
- `.claude/commands/disable-pickle.md` — creates the marker, explains persona removal
- `.claude/commands/enable-pickle.md` — removes the marker
- Persona escape hatch added to `persona.md` and `CLAUDE.md`: if the user explicitly asks to drop the persona, Rick reverts to standard Claude for the remainder of the session

### A4. Existing PRD Detection in `/pickle`

`pickle.md` now runs a pre-flight check before the PRD drafting phase:
```bash
ls prd.md PRD.md 2>/dev/null | head -1
```
If found, copies the file into `${SESSION_ROOT}/prd.md` and skips directly to the PRD Completion Protocol. The user can drop a `prd.md` in their project root and the interrogation phase is bypassed entirely.

### A5. Bug Fixes

| Bug | Root Cause | Fix |
| :---- | :---- | :---- |
| `/pickle-prd` crashed with no arguments | `setup.js` required a task string unconditionally, even in `--paused` mode | Added `!pausedMode` guard; defaults `taskStr` to placeholder when paused |
| `--paused` flag consumed task string | `pickle-prd.md` passed `--paused $ARGUMENTS` — flag landed before task | Reordered to `$ARGUMENTS --paused` |
| Stop hook output `{"decision":"allow"}` | `dispatch.js` `allow()` used invalid schema value | Changed to `"approve"` (valid values: `"approve"`, `"block"`) |
| Fallback summary didn't truncate prompt | Both fallback paths in `stop-hook.js` used raw `original_prompt` | Added 300-char truncation consistent with `buildHandoffSummary` |
| `/pickle --resume` handoff message implied re-processing | `pickle-prd.md` said "break this down into tasks" | Updated to clarify Rick resumes at breakdown with full context, no re-processing |

---

## Appendix B: Feature Backlog (Not Yet PRD'd)

Ideas validated as worthwhile but not yet scoped. Ordered roughly by impact.

### B1. Parallel Morty Workers *(High Impact, Medium Effort)*

Currently tickets run sequentially. Independent tickets (no shared files) could run concurrently via `Promise.all()` on `spawn-morty.js` calls. A 5-ticket epic becomes as fast as the slowest ticket.

**Consideration**: Rick needs to detect ticket dependencies before parallelizing. Tickets that touch the same files must remain sequential. Could be as simple as a `depends_on` field in ticket frontmatter, or as naive as "always parallel, let Morty detect conflicts."

### B2. Linear.app Sync *(High Impact, Medium Effort)*

The local `linear_ticket_*.md` files mirror Linear ticket structure exactly. A `/pickle-sync-linear` command could push tickets to real Linear, update statuses as Mortys complete. The Linear MCP is already available in Claude Code sessions — no new dependencies.

**Consideration**: Bidirectional sync is complex. Start with one-way push only: local → Linear.

### B3. GitHub Issues as PRD Input *(High Impact, Medium Effort)*

`/pickle gh:owner/repo/issues/42` — fetch issue body via `gh issue view`, treat as PRD, skip drafting phase. Closes the loop between PM tools and execution.

**Consideration**: GitHub issue quality varies wildly. May need a lightweight cleanup/normalization step before saving as `prd.md`.

### B4. Worker Timeout Auto-Recovery *(Medium Impact, Low Effort)*

Currently when a Morty hits `--worker-timeout`, the ticket hangs at whatever status it was in. Rick's orchestration audit step should detect this: if a ticket has been "In Progress" for longer than `worker_timeout_seconds`, treat it as failed and offer to retry. Could be as simple as Rick checking ticket `updated` timestamp vs. `state.worker_timeout_seconds`.

### B5. Model Selection Per Phase *(Medium Impact, Low Effort)*

`spawn-morty.js` already constructs the `claude` command. Adding `--model haiku` for research/refactor phases and `--model sonnet` for planning would significantly reduce cost on large epics with no quality loss for the cheaper phases.

**Consideration**: User preference varies. Could be a `pickle_settings.json` config key: `"research_model": "claude-haiku-4-5-20251001"`.

### B6. PR Body Enrichment *(Medium Impact, Low Effort)*

`pr-factory.js` currently generates a sparse PR body (session name + original prompt). Could be enriched with: list of completed tickets, link to session dir, summary of files changed (`git diff --stat`). All information is already available at epic completion time.

**Consideration**: Explicitly marked as out-of-scope for the current PRD. Natural follow-on once auto-PR is wired up.

### B7. Cost / Token Tracking *(Low Impact, Low Effort)*

`state.json` already tracks timing. Could also track approximate token counts per session and per Morty via Claude Code's usage output. Useful for understanding what long Jar runs actually cost. Print a summary line at epic completion.

### B8. Session Dashboard *(Low Impact, High Effort)*

A formatted TUI or web view of all sessions and their states. Lower priority — `/pickle-status` covers the immediate need.

---

## Appendix C: Architecture & Key Patterns

Critical knowledge for future contributors. Read this before touching any core files.

### C1. Session Lookup Pattern

Sessions are tracked in `~/.claude/pickle-rick/current_sessions.json` — a flat JSON map of `{ "<cwd>": "<session_path>" }`. Every script that needs the session path for the current project uses this map keyed on `process.cwd()`. See `get-session.js` for the canonical lookup implementation.

**Important**: `stop-hook.js` uses `input.cwd` (from the hook's stdin JSON), NOT `process.cwd()`, because the hook process spawns in a different working directory.

### C2. Promise Token Pattern

The stop hook checks `input.last_assistant_message` for `<promise>TOKEN</promise>` strings. These control the loop:

| Token | Who outputs it | Effect |
| :---- | :---- | :---- |
| `PRD_COMPLETE` | Rick (manager) | Block exit, advance to breakdown |
| `TICKET_SELECTED` | Rick (manager) | Block exit, start research |
| `TICKET_COMPLETE` / `TASK_COMPLETE` | Rick (manager) | Block exit, move to next ticket |
| `BREAKDOWN_COMPLETE` | Rick (manager) | Block exit, advance to loop |
| `I AM DONE` | Morty (worker) | Allow exit — worker is finished |
| `EPIC_COMPLETED` / `TASK_COMPLETED` | Rick (manager) | Allow exit — full stop |

**Critical**: Worker processes share Rick's `state.json` but are detected via `PICKLE_ROLE=worker` env var. The stop hook does NOT increment `iteration` for workers.

### C3. Disabled Flag Pattern

`~/.claude/pickle-rick/disabled` is a zero-byte marker file. Stop hook checks for it as its absolute first action. Creating/removing this file is the mechanism for `/disable-pickle` and `/enable-pickle`. No config edits, no JSON mutation.

### C4. State Schema (`state.json`)

```json
{
  "active": true,
  "working_dir": "/path/to/project",
  "step": "prd | breakdown | research | implementation",
  "iteration": 3,
  "max_iterations": 5,
  "max_time_minutes": 60,
  "worker_timeout_seconds": 1200,
  "start_time_epoch": 1737000000,
  "completion_promise": null,
  "original_prompt": "refactor the auth module",
  "current_ticket": "abc123",
  "session_dir": "/path/to/sessions/2026-01-15-a3f2",
  "history": [],
  "started_at": "2026-01-15T10:00:00.000Z"
}
```

`jar_complete: true` is also a valid field — checked by stop hook to prevent infinite loops from prior jar sessions.

### C5. EXTENSION_ROOT vs SESSION_ROOT

- `EXTENSION_ROOT` = `~/.claude/pickle-rick/` — where scripts, hooks, and config live. **Never** put session data here.
- `SESSION_ROOT` = `~/.claude/pickle-rick/sessions/<date>-<hash>/` — per-run working directory. All tickets, PRD, state, and logs go here.

Commands and prompts reference both. `EXTENSION_ROOT` is stable across sessions; `SESSION_ROOT` changes every run.

### C6. ESM Requirement

`extension/package.json` has `"type": "module"`. All scripts use `import`/`export` syntax. This is non-negotiable — do not add `require()` calls or CommonJS patterns. Node.js 18+ required.

### C7. Deploy Pattern

The repo is the source of truth. The installed copy lives at `~/.claude/pickle-rick/`. After editing any source file, either:
- Run `bash install.sh` to redeploy everything, or
- `cp <source> <installed>` for targeted hot-patches (faster during development)

The stop hook, `pickle_settings.json`, `persona.md`, and all command files are copied — not symlinked — so edits to the repo do NOT take effect until deployed.

### C8. Morty Worker Invocation

```bash
claude \
  --dangerously-skip-permissions \
  --add-dir <ticket_dir> \
  --no-session-persistence \
  --max-turns <worker_timeout_seconds / ~30> \
  -p "<full send-to-morty prompt with ticket context>"
```

`--no-session-persistence` ensures each Morty starts fresh with no prior conversation. `--add-dir` scopes filesystem access to the ticket directory. `PICKLE_ROLE=worker` and `PICKLE_STATE_FILE` are set in the environment by `spawn-morty.js`.

---

## Appendix D: File Map

```
~/.claude/pickle-rick/               ← EXTENSION_ROOT
├── extension/
│   ├── bin/
│   │   ├── setup.js                 Session initializer. Parses args, creates state.json, writes current_sessions.json
│   │   ├── cancel.js                Marks session inactive (eat-pickle)
│   │   ├── spawn-morty.js           Spawns claude subprocess per ticket
│   │   ├── worker-setup.js          Morty-side session initializer
│   │   ├── get-session.js           Resolves session path from current_sessions.json
│   │   ├── update-state.js          Flat key/value mutator for state.json
│   │   ├── jar-runner.js            Night Shift batch executor
│   │   └── jar-utils.js             Jar queue helper (add/list entries)
│   ├── hooks/
│   │   ├── dispatch.js              Hook router (receives stop-hook event, delegates)
│   │   └── handlers/
│   │       └── stop-hook.js         ★ The loop engine. Reads state, decides block/approve, injects context
│   ├── services/
│   │   ├── pickle-utils.js          Shared utilities (Style, printMinimalPanel, getExtensionRoot)
│   │   ├── git-utils.js             Git helpers
│   │   ├── pr-factory.js            PR creation via gh CLI (CLI entrypoint + exported createPR())
│   │   └── jar-utils.js             Jar queue helper
│   └── package.json                 "type": "module" — critical
├── sessions/                        Per-run session directories
├── jar/                             Night Shift queue
├── current_sessions.json            CWD → session path map
├── pickle_settings.json             Default limits (max_iterations, max_time, worker_timeout, manager_max_turns)
├── persona.md                       Persona snippet — append to project CLAUDE.md
└── disabled                         (optional) Zero-byte marker — disables stop hook globally

~/.claude/commands/                  Installed slash commands
├── pickle.md                        Main loop (PRD + Breakdown + Orchestration inlined)
├── pickle-prd.md                    Interactive PRD drafter
├── eat-pickle.md                    Cancel loop
├── help-pickle.md                   Help text
├── send-to-morty.md                 Worker prompt (all 6 lifecycle phases inlined)
├── add-to-pickle-jar.md             Queue session for Night Shift
├── pickle-jar-open.md               Run Night Shift queue
├── disable-pickle.md                Create disabled marker
└── enable-pickle.md                 Remove disabled marker
```
