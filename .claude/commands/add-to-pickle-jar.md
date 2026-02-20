Please announce what you are doing.

You are jarring the current session's PRD for later execution.

**Step 1: Run the jar command**
```bash
SESSION_DIR=$(node "$HOME/.claude/pickle-rick/extension/bin/get-session.js")
node "$HOME/.claude/pickle-rick/extension/services/jar-utils.js" add --session "$SESSION_DIR"
```

**Step 2: Check the output**
- If it fails, report the error and stop.
- If it succeeds, verify the output says "Task successfully jarred".

**Step 3: Stop**
Once successfully jarred, say "Task jarred. Run `/pickle-jar-open` to execute it later." and end the turn.
