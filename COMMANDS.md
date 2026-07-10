# Command Reference

All Pickle Rick slash commands and their flags. For workflow narrative and tool deep dives, see the [README](README.md).

## Commands

| Command | Description |
|---|---|
| `/pickle "task"` † | Start the full autonomous loop — PRD → breakdown → 8-phase execution |
| `/pickle prd.md` † | Pick up an existing PRD, skip drafting |
| `/pickle-tmux "task"` † | Same loop with context clearing via tmux. Best for long epics (8+ iterations) |
| `/pickle-zellij "task"` | Same loop in Zellij with KDL layouts. Requires Zellij >= 0.40.0 |
| `/pickle-refine-prd [path]` | Refine PRD with 3 parallel analysts → decompose into tickets |
| `/pickle-refine-prd --run [path]` | Refine + decompose + auto-launch unlimited tmux session |
| `/pickle-microverse` † | Metric convergence loop. `--metric` for numeric, `--goal` for LLM judge |
| `/szechuan-sauce [target]` † | Principle-driven deslopping. `--dry-run`, `--focus`, `--domain` |
| `/anatomy-park` † | Three-phase deep subsystem review with trap door cataloging |
| `/citadel --prd <path>` | Post-implementation conformance audit against PRD acceptance criteria, branch diff, and trap doors |
| `/pickle-pipeline "task"` † | Full lifecycle: pickle-tmux → citadel → anatomy-park → szechuan-sauce in one tmux session |
| `/cronenberg "task"` | Meta-router — deterministic decision matrix picks the right metaphor + cleanup chain, and decides whether to run `/pickle-refine-prd` first based on PRD shape signals. Executes by default; `--dry-run` to preview only. Forwards all non-cronenberg flags through |
| `/plumbus <file.dot>` | Iterative DAG shaping on a single `.dot` file. `--dry-run`, `--focus`, `--no-validator` |
| `/council-of-ricks` | Graphite PR stack review — szechuan principles + anatomy data-flow tracing + Codex adversarial challenge. Directives only, never fixes code. `--no-codex` to disable |
| `/portal-gun <source>` | Gene transfusion from another codebase |
| `/pickle-dot [path]` | Convert PRD → attractor-compatible DOT digraph |
| `/attract [file.dot]` | Submit pipeline to attractor server |
| `/pickle-prd` | Draft a PRD standalone (no execution) |
| `/pickle-metrics` | Token usage, commits, LOC. `--days N`, `--weekly`, `--json` |
| `/pickle-standup` | Linear-keyed standup: cross-references activity logs with Linear MCP, drops internal churn |
| `/pickle-status` | Current session phase, iteration, ticket status |
| `/eat-pickle` | Cancel the active loop |
| `/pickle-retry <ticket-id>` | Re-attempt a failed ticket |
| `/add-to-pickle-jar` | Queue session for Night Shift |
| `/pickle-jar-open` | Run all Jar tasks sequentially |
| `/disable-pickle` | Disable the stop hook globally |
| `/enable-pickle` | Re-enable the stop hook |
| `/help-pickle` | Show all commands and flags |
| `/meeseeks` | **Deprecated** — superseded by `/anatomy-park` and `/szechuan-sauce` |
| `lock-scope.js <session-root> --mode branch` | Mid-flight scope recovery for `/pickle-pipeline` sessions that launched without `--scope`. Patches `pipeline.json`, `state.json`, and `pipeline-status.json` in one command. Refuses to run while `pipeline-runner.js` is alive. See `PRD_GUIDE.md § Pipeline Scope` for full usage. |

† accepts `--backend <claude\|codex>` to swap the worker/manager spawn backend (or set `PICKLE_BACKEND=codex`). `/council-of-ricks` has a separate Codex integration (Phase C adversarial reviewer, `--no-codex` / `--codex-timeout`). `/pickle` additionally accepts `--teams` (claude only) to spawn workers via harness team primitives — see [Agent Teams](README.md#agent-teams).

## Flags

Most flags are command-scoped. The table groups them by command family — flags with no command prefix apply across `/pickle`, `/pickle-tmux`, `/pickle-zellij`, `/pickle-jar-open`, and `/pickle-pipeline` unless noted.

| Flag | Command | Description |
|---|---|---|
| `--max-iterations <N>` | General | Stop after N iterations (default: 500; 0 = unlimited) |
| `--max-time <M>` | General | Stop after M minutes (default: 720 / 12 hours; 0 = unlimited) |
| `--worker-timeout <S>` | General | Timeout for individual workers in seconds (default: 1200) |
| `--completion-promise "TXT"` | General | Only stop when the agent outputs `<promise>TXT</promise>` |
| `--resume [PATH]` | General | Resume from an existing session |
| `--reset` | General | Reset iteration counter and start time (use with `--resume`) |
| `--paused` | General | Start in paused mode (PRD only) |
| `--backend <claude\|codex>` | `/pickle`, `/pickle-tmux`, `/pickle-microverse`, `/anatomy-park`, `/szechuan-sauce`, `/pickle-pipeline` | Route worker/manager spawns through `codex exec` instead of `claude`. Persisted in `state.json`. Env var alternative: `PICKLE_BACKEND=codex`. Precedence: CLI flag > env var > session state > default `claude` |
| `--teams` | `/pickle` | Phase 3 spawns workers via harness team primitives (`TeamCreate` + `Agent` + `TaskUpdate`) instead of `spawn-morty.js` subprocesses. Persisted in `state.json`. Claude backend only — incompatible with `--backend codex`. Spec: [`prds/archive/design-notes/pickle-agent-teams.md`](prds/archive/design-notes/pickle-agent-teams.md) |
| `--max-parallel <N>` | `/pickle` (with `--teams`) | Concurrency cap for parallel `morty-implementer` teammates (default: 5). v1 ships sequential; this is plumbed for the parallel-fan-out follow-up. Requires `--teams`. Must be a positive integer |
| `--run` | `/pickle-refine-prd`, `/portal-gun` | Auto-launch tmux |
| `--interactive` | `/pickle-microverse` | Run inline instead of tmux |
| `--metric "<CMD>"` | `/pickle-microverse` | Shell command outputting a numeric score |
| `--goal "<TEXT>"` | `/pickle-microverse` | Natural language goal for LLM judge |
| `--direction <higher\|lower>` | `/pickle-microverse` | Optimization direction (default: higher) |
| `--judge-model <MODEL>` | `/pickle-microverse` | Judge model for LLM scoring |
| `--tolerance <N>` | `/pickle-microverse` | Score delta for "held" status (default: 0) |
| `--stall-limit <N>` | `/pickle-microverse` | Non-improving iterations before convergence (default: 5) |
| `--legacy` | `/pickle-dot` | Prompt-only fallback — skips builder codegen for this run |
| `--provider <name>` | `/pickle-dot` | LLM provider: anthropic, openai, qwen, gemini, deepseek, ollama, vllm |
| `--review-provider <name>` | `/pickle-dot` | Separate provider for review/critical nodes |
| `--isolated` | `/pickle-dot` | Isolated workspace mode |
| `--target <PATH>` | `/portal-gun` | Target repo (default: cwd) |
| `--depth <shallow\|deep>` | `/portal-gun` | Extraction depth (default: deep) |
| `--no-refine` | `/portal-gun` | Skip automatic refinement |
| `--max-passes <N>` | `/portal-gun` | Max convergence passes (default: 3) |
| `--save-pattern <NAME>` | `/portal-gun` | Persist pattern to library |
| `--target <PATH>` | `/pickle-pipeline` | Target directory for review phases (default: cwd) |
| `--refine` | `/pickle-pipeline` | Force `/pickle-refine-prd` before pipeline (auto-inferred if request mentions refinement) |
| `--no-refine` | `/pickle-pipeline` | Suppress auto-inferred refinement |
| `--skip-anatomy` | `/pickle-pipeline` | Skip anatomy-park phase |
| `--skip-szechuan` | `/pickle-pipeline` | Skip szechuan-sauce phase |
| `--anatomy-max-iterations <N>` | `/pickle-pipeline` | Anatomy Park iteration limit (default: 100) |
| `--anatomy-stall-limit <N>` | `/pickle-pipeline` | Anatomy Park stall limit (default: 3) |
| `--szechuan-max-iterations <N>` | `/pickle-pipeline` | Szechuan Sauce iteration limit (default: 50) |
| `--szechuan-stall-limit <N>` | `/pickle-pipeline` | Szechuan Sauce stall limit (default: 5) |
| `--szechuan-domain <name>` | `/pickle-pipeline` | Domain-specific principles for Szechuan phase |
| `--szechuan-focus "<text>"` | `/pickle-pipeline` | Focus directive for Szechuan phase |
| `--scope <flag>` | `/pickle-pipeline` | Scope all review phases to a subset of files. Values: `branch`, `branch:one-hop`, `diff:<ref>`, `paths:<glob,...>`. Naming a branch in the kickoff prompt triggers auto-inference — the skill will ask. |
| `--scope-base <ref>` | `/pickle-pipeline` | Base ref for `branch` scope diff (default: upstream or `main`) |
| `--prd <path>` | `/citadel` | PRD to audit against. Required unless pipeline session state provides `state.prd_path` |
| `--diff <base..head>` | `/citadel` | Diff range to audit. Defaults to `state.start_commit..HEAD` when available |
| `--strict` | `/citadel` | Exit non-zero on High findings as well as Critical findings |
| `--report <path>` | `/citadel` | JSON report destination. Pipeline invocations write `<session>/citadel_report.json` |
| `--print-stubs` | `/citadel` | Print `node:test` skeletons for unguarded trap doors without modifying files |
| `--dry-run` | `/szechuan-sauce`, `/plumbus` | Catalog violations without fixing |
| `--focus "<text>"` | `/szechuan-sauce`, `/plumbus` | Direct review toward specific concern |
| `--domain <name>` | `/szechuan-sauce` | Domain-specific principles (e.g., financial) |
| `--no-validator` | `/plumbus` | Disable attractor validator gate (pattern-only review) |
| `--repo <PATH>` | `/council-of-ricks` | Target repo (default: cwd) |
| `--min-iterations <N>` | `/council-of-ricks` | Minimum review rounds before convergence (overrides size-tier scaling) |
| `--max-iterations <N>` | `/council-of-ricks` | Maximum review rounds before forced stop (overrides scaled headroom) |
| `--effort <low\|medium\|high>` | `/pickle`, `/pickle-tmux`, `/pickle-microverse`, `/szechuan-sauce`, `/anatomy-park` | Codex reasoning effort (`-c reasoning.effort=<level>`); claude no-op |
| `--no-codex` | `/council-of-ricks` | Disable the Codex adversarial reviewer |
| `--codex-timeout <S>` | `/council-of-ricks` | Timeout for Codex adversarial reviewer (seconds) |
| `--no-publish` | `/council-of-ricks` | Skip auto-publishing PR comments at session end |
| `--dry-run` | `/cronenberg` | Print the chosen plan and stop (default: execute) |
| `--no-followups` | `/cronenberg` | Skip the cleanup chain regardless of signals |
| `--no-refine` | `/cronenberg` | Force-skip the refinement pre-pass even when signals say it should run |
| `--refine` | `/cronenberg` | Force-include the refinement pre-pass even when signals would skip it |
