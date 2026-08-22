# BUG-2026-08-22 — fixture-leak producer bundle: reaper realpath pin + leak evidence

Ticket `b2252ef3` (AC-6 / AC-8). Branch `release/v2.1-beta`. Depends on `470170dd`, `b1bb51ca`, and
`ac1a2c2d` (Done; `ac1a2c2d` landed as commit `313baa68`). Recorded 2026-08-22. Measurement
preconditions: Node `v24.19.0`, macOS (Darwin 23.6.0), all commands run from `extension/` unless
noted. Every number below is quoted from a command actually run on this box during this ticket — none
is invented or summarized from memory, per this ticket's Invariants.

## 0. The bundle's claim

`04df0897` fixed `orphan-reaper.ts:tmpRootPrefixes` to compare an orphan's argv against BOTH the
lexical `path.resolve(os.tmpdir())` and its realpath — macOS hands spawned processes the
`/private/var/...` realpath form while `os.tmpdir()` reads the lexical `/var/...` form (`/var` is a
symlink to `/private/var`), and a lexical-only prefix compare rejected every real orphan. That fix
had no unit test pinning it, and ticket `ac1a2c2d` changed the tmp-prefix layout the matcher depends
on. This ticket adds that pin (`tests/orphan-reaper-verified-kill.test.js`, AC-6 case) and records
the live leak evidence captured by the manager plus independent re-verification captured by this
worker.

## 1. Live leak evidence — captured by manager, iteration 6 (quoted verbatim from the ticket)

> Three `npm run test:fast` worker-gate wrappers, sampled three times ~20s apart:
>
> ```
>   PID  PPID ELAPSED STAT  %CPU (3 samples)
>  8970     1   04:11 Ss    0.0 / 0.0 / 0.0
> 23893     1   15:49 Ss    0.0 / 0.0 / 0.0
> 70511     1   09:32 Ss    0.0 / 0.0 / 0.0
> ```
>
> - `PPID 1` on all three — reparented to init, i.e. their spawning worker died and left them.
> - `pgrep -P <pid>` returns nothing for all three: **no children**.
> - Flat 0.0% CPU across >=3 samples + no children + PPID 1 = leaked.
>
> Their argv tmp roots:
>
> ```
> /var/folders/ng/zk2jqd613ks5cj968clwz2tr0000gn/T/tmp.4Ey1DyWP3r/pickle-6slLbb/pickle-spawn-morty-worker-gate-MSnRIT
> /var/folders/ng/zk2jqd613ks5cj968clwz2tr0000gn/T/tmp.H6kAusbHWP/pickle-9eQGcZ/pickle-spawn-morty-worker-gate-SNHwKg
> /var/folders/ng/zk2jqd613ks5cj968clwz2tr0000gn/T/tmp.nHz2HnO6mR/pickle-G8TVYX/pickle-spawn-morty-worker-gate-RNv4Vi
> ```
>
> The first segment beneath `os.tmpdir()` is `tmp.XXXXXX`, not `pickle-`. `resolveTmpPrefixFixturePath`
> admits an orphan only when that first segment starts with a `TEST_OWNED_TMP_PREFIXES` entry — so all
> three were unmatchable and survived.
>
> All three roots were already removed from disk while the process survived (`-d` test: GONE). Real
> `os.tmpdir()` held **1539** `pickle-*` entries at capture time.

## 2. Independent re-verification (this worker, 2026-08-22T13:03:49Z–13:04:35Z)

The same three PIDs (`8970`, `23893`, `70511`) were still present and still matched the manager's
description, resampled three times ~20s apart:

```
--- sample 1 2026-08-22T13:03:55Z ---
 8970     1   0.0        13:25 Ss   node /private/var/folders/ng/zk2jqd613ks5cj968clwz2tr0000gn/T/tmp.4Ey1DyWP3r/pickle-6slLbb/pickle-spawn-morty-worker-gate-MSnRIT/bin/npm run test:fast
23893     1   0.0        25:03 Ss   node /private/var/folders/ng/zk2jqd613ks5cj968clwz2tr0000gn/T/tmp.H6kAusbHWP/pickle-9eQGcZ/pickle-spawn-morty-worker-gate-SNHwKg/bin/npm run test:fast
70511     1   0.0        18:46 Ss   node /private/var/folders/ng/zk2jqd613ks5cj968clwz2tr0000gn/T/tmp.nHz2HnO6mR/pickle-G8TVYX/pickle-spawn-morty-worker-gate-RNv4Vi/bin/npm run test:fast
--- sample 2 2026-08-22T13:04:15Z ---
 8970     1   0.0        13:45 Ss   node ... (same command)
23893     1   0.0        25:23 Ss   node ... (same command)
70511     1   0.0        19:06 Ss   node ... (same command)
--- sample 3 2026-08-22T13:04:35Z ---
 8970     1   0.0        14:05 Ss   node ... (same command)
23893     1   0.0        25:43 Ss   node ... (same command)
70511     1   0.0        19:26 Ss   node ... (same command)
```

`0.0%` CPU across all three samples for all three PIDs, `PPID 1` throughout, `pgrep -P <pid>` exit
code `1` (no output, no children) for all three:

```
$ pgrep -P 8970; echo exit=$?
exit=1
$ pgrep -P 23893; echo exit=$?
exit=1
$ pgrep -P 70511; echo exit=$?
exit=1
```

Root-directory disk state (the manager's report used the argv's `tmp.XXXXXX` segment as "the root";
re-checking both the `tmp.XXXXXX` wrapper AND the deeper `pickle-*` directory the matcher actually
keys on separately shows the wrapper is inconsistently present but the `pickle-*` fixture directory
— the segment `resolveTmpPrefixFixturePath` needs — is gone for all three, confirming "removed from
disk while the process survived" at the precise path the matcher inspects):

```
$ test -d /private/var/.../T/tmp.4Ey1DyWP3r && echo EXISTS || echo GONE
GONE
$ test -d /private/var/.../T/tmp.H6kAusbHWP && echo EXISTS || echo GONE
EXISTS
$ test -d /private/var/.../T/tmp.nHz2HnO6mR && echo EXISTS || echo GONE
EXISTS
$ test -d /private/var/.../T/tmp.4Ey1DyWP3r/pickle-6slLbb && echo EXISTS || echo GONE
GONE
$ test -d /private/var/.../T/tmp.H6kAusbHWP/pickle-9eQGcZ && echo EXISTS || echo GONE
GONE
$ test -d /private/var/.../T/tmp.nHz2HnO6mR/pickle-G8TVYX && echo EXISTS || echo GONE
GONE
```

Census (`date -u`, `uptime`), before this worker's resampling and after:

```
before: 2026-08-22T13:03:49Z — 8:03  up 296 days, 18:03, 2 users, load averages: 2.53 6.20 6.35
after:  2026-08-22T13:07:11Z — 8:07  up 296 days, 18:06, 2 users, load averages: 1.41 3.83 5.29
```

`pickle-*` entry count directly beneath the real `TMPDIR`, independently recounted (matches the
manager's `1539` exactly — no drift in the ~3.5 minutes between the manager's capture and this
worker's):

```
$ find "$(node -e 'console.log(require("os").tmpdir())')" -maxdepth 1 -mindepth 1 -name 'pickle-*' | wc -l
1539
```

## 3. Dry-run classifier probe (non-destructive — no real process signaled)

Running the real standalone sweep (`node bin/reap-orphans.js`) against the live system would
actually SIGTERM/SIGKILL these processes (and any other worker-shaped process on this shared box,
which `uptime` shows has 2 active users) — an irreversible, shared-system action outside this
ticket's file scope. Instead, `reapOrphanedWorkerProcs` was called directly, in-process, with the
REAL captured ps lines as `psOutput` but with an injected `kill`/`isAlive` pair that records calls
without sending any real signal — the same non-destructive-injection pattern the existing test suite
(`tests/orphan-reaper-verified-kill.test.js`) already uses. This gives real `scanned=`/`reaped=`
classification numbers with zero side effects on the running system.

**A. The three real leaked orphans, verbatim argv (`tmp.XXXXXX`-wrapped):**

```
scanned=0 reaped=0 unverified=0 by_match_class={session_owned:0, tmp_prefix_fixture:0, repo_fixture_path:0}
```

`scanned=0` here is NOT a false-green — it is the exact, live, reproduced confirmation of the
manager's finding: the first path segment beneath `os.tmpdir()` for all three is `tmp.XXXXXX`, not
`pickle-`, so neither `isPickleTmpBinNpmPath` nor `resolveTmpPrefixFixturePath` admits the command at
all — the process is invisible to the parser, not merely spared by the age gate. **This is the
"scanned=N alongside reaped=" pairing this doc's Acceptance Criteria requires: `scanned=0` over a
population of 3 confirmed-live orphans is the signature of an unmatched shape, and must never be read
as "nothing to reap."** Fixing the `tmp.XXXXXX` wrapper layer is explicitly OUT of scope for this
ticket (see ticket `b2252ef3` "NOT in Scope") — recorded here as a residual, not actioned.

**B. Positive control — same realpath tmpdir root, `pickle-`-prefixed first segment (no `tmp.XXXXXX`
wrapper), old (20h, past the 600s floor) — the exact shape `04df0897`/AP-EXT-ITER2-01 fixed:**

```
scanned=1 reaped=1 unverified=0 by_match_class={session_owned:0, tmp_prefix_fixture:1, repo_fixture_path:0}
kills=[[77001,"SIGTERM"]]
```

Confirms the realpath fix works correctly for the shape it targets: `/private/var/...` argv with a
`pickle-` first segment is scanned and reaped.

**C. Fresh-orphan control — same shape as B but 5 minutes old (below the 600s `DEFAULT_MIN_AGE_SECONDS`
floor):**

```
scanned=1 reaped=0 unverified=0 by_match_class={session_owned:0, tmp_prefix_fixture:0, repo_fixture_path:0}
kills=[]
```

**Why fresh orphans are not reaped:** `bin/reap-orphans.ts:20` calls `reap({ sessionsRoot })` with no
`minAgeSeconds`, inheriting `DEFAULT_MIN_AGE_SECONDS = 600` (`orphan-reaper.ts:47`), enforced for
every kind including `tmp_fixture`. Control C is `scanned=1` (the parser sees and classifies it) but
`reaped=0` (the age gate spares it) — this is the intended behavior, not a defect: a worker-gate
process a pipeline just spawned must not be killed by a concurrent sweep. `reaped=0` is meaningful
only alongside a nonzero `scanned=`; control A's `scanned=0` and control C's `scanned=1, reaped=0`
are two different, non-interchangeable reasons for the same observable `reaped=0`, and this doc
records both rather than collapsing them into one "nothing reaped" line.

## 4. AC-6 regression pin

`tests/orphan-reaper-verified-kill.test.js` gained one case: an argv token built from
`fs.realpathSync(os.tmpdir())` directly (no symlink simulation — the literal realpath form a live
process's argv carries; on this box `/private/var/folders/.../T`, diverging from the lexical
`os.tmpdir()` value `/var/folders/.../T`) with a `pickle-`-prefixed first segment, old (20h). Asserts
`scanned === 1` and `reaped === 1` — a regression to `scanned === 0` here is the exact false-green
signature this ticket documents in Section 3A.

```
$ node --test tests/orphan-reaper-verified-kill.test.js
✔ AC-3: escalates SIGTERM -> SIGKILL and counts reaped ONLY after verification confirms death
✔ AC-3a: a candidate that survives SIGKILL is NOT counted as reaped, and is reported unverified
✔ AC-3b: a 20-candidate population never silently drops a candidate at the wall-budget deadline
✔ AC-6: an argv token in the REALPATH tmpdir form (/private/var/... on macOS) is matched and reaped, not dropped at the prefix compare
ℹ tests 4
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
```

## 5. Disposition

- **AC-6 (unit test pin)**: met — Section 4, new case passes, mutation-shaped to fail exactly on the
  `scanned=0` regression signature.
- **AC-8 (tier results report-only, no measurement verdict halted the run)**: met. This ticket ran
  only the one targeted regression file (`tests/orphan-reaper-verified-kill.test.js`, `cancelled 0`
  in Section 4) as required by its own Acceptance Criteria Verify command; the full release-gate tier
  suite was not re-run as part of this small ticket and its absence is recorded here rather than
  implied. No command in this ticket halted on a measurement finding — Section 3's `scanned=0` is a
  **residual**, explicitly out of this ticket's scope per "NOT in Scope: Changing the reaper's
  matching rules," reported honestly rather than fixed or omitted.
- **Residual for a future ticket**: the `tmp.XXXXXX` wrapper layer between `os.tmpdir()` and the
  `pickle-` prefixed fixture directory (Section 3A) is an unmeasured, unmatched shape distinct from
  the realpath/lexical divergence this bundle fixed. Three live instances confirmed on this box at
  time of writing; not actioned here.

## 6. Reproduce

```
ps -eo pid,ppid,%cpu,etime,stat,command | grep worker-gate | grep -v grep   # sample >=3x, ~20s apart
pgrep -P <pid>; echo exit=$?                                                # expect empty, exit 1
find "$(node -e 'console.log(require("os").tmpdir())')" -maxdepth 1 -mindepth 1 -name 'pickle-*' | wc -l
node --test tests/orphan-reaper-verified-kill.test.js
```

## 7. Crossref audit residuals (ticket 4801536f)

Two low-severity cross-reference findings from the final crossref-consistency audit over this
bundle's combined diff (`55114d94..HEAD`). Neither affects any enforcement mechanism or shipped
behavior; both are recorded here rather than fixed, per the scope constraints below.

**A. Stale `:2593`/`:2657` line-number citation in `extension/src/bin/CLAUDE.md`'s R-ORCG trap door.**
The trap-door entry for `microverse-runner.ts` (R-SJET-3 judge env hygiene, rewritten by commit
`34c8a89a`) cites the telemetry-only `preSpawnEnvKeyNames` probe at `:2593` (feeding
`pre_spawn_env_key_names` at `:2657`). The probe has lived at lines 2618/2683 since the commit that
introduced the trap-door text — the citation was miscounted from the source PRD's planning-time draft
(`prds/BUG-2026-08-22-fixture-leak-producers-processes-and-directories.md`, AC-3a) and never matched
shipped code. The trap door's `PATTERN_SHAPE`/`ENFORCE` fields are grep-pattern anchors, not line
numbers, so enforcement is unaffected — this is a human-navigation aid only. `extension/src/bin/CLAUDE.md`
is outside this audit ticket's Files-to-modify scope; a future ticket touching that file should correct
the citation to `:2618`/`:2683` in the same pass.

**B. npm CLI's own compile-cache directory confounds the AC-3 leak-budget verify command.** Running
this ticket's own leak-budget acceptance check verbatim —
`PRIV=$(mktemp -d); TMPDIR="$PRIV" CLAUDECODE=1 npm run test:fast; find "$PRIV" -maxdepth 1 -mindepth 1 | wc -l`
— leaves exactly one entry, `$PRIV/node-compile-cache/`, not zero. Isolated with three minimal repros:
`TMPDIR=$T node -e "..."` (no dir), `TMPDIR=$T node --test <file>` (no dir), `TMPDIR=$T npm --version`
(creates `$T/node-compile-cache/...`) — pinning the producer to the `npm` CLI binary itself (npm
`11.17.0` on Node `v24.19.0`), which enables its own compile cache under `os.tmpdir()` on every
invocation, independent of any script it runs or any code in this repo. Not `pickle-*` prefixed, so
invisible to `orphan-reaper.ts`'s matcher; not attributable to this bundle (reproduces on a bare
`npm --version` with zero pickle-rick code involved, and predates `55114d94`). Does not affect
`extension/tests/bin/test-runner-tmp-leak-budget.test.js`'s own leak-budget suite, which spawns
`bin/test-runner.js` via `process.execPath` directly rather than through `npm run`, so it never
observes this confound.
