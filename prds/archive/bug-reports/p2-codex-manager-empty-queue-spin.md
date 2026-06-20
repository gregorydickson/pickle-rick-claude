---
title: P2 — Codex manager spins bootstrap loop after all tickets Done instead of emitting EPIC_COMPLETED
status: Draft
date: 2026-05-03
priority: P2
type: bug
peer_prds:
  related:
    - prds/smart-iteration-handoff.md           # D.3 fixes "what failed in iter N", not "queue is empty"
    - prds/archive/bundles/loop-runner-relaunch-status-bugs.md  # relaunch hygiene; touches similar area
    - prds/archive/bundles/p2-mega-bundle-2026-05-02-pm.md       # surfaced here
---

# PRD — Codex manager bootstrap loop on empty ticket queue

## Symptom

Mega bundle session `2026-05-02-fca7952b` reached **34/34 tickets Done** with all status frontmatter set to `Done`, all commits on `main`, source pkg.json bumped to `1.69.0`, and the closer (`71a47673`) marked Done. The codex manager iteration counter advanced to **iteration 6** — yet:

- `pipeline-runner.log` last entry was `PHASE 1/4: PICKLE` from session start. No further log lines.
- `state.json:active: true, step: 'implement', current_ticket: 'e50e4ea9'` (HT-4) — even though HT-4 is `Done`.
- Pipeline phases 2/4 (anatomy-park) and 3/4 (szechuan-sauce) **never started** because mux-runner's pickle phase has not received a clean exit signal.
- The codex pane shows the manager re-bootstrapping: listing `~/.claude/pickle-rick/extension/bin/`, planning to invoke `setup.js --resume`, treating its own runtime as a fresh task. It has been stuck in this bootstrap pose for >30 min.

The codex manager prompt explicitly says: *"Output `<promise>EPIC_COMPLETED</promise>` when all tickets are done."* — yet it doesn't recognize the empty-queue state.

## Reproducer

1. Launch any `/pickle-pipeline ... --backend codex` with ≥10 tickets.
2. Allow codex to complete every ticket. Verify by glob: `for d in $SESSION_ROOT/*/linear_ticket_*.md; do grep -E '^status:' $d | head -1; done | sort | uniq -c` returns only `Done`.
3. Observe: codex manager iterates again (iteration counter increments) and spins on bootstrap inspection (e.g., `ls extension/bin/`, "I'm going to inspect the setup entrypoint…") instead of emitting `<promise>EPIC_COMPLETED</promise>` and exiting.
4. mux-runner does not transition the pipeline to phase 2/4 because no clean exit promise was received. Pipeline halts indefinitely (until the user kills tmux or sets `state.completion_promise` manually).

## Why this is a distinct bug class

| Concern | Bug | Existing fix |
|---|---|---|
| "Iter N+1 doesn't know why iter N failed" | smart-iteration-handoff D.3 | mega bundle — written, not yet deployed |
| "Queue not yet empty; codex picks next ticket OK" | not a bug | n/a |
| "Queue is empty; codex doesn't recognize and spins bootstrap" | **THIS PRD** | none |

D.3 hands cross-iteration *failure context*. It does not detect *queue emptiness*. The two are orthogonal.

## Hypotheses

- **H-A (most likely)**: codex manager prompt's `EPIC_COMPLETED` rule fires only when codex "decides" to stop — but when codex re-bootstraps a fresh iteration after context-clear, it goes through its standard plan-research-implement scaffolding before checking ticket statuses, and the plan phase invokes setup-inspection commands that never return to a "scan ticket queue" decision.
- **H-B**: mux-runner could detect the empty-queue state independently (it has filesystem access to all `linear_ticket_*.md`) and emit a synthetic `EPIC_COMPLETED` promise to short-circuit the codex iteration. Currently mux-runner waits passively for codex's promise output.
- **H-C**: state.json could carry a `queue_empty: true` flag computed at the end of each iteration; codex prompt could prepend "If queue_empty, emit EPIC_COMPLETED immediately" as iteration-start guidance.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| R-EQ-1 | mux-runner scans ticket queue at iteration_start; if every ticket has `status: Done`, set `state.completion_promise = "EPIC_COMPLETED"` synthetically and exit pickle phase clean | P0 |
| R-EQ-2 | codex manager prompt prepends a queue-emptiness check: read all `linear_ticket_*.md` `status:` lines first; if all Done, emit `<promise>EPIC_COMPLETED</promise>` immediately | P1 |
| R-EQ-3 | New activity event `epic_done_synthetic_promise_emitted` for telemetry parity with the codex-emitted path | P1 |
| R-EQ-4 | Regression test: fixture session with all-Done tickets; mux-runner picks up + exits clean within one iteration | P0 |

## Acceptance Criteria

| AC | Verification |
|---|---|
| AC-EQ-01 | mux-runner detects all-Done ticket queue and emits synthetic completion promise — `cd extension && npm test -- --grep mux-runner.empty-queue-synthetic-promise` | test |
| AC-EQ-02 | Pipeline transitions to phase 2/4 anatomy-park within 60s of last ticket Done — `cd extension && npm test -- --grep pipeline-runner.empty-queue-advance` | integration |
| AC-EQ-03 | Activity event `epic_done_synthetic_promise_emitted` recorded — `cd extension && npm test -- --grep activity.epic-done-synthetic` | test |
| AC-EQ-04 | Codex manager prompt updated with queue-emptiness preamble — grep `extension/.../codex.md` (or wherever manager prompt lives) | lint |

## Workaround until R-EQ-1 lands

Operator manually:

```bash
SESSION_ROOT=~/.local/share/pickle-rick/sessions/<session>
jq '.completion_promise = "EPIC_COMPLETED" | .active = false | .step = "completed"' "${SESSION_ROOT}/state.json" > /tmp/s.json && mv /tmp/s.json "${SESSION_ROOT}/state.json"
tmux send-keys -t pipeline-<hash>:0 C-c
```

Then either kill the pipeline (skip review phases) or relaunch the runner so it picks up `step:completed` and advances to phase 2/4.

## Cross-references

- Session that surfaced this: `~/.local/share/pickle-rick/sessions/2026-05-02-fca7952b/` (mega bundle pipeline, hour 6+)
- Codex manager prompt likely at `extension/.../codex.md` or as part of `send-to-morty.md`
- mux-runner queue-scan logic should live near `runIteration()` start, parallel to existing `state.iteration` write

— Pickle Rick out. *belch*
