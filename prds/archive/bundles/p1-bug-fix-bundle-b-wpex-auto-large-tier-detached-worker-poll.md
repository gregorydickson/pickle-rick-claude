---
title: P1 Bug-Fix Bundle — B-WPEX-AUTO — large-tier tickets autonomously buildable under headless mux (detached worker + manager poll), retiring the interactive-tmux punt
status: draft
priority: P1
filed: 2026-06-17
finding: "#108 R-WPEX (autonomous-fix workstream)"
r_code_prefix: R-WPEXA
backend_constraint: any
peer_prds:
  related:
    - prds/archive/bundles/p1-bug-fix-bundle-r-wpex-worker-silent-death.md   # parent finding + captured repro (600s Bash-tool ceiling)
    - prds/p1-design-simplification-and-autonomy-2026-06-13.md  # north star: never discard verified work; recover-don't-park
supersedes_residual:
  - "AC-GA-REC-2 routeLargeTierTicket interactive punt (de345802) — kept as kill-switch fallback only"
---

# B-WPEX-AUTO — autonomous large-tier worker lifecycle

## Why (the gap, HEAD-verified 2026-06-17)

The captured R-WPEX repro (finding #108, session `2026-06-13-2bd4740a`) proved a headless
`claude -p` MANAGER cannot hold a `>600s` (large-tier) worker against the **600s Bash-tool
ceiling**: a foreground `spawn-morty` is SIGKILLed at 600s, its non-detached worker child dies,
buffered stdout is lost → 0-byte log. The GA stopgap that shipped (B-GA beta.7, `de345802`) is
`routeLargeTierTicket` in `mux-runner.ts`: it detects a `complexity_tier: large` ticket, emits a
`large_tier_routed` event, and returns `sanctionedPath: 'interactive_pickle_tmux'`. Its own
docstring states it **"NEVER spawns a subprocess and NEVER calls runIteration."**

**That is a punt, not autonomy.** The headless pipeline cannot build a large-tier ticket on its
own — it hands the ticket to a human-driven interactive `/pickle-tmux`. This is the single
remaining mechanism by which large bundles still require babysitter hand-building (verified: every
recent large bundle shipped via babysitter takeover or interactive tmux, never the autonomous mux
loop). The two **autonomous** fix directions the parent PRD named — (1) detached worker + manager
poll, (2) scale the phase-set so each manager turn fits `<600s` — never shipped.

D2/W2/W3/W4 (completion authority, salvage-before-fail, single recovery choke point) and W5
(removals, governance) all shipped and are green at HEAD; `salvageTicket` (10 callers),
`reconcileTicketTruth` (6 callers), `routeRecoveryBeforeTerminal` (6 seam callers + a passing
`halt-or-recover-choke-point.test.js` lint), `pickle-recover.ts`, the wall-clock-cap default-off,
and the subtract-before-add governance gate are all present. This bundle is the **one** autonomy
workstream that is diagnosed but unbuilt.

## North-star alignment

- **Recover, don't park** — a large ticket is *runnable autonomously*, not handed off. The
  interactive punt is the park; this removes it.
- **Never discard verified work** — the detached-worker poll reuses the EXISTING `salvageTicket` /
  `reconcileTicketTruth` ground-truth oracle on poll-completion; no new completion path.
- **Subtract before add** — `routeLargeTierTicket`'s interactive disposition is RETAINED only as
  the `PICKLE_LARGE_TIER_DETACHED=off` kill-switch fallback, not deleted, and no NEW skip flag is
  introduced (the lifecycle is the default; the env var is the documented escape hatch).

## Design — decouple worker lifetime from the manager's 600s Bash turn

Today `runIteration` spawns `spawn-morty` and AWAITS it inside one manager `claude -p` turn, which
the harness SIGKILLs at 600s. The fix is a **detached worker + cross-iteration poll** lifecycle for
large-tier tickets (small/medium keep the existing in-turn await — they fit under 600s):

1. **Spawn detached, return fast.** For a `complexity_tier: large` ticket, the manager spawns
   `spawn-morty` fully detached (the session-group detach from R-CSI/W2.R1 already exists at
   `spawn-morty.ts:2069`), persists `{ worker_pid, ticket_id, spawned_at_epoch, worker_log_path }`
   into a new schema-neutral `state.detached_worker` arm, emits `large_tier_worker_spawned`, and
   returns control to the manager loop WITHOUT blocking the worker's full duration.
2. **Poll on subsequent iterations.** When the manager loop re-enters with a live
   `state.detached_worker` for the current ticket, it does NOT re-spawn. It reads ground truth via
   `reconcileTicketTruth` + worker liveness (`isProcessAlive`) + artifact progress
   (`countWorkerArtifacts`) and decides: still-running → emit `large_tier_worker_poll` and yield;
   completed → run the gate + commit via the EXISTING `salvageTicket` disposition; dead-without-
   completion → route through `routeRecoveryBeforeTerminal` (the W4a choke point) exactly like any
   other seam.
3. **Bounded by existing caps.** A detached worker is bounded by the per-ticket
   `worker_timeout_seconds` (large tier = 4800s) measured from `spawned_at_epoch` (NOT the manager
   turn), and by `state.worker_artifact_progress` zero-delta accounting (R-WMW). On timeout it is
   reaped (session-group kill) and routed through the recovery choke point.
4. **Crash-safe.** `state.detached_worker` survives manager relaunch / `setup.js --resume`; on
   resume the poll re-attaches to a still-live PID (ground-truth, not re-spawn) or salvages a
   completed-but-uncommitted tree.

## Acceptance Criteria (machine-checkable)

- [ ] **AC-R-WPEXA-1 — large-tier spawns detached and returns within the manager turn.** A
  `complexity_tier: large` ticket causes the manager loop to spawn `spawn-morty` detached, persist
  `state.detached_worker.{worker_pid,ticket_id,spawned_at_epoch,worker_log_path}`, emit
  `large_tier_worker_spawned`, and return control in `< 600s` without awaiting worker completion.
  No raw foreground `spawn-morty` await on the large-tier path. — Type: integration
- [ ] **AC-R-WPEXA-2 — poll re-attaches, never re-spawns.** With a live `state.detached_worker` for
  the current ticket, the next manager iteration MUST NOT spawn a second worker; it reads worker
  liveness + artifacts via `reconcileTicketTruth`/`isProcessAlive`/`countWorkerArtifacts` and emits
  `large_tier_worker_poll`. Assert exactly one `spawn-morty` invocation across N poll iterations
  for one ticket. — Type: integration
- [ ] **AC-R-WPEXA-3 — completed detached worker commits via the existing salvage oracle.** When a
  detached worker exits with a gate-passing tree, the poll path commits + marks Done through the
  EXISTING `salvageTicket` disposition (NOT a new completion path); `git grep` proves the large-tier
  completion routes through `salvageTicket(`. Reflog has no orphaned ticket commit. — Type: integration
- [ ] **AC-R-WPEXA-4 — dead-without-completion routes through the W4a choke point.** A detached
  worker that dies (0-byte log, no gate-passing tree) routes its terminal decision through
  `routeRecoveryBeforeTerminal` (the single choke point), not a bespoke park; the
  `halt-or-recover-choke-point.test.js` forward-protection lint still passes with the new seam
  included. — Type: integration + lint
- [ ] **AC-R-WPEXA-5 — bounded by per-ticket worker_timeout from spawned_at_epoch.** A detached
  worker exceeding `worker_timeout_seconds` (measured from `state.detached_worker.spawned_at_epoch`,
  NOT the manager turn) is reaped via session-group kill and routed through recovery; the
  R-WMW zero-artifact-progress auto-skip still fires on a genuinely wedged detached worker. — Type: integration
- [ ] **AC-R-WPEXA-6 — crash/resume re-attaches to a live PID.** `setup.js --resume` with a live
  `state.detached_worker` PID re-attaches via the poll path (ground truth) and does NOT re-spawn;
  a completed-but-uncommitted tree on resume is salvaged. `state.detached_worker` is schema-neutral
  (additive, NO `LATEST_SCHEMA_VERSION` bump; absent reads back as null). — Type: integration + test
- [ ] **AC-R-WPEXA-7 — interactive punt retained as kill-switch only.** `PICKLE_LARGE_TIER_DETACHED=off`
  (literal lowercase `off`) reverts large-tier handling to the existing `routeLargeTierTicket`
  interactive disposition; the default (unset/any other value) uses the detached-worker lifecycle.
  No NEW `skip_*_reason` flag is added (governance: the env var is the documented escape hatch). — Type: test
- [ ] **AC-R-WPEXA-8 — CATCH-22 deploy ordering.** Every `mux-runner.ts` control-flow edit compiles
  the matching `extension/bin/mux-runner.js` in the SAME commit; no edit is expected to self-activate
  under the running runner. — Type: test (compiled-mirror parity)
- [ ] **AC-R-WPEXA-9 — R-MWIS no-hang preserved + exit-drain hardened.** The genuinely-silent
  0-byte worker-exit invariant (`mux-silent-worker-exit.test.js`) stays green; `EXIT_DRAIN_FALLBACK_MS`
  is raised from 250ms to a configurable long fallback (default 30000ms) so a healthy worker's piped
  output is never truncated, while a truly silent exit still finalizes within the bounded window.
  `'close'` remains the primary completion signal. — Type: test
- [ ] **AC-R-WPEXA-10 — typecheck + lint + full gate clean.** `npx tsc --noEmit && npx eslint src/
  --max-warnings=-1 && npm run test:fast:budget && npm run test:integration`. — Type: typecheck/test

## New state arm (schema-neutral, additive)

`state.detached_worker: { worker_pid: number, ticket_id: string, spawned_at_epoch: number,
worker_log_path: string } | null` — written on detached spawn, cleared on completion/salvage/reap.
Additive like `rate_limit_park` / `recovery_attempts` (NO `LATEST_SCHEMA_VERSION` bump; defaulted to
`null` by `normalizeV5StateDefaults`; absent reads back as `null`; populated entries survive
migration untouched). A new `state-field-invariants.test.js` row enforces the shape.

## Activity events (all 7 registration touchpoints per R-PDD-oneOf)

`large_tier_worker_spawned`, `large_tier_worker_poll`, `large_tier_worker_reaped` — each registered
in `VALID_ACTIVITY_EVENTS`, `activity-events.schema.json` (`oneOf` ref), `activity-event-payload.test.js`
EVENT_CASES, and `spawn-refinement-team.ts:ACTIVITY_EVENT_SCHEMA_SECTION`. The existing
`large_tier_routed` event is retained for the kill-switch path.

## Out of scope

- The `routeRecoveryBeforeTerminal` choke point itself (shipped, green — this only ADDS the detached-
  worker-dead seam to it).
- Small/medium/trivial tier spawning (unchanged — they fit under the 600s manager turn).
- Codex-backend manager relaunch accounting (`evaluateCodexManagerRelaunch` — separate seam, unchanged).
- Deleting `routeLargeTierTicket` (retained as the kill-switch fallback per subtract-before-add).

## Cross-cutting safety (every mux-runner ticket)

- **Per-seam migration:** the existing in-turn await path is retained behind `PICKLE_LARGE_TIER_DETACHED=off`
  until the detached path's ACs are green; never a big-bang cutover.
- **CATCH-22:** compiled `.js` mirror in the same commit (AC-R-WPEXA-8).
- **Ground-truth reuse:** the poll path MUST call the existing `reconcileTicketTruth` / `salvageTicket`
  / `routeRecoveryBeforeTerminal` primitives — it MUST NOT introduce a parallel completion or park path
  (enforced by the `completion-authority-single-source.test.js` allowlist + the design-ground-truth audit).

## Simplification Review (subtract-before-add)

1. **What existing code does this replace, not just add to?** The interactive-tmux punt
   (`routeLargeTierTicket`) is demoted from default to kill-switch fallback — net behavior change is a
   removal of the human-handoff default, not a new parallel system.
2. **Does it introduce a new escape-hatch flag?** No new `skip_*_reason`. One env kill-switch
   (`PICKLE_LARGE_TIER_DETACHED`), matching the `PICKLE_RECOVERY_CONSOLIDATION` / `PICKLE_CODEGRAPH`
   precedent, with a documented removal condition (drop once detached-poll has soaked).
2. **Does completion/park reuse the single oracle?** Yes — `salvageTicket` + `routeRecoveryBeforeTerminal`;
   no new completion authority (enforced by `completion-authority-single-source.test.js`).
4. **What can be deleted once this soaks?** `routeLargeTierTicket` + the `large_tier_routed` event +
   the `PICKLE_LARGE_TIER_DETACHED` kill-switch, after one large-bundle soak proves the detached path.
   Tracked as a follow-up removal row, not left as permanent dual-path.
