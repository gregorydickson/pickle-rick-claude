# BUG-2026-08-19 — tier evidence at the bundle's final sha

Ticket `29077ab4` (verification). Branch `release/v2.1-beta`, final sha `8c4c5b8a`.
Recorded 2026-08-20. Baseline for comparison: `08415a3e`, the pre-bundle HEAD named in the PRD.

Every count below is quoted verbatim from a captured runner summary block. Where a PRD acceptance
criterion is not met, the failure is recorded with its attribution rather than restated as a pass.

## 0. Provenance — why this was measured by hand

The bundle's original session `2026-08-19-f048dbc4` was paused for a machine reboot (see `RESUME.md`)
and its `SESSION_ROOT` does not exist on this host — the run was started on a different machine. There
was no session state to `--resume`. Ticket `96444430`'s in-flight correction was not lost: it landed as
`8c4c5b8a`. Only `29077ab4` (this verification ticket) remained, so the tiers were run directly.

## 1. Census — the box was idle before each measurement

`ps -Ao pid,ppid,etime,pcpu,command` dumped to a FILE (per `RESUME.md`: `ps | grep` is filtered to
empty on this box). Zero `pickle-spawn-morty-worker-gate` orphans, zero mux-runner, zero spawn-morty,
zero foreign jest. Load average 1.47-2.20 at launch.

## 2. Environment correction — ripgrep was absent

The first fast-tier attempt emitted hundreds of:

```
# scope-resolver import walk: rg fail status=null signal=null error=ENOENT
```

`rg` on this host existed only as a **shell function** from the Claude Code shell snapshot, which is
invisible to `spawnSync` from Node. Installed ripgrep 15.2.0 via Homebrew and verified the failing
layer directly:

```
node -e "spawnSync('rg',['--version'])"  ->  error: none  status: 0  ripgrep 15.2.0
```

The partially-completed run made under the fallback was **discarded**, not reported: a tier measured
while the environment changed mid-run is not evidence. The re-run shows `rg ENOENT lines: 0`.

## 3. Tier results at `8c4c5b8a`

### fast (`node bin/test-runner.js --tier fast --test-concurrency=8`)

```
# tests 7766
# suites 508
# pass 7707
# fail 15
# cancelled 38
# skipped 5
# duration_ms 257164.144958
```

### integration:parallel

```
# tests 628
# suites 21
# pass 607
# fail 14
# cancelled 7
# skipped 0
# duration_ms 16261.260959
```

### integration:serial

```
# tests 603
# suites 24
# pass 594
# fail 3
# cancelled 6
# skipped 0
# duration_ms 461358.419667
```

### expensive (`RUN_EXPENSIVE_TESTS=1 npm run test:expensive`)

parallel:

```
# tests 14
# suites 1
# pass 13
# fail 0
# cancelled 0
# skipped 1
# duration_ms 15393.063542
```

serial:

```
# tests 8
# suites 0
# pass 4
# fail 3
# cancelled 0
# skipped 1
# duration_ms 19845.381708
```

All three serial failures are `tests/integration/codegraph-real-index.test.js` (C0 contract surface,
empty-repo fixture, R-CGBOOT bootstrap). `@colbymchenry/codegraph@0.9.9` resolves on this host, so these
are real defects, not a missing optional dependency.

### deploy-lifecycle soak — the tier does NOT soak by default

`npm run test:expensive` completed in **35 seconds**, because its headline test skipped itself:

```
ok 7 - deploy-lifecycle soak: package.json version remains stable # SKIP refuses to mutate $HOME settings.json — set PICKLE_INSTALL_ROOT to non-$HOME path or set CI=true
```

The release gate's most expensive assertion is therefore a **no-op on any developer machine where
`PICKLE_INSTALL_ROOT` is unset and `CI` is not set** — the tier reports green in under a minute without
having soaked anything. This is a gate gap, independent of the code failures above.

Re-run under an isolated prefix, the soak passes on a genuine 30-minute run:

```
PICKLE_INSTALL_ROOT=<scratch>/soak-prefix/pickle-rick SOAK_SECONDS=1800 \
  node --test tests/integration/deploy-lifecycle-soak.test.js

# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# duration_ms 1804401.836792
```

`duration_ms 1804401` = 30.07 minutes of real soak.

## 4. AC disposition

| AC | Requirement | Result |
|---|---|---|
| AC-1/2/3 | park-and-continue, refuse Done-flip, shared classification | met — `0383103d` |
| AC-4/5 | tests pin park-not-halt and leave the gate-verdict sibling fail-closed | met — `fa88b4e1`, `021201f0` |
| AC-6 | no remaining path ends the phase loop on this reason | met — all four `recordExitReason(...'done_without_commit_evidence')` sites `continue` / return `{kind:'continue'}` / `{action:'leave'}` |
| AC-7 | no new `exit_reason`, no new abort condition | met — reason is not a member of the `ExitReason` union |
| AC-8 | `audit-subprocess-heavy-tests.sh` exits 0 | met — and all nine audit scripts pass |
| AC-9 | fast: `fail 0` / `cancelled 0`, tests >= 7737, suites >= 508 | **counts met (7766 / 508); cleanliness NOT met (15 fail / 38 cancelled)** |
| AC-10 | integration:parallel: `fail 0` / `cancelled 0`, tests >= 622, suites >= 21 | **counts met (628 / 21); cleanliness NOT met (14 fail / 7 cancelled)** |

## 5. Attribution — the red predates the bundle

AC-9 and AC-10 demand `fail 0 / cancelled 0`. That bar was **not satisfiable at this bundle's own
baseline**. Each affected suite was re-run in a throwaway worktree at `08415a3e` (the pre-bundle HEAD
the PRD itself names). Results are identical, failure for failure:

| Suite | `08415a3e` (pre-bundle) | `8c4c5b8a` (final) |
|---|---|---|
| `tests/monitor.test.js` | 0 fail / 20 cancelled | 0 fail / 20 cancelled |
| `tests/codegraph-service.test.js` | 0 fail / 18 cancelled | 0 fail / 18 cancelled |
| `tests/services/convergence-gate.test.js` | 2 fail | 2 fail |
| `tests/test-registration-hygiene.test.js` | 1 fail | 1 fail |
| `tests/install-bun-probe.test.js` | 1 fail | 1 fail |
| `tests/worker-timeout-preserves-commit.test.js` | 2 fail | 2 fail |
| `tests/integration/judge-measurement-async.test.js` | 0 fail / 7 cancelled | 0 fail / 7 cancelled |
| `tests/runner-authored-trailer.test.js` | 3 fail | 3 fail |
| `tests/spawn-morty-commit-attribution.test.js` | 2 fail | 2 fail |
| `tests/boundary-commit-at-iteration.test.js` | 2 fail | 2 fail |
| `tests/integration/extension-wiring.test.js` | 2 fail | 2 fail |
| `tests/mux-runner-fix-b.test.js` (M1) | 1 fail | 1 fail |
| `tests/bin/test-runner-tier-discovery.test.js` | 1 fail | 1 fail |

The bundle's diff touches `extension/src/bin/mux-runner.ts` only. The single mux-runner suite among the
failures (`mux-runner-fix-b.test.js`, M1) fails identically at the pre-bundle sha, so it is not
attributable to this bundle either.

**Disposition: the bundle's thesis holds and its own ACs pass; the success verdict is WITHHELD because
the branch is red on grounds this bundle neither caused nor claims to fix.** That is AC-2's rule applied
to the bundle itself — ran to completion, degradation reported honestly, no auto-release.

## 6. Root cause isolated in the pre-existing red

`src/bin/test-runner.ts:319-322`:

```ts
if (dryRun) {
  if (selectedFiles.length > 0) process.stdout.write(`${selectedFiles.join('\n')}\n`);
  process.exit(0);
}
```

`process.stdout.write()` is asynchronous when stdout is a **pipe**; `process.exit(0)` on the next line
discards whatever has not flushed. Every programmatic consumer of `--dry-run` therefore receives exactly
8192 bytes — the first ~200 of 660 fast-tier files — with `status=0` and no error. Measured:

```
tier=fast status=0 err=none lines=203 stdoutBytes=8192 last=t
tier=integration status=0 err=none lines=155 stdoutBytes=8192 last=tests/mux-silent-worker-exit
```

Note both truncations land mid-filename. Interactively stdout is a TTY (synchronous), so the same
command prints all 660 lines — which is why this hid. This explains the two hygiene-test failures
(`test-registration-hygiene`, `test-quality-hygiene`), which read tier membership through `--dry-run`
and conclude ~400 files are unregistered. It is also a live footgun beyond the tests, since `--dry-run`
is the tier-discovery interface.

Ruled out as the cause: ripgrep. `test-registration-hygiene` fails identically with and without
`/opt/homebrew/bin` on `PATH`.

The remaining pre-existing failures are NOT diagnosed here and are not this bundle's scope.
