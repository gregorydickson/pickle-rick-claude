<p align="center">
  <img src="images/architecture.png" alt="Pickle Rick Architecture" width="100%" />
</p>

# Pickle Rick Internals

Deep-dive architecture, configuration, and runtime details for the Pickle Rick engineering lifecycle. For usage, commands, and quick start, see the [README](README.md).

---

## 🧬 The Pickle Rick Lifecycle

Each ticket goes through 8 phases in the autonomous loop: PRD → Breakdown → per-ticket (Research → Research-Review → Plan → Plan-Review → Implement → Verify → Code-Review → Simplify).

```
  ┌─────────────┐
  │  📋 PRD     │  ← Requirements + verification strategy + interface contracts
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │ 📦 Breakdown│  ← Atomize into tickets, each self-contained with spec
  └──────┬──────┘
         │
    ┌────┴────┐  per ticket (Morty workers 👶)
    ▼         ▼
  ┌──────┐  ┌──────┐
  │🔬 Re-│  │🔬 Re-│  1. Research the codebase
  │search│  │search│
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │📝 Re-│  │📝 Re-│  2. Review the research
  │view  │  │view  │
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │📐Plan│  │📐Plan│  3. Architect the solution
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │📝 Re-│  │📝 Re-│  4. Review the plan
  │view  │  │view  │
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │⚡ Im-│  │⚡ Im-│  5. Implement
  │plem  │  │plem  │
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │✅ Ve-│  │✅ Ve-│  6. Spec conformance
  │rify  │  │rify  │
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │🔍 Re-│  │🔍 Re-│  7. Code review
  │view  │  │view  │
  └──┬───┘  └──┬───┘
     ▼         ▼
  ┌──────┐  ┌──────┐
  │🧹Sim-│  │🧹Sim-│  8. Simplify
  │plify │  │plify │
  └──────┘  └──────┘
```

The **Stop hook** prevents Claude from exiting until the task is genuinely complete. Between each iteration, the hook injects a fresh session summary — current phase, ticket list, active task — so Rick always wakes up knowing exactly where he is, even after full context compression.

All modes support both tmux and Zellij monitor layouts.

See the **Manager / Worker Model** and **The Stop Hook Loop** sections below for the mechanical details of how this lifecycle runs.

---

## Circuit Breaker — Runaway Session Protection

> *"You know what's worse than a bug, Morty? An infinite loop that keeps making the same bug. Over and over. Burning tokens like Jerry burns goodwill."*

Long-running autonomous sessions can get stuck — same error repeating, no git progress, the model spinning its wheels. The circuit breaker detects these failure modes and stops the session before it wastes hours.

### How It Works

The circuit breaker is a three-state machine integrated into `mux-runner.ts`. After every iteration, it checks two signals:

**Progress detection** — Runs `git diff --stat` (staged + unstaged) and `git rev-parse HEAD` against the last known state. Also tracks lifecycle transitions (step changes, ticket changes). If any of these changed, the iteration made progress. First-iteration warm-up always counts as progress (no baseline to compare).

**Error signature extraction** — Parses the iteration's NDJSON output for `result.subtype` starting with `"error"`. If found, extracts the last assistant text block and normalizes it: paths → `<PATH>`, line:column → `<N>:<N>`, timestamps → `<TS>`, UUIDs → `<UUID>`, whitespace collapsed, truncated to 200 chars. Exit codes are preserved (they're diagnostic). Two iterations hitting the same normalized signature count as the same error.

### State Transitions

```
                     progress detected
            ┌────────────────────────────────┐
            │                                │
            ▼                                │
        ┌────────┐  no progress ≥ 2  ┌───────────┐  no progress ≥ 5  ┌────────┐
        │ CLOSED │ ──────────────►  │ HALF_OPEN │ ──────────────►  │  OPEN  │
        │(normal)│                   │ (warning) │                   │ (stop) │
        └────────┘                   └───────────┘                   └────────┘
            ▲                                │                           │
            │         progress detected      │                           │
            └────────────────────────────────┘                           │
                                                                         ▼
                                                              Session terminated
                                                              reason logged
```

- **CLOSED** (normal): Every iteration with progress resets the counter.
- **HALF_OPEN** (warning): After `default_cb_half_open_after` (default: 2) consecutive no-progress iterations. Monitor shows `[CB: HALF_OPEN]`. One more progress iteration → back to CLOSED.
- **OPEN** (stop): After `default_cb_no_progress_threshold` (default: 5) consecutive no-progress iterations, OR `default_cb_same_error_threshold` (default: 5) consecutive identical error signatures. Session terminates with a diagnostic message.

### Manual Recovery

If the circuit breaker trips and you want to continue:

```bash
# Reset the circuit breaker and resume
node ~/.claude/pickle-rick/extension/bin/circuit-reset.js <session-path>
# Then resume normally
/pickle-tmux --resume
```

### Monitor Display

The tmux monitor shows circuit breaker state in the header: `[CB: CLOSED]`, `[CB: HALF_OPEN (2/5)]`, or `[CB: OPEN — stopped]`. HALF_OPEN includes the no-progress count vs threshold.

### Disabling

Set `default_circuit_breaker_enabled: false` in `pickle_settings.json` to disable globally. Or pass `--no-circuit-breaker` to `/pickle-tmux`.

---

## Rate Limit Auto-Recovery

> *"Oh, you thought we'd just... stop? Because some API said 'too many requests'? Morty, I once escaped a galactic prison using a AAA battery and spite."*

When Claude Code hits an API rate limit during a tmux/Zellij session, the runner detects it, computes the optimal wait duration, pauses, and resumes automatically.

### How It Works

The mux-runner classifies every iteration's exit into one of: `completed_normally`, `completed_with_error`, `rate_limited`, `timed_out`, `unknown`. Rate limit detection uses two signals:

1. **Exit code 2** from `claude -p` (Claude Code's rate limit exit)
2. **Structured event**: NDJSON line with `type: "system"` and `subtype: "rate_limit_event"` containing `rate_limit_type` (e.g., `"five_hour"`, `"daily"`) and `resets_at_epoch` (Unix timestamp)

### Wait-and-Resume Cycle

```
Iteration exits with rate limit
         │
         ▼
Parse NDJSON for rate_limit_event
         │
    ┌────┴─────┐
    │ Found?   │
    └────┬─────┘
    Yes  │        No
    │    │        │
    ▼    │        ▼
Compute wait from          Use static config default
resetsAt epoch + 30s       (default_rate_limit_wait_minutes)
buffer, cap at 3×
config default
    │                      │
    └──────────┬───────────┘
               ▼
Write rate_limit_wait.json
  { waiting, wait_until, consecutive_waits,
    rate_limit_type, resets_at_epoch, wait_source }
               │
               ▼
┌─────────────────────────────────────────┐
│  Sleep loop (checks every 30s):        │
│  • Check if wait_until has passed       │
│  • Check state.json active flag         │
│  • Check session time limit             │
│  • /eat-pickle sets active=false → exit │
└──────────────┬──────────────────────────┘
               │ timer expires
               ▼
Delete rate_limit_wait.json
Write handoff.txt (resume instructions)
Continue loop → next iteration
```

**Consecutive limit**: After `default_max_rate_limit_retries` (default: 3) consecutive rate limits without a successful iteration between them, the runner exits with `rate_limit_exhausted`. A successful iteration resets the counter.

**Time-limit aware**: If the computed wait would exceed the session's `max_time_minutes`, the wait is clamped to the remaining time (or the session exits immediately if time is already up).

**Smart backoff**: When a structured `rate_limit_event` is available, the runner uses the API's `resetsAt` epoch to compute the exact wait duration (+ 30s buffer). This avoids both under-waiting (resuming before the window opens) and over-waiting (sitting idle for 60 minutes when the limit resets in 12). The API wait is capped at 3× `default_rate_limit_wait_minutes` to prevent `seven_day` limits from hanging a session for days — if the reset is too far out, the static config default is used instead.

### Monitor Display

When the runner is in a rate limit wait, the tmux monitor shows a countdown timer with minutes:seconds remaining until resume. It also displays the rate limit type (e.g., `[five_hour]`) and source indicator (`(API reset)` when using the structured reset time vs config default). The `rate_limit_wait.json` file contains `wait_until` as an ISO timestamp, plus `rate_limit_type`, `resets_at_epoch`, and `wait_source` (`"api"` or `"config"`).

### Settings

| Setting | Default | Description |
|---|---|---|
| `default_rate_limit_wait_minutes` | 5 | Fallback wait duration when no API reset time is available. Also used as the base for the 3× cap on API-derived waits |
| `default_max_rate_limit_retries` | 3 | Consecutive rate limits before giving up |

---

## Metrics Internals

`/pickle-metrics` aggregates Claude Code usage across all your projects — token consumption, turn counts, commits, and lines of code changed — into a daily or weekly breakdown.

### What It Reports

- **Turns**: Total Claude API round-trips per day/week
- **Input / Output tokens**: Token consumption from Claude Code's session JSONL files (`~/.claude/projects/`)
- **Commits**: Git commit count per repo per day (via `git log`)
- **Lines +/-**: Lines added and removed across all tracked repos
- **Per-project breakdown**: Each project's contribution to the totals
- **Weekly trends**: Week-over-week output delta and top project per week

Data sources: session JSONL files in `~/.claude/projects/` for tokens, `git log --numstat` across repos under `~/loanlight/` (configurable via `METRICS_REPO_ROOT`) for LOC. Results are cached to `metrics-cache.json` to avoid re-parsing unchanged session files.

---

## Portal Gun Internals

### How It Works

1. **Open Portal** — Fetches the donor code (GitHub API, local copy, npm registry, or synthesizes from description). Saves to `portal/donor/`
2. **Pattern Extraction** — Analyzes the donor: structural pattern, invariants, edge cases, anti-patterns → `pattern_analysis.md`
3. **Target Analysis** — Studies your codebase: conventions, integration points, conflicts, adaptation requirements → `target_analysis.md`
4. **PRD Synthesis** — Generates a transplant PRD with a Behavioral Validation Tests table mapping donor behavior to expected target behavior, with donor file references for Morty workers
5. **Refinement Cycle** — Three parallel analysts (Requirements, Codebase Context, Risk & Scope) validate the transplant PRD against donor invariants and target constraints. Portal artifacts give them extra context a normal refinement wouldn't have
6. **Pattern Library** — Saves extracted patterns to `~/.claude/pickle-rick/patterns/` for reuse in future portal-gun sessions. Use `--save-pattern <name>` to persist, or patterns stay in the session directory
7. **Handoff** — Resume with `/pickle --resume`, `/pickle-tmux --resume`, or use `--run` to auto-launch

### Flags

| Flag | Effect |
|------|--------|
| `--run` | Auto-launch tmux/Zellij session after PRD is ready |
| `--meeseeks` | Chain Meeseeks review after execution (implies `--run`) |
| `--target <path>` | Target repo (default: cwd) |
| `--depth shallow\|deep` | `shallow` = summary, structural pattern, and invariants only; `deep` = full analysis (default) |
| `--no-refine` | Skip the automatic refinement cycle |
| `--save-pattern <name>` | Persist extracted pattern to global library for future reuse |
| `--cycles <N>` | Number of refinement cycles (default: 3) |
| `--max-turns <N>` | Max turns per refinement worker (default: 100) |

---

## Project Mayhem Internals

Every module follows the same **Chaos Cycle**: read original → apply one mutation → run tests → record result → `git checkout` revert → verify revert. One mutation at a time, always reverted, always verified.

**Module 1 — Mutation Testing**: Finds high-value mutation sites in your source code (conditionals, comparisons, boolean literals, guard clauses, error handlers) and applies operators like boolean flip, comparison inversion, boundary shift, operator swap, condition negation, guard removal, and empty catch. If tests still pass after a mutation (a "survivor"), that's a test coverage gap. Survivors are severity-rated: Critical (auth/security/validation), High (business logic), Medium (utilities), Low (display/logging).

**Module 2 — Dependency Armageddon**: Selects 5-10 key direct dependencies — prioritizing the most imported, foundational, and security-sensitive — and downgrades each to the previous major version one at a time. Tracks install failures, test breakages (with error messages), and backward-compatible deps. Also runs a phantom dependency check to find imports that work by accident via transitive dependencies.

**Module 3 — Config Resilience**: Discovers runtime config files (JSON, YAML, .env, INI — excluding build tooling), then applies corruption strategies: truncation (50%), empty file, missing keys, wrong types, prototype pollution payloads (`__proto__`), and invalid syntax. Tests whether the app handles each corruption gracefully or crashes.

### The Report

After all modules run, a `project_mayhem_report.md` is written to the project root with:

- **Chaos Score** (0–100): weighted average — Mutation 50%, Deps 25%, Config 25%
- **Mutation survivors table**: file:line, operator, original → mutated, severity
- **Dependency breakages**: package, version tested, error summary
- **Phantom dependencies**: imports not declared in the manifest
- **Config crashes**: file, corruption strategy, exit code, error
- **Prioritized recommendations**: what to fix first based on severity

### Safety Guarantees

- Requires clean git state — refuses to run with uncommitted changes
- Records `HEAD` SHA before starting, verifies it hasn't changed at the end
- Every individual mutation is reverted immediately via `git checkout -- <file>`
- Dependency downgrades restore the original lockfile + re-install after each test
- Final verification: `git diff` must be empty, tests must pass
- On any error: `git checkout .` + restore deps before reporting

---

## Microverse Internals

The Microverse convergence loop optimizes a numeric metric through iterative, atomic changes. It runs as a dedicated runner (`microverse-runner.ts`) that reuses the mux-runner's iteration infrastructure but adds metric measurement, automatic rollback, and convergence detection.

### State Machine

```
                    ┌──────────────┐
                    │ gap_analysis │  Initial state — first iteration
                    └──────┬───────┘  runs gap analysis, measures baseline
                           │
                           ▼
                    ┌──────────────┐
              ┌────►│  iterating   │◄────┐
              │     └──────┬───────┘     │
              │            │             │
              │     measure metric       │ score improved
              │            │             │ or held
              │     ┌──────┴──────┐      │
              │     │ regressed?  │──No──┘
              │     └──────┬──────┘
              │            │ Yes
              │     git reset --hard <pre-SHA>
              │     add to failed_approaches
              │     increment stall_counter
              │            │
              │     ┌──────┴──────┐
              │     │ converged?  │──No──┘
              │     └──────┬──────┘
              │            │ Yes
              │            ▼
              │     ┌──────────────┐
              │     │  converged   │  stall_counter ≥ stall_limit
              │     └──────────────┘
              │
              │     ┌──────────────┐
              └────►│   stopped    │  external cancel, time/iteration limit,
                    └──────────────┘  error, or rate limit exhaustion
```

### Metric Comparison

Three outcomes per iteration, controlled by the `tolerance` parameter:

| Outcome | Condition | Effect |
|---------|-----------|--------|
| **Improved** | `score > previous + tolerance` | Accept commit, reset `stall_counter` to 0 |
| **Held** | `abs(score - previous) ≤ tolerance` | Accept commit, increment `stall_counter` |
| **Regressed** | `score < previous - tolerance` | `git reset --hard` to pre-iteration SHA, add to `failed_approaches`, increment `stall_counter` |

The "previous" score is always the last **accepted** entry's score (not the last entry, which may have been reverted), falling back to `baseline_score` if no accepted entries exist yet.

### microverse.json Schema

```json
{
  "status": "iterating",
  "prd_path": "/path/to/session/prd.md",
  "key_metric": {
    "description": "increase test coverage",
    "validation": "npm test 2>&1 | tail -1",
    "type": "command",
    "timeout_seconds": 60,
    "tolerance": 0,
    "direction": "higher"
  },
  "convergence": {
    "stall_limit": 5,
    "stall_counter": 2,
    "history": [
      {
        "iteration": 1,
        "metric_value": "78.4",
        "score": 78.4,
        "action": "accept",
        "description": "improved: 78.4 vs 72.0",
        "pre_iteration_sha": "abc1234",
        "timestamp": "2026-03-10T05:00:00Z",
        "classification": "improved"
      }
    ]
  },
  "gap_analysis_path": "/path/to/session/gap_analysis.md",
  "judge_context_path": "/path/to/session/judge_context.md",
  "failed_approaches": [
    "Iteration 3: score dropped from 78.4 to 71.2"
  ],
  "baseline_score": 72.0,
  "convergence_target": 90.0,
  "convergence_mode": "metric",
  "convergence_file": null,
  "allowed_paths": ["src/**", "tests/**"],
  "exit_reason": null,
  "stash_ref": null,
  "failure_history": [],
  "approach_exhaustion_fired": false
}
```

Defined in `extension/src/types/index.ts` (`MicroverseSessionState`) and managed by `extension/src/services/microverse-state.ts`. `direction` (`"higher" | "lower"`) controls which direction counts as improvement. `failure_history` records classified failures (`tool_failure | approach_exhaustion | regression | metric_unstable | no_progress`) produced by `classifyFailure()`.

### Runner Architecture

The `microverse-runner.ts` reuses core infrastructure from `mux-runner.ts`:

- **`runIteration()`** — spawns a fresh `claude -p` subprocess per iteration with the `microverse.md` command template
- **`classifyIterationExit()`** — detects rate limits vs normal exits
- **`computeRateLimitAction()`** — computes wait-and-resume for API throttling
- **`measureMetric()`** — executes the validation command in a child shell, parses the last stdout line as a float, with configurable timeout
- **`buildMicroverseHandoff()`** — constructs the per-iteration context injection: metric description, baseline, recent history (last 5), failed approaches, gap analysis path

Each iteration's worker gets a fresh context with only the handoff summary — no conversational drift. The worker template (`microverse.md`) is a focused optimizer: read context → plan one change → implement → commit → exit. The runner handles all measurement, comparison, and rollback externally.

**Default mode is tmux** — `/pickle-microverse` launches in tmux with context clearing between iterations. Pass `--interactive` to run the convergence loop inline (useful for short runs or environments without tmux).

### Final Report

On exit, the runner writes `microverse_report_<date>.md` to the session's `memory/` directory:

- Exit reason (converged, limit_reached, stopped, error, rate_limit_exhausted)
- Total iterations, elapsed time
- Baseline score vs best score
- Accepted vs reverted count
- Full iteration history table (iteration, score, action, description)

### Session Artifacts

```
~/.local/share/pickle-rick/sessions/<date-hash>/
├── microverse.json           # Microverse state (source of truth)
├── gap_analysis.md           # Initial codebase analysis
├── prd.md                    # Optimization PRD
├── handoff.txt               # Per-iteration context (overwritten each iteration)
├── microverse-runner.log     # Runner log
├── tmux_iteration_N.log      # Per-iteration NDJSON output
├── state.json                # Standard session state
└── memory/
    └── microverse_report_*.md  # Final report
```

---

## Council of Ricks Internals

`/council-of-ricks` is an iterative Graphite-stack reviewer. It never fixes code — it generates agent-executable directives. The Council convenes in **rounds**; each round fans out every review category in parallel via the `Agent` tool. Everything below lives in `.claude/commands/council-of-ricks.md`, `extension/szechuan-sauce-principles.md`, and `extension/src/bin/council-publish.ts`.

### Severity × Confidence Scoring

Every finding carries two independent axes, reported as `[P<N>, conf=<score>]`:

- **Severity** (`extension/szechuan-sauce-principles.md`) — `P0` critical (security, data loss, auth bypass, corruption, migration hazards, injection) · `P1` high (correctness bugs, contract mismatches, silent failures, unhandled branches, schema drift) · `P2` medium (DRY 3+, god classes, deep nesting, tight coupling) · `P3` low (naming, magic numbers, minor dup) · `P4` optional (formatting, style drift).
- **Confidence** — rubric `0 / 25 / 50 / 75 / 100`. Any finding with `conf < 80` is **dropped** before the directive is written — severity and confidence are independent, so a `P0` at `conf 50` is still cut. **P0 escape hatch**: genuine security / data-loss / auth-bypass findings survive the confidence filter after explicit grep + surrounding-code + `git log` confirmation. Dropped findings are listed in a `## Dropped Candidates (conf < 80 and false-positive pre-filter)` section in `council-of-ricks-summary.md` — auditable but non-actionable.
- **False-Positives filter** — applied BEFORE scoring: pre-existing issues, tooling-caught errors, stylistic preferences, speculative future-risk, and resolved prior-round findings are excluded wholesale, not down-scored.

### Size-Tier Scaling

At stack discovery (Step 8) the Council computes total diff size across the stack via `git diff --numstat <trunk>...<tip>` and scales `min_rounds` to the surface area. Each round surfaces findings that reframe code earlier rounds walked past, so large PRs need more rounds to converge — this was observed empirically on 5k / 10k / 20k-line PR stacks.

| Stack diff LOC | OR | Files touched | Scaled min rounds | Tier label |
|---|---|---|---|---|
| < 300 | or | < 10 | 2 | `xs` |
| 300 – 1,499 | or | 10 – 29 | 3 | `s` |
| 1,500 – 4,999 | or | 30 – 79 | 4 | `m` |
| 5,000 – 9,999 | or | 80 – 149 | 5 | `l` |
| 10,000 – 19,999 | or | 150 – 299 | 6 | `xl` |
| ≥ 20,000 | or | ≥ 300 | 7 | `xxl` |

Resolution (in council-of-ricks.md Step 8):
- Take `max(LOC tier, files tier)` — either axis can flag "big enough."
- If `--min-iterations N` was passed on the CLI, `effective_min_rounds = N` (explicit override wins, no scaling applied).
- Otherwise, `effective_min_rounds = max(default_council_min_rounds, scaled_tier)`.
- `effective_max_rounds` follows the same rule, with headroom: `max(default_council_max_rounds, effective_min_rounds + 2)` — guarantees at least two rounds above the floor so a big stack can exhaust cleanly.
- `council-stack.json` records `stack_loc`, `stack_files`, `stack_tier`, `scaled_min_rounds`, `effective_min_rounds`, `effective_max_rounds`, `min_rounds_source`, `max_rounds_source`.
- If `git diff --numstat` fails (missing merge base, detached HEAD, etc.), LOC and files default to `0` and scaling falls through to `default_council_min_rounds` — the Council runs at its settings floor rather than blocking.

Step 9.5's startup report announces the tier: `stack tier: l (3,247 LOC / 47 files) → min 4 rounds, max 6 (scaled)`.

### Round Structure

Each round runs four phases. Phases B and C fan out concurrently — one `Agent` tool call batch, every subagent runs in parallel from the main agent's perspective. A round that used to take 11+ sequential passes now completes in one fan-out cycle.

**Phase A — Historical Context** (serial, main agent). Computes a per-round brief at `<SESSION_ROOT>/round-<N>/historical-brief.md` from `git log --oneline -10 -- <file>` + `gh pr list --state merged --search …` / `gh pr view --comments` + in-file `NOTE:/IMPORTANT:` banners. Brief feeds Phase B/C subagents. Fails open: `gh` absence → git-only mode; all signals absent → `skipped` (breaks clean-round classification).

**Phase B — Category Team** (parallel fan-out):

| # | Category | Mandatory? |
|---|----------|------------|
| B1 | Stack Structure | ✓ |
| B2 | CLAUDE.md Compliance | ✓ |
| B3 | Contract Discovery | ✓ |
| B4 | Cross-Branch Contracts + Combinatorial (2^N guards) | ✓ |
| B5 | Test Coverage + Production Migration Safety | ✓ |
| B6 | Security | ✓ |
| B7 | Migration Hygiene (Drizzle journal) | conditional |
| B8 | Szechuan Principles Sweep | ✓ |
| B9 | Polish + Trap Door Candidates | ✓ |

**Phase C — Branch Team** (parallel fan-out, same message as Phase B):

- **C_correctness** (one `Agent` per non-trunk branch, mandatory): Per-Branch Correctness + Data Flow (input → bug → wrong output file:line chain). Pure diff review via `gt branch info --diff --branch <b>` — no checkout, safe in parallel.
- **C_codex** (one `Agent`, conditional): Adversarial sweep. Internally sequential because shared working tree requires serial `gt branch checkout` per branch. Shells out to `~/.claude/plugins/cache/openai-codex/codex/*/codex-companion.mjs` with `--wait --base <parent> --scope branch`, captures to `<SESSION_ROOT>/codex/<slug>-round<N>.md`. Findings tagged `[CODEX]` (or `[COUNCIL+CODEX]`) in Phase D synthesis. Per-branch timeout / non-zero exit / empty output → per-branch failure recorded, sweep continues — Codex is never load-bearing.

**Phase D — Synthesis** (serial, main agent). Receives every subagent's JSON payload, applies in order: false-positive pre-filter → confidence filter (`conf < 80` dropped) → COUNCIL/CODEX dedupe on `file:line` → severity sort → trap-door consolidation → directive write + summary append.

### Approval Gate

`<promise>THE_CITADEL_APPROVES</promise>` fires only when **all four** conditions hold:

1. `current_round >= min_iterations` (the tier-resolved `effective_min_rounds` from Step 8 — see Size-Tier Scaling)
2. The last two `## Round <N>:` headers in `council-of-ricks-summary.md` both end with the exact terminal suffix `— clean round.`
3. Across those two consecutive clean rounds no **unconditional** category (Phase A Historical Context, B1, B2, B3, B4, B5, B6, B8, B9, Phase C per-branch Correctness for every non-trunk branch) was `skipped`. B7 Migration and C_codex are conditional — they may skip without demoting the round, but they also don't substitute for an unconditional category
4. Those two consecutive clean rounds produced zero P0/P1 findings across both Council and Codex sources

Every `## Round <N>:` header must end with exactly one of three terminal suffixes (enforced by the parser):
- `— clean round.`
- `— partial round (skipped: <categories>).`
- `— <count> issues (<P0>/<P1>/<P2>/<P3>/<P4>)`

Partial rounds (any unconditional skip) break the consecutive-clean streak — they are not substitutes for a clean round.

### Auto-Publish at Session End

Implemented in `extension/src/bin/council-publish.ts` → `extension/bin/council-publish.js`. Invoked from Step 17.7 of the skill, exactly once per session, on either the approval path or the max-iterations exhaustion path — **before** the terminal `<promise>` tag. Skipped entirely when `publish_enabled === false` (CLI `--no-publish` or `default_council_publish: false`).

For each non-trunk branch in `council-stack.json`:

1. Compose a comment body from `council-of-ricks-summary.md` (round outcomes), the latest directive's per-branch findings table, and the `## Trap Doors` section. Write to `<SESSION_ROOT>/council-comments/<branch-slug>.md`.
2. `gh auth status` probe — if unavailable, record `skipped_no_gh`, keep the body file as a fallback artifact, continue.
3. Idempotency marker: if `<SESSION_ROOT>/.published/<branch-slug>` exists, record `skipped_already_published`, continue.
4. Resolve PR # via `gh pr list --head <branch> --json number --jq '.[0].number'`; no PR → `skipped_no_pr`.
5. Post via `gh pr comment <N> --body-file <path>`. Success writes the idempotency marker. Per-branch failures append to `publish.log` and the sweep continues — publish never blocks the terminal promise.

Outcomes (`PublishResult.outcome`): `posted | skipped_already_published | skipped_no_pr | skipped_no_gh | failed`. The JSON report (`PublishReport`) is appended to the summary and rendered in the closing message.

### Settings Touchpoints

From `pickle_settings.json`:

- `default_council_min_rounds` — default `2` (two clean rounds gate approval)
- `default_council_max_rounds` — default `5` (exhaustion ceiling; healthy stacks converge in 2–3)
- `default_council_publish` — default `true`

CLI flags `--min-iterations <N>`, `--max-iterations <N>`, `--no-publish`, `--no-codex`, `--codex-timeout <sec>`, `--repo <path>` override.

### Session Artifacts

```
~/.local/share/pickle-rick/sessions/<date-hash>/
├── council-stack.json             # { branches, trunk, repo_path, codex_enabled }
├── council-directive.md           # Agent-executable directive (overwritten each round)
├── council-of-ricks-summary.md    # Append-only round log + dropped candidates
├── round-<N>/                     # Per-round scratch (historical brief, subagent payloads)
│   └── historical-brief.md
├── codex/                         # Per-branch Codex adversarial transcripts
│   └── <branch-slug>-round<N>.md
├── council-comments/              # Composed comment bodies (posted or fallback)
│   └── <branch-slug>.md
├── .published/                    # Idempotency markers (one per posted branch)
│   └── <branch-slug>
├── publish.log                    # NDJSON publish attempts
└── state.json
```

---


## Directory Structure

```
pickle-rick-claude/
├── .claude/
│   ├── commands/           # Slash commands (the magic words)
│   │   ├── pickle.md               # Main loop (PRD + Breakdown inlined)
│   │   ├── pickle-tmux.md          # True context clearing via tmux
│   │   ├── pickle-zellij.md        # True context clearing via Zellij
│   │   ├── pickle-pipeline.md      # Sequential phase orchestrator
│   │   ├── pickle-microverse.md    # Metric convergence loop
│   │   ├── pickle-prd.md           # Interactive PRD drafter
│   │   ├── pickle-refine-prd.md    # PRD refinement team
│   │   ├── pickle-dot.md           # PRD → attractor DOT digraph
│   │   ├── pickle-dot-patterns.md  # Pattern reference (loaded on demand)
│   │   ├── attract.md              # Submit a .dot pipeline to attractor
│   │   ├── plumbus.md              # Iterative .dot pipeline shaper
│   │   ├── portal-gun.md           # Gene transfusion — pattern transplant PRD
│   │   ├── meeseeks.md             # Autonomous code review loop
│   │   ├── meeseeks-zellij.md      # Zellij mode for Mr. Meeseeks
│   │   ├── council-of-ricks.md     # Graphite stack adversarial review
│   │   ├── szechuan-sauce.md       # Principle-driven deslopping loop
│   │   ├── anatomy-park.md         # Subsystem deep review (data flow + trap doors)
│   │   ├── project-mayhem.md       # Chaos engineering (mutation/deps/config)
│   │   ├── send-to-morty.md        # Worker prompt (internal)
│   │   ├── send-to-morty-review.md # Review worker prompt (internal)
│   │   ├── pickle-status.md        # Show session status
│   │   ├── pickle-standup.md       # Formatted standup from activity JSONL
│   │   ├── pickle-metrics.md       # Token/LOC metrics reporter
│   │   ├── pickle-retry.md         # Retry a failed ticket
│   │   ├── eat-pickle.md           # Loop canceller
│   │   ├── help-pickle.md          # Help text
│   │   ├── add-to-pickle-jar.md    # Queue into Jar
│   │   ├── pickle-jar-open.md      # Run all Jar tasks (Night Shift)
│   │   ├── disable-pickle.md       # Disable stop hook globally
│   │   └── enable-pickle.md        # Re-enable stop hook
│   └── settings.json       # Stop hook registration (created by install.sh in ~/.claude/)
├── extension/
│   ├── src/                 # TypeScript sources (canonical — never edit .js directly)
│   │   ├── bin/             # → compiles to extension/bin/
│   │   ├── hooks/           # → compiles to extension/hooks/
│   │   ├── services/        # → compiles to extension/services/
│   │   ├── lib/             # → compiles to extension/lib/
│   │   ├── scripts/         # Build-time scripts (schema parity, audits)
│   │   └── types/           # → compiles to extension/types/
│   ├── bin/                 # Compiled JS (build artifacts)
│   │   ├── setup.js                  # Session initializer
│   │   ├── cancel.js                 # Loop canceller
│   │   ├── spawn-morty.js            # Worker subprocess spawner
│   │   ├── spawn-refinement-team.js  # Parallel PRD analyst spawner
│   │   ├── jar-runner.js             # Jar Night Shift runner
│   │   ├── mux-runner.js             # Outer loop for /pickle-tmux & /pickle-zellij
│   │   ├── pipeline-runner.js        # Sequential phase orchestrator (pickle → anatomy → szechuan)
│   │   ├── microverse-runner.js      # Microverse convergence loop runner
│   │   ├── init-microverse.js        # Microverse session initializer
│   │   ├── monitor.js                # Live tmux dashboard (Matrix-styled)
│   │   ├── log-watcher.js            # Live tmux log stream
│   │   ├── morty-watcher.js          # Live worker log stream
│   │   ├── raw-morty.js              # Raw worker output pane
│   │   ├── refinement-watcher.js     # PRD refinement monitor pane
│   │   ├── worker-setup.js           # Worker session initializer
│   │   ├── get-session.js            # Session path resolver
│   │   ├── update-state.js           # State mutation helper
│   │   ├── status.js                 # Session status display
│   │   ├── retry-ticket.js           # Reset + re-spawn a failed ticket
│   │   ├── resolve-scope.js          # Scope filter CLI
│   │   ├── log-activity.js           # CLI: log activity events (used by personas)
│   │   ├── log-commit.js             # PostToolUse hook: git commits → activity log
│   │   ├── standup.js                # CLI: formatted standup from activity JSONL
│   │   ├── prune-activity.js         # Prune old activity JSONL (called by setup.js)
│   │   ├── circuit-reset.js          # Manual circuit breaker reset CLI
│   │   ├── metrics.js                # Token/LOC metrics reporter (daily/weekly)
│   │   ├── check-update.js           # Auto-update check against GitHub Releases
│   │   ├── dot-builder.js            # DotBuilder programmatic entry
│   │   ├── dot-builder-cli.js        # DotBuilder CLI
│   │   ├── plumbus-frame-analyzer.js # .dot frame analyzer (Override 6)
│   │   ├── sync-schema.js            # Attractor schema sync
│   │   ├── council-publish.js        # Council-of-Ricks end-of-session PR publisher
│   │   ├── check-gate.js             # Gate check CLI (typecheck/lint/tests, --mode baseline|strict)
│   │   ├── finalize-gate.js          # Post-skill gate enforcement + remediator orchestration
│   │   └── spawn-gate-remediator.js  # Remediator brief writer (gate result → morty-gate-remediator.md)
│   ├── layouts/
│   │   └── monitor-pickle.kdl   # Zellij layout for /pickle-zellij
│   ├── hooks/
│   │   ├── dispatch.js      # Hook router (fail-open, spawns handlers)
│   │   ├── resolve-state.js # State file resolution + atomic writes
│   │   └── handlers/
│   │       └── stop-hook.js # The loop engine
│   ├── services/
│   │   ├── pickle-utils.js       # Shared utilities
│   │   ├── git-utils.js          # Git helpers
│   │   ├── pr-factory.js         # PR creation
│   │   ├── jar-utils.js          # Jar queue helper
│   │   ├── activity-logger.js    # JSONL activity log writer (date-keyed, 0o600)
│   │   ├── circuit-breaker.js    # Three-state circuit breaker (CLOSED/HALF_OPEN/OPEN)
│   │   ├── metrics-utils.js      # Metrics aggregation (session scanner + git log parser)
│   │   ├── microverse-state.js   # Microverse state mgmt (convergence detection, compareMetric, classifyFailure)
│   │   ├── state-manager.js      # Atomic file locks, crash recovery, schema migration
│   │   ├── scope-resolver.js     # Scope filter (anatomy-park, szechuan-sauce)
│   │   ├── convergence-defaults.js # DotBuilder convergence preset defaults
│   │   ├── convergence-gate.js   # Gate service: runGate, filterByScope, assertBaselineFresh, baseline subtraction
│   │   └── dot-builder.js        # DotBuilder core (attractor .dot codegen)
│   ├── lib/
│   │   ├── cluster-fix-selector.js  # .dot cluster fix selector
│   │   ├── context-key-matrix.js    # .dot context-key propagation matrix
│   │   ├── diamond-routing.js       # .dot diamond routing algorithm
│   │   ├── engine-keys-registry.js  # Engine-injected attractor keys
│   │   ├── plumbus-kill-switch.js   # PLUMBUS_GENERATIVE_AUDIT kill switch
│   │   ├── severity.js              # Shared severity enum
│   │   ├── tarjan-scc.js            # Tarjan SCC for cycle detection
│   │   └── verification-comparator.js # Verification diff comparator
│   ├── types/
│   │   ├── index.js               # State, PromiseTokens, HookInput, Microverse types, BuilderSpec, errors
│   │   ├── attractor-schema.js    # Attractor DOT schema entry
│   │   ├── attractor-schema.fallback.js # Bundled attractor schema fallback
│   │   ├── engine-keys-registry.js
│   │   └── plumbus-frame-analyzer.js
│   ├── data/                      # Static JSON consumed by plumbus-frame-analyzer
│   │   ├── engine-injected-keys.json
│   │   └── scope-v1.json
│   ├── eslint-plugin-pickle/      # Local ESLint rules (pickle/no-unsafe-error-cast, etc.)
│   ├── schemas/                   # JSON schemas
│   ├── szechuan-sauce-principles.md          # P0–P4 rubric + confidence scoring + false-positives filter
│   ├── szechuan-sauce-financial-principles.md
│   ├── tests/                     # Test suite (node --test)
│   ├── package.json               # "type": "module" — CRITICAL
│   └── tsconfig.json              # TypeScript config (strict, ESNext)
├── images/
│   ├── architecture.png     # Architecture hero
│   ├── tmux-monitor.png     # tmux monitor screenshot
│   ├── portal-gun.png       # Portal Gun — gene transfusion
│   ├── microverse.png       # Microverse hero image
│   └── Meeseeks.webp        # Mr. Meeseeks (from Wikipedia — Meeseeks and Destroy)
├── persona.md               # Pickle Rick persona snippet (append to your project's CLAUDE.md)
├── pickle_settings.json     # Default limits
├── install.sh               # Installer
└── uninstall.sh             # Uninstaller
```

---

## Memory & State

Rick remembers. Not just within a session — across sessions, across conversations, across dimensions. Three memory systems work together so Rick always knows where he's been, what he's doing, and what went wrong last time.

### Auto-Memory (Cross-Session Persistence)

Claude Code's built-in [auto-memory](https://docs.anthropic.com/en/docs/claude-code) system gives Rick persistent knowledge across conversations. The memory directory lives at:

```
~/.claude/projects/<project-hash>/memory/
├── MEMORY.md          # Always loaded into context (first 200 lines)
└── tmux_research.md   # Topic-specific deep dives (linked from MEMORY.md)
```

**MEMORY.md** is automatically injected into every conversation. It contains:
- Project location, build commands, architecture notes
- Key API surfaces and type definitions
- Test file inventory and current test count
- Important patterns and gotchas (macOS symlinks, hook decisions, pipe flushing)
- **Session History Summaries** — a running log of what was accomplished in each session (bugs fixed, features added, test count growth)

Topic files store detailed research that would blow past the 200-line cap. Rick creates these during deep dives and links them from MEMORY.md.

Memory updates happen automatically when stable patterns are confirmed across sessions. One-off findings stay out until verified.

### Session State (`state.json`)

Every Pickle Rick session creates a directory under `~/.local/share/pickle-rick/sessions/<date-hash>/` (XDG data dir; override via `PICKLE_DATA_ROOT`) with a `state.json` that tracks the live execution state:

```json
{
  "active": true,
  "working_dir": "/path/to/project",
  "step": "implement",
  "iteration": 7,
  "max_iterations": 500,
  "max_time_minutes": 720,
  "worker_timeout_seconds": 1200,
  "start_time_epoch": 1772287760,
  "completion_promise": null,
  "original_prompt": "Build the thing",
  "current_ticket": "feat-03",
  "history": [],
  "started_at": "2026-04-23T10:00:00.000Z",
  "session_dir": "/Users/.../sessions/2026-04-23-a1b2c3d4",
  "tmux_mode": true,
  "min_iterations": 0,
  "command_template": "/pickle-tmux",
  "chain_meeseeks": false,
  "schema_version": 2,
  "pid": 12345,
  "consecutive_short_responses": 0,
  "phases_entered": ["prd", "breakdown"],
  "activity": []
}
```

Defined in `extension/src/types/index.ts` (the `State` interface). Valid `step` values (`VALID_STEPS`): `prd | breakdown | research | plan | implement | refactor | review`. The stop hook reads `state.json` on every turn to decide whether to block or approve exit. The mux-runner reads it between iterations to build the handoff summary. `/pickle-status` reads it to display the dashboard.

**StateManager** (`extension/src/services/state-manager.ts`) mediates all writes: atomic rename, per-file advisory locks with exponential backoff + jitter, stale-lock recovery at `30s`, and automatic schema migration. The current schema version is `2` (see `STATE_MANAGER_DEFAULTS`).

### Session Logs & Artifacts

Each session directory accumulates execution traces and work products:

```
~/.local/share/pickle-rick/sessions/2026-02-28-a1b2c3d4/
├── state.json                          # Live state (see above)
├── circuit_breaker.json                # Circuit breaker state (when enabled)
├── rate_limit_wait.json                # Rate limit countdown (transient — deleted on resume)
├── prd.md                              # The PRD for this epic
├── linear_ticket_parent.md             # Parent ticket with all sub-tickets
├── hooks.log                           # Stop hook decisions and state transitions
├── mux-runner.log                      # Orchestrator-level log (tmux/zellij mode)
├── tmux_iteration_1.log                # Per-iteration NDJSON stdout
├── tmux_iteration_1.exitcode           # Subprocess exit code for post-mortem
├── tmux_iteration_2.log
├── meeseeks-summary.md                 # Meeseeks audit trail (when review runs)
├── feat-01/
│   ├── linear_ticket_feat-01.md        # Ticket specification
│   ├── research_feat-01.md             # Research phase output
│   ├── research_review.md              # Research review
│   ├── plan_feat-01.md                 # Implementation plan
│   ├── plan_review.md                  # Plan review
│   └── worker_session_12345.log        # Morty worker stdout
├── feat-02/
│   └── ...
└── refinement/                         # PRD refinement worker logs
    ├── worker_requirements_c1.log      # Requirements analyst (cycle 1)
    ├── worker_codebase_c1.log          # Codebase analyst (cycle 1)
    └── worker_risk-scope_c1.log        # Risk/scope analyst (cycle 1)
```

**Log types:**

| Log | What it captures |
|-----|------------------|
| `hooks.log` | Every stop hook decision (approve/block), completion token matches, state transitions |
| `mux-runner.log` | Iteration lifecycle: spawn, wait, classify completion, advance or stop |
| `tmux_iteration_N.log` | Raw NDJSON from `claude -p --output-format stream-json` per iteration |
| `worker_session_<pid>.log` | Full Morty subprocess output — research, planning, implementation, test runs |
| `worker_<role>_c<N>.log` | PRD refinement analyst output per role per cycle |
| `meeseeks-summary.md` | Per-pass table of issues found/fixed, test status, commit hashes |
| `circuit_breaker.json` | Circuit breaker state: `state` (CLOSED/HALF_OPEN/OPEN), counters, `lastError`, `reason` |
| `rate_limit_wait.json` | Transient: `waiting`, `wait_until` (ISO), `consecutive_waits`, `rate_limit_type`, `resets_at_epoch`, `wait_source` (`"api"`/`"config"`). Deleted on resume. Monitor reads this for countdown + type display |

**Ticket artifacts** follow the lifecycle phases: `research_<id>.md` → `research_review.md` → `plan_<id>.md` → `plan_review.md` → implementation (code changes + commits). These persist in the session directory and can be reviewed after the run.

### Activity Log (Standup Data)

The activity logger (`activity-logger.ts`) writes a date-keyed JSONL file for every notable event — ticket transitions, commits, phase changes, errors:

```
~/.local/share/pickle-rick/activity/
├── 2026-02-27.jsonl
└── 2026-02-28.jsonl
```

`/pickle-standup` reads these to produce a formatted standup summary. Old files are pruned by `prune-activity.js` (called during session setup).

### Global Settings

`~/.claude/pickle-rick/pickle_settings.json` stores all configurable defaults (max iterations, timeouts, meeseeks pass limits, refinement cycles). See [Settings](README.md#settings-pickle_settingsjson) in the README.

### How the Systems Connect

```
Auto-Memory (MEMORY.md)              Global Settings (pickle_settings.json)
   │ loaded every conversation            │ read at session setup
   │                                      │
   ▼                                      ▼
┌──────────────────────────────────────────────┐
│              Active Session                   │
│  state.json ◄──► stop-hook / mux-runner     │
│       │                                       │
│       ├── hooks.log (decision trace)          │
│       ├── tmux_iteration_N.log (raw output)   │
│       ├── ticket/worker_*.log (Morty output)  │
│       ├── ticket/research_*.md (artifacts)    │
│       └── meeseeks-summary.md (review audit)  │
└──────────────────┬───────────────────────────┘
                   │
                   ▼
        Activity Log (JSONL)
           │
           ▼
      /pickle-standup
```

When a session ends, its directory persists — you can review any past session's state, logs, and artifacts. Auto-memory captures the *lessons learned* (patterns, bugs, decisions), while session dirs capture the *raw execution trace*.

---

## The Stop Hook Loop

```
  Claude finishes a turn
          │
          ▼
  Stop hook fires  ◄──────────────────────────────────┐
          │                                             │
          ▼                                             │
  Read state.json                                       │
          │                                             │
    ┌─────┴──────┐                                      │
    │ Loop active?│── No ──► { decision: "approve" }   │
    └─────┬──────┘                                      │
          │ Yes                                         │
          ▼                                             │
  Check completion tokens                                │
          │                                             │
    ┌─────┴──────┐                                      │
    │Task done?  │── Yes ──► { decision: "approve" }   │
    │(promise    │                                      │
    │ detected)  │                                      │
    └─────┬──────┘                                      │
          │ No                                          │
          ▼                                             │
    ┌─────┴──────┐                                      │
    │Limit hit?  │── Yes ──► { decision: "approve" }   │
    └─────┬──────┘                                      │
          │ No                                          │
          ▼                                             │
  { decision: "block",                                  │
    reason: "Pickle Rick Loop Active..." } ─────────────┘
```

---

## Context Clearing

The single biggest advantage of the Rick loop over naive "just keep prompting" approaches is **context clearing between iterations**.

Long-running AI sessions accumulate stale conversational context. The model starts "remembering" earlier wrong turns, half-finished reasoning, and superseded plans — all of it silently influencing every subsequent response. Over enough iterations, the model loses track of what phase it's in, tries to restart from scratch, or hallucinates already-completed work.

**The Ralph Wiggum insight** (see [Credits](README.md#-credits)) is that a simple loop — blocking the agent's exit and re-injecting a minimal, accurate context — outperforms one long conversation every time. Fresh context = cleaner decisions.

**How we accomplish it depends on the mode:**

**Interactive mode** (`/pickle`): The stop hook injects a short feedback string into the `reason` field of every `decision: block` response (e.g. `"Pickle Rick Loop Active (Iteration 3) of 10"`). Claude Code surfaces this `reason` string as a system message, giving Rick enough orientation to continue.

**tmux mode** (`/pickle-tmux`): Each iteration spawns a genuinely fresh `claude -p` subprocess. The mux-runner builds a full structured handoff summary — phase, ticket list, task — and injects it into the prompt before each iteration starts:

```
=== PICKLE RICK LOOP CONTEXT ===
Phase: implementation
Iteration: 4 of 10
Session: ~/.local/share/pickle-rick/sessions/2025-01-15-a3f2
Ticket: PROJ-42
Task: refactor the auth module
PRD: exists
Tickets:
  [x] PROJ-40: Set up database schema
  [x] PROJ-41: Add JWT middleware
  [~] PROJ-42: Refactor auth module
  [ ] PROJ-43: Write integration tests

NEXT ACTION: Resume from current phase. Read state.json for context.
Do NOT restart from PRD. Continue where you left off.
```

No matter how much context gets evicted, Rick always wakes up knowing exactly where he is and what to do next.

Morty workers already get clean context naturally (each is a fresh `claude -p` subprocess with the full 6-phase lifecycle template from `send-to-morty.md`).

---

## Manager / Worker Model

- **Rick (Manager)**: Runs in your interactive Claude session. Handles PRD, Breakdown, orchestration.
- **Morty (Worker)**: Spawned as `claude --dangerously-skip-permissions --add-dir <extension_root> --add-dir <ticket_path> -p "..."` subprocess per ticket. Gets the full 6-phase lifecycle prompt from `send-to-morty.md`. The `CLAUDECODE` env var is stripped so workers don't detect a nested session. Workers are scope-bounded: they write artifacts only to their ticket directory, signal completion only via `<promise>I AM DONE</promise>`, and are forbidden from modifying `state.json` (enforced at both prompt and CLI level).

---

## Settings (`pickle_settings.json`)

All defaults are configurable via `~/.claude/pickle-rick/pickle_settings.json`:

| Setting | Default | Description |
|---|---|---|
| `default_max_iterations` | 500 | Max loop iterations before auto-stop |
| `default_max_time_minutes` | 720 | Session wall-clock limit (12 hours) |
| `default_worker_timeout_seconds` | 1200 | Per-worker subprocess timeout |
| `default_manager_max_turns` | 50 | Max Claude turns per iteration (interactive/jar) |
| `default_tmux_max_turns` | 200 | Max Claude turns per iteration (tmux) |
| `default_refinement_cycles` | 3 | Number of refinement analysis passes |
| `default_refinement_max_turns` | 100 | Max Claude turns per refinement worker |
| `default_council_min_rounds` | 2 | Minimum Council of Ricks parallel review rounds |
| `default_council_max_rounds` | 5 | Maximum Council of Ricks parallel review rounds |
| `default_council_publish` | true | Auto-publish PR comments at session end (disable with `--no-publish`) |
| `default_circuit_breaker_enabled` | true | Enable circuit breaker |
| `default_cb_no_progress_threshold` | 5 | No-progress iterations before OPEN |
| `default_cb_same_error_threshold` | 5 | Identical errors before OPEN |
| `default_cb_half_open_after` | 2 | No-progress iterations before HALF_OPEN |
| `default_rate_limit_wait_minutes` | 60 | Fallback wait when no API reset time |
| `default_max_rate_limit_retries` | 3 | Consecutive rate limits before stopping |

**Convergence Gate** *(v1.58+, nested under `convergence_gate`)*

| Setting | Default | Description |
|---|---|---|
| `convergence_gate.commands` | `{}` | Per-project command overrides (typecheck/lint/tests). Empty = auto-detect from `gate-commands.json` |
| `convergence_gate.enabled_convergence_files` | `["anatomy-park.json"]` | Microverse convergence files that opt in to per-iteration gating |
| `convergence_gate.timeout_ms.typecheck` | 120000 | Per-check timeout (ms) |
| `convergence_gate.timeout_ms.lint` | 60000 | Per-check timeout (ms) |
| `convergence_gate.timeout_ms.tests` | 300000 | Per-check timeout (ms) |
| `convergence_gate.gate_total_timeout_ms` | 600000 | Cumulative cap for a full gate run (ms) |
| `convergence_gate.remediator_timeout_s` | 600 | `morty-gate-remediator` subprocess timeout (s) |
| `convergence_gate.szechuan_max_remediation_cycles` | 3 | Gate ↔ remediator loop cap for `/szechuan-sauce` |
| `convergence_gate.anatomy_park_max_remediation_cycles` | 5 | Gate ↔ remediator loop cap for `/anatomy-park` |
| `convergence_gate.regression_warning_threshold` | 5 | Per-iteration regressions before the one-time warning fires |
| `convergence_gate.baseline_max_age_iterations` | 30 | Halt if baseline older than N iterations |
| `convergence_gate.baseline_max_age_seconds` | 14400 | Halt if baseline older than N seconds (4h) |
| `convergence_gate.prefer_test_unit_alias` | false | Prefer `npm run test:unit` (or pnpm/yarn equivalent) over plain `npm test` when present |
| `convergence_gate.known_flake_files` | `[]` | Test files whose failures yield `green-with-known-flake-warnings` instead of red |

### Upgrading settings from 1.48.x → 1.49.x

1.49 replaces the Council's sequential pass rotation with parallel rounds (every category runs every round via `Agent` fan-out). The settings keys change accordingly:

- `default_council_min_passes` → `default_council_min_rounds` (default: `2`)
- `default_council_max_passes` → `default_council_max_rounds` (default: `5`)

`install.sh` preserves user customizations by merging repo defaults underneath user values (`jq -s '.[0] * .[1]'`). Existing installs keep the now-dead `default_council_min_passes` / `default_council_max_passes` keys (harmless — the skill ignores them). Fresh installs get the new round-based defaults automatically.

To migrate an existing install and drop the dead keys:

```bash
jq 'del(.default_council_min_passes, .default_council_max_passes) | .default_council_min_rounds = 2 | .default_council_max_rounds = 5' \
  ~/.claude/pickle-rick/pickle_settings.json \
  > /tmp/pickle-settings.json && mv /tmp/pickle-settings.json ~/.claude/pickle-rick/pickle_settings.json
```
