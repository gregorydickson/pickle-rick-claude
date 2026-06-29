# Pickle Rick for Claude Code

PRD → Breakdown → Research → Plan → Implement → Verify → Review → Simplify.

## 🐶 Dogfood by default — fix Pickle Rick by RUNNING Pickle Rick

The pipeline is the product. If we can run it — and we can — it fixes its own bugs. **Default: author a PRD/ticket and run `/pickle-pipeline` (or `/pickle-tmux`).** Do NOT hand-write the fix code yourself; hand-decomposing a PRD into tickets is fine (that's planning), hand-*building* the implementation is not. A bug we won't dogfood is a bug we don't trust the tool to survive — fix that, don't route around it.

**Hand-build is a NARROW exception, not a reflex.** It applies ONLY to the **R-PSRB self-referential catch-22**: a bundle that edits the **salvage / completion-evidence / Done-flip path** (`mux-runner.ts` salvage/no-progress logic, `salvage-ticket.ts`, `reconcile-ticket-truth.ts`, `ticket-completion-evidence.ts`), because the deployed *buggy* runtime applies that same logic to the worker building the fix and resets it mid-flight. "Edits `mux-runner.ts`" is NOT the trigger — the *salvage path* is.

Before stamping "hand-build," check the two facts that usually dissolve the catch-22:
1. **The running pipeline executes the DEPLOYED compiled JS, not your source diff** — editing `extension/src/**` has zero mid-run effect; the change only lands at the closer's `install.sh`. So a worker cannot be corrupted by its own diff.
2. **Only the salvage/completion path self-references.** Spawn-gate, routing, phase-exit, scope-fence, refinement, and feature edits are pipeline-safe.
3. **Tier the load-bearing ticket to dodge the deployed bug** when the bug is tier-specific (e.g. pin `complexity_tier: large` so it rides a working path instead of the broken one). That often removes the only residual self-reference.

Build protocol detail: `prds/CLAUDE.md` → "Self-modifying-recovery bundles (R-PSRB build protocol)".

## ⛔ Worker Forbidden Ops (R-WSRC)

Meta-tool: workers run inside the runtime they're modifying. Runtime hooks enforce these; prose alone failed (`send-to-morty.md` NEVER rule was violated by R-QGSK-3 incident 2026-05-16).

| Forbidden write | Override flag | Runtime check |
|---|---|---|
| `state.json` / `state.json.tmp.*` | `allow_state_writes_reason` (schema migration only) | `state-manager.ts` ceiling + `config-protection.ts` hook |
| `LATEST_SCHEMA_VERSION` bump | schema-migration ticket + `_internalSchemaBump` flag | `state-manager.ts` + `install.sh` AC-RVN-08 |
| `pickle_settings.json` / `.tmp.*` | `allow_settings_writes_reason` | `config-protection.ts` hook |
| `circuit_breaker.json`, `pipeline-status.json` / `.tmp.*` | none | `config-protection.ts` hook |
| tsc errors at commit time | `allow_tsc_failed_reason` (manager-only) | `tsc-gate.ts` hook |
| `bash install.sh` from worker | none | bash-scanner |
| `~/.claude/pickle-rick/**` | none | `config-protection.ts` hook |
| Test `claude --add-dir <real-repo>` | none | `backend-spawn.ts` `PICKLE_TEST_MODE` + `audit-test-add-dir-containment.sh` |
| Other ticket's dir | none | `check-scope-diff.ts` preflight |
| `spawnSync`/`spawn` no `timeout` | per-callsite | Per-file trap doors |
| Orchestrator tokens (`EPIC_COMPLETED`, etc.) | none — workers emit only `<promise>I AM DONE</promise>` | `promise-tokens.ts` scrubber |

PRD: `prds/p1-worker-source-state-recursion-contamination.md`.
Closer manager handoff runbook: `docs/closer-ticket-manager-handoff.md` for manager-owned closer residuals after `closer_handoff_terminal` or `manager_handoff_pending`.

## Documentation Rule

When adding, removing, or modifying commands (`.claude/commands/*.md`), update `README.md`. Docs drift = bugs.

## Source of Truth

Canonical → Deployed (`bash install.sh` rsyncs, overwrites):
`extension/src/*.ts` → `~/.claude/pickle-rick/extension/**/*.js` | `.claude/commands/*.md` → `~/.claude/commands/*.md` | `pickle_settings.json` + `persona.md` → `~/.claude/pickle-rick/`

NEVER edit deployed files. Edit source, run `bash install.sh`.

## Generated Artifacts

DOT pipeline files (`*.dot`) and PRD files (`*.md` in `extension/`) are generated artifacts — do NOT commit them to this repo. They are consumed by the attractor server, not by this project. Add `*.dot` to `.gitignore`.
`extension/data/` — static JSON consumed by the plumbus-frame-analyzer (e.g., `engine-injected-keys.json`). Committed, not generated — edit source, not the deployed copy.

## Build & Test

cd extension && npm ci && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && bash scripts/audit-guarded-reset.sh && bash scripts/audit-design-ground-truth.sh && bash scripts/audit-un-terminalize-single-path.sh && npm run test:fast:budget && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive
Tests: `extension/tests/*.test.js` via `node --test`. No `.test.ts` files.
Auxiliary npm scripts: `coverage` (c8 fast-tier baseline), `coverage:delta` (regression check via `scripts/coverage-delta.sh`), `wire-check` (gate parity via `scripts/check-wired.sh`).

## Required Patterns

CLI guard: `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`
Hook decisions: `"approve"` or `"block"` only (never `"allow"`)
Error handling: `const msg = err instanceof Error ? err.message : String(err);`
Extension path: `~/.claude/pickle-rick` (never `.gemini`)

## Versioning

Semver `<Major>.<Minor>.<Patch>` in `extension/package.json`:
**Major** = breaking (state schema, CLI args, hook contracts) | **Minor** = features (commands, flags, prompts) | **Patch** = fixes, refactors
Bump → commit `chore: bump version to X.Y.Z` → `gh release create vX.Y.Z`
Before creating a release, run the full lint and test gate from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && bash scripts/audit-guarded-reset.sh && bash scripts/audit-design-ground-truth.sh && bash scripts/audit-un-terminalize-single-path.sh && npm run test:fast:budget && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. Test failures block release, no exceptions.
**All uncommitted changes MUST be committed and included before tagging a release.** No dirty working tree at release time — `git status` must be clean, compiled JS must match TS source.

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
| meeseeks.md | Setup + per-pass review template |

## Settings (pickle_settings.json)

Operator-configured fields in the source `pickle_settings.json` (deployed via `bash install.sh`).

| Field | Type | Default | Description |
|---|---|---|---|
| `worker_mcp_config_path` | `string \| null` | `null` | Path to an operator-curated subset MCP config for worker/manager subprocesses (e.g. read-only Linear; omit write-capable servers). `null` = no MCP forwarding. |
| `worker_mcp_snapshot_servers` | `string[]` | `[]` | Server names (from `worker_mcp_config_path`) to snapshot at session setup time. Empty = none snapshotted. |
| `codegraph` | `object` | see notes | v2.0 Code Graph integration block (resolved by `resolveCodegraphSettings`; per-field fallback). **Opt-in / disabled by default (de3c5959):** `enabled` (`false`), `index_at_setup` (`false`), `staleness_max_age_minutes` (`30`, min 1), `context_max_bytes` (`8192`, clamp 1024–65536), `expose_mcp_to_workers` (`false` — gated on the C0 handshake; separate future flip), and the SPLIT timeouts `index_timeout_ms` (`120000`, floor 5000) / `sync_timeout_ms` (`30000`, floor 1000) / `query_timeout_ms` (`5000`, floor 500). Kill-switch: `PICKLE_CODEGRAPH=off`. |
| `hardening` | `object` | see notes | Additive runtime-recovery block (DISTINCT from `bmad_hardening`; resolved by `resolveHardeningSettings`). `silent_death_respawn_cap` (`1`; `0` disables silent-death respawns) and `failed_flip_suppression_cap` (`2`; `0` disables evidence-backed Failed-flip suppression). Non-negative integers; both draw down the persistent `state.recovery_attempts` ledger so caps survive relaunch / `setup.js --resume`. A third `hardening.`-namespaced field, `breaker_recovery_grace_seconds` (`30`), is resolved separately by `resolveBreakerRecoveryGraceSeconds` in `mux-runner.ts` (NOT `resolveHardeningSettings` / the `HardeningSettings` interface): the grace window during which a spawn inside breaker-recovery does not count as progress. |
| `rate_limit` | `object` | see notes | B-RRH Workstream B rate-limit park controls (resolved by `resolveRateLimitSettings` in `pickle-utils.ts`). `max_park_minutes` (`360`; integer floor 1) caps cumulative parked wall-clock per rate-limit episode before `rate_limit_park_exhausted`. Absent/partial/malformed falls back to the compiled default. |

## Environment Variables

| Variable | Values | Effect |
|---|---|---|
| `PLUMBUS_GENERATIVE_AUDIT` | `"off"` | Kill-switch: bypasses Override 6 entirely — no analyzer invocation, no `## Generative Findings` written, logs `"generative_audit: skipped (kill-switch)"` to `state.json.activity` |
| `PICKLE_SIGF` | `"off"` or `"advisory"` | Kill-switch for the signature-caller-gap blocking gate (R-SIGF). `off` or `advisory` (lowercase literal) demotes the finding from `signature_caller_gap` (blocking) to `advisory` (informational, exit 0). Any other value / absent keeps the gate active. Reads: `bin/check-readiness.ts` (`findSignatureChangeCallerGapFindings`). |
| `PICKLE_CODEGRAPH` | `"off"` | Kill-switch for the v2.0 Code Graph integration: `off` makes `CodegraphService` inert (every call returns null, emits nothing, never loads the native `@colbymchenry/codegraph` bundle) AND skips the setup-time index (`runCodegraphIndexAtSetup`). Only the literal lowercase `off` disables; any other value / absent leaves the `codegraph.enabled` setting in control. Reads: `services/codegraph-service.ts`, `bin/setup.ts` |
| `PICKLE_CITADEL_MECHANICAL` | `"off"` | Kill-switch for the T40 mechanical remediation floor in `executeCitadelPhase`: `off` reverts the citadel phase to the legacy Critical/threshold-only remediation set, skipping the additive mechanical union (deterministically-fixable sub-threshold findings). Only the literal lowercase `off` disables; any other value / absent keeps the union active. Distinct from the operator bypass on the unified `state.flags.skip_quality_gates_reason` surface (which also collapses the floor but emits a `gate_skipped` event). Reads: `src/bin/pipeline-runner.ts`. |
| `PICKLE_INSTALL_ROOT` | path (default `$HOME/.claude/pickle-rick`) | Override deploy prefix for `install.sh` and deploy-lifecycle soak test |
| `RUN_EXPENSIVE_TESTS` | `"1"` | Gates the `test:expensive` tier (deploy-lifecycle soak, release-gate full run). Must be set explicitly; not included in default `npm test` |
| `SOAK_SECONDS` | integer ≥ 1800 (default `1800`) | Duration for deploy-lifecycle soak test in `tests/integration/deploy-lifecycle-soak.test.js` |
| `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` | integer ms ≥ 60000 (default `600000` = 10 min) | Per-gate-phase cap for `npm run test:fast` / `test:integration` inside the worker lint gate (R-WTFT). Strict positive integer parse; values below the 60_000 ms floor clamp up; invalid values fall back to the default. Use to tune per-machine without redeploy when the fast suite legitimately exceeds 10 min on slow hardware. |
| `PICKLE_RECOVERY_CONSOLIDATION` | `"off"` | Kill-switch: reverts the bundle-bootstrap exemption to legacy per-gate dual-write and disables the AC-shape unified-flag fold-in (`spawn-refinement-team.ts`). Default (unset / any other value) keeps the single-surface consolidated behavior active. Reads: `src/services/backend-spawn.ts`, `src/bin/mux-runner.ts`, `src/bin/spawn-morty.ts`, `src/bin/spawn-refinement-team.ts`. |
| `PICKLE_LARGE_TIER_DETACHED` | `"off"` | Kill-switch for the B-WPEX-AUTO large-tier detached-worker autonomous lifecycle (R-WPEX #108). Default (unset / any other value) spawns large-tier workers DETACHED (survive the 600s Bash-tool ceiling) and re-attaches via the poll loop; the orchestrator owns `state.detached_worker`. Only the literal lowercase `off` reverts to the legacy synchronous `routeLargeTierTicket` punt. Resolver: `largeTierDetachedEnabled` (`src/bin/mux-runner.ts`). |
| `PICKLE_EXIT_DRAIN_FALLBACK_MS` | integer ms (default `30000`) | Per-iteration fallback drain window for the manager subprocess `'exit'` event when the `'close'`-primary stdio drain never fires (e.g. a never-closing pipe). Strict positive integer; zero / negative / fractional / non-numeric falls back to the compiled `EXIT_DRAIN_FALLBACK_MS` default (30_000). Resolver: `resolveExitDrainFallbackMs` (`src/bin/mux-runner.ts`). |
| `PICKLE_LARGE_TIER_DETACHED_WORKER` | `"1"` (INTERNAL) | Internal marker (NOT operator-facing) set by mux-runner's detached large-tier `workerEnv`; identifies the large-tier-detached worker to its `spawn-morty.js` consumer. Consumed by `shouldForceDetachForLargeTier` (`src/services/backend-spawn.ts`): when `=== '1'`, spawn-morty keeps the large-tier claude grandchild in spawn-morty's OWN (already session-scoped) process group — `detached:false`, INHERITING the group, NOT leading its own — so the orchestrator's single `process.kill(-spawn_morty_pid)` timeout reap reaches the whole subtree (H2 fix aee2767b). Reads: `src/services/backend-spawn.ts`, `src/bin/spawn-morty.ts`, `src/bin/mux-runner.ts`. |
