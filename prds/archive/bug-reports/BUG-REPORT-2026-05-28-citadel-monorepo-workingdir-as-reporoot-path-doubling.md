---
title: BUG REPORT — 2026-05-28 — citadel phase crashes ENOENT on monorepo subpackage sessions because pipeline-runner passes `workingDir` (the package dir) as `repoRoot` to `runCitadelAudit`, doubling the package prefix on every diff path
status: Draft
filed: 2026-05-28
priority: P1
type: bug-incident
r_code: R-CWRR
bundle: unbundled
related:
  - prds/MASTER_PLAN.md                                                          # finding #88 (this report)
  - prds/MASTER_PLAN.md                                                          # finding #85 R-PPCD — same class of "citadel was added as a native phase but the surrounding plumbing assumes single-package layout"
  - extension/src/services/citadel/audit-runner.ts                              # path.resolve(options.repoRoot ?? process.cwd()) — the consumer
  - extension/src/bin/pipeline-runner.ts                                        # executeCitadelPhase passes `repoRoot: runtime.workingDir` — the producer
incident_sessions:
  - /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-28-da12c152  # LOA-896 §15 progressive 1025 loading (loanlight-api monorepo)
---

# R-CWRR — citadel treats `workingDir` as `repoRoot`; monorepo subpackage sessions die on the first diff path

## Status

**Open.** This report does NOT pre-commit to a fix. The mechanism is fully observable in the runtime code; the fixer should confirm with one regression spec before changing anything else.

## TL;DR

On a session whose `working_dir` is a **subpackage** of a monorepo (e.g. `<repo>/packages/api`) rather than the git toplevel, the citadel phase crashes on its **first action** with:

```
[FATAL] ENOENT: no such file or directory, open
  '<repo>/packages/api/packages/api/src/lib/appraisal-pipeline/__tests__/adapter.spec.ts'
```

— note the **doubled `packages/api/packages/api/`** segment. PICKLE completes normally; the doubled path appears only in the citadel phase. The pipeline-runner then exits, leaving the session stuck at `step=citadel, exit_reason=fatal` and stranding all downstream phases (anatomy-park, szechuan-sauce) — even though the PICKLE work is complete and committed.

The root cause is a single argument site:

- **`extension/src/bin/pipeline-runner.ts:1580–1587`** (`executeCitadelPhase`) passes the session's `workingDir` (the package dir where pickle/anatomy-park commands run) as `repoRoot` into `runCitadelAudit`.
- **`extension/src/services/citadel/audit-runner.ts:77`** then does `path.resolve(options.repoRoot ?? process.cwd())` and joins every diff entry against that path.
- `state.start_commit..HEAD` git diff produces **repo-root-relative** paths (`packages/api/src/...`).
- Resolving a `packages/api/...` path against a `<repo>/packages/api/` "repoRoot" doubles the prefix.

PICKLE is unaffected because pickle commands are run with cwd = workingDir, and pickle prompts use paths relative to that cwd, not relative to the git toplevel. The mismatch surfaces the moment citadel mixes (a) git-toplevel-relative diff entries with (b) workingDir-as-repoRoot resolution.

## Incident — LOA-896 §15 progressive 1025 loading (session `2026-05-28-da12c152`)

Pipeline run for the loanlight-api monorepo (`/Users/gregorydickson/loanlight/loanlight-api`), working in subpackage `packages/api/` against branch `gregory/loa-896-progressive-1025-review-stream-reducto-sub-schema-results-to`.

- PICKLE phase 1/4 completed cleanly. 7 commits landed (`139c26e07` §15.A through `6df273c19` §15.G); all 7 §15 components shipped; working tree clean; `Phase pickle exited with code 0`.
- One non-blocking warning at PICKLE wind-down: `ticket ca602bf8 cannot flip Done: hasCompletionCommit().source === 'absent' (expected 'explicit')`. PICKLE still exited 0 and transitioned to CITADEL — survivable, possibly orthogonal.
- The runner transitioned to PHASE 2/4: CITADEL and the citadel phase died on its first I/O attempt with the doubled-path ENOENT above. tmux session is alive but pipeline-runner has exited (`pipeline-status.json: failed`).
- All artifacts preserved: branch commits intact, session state at `step=citadel`, `active=false`, `exit_reason=fatal`, working tree clean.

### Verbatim log evidence

```
pipeline-runner.log:
  [2026-05-28T18:04:00.248Z] Phase pickle exited with code 0
  [2026-05-28T18:04:00.272Z] Phase pickle completed successfully
  [2026-05-28T18:04:00.273Z] PHASE 2/4: CITADEL (backend=claude)

tmux capture (pipeline-da12c152:0):
  🧪 Pipeline Phase: citadel
    Phase:  2/4
    Target: /Users/gregorydickson/loanlight/loanlight-api

  [FATAL] ENOENT: no such file or directory, open
    '/Users/gregorydickson/loanlight/loanlight-api/packages/api/packages/api/src/lib/appraisal-pipeline/__tests__/adapter.spec.ts'

  Pipeline finished.

state.json:
  { "working_dir": "/Users/gregorydickson/loanlight/loanlight-api/packages/api",
    "step": "citadel", "active": false, "exit_reason": "fatal",
    "phases_entered": [] }

pipeline-status.json:
  { "status": "failed", "current_phase": null, "completed_phases": 0,
    "total_phases": 0, "updated_at": "2026-05-28T18:04:00.696Z" }
```

The `pipeline-status.json` line `completed_phases: 0` is misleading — PICKLE *did* complete (commits + branch artifacts confirm) — but the failure write path zeros the counter when the runner exits fatal. Possible secondary cleanup item; not the root cause.

## Mechanism (confirmed by direct code reading)

1. `pipeline-runner.ts:189–196 normalizePipelinePhases()` auto-splices `'citadel'` after `'pickle'` whenever pickle is in the phase list — so any pipeline that includes pickle gets citadel for free (this is correct and intentional per [#85 R-PPCD]).
2. `pipeline-runner.ts:1580–1587 executeCitadelPhase()`:
   ```ts
   const result = await runCitadelAudit({
     prdPath: state.prd_path,
     diffRange: `${state.start_commit}..HEAD`,
     repoRoot: runtime.workingDir,       // ← BUG: workingDir is the package dir
     sessionDir: runtime.sessionDir,
     reportPath,
     strict: runtime.config.citadel_strict,
   });
   ```
3. `audit-runner.ts:77` accepts the `repoRoot` argument and uses it as the base for path resolution against the diff entries:
   ```ts
   const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
   ```
4. `git diff <start_commit>..HEAD --name-only` produces paths **relative to the git toplevel**, regardless of process cwd. Examples for this session: `packages/api/src/lib/appraisal-pipeline/__tests__/adapter.spec.ts`, `packages/api/src/database/schema/appraisal-run-partials.ts`, `packages/api/db/migrations/0142_create_appraisal_run_partials.sql`, etc.
5. `path.resolve('<repo>/packages/api', 'packages/api/src/lib/...')` → `<repo>/packages/api/packages/api/src/lib/...`. ENOENT on the first read.

Single-package projects (where `working_dir === git toplevel`) coincidentally work, which is why this bug only surfaces on monorepo sessions like `loanlight-api`.

## Competing root-cause framings (fixer to pick the right surface)

The mechanism is unambiguous. The question is **which side fixes the layering violation**, and they're not equivalent:

- **F1 — Fix the producer (recommended).** `pipeline-runner.ts:1583` should derive the actual git toplevel from `runtime.workingDir` (e.g. `git -C <workingDir> rev-parse --show-toplevel` once at runtime construction, cached in `runtime.repoRoot`) and pass that as `repoRoot`. This matches the *intent* of the field name and unblocks every other future consumer that needs the actual repo root. Failure mode if missed elsewhere: a yet-unobserved consumer calls `runCitadelAudit({ repoRoot: workingDir })` again and the bug recurs.
- **F2 — Fix the consumer.** `audit-runner.ts` could re-derive the toplevel itself when given a `repoRoot` that turns out to be a subdir — but that's an inversion (the consumer second-guessing its input). It also masks the broken contract everywhere else the producer passes a wrong value.
- **F3 — Add a runtime-level `repoRoot` field.** Extend `PipelineRuntime` with an explicit `repoRoot` separate from `workingDir`. Compute it once in `loadPipelineRuntime` via `git rev-parse --show-toplevel`. Then `executeCitadelPhase` (and any other future toplevel consumer) reads `runtime.repoRoot`. This is F1 with a cleaner home. **Likely the right answer** — pipeline-runner already grep'd shows ~6 call sites passing `runtime.workingDir` into things that may or may not actually want the toplevel; auditing those is a follow-up.

The three are not mutually exclusive — F3 is the structurally clean variant of F1. F2 alone leaves the contract incoherent.

## Desired behavior

1. **Monorepo subpackage sessions complete the citadel phase successfully** on a branch that contains commits to subpackage paths. AC: a regression session whose `working_dir` ends in `/packages/<name>` and whose diff touches that subpackage must run citadel to a clean exit (or to a reported finding — anything except ENOENT on the diff path).
2. **`PipelineRuntime` exposes the git toplevel explicitly** (`runtime.repoRoot`), distinct from `runtime.workingDir`. The two coincide for single-package repos and diverge for monorepos. Computed once at runtime construction.
3. **All path-resolving phase consumers use `runtime.repoRoot` for repo-root-relative paths and `runtime.workingDir` for shell-cwd intents.** A grep-level audit confirms no remaining consumer conflates them (~6 call sites flagged in this report — audit is part of the fix scope).
4. **A regression spec asserts the contract.** A unit/integration test that stages a monorepo working_dir + a subpackage diff and asserts citadel resolves paths against the toplevel, not the workingDir.

## AC (acceptance criteria) for the fix bundle

- **AC-CWRR-1** — `PipelineRuntime.repoRoot` exists, computed via `git -C workingDir rev-parse --show-toplevel`, falling back to `workingDir` only if not a git repo.
- **AC-CWRR-2** — `executeCitadelPhase` passes `runtime.repoRoot` (not `runtime.workingDir`) as `repoRoot` to `runCitadelAudit`.
- **AC-CWRR-3** — Audit + update every other `runtime.workingDir` consumer that wants the toplevel; document each remaining `workingDir` use with a 1-line "why workingDir, not repoRoot" comment.
- **AC-CWRR-4** — A regression spec stages a fake monorepo (`<tmp>/<repo>/packages/api/...` + git init at toplevel) and asserts citadel resolves a `packages/api/foo.ts` diff entry to `<tmp>/<repo>/packages/api/foo.ts`, not the doubled path.
- **AC-CWRR-5** — `pipeline-status.json` no longer reports `completed_phases: 0, total_phases: 0` when a downstream phase fails fatal after PICKLE has actually completed. (Secondary cleanup; non-blocking if scoped out.)

## Operator workaround for the LOA-896 session (this incident)

1. Edit `pipeline.json` to drop pickle from the phase list (so citadel doesn't auto-splice): `phases: ["anatomy-park", "szechuan-sauce"]`.
2. Reset `state.json`: clear `exit_reason`, set `active=true`, set `step` to `"anatomy-park"`, leave `phases_entered=[]` (treat as fresh continuation).
3. Re-launch via the existing `launch.sh`.

This is a **per-session bypass**, not a fix. Anatomy-park does not pass diff-derived paths through the same code path, so it tolerates `workingDir==package` correctly.

## Sized

~3 tickets:
1. AC-CWRR-1 + AC-CWRR-2 (one fix + one consumer update). Regression spec inline.
2. AC-CWRR-3 (call-site audit; sweep the ~6 `runtime.workingDir` references in pipeline-runner.ts; convert toplevel-intent ones; comment the rest).
3. AC-CWRR-5 (`pipeline-status.json` counter accuracy on fatal-mid-pipeline — optional, deferrable to a hygiene PR).
