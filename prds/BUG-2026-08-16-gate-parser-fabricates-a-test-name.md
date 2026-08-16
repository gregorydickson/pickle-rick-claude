# BUG: the gate failure parser fabricates a test name from the npm banner — and it now falsely degrades runs

- **Date**: 2026-08-16
- **Priority**: P1 — it corrupts the input to the post-final honesty verdict shipped in R-NOPOSTTIER
- **Branch**: `release/v2.1-beta`
- **Measured at**: `b43ed958` (fast tier green: 7720 tests, 507 suites, fail 0, cancelled 0, 855250 ms)

## Root cause (exact, verified in source)

`parseBetweenTicketFastGateFailures` (`extension/src/bin/mux-runner.ts:601`) walks the gate output for
`^not ok ... - <name>` lines. When the run dies in `pretest:fast` — `audit-test-tiers.sh &&
audit-test-isolation.sh` — it fails BEFORE emitting any TAP, so zero failures parse and the function
falls through to `extension/src/bin/mux-runner.ts:635`:

```js
const fallback = lines.map(line => line.trim()).find(Boolean) ?? 'npm run test:fast failed';
return [{ name: fallback, file: '' }];
```

The first non-empty line of npm's output is always its own lifecycle banner, so the fabricated failure is
verbatim `> pickle-rick-scripts@2.1.0-beta.9 pretest:fast` with `file: ''`. The real diagnostic — which
audit failed and why — is discarded.

## Why this is now P1 rather than cosmetic

Three consumers read that fabricated name, and the third is new:

1. `last_between_ticket_gate.failures` — the manager's fix list. A worker dispatched against this name is
   sent to fix a test that does not exist.
2. `cross_ticket_regression_detected` — observed attributing it to `prior_ticket_id: 70a67ccb`, a ticket
   that had already shipped clean (session `2026-08-14-0807d986`).
3. **`post_final_verdict`** — the R-NOPOSTTIER honesty verdict. Session `2026-08-16-791e6dd0`, the FIRST
   run ever judged by it, recorded:
   `{"state":"red","degraded":true,"dimensions":["> pickle-rick-scripts@2.1.0-beta.9 pretest:fast"]}`
   and logged `post-final tier measurement: red (degraded)`. The first post-final verdict in the
   product's history was a FALSE degradation caused by this parser.

Sightings across three independent sessions: `2026-08-14-0807d986`, `2026-08-15-b88a6603`,
`2026-08-16-791e6dd0`. Systematic, not a one-off.

**The underlying red is usually real but transient** — the audits react to mid-flight worker files and
pass on demand minutes later. The defect is that the failure is reported as a nonexistent test instead of
as a script failure, so nobody can act on it and the honesty wire inherits a lie.

## Solution

When zero TAP failures parse, attribute the failure to the SCRIPT, not to a fabricated test.

- Emit a failure whose name states the phase that actually failed (the `pretest:fast` / `test:fast`
  script) and carries the useful tail of stderr/stdout as its message, rather than the banner line.
- Never emit a failure whose `name` matches the npm lifecycle banner shape `^> \S+@\S+ \S+$`.
- An empty `file` plus a banner-shaped name is the current tell; the replacement must be
  distinguishable from a real TAP failure by consumers.

## Acceptance criteria

- **AC-1 — no banner-shaped test names.** Given gate output whose only content is an npm lifecycle banner
  plus a failing audit, `parseBetweenTicketFastGateFailures` returns a failure whose `name` does NOT match
  `^> \S+@\S+ \S+$`. A unit test drives the exact observed output and pins the result.
- **AC-2 — the real diagnostic survives.** The returned failure carries the audit's actual error text
  (the failing audit script name and its message), not just a generic string. Assert the audit name
  appears.
- **AC-3 — a script failure is distinguishable from a test failure.** Consumers can tell the two apart —
  by an explicit field, a naming convention, or an empty-vs-populated `file` contract that is asserted.
  State the chosen contract in the ticket.
- **AC-4 — real TAP failures are unchanged.** Given output with genuine `not ok` lines, the parser returns
  exactly what it returns today, including `location:` file normalization. A regression pin covers this.
- **AC-5 — the honesty verdict stops lying.** A test drives the post-final verdict path with a
  script-only failure and asserts the recorded `post_final_verdict.dimensions` names the script failure,
  never a banner line. This is the AC that connects the fix to the damage.
- **AC-6 — tier green.** `npm run test:fast` reports `fail 0` AND `cancelled 0`, measured with
  `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and a clean environment. `cancelled > 0` is inconclusive:
  re-run. Test count must not shrink below 7720, read from the runner's own summary block.
- **AC-7 — no new terminal condition, no new operator surface.** No new `exit_reason`, no new abort site,
  no new setting key, no new flag. A script failure must still park-and-continue exactly as today.

## Out of scope

Making `pretest:fast` itself stop failing transiently on mid-flight worker files — that is a separate
question and this bundle must not chase it. The intermittent tier hang at the `mux-runner` suite
(`prds/BUG-2026-08-16-tier-hangs-at-mux-runner-suite.md`) is also separate.

## Simplification Review

1. **What can be subtracted instead of added?** The fallback's "first non-empty line" heuristic is the
   thing to delete. It guesses a test name from arbitrary output; removing the guess and reporting the
   script failure plainly is strictly less machinery.
2. **Does this add a new abort condition?** No — AC-7 forbids it. The gate still parks and continues; only
   the label changes.
3. **Does this add a new configuration surface?** No — AC-7 forbids it.
4. **Is a fix at this seam load-bearing for anything else?** Yes. R-NOPOSTTIER's verdict is only as honest
   as its inputs, and this parser is its input. A false red here makes the honesty machinery cry wolf,
   which is how a real degradation gets ignored later.
