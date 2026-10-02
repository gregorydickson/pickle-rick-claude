# B-RUNREPORT-54 — a Done that its own conformance verdict refutes, citadel noise that reads as clean, refinement messages that read as failure (#54)

Read at `main@72797f3e`. Every premise below was re-measured there, and is content-identical in the deployed
runtime (built from `exp/b-lanes`): the citadel modules `cmp`-equal, and the predicate strings named per item are
present once in the deployed JS. The `exp/b-lanes` deltas in `pipeline-runner.ts` and `scope-resolver.ts` are lane
code and touch no item here. Measured 2026-10-02.

The field session directory is not on this machine. All field numbers come from the issue text. Each mechanism
below was reproduced on a synthetic fixture instead.

## Field incident (numbers only)

One `/pickle-pipeline --refine` run on a TypeScript pnpm monorepo that does not use pickle-rick's own conventions:
- 26 tickets, 665 minutes;
- every ticket ended with a completion commit.

What went wrong:
- **F1.** One ticket was flipped Done while its latest `conformance_*.md` verdict was FAIL. The manager caught it on
  a later turn.
- **F2.** Citadel finished in 36 s over a diff of about 8,700 lines:
  - 34 findings: 33 Medium, 1 Low, 0 at High or above;
  - almost all were `orphan-test-file` ("no inbound ENFORCE ref"), a convention this repo does not have;
  - none spoke to whether the diff meets the PRD.
- **F3.** The refinement AC-shape gate printed 6 lines for 2 smells, each one 3 times. The manifest said
  `all_success: false` with 3 of 3 analysts successful and `decomposition_quality_flags: []`.
- **F4.** `symbol_audit.md` said `Status: FAIL` because one symbol was PHANTOM. That symbol exists in an installed
  dependency's type declarations.
- **F5.** 25 tickets ended `status: "Done"` and 1 ended `status: Done`.
- **F6.** `[ensureMonitorWindow] unrecognized command_template '_pickle-manager-prompt.md'` appears on every
  launch. It is in 14 of this machine's own `pipeline-runner.log` files.
- **G1.** `--refine <session>/prd.md` created a second session instead of binding to the one that owns the PRD.
- **G2.** Scope never armed on a fresh branch with 0 commits ahead.

## Item status

| Item | Status at `main` | Mechanism (file:line) | Falsifying observation taken |
|---|---|---|---|
| F1 | **live** | No reader of the conformance verdict exists. `readLatestTicketConformanceSnapshot` (`bin/mux-runner.ts:6467`) reads only `## Manager Handoff`. `guardCompletionCommitBeforeDone` (`:6331`) checks commit evidence, the worker gate and Z1 executable assertions (`:6410`), but not the verdict. | Probe: a git fixture with a trailered commit, a self-flipped `status: Done` and `conformance_*.md` saying `## Verdict: FAIL`. The guard returns `{ok:true}` and the status stays `Done`. |
| F2a | **live** | `collectOrphanTestFileFindings` (`services/citadel/trap-door-coverage-audit.ts:228-245`) emits `orphan-test-file` for every scoped test not in `referencedFiles`. A repo with no `ENFORCE:` anywhere has an empty set, so every changed test fires. | `runT6TrapDoorCoverage` on a fixture whose only `CLAUDE.md` has no `ENFORCE:` and one changed `*.spec.ts` gives 1 orphan finding. |
| F2b | **live (mechanism); the field cause is a hypothesis** | The only PRD-to-diff check is `buildAcCoverageScorecard` (`services/citadel/audit-runner.ts:361-366`). It reads only `AC-*` ids (`prd-parser.ts:118`). A PRD keyed `FR-*` parses to 0 criteria, gives 0 rows and 0 findings, and nothing says "unmeasured". | Citadel report over an FR-only PRD and a 2-file diff: `ac_coverage` has 0 rows and `skipped: null`; the findings are `orphan-test-file:src/svc.spec.ts` and `anatomy-park:missing`. Run against the content-identical deployed JS, because the worktree has no `node_modules`. Whether the field PRD had 0 `AC-*` ids is not observable here. |
| F3a | **live** | `collectAcShapeData` (`bin/spawn-refinement-team.ts:1815`) concatenates `ac_shape_smells` per analyst. `evaluateAcShapeEnforcement` (`:2189`) emits one violation per smell copy, not per `ac_id`. `runAcShapeEnforcement` (`:2276`) then exits 2, and Step 5 of `pickle-refine-prd.md` says "stop". The check runs over analyst ticket hints before Step 7 has decomposed anything. | 3 analysts × 1 smell × 2 unjustified hint tickets give 3 violations and 3 "lacks // JUSTIFICATION:" lines, exit 2. |
| F3b | **live by derivation; which ids is a hypothesis** | `all_success = results.allSuccess && missingRequirementIds.length === 0` (`:2700`). All 3 workers succeeded, so the coverage conjunct must be the false one. The gap is printed to stderr only (`:2728`) and never stored in the manifest, so a reader of `refinement_manifest.json` cannot see why. Expected ids are `AC-*` only (`REQUIREMENT_ID_RE`, `:2063`). | `computeRequirementCoverageGap`: a PRD with `FR-1`→`AC-1` and `FR-2`→`AC-2`, and tickets mapping `FR-1`/`FR-2`, gives `missing: [AC-1, AC-2]`. |
| F4 | **live** | `hasSourceHit` (`bin/spawn-refinement-team.ts:2523`) walks `src/` (or the whole tree) with `node_modules` in `SKIP_SOURCE_DIRS` (`:2343`). A dependency's declared type is reported `phantom`, "no source-tree hit found". The finding is advisory (it lands in `ticket_quality_warnings`), but `Status: FAIL` is written to `symbol_audit.md`. | Fixture with a root `package.json` depending on `@fx/types` and `node_modules/@fx/types/index.d.ts` declaring the symbol gives `ok:false`, status `phantom`. |
| F5 | **live, cosmetic: no runtime effect** | Both runtime writers quote: `git-utils.ts:126` and `transaction-ticket-ops.ts:209`. LLM-authored writes follow the prompt text, which says `status: Done` bare in 6 places across `spawn-morty.ts:1146,1148` and `send-to-morty.md:104,110`. | `getTicketStatus` and `collectTickets` return `Done` for both spellings. On this machine's sessions: 40 quoted, 13 bare. |
| F6 | **live, cosmetic** | `inferMonitorMode` (`services/monitor-window.ts:73-91`) tests `tpl.startsWith('pickle')`. The pickle manager's own template is `_pickle-manager-prompt.md` (`pipeline-runner.ts:1926`, `setup.ts:298`), so it falls through to the unrecognized-template WARN. The mode is still correct (`pickle`). | Probe: state with `command_template: '_pickle-manager-prompt.md'` gives `pickle` and 1 WARN. |
| G1 | **live** | `.claude/commands/pickle-pipeline.md` Step 0a path 1: "leave `SESSION_ROOT` unset". Path 3 sets `SESSION_ROOT=$(dirname "$PRD_PATH")`. | `awk '/^\*\*0a/,/^No PRD found/' … \| grep -c state.json` gives 0. |
| G2 | **live, and the naive fix would add a halt** | Step 0.6 signal 3 requires `AHEAD >= 1`, so a 0-ahead branch never arms scope. The runtime already tolerates an empty setup diff: `setupScope` (`pipeline-runner.ts:2138`) demotes `SCOPE_EMPTY_DIFF` to a WARN or a file-impact seed. **But** `scope: branch` with no `scope_base` on a 0-ahead branch whose default has advanced makes `merge-base == HEAD` while the base tip differs. That throws `SCOPE_BASE_AHEAD_OF_HEAD` (`scope-resolver.ts:240-251`), and `setupScope` halts with `scope_base_ahead_of_head`. | `resolveScope` on a 4-way fixture (base advanced or not × `scope_base` pinned to the fork sha or not): only *advanced + unpinned* gives `SCOPE_BASE_AHEAD_OF_HEAD`; the other three give `SCOPE_EMPTY_DIFF` (WARN path). |
| G3 | out of scope | Nothing in `extension/src` or `.claude/commands` calls `git merge-tree` or checks drift against the base at the end of the pipeline. | grep: 0 files. |
| G4 | out of scope | Partly covered: the opt-in `PICKLE_REFINE_WORKFLOW=on` path (`.claude/workflows/refine-analyze.js`) runs Step 6 synthesis in a subagent. Step 7 decomposition stays inline on both paths. | — |

**Already satisfied:** none. Every reported item reproduces at `main@72797f3e`.

## Decisions (taken by the babysitter at the recommended defaults, 2026-10-02 — mechanics, not goal changes; the operator may override)

- **D-1 (F3b).** Keep TIER-2.6 gh-10. `all_success` keeps meaning "analysts succeeded AND every PRD-defined
  requirement is mapped". That was a deliberate change, pinned by `spawn-refinement-team-checker.test.js` AC-1/AC-2
  (`:2449-2523`). Nothing in `src/` or `.claude/commands` reads `all_success`; only the schema, the opt-in workflow
  prompt and tests do. So the defect is that the false value is unexplained, not that it is false. Fix: persist the
  gap. The alternative, splitting the flag back to worker outcomes, reverts gh-10. Recommended: persist the gap.
- **D-2 (F3a).** Leave the AC-shape gate's exit-2 disposition as it is in this bundle. Dedupe and reword only.
  - Demoting the gate to advisory, as R-GATE-ADVISORY did for readiness and ticket-audit, removes a pre-pipeline stop
    on analyst hints. That would be a subtraction.
  - But it re-pins about 28 assertions across 5 test files, and that belongs in its own PRD.
  - Recommended follow-up, not this bundle.
- **D-3 (F2b).** Disclose, do not widen.
  - The scorecard records "0 criteria parsed — PRD-to-diff conformance unmeasured". It does not learn `FR-*`.
  - Adding a second id namespace is an enumerated-set addition, and the refinement coverage gap shares the same
    `AC-*`-only rule.
  - A derived "defined requirement id" rule shared by both is the honest collapse, and it is a follow-up.
- **D-4 (F5).** Fix only the prompt wording (a rider on T1), or record it and add nothing. Readers normalize both
  spellings, so the loop cannot be affected. Recommended: the rider, because it is the same file and costs nothing.

## Requirements

### T1 — a FAIL conformance verdict refuses Done locally, reusing Z1 (F1, + F5 rider; tier: medium)

- **Change.**
  - Extend `readLatestTicketConformanceSnapshot` (`bin/mux-runner.ts:6467`) with `verdictFail: boolean`. Take the
    LAST `Verdict` heading or line in the file, and read the first `ALL_PASS`/`FAIL` token on it or on the next line.
    No match means `false`.
  - In `findFailedAcceptanceAssertion` (`:6293`), return a failure when `verdictFail` is true, before the executable
    assertions run.
  - Reuse `refuseDoneOnFailedAcceptanceAssertion` and its `ACCEPTANCE_ASSERTION_FAILED` disposition. That parks a
    self-flipped Done to In Progress, records no `exit_reason`, and lets the loop continue. **No new disposition and
    no new halt.**
  - All 7 `guardCompletionCommitBeforeDone` call sites inherit this.
- **Rider (F5, D-4).** Prompt text says `status: "Done"` in `spawn-morty.ts:1146,1148` and `send-to-morty.md:104,110`.
- **Replay evidence (classifier oracle).**
  - The candidate last-verdict reader was replayed over the 50 live `conformance_*.md` on this machine: 47 read
    PASS, 0 FAIL, 3 have no verdict (and refuse nothing).
  - The corpus contains no FAIL, so the FAIL direction is proven only by the fixture below. State that in the test
    comment.
- **ACs.**
  - (a) New case in `tests/mux-runner.test.js` beside Z1-1:
    `Z1-6: a self-flipped Done whose latest conformance verdict is FAIL is un-claimed`. It reuses `z1Repo`,
    `z1Session` and `z1CommitTrailered`, with prose-only criteria plus `conformance_2026-10-01.md` containing
    `## Verdict: FAIL`. Assert `guard.ok === false`, `isAcceptanceAssertionRefusal(guard)`, status `In Progress`,
    and no `exit_reason`.
    - Measured at HEAD with the same fixture as a scratch probe: `{"ok":true,"disposition":null,"status":"Done"}`.
      It reds.
  - (b) Over-trigger control: the same fixture with `## Verdict: ALL_PASS`, and with a FAIL verdict followed by a
    later `## Verdict: ALL_PASS` in the same file, both give `guard.ok === true`.
  - (c) Rider: `grep -o 'status: Done' .claude/commands/send-to-morty.md extension/src/bin/spawn-morty.ts | wc -l`
    gives 0. Measured at HEAD: **6**.

### T2 — citadel stops grading a convention the repo does not have, and says when it measured no PRD (F2a, F2b; tier: medium)

- **F2a change.** In `runT6TrapDoorCoverage`, emit no `orphan-test-file` finding unless at least one discovered
  `CLAUDE.md` contains the token `ENFORCE:`.
  - This is derivation, not a repo list. The convention's presence is read from the catalogs the audit already
    walks.
  - `orphan-enforce` and `orphan-test-case` are untouched: they need a ref to exist.
- **F2b change (D-3).**
  - In `runPrdContractAnalyzers` (`audit-runner.ts:361`), a resolved PRD with `parsedPrd.acceptanceCriteria.length
    === 0` returns the existing `AnalyzerSkippedResult` shape:
    `{findings: [], skipped: 'no_acceptance_criteria', reason: 'PRD defines no AC-* ids — PRD-to-diff conformance unmeasured'}`.
  - The citadel cycle line in `pipeline-runner.ts` (`:3393`) appends `; ac_coverage UNMEASURED (<reason>)` when that
    section is skipped.
  - Reporting only. It is no verdict input and no remediation trigger.
  - A 36-second duration is not used as a signal: a time threshold is an invented constant.
- **Pinned tests that change.** `tests/citadel/trap-door-coverage-audit.test.js` › `orphan_test_file: … → MEDIUM`
  (`:75`) seeds `enforceLines: ''`. It asserts exactly the defect and must gain one `ENFORCE:` line. The AP15
  control (`:660`) already carries `ENFORCE: none today` and stays green unchanged, which makes it a free negative
  control.
- **ACs.**
  - (a) From `extension/`:
    ```
    node --input-type=module -e "import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {runT6TrapDoorCoverage} from './services/citadel/trap-door-coverage-audit.js';const d=fs.mkdtempSync(path.join(os.tmpdir(),'f2-'));fs.mkdirSync(path.join(d,'src'));fs.writeFileSync(path.join(d,'src/a.spec.ts'),'');fs.writeFileSync(path.join(d,'CLAUDE.md'),'# notes\n');console.log(runT6TrapDoorCoverage({projectRoot:d,claudeFiles:[],testFiles:['src/a.spec.ts']}).findings.filter(f=>f.id.startsWith('orphan-test-file:')).length);fs.rmSync(d,{recursive:true})"
    ```
    prints `0`. Measured at HEAD: **`1`**.
  - (b) The same with `CLAUDE.md` containing `ENFORCE: none` still prints `1` (negative control).
  - (c) A new case in `tests/citadel-ac-coverage-scorecard.test.js`: a git fixture whose PRD lists only `FR-1`/`FR-2` and whose diff adds a source
    file and a spec gives `sections.ac_coverage.skipped === 'no_acceptance_criteria'`. Measured at HEAD: `skipped:
    null`, 0 rows. Control: a PRD with `AC-1` still produces rows.

### T3 — refinement messages say what was measured (F3a, F3b, F4; tier: medium)

- **F3a.**
  - `evaluateAcShapeEnforcement` iterates smells collapsed by `ac_id`, keeping the first occurrence and unioning
    `ticket_ids`. This is the same per-ticket-cardinality rule `collapseAnalystTicketCopies` states for tickets.
  - Reword the violation line to name its phase: `… analyst decomposition hints for <ac_id> split it into N tickets
    without // JUSTIFICATION: — collapse or justify at Step 7`.
  - The exit code is unchanged (D-2).
- **F3b (D-1).**
  - Persist the gap in the manifest as `missing_requirement_ids: string[]`, written always; empty means fully
    covered.
  - Add the field to `types/refinement-manifest.schema.json`, which has `additionalProperties: false`.
  - `all_success` keeps its derivation.
- **F4.**
  - When `hasSourceHit` misses, resolve the symbol against declared-dependency `.d.ts` files, giving status `valid`
    with reason `declared in an installed dependency`.
  - **Reuse:** the R-RCEX resolver in `bin/check-readiness.ts:326-400` (`declaredDependencyNames`,
    `collectDtsFilesUnder`, `collectExternalDtsFiles`, and the 3,000-file / 512 KiB caps) is moved unchanged into
    `services/` and imported by both callers. That is one structural commit, then one behavioural commit.
  - **No second resolver.**
- **Stated limit.** R-RCEX reads `package.json` at the repo root and at `extension/` only. A dependency declared only
  in a nested workspace package stays unresolved. Widening that rule widens it for readiness too, so it is a
  follow-up, not this ticket.
- **ACs.**
  - (a) From `extension/`:
    ```
    node --input-type=module -e "import {evaluateAcShapeEnforcement as e} from './bin/spawn-refinement-team.js';const R=['requirements','codebase','risk-scope'];const v=e({ac_shape_smells:R.map(r=>({ac_id:'AC-9',ticket_ids:[],source_worker:r,source_file:r})),tickets:R.flatMap(r=>['t1','t2'].map(id=>({id,title:id,source_ac_ids:['AC-9'],acceptance_test:'x',source_worker:r,source_file:r})))});console.log(v.length)"
    ```
    prints `1`. Measured at HEAD: **`3`**.
  - (b) `grep -c missing_requirement_ids extension/src/types/refinement-manifest.schema.json` gives ≥ 1. Measured at
    HEAD: **0**. Add a checker test: a manifest built with every analyst successful and `AC-4` unmapped carries
    `missing_requirement_ids: ['AC-4']` and `all_success: false`. The existing AC-1/AC-2 cases stay green.
  - (c) From `extension/`, a fixture with root `package.json` → `@fx/types` and `node_modules/@fx/types/index.d.ts`
    declaring `'widget_state'`, with a PRD line naming the helper `` `widget_state` ``.
    `evaluateSymbolAudit(...).ok` is `true`. Measured at HEAD: **`false phantom`**. Negative control: an undeclared,
    absent symbol stays `phantom` (`symbol-audit-fence-awareness.test.js:91` keeps passing).

### T4 — the pickle manager template is recognized (F6; tier: small)

- **Change.** In `inferMonitorMode`, strip one leading `_` from `tpl` before the existing tests. No new list member.
- **Note.** `microverse.md` (`pipeline-runner.ts:1740`) also falls through to the WARN. It is left alone, because it
  is not in the field report and its correct mode is not obvious.
- **ACs.**
  - (a) From `extension/`:
    ```
    node --input-type=module -e "import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {inferMonitorMode} from './services/monitor-window.js';const d=fs.mkdtempSync(path.join(os.tmpdir(),'f6-'));fs.writeFileSync(path.join(d,'state.json'),JSON.stringify({schema_version:5,command_template:'_pickle-manager-prompt.md'}));const w=[];console.log(inferMonitorMode(d,m=>w.push(m)),w.length);fs.rmSync(d,{recursive:true})"
    ```
    prints `pickle 0`. Measured at HEAD: **`pickle 1`**.
  - (b) `tests/pickle-utils-ensure-monitor-window-mode.test.js:135` (`unknown-widget.md` → exactly 1 WARN) stays
    green as the negative control.
  - (c) Add one row to that file.

### T5 — `/pickle-pipeline` binds the PRD's session and arms scope on a 0-ahead branch without a new halt (G1, G2; tier: small, doc-only)

- **G1.** Step 0a path 1: if `$(dirname "$PRD_PATH")/state.json` exists, set `SESSION_ROOT` to that directory and
  treat it exactly as path 3. That means:
  - 0b and mid-refinement detection apply;
  - 0c invokes `/pickle-refine-prd --resume "${SESSION_ROOT}"`.

  Otherwise behaviour is unchanged.
- **G2.**
  - Step 0.6 signal 3 drops `AND AHEAD >= 1`.
  - When `AHEAD == 0` and the operator chooses `Lock to branch`, also set
    `SCOPE_BASE=$(git -C "${TARGET}" rev-parse HEAD)`. With zero commits ahead, the fork point is HEAD. Step 4
    writes it as `scope_base`.
  - The pin is load-bearing: without it, an advanced default branch turns the new prompt into a
    `SCOPE_BASE_AHEAD_OF_HEAD` halt at setup (measured above).
  - README line 168 gets the "including a fresh branch with zero commits ahead" wording (Documentation Rule).
- **ACs.**
  - (a) `awk '/^\*\*0a/,/^No PRD found/' .claude/commands/pickle-pipeline.md | grep -c 'state.json'` gives ≥ 1.
    Measured at HEAD: **0**.
  - (b) `awk '/^## Step 0.6/,/^## Step 1:/' .claude/commands/pickle-pipeline.md | grep -c 'AHEAD >= 1'` gives 0.
    Measured at HEAD: **1**.
  - (c) The same span `| grep -c 'SCOPE_BASE'` gives ≥ 1. Measured at HEAD: **0**.
  - (d) `tests/pickle-pipeline-skill.test.js` and both scope-inference suites stay green. They pin "commit… ahead"
    wording and the Step 3 `--resume`, never `>= 1`.

## Non-goals

- G3 (base-drift / `merge-tree` check at pipeline end) and G4 (scripted Step 7 decomposition). Both are new features
  for their own PRDs.
- Demoting the AC-shape gate to advisory (D-2), and teaching citadel or refinement a second requirement-id
  namespace (D-3).
- Workspace-wide dependency discovery for the external `.d.ts` resolver.
- Changing who may write `status: Done`. Workers keep that authority; the guard now measures it.
- Any new halt, verdict channel, disposition or gate leg. Gate leg count is unchanged (0 new legs).

## Simplification Review

1. **Necessary?**
   - T1: yes. A Done contradicted by the worker's own recorded measurement is a false-converge, not something the
     next iteration fixes; only the manager's luck caught it.
   - T2a, T3 F4: these remove false findings, so they subtract output.
   - T2b, T3 F3b: they add one disclosure each where the system currently implies a measurement it never took.
   - T4, F5: cosmetic, near-zero cost. Each could be dropped without harm. Recorded as such.
   - T5: removes a condition (`AHEAD >= 1`) and adds one pin that avoids an existing halt path.
2. **Reuse:**
   - T1: Z1's refusal, park and disposition, plus the existing latest-conformance reader.
   - T2b: the `AnalyzerSkippedResult` shape.
   - T3 F3a: the collapse-by-id rule.
   - T3 F4: the R-RCEX resolver (moved, not cloned).
   - T5: `SCOPE_BASE` and the existing empty-diff WARN path.
3. **Brittle guard addressed:**
   - `orphan-test-file` false-positives outside its convention: narrowed by derivation, not by an allow-list.
   - The AC-shape gate's triple-counting: collapsed.
   - The underlying brittleness of an exit-2 stop over analyst hints is named in D-2 rather than wrapped.
4. **Subtraction:**
   - `AHEAD >= 1` removed.
   - Duplicate violations collapsed.
   - One whole false-positive class (orphan tests in non-ENFORCE repos) and the PHANTOM-for-dependency class are
     gone.
   - A duplicate dependency resolver is avoided by moving the existing one.
