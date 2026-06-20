# R-CBI-KIMI-1: kimi 1.38.0 CLI Surface Measurement

**Measured:** 2026-06-02  
**Binary:** `~/.local/bin/kimi` → `~/.local/share/uv/tools/kimi-cli/bin/kimi`  
**Version:** `kimi, version 1.38.0` (Python 3.13.12)  
**Vendor:** MoonshotAI  

---

## Contract answers

| Contract | Answer | Verbatim evidence |
|---|---|---|
| **C1** one-shot flag | `--print` | `--print  Run in print mode (non-interactive). Note: print mode implicitly adds \`--yolo\`.` |
| **C2** prompt-passing | `--prompt`/`-p`/`--command`/`-c TEXT` | `--prompt,--comm… -p,-c TEXT  User prompt to the agent. Default: prompt interactively.` |
| **C3** output envelope | `--output-format [text\|stream-json]` | `--output-format  [text\|stream-json]  Output format to use. Must be used with \`--print\`. Default: text.` |
| **C4** --model | `--model`/`-m TEXT` | `--model -m TEXT  LLM model to use. Default: default model set in config file.` |
| **C5** exit semantics | 0=success, 1=failure, 75=retryable | `class ExitCode: SUCCESS=0  FAILURE=1  RETRYABLE=75  # EX_TEMPFAIL from sysexits.h` |
| **C6** ignore-user-config | `--config '<json-or-toml>'` replaces `~/.kimi/config.toml` entirely (no merge) | `--config TEXT  Config TOML/JSON string to load. Default: none.` + `config = load_config_from_string(config_string)` (no default file read when provided) |
| **C7** auth-failure stderr | `LLMNotSet` → `print(str(e))` → **stdout**, exit 1. Resume hint `"To resume this session: kimi -r <id>"` → `_emit_fatal_error()` → **stderr** | `except LLMNotSet as e: logger.exception("LLM not set:"); print(str(e)); return ExitCode.FAILURE` (`ui/print/__init__.py:410-413`) |
| **C8** Agent Swarm posture + disable flag | **Client-side sub-agent system, not a server-side K2.5/K2.6 swarm.** Both `default` and `okabe` agent specs include `kimi_cli.tools.agent:Agent`. Sub-agents run foreground in-process via `ForegroundSubagentRunner`. Max depth = 1 (sub-agents CANNOT recursively spawn). **No explicit `--no-swarm` or `--no-agent` flag (INV-SWARM-OFF).** Only disable path: `--agent-file <custom-yaml>` pointing to a spec that excludes `kimi_cli.tools.agent:Agent` from the tools list. | `"Subagents cannot launch other subagents."` (`tools/agent/__init__.py`); `okabe/agent.yaml` includes `"kimi_cli.tools.agent:Agent"` |

---

## Detailed evidence per contract

### C1 — One-shot flag

```
$ kimi --help
--print   Run in print mode (non-interactive).
          Note: print mode implicitly adds `--yolo`.
--quiet   Alias for `--print --output-format text --final-message-only`.
```

`--print` is the canonical one-shot flag. `--quiet` is the compact alias.  
Canonical Shape-B invocation: `kimi --print --prompt "task"`.

### C2 — Prompt-passing

```
--prompt,--comm…  -p,-c  TEXT   User prompt to the agent. Default: prompt interactively.
```

Aliases: `--prompt`, `--command`, `-p`, `-c`. Used with `--print` for scripted invocations.  
`--input-format stream-json` enables NDJSON streaming via stdin in print mode.

### C3 — Output envelope

```
--output-format  [text|stream-json]   Output format to use. Must be used with `--print`. Default: text.
--final-message-only                  Only print the final assistant message (print UI).
```

- `text` (default): streaming plain text to stdout  
- `stream-json`: NDJSON event stream to stdout  
- `--final-message-only`: suppresses intermediate output, emits only final assistant message  

### C4 — --model

```
--model  -m  TEXT   LLM model to use. Default: default model set in config file.
```

Short form: `-m`. Takes model name string (format depends on provider config in `~/.kimi/config.toml`).

### C5 — Exit semantics

Source: `kimi_cli/cli/__init__.py:53-57`:
```python
class ExitCode:
    SUCCESS = 0
    FAILURE = 1
    RETRYABLE = 75  # EX_TEMPFAIL from sysexits.h
```

Exit 75 (RETRYABLE) is returned for:
- HTTP 429, 500, 502, 503, 504 from the LLM provider  
- `APIConnectionError`, `APITimeoutError`, `APIEmptyResponseError`  

Source: `_classify_provider_error` in `kimi_cli/ui/print/__init__.py:440-449`.

Observed in test:
```
$ kimi --config '{"api_key":"BOGUS"}' --print --prompt "hi"; echo "EXIT:$?"
...LLM not set
EXIT:1
```

### C6 — Ignore-user-config equivalent

No dedicated `--no-config` flag. The closest equivalent:

```
--config TEXT    Config TOML/JSON string to load. Default: none.
--config-file FILE  Config TOML/JSON file to load. Default: ~/.kimi/config.toml.
```

When `--config` is provided, `load_config_from_string()` is called and the default `~/.kimi/config.toml` is **not read**. There is no merging — the provided string is the entire config. Passing a minimal config (e.g., `--config 'default_model=""'`) effectively bypasses user API keys and provider settings.

Source: `kimi_cli/cli/__init__.py:491-501`:
```python
if config_string is not None:
    config = load_config_from_string(config_string)
elif config_file is not None:
    config = config_file
# else: load_config() reads ~/.kimi/config.toml
```

### C7 — Auth-failure stderr

In print mode (`--print`), when no LLM is configured (`LLMNotSet`):

**stdout** receives (via Python builtin `print()`):
```
LLM not set
```

**stderr** receives (via `_emit_fatal_error()` → original fd):
```
To resume this session: kimi -r <session-uuid>
```

Exit code: **1** (FAILURE).

Source `kimi_cli/ui/print/__init__.py:410-413`:
```python
except LLMNotSet as e:
    logger.exception("LLM not set:")
    print(str(e))          # → stdout
    return ExitCode.FAILURE
```

Source `kimi_cli/cli/__init__.py:388-396`:
```python
def _emit_fatal_error(message: str) -> None:
    with open_original_stderr() as stream:
        if stream is not None:
            stream.write(...)  # → original stderr fd
            return
    typer.echo(message, err=True)
```

**Implication for Shape-B backend:** auth errors go to stdout (not stderr); stdout parsing must handle `LLM not set` as an error sentinel. stderr is safe for logging only.

### C8 — Agent Swarm posture + disable flag (INV-SWARM-OFF)

#### What the "swarm" is

kimi 1.38.0 ships an **`Agent` tool** in both built-in agent specs (`default` and `okabe`). This is a **client-side sub-agent system**, NOT a server-side K2.5/K2.6 Agent Swarm:

- Sub-agents run **in-process** via `ForegroundSubagentRunner`  
- Sub-agents are **foreground** (blocking), not background workers  
- Max depth = 1: `"Subagents cannot launch other subagents."` (`kimi_cli/tools/agent/__init__.py`)  
- Sub-agents write to the same session; their output is captured inline  

#### Built-in agent specs

**`default` agent** (`agents/default/agent.yaml`):
```yaml
tools:
  - "kimi_cli.tools.agent:Agent"
  # ... (coder, explore, plan subagents defined)
subagents:
  coder: {path: ./coder.yaml, description: "Good at general software engineering tasks."}
  explore: {path: ./explore.yaml, description: "Fast codebase exploration with prompt-enforced read-only behavior."}
  plan: {path: ./plan.yaml, description: "Read-only implementation planning and architecture design."}
```

**`okabe` agent** (`agents/okabe/agent.yaml`):
```yaml
extend: default
tools:
  - "kimi_cli.tools.agent:Agent"
  - "kimi_cli.tools.dmail:SendDMail"
  - "kimi_cli.tools.ask_user:AskUserQuestion"
  - "kimi_cli.tools.todo:SetTodoList"
  - "kimi_cli.tools.shell:Shell"
  # ... (extends default, adds dmail + more)
```

`--agent okabe` selects the Okabe agent (named after Steins;Gate's Rintaro Okabe). It's a superset of `default` with additional tools.

#### INV-SWARM-OFF: disable path

There is **no explicit `--no-swarm` or `--no-agent` flag** in kimi 1.38.0.

The only disable path:
```bash
kimi --print --agent-file <custom-spec.yaml> --prompt "task"
```
Where `custom-spec.yaml` is a custom agent spec that **excludes** `kimi_cli.tools.agent:Agent` from its `tools` list.

```yaml
# custom-no-swarm.yaml
version: 1
agent:
  extend: default
  exclude_tools:
    - "kimi_cli.tools.agent:Agent"
```

Or equivalently, a spec with an explicit `tools` list that omits the `Agent` entry.

#### Shape-B / worker-only assessment

Since the sub-agent system is **client-side and suppressible** via `--agent-file`, kimi is compatible with Shape-B use:

- Worker-only path: use `kimi --print --agent-file <no-swarm-spec> --prompt "task"` to disable the Agent tool  
- If using default agent, the Agent tool is present but only fires when the model decides to use it; for simple one-shot tasks it typically does not  
- No Shape-D (research-delegate) escalation required — the swarm is not opaque server-side infrastructure  

#### `vis` subcommand

```
kimi vis   Run Kimi Agent Tracing Visualizer.
```
A local web server (default port 5495) for visualizing agent execution traces. Confirms the multi-agent system is entirely client-side and observable.

---

## Shape-B compatibility verdict

| Contract | Status | Notes |
|---|---|---|
| C1 one-shot | ✅ | `--print` |
| C2 prompt | ✅ | `-p`/`--prompt` |
| C3 envelope | ✅ | `--output-format [text\|stream-json]` |
| C4 model | ✅ | `--model`/`-m` |
| C5 exit codes | ✅ | 0/1/75 (EX_TEMPFAIL) |
| C6 no-user-config | ⚠️ | `--config` replaces but no `--no-config`; usable |
| C7 auth stderr | ⚠️ | Auth errors go to **stdout** in print mode; resume hint → stderr |
| C8 swarm off | ⚠️ | No explicit flag; `--agent-file` with excluded Agent tool is the workaround |

**Verdict: kimi 1.38.0 is Shape-B viable** with the following constraints for R-CBI-KIMI-2:
1. Auth error detection must parse stdout for `LLM not set`, not stderr  
2. Worker-only path should use `--agent-file <no-swarm-spec>` to suppress sub-agent spawning  
3. `--config` (not `--no-config`) is the user-config bypass
