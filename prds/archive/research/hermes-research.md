# Hermes Headless Invocation — Research Findings

| Hermes Headless Invocation Research | | Empirical answers to the 30 research questions in `hermes-integration.md` §Research Questions |
|:---|:---|:---|
| **Author**: Gregory Dickson | **Status**: Complete **Captured**: 2026-05-01 | **Subject**: Hermes Agent v0.12.0 (2026.4.30) |

All observations below are from empirical probing of **Hermes Agent v0.12.0 (2026.4.30)**.

## Process Lifecycle (Q1–Q5)

### Q1 — Deterministic exit?
**Yes.** `hermes chat -q "..." -Q` exits cleanly with code 0 when the response completes. No idle hang; no spinner activity after the final token is flushed.

### Q2 — Session timeout wall?
**No wall-clock wall in headless `-q` mode.** Backend-side timeout is inactivity-based, not wall-clock. As of v0.8.0 (per release notes), long-running active tasks are never killed; only truly idle agents time out. Headless `-q` mode does not seem to hit a limit before the LLM response finishes.

**Implication**: hermes will NOT trigger the codex-manager-relaunch class of recovery. FR-11's backend-aware branch for hermes is a no-op early-return.

### Q3 — Exit codes per failure class?
| Scenario | Exit |
|---|---|
| Success (assistant response) | 0 |
| Agent init / credential failure | 1 |
| Model API invalid (HTTP 400/404) | **0 (WARNING)** |
| Bad provider name | **0** |
| Unknown toolset | **0** (prints warning, continues) |
| `--ignore-user-config` with no key in env | 1 |

⚠️ **Critical**: Hermes currently returns **0 even for non-retryable API errors** because `result.get("failed")` is not set by the retry/fallback path in `cli.py:12018`. The Pickle wrapper MUST grep stderr/on-screen error markers if it needs failure detection for model-side errors. This is a NEW risk class not present in codex.

### Q4 — SIGTERM / SIGINT?
Source inspection (`cli.py:11597`) shows a signal handler for SIGHUP/SIGTERM that calls `agent.interrupt()`, which propagates to kill subprocess groups via `os.killpg`. Atexit cleanup is also registered. **Hypothesis: Hermes does NOT leak child processes.** (Empirical confirmation under load is a follow-up.)

### Q5 — `-Q` under non-TTY?
**Yes**, suppresses banner reliably. `-Q` unconditionally disables banner, spinner, and tool previews. When piped, no spinner characters pollute stdout.

## Output Format (Q6–Q10)

### Q6 — stdout vs stderr split?
- **stdout**: assistant content only (no session metadata)
- **stderr**: `session_id: <id>` plus any error/warning output

Third-party integrations are expected to split the streams.

### Q7 — Output shape?
**Plain text** (final assistant content). NOT JSON-stream. NOT token-by-token SSE. The full response is printed once at the end.

### Q8 — Tool-result interleaving in `-Q`?
**Not interleaved** in `-Q` headless mode. Only the final assistant response text is emitted on stdout.

### Q9 — ANSI escapes when piped?
The styled Hermes box (borders, emoji, color) is **suppressed in `-Q` mode**. However, WARNING/ERROR output to **stderr still contains ANSI** (`\r\n`, bold markers via Rich). Recommend piping stderr through `sed 's/\x1b\[[0-9;]*m//g'` if parsing.

### Q10 — Structured markers in stdout?
**None observed.** No `[tool:...]` tags survive into stdout in `-Q` mode. Pickle's `<promise>TASK_COMPLETED</promise>` regex will not collide.

## CLI Flags (Q11–Q17)

### Q11 — `--version` format?
Output: `Hermes Agent v0.12.0 (2026.4.30)`. Smoke-check regex: `v(\d+\.\d+\.\d+)`.

### Q12 — Full toolset allowlist (v0.12.0)?
`browser`, `browser-cdp`, `clarify`, `code_execution`, `cronjob`, `delegation`, `discord`, `discord_admin`, `file`, `hermes-yuanbao`, `homeassistant`, `image_gen`, `kanban`, `messaging`, `memory`, `mcp`, `nano-pdf`, `obsidian`, `openhue`, `polymarket`, `process`, `search`, `session_search`, `skill_manage`, `skills`, `spotify`, `terminal`, `text_to_speech`, `todo`, `tts`, `vision`, `web`, `xitter`, `xurl`, `yuanbao`. Plus `rl`, `moa`, `rlm`, `rla` (off by default). No harm in listing unknown ones — Hermes prints a warning and skips them.

### Q13 — `--provider` accepts?
**Closed + open set.** Built-ins are enumerated. Users can define custom providers in the `providers:` section of `config.yaml`. Unknown providers print a message and exit 0.

### Q14 — `-m` semantics?
`-m` is parsed as the model string passed to the provider's API call. Hermes does NOT validate cross-compatibility at CLI time. Example: `-m gpt-5-pro --provider anthropic` → HTTP 404 from Anthropic, exit 0.

### Q15 — `--readonly` / sandbox flag?
**None.** Not in help, not in source. To approximate, restrict toolsets — for a judge-only variant, omit `terminal`, `file` (write side), `write_file`, `patch`, `code_execution`. Read-only retrieval toolsets (e.g. `search`, `web`) remain safe.

### Q16 — `--max-turns`?
**Yes.** `hermes chat -q ... --max-turns N`. Default: 90. Maps to `max_iterations` in the agent constructor. Pickle should pass this from `state.max_iterations` (or a worker-specific cap) to bound runaway loops.

### Q17 — `-w` vs `-q` shared state?
`-w` creates an isolated git worktree for filesystem isolation. Both write to the same SQLite session DB (`~/.hermes/sessions/sessions.db`). Session history files are NOT shared across sessions because each session gets a unique `session_id`.

## Configuration & Environment (Q18–Q20)

### Q18 — Precedence?
CLI flags > env vars > `~/.hermes/config.yaml` > built-in defaults.

Secrets in `~/.hermes/.env` are always loaded. `--ignore-user-config` skips the user `config.yaml` entirely.

### Q19 — Isolation flags equivalent to codex `v1.59.1`?
**`--ignore-user-config`** AND **`--ignore-rules`** both exist. The latter skips `AGENTS.md`, `SOUL.md`, `.cursorrules`, memory injection, and preloaded skills. Exactly what's needed for isolated CI / judge mode.

Skills stored under `~/.hermes/skills/` can still be loaded if the code explicitly does `hermes -s skillname`. Use `--ignore-rules` to prevent that. **This defends against the v1.59.1 `~/.hermes/skills/pickle*` literal-bleed class.**

### Q20 — Env vars read?
Provider-specific: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, etc. Plus runtime knobs: `HERMES_INTERACTIVE`, `HERMES_MAX_ITERATIONS`, `HERMES_QUIET`, `HERMES_REDACT_SECRETS`. **No single `HERMES_API_KEY`** — the key var is provider-specific. `OPENAI_API_KEY` pass-through works for the OpenAI provider.

## Concurrency & Sandbox (Q21–Q23)

### Q21 — Concurrent processes?
Empirical: multiple `hermes chat -q` processes run concurrently without crash. The SQLite session DB uses `threading.Lock()` around writes. **However**, WAL mode + SQLite read/write patterns means heavy concurrent writers could hit `database is locked` under high contention.

**Implication**: jar-batch concurrency on hermes should stay modest (≤4 concurrent workers as a starting cap).

### Q22 — `cwd` respect?
**Hermes does respect the parent `cwd`.** The prompt in the banner shows the current working directory from which hermes was spawned. No auto-`chdir` to project root.

### Q23 — Subprocess visibility for `terminal`?
`-t terminal` spawns in a **hidden shell subprocess**, not in the user's visible tmux pane. The `terminal()` tool opens its own PTY when needed. Operators won't see hermes' shell output in the runner pane the way they do for codex's own output.

## Failure Modes (Q24–Q27)

### Q24 — Unknown toolset?
**Warning to stderr, exit 0**, continues with valid toolsets.

### Q25 — Missing API key?
- With `--ignore-user-config` AND no env var → exits 1.
- With user config (no `--ignore`), falls back to whatever hermes' model resolves; **the failure becomes a runtime API error (exit 0, mid-stream)**.

**Implication**: smoke-check should use `--ignore-user-config` + verify the relevant key env var is set BEFORE first invocation, to fail fast.

### Q26 — Rate-limiting?
Hermes retries internally with exponential backoff (3 attempts shown in logs). Falls back to a `fallback_model` if configured, or returns an error message in the assistant response text. No marker in stdout.

### Q27 — Stdin EOF?
Closing stdin → Hermes exits cleanly (no hang). `-q` mode reads the query from the CLI argument, not stdin, so this is a non-issue.

## Comparison vs Codex (Q28–Q30)

### Q28 — `MANAGER_FALSE_EPIC_COMPLETED` equivalent?
**No equivalent documented.** Hermes exposes `failed` in the result dict via `cli.py:12018`, but model-side hallucination of completion is not trapped. Pickle must continue parsing the response text for the `EPIC_COMPLETED` / `TASK_COMPLETED` pattern.

`evaluateEpicCompletion()` (shipped in v1.56.4) stays backend-agnostic — no hermes-specific work needed there.

### Q29 — Prompt literalism trap?
**No "ONLY" trap.** Hermes is a general tool-calling agent, not hardcoded to a coding-loop prompt. The underlying model still follows literal rules though, so standard prompt hygiene applies. `send-to-morty.md` rule rewrites do NOT need hermes-specific copies.

### Q30 — Commit attribution?
Hermes has **no built-in `git commit`**. The pipeline must issue `git commit` via the `terminal` tool. **No `[hermes]` prefix is added automatically.** Attribution must be done via timing or by injecting a prefix in the prompt (e.g. "commit with message `[hermes] ...`").

**Implication**: `metrics.js` attribution by-author-prefix needs an explicit prompt injection in the hermes worker prompt, OR fall back to timing-based attribution.

## Net Impact on the PRD (summary)

| FR / Risk / NFR | Adjustment based on findings |
|---|---|
| FR-3 | `args` shape unchanged; ADD optional `--max-turns N` derived from session iteration budget; ADD `--ignore-rules` + `--ignore-user-config` for isolation. |
| FR-6 (smoke check) | Use `--version` regex `v(\d+\.\d+\.\d+)`; add API-key pre-flight when `--provider` is set; reject when key env var is unset. |
| FR-7 | Add `--hermes-max-turns` CLI flag (optional; defaults to `state.max_iterations`). |
| FR-10 | Confirm mode-3 plain-text path; ANSI strip applies to stderr only (stdout is clean in `-Q`). Add stderr scan for failure markers (Hermes returns exit 0 on API errors). |
| FR-11 | Rename helper as planned, but hermes branch early-returns `{ should_relaunch: false, reason: 'hermes_no_timeout' }`. No relaunch path is exercised. |
| Judge variant (FR-3, OQ-2) | No `--readonly` flag — restrict toolsets to read-only retrieval (`search`, `web`) and omit `terminal,file,write_file,patch,code_execution`. Add `--ignore-rules --ignore-user-config`. |
| New Risk R9 | Hermes returns exit 0 on non-retryable API errors. Mitigation: stderr scan for `WARNING`/`ERROR` markers AND model-name validation pre-flight. |
| New Risk R10 | SQLite session DB contention under concurrent jar-batch. Mitigation: cap hermes-backend jar-batch concurrency at 4 (NFR-3 extension). |
| NFR-3 | Add: hermes-backend tasks limited to ≤4 concurrent workers in jar-runner until per-task SQLite contention is empirically benchmarked. |
| Open Question 1 | RESOLVED: hermes has no relaunch trigger; FR-11 hermes branch is a no-op. |
| Open Question 2 | RESOLVED: no `--readonly` flag; judge variant uses toolset restriction + `--ignore-rules --ignore-user-config`. |
| Open Question 3 | UNCHANGED: schema stays v3 with `manager_relaunch_count` as canonical name; `codex_manager_relaunch_count` accepted as alias for one minor cycle. |
| Open Question 4 | UNCHANGED: emit `manager_relaunch` with `gate_payload.backend`; deprecate `codex_manager_relaunch` for one minor cycle. |
