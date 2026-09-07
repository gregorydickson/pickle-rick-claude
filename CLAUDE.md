# Pickle Rick for Claude Code

PRD → Breakdown → Research → Plan → Implement → Verify → Review → Simplify.

## 🧭 PRIME DIRECTIVE (operator-set, BINDING, governs everything below)

**If a pipeline exits, it takes reliability AND quality and all other metrics to zero.**

**Autonomous execution must never be sacrificed.**

**We achieve reliability first, then slowly work quality up on top of it.**

**Complexity is the source of brittleness.**

Everything below elaborates this. Nothing below overrides it.

## 🧱 COMPLEXITY IS THE SOURCE OF BRITTLENESS (operator-set, BINDING, elaborates the PRIME DIRECTIVE)

Every halt, fake-green and silent bypass this codebase has shipped traces back to a structure with
**more cases than it needed**. Reliability is not bought by adding a guard; it is bought by removing the
distinction the guard was compensating for. This does NOT reorder the ratchet — reliability still comes
first. It says how you GET it: by subtraction.

**An ENUMERATED SET is a liability with a maintenance schedule.** A hand-maintained list of cases is
correct only until the world adds one, and it fails **silently**, because a missing member looks exactly
like a member that does not apply.

1. **Prefer the formulation that needs no list.** If a fix adds a member to an enumeration, ask what
   formulation would need none. Adding the 8th member schedules the 9th bypass.
2. **Collapse cases; do not add them.** Fewer states, fewer ways to be wrong.
3. **A hand-maintained catalog rots, and rots green.** An audit that checks a reference RESOLVES has not
   checked that the invariant names a LIVE symbol.
4. **Subtraction is the preferred fix.** "Necessary?" is the first Simplification Review question — a fix
   that removes a divergence beats one that guards it.
5. **Complexity has a price and it is paid back IN-BUNDLE.** Growth against the 50-line function limit is
   acceptable; **unrepaid growth is not.**

**The metric is not lines — it is how many distinct states a reader must hold to know the system is
correct.** Code that ADDS lines while removing ambiguity (an evidence test, a negative control, a typed
degrade reason) is subtraction in the sense that matters.
## 🔁 THE SYSTEM IS AUTONOMOUS CONTINUOUS LOOPS (operator-set, BINDING, elaborates the PRIME DIRECTIVE)

**Iterations do not need to be correct. The loop is the correctness mechanism.** An imperfect iteration
that keeps running is self-correcting — the next pass sees the result and adjusts. Convergence comes
from ITERATION COUNT, not from per-iteration precision. (anatomy-park: `pass_counts: 8`,
`consecutive_clean: 0`, then a clean pass and convergence. 423 commits out of many imperfect passes.)

**The cost asymmetry is total.** A wrong iteration costs ONE iteration. A verdict that stops the loop
costs the ENTIRE run — a halted run produces no output, and no output has no quality, so a stopping
"quality gate" takes reliability AND quality to zero. It is anti-quality, not careful.

**Ratchet order — sequential, not a dial:** (1) **reliability/autonomy first** — the bar is that the
system COMPLETES hands-off runs; a correct-but-halted run is a failure and an imperfect-but-completed
run is a success. (2) **quality second**, ratcheted on top of a system that already completes.

### The first question on any finding: would the NEXT ITERATION have fixed this?

If yes — **add nothing.** No guard, no classifier, no disposition, no halt. Record it and move on. Only
a defect that **prevents the next iteration from happening**, or that makes the loop **converge on a
false answer**, earns code.

- **A guard per finding is how the verdict layer grew +31% LOC and +41% classifiers in nine weeks while
  build failures stayed at ZERO.** The loop was never the problem.
- **Precision that costs a spawn, a timeout, or an external dependency is worse than an approximation
  the loop already holds.** (szechuan spawns an LLM to compute a number its own ledger defines.)
- **"Is this right?" is usually the wrong question. "Did the loop advance?" is the right one.**
- **A claim is a measurement or it is a hypothesis.** Before asserting a cause, count, regression window
  or "this is stale/fixed/broken", name the observation that would FALSIFY it and take it — otherwise
  say hypothesis. A string is not a measurement (a log line, commit message or disposition may assert a
  cause its producer never observed — read the branch that emits it). An absent or green result is not
  one either (a grep that matched a fixture, a tier that ran zero files, an audit over an empty set all
  read as agreement). Rate and trend claims need two points. Re-derive inherited premises before acting.

### What a gate MAY and MAY NEVER do

**MAY:** refuse a LOCAL action (don't flip THIS ticket Done, don't ship THIS commit), stamp an
`exit_reason`, log a residual for a human. The run **parks the item, flags it, and CONTINUES** —
output-with-flags ≫ no-output.
**MAY NEVER:** break the phase loop or terminate the pipeline.

**Continuing is NOT claiming success.** *Ran to completion* and *reported success* are different facts;
conflating them is fake-green, this codebase's most frequent failure mode. A degraded run executes every
phase, reports the degradation honestly, and **withholds the success verdict** (no auto-release).
**Honesty is a REPORTING property, halting is a DISPOSITION — not the same wire.**

**Halting is reserved for the genuine crash floor** — cannot-physically-continue only (unreadable/
unwritable state, missing `start_commit`, `state_schema_version_ahead`, `state_working_dir_missing`,
toolchain unavailable, budget/iteration cap, operator cancel, explicit `--strict-phases`). A
*measurement* or *quality* verdict is never a floor. **Do not add abort conditions.**
## 🐶 Dogfood by default — fix Pickle Rick by RUNNING Pickle Rick

The pipeline is the product: it fixes its own bugs. **Default: author a PRD/ticket → `/pickle-pipeline` (or `/pickle-tmux`).** Hand-decomposing a PRD into tickets is planning (fine); hand-*building* the fix code is not. A bug we won't dogfood is one we don't trust the tool to survive — fix that.

## 🚫 NEVER hand-build. ALWAYS run a pipeline. (operator-set, BINDING, no exceptions)

Every code fix in this repo is built by `/pickle-pipeline` (or `/pickle-tmux`). No exception for the
salvage path, the completion-evidence path, the Done-flip path, or "just this once because it's
load-bearing." A bundle we refuse to dogfood is a bundle whose fix we cannot claim the tool survives.

**Source and the deployed runtime are ISOLATED.** Workers edit source; the pipeline executes deployed
JS; a source diff lands only at `install.sh`. So a worker editing `mux-runner.ts` cannot change the
runtime executing it, and **a defect in the deployed build affects EVERY bundle identically** — the one
fixing it and the one fixing something unrelated alike. There is no self-modifying-bundle category.
**Posture is never chosen by subject matter**; all bundles run the same way.

## 📐 COMPOSE HUGE BUNDLES — the review phases are a FIXED toll (operator-set, BINDING for dispatch)

**Dozens of tickets per bundle. A 5-ticket bundle is a MINIMUM, not a target.**

`PICKLE` is linear at ~22–25 min/ticket. `ANATOMY-PARK` + `SZECHUAN-SAUCE` are a near-fixed ~300-minute
toll: they review the accumulated diff **by SUBSYSTEM, not per ticket**. So a 2-ticket bundle spends
~85% of its wall clock on review overhead against ~60% for an 8-ticket one, and the toll is paid per
BUNDLE. Draining 20 findings costs almost what draining 4 costs. There is **no ticket-count ceiling**.

- **Compose by SHARED FILE / SUBSYSTEM SURFACE, not by priority tier.** The toll scales with subsystem
  COUNT; same-surface tickets ride one review free. Priority orders the queue; surface composes it.
- **Never split or reorder a bundle to de-risk a deployed-runtime defect.** Source and the deployed
  runtime are isolated, so a known defect hits every bundle equally and no roster shape changes it —
  and a fix is live only after `install.sh`, not when its commit lands. Deploy the fix, or know the
  recovery.
- **Composing a possibly-stale row is CHEAP.** If a premise proves already-fixed, declare
  `zero_diff_intent: already-satisfied` in frontmatter up front and close on evidence. Never shrink a
  bundle to avoid stale rows — that buys another ~300-minute toll.
- **Mixing fixes with new functionality is SOUND** — per-ticket commits keep structural/behavioural
  separation where it belongs.
- **Watch `iteration`, not roster size.** Iteration count is the risk predictor; raise the pickle
  iteration cap when composing large.

Standing vehicle: `prds/p1-b-megadrain-forty-open-items-by-root.md` — compose INTO it by root.
Measured per-session durations: `prds/MASTER_PLAN.md` → "BUNDLE SIZING".

## 🗓 RELEASE CADENCE — ship every FEW DAYS, not every bundle (operator-set, BINDING)

**A completed bundle is NOT a reason to release.** Bundles accumulate on the branch and ship together
every couple of days. Not releasing after a green bundle is the NORMAL state — never report it as a
blocker or a pending decision.

Measured tax: gate ~34 min + a properly-run soak ~30 min + bump/deploy/push/tag/verify ~5–10 min ≈
**70 min blocking**, plus ~70 min CI on the tag. Paid per RELEASE, not per bundle.

1. **Default: do not release.** Land the bundle, push the branch, keep draining. Release when several
   bundles have accumulated, a fix must reach users, or the operator asks.
2. **The soak is NOT optional at release time.** It provisions its own sandbox root (a private
   `HOME`, install prefix and data root under `os.tmpdir()`) and no longer reads
   `PICKLE_INSTALL_ROOT` — so there is nothing for the operator to export, and nothing of the real
   `~/.claude` is touched. Once `RUN_EXPENSIVE_TESTS=1` is set, a refusal THROWS with a
   `SOAK_UNRUN:` prefix instead of skipping, so an unrun leg reds the tier rather than reporting
   `ok ... # SKIP`. **Wall-clock is the oracle: a 16-second pass is not an 1800s soak** — check the
   reported duration against `SOAK_SECONDS`, and `grep SOAK_UNRUN` for a complete audit of refusals.
   Never report an unrun leg as green.
3. **A degraded run still does not auto-release** (see B-NOSTOP-GATES). Cadence does not relax honesty.
4. **Batching releases ≠ batching the GATE.** Keep the branch green per bundle; spend the release
   ritual only when shipping.

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

PRD: `prds/archive/bundles/p1-worker-source-state-recursion-contamination.md`. Closer manager-handoff runbook: `docs/closer-ticket-manager-handoff.md` (manager-owned residuals after `closer_handoff_terminal`, or a parked Manager Handoff residual — no longer a halting `exit_reason`).

## Documentation Rule

Adding/removing/modifying commands (`.claude/commands/*.md`) → update `README.md`. Docs drift = bugs.

**`CLAUDE.md` carries CURRENT INSTRUCTIONS, token-efficient — never history.** It loads every session.
The measurement or incident that produced a rule belongs in `prds/MASTER_PLAN.md`; only the rule lands
here. No "used to claim", no "RETRACTED", no dated correction narrative.

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

## 🚫 NO PULL REQUESTS (operator-set 2026-09-06, BINDING)

**This repo does not use PRs.** The v2.1 line ships by TAG from `release/v2.1-beta` —
`gh release create vX.Y.Z --target "$(git rev-parse HEAD)"`. Work lands as commits pushed straight to
the release branch. **Never run `gh pr create`**, and never invoke `services/pr-factory.ts` (no
production caller; queued for deletion).

**Why this is a hard rule and not a preference:** `gh pr create` with no `--base` targets the repository
DEFAULT branch. `main` is the stale 2.0 line — 1530 commits behind `release/v2.1-beta` and 57 ahead on
its own — so such a PR is unmergeable and merging it would be destructive. This is the same defect class
as [[B-RELTAG]] (`gh release create` with no `--target` tagged `main` for four months). **Any `git`/`gh`
command that can default to the repository default branch MUST name its target explicitly.**

## Source of Truth

Canonical → deployed (`bash install.sh` rsyncs, overwrites): `extension/src/*.ts` → `~/.claude/pickle-rick/extension/**/*.js` | `.claude/commands/*.md` → `~/.claude/commands/*.md` | `pickle_settings.json` + `persona.md` → `~/.claude/pickle-rick/`. **NEVER edit deployed files — edit source, run `bash install.sh`.**

## Generated Artifacts

`*.dot` + PRD `*.md` under `extension/` are generated (consumed by attractor) — do NOT commit; `*.dot` is gitignored. `extension/data/` — static JSON for the plumbus-frame-analyzer (e.g. `engine-injected-keys.json`): committed, edit source not the deployed copy.

## Build & Test — full gate

Run from `extension/` (the release gate; green before any tag):
```
cd extension && npm ci && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && bash scripts/audit-guarded-reset.sh && bash scripts/audit-un-terminalize-single-path.sh && bash scripts/audit-did-we-count.sh && npm run test:fast:budget && npm run test:integration && npm run test:contract && RUN_EXPENSIVE_TESTS=1 npm run test:expensive
```
Tests: `extension/tests/*.test.js` via `node --test` (no `.test.ts`). Aux scripts: `coverage` (c8 fast-tier baseline), `coverage:delta` (`scripts/coverage-delta.sh`), `wire-check` (gate parity, `scripts/check-wired.sh`).

**This chain proves correctness on the OS you ran it on — nothing more.** It is one of three axes; the Node 22 leg covers the runtime axis and `extension/scripts/ci-repro.sh` covers the OS axis. A green here is NOT sufficient to tag — see **Versioning → Before tagging** below for the required manual OS-axis run and its limits.

## Required Patterns

- CLI guard: `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`
- Hook decisions: `"approve"` / `"block"` only (never `"allow"`)
- Errors: `const msg = err instanceof Error ? err.message : String(err);`
- Extension path: `~/.claude/pickle-rick` (never `.gemini`)

## Versioning

Semver in `extension/package.json`: **Major** = breaking (state schema, CLI args, hook contracts) | **Minor** = features (commands, flags, prompts) | **Patch** = fixes/refactors. Bump → commit `chore: bump version to X.Y.Z` → release.

**⛔ TAG AT AN EXPLICIT COMMIT.** `gh release create <tag>` with no `--target` tags the repository's
**DEFAULT BRANCH** (`main`, the stale 2.0 line). Always
`gh release create vX.Y.Z --target "$(git rev-parse HEAD)"`, then verify mechanically with
`extension/scripts/verify-release-tag.sh vX.Y.Z "$(git rev-parse HEAD)"` — it exits non-zero on mismatch
or absence. `git ls-remote --tags` confirms EXISTENCE, not correctness.

**Before tagging**, the full release gate must be green from `extension/` (test failures block release,
no exceptions). This is the release-gate source of truth, mirrored by `.github/workflows/release.yml`
(enforced by `release-gate-parity.test.js`):

`npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && bash scripts/audit-guarded-reset.sh && bash scripts/audit-un-terminalize-single-path.sh && bash scripts/audit-did-we-count.sh && npm run test:fast:budget && npm run test:integration && npm run test:contract && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`

AND the tree must be clean (`git status` clean, compiled JS matches TS). No dirty release.

**⛔ THAT GATE COVERS ONE AXIS OF THREE. A green on one says nothing about the others.**

| Axis | Leg | Covers |
|---|---|---|
| Correctness, **authoring OS** | the `&&` chain above | types, lint, audits, all tiers — on that OS only |
| **Runtime** | `node-version: '22.x'` in `ci.yml`/`release.yml`, matching `engines.node` | the Node major CI runs |
| **OS** | `extension/scripts/ci-repro.sh` — **REQUIRED MANUAL step, deliberately NOT an `&&` link** | Linux, which no other leg reaches |

A locally-green gate cannot see a Linux-only red, so it is not on its own evidence that a tag is safe.
Run it against the sha you are about to tag (from the repo root):

```
bash extension/scripts/ci-repro.sh --ref "$(git rev-parse HEAD)" --cmd 'node bin/test-runner.js tests/<file>.test.js --test-concurrency=1'
```

**Honest limits — an overstated green is worse than no run:**
- **No docker → harness exits `2` → record the OS axis UNRUN** and let CI supply it. Never report an
  unrun leg as green. (It is unjoined from the `&&` chain for exactly this reason.)
- **Emulated on Apple silicon** (`--platform linux/amd64`): arch and node major match CI exactly, but
  wall-clock does not — **timing-sensitive reds under it are suspect**, and a whole tier will not finish
  in a normal budget. Drive **specific FILES** via `--cmd`, not tiers.
- **Only COMMITTED state at `--ref` is measured** — commit first.
- Exit codes: `0` pass · `1..` inner command failed · `2` harness refused · `3` UNTRUSTED (completed, but
  a provisioning gap makes the number inadmissible) · `90`/`91` preflight.
- **Trust a green only while the measured noise baseline is 0.** Re-measure it before relying on a green;
  a harness that is mostly noise falsifies nothing.
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
| `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` | int ms ≥60000 (default 600000) | Per-gate-phase budget for `test:fast`/`test:integration` in the worker lint gate (R-WTFT). Below floor clamps up; invalid → default. **No longer a wall-clock cap on the tier run itself (R-TIERWEDGE):** that wait is the STALL detector, not `timeoutMs` — the two modes are mutually exclusive in `runCommand` (`spawn-morty.ts:1449`), so a tier run that keeps emitting output is never killed by this value however long it takes. It bounds the tier wait only when it is SHORTER than `PICKLE_TIER_STALL_THRESHOLD_MS` (`Math.min(...)`, `spawn-morty.ts:1651`); raising it above 600000 does NOT widen tier hang detection — that knob is the next row. **Parent/child split (R-WGTORPH):** the variable governs the gate's own timeout in the PARENT — `resolveWorkerTestGateTimeoutMs` reads it in the launching process to size the spawn's `timeout` (`mux-runner.ts:638`, `spawn-morty.ts:2061`/`:2137`) — and is scrubbed from the gate child's view: it is the first member of `PICKLE_GATE_SCRUBBED_ENV_KEYS`, so `scrubGateEnv()` deletes it from the env handed to both test-gate spawns (`mux-runner.ts:649`, `spawn-morty.ts:1330`). A test running inside the gate therefore never observes it, however the operator exported it. |
| `PICKLE_TIER_STALL_THRESHOLD_MS` | int ms ≥60000 (default 600000) | R-TIERWEDGE stall window for a worker-gate tier run: the longest `npm run test:fast`/`test:integration` may emit NOTHING before `runCommand` SIGTERMs the process tree (SIGKILL 2s later) and reports `stalled: no output growth for <N>ms` with `ok: false, timedOut: true`. Every stdout/stderr chunk resets the clock, so slow-but-live never trips it. Env-only — no `pickle_settings.json` arm (B-SSAT MANAGED_KEYS strips such pins). Below floor clamps up; absent/blank/non-numeric/zero/negative/fractional → default. Resolver `resolveTierStallThresholdMs` (`services/pickle-utils.ts`). **This is the knob that widens tier hang detection**, independent of `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS` by design. |
| `PICKLE_EXIT_DRAIN_FALLBACK_MS` | int ms (default 30000) | Fallback drain window for the manager `'exit'` event when the `'close'`-primary stdio drain never fires. Invalid/≤0/fractional → default. Resolver `resolveExitDrainFallbackMs` (`mux-runner.ts`). |
| `PICKLE_ORPHAN_REAP` | `off` | Makes the R-CXHANG setup-time orphaned-worker-proc reaper inert (no ps scan, no kills); otherwise setup bootstrap reaps worker procs whose owning session is provably dead (positive ownership + min-age required). Reads `src/bin/setup.ts` (`runSetupOrphanReap`) + `src/services/orphan-reaper.ts`. |
| `PICKLE_WORKER_LOCK` | `off` | Makes the per-session worker-spawn lock inert (`acquireWorkerSpawnLock` returns `{ inert: true }` — no lock file touched, every acquisition succeeds immediately); otherwise a spawn that cannot take the lock within `WORKER_SPAWN_LOCK_TIMEOUT_MS` (30s) throws `WorkerSpawnLockContendedError`. Reads `src/bin/spawn-morty.ts` (`acquireWorkerSpawnLock` / `releaseWorkerSpawnLock`). |
| `PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN` | int > 0 (default 50) | B-APNC WS-1 ceiling on how many passes ONE anatomy-park subsystem may run **having never once passed clean** before the phase ends as `anatomy_non_convergent` (non-fatal — the pipeline continues to szechuan). **NOT a length limit and NOT the iteration cap**: `anatomy_max_iterations` is 500 (`pipeline-runner.ts:250`), and the predicate is `passes >= max && consecutive_clean[sub] === 0 && !hasRecordedCleanPass(sub)` (`microverse-runner.ts:5097`) — a subsystem that has EVER recorded a clean pass is exempt permanently, so this only fires on a subsystem making no clean progress at all. Counts PER-SUBSYSTEM passes, not pipeline iterations. Resolver `resolveApncMaxPassesWithoutClean` (`mux-runner.ts:271`); read once at `microverse-runner.ts:5140` from the launching env. Env-only (no `pickle_settings.json` arm — B-SSAT MANAGED_KEYS would strip such a pin) and NOT in `PICKLE_GATE_SCRUBBED_ENV_KEYS`, so it inherits normally. Absent/blank/non-numeric/zero/negative/fractional → default 50. |

## Tune-Back CUJs

1. **Worker test-gate timeout (per-machine)**: `export PICKLE_WORKER_TEST_FAST_TIMEOUT_MS=<ms>` (floor 60000). Env-only — do NOT re-add `worker_test_gate_timeout_ms` to `pickle_settings.json`; the key is source-authoritative (B-SSAT) and `install.sh` strips any deployed pin via MANAGED_KEYS every deploy. **This knob does NOT govern the tier run's hang detection** — see CUJ #3; raising it alone leaves the stall window at its own default.

CUJ #2 (the B-CGHARD manual codegraph-enable soak dance) is **retired as of WS-B3**: `install.sh:529` MANAGED_KEYS now forces `codegraph.enabled`/`index_at_setup` to `true` on every deploy, and source `pickle_settings.json` ships the same default — codegraph is on by default on both fresh installs and upgrades, no manual deployed-settings edit required. `PICKLE_CODEGRAPH=off` remains the per-session escape hatch to disable it.

3. **Tier-run hang detection (per-machine)**: `export PICKLE_TIER_STALL_THRESHOLD_MS=<ms>` (floor 60000, default 600000). This is the R-TIERWEDGE knob to raise on a slow machine where a legitimate `test:fast`/`test:integration` run goes quiet longer than 10 minutes between TAP lines. Env-only, same B-SSAT reason as CUJ #1. Independent of `PICKLE_WORKER_TEST_FAST_TIMEOUT_MS`, but the effective window is the MINIMUM of the two (`spawn-morty.ts:1651`), so a gate budget shorter than this value still wins.

4. **Anatomy-park no-clean-pass ceiling (per-machine)**: `export PICKLE_APNC_MAX_PASSES_WITHOUT_CLEAN=<int>` (default 50). Raise it further when a large bundle's review is finding REAL defects every pass and you want the loop to keep draining rather than report `anatomy_non_convergent` at 50. It does not touch `anatomy_max_iterations` (500), which remains the actual loop ceiling. **A raise cannot be applied retroactively** — the value is read when the phase runs, so a run already past anatomy-park is unaffected. Because `launch.sh` is regenerated per session and exports nothing, the export must live in the shell that launches the pipeline (profile, or inline on the launch command); a non-login tool shell will NOT pick up `~/.zshrc`.
