---
title: "B-RLH — Review-loop honesty: the review phases must not report success they did not earn"
priority: P2
finding: B-RLH
status: open
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
composes:
  - "p2-bug-fix-bundle-r-bcfr-banned-construct-fabricated-rule.md"
  - "p2-bug-fix-bundle-r-grls-gate-remediator-lock-strand.md"
  - "p2-bug-fix-bundle-r-jpcm-judge-prompt-parser-contract-mismatch.md"
depends_on: "none (deploy-agnostic BUILD; pipeline-safe — see Routing)"
source_assessment: "All three surfaced in ONE live pipeline run (session 2026-07-11-255ad373) and were each verified against source, not inferred. Field evidence in the composed PRDs."
---

# B-RLH — the review loop is lying about its own work

## Thesis (one sentence)

Three independent defects, one shape: **a review phase reports success it did not earn.**

- **[[R-BCFR]] — citadel reports work it can never do.** The `banned-construct` arms cite a rule
  (`"is banned by CLAUDE.md"`) that exists in **no** CLAUDE.md — the string is a hardcoded literal at
  `banned-constructs-audit.ts:129`. eslint configures no `curly` rule and exits 0 on every flagged file;
  brace-free `if` is the house style, including **inside the analyzer enforcing the ban**; and the scan
  reads changed diff lines only, so it **cannot converge**. Live cost: 3 citadel cycles → **43 findings,
  0 remediated**, and the remediator refused twice (`loop_detected: true`) — correctly.
- **[[R-GRLS]] — the gate remediator reports a red gate as handled.** Its hand-rolled lock writes **no
  payload** and cleans up only via `process.on('exit')` (which SIGKILL skips); on `EEXIST` it returns
  `{ok: false, exitCode: 0}` — it exits **clean** having remediated nothing. One abrupt death strands the
  lock and every later remediator is a silent no-op indistinguishable from success. A **false-GREEN gate.**
- **[[R-JPCM]] — szechuan reports "converged" when it stalled blind.** `buildJudgePrompt:1658` demands
  *"Output ONLY a single integer"*; `parseLlmJudgeOutput:1771` `JSON.parse`s it and expects
  `{score, violations[]}`. The bare number fails the object parse, so `violations` is **always empty**
  (5 × `judge_json_parse_failed` in one session), the ledger stays `[]`, `compareMetric` can never take the
  R-SLLJ-4 set-ops branch, and five real landed fixes scored `held: 4 vs 4`. The phase exited
  `status: "converged"` at score 4 against a target of 0.

This is the **honesty** half of the GA bar. A review phase that cannot fail is not a review phase.

## Why these five together

They are one thesis: **a review phase reports success it did not earn.**

**⚠ CORRECTION (2026-07-14, refinement cycle 3) — the original "the fixes touch DISJOINT FILES" claim was
FALSE, and it was the bundle's stated justification for bundling.** WS-1 must delete remediation class **(e)**
at `spawn-gate-remediator.ts:125` (hard-pinned to the exact `banned-construct:brace-free-if` finding id that
WS-1 deletes) **while WS-2 rewrites the lock in that same file.** Two tickets, one file ⇒ the
`check-scope-diff` preflight **blocks whichever runs second**, or they race. Left unstated, this deadlocks the
bundle at **zero commits**.

**Binding ordering (not advisory):**
- `WS-1 → WS-2` is a hard `depends_on`. They MUST NOT run in parallel.
- `spawn-gate-remediator.ts` is **co-scoped into WS-2's allowlist** (WS-2 runs second and owns the file's
  final state).
- WS-4 is co-scoped across `microverse-runner.ts`, `pipeline-runner.ts`, `types/index.ts`, **all four
  `isConverged` test files**, and `src/services/CLAUDE.md` (export-inventory pin). See WS-4 below — the
  co-scoping IS the detection mechanism, not scope hygiene.

Each workstream is subtract-or-reuse. See each composed PRD for the full root cause and its own
`## Simplification Review`.

## Workstreams

Refine **one ticket per workstream** (five); do NOT collapse them into an umbrella ticket.

| WS | Finding | Shape | Composed PRD |
|---|---|---|---|
| WS-1 | [[R-BCFR]] | **pure subtraction** — delete the `isBraceFreeIf` arm; verify-then-delete the `isNestedTernary` sibling (same fabricated citation). **The module itself SURVIVES** (`banned-casts-audit.ts:3-8` imports four helpers from it) — delete the ARMS + their wiring, and subtract the now-empty mechanical floor/classifier/bypass with them | `p2-bug-fix-bundle-r-bcfr-banned-construct-fabricated-rule.md` |
| WS-2 | [[R-GRLS]] | **reuse, not new machinery** — route the 4th lock through the three primitives that already exist (`acquireLockFile` / `reclaimDeadGateLock` / `releaseLockFile`); a lockout must not READ as a remediation — **including at the three callers that today read a lockout as success** | `p2-bug-fix-bundle-r-grls-gate-remediator-lock-strand.md` |
| WS-3 | [[R-JPCM]] | **make the prompt ask for the shape the parser already parses** — no new code path; the parser, ledger writer, set-ops branch, and prior-violations block are all already built and wired | `p2-bug-fix-bundle-r-jpcm-judge-prompt-parser-contract-mismatch.md` |
| **WS-4** | **stall≠success** | **reuse** — `isConverged` returns the same `true` for "gave up" as for "hit the target"; mirror anatomy-park's shipped `anatomy_non_convergent` disposition. **This, not the judge, is what reported `converged` at score 4 vs target 0** | *(this PRD — see Amendment)* |
| **WS-5** | **the dead fail-stop** | **decide: subtract or wire** — `ac-phase-manifest.json`, the pipeline's ONLY quality fail-stop, has zero producers anywhere and fail-opens to `pass`. It has never fired | *(this PRD — see Amendment)* |

**Note for WS-2:** the shared lock primitives changed under R-LSPC-2 (`acquireLockFile` now returns a
`LockHandle {ino, raw}`; identity is `sameLock` — inode AND bytes, never the inode number alone, because
ext4 recycles it). Reuse them **as they are now**; do not reintroduce an inode-number comparison.

**Note for WS-2 (blast radius — CORRECTED 2026-07-14 at refinement cycle 3):** the fix cannot live inside
`acquireLockfile` alone. On a stranded lock the remediator prints `LOCKOUT_PATH=` instead of `BRIEF_PATH=`
(`spawn-gate-remediator.ts:257-261`), and **no caller reads `LOCKOUT_PATH` at all** — it is written and never
consumed. But **it is TWO broken callers, not three** (the earlier note was wrong):

- `pipeline-runner.ts:2560-2563` — **BROKEN.** Bare `return;` on a missing `BRIEF_PATH`; the loop continues and the
  phase still exits 0.
- `finalize-gate.ts` — **BROKEN, and WORSE than described.** The lockout path returns `{ code: null, result }`
  (`:319`) and the **success** path — after `spawnStrictRemediator` — returns `{ code: null, result }` (`:323`).
  **Byte-identical.** The caller cannot structurally distinguish "I spawned a remediator" from "I was locked out
  and did nothing." The fix is a **discriminated** result, not merely a non-null one.
- `microverse-runner.ts:301-303` — **ALREADY HONEST. DO NOT 'FIX' IT.** It returns `{ success: false }` and that
  *is* consumed at `:679-681` (`if (remediationOutcome.success) return opts.currentMv;` → otherwise falls through
  to `recordPerIterationGateRegression`). It needs a **characterization pin** (a test locking in the existing
  correct behaviour), not a change. A worker told to "add a caller-side assertion" here will either no-op or
  damage a working call site.

**Keep the three callers in ONE ticket** (`describe.each` over the call sites). Do **NOT** split per-caller — a
split leaves the false-GREEN reachable via the untouched siblings, and no single split ticket could be verified
against the bundle's thesis.

---

## ▶ AMENDMENT (2026-07-14) — two workstreams added; the bundle as originally scoped SHIPS GREEN AND LEAVES THE FIELD BUG REPRODUCING

A pre-launch review (39-agent audit, all citations verified against source AND the deployed tree) found the
bundle's thesis correct and all three children still open at the exact cited lines — but found the bundle
**insufficient to satisfy its own thesis**. Two defects sit *underneath* the three children. Without them, the
review loop still cannot fail, and WS-3 in particular passes its acceptance test while changing nothing the
field would notice.

### WS-4 — the convergence check conflates STALLED with SUCCEEDED (the defect *under* R-JPCM)

`isConverged` (`services/microverse-state.ts:391`) returns the **same bare `true`** for stall-exhaustion as for
target-reached:

```ts
if (state.convergence.stall_counter >= state.convergence.stall_limit) return true;   // :391  — GAVE UP
// ... and the target-reached branch at :394-399 also returns true                    — SUCCEEDED
```

In `handleMetricMode`, `targetHit` (`score === convergence_target`) **is** computed (`microverse-runner.ts:4165-4167`)
— and then consumed **only inside a template literal to pick a log string** (`:4168`). The function returns
`'converged'` unconditionally (`:4169`). `MicroverseExitReason` (`types/index.ts:1279-1284`) carries no
stalled-below-target member.

**This — not the judge contract — is what produced `status: 'converged'` at score 4 against `convergence_target: 0`.**
**A perfect judge changes nothing here.** Fixing R-JPCM without WS-4 buys a populated ledger attached to a phase
that still declares victory when it gives up.

**Shape: reuse the shipped `anatomy_non_convergent` disposition** (`types/index.ts:1284` →
`run-finalize-gate-incomplete`, `pipeline-runner.ts:4048-4052`). **Mirror ALL FIVE of its facts, not the first
one.**

> ### ⛔ `complexity_tier: large`. **WS-4 MUST NOT be tiered `small` or `medium`.**
> **The earlier "~30 LOC, no new machinery" pricing is STRICKEN — it was false, and the falsity was load-bearing.**
> `small` **skips `test:fast`**, and `test:fast`'s ~30 `assert.equal(isConverged(...), boolean)` assertions are the
> **ONLY** detector for the silent always-converged regression below. A false cost estimate → a `small` tier → the
> detector never runs → a catastrophic regression ships green. Real inventory: 2 truthiness-testing source callers
> + ~30 boolean assertions across **4** test files + 3 exit-reason declarations + **2 divergent success allowlists**
> + the halt classifier + a pinned export inventory (`src/services/CLAUDE.md:78`, policed by
> `audit-subsystem-claude-md.sh`).

#### ⛔ THE TWO TRAPS. A worker who is AC-complete and unaware of these ships something WORSE than the bug.

**TRAP 1 — the always-truthy regression. DO NOT change `isConverged`'s return type.**
Both source callers are **truthiness tests**: `microverse-runner.ts:4164` (`if (!isConverged(state)) return null;`
— `null` means *keep iterating*) and `:3629` (`if (isConverged(state))`). **An object is always truthy**, so an
object return makes the `:4164` guard **never fire** — control always falls through to `return 'converged'`
(`:4169`). **The loop runs exactly ONE iteration and declares `converged`, on every run, forever.** It compiles
clean; tsc flags neither call site. That is a strictly worse version of the bug this bundle exists to fix.
**`isConverged` keeps its `boolean` signature.** The discriminant is already available at the only site that needs
it: `handleMetricMode` reaches `:4165` *knowing* `isConverged` is true, and can distinguish stall from target
directly from state. No signature change, no caller churn, no test-assertion churn — the smaller fix and the safe
one.

**TRAP 2 — the exit code and the halt branch are a COUPLED PAIR.** `logPhaseHaltReason`
(`pipeline-runner.ts:3797`) consults `classifyMicroverseHaltDecision` **only on a NON-ZERO exit** (`:3802`
short-circuits on `exitCode === 0`). Three combinations are reachable; **two are worse than today:**

| | Worker does | Exit | Classifier | Outcome |
|---|---|---|---|---|
| **A** | Adds the enum member, stops (*literally AC-complete*) | 1 | reached → no branch → `:4062` fallthrough | **Pipeline ABORTS. Finalize gate never runs. Real landed work never finalized.** |
| **B** | Sees the abort, "fixes" it by adding the reason to `successfulReasons` | **0** | **NEVER CALLED** | **Pipeline continues as SUCCESS — THE ORIGINAL LIE, RENAMED.** Green on every AC. |
| **C** | Leaves it OUT of `successfulReasons` (exit 1) **AND** adds an explicit halt branch | 1 | explicit branch | **Non-fatal honest halt; finalize gate runs. CORRECT.** |

**Combo B is the trap a competent worker walks into** — it is the *nearest, most obvious* repair of the abort they
see in their own verify run. Only **C** is correct.

- `AC-RLH-2`: `MicroverseExitReason` (`types/index.ts:1279-1284`) carries `stalled_below_target`.
- `AC-RLH-3` **(REPLACED — the original was catastrophic; see TRAP 1)**: `isConverged`
  (`microverse-state.ts:390`) **retains its `boolean` return signature.** A test asserts the existing ~30
  `assert.equal(isConverged(...), true|false)` assertions across all four test files still pass unchanged.
  **Returning an object from `isConverged` FAILS this AC.**
- `AC-RLH-4`: `handleMetricMode` returns `stalled_below_target` when the loop exits on the **stall limit** with
  `convergence_target != null` and the score **not at target**, and `converged` **only** on target-reached.
  **Do NOT reuse the existing `targetHit` local (`:4165-4167`)** — it is a strict `===` additionally gated on
  `kind === 'improved'`, while `isConverged` is **direction-aware** (`<=` for `lower`, `>=` for `higher`). Reusing
  it would report `stalled_below_target` for a legitimate **overshoot** — a case with shipped, currently-green
  tests (`tests/szechuan-sauce.test.js:271-285`, `:288-301`). Derive the disposition direction-awarely, and
  **state the `convergence_target == null` behaviour explicitly** (that class is silently excluded today).
- `AC-RLH-4b` **(THE COUPLED PAIR — getting one half right and the other wrong IS a shipped bug)**:
  `stalled_below_target` mirrors `anatomy_non_convergent` at all **six** sites, each asserted by a test.
  **Adding the union member raises ZERO tsc errors at sites 2–6 — there is no exhaustiveness check anywhere on
  this path. These ACs are the only guard.**
  1. ✅ **IN** the `MicroverseExitReason` union (`types/index.ts:1279-1284`). *(The one site tsc knows about.)*
  2. ❌ **NOT** in `successfulReasons` (`microverse-runner.ts:4571`) ⇒ `microverseExitCode('stalled_below_target') === 1`.
     **Assert this deliberately.** Adding it here makes the phase exit 0 ⇒ the halt classifier is never consulted
     ⇒ **Combo B.**
  3. ❌ **NOT** in `MICROVERSE_FATAL_REASONS` (`types/index.ts:1286-1290`).
  4. ❌ **NOT** in `MICROVERSE_FAILURE_REASONS` (`types/index.ts:1294-1297`) ⇒ `isMicroverseFailureExit(...) === false`.
  5. ✅ `classifyMicroverseHaltDecision('stalled_below_target')` → `{ action: 'run-finalize-gate-incomplete',
     recognizedExitReason: 'stalled_below_target' }`, via an **explicit branch co-located with the
     `anatomy_non_convergent` branch** (`pipeline-runner.ts:4050-4052`). Without it → `:4062` fallthrough →
     **abort** ⇒ **Combo A.**
  6. **The SIXTH, untyped allowlist** — `markMicroverseFatalError` (`microverse-runner.ts:4598`) carries a raw
     `new Set([...])` with **no union type at all** (it already contains `'completed'`/`'success'`, which are not
     `MicroverseExitReason` members — pre-existing drift). With `stalled_below_target` absent, a finalizer crash
     after an honest stall **silently rewrites the disposition to `error`** — fabricating a failure, inside a
     bundle about not fabricating dispositions. **Decide explicitly and justify: PRESERVE the honest stall.**
     Do **NOT** "unify" the two success sets as a drive-by — they are divergent by design.
  - **Known and deliberately untouched:** `MICROVERSE_FATAL_REASONS` contains `'session_state_corrupted'`, not a
    union member. Pre-existing, harmless (`as const`, not union-typed), **out of scope** — do not "helpfully" fix
    it and blow the scope fence.

### WS-5 — the ONLY gate that can halt the pipeline on a quality verdict reads a file that NOTHING WRITES

`runAcPhaseGate` is the sole quality verdict with the power to stop the run: `pipeline-runner.ts:4021` calls it
and `:4029-4032` does `log('Phase X AC gate failed — stopping pipeline'); return { action: 'break' }`.

It reads `<sessionDir>/ac-phase-manifest.json` (`services/ac-phase-gate.ts:197`) — and on a **missing** manifest
returns `{ status: 'pass' }` (`:198-200`). **Fail-open.**

The string `ac-phase-manifest` appears **exactly once in the entire repository**: its own constant declaration at
`services/ac-phase-gate.ts:9`. Zero producers in `src/`, zero in `tests/`, zero in `.claude/commands/`.
`find ~/.local/share/pickle-rick/sessions -name 'ac-phase-manifest.json'` returns **nothing** — no session has
ever produced one. **The gate has never fired. It evaluates zero criteria and returns `pass` on every run that
has ever executed.**

**⚠ CORRECTION (refinement cycle 3): OPTION (a) IS STRUCK. The fork rested on a bad grep.** The
"appears exactly once in the entire repository" finding matched the **string literal**, not the **symbol**.
`runAcPhaseGate` has **FOUR call sites** — `spawn-refinement-team.ts:1127`, `:2279`; `pipeline-runner.ts:4021`;
`finalize-gate.ts:380` — plus an export-inventory pin (`src/services/CLAUDE.md:56`) and **two trap-door INVARIANTs
policed by the release gate** (`audit-trap-door-enforcement.sh`). Deleting it is **~10× the represented blast
radius**, and the AC as originally written invited a worker to pick (a) on the strength of a wrong grep. **The gate
is wired; what is missing is its PRODUCER.**

**RESOLVED: option (b) — WIRE it. Phase-scoped, producer-before-gate.**

Have refinement persist the PRD's **already-required** machine-checkable acceptance criteria into
`<sessionDir>/ac-phase-manifest.json`. The input already exists (the PRD interview requires machine-checkable ACs)
and is simply never written. This converts the PRD's own ACs into the pipeline's one real fail-stop.

> **⛔ A BLANKET FAIL-CLOSED FLIP BRICKS EVERY RUN.** The **first** caller is `evaluationPhase: 'pre-refinement'`
> (`spawn-refinement-team.ts:1127`) — it runs **before refinement can have written anything**. Flipping
> `ac-phase-gate.ts:197-200` to fail-closed unconditionally means **no session can ever start.** The fail-closed
> must be **phase-scoped**: `pre-refinement` stays fail-OPEN; `post-refinement` / `per-phase` / `bundle-end` fail
> CLOSED. The `AcEvaluationPhase` type **already encodes this ordering** — no new flag or sentinel is needed.

- `AC-RLH-5`: a producer exists (refinement writes `<sessionDir>/ac-phase-manifest.json` from the PRD's
  machine-checkable ACs); a real session emits a **non-empty** manifest; and a **missing** manifest fail-CLOSES at
  `post-refinement` / `per-phase` / `bundle-end` while remaining fail-OPEN at `pre-refinement`. A PR that leaves
  the gate fail-open with zero producers does not satisfy this. *(The original `grep -rc … == 0` predicate was also
  malformed — `grep -rc` over a directory emits per-file counts and can never equal a single `0`.)*

### Corrections to the child PRDs (apply during refinement)

- **R-BCFR — "delete the module" is UNBUILDABLE as written.** `banned-constructs-audit.ts` is a shared-helper host:
  `services/citadel/banned-casts-audit.ts:3-8` imports four helpers from it. `AC-BCFR-8` must be re-scoped to
  "delete the two fabricated ARMS and their wiring; the module survives iff another analyzer still imports its
  helpers." Additionally, emptying `MECHANICAL_FINDING_MATCHERS` (its only entry is
  `banned-construct:brace-free-if`) makes `mechanicalEnabled` and the branch at `pipeline-runner.ts:2650-2679`
  dead — subtract the mechanical floor and the classifier with it.
- **⛔ R-BCFR — "subtract the `skip_quality_gates_reason` bypass" is RE-SCOPED. DO NOT DELETE THE FLAG.**
  It is a **global** flag: **6 source files, 27 hits** (`mux-runner.ts` 14, `spawn-refinement-team.ts` 6,
  `check-readiness.ts` 2, `pipeline-runner.ts` 2, `types/index.ts` 2, `recovery-controller.ts` 1) plus
  `activity-events.schema.json`. It is **written by the root-`CLAUDE.md` Step 0 creation-heavy heuristic** and
  carried by `bundle_bootstrap_exemption_applied` — deleting it **destroys the bundle-bootstrap-exemption surface,
  which this very launch may depend on.** **In scope: delete CITADEL'S READ of the flag only**
  (`pipeline-runner.ts:2653-2675` + the `mechanical` filter at `:2699-2701`). **The flag itself and its other five
  consumers are explicitly OUT OF SCOPE.**
- **R-BCFR — re-verify the `curly` premise at BUILD time, don't inherit the snapshot.** WS-1's entire
  justification is "eslint configures no `curly` rule and exits 0 on every flagged file." True today, but it is an
  assumption about a config file any unrelated PR can change. Cheap to re-check; expensive to assume.
- **R-JPCM — the event is ALREADY registered; the EMITTER is missing.** The source comment at `:1769` claiming
  registration is "pending R-SLLJ-6" is **stale**. `judge_json_parse_failed` is present in
  `types/index.ts:715` (`VALID_ACTIVITY_EVENTS`), `activity-events.schema.json:879` (`definitions`) **and** `:1931`
  (the top-level `oneOf` `$ref`). What is missing is the emit site: `emitJudgeParseFailure`
  (`microverse-runner.ts:1756-1760`) does a bare `process.stderr.write` and never calls `logActivity`. WS-2 is a
  one-line emit-site swap plus deleting the stale comment — **do not re-add a duplicate registration.**
- **R-JPCM — the degraded shape is `malformed`, not `legacy`.** `JSON.parse` failure routes to
  `emptyJudgeResult('malformed')` (score: `null`), never to the `legacy` shape. Scope the ticket to the real path.

## Acceptance

Each composed PRD carries its own machine-checkable ACs (AC-BCFR-1..9, AC-GRLS-1..9, AC-JPCM-1..8 — note
**AC-JPCM-8 was RE-KEYED 2026-07-14**: the original keyed on ledger-emptiness, which WS-1 exists to destroy, so
it would have passed **vacuously**). The bundle adds:

- `AC-RLH-1`: the full release gate is green from `extension/` — tsc + eslint + 9 audits +
  `test:fast:budget` + `test:integration` (+ `test:expensive` at release time).
- `AC-RLH-2`, `AC-RLH-3`, `AC-RLH-4`, `AC-RLH-4b`: WS-4 (`complexity_tier: large` — **never `small`**).
  `stalled_below_target` joins `MicroverseExitReason`; **`isConverged` KEEPS its `boolean` signature** (an object
  return is always truthy ⇒ the loop converges on iteration 1 forever — see TRAP 1); `handleMetricMode` reports it
  direction-awarely on a stall-limit exit below target (**do not reuse the `targetHit` local**); and the
  **exit-code / halt-branch COUPLED PAIR** is asserted at all six sites (see TRAP 2 — two of the three reachable
  combinations are worse than today's bug).
- `AC-RLH-5`: WS-5 — the AC-phase gate gets a **PRODUCER**, and its fail-closed is **phase-scoped**
  (`pre-refinement` stays fail-OPEN, or no session can ever start). **Option (a), deleting the gate, is STRUCK** —
  it rested on a grep of the string literal rather than the symbol; `runAcPhaseGate` has four call sites and two
  release-gate-policed trap-door invariants.
- `AC-RLH-6` **(THE THESIS TEST — REWRITTEN 2026-07-14; the original was SATISFIED BY THE BUG)**.
  **Owned by WS-4** (an unowned thesis test is an *unbuildable* one — the per-ticket scope fence blocks whichever
  ticket attempts it ⇒ zero commits). Co-scope the thesis-test file and `pipeline-runner.ts` into WS-4.

  > **Why rewritten.** The original asserted szechuan "reports an honest non-converged **disposition** rather than
  > `status: converged`." Under **Combo B** the disposition string *is* `stalled_below_target` — so the AC went
  > **green** while the phase exited 0, the halt classifier was never called, and pipeline behaviour was
  > **byte-identical to today's bug.** **It tested the label, not the behaviour. A test that a lying system passes
  > is not a thesis test.**

  Drive `handleMetricMode` over an **injected** `MicroverseSessionState` (`convergence_target: 0`,
  `key_metric.direction: 'lower'`, last-accepted score 4, `stall_counter >= stall_limit`) — **stubbed, no live
  judge** (`isConverged` reads state only, so no judge seam is needed; deterministic, `test:integration` tier).
  Assert **all three**:
  1. the disposition is **exactly `stalled_below_target`** — *not merely `!== 'converged'`*, because an `error` or
     an abort also satisfies that, and **both are different lies**;
  2. `microverseExitCode('stalled_below_target') === 1` — **the phase does NOT exit 0.** An exit-0 stall bypasses
     the halt classifier entirely (`pipeline-runner.ts:3802`) and is behaviourally identical to today's bug;
  3. `classifyMicroverseHaltDecision('stalled_below_target')` → `{ action: 'run-finalize-gate-incomplete',
     recognizedExitReason: 'stalled_below_target' }` — **not** the `:4062` fallthrough to `abort`/`null`.

  **A build satisfying only (1) is the bug with a better name and MUST FAIL this AC.**

- `AC-RLH-7` **(WS-3 — convert the risk into a green test)**: on a **stubbed** judge returning a well-formed
  `{score, violations[]}`, `violation_ledger` is **non-empty** after one iteration and the prior-violations prompt
  block fires. WS-3's value rests on an **external assumption** — that the live judge complies with the new object
  contract. The existing prompt block (`microverse-runner.ts:1656-1660`) contains
  `'Do NOT add units or explanations after the number.'`, which is **flatly incompatible** with asking for an
  object, and the PRD's stated mitigation (*"`extractScore`'s line-oriented fallback is PRESERVED, so the worst
  case is today's behaviour"*) **only holds if the new contract still guarantees a trailing bare number for the
  fallback to find.** **Require the new contract to retain a trailing bare-number line, and test BOTH shapes.**
  Otherwise the fallback is dead on arrival and WS-3 passes a structural AC (the prompt text changed) while
  changing nothing the field notices.

## Rollback

Per the repo's shipped `PICKLE_*=off` convention (literal lowercase `"off"`; any other value / absent = active —
see `plumbus-kill-switch.ts:5`, `orphan-reaper.ts:310`, `setup.ts:210`). This bundle introduces **deliberate
fail-closed flips** under a standing *launch-unattended, multi-hour* posture; a fail-closed flip with no lever is
an **operational defect** — the failure mode is a 4-hour run wedged at 2am with nothing to turn off.

- `PICKLE_AC_PHASE_GATE=off` — WS-5: restores the fail-open branch (`ac-phase-gate.ts:197-200`). **Mandatory** — a
  fail-closed gate whose producer regresses bricks **every** run at `spawn-refinement-team.ts:1127`.
- `PICKLE_GATE_LOCKOUT_STRICT=off` — WS-2: restores the callers' early-return-without-failure. Escape hatch if a
  benign transient lockout under contention false-halts runs.
- **WS-4 gets NO switch.** Iff `AC-RLH-4b` lands, its halt is the non-fatal `run-finalize-gate-incomplete`, which
  needs no escape hatch. **If WS-4 ships without the explicit halt branch it is an abort-by-default: that is a bug,
  not a flag-able feature.** Do not paper over Combo A with a kill-switch.
- **Revert unit:** one workstream = one ticket = one commit. `git revert` per WS is the coarse rollback.

## Simplification Review (subtract-before-add)

1. **Is the addition necessary at all?** WS-1 adds **nothing** (pure deletion). WS-3 adds **no code path** —
   it edits prompt text so an already-wired, currently-unreachable path finally receives its input. WS-2
   adds no primitive; it deletes a hand-rolled lock and calls three that exist. The only genuine additions
   are one enum member (`outcome: "locked_out"`) on an artifact that is already written and already read,
   and one activity-event registration (`judge_json_parse_failed`) that was written but never registered.
2. **Can it REUSE instead of ADD?** That is the whole bundle. WS-2 reuses the lock primitives (a bespoke
   steal here would make it the FOURTH parallel lock implementation — the one-adapter smell that produced
   the bug). WS-3 reuses `parseLlmJudgeOutput`, `updateViolationLedger`, `compareMetric`'s set-ops branch,
   and the prior-violations prompt block — all already built.
3. **Does it guard EXISTING brittle complexity that should instead be SUBTRACTED?** No new guards. WS-1
   **removes** a guard that false-blocks 43/43 on a tree the real gate calls clean and can never converge —
   exactly the W5b "loosened or removed, never given a second escape hatch" case (R-PCPS precedent: 41/41
   false-Highs → subtract the arm).
4. **What can this issue SUBTRACT?** Two fabricated analyzer arms (possibly a whole module + its wiring);
   the hand-rolled `acquireLockfile` body and its payload-less lockfile convention (4th divergent lock → 0);
   the bespoke `remediator_concurrent_lockout_*.md` doc, redundant once the result-json carries `locked_out`;
   and the `judge_json_parse_failed` stderr-only emission path.

## Risks

- **WS-1 deletes a rule someone wanted.** Mitigated: WS-2 of that PRD requires the grep before the delete,
  and adopting the brace style *honestly* (eslint `curly` + `--fix` + document it) is recorded as the
  out-of-scope, operator-owned path. Deleting a **fabricated** citation does not prevent adding a real rule.
- **WS-3 changes what the judge is asked to emit.** `extractScore`'s legacy line-oriented fallback is
  PRESERVED (AC-JPCM-5), so the worst case is today's behaviour — a working score and a dead ledger — not a
  broken phase. Do not subtract that fallback in this bundle.
- **WS-2's `locked_out` outcome ripples to the result-reader.** Enumerate the consumers (the
  R-CLOSER-ADJACENCY-AUDIT step-4 cross-module importer check) rather than patching the first one found.

## Routing

**Pipeline-safe (NOT R-PSRB).** None of the three touches the salvage / completion-evidence / Done-flip
path (`mux-runner.ts` salvage logic, `salvage-ticket.ts`, `reconcile-ticket-truth.ts`,
`ticket-completion-evidence.ts`). The build worker executes the **deployed** runtime, not this source diff,
so these fixes cannot sabotage the run that produces them. Drain via `/pickle-pipeline`.

**Deployed runtime at launch:** `2.1.0-beta.2` (MD5 parity verified) — it carries the dead-holder lock
recovery, the ambient-`#S` tmux ownership guard, the `setup --resume` RED-gate Done-flip fix, and
R-LSPC-2. Earlier runs on `beta.1` were exposed to all four.
