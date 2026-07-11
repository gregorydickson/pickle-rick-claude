# P2 Bug-Fix Bundle — R-WGFR: the between-ticket worker-gate must verify `test:fast` through a flake-resistant signal, not one raw c=8 run

**Priority:** P2 (HIGH — reliability. No data loss: the tree is provably green. But a single c=8
timeout-flake yields a false-red worker-gate verdict, R-CWGE fail-closes **fatal**, and a GREEN bundle
is killed at `0/N phases`. This false-red-fatal is the #1 open reliability item and the single biggest
de-flaker of autonomous soak reps — it forced the heavy babysitter closer-takeover on the beta.44 codex
build.)
**Code:** R-WGFR (Worker-Gate Flaky-testfast false-Red-fatal).
**Backend:** claude (gate-decision seam; the fix removes a codex-amplified flake but the seam itself is
backend-agnostic).
**Build-safety note:** **Pipeline-safe — NOT the R-PSRB salvage/completion/Done-flip path.** The edit
lives in `extension/src/bin/mux-runner.ts` `runBetweenTicketFastTests` (the between-ticket gate's
`test:fast` invocation) + a new `extension/package.json` script. It does NOT touch `salvage-ticket.ts` /
`reconcile-ticket-truth.ts` / `ticket-completion-evidence.ts` / the mux-runner Done-flip **evidence**
logic — it only changes the *concurrency of the test command that feeds the verdict*. R-CWGE stays
fail-CLOSED (unchanged). The running pipeline executes DEPLOYED JS, so this builds normally on its own
pipeline; the closer's full gate is the authoritative backstop.
**Source anchor:** verified against branch `experiment/fable-operating-manual` HEAD `0f1e6245`
(2026-07-11, the v2.1 beta line). The three fix sites (`runBetweenTicketFastTests` `mux-runner.ts:638`,
`recomputeAbsentWorkerGateVerdict` delegation `:4584/:4588`, `package.json:22` `test:fast` c=8) are
**byte-identical to `main`** (the branch/main `mux-runner.ts` diff is elsewhere — the codegraph
mux-gate + version), so the fix applies cleanly here and **back-ports to `main` byte-exact** for v2.0.
**Version-line policy (operator 2026-07-11):** ALL work lands on the v2.1 branch first, then back-ports
to `main` for v2.0 as needed. R-WGFR is a GA-blocking reliability fix → build on v2.1, cherry-pick to
main. Refresh anchors before build if HEAD moved.

> **▶ BUILD SCOPE (author decision 2026-07-11, north-star-aligned): WS-1 ONLY. WS-2 is DEFERRED —
> see the WS-2 section.** WS-1 is the reliability root fix + a subtraction of a false-red failure class,
> and it removes the timeout-flake regardless of machine contention. WS-2 (widening the R-CXHANG reaper
> to sweep age-old `codex app-server` orphans) targets a contention *amplifier*, not the root, and it
> tensions with a **pinned safety invariant** (the R-CXHANG reaper's positive-ownership-mandatory
> contract — "an un-attributable proc is NEVER killed; deliberately NO ppid==1-only reap branch"). A
> `codex app-server` proc carries no `--add-dir` session ownership, so an age-only sweep is precisely the
> brittleness-adding change the north star says to defer (the R-MPGD WS-2 precedent). Once WS-1 lands at
> c=4 the timeout-flake is removed at the source; if orphan contention still bites, WS-2 gets its own
> bounded bundle with a real ownership signal — NOT an age-only reap branch grafted onto a positive-
> ownership guard.

---

## Context

Live forensics of the beta.44 R-LTNC codex soak (session `2026-07-08-b89bb506`). Ticket `9bdcecd5`
(a 225-file rename + hermetic backfill test) committed cleanly and flipped **Done**; the pipeline
advanced. Then the **between-ticket gate** re-verified `9bdcecd5` and fatal-stopped the whole pipeline
at **0/4 phases**:

```
[fatal] ticket 9bdcecd5 cannot flip Done: worker_gate_verdict='red'
        (computed_via=between_ticket_gate). Done requires a GREEN worker-gate
        verdict (eslint+tsc+test:fast); a red or absent/unverifiable verdict is
        fail-closed (R-CWGE).
Phase pickle exited (exit_reason=done_without_commit_evidence); 2/3 tickets remain.
```

**But the tree was GREEN.** Post-hoc, on the exact committed tree: `tsc --noEmit` PASS, `eslint src/`
PASS, `test:fast:budget` **5/5 runs, 0 failures**, backfill ≥12-pin ✔. The "red" was a **flake**, not a
real failure — the worker itself reported the fast suite "did not yield a trustworthy terminal result."
Under codex, resource contention from orphan `codex app-server` procs (one 2 days old) amplified the
timeout-flakiness.

The historical operator rule is already on record: **`test:fast` is timeout-shaped flaky at c=8; re-run
at c=4 for the authoritative green.** The release gate never trusts a single c=8 run — it uses
`test:fast:budget` (`check-flake-budget.js`, 5 runs, tolerate ≤2). Only the between-ticket gate trusted
one raw run.

Forensics: `prds/BUG-REPORT-2026-07-08-worker-gate-single-flaky-testfast-false-red-fatal.md`.

## Root cause

The between-ticket gate computes its verdict from a **single raw run**:

- `mux-runner.ts:638` — `runBetweenTicketFastTests` calls
  `spawnSync('npm', ['run', 'test:fast'], …)` **once**. `test:fast` hardcodes
  `--test-concurrency=8` (`package.json:22`), and `test-runner.ts` only *caps* concurrency to core
  count — on a ≥8-core machine the gate runs at the exact c=8 that is documented-flaky under contention.
- `recomputeAbsentWorkerGateVerdict` (`mux-runner.ts:4581–4589`) recomputes an absent verdict over the
  full eslint+tsc+test:fast contract by **delegating to the same `runBetweenTicketFastTests`** — so it
  inherits the single-c=8-run flakiness. **This is one seam: fixing `runBetweenTicketFastTests` fixes
  both callers.**

R-CWGE (correctly) treats a **red OR absent/unverifiable** verdict as fail-closed. That policy is
load-bearing and correct — the defect is **its input**: a verdict only as reliable as one flaky c=8
`test:fast` run. A single c=8 flake becomes a **false red → fatal 0/N on a green bundle.**

## WS-1 — route the between-ticket gate's `test:fast` through the c=4 flake-resistant path (SHIP)

**One seam, one concurrency value, greppable.** Do NOT add a retry-guard around R-CWGE; do NOT change
R-CWGE's fail-closed policy. Only lower the concurrency of the test command that feeds the verdict, from
the documented-flaky c=8 to the documented-authoritative c=4.

### Changes

1. **Add a dedicated gate npm script** in `extension/package.json`:
   `"test:fast:gate": "node bin/test-runner.js --tier fast --test-concurrency=4"`.
   This is the single source of truth for the gate's concurrency (reuses the same `test-runner.js` the
   `test:fast` script uses; no new machinery, no new runner). Placed adjacent to `test:fast` /
   `test:fast:budget`.
2. **Route the gate through it.** In `runBetweenTicketFastTests` (`mux-runner.ts:638`), spawn
   `npm run test:fast:gate` instead of `npm run test:fast`. Keep the existing `timeout`
   (`resolveWorkerTestGateTimeoutMs`), the ETIMEDOUT detection, and the `BetweenTicketGateResult`
   shape unchanged.
3. **Update the two surfaced command strings** in the same function's failure/timeout records
   (the `file: 'npm run test:fast'` fallback at `:651` and the `between_ticket_gate_timeout`
   `gate_payload.command: 'npm run test:fast'` at `:696`) to `'npm run test:fast:gate'` so the activity
   trail names the command that actually ran.
4. **`recomputeAbsentWorkerGateVerdict` requires NO edit** — it calls `runBetweenTicketFastTests` and
   inherits the fix. The R-CWGE trap-door PATTERN_SHAPE (`recomputeAbsentWorkerGateVerdict` runs
   eslint+tsc before `runBetweenTicketFastTests(`) is preserved verbatim.

### Acceptance criteria (machine-checkable)

- **AC-WGFR-1** — `extension/package.json` contains a `"test:fast:gate"` script whose value invokes
  `bin/test-runner.js` with `--tier fast` and `--test-concurrency=4`.
  `node -e "process.exit(/--test-concurrency=4/.test(require('./extension/package.json').scripts['test:fast:gate'])?0:1)"`
  exits 0.
- **AC-WGFR-2** — `runBetweenTicketFastTests` in `extension/src/bin/mux-runner.ts` spawns
  `npm run test:fast:gate` (not `npm run test:fast`).
  `grep -c "'run', 'test:fast:gate'" extension/src/bin/mux-runner.ts` ≥ 1 AND the function body no longer
  contains a `spawnSync('npm', ['run', 'test:fast']` (unsuffixed) call.
- **AC-WGFR-3** — the timeout/failure records in `runBetweenTicketFastTests` name `test:fast:gate`:
  no residual bare `'npm run test:fast'` string literal remains inside the function body (the surfaced
  `command`/`file` fields say `test:fast:gate`).
- **AC-WGFR-4** — `recomputeAbsentWorkerGateVerdict` still delegates test execution to
  `runBetweenTicketFastTests` (single-seam invariant): the R-CWGE conformance test and
  `worker-gate-verdict-recompute.test.js` stay green with no new `test:fast` spawn added.
- **AC-WGFR-5** — a new/updated unit test proves the gate invokes the c=4 path: injecting a fake
  `runTestFast`/`spawnSync` observes the command `npm run test:fast:gate` and the gate returns the
  injected ok/failure verdict unchanged (R-CWGE fail-closed semantics untouched). Test file:
  `extension/tests/between-ticket-gate-concurrency.test.js` (or an added case in the existing
  mux-runner gate test).
- **AC-WGFR-6** — full release gate green from `extension/` (tsc + eslint + all audit scripts +
  `test:fast:budget` + `test:integration` + `RUN_EXPENSIVE_TESTS=1 test:expensive`).

### Simplification Review (subtract-before-add) — WS-1

1. **Necessary?** No new guard/flag/state field. The runtime change is a **one-token concurrency swap**
   at one call site (`test:fast` → `test:fast:gate`), plus one npm script that reuses the existing
   `test-runner.js`. Net-neutral-to-subtractive.
2. **Reuse?** Yes — reuses the c=4 concurrency the release gate already relies on and the existing
   `test-runner.js`. No parallel test mechanism, no retry loop. (The `test:fast:budget` /
   `check-flake-budget.js` path was considered and **rejected** for the per-boundary gate: ~5× the test
   time at every ticket boundary is too expensive; c=4 removes the flake at the source far cheaper.)
3. **Guards existing brittle complexity?** It **removes** brittleness (a flaky single-c=8-run verdict);
   it does not guard it. Explicitly NOT adding a retry-hatch around R-CWGE — that would be
   guards-on-guards (two hatches for one guard = the guard is wrong).
4. **Subtracts?** Removes a false-red failure class: a green bundle can no longer be fatally stopped by
   one c=8 `test:fast` timeout-flake.

## WS-2 — widen the R-CXHANG reaper to sweep age-old `codex app-server` orphans (DEFERRED)

**Status: DEFERRED (author, reliability-first + subtract-before-add).** The contributing cause is real:
orphan `codex app-server` procs accumulate (the R-CXHANG reaper keys on `--add-dir` under the sessions
root and does not catch them), starving the machine and amplifying the c=8 timeout-flake. But this is a
**contention amplifier, not the root** — WS-1 removes the timeout-flake at the source regardless of how
many orphans exist.

Widening the reaper is **not** a safe reuse: the R-CXHANG reaper carries a pinned
positive-ownership-mandatory invariant (`services/orphan-reaper.ts`, trap door
`R-CXHANG orphaned-worker-proc reaper` — "reaping without positive ownership kills a live sibling
pipeline's worker mid-build … there is deliberately NO ppid==1-only reap branch"). A `codex app-server`
proc has no `--add-dir` session ownership, so reaping it by age alone would **violate** that invariant
and risks killing a shared daemon a live codex session still needs. Doing it correctly requires a genuine
ownership signal for `codex app-server` procs — real design work that ADDS a detection branch to a
safety-critical guard.

Per the north star (reliability first; defer goal-#2 workstreams that add brittleness even when the bug
is real — the R-MPGD WS-2 precedent), WS-2 is deferred to its own bounded bundle, to be built **only if**
orphan contention still bites after WS-1 lands at c=4. Tracking stays in the MASTER_PLAN R-WGFR /
R-CXHANG rows.

### Simplification Review — WS-2

1. **Necessary?** Not now — WS-1 removes the flake at the root; WS-2 defends a door WS-1 already closes.
2. **Reuse?** Only partially — it would extend `killProcessGroup`/`orphan-reaper.ts`, but the *ownership
   signal* it needs does not exist and cannot be safely age-only.
3. **Guards existing brittle complexity?** It would ADD a reap branch to a safety-critical
   positive-ownership guard — the exact brittleness class the north star fights.
4. **Subtracts?** No subtraction available; pure addition. → **DEFER.**

## Risks

- **R1 — non-pickle-rick extension targets.** `runBetweenTicketFastTests` early-returns null when no
  `extension/` dir exists, and `recomputeAbsentWorkerGateVerdict` runs only when `extension/` is present
  — in practice the gate's `test:fast` runs only on pickle-rick self-builds, where `test:fast:gate` will
  exist. If a hypothetical non-pickle-rick target ever carries an `extension/` dir with `test:fast` but
  not `test:fast:gate`, `npm run test:fast:gate` would exit non-zero → a fail-closed red (the SAFE
  direction, never a false-green). Acceptable; note it, do not add a fallback (that would be new
  machinery for a case that does not occur in the fleet).
- **R2 — c=4 is slower per boundary than c=8.** True but bounded: fewer parallel workers, marginally
  longer wall-clock at each ticket boundary, in exchange for removing the false-red-fatal class. The
  release gate already accepts this trade at c=4. No mitigation needed.
- **R3 — a test elsewhere pins the between-ticket gate to `npm run test:fast`.** The worker must grep
  `test:fast'` across `extension/tests/` and reconcile any test asserting the old unsuffixed command in
  the between-ticket gate path to the new `test:fast:gate` command (do NOT touch the worker-lint-gate's
  own `test:fast` in spawn-morty — that is a different gate and out of scope).

## Out of scope

- The worker-lint-gate `test:fast` in `spawn-morty.ts` (a different gate; its concurrency is a separate
  decision and NOT part of R-WGFR).
- Any change to R-CWGE fail-closed policy, the completion-evidence oracle, or the Done-flip guard.
- WS-2 (reaper widening) — deferred, see above.
