# P1: Project-Wide Multi-Agent Audit — 2026-05-23

**Bundle code**: `B-PROJECT-AUDIT-2026-05-23`
**Filed**: 2026-05-23 CDT
**Filed by**: 4-agent parallel review (researcher / architect / skeptic / implementer lenses)
**Scope target**: entire `pickle-rick-claude/` repository
**Pipeline contract**: this PRD will be refined by `/pickle-refine-prd`, implemented via `/pickle-tmux` with `--backend codex`, then audited unscoped by `/anatomy-park` and `/szechuan-sauce` (whole-project coverage for both cleanup phases).

## Context

A 4-agent review team scanned the codebase from four distinct lenses and produced 44 raw findings (researcher: 12 ledger/doc-drift; architect: 11 design/coupling; skeptic: 11 adversarial; implementer: 10 code-quality). Findings deduped to 37 actionable tickets, organized into 6 bundles. One P1 (dead-code wired ledger, R-RSLJ) — the rest split between P2 (correctness/safety) and P3 (hygiene/docs/duplication).

## Principles Reference

- Base szechuan principles: `$HOME/.claude/pickle-rick/szechuan-sauce-principles.md`
- Worker forbidden ops: `/Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude/CLAUDE.md` (R-WSRC table)
- Existing trap-door inventory: `extension/CLAUDE.md`
- MASTER_PLAN ledger: `prds/MASTER_PLAN.md`

## Focus Directive

State integrity (lock/migration/circuit-breaker), backend abstraction parity (codex/hermes vs claude), and worker isolation enforcement are elevated by one priority level.

---

## Bundle 1 — Ledger & Open-Work Reconciliation (P2/P3)

### R-RVMW — Wire `evaluateCodexManagerRelaunch` into `microverse-runner.ts`
- **Evidence**: `extension/src/bin/microverse-runner.ts` (zero matches for `evaluateCodexManagerRelaunch`); function exists in `mux-runner.ts` only; `prds/anatomy-park-followups.md` AC-APF-C1..C6.
- **Acceptance criteria** (machine-checkable):
  - `grep -n evaluateCodexManagerRelaunch extension/src/bin/microverse-runner.ts` returns ≥1 match.
  - New test `extension/tests/microverse-codex-manager-relaunch.test.js` exists and passes; asserts relaunch fires on `Subprocess error` branch.
- **Priority**: P2 — long-running anatomy-park codex sessions wedge at 4-hour wall.

### R-RAUD — Flip `bin/` + `services/` subsystem CLAUDE.md audits to OK
- **Evidence**: `prds/MASTER_PLAN.md` lines 73-74 mark these subsystems INCOMPLETE.
- **Acceptance criteria**: `bash extension/scripts/audit-subsystem-claude-md.sh bin/ services/` exits 0; MASTER_PLAN line for B-AUDIT shows both as OK.
- **Priority**: P3.

### R-RPVS — Draft PRDs for R-PVTA and R-VSGE
- **Evidence**: MASTER_PLAN lines 65-66; both ride in B-GATE PARTIAL.
- **Acceptance criteria**: `ls prds/ | grep -E '(r-pvta|r-vsge|p[0-9]-.*pvta|p[0-9]-.*vsge)'` returns ≥2 files; each PRD has machine-checkable AC.
- **Priority**: P3.

### R-RMSF — Promote R-MEGA-SELF-FIX Phases 1/2/4 to NEXT
- **Evidence**: MASTER_PLAN line 111; Phases 1 (B-SJET-2), 2 (B-SSDF), 4 (R-CSI) open with no bundle status.
- **Acceptance criteria**: MASTER_PLAN.md NEXT section lists `B-SJET-2` and `B-SSDF` as NEXT or IN-FLIGHT.
- **Priority**: P2 — szechuan ETIMEDOUTs on judge baseline currently deterministic.

### R-RAPL — Register 6 anatomy-park PRDs into MASTER_PLAN
- **Evidence**: 7 `prds/anatomy-park-*.md` files; zero MASTER_PLAN.md mentions.
- **Acceptance criteria**: for each `anatomy-park-*.md` file, `grep -F <filename> prds/MASTER_PLAN.md` returns ≥1 match; each gets a finding ID + priority.
- **Priority**: P3.

### R-RWUW — Add reproducer test or formal defer marker for R-WUWC (#52)
- **Evidence**: MASTER_PLAN line 67 — "awaiting fresh post-v1.78.0 reproducer".
- **Acceptance criteria**: either (a) `extension/tests/wuwc-reproducer.test.js` exists and passes, OR (b) MASTER_PLAN.md row for #52 contains `DEFERRED: <iso-date>` + re-open criteria.
- **Priority**: P3.

### R-RLNT — Register R-LINT or convert TODOs to carve-outs
- **Evidence**: `extension/src/services/citadel/trap-door-coverage-audit.ts:34`, `extension/src/bin/spawn-morty.ts:975`; R-LINT missing from MASTER_PLAN.
- **Acceptance criteria**: `grep -rn 'TODO(R-LINT)' extension/src` returns 0 occurrences (replaced with `eslint-disable-next-line complexity -- R-LINT-<id> reviewed`), OR MASTER_PLAN has R-LINT registered with finding ID.
- **Priority**: P3.

### R-RCSI — Document R-CSI Phase 1 trigger criteria + ship minimal forensic logging
- **Evidence**: MASTER_PLAN line 51; "deferred per operator (await next incident)" with no trigger criteria.
- **Acceptance criteria**: PRD section for R-CSI lists explicit re-open trigger (incident OR `<date>` timeout); `extension/src/services/concurrent-session-forensics.ts` exists and is wired into mux-runner SIGINT handler.
- **Priority**: P2 — next concurrent-session SIGINT is otherwise unreproducible.

### R-RAPW — Assign R-APWS (#11) scope-bypass to a bundle
- **Evidence**: MASTER_PLAN line 61.
- **Acceptance criteria**: MASTER_PLAN row for #11 shows non-empty bundle code (NEXT or IN-FLIGHT).
- **Priority**: P2.

### R-RMMT — Promote B-R-MMTR closer (ticket 7) to NEXT
- **Evidence**: MASTER_PLAN line 74.
- **Acceptance criteria**: MASTER_PLAN NEXT section lists `B-R-MMTR closer-7`.
- **Priority**: P3.

### R-RSLJ — Wire `updateViolationLedger` + `buildJudgePrompt(priorViolations)` into `measureLlmMetricAttempt`
- **Evidence**: `extension/CLAUDE.md` trap door `ticket 98dc9bed F1.1/F1.2/F1.4`: helpers shipped but `state.violation_ledger` stays empty; entire R-SLLJ-1/3/4 false-stall fix orbit unreachable.
- **Acceptance criteria**:
  - `grep -n updateViolationLedger extension/src/bin/microverse-runner.ts` returns ≥1 production call site.
  - `extension/tests/sllj-violation-ledger-wired.test.js` exists; asserts ledger is populated after a judge invocation.
  - `state.violation_ledger.length > 0` after a microverse iteration in the fixture test.
- **Priority**: **P1** — false-stall pathology can recur on any LLM-judge microverse run.

### R-RMRG — Create bundle for monorepo-gap F2/F3/F4
- **Evidence**: `prds/archive/bug-reports/anatomy-park-szechuan-monorepo-missed-detection-gap.md`; `prds/archive/bug-reports/anatomy-park-szechuan-loa775-sibling-pattern-misses.md:7` confirms F1 shipped, F2/F3/F4 unshipped.
- **Acceptance criteria**: new bundle code in MASTER_PLAN.md NEXT covers F2/F3/F4 with finding IDs.
- **Priority**: P2.

---

## Bundle 2 — State Integrity & Locking (P2)

### R-ACBR — Route `circuit_breaker.json` writes through StateManager (consolidated)
- **Evidence**: `extension/src/bin/mux-runner.ts:5172,5201` — `writeStateFile(cbPath, cbState)` direct call; `PROTECTED_STATE_BASENAMES` in `extension/src/hooks/handlers/config-protection.ts:88-93` lists `circuit_breaker.json`.
- **Acceptance criteria**:
  - `grep -n "writeStateFile(cbPath" extension/src/bin/mux-runner.ts` returns 0 matches.
  - Circuit breaker writes go through `StateManager.update()` or a dedicated SM instance.
  - New test `extension/tests/circuit-breaker-atomicity.test.js` covers concurrent-write race.
- **Priority**: P2.

### R-ASMS — Emit forensic activity event on schema migration write failure
- **Evidence**: `extension/src/services/state-manager.ts:566,583,590` — three silent `catch { /* migration write failed, non-fatal */ }` blocks.
- **Acceptance criteria**:
  - `VALID_ACTIVITY_EVENTS` in `extension/src/types/index.ts` includes `schema_migration_write_failed`.
  - All three catch sites at 566/583/590 emit the event (write to stderr if activity write also fails).
  - Test `extension/tests/state-manager-migration-failure-signal.test.js` asserts the event fires on a simulated write failure.
- **Priority**: P2 — current behavior creates split-brain between in-memory and on-disk schema versions.

### R-ALTC — Count lock steals against retry budget in `tryStealStaleLock`
- **Evidence**: `extension/src/services/state-manager.ts:763-800` — `attempt--` exempts steals from `maxLockRetries`.
- **Acceptance criteria**:
  - `attempt--` after a successful steal is removed; a separate `stealsRemaining` counter (≤ `maxSteals`) gates further steals.
  - `LockError` message includes both retry-budget and steal-budget exhaustion.
  - Test `extension/tests/state-manager-lock-steal-budget.test.js` asserts a contested lock cannot spin past `maxLockRetries`.
- **Priority**: P2.

### R-AORD — Consolidate phantom + mapped-orphan demotion into `recoverStaleActiveFlag`
- **Evidence**: `extension/src/services/state-manager.ts:910-942` — only handles paused-orphan + dead-pid; phantom path lives in `extension/src/services/pickle-utils.ts:360`.
- **Acceptance criteria**:
  - `recoverStaleActiveFlag` handles the phantom-session demotion path (state-map PID dead + missing session-dir) and emits `phantom_session_demoted`.
  - `pickle-utils.ts:360` phantom-demotion code path is removed OR delegates to `recoverStaleActiveFlag`.
  - Test `extension/tests/state-manager-phantom-demotion-consolidated.test.js` asserts both paths fire from a single `StateManager.read()`.
- **Priority**: P2.

### R-AADF — Fix `paused_session_orphan_demoted` idempotency guard
- **Evidence**: `extension/src/services/state-manager.ts:923-925` writes `kind`; guard at line 295-296 checks `a.kind` instead of `a.event`. `ActivityLogEntry` at `extension/src/types/index.ts:258-260` does not define `kind`.
- **Acceptance criteria**:
  - Guard at `state-manager.ts:296` checks `a.event === 'paused_session_orphan_demoted'`.
  - `kind` field removed from the written entry.
  - Test asserts repeated `recoverStaleActiveFlag` calls produce exactly one activity entry.
- **Priority**: P3.

### R-AWLS — Route `writeLoopState` fallback through `_sm.forceWrite()`
- **Evidence**: `extension/src/bin/mux-runner.ts:3343-3345` — `(ctx.writeState || writeStateFile)(...)` bypasses R-WSRC-1 schema ceiling.
- **Acceptance criteria**:
  - Production fallback in `writeLoopState` calls `_sm.forceWrite()` (which enforces `assertSchemaVersionWithinCeiling`).
  - Test `extension/tests/writeloopstate-schema-ceiling.test.js` asserts a forward-schema write is rejected through this path.
- **Priority**: P2.

---

## Bundle 3 — Backend Abstraction Parity (P2/P3)

### R-AHMR — Split `buildHermesManagerInvocation` from worker invocation
- **Evidence**: `extension/src/services/backend-spawn.ts:328-331` — hermes manager routes through `buildHermesWorkerInvocation`, silently dropping `streamJson` / `noSessionPersistence` / `maxTurns`; line 394-410 forces worker `--ignore-rules` + `--ignore-user-config` onto managers.
- **Acceptance criteria**:
  - `buildHermesManagerInvocation` exists in `extension/src/services/backend-spawn.ts` and is called from `buildManagerInvocation` for hermes backend.
  - Manager-specific options (`streamJson`, `noSessionPersistence`, `maxTurns`) are honored.
  - Test `extension/tests/backend-spawn-hermes-manager.test.js` asserts manager flags differ from worker flags.
- **Priority**: P2 — silent flag drop produces unparseable manager output.

### R-SCMT — Document codex `--max-turns` gap; suppress field for codex backend
- **Evidence**: `extension/src/services/backend-spawn.ts:367-392`; `ManagerInvocationOptions.maxTurns` silently dropped by `buildCodexInvocation`.
- **Acceptance criteria**:
  - `buildCodexInvocation` either (a) consumes `maxTurns` and translates to a codex equivalent, OR (b) warns to stderr when `maxTurns` is set but codex has no equivalent.
  - `extension/CLAUDE.md` trap-door section documents the codex/claude maxTurns divergence.
- **Priority**: P3.

### R-SCJE — Add codex `--ephemeral` assertion to `backend-spawn-judge.test.js`
- **Evidence**: `extension/src/services/backend-spawn.ts:436-477` — claude judge has tested `--no-session-persistence`; codex judge uses `--ephemeral` with no test.
- **Acceptance criteria**: `backend-spawn-judge.test.js` includes a test asserting `args` from `buildCodexJudgeInvocation()` contains `--ephemeral`.
- **Priority**: P3.

---

## Bundle 4 — Spawn & Hook Safety (P2)

### R-SSPM — `spawn-morty.ts` SIGKILL failsafe verification
- **Evidence**: `extension/src/bin/spawn-morty.ts:1505` spawn has no native `timeout`; manual setTimeout at line 1521 sends SIGTERM with no SIGKILL failsafe verification.
- **Acceptance criteria**:
  - After SIGTERM is sent, a follow-up SIGKILL is scheduled (e.g., +5s) and the failure to terminate is logged as `worker_kill_escalation_failed`.
  - Test asserts SIGTERM-ignoring child triggers SIGKILL within the escalation window.
- **Priority**: P2.

### R-SJRH — `jar-runner.ts` detached + process-group kill on hang
- **Evidence**: `extension/src/bin/jar-runner.ts:173` — `spawn` with `stdio: 'inherit'`, no `detached`, hang guard at 186 cannot kill grandchildren.
- **Acceptance criteria**:
  - Jar-runner spawn uses `detached: true`; hang guard calls `process.kill(-pid, 'SIGTERM')` then `-pid SIGKILL`.
  - Test asserts a subprocess spawning grandchildren is fully reaped on timeout.
- **Priority**: P2.

### R-ACGS — Move baseline-missing artifact write out of `assertBaselineFresh`
- **Evidence**: `extension/src/services/convergence-gate.ts:186-200` — side-effect file write inside predicate; caller `microverse-runner.ts:684-690` receives `EACCES` instead of `BaselineMissingError` if write fails.
- **Acceptance criteria**:
  - `assertBaselineFresh` is a pure predicate (no I/O), only throws typed errors.
  - Baseline-missing artifact write moves to the catch site in `microverse-runner.ts`.
  - Test `extension/tests/convergence-gate-pure-predicate.test.js` asserts no file write occurs in `assertBaselineFresh` when baseline is missing.
- **Priority**: P3.

### R-ACPS — Unconditional stderr write in `config-protection.ts` outer catch
- **Evidence**: `extension/src/hooks/handlers/config-protection.ts:515-529` — outer catch routes to `debug.log` via `getExtensionRoot()`; if that fails, hook silently approves with zero forensic signal.
- **Acceptance criteria**:
  - First action in outer catch is `process.stderr.write(\`config-protection: unhandled exception: ${err.message}\n\`)` before any `getExtensionRoot()` call.
  - Test asserts stderr contains the crash signal when `getExtensionRoot` throws.
- **Priority**: P3.

---

## Bundle 5 — Test Theater & CI Gate (P2/P3)

### R-STTB — Replace substring assertions in `bundle-state-integrity.test.js` with discriminant fields
- **Evidence**: `extension/tests/bundle-state-integrity.test.js:42,53` — substring sniffs on human-readable reason strings.
- **Acceptance criteria**:
  - Violation object has `kind: 'over_cap' | 'non_numeric'` discriminant.
  - Test assertions check `.kind` not `.reason.includes(...)`.
- **Priority**: P3.

### R-STCS — Add behavioral test for citadel `--strict` flag
- **Evidence**: `extension/tests/citadel-command-surface.test.js:31-78` validates only markdown contents.
- **Acceptance criteria**: `extension/tests/citadel-strict-flag-behavior.test.js` exists; invokes `pipeline-runner.js` with `citadel_strict: true` against a fixture and asserts behavioral difference (e.g., fail-fast vs warn).
- **Priority**: P3.

### R-STCP — `citadel-pipeline-regression-smoke.test.js` asserts mux-runner arg shape
- **Evidence**: `extension/tests/citadel-pipeline-regression-smoke.test.js:162-168` — spawn stub ignores `args`.
- **Acceptance criteria**: Stub captures `args` and assertion verifies `--session-dir` + `pipeline.json` are present and well-formed.
- **Priority**: P3.

### R-SCIG — Stability-gate as required pre-release check
- **Evidence**: `.github/workflows/ci.yml:22` runs expensive on every push; `.github/workflows/stability-gate.yml` is manual-trigger only.
- **Acceptance criteria**:
  - Either (a) release workflow calls stability-gate and waits for green, OR (b) `gh release create` is documented as gated and a `scripts/release-precheck.sh` exists that the release runbook runs.
  - `CLAUDE.md` `## Versioning` section references the stability-gate requirement.
- **Priority**: P2.

---

## Bundle 6 — Code Quality & Hygiene (P3)

### R-IDSM — Replace 45 inline `err instanceof Error ? err.message : String(err)` with `safeErrorMessage`
- **Evidence**: 45 occurrences across 24 files; helper exists at `extension/src/services/pickle-utils.ts:108`.
- **Acceptance criteria**: `grep -rn "err instanceof Error ? err.message" extension/src --include='*.ts' | wc -l` returns ≤5 (with carve-outs documented for the residual cases, e.g., test fixtures).
- **Priority**: P3.

### R-IDRX — Remove duplicate `evaluateCodexManagerRelaunch` re-export from `mux-runner.ts`
- **Evidence**: `extension/src/bin/mux-runner.ts:30` and `extension/src/services/codex-manager-relaunch.ts:2` both re-export from `manager-relaunch.js`.
- **Acceptance criteria**:
  - `mux-runner.ts:30` re-export removed; tests importing from `mux-runner.js` for this symbol redirected to `codex-manager-relaunch.js`.
  - `extension/tests/mux-runner.test.js:4428` (and any sibling) updated.
- **Priority**: P3.

### R-ITYP — Reduce `as unknown as` cast chains
- **Evidence**: 19 occurrences across 10 files; worst offender `extension/src/services/dot-builder.ts` (5).
- **Acceptance criteria**: `grep -rn "as unknown as" extension/src --include='*.ts' | wc -l` returns ≤8; dot-builder reduced to ≤1.
- **Priority**: P3.

### R-INGS — Add `npm run test:gate` script
- **Evidence**: `extension/package.json:19` — `"test"` is fast+integration only; full gate is prose in CLAUDE.md.
- **Acceptance criteria**:
  - `extension/package.json` defines `"test:gate"` containing the full audit + tier chain documented in CLAUDE.md.
  - CLAUDE.md `## Build & Test` section references `npm run test:gate` as the canonical pre-commit/pre-release invocation.
- **Priority**: P3.

### R-IDOC — Add `/pickle-debate` + `/project-mayhem` to `COMMANDS.md`
- **Evidence**: both commands exist under `.claude/commands/`; neither appears in `COMMANDS.md`.
- **Acceptance criteria**: `grep -E '(pickle-debate|project-mayhem)' COMMANDS.md` returns ≥2 entries, each with synopsis + flag list.
- **Priority**: P3.

### R-ITSL — Verify `src/bin/__tests__/*.spec.ts` registration in `test-registration-hygiene.test.js`
- **Evidence**: 3+ `.spec.ts` files in `extension/src/bin/__tests__/` — compiled output lands outside `extension/tests/`.
- **Acceptance criteria**: `test-registration-hygiene.test.js` either lists these files in its allowlist OR the test runner discovers `extension/bin/__tests__/*.test.js` paths; new test asserts every `src/**/__tests__/*.spec.ts` has a compiled+discovered counterpart.
- **Priority**: P3.

### R-IGIG — Extend `.gitignore` carve-out for fixtures path
- **Evidence**: `.gitignore:5` carves out `!extension/tests/__fixtures__/**/*.dot` but golden files live under `extension/tests/fixtures/dot-builder/`.
- **Acceptance criteria**:
  - `.gitignore` includes `!extension/tests/fixtures/**/*.dot`.
  - `git check-ignore extension/tests/fixtures/dot-builder/golden-*.dot` returns non-zero (i.e., NOT ignored).
- **Priority**: P3.

### R-AAOM — Extend install parity gate to cover all compiled JS
- **Evidence**: `install.sh:335-348` parity probe covers 5 hand-picked files only.
- **Acceptance criteria**:
  - Parity probe iterates all `*.js` files under `extension/bin/`, `extension/services/`, `extension/hooks/` that have a corresponding `*.ts` source.
  - `pipeline_auto_resumed` activity event registration is covered (`types/index.js` MD5 parity).
- **Priority**: P2.

---

## Out-of-scope for this run

- I-COMPLEXITY-001/002/003 (mux-runner.ts / microverse-runner.ts / pickle-utils.ts monolith splits) — large refactors with shipped partial work (god-functions-remediation.md); needs its own bundle.

## Definition of done

- Every ticket above has its AC verified green.
- `prds/MASTER_PLAN.md` updated with a closed-row for each shipped ticket and bundle status `B-PROJECT-AUDIT-2026-05-23: COMPLETED`.
- Full gate passes: `cd extension && npm run test:gate` (the new script from R-INGS).
- `anatomy-park` and `szechuan-sauce` complete unscoped passes against the post-fix tree with no new P1/P2 findings.
