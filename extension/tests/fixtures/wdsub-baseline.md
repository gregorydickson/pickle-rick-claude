---
ticket: 44b161e3
purpose: "AC-WDSUB-11a baseline — pre-WS-1 observation of the token-less worker outcome"
baseline_repo_sha: ef7e4fab
observed_at_repo_head: 4da2d9d3
harness: "in-process, real spawn — spawnSync(process.execPath, ['extension/bin/spawn-morty.js', ...])"
sampling_point: "ticket frontmatter read after process exit; persistWorkerOutcomeStatus is the ONLY status writer reached on this path (the isSuccess:true autoFillCompletionCommit branch is skipped), so the on-disk frontmatter after exit equals the state immediately after persistWorkerOutcomeStatus returned"
---

# WDSUB pre-fix baseline: token-less, staged-not-committed worker

## Fixture

A real `spawn-morty.js` subprocess was driven against a tmp git-fixture repo with
a fake `codex` binary on PATH (writeCodexShim pattern from
`extension/tests/spawn-morty-worker-gate.test.js`, adapted to be token-less):

- The fake `codex` worker writes a **fresh** lifecycle artifact
  (`research_2026-07-22.md`, inside the ticket dir).
- It edits `extension/src/wdsub-baseline-fixture.ts` and runs `git add` on it
  (**staged leg** — exercises `checkGitEdits`'s `git diff --stat --cached`
  branch — NOT a commit-based fixture, per the ticket's explicit prohibition).
- It emits **no** `<promise>WORKER_DONE</promise>` token, no
  `COMPLETION_COMMIT_RECORDED` ack, and exits 0 quickly (no timeout).

## Observed result (verbatim from the driven run)

| Field | Observed value |
|---|---|
| ticket `status` (frontmatter, sampled after process exit) | `Failed` |
| ticket `completion_commit` (frontmatter) | **absent from the frontmatter block** — `applyCompletionCommitField` drops the key when `persistWorkerOutcomeStatus` passes `completion_commit: null` on the Failed branch. Equivalent to `completion_commit: null`. |
| did `runWorkerGate` execute? | **No.** `state.json` activity log contains no `worker_gate_failed`, `worker_gate_passed`, or any `tier_phase_*` (other than the pre-spawn `tier_phase_skipped` lifecycle-skip entry) event attributable to a gate run. Source confirms why: in `finalizeWorkerTurn` (`extension/src/bin/spawn-morty.ts:2008-2048`), `runWorkerGate` is called only inside `if (isSuccess) { ... }`; `evaluateWorkerOutcome` (`:2459-2480`) computed `isSuccess = !timedOut && tokenPresent && hasArtifact && (logNonTrivial \|\| hasEdits)`, and with `tokenPresent === false` the whole expression short-circuits to `false` regardless of `hasArtifact`/`hasEdits` — so the gate block is skipped entirely. |
| observed `flipSuppressed` | `false`. No `failed_flip_suppressed` activity event was recorded, and `state.recovery_attempts` has no `failed_flip_suppressed` entry for this ticket. `flipSuppressed` is only set inside the (skipped) `if (isSuccess)` block in `finalizeWorkerTurn`, so it never leaves its initialized value of `false`. |
| worker commit sha | **None** — the worker never committed. `git rev-parse HEAD` before and after the driven run are identical (`3e488fb7...` in the tmp fixture, unchanged). The only git-visible effect is a staged (not committed) diff: `extension/src/wdsub-baseline-fixture.ts \| 1 +`. |
| worker validation failure reason (stderr) | `Worker validation failed: no WORKER_DONE token` |
| spawn-morty process exit code | `1` (matches the `!isSuccess` branch's `process.exit(1)` at `spawn-morty.ts:2073`) |

## Verdict

Baseline reads **`Failed`**, not `Done`. STOP CONDITION does not trigger — the
premise is not wrong, WS-3b's before/after comparison at this seam is
well-founded: whatever WS-1 changes, it must do so against a baseline of
`status: Failed`, `completion_commit: (absent/null)`, `runWorkerGate: did not execute`,
`flipSuppressed: false`.

## Interface Contracts note

`persistWorkerOutcomeStatus`, `evaluateWorkerOutcome`, and `finalizeWorkerTurn`
are internal (unexported) functions in `spawn-morty.ts` — none of the three
appear in the Module Export Catalog for `bin/spawn-morty.ts`. This baseline was
therefore captured via the **real subprocess harness** (driving the actual
`extension/bin/spawn-morty.js` CLI end-to-end and reading the resulting ticket
frontmatter + `state.json` activity log), not via a direct in-process call
against `evaluateWorkerOutcome`'s inputs — the direct-call fallback described in
the ticket's Interface Contracts was not needed.
