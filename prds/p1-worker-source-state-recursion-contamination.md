<!-- R-CTSF retroactive (shipped pre-R-CTSF) -->
# P1: Worker Source/State Recursion Contamination

**Bundle code**: `R-WSRC` (Worker Source/State Recursion Contamination)
**Priority**: P1 — pipeline-bricking + security blast radius (leaked subprocesses with `--dangerously-skip-permissions --add-dir <real-repo>`).
**Filed**: 2026-05-16 CDT
**Filed by**: operator-driven 4-agent debate analysis post-incident (session 2026-05-15-c543d227, ticket 22c36bf6 R-QGSK-3 wedge).
**Related**: R-MRWG (Finding #42) — overlapping root cause class (worker-gate SIGTERM non-propagation enables R-WSRC leak survival).

## Incident Summary

**Incident A — Live runtime state corruption**: Worker on ticket `22c36bf6` (R-QGSK-3 schema-migration ticket) was asked to bump `LATEST_SCHEMA_VERSION` from 4→5. The TS source change was correct, but the worker also caused `~/.local/share/pickle-rick/sessions/2026-05-15-c543d227/state.json` (or a `.tmp.<pid>` snapshot promoted by `StateManager.recoverOrphanTmpFiles`) to be written with `schema_version: 5`. The running mux-runner (deployed v4 binary at `~/.claude/pickle-rick/extension/services/state-manager.js`) entered a tight `1 warn/sec` loop on:
```
[WARN] state.json schema mismatch on cap-check read:
  State file schema_version 5 is newer than supported version 4. Retrying next iteration.
```
The loop ran indefinitely until operator killed it.

**Incident B — Leaked subprocess with full repo write access**: A `claude --dangerously-skip-permissions --add-dir /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude --add-dir /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude --add-dir /private/var/folders/.../pickle-mux-runner-Jj2cBP/session/deadbeef/` subprocess was found alive after a worker-gate SIGTERM did not propagate (R-MRWG-2). The leaked subprocess inherited `working_dir: REPO_ROOT` from a test fixture in `extension/tests/mux-runner.test.js:782-837` (the `audit-bundle-halt` test using a `deadbeef` ticket and phantom file `extension/src/does-not-exist-phantom.ts`) and retained write access to the operator's real working tree for the duration of the leak.

## Root Cause

pickle-rick-claude is a meta-tool that uses itself to modify itself. The architecture has these structural overlaps:

1. **Worker cwd === runtime repo root.** `spawn-morty.ts:1414` spawns the worker subprocess with full filesystem access to the repo. The worker can edit any file including the runtime's TypeScript source AND the compiled JS mirror.

2. **Worker's `--add-dir` includes deployed runtime path.** `backend-spawn.ts:284-296` `buildClaudeWorkerInvocation` passes `getExtensionRoot()` — which resolves to `~/.claude/pickle-rick/` — in every worker's `addDirs`. There is no containment check that `addDirs` entries are within the session sandbox.

3. **`StateManager.update()` has no schema-version ceiling at write time.** The existing `isRecoverableStateSnapshotCandidate` at `state-manager.ts:361-382` rejects `schema_version > maxSupportedSchemaVersion` ONLY during tmp-promotion. The direct write path through `StateManager.update()` and `forceWrite()` has no such ceiling — a worker that constructs a v5 state and calls `update()` writes it through without validation.

4. **mux-runner's read-loop wedges on SCHEMA_MISMATCH outside `classifyCapCheckReadError`.** `mux-runner.ts:2615` `classifyCapCheckReadError` handles SCHEMA_MISMATCH as `'continue'` (retry next iteration) for cap-checks. But other `sm.read()` call sites — the top-of-loop `readRunnerState` at `mux-runner.ts:80`, the iteration_start state reads, etc. — have no SCHEMA_MISMATCH handler. They retry forever, producing the 1-warn/sec loop observed.

5. **Test fixtures set `working_dir: REPO_ROOT` in spawned session state.** `mux-runner.test.js:36-49` `run()` helper passes `REPO_ROOT` as the working_dir, which propagates through `spawn-morty` to `--add-dir` of the actually-spawned claude subprocess. If the spawnSync timeout fires (R-MRWG-2 ladder) and the subprocess survives, the orphan has real-repo write access.

6. **Prose-only enforcement was violated.** `.claude/commands/send-to-morty.md:61` already states: "NEVER modify `state.json`, `active`, or `completion_promise`". The worker violated this. Prose without runtime enforcement is not a safeguard.

## Atomic Tickets

### R-WSRC-1 — Schema-version ceiling at `StateManager.update()` and `forceWrite()` write sites

**File**: `extension/src/services/state-manager.ts` (update method ~line 521, forceWrite ~line 608)

**Change**: Before committing any write (after the mutator runs, before `writeStateFile` is called), validate `state.schema_version <= LATEST_SCHEMA_VERSION`. If exceeded, throw a new `SchemaVersionAheadError extends StateError` with `{ field: 'schema_version', written_value, max_supported, source_caller }`. Same check in `forceWrite()` post-mutate, pre-rename.

**Why this is the 80% fix** (consensus from architect + skeptic agents): the existing `isRecoverableStateSnapshotCandidate` already shows the right mental model at line 361. R-WSRC-1 mirrors it at the write site. All legitimate schema-version bumps happen inside the runtime's own `migrateSchema` path; no worker should ever construct a forward-schema state via `update()`.

**Acceptance criteria**:
- [ ] `StateManager.update()` body MUST include a `state.schema_version <= LATEST_SCHEMA_VERSION` assertion AFTER the mutator returns AND BEFORE `writeStateFile` is called
- [ ] `StateManager.forceWrite()` body MUST include the same assertion AFTER the mutator returns AND BEFORE the tmp-rename
- [ ] Both paths emit a `state_write_schema_version_violation` activity event with `{ written_value, max_supported, statePath, caller_pid }` payload registered in `VALID_ACTIVITY_EVENTS` and `activity-events.schema.json` definitions + oneOf per R-PDD-oneOf
- [ ] `SchemaVersionAheadError` thrown is NOT swallowed by `StateManager` itself; callers (mux-runner, spawn-morty, pipeline-runner) handle it via `recordExitReason('state_schema_write_violation')` + safeDeactivate
- [ ] Regression test: a mutator that sets `state.schema_version = LATEST_SCHEMA_VERSION + 1` and calls `update()` MUST throw `SchemaVersionAheadError` BEFORE any disk write; `state.json` on disk MUST be unchanged after the throw
- [ ] Existing `migrateSchema` path is exempt only when it's the source caller (detect via internal stack inspection OR a dedicated `_internalSchemaBump` flag in opts)

**Trap door** (`extension/src/services/state-manager.ts` invariant):
> `StateManager.update()` and `forceWrite()` MUST validate `state.schema_version <= LATEST_SCHEMA_VERSION` AFTER the mutator runs AND BEFORE any disk write. BREAKS: a worker that writes a forward-schema state via `update()` corrupts the live runtime's state.json; the running binary cannot parse it and wedges (R-QGSK-3 incident class). ENFORCE: `extension/tests/state-manager-schema-write-ceiling.test.js`. PATTERN_SHAPE: `StateManager.update` AND `forceWrite` bodies MUST contain `if (state.schema_version > LATEST_SCHEMA_VERSION) throw new SchemaVersionAheadError(...)` before any `writeStateFile` call.

### R-WSRC-2 — Schema-ahead graceful exit at all `sm.read()` call sites in mux-runner

**File**: `extension/src/bin/mux-runner.ts` (`readRunnerState` wrapper ~line 80, plus all `sm.read()` call sites outside `classifyCapCheckReadError`)

**Change**: Replace the implicit retry-loop on SCHEMA_MISMATCH with `recordExitReason(statePath, 'state_schema_version_ahead') + safeDeactivate(statePath)` followed by `process.exit(3)` (PipelineRunnerExitCode.PhaseIncomplete). `state_schema_version_ahead` is registered in the `ExitReason` enum but NOT in `MICROVERSE_FAILURE_REASONS` (so it doesn't trigger recovery loops) and IS in `isFailureExit` (so auto-resume.sh R-CNAR-4(c) stop condition fires).

**Acceptance criteria**:
- [ ] `readRunnerState(statePath)` at mux-runner.ts:80 catches `SchemaVersionAheadError` AND raw `SCHEMA_MISMATCH` strings from `sm.read()`; on catch, calls `recordExitReason('state_schema_version_ahead') + safeDeactivate(statePath) + process.exit(3)`
- [ ] All other non-cap-check `sm.read()` call sites in mux-runner.ts route through `readRunnerState` (audit grep: no bare `sm.read(statePath)` outside the wrapper except `classifyCapCheckReadError`)
- [ ] `state_schema_version_ahead` added to `ExitReason` enum in `extension/src/types/index.ts` and compiled mirror
- [ ] `state_schema_version_ahead` added to `isFailureExit` set
- [ ] `state_schema_version_ahead` NOT added to `MICROVERSE_FAILURE_REASONS` (it's a fatal-but-recoverable-via-operator state, not a microverse class)
- [ ] Regression test: a fake state.json with `schema_version: LATEST + 1` causes `readRunnerState` to exit 3 within < 100ms (NOT loop forever)

**Trap door** (`extension/src/bin/mux-runner.ts` invariant):
> Every non-cap-check `sm.read(statePath)` call site in `mux-runner.ts` MUST route through `readRunnerState()` which handles `SchemaVersionAheadError`/`SCHEMA_MISMATCH` by calling `recordExitReason('state_schema_version_ahead') + safeDeactivate + process.exit(3)`. BREAKS: a forward-schema state.json (e.g., from a malformed worker write OR mid-deploy schema bump) causes mux-runner to retry-loop indefinitely at 1 warn/sec (R-QGSK-3 wedge incident class). ENFORCE: `extension/tests/mux-runner-schema-ahead-graceful-exit.test.js`. PATTERN_SHAPE: `grep -c "sm\\.read(statePath)" extension/src/bin/mux-runner.ts` count MUST equal `grep -c "readRunnerState(" extension/src/bin/mux-runner.ts` PLUS `grep -c "classifyCapCheckReadError" extension/src/bin/mux-runner.ts`.

### R-WSRC-3 — PreToolUse hook + bash-command scanner blocking writes to runtime state files

**File**: `extension/src/hooks/handlers/config-protection.ts` (extend existing PROTECTED_BASH_CANDIDATES + add PROTECTED_WRITE_GLOBS)

**Change**: Block `Write` and `Edit` tool calls targeting:
- `**/state.json` (any depth — sessions + tests)
- `**/state.json.tmp.*`
- `**/circuit_breaker.json` + `**/circuit_breaker.json.tmp.*`
- `**/pipeline-status.json` + `**/pipeline-status.json.tmp.*`
- `~/.claude/pickle-rick/**` (deployed runtime path)
- `pickle_settings.json` + `pickle_settings.json.tmp.*`

Extend the existing `PROTECTED_BASH_CANDIDATES` bash scanner to detect these same paths in shell command output redirects (`>`, `>>`, `tee`, `cp dest`, `mv dest`, `rsync ... dest`).

Override available via session-level flag `state.flags.allow_state_writes_reason: '<reason>'` (analogous to `skip_quality_gates_reason`). Only the schema-migration ticket (and similar legitimate cases) sets this with a justification. Emits `state_write_override_used` activity event on every override-bypass.

**Acceptance criteria**:
- [ ] `Write`/`Edit` tool calls matching PROTECTED_WRITE_GLOBS are blocked with `"decision": "block"` and stderr message naming the override flag
- [ ] Bash commands matching PROTECTED_BASH_CANDIDATES (extended set) are blocked
- [ ] Override flag `state.flags.allow_state_writes_reason` (non-empty trimmed string) bypasses both gates and emits `state_write_override_used` per bypass
- [ ] `state_write_override_used` is registered in `VALID_ACTIVITY_EVENTS` + schema definitions + oneOf
- [ ] Hook fail-open per dispatch.js contract: if the scanner crashes, the write is approved (not silently blocked)
- [ ] Regression test: worker writes to `<session>/state.json` without override → blocked; with override → allowed + event emitted

**Trap door** (`extension/src/hooks/handlers/config-protection.ts` invariant):
> PreToolUse hook MUST block `Write`/`Edit` tool calls AND bash output-redirects targeting `**/state.json*`, `**/circuit_breaker.json*`, `**/pipeline-status.json*`, `~/.claude/pickle-rick/**`, and `pickle_settings.json*` UNLESS `state.flags.allow_state_writes_reason` is a non-empty trimmed string (which emits `state_write_override_used` per bypass). BREAKS: workers retain ad-hoc write access to runtime state files, enabling R-WSRC corruption. ENFORCE: `extension/tests/config-protection-state-files.test.js`. PATTERN_SHAPE: `PROTECTED_WRITE_GLOBS` constant in source MUST include the named globs; `PROTECTED_BASH_CANDIDATES` extended scanner MUST match `>`, `>>`, `tee`, `cp`, `mv`, `rsync` targets against the same globs.

### R-WSRC-4 — Test-harness assertion: `--add-dir` paths MUST be under `os.tmpdir()`

**File**: `extension/src/services/backend-spawn.ts` (`buildClaudeWorkerInvocation` ~line 284-296) + a new audit script `extension/scripts/audit-test-add-dir-containment.sh`

**Change**:
- In `buildClaudeWorkerInvocation`, add an assertion: if `process.env.PICKLE_TEST_MODE === '1'` (set by test harness) AND any `addDirs[i]` is not under `os.tmpdir()` (or its symlink-resolved canonical), throw `AddDirOutsideSandboxError`
- The audit script greps for hardcoded paths in test files that pass `working_dir: REPO_ROOT`-equivalent or `cwd: process.cwd()` to spawn-morty / spawn-refinement helpers — fails the build if found
- `mux-runner.test.js:36` `run()` helper MUST be refactored to use `path.join(os.tmpdir(), 'pickle-mux-runner-test-...')` as working_dir, never REPO_ROOT

**Acceptance criteria**:
- [ ] `buildClaudeWorkerInvocation` throws `AddDirOutsideSandboxError` when `PICKLE_TEST_MODE=1` AND any addDir is outside `os.tmpdir()` (resolved via `fs.realpathSync`)
- [ ] `mux-runner.test.js:run()` (line 36-49) MUST use `os.tmpdir()`-rooted working_dir, NEVER REPO_ROOT
- [ ] All other test helpers that call `buildClaudeWorkerInvocation` or `spawnMorty` pass working_dir under `os.tmpdir()`
- [ ] `audit-test-add-dir-containment.sh` greps for `working_dir.*REPO_ROOT`, `working_dir.*process\.cwd`, `working_dir.*__dirname`-without-tmp patterns; fails on match
- [ ] Audit script added to the standard release-gate command in CLAUDE.md
- [ ] Regression test: a test fixture that passes REPO_ROOT to spawn-morty (under PICKLE_TEST_MODE=1) → throws AddDirOutsideSandboxError

**Trap door** (`extension/src/services/backend-spawn.ts` invariant):
> `buildClaudeWorkerInvocation` MUST throw `AddDirOutsideSandboxError` when `PICKLE_TEST_MODE === '1'` AND any `addDirs[i]` (after `fs.realpathSync`) is not a child of `os.tmpdir()`. BREAKS: test fixtures that pass REPO_ROOT to spawn-morty leak claude subprocesses with `--dangerously-skip-permissions --add-dir <real-repo>` if the spawn timeout fires (R-MRWG-2 ladder); the orphan retains write access to the operator's real working tree. ENFORCE: `extension/tests/backend-spawn-add-dir-sandbox.test.js` + `extension/scripts/audit-test-add-dir-containment.sh`. PATTERN_SHAPE: `buildClaudeWorkerInvocation` body MUST include `if (process.env.PICKLE_TEST_MODE === '1' && addDirs.some(...isOutsideTmpdir))` throw.

### R-WSRC-5 — CLAUDE.md / AGENTS.md / send-to-morty.md emphatic forbidden-ops sections

**Files**:
- `CLAUDE.md` (root project)
- `AGENTS.md` (codex-readable equivalent)
- `extension/CLAUDE.md` (subsystem trap doors)
- `.claude/commands/send-to-morty.md` (worker prompt)

**Change**: Add a top-of-file `## ⛔ Worker Forbidden Operations` section to each file. Content is the consolidated forbidden-ops table from the R-WSRC researcher agent's analysis. Two-tier structure:
- **Hard prohibitions** (no override): writes to `state.json`, `circuit_breaker.json`, `pipeline-status.json`, `~/.claude/pickle-rick/**`, schema-version bumps from non-migration tickets, `install.sh` execution from worker context, `--dangerously-skip-permissions` invocation from worker context
- **Conditional prohibitions** (override via `state.flags.<reason>`): schema-migration ticket can override `allow_state_writes_reason`; `pickle_settings.json` edits can override `allow_settings_writes_reason`

**Acceptance criteria**:
- [ ] All 4 files contain a `## ⛔ Worker Forbidden Operations` section at the top (above any task-specific content) with the same forbidden-ops table
- [ ] Each forbidden op cites: (a) the path/operation, (b) the failure mode it prevents, (c) the override flag if any, (d) the runtime trap-door file enforcing it
- [ ] send-to-morty.md line 61 `NEVER modify state.json...` rule is expanded into a full table and cross-referenced to the runtime trap doors (so workers see "this is also runtime-enforced; don't waste time trying")
- [ ] Regression test: `extension/tests/forbidden-ops-doc-parity.test.js` asserts all 4 files have the identical forbidden-ops table by content-hash

**Note on enforcement value**: Per the skeptic agent's red-team — prose alone is worthless. This ticket is the prose layer of a defense-in-depth strategy paired with R-WSRC-1, -2, -3, -4 runtime checks. The prose's job is to (a) make workers self-aware so they don't accidentally try forbidden ops, (b) cite the runtime trap doors so workers know the check is real and not bypassable, (c) provide override discoverability so legitimate use cases (schema migration) know how to proceed.

### R-WSRC-6 — Closer: version bump + release-gate + deploy + MASTER_PLAN update

**Atomic closer ticket** (large tier, retroactive R-CTSF split):
- [worker] Run source-scope verification and prepare handoff evidence: full release gate from `extension/` plus `bash scripts/audit-test-add-dir-containment.sh`; if residual failures are pre-existing or manager-only work remains, record them in the closer handoff instead of failing the ticket on deploy/release ownership.
- [worker] Prepare the manager handoff package: expected compiled-file parity set, the Finding #43 closeout note, and the exact closeout rows the manager must update once handoff begins.
- [manager] Bump `extension/package.json`: minor bump (new `state_write_*` activity events + schema fields = state schema_version bump candidate; needs migration if existing sessions carry pre-R-WSRC flag absence).
- [manager] Deploy via `bash install.sh --closer-context --no-confirm`.
- [manager] MD5 parity verify on 5 most-trafficked files per AC-RVN-08.
- [manager] Update `prds/MASTER_PLAN.md`: move R-WSRC row from `### Open (P1)` to `### Closed`; close Finding #43.

## Out of Scope

- **Per-worker git worktree isolation** — architect + skeptic both rejected (wrong layer, breaks self-modification semantics, unresolvable merge conflicts for sequential tickets with overlapping file targets). Revisit only if R-WSRC-1..4 prove insufficient in production.
- **macOS sandbox-exec / Linux namespaces** — operationally hostile (silent EPERM, undocumented .sb format, deprecated in macOS 12+).
- **In-process fs monkey-patch** — wrong process boundary (the worker is a `claude -p` subprocess with its own file descriptors; the Node parent's fs is irrelevant).
- **Worker-gate SIGTERM propagation** — covered by R-MRWG-2 (Finding #42) in the B-MRWG bundle. R-WSRC and R-MRWG should land in the same release window since they have overlapping incident classes.
- **Fixing the test that leaked** (`mux-runner.test.js:782-837` audit-bundle-halt with deadbeef/phantom fixture) — partially in R-WSRC-4; if more invasive surgery is needed it lands in a follow-up R-WSRC-7.

## Dependencies

- Builds on existing `StateManager` + `isRecoverableStateSnapshotCandidate` primitives (state-manager.ts:361)
- Builds on existing `classifyCapCheckReadError` pattern (mux-runner.ts:2615) — extended to other read sites
- Builds on existing `config-protection.ts` hook surface (PROTECTED_BASH_CANDIDATES)
- Builds on existing `ExitReason` enum + `isFailureExit` set + auto-resume.sh R-CNAR-4(c) integration
- No deps on B2-RSU in-flight bundle; can ship as standalone B-WSRC

## Risk

- **R-WSRC-1 false-positive** if `migrateSchema` path can't be exempted cleanly. Mitigation: dedicated `_internalSchemaBump: true` flag in `update()` opts, set only by `migrateSchema` itself, audited at lint time.
- **R-WSRC-3 false-positive** on legitimate ticket artifact writes near runtime files. Mitigation: glob anchors `**/state.json` are explicit (not `**/state*`), schema-migration ticket explicitly sets the override flag.
- **R-WSRC-4 PICKLE_TEST_MODE leakage** if env var is set in production by accident. Mitigation: only the npm test runner sets it; check at install.sh time that it's unset.
- **R-WSRC-5 doc bloat** — adds ~30 lines to 4 files. Mitigation: keep the table tight, cross-reference instead of duplicating prose.

## Recurrence Evidence

| Date | Ticket | Incident | Recovery cost |
|---|---|---|---|
| 2026-05-16 AM | `22c36bf6` (R-QGSK-3) | Schema bump → mux-runner wedge | Killed mid-progress; ticket abandoned with worker-written changes left uncommitted |
| 2026-05-16 AM | (test fixture) | Leaked `claude --dangerously-skip-permissions --add-dir <real-repo>` survived worker-gate SIGTERM | Killed manually; no observed damage to working tree (caught before subprocess made writes) |

Both incidents in the same operator session, both root-caused to the same defense-in-depth gap: workers have unrestricted access to runtime state and the runtime trusts whatever state files it finds.

## Cross-references

- Finding #42 R-MRWG — `prds/archive/bug-reports/p1-mux-runner-wedges-13h-on-unbounded-between-ticket-gate-spawnsync.md` (overlap on SIGTERM non-propagation enabling leak survival)
- AC-RVN-08 — existing deploy parity gate that catches install-time drift; R-WSRC complements with write-time defenses
- send-to-morty.md:61 — existing prose-only `NEVER modify state.json` rule; R-WSRC-5 promotes to defense-in-depth pairing with runtime enforcement
