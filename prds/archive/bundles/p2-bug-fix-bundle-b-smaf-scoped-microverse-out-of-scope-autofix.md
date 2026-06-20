---
title: P2 bug-fix bundle — B-SMAF — scoped microverse out-of-scope autofix dirty-tree abort
status: Draft
filed: 2026-06-02
priority: P2
type: bug-bundle
code: B-SMAF
composes:
  - "#91 R-SMAF — scoped /anatomy-park /szechuan-sauce abort when a package-wide `lint --fix` dirties a file OUTSIDE scope.json:allowed_paths; recurs every gate/iteration"
  - "#93 R-APXG — anatomy-park post-convergence exit-gate hangs indefinitely (coupled to the un-clean out-of-scope tree)"
  - "#92 R-RSBI — resolve-scope.js base inconsistency (paths: glob resolved against workingDir vs repoRoot) + misleading dirty-tree abort copy"
backend_constraint: any
schema_neutral: true   # behavior fixes to scope/clean-tree/exit-gate logic; no state.json field, no LATEST_SCHEMA_VERSION change
source:
  - prds/archive/bug-reports/BUG-REPORT-2026-06-02-scoped-microverse-out-of-scope-autofix-dirty-tree-abort.md
  - prds/MASTER_PLAN.md   # findings #91 / #92 / #93
---

# B-SMAF — scoped microverse out-of-scope autofix dirty-tree abort

> Three findings from the 2026-06-02 loanlight-api LOA-955 remediation pipeline. **R-SMAF is primary** (the recurring abort); R-APXG and R-RSBI are coupled secondaries from the same incident. The bug report does NOT pre-commit to a fix — each ticket's research phase MUST confirm the mechanism + exact call site before changing logic.

## Trigger

MASTER_PLAN drain row 15 (`#91 R-SMAF` + `#93 R-APXG` + `#92 R-RSBI`). Running `/anatomy-park` or `/szechuan-sauce` with `--scope paths:<glob>` against a monorepo subpackage, the microverse-runner aborts on startup: `Working tree is dirty and not a git repository`. The dirtying file is OUTSIDE `scope.json:allowed_paths` — a package-wide `lint --fix` (eslint `reportUnusedDisableDirectives`) rewrote an unrelated file. It recurs every gate/iteration until the unrelated autofix is manually committed (a scope leak into the operator's PR).

## Root cause (per the report; confirm in research)

1. `--scope paths:…` resolves `scope.json:allowed_paths` correctly. ✅
2. A gate/worker step runs the project lint package-wide with `--fix`, mutating the **working tree** of files outside `allowed_paths` (never going through the gated `git add`, so B-APWS #11's allowlist never sees it).
3. The microverse-runner clean-tree precondition sees a dirty tree and aborts — it does NOT subtract out-of-scope changes the way the gate subtracts `baseline.json` failures.
4. Restoring is futile (next lint re-applies); the only escape is committing the unrelated change.

Coupled: the post-convergence exit gate (R-APXG) hangs because it can never reach a clean tree; `resolve-scope.js` (R-RSBI) resolves the same glob against different bases (`workingDir` vs `repoRoot`) across templates.

## In scope

- R-SMAF: make the scoped clean-tree precondition scope-aware (ignore out-of-scope working-tree changes), mirroring the gate's `baseline.json` subtraction; regression-test it.
- R-RSBI: resolve `paths:` globs against a single documented base regardless of template/working_dir; fix the misleading abort copy.
- R-APXG: bound the post-convergence exit gate so it cannot hang indefinitely; confirm it resolves once R-SMAF lands.
- Closer: gate, bump, install.sh, push, release, MASTER_PLAN repoint closing #91/#92/#93.

## Not in scope

- Changing the lint scripts of consuming repos (loanlight-api). The fix is in the pickle-rick-claude runtime (microverse-runner / resolve-scope / pipeline-runner).
- The babysit/auto-chain UX asks from the report's secondaries (already covered by launch-friction/babysit-harden bundles).
- gitnexus graph-preflight noise (tracked separately).

## Atomic tickets

> Each ticket's **research phase MUST confirm the mechanism + exact call site** (the report is observational, not prescriptive) before editing logic.

### R-SMAF-1 (medium) — Scope-aware clean-tree precondition
- **Scope:** in `extension/src/bin/microverse-runner.ts` (the dirty-tree precondition / `preflightAutoCommit` abort site), when a `scope.json` with `allowed_paths` exists for the run, evaluate working-tree dirtiness **only over `allowed_paths`** — out-of-scope changes do NOT abort the run and are NOT committed (optionally revert them as pre-run hygiene). Mirror how the convergence gate subtracts the `gate/baseline.json` failure set. An UNSCOPED run keeps the existing whole-tree precondition.
- **AC-SMAF-1-1:** a regression test (`extension/tests/...` forward-created) drives a scoped run where an out-of-scope file is dirtied by a simulated autofix and asserts (a) the run does NOT abort with the dirty-tree error, and (b) the out-of-scope change is NOT committed (no scope leak).
- **AC-SMAF-1-2:** an UNSCOPED run with a dirty tree still triggers the existing precondition (no regression) — covered by an existing or added test.
- **AC-SMAF-1-3:** `grep -niE "allowed_paths|scope" <the precondition function in microverse-runner.ts>` shows the dirtiness check is gated on scope (the scope-aware branch exists).

### R-RSBI-2 (small) — resolve-scope single-base + abort copy
- **Scope:** `extension/src/bin/resolve-scope.ts` — resolve `paths:<glob>` against a single, documented base (repo toplevel) regardless of template/`working_dir`, so the same `--scope` argument resolves identically across anatomy-park/szechuan/build (same `workingDir`-vs-`repoRoot` class as R-CWRR #88). Fix the conflated abort copy to distinguish "working tree dirty (out-of-scope changes)" from "no `.git` repository found".
- **AC-RSBI-2-1:** a test asserts the same `paths:<glob>` resolves to the same `allowed_paths` set regardless of `working_dir` (subpackage vs repo root).
- **AC-RSBI-2-2:** `grep -c "dirty and not a git repository" extension/src/bin/microverse-runner.ts` returns `0` (the conflated message is replaced); the two conditions emit distinct messages.

### R-APXG-3 (medium) — bound the post-convergence exit gate
- **Scope:** `extension/src/bin/pipeline-runner.ts` (anatomy-park per-iteration "gate before exit") — the post-convergence exit path MUST be bounded (finite timeout / guard) so it cannot hang indefinitely after the worker signals `converged=true`; on timeout it surfaces a clear reason and exits rather than hanging. Confirm in research whether R-SMAF-1 alone resolves the hang (gate can now reach a clean in-scope tree); if so, R-APXG-3 reduces to a defensive bound + regression.
- **AC-APXG-3-1:** a test simulating post-convergence with an out-of-scope dirty file asserts the exit gate completes (or times out with a clear reason) within a bounded wall-time — no indefinite hang.
- **AC-APXG-3-2:** the closing banner / terminal disposition is reached in the test (the session does not require a manual kill).

### C-SMAF-CLOSER [manager] — Ship B-SMAF
- **Scope:** run the FULL release gate from `extension/`, bump per semver (**PATCH** if pure bug-fix; **MINOR** if a new activity event/flag is added, e.g. an `out_of_scope_dirty_ignored` event — apply the decision rule on the actual diff), `bash install.sh`, push, `gh release create`, repoint MASTER_PLAN closing #91/#92/#93.
- **AC-CLOSER-1:** Full release gate GREEN from `extension/` (tsc --noEmit, eslint --max-warnings=-1, tsc, all audit-*.sh, test:fast, test:integration, RUN_EXPENSIVE_TESTS=1 test:expensive) — READ + confirm before bump/commit/tag.
- **AC-CLOSER-2:** `extension/package.json:version` bumped (single bump); commit subject `chore(C-SMAF-CLOSER): ship B-SMAF — bump X.Y.Z + close #91/#92/#93`.
- **AC-CLOSER-3:** `bash install.sh` exits 0; `git status` clean at tag time; compiled JS matches TS.
- **AC-CLOSER-4:** `git push` succeeds; `gh release create vX.Y.Z` succeeds (verify with `gh release list`).
- **AC-CLOSER-5:** `prds/MASTER_PLAN.md` marks B-SMAF SHIPPED and closes #91/#92/#93. Verify: `grep -c "B-SMAF.*SHIPPED" prds/MASTER_PLAN.md` ≥ 1.

## Acceptance (bundle-level)

- Scoped microverse runs no longer abort on out-of-scope autofix dirt and no longer leak out-of-scope commits; `resolve-scope` resolves `paths:` consistently; the post-convergence exit gate cannot hang; release gate green; shipped; MASTER_PLAN repointed (#91/#92/#93 closed).

— Pickle Rick out. *belch*
