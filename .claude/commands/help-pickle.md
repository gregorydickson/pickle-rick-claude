Display the Pickle Rick for Claude Code help documentation.

Summarize the available commands for the user:

**Loop Commands:**
- `/pickle <prompt>`: Start the autonomous development loop (Manager Mode).
- `/pickle-prd <prompt>`: Interactively draft a PRD and initialize a session in paused mode, then resume with `/pickle --resume`.
- `/eat-pickle`: Stop/Cancel the current loop.
- `/help-pickle`: Show this message.

**Jar Commands (Night Shift / Queue Mode):**
- `/add-to-pickle-jar`: Save the current session's PRD to the Jar for later batch execution.
- `/pickle-jar-open`: Run all queued Jar tasks sequentially (Grand Overseer Mode).

**Advanced Flags for /pickle:**
- `--resume [PATH]`: Resume an existing session.
- `--max-iterations <N>`: Stop after N iterations (default: 5).
- `--max-time <M>`: Stop after M minutes (default: 60).
- `--worker-timeout <S>`: Timeout for individual workers in seconds (default: 1200).
- `--completion-promise "TEXT"`: Only stop when the agent outputs `<promise>TEXT</promise>`.
