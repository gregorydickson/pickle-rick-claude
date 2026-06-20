---
title: P1 — Codex manager subprocess executes operator-facing setup.js invocations from skill prompt body
status: Shipped
filed: 2026-05-15
refined: 2026-05-15 (3-analyst team, session 2026-05-15-e9d9da8e)
shipped: 2026-05-15 (5/10 substantive tickets — implementation tier complete; wiring + 4 hardening deferred to R-CCPM-WH)
priority: P1
type: bug
r_code_prefix: R-CCPM
backend_constraint: claude
related:
  - prds/archive/bug-reports/codex-classifier-prompt-leak.md  # R-CCPL (REOPENED P1, Master Plan Finding #1) — Phase 1a-bis successor
  - prds/archive/research/research-r-ccpl-7fe6da60-2026-05-15.md  # forensic artifact from R-RHGS run
  - prds/archive/bundles/p3-ccpm-wiring-and-hardening-followup.md  # R-CCPM-WH — deferred wiring + hardening (1 + 4 tickets)
---

## HEAD reconciliation (shipped 2026-05-15)

R-CCPM closes the R-CCPL successor class (Master Plan Finding #1) via 5 substantive implementation commits authored autonomously by session `2026-05-15-e9d9da8e` (claude backend; codex was the fix target — chicken-and-egg). Bundle was operator-stopped at 5/10 after the implementation tier completed cleanly; the remaining 1 wiring + 4 hardening tickets are deferred as `prds/archive/bundles/p3-ccpm-wiring-and-hardening-followup.md` (R-CCPM-WH).

| Ticket | R-code | Commit | Substance |
|---|---|---|---|
| `2d9f16d7` | R-CCPM-5 | `f915b821` | Register 3 new activity events at 6-site triangle + pin trap door |
| `cf912ac9` | R-CCPM-1 | `690e5c5c` | Shared `composeManagerPromptFromSkill` helper + codex Role Framing + scrub at both call sites |
| `838f4cbf` | R-CCPM-2 | `e955ce4d` | Runtime guard — LOG-only observation of codex `setup.js` tool-calls |
| `c7396196` | R-CCPM-3 | `39a660e4` | Orphan-session detection at iteration boundary (schema v4 bump; new State fields `orphans_detected` + `parent_session_hash` + `invocation_source`) |
| `3bc1c3ca` | R-CCPM-4 | `73657d27` | Session-map cwd-collision protection in `updateSessionMap` — fixes the root cause of the apparent `worker_timeout_seconds` drift (codex manager subprocess's setup.js was overwriting the parent pointer) |

**Operator stop rationale**: the R-CCPL bug class is closed in HEAD with R-CCPM-1..5 substantive shipped. Wiring + 4 hardening are filler relative to the queued backlog (R-GBK Grok backend slot 37, R-MFW MCP forwarding slot 36, R-FRA gate ergonomics, R-CCDC citadel detection-coverage). R-CCPM-WH ships opportunistically when paired with the next state-manager / mux-runner touch.

# R-CCPM — Codex Manager Prompt Pollution

## Symptom

When `mux-runner.ts` spawns the manager subprocess with `--backend codex`, the codex CLI receives the `/pickle.md` skill prompt verbatim as its system prompt. Codex parses the operator-facing `setup.js` invocation examples in that prompt as a task list and EXECUTES them via `Bash` tool-calls — running `node setup.js --task "..."` itself instead of acting as the manager that calls `spawn-morty.js` for each ticket.

Witnessed in session `2026-05-14-7fe6da60` during the R-RHGS bundle launch:
- Codex manager called `setup.js --task "--resume <SESSION_ROOT>"` — pattern matches the operator-facing examples documented in `.claude/commands/pickle.md` lines 39, 41, 42 (the `# Step 1: Initialization` block, lines 34-46). Specifically:
  - line 39: `node "$HOME/.claude/pickle-rick/extension/bin/setup.js" <FLAGS> --task "<TASK_TEXT>"`
  - line 41: `setup.js --task "$ARGUMENTS"`
  - line 42: contains TWO refs — `setup.js --backend codex --task "refactor auth"` AND `setup.js --backend hermes --task "scaffold CLI smoke tests"`
  - line 178 (TEAMS MODE) intentionally OUT of scope for the scrub — that's documentation-context narrating that "setup.js rejects codex+teams", not an operator order.
- Symptom observed: orphan session `2026-05-14-afc7e9df` created in `~/.local/share/pickle-rick/sessions/`; `current_sessions.json[cwd]` overwritten to point at the orphan; downstream consumers (status, retry-ticket, workers) resolved to the orphan's `state.json` (which has the fresh default `worker_timeout_seconds=1200`). The parent's `state.json` was never modified; the apparent "worker_timeout reset" is consumer-side resolution drift.
- Result: operator forced to switch backend codex → claude mid-pipeline to recover.

Same prompt body produces correct manager behavior on the claude backend — claude calls `spawn-morty.js` directly without ever touching `setup.js`. The bug is codex-specific.

## Root cause

The manager spawn payload is loaded from `pickle.md` verbatim — the same artifact that operators read in the `/pickle` slash command. Operator-facing tutorial code blocks like:

> ```bash
> node "$HOME/.claude/pickle-rick/extension/bin/setup.js" <FLAGS> --task "<TASK_TEXT>"
> ```

are documentation when claude reads them and orders when codex reads them. Codex lacks the "this is operator docs, you are the manager" framing that claude infers from training.

**Selective rule-compliance evidence (analyst Cycle 3 P0 finding)**: `.claude/commands/pickle.md:1-20` already contains a `<!-- BEGIN GIT_BOUNDARY_RULES --> ... <!-- END GIT_BOUNDARY_RULES -->` block that codex DOES respect — no prohibited git-checkout commands were emitted in the witnessed bug. So codex distinguishes "explicit rule block with PROHIBITED markers + HTML-comment fences" from "unframed fenced example code." The fix MUST reuse this proven marker pattern, not invent a new one.

**Spawn-site multiplicity (analyst Cycle 3 P0 finding)**: `git grep -n buildManagerInvocation extension/src/` returns TWO call sites at HEAD: `mux-runner.ts:1616` and `jar-runner.ts:154`. The shared codex codepath at `backend-spawn.ts:buildCodexInvocation:314` is ALSO the codepath for `buildWorkerInvocation:271` (worker spawns). Injection at `buildCodexInvocation` would pollute every codex worker prompt. The Role Framing prologue MUST inject at the two MANAGER call sites only, guarded by `backend === 'codex'`.

**FR-5 mechanism re-framing (analyst Cycle 3 P0 finding)**: The witnessed "worker_timeout reset 2400 → 1200" symptom is consumer-side resolution drift, NOT parent-state mutation. `extension/src/bin/setup.ts:255-269` has `map[cwd] = { sessionPath, pid: process.pid }` UNCONDITIONAL overwrite at line 263 — no live-PID collision check. The orphan setup overwrites the parent's cwd pointer in `current_sessions.json`. Downstream consumers then resolve through the overwritten pointer to the orphan's default-valued state.json. The fix is collision-blocking at `updateSessionMap`, not drift-correction of `worker_timeout_seconds`.

R-PIWG-2's Git Boundary Rules block addresses destructive *git* commands but does NOT cover the broader category of "operator-facing CLI invocations the manager subprocess should not run."

## Functional requirements

- **FR-1**: Manager-spawn payload sent to codex MUST include an explicit "you are the manager subprocess" role-framing block, wrapped in HTML-comment markers `<!-- BEGIN MANAGER_ROLE_FRAMING -->` / `<!-- END MANAGER_ROLE_FRAMING -->` (matching the existing `.claude/commands/pickle.md:1-20` `<!-- BEGIN GIT_BOUNDARY_RULES -->` pattern that codex demonstrably respects). The block MUST include the literal string `"PROHIBITED: invoking \`setup.js\` via Bash"` so codex applies the same "structured rule block" treatment it currently gives to GIT_BOUNDARY_RULES. The block is injected IN-MEMORY at the manager call sites (NOT written to the on-disk skill file).
- **FR-2**: The manager-spawn payload MUST strip the entire `# Step 1: Initialization` block from `pickle.md` (heading at line 34, end-marker `# Step 2: Execution (Management)` at line 56) before passing to `buildManagerInvocation`. The strip applies at BOTH manager call sites: `mux-runner.ts:1617` AND `jar-runner.ts:154`. The on-disk `pickle.md` is never mutated.
- **FR-3**: Runtime guard: when codex's stream-json output (`tmux_iteration_<n>.log`) shows a `Bash` tool-call invoking `setup.js`, `mux-runner.ts` MUST emit `codex_manager_self_bootstrap_attempted` (created by R-CCPM-5) activity event and surface the misbehavior in stderr. **FR-3 disposition: LOG-ONLY by physical limitation** — the tool-call has already executed by the time `mux-runner` parses the log. BLOCKING is structurally unavailable at this surface. Prevention is the responsibility of FR-1 + FR-2; FR-3 is observability + audit-trail for post-incident analysis. The guard MUST fire only when `state.backend === 'codex'` to avoid false positives on claude-mode sessions where the manager's text response happens to legitimately mention `setup.js`.
- **FR-4**: Orphan-session reaper: if a session is created under `~/.local/share/pickle-rick/sessions/<date>-<hash>/` while a parent session in the same data root is active AND in the same `working_dir`, the parent's next iteration MUST detect the orphan and log `orphan_session_detected` (created by R-CCPM-5) with the orphan path. Discriminator: `state.parent_session_hash` populated via `PICKLE_PARENT_SESSION_HASH` env passthrough OR `state.invocation_source: "manager_subprocess"`. Dedup via `state.orphans_detected: string[]` — append-only, never re-emit per parent lifetime. Auto-cleanup is out of scope.
- **FR-5 (revised)**: Session-map cwd-overwrite protection. `updateSessionMap` at `extension/src/bin/setup.ts:255-269` (and its second call site at `setup.ts:1160`) MUST refuse the overwrite when the existing entry's PID is alive AND its `sessionPath` differs from the new one. Uses the existing `readMappedPid` helper at `state-manager.ts:140` and process-alive check at the same module. On refusal, `setup.js` exits non-zero and emits `session_map_collision_blocked` (created by R-CCPM-5) with payload `{ existing_session_path, existing_pid, attempted_session_path, attempted_pid, cwd }`. **Note**: this replaces the original PRD's mechanistically-wrong worker_timeout drift framing. The operator's persisted `worker_timeout_seconds` is never touched; the bug is downstream consumers resolving through the overwritten cwd pointer to the orphan's default-valued state.json.

## Relationship to existing orphan-handling events

`VALID_ACTIVITY_EVENTS` at `extension/src/types/index.ts:503,517` already contains:
- `paused_session_orphan_demoted` — fires when `state-manager.ts:171,773` demotes a stale-active orphan during `recoverStaleActiveFlag` (consumed by 6 tests).
- `orphan_map_entry_pruned` — fires when `cancel.ts` prunes a dead-mapped-pid entry from `current_sessions.json`.

The three NEW events in this bundle have distinct semantics:
- `orphan_session_detected` (FR-4) — informational; fires on iteration boundary when a live sibling session in the same cwd is discovered. No state mutation.
- `codex_manager_self_bootstrap_attempted` (FR-3) — informational; fires when codex's stream-json log shows a `Bash` tool-call invoking `setup.js`. No state mutation.
- `session_map_collision_blocked` (FR-5 revised) — state-protecting; fires when `updateSessionMap` refuses to overwrite a live entry. Causes `setup.js` to exit non-zero.

**Firing-order invariant**: if a session would qualify for BOTH `orphan_session_detected` AND `paused_session_orphan_demoted` in a single iteration boundary, only the latter fires (state-mutating events outrank informational ones for the same session).

## In Scope

- Codex-only manager-spawn payload Role Framing injection at `mux-runner.ts:1617` AND `jar-runner.ts:154` (NOT inside `backend-spawn.ts:buildCodexInvocation`, which is shared with worker spawns).
- In-memory payload de-pollution: strip `# Step 1: Initialization` block from codex manager prompt only (file at rest is unmodified).
- Skill files in scope: `.claude/commands/pickle.md` (anything whose manager spawn flows through `buildManagerInvocation`). `pickle-jar-open.md` flows through `jar-runner.ts:154` and is in scope via the same shared helper.
- Runtime guard observing codex stream-json `tool_use` events for `Bash` tool-calls invoking `setup.js` (FR-3); LOG-ONLY by physical limitation.
- Orphan-session detection at iteration boundaries (FR-4); detection only, no auto-cleanup.
- Session-map cwd-collision blocking in `updateSessionMap` (FR-5 revised) — root cause of the worker_timeout-reset symptom.
- Trap door + 3 new activity events: `codex_manager_self_bootstrap_attempted`, `orphan_session_detected`, `session_map_collision_blocked`.
- Full 11-command release gate per `extension/scripts/check-wired.sh:13`.

## Acceptance criteria

- **AC-CCPM-1.a** — Manager Role Framing block injected EXACTLY at the two manager call sites: `extension/src/bin/mux-runner.ts:1617` (in the `buildManagerInvocation` opts.prompt argument) AND `extension/src/bin/jar-runner.ts:154` (analogously), both guarded by `if (state.backend === 'codex')`. Block uses HTML-comment markers `<!-- BEGIN MANAGER_ROLE_FRAMING -->` / `<!-- END MANAGER_ROLE_FRAMING -->`. The framing string is centralized in a new shared helper `composeManagerPromptFromSkill(skillPath, backend, opts)` exported from `extension/src/services/pickle-utils.ts`. — Verify: `grep -c 'BEGIN MANAGER_ROLE_FRAMING' extension/src/services/pickle-utils.ts` returns ≥1 AND `grep -rc 'BEGIN MANAGER_ROLE_FRAMING' extension/src/bin/` returns 0 (no per-callsite string concat — anchor lives only in the helper) AND `grep -rc 'composeManagerPromptFromSkill(' extension/src/bin/` returns exactly 2 (mux-runner + jar-runner) AND `grep -c 'composeManagerPromptFromSkill' extension/src/services/backend-spawn.ts` returns 0 (NOT in the worker-shared codepath). — Type: lint

- **AC-CCPM-1.b** — Codex-mode FINAL manager prompt (the string passed to `buildManagerInvocation` at mux-runner.ts:1617 OR jar-runner.ts:154, AFTER `# Step 1: Initialization` block strip, AFTER handoff/TASK_NOTES injection, AFTER Manager Role Framing prepend) MUST NOT contain `/\bsetup\.js\b[^\n]{0,200}--task\b/` outside the `MANAGER_ROLE_FRAMING` marker region. — Verify: `extension/tests/codex-manager-prompt-no-setup-examples.test.js` (forward-created) constructs the FINAL composed payload for BOTH spawn surfaces using `composeManagerPromptFromSkill(...)` and asserts the regex returns zero matches outside the marker region. Snapshot test pins claude-mode payload bytes against a fixture so the Role Framing path remains codex-only. — Type: test

- **AC-CCPM-1.c** — Slash-command preservation: `.claude/commands/pickle.md` on disk is never modified by the bundle. — Verify: `git diff --stat .claude/commands/pickle.md` returns empty across the bundle's commits AND a fixture test asserts the in-memory composed payload differs from the on-disk file. — Type: integration

- **AC-CCPM-1.d** — jar-runner fallback prompt fix: `jar-runner.ts:121`'s hardcoded fallback string (currently `'You are Pickle Rick. Resume the session.\n\nRun:\nnode "${extensionRoot}/extension/bin/setup.js" --resume ${sessionDir}\n\nThen continue the manager lifecycle from the current phase.'`) MUST NOT contain `setup.js`. Replace with manager-safe error path (e.g., `process.stderr.write('jar-runner: pickle.md missing; abort'); process.exit(1)`). — Verify: `grep -c 'setup\.js' extension/src/bin/jar-runner.ts` returns 0 outside import statements and helper-doc comments. — Type: lint

- **AC-CCPM-2.a** — Runtime guard: when `mux-runner.ts` observes a codex stream-json tool-call invoking `node setup.js` (any args), it logs `codex_manager_self_bootstrap_attempted` (created by R-CCPM-5) with payload `{ ticket: state.current_ticket || null, attempted_argv: string[], iteration: int, action_taken: 'logged' }`. — Verify: `extension/tests/integration/codex-manager-self-bootstrap-guard.test.js` (forward-created) injects a synthetic stream-json tool-call line and asserts the event fires exactly once with `action_taken: 'logged'`. — Type: test

- **AC-CCPM-2.b** — Codex-only false-positive guard: FR-3 runtime guard fires ONLY when `state.backend === 'codex'`. — Verify: `extension/tests/integration/codex-manager-self-bootstrap-guard-claude-noop.test.js` (forward-created) constructs a synthetic `tmux_iteration_<n>.log` containing `Bash` tool-call output `node setup.js ...` on a claude-backend session and asserts zero `codex_manager_self_bootstrap_attempted` events fire. — Type: test

- **AC-CCPM-3.a** — On iteration boundary, the runner scans `${dataRoot}/sessions/*/state.json` for entries where `started_at > parent.started_at AND working_dir === parent.working_dir AND pid !== parent.pid AND (invocation_source === 'manager_subprocess' OR parent_session_hash === parent.session_hash)`. Each match emits `orphan_session_detected` (created by R-CCPM-5) with `{ orphan_session_path: string, orphan_started_at: number, parent_session_hash: string, orphan_pid: number }`. — Verify: `extension/tests/integration/orphan-session-detection.test.js` (forward-created) creates a synthetic orphan with `parent_session_hash` populated; asserts event fires AND a concurrent legitimate session in the same cwd (without `parent_session_hash`) does NOT trigger a false positive. — Type: test

- **AC-CCPM-3.b** — `state.orphans_detected: string[]` field tracks emitted orphan session_dir basenames; an orphan is NEVER re-emitted in the same parent lifetime. Initialized to `[]` in `createInitialState` (`extension/src/bin/setup.ts`); state-schema migration adds the field to existing sessions on resume. — Verify: `extension/tests/state-field-invariants.test.js` adds an invariant row + dedup integration test (3 iterations, same orphan → expect 1 event total). — Type: test

- **AC-CCPM-3.c** — Parent-session linkage: when codex's manager subprocess re-invokes `setup.js`, `codex exec` env passthrough propagates `PICKLE_PARENT_SESSION_HASH=<parent.session_hash>` (set by `mux-runner.ts` before `buildCodexInvocation`); `setup.ts:createInitialState` reads that env var and populates `state.parent_session_hash`. — Verify: integration test asserts parent_session_hash is populated when env var is set; absent when not. — Type: test

- **AC-CCPM-4.a (revised)** — Two concurrent `setup.js` invocations targeting the same `cwd`: the second MUST detect the first's live entry via `readMappedPid` (`extension/src/services/state-manager.ts:140`) and abort with exit code 1, emitting exactly one `session_map_collision_blocked` (created by R-CCPM-5) event. Parent's `current_sessions.json[cwd]` entry survives unchanged. The orphan's session_dir is NOT created (setup.ts exits before `createInitialState`). Both `updateSessionMap` call sites (`setup.ts:903` and `setup.ts:1160`) MUST apply the same check. — Verify: `extension/tests/integration/session-map-collision-block.test.js` (forward-created) spawns a fake-parent process holding the cwd map entry, calls `setup.js --task "..."` in the same cwd, asserts (a) parent's entry intact, (b) child exits non-zero, (c) one event fires, (d) no orphan session dir at `${dataRoot}/sessions/<orphan-hash>/`. — Type: test

- **AC-CCPM-5.a** — Trap door pinned at `extension/src/bin/CLAUDE.md` documenting the H-D root cause + the FR-1/FR-2/FR-3 contract. PATTERN_SHAPE asserts on the test-fixture composed payload: `grep -c '\bsetup\.js\b[^\n]{0,200}--task\b' <payload>` returns 0 outside `MANAGER_ROLE_FRAMING` marker region. The trap-door anchor uses naming convention `R-CCPM-1 codex manager payload scrub`. ENFORCE reference points at `extension/tests/codex-manager-prompt-no-setup-examples.test.js`. — Verify: `bash extension/scripts/audit-trap-door-enforcement.sh` exits 0 AND `grep -c 'R-CCPM-1 codex manager payload scrub' extension/src/bin/CLAUDE.md` returns ≥1. — Type: integration

- **AC-CCPM-5.b** — Three new activity events — `codex_manager_self_bootstrap_attempted` (created by R-CCPM-5), `orphan_session_detected` (created by R-CCPM-5), and `session_map_collision_blocked` (created by R-CCPM-5) — registered at SIX sites each:
  1. `VALID_ACTIVITY_EVENTS` in `extension/src/types/index.ts`
  2. `definitions/<event>` block in `extension/src/types/activity-events.schema.json`
  3. `oneOf` entry `{"$ref":"#/definitions/<event>"}` in same schema (R-PDD-oneOf precedent)
  4. `EVENT_CASES` row in `extension/tests/activity-event-payload.test.js`
  5. `EVENT_NAMES` row in same test file (universal drift-check — DISTINCT from `GATE_REMEDIATION_EVENT_NAMES`)
  6. `ACTIVITY_EVENT_SCHEMA_SECTION` row in `extension/src/bin/spawn-refinement-team.ts`
  — Verify: `extension/tests/activity-events-piwg-conformance.test.js` already parametrizes describe.each over (event × leg) — adding the 3 new event names to its event-name source array exercises all six registration sites automatically. — Type: test

- **AC-CCPM-5.c** — Three new schema-conformance tests: `codex-manager-self-bootstrap-attempted-schema-conformance.test.js`, `orphan-session-detected-schema-conformance.test.js`, `session-map-collision-blocked-schema-conformance.test.js`. Each asserts producer-side payload shape matches `activity-events.schema.json` `required` fields AND that `ts` is explicitly stamped (R-WSE-2 trap-door pattern — `writeActivityEntry` does not auto-stamp `ts`, unlike `logActivity`). — Type: test

- **AC-CCPM-Release** — `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive` exits 0.

## Implementation notes

**Files likely touched (refined):**
- `extension/src/services/pickle-utils.ts` — new shared helper `composeManagerPromptFromSkill(skillPath: string, backend: Backend, opts: { argumentSubstitution: string; handoffText?: string; iterationSummary?: string; taskNotes?: string }): string`. Encapsulates: `readFileSync` → `$ARGUMENTS` replace → `stripSetupSection` → strip-`# Step 1: Initialization`-block (new) → optional handoff/summary/task_notes append → codex-only Role Framing prologue with HTML-comment markers.
- `extension/src/bin/mux-runner.ts:1555-1620` — replace existing prompt-composition pipeline with one call to the new helper. Codex Role Framing happens INSIDE the helper, conditional on `backend === 'codex'`. Also: emit `PICKLE_PARENT_SESSION_HASH=<state.session_hash>` env before `buildCodexInvocation` so the codex-spawned setup.js (if the bug recurs despite Role Framing) sets parent linkage.
- `extension/src/bin/jar-runner.ts:120-155` — replace `pickle.md` load + fallback string + call site with one call to the new helper. Fallback string at line 121 MUST NOT contain `setup.js`.
- `extension/src/bin/setup.ts:255-269` (updateSessionMap) — add `readMappedPid` + isProcessAlive collision check before unconditional `map[cwd] = ...` overwrite. Same change at `setup.ts:1160` (second call site).
- `extension/src/bin/setup.ts:createInitialState` — initialize `state.orphans_detected: []` and `state.parent_session_hash` (from `PICKLE_PARENT_SESSION_HASH` env or null) and `state.invocation_source` ("manager_subprocess" when env var present, else "operator").
- `extension/src/services/state-manager.ts` — schema migration adds `orphans_detected: []` + `parent_session_hash: null` + `invocation_source: "operator"` to existing sessions on read. LATEST_SCHEMA_VERSION bump.
- `extension/src/types/index.ts` — 3 new events in `VALID_ACTIVITY_EVENTS`; `orphans_detected: string[]`, `parent_session_hash: string | null`, `invocation_source: 'operator' | 'manager_subprocess'` added to `State`.
- `extension/src/types/activity-events.schema.json` — 3 new `definitions` blocks + 3 new `oneOf $ref` entries (R-PDD-oneOf).
- `extension/src/bin/spawn-refinement-team.ts:148-173` — 3 new rows in `ACTIVITY_EVENT_SCHEMA_SECTION`.
- `extension/tests/activity-event-payload.test.js` — 3 new `EVENT_CASES` rows AND 3 new entries in `EVENT_NAMES` (R-PDD bidirectional drift-check).
- `extension/src/bin/CLAUDE.md` — trap door for the prompt-pollution invariant + state-field invariants for the new fields.
- 3 new schema-conformance tests + 4 new integration tests + 1 new helper test for `composeManagerPromptFromSkill`.
- NOT TOUCHED: `extension/src/bin/spawn-morty.ts` (worker), `extension/src/services/backend-spawn.ts` (shared codex envelope — workers MUST NOT receive Role Framing prologue).

**Bundle composition (required ordering — R-CCPM-5 is bundle-blocker):** Single-PRD bundle, 5 tickets.
1. **R-CCPM-5** (Trap door + 6-site event triangle for 3 new events; `bundle-blocker: true` — its event triangle is a hard test-gate dependency for R-CCPM-1/2/3/4 because `audit-bundle-thesis.sh` inspects EVENT_CASES against schema definitions and would fail any emitter shipped before the registration).
2. **R-CCPM-1** (Manager Role Framing + payload de-pollution at both manager call sites via shared helper).
3. **R-CCPM-2** (Runtime guard against codex `setup.js` tool-calls — LOG-ONLY + codex-only false-positive guard).
4. **R-CCPM-3** (Orphan-session detection with `state.orphans_detected` dedup + `parent_session_hash` linkage).
5. **R-CCPM-4** (Session-map cwd-collision protection — replaces misdiagnosed worker_timeout drift framing).

**Backend:** Run on **claude backend** (codex is the target being fixed; using it during the build would create chicken-and-egg). After the bundle ships and is deployed via `bash install.sh`, retest with codex backend on a small follow-up PRD.

## Pre-flight risks

- **R-CCPL classifier interaction**: R-CCPL's v1.74.0 fix scrubs `EPIC_COMPLETED` from codex OUTPUT (classifier path in `classifier-utils.ts:4`). R-CCPM-1 transforms the codex INPUT (manager prompt assembly at `mux-runner.ts:1555-1620`). The two operate on different sides of the codex CLI — no compositional risk.
- **Operator UX preservation**: The operator-facing `/pickle` slash command still needs the setup.js examples in `pickle.md` for documentation purposes. R-CCPM-1's scrub/wrap happens at spawn-payload-build time, not at file-author time. AC-CCPM-1.c enforces this.
- **Worker-prompt pollution risk**: Injection MUST be at mux-runner.ts:1617 + jar-runner.ts:154, NOT inside `buildCodexInvocation` (shared with workers). AC-CCPM-1.a's grep predicate enforces this.
- **Activity-event duplication risk**: `paused_session_orphan_demoted` and `orphan_map_entry_pruned` already exist with production consumers. Firing-order invariant (above) addresses semantic differentiation.
- **Test backend constraint**: Tests asserting codex manager behavior need to mock the codex tool-call stream (don't spawn real codex during fast-tier). Pattern is established in `extension/tests/mux-runner-classifier.test.js`.
- **Codex CLI version dependency**: `extension/src/services/classifier-utils.ts:4` `CODEX_DELIMITER_RE` pins `tool_call` delimiter. If codex bumps its version and renames `tool_call` → `tool_use`, R-CCPM-2's runtime guard silently breaks. Add a snapshot test for both `codex-block` and `stream-json` formats; join the R-CCPL-4 codex-output-format trap door.

## Out of scope

- Refactoring `pickle.md` to be entirely manager-safe (would lose operator-facing tutorial value). The scrub/wrap happens at spawn-payload-build time, not at file-author time.
- Auto-deleting orphan sessions (AC-CCPM-3.a is detection-only; cleanup remains operator-initiated until safety is proven).
- Fixing R-CCPL classifier prompt-leak (separate concern, already shipped in v1.74.0; this PRD is the H-D successor, not the H-A/H-B/H-C path).
- Killing the codex manager subprocess on FR-3 detection (LOG-ONLY by physical limitation; escalation to "kill on detection" is a follow-up PRD if LOG-only proves insufficient post-ship).

## Bundle-level acceptance criteria

- **AC-BUNDLE-01** — Full release gate green: `cd extension && npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && npm run test:fast && npm run test:integration && RUN_EXPENSIVE_TESTS=1 npm run test:expensive` exits 0.
- **AC-BUNDLE-02** — Trap door pinned + 3 new activity events satisfy the 6-site triangle (covered by AC-CCPM-5.a / AC-CCPM-5.b / AC-CCPM-5.c).
- **AC-BUNDLE-03** — `bash install.sh` deploys cleanly (no parity-check mismatch).
- **AC-BUNDLE-04** — Post-ship validation: launch any small PRD with `--backend codex` on BOTH `/pickle` AND `/pickle-jar-open` and confirm the codex manager calls `spawn-morty.js` only (not `setup.js`), no orphan session appears, no `session_map_collision_blocked` event fires for single-session-per-cwd runs.

## Why P1

- Direct operator-visible damage: every codex pipeline launch loses ~10-30min to orphan-cleanup + backend-fallback.
- Recurrence is deterministic on every fresh codex pipeline that uses the `/pickle.md` or `/pickle-jar-open.md` skill (not flaky).
- Forces operators to choose claude backend, defeating the codex-first design goal.
- The fix is local to the spawn payload (no operator workflow change, no cross-cutting refactor).

## NOT in Scope (deferred to later bundles)

- Worktree isolation R-PIWG-3 (deferred from R-RHGS; durable concurrent-git fix).
- LLM-judge stabilization R-PRJT/R-SLLJ/R-MBLE (Master Plan Findings #16/#17/#26).
- mux-runner claude max-turns relaunch R-MMTR (Master Plan Finding #19).

## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | 2d9f16d7 (R-CCPM-5) | Register 3 events at 6-site triangle + pin trap door | High | bundle start | events ready for emitters | types/index.ts, activity-events.schema.json, spawn-refinement-team.ts, activity-event-payload.test.js, CLAUDE.md, 3 schema-conformance tests |
| 20 | cf912ac9 (R-CCPM-1) | Shared composeManagerPromptFromSkill + Role Framing + scrub | High | R-CCPM-5 done | helper in use at both spawn surfaces | pickle-utils.ts, mux-runner.ts, jar-runner.ts, 2 tests |
| 30 | 838f4cbf (R-CCPM-2) | Runtime guard — LOG-only codex setup.js observer | High | R-CCPM-5 done | guard wired into mux-runner | classifier-utils.ts, mux-runner.ts, 3 tests |
| 40 | c7396196 (R-CCPM-3) | Orphan-session detection + parent_session_hash linkage | High | R-CCPM-5 done | detector wired into iteration boundary | mux-runner.ts, setup.ts, state-manager.ts, CLAUDE.md, state-field-invariants tests, 1 integration test |
| 50 | 3bc1c3ca (R-CCPM-4) | Session-map cwd-collision protection | High | R-CCPM-5 done | both updateSessionMap call sites collision-block | setup.ts, state-manager.ts, 1 integration test |
| 60 | a16d47f0 (Wiring) | End-to-end integration smoke for both spawn surfaces | High | R-CCPM-1..5 done | full chain exercised + claude no-op pinned | 2 integration tests |
| 70 | be2bae36 (Hardening 1) | Code quality review of R-CCPM modified files | High | all impl + wiring done | zero P0-P1 violations | all R-CCPM MODIFIED_FILES |
| 80 | d4918ede (Hardening 2) | Data flow integrity audit for R-CCPM | High | code-quality done | zero CRITICAL+HIGH findings | all R-CCPM MODIFIED_FILES |
| 90 | 896d10f9 (Hardening 3) | Test quality review of R-CCPM | High | data-flow done | zero P0-P1 assertion gaps | all R-CCPM test files |
| 100 | 4f6a09ec (Hardening 4) | Cross-reference consistency audit for R-CCPM | High | test-quality done | zero CRITICAL+HIGH cross-ref mismatches | R-CCPM DOC_FILES + MODIFIED_FILES |
