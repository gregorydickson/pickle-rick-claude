# B-MEGA — every open issue, built by the multi-agent branch on itself (#43, #52, #53, #54 follow-ups, #55, #5 Moves 1–3; `exp/b-parallel-build`)

DRAFT for refinement. Read at `exp/b-parallel-build@99fe61eb` (detached worktree). Probes ran against that tree's
committed JS, with `node_modules` borrowed by symlink. Main's in-flight B-RUNREPORT-54 commits (local `main@028729e1`)
were read where an item builds on them. Measured 2026-10-02. Field numbers come from issue text; the field session dirs
are not on this machine.

## Run config (operator-approved; restated so refinement cannot drift it)

- **Branch:** `exp/b-parallel-build`. Do NOT launch before the B-RUNREPORT-54 merge-down chain completes
  (main → `exp/b-lanes` → `exp/b-parallel-build`, each gated). E3, E4, E6, C3 and D4 edit the exact lines T2 and T3
  changed. Launched before that, they conflict or re-implement them.
- **Deploy:** `install.sh` from `exp/b-parallel-build` at the launch sha. Verify by content: the deployed
  `pipeline-runner.js` must contain `runPickleWaves`, `max_parallel_tickets` and `unreproducibleNodeModulesCount`.
  Rollback: `install.sh` from `exp/b-lanes`. This ends the deployed `exp/b-lanes` beta soak for the duration.
- **`pipeline.json`:**
  - `max_parallel_tickets: 2` and `anatomy_max_parallel_lanes: 2`;
  - `scope: branch` with **`scope_base` pinned to the launch sha**. The branch is 76 files ahead of main, and an
    unpinned branch scope would review all of them. The ledger's unscoped run took 135 min of anatomy;
  - pickle iteration cap raised for about 26 tickets.
- **Refinement ON** (3 analysts × 3 cycles). B, C, D, E1, E2 and A2 are new features.
- **Gate-leg delta: 0.** No item adds a leg, a halt, an `exit_reason` or a verdict input.

## Workstreams → issues closed

| WS | Closes | Note |
|---|---|---|
| A | #43 (build half), #52 (residual), #53 (Expected 8) | #43 cannot close on this bundle: its merge criterion needs ≥ 3 field wave runs, and this run is at most one |
| B | #55 proposals 5, 6 | |
| C | #55 proposals 1, 2, 3, 8 | |
| D | #55 proposals 4, 7 | together with B and C, closes #55 |
| E | #54 follow-ups (G3, G4, D-2, D-3, F6 rider, nested `.d.ts`) | #54 itself closes on B-RUNREPORT-54 |
| F | #5 Moves 1–3 | 2 of 3 already satisfied; Move 1's premise is falsified (operator decision O-3) |

## Item status (every premise re-measured at `99fe61eb`)

| Item | Status | Mechanism (file:line, worktree) | Falsifying observation taken → result | Kind |
|---|---|---|---|---|
| A1 units lack the L2 predicate | **live** | The L2 check `unreproducibleNodeModulesCount` sits inside the `lanes.length >= 2` arm of `runConfiguredPhase` (`bin/pipeline-runner.ts:4914-4921`). The `pickle` + `max_parallel_tickets >= 2` arm (`:4922`) never consults it. `createTicketUnitSession` (`:2037`) links with the same depth-1 linker. | Predicate on a fixture with root `node_modules` plus `packages/a/node_modules` → `1`. That is, a unit in a workspace builds without its dependencies. On this repo the same predicate → `0`. | FIX |
| A2 workspace `node_modules` in lane/unit worktrees | **live** | `laneLinkableNodeModules` (`services/anatomy-lanes.ts:94`) covers the root and direct children only. `symlinkLaneNodeModules` (`:132`) **aliases** whole dirs. | Aliasing is wrong as well as incomplete. In a fixture, a nested `node_modules/@s/b → ../../../b` reached through an aliased dir resolves to the **main checkout's** `packages/b`, not the worktree's. A **replicated** link with the same relative target resolves to the worktree's `packages/b`. Measured with `fs.realpathSync`. | NEW FEATURE |
| A3 wave telemetry for the B-PBUILD merge criterion | **live (reader only)** | The runtime already emits everything needed: `pickle waves: wave N members=… in_flight=K` (`:2565`), one timestamped outcome line per member (`:2597`), the activity event `anatomy_lanes_integrated` with `phase:'pickle'` and per-member `started_at`/`ended_at` (`:2600`), and the serial path's `[done-guard] ticket X is Done` in `mux-runner.log`. `field-timing.py` reads none of these. | `field-timing.py --json \| grep -c 'impl\|wave'` → `0`. The tool is also lane-blind: it reports `anatomy_passes` 0 for every lane run (session `face240c`: tool 0/0/0/0/0, lane dirs 4/2/3/2/2). 0 of 62 local sessions contain a `pickle waves:` line, so **the wave path has never run outside fixtures.** | FIX (research tool) |
| A4 wave integration `unavailable` undisclosed | **live** | `runTicketWave` calls `integrateLanes` (`:2575`) but never reads `integration.checks`. The lane path discloses (`discloseUnmeasuredIntegration`, `:2283`); the wave path logs only `integration_check: unavailable — accepting the lane` (`services/anatomy-lanes.ts:371`). | `sed -n 2560,2610p … \| grep -c checks` → `0` | FIX |
| #52 residual "disclose unavailable" (lanes) | **satisfied** | L6 + `discloseUnmeasuredIntegration` (`:2304`) | — | — |
| #52 residual "lane stuck at gap analysis" | **HYPOTHESIS, unmeasurable here** | Evidence dir not on this machine | Recorded only. Per the loop rule, nothing is added without a reproduction. | — |
| B1 dependency-lens review | **live** | `filterBySubsystem` (`services/scope-resolver.ts:503`) keeps only lanes with an allowed path. `writeSkippedByScope` (`:3165`) has no production reader. No review-only lane mode exists, and nothing reads a premise list. | Probe: two 22-file lanes, a `src/beta/` dependency named in `prd.md`, allowed path in `src/alpha` → roster `src/alpha` only, and 0 mentions of `src/beta` in the generated anatomy PRD | NEW FEATURE |
| B2 sibling-writer protocol | **live** | No rubric or prompt text about it | `grep -ciE 'other writers\|existing writers'` over the rubric and `anatomy-park.md` → `0`, `0` | NEW FEATURE (prompt) |
| C1 premise ledger | **live** | Only the codebase analyst is told to tag hypotheses (`bin/spawn-refinement-team.ts:822`, `.claude/workflows/refine-analyze.js:49`). Neither synthesis prompt mentions the tags (`pickle-refine-prd.md:152-179`, `refine-analyze.js:208-235`). `evaluateSymbolAudit` reads the input `prd.md` (`:2977`), never `prd_refined.md`. | `grep -c '## Premises'` over both synthesis surfaces → `0`, `0` | NEW FEATURE |
| C2 escalations stay open | **live** | Neither synthesis prompt says where a human-gated item goes. "settled", "open decision" and "escalat" each appear 0 times. Citadel already has an unused-for-this `decision_required` bucket (`services/citadel/reporter.ts:43`). | `grep -c '## Open Decisions'` → `0`, `0` | FIX (prompt) |
| C3 phantom guarantee | **live, two holes in an existing check** | Readiness `findPrdMapFindings` (`bin/check-readiness.ts:810`): (a) an id mapped in frontmatter but listed only under `## NOT in Scope` counts as covered (`:628`, `:801`); (b) only `AC-DR-*` parent ids are enumerated (`:707`). | (a) fixture → `exit 0 prd_map []`; control without the frontmatter map → `exit 2 ["AC-DR-1"]`. (b) `AC-1` mapped nowhere → `exit 0 prd_map []`. | FIX (widen) |
| C8 test-expectation independence | **live** | Conformance step 4 (`bin/spawn-morty.ts:562`) only says "each expected test exists and passes". "mutation" appears in no worker or refinement prompt. The Test Expectations table has no source column (`pickle-refine-prd.md:270`). | `sed -n '/^export function buildTierLifecycleSections/,/^}/p' extension/src/bin/spawn-morty.ts \| grep -c "Expected-value source"` → `0` | FIX (prompt) |
| D4a lexical AC coverage | **live (confirmed)** | `ac-coverage-scorecard.ts:242-247` (`symbolContainsAnchor` `:356`), test side `:273-278`, plus the hand-maintained `COMMON_WORDS` (`:70-104`). | Probe: an AC about stale results vs. a label formatter and an unrelated test → `implemented:true tested:true`, evidence `keyword_anchor:result`. A date-parsing test also scores via the word `input`. | FIX (subtraction) |
| D4b card mode | **live; no card input exists** | Citadel scores `prd_refined.md` (heal order `pipeline-runner.ts:4273-4283`). The pre-refinement `prd.md` is in the session but never read by citadel (`grep -c "'prd.md'" audit-runner.ts` → `0`). No tracker card is stored anywhere. | as left | NEW FEATURE |
| D7a "conforms to PRD" excuses | **live** | `szechuan-sauce-principles.md:92` ("obviously the stated intent of the change (… the PRD said …)"), applied as a discard at `anatomy-park.md:332` and `szechuan-sauce.md:352` | `grep -n 'stated intent of the change' … \| grep -c report-only` → `0` | FIX (rubric) |
| D7b `dropped_findings.md` consumer | **live (no reader)** | Writer: the prompt only (`anatomy-park.md:392`). 0 readers in `extension/src` outside catalogs. Local corpus: 97 lines in 38 files at 3 different depths, 100% parseable `conf=N`, 0% carry a category, 89 at conf ≥ 25. `extension/dropped_findings.md` is a misplaced committed artifact, cited by `src/bin/CLAUDE.md:135`. | `grep -rl dropped_findings extension/src \| grep -v 'CLAUDE.md$' \| wc -l` → `0` | NEW FEATURE |
| E1 base-drift report | **live** | No `merge-tree` anywhere (0 files). The natural site is after `reportKeptLaneBranches` in `writeFinalPipelineActivity` (`pipeline-runner.ts:5348`). Base: `resolveSetupScopeBaseRef` (`:895`), not `scope_base`, because T5 pins that to the launch sha. git 2.39.5 has `merge-tree --write-tree`. | `typeof (await import('./bin/pipeline-runner.js')).reportBaseDrift` → `undefined` | NEW FEATURE |
| E2 scripted Step 7 | **live** | `refine-analyze.js:4` phases `['analyze','synthesize']`, opt-in only. Step 7 is **616 of 842** prompt lines (`pickle-refine-prd.md:181-796`). | `grep -c "phase('decompose')" .claude/workflows/refine-analyze.js` → `0` | NEW FEATURE |
| E3 AC-shape gate → advisory | **live** | `main()` `process.exit(acShapeStatus)` (`spawn-refinement-team.ts:3029`); doc says "stop and fix" (`pickle-refine-prd.md:144`) | Probe replaying the unjustified-fanout fixture → `status 2, advisory false`. Re-measured cost: **3 assertions in 2 files**, not ~28. The ~25 unit pins on the return value stay green if only the `main()` call site changes. | FIX (subtraction) |
| E4 one requirement-id rule | **live** | Citadel `AC_ID_PATTERN` (`services/citadel/prd-parser.ts:118`) vs refinement `REQUIREMENT_ID_RE` + `definedRequirementIdsInLine` (`spawn-refinement-team.ts:2063,2079`); readiness has a third, `AC-DR-*` (`check-readiness.ts:707`) | FR-only PRD → `citadel 0 refine 0`. Census guarding the naive widening: a generic "defined `<UPPER>-<n>`" rule over 184 PRDs yields 499 non-`AC` ids, so it would flip `all_success` on most PRDs. | FIX (collapse) |
| E5 `microverse.md` monitor WARN | **live, cosmetic; PRD location was wrong** | Comes from standalone `/pickle-microverse` (`microverse-runner.ts:4814`, via `ensureMicroverseMonitor` `:6892`), not from `pipeline-runner.ts:1740`. The T4 underscore strip does not cover it. | Probe on main's T4 build → `microverse.md: pickle 1` (1 WARN) | FIX |
| E6 nested-workspace `.d.ts` | **live** | `declaredDependencyNames` / `collectExternalDtsFiles` (`check-readiness.ts:337,371`) hard-code `[root, extension]` | Workspace fixture with the dependency declared only in `packages/a` → `dts 0`; root-declared control → `dts 1` | FIX (widen by derivation) |
| F1 context cache (Move 1) | **premise falsified** | `bin/archaeology.ts:184` writes `project-context.md`, but **nothing invokes archaeology** (0 callers). `/pickle-archaeology` never existed in git history, though `PRD_GUIDE.md:168` documents it. | 0 of 62 local sessions have a `project-context.md` | NEW FEATURE (wire + cache), or delete (O-3) |
| F2 committed trap doors (Move 2) | **satisfied** | `anatomy-park.md:201,322,442` commit trap doors with the fix; the `audit-trap-door-enforcement.sh` leg | 309 of 1,002 main commits since 09-01 mention "trap door". Residual inverted: catalogs total **1.27 MB** (the issue cited 211 KB), and per-session load is a HYPOTHESIS. | — |
| F3 breaker taxonomy (Move 3) | **satisfied** | `services/circuit-breaker.ts` has 0 rate-limit references. `applyRateLimitCycleOutcome` (`mux-runner.ts:13975`) parks before breaker recording (B-RRH). `rate_limit_exhausted` is `crashFloor:false` (`types/index.ts:1668`). | Residual: blind-bail (no `resetsAt` after 3 retries) and the 360-min park cap still end the pickle phase, but not the pipeline. Add nothing. | — |
| #53 | **satisfied on the lane branches** (G1/G2/D2/L1–L6) | Expected 8 → A1/A2 here | — | — |

## Decisions (drafted; refinement may override the mechanics, not the goals)

- **D-A1 — hoist, don't copy.** The L2 predicate moves above both parallel arms of `runConfiguredPhase`. One `missing`
  value then gates anatomy lanes AND pickle waves, with one log line per phase naming which it disabled. It is not a
  second call.
- **D-A2 — replicate, don't alias (measured).**
  - **Rule.** Every `node_modules` dir that `findNodeModulesDirs` finds is recreated as a real dir in the worktree,
    root included. Each `@scope` dir inside it is recreated too: that is npm's own naming rule, not a list. Inside
    them, a symlink entry is copied with its link text unchanged, so relative workspace links resolve inside the
    worktree. Every other entry is symlinked absolute to the main checkout.
  - **Why the walk and the predicate share code.** The linker and the predicate share the walk. After A2 the predicate
    counts only dirs the replica could not create (for example, an untracked parent). It stays non-vacuous and can
    reach 0 on a pnpm workspace.
  - **Accepted limit:** gitignored build output (`dist/`) is not reproduced. Serial has the same staleness.
- **D-A3 — telemetry is a reader, not a runtime change.** Every number the B-PBUILD criterion needs is already logged.
  `field-timing.py` gains:
  - `wave_widths`;
  - `impl_subphase_min`: first to last `parallel_safe: true` ticket Done, from wave member lines or serial
    `[done-guard]` lines;
  - lane-summed `anatomy_passes`;
  - exclusion of `--unit-*`/`--lane-*` sibling dirs as rows. **HYPOTHESIS:** a unit dir would be listed as its own
    session, because it holds a ticket dir. There are 0 unit dirs on disk to confirm it.
- **D-A4 — disclose in the log, not the verdict.** A wave-integrated ticket with `integration_check: unavailable`
  gets ` (integration typecheck unavailable)` on its member line, plus one phase-end count. It does NOT withhold
  success: the serial path never runs a cross-ticket typecheck at all, so waves are no less measured than serial.
- **D-B1 — the lens reads C1's ledger; there is no new lane mode.**
  - Dependency paths are the `file:line` column of the refined PRD's `## Premises` table. That gives one source and no
    second PRD section.
  - `buildAnatomyPrd` renders them as a "Dependency Lens (review-only)" section.
  - Findings there take the existing `[report-only: …]` tag. The existing scope fence blocks edits.
  - Real review-only lanes are rejected: a lane that can never fix anything runs into the 50-pass no-clean ceiling.
  - The rubric's "pre-existing on untouched lines" false-positive bullet (`principles.md:88`) gains the matching
    exception in the same ticket.
- **D-B2/D-D7a — one rubric file reaches both review phases.** Both rubric edits go into
  `szechuan-sauce-principles.md` (read by anatomy-park and szechuan), not into `anatomy-park.md`'s hand-maintained
  Phase-1 checklist.
  - A "PRD says so"-only exoneration of a correctness or concurrency finding becomes `[report-only: spec-suspect]`.
    It reuses the report-only tag; no new status.
- **D-C1 — no blocking.**
  - An unverified premise that a decision depends on becomes either a ticket whose AC tests the existing code, or an
    `## Open Decisions` row (C2).
  - Decomposition is never refused, because that would be a new halt.
  - The optional machine check reuses `scanAnalystOutputsForUnverifiedPaths` (`:2857`) as advisory
    `ticket_quality_warnings`.
- **D-C3 — the new misses are advisory.** Routing them through the blocking `prd_map` finding would add readiness
  refusals. A prose-promise classifier ("never", "bound to") is rejected as a lexical instrument: such sentences are
  covered as Premises (C1).
- **D-D4 — subtract the lexical axis.**
  - Delete `extractKeywordAnchors`, `symbolContainsAnchor` and `COMMON_WORDS`.
  - `tested` then needs an AC id in a changed test line, or a reference to an implementation symbol. `implemented`
    needs an AC id or an `llm_entity` mapping.
  - Rows that lose lexical credit become citadel findings, which are advisory. Their count is to be measured at
    refinement over recorded `citadel_report.json` files.
  - **Card mode (D4b), reduced to what exists:** the pre-refinement `prd.md` stands in for the card. Citadel diffs its
    criteria against `prd_refined.md` and reports criteria that were dropped or weakened under `decision_required`.
    Ingesting a real tracker card is out of scope (no input exists).
- **D-E4 — the id-rule widening is a fallback only.**
  - `definedRequirementIdsInLine` moves to one shared service, used by citadel, refinement and readiness (C3b).
  - The generic `<UPPER>-<n>` form applies only when a PRD defines no `AC-*` id at all. That covers 33 of the 129 PRDs
    that define any id.
  - No prefix list.
- **D-E5 — fix at the caller.** `ensureMicroverseMonitor` passes its mode explicitly (the option exists,
  `monitor-window.ts:510`). The template-string inference gains no member.
- **D-E6 — reuse the workspace enumerator.** `getWorkspacePackages` (`services/convergence-gate.ts:585`) supplies
  the package dirs. Caps are unchanged.

## Requirements (one AC each; "today" = measured at `99fe61eb`, must red before the fix)

**A1 (small).** Hoist the predicate (D-A1). AC: mirror `tests/pipeline-runner.test.js:5870` for waves. Fixture: a
workspace (`packages/a/node_modules`) with `max_parallel_tickets: 2` and two `parallel_safe` tickets. Assert the serial
runner gets the parent session dir and no `<session>--unit-*` dir exists. Today: waves run (static: `:4922` precedes no
predicate). Control: a root-only fixture still runs waves.

**A2 (medium, refine).** Replicate nested and root `node_modules` (D-A2) in `services/anatomy-lanes.ts`. AC: on the
`fx-ws` fixture shape, `fs.realpathSync(<wt>/packages/a/node_modules/@s/b/index.ts)` lies under `<wt>`, and
`unreproducibleNodeModulesCount` → `0`. Today: the predicate → `1`, and the aliased path resolves under `<main>`. Both
were measured.

**A3 (small).** `prds/research/tools/field-timing.py` (D-A3). AC: `python3 field-timing.py --json | grep -c
impl_subphase_min` ≥ 1, and session `2026-10-01-face240c` reports passes summing to 13. Today: `0`, and passes sum to 0.

**A4 (small).** Wave member disclosure (D-A4). AC: a wave fixture whose target has no runnable typecheck logs
`integration typecheck unavailable` on the member line. Today: `0` occurrences (`runTicketWave` never reads
`checks`).

**B1 (medium, refine; after C1).** AC: on the agent probe (two 22-file lanes; a `## Premises` row citing `src/beta/x.ts`;
allowed path in `src/alpha`), `grep -c 'src/beta' <session>/prd-anatomy-park.md` ≥ 1. Today: `0`. Control: no
Premises table → `0`.

**B2 + D7a (small; one ticket, one file).** AC: `grep -ciE 'other writers|existing writers'
extension/szechuan-sauce-principles.md` ≥ 1 AND `grep -n 'stated intent of the change'
extension/szechuan-sauce-principles.md | grep -c report-only` ≥ 1. Today: `0` and `0`.

**C1 + C2 (small; one ticket; both synthesis surfaces).** AC: `grep -c '## Premises'` and `grep -c '## Open
Decisions'` each ≥ 1 in BOTH `.claude/commands/pickle-refine-prd.md` and `.claude/workflows/refine-analyze.js`. Today:
`0/0/0/0`. Rule text: analyst `(verified)`/`(hypothesis)` tags are copied verbatim. "Analysts converge" is not
verification. A needs-human item is never written under settled decisions without a quoted human decision.

**C3 (medium; after E4).** AC: the agent's `c3` fixture (an id mapped in frontmatter, listed only under NOT in Scope)
yields an `advisory` finding naming `AC-DR-1`, and a plain `AC-1` mapped nowhere yields one too. Today: `exit 0`, no
finding for either. Control: the existing `prd_map` exit-2 case is unchanged.

**C8 (small; two tickets: `spawn-morty.ts` | refinement template).** AC: the `buildTierLifecycleSections` span
`grep -c "Expected-value source"` → `1`, and the template's Test Expectations header gains a `Source` column. Today:
`0`. Rule: an expected value cites a source other than the code under test. A fixture builds the defended-against
condition unresolved. Mutations cover every input that can be unreadable, not only the conjuncts the PRD lists.

**D4a (medium).** Delete the lexical axis (D-D4). AC (from `extension/`):
`node --input-type=module -e "import {buildAcCoverageScorecard as b} from './services/citadel/ac-coverage-scorecard.js';const r=b([{id:'AC-1',line:1,text:'A stale result never reports satisfied when the input record changed after it was computed.'}],{repoRoot:'<d4 fixture>',changedFiles:[{path:'src/label.ts',status:'A',kind:'production'},{path:'src/other.test.ts',status:'A',kind:'test'}]}).rows[0];console.log(r.implemented,r.tested)"`
prints something other than `true true`. Today: `true true`. The pin `tests/citadel-ac-coverage-scorecard.test.js:37`
asserts the defect and is rewritten in the same ticket.

**D4b (medium, refine).** Source-PRD diff (D-D4). AC: a session whose `prd.md` has `AC-3` and whose `prd_refined.md`
drops it gives a `decision_required` entry naming `AC-3`. Today: `0`. To be measured at refinement.

**D7b (small).** End-of-run panel line `dropped findings (conf≥25): N in <files>`, searching the parent and lane sibling
dirs (reuse the per-lane loop at `:2307`). The prompt's line format gains `cat=<category>`. Move the misplaced
`extension/dropped_findings.md` and its `CLAUDE.md:135` cite. AC: `grep -rl dropped_findings extension/src | grep -v
'CLAUDE.md$' | wc -l` ≥ 1. Today: `0`.

**E1 (small).** `reportBaseDrift(runtime)` after `reportKeptLaneBranches`:
- `git fetch` the base with a timeout, then `merge-tree --write-tree --name-only <base> HEAD`;
- one line per conflicted path;
- any failure → `base drift: unmeasured (<reason>)`;
- the exit code is never touched.

AC: `typeof reportBaseDrift` → `function`, and a conflicting-base fixture logs `CONFLICT` with the pipeline exit
unchanged. Today: `undefined`.

**E2 (medium, refine).** A `decompose` phase in `refine-analyze.js`. The command doc's workflow section skips inline
Step 7. README per the Documentation Rule. AC: `grep -c "phase('decompose')" .claude/workflows/refine-analyze.js` ≥ 1.
Today: `0`.

**E3 (small).** The `main()` call site uses the existing `reportAdvisoryGateVerdict('ac-shape gate', …)` (`:2331`).
Step 5 text changes from "stop" to advisory. Re-pin `spawn-refinement-team.test.js:1019` and
`spawn-refinement-team-checker.test.js:1643,1651`. AC: the fanout replay probe → `status 0 … advisory true`. Today:
`status 2 … advisory false`.

**E4 (medium).** One shared id rule (D-E4). AC: on the FR-only fixture, `parsePrdFile(...).acceptanceCriteria.length`
≥ 1 and `computeRequirementCoverageGap(...).expectedRequirementIds.length` ≥ 1. Today: `0 0`. Control: an `AC-*` PRD's
expected set is byte-identical.

**E5 — CUT (operator O-6, 2026-10-02).** Recorded only; no ticket.

**E6 (small; after the merge-down).** D-E6. AC: the workspace fixture (dependency declared only in `packages/a`) →
`dts ≥ 1`. Today: `0`. The root-declared control is unchanged.

**F1 (medium) — DELETE archaeology (operator O-3, 2026-10-02).** Correction to the draft's "0 callers": the pipeline
never runs it (no setup/runner call site; 0 of 62 sessions hold `project-context.md`), but it is not isolated —
`services/calibration-corpus.ts:3` imports `normalizeProjectContext`/`buildArchaeologyPrompt` from it and defines an
`archaeology` calibration suite (`:9,:11,:61`); `bin/calibrate.ts:19` lists it; `bin/spawn-morty.ts:357` reads
`state.flags.no_archaeology`; `state.archaeology` is defaulted in `services/state-manager.ts:547,736` and typed at
`types/index.ts:113`; events `archaeology_complete`/`archaeology_skipped` are declared at `types/index.ts:776-777`.
- **Delete:** `extension/src/bin/archaeology.ts` (+ compiled mirror), `extension/tests/archaeology.test.js`, the
  `archaeology` calibration suite and its corpus rows, the `calibrate.js` usage member, the `no_archaeology` flag read,
  the stale `PRD_GUIDE.md` reference, and test fixtures that exist only to exercise these.
- **Keep read-tolerant (no schema bump, no migration):** an old `state.json` carrying `archaeology` and an old
  activity log carrying the two event names must still load. Removing the WRITER of `state.archaeology` and the
  event declarations is allowed only if every reader/validator still accepts the old values; otherwise keep the
  declaration and record why. `LATEST_SCHEMA_VERSION` is untouched (Worker Forbidden Ops).
- **AC:** `git grep -c "from '../bin/archaeology.js'\|archaeology.js" -- extension/src` returns 0 (today: 2), and
  `cd extension && node --test tests/state-manager.test.js tests/activity-logger.test.js` passes with a fixture state
  holding `archaeology: {…}`. **F2, F3:** close #5 on the evidence above at branch merge; no tickets.

## Interface Contracts (added at refinement readiness, 2026-10-02 — derived from the Decisions section)

- **A1** `runConfiguredPhase` (pipeline-runner.ts): one `const missing = unreproducibleNodeModulesCount(gitRepoRoot(runtime.target))`
  computed once per phase BEFORE both parallel arms; `missing > 0` → neither `runAnatomyLanes` nor `runPickleWaves`
  runs; log `<lanes|waves>: disabled for this phase — lane worktrees cannot reproduce N node_modules dir(s); running serially`.
  Signature unchanged: `unreproducibleNodeModulesCount(repoRoot: string): number`.
- **A2** `services/anatomy-lanes.ts`: `findNodeModulesDirs(repoRoot: string, maxDepth = 3): string[]` (repo-relative,
  never descends into a `node_modules`) is the ONE walk shared by linker and predicate.
  `replicateLaneNodeModules(repoRoot: string, worktree: string): { replicated: string[]; unreproducible: string[] }`
  replaces `symlinkLaneNodeModules` at both call sites (lane + unit); `LaneOutcome.node_modules_linked` keeps its
  `string[]` type (= `replicated`). Never throws; a per-dir failure lands in `unreproducible`.
  `unreproducibleNodeModulesCount` = `findNodeModulesDirs(...)` entries the replica cannot create (dry, no worktree).
- **A3** `field-timing.py --json` per-session object gains `wave_widths: number[]`, `impl_subphase_min: number | null`,
  `anatomy_passes: number` (lane-summed); `--unit-*`/`--lane-*` dirs are never rows.
- **A4** wave member log line: `pickle waves: <ticket> integrated (integration typecheck unavailable)` + phase-end
  `pickle waves: N member(s) integrated over an unavailable integration typecheck`. No verdict input.
- **B1** refined PRD table `## Premises` columns: `| claim | file:line | status (verified|hypothesis) | verifier |`.
  `buildAnatomyPrd` renders `## Dependency Lens (review-only)` listing the distinct `file` values outside the
  session's allowed paths; findings there are tagged `[report-only: dependency-lens]`.
- **C1/C2** synthesis output sections: `## Premises` (as B1) and `## Open Decisions`
  (`| item | raised by | options | owner | status: open |`). A needs-human item never appears under settled decisions
  without a quoted human decision.
- **C3** readiness advisory finding `{ kind: 'ac_unowned', id: string, reason: 'not-in-scope-only' | 'unmapped', advisory: true }`
  in the existing readiness findings array; exit code unchanged.
- **C8** worker prompt sentence `Expected-value source:`; template Test Expectations header
  `| Criterion | Test File | Description | Assertion | Source |`.
- **D4a** `buildAcCoverageScorecard(criteria, ctx)` return shape unchanged (`{ rows: { id, implemented, tested, … }[] }`);
  only the lexical evidence path is removed.
- **D4b** citadel report `sections.decision_required: { id: string; kind: 'dropped' | 'weakened'; source: 'prd.md'; refined: 'prd_refined.md' }[]`.
- **D7b** end-of-run panel line `dropped findings (conf>=25): N in <file>[, <file>…]`; anatomy prompt line format
  `- <finding> — conf=<n> — cat=<category> — <reason>`.
- **E1** `export async function reportBaseDrift(runtime: PipelineRuntime): Promise<void>` — logs
  `base drift: CONFLICT <path>` per path, or `base drift: clean (<base>)`, or `base drift: unmeasured (<reason>)`;
  bounded `git fetch` timeout; never throws; never changes the exit code.
- **E2** `refine-analyze.js` gains `phase('decompose')` returning `{ tickets: { id: string; path: string }[] }`; the
  command doc's workflow path skips inline Step 7.
- **E3** `reportAdvisoryGateVerdict('ac-shape gate', …)` at the `main()` call site; process exit 0 on a smell.
- **E4** `definedRequirementIdsInLine(line: string, opts: { generic: boolean }): string[]` in one shared service;
  `generic` is true only when the PRD defines no `AC-*` id.
- **E6** external `.d.ts` resolver reads declared dependencies from every `getWorkspacePackages` dir (caps unchanged).

## Ordering and dependencies

1. **Precondition:** B-RUNREPORT-54 merged down and gated on this branch. Then deploy and verify by content.
2. **E4 → C3** (shared id rule). **C1 → B1** (the lens reads the Premises table). **A1 → A2** (A2 changes what the
   hoisted predicate counts). **E6** only after T3's resolver export has arrived.
3. Everything else is independent. Closers (Wire, Harden, Audit) run last and serial by design.

## Composition by shared surface (compose by surface, CLAUDE.md)

| Surface | Tickets | parallel_safe? |
|---|---|---|
| `bin/pipeline-runner.ts` + `services/anatomy-lanes.ts` (lanes/waves/finish) | A1, A2, A4, B1 (code half), D7b, E1 | A2 is disjoint from E1 in files only if A2 stays in `anatomy-lanes.ts`; the rest share `pipeline-runner.ts` → serial among themselves |
| research tool | A3 | yes (sole file) |
| rubric + review prompts (`szechuan-sauce-principles.md`, `anatomy-park.md`) | B2+D7a, B1 (prompt half), D7b (format) | `anatomy-park.md` is `.claude/**`, so it overlaps everything → serial |
| refinement prompts (`pickle-refine-prd.md`, `refine-analyze.js`) | C1+C2, C8 (template), E2, E3 (doc half) | `.claude/**` → serial |
| `bin/spawn-morty.ts` | C8 (conformance text) | yes |
| refinement/readiness code (`spawn-refinement-team.ts`, `check-readiness.ts`, new shared id service) | E3, E4, C3, E6 | E4 and E6 are file-disjoint only if E4's service is new and E6 stays in `check-readiness.ts` |
| citadel (`ac-coverage-scorecard.ts`, `audit-runner.ts`, `prd-parser.ts`) | D4a, D4b | D4a is disjoint from E4 unless E4 edits `prd-parser.ts` (it does) → order E4 first |
| `bin/microverse-runner.ts` | E5 | yes |
| setup/archaeology | F1 (if O-3 = build) | yes |

**Estimate: 22 implementation tickets + 3–4 closers ≈ 25–26** (F1 adds 1–2). Only about 8 implementation tickets are
both file-disjoint and free of `.claude/**`: A3, C8a, E5, F1, and some of A2, D4a, E4, E6. Expect few 2-wide waves.
The measured ceiling at cap 2 is 1.27× even with perfect disjointness. **This run is a reliability measurement of the
wave path, not a speed result.**

## Risks of running this on the deployed experimental branch

- **R1 — first real wave run.** 0 `pickle waves:` lines exist in 62 local sessions. Every wave behaviour so far is
  fixture-proven only. The zero-progress fallback (`:2705`) bounds a failure to "serial for the rest of the phase";
  watch for it.
- **R2 — concurrent worker gates on this repo.** Each unit runs `test:fast` and `test:integration`
  (`spawn-morty.ts:1661`). Overlapping tiers here have measured ~3.9× fabricated-red inflation. Expect spurious unit
  gate reds → re-queue → serial. It costs time, not completion. Do NOT attribute those reds to ticket code without a
  lone re-run.
- **R3 — self-hosting does not exercise A1/A2.** The predicate measures `0` on this repo, so the bundle cannot
  dogfood its own monorepo fix. A monorepo field run stays an open item for #43, #52 and #53.
- **R4 — deploy displaces the `exp/b-lanes` soak.** Ledger rows during this run come from a different build. Rollback
  is `install.sh` from `exp/b-lanes`.
- **R5 — rule-P departure (operator-accepted).** The general fixes (C, D, E) reach `main` only when the operator merges
  the branch. Until then `main` and the branch diverge on the files B-RUNREPORT-54 just touched.
- **R6 — barrier + rate limits.** Two concurrent workers roughly double token burn. A rate-limit-parked unit holds its
  wave barrier (accepted R5 of B-PBUILD).
- **R7 — review toll.** About 26 tickets across 8 surfaces. The anatomy toll scales with surface count, and lanes at
  cap 2 help. `scope_base` MUST be pinned, or 76 pre-existing files join the review.
- **R8 — public repo.** B2, C1 and C8 add prompt prose drawn from a client incident. Workers must write it generically.
  Refinement must strip any concrete example back to the shapes used here.

## Non-goals

- #5 Moves 4–5. Ingesting real tracker cards (D4b uses `prd.md`). A prose-promise classifier. A review-only lane
  mode. Reproducing gitignored build output in worktrees.
- Changing `RETAINED_BRANCH_MAX_AGE_DAYS`, the wave rule, or `parallel_safe` stamping.
- Any new halt, `exit_reason`, verdict input, disposition, or gate leg. **Gate legs: 22 → 22.**

## Simplification Review

1. **Necessary?**
   - A1, A4: yes. They are silent unmeasured builds and integrations.
   - A3: yes. The merge criterion is unmeasurable without it.
   - B, C, D: yes. #55 shipped 4 blocking defects through a green run.
   - E1, E2: features the operator asked for.
   - E5: cosmetic; drop it if the bundle runs long.
   - F2, F3: no, already satisfied.
   - F1: questionable, because its premise is false (O-3).
2. **Reuse:**
   - L2 predicate (A1); `findNodeModulesDirs` (A2); existing log lines and events (A3); the lane disclosure pattern
     (A4).
   - The `[report-only]` tag (B1, D7a); one rubric file for both phases (B2).
   - `scanAnalystOutputsForUnverifiedPaths` (C1); the `decision_required` bucket (C2, D4b); `findPrdMapFindings`
     (C3).
   - `reportAdvisoryGateVerdict` (E3); `definedRequirementIdsInLine` (E4); `getWorkspacePackages` (E6); the explicit
     `mode` option (E5); `resolveSetupScopeBaseRef` (E1).
3. **Brittle guards addressed:**
   - The AC-shape exit-2 stop: demoted.
   - Lexical AC coverage: deleted.
   - Readiness's `AC-DR`-only enumeration: replaced by a derived rule.
   - Two hard-coded resolver roots: derived.
   - The rubric clause that excuses PRD-conforming defects.
4. **Subtraction:**
   - `COMMON_WORDS` plus two keyword functions.
   - 3 of 4 requirement-id regexes collapse to 1.
   - The AC-shape halt path.
   - The `[root, extension]` enumeration.
   - A misplaced committed artifact.
   - Two of #5's three moves closed on evidence with no code.
   - Optionally the never-invoked archaeology module (O-3).

## Operator decisions (answered 2026-10-02)

- **O-1 — launch precondition:** wait for the full B-RUNREPORT-54 + B-DEPLOYPARITY merge-down (main → `exp/b-lanes` →
  `exp/b-parallel-build`, each gated). E3, E4, E6, C3 and D4 stay in.
- **O-2 — A2 ships in this bundle.** A1 is kept as the safety net: when linking cannot reproduce a workspace's
  `node_modules`, units and lanes fall back to serial. This repo cannot exercise A2; the first monorepo field run is its
  real test and must be reported.
- **O-3 — delete archaeology** (the dead module, its tests, and the stale `PRD_GUIDE.md` reference). #5 Move 1 is closed
  by subtraction; Moves 2–3 are already satisfied (evidence above).
- **O-4 — close #5, #52 and #53 only when the branch merges to `main`,** with evidence comments then.
- **O-5 — record only:** the trap-door catalog size residual is not in this bundle.
- **O-6 — E5 is cut** (cosmetic; recorded, no ticket).

---

## Refinement (3 analysts × 3 cycles, session `2026-10-02-be104839`, measured at `1bacc67a`) — SUPERSEDES the sections above where they differ

*(refined: all 9 analyses succeeded; `all_success: true`, `missing_requirement_ids: []`. The AC-shape gate exited 2 on one
analyst decomposition hint (C8b lacked a `describeEach` acceptance test); the hint's title is already universal and the
ticket below carries the requested parametrized check, so refinement proceeded without a re-run. The symbol audit's 5
"PHANTOM" entries are prose words on PRD line 41 (field names, a session id), not code symbols — the #54 F4 class.)*

### Run config (refined — the precondition is satisfied) *(refined: risk-scope c3)*
- `exp/b-parallel-build@1bacc67a` contains the B-RUNREPORT-54 + B-DEPLOYPARITY merge-down and is DEPLOYED, byte-identical
  (gate `20261002T220652Z-75128` 22/22). The beta soak on `exp/b-lanes` is paused, not "ended", while this runs.
- `pipeline.json`: `max_parallel_tickets: 2`, `anatomy_max_parallel_lanes: 2`, `scope: branch`,
  `scope_base: 1bacc67a273d185266945443d51a78f7a2c45dc8`. Pre-launch: `git merge-base --is-ancestor 1bacc67a HEAD` exits 0.
  **Never pin `origin/main`** — it is not an ancestor of this branch and halts setup with `scope_base_ahead_of_head`.
- Iteration caps unchanged (500; measured 0.4–4 iterations/ticket). Commit the refined PRD before launch.
- **Gate legs 22 → 22. Verdict-input deltas, each measured by an AC:** D4a lexical-only losses emit at `Medium` (below the
  remediation threshold); C3 reuses `kind: 'advisory'` (readiness exit unchanged); E4's citadel half waits for D4a and its
  FR-only flip count is recorded. *(refined: replaces "no verdict input", falsified three ways)*

### CUJ-OP-1 — the operator reads a finished B-MEGA run *(refined: requirements c2)*
1. At a phase start `pipeline-runner.log` shows `anatomy lanes: disabled for this phase — …` or `pickle waves: disabled for
   this phase — …` only when a parallel arm was eligible and `missing > 0` (A1).
2. During pickle each wave member line ends ` (integration typecheck unavailable)` when the check could not run, plus one
   phase-end `pickle waves: N member(s) integrated over an unavailable integration typecheck` when N > 0 (A4).
3. The final activity block prints, in order: kept lane branches → `base drift: base=<ref>` then `CONFLICT <path>` /
   `clean` / `unmeasured (<reason>)` (E1) → `dropped findings (conf>=25): N in <files>` (D7b, printed even when N = 0).
   All are LOG LINES (one sink).
4. Action map: `CONFLICT` → rebase before merging; `unmeasured` → run `git merge-tree --write-tree <base> HEAD` by hand;
   dropped N > 0 → read the files; unavailable integration → a lone typecheck re-run. No line changes the exit code or the
   success verdict.

### Fixtures *(refined: requirements c3 — none of the PRD's named fixtures exist in the repo)*
Every fixture is BUILT IN-TEST under `os.tmpdir()` in the ticket's own test file (a committed `node_modules` is
gitignored; a separate fixture file is a scope-violation risk). Shapes are stated per requirement below.

### Refined requirements (each replaces the same-named entry above)

- **A1 (medium).** Guard + hoist: `const parallelArm = lanes.length >= 2 || (phaseConfig.name === 'pickle' &&
  runtime.config.max_parallel_tickets >= 2); const missing = parallelArm ? unreproducibleNodeModulesCount(gitRepoRoot(runtime.target)) : 0;`
  A throw from the count → treat as `missing > 0` (fail to serial). Literals: `anatomy lanes: disabled …` stays
  BYTE-IDENTICAL (pinned `tests/pipeline-runner.test.js:5870`/`:5884`); new `pickle waves: disabled for this phase — lane
  worktrees cannot reproduce N node_modules dir(s); running serially`. Fixture: tmp repo, root `package.json`
  (`workspaces: ["packages/*"]`), `node_modules/`, `packages/a/node_modules/`, two `parallel_safe: true` tickets. AC: the
  serial runner gets the parent session dir, no `<session>--unit-*` dir, the waves literal is logged. Controls: root-only
  fixture still runs waves; a serial pickle phase logs neither line.
- **A2 (large).** As contracted, at all THREE call sites (lane creation, unit creation, and `integrateLanes`' `preserve`
  prefixes, `anatomy-lanes.ts:~398`, which must preserve the replica during `resetToSha`). Fixture: A1's plus
  `packages/b/index.ts` and relative symlink `packages/a/node_modules/@s/b → ../../../b`. AC: `realpathSync(<wt>/packages/a/
  node_modules/@s/b/index.ts)` is under `<wt>` (today under `<main>`), and the predicate → `0` (today `1`). Record
  `node_modules_linked` per lane/unit in `lanes.json` (existing field). **R9 (common mode) applies** — see Risks.
- **A3 (small; research tool, no runtime change).** `field-timing.py` (takes `SESSIONS_DIR` positionally; no argparse —
  never rely on `--help`). Committed synthetic fixture sessions under `prds/research/tools/fixtures/`: (a) `waves/` — two
  `parallel_safe: true` tickets + `pickle waves: wave 1 members=… in_flight=2` + member outcome lines → `wave_widths ==
  [2]` and `impl_subphase_min ==` the hand value; (b) `serial/` — two `parallel_safe: true` tickets + two `[done-guard]`
  lines → their interval; (c) `lanes/` — copies of `2026-10-01-face240c`'s lane `anatomy-park.json` files →
  `anatomy_passes == 13` (today 0); (d) `<s>--unit-1/` holding a ticket dir → no row. Also emit
  `wave_member_failed_then_serial_done` (the fake-red estimate, R2). Do NOT write an AC for lane-dir exclusion (true today).
- **A4 (medium).** In `pipeline-runner.ts` ONLY (reads `integration.checks` from `integrateLanes`' return; does NOT edit
  `anatomy-lanes.ts`). Literals as CUJ step 2. Fixture: a wave whose target has no runnable typecheck. Today 0 occurrences.
- **B1 (medium; after C1).** `buildAnatomyPrd` parses the refined PRD's `## Premises` table and renders `## Dependency Lens
  (review-only)`; logs `dependency lens: N premises parsed (M outside allowed paths)` (N=0 when absent — never silent).
  Findings tagged `[report-only: dependency-lens]`; the rubric's pre-existing-lines false-positive bullet
  (`szechuan-sauce-principles.md:~88`) gains the matching exception. ACs: on an in-test session (allowed path `src/alpha`,
  a Premises row citing `src/beta/x.ts`) `grep -c 'src/beta' <session>/prd-anatomy-park.md` ≥ 1 (today 0); no table → the
  log line with N=0; `grep -c 'dependency-lens' extension/szechuan-sauce-principles.md` ≥ 1 (today 0).
- **B2 + D7a (small, doc).** `szechuan-sauce-principles.md`: an "existing writers" protocol check (a new writer to a table
  with writers lists their locks/transaction boundaries/advisory keys and requires parity or a written reason), and the
  `:~92` "stated intent of the change" bullet makes a PRD-says-so-only exoneration of a correctness/concurrency finding
  `[report-only: spec-suspect]`. ACs: `grep -ciE 'other writers|existing writers'` ≥ 1 (today 0); `grep -c 'report-only:
  spec-suspect'` ≥ 1 (today 0). Conformance: no client names, paths, schema names or quoted finding text.
- **C1 + C2 (small, doc).** Both synthesis surfaces (`.claude/commands/pickle-refine-prd.md` Step 6, `.claude/workflows/
  refine-analyze.js` synthesis prompt) emit `## Premises` and `## Open Decisions` per the contracts; analyst
  `(verified)`/`(hypothesis)` tags copied verbatim; "analysts converge" is not verification; a needs-human item is never
  written under settled decisions without a quoted human decision; an empty ledger is written as an explicit "none"
  row. The optional machine check (D-C1) is OUT. ACs: each grep ≥ 1 in both files (today 0/0/0/0; presence checks, not
  behaviour). Same conformance line as B2.
- **C3 (medium; after E4).** Finding shape `{ ticket: 'manifest', kind: 'advisory', analyst: 'gaps', message, detail:
  '<id>: not-in-scope-only' | '<id>: unmapped' }` — NO new `kind` member (the blocking filter `check-readiness.ts:1246`
  is a negative enumeration). The `AC-DR-*` widening goes through E4's shared rule, not a second regex. Edge cases: an id
  both `prd_map`-missing and unowned emits `prd_map` only; an id under NOT in Scope that a ticket body also names is owned.
  ACs on an in-test PRD + ticket dir: readiness exits 0 and prints `AC-DR-1: not-in-scope-only` and `AC-1: unmapped`
  (today neither); the existing `prd_map` control still exits 2.
- **C8a (small).** `spawn-morty.ts` `buildTierLifecycleSections` renders `Expected-value source:` for every tier. AC on
  RENDERED output: `buildTierLifecycleSections(<phases>, t)` contains it for one tier per lifecycle shape (today 0).
- **C8b (small, doc).** All six Test Expectations tables in `pickle-refine-prd.md` (`:270, :352, :458, :556, :657, :764`)
  gain a `Source` column and a fifth separator cell. ACs: `grep -c '| Criterion | Test File | Description | Assertion |
  Source |'` returns 6 (today 0) AND `grep -c '| Criterion | Test File | Description | Assertion |$'` returns 0 (today 6).
- **D4a (medium).** Replace `CoverageSeverity` (`ac-coverage-scorecard.ts:8`) with `CitadelSeverity` (`reporter.ts:1`);
  rows whose credit came only from removed lexical evidence emit at `Medium` with message prefix `lexical-only:` (below
  `REMEDIATION_SEVERITY_THRESHOLD`; advisory via `partitionCitadelCycleFindings`; not claimed by the mechanical
  classifier). Remove `keywordAnchors` from row and finding (no other reader). KEEP `isUsableIdentityToken`/`COMMON_WORDS`
  (they guard `extractSymbolName`, AP-EXT-ITER286-01 pin stays green unmodified). Edit the `src/services/CLAUDE.md:~189`
  export row. ACs: the in-test fixture (`src/label.ts` `export function formatLabel(s: string) { return s.trim(); }`,
  `src/other.test.ts` importing nothing, neither containing `AC-1`) prints exactly `false false` (today `true true`);
  `findings[0].severity === 'Medium'`; control: an `AC-1` literal in a changed production line → `implemented true`.
  Completion note: the replay severity distribution over local `citadel_report.json` files. **R10 (Goodhart)** applies.
- **D4b (medium; cut-first if the bundle runs long; after E4).** Source = `<session>/prd-pickle.md` if present, else
  `prd.md` (`prd.md` is overwritten by anatomy/szechuan setup, `pipeline-runner.ts:~3761/~3919`). Emit `dropped` only
  (`weakened` cut): ids defined in the source (E4 rule) and absent from `prd_refined.md`, each a `CitadelDecision { id:
  '<id>-dropped', severity: 'Medium', message, evidence: ['<source>:<line>'] }` from a new section exposing
  `decisionsRequired`. `buildCitadelAuditReport` derives `decisionRequired` from EVERY section's `decisionsRequired`
  (`Object.values(sections).flatMap(…)`) instead of naming two — a collapse, not a third member. Absent source or refined
  PRD → `[]`, never a throw. ACs: `AC-3` in `prd-pickle.md`, absent in `prd_refined.md` → one decision naming `AC-3`;
  control: `prd.md` is an "Anatomy Park" PRD and `prd-pickle.md` matches `prd_refined.md` → 0. Measured population today:
  0 dropped ids over 11 eligible sessions.
- **D7b (medium).** One log line (CUJ step 3), searching `${SESSION_ROOT}/<subsystem>/dropped_findings.md` one level under
  the parent and each `--lane-*` sibling; zero case prints `0`. `.claude/commands/anatomy-park.md` line format gains
  `cat=<category>` (free text, not an enum). Remove the stray committed `extension/dropped_findings.md` and its
  `extension/CLAUDE.md:~135` cite (0 test readers, measured). ACs: an in-test session with one lane file holding two
  conf≥25 lines → `dropped findings (conf>=25): 2 in …` (today: no such line); zero case prints `0`;
  `git ls-files extension/dropped_findings.md | wc -l` returns 0 (today 1).
- **E1 (medium).** `export function reportBaseDrift(runtime: PipelineRuntime): void` — SYNC (the caller
  `writeFinalPipelineActivity` is sync). Base = `resolveSetupScopeBaseRef(repoRoot)` with exactly ONE argument (passing
  the session `scope_base` is the vacuous pass-through, `:895-896`). `git fetch --no-tags origin <single ref>` (no refspec
  mapping; only `FETCH_HEAD`), 15 000 ms timeout; on fetch failure compare against the local ref labelled `(stale)`. Its
  own `execFileSync` with `timeout`, reading stdout on exit 1 (`runGitString` swallows exit 1, which is how `merge-tree
  --write-tree` reports a conflict). Never throws; never touches the exit code. ACs on one in-test repo with an `origin`
  remote: conflicting upstream with `scope_base` = HEAD → `base drift: CONFLICT <path>` (the pass-through control);
  non-conflicting → `base drift: clean (<ref>)`; no remote → `base drift: unmeasured (`; pipeline exit equals the no-E1
  baseline in all three. Field observation for the closer: on this run it reads `clean` (origin/main differs only by
  MASTER_PLAN commits).
- **E2 (medium, narrowed).** Opt-in workflow path only (`PICKLE_REFINE_WORKFLOW=on`); legacy default and inline Step 7
  unchanged. The phase covers 7a–7e; Step 7g (state handoff) stays with the command (a workflow agent writing `state.json`
  is a Worker Forbidden Op). Throw or 0 tickets → the command runs inline Step 7 and logs `decompose phase: fallback to
  inline Step 7 (<reason>)`. `meta.phases` becomes `['analyze','synthesize','decompose']`;
  `tests/refine-analyze-workflow.test.js` gains a `decompose` branch. README per the Documentation Rule. ACs: `grep -c
  "phase('decompose')"` ≥ 1 (today 0); the command doc names the fallback line; the returned `{tickets}` is an agent's
  report, so the behavioural check is ≥ 1 `rick_ticket_*.md` with `complexity_tier` on disk.
- **E3 (medium).** `spawn-refinement-team.ts:~3058` `if (acShapeStatus !== 0) process.exit(acShapeStatus);` becomes
  `reportAdvisoryGateVerdict('ac-shape gate', acShapeStatus);` (mirror `:~3068`). Wording: "AC shape gate FAILED" → "AC
  shape advisory"; drop the `Override:` line; KEEP `--skip-ac-shape-gate` (removing a CLI arg is Major). Touch-set: the
  helper docblock (`:~2338-2342`), `tests/spawn-refinement-team-checker.test.js:~1637-1655` (invert to assert the advisory
  call and the new doc text), `tests/spawn-refinement-team.test.js:~1019`, the AP-EXT-ITER234-01 BREAKS clause in
  `src/bin/CLAUDE.md:~36` ("returns 2, reported advisory"), `.claude/commands/pickle-refine-prd.md` Step 5 ("stop and fix"
  → advisory). ACs: `main()` over the unjustified-fanout manifest exits 0 with stderr `ac-shape gate advisory: exited 2`;
  control: a clean manifest emits no `ac-shape gate advisory`; `grep -c 'stop and fix' .claude/commands/pickle-refine-prd.md`
  returns 0 (today 1).
- **E4 (medium).** Export from ONE new service `extension/src/services/requirement-ids.ts`:
  `requirementIdsInPrd(markdown: string): string[]` (decides `generic` once: the generic `<UPPER>-<n>` form only when the
  PRD defines no `AC-*` id; no prefix list) and `definedRequirementIdsInLine(line: string, idRe: RegExp): string[]`.
  Refinement (`spawn-refinement-team.ts:~2064/~2081`) and readiness (`check-readiness.ts:~707`) adopt it. **Citadel's
  `prd-parser.ts` adoption only after D4a lands** (otherwise new FR-only rows arrive Critical). ACs: an in-test FR-only
  PRD → `parsePrdFile(…).acceptanceCriteria.length ≥ 1` and `computeRequirementCoverageGap(…).expectedRequirementIds.length
  ≥ 1` (today `0 0`); control: an `AC-*` PRD's expected set is byte-identical; self-hosting control: this PRD's prose
  `AC-1`/`AC-3`/`AC-DR-1` yield 0 defined criteria. Completion note: over `prds/**/*.md` FR-only PRDs, the count whose
  expected set goes 0 → > 0, and the `acceptanceCriteria.length` delta.
- **E6 (medium).** The external `.d.ts` resolver reads declared dependencies from the UNION (de-duplicated) of
  `[root, extension]` and `getWorkspacePackages(repoRoot)` — the enumerator alone returns `[]` on this repo and would drop
  `extension/`. Caps unchanged. ACs: in-test workspace fixture (dependency declared only in `packages/a`) → `dts ≥ 1`
  (today 0); control: `collectExternalDtsFiles(<this repo>)` byte-identical before/after.
- **F1 (large).** Delete per O-3. Allowed paths = `git grep -l -i archaeology -- extension/ PRD_GUIDE.md package.json`
  MINUS `extension/src/services/state-manager.ts` and `extension/src/types/index.ts` (their archaeology members stay; the
  `V3_STATE_SHAPE_MARKERS` marker matters for schema-less legacy states). Also the orphaned `project-type-classifier`,
  `readProjectContextBlock`/`isArchaeologyDisabled` in `spawn-morty.ts`, and the `calibrate:archaeology` npm script. ACs:
  `git grep -l "archaeology.js" -- extension/src | wc -l` returns 0 (today 2); NEW legacy-load controls (labelled controls,
  green before and after): a state with `archaeology: {…}` and an activity log with `archaeology_complete` both load.

### Risks added *(refined: risk-scope c3)*
- **R2 bound.** A3's `wave_member_failed_then_serial_done` is the fake-red estimate; the closer reports it.
- **R9 (A1/A2 common mode).** The predicate shares the linker's walk, so a replica that exists but resolves wrongly reads 0
  and the serial fallback does not fire. Field falsifier: a lane/unit gate fails `Cannot find module`/`ERR_MODULE_NOT_FOUND`
  while the main checkout passes. Action: `max_parallel_tickets: 1` + `anatomy_max_parallel_lanes: 1` in that repo's
  `pipeline.json`, file against A2 with the path. The first monorepo field run reports per-lane `node_modules_linked`.
- **R10 (D4a Goodhart).** Falsifier: added `AC-` literals in remediator commits under `extension/src`. Action: keep the
  `Medium` routing (it removes the remediation pressure).

### Ordering *(refined)*
A1 → A2 (A4 independent; file-disjoint from A2). C1 → B1. E4 → C3, E4 → D4b, D4a → E4's citadel half. C8b after C1+C2
(same file). E3 and E2 touch `pickle-refine-prd.md` after C8b. F1 last of the implementation tickets (widest file set).

### Wiring ticket — skipped *(refined)*
Each item lands in an existing surface and is exercised by its own end-to-end AC (A1/A4 through `main()`, E1 at
`writeFinalPipelineActivity`, D4b in `buildCitadelAuditReport`); no new module needs mounting. The four hardening tickets
run last over the union of files.

### Tiers *(refined: consensus)*
large: A2, F1 · medium: A1, A4, B1, C3, D4a, D4b, D7b, E1, E2, E3, E4, E6 · small: A3, C8a · small doc-only: B2+D7a,
C1+C2, C8b. **19 implementation tickets + 4 hardening = 23.**


## Implementation Task Breakdown

| Order | ID | Title | Priority | Tier | Entry (deps) | Exit | Files |
|---|---|---|---|---|---|---|---|
| 10 | `305f9d98` | Pickle waves and anatomy lanes fall back to serial behind one eligibility-guarded node_modules predicate | High | medium | none | ACs green, committed | 3 |
| 20 | `dd9db0ea` | Wave members disclose an unavailable integration typecheck in the log (pipeline-runner only) | High | medium | none | ACs green, committed | 3 |
| 30 | `62ccbcf4` | A finished pipeline reports drift against its base branch without touching the exit code | High | medium | none | ACs green, committed | 3 |
| 40 | `eecd4ce2` | The run summary reports dropped findings (conf>=25) and the stray committed dropped_findings.md is removed | High | medium | none | ACs green, committed | 6 |
| 50 | `d2db0da1` | Lane and unit worktrees replicate nested workspace node_modules so relative workspace links resolve inside the worktree | High | large | `305f9d98` (A1) | ACs green, committed | 6 |
| 60 | `da045ce1` | field-timing.py reports wave widths, the implementation sub-phase and lane-summed anatomy passes from committed fixtures | High | small | none | ACs green, committed | 2 |
| 70 | `228074bc` | The review rubric checks existing writers' protocols and tags PRD-says-so exonerations report-only: spec-suspect | High | small | none | ACs green, committed | 1 |
| 80 | `18f65637` | Both refinement synthesis surfaces write a Premises ledger and an Open Decisions table | High | small | none | ACs green, committed | 2 |
| 90 | `d87c5ec0` | Every worker lifecycle tier renders an Expected-value source rule | High | small | none | ACs green, committed | 3 |
| 100 | `e23660a5` | Every Test Expectations table in the refinement template carries a Source column | High | small | `18f65637` (C1C2) | ACs green, committed | 1 |
| 110 | `541cc02b` | Anatomy-park renders a review-only Dependency Lens from the refined PRD Premises ledger | High | medium | `18f65637` (C1C2), `228074bc` (B2D7a) | ACs green, committed | 4 |
| 120 | `4ff809e5` | Citadel AC coverage drops lexical keyword credit and routes lexical-only losses at Medium | High | medium | none | ACs green, committed | 4 |
| 130 | `72e52d1f` | One shared requirement-id rule serves refinement, readiness and citadel | High | medium | `4ff809e5` (D4a) | ACs green, committed | 12 |
| 140 | `73a487de` | Readiness reports acceptance criteria owned only by NOT in Scope, or by nothing, as advisory findings | High | medium | `72e52d1f` (E4) | ACs green, committed | 4 |
| 150 | `374ad1c3` | Citadel reports requirement ids the refined PRD dropped, derived from every section decisionsRequired | High | medium | `72e52d1f` (E4) | ACs green, committed | 3 |
| 160 | `4489720b` | The external .d.ts resolver reads every workspace package plus root and extension | High | medium | `73a487de` (C3) | ACs green, committed | 3 |
| 170 | `2f9606ec` | The refinement AC-shape gate reports advisory instead of stopping refinement | High | medium | `e23660a5` (C8b), `72e52d1f` (E4) | ACs green, committed | 7 |
| 180 | `d287216a` | The opt-in refinement workflow gains a decompose phase with an inline-Step-7 fallback | High | medium | `2f9606ec` (E3) | ACs green, committed | 4 |
| 190 | `44e235da` | Delete the never-run archaeology module and everything that exists only for it, keeping legacy state and logs loadable | High | large | `d287216a` (E2) | ACs green, committed | 37 |
| 200 | `b7b650b7` | Harden: code quality review of B-MEGA | High | large | all implementation tickets | ACs green, committed | 42 |
| 210 | `ba2159ca` | Audit: data flow integrity for B-MEGA | High | large | all implementation tickets | ACs green, committed | 42 |
| 220 | `35818690` | Harden: test quality review of B-MEGA | High | large | all implementation tickets | ACs green, committed | 29 |
| 230 | `9908237e` | Audit: cross-reference consistency for B-MEGA | High | medium | all implementation tickets | ACs green, committed | 8 |
