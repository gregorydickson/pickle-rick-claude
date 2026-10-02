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

**E5 (small).** D-E5. AC: a `microverse.md` session reaches `inferMonitorMode` with 0 WARNs. Today: 1.
`unknown-widget.md` still gives 1 WARN.

**E6 (small; after the merge-down).** D-E6. AC: the workspace fixture (dependency declared only in `packages/a`) →
`dts ≥ 1`. Today: `0`. The root-declared control is unchanged.

**F1 — per O-3.** If built: wire `runArchaeology` into setup, keyed on `git rev-parse HEAD:<target-rel>` under
`getDataRoot()/archaeology/`. A hit copies into the session; any failure falls through. AC: with an injected spawn, a
second setup on the same tree makes 0 spawns. To be measured at refinement. **F2, F3:** close on the evidence above, no
tickets.

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
