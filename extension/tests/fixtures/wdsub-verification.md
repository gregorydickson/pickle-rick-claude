---
ticket: 7412bef9
purpose: "AC-WDSUB-11/11d/11e/12/13 — post-fix observation of the token-less worker outcome, compared against the 44b161e3 baseline"
baseline_artifact: extension/tests/fixtures/wdsub-baseline.md
baseline_repo_sha: ef7e4fab
postfix_repo_sha_observed_at: bd8b7a0e
harness: "in-process, real spawn — spawnSync(process.execPath, ['extension/bin/spawn-morty.js', ...]), same shape as the baseline harness (writeCodexShim/initWorkerFixtureRepo/writeSession pattern from extension/tests/spawn-morty-worker-gate.test.js), token-less, staged-not-committed leg, run at /tmp/wdsub-postfix-repro.mjs (throwaway, not committed)"
sampling_point: "ticket frontmatter and state.json.activity read after process exit"
---

# WDSUB post-fix verification: token-less, staged-not-committed worker

## Fixture (post-fix arm)

A real `spawn-morty.js` subprocess was driven against a tmp git-fixture repo, faithful
to the baseline's fixture shape, with one addition: `complexity_tier: small` in the
ticket frontmatter, so `runWorkerGate` actually executes (small tier still runs
lint+tsc; it skips `test:fast`, which the fixture has no real npm scripts for).
`npm`/`npx` are pass-through no-op shims (exit 0, no output) so the gate's non-test
phases (`npx eslint`, `npx tsc --noEmit`) complete cleanly without a real toolchain.

- The fake `codex` worker writes a **fresh** lifecycle artifact
  (`research_2026-07-22.md`, inside the ticket dir).
- It edits `extension/src/wdsub-postfix-fixture.ts` and runs `git add` on it
  (**staged leg** — same `checkGitEdits` `git diff --stat --cached` branch as the
  baseline — NOT a commit-based fixture).
- It emits **no** `<promise>WORKER_DONE</promise>` token, no
  `COMPLETION_COMMIT_RECORDED` ack, and exits 0 quickly (no timeout).
- The fixture repo has an `extension/` directory present (extension/bin, extension/src,
  extension/package.json), matching "this repo" shape — NOT the target-repo shape
  where `runWorkerGate` short-circuits `ok: true` unconditionally at
  `spawn-morty.ts:1673-1687` when `extension/` is absent. All three
  `persistWorkerOutcomeStatus` terminal states are live in this environment.

## Observed result (verbatim from the driven run)

| Field | Baseline (44b161e3, pre-fix) | Post-fix (this ticket) |
|---|---|---|
| ticket `status` | `Failed` | `Done` |
| ticket `completion_commit` | absent (equivalent to `null`) | `f9d1790245fed266e53248a8a0b3bffa6151bd1a` |
| did `runWorkerGate` execute? | **No** | **Yes** — `worker_lint_gate_passed` activity event present, `file_list: ["extension/src/wdsub-postfix-fixture.ts"]` |
| observed `flipSuppressed` | `false` | `false` (never entered the failure branch — `isSuccess` was `true` throughout, so `flipSuppressed` stayed at its initialized `false`; no `failed_flip_suppressed` activity event) |
| spawn-morty exit code | `1` | `0` |
| worker validation | `Worker validation failed: no WORKER_DONE token` | `successful` (Worker Report panel: `status: exit:0`, `validation: successful`) |
| `worker_gate_verdict` (frontmatter) | not applicable (gate never ran) | `"green"` |

Raw activity log (post-fix arm, in order):
```
tier_phase_skipped   { tier: small, skipped_phases: [research, research_review, plan_review, conformance, simplify] }
worker_backend_resolved
worker_spawn_backend_resolved
tier_phase_skipped   { tier: small, skipped_phases: [test:fast] }
worker_lint_gate_passed { file_list: [extension/src/wdsub-postfix-fixture.ts] }
```
No `worker_gate_failed`, no `failed_flip_suppressed` event in the post-fix run.

## `completion_commit` reachability — BOTH arms

- **Baseline**: field absent from frontmatter; no SHA to check. `applyCompletionCommitField`
  drops the key entirely on the Failed branch (`completion_commit: null` passed in).
  Reachability is not applicable — there is no pointer to lose.
- **Post-fix**: `completion_commit: "f9d1790245fed266e53248a8a0b3bffa6151bd1a"`.
  - `git cat-file -e f9d1790245fed266e53248a8a0b3bffa6151bd1a` → exit 0 (object exists). **PASS**
  - `git merge-base --is-ancestor f9d1790245fed266e53248a8a0b3bffa6151bd1a HEAD` → exit 0
    (ancestor). **PASS**
  - `headBefore === headAfter === completionCommit` — the worker's own edit was staged,
    never committed, so this SHA is the **pre-existing HEAD**, not a new commit the
    worker produced. This is `persistWorkerOutcomeStatus`'s pre-existing
    `completionCommitSha ?? getHeadSha(...)` fallback (`spawn-morty.ts:1994`),
    confirmed live and unrelated to WS-1's `tokenPresent` subtraction (research
    finding #4). A reachable-but-unchanged pointer is still a real observation, not a
    loss: nothing was lost, because nothing new was ever committed by this worker in
    this fixture — the discriminating field is `status`, not the SHA's novelty.

## Three-state disposition

Per `persistWorkerOutcomeStatus:1993-1997`:

| # | `isSuccess` | `flipSuppressed` | Frontmatter written | Observed here? |
|---|---|---|---|---|
| 1 | `true` | — | `Done` + real `completion_commit` | **YES — this observation lands here** |
| 2 | `false` | `false` | `Failed` + `completion_commit: null` | No (this is the baseline's state) |
| 3 | `true` | `true` | nothing written — ticket parked | No — NOT observed, NOT fabricated. Cited from source only: `spawn-morty.ts:2036` (`flipSuppressed = !workerGate.ok && workerGate.failedFlipSuppressed`) and `mux-runner.ts:5453` (`routeFailedFlipSuppression`, a **mux-runner-only** function per research finding #3 — unreachable from a bare `spawn-morty.js` subprocess spawn, which is what both this and the baseline harness drive). State 3 requires a **suppressed** worker-gate failure (`workerGate.ok === false && workerGate.failedFlipSuppressed === true`); this run's gate passed (`ok: true`), so state 3 was never in play for this fixture shape. |

**This observation is state 1, not state 3.** A non-Done result would have required
either a gate failure (state 2/3 territory) — did not occur, gate passed — so this run
is unambiguously state 1: `isSuccess: true`, no suppression, real Done flip.

## Did `runWorkerGate` execute?

- **Baseline**: No. `evaluateWorkerOutcome` pre-fix computed
  `isSuccess = !timedOut && tokenPresent && hasArtifact && (logNonTrivial || hasEdits)`;
  `tokenPresent === false` short-circuited the whole expression to `false`, so
  `finalizeWorkerTurn`'s `if (isSuccess) { ... runWorkerGate ... }` block never ran.
- **Post-fix**: Yes. Post-fix `evaluateWorkerOutcome` (b2882618) is
  `isSuccess = !timedOut && hasArtifact && (logNonTrivial || hasEdits)` — no
  `tokenPresent` conjunct. With a fresh artifact written and a staged edit present,
  `isSuccess` evaluated `true` even with no promise token, entering the
  `if (isSuccess)` block and invoking `runWorkerGate`, confirmed by the
  `worker_lint_gate_passed` activity event and `worker_gate_verdict: "green"` in the
  ticket frontmatter.

This is exactly the routing change WS-1 claims: the deleted `tokenPresent` conjunct is
what moved this fixture from "gate never reached" (baseline) to "gate reached and
passed" (post-fix).

## Was `routeFailedFlipSuppression` reached?

**No, in neither arm.** `routeFailedFlipSuppression` (`mux-runner.ts:5453`) is a
mux-runner-orchestration-level function, invoked from `mux-runner.ts:10266` on the
ticket lifecycle decision path. Neither this ticket's observation nor the baseline's
drove `mux-runner.js` — both drove `spawn-morty.js` directly as a bare subprocess (the
harness pattern from `extension/tests/spawn-morty-worker-gate.test.js`), which never
imports or calls into `mux-runner.ts`. This is consistent across both arms and is not
something either observation could have exercised differently; it is documented here
per the ticket's Interface Contracts requirement, not fabricated as an observation.

## Attribution verdict: WS-1 **HOLDS**

Baseline reads `Failed` / `completion_commit` absent / gate did not execute.
Post-fix reads `Done` / `completion_commit` present (reachable) / gate executed and
passed green. The baseline-Failed → post-fix-Done transition is exactly the shape the
ticket's attribution rule requires (`## Solution` / Research Seeds): **HOLDS**. Nothing
in this observation contradicts the claim; no retraction is warranted for WS-1.

## WS-2 grounding (no fabricated fixture)

WS-2 claims the dead `readiness_halt` reader cluster deletion (`bd8b7a0e`, ticket
`bcd9ce96`) removed only unreachable code, because its producer was already deleted by
an earlier commit (`87d837f6`, R-GATE-ADVISORY).

- `grep -n "readiness_halt" extension/src/bin/mux-runner.ts` → **zero matches**. Run
  directly during this ticket's work; confirms mux-runner.ts has never written
  `exit_reason: 'readiness_halt'`.
- `extension/src/bin/mux-runner.ts:9705-9714` — the live readiness-gate call site: on a
  non-zero `check-readiness` exit it logs `readiness advisory: ...` and explicitly does
  **not** halt (`log(\`readiness advisory: check-readiness exited ${readinessStatus} —
  findings logged, NOT halting (advisory gate)\`)`). This is the current, sole producer
  of readiness-gate outcomes.
- `extension/tests/mux-runner.test.js:1065-1066` — live, currently-passing test
  asserting the advisory behavior:
  `assert.match(runnerLog, /readiness advisory/)` (gate ran, logged its finding) and
  `assert.doesNotMatch(result.stderr + runnerLog, /READINESS HALT/)` (never halts).
- `git show bd8b7a0e --stat` — confirms the diff touches only
  `extension/bin/pipeline-runner.js`, `extension/src/bin/pipeline-runner.ts`,
  `extension/tests/mux-runner.test.js` (one deletion), and
  `extension/tests/pipeline-runner-prnf9.test.js` — reader-side deletions in
  `pipeline-runner`, not the mux-runner producer.

**No new `readiness_halt` fixture was created for this ticket.** WS-2's grounding is a
citation of existing, already-passing coverage (`mux-runner.test.js:1065-1066`) plus a
direct grep against current HEAD, per the ticket's explicit prohibition on fabricating
a fixture for a codepath that was never reachable via a bare `spawn-morty.js` spawn in
the first place (`routeFailedFlipSuppression` / mux-runner-level readiness gate — see
above).

## Retractions

None. No claim in this observation is contradicted by what was actually run. Both WS-1
(attribution: HOLDS) and WS-2 (grounding: citation-based, no fabrication) stand as
verified above.
