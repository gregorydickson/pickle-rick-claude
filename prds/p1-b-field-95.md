---
title: "B-FIELD-95 — field issues #89–#98 + the B-FIELD-88 gate reds — REFINED"
status: refined
priority: P1
type: bug-bundle
branch: main
composes: ["#89", "#90", "#91", "#92", "#93", "#94", "#95", "#96", "#97", "#98"]
---

# B-FIELD-95 — REFINED

Source: `prds/p1-b-field-95.md` @ `main@1212055d`. Refined from 3 analysts × 3 cycles (9/9 succeeded). Changes from the
source are attributed `*(refined: <analyst> c<N>)*`. `composes:` lists ISSUE numbers, not PRDs — no Atomic-decomposition
fan-out applies. Issue texts reach this PRD by number and generic shape only; no client content.

## Invariants

- **No gate leg added.** Falsifier: `grep -c 'bash scripts/audit-' CLAUDE.md` is unchanged (record before/after in the
  release note). Every new test case lives in an EXISTING test file; every subprocess in a new case gets `timeout: 30_000`.
- **No new halt or abort condition.** T2 makes an EXISTING crash-floor halt (operator cancel) reachable from the cancel
  path that already means it; nothing else stops. T9/T10 change REPORTING only (verdict and log), never dispositions.
- `--scope branch --scope-base a0d6ccc2` — the commit before the #96 cherry-pick `3bc1fbdf`, so #96 is reviewed.
  `git merge-base --is-ancestor 3bc1fbdf HEAD` exits 0.

## Bundle self-exposure (this bundle runs on the deployed build it fixes) *(refined: risk-scope c3)*

- **#91:** `/eat-pickle` does not stop this bundle's pipeline. Recovery: `tmux kill-session -t pipeline-<hash>`.
- **#93:** a mid-bundle `circuit_open` is auto-relaunched and trips again; recovery `node ~/.claude/pickle-rick/extension/bin/circuit-reset.js`.
- **#94:** a rate-limit park over 30 min is reaped as a hang. Recovery: relaunch, or raise `child_mux_runner_stall_seconds`.
- **#89:** the pickle fence may seed narrow; out-of-fence boundary residue lands in `refs/pickle/salvage/<session>`.
- **#97:** the generated hardening tickets for THIS bundle already carry `zero_diff_intent: audit` (a recognised value
  today), so a correct no-op audit here does not loop.

## Premises (measured at `1212055d`)

| Claim | Tag | Evidence |
|---|---|---|
| The child-mux heartbeat reads only `tmux_iteration_*.log` mtimes (state.json fallback) | (verified) | `pipeline-runner.ts:1709-1739` |
| A `rejected` park re-probes every `PICKLE_RATE_LIMIT_PROBE_INTERVAL_MS` (default 600000, no ceiling) and WRITES `<session>/rate_limit_probe.log` each probe; an `allowed_warning` park does not probe and writes nothing | (verified) | `mux-runner.ts:9846`, `:9862`, `:9919`; `services/pickle-settings.ts:225-229` *(refined: codebase c3 — source premise row 2 was false)* |
| `rateLimitParkStillLive` returns true on unparseable JSON / missing `wait_until` BY DESIGN (B3: its watchdog callers escalate to a terminal park); a stale `rate_limit_wait.json` can survive a cancelled park | (verified) | `mux-runner.ts:13450-13467` *(refined: risk-scope c3)* |
| `exit_reason: 'cancelled'` is never persisted on the cancel path | (verified) | all three analysts c2/c3 — the source T2 mechanism could not fire |
| `cancelSession` returns before its lock when `active !== true`; `resetStateForPhase` sets `active=false` before every phase spawn | (verified) | `cancel.ts:83-86`; `pipeline-runner.ts:2018-2035` *(refined: risk-scope c3)* |
| `cancelledOutcome` is consulted per-ARM; the pending-ticket pickle arm (`maybeStampPhaseGraduation` continue) never calls it | (verified) | `pipeline-runner.ts:7450`, `:6292`/`:6299`, loop `:7684-7718` *(refined: codebase c2/c3)* |
| `main()` unlinks a stale `pipeline-cancel` marker at start | (verified) | `pipeline-runner.ts:7733-7738` |
| `initCircuitBreaker` trusts the on-disk breaker AS-IS (C3, ticket 1312977e), pinned by AC-C3-1/AC-C3-2; `resetCircuitBreaker` early-returns on CLOSED | (verified) | `services/CLAUDE.md` C3; `tests/circuit-breaker.test.js:1242`, `:1272`; `circuit-breaker.ts:453-456` *(refined: codebase c3)* |
| `canExecute` is `state !== 'OPEN'` | (verified) | `circuit-breaker.ts:199` |
| `reportPhaseIncomplete` overwrites `exit_reason` only when tickets remain | (verified) | `pipeline-runner.ts:6298` *(refined: requirements c3)* |
| Local census: 64 Done tickets, 63 stamped, 63/63 carry their own `Pickle-Ticket` trailer inside `start_commit..`; 1 unstamped (zero-diff) | (verified, local only) | census c3; the #92 field corpus is client-side and unmeasured here *(refined: codebase c3)* |
| HEAD fallback for a Done stamp at `spawn-morty.ts:2912`; a second unattributed source `pickAttributionCommit` → `windowShas[0]` at `:2709` | (verified) | *(refined: codebase c3)* |
| No worker prompt defines a BLOCKED token; workers may emit only `<promise>I AM DONE</promise>` | (verified) | root `CLAUDE.md` Worker Forbidden Ops *(refined: requirements c2)* |
| B-FIELD-88 seeded `allowed_paths = 2` from ONE ticket on a fresh launch; the 21 tickets' declared-file union is 41 | (verified) | session `2026-10-08-59c0d821` `pipeline-runner.log:5`; `resolveSeedPathsForSetup` `:1019-1035` takes its `currentTicket ?` branch *(refined: codebase c3)* |
| Claude CLI 2.1.295 documents `--settings` as additive; `--bare` skips settings-defined hooks | (verified) | `claude --help` *(refined: codebase/risk c2)* |
| This box masks #90 via `includeCoAuthoredBy: false` in `~/.claude/settings.json` | (verified) | 0/39 B-FIELD-88 commits carry it |
| `zeroDiffAccept` already accepts a declared intent with the tier's artifacts and a green gate | (verified) | `ticket-completion-evidence.ts:1149-1189` *(refined: requirements c2)* |
| Step 7e templates: Tickets 1–3 `large`, Ticket 4 `medium`; medium and large lifecycles are identical | (verified) | `pickle-refine-prd.md:408/:500/:598/:700`; `ticket-tier.ts:34-35` *(refined: all c3)* |
| A placeholder Open Decisions row (`none open`) is counted open and makes `computePipelineVerdict.unsuccessful` true | (verified) | `pipeline-runner.ts:3774`, `:6548-6551`; twin filter `:3722` *(refined: requirements c3)* |
| A pickle exit 1 with all tickets Done logs `completed successfully` because the pickle arm skips `phaseDivergence` | (verified) | `pipeline-runner.ts:7502-7511`, `:7547-7565` *(refined: codebase c2/c3)* |
| Six Failed writers; four record no reason (`spawn-morty.ts:2917`, `:3572`, `:3604`; `mux-runner.ts:3585`); the heal recipe writes `skipped_reason` that `reportSkippedFailedTickets` never reads | (verified) | `pipeline-runner.ts:2704-2707`; `bin/CLAUDE.md:162` *(refined: requirements c3)* |
| `archiveDirtyTreeBeforeFlip(` has exactly 4 call sites in `mux-runner.ts`, pinned `>= 4` by AC-WMFF-2A | (verified) | `:3501`, `:3583`, `:11127`, `:15883`; `bin/CLAUDE.md:121` *(refined: risk-scope c3)* |
| The R-ORSR-2 probe and `runner-authored-trailer.test.js:136` fail only because their small-tier fixtures lack `plan`/`code_review` | (verified) | measured: probe exit 1→0, test 20/1→21/0 with the two files |

## Open Decisions

| decision | options | default | owner | status |
|---|---|---|---|---|
| Mechanics: T1 mtime-set widening (+ park touches `rate_limit_wait.json` each poll); T2 marker written regardless of `active` when `pipeline.json` exists + one loop-level check, per-arm checks subtracted; T3 breaker reset at every mux-runner process start, reversing C3; T4 no HEAD-fallback Done stamp, BLOCKED clause dropped; T5 union seed; T8 all four hardening templates declare `audit`; T10 whole-cell placeholder match | accept all; review each | accept all | operator | decided: "Accept all (Recommended)" (operator, 2026-10-10) |
| #96 landing | cherry-pick into this bundle; standalone; rebuild | cherry-pick | operator | decided: "Cherry-pick into B-FIELD-95 (Recommended)" (operator, 2026-10-10) |

## Requirements

### T0 — B-FIELD-88 gate reds: fixtures model a small ticket WITH its tier's artifacts
Add `plan_*.md` + `code_review_*.md` (`requiredTierArtifactPrefixes('small')`) to (1) the R-ORSR-2 probe fixture in
`prds/MASTER_PLAN.md` and (2) `makeSession` in `extension/tests/runner-authored-trailer.test.js`. Never loosen T5a.
AC1: `bash extension/scripts/audit-ledger-probes.sh` exits 0 (measured 1). AC1b: its output names the R-ORSR-2 probe
OPEN. AC2: `node --test extension/tests/runner-authored-trailer.test.js` exits 0 (measured 1 fail).

### T1 — #94 a live rate-limit park is not a hang
`resolveChildMuxLivenessMtime` takes the MAX mtime over `tmux_iteration_*.log`, `rate_limit_probe.log` and
`rate_limit_wait.json`; the main-loop park touches `rate_limit_wait.json` (`fs.utimesSync`) each `RATE_LIMIT_POLL_MS`
poll, covering warning parks. No park record is parsed; `rateLimitParkStillLive` is unchanged. A stale wait file stops
advancing, so it cannot shield a hung child.
ACs (one `describeEach` over the liveness files): a fresh `rate_limit_probe.log` alone → no reap (fails today); a fresh
touched `rate_limit_wait.json` alone → no reap (fails today); every file stale including a future-dated
`rate_limit_wait.json` → reaped; no park files + stale log → reaped (unchanged). Document in the env-var row that a
probe interval above `child_mux_runner_stall_seconds × 1000` is covered by the poll touch.

### T2 — #91 an operator cancel ends the pipeline
Producer: `cancel.ts:cancelSession` writes `<session>/pipeline-cancel` for a session carrying `pipeline.json`, BEFORE
its `active !== true` early return; its message must not say "No active session" when it cancelled a pipeline.
Consumer: `runPipelinePhaseLoop` checks `cancelledOutcome(cancelMarker, log)` ONCE after every phase outcome, before
`handlePhaseBoundaryRespawn`; the per-arm calls are subtracted. No `exit_reason` is read.
ACs: AC1 (fails today) pickle stub calls the real `cancelSession` then exits 0 with Todo tickets → no later phase
runner, `pipeline-status.json:status === 'cancelled'`, tickets stay Todo; AC2 control: same without cancel → citadel
runs; AC3 control: a stale marker before `main()` does not cancel; AC4 (fails today): `cancelSession` with `active=false`
on a pipeline session → marker written, pipeline stops at the next boundary; AC5: a microverse phase cancelled mid-run
→ no later phase runs.

### T3 — #93 a relaunch starts the breaker fresh (reverses C3)
At mux-runner process start (the sole `initCircuitBreaker` caller) the loaded breaker is replaced by `freshState()` with
`history` preserved plus one appended transition (`reason: 'process start'`), whatever its persisted state. Rewrite the
`services/CLAUDE.md` C3 entry and AC-C3-1/AC-C3-2 to pin the new contract. Within one process the breaker accumulates.
ACs: AC1 (fails today) persisted CLOSED at 4/5 → fresh start + one no-progress iteration → `canExecute === true`; AC1b
(fails today) persisted OPEN → fresh start → `canExecute === true`; AC2 control: 5 in-process no-progress → OPEN; AC3:
`auto-resume.sh` R-CNAR-4(a) stops repeated no-progress relaunches at retry 3 (pin in `auto-resume-stop-conditions.test.js`).
Rejected: `resetCircuitBreaker` (no-op on CLOSED); an environmental-error enumeration.

### T4 — #92 a Done stamp needs an attributable commit
`persistWorkerOutcomeStatus` never stamps Done with a `completion_commit` that is merely current HEAD; with no
attributable window commit the ticket stays In Progress and `guardCompletionCommitBeforeDone` decides. Local census 0/63
borrowed stamps, so this refuses nothing seen on this box; re-run the census in the reporting environment before
release. The BLOCKED clause is dropped (no token grammar). `depends_on: [T0, T8]`.
ACs: AC1 (fails today) a successful worker outcome with no commit in its window → status not Done and no
`completion_commit` written; AC2 control: an attributable window commit → Done with that sha; AC3:
`bash extension/scripts/audit-ledger-probes.sh` exits 0 after T4 (if R-ORSR-2 legitimately closes, update its
MASTER_PLAN row in the same commit). Recorded, not built: the `pickAttributionCommit` `windowShas[0]` fallback.

### T5 — #89 the branch fence is the union of every ticket's files
Drop the `currentTicket ?` branch in `resolveSeedPathsForSetup` so the seed is always the union of Todo/In Progress
declared files. Rejected: deleting the seed (leaves pickle unfenced and falsifies the root CLAUDE.md R-WSRC row);
widening `isPathShaped`'s extension list.
ACs: AC1 (fails today) a multi-ticket session with `current_ticket` set at setup → seed = union (B-FIELD-88's roster
measured 41); AC2 control: a boundary commit with an untracked non-ticket file does not stage it.

### T6 — #90 workers emit no attribution trailer
Claude worker spawns pass `--settings` with the co-author attribution disabled (research verifies the key on 2.1.295:
`includeCoAuthoredBy` vs `attribution`), plus one worker-prompt line. Codex/hermes out of scope. Rejected: `--bare`
(skips settings hooks, removing R-WSRC enforcement); a deny-list hook.
ACs: AC1 the built claude invocation carries the override; AC2 a real commit made by a claude invocation built this way,
under a HOME without the user setting, carries no `Co-Authored-By` (or, if a live claude spawn is unavailable in tests,
a settings-file round trip proving the key is the one the CLI reads — research decides which and records why).

### T7 — #95 a cleanup phase changes no observable behaviour
`szechuan-sauce.md`: a cleanup may restructure, never change observable behaviour (new refusals, newly accepted
inputs, changed outputs) unless an acceptance criterion names it; a change that adds or changes a test expectation is
recorded as an open finding, not committed. ACs: `grep -c "observable behaviour" .claude/commands/szechuan-sauce.md` ≥ 1
and `grep -c "test expectation"` ≥ 1 (both measured 0), asserted by a case in `tests/szechuan-sauce.test.js`.

### T8 — #97 hardening tickets declare their zero-diff intent
Every `**Ticket N:` block in Step 7e of `pickle-refine-prd.md` declares `zero_diff_intent: audit` in its frontmatter
(decided: all four — a stated quality concession, PRIME DIRECTIVE). Reword the Done-flip fatal in `mux-runner.ts` so it
points at `zero_diff_intent`, not at pasting a sha.
ACs: AC1 per-block derived check over Step 7e (measured 0 declared); AC2 control pin parametrized over `large` and
`medium`, each with that tier's real artifact set → `zeroDiffAccept` accepts; the undeclared twin is refused; AC3
`grep -c "include completion_commit: <sha>" extension/src/bin/mux-runner.ts` = 0 (measured 1).

### T9 — #97 a non-zero phase exit never reads "completed successfully"
In `finalizePhaseSuccess`, remove the pickle exclusion around `phaseDivergence`: every phase with `exitCode !== 0`
gets `nonConvergent++` and `phaseDispositions[phase] = <exit_reason ?? 'exit_<code>'>`; the next phase still runs.
ACs: AC1 (fails today) pickle exit 1 with `exit_reason: circuit_open`, all Done → no `completed successfully`,
`phaseDispositions.pickle === 'circuit_open'`, `computePipelineVerdict(...).unsuccessful === true`, citadel runs; AC2
control exit 0 + all Done unchanged; AC3 exit 1 with no exit_reason → `exit_1`. Assert dispositions, never `exit_reason`.

### T10 — #97 a placeholder Open Decisions row is not a decision
One placeholder predicate used by `buildDependencyLens` and `readOpenDecisions` drops a row whose first cell matches
`^none(\s+open)?\.?$` (case-insensitive, whole cell). ACs: AC1 (fails today) only row `none open` → `open decisions: 0`
and `computePipelineVerdict(...).unsuccessful === false`; AC2 control `None of the backends support X` stays open;
AC3 `grep -c "!== 'none'" extension/src/bin/pipeline-runner.ts` = 0 (measured 2).

### T11 — #98 a Failed status is written only with its reason
`markTicketFailed(ticketId, sessionDir, { reason, evidenceLog?, completionCommit? })` in `services/git-utils.ts` writes
status, `failed_reason`, the evidence path and the completion-commit rule (null clears `completion_commit_inferred`; a
passed verified sha is kept) in ONE update. All six writers route through it; it does NOT archive — callers keep
`archiveDirtyTreeBeforeFlip(` first (count stays 4). When the worker log matches the existing rate/usage-limit
detector, the reason is that environmental class. `reportSkippedFailedTickets` reads `failed_reason ?? skipped_reason`.
Rewrite the AC-WMFF-2A shape in `bin/CLAUDE.md` to name `markTicketFailed(`; add a `services/CLAUDE.md` export row.
ACs: AC1 a widened case in `completion-authority-single-source.test.js`: no `status: 'Failed'` or
`updateTicketStatus(…'Failed'…)` write in `src/` outside `markTicketFailed` (mutation: a bare write → red); AC2 one
derived parametrized case over every Failed writer → non-empty `failed_reason` printed by the report; AC3 an
operator-Skipped ticket with `skipped_reason: X` prints `X`; AC4 `archiveDirtyTreeBeforeFlip(` count in mux-runner.ts = 4.

## Rejected or recorded

| Item | Why |
|---|---|
| Reading `state.rate_limit_park` (T1) | survives wake with `reset_at: null` (up to 240 min of false immunity) |
| Editing `rateLimitParkStillLive` (T1) | its fail-suppress arm is a deliberate B3 contract for the watchdogs |
| `exit_reason: 'cancelled'` as the cancel signal (T2) | never persisted |
| `resetCircuitBreaker` (T3) | no-op on a CLOSED breaker below threshold |
| Environmental-error enumeration (#93) | enumerated set |
| Log-token success test (#92) | 81% of worker logs are empty |
| BLOCKED verdict parsing (#92) | no token grammar exists |
| Deleting the fence seed (#89) | leaves pickle unfenced; falsifies the R-WSRC row |
| `isPathShaped` widening (#89) | enumerated set |
| `--bare` (#90) | skips settings-defined hooks |
| Trailer deny-list hook (#90) | enumerated set + new check |
| Test-expectation diff guard (#95) | new mechanism |
| Worker→report question channel (#97) | deferred: needs a design reusing an existing artifact |
| `markTicketFailed` absorbing the archive (#98) | breaks AC-WMFF-2A's zero-slack call-site count |


## Implementation Task Breakdown

| Order | ID | Title | Priority | Entry | Exit | Files |
|---|---|---|---|---|---|---|
| 10 | c931be45 | Fixtures model a small ticket with its tier artifacts (B-FIELD-88 gate reds) | High (medium) | prior orders Done | Exit State in ticket | prds/MASTER_PLAN.md, extension/tests/runner-authored-trailer.test.js |
| 20 | d5f4fc60 | The child-mux heartbeat counts a live rate-limit park as alive (#94) | High (medium) | prior orders Done | Exit State in ticket | extension/src/bin/pipeline-runner.ts, extension/src/bin/mux-runner.ts, extension/tests/pipeline-runner-wedge-iteration-log-mtime.test.js, CLAUDE.md |
| 30 | 5be1391a | An operator cancel ends the pipeline, not just the phase (#91) | High (medium) | prior orders Done | Exit State in ticket | extension/src/bin/cancel.ts, extension/src/bin/pipeline-runner.ts, extension/tests/pipeline-runner.test.js, extension/tests/cancel.test.js |
| 40 | 77ed75d9 | A mux-runner process start resets the circuit breaker (#93, reverses C3) | High (medium) | prior orders Done | Exit State in ticket | extension/src/services/circuit-breaker.ts, extension/src/bin/mux-runner.ts, extension/tests/circuit-breaker.test.js, extension/tests/auto-resume-stop- |
| 50 | a4d9015f | Hardening ticket templates declare zero_diff_intent: audit (#97) | High (medium) | prior orders Done | Exit State in ticket | .claude/commands/pickle-refine-prd.md, extension/src/bin/mux-runner.ts, extension/tests/pickle-refine-prd-failure-mode-checklist.test.js, extension/te |
| 60 | 5ba13039 | A Done stamp needs an attributable commit, never current HEAD (#92) | High (large) | prior orders Done | Exit State in ticket | extension/src/bin/spawn-morty.ts, extension/tests/spawn-morty-commit-attribution.test.js, prds/MASTER_PLAN.md |
| 70 | 845072b7 | The branch scope seed is the union of every ticket's declared files (#89) | High (medium) | prior orders Done | Exit State in ticket | extension/src/bin/pipeline-runner.ts, extension/tests/pipeline-scope-ticket-seed.test.js |
| 80 | 0f95a5db | Claude workers emit no attribution trailer (#90) | High (medium) | prior orders Done | Exit State in ticket | extension/src/services/backend-spawn.ts, extension/src/bin/spawn-morty.ts, extension/tests/backend-spawn.test.js |
| 90 | 49b2d289 | szechuan-sauce changes no observable behaviour without a criterion (#95) | High (small) | prior orders Done | Exit State in ticket | .claude/commands/szechuan-sauce.md, extension/tests/szechuan-sauce.test.js |
| 100 | 6a7a5ab0 | A non-zero pickle exit never reports "completed successfully" (#97) | High (medium) | prior orders Done | Exit State in ticket | extension/src/bin/pipeline-runner.ts, extension/tests/pipeline-finalize-honesty.test.js |
| 110 | c362f86b | A placeholder Open Decisions row is not counted as a decision (#97) | High (medium) | prior orders Done | Exit State in ticket | extension/src/bin/pipeline-runner.ts, extension/tests/pipeline-finalize-honesty.test.js |
| 120 | 8d1ed05c | A Failed status is written only together with its reason (#98) | High (large) | prior orders Done | Exit State in ticket | extension/src/services/git-utils.ts, extension/src/bin/spawn-morty.ts, extension/src/bin/mux-runner.ts, extension/src/bin/pipeline-runner.ts, extensio |
| 130 | 83a7df0b | Wire: integrate B-FIELD-95 changes end to end | High (medium) | prior orders Done | Exit State in ticket | extension/src/bin/pipeline-runner.ts, extension/tests/pipeline-runner.test.js |
| 140 | aaaf6740 | Harden: code quality review of B-FIELD-95 | High (large) | prior orders Done | Exit State in ticket | extension/src/bin/pipeline-runner.ts, extension/src/bin/mux-runner.ts, extension/src/bin/cancel.ts, extension/src/services/circuit-breaker.ts, extensi |
| 150 | a8f3128f | Audit: data flow integrity for B-FIELD-95 | High (large) | prior orders Done | Exit State in ticket | extension/src/bin/pipeline-runner.ts, extension/src/bin/mux-runner.ts, extension/src/bin/cancel.ts, extension/src/services/circuit-breaker.ts, extensi |
| 160 | 42338526 | Harden: test quality review of B-FIELD-95 | High (large) | prior orders Done | Exit State in ticket | extension/tests/runner-authored-trailer.test.js, extension/tests/pipeline-runner-wedge-iteration-log-mtime.test.js, extension/tests/pipeline-runner.te |
| 170 | 49ab4ffb | Audit: cross-reference consistency for B-FIELD-95 | High (medium) | prior orders Done | Exit State in ticket | prds/MASTER_PLAN.md, CLAUDE.md, extension/src/services/CLAUDE.md, .claude/commands/pickle-refine-prd.md, .claude/commands/szechuan-sauce.md, extension |
