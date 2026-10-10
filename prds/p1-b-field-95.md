---
title: "B-FIELD-95 — field issues #89–#98 + the B-FIELD-88 gate reds: park-aware hang detection, cancel stops the pipeline, breaker resets on relaunch, Done needs evidence, branch fence from the branch, no attribution trailers, cleanup changes no behaviour"
status: draft
priority: P1
type: bug-bundle
branch: main
composes: ["#89", "#90", "#91", "#92", "#93", "#94", "#95", "#96", "#97", "#98"]
---

# B-FIELD-95 (`main`)

Issue texts reach this PRD by number and generic shape only; no client content (public repo).

## Trigger

Issues #89–#95, filed 2026-10-08/09 from client field runs. Three of them (#91, #93, #94) END or SILENTLY
CORRUPT a run — reliability tier, ratchet order first. The rest are quality. Triage in `prds/MASTER_PLAN.md`
QUEUE item 13.

## Invariants

- **No gate leg added.** Legs 22 → 22. New tests live in EXISTING test files; every subprocess in a new test
  case gets `timeout: 30_000`.
- **No new halt or abort condition.** #91 widens an EXISTING crash-floor halt (operator cancel) to the second
  path that already means "operator cancel"; nothing else stops.
- **Reuse before add.** #94 reads the park record `state.json` already carries (`rate_limit_park`); #91 reads the
  exit reason mux-runner already stamps (`cancelled`); #93 resets a counter at process start; #89 is a subtraction.
- `--scope branch --scope-base a0d6ccc2` (the commit BEFORE the #96 cherry-pick `3bc1fbdf`, so #96 is inside the reviewed diff).

## Premises (measured at `a0d6ccc2`, read-only)

| Claim | Tag | Evidence |
|---|---|---|
| The child-mux heartbeat measures liveness from log/state mtime only and SIGTERMs the subtree past `child_mux_runner_stall_seconds` (default 1800) | (verified) | `pipeline-runner.ts:1709-1800` (`resolveChildMuxLivenessMtime`, `armChildMuxRunnerHeartbeat`), `:324` default |
| A parked mux-runner records `rate_limit_park { reset_at_epoch_sec, parked_started_epoch_ms, ... }` in state.json and then writes nothing while it sleeps | (verified) | `mux-runner.ts:9732-9733`; park log `Parking on API reset: ...` `:10064` |
| mux-runner parks on `allowed_warning` as well as `rejected` | (verified) | `mux-runner.ts:4036`, `isUsageWarning` `:4045` |
| `cancel.ts` sets `active=false` only and writes no `pipeline-cancel` marker | (verified) | `grep -c pipeline-cancel bin/cancel.ts` → 0 |
| The pipeline phase loop never reads the session's active/exit fact; only the signal handler's marker cancels | (verified) | `grep -c "state.active" bin/pipeline-runner.ts` → 0; `cancelledOutcome` (issue #91, `:7192`) |
| mux-runner exits `cancelled` on "Session inactive" | (verified, per issue #91) | `mux-runner.ts:15218-15219` (re-verify at breakdown) |
| The circuit breaker loads `consecutive_no_progress` from disk at every start and counts environmental failures as no-progress | (verified) | `circuit-breaker.ts:177-196`; `mux-runner.ts:10223` excludes only `error`/`inactive` |
| `evaluateWorkerOutcome` decides success without reading the worker's verdict; `persistWorkerOutcomeStatus` falls back to HEAD for `completion_commit` | (verified, per issue #92) | `spawn-morty.ts:3427-3443`, `:2884-2885`; `grep -c BLOCKED bin/spawn-morty.ts` → 0 code hits |
| Most worker session logs are empty (B-LOGEV: 35/43 = 81% zero bytes on the one clean recorded run), so a log-token success test fails closed on production | (verified) | `bin/CLAUDE.md` B-LOGEV entry |
| The branch fence is seeded from ONE ticket's declared files; this repo's own B-FIELD-88 run seeded `allowed_paths = 2` for 21 tickets | (verified) | `pipeline-runner.ts:1019-1031` (`resolveSeedPathsForSetup`); `scope.json` of session `2026-10-08-59c0d821` |
| The seeded fence is destructive only on the boundary-commit path (HEAD static + dirty tree); workers that commit themselves never hit it | (verified) | `mux-runner.ts:7446` `preStashOutOfAllowlistResidue`, call `:7548` under Branch 2; 0 salvage refs from B-FIELD-88 despite a 2-path fence |
| `isPathShaped` admits only `/`-paths or a fixed extension list, so root `Dockerfile`/`pnpm-lock.yaml` never enter the fence | (verified) | `services/ticket-declared-files.ts:35-40` |
| Claude workers are spawned with no `--settings`/attribution override; nothing emits, strips or checks `Co-Authored-By` | (verified) | `services/backend-spawn.ts:~825-840`; this box hides it via `includeCoAuthoredBy: false` in `~/.claude/settings.json` (0/39 B-FIELD-88 commits carry it) |
| The szechuan prompt has no rule against behaviour changes or new/changed test expectations | (hypothesis) | grep `szechuan-sauce.md` at breakdown |

## Tickets

### T0 — the B-FIELD-88 release gate's two reds: fixtures that model a Done flip without the tier's artifacts (Tier 1 — blocks the release) — `small`
Release gate run 3 on `a0d6ccc2` (B-FIELD-88): 20/22 legs `LEG_RC 0`; red: `audit-ledger-probes` and `test_integration`.
ONE cause, measured: B-FIELD-88 T5a parks a committed ticket once when its tier's lifecycle artifacts are missing, and
two instruments model a `complexity_tier: small` ticket flipping Done with NO `plan`/`code_review` files.
(1) The R-ORSR-2 PROBE in `prds/MASTER_PLAN.md` (`## OPEN BUG — R-ORSR-2 recovery flips a ticket Done without the
impl landing`) now exits 1 ("FIXED") because the ticket is parked, not because the prose-AC residual closed — with the
two artifacts added to its fixture it exits 0 (OPEN) again (measured). (2) `extension/tests/runner-authored-trailer.test.js`
case `site 1: the completion guard is now satisfiable` (line 136) gets no `result.sha` because the flip is parked —
with the two artifacts written in `makeSession` the file goes 20/1 → 21/0 (measured on a scratch copy).
Fix the FIXTURES (they must model a real small ticket); never loosen T5a.
- AC1: `bash extension/scripts/audit-ledger-probes.sh` exits 0 and reports the R-ORSR-2 probe OPEN (measured exit 1).
- AC2: `node --test extension/tests/runner-authored-trailer.test.js` exits 0 (measured 1 fail).

### T1 — #94: a live rate-limit park is not a hang (Tier 1) — `medium`
`resolveChildMuxLivenessMtime` (or the heartbeat tick) reads `state.rate_limit_park`: while `now <
reset_at_epoch_sec*1000 + grace` the child is LIVE; with no `reset_at`, `parked_started_epoch_ms + max_park_minutes`
bounds it. An expired park with no activity is reaped as before.
- AC1 (fails today): heartbeat with a park whose reset is 2h out and stale log/state → no reap, no
  `child_mux_runner_wedge_detected`. Host: the existing heartbeat test file (locate at breakdown).
- AC2 (control): park expired + grace passed + no activity → reaped.
- AC3 (control): no park, stale past threshold → reaped (unchanged).
- Recorded, not built: parking on `allowed_warning` (a warning, not a rejection — #72 closed). Revisit only with
  a measured case where the warning park costs a run.

### T2 — #91: an operator cancel ends the pipeline, not just the phase (Tier 1) — `medium`
`cancelledOutcome` also honours the cancellation FACT mux-runner already records: after a phase returns, a session
whose `exit_reason` is `cancelled` (the value mux-runner stamps on "Session inactive") takes the same cancel path as
the marker. Operator cancel is an existing crash-floor halt; this widens its detection, it adds no new halt.
- AC1 (fails today): drive `main()` with a pickle phase whose runner exits leaving `exit_reason: 'cancelled'` and
  Todo tickets → citadel/anatomy-park never run, `phases_entered` gains nothing new, run reports cancelled.
- AC2 (control): a normal pickle completion (`exit_reason: completed`) still advances.
- Research must confirm `active=false` alone is NOT the signal (normal completion also deactivates).

### T3 — #93: a relaunch starts the no-progress count fresh (Tier 1) — `small`
At mux-runner start, `initCircuitBreaker` keeps the breaker file but zeroes `consecutive_no_progress` (a relaunch
is a new run; the breaker bounds one run's spinning). No environmental-error classification.
- AC1 (fails today): a breaker file at `consecutive_no_progress: 5` (OPEN) → a fresh start does not trip on its
  first iteration.
- AC2: within one run, the breaker still trips at its budget.
- Rejected: an enumerated list of environmental failure kinds (quota/auth/model/rate-limit).
- Check the B-RRH park and `auto-resume.sh` caps still bound a loop of relaunches (they do by reading; confirm).

### T4 — #92: Done requires completion evidence, not process exit plus a log (Tier 2) — `large`
`persistWorkerOutcomeStatus` must not stamp Done with a `completion_commit` that is merely current HEAD when no
commit in the worker's window is attributable to this ticket; such a ticket stays In Progress and mux-runner's
guard (`guardCompletionCommitBeforeDone`) decides. A BLOCKED verdict from the worker's stdout (the same stream the
completion-ack listener already reads) maps to non-Done.
- **Census first (required-field risk):** over the live session corpus, how many Done tickets were flipped by
  spawn-morty with a HEAD-fallback sha vs a verified window sha? If most production Done flips rely on the fallback,
  this ticket must route them to the guard rather than refuse them.
- Rejected: requiring the done-promise token in the worker LOG (81% of logs are empty — fails closed on production).

### T5 — #89: the branch fence comes from the branch, never one ticket (Tier 2) — `medium`
Subtraction preferred: in branch mode with an empty pre-build diff, do NOT seed a strict pickle-phase fence from
declared files (per-ticket ownership is `check-scope-diff`'s job); the review phases already refresh scope from the
real diff. If refinement shows a seeded fence is still needed, seed it from EVERY ticket's declared files resolved
against `git ls-files` (no extension list).
- AC1 (fails today): a multi-ticket session with an empty pre-build branch diff → `scope.json` does not restrict
  the pickle phase to one ticket's files (today: 2 paths for 21 tickets).
- AC2: a ticket's boundary-commit of in-ticket work outside the first ticket's files is committed, not stashed.
- Rejected: adding extensions to `isPathShaped` (enumerated set).

### T6 — #90: workers do not emit attribution trailers (Tier 2) — `small`
Claude worker spawns pass a settings override disabling the co-author trailer (verify the current Claude Code
setting name at research — `includeCoAuthoredBy` vs `attribution` — against `claude --help` and the docs), plus one
worker-prompt line: no attribution trailers.
- AC1: the built claude invocation carries the override (spawn-arg test in the existing backend-spawn test file).
- Rejected: a hook/post-commit deny list (enumerated set + new check). Repo opt-in deferred until asked.

### T7 — #95: a cleanup phase changes no observable behaviour (Tier 2) — `small`
`szechuan-sauce.md`: a cleanup may restructure, never change observable behaviour (new refusals, newly accepted
inputs, changed outputs) unless an acceptance criterion names it; a change that ADDS or CHANGES a test expectation
is recorded as an open finding, not committed.
- AC1: `grep -c "observable behaviour" .claude/commands/szechuan-sauce.md` ≥ 1 (measure 0 at HEAD first).
- Rejected: the runtime test-expectation diff guard (new mechanism; revisit if the prompt rule fails in the field).

## Simplification Review

| Ticket | Necessary? | Reuse | Brittle complexity guarded? | Subtraction |
|---|---|---|---|---|
| T1 | Yes — kills runs | existing `rate_limit_park` record | the mtime-only liveness proxy | none |
| T2 | Yes — skips tickets | existing `cancelled` exit reason + cancel path | two cancel signals, one honoured | collapse to one fact |
| T3 | Yes — relaunch halts in 1s | existing breaker file | — | none |
| T4 | Yes — false Done | existing mux guard | HEAD-fallback sha | **delete** the HEAD fallback as Done evidence |
| T5 | Yes — work stashed off-branch | `check-scope-diff`, scope refresh | one-ticket seed + extension list | **delete** the seed (preferred) |
| T6 | Yes | spawn args | — | none |
| T7 | Yes | szechuan prompt | — | none |

## Open Decisions

| decision | options | default | owner | status |
|---|---|---|---|---|
| none | | | | |

## Added 2026-10-10 — #97, #98

### T8 — #97: audit and verification tickets declare their zero-diff intent (Tier 1 — a correct no-op audit trips the breaker) — `small`
The four hardening ticket templates in `.claude/commands/pickle-refine-prd.md` Step 7e carry `zero_diff_intent: audit`
in frontmatter (the value already exists: `ZeroDiffIntent = 'verification' | 'audit' | 'already-satisfied'`,
`services/ticket-completion-evidence.ts:834`). Committed evidence still wins when a hardening ticket does commit — the
zero-diff arm is reached only after every attribution path comes up empty. Reword the Done-flip fatal so it points at
`zero_diff_intent`, not at pasting a sha into frontmatter.
- AC1: `grep -c "zero_diff_intent: audit" .claude/commands/pickle-refine-prd.md` ≥ 4 (measured 0).
- AC2 (fails today): a medium audit ticket with `zero_diff_intent: audit`, its tier's artifacts and a green gate, no
  commit → `guardCompletionCommitBeforeDone` accepts (pin in the existing zero-diff test file); the same ticket
  without the declaration is refused (control).
- AC3: the fatal text no longer instructs `completion_commit: <sha>` (grep, measure first).
- Recorded: the borrowed-HEAD stamp in the field case was the manager's, after the loop; the R-OMA foreign-attribution
  rejection already exists (since `7f2d53c6`, in v2.2.1) and would have reverted it on the next watcher pass. T8
  removes the loop that led there.

### T9 — #97: a phase that ended non-zero on a recorded cause is never "completed successfully" (Tier 2, reporting) — `small`
When the pickle runner exits non-zero with a recorded `exit_reason` (e.g. `circuit_open`), "all tickets accounted
for" may clear a stale incomplete stamp but must not produce `Phase pickle completed successfully`: the phase is
reported with its cause and the run withholds the success verdict (`nonConvergent`/disposition). Continues, never halts.
- AC1 (fails today): pickle runner exits 1 with `exit_reason: circuit_open` and every ticket Done → log does not
  print `completed successfully`; `computePipelineVerdict` reports unsuccessful; the next phase still runs.
- AC2 (control): exit 0 with all tickets Done → unchanged.

### T10 — #97: a placeholder Open Decisions row is not a decision (Tier 2) — `small`
`readOpenDecisions` (`pipeline-runner.ts:3768`) drops placeholder rows whose first cell STARTS with `none`
(`none`, `none open`, `None.`), not only the exact word.
- AC1 (fails today): a refined PRD whose only row is `none open` → `open decisions: 0`.
- Deferred, recorded: carrying a worker-raised "for you to decide" question into the end-of-run report needs a new
  worker→report channel; revisit with a design that reuses an existing artifact rather than a new field.

### T11 — #98: a Failed status is written only with its reason (Tier 2) — `medium`
One `markTicketFailed(ticketId, sessionDir, { reason, evidenceLog? })` writes `status`, `failed_reason` and the
evidence path in one frontmatter update; all six Failed writers route through it, each passing the cause it already
knows (head regression, worker outcome, worker hang, spawn error, no-progress, anatomy failure). When the worker log
matches the EXISTING rate/usage-limit detector, the reason is that environmental class (ties to #93's environmental stops).
- AC1: a widened case in the EXISTING completion-authority single-source test: no `status: 'Failed'` /
  `'Failed'` status write in `src/` outside `markTicketFailed` (mutation: add a bare write → red).
- AC2 (fails today): each of the four reason-less writers, driven to fail, leaves a non-empty `failed_reason`;
  `reportSkippedFailedTickets` prints it instead of `no reason recorded`.
- Rejected: a new classifier of worker-log causes beyond the existing rate-limit detector.

## #96 — landed by cherry-pick, not a ticket (operator decision 2026-10-10: "Cherry-pick into B-FIELD-95")
`f60be7b8` (branch `fix/codex-companion-resolver`) is cherry-picked onto `main` BEFORE this bundle's scope base, so
its resolver, test and command edits sit inside this bundle's reviewed diff: set `--scope-base` to the commit BEFORE
the cherry-pick. The remote branch is deleted after the bundle ships (operator-approved with this decision).
