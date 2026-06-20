# R-CBI-GEMINI-1: gemini 0.32.1 CLI Surface Measurement

**Measured:** 2026-06-02  
**Binary:** `~/.nvm/versions/node/v25.6.1/bin/gemini`  
**Version:** `0.32.1` (installed via `npm i -g @google/gemini-cli`)  
**Source:** Google Gemini CLI (`@google/gemini-cli`)

## Contract answers

| ID | Contract point | Verbatim CLI evidence | Verdict |
|----|---------------|----------------------|---------|
| C1 | One-shot / headless flag | `-p, --prompt  Run in non-interactive (headless) mode with the given prompt. Appended to input on stdin (if any).  [string]` (from `gemini --help`). Description at top: "Defaults to interactive mode. Use -p/--prompt for non-interactive (headless) mode." | ✅ Confirmed. `-p`/`--prompt` is the exact headless analog of `claude -p`. |
| C2 | Prompt-passing mechanism | Two forms: (a) `-p "<prompt>"` / `--prompt "<prompt>"` (inline string arg); (b) stdin pipe (content read from stdin, appended to `-p` value if both provided — "Appended to input on stdin (if any)"). Positional `query` also accepted but puts CLI in interactive mode unless `-p` is used. | ✅ Confirmed: `-p` inline string is primary; stdin is additive. |
| C3 | Stream / output envelope spelling | `-o, --output-format  The format of the CLI output.  [string] [choices: "text", "json", "stream-json"]`. **json envelope (live-tested):** `{"session_id":"...","response":"...","stats":{"models":{...}}}`. **stream-json envelope (live-tested):** `{"type":"init","timestamp":"...","session_id":"...","model":"auto-gemini-3"}` → `{"type":"message","role":"user","content":"..."}` → `{"type":"message","role":"assistant","content":"...","delta":true}` → `{"type":"result","status":"success","stats":{...}}` (NDJSON). | ✅ Confirmed. Flag is `-o`/`--output-format` with values `text`, `json`, `stream-json`. |
| C4 | `--model` strings | `-m, --model  Model  [string]` — no choices enumeration; accepts any free-form string. Candidates `gemini-2.5-flash` and `gemini-2.5-pro` accepted without CLI error (exit 0, valid response). Default auto-routing (no `-m` flag) uses internal classifier: live test showed `gemini-3.1-flash-lite` + `gemini-3-flash-preview` in stats models map; stream-json init shows `"model":"auto-gemini-3"`. | ⚠️ `-m` accepts free-form strings. `gemini-2.5-flash` and `gemini-2.5-pro` are accepted; actual routing may still use internal model selection. Model IDs confirmed in stats JSON at runtime will differ from the `-m` string in some cases. |
| C5 | Exit semantics | Empirically confirmed: exit 0 = success (headless prompt completed, response returned); exit 1 = runtime/API error (auth failure: `GEMINI_API_KEY=INVALID_KEY` → exit 1; invalid CLI argument: `--bogus-flag-xyz` → exit 1). Two-code taxonomy: 0 = ok, 1 = any error. | ✅ Two-code exit taxonomy confirmed. |
| C6 | `--ignore-user-config` / `--no-config` equivalent | None found. Tested: `--ignore-user-config` → `Unknown arguments: ignore-user-config, ignoreUserConfig`; `--no-user-config` → `Unknown arguments: user-config, userConfig`; `--no-config` → `Unknown argument: config`. No config-isolation flag exists in `gemini --help`. MCP server allow-listing (`--allowed-mcp-server-names`) can restrict tool exposure but does not skip user config. | ❌ No direct equivalent. No `--ignore-user-config`, `--no-config`, or `--no-user-config` flag exists. Workaround: redirect HOME to a temp dir (`HOME=$(mktemp -d)`) to force fresh credential/config state. |
| C7 | Auth-failure stderr | Triggered via `GEMINI_API_KEY=INVALID_KEY HOME=/tmp/gemini-test-home gemini -p "hi"`. Output goes to **stdout** (confirmed: `2>/dev/null \| head -5` captures it; stderr-only capture to file was empty). First line: `Error generating content via API. Full report available at: /tmp/.../gemini-client-error-generateJson-api-<timestamp>.json ApiError: {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID","domain":"googleapis.com",...}]}}`. Also emits `[Routing] ClassifierStrategy failed:` and `Error when talking to Gemini API` lines, then a full stack trace on stdout. Exit code 1. | ✅ Confirmed. Auth error on stdout (not stderr), includes JSON error body + stack trace, exit 1. |
| C8 | Native sub-agent/swarm surface + EXACT disable flag | Swarm/auto-approve surface: `-y, --yolo  Automatically accept all actions (aka YOLO mode, ...)  [boolean] [default: false]`; `--approval-mode  Set the approval mode: default (prompt for approval), auto_edit (auto-approve edit tools), yolo (auto-approve all tools), plan (read-only mode)  [string] [choices: "default", "auto_edit", "yolo", "plan"]`. ACP (Agent Communication Protocol) mode: `--experimental-acp  Starts the agent in ACP mode  [boolean]`. **No explicit sub-agent spawn disable flag** (unlike grok's `--no-subagents`). `--yolo` (default: false) is the AUTO-APPROVE toggle; **INV-SWARM-OFF = omit `--yolo` (default: false) OR use `--approval-mode default`**. The yolo posture is disabled by default; `--approval-mode default` is explicit form. | ⚠️ No dedicated `--no-subagents` flag. Yolo/auto-approve is OFF by default. INV-SWARM-OFF = `--approval-mode default` (explicit) or simply omit `--yolo`. ACP sub-agent mode requires `--experimental-acp` (opt-in). |

## One-shot invocation string

```bash
~/.nvm/versions/node/v25.6.1/bin/gemini -p "<prompt>" --output-format stream-json --approval-mode default
```

## Swarm-disable flag

`--approval-mode default` (explicit form) — or simply omit `--yolo` (default is non-auto-approve).

No dedicated sub-agent disable flag analogous to grok's `--no-subagents` exists. Auto-approve is off by default.

## INV-MCP-DEFER note

No runtime MCP-injection flag found (unlike a hypothetical `--mcp-config-file`). MCP server config is persistent, managed via `gemini mcp add/remove/enable/disable` subcommands. At runtime, `--allowed-mcp-server-names <names>` RESTRICTS which configured MCP servers are allowed — it is a filter, not an injector. The `--experimental-acp` mode and the `mcp` subcommand exist but neither provides a session-scoped MCP config injection path. **INV-MCP-DEFER: R-MFW follow-up needed** — MCP config must be pre-baked via `gemini mcp add` (persistent) or via the `--allowed-mcp-server-names` allowlist.

## Raw `gemini --help` (verbatim, 2026-06-02)

```
Usage: gemini [options] [command]

Gemini CLI - Defaults to interactive mode. Use -p/--prompt for non-interactive (headless) mode.

Commands:
  gemini [query..]             Launch Gemini CLI  [default]
  gemini mcp                   Manage MCP servers
  gemini extensions <command>  Manage Gemini CLI extensions.  [aliases: extension]
  gemini skills <command>      Manage agent skills.  [aliases: skill]
  gemini hooks <command>       Manage Gemini CLI hooks.  [aliases: hook]

Positionals:
  query  Initial prompt. Runs in interactive mode by default; use -p/--prompt for non-interactive.

Options:
  -d, --debug                     Run in debug mode (open debug console with F12)  [boolean] [default: false]
  -m, --model                     Model  [string]
  -p, --prompt                    Run in non-interactive (headless) mode with the given prompt. Appended to input on stdin (if any).  [string]
  -i, --prompt-interactive        Execute the provided prompt and continue in interactive mode  [string]
  -s, --sandbox                   Run in sandbox?  [boolean]
  -y, --yolo                      Automatically accept all actions (aka YOLO mode, see https://www.youtube.com/watch?v=xvFZjo5PgG0 for more details)?  [boolean] [default: false]
      --approval-mode             Set the approval mode: default (prompt for approval), auto_edit (auto-approve edit tools), yolo (auto-approve all tools), plan (read-only mode)  [string] [choices: "default", "auto_edit", "yolo", "plan"]
      --policy                    Additional policy files or directories to load (comma-separated or multiple --policy)  [array]
      --experimental-acp          Starts the agent in ACP mode  [boolean]
      --allowed-mcp-server-names  Allowed MCP server names  [array]
      --allowed-tools             [DEPRECATED: Use Policy Engine instead See https://geminicli.com/docs/core/policy-engine] Tools that are allowed to run without confirmation  [array]
  -e, --extensions                A list of extensions to use. If not provided, all extensions are used.  [array]
  -l, --list-extensions           List all available extensions and exit.  [boolean]
  -r, --resume                    Resume a previous session. Use "latest" for most recent or index number (e.g. --resume 5)  [string]
      --list-sessions             List available sessions for the current project and exit.  [boolean]
      --delete-session            Delete a session by index number (use --list-sessions to see available sessions).  [string]
      --include-directories       Additional directories to include in the workspace (comma-separated or multiple --include-directories)  [array]
      --screen-reader             Enable screen reader mode for accessibility.  [boolean]
  -o, --output-format             The format of the CLI output.  [string] [choices: "text", "json", "stream-json"]
      --raw-output                Disable sanitization of model output (e.g. allow ANSI escape sequences). WARNING: This can be a security risk if the model output is untrusted.  [boolean]
      --accept-raw-output-risk    Suppress the security warning when using --raw-output.  [boolean]
  -v, --version                   Show version number  [boolean]
  -h, --help                      Show help  [boolean]
```

## Raw `gemini mcp --help` (verbatim, 2026-06-02)

```
gemini mcp

Manage MCP servers

Commands:
  gemini mcp add <name> <commandOrUrl> [args...]  Add a server
  gemini mcp remove <name>                        Remove a server
  gemini mcp list                                 List all configured MCP servers
  gemini mcp enable <name>                        Enable an MCP server
  gemini mcp disable <name>                       Disable an MCP server

Options:
  -d, --debug  Run in debug mode (open debug console with F12)  [boolean] [default: false]
  -h, --help   Show help  [boolean]
```
