You are retrying a failed or timed-out Pickle Rick ticket.

> **Backend:** Inherited from the original session's `state.json` (`claude` or `codex`). The retry runs on the same backend the ticket originally used — there is no `--backend` override on retry.

Run the retry script with the ticket ID:
```bash
node "$HOME/.claude/pickle-rick/extension/bin/retry-ticket.js" $ARGUMENTS
```

After the script runs:
1. Read the printed `spawn-morty.js` command from the output.
2. Run `git status` and READ the diff before touching the tree. A Failed/timed-out ticket with fresh artifacts + a real diff is usually a spurious Failed-flip — verify the diff against the ticket's ACs and, if green, commit it (scoped paths) and mark Done instead of retrying. Never blind-stash: a stash buries verified work the respawned worker will never restore. Only genuinely unverifiable leftovers get archived (path-scoped) before respawn.
3. If step 2 did NOT already resolve the ticket (committed + marked Done), execute the printed spawn-morty command exactly as shown. A ticket resolved in step 2 needs no respawn — stop there.
4. After Morty outputs `<promise>I AM DONE</promise>`, proceed with the standard validation and commit flow (audit docs, check git diff, run tests, commit if passing, mark ticket Done).
