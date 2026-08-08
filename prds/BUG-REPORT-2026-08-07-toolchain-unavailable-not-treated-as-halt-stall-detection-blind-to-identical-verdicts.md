# BUG REPORT 2026-08-07 — a deployed `toolchain_unavailable` halt verdict is discarded at the phase boundary; the amnesiac-exit breaker zeroes the counter that bounds it, burning $13.21 / 22 iterations

**Priority:** P2 — no work lost (pickle phase made 0 commits, nothing to corrupt), but real token spend on a run that should have self-halted after 1-2 iterations.
**Found:** `/pickle-pipeline` session `2026-08-07-35088221` (LOA-2188 non-product-decision cleanup bundle), operating on `~/loanlight/loa-2188-worktree/packages/api` (a freshly created worktree with no `node_modules` and no `.env.local`).
**Status:** open, unfixed. Operator (me) manually killed the tmux session after diagnosing.

> **DIAGNOSIS REVISED 2026-08-07 (post-mortem against source + session artifacts).** The original
> write-up below inferred both root causes from the worker's prose output. Both inferences were wrong in
> ways that change the fix, and both corrections make the fix *smaller*:
>
> 1. **The `toolchain_unavailable` detector is not missing — it already exists, is deployed, and fired
>    correctly in 268 ms.** Its verdict is then discarded by the phase-boundary classifier, which reads
>    the exit *code* and never the `exit_reason` the detector had just written. No new detector and no
>    prose-signature matching is needed; the missing piece is one wire.
> 2. **Stall detection was never "blind to identical verdicts" — it was bypassed and is structurally
>    unbounded.** A `num_turns < 5` proxy classifies a correctly-blocked worker as `amnesiac`, which
>    explicitly does not count toward `stall_counter`; the 2-strike breaker then *zeroes the very counter
>    that is supposed to bound it*, so the loop can never terminate.
>
> The corrected analysis is in **"Verified root causes"** below. The original inferred analysis is
> retained under "Original inferred diagnosis (superseded)" because the reasoning trail is the evidence
> that prose-level inference is not a substitute for reading the seam.

## What happened

```
[PHASE 1/4: PICKLE] Phase pickle exited with code 1
Phase pickle exited with no progress (0 Done of 8 tickets, 0 commits since 9947b3af) — reporting incomplete, advancing
[PHASE 2/4: CITADEL] citadel: no remediable findings — phase complete, continuing pipeline
[PHASE 3/4: ANATOMY-PARK] Phase anatomy-park exited with code 0
[PHASE 4/4: SZECHUAN-SAUCE] ... ran to iteration 22 before manual kill, $13.21 spent
```

Root cause of the *pickle* failure was operator error, not a pickle-rick bug: the worktree was created without running `pnpm install` (a deliberate choice — "let the fresh session run it" — that nobody then ran before launching the pipeline). No `node_modules`, no `packages/api/.env.local`, `GITHUB_PACKAGES_TOKEN` unset. Iteration 1's own worker diagnosed this correctly and precisely:

```
"result":"Blocked, not sauce.\n\nNo diff to deslop: `git diff main...HEAD` empty, tree clean, `HEAD`
= `start_commit` = `9947b3afd` = tip of `main`. Pickle build phase produced zero commits.\n\nNo
toolchain either: no `node_modules` (root or `packages/api`), no `packages/api/.env.local`,
`GITHUB_PACKAGES_TOKEN` unset — `.npmrc` can't resolve `@loanlight-engineering/*`, so lint/typecheck/
test can't run. No fix could be verified before commit.\n\n...\n\nUnblock needs operator:\n1.
`packages/api/.env.local` with `GITHUB_PACKAGES_TOKEN`\n2. `set -a; source .env.local; set +a; pnpm
install`\n3. re-run pickle build so tickets produce commits\n4. re-run anatomy-park, then
szechuan-sauce"
```

That is a correct, complete, actionable diagnosis — on iteration **1**. Every one of the next 21 iterations (verified: iterations 5, 10, 15, 20, 22 all sampled) reproduced the *identical* verdict verbatim ("same wall as prior iterations", `HEAD` unchanged, diff empty, no fix possible), at a cost of $0.50–$0.90 each, totaling **$13.21 across 22 iterations** for zero additional information after iteration 1.

## Verified root causes

Evidence base: `extension/src/bin/mux-runner.ts`, `extension/src/bin/microverse-runner.ts`,
`extension/src/services/microverse-state.ts` at `08cfcf9d`, plus session `2026-08-07-35088221`'s
`mux-runner.log`, `pipeline-runner.log`, `microverse-runner.log`, `state.json`, `microverse.json`,
and `anatomy-park.json`.

### V1. The halt fired correctly. The phase boundary threw the verdict away.

`toolchain_unavailable` is fully implemented and deployed:

| Artifact | Location |
|---|---|
| `ExitReason` union member | `extension/src/bin/mux-runner.ts:4434` |
| terminal-reason set membership | `extension/src/bin/mux-runner.ts:4464` |
| predicate `targetToolchainMissing()` | `extension/src/bin/mux-runner.ts:4505` |
| one-time preflight (R-PFNT WS-2c) | `extension/src/bin/mux-runner.ts:9967` |
| present in the deployed tree | `~/.claude/pickle-rick/extension/bin/mux-runner.js` |

It behaved exactly as designed, 268 ms into phase 1:

```
20:09:56.594  PHASE 1/4: PICKLE (backend=claude)
20:09:56.862  toolchain_unavailable: target repo '/Users/.../loa-2188-worktree/packages/api'
              has package.json but no installed node_modules — failing fast instead of
              churning iterations against a missing toolchain.
              → writeActivityEntry(session_end, terminal_exit_reason: toolchain_unavailable)
              → recordExitReason(statePath, 'toolchain_unavailable')
              → safeDeactivate(statePath)
20:09:57.072  Phase pickle exited with code 1
20:09:57.093  Phase pickle exited with code 1 (non-fatal) — continuing to citadel for
              automated remediation
```

The `session_end` activity record survives in `state.json` and names the reason. **`shouldHaltAfterPhase`
consulted only the exit code.** Exit code `1` is non-fatal for a non-citadel phase under the R-PHC-6
continue-by-default invariant, so the classifier discarded an authoritative crash-floor `exit_reason`
that had been persisted 200 ms earlier and advanced the pipeline.

**This is a stated-but-unwired policy, and the conflict is documented on both sides.** The root
`CLAUDE.md` halt set explicitly names *"toolchain unavailable"* as a genuine crash floor that MAY halt.
R-PHC-6 says non-fatal non-zero `pickle` exits MUST continue when downstream remediation phases are
queued. Neither rule references the other, and no code path reconciles them — so the crash floor is
unreachable through the phase boundary regardless of how well the detector works.

Precedent for the fix already exists at the same seam: `runPhaseIteration` reads `state.exit_reason`
twice today — R-CCR-3 (stale-handoff clearance) and R-ICP-2 (`PhaseIncomplete` → `reportPhaseIncomplete`).
This is a third reason to read it, not a new mechanism.

### V2. `num_turns < 5` misclassifies a correct verdict, and the breaker resets its own bound.

`classifyNoCommitExit` — `extension/src/bin/microverse-runner.ts:1518`:

```ts
const turns = typeof result?.num_turns === 'number' ? result.num_turns : null;
if (turns !== null && turns < 5) return 'amnesiac';   // :1530 — FIRST check
if (output.includes('clean') || output.includes('no violations') || ...) return 'clean_pass';
return 'stall';
```

The turn-count proxy is evaluated **before** any content check. A worker that correctly concludes
"blocked, no toolchain, cannot verify a fix" reaches that conclusion in few turns — being right is fast —
so a decisive correct verdict is labelled `amnesiac` ("the worker forgot what it was doing"). The handler
at `:3749` then logs `not counting as stall` and returns `null` **without touching `stall_counter`**.
Confirmed in the session's final `microverse.json`: `stall_counter: 0`, `convergence.history: []` after
22 iterations. Stall detection was not blind to identical verdicts; it was never handed anything to count.

The loop is then unbounded **by construction**. At 2 strikes the breaker
`resetGapAnalysisForAmnesiacBreaker` — `extension/src/bin/microverse-runner.ts:3670` — returns:

```ts
status: 'gap_analysis',
consecutive_amnesiac_exits: 0,   // ← zeroes the counter that is supposed to bound this
```

So the cycle is: 2 amnesiac exits → breaker fires → counter reset to 0 → `status` back to `gap_analysis`
→ gap analysis re-runs, paying a **fresh LLM baseline measurement** → worker is still blocked and still
answers fast → `amnesiac` → repeat. `consecutive_amnesiac_exits` can never exceed 2, and nothing else
bounds the path.

The session log shows the cycle and the cost driver directly:

```
LLM baseline metric: 3  → iter 2,3  amnesiac (1/2, 2/2) → reset
LLM baseline metric: 2  → iter 5,6  amnesiac (1/2, 2/2) → reset
LLM baseline metric: 4  → iter 8,9  amnesiac (1/2, 2/2) → reset
LLM baseline metric: 1  → ...                             (final state: baseline_score 0)
```

**Cost attribution corrected:** the spend was ~11 gap-analysis + LLM-baseline judge cycles, not 22 worker
iterations. Note also that the judge returned a *different score on every cycle against an unchanged
empty diff* (3, 2, 4, 1, … 0) — an independent judge-non-determinism signal worth its own finding, since
an empty diff should score deterministically.

`num_turns < 5` is a **proxy standing in for available truth.** The authoritative facts — empty diff,
`HEAD` unchanged, `HEAD == start_commit`, missing toolchain — were all observable and all ignored in
favour of a turn count. Same class as the proxy-over-truth cluster.

## Original inferred diagnosis (superseded)

Retained for the reasoning trail. Both numbered defects below were inferred from worker prose and are
corrected by V1/V2 above.

### 1. `toolchain_unavailable` is a sanctioned crash-floor halt condition that didn't halt

This repo's own `CLAUDE.md` (binding, operator-set) enumerates the sanctioned hard-halt set: *"unreadable/unwritable state, missing `start_commit`, `state_schema_version_ahead`, `state_working_dir_missing`, **toolchain unavailable**, budget/iteration cap, operator cancel, explicit `--strict-phases`"*. Iteration 1's own diagnosis is a textbook `toolchain_unavailable` — no `node_modules`, `.npmrc` can't resolve scoped packages, "lint/typecheck/test can't run." Per the pipeline's own binding directive this should have been classified as a halt, not a "no remediable findings, continuing" pass-through. Instead `pipeline_continue_on_phase_fail: true` drove citadel/anatomy-park/szechuan-sauce forward against a pickle phase that made zero commits for a structural (not measurement) reason.

### 2. Stall detection did not fire on 21 consecutive identical verdicts

Even granting that continuing past pickle was intended behavior, `szechuan-sauce`'s `stall_limit` was set to 5 in this run's `pipeline.json` (and `anatomy_stall_limit: 3` for anatomy-park). Neither stopped the loop. The blocked verdict was not merely "no progress" in a vague sense — it was **byte-for-byte the same root cause** (`HEAD` unchanged, diff empty, missing toolchain) reported by the worker itself in near-identical prose every single iteration. Whatever mechanism `microverse-runner`/szechuan's stall detection uses evidently does not treat "N consecutive iterations with zero commits AND an unchanged `HEAD`" as a stall condition strong enough to halt before iteration 22 (4-5× past the configured `stall_limit: 5`).

## Candidate fix — subtractive-first, per this repo's own Simplification Review rule

Revised against the verified root causes. Two of the four original items are struck as unnecessary:
the work they describe is already shipped, or is a proxy where truth is available.

1. ~~**Necessary?** A phase-exit classifier needs to recognize a worker's own explicit "no toolchain,
   cannot verify a fix" report...~~ — **STRUCK. Already shipped.** `targetToolchainMissing` +
   the R-PFNT preflight exist at `mux-runner.ts:4505`/`:9967`, are deployed, and fired correctly in
   268 ms. **No prose-signature detector is needed.** What is needed is for `shouldHaltAfterPhase` to
   consult the `state.exit_reason` the detector already persists, against the crash-floor set that
   already exists (`mux-runner.ts:4464`), instead of keying solely on the exit code. That is a wire,
   not a mechanism — and it reconciles the standing `CLAUDE.md`-halt-set vs R-PHC-6 conflict that
   currently makes the crash floor unreachable through the phase boundary.
2. **Reuse instead of add?** Yes, and more cheaply than originally framed. The terminal-reason set,
   the detector, the `exit_reason` persistence, and the `runPhaseIteration` `exit_reason` read all
   exist. Precedent for reading `exit_reason` at this exact seam: R-CCR-3 and R-ICP-2. Adding a
   parallel prose classifier beside a working structured signal is the smell this rule exists to catch.
3. **Guard existing brittle complexity, or subtract?** **Subtract — and the target is now precise.**
   Two edits, both removals or demotions, no new state:
   - **`num_turns < 5` (`microverse-runner.ts:1530`) must not outrank observable truth.** It is a
     proxy for effort that fires ahead of every content check, so a correctly-blocked worker (fast
     because it is right) is labelled `amnesiac`. Demote it below the empty-diff / unchanged-`HEAD`
     checks, or subtract it entirely — the authoritative facts are already in hand.
   - **`resetGapAnalysisForAmnesiacBreaker` (`:3670`) must stop zeroing `consecutive_amnesiac_exits`.**
     A breaker that resets its own bound is not a bound. This is a one-line deletion from the returned
     object, not a new counter.
   Note the original "hash the worker's verdict text and halt on N identical hashes" idea is **STRUCK**
   for the same reason as item 1: it invents a proxy where the structured facts (`HEAD` unchanged,
   diff empty, zero commits) are already available.
4. **What can this subtract?** Unchanged and still the strongest argument: if the crash floor is
   honoured at phase 1, citadel/anatomy-park/szechuan-sauce never run in this scenario at all — a net
   reduction in executed phases. Plus one deleted proxy branch and one deleted counter reset. **This
   bundle is net-subtractive: no new state field, no new detector, no new gate, no new skip flag.**

## Repro

1. Create a fresh git worktree with no `node_modules` and no `.env.local`.
2. Launch `/pickle-pipeline` (or `pipeline-runner.js` directly) against it with a valid ticket bundle.
3. Observe: pickle phase exits with 0 commits; citadel/anatomy-park proceed; szechuan-sauce loops past its configured `stall_limit` reporting an unchanged verdict every iteration until manually killed.

## Machine-checkable acceptance criteria

Revised to key on the structured signals the verified root causes identified, rather than on worker prose.

- [ ] A phase whose runner persisted a crash-floor `state.exit_reason` (`toolchain_unavailable` and every other member of the `mux-runner.ts:4464` terminal set) halts the pipeline at that phase boundary, regardless of exit code — Verify: unit test drives `shouldHaltAfterPhase`/`runPhaseIteration` with `exit_reason: 'toolchain_unavailable'` + exit code 1; assert halt, not `continuing to citadel`. — Type: test
- [ ] The halt is attributed, not silent: the phase-boundary halt stamps/preserves `toolchain_unavailable` and logs it, so `pipeline-status.json` does not report a bare `failed` — Verify: assert the persisted `exit_reason` survives `finalizePipeline` (the R-PRH three-case contract already covers this shape). — Type: test
- [ ] `classifyNoCommitExit` does NOT return `amnesiac` for an iteration whose diff is empty AND `HEAD` is unchanged, regardless of `num_turns` — Verify: unit test with `num_turns: 2` + empty diff + unchanged `HEAD`; assert the classification is not `amnesiac`. — Type: test
- [ ] The amnesiac path is provably bounded: `resetGapAnalysisForAmnesiacBreaker` does not zero `consecutive_amnesiac_exits`, so N consecutive amnesiac exits terminate the loop — Verify: unit test with a stubbed worker returning the same sub-5-turn blocked result 10× in a row; assert the runner exits with a terminal reason and that the count of LLM baseline measurements is bounded (today it is unbounded). — Type: test
- [ ] Regression floor: a genuine iterative convergence loop making real changing progress is NOT mistaken for a stall or an amnesiac exit — Verify: existing microverse-convergence tests remain green (`extension/tests/microverse-convergence.test.js`, `extension/tests/microverse-llm-judge-non-determinism-recovery.test.js`). — Type: test
- [ ] Net-subtractive check: the bundle adds no new state field, no new detector, no new gate, and no new skip flag — Verify: `git diff` introduces no new key in `StateStateFlags`/`MicroverseSessionState` and no new `skip_*_reason`. — Type: test

## Spun-off finding — judge non-determinism on an empty diff

Not this bundle's to fix, recorded so it is not lost: across ~11 gap-analysis cycles against a
**provably unchanged empty diff**, the LLM judge returned baseline scores `3, 2, 4, 1, … 0`. An empty
diff has no violations to find, so the only defensible score is a constant. This is adjacent to the
reopened R-JPCM (judge fails to emit a numeric score) and to the R-SLLJ ledger work, and it is the
reason each amnesiac reset cost real money rather than being merely wasteful. Worth its own finding
before anyone tunes the amnesiac thresholds, since a non-deterministic baseline defeats threshold
tuning by construction.
