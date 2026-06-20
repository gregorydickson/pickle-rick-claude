---
title: P3 — mux-runner respawns monitor + watcher panes with per-iteration codex temp dir instead of canonical SESSION_ROOT
status: Draft
filed: 2026-05-12
priority: P3
type: bug
finding: 27
r_codes:
  - R-MMRT-1
  - R-MMRT-2
  - R-MMRT-3
  - R-MMRT-4
  - R-MMRT-5
sister_prds:
  - prds/p3-monitor-dashboard-stale-after-pickle-to-anatomy-park-transition.md
related:
  - prds/MASTER_PLAN.md
---

# PRD — mux-runner monitor respawn uses temp dir not SESSION_ROOT (R-MMRT)

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Problem

### Symptom

Operators of codex-backend pipelines observe that the in-session 4-pane monitor window flickers and never stabilizes. Panes flip between rendering a correct dashboard for the live session and then `◤ SESSION COMPLETE ◢` / `◤ FEED TERMINATED ◢` banners within seconds. Eventually 2 of the 4 panes vanish entirely from the tmux window (rebalanced layout), leaving the operator with no usable dashboard.

Discovered 2026-05-12 during the 2026-05-12 mega-bundle launch (session `2026-05-11-e1a3a5dd`). Operator manual rebuild via `tmux send-keys "node monitor.js $SESSION_ROOT"` renders the correct dashboard ("Project: pickle-rick-claude, Phase: research, Current: bad8f6e6 R-SAOV-4, Active: ▣ ONLINE") for ~2 seconds, then gets trampled.

### Smoking-gun trace

Pane-0 scrollback during a stable manual launch followed by mux-runner trampling:

```
❯ node /Users/gregorydickson/.claude/pickle-rick/extension/bin/monitor.js \
      /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-11-e1a3a5dd

◤ PICKLE RICK — LIVE MONITOR ◢
  Project:    pickle-rick-claude
  Phase:      research
  Current:    bad8f6e6: R-SAOV-4
  Active:     ▣ ONLINE
◤ SESSION COMPLETE ◢

❯ node /Users/gregorydickson/.claude/pickle-rick/extension/bin/monitor.js \
      /private/var/folders/2w/.../T/pickle-mux-runner-A9tEGB/session

◤ PICKLE RICK — LIVE MONITOR ◢
  Project:    pickle-mux-runner-A9tEGB
  Task:       test iteratio…
  Phase:      research
  Iteration:  1 / 100
  Active:     ▣ ONLINE
◤ SESSION COMPLETE ◢

❯ node /Users/gregorydickson/.claude/pickle-rick/extension/bin/monitor.js \
      /private/var/folders/2w/.../T/pickle-mux-runner-v4j9Bb/session
…
```

The temp-dir suffix changes each cycle (`A9tEGB`, `v4j9Bb`, `xZnmUl`, `kiYPQj` — one per codex spawn iteration). The "Project: pickle-mux-runner-*" line in the rendered dashboard is the unambiguous fingerprint: that temp-dir state.json belongs to a different (test/scratch) session, not the live pipeline.

### Root cause

`restartDeadWatcherPanes` in `extension/src/services/pickle-utils.ts` (consumed by mux-runner at every iteration boundary to respawn dead watcher panes per the R-MWR-1 trap-door) is being invoked with the **wrong `sessionDir` argument**. The argument resolves to mux-runner's current codex spawn working directory — a per-spawn ephemeral tmp dir at `/private/var/folders/.../T/pickle-mux-runner-<8-char-rand>/session` — rather than the canonical pickle session root (e.g. `/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-05-11-e1a3a5dd`).

Each respawn launches monitor.js / log-watcher.js / morty-watcher.js / raw-morty.js pointing at a tmp dir whose state.json either does not exist or belongs to a transient scratch session. The watchers detect `state.active !== true` (or unreadable state) and exit immediately via their canonical banners. Because the dispatch happens every iteration, the cycle repeats indefinitely; the visible panes flicker and never stabilize.

The same call site is correct for codex's exec command (mux-runner intentionally uses `--ephemeral --skip-git-repo-check --add-dir <canonical>` to isolate the worker's cwd from the canonical session). The bug is that the watcher-respawn call inherits the same wrong-cwd-derived value where it should use the canonical session path.

### Why this surfaced now

The R-MWR-1 respawn watchdog inside `monitor.ts:main()` (added per the R-MWR family of fixes) revives dead panes more aggressively than before. Prior to R-MWR-1 a dead pane often stayed dead; the wrong-sessionDir respawn never fired in steady state. With the watchdog in place, every iteration drives a respawn with the wrong argument and the bug becomes visible.

### Severity

P3 — purely cosmetic. The actual pipeline progresses normally underneath; the operator can read state directly via `jq` and tail logs. Climbs to P2 if any future operator relies on the dashboard for a cancel/continue decision and acts on a structurally-wrong `SESSION COMPLETE` banner. Recurrence is structural and 100% reproducible on every codex-backend pipeline session.

### Sister-PRD landscape

| Finding | R-code | Layer | Sister kind |
|---|---|---|---|
| #15 | R-MDS | dashboard *content template* freeze on phase transition | Same surface (monitor panes); different root cause (content vs argument) |
| — | R-MWR-1..6 | monitor watchdog + log-watcher resilience family | Same call site; this PRD fixes the argument-resolution gap left by R-MWR-1 |

## Scope

### Objective

One measurable goal: every invocation of `restartDeadWatcherPanes` in the entire mux-runner / pipeline-runner / monitor-watchdog chain passes the canonical pickle session root as `sessionDir`, never a per-spawn temp working directory.

### Done looks like

- Running a 5-iteration codex-backend pipeline and capturing the monitor pane shows the canonical project name (e.g. `pickle-rick-claude`) in every render — never `pickle-mux-runner-<rand>`.
- No occurrence of `pickle-mux-runner-` substring appears in any spawned watcher's command-line argv during a healthy run.
- Existing R-MWR-1 watchdog respawn cycle continues to fire every 30 seconds and remains effective at reviving dead panes.
- A regression test mocks a codex spawn with `process.cwd` pointing at a temp dir and asserts that `restartDeadWatcherPanes` still uses the canonical session_root.

### In-scope (this PRD)

- `extension/src/services/pickle-utils.ts` `restartDeadWatcherPanes` and its callers
- Every mux-runner / pipeline-runner / monitor.ts call site that passes a `sessionDir` argument into respawn helpers
- One new regression test under `extension/tests/`
- One trap-door pin at `extension/src/services/pickle-utils.ts` (or `extension/CLAUDE.md` if registry-style)

### Not-in-scope (filed for follow-up)

- The R-MWR-1 / R-MWR-2 / R-MWR-3 / R-MWR-4 / R-MWR-5 / R-MWR-6 watchdog family (shipped; unaffected by this fix).
- The R-MDS dashboard-content-template family (shipped via bundle 2026-05-10; different bug).
- Replacing tmux as the orchestration layer (out of scope; separate research surface).
- A wholesale rewrite of session_dir resolution across the codebase. This PRD fixes only the watcher-respawn argument; broader cleanup of `process.cwd()` usage is a separate epic.

## Functional Requirements

### R-MMRT-1 — Audit call sites and identify the bleed point

A diagnostic pass enumerates every call to `restartDeadWatcherPanes` across `extension/src/` and identifies which argument-resolution path is yielding a per-spawn temp dir. Output is a short artifact under `extension/audit/` listing each call site with its computed `sessionDir` value at runtime under codex backend.

Acceptance: the artifact identifies at least one call site whose `sessionDir` argument originates in `process.cwd()` or in a derived value that has been mutated by a prior codex spawn.

### R-MMRT-2 — Thread canonical session_root through every respawn call site

Every call site identified by R-MMRT-1 is refactored to source `sessionDir` from one of: (a) the runner's stored `runtime.statePath`'s parent directory, (b) an explicit `SESSION_ROOT` constant captured at process startup, or (c) the resolved `pickle_state.session_dir` field. No call site uses `process.cwd()` or any value derivable from the current codex spawn.

Acceptance: a grep of the production code for `restartDeadWatcherPanes` invocations shows every call's `sessionDir` argument originating from one of the three canonical sources above.

### R-MMRT-3 — Trap-door pin

A trap-door entry is added at `extension/CLAUDE.md` (and/or the `extension/src/services/CLAUDE.md` subsystem doc when present) declaring the invariant: `restartDeadWatcherPanes` MUST always be called with the canonical pickle session root; never with `process.cwd()` or any per-spawn temp directory. The entry is ENFORCEd by a regression test that grep-asserts the call sites match an allowed shape.

Acceptance: `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0 with the new entry referenced.

### R-MMRT-4 — Regression test

A new test file under `extension/tests/` exercises a mock 5-iteration codex spawn where `process.cwd` is set to a per-iteration temp dir. The test asserts: (a) every `restartDeadWatcherPanes` call records the canonical session_root in its argv; (b) the spawned watcher command-line argv contains the canonical path, not the temp path; (c) no `pickle-mux-runner-` substring appears in the asserted argv values.

Acceptance: the test passes; `cd extension && npm run test:fast` exit code 0.

### R-MMRT-5 — Closer

Ticket that bumps version (delegated to bundle closer if shipping inside a bundle), closes Finding #27 in MASTER_PLAN, moves the entry to MASTER_PLAN-archive. Auto-skips version + release-gate when running inside a bundle whose closer handles those steps.

Acceptance: MASTER_PLAN no longer lists Finding #27 in Open Findings; archive contains the entry verbatim.

## Interface Contracts

### Contract 1 — restartDeadWatcherPanes session_dir argument

The `sessionDir` parameter accepts only paths that satisfy the predicate "directory contains a `state.json` whose `session_dir` field equals the same path". Per-spawn temp dirs at `/private/var/.../T/pickle-mux-runner-*/session` fail this predicate and MUST not be passed.

### Contract 2 — Caller-side resolution

Each caller resolves `sessionDir` BEFORE calling `restartDeadWatcherPanes`; the helper does NOT itself derive `sessionDir` from `process.cwd()` or from environment variables that the codex spawn may have rewritten.

## Verification Strategy

- Unit tests for the canonical-source resolution at each call site.
- Regression test for the mock-codex-spawn scenario (R-MMRT-4).
- Audit script (`audit-trap-door-enforcement.sh`) verifies the new ENFORCE entry.
- Manual smoke: launch a fresh codex-backend pipeline and observe the monitor dashboard renders "Project: pickle-rick-claude" continuously for 10+ iterations with no `pickle-mux-runner-` substring in any captured pane.
- `npm run test:fast` and `npm run test:integration` both pass.

## Test Expectations

- 1 new regression test file or 4 new test cases in an existing nearby test file (`mux-runner.test.js` or `pickle-utils.test.js`).
- Net new tests: 4-6. All in fast tier.

## Out-of-Band Concerns

- This PRD does NOT modify the codex spawn working-directory convention (`--ephemeral --skip-git-repo-check --add-dir <canonical>`). Codex still operates from its own temp working dir; the fix is purely caller-side argument plumbing.
- This PRD does NOT modify the R-MWR-1 watchdog itself. The watchdog correctly respawns dead panes; the fix gives it the right path to point them at.
- If R-MWR-3 log-tag enforcement is regression-checked alongside R-MMRT-4, the watcher-respawn log lines must show both the canonical session_root AND the `monitor-watchdog:` log prefix.

## Risk Register

- **R1**: Changing the `sessionDir` argument source could regress an edge case where the current (buggy) temp-dir behavior happens to mask a deeper issue (e.g. session-map staleness). Mitigation: the test in R-MMRT-4 covers both the canonical path and a stale-session-map case to catch regressions.
- **R2**: Calls that use a centralized helper (e.g. `getCanonicalSessionDir()`) may need a small new helper. Adding one is allowed but the helper must source its value from the same three canonical sources listed in R-MMRT-2.

## Sister-PRD bundling recommendation

Ship R-MMRT as part of the bundle that follows the 2026-05-12 mega. It can bundle cleanly with R-CSI Phase 2 (session.lock + destructive-guard) since both touch the runner / monitor surface, OR ship as a standalone half-day fix alongside R-FGNC (P2 npmrc warn pollution) and R-SLLJ (the missed P1 from the mega).
