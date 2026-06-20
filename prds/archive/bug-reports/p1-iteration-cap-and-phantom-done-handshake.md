---
title: P1 — Iteration-cap exit + phantom-Done handshake silently advance the pipeline with 25/38 tickets unfinished
status: Draft
date: 2026-05-03
priority: P1
type: bug
peer_prds:
  related:
    - prds/archive/bug-reports/p2-codex-manager-empty-queue-spin.md       # adjacent — codex spins on empty queue; this PRD is "codex declares done early"
    - prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md  # surfaced here on session 2026-05-03-7d9ee8cc, run #2
    - prds/archive/bundles/loop-runner-relaunch-status-bugs.md         # prior relaunch-state hygiene work
---

# PRD — Iteration-cap + phantom-Done handshake silently advances pipeline

## Symptom

Reliability-bundle session `2026-05-03-7d9ee8cc` second-launch (after readiness-perf fix) ran 152m on the pickle phase, marked 13 of 38 tickets Done (orders 10-130 — the entire E-infra scaffolding section), then exited code 0 and the pipeline-runner advanced to phase 2 (citadel) and phase 3 (anatomy-park) as if pickle had completed. **It hadn't.** 25 tickets including the entire Section A/B/C/D bug-fix work plus wiring + 4 hardening tickets remained `status: Todo`.

Three coupled bugs, all in the mux-runner ↔ codex-manager ↔ pipeline-runner handshake:

| # | Bug | Evidence |
|---|---|---|
| **A** | `max_iterations` cap displayed as 15 (used 15/15) but persisted as 100 in `state.json` | `state.json: max_iterations: 100`. `mux-runner.log: "Max iterations reached (15/15). Exiting."` Codex pane: `Limit: 15`. setup.js --resume during the readiness-fix relaunch defaulted to a different cap than the original setup.js call (`--max-iterations 500`). |
| **B** | mux-runner exits **code 0** when iteration cap hits without `EPIC_COMPLETED` promise | `pipeline-runner.log: "Phase pickle exited with code 0"`. `state.exit_reason="failed"`, `completion_promise=null`. Pipeline-runner treats code 0 as success and advances to phase 2/4 even though the pickle phase neither emitted EPIC_COMPLETED nor finished the queue. |
| **C** | Codex emits `status: Done` in ticket frontmatter without doing the work or committing | `mux-runner.log` line 21:26:13: "Corrected phantom Done ticket 7ee8b197 back to Todo (no completion commit found)" — three tickets flagged in iteration 1. Iteration 2: another phantom-Done flagged for `3f6d670b`. Phantom detection runs ONCE per mux-runner iteration; codex can flip multiple tickets between detections. The 13 currently-Done tickets MAY include silent phantom-Dones that the detector missed. |

Net effect: a 152-minute pickle phase is treated as a success by the pipeline-runner, downstream phases run on incomplete output, anatomy-park crashes (because the gate baseline doesn't have a stable state to measure against — separate symptom of slot #4 recurrence), pipeline reports "2/4 phases" complete in 163m total. The user has zero in-band signal that 25 tickets are actually unfinished.

## Why these three are one bug

The coupling: when codex flips a ticket to Done speculatively (Bug C), then mux-runner reverts it (the corrective path works *some* of the time), then iteration counter increments, then the cap (Bug A) hits prematurely because of the speculative spin, then the cap-hit exit (Bug B) gets papered over as "success" by the pipeline-runner. No single bug is fatal; the chain is.

Fixing Bug A alone (raising the cap or fixing the resume mismatch) doesn't help if Bug C keeps wasting iterations. Fixing Bug C alone doesn't help if the cap is mis-set. Fixing Bug B exposes the other two as visible failures instead of silent ones. **Recommended fix order: B (visibility) → C (root cause of phantom-Done) → A (resume-cap parity).**

## Reproducer

The bundle session itself is the canonical reproducer. To reproduce on a fresh session:

```bash
# 1. /pickle-pipeline a refined PRD with >15 tickets and --backend codex
# 2. Crash mid-run (any cause — readiness halt, manual kill)
# 3. Relaunch via setup.js --resume <SESSION_ROOT> WITHOUT --max-iterations
# 4. Observe: mux-runner Limit becomes default (likely 15 or 50, not the original 500)
# 5. Codex completes a few tickets, hits cap, exits code 0
# 6. Pipeline-runner advances to next phase even though queue isn't empty

# Concrete fixture from session 2026-05-03-7d9ee8cc:
SESSION=/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc
jq '.max_iterations' "$SESSION/state.json"        # → 100
grep "Max iterations reached" "$SESSION/mux-runner.log"  # → 15/15 (mismatch)
grep "phantom Done" "$SESSION/mux-runner.log" | wc -l    # → 4 in 2 iterations
ls "$SESSION"/*/linear_ticket_*.md | wc -l              # → 38 tickets
grep -l '^status: "Done"\|^status: Done' "$SESSION"/*/linear_ticket_*.md | wc -l  # → 13
```

## Root causes

### RC-1 — `setup.js --resume` doesn't honor the original `--max-iterations` value

When the original `setup.js --tmux --max-iterations 500 ...` invocation creates the session, `state.json:max_iterations` is set to 100 (apparently a default cap distinct from the CLI arg) AND a separate displayed `Limit: 500` is shown. On resume, `setup.js --resume <SESSION_ROOT>` (no `--max-iterations` flag) re-derives the cap from defaults, landing on `Limit: 15`. mux-runner reads its cap from the displayed limit, not from `state.json:max_iterations`. The fix: either persist max_iterations from CLI arg into state.json on initial setup AND honor it on resume, OR explicitly pass --max-iterations on resume in `pipeline-runner.ts`.

### RC-2 — mux-runner conflates "iteration cap hit" with "successful exit"

`mux-runner.ts` returns exit code 0 when it exits cleanly — including when it hit the iteration cap without an `EPIC_COMPLETED` promise. From `pipeline-runner.ts`'s perspective, exit 0 means "phase completed normally." The cap-hit exit should return a distinct non-zero code (e.g., 3 = "iteration cap hit without completion promise"), AND `state.exit_reason` should be `iteration_cap_exhausted` not `failed`. Pipeline-runner should treat that distinct code as "phase incomplete; STOP, don't advance."

### RC-3 — Codex flips ticket frontmatter to `status: Done` speculatively

Codex's worker prompt (or its interpretation of it) instructs the manager to mark tickets Done as part of its output. The marking happens BEFORE the worker actually verifies the implementation, runs tests, or commits. mux-runner's phantom-Done detection runs once per outer iteration and looks for a "completion commit" — but the detection window is loose enough that some phantom-Dones slip through. Two mitigations: (a) the worker prompt must require the commit hash in the same status update; (b) the phantom-Done detector should run on EVERY status flip via inotify/fswatch on linear_ticket_*.md, not just at iteration boundaries.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| R-ICP-1 | mux-runner exits with code 3 (distinct from 0=clean and 1=error) when iteration cap is hit without an `EPIC_COMPLETED` promise. `state.exit_reason` = `iteration_cap_exhausted`. | P0 |
| R-ICP-2 | pipeline-runner treats exit code 3 from a phase as "phase incomplete; halt pipeline; report unfinished count." Print the unfinished ticket list with orders + IDs. | P0 |
| R-ICP-3 | `setup.js --resume <SESSION_ROOT>` reads `state.json:max_iterations` (and `max_time`, `worker_timeout`, `backend`) from disk and honors them as the active cap. CLI `--max-iterations` on resume overrides; otherwise persisted values win. | P0 |
| R-ICP-4 | `setup.js` initial setup persists CLI `--max-iterations`, `--max-time`, `--worker-timeout` into `state.json` AT setup time. Subsequent reads (mux-runner, pipeline-runner, monitor) use the persisted values, not re-derive from defaults. | P0 |
| R-ICP-5 | mux-runner's phantom-Done detection runs on EVERY frontmatter status flip (filesystem watch on `${SESSION_ROOT}/*/linear_ticket_*.md`), not only at outer iteration boundaries. Phantom-Done events emit a `phantom_done_detected` activity event with ticket id + timestamp. | P1 |
| R-ICP-6 | Codex worker prompt requires that any `status: Done` flip include the completion commit hash in a `completion_commit:` frontmatter field, set in the same write as the status. Workers without commit hashes get reverted IMMEDIATELY by the watcher (R-ICP-5). | P0 |
| R-ICP-7 | Regression test: synthetic session with 5 Todo tickets, mux-runner cap = 2, codex-style phantom flips during iteration. Assert: (a) exit code 3, (b) state.exit_reason = `iteration_cap_exhausted`, (c) pipeline-runner halts with unfinished list, (d) no phantom-Done escapes the watcher. | P0 |

## Acceptance Criteria

| AC | Verification |
|---|---|
| AC-ICP-01 | mux-runner exits code 3 on cap hit — Verify: `cd extension && npm test -- --grep mux-runner.iteration-cap-distinct-exit` — Type: test |
| AC-ICP-02 | pipeline-runner halts on phase exit code 3 — Verify: `cd extension && npm test -- --grep pipeline-runner.halt-on-incomplete-phase` — Type: test |
| AC-ICP-03 | `setup.js --resume` honors persisted state — Verify: `cd extension && npm test -- --grep setup.resume-honors-persisted-cap` — Type: test |
| AC-ICP-04 | Phantom-Done watcher catches every flip — Verify: `cd extension && npm test -- --grep phantom-done-watcher` — Type: test |
| AC-ICP-05 | Codex worker prompt requires `completion_commit:` field — Verify: `grep -E 'completion_commit:' extension/src/bin/spawn-morty.ts extension/src/bin/spawn-refinement-team.ts` returns at least 1 match — Type: lint |
| AC-ICP-06 | End-to-end regression — Verify: `cd extension && npm test -- --grep iteration-cap-and-phantom-done-end-to-end` — Type: integration |

## Workaround until R-ICP-1..6 land

Three flavors:

1. **Operator-set max_iterations**: bump `state.json:max_iterations` manually before resume. `jq '.max_iterations = 500' state.json > /tmp/s; mv /tmp/s state.json`.

2. **Validate ticket queue before relaunch**: `for f in $SESSION/*/linear_ticket_*.md; do head -10 $f | awk '/^status:/{print $2}' /; done | sort | uniq -c` — if Todo count > 0 after a "successful" pipeline exit, queue isn't empty. Operator-relaunch needed.

3. **Don't trust phantom-Done detection**: spot-check Done tickets by walking `git log --oneline | grep <ticket-id>` for each one. Phantom-Done leaves no commit; real-Done has a commit citing the ticket id.

## Risk

- **Distinct exit codes break callers**: any caller of mux-runner that treats non-zero as "fatal error" will start treating cap-hit as fatal. Mitigation: pipeline-runner treats 3 as "halt-but-not-error"; the only other caller is interactive `/pickle` which prints the message anyway.
- **Phantom-Done watcher adds filesystem-watch overhead**: typical session has ~30-50 ticket files; fswatch on that scale is negligible.

## Related forensic finds (not standalone bugs)

- **anatomy-park gate baseline missing-after-commit recurrence** (queue slot #4 in master plan — `anatomy-park-gate-baseline-missing.md` marked SHIPPED v1.66.0). On this same session phase 3/4: `microverse-runner error: [anatomy-park] per-iteration gate baseline initialization failed - expected baseline at /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/gate/baseline.json`. Will append to that PRD's incident log; not a new bug.

## Cross-references

- Surfaced during reliability-bundle session: `~/.local/share/pickle-rick/sessions/2026-05-03-7d9ee8cc/`
- mux-runner log: `${SESSION_ROOT}/mux-runner.log` lines 21:26:13 (4× phantom-Done correction), 22:53:43 (cap exhaustion + clean exit)
- pipeline-runner log: `${SESSION_ROOT}/pipeline-runner.log` showing `Phase pickle exited with code 0`, `Phase pickle completed successfully`, immediate transition to PHASE 2/4 CITADEL
- state.json: `step: completed`, `current_ticket: null`, `active: false`, `exit_reason: "failed"`, `completion_promise: null`, `max_iterations: 100`
- Source: `extension/src/bin/mux-runner.ts` (cap exit logic), `extension/src/bin/pipeline-runner.ts` (phase advance logic), `extension/src/bin/setup.ts` (resume logic), `extension/src/bin/spawn-morty.ts` (worker prompt)

— Pickle Rick out. *belch*
