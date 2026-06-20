# PRD: Anatomy-Park + Szechuan-Sauce Miss Constraint/Tenant/PII Defects in Monorepo Targets (Missed-Detection Gap)

**Status**: Bug PRD (2026-05-05) — quality-gate gap. Reviewers and the post-pipeline cleanup phases failed to surface a production-blocker DB constraint mismatch, three tenant-isolation gaps, and a Redis PII leak. All six findings were inside their declared scope.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**: `anatomy-park-judge-unreachable-on-worker-convergence.md` (slot 1r+1s) — that PRD makes the judge resilient. This PRD makes the **scan** resilient. Both are needed for the post-pipeline review to be trustworthy.
**Triggering session**: `/pickle-pipeline` `pipeline-2026-05-04-8aecd4c7` followed by `/szechuan-sauce` `2026-05-05-af779f40` over `loanlight-api-income-expansion` (monorepo: `packages/api`, `packages/app`, `packages/shared`). Final 3-agent adversarial review immediately afterwards surfaced 1 BLOCKER + 3 MAJOR + 2 MINOR defects that should have been caught by anatomy-park or szechuan-sauce.

---

## What was missed

| # | Defect | Severity | Should have been caught by | Why it slipped |
|---|--------|----------|---------------------------|----------------|
| 1 | `key_field_catalog`/`key_field_reviews` `agent_check` constraints don't include `'income'`; `INCOME_CATALOG_FIELDS` rows never seeded → income review feature throws PostgreSQL `check_violation` on first call | **BLOCKER** (feature non-functional in prod) | Szechuan **Override 6** (Migration Hygiene → CHECK Constraint Drift, P1) | Override 6 trigger checks `db/migrations/meta/_journal.json` **relative to target root**. Target was the monorepo root; journal lives at `packages/api/db/migrations/meta/_journal.json`. Override 6 was silently **skipped** |
| 2 | `correctedValues` (borrower-corrected income figures, employer names, W-2 box values) written into BullMQ job payload → persisted in Redis indefinitely | MAJOR (PII leak / compliance) | Anatomy-park data-flow trace; Szechuan principles "data hygiene" | Anatomy-park's subsystem discovery flattened the monorepo to one subsystem (`packages`) and never traced producer→consumer across `service.ts → queue.add → Redis` |
| 3 | `markFailed` UPDATE on `incomeRuns` lacks `lenderId` predicate | MAJOR (defense-in-depth gap) | Anatomy-park "tenant scope on UPDATE" (the prior round caught the same class on `requeueIfClear`) | Worker fixed only the one cited site (`requeueIfClear`); never grepped `.update(incomeRuns)` for sibling missing-predicate sites |
| 4 | `completeRun` UPDATE on `incomeRuns` lacks `lenderId` predicate | MAJOR (same as #3) | Same as #3 | Same as #3 |
| 5 | `queue.add("recalc")` inside `db.transaction` claims false atomicity (Postgres↔Redis coordination gap) | MAJOR (misleading invariant) | Anatomy-park architectural review | Worker added the transaction wrapping per M6 of the fix PRD without re-reading the comment |
| 6 | `requeueIfClear` uses `ne(status, "approved_as_extracted")` instead of `eq(status, "corrected")` | MINOR (latent — pendingCount=0 saves it today) | Szechuan principle "Defensive Explicit Predicates" | Worker accepted Override 2 contract-map view as authoritative without re-checking each `where()` clause for explicit equality |
| 7 | Empty `packages/api/drizzle/meta/_journal.json` stub from a prior misconfigured `out` path | MINOR (foot-gun) | Szechuan **Override 4** (root scratch artifacts) | Override 4's allowlist references project root; this is a legitimate-looking subdirectory artifact that the trigger doesn't classify |

**Six of seven defects were in declared scope of one or both review phases.** The bundle of misses indicates a systemic gap, not seven independent miss events.

---

## Root causes (composed)

### RC-1: Override 6 path resolution is monorepo-blind

Source (in `extension/.claude/commands/szechuan-sauce.md` line 344):

> Before the first scoring pass, check if the target directory contains a Drizzle migration journal at `db/migrations/meta/_journal.json` (relative to target root). If it does NOT exist, skip this override entirely.

In a pnpm workspace monorepo the journal lives at `packages/<pkg>/db/migrations/meta/_journal.json`. The check is too literal. Effect: Override 6 — the override **specifically designed** to catch CHECK-constraint-vs-TS-enum drift — silently skipped on every monorepo target.

The principles file has the same single-path assumption (line 199 in `szechuan-sauce-principles.md`).

### RC-2: Anatomy-park subsystem discovery flattens monorepos

The runner's `pipeline-runner.js:Subsystem Discovery` mirrored anatomy-park.md Step 3. It excluded test-only directories but did not descend into `packages/*/src/modules/*`. The session log confirms:

```
[02:02:15] Discovered 1 subsystems: packages
```

A subsystem-as-`packages` review can't catch single-module data flow leaks. The two PII / tenant-isolation defects (#2, #3, #4) live inside one module — `portal-income/` — and require module-level subsystem partitioning to surface.

### RC-3: Worker self-report is authoritative when judge is unavailable (covers half of slot 1s)

When `measureLlmMetric` times out (slot 1s), the runner converges on the worker's TASK_NOTES.md. The worker's self-report ("no actionable violations remain") is the only signal. There is no second-pass review against the diff that would re-grep for sibling sites of cited fixes (defects #3 and #4 are exactly this pattern: worker fixed one cited site, missed the rest of the class).

### RC-4: No "fix-class regression" check between iterations

When iteration N fixes a violation in class X (e.g. "missing lenderId on UPDATE"), iteration N+1 should re-grep the codebase for OTHER instances of class X before declaring convergence. Today the loop only re-checks the candidate against the static principles list. The pattern "fixed one, missed the other two siblings" is what produced defects #3 and #4.

---

## Fix

Three changes in the deployed extension. Each is independently shippable.

### F1 — Override 6 monorepo-aware glob (resolves miss #1)

Source: `extension/.claude/commands/szechuan-sauce.md` line 344 + `extension/szechuan-sauce-principles.md` line 199.

Replace the literal path check with a glob:

```ts
// Pseudo: Override 6 trigger
const journalPaths = await glob([
  `${target}/db/migrations/meta/_journal.json`,
  `${target}/packages/*/db/migrations/meta/_journal.json`,
  `${target}/apps/*/db/migrations/meta/_journal.json`,
  `${target}/services/*/db/migrations/meta/_journal.json`,
]);
if (journalPaths.length === 0) skipOverride6();
else applyMigrationHygieneTo(journalPaths);
```

Override 6 then iterates each discovered journal — the CHECK-constraint-vs-TS-enum diff is run per-journal, not once per target.

### F2 — Subsystem discovery descends into monorepo packages (resolves misses #2, #3, #4, #5)

Source: `extension/bin/pipeline-runner.js:141-200` (Subsystem Discovery).

When the target contains a `packages/`, `apps/`, or `services/` directory with workspace metadata (`pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `package.json`'s `workspaces` field), descend one level and treat each member's `src/modules/*` as the subsystem unit. Fall back to today's flat behavior when no workspace metadata is present.

Acceptance: a target containing `packages/api/src/modules/portal-income/` produces a subsystem named `packages/api/portal-income`, not `packages`.

### F3 — Add a "fix-class regression" pass to anatomy-park + szechuan-sauce (resolves miss #3, #4)

Source: `extension/.claude/commands/anatomy-park.md` Phase 2 + `szechuan-sauce.md` Override 2 (Contract Discovery).

After fixing a violation, the worker MUST grep the codebase for OTHER instances of the same fix class before exiting the iteration. Concretely:

1. The fix-PRD ticket entry already encodes the fix class (e.g. "M3 — `awaitClassifications` fails the run when `loanId` is null"). Read it.
2. Extract the fix predicate (e.g. "missing `lenderId` predicate on UPDATE incomeRuns").
3. Grep the codebase for other call sites that match the predicate but lack the fix.
4. Report any matches as additional candidates for the next iteration.

This is not optional — make it a required step in the iteration template.

### F4 — Constraint/code drift as a first-class trap-door category (resolves miss #1 even when Override 6 is off)

Add a permanent trap-door category `constraint_code_drift` enforced regardless of override activation. The check:

For each TypeScript file matching `**/catalogs/*.ts`, `**/seeds/*.ts`, or files exporting a constant array of literal objects with an `agent`/`type`/`status` discriminator field:

1. Extract the discriminator values (e.g. `agent: "income"`).
2. Find any matching SQL `CHECK (col IN ('a', 'b', ...))` constraint on a table whose schema TS file also references the discriminator.
3. Flag as P0 if any TS value is missing from the SQL CHECK list.

The check is cheap (O(catalog files × constraint files)), runs in both anatomy-park and szechuan-sauce, and would have caught defect #1 in 30 seconds. Today nothing checks this.

---

## Acceptance Criteria (machine-checkable)

| ID | Criterion | Verify |
|----|-----------|--------|
| AC1 | Override 6 detects journals at `packages/*/db/migrations/meta/_journal.json`, `apps/*/...`, `services/*/...` | unit spec `Override 6 monorepo journal globbing` covers the 3 patterns + the legacy root-level path |
| AC2 | A target with no journal anywhere still skips Override 6 cleanly | unit spec `Override 6 absent journal still skips` passes |
| AC3 | `pipeline-runner.js:discoverSubsystems` returns `packages/api/portal-income` (not `packages`) for a pnpm workspace target with `packages/api/src/modules/portal-income/` | unit spec `discoverSubsystems descends into pnpm workspaces` passes |
| AC4 | A non-workspace target preserves the legacy flat subsystem discovery | unit spec `discoverSubsystems flat-mode regression` passes |
| AC5 | Anatomy-park / szechuan-sauce iteration template includes a "sibling-of-fix" grep pass | string match in the deployed `anatomy-park.md` + `szechuan-sauce.md` for the literal phrase `sibling-of-fix grep` |
| AC6 | New trap-door category `constraint_code_drift` runs in both phases regardless of override flags | unit spec `constraint_code_drift detects agent column missing income value` reproduces miss #1 against a fixture mirroring `0086_create_key_field_catalog.sql` + `INCOME_CATALOG_FIELDS` |
| AC7 | Replay of session `2026-05-05-af779f40` against the new code produces ≥6 of the 7 missed defects in the iteration's candidate list | integration spec replays the worktree fixture and asserts `gap_analysis.md` flags the 6 in-scope defects (the 7th — empty drizzle stub — is acknowledged as Override 4 wishlist) |
| AC8 | Override 6's `Schema Drift` check runs against the right schema TS path in monorepos | spec asserts the schema diff compares `packages/api/src/database/schema/*.ts` against `packages/api/db/migrations/*.sql`, not the (nonexistent) `db/schema/*.ts` |

---

## Trap doors / known traps

1. **Glob breadth.** The monorepo glob in F1 covers 3 conventions (`packages/`, `apps/`, `services/`). A repo using `libs/` or `modules/` or `crates/` would still skip Override 6. Document in the PRD that ad-hoc layouts can opt in via a `pickle.config.json` glob list. Don't try to enumerate every monorepo convention.
2. **Subsystem name uniqueness.** F2 produces deeper paths as subsystem names. Anatomy-park's `subsystems[<name>].pass_counts` is keyed by name. Migrating an existing session from flat `packages` to nested `packages/api/portal-income` requires a key-rename; for now, ship F2 only on fresh sessions.
3. **Sibling-of-fix grep cost.** F3 re-greps the codebase on every iteration. Cache the predicate map at session start and incrementally re-grep only on diff lines — don't re-grep the whole tree every time.
4. **Override-6 / trap-door overlap.** F4's `constraint_code_drift` overlaps with Override 6 check #1. Make F4 the authoritative source; Override 6 check #1 then becomes a thin wrapper that delegates to F4's results. No double-counting.
5. **Worker prompt updates.** F3's iteration template change (`anatomy-park.md`, `szechuan-sauce.md`) means the deployed prompt files diverge from source. Run `bash install.sh` post-merge or the change won't reach live workers. Document in the AC.

---

## Verification commands (post-fix)

```bash
cd /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
npm test -- tests/szechuan-sauce.test.js
npm test -- tests/pipeline-runner-anatomy-park.test.js
npm test -- tests/services/citadel/   # if F4 adds a citadel-runner integration
bash install.sh
# Replay-style integration test:
RUN_EXPENSIVE_TESTS=1 npm test -- tests/integration/anatomy-park-monorepo-replay.test.js
```

---

## Out of scope

- Replacing pnpm workspaces with a different monorepo tool. The fix targets discovery, not the underlying layout.
- Auto-fixing the constraint_code_drift findings (the worker will fix them as P0 candidates; no auto-edit).
- Backporting to existing live sessions — fix-forward via `bash install.sh`. Existing sessions retain flat subsystem discovery until they exit.
- Drizzle-side migration generation — Drizzle-kit will emit constraint changes from schema TS, but only if schema TS encodes the `CHECK` constraint via `pgEnum` or `pgCheck`. This PRD only catches the drift; the schema-side fix is a separate hardening step.

---

## Related

- `anatomy-park-judge-unreachable-on-worker-convergence.md` (slot 1r+1s) — the judge layer being brittle composes with this gap. Slot 1s makes the judge stop falsely-converging; this PRD makes the scan that feeds the judge actually look in the right places.
- `anatomy-park-finalizer-history-crash.md` (shipped v1.63.0) — same file class, different defect.
- Skeptic / architect / implementer 3-agent review reports from the 2026-05-05 final review on `feat/income-expansion` — these surfaced the seven misses and constitute the validation fixture for AC7.
