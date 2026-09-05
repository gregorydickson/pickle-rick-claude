# B-FRESHWIN — a progress window that can exclude the artifact it is measuring, plus two verified P1 roots

---
title: "B-FRESHWIN — the mtime-vs-window race that makes CI a coin flip, session-log emptiness as evidence, and the last abort-channel residual"
status: draft
priority: P1
type: bug-bundle
composes: [AP-EXT-ITER41-02-intermittent, B-LOGEV, B-ONEABORT-residual]
---

## Trigger — CI on this branch is non-deterministic, and one test is why

Two consecutive CI runs, on trees whose ONLY difference is a markdown edit to `prds/MASTER_PLAN.md`:

| run | head | flake budget |
|---|---|---|
| `33947849271` | `a8ef0566` | `OK failures=1 budget=2 runs_completed=5` ✅ |
| `33949406204` | `1ebbe54c` (doc-only) | `FAIL_BUDGET_EXCEEDED failures=3 budget=2 runs_completed=4` ❌ |

Same code. `AP-EXT-ITER41-02: a ticket landing a lifecycle phase every relaunch is never
force-terminated` failed runs 1, 2 and 4 and passed run 3. Its rate straddles the budget of 2, so
**every release gate is a coin flip.** It was introduced by `493c4b2a` (2026-09-02, the B-CIGREEN4
anatomy-park pass) — it does NOT predate that, and it is NOT the fast-tier flake class B-CIGREEN3
closed. Do not re-open that class; this is a new instance with a different mechanism.

## Root A — a freshness window that can exclude the very artifact it measures

`extension/tests/mux-runner.test.js` `driveBoundedEscapePasses` captures `iterationStartMs =
Date.now()` and only THEN writes the lifecycle artifact, and `recordBoundedEscapeAttempt` decides
"progress" by that artifact's mtime against the window. When the recorded mtime does not strictly
exceed `iterationStartMs` — coarse mtime granularity, truncation, or a same-millisecond write — the
artifact reads as stale, no progress is seen, the charge lands, and the ticket is force-terminated at
the cap. The assertion then fails with `escapedAt` non-null.

**This bundle must decide, by measurement, WHICH side owns the race — and the answer changes the
fix.** If `recordBoundedEscapeAttempt` in `src/bin/mux-runner.ts` compares a strict `>` against a
caller-supplied epoch, the same race exists in PRODUCTION: a real worker that lands an artifact inside
the same clock tick is charged with no-progress, and `bounded_terminal_escape` salvages a productive
ticket — the exact defect `AP-EXT-ITER41-02` was written to prevent, arriving through its own
detector. Do not "fix" this by loosening the test's assertion or by sleeping in the fixture; a sleep
hides a production race behind a slower test.

## Root B — session-log emptiness is treated as evidence (VERIFIED INTACT 2026-09-05)

`prds/p1-b-logev-session-log-emptiness-is-not-evidence.md`. Re-measured against HEAD `a8ef0566`:
`classifyWorkerSessionLogs` is live at `src/bin/mux-runner.ts:10616`, still returning a
`SilentDeathSubClass` off `sessionLogSize`, so a 0-byte log still maps to `log_empty` and feeds the
`worker_produced_nothing` breadcrumb and the `worker_silent_death` route. On the ONE clean hands-off
run ever recorded, 35 of 43 logs were 0 bytes (81%) while 11 of 15 tickets held a FULL lifecycle
artifact set. **An empty log is an absence of measurement, not evidence of an absent worker** — the
same `failed`-vs-`empty` collapse this codebase names as its dominant defect class.

Note for whoever scopes this: the presence of a `log_empty` state reads at a glance like a fix and is
the opposite. `log_empty` IS the mechanism under indictment.

## Root C — the last abort-channel residual

`prds/p1-b-oneabort-one-termination-policy-across-both-channels.md`. Surface B closed 2026-09-01
(FR-B1): the inline `judge_timeout || all_judge_backends_exhausted ||
baseline_unmeasurable_transient` triple at `pipeline-runner.ts` collapsed to one derived term. The
residual is the remaining abort conditions. **Verify-first before scoping** — this row has been
re-counted wrong twice (6 → 9 → 10 depending on whether you probe the bare predicate or the shipped
entry point through `migrateLegacyBaselineExitReason`). Re-derive the count from the shipped entry
point and state it, rather than trusting any number in the plan.

## Acceptance criteria (machine-checkable)

- **AC-1** The owner of the race is NAMED by measurement, with the probe shown: production detector or
  test fixture. If production, the fix is in `src/bin/mux-runner.ts` and a regression pin drives the
  detector directly with an artifact whose mtime equals the window start.
- **AC-2** `AP-EXT-ITER41-02` and both its controls pass **5 consecutive `test:fast:budget` runs**
  (`runs_completed=5 runs_requested=5`), not one green run. A single pass does not falsify an
  intermittent — this is the acceptance the bug's own nature demands.
- **AC-3** Neither control is greened by weakening it: the sterile ticket must still escape at the cap
  (AC-A4 preserved), and the omitted-window arm must still charge.
- **AC-4** No `sleep`, no wall-clock padding, and no widened assertion tolerance anywhere in the fix.
  Mutation-verify: restoring the pre-fix comparison reddens the pin.
- **AC-5** B-LOGEV: an empty worker session log is no longer sufficient on its own to produce
  `worker_produced_nothing` or `worker_silent_death`. Artifact presence is consulted, and the
  three states (`measured` / `empty` / `failed`) are distinguishable at the call site. Negative
  control: a genuinely dead worker with NO artifacts still classifies as silent death.
- **AC-6** B-ONEABORT: the abort-condition count is re-derived from the shipped entry point, stated as
  a number with the probe that produced it, and reduced. No new abort condition is added.
- **AC-7** Closer: full release gate green, with `test:fast:budget` reporting
  `runs_completed=5 runs_requested=5`, plus a `ci-repro.sh --runner-release 24.04` run naming the sha
  (docker is UP on this host; if it exits 2 record the OS axis UNRUN, never green).

## Explicit non-goals

- Do NOT raise the flake budget above 2 to make this pass. That converts a measurable defect into a
  standing permission to read red as green.
- Do NOT quarantine or skip `AP-EXT-ITER41-02`. It is pinning a real autonomy defect.
- Do NOT re-open the B-CIGREEN3 fast-tier flake class; it is closed and this is a different mechanism.

## Ticket classes

1. Root A: measure the race owner, fix it, pin it (behavioural).
2. Root A: the 5-run stability evidence + mutation verification (evidence).
3. Root B: B-LOGEV artifact-corroborated classification + negative control (behavioural).
4. Root C: B-ONEABORT residual, re-derived count and reduction (behavioural).
5. Closer: full gate + ci-repro evidence naming the sha.
