---
title: P3 bug-fix bundle — B-E2E — E2E regression test for "20-ticket session auto-recovers via max-turns relaunch" (residual of #19 R-MMTR-6)
status: Draft
filed: 2026-06-01
priority: P3
type: bug-bundle
code: B-E2E
composes:
  - "#19 R-MMTR-6 (residual) — the oversized E2E regression ticket force-skipped from the B-R-MMTR closeout; the surrounding R-MMTR family shipped v1.89.1, this is the missing test-coverage residual only"
source:
  - prds/archive/bug-reports/p1-mmtr-6-decompose-e2e-into-sub-tickets.md   # R-MMTR6S decomposition — the 4-sub-ticket plan (R-MMTR-6A..6D) this bundle implements verbatim
backend_constraint: any
launch_constraint: |
  Launch WITHOUT `/pickle-refine-prd`. The 4 sub-tickets (R-MMTR-6A..6D) are pre-decomposed and authored explicitly below. The source PRD's AC-1 ("refinement team produces R-MMTR-6A..6D as separate tickets") is MOOT: B-WEDGE (#30 R-RSU) shipped v1.89.5 with `BUNDLE_OF_BUNDLES_FANOUT_SECTION` analyst-prompt fan-out guidance + the `detectBundleOfBundlesOverCollapse` over-collapse guard, so refinement already fans out atomic tickets — there is no fan-out gap to validate here. This bundle is the test-build itself, not a refinement-behavior test.
---

# B-E2E — E2E regression: 20-ticket session auto-recovers via max-turns relaunch

> **Schema-neutral.** This bundle adds a test fixture, a test harness, an integration test, and CI-gate registration. It touches NO persisted `state.json` field, adds NO activity event, and does NOT bump `LATEST_SCHEMA_VERSION`. Closer is a PATCH release (1.89.5 → 1.89.6).

> **B-WEDGE re-scope note.** The source PRD (`prds/archive/bug-reports/p1-mmtr-6-decompose-e2e-into-sub-tickets.md`, filed 2026-05-13) framed itself around the refinement team correctly fanning out the E2E ticket into sub-tickets (its AC-1). That framing is **dropped**: B-WEDGE (#30 R-RSU, shipped v1.89.5) already added the analyst fan-out guidance and the emission-time over-collapse guard. The original R-MMTR-6 session `2026-05-13-c122b0f7` / hash `fd1fff6c` is long gone — there is nothing to "retire". This bundle is a **fresh implementation** of the missing E2E test, decomposed exactly as the source Solution specified (R-MMTR-6A → 6B → 6C → 6D).

## Trigger

The claude-backend max-turns manager relaunch path (R-MMTR-3, shipped) and the codex `Session inactive` relaunch path (R-CMWL-1, shipped v1.88.0) are the runtime mechanism that keeps a long pickle phase alive across the manager's turn boundary: when the manager subprocess exits cleanly with tickets still pending, the runner relaunches it (bounded by `CLAUDE_MANAGER_RELAUNCH_CAP=20` / `CODEX_MANAGER_RELAUNCH_CAP=10`) instead of tearing down. These paths are covered by **unit / single-branch tests** (`mux-runner-claude-max-turns-relaunch.test.js`, `mux-runner-codex-inactive-relaunch.test.js`, `manager-relaunch.test.js`) that exercise one `processCompletionBranch` / `evaluateManagerRelaunch` decision at a time. There is **no end-to-end regression test** that drives a multi-ticket session through repeated relaunch cycles to all-Done and asserts the final ticket distribution — the exact failure shape that an oversized merged ticket originally tried (and failed) to cover.

## Root cause / context (the oversized-ticket incident + B-WEDGE relationship)

Per the source PRD: the original R-MMTR-6 ticket (session `2026-05-13-c122b0f7`, hash `fd1fff6c`, "E2E regression — 20-ticket session auto-recovers via max-turns relaunch") was a single ticket whose implementation required four distinct deliverables — a 20-ticket synthetic session fixture, a replay-stubbed harness exercising the relaunch loop, multi-scenario assertions over manager state, and CI wiring (~500 LOC across multiple files). That exceeded a single worker iteration budget: it burned 8 worker subprocesses across 14 iterations (~80 min), landed 0 commits, hit the false-EPIC counter twice, and was operator-force-skipped at 21:35Z to save the remaining 52 tickets of the bundle. Research and plan artifacts landed within budget; only the implementation could not finish in one iteration, and resumed iterations could not re-load partial context fast enough.

The fix (this bundle) is the source PRD's Solution verbatim: split the work into four atomic sub-tickets, each completable within a single-worker iteration with budget headroom, with the dependency chain 6A → 6B → 6C, and 6D depending on 6C.

**Relationship to B-WEDGE (#30 R-RSU):** B-WEDGE shipped the structural fix that makes refinement fan out atomic tickets instead of collapsing them into oversized umbrellas (`BUNDLE_OF_BUNDLES_FANOUT_SECTION` + `detectBundleOfBundlesOverCollapse`, trap door in `extension/src/bin/spawn-refinement-team.ts`). That closes the *general* over-collapse class. B-E2E is the *specific* residual: it ships the concrete E2E test the oversized R-MMTR-6 ticket was supposed to deliver. Because B-WEDGE already guarantees correct fan-out, this bundle launches WITHOUT refinement and authors the 4 sub-tickets explicitly.

## Real relaunch contract the test must assert against (verified against code)

The harness/test ACs below are grounded in the actual relaunch runtime:

- **Activity event:** `manager_max_turns_relaunch` is emitted by `recordManagerRelaunch` for both `claude_max_turns` and `codex_session_inactive` exit kinds (`extension/src/services/manager-relaunch.ts:218-230`), carrying `{ backend, relaunch_count, cap, pending_count, last_ticket_seen }`. Non-max-turns relaunches emit `codex_manager_relaunch` (`manager-relaunch.ts:233-238`). The event is registered in `VALID_ACTIVITY_EVENTS` (`extension/src/types/index.ts:600`).
- **State counter:** `recordManagerRelaunch` increments `state.manager_relaunch_count` to `decision.nextRelaunchCount` and deletes the legacy `codex_manager_relaunch_count` (`manager-relaunch.ts:204-212`). Field invariant pinned in `extension/CLAUDE.md` (`manager_relaunch_count`).
- **Relaunch decision:** `evaluateManagerRelaunch(state, tickets, cbState, exitKind)` returns `{ shouldRelaunch, pendingCount, nextRelaunchCount, reason, cap, backend, exitKind }`; `reason: 'cap_exceeded'` once `prior >= cap` (`manager-relaunch.ts:107-185`). Cap = `CLAUDE_MANAGER_RELAUNCH_CAP` (20) for `claude_max_turns`, `CODEX_MANAGER_RELAUNCH_CAP` (10) otherwise.
- **Branch entry point:** `processCompletionBranch(state, result, ctx)` (`extension/src/bin/mux-runner.ts:4000`) returns `{ kind: 'relaunch', relaunchCount, pendingTickets, resetStall }` on an eligible relaunch and `{ kind: 'break', reason }` on teardown — this is the seam the harness drives (see `mux-runner-claude-max-turns-relaunch.test.js` for the established replay-stub pattern: write `state.json` + ticket frontmatter to a tmpdir, build a fake `ctx` with `log`/`deactivate` collectors and a synthetic `outcome` + `tmux_iteration_<n>.log`, call `processIterationOutcome` / `processCompletionBranch`, assert on `kind`, persisted `manager_relaunch_count`, and `log` lines).
- **Codex no-progress halt:** `checkAndUpdateCodexManagerNoProgress` (`mux-runner.ts:3966-3997`) halts with `exit_reason: 'codex_manager_no_progress'` (event `codex_manager_no_progress`, `types/index.ts:647`) after 2 consecutive zero-progress relaunch passes — the natural "cap-exceeded / no-progress halt" scenario for the codex path.
- **Cap-exhausted exit:** for the claude path, when `manager_relaunch_count >= cap`, `evaluateManagerRelaunch` returns `reason: 'cap_exceeded'` and `shouldRelaunch: false`; the loop tears down rather than relaunching. (Distinct from the global iteration cap `iteration_cap_exhausted` → exit code 3, `mux-runner.ts:6151`.)

The harness MUST stub the manager via fixture replay (the existing `mux-runner-claude-max-turns-relaunch.test.js` pattern of synthetic `outcome` + iteration-log content driving `processCompletionBranch`), NOT spawn a real `claude`/`codex` CLI.

## In scope

- A deterministic 20-ticket synthetic session fixture (R-MMTR-6A).
- A replay-stubbed E2E harness exporting `runMaxTurnsRelaunchE2E({ sessionFixture, expectedRelaunchCount, expectedDoneCount })` (R-MMTR-6B).
- Three E2E scenarios asserting on relaunch activity events + final ticket distribution (R-MMTR-6C).
- CI-gate registration so the new test runs in `test:integration` and passes the tier/hygiene audits (R-MMTR-6D).

## Not in scope

- Any change to the relaunch runtime itself (`manager-relaunch.ts`, `mux-runner.ts` relaunch branches) — those shipped and are correct; this is test-only.
- Refinement-team behavior (B-WEDGE owns fan-out; this bundle does not touch `spawn-refinement-team.ts`).
- The refinement ticket-sizing heuristic (R-TSH, separate PRD per source Out of Scope).
- Any `state.json` schema change or new activity event.
- Other R-MMTR family tickets (R-MMTR-1..5 shipped; R-MMTR-7 closer ran).

## Atomic tickets

Dependency chain: **6A → 6B → 6C**, and **6D depends on 6C**.

### R-MMTR-6A (small) — 20-ticket synthetic session fixture
- Primary file: `extension/tests/fixtures/mmtr6-synthetic-session/` (forward-created) — a fixture directory, data only, NO mux-runner invocation.
- Contents: 20 ticket subdirectories each with a `linear_ticket_<id>.md` carrying deterministic frontmatter (fixed `id` hashes, `title`, `status`, `order`) following the shape written by `writeTicket` in `extension/tests/mux-runner-claude-max-turns-relaunch.test.js`; plus a `session_state.json` template (schema-neutral `State` shape: `active`, `backend`, `working_dir`, `iteration`, `max_iterations`, `manager_relaunch_count: 0`, `current_ticket`, `session_dir`, etc. — mirror the `writeState` fixture in that test). Deterministic: no timestamps that vary per run beyond a harness-substituted `start_time_epoch`/paths placeholder.
- The fixture MUST encode a realistic distribution: enough `Todo`/`In Progress` tickets that ≥1 remains pending across multiple relaunch boundaries, so the harness can drive repeated relaunches.
- **AC (machine-checkable):**
  - `test -d extension/tests/fixtures/mmtr6-synthetic-session` exits 0.
  - `ls extension/tests/fixtures/mmtr6-synthetic-session | grep -c 'linear_ticket_\|session_state.json'` — fixture contains a `session_state.json` template AND ≥20 ticket artifacts (count via `find extension/tests/fixtures/mmtr6-synthetic-session -name 'linear_ticket_*.md' | wc -l` ≥ 20).
  - `node -e "const o=require('./extension/tests/fixtures/mmtr6-synthetic-session/session_state.json'); process.exit(o.manager_relaunch_count===0 && o.active!==undefined ? 0 : 1)"` exits 0 (template is valid JSON with `manager_relaunch_count: 0`).
  - `bash extension/scripts/audit-test-tiers.sh` exits 0 (fixture dir under `tests/fixtures/` is excluded from the `@tier` requirement; no regression).

### R-MMTR-6B (medium) — replay-stubbed E2E harness
- Primary file: `extension/tests/integration/mmtr6-harness.ts` (forward-created).
- Export the function `runMaxTurnsRelaunchE2E({ sessionFixture, expectedRelaunchCount, expectedDoneCount })`. It MUST: (a) copy the R-MMTR-6A fixture (created by R-MMTR-6A) into a tmpdir (`fs.mkdtempSync`) and rewrite `working_dir`/`session_dir`/`start_time_epoch` to the tmp paths; (b) drive `processCompletionBranch` / `processIterationOutcome` from `extension/bin/mux-runner.js` with synthetic `outcome` objects + `tmux_iteration_<n>.log` content that simulate a clean max-turns exit with pending tickets (the `mux-runner-claude-max-turns-relaunch.test.js` replay pattern); (c) advance ticket frontmatter to `Done` between relaunch passes to model progress; (d) collect `log` lines, `deactivate` calls, persisted `state.json` (`manager_relaunch_count`), and the session `activity` events; (e) return a structured result `{ relaunchCount, doneCount, activityEvents, finalTicketStatuses, teardownReason }` for the test to assert on. The harness MUST stub the CLI via fixture replay — NO real `claude`/`codex` subprocess spawn.
- The harness is orchestration only — it contains NO `test(...)` assertions itself (those live in R-MMTR-6C).
- Carry a `// @tier: integration` discovery comment.
- **AC (machine-checkable):**
  - `test -f extension/tests/integration/mmtr6-harness.ts` exits 0.
  - `grep -nE "export (async )?function runMaxTurnsRelaunchE2E" extension/tests/integration/mmtr6-harness.ts` returns ≥ 1 hit.
  - `grep -nE "sessionFixture|expectedRelaunchCount|expectedDoneCount" extension/tests/integration/mmtr6-harness.ts` returns ≥ 3 hits (the destructured option keys are present).
  - `grep -cE "spawnSync\(|child_process|execFile" extension/tests/integration/mmtr6-harness.ts` == 0 for any `claude`/`codex` invocation — the harness MUST NOT spawn the real CLI (replay-stub only).
  - `npx tsc --noEmit` exits 0 (harness type-checks).

### R-MMTR-6C (medium) — E2E test cases (3 scenarios)
- Primary file: `extension/tests/integration/max-turns-relaunch-e2e.test.js` (forward-created), importing the harness `runMaxTurnsRelaunchE2E` from `extension/tests/integration/mmtr6-harness.ts` (created by ticket R-MMTR-6B).
- Three named scenarios, each calling the harness and asserting on `state.json` activity events + final ticket distribution:
  1. **clean relaunch** — manager exits max-turns once with pending tickets, relaunches, drains queue to all-Done: assert `relaunchCount === 1`, a `manager_max_turns_relaunch` activity event was emitted with the expected `relaunch_count`/`pending_count`, persisted `manager_relaunch_count === 1`, no `deactivate`, final ticket distribution = all `Done` (`doneCount === 20`).
  2. **consecutive relaunches up to cap** — repeated max-turns exits with progress each pass, relaunching multiple times below `CLAUDE_MANAGER_RELAUNCH_CAP` (20): assert `relaunchCount` increments per pass, one `manager_max_turns_relaunch` event per relaunch, persisted `manager_relaunch_count` matches, queue drains to all-Done.
  3. **cap-exceeded / no-progress halt** — relaunch passes make no progress (pending count never decreases) until the bound is hit: assert the loop **halts** rather than relaunching — `evaluateManagerRelaunch` returns `reason: 'cap_exceeded'` (claude path) OR the codex path halts with `exit_reason: 'codex_manager_no_progress'` after 2 zero-progress passes (`codex_manager_no_progress` event emitted); assert tickets remain pending (not all Done) and a teardown/deactivate occurred.
- Carry a `// @tier: integration` discovery comment.
- **AC (machine-checkable):**
  - `test -f extension/tests/integration/max-turns-relaunch-e2e.test.js` exits 0.
  - `grep -cE "clean relaunch|consecutive|cap-exceeded|no-progress|cap" extension/tests/integration/max-turns-relaunch-e2e.test.js` ≥ 3 (the three scenario names are present).
  - `grep -cE "manager_max_turns_relaunch|manager_relaunch_count|codex_manager_no_progress" extension/tests/integration/max-turns-relaunch-e2e.test.js` ≥ 3 (asserts on the real relaunch events/fields).
  - `node --test extension/tests/integration/max-turns-relaunch-e2e.test.js` exits 0 with the 3 named scenarios passing.

### R-MMTR-6D (small) — CI gate wiring
- Primary file: `extension/scripts/audit-test-tiers.sh` (+ the `test-registration-hygiene` allowlist and `test:integration` discovery).
- Register the new integration test so it runs and audits clean:
  - Ensure `extension/tests/integration/max-turns-relaunch-e2e.test.js` and `extension/tests/integration/mmtr6-harness.ts` carry the `// @tier: integration` discovery comment so the recursive `discoverTierFiles` scanner in `extension/bin/test-runner.js` picks them up under `npm run test:integration`.
  - If either file is subprocess-heavy under the `audit-subprocess-heavy-tests.sh` definition, add it to `extension/tests/integration/.serial-tests.json` (or annotate `// SERIAL: <reason>`); otherwise leave it parallel.
  - Add `tests/integration/max-turns-relaunch-e2e.test.js` to the `UNREGISTERED_TEST_ALLOWLIST` in `extension/tests/test-registration-hygiene.test.js` ONLY if it would otherwise be flagged as unregistered (the harness `.ts` file is not a `node --test` entry and must not be flagged as a missing test).
- **AC (machine-checkable):**
  - `grep -c "@tier: integration" extension/tests/integration/max-turns-relaunch-e2e.test.js` ≥ 1.
  - `bash extension/scripts/audit-test-tiers.sh` exits 0.
  - `bash extension/scripts/audit-subprocess-heavy-tests.sh` exits 0.
  - `node --test extension/tests/test-registration-hygiene.test.js` exits 0.
  - `npm run test:integration` discovers and runs `max-turns-relaunch-e2e.test.js` (the test appears in the integration-tier run and passes).

### C-E2E-CLOSER [manager] — Ship B-E2E
- Run the FULL release gate from `extension/`: `npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive`. READ the gate result and confirm GREEN before any bump/commit/tag (never batch the tag with the gate-read).
- Bump `extension/package.json` to **1.89.6** (PATCH — test fixture + harness + integration test + CI wiring; no feature surface, no breaking change, schema-neutral). Commit `chore(C-E2E-CLOSER): ship B-E2E — bump 1.89.6 + repoint MASTER_PLAN`.
- `bash install.sh`; verify clean working tree (`git status --porcelain` empty) and deployed JS matches source (install.sh parity gate green).
- `git push`; `gh release create v1.89.6`.
- Repoint MASTER_PLAN: in `prds/MASTER_PLAN.md` mark the **B-E2E** drain-queue row (row 4b) SHIPPED and close the **#19 R-MMTR-6** residual (Finding #19 row notes the residual as resolved). Update the repo-root `MASTER_PLAN.md` compatibility shim only if it carries the row (it is a pointer file; canonical is `prds/MASTER_PLAN.md`).
- **AC (machine-checkable):**
  - Release gate exits 0 (all phases green).
  - `node -p "require('./extension/package.json').version"` prints `1.89.6`.
  - `git status --porcelain` is empty after `bash install.sh`.
  - `gh release view v1.89.6` exits 0 (release exists).
  - `grep -c "B-E2E" prds/MASTER_PLAN.md` ≥ 1 AND the B-E2E row is marked SHIPPED.

## Acceptance (bundle-level)

- A deterministic 20-ticket synthetic session fixture exists under `extension/tests/fixtures/mmtr6-synthetic-session/` (R-MMTR-6A).
- A replay-stubbed harness `runMaxTurnsRelaunchE2E({ sessionFixture, expectedRelaunchCount, expectedDoneCount })` drives `processCompletionBranch` without spawning a real CLI (R-MMTR-6B).
- Three E2E scenarios (clean relaunch, consecutive-to-cap, cap-exceeded/no-progress halt) pass, asserting on `manager_max_turns_relaunch` / `manager_relaunch_count` / `codex_manager_no_progress` and the final ticket distribution (R-MMTR-6C).
- The new test runs under `npm run test:integration` and passes `audit-test-tiers.sh`, `audit-subprocess-heavy-tests.sh`, and `test-registration-hygiene` (R-MMTR-6D).
- Release gate green, clean tree, shipped through `gh release create v1.89.6`, MASTER_PLAN repointed closing #19 R-MMTR-6 residual + the B-E2E row (C-E2E-CLOSER).
