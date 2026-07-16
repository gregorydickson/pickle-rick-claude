---
title: "B-TRGP (re-scoped ③) — Honest off-repo worker-gate verdict: stop fabricating green"
priority: P1
r_codes: [B-TRGP]
status: build-ready
build_protocol: PIPELINE
line: release/v2.1-beta
composes: []
---

# B-TRGP — Honest off-repo worker-gate verdict (option ③: stop the lie, don't build the gate)

**Thesis: the per-ticket worker gate cannot verify a non-pickle-rick repo — its commands are hardcoded to
`extension/` (eslint `extension/src`, `tsc`, `npm run test:fast`). So off-repo it must return an honest
`unverified` verdict, NEVER a fabricated `green`. Done still PROCEEDS on `unverified` (target-repo builds
must not brick), but is honestly labeled; the portable review/closer gate (`runGate`/`detectProjectType`),
which ALREADY verifies target repos, remains the verification authority.**

## Why ③, not ④ — the re-scope decision (2026-07-16, operator)

A 3-analyst × 3-cycle refinement of the original ④ scope ("route the per-ticket gate through the portable
`runGate`") mapped it, with independent corroboration, as a **large completion-authority-entangled build**:
the `runGate` call doesn't compile without a `scope` decision; the portable gate is repo-scoped where the
native gate is diff-scoped (judges the worker on untouched packages); the 600s cumulative cap + timeout
paths red healthy code on the loanlight-api fixture; and the verdict adapter **cannot be written against the
current `GateResult`** (`emptyGateResult` hardcodes green; skip reasons escape only via a side-channel
`emit`). Worst: ④ **duplicates** verification the review/closer layer already does repo-agnostically.

**Operator ruling: subtract the LIE (③), do not build the parallel gate (④).** The repo-agnostic
verification already exists downstream — the per-ticket gate's only job off-repo is to stop *claiming it
verified when it didn't*.

**Born-in context (git-verified):** the off-repo no-op has existed since the gate's FIRST commit
(`4e2e8bf8`, 2026-05-06 — `if (!fs.existsSync(extensionDir)) return { ok: true }`), a *correct*
self-hosting-era assumption (the gate lints/tests pickle-rick's own `extension/`) that became a defect at
the "build other repos" pivot. B-CWGE (`c4291522`, 2026-06-28) — the fix that made the Done-flip
fail-closed — consciously *deferred* the off-repo green with a "NOT fail-closed" comment rather than
closing it. This is foundational debt, not a regression.

## The defect

- `runWorkerGate` (`spawn-morty.ts:1538-1553`) — `if (!fs.existsSync(<wd>/extension)) return { ok: true }`,
  verifying nothing off-repo.
- `resolveWorkerGateVerdict` (`mux-runner.ts:4643-4647`) — the Done-flip authority returns `verdict:'green'`
  off-repo (own comment: "NOT fail-closed").
- **R-CWGE's trap-door invariant ("Done requires a GREEN worker-gate verdict") is satisfied VACUOUSLY off-repo**
  — the lie. All 25 loanlight-api sessions stamped Done on a green verdict that verified nothing.

## Workstreams

### WS-1 — off-repo verdict is `unverified`, not fabricated green [SUBTRACTS the lie]
- `runWorkerGate` off-repo early return stops claiming `ok:true`; it returns a signal the verdict layer maps
  to `unverified` (it still does not RUN anything — it honestly reports it cannot verify this repo).
- `resolveWorkerGateVerdict` off-repo path returns `unverified`, not `green`.
- **The on-repo path (`extension/` present) is UNCHANGED** — the native eslint/tsc/test:fast gate still runs
  and still yields green/red. (Pinned byte-identical by AC-3-4.)

### WS-2 — tri-state persistence with a DISTINCT `unverified` token (NOT the `absent` sentinel) [honesty plumbing]
- `persistWorkerGateVerdict` (`spawn-morty.ts:1479`) is typed `'green'|'red'`; widen to include
  `'unverified'`. ⚠ **Do NOT reuse `absent`** — `readWorkerGateVerdict` (`mux-runner.ts:4579`) already uses
  `absent` as a control-flow SENTINEL meaning "no data → recompute" (analyst finding, independently
  confirmed 3 cycles). A distinct `unverified` token so a persisted `unverified` is NOT re-read as
  "recompute" and does NOT fall through to the hardcoded off-repo green.
- Round-trip `unverified` through `readWorkerGateVerdict` / `resolveWorkerGateVerdict`.

### WS-3 — Done-flip contract: `unverified` PROCEEDS (don't brick) but is honestly recorded [redefine the invariant]
- `guardCompletionCommitBeforeDone`: on `unverified`, ALLOW the Done-flip (a target-repo build MUST be able
  to complete) but record it and emit a `worker_gate_unverified` observability event carrying the repo +
  ticket. It is NOT fail-closed (that bricks every target-repo Done) and NOT counted as green.
- **Redefine the R-CWGE invariant honestly:** "a Done-flip requires a GREEN verdict on pickle-rick-claude;
  on a repo without `extension/`, `unverified` is permitted, and the portable review/closer gate is the
  verification authority." Update the R-CWGE trap-door text + its tests in lockstep.

### WS-4 — name the portable review/closer gate as the off-repo verification authority [pure reuse / doc + pin]
- The review phases (citadel/anatomy/szechuan) ALREADY run `runGate`/`detectProjectType` on the target repo.
  Make the handoff explicit (doc + one pin): off-repo verification lives THERE, not in the per-ticket gate.
  No new verification machinery — the honest label from WS-1/2/3 is the whole contribution.

## Simplification Review (subtract-before-add — REQUIRED, per WS)

- **WS-1.** (1) Necessary — it removes a fabricated verdict. (2) Reuse — edits the existing early return; adds
  nothing. (3) It SUBTRACTS the fake-green LIE (the brittle thing). (4) Subtraction: the `ok:true` claim is
  gone. ✓ ideal.
- **WS-2.** (1) Necessary to carry an honest third state. (2) Reuse the existing persist/read seam; add ONE
  token. (3) It subtracts AMBIGUITY (stops overloading `absent`). (4) Net: +1 enum member, honesty plumbing —
  NOT a parallel verification system.
- **WS-3.** (1) Necessary — the invariant must match reality. (2) Reuse `guardCompletionCommitBeforeDone`. (3)
  Redefines an invariant to be honest rather than adding a guard. (4) +1 observability event.
- **WS-4.** Pure reuse — the portable gate already exists and runs.
- **Contrast ④ (REJECTED):** running the portable gate per-ticket needs a `scope`/`since` decision +
  diff-scoping + the 600s-cap fix + timeout classification + a bun row + a `GateResult`→verdict adapter that
  cannot be written today — a large parallel verification system duplicating the review layer. **③ builds
  none of it.**

## Explicitly NOT in scope
- Running the portable gate per-ticket off-repo (④ / B-TRGP-full — deferred, likely rejected: duplicates the
  review/closer verification).
- diff-scoping parity, the 600s cumulative-cap fix, timeout→verdict classification, the bun
  `gate-commands.json` row, the `GateResult`→verdict adapter — ALL ④ concerns, none needed for ③.
- **[[R-ORSR-2]]** (own PRD) — re-running a ticket's own `acceptance_test` at Done needs a NEW AC-execution
  helper (none exists); additive, distinct mechanism.

## Build protocol: `/pickle-pipeline` (PIPELINE-SAFE — no hand-build)
The change only affects the OFF-repo branch. The pipeline builds B-TRGP with `working_dir` =
pickle-rick-claude (which HAS `extension/`), so every build worker's deployed runtime takes the UNCHANGED
on-repo path — the changed off-repo branch never fires on the build worker. Per operator directive
(2026-07-16): NOTHING hand-built — always `/pickle-pipeline`. **Lockstep trap-doors/tests:** the R-CWGE
entry in `extension/CLAUDE.md`, `extension/tests/completion-authority-single-source.test.js`,
`extension/tests/integration/codex-worker-gate-fail-closed.test.js`, `bash scripts/audit-trap-door-enforcement.sh`.

## Acceptance Criteria (machine-checkable)
- **AC-3-1** — `it("off-repo (no extension/ dir), runWorkerGate/resolveWorkerGateVerdict resolve 'unverified', never 'green'")`.
- **AC-3-2** — `it("a persisted 'unverified' round-trips DISTINCTLY from 'absent' — it is not re-read as recompute and does not fall through to the hardcoded off-repo green")`.
- **AC-3-3** — `it("a Done-flip on an 'unverified' verdict PROCEEDS (target build completes) AND emits worker_gate_unverified; it is never recorded as green")`.
- **AC-3-4** — `it("on-repo (extension/ present), the native gate behavior is byte-identical to pre-fix — green/red unchanged")`.
- **AC-3-5** — `it("the R-CWGE trap-door + tests encode the honest contract: green required on pickle-rick-claude, unverified permitted off-repo")`.

## Risks
- **`absent`-sentinel collision (the one surviving analyst P0)** — use a DISTINCT `unverified` token; pin
  that a persisted `unverified` never routes to recompute or green (AC-3-2).
- **`unverified` must NOT block Done** — else every target-repo build bricks; AC-3-3 pins proceed.
- **Completion-authority trap-doors (R-CWGE / B-1SEAM)** — update in lockstep; verify the full release gate
  (this is the most-pinned code in the repo).
- **Honest, not verifying** — ③ makes the per-ticket state truthful; it does NOT verify target-repo diffs
  per-ticket (by design). Real target-repo verification stays at the review/closer portable gate (WS-4).
  If per-ticket fail-fast on target repos later proves load-bearing, that is a SEPARATE ④ decision.
