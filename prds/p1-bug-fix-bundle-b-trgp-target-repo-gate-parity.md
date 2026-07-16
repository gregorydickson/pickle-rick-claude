---
title: "B-TRGP — Target-Repo Gate Parity: make Done mean something on ANY repo"
priority: P1
r_codes: [B-TRGP, R-TCVC]
status: build-ready
build_protocol: PIPELINE
line: release/v2.1-beta
composes: []
---

# B-TRGP — Target-Repo Gate Parity

**One thesis: on a target repo, "Done" currently means nothing — subtract the pickle-rick-specific
gate and reuse the portable gate the review phases already run.**

This is the single highest-leverage reliability fix under the operator frame (*subtract brittleness ·
increase simplicity · enable reliable autonomous development on OTHER repos*). It is **subtractive**
(delete a hardcoded repo-specific assumption — the repo-agnosticism INVARIANT's canonical defect) and
**reuse, not add** (route through `runGate`/`detectProjectType`, which already exist and are already
called by anatomy-park / szechuan / citadel).

## ⚠ REFINEMENT CORRECTION (2026-07-16, verified against `release/v2.1-beta` source)

The refinement analysts (3 roles × 3 cycles) caught a FALSE premise in the first draft, since verified
against source and MEASURED on real target repos:

- **"The honest-degradation machinery already exists, it just wrongly degrades to green" is WRONG.** An
  unrunnable/missing script currently → **`red`**, not green. `runGateCheck` (`convergence-gate.ts:1013-1015`)
  returns BOTH `failures` (the generic `ERR_PNPM_NO_SCRIPT` failure from `buildFailures:711-720`) AND an
  advisory `unrunnable` tag; `realFailures = applyFlakeFilter(allFailures)` (`:1355`) subtracts only known
  FLAKES — never unrunnable — so `status = realFailures.length===0 ? 'green':'red'` (`:1232`) goes **red**.
  `unrunnableCheck` is consulted ONLY in baseline mode (`logUnrunnableCheckIfBaseline:1352`), advisory.
- **MEASURED:** octy (pnpm; no `typecheck`, no `lint:quiet` script) and loanlight-api (4-pkg pnpm workspace;
  `lint:quiet` missing in 3/4 pkgs) both resolve **red on healthy code** under `runGate({mode:'strict'})`.
  So naively routing the build gate through `runGate` swaps the current fail-OPEN no-op for a fail-CLOSED
  regression that blocks EVERY Done on a target repo lacking the exact script names. Equally broken.
- **There is a SECOND, opposite path**: `canRunTestScript` returning false (unsafe/e2e leaf, or no safe
  runner — e.g. `test: "echo 'No tests'"`) hits the bare `continue` at `:1059` and **vanishes with no
  failure and no unrunnable tag** → silently green. And `if (!cmd) continue` (`:1058`) does the same.

⇒ **The fix is bigger than a 15-line adapter: it must FINISH the incomplete unrunnable separation in
`convergence-gate.ts` (still subtractive-leaning — completing a half-built distinction, not adding a
parallel mechanism), THEN map the cleaned result to a verdict.** Design (the honesty principle / R-TCVC):
a check that could not actually verify the worker's diff is neither `green` NOR `red` — it is **`absent`**.
WS-2 below is rewritten accordingly. AC-TRGP-3 / AC-TRGP-6 reshaped to universal quantifiers (the analysts
produced three different site counts reading the old enumerated ACs — the enumeration shape was itself a
defect).

## The defect (verified against `release/v2.1-beta` source, 2026-07-16)

The worker gate — the ONE mechanism that stops the runner stamping `Done` over unverified work — is a
**no-op on every repo that is not pickle-rick-claude**, because it is gated on a hardcoded `extension/`
sentinel directory. On octy / loanlight-api / any target repo, it returns green having lint/type/test-checked
**nothing**. All 25 loanlight-api sessions stamped `Done` with a green gate that verified nothing.

**The fail-open ⇄ fail-closed inconsistency (the core bug): the same "is there an `extension/` dir?"
question is answered oppositely at sibling sites.**

| # | Site | `file:line` | Off-repo result | Class |
|---|---|---|---|---|
| 1 | `runWorkerGate` | `spawn-morty.ts:1538-1553` | `{ok:true}` — skips eslint/tsc/test | **FAIL-OPEN** |
| 2 | `resolveWorkerGateVerdict` (Done-flip authority) | `mux-runner.ts:4643-4647` | `{verdict:'green'}` | **FAIL-OPEN** |
| 3 | `extensionGreenGate` (file-touch attribution) | `mux-runner.ts:4669-4672` | `'failing'` | **FAIL-CLOSED** |
| 4 | `commitGatePassingDeliverableOnExitPath` (salvage committer) | `mux-runner.ts:5153-5154` | `{committed:false, reason:'no-extension-dir'}` | declines |
| 5 | `runBetweenTicketFastGate` | `mux-runner.ts:670-671` | `null` (gate skipped) | **FAIL-OPEN** |

Site 2 is the Done-flip authority (consumed by `evaluateCompletionEvidence`'s `workerGateRefusal` for
`decision:'done-flip'`). Its off-repo `green` is what stamps `Done` over never-checked code. Its own doc
comment (`mux-runner.ts:4630-4646`) concedes it is *"NOT fail-closed"* off-repo. **R-CWGE's trap-door
invariant ("Done requires a GREEN worker-gate verdict") is VACUOUS outside this repo.**

## The reuse target already exists (contract match — MANDATORY authoring artifact)

The review phases already carry a portable, project-type-aware gate. The build phase just doesn't call it.

- `detectProjectType(workingDir): 'pnpm'|'npm'|'yarn'|'cargo'|'go'|'bun'|null` — `convergence-gate.ts:362`
  (lockfile/manifest probe).
- `runGate(opts): Promise<GateResult>` — `convergence-gate.ts:1323`. Maps project type →
  `data/gate-commands.json[projectType]` real commands, reads the target's own `package.json` scripts,
  and **already distinguishes** ran-and-failed / missing-script / unrunnable / unsafe-e2e via
  `canRunTestScript` (`:911-932`), `classifyUnrunnableCheck` + `UNRUNNABLE_CHECK_PATTERNS` (`:728-742`),
  and `UNSAFE_TEST_SCRIPT_REGEX` (`:100`).

**Side-by-side contract (research artifact, per prds/CLAUDE.md contract-match rule):**

| | `runWorkerGate` (build-phase, off-repo no-op) | `runGate` (portable, review-phase) |
|---|---|---|
| Repo detection | hardcoded `fs.existsSync(<wd>/extension)` (`:1538`) | `detectProjectType(workingDir)` lockfile probe |
| Command source | hardcoded `npx eslint extension/src`, `npx tsc`, `npm run test:fast/integration` | `gate-commands.json[projectType]` + target `package.json` scripts |
| Off-repo behavior | `{ok:true}` — skips all checks | `status:'green'` **+ `gate_skipped` reason** (`no_project_type_detected` / `project_type_low_confidence`) |
| Missing/unsafe script | none | `classifyUnrunnableCheck` / `canRunTestScript` block + telemetry |
| Output verdict shape | boolean `ok` + counts | tri-state `status:'green'|'red'|'green-with-known-flake-warnings'` + `failures[]` |

**The adapter — `mapGateResultToWorkerVerdict(GateResult): 'green'|'red'|'absent'` — depends on WS-2(a)/(b)
first** (see the correction above: today an unrunnable check is BOTH a red failure and an advisory tag, and
silent-skips vanish, so the raw `GateResult` cannot be mapped honestly). After WS-2 cleans the result:
`red` iff ≥1 RUNNABLE failure; `green` iff ≥1 required check ran-and-passed with 0 runnable failures and 0
required-but-unrunnable checks; else **`absent`** (`detectProjectType===null`, low-confidence,
every-required-check-unrunnable, all-e2e-blocked, `bun` with no `gate-commands.json` entry).
`guardCompletionCommitBeforeDone` already fail-closes on `absent` — so `absent` IS the honest "can't verify
here" verdict R-TCVC demands. The fix does NOT fabricate green, does NOT go red on healthy target-repo code
lacking a script, and does NOT invent a per-stack adapter matrix; it reads the target's own manifest.

## Workstreams

### WS-1 (B-TRGP) — route the build-phase gate through the portable gate [SUBTRACTIVE]
- Delete the `!fs.existsSync(<wd>/extension) → {ok:true}` shortcut in `runWorkerGate`
  (`spawn-morty.ts:1538-1553`). When no `extension/` dir is present, call
  `runGate({workingDir, mode:'strict', checks:['typecheck','lint','tests']})` and translate its
  `GateResult` into the `WorkerGateResult` shape (ok = status green; lint/tsc/test failures mapped from
  `GateResult.failures`).
- Route `resolveWorkerGateVerdict`'s off-repo path (`mux-runner.ts:4643-4647`) through the same portable
  gate via the new `mapGateResultToWorkerVerdict` adapter, so the Done-flip authority resolves the REAL
  verdict on a target repo (`green`/`red`/`absent`) instead of a hardcoded `green`.
- **pickle-rick-claude itself is unchanged**: when `extension/` IS present, the existing native gate
  (eslint `extension/src`, `tsc`, `test:fast`/`integration`) still runs — it is the pickle-rick project's
  own richer gate, kept. (AC below pins that self-repo behavior is byte-identical.)

### WS-2 (R-TCVC) — finish the unrunnable separation, then map to a verdict [CORRECTED — convergence-gate plumbing + adapter]
Per the refinement correction, the unrunnable distinction in `convergence-gate.ts` is half-built. Finish it
so a check that did not actually run-and-pass is neither red nor a false green, then map to a verdict:
- **(a) Exclude unrunnable-classified failures from `realFailures` (strict mode).** In the `finalGateResult`
  path, partition `allFailures` by `isUnrunnableCheckResult`-equivalent so an `ERR_PNPM_NO_SCRIPT` /
  ENOENT / exit-127 result does NOT count toward `status:'red'` (it currently does — `:1232`). Surface the
  unrunnable set on `GateResult` (e.g. `unrunnable_checks: UnrunnableCheck[]`) in strict mode, not only
  baseline. This is the completion of R-SZGB-D, which added the classifier but never subtracted it in
  strict mode.
- **(b) Make the silent-skip paths OBSERVABLE.** `canRunTestScript`-false (`:1059`) and `if(!cmd)continue`
  (`:1058`) currently drop a check with zero trace → false green. Record each as an unrunnable/absent
  signal (a check that was required but could not run) so the verdict can tell "verified clean" from
  "nothing ran."
- **(c) Verdict adapter `mapGateResultToWorkerVerdict(GateResult): 'green'|'red'|'absent'`:** `red` iff ≥1
  RUNNABLE (real) failure; `green` iff ≥1 required check actually ran-and-passed AND 0 runnable failures AND
  0 required-but-unrunnable checks; else **`absent`** (`detectProjectType===null`, low-confidence,
  every-check-unrunnable, all-e2e-blocked). `guardCompletionCommitBeforeDone` already fail-closes on
  `absent` — so a target repo the gate genuinely cannot verify DEFERS (no false green, no false red on
  healthy code).
- **(d) `bun` entry in `data/gate-commands.json`** (`bun run typecheck`/`bun run lint`/`bun test`) so bun
  repos verify rather than resolve `absent` — small DATA, not machinery.
- **Fixtures MUST include the measured reality:** octy (pnpm, no `typecheck`/`lint:quiet`) and a
  loanlight-api-shaped workspace (missing `lint:quiet` in some packages) resolve `absent`/`green` on healthy
  code, NEVER `red`; a genuine tsc/eslint/test failure resolves `red`.

### WS-3 — reconcile the disagreeing siblings [SUBTRACTIVE / consistency]
- `extensionGreenGate` (`mux-runner.ts:4669-4672`, off-repo `'failing'`), `runBetweenTicketFastGate`
  (`:670-671`, off-repo `null`), and `commitGatePassingDeliverableOnExitPath` (`:5153-5154`) must derive
  from the SAME portable verdict so fail-open and fail-closed stop contradicting each other. Pin the
  single-source with a call-site audit (the R-AFCC-CALLER-ENUMERATION pattern) so a future divergence
  fails the gate.

## Simplification Review (subtract-before-add — REQUIRED, per WS)

**WS-1.** (1) *Necessary?* Yes — the gate verifies nothing off-repo. (2) *Reuse not add?* **YES — the entire
fix is reuse**: `runGate`/`detectProjectType`/`gate-commands.json` already exist and are already the
review-phase gate. The only new code is one ~15-line `GateResult→verdict` adapter. (3) *Guards brittle
complexity that should be subtracted?* Yes — it **deletes** the hardcoded `extension/` sentinel, the exact
repo-dependent assumption the repo-agnosticism INVARIANT calls a defect. (4) *Subtraction?* The
`existsSync(extension)→ok:true` no-op branch is deleted; two divergent gate implementations (build-phase
hardcoded vs review-phase portable) collapse toward one.

**WS-2.** (1) Necessary — verified: today unrunnable → false RED on healthy target repos AND silent-skip →
false green; both are wrong. (2) Reuse-leaning — the classifier (`classifyUnrunnableCheck`,
`isUnrunnableCheckResult`, `canRunTestScript`) ALREADY exists; WS-2 FINISHES the separation it started
(exclude unrunnable from `realFailures`, make silent-skips observable) rather than adding a parallel gate.
This is completing R-SZGB-D, not a new mechanism. (3) It subtracts the double-count (unrunnable-as-red) and
the silent skip-to-green vanish. (4) The bun data entry is additive but CONFIG parity, not machinery.
**Honest note:** this is LESS purely-subtractive than the first draft claimed — it adds a `realFailures`
partition + an `unrunnable_checks` field on `GateResult` + the adapter. Still net-simplifying (one verdict
seam, one honest classification) and firmly reuse-over-parallel, but not zero-add.

**WS-3.** (1) Necessary — contradictory sibling verdicts are their own defect. (2) Reuse the WS-1 adapter.
(3/4) Collapses 5 divergent per-site answers onto ONE portable verdict + a call-site audit pin.

## Explicitly OUT of scope — R-ORSR-2 (split to its own PRD)

R-ORSR-2 (the Done-flip accepting an R-ORSR-2 *commit-and-continue salvage* commit as completion evidence
without re-running the ticket's own grep/e2e AC) is a **distinct mechanism** and its full fix is
**ADDITIVE** — the research confirmed **no AC-execution helper exists anywhere** in the codebase; closing it
means building one (running a ticket's frontmatter `acceptance_test`). Per subtract-before-add, that does
NOT belong in this pure-subtraction bundle. It gets its own PRD, where the subtractive alternative (reject a
bare recovery/salvage commit as SOLE Done evidence — detect the `R-ORSR-2`/`commit-and-continue` marker)
is weighed against the additive AC-runner. **B-TRGP makes the gate real; it does not run per-ticket ACs —
say so, don't let the thesis swallow R-ORSR-2.**

## Build protocol: `/pickle-pipeline` (PIPELINE-SAFE — dogfood, do NOT hand-build)

This touches `resolveWorkerGateVerdict` / `guardCompletionCommitBeforeDone` — the Done-flip path — so it
LOOKS like an R-PSRB hand-build. It is not. **The R-PSRB test is "does the deployed BUGGY behavior bite the
worker building the fix?" — not "does it touch mux-runner."** B-TRGP's bug is **off-repo only** (the
`!fs.existsSync(<wd>/extension)` no-op branch). The pipeline builds B-TRGP with `working_dir` =
pickle-rick-claude, which **HAS** `extension/`, so the deployed runtime takes the ON-repo native-gate path
for every build worker — the changed off-repo branch is **never exercised** during the build. AC-TRGP-4
pins on-repo behavior byte-identical, so WS-3's sibling reconciliation doesn't perturb the build worker
either. ⇒ **fully pipeline-safe; launch via `/pickle-pipeline`.** (Precedent: B-RASO beta.43 shipped a
salvage-path fix via an attended pipeline for the same "the deployed bug never fires on the build worker"
reason.) Per operator directive 2026-07-16: **NOTHING is hand-built — always run a pipeline.**

**Trap-doors / tests to update in LOCKSTEP** (changing the off-repo verdict shape will red these until
synced): `extension/tests/completion-authority-single-source.test.js`, the R-CWGE trap-door in
`extension/CLAUDE.md` (worker-gate verdict reach) + its
`extension/tests/integration/codex-worker-gate-fail-closed.test.js`, the B-1SEAM completion-predicate
single-seam audit, `extension/tests/worker-gate-verdict-recompute.test.js`, and
`bash extension/scripts/audit-trap-door-enforcement.sh`. The AC-D4 completion-authority allowlist pins the
Done-flip write sites.

## Acceptance Criteria (machine-checkable)

- **AC-TRGP-1** — `it("runWorkerGate on a repo with NO extension/ dir runs the portable gate (detectProjectType + gate-commands.json), not a bare ok:true no-op")` — assert the `existsSync(extension)→ok:true` early return is gone and a project-typed fixture (e.g. a pnpm repo) actually runs its lint/typecheck/test.
- **AC-TRGP-2** — `it("resolveWorkerGateVerdict returns red on a target repo whose portable gate fails, and green only when it actually passes")` — no hardcoded off-repo green.
- **AC-TRGP-3 (R-TCVC, universal)** — `it("for ANY gate check that did not actually run-and-pass, the verdict is never 'green' and never 'red' — it is 'absent'; and any check that DID run and fail is 'red'")`. Property-style over the outcome classes {ran-passed, ran-failed, missing-script, unsafe/e2e-blocked, no-safe-runner, no-cmd, timeout, detectProjectType-null, low-confidence, bun-no-entry}. Includes the MEASURED cases: octy + loanlight-api-shaped workspace on healthy code → `absent`/`green`, never `red`; `guardCompletionCommitBeforeDone` refuses the Done-flip on `absent`.
- **AC-TRGP-3b** — `it("an unrunnable check (ERR_PNPM_NO_SCRIPT/ENOENT/exit127) is excluded from realFailures in strict mode, so healthy code with a missing script is not red")`.
- **AC-TRGP-4** — `it("pickle-rick-claude itself (extension/ present) runs the unchanged native gate — behavior byte-identical to pre-fix")`.
- **AC-TRGP-5** — `it("bun repo with a gate-commands.json bun entry verifies via bun run; without it degrades to absent, never green")`.
- **AC-TRGP-6 (WS-3, universal — reshaped)** — `it("EVERY off-repo gate site derives its verdict from the ONE portable-gate seam")` — the full set of FIVE from the defect table (`runWorkerGate`, `resolveWorkerGateVerdict`, `extensionGreenGate`, `runBetweenTicketFastGate`, `commitGatePassingDeliverableOnExitPath`); a call-site audit asserts no bare off-repo constant (`ok:true` / `'green'` / `'failing'` / `null` / `'no-extension-dir'`) survives. (The old AC named only 3 sites; the analysts produced three different counts reading it — the enumeration shape was the defect.)
- **AC-TRGP-7** — the lockstep trap-door/test set above is green; `audit-trap-door-enforcement.sh` passes.

## Risks

- **Verdict-shape churn on the Done-flip authority** — the highest-risk edit. Mitigate: change the adapter,
  not the `evaluateCompletionEvidence` predicate; keep `absent` semantics identical; update the pinning
  tests in the same commit; verify the full release gate (this is where R-CWGE/B-1SEAM live).
- **A newly-real gate could RED a target-repo bundle that used to sail through on fake green** — that is the
  POINT (it was never verified), but it will surface latent target-repo failures. Land with the honest
  `absent` degradation so genuinely-unverifiable repos defer rather than hard-fail.
- **Do NOT drift toward a per-stack adapter matrix** — if a project type needs handling, add a
  `gate-commands.json` DATA row (like bun), never a code branch per stack. That is the repo-agnosticism
  invariant.
- **Fail-CLOSED-too-hard is as broken as fail-open (verified live)** — naively routing through
  `runGate({mode:'strict'})` reds octy/loanlight-api on HEALTHY code (missing `typecheck`/`lint:quiet`
  scripts). WS-2(a)/(b) MUST land before/with WS-1, and the octy + loanlight-api fixtures MUST prove
  healthy-code-with-missing-script → `absent`/`green`, never `red`.
- **WS-2 also touches `convergence-gate.ts`, which the review phases (citadel/anatomy/szechuan) call** — but
  the change only affects the unrunnable/skip classification; on pickle-rick-claude (npm, all scripts
  present) the review phases of THIS pipeline run take the ran-and-passed path unchanged, so the build stays
  pipeline-safe and the same run self-tests the change. Pin review-phase behavior with an AC.
