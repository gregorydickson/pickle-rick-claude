---
title: P1 — Bug-fix bundle 2026-05-04 (REFINED)
status: Shipped
date: 2026-05-04
priority: P1
shipped: with residuals carried forward to p1-bug-fix-bundle-2026-05-04-completion.md
type: bug-bundle
peer_prds:
  composes:
    - prds/archive/bug-reports/p1-worker-spawns-codex-despite-claude-backend.md
    - prds/archive/bug-reports/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md
    - prds/archive/bug-reports/p1-ticket-authoring-quality-systemic-defects.md
    - prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md
    - prds/archive/bug-reports/p2-refined-tickets-trip-readiness-contract-resolver.md
    - prds/archive/features/p3-monitor-watcher-continuous-auto-respawn.md
  related:
    - prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md
    - prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md
refinement:
  cycles: 3
  workers: [requirements, codebase, risk-scope]
  manifest: refinement_manifest.json
  ac_shape_smells_resolved: 6 (3 unique, 3 cross-confirmed)
---

# PRD — Bug-fix bundle 2026-05-04 (REFINED)

## Why one bundle *(carried from original)*

The reliability bundle (`prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md`, session `2026-05-03-7d9ee8cc`) reached **38/38 tickets Done** but the pipeline marked `failed` because **0/3 phases ran** *(refined: codebase-analyst — pipeline-runner orchestrates 3 phases pickle-build → anatomy-park → szechuan-sauce; citadel is a separate command, not a pipeline-runner phase)*. Forensic review surfaced six new bug PRDs whose root causes overlap and whose tests share fixture infrastructure. Six tiny releases would re-traverse the same code paths six times. One bundle ships them together, after which v1.66.0's poisoned GitHub-Latest tag finally gets evicted by v1.70.0.

## ‼ Cycle-3 critical refinements (read first)

The following changes from the original PRD are mandatory — refinement found existing-code conflicts, name collisions, and bootstrap failure cascades. Implementer MUST treat the refined section bodies as authoritative; the original `prds/archive/bundles/p1-bug-fix-bundle-2026-05-04.md` line-numbers may rot.

| Original | Refined | Source |
|---|---|---|
| R-XBL-4 (manager-relaunch re-read) | **DROP** — already shipped at `codex-manager-relaunch.ts:69` + `mux-runner.ts:2078-2086, :3206-3212`. Replaced by AC-XBL-08 regression test only. | codebase-analyst |
| R-DTS-1 (typescript symlink) | **REGRESSION-TEST-ONLY** — already shipped at `install.sh:305-310`. New AC asserts existing behavior. | codebase-analyst |
| AC-DTS-02 (`pipeline-runner.js --help` exit 0) | **REPLACE** — `--help` is not parsed at `pipeline-runner.ts:1658-1665`. New body: `node -e "require($EXTENSION_ROOT/extension/bin/pipeline-runner.js)"` exits 0 (module-load only). | codebase-analyst |
| AC-MWR-03 (4 watchers truncate) | **SPLIT** into AC-MWR-03a (3 file-tail watchers, parametrized) + AC-MWR-03b (refinement-watcher manifest-poll resilience). `refinement-watcher.ts` has zero `FEED TERMINATED` matches; different architecture. | requirements + codebase analysts |
| AC-BUNDLE-03 (phases all run) | **RENAME** to **AC-PIPELINE-PHASES-01** (name collision with existing trap-door `src/services/bundle-state-integrity.ts AC-BUNDLE-03 audits`). Body: `pipeline-status.json.status === 'completed'` AND `completed_phases` is canonical 3-phase array. | codebase-analyst |
| `xlarge` tier in R-CNAR-1 | **DROP** — adding tier requires migrating 5 state-field invariants + parseTicketFrontmatter + analyst prompts (7+ file blast radius). Raise `large` to `{60 iter, 80*60s}` instead. | codebase-analyst |
| Section C dogfooding sentence | **STRIKE-AND-REPLACE** — refinement is hardcoded `'claude'` AND already ran for this bundle BEFORE R-TAQ-1 lands. R-TAQ-6 backfill on `2026-05-03-7d9ee8cc` is the dogfooding surface, not this bundle's own tickets. | risk + requirements analysts |
| `bash launch.sh` references | **REPLACE** with `node $EXTENSION_ROOT/extension/bin/mux-runner.js <session-dir>` — `launch.sh` does not exist in repo. | codebase-analyst |
| `extension/pickle_settings.json` path | **REPLACE** with repo-root `pickle_settings.json` (2968 bytes; deployed copy lives at `~/.claude/pickle-rick/pickle_settings.json`). | codebase-analyst |
| AC-BUNDLE-07 (md5 parity 4 files) | **DROP** — duplicates already-shipped `assertSchemaVersionDeployParity()` (AC-RVN-08 trap-door). | codebase + risk analysts |
| R-WSE-1 prescription `process.stdout.write('', () => process.exit(code))` | **REPLACE** with `flushAndExit(sessionLog: fs.WriteStream, code)` helper at `extension/src/services/worker-shutdown.ts` (NEW). Per-site map: replace at `spawn-morty.ts:733, 756, 764, 799, 849`. Line 310 (`die()` early-args-error) excluded. | codebase + requirements analysts |
| R-XBL-2 spawn-site enumeration (4 sites incl. spawn-gate-remediator) | **REWRITE** to 4 real sites: `spawn-morty.ts`, `spawn-refinement-team.ts`, `microverse-runner.ts:251`, `mux-runner.ts:2080-2086`. spawn-gate-remediator has zero backend code; covered by NEW R-XBL-2b inheritance audit. | requirements + codebase analysts |

## Cleanup — pre-launch *(NEW Cycle 3, P0)*

`bundle/ac-dr-02.json` is non-deterministic test debris (regenerated by `verify-recapture-fired` checker on every test run, with random temp-dir paths in `state_path`). Currently dirty in working tree. **Pre-launch action**: gitignore + remove from tree. Bundle's own `audit-fix-commits.sh` will fail with this file modified.

```bash
echo "bundle/ac-dr-02.json" >> .gitignore
git rm --cached bundle/ac-dr-02.json
git commit -m "chore: gitignore non-deterministic test artifact bundle/ac-dr-02.json"
```

This commit lands BEFORE bundle launch as part of the bootstrap-mode preparation.

## Risks *(NEW Cycle 3, P0 from risk-scope analyst)*

| ID | Risk | Likelihood | Blast | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Spark codex tier exhausts mid-bundle | Med | Bundle stalls | 429 → mux-runner persists state, exits clean, operator switches to claude per R20 CUJ. NO auto-resume on rate-limit. | Section B / R-CNAR-2 |
| R2 | Refinement (claude) emits ticket bodies that codex workers cannot execute | Med | Tickets fail | R-CNAR-6 smoke gate (first 2 must pass); R-XBL-9 schema-coordination prompt update | Section A |
| R3 | Bootstrapping — pre-flight gates fail on un-fixed code paths | High | Bundle won't launch | R-BUNDLE-1 single bootstrap flag auto-applies BOTH bypasses | Section D / R-BUNDLE-1 |
| R4 | 0-byte log root cause is crash, not graceful exit | Low | R-WSE-1 fix appears clean but recurrence ungated for crash class | R-XBL-6 + R-WSE-2 cover crash + leak; document limitation in R-WSE-1 body | Section C |
| R5 | Closer release-gate fails after `git push` | Low | Half-shipped repo | R-CLOSER-1: tag is LAST step; no history rewrite | Closer |
| R6 | Auto-resume daemon loops indefinitely | Med | Burns codex budget overnight | R-CNAR-4 + cap retries=10 + PROGRESS_THRESHOLD=3 + MAX_WALL_SECONDS=7200 | Section B |
| R7 | R-MWR-1 watchdog symbol-collides with `MONITOR_STDOUT_WATCHDOG_MS` | High | Reader confusion | Rename to `RESPAWN_WATCHDOG_INTERVAL_MS` / `startRespawnWatchdog()`; lands first commit of Section E | Section E |
| R8 | R-CNAR-1 xlarge tier scope-creep | High | 7+ file invariant chain | DROP xlarge; raise large=60. Path: repo-root `pickle_settings.json` | Section B |
| R9 | pipeline-runner phase contract under-specified | Med | AC defines wrong phase count | Read `pipeline-runner.ts` source; lock canonical phase array | Section Bundle |
| R10 | R-XBL-2 enumeration includes non-spawn-site | Med | Implementer adds backend code where it's not needed | 4 real sites + R-XBL-2b for remediator | Section A |
| R11 | Closer md5 parity duplicates AC-RVN-08 | Med | Two parity contracts | DROP AC-BUNDLE-07; cite AC-RVN-08 trap-door | Closer |
| R12 | Spark backend has unproven reliability | High | 8-hour run wastes operator-night | R-CNAR-6 smoke gate; halt at 3 consecutive codex-CLI errors | Bundle constraints |
| R13 | Auto-resume + spark + no notification = silent burn | High | Budget exhaustion at standup | Stderr banner past retry 3 | Section B |
| R14 | R-WSE-1 only addresses graceful-exit class | Med | Crash-class recurrence appears as if R-WSE-1 didn't ship | Document in R-WSE-1 body; R-WSE-2 catches all classes | Section C |
| R15 | Bundle commit-count thesis over-counted; "already-shipped" reqs flagged as hallucinated-premise by R-TAQ-2 | High | Bundle's own gate kills bundle | R-BUNDLE-DISPO-1 disposition table read by refinement analyst prompts | Section Bundle |
| R16 | Bootstrap exemption requires 2 simultaneous skip flags | High | 3 of 4 op-error states crash | R-BUNDLE-1 single flag with hardcoded session-hash allowlist | Section Bundle |
| R17 | Closer release-gate not idempotent under partial gh failures | Med | Half-shipped (commits pushed, no tag) | R-CLOSER-1 script: rate-limit pre-flight, retry-on-429, post-flight verify | Closer |
| R18 | R-XBL-5 + AC-BUNDLE-04 contradiction halts every bundle using `/codex:rescue` | Med | Recovery path triggers failure condition | AC-BUNDLE-04 carve-out: `subtool_backend_override` excluded; closer reports separately | Section A |
| R19 | R-CNAR-2 references nonexistent `launch.sh` | Med | Wrapper-creation forks scope | Use `node mux-runner.js <session-dir>`; NO new launch.sh | Section B |
| R20 | Codex-spark 429 mid-bundle has no recovery CUJ; R-XBL-3 tripwires backend-flip | Med | Operator stuck | 4-step recovery CUJ; `state.flags.backend_flip_reason` bypasses R-XBL-3 once | Bundle constraints |
| R21 | R-CNAR-2 daemon process-tree unspecified — orphan possible | Med | Detached daemon resurrects corrupted session overnight | Foreground wrapper only; forbid `setsid`/`nohup`; AC-CNAR-05 SIGTERM kill-tree test | Section B |

## Per-requirement disposition table — R-BUNDLE-DISPO-1 *(NEW Cycle 3, P0 — ALL ANALYST PROMPTS MUST READ THIS)*

This table prevents the recursive bootstrap failure described in R15 (R-TAQ-2 audit flagging already-shipped requirements as hallucinated-premise). Refinement-team analyst prompts (R-TAQ-1, R-XBL-9) read this table and skip/downgrade tickets accordingly. The audit-ticket-bundle.js validator (R-TAQ-2) treats `REGRESSION-TEST-ONLY` and `DROP` dispositions as exempt from `hallucinated-premise` check.

| Requirement | Disposition | Reason |
|---|---|---|
| R-XBL-1 | IMPLEMENT (P1, downgraded from P0) | Logging value realized in NEXT bundle's backfill audit |
| R-XBL-2 | IMPLEMENT | Single source of truth — 4 real sites |
| R-XBL-2b *(NEW)* | IMPLEMENT | spawn-gate-remediator inheritance audit-only |
| R-XBL-3 | IMPLEMENT | Pre-spawn assertion |
| R-XBL-4 | DROP | Already shipped at `codex-manager-relaunch.ts:69`, `mux-runner.ts:2078-2086, :3206-3212` |
| R-XBL-5 | IMPLEMENT (with carve-out) | `subtool_backend_override` excluded from leak count per R18 |
| R-XBL-6 | IMPLEMENT | Backfill audit script |
| R-XBL-7 | IMPLEMENT | Env-poison defense |
| R-XBL-7b *(NEW)* | IMPLEMENT | Reproduces actual `2026-05-03-7d9ee8cc` conditions |
| R-XBL-8 | IMPLEMENT | Trap-door |
| R-XBL-9 *(NEW)* | IMPLEMENT | Refinement-claude prompts reference new event schemas |
| R-DTS-1 | REGRESSION-TEST-ONLY | Already shipped at `install.sh:305-310` |
| R-DTS-2 | IMPLEMENT | Audit script `extension/scripts/audit-runtime-imports.sh` |
| R-DTS-3 | IMPLEMENT | Module-load smoke (replaces nonexistent `--help`) |
| R-CNAR-1 | IMPLEMENT | tier_caps schema; DROP xlarge; raise large=60 |
| R-CNAR-2 | IMPLEMENT | Auto-resume; foreground wrapper; uses `mux-runner.js` not launch.sh |
| R-CNAR-3 | IMPLEMENT | `pipeline_auto_resumed` event |
| R-CNAR-4 | IMPLEMENT | Stop conditions + MAX_WALL_SECONDS |
| R-CNAR-5 | IMPLEMENT | Regression test |
| R-CNAR-6 *(NEW)* | IMPLEMENT | Spark smoke-run gate |
| R-TAQ-1 | IMPLEMENT | Analyst verification block |
| R-TAQ-2 | IMPLEMENT | audit-ticket-bundle.js |
| R-TAQ-2b *(NEW)* | IMPLEMENT | Manifest schema (versioned) |
| R-TAQ-3 | IMPLEMENT | Pin to `runMuxReadinessGate` slot |
| R-TAQ-4 | IMPLEMENT | Failure-mode checklist |
| R-TAQ-5 | IMPLEMENT | Cross-doc validator (scope: `**/*.md` ∩ git-tracked) |
| R-TAQ-6 | IMPLEMENT | Backfill audit (uses snapshot per R-BUNDLE-2) |
| R-TAQ-7 | IMPLEMENT | refinement_manifest schema |
| R-WSE-1 | IMPLEMENT | flushAndExit helper, per-site map |
| R-WSE-2 | IMPLEMENT | partial-lifecycle event |
| R-WSE-3 | IMPLEMENT | Stderr breadcrumb (fixed format) |
| R-WSE-4 | IMPLEMENT | Worker prompt update |
| R-RTRC-1 | IMPLEMENT | Forward-ref hygiene |
| R-RTRC-2 | IMPLEMENT | Resolver skip annotated tokens |
| R-RTRC-3 | IMPLEMENT | Lift `tests/` exclusion (extension allowlist unchanged) |
| R-RTRC-4 | IMPLEMENT | Suffix-match fallback |
| R-RTRC-5 | IMPLEMENT | `.readiness-allowlist.json` (NOT `.cli-pins.json`) + lint script |
| R-RTRC-6 | IMPLEMENT | Regression suite |
| R-RTRC-7 *(NEW)* | IMPLEMENT | Annotation schema (8-char SHA or ticket-dir basename, OUTSIDE backticks) |
| R-MWR-1 | IMPLEMENT | Watchdog (delegate to `restartDeadWatcherPanes(opts)`) |
| R-MWR-2 | IMPLEMENT | Kill-switch |
| R-MWR-3 | IMPLEMENT | Logs |
| R-MWR-4 | IMPLEMENT | EOF resilience for 3 file-tail watchers |
| R-MWR-5 | IMPLEMENT | refinement-watcher manifest-poll resilience (separate path) |
| R-MWR-6 | IMPLEMENT | Banner reservation (excludes refinement-watcher) |
| R-MWR-7 | IMPLEMENT | Watchdog regression test |
| R-MWR-8 | IMPLEMENT | Watcher truncate test |
| R-BUNDLE-1 *(NEW)* | IMPLEMENT | Single bootstrap flag with session-hash allowlist |
| R-BUNDLE-2 *(NEW)* | IMPLEMENT | Snapshot baseline session before launch |
| R-CLOSER-1 *(NEW)* | IMPLEMENT | `closer-release-gate.sh` script |

## Bootstrap exemption — R-BUNDLE-1 *(NEW Cycle 3, P0)*

**Single flag, double bypass:** `state.flags.bundle_bootstrap_mode = "2026-05-04-v1.70.0"` set at session creation auto-applies both `skip_readiness_reason` and `skip_ticket_audit_reason` for THIS bundle's launch only. Hardcoded allowlist binds the flag to a specific session hash so the flag cannot be reused. Activity event `bundle_bootstrap_exemption_applied` records both bypasses in the activity log.

Implementation: in `mux-runner.ts` early init, if `state.flags.bundle_bootstrap_mode` matches the allowlist entry for the current session hash, set `state.flags.skip_readiness_reason` and `state.flags.skip_ticket_audit_reason` to the bootstrap-mode value, emit one activity event, continue.

## Section A — Cross-backend leak *(refined)*

### A.1 Diagnostic-first

| ID | Requirement | Disposition |
|---|---|---|
| **R-XBL-1** | Log resolved backend at spawn time as `worker_spawn_backend_resolved` activity event with payload `{backend: <one of: claude\|codex\|hermes>, source: <one of: state\|env\|settings\|default\|refinement-lock\|cli-flag-override>, pid: <int>}` *(refined: codebase-analyst — six-value source enum, pinned)*. Lands first as small commit before A.2. | IMPLEMENT (P1) |

### A.2 Design + enforcement

| ID | Requirement | Disposition |
|---|---|---|
| **R-XBL-2** | Single source of truth: read backend exclusively via `StateManager.read(statePath).backend` immediately before exec at four real spawn sites: `spawn-morty.ts`, `spawn-refinement-team.ts`, `microverse-runner.ts:251`, `mux-runner.ts:2080-2086` (relaunch path). spawn-gate-remediator EXCLUDED — no backend code at line level *(refined: codebase-analyst grep verified zero matches)*. **Carve-out**: `PICKLE_REFINEMENT_LOCK=1` env var is the ONLY env that may force backend=claude (refinement-team-claude-only invariant); precedence remains: refinement-lock > state > settings > default. NEW `--backend <name>` CLI override allowed for one-off operator override, logged as `worker_spawn_backend_override`. | IMPLEMENT |
| **R-XBL-2b** *(NEW)* | spawn-gate-remediator inheritance audit. Inherits backend from caller (`microverse-runner.ts:633`); on remediator entry, emits ONE `worker_spawn_backend_resolved` event with `source: "inherited-from-caller"`. Fires once per remediator invocation, not per lifecycle phase. | IMPLEMENT |
| **R-XBL-3** | Pre-spawn assertion: spawn site asserts resolved backend matches `state.backend`; on mismatch emit `worker_spawn_backend_mismatch` event with both values, exit non-zero, do NOT spawn. **Carve-out (R20 mitigation)**: when `state.flags.backend_flip_reason` is fresh (set within last 60s), mismatch check is bypassed for ONE iteration; flag is consumed (cleared) after first iteration. | IMPLEMENT |
| **R-XBL-4** | ~~Manager relaunch path re-reads state per decision~~ — **DROPPED**: already shipped at `codex-manager-relaunch.ts:69` (calls `resolveBackend(state)` per invocation, no caching) and `mux-runner.ts:2078-2086, :3206-3212` (`ctxReadState(ctx)` before each decision). AC-XBL-08 (NEW) regression test locks the existing behavior. | DROP |
| **R-XBL-5** | Sub-tools (`/codex:rescue`, send-to-morty) emit `subtool_backend_override` activity event when invoking codex regardless of session backend. **AC-BUNDLE-04 carve-out**: subtool overrides EXCLUDED from cross-backend leak count (R18). When session backend is non-codex, sub-tool warns or no-ops (configurable). | IMPLEMENT |

### A.3 Backfill + regression + invariant

| ID | Requirement | Disposition |
|---|---|---|
| **R-XBL-6** | `extension/src/bin/audit-worker-backends.ts` (NEW): scans `<session>/<ticket>/worker_session_*.log` for codex-CLI banner (`Reading additional input from stdin...` + `chatgpt.com/codex/settings/usage`), reports cross-backend mismatches as JSON. CLI guard required per CLAUDE.md "Required Patterns". Run on snapshot `extension/tests/fixtures/baseline-2026-05-03-7d9ee8cc/` (per R-BUNDLE-2) to lock baseline finding count. | IMPLEMENT |
| **R-XBL-7** | Integration test in `extension/tests/integration/spawn-morty-backend-resolution.test.js`: state.backend=claude + poisoned `PICKLE_BACKEND=codex` env → claude wins. Type: integration. | IMPLEMENT |
| **R-XBL-7b** *(NEW)* | Second integration test: reproduces actual session `2026-05-03-7d9ee8cc` conditions — `state.backend='claude'`, `PICKLE_REFINEMENT_LOCK=1`, then trigger codex-manager-relaunch path. Assert claude wins. Discovered conditions feed back from R-XBL-1 + R-XBL-6. Type: integration. | IMPLEMENT |
| **R-XBL-8** | Trap-door in `extension/CLAUDE.md`: backend resolution through `StateManager.read()`-only at the 4 real spawn sites; pre-spawn mismatch fails loud. ENFORCE: R-XBL-7 + R-XBL-7b. | IMPLEMENT |
| **R-XBL-9** *(NEW)* | Refinement-team analyst prompts (`spawn-refinement-team.ts:367-525`) reference new event schemas (`worker_spawn_backend_resolved`, `worker_partial_lifecycle_exit`, `pipeline_auto_resumed`, `bundle_bootstrap_exemption_applied`, `ticket_audit_*`) by name so codex workers consuming claude-authored tickets understand the contract. | IMPLEMENT |

### A — Acceptance Criteria *(refined)*

- **AC-XBL-01** — `state.backend='claude'` + poisoned `PICKLE_BACKEND=codex` env → all spawns invoke claude. Verify: R-XBL-7. Type: integration.
- **AC-XBL-02** — `state.activity` contains `worker_spawn_backend_resolved` event for every worker spawn. Parametrized via `describe.each([{site: 'spawn-morty'}, {site: 'spawn-refinement-team'}, {site: 'microverse-runner-worker-spawn'}, {site: 'mux-runner-relaunch'}])` *(resolves AC-shape smell)*. Five events expected per ticket per site (one per lifecycle phase research/plan/implement/verify/review). Type: test.
- **AC-XBL-02b** *(NEW)* — On remediator invocation, exactly one `worker_spawn_backend_resolved` event with `source: "inherited-from-caller"` is emitted. Type: test.
- **AC-XBL-03** — `audit-worker-backends.ts` reports zero leaks on a fresh session running on either backend. Type: integration.
- **AC-XBL-04** — `audit-worker-backends.ts` on snapshot `baseline-2026-05-03-7d9ee8cc/` produces a baseline JSON. Locked count = N where N := empirically-locked count from baseline run *(replaces vague `≥8`)*. Type: integration.
- **AC-XBL-05** — Mismatch causes spawn abort with non-zero exit and stderr diagnostic; mux-runner records failure. **Carve-out**: `state.flags.backend_flip_reason` fresh → bypass for one iteration. Type: test.
- **AC-XBL-06** — Trap-door in `extension/CLAUDE.md`. Type: lint.
- **AC-XBL-08** *(NEW, replaces dropped R-XBL-4)* — Mid-session backend flip regression: write `state.backend='codex'`, trigger one relaunch decision → `shouldRelaunch: true`; mutate `state.backend='claude'` → second decision → `shouldRelaunch: false reason: 'not_codex'`. ZERO production-code change required (asserts existing behavior). Path: `extension/tests/integration/manager-relaunch-backend-flip.test.js`. Type: integration.
- **AC-EVENT-PAYLOAD-01** *(NEW)* — Every NEW activity event validates against `extension/src/types/activity-events.schema.json`. Schema covers: `worker_spawn_backend_resolved`, `worker_spawn_backend_mismatch`, `worker_spawn_backend_override`, `subtool_backend_override`, `worker_partial_lifecycle_exit`, `pipeline_auto_resumed`, `bundle_bootstrap_exemption_applied`, `ticket_audit_bypassed`, `ticket_audit_manual_edit`, `smoke_gate_bypassed`, `bundle_2026_05_04_closer_done`. Type: test.

### A — Files in scope

`extension/src/bin/spawn-morty.ts`, `spawn-refinement-team.ts`, `spawn-gate-remediator.ts` (R-XBL-2b inheritance event only), `microverse-runner.ts:251`, `mux-runner.ts:2080-2086`, `services/backend-spawn.ts`, `extension/src/bin/audit-worker-backends.ts` (NEW), `extension/src/types/activity-events.schema.json` (NEW), `extension/tests/integration/spawn-morty-backend-resolution.test.js` (NEW), `extension/tests/integration/manager-relaunch-backend-flip.test.js` (NEW), `extension/CLAUDE.md`.

## Section B — Deploy + auto-resume *(refined)*

### B.1 — install.sh deploy gap *(REGRESSION-TEST-ONLY for R-DTS-1)*

| ID | Requirement | Disposition |
|---|---|---|
| **R-DTS-1** | typescript symlink — already shipped at `install.sh:305-310`. Add regression assertion to existing `extension/tests/install-script.test.js` that the symlink target exists post-install. | REGRESSION-TEST-ONLY |
| **R-DTS-2** | `extension/scripts/audit-runtime-imports.sh` (NEW) emits JSON manifest of every npm package imported at module-load by `extension/src/services/`, `extension/src/bin/`. | IMPLEMENT |
| **R-DTS-3** | Post-install module-load smoke. `node -e "require($EXTENSION_ROOT/extension/bin/pipeline-runner.js)"` exits 0 — no `ERR_MODULE_NOT_FOUND`. *(replaces nonexistent `--help` flag)*. | IMPLEMENT |

### B.2 — Cap auto-resume

| ID | Requirement | Disposition |
|---|---|---|
| **R-CNAR-1** | Per-tier cap defaults in `TICKET_TIER_BUDGETS` at `pickle-utils.ts:355-360`: `trivial: {5, 5*60}`, `small: {10, 10*60}`, `medium: {30, 20*60}`, `large: {60, 80*60}`. **NO `xlarge` tier** *(refined: codebase-analyst — adding tier requires migrating 5 state-field invariants)*. Repo-root `pickle_settings.json` gains optional `tier_caps: {trivial?, small?, medium?, large?}` block (each per-tier object MAY be partial; field-level fallback). Per-session override via `state.flags.tier_cap_override.<tier>.<field>` wins last. Helper `getTicketTierBudgetWithOverrides(state, tier)` is canonical accessor. `pickle_settings.schema_version` bumps to 2; reader accepts both. | IMPLEMENT |
| **R-CNAR-2** | `PICKLE_AUTO_RESUME_ON_CAP_HIT=1` env enables auto-resume. After pipeline-runner halts with `exit_reason='pipeline_phase_incomplete'`, **foreground wrapper** (`extension/scripts/auto-resume.sh`) relaunches via `node $EXTENSION_ROOT/extension/bin/mux-runner.js <session-dir>` (NOT launch.sh — does not exist) up to `PICKLE_AUTO_RESUME_MAX_RETRIES` times (default 10). Wrapper dies with parent shell — explicitly forbid `setsid`/`nohup`/`disown`/detach (R21). | IMPLEMENT |
| **R-CNAR-3** | Activity event `pipeline_auto_resumed` records `{retry_index, ticket_id, session_done_count_at_retry}`. Same-ticket retries set `retry_index ≥ 1` *(refined: codebase-analyst on payload shape)*. | IMPLEMENT |
| **R-CNAR-4** | Auto-resume STOPS unconditionally on: (a) no progress between consecutive retries (same ticket, same Done count) AND retry-index ≥ `PROGRESS_THRESHOLD` default 3; (b) `MAX_RETRIES` exhausted; (c) non-`pipeline_phase_incomplete` exit (codex 429, ticket-audit-failed, etc.); (d) wall-clock exceeds `PICKLE_AUTO_RESUME_MAX_WALL_SECONDS` default 7200. Each retry past 3 prints stderr banner. | IMPLEMENT |
| **R-CNAR-5** | Regression test: synthetic 5-ticket session with 15-cap simulating cap-hit on each ticket; auto-resume completes all 5 within retries. Plus SIGTERM-to-parent-shell test (R21): kill parent shell mid-retry, assert daemon and child mux-runner both die within 5s. | IMPLEMENT |
| **R-CNAR-6** *(NEW)* | Spark codex smoke-run gate. First 2 tickets of any bundle launched on `state.backend='codex'` AND `state.codex_model` matches `gpt-5.3-codex-spark*` MUST complete (Done) before mux-runner spawns iteration on tickets 3+. Halt criteria: (i) either of first 2 tickets exits Failed AND codex-CLI-error breadcrumb in worker session log; (ii) 3 consecutive ticket-failures with codex-CLI errors at any point. Halt action: mux-runner exits clean with `exit_reason: codex_unhealthy_consecutive_failures`; auto-resume MUST treat as non-`pipeline_phase_incomplete` and STOP per R-CNAR-4(c). Bypass: `state.flags.skip_smoke_gate_reason='<reason>'`; activity event `smoke_gate_bypassed`. | IMPLEMENT |

### B — Acceptance Criteria *(refined)*

- **AC-DTS-01** — `ls -la $HOME/.claude/pickle-rick/extension/node_modules/typescript` resolves to source repo path post-install; idempotent. Type: integration.
- **AC-DTS-02** *(replaces existing)* — `node -e "require(process.env.HOME + '/.claude/pickle-rick/extension/bin/pipeline-runner.js')"` exits 0 with no `ERR_MODULE_NOT_FOUND`. Module-load only; exercises every transitive runtime import including typescript symlink. Type: integration.
- **AC-CNAR-01** *(replaces existing)* — Defaults `{trivial:5, small:10, medium:30, large:60}`; operator override via `state.flags.tier_cap_override.<tier>.<field>` wins per-field with fallback. Verified via `describe.each([{tier:'trivial', field:'max_iterations', expected:5}, ..., {tier:'large', field:'max_iterations', expected:60}])`. Plus partial-override test: `tier_caps.medium.max_iterations: 50` while `worker_timeout_seconds` unset → seconds falls back to `TICKET_TIER_BUDGETS.medium.worker_timeout_seconds` (20*60). Type: test.
- **AC-CNAR-02** *(refined)* — 3-element parametrized check: (i) default unset = 10 retries; (ii) `=5` honored; (iii) `=15` honored. Each retry past 3 prints stderr banner. Type: test.
- **AC-CNAR-03** — Auto-resume halts on same-ticket / same-Done-count across two consecutive retries when `retry_index ≥ PROGRESS_THRESHOLD`. Type: test.
- **AC-CNAR-04** — `state.activity` contains one `pipeline_auto_resumed` event per retry with documented payload. Type: test.
- **AC-CNAR-05** *(NEW R21)* — SIGTERM to parent shell kills child mux-runner + daemon within 5s. Type: integration.
- **AC-CNAR-06** *(NEW R-CNAR-6)* — `extension/tests/integration/spark-smoke-gate.test.js`: 5-ticket fixture `state.backend='codex'`, `state.codex_model='gpt-5.3-codex-spark'`. (a) first 2 pass → tickets 3-5 spawn; (b) ticket 1 fails with codex-CLI error → halt before ticket 2; (c) 3 consecutive failures → halt with `codex_unhealthy_consecutive_failures`; (d) `state.flags.skip_smoke_gate_reason='testing'` bypasses gate AND emits `smoke_gate_bypassed`. Type: integration.

### B — Files in scope

`install.sh`, `extension/src/bin/pipeline-runner.ts`, `mux-runner.ts`, `extension/src/services/pickle-utils.ts:355-360`, repo-root `pickle_settings.json`, `extension/scripts/audit-runtime-imports.sh` (NEW), `extension/scripts/auto-resume.sh` (NEW), `extension/tests/integration/install-typescript-package.test.js` (NEW), `extension/tests/integration/auto-resume-on-cap-hit.test.js` (NEW), `extension/tests/integration/spark-smoke-gate.test.js` (NEW), `extension/CLAUDE.md`.

## Section C — Ticket-authoring quality + worker silent-exit *(refined)*

**STRIKE-AND-REPLACE (P0, requirements + risk analysts):** the original Section C narrative claimed "fix is its own dogfooding". This is factually wrong because refinement is hardcoded `'claude'` AND already ran for this bundle BEFORE R-TAQ-1 lands. Replacement narrative:

> Section C changes how ticket-authoring works going forward. R-TAQ-1 (analyst prompt verification block) and R-TAQ-4 (Failure-mode checklist) apply to the **next** bundle's refinement, not this one — refinement-team is hardcoded `'claude'` (`spawn-refinement-team.ts:22 REFINEMENT_BACKEND`) AND already ran for this bundle BEFORE R-TAQ-1's prompt change can take effect. This bundle validates R-TAQ-1/-4 via the **R-TAQ-6 backfill audit on snapshot `baseline-2026-05-03-7d9ee8cc/`** — that is the dogfooding surface. R-TAQ-2 (audit gate) and R-TAQ-3 (mux-runner integration) DO take effect on this bundle's tickets as a runtime gate; the disposition table (R-BUNDLE-DISPO-1) prevents already-shipped requirements from being flagged as hallucinated-premise.

### C.0 — Operator CUJ for audit-ticket-bundle exit non-zero *(NEW Cycle 3, P0)*

1. Operator runs `node $EXTENSION_ROOT/extension/bin/mux-runner.js <session-dir>`. mux-runner invokes `audit-ticket-bundle.js` as the FIRST step after `runMuxReadinessGate` exits 0, BEFORE iteration-0 spawn (R-TAQ-3 slot pin).
2. Audit exits non-zero with findings written to `${SESSION_ROOT}/audit-ticket-bundle.json` (R-TAQ-2b schema).
3. mux-runner halts BEFORE first iteration spawn, prints stderr `[halt] ticket-audit found N findings — see ${SESSION_ROOT}/audit-ticket-bundle.json`, exits non-zero with `exit_reason='ticket_audit_failed'`.
4. Operator inspects findings and chooses ONE recovery:
   - **(a) Re-run refinement** — `node $EXTENSION_ROOT/extension/bin/spawn-refinement-team.js --session <hash>`. **CAUTION**: NEW ticket hashes invalidate every backfill AC (AC-XBL-04, AC-TAQ-06, AC-BUNDLE-04). **FORBIDDEN once any iteration has spawned** (mid-bundle hash divergence corrupts artifact references).
   - **(b) Hand-edit** — Operator edits offending `linear_ticket_<hash>.md`; activity event `ticket_audit_manual_edit` records edit count. Re-launch.
   - **(c) Bypass** — `state.flags.skip_ticket_audit_reason='<reason>'` (mirrors `skip_readiness_reason`). Activity event `ticket_audit_bypassed`.
5. Audit re-passes; mux-runner spawns iteration 0.

### C.1 — Ticket-authoring quality

| ID | Requirement | Disposition |
|---|---|---|
| **R-TAQ-1** | `spawn-refinement-team.ts` analyst prompts (around line 367-525, `buildAnalystPrompt`) add hard verification block: "Every file path you cite in `## Files` or `## Locations` MUST be verified via `git ls-files <path>` first. Cite the verification command's output. If path doesn't exist, mark `(forward-created)` with sibling-ticket reference per R-RTRC-7 schema." Also references the disposition table (R-BUNDLE-DISPO-1). | IMPLEMENT |
| **R-TAQ-2** | `extension/src/bin/audit-ticket-bundle.ts` (NEW): walks `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md`, runs all 7 defect-class checks (path-drift, self-reference, missing-deps, wrong-HEAD-assumptions, cross-doc-naming, hallucinated-premise, literal-value-drift). Reads R-BUNDLE-DISPO-1 disposition; tickets marked `REGRESSION-TEST-ONLY` and `DROP` are EXEMPT from `hallucinated-premise` check (R15 mitigation). Exits non-zero with per-ticket findings; manifest at `${SESSION_ROOT}/audit-ticket-bundle.json` per R-TAQ-2b schema. CLI guard required. | IMPLEMENT |
| **R-TAQ-2b** *(NEW)* | `audit-ticket-bundle.json` schema v1: `{schema_version:1, session_hash:<str>, audited_at:<ISO>, ticket_count:<int>, findings: [{ticket_id, ticket_path, defect_class:<enum>, severity:'fatal'|'warning'|'info', evidence:<str>, remediation_hint:<str>}], exit_code:<int>}`. JSON Schema definition committed at `extension/src/types/audit-ticket-bundle.schema.json`. R-TAQ-7 reads this manifest; R-TAQ-3 reads `exit_code` only. | IMPLEMENT |
| **R-TAQ-3** | mux-runner runs `audit-ticket-bundle.ts` after `runMuxReadinessGate` exits 0, BEFORE iteration-0 spawn *(refined: codebase-analyst — pin to existing slot at `mux-runner.ts:1494`)*. Exit non-zero halts pipeline with `exit_reason='ticket_audit_failed'`. Bypass: `state.flags.skip_ticket_audit_reason='<reason>'` (mirrors `skip_readiness_reason`); activity event `ticket_audit_bypassed`. | IMPLEMENT |
| **R-TAQ-4** | `pickle-refine-prd.md` Step 7a Decompose adds "Failure-mode checklist" subsection with 7 defect classes + examples. Decomposition agents write 1-line audit comment per ticket body confirming each class checked. Audit comment format: `<!-- audit: 7-class checked 2026-05-04 -->`. | IMPLEMENT |
| **R-TAQ-5** | Cross-document validator (subset of R-TAQ-2): for every ticket creating a file, scan `**/*.md ∩ git-tracked` for references. Reference = path-shaped token in backticks OR fenced code blocks; exact basename match. Flag drift as `cross-doc-naming-drift`. | IMPLEMENT |
| **R-TAQ-6** | Backfill audit on snapshot `extension/tests/fixtures/baseline-2026-05-03-7d9ee8cc/` (per R-BUNDLE-2): produces findings report matching ≥12 documented defects. Bound to fixture file `extension/tests/fixtures/audit-ticket-bundle/2026-05-03-7d9ee8cc-expected.json`. | IMPLEMENT |
| **R-TAQ-7** | `refinement_manifest.json` schema gains `ticket_quality_warnings: [{ticket_id, defect_class, evidence}]`. Populated by R-TAQ-1 (analyst-side) and R-TAQ-2 (post-decomp); operator sees single-pane summary before launch. | IMPLEMENT |

### C.2 — Worker silent-exit (R-WSE-1..4 from 1h)

| ID | Requirement | Disposition |
|---|---|---|
| **R-WSE-1** *(refined)* | Add helper `flushAndExit(sessionLog: fs.WriteStream, code: number): Promise<never>` to `extension/src/services/worker-shutdown.ts` (NEW): `sessionLog.end()` + `await once(sessionLog, 'close')` + `process.exit(code)`. Migrate `process.exit()` calls in `spawn-morty.ts` per exhaustive map: line 310 UNCHANGED (early-args-error, no sessionLog yet); line 733 REPLACE `sessionLog.destroy()` → `await flushAndExit(sessionLog, 1)`; line 756 REPLACE callback form → `await flushAndExit(sessionLog, 127)`; lines 764, 799, 849 REPLACE bare `process.exit(...)` → `await flushAndExit(sessionLog, code)`. **Limitation documented**: addresses graceful-exit class only. SIGKILL/segfault/OOM still produces 0-byte log; R-WSE-2 covers all classes via `worker_partial_lifecycle_exit` event. | IMPLEMENT |
| **R-WSE-2** | When worker exits with research-review APPROVED but downstream lifecycle artifacts missing, mux-runner emits `worker_partial_lifecycle_exit` with `{ticket: <id>, artifacts_missing: [...], session_log_size: <bytes>}`. | IMPLEMENT |
| **R-WSE-3** | mux-runner exit-validation: if `status: Failed` AND research_review.md ends in `APPROVED`, log stderr breadcrumb. Format: `[warn] [<ISO-8601>] ⚠ ticket <id> failed AFTER research APPROVED — see <session_dir>/<id>/`. | IMPLEMENT |
| **R-WSE-4** | `send-to-morty.md`: "Do NOT emit `<promise>I AM DONE</promise>` until ALL six lifecycle phases (research, plan, implement, verify, review, refactor) have produced their artifacts." | IMPLEMENT |

### C — Acceptance Criteria *(refined)*

- **AC-TAQ-01** — `grep -c "git ls-files" extension/src/bin/spawn-refinement-team.ts` ≥ 1. Type: lint.
- **AC-TAQ-02** — `audit-ticket-bundle.ts` runs against fixture; exits 0 on clean, non-zero on defective. Type: test.
- **AC-TAQ-03** — mux-runner halts on audit-bundle exit non-zero. Pinned to slot post-`runMuxReadinessGate`. Type: test.
- **AC-TAQ-04** *(refined)* — `pickle-refine-prd.md` "Failure-mode checklist" structurally lints (next 7 bullets enumerate all defect classes). Replaces grep-fragility. Type: lint.
- **AC-TAQ-05** — Cross-doc validator catches matrix-vs-ticket drift. Test fixture: bundle PRD's own `extension/pickle_settings.json` vs `pickle_settings.json` drift. Type: test.
- **AC-TAQ-06** *(refined)* — Backfill audit on snapshot produces ≥12 findings; bound to `extension/tests/fixtures/audit-ticket-bundle/2026-05-03-7d9ee8cc-expected.json`. Type: integration.
- **AC-TAQ-07** — `refinement_manifest.json` contains `ticket_quality_warnings` field; schema-valid. Type: test.
- **AC-TAQ-08** *(NEW R-TAQ-2b)* — Audit manifest validates against schema v1 for both clean and defective fixture sessions. Type: test.
- **AC-TAQ-09** *(NEW)* — Defective fixture in `extension/tests/fixtures/audit-ticket-bundle/defective/` enumerates exactly one ticket per defect class (8 fixtures); audit produces 8 findings, severity `fatal`. Clean fixture → zero findings. Type: test.
- **AC-WSE-01** — Session log size > 0 bytes for any worker that emits output. Type: test.
- **AC-WSE-02** — `worker_partial_lifecycle_exit` event recorded. Type: test.
- **AC-WSE-03** — Stderr breadcrumb format matches pinned regex. Type: test.
- **AC-WSE-04** *(refined)* — `grep -c "ALL six lifecycle phases" .claude/commands/send-to-morty.md` ≥ 1. Type: lint.
- **AC-WSE-05** *(NEW)* — `extension/tests/worker-session-log-flush.test.js` parametrizes over 5 mutated exit sites (lines 733, 756, 764, 799, 849). Each: simulate trigger, observe `worker_session_<pid>.log` size ≥ 1 byte AND last-line-written present in file content. Line 310's `die()` excluded. Type: test.

### C — Files in scope

`extension/src/bin/spawn-refinement-team.ts`, `spawn-morty.ts`, `mux-runner.ts`, `extension/src/bin/audit-ticket-bundle.ts` (NEW), `extension/src/services/worker-shutdown.ts` (NEW), `extension/src/types/audit-ticket-bundle.schema.json` (NEW), `.claude/commands/pickle-refine-prd.md`, `.claude/commands/send-to-morty.md`, test fixtures + tests, `extension/CLAUDE.md`.

## Section D — Readiness contract resolver false positives *(refined)*

| ID | Requirement | Disposition |
|---|---|---|
| **R-RTRC-1** | Refinement-team analyst prompts gain "Forward-reference hygiene" section. Backtick path/symbol ONLY when artifact exists at HEAD; bundle-created artifacts annotated with `(created by ticket <hash>)` per R-RTRC-7 schema; stdlib/external never backticked. | IMPLEMENT |
| **R-RTRC-2** | `check-readiness.ts` `extractContractReferences()` skips backticked tokens followed by `(created by ticket <hash>)` or `(introduced by ticket <hash>)` parenthetical (R-RTRC-7 schema). Document convention in `extension/CLAUDE.md`. | IMPLEMENT |
| **R-RTRC-3** | `resolveSymbolRef()` at `check-readiness.ts:264` lifts `tests/` exclusion ONLY. Extension allowlist `(ts\|tsx\|js\|jsx\|mjs\|cjs)` unchanged. Symbols in non-source files (JSON fixtures, MD prompts) need separate handling via R-RTRC-5 allowlist or R-RTRC-7 annotation. | IMPLEMENT |
| **R-RTRC-4** | `resolvePathRef()` falls back to `git ls-files | grep '/<ref>$\|^<ref>$'`. | IMPLEMENT |
| **R-RTRC-5** | `extension/.readiness-allowlist.json` (NEW; NOT `.cli-pins.json` which is unrelated CLI version pins). Each entry needs `source:` field; entries without rejected by `extension/scripts/audit-readiness-allowlist.sh` (NEW lint). | IMPLEMENT |
| **R-RTRC-6** | Regression suite: 3 fixture tickets exercising each of RC-1..RC-4 (forward-ref-annotated bundle artifact, test-defined helper, deep repo path, stdlib API). Contract-only run exits 0. | IMPLEMENT |
| **R-RTRC-7** *(NEW)* | Forward-reference annotation schema. `(created by ticket <hash>)` and `(introduced by ticket <hash>)` follow exact convention: position OUTSIDE backticks, separated by exactly one ASCII space; hash format = 8-char short SHA OR ticket-dir basename (e.g. `dddee00b`); both formats accepted, resolver normalizes by length; written by analysts at refinement time AND operators at PRD-author time; stale annotation → `cross-doc-stale-annotation` warning (NOT fatal). | IMPLEMENT |

### D — Acceptance Criteria *(refined)*

- **AC-RTRC-01** — Re-run `node check-readiness.ts --session-dir <fixture> --contract-only` against regression fixture; exit 0. Type: test.
- **AC-RTRC-02** — `grep -c "Forward-reference hygiene" extension/src/bin/spawn-refinement-team.ts` ≥ 1. Type: lint.
- **AC-RTRC-03** — `resolveSymbolRef` finds test-defined helpers. Type: test.
- **AC-RTRC-04** — `resolvePathRef` finds deep paths via `git ls-files` suffix-match. Type: test.
- **AC-RTRC-05** — Allowlist works AND lint rejects entries without `source:`. Type: test.
- **AC-RTRC-06** — On snapshot `baseline-2026-05-03-7d9ee8cc/`, check-readiness exits 0 with NO `state.flags.skip_readiness_reason`. Type: integration.
- **AC-RTRC-07** *(NEW)* — Resolver accepts both 8-char SHA and ticket-dir basename annotations; mismatched separator (no-space, two-space, tab) fails with `annotation-format-error`. Type: test.

### D — Files in scope

`extension/src/bin/spawn-refinement-team.ts`, `extension/src/bin/check-readiness.ts:264 resolveSymbolRef + resolvePathRef + extractContractReferences`, `extension/.readiness-allowlist.json` (NEW), `extension/scripts/audit-readiness-allowlist.sh` (NEW), `extension/tests/check-readiness-forward-ref-fixture.test.js` (NEW), `extension/tests/check-readiness-forward-ref-annotation.test.js` (NEW), `extension/CLAUDE.md`.

## Section E — Monitor watchdog *(refined)*

**Naming change (R7):** all new symbols use `RESPAWN_WATCHDOG_*` prefix to avoid collision with existing `MONITOR_STDOUT_WATCHDOG_MS`. Ships first commit of Section E.

| ID | Requirement | Disposition |
|---|---|---|
| **R-MWR-1** *(refined)* | `monitor.ts` registers continuous watchdog: `setInterval(() => { try { restartDeadWatcherPanes(opts) } catch (err) { log(err) } }, RESPAWN_WATCHDOG_INTERVAL_MS).unref()`. `RESPAWN_WATCHDOG_INTERVAL_MS = 30_000`. Helper `startRespawnWatchdog()` wraps the setInterval. Argument resolution delegated to existing helper — PRD does NOT prescribe arg list. | IMPLEMENT |
| **R-MWR-2** | `process.env.PICKLE_MONITOR_WATCHDOG === 'off'` disables watchdog. | IMPLEMENT |
| **R-MWR-3** | Watchdog respawn decisions logged via `appendWatcherRestartLog`, tagged `monitor-watchdog:`. | IMPLEMENT |
| **R-MWR-4** | `log-watcher.ts`, `morty-watcher.ts`, `raw-morty.ts` do NOT exit on EOF. Poll for size growth or file re-creation indefinitely until `StateManager.read()` reports session inactive. | IMPLEMENT |
| **R-MWR-5** *(refined)* | `refinement-watcher.ts` uses manifest-poll (NOT file-tail) — different architecture. Resilience requirement: refinement-watcher survives manifest rewrite (refinement_manifest.json overwritten); polls indefinitely until `shouldStopForInactiveSession`. R-MWR-6 banner-reservation does NOT apply. | IMPLEMENT |
| **R-MWR-6** *(refined)* | `◤ FEED TERMINATED ◢` banner reserved for explicit liveness-probe inactive exit, never EOF — applies to file-tail watchers (`log-watcher`, `morty-watcher`, `raw-morty`). Refinement-watcher EXCLUDED (no banner code at all). EOF prints at most one dim `(reconnecting...)` line. | IMPLEMENT |
| **R-MWR-7** | Regression test in `extension/tests/monitor-watchdog.test.js` (NEW): mock dead pane (non-`node` process probe), advance fake timer 30s, assert respawn invoked exactly once. | IMPLEMENT |
| **R-MWR-8** | Regression test in `extension/tests/log-watcher.test.js` (extend) + parametrized over 3 file-tail watchers: synthesize tailed log, write content, truncate, write more content. Watcher process stays alive across truncate AND consumes post-truncate content. | IMPLEMENT |

### E — Acceptance Criteria *(refined)*

- **AC-MWR-01** — `monitor.ts` registers 30s setInterval (with `.unref()`) calling `restartDeadWatcherPanes` via `startRespawnWatchdog()`. Type: test.
- **AC-MWR-02** *(refined)* — Killing pane 0/1/2/3 mid-iteration → respawn within ≤45s *(refined: codebase-analyst — 45s = 30s watchdog + 1-3s tmux + 10-15s slack; 60s masks stuck watchdog)*. Parametrized: `describe.each([{pane: 0, name: 'dashboard'}, {pane: 1, name: 'log-watcher'}, {pane: 2, name: 'morty-watcher'}, {pane: 3, name: 'raw-morty'}])` *(resolves AC-shape smell)*. Type: integration.
- **AC-MWR-03a** *(replaces AC-MWR-03)* — File-tail watchers (`log-watcher`, `morty-watcher`, `raw-morty`) survive `truncate -s 0`. Parametrized via `describe.each(['log-watcher', 'morty-watcher', 'raw-morty'])`. Each: process stays alive across truncate, prints at most one `(reconnecting...)` line, consumes post-truncate content. Type: test.
- **AC-MWR-03b** *(NEW)* — Refinement-watcher survives manifest rewrite (`refinement_manifest.json` overwritten with new content). Polls indefinitely; rewrite consumed without exit. R-MWR-6 banner rule does NOT apply. Type: test.
- **AC-MWR-04** *(refined)* — `PICKLE_MONITOR_WATCHDOG=off` disables timer. Plus: `RESPAWN_WATCHDOG_INTERVAL_MS` and `MONITOR_STDOUT_WATCHDOG_MS` are distinct symbols (no shared scope). Type: test.
- **AC-MWR-05** — `mux-runner.log` shows `monitor-watchdog: respawned <name> in pane <N>` lines distinct from boundary-driven `restartDeadWatcherPanes:`. Type: test.
- **AC-MWR-06** — Trap-door in `extension/CLAUDE.md`: monitor.ts watchdog INVARIANT. Type: lint.
- **AC-MWR-07** — Trap-door extended for each watcher: EOF resilience invariant. Type: lint.

### E — Files in scope

`extension/src/bin/monitor.ts`, `log-watcher.ts`, `morty-watcher.ts`, `raw-morty.ts`, `refinement-watcher.ts`, `extension/tests/monitor-watchdog.test.js` (NEW), `extension/tests/log-watcher.test.js` (extend), `extension/tests/refinement-watcher-manifest-rewrite.test.js` (NEW), `extension/CLAUDE.md`.

## Bundle-level requirements *(NEW Cycle 3)*

| ID | Requirement | Disposition |
|---|---|---|
| **R-BUNDLE-1** | `state.flags.bundle_bootstrap_mode = "2026-05-04-v1.70.0"` with hardcoded session-hash allowlist auto-applies BOTH `skip_readiness_reason` AND `skip_ticket_audit_reason` for THIS bundle's launch only. Activity event `bundle_bootstrap_exemption_applied` records both. | IMPLEMENT |
| **R-BUNDLE-2** | Snapshot `~/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/` to `extension/tests/fixtures/baseline-2026-05-03-7d9ee8cc/` BEFORE bundle launch. R-XBL-6 + R-TAQ-6 backfill ACs reference snapshot, not live session. Snapshot creation is part of bundle-launch checklist; `pruneOldSessions` 7-day cutoff doesn't affect fixtures. | IMPLEMENT |
| **R-BUNDLE-DISPO-1** | Disposition table (above) is committed at `extension/src/data/bundle-disposition-2026-05-04.json`. Refinement-team analyst prompts (R-TAQ-1, R-XBL-9) read this file by path. R-TAQ-2 audit-ticket-bundle reads dispositions to exempt `REGRESSION-TEST-ONLY`/`DROP` from `hallucinated-premise` check. | IMPLEMENT |
| **R-CLOSER-1** | `extension/scripts/closer-release-gate.sh` (NEW): pre-flight `gh api rate_limit` ≥100 reqs; `gh release create v1.70.0 --latest --notes-file <path>` with retry-on-429 (3 retries, 30s backoff); post-flight `gh release view v1.70.0 --json isLatest --jq '.isLatest'` returns true AND `gh release view v1.66.0 ...` returns false. On failure post-`git push`: do NOT rewrite history, do NOT amend tag; print stderr `[halt] release gate partial failure — manual recovery: <command>`. Tag creation is the LAST step. | IMPLEMENT |

## Bundle-level Acceptance Criteria *(refined)*

| AC | Verification |
|---|---|
| **AC-BUNDLE-01** — All 6 source PRDs' AC sets pass | Each section's AC list above |
| **AC-BUNDLE-02** — Full release gate clean | `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-canary-flip.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && bash scripts/audit-readiness-allowlist.sh && bash scripts/audit-runtime-imports.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive` |
| **AC-PIPELINE-PHASES-01** *(replaces AC-BUNDLE-03; renamed to avoid collision with `bundle-state-integrity.ts AC-BUNDLE-03`)* | `pipeline-status.json.status === 'completed'` AND `pipeline-status.json.completed_phases` enumerates the canonical 3-phase array `["pickle-build", "anatomy-park", "szechuan-sauce"]` (verified against `pipeline-runner.ts` write-points before locking literal). Type: integration. |
| **AC-BUNDLE-04** *(refined R18 carve-out)* | R-XBL-6 `audit-worker-backends.ts` on the new bundle session reports zero `worker_spawn_backend_resolved`-vs-state mismatches. `subtool_backend_override` events are EXCLUDED from leak count and reported separately as informational. |
| **AC-BUNDLE-05** | R-TAQ-2 `audit-ticket-bundle.ts` on the new bundle session exits 0 OR exits with only pre-decomposition warnings the operator accepted via `state.flags.skip_ticket_audit_reason`. |
| **AC-BUNDLE-06** | New bundle session's `state.json` does NOT carry `flags.skip_readiness_reason` (after bundle ships clean on FRESH probe session, not THIS session which uses `bundle_bootstrap_mode`). pipeline-runner.log shows readiness gate passed. |
| **AC-BUNDLE-07** *(replaces md5 list)* | Existing AC-RVN-08 deploy/source parity invariant remains green after closer commit (`assertSchemaVersionDeployParity()` passes). |
| **AC-BUNDLE-08** | `gh release create v1.70.0 --latest` succeeds via R-CLOSER-1 script. Post-flight: `gh release view v1.70.0 --json isLatest` true AND `gh release view v1.66.0 --json isLatest` false. v1.66.0 is no longer GitHub-Latest. |

## Closer

A single closer ticket performs:

1. Bumps `extension/package.json` 1.69.0 → 1.70.0 (Minor — features: auto-resume daemon, audit-ticket-bundle, monitor watchdog, smoke gate, bootstrap mode; fixes: cross-backend leak detection, deploy ts symlink test, readiness false-positives, R-XBL-4 regression).
2. Runs full release gate per AC-BUNDLE-02.
3. `git push` (74+ commits + bundle commits).
4. Invokes `extension/scripts/closer-release-gate.sh` (R-CLOSER-1) — tag creation is LAST step.
5. Posts `state.activity` event `bundle_2026_05_04_closer_done` with release URL. Consumer: monitor pane footer + `/pickle-standup` next-day report.

## Bundle execution constraints *(refined)*

- **Backend**: codex (spark) per operator direction. Slot 1l shipped means default `codex_model = gpt-5.3-codex-spark`. Codex usage limit on prior tier resets 2026-05-05 00:31; spark tier has its own budget.
- **Refinement-team is claude-only** by design (`REFINEMENT_BACKEND` hardcoded). Pipeline phase spawns codex; refinement is unaffected by `--backend codex`.
- **Bootstrap mode**: launch with `state.flags.bundle_bootstrap_mode = "2026-05-04-v1.70.0"` (R-BUNDLE-1 single flag bypasses both gates).
- **Per-tier cap**: until R-CNAR-1 ships, expect cap-hit halts on tier:medium tickets at 15 iter. After R-CNAR-2 ships within this bundle, set `PICKLE_AUTO_RESUME_ON_CAP_HIT=1`. Foreground wrapper only (R21).
- **Mandatory operator presence for first 30 min** of bundle (R-CNAR-6 smoke gate window). Post-30min, bundle is autonomous.
- **Codex-spark recovery CUJ (R20)**:
  1. Operator sees `pipeline_phase_incomplete` halt with stderr `codex_rate_limited (429)`.
  2. Decision: wait-for-reset OR backend-flip-to-claude.
  3. Backend-flip: `state.backend = "claude"` AND `state.flags.backend_flip_reason = "codex-spark-rate-limit"`; R-XBL-3 mismatch check bypassed for next iteration only.
  4. Wait-for-reset: `PICKLE_AUTO_RESUME_ON_CAP_HIT=0`; relaunch manually.
- **Pre-launch cleanup**: `bundle/ac-dr-02.json` gitignore + remove from tree (committed before bundle launch).
- **DO NOT push commits mid-bundle**. Closer ticket bundles all pushes via R-CLOSER-1.
- **Pipeline-runner phase contract**: 3 review phases `pickle-build → anatomy-park → szechuan-sauce`. Citadel is a separate command (`/citadel`), NOT a pipeline-runner phase.

## Out of scope for this bundle

- 1l codex-spark wiring (already SHIPPED locally; tag with v1.70.0).
- Adding `xlarge` complexity tier (7+ file blast radius via 5 state-field invariants).
- Creating a new `launch.sh` artifact (R19 — use mux-runner.js directly).
- Detached/`setsid`/`nohup` daemon architecture (R21 — foreground only).
- Any new PRDs surfaced during this bundle's run — file as new queue slots.

## Implementation Task Breakdown

See `## Implementation Task Breakdown` table appended at end of this PRD after decomposition.

## Cross-references

- Six source PRDs in `peer_prds.composes` above
- Bootstrap context: `CONTEXT_2026-05-04.md`
- Operational plan: `prds/MASTER_PLAN.md` `## ▶ Recommended next move` item 2
- Refinement artifacts: `${SESSION_ROOT}/refinement/analysis_*.md`, `refinement_manifest.json`
- 3-cycle analyses: requirements (54K), codebase (37K), risk-scope (43K) — each at Cycle 3 depth
- Empirical session: `~/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/`

— Pickle Rick out. *belch*

## Implementation Task Breakdown

| Order | ID | Title | Priority | Tier | Files |
|---|---|---|---|---|---|
| 100 | 52277694 | Add worker_spawn_backend_resolved activity event in spawn-morty.ts | High | small | (per ticket Files section) |
| 110 | 8224fc7f | Single source of truth — read state.backend at 4 real spawn sites (R-XBL-2) | High | medium | (per ticket Files section) |
| 120 | 160e8816 | R-XBL-2b — spawn-gate-remediator inheritance audit event | High | small | (per ticket Files section) |
| 130 | 4d7c4cfa | Pre-spawn assertion + backend_flip_reason carve-out (R-XBL-3) | High | medium | (per ticket Files section) |
| 140 | 72386a22 | R-XBL-5 — Sub-tool override events with AC-BUNDLE-04 carve-out | High | small | (per ticket Files section) |
| 150 | 2e004a2c | R-XBL-6 — audit-worker-backends.ts backfill audit script | High | medium | (per ticket Files section) |
| 160 | 0d7168ad | R-XBL-7 — Integration test: env-poison defense | Medium | small | (per ticket Files section) |
| 170 | 44c5ab6e | R-XBL-7b — Integration test: reproduces actual session 2026-05-03-7d9ee8cc bug | Medium | small | (per ticket Files section) |
| 180 | 897e05d6 | R-XBL-8 — Trap-door entry in extension/CLAUDE.md | Medium | small | (per ticket Files section) |
| 190 | c1cf3a92 | R-XBL-9 — Refinement-team prompts reference new event schemas | Medium | small | (per ticket Files section) |
| 200 | 68905ecd | AC-XBL-08 — Manager-relaunch backend-flip regression test (replaces dropped R-XBL-4) | Medium | small | (per ticket Files section) |
| 210 | f05fb934 | AC-EVENT-PAYLOAD-01 — activity-events.schema.json + parametrized validation | High | medium | (per ticket Files section) |
| 220 | b49852f8 | Pre-launch: gitignore + remove bundle/ac-dr-02.json from tree | High | trivial | (per ticket Files section) |
| 230 | f929d490 | R-DTS-1 — Regression assertion for typescript symlink (already-shipped) | High | small | (per ticket Files section) |
| 240 | 7dc2f5ea | R-DTS-2 — audit-runtime-imports.sh + JSON manifest | High | medium | (per ticket Files section) |
| 250 | 8be0d8cb | R-DTS-3 — Module-load smoke (replaces nonexistent --help flag) | High | small | (per ticket Files section) |
| 260 | 51d826c9 | R-CNAR-1 — tier_caps schema + getTicketTierBudgetWithOverrides + invariant-chain extension | High | large | (per ticket Files section) |
| 270 | f5618ebf | R-CNAR-2 — auto-resume.sh foreground wrapper (no launch.sh) | High | medium | (per ticket Files section) |
| 280 | adaaae6b | R-CNAR-3 — pipeline_auto_resumed activity event | Medium | small | (per ticket Files section) |
| 290 | 8ae2137e | R-CNAR-4 — Stop conditions (PROGRESS_THRESHOLD + MAX_WALL_SECONDS) | High | medium | (per ticket Files section) |
| 300 | c3c75812 | R-CNAR-5 — Auto-resume regression test + SIGTERM kill-tree (R21) | Medium | medium | (per ticket Files section) |
| 310 | ea45c78c | R-CNAR-6 — Spark codex smoke-run gate | High | large | (per ticket Files section) |
| 340 | d424e487 | R-TAQ-1 — Analyst verification block in spawn-refinement-team.ts | High | small | (per ticket Files section) |
| 350 | b548a16e | R-TAQ-2 — audit-ticket-bundle.ts validator (7 defect classes) | High | large | (per ticket Files section) |
| 360 | 15127c82 | R-TAQ-2b — audit-ticket-bundle.schema.json (versioned manifest schema) | High | small | (per ticket Files section) |
| 370 | bab38c02 | R-TAQ-3 — mux-runner gate integration (post-readiness slot) | High | medium | (per ticket Files section) |
| 380 | 3e776f42 | R-TAQ-4 — Failure-mode checklist in pickle-refine-prd.md | Medium | small | (per ticket Files section) |
| 390 | 59a8b5ef | R-TAQ-5 — Cross-document validator (subset of audit-ticket-bundle) | Medium | medium | (per ticket Files section) |
| 400 | 65acc943 | R-TAQ-6 — Backfill audit on snapshot baseline-2026-05-03-7d9ee8cc | High | medium | (per ticket Files section) |
| 410 | 71905727 | R-TAQ-7 — refinement_manifest schema gains ticket_quality_warnings | Medium | small | (per ticket Files section) |
| 420 | 018f32d2 | R-WSE-1 — flushAndExit helper + per-site migration in spawn-morty.ts | High | medium | (per ticket Files section) |
| 430 | 3b976e6e | R-WSE-2 — worker_partial_lifecycle_exit event | High | small | (per ticket Files section) |
| 440 | c5bd304e | R-WSE-3 — Stderr breadcrumb on ticket-fail-after-research-approved | Medium | small | (per ticket Files section) |
| 450 | 58fac5e3 | R-WSE-4 — send-to-morty.md prompt update (six lifecycle phases) | Medium | trivial | (per ticket Files section) |
| 460 | f8153c03 | AC-WSE-05 — worker-session-log-flush parametrized test (5 exit sites) | Medium | small | (per ticket Files section) |
| 470 | 5beb7594 | AC-TAQ-09 — Defective + clean fixture sessions for audit-ticket-bundle | Medium | small | (per ticket Files section) |
| 480 | 5c75a9eb | R-RTRC-1 — Forward-reference hygiene in analyst prompts | High | small | (per ticket Files section) |
| 490 | c92566c2 | R-RTRC-2 — extractContractReferences skip annotated tokens | High | small | (per ticket Files section) |
| 500 | 4f4b57de | R-RTRC-3 — Lift tests/ exclusion at check-readiness.ts:264 | Medium | trivial | (per ticket Files section) |
| 510 | 5061cfbd | R-RTRC-4 — git ls-files suffix-match fallback in resolvePathRef | Medium | small | (per ticket Files section) |
| 520 | abefd0d5 | R-RTRC-5 — .readiness-allowlist.json + audit-readiness-allowlist.sh lint | Medium | small | (per ticket Files section) |
| 530 | bad6cb66 | R-RTRC-6 — Regression suite (3 fixture tickets covering RC-1..RC-4) | Medium | small | (per ticket Files section) |
| 540 | 7c72918a | R-RTRC-7 — Forward-ref annotation schema + format test | Medium | small | (per ticket Files section) |
| 570 | b178b3d5 | R-MWR-rename — RESPAWN_WATCHDOG_INTERVAL_MS rename (lands first in Section E) | High | trivial | (per ticket Files section) |
| 580 | ce7b0bf2 | R-MWR-1 — monitor.ts continuous watchdog setInterval | High | small | (per ticket Files section) |
| 590 | 1eb67cc5 | R-MWR-2 — Kill-switch via PICKLE_MONITOR_WATCHDOG=off | Medium | trivial | (per ticket Files section) |
| 600 | e7ecc172 | R-MWR-3 — Watchdog respawn-decision logging | Medium | trivial | (per ticket Files section) |
| 610 | db16ca78 | R-MWR-4 — File-tail watchers EOF resilience (3 watchers) | High | medium | (per ticket Files section) |
| 620 | 528f2f32 | R-MWR-5 — refinement-watcher manifest-poll resilience (separate path) | Medium | small | (per ticket Files section) |
| 630 | 04eead65 | R-MWR-6 — Banner reservation (3 file-tail watchers only) | Medium | trivial | (per ticket Files section) |
| 640 | 739314cf | R-MWR-7 — Watchdog regression test (mock dead pane) | Medium | small | (per ticket Files section) |
| 650 | 9270858f | R-MWR-8 — Watcher truncate parametrized test | Medium | small | (per ticket Files section) |
| 660 | b3b22bb2 | R-BUNDLE-1 — bundle_bootstrap_mode flag with session-hash allowlist | High | small | (per ticket Files section) |
| 670 | 6b76617f | R-BUNDLE-2 — Snapshot baseline-2026-05-03-7d9ee8cc/ before launch | High | small | (per ticket Files section) |
| 680 | 7a2a2764 | R-BUNDLE-DISPO-1 — Disposition table JSON (52 IMPL + 1 DROP + 1 RTO) | High | small | (per ticket Files section) |
| 690 | 638c5db1 | R-CLOSER-1 — closer-release-gate.sh (idempotent under partial gh failures) | High | medium | (per ticket Files section) |
| 700 | 7793b88a | Wire: integrate bundle subsystems (auto-resume + smoke-gate + audit + bootstrap-mode + watchdog) | High | large | (per ticket Files section) |
| 710 | 6b4de66b | Harden: code quality review of bundle subsystems | High | large | (per ticket Files section) |
| 720 | 2a7d0000 | Audit: data flow integrity for bundle subsystems | High | large | (per ticket Files section) |
| 730 | 50894a9f | Harden: test quality review of bundle subsystems | High | large | (per ticket Files section) |
| 740 | aadcd07e | Audit: cross-reference consistency for bundle subsystems | High | large | (per ticket Files section) |
| 750 | bdbf368d | Closer: bump 1.69.0 → 1.70.0 + closer-release-gate.sh + push 74+ commits + tag v1.70.0 | High | large | (per ticket Files section) |

## Session Notes

### 2026-05-04 evening — Run #2 — circuit-tripped after 28min, 5 commits landed

**Commits:**
- `9437b0c` — R-CNAR-1: TICKET_TIER_BUDGETS raised (mine, direct-execute)
- `817e73c` — R-XBL-2: read-side SoT at 4 spawn sites (mine, direct-execute)
- `a3641e3` — R-XBL-2: worker overlay pass (added `assertBackendPreSpawn` import + `worker_spawn_backend_mismatch` event prep)
- `616f474` — R-XBL-2b: spawn-gate-remediator inheritance audit event
- `95f2c37` — R-XBL-3: write-side tripwire (`assertBackendPreSpawn()` + `state.flags.backend_flip_reason` carve-out)

**Path C direct-execute pattern justified:** the bundle's keystones (R-XBL-2, R-CNAR-1) needed to ship before the bundle could process them via the normal pickle loop, because *those exact bugs* were what blocked the previous run. Operator landed them manually, then the worker layered its own pass on top via the bundle. Both passes co-exist correctly (the worker's `assertBackendPreSpawn` augments rather than replaces the SoT read).

**Run #2 failure timeline (16:59→17:28 local):**

| t | event |
|---|---|
| 16:59:23 | tmux relaunch; pipeline-runner + mux-runner up |
| 17:00 | first install.sh deployed compiled JS; `extension/types/index.js` md5 mismatch (slot 1q) — `WARN: ignoring unknown activity event worker_spawn_backend_resolved` from this point on |
| 17:01–17:04 | R-XBL-2 / R-XBL-2b / R-XBL-3 worker passes commit (`a3641e3 616f474 95f2c37`); workers DON'T write `completion_commit:` to ticket frontmatter (slot 1p) |
| ~17:15–17:23 | codex-spark MANAGER hallucinates: "I'll try one last time under Hermes for that ticket, which previously fa…" — writes `state.backend = 'hermes'` directly to disk (slot 1j H3 confirmed) |
| 17:28:01 | Phantom-Done watcher correctly reverts `8224fc7f / 160e8816 / 4d7c4cfa` to Todo (no `completion_commit:` in frontmatter despite real git commits) |
| 17:28:02–22 | iterations 3–6 fire in 20 sec (degenerate fast-loop); circuit breaker opens on tier=small budget=4 |
| 17:28:22 | Pipeline exits `step=completed exit_reason=failed`, `0/4 phases` |

**Three new findings filed in MASTER_PLAN as slots 1o / 1p / 1q:**

1. **F1 / slot 1o — manager/worker backend split.** R12 ("Spark backend has unproven reliability") materialized at the manager tier. Fix: introduce `state.worker_backend` (optional). Manager runs `state.backend` (claude/sonnet — reliable narration); workers run `state.worker_backend` (codex-spark — cheap+parallel). ~15 LOC + state-field invariant + test. Symmetrical with `state.codex_model`. Eliminates F1 hallucination class entirely.
2. **F2 / slot 1p — codex-spark worker `completion_commit:` contract violation.** Workers commit to git but skip the YAML field. Phantom-Done correctly reverts. Fix: post-commit wrapper auto-fills frontmatter from `git log -1 --format=%H -- <ticket-path>`, OR phantom-Done watcher cross-checks `git log` before reverting.
3. **F3 / slot 1q — install.sh post-rsync md5 parity probe missing.** First install.sh after R-CNAR-1 + R-XBL-2 left `extension/types/index.js` deployed-stale (8 events missing). Fix: install.sh forces `rm types/index.js && tsc` BEFORE rsync, then post-rsync md5-parity asserts on 5 most-trafficked compiled files. Documented under prds/archive/bug-reports/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md as Bug C / R-DTS-4..6.

**Run #3 prerequisites (operator checklist):**

1. Restore phantom-reverted Done tickets — manually patch `completion_commit:` into frontmatter for `8224fc7f` (sha `a3641e3`), `160e8816` (sha `616f474`), `4d7c4cfa` (sha `95f2c37`). Set `status: Done`.
2. Ship slot 1o (`state.worker_backend` field) — block run #3 on this.
3. Reset session state: `state.backend='claude'`, `state.worker_backend='codex'`, `state.codex_model='gpt-5.3-codex-spark'`. Reset Failed/Skipped→Todo. Reset circuit_breaker.json to CLOSED.
4. Verify install.sh deploy parity before tmux launch (`md5 extension/types/index.js ~/.claude/pickle-rick/extension/types/index.js`).

R-XBL-3 is now deployed and will catch any residual backend flip pre-spawn — belt-and-suspenders even with the manager-role split.
