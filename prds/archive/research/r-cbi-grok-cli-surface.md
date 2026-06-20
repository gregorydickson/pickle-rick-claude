# R-CBI-GROK-1: grok 0.2.17 CLI Surface Measurement

**Measured:** 2026-06-02  
**Binary:** `~/.local/bin/grok`  
**Version:** `grok 0.2.17 (d42c204ca3e) [alpha]`  
**Source:** xAI Grok Build

## Contract answers

| ID | Contract point | Verbatim CLI evidence | Verdict |
|----|---------------|----------------------|---------|
| C1 | One-shot / headless flag | `-p, --single <PROMPT>` — "Single-turn prompt. Prints the response to stdout and exits" | ✅ Confirmed. `-p` is the exact analog of `claude -p`. Operator-reported `--output-format streaming-json` is a separate flag (C3), not the headless trigger itself. |
| C2 | Prompt-passing mechanism | Three forms: (a) `-p <PROMPT>` / `--single <PROMPT>` (inline string); (b) `--prompt-file <PATH>` (read from file); (c) `--prompt-json <JSON>` (JSON content blocks) | ✅ All three confirmed by `grok --help` output. |
| C3 | Stream / output envelope spelling | `--output-format <OUTPUT_FORMAT>` — `[default: plain] [possible values: plain, json, streaming-json]`. **streaming-json NDJSON envelope:** `{"type":"thought","data":"..."}` (streaming thoughts), `{"type":"text","data":"..."}` (streaming text), `{"type":"end","stopReason":"EndTurn","sessionId":"...","requestId":"..."}` (terminal frame). **json envelope (non-streaming):** `{"text":"...","stopReason":"EndTurn","sessionId":"...","requestId":"...","thought":"..."}` | ✅ Confirmed via live invocation: `grok -p "say exactly: hello" --output-format streaming-json` |
| C4 | `--model` strings | `-m, --model <MODEL>` — "Model ID to use". `grok models` output: `grok-composer-2.5-fast` (default, marked `*`), `grok-build`. Candidate `grok-code-fast-1` **NOT listed** in available models. Default in `config.toml`: `default = "grok-composer-2.5-fast"` | ⚠️ `grok-code-fast-1` not available. Only `grok-composer-2.5-fast` and `grok-build` are listed. |
| C5 | Exit semantics | Exit 0 = success (prompt completed, `--single` flow). Exit 1 = runtime / API error (invalid key, network error, internal error). Exit 2 = CLI argument error (`error: unexpected argument '...' found`). Confirmed: `grok -p "say hi" --output-format plain` → EXIT 0; `XAI_API_KEY=invalid_key GROK_HOME=/tmp/empty grok -p "hi"` → EXIT 1; `grok -p "hi" --nonexistent-flag` → EXIT 2 | ✅ Three-code taxonomy confirmed. |
| C6 | `--ignore-user-config` equivalent | **No direct equivalent found.** Closest mitigations: (a) `--system-prompt-override <PROMPT>` overrides the agent's system prompt / Agents.md (`Claude Code: --system-prompt`); (b) `GROK_HOME=<tmpdir>` env var redirects the entire config directory (Agents.md, config.toml, auth.json) to a temp path; (c) `--no-memory` disables cross-session memory. No `--no-agents-file`, `--no-config`, or `--ignore-user-config` flag exists. | ❌ No direct analog. Workaround: `GROK_HOME=$(mktemp -d)` + `--system-prompt-override ""` for isolation. |
| C7 | Auth-failure stderr | Triggered via `XAI_API_KEY=xai-invalidkeyfortesting GROK_HOME=$(mktemp -d) grok -p "hi" --output-format plain`. Stderr output (ANSI-colored, goes to stdout in plain mode): `ERROR responses API error status=400 Bad Request error_message=Client specified an invalid argument: Incorrect API key provided: xa***ng. You can obtain an API key from https://console.x.ai. Request URL: https://api.x.ai/v1/responses model_id=grok-build` followed by `Internal error: {"message": "API error (status 400 Bad Request): ...", "http_status": 400}` and `Error: Internal error: {...}`. Exit code 1. | ✅ Confirmed. Auth error emits structured ERROR lines + JSON error blob to stdout (mixed with response stream), exits 1. |
| C8 | Native swarm surface + EXACT disable flag | Swarm/multi-agent surface: `--agents <JSON>` ("Inline subagent definitions as JSON"), `--agent <NAME>` ("Agent name or definition file path"), `--best-of-n <N>` ("Run the task N ways in parallel and pick the best (headless only)"). **EXACT disable flag: `--no-subagents`** ("Disable subagent spawning"). | ✅ Native swarm confirmed. INV-SWARM-OFF = `--no-subagents`. |

## One-shot invocation string

```bash
grok -p "<prompt>" --output-format streaming-json --no-subagents
```

## Swarm-disable flag

`--no-subagents`

## Raw `grok --help` (verbatim, 2026-06-02)

```
Grok Build TUI

Usage: grok [OPTIONS] [COMMAND]

Options:
      --agent <NAME>
          Agent name or definition file path

      --agents <JSON>
          Inline subagent definitions as JSON

      --allow <RULE>
          Permission allow rule (Claude Code: --allowedTools)

      --always-approve
          Auto-approve all tool executions

      --best-of-n <N>
          Run the task N ways in parallel and pick the best (headless only)

  -c, --continue
          Continue the most recent session for the current working directory

      --check
          Append a self-verification loop to the prompt (headless only)

      --compaction-detail <DETAIL>
          Segments verbatim detail [none|minimal|balanced|verbose] (default `verbose`). Only affects
          `--compaction-mode segments`. Sets `GROK_COMPACTION_DETAIL`

      --compaction-mode <MODE>
          Compaction mode [summary|transcript|segments]: `summary` (default) adds no pointer;
          `transcript` points at the raw transcript; `segments` persists per-segment markdown to grep.
          Sets `GROK_COMPACTION_MODE`

      --cwd <CWD>
          Working directory

      --deny <RULE>
          Permission deny rule (Claude Code: --disallowedTools)

      --disable-web-search
          Disable web search and web fetch tools

      --disallowed-tools <TOOLS>
          Built-in tools to remove (comma-separated)

      --effort <LEVEL>
          Effort level

          [possible values: low, medium, high, xhigh, max]

      --experimental-memory
          Enable cross-session memory

  -h, --help
          Print help (see a summary with '-h')

  -m, --model <MODEL>
          Model ID to use

      --max-turns <N>
          Maximum number of agent turns

      --no-alt-screen
          Run inline instead of using the terminal alternate screen

      --no-memory
          Disable cross-session memory for this session

      --no-plan
          Disable plan mode

      --no-subagents
          Disable subagent spawning

      --oauth
          Use OAuth when the welcome screen starts authentication

      --output-format <OUTPUT_FORMAT>
          Output format for headless mode

          [default: plain]
          [possible values: plain, json, streaming-json]

  -p, --single <PROMPT>
          Single-turn prompt. Prints the response to stdout and exits

      --permission-mode <MODE>
          Permission mode

          [possible values: default, acceptEdits, auto, dontAsk, bypassPermissions, plan]

      --prompt-file <PATH>
          Single-turn prompt from a file

      --prompt-json <JSON>
          Single-turn prompt as JSON content blocks

  -r, --resume [<SESSION_ID>]
          Resume a session by ID, or the most recent if omitted

      --reasoning-effort <EFFORT>
          Reasoning effort for reasoning models

      --restore-code
          Check out the original session's commit when resuming

      --rules <RULES>
          Extra rules to append to the system prompt

      --sandbox <PROFILE>
          Sandbox profile for filesystem and network access

          [env: GROK_SANDBOX=]

      --system-prompt-override <PROMPT>
          Override the agent's system prompt (Claude Code: --system-prompt)

      --todo-gate
          Enable the runtime turn-end TodoGate for this session.

      --tools <TOOLS>
          Built-in tools to allow (comma-separated)

  -v, --version
          Print version

      --verbatim
          Send the prompt exactly as given

  -w, --worktree [<WORKTREE>]
          Start the session in a new git worktree, optionally named

Commands:
  agent        Run Grok without the interactive UI
  completions  Generate shell completion scripts
  export       Export a session transcript as Markdown
  help         Print this message or the help of the given subcommand(s)
  import       Import sessions into Grok
  inspect      Show the configuration Grok discovers for this directory
  leader       Manage running leader processes
  login        Sign in to Grok
  logout       Sign out and clear cached credentials
  mcp          Manage MCP server configurations
  memory       Manage cross-session memory
  models       List available models and exit
  plugin       Manage plugins and marketplace sources
  sessions     List, search, or restore sessions
  setup        Fetch and install managed deployment configuration
  ssh          Run ssh with local clipboard support
  trace        Export or upload session trace data
  update       Check for updates or install a specific version
  version      Print version information [aliases: v]
  worktree     Manage git worktrees
```

## Raw `grok models` (verbatim, 2026-06-02)

```
You are logged in with grok.com.

Default model: grok-composer-2.5-fast

Available models:
  * grok-composer-2.5-fast (default)
  - grok-build
```

## Notes for R-CBI-GROK-2 (backend builder)

- **Headless one-shot works**: `grok -p "<prompt>" --output-format streaming-json` confirmed functional
- **`grok-code-fast-1` absent**: Not in model catalog. Must use `grok-build` or `grok-composer-2.5-fast`
- **No `--ignore-user-config`**: If config isolation is needed, use `GROK_HOME=$(mktemp -d)` as env prefix
- **Swarm**: `--no-subagents` is the exact disable flag (INV-SWARM-OFF); include in backend builder invocations
- **Exit 1 = any runtime failure**: Distinguish from exit 2 (CLI arg error) in error handling
- **Auth uses OIDC cached token** (`~/.grok/auth.json`); `XAI_API_KEY` env var supported as fallback
