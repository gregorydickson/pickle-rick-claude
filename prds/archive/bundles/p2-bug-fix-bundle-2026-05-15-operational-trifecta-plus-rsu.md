---
title: "Bug-fix bundle 2026-05-15 — operational tax trifecta + R-RSU (refined)"
status: Draft
filed: 2026-05-15
refined: 2026-05-15
priority: P2
type: bug-bundle
composes:
  - prds/archive/bug-reports/p3-monitor-watcher-collapsed-layout-repair-gap.md
  - prds/archive/bug-reports/p3-worker-timeout-default-too-short-blocks-test-gate.md
  - prds/archive/bundles/p3-collapse-quality-gate-skip-flags.md
  - prds/archive/bug-reports/p2-pickle-refine-section-umbrella-granularity-bug.md
r_codes:
  - R-MWCL-1
  - R-MWCL-2
  - R-MWCL-3
  - R-MWCL-4
  - R-MWCL-5
  - R-MWCL-6
  - R-MWCL-7
  - R-WTB-1
  - R-WTB-2
  - R-WTB-3
  - R-WTB-4
  - R-QGSK-1
  - R-QGSK-2
  - R-QGSK-3
  - R-QGSK-4
  - R-QGSK-5
  - R-RSU-1
  - R-RSU-2
  - R-RSU-3
  - R-RSU-4
  - R-RSU-5
  - R-CLOSER-1
sister_prds: []
related:
  - prds/MASTER_PLAN.md
schema_version_bump: 4 -> 5
---

# Bundle PRD — Operational Tax Trifecta + R-RSU (refined)

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only
**Working dir**: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude`

*(refined: analysis_requirements.md, analysis_codebase.md, analysis_risk-scope.md)*

## Bundle rationale

This is a sanctioned multi-PRD bundle under the **2026-05-15 PM operator directive** (bug-fix-only sequence; defer features). It composes four open bug PRDs into a single pickle pipeline run:

1. **R-MWCL** (Finding #29) — `inferMonitorMode` falls through to `'pickle'` for `szechuan-sauce.md`/`anatomy-park.md` → monitor pane crashes on every microverse iter → operator-blind during autonomous runs.
2. **R-WTB** (Finding #34) — `TICKET_TIER_BUDGETS.medium.worker_timeout_seconds: 1200` (20m) is below the R-PTG worker lifecycle floor → workers killed mid-`npm run test:fast` → spurious failures + retry burn.
3. **R-QGSK** — Two separate skip-flag fields (`state.flags.skip_readiness_reason` + `state.flags.skip_ticket_audit_reason`) force operators to set both on every codex launch → friction tax.
4. **R-RSU** (Finding #30) — `spawn-refinement-team.ts` collapses `composes:` bundle PRDs into N section-umbrella tickets → wedge in `c122b0f7` (R-MMTR-6 80-min no-progress) + `ba01c135` (R-ICDM umbrella 67-min no-commit).

**Why one bundle**: the three P3 PRDs (R-MWCL/R-WTB/R-QGSK) are individually small but together remove three high-frequency operator-friction taxes that compound on every codex pipeline launch. R-RSU is P2 risk-reduction.

**Why this PRD body enumerates each R-code inline**: defense against R-RSU's own bug — the section-umbrella collapse it fixes. The R-RSU-1 idempotency clause (added in refinement) prevents this PRD from re-fanning-out to 44 tickets if refinement reruns on it.

## Assumptions

*(added: analysis_risk-scope.md — Specific Recommendations § assumption surfacing)*

1. `MonitorMode` at `extension/src/services/pickle-utils.ts:1613` includes `'refinement'` at HEAD; Contract 1 preserves it (six members total post-bundle).
2. `getTicketTierBudgetWithOverrides` exists at `extension/src/services/pickle-utils.ts:541-555` with precedence `state.flags.tier_cap_override > pickle_settings.tier_caps > compiled defaults`; R-WTB-2 only edits compiled values and codifies the existing precedence, never inverts it.
3. `composedPrdPaths` exists at `extension/src/bin/spawn-refinement-team.ts:1259-1271`; R-RSU-1 imports/reuses it, does not reimplement.
4. `state.flags.skip_*` are the existing field locations; the new `skip_quality_gates_reason` lives on the `Flags` interface (`extension/src/types/index.ts:165-188`), NOT `State` root.
5. `LATEST_SCHEMA_VERSION` bumps from 4 → 5 in this bundle (R-QGSK-3); concurrent migrations must use ≥6.
6. `pickle_settings.json` lives at repo root, NOT `extension/pickle_settings.json` (verified via `git ls-files`).
7. `composes:` is never nested at the time this bundle ships; recursive composes is explicit follow-up.
8. Migration is idempotent (project invariant).
9. The PRD does not re-trigger refinement on already-decomposed bundles (R-RSU-1 idempotency clause).

## Scope

### In-scope

- All 7 R-MWCL atomic tickets (monitor reliability)
- All 4 R-WTB atomic tickets (worker timeout default + per-tier overrides)
- All 5 R-QGSK atomic tickets (collapse skip flags + back-compat migration)
- All 5 R-RSU atomic tickets (composes fanout in refinement entrypoint)
- 1 closer ticket (version bump + parity check + MASTER_PLAN bookkeeping)
- 4 hardening tickets (code quality, data flow, test quality, cross-reference)

### Out of scope

- R-CSI Phase 1/Phase 2 (concurrent-session interference) — deferred 2026-05-15 PM
- R-CCDC (citadel detection coverage) — deferred (maybe-later)
- R-PIWG-3 worktree isolation — rejected (no worktrees in pickle runs)
- Adding `xlarge` tier to `VALID_TICKET_COMPLEXITY_TIERS` (separate schema migration, blocked by R-QGSK-3's bump)
- Refinement-watcher pane wiring changes (per `'refinement'` mode preservation)
- Removal of legacy `skip_readiness_reason` / `skip_ticket_audit_reason` (forward `R-QGSK-DEPRECATE-1` PRD, target `vX.Y+2.0`)

## Cross-cutting User Journeys (CUJ)

*(added: analysis_requirements.md — Specific Recommendations)*

### CUJ-1 — Operator diagnoses a monitor crash across all six monitor modes

1. Operator launches one of: `/pickle`, `/pickle-tmux`, `/pickle-refine-prd`, `/meeseeks`, `/council-of-ricks`, `/szechuan-sauce`, `/anatomy-park`.
2. The monitor pane (`'pickle' | 'refinement' | 'meeseeks' | 'council' | 'szechuan-sauce' | 'anatomy-park'` — six layout-selector modes at `pickle-utils.ts:1613` post-bundle) goes blank or shows an error mid-iteration.
3. Operator reads `${SESSION_ROOT}/monitor-stderr.log` (R-MWCL-4) and finds the thrown error verbatim, regardless of which mode crashed.
4. Operator restarts monitor via documented recovery step OR R-MWCL-3's watchdog auto-restores within `RESPAWN_WATCHDOG_INTERVAL_MS + 100ms` of the collapse being detected.

**Success**: operator never SSHes into tmux; stderr log is sufficient; recovery works in every monitor mode including `'refinement'` (the most-trafficked path today).

### CUJ-2 — Operator launches a codex pipeline with a single skip-flag

1. Operator sets `state.flags.skip_quality_gates_reason = "CI bypass"` (single unified flag).
2. Both the readiness gate AND the ticket-audit gate honor the bypass.
3. State files predating R-QGSK auto-migrate on next load via schema 4→5 migration; readiness value wins, ticket-audit value preserved at `state.flags.migrated_skip_ticket_audit_reason_archive`.
4. `mux-runner.log` shows a one-shot-per-process deprecation warning when a legacy field is still in play.

### CUJ-3 — Operator inspects a composed-bundle refinement output

1. Operator runs `/pickle-refine-prd` on a `composes:` bundle PRD.
2. Refinement spawns N≤8 decomposer Mortys, one per source PRD, in parallel.
3. Aggregator merges per-source ticket lists into a flat manifest; `manifest.bundle_shape === 'composed'`.
4. Operator runs `grep -c '^### R-' prd_refined.md` and expects N matches where N = sum of R-codes across source PRDs. If N matches `composes:` source count (1 per source), section-umbrella bug has reappeared — escalate.
5. If the same PRD already inline-enumerates `### R-XXX-N` sections matching its `r_codes:` frontmatter, detector returns `bundle_shape === 'flat'` and skips fanout (idempotency).

## Functional Requirements

### R-MWCL-1 — Infer monitor mode from `state.command_template` for every template

*(refined: analysis_requirements.md P0 #1, analysis_codebase.md P0 #1, analysis_risk-scope.md P0 #1)*

`extension/src/services/pickle-utils.ts::inferMonitorMode` at line 1646 currently switches on `meeseeks.md` and `council-of-ricks.md`, falling through to `'pickle'` for `szechuan-sauce.md`/`anatomy-park.md`. The `MonitorMode` union at line 1613 already carries six members: `'pickle' | 'meeseeks' | 'council' | 'refinement' | 'szechuan-sauce' | 'anatomy-park'` (existing five plus two new microverse arms — preserving `'refinement'`). Add switch arms for both microverse templates so `ensureMonitorWindow` spawns the correct render template at boot. New switch arms must also be added to `watcherPaneCommands` (`pickle-utils.ts:1743`), `watcherPaneTwoCommand` (`:1767`), and `monitorModesCompatible` (`:1989`).

**Acceptance**: a unit test for `inferMonitorMode` exhaustively asserts return values for the FULL `MonitorMode` union via `describe.each` over: `[['szechuan-sauce.md','szechuan-sauce'], ['anatomy-park.md','anatomy-park'], ['meeseeks.md','meeseeks'], ['council-of-ricks.md','council'], ['refinement.md','refinement'], [undefined,'pickle'], ['unknown-template.md','pickle']]`. Universal-quantifier shape; one ticket; no split.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/services/pickle-utils.ts` (+ tests), and the four downstream callers above.

### R-MWCL-2 — Extend `inferModeFromStep` to recognize microverse step values

*(refined: analysis_requirements.md P0 #3, analysis_codebase.md Cross-Reference, analysis_risk-scope.md P0 #2)*

R-MDS-3 already wires `checkAndSwapMode(sessionDir, mode)` at `extension/src/bin/monitor.ts:901` and `inferModeFromStep` at `:211`. The PRD's original "render mode-mismatch guard" is REDUNDANT. The actual delta: extend `inferModeFromStep` to map step `'anatomy-park'` and step `'szechuan-sauce'` to those modes (currently both fall through to `'pickle'` per the R-MDS-3 invariant in `extension/src/bin/CLAUDE.md`). The existing `checkAndSwapMode` call at the top of `render` already handles the swap once `inferModeFromStep` returns the right mode — no new top-of-`render` guard.

**Acceptance**: `inferModeFromStep('anatomy-park') === 'anatomy-park'` AND `inferModeFromStep('szechuan-sauce') === 'szechuan-sauce'` (currently both fall through to `'pickle'`). `checkAndSwapMode` returns the swapped mode when `state.step` carries a microverse phase. The existing `'pickle'` fallback for unrecognized step values remains.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/bin/monitor.ts:211-225` (+ tests).

### R-MWCL-3 — `restartDeadWatcherPanes` collapsed-layout fallback

*(refined: analysis_codebase.md P1 R-MWCL-3, analysis_risk-scope.md R3)*

`extension/src/services/pickle-utils.ts::restartDeadWatcherPanes` at lines 1683-1700, in the `currentCommand === null` branch, logs+continues. Replace with a `tmux split-window` fallback that recreates the missing pane in-place when the layout has collapsed. The fallback MUST enter through the shared serialized `withPath` path (per R-TSPF-4 trap door in `extension/CLAUDE.md`) — call `withSerializedPath` to avoid the PATH-env race already gating `ensureMonitorWindow` tests.

**Acceptance**: an integration test injects a collapsed 1x2 layout (panes dead) and asserts `restartDeadWatcherPanes` restores 2x2 within `RESPAWN_WATCHDOG_INTERVAL_MS + 100ms` of the collapse being detected (measurable, not "one tick"). Test runs through `withSerializedPath` so parallel-execution flakiness is impossible.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/services/pickle-utils.ts:1683-1700` (+ tests).

### R-MWCL-4 — Capture monitor stderr to a session-local rotated log

*(refined: analysis_requirements.md P1 R-MWCL-4, analysis_codebase.md P1 R-MWCL-4, analysis_risk-scope.md P1)*

Add `${SESSION_ROOT}/monitor-stderr.log` capture so operators can diagnose monitor crashes post-mortem. Highest-value-first diagnostic — ship even if behavioral fixes (R-MWCL-1..3) are deferred. Stderr capture works for ALL values of `MonitorMode` including `'refinement'` (most-trafficked path today). 64 KB ring-buffer, append-mode, header line `[monitor-stderr] session=<hash> pid=<pid> ts=<ISO>` on first write per process. When the cap is hit, emit a `monitor_stderr_rotated` activity event for operator visibility.

**Acceptance**: a unit test asserts that a thrown error inside `render` is written verbatim to `monitor-stderr.log` within the session dir for every mode including `'refinement'`. Size cap test: write >64 KB, assert the ring buffer rotates and the activity event fires.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/bin/monitor.ts` (+ tests).

### R-MWCL-5 — Watchdog initial tick fires on first interval, not after first interval

*(refined: analysis_codebase.md P0 #5, analysis_requirements.md P1 R-MWCL-5)*

`monitor.ts::startRespawnWatchdog` at lines 777-798 currently waits `RESPAWN_WATCHDOG_INTERVAL_MS = 30_000` ms (NOT 2000 ms — the PRD-original 2-second figure was factually wrong by 15×) before its first tick. Invoke `restartDeadWatcherPanes(sessionDir, extensionRoot, mode, spawnSync, 'monitor-watchdog')` synchronously inside the function body BEFORE scheduling `setInterval(..., RESPAWN_WATCHDOG_INTERVAL_MS=30_000)`. The immediate-fire path MUST NOT block; the interval timer starts at registration time, not after the first tick completes. The R-MWR-1 trap-door PATTERN_SHAPE in `extension/CLAUDE.md` must be updated in the same commit OR `bash extension/scripts/audit-trap-door-enforcement.sh` exits non-zero.

**Acceptance**: a unit test in `extension/tests/monitor-watchdog.test.js` asserts `monitor-watchdog: respawned ...` log within 100 ms of `startRespawnWatchdog` returning, then a second log after `RESPAWN_WATCHDOG_INTERVAL_MS` ms (mockable via fake timers).

**Verify**: `cd extension && npm run test:fast` exits 0; `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0.

**Files**: `extension/src/bin/monitor.ts:777-798`, `extension/CLAUDE.md` (R-MWR-1 trap door wording).

### R-MWCL-6 — Regression test for R-MWCL-1..5

*(refined: analysis_requirements.md P1, analysis_risk-scope.md R7)*

A new test file `extension/tests/monitor-mode-resilience.test.js` (forward-created per R-RTRC-7) exercises all five R-MWCL fixes end-to-end (mode inference + extended step inference + split-window fallback + stderr capture + first-tick watchdog). Per-mode assertions for all six `MonitorMode` members so the R-MDS-3 invariant remains visible.

**Acceptance**: `cd extension && npm run test:fast` exits 0; the new test file appears in `extension/tests/` and is picked up by the fast tier. Test runs N specific assertions for the 6 modes (`pickle`, `meeseeks`, `council`, `refinement`, `szechuan-sauce`, `anatomy-park`).

**Files**: `extension/tests/monitor-mode-resilience.test.js` (new).

### R-MWCL-7 — Trap-door entry pinning `inferMonitorMode` shape

*(refined: analysis_codebase.md P1 R-MWCL-7)*

Pin the R-MWCL-1 mode-inference shape (must handle all 6 template kinds: pickle / meeseeks / council / refinement / szechuan-sauce / anatomy-park) as an ENFORCE entry in `extension/src/services/CLAUDE.md` (the layout-selector union — the render-mode union at `monitor.ts:204` is already pinned via R-MDS-3). Verified by `bash extension/scripts/audit-trap-door-enforcement.sh`.

**Acceptance**: `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0; the new ENFORCE entry is counted in its summary.

**Files**: `extension/src/services/CLAUDE.md`.

### R-WTB-1 — Raise medium-tier worker-timeout default from 1200 to 2400

*(refined: analysis_codebase.md P0 #3, analysis_risk-scope.md Cross-Reference)*

There is **no** single `Defaults.WORKER_TIMEOUT_SECONDS` constant. The worker-timeout default lives in `TICKET_TIER_BUDGETS.medium.worker_timeout_seconds` at `extension/src/services/pickle-utils.ts:444` (currently `20 * 60 = 1200`). The ticketless fallback path is `getTicketTierBudget(undefined)` → `getTicketTierBudgetWithOverrides(null, undefined, null)` (`pickle-utils.ts:559-563`), which normalizes to tier `'medium'`. Bump that value to `40 * 60 = 2400` and update the deployed mirror `extension/services/pickle-utils.js` in the same commit (AC-RVN-08 trap door). Document the new default + reasoning in `extension/CLAUDE.md` invariant entry under `worker_timeout_seconds`. The `--worker-timeout` CLI flag writes to `state.flags.tier_cap_override.<tier>.worker_timeout_seconds` at setup time (matches existing `--max-iterations` flow); no fourth precedence tier.

**Acceptance**: a fresh `node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --paused --task "test"` session writes effective `worker_timeout_seconds: 2400` (the medium-tier default) to `state.json` unless `--worker-timeout <N>` is passed.

**Verify**: `cd extension && npm run test:fast` exits 0; deployed `TICKET_TIER_BUDGETS.medium.worker_timeout_seconds === 2400` in `extension/services/pickle-utils.js` after `bash install.sh`.

**Files**: `extension/src/services/pickle-utils.ts:441-446`, `extension/CLAUDE.md`, compiled mirror `extension/services/pickle-utils.js`.

### R-WTB-2 — Tier override precedence (no inversion)

*(refined: analysis_codebase.md P0 #2, analysis_risk-scope.md P0 #3)*

Confirm and document the existing `getTicketTierBudgetWithOverrides` precedence at `extension/src/services/pickle-utils.ts:541-555`: `state.flags.tier_cap_override.<tier>.<field>` > `pickle_settings.tier_caps.<tier>.<field>` > `TICKET_TIER_BUDGETS[<tier>].<field>`. The original PRD body's "settings first, then state.flags" wording inverted this — refinement reverts to match HEAD. Tier defaults (bumping `medium` only; preserving `large=4800` already above the R-PTG floor; dropping the non-existent `xlarge` row): `{ trivial: 5*60=300, small: 10*60=600, medium: 40*60=2400, large: 80*60=4800 }`. `pickle_settings.json` lives at repo root, NOT `extension/pickle_settings.json`.

**Small-tier rationale** *(refined: analysis_requirements.md P1)*: small tickets (`small=600`) skip the full worker lifecycle (no research/plan phases, no `npm run test:fast`; only ticket-write + commit). AC enforces: small-tier tickets refuse to invoke `npm run test:fast` and emit `tier_phase_skipped` activity events. Without this, the small-tier override is a footgun reintroducing R-WTB-1's bug.

**Acceptance**: `getTicketTierBudgetWithOverrides(state, 'medium')` returns `worker_timeout_seconds: 2400` when no override is set; honors `state.flags.tier_cap_override` > `pickle_settings.tier_caps` > compiled defaults in precedence order. Adding `xlarge` is OUT OF SCOPE.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/services/pickle-utils.ts:441-446`, repo-root `pickle_settings.json`.

### R-WTB-3 — describe.each over tier × override-source matrix

*(refined: refinement_manifest.json#ac_shape_smells — single parametrized ticket, universal-quantifier shape)*

Single ticket. AC enumerates 4 tiers × 3 precedence levels = 12 cells with the same predicate. Express via `describe.each` over the cross-product, not 7+ duplicated assertions.

**Acceptance**: a new integration test `extension/tests/integration/worker-timeout-tier-budget.test.js` (forward-created per R-RTRC-7) runs `describe.each([['trivial',300],['small',600],['medium',2400],['large',4800]])` × `['compiled-default','pickle_settings.tier_caps','state.flags.tier_cap_override']`. Each cell asserts the resolver returns the override value when set at that precedence level and falls through when not. (Note: `xlarge` row from original PRD is dropped — not in `VALID_TICKET_COMPLEXITY_TIERS`.)

**Verify**: `cd extension && npm run test:integration` exits 0; the new test is picked up by the integration tier.

**Files**: `extension/tests/integration/worker-timeout-tier-budget.test.js` (new).

### R-WTB-4 — Trap-door pin for worker-timeout / R-PTG interaction

*(refined: analysis_codebase.md Cross-Reference)*

Document the timeout invariant and its interaction with the R-PTG worker test gate in `extension/src/services/CLAUDE.md`. ENFORCE references the new R-WTB-3 regression test.

**Acceptance**: `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0; the new ENFORCE entry is counted.

**Files**: `extension/src/services/CLAUDE.md`.

### R-QGSK-1 — Add `skip_quality_gates_reason` to the `Flags` interface

*(refined: analysis_requirements.md P0 #2, analysis_codebase.md P1, analysis_risk-scope.md P1 placement)*

`extension/src/types/index.ts:165-188` already places `skip_readiness_reason?` (line 174) and `skip_ticket_audit_reason?` (line 179) on the `Flags` interface (read by mux-runner via `state.flags.*`). Add `skip_quality_gates_reason?: string` to the **`Flags`** interface — NOT to `State` root. Add `skip_quality_gates_deprecation_warning?: boolean` to the same interface (it was orphaned in the original Out-of-Band Concerns — assigning it here closes the gap). Existing legacy fields remain on `Flags` for back-compat (deprecated, planned removal in `R-QGSK-DEPRECATE-1` against `vX.Y+2.0`).

**Acceptance**: the type checker accepts `state.flags.skip_quality_gates_reason = 'foo'` without complaint; the deprecated fields still work but emit a runtime warning when accessed. Type test: `state.skip_quality_gates_reason = 'foo'` on State ROOT fails type-check (it is on `Flags`, not root).

**Verify**: `cd extension && npx tsc --noEmit` exits 0.

**Files**: `extension/src/types/index.ts:165-188`.

### R-QGSK-2 — `mux-runner.ts` checks the unified flag first

*(refined: analysis_codebase.md P2, analysis_requirements.md P1)*

`mux-runner.ts` skip-flag check logic: check `state.flags.skip_quality_gates_reason` first; if absent, fall back to either `state.flags.skip_readiness_reason` OR `state.flags.skip_ticket_audit_reason` with a deprecation warning logged to `mux-runner.log` (once-per-process) AND a structured `skip_flag_legacy_used` activity event emitted to `state.activity` every access. The activity event must be added to BOTH `definitions` and top-level `oneOf` in `extension/src/types/activity-events.schema.json` (per R-PDD-oneOf trap door at `extension/src/types/CLAUDE.md`), plus a per-event schema-conformance test `extension/tests/skip-flag-legacy-used-schema-conformance.test.js` (forward-created).

**Acceptance**: a unit test asserts the unified flag takes precedence; the deprecation warning is logged when only a legacy flag is set; the `skip_flag_legacy_used` event is emitted and is schema-conformant.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/bin/mux-runner.ts`, `extension/src/types/activity-events.schema.json`, `extension/tests/skip-flag-legacy-used-schema-conformance.test.js` (new).

### R-QGSK-3 — Migration in `state-manager.ts` (schema 4 → 5)

*(refined: analysis_requirements.md P0 #2 & R-QGSK-3 strengthened, analysis_codebase.md P0 #4 & P1, analysis_risk-scope.md P1)*

`LATEST_SCHEMA_VERSION` bumps from `4` (current at `extension/src/types/index.ts:259`) to `5`. `assertSchemaVersionDeployParity()` at `extension/src/services/state-manager.ts:35-65` is updated in the same commit. Compiled `extension/types/index.js` and `extension/services/state-manager.js` MUST match source post-`tsc` per R-AC-RVN-08 deploy-parity invariant.

**Migration rule (first-non-empty wins, NEVER concatenated)**: populate `state.flags.skip_quality_gates_reason` with the first non-empty value from this precedence: `state.flags.skip_readiness_reason`, then `state.flags.skip_ticket_audit_reason`, then `state.skip_readiness_reason` (state-root legacy, much older sessions), then `state.skip_ticket_audit_reason` (state-root legacy). If both `state.flags.skip_readiness_reason` AND `state.flags.skip_ticket_audit_reason` are set with different values, the readiness value wins AND the ticket-audit value is preserved verbatim in `state.flags.migrated_skip_ticket_audit_reason_archive` for operator-visible auditing. **Concatenation is explicitly forbidden** because it contaminates downstream equality checks.

**Schema-event preservation**: the existing `bundle_bootstrap_exemption_applied` activity event at `extension/src/types/activity-events.schema.json:140-153` REQUIRES both `gate_payload.skip_readiness_reason` AND `gate_payload.skip_ticket_audit_reason`. The auto-allowlist code at `extension/src/bin/mux-runner.ts:3692-3712` continues to dual-write these for back-compat. Removing the legacy fields is OUT OF SCOPE.

**Acceptance**: a unit test loads a `state.json` fixture with `state.flags.skip_readiness_reason: 'foo'` and asserts post-migration `state.flags.skip_quality_gates_reason === 'foo'`. A second fixture with both legacy flags set with divergent values asserts `state.flags.skip_quality_gates_reason === <readiness>` AND `state.flags.migrated_skip_ticket_audit_reason_archive === <ticket-audit>`. Migration is idempotent (re-running on an already-migrated state is a no-op).

**Verify**: `cd extension && npm run test:fast` exits 0; deployed mirrors `extension/types/index.js` and `extension/services/state-manager.js` match source.

**Files**: `extension/src/services/state-manager.ts:35-65,432-451`, `extension/src/types/index.ts:259`, compiled mirrors.

### R-QGSK-4 — describe.each over state-shape × gate matrix

*(refined: refinement_manifest.json#ac_shape_smells — single parametrized ticket)*

Single ticket. AC enumerates 7 state-shapes × 2 gates = 14 cells with shared predicate. Express via `describe.each` over the state-shape × gate matrix; assert bypass behavior, warning channel emission, and migration-archive preservation per the resolved R-QGSK-3 rule.

**Acceptance**: a new test file `extension/tests/skip-flag-collapse.test.js` (forward-created) runs `describe.each(['unified-only', 'readiness-only', 'audit-only', 'both-legacy-same-value', 'both-legacy-divergent', 'fresh-migration', 'idempotent-re-migration'])` × `['readiness-gate', 'ticket-audit-gate']`. Each cell asserts: (a) bypass behavior matches resolved rule, (b) correct warning channel (`mux-runner.log` once-per-process + `skip_flag_legacy_used` activity event), (c) `migrated_skip_ticket_audit_reason_archive` preserved on divergent path. `cd extension && npm run test:fast` exits 0.

**Files**: `extension/tests/skip-flag-collapse.test.js` (new).

### R-QGSK-5 — Docs update

*(refined: analysis_codebase.md P2 — `prds/CLAUDE.md` does not exist at HEAD)*

Update `extension/CLAUDE.md` skip-flag section to document `state.flags.skip_quality_gates_reason` as the new canonical field. Deprecate legacy fields with a removal target (`R-QGSK-DEPRECATE-1` against `vX.Y+2.0`). `prds/CLAUDE.md` does NOT exist at HEAD — skill-prompt doc is `extension/CLAUDE.md` itself.

**Acceptance**: `grep -n "skip_quality_gates_reason" extension/CLAUDE.md` returns at least one match; legacy field docs marked deprecated with removal target.

**Files**: `extension/CLAUDE.md`.

### R-RSU-1 — Reuse `composedPrdPaths` + idempotency contract

*(refined: analysis_codebase.md P0 #5, analysis_requirements.md P0 #1, analysis_risk-scope.md P0 #5 & P1 self-reprocessing)*

`extension/src/bin/spawn-refinement-team.ts:1259-1271` already defines `composedPrdPaths(frontmatter)` with cycle/glob/depth handling (the Citadel-class `composedPrdPaths` at `extension/src/services/citadel/prd-parser.ts:520+` is the validation/error-emission path used by `audit-runner.ts`; do NOT duplicate it in refinement). R-RSU-1 reuses the local detector and surfaces results as `manifest.bundle_shape: 'composed' | 'flat' | 'flat-pre-decomposed'` with `manifest.source_prds: Array<{ path: string, r_codes: string[] }>`.

**Idempotency contract** *(this PRD as fixture)*: if the input PRD's body already contains `### R-XXX-N` sections matching every entry in its `r_codes:` frontmatter, the detector returns `bundle_shape === 'flat-pre-decomposed'` and skips composes-fanout (the inline body is authoritative). Operator can force fanout with `--force-composes-fanout` if needed.

**Acceptance**: a unit test passes a fixture PRD with `composes: [a.md, b.md]` (each with `r_codes: [A-1, A-2]` / `[B-1, B-2]`) and asserts the detector returns `'composed'` with `source_prds.length === 2`. A second test uses **this very bundle PRD** as fixture (`composes:` lists 4, inline body has 21 `### R-` sections matching `r_codes:`); expected output is `'flat-pre-decomposed'`, not 21 + 4×N additional tickets via composes-walking.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/bin/spawn-refinement-team.ts:1259-1515`.

### R-RSU-2 — Fan-out N≤8 decomposer Mortys with failure-mode contract

*(refined: analysis_requirements.md P0 #5, analysis_codebase.md P1 R-RSU-2, analysis_risk-scope.md P0 #4)*

When `bundle_shape === 'composed'`, spawn N parallel decomposer Morty subprocesses (one per source PRD via `Promise.all`), each scoped to its single source. Decomposers run as a **one-shot phase BEFORE cycle 1**; analyst trio still runs each cycle on the aggregated manifest. Aggregator collects per-source `analysis_decomposition_<source>.md` outputs and merges into a flat atomic ticket list (no section umbrellas).

**Concurrency cap**: `N = Math.min(sources.length, 8)`; if `sources.length > 8`, abort with operator-visible error before spawning any decomposer.

**Failure categories (all three tested)**: (1) subprocess exit code ≠ 0 — aggregator aborts, writes `refinement_manifest.error.category: 'exit-code'`; (2) subprocess timeout — decomposer has its own 600s budget (NOT inheriting R-WTB worker timeout — closes Risk Auditor's R9 closer self-timeout class); aggregator aborts, writes `category: 'timeout'`; (3) subprocess exits 0 but produces no output file — aggregator aborts, writes `category: 'empty-output'`. All three preserve successfully-written per-source files at `${SESSION_ROOT}/refinement/decomposer_<source>_partial.md` and exit non-zero. Partial manifests are explicitly forbidden.

**Parallel-tmp race protection** *(per original Out-of-Band Concerns)*: each decomposer gets a `mkdtempSync` directory; `realpathSync` resolves the symlink before any concurrent operation.

**Acceptance**: a unit test mocks a 3-source bundle and asserts 3 parallel decomposer spawns + a merged manifest with N atomic tickets (N = sum of per-source R-codes), no section umbrellas. Three failure tests exercise the three categories above. Over-cap test: pass 9 sources, assert pre-spawn abort.

**Verify**: `cd extension && npm run test:fast` exits 0.

**Files**: `extension/src/bin/spawn-refinement-team.ts`.

### R-RSU-3 — Decomposer Morty prompt + env-var input channel

*(refined: analysis_requirements.md P1 R-RSU-3, analysis_codebase.md P1 R-RSU-3)*

The per-source decomposer Morty prompt instructs the worker to: (1) read the source PRD, (2) walk its `## Atomic decomposition` section (or `r_codes:` frontmatter), (3) write one `linear_ticket_<hash>.md` per R-code with full atomic-ticket detail (acceptance criteria, verify commands, file paths, interface contracts). Output: a per-source ticket-list manifest the aggregator merges.

**Input channel**: decomposer Morty receives input via environment variables (consistent with existing analyst-trio convention): `PICKLE_DECOMPOSER_SOURCE_PRD` (absolute path to single source PRD), `PICKLE_DECOMPOSER_OUTPUT_DIR` (per-source manifest directory). Stdin/CLI-args are NOT used.

**Backend lock**: decomposer Mortys spawn through the same `spawnClaudeProcess` path as analyst-team spawns; `PICKLE_REFINEMENT_LOCK=1` is set on every decomposer subprocess env per R-XBL-2 trap door at `extension/src/bin/CLAUDE.md`.

**Empty-source handling**: a source PRD with no `r_codes:` AND no `## Atomic decomposition` is an explicit operator-visible error (abort with named source), not silent skip. Duplicate R-codes across sources also abort (silent collision risks two tickets with same hash colliding in `state.history`).

**Acceptance**: a unit test asserts the decomposer prompt template includes the required instructions; an integration test invokes a real decomposer Morty against a fixture source PRD and asserts N ticket files written, prompt template references `PICKLE_DECOMPOSER_SOURCE_PRD` and `PICKLE_DECOMPOSER_OUTPUT_DIR` verbatim, every decomposer subprocess has `PICKLE_REFINEMENT_LOCK=1` in its env.

**Verify**: `cd extension && npm run test:fast` exits 0; integration test passes under `npm run test:integration`.

**Files**: `extension/src/bin/spawn-refinement-team.ts` + decomposer prompt template asset.

### R-RSU-4 — Integration test: 3-source bundle produces ≥6 atomic tickets

*(refined: analysis_codebase.md P2)*

A new integration test `extension/tests/integration/refinement-composes-fanout.test.js` (forward-created) constructs a synthetic 3-source bundle PRD (each source having 2 R-codes) and asserts: (a) decomposer Morty count == 3, (b) atomic ticket count ≥ 6, (c) no section-umbrella tickets in the manifest, (d) `prd_refined.md` lists all 6 atomic tickets in `## Implementation Task Breakdown`. Fixture directory `extension/tests/integration/fixtures/composes-fanout/` (3 source PRDs, each with 2 R-codes) committed in the same commit.

**Acceptance**: `cd extension && npm run test:integration` exits 0.

**Files**: `extension/tests/integration/refinement-composes-fanout.test.js` (new), fixtures under `extension/tests/integration/fixtures/composes-fanout/`.

### R-RSU-5 — Trap-door pin for composes fanout shape

*(refined: analysis_codebase.md Cross-Reference)*

`extension/src/bin/CLAUDE.md` adds an ENFORCE entry pinning the `composes:` fanout shape (must spawn N≤8 decomposers, never section-umbrellas; idempotency clause preserved). Verified by `bash extension/scripts/audit-trap-door-enforcement.sh`.

**Acceptance**: `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0; the new ENFORCE entry is counted.

**Files**: `extension/src/bin/CLAUDE.md`.

### R-CLOSER-1 — Bundle closer

*(refined: analysis_codebase.md P1 versioning, analysis_risk-scope.md R9)*

Atomically: (a) **minor** bump in `extension/package.json` (R-QGSK-3 bumps `LATEST_SCHEMA_VERSION` from 4 → 5 — concrete rule, not "likely" judgment, per AC-RVN-08 trap door). (b) Run the full release gate from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. (c) Deploy via `bash install.sh --closer-context --no-confirm`. (d) Verify md5 parity on the 5 named compiled files: `extension/types/index.js`, `extension/services/state-manager.js`, `extension/bin/spawn-morty.js`, `extension/bin/mux-runner.js`, `extension/services/pickle-utils.js`. (e) Update `prds/MASTER_PLAN.md`: mark Findings #29 + #30 + #34 + slot #29 as CLOSED; move entries to archive; update B-bundle table rows.

**Tier**: ticket frontmatter declares `complexity_tier: large` so its worker timeout is 4800s, not the bundle's default 2400s (closes Risk Auditor R9 closer self-timeout class).

**Acceptance**:
- `extension/package.json#version` reads the new minor bump.
- All release gate steps exit 0.
- `git status` clean in source tree (`~/.claude/pickle-rick/` is rsync'd, not git-tracked — out of scope for `git status`).
- MASTER_PLAN.md no longer lists Findings #29/#30/#34 in Open Findings; archive contains them verbatim.
- md5 parity confirmed on 5 named files.

**Verify**: as above per step.

**Files**: `extension/package.json`, `prds/MASTER_PLAN.md`, the 5 compiled mirrors under `extension/services/`, `extension/types/`, `extension/bin/`.

## Interface Contracts

### Contract 1a — `inferMonitorMode` return type (layout selector — this PRD extends)

*(refined: analysis_codebase.md Specific Recommendations)*

`inferMonitorMode(sessionDir: string): MonitorMode` at `extension/src/services/pickle-utils.ts:1646` where `MonitorMode = 'pickle' | 'meeseeks' | 'council' | 'refinement' | 'szechuan-sauce' | 'anatomy-park'` (extends the existing union at line 1613 by two members — preserves `'refinement'`). New switch arms must also extend `watcherPaneCommands` (`:1743`), `watcherPaneTwoCommand` (`:1767`), and `monitorModesCompatible` (`:1989`). Defaults to `'pickle'` only when `state.command_template` is unset or unrecognized.

### Contract 1b — `inferModeFromStep` return type (render mode — extended in this PRD)

`inferModeFromStep(step: string): 'pickle' | 'microverse' | 'idle'` at `extension/src/bin/monitor.ts:211`. NOTE: the render-loop `MonitorMode` union at `monitor.ts:204` is intentionally different from the layout-selector union — R-MWCL-2 extends `inferModeFromStep` only; the union itself is unchanged (already pinned via R-MDS-3 trap door).

### Contract 2 — `getTicketTierBudgetWithOverrides` return shape

*(refined: analysis_codebase.md, analysis_risk-scope.md)*

`getTicketTierBudgetWithOverrides(state: State, tier: 'trivial'|'small'|'medium'|'large', settings?: PickleSettings): { worker_timeout_seconds: number; ... }` at `extension/src/services/pickle-utils.ts:541-555`. Precedence: `state.flags.tier_cap_override.<tier>.<field>` > `pickle_settings.tier_caps.<tier>.<field>` > `TICKET_TIER_BUDGETS[<tier>].<field>`. `--worker-timeout <N>` CLI flag writes to `state.flags.tier_cap_override.<tier>.worker_timeout_seconds` at setup time (no fourth precedence tier).

### Contract 3 — `Flags.skip_quality_gates_reason` field

*(refined: analysis_requirements.md P0 #2, analysis_codebase.md P1, analysis_risk-scope.md P1)*

`Flags.skip_quality_gates_reason?: string` on the `Flags` interface at `extension/src/types/index.ts:165-188`, accessed via `state.flags.skip_quality_gates_reason`. Truthy value bypasses both readiness and ticket-audit gates. Legacy `Flags.skip_readiness_reason` and `Flags.skip_ticket_audit_reason` remain readable but emit a one-shot-per-process deprecation warning + a `skip_flag_legacy_used` activity event when accessed. Removal target: `R-QGSK-DEPRECATE-1` against `vX.Y+2.0`.

### Contract 4 — `bundle_shape` manifest field

*(refined: analysis_requirements.md P0 #1)*

`refinement_manifest.bundle_shape: 'flat' | 'composed' | 'flat-pre-decomposed'`. When `'composed'`, manifest also carries `source_prds: Array<{ path: string, r_codes: string[] }>` reflecting per-source decomposition. When `'flat-pre-decomposed'` (idempotency case: PRD body already inline-enumerates R-codes matching `r_codes:` frontmatter), refinement processes the inline sections directly without fanout. Operator can force fanout via `--force-composes-fanout`.

## Verification Strategy

- Unit tests for each R-code's atomic acceptance (per-section above)
- Integration tests for R-WTB-3 (tier budget), R-RSU-4 (composes fanout end-to-end), R-MWCL-6 (mode resilience), R-RSU-3 (decomposer prompt)
- Audit script `audit-trap-door-enforcement.sh` validates R-MWCL-7 + R-WTB-4 + R-RSU-5 + R-MWCL-5 (R-MWR-1 update) + R-MWCL-1 (R-MDS-3 cross-ref) ENFORCE entries
- Release gate validates state schema migration (R-QGSK-3): `assertSchemaVersionDeployParity()` confirms compiled mirrors match source
- Schema-conformance test validates new `skip_flag_legacy_used` activity event (R-QGSK-2)
- `npm run test:fast` and `npm run test:integration` both pass at the closer; `RUN_EXPENSIVE_TESTS=1 npm run test:expensive` passes

## Test Expectations

| R-code | Test file | Description |
|---|---|---|
| R-MWCL-1..5 | `extension/tests/monitor-mode-resilience.test.js` | Mode inference (all 6 modes) + extended step inference + split-window fallback + stderr capture w/ rotation + first-tick watchdog |
| R-MWCL-5 | `extension/tests/monitor-watchdog.test.js` (extended) | Watchdog fires within 100ms, then every `RESPAWN_WATCHDOG_INTERVAL_MS` |
| R-MWCL-7 | (audit script) | ENFORCE entry verified |
| R-WTB-1 | `extension/tests/state-field-invariants.test.js` (extended) | Medium-tier default is 2400 |
| R-WTB-2/3 | `extension/tests/integration/worker-timeout-tier-budget.test.js` | `describe.each` over 4 tiers × 3 precedence levels |
| R-WTB-4 | (audit script) | ENFORCE entry |
| R-QGSK-1..4 | `extension/tests/skip-flag-collapse.test.js` | `describe.each` over 7 state-shapes × 2 gates |
| R-QGSK-2 | `extension/tests/skip-flag-legacy-used-schema-conformance.test.js` | Activity event matches schema |
| R-QGSK-5 | (grep) | Docs updated |
| R-RSU-1..4 | `extension/tests/integration/refinement-composes-fanout.test.js` | 3-source fanout produces ≥6 atomic tickets; idempotency tested against this PRD |
| R-RSU-5 | (audit script) | ENFORCE entry |
| R-CLOSER-1 | (release gate) | Full gate exit 0 |

## Risk Register

*(refined: analysis_risk-scope.md Specific Recommendations §risk-register additions)*

- **R1** (R-MWCL): the +2 LOC fix in R-MWCL-1 may interact badly with `restartDeadWatcherPanes` if existing call sites assume `mode === 'pickle'`. Mitigation: R-MWCL-3's split-window fallback handles unexpected mode values without crashing.
- **R2** (R-WTB): raising medium-tier default could mask real worker hangs. Mitigation: R-PTG's per-ticket test gate catches stuck workers via test-failure mode; timeout is a backup.
- **R3** (R-QGSK): schema migration must handle nested `state.flags` objects correctly. Mitigation: R-QGSK-3 regression test fixture covers the cross-product of (legacy A set, legacy B set, both same, both divergent, neither, migrated already) × (operator edited new field vs not).
- **R4** (R-RSU): concurrent decomposer Morty spawns could exceed claude API rate limits. Mitigation: `N = Math.min(sources.length, 8)` hard cap + rate-limiter at `spawnClaudeProcess`.
- **R5** (bundle scope): 22+4 tickets at the edge of sanctioned cap. Mitigation: tightly-themed, section-by-section enumeration in PRD body, no `composes:`-walker dependency for this bundle's own decomposition.
- **R6** (MonitorMode breakage): Contract 1a preserves `'refinement'` member; R-MWCL-1 AC also touches `watcherPaneCommands`/`watcherPaneTwoCommand`/`monitorModesCompatible`.
- **R7** (R-MWCL-2 redundancy): R-MWCL-2 reframed to extend `inferModeFromStep`, not duplicate R-MDS-3's guard.
- **R8** (schema collision): `LATEST_SCHEMA_VERSION = 4 → 5` locked here; concurrent migrations must use ≥6.
- **R9** (closer self-timeout): R-CLOSER-1 frontmatter declares `complexity_tier: large` so its worker timeout is 4800s, not the bundle's default 2400s; decomposer Mortys have a 600s budget that does NOT inherit `worker_timeout_seconds`.
- **R10** (deprecation removal anchor): forward-PRD `R-QGSK-DEPRECATE-1` filed against `vX.Y+2.0`.
- **R11** (self-reprocessing recursion): R-RSU-1 idempotency clause prevents the bundle's own re-refinement from double-decomposing.
- **R12** (partial decomposer failure): R-RSU-2 fail-closed contract prevents R-RSU itself from introducing a new wedge class.
- **R13** (concurrency cap): R-RSU-2 caps N at 8 with explicit pre-spawn abort.
- **R14** (`bundle_bootstrap_exemption_applied` schema breakage): R-QGSK-3 dual-write preserves both legacy `gate_payload` fields; removing them is OUT OF SCOPE.

## Out of Band Concerns

- R-MWCL-3's `tmux split-window` fallback assumes tmux session is alive; if killed by SIGINT, that's R-SOA (already shipped).
- R-WTB tier override precedence MUST NOT silently downgrade; explicit fall-through to compiled default, not lower value.
- R-QGSK deprecation warnings can be suppressed via `state.flags.skip_quality_gates_deprecation_warning: true` (now formally placed in R-QGSK-1's Flags additions).
- R-RSU-2's parallel decomposer spawns MUST NOT share temp directories — each gets `mkdtempSync` + `realpathSync` to avoid parallel-tmp race.
- `extension/src/data/bundle-disposition-2026-05-04.json` is referenced by R-TAQ-2 but absent at HEAD; closer or follow-up may rename anchor — not in this bundle's scope.

## Success definition

Closer's release gate exits 0 against full test tier; deployed `~/.claude/pickle-rick/` md5-parity verified on the 5 named compiled files (`extension/types/index.js`, `extension/services/state-manager.js`, `extension/bin/spawn-morty.js`, `extension/bin/mux-runner.js`, `extension/services/pickle-utils.js`); MASTER_PLAN.md updated; `git status` clean (source tree); minor version tag advanced reflecting the schema 4→5 bump.

## Implementation Task Breakdown

| Order | ID | R-code | Title | Priority | Files |
|---|---|---|---|---|---|
| 10 | 799d5ebe | R-MWCL-1 | inferMonitorMode returns correct mode for every template | Medium | `pickle-utils.ts:1613,1646,1743,1767,1989` |
| 20 | 45815a71 | R-MWCL-2 | Extend inferModeFromStep to cover microverse step values | Medium | `monitor.ts:211-225` |
| 30 | 40cab843 | R-MWCL-3 | restartDeadWatcherPanes collapsed-layout split-window fallback | Medium | `pickle-utils.ts:1683-1700` |
| 40 | 7644f1ba | R-MWCL-4 | Capture monitor stderr to session-local rotated log | Medium | `monitor.ts` |
| 50 | 32f8a0ed | R-MWCL-5 | Watchdog fires on registration before interval | Medium | `monitor.ts:777-798`, `extension/CLAUDE.md` |
| 60 | 8240fdca | R-MWCL-6 | Regression test for R-MWCL-1..5 across all six modes | Medium | `extension/tests/monitor-mode-resilience.test.js` |
| 70 | c1271d6c | R-MWCL-7 | Trap-door pin for inferMonitorMode shape | Medium | `extension/src/services/CLAUDE.md` |
| 80 | e69810cc | R-WTB-1 | Bump TICKET_TIER_BUDGETS.medium.worker_timeout_seconds to 2400 | Medium | `pickle-utils.ts:441-446`, `extension/CLAUDE.md` |
| 90 | 5d52ca45 | R-WTB-2 | Tier override precedence + small-tier lifecycle skip | Medium | `pickle-utils.ts:441-555`, repo-root `pickle_settings.json` |
| 100 | bf456cc5 | R-WTB-3 | describe.each over tier × override-source matrix | Medium | `extension/tests/integration/worker-timeout-tier-budget.test.js` |
| 110 | fd704849 | R-WTB-4 | Trap-door pin for worker-timeout / R-PTG interaction | Medium | `extension/src/services/CLAUDE.md` |
| 120 | 86fed02c | R-QGSK-1 | Add skip_quality_gates_reason to Flags interface | Medium | `extension/src/types/index.ts:165-188` |
| 130 | 1d385443 | R-QGSK-2 | mux-runner reads unified flag first, emits deprecation event | Medium | `mux-runner.ts`, `activity-events.schema.json` |
| 140 | 22c36bf6 | R-QGSK-3 | Schema 4→5 migration: first-non-empty wins, archive preserved | Medium | `state-manager.ts:35-65,432-451`, `types/index.ts:259` |
| 150 | b8146528 | R-QGSK-4 | describe.each over state-shape × gate matrix | Medium | `extension/tests/skip-flag-collapse.test.js` |
| 160 | 1bb3434a | R-QGSK-5 | Update extension/CLAUDE.md skip-flag docs | Medium | `extension/CLAUDE.md` |
| 170 | abc9555c | R-RSU-1 | Reuse composedPrdPaths + idempotency contract | Medium | `spawn-refinement-team.ts:1259-1515` |
| 180 | 6be166a4 | R-RSU-2 | Fan-out N≤8 decomposer Mortys with failure-mode contract | Medium | `spawn-refinement-team.ts` |
| 190 | 119789f4 | R-RSU-3 | Decomposer prompt + env-var input channel | Medium | `spawn-refinement-team.ts` + prompt asset |
| 200 | 992d769d | R-RSU-4 | Integration test: 3-source bundle produces ≥6 atomic tickets | Medium | `extension/tests/integration/refinement-composes-fanout.test.js` |
| 210 | 244bc639 | R-RSU-5 | Trap-door pin for composes fanout shape | Medium | `extension/src/bin/CLAUDE.md` |
| 220 | 90ee4875 | R-CLOSER-1 | Version bump (minor) + release gate + parity + MASTER_PLAN | Medium | `package.json`, `prds/MASTER_PLAN.md`, 5 compiled mirrors |
| 230 | 6f1956fd | Harden-CQ | Code quality review of operational tax trifecta + R-RSU | High | All MODIFIED_FILES |
| 240 | e56104e6 | Harden-DF | Data flow audit for operational tax trifecta + R-RSU | High | AFFECTED_SUBSYSTEMS |
| 250 | 87731a6d | Harden-TQ | Test quality review of operational tax trifecta + R-RSU | High | All test files |
| 260 | 9458b497 | Harden-XR | Cross-reference consistency for operational tax trifecta + R-RSU | High | Docs + impl files |
