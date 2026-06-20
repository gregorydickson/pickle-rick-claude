---
title: P1 — Workers spawn codex CLI despite state.backend=claude (cross-backend leak)
status: Draft
date: 2026-05-04
priority: P1
type: bug
peer_prds:
  related:
    - prds/archive/bug-reports/p2-worker-silent-exit-and-ticket-path-drift.md  # downstream effect — codex exits with usage-limit error → 0-byte / truncated worker logs
    - prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md   # the cap fix surfaced this leak by halting + relaunching repeatedly
    - prds/archive/bug-reports/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md  # adjacent — same operator workaround sequence
---

# PRD — Workers spawn codex CLI despite `state.backend=claude`

## Symptoms

Reliability-bundle session `2026-05-03-7d9ee8cc` ran with `state.backend = "claude"` (manually flipped from codex when the codex usage limit hit; codex usage resets May 5th 2026 12:31 AM). The session reached **37/38 tickets Done** but pipeline marked `failed` after `tool_retry_circuit_open` × 2; **0/4 phases ran** (never entered citadel/anatomy-park/szechuan-sauce).

Forensic check of `<session>/<ticket>/worker_session_*.log`: at least **11 worker logs across 8 different ticket directories** end with the codex CLI's signature output:

```
Reading additional input from stdin...
... [worker prompt transcript, ~270+ lines] ...
ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 5th, 2026 12:31 AM.
ERROR: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 5th, 2026 12:31 AM.
```

Affected ticket dirs (non-exhaustive): `36984f05`, `3829b975`, `3f6d670b`, `74a32429`, `968b6f66`, `ef87cd0e`, `f28d7f23`, plus larger logs that also match.

The "Reading additional input from stdin..." preamble plus the `https://chatgpt.com/codex/settings/usage` URL is unambiguous evidence: **the spawned worker process is the codex CLI**, not claude — even though `state.backend` is `"claude"`.

## Why this is distinct

This is **not** the same bug as worker silent-exit (`p2-worker-silent-exit-and-ticket-path-drift`). That PRD describes a worker process exiting with no log output. This PRD describes a worker process being **the wrong backend entirely**:

- Silent-exit (RC-1 in 1h) → worker_session log is 0 bytes, no spawn happened or process aborted instantly.
- Cross-backend leak (this PRD) → worker_session log is hundreds of KB to MB, but the process is codex when it should be claude. Codex then exits because of the usage limit, and the lifecycle artifact (`research_review.md`, `plan.md`, etc.) is never produced.

The downstream visible effect is similar (no progress, ticket stalls, `tool_retry_circuit_open`), but the root cause and the fix surface are completely different.

## Reproducer

1. Active session with `state.backend = "claude"` (set explicitly via `jq` patch).
2. Codex CLI logged in to a tier with a usage limit (so any actual codex spawn fails loudly).
3. Run `bash launch.sh <SESSION_ROOT>` to advance any ticket.
4. Inspect `<session>/<ticket>/worker_session_<pid>.log` — it should be claude prompt output, but it's codex output ending in the usage-limit error.

## Root cause hypotheses (not yet confirmed)

| # | Hypothesis | Surface | Likelihood |
|---|---|---|---|
| **H1** | `spawn-morty.ts` reads backend from somewhere other than `StateManager.read(state.json).backend` — possibly an env var (`PICKLE_BACKEND`), an inherited shell variable, or a stale settings JSON tmp snapshot — and that source still says "codex". | `extension/src/bin/spawn-morty.ts`; `extension/src/services/backend-spawn.ts` | **HIGH** — backend-spawn already has trap-door invariant about reading state through `StateManager.read()` (per `extension/CLAUDE.md`); a path that doesn't go through it would explain the leak |
| **H2** | A sub-tool the worker invokes (e.g., `/codex:rescue`, council-publish, send-to-morty) calls codex directly regardless of session backend. | Skill prompts in `~/.claude/skills/`, `.claude/commands/send-to-morty*.md` | MEDIUM — these are user-level tools and may not honor session backend |
| **H3** | Manager-level relaunch (`evaluateCodexManagerRelaunch`) keeps spawning codex on relaunch even after the operator flipped backend → claude in `state.json`. R-ICP fixed cap-handling for codex; if relaunch path doesn't refresh backend on each manager turn, it would keep firing codex. | `extension/src/bin/mux-runner.ts` (`evaluateCodexManagerRelaunch`) | MEDIUM |
| **H4** | `tmux_mode` ownership claim or pipeline-runner spawn carries an env (`PICKLE_BACKEND=codex`) from the original session start, even though `state.json` was patched. | Process env at pipeline-runner / mux-runner spawn | MEDIUM-LOW |

The most useful next diagnostic step is to (a) `dtruss` / `strace` a worker spawn and capture which binary actually executes, and (b) `jq '.backend, .activity[-5:]' state.json` immediately before and after spawn to confirm which value the spawn site reads.

## Why this matters

- **All progress on `state.backend=claude` after a backend flip is suspect.** If H3 is correct, the 22 unpushed commits on session `2026-05-03-7d9ee8cc` may have been written by codex workers that happened to succeed before the usage limit cut them off, even though we believed claude was driving.
- **Codex usage-limit errors silently consume worker iterations.** Each failed spawn burns one `current_ticket_max_iterations` slot without producing a lifecycle artifact, looking exactly like a circuit-breaker / silent-exit failure to mux-runner.
- **Bundle-shipping integrity is undermined.** When the operator flips `state.backend = "claude"` because codex is unavailable, they expect claude workers. If codex is still being spawned, the bundle ships under unknown attribution.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| **R-XBL-1** | Diagnose: in `extension/src/bin/spawn-morty.ts`, log the resolved backend AND its source (state.json, env var, settings, default) at spawn time as an `activity` event `worker_spawn_backend_resolved` with payload `{backend, source, pid}`. Lands first as a diagnostic so we can confirm or rule out H1–H4. | P0 |
| **R-XBL-2** | Single source of truth: every worker spawn site (spawn-morty, spawn-refinement-team, spawn-gate-remediator, microverse-runner worker spawn) reads backend exclusively via `StateManager.read(statePath).backend` immediately before exec. No env-var override, no settings-file override, no inherited variable. Exception: a NEW explicit `--backend <name>` CLI flag override is allowed for one-off operator override, logged as `worker_spawn_backend_override` activity event. | P0 |
| **R-XBL-3** | Pre-spawn assertion: spawn site asserts the resolved backend matches `state.backend`. If they differ, fail loud — write `worker_spawn_backend_mismatch` activity event with both values, exit non-zero, do NOT spawn. | P0 |
| **R-XBL-4** | Manager relaunch path (`evaluateCodexManagerRelaunch`) re-reads `state.backend` on every relaunch decision, never caches it. If `state.backend !== 'codex'`, the codex-relaunch path is short-circuited and a generic relaunch decision is made via the regular per-backend path. | P0 |
| **R-XBL-5** | Sub-tools (`/codex:rescue`, send-to-morty) that explicitly invoke codex regardless of session backend MUST be documented as such and emit `subtool_backend_override` activity event. If the user has flipped backend to non-codex, these tools should warn or no-op (configurable). | P1 |
| **R-XBL-6** | Backfill audit: write a one-shot script `extension/src/bin/audit-worker-backends.ts` that scans `<session>/<ticket>/worker_session_*.log` for the codex-CLI banner (`Reading additional input from stdin...` + `chatgpt.com/codex/settings/usage`) and reports every worker that ran codex while session backend was something else. Output JSON. Run on session `2026-05-03-7d9ee8cc` to quantify the impact. | P1 |
| **R-XBL-7** | Regression test: integration test in `extension/tests/integration/spawn-morty-backend-resolution.test.js` that (a) writes `state.json` with `backend: 'claude'`, (b) sets `PICKLE_BACKEND=codex` in env (poisoned env), (c) invokes spawn-morty via the public entry point, (d) asserts spawn args include the claude binary path AND env-poison did not win. | P0 |
| **R-XBL-8** | Trap-door invariant added to `extension/CLAUDE.md`: `src/bin/spawn-morty.ts` (backend resolution) — INVARIANT: backend resolves through `StateManager.read(statePath).backend` only; env/settings/inherited-var never wins. Pre-spawn mismatch check fails loud. ENFORCE: `extension/tests/integration/spawn-morty-backend-resolution.test.js`. | P0 |

## Acceptance Criteria

- **AC-XBL-01** — On a session with `state.backend = "claude"` and a poisoned env `PICKLE_BACKEND=codex`, all worker spawns invoke claude. Verified by R-XBL-7 test.
- **AC-XBL-02** — `state.activity` contains a `worker_spawn_backend_resolved` event for every worker spawn (one per ticket lifecycle phase research/plan/implement/verify/review).
- **AC-XBL-03** — `audit-worker-backends.ts` reports zero cross-backend leaks on a fresh session running on either backend.
- **AC-XBL-04** — Running `audit-worker-backends.ts` on session `2026-05-03-7d9ee8cc` produces a baseline JSON listing the affected tickets (≥8 ticket dirs known so far) — used to validate that the fix lands.
- **AC-XBL-05** — Mismatch between resolved-backend and `state.backend` causes spawn to abort with non-zero exit and a clear stderr diagnostic; mux-runner records the failure in activity log.
- **AC-XBL-06** — Trap-door invariant in `extension/CLAUDE.md` enforced by the new test.

## Workaround until shipped

When flipping backend in `state.json`, ALSO:

```bash
# 1. Patch state.json
jq '.backend = "claude"' $SESSION/state.json > /tmp/s.json && mv /tmp/s.json $SESSION/state.json

# 2. Clear any inherited PICKLE_BACKEND env in the tmux pane that owns pipeline-runner
tmux send-keys -t pipeline-<hash>:0 "unset PICKLE_BACKEND" Enter

# 3. Verify next worker spawn doesn't print 'Reading additional input from stdin...':
tail -1 $SESSION/<next-ticket>/worker_session_*.log
# expect: claude prompt output, NOT codex CLI banner
```

This workaround does NOT cover H2 (sub-tool invocations) — those need the R-XBL-5 fix.

## Files in scope

- `extension/src/bin/spawn-morty.ts` — primary suspect (R-XBL-1, R-XBL-2, R-XBL-3, R-XBL-8)
- `extension/src/bin/spawn-refinement-team.ts` — same backend-resolution path
- `extension/src/bin/spawn-gate-remediator.ts` — gate remediator spawn
- `extension/src/bin/microverse-runner.ts` — worker spawn inside microverse loop
- `extension/src/services/backend-spawn.ts` — shared spawn helper (already has a trap-door for `StateManager.read()`; verify this PRD's leak isn't a violation of that invariant)
- `extension/src/bin/mux-runner.ts` — `evaluateCodexManagerRelaunch` (R-XBL-4)
- `extension/src/bin/audit-worker-backends.ts` — NEW (R-XBL-6)
- `extension/tests/integration/spawn-morty-backend-resolution.test.js` — NEW (R-XBL-7)
- `extension/CLAUDE.md` — trap-door entry (R-XBL-8, AC-XBL-06)

## Session Notes

### 2026-05-04 evening — write source CONFIRMED: codex-spark manager hallucination

Bundle session `2026-05-04-f416c6cc` run #2 (16:59→17:28 local) reproduced the leak under **fully-deployed R-XBL-2 (read-side SoT)**. Commits landed: R-XBL-2 (`a3641e3`), R-XBL-2b (`616f474`), R-XBL-3 (`95f2c37`). After ~22min the codex-spark MANAGER subprocess narrated:

> *"order, I'll try one last time under Hermes for that ticket, which previously fa…"*

…and immediately wrote `state.backend = 'hermes'` to disk. Read-side SoT then dutifully resolved hermes for the next worker spawn — *not a leak*, just the SoT correctly reading the corrupted state. The next 4 manager loops fired in 16 seconds (degenerate fast-loop), no progress, circuit-breaker tripped on tier=small budget=4.

**Root cause established:** the leak is **manager-tier hallucination** plus state-write authority. R-XBL-3 (now deployed at `95f2c37`) catches this pre-spawn — `assertBackendPreSpawn()` refuses to spawn when state.backend mid-run-mutation is detected without a corresponding `state.flags.backend_flip_reason` carve-out. Run #3 will validate.

**H1–H4 hypothesis status (from line 49):**
- H1 (stale env override): unconfirmed in run #2 — env was clean at launch (`PICKLE_BACKEND=''` set by reset script).
- H2 (sub-tool invocation): unconfirmed in this run — no `/codex:rescue` invocation.
- **H3 (state.backend re-write mid-run): CONFIRMED.** Manager prompt-tier did this directly.
- H4 (refinement leak): N/A — refinement was claude-locked successfully.

**Compounding finding (out of scope here, filed as slot 1p):** codex-spark workers commit code to git but skip writing `completion_commit: <sha>` into ticket frontmatter, so phantom-Done watcher reverted three truly-Done tickets (`8224fc7f / 160e8816 / 4d7c4cfa`) to Todo, fueling the no-progress loop alongside H3.

**Next step:** ship slot 1o (`state.worker_backend` field) so manager can be claude/sonnet (eliminates H3 entirely) while workers stay on codex-spark. R-XBL-3 stays as belt-and-suspenders for any residual flip path.

— Pickle Rick out. *belch*
