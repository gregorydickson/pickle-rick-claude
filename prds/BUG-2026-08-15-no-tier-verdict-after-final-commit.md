# BUG: R-NOPOSTTIER — no tier verdict after a bundle's final commit, and a recorded RED gate still reports success

- **Date**: 2026-08-15
- **Priority**: P1 (fake-green)
- **Branch**: `release/v2.1-beta`
- **Measured at**: `45d3081f` (fast tier green: 7647 tests, 504 suites, fail 0, cancelled 0, 835042 ms)
- **Class**: reporting defect. The run's disposition is correct; its VERDICT is not.

## The two defects, and they are separable

### Defect 1 — nothing measures the tree after the final commit

Session `2026-08-15-b88a6603` timeline, from its own state and git:

| when (UTC) | what |
|---|---|
| 12:36:57 | last `between_ticket_gate` recorded (`ok: false`) |
| 14:28:44 | `1bead552` lands — the bundle's LAST commit, which put HEAD red |
| 14:38:11 | `EPIC_COMPLETED / all-tickets-done`, `exit_reason: completed` |

**121 minutes** separate the last recorded gate from epic completion, and **no gate ran in the 9.5
minutes between the reddening commit and the success verdict.** Operator-run clean-env tier at
`1bead552`: 7647 tests, **fail 3**, cancelled 0, EXIT=1 — three failures, one root (a trap-door entry at
1831 chars against the 1500 cap at `extension/tests/trap-door-conformance.test.js:15`).

There IS a post-final-completion call site — `runBetweenTicketFastGate({ nextTicketId: null, ... })` at
`extension/src/bin/mux-runner.ts:8064`, inside `if (curState.current_ticket)` at `:8042`. It did not
produce a verdict in this session: `last_between_ticket_gate.ts` is 121 minutes stale at completion. The
ticket bundle must determine WHY (the guarding `current_ticket` being already null is the leading
hypothesis, not a finding) and make a post-final-commit measurement actually happen.

The structural reason the rest of the pipeline cannot catch this: the between-ticket gate runs BETWEEN
tickets and there is no ticket after the last one; per-ticket conformance is scoped to that ticket's own
diff. **The final commit of every bundle is structurally unmeasured.** The aggravating shape is that the
reddening commit was a DOCS commit from an AUDIT ticket — the class least likely to be suspected.

### Defect 2 — a recorded RED gate does not withhold the success verdict

The same session finished with `last_between_ticket_gate.ok: false` sitting in state AND
`completion_promise: {"kind":"EPIC_COMPLETED","reason":"all-tickets-done"}` AND `exit_reason: "completed"`.
A red gate verdict was on disk and the run still reported unqualified success. Fixing Defect 1 alone
would produce a fresh red verdict that is likewise ignored — so Defect 2 must be fixed too, or the new
measurement is decorative.

This is the governing rule stated exactly: **honesty is a REPORTING property, halting is a DISPOSITION,
and they are not the same wire.** The run SHOULD complete. It MUST NOT claim success it did not measure.

## Solution

1. Ensure a tier measurement runs after the final ticket's commit and before the completion promise is
   synthesized (`extension/src/bin/mux-runner.ts:2184`), recording its verdict in state.
2. Carry that verdict into the completion promise. When the verdict is red or ABSENT, the promise must
   report a degraded completion rather than an unqualified `all-tickets-done` success — the epic still
   completes, the run still exits, no ticket is un-flipped.
3. An absent verdict is NOT a pass. Silence must read as degraded, never as green.

## Acceptance criteria

- **AC-1 — a verdict exists at completion.** On a bundle whose final ticket lands a commit,
  `last_between_ticket_gate.ts` (or the successor field) is NEWER than that final commit's timestamp when
  the completion promise is synthesized. A test drives a run to final completion and asserts the recorded
  verdict post-dates the last commit.
- **AC-2 — red withholds success.** With a red post-final verdict, the completion promise does NOT read
  as unqualified `all-tickets-done` success; it carries the degraded marker and the failing dimension. A
  test asserts the degraded shape.
- **AC-3 — the run still completes.** With that same red verdict: every phase still executes, the epic
  still reaches a terminal state, `exit_reason` is NOT a new abort value, no ticket is demoted, and no
  work is discarded. This AC fails if the fix stops the pipeline.
- **AC-4 — absent is degraded, not green.** If the post-final measurement cannot run (throws, times out,
  toolchain missing), the promise reports degraded, never success. A test forces the throw path — note
  `mux-runner.ts:8073` currently swallows it with `(ignored)`.
- **AC-5 — no new terminal condition, no new operator surface.** No new `exit_reason` string, no new
  abort site, no new setting key, no new flag. A test pins the terminal `exit_reason` set against the
  pre-change set.
- **AC-6 — the regression oracle.** A test reproduces the `b88a6603` shape end-to-end: all tickets Done,
  final commit reddens the tree, and asserts the run completes WITHOUT reporting success. It must go RED
  if either defect is reintroduced.
- **AC-7 — tier green.** `npm run test:fast` reports `fail 0` AND `cancelled 0`, measured with
  `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and a clean environment. `cancelled > 0` is inconclusive:
  re-run, never report as pass. Test count must not shrink below 7647.

## Out of scope

`R-GBANNER` (the gate's failure parser reporting an npm banner as a test name) — this bundle must not
also fix the parser, though its oracle should not DEPEND on the parser being correct. `R-SJLAGMT` and
`R-TIERWEDGE` likewise: if the tier flakes or wedges during this work, that is those tickets, not this
one.

## Simplification Review

1. **What can be subtracted instead of added?** Defect 2 is pure subtraction: stop asserting success that
   was never measured. The success claim is the thing being removed, not a check being added.
2. **Does this add a new abort condition?** No — AC-3 and AC-5 forbid it. The verdict changes what is
   REPORTED, never whether the run continues.
3. **Does this add a new configuration surface?** No — AC-5 forbids it.
4. **Is a fix at this seam load-bearing for anything else?** Yes, decisively. Every bundle's green
   currently requires an operator-run measurement to be believed — that is a human in the loop on every
   single run. This is the fix that makes an unattended green mean something.
