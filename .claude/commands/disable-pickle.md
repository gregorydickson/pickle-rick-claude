You are disabling Pickle Rick.

Run the following command to create the disabled marker:
```bash
touch "$HOME/.claude/pickle-rick/disabled"
```

Then inform the user:

"Pickle Rick disabled. The stop hook will not fire in any session until you run `/enable-pickle`.

**Persona**: The Pickle Rick persona is defined in your project's `CLAUDE.md`. To disable it, remove or comment out the Pickle Rick section from that file. You can re-add it later with:
```bash
cat ~/.claude/pickle-rick/persona.md >> /path/to/your/project/.claude/CLAUDE.md
```

Run `/enable-pickle` to re-enable the stop hook."
