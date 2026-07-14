# PRD Analysis: Requirements Analyst Morty (Cycle 3)

**Date**: 2026-07-14
**Analyst**: Requirements Analyst Morty
**Cycle**: 3

## Executive Summary

Cycle 2 all three of us analyzed the bundle document. Cycle 3 I read the **three composed child PRDs** — which no analyst has opened in three cycles — and the bundle is worse than any of us said. **`AC-BCFR-6` and the amendment's own WS-1 correction are MUTUALLY UNSATISFIABLE against a real, currently-green, fast-tier test** (`tests/citadel/citadel-analyzer-wiring.test.js`, 8/8 pass, verified by running it): the amendment says "the module SURVIVES," the test asserts *every* non-excluded module in `src/services/citadel/` is imported by `audit-runner.ts`, and `AC-BCFR-6` asserts that test still passes. Satisfy the correction → the test goes RED → `AC-RLH-1` (gate green) fails. **No branch of this bundle can go green as written.** This also **inverts Codebase Morty's P0-1**: they audited `audit-citadel-wiring.js` (non-gated, synthetic fixtures) and concluded no gate enforces analyzer wiring. They audited the wrong file. The enforcement is real, it is in the fast tier, and `mechanical-finding-classifier` reads "unwired" only because it is on an **explicit exclusion list** (`:16-29`) — not because nothing is watching.

Three further new P0s, all from the child PRDs: **`AC-BCFR-3`'s count is factually wrong** (`is banned by CLAUDE.md` appears **4 times, not 2**) and satisfying it *literally mandates* deleting the two `banned-casts` arms that both other Mortys demanded be scoped OUT; **`AC-BCFR-2` mandates editing `spawn-gate-remediator.ts`**, which makes the WS-1/WS-2 file collision **AC-required**, not incidental; and the bundle and its children **both use the identifiers `WS-1`/`WS-2` for different things**, so the Corrections section's sentence *"WS-2 is a one-line emit-site swap"* (meaning R-JPCM's WS-2) points a refiner at **bundle WS-2 = the gate-remediator lock rewrite** — a `small`-tier instruction aimed at the bundle's largest ticket.

And I retract my own cycle-2 `AC-RLH-8`: it named three broken callers. **There are two.** Verified below.

---

## Critical Gaps (P0 — Must Fix)

### 1. `AC-BCFR-6` and the amendment's WS-1 correction are MUTUALLY UNSATISFIABLE — no branch of this bundle goes green

This is the finding of the cycle, and it kills the bundle as written.

**The amendment says** (`## Workstreams`, WS-1, and again under Corrections): *"**The module itself SURVIVES** (`banned-casts-audit.ts:3-8` imports four helpers from it) — delete the ARMS + their wiring."* "Their wiring" means removing `auditBannedConstructs` from `audit-runner.ts` — verified present at `audit-runner.ts:24` (`import { auditBannedConstructs } from './banned-constructs-audit.js';`).

**`AC-BCFR-6` says** (child PRD, `p2-...-r-bcfr-...md:92-97`): *"the citadel analyzer-wiring test (`citadel-analyzer-wiring.test.js`, R-CCNW-2) **still passes**."*

**The test says** (`tests/citadel/citadel-analyzer-wiring.test.js` — verified by reading and by running it):

```js
const CITADEL_SRC = path.resolve(__dirname, '../../src/services/citadel');   // :11 — the REAL tree
const FILENAME_EXCLUDED = new Set([                                          // :16-29 — exactly 7 entries
  'audit-runner.ts', 'reporter.ts', 'diff-walker.ts', 'prd-parser.ts',
  'trap-doors-section.ts', 'citadel-findings-to-gate-result.ts',
  'mechanical-finding-classifier.ts',
]);
// :51  const files = fs.readdirSync(citadelSrcDir).filter(f => f.endsWith('.ts'));
// :70  test('every non-excluded analyzer module is imported in audit-runner.ts')
// :80  assert.deepStrictEqual(unwired, []);
```

`banned-constructs-audit.ts` is **not** in `FILENAME_EXCLUDED`, does not end in `-helpers.ts` or `-types.ts` (both excluded, `:116`/`:125`), and lives in `src/services/citadel/`. So the moment WS-1 removes the `audit-runner.ts:24` import while the module survives on disk, `findUnwiredModules` (`:60-66`) returns `['banned-constructs-audit']`, `assert.deepStrictEqual(unwired, [])` **fails**, and the test goes RED. It is a `tests/` file → fast tier → **`AC-RLH-1` (full gate green) fails**.

**The three ACs form an unsatisfiable triangle:** the correction ("module survives") ⊥ `AC-BCFR-6` ("wiring test still passes") ⊥ `AC-RLH-1` ("gate green"). A worker satisfying any two breaks the third. **This is not a risk — it is an arithmetic contradiction, and it means the bundle currently has no green path.**

**Live proof the test is real and binding** (not a paper guard): `node --test tests/citadel/citadel-analyzer-wiring.test.js` → **8 pass, 0 fail**. It passes *today* precisely because `audit-runner.ts:24` still imports the module.

**Fix — the PRD must PICK a resolution and state it (paste-ready):**

> **WS-1 wiring resolution (REQUIRED — the amendment's "the module SURVIVES" contradicts `AC-BCFR-6` as written).** `tests/citadel/citadel-analyzer-wiring.test.js` audits the **real** `src/services/citadel/` tree (`:11`, `readdirSync` at `:51`) and asserts `unwired === []` (`:80`). It is in the fast tier and passes **8/8 today**. Deleting the arms + unwiring `audit-runner.ts:24` while the module survives on disk makes it **RED**, which fails `AC-BCFR-6` and `AC-RLH-1`. Pick **exactly one**, in the ticket, with a one-line justification:
> - **(i) RENAME** `banned-constructs-audit.ts` → `changed-source-helpers.ts`. The `-helpers.ts` suffix is excluded from the analyzer discovery surface (test `:116` pins this). Re-point `banned-casts-audit.ts:3-8` (four symbols — `ChangedSource`, `collectChangedCodeLines`, `isCommentLine`, `stripStringLiterals`). **This is the recommended branch** — it makes the surviving module *honestly* a helper module, which is what it now is.
> - **(ii) EXCLUDE** — add `'banned-constructs-audit.ts'` to `FILENAME_EXCLUDED` (`:16-29`) with a justifying comment, matching the established pattern (three of the seven existing entries carry exactly such a comment).
> **Do NOT leave this to the worker.** Either branch edits a **test file** and either is defensible; a worker who picks neither ships a red gate, and a worker who "fixes" the red by re-adding the `audit-runner.ts` import silently restores the fabricated arms this workstream exists to delete.

### 2. `AC-BCFR-3`'s count is FACTUALLY WRONG, and satisfying it literally mandates deleting the `banned-casts` arms both other analysts demanded be OUT of scope

`AC-BCFR-3` (child PRD `:88-89`): *"`grep -rc "is banned by CLAUDE.md" extension/src/` == `0` (WS-1 + WS-2 together; **WS-1 alone reduces it from 2 to 1**)."*

Verified — the string appears **four** times, in **two** modules:

```
src/services/citadel/banned-constructs-audit.ts:118   Nested/chained ternary ... is banned by CLAUDE.md;
src/services/citadel/banned-constructs-audit.ts:129   Brace-free if ...        is banned by CLAUDE.md;
src/services/citadel/banned-casts-audit.ts:44         Unsafe `(x as Error).` cast ... is banned by CLAUDE.md;
src/services/citadel/banned-casts-audit.ts:55         `as any` cast ...        is banned by CLAUDE.md;
```

The PRD's parenthetical ("from 2 to 1") is wrong: WS-1 alone takes it from **4 to 3**. And `AC-BCFR-3`'s stated success condition — **== 0** — is **unsatisfiable without deleting the two `banned-casts` arms**, which Codebase Morty (P1) and Risk Morty both said must be explicitly out of scope, and one of whose siblings (`banned-cast:as-never:`) is a **pinned LOA-907 floor defect** (`tests/citadel/loa907-regression.test.js:151`).

So the AC as written is a **scope grenade with a green pin**: a worker greps, sees 4, deletes 4, satisfies `AC-BCFR-3`, and blows up an out-of-scope analyzer and a pinned regression floor. Codebase Morty framed this as "the WS-2 grep *will surface* these — scope them out." That undersells it. **The AC does not merely surface them; it mathematically requires their deletion.** Prose saying "out of scope" loses to an AC that says `== 0`.

**Fix (paste-ready):**

> `AC-BCFR-3` **(CORRECTED — the original count and target are both wrong)**: `is banned by CLAUDE.md` appears **4×** in `extension/src/`, not 2×: `banned-constructs-audit.ts:118`, `:129` (in scope) and `banned-casts-audit.ts:44`, `:55` (**OUT of scope** — the `(x as Error)` ban is grounded in root `CLAUDE.md` → Required Patterns; the `as any` ban is separately ungrounded and is filed as its own follow-on finding). The AC is therefore scoped to the module, not the tree:
> `! grep -q "is banned by CLAUDE.md" extension/src/services/citadel/banned-constructs-audit.ts` **and** `grep -c "is banned by CLAUDE.md" extension/src/services/citadel/banned-casts-audit.ts` == `2` (an **anti-regression pin**: the casts arms are deliberately untouched). A PR that zeroes the tree-wide count has **exceeded scope** and fails this AC.

### 3. `AC-BCFR-2` MANDATES editing `spawn-gate-remediator.ts` — the WS-1/WS-2 file collision is AC-required, not incidental

Both other analysts flagged the WS-1/WS-2 collision on `spawn-gate-remediator.ts` as a falsified "disjoint files" claim. It is stronger than that: **an acceptance criterion requires it.**

`AC-BCFR-2`: `grep -rc "banned-construct:brace-free-if" extension/src/` == `0`. Verified occurrences — **four files**:

| File:line | What it is | Owner |
|---|---|---|
| `services/citadel/banned-constructs-audit.ts:124` | the finding-id emission | WS-1 |
| `services/citadel/mechanical-finding-classifier.ts:19,20,29,30` | the sole matcher + its JSDoc | WS-1 (the "mechanical floor" subtraction) |
| **`bin/spawn-gate-remediator.ts:125`** | **remediation class (e), hard-pinned to this exact id** | **WS-2's file** |

`AC-BCFR-2` cannot reach `0` unless bundle-WS-1 edits `spawn-gate-remediator.ts:125` — the file bundle-WS-2 rewrites end-to-end. Under the per-ticket `check-scope-diff` preflight, **whichever runs second is blocked, and the bundle lands zero commits on that ticket.** The PRD's `## Why these three together` offers non-contention as its *justification for bundling*; that justification is not merely false, it is **contradicted by the bundle's own acceptance sheet**.

Also newly surfaced: deleting `mechanical-finding-classifier.ts` (which `AC-BCFR-2` requires, and which Codebase Morty recommends) breaks **`tests/citadel/mechanical-finding-classifier.test.js`** — an existing 2.0K test file neither of us listed. It must be in WS-1's allowlist or WS-1 cannot go green.

**Fix (paste-ready):**

> **Ordering (REQUIRED — `AC-BCFR-2` forces the collision).** `banned-construct:brace-free-if` appears in **four** files, including `bin/spawn-gate-remediator.ts:125` (remediation class **(e)**, hard-pinned to this exact finding id) — WS-2's file. `AC-BCFR-2` (`grep` count → 0) is therefore **unsatisfiable without editing WS-2's file**. Declare `WS-2 depends_on WS-1`; co-scope `bin/spawn-gate-remediator.ts` into **WS-1's** allowlist for the class-(e) deletion only, and have WS-2 (which rewrites the lock in the same file) run **after**. They may **not** run in parallel — the scope fence blocks the second writer. Delete the "the fixes touch **disjoint files**" sentence from `## Why these three together`; it is false and it is the bundle's stated reason to exist.
> **WS-1 allowlist additions (verified, previously unlisted):** `services/citadel/mechanical-finding-classifier.ts` (delete), **`tests/citadel/mechanical-finding-classifier.test.js`** (delete — it tests the deleted module), `tests/citadel/banned-constructs-audit.test.js` (arm tests), `tests/citadel/citadel-analyzer-wiring.test.js` (per P0-1), `services/citadel/audit-runner.ts:24`, `services/citadel/banned-casts-audit.ts:3-8` (import re-point), `bin/spawn-gate-remediator.ts:125`, `src/services/CLAUDE.md`.

### 4. Workstream namespace collision: the bundle and its children both use `WS-1`/`WS-2`, and the Corrections section aims a `small`-tier instruction at the bundle's largest ticket

**Nobody has read the child PRDs in three cycles.** Each of the three children carries **its own** `WS-1` and `WS-2` (verified — section headers):

| Child PRD | its WS-1 | its WS-2 |
|---|---|---|
| R-BCFR | delete the `isBraceFreeIf` arm | **re-ground *or* delete** the `isNestedTernary` arm |
| R-GRLS | reclaim a dead holder via shared primitives | a lockout must not read as a remediation |
| R-JPCM | make the prompt ask for the parsed shape | a dead ledger must be loud |

The bundle then **re-uses the same identifiers** for a different partition: bundle `WS-1` = *all of* R-BCFR, bundle `WS-2` = *all of* R-GRLS, bundle `WS-3` = *all of* R-JPCM. Two incompatible `WS-n` namespaces, no disambiguation anywhere in the document.

Now read the Corrections section, verbatim: *"**WS-2 is a one-line emit-site swap plus deleting the stale comment** — do not re-add a duplicate registration."* That sentence sits under the **R-JPCM** correction bullet and means **R-JPCM's WS-2**. But a refiner tiering the *bundle's* five tickets reads `WS-2` and finds **the gate-remediator lock strand** — the ticket Codebase Morty and Risk Morty both tier **large** (lock rewrite + two caller fixes + a characterization pin + a new `LOCKOUT_PATH` reader).

**A "one-line swap" label on the bundle's largest ticket is a mis-tier written directly into the PRD**, and tier is a bet on the worker timeout. This is exactly the class of defect the amendment header exists to catch, and the amendment *introduced* it.

**Fix:** in the bundle, refer to child workstreams **only** as `R-JPCM/WS-2`, `R-BCFR/WS-2`, etc. — never bare `WS-n`. Rewrite the offending sentence: *"**R-JPCM/WS-2** (the emit site) is a one-line swap plus deleting the stale JSDoc line at `microverse-runner.ts:1771`."* Retitle the bundle's rows `B-RLH/WS-1..5` if the collision cannot be avoided. Also add the tier table explicitly (all five are **medium+**; WS-1, WS-2, WS-4, WS-5 are **large** per the verified file inventories — concurring with Codebase and Risk Morty).

### 5. R-BCFR carries a SECOND undecided fork the bundle never mentions — and its ACs are CONDITIONAL, so they cannot gate

The bundle presents WS-5 as its one open decision ("**Decide, don't leave it**"). It is not. **R-BCFR/WS-2 is a second undecided fork**, and the bundle's WS-1 row papers over it with the word "verify-then-delete":

> `## WS-2 — re-ground **or** delete the isNestedTernary arm` … *"**If none exists** (expected): delete … **If one exists**: keep the arm but rewrite the message to cite the actual file and line."*

Both of its acceptance criteria are **conditional on the unresolved branch**:
- `AC-BCFR-7`: *"…**unless** the same finding payload carries a `rule_source` field…"* — an AC with an escape clause the same undecided branch controls.
- `AC-BCFR-8`: *"**if** `banned-constructs-audit.ts` is deleted, `grep -c …` == 0…"* — vacuously true whenever the module is *not* deleted, which is **exactly what the bundle's own correction mandates** ("the module SURVIVES"). **`AC-BCFR-8` is therefore vacuous in the branch the bundle has already chosen.** It gates nothing.

A conditional AC is not an acceptance criterion; it is a description of two possible worlds. The bundle already resolved the module-survival question — so it must also resolve this one, and **re-key `AC-BCFR-8`**, which the amendment did for `AC-JPCM-8` and forgot to do here.

**Fix (paste-ready):**

> **R-BCFR/WS-2 decision (resolved at refinement): DELETE.** The grep is already run and recorded: the citation is a hardcoded literal in the analyzer itself and no `CLAUDE.md` in the repo carries a nested/chained-ternary ban. The "re-ground" branch is **STRUCK** — do not leave a live fork in a build ticket.
> **`AC-BCFR-8` is RE-KEYED** (it is vacuous as written: it is conditioned on `banned-constructs-audit.ts` being deleted, and this bundle's own WS-1 correction mandates that the module **survives** — so the AC can never fire). New predicate: *"`grep -c "auditBannedConstructs" extension/src/services/citadel/audit-runner.ts` == `0`, the module survives as a renamed helper (P0-1 branch (i)), and `tests/citadel/citadel-analyzer-wiring.test.js` is green."*
> **`AC-BCFR-7` is RE-KEYED** to drop its escape clause: *"no source file under `extension/src/services/citadel/` emits a finding message containing `banned by CLAUDE.md` except `banned-casts-audit.ts:44`,`:55` (explicitly out of scope, pinned by `AC-BCFR-3`)."*

### 6. `AC-RLH-6` is still unowned, and `stalled_below_target` still has no consumer AC (CARRIED — both unresolved; Risk Morty found the deeper half)

Carrying my cycle-2 P0 #1 and #2 forward, compressed, because **Risk Morty's cycle-2 P0-1 supersedes my version of the second one and it is the most important finding in the bundle after P0-1 above**: `classifyMicroverseHaltDecision`'s default is `{action: 'abort'}` (`pipeline-runner.ts:4062`), `microverseExitCode` is an **allowlist typed against a different union** (`ExitReason`, not `MicroverseExitReason` — so **tsc flags nothing**), and **no AC requires the recognizer branch**. An AC-complete WS-4 therefore does not merely fail to halt honestly — it **hard-aborts the pipeline before the finalize gate**, destroying legitimately-landed work. That is strictly worse in the field than today's silent lie. Their `AC-RLH-4b` is the correct fix; adopt it verbatim. I add only the requirements framing: **an enum member with no consumer branch is a value written and never read — the exact `LOCKOUT_PATH` defect this bundle was chartered to kill.** The bundle would ship two more of them.

And `AC-RLH-6` — the AC the PRD calls *"what the bundle is FOR"* — **still maps to no workstream** (five workstreams; the refinement instruction is "one ticket per workstream (five)"). Risk Morty is right that the per-ticket scope fence makes it *unbuildable* as an orphan. Two acceptable resolutions: assign it to **WS-4 with a co-scoped allowlist** (Risk Morty's), or add the **sixth bundle-acceptance ticket** with `depends_on: [WS-1..WS-5]` (mine). I now prefer **the sixth ticket**: WS-4 is already `large` with a ~30-assertion test migration across four files, and hanging the bundle's thesis test off its budget is a bet on the worker timeout. Either way: **do not leave it unowned.**

---

## Important Gaps (P1 — Should Fix)

- **RETRACTION — my cycle-2 `AC-RLH-8` named three broken callers. There are TWO.** Codebase Morty was right and I verified it myself rather than take it on their word:
  - `microverse-runner.ts:301-303` → **`if (briefCode !== 0) return { success: false };` / `if (!briefPathLine) return { success: false };`** — and it **is** consumed: `:680` `if (remediationOutcome.success) return opts.currentMv;` else falls through to `recordPerIterationGateRegression`. **This caller is already honest. It is a CHARACTERIZATION pin, not a fix.** A worker told to "add the caller-side assertion" here will either no-op or damage a correct call site.
  - `pipeline-runner.ts:2558`,`:2563` → bare `return;` from a `void` function; the cycle loop continues; the phase exits 0. **Broken.**
  - `finalize-gate.ts:256`,`:262` → `return null` → consumed at `:319` as `return { code: null, result };` — which is **byte-identical to the SUCCESS return at `:323`** (after `spawnStrictRemediator`). The caller **structurally cannot distinguish "I spawned a remediator" from "I was locked out and did nothing."** **Broken, and worse than the PRD describes** — the fix is a *discriminated* result, not merely a non-null one.
  The PRD's WS-2 blast-radius note ("**all three callers** … return early WITHOUT signalling failure") is **wrong on `microverse-runner`** and must be corrected before a worker acts on it. My `AC-RLH-8` is re-scoped in the JSON below: **2 fixes + 1 characterization + 1 positive-discrimination row.** *(Open question for the ticket, P2: `{success:false}` routes a lockout to `recordPerIterationGateRegression` — verify that does not mislabel a **lock failure** as a **code regression**. Honest on the success axis; possibly mislabeled on the cause axis.)*

- **The malformed `grep -rc … == 0` idiom is a PATTERN across THREE ACs, not a nit.** `grep -rc` over a *directory* emits **per-file** counts — demonstrated live (`src/types/engine-keys-registry.ts:0`, `src/types/attractor-schema.fallback.ts:0`, …), never a single total, so it can never compare to `0`. It appears in **`AC-BCFR-2`**, **`AC-BCFR-3`**, and **`AC-RLH-5`**. Three ship-gating ACs are **unexecutable as literally written**, which means a worker will hand-wave them and self-certify. Fix all three to `! grep -rq "<pattern>" extension/src/` (or `grep -rl … | wc -l` == 0). I raised this as a P2 in cycle 2 against one AC; with three instances it is a systemic P1 — the PRD's machine checks are not machine-checkable.

- **`AC-RLH-7` (WS-3 positive signal) — still missing.** The amendment *diagnoses* the vacuity in prose (*"WS-3 in particular passes its acceptance test while changing nothing the field would notice"*) and then never writes the AC that catches it. Every AC WS-3 can pass today is green with `violations` still `[]`: `AC-JPCM-5` is a *preservation* check on `extractScore`'s fallback; the structural ACs check the *prompt input*. **No AC asserts a populated ledger.** Add: *a szechuan iteration whose (stubbed, `test:integration`-tier) judge output contains known violations produces a **non-empty** `violations` ledger — asserted positively — and `compareMetric` takes the R-SLLJ-4 set-ops branch on the next iteration. A prompt-text-only change with an empty ledger FAILS.* Codebase Morty adds the load-bearing detail I did not have: the real prompt block is **three** score-contract lines (`microverse-runner.ts:1656-1660`), one of which — *"Do NOT add units or explanations after the number"* — is **flatly incompatible** with asking for a `{score, violations[]}` object. WS-3 must rewrite **all three**, and must state whether the new contract still guarantees a trailing bare number, or `extractScore`'s fallback (the PRD's entire stated risk mitigation) is **dead on arrival**.

- **`AC-RLH-4`'s predicate is not TOTAL over its input domain.** As written it reuses `targetHit` (`microverse-runner.ts:4165-4167`) — a strict, non-direction-aware `===` gated on `kind === 'improved'` — while `isConverged` (`microverse-state.ts:390-400`) is a direction-aware inequality. Three input classes get a wrong or undefined disposition: **overshoot** (`'lower'`, target 2, score 0 → `isConverged` true, `targetHit` false → AC reports `stalled_below_target` on a run that **beat** its target — a **new lie**); **held-at-target** (`kind === 'held'` → same); and **null-target stall** (excluded by the AC's own `convergence_target != null` guard → keeps reporting `converged` **after this bundle lands**). Risk Morty supplied the receipt I lacked: `tests/szechuan-sauce.test.js:271-301` are **shipped, passing** tests asserting `isConverged === true` on exactly the overshoot cases `targetHit` calls false. **`AC-RLH-4` as literally written mandates a predicate that contradicts a shipped test.** Replace it: derive the disposition **exclusively** from the `AC-RLH-3` discriminant; **DELETE `targetHit`, do not reuse it** (its only other consumer is a log-string template at `:4168` — deletion is free); require four regression rows (stall-above-target → `stalled_below_target`; overshoot → `converged`; held-at-target → `converged`; **null-target → DECIDE AND STATE**, with a justification).

- **`AC-RLH-5` is a disjunction with no mutual-exclusion assertion, and its option (a) rests on a false grep.** Make it an explicit **XOR** — fail if neither, both, *or a partial* holds; a half-done (b) (producer added, gate still fail-opens) is the likeliest real outcome and passes an (a)-shaped check. Fold in the two corrections both other analysts proved: **option (a) is ~10× the represented blast radius** (4 `runAcPhaseGate` call sites, 4 test files importing `AC_PHASE_MANIFEST`, 2 gate-resident trap-door INVARIANTs) — the amendment's "appears exactly once … zero in `tests/`" grep matched the *string literal*, not the exported symbol; and a **blanket** fail-closed **deadlocks every session** (`spawn-refinement-team.ts:1127` runs `evaluationPhase: 'pre-refinement'`, *before* refinement can write a manifest). **Fail-closed must be phase-scoped**: `pre-refinement` stays fail-open; `post-refinement`/`per-phase`/`bundle-end` fail closed. An AC that, if satisfied literally, bricks the product is a defective AC.

- **`AC-JPCM-8`'s re-keyed predicate is still never restated in this bundle.** The PRD says it "was RE-KEYED 2026-07-14" because the original "would have passed **vacuously**" — and then never quotes the new text. A refiner reading only B-RLH cannot verify the re-key held. **Quote it verbatim.** (And note the irony now compounded by P0-5: `AC-BCFR-8` is vacuous for the *identical* reason and was **not** re-keyed.)

- **The "Corrections to the child PRDs" section has ZERO acceptance criteria.** Four prose instructions to a refiner (module survives; `judge_json_parse_failed` already registered — emit site missing; degraded shape is `malformed` not `legacy`; subtract the mechanical floor) with **no machine check**. If any is dropped the bundle regresses toward the state the amendment header warns about. Corrections that matter enough to write down matter enough to assert. Add one AC each — e.g. *"`grep -c 'judge_json_parse_failed' extension/src/types/index.ts` == `1` (no duplicate registration added) **and** `emitJudgeParseFailure` calls `logActivity`."*

---

## Minor Issues (P2 — Nice to Fix)

- **No end-to-end operator CUJ.** The defect flows are vivid; the *intended success flow* is written nowhere. Five steps would have caught P0-6 by itself: *(1) operator runs `/pickle-pipeline` on a tree whose score cannot reach `convergence_target`; (2) the judge emits `{score, violations[]}` and the ledger populates (WS-3); (3) the stall limit is hit without reaching target → `isConverged` returns `{reason: 'stall_limit'}` (AC-RLH-3); (4) `handleMetricMode` returns `stalled_below_target`, **not** `converged` (AC-RLH-4); (5) `classifyMicroverseHaltDecision` maps it to `run-finalize-gate-incomplete` → the phase halts **honestly incomplete and non-fatally**, and the finalize gate still runs (AC-RLH-4b/AC-RLH-6).* **Step 5 is the step the ACs are missing.** Writing the journey out is how you find the hole.
- **The Simplification Review contains two false minimality claims and cannot be used to size tickets.** §1 asserts `locked_out` lands "on an artifact that is **already written and already read**." Verified: `grep -rn "locked_out" src/ tests/` → **zero hits**; the artifact (`remediation_<iso>_result.json`) is referenced exactly once in the tree — at `spawn-gate-remediator.ts:147`, inside **worker prompt text** — and is **read by nothing**. Risk Morty proved the second (WS-5(b)'s producer is net-new machinery, not "the input already exists"). Two of four claims false, **both pushing tiers downward** — which is what the refiner reads to assign complexity. Re-derive the section.
- **The deployed-runtime pin (`2.1.0-beta.2`) VERIFIES today** (source `package.json`, deployed `package.json`, and `git describe` all agree — Codebase Morty confirmed; Risk Morty withdrew their staleness concern). Add "re-verify at launch" so a later drain does not inherit a stale parity claim.
- **`MICROVERSE_FATAL_REASONS` (`types/index.ts:1286-1290`) contains `'session_state_corrupted'`, which is not a member of the `MicroverseExitReason` union.** Pre-existing, harmless (the array is `as const`), **out of scope** — but WS-4 is the ticket staring at these three declarations. Mark it **known and deliberately untouched** or a worker "helpfully" fixes it and blows the scope fence.

---

## ac_shape_smells

```json
{
  "ac_shape_smells": [
    {
      "ac_id": "AC-RLH-6",
      "headline": "a review phase can FAIL — drive a phase over an input it cannot legitimately succeed on and assert an honest non-success disposition",
      "evidence": [
        "PRD Thesis names THREE lying phases: citadel (R-BCFR — '43 findings, 0 remediated'), the gate remediator (R-GRLS — 'A false-GREEN gate'), szechuan (R-JPCM — 'reports converged when it stalled blind')",
        "PRD Acceptance, AC-RLH-6 drives only ONE of the three: 'Drive szechuan over a tree whose score cannot reach convergence_target'",
        "AC-RLH-6's own success condition is universally quantified over EVERY phase — 'If every phase still exits 0 on every input after this bundle lands, the bundle did not do its job' — but its test drives one",
        "AC-RLH-6 maps to NO workstream: the Workstreams table lists WS-1..WS-5 and the refinement instruction is 'one ticket per workstream (five)'",
        "VERIFIED: classifyMicroverseHaltDecision's default branch is { action: 'abort', recognizedExitReason: null } (pipeline-runner.ts:4062); microverseExitCode is an allowlist typed against ExitReason, a DIFFERENT union from MicroverseExitReason — so tsc flags NOTHING when the union grows"
      ],
      "targets": ["citadel", "gate-remediator", "szechuan"],
      "repeated_predicate": "given an input on which the phase cannot legitimately succeed, the phase reports an honest non-success disposition (never status:'converged', never an exit-0 read as success)",
      "ticket_ids": ["ws-6-bundle-acceptance-review-phases-can-fail"]
    },
    {
      "ac_id": "AC-RLH-8",
      "headline": "a LOCKOUT_PATH result (no BRIEF_PATH) must be surfaced as a DISTINGUISHABLE failure by every consumer",
      "evidence": [
        "PRD 'Note for WS-2 (blast radius)': 'all three callers check only for BRIEF_PATH and, on its absence, log a line and return early WITHOUT signalling failure' — VERIFIED WRONG on the third caller",
        "VERIFIED pipeline-runner.ts:2558,:2563 — bare `return;` from a void fn; the cycle loop continues and the phase exits 0. BROKEN.",
        "VERIFIED finalize-gate.ts:256,:262 — `return null` -> consumed at :319 as `return { code: null, result }`, which is BYTE-IDENTICAL to the SUCCESS return at :323 after spawnStrictRemediator. The caller cannot distinguish 'remediator spawned' from 'locked out, did nothing'. BROKEN, and worse than the PRD states.",
        "VERIFIED microverse-runner.ts:301-303 — ALREADY returns `{ success: false }`, and it IS consumed at :680 (`if (remediationOutcome.success)` -> else recordPerIterationGateRegression). ALREADY HONEST — characterization only.",
        "VERIFIED grep -rn 'locked_out|LOCKOUT_PATH' src/ -> exactly ONE line, spawn-gate-remediator.ts:259 (a write). Zero reads. `locked_out` does not exist in src/ at all."
      ],
      "targets": ["pipeline-runner.ts:2558", "finalize-gate.ts:262 (+ the :319/:323 code:null collision)", "microverse-runner.ts:302 (characterization only)"],
      "repeated_predicate": "on a missing BRIEF_PATH the consumer must surface a non-success signal that is DISTINGUISHABLE from its own success-path return; LOCKOUT_PATH must be read, not merely written",
      "ticket_ids": ["ws-2-r-grls-gate-remediator-lock-strand"]
    }
  ],
  "tickets": [
    {
      "id": "ws-6-bundle-acceptance-review-phases-can-fail",
      "title": "Bundle acceptance: every review phase reports an honest non-success disposition on an input it cannot succeed on",
      "source_ac_ids": ["AC-RLH-6"],
      "complexity_tier": "medium",
      "depends_on": ["ws-1-r-bcfr", "ws-2-r-grls-gate-remediator-lock-strand", "ws-3-r-jpcm", "ws-4-stall-not-success", "ws-5-dead-fail-stop"],
      "acceptance_test": "describe.each([{phase:'citadel', unsatisfiable:'a tree the real gate calls clean — no fabricated finding is emitted'}, {phase:'gate-remediator', unsatisfiable:'a stranded lock (LOCKOUT_PATH, no BRIEF_PATH)'}, {phase:'szechuan', unsatisfiable:'an injected MicroverseSessionState with convergence_target:0, direction:lower, last score 4, stall_counter >= stall_limit'}]) — each phase reports an honest non-success disposition: never status:'converged', never an exit-0 read as success. For szechuan assert the disposition is EXACTLY 'stalled_below_target' (not merely != 'converged' — an `error` or an abort would also satisfy that, and both are DIFFERENT lies), and that classifyMicroverseHaltDecision maps it to 'run-finalize-gate-incomplete' with recognizedExitReason !== null — NOT the :4062 fallthrough to abort/null, which would skip the finalize gate entirely. Judge is STUBBED; isConverged reads MicroverseSessionState only (microverse-state.ts:390), so state can be injected directly — no live LLM. Deterministic, test:integration tier.",
      "justification": "// JUSTIFICATION: A SIXTH ticket beyond the PRD's five workstreams, and it is required, not an umbrella. AC-RLH-6 is the AC the PRD calls 'what the bundle is FOR' and it is assigned to NO workstream — five tickets can all go green while the thesis test is written by nobody. It adds ZERO production code (it IS the thesis test), so it neither collapses nor duplicates WS-1..WS-5; it depends_on all five. The three phases share ONE predicate across three targets, so this is ONE parametrized describe.each, NOT three per-phase tickets — fanning out would let each phase's honesty be 'proven' while the other two still exit 0, which is precisely the failure the AC exists to catch. Preferred over folding it into WS-4 (Risk Morty's alternative) because WS-4 is already large (a ~30-assertion migration across 4 test files) and hanging the bundle's thesis test on its timeout budget is a bet, not a plan. complexity_tier: medium — integration-tier, orchestrator-adjacent; a slow integration verify is never 'small'."
    },
    {
      "id": "ws-2-r-grls-gate-remediator-lock-strand",
      "title": "Route the 4th gate lock through the shared primitives AND make every stdout consumer surface a lockout as a DISTINGUISHABLE failure",
      "source_ac_ids": ["AC-RLH-8", "AC-GRLS-1..9"],
      "complexity_tier": "large",
      "depends_on": ["ws-1-r-bcfr"],
      "acceptance_test": "describe.each over the three consumers. (1) pipeline-runner.ts:2558 — feed remediator stdout with LOCKOUT_PATH= and no BRIEF_PATH=; assert it returns a non-success signal, NOT the bare `return;` that lets the cycle loop continue to a 0 exit. (2) finalize-gate.ts:262 — assert the lockout result is NOT the `{code: null, result}` it also returns at :323 after a SUCCESSFUL spawnStrictRemediator; the two must be discriminable. (3) microverse-runner.ts:302 — CHARACTERIZATION ONLY: pin the already-correct `{success:false}` -> :680 -> recordPerIterationGateRegression path so it cannot regress. Do NOT 'fix' it. Positive row: feed BRIEF_PATH= and assert success at all three, proving the discrimination. Machine check: `grep -rn 'LOCKOUT_PATH|locked_out' extension/src/` shows >= 2 READ sites post-fix (today: 1 write, 0 reads).",
      "justification": "// JUSTIFICATION: NOT fanned out — ONE parametrized ticket. The consumers share one root cause (a payload-less lock whose EEXIST path returns exitCode 0 and a LOCKOUT_PATH nobody reads) and one lock rewrite in spawn-gate-remediator.ts; the amendment already scopes them to a single ticket ('The ticket MUST add the caller-side assertions'). Splitting per-caller would leave the false-GREEN reachable via the untouched siblings. CORRECTION to the PRD and to my own cycle-2 analysis: the PRD's 'all three callers' claim is FALSE — microverse-runner.ts:302 ALREADY returns {success:false} and it IS consumed at :680. Two fixes + one characterization pin, or a worker damages a correct call site. HARD depends_on WS-1: AC-BCFR-2 (grep 'banned-construct:brace-free-if' -> 0) is unsatisfiable without editing spawn-gate-remediator.ts:125 (remediation class (e)), which is THIS ticket's file — the scope fence blocks whichever runs second. complexity_tier: large — lock rewrite + 2 caller fixes + 1 characterization pin + a new LOCKOUT_PATH reader + a discriminated finalize-gate result."
    }
  ]
}
```

---

## Specific Recommendations

Ranked by what stops this bundle from shipping green-and-broken. **#1 is new this cycle and it is the one that means the bundle currently has no green path at all.**

1. **Resolve the `AC-BCFR-6` contradiction — pick the rename or the exclusion.** (P0-1.) `tests/citadel/citadel-analyzer-wiring.test.js` audits the **real** citadel tree, passes **8/8 today**, and asserts `unwired === []`. The amendment's "the module SURVIVES" + unwiring `audit-runner.ts:24` makes it **RED**, which fails `AC-BCFR-6` **and** `AC-RLH-1`. Recommended branch: **rename to `changed-source-helpers.ts`** (the `-helpers.ts` suffix is excluded at test `:116`) and re-point `banned-casts-audit.ts:3-8`. Co-scope the test file. *Without this the bundle cannot go green in any branch.*

2. **Correct `AC-BCFR-3`'s count and scope it to the module.** (P0-2.) The string appears **4×**, not 2×; `== 0` over `src/` **mandates** deleting the `banned-casts` arms everyone agrees are out of scope. Re-key to a module-scoped check **plus an anti-regression pin** (`banned-casts-audit.ts` count stays `2`).

3. **Declare `WS-2 depends_on WS-1` and co-scope `spawn-gate-remediator.ts`.** (P0-3.) `AC-BCFR-2` *requires* WS-1 to edit WS-2's file. Delete the "disjoint files" sentence — it is the bundle's stated reason to exist and it is false. Add the four previously-unlisted WS-1 files, including **`tests/citadel/mechanical-finding-classifier.test.js`**.

4. **De-collide the `WS-n` namespace.** (P0-4.) The bundle and all three children use `WS-1`/`WS-2` for different things, and the Corrections section's *"WS-2 is a one-line emit-site swap"* aims a `small` label at the bundle's **largest** ticket. Use `R-JPCM/WS-2` form everywhere.

5. **Resolve R-BCFR's second fork and re-key its vacuous AC.** (P0-5.) "re-ground **or** delete" is an undecided fork in a build ticket; `AC-BCFR-8` is **vacuous in the branch the bundle already chose** (it is conditioned on a module deletion the amendment forbids) — the same defect the amendment caught in `AC-JPCM-8` and re-keyed, missed one section later.

6. **Add `AC-RLH-4b` (Risk Morty's, verbatim) and give `AC-RLH-6` an owner.** (P0-6.) Without 4b, `stalled_below_target` is written and never read, `classifyMicroverseHaltDecision` falls through at `:4062` to **`abort`**, **tsc says nothing** (the exit-code allowlist is typed against a *different* union), and szechuan **hard-aborts the pipeline before the finalize gate** — worse in the field than today's lie. Add the sixth bundle-acceptance ticket for `AC-RLH-6`.

7. **Then the P1s:** fix the three malformed `grep -rc` machine checks; add `AC-RLH-7` (non-empty ledger, stubbed judge); replace `AC-RLH-4` with the total four-row version (delete `targetHit`, do not reuse it); make `AC-RLH-5` an explicit XOR with **phase-scoped** fail-closed; quote `AC-JPCM-8`'s re-keyed text; give the four Corrections one AC each.

---

## Cross-Reference Notes

**Where I corrected another analyst.** **Codebase Morty's P0-1 is inverted, and it matters.** They audited `audit-citadel-wiring.js` / `tests/audit-citadel-wiring.test.js` — correctly finding it is synthetic-fixture-only and not in the release gate — and concluded *"WS-1 has NO gate forcing the dead-analyzer question … nothing will catch it at all."* **They audited the wrong file.** `tests/citadel/citadel-analyzer-wiring.test.js` is a **different** test, it audits the **real** `src/services/citadel/` tree via `readdirSync` (`:11`, `:51`), it asserts `unwired === []` (`:80`), it is in the fast tier, and it **passes 8/8 today** (I ran it). `mechanical-finding-classifier` reads "unwired" only because it sits on an **explicit `FILENAME_EXCLUDED` list** (`:16-29`) with a justifying comment — not because nothing is watching. So WS-1's danger is the **opposite** of what they said: not "no gate will catch it," but **"a gate WILL catch it, and the bundle's own correction is what trips it."** That is P0-1, and it is only visible from the requirements side — because the contradiction is between two *acceptance criteria*, not two lines of code.

**Where another analyst corrected me, and I verified rather than deferred.** My cycle-2 `AC-RLH-8` asserted **three** broken `LOCKOUT_PATH` callers, repeating the PRD's blast-radius note. Codebase Morty said the third is already honest. I read all three: **they are right.** `microverse-runner.ts:301-303` returns `{success: false}` and it **is** consumed at `:680`. My AC is re-scoped to **2 fixes + 1 characterization pin**. Left uncorrected, a worker is instructed to "fix" a correct call site. *(All three of us repeated the PRD's claim in cycle 1. The PRD was the common source of error — which is itself the finding: an unverified blast-radius note propagates through every downstream analysis that trusts it.)*

**Where Risk Morty went past me and I am adopting their finding wholesale.** Their cycle-2 P0-1 (WS-4's **abort-by-default**) supersedes my cycle-2 P0 #2. I said `stalled_below_target` would produce a *generic unrecognized halt*; they traced further and found `classifyMicroverseHaltDecision`'s default is `{action: 'abort'}` (`:4062`) **and** that `microverseExitCode` is an allowlist typed against `ExitReason` — a **different union** from `MicroverseExitReason` — so **no tsc exhaustiveness check protects the path**. An AC-complete WS-4 does not just halt dishonestly; it **kills the run before the finalize gate**, destroying landed work. Their `AC-RLH-4b` is the correct fix. My only addition is the requirements framing: **an enum member with no consumer branch is a value written and never read** — the exact `LOCKOUT_PATH` defect this bundle was chartered to kill. The bundle, as specified, would ship two more of them (`stalled_below_target`, `locked_out`).

**Where all three of us converged, from three doors.** WS-3's judge-shape compliance: Risk Morty called it an unstated *assumption*, Codebase Morty found the *mechanism* (the third prompt line, *"Do NOT add units or explanations after the number,"* is flatly incompatible with requesting an object), and I call it a missing *acceptance criterion*. The resolution is mine — **stub the judge, assert a non-empty ledger** (`AC-RLH-7`) — because a risk you can convert into a deterministic green test is not a risk. But Codebase Morty's mechanism is what makes it *buildable*: rewrite **all three** score-contract lines, and state whether the new contract still guarantees a trailing bare number, or `extractScore`'s fallback — the PRD's **entire stated risk mitigation for WS-3** — is dead on arrival.

**What only cycle 3 revealed.** In three cycles, **nobody opened the composed child PRDs.** Four of my six P0s are in them: the `AC-BCFR-6` contradiction, the wrong `AC-BCFR-3` count, the AC-mandated file collision, and R-BCFR's second undecided fork with a vacuous AC. The bundle-of-bundles fan-out rule is technically satisfied (no child carries an `## Atomic decomposition` section → one ticket per source → five), but **the child ACs are what the tickets will actually be graded against**, and three of them (`AC-BCFR-2`, `AC-BCFR-3`, `AC-BCFR-8`) are either unexecutable, over-scoped, or vacuous. The bundle amendment reviewed the *bundle* and never re-reviewed what it composes. That is the same shape as the defect it exists to fix: **a review pass that reports success over an input it never actually read.**
