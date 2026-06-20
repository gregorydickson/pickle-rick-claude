---
status: draft
priority: P1
filed: 2026-05-05
slot: 1o
forensic_origin: bundle session 2026-05-04-f416c6cc run #2 (16:59→17:28 local)
---

# PRD: Manager / Worker Backend Split — `state.worker_backend` Field

**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`

## Problem

The current architecture has one knob: `state.backend` selects the implementation backend used for both the **manager loop** (mux-runner manager spawn at `mux-runner.ts:2078-2086`) and **worker spawns** (spawn-morty at the 4 spawn sites enumerated by R-XBL-2 SoT).

Run #2 of bundle `2026-05-04-f416c6cc` (codex-spark backend) captured a captured tmux line that surfaced **F1**: the codex-spark MANAGER hallucinated a backend flip to `'hermes'`, narrating *"I'll try one last time under Hermes for that ticket, which previously fa…"* — then edited `state.backend` to `'hermes'`. Workers spawned in a 2nd backend that weren't even part of the operator's launch directive. R-XBL-3 (now deployed) catches this *read*-side at pre-spawn — but the underlying R12 risk **(manager-tier reliability for orchestration roles)** materialized: codex-spark is unreliable as a MANAGER even when it's an acceptable WORKER.

The hybrid the operator actually wants is:
- **Manager = claude** (reliable orchestration, doesn't hallucinate state edits)
- **Worker = codex-spark** (cheap + fast at bulk ticket implementation)

That hybrid is **inexpressible** today. R-XBL-3 prevents the symptom at runtime but doesn't enable the legitimate hybrid configuration. The operator either pays for claude on every spawn (expensive) or risks a codex-spark manager going off-script.

This bug class is symmetrical with `state.codex_model` (per-session model override on top of `pickle_settings.default_codex_model`); the field-level fix is identical in shape.

## Proposal

Introduce optional `state.worker_backend` field. Resolution order at every worker spawn site:

```
PICKLE_REFINEMENT_LOCK=1 (refinement-only, hardcoded claude — wins everything)
  → state.worker_backend (when set)
  → state.backend (fallback, current behavior)
```

The manager continues to read `state.backend` (claude when operator wants reliable orchestration). Workers consult `state.worker_backend` first.

## Requirements

### R-WBS-1 — Field definition
- Add `worker_backend?: string` to `State` type in `extension/src/types/index.ts`.
- Allowed values: same set as `backend` (`claude`, `codex`, `hermes`, ...) plus `null`/`undefined`.
- Documented as optional override: when present, all worker spawns use it; when absent or null, `state.backend` is used.

### R-WBS-2 — Spawn-site resolution
- `extension/src/bin/spawn-morty.ts` — at the existing `StateManager.read(statePath).backend` resolution point, consult `state.worker_backend` first; fall back to `state.backend`. Result is the value passed to `buildWorkerInvocation()`.
- `extension/src/bin/microverse-runner.ts:251` — same precedence.
- `extension/src/bin/mux-runner.ts:2078-2086` (manager spawn) — does NOT consult `worker_backend`; manager always uses `state.backend`.
- `extension/src/bin/spawn-refinement-team.ts` — refinement-only; PICKLE_REFINEMENT_LOCK=1 still wins; worker_backend is **ignored** for refinement spawns (refinement integrity invariant unchanged).
- `extension/src/services/backend-spawn.ts` — helper functions accept and forward worker_backend when configured.

### R-WBS-3 — `--worker-backend` CLI flag at setup
- `setup.ts` accepts `--worker-backend <name>` and writes the value into `state.worker_backend` at session creation. Validates against the same allowed-set as `--backend`.
- Absence preserves current behavior (no field written, falls back to `backend`).

### R-WBS-4 — Activity event for forensics
- New event `worker_backend_resolved` emitted at each spawn site, with payload `{ worker_backend, backend, source }` where `source ∈ { 'worker_backend', 'backend', 'env_lock' }`.
- Registered in `VALID_ACTIVITY_EVENTS` (`extension/src/types/index.ts`).
- Schema entry in `activity-events.schema.json`.
- Distinct from R-XBL-1's `worker_spawn_backend_resolved` — that event records source-of-truth audit; this event records the additional `worker_backend` precedence layer.

### R-WBS-5 — State-field invariant + trap-door
- Add to `extension/CLAUDE.md` `## state.json Field Invariants`:
  > `worker_backend` is the optional per-session worker-spawn backend override; falls back to `backend` when absent. Refinement spawns ignore this field (PICKLE_REFINEMENT_LOCK=1 still forces claude).
- Add trap-door entry on `spawn-morty.ts (worker_backend resolution)` — INVARIANT, BREAKS, ENFORCE.
- Update existing R-XBL trap-door entries to mention `worker_backend` precedence above `backend`.

### R-WBS-6 — Tests
- `extension/tests/state-field-invariants.test.js` — assert `worker_backend` is optional non-empty string when present.
- `extension/tests/integration/worker-backend-split.test.js` — end-to-end: state with `backend='claude' worker_backend='codex'` spawns worker with codex command, manager with claude command. Refinement spawn ignores both and uses claude (PICKLE_REFINEMENT_LOCK=1 path).
- `extension/tests/spawn-morty-backend-resolution.test.js` — extend existing tests to cover `worker_backend` precedence over `backend`.

## Acceptance Criteria

- **AC-WBS-01** — `extension/src/types/index.ts` `State` type contains `worker_backend?: string`.
- **AC-WBS-02** — `setup.ts` accepts `--worker-backend <name>`; absence keeps state.worker_backend unset; presence writes the validated value.
- **AC-WBS-03** — `spawn-morty.ts` resolution: worker_backend precedence test asserts that when `state.worker_backend='codex' state.backend='claude'`, the spawn command uses codex.
- **AC-WBS-04** — Manager spawn at `mux-runner.ts:2078-2086` ignores `worker_backend` (always uses `state.backend`); regression test asserts manager spawn always uses `state.backend` regardless of `worker_backend`.
- **AC-WBS-05** — `spawn-refinement-team.ts` ignores `worker_backend` (refinement-only invariant); PICKLE_REFINEMENT_LOCK=1 path test asserts claude regardless of state.
- **AC-WBS-06** — `worker_backend_resolved` event emitted with `{ worker_backend, backend, source }` payload, registered in `VALID_ACTIVITY_EVENTS` and `activity-events.schema.json`.
- **AC-WBS-07** — `extension/CLAUDE.md` contains the state-field invariant for `worker_backend` and the new spawn-morty trap-door entry.
- **AC-WBS-08** — `audit-worker-backends.ts` (R-XBL-6) recognizes `worker_backend` resolution as legitimate (not a mismatch); informational events excluded from leak-count count.

## Notes & Refinement Hooks

- This PRD ENABLES the hybrid claude-manager + codex-spark-worker mode that motivated R12 in the bundle Risk Register. It is the **architectural follow-up** to R-XBL-3 (which only catches mismatches; doesn't enable the legitimate hybrid).
- Cycle 1 should validate that `worker_backend=codex` survives the same env-poison defenses as `backend` (R-XBL-7 integration test pattern).
- Cycle 2 should enumerate every spawn site and confirm precedence order matches R-WBS-2.
- Cycle 3 should validate codex-spark stress test in worker role only (manager=claude); compare cost + reliability vs all-claude run #5.
- After this lands, slot 1p (worker completion_commit reliability) becomes more tractable because worker prompts can be tuned independently of manager prompts.
