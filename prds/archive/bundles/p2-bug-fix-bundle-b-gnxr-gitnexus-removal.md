---
title: P2 bundle — B-GNXR — Remove GitNexus integration entirely (root-fix R-GNDT) + pipeline-runner robustness (R-PFNP, R-PRNF)
status: Draft
filed: 2026-06-04
priority: P2
type: bug-bundle
code: B-GNXR
composes:
  - "#96 R-GNDT — setup.js GitNexus graph-preflight (`gitnexus analyze`) rewrites tracked CLAUDE.md/AGENTS.md index stats → dirty tree → pipeline-runner FATAL self-brick. RESOLVED BY REMOVAL: deleting the GitNexus integration removes the mutator entirely (no preflight, no stat-drift, no self-brick)."
  - "#97 R-PFNP — pipeline-runner dirty-tree preflight ignore-prefix matches only top-level docs/prds; nested packages/api/docs/prd/ blocks launch. GitNexus-INDEPENDENT robustness fix — kept."
  - "#98 R-PRNF — pipeline-runner treats a readiness-HALTED pickle phase as a recoverable partial build and reports a zero-build pipeline 'complete'. GitNexus-INDEPENDENT correctness fix — kept."
  - "#99 R-WCUC — mux-runner no-progress detector discards completed, gate-passing-but-uncommitted worker output (keys on commits-landed not tree-changes-passing-gates) → work loss on clean-tree relaunch. GitNexus-INDEPENDENT run-integrity fix — folded in by operator (dominant codex failure mode)."
backend_constraint: claude
schema_neutral: true   # no state.json field change, no LATEST_SCHEMA_VERSION bump. Removes graph_preflight_completed/graph_preflight_degraded from the VALID_ACTIVITY_EVENTS allowlist (runtime event allowlist, not state schema) — backward-compatible: old state.json stays readable.
replaces: B-GNDT (the fix-in-place plan-of-record; operator chose full removal over patching the preflight)
source:
  - prds/archive/bug-reports/BUG-REPORT-2026-06-04-pipeline-launch-gitnexus-statdrift-dirty-tree-abort.md   # #96 R-GNDT + #97 R-PFNP + #98 R-PRNF origin (LOA-907 incident, session 2026-06-04-0204150f)
  - prds/archive/features/p2-pipeline-graph-intelligence-2026-05-21.md   # the shipped feature being removed (R-PGI-*)
  - prds/archive/features/p2-codegraph-integration.md                     # adjacent GitNexus feature spec being removed
  - prds/MASTER_PLAN.md                                  # findings #96 / #97 / #98; Drain Queue row 27
---

# B-GNXR — Remove GitNexus integration entirely + pipeline-runner robustness

> Operator decision (2026-06-04): rather than patch the GitNexus graph-preflight to stop dirtying the tree (the B-GNDT fix-in-place plan), **remove the GitNexus integration from pickle-rick-claude entirely**. This eliminates #96 R-GNDT at the root (no mutator → no stat-drift → no self-brick). The two GitNexus-independent pipeline-runner defects surfaced by the same LOA-907 incident — #97 R-PFNP (nested-docs ignore-prefix) and #98 R-PRNF (readiness-halt false-success) — are real robustness bugs and remain in scope as standalone tickets.

## Trigger

MASTER_PLAN drain row 27 (`#96 R-GNDT` + `#97 R-PFNP` + `#98 R-PRNF`), repointed from B-GNDT (fix) to B-GNXR (removal). The canonical `/pickle-pipeline` launch self-bricks on any GitNexus-indexed repo because `setup.js`'s graph-preflight runs `gitnexus analyze`, which rewrites tracked `CLAUDE.md`/`AGENTS.md` index-stat lines, dirtying the tree; the same launch path's `pipeline-runner.js` dirty-tree preflight then FATAL-aborts. Re-running setup re-dirties → infinite self-brick. (Full mechanism + evidence in the bug report.)

## Decision: remove, don't patch

GitNexus is the shipped "Pipeline Graph Intelligence" feature (R-PGI-*): a knowledge-graph index consulted by workers/refinement for impact analysis, plus a setup/pipeline graph-preflight that runs `gitnexus analyze`. Its only operational footprint in the runtime is (a) the self-bricking preflight (#96) and (b) optional per-ticket "impact slice" context injected into worker/refinement prompts. The operator has determined the integration is not worth its launch-fragility and maintenance cost. Removing it is simpler and net-deletes complexity versus teaching the preflight to run non-mutatingly.

## GitNexus footprint (confirm exact call sites in each ticket's research phase)

**Runtime source (`extension/src/`):**
- `services/graph-preflight.ts` — the whole module (`ensureGraph`, `defaultDetect/Install/Analyze`, `PINNED_GITNEXUS_VERSION`, `GraphPreflightResult`). Runs `gitnexus analyze` — the #96 mutator.
- `bin/setup.ts` — imports + calls `ensureGraph(process.cwd())` (~line 1413).
- `bin/pipeline-runner.ts` — imports + calls `ensureGraph(runtime.repoRoot)` for anatomy-park/szechuan phases (~lines 2238/2255), gated by `loadGraphPreflightEnabled()`.
- `bin/spawn-morty.ts` — `hasGitNexusIndex`, `readGitNexusRepoName`, `buildGitNexusMcpConfig` (R-PGI-6/7), per-ticket impact-slice builder, GitNexus prompt-context block, and `--mcp-config` injection of the gitnexus MCP server (~lines 587-700, 1820-1829).
- `bin/spawn-refinement-team.ts` — `hasGitNexusIndex`, `readGitNexusRepoNameForRefinement`, R-PGI-8 impact-slice context (~lines 158-214), plus the `ensureGraph` consumer path.
- `types/index.ts` — `graph_preflight_completed` + `graph_preflight_degraded` in `VALID_ACTIVITY_EVENTS` (~lines 651-652).

**Skills:** .claude/skills/gitnexus/ (dir) (7 SKILL.md: gitnexus-cli, gitnexus-debugging, gitnexus-exploring, gitnexus-guide, gitnexus-impact-analysis, gitnexus-refactoring, gitnexus-bdd).

**Commands:** GitNexus references in `.claude/commands/council-of-ricks.md`, `portal-gun.md`, `help-pickle.md`.

**Top-level docs:** `CLAUDE.md` ("# GitNexus — Code Intelligence" section + the injected stat block — the #96 drift source), `AGENTS.md`, `COMMANDS.md`, `README.md`, `roadmap.md`, `internals.md`.

**Config / on-disk (full teardown):** `mcp__gitnexus__*` permission entries in `.claude/settings.local.json`; the .gitnexus/ (dir) on-disk index directory.

**Tests:** gitnexus-only suites to delete (`graph-preflight.test.js`, `graph-preflight-wiring.test.js`, `spawn-morty-gitnexus-mcp-config.test.js`, `spawn-morty-graph-context.test.js`, `spawn-refinement-team-graph-context.test.js`); shared suites to de-gitnexus without losing non-GitNexus coverage (`spawn-morty.test.js`, `spawn-morty-helpers.test.js`, `activity-event-payload.test.js`).

## In scope

- Full removal of the GitNexus integration from the runtime, skills, commands, docs, config, and on-disk index (full teardown per operator).
- R-PFNP: pipeline-runner dirty-tree preflight ignores `docs/`/`prds/` at any path depth.
- R-PRNF: pipeline-runner treats a readiness-halted pickle phase as a hard failure (not recoverable-continue) and never reports a zero-build run as `completed`.
- R-WCUC: mux-runner no-progress detector commits gate-passing uncommitted worker output (or records the diff if gates fail) instead of discarding it; splits the `work_uncommitted` vs `no_work_produced` failure taxonomy.
- Closer: full release gate, version bump, install.sh, push, release, MASTER_PLAN repoint closing #96/#97/#98/#99.

## Not in scope

- The external `gitnexus` CLI/MCP server itself (a separately-installed tool; we remove only pickle-rick-claude's integration with it).
- The readiness gate's own logic (#98 is about the runner mis-handling a halt, not the gate — the gate correctly caught a real defect).
- Re-architecting impact analysis: workers fall back to Grep/Glob/`gitnexus_*`-free navigation. No replacement graph layer is introduced (YAGNI).
- Deleting the historical feature PRDs (`p2-pipeline-graph-intelligence`, `p2-codegraph-integration`) — they stay as archival record; the closer marks them superseded in MASTER_PLAN only.

## Atomic tickets

> Each ticket's **research phase MUST confirm exact call sites/line numbers** (the footprint above is observational from grep, not prescriptive) before editing. Removal tickets must leave `tsc --noEmit` + `eslint` green and all non-GitNexus tests passing.

### R-GNXR-1 (medium) — Remove graph-preflight service + setup/pipeline call sites (root-fix #96 R-GNDT)
- **Scope:** delete `extension/src/services/graph-preflight.ts`; remove the `import { ensureGraph }` + `await ensureGraph(...)` call sites in `extension/src/bin/setup.ts` and `extension/src/bin/pipeline-runner.ts` (including `loadGraphPreflightEnabled()` and any `pickle_settings`/env toggle that only gated the preflight). Remove the compiled `extension/services/graph-preflight.js` mirror.
- **AC-GNXR-1-1:** `test ! -f extension/src/services/graph-preflight.ts && test ! -f extension/services/graph-preflight.js` (module gone, source + mirror).
- **AC-GNXR-1-2:** `grep -rn "ensureGraph\|graph-preflight\|graphPreflight\|loadGraphPreflightEnabled" extension/src/` returns zero matches.
- **AC-GNXR-1-3 (root-fix #96):** an integration test (`extension/tests/integration/...` forward-created) runs `setup.js --tmux --resume <fixture>` against a fixture repo containing a tracked `CLAUDE.md` with a GitNexus-style stat line, and asserts `git status --porcelain` shows NO modification to `CLAUDE.md`/`AGENTS.md` attributable to setup (no `gitnexus analyze` ran). The setup→runner path stays clean.
- **AC-GNXR-1-4:** `npx tsc --noEmit` + `eslint src/ --max-warnings=-1` green after removal.

### R-GNXR-2 (medium) — Remove GitNexus from spawn-morty.ts
- **Scope:** remove `hasGitNexusIndex`, `readGitNexusRepoName`, `buildGitNexusMcpConfig`, the per-ticket impact-slice builder, the `# GITNEXUS CODE INTELLIGENCE` prompt-context block(s), and the `--mcp-config <gitnexus>` injection at the worker-spawn site in `extension/src/bin/spawn-morty.ts`. The generic worker-MCP-forwarding path (B-MFW `resolveMcpConfigPath`/`worker_mcp_config_path`) MUST be preserved — only the GitNexus-specific config injection is removed.
- **AC-GNXR-2-1:** `grep -niE "gitnexus" extension/src/bin/spawn-morty.ts` returns zero matches.
- **AC-GNXR-2-2:** the B-MFW MCP-forwarding trap door stays intact — `extension/tests/services/backend-spawn-mcp.test.js` + `extension/tests/integration/worker-mcp-access.test.js` still pass (operator MCP config forwarding unaffected).
- **AC-GNXR-2-3:** `extension/tests/spawn-morty.test.js` + `extension/tests/spawn-morty-helpers.test.js` pass with GitNexus assertions removed and all non-GitNexus coverage retained; the GitNexus-only suites (`spawn-morty-gitnexus-mcp-config.test.js`, `spawn-morty-graph-context.test.js`) are deleted.
- **AC-GNXR-2-4:** `npx tsc --noEmit` + eslint green.

### R-GNXR-3 (small) — Remove GitNexus from spawn-refinement-team.ts
- **Scope:** remove `hasGitNexusIndex`, `readGitNexusRepoNameForRefinement`, the R-PGI-8 impact-slice context, and the `ensureGraph`/`graphResult` consumer path in `extension/src/bin/spawn-refinement-team.ts`.
- **AC-GNXR-3-1:** `grep -niE "gitnexus\|ensureGraph\|graphResult" extension/src/bin/spawn-refinement-team.ts` returns zero matches.
- **AC-GNXR-3-2:** the GitNexus-only suite `spawn-refinement-team-graph-context.test.js` is deleted; `spawn-refinement-team.test.js` passes with refinement behavior otherwise unchanged (manifest atomicity, readiness path, R-RTRC hygiene all intact).
- **AC-GNXR-3-3:** `npx tsc --noEmit` + eslint green.

### R-GNXR-4 (small) — Remove graph_preflight_* activity events
- **Scope:** remove `'graph_preflight_completed'` and `'graph_preflight_degraded'` from `VALID_ACTIVITY_EVENTS` in `extension/src/types/index.ts` (+ compiled `extension/types/index.js` mirror) and from `extension/activity-events.schema.json` (and any per-event schema definitions). Update `extension/tests/activity-event-payload.test.js` expectations.
- **AC-GNXR-4-1:** `grep -rn "graph_preflight" extension/src/ extension/types/ extension/activity-events.schema.json` returns zero matches.
- **AC-GNXR-4-2:** `node extension/bin/log-activity.js graph_preflight_completed "x"` is rejected as an invalid event (no longer in the allowlist).
- **AC-GNXR-4-3:** `extension/tests/activity-event-payload.test.js` passes with the two events removed; no other event's coverage regresses.

### R-GNXR-5 (small) — Delete gitnexus skills + scrub command references
- **Scope:** `rm -rf .claude/skills/gitnexus/`; remove GitNexus references/sections from `.claude/commands/council-of-ricks.md`, `.claude/commands/portal-gun.md`, and `.claude/commands/help-pickle.md` (preserve each command's non-GitNexus content).
- **AC-GNXR-5-1:** `test ! -d .claude/skills/gitnexus`.
- **AC-GNXR-5-2:** `grep -rniE "gitnexus" .claude/commands/` returns zero matches.

### R-GNXR-6 (small) — Scrub GitNexus from docs + Documentation Rule
- **Scope:** remove the "# GitNexus — Code Intelligence" section + injected stat block from `CLAUDE.md` (the #96 drift surface); remove GitNexus sections/lines from `AGENTS.md`, `COMMANDS.md`, `README.md`, `roadmap.md`, `internals.md`. Per the project Documentation Rule, update `README.md` to reflect the removed capability.
- **AC-GNXR-6-1:** `grep -rniE "gitnexus" CLAUDE.md AGENTS.md COMMANDS.md README.md roadmap.md internals.md` returns zero matches.
- **AC-GNXR-6-2:** the CLAUDE.md "GitNexus" section AND its symbol/relationship/stat line (e.g. ``indexed by GitNexus as **pickle-rick-claude** (NNNNN symbols, …)``) are both gone — this is the line `gitnexus analyze` used to rewrite.

### R-GNXR-7 (small) — Full teardown: index dir + MCP perms
- **Scope:** delete the on-disk .gitnexus/ (dir) index directory; strip every `mcp__gitnexus__*` entry from `.claude/settings.local.json` (preserve all non-GitNexus permissions). Add .gitnexus/ (dir) to `.gitignore` if present there is removed, so a stray re-index does not re-dirty the tree.
- **AC-GNXR-7-1:** `test ! -d .gitnexus`.
- **AC-GNXR-7-2:** `grep -n "mcp__gitnexus" .claude/settings.local.json` returns zero matches; the file remains valid JSON (`node -e "JSON.parse(require('fs').readFileSync('.claude/settings.local.json','utf8'))"`).

### R-PFNP-8 (small) — pipeline-runner dirty-tree ignore matches docs/prds at any depth (#97)
- **Scope:** in `extension/src/bin/pipeline-runner.ts` dirty-tree preflight, match the path SEGMENT `docs/`/`prds/` at any depth (not only top-level), so `packages/api/docs/prd/foo.md` is ignored. Preserve the existing `.gitignore` + `.pipeline-runner-dirty-allowed.json` exemptions and the per-file fatal listing.
- **AC-PFNP-8-1:** a regression test asserts that with ONLY `packages/api/docs/prd/foo.md` dirty, `pipeline-runner.js` passes the dirty-tree preflight.
- **AC-PFNP-8-2:** a non-docs nested file dirty (e.g. `packages/api/src/foo.ts`) still blocks the preflight (no over-broad ignore).
- **AC-PFNP-8-3:** the R-SMAF/#80 dirty-tree-guard trap door (`DIRTY_ALLOWED_FILE_REL|isGitIgnoredPath|Dirty files:`) stays intact.

### R-PRNF-9 (medium) — readiness-halt = hard pickle failure + honest terminal status (#98)
- **Scope:** in `extension/src/bin/pipeline-runner.ts` pickle-exit handling: (a) gate the "recoverable, continue" decision on build-progress-since-`start_commit` (ticket commits or worker artifacts produced THIS run), NOT on "commits present"; (b) treat a readiness HALT (`check-readiness exited 2`, no manager spawned) as a hard pickle failure that does NOT advance to citadel, with a distinct `exit_reason` (e.g. `pickle_readiness_halt`); (c) ensure a zero-build run never finalizes as `completed` (e.g. `pipeline_incomplete: build_did_not_run`). Respect the existing `state.flags.skip_quality_gates_reason` operator escape hatch (that is a chosen skip, distinct from an unchosen halt).
- **AC-PRNF-9-1:** a regression where pickle exits non-zero with zero commits-since-`start_commit` yields `decision != continue` (does not run citadel/anatomy/szechuan over an empty diff).
- **AC-PRNF-9-2:** a readiness-halt pickle phase does NOT advance to citadel and the runner exits with the distinct `pickle_readiness_halt` (or equivalent) `exit_reason`.
- **AC-PRNF-9-3:** final state for a zero-build run reads an honest incomplete status (never `completed`/success).
- **AC-PRNF-9-4:** a genuine partial build (pickle errored AFTER producing ticket commits this run) still continues to citadel for remediation (no regression of the legitimate recoverable-continue path).
- **AC-PRNF-9-5:** the R-PHC-6 continue-by-default phase-halt trap door and R-ICP-2 phase-incomplete trap door are not regressed (existing pipeline-runner tests stay green).

### R-WCUC-10 (medium) — commit gate-passing uncommitted worker output instead of discarding it (#99)
- **Scope:** in `extension/src/bin/mux-runner.ts` no-progress detector (the `oversized_no_progress` → `closer_handoff_terminal` path; see R-WMW-5 trap door): before declaring `oversized_no_progress`/Failed, inspect the working tree for uncommitted changes attributable to the ticket. (a) If present AND the ticket's gate passes (typecheck + the ticket's acceptance spec(s)), **commit the worker output and mark the ticket Done** instead of Failed. (b) If present but gates FAIL, record the diff (stash ref or patch file under the session dir) in the failure record so the next clean-tree relaunch does not silently destroy it. (c) Split the `failure_reason` taxonomy: `no_work_produced` (true no-progress) distinct from `work_uncommitted` (tree has gate-passing changes). NOT in scope: the worker-lifecycle reason the commit step didn't fire (separate codex-lifecycle-convergence investigation); true oversized tickets that produce no convergent work still fail/split.
- **AC-WCUC-10-1:** a regression where a worker writes gate-passing files but never commits → the ticket ends `Done` with a commit, not `Failed`/`oversized_no_progress`.
- **AC-WCUC-10-2:** when uncommitted changes are present but gates fail, the failed-ticket record references the preserved diff (stash ref / session-dir patch) and a relaunch does not destroy it unrecorded.
- **AC-WCUC-10-3:** the `failure_reason` taxonomy distinguishes `work_uncommitted` from `no_work_produced`; the 907.1-shaped case (gate-passing tree, no commit) reports `work_uncommitted`.
- **AC-WCUC-10-4:** the R-WMW-5 oversized-wedge auto-skip trap door is not regressed — a genuinely wedged ticket with NO gate-passing tree changes still auto-skips/fails as before.

### R-GNXR-CLOSER (closer) — gate, ship, repoint
- **Scope:** run the full release gate from `extension/` (tsc --noEmit, eslint --max-warnings=-1, tsc, all audit-*.sh, test:fast, test:integration, RUN_EXPENSIVE_TESTS=1 test:expensive); CONFIRM GREEN; recompile so deployed `.js` matches `.ts`; bump `extension/package.json` per semver (MINOR — removes commands/skills/events + a feature, no state-schema change and no CLI-arg/hook-contract removal); commit `chore: bump version to X.Y.Z`; `bash install.sh`; verify clean tree + parity; `git push`; `gh release create vX.Y.Z`; repoint MASTER_PLAN row 27 to ✅ SHIPPED, mark #96 (resolved-by-removal) / #97 / #98 / #99 done, and note `p2-pipeline-graph-intelligence` + `p2-codegraph-integration` as superseded.
- **AC-CLOSER-1:** full gate green (read each tier's summary; re-run c=8 flakes at c=2/c=4 per `feedback_release_gate_fast_suite_concurrency_flakes`).
- **AC-CLOSER-2:** `grep -rniE "gitnexus" extension/src .claude CLAUDE.md AGENTS.md COMMANDS.md README.md roadmap.md internals.md` returns zero matches (whole-integration removal verified at close).
- **AC-CLOSER-3:** `git status` clean, compiled `.js` matches `.ts`, release tagged, MASTER_PLAN row 27 repointed.

## Version impact

MINOR. Removes commands/skills/activity-events and the graph-preflight feature. No `state.json` field change, no `LATEST_SCHEMA_VERSION` bump, no CLI-arg or hook-contract removal — old `state.json` stays readable by the new code. (Per the babysitter decision rule: feature/event removal that keeps state readable is MINOR, not MAJOR.)
