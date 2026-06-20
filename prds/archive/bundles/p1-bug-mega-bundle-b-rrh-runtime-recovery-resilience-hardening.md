---
title: P1 mega-bundle — B-RRH — Runtime Recovery & Resilience Hardening (REFINED)
status: Draft
filed: 2026-06-12
refined: 2026-06-12 (3-cycle analyst team — requirements / codebase / risk-scope)
priority: P1
type: bug-bundle
code: B-RRH
backend_constraint: claude   # control-flow-heavy mux-runner/pipeline-runner edits; codex override UNSUPPORTED for this bundle
schema_neutral: true         # REVISED after refinement: A0 is an additive VALID_ACTIVITY_EVENTS edit (forward-migration, MINOR via _internalSchemaBump). exit_reason is a free string (types/index.ts:117/840/1181) → NO v6 bump, NO new phase enum → NO mid-bundle live-state migration deadlock.
source:
  - "v2.0.0-beta.1 bundle, session 2026-06-10-f50e5c11 (11 babysitter interventions). 7 of 10 findings from this one run."
  - "LOA-1097, concurrent session 2026-06-11-c653c95f (#110 R-PRPATH + cross-session-pollution half of #34)."
  - prds/MASTER_PLAN.md   # Open Findings #30-38, #110; Drain Queue row 111
---

# B-RRH — Runtime Recovery & Resilience Hardening (REFINED)

> **Thesis.** None of these ten findings is the agent doing bad work — the v2-beta bundle shipped clean. They're about what the runtime does when something **interrupts** a long run (a 5h API window, a stray SIGTERM, a `/login`, a manager crash, a concurrent peer session, an inferred-completion edge): it destroys committed/completed work, charges an innocent ticket, or bricks its own relaunch — and a human had to recover, 11 times in one run. B-ORSR made the recovery ladder *exist*; B-RRH makes the *inputs to recovery* trustworthy and the *teardown/relaunch paths* non-destructive.

## A0 is the taxonomy-of-record (HARD ordering precondition)

Every B/C/D acceptance fixture asserts on an event literal. Those literals must be frozen FIRST or the fixtures are un-writable. **A0 lands and installs before any B/C/D conformance fixture is authored.** Per-event decisions (verified against `types/index.ts:564`):

| Need | Decision | Why |
|---|---|---|
| park / resume signal | **REUSE** existing `rate_limit_wait` / `rate_limit_resume`; ADD `reset_at` / `parked_minutes` payload | `rate_limit_parked`/`rate_limit_resumed` are one char from the existing pair → fixture/standup ambiguity |
| park exhaustion | **NEW** `rate_limit_park_exhausted` → `VALID_ACTIVITY_EVENTS` **ONLY** | `rate_limit_exhausted` is ALSO a `MicroverseExitReason` (`:1057`/`:1071`) — reuse cross-wires microverse failure classification. Park-exhaustion is an activity event, **never** an exit_reason enum member |
| 429 w/o reset_at | **NEW** `rate_limited_without_reset_at` | degraded path must be observable |
| ladder per-ticket exhaustion | **NEW** `ticket_ladder_exhausted` | B-LERD run-exit vs advance |
| crash quarantine | **NEW** `crashed_ticket_files_quarantined` + `crashed_ticket_files_quarantine_truncated` | C8 happy + truncation-FATAL paths |
| pickle phase incomplete | **NEW** `pickle_incomplete` (sentinel, default over non-zero-exit) | survives signal-mangled exit codes |

No new phase, no new exit_reason enum value → `LATEST_SCHEMA_VERSION` stays 5; the `VALID_ACTIVITY_EVENTS` array edit is the only forward-migration (`_internalSchemaBump`, MINOR).

## Schema & invariants — shared predicate block (cited by A/C)

1. **Graded artifact level** = highest present of `research_*` < `plan_*` < `conformance_*` (each = named glob + non-zero content). `countWorkerArtifacts` (`mux-runner.ts:5580-5588`) today credits ONLY `code_review*`/`conformance*`. **A4 widens it to credit a `≥ research` phase advance; C7 auto-commits ONLY at `= conformance` + gate-green; C3 treats `completion_commit` (explicit OR inferred) as committed.** One definition, three call-sites — prevents C7 auto-committing a research-only tree (data loss).
2. **"Committed" for the Done-guard / no-Failed-flip** = `completion_commit` explicit OR `completion_commit_inferred` present (`mux-runner.ts:1170/1449`). A1 and D1 must agree on this so a not-yet-promoted inferred-Done ticket is Done-guarded.
3. **"Own paths"** = `scope.json:allowed_paths` (the convention `getLatestCommitInScope` uses, `artifact-progress-detector.ts:49-61`); ticket-declared `Files to modify/create` is fallback only when no `scope.json` exists.
4. **Archive convention** = `archiveBeforeDestructive` patch-file (`pre_reset_diff_*.patch`, `git-utils.ts:388`) — NOT a new `refs/pickle/quarantine/*` ref scheme.
5. **rate_limit event namespace** and the **microverse exit-reason enum** are SEPARATE surfaces and must stay separate.

## Critical User Journeys (each ends in an observable end-state + an operator-visible recovery line via `pickle-status`)

1. **Rate-limit park/resume** — 429 with `reset_at = now+5h` → park ≈5h (not the 15-min `3×` cap), zero spawns, `rate_limit_wait{reset_at}`; at reset+jitter probe → `rate_limit_resume{parked_minutes}`, re-spawn ≤1 worker same ticket/phase, counters preserved.
2. **SIGTERM → pickle incomplete** — mux killed with ≥1 Todo → `pickle_incomplete` sentinel → pipeline-runner does NOT advance to citadel.
3. **SIGTERM → committed ticket not Failed** — ticket already committed → not Failed-flipped, HEAD unchanged.
4. **/login hang → CPU watchdog salvage** — worker alive but <5s CPU over M min + no artifact-mtime advance → watchdog trips → conformance-present fast-path commits + advances.
5. **Mid-implement crash → dirty-tree quarantine relaunch** — relaunch with crashed ticket's own files dirty → archive (recoverable patch) + reset to Todo + proceed; truncated archive → FATAL (never destroy).

## Workstreams (ACs corrected per refinement; see analyses for line-exact rationale)

### Workstream A — Progress & recovery accounting (ONE `large` ticket — A1/A3/A4/A5 share `recordWorkerArtifactProgress`)
- **AC-A1** Done-guard: before charging `zero_progress_count` or running a ladder rung, re-read frontmatter; "committed" per invariant #2 (explicit OR inferred) → reset counter, clear `current_ticket`, advance. *Assert:* Done(+inferred-only) ticket + zero-artifact spawns → advance, no increment.
- **AC-A2** Exit-action audit: per-ticket exhaustion emits `ticket_ladder_exhausted{ticket}` and advances while ≥1 runnable Todo remains; full run-exit only on no-runnable / global cap (name the existing iteration ceiling). *Assert:* exhaustion on A with Todo B/C → run continues at B.
- **AC-A3** Scoped signature: pass a path-scoped fn via the existing `opts.sourceSignatureFn` seam (`mux-runner.ts:5644`); DO NOT rewrite `computeSourceTreeSignature` (`:5604`). Scope = invariant #3. *Assert:* a peer session's dirty `prds/` file is absent from the signature, does not reset `zero_progress_count`.
- **AC-A4** Phase-aware credit: widen the `progressed` predicate in `recordWorkerArtifactProgress` (`:5662-5673`) / `countWorkerArtifacts` (`:5585`) to credit a `≥ research` phase advance for the first **N (< `PICKLE_WMW_SKIP_K`, default 5)** iterations of a `large`-tier ticket. DO NOT touch `detectArtifactProgress` or the heartbeat (both already credit research/plan). *Assert:* research→plan→implement over 3 iters not flagged zero-progress; phase-churn-only past iteration N still hits `worker_auto_skip_oversized`.
- **AC-A5** Rate-limit/breaker immunity: spawn outcomes classified rate-limited, or within K=30s (`hardening.breaker_recovery_grace_seconds`) of a breaker recovery, never increment any recovery counter. *Assert:* 429-death K s after `HALF_OPEN→CLOSED` → counter unchanged.

### Workstream B — Rate-limit park & auto-resume (ONE ticket; root cause = the `3×` cap)
- **AC-B1** Park-until-reset: `computeRateLimitAction` (`mux-runner.ts:2732`) already honors `reset_at` (`apiWaitMs` `:2746`) but caps it at `maxApiWaitMs = configWaitMs*3` (`:2739`). Remove/raise the cap; on `consecutive ≥ threshold` enter park: no spawns, no iteration advance, no counter accounting; set `rateLimitWaiting=true`; persist park state; emit `rate_limit_wait{reset_at}`. *Assert:* 429 with `reset_at=now+5h` parks ≈5h (not 15 min), one wait event, zero spawns.
- **AC-B2** Auto-resume: at `max(reset_at+jitter[60-120s], now+min_wait)` probe once; success → `rate_limit_resume{parked_minutes}`, re-spawn ≤1 worker for the SAME `current_ticket` at the same phase, iteration index + `zero_progress_count` preserved (not incremented); still limited → re-park to new reset.
- **AC-B3** Wall-clock exclusion: parked time excluded from `max_time_minutes` (`types/index.ts:7`) AND frozen against the R-WTB-A1 timeout-halt window. *Assert:* a T-min park consumes 0 of the wall and 0 of the no-progress window.
- **AC-B4** Park survives `--resume`: re-arm timed resume from persisted `reset_at`. *Assert:* `--resume` mid-park does not spawn-burn, resume-arm survives.
- **AC-B5** Park ceiling: cumulative park ≤ `rate_limit.max_park_minutes` (default 360); on exceed emit `rate_limit_park_exhausted` (activity-only) + exit-for-recovery, never re-park. No-`reset_at` fallback: `now + configured_min_wait`, emit `rate_limited_without_reset_at`, never spawn-burn. *Assert:* fake clock past ceiling + perma-limited probe → one exhaustion event + clean exit.
- **AC-C6a** (park↔watchdog wiring): while parked, watchdog input sets `rateLimitWaiting=true` → `evaluateMuxIdleStallWatchdog` returns `{stalled:false,reason:'in_wait_state'}` (`:3386-3391`), never the CPU/mtime branch; parked wall excluded from the M-window. *Assert:* parked worker hits `in_wait_state`, never salvaged.
- **AC-B6** (SIGTERM-during-park precedence): SIGTERM while parked preserves the park-arm, does NOT Failed-flip (no in-flight worker), fires no archive/reset. *Assert:* SIGTERM during park → ticket not Failed, park-arm survives, zero archive events.

### Workstream C — Interruption resilience
- **AC-C1** (pipeline-runner): pickle-phase completion gated on all-tickets-Done, not mux exit code; any Todo/In-Progress/Failed → INCOMPLETE (re-enter pickle or halt), never advance to citadel. *Assert:* SIGTERM-killed mux with ≥1 Todo → no advance to PHASE 2.
- **AC-C2** (mux + pipeline-runner): signal-deactivation with tickets remaining writes the `pickle_incomplete` sentinel (default; non-zero exit optional). *Assert:* SIGTERM with Todo tickets → sentinel present, pipeline-runner does not phase-advance.
- **AC-C3** Failed-flip suppression: EXTEND `evaluateFailedFlipSuppression` (`mux-runner.ts:2262`) to treat a SIGTERM-interrupted-but-committed ticket (invariant #2) as evidence-PRESENT at BOTH flip sites `:2283` AND `:7544`; honor the `git-utils.ts` invariant (a `Failed`+`completion_commit:null` write clears `completion_commit_inferred`). *Assert:* SIGTERM during a committed ticket → not Failed at either site.
- **AC-C4** (smell → ONE parametrized ticket): every real reset path is `git merge-base --is-ancestor`-guarded via the built H1 `detectAndRecoverHeadRegression` (`mux-runner.ts:2209`, probes `:2025`/`:2053`); wire into the real `resetToSha` callers (anatomy/microverse auto-commit-then-reset). `describe.each([cancel-teardown, anatomy auto-commit-reset, microverse auto-commit-reset])` — the cancel case asserts cancel STAYS non-destructive (no reset in `cancel.ts` today); fixtures pin the real mutators `:2283`/`:7544`. *Assert:* committed-then-reset → HEAD stays at ticket commit, no orphan.
- **AC-C5** Resume self-heal: on `--resume`, a Failed/In-Progress ticket whose frontmatter/reflog names a commit that ff-descends from HEAD → `merge --ff-only` reattach + mark Done. *Assert:* orphaned-pre-resume ticket → reattached + Done, no manual ff.
- **AC-C6** CPU/artifact liveness watchdog: extend `evaluateMuxIdleStallWatchdog`; slot the new check AFTER the `:3386-3391` `in_wait_state` short-circuit; trip when worker alive but <5s CPU over M min (M reuses `DEFAULT_MUX_IDLE_STALL_SECONDS=900` `:3409` unless lowering — state which) AND no artifact-mtime advance — defeating the `lastProgressMs`-freshness false-liveness that `/login` output kept alive. On trip → `checkPartialLifecycleExit` salvage. *Assert:* two 55s samples, no advance, live 0%-CPU worker → trips in one idle-eval cycle.
- **AC-C7** Conformance-present fast-path: when the current ticket is at graded level `= conformance` + a gate that **runs to completion** (not inferred from a stale artifact) is green, but the worker is unresponsive → validate-and-commit (reset-proof, explicit `completion_commit`). *Assert:* complete-set + gate-green + no-token worker → commits + advances; INCOMPLETE set + unresponsive → does NOT auto-commit.
- **AC-C8** Dirty-tree relaunch self-heal: reuse `archiveBeforeDestructive` (invariant #4) — NOT a ref scheme. If `filesTruncated===true` → do NOT clean/reset → FATAL + `crashed_ticket_files_quarantine_truncated`. Branch table: dirty within `current_ticket`'s declared files → archive + reset to Todo + `crashed_ticket_files_quarantined`; **`current_ticket==null`** (normal post-crash) → scope against the union of all In-Progress/Todo declared files; any dirty path inside `working_dir` but undeclared → quarantine-and-warn; dirty OUTSIDE `working_dir` → FATAL. *Assert:* large(>cap) crashed tree → FATAL, not cleaned; small in-scope crashed tree → archived (patch-recoverable) + reset to Todo; out-of-`working_dir` dirt → FATAL.

### Workstream D — State integrity & idempotency
- **AC-D1** Promote-once: when Done + a commit resolves, promote `completion_commit_inferred`→`completion_commit` exactly once and DELETE the inferred field so the re-scan is a no-op; route keep/revert through the existing `gateForPhantomDoneRevert` oracle (`ticket-completion-evidence.ts`, R-RIC-EXPLICIT-4). *Assert:* Done+inferred over N passes → exactly one promotion, no growing `phantom_done_backfilled` count.
- **AC-D2** Bounded activity log: ring ceiling `state.activity.length ≤ 2000` (drop-oldest) in the `state-manager.ts` write path; `rate_limit_*`/`*_quarantined`/`ticket_ladder_exhausted` events are eviction-EXEMPT. *Assert:* N backfill attempts → length ≤ cap, no exempt event dropped.
- **AC-D3** prd_path on resume (NARROWED): `State.prd_path` (`types/index.ts:26`) + the `setup.ts:1210` stamp already exist — the hole is `config.prdPath` is never populated on the paused-refine→`--resume` path. Fix the resume resolver to set `config.prdPath = ${SESSION_ROOT}/prd_refined.md` (else `prd.md`) so the existing stamp fires. Do NOT re-add a stamp. *Assert:* after `--paused`→refine→`--resume`, `jq -r .prd_path state.json` → an existing file.
- **AC-D4** Citadel preflight self-heal: when `prd_path` absent but `start_commit` set and `${SESSION_ROOT}/prd_refined.md|prd.md` exists → adopt + log, not hard-fail. *Assert:* such a session runs citadel instead of `exit 1`.
- **AC-D5** Regression: scripted `--paused`→refine→`--resume` fixture reaches PHASE 2 CITADEL.

### Workstream E — Gate & validator scope correctness (extends R-FRA-6; drained early per launch precondition)
- **AC-E1..E6** (ONE `large` ticket): extend `forward-ref-annotation.ts` (R-FRA-6) — bundle-creation index consulted by both checkers; command-string + table coverage; grammar accepts trailing `, ; ) .`; annotation honor in the exit-code checker AND the contract resolver (`check-readiness.ts:extractContractReferences/extractForwardRefAnnotations` vs `audit-ticket-bundle.ts:extractForwardCreatePaths` — name which calls which); classifier checks a token only when cited AS event/exit-code; `path_not_verified` skips URL segments / >2-slash identifier lists / `node_modules`. *Assert:* annotated forward-created files in commands/tables/cross-ticket → zero findings, no skip flag; control fixture with one real phantom path + one phantom event → both validators still fail naming exactly those two; grammar unit matrix passes.
- **AC-E7** Review-hammer cross-file scope: the test-quality + cross-ref hammers grep the bundle's changed symbols/commands across ALL tests + canonical-config files (`check-wired.sh`, the gate-wiring test), not only the diff. *Assert:* a fixture changing behavior X with a pre-existing test pinning old-X is flagged.
- **AC-E8** (smell → ONE parametrized ticket): replace single-pass `npm run test:fast` in the canonical `FULL_CMD` with the flake-tolerant mechanism (`check-flake-budget` rerun-with-budget / serial-manifest) across all 5 mirrors, kept byte-identical by the EXISTING `check-wired.sh`/`release-gate-wiring.test.js` parity gate. `describe.each(['CLAUDE.md','ci.yml','release.yml','check-wired.sh','release-gate-wiring.test.js'])` asserts each mirror encodes it and none retains single-pass; + release.yml green on clean / red on a genuinely-broken test.
- **AC-E9a** codegraph `serve --mcp` handshake → serial manifest (or low-concurrency expensive tier).
- **AC-E9b** install.sh `INSTALL_BYPASS_ACTIVE_SESSION` audit-write the README documents.

## Risks, Mitigations & Assumptions (from the risk-scope analyst — six line-pinned entries)

| Risk | Severity | Coordinate | Mitigation |
|---|---|---|---|
| C8 archive truncates → "recoverable" false; quarantine-then-clean destroys un-archived work | **Critical** | `git-utils.ts:399-422` `filesTruncated` | FATAL on truncation + `crashed_ticket_files_quarantine_truncated`; reuse patch archive |
| Misdirected fix: C3/B/C6 name wrong file | **Critical** | `cancel.ts` grep empty; real `:2283`/`:7544`/`:2739`/`:3409` | each AC carries the coordinate; conformance asserts edit landed at named lines |
| C4 reattach rewinds HEAD off a real commit | **Critical** | mutators `:2283`/`:7544` | reuse H1 unchanged; every reset is-ancestor-guarded; no-orphan trap-door BEFORE any live runner |
| `rate_limit_exhausted` reuse crosses microverse classification | **Critical** | event `:564` AND `MicroverseExitReason` `:1057`/`:1071` | park-exhaustion event activity-surface ONLY; never an exit_reason enum member |
| Unbounded park (reset never arrives / probe perma-limited) | **High** | new B mechanism, no terminal | AC-B5 ceiling → exit-for-recovery |
| Under-declared ticket file set → C8 FATALs its own dirty file | **High** | A3/C8 pivot on declarations | quarantine-and-warn inside `working_dir`; FATAL only outside |

**Assumptions:** (a) ticket `Files to modify/create` complete + machine-parseable; (b) the 429 classifier reports `reset_at` (fallback defined); (c) `bundle-disposition-2026-05-04.json` ABSENT — disposition gating unavailable; (d) rate_limit event namespace and microverse exit-reason enum are SEPARATE and stay so. **Launch precondition (deterministic):** drain E1–E6 first, OR launch sets `state.flags.skip_quality_gates_reason='creation-heavy bundle, B-RFCB gate-hardening not yet landed; <N> forward-creating tickets'`. **codex override unsupported for this bundle.**

## Implementation Task Breakdown

Wiring ticket SKIPPED — this bundle edits already-integrated runtime functions in place (no isolated new modules to wire); A0's new events are self-wired (declared in A0, emitted per ticket); integration risk covered by the 4 hardening tickets + the closer's full gate.

| Order | ID | Title | Pri | Entry | Exit |
|---|---|---|---|---|---|
| 10 | 6751a390 | A0 — freeze event taxonomy | High | first | events frozen, schema-neutral |
| 20 | 3d540d6c | Workstream A — progress accounting (A1/A3/A4/A5) | High | A0 | counter status/scope/phase/RL-aware |
| 30 | d680804e | C1/C2 — pickle completion gated on all-Done + sentinel | High | A0 | no advance on partial build |
| 40 | 05285a6e | C3 — no Failed-flip of a committed ticket (both sites) | High | A0 | committed work never Failed |
| 50 | 84f79bfc | C4 — is-ancestor reset guard (parametrized) | High | A0 | no reset orphans a commit |
| 60 | a3f87133 | C5 — resume self-heals orphaned commit | High | A0, C4 | resume ff-reattaches |
| 70 | f2de392b | C6/C6a/C7 — CPU watchdog + conformance salvage | High | A0, B(flag) | hung-complete worker salvaged |
| 80 | 379db767 | C8 — dirty-tree quarantine (truncation-safe) | High | A0 | relaunch self-heals, never destroys |
| 90 | e9bdac75 | Workstream B — rate-limit park/resume/ceiling | High | A0 | parks until reset, no spawn-burn |
| 100 | 84c209ae | D1/D2 — promote-once + activity cap | High | A0 | no backfill loop, bounded state.json |
| 110 | 5783cf7f | D3/D4/D5 — prd_path on resume + citadel self-heal | High | A0 | refine→resume reaches citadel |
| 120 | 88a4cdd6 | E1–E6 — forward-created validator awareness | High | A0 | creation-heavy bundles launch clean |
| 130 | c8192339 | E7 — review hammer cross-file scope | Med | A0 | cross-file drift caught |
| 140 | 087731c7 | E8 — flake-tolerant release gate (parametrized) | Med | A0 | CI green = real failures |
| 150 | db89b7f0 | E9a — serialize codegraph handshake test | Low | — | no expensive-tier flake |
| 160 | 612217e2 | E9b — install.sh audit-write | Low | — | documented event emitted |
| 170 | 71001154 | Harden: code quality | High | all impl | zero P0-P1 in MODIFIED_FILES |
| 180 | ed840487 | Audit: data flow integrity | High | +170 | shared predicates single-source |
| 190 | 5495bee2 | Harden: test quality | High | +180 | every AC mapped, strong asserts |
| 200 | 1cf82fe7 | Audit: cross-reference consistency | High | +190 | docs match code |
| 210 | 00fa0662 | Closer: full gate + release | High | all | shipped prerelease, gate green @c4 |
