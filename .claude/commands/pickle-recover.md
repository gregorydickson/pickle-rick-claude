You are recovering a Pickle Rick session that halted in `recovery_exhausted` — the single sanctioned, hook-safe operator recovery command.

> **Gate:** every subcommand EXCEPT `--reactivate` refuses to run unless the session's `state.exit_reason` is `recovery_exhausted`. `--reactivate` is the exception: it targets a COMPLETED session (`active:false`, `step:'completed'`), so it is exempt from the `recovery_exhausted` entry-state gate and instead refuses a still-live session (`active:true`). Each real (non-`--plan`) run performs EXACTLY ONE state transition via a shared primitive — never inline git, never a raw `state.json` write — and emits one `operator_recovery_transition` activity event.

Diagnose from the tree before picking: most halts trace to the recovery/salvage machinery, not the worker — `git fsck` for dangling commits and check ticket artifact mtimes first. An orphaned commit wants `--reattach-orphan`, the only subcommand that moves HEAD. A dirty tree wants `--salvage`, which archives the diff to a patch and re-queues the ticket — it never commits the work, green or not — and `--reset-ticket` does the same for a clean tree or an already-terminal ticket that `--salvage` declines.

Pick the subcommand for the situation, then run the recover script from the session's working directory:

**Re-queue the lowest runnable Todo** (reattaches any orphaned commit first, then clears `current_ticket`):
```bash
node "$HOME/.claude/pickle-rick/extension/bin/pickle-recover.js" --resume-from-todo
```

**Salvage one ticket** (a dirty non-terminal tree is archived to a patch and the ticket reset to Todo; a clean or already-terminal tree is a no-op — it never commits):
```bash
node "$HOME/.claude/pickle-rick/extension/bin/pickle-recover.js" --salvage <ticket>
```

**Reattach an orphaned commit** (ff-only HEAD-regression recovery):
```bash
node "$HOME/.claude/pickle-rick/extension/bin/pickle-recover.js" --reattach-orphan
```

**Reset a ticket to Todo** (archives the diff first, then re-queues the ticket). Naming the ticket is the decision: it re-queues on a clean tree and re-queues a terminal `Skipped`/`Done` ticket too, which `--salvage` will not do:
```bash
node "$HOME/.claude/pickle-rick/extension/bin/pickle-recover.js" --reset-ticket <id>
```

**Reactivate a completed session** (un-terminalizes a session driven to `{active:false, step:'completed'}`, re-pointing at the lowest runnable Todo; refuses a live `active:true` session — stop the pipeline first):
```bash
node "$HOME/.claude/pickle-rick/extension/bin/pickle-recover.js" --reactivate
```

Append `--plan` to any of the above for a dry-run that prints the would-be transition and writes nothing:
```bash
node "$HOME/.claude/pickle-rick/extension/bin/pickle-recover.js" --salvage <ticket> --plan
```

After the transition completes, re-run `setup.js --resume <SESSION_ROOT>` (or `bash launch.sh`) to continue the pipeline from the recovered state.
