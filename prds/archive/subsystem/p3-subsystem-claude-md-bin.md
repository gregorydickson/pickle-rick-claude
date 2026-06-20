# DRAFT PRD: extension/src/bin/ CLAUDE.md — Public Export Documentation

**Status**: DRAFT (follow-up from audit ticket 2bc35531)
**Drift class**: INCOMPLETE (0% export coverage)
**Priority**: P3

## Problem

`extension/src/bin/CLAUDE.md` contains only trap-door entries. It does not enumerate public exports, invariants per exported symbol, or entry-point documentation for the 49 source files (~337 exports). Future agents working on bin/ scripts lack context about what each module exports and guarantees.

## Public Exports by File

| File | Key exports |
|------|-------------|
| archaeology.ts | ArchaeologyArgs, ArchaeologyRunOptions, ArchaeologyRunResult, parseArgs, buildArchaeologyPrompt |
| audit-ticket-bundle.ts | detectCrossDocNamingDrift, extractForwardCreatePaths, checkPathDrift, auditSession |
| audit-worker-backends.ts | scanSession |
| auto-fill-completion-commit.ts | AutoFillCompletionCommitInput, AutoFillCompletionCommitResult, autoFillCompletionCommit |
| cancel.ts | cancelSession |
| check-gate.ts | CheckGateMainOpts, checkGateMain |
| check-readiness.ts | ReadinessArgs, ReadinessFinding, parseArgs, extractAcceptanceCriteria, isMachineCheckable |
| check-scope-diff.ts | CheckScopeDiffOpts, ScopeDiffResult, checkScopeDiff |
| check-update.ts | parseVersion, compareSemver, BlockedDowngradeError, readCache, writeCache |
| correct-course.ts | CorrectCourseArgs, CorrectCourseRunOptions, CorrectCourseRunResult |
| council-publish.ts | CouncilPublishError, PublishOptions, PublishResult, PublishReport |
| debate.ts | DebateArgs, DebateSettings, DebateRunOptions, DebateRunResult |
| finalize-gate.ts | FinalizeGateOpts, finalizeGateMain |
| generate-debate-personas.ts | DebatePersonaName, DebatePersonaDefinition, DEBATE_PERSONAS, renderDebatePersona |
| jar-runner.ts | loadJarTaskTimeout, RunTaskResult, SpawnResult, TaskMeta |
| log-watcher.ts | formatToolUse, processLine |
| metrics.ts | parseMetricsArgs |
| microverse-runner.ts | MetricSnapshot, IterationClassification, ExitOutcome |
| monitor.ts | MONITOR_STDOUT_WATCHDOG_MS, RESPAWN_WATCHDOG_INTERVAL_MS, MonitorWriteSink |
| morty-watcher.ts | classifyArtifact, discoverArtifacts |
| mux-runner.ts | killCurrentChild, stripSetupSection, truncateTaskNotes, detectMultiRepo |
| pipeline-runner.ts | PhaseName, SetupArgs, PhaseConfig, SpawnRunnerResult |
| setup.ts | SetupArgs, DEFAULT_MANAGER_IDLE_BACKOFF_FALLBACK_MS, countManifestTickets |
| spawn-gate-remediator.ts | SpawnGateRemediatorOpts, spawnGateRemediatorMain |
| spawn-morty.ts | ParsedArgs, TicketSpec, BuildWorkerPromptOptions, WorkerProcessContext, tierToModel |
| spawn-refinement-team.ts | warnIfCodexRequested, buildRefinementWorkerInvocation, ACTIVITY_EVENT_SCHEMA_SECTION |
| standup.ts | parseArgs, readActivityFiles, GitCommitEntry, getGitCommits |
| status.ts | showStatus |
| update-state.ts | updateState |
| validate-teams-ticket.ts | ParsedArgs, parseArgs, main |
| worker-setup.ts | (CLI guard entry point) |

## Suggested Invariants

- Every `bin/` script must have a CLI guard: `if (process.argv[1] && path.basename(process.argv[1]) === 'foo.js') { ... }`
- Every entry-point script that reads `state.json` must use `StateManager.read()`, not raw `JSON.parse(fs.readFileSync(...))`
- Every script that spawns subprocesses must pass a finite `timeout` to `spawnSync`/`execFileSync`
- Every helper module exported from `bin/` that is also used by other modules must be documented in the subsystem CLAUDE.md

## Suggested Trap-Door Entries

```
- `bin/` — INVARIANT: all CLI entry points must have a `process.argv[1]` guard before executing side-effectful logic. BREAKS: importing the module for testing executes side effects. ENFORCE: extension/tests/audit-test-isolation.sh.
- `bin/` — INVARIANT: all state reads in bin/ scripts must go through StateManager.read() except the explicit crash-path forceWrite fallback in mux-runner.ts. BREAKS: orphan tmp payloads ignored. ENFORCE: per-module tests.
```

## Acceptance Criteria (for follow-up ticket)

- [ ] `extension/src/bin/CLAUDE.md` updated to enumerate public exports by file
- [ ] Invariants documented per exported symbol where non-obvious
- [ ] Trap-door entries added for new invariants not already in `extension/CLAUDE.md`
- [ ] Drift audit script reports `OK` for bin/ subsystem after update
