---
title: P1 — Two new bugs surfaced 2026-05-04 AM during reliability-bundle relaunch
status: Draft
date: 2026-05-04
priority: P1
type: bug
peer_prds:
  related:
    - prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md   # parent — R-ICP-1/-2 are now firing correctly; this PRD captures the SECOND-ORDER issues that surface ONCE those fixes work
    - prds/p1-reliability-and-test-coverage-bundle-2026-05-03.md   # session that surfaced both bugs
    - prds/archive/bug-reports/p1-deployed-pkgjson-version-only-revert.md   # adjacent — Section A of bundle; same deploy-revert family
---

# PRD — Two bugs surfaced 2026-05-04 AM during pipeline relaunches

## Symptoms

Reliability-bundle session `2026-05-03-7d9ee8cc` ran on claude backend (after codex usage limit hit) and made real progress: 22 of 38 tickets Done, R-ICP-1/-2 fired correctly to halt the pipeline at the per-ticket iteration cap with the proper unfinished list. On relaunch attempt for the next batch, two new bugs surfaced:

| # | Bug | Symptom |
|---|---|---|
| **A** | Deployed `extension/node_modules/typescript` is missing | `pipeline-runner.js` crash: `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'typescript' imported from .../services/citadel/frontend-prop-drift-audit.js`. install.sh symlinks `node_modules/.bin/tsc` but NOT the typescript PACKAGE. Deployed pipeline-runner now imports `collectTickets` (R-ICP-2) which transitively pulls in citadel/frontend-prop-drift-audit, which needs `typescript`. Manual workaround: `ln -sf /repo/extension/node_modules/typescript $HOME/.claude/pickle-rick/extension/node_modules/typescript` |
| **B** | Pipeline halts at per-ticket iteration cap (15) with no auto-resume | mux-runner exits code 3 + pipeline-runner halts (R-ICP-1/-2 working correctly). For a 38-ticket bundle, this means an operator must manually re-run `bash launch.sh` once per cap-hit. Each cap-hit batch processes ~5-15 tickets. A 38-ticket bundle ends up needing 3-7 manual relaunches. |

## Why this is a distinct bug class (vs the parent PRD)

`prds/archive/bug-reports/p1-iteration-cap-and-phantom-done-handshake.md` shipped R-ICP-1..6 with the explicit goal of making cap-hit-without-completion VISIBLE (exit code 3 + halt + unfinished list) instead of SILENT (exit code 0 + pipeline-runner advance). That fix is working as designed. **These are the second-order issues that surface once the underlying chain stops papering over them.**

- Bug A is upstream of the bundle entirely — it's a pre-existing deploy gap exposed by the R-ICP-2 fix's new import path. It would have surfaced eventually regardless.
- Bug B is downstream — the operator-friction question of "how often do we have to manually relaunch?" The fix isn't to skip the cap; it's to add an auto-resume daemon or to widen per-ticket caps for tier:medium and tier:large.

## Bug A: install.sh deploy gap on typescript package

### Root cause

`install.sh` rsyncs `extension/` to `~/.claude/pickle-rick/extension/` and creates a `node_modules/.bin/tsc` symlink:

```bash
mkdir -p ../node_modules/.bin && ln -sf $(pwd)/node_modules/.bin/tsc ../node_modules/.bin/tsc
```

But this only symlinks the `tsc` binary. The typescript PACKAGE directory (`node_modules/typescript/`) is not symlinked. Most deployed code paths never imported typescript at runtime, so this gap was invisible. Then R-ICP-2's `collectTickets` import chain hit `services/citadel/frontend-prop-drift-audit.js` which has `import ts from 'typescript'` at module load — boom.

### Reproducer

```bash
bash install.sh
ls $HOME/.claude/pickle-rick/extension/node_modules/typescript
# → ls: No such file or directory

# In a session where pipeline-runner.js is invoked:
node $HOME/.claude/pickle-rick/extension/bin/pipeline-runner.js <SESSION_ROOT>
# → ERR_MODULE_NOT_FOUND: Cannot find package 'typescript'
```

### Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| R-DTS-1 | `install.sh` creates a symlink: `$HOME/.claude/pickle-rick/extension/node_modules/typescript -> /repo/extension/node_modules/typescript`. Idempotent (replace existing symlink). Skipped silently if source typescript dir doesn't exist. | P0 |
| R-DTS-2 | Same treatment for any other run-time-imported npm package the deployed copy needs. Audit: `grep -rln "from 'typescript'\|from '@anthropic-ai\|from '..." extension/services/ extension/bin/ | xargs ...` to find runtime imports vs devDeps. | P1 |
| R-DTS-3 | Regression test: after `install.sh`, `node $HOME/.claude/pickle-rick/extension/bin/pipeline-runner.js --help` (or equivalent dry-run) must exit 0 — confirms the runtime can load all transitively imported modules. | P0 |

### Workaround until R-DTS-1 lands

```bash
ln -sf /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension/node_modules/typescript $HOME/.claude/pickle-rick/extension/node_modules/typescript
```

(Used to unblock session `2026-05-03-7d9ee8cc` 2026-05-04 09:08Z.)

## Bug B: per-ticket cap halt → operator must manually relaunch

### Root cause

mux-runner reads `current_ticket_max_iterations` (set per ticket from the complexity-tier budget). When the cap is hit without `EPIC_COMPLETED`, mux-runner exits code 3, pipeline-runner halts. **By design** — the R-ICP-1/-2 fix's whole point was to make this visible.

Issue: there's no auto-resume mechanism. After a cap-hit halt, the operator runs `bash launch.sh` again. Each batch processes 5-15 tickets. A 38-ticket bundle takes 3-7 manual relaunches. For overnight/headless runs this is poor ergonomics.

Three reasonable fixes:

1. **Widen the per-tier caps**: the current `medium` tier budget is 5 (no-progress) and `current_ticket_max_iterations` is 15. For tickets that genuinely need more iterations, this is too tight. Bump `medium` to 30 iterations, `large` to 60. Keep `trivial`/`small` at 5/10 (they should converge fast or there's a real problem).

2. **Auto-resume daemon**: a tmux pane (or cron) that watches for `state.exit_reason == "pipeline_phase_incomplete"` and `current_ticket != null`, then re-runs `launch.sh`. Caps the auto-resume count at, say, 10 per session to avoid runaway loops.

3. **Aggregate progress across cap-hits**: instead of a per-ticket cap, use a per-phase cap (e.g., max 1000 iterations across the whole pickle phase). Cap-hit at the phase level is rare; cap-hit at the ticket level is common.

Recommended: combination of (1) and (2). (1) reduces cap-hit frequency. (2) handles the residual case automatically.

### Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| R-CNAR-1 | Per-tier cap settings updated: `trivial`=5, `small`=10, `medium`=30, `large`=60, `xlarge`=120 in `pickle_settings.json` defaults. Existing settings precedence preserved (operator override wins). | P0 |
| R-CNAR-2 | New env var `PICKLE_AUTO_RESUME_ON_CAP_HIT=1` enables auto-resume. When set, after pipeline-runner halts with exit_reason=`pipeline_phase_incomplete`, a small wrapper relaunches `launch.sh` up to `PICKLE_AUTO_RESUME_MAX_RETRIES` times (default 10). Each retry resets the per-ticket counters but preserves per-phase progress. | P1 |
| R-CNAR-3 | Activity event `pipeline_auto_resumed` records every retry with timestamp + previous ticket + new current_ticket. Operator can audit how many auto-resumes ran. | P1 |
| R-CNAR-4 | Auto-resume STOPS unconditionally if (a) no progress between two consecutive auto-resumes (same ticket, same Done count), or (b) `PICKLE_AUTO_RESUME_MAX_RETRIES` exhausted, or (c) pipeline-runner exits with a non-`pipeline_phase_incomplete` reason. | P0 |
| R-CNAR-5 | Regression test: synthetic 5-ticket session with 15-cap simulating cap-hit on each ticket; auto-resume daemon completes all 5 tickets across N retries. | P1 |

### Workaround until R-CNAR-1..5 land

Operator manually re-runs `bash $SESSION_ROOT/launch.sh $SESSION_ROOT` after each halt. Or wraps it:

```bash
while jq -e '.exit_reason == "pipeline_phase_incomplete"' "$SESSION_ROOT/state.json" >/dev/null; do
  bash "$SESSION_ROOT/launch.sh" "$SESSION_ROOT" || break
done
```

(Naive — no progress check, no retry cap. Use only on attended sessions.)

## Cross-references

- Surfaced during reliability-bundle session `2026-05-03-7d9ee8cc/`
- Bug A traceback in tmux pane: `pipeline-7d9ee8cc:0` lines around 09:08:00Z
- Bug B trigger: `pipeline-runner.log` line `[2026-05-04T03:54:52.530Z] Pipeline finished: 0/4 phases, 124m 49s` followed by full unfinished-ticket list (R-ICP-2 working correctly)
- install.sh location: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/install.sh`
- The typescript runtime import: `extension/services/citadel/frontend-prop-drift-audit.js` (TS source — find the `import ts from 'typescript'` line near top)

## Session Notes

### 2026-05-04 evening — Bug C surfaced: install.sh leaves `extension/types/index.js` stale

While running the bundle's keystone direct-execute (`9437b0c` R-CNAR-1 + `817e73c` R-XBL-2 + Worker's overlay commits), the **first** `bash install.sh` invocation completed cleanly with no errors but the deployed `~/.claude/pickle-rick/extension/types/index.js` md5 still pointed at the May 3 build — missing 8 events including `worker_spawn_backend_resolved`, `paused_session_orphan_demoted`, `pkgjson_only_revert_detected`, etc. Source `extension/types/index.js` had the new entries, but the rsync from `extension/` → `~/.claude/pickle-rick/extension/` either skipped or pre-empted by `--delete-excluded`.

**User-visible symptom:** every spawn-morty invocation in run #2 emitted `WARN: ignoring unknown activity event worker_spawn_backend_resolved` to stderr × N (state-manager validator running deployed code rejects events not in deployed VALID_ACTIVITY_EVENTS). Activity-log fidelity was lost for the entire run.

**Resolution:** re-running `bash install.sh` a second time DID produce md5 parity. So the rsync logic is correct — the problem is upstream timing. Most likely: `npx tsc` did not actually re-emit `extension/types/index.js` between the source TS edit and install.sh execution (tsc incremental cache + same-second mtimes is a known footgun). install.sh has a **schemaVersion parity gate** (`install.sh:250-258`) but no broader **content parity probe**.

**Bug C — proposal (split out as slot 1q in MASTER_PLAN if not bundled here):**

| Req | What | Where |
|---|---|---|
| **R-DTS-4** | install.sh forces clean tsc rebuild | Add `rm -f extension/types/index.js extension/services/state-manager.js extension/bin/spawn-morty.js && (cd extension && npx tsc)` BEFORE the rsync block at install.sh:282. Cost: ~3 sec on incremental rebuild, gives correctness. |
| **R-DTS-5** | install.sh post-rsync md5 parity probe | After rsync, run `md5 source deployed | uniq -c` for the 5 most-trafficked compiled files (`types/index.js`, `services/state-manager.js`, `services/pickle-utils.js`, `bin/spawn-morty.js`, `bin/mux-runner.js`). Fail-loud if any mismatch — exits 1 with "stale deploy detected." |
| **R-DTS-6** | install.sh emits a deploy report | One-line summary of bytes/files synced, parity-checked count, and final schemaVersion. So the operator can see at a glance that the deploy actually happened, not just that the script exited 0. |

**Cross-reference:** Run #2 was on session `2026-05-04-f416c6cc`. tmux pane output around 17:00 shows the WARN spam. Re-deploy fix verified at end-of-turn — `md5 extension/types/index.js ~/.claude/pickle-rick/extension/types/index.js` produces identical hashes after the second install.sh.

---

## 2026-05-05 mid-day forensic addendum — R-CNAR-1 part 2 cap-split fix has a stale-cache edge case (R-CNAR-7 NEW)

**Live forensic from run #6 launch attempt 1** (bundle session `2026-05-04-f416c6cc`, 2026-05-05 ~14:08 local). With cap-split fix `6be334b1` freshly deployed via install.sh, mux-runner exited immediately on launch with:

```
mux-runner exiting with code 3: per-ticket budget (18/10, tier=unknown) exhausted on ticket unknown without EPIC_COMPLETED promise
Max iterations reached (18/10). Exiting.
```

The `tier=unknown` and `ticket unknown` substrings in the runner's own diagnostic indicate the cap-check fired against **stale cache fields with no live current_ticket** — the runner KNOWS it's in a degenerate state and trips the cap anyway.

### Root cause

The cap-split fix (R-CNAR-1 part 2) introduces independent per-ticket and global cap-check branches:

- per-ticket: `budgetIter >= state.current_ticket_max_iterations`
  where `budgetIter = state.iteration - state.current_ticket_budget_start_iteration`
- global: `state.iteration >= state.max_iterations`

The per-ticket branch reads three cache fields populated by `applyTicketTierBudget()` when the current ticket changes:
- `state.current_ticket_max_iterations`
- `state.current_ticket_budget_start_iteration`
- `state.current_ticket_tier`

**The bug**: when the runner resumes a session where `state.current_ticket === null` (because a prior run completed/aborted/was reset), these cache fields can be **leftover from a prior ticket** OR partially set. Specifically observed in the recovery sequence on 2026-05-05:

```
state.iteration                              = 18  (carryover from prior run)
state.current_ticket                         = null  (cleared)
state.current_ticket_max_iterations          = 10   (stale leftover)
state.current_ticket_budget_start_iteration  = null  (cleared)
state.current_ticket_tier                    = null  (cleared)
```

The cap-check evaluated:
- `budgetIter = 18 - null` → JavaScript `Number(null)` is `0` → `budgetIter = 18`
- `18 >= 10` → cap exhausted → exit with `iteration_cap_exhausted`

### Why R-CNAR-1 part 2's regression test didn't catch it

`extension/tests/mux-runner-cap-split.test.js` verifies the cap-split fix in scenarios where the cache is freshly populated. It does NOT verify the **resume-with-stale-cache** scenario where `state.current_ticket = null` AND `state.current_ticket_max_iterations` is stale AND `state.current_ticket_budget_start_iteration` is null. That gap allowed this regression-class to ship.

### R-CNAR-7 (NEW) — Cap-check guard against stale per-ticket cache

**Requirement**: the per-ticket cap-check at `runMuxLoop` MUST NOT fire when ANY of these conditions hold:

1. `state.current_ticket === null` OR `state.current_ticket === undefined`
2. `state.current_ticket_max_iterations === null` OR not a positive integer
3. `state.current_ticket_budget_start_iteration === null` OR not a non-negative integer
4. `state.current_ticket_tier === null` OR not in the allowed tier set

If any condition holds → SKIP the per-ticket cap-check entirely; let the manager turn proceed; on next ticket selection `applyTicketTierBudget()` repopulates the cache and the cap-check resumes normal operation.

**Diagnostic**: when the cap-check is SKIPPED for stale-cache reason, log a one-line warning `per-ticket cap-check skipped: stale cache (current_ticket=<v>, max_iter=<v>, budget_start=<v>, tier=<v>)` and emit `cap_check_skipped_stale_cache` activity event.

**Self-healing**: at iteration_start, if `state.current_ticket === null` AND any per-ticket cache field is non-null, log `clearing stale per-ticket cache fields (current_ticket=null)` and clear all four cache fields atomically via `StateManager.update()`. Prevents the next iteration from also tripping the check.

### Acceptance criteria

- **AC-CNAR-7-01** — Test that simulates `state.current_ticket=null` + stale `current_ticket_max_iterations=10` + `state.iteration=18` confirms cap-check is SKIPPED (not tripped) and the runner proceeds to manager turn.
- **AC-CNAR-7-02** — `cap_check_skipped_stale_cache` event is registered in `VALID_ACTIVITY_EVENTS` and emitted with the four cache-field values in payload.
- **AC-CNAR-7-03** — Self-healing iteration_start clears stale cache fields when `current_ticket=null`; verified by test that asserts post-iteration_start state has all four cache fields = null.
- **AC-CNAR-7-04** — `mux-runner-cap-split.test.js` extended with the resume-with-stale-cache fixture (the exact 2026-05-05 reproducer state).
- **AC-CNAR-7-05** — Trap-door entry for `mux-runner.ts (R-CNAR-1 part 2 cap split)` updated to add the stale-cache guard invariant.

### Operator workaround applied 2026-05-05

After the cap-trip, operator manually cleared all four cache fields + reset `state.iteration=0`. Run #6 then launched cleanly. Documented as evidence the gap is exploitable AND the workaround is non-obvious (requires reading mux-runner source to understand which fields to clear).

**Mitigation order**: R-CNAR-7 self-healing iteration_start cleanup is the keystone. Without it, every fresh resume of a stalled session is a candidate for this trap.

— Pickle Rick out. *belch*
