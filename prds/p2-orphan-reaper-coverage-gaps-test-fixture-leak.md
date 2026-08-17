# P2 — Orphan reaper coverage gaps: test-fixture process leak

**Status:** Draft
**Repo:** `pickle-rick-claude`
**Discovered:** 2026-08-17, during a host-level "system pausing / slow" investigation on the dev Mac.

## Summary

42 orphaned processes attributable to this repo's own test suite had accumulated on the
development machine over a 19-day uptime and were never reaped. All 42 were re-parented to
`launchd` (PPID 1), consuming 0.0% CPU, holding roughly 1.7 GB of resident memory on a host
whose swap was 93% full (14.28 GB of 15.36 GB). They were killed manually with `SIGKILL`;
process count dropped from 730 to 691 and swap fell to 13.65 GB.

The irony is load-bearing: the leaked processes are the fixtures belonging to
`orphan-worker-reaper-real-proc.test.js` and `orphan-worker-reaper-tmp-prefix-drain.test.js`.
The orphan reaper's own test suite is the largest producer of unreaped orphans on the host,
and the shipped reaper does not match them.

## Evidence

Leaked population, by family, as observed at 08:53 on 2026-08-17:

| Family | Count | Age range | RSS each |
| --- | --- | --- | --- |
| `node .../extension/tests/fixtures/sigterm-ignoring-sleeper.js` | 13 | 18 min – 23 h | ~40 MB |
| `node $TMPDIR/pickle-spawn-morty-worker-gate-*/bin/npm run test:fast` | 26 | 60 min – 18 h | ~40 MB |
| `$TMPDIR/cxhang-int-bin-*/claude` (fake-claude shim) | 4 | 4 h | ~40 MB |
| orphan `codex app-server-broker` (not this repo) | 3 | 13 h, 11 d, 13 d | ~30 MB |

Every entry had PPID 1, 0.0% CPU, and no children — orphan, inert, and disjoint on all three
axes, so reaping was safe. Separately, one orphaned shell running an infinite
`until …; do sleep 30; git status; done` poll loop had been touching disk every 30 seconds
for 4 days 21 hours.

## Root cause

Two independent defects.

### D1 — Teardown is unreachable when the test process dies abnormally

`orphan-worker-reaper-real-proc.test.js` and `orphan-worker-reaper-tmp-prefix-drain.test.js`
both do escalate to `SIGKILL`, but only from per-test `finally` blocks
(`real-proc.test.js:231-232, 258-259`, `tmp-prefix-drain.test.js:160`). Those blocks run only
if the test process itself survives. When the runner is interrupted — a jest timeout that
kills the worker, a heap OOM, an operator `Ctrl-C`, a pipeline cancel — the `finally` never
executes and the fixture survives by construction: `sigterm-ignoring-sleeper.js` installs a
no-op `SIGTERM` handler and a 1-second keep-alive interval, so nothing short of `SIGKILL`
collects it.

The observed age clustering supports this. Six sleepers share the timestamp `04:08:31` and
six more share `04:07:39`; each cluster is one aborted run leaking its whole cohort at once.

### D2 — The reaper's match rules and trigger points do not cover these processes

`extension/src/services/orphan-reaper.ts` classifies a candidate as reapable when either the
argv resolves to a session directory under the sessions root, or (the WS-1 `tmp_fixture`
class, `orphan-reaper.ts:148-162`) an argv token is a path anchored under `os.tmpdir()` whose
first segment starts with `pickle-`. Against the leaked population:

- The bare `node .../extension/tests/fixtures/sigterm-ignoring-sleeper.js` orphans carry no
  tmpdir path in argv at all. Neither class matches.
- The `cxhang-int-bin-*` and `cxhang-int-sess-*` prefixes do not start with `pickle-`, so
  WS-1 rejects them. `grep -r cxhang extension/src/` returns zero hits — the prefix is
  unknown to production code.
- Only the `pickle-spawn-morty-worker-gate-*` family is matchable in principle.

The trigger surface is also too narrow. The reaper is invoked from exactly three places, all
pipeline-scoped: `setup.ts:1847`, `mux-runner.ts:10401` (runner startup), and
`mux-runner.ts:10911` (iteration start). A developer running `npm test` outside a pipeline
never triggers a sweep, so leaked fixtures accumulate until the next pipeline launch — or,
as here, indefinitely.

## Acceptance criteria

1. `sigterm-ignoring-sleeper.js` writes its PID to a run-scoped registry file at startup, and
   a suite-level `afterAll` (plus a `process.on('exit')` guard) `SIGKILL`s every PID in that
   registry. A test asserts that killing the runner with `SIGKILL` mid-test leaves zero
   surviving fixtures once the next suite run starts.
2. The fixture self-terminates without external help: it exits after a bounded lifetime
   (default 120 s, overridable by env) so an abandoned instance cannot outlive its run. A
   test asserts the fixture exits unaided past that bound.
3. WS-1 recognizes the `cxhang-int-bin-`, `cxhang-int-sess-`, and any other test-owned tmpdir
   prefixes as reapable, and recognizes an argv whose script path resolves under this repo's
   `extension/tests/fixtures/` directory regardless of tmpdir involvement. Unit tests build
   the real argv for each of the three leaked families and assert a match.
4. A standalone sweep entry point exists — a `bin/` command and a `posttest` hook — so the
   reaper runs after any local test invocation, not only at pipeline startup. Running the
   suite, killing it mid-flight, then running it again leaves zero orphans from the first run.
5. The reaper emits a count of what it collected; a sweep that reaps more than zero on a
   developer machine is visible rather than silent.

## Out of scope

The orphaned `codex app-server-broker` processes (11 and 13 days old) belong to the Codex
plugin, not to pickle-rick. Track separately.

## Notes

Manual remediation applied on 2026-08-17 killed all 42 orphans plus the `git status` poll
loop. The host's underlying memory pressure — 89% swap after a 19-day uptime, with a 12.9 GB
`droid` process holding 19% of RAM — is a separate host-hygiene matter and was left alone.
