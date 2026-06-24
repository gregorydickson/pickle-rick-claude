# PRD: Anatomy-Park Aftermath — Three Follow-up Cleanups

**Status**: Draft (2026-04-29)
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Origin**: 5-agent review of the 59-commit anatomy-park overnight run on session `2026-04-25-9152e64b` (2026-04-28 → 2026-04-29). Agents flagged three small follow-up gaps; this PRD bundles them.

---

## Problem

The overnight anatomy-park phase shipped 59 trap-door fixes (defensive validation, tmp-file recovery propagation, `readRecoverableJsonObject` cross-cutting extraction). A 5-agent independent review found the work net-positive (HIGH confidence on behavioral parity, HIGH confidence on the extraction, MEDIUM confidence on catalog hygiene). Three discrete gaps surfaced — none blocking a release, all small enough that they should land as a single follow-up rather than dragging into a larger epic.

## Scope (3 sub-fixes)

### Sub-fix A — Trap-door catalog hygiene

`extension/CLAUDE.md` grew from **40 → 56 trap-door entries** during the overnight run. Catalog quality has drifted:

- **3 entries severely oversized** (>1500 chars each):
  - `src/services/pickle-utils.ts` — **4042 chars** (10+ subconditions, reads like a spec)
  - `src/bin/microverse-runner.ts` (main) — **2751 chars**
  - `src/bin/mux-runner.ts` — **2282 chars**
- **4 of 8 sampled ENFORCE clauses** use vague prose ("hang-path tests using sentinels") instead of explicit test filenames.

The catalog is meant to be a quick-reference index for engineers and code reviewers — it's drifted toward a living specification.

### Sub-fix B — `recoverable-json.test.js` dedicated unit tests

The `readRecoverableJsonObject` helper was extracted from `services/microverse-state.ts` into `services/recoverable-json.ts` overnight. The new module has **zero dedicated unit tests**:

- All current coverage is indirect: via `state-manager.test.js` orphan-tmp suite (which exercises the same logic embedded in StateManager) and via caller-level tests in 21 different files.
- When the backward-compat re-export from `microverse-state.ts` is eventually removed, that indirect coverage may decouple.

### Sub-fix C — Extend codex-manager relaunch path to `microverse-runner.ts`

Commit `bf4a002` added codex-manager auto-relaunch (≤5 retries) to `mux-runner.ts` — when a long-running codex subprocess hits the 4-hour wall and exits with `Subprocess error`, mux-runner relaunches it instead of stranding remaining tickets. This unblocked Phase 1 of yesterday's pipeline.

**Anatomy-park's `microverse-runner.ts` hits the exact same pattern but doesn't have the relaunch path.** Last night's Phase 2 ran for 12 hours, completed 70 iterations + 59 commits, then exited with `Subprocess error. Exiting loop.` after the codex subprocess crashed at the same wall. The pipeline never reached Phase 3 (szechuan-sauce).

---

## Acceptance Criteria

### Sub-fix A
- **AC-APF-A1** Catalog entries that exceed 1500 chars are split into atomic invariants (one INVARIANT / BREAKS / ENFORCE triple per entry).
- **AC-APF-A2** Every ENFORCE clause names a specific test filename (`extension/tests/<name>.test.js`) — no descriptive prose substitutes.
- **AC-APF-A3** No semantic content lost — every invariant present pre-cleanup is still present (possibly in a different entry).
- **AC-APF-A4** Catalog total length doesn't grow; ideally shrinks 10-20% after splitting + tightening.

### Sub-fix B
- **AC-APF-B1** New file `extension/tests/recoverable-json.test.js` with at least 6 test cases covering: orphan-tmp promotion (newer mtime wins), live-PID skip, dead-PID promotion, base file missing, base file corrupt, multiple competing tmps (highest mtime wins), file outside the orphan-tmp pattern (no-op).
- **AC-APF-B2** All cases use real filesystem (mkdtemp); no mocking the helper itself.
- **AC-APF-B3** Tests must pass without depending on `state-manager.test.js` infrastructure — fully standalone.

### Sub-fix C
- **AC-APF-C1** `microverse-runner.ts` main loop catches the `Subprocess error` exit path and relaunches the manager subprocess via the same evaluator pattern used in `mux-runner.ts` (`evaluateCodexManagerRelaunch` in `extension/src/bin/mux-runner.ts`).
- **AC-APF-C2** Per-relaunch counter persisted as `state.codex_manager_relaunch_count` (already exists from `bf4a002`) — same field, shared across mux + microverse.
- **AC-APF-C3** Relaunch cap: `Defaults.CODEX_MANAGER_RELAUNCH_CAP` (already 5).
- **AC-APF-C4** Activity event: emit `codex_manager_relaunch` (already in `VALID_ACTIVITY_EVENTS`).
- **AC-APF-C5** Backend-asymmetric: only fires for codex; claude path stays exit-on-error (claude iterations are per-iteration spawns, not long-lived sessions).
- **AC-APF-C6** Regression test in `extension/tests/microverse.test.js`: codex subprocess error + pending iterations + below cap → relaunch path; codex error + at cap → break.

## Non-goals

- Refactoring the 56 trap-door entries into a database / structured format. Markdown stays.
- Rewriting `recoverable-json.ts` itself; only adding tests.
- Introducing relaunch into `pipeline-runner.ts`. Pipeline-runner orchestrates phases; phase failure (mux-runner exit non-zero, microverse-runner exit non-zero) is a real failure signal that should propagate. The relaunch lives one level down in mux-runner / microverse-runner where it belongs.

---

## Atomic Tickets

### T1 — Catalog cleanup

Split the 3 oversized entries (`pickle-utils.ts`, `microverse-runner.ts main`, `mux-runner.ts`) into one atomic invariant per entry. Audit all 56 entries' ENFORCE clauses; replace prose with test filenames where possible. **min_new_tests: 0** (this is doc-only).

### T2 — `recoverable-json.test.js`

Create the test file per AC-APF-B1. Use `mkdtempSync` for isolation. **min_new_tests: 6** (one per AC sub-bullet).

### T3 — `microverse-runner.ts` relaunch wiring

Reuse `evaluateCodexManagerRelaunch` and `recordCodexManagerRelaunch` from `mux-runner.ts` (or extract the helper to `services/codex-manager-relaunch.ts` if shared cleanly). Wire into `microverse-runner.ts` main loop's subprocess error branch. **min_new_tests: 3** (codex relaunch / codex at cap / claude no-relaunch).

---

## Verification Plan

1. **Sub-fix A**: `wc -l extension/CLAUDE.md` before/after — expect 10-20% shrink. Diff trap-door entries pre/post — every INVARIANT present in old version still present in new. ENFORCE clauses grep: `grep -c "ENFORCE: .*test\.js" extension/CLAUDE.md` should be ≥ entry count (tolerance for entries with multiple test refs).
2. **Sub-fix B**: `node --test extension/tests/recoverable-json.test.js` — all cases pass independently. Mutation test: temporarily break `parseDeadTmp` in the source — at least 4 of the 6 tests should fail (proves coverage is meaningful).
3. **Sub-fix C**: Reproducer — start a codex microverse run, simulate subprocess error mid-iteration via `kill -9` on the codex child. Expect: `microverse-runner` relaunches it, activity log records `codex_manager_relaunch`, iteration counter resumes.

---

## Files Likely Touched

```
extension/CLAUDE.md                              # T1 (largest diff)
extension/src/bin/microverse-runner.ts          # T3
extension/src/services/codex-manager-relaunch.ts # T3 (if extracted from mux-runner.ts)
extension/src/bin/mux-runner.ts                 # T3 (if helper extracted)
extension/tests/recoverable-json.test.js        # T2 (new)
extension/tests/microverse.test.js              # T3 regression test
extension/tests/iteration-outcome.test.js       # T3 if helper test moves
```

---

## Linked Context

- Anatomy-park aftermath review: 5 agents (behavioral parity / API design / test coverage / trap-door preservation / cross-cutting integration) on the 59-commit overnight run.
- Codex-manager relaunch original: commit `bf4a002` (mux-runner only).
- `recoverable-json.ts` extraction: part of the 59-commit overnight run, no specific commit hash (cross-cutting).
- 5-agent verdict: HIGH / HIGH / MEDIUM confidence overall — work is net-positive but these three gaps remain.
