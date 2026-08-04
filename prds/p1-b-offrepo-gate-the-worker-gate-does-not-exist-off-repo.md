---
title: "B-OFFREPO — the worker quality gate does not exist on any repo that is not pickle-rick, and reports green"
priority: P1
finding: B-OFFREPO
status: ready
type: bug-fix-bundle
schema_neutral: true
target_version: v2.1.0
branch: release/v2.1-beta
build_mode: attended
source_assessment: "Authored 2026-08-04. Every site grep-verified at HEAD with matching content; family enumerated by scanning workingDir-relative 'extension' joins across extension/src/."
---

# B-OFFREPO — a gate that only exists when we build ourselves

**Autonomy means building OTHER repos** ([[feedback_autonomy_means_building_other_repos_not_itself]]).
On every other repo, the worker quality gate does not run — and says `green`.

## 0. Pre-launch checks

- **Green-tree precondition — GREEN at `3e8ba9ed`, 2026-08-04.** `cd extension && npm run test:fast`:
  `tests 7212 / pass 7209 / fail 0 / skipped 2 / todo 1`, 481 suites, 438s, exit 0. Single run on a
  quiet box, no concurrent pipeline.
- **Stale-premise check — LIVE.** All five gate sites verified at HEAD with matching source content
  (see §1). Nothing has fixed this.
- **Build mode: ATTENDED.** Edits the Done-flip / recovery path.
- ⚠️ **Self-build blind spot, stated up front:** this bundle builds *on pickle-rick*, where
  `extension/` exists — so **the buggy path is never exercised by its own build.** A green self-build
  proves nothing about the fix. That is what WS-4 is for, and why it is not optional.

## 1. The family — five sites keyed on `<workingDir>/extension`

| # | Site | Off-repo behaviour | Severity |
|---|---|---|---|
| **F1** | `extension/src/bin/spawn-morty.ts:1786` `runWorkerGate` | `{ ok: true, lintErrors: 0, tscErrors: 0, testFailures: [] }` | **FAKE GREEN** |
| **F2** | `extension/src/bin/mux-runner.ts:4718` `resolveWorkerGateVerdict` | `{ verdict: 'green', computedVia: 'worker_gate' }` | **FAKE GREEN + false attribution** |
| **F3** | `extension/src/bin/mux-runner.ts:5834` `attemptRecoveryBeforeTerminal.runArmedGate` | `{ ok: true }` | **FAKE GREEN in the recovery ladder** |
| **F4** | `extension/src/bin/mux-runner.ts:670` `runBetweenTicketFastGate` | `return null` | silent skip (honest shape, no gate) |
| **F5** | `extension/src/bin/mux-runner.ts:5238` exit-path commit | `{ committed: false, reason: 'no-extension-dir' }` | honest refusal; **strands work off-repo** |

**F2 is the worst of them, and it is deliberate.** The source documents its own reasoning:

```js
const ext = path.join(workingDir, 'extension');
// No extension/ dir → JS worker gate not applicable to this target repo → green
// (matches runWorkerGate's no-extension ok:true). NOT fail-closed: a non-pickle-rick
// target would otherwise have every Done-flip refused.
if (!fs.existsSync(ext)) { return { verdict: 'green', computedVia: 'worker_gate' }; }
```

It does not merely skip — it returns `green` stamped `computedVia: 'worker_gate'`, **asserting that a
gate produced the verdict.** The comment's fear is correct (fail-closed would refuse every off-repo
Done-flip) and the conclusion is wrong: the answer to "we cannot run the gate" is not `green`.

`worker_gate_verdict` is load-bearing — it gates the Done flip at
`extension/src/bin/mux-runner.ts:4861` (*"cannot flip Done: worker_gate_verdict=…"*).

## 2. Field evidence

Session `2026-08-03-2d5b3820` — the LOA-2190 worktree, **our one clean hands-off run on a real target
repo**, 15 tickets, 14 Done, `exit_reason: completed`. The worktree has **no `extension/` directory**
(verified). Therefore **every worker in that run skipped the entire lint/tsc/test gate and reported
green.** The run is evidence the system *completes*; it is not evidence anything it produced was
checked.

This is the largest instance of [[R-WGVI]] (the worker gate verdict carries no information) and a
confirmed member of the off-repo fake-green family
([[project_offrepo_fakegreen_is_a_family_not_one_site]] — *"grep `existsSync(<wd>/extension)` first"*).

## 3. The reuse target — do NOT build an adapter matrix

`pickle-rick` must stay repo-agnostic ([[feedback_pickle_rick_must_be_repo_agnostic_invariant]]); a
per-stack matrix is forbidden. **It is not needed — the primitive already exists and is exported:**

- `extension/src/services/convergence-gate.ts:362` — `detectProjectType(workingDir)` →
  `'pnpm' | 'npm' | 'yarn' | 'cargo' | 'go' | 'bun' | null`
- `extension/src/services/convergence-gate.ts:911` — `canRunTestScript(check, projectType, dir, emit)`,
  which already answers "does this project actually have that script?"
- plus `getWorkspacePackages` and workspace-root resolution, all already exported.

The worker gate simply never asks. Two hardcodes must also go:
`extension/src/bin/spawn-morty.ts:1473` (`runCommand('npm', ['run', scriptName], …)`) and
`extension/src/bin/mux-runner.ts:639` (`spawnSync('npm', ['run', 'test:fast'], …)`).

## 4. Workstreams

### WS-OFFREPO-1 — `not_run` is a verdict; `green` is a claim

Introduce an honest disposition for "the gate could not run here" and stop minting `green`.

**Directive-2 constraint (binding):** `not_run` MUST NOT block the Done flip. A gate may refuse a
LOCAL action; it may never stop the pipeline. Off-repo tickets continue, **flagged**, exactly as today
— the change is that the record stops lying.

- **AC-OFFREPO-1a**: `resolveWorkerGateVerdict` never returns `verdict: 'green'` with
  `computedVia: 'worker_gate'` when the gate did not execute. — Verify: `npm run test:fast` — Type: test
- **AC-OFFREPO-1b**: a `not_run` verdict does **not** refuse the Done flip, and emits a residual
  activity event naming the ticket and the reason. — Verify: `npm run test:fast` asserting the Done
  flip proceeds AND the event is present in `state.json.activity` — Type: test
- **AC-OFFREPO-1c**: F1 and F3 no longer return an `ok: true` shape for a gate that did not execute;
  they return a not-run shape distinguishable from a pass by the caller. — Verify: `npm run test:fast`
  — Type: test

### WS-OFFREPO-2 — make the gate actually run off-repo (REUSE, do not add)

Route F1 through `detectProjectType` + `canRunTestScript` so a target repo's own toolchain runs.

- **AC-OFFREPO-2a**: on a fixture repo with **no** `extension/` dir but a resolvable project type and a
  test script, `runWorkerGate` **executes** that project's lint/typecheck/test and returns a verdict
  derived from the real result. — Verify: `npm run test:fast` with a fixture per detected type —
  Type: test
- **AC-OFFREPO-2b**: on a repo where no project type resolves, the verdict is `not_run` — never
  `green`, never a halt. — Verify: `npm run test:fast` — Type: test
- **AC-OFFREPO-2c**: no per-stack branching is introduced beyond what `detectProjectType` already
  returns; the diff adds no new package-manager list. — Verify: `git diff` contains no new literal
  array of package-manager names — Type: llm-conformance
- **AC-OFFREPO-2d**: the `'npm'` hardcodes at `extension/src/bin/spawn-morty.ts:1473` and
  `extension/src/bin/mux-runner.ts:639` resolve
  from the detected project type. — Verify: `git diff` + `npm run test:fast` — Type: test

### WS-OFFREPO-3 — F4/F5 disposition

F4 (`null`) and F5 (`no-extension-dir`) are honest but leave off-repo runs with no between-ticket gate
and a stranded-work path. Decide each explicitly: route through WS-2's resolver, or document as
deliberate with the reason recorded. **A silent skip that nobody decided is not an option.**

- **AC-OFFREPO-3a**: F4 and F5 each carry a recorded disposition (routed | deliberate-with-reason) in
  `prds/research/offrepo-f4-f5-disposition.md`, each citing its site by `file:line`. — Verify:
  `test -f` and the file names both sites — Type: test

### WS-OFFREPO-4 — verification on a repo that is NOT pickle-rick (**mandatory**)

The self-build cannot exercise the bug (§0). This bundle is unproven without an off-repo run.

- **AC-OFFREPO-4a**: a pipeline (or a scoped harness run) executes ≥1 ticket in a working dir with **no
  `extension/` directory**, and `prds/research/offrepo-field-result.md` records, per ticket: the
  detected project type, whether the gate executed, and the resulting verdict. **A run in which every
  verdict is `green` with no gate execution is a FAILED bundle, stated as such.** — Verify: `test -f`
  and the file names a working dir, a project type, and a verdict per ticket — Type: test

## 5. Simplification Review

1. **Necessary?** WS-1 changes a returned value and adds one residual event. WS-2 adds **no** new
   mechanism — it calls an existing exported primitive. WS-3/WS-4 add no code.
2. **REUSE not ADD?** This is the whole design: `detectProjectType` / `canRunTestScript` /
   `getWorkspacePackages` already exist, are already exported, and already solve repo-agnostic command
   resolution for the convergence gate. Building a second resolver would be the defect.
3. **Guards brittle complexity that should be SUBTRACTED?** Yes — five `existsSync(<wd>/extension)`
   special cases are the brittle thing. They encode "this repo is pickle-rick" as a precondition for
   quality. WS-2 deletes that precondition at F1; WS-1 removes the false `green` at F2/F3.
4. **SUBTRACTS:** the pickle-rick-shaped special case at the gate seam, two `'npm'` hardcodes, and one
   class of fake-green. Net-negative LOC is the expected shape.

## 6. Risks

- **R1 — fail-closed by accident.** Making the gate real off-repo could start refusing Done flips on
  target repos whose suites are red for inherited reasons. **Mitigated by directive 2 and AC-1b:**
  `not_run` and red both *flag*; neither halts. Do NOT fail-closed on raw red — that would deadlock
  every ticket on inherited debt (the explicit R-WGVI warning).
- **R2 — running an unknown repo's test suite is slow or destructive.** Bound it with the existing
  worker test-gate timeout (`PICKLE_WORKER_TEST_FAST_TIMEOUT_MS`); reuse, do not add a new budget.
- **R3 — the self-build proves nothing** (§0). WS-4 is the mitigation and must not be dropped or
  parked to reach a green bundle.
- **R4 — scope creep into a stack matrix.** Pinned by AC-2c.

## 7. Implementation Task Breakdown

| Order | Title | Tier | Files |
|---|---|---|---|
| 10 | WS-OFFREPO-1: `not_run` disposition; stop minting `green` at F1/F2/F3 | large | `extension/src/bin/mux-runner.ts`, `extension/bin/mux-runner.js`, `extension/src/bin/spawn-morty.ts`, `extension/bin/spawn-morty.js`, `extension/tests/**` |
| 20 | WS-OFFREPO-2: route the worker gate through `detectProjectType`/`canRunTestScript`; drop the `npm` hardcodes | large | `extension/src/bin/spawn-morty.ts`, `extension/bin/spawn-morty.js`, `extension/src/bin/mux-runner.ts`, `extension/bin/mux-runner.js`, `extension/tests/**` |
| 30 | WS-OFFREPO-3: record F4/F5 dispositions | small | `prds/research/offrepo-f4-f5-disposition.md` |
| 40 | WS-OFFREPO-4: off-repo field verification | medium | `prds/research/offrepo-field-result.md` |

> **Scope note:** tickets 10 and 20 include the **compiled mirror** (`extension/bin/*.js`) alongside the
> `.ts` sources. Tests import the mirror; a src-only commit is `outside_scope` at the fence and leaves
> the gate measuring pre-fix code.
