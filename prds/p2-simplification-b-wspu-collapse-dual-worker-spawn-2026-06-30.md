# PRD — B-WSPU: collapse the dual worker-spawn model into ONE synchronous lifecycle

**Code:** B-WSPU · **Priority:** P2 (highest-value structural subtraction) · **Bundle:** simplification / pure subtraction, 4 workstreams · **Pipeline:** NORMAL `/pickle-pipeline --scope branch` with R-PSRB-aware ticket tiering (see `## R-PSRB build protocol`).

**Operator directive (2026-06-30):** collapse the dual worker-spawn model — the concrete 5th meta-defect / recovery-sprawl lever. Sign-off given.

Source context: `BUG-REPORT-2026-06-30-beta31-medium-tier-routes-detached-poll-falsefails-in-1s.md` (R-LTDM) + the B-WSPU MASTER_PLAN row + the 2026-06-30 B-SSVR build's own late-flush `phase_no_progress` (fresh field evidence — a detached-path bug that false-failed the pickle phase).

---

## Problem to solve

There are two parallel ways to spawn a ticket worker, and they have drifted into two whole lifecycles:

1. **Synchronous** — `runIteration` (`mux-runner.ts:3479`) spawns the **manager** `claude -p`, which runs the `/pickle` prompt and spawns the worker by shelling `spawn-morty.js` through a **foreground Bash tool call** (naturally throttled by blocking on the manager turn). Used for trivial/small tickets and default-tier tickets.
2. **Detached** — the orchestrator spawns `spawn-morty.js` **directly** (`spawnDetachedLargeTierWorker`, `mux-runner.ts:3405`) `detached:true`+`unref()` so it survives the 600s Bash ceiling, then hand-rolls a poll loop (`mux-runner.ts:10878-11050`) with its own disposition logic. Used for `medium`+`large` tier (any ticket whose `worker_timeout_seconds > 600`).

**The detached half is where every recent field bug in this area lives** — R-LTDM (premature poll verdict, beta.32), R-WPEX (detached-log flush-death, beta.28), R-MWBG runtime half (medium-tier ceiling gap, beta.31), and the 2026-06-30 B-SSVR late-flush `phase_no_progress`. Every detached bug is a tax on maintaining two spawn models that drift. The routing predicate alone is evaluated at **three** sites (`mux-runner.ts:10841`, `:10878`, `:6104`).

**Root finding that unlocks the collapse (from the 2026-06-30 investigation):**
- The 600s ceiling is a **hard Claude Code Bash-tool cap** (`max 600000ms`) on the manager's worker-spawn Bash call, hardcoded as `BASH_TOOL_CEILING_SECONDS = 600` (`mux-runner.ts:3332`) with **no override**. It cannot be removed at source.
- **BUT the synchronous path already survives >600s work via re-spawn-resume** — the manager prompt (`extension/templates/_pickle-manager-prompt.md:156`, shipped R-MWBG half-1 beta.29) mandates: if a worker's Bash call is SIGKILLed at 600s, re-spawn the SAME `spawn-morty.js` foreground on the next turn; the worker **resumes from its on-disk artifacts** (`research_*`, `plan_*`, `conformance_*`). Progress accumulates across the ceiling over multiple manager turns.
- **Therefore the detached path is an optimization (avoid multi-turn re-spawn churn), NOT a correctness requirement.** The synchronous re-spawn-resume model is the reliable pre-detached baseline (~v1.5). Reverting to it is the operator's north-star subtraction.

## Solution — DELETE the detached lifecycle; unify all tiers on synchronous re-spawn-resume

Route **every tier** through `runIteration` (synchronous manager, foreground `spawn-morty.js`, re-spawn-resume for >600s). Delete the entire detached spawn arm, poll loop, disposition functions, `state.detached_worker`, the env kill-switches, the `large_tier_*` activity events, and the `AC-R-WPEXA-*` / `large-tier-detached-*` tests. **Do NOT touch** the shared salvage primitives (`salvage-ticket.ts`, `reconcile-ticket-truth.ts`, `ticket-completion-evidence.ts`) or the synchronous salvage seams (`routeExitPathSalvage` `mux-runner.ts:6440`, the exit-path/failed-flip adapters `:5691-5744`, `guardCompletionCommitBeforeDone`) — those are shared and stay.

### The correctness bet (explicit, auditable)
This bundle bets that **synchronous re-spawn-resume is reliable enough to be the sole worker lifecycle** — the same bet as reverting to the reliable pre-detached baseline. Validation is field-soak, not the gate: after ship, run ≥2 representative bundles (incl. one with a genuine >600s `medium`/`large` ticket) hands-off and confirm the worker resumes cleanly across the 600s SIGKILL. If re-spawn-resume proves flaky in the field, that is evidence to reconsider — but the deployed runtime is unchanged until `install.sh`, so the bet is reversible (revert branch / hold deploy). **The closer must HOLD the shared-runtime deploy until the field-soak confirms it — do not blind-deploy a spawn-model change while another repo's pipeline (e.g. loanlight-api) shares the runtime.**

---

## Workstreams

### WS-1 — Route all tiers synchronous; delete the detached SPAWN + poll (group A, `complexity_tier: medium`)

**Files:** `extension/src/bin/mux-runner.ts`.

**R-PSRB:** group A (spawn mechanics) — **pipeline-safe at any tier** (the deployed runtime makes the routing decision before the fix-worker runs; the source edit does not affect the already-routed worker; this ticket does not touch any salvage/disposition function).

**Deletions / changes:**
1. Delete the main-loop **detached spawn arm** (`mux-runner.ts:10841-10869`) and the **detached poll loop** (`:10878-11050`).
2. Delete the `state.current_ticket_tier === 'large'` → `routeLargeTierTicket` branch (`:11054`) so `large` also falls through to synchronous `runIteration` (`:11059`).
3. Delete the **recovery re-exec detached branch** (`:6104-6127`, `reExecutionSeam.spawnImplementPass`) — the re-exec always spawns synchronous.
4. Delete `spawnDetachedLargeTierWorker` (`:3405`), `routeLargeTierTicket` (`:3286`), `largeTierDetachedEnabled` (`:3323`), `tierExceedsBashCeiling` (`:3353`), `BASH_TOOL_CEILING_SECONDS` (`:3332`), and their exports (`bin/CLAUDE.md` Module Export Catalog).
5. Remove `PICKLE_LARGE_TIER_DETACHED` and `shouldForceDetachForLargeTier` / `LARGE_TIER_DETACH_FORCE_ENV` (`backend-spawn.ts:806,843`) + its spawn-morty consumer (`spawn-morty.ts:2120`, restore the unconditional `shouldIsolateSessionGroup()` path).

**KEEP (shared / synchronous-path):** `resolveExitDrainFallbackMs` + `PICKLE_EXIT_DRAIN_FALLBACK_MS` (consumed by the synchronous manager drain `:3611`), `routeRecoveryBeforeTerminal`, all `salvage-ticket.ts` / `reconcile-ticket-truth.ts` / `ticket-completion-evidence.ts`, `routeExitPathSalvage`.

**ACs:**
- `runMuxRunnerMain` has exactly ONE worker-spawn path: `await runIteration(...)`. No `state.detached_worker` read/write remains in the main loop. — `grep -c 'detached_worker' mux-runner.ts` limited to schema-migration/deletion sites only.
- A `large`/`medium`-tier ticket routes to `runIteration` (synchronous), not a detached spawn. — new `mux-runner` unit test asserting the routing.
- `tierExceedsBashCeiling`, `spawnDetachedLargeTierWorker`, `routeLargeTierTicket`, `largeTierDetachedEnabled`, `BASH_TOOL_CEILING_SECONDS` are absent from source + export catalog. — `grep` AC.
- Full gate green.

### WS-2 — Delete the detached DISPOSITION + state field + events (group B, `complexity_tier: small`)

**Files:** `extension/src/bin/mux-runner.ts`, `extension/src/types/index.ts`.

**R-PSRB (LOAD-BEARING):** group B edits the detached **disposition** (`routeDeadDetachedWorkerDisposition` `:8505`, `routeDetachedWorkerTerminalNoProgress` `:8372`) — literal R-PSRB. **Dodge: `complexity_tier: small`** so the fix-worker runs SYNCHRONOUS (≤600s budget) and never traverses the detached disposition it deletes. This is the INVERSE of the usual `→large` dodge, because the deleted code lives on the large/detached path. If a `small` worker needs >600s, re-spawn-resume continues it synchronously (dogfoods the unified model). **This ticket MUST NOT touch the shared primitives or synchronous salvage seams.**

**Deletions:**
1. `routeDeadDetachedWorkerDisposition` (`:8505`), `routeDetachedWorkerTerminalNoProgress` (`:8372`), `reapTimedOutDetachedWorker` (`:8752`), `validateDetachedWorkerIdentity` (`:8695`), `readProcessStartEpochMs` (`:8665`), `resolveCleanTreeAttribution` (`:8479` — verify detached-only; if a synchronous seam also calls it, KEEP), `resolveDetachedPollIntervalMs` (`:7923`) + `DETACHED_POLL_INTERVAL_ENV` / `DETACHED_POLL_INTERVAL_DEFAULT_MS` + `PICKLE_DETACHED_POLL_INTERVAL_MS`.
2. `state.detached_worker` field + `DetachedWorker` type (`types/index.ts`) + its `normalizeV5StateDefaults` default + the `state-field-invariants` entry. Schema-neutral removal (no `LATEST_SCHEMA_VERSION` change; an absent field simply stays absent).
3. `large_tier_worker_spawned`, `large_tier_worker_poll`, `large_tier_worker_reaped`, `large_tier_routed` from `VALID_ACTIVITY_EVENTS` (`types/index.ts`) + `activity-events.schema.json`.

**ACs:**
- None of the deleted disposition symbols remain in source or export catalog. — `grep` AC.
- `VALID_ACTIVITY_EVENTS` no longer contains `large_tier_*`; `activity-event-payload.test.js` updated. — test.
- `state.detached_worker` removed; no reader/writer remains. — `grep` AC.
- Full gate green.

### WS-3 — Delete the detached tests + trap doors (`complexity_tier: small`)

**Files:** delete `extension/tests/integration/large-tier-detached-spawn.test.js`, `large-tier-detached-poll.test.js`, `large-tier-detached-dead-disposition.test.js`, `large-tier-detached-timeout-reap.test.js`, `large-tier-detached-e2e.test.js`, `large-tier-recovery-reexec-detached.test.js`, `large-tier-resume-reattach.test.js`, `large-tier-routing-fallback.test.js`, `extension/tests/mux-runner-detached-poll-throttle.test.js`, `extension/tests/r-mwbg-tier-exceeds-bash-ceiling.test.js`, `extension/tests/integration/salvage-backfill-verdict-authority.test.js` (detached-only). Update `extension/tests/state-field-invariants.test.js` (drop `detached_worker`), `activity-logger.test.js` / `activity-event-payload.test.js` (drop `large_tier_*`). Remove the `mux-runner.ts (R-LTDM detached-poll throttle)`, `mux-runner.ts (R-CWGE clean-tree salvage back-fill verdict reach)`, and the `detached_worker` state-field trap doors from `extension/CLAUDE.md`; ensure `audit-trap-door-enforcement.sh` and `test-registration-hygiene.test.js` stay green after the deletions.

**R-PSRB:** none (test/doc deletion). `small`.

**ACs:** the named test files are gone; `npm run test:integration` + `test:fast` discover no orphaned references; `audit-trap-door-enforcement.sh` green; `bash scripts/audit-quarantine.sh` green.

### WS-4 — Manager prompt + env-doc cleanup (`complexity_tier: small`)

**Files:** `extension/templates/_pickle-manager-prompt.md`, `.claude/commands/pickle.md` / `send-to-morty.md` (if they carry large-tier-special framing), the project `CLAUDE.md` Environment Variables table (drop `PICKLE_LARGE_TIER_DETACHED`, `PICKLE_DETACHED_POLL_INTERVAL_MS`, `PICKLE_LARGE_TIER_DETACHED_WORKER`; keep `PICKLE_EXIT_DRAIN_FALLBACK_MS`), `README.md` if it references detached.

Per the investigation the manager prompt needs **minimal** change — the foreground-blocking + re-spawn-resume contract (`:156`) already IS the unified model. Clarify that re-spawn-resume is the SOLE >600s mechanism and drop any "large-tier is special / route to /pickle-tmux" framing.

**R-PSRB:** none. `small`.

**ACs:** docs contain no live reference to the deleted env vars / detached path; `release-gate-parity.test.js` + `codegraph-docs-optin-parity` green (don't disturb test-pinned literals); `compose-manager-prompt-from-skill.test.js` green.

---

## ⚠️ Trap-door / entry-format note (from the B-SSVR closer, 2026-06-30)

Every `extension/CLAUDE.md` trap-door entry MUST be a **single physical line** — the citadel `rule-set-invariant-audit` parser is line-oriented and reads a wrapped INVARIANT/BREAKS as "no BREAKS". This bundle mostly REMOVES trap doors; any that are added/edited stay one line.

## Simplification Review (subtract-before-add)

1. **Is the addition necessary at all?** This bundle adds NOTHING — it is **pure removal**. It deletes a whole second worker lifecycle (spawn arm + poll loop + 5 disposition functions + 1 state field + 3 env vars + 4 activity events + ~11 test files + 3 trap doors). Ideal case; no further justification needed.
2. **Can it REUSE instead of ADD?** N/A (removal). The retained path (synchronous `runIteration` + manager re-spawn-resume) is the existing, reliable primitive; we reuse it for all tiers instead of maintaining a parallel one.
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** Yes — this IS that subtraction. The detached path is the brittle complexity (R-LTDM/R-WPEX/R-MWBG). R-LTDM's poll-throttle was a patch on a patch; this removes the patched thing.
4. **What can this issue SUBTRACT?** The entire detached lifecycle. The system leaves smaller and flatter: one spawn path, one throttle mechanism (the blocking manager turn), three routing sites collapse to zero, ~11 test files and ~3 trap doors deleted.

## R-PSRB build protocol

- **WS-1 (group A, spawn mechanics):** pipeline-safe at `medium`. The deployed beta.x runtime routes + completes the fix-worker via its own (unchanged) logic; the source edit to routing/spawn does not affect the already-routed worker.
- **WS-2 (group B, detached disposition):** `complexity_tier: small` — forces the fix-worker onto the SYNCHRONOUS path so the deployed detached disposition it is deleting never applies to it. **Inverse-tier dodge.** If refinement or the runner cannot honor small, hand-build WS-2 in-process per the R-PSRB protocol.
- **Never** touch `salvage-ticket.ts` / `reconcile-ticket-truth.ts` / `ticket-completion-evidence.ts` or the synchronous salvage seams in this bundle — those are hard-R-PSRB and out of scope.
- Build on the beta.34 tree (main). Deployed runtime is currently beta.33 (has the detached path) — that is expected and correct for the build; the collapse takes effect only at the (held) deploy.

## Acceptance (bundle-level)
- Full local release gate green: tsc + eslint + all audits + audit-fix-commits + fast-c4 + integration + expensive.
- `grep` proves the detached lifecycle symbols are absent from source, exports, tests, trap doors, and env-doc tables.
- One worker-spawn path remains (`runIteration`); a `medium`/`large` ticket routes synchronous.
- Closer HOLDS the shared-runtime `install.sh` deploy until a field-soak (≥2 bundles, incl. one >600s ticket) confirms re-spawn-resume; the git release (bump + push + `gh release`) proceeds normally.

## Implementation Task Breakdown

| Order | ID | Title | Tier | Files |
|---|---|---|---|---|
| 10 | e345fb12 | Route all tiers synchronous; remove detached spawn arm + poll | medium | mux-runner.ts, backend-spawn.ts, spawn-morty.ts |
| 20 | 0c5daf46 | Delete detached disposition + state field + events | small (R-PSRB dodge) | mux-runner.ts, types/index.ts |
| 30 | 8258253b | Delete detached tests + trap doors | small | tests/integration/large-tier-detached-*, CLAUDE.md |
| 40 | 775e9a17 | Manager prompt + env docs → single lifecycle | small | _pickle-manager-prompt.md, CLAUDE.md, README.md |
