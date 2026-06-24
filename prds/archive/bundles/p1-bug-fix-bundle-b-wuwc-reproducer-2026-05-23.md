---
title: P1 — Bug-fix bundle B-WUWC reproducer 2026-05-23 — regression coverage for worker-uncommitted-work-class data loss
status: Draft
filed: 2026-05-23
priority: P1
type: bug-bundle
r_code_prefix: R-WUWC
composes:
  - prds/BUG-REPORT-2026-05-18-pipeline-launch-friction.md
related:
  - prds/MASTER_PLAN.md
  - docs/closer-ticket-manager-handoff.md
backend_constraint: any
refine: false
unattended: true
remediation_phases_required: ["citadel"]
---

# PRD — Bug-Fix Bundle B-WUWC Reproducer 2026-05-23 — Regression Coverage for Worker-Uncommitted-Work-Class Data Loss

**Author**: Pickle Rick
**Project**: `pickle-rick-claude`
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`, local-only

## Why this bundle

R-WUWC (MASTER_PLAN Open Finding #52) is a P1 DATA-LOSS class finding. On session `2026-05-18-6108815e/fb4b547f/` the T01 worker produced 357 lines of real, on-spec spike code — `citation-spike.ts` (141 LOC) + `cost-latency-measure.ts` (216 LOC) — and the pickle orchestrator dropped both files on the floor uncommitted. `markTicketDone` was blocked by the `guardCompletionCommitBeforeDone` gate (no completion commit existed), the ticket wedged Failed for 2/2 consecutive iterations, the closer terminated, and `mux-runner` logged `Phase pickle completed successfully` — a false-green over real lost work. The 357 LOC sat untracked in the working tree until the operator manually salvaged via `git add` + commit `dbec6699d` (in the `loanlight-api` repo, NOT this repo).

The **prevention** for this class has shipped:

| Layer | Component | Trap door at HEAD `e4b8520f` |
|---|---|---|
| R-WSE-1 | `extension/src/services/worker-shutdown.ts` `flushAndExit(sessionLog, code)` — `sessionLog.end()` → `await once(sessionLog, 'close')` → `process.exit(code)` | `extension/CLAUDE.md` `src/services/worker-shutdown.ts` INVARIANT (drains buffered worker output before exit) |
| R-WSE-2 | `extension/src/bin/mux-runner.ts` `checkPartialLifecycleExit(sessionDir, statePath, ticketId)` emits `worker_partial_lifecycle_exit { ticket, gate_payload: { artifacts_missing: string[], session_log_size: int }, ts }` | `extension/CLAUDE.md` `src/bin/mux-runner.ts (R-WSE-2 partial lifecycle exit)`; `extension/tests/worker-partial-lifecycle-exit-schema-conformance.test.js` |
| R-WSE-3 | `extension/src/bin/mux-runner.ts` `checkFailedAfterResearchApproved` stderr breadcrumb `/\[warn\] \[<ISO-8601>\] ⚠ ticket <id> failed AFTER research APPROVED — see <session_dir>\/<id>\//` | `extension/CLAUDE.md` `src/bin/mux-runner.ts (R-WSE-3 failed-after-research-approved breadcrumb)`; `extension/tests/ticket-fail-after-research-approved.test.js` |
| R-PIPE-2 | `extension/src/bin/pipeline-runner.ts:2263` `recordExitReason(runtime.statePath, 'phase_no_progress')` stamped on `pipeline-status.json` when a phase ends with 0 Done / 0 commits | `extension/tests/pipeline-runner-phase-no-progress.test.js` |

What did **not** ship: a CONCRETE REPRODUCER TEST that exercises the R-WUWC failure path end-to-end and asserts all four signal classes fire. MASTER_PLAN Finding #52 carries the explicit note "B-PIPE-FIX hardening (R-PIPE-2/3/4 + R-WSE-2/3 observability) shipped; awaiting a fresh post-v1.78.0 reproducer to confirm prevention." Without that test, the next R-WUWC incident again requires a forensic dig through `worker_session_<pid>.log` shards, capture-pane reads, and manual `git status` archaeology — exactly the 48m 45s of wasted wall-clock from the original session.

Bug 5 recommended fix #2 (auto-commit working-tree changes with a stub message before terminating Failed) is NOT shipped in pickle-phase code paths. The only `auto-commit` callsites at HEAD live in `extension/src/bin/microverse-runner.ts` (lines 2577, 2579, 2583, 3205, 3208) which is a different code path serving microverse convergence rescue — pickle phase has no equivalent salvage. This bundle does NOT ship that salvage; it documents the absence as a STILL-OPEN follow-up.

## Live incident — 2026-05-23 (second occurrence, SOFTER variant)

Session `2026-05-23-17b2f716` (`B-PROJECT-AUDIT-2026-05-23`, 46 tickets, the same session that motivated `BUG-REPORT-2026-05-23-readiness-rejects-forward-created-tickets.md`) hit a SOFTER variant of R-WUWC at iteration 7 on ticket `be5a047d R-RVMW` ("Behavioral test for codex manager relaunch in microverse-runner"). Forensic timeline:

1. Worker wrote `extension/tests/microverse-codex-manager-relaunch.test.js`, ran `node --test` (passed), ran `npx tsc --noEmit` (passed).
2. Worker DID `git commit` — landed as `59810646: be5a047d add microverse codex relaunch regression test` (visible in `git log --oneline`).
3. Worker edited the ticket frontmatter to `status: "Done"` and emitted `<promise>TASK_COMPLETED</promise>`.
4. Worker did NOT add a `completion_commit: 59810646` field to the ticket frontmatter (`~/.local/share/pickle-rick/sessions/2026-05-23-17b2f716/be5a047d/linear_ticket_be5a047d.md` — frontmatter has `id`, `title`, `status`, `priority`, `order`, `working_dir`, `source_prd`, `source_section`, `mapped_requirements`, `created`, `updated`, `links` but NO `completion_commit`).
5. Closer ran. `guardCompletionCommitBeforeDone` invoked `hasCompletionCommit()`. The resolver scanned `git log` for the ticket-id token `be5a047d` in commit messages, found `59810646`, classified `source: 'inferred'` (not explicit because the ticket frontmatter doesn't pin the SHA), refused the Done flip.
6. Exact fatal text (verbatim from `tmux capture-pane -t pipeline-17b2f716:0`):
   > `[2026-05-23T20:17:04.024Z] [fatal] 2026-05-23T20:17:04.024Z ticket be5a047d cannot flip Done: hasCompletionCommit().source === 'inferred' (expected 'explicit'); worker did not produce an attributable git commit. Set state.flags.allow_inferred_completion_commit=true to bypass, or edit ticket frontmatter to include completion_commit: <sha>.`
7. `[2026-05-23T20:17:04.043Z] Phase pickle exited with code 0`
8. `[2026-05-23T20:17:04.072Z] Phase pickle exited clean but 45/46 tickets remain unresolved (1 Done) — incomplete bundle`
9. Pipeline halted at 0/4 phases; elapsed 29m 30s.

### Why this is a SOFTER variant

| Variant | Worker file edits | Worker `git commit` | Ticket frontmatter `completion_commit:` | Outcome | Reproducer must cover |
|---|---|---|---|---|---|
| **HARD (2026-05-18 historical)** | YES (357 LOC across 2 files) | NO | N/A | Work sits **untracked**; operator manual salvage required; **DATA LOSS** if salvage missed | YES — primary case |
| **SOFT (2026-05-23 live)** | YES (1 test file, ~120 LOC) | YES (`59810646`) | NO | Work **preserved in git**; ticket wedges Failed; pipeline halts at first incomplete ticket; **WORK SURVIVES, PROGRESS LOST** | YES — secondary case |

Both variants leave the pipeline in the same terminal symptom (ticket Failed, phase halt, false-green "Phase pickle exited with code 0"). The DIFFERENCE is whether the worker's output is recoverable — HARD case requires the operator to spelunk through `worker_session_<pid>.log` shards and manual `git add`; SOFT case requires a one-line frontmatter edit.

### Implication for AC-WUWC-N

The reproducer test (`extension/tests/wuwc-reproducer.test.js`, AC-WUWC-01) MUST exercise BOTH variants as distinct test cases:

- **Case A — HARD**: synthesize a worker that writes files to the working tree but never `git add`. Assert: `worker_partial_lifecycle_exit` fires with `artifacts_missing` listing the unstaged files; `working tree contains the files`; `markTicketDone` returns the appropriate `no_completion_commit` error class.
- **Case B — SOFT**: synthesize a worker that writes files, runs `git add` + `git commit`, but does NOT add `completion_commit:` to the ticket frontmatter. Assert: `hasCompletionCommit()` returns `{ source: 'inferred', sha: <the commit's SHA> }`; `markTicketDone` returns the `inferred_completion_commit` error class with the verbatim fatal text matching the 2026-05-23 evidence; `state.flags.allow_inferred_completion_commit=true` bypass path is available; `ticket frontmatter editable workaround` (add `completion_commit: <sha>`) flips the ticket Done on the next iteration's gate check.

The bundle's other ACs (WSE-1/2/3 + PIPE-2 conformance) remain unchanged — they cover the four signal-emission contracts regardless of variant.

### Forensic evidence retained

- Session dir: `~/.local/share/pickle-rick/sessions/2026-05-23-17b2f716/be5a047d/` (kept) — `linear_ticket_be5a047d.md` 3.6K, `worker_session_18401.log` 689.5K, `research_2026-05-23.md`, `plan_2026-05-23.md`, `conformance_2026-05-23.md`, `code_review_2026-05-23.md`, `handoff_notes.md`, `plan_review.md`, `research_review.md`.
- Git commit: `59810646 be5a047d add microverse codex relaunch regression test` (in `gregorydickson/pickle-rick-claude` `main`).
- tmux session `pipeline-17b2f716` still attached at filing time; window 0 shows "Pipeline Complete | Phases: 0/4 | Elapsed: 29m 30s".
- Operator unblock path (chosen): edit the ticket frontmatter to add `completion_commit: 59810646`, then resume via `node ~/.claude/pickle-rick/extension/bin/setup.js --tmux --resume <SESSION_ROOT>` — restart kicks the closer's `hasCompletionCommit()` re-check and the Done flip succeeds on the next iteration.

## Bundle thesis

> "Prevention without a reproducer is a hope. This bundle ships the test that fails when R-WUWC regresses, so the next operator finds the bug at gate time, not at salvage time."

If a section's fix isn't structurally aligned with that thesis, drop it.

## Backend constraint

`backend_constraint: any`. The reproducer test is a pure `node --test` integration test that synthesizes the failure shape via filesystem fixtures; it does not spawn a real backend. Either claude or codex can drive the closer.

## Refinement: DISABLED

`refine: false`. This bundle is 3 tickets — well under the refinement threshold (≥10 R-codes) cited by the MASTER_PLAN sizing note for #52 ("~2 tickets (test + ledger update)"). The third ticket is the bundle closer for MASTER_PLAN bookkeeping; the bundle PRD includes the closer as an explicit ticket rather than a wrapper-level invariant so the closer's DEFERRED-or-Closed decision is auditable as a refinement-free atomic unit.

## Bundle-level acceptance criteria

Machine-checkable, prefixed `AC-WUWC-N`:

- [ ] **AC-WUWC-01** — `extension/tests/wuwc-reproducer.test.js` exists, is discovered by `extension/tests/test-registration-hygiene.test.js`, and runs under `npm run test:integration`. (Tier registration is integration, not fast, because the test stages a synthetic session directory and reads multiple JSON artifacts; it does not invoke a real backend.)
- [ ] **AC-WUWC-02** — Reproducer synthesizes a worker session matching the `fb4b547f` failure shape: a temp `sessionDir` with a `<ticket>/` subdir containing `research_<id>.md` and `research_review.md` ending with `APPROVED`, a synthetic working tree containing ≥2 SYNTHETIC source files (`>100 LOC combined`) that are untracked from git's perspective, and NO completion commit on HEAD between session start and the partial-lifecycle check. (Fixture content is synthetic strings — the `dbec6699d` commit in `loanlight-api` is cited as forensic evidence only, never read by the test.)
- [ ] **AC-WUWC-03** — Reproducer asserts that the canonical `markTicketDone` path refuses to flip the ticket to Done while no completion commit exists (`guardCompletionCommitBeforeDone` gate fires); ticket status remains `Failed` or `In Progress` after the gate runs.
- [ ] **AC-WUWC-04** — Reproducer drives `checkPartialLifecycleExit(sessionDir, statePath, ticketId)` from `extension/src/bin/mux-runner.ts` and asserts a `worker_partial_lifecycle_exit` event is written to the session activity log with `event`, `ts` (ISO-8601), `ticket: <ticketId>`, and `gate_payload: { artifacts_missing: string[] (non-empty), session_log_size: int (≥ 0) }` — matching the schema at `extension/src/types/activity-events.schema.json:91-107`.
- [ ] **AC-WUWC-05** — Reproducer drives `checkFailedAfterResearchApproved(sessionDir, ticketId)` and asserts a stderr line matches `/\[warn\] \[\d{4}-\d{2}-\d{2}T[^\]]+\] ⚠ ticket <ticketId> failed AFTER research APPROVED — see [^\/]+\/<ticketId>\//`.
- [ ] **AC-WUWC-06** — Reproducer asserts that after the synthesized 0-Done / 0-commit phase outcome, `pipeline-status.json` carries `exit_reason: 'phase_no_progress'` (per `extension/src/bin/pipeline-runner.ts:2263` `recordExitReason(runtime.statePath, 'phase_no_progress')` and the R-PIPE-2 invariant covered by `extension/tests/pipeline-runner-phase-no-progress.test.js`).
- [ ] **AC-WUWC-07** — Reproducer asserts the working-tree diff is PRESERVED: the ≥2 synthetic files still exist on disk after the failure path runs, with their original byte sizes unchanged. (This is the load-bearing data-loss assertion — proves the working tree was not auto-cleaned.)
- [ ] **AC-WUWC-08** — Reproducer asserts the working-tree diff is SURFACED in observability: at minimum, the `worker_partial_lifecycle_exit.gate_payload.artifacts_missing` array is non-empty so the operator can see which lifecycle artifacts the worker skipped. If a working-tree-diff field is added to `pipeline-status.json` as part of Bug 5 recommended fix #3 (NOT scope of this bundle), AC-WUWC-08 will be tightened in a follow-up R-WUWC bundle.
- [ ] **AC-WUWC-09** — `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0 after the new trap door for `extension/tests/wuwc-reproducer.test.js` is pinned in `extension/CLAUDE.md`.
- [ ] **AC-WUWC-10** — Closer commit body (R-WUWC-3-CLOSER) either (a) closes MASTER_PLAN Finding #52 R-WUWC if the reproducer passes and AC-WUWC-01 through AC-WUWC-09 are all green, OR (b) stamps Finding #52 R-WUWC as DEFERRED with an explicit gap list naming each missing prevention layer (e.g., "auto-commit salvage from Bug 5 fix #2 not shipped — file follow-up bundle R-WUWC-2-SALVAGE").
- [ ] **AC-WUWC-11** — Reproducer SOFT-variant case (per `## Live incident — 2026-05-23`): synthesize a worker that writes ≥1 file to the working tree, runs `git add` + `git commit -m "<ticket-id> <summary>"`, edits the ticket frontmatter to `status: Done`, but does NOT add `completion_commit:` to the frontmatter. Assert: `hasCompletionCommit()` returns `{ source: 'inferred', sha: <commit SHA> }`; `guardCompletionCommitBeforeDone` raises a fatal whose message matches `/cannot flip Done: hasCompletionCommit\(\)\.source === 'inferred' \(expected 'explicit'\); worker did not produce an attributable git commit/`; the canonical bypass paths (`state.flags.allow_inferred_completion_commit=true` AND `completion_commit: <sha>` frontmatter edit) are both surfaced in the error message.
- [ ] **AC-WUWC-12** — Reproducer SOFT-variant recovery: after the AC-WUWC-11 fatal, simulating the frontmatter-edit bypass (write `completion_commit: <sha>` to the ticket file) MUST let the next iteration's `guardCompletionCommitBeforeDone` re-check classify the source as `'explicit'` and flip the ticket to `Done`. Asserts the documented operator recovery path is functional and not vacuous.

## Trap-door touchpoints

### TOUCHES (must stay green throughout the bundle)

| Code | File | Existing trap door |
|---|---|---|
| R-WSE-1 | `extension/src/services/worker-shutdown.ts` | `flushAndExit(sessionLog, code)` graceful drain (`extension/CLAUDE.md` `src/services/worker-shutdown.ts`) |
| R-WSE-2 | `extension/src/bin/mux-runner.ts` | `checkPartialLifecycleExit` emission with `{ artifacts_missing, session_log_size }` payload + explicit `ts` (`extension/CLAUDE.md` `src/bin/mux-runner.ts (R-WSE-2 partial lifecycle exit)`, `extension/src/bin/CLAUDE.md` `mux-runner.ts (R-WSE-2 worker_partial_lifecycle_exit ts)`) |
| R-WSE-3 | `extension/src/bin/mux-runner.ts` | `checkFailedAfterResearchApproved` stderr breadcrumb (`extension/CLAUDE.md` `src/bin/mux-runner.ts (R-WSE-3 failed-after-research-approved breadcrumb)`) |
| R-PIPE-2 | `extension/src/bin/pipeline-runner.ts:2263` | `recordExitReason(runtime.statePath, 'phase_no_progress')` (covered by `extension/tests/pipeline-runner-phase-no-progress.test.js`) |

### ADDS (one new trap door)

- **`extension/tests/wuwc-reproducer.test.js`** — INVARIANT: the reproducer MUST assert ALL FOUR signal classes in a single test pass: (1) `worker_partial_lifecycle_exit` event with conformant `gate_payload`, (2) `⚠ ticket <id> failed AFTER research APPROVED` stderr breadcrumb, (3) `phase_no_progress` exit_reason on `pipeline-status.json`, (4) working-tree diff PRESERVED on disk (synthetic files still exist with original byte sizes). BREAKS: dropping any single assertion lets one of the four R-WUWC prevention layers silently regress without trip-wire — operators discover the data loss again only after a fresh incident. ENFORCE: itself, plus `extension/CLAUDE.md` pinning. PATTERN_SHAPE: `worker_partial_lifecycle_exit[\s\S]*failed[\s\S]*AFTER[\s\S]*research[\s\S]*APPROVED[\s\S]*phase_no_progress` MUST match the test source.

## Ticket sizing

Three atomic tickets, each <30min wall-clock, <5 files touched, <4 acceptance criteria. The MASTER_PLAN sizing note says "~2 tickets (test + ledger update)"; this PRD adds a third (the CLAUDE.md trap-door pin) only because the existing test-tier registration check (`extension/tests/test-registration-hygiene.test.js`) and the trap-door enforcement audit (`extension/scripts/audit-trap-door-enforcement.sh`) are two distinct gates with two distinct invariants, and bundling both into the test-authoring ticket would push that ticket's surface above the 4-AC ceiling.

### R-WUWC-1 (M, ~30min) — author reproducer test

- **Files**: `extension/tests/wuwc-reproducer.test.js` (new, ~150 LOC)
- **ACs**:
  - Synthesizes failure shape per AC-WUWC-02 (temp session dir, ≥2 untracked synthetic source files >100 LOC combined, `research_review.md` ending APPROVED, no completion commit).
  - Asserts `worker_partial_lifecycle_exit` event payload conforms to `extension/src/types/activity-events.schema.json:91-107` per AC-WUWC-04.
  - Asserts `failed AFTER research APPROVED` stderr breadcrumb per AC-WUWC-05.
  - Asserts `phase_no_progress` exit_reason on `pipeline-status.json` per AC-WUWC-06 and working-tree diff preserved per AC-WUWC-07.

### R-WUWC-2 (S, ~15min) — pin trap door + register test tier

- **Files**: `extension/CLAUDE.md` (1 new trap-door entry under `## Trap Doors`), `extension/tests/test-registration-hygiene.test.js` (allowlist entry if needed for integration tier).
- **ACs**:
  - New trap-door entry for `extension/tests/wuwc-reproducer.test.js` exists in `extension/CLAUDE.md` with INVARIANT / BREAKS / ENFORCE / PATTERN_SHAPE matching the "ADDS" spec above.
  - `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0.
  - `extension/tests/test-registration-hygiene.test.js` passes (reproducer is discovered, no orphan-test regression).

### R-WUWC-3-CLOSER (S, ~15min) — MASTER_PLAN bookkeeping

- **Files**: `prds/MASTER_PLAN.md` (1 entry edit).
- **ACs**:
  - If AC-WUWC-01 through AC-WUWC-09 are all green, move Finding #52 R-WUWC to the archive/closed section with closure commit SHA and the new reproducer test path.
  - If any AC failed, mark Finding #52 R-WUWC as DEFERRED with an explicit gap list (one bullet per missing prevention layer or assertion).
  - Closer commit body lists the outcome explicitly (`Closed: #52 R-WUWC` OR `Deferred: #52 R-WUWC — gaps: <list>`).

## Pre-flight checklist (R-BUNDLE-PREFLIGHT-2026-05-23)

Before the bundle launches:

1. Working tree clean (no in-flight worker edits; only untracked PRD or `.dot` artifacts tolerated per `.pipeline-runner-dirty-allowed.json`).
2. HEAD on `main`; no detached HEAD or feature branch.
3. The four prevention layers are green at HEAD before the reproducer runs:
   - `npx tsc --noEmit` exits 0
   - `node --test extension/tests/worker-partial-lifecycle-exit-schema-conformance.test.js` exits 0 (R-WSE-2)
   - `node --test extension/tests/ticket-fail-after-research-approved.test.js` exits 0 (R-WSE-3)
   - `node --test extension/tests/pipeline-runner-phase-no-progress.test.js` exits 0 (R-PIPE-2)
   - `node --test extension/tests/services/worker-shutdown.test.js` exits 0 (R-WSE-1)
4. No prior pipeline session attached: `tmux ls 2>/dev/null | grep -E '^(pipeline|monitor-aux|refine)-' | head -1` returns empty.
5. The `dbec6699d` commit in `loanlight-api` is forensic evidence only — the reproducer MUST NOT read from it at runtime, so the loanlight-api repo does not need to be present.

## Risk Register

- **R1**: The reproducer fails because PREVENTION is incomplete (not because the test is wrong). For example, R-WSE-2 emits the event but with the wrong payload shape, or R-PIPE-2 stamps the wrong exit_reason. Mitigation: AC-WUWC-10 explicitly allows the closer to report DEFERRED with a gap list. The bundle closer ticket (R-WUWC-3-CLOSER) ALWAYS commits MASTER_PLAN bookkeeping; the outcome (Closed vs Deferred) depends on what the reproducer found, not on whether the reproducer ran. Follow-up R-WUWC bundles are filed per missing layer.
- **R2**: Coupling the test to historical session data would make it fragile (the `dbec6699d` commit could be force-deleted from `loanlight-api`; the original session_<pid>.log shards have already been pruned from session storage). Mitigation: AC-WUWC-02 mandates SYNTHETIC fixture content. The `dbec6699d` commit and the original session dir `~/.local/share/pickle-rick/sessions/2026-05-18-6108815e/fb4b547f/` are cited in this PRD as forensic evidence for WHY the reproducer exists, never as runtime fixtures.
- **R3**: The new trap-door entry collides with the existing R-WSE-2 trap door (both reference `worker_partial_lifecycle_exit`). Mitigation: the new entry's INVARIANT is at the TEST-SOURCE level ("the test source MUST contain assertions for all four signals"), not at the EVENT-PRODUCER level (R-WSE-2's invariant). The PATTERN_SHAPE for the new trap door anchors on a regex that matches the test source, not on `mux-runner.ts` source — no collision.
- **R4**: The reproducer is registered to `npm run test:integration` (not `test:fast`) because it stages a temp session directory and reads multiple JSON artifacts. Operators expect the R-WUWC regression coverage to ride with the integration suite, which IS run in the canonical release gate per the project `## Versioning` policy. If the test were placed in `test:fast`, the per-iteration CI overhead would grow; integration tier is the correct home.

## Closer behavior (R-WUWC-3-CLOSER)

- **Version bump**: patch (e.g., `1.78.x → 1.78.(x+1)`) — regression coverage only, no behavioral changes to runtime code paths.
- **Release gate**: run the full canonical release gate from `extension/`:
  ```
  cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc \
    && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh \
    && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh \
    && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh \
    && npm run test:fast && npm run test:integration \
    && RUN_EXPENSIVE_TESTS=1 npm run test:expensive
  ```
- **Deploy**: `bash install.sh --closer-context`; verify md5-parity for the 5 canonical compiled files per the install.sh R-PJV-6 / parity-gate invariant.
- **MASTER_PLAN bookkeeping**: per AC-WUWC-10 — either archive Finding #52 R-WUWC or stamp it DEFERRED with a gap list.
- **Closer commit body**: explicit outcome line (e.g., `Closed: MASTER_PLAN #52 R-WUWC via extension/tests/wuwc-reproducer.test.js` OR `Deferred: MASTER_PLAN #52 R-WUWC — gaps: auto-commit salvage from Bug 5 fix #2 not shipped`).

## What this bundle does NOT do

- Does NOT ship new prevention code. R-PIPE-2, R-PIPE-3, R-PIPE-4, R-WSE-1, R-WSE-2, R-WSE-3 all shipped in the B-PIPE-FIX bundle and are load-bearing throughout. Touching their source files is out of scope.
- Does NOT ship the auto-commit salvage mechanism from Bug 5 recommended fix #2. The drift sweep confirmed at HEAD `e4b8520f` that no auto-commit-on-Failed callsites exist in `extension/src/bin/mux-runner.ts`, `extension/src/bin/pipeline-runner.ts`, or `extension/src/bin/spawn-morty.ts` (the only `auto-commit` callsites live in `extension/src/bin/microverse-runner.ts`, which is a different code path for microverse convergence rescue). If the operator wants to ship Bug 5 fix #2 for pickle phase, that's a separate hardening bundle (proposed code `R-WUWC-2-SALVAGE`, NOT in this bundle's scope).
- Does NOT remove or weaken the `markTicketDone` gate. The `guardCompletionCommitBeforeDone` guard is load-bearing — see R-CTSF closer-handoff guards and the R-WSRC `## ⛔ Worker Forbidden Ops` table. The reproducer EXPECTS the gate to fire; weakening it would defeat the prevention itself.
- Does NOT touch the original session `~/.local/share/pickle-rick/sessions/2026-05-18-6108815e/` or the `dbec6699d` commit in `loanlight-api`. Those are forensic evidence cited in this PRD; the reproducer uses synthetic fixtures only.
- Does NOT bump the state schema, edit `pickle_settings.json`, or otherwise touch any worker-forbidden file.

## Triggering session

Will be assigned at launch via `/pickle prds/p1-bug-fix-bundle-b-wuwc-reproducer-2026-05-23.md` (small bundle, three atomic tickets — `/pickle` not `/pickle-tmux`). Session ID format: `2026-05-23-<8-char-hash>`. Either backend acceptable per `backend_constraint: any`.
