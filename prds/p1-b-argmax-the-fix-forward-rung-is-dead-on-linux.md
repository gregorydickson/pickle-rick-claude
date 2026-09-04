# B-ARGMAX — the fix-forward remediation rung cannot spawn a worker on Linux, and says nothing when it fails

---
title: "B-ARGMAX — a >128KiB single argv string makes every fixer-worker spawn E2BIG on Linux, reported as a clean 'not remediated'"
status: draft
priority: P1
type: bug-bundle
composes: [AP-EXT-ITER146-01-linux, R-REMEDSILENT]
---

## Trigger

`v2.1.0-beta.25` (`39ffdcf5`) CI is RED, and unlike the beta.24 red this one is **caused by the bundle
in flight**. Two tests added by `aa74e37e` (in-bundle; `git merge-base --is-ancestor aa74e37e ec691ef7`
is false) fail **deterministically on Linux and pass on macOS**:

```
FAIL_BUDGET_EXCEEDED failures=3 budget=2 runs_completed=3 runs_requested=5
REPEATED ACROSS RUNS:
  - AP-EXT-ITER146-01: the fix-forward rung drives a fixer worker over the authored brief
  - AP-EXT-ITER146-01 control: a fixer worker that FAILS is not a completed remediation
```

Same two tests in all three runs, same assertion (`a fixer worker must actually be invoked`). This is
not the flake class — do NOT re-open that; `runs_completed=3` is the budget bailing out early, not
three different outcomes.

## Root cause — MEASURED in a local Linux repro, not inferred

`ci-repro.sh --runner-release 24.04` reproduces it exactly (`exit=1`, the same two tests, the same
assertion), so the whole diagnosis below is a measurement on Ubuntu 24.04 / node 22.23.2.

**Linux caps a SINGLE argv string at `MAX_ARG_STRLEN` = 32 pages = 131072 bytes. macOS has no
per-argument cap.** Measured threshold in the CI image, spawning a recording shim by bare name:

| single argv string | status | error | exec'd? |
|---|---|---|---|
| 100000 B | 0 | none | yes |
| 131000 B | 0 | none | yes |
| **131072 B** | null | **E2BIG** | **no** |
| 268854 B | null | E2BIG | no |

`spawnRecoveryRemediatorWorker` (`src/bin/mux-runner.ts`) passes the whole remediation brief as ONE
argv element: `buildClaudeManagerInvocation` emits `args.push('-p', opts.prompt)`. The brief embeds
`loadTrapDoorSection`, which is **`extension/CLAUDE.md` verbatim — 268854 bytes**, over the cap by
137782 bytes. So the exec never happens on Linux and the marker file is never written.

Ruled out by measurement, so do not re-derive: brief-prep is NOT the cause (`spawn-gate-remediator.js`
returns `STATUS=0` with a valid `BRIEF_PATH=` on Linux); PATH/shim resolution is NOT the cause (the
same shim spawned by bare name `claude` runs fine on Linux, `status=0`).

## This is a PRODUCTION defect, not a test defect

The tests are correct and must stay. On any Linux host the fix-forward rung **cannot ever spawn its
fixer worker** — every gate remediation silently does nothing and reports a clean "not remediated".
CI runs Linux. Production hosts run Linux. This has never worked there.

## Root 2 — the failure is structurally unobservable (why nobody knew)

Two seams turn a crashed spawn into a routine decision, and they are the reason the CI log could not
say why:

- `spawnRecoveryRemediatorWorker` ends `return r.status === 0;`. On E2BIG `r.status` is **null** and
  `r.error.code` is `E2BIG`. The function discards `r.error`, discards `r.stderr`, and logs NOTHING —
  so "the kernel refused to exec" and "the worker ran and failed" are the same value.
- `spawnRecoveryRemediator`'s `if (r.status !== 0) return false;` likewise drops the child's stderr
  with no log line, while the sibling no-brief branch DOES log.

This is the codebase's dominant defect class (`failed` vs `empty` vs `measured` collapsed to one
state) sitting in the observability path of the thing that broke.

## Acceptance criteria (machine-checkable)

Per the B-CIGREEN rule, a ticket may NOT close on "passes locally" — a macOS pass is no evidence about
Linux. State which acceptance you claim. `ci-repro.sh` is available on this host (docker server 29.0.1)
and its noise baseline for this file measured **0** (the harness reproduced exactly the 2 CI failures
and nothing else), so (c) is admissible here.

- **AC-1** No argv element handed to a backend spawn exceeds 131072 bytes, for any brief size. The
  brief must reach the worker by a mechanism that is not a single argv string (stdin or a file the
  prompt references are both acceptable; pick ONE and state why). A unit test constructs a >131072-byte
  brief and asserts the chosen mechanism, mutation-verified by restoring the `-p <brief>` form.
- **AC-2** `AP-EXT-ITER146-01` and its FAILS-control pass under
  `ci-repro.sh --runner-release 24.04 --cmd 'node bin/test-runner.js tests/worker-produced-everything-but-commit.test.js --test-concurrency=1'`,
  naming the sha tested. The third control (`no brief means no worker`) still passes — it must not be
  greened by making every path spawn.
- **AC-3** A spawn that never exec'd is distinguishable from a worker that ran and failed. `r.error`
  (code included) and a non-empty `r.stderr` are logged at BOTH seams above; `r.status === null` is not
  reported as a completed non-remediation. Negative control: a worker that genuinely exits 1 still
  reports not-remediated, and does NOT report a spawn failure.
- **AC-4** The `r.status !== 0` branch in `spawnRecoveryRemediator` logs the child's stderr, matching
  the sibling no-brief branch that already logs.
- **AC-5** Trap-door entry recording the invariant: no unbounded caller-supplied content in a single
  argv element, with a PATTERN_SHAPE that greps as a real sweep (per the CLAUDE.md rule that a
  PATTERN_SHAPE must be runnable), plus the NOT-matches it deliberately exempts.
- **AC-6** Sweep the sibling spawn sites for the same shape and state the result as a COUNT, not a
  claim: every `-p`/prompt-bearing invocation builder in `services/backend-spawn.ts`
  (`buildClaudeWorkerInvocation`, `buildClaudeManagerInvocation`, codex/hermes/deepseek/grok/kimi/gemini)
  is either fixed or recorded as inert with the reason. `spawnConvergedPlanImplementPass` shares the
  spawn shape and is explicitly in scope for this sweep.

## Explicit non-goals

- Do NOT shrink `extension/CLAUDE.md` to get under the cap. That is the enumerated-set fix — it buys
  one release and schedules the next bypass at the next catalog entry.
- Do NOT delete or weaken the two failing tests. They are measuring a real production break.
- Do NOT move CI off Node 22 (standing B-CIGREEN non-goal).

## Ticket classes

1. The argv-size fix at the invocation seam + AC-1 pin (behavioural).
2. The two observability seams, AC-3 + AC-4, with the negative control (behavioural).
3. The sibling sweep AC-6 + the AC-5 trap door (audit + catalog).
4. Closer: `ci-repro.sh` evidence run naming the sha, and the full release gate.
