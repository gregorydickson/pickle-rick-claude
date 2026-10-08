---
title: "B-FIELD-88 — field issues #83–#88 (+ #56, #57, #61, #80 follow-ups) and flow-built anatomy-park lanes"
status: draft
priority: P1
type: bug-bundle
branch: main
composes: ["#83", "#84", "#85", "#86", "#87", "#88", "#56", "#57", "#61", "#80"]
---

# B-FIELD-88 — field issues #83–#88 + flow-built anatomy-park lanes (`main`)

Issue texts reach this PRD by number and generic shape only; no client content (root `CLAUDE.md`, public repo).

## Trigger

One client field run: 24 tickets, 73 commits, all 4 phases reported success. The first strict external review at the
pipeline's head found 10 Medium+ findings (2 High); citadel, anatomy-park and szechuan-sauce caught none of them. The
operator filed the classes as #83–#88 and added comments to #56, #61 and #80 (2026-10-08). Triage: `prds/MASTER_PLAN.md`
QUEUE item 11. Operator decisions 2026-10-08: delete the unwired course-correction primitive (T6); build flow lanes in
THIS bundle (T8) — anatomy-park's own contract is "trace data flows" (`anatomy-park.md:1`, `:356`), yet its lanes are
directories, so every cross-directory flow is outside every lane.

## Invariants

- **No gate leg added.** Legs 22 → 22. Every new test lives in an EXISTING test file (pipeline.json `paths:` drops
  absent files). Every subprocess in a new test case gets `timeout: 30_000`.
- **No new halt, abort or launch-block condition.** A refused Done-flip (T5) rides the existing refusal path and a
  one-time re-queue; a flow-lane build failure (T8) falls back to directory lanes and is DISCLOSED, never fatal.
- **Szechuan-sauce keeps directory scope.** Its job is local code quality (naming, size, duplication), which is
  file-scoped. Only anatomy-park's lane builder changes.
- `--scope-base` pinned to the sha before this bundle (on `main`, `--scope branch` resolves empty).

## Premises (measured at `25824746`, read-only)

| Claim | Tag | Evidence |
|---|---|---|
| No refinement rule maps a PRD state/outcome row to a test at the outermost surface | (verified) | `grep -c "outermost surface" .claude/commands/pickle-refine-prd.md` → 0; nearest rules `:197` (rule-owner symmetry test), `:201` (per-criterion test expectations) |
| No worker/manager rule on answering a red guard by growing its exception list; no detector | (verified) | `grep -ci allowlist` → 0 in `.claude/agents/morty-phase-verifier.md` and `extension/src/bin/spawn-morty.ts`; nearest `morty-phase-verifier.md:26` |
| The #80 research rule is singular and lives in `spawn-morty.ts`, not `send-to-morty.md` | (verified) | `spawn-morty.ts:526` "cite its writer" (count 1); `:534` "through the input's writer"; `grep -c "every writer"` → 0 |
| No mutation step exists anywhere in the worker lifecycle | (verified) | `grep -ci mutant` → 0 in `spawn-morty.ts` and `morty-phase-verifier.md`; `/project-mayhem` is prompt-only, repo-wide (`project-mayhem.md:61-76`) |
| Tier-aware `hasLifecycleArtifacts` runs only on the zero-diff arm | (verified) | `ticket-completion-evidence.ts:1061` called only from `zeroDiffAccept` (`:1135`); committed path accepts at `:1192-1198` |
| spawn-morty's artifact check is any-ONE-of, tier-blind | (verified) | `types/index.ts:689,720-722` |
| `classifyTicketCompletion` is dead | (verified) | `mux-runner.ts:3200`, 0 callers |
| **Wave-built tickets keep their artifacts in unit sessions, not the parent ticket dir** | (verified) | census of 105 local Done tickets: 24 fail the tier-aware check read in the parent dir; 22 are wave session `2026-10-02-be104839`, whose artifacts are in `<session>--unit-<ticket>/<ticket>/` (96 files over 23 unit sessions) |
| Nothing re-opens a Done ticket; `applyCourseCorrectionRestructure` has 0 production callers; `/pickle-correct-course` has no command file but is named in 2 runtime hints + 1 agent file | (verified) | callers: only its own file, `services/CLAUDE.md`, and 3 test files (`transaction-ticket-ops.test.js`, `integration/lock-steal-live-holder.test.js`, `integration/course-correct-hot-swap.test.js`); hints `circuit-breaker.ts:57`, `transaction-ticket-ops.ts:562-563`; `.claude/agents/morty-course-corrector.md:3` |
| `consecutive_clean` is incremented by the worker prompt on zero findings; the runner accepts a bare `{result:'clean'}` | (verified) | `anatomy-park.md:532`; `microverse-runner.ts:6226-6237` |
| **Lanes are directories; one data flow spans 4 lanes** | (verified) | fixture with `producer/ store/ reader/ surface/` (one value written → stored → read → served): `discoverLanes` puts the 4 flow files in **4** lanes (scratch measurement at `25824746`) |
| Lanes run in parallel, each fenced to `dir − excludes` (+ generated mirrors), integrated by cherry-pick | (verified) | `anatomy-lanes.ts` `laneAllowedPaths`; `services/CLAUDE.md:122`; `pipeline-runner.ts:2018,2558-2586` |
| `archiveFile` overwrites an existing archive (crash-resume can replace `prd-pickle.md` with the anatomy PRD) | (hypothesis) | `pipeline-runner.ts:2966-2970` (`copyFileSync`, no existence check); anatomy setup re-runs on resume (bin `CLAUDE.md`, AP-EXT-ITER5-01) — T9 reproduces it |
| Szechuan's objective names the whole target, no diff range | (verified) | `pipeline-runner.ts:4144` |
| The final review disclosure has no sha and is log-only | (verified) | `pipeline-runner.ts:5668` `review convergence: not measured`; absent from `buildPipelineCompletePanel` (`:6165-6185`) |
| `refreshScope` absorbs any out-of-scope path an anatomy commit touched | (hypothesis — by reading) | `scope-resolver.ts:312-398` recomputes from `base_sha..HEAD`; T11 reproduces it first |

## Simplification Review

| Ticket | 1. Necessary? | 2. Reuse instead of add | 3. Guarding brittle complexity? | 4. Subtraction |
|---|---|---|---|---|
| T1 #84 | Yes — escapes were a state row dropped between tickets | Widens `pickle-refine-prd.md:197`/`:201` | No | none (prompt text) |
| T2 #86 | Yes — a red guard was "fixed" by exempting the change | Widens `morty-phase-verifier.md:26` | The detector would be one — **rejected** | none |
| T3 #80 | Yes — a second writer stored NULL | Widens the shipped `be7f572a` rule | No | none |
| T4 #87 | Yes — a deleted fail-closed `throw` kept all tests green | Widens `send-to-morty-review.md:45`; reuses `project-mayhem.md` operators | A runtime mutation runner would be one — **rejected** | none |
| T5 #88 | Yes — Done without research/plan | REUSES tier-aware `hasLifecycleArtifacts`, the existing refusal path, and the `state.recovery_attempts` ledger | Yes: two divergent artifact predicates | **Collapse** any-of `hasLifecycleArtifact` into the tier-aware one; **delete** dead `classifyTicketCompletion` |
| T6 #83 | Yes — a stale consumer survived a mid-run rule change | Re-verification lives in the correction ticket's OWN ACs (no new state transition) | The unwired course-correction primitive | **Delete** `applyCourseCorrectionRestructure` + input type + its test cases; fix 3 dangling hints |
| T7 #85 clean pass | Yes — a no-op repeat pass counted toward convergence | Widens `anatomy-park.md:532` | — | none |
| T8 #85 lanes | Yes — anatomy-park cannot do its stated job across directories | Reuses `LaneRecord`, `laneAllowedPaths`, lane integration; directory lanes stay as the no-diff path and the fallback | — | One lane builder per input case (diff → flows; no diff → directories); no new phase |
| T9 #61 | Yes — data loss on resume | Widens `archiveFile` | No | none |
| T10 #56 | Yes — honesty is a reporting property | Extends the existing MREL-B6 line | A measured-review gate would be one — **rejected** (as before) | none |
| T11 #57 | Only if reproduced | Narrows `computeRefreshedAllowed` | Yes — refresh absorbs violations | **Subtraction**: refreshed set ⊆ previous set ∪ catalogs |

## Open Decisions

| decision | options | default | owner | status |
|---|---|---|---|---|
| none | | | | |

## Tickets

### T1 — #84: every state/outcome row is tested at the outermost surface it reaches — `small`

Widen `.claude/commands/pickle-refine-prd.md` Step 7a (`:197`/`:201`): each row of a PRD state/outcome table (an input
state → result row) gets a test asserted at the OUTERMOST surface that row reaches (API response, rendered view,
persisted record), owned by the ticket that owns that surface or by the final integration ticket (`:300`). A row with
only producer-level tests is an uncovered criterion.
- AC1: `grep -c "outermost surface" .claude/commands/pickle-refine-prd.md` ≥ 1 (measured 0 at `25824746`).
- AC2: the rule sits in Step 7a beside the rule-owner rule, not in a new step.

### T2 — #86: growing a guard's exception list is a finding, not a fix — `small`

Widen `morty-phase-verifier.md:26` and the Implement and Code Review instructions in `spawn-morty.ts` (`:539`, `:545`):
adding members to a constant that a guard reads to skip its check (allowlist, uncovered/known-exceptions list,
baseline) is NOT a response to a red guard; if an exception is genuinely needed, the worker records it with its reason
as an open finding in its review artifact.
- AC1: `grep -ci "allowlist" .claude/agents/morty-phase-verifier.md` ≥ 1 (measured 0).
- AC2: `grep -ci "allowlist" extension/src/bin/spawn-morty.ts` ≥ 1 (measured 0), in the prompt text a worker receives
  (assert via the existing prompt-builder test file for spawn-morty prompts).

### T3 — #80 follow-up: every writer, one fixture per writer — `small`

`spawn-morty.ts:526`: "cite its writer" → cite EVERY writer of each persisted input and the values each can store
(including NULL). `:534`: build one fixture row per writer's shape.
- AC1: `grep -c "every writer" extension/src/bin/spawn-morty.ts` ≥ 1 (measured 0); `grep -c "cite its writer"` = 0
  (measured 1).
- AC2: any existing test pinning the old sentence is updated in the same commit (grep `tests/` for `its writer`).

### T4 — #87: the verifier mutates the diff's new guards; a worker's count is not evidence — `medium`

Spec Conformance prompt (`spawn-morty.ts:541`) and `morty-phase-verifier.md`: for each new `throw`, guard condition
and fail-closed branch in the ticket's diff, the VERIFIER deletes or inverts it, runs the ticket's own test FILES (never
a whole tier), records killed/survived per mutant in the conformance artifact, and restores the line with a
path-scoped restore. A surviving mutant is a conformance finding. Reuse the operator list from `project-mayhem.md:70-76`.
A worker-reported mutation count is a claim, not evidence (widens `send-to-morty-review.md:45`).
- AC1: `grep -ci "mutant" extension/src/bin/spawn-morty.ts` ≥ 1 and `grep -ci "mutant" .claude/agents/morty-phase-verifier.md` ≥ 1 (both measured 0).
- AC2: the instruction names "test files" scope and forbids tier runs for mutants (cost bound; tier runs are minutes).
- AC3: the instruction uses path-scoped restore only (`git restore <path>`), never `git checkout` (Git Boundary Rules).

### T5 — #88: a ticket missing its tier's lifecycle artifacts is re-run once, never silently accepted — `large`

1. **Collapse:** spawn-morty's any-of `hasLifecycleArtifact` (`types/index.ts:689,720`) is replaced by the tier-aware
   predicate. **Delete** dead `classifyTicketCompletion` (`mux-runner.ts:3200`).
2. **Widen:** `evaluateCompletionEvidence` applies the tier-aware check on the committed path for `decision ===
   'done-flip'` only (beside `workerGateRefusal`, `ticket-completion-evidence.ts:1196`); the `attribution` decision is
   unchanged.
3. **Resolve where the worker wrote.** A wave-built ticket's artifacts live in `<session>--unit-<ticket>/<ticket>/`;
   the predicate checks the ticket dir AND its unit-session dir.
4. **Bounded:** the FIRST refusal for a ticket returns the existing refusal kind so the ticket is respawned from its
   first missing step; the count is kept in the existing persistent `state.recovery_attempts` ledger (no new state
   field). The SECOND time, the flip is accepted and the ticket is disclosed (`lifecycle_skipped` in the run summary's
   existing Skipped/Failed disclosure, MREL-A8). A committed, gate-green ticket is never flipped Failed for missing
   artifacts alone.
- AC1 (fails today): `evaluateCompletionEvidence` on a committed, gate-green, tier-`medium` ticket with no research/plan
  artifacts returns accepted at HEAD; after the fix the first call refuses. Host in the existing
  `ticket-completion-evidence` test file.
- AC2 (negative control): the same ticket whose artifacts exist only in a `<session>--unit-<id>/<id>/` fixture is
  ACCEPTED on the first call.
- AC3: the second refusal-eligible call accepts and the disclosure line names the ticket.
- AC4: replay the census script over the local session corpus: 0 wave-built Done tickets would be refused (measured
  22 refusals under a parent-dir-only check).
- AC5: `grep -rn "classifyTicketCompletion" extension/src extension/tests` → 0 (measured 6 lines in `src` — the
  definition `mux-runner.ts:3200`, a comment `:16953`, the Module Export Catalog row `bin/CLAUDE.md:257` and 3
  unrelated catalog substrings to re-check — plus 13 test cases in `tests/mux-runner.test.js:1342,3230-3295,4151-4295`,
  which are deleted with it). `mux-runner.test.js` is therefore in T5's Files list.

### T6 — #83: a correction ticket owns re-verification of its consumers; delete the unwired primitive — `medium`

1. Manager/refinement guidance (where tickets are added after refinement — locate at breakdown; grep `mux-runner.ts`
   manager prompt and `pickle-refine-prd.md`): a correction ticket names the value/rule it changes, derives its
   consumers from the CODE (callers/readers of the changed symbol, not ticket text), and carries "each Done consumer's
   tests pass against the new rule" in its own ACs. No Done→Todo transition (the single un-terminalize path stays
   single).
2. **Delete** `applyCourseCorrectionRestructure`, `ApplyCourseCorrectionRestructureInput` and their exclusive helpers in
   `transaction-ticket-ops.ts`; remove their cases from the 3 test files; update `services/CLAUDE.md`. Re-point or
   delete the dangling `/pickle-correct-course` hints (`circuit-breaker.ts:57`, `transaction-ticket-ops.ts:562-563`) and
   the description in `.claude/agents/morty-course-corrector.md:3` to the real entry point (`bin/correct-course.ts`) or
   remove them. Check `README.md` per the Documentation Rule.
- AC1: `grep -rn "applyCourseCorrectionRestructure" extension/src extension/tests` → 0 (measured 5 files).
- AC2: `grep -rn "pickle-correct-course" extension/src .claude` → 0 hits naming a command that does not exist
  (measured 4).
- AC3: the correction-ticket rule text exists in the manager-facing prompt (grep its key phrase ≥ 1; measured 0).

### T7 — #85: a clean anatomy pass records what it traced — `small`

`anatomy-park.md:532`: a pass increments `consecutive_clean` only if its pass entry records the flows it traced
(write → store → read → surface, from the review diff) and the HEAD sha it reviewed. A repeat pass at the same sha that
traced nothing new is not clean. Prompt-only: `isCleanPassEntry` is NOT given a required field (a field one producer
omits would reject 100% of entries and burn to the 500-iteration cap).
- AC1: `grep -c "flows traced" .claude/commands/anatomy-park.md` ≥ 1 (measured 0).

### T8 — #85: anatomy-park lanes are built from the diff's data flows — `large`

**Design.** When the phase has a review diff (`scope.base_sha..HEAD`, pipeline mode), lanes are the CONNECTED
COMPONENTS of a graph over the diff's changed source files. Edges: (a) one file imports another (static specifiers,
resolved relative; codegraph may refine but is optional — fail open to the specifier scan); (b) two files' ADDED lines
share a persisted key/identifier literal (string-literal keys, column/field names), which is how a stored-data hop
(write → store → read) is seen without a call edge. Components are disjoint by construction, so per-lane write fences
stay disjoint and parallel integration is unchanged.
- **Read set vs write fence.** A flow lane's write fence is its component files (+ generated mirrors, as today). Its
  READ set adds each component file's one-hop importers, so the reviewer sees the surface that consumes the flow.
- **Identity.** `LaneRecord.name = "flow:" + <lexicographically first file in the component>`; the record gains an
  explicit `files` list. `archive/lanes.json` and resume read the persisted roster, as today.
- **No-diff case and fallback.** No review diff (standalone `/anatomy-park`) → directory lanes, unchanged. A flow-lane
  build that throws, or yields 0 lanes for a non-empty diff → directory lanes, with one disclosed log + run-summary line
  (`anatomy lanes: flow build fell back to directories: <reason>`). Never a halt.
- **Prompt.** `anatomy-park.md:356` reads "Read every file the lane admits" — for a flow lane that is its `files` plus
  the read set.
- AC1 (fails today): the producer/store/reader/surface fixture (4 directories, one value written → stored → read →
  served) yields ONE lane containing all 4 flow files (measured **4 lanes** at `25824746`). Host in
  `extension/tests/pipeline-runner.test.js` beside the existing lane tests.
- AC2 (disjointness control): two unrelated flows in the same directory yield TWO lanes with disjoint `files`.
- AC3 (fallback control): a lane builder forced to throw yields the directory roster and the disclosure line.
- AC4 (no-diff control): with no review diff, `discoverLanes` output is byte-identical to HEAD's for the same tree.
- AC5 (measured at breakdown, recorded in the research artifact): run the flow builder over the B-FIELD-82 diff
  (`0bdd6158..7bdcdecb`) and this bundle's own diff; report component count and max component size. If one component
  holds > 80% of changed files, the plan must address hub files before implementation (that is a design input, not a
  runtime threshold).

### T9 — #61: the feature PRD survives resume; szechuan names its diff range — `small`

`archiveFile` (`pipeline-runner.ts:2966`) keeps an existing archive (no overwrite). `buildSzechuanPrd` (`:4144`) names
`<scope.base_sha>..HEAD` as the reviewed range.
- AC1 (reproduce first): run anatomy setup twice on one session dir; at HEAD `prd-pickle.md` ends holding the anatomy
  PRD; after the fix it holds the original. Host in `pipeline-runner.test.js`.
- AC2: the szechuan objective string contains `..HEAD` (measured absent at `:4144`).

### T10 — #56: the final report names the sha it did or did not measure — `small`

Extend `pipeline-runner.ts:5668` to `review convergence: not measured at <short-sha>` and add a `Review:` row with the
same text to `buildPipelineCompletePanel` (`:6165`). Update the existing pin at `pipeline-runner.test.js:6761`.
- AC1: panel output contains `Review:` (measured absent).

### T11 — #57: scope refresh does not absorb out-of-scope writes — `small`, conditional

Reproduce first: an anatomy commit touching a path outside `allowed_paths` (not a `CLAUDE.md` catalog) appears in the
refreshed szechuan `allowed_paths` at HEAD. If it reproduces, `computeRefreshedAllowed` returns ⊆ previous
`allowed_paths` ∪ catalog paths. If it does not reproduce, close with `zero_diff_intent: already-satisfied` and the
evidence.
- AC1: the reproduction test, in the existing `scope-resolver` test file.

## Rejected or recorded

| Item | Why |
|---|---|
| #86 "detect by kind" diff classifier | No repo-independent formulation; an enumerated-set member. Revisit only if T2's rule fails in the next field run |
| #87 mechanical mutation runner in `extension/src` | Precision that costs a spawn plus tier time per mutant. T4 bounds cost to the ticket's own test files |
| #83 Done→Todo re-open path (`reopenedTicketIds`) | A second un-terminalize path against the single-path audit; T6 puts re-verification in the correction ticket's ACs |
| `isCleanPassEntry` required field (#85) | Fails closed on the live corpus; T7 is prompt-side |
| #56 measured-review gate | A new gate per finding (unchanged decision) |
| Lane size cap (#85) | A threshold that does not fix cross-directory flows; T8's components replace it |

## Launch

`/pickle-pipeline` on `main`, refinement ON, `--scope-base <sha of the commit before this PRD's first ticket commit>`.
Pickle iteration cap raised for 11 tickets (2 `large`).
