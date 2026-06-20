---
title: P1 — Bug-fix bundle 2026-05-04 COMPLETION (residuals + new findings, ships v1.70.0)
status: Shipped
filed: 2026-05-05
priority: P1
shipped: v1.70.0
type: bug-bundle
inherits_from: prds/archive/bundles/p1-bug-fix-bundle-2026-05-04.md
composes:
  - prds/archive/bundles/p1-bug-fix-bundle-2026-05-04.md           # 27 unshipped tickets carried forward
  - prds/archive/bug-reports/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md   # R-CNAR-7 NEW addendum
  - prds/archive/bug-reports/p2-codex-spark-worker-completion-commit-contract-violation.md  # R-CCC-5 NEW addendum
  - prds/archive/bug-reports/p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md  # R-SHB-5/6 NEW addenda
related:
  - prds/archive/bundles/p1-bug-fix-bundle-2026-05-05.md           # next-round bundle, defers behind this
target_release: v1.70.0
predecessor_session: 2026-05-04-f416c6cc (33 tickets shipped over runs #5–#6, then halted)
---

# PRD: P1 Bug-Fix Bundle 2026-05-04 — COMPLETION

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`

## Why a completion bundle (not a relaunch)

Bundle session `2026-05-04-f416c6cc` ran for 12+ hours across runs #5 and #6 attempts 1–3. **33 of 62 atomic tickets shipped** (Section A keystones, R-DTS-1..3, R-CNAR-1..6, R-XBL-1..9, R-TAQ-1..7, R-WSE-1..4, R-BUNDLE-CLEANUP, R-XBL-* test residuals — all in `git log 6be334b1..2c04b318`). 27 tickets remain undone. Three new bug classes surfaced during the run that block clean completion of the original bundle:

1. **Phantom-Done watcher's hash-only check** (run #6 forensic) — `hasCommitReferencingTicketSince()` searches commit messages for the ticket's 8-char hash; bundle commits use R-* codes; 100% miss rate; revert-cascade reaches even tickets with operator-backfilled `completion_commit:`. **R-CCC-5 NEW** (slot 1p forensic).
2. **Stale per-ticket cache cap-trip on relaunch** (run #6 attempt 1) — fresh `--resume` with `current_ticket=null` still reads `state.current_ticket_max_iterations` from the prior worker's last ticket; cap-check fires before any ticket starts. **R-CNAR-7 NEW** (slot 1g forensic).
3. **`current_sessions.json` phantom map entries after pipeline crash** (operator workaround #3) — 13 phantom entries pruned manually; `recoverStaleActiveFlag` does not demote on missing-sessionDir, mux-runner does not self-clean its map entry on terminal exit. **R-SHB-5/6 NEW** (slot 1n forensic).

Relaunching session `2026-05-04-f416c6cc` after a `bash install.sh` is contraindicated: the runner has stale code in-memory while new spawns get fresh code → mixed-state bugs. Composing a fresh bundle on cleanly-deployed code is the safe path.

The 33 shipped commits are real and in `main`. **This bundle does NOT re-implement them.** The R-BUNDLE-DISPO-2 disposition table below marks each shipped commit `ALREADY-SHIPPED` for the audit gate.

## Inherits from `prds/archive/bundles/p1-bug-fix-bundle-2026-05-04.md`

All sections, requirements, and acceptance criteria of the parent PRD are inherited unless explicitly overridden in this file. The 33 ALREADY-SHIPPED requirements stay verifiable via the parent. This PRD composes the **27 residual Todo tickets** + **3 new requirements (R-CCC-5, R-CNAR-7, R-SHB-5/6)** into a focused execution plan.

## ‼ Refinement directives — read first

| Concern | Fix | Owner |
|---|---|---|
| Audit gate must self-pass on first iteration | **R-BUNDLE-DISPO-1 ships first**; it provides the disposition table that exempts ALREADY-SHIPPED + REGRESSION-TEST-ONLY + DROP from `hallucinated-premise` checks. Without it, the bundle's own gate kills the bundle. | Section A |
| Phantom-Done watcher cannot revert work shipped by THIS bundle | **R-CCC-5 ships second**; replaces the hash-only commit-message search with a single `hasCompletionCommit()` helper called as the FIRST gate at every revert site. | Section B |
| Stale per-ticket cache must not cap-trip on resume | **R-CNAR-7 ships third**; iteration_start clears `state.current_ticket_max_iterations` when `state.current_ticket === null`. | Section C |
| Workers must not run on stale deployed code | Bundle launches AFTER `bash install.sh` from a clean tree. Mid-bundle deploys forbidden. R-ITS-5 (mid-bundle deploy guardrail) is in the **next-round bundle** (`prds/archive/bundles/p1-bug-fix-bundle-2026-05-05.md`), not this one. | Pre-flight |
| Wall-clock cap leak across `--resume` | Operator MUST reset `start_time_epoch` at launch (workaround). R-NTC default-off lands in next-round bundle, not this one. | Pre-flight |
| Manager stop-hook nudge cadence wastes turns | Workaround: `--max-turns 800` (double the default) for THIS bundle. R-MSCN fix lands in next-round bundle. | Pre-flight |

## Bootstrap exemption — R-BUNDLE-1 update

`state.flags.bundle_bootstrap_mode = "2026-05-04-completion-v1.70.0"` with NEW session-hash allowlist (the new session hash gets added by setup.js). Auto-applies BOTH `skip_readiness_reason` AND `skip_ticket_audit_reason` for THIS bundle's launch only. Activity event `bundle_bootstrap_exemption_applied` records both with `bundle_id="2026-05-04-completion"`.

## Per-requirement disposition table — R-BUNDLE-DISPO-2 (NEW)

Supersedes the parent's R-BUNDLE-DISPO-1 for purposes of THIS bundle's R-TAQ-2 audit gate. Format: `<R-CODE> | DISPOSITION | Notes`.

| Req | Disposition | Notes |
|---|---|---|
| R-XBL-1..9, AC-XBL-08, AC-EVENT-PAYLOAD-01 | **ALREADY-SHIPPED** | commits `7793a11 9437b0c 817e73c a3641e3 616f474 95f2c37 cd35ae82 6f1a5486 e5d64089 50c43b9c 8c692f2e 7ef0c041 a2690794 044a8d42 7d81aad6 ee2ae138` |
| R-DTS-1, R-DTS-2, R-DTS-3 | **ALREADY-SHIPPED** | commits `6f1a5486 308f07bb ef77d317` |
| R-CNAR-1, R-CNAR-1-part-2, R-CNAR-2, R-CNAR-3, R-CNAR-4, R-CNAR-5, R-CNAR-6 | **ALREADY-SHIPPED** | commits `9437b0c 6be334b1 7573df75 f2ab464a 4be21383 7cd8f8a3 caab90fd e0dec151` |
| R-TAQ-1, R-TAQ-2, R-TAQ-2b, R-TAQ-3, R-TAQ-4, R-TAQ-5, R-TAQ-6, R-TAQ-7 | **ALREADY-SHIPPED** | commits `6280e91c 6482f6dd 6b0614a9 b19946c6 fcc81832 135b319e fc63f552 2c04b318` |
| R-WSE-1, R-WSE-2, R-WSE-3, R-WSE-4 | **ALREADY-SHIPPED** | commits `1131cf3b eaf18761 9ebe97ce 67c5ebe2` |
| R-BUNDLE-CLEANUP | **ALREADY-SHIPPED** | commit `cd35ae82` |
| R-CCC-5 *(NEW)* | **IMPLEMENT** | Phantom-Done watcher: `hasCompletionCommit()` first-gate everywhere |
| R-CNAR-7 *(NEW)* | **IMPLEMENT** | iteration_start clears stale per-ticket cache when `current_ticket=null` |
| R-SHB-5 *(NEW)* | **IMPLEMENT** | `recoverStaleActiveFlag` demotes on missing sessionDir |
| R-SHB-6 *(NEW)* | **IMPLEMENT** | mux-runner cleans its own map entry on terminal exit |
| R-BUNDLE-DISPO-1 (parent) → R-BUNDLE-DISPO-2 (this bundle) | **IMPLEMENT** | committed at `extension/src/data/bundle-disposition-2026-05-04-completion.json` |
| R-BUNDLE-1, R-BUNDLE-2 | **IMPLEMENT** | bootstrap flag w/ NEW session-hash allowlist; baseline snapshot reused |
| R-RTRC-1..7 | **IMPLEMENT** | Section D — readiness resolver false positives |
| R-MWR-rename, R-MWR-1..8 | **IMPLEMENT** | Section E — monitor watchdog |
| AC-TAQ-09 | **IMPLEMENT** | defective + clean fixture sessions |
| Hardening×5 (Audit×2, Harden×2, Wire×1) | **IMPLEMENT** | Section I — bundle subsystems audit/harden/wire |
| R-CLOSER-1, Closer (bdbf368d) | **IMPLEMENT** | Section Closer — `closer-release-gate.sh` + `gh release create v1.70.0 --latest` |

JSON form lives at `extension/src/data/bundle-disposition-2026-05-04-completion.json` (per R-BUNDLE-DISPO-2).

## Section A — Bundle bootstrap *(FIRST)*

| Req | Disposition |
|---|---|
| **R-BUNDLE-DISPO-2** *(this PRD)* | Disposition table (above) committed at `extension/src/data/bundle-disposition-2026-05-04-completion.json`. R-TAQ-2 audit-ticket-bundle reads this file (NOT the parent bundle's). Exempts ALREADY-SHIPPED, REGRESSION-TEST-ONLY, DROP from `hallucinated-premise` check. |
| **R-BUNDLE-1** *(carried)* | `state.flags.bundle_bootstrap_mode = "2026-05-04-completion-v1.70.0"`; allowlist hash = NEW session hash; auto-applies BOTH skip flags; emits `bundle_bootstrap_exemption_applied`. |
| **R-BUNDLE-2** *(carried)* | Snapshot `extension/tests/fixtures/baseline-2026-05-03-7d9ee8cc/` already exists from parent bundle; verify present at launch via `extension/scripts/check-baseline-fixture.sh` (NEW lightweight pre-flight). |

**Section A — Acceptance Criteria**

- **AC-COMPLETION-A-01** — `bundle-disposition-2026-05-04-completion.json` exists, schema-valid against `bundle-disposition.schema.json` (carried from parent).
- **AC-COMPLETION-A-02** — Audit-ticket-bundle run on this session's tickets exits 0 (or only with non-fatal warnings); ALREADY-SHIPPED tickets are skipped via the disposition table.
- **AC-COMPLETION-A-03** — Activity event `bundle_bootstrap_exemption_applied` records `{bundle_id: "2026-05-04-completion", session_hash: <new>, flags: ["skip_readiness", "skip_ticket_audit"]}`.

## Section B — Phantom-Done watcher fix *(SECOND — R-CCC-5 NEW)*

Source: `prds/archive/bug-reports/p2-codex-spark-worker-completion-commit-contract-violation.md` `## Forensic addendum — 2026-05-05 mid-day, run #6`.

| Req | Description |
|---|---|
| **R-CCC-5** | Single shared helper `hasCompletionCommit(ticketFrontmatter): { sha: string\|null, source: 'explicit'\|'inferred'\|'absent' }` in `extension/src/services/pickle-utils.ts`. ALL phantom-Done revert sites — `correctPhantomDoneTickets` (mux-runner.ts:243), `validateAutoTicketCompletion` (mux-runner.ts:545), and any cached `getTicketStatus` path — call this helper as FIRST gate. Reverting Done→Todo permitted ONLY when helper returns `'absent'`. The existing `hasCommitReferencingTicketSince()` becomes a subroutine of the helper, not a parallel call site. |
| **AC-CCC-08** | Helper exists with three-state return type. Unit tests cover all three branches. |
| **AC-CCC-09** | Audit script `extension/scripts/audit-phantom-done-call-sites.sh` greps for any `status === 'Done'` revert pattern that bypasses the helper; CI fails on new instances. Wired into `audit-trap-door-enforcement.sh`. |
| **AC-CCC-10** | Replay test using `state.json.run6-handoff-snapshot` + `mux-runner.log.run6-handoff-snapshot` from session `2026-05-04-f416c6cc`: with operator-backfilled `completion_commit:` SHAs and bundle commit messages using R-* codes, zero false reverts. |

## Section C — Stale per-ticket cache cap-trip fix *(THIRD — R-CNAR-7 NEW)*

Source: `prds/archive/bug-reports/p1-deploy-typescript-symlink-and-cap-no-auto-resume.md` lines 142–212.

| Req | Description |
|---|---|
| **R-CNAR-7** | At iteration_start in `mux-runner.ts`, when `state.current_ticket === null`, clear `state.current_ticket_max_iterations` (set to `state.max_iterations`, the global cap). Cap-check at iteration boundary uses `Math.min(global, per-ticket)` ONLY when `current_ticket !== null`. |
| **AC-CNAR-07-01** | Unit test: state with `current_ticket=null` + `current_ticket_max_iterations=10` + `iteration=11` + `max_iterations=500` does NOT trip cap on iteration_start; budget resets. |
| **AC-CNAR-07-02** | Activity event `cap_check_skipped_stale_cache` recorded when reset fires. |
| **AC-CNAR-07-03** | Replay test using session `2026-05-04-f416c6cc` run #6 attempt 1 startup state: launch with `iteration=8 current_ticket=null current_ticket_max_iterations=10 max_iterations=500` → mux-runner does NOT exit with `iteration_cap_exhausted`. |
| **AC-CNAR-07-04** | Trap-door entry in `extension/CLAUDE.md`: "Per-ticket cap cache survives `current_ticket=null` only by accident; iteration_start MUST self-heal." |
| **AC-CNAR-07-05** | Regression in `extension/tests/mux-runner-cap-split.test.js`: extends existing test with the stale-cache scenario. |

## Section D — Stop-hook orphan-shadow residuals *(R-SHB-5/6 NEW)*

Source: `prds/archive/bug-reports/p2-stop-hook-blocks-launcher-of-tmux-bundle-via-orphan-session.md` lines 155–195.

| Req | Description |
|---|---|
| **R-SHB-5** | `recoverStaleActiveFlag` demotes the session and removes its `current_sessions.json` entry when the mapped session directory does not exist on disk. |
| **R-SHB-6** | `mux-runner.ts` cleans its own `current_sessions.json` map entry on terminal exit (`active=false` + `exit_reason ∈ {failed, orphan-paused-no-claim, signal}`); idempotent across crashes via `pruneOrphanedMapEntries` on next cwd-resolve hit. |
| **AC-SHB-05** | Unit test: missing sessionDir + mapped entry in `current_sessions.json` → `recoverStaleActiveFlag` removes the entry; subsequent stop-hook reads no longer see the orphan. |
| **AC-SHB-06** | Integration test: launch + crash a mux-runner; observe `current_sessions.json` no longer maps the dead PID; new mux-runner in same cwd claims cleanly. |

## Section E — Readiness contract resolver *(R-RTRC-1..7, carried verbatim from parent)*

Inherits parent Section D in full. Tickets `5c75a9eb 4f4b57de 5061cfbd c92566c2 abefd0d5 bad6cb66 7c72918a` carry their refined bodies forward.

## Section F — Monitor watchdog *(R-MWR-rename + R-MWR-1..8, carried verbatim from parent)*

Inherits parent Section E in full. Tickets `b178b3d5 ce7b0bf2 1eb67cc5 e7ecc172 db16ca78 528f2f32 04eead65 739314cf 9270858f` carry their refined bodies forward. R-MWR-rename (RESPAWN_WATCHDOG_INTERVAL_MS) MUST land first in this section to avoid R7 symbol collision.

## Section G — Audit fixtures *(AC-TAQ-09, carried from parent)*

Ticket `5beb7594` carries forward. Defective fixture `extension/tests/fixtures/audit-ticket-bundle/defective/` enumerates one ticket per defect class (8 fixtures); audit produces 8 `fatal` findings. Clean fixture → zero findings.

## Section H — Bundle subsystem hardening *(5 hardening tickets, carried from parent)*

Tickets `2a7d0000 50894a9f 6b4de66b aadcd07e 7793b88a` carry forward. Audit data flow + harden code/test quality + cross-reference consistency + wire integration.

## Closer — v1.70.0 release

| Req | Description |
|---|---|
| **R-CLOSER-1** *(carried)* | `extension/scripts/closer-release-gate.sh` exists per parent spec: pre-flight `gh api rate_limit ≥ 100`; `gh release create v1.70.0 --latest --notes-file <path>` with retry-on-429 (3 retries, 30s backoff); post-flight verifies `v1.70.0.isLatest=true` AND `v1.66.0.isLatest=false`. |
| **Closer ticket bdbf368d** *(carried)* | Bumps `extension/package.json` 1.69.0 → 1.70.0; runs full lint/test gate per CLAUDE.md (`npx tsc --noEmit && npx eslint --max-warnings=-1 && npx tsc && bash scripts/audit-*.sh && npm test:fast && npm test:integration && RUN_EXPENSIVE_TESTS=1 npm test:expensive`); test failures abort release; bash install.sh; commits dirty tree (must be empty); pushes 89+ commits in coherent order; `gh release create v1.70.0 --latest` via R-CLOSER-1; verifies post-flight. |

## Bundle-level Acceptance Criteria

- **AC-COMPLETION-01** — All 27 inherited Todo tickets + 4 new requirement-tickets (R-CCC-5, R-CNAR-7, R-SHB-5, R-SHB-6) reach `status: Done` with valid `completion_commit:` SHAs.
- **AC-COMPLETION-02** — Activity event count for `worker_partial_lifecycle_exit` during the run equals zero (R-WSE-1..4 + R-CCC-5 working in concert prevent the false-revert + silent-exit cascade).
- **AC-COMPLETION-03** — Activity event `cap_check_skipped_stale_cache` fires at least once on a `--resume` of this session (proving R-CNAR-7 path is exercised); zero `iteration_cap_exhausted` exits before a single ticket starts.
- **AC-COMPLETION-04** — `gh release view v1.70.0 --json isLatest --jq '.isLatest'` returns `true` AND `gh release view v1.66.0 --json isLatest --jq '.isLatest'` returns `false`. v1.66.0 demoted from GitHub-Latest.
- **AC-COMPLETION-05** — `prds/MASTER_PLAN.md` updated post-bundle to mark slots `1d 1e 1f 1g 1h 1i 1j 1k 1m 1n` SHIPPED via this completion bundle; queue slot `0-next` (`prds/archive/bundles/p1-bug-fix-bundle-2026-05-05.md`) becomes the active queue head.
- **AC-COMPLETION-06** — `current_sessions.json` contains zero phantom map entries at run end (R-SHB-5/6 working).

## Risks

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| RC-R1 | R-CCC-5 helper covers gates A and B but not the third (cached `getTicketStatus` path) — bug recurs | Med | Med | AC-CCC-09 audit script greps the codebase for any `status === 'Done'` revert pattern; CI fails on bypass. Refinement Cycle 2 enumerates every read site. | Section B |
| RC-R2 | R-CNAR-7 reset fires when it shouldn't (e.g., legitimate per-ticket override) | Low | Low | Reset only when `current_ticket === null`; legitimate overrides set `current_ticket` first. | Section C |
| RC-R3 | R-SHB-5 demotion races with a starting mux-runner | Low | Low | mux-runner setup writes its map entry BEFORE clearing `recoverStaleActiveFlag`'s critical section; existing serialization holds. | Section D |
| RC-R4 | Closer's R-CLOSER-1 fails on `gh` rate-limit during 89-commit push | Low | Med | Pre-flight `gh api rate_limit ≥ 100`; retry-on-429; if push half-fails, do NOT rewrite history — print manual recovery command. | Closer |
| RC-R5 | Mid-bundle `bash install.sh` accidentally invoked | Med | High | Hard banner in mux-runner.log.intro. R-ITS-5 mid-bundle deploy guardrail is in next-round bundle, not this one — operator discipline only. | Pre-flight |
| RC-R6 | Audit gate self-passes on disposition table but the table itself has a bug (e.g., wrong SHA for an ALREADY-SHIPPED entry) | Med | High | AC-COMPLETION-A-01 schema-validates the disposition JSON; refinement Cycle 1 spot-checks 5 random ALREADY-SHIPPED entries against `git log`. | Section A |
| RC-R7 | 89+ unpushed commits include this morning's PRD doc churn that the closer shouldn't push | Med | Low | Closer's diff-pre-flight prints commits to be pushed; operator sign-off required at first run; subsequent runs follow established baseline. | Closer |

## Pre-flight checklist (before `/pickle-refine-prd`)

- [ ] `git status --short` clean (no uncommitted changes outside this PRD).
- [ ] All 5 hot files md5-parity OK between source and `~/.claude/pickle-rick/extension/`. Run `bash install.sh` ONCE NOW if drift, then verify before launching.
- [ ] `~/.local/share/pickle-rick/sessions/2026-05-04-f416c6cc/` snapshots present: `state.json.run6-handoff-snapshot`, `mux-runner.log.run6-handoff-snapshot` (already done at 10:46).
- [ ] `extension/tests/fixtures/baseline-2026-05-03-7d9ee8cc/` snapshot present (from parent bundle).
- [ ] `current_sessions.json` for this cwd is empty OR points to a live session — no phantom entries.
- [ ] No live mux-runner / spawn-morty processes from any prior bundle (`ps -ef | grep -E "mux-runner|claude.*--max-turns" | grep -v grep` returns empty).
- [ ] `start_time_epoch` will be `now` at fresh launch (this is automatic for new sessions; only a concern on `--resume`).
- [ ] `extension/package.json` version is `1.69.0` (closer bumps to `1.70.0`).
- [ ] v1.66.0 still poison-Latest on GitHub — closer fixes via `gh release create v1.70.0 --latest`.

## Refinement directives (Cycle 1 / 2 / 3)

**Cycle 1** — verify the disposition table line-by-line against `git log 6be334b1..HEAD` and the parent bundle's R-codes. Flag any ALREADY-SHIPPED entry whose SHA isn't reachable.

**Cycle 2** — for R-CCC-5: enumerate every `status === 'Done'` read site in the codebase. Each must call `hasCompletionCommit()` as the FIRST gate. Document any read site found that the requirement misses.

**Cycle 3** — for R-CNAR-7: confirm reset semantics don't break the per-ticket budget enforcement when a ticket IS active. Verify the regression test in `mux-runner-cap-split.test.js` covers BOTH scenarios (active ticket + null ticket) without flakes.

## Files in scope (delta from parent)

- **NEW**: `extension/src/services/pickle-utils.ts` (or wherever `hasCompletionCommit` lands per refinement; current location `extension/src/services/pickle-utils.ts` is canonical for utility helpers).
- **NEW**: `extension/src/data/bundle-disposition-2026-05-04-completion.json`.
- **NEW**: `extension/scripts/audit-phantom-done-call-sites.sh`.
- **NEW**: `extension/scripts/check-baseline-fixture.sh`.
- **MODIFIED**: `extension/src/bin/mux-runner.ts` — `correctPhantomDoneTickets`, `validateAutoTicketCompletion`, iteration_start cap reset, terminal-exit map cleanup.
- **MODIFIED**: `extension/src/services/state-manager.ts` — `recoverStaleActiveFlag` missing-sessionDir branch.
- **MODIFIED**: `extension/CLAUDE.md` — trap-door entries for R-CCC-5 + R-CNAR-7.
- All other files-in-scope inherited from parent Sections D, E.

---

*Pickle Rick out. Compose then refine. Don't relaunch the corpse session.*
