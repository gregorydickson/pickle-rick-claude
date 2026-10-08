---
title: "B-FIELD-88 — field issues #83–#88 (+ #56, #57, #61, #80 follow-ups) and flow-built anatomy-park lanes — REFINED"
status: refined
priority: P1
type: bug-bundle
branch: main
composes: ["#83", "#84", "#85", "#86", "#87", "#88", "#56", "#57", "#61", "#80"]
---

# B-FIELD-88 — REFINED

Source: `prds/p1-b-field-88.md` @ `main@ee967302`. Refined from 3 analysts × 3 cycles (9/9 succeeded). Changes from
the source are attributed `*(refined: <analyst> c<N>)*`. Operator decisions taken after refinement (2026-10-08) are
quoted in `## Open Decisions`. Issue texts reach this PRD by number and generic shape only; no client content.

## Trigger

One client field run: 24 tickets, 73 commits, all 4 phases reported success; the first strict external review at the
pipeline's head found 10 Medium+ findings (2 High), none caught by citadel, anatomy-park or szechuan-sauce. Classes
filed as #83–#88 plus comments on #56, #61, #80. Triage: `prds/MASTER_PLAN.md` QUEUE item 11.

## Invariants

- **No gate leg added.** Legs 22 → 22. Every new test case lives in an EXISTING test file. Every subprocess in a new
  test case gets `timeout: 30_000`.
- **No new halt, abort or launch-block condition.** T5's refusal rides the Z1 park (`isAcceptanceAssertionRefusal`):
  the ticket returns to In Progress and the loop continues; **no `recordExitReason`, no `done_without_commit_evidence`
  stamp**. *(refined: requirements c3, codebase c2/c3 — the source line "rides the existing refusal path" selected the
  stamping path)* A flow-lane build failure (T8) falls back to directory lanes and is disclosed, never fatal.
- **Szechuan-sauce keeps directory scope.** Only anatomy-park's lane builder changes.
- **Attribution.** This bundle's own anatomy-park runs the DEPLOYED directory-lane builder; no runtime number from this
  run may be credited to T7 or T8. Next-run observables: T7 → share of lanes reaching `consecutive_clean = 2` whose
  entries carry `flows_traced`; T8 → lane count, max lane size and `outcome: 'conflict'` count in `archive/lanes.json`.
  *(refined: risk-scope c3)*
- Launch: `--scope branch --scope-base ee967302`, pickle iteration cap 500.

## Risks (top first) *(refined: risk-scope c3)*

1. **T7 non-termination.** A rule that makes a same-sha second clean pass non-clean stops every lane converging and
   burns to `anatomy_max_iterations` (500), because a clean pass commits nothing (`anatomy-park.md:492`) and
   convergence needs 2 consecutive clean passes (`ANATOMY_CONVERGED_CLEAN_PASSES = 2`, `microverse-state.ts:28`).
   Mitigated: T7 records the sha for audit only; an AC proves two clean passes at an unchanged HEAD still converge.
2. **T8 catalog-conflict lane loss.** Flow lanes span directories, so two lanes append to the same `CLAUDE.md`; a partial
   pick undoes the WHOLE lane (`anatomy-lanes.ts:404-413`). Baseline under directory lanes: 38/38 lanes integrated, 0
   conflicts (10 local sessions). Mitigated by T8c (git `merge=union` for `CLAUDE.md` in the integration worktree).
3. **T5 counter reset across waves.** Each unit session is seeded from the parent state (`createTicketUnitSession`,
   `pipeline-runner.ts:2056-2077`) and `writeBackWave` (`:2701-2720`) copies back only `completion_commit` + status, so
   a unit-side counter is lost. Mitigated: the counter is a ticket FRONTMATTER field that `writeBackWave` carries.
4. **T11 empty-scope false success.** Narrowing the refresh at anatomy entry empties anatomy-park; `empty_scope` is
   outside `DEGRADED_PHASE_SKIP_REASONS`, so the run would report success over an unreviewed tree. Mitigated: T11 narrows
   only the refresh at szechuan entry, with a control AC.
5. **T8 resume roster churn.** `anatomy-park.json` is preserved only when the roster matches (AP-EXT-ITER5-01); a flow
   roster rebuilt after HEAD moved renames lanes and zeroes the ledger. Mitigated: build once at phase start, persist,
   read back.
6. **T4 per-ticket cost.** Capped at 5 mutants, ticket test FILES only.
7. **T6 catalog drift.** Deleting the lock closure must rewrite `services/CLAUDE.md:109-110` in the same commit.

## Premises

| Claim | Tag | Evidence |
|---|---|---|
| No refinement rule maps a state/outcome row to a test at the outermost surface | (verified) | `grep -c "outermost surface" .claude/commands/pickle-refine-prd.md` → 0 |
| No worker rule on answering a red guard by growing an exception list; no detector | (verified) | `grep -ci allowlist` → 0 in `morty-phase-verifier.md` and `spawn-morty.ts` |
| The #80 rule is singular, in `spawn-morty.ts:526`/`:534`; no test pins the sentence | (verified) | `grep -c "cite its writer"` → 1; `grep -rn "its writer" extension/tests` → 0 *(refined: requirements c3)* |
| No mutation step exists in the worker lifecycle | (verified) | `grep -ci mutant` → 0 in `spawn-morty.ts`, `morty-phase-verifier.md` |
| Wave tickets are judged by the UNIT session's own guard, over `<unitDir>/<id>/`; the parent writes Done with no evidence check | (verified) | `runTicketUnit` spawns `mux-runner.js <unitDir>` (`pipeline-runner.ts:2634-2683`); `grep -c "guardCompletionCommitBeforeDone\|evaluateCompletionEvidence" pipeline-runner.ts` → 0; unit log `2026-10-02-be104839--unit-62ccbcf4/mux-runner.log` lines 7-8 *(refined: codebase c3, risk-scope c3)* |
| The source PRD's "24 of 105 fail, 22 wave" census read the PARENT dir, which no guard reads | (verified) | same evidence; the census measured its own reader, not the runtime *(refined: codebase c3)* |
| Unit artifacts are never copied back to the parent ticket dir | (verified) | `writeBackWave` writes `completion_commit` + status only (`:2711-2712`) |
| Tier-aware `hasLifecycleArtifacts` returns one `false` for missing, tierless AND unreadable | (verified) | `ticket-completion-evidence.ts:1061-1080` *(refined: codebase c3)* |
| `matchesArtifactPrefix` lets `research_review.md` satisfy `research` | (verified) | `types/index.ts:702` *(refined: requirements c2/c3)* |
| `buildTierResumeTable` would route a committed-but-unresearched ticket back into Implement | (hypothesis, by reading) | `spawn-morty.ts:457-482` ("no implementation diff" row) *(refined: codebase c3)* |
| `isAcceptanceAssertionRefusal(` occurs 7 times in `mux-runner.ts` (Z1 PATTERN_SHAPE pin) | (verified) | grep count *(refined: requirements c3)* |
| `reportSkippedFailedTickets` filters to skipped/failed; `MREL-A8` is not a code anchor | (verified) | `pipeline-runner.ts:2526-2529` *(refined: codebase c2)* |
| `classifyTicketCompletion` has no production caller; 13 test cases + catalog mentions | (verified) | `mux-runner.ts:3200`; `tests/mux-runner.test.js`; `bin/CLAUDE.md:54,257,318`, `services/CLAUDE.md:118` |
| `applyCourseCorrectionRestructure` has 0 production callers; the restructure lock primitives' only callers are the functions being deleted | (verified) | `transaction-ticket-ops.ts:435-455,641,831,840`; `services/CLAUDE.md:109-110` *(refined: codebase c2/c3)* |
| `/pickle-correct-course` has no command file; named at 4 sites | (verified) | `circuit-breaker.ts:57`, `transaction-ticket-ops.ts:562-563`, `.claude/agents/morty-course-corrector.md:3` |
| Clean pass = zero findings, counted by the worker prompt; runner accepts bare `{result:'clean'}` | (verified) | `anatomy-park.md:532`; `microverse-runner.ts:6226-6237` |
| A clean pass commits nothing, so consecutive clean passes share a sha | (verified) | `anatomy-park.md:492`; `microverse-state.ts:28` *(refined: risk-scope c3)* |
| One producer→store→reader→surface flow spans 4 directory lanes | (verified) | scratch fixture at `25824746` |
| `discoverLanes(target)` takes no diff; 5 callers pass `target` only | (verified) | `pipeline-runner.ts:655,673,2018,3370,3842`; `bin/resolve-scope.ts:45` *(refined: codebase c3)* |
| `laneAdmits` returns false for `dir === ''` | (verified) | `scope-resolver.ts:484-489` *(refined: codebase c2)* |
| Trap doors land in the same commit as the fix; partial pick resets the whole lane | (verified) | `anatomy-park.md:445,491`; `anatomy-lanes.ts:404-413` *(refined: risk-scope c3)* |
| `archiveFile` overwrites (crash-resume can replace `prd-pickle.md`) | (hypothesis) | `pipeline-runner.ts:2966-2970`; T9 reproduces first |
| `grep -c "\.\.HEAD" pipeline-runner.ts` already returns 9, so a grep AC is fake-green | (verified) | *(refined: requirements c3)* |
| The MREL-B6 pin is end-anchored at `pipeline-runner.test.js:6767` | (verified) | `/\] review convergence: not measured$/` |
| `refreshScope` absorbs any path an anatomy commit touched | (hypothesis, by reading) | `scope-resolver.ts:312-398`; T11 reproduces first |

## Open Decisions

| decision | options | default | owner | status |
|---|---|---|---|---|
| T5 #88: re-run vs disclosure-only | re-run once then disclose; disclose only | re-run once then disclose | operator | decided: "Re-run once, then disclose" (operator, 2026-10-08) |
| T7+T8 in one bundle | both with split observables; T8 now, T7 later | both | operator | decided: "Both, observables split" (operator, 2026-10-08) |
| Mechanics: T5 counter as ticket frontmatter carried by `writeBackWave`; T5 park = Z1 widening; T5 review artifact does not satisfy its subject phase; T5 tierless/unmeasured → accept; T6 delete recover surface + restructure lock; T8 separate `buildFlowLanes`, persisted once, literal edge = exactly 2 changed files; T8 `CLAUDE.md merge=union` in the integration worktree; T11 szechuan-entry refresh only; T4 ≤ 5 mutants, `/tmp` restore | accept all; review each | accept all | operator | decided: "Accept all" (operator, 2026-10-08) |
| T6 deletion (source item) | delete; wire | delete | operator | decided: "delete it" (operator, 2026-10-08) |

## Simplification Review

| Ticket | Necessary? | Reuse | Brittle complexity guarded? | Subtraction |
|---|---|---|---|---|
| T1 #84 | Yes | widens `pickle-refine-prd.md:197`/`:201` | no | none |
| T2 #86 | Yes | widens `morty-phase-verifier.md:26` | detector rejected | none |
| T3 #80 | Yes | widens `be7f572a` rule | no | none |
| T4 #87 | Yes | widens `send-to-morty-review.md:45`; `project-mayhem.md` operators | runtime runner rejected | none |
| T5 #88 | Yes | REUSES Z1 park, `requiredTierArtifactPrefixes`, `writeBackWave`'s existing frontmatter write, `buildTierResumeTable` | two artifact predicates | **delete** `classifyTicketCompletion`; spawn-morty's any-of floor is KEPT unchanged (collapsing it would Failed-flip committed tickets via `persistWorkerOutcomeStatus`) *(refined: all analysts c2/c3)* |
| T6 #83 | Yes | re-verification lives in the correction ticket's own ACs | unwired course-correction primitive | **delete** apply + recover + restructure lock + their tests |
| T7 #85 | Yes | widens `anatomy-park.md:532` | — | none |
| T8 #85 | Yes | reuses `LaneRecord`, `laneAdmits`, lane integration, git's union merge driver | — | one builder per input case (diff → flows; none → directories) |
| T9 #61 | Yes | widens `archiveFile` | no | none |
| T10 #56 | Yes | extends the MREL-B6 line | review gate rejected | none |
| T11 #57 | If reproduced | narrows `computeRefreshedAllowed` at one refresh | refresh absorbs violations | subtraction |

## Requirements

### T1 — #84 outermost-surface test per state/outcome row (prompt)
Widen `.claude/commands/pickle-refine-prd.md` Step 7a: each row of a PRD state/outcome table gets a test asserted at the
OUTERMOST surface it reaches (API response, rendered view, persisted record), owned by that surface's ticket or the
final integration ticket; a row with only producer-level tests is an uncovered criterion.
AC: `grep -c "outermost surface" .claude/commands/pickle-refine-prd.md` ≥ 1 (measured 0).

### T2 — #86 exception-list growth is a finding (prompt)
`morty-phase-verifier.md:26` + spawn-morty Implement/Code Review text (`spawn-morty.ts:539`, `:545`): adding members
to a constant a guard reads to skip its check (allowlist, uncovered/known-exceptions list, baseline) is not a response
to a red guard; a genuinely needed exception is recorded with its reason as an open finding in the review artifact.
ACs: `grep -ci allowlist .claude/agents/morty-phase-verifier.md` ≥ 1 (measured 0); `grep -ci allowlist
extension/src/bin/spawn-morty.ts` ≥ 1 (measured 0), asserted in `tests/spawn-morty-tier-phases.test.js`.

### T3 — #80 every writer (prompt)
`spawn-morty.ts:526`: cite EVERY writer of each persisted input and the values each can store (including NULL);
`:534`: one fixture row per writer's shape. ACs: `grep -c "every writer"` ≥ 1 (measured 0); `grep -c "cite its writer"`
= 0 (measured 1). No test pins the old sentence (measured).

### T4 — #87 verifier-chosen mutants (prompt)
Spec Conformance (`spawn-morty.ts:541`) + `morty-phase-verifier.md`: for each new `throw` / guard / fail-closed branch
in the ticket diff (at most 5; skip when none), the VERIFIER deletes or inverts it, runs the ticket's own test FILES
(never a tier), and records `mutants: K of M` with killed/survived per mutant in the conformance artifact. It mutates
only a path whose `git status --porcelain -- <path>` is clean, copies the file to `/tmp` first, restores from that
copy, and confirms `git diff --quiet -- <path>` before writing the artifact. A surviving mutant is a conformance
finding; a worker-reported count is a claim, not evidence. *(refined: requirements c3, risk-scope c2/c3 — the source's
`git restore <path>` wording destroys uncommitted work)*
ACs: `grep -ci mutant` ≥ 1 in both files (measured 0); `grep -c "git diff --quiet" extension/src/bin/spawn-morty.ts`
≥ 1 (measured 0); `grep -c "mutants: " .claude/agents/morty-phase-verifier.md` ≥ 1 (measured 0).

### T5 — #88 a ticket missing its tier's lifecycle artifacts is re-run once, then disclosed
Rule owner: **T5a**. Consumers: T5b, T5c.
- **T5a (owner, `mux-runner.ts` + `ticket-completion-evidence.ts`).** A three-state tier answer
  `lifecycleArtifactStatus(ticketPath): { kind: 'complete' } | { kind: 'missing'; prefixes: string[] } | { kind: 'unmeasured'; reason: 'no_ticket' | 'tierless' | 'unreadable' }`
  over `requiredTierArtifactPrefixes(tier)`, where a `*_review` artifact does NOT satisfy its subject phase. In
  `guardCompletionCommitBeforeDone`'s committed accept arm (beside the Z1 acceptance-assertion park): `missing` with
  frontmatter `lifecycle_rerun` absent → set `lifecycle_rerun: requested`, park exactly like Z1 (Done → In Progress,
  `disposition` that `isAcceptanceAssertionRefusal` — widened, or a sibling predicate counted into the Z1 pin — treats
  as a local park; NO `recordExitReason`); `missing` with `lifecycle_rerun: requested` → accept and set
  `lifecycle_rerun: accepted_incomplete`; `complete` → accept; `unmeasured` → accept, no stamp. The existing zero-diff
  arm keeps `hasLifecycleArtifacts`. `classifyTicketCompletion` (`mux-runner.ts:3200`) and its 13 test cases are
  deleted; catalog mentions (`bin/CLAUDE.md:54,257,318`, `services/CLAUDE.md:118`) are reworded so no backticked dead
  symbol remains.
- **T5b (`spawn-morty.ts`).** When the ticket has `completion_commit` AND `lifecycle_rerun: requested`, the worker
  prompt states the commit sha and that the run produces ONLY the missing pre-implementation artifacts (research,
  plan and their reviews) describing that commit; `buildTierResumeTable` omits the Implement row in that case.
- **T5c (`pipeline-runner.ts`).** `writeBackWave` (a) copies `<unitDir>/<id>/*.md` into `<parent>/<id>/` before the
  status flip, and (b) carries `lifecycle_rerun` in the same `updateTicketFrontmatter` call as `completion_commit`. The
  run end prints ONE line on every run: `lifecycle-incomplete Done tickets: N — <ids>` (N = Done tickets with
  `lifecycle_rerun: accepted_incomplete`; `N=0` prints `lifecycle-incomplete Done tickets: 0`).
- **Bound.** Because the field is on the ticket and is carried back, a ticket is re-run at most once per run in both
  serial and wave modes; it is never Failed-flipped for missing artifacts.
ACs (T5a): AC1 a committed, gate-green, tier-`medium` ticket holding only `conformance_*.md` + `code_review_*.md` →
guard returns a park refusal, ticket reads In Progress, `state.exit_reason` unchanged, frontmatter `lifecycle_rerun:
requested` (at HEAD the guard returns `ok: true`); AC1b only `research_review.md` + `plan_review.md` + `conformance` +
`code_review` → refused; AC2 the full medium set → accepted, no field written; AC3 second evaluation with `requested` →
accepted, field `accepted_incomplete`; AC3c tierless or unreadable → accepted, no field; AC5 `grep -rn
classifyTicketCompletion extension/src extension/tests --include='*.ts' --include='*.js'` → 0 and
`bash scripts/audit-trap-door-enforcement.sh` exits 0; AC6 spawn-morty's `persistWorkerOutcomeStatus` outcome for a
committed medium ticket with only `research_*.md` is unchanged. ACs (T5b): resume table for such a ticket contains no
Implement row and the prompt contains the sha. ACs (T5c): after a wave integrates a member, the parent ticket dir holds
the unit's `plan_*` artifact and the parent frontmatter carries the unit's `lifecycle_rerun`; the run log contains
`lifecycle-incomplete Done tickets: 1 — <id>` with one such ticket and `lifecycle-incomplete Done tickets: 0` with none.

### T6 — #83 correction ticket owns consumer re-verification; delete the unwired course-correction surface
- **T6a.** Delete `applyCourseCorrectionRestructure`, `ApplyCourseCorrectionRestructureInput`,
  `recoverCourseCorrectionFromLedger`, `acquireFileLock`, `reclaimDeadRestructureLock` and their exclusive helpers in
  `transaction-ticket-ops.ts`, with their cases in `tests/transaction-ticket-ops.test.js`,
  `tests/integration/lock-steal-live-holder.test.js`, `tests/integration/course-correct-hot-swap.test.js`; rewrite
  `services/CLAUDE.md:109-110`. Reword the `tickets_version` invariant in `extension/CLAUDE.md` ("increments when course
  correction changes ticket state" becomes false).
  ACs: `grep -rnE 'applyCourseCorrectionRestructure|recoverCourseCorrectionFromLedger|acquireFileLock|reclaimDeadRestructureLock' extension/src extension/tests --include='*.ts' --include='*.js'`
  → 0; `bash scripts/audit-trap-door-enforcement.sh` exits 0.
- **T6b.** Re-point the 4 dangling `/pickle-correct-course` mentions to `node ~/.claude/pickle-rick/extension/bin/correct-course.js "<discovery>"`
  or remove them (`circuit-breaker.ts:57`, `transaction-ticket-ops.ts:562-563` die with T6a if their function goes;
  `.claude/agents/morty-course-corrector.md:3`); update pins in `tests/circuit-breaker.test.js`,
  `tests/morty-course-corrector-agent.test.js`. Add the correction-ticket rule to `pickle-refine-prd.md` Step 7a: a
  correction ticket names the value/rule it changes, derives consumers from the CODE (callers/readers), and carries
  "each Done consumer's tests pass against the new rule" in its own ACs; no Done→Todo transition.
  ACs: `grep -rn "pickle-correct-course" extension/src .claude` → 0 (measured 4); `grep -c "each Done consumer"
  .claude/commands/pickle-refine-prd.md` ≥ 1 (measured 0).

### T7 — #85 a clean pass records the flows it traced (prompt)
`anatomy-park.md:532`: a pass increments `consecutive_clean` only if its `findings_history` entry carries a non-empty
`flows_traced` list (write → store → read → surface, from the review diff) and the HEAD sha reviewed. **The sha is
recorded for audit only; it is NOT a cleanliness condition** — a clean pass commits nothing, so consecutive clean passes
share a sha. `isCleanPassEntry` is NOT changed. *(refined: risk-scope c3)*
ACs: `grep -c "flows_traced" .claude/commands/anatomy-park.md` ≥ 1 (measured 0); the prompt text contains "NOT a
cleanliness condition" (measured 0).

### T8 — #85 flow-built anatomy-park lanes
- **T8a (`scope-resolver.ts`, `pipeline-runner.ts`).** `LaneRecord` gains optional `files?: string[]`; `laneAdmits`
  admits exactly `files` (+ generated mirrors) when `files` is present, and keeps today's behaviour otherwise.
  New `buildFlowLanes(target: string, baseSha: string, changedFiles: string[]): LaneRecord[]` — connected components
  over the changed source files; edges: (a) a static relative import between two changed files (resolve `.js`
  specifiers to `.ts` sources); (b) a string literal appearing in the ADDED lines of exactly 2 changed files. Lane
  `name = "flow:" + <lexicographically first file>`, `dir = ''`, `files` sorted, `fileCount = files.length`.
  `discoverLanes` is unchanged.
- **T8b (`pipeline-runner.ts`, `anatomy-park.md`).** Inside `runAnatomyLanes`, after the
  `unreproducibleNodeModulesCount === 0` gate: when the phase has a review diff (`scope.base_sha..HEAD`), build the
  roster once with `buildFlowLanes`, persist it to `archive/lanes.json`, and have every later reader (resume, per-lane
  fence recompute at `:2018`) read the persisted roster; with no diff, or when `buildFlowLanes` throws or returns 0
  lanes for a non-empty diff, use `discoverLanes(target).lanes` and print `anatomy lanes: flow build fell back to
  directories: <reason>`. The serial (non-lane) path is unchanged. `anatomy-park.md:356` reads: for a flow lane, read
  its `files` and their one-hop importers; write only `files`.
- **T8c (`anatomy-lanes.ts`).** Before picking, the integration worktree writes `CLAUDE.md merge=union` to
  `$GIT_DIR/info/attributes` (worktree-local; the operator's repo config untouched).
ACs (T8a): AC1 the producer/store/reader/surface fixture (imports use `.js` specifiers; one value written → stored →
read → served) yields ONE lane holding all 4 flow files (measured 4 lanes at HEAD under `discoverLanes`); AC2 two
unrelated flows → two lanes with disjoint `files`; AC2b six files sharing `'utf-8'` plus two real flows → ≥ 2 lanes;
AC3 `laneAdmits` on a flow lane admits its files + generated mirrors and rejects a one-hop importer. ACs (T8b): AC4 a
phase with no review diff persists a roster equal to `discoverLanes(target).lanes`; AC5 a forced `buildFlowLanes` throw
yields the directory roster and the disclosure line; AC6 an `archive/lanes.json` written by HEAD (no `files`)
round-trips unchanged; AC7 a resumed phase reads the persisted roster and `anatomy-park.json` is not zeroed. ACs (T8c):
AC8 two lanes each committing a source fix plus an EOF append to the same `CLAUDE.md` both end `integrated` with both
source commits on the branch (hypothesis at HEAD: the second lane conflicts — T8c measures it red before the fix).

### T9 — #61 feature PRD survives resume; szechuan names its range
`archiveFile(..., { keepExisting: true })` at the two `prd.md` archive sites only (`pipeline-runner.ts:4056`, `:4214`);
`TASK_NOTES-<phase>.md` still overwrites. `buildSzechuanPrd` names `<scope.base_sha>..HEAD` (or `HEAD (no scope
base)` when none). ACs: AC1 anatomy setup run twice on one session dir leaves `prd-pickle.md` holding the original
(reproduce at HEAD first; if it does not reproduce, the ticket closes `zero_diff_intent: already-satisfied` for that
arm); AC1c `TASK_NOTES-<phase>.md` still overwrites; AC2 `buildSzechuanPrd` output contains `<base>..HEAD` for a set
base and the no-base label otherwise (an output assertion — `grep -c "\.\.HEAD"` already returns 9).

### T10 — #56 the final report names the sha
`pipeline-runner.ts:5668` → `review convergence: not measured at <sha7|unknown>` (sha from
`git rev-parse --short=7 HEAD` in `runtime.workingDir`, `unknown` on failure); `buildPipelineCompletePanel` adds a
`Review:` row with the same text. Update the end-anchored pin at `pipeline-runner.test.js:6767`. ACs: panel matches
`/Review: .*not measured at ([0-9a-f]{7}|unknown)/`; in a non-git dir the panel shows `unknown` and does not throw.

### T11 — #57 the szechuan-entry refresh does not absorb out-of-scope writes (conditional)
Reproduce first (`tests/scope-refresh.test.js`): an anatomy commit touching a path outside `allowed_paths` (not a
`CLAUDE.md` catalog) appears in the szechuan-entry refreshed `allowed_paths` at HEAD. If it reproduces:
`computeRefreshedAllowed` returns ⊆ previous `allowed_paths` ∪ catalog paths **for the refresh at szechuan entry
only**; `mode: 'paths'` unaffected. Control ACs: a build-phase path IS in the anatomy-entry `allowed_paths`; the
anatomy-entry refresh never raises `SCOPE_EMPTY_POST_BUILD` for a build diff that touches source. If it does not
reproduce: close `zero_diff_intent: already-satisfied` with the evidence.

## Rejected or recorded

| Item | Why |
|---|---|
| #86 diff classifier | no repo-independent formulation; enumerated-set member |
| #87 runtime mutation runner | precision that costs a spawn + tier time per mutant |
| #83 Done→Todo re-open path | second un-terminalize path vs the single-path audit |
| `isCleanPassEntry` required field | fails closed on the live corpus |
| T7 same-sha non-clean rule | makes convergence impossible (Risk 1) |
| #56 measured-review gate | a gate per finding |
| Lane size cap | does not fix cross-directory flows |
| Collapsing spawn-morty's any-of artifact floor | Failed-flips committed tickets via `persistWorkerOutcomeStatus` |
| Parent ∪ unit union read (source T5 step 3) | dead path — no guard reads two dirs |
| Deferred catalog flush for lanes | breaks the atomic fix-plus-catalog commit (`anatomy-park.md:445`) |


## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | de716374 | Refinement maps every state/outcome row to a test at its outermost surface (#84) | Medium (small) | prior orders Done | Exit State in ticket | .claude/commands/pickle-refine-prd.md, extension/tests/pickle-refine-prd-failure-mode-checklist.test.js |
| 20 | 15d7aa7d | Workers treat growing a guard exception list as a finding, not a fix (#86) | Medium (medium) | prior orders Done | Exit State in ticket | .claude/agents/morty-phase-verifier.md, extension/src/bin/spawn-morty.ts, extension/tests/spawn-morty-tier-phases.test.js |
| 30 | fca7c125 | Research cites every writer of a persisted input; one fixture per writer (#80 follow-up) | Medium (medium) | prior orders Done | Exit State in ticket | extension/src/bin/spawn-morty.ts, extension/tests/spawn-morty-tier-phases.test.js |
| 40 | dda350da | Verifier mutates each new guard in the diff; a worker-reported count is not evidence (#87) | High (medium) | prior orders Done | Exit State in ticket | extension/src/bin/spawn-morty.ts, .claude/agents/morty-phase-verifier.md, extension/tests/spawn-morty-tier-phases.test.js |
| 50 | dbb9b87d | Done-flip guard re-runs a committed ticket missing its tier artifacts once, then accepts and stamps it (#88, rule owner) | High (large) | prior orders Done | Exit State in ticket | extension/src/services/ticket-completion-evidence.ts, extension/src/bin/mux-runner.ts, extension/tests/mux-runner.test.js, extension/tests/zero-diff-completi... |
| 60 | 036d7466 | A lifecycle re-run of a committed ticket writes only the missing pre-implementation artifacts (#88) | High (medium) | prior orders Done | Exit State in ticket | extension/src/bin/spawn-morty.ts, extension/tests/spawn-morty-tier-phases.test.js |
| 70 | 5db57226 | Wave write-back copies lifecycle artifacts and lifecycle_rerun to the parent; run end discloses accepted-incomplete tickets (#88) | High (medium) | prior orders Done | Exit State in ticket | extension/src/bin/pipeline-runner.ts, extension/tests/pipeline-runner-units.test.js, extension/tests/pipeline-runner.test.js |
| 80 | 93efae82 | Delete the unwired course-correction apply/recover surface and its restructure lock (#83) | Medium (large) | prior orders Done | Exit State in ticket | extension/src/services/transaction-ticket-ops.ts, extension/tests/transaction-ticket-ops.test.js, extension/tests/integration/lock-steal-live-holder.test.js,... |
| 90 | 3860e361 | Correction tickets own re-verification of their consumers; no dangling /pickle-correct-course hints (#83) | Medium (medium) | prior orders Done | Exit State in ticket | .claude/commands/pickle-refine-prd.md, extension/src/services/circuit-breaker.ts, .claude/agents/morty-course-corrector.md, extension/tests/circuit-breaker.t... |
| 100 | 4534af5a | A clean anatomy pass records the flows it traced; the sha is audit-only (#85) | Medium (small) | prior orders Done | Exit State in ticket | .claude/commands/anatomy-park.md, extension/tests/anatomy-park-convergence-guard.test.js |
| 110 | d1cb934a | buildFlowLanes groups the review diff into data-flow lanes; laneAdmits honours a files list (#85) | High (large) | prior orders Done | Exit State in ticket | extension/src/services/scope-resolver.ts, extension/src/bin/pipeline-runner.ts, extension/tests/pipeline-runner.test.js, extension/tests/anatomy-park-scope.t... |
| 120 | 36974b0e | runAnatomyLanes builds the flow roster once, persists it, and falls back to directories with disclosure (#85) | High (large) | prior orders Done | Exit State in ticket | extension/src/bin/pipeline-runner.ts, .claude/commands/anatomy-park.md, extension/tests/pipeline-runner.test.js, extension/tests/pipeline-runner-anatomy-park... |
| 130 | 533ae192 | Lane integration merges CLAUDE.md catalog appends with git union merge (#85) | High (medium) | prior orders Done | Exit State in ticket | extension/src/services/anatomy-lanes.ts, extension/tests/pipeline-runner.test.js |
| 140 | 39311a81 | Feature PRD archive survives resume; szechuan objective names its diff range (#61) | Medium (medium) | prior orders Done | Exit State in ticket | extension/src/bin/pipeline-runner.ts, extension/tests/pipeline-runner-phase-fail-continue.test.js, extension/tests/pipeline-runner.test.js |
| 150 | 2a377ec9 | Final report says review convergence was not measured at <sha> and shows it on the panel (#56) | Medium (medium) | prior orders Done | Exit State in ticket | extension/src/bin/pipeline-runner.ts, extension/tests/pipeline-runner.test.js, extension/tests/pipeline-finalize-honesty.test.js |
| 160 | e9ade22b | Szechuan-entry scope refresh does not absorb out-of-scope anatomy writes (#57, conditional) | Medium (medium) | prior orders Done | Exit State in ticket | extension/src/services/scope-resolver.ts, extension/tests/scope-refresh.test.js |
| 170 | 6602f52e | Wire: integrate B-FIELD-88 changes into the working pipeline | High (medium) | prior orders Done | Exit State in ticket | extension/src/bin/pipeline-runner.ts, extension/src/bin/mux-runner.ts, extension/tests/pipeline-runner-units.test.js, extension/tests/pipeline-runner.test.js |
| 180 | 365986c0 | Harden: code quality review of B-FIELD-88 | High (large) | prior orders Done | Exit State in ticket | extension/src/bin/spawn-morty.ts, extension/src/services/ticket-completion-evidence.ts, extension/src/bin/mux-runner.ts, extension/src/bin/CLAUDE.md, extensi... |
| 190 | d11072c8 | Audit: data flow integrity for B-FIELD-88 | High (large) | prior orders Done | Exit State in ticket | extension/src/bin/spawn-morty.ts, extension/src/services/ticket-completion-evidence.ts, extension/src/bin/mux-runner.ts, extension/src/bin/CLAUDE.md, extensi... |
| 200 | ad91727d | Harden: test quality review of B-FIELD-88 | High (large) | prior orders Done | Exit State in ticket | extension/tests/pickle-refine-prd-failure-mode-checklist.test.js, extension/tests/spawn-morty-tier-phases.test.js, extension/tests/mux-runner.test.js, extens... |
| 210 | 55c8de7e | Audit: cross-reference consistency for B-FIELD-88 | High (medium) | prior orders Done | Exit State in ticket | .claude/commands/pickle-refine-prd.md, .claude/agents/morty-phase-verifier.md, extension/src/bin/CLAUDE.md, extension/src/services/CLAUDE.md, extension/CLAUD... |
