---
title: "R-WMFF — Worker parks on a monitor/wait pattern for its test gate, burns budget, Failed-flip orphans verified uncommitted work with zero activity trail"
priority: P2
finding: R-WMFF
status: captured
type: bug-report
schema_neutral: true
observed: 2026-07-11, session 2026-07-11-a19aa731 (B-CGHARD pipeline), ticket 6317933b
---

# R-WMFF — monitor-wait Failed-flip orphans verified work (capture-only)

## Symptom

Hardening ticket `6317933b` (code-quality pass, large tier) flipped `status: "Failed"` even
though the worker had COMPLETED its deliverable: a verified one-line dead-code subtraction in
`codegraph-query-runner.ts` (+ compiled mirror), full artifact trail on disk
(research/plan/reviews all approved, `code_review_2026-07-11.md` verdict PASS, tsc+eslint green
per conformance), and `handoff_notes.md` stating "Failed: none — diff is clean… Next focus:
confirm test:fast green, commit, flip Done."

The verified diff was left UNCOMMITTED in the working tree across the Failed-flip boundary — the
exact precondition for the known reset-destroys-work class.

## Forensics (session 2026-07-11-a19aa731)

- `6317933b/worker_session_8786.log` (103 bytes, the entire log): *"Artifacts staged. Waiting on
  the test:fast monitor event before finalizing conformance and committing."* — the worker
  delegated its `test:fast` confirmation to a monitor/background-wait pattern and parked.
  Inside a `claude -p` worker there is no guaranteed waker for that wait; the worker sat idle
  until its budget died.
- `state.json.activity`: the ONLY event for the ticket is `worker_spawn_backend_resolved`
  (19:10:54Z). **No** `worker_partial_lifecycle_exit` (correctly — all artifact prefixes exist,
  the R-WSE-2 predicate doesn't fire), no silent-death, no timeout, no failed-flip event. The
  Failed flip is invisible in telemetry — observability gap for the "complete-but-uncommitted"
  terminal shape.
- Exit-path salvage (`commitGatePassingDeliverableOnExitPath`) did not commit the work: the
  worker gate never RAN (worker died pre-gate), so there was no gate-passing evidence — the
  salvage refused correctly by its own contract, but the net effect is orphaned verified work.
- Recovery machinery did engage the loop afterward (manager iteration 4 actively re-driving,
  flake-triaging `test:fast` reds in isolation) — the LOOP is not wedged; only the work-loss +
  telemetry-blindness legs are defects.

## Operator recovery applied (this incident)

Per the standing rule (commit verified uncommitted work BEFORE respawn): babysitter re-verified
tsc clean and committed the diff as `3d36ff2c` (`harden(6317933b): dead-code …`, `Resolves:`
trailer audit-green) and logged the assist. No state.json edits; runner left to its own
re-drive.

## Hypothesis / defect legs

1. **Worker behavior (prompt-layer):** the worker used a background/monitor wait for its own
   gate command instead of running it synchronously (the worker lint gate is the runner's job at
   finalize anyway — R-CWGE `runWorkerGate` runs before completion-commit). A worker that has a
   green diff should commit and let the gate verdict land; parking on an un-wakeable monitor
   event inside `claude -p` is a death sentence. Likely prompt-shape fix in the send-to-morty /
   hardening-ticket lifecycle guidance: forbid backgrounding the gate wait.
2. **Telemetry:** a terminal Failed flip on a ticket whose artifact set is COMPLETE and whose
   tree carries an in-scope dirty diff should emit a distinct breadcrumb (the mirror-image of
   R-WSDO `worker_produced_nothing` — this is `worker_produced_everything_but_commit`). Today it
   emits nothing.
3. **Salvage reach (evaluate before adding anything):** the exit path already has the salvage
   seam; the question is whether "complete artifacts + clean in-scope diff + no gate verdict"
   should run the gate once and commit on green, or stay refused. Subtract-before-add: prefer
   tightening the WORKER contract (leg 1) over widening salvage machinery — do NOT add a second
   salvage branch without failure-history evidence that leg 1 alone is insufficient.

## Fix direction (when drained — author ACs then)

- Leg 1 (primary, prompt-only): send-to-morty/hardening lifecycle text — the gate confirmation
  is synchronous; never park on a monitor/background event for `test:fast`; if the budget nears,
  commit the verified diff FIRST (the runner's gate recomputation R-WGFR covers verification).
- Leg 2 (observability, one event): emit a breadcrumb on Failed-flip-with-complete-artifacts;
  registry + schema + payload test per the R-WSE-2 co-location discipline.
- Leg 3: explicitly REJECTED for now per subtract-before-add (two escape hatches for one guard).

## Related

- `feedback_worker_transient_failed` (spurious Failed flips class),
  `feedback_commit_uncommitted_verified_work_before_respawn` (the recovery rule applied),
  R-WSDO `worker_produced_nothing` (the sibling breadcrumb this mirrors), R-WSE-2
  `worker_partial_lifecycle_exit` (correctly did not fire — different predicate).
