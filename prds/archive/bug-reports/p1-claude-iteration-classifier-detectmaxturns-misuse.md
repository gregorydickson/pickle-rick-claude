---
title: P1 — mux-runner iteration-completion classifier misuses detectManagerMaxTurnsExit, reclassifies clean promiseless claude exits as `error` (breaks anatomy-park AND szechuan-sauce on claude backend)
status: Draft
filed: 2026-05-13
priority: P1
type: bug + hardening-cycle
backend_constraint: claude
template_constraint: any worker template that instructs "do NOT output promise tokens" — confirmed: `.claude/commands/anatomy-park.md` (Override 5 region), `.claude/commands/szechuan-sauce.md:401`. Grep `.claude/commands/*.md` for `Do NOT output any promise tokens` to find others.
related:
  - prds/archive/bug-reports/p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md   # sibling — same helper, different misuse site (manager-relaunch vs iteration-classifier). This PRD's R-ICDM-1 directly enables R-MMTR's relaunch path to work correctly.
  - prds/archive/bug-reports/codex-classifier-prompt-leak.md                            # same family — completion classifier false-positives, codex side
  - prds/p1-anatomy-park-worker-mode-subprocess-error-kills-loop.md # adjacent — anatomy-park subprocess-error kills loop via same `handleManagerErrorOutcome` path this bug routes claude iterations into
---

# P1 — mux-runner iteration-completion classifier misuses `detectManagerMaxTurnsExit`, reclassifies clean promiseless claude exits as `error`

## Problem (one paragraph)

`extension/src/bin/mux-runner.ts` (deployed `mux-runner.js:1463-1470`) wraps the iteration's natural completion with a claude-only reclassification path that converts `completion: 'continue'` → `completion: 'error'` whenever `detectManagerMaxTurnsExit(...)` returns true. The helper is named for max-turns detection but its actual check is `stop_reason === 'end_turn' && terminal_reason === 'completed' && is_error === false` — which is the **success** shape that every cleanly-finished claude SDK iteration emits. So any worker that finishes its work cleanly **and** doesn't emit a legacy promise token (`<promise>EPIC_COMPLETED</promise>` or `<promise>EXISTENCE_IS_PAIN</promise>` or `<promise>THE_CITADEL_APPROVES</promise>`) gets misclassified as a fatal iteration error. Both `anatomy-park.md` and `szechuan-sauce.md` (line 401) currently instruct the worker `Do NOT output any promise tokens — the microverse-runner manages the loop.` On claude backend, both templates break at the iteration classifier; codex doesn't trigger the branch (line 1465 hard-gate: `backend === 'claude'`).

## Observed incident

**Session**: `~/.local/share/pickle-rick/sessions/2026-05-13-e58dcc1d/` (anatomy-park R7, branch `gregory/1025-appraisal-epic` in `loanlight-api`).

**Invocation**:
```
node setup.js --tmux --max-iterations 200 --command-template anatomy-park.md \
  --backend claude --task "Anatomy Park R7..."
```

Worker did real work: reviewed `candidate-generators`, fixed a HIGH bug (`parseBasement` malformed-comma → fabricated `basement_sqft`), committed `4fb3887c5`, cataloged a trap door, ran the test suite, posted a clean summary, and exited the claude SDK with the standard success result line:

```
{"type":"result","subtype":"success","is_error":false,
 "stop_reason":"end_turn","terminal_reason":"completed",...}
```

**Worker outcome**: ✅ Real work landed in git.
**Runner outcome**: ❌ `Gap analysis failed: error` → `microverse-runner finished. 1 iterations, 12m 34s, exit: error` → tmux launcher dropped to `read -r _` waiting for human intervention.

Hook log (`hooks.log`) recorded the worker's final assistant message and noted `hasPromise=false` on the way out — Stop hook APPROVED (`tmux owns this loop, launcher may stop`), so the failure is not in the hook layer; it's downstream in the iteration classifier.

Runner log (`microverse-runner.log`):
```
[12:49:55.681Z] microverse-runner started
[12:49:55.834Z] Starting gap analysis phase
[13:02:30.364Z] Gap analysis failed: error
[13:02:30.364Z] microverse-runner error: gap analysis failed
[13:02:30.367Z] microverse-runner finished. 1 iterations, 12m 34s, exit: error
```

**Same template, codex backend = works**: session `2026-05-12-6746d157` (R6, same target, same skill template) ran 90 productive iterations on codex backend, 74 HIGH fixes committed, before stopping for unrelated codex weekly-quota exhaustion. R6 saw the *identical* `classifyCompletion='continue'` output shape from every iteration but never tripped the reclassifier — line 1465 is hard-gated to `backend === 'claude'`.

**Confirmed 2026-05-13**: szechuan-sauce on claude would hit the same gap-analysis tear-down. `.claude/commands/szechuan-sauce.md:401` carries the identical `Do NOT output any promise tokens` line. This is a template-generic bug class, not anatomy-park-specific.

## Root cause analysis

### Code path

`extension/src/bin/mux-runner.ts` (deployed `mux-runner.js`):

1. **Iteration outcome classification** (lines 1456-1470):
   ```ts
   const completion = classifyCompletion(output);  // returns 'continue' when no promise token
   const normalizedOutcome = {
       completion,
       timedOut: didTimeout,
       exitCode: code ?? null,
       wallSeconds: (Date.now() - start) / 1000,
   };
   resolve({
       ...normalizedOutcome,
       completion: backend === 'claude'
           && completion === 'continue'
           && detectManagerMaxTurnsExit(normalizedOutcome, logFile)
           ? 'error'                                  // ← misclassification fires here
           : completion,
   });
   ```

2. **`detectManagerMaxTurnsExit` helper** (lines 1159-1194):
   ```ts
   export function detectManagerMaxTurnsExit(outcome, logFile) {
       if (outcome.timedOut || outcome.exitCode !== 0) {
           return false;
       }
       // ... read last result event from log ...
       return event.stop_reason === 'end_turn'
           && event.terminal_reason === 'completed'
           && event.is_error === false;
   }
   ```
   This returns `true` for **every** cleanly-completed claude SDK session. There is no comparison against the actual turn budget (`Defaults.MANAGER_MAX_TURNS = 400` via `default_tmux_max_turns` setting). The function name implies turn-budget detection; the implementation is "claude exited cleanly". Not the same thing.

3. **Compounding spec — multiple templates forbid promise tokens**:
   - `.claude/commands/anatomy-park.md` (Override 5 / "Standard Protocol" region): `Do NOT output any promise tokens — the microverse-runner manages the loop.`
   - `.claude/commands/szechuan-sauce.md:401`: identical line.

   Sensible in isolation — the skill authors wanted workers to focus on work and let the runner own the loop — but it makes `classifyCompletion(output)` return `'continue'` on every cleanly-finished iteration, which is the exact precondition the reclassifier needs to fire.

4. **Where the misclassified `'error'` lands**:
   - **Gap-analysis phase** (`microverse-runner.js:1443-1449`):
     ```ts
     if (outcome.completion === 'error' || outcome.completion === 'inactive') {
         ctx.log(`Gap analysis failed: ${outcome.completion}`);
         state.status = 'stopped';
         state.exit_reason = 'error';
         writeMicroverseState(ctx.sessionDir, state);
         throw new Error('gap analysis failed');
     }
     ```
     Fresh session → no `microverse.json.convergence.history`, no `microverse.json.baseline_score` → `executeGapAnalysis` runs as iteration 1. Reclassification fires → loop tears down on iteration 1.
   - **Normal iterating phase** (`microverse-runner.js:2011-2016`):
     ```ts
     if (outcome.completion === 'error') {
         return handleManagerErrorOutcome(ctx);
     }
     if (outcome.completion === 'inactive') {
         ctx.log('Session deactivated. Exiting loop.');
         return 'stopped';
     }
     ```
     Even if gap analysis were bypassed (by pre-seeding history), the same reclassifier would fire on every subsequent iteration, sending each clean iteration through `handleManagerErrorOutcome` instead of the worker-convergence check.

### Why R-MMTR (Finding #19) didn't catch this

R-MMTR (`p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md`) introduced `detectManagerMaxTurnsExit` for use in the **manager-relaunch helper** (`classifyManagerRelaunchExit` at line 1195-1199), where its semantics — "was the manager's clean exit caused by max-turns?" — are plausibly defensible (a tmux manager that orchestrated workers cleanly past N turns could in fact be at the cap). R-MMTR plans to use this helper to drive a backend-agnostic relaunch path. R-MMTR-1's spec said "introduce `detectManagerMaxTurnsExit` helper" — it didn't audit existing call sites for fit. The line-1465 site is older code that the helper was retro-fitted into without re-checking semantics.

### Why this didn't bite before now

1. **Codex was the default for anatomy-park** — every anatomy-park session in `~/.local/share/pickle-rick/sessions/2026-05-*/` we've checked uses `"backend": "codex"`. The `backend === 'claude'` guard means codex sessions never hit the reclassifier.
2. **Other claude-backend templates emit promise tokens** — `pickle.md`, etc., end with promise tokens per skill spec, so `classifyCompletion` returns `'task_completed'` or `'review_clean'`, and the reclassifier's `completion === 'continue'` precondition is false.
3. **anatomy-park.md AND szechuan-sauce.md explicitly forbid promise tokens** — and claude-backend runs of these were rare (codex's longer context window made it the natural fit). The bug needed a specific combo to surface: claude backend + a promise-forbidding template + (for gap-analysis path) a fresh session.

The exact trigger today: codex weekly quota exhausted mid-bundle, operator fell back to `--backend claude`, gap-analysis on the first iteration tripped the reclassifier.

## Source surface (file-by-file)

**Files to touch**:
- `extension/src/bin/mux-runner.ts` — repair `detectManagerMaxTurnsExit` semantics and/or remove the iteration-classifier reclassification branch
- `.claude/commands/anatomy-park.md` — remove the promise-token prohibition
- `.claude/commands/szechuan-sauce.md` — remove the promise-token prohibition (line ~401)
- Any other `.claude/commands/*.md` carrying the same line — grep before editing
- `extension/tests/integration/mux-runner-claude-iteration-classifier.test.ts` (new) — regression coverage

**Files to NOT touch**:
- `microverse-runner.ts:1443` — the gap-analysis bail logic is correct given a correct `outcome.completion`; bug is upstream
- `microverse-runner.ts:2011-2016` — same
- `mux-runner.ts:1197` (`classifyManagerRelaunchExit`) — R-MMTR's intended use site, in-scope semantics

## The fix — three options, recommend (1) + (3) layered

### Option 1 (recommended): Repair `detectManagerMaxTurnsExit` to actually check turn budget

The helper should compare actual `num_turns` (from the SDK's `result` event) against the manager's `--max-turns` budget. A clean exit at `num_turns >= maxTurns` is max-turns shape; a clean exit at `num_turns < maxTurns` is finished-naturally shape.

```ts
export function detectManagerMaxTurnsExit(outcome, logFile, maxTurns) {
    if (outcome.timedOut || outcome.exitCode !== 0) return false;
    const lastResult = readLastResultEvent(logFile);
    if (!lastResult) return false;
    if (lastResult.stop_reason !== 'end_turn') return false;
    if (lastResult.terminal_reason !== 'completed') return false;
    if (lastResult.is_error !== false) return false;
    // NEW: only "max-turns" if actually at the budget
    const turns = lastResult.num_turns ?? lastResult.turn_count ?? null;
    if (turns === null || maxTurns === null) return false;
    return turns >= maxTurns;
}
```

Update call sites at line 1197 and 1465 to pass `maxTurns` (already computed at line 1336-1339).

### Option 2: Drop the iteration-completion reclassification entirely

The line-1465 branch was likely added to handle a "claude finished without saying done" symptom that was actually caused by a different bug (worker template misconfiguration, missing handoff, etc.). With `classifyCompletion` correctly returning `'continue'` when there's no promise token, the downstream loop can decide what to do — and for worker-convergence mode (the mode used by both anatomy-park and szechuan-sauce), the runner shouldn't need a per-iteration "done" signal at all; the worker writes a convergence file and the runner reads it.

Simpler diff but riskier — may have been protecting a legacy use case we don't see immediately.

### Option 3 (defense in depth, ships alongside #1): Relax the promise-token prohibition across ALL affected templates

Confirmed `anatomy-park.md` and `szechuan-sauce.md:401` carry the line. Grep `.claude/commands/*.md` for `Do NOT output any promise tokens` to find any others.

For each affected template, change:
> Do NOT output any promise tokens — the microverse-runner manages the loop.

to:
> At the end of each iteration, emit `<promise>TASK_COMPLETED</promise>` on its own line so the runner classifier marks a clean iteration boundary. The runner still owns the loop — this token only marks "this iteration finished its work" so the classifier can distinguish from a truncated exit.

This restores parity with `pickle.md`/etc., and removes the spec divergence that makes claude+anatomy-park / claude+szechuan-sauce special cases.

**Recommended**: ship (1) + (3) layered. (1) fixes the classifier semantics for any future skill that forbids promise tokens (defense in depth at the runner layer). (3) restores immediate parity for the two known templates and removes the only known triggering combos (template-level fix). Both are cheap.

## Atomic tickets — R-ICDM family ("iteration classifier detect-max-turns")

### R-ICDM-1 — Repair `detectManagerMaxTurnsExit` to compare actual turn count against budget
- Add `maxTurns` parameter to `detectManagerMaxTurnsExit(outcome, logFile, maxTurns)`.
- Read `num_turns` (or equivalent) from the last `result` event.
- Return `false` if either is null/undefined or if `turns < maxTurns`.
- Thread `maxTurns` through call sites at lines 1465 and 1197.
- File: `extension/src/bin/mux-runner.ts`. ~30 LOC.

### R-ICDM-2 — Drop or audit the iteration-completion reclassifier
- Either remove the `completion: backend === 'claude' && ... ? 'error' : completion` ternary entirely, OR
- Verify Option-1's repair is sufficient and keep the ternary as-is (now correctly fires only when claude truly exited at the turn budget).
- Decision artifact: doc note in `docs/codex-prompt-design-notes.md` explaining which call sites use the helper and why each is justified.
- File: `extension/src/bin/mux-runner.ts`. ~5 LOC removal or 0 LOC + doc.

### R-ICDM-3 — Relax promise-token prohibition across ALL affected templates
- Pre-step: grep `.claude/commands/*.md` for `Do NOT output any promise tokens` to find any beyond the two we've confirmed.
- For each affected template (`anatomy-park.md`, `szechuan-sauce.md`, plus any others), edit the "Standard Protocol" / "Override" region:
  - Remove: `Do NOT output any promise tokens — the microverse-runner manages the loop.`
  - Add: `At the end of each iteration, emit <promise>TASK_COMPLETED</promise> on its own line so the runner classifier marks a clean iteration boundary.`
- Update any iteration-completion checklist examples that referenced the old prohibition.
- Run `bash install.sh` to deploy.
- Files: `.claude/commands/anatomy-park.md`, `.claude/commands/szechuan-sauce.md`, plus any surfaced by the grep. ~5 LOC per template.

### R-ICDM-4 — Regression test
- New: `extension/tests/integration/mux-runner-claude-iteration-classifier.test.ts`.
- Stub claude SDK iteration logs that end with:
  - `(a)` `stop_reason: end_turn, terminal_reason: completed, is_error: false, num_turns: 50` while `maxTurns = 400` → assert `detectManagerMaxTurnsExit(...) === false`
  - `(b)` `num_turns: 400` while `maxTurns = 400` → assert `=== true`
  - `(c)` no `num_turns` field at all → assert `=== false` (conservative; can't tell so don't reclassify)
  - `(d)` codex prompt-echo `<promise>EPIC_COMPLETED</promise>` not classified as `task_completed` (shared scaffold with HCC-C below)
- ~80 LOC.

### R-ICDM-5 — Trap-door entry in `extension/src/bin/CLAUDE.md`
- INVARIANT: `detectManagerMaxTurnsExit` must compare `num_turns` against the actual `maxTurns` budget, not just check that the SDK exited cleanly.
- BREAKS: claude workers that finish work cleanly without emitting a legacy promise token get reclassified as iteration errors → anatomy-park / szechuan-sauce on claude tear down on iteration 1.
- ENFORCE: `mux-runner-claude-iteration-classifier.test.ts`.
- PATTERN_SHAPE: `detectManagerMaxTurnsExit\(.*\)` callable without a `maxTurns` argument, or call site that doesn't pass it; OR any `.claude/commands/*.md` containing `Do NOT output any promise tokens` without a complementary `<promise>TASK_COMPLETED</promise>` instruction.

### R-ICDM-6 — Observability event
- When the reclassifier fires (which should now be rare and only at true max-turns), emit a structured activity event `iteration_classified_at_max_turns` with `iteration_num`, `num_turns`, `max_turns`, `wall_seconds`. Audits how often the "real" max-turns shape happens in practice and whether the relaunch path (R-MMTR) is needed.
- File: `extension/src/bin/mux-runner.ts` near the reclassifier. ~10 LOC.

### R-ICDM-7 — Backfill log scan (optional)
- One-shot bash: scan `~/.local/share/pickle-rick/sessions/*/microverse-runner.log` for `Gap analysis failed: error` events on claude-backend sessions and surface a count. Establishes how often this has bitten silently across the org.
- Lives in this PRD; doesn't need to ship.

## Hardening cycle (master plan) — Claude-backend completion-classifier parity

Bundle this work with related claude-backend classifier issues for one coherent ship.

### In-scope PRDs

| Slot | PRD | Status | LOC est |
|---|---|---|---|
| HCC-A | [`p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md`](p1-mux-runner-no-claude-manager-relaunch-on-max-turns.md) (R-MMTR, Finding #19) | Draft | ~200-300 |
| HCC-B | This PRD (R-ICDM-1..7) | Draft (filed 2026-05-13) | ~150 |

### Adjacent — may bundle or sequence separately

| Slot | PRD | Why related | Decision |
|---|---|---|---|
| HCC-C | [`codex-classifier-prompt-leak.md`](codex-classifier-prompt-leak.md) (Finding #1) | Same `classifyCompletion`/`extractAssistantContent` surface; codex side. False-positive `task_completed` from prompt-echo. | **Bundle**: shared regression test scaffold, single `mux-runner-completion-classifier.test.ts`. |
| HCC-D | [`p1-anatomy-park-worker-mode-subprocess-error-kills-loop.md`](p1-anatomy-park-worker-mode-subprocess-error-kills-loop.md) (R-APMW, Finding #23) | Downstream consumer of misclassified `completion: 'error'`. R-APMW handles real subprocess errors. R-ICDM-2 prevents clean exits from ever reaching the error handler. | **Sequence separately**: R-APMW is its own bundle, partially shipped. Cross-reference. |
| HCC-E | [`p1-microverse-baseline-llm-exhaustion-collapses-transient-into-fatal.md`](p1-microverse-baseline-llm-exhaustion-collapses-transient-into-fatal.md) (R-MBLE, Finding #26) | Adjacent classifier-family bug: collapses transient timeouts into fatal exit reasons. Same "be conservative when reasons aren't certain" theme. | **Cross-reference only**: different file, different exit reason, already queued separately. |

### Sequencing — `HCC-COORD-1` helper signature freeze

R-MMTR and R-ICDM both touch `detectManagerMaxTurnsExit`. Whichever ships first MUST update the other's call site to match the new signature (`(outcome, logFile, maxTurns) => boolean`). Coordinate via a one-paragraph ticket in this bundle, no separate PRD file. Pre-ship: agree on the helper's final signature; the first ship implements both call sites (line 1197 and line 1465) with the new signature even if the second-shipping PRD's other changes haven't landed yet. Trap-door pin in `extension/src/bin/CLAUDE.md`: "`detectManagerMaxTurnsExit` must be called with the call site's actual `maxTurns` value — never null, never default."

### Out of scope (this cycle)

- **Manager-relaunch UX for codex** — codex already has `evaluateCodexManagerRelaunch`. R-MMTR generalizes it to backend-agnostic; does not redesign codex side.
- **Promise-token deprecation** — the legacy `<promise>EPIC_COMPLETED</promise>` family is a known crutch. There's an argument to delete the whole `classifyCompletion` token-scanning surface in favor of worker-managed convergence files. Out of scope; own design doc.
- **anatomy-park / szechuan-sauce skill re-architecture** — R-ICDM-3 relaxes one line per template; we don't redesign worker phase structure or convergence model.
- **Hermes backend** — separate epic (`hermes-integration.md`). If hermes lands during this cycle, its completion semantics get audited against the helper's new contract, but hermes work doesn't gate on this bundle.

### Acceptance criteria for the bundle

A single PR (or fast-follow PR chain) that, in any order:

1. `detectManagerMaxTurnsExit(outcome, logFile, maxTurns)` compares actual turn count against budget (R-ICDM-1).
2. Both call sites (line 1197 / 1465) pass `maxTurns` (R-ICDM-1, HCC-COORD-1).
3. Backend-agnostic `evaluateManagerRelaunch(backend, ...)` exists and wires claude into the relaunch path (R-MMTR-2..4).
4. Iteration-classifier reclassifier either removed or correctly fires only at real max-turns (R-ICDM-2).
5. `anatomy-park.md` AND `szechuan-sauce.md` no longer forbid promise tokens (R-ICDM-3); `bash install.sh` deploys.
6. New activity events: `manager_max_turns_relaunch` (R-MMTR), `iteration_classified_at_max_turns` (R-ICDM-6).
7. Regression suite: `mux-runner-completion-classifier.test.ts` covers (a) clean exit with `num_turns < maxTurns` → not max-turns, (b) clean exit at `num_turns >= maxTurns` → max-turns, (c) missing `num_turns` → conservative false, (d) codex prompt-echo `<promise>EPIC_COMPLETED</promise>` not classified as `task_completed` (HCC-C).
8. Trap-door pin in `extension/src/bin/CLAUDE.md` covering the helper's contract (R-ICDM-5).
9. End-to-end smoke: anatomy-park OR szechuan-sauce on claude backend completes ≥3 iterations on a small fixture without the loop tearing down.

### Total bundle scope

- R-MMTR: ~200-300 LOC (per its PRD)
- R-ICDM: ~150 LOC
- HCC-C bundling overhead (if included): ~50 LOC shared regression scaffold
- HCC-COORD-1: trivial coordination, no LOC
- **Total**: ~400-500 LOC, single PR or 2-PR chain, ~1-2 days focused.

## Reproduction (deterministic)

1. Any repo with claude backend healthy and codex either unavailable or unused.
2. `cd <any-project-with-subsystems>`.
3. `node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --max-iterations 5 --command-template anatomy-park.md --backend claude --task "repro"` (or `--command-template szechuan-sauce.md` for the szechuan-sauce flavor).
4. Initialize convergence state per the skill's Setup Mode.
5. `bash launch.sh ${SESSION_ROOT}`.
6. Watch tmux window 0. Iteration 1 runs, worker does work, claude SDK exits clean.
7. ~30 seconds after worker exit, `microverse-runner.log` writes `Gap analysis failed: error` and the loop tears down.

**Expected (after fix)**: gap analysis succeeds, runner transitions to `iterating`, iteration 2 begins.

## Cross-cutting notes for the implementer

- **Symbol audit before refactor**: grep for every call to `detectManagerMaxTurnsExit` and `classifyCompletion` across `extension/src/bin/` AND deployed `~/.claude/pickle-rick/extension/bin/` AND tests. Confirm no stragglers in `tmux-runner.ts` / `jar-runner.ts` (early grep showed `tmux-runner.ts:1336` mirrors mux-runner; verify same helper invocation there).
- **Deployed parity**: after `bash install.sh`, deployed `mux-runner.js` and `~/.claude/commands/*.md` must match source. Run closer parity check before declaring shipped.
- **Activity event schema**: the new `iteration_classified_at_max_turns` event must conform to whatever `extension/src/types/activity.ts` declares; check schema-version drift constraints before adding.
- **Test fixture**: a small repo with 2-3 subsystems is enough to smoke. Don't use `loanlight-api` — it's slow and has unrelated pre-existing typecheck/lint failures that confuse the gate.

## Verification (after ship)

- Repro the failing session shape on a controlled fixture; assert runner now transitions `gap_analysis` → `iterating` and continues.
- Backfill scan (R-ICDM-7 one-shot) on operator's `~/.local/share/pickle-rick/sessions/*/microverse-runner.log` for historical false `Gap analysis failed: error` events. Expect zero new occurrences after deploy.
- Smoke against `loanlight-api` branch `gregory/1025-appraisal-epic` (where this was discovered): launch `/anatomy-park --backend claude` or `/szechuan-sauce --backend claude` and verify ≥10 successful iterations.

## Open questions

1. **R-ICDM-2 decision**: drop the reclassifier entirely (Option 2) or keep with the fixed helper (Option 1 alone)? **Recommendation**: keep with fixed helper — preserves original intent (catch genuine "claude truncated at max-turns" events) without the false-positive surface.
2. **Should `classifyCompletion` learn a fourth return value** — e.g. `'clean_exit_no_promise'` — so consumers can distinguish "claude finished cleanly, no completion token" from "claude is still going" (current ambiguous `'continue'`)? **Recommendation**: not in this cycle. Adds branches everywhere `classifyCompletion` is consumed. Defer.
3. **Trap-door granularity** — one pin for the helper, or separate pins per call site? **Recommendation**: one pin, list both call sites in the BREAKS clause.

## Session evidence

- Failed session: `~/.local/share/pickle-rick/sessions/2026-05-13-e58dcc1d/`
  - `microverse-runner.log` — the "Gap analysis failed: error" log line
  - `tmux_iteration_1.log` — the 847.8 KB iteration log showing successful work + clean SDK exit
  - `hooks.log` — Stop hook recording `hasPromise=false` then APPROVE
  - `state.json` — `active: false, exit_reason: error, step: completed`
- Successful sibling session on codex: `~/.local/share/pickle-rick/sessions/2026-05-12-6746d157/` — same target, same template, 90 productive iterations, 74 fixes shipped before codex weekly quota exhaustion.
- Triggering work: `loanlight-api` branch `gregory/1025-appraisal-epic`, commit `4fb3887c5` (the one iteration's real fix that landed before the runner tore down).
- Bundle 2026-05-10 session `2026-05-10-84ad0873` (R-MMTR trigger, 21 stranded tickets) — per the R-MMTR PRD.

## Session notes

- R7 iteration produced real value (commit `4fb3887c5` landed `parseBasement` strict-comma validation + regression test + trap-door entry on `candidate-generators/CLAUDE.md`) before the runner tore down. "Gap analysis failed" was after the work — operator only lost the loop continuation, not the work.
- R5 + R6 + R7 across this session produced **76 HIGH fixes + 73 trap doors** on the same target before this bug stopped further progress. Bug is loop-continuity-killer, not data-corrupting.
- Operator workaround until R-ICDM ships: either pin anatomy-park/szechuan-sauce sessions to `--backend codex` (when quota allows), or hand-patch the deployed `.claude/commands/{anatomy-park,szechuan-sauce}.md` to emit `<promise>TASK_COMPLETED</promise>` at iteration end (R-ICDM-3 done manually; survives until next `install.sh` overwrites).
- This PRD was originally drafted as two separate files (focused bug + hardening bundle) but lost to concurrent activity in pickle-rick-claude (untracked file got cleaned). Consolidated into one PRD with both surfaces here.
