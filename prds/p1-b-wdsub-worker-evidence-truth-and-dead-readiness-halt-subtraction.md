---
title: "B-WDSUB — worker-evidence truth + dead readiness_halt cluster subtraction (v2.1) [REFINED]"
priority: P1
finding: B-WDSUB
composes: [R-WDTF, R-PRNF9-DEAD]
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
baseline_sha: ef7e4fab
source_assessment: "MASTER_PLAN NEXT STEPS #3 + #5, re-grounded at HEAD. Refined 2026-07-22 by a 3-role × 3-cycle analyst team (session 2026-07-22-3d839159). The pre-refinement PRD is preserved at prd.md."
---

# B-WDSUB — ground truth outranks narration, and dead code stops pretending to be a guard

*(refined 2026-07-22 from the beta.4 refinement team: requirements + codebase + risk-scope, 3 cycles.
Every correction below is attributed to the analyst pass that produced it.)*

> ## ⚠ AUTHOR'S RETRACTION — read before implementing
> *(refined: risk-scope C3 P2 "assumption inventory", codebase C3 P0-1)*
>
> The pre-refinement PRD asserted five load-bearing facts. **All five were wrong.** They were written
> from the MASTER_PLAN ledger, not from the code. The citations were exact; the *behavior* behind them
> was never read — the [[feedback_verify_the_outcome_not_the_mechanism]] failure applied to this PRD's
> own authorship.
>
> | # | Original assertion | Verified at HEAD |
> |---|---|---|
> | 1 | "verified work is destroyed by the downstream reset" | **FALSE** — no reset on this path |
> | 2 | `evaluateWorkerOutcome` decides Done | **FALSE** — it is a gatekeeper; `:2031` overwrites |
> | 3 | The destruction is a `git reset` | **FALSE** — it is `completion_commit: null` at `:1996` |
> | 4 | The deployed runtime is tag `v2.1.0-beta.4` | **FALSE** — it is HEAD-compiled; version merely un-bumped |
> | 5 | `hasLifecycleArtifact` is all-of | **FALSE** — any-of (`types/index.ts:575-580`) |
>
> **The bundle is still correct. Its stated reason was not.** Implement from this refined document
> only; treat the original prose as retracted.

---

## Critical User Journeys
*(refined: requirements C3 Rec 7 — the PRD had no CUJ section; both harms lived only in prose)*

**CUJ-1 — the worker false-negative (WS-1 site 1). Repo-agnostic; bites every target repo.**
1. Operator launches a pipeline in any target repo.
2. A worker researches, edits, writes its lifecycle artifact, and **commits**.
3. The model's final message omits `<promise>I AM DONE</promise>`.
4. **Today:** `evaluateWorkerOutcome` returns `false` → short-circuits **past** `runWorkerGate` →
   `persistWorkerOutcomeStatus:1996` writes `{ status: 'Failed', completion_commit: null }`.
   The commit object survives; **the pointer to it is erased**. `Failed` is runnable
   (`mux-runner.ts:9499`), so the ticket is re-spawned and a full worker iteration is burned re-doing
   committed work.
5. **After this bundle:** the ticket flips **Done** with a non-null, resolvable `completion_commit` —
   or is **parked with work preserved** if `runWorkerGate` independently fails. Both are WS-1 successes.

**CUJ-2 — the refinement false-negative (WS-1 site 2).**
1. Operator runs `/pickle-refine-prd` with 3 cycles.
2. All three analysts write `analysis_<role>.md` correctly in cycle 1.
3. All three omit `<promise>ANALYSIS_DONE</promise>`.
4. **Today:** `success = false` for all three → `spawn-refinement-team.ts:1305`
   `if (results.every(r => !r.success)) break;` → **cycles 2 and 3 never run.** The operator sees
   "All workers failed" and receives a single shallow pass — whose analyses were nonetheless consumed
   (`:1487-1489` gates on `existsSync` alone). Silent quality degradation, not a visible failure.
   *(This is the harm the original PRD never stated — the deep-dive cycles that produced this very
   document would have been skipped.)*
5. **After this bundle:** freshness-checked artifact presence decides `success`; all cycles run.

---

## WS-1 — R-WDTF: subtract the narrative-token conjunct (P1, repo-agnostic)

### The defect — corrected
*(refined: codebase C3 Rec 1, risk-scope C3 Rec 2 — replaces the retracted "downstream reset" prose)*

A worker's success is decided by an AND-chain in which a **narrative token the model must remember to
print** is a hard conjunct, outranking ground truth. **Measured consequences at HEAD:**

1. **Attribution is erased.** `persistWorkerOutcomeStatus` (`spawn-morty.ts:1995-1996`) writes
   `{ status: 'Failed', completion_commit: null }` over a real commit. That null-write erases the
   attribution sha the salvage clean-tree path takes as input (`salvage-ticket.ts:147-151`,
   `attributable = !!attributedSha && …`). `Failed` is **not** terminal
   (`isTerminalStatus:127-130` = `done || skipped`) — **the nulled pointer is the blocker, not the status.**
2. **The ticket is re-spawned.** `mux-runner.ts:9499` — `runnable = normalized !== 'done' && normalized !== 'skipped'`.
   One forgotten token burns a full worker iteration.
3. **Uncommitted work is destroyed — two iterations later, via a different path.** The
   `evaluateWorkerOutcome === false` path performs **no reset**: the only `resetToSha` in the worker
   lifecycle is `spawn-morty.ts:1792`, inside `runWorkerGate`'s fail branch, and a `false` verdict
   short-circuits past it at `:2020`. `mux-runner.ts` never imports `resetToSha`
   (`grep -n "reset --hard" src/bin/mux-runner.ts` → one hit, a **comment** at `:2669`). Destruction
   occurs when the **re-spawned** worker's gate fails over the still-dirty tree.

**`evaluateWorkerOutcome` is a gatekeeper, not the Done authority** *(refined: risk-scope C2 P0-1)*:
`:2016 let { isSuccess }` → `:2020 if (isSuccess) {` → `:2031 isSuccess = workerGate.ok`. Removing the
conjunct changes **routing**, not the verdict.

### Site 1 — `spawn-morty.ts:2471`

```ts
const isSuccess = !ctx.mutableState.timedOut && tokenPresent && hasArtifact && (logNonTrivial || hasEdits);
```
**Delete the `tokenPresent` conjunct.** The "hoist/suppress" arm is ADDITIVE and REJECTED. Collateral:
the `tokenPresent` field in `buildValidationFailureReasons`' `checks` struct and its
`'no WORKER_DONE token'` reason string (`:2398-2412`).

### Site 2 — `spawn-refinement-team.ts:968` — DECISION RESOLVED, no research cycle
*(refined: requirements C3 P0-3 + Rec 3 — the original "REQUIRED DECISION" was already answered on disk, twice)*

```ts
const success = !workerTimedOut && hasToken(logContent, PromiseTokens.ANALYSIS_DONE);
```

**Take Arm A.** The ground-truth expression already exists on the adjacent line —
`spawn-refinement-team.ts:2176`: `exists: fs.existsSync(outputFile)`. A substitution using an
expression the file already computes: no new file, field, or write.

Consumer inventory of `success` (complete): `:1231`, `:1314`, `:1333`, `:1344` (display), `:2175`
(manifest field), `:2441` (warning), and **`:1305` — the only behavioral consumer**, which aborts
remaining cycles. Consumption of the analysis is `existsSync`-gated at `:1487-1489` and never reads
the flag.

*Arm B's gate was also already satisfied* (recorded so it is not re-litigated): `:2443` reads
*"Workers failed: … Synthesis will proceed with available analyses."* Arm B is permissible; **Arm A is
preferred** because it substitutes real evidence rather than deleting the conjunct outright.

**Staleness guard (MANDATORY)** *(refined: codebase C3 P1-5)*: nothing unlinks `analysis_<role>.md`
between cycles (the file's only `unlink` is `:2201`, for `manifestTmp`), so on cycle ≥ 2 a bare
`existsSync` returns `true` for an analyst that died writing nothing — a false **positive**, the WS-1
defect class pointed the other way. Gate on mtime freshness against the worker's `startTime`, reusing
the `checkGitEdits(dir, Math.floor(startTime / 1000))` precedent.

### WS-1 test seam

`evaluateWorkerOutcome` is **NOT exported** and has **zero** referencing tests — in **both** trees
(`src/bin/spawn-morty.ts:2459`, `bin/spawn-morty.js:2197`). Add the `export` keyword, following the
in-file precedent: `runWorkerGate` is already exported for exactly this reason
(`tests/spawn-morty-worker-gate.test.js:9` imports from `'../bin/spawn-morty.js'`). No `__testables`
bag, no DI seam.

### WS-1 Acceptance Criteria

- **AC-WDSUB-1** — `grep -c "tokenPresent" extension/src/bin/spawn-morty.ts extension/bin/spawn-morty.js || true`
  reports `0` for **both** trees. Additionally the `isSuccess` assignment contains no `hasToken(...)`
  call (the AC is otherwise rename-evadable). *(refined: codebase C3 Rec 5; risk-scope C1 — `|| true`
  because `grep -c` exits non-zero on zero matches and would abort a `set -e` script)*
  **Note:** `WORKER_DONE` legitimately survives at `:1112`, `:2381`, `types/index.ts`,
  `promise-tokens.ts`, and the stop-hook. AC-WDSUB-2 is the real guard.
- **AC-WDSUB-2a** — `evaluateWorkerOutcome` is exported from `src/bin/spawn-morty.ts` **and present as
  an export in the committed compiled mirror `extension/bin/spawn-morty.js`**, imported by name from
  `'../bin/spawn-morty.js'`. *(refined: requirements C3 Rec 4)*
- **AC-WDSUB-2b (sequencing — MANDATORY)** — the red-green proof MUST be two steps. **Step 1:** add
  `export` + rebuild the mirror **only** (no predicate change); run the test; the failure MUST be an
  **assertion** failure (`isSuccess === false` where `true` expected). **Step 2:** delete the conjunct;
  re-run; record green. A recorded "red" whose message contains `is not a function`, `undefined`, or
  `Cannot find module` does **NOT** satisfy AC-WDSUB-2. *(refined: requirements C3 P0-4)*
- **AC-WDSUB-2** — regression test: `isSuccess === true` for a worker that did not time out, has a
  lifecycle artifact, has git edits, and whose log contains **no** `WORKER_DONE`.
- **AC-WDSUB-3** — over-subtraction guard, pinned as a **single parametrized case table** in one test
  (`for (const c of CASES)`) — **never fanned out into multiple tickets**:

  | # | timedOut | artifacts | log ≥200B | git edits | expected | note |
  |---|---|---|---|---|---|---|
  | 1 | false | full lifecycle set | yes | yes | **true** | the AC-WDSUB-2 case |
  | 2 | false | none | yes | yes | **false** | artifact bar holds |
  | 3 | **true** | full set | yes | yes | **false** | timeout bar holds |
  | 4 | false | full set | no | no | **false** | surviving `logNonTrivial \|\| hasEdits` arm |
  | 5 | false | **`research_*.md` only** | yes | **no** | **true — CHARACTERIZATION** | see below |

  **Row 5 is mandatory and asserts `true`.** `hasLifecycleArtifact` is **any-of**
  (`types/index.ts:575-579`), so a research-only worker with a chatty log evaluates `true`. This is a
  **widening of a pre-existing hole, not a new one** — at HEAD such a worker already flips Done when it
  prints the token. **Do NOT tighten the predicate to close it:** raising to the teams all-of bar
  (`findMissingPrefixes`) is an additive bar-raise that false-Fails review workers and would likely red
  row 1's own fixture. Pin as accepted behavior so a later szechuan/anatomy pass cannot silently
  "correct" it; file a Drain Queue row. *(refined: all three analysts converged; requirements C3
  withdrew its own `findMissingPrefixes` remedy, risk-scope C2 self-corrected the same)*
- **AC-WDSUB-4** — `buildValidationFailureReasons` no longer emits `'no WORKER_DONE token'`, and its
  `checks` parameter type no longer declares `tokenPresent`.
- **AC-WDSUB-5** — site 2 ships **Arm A** plus the mtime-freshness guard, and a test pins the predicate.
  *(The original "record an arm" / "omitted entirely" contradiction is deleted — refined: requirements
  C3 P0-5 + Rec 5.)* If Arm A proves impossible at build time, ship a **characterization** test pinning
  the current predicate **and** a MASTER_PLAN Drain Queue row naming the site and why.
- **AC-WDSUB-5a** — a test pins that when all analysts are token-less but their artifacts are **fresh**
  on disk, the cycle loop at `:1305` does **not** break early. *(This is the behavior that matters;
  pinning the predicate alone does not cover it.)*
- **AC-WDSUB-6** — no new **runtime** file, field, flag, setting, or state key. *(One-word fix: the
  original forbade what the Test Expectations table mandates — refined: risk-scope C1/C2/C3 P1)*

---

## WS-2 — R-PRNF9-DEAD: delete the `readiness_halt` cluster (pure subtraction)

Zero producers of `'readiness_halt'` in `extension/src/` **or** the deployed tree. Dead end-to-end:
`:4047` reader never true → `:4048` never writes `pickle_readiness_halt` → `:3719` predicate never true
→ `:2799` + `:3890` never fire. Confirmed sites: `pipeline-runner.ts:2799, 3719, 3789 (comment), 3890,
4043-4050` — all five re-verified exact.

**Producer archaeology — ANSWERED, do not re-run** *(refined: codebase C3 P1-4, risk-scope C3 P0-5)*:
the producer was removed **deliberately** by `87d837f6 refactor(R-GATE-ADVISORY)`. Advisory behavior is
live at `mux-runner.ts:9714`. **Absence of a catcher is the designed state, not an accident.**
Archaeology is four commits: `be386f98`, `87d837f6`, `d53f20e5`, `61e546ec`.

### Deletion boundary — what must NOT be touched
- `isFatalPhaseFailure`'s `done_without_commit_evidence` check (`:2802`) is **live and load-bearing**.
- `getFatalPickleHaltReason`'s `start_commit` / baseline-unmeasurable branches are live.
- `tests/fixtures/codegraph-terms/a5f8cf4f.md` — inert fixture, leave alone.
- `tests/pipeline-runner-done-without-commit-evidence-reason-report.test.js` (`AC-MWMO-D2-11`, `:173`)
  — verified **green-safe**; named here so no worker redoes the trace.

### WS-2 test fate table — STATED, not inferred
*(refined: codebase C3 P1-1 + Rec 7. **Do NOT infer fate from green/red** — see AC-PRNF-9-3.)*

| Test | Line | Fate on deletion | Action |
|---|---|---|---|
| `AC-PRNF-9-1` | `:129` | green | **KEEP** |
| `AC-PRNF-9-2` | `:140` | **RED** — subject is the `:2799` early-return | **DELETE whole test** |
| `AC-PRNF-9-3` | `:160` | **stays green, tests nothing** | **DELETE** — and say why |
| `AC-PRNF-9-4` | `:189` | green | **KEEP** — the AC-WDSUB-9 over-reach proof |
| `AC-PRNF-9-5` | `:207` | green | **KEEP** |
| unused `recordExitReason` import | `:28` | n/a | **DELETE** (fossil of the removed producer) |

`AC-PRNF-9-3` is the trap: the fixture writes `exit_reason` via `stateOverrides`, the test calls
`writePipelineStatus` directly, and `:184` asserts back the value the fixture wrote. It never invokes
the deleted code. A worker's cheapest triage heuristic ("is it green?") keeps it, and the bundle ships a
permanently-green test named *"pickle_readiness_halt exit_reason is preserved"* in a codebase where no
such value can exist.

`tests/mux-runner.test.js` — delete **only** `:1067`. Lines `:1065-1066` execute the real extension and
are the **live** advisory-contract proof.

### WS-2 Acceptance Criteria

- **AC-WDSUB-7** — `grep -rn "readiness_halt" extension/src/ extension/bin/` returns `0` hits (covers
  both variants, **both trees**).
- **AC-WDSUB-8** — the producer-archaeology answer is recorded in the ticket citing `87d837f6`.
  *(Do not re-derive; it is settled above.)*
- **AC-WDSUB-9** — over-reach proof on **both** protected functions. `isFatalPhaseFailure` (exported,
  `:2792`) is pinned by the surviving `AC-PRNF-9-4`. **`getFatalPickleHaltReason` is NOT exported**
  (`:3887`) and has zero direct coverage — either **(a)** add the `export` keyword and pin that its
  `start_commit` / baseline-unmeasurable branches still return their strings, or **(b)** downgrade the
  deletion-boundary language to admit the branch ships unpinned. *(refined: codebase C3 P0-4)*
- **AC-WDSUB-10** — full `test:fast` green with no test skipped or quarantined to compensate for a
  deletion.

---

## WS-3 — Verification: RUN the claim, with a baseline

- **AC-WDSUB-11 (WS-1 outcome — baseline-controlled)** *(refined: risk-scope C3 Rec 4 + requirements C3
  Rec 2 — merged; the original Done-or-Failed binary would have **retracted a fix that worked**)*.
  Two observations, recorded verbatim, in this order:
  - **(a) Baseline, at HEAD, BEFORE the WS-1 edit** — drive the token-less-but-committed worker; record
    ticket `status` **and** frontmatter `completion_commit`. Expected `Failed` / `null`. **If the
    baseline already reads `Done`, STOP** — the premise is wrong and WS-1 must be re-grounded, not built.
  - **(b) After the edit** — identical scenario. Record status, `completion_commit`, the deciding locus,
    and the worker's commit sha.

  `persistWorkerOutcomeStatus:1993-1997` has **three** terminal behaviors, not two:

  | # | `isSuccess` | `flipSuppressed` | Frontmatter written | WS-1 verdict |
  |---|---|---|---|---|
  | 1 | `true` | — | `Done` + real `completion_commit` | **HOLDS** |
  | 2 | `false` | `false` | `Failed` + **`completion_commit: null`** | **REFUTED** |
  | 3 | `true` | `true` | **nothing — ticket parked, work preserved** | **HOLDS** |

  **Only arm 2 refutes WS-1.** Reporting "not Done" as a retraction in arms 1/3 is a false negative in
  the verification itself — arm 3 is a gate failure, a **separate** defect (e.g. the documented
  `__timeout__` false-fail class), and MUST be recorded as such.
  **Attribution rule:** the claim holds only if (a) is `Failed` and (b) is `Done`. `Done` in **both**
  arms means something other than WS-1 produced it — record and **retract**.
  Also record `flipSuppressed` as observed at `:2036`, and whether `routeFailedFlipSuppression`
  (`mux-runner.ts:5449`) was reached — post-WS-1 a new population arrives at that seam for the first time.
- **AC-WDSUB-11d (the discriminating field)** *(refined: codebase C3 Rec 2 — the reachability-only
  version **passes at HEAD with the bug live** and would certify nothing)*. `completion_commit` is the
  field that discriminates; `status` alone does not, and commit reachability **does not discriminate at
  all**. Record both: assert the worker's commit is reachable (`git cat-file -e <sha>` **and**
  `git merge-base --is-ancestor <sha> HEAD`) **and** that `completion_commit` is a non-null resolvable
  SHA. **A reachable commit with a nulled pointer is still a loss.**
- **AC-WDSUB-11e (routing change)** — record whether `runWorkerGate` executed (grep the worker log for
  the gate's phase output). At HEAD it MUST NOT have; post-fix it MUST have.
- **AC-WDSUB-12** — WS-2 is grounded in the **existing live test**: cite `tests/mux-runner.test.js:1065-1066`
  and `src/bin/mux-runner.ts:9714` as proof that a readiness finding is advisory-by-design per `87d837f6`.
  **No fabricated `readiness_halt` fixture is required or permitted.** WS-2 downgrades to a comment fix
  **only** if a live **producer** is found in `extension/src/` or `extension/bin/` — HEAD has none.
  *(The original decision rule was inverted — refined: all three analysts.)*
- **AC-WDSUB-13** — net LOC negative **scoped to code**:
  `git diff --stat <ticket-start-sha>..HEAD -- extension/src/ extension/bin/`. *(The original repo-wide
  form was unsatisfiable: measured `a17e9258..HEAD` = **+290**, of which **+289 is this PRD and the
  MASTER_PLAN rows**. Measured three times independently.)* **Deleting or thinning a test to make this
  number go green violates AC-WDSUB-10 and does NOT satisfy AC-WDSUB-13.**

### AC-WDSUB-11 harness contract (mandatory)
*(refined: requirements C3 P1 — both other analysts over-budgeted this and withdrew)*
Use the **staged leg**: `git init` + write + `git add`. `checkGitEdits:1146-1168` returns `true` at
`git diff --stat --cached` **before** reaching the same-second-racy committer-epoch comparison. The
commit-based fixture is **forbidden** — it is intermittently red by construction.
**Sampling point:** read frontmatter immediately after `persistWorkerOutcomeStatus` for the observed
spawn. A `Failed` ticket at iteration N may read `In Progress` at N+1 and `Done` at N+2 for reasons
unrelated to WS-1, so an undefined sampling point makes the AC non-reproducible.

---

## Non-Goals
*(refined: risk-scope C3 Rec 1 — absent after two cycles of all three analysts asking; two hard fences added)*

- **Neither `WORKER_DONE` nor `ANALYSIS_DONE` is retired as a token.** Both stay live at
  `stop-hook.ts:415`/`:621`/`:410`/`:618`, in `promise-tokens.ts`, and `types/index.ts:536`/`:539`.
  This bundle removes them from **success predicates only**.
- **Worker prompt instructions stay verbatim** (`spawn-morty.ts:1105`, `spawn-refinement-team.ts:813`).
- **`scrubForbiddenWorkerTokens` / `scrubWorkerLog` stay.**
- **`persistWorkerOutcomeStatus` is NOT edited.** `:1996`'s `completion_commit: null` is the real
  destruction mechanism and is **visible from WS-1's own edit site** — a live scope-creep attractor. It
  is a completion-evidence write, i.e. the narrow **R-PSRB** path. **Do not "also fix" it.**
- **`src/lib/salvage-ticket.ts` is NOT edited; the dead `backfillDone` wiring is NOT restored here.**
- **The off-repo fake-green at `runWorkerGate:1673` is NOT fixed here** — this bundle only *documents*
  that it makes `evaluateWorkerOutcome` authoritative in target repos.
- **`validate-teams-ticket.ts` is out of scope** (teams mode already uses artifact-only proof).
- **No `exit_reason` value changes other than the two `readiness_halt` variants.**

---

## Interface Contracts

### WS-1a — `evaluateWorkerOutcome` (`spawn-morty.ts`)
**Inputs/Outputs unchanged:** `{ ctx, logContent, startTime }` → `{ isSuccess, role }`

| Predicate | Before | After |
|---|---|---|
| `isSuccess` | `!timedOut && tokenPresent && hasArtifact && (logNonTrivial \|\| hasEdits)` | `!timedOut && hasArtifact && (logNonTrivial \|\| hasEdits)` |

**Invariant:** every surviving conjunct is ground truth. No narrative-token term may appear.
`buildValidationFailureReasons` `checks` — after: same minus `tokenPresent`; emitted strings limited to
`'timeout'`, `` `no ${role} lifecycle artifact` ``, `` `log ${n}B < 200B and no git edits` ``.

### WS-1b — refinement analyst (`spawn-refinement-team.ts:968`)
**Before:** `!workerTimedOut && hasToken(logContent, PromiseTokens.ANALYSIS_DONE)`
**After (Arm A):** `!workerTimedOut && <fresh artifact exists>` where freshness is mtime ≥ worker
`startTime`, mirroring `checkGitEdits(dir, Math.floor(startTime / 1000))`. Artifact:
`analysis_${roleId}.md` (written `:1228`, consumed `:1487`).

### WS-2 — `exit_reason` (`pipeline-runner.ts`)
Both `readiness_halt` variants removed from the read surface. `done_without_commit_evidence` and every
other value **unchanged**.

---

## Test Expectations

| Criterion | Test File | Description | Assertion |
|:---|:---|:---|:---|
| AC-WDSUB-2, -3 | `extension/tests/spawn-morty-worker-evidence.test.js` *(new)* | Single parametrized 5-row case table | Each row's `expected`; row 5 asserts `true` (characterization) |
| AC-WDSUB-4 | same file | Failure-reason string for artifact-less worker | Excludes `'no WORKER_DONE token'`; includes artifact reason |
| AC-WDSUB-5, -5a | `extension/tests/refinement-worker-evidence.test.js` *(new, unconditional)* | Token-less analysts with fresh artifacts | Predicate true; **`:1305` does not break early** |
| AC-WDSUB-7, -9 | `extension/tests/pipeline-runner-prnf9.test.js` *(triage per fate table)* | Delete `-9-2`/`-9-3` + unused import; keep `-9-1`/`-9-4`/`-9-5` | `done_without_commit_evidence` still fatal |
| AC-WDSUB-11..13 | WS-3 verification artifact | Baseline + post-fix observation | Per the three-state table; retract on arm 2 |

Runner: `npm run test:fast` — **never** bare `node --test <file>` (drops `node_modules/.bin` from PATH
and fabricates failures). Both new files carry `// @tier: fast` on line 1.
**Before committing to `fast`:** both new files shell out to `git`; confirm against
`scripts/audit-subprocess-heavy-tests.sh` and `audit-test-isolation.sh` (release-gate members). With
the staged-leg fixture that is 2 short subprocesses. *(Note: `.serial-tests.json` exists only for the
`integration` and `expensive` tiers — there is no fast-tier serial manifest.)*

---

## Compiled-mirror co-scoping (MANDATORY)
*(refined: codebase C3 P0-3 + Rec 4 — the single highest-risk finding in refinement)*

`extension/tsconfig.json:6-7` sets `"outDir": "."` / `"rootDir": "src"`, and `install.sh:389` rsyncs with
**`--exclude='src'`**. **The compiled `extension/bin/*.js` mirror IS the deployed runtime; the `.ts`
never ships.** Every ticket allowlist MUST co-scope the mirror:

| Ticket | Allowlist |
|---|---|
| WS-1a | `extension/src/bin/spawn-morty.ts` **+ `extension/bin/spawn-morty.js`** |
| WS-1b | `extension/src/bin/spawn-refinement-team.ts` **+ `extension/bin/spawn-refinement-team.js`** |
| WS-2 | `extension/src/bin/pipeline-runner.ts` **+ `extension/bin/pipeline-runner.js`** |

**The failure mode is a silent green, not a deadlock.** The fence (`check-scope-diff.ts:34-38`) matches
**staged** paths, and its own remediation text (`:137`) advises *"Unstage outside-scope paths…"*. A
worker following that advice commits src-only, `grep` on `src/` returns `0`, **AC-WDSUB-1 passes**, and
the deployed runtime keeps the bug. Precedent: `87d837f6` committed both trees together.

---

## Tiering

| Ticket | Tier | Rationale |
|---|---|---|
| WS-1a | **medium** | worker Done-flip predicate |
| WS-1b | **medium** | refinement lifecycle |
| WS-2 | **medium** | orchestrator |
| WS-3 | **medium** | drives a real spawn against a dirty tree |

**No ticket may be `small`** — `small` provably skips `test:fast` (`runWorkerGate:1700-1702`), which
would let the red-green proof go unrun on the very predicate being changed.

---

## Risks

- **WS-1 moves a worker class ONTO the one reset-capable path in the lifecycle.** *(refined: codebase C3
  P0-2 — the original Risks section had this backwards.)* Today a `false` verdict short-circuits at
  `:2020` and is **tree-safe**. Post-subtraction the same worker enters `runWorkerGate` and on gate
  failure reaches `resetToSha` + `git clean -fd` (`:1792`). Mitigation is `evaluateFailedFlipSuppression`
  (`mux-runner.ts:8389-8432`). **Three residuals accepted and declared:** (i) the evidence check
  **fails open to `proceed`** on error (`:8393-8395`) and `proceed` means the reset runs;
  (ii) `failed_flip_suppression_cap` (default **2**) draws down the persistent session-wide
  `state.recovery_attempts` ledger shared by all callsites — WS-1 adds a new population consuming it;
  (iii) `git clean -fd` removes **untracked** files and the preserve set carries only `[sessionRoot]`.
  **This exposure is self-repo-only** — in target repos `runWorkerGate:1673-1687` returns `ok: true`
  unconditionally, so the post-fix worker never reaches `:1792`. CUJ-1's harm is repo-agnostic; this
  risk is not.
- **The assumed safety net under a false-Failed worker does not exist.** *(refined: risk-scope C3 P0-2)*
  `backfilled_clean_tree` — the disposition written for exactly this scenario — is **unreachable in
  production**: `grep -rn "backfillDone" src/` → 4 hits, **all inside `salvage-ticket.ts`**, and neither
  production call site (`mux-runner.ts:5439`, `:6110`) passes `completionCommitSha`. Its own comment
  (`:124`) claims *"Production wires this from mux-runner"* — **false at HEAD**. The suite is green
  because `tests/salvage-backfilled-done.test.js` **injects** the dep. **Out of scope** (additive, and
  it edits the R-PSRB salvage path) → Drain Queue row below.
- **WS-1 narrows the false-Failed population; it does not close the harm.** Workers that pass
  `evaluateWorkerOutcome` and then fail `runWorkerGate` still reach `:1996` unless `flipSuppressed`.
- **No retroactive healing.** `bounded_terminal_escape_cap` (3) can drive a repeatedly-false-Failed
  ticket to terminal `Skipped` (`mux-runner.ts:6106-6114`). Pre-existing sessions carrying such tickets
  are **not** repaired by this fix.
- **Over-subtraction** — mitigated by AC-WDSUB-3 rows 2–4.
- **The build runs on 41 never-gated commits**, so anomalies have two candidate causes. *(The deployed
  `bin/*.js` are byte-identical to the repo's compiled mirror at HEAD — the runtime is HEAD-compiled,
  merely un-bumped. Source `.ts` edits still do not reach the running worker until `install.sh`, so the
  build remains pipeline-safe.)*

---

## Simplification Review (subtract-before-add)

(1) **Adds no runtime mechanism** — no gate, flag, state field, setting, or code path. Declared
additions: **one `export` keyword** on `evaluateWorkerOutcome` (possibly a second on
`getFatalPickleHaltReason` per AC-WDSUB-9) and **two test files**. Neither is a runtime mechanism.
**Honest caveat:** the claim is true of the *code* and false of the *control flow* — WS-1 changes
routing (see Risks).
(2) **REUSE:** WS-1a reuses ground truth already computed in the same function. WS-1b reuses
`fs.existsSync(outputFile)` already computed at `:2176` and the `checkGitEdits` freshness precedent.
WS-2's over-reach test reuses the existing `pipeline-runner-prnf9.test.js` harness.
(3) **The brittle thing is the narrative token as a hard conjunct** — a model-memory dependency upstream
of an attribution-erasing write. This DELETES that dependency rather than wrapping it in a suppression.
(4) **Subtraction:** one conjunct + one reason string + one struct field (WS-1a); one token dependency
(WS-1b); four reader sites, one promotion block, one dead predicate, two dead tests, one fossil import
(WS-2). **Bounded honestly:** WS-1 removes the narration dependency from the completion predicate. It
does **not** remove `runWorkerGate`'s false-fail modes, and for any worker that still flips Failed the
`:1996` null-write and the dead back-fill mean the work is still not automatically recovered.
**This bundle shrinks the harm population; it does not close the harm.**

---

## Implementation Task Breakdown

| Order | ID | Title | Priority | Tier | Entry | Exit | Files |
|---|---|---|---|---|---|---|---|
| 10 | `44b161e3` | Capture the pre-fix baseline for the token-less worker outcome | High | medium | Repo at `ef7e4fab`, fast tier green | Baseline `status` + `completion_commit` recorded | `extension/tests/fixtures/wdsub-baseline.md` |
| 20 | `0b9ba38d` | Subtract the `tokenPresent` conjunct from the worker success predicate | High | medium | `44b161e3` done | Predicate is ground-truth-only, both trees | `extension/src/bin/spawn-morty.ts`, `extension/bin/spawn-morty.js`, `extension/tests/spawn-morty-worker-evidence.test.js` |
| 30 | `17007f06` | Replace the refinement analyst success token with fresh-artifact evidence | High | medium | `0b9ba38d` done | Arm A + freshness guard, both trees | `extension/src/bin/spawn-refinement-team.ts`, `extension/bin/spawn-refinement-team.js`, `extension/tests/refinement-worker-evidence.test.js` |
| 40 | `bcd9ce96` | Delete the dead `readiness_halt` reader cluster from pipeline-runner | High | medium | `17007f06` done | Zero `readiness_halt` refs in either tree | `extension/src/bin/pipeline-runner.ts`, `extension/bin/pipeline-runner.js`, `extension/tests/pipeline-runner-prnf9.test.js`, `extension/tests/mux-runner.test.js` |
| 50 | `7412bef9` | Verify the WS-1 claim against the baseline and attribute or retract it | High | medium | All prior done | Claims executed and attributed, or retracted | `extension/tests/fixtures/wdsub-verification.md` |
| 60 | `8784c6cb` | Wire: compiled-mirror parity + full-suite integration | High | medium | All prior done | src/mirror parity proven, fast tier green | `extension/bin/*.js` (repair only) |

**No ticket is `small`** — `small` provably skips `test:fast` (`runWorkerGate:1700-1702`), which would
let the red-green proof go unrun on the very predicate being changed.

### Decomposition deviations (recorded, not silent)

- **The four Step-7e hardening tickets are intentionally NOT created** (operator decision, 2026-07-22).
  `/pickle-pipeline` runs **citadel → anatomy-park → szechuan-sauce** after the build, covering
  conformance, subsystem data-flow, and code quality respectively. For a ~50-line subtraction across
  three files, four `large` in-build review tickets duplicate the phases that follow — and adding
  machinery is what THE LENS rejects. The skip gate did not fire; this is a deliberate deviation.
- **WS-3 is split by TIME, not by terminal state.** `44b161e3` (baseline) and `7412bef9` (post-fix) are
  separate tickets **only** because `AC-WDSUB-11`'s baseline arm must be observed before the WS-1 edit
  exists. The three terminal-state arms stay together in `7412bef9`, per the refinement team's explicit
  instruction that they are "arms of one observation, not three tickets."
- **`AC-WDSUB-3`'s five rows are ONE parametrized case table in ONE test in ONE ticket** — never fanned
  out. All three analysts flagged this as the bundle's only AC-shape risk.

---

## MASTER_PLAN Drain Queue rows (author at close — deferred work must land somewhere drainable)
*(refined: requirements C3 P1, risk-scope C3 Rec 3 — per [[feedback_loop_failure_log_bug_prd_and_master_plan]])*

1. **R-SBFD** — wire `backfillDone` + `completionCommitSha` at the production salvage seams, **or**
   delete the dead disposition and its false comment. `tests/salvage-backfilled-done.test.js` proves the
   primitive, never the wiring.
2. **R-WDTF-ANYOF** — role-aware lifecycle-artifact bar (AC-WDSUB-3 row 5's accepted residual).
3. **R-CMDRIFT** — `CLAUDE.md`'s R-PSRB file list is drifted: `salvage-ticket.ts` lives under `src/lib/`
   (not `src/services/`) and `reconcile-ticket-truth.ts` **does not exist** anywhere in `src/`.
4. **R-ORGF** — the off-repo `runWorkerGate:1673` fake-green makes `evaluateWorkerOutcome` the sole Done
   authority in every target repo (documented here, not fixed).
