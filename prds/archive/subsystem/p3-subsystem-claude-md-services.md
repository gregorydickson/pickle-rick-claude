# DRAFT PRD: extension/src/services/ CLAUDE.md — Public Export Documentation

**Status**: DRAFT (follow-up from audit ticket 2bc35531)
**Drift class**: INCOMPLETE (1% export coverage — only 4/365 exports mentioned)
**Priority**: P3

## Problem

`extension/src/services/CLAUDE.md` contains only 2 trap-door entries (`backend-spawn.ts`, `state-manager.ts`). The services subsystem has 30 source files and ~365 public exports — by far the largest subsystem. Key services like convergence-gate, pickle-utils, circuit-breaker, metrics-utils are undocumented at the subsystem level despite having complex contracts.

## Public Exports by File (key entries)

| File | Key exports |
|------|-------------|
| ac-phase-gate.ts | AC_PHASE_MANIFEST, AcEvaluationPhase, AcPhaseCriterion, AcPhaseGateResult, runAcPhaseGate |
| activity-logger.ts | getActivityDir, logActivity, _setRetryDelayMs |
| agent-md-loader.ts | AgentModel, AgentMdFrontmatter, LoadedAgentMd, loadAgentMd |
| artifact-validation.ts | findMissingPrefixes, listLinearTicketFiles |
| backend-spawn.ts | ReasoningEffort, SpawnInvocation, buildWorkerInvocation, buildManagerInvocation |
| bundle-finalize.ts | BundleFinalizeTicket, BundleTestFloorResult, parseRefinementBaseline, computeTestFloor |
| bundle-state-integrity.ts | RelaunchCapAuditResult, auditCodexManagerRelaunchCaps |
| calibration-corpus.ts | CalibrationSuite, CALIBRATION_SUITES, runCalibration |
| circuit-breaker.ts | CircuitState, CircuitBreakerState, checkCircuitBreaker, recordProgress |
| classifier-utils.ts | detectOutputFormat, extractAssistantContent |
| codex-manager-relaunch.ts | RelaunchEvaluation, evaluateCodexManagerRelaunch, recordCodexManagerRelaunch |
| convergence-defaults.ts | DEFAULT_FIX_BACKEND_PROMPT, DEFAULT_REVIEW_BE_PROMPT, etc. |
| convergence-gate.ts | GateError, runGate, filterByScope, assertBaselineFresh |
| council-fanout.ts | StackTier, SubagentSpec, planFanOut |
| council-schema.ts | CouncilSchemaError, Finding, TrapDoor, StackOverview |
| dot-builder.ts | BUILD_ERROR_CODES, BuildErrorCode, build (main entry) |
| git-utils.ts | runGit, getGithubUser, getBranchName, updateTicketFrontmatter |
| jar-utils.ts | addToJar |
| linear-integration.ts | syncLinearTicketStatus, emitBundleLinearComments |
| metrics-utils.ts | DailyTokens, MetricsTotals, computeMetrics, appendSessionMetrics |
| microverse-state.ts | assertMicroverseStateShape, createMicroverseState, compareMetric, recordIteration |
| pickle-utils.ts | clearTicketCacheFields, safeErrorMessage, detectLogTruncation, restartDeadWatcherPanes |
| pr-factory.ts | createPR |
| project-type-classifier.ts | ProjectTypeCategory, ProjectTypeScore, detectProjectType |
| promise-tokens.ts | PROMISE_TOKENS, PromiseToken, FORBIDDEN_WORKER_TOKENS, scrubForbiddenWorkerTokens |
| recoverable-json.ts | readRecoverableJsonObject |
| scope-resolver.ts | ScopeMode, ScopeStrategy, resolveScope, refreshScope |
| state-manager.ts | StateManager, safeDeactivate, recordExitReason, finalizeTerminalState |
| transaction-ticket-ops.ts | TicketStatus, TicketTransactionContext, executeTicketTransaction |
| worker-shutdown.ts | flushAndExit |

## Suggested Invariants

- `readRecoverableJsonObject` — Only entrypoint for reading any JSON that may have `.tmp.<pid>` partial writes; never use raw `JSON.parse(fs.readFileSync(...))` at call sites that read mutable session state
- `StateManager.read()` — The canonical recovered-state reader; raw reads bypass orphan-tmp promotion and dead-pid demotion
- `scrubForbiddenWorkerTokens` — Must be applied to all worker output before promise-token detection
- `detectOutputFormat` — Canonical codex vs. stream-json classifier; callers must emit drift warning when plain-text returned for codex backend

## Suggested Trap-Door Entries

```
- `src/services/recoverable-json.ts` — INVARIANT: readRecoverableJsonObject is the sole JSON recovery primitive; direct fs.readFileSync + JSON.parse is forbidden at sites that read mutable session artifacts. BREAKS: interrupted writes produce corrupted reads. ENFORCE: state-manager.test.js, get-session.test.js.
- `src/services/promise-tokens.ts` — INVARIANT: scrubForbiddenWorkerTokens must run on worker output before promise-token detection; FORBIDDEN_WORKER_TOKENS is the authoritative forbidden list. BREAKS: orchestrator-only tokens emitted by workers escape detection. ENFORCE: extension/tests/activity-event-payload.test.js.
```

## Acceptance Criteria (for follow-up ticket)

- [ ] `extension/src/services/CLAUDE.md` enumerates all 30 files with key exports and per-service invariants
- [ ] Trap-door entries for `recoverable-json.ts` and `promise-tokens.ts` added
- [ ] Drift audit script reports `OK` for services/ subsystem after update
