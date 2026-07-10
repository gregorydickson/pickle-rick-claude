Display the Pickle Rick for Claude Code help documentation.

Summarize the available commands for the user:

**Loop Commands:**
- `/pickle-tmux <prompt>`: Start autonomous dev loop (Manager Mode) — fresh subprocess per iteration, context-clearing. Requires `tmux`
- `/pickle-zellij <prompt>`: Context-clearing Zellij mode — fresh subprocess per iteration via KDL layouts. Same as /pickle-tmux but for Zellij users. Requires Zellij >= 0.40.0
- `/pickle-prd <prompt>`: Interactive PRD drafting, then resume with `/pickle-tmux --resume`
- `/pickle-refine-prd [path]`: Refine PRD via 3 parallel Morty analysts, decompose into atomic tickets. Resume with `/pickle-tmux --resume`
- `/pickle-debate "<question>"`: Multi-agent decision debate. Flags: `--personas r,a,i,s`, `--n <2-6>`, `--solo`, `--strict-teams`, `--no-strict-teams`, `--continue`, `--confirm-multi-round`, `--accept-stale`
- `/pickle-dot [path | inline PRD]`: Convert PRD to strongdm/attractor-compatible DOT digraph
- `/citadel --prd <path>`: Post-implementation conformance audit against PRD acceptance criteria, branch diff, and trap doors. Flags: `--diff <base..head>`, `--strict`, `--report <path>`, `--print-stubs`
- `/szechuan-sauce [target]`: Principle-driven code quality review (iterative deslopping). Flags: `--domain <name>`, `--focus "<text>"`, `--dry-run`, `--max-iterations`, `--stall-limit`
- `/anatomy-park [target]`: Deep subsystem review — trace data flows, fix bugs, catalog trap doors. Flags: `--dry-run`, `--max-iterations`, `--stall-limit`
- `/council-of-ricks`: Iterative Graphite stack reviewer (Council of Ricks). Reviews every branch, generates agent-executable directives. Requires `gt`, `tmux`, `CLAUDE.md`, lint with architectural rules. Flags: `--min-iterations`, `--max-iterations`, `--repo`
- `/pickle-microverse`: Microverse convergence loop — optimize a numeric metric through targeted changes. Requires `tmux` (or `--interactive`)
- `/attract [file.dot]`: Submit a `.dot` pipeline to the attractor server for execution
- `/portal-gun <source>`: Migration/transfusion — exhaustive inventory of donor codebase, scope confirmation, concrete migration PRD. `--run` enables convergence loop (execute → coverage scan → delta PRD → re-execute until 100%). Flags: `--run`, `--target <path>`, `--depth <shallow|deep>`, `--no-refine`, `--save-pattern <name>`, `--max-passes <N>`, `--no-converge`
- `/project-mayhem`: Chaos engineering — mutation testing, dependency downgrades, config corruption
- `/eat-pickle`: Stop/cancel current loop
- `/help-pickle`: This message
- `/disable-pickle`: Disable stop hook globally
- `/enable-pickle`: Re-enable stop hook

**Session:** `/pickle-status` (show status) | `/pickle-retry <ticket-id>` (retry failed ticket) | `/pickle-standup` (activity summary)

**Jar (batch queue):** `/add-to-pickle-jar` (queue PRD) | `/pickle-jar-open` (run all queued)

**Internal:** `/send-to-morty` — auto-sent to worker subprocesses, not for direct use

**Flags for /pickle-tmux:** `--resume [PATH]` | `--max-iterations <N>` (default:500) | `--max-time <M>` (default:off; opt-in) | `--worker-timeout <S>` (default: tier-derived; medium=3600) | `--completion-promise "TEXT"` | `--backend <claude|codex|hermes|deepseek|grok|kimi|gemini>` | `--teams` (claude-only; spawns workers via harness Agent teams instead of subprocesses) | `--max-parallel <N>` (default:5; requires `--teams`; v1 ships sequential, this flag is plumbed for the parallel-fan-out follow-up)

**Backends:**
- `--backend <claude|codex|hermes|deepseek|grok|kimi|gemini>` accepted by `/pickle-tmux`, `/pickle-microverse`, `/anatomy-park`, `/szechuan-sauce`
- `/council-of-ricks` integrates codex differently: Phase C adversarial subagent runs by default; `--no-codex` disables, `--codex-timeout <sec>` tunes (default 600)
- `PICKLE_BACKEND=codex` or `PICKLE_BACKEND=hermes` env var — session-independent alternative, persists across commands
- Precedence: CLI flag > env var > session state > default `claude`
- Use codex/hermes when: user explicitly prefers that backend, wants a second opinion on implementation, or benchmarking backends
