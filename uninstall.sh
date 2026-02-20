#!/bin/bash
set -e

SETTINGS_FILE="$HOME/.claude/settings.json"

echo "🥒 Uninstalling Pickle Rick for Claude Code..."

# Remove extension scripts
rm -rf "$HOME/.claude/pickle-rick/"

# Remove commands (by exact name — does NOT touch user's other commands)
rm -f "$HOME/.claude/commands/pickle.md"
rm -f "$HOME/.claude/commands/pickle-prd.md"
rm -f "$HOME/.claude/commands/eat-pickle.md"
rm -f "$HOME/.claude/commands/help-pickle.md"
rm -f "$HOME/.claude/commands/send-to-morty.md"

# Remove Stop hook from settings.json (clean up empty Stop/hooks keys)
if [ -f "$SETTINGS_FILE" ]; then
  jq '
    "node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook" as $cmd |
    if .hooks.Stop then
      .hooks.Stop = [.hooks.Stop[] | select(.hooks | map(.command) | any(. == $cmd) | not)] |
      if (.hooks.Stop | length) == 0 then del(.hooks.Stop) else . end |
      if (.hooks | keys | length) == 0 then del(.hooks) else . end
    else . end
  ' "$SETTINGS_FILE" > /tmp/pickle-uninstall.json \
    && mv /tmp/pickle-uninstall.json "$SETTINGS_FILE"
  echo "✅ Removed Stop hook from settings.json"
fi

echo ""
echo "✅ Pickle Rick uninstalled."
echo "📝 Project-local CLAUDE.md files were NOT removed — delete them manually if desired."
echo "📝 Backup: ~/.claude/backups/ (if you ran install.sh) — safe to delete manually."
