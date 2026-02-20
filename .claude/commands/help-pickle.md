Display the Pickle Rick for Claude Code help documentation.

Summarize the available commands for the user:
- `/pickle <prompt>`: Start the autonomous development loop (Manager Mode).
- `/pickle-prd <prompt>`: Interactively draft a PRD and initialize a session in paused mode, then resume with `/pickle --resume`.
- `/eat-pickle`: Stop/Cancel the current loop.
- `/help-pickle`: Show this message.

**Advanced Flags for /pickle:**
- `--resume [PATH]`: Resume an existing session.
- `--max-iterations <N>`: Stop after N iterations (default: 5).
- `--max-time <M>`: Stop after M minutes (default: 60).
- `--worker-timeout <S>`: Timeout for individual workers in seconds (default: 1200).
- `--completion-promise "TEXT"`: Only stop when the agent outputs `<promise>TEXT</promise>`.

**Note**: Jar commands (`/add-to-pickle-jar`, `/pickle-jar-open`) are **not available** in this Claude Code port. They are a planned follow-up milestone.
