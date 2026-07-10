Execute all queued Pickle Jar tasks sequentially in Night Shift batch mode.

You are the **Grand Overseer** — manage the conveyor belt, do not write code.

**Step 1**: `node "$HOME/.claude/pickle-rick/extension/bin/jar-runner.js" $ARGUMENTS`

Launch jar-runner inside a detached tmux session (`tmux new-session -d -s pickle-jar '<command>'`), NEVER a plain foreground Bash call (the 600s tool ceiling kills a multi-hour batch mid-task) or a backgrounded one (reaped at turn-end, exit 143 — R-MWBG). A mid-task kill orphans the in-flight worker's uncommitted work: before any re-run, `git status` the task repo and commit-if-green with scoped paths first.

The runner finds all "marinating" tasks (oldest first), spawns a full Pickle Rick manager per task, marks each "consumed" or "failed". For `deepseek`-backed tasks the `DEEPSEEK_API_KEY` environment variable must be set in the outer jar process (it is spread into the child environment alongside `PICKLE_BACKEND`).

**Step 2**: Do not interfere — let each task complete.

**Step 3**: When runner prints `Signal: Jar Complete`, announce results (succeeded/failed counts) and stop. Cancel mid-run: `/eat-pickle` in a separate terminal.

## Backend

`/pickle-jar-open` takes no `--backend` flag. Each queued task carries its own backend, resolved per-task from that task's `state.json` via `resolveBackend(state)` against the already-parsed state object. The runner routes the manager spawn through `codex exec` when `state.backend === 'codex'`, otherwise `claude`, and spreads `PICKLE_BACKEND=<backend>` into the child environment so transitively-spawned workers inherit it. A single jar run can therefore mix claude-backed and codex-backed tasks — whatever was stored at `/pickle-tmux ... --backend <x>` or `/add-to-pickle-jar` time is replayed faithfully. The active backend is printed in the "Running Jarred Task" panel for each task. If the outer jar process has `PICKLE_BACKEND` in its environment, per-task `state.backend` still wins; workers spawned under each task see `PICKLE_BACKEND` rewritten to match that task's backend.

If the manager CLI (`codex` or `claude`) is not on `PATH`, jar-runner prints an install hint and leaves that task's status untouched (still `marinating`) rather than marking it `failed` — a future `/pickle-jar-open` succeeds once the CLI is installed. When a codex-backed task hits ENOENT, remaining codex-backed tasks are short-circuited (they'd all ENOENT identically); claude-backed tasks further down the queue still run.
