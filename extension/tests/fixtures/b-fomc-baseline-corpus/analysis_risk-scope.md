# PRD Analysis: Risk & Scope Auditor Morty (Cycle 3)

**Date**: 2026-07-14
**Analyst**: Risk & Scope Auditor Morty
**Cycle**: 3

## Executive Summary

Cycle 2 I found WS-4's abort-by-default. Cycle 3 I traced the halt path end-to-end and found the thing that actually kills this bundle: **the exit-code choice and the halt-classification choice are COUPLED, there are three reachable combinations, two of them are wrong, and AC-RLH-2..4 permit all three.** `logPhaseHaltReason` (`pipeline-runner.ts:3797`) is only reached on a **non-zero** exit — so a worker who "fixes" the abort by adding `stalled_below_target` to the exit-code success allowlist makes the phase exit 0, the halt classifier is **never consulted**, the pipeline continues, and **the lie comes back wearing a better name.** The naive repair of defect A *is* defect B. Only one combination is correct, it is the shipped `anatomy_non_convergent` shape (exit **1** + an explicit `run-finalize-gate-incomplete` branch), I verified it end-to-end, and **the PRD names neither half of it.**

Underneath that: `stalled_below_target` must be hand-decided at **six** declaration sites, of which **exactly one is type-coupled** — so tsc protects nothing. And the mis-tier I called a "budget bet" in Cycle 2 is worse than that: **`small` skips `test:fast`, and `test:fast` is the ONLY thing that catches WS-4's silent always-converged regression.** A false cost estimate ("~30 LOC, no new machinery") → a `small` tier → the 30 assertions never run → **the microverse loop converges on iteration 1, every run, and ships green.**

I also **retract one Cycle-2 mechanism** (the `ExitReason` "different union" claim — it is a local alias; the conclusion survives, the reasoning does not) and **harden, rather than soften, my ac_shape_smells position** against both colleagues.

---

## Critical Gaps (P0 — Must Fix)

### 1. The exit-code and the halt-classification are COUPLED — three reachable combos, two are wrong, and the ACs permit all three

This supersedes and sharpens my Cycle-2 P0-1. I traced the whole path.

**The gate that decides whether the halt classifier runs at all** (`pipeline-runner.ts:3797-3806`, verified verbatim):

```ts
export function logPhaseHaltReason(runtime, rawPhase, exitCode, log): 'abort' | 'run-finalize-gate' | 'run-finalize-gate-incomplete' {
  const haltMsg = `Phase ${rawPhase} failed (exit ${exitCode}) — stopping pipeline`;
  ...
  if (exitCode === 0 || (rawPhase !== 'anatomy-park' && rawPhase !== 'szechuan-sauce')) {
    ... log(haltMsg); return 'abort';                 // ← never consults classifyMicroverseHaltDecision
  }
  ... const decision = classifyMicroverseHaltDecision(runnerState.exit_reason);   // ← only reachable on exit != 0
```

So `classifyMicroverseHaltDecision` is consulted **only when the phase exits non-zero** *and* the phase is `anatomy-park` or `szechuan-sauce`. The exit code is produced by `microverseExitCode` (`microverse-runner.ts:4570-4573`, verified verbatim):

```ts
function microverseExitCode(exitReason: ExitReason): number {
  const successfulReasons: ExitReason[] = ['converged', 'stopped', 'limit_reached', 'approach_exhaustion', 'no_progress'];
  return successfulReasons.includes(exitReason) ? 0 : 1;
}
```

**The three combinations a worker can reach while being AC-complete on AC-RLH-2..4:**

| # | What the worker does | Exit code | Halt classifier | Field outcome |
|---|---|---|---|---|
| **A** | Adds the enum member + producer, stops (**literally AC-complete**) | **1** (absent from allowlist) | reached → no branch matches → falls through `pipeline-runner.ts:4062` → `{action:'abort', recognizedExitReason:null}` | **Pipeline ABORTS. Finalize gate never runs. Real landed work is never finalized.** Strictly worse than today. |
| **B** | Notices the abort, "fixes" it by adding `stalled_below_target` to `successfulReasons` | **0** | **NEVER CALLED** (`exitCode === 0` short-circuits at `:3802`) | **Pipeline continues as SUCCESS. The phase reports a stall as a clean exit. THE ORIGINAL LIE, RENAMED.** Ships green on every AC. |
| **C** | Leaves it OUT of `successfulReasons` (exit 1) **AND** adds an explicit `run-finalize-gate-incomplete` branch to the classifier | **1** | reached → explicit branch → `run-finalize-gate-incomplete` | **Non-fatal, honest halt. The finalize gate runs. Correct.** |

**Combo B is the trap, and it is the one a competent worker walks into.** They ship A, see the pipeline abort in their own verify run, diagnose "the exit code is wrong," add the reason to `successfulReasons` — the *nearest, most obvious* fix — and land B. B satisfies AC-RLH-2, AC-RLH-3, AC-RLH-4, and even AC-RLH-6 as currently worded (*"reports an honest non-converged disposition rather than `status: "converged"`"* — under B the **disposition string** is `stalled_below_target`, so the AC is **literally satisfied**, while the **pipeline behaviour** is byte-identical to today's bug). **The bundle's own thesis test goes green over the bug it exists to kill.**

**Combo C is provably right, and I verified the precedent end-to-end.** `anatomy_non_convergent` is (i) in the `MicroverseExitReason` union (`types/index.ts:1284`), (ii) **NOT** in `successfulReasons` (`microverse-runner.ts:4571`) → **exit 1**, (iii) **NOT** in `MICROVERSE_FATAL_REASONS` (`:1286-1290`), (iv) **NOT** in `MICROVERSE_FAILURE_REASONS` (`:1294-1297`), (v) handled by its **own explicit branch** at `pipeline-runner.ts:4050-4052` → `run-finalize-gate-incomplete`. That is the complete, shipped shape. **Mirror all five facts, not the first one.**

**Fix — replace AC-RLH-4b with this (paste-ready):**

> `AC-RLH-4b` **(the disposition is a COUPLED PAIR — exit code AND halt branch; getting one right and the other wrong is a shipped bug)**:
> `stalled_below_target` mirrors `anatomy_non_convergent` at **all five** of its declaration sites, and a test asserts each:
> 1. It joins the `MicroverseExitReason` union (`types/index.ts:1279-1284`). *(The only site tsc knows about.)*
> 2. It is **NOT** added to `successfulReasons` (`microverse-runner.ts:4571`) → `microverseExitCode('stalled_below_target') === 1`. **Assert this deliberately.** Adding it there makes the phase exit **0**, which means `logPhaseHaltReason` (`pipeline-runner.ts:3802`) **short-circuits and never consults the halt classifier at all** — the pipeline continues as a success and the stall-reported-as-success bug is **reintroduced under a new name**. This is the single most likely wrong turn in the bundle.
> 3. It is **NOT** in `MICROVERSE_FATAL_REASONS` (`types/index.ts:1286-1290`).
> 4. It is **NOT** in `MICROVERSE_FAILURE_REASONS` (`types/index.ts:1294-1297`) → `isMicroverseFailureExit('stalled_below_target') === false`. *(Membership routes it to `abort` via `pipeline-runner.ts:4053-4061`.)*
> 5. `classifyMicroverseHaltDecision('stalled_below_target')` returns **`{ action: 'run-finalize-gate-incomplete', recognizedExitReason: 'stalled_below_target' }`** — via an **explicit branch co-located with the `anatomy_non_convergent` branch at `pipeline-runner.ts:4050-4052`**. Without it the function falls through to `:4062` → `{action:'abort', recognizedExitReason:null}` → **the pipeline aborts and the finalize gate never runs**, destroying finalization of real landed work.
>
> **Builder note (non-negotiable):** `classifyMicroverseHaltDecision` takes `exitReason: unknown`, `successfulReasons` is a plain array literal, and `MICROVERSE_FATAL/FAILURE_REASONS` are hand-maintained lists. **Adding the union member raises ZERO tsc errors at sites 2–5.** There is no exhaustiveness check anywhere on this path. The ACs are the only guard.

**Add to `## Risks` (paste-ready):**

> - **WS-4 disposition coupling (the bundle's highest-severity risk).** The exit code and the halt branch are a **pair**. Get only the branch right → the phase exits 1, the classifier is reached, fine. Get only the exit code "right" (`successfulReasons`) → **the classifier is never called** (`pipeline-runner.ts:3802` short-circuits on `exitCode === 0`) and **the stall-as-success lie ships intact under a new name, green on every AC including AC-RLH-6.** Get neither → the pipeline **aborts** before the finalize gate. **Two of three reachable outcomes are worse than today's bug.** Mitigation: `AC-RLH-4b` asserts all five sites. No tsc exhaustiveness protects any of them.

### 2. The mis-tier is not a budget bet — `small` skips `test:fast`, and `test:fast` is the ONLY thing that catches WS-4's silent always-converged regression

Cycle 2 I called the false "~30 LOC, no new machinery" cost estimate a P0 *scope misrepresentation* whose harm was a worker-timeout risk. That undersold it. Here is the actual chain, and it ends in a green ship over a catastrophic regression.

**The regression.** Under AC-RLH-3, `isConverged` returns an **object**. The two source callers are **truthiness tests**, verified:
- `microverse-runner.ts:4164` — `if (!isConverged(state)) return null;`. `return null` means *"keep iterating."* With an object return, `!object` is **always `false`** → **the guard never fires** → control **always** falls through to `return 'converged'` (`:4169`).
- `microverse-runner.ts:3629` — `if (isConverged(state))` → **always true.**

Concretely: **the microverse/szechuan loop runs exactly ONE iteration and declares `converged`, on every run, forever.** That is not "a subtle always-truthy bug" — it is a total loss of the optimization loop, and it is **a strictly worse version of the exact bug this bundle exists to fix.** It **compiles clean**; tsc flags neither call site.

**The only thing that catches it** is the ~30 `assert.equal(isConverged(...), true|false)` boolean assertions across **four** test files (`tests/microverse.test.js`, `tests/microverse-convergence.test.js`, `tests/szechuan-sauce.test.js`, `tests/integration/microverse-convergence.test.js`), every one of which breaks loudly the moment the return is an object.

**The chain that ships it green:**

> PRD says *"~30 LOC, no new machinery"* → refinement tiers WS-4 **`small`** → **`small` skips `test:fast` entirely** (the tiering contract: *"Tier is a BET on … which test tiers the gate runs; `small` skips `test:fast` entirely"*) → **the ~30 assertions never run in the worker gate** → the truthiness callers are never exercised → **always-converged lands, the worker's gate is green, and AC-RLH-2/3/4 are all satisfied.**

So the false cost estimate does not merely risk a timeout. **It disables the one detection mechanism for the worst regression the bundle can produce.** That is why "~30 LOC" is a P0 and not a copy-edit.

**Fix (paste-ready):**

> **Strike "~30 LOC, no new machinery" from the WS-4 section.** Real inventory: 2 truthiness-testing source callers (`microverse-runner.ts:3629`, `:4164`) + **~30 boolean assertions across 4 test files** + 3 exit-reason declarations (`types/index.ts:1279`, `:1286`, `:1294`) + 2 divergent success allowlists (`microverse-runner.ts:4571`, `:4598`) + the halt classifier (`pipeline-runner.ts:4041-4062`) + the pinned export inventory (`src/services/CLAUDE.md:78`, policed by `audit-subsystem-claude-md.sh`).
> **WS-4 is `complexity_tier: large`. It MUST NOT be tiered `small`** — `small` skips `test:fast`, and the ~30 `assert.equal(isConverged(...), boolean)` assertions in `test:fast` are the **only** detector for the silent always-converged regression: both source callers test **truthiness**, so an object return makes `microverse-runner.ts:4164`'s `if (!isConverged(state)) return null;` **never fire**, and the loop declares `converged` after **one** iteration on **every** run. tsc does not flag it. A `small` tier ships it green.
> **All four test files are co-scoped into WS-4's allowlist** — this is not scope hygiene, it is the detection mechanism.

### 3. `stalled_below_target` must be hand-decided at SIX sites; tsc knows about ONE — and I retract my Cycle-2 explanation of why

**Retraction first.** Cycle 2 I wrote that `microverseExitCode` is *"typed against the pickle-phase `ExitReason` union, NOT `MicroverseExitReason`."* **That is false.** `microverse-runner.ts:84` reads:

```ts
type ExitReason = MicroverseExitReason;
```

It is a **local alias for the same union.** My mechanism was wrong. **The conclusion is unchanged and the real reason is worse**, because it is not a fixable type mismatch — it is a *structural* absence of exhaustiveness:

| # | Site | Declaration form | Does tsc force an update? |
|---|---|---|---|
| 1 | `MicroverseExitReason` union — `types/index.ts:1279-1284` | `type` union | **Yes** — the only one |
| 2 | `MICROVERSE_FATAL_REASONS` — `types/index.ts:1286-1290` | `as const` **array literal** | **No** |
| 3 | `MICROVERSE_FAILURE_REASONS` — `types/index.ts:1294-1297` | `new Set<MicroverseExitReason>([...])` — typed, **not exhaustive** | **No** |
| 4 | `successfulReasons` — `microverse-runner.ts:4571` | `ExitReason[]` **array literal** + `.includes()` | **No** |
| 5 | `successfulReasons` — `microverse-runner.ts:4598` | **raw `new Set([...])` — no type at all** (see P1-1) | **No** |
| 6 | `classifyMicroverseHaltDecision` — `pipeline-runner.ts:4041` | `(exitReason: unknown)` **if-chain with an abort fallthrough** | **No** |

**One of six.** Adding the union member compiles clean and silently mis-routes at five sites. This is precisely the class of defect the bundle's thesis names ("a value written and never read") — and the bundle would add a sixth instance of it unless every site is an explicit AC. **This is the strongest possible argument that AC-RLH-4b must enumerate sites by file and line rather than saying "wire it through."**

### 4. AC-RLH-6 is satisfiable by the bug (Combo B) — the thesis test does not test the thesis

AC-RLH-6 asserts szechuan *"reports an honest non-converged **disposition** rather than `status: "converged"`."* Under **Combo B** (P0-1) the disposition string **is** `stalled_below_target` and the AC goes **green** — while the phase exits **0**, the halt classifier is never called, and the pipeline proceeds exactly as it does today. **The AC tests the label, not the behaviour.** A test that a lying system passes is not a thesis test.

Requirements Morty correctly found AC-RLH-6 is **unowned** (no workstream); I found in Cycle 2 that the per-ticket scope fence makes it **unbuildable** across five one-WS tickets. Cycle 3 adds the third and worst: **even once owned and built, as worded it does not discriminate the fix from the bug.**

**Fix (paste-ready), replacing AC-RLH-6's szechuan clause:**

> `AC-RLH-6` (szechuan arm): drive `handleMetricMode` over an **injected** `MicroverseSessionState` (`convergence_target: 0`, `key_metric.direction: 'lower'`, last-accepted score 4, `stall_counter >= stall_limit`) — **stubbed, no live judge**; `isConverged` reads state only (`microverse-state.ts:390`), so no judge seam is required and the test is deterministic (`test:integration` tier). Assert **all three**, not just the first:
> (i) the disposition is **exactly `stalled_below_target`** (not merely "≠ `converged`" — an `error` or an abort also satisfies that, and both are *different lies*);
> (ii) `microverseExitCode('stalled_below_target') === 1` — **the phase does NOT exit 0**; an exit-0 stall bypasses the halt classifier entirely (`pipeline-runner.ts:3802`) and is behaviourally **identical to today's bug**;
> (iii) `classifyMicroverseHaltDecision('stalled_below_target')` → `{ action: 'run-finalize-gate-incomplete', recognizedExitReason: 'stalled_below_target' }` — **not** the `:4062` fallthrough to `abort`/`null`.
> **A build satisfying only (i) is the bug with a better name and MUST fail this AC.**
> **Ownership:** AC-RLH-6 is owned by **WS-4**, whose allowlist is co-scoped to include the thesis-test file and `pipeline-runner.ts`. Leaving it unowned across five one-WS tickets means the per-ticket scope fence blocks whichever ticket attempts it → zero commits.

### 5. Still no `## Rollback` and no kill-switch — for a 5-WS bundle carrying three fail-closed flips, against this repo's own documented convention

Carried from Cycle 2, **unresolved**, and now with the convention verified in source rather than in docs. The repo has at least **six** shipped `=== 'off'` kill-switches:

```
src/bin/setup.ts:210               PICKLE_CODEGRAPH === 'off'
src/bin/archaeology.ts:233         PICKLE_ARCHAEOLOGY_AUTO_REFRESH === 'off'
src/bin/monitor.ts:912             PICKLE_MONITOR_WATCHDOG === 'off'
src/lib/plumbus-kill-switch.ts:5   PLUMBUS_GENERATIVE_AUDIT === 'off'
src/services/orphan-reaper.ts:310  ORPHAN_REAP_ENV_VAR === 'off'
src/bin/spawn-morty.ts:189         (env value 'off')
```

Every one guards a behavior that can halt or degrade a run. This bundle introduces **three** ways to halt a previously-passing pipeline — WS-2's caller assertions, WS-5(b)'s manifest fail-close, and (per P0-1, *unintentionally*) WS-4's abort-by-default — and gives the operator **zero** levers. Under the standing "launch unattended, multi-hour" posture, a fail-closed flip with no kill-switch is an **operational defect**, not a design preference: the failure mode is a 4-hour run wedged at 2am with nothing to turn off.

**Fix — add a `## Rollback` section (paste-ready):**

> **## Rollback**
> Each **deliberate** fail-closed flip gets an operator kill-switch per the repo's shipped `PICKLE_*=off` convention (literal lowercase `"off"`; any other value / absent = feature active — see `plumbus-kill-switch.ts:5`, `orphan-reaper.ts:310`, `setup.ts:210`).
> - `PICKLE_AC_PHASE_GATE=off` — WS-5(b): restores the fail-open branch at `ac-phase-gate.ts:197-200`. **Mandatory**: a fail-closed gate whose producer regresses bricks **every** run at `spawn-refinement-team.ts:1127`.
> - `PICKLE_GATE_LOCKOUT_STRICT=off` — WS-2: restores the callers' early-return-without-failure. Escape hatch if a benign transient lockout under contention false-halts runs.
> - **WS-4 gets NO switch** — iff `AC-RLH-4b` lands, its halt is the non-fatal `run-finalize-gate-incomplete`, which needs no escape hatch. If WS-4 ships without the explicit halt branch it is an **abort-by-default: that is a bug, not a flag-able feature.** Do not paper over P0-1 with a kill-switch.
> **Revert unit:** one workstream = one ticket = one commit; `git revert` per WS is the coarse rollback. State this so a 2am operator does not have to derive it.

---

## Important Gaps (P1 — Should Fix)

- **P1-1 (NEW). A SIXTH, untyped success allowlist that no analyst has named — and it rewrites an honest stall into `error`.** `markMicroverseFatalError` (`microverse-runner.ts:4598`) carries a **second, divergent** success set:
  ```ts
  const successfulReasons = new Set(['converged','stopped','limit_reached','approach_exhaustion','no_progress','completed','success']);
  ```
  It is a **raw `Set<string>` with no union type at all**, and it contains `'completed'` and `'success'` — **neither of which is a member of `MicroverseExitReason`**. It is already drifted. Its job: on a finalizer crash, decide whether to **preserve** the recorded exit reason or **overwrite** `mv.exit_reason` to `'error'`. With `stalled_below_target` absent, a finalizer crash after an **honest stall** silently **rewrites the honest disposition to `error`** — converting the bundle's new honesty into a fabricated failure, inside a bundle about not fabricating dispositions. **The ticket must make an explicit, justified decision here** (recommend: **preserve** — an honest stall is a real recorded outcome, not a finalizer artifact; note this is a *different* question from `microverseExitCode`'s, and the two sets are **already divergent by design**, so do NOT "unify" them as a drive-by). Add the site to WS-4's allowlist and to AC-RLH-4b's enumeration.

- **P1-2. AC-RLH-4's `targetHit` reuse mandates a predicate that CONTRADICTS shipped, passing tests.** Re-verified verbatim at `microverse-runner.ts:4165-4167`: `classification.kind === 'improved' && convergence_target != null && classification.metric.score === state.convergence_target` — a strict `===`, additionally gated on `'improved'`. `isConverged` (`microverse-state.ts:390-401`) is **direction-aware**: `direction === 'lower' ? currentScore <= target : currentScore >= target`. Corroborating receipts (shipped, green today): `tests/szechuan-sauce.test.js:271-285` (*overshoot, lower direction* → `isConverged === true`) and `:288-301` (*overshoot, higher direction* → `isConverged === true`). Under AC-RLH-4 as literally written, both report `stalled_below_target` — **and then (per P0-1, Combo A) abort the pipeline.** AC-RLH-4 must **forbid reuse of `targetHit` by name and line** and derive the disposition **solely** from the AC-RLH-3 discriminant. Its only live consumer is the log-string template at `:4168`, so deleting it is free. Requirements Morty's four-row total-predicate table (stall-above-target / lower-overshoot / held-at-target / **null-target — DECIDE AND STATE**) is the right instrument; I endorse it without duplicating it.

- **P1-3. The bundle's stated reason for existing — "the fixes touch *disjoint files*" — is FALSE.** `## Why these three together` uses disjointness to argue the workstreams "do not contend." But WS-1 must delete remediation class **(e)** at `spawn-gate-remediator.ts:125` (hard-pinned to the exact `banned-construct:brace-free-if` finding id WS-1 deletes) while WS-2 rewrites the lock in **the same file**. Two tickets, one file → the `check-scope-diff` preflight **blocks whichever runs second**, or they race. This is a **scope claim**, not a code nit: the PRD's justification for bundling is wrong, and the consequence is a **zero-commit deadlock**. Fix: delete the disjointness claim; declare a hard `depends_on` ordering (WS-1 → WS-2); co-scope `spawn-gate-remediator.ts` into the second ticket's allowlist; do not run them in parallel.

- **P1-4. "Subtract the `skip_quality_gates_reason` bypass" is an unbounded directive aimed at a GLOBAL flag.** Re-verified per-file counts: `mux-runner.ts` **14**, `spawn-refinement-team.ts` **6**, `check-readiness.ts` **2**, `pipeline-runner.ts` **2**, `types/index.ts` **2**, `recovery-controller.ts` **1** — **6 source files, 27 hits**, plus `activity-events.schema.json`. Citadel only **reads** it (the 2 hits in `pipeline-runner.ts`). The flag is **written by the root-`CLAUDE.md` Step 0 creation-heavy heuristic** and carried by `bundle_bootstrap_exemption_applied`. A worker reading "subtract the bypass" as "delete the flag" **destroys the bundle-bootstrap-exemption surface — the mechanism this very session's launch may depend on.** Re-scope to: *"delete **citadel's read** of the flag (`pipeline-runner.ts:2653-2675` + the `mechanical` filter at `:2699-2701`). The flag itself and its other five consumers are explicitly **OUT OF SCOPE**."*

- **P1-5. WS-5's fork still rests on false evidence, and option (b)'s fail-closed as written bricks every run.** Both facts are Codebase Morty's; I escalate them into the **risk register** because they are a *decision* defect, not a code defect. (i) The amendment's *"appears exactly once in the entire repository … zero producers, zero in `tests/`"* matched the **string literal**, not the symbol: I re-verified that `runAcPhaseGate` has **4 call sites** (`spawn-refinement-team.ts:1127`, `:2279`; `pipeline-runner.ts:4021`; `finalize-gate.ts:380`), plus an export-inventory pin at `src/services/CLAUDE.md:56` and 2 trap-door INVARIANTs policed by the **release-gate** `audit-trap-door-enforcement.sh`. **AC-RLH-5 currently invites a worker to pick option (a) on the strength of a wrong grep** — ~10× the represented blast radius. (ii) The fail-open is one unconditional line (`ac-phase-gate.ts:197-200`, verified), and the **first** caller is `evaluationPhase: 'pre-refinement'` at `spawn-refinement-team.ts:1127` — **before refinement can have written anything.** A blanket fail-closed flip **halts every run at the pre-refinement gate: no session can start.** **Fix: strike option (a); resolve to (b); phase-scope the fail-closed** (`pre-refinement` stays fail-OPEN; `post-refinement`/`per-phase`/`bundle-end` fail closed); make **producer-before-gate deploy order part of the AC**. The `AcEvaluationPhase` type already encodes the ordering — no new flag or sentinel is needed.

- **P1-6. WS-3's whole value rests on an undocumented external assumption, and the PRD's own mitigation may be false.** Carried, still unaddressed, now sharper. Ledger population — WS-3's entire point — requires the **LLM judge to comply** with a new `{score, violations[]}` contract. If it keeps emitting bare integers or wraps the object in prose/markdown fences, `JSON.parse` routes to `emptyJudgeResult('malformed')`, the ledger stays `[]`, and **WS-3 passes its structural AC (the prompt text changed) while changing nothing the field notices** — the *exact* failure the amendment header warns about. Worse: Codebase Morty found the real prompt block (`microverse-runner.ts:1656-1660`) contains **`'Do NOT add units or explanations after the number.'`**, which is **flatly incompatible** with asking for an object — and the PRD's stated mitigation (*"`extractScore`'s line-oriented fallback is PRESERVED, so the worst case is today's behaviour"*) **only holds if the new contract still guarantees a trailing bare number for the fallback to find.** If it does not, **the stated mitigation is not true and the fallback is dead on arrival.** Fix: state the assumption; require the new contract to retain a trailing bare-number line; test **both** shapes; and add Requirements Morty's `AC-RLH-7` (a **positive**, non-empty violations ledger on a **stubbed** judge run — a risk you can convert into a green test is not a risk).

- **P1-7. The `eslint curly` premise is an external-config dependency, not a fact in amber.** WS-1's entire justification is "eslint configures no `curly` rule and exits 0 on every flagged file." True today. It is an assumption about a config file any unrelated PR can change. Cheap to re-check, expensive to assume: **require the ticket to re-verify at build time** rather than inherit the PRD's snapshot.

---

## Minor Issues (P2 — Nice to Fix)

- **Retraction (Cycle 2 → 3).** I claimed `microverseExitCode` is *"typed against `ExitReason`, a **different** union from `MicroverseExitReason` — tsc will NOT flag a missing entry."* **Wrong.** `microverse-runner.ts:84` is `type ExitReason = MicroverseExitReason;` — a **local alias for the same union**. The conclusion (no tsc protection) survives, but for a **structural** reason: `successfulReasons` is a plain **array literal**, not an exhaustive `Record`, so a union member can be added with no compiler complaint. See P0-3. Correcting this matters — a builder told "wrong union" would hunt for a type mismatch that does not exist, find nothing, and conclude the risk was imaginary.
- **Retraction (Cycle 2).** I flagged the `2.1.0-beta.2` deployed-runtime pin as possibly stale. Verified with Codebase Morty: source `package.json`, deployed `package.json`, and `git describe --tags` all agree. **The pin is accurate; my concern is withdrawn.** Keep the "re-verify at launch" note (cheap), drop the doubt.
- `MICROVERSE_FATAL_REASONS` (`types/index.ts:1286-1290`) contains `'session_state_corrupted'`, which is **not a member of `MicroverseExitReason`** (`:1279-1284`). Pre-existing drift; the array is `as const`, not typed to the union, so it is harmless and **out of scope** — but WS-4 is the ticket staring straight at this declaration. Mark it **known and deliberately untouched**, or a worker "helpfully" fixes it and blows its scope fence. (Same for the `'completed'`/`'success'` drift in P1-1's set — **decide, don't unify.**)
- The `## Risks` section still contributes **zero rows for WS-4 and WS-5** — the amendment added the two highest-risk workstreams and no risks for either. Four of this analysis's five P0s are rows those workstreams should already have carried.
- `AC-RLH-5`'s machine check `grep -rc "ac-phase-manifest" extension/src/ == 0` is **malformed** — `grep -rc` over a directory emits **per-file** counts, never a single total, so it can never compare to `0`. Use `! grep -rq "ac-phase-manifest" extension/src/`. Moot once option (a) is struck, but do not leave an inexecutable predicate in an AC.
- The R-LSPC-2 note (`sameLock` = inode **AND** bytes, never the inode number alone — ext4 recycles inodes) is precise and correctly cited. **Keep it verbatim in the WS-2 ticket.** It remains the highest-value landmine warning in the PRD.

---

## ac_shape_smells

```json
{ "ac_shape_smells": [], "tickets": [] }
```

_No endpoint-enumeration smells — **and I am hardening this position, not softening it, after reading both colleagues' Cycle-2 JSON.** Both emitted the WS-2 caller triad (`pipeline-runner.ts:2560`, `finalize-gate.ts:258`, `microverse-runner.ts:302`) as a smell. I agree with their **conclusion** (ONE parametrized ticket, `describe.each` over the call sites) but **not** with classifying it as a smell, and the distinction is operationally load-bearing: a "smell" is an instruction to a refiner to **collapse a fan-out**, and there is no fan-out here to collapse — the PRD **already** scopes all three callers into a single workstream, and the amendment says "**The ticket** MUST add the caller-side assertions" (singular). **Emitting it as a smell invites a refiner to "resolve" it by SPLITTING it per-caller — the exact opposite of what all three of us want**, and a split would leave the false-GREEN reachable via the untouched siblings while no single split ticket could be verified against the bundle's thesis. Same reasoning for the WS-4 `isConverged` caller set (2 source callers + ~30 test assertions across 4 files): **one ticket**, per registration co-location; AC-RLH-3 already carries a universal quantifier ("every caller is updated") and names no endpoints in its body. **The operative instruction to refinement is: do NOT split either set per-caller.** That is a scope constraint, and it belongs in prose (above), not in a smells array whose semantics are "fan this out or justify why not."_

_One correction to both colleagues' triad, which their tickets must absorb: **the PRD is WRONG that all three callers are broken.** I verified independently — `microverse-runner.ts:301-303` returns `{ success: false }` and it **IS** consumed at `:679-681` (`if (remediationOutcome.success) return opts.currentMv;` → otherwise falls through to `recordPerIterationGateRegression`). **That call site is already honest** and needs a **characterization pin**, not a fix. And `finalize-gate` is **worse** than the PRD says: the lockout path returns `{ code: null, result }` (`:319`) and the **success** path — after `spawnStrictRemediator` — returns `{ code: null, result }` (`:323`). **Byte-identical.** The caller cannot structurally distinguish "I spawned a remediator" from "I was locked out and did nothing." The fix is a **discriminated** result, not merely a non-null one. A worker told "add a caller-side assertion" to a **correct** call site will either no-op or damage it._

---

## Specific Recommendations

Ranked by what stops this bundle from shipping green-and-broken. Paste-ready language is inline in each P0.

1. **Replace `AC-RLH-4b` with the five-site coupled-pair AC** (P0-1). The exit code and the halt branch are a **pair**; the "obvious" fix for the abort (adding the reason to `successfulReasons`) makes the phase exit **0**, which means the halt classifier is **never called** (`pipeline-runner.ts:3802`) and **the original lie ships under a new name, green on every AC including the thesis test.** Mirror `anatomy_non_convergent` at **all five** sites — union ✅, `successfulReasons` ❌ (exit 1), fatal ❌, failure ❌, explicit `run-finalize-gate-incomplete` branch ✅. **Highest-value edit in this analysis.**

2. **Strike "~30 LOC, no new machinery"; tier WS-4 `large`; co-scope all four test files** (P0-2). Not a budget nit: **`small` skips `test:fast`**, and `test:fast`'s ~30 `assert.equal(isConverged(...), boolean)` assertions are the **only** detector for the silent always-converged regression (`microverse-runner.ts:4164`'s `if (!isConverged(state)) return null;` **never fires** against an object return → the loop converges after **one** iteration, every run, and tsc says nothing).

3. **Rewrite AC-RLH-6 to assert behaviour, not the label** (P0-4), and **assign it to WS-4, co-scoped**. As worded it is satisfied by Combo B — the bug with a better name. Assert the disposition **string**, the **exit code (1)**, and the **halt action (`run-finalize-gate-incomplete`)**. Stub the judge (`isConverged` reads state only — no judge seam needed; `test:integration`, deterministic). An unowned thesis test is an unbuildable thesis test; a label-only thesis test is a useless one.

4. **Resolve WS-5 at refinement: option (b), phase-scoped fail-closed, producer-before-gate** (P1-5). **Strike option (a)** — its evidence was a grep on the string literal, not the symbol. And a *blanket* fail-closed **bricks every run** at `spawn-refinement-team.ts:1127` (`pre-refinement` runs before any manifest can exist).

5. **Add a `## Rollback` section with `PICKLE_*=off` kill-switches** for the two **deliberate** fail-closed flips (P0-5), per the six shipped switches already in `src/`. **WS-4 gets no switch** — if it needs one, `AC-RLH-4b` did not land, and that is a bug, not a feature.

Plus three prose corrections that are **scope claims, not nits**:
- **Delete the "disjoint files" claim** — WS-1 and WS-2 collide on `spawn-gate-remediator.ts` (`:125` vs the lock). Replace with an explicit `depends_on` ordering + co-scoping, or the scope fence deadlocks the bundle at **zero commits**.
- **Re-scope "subtract the `skip_quality_gates_reason` bypass"** to "delete **citadel's read** of the flag." The flag is global (6 files, 27 hits) and is **written by the root-`CLAUDE.md` Step 0 heuristic** that may be governing this very launch.
- **Correct the WS-2 blast-radius note**: **two** callers read a lockout as success, not three. `microverse-runner.ts:301-303` is **already honest** (`{success:false}`, consumed at `:679`) and needs a characterization pin. `finalize-gate`'s lockout return is **byte-identical to its success return** (`{code:null}` at both `:319` and `:323`) — it needs a **discriminated** result.

---

## Cross-Reference Notes

**From Requirements Morty.** Their P0 — **AC-RLH-6 is owned by no workstream** — is correct and structurally decisive; I endorsed it in Cycle 2 and extend it in Cycle 3 with the third failure: **even once owned, as worded it is satisfied by the bug** (Combo B). Their AC-RLH-4 **total-predicate** rewrite (four rows, including the `convergence_target == null` class the AC's own guard *actively excludes*) is the right instrument and I adopt it wholesale rather than restate it. Their **AC-RLH-7** (a *positive*, non-empty violations ledger on a **stubbed** judge) correctly converts my Cycle-1/2 WS-3 *risk row* into a *green test* — **a risk you can convert into a test is not a risk**, and their framing supersedes mine. Their P0 on the **Simplification Review's false minimality claims** matters in my domain for one reason: that section is what refinement reads to **assign complexity tiers**, and **both** false claims push tiers **downward** — which, per my P0-2, is the mechanism that disables `test:fast` and ships the always-converged regression. **Two false minimality claims → a `small` tier → a green catastrophic bug.** That is the whole chain, and it is why I escalated their documentation finding onto my critical path.

**From Codebase Morty.** Three of their findings are **scope defects wearing code costumes**, so I carry them in the risk register rather than duplicating: the false **"disjoint files"** bundling justification (P1-3), the **WS-5 false grep** that makes option (a) look cheap enough for a worker to pick (P1-5), and the **`skip_quality_gates_reason` global-flag trap** (P1-4 — per-file counts re-verified independently: 6 files, 27 hits). Their **retraction of their own Cycle-1 P0** — that `audit-citadel-wiring` is *itself* a never-fired guard (synthetic-`os.tmpdir()`-only tests, absent from the release gate, already reporting an unactioned `wired: false`) — is the best finding across all three analysts this cycle, and it has a **risk consequence** they understated: **WS-1 has no gate forcing the hollow-analyzer question**, so the PRD must *specify* the resolution by construction rather than assume an audit will catch it. Their `microverse-runner.ts:302` retraction (**already honest**) corrects the PRD, both of my prior cycles, and Requirements Morty's ticket — I verified it myself at `:301-303` and `:679-681` and folded it into my smells prose.

**Where I went past both, again.** Both analysts stopped at *"`classifyMicroverseHaltDecision` falls through to abort."* True — I said it first in Cycle 2 — but **incomplete, and the incompleteness is dangerous.** Neither traced **who calls the classifier.** I did: `logPhaseHaltReason` (`pipeline-runner.ts:3797`) **only reaches it on a non-zero exit** (`:3802`). That one line converts the finding from *"the worker might forget a branch"* into *"the worker's most natural repair of the abort re-introduces the original bug, and the thesis test goes green over it."* **Combo B is the bundle's actual most-likely failure mode**, and no one — including me, in two prior cycles — had named it. I also found the **sixth site** (`markMicroverseFatalError`'s raw, untyped, already-drifted success `Set` at `:4598`, which rewrites an honest stall into `error`), and I **retract my own Cycle-2 "different union" mechanism** — it is a local alias (`microverse-runner.ts:84`), and the real absence of type safety is structural, not a mismatch.

**Net.** Cycle 1: "B+ with three holes." Cycle 2: "C with six." Cycle 3: **the bundle, as specified, has a most-likely outcome that is worse than the bug it fixes** — a worker who satisfies every stated AC ships either a pipeline that aborts before finalizing real landed work (Combo A) or a phase that reports a stall as a clean success under a prettier name (Combo B), and **AC-RLH-6, the thesis test, goes green on Combo B.** The amendment's own warning — *"SHIPS GREEN AND LEAVES THE FIELD BUG REPRODUCING"* — has now recursed **twice**: once into the fix that was supposed to close it, and once into the test that was supposed to prove it.

<promise>ANALYSIS_DONE</promise>
