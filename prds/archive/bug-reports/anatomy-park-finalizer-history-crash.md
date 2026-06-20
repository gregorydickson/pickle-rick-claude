# PRD: Anatomy-Park Finalizer Crashes Reading `convergence.history` on Successful Worker-Managed Convergence

**Status**: Bug PRD (2026-04-30) — production-blocking for any `/pickle-pipeline` run that includes anatomy-park or szechuan-sauce; surfaced live during `pipeline-a5e02f01`
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Origin**: live during `/pickle-pipeline` run `pipeline-a5e02f01` over `prds/2026-04-30-income-agent-ux-fixes-prd.md` in `loanlight-api-income-agent-ux`. Phase 1 (pickle) shipped 13/13 tickets cleanly. Phase 2 (anatomy-park) ran 2 iterations, recorded `consecutive_clean=2` and converged successfully (`anatomy-park.json: "converged": true`). Then the finalizer crashed with `[FATAL] Cannot read properties of undefined (reading 'history')`. Process exited 1. `pipeline-runner` saw the non-zero exit and aborted phase 3 (szechuan-sauce).

---

## Problem

`microverse-runner.ts:writeFinalReport()` (deployed `extension/bin/microverse-runner.js:634`) unconditionally dereferences `mvState.convergence.history`. The microverse runtime supports two convergence modes — `metric` (the original gradient-descent style; populates `convergence.history` with per-iteration `{iteration, score, action, description}` entries) and `worker` (anatomy-park, szechuan-sauce; the worker decides when to converge and writes `anatomy-park.json` / `szechuan-sauce.json` directly). Worker-managed convergence does not populate `mvState.convergence.history`. When the finalizer runs after a successful worker-managed convergence, it crashes.

The crash path:

1. Convergence detected — log line `Converged (worker-managed: ... consecutive_clean=2 ...)` written.
2. `finalizeMicroverseRun()` called with `outcome.exitReason = 'converged'` (microverse-runner.js:1244–1271).
3. Lines 1245–1247 correctly stamp `microverse.json` with `status: 'converged'`, `exit_reason: 'converged'`. No crash here.
4. Line 1249 sets `state.active = false`. Clean.
5. Line 1255 calls `writeFinalReport(sessionDir, outcome.state, 'converged', iterations, elapsed)`.
6. **Line 635 (inside writeFinalReport): `const history = mvState.convergence.history;` — `mvState.convergence` is `undefined` because anatomy-park's outer state never builds a metric-mode `convergence` object.** Throws `TypeError: Cannot read properties of undefined (reading 'history')`.
7. The throw escapes `main()` and is caught by the top-level handler at line 1300.
8. `markMicroverseFatalError()` (line 1282) **overwrites the just-written successful `microverse.json`** with `status: 'stopped'`, `exit_reason: 'error'` (line 1290–1291). The actual successful convergence record is destroyed.
9. `process.exit(1)`.
10. `pipeline-runner` reads the exit code, prints `Phase anatomy-park failed (exit 1) — stopping pipeline`, and aborts phase 3.

The user-visible failure is "anatomy-park failed; pipeline stopped". The actual reality is "anatomy-park succeeded with zero confident findings, then the report writer crashed and erased the success marker".

---

## Symptoms

1. **Pipeline aborts after a successful anatomy-park (or szechuan-sauce) phase.** Operator sees `Phase anatomy-park failed (exit 1) — stopping pipeline` despite `anatomy-park.json` showing `"converged": true`.
2. **`microverse.json` says `"exit_reason": "error"` even though `anatomy-park.json` says `"converged": true`.** Two source-of-truth files disagree because `markMicroverseFatalError()` overwrites the success marker on the way down.
3. **Stdout in tmux pane shows `[FATAL] Cannot read properties of undefined (reading 'history')`** immediately after the worker convergence log line. No structured logging — bare TypeError stack message.
4. **Subsequent phases of the pipeline never run.** Operator must manually trim `pipeline.json` to `phases: ["szechuan-sauce"]` (or whichever) and re-launch `pipeline-runner` against the same session to continue.
5. **The `memory/microverse_report_<date>.md` final report file is never written**, even though it should be — the writer crashes before `fs.writeFileSync` (line 662).

---

## Reproduction

```bash
# Any /pickle-pipeline run with worker-managed convergence:
/pickle-pipeline path/to/prd.md   # default phases include anatomy-park

# Wait for pickle phase to complete.
# Wait for anatomy-park to do its iterations and signal worker-managed convergence.
# Within ~1 second of the "Converged (worker-managed: ...)" log line,
# observe `[FATAL] Cannot read properties of undefined (reading 'history')`.
```

Direct unit-test repro: construct an `mvState` for worker-managed convergence (no `convergence.history` field), pass to `writeFinalReport`, observe TypeError.

```ts
// Failing case (currently throws):
writeFinalReport(sessionDir, {
  status: 'converged',
  exit_reason: 'converged',
  // no convergence object — typical of worker-managed runs
} as MicroverseSessionState, 'converged', 2, 1000);
```

---

## Root Cause

`writeFinalReport()` was written for metric-mode convergence (the original microverse use case) where `mvState.convergence.history` is always populated with at least the baseline entry. When `worker` convergence mode was added (per `init-microverse.js --convergence-mode worker --convergence-file anatomy-park.json` — see `pipeline-runner.js:519`), the call sites that drive worker mode were updated to handle the new `consecutive_clean` / `stall_counts` shape, but the **finalizer's report writer was not updated to defend against a missing `convergence` object**.

Three other call sites in the same file dereference `mvState.convergence.history` — they should each be audited for the same hazard:

- `microverse-runner.js:571` — `buildMicroverseHandoff` builds a per-iteration handoff context. Reads `mvState.convergence.history`. Likely throws every iteration after the first when running anatomy-park, OR is currently guarded somewhere upstream by a code path that doesn't reach worker mode (need to verify).
- `microverse-runner.js:598` — `getBestScore` computes the best metric score. Returns `bestFn(...accepted, mvState.baseline_score)`. For worker-managed convergence with no metric, this returns NaN or undefined and is rendered into the panel at line 1268 (`BestScore: panelBestScore`). Currently silent because the panel just stringifies whatever it gets, but it's lying to the operator.
- `microverse-runner.js:874` — `[...state.convergence.history].reverse().find(...)` for last-accepted lookup. Spread on undefined throws. Need to confirm this code path is unreachable in worker mode (likely guarded by `state.key_metric.type === 'llm'` or similar; verify).

The deeper issue is **`microverse-runner.js` mixes two shapes (`metric` mode and `worker` mode) into one MicroverseSessionState type without a discriminated union**. The fix has to either (a) make the worker-mode code path always populate a stub `convergence: { history: [], stall_counter: 0, ... }` so existing readers don't crash, or (b) introduce a discriminator (`convergence_mode: 'metric' | 'worker'`) and gate every `mvState.convergence` access behind it.

Option (a) is the smaller patch and matches what `convergence.stall_counter` already does (line 563 reads it for both modes via `init-microverse.js` populating it). Option (b) is correct long-term but touches more files.

---

## Fix (proposed)

### F1 — Defensive guards in `writeFinalReport`

Make the report writer tolerant of missing `convergence.history`. The report should still be written for worker-managed runs; it just shouldn't include the metric-history table.

```ts
// extension/src/bin/microverse-runner.ts
export function writeFinalReport(sessionDir, mvState, exitReason, iterations, elapsedSeconds) {
  const history = mvState.convergence?.history ?? [];
  const isWorkerMode = !mvState.convergence || mvState.key_metric?.type === 'none';
  const accepted = history.filter(h => h.action === 'accept').length;
  const reverted = history.filter(h => h.action === 'revert').length;
  const bestScore = isWorkerMode ? null : getBestScore(mvState);

  const report = [
    `# Microverse Final Report`,
    '',
    `- **Exit Reason**: ${exitReason}`,
    `- **Iterations**: ${iterations}`,
    `- **Elapsed**: ${formatTime(elapsedSeconds)}`,
    `- **Convergence Mode**: ${isWorkerMode ? 'worker' : 'metric'}`,
    `- **Metric**: ${mvState.key_metric?.description ?? 'n/a'}`,
    ...(isWorkerMode
      ? [`- **Worker Convergence Signal**: see ${mvState.convergence_file ?? 'phase config file'}`]
      : [
          `- **Baseline Score**: ${mvState.baseline_score}`,
          `- **Best Score**: ${bestScore}`,
          `- **Accepted**: ${accepted}`,
          `- **Reverted**: ${reverted}`,
        ]),
    `- **Failed Approaches**: ${mvState.failed_approaches?.length ?? 0}`,
  ];
  if (history.length > 0) {
    report.push('', '## Iteration History', '| Iter | Score | Action | Description |', '|------|-------|--------|-------------|',
      ...history.map(h => `| ${h.iteration} | ${h.score} | ${h.action} | ${h.description} |`));
  }
  report.push(buildFailureDistribution(mvState.failure_history ?? []));
  if (history.length > 0) report.push(buildEfficiencySection(history, iterations));
  // ... existing write logic
}
```

### F2 — Defensive guards in `buildMicroverseHandoff` (line 571)

Same pattern — `mvState.convergence?.history ?? []`. Build the "Recent Metric History" section only when `history.length > 0`. Worker mode skips the section entirely; the convergence file path is the worker's source of truth and the worker reads it directly.

### F3 — Defensive guards in `getBestScore` (line 598)

Return `null` (not `NaN`) when `mvState.convergence` is missing. The panel render at line 1268 should display "n/a" for null, not stringify NaN.

### F4 — Audit + guard `microverse-runner.js:874` last-accepted lookup

Confirm whether this path is reachable in worker mode. If yes, guard. If no, add a runtime assertion `if (!mvState.convergence) throw new Error('last-accepted lookup called in worker mode — refactor needed')` so future regressions surface loudly.

### F5 — Don't overwrite successful convergence on finalizer crash

`markMicroverseFatalError()` (line 1282) currently overwrites `microverse.json` with `exit_reason: 'error'` whenever `main()` throws — even if the throw happened *after* the success marker was already written. Two safer options:

1. **Read-modify-write with success guard**: in `markMicroverseFatalError`, read the current `microverse.json`. If `status === 'converged'` or `exit_reason === 'converged'`, do not overwrite — instead write a `microverse-finalizer-error.json` next to it documenting the post-success crash. The `convergence.history` access bug here is the proximate cause; the data-loss is the deeper bug.
2. **Move `writeFinalReport` outside the `main()` try/catch envelope** so finalizer errors don't trigger the fatal-error overwrite. Report writing is non-critical; if it fails, log and continue.

Option 1 is more defensive (preserves both signals); option 2 is structurally cleaner. Recommend both — option 1 as a belt, option 2 as suspenders.

### F6 — Discriminated `convergence_mode` field on MicroverseSessionState

Long-term: replace `mvState.convergence` access with a discriminated union. Phase 1: add `mvState.convergence_mode: 'metric' | 'worker'` field, populated by `init-microverse.js` from the `--convergence-mode` flag. Phase 2: every `mvState.convergence.*` reader checks the mode first. Phase 3: rename to `mvState.metric_convergence` to make the shape coupling explicit.

This is correct but touches more files. F1–F5 unblock the proximate bug; F6 prevents the next instance.

---

## Acceptance Criteria

- **AC-APH-01** `writeFinalReport()` does not throw when called with `mvState.convergence === undefined`. Unit test in `microverse-runner.test.js` constructs a worker-mode fixture (no `convergence` object) and asserts the call returns without throwing AND writes a non-empty report file.
- **AC-APH-02** The written report for worker-mode convergence renders `Convergence Mode: worker`, omits the metric-history table, and references the convergence-file path so the operator can find the worker's reasoning.
- **AC-APH-03** `buildMicroverseHandoff()` does not throw when `mvState.convergence` is missing. Unit test mounts a worker-mode fixture and asserts the handoff is built.
- **AC-APH-04** `getBestScore()` returns `null` (not `NaN`, not `undefined`) when `mvState.convergence` is missing. Panel renderer at line 1264 shows "n/a" for null.
- **AC-APH-05** `markMicroverseFatalError()` does not overwrite a `microverse.json` whose `exit_reason` is in `successfulReasons`. Unit test: write `microverse.json` with `exit_reason: 'converged'`, call `markMicroverseFatalError`, assert file unchanged AND a `microverse-finalizer-error.json` is created in the same directory documenting the post-success crash.
- **AC-APH-06** `pipeline-runner` exits 0 when anatomy-park converges in worker mode (regression test). Integration fixture: stub `microverse-runner` to drive a worker-mode convergence + the finalizer guard logic, assert pipeline-runner advances to the next phase.
- **AC-APH-07** New `convergence_mode` field on MicroverseSessionState, populated by `init-microverse.js` from `--convergence-mode`. Backwards-compatible default `'metric'` when absent.
- **AC-APH-08** All `mvState.convergence.*` reader sites in `microverse-runner.ts` (audit grep: `\.convergence\.`) gate their access on `mvState.convergence_mode === 'metric'` OR are confirmed safe for worker mode (no `.history` / no `getBestScore`-style operations).

## Verification Plan

1. **AC-APH-01..04** — `extension/tests/microverse-runner-finalizer.test.js`. Worker-mode fixture: `{ status: 'converged', exit_reason: 'converged', failed_approaches: [], failure_history: [] }`. Drive `writeFinalReport`, `buildMicroverseHandoff`, `getBestScore`. Assert no throws + correct report shape.
2. **AC-APH-05** — same test file. Pre-write `microverse.json` with `exit_reason: 'converged'`, call `markMicroverseFatalError`, assert original file unchanged and a sibling `microverse-finalizer-error.json` exists with the error message + timestamp.
3. **AC-APH-06** — `extension/tests/pipeline-runner-anatomy-park.test.js`. Mock `spawn` to return a microverse-runner that exits 0 (after F1–F5 fixes). Run pipeline-runner with phases `['anatomy-park', 'szechuan-sauce']`. Assert szechuan-sauce phase fires.
4. **AC-APH-07..08** — manual audit + lint rule (eslint-plugin-pickle): forbid bare `.convergence.history` access without optional chaining. Add to `eslint-plugin-pickle/index.js` rules section.

## Non-goals

- Redesigning the worker-managed convergence protocol. The shape `anatomy-park.json` writes is correct and battle-tested. This PRD only fixes the finalizer's bad assumption about it.
- Migrating microverse to a discriminated-union state type globally. F6 is sketched as a future improvement; F1–F5 are the must-ships.
- Auto-recovery of post-success crashes (e.g. resuming the next phase from the convergence marker without operator intervention). The fix here makes the success marker durable so no recovery is needed; if the finalizer still crashes after the fix, the operator's manual phase-trim workaround stays as the escape hatch.

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-APH-1 | F5's "preserve success marker" creates two sources of truth (`microverse.json` says converged, `microverse-finalizer-error.json` says crashed). Operators may not notice the second file. | Pipeline-runner's status writer reads BOTH and surfaces a degraded-success state in `pipeline-status.json`. Monitor pane shows the warning. |
| R-APH-2 | Defensive `?? []` pattern proliferates and hides real shape bugs in metric-mode | F6's discriminated union catches metric-mode regressions at the type level. Use `?? []` only at worker-mode call sites; metric-mode callers should hard-fail on missing history because that IS a bug there. |
| R-APH-3 | F2's silent skip of the "Recent Metric History" handoff section means worker iterations get less context | Worker-mode iterations don't track scores anyway. The `consecutive_clean` and `stall_counts` from `anatomy-park.json` already serve the same role. Confirm by inspecting an anatomy-park iteration log post-fix. |
| R-APH-4 | F6's introduction of `convergence_mode` field is a state.json schema change. Versioning required. | Bump `STATE_MANAGER_DEFAULTS.schemaVersion` (currently being raised to 3 elsewhere; coordinate with `prds/archive/incidents/schema-version-deploy-reversion-rca.md`). Migration path: when reading a state.json without `convergence_mode`, infer from presence/absence of `convergence.history`. |
| R-APH-5 | The hot-fix landing in deployed `~/.claude/pickle-rick/extension/bin/microverse-runner.js` will be reverted by the next `install.sh` because that path's reverter (per `prds/archive/incidents/schema-version-deploy-reversion-rca.md`) replaces the inode | Stack this PRD's source-tree commits behind the rca PRD's F1+F3 (kill-switch + parity check). When reverter is fixed, deploy F1–F5 normally. |

## Files Likely Touched

```
extension/src/bin/microverse-runner.ts             # F1, F2, F3, F4, F5
extension/src/bin/init-microverse.ts               # F7 (populate convergence_mode)
extension/src/types/index.ts                       # F6 (MicroverseSessionState shape)
extension/eslint-plugin-pickle/index.js            # F8 (lint rule for unguarded .history access)
extension/tests/microverse-runner-finalizer.test.js  # NEW — F1..F5 unit tests
extension/tests/pipeline-runner-anatomy-park.test.js # NEW — F6 integration test
prds/MASTER_PLAN.md                                  # mention this PRD in §1
```

---

## Linked Context

- Active session demonstrating the bug: `~/.local/share/pickle-rick/sessions/2026-04-30-a5e02f01/`. tmux session `pipeline-a5e02f01`.
- Crash log location: tmux scrollback of `pipeline-a5e02f01:0` shows `[FATAL] Cannot read properties of undefined (reading 'history')` at 2026-04-30T16:06:17Z, immediately after the worker-managed convergence log line.
- Successful convergence markers (preserved despite the crash, because they were written before the throw):
  - `~/.local/share/pickle-rick/sessions/2026-04-30-a5e02f01/anatomy-park.json` — `"converged": true`, `"reason": "Subsystem 'packages' has consecutive_clean=2..."`.
  - `~/.local/share/pickle-rick/sessions/2026-04-30-a5e02f01/packages/dropped_findings.md` — 11 candidate findings across 2 iterations, all dropped below the 80% confidence threshold.
- Overwritten success marker (proof of F5's data-loss bug): `~/.local/share/pickle-rick/sessions/2026-04-30-a5e02f01/microverse.json` shows `"status": "stopped", "exit_reason": "error"` even though the run actually converged.
- Operator workaround that unblocked the pipeline today: edit `pipeline.json` to `"phases": ["szechuan-sauce"]`, re-run `pipeline-runner`. The phase config's `prevPhase: 'anatomy-park'` cleanup logic still fires correctly because anatomy-park's artifacts are present on disk.
- Convergence-mode origin: `pipeline-runner.js:519` — `--convergence-mode worker` for anatomy-park; `--convergence-mode worker` for szechuan-sauce; metric mode is the original microverse use (e.g. `/pickle-microverse` for coverage/perf optimization).
- Related infra bug: `prds/archive/incidents/schema-version-deploy-reversion-rca.md` — the deployed-file reverter would erase any hot-fix to `microverse-runner.js` within ~1 hour. F1–F5 must land in source + survive a clean `install.sh` cycle, which depends on that PRD's F1+F3 shipping first.

---

## Operator workaround for any in-flight pipeline hitting this

When `pipeline-runner` aborts with `Phase anatomy-park failed (exit 1) — stopping pipeline` AND `anatomy-park.json` shows `"converged": true`:

1. Confirm the finalizer crash by grepping the runner pane's scrollback for `[FATAL] Cannot read properties of undefined (reading 'history')`.
2. Edit `${SESSION_ROOT}/pipeline.json` to drop the completed phase from the `phases` array (e.g. `["pickle", "anatomy-park", "szechuan-sauce"]` → `["szechuan-sauce"]`).
3. Re-run `node $HOME/.claude/pickle-rick/extension/bin/pipeline-runner.js ${SESSION_ROOT}` in the same tmux pane. The runner re-reads `pipeline.json` at startup; the phase configs' `prevPhase` cleanup will archive the converged anatomy-park artifacts correctly.

This workaround is what kept `pipeline-a5e02f01` moving today. Document in `pickle-pipeline.md` skill once F1–F5 ship so operators have a fallback if the finalizer still misbehaves.
