---
title: P2 — B-PIPE-LAUNCH-FRICTION bundle — anatomy/szechuan silent-skip, scope-resolver grep-loop, pickle-pipeline doc drift
status: Partial (P2) — R-SRGT (#50) + R-PPSD (#51) shipped 2026-05-22; R-PSSS (#49) re-scoped and pipeline-ready
filed: 2026-05-18
priority: P2
type: bug-cluster
code: R-PLF
bundle: B-PIPE-LAUNCH-FRICTION
related:
  - prds/BUG-REPORT-2026-05-18-pipeline-launch-friction.md  # operator-authored bug report; this PRD is its decomposition
  - prds/p1-pipeline-fix-bundle-2026-05-18.md  # B-PIPE-FIX — sibling bundle. Bug #48 R-PCFG folds into R-PIPE-2 (phase_no_progress); NOT duplicated here.
  - extension/src/services/scope-resolver.ts
  - extension/src/bin/pipeline-runner.ts  # anatomy-park + szechuan-sauce are skill prompts orchestrated here; setupAnatomyPark / setupSzechuanSauce / resolveAnatomySubsystems live in this file
  - extension/src/types/activity-events.schema.json  # new-event registration (R-PSSS-1/2)
  - extension/.claude/commands/pickle-pipeline.md
rescoped: "2026-05-22 — R-SRGT (#50) + R-PPSD (#51) shipped surgically; R-SRGT/R-PPSD ticket bodies left as historical record. R-PSSS (#49) ticket bodies REWRITTEN below against the real pipeline-runner.ts architecture (the original anatomy-park.ts/szechuan-sauce.ts files never existed)."
findings_closed:
  - "#49 R-PSSS — anatomy-park/szechuan-sauce silent phase-skip"
  - "#50 R-SRGT — scope-resolver grep timeout loop on empty diff"
  - "#51 R-PPSD — pickle-pipeline.md skill prompt docs deprecated skip flag names"
findings_folded_elsewhere:
  - "#48 R-PCFG — folds into B-PIPE-FIX R-PIPE-2 (phase_no_progress exit_reason). Do NOT add a separate ticket here."
ship_strategy: |
  Ship as v1.75.7 after B-PIPE-FIX (v1.75.6) lands, OR co-ship into v1.75.6
  if operator wants release-train economy. R-PPSD-1 (doc-only) can land at
  any time independently — does not need bundle gating.
---

# R-PLF — Pipeline launch friction bundle

**Author**: pickle-rick autonomous session 2026-05-18 PM, decomposing operator-authored bug report.
**Project**: pickle-rick-claude
**Repo**: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude`
**HEAD at filing**: `611b2625`

## Symptom cluster

Operator launched `/pickle-pipeline --refine --scope branch` on `loanlight-api` for LOA-701 (Reducto bounding boxes) on 2026-05-18. Session `2026-05-18-6108815e`. The launch surfaced **four distinct pipeline-launch friction bugs** (full operator report at `prds/BUG-REPORT-2026-05-18-pipeline-launch-friction.md`):

| # | Code | Symptom | Severity |
|---|---|---|---|
| 48 | R-PCFG | runner logs `Phase pickle completed successfully` immediately after `Phase pickle exited with code 1`; final pipeline can report `succeeded` with 0 workers spawned | S2 — observability false-green |
| 49 | R-PSSS | anatomy-park / szechuan-sauce silently skip when scope filter excludes all subsystems (doc-only diff); no operator-visible WARN | S2 — observability silent-skip |
| 50 | R-SRGT | scope-resolver import walk loops on `grep timeout / ETIMEDOUT` when branch diff is empty | S3 — UX + wall-clock waste |
| 51 | R-PPSD | `/pickle-pipeline` skill prompt documents deprecated `skip_readiness_reason` + `skip_ticket_audit_reason`; unified `skip_quality_gates_reason` (R-QGSK partial-ship `b2ddf584`) is undocumented | S3 — doc drift, 5-min fix |

**#48 R-PCFG folds into B-PIPE-FIX R-PIPE-2** — the `phase_no_progress` exit_reason gate at `extension/src/bin/pipeline-runner.ts` is structurally the same fix (count Done tickets + commits before claiming success). This PRD does NOT duplicate that ticket; it cross-references B-PIPE-FIX and tracks the remaining three findings.

## Cost

Concrete operator cost from session `2026-05-18-6108815e`:
- First launch died at 1m 8s (readiness halt + scope-resolver grep timeout spam).
- Second launch's pickle phase ran 1.5 seconds with 0 worker spawns (ticket-audit halt), then runner falsely logged `Phase pickle completed successfully`.
- anatomy-park silently skipped phase. szechuan-sauce ran no-op against doc-only diff.
- 13 tickets remained Todo. Operator had to read raw logs to discover the failure mode.

Structural cost: any operator launching with `--scope branch` and an empty or doc-only diff hits this cluster. Will recur on every doc-first PRD workflow until B-PLF ships.

## Atomic ticket scope

> **⚠ R-PSSS RE-SCOPED 2026-05-22.** The original R-PSSS-1/2/3 ticket bodies
> named `extension/src/bin/anatomy-park.ts` and `extension/src/bin/szechuan-sauce.ts`
> — **those files do not exist and never did.** anatomy-park and szechuan-sauce
> are skill prompts (`.claude/commands/*.md`) executed by `microverse-runner.js`;
> the pipeline orchestration — phase setup, scope filtering, the empty-scope
> skip — all lives in `extension/src/bin/pipeline-runner.ts`. The ticket bodies
> below are rewritten against that real architecture. Verified at HEAD
> `d7db89d0`. R-SRGT (#50) + R-PPSD (#51) already shipped surgically 2026-05-22.

### R-PSSS-1 (small) — anatomy-park: structured WARN + activity event on empty-scope skip

**Architecture (verified)**: `pipeline-runner.ts:resolveAnatomySubsystems()` (≈ line 1093) has two `return null` skip branches — `discovered.length === 0` ("No subsystems discovered") and `kept.size === 0` ("scope filter excluded all subsystems"). `null` propagates: `setupAnatomyPark` returns `false` → `runConfiguredPhase` returns `{skipped:true}` → `runPhaseIteration` (≈ line 2400) logs the generic `Phase anatomy-park skipped (setup returned false)`. The skip is therefore real but undistinguished and carries no activity event. `scope.allowedPaths` IS in hand at the `resolveAnatomySubsystems` call site.

**Files to modify**:
- `extension/src/bin/pipeline-runner.ts` — in `resolveAnatomySubsystems`, replace the plain `log('anatomy-park: scope filter excluded all subsystems — skipping phase')` with a structured, operator-actionable WARN AND a `logActivity` emission:
  ```
  ⚠ anatomy-park did not run: scope filter excluded all subsystems.
    In-scope diff (<N> path(s)): <comma-joined scope.allowedPaths, capped ~20>
    Hint: anatomy-park inspects code subsystems; a doc-only or test-only diff
    yields 0 in-scope subsystems. Widen with --scope paths:<glob>.
  ```
  Emit `logActivity({ event: 'anatomy_park_empty_scope_skip', source: 'pickle', session: path.basename(sessionDir), gate_payload: { in_scope_paths: scope.allowedPaths, discovered_subsystems: discovered.map(s => s.name) } })`. (`resolveAnatomySubsystems` must receive `sessionDir` — thread it from `setupAnatomyPark`.)
- Register `anatomy_park_empty_scope_skip` per **New activity event registration** below.

**Acceptance** (machine-checkable):
- `grep -c "anatomy_park_empty_scope_skip" extension/src/types/index.ts` ≥ 1.
- R-PDD-oneOf grep (see types/CLAUDE.md) emits zero lines — event has both a `definitions` entry and an `oneOf` `$ref`.
- Integration fixture: a session whose `scope.json.allowed_paths` are all `docs/*.md` → `resolveAnatomySubsystems` returns `null`; `pipeline-runner.log` contains the `⚠ anatomy-park did not run` line; `state.json.activity` has exactly one `anatomy_park_empty_scope_skip` entry; the phase is still skipped (no microverse spawn).
- `<event>-schema-conformance.test.js` passes.

### R-PSSS-2 (small) — szechuan-sauce: skip code-free scope with WARN + activity event

**Architecture (verified)**: `pipeline-runner.ts:setupSzechuanSauce()` (≈ line 1297) has **no empty-scope skip**. On a doc-only diff it still spawns `init-microverse.js` and the szechuan worker no-ops over the doc files — the bug report's "szechuan-sauce ran no-op against doc-only diff". The original PRD's "symmetric to R-PSSS-1, phase still skipped" assumption was wrong: szechuan does not skip today and its scope is the diff itself (`allowed_paths`), not a subsystem set.

**Files to modify**:
- `extension/src/bin/pipeline-runner.ts` — in `setupSzechuanSauce`, after `effectiveAllowedPaths` is resolved, classify it: if it is empty OR every entry has a non-code extension, emit the WARN + `szechuan_sauce_empty_scope_skip` event and `return false` (skip) **before** the `init-microverse.js` spawn — making szechuan's empty-scope behaviour observable and symmetric with anatomy-park.
  - Define a `CODE_EXTENSIONS` set near the top of `pipeline-runner.ts` (`ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,c,cc,cpp,h,hpp,cs,kt,swift,scala,sh`). Do NOT import check-readiness's `DOC_EXTENSION_ALLOWLIST` — different module, inverse semantics.
  - WARN template mirrors R-PSSS-1 with "szechuan-sauce" substituted.
- Register `szechuan_sauce_empty_scope_skip` per **New activity event registration** below.

**Acceptance**:
- Integration fixture: `setupSzechuanSauce` with `scope.json.allowed_paths` all `docs/*.md` → returns `false`; WARN line present; one `szechuan_sauce_empty_scope_skip` activity event; `init-microverse.js` NOT spawned.
- Integration fixture: a scope with ≥1 code file → `setupSzechuanSauce` proceeds unchanged (no skip, no event).
- R-PDD-oneOf + schema-conformance ACs as in R-PSSS-1.

### R-PSSS-3 (small) — pipeline-status.json: record per-phase skip disposition

**Architecture (verified)**: `pipeline-status.json` is currently a FLAT aggregate — `PipelineStatus = {status, current_phase, completed_phases, skipped_phases, total_phases, updated_at}` (see `writePipelineStatus`, ≈ line 648). There is **no per-phase record array**, so the original PRD's `phases.anatomy_park.skip_reason` path does not exist. Adding skip dispositions is an additive schema extension. The setup contract is `boolean` (`PhaseConfig.setup` returns `boolean`; `runConfiguredPhase` collapses every falsey setup into `{skipped:true}` — the reason is lost there).

**Files to modify**:
- `extension/src/bin/pipeline-runner.ts`:
  - Introduce `type PhaseSkipReason = 'empty_scope' | 'no_subsystems' | 'setup_error'`. Change the phase-setup return contract from `boolean` to `PhaseSetupResult = true | { skipReason: PhaseSkipReason }` (a falsey/object result means skip). `setupAnatomyPark` / `setupSzechuanSauce` / `resolveAnatomySubsystems` return the specific reason (`resolveAnatomySubsystems` distinguishes its two `null` causes: `no_subsystems` vs `empty_scope`).
  - `runConfiguredPhase` (≈ line 1822) threads the reason: return `{ skipped: boolean; skipReason?: PhaseSkipReason; exitCode; stderr }`.
  - `runPhaseIteration` (≈ line 2400, the `result.skipped` branch) passes `skipReason` onward.
  - Extend `PipelineStatus` with an additive `phase_skips?: Record<string, PhaseSkipReason>`; `writePipelineStatus` / `writeRunningStatus` populate it. The field is OPTIONAL so existing recoverable readers (`monitor.ts`) tolerate its absence.
  - The final `Phases:` summary line (≈ line 2265) renders e.g. `anatomy-park ⏭ (empty scope)` rather than a bare count.
- Update any `pipeline-status.json` schema/parity test for the new optional field.

**Acceptance**:
- Integration fixture: doc-only diff pipeline → `pipeline-status.json.phase_skips["anatomy-park"] === "empty_scope"`.
- The final report line distinguishes an empty-scope skip from a setup-error skip.
- `monitor.ts` recoverable read of a `pipeline-status.json` WITHOUT `phase_skips` still parses (additive-field regression).

### New activity event registration (R-PSSS-1 + R-PSSS-2)

Each of `anatomy_park_empty_scope_skip` and `szechuan_sauce_empty_scope_skip` MUST land all **7 touchpoints** — the R-PDD-oneOf trap door (`extension/src/types/CLAUDE.md`) plus the per-event schema-conformance pattern (`ticket-audit-failed` / `time-cap-disabled-default` / `worker-partial-lifecycle-exit`):

1. `extension/src/types/index.ts` — add to `VALID_ACTIVITY_EVENTS`.
2. `extension/src/types/activity-events.schema.json` — add a `definitions/<event>` object. `required: ["event","ts","session","gate_payload"]`; `gate_payload` carries `in_scope_paths: string[]` (+ `discovered_subsystems: string[]` for the anatomy event).
3. Same file — add `{ "$ref": "#/definitions/<event>" }` to the top-level `oneOf` array.
4. `extension/tests/activity-event-payload.test.js` — add an `EVENT_CASES` row.
5. `extension/src/bin/spawn-refinement-team.ts` — add a row to `ACTIVITY_EVENT_SCHEMA_SECTION`.
6. `extension/tests/<event>-schema-conformance.test.js` — new per-event test mirroring `ticket-audit-failed-schema-conformance.test.js`, asserting emitter↔schema parity AND the R-PDD-oneOf membership invariant.
7. `npx tsc` so the compiled mirror `extension/types/index.js` matches source.

Prefer `logActivity` (auto-stamps `ts`) over `writeActivityEntry` (does NOT auto-stamp — see the R-WSE-2 / R-CCPM-1 trap doors; a `writeActivityEntry` emitter MUST pass `ts: new Date().toISOString()` explicitly).

### R-SRGT-1 (small, ≤30m) — scope-resolver short-circuit import walk on empty initial diff

> **✅ SHIPPED 2026-05-22 (`6f71dd6a`).** `computeOneHop` returns `[]` immediately
> for an empty seed set. NOTE: the actual short-circuit lives in `computeOneHop`
> (the one-hop expander), not a separate "2-pass walk" function — empty-diff
> modes already throw `SCOPE_EMPTY_DIFF` upstream in `resolveAllowedFromDiffMode`.
> Ticket body below is historical. R-SRGT-1 + R-SRGT-2 shipped together.

**Files to modify**:
- `extension/src/services/scope-resolver.ts` — locate the 2-pass walk (build initial file set from `git diff` → "import walk" expand via grep). When initial file set is empty:
  ```typescript
  if (initialFileSet.size === 0) {
    log.info('scope-resolver: empty initial diff; skipping import walk');
    return { allowed: [], scope_resolved_at: new Date().toISOString() };
  }
  ```
  No grep, no subprocess, no retries.

**Acceptance**:
- Unit test: scope-resolver invoked with empty diff → returns `allowed=[]` in <100ms, no grep subprocess spawn observed via instrumented mock.

### R-SRGT-2 (small, ≤30m) — scope-resolver grep timeout caps

> **✅ SHIPPED 2026-05-22 (`6f71dd6a`).** Per-grep timeout lowered 30s→5s
> (`FIND_IMPORTERS_TIMEOUT_MS`); aggregate wall-clock cap added
> (`ONE_HOP_WALK_WALL_MS`, 60s) — on exceed, log + return partial importer set.
> The "3-retry per target" cap was dropped: there is no retry loop in
> `findImporters` (rg-then-grep fallback, single attempt each), so it was a
> no-op AC. Trap door + `scope-srgt.test.js` added.

**Files to modify**:
- `extension/src/services/scope-resolver.ts` — even when initial diff is non-empty, add defensive caps on grep import-walk:
  - Per-grep timeout: 5s (currently unbounded / inherits default).
  - Total retry cap: 3 attempts per grep target; on exceed, log `scope-resolver: grep retry exhausted target=<path>; abandoning walk for this target` and continue (do NOT abort whole walk).
  - Total walk wall-clock cap: 60s. Exceed → log + return partial allowlist.

**Acceptance**:
- Unit test with a deliberately-slow grep mock asserts the 5s/3-retry/60s caps fire correctly.
- Integration regression: empty-diff case still completes in <100ms (R-SRGT-1 path); non-empty case completes <60s.

### R-PPSD-1 (small, ≤15m, DOC-ONLY) — pickle-pipeline.md unified skip flag docs

> **✅ ALREADY SATISFIED (verified 2026-05-22).** Both `.claude/commands/pickle-pipeline.md`
> and `.claude/commands/pickle-tmux.md` already document `skip_quality_gates_reason`
> as primary with the legacy flags labelled `**Legacy**:`. No change needed — a
> prior commit (the R-QGSK-2 ship or a follow-up) already closed this. Ticket
> body below is historical.

**Files to modify**:
- `extension/.claude/commands/pickle-pipeline.md` § "Skip-flag overrides" — replace the legacy-only doc block:

  **Before** (currently in skill prompt):
  > Set `state.flags.skip_readiness_reason` … or `state.flags.skip_ticket_audit_reason` …

  **After**:
  > If pipeline launch halts at a quality gate, edit `${SESSION_ROOT}/state.json` and add:
  > ```json
  > "flags": { "skip_quality_gates_reason": "<reason string>" }
  > ```
  > This unified flag (R-QGSK-2, `b2ddf584`) covers both readiness AND ticket-audit gates.
  >
  > **Legacy**: `skip_readiness_reason` and `skip_ticket_audit_reason` are still honored but emit a deprecation warning. Migrate to the unified flag.

- Also update `extension/.claude/commands/pickle-tmux.md` § "Skip-flag overrides" if it has the same drift.

**Acceptance**:
- `grep "skip_quality_gates_reason" extension/.claude/commands/pickle-pipeline.md` returns a hit.
- `grep "skip_readiness_reason" extension/.claude/commands/pickle-pipeline.md | grep -i "legacy"` returns a hit (showing it's documented as legacy).

**Note**: This ticket is DOC-ONLY and can ship independently of the rest of the bundle. R-PPSD-1 is safe to land at any time, including before B-PLF closes.

## Hardening (1)

### T-HARDEN-PLF-TESTS (small) — integration tests for the R-PSSS empty-scope launch fixtures

**Note**: the scope-resolver coverage the original ticket scoped (empty-diff
short-circuit, slow-grep caps) already SHIPPED in `extension/tests/scope-srgt.test.js`
with R-SRGT. This ticket now covers only the R-PSSS fixtures.

**Files to modify**:
- `extension/tests/integration/pipeline-launch-friction.test.js` (new file).

**Coverage**:
1. Fixture: `scope.json.allowed_paths` all `docs/*.md` → `setupAnatomyPark` skips, `anatomy_park_empty_scope_skip` activity event emitted, WARN line present (R-PSSS-1).
2. Fixture: same code-free scope → `setupSzechuanSauce` returns `false`, `szechuan_sauce_empty_scope_skip` emitted, `init-microverse.js` not spawned (R-PSSS-2); and a scope with ≥1 code file proceeds normally.
3. Fixture: doc-only diff pipeline → `pipeline-status.json.phase_skips["anatomy-park"] === "empty_scope"` (R-PSSS-3).

**Acceptance**:
- All three test cases pass under `npm run test:integration`.

## Closer (1)

### C-PLF-CLOSER [manager] (small) — bundle ship

The bundle now ships only R-PSSS-1/2/3 + T-HARDEN-PLF-TESTS (R-SRGT and R-PPSD
already shipped on `main` 2026-05-22; #50/#51 already closed in MASTER_PLAN).

Closer work:
- Minor version bump from the current `extension/package.json` version (v1.76.0 at re-scope time → v1.77.0; the closer reads the live version, does not hardcode).
- `cd extension && npx tsc` rebuild compiled mirrors.
- `bash install.sh` parity check (manager-only).
- Full release-gate audit (`npx tsc --noEmit && npx eslint && audit-* && test:fast && test:integration`).
- Commit + tag + push.
- Update `prds/MASTER_PLAN.md`: mark finding #49 closed; B-PIPE-LAUNCH-FRICTION row → Shipped.

## Acceptance criteria (bundle-level)

| ID | Criterion | Evidence |
|---|---|---|
| AC-PLF-01 | anatomy-park emits top-level WARN + activity event on empty-scope skip | log line + jq on state.json.activity |
| AC-PLF-02 | szechuan-sauce emits top-level WARN + activity event on empty-scope skip | symmetric to AC-PLF-01 |
| AC-PLF-03 | pipeline-status.json records `skip_reason` per phase; final report renders disposition | jq + grep on report |
| AC-PLF-04 | ✅ scope-resolver short-circuits on empty diff (<100ms, no grep spawn) | SHIPPED `6f71dd6a` — `scope-srgt.test.js` |
| AC-PLF-05 | ✅ scope-resolver grep cap (5s per-grep / 60s total) fires correctly | SHIPPED `6f71dd6a` — `scope-srgt.test.js`. 3-retry cap dropped (no retry loop exists) |
| AC-PLF-06 | ✅ `/pickle-pipeline` skill prompt documents `skip_quality_gates_reason` as primary; legacy flags labeled | SHIPPED earlier — verified 2026-05-22 |
| AC-PLF-07 | Integration test suite covers the R-PSSS fixtures (anatomy empty-scope, szechuan code-free scope, pipeline-status `phase_skips`) | npm run test:integration |
| AC-PLF-CLOSER | R-PSSS shipped; MASTER_PLAN finding #49 closed; B-PIPE-LAUNCH-FRICTION row → Shipped | git log + MASTER_PLAN diff |

## Out of scope

- **#48 R-PCFG** — folds into B-PIPE-FIX R-PIPE-2. Ships there.
- **Forward-create gate UX improvements** — separate problem (R-FRA / R-RTRC-7 → B-QSRC bundle).
- **Ticket-audit gate operator hints** — separate (`audit-ticket-bundle` belongs to a different gate family).
- **Subsystem registry expansion** (e.g., teach anatomy-park to inspect docs) — explicitly out; the WARN approach makes the silent-skip operator-visible without expanding subsystem coverage.

## Implementation strategy

**Pickle-friendly bundle** — unlike B-PIPE-FIX, this bundle does NOT modify the runner contract or worker prompts in ways that block pipeline self-hosting. Safe to ship via `/pickle-tmux` once B-PIPE-FIX R-PIPE-1 (max-turns 400) lands.

**Recommended order (post re-scope, 2026-05-22)**:
1. R-SRGT + R-PPSD already shipped surgically — skip their (historical) ticket bodies.
2. Run the remaining bundle — R-PSSS-1/2/3 + T-HARDEN-PLF-TESTS + C-PLF-CLOSER —
   via `/pickle-tmux prds/archive/bundles/p2-pipeline-launch-friction-bundle-2026-05-18.md`.
   All four tickets touch `pipeline-runner.ts` (sequential, not parallel-safe
   on that file). Each R-PSSS ticket also touches the activity-event schema —
   workers must run the R-PDD-oneOf grep before commit.

## Post-validation gaps

1. Watch one real operator launch with `--scope branch` against a doc-only branch — confirm anatomy/szechuan WARN surfaces visibly (not buried in DEBUG).
2. Confirm scope-resolver R-SRGT-1 short-circuit doesn't accidentally collapse legitimate "first commit gives 1 file but import walk finds 50" cases. The short-circuit is gated on EMPTY initial diff only.
3. Verify `skip_quality_gates_reason` documentation lands and a future operator session uses it without hitting the deprecation warning.

## Related findings / bundles

- **B-PIPE-FIX (R-PIPE-1..4 + hardening + closer)** — sibling bundle; R-PIPE-2 covers Bug #48 R-PCFG (the false `Phase pickle completed successfully` log). This bundle covers the other three friction bugs.
- **R-QGSK (B-QSRC residual)** — R-PPSD-1 documents the unified skip flag that R-QGSK-2 already shipped at `b2ddf584`. Doc-only catch-up; no runtime work.
- **R-FRA / R-RTRC-7** — operator-observed gate friction sits adjacent to this bundle (readiness gate exited 2 on legitimate forward-create symbols). Separate problem; tracked under B-QSRC.

## Bundle sizing

Original: 6 atomic + 1 hardening + 1 closer = 8 tickets. **Remaining after the
2026-05-22 surgical ship of R-SRGT-1/2 + R-PPSD-1: 4 tickets** —
R-PSSS-1, R-PSSS-2, R-PSSS-3, T-HARDEN-PLF-TESTS + C-PLF-CLOSER.

- Tier: R-PSSS-1/2 small; R-PSSS-3 small-to-medium (it changes the phase-setup
  return contract `boolean → PhaseSetupResult` and extends `PipelineStatus` —
  more touchpoints than a pure additive change, classify medium if the
  auto-sizer is unsure). T-HARDEN + closer small.
- R-PSSS-1/2 each add a new activity event → 7-touchpoint registration each.
- Sequential on `pipeline-runner.ts` — do NOT parallelize these tickets.
- No further refinement required — these re-scoped bodies are pipeline-ready.
