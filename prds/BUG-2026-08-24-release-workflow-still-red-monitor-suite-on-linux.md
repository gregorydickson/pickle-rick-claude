> **✅ SHIPPED 2026-08-25 as v2.1.0-beta.16 — CLOSED.** Pipeline ran 4/4 phases in 541m53s,
> both tickets Done, 25 commits, session `2026-08-24-3df8dfe4`.
>
> **The fix went in at the production contract, not the test.** `monitor.ts` `writeWithWatchdog` now
> keeps its timer ref'd during in-flight writes (`3b2c0205`), satisfying AC-8′ — the contract at
> `monitor.ts:1063-1074` that a wedged pane surfaces as a rejected promise and `exit 2`.
>
> **NOT a clean run, and the release notes say so.** Three phases withheld their success verdict:
> pickle `done_over_red_worker_gate_tests` + `post_final_tier_degraded:red`, anatomy-park
> `anatomy_non_convergent` (8 passes, no clean pass), szechuan `stalled_below_target` (1 vs target 0).
> Each is the no-stop-gate refusing a LOCAL claim and continuing — the PRIME DIRECTIVE working.
>
> **Anatomy-park closed seven trap doors**, four of them one class walked to its edges (absence of
> measurement read as clean measurement). One was self-inflicted by this bundle: iteration 5's own fix
> added an untimed `execFileSync`, reddening `pretest:integration` and leaving **1272 integration
> assertions unmeasured for three iterations**. The loop caught and fixed it.

> **⛔ CORRECTION 2: THE STREAK IS ~147, NOT 13/14 — off by ~11x and four months.**
>
> Operator-measured over 200 runs: **151 failures, 48 successes, last success `2026-04-22`**
> (`v1.44.4`, *"fix(runners): auto-create 4-pane tmux monitor window"*). Every prior figure in this
> PRD and in the session log — "12 of 12", "13th consecutive", "14th consecutive" — came from
> `gh run list --limit 12`. **One page read as the whole history: a truncated enumeration reported as
> a complete one.** Same defect class as the bundle shipped hours earlier to prevent it.
>
> **This reframes the work.** It is not "fix a five-week regression". It is **end a four-month,
> unknown-depth stack of independent causes**, which matches the observed peel: beta.14 fixed the
> corepack provisioning gap and the run advanced to a *different* wall. Expect more layers. AC-6′ is a
> milestone, not a completion promise.
>
> ## Refinement findings that change the fix (all measured)
>
> - **The `.unref()` is the isolated cause, experimentally proven.** A `/tmp` copy of
>   `writeWithWatchdog` with the unref behind a flag: **Node 22 → `cancelled 2` with it, `pass 2`
>   without it; Node 24 passes either way.** Cause isolated *and* fix pre-verified.
> - **THE DEFECT IS MIS-CLASSIFIED — this is a live PRODUCTION bug, not CI hygiene.**
>   `monitor.ts:1063-1074` states a production contract: a wedged pane must surface as a rejected
>   promise and `process.exit(2)` — *"kill -9 should never be required"*. The `.unref()` at
>   `monitor.ts:101-103` **actively defeats that contract**. `monitor.test.js:746` is faithfully
>   reproducing a real wedge-escape defect. **No AC below states or verifies that production
>   requirement**, so a fix satisfying every AC can leave the actual bug in place. **AC-8′ added.**
> - **AC-2′ hides a genuine requirements conflict the worker must not be left to invent.** The unref
>   exists so the process can exit; the test requires the timer to fire. When the watchdog is the only
>   handle, both cannot hold. **The PRD must rule, not the worker.**
> - **AC-5′ cited a path that does not exist** — it is `extension/tests/QUARANTINE.md`, not
>   `tests/QUARANTINE.md`. And it guards only ONE dodge: **`convergence_gate.known_flake_files` is a
>   second, equally empty-and-wired escape** and is now equally forbidden.
> - **The anti-fake-green AC contained a fake-green trap.** Node 22 (TAP) prints `# cancelled`; Node 24
>   (spec) prints `ℹ cancelled`. A grep written for `^#` **goes vacuously green on Node 24**. Every
>   summary grep in this bundle must match `^[ℹ#]`.
> - **AC-6′ is far cheaper than assumed — no tag burning needed.** `ci.yml` runs a **byte-identical**
>   gate command (md5 match) and triggers on `push:` to `release/**`, the branch we are on; 8 such runs
>   already exist. Use it as the CI proof loop.
> - **CI dies inside `npm run test:fast:budget`** with `FAIL_BUDGET_EXCEEDED failures=3 budget=2`.
>   That budget counts *failing runs*, so **no single ticket can turn CI green** — the monitor fix and
>   the R-MWBG fix are **conjunctive** for AC-6′.
>
> - **AC-8′ (NEW, binding).** State and verify the production contract: a wedged pane surfaces as a
>   rejected promise and `process.exit(2)`, with `kill -9` never required. A green `cancelled 0` that
>   leaves this unverified does **not** satisfy this bundle.

> **✅ BOTH MANDATORY PRE-LAUNCH CHECKS PASSED — 2026-08-25 at HEAD `be12e4fb`.**
>
> **Stale premise: PASSED, with fresh evidence rather than the filing's own.** `release.yml` run
> `32795387967` (v2.1.0-beta.15) is the **14th consecutive failure**, same step, `Create release`
> skipped, and its failing set is **identical** to beta.14's. The mechanism is reproducible locally in
> **9.6 s**: `node@22 --test tests/monitor.test.js` → `tests 74 / pass 54 / fail 0 / cancelled 20`.
>
> **Green tree: PASSED, baseline recorded.** `npm run test:fast` under node **24** (the gate's own
> interpreter), from `extension/`: **pass 7984 / fail 1 / cancelled 0**. The one failure is the
> inherited `install-bun-probe` P3. Recorded as inherited; any OTHER fast-tier failure during this
> bundle is caused by this bundle.
>
> **⚠️ Note the two-interpreter split, and do not conflate them.** The gate baseline above is node 24
> and shows `cancelled 0`. The bundle's target — the 20 cancellations — is only visible under node 22.
> **Both numbers are real; they answer different questions.** AC-1′ is measured under node 22; the
> ship gate is measured under node 24. Reporting one as the other is the defect this bundle exists in
> the shadow of.

> **⛔ THIS PRD'S BANNER IS FALSIFIED. Refined 2026-08-25; the corrections are binding.**
>
> **RETRACTED: "the failures are Linux-only and this host is darwin, so the verification loop is CI
> itself — a green local tier proves nothing."** All three analysts refuted it by running the
> measurement, and the operator re-verified at HEAD:
>
> ```
> /opt/homebrew/opt/node@22/bin/node --test tests/monitor.test.js
> # tests 74 · pass 54 · fail 0 · cancelled 20        ← 9.6 seconds, on THIS darwin host
> ```
>
> **Node 22 is already installed here** — `v22.23.2` (`/opt/homebrew/opt/node@22/bin/node`) and
> `v22.12.0` (`/usr/local/bin/node`). **The axis is the Node version, not the platform.** The author
> only ever ran node 24 (per the standing "pin node 24" precondition) and concluded from its absence
> that the failures were platform-specific. They reproduce locally in **ten seconds**.
>
> **Cost of the error:** the PRD instructed the bundle to budget for ~20-minute tag-push CI round trips
> as its verification loop. The real loop is a 9.6-second local command. Verify locally under Node 22;
> use CI only for the final AC-1 proof.
>
> **⚠️ NEW — the defect class is baked into the REPORTER.** node:test prints **`# fail 0`** on the same
> summary as **`# cancelled 20`**. A gate, a script, or a human reading `fail` as the health signal sees
> zero failures while twenty tests never ran. **No AC in this bundle may use `fail` alone as evidence;
> `cancelled` must be read and reported alongside it.**
>
> **⚠️ NEW — `tests/QUARANTINE.md` is a sanctioned dodge that beats every proposed guard.** It is wired
> (`scripts/audit-quarantine.sh` + 3 tests), currently empty, and permits audit-green entries. Quarantining
> the 20 cancelled tests would clear AC-1 with **zero product change** and pass every anti-fake-green
> check. **Forbidden by AC-5 below.**
>
> **Still current (re-verified):** `release.yml` run `32795387967` for v2.1.0-beta.15 is the **14th
> consecutive failure**, dying at `Install and compile` with `Create release` skipped, and the failing
> set is **identical** to beta.14's — `R-MDS-3`, `R-MDS-4`, `monitor CLI`, `renderDashboard`,
> `writeWithWatchdog`, `R-MWBG`.
>
> ## Binding ACs (supersede those below)
>
> - **AC-1′** `monitor.test.js` under **Node 22** reports **`cancelled 0`** with pass-count not reduced.
>   Verified by the 10-second local command; report the full `tests/pass/fail/cancelled` line. Then, and
>   only then, prove it in CI.
> - **AC-2′** The fix targets `extension/src/bin/monitor.ts` — **product code**, the deliberately
>   `.unref()`'d watchdog timer — not the test file. The cascade origin is `monitor.test.js:746`,
>   `failureType: 'cancelledByParent'`.
> - **AC-3′** `R-MWBG: send-to-morty.md deployed copy matches the repo copy` is a **deploy-parity**
>   assertion CI structurally cannot satisfy. Skip it in CI with a stated reason, or give it a
>   CI-satisfiable form. **Do not delete the assertion.**
> - **AC-4′ (no `fail`-only evidence).** Every measurement in this bundle reports `cancelled` alongside
>   `fail`. Any claim resting on `fail 0` while `cancelled > 0` is void.
> - **AC-5′ (quarantine forbidden).** No entry may be added to `tests/QUARANTINE.md` to satisfy any AC
>   here. If the fix is genuinely impossible, say so and stop — do not quarantine.
> - **AC-6′** A `release.yml` run reaches **`Create release`**. Evidence is a run URL and conclusion.
> - **AC-7′ (PRIME DIRECTIVE)** No new halt path, no new `exit_reason`.

> **✅ BOTH MANDATORY PRE-LAUNCH CHECKS PASSED — 2026-08-24 at HEAD `f0c95353`.**
>
> **Stale premise: PASSED (mechanism, not R-code).** The `.unref()`'d watchdog timer this PRD targets
> is live: `extension/src/bin/monitor.ts:101-103` (`(timer as { unref: () => void }).unref()`), and the
> deployed `~/.claude/pickle-rick/extension/bin/monitor.js` carries 4 `unref()` occurrences. The CI
> failure is CURRENT, not historical: run `32738408865` is the **latest** `release.yml` run and its
> conclusion is `failure`.
>
> **Green tree: PASSED, baseline recorded.** `npm run test:fast`, node 24.19.0 pinned:
> **518 suites / pass 7961 / fail 1 / cancelled 0 / 175.1s**. The one failure is the inherited
> `install-bun-probe` P3. Recorded as inherited.
>
> **⚠️ The darwin baseline above is NOT evidence about this bug.** Every failure this PRD targets is
> Linux-only; the local tier passes them. That asymmetry is the whole point — and reading a local pass
> as evidence is the exact error that produced this PRD. See AC-4.

# BUG-2026-08-24 (P1) — `release.yml` still red: `monitor.test.js` DOES fail on Linux

- **Priority**: P1 — the release workflow has now failed **13 consecutive times** (2026-07-18 → 2026-08-24).
- **Status**: Open. Found by the operator verifying `v2.1.0-beta.14`'s own binding criterion.
- **Type**: bug

## What happened

`v2.1.0-beta.14` (the Node-pin bundle) set itself a binding success criterion — **AC-2: a `release.yml`
run reaches `Create release`**. It did not. Run
[32738408865](https://github.com/gregorydickson/pickle-rick-claude/actions/runs/32738408865)
failed at `Install and compile`; `Build tarball` and `Create release` were **skipped**, exactly as on
the previous twelve.

**The bundle is not a no-op — it moved the frontier, and that is measurable:**

| | before (run 32689967189) | after (run 32738408865) |
|---|---|---|
| `Enable corepack` step | did not exist | **success** (new, from `b554cc7b`) |
| `rebuild failure latches immediately` | FAIL | **gone** |
| `every phase degraded ⇒ non-zero exit…` | FAIL | **gone** |
| `runGate: flake-listed failure…` | FAIL | **gone** |
| failing suite | codegraph-service, oneabort, convergence-gate | **monitor.test.js + R-MWBG** |

All three previously-named Linux failures are fixed. The provisioning gap is closed. The run simply
gets further and hits a **different** wall.

## The refuted premise — and it was MINE

The `v2.1.0-beta.14` refinement concluded, and I recorded in the refined PRD as a §1 ruling, that
**`monitor.test.js` "does not appear in the Linux failure set at all"** — and on that basis the darwin
Node-22 cancellations were deferred out of scope and re-filed as
`BUG-2026-08-24-darwin-node22-monitor-cancellations.md`.

**That is now measured false.** The current Linux failure set is dominated by exactly that suite:
`R-MDS-3 AC-1..4`, `R-MDS-4 AC-1..7`, `monitor CLI: --mode` cases, `renderDashboard:` cases,
`writeWithWatchdog:` cases.

Honest reading of why: the earlier observation was taken from a run that **died before reaching those
tests**. "Absent from the failure list" was read as "passes", when it actually meant "never ran". That
is the codebase's dominant defect class — a non-measurement read as a measured result — committed by
the analysis *about* that defect class, and then by me when I ruled on it.

## Second, separate failure

`R-MWBG: send-to-morty.md deployed copy matches the repo copy` — a **deploy-parity** assertion. CI has
no deployed copy at `~/.claude/pickle-rick/`, so this is structurally unsatisfiable in CI and belongs
with the `extension-wiring` deploy-smoke class, not with the monitor suite.

## Acceptance criteria

- **AC-1** A `release.yml` run reaches **`Create release`** and produces an artifact. Evidence is a run
  URL and its conclusion — not a local gate result.
- **AC-2** The `monitor.test.js` Linux failures are fixed at their source. Per the re-filed darwin PRD
  the owner surface is `extension/src/bin/monitor.ts` — **product code**, a deliberately `.unref()`'d
  watchdog timer — not the test file. **This bundle and the darwin PRD are now the same bug**; the
  earlier separation rested on the refuted premise above. Recompose them.
- **AC-3** `R-MWBG` deploy-parity is either skipped in CI with a stated reason or given a CI-satisfiable
  form. Do not delete the assertion.
- **AC-4** No claim about which tests "pass" on a platform may be derived from a run that terminated
  before those tests executed. Absence from a failure list is evidence only when the run reached them.

## Non-goals

Changing the Node major again. Reverting the beta.14 provisioning fixes — they are working.
