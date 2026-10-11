# B-FIELD-103 — field-run classes #99–#103 (refined)

**Status:** refined 2026-10-11 (3 analysts × 3 cycles) · **Scope base:** `f2c590f466b214c99bf2d7ab074155b13db1fe1f`
(launch HEAD `c8f82b36` is a docs-only delta over it; every cited line re-verified there) · **Gate legs:** 22 → 22
(counted as the `=== LEG_RC` legs `prds/gate-runner.sh` prints; no leg added or removed).

Issues are referenced by number and generic shape only (root CLAUDE.md: no client content). Session/ticket ids
below are this repo's own dogfood sessions.

## Premises

| # | Claim | Tag | Evidence |
|---|---|---|---|
| P1 | `conformanceVerdictIsFail` reads only the first `ALL_PASS`/`FAIL` token after the last Verdict line; a qualified `ALL_PASS` parses as a pass | verified | `mux-runner.ts:6557-6567`; compiled probe: `"## Verdict: ALL_PASS for the ticket's own criteria"` → `false` |
| P2 | The live #103 family is **2 of 55** conformance artifacts, in **two shapes**: a qualified verdict (`2026-10-06-8bb73a5e/dffe1ae9`) and a **bare** `## Verdict: ALL_PASS` plus a substantive `## Manager Handoff` recording an unrun axis (`…/fccc51d9`). An exact-token rule alone catches only the first; `hasSubstantiveManagerHandoff` (`mux-runner.ts:6505`) catches both and nothing else | verified *(refined: codebase c3, compiled module over all `sessions/*/*/conformance_*.md`)* | 55 artifacts; handoff-true 2; verdictFail-true 0 |
| P3 | A manager-handoff residual **withholds nothing**: `emitManagerHandoffResidual` (`mux-runner.ts:6587-6605`) appends one `gate_skipped` activity line; `computePipelineVerdict` (`pipeline-runner.ts:6547-6561`) reads only `pipelineFailed || nonConvergent>0 || doneOverRed || degradedSkip || openDecisions` | verified *(refined: all three c3)* | both #103 tickets are `Done`; that run reported success |
| P4 | Parking a deferral loops: a respawn writes a fresh `conformance_*.md` (`LIFECYCLE_ARTIFACT_RE`, `mux-runner.ts:11529`), which resets bounded-escape charges (`:8778-8830`), so the per-ticket cap fires `iteration_cap_exhausted` for the **whole** mux loop (`:13751-13758`) | verified *(refined: risk + codebase c2/c3)* | — |
| P5 | The worker prompt itself sanctions the #103 shape: `spawn-morty.ts:1197` tells workers to list deferred `[manager]` items under `## Manager Handoff` and not fail on them; in `dffe1ae9` the deferred criterion was **untagged**, and `pickle-refine-prd.md:280` mandates `[manager]` tags only for "closer/release/hardening tickets" | verified *(refined: requirements c3)* | grep `\[manager\]` in that ticket = 0 lines |
| P6 | Trivial/small tickets write no conformance artifact (`TIER_LIFECYCLE`, `services/ticket-tier.ts:30-35`), so WS-1 cannot see them | verified | — |
| P7 | Open Decisions rows already withhold success: `readOpenDecisions` (`pipeline-runner.ts:3772-3784`) counts a row open unless its `status` cell matches `^decided` | verified | — |
| P8 | `state.json` stamps `claude_version_seen` / `codex_version_seen` but no pickle-rick build version or source sha (#100) | verified | `setup.ts:1598-1599` |
| P9 | `check-update` runs only from the stop hook after a session (`stop-hook.ts:672-712`); `getCurrentVersion` returns `'0.0.0'` on read failure (`check-update.ts:202-211`); `auto_update_enabled:false` short-circuits to up-to-date without fetching (`:688-690`); `checkForUpdate` can install | verified | — |
| P10 | Refinement edge-case rubric is "Covers empty, null, max, error states" (`pickle-refine-prd.md:476`); `grep -ci "edge case"` = 8 | verified | — |
| P11 | Verifier mutates only new throws/guards/fail-closed branches, at most 5 (`morty-phase-verifier.md:22`; worker-facing step 6 at `spawn-morty.ts:560`); survivors are a "conformance finding" | verified | — |
| P12 | No requirements-analyst rule asks for degenerate-input rows (`grep -ci degenerate spawn-refinement-team.ts` = 0) | verified | — |
| P13 | No phase reviews rendered structure; `playwright` appears only as a test-command classifier | verified | `ticket-tier.ts:94`, `convergence-gate.ts:119` |
| P14 | `mux-runner.ts:2339` (`if (conformance.hasManagerHandoff) continue;`) sits on the absent-commit phantom-Done branch and protects legitimate closer handoffs (gh-11); it is NOT a test-red carve-out | verified *(refined: all three c1–c3 — original P2 was wrong)* | — |

## Workstreams

### WS-1 (#103) — a deferred or qualified check is disclosed, never laundered into success

The run already has the right disposition for this (Done kept, output kept); what is missing is that it never
reaches the verdict. One subtraction-shaped fix *(refined: codebase c3 P0-1..4, risk c3 P0)*:

| Evidence in the latest `conformance_*.md` | Done flip | Run verdict | Respawn |
|---|---|---|---|
| verdict token `FAIL` | refused, parked (today's path, `findFailedAcceptanceAssertion`) | — | yes, bounded as today |
| bare `ALL_PASS`, no substantive handoff | accepted | unaffected | no |
| `ALL_PASS` + qualifying text on the verdict line, **or** a substantive `## Manager Handoff` | accepted | **withheld** | **no** |
| unfilled template `ALL_PASS / FAIL` | accepted | **withheld** | no |
| no verdict line / prose with no token | accepted | unaffected (unchanged) | no |

- **Withhold wire:** widen `collectDoneTicketsWithRedTestVerdict` (`pipeline-runner.ts:7314`) — the collector
  behind the existing `doneOverRed` term — from "persisted test verdict is red" to "this Done ticket's own evidence
  says not all green": red test verdict **or** a latest conformance artifact matching row 3 or 4. Record the new
  arm as its own phase disposition `done_with_deferred_checks:<ids>` via the existing
  `appendPhaseDisposition(counters, 'pickle', …)`, and print one run-end line naming those tickets (sibling of
  `reportLifecycleIncompleteTickets`, `pipeline-runner.ts:2677`). **No new `unsuccessful` term, no new event, no
  new `LocalParkDisposition` member, no new refusal handler** (`grep -c "isAcceptanceAssertionRefusal("
  extension/src/bin/mux-runner.ts` stays 7).
- **Detector:** one exported predicate in `mux-runner.ts`, `conformanceDefersChecks(content: string): boolean` —
  true for row 3 or 4 — built from the existing `hasSubstantiveManagerHandoff` plus a verdict-line check (a verdict
  line whose remainder after stripping markdown/step number is not exactly `ALL_PASS` or `FAIL`).
  `conformanceVerdictIsFail` keeps its boolean signature and its current behaviour (only `FAIL` parks).
  `readLatestTicketConformanceSnapshot` (`:6526`) is the single reader both sides use; export it (or a thin
  wrapper) from one home.
- **Producer half:** `spawn-morty.ts:560` step 7 requires the verdict as a bare token on its own line, with deferred
  checks under `## Manager Handoff` and never on the verdict line; `spawn-morty.ts:1197` requires each Manager
  Handoff bullet to quote the `[manager]` criterion it defers. `pickle-refine-prd.md:280` widens mandatory
  tagging from "closer/release/hardening tickets" to "any criterion the worker cannot execute under the Worker
  Forbidden Ops table, whatever the ticket's kind", and adds the tiering rule "a ticket carrying a `[manager]`
  criterion or naming an installer/OS/CI check is at least `medium`" (closes P6 without a new path).
- **Not changed:** `mux-runner.ts:2339`; `conformanceVerdictIsFail`'s signature; #66 (`converged_with_unmeasured` is a
  different predicate — not absorbed).
- **Known limit:** trivial/small tickets have no conformance phase (mitigated by the tiering rule).
- `/pickle-tmux` has no pipeline verdict: its disclosure is the existing `gate_skipped manager_handoff_pending`
  activity record (`flagManagerHandoffResidual`, `:6621-6635`); nothing new.
- **Expectation, stated:** the first bundle after deploy will report more degraded runs where tagging was sloppy.
  That is honest, not a regression.

### WS-2 (#100) — a fix is live when a run records it (record-only)

- **Stamp at deploy:** `install.sh` writes `BUILD_INFO.json` `{ version, source_sha, dirty, tag }` into the
  **deployed** extension root **after** the rsync (`install.sh:378` uses `--delete`, so writing it into source
  would be erased or self-dirty the tree). Git mode: `source_sha = git rev-parse HEAD`, `dirty` from
  `git status --porcelain`; tarball mode: `source_sha: null`, `tag` from the release version. *(refined: all c3)*
- **Stamp at launch:** `setup.ts` copies it into `state.json` as `pickle_build`, plus `build_check`
  (below). Both fields: `extension/CLAUDE.md` § state.json Field Invariants entries (required by
  `state-field-invariants.test.js`), `null` hydration in `normalizeV5StateDefaults`
  (`services/state-manager.ts:771`), **no schema bump** (precedent `claude_version_seen`).
- **Comparison:** a pure comparator exported from `check-update.ts` — never `checkForUpdate`, never an install
  path. Three-valued and content-keyed: `behind` iff the latest release tag's commit is not an ancestor of
  `source_sha`; `current`; `unmeasured` with a reason (`no_source_sha`, `gh_missing`, `offline`, `dirty`…). Release
  tag only; `origin/main` is NOT a reference (it is the working branch and trails constantly).
- **Disclosure:** the pipeline run-end summary prints `pickle_build` (with `(dirty)`), `build_check`, and
  `build_changed_mid_run` when a run-end re-read of `BUILD_INFO.json` differs from the launch stamp.
- **Record-only:** `build_check` never enters `computePipelineVerdict` (being behind a tag says nothing about this
  run's output; an `unmeasured` withhold would kill auto-success on every offline launch). **Launch refusal is
  rejected** (launch-block, PRIME DIRECTIVE).
- **Handoff convention** (MASTER_PLAN, not code): an issue closes as *live* by citing a session whose stamped
  `source_sha` contains the fix and is not dirty.

### WS-3 (#101 + #102) — test inputs span the code's distinctions; outcome rules carry degenerate rows

- **Plan input table** (`spawn-morty.ts` Plan section, `:546-560` region): for each input the change reads —
  writers and storable values; cardinality (0 / 1 / many-differing); related fields, with one row that makes them
  disagree; variant source (derived from the type/registry, never hand-listed); size bound (counted work at n and
  2n, never timing). Each cell names its test row. A change reading no runtime input writes one row
  `none — <reason>`. The existing per-writer rule (#80 follow-up, "one test fixture per writer") becomes one column;
  keep its literal so `spawn-morty-tier-phases.test.js:170` stays green (or co-scope and update it).
- **Plan review** (`plan_review` phase, medium/large) refuses a plan whose table is missing or has an unassigned
  cell; `none — <reason>` is accepted.
- **Domain mutants** (`spawn-morty.ts:560` step 6, `morty-phase-verifier.md:22`, `project-mayhem.md` Step 3b): from the
  table — collapse to the first member, swap the two related fields, drop one variant — join #87's guard-mutant
  ledger under the **existing** "at most 5" cap, selected guard → domain → presentation. A survivor the verifier
  marks `equivalent: <reason>` is a **finding, not a FAIL**; a non-equivalent survivor is a FAIL (curable: add the
  killing test). Keep `/at most 5/` (`spawn-morty-tier-phases.test.js:185`, `:197`) green.
- **Refinement rubric** (`pickle-refine-prd.md`): replace `:458`, `:476` and `:677` with the input-table rule; fold
  #79's symmetry clause in (an input side is one variant set). Keep `:640` (a review severity row), reworded as
  "an input-table cell with no test row". Net: `grep -ci "edge case"` drops below 8.
- **#102 degenerate rows:** `REQUIREMENTS_ROLE_INSTRUCTIONS` (`spawn-refinement-team.ts:765`) asks, for each rule
  that publishes a persisted outcome over open input, for a degenerate-row table (unreadable, empty, more than one,
  conflicting members, malformed/foreign, oversized, lookalike-but-distinct). The synthesis rule
  (`pickle-refine-prd.md:188`) writes **at most one roll-up `## Open Decisions` row per such rule**, `default` = the
  fail-closed option the build proceeds on (a real option — e.g. `read unknown / refuse`), `status: open` until the
  spec owner rules. #82's counter-example rule is restated as one case of it. Row kinds live in the analyst
  template, not in code.
- Verdict consequence, stated: an open roll-up row withholds the run's success through the existing
  `openDecisions` term — the intended "rule once before the build" pressure, at most one row per rule.

### WS-4 (#99) — a UI ticket's rendered structure is reviewed (operator decision 2026-10-11: "ok, 3")

- Decided approach (quoted): **option 3 — no images; review the rendered structure.** Applies when a PRD
  state/outcome row's outermost surface (#84, `pickle-refine-prd.md:199`) is a rendered view: the row's test renders
  that state to DOM/HTML **in the target repo's existing test runner** and asserts on the rendered whole.
- Fixed checklist, asserted over those renders and applied by conformance and anatomy-park: (a) no pass styling on a
  not-passed / unknown / missing state — the verifier cites the target's pass token as `file:line`, so a missing
  citation is a visible FAIL rather than a vacuous pass; (b) one value → one label everywhere it renders; (c) no
  empty container or orphan header; (d) every count/summary consistent with the state it summarizes.
- Presentation mutants join the WS-3 ledger (swap a fail state's styling to the pass style; relabel one occurrence
  of a value; render an empty group).
- No render-capable runner in the target → the check is decomposed as a `[manager]`-tagged criterion, so it routes
  through WS-1's deferral row (disclosed, success withheld) and never becomes a silent pass.
- pickle-rick adds **no browser or screenshot dependency**. Known limit: purely visual defects (layout, contrast).

## Interface Contracts

- **WS-1** `export function conformanceDefersChecks(content: string): boolean` (`mux-runner.ts`).
  `conformanceVerdictIsFail(content: string): boolean` unchanged. `TicketConformanceSnapshot` gains
  `defersChecks: boolean`. Phase disposition string: `done_with_deferred_checks:<comma-separated ids>`.
- **WS-2** `BUILD_INFO.json` (deployed root): `{ version: string; source_sha: string | null; dirty: boolean | null;
  tag: string | null }`. `state.json`: `pickle_build: { version: string; source_sha: string | null; dirty: boolean |
  null } | null`; `build_check: { outcome: 'behind' | 'current' | 'unmeasured'; installed: string | null; latest:
  string | null; reason: string | null } | null`. Comparator: `export function compareInstalledBuild(input: {
  sourceSha: string | null; dirty: boolean | null; latestTagSha: string | null; isAncestor: (a: string, b: string)
  => boolean | null }): BuildCheck` (pure; IO lives in its caller).
- **WS-3 / WS-4** prompt contracts: the input-table header, the `none — <reason>` row, `domain mutant`,
  `equivalent:`, `pass styling` — pinned in ONE parametrized prompt-contract test over the worker-facing template
  (`buildTierLifecycleSections` output), `morty-phase-verifier.md` and `anatomy-park.md`.

## Acceptance Criteria (measured at HEAD `c8f82b36`; each fails today unless marked guard)

| AC | Check | Today | Expected |
|---|---|---|---|
| WS-1a | `conformanceDefersChecks` on a `fccc51d9`-shaped fixture (bare `## Verdict: ALL_PASS` + substantive handoff; structure only) | symbol absent | `true` |
| WS-1b | same on a `dffe1ae9`-shaped fixture (qualified verdict + handoff) | absent | `true` |
| WS-1c | control: handoff body `none` + bare `ALL_PASS` | absent | `false` |
| WS-1d | `computePipelineVerdict(...).unsuccessful` for a session with one Done ticket (green gate verdicts) whose artifact is WS-1a-shaped | `false` | `true`, and `phaseDispositions.pickle` contains `done_with_deferred_checks` |
| WS-1e | falsifying control for WS-1d: same session, handoff `none` | `false` | `false` |
| WS-1f | guard: `grep -c "if (conformance.hasManagerHandoff) continue;" extension/src/bin/mux-runner.ts` | 1 | 1 |
| WS-1g | guard: `grep -c "isAcceptanceAssertionRefusal(" extension/src/bin/mux-runner.ts` | 7 | 7 |
| WS-1h | `grep -c "closer/release/hardening tickets, prefix" .claude/commands/pickle-refine-prd.md` | 1 | 0 |
| WS-2a | `grep -c "pickle_build" extension/src/bin/setup.ts` | 0 | ≥1, plus a `setup.test.js` row asserting the stamp from a fixture `BUILD_INFO.json` |
| WS-2b | `grep -c "BUILD_INFO.json" install.sh` | 0 | ≥1, plus an install fragment test against a temp `--prefix` |
| WS-2c | guard: `grep -cE "applyAvailableUpdate|performUpgrade|checkForUpdate\(" extension/src/bin/setup.ts` | 0 | 0 |
| WS-3a | `grep -c "Covers empty, null, max, error states" .claude/commands/pickle-refine-prd.md` | 1 | 0 |
| WS-3b | `grep -ci "cardinality" extension/src/bin/spawn-morty.ts` | 0 | ≥1 (in the rendered Plan section, pinned by test) |
| WS-3c | `grep -ci "domain mutant" .claude/agents/morty-phase-verifier.md` | 0 | ≥1 |
| WS-3d | `grep -ci "degenerate" extension/src/bin/spawn-refinement-team.ts` | 0 | ≥1 |
| WS-3e | `grep -ci "edge case" .claude/commands/pickle-refine-prd.md` | 8 | < 8 |
| WS-4a | `grep -ci "pass styling" .claude/agents/morty-phase-verifier.md` | 0 | ≥1 |

Single-token greps are necessary, not sufficient: each prompt ticket also adds a pin in an existing prompt-contract
test (memory: an existence pin can be satisfied by a comment).

## CUJs

- **CUJ-1 (WS-1, #103):** a worker defers an unrunnable check under `## Manager Handoff` and writes `ALL_PASS` →
  Done kept, no respawn → remaining tickets build → run-end line names the ticket → `computePipelineVerdict`
  unsuccessful → no halt, no auto-success.
- **CUJ-2 (WS-1, worker red):** worker writes `FAIL` → parked → respawn → fixed → Done (unchanged).
- **CUJ-3 (WS-2):** `install.sh` from a dirty tree → deployed `BUILD_INFO.json {source_sha, dirty:true}` → launch with
  `gh` absent → `pickle_build` stamped, `build_check: unmeasured(gh_missing)` → summary prints both → verdict
  unaffected.
- **CUJ-4 (WS-3):** a prompt-only ticket's plan writes `none — prompt-only` → plan review accepts.
- **CUJ-5 (#102):** a refined PRD with a name-matching rule gets one roll-up Open Decision with a fail-closed default →
  the operator rules once before the build.

## Risks

| Risk | Mitigation (testable) |
|---|---|
| An unrunnable check respawns forever (artifact resets the escape cap) | Deferrals never park; only `FAIL` parks (WS-1 table) |
| Disclosure without a verdict wire (fake-green) | Widened `doneOverRed` collector; WS-1d/e |
| WS-1 adds a disposition/handler and breaks the Z1 pin | No new member/handler; WS-1g |
| #102 rows make every refined PRD unsuccessful | One roll-up row per rule, real default |
| Launch reuses `checkForUpdate` and installs | Pure comparator; WS-2c |
| `0.0.0` / `auto_update_enabled:false` fabricate behind/current | Content-keyed, three-valued, record-only |
| New state fields red `state-field-invariants.test.js` | CLAUDE.md invariants + hydration in the WS-2 file list |
| Plan review refuses prompt-only tickets | `none — <reason>` row |
| Equivalent mutants loop | `equivalent: <reason>` is a finding, not a FAIL |
| A rubric rewrite reds out-of-list pins and the fence deadlocks | Pinning test files co-scoped per ticket |

## Non-Goals

No launch refusal; no install at launch; no browser/screenshot dependency; no new gate leg; no new `unsuccessful`
disjunct; no `LATEST_SCHEMA_VERSION` bump; no CI-provider lane derivation (follow-up); no change to
`mux-runner.ts:2339`; #66 not absorbed; no `release.yml` change; WS-2 never withholds success.

## Open Decisions

| decision | options | default | owner | status |
|---|---|---|---|---|
| WS-4 approach | 1 screenshot capture / 2 target tooling only / 3 rendered-structure review, no images | 3 | operator | decided: "ok, 3" |
| WS-1 deferral disposition | Done + withheld success, no park / refuse once then accept with stamp / park | Done + withheld, no park | operator | open |
| WS-2 withhold policy | record-only / withhold when behind | record-only | operator | open |
| CI-lane derivation from the target's CI config (#103) | follow-up row / this bundle | follow-up row | operator | open |

## Simplification Review

1. **Necessary?** WS-1 adds one predicate and widens one collector; it adds no verdict term, event, disposition
   member, handler, or park path. WS-2 adds two optional state fields, one deploy file and one pure comparator; it
   rejects the launch refusal. WS-3/WS-4 are prompt-contract changes.
2. **Reuse?** `hasSubstantiveManagerHandoff`, `readLatestTicketConformanceSnapshot`, the `doneOverRed` collector,
   `appendPhaseDisposition`, `readOpenDecisions`, #87's mutation ledger and cap, #84's outermost-surface rule, the
   target's own test runner.
3. **Brittle complexity subtracted?** The proposed "manager residual withholds" route (dead wire) is replaced by an
   existing verdict term; three rubric lines (`:458`, `:476`, `:677`) and #79's separate clause collapse into one
   input-table rule; #82's narrower rule becomes a case of #102's.
4. **Subtraction:** as in 3. Original WS-1d (delete `:2339`) dropped — the premise was wrong (P14).

## Rejected (recorded)

- #100 launch refusal behind the released tag — launch-block (PRIME DIRECTIVE).
- #103 park/"Blocked" for an unrunnable check — loops the whole mux loop (P4); replaced by Done + withheld success.
- Deleting `mux-runner.ts:2339` — not a test-red carve-out (P14).
- #99 option 1 (screenshot capture) — deferred as a separate design item for the operator.
- `origin/main` as a WS-2 reference — the working branch; behind almost always.
- Absorbing #66 — different predicate.

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | 7df6c7d2 | A Done ticket whose conformance defers or qualifies a check withholds the run success verdict (#103) | High | prior orders Done | per ticket Exit State | extension/src/bin/mux-runner.ts, extension/src/bin/pipeline-runner.ts, extension/tests/success-verdict-withheld.test.js, extension/tests/mux-runner.test.js, extension/src/bin/__tests__/mux-runner.output-stall.spec.ts, extension/src/bin/CLAUDE.md |
| 20 | 5f47f782 | Worker and refinement contracts keep the verdict bare and tag every unrunnable criterion [manager] (#103) | High | prior orders Done | per ticket Exit State | extension/src/bin/spawn-morty.ts, .claude/commands/pickle-refine-prd.md, extension/tests/spawn-morty-tier-phases.test.js, extension/tests/pickle-refine-prd-failure-mode-checklist.test.js |
| 30 | e4e9344e | Each session records the pickle-rick build it ran on (#100) | High | prior orders Done | per ticket Exit State | install.sh, extension/src/bin/setup.ts, extension/src/services/state-manager.ts, extension/CLAUDE.md, extension/tests/setup.test.js, extension/tests/install-script.test.js, extension/tests/state-field-invariants.test.js |
| 40 | 219ace9e | Launch records whether the installed build is behind the latest release, record-only (#100) | High | prior orders Done | per ticket Exit State | extension/src/bin/check-update.ts, extension/src/bin/setup.ts, extension/src/bin/pipeline-runner.ts, extension/tests/check-update.test.js, extension/tests/pipeline-runner.test.js |
| 50 | 1e6a0e28 | The Plan writes an input table and plan review refuses a plan without one (#101) | High | prior orders Done | per ticket Exit State | extension/src/bin/spawn-morty.ts, extension/tests/spawn-morty-tier-phases.test.js |
| 60 | f999eb11 | The verifier applies domain and presentation mutants under the existing cap (#101, #99) | High | prior orders Done | per ticket Exit State | extension/src/bin/spawn-morty.ts, .claude/agents/morty-phase-verifier.md, extension/tests/spawn-morty-tier-phases.test.js |
| 70 | ffe9f2ba | Refinement asks for input tables, degenerate-row decisions and rendered-structure rows (#101, #102, #99) | High | prior orders Done | per ticket Exit State | .claude/commands/pickle-refine-prd.md, extension/src/bin/spawn-refinement-team.ts, extension/tests/pickle-refine-prd-failure-mode-checklist.test.js, extension/tests/spawn-refinement-team.test.js |
| 80 | 10adfeeb | Wire: integrate B-FIELD-103 changes end to end | High | prior orders Done | per ticket Exit State | extension/src/bin/pipeline-runner.ts, extension/tests/pipeline-runner.test.js |
| 90 | 2d87768d | Harden: code quality review of B-FIELD-103 | High | prior orders Done | per ticket Exit State | extension/src/bin/mux-runner.ts, extension/src/bin/pipeline-runner.ts, extension/src/bin/__tests__/mux-runner.output-stall.spec.ts, extension/src/bin/CLAUDE.md, extension/src/bin/spawn-morty.ts, extension/src/bin/setup.ts, extension/src/services/state-manager.ts, extension/src/bin/check-update.ts, extension/src/bin/spawn-refinement-team.ts |
| 100 | ab7647d7 | Audit: data flow integrity for B-FIELD-103 | High | prior orders Done | per ticket Exit State | extension/src/bin/mux-runner.ts, extension/src/bin/pipeline-runner.ts, extension/src/bin/__tests__/mux-runner.output-stall.spec.ts, extension/src/bin/CLAUDE.md, extension/src/bin/spawn-morty.ts, extension/src/bin/setup.ts, extension/src/services/state-manager.ts, extension/src/bin/check-update.ts, extension/src/bin/spawn-refinement-team.ts |
| 110 | 7a3ad8cf | Harden: test quality review of B-FIELD-103 | High | prior orders Done | per ticket Exit State | extension/tests/success-verdict-withheld.test.js, extension/tests/mux-runner.test.js, extension/tests/spawn-morty-tier-phases.test.js, extension/tests/pickle-refine-prd-failure-mode-checklist.test.js, extension/tests/setup.test.js, extension/tests/install-script.test.js, extension/tests/state-field-invariants.test.js, extension/tests/check-update.test.js, extension/tests/pipeline-runner.test.js, extension/tests/spawn-refinement-team.test.js |
| 120 | 75550fea | Audit: cross-reference consistency for B-FIELD-103 | High | prior orders Done | per ticket Exit State | extension/src/bin/CLAUDE.md, .claude/commands/pickle-refine-prd.md, extension/CLAUDE.md, .claude/agents/morty-phase-verifier.md, extension/CLAUDE.md |
