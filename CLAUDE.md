# Pickle Rick for Claude Code

PRD → Breakdown → Research → Plan → Implement → Verify → Review → Simplify.

## 🐶 Dogfood by default — fix Pickle Rick by RUNNING Pickle Rick

The pipeline is the product: it fixes its own bugs. **Default: author a PRD/ticket → `/pickle-pipeline` (or `/pickle-tmux`).** Hand-decomposing a PRD into tickets is planning (fine); hand-*building* the fix code is not. A bug we won't dogfood is one we don't trust the tool to survive — fix that.

**Hand-build is the NARROW R-PSRB exception, not a reflex.** It applies ONLY when a bundle edits the **salvage / completion-evidence / Done-flip path** (`mux-runner.ts` salvage/no-progress logic, `salvage-ticket.ts`, `reconcile-ticket-truth.ts`, `ticket-completion-evidence.ts`) — the deployed buggy runtime applies that logic to the worker building the fix and resets it. "Edits `mux-runner.ts`" is NOT the trigger; the *salvage path* is. Spawn-gate / routing / phase-exit / scope-fence / refinement / feature edits are pipeline-safe — the run executes DEPLOYED JS, not your source diff (lands only at `install.sh`). As of B-WSPU (beta.35) all tiers run the single synchronous re-spawn-resume lifecycle — the old `large → detached path` dodge is gone; a genuine salvage-path bundle is hand-built. Detail: `prds/CLAUDE.md` → "Self-modifying-recovery bundles".

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

## Source of Truth

Canonical → deployed (`bash install.sh` rsyncs, overwrites): `extension/src/*.ts` → `~/.claude/pickle-rick/extension/**/*.js` | `.claude/commands/*.md` → `~/.claude/commands/*.md` | `pickle_settings.json` + `persona.md` → `~/.claude/pickle-rick/`. **NEVER edit deployed files — edit source, run `bash install.sh`.**

## Generated Artifacts

`*.dot` + PRD `*.md` under `extension/` are generated (consumed by attractor) — do NOT commit; `*.dot` is gitignored. `extension/data/` — static JSON for the plumbus-frame-analyzer (e.g. `engine-injected-keys.json`): committed, edit source not the deployed copy.

## Build & Test — full gate

Run from `extension/` (the release gate; green before any tag):
```
cd extension && npm ci && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && bash scripts/audit-guarded-reset.sh && bash scripts/audit-un-terminalize-single-path.sh && npm run test:fast:budget && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive
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

`npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && bash scripts/audit-guarded-reset.sh && bash scripts/audit-un-terminalize-single-path.sh && npm run test:fast:budget && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`

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
| `worker_mcp_config_path` | `string \| null` | `null` | Subset MCP config for worker/manager subprocesses (e.g. read-only Linear; omit write servers). `null` = no MCP forwarding. |
| `worker_mcp_snapshot_servers` | `string[]` | `[]` | Server names from `worker_mcp_config_path` to snapshot at setup. `[]` = none. |
| `codegraph` | `object` | see notes | v2.0 Code Graph block (`resolveCodegraphSettings`, per-field fallback). **Opt-in / disabled by default** (de3c5959): `enabled` (`false`), `index_at_setup` (`false`), `staleness_max_age_minutes` 30 (min 1), `context_max_bytes` 8192 (clamp 1024–65536), `expose_mcp_to_workers` (`false`, C0-gated, separate future flip), timeouts `index_timeout_ms` 120000 (floor 5000) / `sync_timeout_ms` 30000 (floor 1000) / `query_timeout_ms` 5000 (floor 500). Kill-switch `PICKLE_CODEGRAPH=off`. |
| `hardening` | `object` | see notes | Runtime-recovery block (DISTINCT from `bmad_hardening`), all four fields resolved by the single `resolveHardeningSettings` in `services/pickle-utils.ts`. `silent_death_respawn_cap` 1 (0 disables), `failed_flip_suppression_cap` 2 (0 disables) — non-negative ints drawing down the persistent `state.recovery_attempts` ledger (survives relaunch/`--resume`). `breaker_recovery_grace_seconds` 30: grace window where a breaker-recovery spawn doesn't count as progress. `bounded_terminal_escape_cap` 3 (AC-A4): consecutive no-progress relaunches on the same In Progress ticket before the bounded escape forces it terminal. |
| `rate_limit` | `object` | see notes | B-RRH rate-limit park (`resolveRateLimitSettings`, `pickle-utils.ts`). `max_park_minutes` 360 (int floor 1) caps cumulative parked wall-clock per episode before `rate_limit_park_exhausted`. Absent/malformed → compiled default. |

## Environment Variables

Kill-switches are the literal lowercase `"off"` (any other value / absent = feature active) unless noted.

| Variable | Values | Effect |
|---|---|---|
| `PLUMBUS_GENERATIVE_AUDIT` | `off` | Bypasses Override 6 — no analyzer, no `## Generative Findings`; logs `generative_audit: skipped (kill-switch)` to `state.json.activity`. |
| `PICKLE_CODEGRAPH` | `off` | Makes `CodegraphService` inert (returns null, never loads `@colbymchenry/codegraph`) + skips setup-time index (`runCodegraphIndexAtSetup`); else `codegraph.enabled` governs. Reads `services/codegraph-service.ts`, `bin/setup.ts`. |
| `PICKLE_INSTALL_ROOT` | path (default `$HOME/.claude/pickle-rick`) | Deploy-prefix override for `install.sh` + deploy-lifecycle soak. |
| `RUN_EXPENSIVE_TESTS` | `1` | Gates `test:expensive` (deploy-lifecycle soak, release-gate full run). Explicit only; not in default `npm test`. |
| `SOAK_SECONDS` | int ≥1800 (default 1800) | deploy-lifecycle soak duration (`tests/integration/deploy-lifecycle-soak.test.js`). |
| `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` | int ms ≥60000 (default 600000) | Per-gate-phase cap for `test:fast`/`test:integration` in the worker lint gate (R-WTFT). Below floor clamps up; invalid → default. |
| `PICKLE_EXIT_DRAIN_FALLBACK_MS` | int ms (default 30000) | Fallback drain window for the manager `'exit'` event when the `'close'`-primary stdio drain never fires. Invalid/≤0/fractional → default. Resolver `resolveExitDrainFallbackMs` (`mux-runner.ts`). |
| `PICKLE_ORPHAN_REAP` | `off` | Makes the R-CXHANG setup-time orphaned-worker-proc reaper inert (no ps scan, no kills); otherwise setup bootstrap reaps worker procs whose owning session is provably dead (positive ownership + min-age required). Reads `src/bin/setup.ts` (`runSetupOrphanReap`) + `src/services/orphan-reaper.ts`. |

## Tune-Back CUJs

Two distinct journeys for tuning behavior back — they use different mechanisms, don't conflate them:

1. **Worker test-gate timeout (per-machine)**: `export PICKLE_WORKER_TEST_FAST_TIMEOUT_MS=<ms>` (floor 60000). Env-only — do NOT re-add `worker_test_gate_timeout_ms` to `pickle_settings.json`; the key is source-authoritative (B-SSAT) and `install.sh` strips any deployed pin via MANAGED_KEYS every deploy.
2. **Codegraph enable (B-CGHARD soak)**: edit the **deployed** `~/.claude/pickle-rick/pickle_settings.json` directly (`codegraph.enabled:true`, `index_at_setup:true`), and do NOT run `bash install.sh` again until the soak completes. `install.sh:529` MANAGED_KEYS force-resets both keys to `false` on every deploy, so a *source* flip never enables it — there is no env kill-switch's positive counterpart (`PICKLE_CODEGRAPH=off` only disables; there is no env-on) — and any mid-soak redeploy silently disables the feature again.
