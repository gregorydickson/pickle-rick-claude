# P2 Bug-Fix Bundle — R-SZGB: the per-iteration convergence gate fails OPEN on an undetectable project type

**Priority:** P2 (quality-gate integrity — a converged szechuan/anatomy exit can silently ship a
tsc/eslint-RED tree; no data loss because the closer's full release gate is the backstop, but the
per-phase gate does not hold its own typecheck contract).
**Code:** R-SZGB (Szechuan Gate Blind spot)
**Backend:** claude (this repairs the review-phase gate itself; do NOT soak it on codex — codex is
irrelevant to the mechanism, which is target-path resolution).
**Build-safety note:** **Pipeline-safe — the salvage / completion-evidence / Done-flip path is NOT
touched, so the R-PSRB hand-build protocol does NOT apply.** The edits live in
`extension/src/services/convergence-gate.ts` and `extension/src/bin/microverse-runner.ts` (the
per-iteration gate seam). ⚠️ **Self-referential-review caveat (NOT R-PSRB):** if built via
`/pickle-pipeline`, this build's OWN anatomy-park + szechuan phases run the DEPLOYED (still-broken)
gate against the repo root, so their per-iteration gates remain no-ops until `install.sh` deploys the
fix. That does not corrupt the build (the closer's full gate is authoritative), but it means the
review phases cannot self-validate the fix. **Deploy via `install.sh` immediately after the closer,
then run `/szechuan-sauce` over a known-RED tree (or the R-SIGF diff) as the live proof the gate now
bites.**
**Complexity tiers:** WS-1 `complexity_tier: medium` · WS-2 `complexity_tier: medium` (both edit the
core gate service and must run `test:fast` at the worker gate — a gate fix under `small` would SKIP
`test:fast` and re-introduce exactly this class of blind spot).

---

## Context

`/pickle-pipeline` ran B-SCOPESEED (codex, session `2026-07-02-b3c45331`) to a "clean" 4/4
hands-off finish, yet HEAD after the run was tsc-RED (5 type errors in `mux-runner.ts` from the
szechuan "Small Functions" commits), eslint-RED (`no-useless-assignment` in `pipeline-runner.ts`),
and carried 3 broken source-pin tests + compiled-JS drift — **none of it caught by the per-iteration
convergence gate, all of it caught only by the closer's full release gate**
(`BUG-REPORT-2026-07-03-szechuan-periteration-gate-converges-tsc-red-commits.md`).

**Mechanism — VERIFIED against the session artifacts (Hypothesis 2 of the bug report, refined):**

1. `detectProjectType(workingDir)` (`convergence-gate.ts:362`) inspects **only the exact
   `workingDir`** — `has(f) = fs.existsSync(path.join(workingDir, f))`, no ancestor/descendant walk.
2. The pipeline targeted the **repo root** (`microverse.json` → `prd_path:
   ".../pickle-rick-claude"`). That directory has **no `package.json` / lockfile** — they live one
   level down in `extension/` (verified: repo root has zero package files; exactly one immediate
   child, `./extension`, carries `package.json`). So `detectProjectType` returned **`null`**.
3. `runGate` (`:1219`): `if (!projectType) return emitSkippedAndReturn(opts, null,
   'no_project_type_detected', ...)`.
4. `emitSkippedAndReturn` (`:1200`) — **by deliberate design** (see its doc comment) — in baseline
   mode **persists a valid EMPTY baseline** (`persistGateBaseline(..., null, [], [], ...)`) so
   downstream `pathExists(baselinePath)` consumers do not read the skip as a missing-baseline error.
   The artifact proves it: `gate/baseline.json` = `{ "project_type": null, "checks": [], "failures":
   [] }`.
5. Every per-iteration replay then subtracts against **zero checks → zero new failures → "clean."**
   The tsc-RED commit `d30bab01` converged as "held: 3 vs 3" — judged green by the LLM
   principle-metric while the toolchain gate inspected **nothing**.

**The root is a fail-OPEN skip:** the gate treats "I could not find a project to check" as
"everything is fine" and lets convergence proceed. Two facts widen the blast radius beyond the bug
report:

- **Not szechuan-specific.** `microverse-runner.log:11` — `[anatomy-park] initialized per-iteration
  gate baseline (captured 0 pre-existing failure(s))`. Anatomy-park ran the *same* empty gate in the
  *same* run. R-SZGB is the whole per-iteration gate for any repo-root-above-package target.
- **Repo-root targeting is real pipeline behavior, not operator error** — `/pickle-pipeline` handed
  the gate the repo root; the package is a child. The fix cannot just hardcode "point at
  `extension/`."

Two seams close this: **run the gate against the real package (WS-1)** so it actually catches the
regression, and **fail-closed when it still cannot (WS-2)** so the fail-open hole can never again
greenlight red. Both reuse the existing `runGate`/convergence seam and existing persisted data — no
new gate, flag, or state field.

---

## WS-1 — R-SZGB-A: resolve the package root before declaring "no project type"

### Problem
`detectProjectType` inspects only the literal target directory. When the target is one level above
the package (the pipeline's repo-root targeting), it returns `null`, the gate is skipped, and an
empty baseline is persisted — so the gate never runs against the code that the iteration actually
changed.

### Fix
When `detectProjectType(target)` returns `null`, perform a **bounded downward resolution** for the
real project root before giving up:

- Search immediate child directories (depth 1; do NOT recurse into `node_modules`, dot-dirs, or
  known non-package dirs) for exactly one directory that `detectProjectType` resolves to a non-null
  type.
- **Exactly one** unambiguous candidate → use it as the gate working dir for this session
  (both baseline capture and replay resolve to the same dir — persist the resolved dir in the
  baseline so replay is consistent). Reuse the existing `detectProjectType` /
  `getWorkspacePackages` primitives; do NOT write a new project-detection routine.
- **Zero** candidates (genuinely toolchain-less target) or **two-or-more** (ambiguous monorepo) →
  do NOT guess. Fall through to the existing skip, which WS-2 now makes fail-closed for the
  convergence path.

Emit a LOG LINE (`gate: resolved project root <n> level(s) below target -> <dir>`) — do NOT add a
new activity event (event registration is a recurring closer-bug class; a log line is sufficient
observability).

Constraints:
- `convergence-gate.ts` must stay a general-purpose service — the resolution is data-driven
  (lockfile/`package.json` presence), never a hardcoded `extension/` path.
- Non-null `detectProjectType(target)` behavior is UNCHANGED — resolution only engages on the
  current `null` branch, so no existing single-package or workspace target regresses.

### Acceptance criteria (machine-checkable)
- **AC-SZGB-01:** New test proves: a fixture repo with NO package files at the target and exactly one
  child dir carrying `package.json` resolves the gate working dir to that child; `runGate` in
  baseline mode captures a **non-empty** `project_type` (not `null`) and the child's real checks.
- **AC-SZGB-02:** The same test proves: **zero** package children → `project_type` stays `null`
  (skip preserved); **two** package children → `project_type` stays `null` (ambiguous, no guess).
- **AC-SZGB-03:** Regression guard — a fixture whose target directory ITSELF has a `package.json`
  resolves to the target unchanged (no spurious descent), asserted in the test.
- **AC-SZGB-04:** No new activity event and no new state field: `git diff` for WS-1 adds no entry to
  the activity-logger expected-event list and no key to the state schema (grep-asserted in the test
  or via `audit-*` parity — resolution is surfaced by a log line only).

---

## WS-2 — R-SZGB-B: fail-CLOSED — an empty/undetectable baseline cannot certify convergence

### Problem
Even with WS-1, an ambiguous or genuinely undetectable target yields a `project_type: null` / empty
baseline. Today the convergence loop reads that empty baseline as **zero new failures = clean** and
lets the iteration converge — the fail-OPEN hole. A gate that inspected nothing must never certify a
tree as green.

### Fix
In the per-iteration / worker-managed convergence decision (`microverse-runner.ts`, the seam that
consumes the `runGate` result before signalling convergence), treat a gate whose baseline has
`project_type: null` (equivalently: zero captured `checks`) as **NON-CERTIFYING**: it must NOT count
as a clean pass — block/defer convergence and surface the reason. **Reuse the already-persisted
`baseline.project_type` field** (`gate/baseline.json`) as the signal — add no new field, flag, or
gate. Log `gate: uncertifiable baseline (no project type detected at target) — cannot certify
convergence`.

Constraints:
- No new state field / flag / skip surface / activity event — the decision keys on existing
  persisted `baseline.project_type` and routes through the existing convergence-exit seam.
- A target that legitimately resolves a project (WS-1 success, or a direct-target package) is
  unaffected — this branch only engages when the baseline is uncertifiable.
- Must cover BOTH the standard per-iteration replay exit AND the worker-managed convergence signal
  (`handleWorkerManagedIteration` / the "worker convergence signaled; running per-iteration gate
  before exit" path seen at `microverse-runner.log:21-22`).

### Acceptance criteria (machine-checkable)
- **AC-SZGB-05 (the headline repro, on the worker-managed path):** New test proves a szechuan/
  microverse iteration that commits a **tsc-RED** change against a target whose gate baseline is
  `project_type: null` **cannot converge** — the run blocks/defers (records the uncertifiable-baseline
  outcome) instead of returning `converged`. Exercises the worker-managed convergence path per the
  bug-report AC.
- **AC-SZGB-06:** With WS-1 resolving the package root, the SAME tsc-RED change now produces a REAL
  gate failure (a `tsc`/typecheck failure surfaces in the gate result / `tsc_gate_failed`-class
  outcome) rather than a silent skip — proving the end-to-end path (resolve → run → catch).
- **AC-SZGB-07:** Regression guard — a certifiable baseline (non-null `project_type`, clean tree)
  still converges normally (fail-closed does not over-block the healthy path).
- **AC-SZGB-08:** Mechanism finding recorded: a durable note (test comment or a one-paragraph repo
  doc) states Hypothesis 2 held, cites `gate/baseline.json` `project_type: null` from session
  `2026-07-02-b3c45331`, and that anatomy-park shared the defect — satisfying the bug-report's
  "mechanism finding documented" AC.

---

## Simplification Review (subtract-before-add) — REQUIRED

### WS-1 (package-root resolution)
1. **Necessary?** Yes — without it the gate never runs on the pipeline's real (repo-root) target
   shape; the incident recurs on every repo-root-above-package run. Adds a bounded resolution step,
   no new state/flag/gate.
2. **Reuse over add?** Yes — reuses `detectProjectType` and the existing `getWorkspacePackages`
   primitives; the only new code is a depth-1 child scan that calls the existing detector. No new
   project-detection routine, no new event (log line only).
3. **Guards existing brittle complexity?** It repairs the brittle `detectProjectType` (single-dir
   inspection) at its root rather than wrapping it — the null branch now tries to resolve before
   skipping. It does not add a guard around a guard.
4. **Subtracts?** Removes the silent-no-op class for the common monorepo-target shape. Net: the
   empty-baseline path stops being reachable on well-formed single-package-child targets.

### WS-2 (fail-closed invariant)
1. **Necessary?** Yes — it is the load-bearing safety invariant: "a gate that checked nothing must
   not certify green." Adds no new field/flag — keys on the already-persisted `baseline.project_type`.
2. **Reuse over add?** Yes — reuses the existing persisted `baseline.project_type` datum and the
   existing convergence-exit seam; no parallel gate or second baseline.
3. **Guards existing brittle complexity?** It converts the *deliberate fail-OPEN* skip
   (`emitSkippedAndReturn` persisting an empty baseline that reads as clean) from silent-pass to
   fail-closed for the convergence consumer. This is the honest fix to the brittle behavior, not a
   second escape hatch — the skip semantics for genuine non-baseline callers are untouched.
4. **Subtracts?** Removes the fail-OPEN certification path — a strictly smaller set of trees can be
   declared converged. No flag added; no new machinery.

**Bundle-level subtraction:** together the two WS delete the "empty baseline = clean" behavior
entirely: either the gate resolves and runs (WS-1) or it refuses to certify (WS-2). There is no
surviving path where a converged exit is backed by zero checks.

---

## Bundle thesis

**Fix the gate at the seam: resolve the real project root, and fail closed when you can't — so a
convergence gate can never again certify a tree it never inspected.** One defect class
(fail-OPEN-on-undetectable-project), two complementary edits in the one gate service, reuse-first,
no new gate/flag/state field. Covers szechuan AND anatomy-park (shared per-iteration gate).

## Out of scope
- The closer's full release gate (unchanged — it remains the authoritative backstop).
- Making per-phase gates run the FULL release gate (the broader autonomy-gap (a); tracked
  separately, not this bundle).
- The LLM principle-metric convergence judge (orthogonal — this bundle is only the toolchain gate).
- `scope-resolver.ts` fail-closed invariants (R-SSBR) — untouched.
