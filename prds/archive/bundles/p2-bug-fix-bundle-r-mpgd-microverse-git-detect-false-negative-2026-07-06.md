# P2 Bug-Fix Bundle — R-MPGD: microverse dirty-tree git detection must use the work-tree signal, not a naive `.git`-direct-child test

**Priority:** P2 (HIGH — reliability + honesty. No data loss: the build commits survive. But on **any
monorepo package subdir** — the common case, `packages/api`, `packages/app` — the two most expensive
review phases [anatomy-park, szechuan-sauce] are **silently skipped** and the pipeline reports
`4/4 completed successfully` on a green ledger. The recovery the operator expects *already exists* and
simply mis-fires.)
**Code:** R-MPGD (Microverse Preflight Git-Detection false-negative)
**Backend:** claude (repairs the review-phase microverse dirty-tree seam; codex irrelevant to the mechanism).
**Build-safety note:** **Pipeline-safe — NOT the R-PSRB salvage/completion/Done-flip path.** Edits live in
`extension/src/bin/microverse-runner.ts` (the dirty-tree preflight + auto-rescue seam) and the
phase-outcome classifier in `extension/src/bin/pipeline-runner.ts`. Neither touches
`salvage-ticket.ts` / `reconcile-ticket-truth.ts` / `ticket-completion-evidence.ts` / the mux-runner
Done-flip — the running pipeline executes DEPLOYED JS, so this builds normally on its own pipeline; the
closer's full gate is the authoritative backstop.
**Source anchor:** verified against HEAD `0c99680a` (2026-07-07). All cited lines land verbatim; refresh
before build if HEAD moved.

> **⚠ Refined 2026-07-07 (3-cycle analyst team, session `2026-07-07-30904428`).** The first-draft WS-2
> targeted a **phantom function** (`getPhaseExitReason` — 0 grep hits; the author misread
> `getRecoverablePhaseFailureReason:2862`, a telemetry-string builder that gates nothing). As first
> written WS-2 would change **zero behavior** and ship the honesty bug unfixed. This revision routes WS-2
> to the **real** mislabel seam (`runPhaseIteration:4006` → `finalizePhaseSuccess:4131/4137`), pins the
> discriminator to `pass_counts` all-zero, and co-scopes the `PhaseSkipReason` union extension to avoid a
> scope-fence deadlock. WS-1 was confirmed precise.

> **▶ BUILD SCOPE (operator decision 2026-07-07): WS-1 ONLY. WS-2 is DEFERRED — see the WS-2 section.**
> Held to the north star (reliability of autonomous execution first; quality/correctness second; subtract
> brittleness). WS-1 is the reliability fix + a net-subtraction (2 naive checks → 1 helper). WS-2 serves
> goal #2 (ledger honesty), changes zero runtime behavior, and *adds* the exact brittleness class we are
> fighting — a new classifier keyed on `pass_counts`, a field written **out-of-process** by the skill
> subprocess (R6: read-after-write race → a completed phase could be mis-marked skipped). Crucially, once
> WS-1 lands the R-MPGD abort no longer fires on monorepo subdirs, so WS-2 defends a door WS-1 just locked.
> If the honesty gap ever bites, prefer the **subtractive** root fix [[B-CSOR]] (citadel commits its own
> remediation → no dirty tree → no abort → nothing to mislabel) over adding this classifier.

---

## Context

Live forensics of pipeline session `2026-07-05-f923a9c4` (target `loanlight-api`, LOA-1570 Phase 5,
build→citadel→anatomy-park→szechuan-sauce, "4/4 completed", 124m). PICKLE committed 4/4 tickets clean;
CITADEL remediated 2 mechanical findings and **left them uncommitted** ([[B-CSOR]]), so the tree was
dirty entering the review phases. Then **both** microverse phases exited in **under one second, zero
passes**:

```
PHASE 3/4: ANATOMY-PARK … Anatomy Park setup complete
  microverse-runner: ERROR: Working tree is dirty — uncommitted in-scope changes detected. Aborting.
  microverse-runner: ERROR: No .git repository found at working directory. Cannot auto-commit.
Phase anatomy-park exited with code 1 (non-fatal) — continuing to szechuan-sauce for automated remediation
Phase anatomy-park completed successfully          ← reported as success
PHASE 4/4: SZECHUAN-SAUCE … (identical abort)
Pipeline finished: 4/4 phases, 124m 2s
```

`anatomy-park.json`: `pass_counts:{packages:0}`, `findings_history:{packages:[]}`. `pipeline-status.json`:
`{"status":"completed","completed_phases":4,"skipped_phases":0}`. The skip was invisible without reading
`microverse-runner.log`.

**Root cause (one sentence):** the microverse dirty-tree recovery gates on
`fs.existsSync(path.join(workingDir, '.git'))` — a naive direct-child test that only holds when `.git` is
an immediate child of `workingDir`, so it false-negatives on a monorepo package subdir (git root one
level up), git worktrees, and submodules, defeating a recovery path that already exists.

**Verified against source at HEAD `0c99680a`:**
- `extension/src/bin/microverse-runner.ts:2935` — `if (!fs.existsSync(path.join(workingDir, '.git'))) {` —
  the **setup preflight** (`preflightAutoCommit`, `:2926`, exported/injectable). On false-negative it
  THROWS → the whole phase aborts at setup (`pass_counts:0`).
- `extension/src/bin/microverse-runner.ts:3619` — `if (!fs.existsSync(path.join(ctx.workingDir, '.git'))) {` —
  the **worker-timeout auto-rescue** (`autoRescueDirtyTree`, `:3610`, exported/injectable). On
  false-negative it RETURNS/skips (`"Auto-commit skipped: not a git repository"`) → a timed-out worker's
  dirty in-scope output is **silently discarded** rather than salvaged (adjacent to the [[R-MACB]] salvage
  machinery this path already uses at `:3623`+). So D1 has TWO failure modes on monorepo subdirs, not one.
- Precedent for the correct test already lives in-repo: `circuit-breaker.ts:225` uses
  `git rev-parse --is-inside-work-tree` with `cwd: workingDir`; `pipeline-runner.ts:655`/`:3273`,
  `mux-runner.ts:814`, `resolve-scope.ts:18` use `git rev-parse --show-toplevel`. This bundle REUSES that
  established signal.

Control only *reaches* `:2935` because `listWorkingTreeDirtyPaths(workingDir)` (`:2927`) already ran
`git status` from `workingDir` successfully — proving `workingDir` IS inside a work tree. Every other git
call in the file uses `cwd: workingDir` and works. **Only the two `existsSync` short-circuits are naive.**

Distinct from [[R-MACB]] (auto-rescue *scope-leak* — what gets staged), [[B-GNDT]] (launch-time
pre-pipeline preflight), and [[B-GNXR]] (no-progress discards uncommitted output). Source of the
inter-phase dirt is [[B-CSOR]] (citadel remediation left uncommitted) — a separate, deeper root fix; this
bundle is the safety net that makes the *existing* recovery fire regardless.

---

## WS-1 — R-MPGD-A: one shared work-tree test at BOTH microverse git-detect sites

**complexity_tier: medium** (core review-phase runner; the commit-scope activation risk R1 means AC-A3/A4
must run at the worker gate — `small` skips `test:fast`).

### Problem
Two sites gate the microverse dirty-tree recovery on `fs.existsSync(path.join(<dir>, '.git'))`, a test
that is not a git-repo test — it false-negatives on monorepo subdirs / worktrees / submodules and
true-positives for a stray `.git` file. A partial fix touching only `:2935` leaves the `:3619` rescue
path broken and still losing timed-out work.

### Fix (reuse-first, net-subtraction: 2 naive checks → 1 correct helper)
1. **Introduce a named probe timeout constant** near the other in-file git timeouts:
   `const GIT_REV_PARSE_TIMEOUT_MS = 5_000;` — matches the sibling `rev-parse` probes
   (`resolve-scope.ts:18`, `pipeline-runner.ts GIT_REPO_ROOT_TIMEOUT_MS`). Do NOT reuse
   `GIT_TEMP_CHECKOUT_TIMEOUT_MS` (10_000, checkout-semantic) or `DEFAULT_PROBE_TIMEOUT_MS` (5000,
   backend-version-probe-semantic) — a named const makes AC-A5 deterministic.
2. **Extract ONE shared helper** in `microverse-runner.ts` (module-local, near the other git helpers,
   e.g. beside `getGitRestoreArgs`), matching the file's existing `execFileSync` idiom:
   ```ts
   function isInsideWorkTree(dir: string): boolean {
     // reuse the signal the file's dirty-detection already trusts; finite timeout, never throws
     try {
       const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
         cwd: dir, encoding: 'utf8', timeout: GIT_REV_PARSE_TIMEOUT_MS,
         stdio: ['ignore', 'pipe', 'ignore'],
       });
       return out.trim() === 'true';
     } catch { return false; }
   }
   ```
3. **Replace BOTH gates** with `if (!isInsideWorkTree(<dir>)) {` — `:2935` (workingDir, keeps the THROW:
   genuinely-not-a-repo is a real abort) and `:3619` (ctx.workingDir, keeps the RETURN/skip). Behavior on
   a genuine non-repo is UNCHANGED; only the false-negative on a real work tree is corrected, so the
   by-design auto-commit (`:2940`–`:2946`) and the auto-rescue salvage (`:3623`+) now fire in the
   monorepo-subdir case.
4. **DELETE** the now-dead naive checks (no fallback to `existsSync` — the work-tree signal subsumes it).

### Acceptance criteria (machine-checkable)
- **AC-MPGD-A1** `grep -c "existsSync(path.join(workingDir, '.git'))\|existsSync(path.join(ctx.workingDir, '.git'))" extension/src/bin/microverse-runner.ts` → **0** (both naive gates removed).
- **AC-MPGD-A2** `grep -c "function isInsideWorkTree" extension/src/bin/microverse-runner.ts` → **1**; both former gate sites call it.
- **AC-MPGD-A3** unit test: `preflightAutoCommit` invoked with `workingDir` = a **real subdir INSIDE a git repo** (git root one level up, no direct-child `.git`) and one dirty in-scope file **auto-commits AND commits ONLY the in-scope subdir file** — assert the exact committed path set contains the subdir file and NOT a sibling-package file (R1). Invoked with a genuinely-non-git tmp dir still **throws**.
- **AC-MPGD-A4** unit test: `autoRescueDirtyTree` on a **real monorepo-subdir** `ctx.workingDir` with dirty in-scope output **stages/salvages** (does not log "not a git repository" / skip); assert the committed/staged set is the owned subdir path, not the whole repo index (R1).
- **AC-MPGD-A5** `isInsideWorkTree` passes `timeout: GIT_REV_PARSE_TIMEOUT_MS` (5_000) to its git spawn (subprocess-audit clean). The `catch { return false }` branch is intentionally NOT distinguished from "provably not a work tree" — documented in R5, matches the pre-existing abort-on-`git-status`-failure at `:2927`.
- **AC-MPGD-A6** full worker gate green (`tsc --noEmit` + `eslint` + `test:fast`).

### Files (allowlist)
- `extension/src/bin/microverse-runner.ts`
- `extension/tests/<ws1-isinsideworktree>.test.js` (new)

---

## WS-2 (DEFERRED — NOT in this bundle) — R-MPGD-B: a 0-pass setup-abort is `setup_aborted`/skipped, not `completed successfully`

> **DEFERRED 2026-07-07 (operator).** Does not serve goal #1 (reliability of autonomous execution — zero
> runtime-behavior change); serves goal #2 (ledger honesty) at the cost of *adding* a cross-process-keyed
> classifier + closed-union extension (the brittleness class we are subtracting). Superseded in intent by
> the subtractive [[B-CSOR]] root fix. Retained below as the analyzed design record should the honesty gap
> later prove load-bearing on a non-R-MPGD abort cause.

**complexity_tier: medium** (new classifier with fast-tier regression risk [AC-B3]; hard file count 4–5;
the `PhaseSkipReason` union edit is guarded by two scope tests that must run).

### Problem
On the microverse setup-abort path, `runPhaseIteration` takes the recoverable-continue branch
(`pipeline-runner.ts:4012`) into `finalizePhaseSuccess` (`:4033`) → `counters.completed++` (`:4131`) +
`log("Phase … completed successfully")` (`:4137`). A phase that aborted at setup with **zero passes** is
indistinguishable in the ledger from one that ran fully and found nothing. The non-fatal *continue*
policy is correct; the *labeling* is a honesty defect — a green ledger hiding silently-deleted phases is
exactly the GA-bar honesty gate.

**The existing skip guard does NOT apply:** `shouldSkipAnatomyPhaseWithWarning` (`:2760`) triple-gates on
`phase==='anatomy-park'` (excludes szechuan-sauce), `exit_reason==='fatal'` (the R-MPGD abort is
**non-fatal**), and a `description`-stderr regex — the R-MPGD abort matches none. This is a **new sibling
classifier**, not an extension of that guard.

### Fix (labeling only — keep the non-fatal continue policy)
1. **Add a sibling classifier** `isMicroverseSetupAbort(rawPhase, exitCode, sessionDir): boolean`,
   invoked in `runPhaseIteration` immediately after the `skipWarning` block ends (`~:4006`), BEFORE the
   recoverable-continue branch (`:4012`) reaches `finalizePhaseSuccess` (`:4033`). Predicate:
   - `rawPhase ∈ {anatomy-park, szechuan-sauce}` AND `exitCode !== 0`, AND
   - read `sessionDir/<rawPhase>.json`; the **headline discriminator** is
     `Object.values(pass_counts).every(v => v === 0)` — correctly classifies both `{packages:0}` (the
     actual forensic state) and `{}` (vacuous) as setup-aborted. Do **NOT** key on `exit_reason` (R4).
   - **Absent / unreadable / parse-error `<rawPhase>.json`** on a non-zero exit ⇒ classify
     `setup_aborted` (fail-toward-honesty, R2). Use the runner's recoverable-read idiom
     (`readRecoverableJsonObject`/`try-catch`), never a raw `JSON.parse(fs.readFileSync)` that throws.
2. **On a hit**, before `finalizePhaseSuccess`:
   `counters.skipped++; counters.phaseSkips[rawPhase] = 'setup_aborted'; writeRunningStatus(runtime, counters, null);`
   `log('Phase <phase> setup-aborted (0 passes) — review did not run'); return {action:'continue'}`.
   Do **NOT** log `completed successfully` for this phase; do **NOT** edit `getRecoverablePhaseFailureReason`
   (telemetry-string only); `getPhaseExitReason` does not exist.
3. **Extend the closed union (Path B — required to carry the reason).** Add `'setup_aborted'` to
   `PhaseSkipReason` at `pipeline-runner.ts:127` (`'empty_scope' | 'no_subsystems' | 'setup_error' | 'setup_aborted'`)
   AND update the INVARIANT line `src/types/CLAUDE.md:22` in lockstep. The banner formatter (`:3745`) then
   renders `3/4 (1 skipped — anatomy-park: setup_aborted)`; `pipeline-status.json` gets the `phase_skips`
   entry (`:3377`). No new activity event.

### Acceptance criteria (machine-checkable)
- **AC-MPGD-B1** unit/integration test: a microverse phase exiting non-zero with `pass_counts` all-0 (`{packages:0}` fixture) increments `skipped_phases` and sets `phaseSkips[phase]='setup_aborted'` — NOT `completed_phases`, and is NOT logged `completed successfully`.
- **AC-MPGD-B2** the banner renders exactly `3/4 (1 skipped — anatomy-park: setup_aborted)` (via `skipDetail`/`phaseSkips`) and `pipeline-status.json` carries the `phase_skips` reason — assert the literal, not `4/4`.
- **AC-MPGD-B3** regression guard: a microverse phase that RAN and found nothing (non-zero exit, `pass_counts[sub] >= 1`) is STILL `completed successfully` with `skipped_phases` unchanged — the fix separates "never ran" from "ran, clean," it does not re-classify clean runs.
- **AC-MPGD-B4** absent/unreadable/parse-error `<phase>.json` on a non-zero microverse exit classifies `setup_aborted` (fail-honest), never `completed successfully` (R2).
- **AC-MPGD-B5** both `{anatomy-park, szechuan-sauce}` are covered — a szechuan-sauce setup-abort classifies identically (the forensic proves both abort the same way).
- **AC-MPGD-B-INCR** (empirical, R3/R6) — a fixture running ≥1 real convergence pass confirms `<phase>.json` `pass_counts[sub]` persists `>= 1`, citing the skill write site `.claude/commands/anatomy-park.md:520` (`pass_counts[subsystem] += 1`); grep-verify no `++`/assignment to `pass_counts` exists in `extension/src/` (only the `:2087` 0-init and the `:3816` B-APNC read). This pins "all-0 ⇒ never ran" as a *tested behavioral* invariant, not a runner-line citation.
- **AC-MPGD-B6** full worker gate green.

### Files (allowlist — co-scoped to break the scope-fence deadlock)
- `extension/src/bin/pipeline-runner.ts` — classifier + `PhaseSkipReason` union member
- `extension/src/types/CLAUDE.md` — invariant-doc lockstep (line 22)
- `extension/tests/anatomy-park-scope.test.js` — enforces the `PhaseSkipReason` invariant
- `extension/tests/szechuan-scope.test.js` — enforces the invariant (szechuan side)
- `extension/tests/<ws2-setup-aborted>.test.js` (new) — the classifier ACs

> **Deadlock warning:** omitting `src/types/CLAUDE.md` or either scope test from the allowlist makes
> `check-scope-diff.ts` block the union/doc/test edits → the ticket is unsatisfiable at zero commits
> (registration-co-location rule). Verified safe: `anatomy-park-scope.test.js:113/133/143` and
> `szechuan-scope.test.js:210` assert **specific** literals, never a full-union enumeration, so a fourth
> member breaks no existing assertion.

---

## Risks & Mitigations
- **R1 — Behavior activation (dead → live auto-commit on subdirs) [WS-1, highest runtime risk].** WS-1
  makes `preflightAutoCommit` (`git commit` @`:2946`, `cwd:workingDir`) and `autoRescueDirtyTree`
  (`git commit` @`:3651`) fire for the FIRST time when cwd is a subdir and the git root is one level up; a
  bare `git commit` from a subdir stages the whole repo index. R-MACB scope discipline was verified for the
  direct-child-`.git` case, not this. *Mitigation:* AC-A3/A4 use REAL subdir-inside-a-repo fixtures and
  assert the EXACT committed path set (only the in-scope subdir file), not merely "no throw."
- **R2 — `<phase>.json` absent/unreadable at classify time [WS-2].** A setup abort before persistence
  leaves `pass_counts` unreadable. *Mitigation:* absent/unreadable/parse-error on a non-zero exit ⇒
  `setup_aborted` (AC-B4), never success.
- **R3 — 0-pass ≠ never-ran ambiguity [WS-2].** That a completed no-findings pass increments `pass_counts`
  is a behavioral claim. *Mitigation:* AC-B-INCR verifies it empirically (≥1 real pass); AC-B3 pins that a
  ran-then-clean phase stays `completed`.
- **R4 — Discriminator keys on the wrong signal [WS-2].** The R-MPGD abort is logged NON-fatal; the
  existing seam gates on `exit_reason==='fatal'`. *Mitigation:* discriminate ONLY on `pass_counts` all-0
  (+ absent-json), never on `exit_reason` category.
- **R5 — git-CLI / submodule / transient-failure semantics [WS-1].** Inside a submodule the commit targets
  the submodule repo (accepted, not separately tested). A transient git failure/timeout resolves `false` ⇒
  abort at `:2935` — accepted, matches the pre-existing abort on any `git-status` failure at `:2927`.
- **R6 — Cross-process data dependency [WS-2].** `pass_counts` is written by the anatomy/szechuan skill
  subprocess (`anatomy-park.md:520`), NOT by any runner/state/gate TS (grep-verified: no `++`/assignment in
  `extension/src/`). *Mitigation:* the classifier reads `<phase>.json` only after the subprocess has fully
  exited (phase-exit, already true); treat partial/corrupt JSON identically to absent (→ `setup_aborted`);
  do not assume the invariant is statically verifiable — test it (AC-B-INCR).

---

## Simplification Review (subtract-before-add)

**WS-1 (R-MPGD-A).**
1. *Necessary?* Yes — the false-negative silently deletes two review phases and loses timed-out work on
   the common monorepo-subdir case.
2. *Reuse vs add?* **Reuse.** `git rev-parse --is-inside-work-tree` is already the signal the file's own
   dirty-detection relies on, used verbatim at `circuit-breaker.ts:225`. One module-local helper + one
   named timeout const; no new dependency, no new state field.
3. *Guards a brittle thing?* Yes — it deletes a naive guard rather than wrapping it.
4. *Subtracts?* **Yes — net-subtraction: 2 divergent naive checks → 1 correct shared helper** (the
   "collapse seams, don't gate them" move, [[feedback_analyze_failures_then_subtract_not_add_guards]]).

**WS-2 (R-MPGD-B) — honest scope accounting (corrected 2026-07-07).**
1. *Necessary?* Yes — a green ledger hiding a silently-deleted phase is an honesty defect on the GA bar.
2. *Reuse vs add?* **Partial reuse.** Reuses the `counters.skipped → skipped_phases` thread and the
   `<phase>.json` `pass_counts` field, but **adds**: (a) a new phase-outcome classifier (sibling beside
   `shouldSkipAnatomyPhaseWithWarning`, gating on `pass_counts`-all-0 across `{anatomy-park,
   szechuan-sauce}` — the three existing gates do NOT apply); (b) a new `<phase>.json` read across both
   phases; (c) a new `'setup_aborted'` member of the closed `PhaseSkipReason` union with its INVARIANT-doc
   update and both enforcing scope tests. `getPhaseExitReason` does not exist; do NOT edit
   `getRecoverablePhaseFailureReason` (telemetry only). **This is a new classifier across two phases plus a
   union extension — not "labeling only."**
3. *Guards a brittle thing?* It corrects an over-broad "non-fatal ⇒ success" label; narrows an existing
   seam, adds no guard-on-guard.
4. *Subtracts?* Removes the unconditional `completed successfully` on the 0-pass abort path (one honest
   label replaces one dishonest one), but is **net-additive in code** — tiered `medium` accordingly. The
   *maximally* subtractive alternative is [[B-CSOR]] (make citadel commit its own remediation so no phase
   inherits a dirty tree), scoped out below as the deeper root fix.

---

## Non-goals / out of scope
- **B-CSOR** (citadel remediation left uncommitted — the *source* of the inter-phase dirt) is a separate,
  deeper root fix. This bundle is the safety net that makes the existing recovery fire regardless. If the
  priority is *remove complexity* over *add a net*, B-CSOR is the more subtractive follow-on and makes
  R-MPGD vestigial over time.
- Changing the non-fatal *continue* policy (a failed review phase should still not abort the pipeline).
- **R-MACB** auto-rescue scope-leak (WHAT gets staged) — already shipped beta.37; this fixes WHETHER the
  rescue runs at all on a monorepo subdir. (But note R1: WS-1 newly activates the commit on subdirs, so
  AC-A3/A4 must assert commit-scope.)
- Committing into a submodule repo (R5) — accepted outcome, not separately tested.

## Build / verify
Build on claude via `/pickle-tmux` or `/pickle-pipeline`. Deploy `bash install.sh`. The closer's full
release gate (`tsc --noEmit && eslint && tsc && audits && test:fast:budget && test:integration &&
RUN_EXPENSIVE_TESTS=1 test:expensive`) is the authoritative backstop. Field-proof: re-run a
build→citadel→anatomy-park→szechuan pipeline whose ticket `working_dir` is a monorepo package subdir and
confirm anatomy-park/szechuan actually run their loops (`pass_counts >= 1`) instead of aborting <1s.
