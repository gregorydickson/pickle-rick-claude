# BUG (P0): the post-final measurement makes `test:fast` wedge — a nested tier run inside `mux-runner.test.js`

- **Date**: 2026-08-16
- **Priority**: P0 — blocks ALL tier measurement, so nothing on this branch can be verified
- **Branch**: `release/v2.1-beta`
- **Introduced by**: the R-NOPOSTTIER bundle, session `2026-08-15-29b48a40` (`6106dec5`, `d1135adf`)
- **Class**: self-inflicted hang. The fix for unmeasured completions made completions unmeasurable.

## Evidence

`runPostFinalMeasurement` (`extension/src/bin/mux-runner.ts:851`) runs a REAL fast-tier measurement and is
wired at **both** promise-synthesis seams — `extension/src/bin/mux-runner.ts:959` (manager-token) and
`extension/src/bin/mux-runner.ts:2432`. There is **no test-mode guard** on either call. The
`PICKLE_TEST_MODE` checks at `:5370` and `:5630` belong to R-WSRC-4 and do not cover this path.

`extension/tests/mux-runner.test.js` spawns the real mux-runner binary and drives it to completion. With
the new wiring, reaching the completion seam inside that test starts a nested `npm run test:fast` — an
~800 s run spawned from inside a running tier. The tier never returns.

Measured, three runs, stall detector at 8 minutes of zero log growth:

| tree | result | wedge point |
|---|---|---|
| `5dba30c5` (pre-bundle) | **completed**, fail 0 | — |
| `e57bac7a` (post-bundle) | WEDGED | 6126 lines |
| `e57bac7a` (post-bundle) | WEDGED | 6126 lines, byte-identical tail |
| `c688f9ab` (post-fix, ticket `4a25e6ca`) | **completed** — 7707 tests, 507 suites, pass 7704, fail 0, cancelled 0, skipped 2, todo 1, 1442185 ms, `EXIT=0` | none — walked through the old wedge point; `mux-runner: exits with code 1 and prints Usage when no args provided` PASSES at line 6132 and the run reaches 14089 lines |

**The `5899` retraction is itself RETRACTED (operator, 2026-08-16). The floor stands at `7647`.**
`5899` was never a tier count — it is the number of top-level `✔` lines a throwaway operator diff script
scraped while locating the wedge, an artifact of that regex, not a measurement. The authoritative summary
block at `5dba30c5` reads `tests 7647 / suites 504 / pass 7644`, and `c56e1cfb` reads `tests 7647` as
well. Adopting `5899` would have lowered the floor by ~1750 tests and let a genuine shrink pass unnoticed.
The `c688f9ab` run (7707) clears the real floor, so nothing shipped wrong — but the lesson is the sharper
one: **a floor must come from the runner's own summary block, never from a number quoted in prose.**

### Residuals at `c688f9ab` (AC-1b)

Failing residuals: **none** (`fail 0`, `cancelled 0`). The three non-passing entries are pre-existing
and match the standing `skipped 2 / todo 1` baseline recorded at `c56e1cfb`, `390049c8` and `5dba30c5`:

- SKIP — `runWorkerGate: retries once when npm run test:fast fails and the second attempt passes`
  (`extension/tests/spawn-morty-worker-gate.test.js`)
- SKIP — `runWorkerGate: skips test:fast when SKIP_WORKER_TEST_GATE=1 and logs the skip marker`
  (`extension/tests/spawn-morty-worker-gate.test.js`)
- TODO — `stop-hook state matrix: Section D expansion cells (xfail placeholder)`
  (`extension/tests/stop-hook-state-matrix.test.js:152`)

### Attribution verdict (AC-0): the nested-tier hypothesis is FALSIFIED

The causal story above — that reaching the completion seam inside `extension/tests/mux-runner.test.js`
starts a nested real `npm run test:fast` — does not survive reading the seams. Both
`runBetweenTicketFastGate` (`extension/src/bin/mux-runner.ts:708`) and `runPostFinalMeasurement`
(`:941`) return early unless `<working_dir>/extension` exists, and that `existsSync` guard PREDATES
this bundle (`e57bac7a`); every working dir in `mux-runner.test.js` is a bare `mkdtempSync` with no
`extension/` child. The runner spawns in that file already carried `timeout: 150000 / 30000 / 60000`
(`:84`, `:109`, `:120`, `:282`, `:2414`, `:2513`, `:2630`), which contradicts an unbounded 8-minute
hang. So the nested tier could not have fired from that test file even at the wedged tree.

The wedge at `e57bac7a` was real and twice-reproduced, but its cause lies in the `mux-runner:` suite's
own binary spawns and it is intermittent — the already-filed `R-TIERWEDGE` shape (0-CPU park under a
plain operator tier, cleared by re-running). Recorded as correlation rather than proof: `c35d1af6` /
`c1c37490` short-circuited the post-final tier measurement under `PICKLE_TEST_MODE` at both seams, and
`c688f9ab` bounded the two unbounded `execFileSync` callsites named below. One completed run refutes
the stated mechanism; it cannot by itself distinguish "fixed" from "did not recur".

Deterministic: same line count twice. Process census at the wedge — runner `bin/test-runner.js` at
`0:00.10` CPU unchanged across a 20 s sample, child unchanged at `0:02.36`, grandchild parked. Nothing is
working; it is waiting.

Suite-coverage diff between the completed run and a wedged run: the wedged run logged **2886 tests vs
5899**, and the **3011 missing tests begin exactly at the `mux-runner:` suite** (`mux-runner: exits with
code 1 and prints Usage when no args provided`, …). The tier stops on the one suite that spawns the
binary the bundle modified.

## Secondary defect, same bundle

Two subprocess callsites were added with **no `timeout`**, which this repo forbids per-callsite:

- `extension/tests/pipeline-finalize-honesty.test.js:251` — `execFileSync('git', args, { cwd, encoding: 'utf-8' })`
- `extension/tests/nostop-gates-phase-loop.test.js:54` — same shape

`bash scripts/audit-subprocess-heavy-tests.sh` exits **0** on both. The audit only flags timeouts inside a
duration band; it is **blind to a MISSING timeout**. So the guard that exists for exactly this class did
not fire. Whether or not these two callsites contribute to the wedge, they are unbounded waits in the
tier and the audit gap is real.

## Solution

1. The post-final measurement must not run a real tier from inside a test-spawned runner. Inject the
   measurement function at both seams (the bundle's own new tests already inject a fake runner — do the
   same here), or guard the call so a test-mode runner uses an injected stub. Prefer injection: it is the
   pattern already established by `post-final-verdict-oracle.test.js`.
2. Add `timeout` to both `execFileSync` callsites above.
3. Extend `scripts/audit-subprocess-heavy-tests.sh` to fail on a subprocess callsite in `extension/tests/`
   with NO `timeout` option, not merely one whose timeout sits in the wrong band.

## Acceptance criteria

- **AC-1 — the tier completes.** `npm run test:fast` runs to a summary block with `fail 0` AND
  `cancelled 0`, measured with `PICKLE_TEST_RUNNER_TIMEOUT_MS=7200000` and a clean environment. Test count
  must not shrink below 7647. This AC is the whole point: a wedged run is a FAILURE of this ticket, not an
  inconclusive result.
- **AC-2 — no nested tier run.** A test asserts that driving the runner to its completion seam under test
  conditions does NOT invoke a real `npm run test:fast`; the measurement is injected. Assert on the
  injected function being called, not on wall time.
- **AC-3 — the production behavior is preserved.** R-NOPOSTTIER still holds: a real completion still
  measures, still records the verdict, and still withholds success on a degraded verdict. The oracle
  `extension/tests/post-final-verdict-oracle.test.js` and `extension/tests/pipeline-finalize-honesty.test.js`
  stay green. This ticket must NOT be resolved by reverting the R-NOPOSTTIER fix.
- **AC-4 — both callsites bounded.** No `execFileSync` / `spawnSync` / `spawn` in `extension/tests/`
  without an explicit `timeout`. The two named callsites carry one.
- **AC-5 — the audit catches the class.** `scripts/audit-subprocess-heavy-tests.sh` FAILS on a fixture
  with a missing-timeout subprocess callsite, and passes once a timeout is added. A test drives the audit
  against such a fixture — it must go red if the check is removed.
- **AC-6 — no new terminal condition, no new operator surface.** No new `exit_reason`, no new abort site,
  no new setting key, no new flag.

## Out of scope

`R-SJLAGMT` (float-`mtimeMs` flake) and `R-GBANNER` (banner parsed as a test name). Do not fix either
here.

## Simplification Review

1. **What can be subtracted instead of added?** The unconditional real-tier call is the subtraction
   target: the seam should take its measurement as a dependency rather than reaching for the tier itself.
   That is fewer things the seam knows about, not more.
2. **Does this add a new abort condition?** No — AC-6 forbids it.
3. **Does this add a new configuration surface?** No — AC-6 forbids it. Injection is a code seam, not a
   flag.
4. **Is a fix at this seam load-bearing for anything else?** Yes — while the tier wedges, NOTHING on this
   branch can be verified, including the R-NOPOSTTIER bundle that caused it. This is the gate on every
   other verdict.
