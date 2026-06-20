# R-CCPL Phase 2 forensic — session 2026-05-14-7fe6da60

**Filed:** 2026-05-15
**Type:** Read-only research artifact (no source changes)
**Predecessor:** `prds/archive/bug-reports/codex-classifier-prompt-leak.md` (R-CCPL, Master Plan Finding #1 REOPENED P1)
**Successor:** Phase 1a-bis PRD scoped to H-D below.

## Summary

A new R-CCPL failure mode surfaced during the R-RHGS bundle launch on 2026-05-14. The original v1.74.0 fix (codex-aware `extractAssistantContent`, `detectOutputFormat`, `PromiseTokens`) addresses prompt-leak in the CLASSIFIER. This session exposes a different bug: **codex EXECUTES operator-facing examples from the manager-spawn prompt body as actions**. Same prompt produces correct manager behavior on claude (calls `spawn-morty.js`) but broken operator-impersonation on codex (calls `setup.js` itself, creating orphan sessions).

This is a new hypothesis H-D — distinct from H-A/H-B/H-C in the original PRD's Diagnostic Plan.

## Evidence

### What codex did (launch-stdout.log, 19:47-19:53 UTC)

Codex manager subprocess received the verbatim `/pickle.md` skill prompt (operator-facing tutorial). Codex's response chain:

1. Reads prompt → identifies `setup.js --task "..."` invocation examples (`pickle.md` lines 17-22, 53-54)
2. Decides to "run the required setup bootstrap" (literal codex log line at offset 197)
3. Executes `node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --task "--resume <SESSION_ROOT>"` — interpreting the prompt's documented invocation as orders
4. setup.js treats `--task "--resume <path>"` as task text → **creates orphan session `2026-05-14-afc7e9df`**
5. Codex re-runs setup.js with `--resume` flag correctly the second time
6. Eventually spawns spawn-morty.js for the ticket — but worker_timeout has been reset by the second setup.js call from 2400 → 1200

### What claude did (launch-stdout-2.log, 19:48 onwards)

Same prompt body. Claude opus-4-7 manager subprocess:
- Goes directly to `node "$HOME/.claude/pickle-rick/extension/bin/spawn-morty.js" "<DESC>" --ticket-id ... --ticket-file ...` (manager-level invocation)
- Never calls setup.js itself
- Correctly treats the operator-facing examples as DOCS, not ORDERS

### Operator-visible damage

- Orphan session `2026-05-14-afc7e9df` (caught and cleaned up by cron monitor)
- `state.worker_timeout_seconds` reset 2400→1200 (re-bumped manually 3 separate times across the run)
- Backend forced to fall back to claude for the entire pickle phase
- Cumulative operator-attention cost: ~30 minutes of manual recovery before the run could proceed

## Hypothesis H-D (new)

**The `/pickle.md` skill prompt is operator-facing documentation, but it is also the manager spawn payload. Codex parses operator-facing setup.js invocation examples as actions to execute.**

Disambiguation from prior hypotheses:
- **H-A (codex echoes prompt body):** partial overlap — codex DID echo the prompt's setup.js examples, but it also EXECUTED them. The classifier fix from v1.74.0 stops the echoes from being misread as completion tokens, but does nothing to prevent the execution.
- **H-B (delimiter detection gap):** not applicable — `detectOutputFormat` worked correctly; the codex output WAS detected as `codex` plain-text mode.
- **H-C (mux-runner strike accounting):** not applicable — no MANAGER_FALSE_EPIC_COMPLETED strikes were observed in this session.

H-D is **codex executes prompt-body instructions as actions**, distinct from echoing-as-text.

## Root cause

The manager spawn payload is built from `pickle.md` verbatim. `pickle.md` is operator-facing — it begins with documentation like:

> ```bash
> node "$HOME/.claude/pickle-rick/extension/bin/setup.js" <FLAGS> --task "<TASK_TEXT>"
> ```
> No flags: `setup.js --task "$ARGUMENTS"`. ...

Claude has been trained to treat fenced code blocks in skill-prompt context as documentation. Codex appears to lack that framing and treats the fenced commands as a task list. The R-PIWG-2 prompt hardening we just shipped removes destructive git commands but does NOT remove these setup.js invocation examples.

The fundamental issue: **the manager prompt and the operator prompt are the same artifact**. The skill prompt is loaded into both contexts (operator-facing via `/pickle` slash command in the UI, and manager-facing via mux-runner spawning a subprocess with the skill body). Codex doesn't distinguish these contexts.

## Recommendation

**Phase 1a-bis PRD scope (single-PRD, 4-5 tickets):**

1. **R-CCPM-1: Manager spawn payload de-pollution.** Strip operator-facing setup.js invocation examples from the manager-spawn payload. Either (a) replace with a brief role-framing header ("You are the MANAGER subprocess for this Pickle Rick session. Do NOT run `setup.js` — it has already been called. Your job is to call `spawn-morty.js` for each pending ticket"); or (b) load a separate `pickle-manager.md` payload for codex subprocess spawns that doesn't include operator-facing flow examples.

2. **R-CCPM-2: Codex manager guard.** Detect when the codex manager subprocess attempts `setup.js` execution by inspecting its tool-call stream. If detected, log `codex_manager_self_bootstrap_attempted` activity event and refuse to forward the bash invocation (sandbox the manager away from setup.js).

3. **R-CCPM-3: Orphan-session reaper.** If a codex manager creates a sibling session under `~/.local/share/pickle-rick/sessions/` while the parent session is still active, detect and clean up automatically on the next iteration boundary.

4. **R-CCPM-4: worker_timeout protection.** When state.worker_timeout_seconds drops below its launch-time value during a session, restore it on the next mux-runner iteration and log `state_worker_timeout_drift_corrected`.

5. **R-CCPM-5: Trap door + regression fixture.** Pin invariant at `extension/src/bin/CLAUDE.md`. Regression: spawn a codex manager with the deployed `pickle.md` and assert it does NOT call `setup.js` in its first 10 turns.

## Diagnostic deliverables (this artifact)

- ✅ Per-session forensic note: this file
- ✅ Hypothesis selection: H-D (new)
- ✅ Decision: draft Phase 1a-bis PRD scoped to H-D (above)

## Constraint

This artifact is read-only forensics. No source changes were made to research it. The R-RHGS bundle (which DID modify source) was unrelated to R-CCPL — those commits address Findings #36/#37/#38/#41, not Finding #1.
