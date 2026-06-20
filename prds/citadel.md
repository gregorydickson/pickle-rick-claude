# PRD — Citadel (Conformance Audit) + Cross-Skill Hardening

> **Scope note**: This PRD is the new `/citadel` command (post-implementation conformance audit — the Citadel of Ricks judges your branch against the PRD it was built from) **plus** the matched updates to `/pickle-refine-prd`, anatomy-park, and szechuan-sauce that the LOA-618 post-mortem identified. One PRD, three sibling skills updated, one new skill added — the gaps don't cleanly partition by skill, so the fixes ship together.

> **Merge note (2026-04-29)**: This PRD absorbs `bmad-inspired-hardening.md` (deleted 2026-04-29). The conformance overlap (BMAD P0's AC-machine-checkability and contract-resolution checks) is integrated into the core audit as new task T17 (refinement-time hard gate that pairs with T20's enforcement and T11.7's safety net). The remaining BMAD capabilities — `/pickle-readiness` skill itself, `/pickle-archaeology`, phase-specialized Morty personas, `/pickle-correct-course`, `/pickle-debate`, codex-version smoke, schema v2→v3 migration, hang guards, behavioral test framework, CUJs, expanded risk register, and implementation task breakdown — are preserved verbatim in the **Appendix: Additional BMAD-inspired hardening (non-conformance)**. No genuine contradictions found between the two PRDs; both reference LOA-618 and v1.55.0 baseline coherently.

## Background

After running `/pickle-pipeline` end-to-end on a 22k-line feature (LOA-618 Updated Appraisal Comparison, 41 tickets) a manual 5-agent audit found 8 real issues the pipeline missed:

- 2 AC violations (audit action allowlisted but never emitted; feature flag not gating mutation endpoints per AC-FF-05).
- 5 trap-door-documented behaviors with zero regression tests.
- 1 cross-cutting bug (3 of 4 sibling proxy routes lost a structured error-body field on the same code path).

None of these are anatomy-park's job (data-flow regression) or szechuan-sauce's job (DRY/simplification). They are whole-feature conformance issues invisible to per-ticket review.

This PRD specifies a new Pickle Rick slash command that runs as a post-implementation phase between build (pickle / pickle-tmux) and quality (anatomy-park / szechuan-sauce). It validates an entire branch's diff against the PRD it was built from, plus surfaces unguarded trap doors and sibling-pattern divergence.

## Persona / Style

Pickle Rick voice. Cynical, terse, builds tools instead of complaining. Belch occasionally. Output should be scannable — tables, file:line citations, no prose padding.

## Skill Venn (overlap is intentional)

The three post-implementation skills share a Venn-diagram model. Each owns a primary domain; the overlaps are deliberate, not duplication:

```
            ┌────────────────────────┐
            │   anatomy-park         │
            │  (subsystem depth,     │
            │   data flow, trap-door │
            │   discovery)           │
            │                        │
            │       ┌──── pattern    │
            │       │     replay,    │
            │       │     trap-door  │
            │       │     coverage   │
            │       ▼                │
            │   ┌───────────────┐    │
            │   │ conformance-  │    │
            │   │ audit (PRD ↔  │    │
            │   │ implementation│    │
            │   │ invariants)   │    │
            │   └───────────────┘    │
            │       ▲                │
            │       │     dead       │
            │       │     code,      │
            │       │     hygiene,   │
            │       │     diff-shape │
            │       │                │
            │   szechuan-sauce       │
            │   (DRY, simplify,      │
            │   delete waste)        │
            └────────────────────────┘
```

**Primary domain of conformance-audit**: does the branch satisfy the PRD it was built from? AC coverage, endpoint contract, sibling guard parity, rule-set invariants. Whole-feature scope.

**Intentional overlaps**:
- *with anatomy-park*: trap-door enforcement (T6) and pattern-replay (T10.7). anatomy-park goes deep on a subsystem; citadel walks the whole branch and verifies anatomy-park's findings are enforced everywhere.
- *with szechuan-sauce*: dead allowlists (T4) and diff hygiene (T10.9). szechuan-sauce optimizes for fewer lines; citadel catches the conformance variant — "this entry exists but nothing references it" reads as a PRD-vs-impl gap, not just dead code.
- *with `/pickle-refine-prd`*: AC-shape smell (T11.7). Refinement should enforce invariant-shaped ACs at fan-out time; citadel is the safety net for ACs that slipped through.

A small amount of duplicated detection across skills is acceptable. The cost of missing a bug is much higher than the cost of two skills both reporting it.

## Reuse Reality Check

The first cut of this PRD claimed reuse from `pickle-refine-prd`, anatomy-park, and szechuan-sauce. After auditing the codebase that turned out to be fiction at the *TypeScript module* level:

- `pickle-refine-prd` is LLM-driven (`extension/src/bin/spawn-refinement-team.ts`); no markdown→entity parser exists.
- anatomy-park and szechuan-sauce are slash-command prompts (`.claude/commands/*.md`), not TypeScript modules. There is no extractable `Logger`, `Reporter`, trap-door parser, or diff-walker to import.
- `extension/src/skills/` does not exist. The repo layout is `extension/src/{bin,services,lib,types,hooks,scripts}/`.

The only existing primitive that maps to this PRD is `getDiffFiles(base, head, repoRoot)` in `extension/src/services/git-utils.ts:163`. Everything else is **build from scratch** for the citadel core (T1–T16).

**However**, the cross-skill tasks T20–T23 do edit real files: `.claude/commands/pickle-refine-prd.md`, `.claude/commands/anatomy-park.md`, `.claude/commands/szechuan-sauce.md` (prompt updates), plus `extension/src/bin/spawn-refinement-team.ts` (manifest schema) and a new shared `extension/src/services/citadel/diff-hygiene.ts`. Schema changes (anatomy-park.json `pattern_shape`, refinement_manifest.json `ac_shape_smells` + `justification`, szechuan output `category: 'hygiene'`) are real interface contracts and must ship together for T10.7 / T10.9 / T11.7's safety-net dedupe to work.

## Command Surface

`/citadel` — new top-level slash command.

Inputs:
- `--prd <path>` (required) — path to PRD markdown file.
- `--diff <range>` (optional, default `main..HEAD`) — git diff range to audit.
- `--strict` (optional) — exit non-zero on any High finding (default: only on Critical).
- `--report <path>` (optional) — write JSON report to path; otherwise stdout.
- `--no-block` (optional) — never block the pipeline regardless of severity.
- `--print-stubs` (optional) — emit `node:test` skeletons inline for unguarded trap doors.

When invoked from `/pickle-pipeline`, all inputs come from session state. See **Pipeline Integration** below for the schema fields this requires; T0 wires them.

Outputs:
1. **Console** — ranked findings list (Critical → High → Medium → Low), each with severity tag, AC / trap-door ID, file:line citation, one-sentence description.
2. **JSON report** — written to `--report <path>` (or `<session>/citadel_report.json` when invoked from pipeline). Schema versioned with `schema: "1.0"`.
3. **End-of-run summary line:**
   ```
   Conformance audit: <total> findings (CRITICAL=N, HIGH=N, MEDIUM=N, LOW=N)
                      <decisions> decisions required
                      <unguarded> unguarded trap doors
                      exit <code>
   ```

Exit code:
- `0` if no Critical (or no High when `--strict`).
- `1` otherwise.

## Repo Conventions (Non-Negotiable)

This PRD must conform to the existing extension conventions:

- **Source path**: New code lives at `extension/src/services/citadel/` (TypeScript). NOT `extension/src/skills/...` — that path doesn't exist and introducing it is out of scope.
- **CLI entry point**: If a binary is needed, it goes in `extension/src/bin/` and follows the CLAUDE.md guard pattern: `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`.
- **Tests**: `extension/tests/citadel-*.test.js` via `node --test`. NOT Vitest. NOT `.test.ts`. Run with `npm test` from `extension/`.
- **Build gate**: `npx tsc --noEmit && npx tsc && npm test` from `extension/`.
- **AST parsing**: Prefer `node --test` + regex/grep over heavy AST deps. If AST is required for T7/T9/T10, declare `ts-morph` explicitly in `extension/package.json` devDependencies before T7 starts; otherwise use the TypeScript compiler API which is already a transitive dep.
- **Fixture path**: `prds/fixtures/citadel/` (top-level, alongside the PRD). NOT under `extension/` — CLAUDE.md forbids `.md` artifacts there.

## Tasks

### T0 — Session-state schema migration

Pre-requisite for T13. The current `State` interface in `extension/src/types/index.ts:1-43` does not have `prd_path` or `start_commit`. (It does have `prd_path` on `MicroverseSessionState`, but not on the main pipeline state.)

Steps:
- Add optional `prd_path?: string` and `start_commit?: string` to the main `State` interface.
- Update `setup.js` (canonical: `extension/src/bin/setup.ts`) to populate both fields when `pipeline.json` is written.
- Bump state schema version + add migration in `state-manager.ts`.

Exit: state.json on a fresh pipeline session contains both fields; tests in `extension/tests/state-schema-*.test.js` cover the migration.

### T1 — PRD ID parser

Build a parser at `extension/src/services/citadel/prd-parser.ts` that walks a PRD markdown file and extracts:
- Architectural decisions (`A1` … `A99`, including dotted forms like `A11.`).
- Acceptance criteria IDs matching `AC-[A-Z0-9]+(-[A-Z0-9]+)*(-\d+)?`.
- API endpoints from tables shaped `| <METHOD> /path |`.
- Audit / enum allowlist additions (`VALID_ACTIONS`, lender_feature_flags keys, enum value tables).
- Per-endpoint status-code tables and documented error-message strings.

Multi-paragraph PRD sections may bury an AC in prose; do not require a table. Test on the LOA-618 PRD fixture committed under `prds/fixtures/citadel/loa-618-prd.md`.

This parser does **not** exist anywhere — `pickle-refine-prd` is LLM-driven and produces prose, not typed entities. Build from scratch.

Exit: parser exposes typed entities (`Decision`, `AcceptanceCriterion`, `Endpoint`, `AllowlistEntry`, `StatusCodeRow`).

### T2 — Diff walker

Build a helper at `extension/src/services/citadel/diff-walker.ts` that takes a git diff range and returns:
- Set of changed files (production + tests, classified).
- Set of CLAUDE.md files in or under any changed-file's directory.
- Per-file blame summary for changed lines (so findings can name an authoring commit).

Wrap `getDiffFiles` from `extension/src/services/git-utils.ts:163` for the file-set; add the CLAUDE.md walk and blame summary on top.

Exit: helper exposes `walkDiff(range): DiffSummary` with deterministic ordering.

### T3 — AC coverage scorecard

For each ID from T1:
- Grep production-code files in T2's changed set for at least one match (ID in a comment OR an implementing symbol whose name contains a keyword anchor extracted from the AC's title).
- Grep test files in T2's changed set for at least one test that names the ID or implementing symbol.

Produce a markdown table:
```
| ID         | Implemented | Tested | File:line evidence       |
|------------|:-----------:|:------:|--------------------------|
| AC-FF-01   | ✓           | ✓      | service.ts:2619 + spec   |
| AC-FF-05   | ✗           | ✗      | (no enforcement found)   |
```

**Known limitation**: This is a keyword-anchor heuristic, not semantic name-matching. Recall ceiling is bounded by AC-comment discipline + keyword overlap. Expect ~60-70% recall on real branches without LLM assistance. T11.5 (optional) adds an LLM-assisted entity-extraction pass to lift that ceiling.

Severity:
- `✗ Implemented` → Critical.
- `✓ Implemented, ✗ Tested` → High.

Exit: scorecard generator produces the table + structured findings; tests assert keyword-anchor matching against the LOA-618 fixture.

### T4 — Allowlist dead-entry detector

For every `VALID_ACTIONS` entry, lender_feature_flags key, or enum value added in the diff range:
- Grep production code (excluding `*.spec.ts` / `*.test.tsx` / `*.test.js`) for at least one caller.
- Allowlist entry with zero production callers → High finding ("dead allowlist; deploy-ordering smell").

Catches the `appraisal.updated_run_failed` class.

Exit: detector returns a list of dead allowlist entries with file:line of the allowlist declaration.

### T5 — Endpoint contract conformance

For every endpoint in T1's endpoint list:
- Locate the controller method (NestJS `@Controller`/`@Get`/`@Post` decorator parse).
- Confirm the implementation throws or returns each documented status code at least once. Use grep for `throw new (Forbidden|BadRequest|NotFound|Conflict)Exception` patterns; escalate to `ts-morph` only if grep recall drops below 80% on the fixture.
- Confirm documented error-message strings appear verbatim somewhere in the implementation.

Severity:
- Missing 4xx → Medium.
- Missing 403 / auth path → High.

Exit: endpoint conformance report listing all missing-code rows.

### T6 — Trap door coverage gate (presence + enforcement)

Build the trap-door parser at `extension/src/services/citadel/trap-door-parser.ts`. anatomy-park does **not** have an extractable parser to share — it is a slash-command prompt; build from scratch.

For every trap-door bullet in CLAUDE.md files identified in T2:
- Resolve the symbol the bullet cites (e.g. `service::reExtract`, `processor` step number, file path) via regex anchors over named entities: file paths, rule codes (`DIFF_005`), schema fields (`subject.property_address`), numeric thresholds (`50MB`, `10MB`).
- Find that symbol's spec file (e.g. `service.spec.ts`).
- **Presence check**: Grep the spec for at least one `it()` / `describe()` whose body references the trap door's specific failure mode using the named-entity anchors.
- **Enforcement check** (added to close the LOA-618 S3-key gap): For trap doors that document a structural INVARIANT (regex shape, segment count, allowlist membership, range bound, ordering), assert the spec contains a negative test — i.e. an assertion that violating inputs are rejected. Trap doors written as "X must match shape Y" without a corresponding "rejects when not Y" test → High finding even if a positive-path test exists.
- Bullet with zero matching tests → High finding.
- Bullet with positive-only tests against an invariant trap door → High finding ("trap door documented but not enforced").

**Known limitation**: Free-text bullet parsing without an LLM gives keyword-level coverage only. Tests that parameterize thresholds (e.g. computed dates instead of literal `2026-03-02`) will silently miss. Document the limitation in the report header so reviewers understand the recall floor.

Output an unguarded list as a markdown checklist:
```
- [ ] `service::reExtract` — date-roundtrip guard (no test for 2026-02-30 case)
- [ ] `compute-differences` — condo legacy "false" string normalize
```

When `--print-stubs` is set, emit `node:test` skeletons inline so a human can flesh them out.

Exit: unguarded checklist + structured findings.

### T7 — Sibling proxy-route divergence audit

Group `*/route.ts` files in T2's changed set into sibling cohorts. **Sibling definition**: same immediate-parent directory pattern AND same HTTP method handler exports. (Just-parent-pattern grouping false-positives in Next.js app-router where `app/api/foo/[id]/route.ts` and `app/api/bar/[id]/route.ts` are unrelated.)

For each cohort of ≥2 routes:
- Parse the catch-block AST of each route.
- Diff the error-handling shape across siblings.
- Divergence (e.g. one route returns `err.body ?? { error: err.message }`, others return only `{ error: err.message }`) → High finding.

Catches the LOA-618 proxy `err.body` bug.

Exit: divergence pairs reported with file:line of the inconsistent siblings.

### T8 — State-machine transition audit

Parse the PRD for tables shaped "Transition | Audit | …". For each transition row:
- Confirm a corresponding audit emit exists in production code (string match the audit action, then walk to the call site).

Missing audit emit → High finding.

Exit: transition coverage report; each missing emit cites the PRD row + the expected call site.

### T9 — Sibling auth/precondition audit + destructive-role lint

Two passes on the same controller cohort:

**Pass A — guard-prefix parity.** For all controller methods on the same resource path prefix (e.g. `/foo/:id/X`, `/foo/:id/Y`, `/foo/:id/Z`):
- Compare the prefix of guards each method runs (`@Roles`, `@UseGuards`, flag check, ownership lookup, status validation), accounting for class-level vs method-level decorator inheritance.
- Divergence (e.g. method A flag-checks but B does not) → Medium finding.

Catches the cross-method flag inconsistency variant of AC-FF-05.

**Pass B — destructive-role lint** (added to close the LOA-618 `client_user could DELETE` gap). For every controller in T2's changed set:
- Identify destructive routes by handler shape: `@Delete(...)` decorators, route names matching `revert-*` / `override-*` / `cancel-*` / `purge-*`, or method names matching `/(delete|revert|override|cancel|purge|destroy)/i`.
- Collect the `@Roles(...)` allowlist for each.
- If destructive routes in the same controller have non-equal role allowlists → High finding ("destructive-role drift").
- If a destructive route has no `@Roles` decorator at all → Critical finding.

Exit: divergence report with method names + missing guard list + destructive-role drift table.

### T10 — Frontend prop drift audit

For every component invocation in `.tsx` files in T2's changed set:
- Parse the JSX attributes passed.
- Parse the receiver component's declared props.
- Passed-but-not-declared (and not spread) → High finding.

**Known blind spot**: Spread props (`<Foo {...rest} />`) defeat this heuristic, and spread is ubiquitous in modern React. Report header must call out that any sibling using spread is not analyzed. Future enhancement: trace spread-source types if `ts-morph` is in play.

Catches the `comparisonData` dead-prop case.

Exit: prop-drift report.

### T10.5 — Resource-module guard parity (cross-route)

This is broader than T9's path-prefix grouping. **LOA-618 lesson**: AC-FF-05 was decomposed into four endpoint tickets and `getComparison` was simply not on the list. T9 catches drift between path-prefix siblings; this catches drift across **all routes touching the same resource module**, even when paths don't share a prefix.

Steps:
- Identify the "resource module" for each changed controller method by walking imports: a method belongs to module M if its handler reads/writes a service exported from `M/*.service.ts` or a Drizzle schema from `M/*.schema.ts`.
- For each module, enumerate every controller route (read + write paths) that touches it.
- For each guard observed on **any** route in the module (`@UseGuards(FlagGuard)`, `isXEnabled` calls, `@Roles`, ownership lookups), check it is also applied to **every other** route in the module — unless the route is explicitly tagged `@Public()` or annotated `// CONFORMANCE-EXEMPT: <reason>`.
- Missing guard on a sibling read endpoint → High finding. Missing guard on a sibling write endpoint → Critical finding.

Catches the LOA-618 `getComparison` flag-gate miss directly.

Exit: per-module guard-coverage matrix; rows are routes, columns are guards, missing cells are findings.

### T10.7 — Pattern-replay enforcement (overlap with anatomy-park)

**Primary owner**: anatomy-park (deep pattern discovery + per-subsystem replay; see CSF-2 for the deep version).
**This task's slice**: branch-wide regex/AST replay of anatomy-park findings the audit can read from session state. Light overlap, intentional — anatomy-park looks deep at one subsystem, citadel walks the whole branch.

**LOA-618 lesson**: anatomy-park found the `BullMQ enqueue inside try/catch with rollback update().set({status})` CRITICAL pattern in `createUpdatedRun`, added a CLAUDE.md trap door, but the same pattern in `retryChildExtraction` shipped without the CAS guard.

Steps:
- Read `<session>/anatomy-park.json` for findings tagged `severity: CRITICAL` AND `category: pattern`. (Soft-skip with a Low informational finding when the file is absent — audit may run standalone.)
- For each such finding, extract the structural shape (anatomy-park records its detection regex/anchor in the finding payload).
- Re-grep the entire diff for matches of that shape.
- For every match, assert the documented mitigation is present (e.g. CAS guard, retry-idempotency). Missing mitigation → Critical finding ("pattern-replay miss"), citing the original anatomy-park finding ID.

When anatomy-park ships its own CSF-2 phase-2 sweep, this task becomes the redundant safety net at branch scope — kept on purpose. Two skills catching the same bug is cheaper than missing it.

Exit: pattern-replay sweep report; each finding cites the original anatomy-park finding ID + the un-guarded site.

### T10.8 — Rule-set / state-machine invariant checker

**LOA-618 lesson**: `DIFF_001`, `DIFF_002`, `DIFF_003` were tested in isolation; nothing asserted "exactly one fires per single-field change." The bug encoded itself into the multi-rule test's expected output.

Steps:
- Detect rule-set or enum-set declarations in the diff: `const RULES = [...]`, exported `enum DifferenceCode { ... }`, `VALID_ACTIONS` arrays, status-machine const objects with ≥3 members.
- Look for an accompanying invariant assertion in spec files: a test that names ≥2 members of the set together AND asserts a relationship — `expect(fired.length).toBe(1)`, `expect(fired).toEqual([...])`, `for.each` over the set with mutual-exclusion check, etc.
- A rule-set declaration of size ≥3 with no invariant assertion → Medium finding ("rule-set lacks interaction test").
- Optionally, when the PRD contains an explicit invariant clause (lines matching `exactly one of {…}`, `at most one of {…}`, `mutually exclusive`, `partition of`), promote to High.

Exit: rule-set inventory + invariant-coverage table.

### T10.9 — Diff-shape / orphan-file gate (overlap with szechuan-sauce)

**Primary owner**: szechuan-sauce or a future `/pickle-prepr-lint` (see CSF-3).
**This task's slice**: orphan files are also a *conformance* problem — they're committed but not part of the documented change. Light overlap, kept intentionally.

**LOA-618 lesson**: `continuation_plan.md` got accidentally tracked at the repo root. Cheap to catch.

Steps:
- For every file added by the diff (`status: 'A'`), apply rules:
  - Top-level `*.md` not in `{CLAUDE.md, README.md, AGENTS.md, LICENSE.md, CHANGELOG.md}` → Medium finding.
  - Top-level `*.txt`, `*.log`, `*.tmp`, `scratch*`, `notes*`, `WIP*`, `tmp*` → Medium finding.
  - Files matching `.env*` (except `.env.example`) → Critical finding.
  - Files >1 MB not gitignored → High finding (binary leak).
- Suppress findings already flagged by szechuan-sauce on the same diff (read `<session>/szechuan-sauce.json` if present) so the two skills don't double-count in the user-facing report.

Exit: hygiene findings list, deduped against szechuan-sauce output when available.

### T11 — Divergence reconciliation reporter

Some PRD violations are not bugs — they are product / UX deviations the team shipped on purpose. Detect by scanning for:
- ✓ Implemented but ✗ Tests-locked-against-PRD (tests assert something contradicting the PRD; team chose differently).
- Trap doors that contradict the PRD (LOA-618 case where the trap door said "stay live across rollback" while AC-FF-05 said "403 when off").

Report these as `DECISION REQUIRED`, not findings. Suggest which document to amend. Do not auto-fix.

Exit: decision-required list, separate from findings.

### T11.7 — AC-shape smell (overlap with `/pickle-refine-prd`)

**Primary owner**: `/pickle-refine-prd` (see CSF-1) — must enforce at fan-out time.
**This task's slice**: safety-net detector for ACs that slipped through refinement, plus echo on dog-food / fixture runs. Light overlap, intentional.

**LOA-618 lesson**: AC-FF-05 was authored as four bullet points (one per endpoint), refinement decomposed it into four parallel tickets, the missing fifth endpoint (`getComparison`) was never on the list. The load-bearing fix has to be at refinement time, but citadel catches whatever still slips through.

Steps:
- For each AC extracted by T1, count bullet/sub-bullet structure under it.
- Flag as `DECISION REQUIRED` (Medium severity, contributes to exit code under `--strict`) when: ≥3 bullets each name a distinct endpoint / handler / method, AND all bullets repeat the same predicate, AND the AC headline has no universal quantifier.
- Cross-check against the refined ticket manifest (when `<session>/prd_refined.md` exists): if the smelly AC produced ≥3 separate tickets and none of them carry a `// JUSTIFICATION:` block, escalate to High.
- Suggest the rewrite: "Rewrite as 'every <resource> endpoint <predicate>' with a parametrized test."

Exit: AC-shape findings in both `DECISION REQUIRED` and (when the refinement manifest is available) in the High-severity findings stream.

### T11.5 — (Optional) LLM-assisted entity extraction

T3 and T6 have known recall ceilings because grep can't do semantic name matching or free-text entity extraction. Optional sub-task: when `--llm-assist` is set, run a single Claude pass over the PRD to extract `(AC ID → expected symbols / call sites)` and `(trap-door bullet → expected test anchors)` mappings. Feed the mappings back into T3/T6 grep. Token cost should be bounded (<10k input tokens per audit).

Exit: when `--llm-assist` is enabled, T3/T6 recall on the LOA-618 fixture lifts above the keyword-only baseline by a measurable delta (target: ≥10 percentage points).

### T12 — Findings ranker + JSON reporter

Aggregate all findings from T3–T11. Rank by severity (Critical → High → Medium → Low). Emit:
- Console output (ranked markdown).
- JSON report (typed schema versioned with `schema: "1.0"`).
- End-of-run summary line.
- Correct exit code.

Build a small `Reporter` class — no shareable Logger/Reporter exists in szechuan-sauce; it's a prompt skill.

Exit: single entry-point function `runCitadelAudit(opts): Promise<{ exitCode, findings, decisions, json }>`.

### T13 — pipeline-runner integration

Update `extension/src/bin/pipeline-runner.ts` so `/pickle-pipeline` runs:
```
pickle → citadel → anatomy-park → szechuan-sauce
```

(Note: `meeseeks` is **not** in the active chain — `pipeline-runner.ts` explicitly sets `chain_meeseeks = false` and the deprecation comments at lines 268, 329, 844-845 confirm the loop is retired. Earlier draft of this PRD wrongly listed meeseeks; it has been removed.)

Steps:
- Extend the `PipelinePhase` type union (currently `'pickle' | 'anatomy-park' | 'szechuan-sauce'` at `pipeline-runner.ts:50`) to include `'citadel'`.
- Add a phase branch alongside the existing `else if` blocks (lines 843, 857, 906) that reads `state.prd_path` + `state.start_commit` (populated by T0), invokes `runCitadelAudit`, and writes `<session>/citadel_report.json`.
- Replace the binary "halt on any non-zero exit" semantics (`pipeline-runner.ts:952-954`) with severity-gated halt: read the JSON report, halt only when `findings[].severity === 'Critical'` (or `>= High` under `--strict`); otherwise continue to anatomy-park.
- Specify the read protocol: anatomy-park and szechuan-sauce phases gain an explicit `readCitadelReport(sessionDir)` helper. anatomy-park uses the unguarded-trap-door list to prioritize its catalog phase; szechuan-sauce treats the divergence list as known/intentional. **Wire those readers explicitly — do not assume implicit handoff.**

Exit: pipeline-runner integration tested against the LOA-618 fixture branch.

### T13.5 — `/cronenberg` integration

`/cronenberg` is the meta-router that picks a metaphor + followup chain from request signals (`.claude/commands/cronenberg.md`). It currently routes to `/pickle`, `/pickle-tmux`, `/pickle-pipeline`, `/pickle-microverse`, `/council-of-ricks`, plus followups `/anatomy-park` and `/szechuan-sauce`. It does **not** know about `/citadel`.

Wire citadel into cronenberg as a followup, gated on signals where a whole-feature audit pays off:

Steps:
- Add a new signal `CITADEL_RISK` to Step 2: true when any of (`PRD_PRESENT` AND `TICKET_COUNT ≥ 3`) OR (TASK mentions "conformance / acceptance criteria / spec compliance / audit against PRD") OR (`SUBSYSTEM_TOUCHES ≥ 2` AND `PRD_PRESENT`).
- Add a Step 4 followup row: when `CITADEL_RISK` is true → append `/citadel --prd <prd_path>` **before** `/anatomy-park` in the followup chain. Rationale: anatomy-park can prioritize unguarded trap doors surfaced by the audit (matches the pipeline-runner ordering from T13).
- Update the skip-followups rule: `/pickle-pipeline` already chains citadel internally (per T13), so cronenberg must not double-append it when `/pickle-pipeline` is the chosen metaphor. Extend the existing skip clause for `/pickle-pipeline`.
- Update Step 5's printed plan template so the signals line includes `conformance=<y/n>`.
- For tmux-launching metaphors (which can't auto-chain — see Step 6), the printed copy-paste followup list must include the citadel invocation in the right slot.

Exit: `/cronenberg --dry-run` on a multi-ticket PRD task prints a plan that includes `/citadel` before `/anatomy-park`; `/cronenberg --dry-run` on a single-file fix does not include it; `/cronenberg` (default execute) on a `/pickle`-routed task chains citadel at the correct position.

### T14 — Slash command + help

Author `.claude/commands/citadel.md` (the command prompt the harness invokes). Update `/help-pickle` to mention the new phase. Update `.claude/commands/cronenberg.md` per T13.5. Update `README.md` and any PRD guide docs to document the task surface area, the JSON report schema, and the cronenberg routing entry.

Exit: command discoverable via `/help-pickle`; running `/citadel --help` prints usage; `/cronenberg` lists citadel in its followup table.

### T15 — Self-test fixtures

Bundle three fixture branches under `prds/fixtures/citadel/`:

1. **LOA-618 regression positive** (commit `d51dda2b` of `gregory/loa-618-updated-appraisal-comparison-epic` in the loanlight-api repo) — captured as a PRD + diff blob. Each of the 8 manual-audit issues is tagged with a stable ID (`LOA-618-ISSUE-001` through `LOA-618-ISSUE-008`) in `prds/fixtures/citadel/loa-618-issues.json`. The audit MUST surface ≥6 of those 8 IDs at severity ≥ High, matched by ID.
2. **Noise floor negative** — a clean already-merged epic from the same repo. Audit MUST produce <5 Low findings and zero Critical/High.
3. **Random-sample cohort** (≥5 additional closed epics, hand-picked but not cherry-picked-for-coverage) — captured as PRD + diff blobs. Used to measure aggregate recall and false-positive rate. No hard threshold; measurement only, results recorded in `prds/fixtures/citadel/recall-baseline.json`. This guards against overfitting to LOA-618.

Tests don't depend on live repo access — fixtures are committed.

Exit: `npm test` covers all three fixture cohorts with deterministic assertions.

### T16 — Pipeline regression smoke test

When the build finishes, run `/citadel` against the **LOA-618 fixture diff** (NOT this PRD's own diff — this PRD has zero `AC-*` IDs, zero endpoints, zero `VALID_ACTIONS`, so a self-audit trivially passes and measures nothing).

Smoke test passes when: LOA-618 fixture audit surfaces ≥6 of 8 tagged issues at severity ≥ High, exits non-zero under `--strict`, and the noise-floor fixture stays clean.

Exit: pipeline regression smoke test passes deterministically.

### T17 — Refinement-time AC-verifiability + contract-resolution hard gate (folded from BMAD P0)

**Source**: `bmad-inspired-hardening.md` P0 `/pickle-readiness`. The pre-implementation alignment gate's two conformance-shaped checks — "every AC is machine-checkable" (P0.2) and "every contract referenced exists" (P0.2 via `scope-resolver.computeOneHop`) — are folded into citadel's conformance umbrella here. The wider `/pickle-readiness` skill itself (with PRD↔ticket map, recycle cycles, history flags, multi-repo, codex-version smoke, delta-mode post-correction) is preserved as Appendix Section 1; this task is the conformance subset that lives in citadel's authority.

**Why citadel and not just BMAD's P0**: T20 (refinement-time AC-shape collapse-or-justify) already enforces *shape*. T11.7 (audit-time safety net) already catches what slips through. T17 adds the missing *machinability* check between them — a refined ticket whose AC says "the system should be intuitive" passes T20's shape filter and T11.7's enumeration filter but fails machinability. That's the conformance gap.

Steps:
- After `/pickle-refine-prd --run` mints the ticket tree but BEFORE `setup.ts` writes `state.json`, run a verifier over each `${SESSION_ROOT}/<hash>/linear_ticket_<hash>.md`:
  - **AC machinability**: each AC must be (a) a measurable threshold (numeric, exact-string match, regex), (b) an observable artifact (file exists, JSON field present), (c) an enumerable input/output table, or (d) a test name. Pure-prose ACs ("must be performant", "should feel intuitive") → fail.
  - **Contract resolution**: every symbol/path/file the ticket references resolves via `scope-resolver.computeOneHop({findImportersTimeoutMs: 30_000})`. Unresolved → fail.
- Failure routes back to refinement with the failing AC list and a suggested analyst (`gaps` for missing-machinability, `codebase` for missing-contract).
- Hard cap: `state.json.readiness.cycle_history.length ≤ 3`. After 3 cycles the gate halts with `readiness_escalation_<date>.md` (preserves BMAD R33 mitigation).
- After `course_corrected` events bump `tickets_version`, re-run T17 in DELTA mode on added/modified tickets only (preserves BMAD R30 / P0.12).

This task **cooperates** with T20: T20 enforces shape and `// JUSTIFICATION:` blocks at the analyst level; T17 enforces machinability and contract resolution at the manifest level. Both must pass for refinement to hand off to setup.

**Files**:
- `extension/src/bin/check-readiness.ts` (NEW — shared with Appendix Section 1; this task uses only the AC-machinability + contract-resolution checks).
- `extension/src/services/artifact-validation.ts` (reuse `findMissingPrefixes` per BMAD P0.8).
- `extension/src/bin/spawn-refinement-team.ts` (T17 hook: invoke `check-readiness --machinability-only --contract-only` after manifest aggregation; halt with `exit 2` on fail).
- `tests/check-readiness-machinability.test.js` (NEW — fixtures with prose-only ACs, missing-symbol references).

Exit: refinement on a fixture PRD with a prose-only AC halts with `exit 2` and a suggested-analyst hint; refinement on a fixture PRD with an unresolvable contract reference halts with `exit 2`; both surfaced in `readiness_<date>.md`. Cycle 4 halts with escalation file.

## Post-Mortem Gap Coverage (LOA-618)

The LOA-618 pipeline run produced 7 issues that reached code review. Each maps to a primary owner with an intentional safety-net overlap from one of the other two skills:

| Issue | Primary owner | Safety net |
|---|---|---|
| `getComparison` skipped feature flag | **T20** (`/pickle-refine-prd` AC-shape enforcement) + **T10.5** (resource-module guard parity) | **T11.7** (AC-shape echo at audit time) |
| `retryChildExtraction` rollback raced with worker | **T21** (anatomy-park phase-2 pattern-replay sweep) | **T10.7** (branch-scope replay against anatomy-park output) |
| `DIFF_001` co-firing with `DIFF_002`/`DIFF_003` | **T10.8** (rule-set invariant) | none needed |
| `client_user` could DELETE (role drift) | **T9 Pass B** (destructive-role lint) | none needed |
| S3 key UUID structural validation missing | **T23** (szechuan trap-door-as-test sweep) + **T6** (AC-cited subset) | T21 sets `pattern_shape` so future replays catch new violations |
| `differenceSummary` Drizzle cast | **OUT OF SCOPE** | ergonomic, not correctness |
| `continuation_plan.md` orphan file | **T22** (szechuan-sauce diff-hygiene gate) | **T10.9** (deduped against szechuan output) |

**Two structural takeaways:**

1. *PRD ACs need machine-checkable invariants, not endpoint enumerations.* T20 enforces at refinement time (load-bearing fix); T11.7 is the audit-time safety net; T10.5 catches the runtime consequence.
2. *Trap doors are knowledge, not enforcement.* T21 makes anatomy-park record `pattern_shape` and replay it within its own run; T23 makes szechuan-sauce assert every new trap door has a corresponding negative test; T6 covers the AC-cited subset; T10.7 is the branch-scope safety net.

## Cross-Skill Tasks (this PRD updates three sibling skills)

The LOA-618 post-mortem's load-bearing fixes don't all live in citadel. T20–T23 update the three sibling skills so the Venn-overlap model in the diagram above actually has primary owners doing primary work:

### T20 — `/pickle-refine-prd`: AC-shape collapse-or-justify

**Files**: `.claude/commands/pickle-refine-prd.md` (worker prompt) + `extension/src/bin/spawn-refinement-team.ts` (orchestration).

The refinement skill already runs 3 parallel analyst workers per cycle. Add an AC-shape smell pass to each worker's prompt and a manifest-level enforcement step in `spawn-refinement-team.ts`:

1. **Worker prompt update** (`pickle-refine-prd.md`): instruct the worker to flag every AC where (a) the headline lacks a universal quantifier ("all", "every", "for any"), AND (b) the body has ≥3 bullets each naming a distinct endpoint/handler/method, AND (c) all bullets repeat the same predicate. Worker emits these in a new `ac_shape_smells` section of its analysis output.
2. **Manifest enforcement** (`spawn-refinement-team.ts`): when the manifest aggregator merges worker outputs into `refinement_manifest.json`, every AC tagged as a smell must produce **exactly one** of:
   - A single parametrized ticket whose title contains a universal quantifier and whose acceptance test is `describe.each([...])` over the enumerated cases, OR
   - A multi-ticket decomposition where each ticket carries an explicit `// JUSTIFICATION:` block in the manifest entry.
3. **Halt condition**: if any smelly AC produced ≥2 tickets without justification, refinement halts with `exit 2` and surfaces the AC list. The `pickle-refine-prd` skill prompt is updated to instruct the user how to either rewrite the AC or add justifications.
4. **Manifest schema bump**: `refinement_manifest.json` gains `ac_shape_smells: AcShapeSmell[]` and per-ticket `justification?: string`.

This is the load-bearing fix for the `getComparison` class of misses. T11.7 in citadel is the safety net.

Exit: refinement on a fixture PRD containing an enumerated AC produces a parametrized ticket OR halts demanding justification; manifest schema test asserts `ac_shape_smells` field.

### T21 — anatomy-park: phase-2 pattern-replay sweep

**Files**: `.claude/commands/anatomy-park.md` (skill prompt — anatomy-park is prompt-driven, no TS module to edit).

anatomy-park's three phases (data-flow trace → fix without regression → catalog trap doors) are extended with a **phase-2.5 pattern-replay sweep** between fix and catalog:

1. **Prompt update** (`anatomy-park.md`): add a phase-2.5 section instructing the agent that, for every finding produced in phase 2 with `severity: CRITICAL` AND `category: pattern`, it must:
   - Articulate the structural shape of the pattern in unambiguous terms (file shape, AST shape, or grep regex).
   - Re-grep / re-walk the full diff scope for matches of that shape.
   - For every additional match, verify the documented mitigation is present.
   - Emit any un-guarded match as a new CRITICAL finding in `anatomy-park.json`, tagged `phase: replay` and citing the original finding ID.
2. **Output schema bump**: `anatomy-park.json` findings gain `phase?: 'discovery' | 'replay'` and `original_finding_id?: string`. Trap-door entries gain a `pattern_shape` field (regex or AST description) consumed by both anatomy-park's own replay and citadel's T10.7 safety-net.
3. **Catalog phase update**: every trap door added in phase 3 must include the `pattern_shape` so future runs can replay against it deterministically.

Catches the `retryChildExtraction` class. T10.7 in citadel becomes the branch-scope safety net that runs even when anatomy-park is skipped.

Exit: on the LOA-618 fixture, anatomy-park surfaces both `createUpdatedRun` (discovery) and `retryChildExtraction` (replay) as CRITICAL findings; the trap-door entry in CLAUDE.md carries a `pattern_shape` regex.

### T22 — szechuan-sauce: diff-hygiene gate

**Files**: `.claude/commands/szechuan-sauce.md` (skill prompt) + optional helper at `extension/src/services/citadel/diff-hygiene.ts` (shared with T10.9).

Add a hygiene pass to szechuan-sauce's existing principle-driven sweep:

1. **Prompt update** (`szechuan-sauce.md`): add a "diff hygiene" principle section. For every file with `status: 'A'` in the diff:
   - Top-level `*.md` not in `{CLAUDE.md, README.md, AGENTS.md, LICENSE.md, CHANGELOG.md}` → emit P1 finding ("orphan planning doc — move to `docs/` or `prds/` or delete").
   - New `.env*` (except `.env.example`) → P0 ("secret leak risk").
   - New top-level `*.txt`, `*.log`, `*.tmp`, `scratch*`, `notes*`, `WIP*`, `tmp*` → P1.
   - New >1 MB files not gitignored → P2 ("binary leak").
2. **Shared helper** (`diff-hygiene.ts`): the rules live in a small typed module so both szechuan-sauce (via the prompt's reference) and citadel's T10.9 use the same allowlist constants. Single source of truth.
3. **Output bump**: szechuan-sauce's findings JSON gains `category: 'hygiene'` for these entries so T10.9 can dedupe against them.

Catches the `continuation_plan.md` class. T10.9 in citadel dedupes against szechuan output when run together.

Exit: szechuan-sauce on a diff that adds a top-level `notes.md` produces a P1 hygiene finding; the shared `diff-hygiene.ts` helper has unit tests asserting the allowlist constants.

### T23 — szechuan-sauce: trap-door-as-test enforcement sweep

**Files**: `.claude/commands/szechuan-sauce.md`.

The post-mortem's second structural takeaway: *"for each CLAUDE.md trap door added in this branch, is there a spec that fails if the trap door is violated?"* This is broader than T6's per-AC enforcement — it operates on every trap door anatomy-park (or a hand-edit) added in the diff, regardless of whether the AC explicitly cites it.

1. **Prompt update**: szechuan-sauce gains a sweep instruction. For every trap-door bullet added to a CLAUDE.md file in the diff (read directly from `git diff` of CLAUDE.md files), with a `pattern_shape` field present (set by T21):
   - Confirm at least one spec file in the diff contains a test whose body asserts the negative case (input violating the pattern is rejected / throws / fails).
   - Trap door without a corresponding negative test → P0 finding ("trap door documented but not enforced").
2. **Coordination with T6**: T6 in citadel handles the AC-cited subset. T23 handles the un-cited remainder. Both write findings; citadel's reporter dedupes by `(claude_md_file, bullet_text)` tuple.

Catches the S3-key class deeper than T6 alone. The trap door is now a contract, not a comment.

Exit: szechuan-sauce on the LOA-618 fixture flags the S3-key trap door as un-enforced (P0) when the receiving-side validation test is missing; dedupes correctly when citadel also reports it.

## Acceptance Criteria

- [ ] **AC-CIT-01**: `/citadel --prd <loa-618-prd> --diff main..HEAD --strict` exits non-zero on the LOA-618 fixture and surfaces ≥6 of the 8 tagged issues from `loa-618-issues.json`, matched by stable ID, all severity ≥ High.
- [ ] **AC-CIT-02**: All tasks T3–T11 produce findings under their own clearly labelled console section.
- [ ] **AC-CIT-03**: JSON report writes to `<session>/citadel_report.json` when invoked from `/pickle-pipeline`; schema is versioned `"1.0"`.
- [ ] **AC-CIT-04**: `pipeline-runner.ts` integrates the phase between `pickle` and `anatomy-park`, blocking only on Critical (or High with `--strict`); anatomy-park and szechuan-sauce explicitly call `readCitadelReport(sessionDir)`.
- [ ] **AC-CIT-05**: Noise-floor fixture (clean merged epic) produces <5 Low findings and zero Critical/High.
- [ ] **AC-CIT-06**: Random-sample cohort (T15 #3) recall/precision baseline is recorded in `recall-baseline.json` and surfaces no regressions on subsequent runs (>5pp recall drop fails CI).
- [ ] **AC-CIT-07**: `.claude/commands/citadel.md` slash command exists; `/help-pickle` mentions the new phase; `/cronenberg` routes to `/citadel` as a followup when `CITADEL_RISK` is true and skips it when `/pickle-pipeline` is the chosen metaphor.
- [ ] **AC-CIT-08**: `state.prd_path` and `state.start_commit` are populated by `setup.ts` and visible in `state.json` on a fresh pipeline session.
- [ ] **AC-CIT-09**: Audit run on a 22k-line diff completes in <120 s wall-clock on a developer laptop (perf budget).
- [ ] **AC-CIT-10**: Re-running the audit on an unchanged diff is idempotent — same JSON report, same exit code; concurrent invocations on the same session dir are guarded by `state-manager.ts` locks.
- [ ] **AC-CIT-11** (LOA-618 post-mortem regression): On the LOA-618 fixture, the audit surfaces all six in-scope gaps — `getComparison` flag-gate miss (T10.5), `retryChildExtraction` pattern-replay miss (T10.7, given a populated `anatomy-park.json`), rule-set interaction gap (T10.8), destructive-role drift (T9 Pass B), S3-key invariant non-enforcement (T6), and `continuation_plan.md` orphan (T10.9). At least 5 of 6 fire at severity ≥ High; the 6th may fire at Medium.
- [ ] **AC-CIT-12**: T11.7 (AC-shape) on the LOA-618 PRD surfaces AC-FF-05 in `DECISION REQUIRED` with a suggested rewrite. When the refinement manifest shows AC-FF-05 fanned out into ≥3 tickets without a `// JUSTIFICATION:` block, T11.7 escalates to High.
- [ ] **AC-CIT-13** (overlap behavior): When `<session>/szechuan-sauce.json` exists, T10.9 dedupes findings against it (no double-count). When `<session>/anatomy-park.json` is absent, T10.7 emits a Low informational finding instead of failing.
- [ ] **AC-CIT-14** (T20 — refinement enforcement): Refinement on a fixture PRD whose AC is enumerated across ≥3 endpoints either produces one parametrized ticket OR halts with `exit 2`; `refinement_manifest.json` carries `ac_shape_smells` and per-ticket `justification?` fields; existing refinement runs without smells are unaffected.
- [ ] **AC-CIT-15** (T21 — anatomy-park replay): On the LOA-618 fixture, anatomy-park surfaces both `createUpdatedRun` (phase: discovery) and `retryChildExtraction` (phase: replay) as CRITICAL findings; every new trap door written to CLAUDE.md carries a `pattern_shape` field.
- [ ] **AC-CIT-16** (T22 — szechuan hygiene): szechuan-sauce on a diff that adds `notes.md` at repo root produces a P1 hygiene finding tagged `category: 'hygiene'`; the shared `diff-hygiene.ts` allowlist constants have unit-test coverage.
- [ ] **AC-CIT-17** (T23 — trap-door enforcement): szechuan-sauce on the LOA-618 fixture flags the S3-key trap door as un-enforced (P0) when the negative test is missing; citadel's T6 dedupes correctly when both fire on the same trap door.
- [ ] **AC-CIT-18** (T17 — refinement-time machinability + contract-resolution hard gate, folded from BMAD P0.2 / P0.5 / P0.12 / P0.7 / R33): refinement on a fixture PRD with a prose-only AC ("must be intuitive") halts with `exit 2`, suggests `gaps` analyst, writes `readiness_<date>.md`. Refinement on a fixture PRD with an unresolvable contract reference halts with `exit 2`, suggests `codebase` analyst. Cycle 4 halts with `readiness_escalation_<date>.md` (cap of 3 enforced). After `course_corrected` events bump `tickets_version`, T17 re-runs in DELTA mode on added/modified tickets only and emits `readiness_failed_post_correction` on regression. Gate runs in <10s on the 25-ticket manifest fixture.

## Out of Scope

- Auto-fixing findings. Surface only.
- Generating tests for unguarded trap doors (stub-printing only via `--print-stubs`; full generation is a future `/pickle-trap-door-test-gen` skill).
- Visual regression / pixel diffing of frontend.
- License / dependency audits.
- Security scanning beyond what `/security-review` already covers.
- Non-TypeScript repos. Heuristics assume NestJS-shaped backends + React frontends. Other stacks are future work.
- Non-Pickle PRDs. T1's parser is tuned for the Pickle PRD shape. Other markdown shapes may parse partially or not at all.

## Implementation Guidance

**Build path**: `extension/src/services/citadel/` (TypeScript). All new files. No reuse from `pickle-refine-prd`, anatomy-park, or szechuan-sauce — those are prompt skills, not callable libraries.

**Existing primitive to wrap**: `getDiffFiles(base, head, repoRoot)` from `extension/src/services/git-utils.ts:163`. Everything else is from scratch.

**Heuristic load-bearing**:
- AC IDs use letter-number patterns (`AC-FF-05`, `AC-DIFF-SUPP-01`); regex must support multi-segment dashes.
- Architectural decisions can be `A1` through `A99` plus dotted forms (`A11.`).
- Multi-paragraph PRD sections may bury an AC in prose; do not require a table.
- T3 and T6 have a recall ceiling without LLM assist. Document the limit; offer T11.5 as a paid upgrade.

**Performance budget**: 120 s wall-clock on a 22k-line diff. T2 diff-walker should cache the file list per session. T3-T6 grep passes should run in parallel where possible.

**Concurrency**: All session-state writes route through `state-manager.ts` locks. Do not write `citadel_report.json` outside that fence.

**Telemetry**: Per-heuristic timing + parse-error counts written to `<session>/citadel_telemetry.json`. Helps tune heuristics without re-running the whole audit.

## Dependency DAG

```
T0 ─┬─→ T13
    └─→ (everything else can read state)
T1 ─┬─→ T3, T5, T8, T11
    └─→ T15
T2 ─┬─→ T3, T4, T5, T6, T7, T8, T9, T10, T10.5, T10.7, T10.8, T10.9, T11
    └─→ T15
anatomy-park output (with T21 schema) ─→ T10.7 (pattern-replay safety-net; soft-skip if absent)
szechuan-sauce output (with T22 schema) ─→ T10.9 (dedupe; no-op if absent)
T1 + refinement manifest (with T20 schema) ─→ T11.7 (AC-shape safety-net for T20)
T3..T11.7 ─→ T12 ─→ T13
T11.5 (optional) ─→ T3, T6
T13 ─→ T13.5 (cronenberg routing) ─→ T14
T13 ─→ T16 (smoke test)
T14, T15 parallelizable with T1-T12

Cross-skill (parallelizable with the citadel core):
T20 (refine-prd) — schema bump + worker-prompt update + manifest enforcement
T21 (anatomy-park) — phase-2.5 prompt addition + schema bump (pattern_shape, phase, original_finding_id)
T22 (szechuan diff-hygiene) ─→ shares diff-hygiene.ts with T10.9
T23 (szechuan trap-door-as-test) ─→ depends on T21's pattern_shape field

Schema-coupled ordering: T21 must merge before T10.7 / T23 can rely on pattern_shape; T22 must merge before T10.9 dedupe assertion holds; T20 must merge before T11.7 escalation logic activates.
```

## How to Ship This

Use the standard pickle pipeline on this PRD. Refine first (`/pickle-refine-prd`), then build with `/pickle-tmux` (this is multi-file, multi-stage, multi-skill — interactive `/pickle` would underutilize). Backend / agent code in TypeScript; tests in `node --test`. Default backend is fine.

**Recommended ticket ordering** (after refinement decomposes into atomic tickets):
1. T0 (state schema) and T20–T22 (cross-skill schema bumps) **first** — every other task either reads or writes against these contracts. Skipping ahead means rework when the schemas change.
2. T1, T2, then T3–T11 in parallel.
3. T10.5, T10.7, T10.8, T10.9, T11.7 — depend on the schema bumps from step 1.
4. T23 — depends on T21's `pattern_shape`.
5. T12, T13, T13.5, T14, T15.
6. T16 smoke test runs against the **LOA-618 fixture diff**, not against this PRD's own diff (would be tautological).

**Cross-skill commit hygiene**: T20–T23 touch sibling skills' command prompts. Bump `extension/package.json` minor version (new commands + new schema fields = minor bump per CLAUDE.md). Run `bash install.sh` after editing `.claude/commands/*.md` so the deployed copies match source. The full release gate (`npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && npm test`) must pass.

— Pickle Rick out. *belch*

---

## Post-Validation Gaps (2026-04-30 agent-team pass)

Surfaced by a 4-parallel-agent validation pass against ~50 commits over the prior ~3 days. Functional core verified; these are the spec-level gaps still open at v1.62.1. Tracked here (not in MASTER_PLAN) because they belong with the PRD that defines them.

### Validation team verdicts

- **Agent A** — BMAD T04→T27 (state schema v3, phase personas, debate, calibration drift, course-correct ledger, txn ticket ops). Verdict: functional core ships; 12 PRD-spec gaps catalogued (see table below).
- **Agent B** — v1.62.x features (AC-SSV-05/07, AC-LPB-01..06,08). Verdict: all 9 ACs traced to impl + test, TS↔JS in sync.
- **Agent C** — schema-version-deploy-reversion F1-F4, archaeology, install symlink, project-type classifier, promotions. Verdict: all clean; no remaining hardcoded `/Users/` paths; archaeology dual-path confirmed.
- **Agent D** — MASTER_PLAN ↔ commits coherence, PRD status drift, test quality. Verdict: tests solid (3390 pass / 0 fail / 0 skipped).

### Residual gaps

| Gap | Severity | Notes |
|---|---|---|
| ~~`--skip-readiness <reason>` CLI flag (P0.6)~~ | ~~High~~ | **SHIPPED v1.63.0** as Agent A bundle, commit `deac6c5`. |
| `verify` step missing from `VALID_STEPS` in `src/types/index.ts:251` while present in `data/phase-personas.json` | High | `morty-phase-verifier` works under teams-mode (skill orchestrator) but is dead under subprocess path (`spawn-morty.ts` reads `state.step`); decide: add `verify` to lifecycle or rename the persona |
| Slash-command files missing: `pickle-readiness.md`, `pickle-archaeology.md`, `pickle-correct-course.md` | High | Referenced in `prds/citadel.md:966-968`; only `pickle-debate.md` shipped. Bin scripts work via `node bin/<x>.js`; UX gap only |
| `correct-course.ts` proposal validator does not assert `artifact_diffs` and `confidence_metadata` artifact prefixes (P3.4) | Medium | Currently checks 3 of 5 mandated sections |
| `--repo-root` not repeatable (P0.11) | Medium | Multi-repo workspaces only get one repo's readiness output |
| `complexity_tier_default` field in `phase-personas.json` not consumed by source | Medium | Schema-only; tier→model precedence rule from P2.5 not enforced |
| Filename drift: code writes `readiness_<date>.md`; PRD says `readiness_escalation_<date>.md` (P0.5) | Low | Either rename code or PRD |
| AC-SSV-04 (NEW-T2 lowered), AC-SSV-06 (actionable schema-mismatch error) not verifiably shipped | Low | `tests/integration/state-schema-version-rollback.test.js` referenced but doesn't exist |
| Behavioral phase-personas baseline test triplet missing (`tests/behavioral/phase-personas/{harness,quality-vs-baseline,baseline.json}`) | Medium | `R23` mitigation requires baseline-before-flip; CI cannot enforce yet |
| Integration tests missing: `phase-persona-dispatch`, `archaeology-injection`, `readiness-gate` | Medium | Unit coverage exists; end-to-end coverage does not |
| Pre-existing `pickle_settings.json` deploy drift (`default_max_iterations` 500 vs 100, `default_tmux_max_turns` 200 vs 400) | Low | `install.sh` is partially-leaky for `pickle_settings.json` — additive-only on this file |
| Cosmetic: AC-LPB-06 PRD says `⚠️ EXCEEDED`; code emits plain `EXCEEDED` | Low | Tests assert the token, not the glyph |

### Fixed in the validation pass itself (2026-04-30)

- 6 emitted-but-unenumerated activity events added to `VALID_ACTIVITY_EVENTS`: `course_corrected`, `course_correct_apply_failed`, `course_correct_recovered`, `current_ticket_redirected_to_new`, `readiness_delta_requested`, `halt`. Regression test in `tests/types-gate-events.test.js`. Enum length 52 → 58.

---

## Appendix → split out

The BMAD-inspired hardening appendix (P0.N / P1.N / P2.N / P3.N / P4.N ACs, R## risk register, T0## task list — ~454 lines) was extracted to `prds/archive/features/citadel-appendix-bmad-reference.md` on 2026-05-01 to keep this PRD lean for coding-agent context. AC IDs there are still authoritative for the appendix scope and do not collide with `AC-CIT-NN` here.

T04-T27 from that appendix SHIPPED via the v1.62.x BMAD wave (see `## Post-Validation Gaps` above for residual spec gaps).

---
