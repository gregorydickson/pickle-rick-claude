# B-PXBO — Phase-eXit Boundary reads the completion Oracle

| | |
|---|---|
| **Bundle** | B-PXBO |
| **Priority** | P2 (top of the P2 queue — codex GA-relevant; R-DPGT has 2 independent repros) |
| **Class** | Bug-fix — completion/recovery machinery |
| **Closes** | [[R-DPGT]] (2 repros) · [[R-DOTR]] (1 repro) · [[R-CRSR]] (1 repro, Facets A+B) · LOA-1588 no-op-audit evidence-misattribution sub-finding |
| **Backends** | claude + codex (R-DPGT/R-DOTR observed on codex; R-CRSR on claude) |
| **⚠️ Build protocol** | **SELF-MODIFYING-RECOVERY (R-PSRB).** Scope edits `mux-runner.ts` salvage/no-progress/detached-poll paths, `ticket-completion-evidence.ts`, and `pipeline-runner.ts`. The deployed pre-fix runtime exercises the very machinery these tickets edit → cannot run a clean autonomous `/pickle-pipeline`. Load-bearing tickets **MUST be hand-built in-process** (or built then `install.sh`-deployed incrementally so the rest runs on the fixed runtime). See `prds/CLAUDE.md` → "Self-modifying-recovery bundles". |

## Problem — one wound, three costumes

Three logged defects are the **same structural gap**: the **pickle phase-exit / per-ticket-budget boundary does not consult the single `readEvidence` completion oracle** that B-DURA/R-CECX established as the source of completion truth (`extension/src/services/ticket-completion-evidence.ts:421`, returns `'committed' | 'absent'`). The boundary makes completion decisions on *stale frontmatter status* and *spent budget counters* instead of asking the oracle the question it already answers.

- **R-DPGT** — `reportPhaseIncomplete` (`pipeline-runner.ts:3131-3165`) classifies a ticket as unfinished purely on `t.status.toLowerCase() !== 'done'` (line 3134). When the "unfinished" set is entirely **detached large-tier workers still advancing** (`mux-runner.ts:10645-10651` "Alive + not wedged: yield"), the runner declares `0/N phases` and exits — and those workers commit **green** 4–12 min later (2 repros: LOA-1363 run4, LOA-1588). Downstream citadel/anatomy/szechuan are already skipped.
- **R-DOTR** — `guardCompletionCommitBeforeDone` (`mux-runner.ts:4587-4710`, `readEvidence` at :4674) gates the Done-flip on **durability** (`'committed'`) but **NOT** on **green**. The B-DURA durable-boundary committer commits a worker's *partial* output on `no_progress_timeout`; the tsc result (`spawn-morty.ts:1255-1260`, `tscResult.ok`) exists in the worker gate phase but **is not available at the Done-flip** (Explore confirmed: not persisted). So a salvage commit that leaves `tsc` RED on its own files flips `Done`. This is the **inverse of the R-CECX fix** — committed-*nothing* became impossible, committed-*broken* opened.
- **R-CRSR** — `pipeline-runner.ts:3832` starts the phase loop at `phases[0]` unconditionally; `pipeline-status.json` (`writePipelineStatus`, :1260-1287) records `completed_phases`/`current_phase` but is **never read to choose the start phase** (read only for fatal-exit count preservation at :3897). A crash-relaunch re-runs completed phases AND re-enters pickle, where an already-`Done` large-tier ticket is re-selected with a **stale-spent per-ticket budget** (`60/60` never reset on a fresh process; budget check `mux-runner.ts:6362-6373`) → instant exhaustion flips `Done→Failed`.

**Common fix shape (reuse-first):** wire the *already-computed* signals — the single `readEvidence` oracle, the detached-poll liveness, the worker-gate tsc result, and `pipeline-status.json` — into the phase-exit and budget-accounting decision points. **No new oracle, no new state field.**

---

## Workstreams

### WS-1 — R-DPGT: detached-advancing tickets are terminal-for-advance via the oracle

Before `reportPhaseIncomplete` (`pipeline-runner.ts:3131`) counts a ticket as unfinished, re-resolve it through the existing oracle: a ticket that has acquired a durable `completion_commit` (oracle → `'committed'`) is **terminal-for-advance**, even if its frontmatter `status` has not yet flipped (the detached worker is mid-flight). Additionally, if the entire unfinished set is detached + actively advancing at the iteration/poll cap, grant a **bounded grace-drain** keyed to the existing detached poll (`mux-runner.ts:10482-10651`) before declaring `0/N`.

**Acceptance criteria (machine-checkable):**
- `AC-DPGT-1` — `reportPhaseIncomplete`'s unfinished filter calls `readEvidence` (or a thin shared helper that does) for each non-`Done` ticket; a ticket whose oracle result is `'committed'` is **excluded** from the unfinished set. Covered by a unit test that builds a session dir with a non-`Done` frontmatter + a durable git commit and asserts the ticket is NOT counted unfinished.
- `AC-DPGT-2` — When `largeTierDetachedEnabled()` is true and every still-unfinished ticket has a live `state.detached_worker` (`isProcessAlive` true), the runner performs a bounded grace-drain (cap = the existing detached-poll timeout, NOT a new constant) before emitting `pipeline_phase_incomplete`. Test: simulate a live detached worker at the cap and assert `reportPhaseIncomplete` is deferred until the worker either commits (→ AC-DPGT-1 excludes it) or the drain cap elapses.
- `AC-DPGT-3` — No new state field and no second oracle: a grep proves the new code path calls the existing `readEvidence` and reads the existing `state.detached_worker` / detached-poll timeout. (`audit-subtract-before-add.sh` stays green.)
- `AC-DPGT-4` — Regression: a genuinely stuck ticket (no commit, dead/absent detached worker) still produces `0/N` + `pipeline_phase_incomplete` — the grace-drain does not mask real failure. Test asserts the negative path is unchanged.

### WS-2 — R-DOTR: Done-flip gated on tsc-green for salvage/timeout commits

Make the worker-gate tsc result available at the Done-flip and gate on it for salvage/timeout dispositions. In `guardCompletionCommitBeforeDone` (`mux-runner.ts:4587`), when the completion is a `no_progress_timeout` / durable-boundary *salvage* commit, require the toolchain signal already computed by the per-ticket loop (`spawn-morty.ts` `tscResult.ok`, persisted into the worker-gate result `WorkerGateCheckResult`): if `tsc` is RED on the ticket's declared files, disposition is `Failed`/retry, **not** `Done`.

**Acceptance criteria:**
- `AC-DOTR-1` — The per-ticket worker-gate tsc result (`tscOk`) is persisted to a state/artifact field readable at the Done-flip (reuse the existing `WorkerGateCheckResult` shape — do NOT re-run `tsc` in the guard). Grep proves no second `npx tsc` invocation is added inside `guardCompletionCommitBeforeDone`.
- `AC-DOTR-2` — A salvage/`no_progress_timeout` commit whose tree leaves `tsc` RED on the ticket's declared files results in `Failed` (or retry), NOT `Done`. Unit test: frontmatter `failed_reason: no_progress_timeout` + a `completion_commit` whose tree fails tsc → guard returns reject.
- `AC-DOTR-3` — A salvage commit that is tsc-GREEN still flips `Done` (no regression to the R-CECX salvage path). Test asserts the green salvage path is unchanged.
- `AC-DOTR-4` — The gate fires ONLY on salvage/timeout dispositions, not on normal worker-completed tickets that already ran their own gate (avoid double-gating the happy path). Test asserts a normally-completed green ticket is not re-tsc-checked.

### WS-3 — R-CRSR: crash-resume reads the phase ledger + per-process budget reset

**Facet A (resume oracle):** on `pipeline-runner` (re)start, read `pipeline-status.json`; if `status === 'running'` and `completed_phases > 0` for this session, **start the phase loop at `current_phase`** (skip completed phases) instead of `phases[0]` (`pipeline-runner.ts:3832`). Reuse the file already written by `writePipelineStatus` — no new state.

**Facet B (Done-skip + budget reset):** before per-ticket budget accounting on pickle (re)entry, **skip tickets already `Done` with a durable `completion_commit`** (oracle `'committed'`) *before* the budget check (`mux-runner.ts:6362-6373`); and **reset the per-ticket budget** (`state.current_ticket_budget_start_iteration` and friends) on a fresh process start so a relaunch does not inherit a spent `60/60`.

**Acceptance criteria:**
- `AC-CRSR-1` — On (re)start with `pipeline-status.json` `{status:"running", completed_phases:2, current_phase:"anatomy-park"}`, the phase loop starts at `anatomy-park` and does NOT re-run pickle/citadel, and does NOT reset `completed_phases` to 0. Unit test on the phase-loop entry.
- `AC-CRSR-2` — A fresh-start with no prior status / `status !== "running"` / `completed_phases === 0` starts at `phases[0]` (unchanged behavior). Test asserts the cold-start path.
- `AC-CRSR-3` — On pickle (re)entry, a ticket already `Done` with oracle `'committed'` is skipped before budget accounting and is NEVER flipped `Done→Failed`/`Done→Todo`. Unit test reproduces the R-CRSR `84636f7e` scenario (Done + durable commit + spent budget) and asserts status stays `Done`.
- `AC-CRSR-4` — The per-ticket budget counter resets on a new process start: a relaunch of a ticket mid-budget begins at `0/N`, not the inherited spent value. Test asserts `applyTicketTierBudget`/budget-start reset on process (re)entry.
- `AC-CRSR-5` — Operator-recovery doc note: the verified manual recovery (kill relaunch, repair the 2 statuses, finish via standalone `/anatomy-park` + `/szechuan-sauce`) is captured in the closer-handoff or recovery runbook so the path is documented even with the code fix.

### WS-4 — Evidence-oracle: reject a foreign-ticket completion_commit (LOA-1588 sub-finding) [lightest]

A no-op/audit ticket (`ca933c63`) flipped `Done` with `completion_commit: c253c6c6` — which is **another ticket's** e2e commit (`89c654f7`'s). Tighten the oracle so a `completion_commit` must be authored *for this ticket* (commit message/attribution matches the ticket id) **or** be a sanctioned explicit no-change disposition; borrowing a foreign hash is rejected.

**Acceptance criteria:**
- `AC-OMA-1` — A no-op/clean-audit ticket records an explicit *no-change* disposition (a sanctioned marker), NOT another ticket's commit hash, when it produced no diff. Unit test: clean-audit ticket → no-change disposition, not a borrowed hash.
- `AC-OMA-2` — `readEvidence` (or its caller) rejects a `completion_commit` whose attribution belongs to a different ticket id as evidence for *this* ticket (returns `'absent'` / triggers the no-change path). Test feeds a foreign-attributed commit and asserts rejection.
- `AC-OMA-3` — Legitimately-attributed commits (the normal `fix(<ticketid>): …` path) are still accepted — no regression to the 14/14-durable LOA-1363 run-4 behavior. Test asserts the happy path.

---

## Out of scope (explicit)

- **R-SIGF full scope-auto-extension** — the orthogonal scope-fence track (fence auto-extends to out-of-fence signature/schema-shape consumers). It is the *other* codex GA blocker but a different subsystem (refinement/readiness fence, not the phase-exit oracle). Tracked separately; promote toward P1 per its drain row. Keeping it out keeps this bundle atomic.
- The `recovery_attempts` "no_work_produced → oversized_no_progress Failed-flip" **label seam** (frontmatter records `no_progress_timeout` while the reason string says `oversized_no_progress`). Verify the WS-2d split (`b60a112e`) covers the auto-split fall-through — if it doesn't, file a follow-up; do not expand this bundle.

---

## Simplification Review (subtract-before-add)

Per `prds/CLAUDE.md`, answering all four per workstream.

**WS-1 (R-DPGT):**
1. *Necessary?* Adds a grace-drain branch + an oracle re-check at the unfinished filter. Necessary — without it the 0/N declaration races detached commits (2 repros).
2. *Reuse not add?* **Yes — pure reuse.** Reuses `readEvidence` (the single oracle) + `state.detached_worker` + the existing detached-poll timeout. No new oracle, no new state, no new constant.
3. *Guards brittle complexity?* The brittle thing is the status-only unfinished filter (`t.status !== 'done'`). The fix **replaces** that with the oracle truth rather than adding a guard around it.
4. *Subtract?* Subtracts the implicit "frontmatter status is completion truth" assumption at this boundary — collapses two completion notions (status vs oracle) to one.

**WS-2 (R-DOTR):**
1. *Necessary?* Adds a tsc-green condition to the salvage Done-flip. Necessary — the R-CECX fix opened committed-broken.
2. *Reuse not add?* **Yes.** Reuses the tsc result the worker gate *already computes* (`spawn-morty.ts:1255`); persists it rather than re-running tsc. No new gate, no new tooling.
3. *Guards brittle complexity?* The durable-boundary committer commits partial output unconditionally; rather than adding a guard, WS-2 makes the *Done-flip* honest about that commit's greenness using an existing signal.
4. *Subtract?* No new machinery; net add is one read of an existing field. Records "no subtraction available beyond avoiding a re-run" — the win is reuse, not removal.

**WS-3 (R-CRSR):**
1. *Necessary?* Facet A adds a resume branch; Facet B adds a Done-skip + budget reset. Necessary — relaunch corrupts a complete build.
2. *Reuse not add?* **Yes.** Facet A reuses `pipeline-status.json` (already written) as the resume oracle — promotes write-only telemetry to a read. Facet B reuses the `readEvidence` oracle for the Done-skip and the existing `applyTicketTierBudget` reset.
3. *Guards brittle complexity?* The brittle thing is "always restart at phases[0]" + "budget persists across processes." Both are *corrected*, not guarded.
4. *Subtract?* Subtracts the duplicate-work of re-running completed phases and the false Done→Failed flips — flatter, fewer corrupting paths.

**WS-4 (foreign-hash misattribution):**
1. *Necessary?* Adds an attribution check + a no-change disposition marker. Necessary — the oracle currently accepts a foreign hash.
2. *Reuse not add?* Tightens `readEvidence`'s existing attribution logic; the no-change marker reuses the sanctioned-no-op concept. Minimal add.
3. *Guards brittle complexity?* Corrects the oracle's over-acceptance directly.
4. *Subtract?* Removes a class of false-positive evidence — the oracle becomes stricter, not wider.

---

## Build sequencing

1. **WS-3 Facet B** + **WS-1** first — they share the `readEvidence`-at-the-boundary helper; build the shared re-check helper once, consume in both. Hand-build (R-PSRB).
2. **WS-2** — depends on persisting the worker-gate tsc result; isolated to the Done-flip guard + spawn-morty result shape.
3. **WS-3 Facet A** — `pipeline-runner` resume; independent of mux-runner changes.
4. **WS-4** — lightest, oracle attribution tightening; can land last.

**Complexity tiers:** WS-1 `medium`, WS-2 `medium`, WS-3 `medium` (Facet A + B as separate tickets, each `medium`), WS-4 `small`/`medium`. None are `large` review-all tickets (avoid the R-DPGT-style detached-overrun this bundle is fixing).

## Verification gate

Full local gate before tag (per `extension/CLAUDE.md`): `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && <audit scripts incl. audit-subtract-before-add.sh> && npm run test:fast:budget && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. Each AC above ships with a `node --test` unit test under `extension/tests/`. Ship on the local gate; CI-green is hygiene, not a release gate.
