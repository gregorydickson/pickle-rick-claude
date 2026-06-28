---
title: "B-CWGE — codex worker quality gate fail-closed enforcement (R-CWGE)"
priority: P1
finding: R-CWGE
status: ready
type: bug-fix-bundle
schema_neutral: true
self_modifying_recovery: false
backend: claude
source_bug_report: prds/BUG-REPORT-2026-06-27-codex-worker-gate-not-enforced-and-anatomy-guard-piling.md
---

# B-CWGE — codex worker quality gate fail-closed enforcement

## Problem

On `--backend codex`, the per-ticket worker quality gate (`runWorkerGate` in `spawn-morty.ts`:
eslint + tsc + `test:fast`) **did not block completion-commits.** The 2026-06-27 B-PXBO codex soak
`Done`-flipped 4 tickets with valid `completion_commit`s over code that fails the release gate (WS-1
broke 3 pre-existing tests + an unguarded `Number(worker_pid)` eslint error; WS-3 added a
sandbox-violating test failing `audit-test-isolation`; WS-4 broke the `readEvidence`
"explicit-SHA-wins" invariant + pushed complexity 13→19). The build was reverted — no ship.

This is the **R-DOTR class (Done-over-red) recurring at the worker-gate level**: the very class
B-PXBO existed to fix, manifest on codex during B-PXBO's own build.

### Root cause (confirmed by source read, 2026-06-28)

`runWorkerGate` is invoked from **exactly one callsite**: `spawn-morty.ts:1619`, inside
`finalizeWorkerTurn`, guarded by `if (isSuccess)` (where `isSuccess` is the *worker exit*
classification from `evaluateWorkerOutcome`). **No orchestrator Done-flip path re-runs it** — verified:
the only `runWorkerGate(` call in `extension/src/` is the spawn-morty one; every `markTicketDone(`
callsite in `mux-runner.ts` (durable-boundary committer, salvage clean-tree backfill,
`applyAutoTicketCompletionValidation`, and B-PXBO's new detached terminal-via-oracle path) decides
keep-vs-Done from the **evidence oracle** (does an attributable `completion_commit` exist) — NOT from
whether the gate passed.

So on the codex large-tier **detached** / `no_progress_timeout` / salvage path — where the worker
commits partial work but never exits through spawn-morty's clean `isSuccess` finalize — **`runWorkerGate`
never runs**, and the orchestrator then flips the ticket `Done` purely on commit-existence. B-PXBO WS-2
(R-DOTR) partially closed this by persisting `WORKER_GATE_TSC_OK_FIELD` and consulting it on the
salvage/timeout disposition — but (a) it only covers `tsc`, not `eslint`/`test:fast`, and (b) when the
gate **never ran** there is no verdict to consult, so the field is absent and the flip proceeds. The
present default on a missing verdict is **fail-OPEN**. R-CWGE makes it **fail-CLOSED**.

This is **backend-independent in mechanism** (the gate-bypass paths exist for claude too) but bites
codex because codex hits the detached / no-progress / salvage dispositions far more often, and codex
workers bypass PreToolUse hooks (per `project_rssoc_rtdcs_shipped_beta20_21_deployed`).

## Goal

A ticket may reach `status: Done` with a `completion_commit` **only** when a worker quality gate
(eslint + tsc + `test:fast` for its tier) has been recorded **GREEN** for that commit. Absence of a
recorded green verdict on any Done-flip path is **fail-closed** (disposition `Failed` / retry, never
`Done`). No new gate — reuse `runWorkerGate` and the existing between-ticket fast gate; close the
enforcement gap on the path that already exists.

## Non-goals

- R-APNC (anatomy-park guard-piling) — separate P2 bundle, same source bug report.
- R-SIGF scope-fence auto-extension — separate parallel track.
- Changing the gate's *contents* (which checks run per tier). Only its *enforcement reach*.

---

## Workstreams

### WS-1 — Root-cause characterization (investigation + failing tests first; TDD red)

Reproduce the bypass and pin **which** Done-flip path ships red, so the fix targets the real seam, not
a guessed one.

- Add an `@tier: integration` characterization test that drives a worker to **commit a lint-RED change
  on a `large`/detached or `no_progress_timeout` disposition** (codex-shaped: worker commits, never
  reaches spawn-morty's `isSuccess` finalize), then asserts the orchestrator Done-flip path
  **currently** flips it `Done` (the red, documenting the bug), and after WS-2 **refuses** it.
- The test MUST exercise the real Done-flip helpers in `mux-runner.ts` (the `markTicketDone` callsites
  reachable from the detached terminal-via-oracle / salvage / auto-completion paths), not a mock.
- Confirm or refute the secondary hypothesis (`test:fast` timeout passthrough): assert that a worker
  `runWorkerGateTestCommand('test:fast', …)` **timeout** yields `ok: false` with a `__timeout__`
  failure (it already does at `spawn-morty.ts:1178-1186` — pin it so a regression can't silently flip
  it to a pass).

**AC-CWGE-1** (red→green): `extension/tests/integration/codex-worker-gate-fail-closed.test.js`
(forward-created) exists, exercises a real `mux-runner.ts` Done-flip helper over a committed lint-RED
tree with **no recorded green worker-gate verdict**, asserts the pre-WS-2 behavior flips `Done` (xfail
marker removed by WS-2) and the post-WS-2 behavior yields a non-`Done` disposition.

**AC-CWGE-2**: a test pins that `runWorkerGateTestCommand` returns `ok:false` + a single `__timeout__`
`WorkerGateTestFailure` when the underlying `npm run test:fast` times out (regression guard on the
existing fail-closed-on-timeout shape).

### WS-2 — Fail-closed worker-gate verdict authority on every Done-flip path

Make the recorded worker-gate verdict authoritative, generalizing B-PXBO WS-2's `tscOk`-only,
salvage-only persistence.

- **Persist the full verdict, not just tsc.** Extend `persistWorkerGateTscOk`
  (`spawn-morty.ts`) into a verdict writer that records eslint + tsc + test outcomes for the
  completion commit (reuse the existing `WorkerGateCheckResult` already computed in
  `finalizeWorkerTurn`; reuse `upsertFrontmatterField`; **no new schema field on `state.json`** —
  ticket-frontmatter fields only, which survive the gate-fail tree reset). Prefer ONE frontmatter
  field `worker_gate_verdict: green|red|absent` over three booleans (subtraction: collapses the
  tsc-only field into a single verdict the Done-flip paths read).
- **Ensure a verdict exists on the codex completion path.** When a worker produces a commit but does
  NOT exit through spawn-morty's clean `isSuccess` finalize (detached / no_progress / salvage), the
  orchestrator MUST obtain a verdict before flipping `Done`. **Reuse the existing between-ticket gate**
  (`runBetweenTicketFastGate` / `runBetweenTicketFastTests` in `mux-runner.ts`) to compute and record a
  verdict for the commit at the Done-flip boundary when none is recorded — do NOT add a parallel gate.
- **Fail closed.** Every orchestrator Done-flip path that consults the evidence oracle MUST also
  consult the verdict: a `red` or `absent` verdict for the completion commit ⇒ disposition is
  `Failed` (operator-recoverable, reuse the existing `Failed` + `failed_reason` convention), never
  `Done`. This routes through the existing `guardCompletionCommitBeforeDone` ordering — extend the
  guard's decision, do not add a new guard.

**AC-CWGE-3**: a worker-gate run records a single `worker_gate_verdict` frontmatter field
(`green`|`red`|`absent`) on BOTH the pass and fail paths of `finalizeWorkerTurn`; the legacy
`WORKER_GATE_TSC_OK_FIELD` read path is subsumed (one field, not two) with no behavior regression on
the B-PXBO WS-2 (R-DOTR) salvage/timeout case.

**AC-CWGE-4**: every `markTicketDone(` callsite reachable from an orchestrator completion path
(durable-boundary committer, salvage clean-tree backfill, `applyAutoTicketCompletionValidation`,
detached terminal-via-oracle) is gated on a `green` `worker_gate_verdict` for the completion commit; a
`red`/`absent` verdict yields a non-`Done` disposition. Enforced by an audit-style test that greps the
callsites + a behavioral integration test (AC-CWGE-1).

**AC-CWGE-5**: when no verdict is recorded for a commit on a Done-flip path, the orchestrator computes
one via the **existing** `runBetweenTicketFastGate`/`runBetweenTicketFastTests` (no new gate function
introduced — verified by `grep -c "runWorkerGate(" extension/src/ === 1` staying true, and no new
`spawnSync('npm', ['run', 'test:*'])` callsite outside the existing between-ticket gate).

**AC-CWGE-6** (fail-closed default): with the verdict field absent AND the between-ticket gate
unavailable/erroring, the Done-flip MUST default to a non-`Done` disposition (the safe direction),
emitting an observability event — never silently flip `Done`.

### WS-3 — Documentation + trap-door

- Update the `spawn-morty.ts (worker lint gate)` trap door in `extension/CLAUDE.md` to state the
  **enforcement-reach** invariant: the worker-gate verdict is authoritative on every Done-flip path,
  fail-closed on absence.
- `README.md` unaffected (no command surface change) — confirm and note in the PRD closeout.

**AC-CWGE-7**: `extension/CLAUDE.md` carries the enforcement-reach invariant with an ENFORCE test
reference; `audit-trap-door-enforcement.sh` passes.

---

## Simplification Review (subtract-before-add)

**WS-1 (investigation + tests).** (1) Necessary? Adds only test files — the ideal (pure verification,
no runtime code). (2) Reuse? Reuses the existing characterization-suite pattern under
`extension/tests/` + the real `mux-runner.ts` helpers. (3) Guards brittle complexity? No — it
*documents* the brittle fail-open before WS-2 removes it. (4) Subtract? N/A (tests only).

**WS-2 (fail-closed enforcement).** (1) Necessary? Yes — runtime behavior change. The new state is
ONE frontmatter field. (2) Reuse? **Heavy reuse, no new machinery**: extends the existing
`persistWorkerGateTscOk` writer, the already-computed `WorkerGateCheckResult`, `upsertFrontmatterField`,
the existing `guardCompletionCommitBeforeDone` ordering, and the **existing** between-ticket fast gate
(`runBetweenTicketFastGate`). No second `runWorkerGate`, no new `test:*` callsite. (3) Guards brittle
complexity? The current `WORKER_GATE_TSC_OK_FIELD` (tsc-only, salvage-only) is the brittle partial fix
— WS-2 **subtracts** it by *replacing* it with one `worker_gate_verdict` field covering all checks on
all paths, rather than adding a parallel eslint-field + test-field beside it. (4) Subtract? **Yes** —
collapse `WORKER_GATE_TSC_OK_FIELD` (one tsc-boolean) into the single `worker_gate_verdict`; the
multiple Done-flip paths read ONE verdict source instead of each carrying bespoke commit-existence
logic.

**WS-3 (docs).** (1) Necessary? Doc-only. (2) Reuse? Updates an existing trap door, adds none. (3/4)
N/A — documents the now-enforced invariant.

---

## Build protocol

**NOT self-modifying-recovery in the dangerous sense.** R-CWGE edits the worker-gate / completion path,
but it is built on **claude**, whose worker gate **is** enforced — the deployed (beta.25) claude
runtime that builds the fix correctly gates the workers building it. Do **not** `install.sh`-deploy
mid-pipeline (that would swap the runtime under the running workers). Standard `/pickle-pipeline
--scope branch` on claude. The fix becomes the prerequisite for any future trustworthy codex soak.

**Pre-build residual check** (`feedback_prelaunch_residual_check_stale_findings`): `git log` / grep
HEAD for `worker_gate_verdict` / `WORKER_GATE_TSC_OK_FIELD` enforcement in case a beta.25 change
already shifted the seam.

## Verification (release gate)

Full local gate from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc`
+ all audit scripts + `npm run test:fast:budget` + `npm run test:integration` +
`RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. Green before tag. Flake-classify any `test:fast`/c8
variance at `--test-concurrency=4` (authoritative). On ship: bump to **v2.0.0-beta.26**, commit,
`install.sh`, `gh release create`.
