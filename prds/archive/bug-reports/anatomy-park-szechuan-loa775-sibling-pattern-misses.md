# PRD: Anatomy-Park + Szechuan-Sauce Miss Sibling Patterns in Same-File Refactors (LOA-775 evidence)

**Status**: Bug PRD (2026-05-15) — quality-gate gap. Szechuan-sauce ran three times on the LOA-775 branch in the days before code review, refactoring the exact files where Jorge's review later found 12 issues. ~8 of those 12 were inside szechuan-sauce or anatomy-park's declared lens; multiple instances live in the same function szechuan was actively touching.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Supplement to**: `anatomy-park-szechuan-monorepo-missed-detection-gap.md` (entry #13 in `MASTER_PLAN.md`; P2 Follow-up bundle; F1 shipped via `55ef850e`, F2/F3/F4 unshipped). That PRD documents a 6-defect miss across PII/tenant/CHECK-constraint classes; this PRD adds **same-file-refactor-leaves-siblings-untouched** as a new failure mode with concrete repro evidence.
**Triggering session**: LOA-775 branch `gregory/loa-775-rule-engine-implement-phase-2-compound-conditions-all-any` in `loanlight-api`. Szechuan-sauce ran three iterations before review (`9808490f1`, `36e1e1d58`, `5080dbc49`). Jorge's PR review of #1356 (2026-05-15) found 12 issues fixed in commit `dad65b94f`.

---

## What was missed

Eight of the twelve PR review findings were inside one of the two phases' declared lenses. Six are cases szechuan-sauce ran on, in commits that *literally edited the same file or even the same function*.

| # | Defect | Severity | Should have been caught by | Why it slipped |
|---|--------|----------|---------------------------|----------------|
| 1 | `appraisal_custom_rules_operator_check` Drizzle schema missing `abs_less_than` / `abs_less_than_or_equal` — direct sibling of `appraisal_rules_operator_check` whose trap-door is already pinned in `packages/api/src/database/schema/CLAUDE.md` | **HIGH** | Anatomy-park — sibling-table application of an already-cataloged trap-door | `appraisal-rules.ts` carries a `PATTERN_SHAPE: operator CHECK string missing a value already added by migration SQL/runtime union` invariant. The sibling table `appraisal_custom_rules.ts` lives in the same directory. Anatomy-park's prior pass produced the trap-door for one table and never grepped neighbors |
| 2 | `evaluateBranching` (`compound-walker.ts:447`) collapses `any` on SKIPPED — `if (result.outcome === "SKIPPED") return result;` aborts iteration. `any{skipped, pass}` returns SKIPPED instead of PASS. Mirrored bug for `all` | **CRITICAL** (incorrect rule outcomes) | (Beyond either tool's current lens — outcome-matrix property test needed) | Neither tool currently runs `{PASS, FAIL, SKIPPED, NEEDS_INFO}^N` permutation tests against branching dispatch helpers. The existing `AGGREGATION_MATRIX` test omits `(skipped, pass)` combinations. **Acknowledged honest gap, not a regression** |
| 3 | `CONDITION_ERROR_CODES` missing `days_must_be_positive_integer` / `days_exceeds_maximum` — emitted by `predicate-thresholds.validator.ts:40,43`, but absent from the typed registry. CLAUDE.md trap-door at `predicate-thresholds.validator` says *"every `ThresholdsErrorCode` emitted here must stay mirrored in `packages/app/src/lib/api-types.ts::CONDITION_ERROR_CODES`"* — but the invariant is **prose only, never enforced in code** | HIGH | Anatomy-park — prose invariants must convert to canaries | Anatomy-park's job (per `anatomy-park.md`) is *"trace data flows, fix without regression, **catalog** trap doors"*. It cataloged the prose. There's no follow-up step that says *"for every PATTERN_SHAPE / INVARIANT in CLAUDE.md, verify there exists an executable test that fires when the invariant is violated."* Cross-package mirror enforcement is a one-script fix |
| 4 | `ABS_OPERATOR_NON_NEGATIVE_EXPECTED_VALUE_MESSAGE` is a free-text English string smuggled into a typed `ConditionValidationFailure` union (`compound-condition.validator.ts:38-40`) — return value forwarded as `code:` to the wire, FE's `mapConditionErrorCode` can't match it, user sees raw English | HIGH | Szechuan-sauce — Fail-Fast principle on typed-code registries | `36e1e1d58 szechuan-sauce: Fail-Fast — preserve structured rule API errors` ran on this exact theme in the days before review. It found and fixed *some* free-text-as-code violations but missed this one in the same file. No lens for *"if `ConditionErrorCode` is a typed registry, no union should contain `typeof <some_string_const>` next to it"* |
| 5 | HTTP exception filter switched from allowlist to denylist (`http-exception.filter.ts:58-65, 79`) — `extraFields` spreads every key except 4 blacklisted; future `{ detail, query: drizzleQuery.toSQL().sql }` leaks SQL to wire | WARNING (forward-compat) | (Beyond either tool's current lens — principle-of-least-authority isn't a hardcoded check) | Acknowledged honest gap. Could be added as a szechuan trap-door category *"denylist forwarding from untrusted boundary"* but isn't today |
| 6 | Stale `0124` migration references after rename to `0131` — header SQL comment + 5 spec constants | MINOR (audit-trail hygiene) | (Beyond either tool's current lens — grep-while-touching) | Honest gap. Could plausibly be a szechuan "rename-coherence" pass on every commit that renames a file or constant |
| 7 | `assertSequenceEqual` enforces order on Sets (`scripts/check-rule-frontend-sync.ts:103-119, 162`) — `OPERATORS_REQUIRING_EXPECTED_VALUE` extracted from a `new Set(...)` literal, compared index-by-index. The FE mirror test already uses `diffMembers` (set semantics); the script should match | HIGH | Szechuan-sauce — data-structure-↔-algorithm alignment | Clear principle miss. Set + index-comparison is a textbook smell |
| 8 | Signed-zero (`-0`) slips both abs guards (`condition-schema.ts:430`, `compound-walker.ts:880`) — `numericValue < 0` is false for `-0`; `Math.abs(field) < -0` always-fails silently | MEDIUM (edge case) | (Beyond either tool's current lens — explicit edge-case sweep needed) | Honest gap. Signed-zero / NaN / ±Infinity / `MAX_SAFE_INTEGER` aren't part of the standard szechuan sweep |
| 9 | Three-level nested ternary in `evaluateEmptyEach` (`compound-walker.ts:545-555`). **CLAUDE.md explicitly bans nested ternaries** | LOW (style) | **Szechuan-sauce — CLAUDE.md-banned-pattern enforcement** | `9808490f1 szechuan-sauce: DRY — unify operator expected-value validation` touched this same file three commits before review. CLAUDE.md says *"banned"* and szechuan didn't grep |
| 10 | Duplicate `days <= 0` guard in `compound-condition.validator.ts:135-137` vs `:152-158`. The 135 copy is dead code on every production call path — `checkPredicateNode` (`:152-158`) always fires first via the chain at `:200` | LOW (DRY) | Szechuan-sauce — DRY + dead-code | DRY is szechuan's headline principle. Two guards with identical bodies, one unreachable. Clear miss |
| 11 | `ExpectedValue` decorator `validate` and `defaultMessage` diverge (`add-custom-rule.dto.ts:55-134`) — five operator-family checks in `validate`, re-implemented in `defaultMessage` with different ordering. Adding a 6th means editing two divergent chains with zero compiler check | HIGH (DRY + maintainability) | **Szechuan-sauce — same-function-sibling DRY** | `9808490f1 szechuan-sauce: DRY — unify operator expected-value validation` **literally touched this exact decorator** and missed the internal `validate↔defaultMessage` divergence in the same function. This is the clearest single failure mode in the bunch |
| 12 | Dead `known` array defensive check in `nl-parse.service.ts:175-176` — runs immediately before `walkConditionNode`'s exhaustive discriminated switch. The only real null case is covered by the line above | LOW (dead code) | Szechuan-sauce — dead-code | `walkConditionNode` is exhaustive by construction. Defensive check is unreachable. Standard szechuan miss |

**Score**: 8/12 fall inside one of the two phases' declared lenses, 6 of those 8 were in files szechuan-sauce had just refactored. 4/12 are honest gaps (#2, #5, #6, #8) requiring new lenses.

---

## Root causes (composed)

### RC-1: Szechuan-sauce doesn't apply CLAUDE.md-banned patterns as a grep pass

The repo's `packages/api/CLAUDE.md` declares *"banned"* lists (nested ternaries, `unknown + String()`, `as Type` when TS infers, etc.). Szechuan-sauce treats CLAUDE.md as background context for its model, not as a literal grep input. Effect: an explicit ban from the project's own house rules ships into commits the very phase reviewing for quality just touched.

**Source surface**: `extension/.claude/commands/szechuan-sauce.md` Override-X (no current override for `CLAUDE.md`-grep). Likely add as Override-7 alongside Override-6 (migration hygiene).

### RC-2: Szechuan refactors a function's outer signature but doesn't re-read the function body for sibling-shape violations

Defect #11 is the canonical example: the previous szechuan commit's title is literally *"DRY — unify operator expected-value validation."* It unified the *outer* operator-family validators but missed the *inner* `validate ↔ defaultMessage` divergence within the very same decorator. The fix lens runs against a *target* (an inconsistency the model identified) and stops; it doesn't iterate the same function for siblings of the just-fixed shape.

Same mechanism explains defect #4 (free-text-in-typed-union — `36e1e1d58 Fail-Fast — preserve structured rule API errors` fixed *some* free-text-as-code violations and stopped).

### RC-3: Anatomy-park catalogs prose invariants but never converts them to canaries

`predicate-thresholds.validator` CLAUDE.md trap-door declares *"every ThresholdsErrorCode must stay mirrored in `condition-error-copy.ts`"*. Defect #3 ships because that mirror **isn't enforced in code, only prose**. Anatomy-park's job is to *"catalog trap doors"*; nothing in its phase loop converts a `INVARIANT: X` line into a regression test or a runtime check.

Same RC as #1 in the predecessor PRD (RC-1 there: prose-only mirror invariants slip).

### RC-4: Anatomy-park doesn't re-apply a fix-pattern to sibling subjects

Defect #1 — the `appraisal_rules_operator_check` trap-door is pinned. Its sibling table `appraisal_custom_rules` lives next to it in the same directory and has the same operator CHECK shape. Anatomy-park's prior pass cataloged the invariant on one table and never asked *"are there other tables in this folder that should be subject to the same invariant?"*

This is a different failure mode from the predecessor PRD's RC-2 (subsystem-flatten). RC-4 here is sibling-of-subject discovery; RC-2 there is subsystem-of-target discovery. Both contribute to the same observed bug class.

---

## Fix

Four changes in the deployed extension. F1 / F2 are szechuan-sauce; F3 / F4 are anatomy-park. Each is independently shippable.

### F1 — Szechuan Override-7: CLAUDE.md banned-pattern grep (resolves #9)

Source: `extension/.claude/commands/szechuan-sauce.md` (new override) + `extension/szechuan-sauce-principles.md`.

Before the first scoring pass:

1. Walk all `CLAUDE.md` files under `target/`.
2. Extract any line matching `(banned|forbidden|never|do not|NEVER|MUST NOT)` + a code-shape pattern (nested ternary, `as Type` assertion, etc.).
3. For each extracted pattern, derive a regex (curated mapping for known patterns; literal-string fallback otherwise) and grep the diff range for matches.
4. Each match → P1 violation in the next iteration's candidate list.

Curated initial mapping (loanlight-api `CLAUDE.md` examples):
- *"banned"* + *"nested ternar"* → `\?[^?]*\?[^?]*\?` (three `?` on one logical line)
- *"`unknown` + `String()`"* → `String\(.*?\bas unknown\b`
- *"Never `as Type` when TS infers"* → `\bas\s+[A-Z]\w+\s*[;)\]]` (heuristic; high false-positive — flag for review, not auto-fix)

Effect: defect #9 (nested ternary) flagged on iter 1 before any cleanup pass touches the file.

### F2 — Szechuan sibling-shape sweep (resolves #4, #7, #10, #11, #12)

Source: `extension/.claude/commands/szechuan-sauce.md` Phase 2 (iteration template) + `extension/bin/pipeline-runner.js` Subsystem loop.

After each fix worker commits an iteration, before exiting:

1. Read the diff of the just-committed iteration.
2. Extract a *pattern descriptor* from each `+` line — operator/shape/structure of the fix.
3. Re-grep the **same function and same file** for other lines matching the pattern descriptor.
4. Any match that wasn't part of the diff → carried into the next iteration as a candidate.

Concretely, the descriptor mining covers:
- **Free-text-in-typed-union**: in a TS union like `T | typeof CONST`, where `CONST: string`, flag every `typeof <string-constant>` member.
- **Dead-after-fix**: a removed guard that had identical body to another extant guard in the same function → flag the extant copy too if it's unreachable on the production call path (use a simple control-flow walk).
- **Order-sensitive comparison on Set**: in any file extracted from `new Set(...)`, flag `===` / `assertSequenceEqual` / index-by-index walks.
- **Validate↔message decorator divergence**: in a `registerDecorator({ validate, defaultMessage })` block, flag when `validate` and `defaultMessage` reference the same DTO properties but their control flow shapes differ.

This is RC-2's "siblings-in-the-same-function" lens; it's narrower than the predecessor PRD's F3 (fix-class regression grep across the codebase) which targeted siblings-across-files.

### F3 — Anatomy-park "prose-to-canary" sweep (resolves #3)

Source: `extension/.claude/commands/anatomy-park.md` (new phase, between Catalog and Iterate).

After the Catalog phase produces trap-door entries / CLAUDE.md updates:

1. For each `INVARIANT: <X>` / `PATTERN_SHAPE: <Y>` line in any `CLAUDE.md` modified during the pass, check whether there exists a test file referencing the invariant's enforcement surface.
   - For *"every X must be mirrored in Y"* shape: check whether there's a test that diffs `X` and `Y`.
   - For *"hard-fail rule X must not duplicate field Y in `requiredFields`"* shape: check whether there's a regression test that confirms the duplication-detection.
2. If no test exists, emit a P1 finding *"prose-only invariant"* with a suggested canary stub.
3. Carry the stubs forward as candidates in the next iteration.

This is cheap (text matching), runs once per pass, and converts the largest existing class of trap-doors (prose-only) into actionable test work.

### F4 — Anatomy-park sibling-of-subject sweep (resolves #1)

Source: `extension/.claude/commands/anatomy-park.md` Phase 2 + `pipeline-runner.js` subsystem-discovery.

When anatomy-park applies a fix or pins a trap-door against a *single* subject (a table, a route, a module, a rule), generate sibling candidates and check the invariant against them:

1. From the subject's file path, extract directory neighbors (`packages/api/src/database/schema/*.ts` for a schema fix).
2. From the subject's exported symbols, extract sibling discriminators (table names, rule codes, route prefixes).
3. For each sibling, re-apply the invariant check (same pattern grep, same shape diff).
4. Mismatches → candidates for next iteration.

Concretely, defect #1 falls out: `appraisal_rules_operator_check` invariant + sibling discovery of `appraisal_custom_rules_operator_check` in the same directory + the same pattern grep → mismatch flagged.

This is the structural complement of F2 (siblings within one function) at a coarser granularity (siblings within one directory / subsystem).

---

## Acceptance Criteria (machine-checkable)

| ID | Criterion | Verify |
|----|-----------|--------|
| AC1 | Szechuan Override-7 detects `nested ternary` and flags as P1 when present in the diff range, regardless of which file | unit spec `Override-7 banned-pattern grep > nested ternary fixture flagged P1` |
| AC2 | Override-7 silent when CLAUDE.md absent or contains no banned patterns | unit spec `Override-7 no-CLAUDE.md fixture skips cleanly` |
| AC3 | Szechuan sibling-shape sweep flags `typeof STRING_CONST` members of a typed union after a same-file fix that removed one such member | integration spec replays a synthetic 3-commit branch (initial → szechuan iter 1 fixes one member → assert sibling-shape sweep flags the remaining member) |
| AC4 | Sibling-shape sweep flags duplicate-body guards in the same function when the unreachable copy is detectable via simple control-flow walk | unit spec `sibling-shape sweep > dead guard after dedup` |
| AC5 | Anatomy-park prose-to-canary sweep emits a finding for every `INVARIANT:` / `PATTERN_SHAPE:` line in modified CLAUDE.md that lacks a paired test reference | unit spec `prose-to-canary > mirror invariant without canary flagged` against a fixture mirroring `predicate-thresholds.validator` CLAUDE.md |
| AC6 | Anatomy-park sibling-of-subject sweep flags `appraisal_custom_rules_operator_check` mismatch when invariant exists on `appraisal_rules_operator_check` | integration spec replays a synthetic fixture mirroring the LOA-775 evidence and asserts the sibling is flagged in candidate list |
| AC7 | Replay of the LOA-775 final szechuan iteration against the new code flags ≥5 of {#4, #7, #9, #10, #11, #12} in the iteration's candidate list | integration spec under `tests/integration/szechuan-loa775-replay.test.js` |
| AC8 | Replay of the most recent anatomy-park pass that touched `appraisal-rules.ts` flags `appraisal_custom_rules_operator_check` as a sibling candidate | integration spec under `tests/integration/anatomy-park-loa775-replay.test.js` |

---

## Trap doors / known traps

1. **F1 banned-pattern regex breadth.** `nested ternary` is easy; *"Never `as Type` when TS infers"* is hard (depends on inference). Ship F1 with the curated mapping; treat heuristic patterns as `severity: review` not `severity: P1` so the worker doesn't waste an iteration on false positives. Document the heuristic list in the override prompt.
2. **F2 control-flow walk depth.** The unreachable-guard detection in `sibling-shape sweep > dead guard after dedup` (AC4) requires a tiny CFG walker. Don't roll a real one — match the limited shape *"function A() returns based on guard, function B() (called by A) repeats the same guard"*. Document the shape limitation in the override prompt.
3. **F3 prose-to-canary false-positive rate.** Many CLAUDE.md invariants are *informational* (*"do NOT swap getters back even for readability"*) not *testable* (*"every X must equal Y"*). The text matcher must distinguish — start with a curated list of testable shapes (`every X must be mirrored in Y`, `requiredFields may not duplicate Z`, `X must use Y, not Z`); silently skip informational ones. Iterate the curated list as misses surface.
4. **F4 sibling-of-subject explosion.** Directory-sibling discovery for `routes/`, `schemas/`, `definitions/` can produce dozens of candidates. Cap at 10 per iteration; rank by name-similarity to the subject (Levenshtein) and apply the invariant only to the top 10. Document the cap.
5. **Source vs deployed drift.** F1-F4 prompts live in `extension/.claude/commands/*.md` source; `install.sh` deploys to `~/.claude/pickle-rick/`. Existing deployed installs won't pick up the new overrides until `bash install.sh` runs. Document in AC verification commands.
6. **Overlap with predecessor PRD.** F2 (sibling-shape sweep within function) and F4 (sibling-of-subject across directory) compose with the predecessor's F3 (fix-class regression grep across codebase) and F4 (`constraint_code_drift` category). Three lenses, three granularities. No double-fire — flagged sites dedupe by `{file, line_range, pattern_id}`.

---

## Verification commands (post-fix)

```bash
cd /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
npm test -- tests/szechuan-sauce-override-7.test.js
npm test -- tests/szechuan-sibling-shape-sweep.test.js
npm test -- tests/anatomy-park-prose-to-canary.test.js
npm test -- tests/anatomy-park-sibling-of-subject.test.js
bash install.sh
RUN_EXPENSIVE_TESTS=1 npm test -- tests/integration/szechuan-loa775-replay.test.js
RUN_EXPENSIVE_TESTS=1 npm test -- tests/integration/anatomy-park-loa775-replay.test.js
```

---

## Out of scope

- Outcome-matrix property testing for branching dispatch helpers (defect #2). Useful but a separate lens; file as a successor PRD if it bites again.
- Principle-of-least-authority allowlist enforcement on response-body forwarding (defect #5). Useful but a separate lens.
- Rename-coherence grep across the codebase (defect #6). Useful but cheap to handle ad-hoc.
- Signed-zero / NaN / ±Infinity edge-case sweeps (defect #8). Useful but a separate lens.
- Auto-fixing flagged candidates. The worker continues to author fixes; F1-F4 only contribute to the candidate set.
- Backporting to existing live sessions — fix-forward via `bash install.sh`. Existing sessions keep current behavior until they exit.

---

## Related

- `anatomy-park-szechuan-monorepo-missed-detection-gap.md` (entry #13 in `MASTER_PLAN.md`) — the predecessor PRD; F1 (monorepo journal globbing) shipped; F2 / F3 / F4 unshipped. This PRD's F2 and F4 share descriptor-mining utilities with that PRD's F3 — implement once, consume from both phases.
- LOA-775 PR #1356 in `loanlight-api` — reviewed 2026-05-15 by Jorge (`jcapona`); 12 findings; fixes shipped in `dad65b94f` + merge `bb0211506` + chore `24cd96cc9`. Comment on the PR catalogs the per-finding root-cause attribution between principle misses and honest gaps; serves as the validation fixture for AC7 and AC8.
- `packages/api/CLAUDE.md` and `packages/api/src/database/schema/CLAUDE.md` and `packages/api/src/lib/appraisal-pipeline/rules/CLAUDE.md` in the loanlight-api repo — three files that already declare the invariants F1, F3, and F4 are meant to enforce. The PRD's claim is *"the prose is good; we need the enforcement loop."*
