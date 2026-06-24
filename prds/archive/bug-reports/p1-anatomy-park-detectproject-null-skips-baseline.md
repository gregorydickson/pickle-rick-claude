---
title: P1 — anatomy-park silently skips baseline write when workingDir has no project-type marker (kills pipeline Phase 3)
status: Draft
filed: 2026-05-08
priority: P1
type: bug
discovered_in:
  - session: 2026-05-08-d6f98b66
  - phase: anatomy-park
  - exit_reason: failed (pipeline-runner halt)
  - failed_at: 2026-05-08T15:05:03.354Z
related:
  - prds/archive/bundles/p1-bug-fix-bundle-2026-05-07-deferred-slots.md  # bundle that exposed this on its own anatomy-park phase
  - prds/MASTER_PLAN.md  # Open Finding (new — supersedes prior #7 closure)
backend_constraint: claude
refine: false
unattended: false
---

# PRD — anatomy-park `gate/baseline.json` not written when `detectProjectType(workingDir) === null`

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Why this PRD

Session `2026-05-08-d6f98b66` ran the full `/pickle-pipeline --no-refine --backend claude` against `prds/archive/bundles/p1-bug-fix-bundle-2026-05-07-deferred-slots.md`. **Phase 1 (pickle) shipped 5/5 tickets** (Slots D/E/K/L + Closer); **Phase 2 (citadel) wrote 1 informational finding**; **Phase 3 (anatomy-park) failed at iteration 1, 4m25s into the microverse loop**, before any subsystem-review iteration could land. Phase 4 (szechuan-sauce) never ran.

The trap door at `microverse-runner.ts:capturePerIterationGateBaseline` (`extension/CLAUDE.md` — `convergence-gate.ts (baseline write verification)` + `microverse-runner.ts (baseline-init log gating)`) **fired correctly** with:

```
[anatomy-park] per-iteration gate baseline initialization failed - expected baseline at
  /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-08-d6f98b66/gate/baseline.json
microverse-runner error: ... finished. 1 iterations, 4m 25s, exit: error
```

The trap door is doing exactly what it was designed to do — but it's catching a real silent-skip bug in `runGate({mode:'baseline'})`, not an interrupted write or filesystem error.

## Root cause

`runGate()` at `extension/src/services/convergence-gate.ts:947` calls `detectProjectType(opts.workingDir)` first. When `workingDir` lacks a project-type marker (`package.json`, `*-lock.*`, `Cargo.toml`, `go.mod`), `detectProjectType` returns `null` and `runGate` early-returns:

```ts
if (!projectType) {
  emit('gate_skipped', { reason: 'no_project_type_detected' });
  return { ...emptyGateResult(), elapsed_ms: Date.now() - start };
}
```

`emptyGateResult()` returns `{status:'green', ..., baseline_used:false, ...}` — a successful result — but **does NOT write `baselinePath`**. The caller `capturePerIterationGateBaseline` then runs `pathExists(baselinePath)` (the trap-door check), sees missing file, and throws the operator-visible `failureMessage` plus emits `gate_baseline_init_failed`.

In this repo:
- repo root `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/` has **no project-type marker** (no `package.json`, no `*-lock.*`)
- the only npm project lives at `extension/` (`extension/package.json`, `extension/package-lock.json`)
- `/pickle-pipeline` Step 4 sets `pipeline.json:target` to the current working directory (repo root), which microverse-runner forwards as `workingDir`
- result: `detectProjectType('/.../pickle-rick-claude') === null` → silent gate skip → missing baseline file → trap-door throws → pipeline halts

Verified empirically:

```bash
$ node -e "const cg = require('./extension/services/convergence-gate.js'); \
  console.log(cg.detectProjectType('/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude'));"
null
$ node -e "const cg = require('./extension/services/convergence-gate.js'); \
  console.log(cg.detectProjectType('/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/extension'));"
npm
```

## Why the existing closure of Open Finding #7 didn't cover this

`b0f5ceca` ("fix(microverse): defer stale-baseline refresh failures to post-commit recapture") closes the **stale-baseline** class — when an existing baseline is too old/wrong-iteration. It explicitly leaves the **fresh-init** path unchanged: "Fresh-init failure (no baseline ever) still throws because there is no recovery path" (`microverse-runner.ts:683-684`). The new bug class is a fresh-init failure, NOT a stale refresh, so `b0f5ceca`'s catch-and-defer path correctly does NOT apply.

This is a NEW pipeline-killer class that re-opens the spirit of MASTER_PLAN Open Finding #7 — anatomy-park phase still cannot survive a green-tree, project-rooted launch when the project layout is `monorepo with subdir package`.

## Scope of impact

| Repo layout | Hits this bug |
|---|---|
| Single npm project at repo root | NO — `package.json` at workingDir, gate runs |
| Monorepo with `pnpm-workspace.yaml` at root | NO — pnpm-workspace.yaml triggers `'pnpm'` |
| Monorepo with subdir-only package (e.g. `extension/package.json`) | **YES** — repo root has no marker, gate silently skips |
| Pure docs/data repo (no project at all) | YES — but expected outcome may differ |

This repo (`pickle-rick-claude`) is the third bucket. So is any project that follows the same "tools live under `extension/`, repo root holds prds/docs/scripts" layout.

## Requirements

| Req | Description |
|---|---|
| **R-APBN-1** | When `runGate({mode:'baseline', baselinePath, ...})` enters the `!projectType` early-return path, it MUST write `baselinePath` with a valid `GateBaselineFile` shape that records `project_type: null` (extend `GateBaselineFile['project_type']` enum to include `null` if the type forbids it), `checks: []`, `failures: []`, `captured_at: now`. The status MUST remain `'green'` so the trap-door's `pathExists(baselinePath)` check passes and the iteration loop proceeds with no preexisting failures to subtract. Activity event `gate_skipped` continues to fire with the same `reason: 'no_project_type_detected'` payload so observability is preserved. |
| **R-APBN-2** | The same fix MUST also apply to the `!cmdMap` early-return path (line ~959 — project-type detected but commands missing for that type). Write empty baseline + emit `gate_skipped` with `reason: 'project_type_low_confidence'`. |
| **R-APBN-3** | Regression test `extension/tests/services/convergence-gate-baseline-no-project-type.test.js` (new file) covers: (a) `runGate({mode:'baseline'})` against a workingDir lacking any project marker writes baseline.json with empty `failures` + `checks`, (b) the same against a workingDir with an unknown project type writes baseline.json with empty `failures` + `checks`, (c) post-write `fs.existsSync(baselinePath) === true` in both cases. Existing trap-door tests (`convergence-gate-baseline-write-verify.test.js`, `microverse-runner-baseline-init.test.js`) MUST still pass unchanged. |
| **R-APBN-4** | Trap-door entry in `extension/CLAUDE.md` under the existing `src/services/convergence-gate.ts (baseline write verification)` block — append: "INVARIANT: the no-project-type and unknown-project-type early-return paths MUST also write `baselinePath` (empty checks + empty failures); a gate that returns `gate_skipped` in baseline mode without writing the file silently breaks every downstream `pathExists(baselinePath)` consumer, and the microverse-runner trap door cannot distinguish 'truly skipped' from 'forgot to write'." Honor the existing PATTERN_SHAPE/BREAKS/ENFORCE field structure. |
| **R-APBN-5** | End-to-end regression: a synthetic minimal session under `extension/tests/integration/anatomy-park-no-project-root.test.js` runs `pipeline-runner.js` against a fixture repo containing `bin/foo.js` + `extension/package.json` + minimal anatomy config; assert (a) anatomy-park phase exits 0 (or `judge_unreachable`-class error rather than baseline-init failure), (b) `gate/baseline.json` exists post-run, (c) `state.exit_reason !== 'gate_baseline_init_failed'`. |

## Acceptance Criteria

- **AC-APBN-01** — `cd extension && node --test tests/services/convergence-gate-baseline-no-project-type.test.js` exits 0 with all 3 cases passing.
- **AC-APBN-02** — `cd extension && node --test tests/services/convergence-gate-baseline-write-verify.test.js tests/microverse-runner-baseline-init.test.js` exits 0 (no regression).
- **AC-APBN-03** — `cd extension && bash scripts/audit-trap-door-enforcement.sh` exits 0 with ENFORCE refs ≥ 122 (current 121 + new R-APBN-4 entry).
- **AC-APBN-04** — `cd extension && node --test tests/integration/anatomy-park-no-project-root.test.js` exits 0.
- **AC-APBN-05** — Live verification: re-run `/pickle-pipeline --no-refine --backend claude` against `prds/archive/bundles/p1-bug-fix-bundle-2026-05-07-deferred-slots.md` (or any bundle PRD) on `pickle-rick-claude` repo root; anatomy-park phase reaches at least iteration 2 without `gate_baseline_init_failed` exit. (Recovery from `2026-05-08-d6f98b66` — the session that originally caught this.)
- **AC-APBN-06** — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1` exits 0 (production gate parity).

## Files in scope

- `extension/src/services/convergence-gate.ts` (`runGate` early-return paths, `writeBaselineFile`, `GateBaselineFile` schema if `project_type: null` needs adding)
- `extension/src/bin/microverse-runner.ts` (no change expected — verify R-APBN-5 e2e)
- `extension/tests/services/convergence-gate-baseline-no-project-type.test.js` (NEW)
- `extension/tests/integration/anatomy-park-no-project-root.test.js` (NEW)
- `extension/CLAUDE.md` (R-APBN-4 trap-door extension)

## Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Empty-baseline write masks a real configuration bug — operator launches anatomy-park with the wrong workingDir and gets a "green" empty baseline instead of an error | Med | Low | The `gate_skipped` activity event is preserved; operators reading the activity log see `reason:'no_project_type_detected'` and can diagnose. The alternative (current behavior) is silent pipeline halt — strictly worse. |
| R2 | Some downstream consumer of `gate/baseline.json` chokes on `failures: []` + `checks: []` empty arrays | Low | Med | Existing baseline JSON readers tolerate empty arrays (no test asserts non-empty). R-APBN-3 covers the read-path through `runChangedPerIterationGate`'s strict-mode fallback. |
| R3 | Adding `null` to `GateBaselineFile['project_type']` breaks the JSON schema or its consumers | Low | Low | The literal `null` only appears in the new no-project-type branch; existing branches continue to write a string project_type. Schema evolution is additive, not breaking. |

## Out of scope

- **`/pickle-pipeline` `--target` defaulting**: the pipeline-runner correctly forwards repo-root as the anatomy-park workingDir; the bug is in convergence-gate's silent-skip behavior, not in target resolution.
- **Walking up/down for nested project dirs**: detectProjectType could be extended to descend one level and discover `extension/package.json`, but this changes anatomy-park semantics (gate runs against a different scope than the operator targeted). Out of scope for this bug fix; track separately if desired.
- **Re-running the failed `2026-05-08-d6f98b66` session's anatomy-park + szechuan-sauce phases**: those are separate runs once the fix lands. AC-APBN-05 is the gating live verification.

## Closer

| Req | Description |
|---|---|
| **R-CLOSER-1** | At fix end, run the full local lint + test gate from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration`. All green. |
| **R-CLOSER-2** | `bash install.sh` runs once to sync compiled JS with TS source. Final `git status --short` MUST be clean. |
| **R-CLOSER-3** | `prds/MASTER_PLAN.md` updated: re-open Finding #7 with this PRD's link, OR add new Finding #10 for this bug class. Operator decides; bundle does NOT auto-update MASTER_PLAN beyond noting the Closed/Open transition. |

## Launch command

```bash
cd /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
/pickle prds/p1-anatomy-park-detectproject-null-skips-baseline.md
```

Single-ticket fix; `/pickle` (not `/pickle-tmux` or pipeline) — scope is too narrow to justify the orchestration overhead.

---

*Pickle Rick out. The trap door caught a real bug, Morty. Fix is straightforward — write the file even when nothing's in it. Belch.*
