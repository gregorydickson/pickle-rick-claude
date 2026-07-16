---
title: "B-TRGP — Target-Repo Gate Parity: make Done mean something on ANY repo"
priority: P1
r_codes: [B-TRGP, R-TCVC]
status: build-ready
build_protocol: R-PSRB-HAND-BUILD
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

**The one adapter required — `mapGateResultToWorkerVerdict(GateResult): 'green'|'red'|'absent'`:**
`green`/`green-with-known-flake-warnings` → `green`; `red` → `red`; **every skip/unrunnable outcome
(`no_project_type_detected`, `project_type_low_confidence`, `canRunTestScript`-blocked,
`classifyUnrunnableCheck` hit, `detectProjectType===null`, `bun` with no `gate-commands.json` entry) →
`absent`.** `guardCompletionCommitBeforeDone` already treats `absent` fail-closed — so `absent` IS the
honest "can't verify here" verdict R-TCVC demands. The fix does NOT fabricate green and does NOT invent a
per-stack adapter matrix; it reads the target's own manifest.

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

### WS-2 (R-TCVC) — honest degradation, never fabricated green [REUSE + tiny data add]
- The adapter maps every non-green/non-red outcome to `absent` (see contract above). A container-e2e-only
  repo (`UNSAFE_TEST_SCRIPT_REGEX` match → `canRunTestScript` false → check silently skipped) must NOT let
  the gate go green on typecheck+lint alone: an unrunnable **required** test check degrades the verdict to
  `absent`, not `green`.
- Add a `bun` entry to `data/gate-commands.json` (`bun run typecheck` / `bun run lint` / `bun test`) so bun
  repos VERIFY rather than degrade to `absent` — small DATA, not machinery. (Decision AC: add-bun vs
  bun→absent; default = add-bun, it's config parity.)

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

**WS-2.** (1) Necessary to avoid fabricating green on unverifiable repos. (2) Reuse — the
unrunnable/unsafe/missing classification ALREADY exists (`classifyUnrunnableCheck`, `canRunTestScript`); we
only change the degradation target from silent-skip-green to `absent`. (3) It subtracts the silent
skip-to-green path. (4) The bun data entry is additive but is CONFIG parity, not machinery.

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

## ⚠ R-PSRB — HAND-BUILD

Touches the salvage / completion-evidence / Done-flip path (`resolveWorkerGateVerdict` feeds
`buildCompletionCtx`/`guardCompletionCommitBeforeDone`; `commitGatePassingDeliverableOnExitPath` is the
salvage committer). The deployed pre-fix runtime applies this logic to the worker building the fix →
**hand-build**, not a `/pickle-pipeline` dogfood. Build then `install.sh`-deploy incrementally.

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
- **AC-TRGP-3 (R-TCVC)** — `it("an unrunnable/unsafe (e2e/container) or unresolved (detectProjectType null, bun-no-entry) gate maps to verdict:'absent', never 'green'")` — and `guardCompletionCommitBeforeDone` refuses the Done-flip on `absent`.
- **AC-TRGP-4** — `it("pickle-rick-claude itself (extension/ present) runs the unchanged native gate — behavior byte-identical to pre-fix")`.
- **AC-TRGP-5** — `it("bun repo with a gate-commands.json bun entry verifies via bun run; without it degrades to absent, never green")`.
- **AC-TRGP-6 (WS-3)** — a call-site audit asserts `extensionGreenGate`, `runBetweenTicketFastGate`, and `resolveWorkerGateVerdict` derive their off-repo verdict from the ONE portable-gate seam (no bare `'failing'`/`'green'`/`null` off-repo constants remain).
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
