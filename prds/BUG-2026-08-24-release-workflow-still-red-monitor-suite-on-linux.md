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
