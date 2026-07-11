# P2 Bug-Fix Bundle — R-WGFR (subtractive): the Done-flip worker-gate recompute must verify the DETERMINISTIC dimensions (eslint+tsc), not re-run the flaky `test:fast`

**Priority:** P2 (HIGH — reliability / continuous-autonomy. No data loss: the tree is provably green. A
single c=8 `test:fast` timeout-flake makes `recomputeAbsentWorkerGateVerdict` return red, R-CWGE
fail-closes **fatal**, and a GREEN bundle is killed at `0/N phases` — the beta.44 codex 0/4 forensic.
This is the #1 open reliability item AND the single biggest de-flaker of hands-off soak reps.)
**Code:** R-WGFR (Worker-Gate Flaky-testfast false-Red-fatal) — **resolved by SUBTRACTION.**
**Backend:** claude (gate-verdict seam; backend-agnostic).
**North-star framing (operator 2026-07-11): simplify → autonomy → quality.** This bundle is a net
**subtraction**: it *removes* the flaky `test:fast` re-run from the Done-flip verdict recompute. It adds
no script, no npm hook, no schema field, no retry/budget machinery, no new flag/state. The additive
alternatives (a `test:fast:gate` script at c=4; a flake-budget branch) were rejected — a 3-analyst
refinement pass proved the additive path carries a 5-file blast radius (a JSON-schema `const`, a
`pretest:fast` audit hook, two command-pinned tests) AND does not actually *close* the class (c=4 is
still one run against the unchanged 600 s timeout; the release gate's real resistance is a repetition
budget, not c=4). Subtracting the flaky dimension closes the class at the root and dissolves all of it.

**Build-safety note (pipeline-safe, self-exposed — B-RASO model).** The edit lives in
`extension/src/bin/mux-runner.ts` `recomputeAbsentWorkerGateVerdict` (the absent-verdict recompute that
feeds the Done-flip guard) + its R-CWGE trap door + one test. It does NOT touch `salvage-ticket.ts` /
`reconcile-ticket-truth.ts` / `ticket-completion-evidence.ts` / the completion-evidence oracle. The
running pipeline executes DEPLOYED JS, so the source diff never self-applies mid-build (lands at
`install.sh`). **Self-exposure:** the R-WGFR build's own ticket-boundary Done-flips run under the
DEPLOYED (buggy, flaky) recompute — so this very build can be false-red-fataled by the bug it fixes. The
firing condition is a c=8 flake (low base rate). If it fires: re-verify via `test:fast:budget`
(authoritative because it is **5 reruns @ c=8 tolerating ≤2** — a repetition budget, NOT because it is
c=4; it is not), `git merge --ff-only` the orphaned commit, do NOT re-spawn — then continue. Attended
pipeline per B-RASO; expected, not a regression.

**Source anchor:** verified against branch `experiment/fable-operating-manual` HEAD `a317d971`
(2026-07-11, v2.1 beta line). `recomputeAbsentWorkerGateVerdict` at `mux-runner.ts:4581–4589`; the
Done-flip guard reason string at `:4743`; the R-CWGE trap door in `extension/src/bin/CLAUDE.md`. **Fix
site is byte-identical to `main`** → back-ports byte-exact for v2.0. **Version-line policy (operator
2026-07-11):** all work on the v2.1 branch first, back-port to `main` for v2.0 as needed. Refresh anchors
before build if HEAD moved.

---

## Context

Live forensics of the beta.44 R-LTNC codex soak (session `2026-07-08-b89bb506`). Ticket `9bdcecd5`
committed cleanly and flipped **Done**; the pipeline advanced. Then the between-ticket boundary
re-resolved that ticket's worker-gate verdict — which was **absent** (a codex worker never persisted
one) — via `recomputeAbsentWorkerGateVerdict`, and the Done-flip guard fatal-stopped the whole pipeline
at **0/4 phases**:

```
[fatal] ticket 9bdcecd5 cannot flip Done: worker_gate_verdict='red'
        (computed_via=between_ticket_gate). Done requires a GREEN worker-gate
        verdict (eslint+tsc+test:fast); a red or absent/unverifiable verdict is
        fail-closed (R-CWGE).
```

**But the tree was GREEN.** Post-hoc on the exact committed tree: `tsc --noEmit` PASS, `eslint src/`
PASS, `test:fast:budget` **5/5, 0 failures**. The "red" was a `test:fast` **flake** at c=8 (documented
R-CIFB, amplified by codex orphan contention) — not a real failure.

## Root cause (and why the fix is subtraction, not addition)

`recomputeAbsentWorkerGateVerdict` (`mux-runner.ts:4581`) speaks for a worker that never persisted a
`worker_gate_verdict` (codex / salvaged). It recomputes over the full contract:

```
if (!runCheck eslint) return 'red';   // deterministic
if (!runCheck tsc)    return 'red';   // deterministic
return runTests(...) ? 'green' : 'red';  // ← runs a SINGLE npm run test:fast — FLAKY at c=8
```

The verdict feeds `resolveWorkerGateVerdict` → `guardCompletionCommitBeforeDone`, whose
`worker_gate_red` branch (`:4727`) is **fail-closed FATAL**. Two of the three dimensions (`eslint`,
`tsc`) are **deterministic** — they never flake. The flake lives entirely in the third (`test:fast`),
and that third dimension is **redundant** with (a) the *next* ticket's own worker-lint gate, which runs
`test:fast`, and (b) the **closer's authoritative full release gate**, which runs
`test:fast`+`integration`+`expensive`.

The guard is a lifecycle-advancement gate → it correctly fails **closed** (manual §4). The defect is its
**input**: a deterministic verdict polluted by one flaky, redundant test run. The subtract-before-add
fix is not to make the flaky run flake-resistant (add machinery) — it is to **remove the flaky,
redundant dimension** and keep the deterministic ones. B-CWGE's actual protection (a lint-RED or tsc-RED
tree hidden behind a passing `test:fast` recomputing green) is fully preserved by keeping eslint+tsc —
that is the class the trap door was written to catch, and it stays caught.

**Verified caller topology (why this is the whole fix):** `runBetweenTicketFastTests` is called by five
sites, but only the **Done-flip guard verdict** (via the recompute) fatals a green bundle. `greenGate`
(`:4640`) feeds a *separate* salvage/attribution decision, not the `worker_gate_red` fatal branch;
`commitGatePassingDeliverableOnExitPath` (`:5110`) and the recovery-ladder armed gate (`:5726`) degrade
gracefully (skip-commit / continue-recovery) — none fatal a green bundle on a flake. Subtracting the
test dimension from the **recompute** closes the confirmed fatal class without touching the observability
gate's command string (so the schema `const`, the `pretest:fast` hook, and the two command-pinned tests
the refinement flagged are all **untouched**).

## WS-1 — recompute the absent verdict over eslint+tsc only (SHIP)

### Changes

1. **`recomputeAbsentWorkerGateVerdict` (`mux-runner.ts:4581`)** — remove the `runTests` step and its
   parameter; return `'green'` once eslint and tsc both pass. eslint short-circuits tsc (ordering
   preserved). Add a one-line R-WGFR rationale comment (deterministic-only; test authority = closer).
2. **Done-flip guard reason string (`:4743`)** — `Done requires a GREEN worker-gate verdict
   (eslint+tsc+test:fast)` → `(eslint+tsc)`. (Tests grep this string — reconcile in lockstep.)
3. **R-CWGE trap door (`extension/src/bin/CLAUDE.md`)** — update the invariant + PATTERN_SHAPE: the
   recompute runs **eslint+tsc** (no longer "eslint+tsc before `runBetweenTicketFastTests(`"); document
   that dropping the deterministic-only recompute's test dimension is deliberate (R-WGFR: the flaky
   redundant run false-red-fataled a green bundle; test authority is the closer's full gate). The
   `runWorkerGate(` callsite-count == 1 and the fail-closed Done-flip routing invariants are UNCHANGED.
4. **`worker-gate-verdict-recompute.test.js`** — reconcile: inject `runCheck` returning eslint-red /
   tsc-red → `'red'` (both preserved); eslint+tsc green → `'green'` **regardless of any test state**
   (prove the test dimension is gone); remove/repurpose the old `runTests` injection assertions.

### Acceptance criteria (machine-checkable)

- **AC-WGFR-1** — `recomputeAbsentWorkerGateVerdict` no longer runs `test:fast`: its body contains no
  `runTests(` call and no `runBetweenTicketFastTests(` call.
  `awk '/export function recomputeAbsentWorkerGateVerdict/,/^}/' extension/src/bin/mux-runner.ts | grep -c "runBetweenTicketFastTests\|runTests("` == 0.
- **AC-WGFR-2** — the deterministic Done-over-red protection is preserved: the function still returns
  `'red'` when eslint fails and when tsc fails (eslint checked before tsc).
  `awk '/export function recomputeAbsentWorkerGateVerdict/,/^}/' … | grep -Ec "eslint|tsc"` ≥ 2 with
  both guarded `return 'red'`.
- **AC-WGFR-3** — the guard reason string names only the checked dimensions:
  `grep -c "GREEN worker-gate verdict (eslint+tsc)" extension/src/bin/mux-runner.ts` ≥ 1 AND
  `grep -c "eslint+tsc+test:fast" extension/src/bin/mux-runner.ts` == 0.
- **AC-WGFR-4** — the R-CWGE trap door reflects the new contract:
  `extension/src/bin/CLAUDE.md`'s R-CWGE entry PATTERN_SHAPE no longer requires
  `runBetweenTicketFastTests(` inside `recomputeAbsentWorkerGateVerdict`, and
  `bash extension/scripts/audit-trap-door-enforcement.sh` passes.
- **AC-WGFR-5** — `worker-gate-verdict-recompute.test.js` proves: eslint-red→red, tsc-red→red, and
  eslint+tsc-green→green with **no** test invocation (inject a `runCheck` and assert green without any
  `runTests`); `npm run test:fast` (fast tier) green.
- **AC-WGFR-6** — the fail-closed Done-flip ROUTING is untouched: `resolveWorkerGateVerdict` still calls
  `recomputeAbsentWorkerGateVerdict` on an absent persisted verdict; `guardCompletionCommitBeforeDone`
  still fail-closes on `worker_gate_red`/`worker_gate_unavailable`; `runWorkerGate(` callsite count == 1.
- **AC-WGFR-7** — full release gate green from `extension/` (tsc + eslint + all audit scripts +
  `test:fast:budget` + `test:integration` + `RUN_EXPENSIVE_TESTS=1 test:expensive`).

### Simplification Review (subtract-before-add) — WS-1

1. **Necessary?** Pure removal — deletes the `runTests` step + parameter from one function. Adds no
   guard/flag/state/script/hook/schema. The ideal case per the guide.
2. **Reuse?** N/A (removal). The deterministic dimensions reuse the existing `runCheck` seam unchanged.
3. **Guards existing brittle complexity that should be SUBTRACTED?** Yes — and it subtracts it. The
   brittle thing is the recompute's flaky `test:fast` dimension, which false-red-fataled a green bundle
   (a guard false-blocking past budget → removal candidate, not a hardening candidate). We remove it
   rather than wrap it in c=4/budget/retry machinery (which would be a second hatch around one guard).
4. **Subtracts?** Removes a flaky, redundant per-boundary test run and the entire false-red-fatal class
   it caused; collapses a 3-dimension recompute to its 2 deterministic dimensions.

## Risks

- **R1 — test-red deferred at absent-verdict boundaries (accepted, priority #3).** After the fix, a
  worker with an *absent* persisted verdict whose tree is genuinely test-RED (but eslint+tsc green) flips
  Done at the boundary; the RED is caught by the closer's authoritative full gate rather than at the
  boundary. This is the deliberate quality/autonomy trade (quality #3): the boundary recompute no longer
  fatal-stops on a *flaky* red, at the cost of not catching a *genuine* boundary test-red until the
  closer. B-CWGE's lint/tsc-red protection is fully preserved. Persisted-verdict workers (the common
  case) are unaffected — their own worker-lint gate already ran test:fast.
- **R2 — self-exposure during this build** (see Build-safety note): the deployed flaky recompute governs
  the build's own Done-flips; recovery = `test:fast:budget` re-verify + ff-reattach, do NOT re-spawn.
- **R3 — trap-door reversal is deliberate.** We are loosening a pinned R-CWGE invariant. This is
  sanctioned subtract-before-add (the guard false-blocked past budget), but it MUST update the trap-door
  text + its enforcing audit + the test in one commit, with the rationale recorded, so the reversal is
  documented, never silent.

## Out of scope

- The observability between-ticket gate `runBetweenTicketFastGate` / `runBetweenTicketFastTests` command
  string, the `test:fast` npm script, the `pretest:fast` hook, `activity-events.schema.json`, and the
  command-pinned tests (`per-ticket-gate-no-flake-budget.test.js`, `mux-runner-between-ticket-gate.test.js`)
  — all UNTOUCHED (we never introduce a `test:fast:gate` command). A *further* subtraction — dropping the
  per-boundary observability `test:fast` re-run entirely (rely on worker gate + closer) — is a separate,
  larger call, deliberately NOT bundled here.
- The worker-lint gate `test:fast` in `spawn-morty.ts` (a different gate).
- R-CWGE fail-closed Done-flip policy, the completion-evidence oracle, WS-2 reaper widening (a different
  concern; contention amplifier, not the root).
