---
title: P1 — B-CWRR bundle: citadel treats workingDir as repoRoot, doubling the package prefix on monorepo subpackage sessions
status: Draft
filed: 2026-05-29
priority: P1
type: bug-bundle
r_code: R-CWRR
composes:
  - 88   # R-CWRR — pipeline-runner passes workingDir as repoRoot to runCitadelAudit; monorepo diff paths double the package segment
source_report: prds/archive/bug-reports/BUG-REPORT-2026-05-28-citadel-monorepo-workingdir-as-reporoot-path-doubling.md
related:
  - extension/src/services/citadel/audit-runner.ts        # consumer: path.resolve(options.repoRoot ?? process.cwd())
  - extension/src/bin/pipeline-runner.ts                  # producer: executeCitadelPhase passes repoRoot: runtime.workingDir
incident_sessions:
  - /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-28-da12c152  # LOA-896 §15 (loanlight-api monorepo) — citadel ENOENT on doubled path
---

# PRD — B-CWRR bundle

**Trigger**: On a pipeline session whose `working_dir` is a **subpackage** of a monorepo (e.g. `<repo>/packages/api`) rather than the git toplevel, the citadel phase crashes on its **first I/O** with a doubled package segment:

```
[FATAL] ENOENT: no such file or directory, open
  '<repo>/packages/api/packages/api/src/lib/.../adapter.spec.ts'
```

PICKLE completes and commits normally; the doubled path appears only once citadel runs. The pipeline-runner then exits `step=citadel, exit_reason=fatal`, stranding every downstream phase (anatomy-park, szechuan-sauce) even though the PICKLE work is complete and committed. Observed on session `2026-05-28-da12c152` (LOA-896 §15, loanlight-api monorepo, subpackage `packages/api/`).

**Root cause (confirmed by direct code reading)**: a single argument site.

- `extension/src/bin/pipeline-runner.ts:1580–1587` (`executeCitadelPhase`) passes the session's `workingDir` (the package dir) as `repoRoot` into `runCitadelAudit`.
- `extension/src/services/citadel/audit-runner.ts:77` does `path.resolve(options.repoRoot ?? process.cwd())` and joins every diff entry against it.
- `git diff <start_commit>..HEAD --name-only` yields **git-toplevel-relative** paths (`packages/api/src/...`), regardless of process cwd.
- `path.resolve('<repo>/packages/api', 'packages/api/src/...')` → `<repo>/packages/api/packages/api/src/...`. ENOENT on the first read.

Single-package projects (where `working_dir === git toplevel`) coincidentally work, which is why the bug only surfaces on monorepo sessions.

**Chosen fix surface (F3 — structurally-clean F1, per source report)**: extend `PipelineRuntime` with an explicit `repoRoot` distinct from `workingDir`, computed once via `git -C workingDir rev-parse --show-toplevel`. Every path-resolving phase consumer reads `runtime.repoRoot` for repo-root-relative paths and `runtime.workingDir` for shell-cwd intents. Fixing the producer (F1/F3) — not the consumer second-guessing its input (F2) — keeps the `repoRoot` contract coherent for every future consumer.

## Acceptance Criteria

- **AC-CWRR-00**: full release gate green from a clean tree — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive` exits 0.
- **AC-CWRR-1**: `PipelineRuntime.repoRoot` exists, computed via `git -C <workingDir> rev-parse --show-toplevel`, falling back to `workingDir` only when `workingDir` is not inside a git repo. Computed once at runtime construction (`loadPipelineRuntime`), cached on the runtime object.
- **AC-CWRR-2**: `executeCitadelPhase` passes `runtime.repoRoot` (not `runtime.workingDir`) as `repoRoot` to `runCitadelAudit`.
- **AC-CWRR-3**: every other `runtime.workingDir` consumer in `pipeline-runner.ts` is audited (the ~6 call sites flagged in the source report). Each toplevel-intent use is converted to `runtime.repoRoot`; each remaining `workingDir` use carries a 1-line `// why workingDir, not repoRoot` comment so the distinction is self-documenting and the next reader can't reintroduce the conflation.
- **AC-CWRR-4**: a regression spec stages a fake monorepo (`<tmp>/<repo>/packages/api/...` with `git init` at the toplevel and a subpackage diff) and asserts citadel resolves a `packages/api/foo.ts` diff entry to `<tmp>/<repo>/packages/api/foo.ts` — **not** the doubled `<tmp>/<repo>/packages/api/packages/api/foo.ts`. Test also covers the single-package case (`workingDir === toplevel`) to prove no regression there.
- **AC-CWRR-5** (secondary, deferrable): `pipeline-status.json` no longer reports `completed_phases: 0, total_phases: 0` when a downstream phase fails fatal **after** PICKLE has actually completed at least one phase. Scope out to a hygiene follow-up if it threatens the bundle — it is not the root cause and must not block AC-CWRR-1..4.
- **AC-CWRR-06**: no `LATEST_SCHEMA_VERSION` bump. `PipelineRuntime` is an in-memory runtime object, not persisted `state.json` schema — adding `repoRoot` to it is schema-neutral. Confirm no `state.json` field is added (R-WSRC / #74 R-WSWA guard).

## Class A — R-CWRR producer fix + contract (#88, ~1 ticket)

AC-CWRR-1 + AC-CWRR-2 + AC-CWRR-06. Add `repoRoot` to the `PipelineRuntime` type and compute it in `loadPipelineRuntime` via `git -C workingDir rev-parse --show-toplevel` (fallback to `workingDir` on non-repo). Repoint `executeCitadelPhase` at `runtime.repoRoot`. Regression spec (AC-CWRR-4) authored inline with this ticket so the fix is proven the moment it lands.

## Class B — R-CWRR call-site audit (#88, ~1 ticket)

AC-CWRR-3. Sweep every `runtime.workingDir` reference in `pipeline-runner.ts`. For each: decide toplevel-intent vs shell-cwd-intent. Convert the toplevel-intent ones to `runtime.repoRoot`; annotate the rest with a 1-line justification comment. Output a short audit note in the ticket artifact listing each call site and its verdict so the closer can confirm completeness.

## Class C — pipeline-status counter accuracy (#88, ~1 ticket, OPTIONAL)

AC-CWRR-5. Fix the fatal-exit write path so `completed_phases` / `total_phases` reflect phases actually completed before the fatal phase, rather than zeroing the counter. Deferrable: if it risks the bundle or touches unrelated surface, scope it out and re-file as a hygiene finding — AC-CWRR-1..4 are the load-bearing fix.

## Total: ~3 tickets + closer

## Closer

Run the full release gate (AC-CWRR-00) from a clean tree. On green: bump `extension/package.json` (**PATCH** — fixes only, no new commands/flags/schema), commit `chore: bump version to X.Y.Z`, ensure clean working tree, then the babysitter's finalization step tags `gh release create vX.Y.Z`. Update `prds/MASTER_PLAN.md`: strike the B-CWRR dispatch line, move #88 R-CWRR to "Closed since last update", add a "Recently Shipped" entry with the closer commit SHA + version. Pin any new trap door if the call-site audit (Class B) reveals a recurring conflation pattern worth a runtime guard.
