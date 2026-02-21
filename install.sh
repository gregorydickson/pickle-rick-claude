#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$HOME/.claude/pickle-rick"
COMMANDS_DIR="$HOME/.claude/commands"
SETTINGS_FILE="$HOME/.claude/settings.json"
# IMPORTANT: $HOME is intentionally a literal here — it gets expanded at runtime
# by the shell when Claude Code executes the hook command. Do NOT expand it at install time.
HOOK_CMD_LITERAL='node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook'

echo "🥒 Installing Pickle Rick for Claude Code..."

# --- VALIDATION ---
node --version >/dev/null 2>&1    || { echo "❌ node not found on PATH"; exit 1; }
jq --version >/dev/null 2>&1     || { echo "❌ jq not found on PATH"; exit 1; }
claude --version >/dev/null 2>&1 || echo "⚠️  claude CLI not on PATH (needed at runtime for worker spawning)"
[ -f "$SETTINGS_FILE" ]          || { echo "❌ ~/.claude/settings.json not found. Run 'claude' at least once first."; exit 1; }
jq . "$SETTINGS_FILE" >/dev/null 2>&1 || { echo "❌ settings.json is not valid JSON"; exit 1; }
[ -d "$SCRIPT_DIR/extension" ]   || { echo "❌ extension/ not found. Are you running from the repo root?"; exit 1; }
[ -d "$SCRIPT_DIR/.claude/commands" ] || { echo "❌ .claude/commands/ not found. Are you running from the repo root?"; exit 1; }

# --- BACKUP ---
mkdir -p "$HOME/.claude/backups"
cp "$SETTINGS_FILE" "$HOME/.claude/backups/settings.json.pickle-backup.$(date +%s)"
echo "✅ Backed up settings.json to ~/.claude/backups/"

# --- DIRECTORIES ---
mkdir -p "$EXTENSION_ROOT" "$COMMANDS_DIR"

# --- EXTENSION SCRIPTS ---
# cp -r includes extension/package.json → required for ESM "type":"module" (all scripts use import)
cp -r "$SCRIPT_DIR/extension/." "$EXTENSION_ROOT/extension/"
cp "$SCRIPT_DIR/pickle_settings.json" "$EXTENSION_ROOT/"
# Store persona snippet — append this to your project's CLAUDE.md
cp "$SCRIPT_DIR/persona.md" "$EXTENSION_ROOT/persona.md"

# --- PERMISSIONS (files with shebangs that may be invoked directly) ---
chmod +x "$EXTENSION_ROOT/extension/hooks/dispatch.js"
chmod +x "$EXTENSION_ROOT/extension/bin/setup.js"
chmod +x "$EXTENSION_ROOT/extension/bin/cancel.js"
chmod +x "$EXTENSION_ROOT/extension/bin/spawn-morty.js"
chmod +x "$EXTENSION_ROOT/extension/bin/worker-setup.js"
chmod +x "$EXTENSION_ROOT/extension/bin/jar-runner.js"

# --- COMMANDS ---
cp "$SCRIPT_DIR/.claude/commands/pickle.md"            "$COMMANDS_DIR/"
cp "$SCRIPT_DIR/.claude/commands/pickle-prd.md"        "$COMMANDS_DIR/"
cp "$SCRIPT_DIR/.claude/commands/eat-pickle.md"        "$COMMANDS_DIR/"
cp "$SCRIPT_DIR/.claude/commands/help-pickle.md"       "$COMMANDS_DIR/"
cp "$SCRIPT_DIR/.claude/commands/send-to-morty.md"     "$COMMANDS_DIR/"
cp "$SCRIPT_DIR/.claude/commands/add-to-pickle-jar.md" "$COMMANDS_DIR/"
cp "$SCRIPT_DIR/.claude/commands/pickle-jar-open.md"   "$COMMANDS_DIR/"
cp "$SCRIPT_DIR/.claude/commands/disable-pickle.md"    "$COMMANDS_DIR/"
cp "$SCRIPT_DIR/.claude/commands/enable-pickle.md"     "$COMMANDS_DIR/"

# --- STOP HOOK (idempotent jq merge, $HOME stays LITERAL in JSON) ---
if jq -e '.hooks.Stop // [] | map(.hooks // [] | map(.command)) | flatten | any(. == "node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook")' \
    "$SETTINGS_FILE" >/dev/null 2>&1; then
  echo "⚠️  Stop hook already registered — skipping"
else
  jq '
    "node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook" as $cmd |
    {"type": "command", "command": $cmd} as $entry |
    if .hooks == null then
      .hooks = {"Stop": [{"hooks": [$entry]}]}
    elif .hooks.Stop == null then
      .hooks.Stop = [{"hooks": [$entry]}]
    else
      .hooks.Stop += [{"hooks": [$entry]}]
    end
  ' "$SETTINGS_FILE" > /tmp/pickle-settings-merged.json \
    && mv /tmp/pickle-settings-merged.json "$SETTINGS_FILE"
  echo "✅ Registered Stop hook in $SETTINGS_FILE"
fi

# --- VALIDATE result ---
jq . "$SETTINGS_FILE" >/dev/null 2>&1 || { echo "❌ settings.json corrupted after merge — restore from backup"; exit 1; }

echo ""
echo "✅ Pickle Rick for Claude Code installed!"
echo ""
echo "📝 Persona setup — add the Pickle Rick persona to your project's CLAUDE.md:"
echo ""
echo "   # If your project already has a CLAUDE.md:"
echo "   cat $EXTENSION_ROOT/persona.md >> /path/to/project/.claude/CLAUDE.md"
echo ""
echo "   # If starting fresh:"
echo "   mkdir -p /path/to/project/.claude"
echo "   cp $EXTENSION_ROOT/persona.md /path/to/project/.claude/CLAUDE.md"
echo ""
echo "Get started in any project: /pickle \"your task here\""
echo "Queue tasks for later:      /add-to-pickle-jar  then  /pickle-jar-open"
