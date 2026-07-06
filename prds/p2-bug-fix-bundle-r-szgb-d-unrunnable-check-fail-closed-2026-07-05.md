# P2 Bug-Fix Bundle — R-SZGB-D: an unrunnable gate check must fail-CLOSED (uncertifiable), not emit a subtractable failure

**Priority:** P2 (quality-gate integrity — completes the R-SZGB family. The same fail-OPEN *class* as
R-SZGB-B, one level down: per-CHECK instead of per-PROJECT.)
**Code:** R-SZGB-D (Szechuan Gate Blind spot — unrunnable-check residual)
**Backend:** claude (repairs the review-phase gate service; codex irrelevant to the mechanism).
**Build-safety note:** **Pipeline-safe — NOT the R-PSRB salvage/completion/Done-flip path.** Edits live in
`extension/src/services/convergence-gate.ts` (check-execution + baseline-certifiability) and the
per-iteration certification consumer in `extension/src/bin/microverse-runner.ts` (reusing the R-SZGB-B/C
uncertifiable-baseline path). Same self-referential-review caveat as R-SZGB-B/C: this build's own review
phases run the DEPLOYED gate; the closer's full gate is the authoritative backstop. Build → deploy →
(covered by the already-green R-APBN-5-class fixtures + new fixtures here).
**Complexity tier:** WS-1 `complexity_tier: medium` (core gate service; must run `test:fast` at the worker
gate — a `small`-tier gate fix would SKIP `test:fast` and re-introduce exactly this blind-spot class).

---

## Context

The R-SZGB live-proof (session `2026-07-05-9fb9a10b`) targeted the repo root. R-SZGB-A correctly resolved
`extension/` (the finalize-gate result's `file: .../extension` proves it), but the `typecheck` check then
ran `npm run typecheck` — a script `extension/package.json` did not have — erroring
`npm error Missing script: "typecheck"`. That "couldn't run" error was captured by `buildFailures`
(`convergence-gate.ts:712-720`) as a **generic subtractable failure**
(`{check, file: pkgDir, ruleOrCode: String(exitCode), message: "Missing script...", severity: error}`),
indistinguishable from a real check failure.

Consequence — the check is INERT: in per-iteration baseline mode the "Missing script" failure is captured
as the baseline; in replay a tsc-RED commit ALSO yields only `npm run typecheck → Missing script` (tsc
never runs), an identical failure signature → `subtractBaseline` nets zero new failures → **the gate
certifies green over the tsc-RED tree.** On any repo whose toolchain does not match the exact npm script
names in `gate-commands.json` (pickle-rick typechecks via `npx tsc --noEmit`, no `typecheck` script), the
`typecheck` check silently never runs and its regression class escapes — the very class the original
R-SZGB incident shipped (5 tsc errors).

**Root cause (one sentence):** a check whose command *could not run* (missing npm script, command not
found, ENOENT) is treated as a subtractable failure rather than a fail-CLOSED "this check is
uncertifiable" signal — the same fail-OPEN principle R-SZGB-B closed at the per-PROJECT level
(`project_type: null` must not certify), unclosed at the per-CHECK level.

An interim option-3 fix (add `"typecheck": "tsc --noEmit"` to `extension/package.json`) has ALREADY
landed (`c5c7125f`) and makes pickle-rick's own gate bite on tsc. This bundle is the **durable, general**
fix so the blind spot cannot recur on any repo/toolchain.

---

## WS-1 — R-SZGB-D-A: classify an unrunnable check as uncertifiable and fail-CLOSED

### Problem
`buildFailures` cannot distinguish "the check ran and found errors" from "the check command could not
run at all." The latter is emitted as a normal, baseline-subtractable failure, so the check becomes inert
(never certifies the thing it exists to certify) and its regression class escapes.

### Fix
1. **Detect the unrunnable-check class** in the gate's check execution. Add a single predicate (e.g.
   `isUnrunnableCheckResult(result)`) that recognizes a command that never executed the real tool:
   - npm/pnpm/yarn "Missing script" (`npm error Missing script`, pnpm/yarn equivalents),
   - command-not-found / ENOENT / exit 127.
   Keep it a narrow, well-tested classifier — a REAL tool failure (tsc emitting `TSxxxx`, eslint emitting
   violations, tests failing) MUST NOT be classified unrunnable.
2. **Fail-CLOSED via the existing R-SZGB-B path — reuse, do not add a parallel mechanism.** When a check
   is unrunnable in baseline mode, mark the baseline **uncertifiable** using the SAME signal R-SZGB-B/C
   already consume (the `project_type: null` / uncertifiable-baseline certification block that
   `handleWorkerManagedIteration` → `handlePostConvergenceGateDeferral` already honor with `selfRedOpen`).
   Prefer surfacing an existing-shaped uncertifiable signal on the persisted baseline (reuse
   `baseline.project_type`-null-equivalent semantics or the smallest additive marker the R-SZGB-B consumer
   already reads) so NO new certification path is created — the convergence consumer already knows how to
   refuse an uncertifiable baseline.
3. Emit a LOG LINE (`gate: check '<check>' could not run (<reason>) — baseline uncertifiable, cannot
   certify`). Do NOT add a new activity event (event registration is a recurring closer-bug class).

Constraints:
- Reuse the R-SZGB-B/C uncertifiable-baseline certification-refusal path; add NO new gate, flag, state
  field, or activity event beyond (if unavoidable) the smallest additive marker the existing consumer
  reads.
- A runnable check that passes (exit 0) or fails for real (parseable tsc/eslint/test failures) is
  UNCHANGED — only the couldn't-run class newly fails closed.
- The `stripEnvNoise` / exit-code-is-truth contract (R-FGNC) is preserved — this classifier runs on the
  same combined output but distinguishes "no tool output because the tool never ran" from "tool ran,
  found nothing."

### Acceptance criteria (machine-checkable)
- **AC-SZGBD-01 (headline):** New test — a fixture npm project whose `typecheck` maps to a MISSING npm
  script, in baseline mode, marks the baseline **uncertifiable** (not a normal captured failure); the
  per-iteration certification consumer then **refuses to certify convergence** (reuses the R-SZGB-B
  fail-closed path) even when replay nets zero new failures.
- **AC-SZGBD-02 (tsc-RED no longer escapes via the inert check):** New test — with the unrunnable
  `typecheck` check, a tsc-RED change does NOT converge (the run blocks/defers on the uncertifiable
  baseline) instead of netting zero-new-failures-green. Directly reproduces the live-proof escape.
- **AC-SZGBD-03 (real failure NOT misclassified):** Regression guard — a check that RAN and produced real
  failures (a genuine `tsc` `TSxxxx` error / eslint violation / failing test, exit≠0 WITH tool output) is
  classified as a normal subtractable failure, NOT unrunnable — `isUnrunnableCheckResult` returns false.
- **AC-SZGBD-04 (runnable-clean still certifies):** Regression guard — a project whose checks all run and
  pass (exit 0) certifies convergence normally; fail-closed does not over-block the healthy path.
- **AC-SZGBD-05 (no new surface):** `git diff` adds no new activity event and no new state schema field;
  the fail-closed decision routes through the existing R-SZGB-B uncertifiable-baseline consumer
  (grep-asserted in the test or via `audit-*` parity; observability is a log line only).

---

## Simplification Review (subtract-before-add) — REQUIRED

### WS-1 (unrunnable-check fail-closed)
1. **Necessary?** Yes — without it, any repo whose toolchain doesn't match `gate-commands.json`'s exact
   npm script names has silently-inert checks whose regression class escapes. Adds one narrow classifier
   + reuses the existing uncertifiable-baseline refusal.
2. **Reuse over add?** Yes — reuses the R-SZGB-B/C uncertifiable-baseline certification-refusal path (the
   `project_type: null` fail-closed consumer + `selfRedOpen` attrition latch). No parallel gate, no second
   certification path, no new event. The only genuinely new code is the `isUnrunnableCheckResult`
   predicate and its wiring into baseline-certifiability.
3. **Guards existing brittle complexity?** It repairs `buildFailures`' conflation of "couldn't run" with
   "ran and failed" at the root, rather than wrapping a guard around it. It generalizes the R-SZGB-B
   invariant ("a gate that inspected nothing must not certify") from per-project to per-check — the honest
   completion of that invariant, not a second hatch.
4. **Subtracts?** Removes the last fail-OPEN path in the per-iteration gate: after R-SZGB-A (resolve) +
   R-SZGB-B/C (uncertifiable project fail-closed) + R-SZGB-D (uncertifiable check fail-closed), there is
   no path where a converged exit is backed by a check that never actually ran. A strictly smaller set of
   trees can be declared converged.

**Bundle-level subtraction:** the R-SZGB family now closes the fail-OPEN at every level — no project type
(B/C) and no runnable check (D) both refuse certification instead of silently passing.

---

## Bundle thesis

**A gate check that could not run must fail CLOSED, not subtract to green — reusing the R-SZGB-B
uncertifiable-baseline refusal at per-check granularity.** One narrow classifier + existing fail-closed
path, no new gate/flag/state/event. Completes the R-SZGB fail-OPEN closure (project-level → check-level).

## Out of scope
- R-SZGB-A/B/C (shipped beta.39) and the option-3 `typecheck` script (`c5c7125f`) — unchanged.
- Broadening `gate-commands.json` cmdMap fallbacks (e.g. `npx tsc` when no npm script) — a valid separate
  enhancement, but this bundle's fail-CLOSED invariant is the durable safety net regardless of cmdMap
  coverage; do not couple them.
- The closer's full release gate (unchanged — authoritative backstop).
- The LLM principle-metric convergence judge (orthogonal).
