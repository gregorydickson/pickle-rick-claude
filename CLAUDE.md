# Pickle Rick for Claude Code

PRD → Breakdown → Research → Plan → Implement → Verify → Review → Simplify.

## 🧭 PRIME DIRECTIVE (operator-set, BINDING, governs everything below)

**If a pipeline exits, it takes reliability AND quality and all other metrics to zero.**

**Autonomous execution must never be sacrificed.**

**We achieve reliability first, then slowly work quality up on top of it.**

Everything below elaborates this. Nothing below overrides it.

## 🛑 WHEN THE PIPELINE STOPS, RELIABILITY GOES TO ZERO — AND SO DOES QUALITY (operator-set, BINDING, elaborates the PRIME DIRECTIVE)

**A halted run produces no output. No output has no quality.** So a "quality gate" that stops the
pipeline does not trade reliability for quality — it takes **both** to zero. A stopping gate is
**anti-quality**, not a careful one.

**Ratchet order — they are sequential, not a dial:**
1. **Reliability / autonomy first.** The bar is: the system COMPLETES hands-off runs. A correct-but-halted
   run is a failure; an imperfect-but-completed run is a success.
2. **Quality second**, ratcheted up on top of a system that already completes. You cannot ratchet quality
   on a system that stops.

**What a gate MAY do:** refuse a LOCAL action (don't flip THIS ticket Done, don't ship THIS commit),
stamp an `exit_reason`, and log a residual for a human.
**What a gate MAY NEVER do:** break the phase loop or terminate the pipeline.
The run **parks the item, flags it, and CONTINUES.** Output-with-flags ≫ no-output.

**But continuing is NOT claiming success.** *Ran to completion* and *reported success* are different
facts, and conflating them is fake-green — this codebase's most frequent failure mode. A degraded run
must execute every phase, report the degradation honestly, and **withhold the success verdict** (no
auto-release). That is [[B-NOSTOP-GATES]]' rule stated as a priority: **honesty is a REPORTING property,
halting is a DISPOSITION, and they are not the same wire.**

**Halting is reserved for the genuine crash floor** — cannot-physically-continue only (unreadable/
unwritable state, missing `start_commit`, `state_schema_version_ahead`, `state_working_dir_missing`,
toolchain unavailable, budget/iteration cap, operator cancel, explicit `--strict-phases`). Anything
that is a *measurement* or *quality* verdict is not a floor. **Do not add abort conditions** — every new
one is a new way for reliability and quality to both reach zero.

## 🐶 Dogfood by default — fix Pickle Rick by RUNNING Pickle Rick

The pipeline is the product: it fixes its own bugs. **Default: author a PRD/ticket → `/pickle-pipeline` (or `/pickle-tmux`).** Hand-decomposing a PRD into tickets is planning (fine); hand-*building* the fix code is not. A bug we won't dogfood is one we don't trust the tool to survive — fix that.

## 🚫 NEVER hand-build. ALWAYS run a pipeline. (operator-set 2026-08-04 — BINDING, no exceptions)

**There is no hand-build exception. Not for the salvage path, not for the completion-evidence path, not for the Done-flip path, not for "just this once because it's load-bearing."** Every code fix in this repo is built by `/pickle-pipeline` (or `/pickle-tmux`). The prior "NARROW R-PSRB exception" is **DELETED** — it was a reflex dressed as a rule, and it kept the tool from being tested exactly where it was weakest.

**The R-PSRB catch-22 is real, and it is not an escape hatch — it is the thing being tested.** When a bundle edits the salvage / completion-evidence / Done-flip path, the deployed pre-fix runtime applies that same buggy logic to the worker building the fix. That is a genuine hazard, so run those bundles **ATTENDED**: launch normally, watch the salvage seam, and recover the stall if it bites (`B-RASO`, beta.43, shipped a salvage-path fix this way — the precedent exists and it worked). Attended is an *operator posture*, never a different build path.

**Why the exception had to go:** a bundle we refuse to dogfood is a bundle whose fix we cannot claim the tool survives. Hand-building the recovery path means the recovery path is the one code in the system never exercised by the system. Every stalled run that hand-build "avoided" was a defect report we chose not to collect.

**What is still true (and is NOT a hand-build licence):** spawn-gate / routing / phase-exit / scope-fence / refinement / feature edits are pipeline-safe because a running pipeline executes **deployed JS**, not your source diff (which lands only at `install.sh`). Those run unattended. Salvage-path bundles run attended. Both run.

Detail: `prds/CLAUDE.md` → "Self-modifying-recovery bundles".

## ⛔ Worker Forbidden Ops (R-WSRC)

Workers run inside the runtime they modify. Hooks enforce these (prose alone failed — R-QGSK-3, 2026-05-16).

| Forbidden write | Override flag | Runtime check |
|---|---|---|
| `state.json` / `state.json.tmp.*` | `allow_state_writes_reason` (schema migration only) | `state-manager.ts` ceiling + `config-protection.ts` hook |
| `LATEST_SCHEMA_VERSION` bump | schema-migration ticket + `_internalSchemaBump` flag | `state-manager.ts` + `install.sh` AC-RVN-08 |
| `pickle_settings.json` / `.tmp.*` | `allow_settings_writes_reason` | `config-protection.ts` hook |
| `circuit_breaker.json`, `pipeline-status.json` / `.tmp.*` | none | `config-protection.ts` hook |
| tsc errors at commit time | `allow_tsc_failed_reason` (manager-only) | `tsc-gate.ts` hook |
| `bash install.sh` from worker | none | bash-scanner |
| `~/.claude/pickle-rick/**` | none | `config-protection.ts` hook |
| Test `claude --add-dir <real-repo>` | none | `backend-spawn.ts` `PICKLE_TEST_MODE` |
| Other ticket's dir | none | `check-scope-diff.ts` preflight |
| `spawnSync`/`spawn` no `timeout` | per-callsite | Per-file trap doors |
| Orchestrator tokens (`EPIC_COMPLETED`, etc.) | none — workers emit only `<promise>I AM DONE</promise>` | `promise-tokens.ts` scrubber |

PRD: `prds/archive/bundles/p1-worker-source-state-recursion-contamination.md`. Closer manager-handoff runbook: `docs/closer-ticket-manager-handoff.md` (manager-owned residuals after `closer_handoff_terminal` / `manager_handoff_pending`).

## Documentation Rule

Adding/removing/modifying commands (`.claude/commands/*.md`) → update `README.md`. Docs drift = bugs.

Internal ticket artifacts use `rick_ticket_<hash>.md` and `rick_ticket_parent.md`; reserve "Linear ticket" prose for real external tracker issues, not the on-disk worker artifacts.

### Filing findings (operator-set)

The backlog is what the OPERATOR logs from real runs. An agent's mid-session observations are not
findings. Open a PRD / MASTER_PLAN row / `R-*` ID only when: the operator asks, OR it blocks the run in
progress, OR this bundle just caused it. Everything else — flakes, slow tests, cosmetic misparses,
"worth watching" — goes in the chat report and dies there. An ID grants permanence the observation has
not earned, and a P-number on a 30 ms timing flake buys attention it does not deserve.

### Banned word: "wedge"

Imprecise — it has meant a hung runner, a halted pipeline, a stalled ticket, a salvage loop, and an
auto-skip. Name the failure and cite the observable that proves it: **hang** (CPU flat across ≥2 samples)
· **halt** (name the `exit_reason`) · **stalled ticket** (iteration + `spawn_count`) · **no-progress
loop** (iteration advances, artifacts do not) · **manual recovery** (the command that unblocked it).
Applies to new writing; fix old occurrences only when already touching the file.

## Source of Truth

Canonical → deployed (`bash install.sh` rsyncs, overwrites): `extension/src/*.ts` → `~/.claude/pickle-rick/extension/**/*.js` | `.claude/commands/*.md` → `~/.claude/commands/*.md` | `pickle_settings.json` + `persona.md` → `~/.claude/pickle-rick/`. **NEVER edit deployed files — edit source, run `bash install.sh`.**

## Generated Artifacts

`*.dot` + PRD `*.md` under `extension/` are generated (consumed by attractor) — do NOT commit; `*.dot` is gitignored. `extension/data/` — static JSON for the plumbus-frame-analyzer (e.g. `engine-injected-keys.json`): committed, edit source not the deployed copy.

## Build & Test — full gate

Run from `extension/` (the release gate; green before any tag):
```
cd extension && npm ci && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && bash scripts/audit-guarded-reset.sh && bash scripts/audit-un-terminalize-single-path.sh && bash scripts/audit-did-we-count.sh && npm run test:fast:budget && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive
```
Tests: `extension/tests/*.test.js` via `node --test` (no `.test.ts`). Aux scripts: `coverage` (c8 fast-tier baseline), `coverage:delta` (`scripts/coverage-delta.sh`), `wire-check` (gate parity, `scripts/check-wired.sh`).

## Required Patterns

- CLI guard: `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`
- Hook decisions: `"approve"` / `"block"` only (never `"allow"`)
- Errors: `const msg = err instanceof Error ? err.message : String(err);`
- Extension path: `~/.claude/pickle-rick` (never `.gemini`)

## Versioning

Semver in `extension/package.json`: **Major** = breaking (state schema, CLI args, hook contracts) | **Minor** = features (commands, flags, prompts) | **Patch** = fixes/refactors. Bump → commit `chore: bump version to X.Y.Z` → `gh release create vX.Y.Z`.

**Before tagging**, the full release gate must be green from `extension/` (test failures block release, no exceptions) — this is the release-gate source of truth, mirrored by `.github/workflows/release.yml` (enforced by `release-gate-parity.test.js`):

`npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && bash scripts/audit-guarded-reset.sh && bash scripts/audit-un-terminalize-single-path.sh && bash scripts/audit-did-we-count.sh && npm run test:fast:budget && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`

AND the tree must be clean (`git status` clean, compiled JS matches TS source). No dirty release.

## Architecture

| Script | Role |
|--------|------|
| dispatch.js | Hook entry, stdin JSON, spawns handler, fail-open |
| stop-hook.js | Checks state.json tokens, no lifecycle advance, tmux passthrough |
| setup.js | Session init (state.json, ticket dirs), first prompt |
| spawn-morty.js | Per-ticket `claude -p` subprocess |
| spawn-refinement-team.js | 3 parallel analysts/cycle, writes refinement_manifest.json |
| mux-runner.js | Context-clearing outer loop via tmux |
| jar-runner.js | Batch runner for jar queue |
| metrics.js + metrics-utils.js | Token/commit/LOC reporter, cache at `~/.claude/pickle-rick/metrics-cache.json` |
| monitor.js / log-watcher.js / morty-watcher.js / raw-morty.js | tmux TUI panes (Matrix-styled) |
| refinement-watcher.js | PRD refinement team monitor pane |
| microverse-runner.js + microverse-state.js | Metric convergence loop: measure, compare, rollback, stall detection |
| convergence-gate.ts | Gate service: runGate, filterByScope, assertBaselineFresh, baseline subtraction; invoked by check-gate / finalize-gate / microverse-runner |
| pipeline-runner.js | Sequential phase orchestrator: pickle → anatomy-park → szechuan-sauce |
| state-manager.js | Atomic file locks, crash recovery, schema migration, multi-file transactions |
| types/index.js | Shared types: State, errors (StateError/LockError/TransactionError), PromiseTokens, activity events |

## Settings (pickle_settings.json)

Operator fields (source `pickle_settings.json`, deployed via `bash install.sh`):

| Field | Type | Default | Description |
|---|---|---|---|
| `worker_mcp_config_path` | `string \| null` | `null` | Subset MCP config for worker/manager subprocesses (e.g. read-only Linear; omit write servers). `null` = no operator override; the runtime falls back to `~/.claude.json` only when that file parses and contains an `mcpServers` record, otherwise `--mcp-config` is omitted. |
| `worker_mcp_snapshot_servers` | `string[]` | `[]` | Server names from `worker_mcp_config_path` to snapshot at setup. `[]` = none. |
| `codegraph` | `object` | see notes | v2.0 Code Graph block (`resolveCodegraphSettings`, per-field fallback). **Enabled by default** (WS-B3): `enabled` (`true`), `index_at_setup` (`true`), `staleness_max_age_minutes` 30 (min 1), `context_max_bytes` 8192 (clamp 1024–65536), `expose_mcp_to_workers` (`true`, forced source-authoritative by `install.sh` MANAGED_KEYS — a stale deployed `false` cannot survive a deploy), timeouts `index_timeout_ms` 120000 (floor 5000) / `sync_timeout_ms` 30000 (floor 1000) / `query_timeout_ms` 5000 (floor 500). Kill-switch `PICKLE_CODEGRAPH=off`. |
| `hardening` | `object` | see notes | Runtime-recovery block (DISTINCT from `bmad_hardening`), all four fields resolved by the single `resolveHardeningSettings` in `services/pickle-utils.ts`. `silent_death_respawn_cap` 1 (0 disables), `failed_flip_suppression_cap` 2 (0 disables) — non-negative ints drawing down the persistent `state.recovery_attempts` ledger (survives relaunch/`--resume`). `breaker_recovery_grace_seconds` 30: grace window where a breaker-recovery spawn doesn't count as progress. `bounded_terminal_escape_cap` 3 (AC-A4): consecutive no-progress relaunches on the same In Progress ticket before the bounded escape forces it terminal. |
| `rate_limit` | `object` | see notes | B-RRH rate-limit park (`resolveRateLimitSettings`, `pickle-utils.ts`). `max_park_minutes` 360 (int floor 1) caps cumulative parked wall-clock per episode before `rate_limit_park_exhausted`. Absent/malformed → compiled default. |

## Environment Variables

Kill-switches are the literal lowercase `"off"` (any other value / absent = feature active) unless noted.

| Variable | Values | Effect |
|---|---|---|
| `PLUMBUS_GENERATIVE_AUDIT` | `off` | Bypasses Override 6 — no analyzer, no `## Generative Findings`; logs `generative_audit: skipped (kill-switch)` to `state.json.activity`. |
| `PICKLE_CODEGRAPH` | `off` | Makes `CodegraphService` inert (returns null, never loads `@colbymchenry/codegraph`) + skips setup-time index (`runCodegraphIndexAtSetup`); else `codegraph.enabled` governs. Reads `services/codegraph-service.ts`, `bin/setup.ts`. |
| `PICKLE_INSTALL_ROOT` | path (default `$HOME/.claude/pickle-rick`) | Does NOT override `install.sh`'s deploy prefix — only `--prefix` (`$PREFIX`) does that; `install.sh:33` unconditionally reassigns `PICKLE_INSTALL_ROOT="${PREFIX:-$HOME/.claude/pickle-rick}"`, discarding any inherited value. Governs the deployed runtime's own path resolution (e.g. deploy-lifecycle soak, hook commands) once set to match `--prefix`. |
| `RUN_EXPENSIVE_TESTS` | `1` | Gates `test:expensive` (deploy-lifecycle soak, release-gate full run). Explicit only; not in default `npm test`. |
| `SOAK_SECONDS` | int ≥1800 (default 1800) | deploy-lifecycle soak duration (`tests/integration/deploy-lifecycle-soak.test.js`). |
| `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` | int ms ≥60000 (default 600000) | Per-gate-phase cap for `test:fast`/`test:integration` in the worker lint gate (R-WTFT). Below floor clamps up; invalid → default. **Parent/child split (R-WGTORPH):** the variable governs the gate's own timeout in the PARENT — `resolveWorkerTestGateTimeoutMs` reads it in the launching process to size the spawn's `timeout` (`mux-runner.ts:638`, `spawn-morty.ts:2061`/`:2137`) — and is scrubbed from the gate child's view: it is the first member of `PICKLE_GATE_SCRUBBED_ENV_KEYS`, so `scrubGateEnv()` deletes it from the env handed to both test-gate spawns (`mux-runner.ts:649`, `spawn-morty.ts:1330`). A test running inside the gate therefore never observes it, however the operator exported it. |
| `PICKLE_EXIT_DRAIN_FALLBACK_MS` | int ms (default 30000) | Fallback drain window for the manager `'exit'` event when the `'close'`-primary stdio drain never fires. Invalid/≤0/fractional → default. Resolver `resolveExitDrainFallbackMs` (`mux-runner.ts`). |
| `PICKLE_ORPHAN_REAP` | `off` | Makes the R-CXHANG setup-time orphaned-worker-proc reaper inert (no ps scan, no kills); otherwise setup bootstrap reaps worker procs whose owning session is provably dead (positive ownership + min-age required). Reads `src/bin/setup.ts` (`runSetupOrphanReap`) + `src/services/orphan-reaper.ts`. |
| `PICKLE_WORKER_LOCK` | `off` | Makes the per-session worker-spawn lock inert (`acquireWorkerSpawnLock` returns `{ inert: true }` — no lock file touched, every acquisition succeeds immediately); otherwise a spawn that cannot take the lock within `WORKER_SPAWN_LOCK_TIMEOUT_MS` (30s) throws `WorkerSpawnLockContendedError`. Reads `src/bin/spawn-morty.ts` (`acquireWorkerSpawnLock` / `releaseWorkerSpawnLock`). |

## Tune-Back CUJs

1. **Worker test-gate timeout (per-machine)**: `export PICKLE_WORKER_TEST_FAST_TIMEOUT_MS=<ms>` (floor 60000). Env-only — do NOT re-add `worker_test_gate_timeout_ms` to `pickle_settings.json`; the key is source-authoritative (B-SSAT) and `install.sh` strips any deployed pin via MANAGED_KEYS every deploy.

CUJ #2 (the B-CGHARD manual codegraph-enable soak dance) is **retired as of WS-B3**: `install.sh:529` MANAGED_KEYS now forces `codegraph.enabled`/`index_at_setup` to `true` on every deploy, and source `pickle_settings.json` ships the same default — codegraph is on by default on both fresh installs and upgrades, no manual deployed-settings edit required. `PICKLE_CODEGRAPH=off` remains the per-session escape hatch to disable it.
