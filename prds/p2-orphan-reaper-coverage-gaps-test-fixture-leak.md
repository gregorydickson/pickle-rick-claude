# P2 — Orphan reaper coverage gaps: test-fixture process leak

**Status:** Draft — reaper half RESOLVED 2026-08-21 (`04df0897`); producer half OPEN (see Update 2026-08-21)
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

## Re-measured population — 2026-08-19 (operator, unplanted)

The 2026-08-17 census read 0 only because all 42 had been killed by hand. This is a fresh,
naturally-accumulated population on the same host, captured from a full `ps -Ao pid,ppid,etime,pcpu`
dump (never a `ps | grep` pipe, which this box filters to empty):

| pid | ppid | age | cpu |
|---|---|---|---|
| 64349 | 1 | 11:40:22 | 0.0 |
| 29361 | 1 | 10:33:01 | 0.0 |
| 64756 | 1 | 07:59:29 | 0.0 |
| 17517 | 1 | 06:42:58 | 0.0 |
| 30055 | 1 | 04:58:21 | 0.0 |
| 5356 | 1 | 04:00:54 | 0.0 |
| 73217 | 1 | 06:27 | 0.0 |

All seven are `node /private/var/folders/.../T/pickle-spawn-morty-worker-gate-*`, all re-parented to
PPID 1, all at 0.0% CPU. **Pid 73217 was created during the `test:fast` run that produced this
census** — the leak is live and reproduces once per tier run, so the population is self-replenishing
and does not need planting. The count has been observed at 6, then 7, then 7-with-one-replaced across
three checks in a single evening.

Note the family: `pickle-spawn-morty-worker-gate-*`, NOT the
`orphan-worker-reaper-*` fixtures named in the original evidence section. The dominant leaker today is
the worker-gate fixture family, which is what the shipped reaper still does not match.

---

## Update 2026-08-21 — D3 found, reaper half RESOLVED, producer half identified

Two findings from session `2026-08-20-54c74299` change this PRD materially. **D2 above is incomplete
and one of its conclusions is wrong.**

### D3 — the reaper matched NOTHING, including the family D2 calls "matchable in principle"

D2 concludes: *"Only the `pickle-spawn-morty-worker-gate-*` family is matchable in principle."*
Measured, it was not matched in practice either. `isPickleTmpBinNpmPath` and
`resolveTmpPrefixFixturePath` each compared a `ps` argv token against `path.resolve(os.tmpdir())`.
That compare is **LEXICAL** — `path.resolve` does not follow symlinks. On macOS `os.tmpdir()` yields
`/var/folders/…/T` (where `/var` is a symlink to `/private/var`) while a spawned process's argv carries
the realpath form `/private/var/folders/…/T`, so `startsWith` rejected **every** real orphan.

Verified independently with a real leaked orphan's argv:

```
startsWith(path.resolve(os.tmpdir()) + sep)          -> false   <-- the bug
startsWith(realpathSync(os.tmpdir())  + sep)         -> true    <-- the fix
```

Observed live before the fix: **six** alive `pickle-spawn-morty-worker-gate-*` processes, reaper
reporting `scanned=0 reaped=0`. The commit that fixed it records ten alive against `scanned=0`.

**This reframes the whole PRD.** The reaper was not under-scoped — it was **scanning nothing while
reporting success**. A permanent false-green over an unbounded leak. That is why "an empty census is
NOT evidence" was the right instinct for a reason nobody had identified: the empty census *was* the bug.

**RESOLVED by `04df0897`** (anatomy-park, 2026-08-21) — memoized realpath prefixes, both lexical and
resolved roots accepted. **Verified twice on naturally-occurring orphans**, not planted fixtures:

```
[reap-orphans] scanned=1 reaped=1 unverified=0 session_owned=0 tmp_prefix_fixture=1 repo_fixture_path=0
```

This satisfies the PRD's standing demand for a real population. AC-3's tmpdir-prefix arm and AC-5's
count emission are effectively met for the `pickle-` family; the `cxhang-int-*` prefixes and the
repo-fixture-path arm of AC-3 remain open.

### D4 — the PRODUCER: workers background their own tier runs

D1 explains how a fixture survives an abnormal death. It does not explain what kills the parent so
often. Measured this session: **a worker that launches a tier run with `run_in_background` ends its
turn expecting a completion notification that never arrives.** The backgrounded child is killed at the
turn boundary, the worker exits `exit:0` with **zero artifacts and a clean tree**, its gate reds, and
one `npm run test:fast` is left at `PPID 1`.

**One orphan per failed spawn.** Ticket `9b3c4549` burned **five consecutive worker spawns** this way
before an explicit foreground directive unblocked it in a single spawn.

`R-MWBG` already forbids this for `spawn-morty.js` in the manager prompt, but the same rule is **not
enforced on the worker's OWN test invocations** — which are precisely the commands long enough to
tempt backgrounding.

### Additional acceptance criteria

6. **The worker prompt forbids backgrounding its own long commands.** No `run_in_background`, `&`,
   `nohup`, `setsid`, or `disown` for test/tier invocations; every test runs in the FOREGROUND with a
   large explicit timeout. A test asserts the directive is present in the worker template, in the same
   shape `R-MWBG` is pinned for the manager path.
7. **A stalled ticket is diagnosable in one read.** When a ticket produces repeated `exit:0` +
   `validation: failed` + clean tree, the newest `worker_session_*.log` names the cause. Assert that a
   backgrounded-then-cut test run leaves an attributable line rather than silence.
8. **The reaper's realpath handling is pinned.** A unit test builds an argv in the `/private/var/...`
   realpath form and asserts a match, so D3 cannot regress. (Add alongside the `04df0897` trap door.)

### Status change

- **Reaper half: DONE** (`04df0897`, verified twice on real orphans).
- **Producer half: OPEN** — AC-6/AC-7 above are the next bundle.
- AC-1, AC-2 (fixture registry + self-termination) and the `cxhang-int-*` arm of AC-3: still open.

Related memories: `orphan-reaper-blind-to-own-leak` (population),
`worker-backgrounded-test-run-stalls-ticket` (producer).
