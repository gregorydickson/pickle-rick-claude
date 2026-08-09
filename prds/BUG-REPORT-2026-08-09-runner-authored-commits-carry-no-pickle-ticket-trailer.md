# B-RATRAIL — Runner-authored commits carry no `Pickle-Ticket` trailer, so every runner-authored Done flip is refused

**Status:** Draft
**Branch:** `release/v2.1-beta`
**Baseline:** `f1e1ce1b` (v2.1.0-beta.8)
**Priority:** P1 — a live reliability defect on the recovery/salvage path, plus the root cause of 13 of the 16 red `test:integration:parallel` tests.

---

## Summary

`readEvidence`'s git-log arm is trailer-only. B-GITATTR WS-3 (`a4e48c26`,
*"fix(git-trailer-hooks): delete the message-inference completion-evidence…"*) removed message
inference, leaving `scanGitLogByTrailer` — an exact match on the `Pickle-Ticket` git trailer — as the
only way a commit can be attributed to a ticket without an explicit `completion_commit` stamp.

The trailer has exactly **one** producer: the `prepare-commit-msg` hook that
`services/git-trailer-hooks.ts` materializes, wired in by
`services/backend-spawn.ts:buildTrailerHooksEnvFragment` via `core.hooksPath` + `PICKLE_TICKET_ID`.
That fragment is applied **only to worker subprocess spawns**.

Commits the **runner authors in-process** therefore carry no trailer. They name the ticket in the
subject line (`fix(<ticketId>): commit-and-continue recovery (R-ORSR-2)`) — which is precisely the
signal `a4e48c26` deleted. So:

1. `commitAndContinueDoneFlip` stages, commits, and then calls
   `guardCompletionCommitBeforeDone`.
2. The guard reads evidence for a commit that has no trailer and no explicit stamp → `absent`.
3. The guard refuses → `commitAndContinueDoneFlip` returns `{ ok: false }`.
4. The caller reports `reason: 'commit-failed'`.

**The commit landed. The ticket does not go Done.** Work is committed and then orphaned from its
ticket — the same shape as the `zero_diff_ticket_stamped_foreign_completion_commit` /
`done_without_commit_evidence` family.

### Verified reproduction (2026-08-09, HEAD `f1e1ce1b`)

A temp repo, one commit whose subject is `fix(aaaa1111): commit-and-continue recovery (R-ORSR-2)`,
read through the deployed `readEvidence`:

```
A subject-only  -> {"kind":"absent","absentReason":"no_evidence"}
B with trailer  -> {"kind":"committed","sha":"3ef19a68…","via":"scan"}
```

The only delta between A and B is a `Pickle-Ticket: aaaa1111` trailer on the same commit.

---

## Evidence: the integration tier

`npm run test:integration:parallel` at `f1e1ce1b`: 590 tests, 574 pass, **16 fail**.
(Measure the two sub-tiers separately — `test:integration` is `parallel && serial`, so a red parallel
half means the serial half never runs.)

The 16 split into four causes:

### Cause A1 — the production gap above (6 tests: 4 parallel, 2 serial)

The runtime authors the commit; the guard then refuses it.

| Test | File | Actual |
|---|---|---|
| `AC-DURA-1 commit branch` | `tests/boundary-commit-at-iteration.test.js:69` | `honest_failure/commit-failed` |
| `AC-DURA-2 allowlist staging` | `tests/boundary-commit-at-iteration.test.js:176` | `honest_failure/commit-failed` |
| `AC-1/AC-2/AC-3 forced fatal … N+1 stashed` | `tests/exit-path-bystander-stash.test.js:67` | `reason=commit-failed` |
| `AC-R-MWIS-3 Case A` | `tests/mux-exit-path-commit.test.js:79` | `reason=commit-failed` |
| `AC-PCOMP-4: 4-ticket bundle completes 4/4 hands-off` (serial) | `tests/integration/pipeline-completion-handsoff-e2e.test.js:160` | `(b) T2 exit-commit … reason=commit-failed` |
| `M1: ticket-owned dirty work is still committed` (serial) | `tests/mux-runner-fix-b.test.js:136` | `reason=commit-failed` |

`AC-PCOMP-4` is the sharpest statement of the defect: an end-to-end hands-off bundle cannot complete,
for exactly this reason.

These tests are **correct and valuable**. They assert the contract the runtime is supposed to honor
and the runtime does not. Do not weaken them.

### Cause A2 — fixtures that encode the deleted message-inference contract (6 tests)

These fixtures hand-author a commit with the ticket id in the **subject** and no trailer, then assert
it is attributable. In production a worker commit carries the trailer (the hook stamps it) or is
amended to carry one (`spawn-morty.ts:reconcileWorkerCommitAttribution`), so the fixture models a
commit shape production no longer produces.

| Test | File |
|---|---|
| `path-2 autofill: … fills from git-log` | `tests/characterization/completion-commit-cluster/path-2-worker-autofill-belt-and-suspenders.test.js:52` |
| `path-3 manager-drift` | `.../path-3-manager-drift-auto-completion-validation.test.js:76` |
| `path-7 backfill` | `.../path-7-phantom-done-watcher-backfill.test.js:74` |
| `AC-DURA-8 attribute branch` | `tests/boundary-commit-at-iteration.test.js:102` |
| `AC-DURA-8 attribute` | `tests/doneflip-gate-all-callsites.test.js:118` |
| `AC-WUWC-11a: readEvidence returns { kind: "committed", sha }` | `tests/wuwc-reproducer.test.js:305` |

The value in each test is real (autofill, manager drift, phantom-done backfill, boundary attribution
are all live paths). Only the **fixture commit shape** is stale. Fix the fixture, keep the assertion.

### Cause B — brittle source-text tests (2 tests)

Neither describes a production defect; both broke on refactors that did not change behavior.

| Test | Why it fails |
|---|---|
| `AC-SPAWN-SUMMARY-SOURCE` (`tests/integration/setup-codegraph-index.test.js:282`) | greps `mux-runner.ts` for the literal `emitCgSessionSummary`. That symbol exists **nowhere in `src/`** — the b1089e97 work renamed it (`createCodegraphSession` / `emitSummary`). The behavior it stands for is separately and behaviorally covered by `tests/codegraph-session-summary-counts.test.js`. |
| `AC-DURA-3: the 7th path commitAndContinueDoneFlip routes Done through the guard` (`tests/doneflip-gate-all-callsites.test.js:74`) | slices a fixed **2000 characters** from `export function commitAndContinueDoneFlip` and greps inside. The function's leading comment block grew (AP-EXT-ITER6-01), pushing the real `guardCompletionCommitBeforeDone(` call past the window. The routing is intact — `mux-runner.ts:5330`. |

### Cause C — needs its own diagnosis (1 test)

`INV-CODEX-RECOVERY-ADVANCED` (`tests/integration/codex-authority-recovery.test.js:304`) expects
`kind: 'relaunch'`, gets `{"kind":"break","reason":"recovery_exhausted"}` after 18.5s. The test relies
on the `PICKLE_TEST_MODE === '1'` guard bypass (`mux-runner.ts:5012`), which is still present, so this
is **not** explained by A1. Diagnose before changing anything.

### Cause D — B-ONEABORT reconciliation (3 tests)

`tests/integration/pipeline-runner-judge-reasons.test.js` (last touched `a5015064`, 2026-07-26, eleven
days before B-ONEABORT) and one twin in `pipeline-runner-judge-timeout-recovery.test.js` assert the
contract B-ONEABORT deliberately removed: they expect `judge_unreachable` / `judge_cli_missing` /
`all_judge_backends_exhausted` to skip the finalize gate and abort. Under the current classifier every
`MICROVERSE_EXIT_REASONS` member routes to the finalize gate and only `session_state_corrupted`
aborts (see the `pipeline-runner.ts` B-ONEABORT trap door). Ticket 50 (`f378ffd1`) already performed
exactly this reconciliation on the **fast**-tier twin
`tests/pipeline-runner-judge-unreachable.test.js` — use it as the template.

### Cause E — R-JPCM superseded the judge output contract (2 serial tests)

`buildJudgePrompt` used to demand a bare integer. R-JPCM replaced that with a single JSON object
(`microverse-runner.ts:1703-1712`) because the parser `parseLlmJudgeOutput` demanded an object, so
every measurement landed in `emptyJudgeResult('malformed')`. The two tests still pin the old prose:

| Test | Asserts | Present in source? |
|---|---|---|
| `buildJudgePrompt includes goal, cwd, and scoring format instructions` (`tests/microverse.test.js:2059`) | `prompt.includes('single integer')` | no |
| `buildJudgePrompt instructs no fractions` (`tests/microverse.test.js:2066`) | `prompt.includes('Do NOT use fractions')` | no |

The goal/cwd half of the first test is still valid and still passes; only the scoring-format assertion
is stale. Same shape as Cause D: a deliberate contract change with no test reconciliation.

### Not a defect — environment/load (1 serial test)

`install-script-prefix.prefix-writes-files` (`tests/install-script-prefix.test.js:55`) exited `null`
(killed, not a non-zero exit) after **1,190,825 ms — 19.8 minutes** — with its stdout stopped at
`🔨 Compiling TypeScript...`. This is the real-install class that must be re-measured **at rest**;
this run had a concurrent `codex` pipeline and other work on the machine. Do **not** change code or
shrink a timeout for it (see the serial-manifest hygiene principle in `extension/CLAUDE.md`: a
subprocess timeout is a hang-guard, not a perf assertion). Re-measure before drawing any conclusion.

---

## The pattern across all 21 failures

| Class | Count | What it is |
|---|---|---|
| A1 — runner-authored commit has no trailer | 6 | One real production defect |
| A2 — fixture models a commit shape production no longer produces | 6 | Stale fixture, valid assertion |
| D — B-ONEABORT contract change, unreconciled | 3 | Stale contract |
| B — brittle source-text greps | 2 | Test rot, no defect |
| E — R-JPCM contract change, unreconciled | 2 | Stale contract |
| C — unexplained | 1 | Needs diagnosis |
| env/load | 1 | Re-measure at rest |

**13 of 21 are tests pinning a contract or commit shape that a deliberate change superseded.** They
accumulated because no pipeline phase runs the integration tier — pickle, citadel, anatomy-park and
szechuan-sauce all gate on `test:fast`, so a bundle can run four green phases over a red integration
tier, and `test:integration` being `parallel && serial` meant the serial half was never even reached.
That is the structural finding; it is tracked below, out of scope for this bundle.

---

## Simplification Review

1. **What can be subtracted instead of added?** The two Cause-B tests are subtractive fixes: one
   deletes a dead symbol grep in favour of the behavioral test that already exists; the other replaces
   a byte-offset slice with a bounded read. Neither adds a guard.
2. **Does WS-A add a new mechanism?** No. It reuses git's own trailer writer (`interpret-trailers`),
   the same one the WS-1 hook uses, so producer and consumer keep one view. No new state field, no new
   gate, no new env var.
3. **Is there a smaller root fix?** The alternative — restoring message inference — is explicitly
   forbidden by the `ticket-completion-evidence.ts` R-CCRC-1 trap door and would re-open the
   proxy-over-truth surface B-GITATTR closed. Producer parity is the smaller, truthful fix.
4. **What guard is being loosened?** None. WS-A makes an existing guard *satisfiable* on a path where
   it is currently unsatisfiable by construction.

---

## Workstreams

### WS-A — runner-authored commits stamp the trailer (production fix)

Two ticket-attributable commits are authored by the runner in-process, neither under the trailer-hook
env fragment:

- `src/bin/mux-runner.ts:5319` — `commitAndContinueDoneFlip`
- `src/bin/mux-runner.ts:6040` — `executeConvergedPlanAdapter`'s per-phase `commitPhase`

Both must carry `Pickle-Ticket: <ticketId>`, written with `git interpret-trailers` (symmetric with the
hook's writer — a bare appended line opens a new paragraph and demotes any pre-existing trailer to
prose), degrading to a plain appended trailer only when `interpret-trailers` cannot run.

Not in scope: `microverse-runner.ts:3125` / `:3854` (not ticket-scoped) and
`spawn-morty.ts:1553` (runs inside the worker process, which already carries the env fragment — verify,
do not change).

**Acceptance criteria**

- AC-A1: `cd extension && npx tsc --noEmit` exits 0.
- AC-A2: A new test asserts that after `commitAndContinueDoneFlip` succeeds on a temp repo, the
  authored commit's `git log -1 --format='%(trailers:key=Pickle-Ticket,valueonly)'` equals the ticket
  id. Assert the **parsed trailer view**, never a `%B` substring.
- AC-A3: A test asserts a commit with a pre-existing trailer (e.g. `Co-Authored-By:`) still exposes
  that trailer in the parsed view after the runner's stamp (no paragraph demotion).
- AC-A4: `node bin/test-runner.js --tier integration --manifest tests/integration/.serial-tests.json
  --manifest-mode exclude` shows the four Cause-A1 tests passing.
- AC-A5: Mutation check — removing the trailer stamp reddens AC-A2 and the four Cause-A1 tests, and
  nothing else.

### WS-B — fixtures produce commits the way production does

Give the completion-commit fixtures one shared helper that authors a commit **with** a
`Pickle-Ticket` trailer, and use it wherever a fixture is standing in for a worker commit.

**Acceptance criteria**

- AC-B1: One shared helper; no per-file copy of the trailer-stamping logic.
- AC-B2: The six Cause-A2 tests pass, with their original assertions **unchanged** — only the fixture
  commit shape changes. Each changed fixture carries an adjacent comment naming
  `a4e48c26` and stating why a subject-only commit is no longer a production shape.
- AC-B3: No assertion is deleted or weakened; the diff to those six test files touches fixture setup
  only.

### WS-C — replace the two brittle source-text tests

- AC-C1: `AC-SPAWN-SUMMARY-SOURCE` is deleted, with a comment in
  `tests/integration/setup-codegraph-index.test.js` pointing at
  `tests/codegraph-session-summary-counts.test.js` as the behavioral cover. (Deletion, not a symbol
  rename: a symbol-name grep next to a behavioral test that already drives the real emitter is pure
  duplication with a drift liability.)
- AC-C2: `AC-DURA-3: the 7th path …` no longer uses a fixed byte window. It bounds the read by the
  function's own extent (start of `commitAndContinueDoneFlip` to the start of the next top-level
  `export`), or is replaced by a behavioral assertion.
- AC-C3: Mutation check — removing the `guardCompletionCommitBeforeDone(` call from
  `commitAndContinueDoneFlip` still reddens the rewritten AC-DURA-3 test.

### WS-D — reconcile the three B-ONEABORT twins

Mirror `f378ffd1`. Reconcile each assertion **deliberately**, with the reasoning in an adjacent
comment. Never delete or weaken an assertion to make it pass.

- AC-D1: The three tests pass against the current `classifyMicroverseHaltDecision` contract.
- AC-D2: Each changed assertion carries a comment naming B-ONEABORT and what the contract now is.
- AC-D3: An assertion-count floor is pinned for
  `tests/integration/pipeline-runner-judge-reasons.test.js` so a later change cannot quietly shrink it.

### WS-E — diagnose `INV-CODEX-RECOVERY-ADVANCED`

Diagnose only. Produce a written root cause in the ticket's artifacts. Change code **only** if the
root cause is a production defect; if the test is stale, say so with evidence and reconcile it the way
WS-D does.

- AC-E1: A root-cause statement citing the specific line where the ladder takes `recovery_exhausted`
  instead of `advanced`.
- AC-E2: Either the test passes, or the ticket records why it should not and what replaces it.

### WS-F — reconcile the two R-JPCM judge-prompt assertions

Same discipline as WS-D: reconcile deliberately against the shipped contract, never delete the test.

- AC-F1: `buildJudgePrompt includes goal, cwd, and scoring format instructions` asserts the **current**
  contract — the single-JSON-object instruction and its five required keys — and keeps its existing
  goal/cwd assertions unchanged.
- AC-F2: `buildJudgePrompt instructs no fractions` either asserts a scoring constraint the shipped
  prompt actually makes, or is deleted with an adjacent comment naming R-JPCM and stating that the
  bare-integer contract (and with it the fractions hazard) no longer exists.
- AC-F3: Mutation check — deleting the `'Output a SINGLE JSON object and NOTHING else'` line from
  `buildJudgePrompt` reddens AC-F1.

---

## Out of scope (tracked, not fixed here)

- **`install-script-prefix.prefix-writes-files`** — re-measure at rest before any action.
- **No pipeline phase runs `test:integration`.** This is the structural reason the debt accumulated
  unseen — pickle / citadel / anatomy-park / szechuan-sauce all gate on the fast tier, so a bundle can
  run four green phases over a red integration tier. Any fix here must be **advisory**: per the root
  `CLAUDE.md`, a gate may refuse a local action and flag a residual, but must never halt the phase
  loop. Its own bundle.
- **Untagged worker commits outside `reconcileWorkerCommitAttribution`'s preconditions** (multi-commit
  window, dirty index) remain unattributable. Narrower than WS-A; note it, do not fix it here.

---

## Bundle-wide gate

Green from `extension/` before this bundle is considered done:

```
npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc \
  && bash scripts/audit-trap-door-enforcement.sh \
  && npm run test:fast \
  && npm run test:integration:parallel \
  && npm run test:integration:serial
```

Run the two integration sub-tiers **separately** and read each one's own
`ℹ tests/pass/fail` summary — never the composite `test:integration`, whose `&&` hides the serial
half behind a red parallel half. `test:integration:parallel` must show **0 failures** — not "no new
failures". `test:integration:serial` must show at most the one environment-sensitive
`install-script-prefix` failure, and only after a re-measure at rest confirms it is load-shaped.
