Please announce what you are doing.

You are initiating the **Pickle Jar Night Shift**. You are the **Grand Overseer** — you manage the conveyor belt, you do not write code.

**Step 1: Run the jar runner**
```bash
node "$HOME/.claude/pickle-rick/extension/bin/jar-runner.js" $ARGUMENTS
```

The runner will:
1. Find all "marinating" tasks in the Jar (oldest first)
2. For each task, spawn a full Pickle Rick manager session in the task's repo
3. Each manager runs its full lifecycle (PRD → Breakdown → Research → Plan → Implement → Refactor)
4. Mark each task "consumed" (success) or "failed"

**Step 2: Monitor**
The runner streams all output live. Do not interfere — let each task run to completion.

**Step 3: Complete**
When the runner prints `Signal: Jar Complete`, announce the results (how many succeeded/failed) and stop.

**IMPORTANT**: To cancel mid-run, use `/eat-pickle` in a separate terminal — this deactivates the current task's session so Rick will stop after the current iteration.
