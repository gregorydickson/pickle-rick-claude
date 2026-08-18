# BUG-2026-08-14 — the advisory-residual re-route left four consumers on the old sink

**Status:** ready to launch
**Priority:** P1 (reliability — the fast tier is RED at HEAD)
**Branch:** release/v2.1-beta
**Launch commit:** `9a7cbdaf` — tier is RED with exactly the four failures this bundle owns

---

## Problem

The fast tier is red at HEAD: **7616 tests, 7609 pass, fail 4, cancelled 0**. All four are stale
consumers of a sink that moved.

Ticket `119acf6a` (commit `40e07bde`, "route advisory worker-gate residual to the jsonl sink metrics
reads") deliberately moved the advisory worker-gate residual out of `state.json.activity` and into
the jsonl activity sink. It shipped `extension/tests/advisory-residual-sink.test.js` proving the new
behavior. It did not update the four pre-existing tests that assert the residual lands in the OLD
sink, and they now fail:

| test | file |
|---|---|
| `setup --resume: a REAL orphaned commit is still ff-reattached and flipped Done` | `extension/tests/setup.test.js` |
| `setup --resume: a TARGET-repo RED is advisory — reattached, flipped Done, residual recorded` | `extension/tests/setup.test.js` |
| `AC-1 site: mux-runner.ts attemptRecoveryBeforeTerminal.runArmedGate — an unrunnable gate` | `extension/tests/worker-gate-not-run-invariant.test.js` |
| `AC-3: a not_run verdict flips Done and emits a residual naming the ticket and reason` | `extension/tests/worker-gate-not-run-invariant.test.js` |

Isolated repro:

```
AssertionError [ERR_ASSERTION]: an advisory Done flip must leave a residual
    actual: undefined,   expected: true
```

The stale reads are direct: `setup.test.js:1932` parses `state.json` and takes `.activity`;
`worker-gate-not-run-invariant.test.js:94` returns `state.activity`. Neither looks at the jsonl sink
the producer now writes.

## The re-route is correct — this is fix-forward, not a revert

`/pickle-metrics` reads `getDataRoot()/activity/*.jsonl`. The W5c skip-flag scanner **ignores**
`state.json.activity` — this is already documented and already enforced elsewhere: the
`pipeline-runner.ts` `gate_skipped` trap door requires that event to be emitted via `logActivity` to
the activity-dir jsonl and explicitly forbids the `sm.update` / `s.activity = [...]` form, naming it
"the state.json sink the W5c skip-flag scanner ignores".

So a residual written to `state.json.activity` is invisible to the dashboard that exists to read it.
`40e07bde` moved the producer to the right sink. The four tests are pinning the defect the re-route
removed. **Do not revert `40e07bde`; migrate the assertions.**

## Why it shipped red

`c916b3da`'s three worker gates all reported `__timeout__` (600000 ms and 1800000 ms alike) and all
three were absorbed by `failed_flip_suppressed`, so the tier never reached a verdict on any ticket in
that bundle. The bundle whose purpose was making the success verdict stop being blind to tests was
itself shipped without a test verdict.

Root cause of the timeouts is a separate, already-authored bundle:
`prds/BUG-2026-08-14-concurrent-workers-per-session.md` (`9a7cbdaf`). This PRD does not fix that and
must not try to — it only returns the tier to green so that bundle can launch onto solid ground.

## Simplification Review

**1. Is the addition necessary at all?**
It adds nothing. This is pure consumer migration: four assertions move from reading one sink to
reading the other. No new guard, flag, state field, or code path.

**2. Can it REUSE instead of ADD?**
Yes — mandatory. `extension/tests/advisory-residual-sink.test.js` already contains the correct
jsonl-sink read (resolve `getDataRoot()/activity/<local-day>.jsonl`, parse lines, find the event).
The four migrated assertions MUST reuse that same read shape rather than each hand-rolling a jsonl
parse. If the implementation writes a fourth variant of "find today's jsonl", the reuse question was
answered wrong; extract one shared helper and have all consumers call it.

**3. Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?**
No new guard. There is a real subtraction available (see Q4): the split-sink ambiguity itself is what
let a producer move without its consumers noticing.

**4. What can this issue SUBTRACT?**
The duplicated jsonl-read logic — collapse to one helper as part of Q2. Second, worth recording
rather than building here: nothing structurally prevents the next producer/consumer sink split. A
follow-on candidate is a test-level assertion that the two sinks are not both read for the same event
name, but that is new machinery and is explicitly deferred, not silently dropped.

## Scope

**In:** migrating the four stale assertions to the jsonl sink and collapsing the read to one shared
helper. Tests only.

**Out:**
- Any change to `40e07bde`'s producer or to `extension/src/`. If a ticket finds itself editing
  runtime source, the diagnosis was wrong and it should stop and report rather than proceed.
- The worker-concurrency root cause.
- The eight-failures-under-contaminated-env issue (its own ticket, recorded in the concurrent-workers
  PRD).

## Acceptance criteria

Measurements use `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and a clean env
(`env -u PICKLE_TICKET_ID -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_COUNT
-u GIT_CONFIG_KEY_0 -u GIT_CONFIG_VALUE_0`) on a quiet box.

- **AC-1 — the tier is green.** Full `npm run test:fast` reports `fail 0` AND `cancelled 0`. A run
  with `cancelled > 0` is inconclusive and must be re-run, not reported as a pass.
- **AC-2 — no test count shrinks.** `tests` >= 7616 and `suites` >= 504. Deleting or skipping a
  failing assertion is a failed AC, not a fix.
- **AC-3 — the old sink is gone from these four.** In `extension/tests/setup.test.js` and
  `extension/tests/worker-gate-not-run-invariant.test.js`, no residual assertion reads
  `state.json`'s `.activity`; each reads the jsonl sink.
- **AC-4 — one shared jsonl read.** The jsonl-sink read exists in exactly one place and all consumers
  (including `extension/tests/advisory-residual-sink.test.js`) call it. Assert the helper has >= 3
  call sites and that no test hand-rolls a second `activity/<day>.jsonl` path join.
- **AC-5 — the assertions still bite.** Mutation check: with the producer's jsonl emission removed,
  each migrated assertion goes RED. A migrated test that passes against a missing residual is
  asserting nothing — this is the AC that distinguishes a fix from a rubber stamp.
- **AC-6 — runtime source is untouched.** `git diff --name-only <launch-sha>..HEAD` contains no path
  under `extension/src/`.

## Risks

- **The four tests may be asserting more than the sink.** If one fails for a second, unrelated reason
  after migration, report it as a distinct finding rather than adjusting the assertion until it
  passes. AC-5 is the guard against fixing by weakening.
- **This bundle will be built by the buggy runtime.** Its own workers may overlap and its gates may
  false-timeout exactly as `c916b3da`'s did. That is expected and is why AC-1 is verified by an
  operator-run tier measurement after the bundle lands, not by the bundle's own gate verdict.

## References

- `extension/tests/setup.test.js:1932` — stale `state.json.activity` read
- `extension/tests/worker-gate-not-run-invariant.test.js:94` — stale `state.activity` read
- `extension/tests/advisory-residual-sink.test.js` — the correct jsonl-sink read, and the reuse target
- `40e07bde` — the producer re-route this bundle completes
- `extension/CLAUDE.md` — `pipeline-runner.ts` W5c `gate_skipped` trap door: jsonl sink, never
  `state.json.activity`
- `prds/BUG-2026-08-14-concurrent-workers-per-session.md` — why the gate did not catch this
