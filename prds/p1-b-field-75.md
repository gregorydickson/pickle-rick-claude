# B-FIELD-75 — field issues #75, #72, #74, #71, #69, #68 (+ the #70 README note), as operator-decided (`main`)

No-refine fix bundle. Read at local `main@0a2d9299` in a detached throwaway worktree, with `node_modules` borrowed by
symlink and `./node_modules/.bin/tsc` run first. Every probe below ran against that tree's compiled JS. Nothing was
edited in the main checkout. Measured 2026-10-04 (TZ=UTC, Node 24.19.0). Each claim is MEASURED (with its command
or fixture) or marked HYPOTHESIS. Issue texts are already sanitized; this PRD carries no client data.

**Invariants kept.**
- Gate legs: 22 → 22. No new gate leg, halt, `exit_reason`, verdict input or classifier.
- The pipeline never stops for any item here. Every item is a disclosure, a park that resumes, or a prompt change.
- Two items withhold the success verdict; both reuse `computePipelineVerdict`'s existing `unsuccessful` term.

## Operator decisions (2026-10-04, quoted; binding for this bundle)

> - **#75:** the pipeline never stops for an open decision. Read the refined PRD's `## Open Decisions` table, the one
>   B-MEGA C2 writes. Print the open rows at run start and in the final report. While any row is still `open`,
>   WITHHOLD the success verdict, reusing an existing withhold path; the CLAUDE.md "continuing is not claiming
>   success" rule. The build proceeds on the analysts' recommended default.
> - **#72:** PAUSE on usage-limit WARNINGS. Treat a rate-limit warning event like a rejection by reusing the existing
>   rate-limit park and resume (`runMainLoopRateLimitPark` / `runRateLimitWaitLoop`); determine from the code and the
>   issue what a "warning crossing" looks like in the stream. FIRST write a `main()`/runner fixture for the far-off
>   reset case: a weekly reset beyond the 360-minute `max_park_minutes` cap. Measure whether, after park exhaustion,
>   a later review phase reads an empty or failed run as a clean pass (false convergence). If it does, the fix keeps
>   the run parked until a KNOWN reset time instead of exhausting. If it does not, record that and leave the
>   exhaustion behaviour alone.
> - **#74:** route the stale-anchor check (`spawn-refinement-team.ts` ~:515) through the existing
>   `resolveTrackedSuffixMatches` (~:633) and delete the root-only path, leaving one resolver. While in that file,
>   reword the code comment near ~:601 that names a client repository; make it generic.
> - **#71:** add parent ancestry to the existing end-of-run base-drift report line (`reportBaseDrift`,
>   `pipeline-runner.ts` ~:2415): is the pinned `start_commit` still an ancestor of the parent or base ref?
>   Disclosure only. No auto-restack (operator: autonomy extends by self-checking the base, not by mutating other
>   branches).
> - **#69:** prompt-only. The anatomy-park sibling sweep (`.claude/commands/anatomy-park.md` ~:422) currently fires
>   only for CRITICAL `pattern` findings. Make it fire for every fix and fix same-lane siblings in the same commit.
> - **#68:** an OPT-IN per-phase backend override in `pipeline.json`, e.g. `phase_backends: { "anatomy-park":
>   "codex" }`, default absent, meaning today's behaviour. Reuse the existing backend resolution; add a
>   "reviewed by: <backend per phase>" line to the final report. Update the README per the Documentation Rule.
> - **README note (#70 decision):** document that post-build review-and-fix on an existing branch is `/anatomy-park`
>   + `/szechuan-sauce` with `--scope branch`. Pickle stays build-only.

Two places where the measured code forced a narrower or more precise mechanic than the quoted text are named in
their sections (#71 pinned sha, #72 probe). Neither adds a state, gate or halt.

## #72 — the far-off-reset measurement (done FIRST, per the decision)

Fixtures: scratch drivers over the compiled worktree JS, with `PICKLE_DATA_ROOT` redirected, an injected clock and a
probe stub that always answers `limited`. The weekly reset was set 5 days out (7,200 min, 20× the 360-min cap).

| # | Driver | Input | MEASURED outcome |
|---|---|---|---|
| M1 | `runMainLoopRateLimitPark` (pickle phase) | `rejected`, `seven_day`, `resetsAt` = now + 5 d, no prior ledger | `kind: resume` after **5.00 days**; 655 probes; ledger folded to 7,205 min; no `exit_reason`. The pickle park already waits to the KNOWN reset: `resolveParkResumeTime` targets `resetsAt`, and the 360-min clamp only sizes the logged `waitMs`. |
| M1b | same, right after M1's wake | a second `rejected` | `kind: exit`, `rate_limit_exhausted` (ledger 7,205 > 360). A clean iteration clears the ledger (`mux-runner.ts` ~:14024), so this fires only when the reset did not actually lift. |
| M2 | microverse `handleRateLimitExit` (review phases) | same weekly rejection, twice | first: `continue` after **363 min** (clamped to the cap); second: `rate_limit_exhausted`, disposition `{reportAs: failure, exitCode: 1}`. Review phases do exhaust on a weekly reset. |
| M3 | `pipeline-runner main()`, phases `anatomy-park,szechuan-sauce`, both runners leave `exit_reason: rate_limit_exhausted` and exit 1, finalize-gate stub exits **0** (worst case: the unchanged tree passes its gates) | — | exit **1**, `pipeline-status.json` `status: failed`, `phase_dispositions` = `rate_limit_exhausted` on both phases, log `finalize-gate passed after rate_limit_exhausted — phase degraded, run cannot report success` ×2, `completed successfully` ×**0**. |
| M3 control | same, runners exit 0 with `converged` | — | exit 0, `status: completed`, `completed successfully` ×2. The fixture discriminates. |

A rejected worker stream classifies `api_limit` (`classifyIterationExit` on a `rejected` `seven_day` line), so an
exhausted review iteration never reaches the clean-pass logic. **Result: NO false convergence.** After exhaustion a
review phase reads as degraded and the run withholds success. Per the decision, **the exhaustion behaviour is left
alone.** The M1/M2/M3 fixtures ship as regression controls (ticket F75-B), and the M2 asymmetry is recorded below
under Record-only.

## Mechanism

### #75 — the Open Decisions table is written and never read

B-MEGA C2 makes both synthesis surfaces write `## Open Decisions` (`.claude/commands/pickle-refine-prd.md:188`,
`.claude/workflows/refine-analyze.js:236`), columns `decision, options, owner`. `grep -c "Open Decisions"
extension/src/bin/pipeline-runner.ts` → **0**. The only refined-PRD table the runner parses is `## Premises`
(`buildDependencyLens`, ~:3449, section split at ~:3454). The table has no status column and no default column, so
"still open" and "the recommended default" cannot be read from it today.

MEASURED (`main()` fixture, `prd_refined.md` with one undecided row, both review phases `converged`): exit **0**,
`status: completed`, **0** log lines naming an open decision.

### #72 — a usage-limit warning is invisible to the runner

`detectRateLimitInLog` (`mux-runner.ts` ~:4055) sets `limited` only for `status === 'rejected'`, and only within the
last 100 lines (`lines.slice(-100)`). A warning crossing in the stream is a line of this shape (issue #72's evidence;
0 occurrences in the local corpus, which never crossed):

`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"five_hour"|"seven_day","resetsAt":<epoch s>,"utilization":<0..1>}}`

- MEASURED: `classifyIterationExit('continue', <log with that line>)` → `{ type: 'success' }`.
- MEASURED (184 local `tmux_iteration_*.log` files that carry a `rate_limit_event`): in **19** the LAST event sits
  more than 100 lines from the end, and 102 carry more than one event. A warning there is invisible even after the
  status predicate is widened, so the tail window must go too.
- Both re-probes answer `cleared` whenever the API serves (`served = true` → `'cleared'`, `mux-runner.ts` ~:9834 and
  `microverse-runner.ts` ~:3596). Under a warning the API still serves by definition, so a warning-entered park would
  release at its first probe (10 min), re-hit the warning, and spend one iteration per 10 min until the ledger
  exhausts. The probe carries no information during a warning.

### #74 — two citation resolvers in one file, one of them root-anchored

`findStaleAnchorWarnings` (~:515) reads `git show HEAD:<path>` via `readHeadFile` (~:489), which is repo-root
anchored. `checkAnalystOutputPaths` (~:691) in the same file resolves through `resolveTrackedSuffixMatches` (~:633),
whose own comment (~:598) says it deleted root-anchoring on purpose. That comment names a client repository.

MEASURED (repo with `packages/pkg/src/modules/foo/bar.ts`, 3 lines; PRD cites `modules/foo/bar.ts:3` and
`modules/foo/bar.ts:9`): `[[":3","missing-file"],[":9","missing-file"]]`. The in-range citation is a false alarm,
and the out-of-range one is misreported as missing.

### #71 — the drift line measures the wrong base and never asks about ancestry

`reportBaseDrift` (~:2415) resolves its base with `resolveSetupScopeBaseRef(repoRoot)` and no scope base, so a stacked
child is compared with `origin/HEAD`, not its parent. It asks only "does a merge conflict".

MEASURED (origin with `main`; `parent` = main + p1; `child` = parent + one pre-launch PRD commit; `scope.json`
`base_ref: origin/parent`, `base_sha` = merge-base at launch; `state.start_commit` = child HEAD at launch):

| parent restacked? | today's line | `base_sha` ancestor of `origin/parent`? | `start_commit` ancestor of `origin/parent`? |
|---|---|---|---|
| no | `base drift: clean (origin/main)` | **true** | **false** (a false alarm) |
| yes (rebased onto a new main commit, force-pushed) | `base drift: clean (origin/main)` | **false** | false |

**Refinement of the quoted mechanic (measured):** `start_commit` is the child's HEAD at launch. Any child with a
commit of its own before launch (the PRD commit is the normal case) is never an ancestor of its parent, so testing
`start_commit` reads "not on parent" on a healthy stack. The sha the session actually pinned from the parent is
`scope.json.base_sha` (branch mode: the merge-base with the parent ref at launch). The line therefore tests
`scope.json.base_sha`, falling back to `state.start_commit` only when no branch scope was pinned. That is the
operator's "pinned" sha, read from the record that holds it.

### #69 — the sibling sweep's trigger excludes the findings that need it

PHASE 2.5 (`.claude/commands/anatomy-park.md` ~:422) runs only "For every Phase 2 finding with `severity: CRITICAL`
AND `category: pattern`", and it *emits* replay matches as findings for later iterations instead of fixing them.
MEASURED: that trigger clause appears **1** time inside the PHASE 2.5 section.

### #68 — the backend is pipeline-wide

`runtime.backend` is resolved once (`resolvePipelineBackend`, ~:5225) and every phase spawns with `runtime.phaseEnv`
and restamps `state.backend` from it (`preparePhaseState`, ~:4997). MEASURED (`main()` fixture with
`pipeline.json` `phase_backends: {"anatomy-park":"codex"}`): both microverse spawns carry `PICKLE_BACKEND=claude`, and
**0** `reviewed by` lines are logged. `grep -c phase_backends` → 0 in `pipeline-runner.ts`, 0 in `README.md`.

## Fix

### F75-A (#75) — read, disclose, withhold
1. **Prompt (both synthesis surfaces):** the `## Open Decisions` columns become `decision, options, default, owner,
   status`. `default` is the option the build proceeds on. `status` is `open` until a quoted human decision is
   recorded, then `decided: <quote>`. The existing `none` row and the needs-human sentence stay.
2. **Reader:** one helper that splits `prd_refined.md` into `## `-sections and returns a named table's data rows.
   `buildDependencyLens` is refactored onto it, so Premises and Open Decisions share one section reader instead of
   two. `readOpenDecisions(sessionDir)` returns rows whose first cell is not `none` and that are not settled. A row
   is settled only when the table has a `status` column and that cell starts with `decided`. Every other row is open,
   which includes every row of a pre-F75 table without a status column. A missing file or section yields `[]`.
3. **Disclosure:** `open decisions: <n>` plus one `- <decision> (default: <x>, owner: <y>)` line per open row, logged
   once at run start (in `main()`, after `seedResumePhaseCounters`) and once in `writeFinalPipelineActivity`. With 0
   open rows it logs `open decisions: 0`.
4. **Withhold:** `computePipelineVerdict` adds `openDecisions > 0` to `unsuccessful`, beside `doneOverRed`. That is
   the existing withhold term: banner, `pipeline-status.json` `failed`, exit 1, closer-release skipped,
   `exit_reason` stays `completed` (R-NOPOSTTIER). No phase stops.

### F75-B (#72) — pause on warnings through the existing park
1. **One detector rule:** `detectRateLimitInLog` scans the whole log (the `slice(-100)` window is deleted). The
   LAST `rate_limit_event` decides, and `limited` is true when its status is `rejected` or `allowed_warning`.
   `RateLimitInfo` gains `status?: string`, copied from that event. `sawEvents` keeps its meaning. A later `allowed`
   event therefore clears an earlier crossing in the same stream.
2. **No probe during a warning:** a park whose `rateLimitInfo.status` is `allowed_warning` does not re-probe. It
   sleeps to its target:
   - in `runMainLoopRateLimitPark`, that target is `resolveParkResumeTime`, the known `resetsAt` plus jitter;
   - in microverse `runRateLimitWaitLoop`, it is the existing clamped `waitEnd`.

   One exported predicate (`isUsageWarning(info)`) serves both runners.
3. Everything else is the existing B-RRH park: arm, ledger fold, `rate_limit_wait.json`, cancel, `--resume` re-arm,
   B3 wall exclusion. The microverse exhaustion on a weekly reset (M2) is **left alone** per the decision, since M3
   measured no false convergence.

### F75-C (#74) — one resolver
1. Extract one citation classifier used by BOTH `findStaleAnchorWarnings` and `checkAnalystOutputPaths`. It takes
   `(workingDir, citedPath, line?)` and returns 0 matches → missing, >1 → ambiguous, or 1 → line-range check against
   that file, read as `checkAnalystOutputPaths` reads it today, through `countContentLines`.
2. `StaleAnchorWarning.reason` gains `'ambiguous'`. `readHeadFile` and its root-anchored `git show HEAD:<path>` are
   deleted, along with `execFileSync` if it becomes unused.
3. Reword the ~:598–602 comment: "the refined repo is arbitrary", with no repository names.
4. Update `extension/src/bin/CLAUDE.md` entries that name `readHeadFile` in backticks. A backticked dead symbol
   re-creates a phantom for the trap-door audit.

### F75-D (#71) — ancestry on the existing drift line
1. `reportBaseDrift` reads `<session>/scope.json` (`base_ref`, `base_sha`) and `state.start_commit`. Base ref =
   `resolveSetupScopeBaseRef(repoRoot, scope.base_ref ?? undefined)`, so a branch scope's parent ref now drives the
   conflict check too, and an unscoped run is unchanged. Pinned sha = `scope.base_sha ?? state.start_commit`.
2. The SAME line gains a suffix computed against the same comparand (`FETCH_HEAD` or the stale local ref):
   `; ancestry: <sha7> on <label>` (exit 0), `; ancestry: <sha7> NOT on <label> (base rewritten?)` (exit 1), or
   `; ancestry: unmeasured (<why>)`. Disclosure only: never throws, never changes the exit code, never fetches more
   than today, never restacks.

### F75-E (#68 + #70 README) — opt-in per-phase backend
1. `parsePipelineConfig` reads `phase_backends`: an object whose keys are phase names and whose values pass
   `isBackend`. Invalid entries are dropped. Absent means `{}`.
2. `runPhaseIteration` builds a phase runtime: when `phase_backends[phase]` differs from `runtime.backend`, it is
   `{ ...runtime, backend, phaseEnv: { ...process.env, ...backendEnvOverrides(backend) } }`; otherwise it is the
   SAME object, so default behaviour is byte-identical. Everything downstream (`logPhaseStart`, `preparePhaseState`
   restamp, phase spawns, lanes, units) already reads `runtime.backend` / `runtime.phaseEnv`. After an overridden
   phase returns or throws, `state.backend` is restamped to `runtime.backend`, so the next phase and a `--resume`
   read the pipeline backend.
3. `writeFinalPipelineActivity` logs one line: `reviewed by: <phase>=<backend>, …` for every configured phase except
   `pickle`, derived from config plus `runtime.backend`.
4. README: document `phase_backends` beside the other `pipeline.json` knobs (~:210–214), and add the review-only
   route: post-build review-and-fix on an existing branch is `/anatomy-park` then `/szechuan-sauce` with
   `--scope branch --scope-base <parent>` (optionally `--backend codex`). Pickle stays build-only.

### F75-F (#69) — sweep every fix, fix in-lane siblings
PHASE 2.5's trigger becomes **every Phase 2 fix**. A match in the same lane (the current subsystem scope) is fixed in
the same commit, with one regression test per sibling and a `pattern_shape` naming the principle. Only matches outside
the lane are emitted as `phase: "replay"` findings. The existing metadata tokens stay, and no new schema field is
added (`pattern_shape` already is the principle field).

## Acceptance criteria (measured at `0a2d9299`)

Each ticket carries its own executable ACs with today's measured value. **Test-count instrument (measured):** a
bare `node --test --test-name-pattern=<p> <files>` reports each FILE as one passing test when nothing matches, so
`# tests >= 1` passes before any F75 test exists (measured: 1–3 per row at HEAD, a fake-green). Every "F75-<KEY>-"
row below therefore counts NAMED results:
`node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern="F75-<KEY>-" <files> 2>&1 | grep -cE "^ *ok [0-9]+ - F75-<KEY>-"`
must be ≥ 1, and the same pipe through `grep -cE "^ *not ok [0-9]+ - "` must be 0. Positive control, measured: the
pattern `detectRateLimitInLog: returns limited=false for allowed_warning` on `tests/rate-limit.test.js` gives ok=1.
Summary ("≥ 1 named" = the instrument above):

| AC | Ticket | Predicate | Today |
|---|---|---|---|
| A-1 | F75-A | `node --test --test-name-pattern="F75-OPENDEC-" tests/pipeline-runner.test.js tests/refine-analyze-workflow.test.js` ≥ 1 named, 0 not-ok | 0 named |
| A-2 | F75-A | `grep -c "decision, options, default, owner, status"` on both prompt surfaces | 0, 0 |
| B-1 | F75-B | `node --test --test-name-pattern="F75-RLWARN-" tests/rate-limit.test.js tests/mux-runner.test.js tests/microverse.test.js` ≥ 1 named, 0 not-ok | 0 named |
| B-2 | F75-B | `node --test --test-name-pattern="F75-RLFAR-" tests/pipeline-runner.test.js tests/mux-runner.test.js tests/microverse.test.js` ≥ 3 named, 0 not-ok (regression controls: M1, M2, M3 as tests) | 0 named |
| B-3 | F75-B | `grep -c "slice(-100)" src/bin/mux-runner.ts` = 0 | 1 |
| C-1 | F75-C | `node --test --test-name-pattern="F75-ANCHOR-" tests/spawn-refinement-team-checker.test.js` ≥ 1 named, 0 not-ok | 0 named |
| C-2 | F75-C | `grep -c 'refined (.*, \.\.\.)' src/bin/spawn-refinement-team.ts bin/spawn-refinement-team.js` = 0, 0 (the repository-name list in the comment) | 1, 1 |
| C-3 | F75-C | `grep -c readHeadFile src/bin/spawn-refinement-team.ts src/bin/CLAUDE.md` = 0, 0 | 2, 2 |
| D-1 | F75-D | `node --test --test-name-pattern="F75-ANCESTRY-" tests/pipeline-runner.test.js` ≥ 1 named, 0 not-ok | 0 named |
| E-1 | F75-E | `node --test --test-name-pattern="F75-BACKEND-" tests/pipeline-runner.test.js` ≥ 1 named, 0 not-ok | 0 named |
| E-2 | F75-E | `grep -c phase_backends README.md` ≥ 1; `grep -c "review-only route" README.md` ≥ 1 | 0; 0 |
| F-1 | F75-F | `node --test --test-name-pattern="F75-SWEEP-" tests/skill-prompts/anatomy-park-gate-integration.test.js` ≥ 1 named, 0 not-ok | 0 named |
| F-2 | F75-F | PHASE 2.5 section count of `` severity: CRITICAL` AND `category: pattern `` = 0 | 1 |
| ALL | every | `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/eslint src/ --max-warnings=0` exit 0 | 0 |

Baseline of the files these tickets edit (TAP, `--test-concurrency=1`, at `0a2d9299`): see each ticket's Test
Expectations. Every pre-existing test in them passes today. A ticket may change only the tests it lists as re-pins.

## Simplification Review

| Item | Necessary? | Reuses | Subtracted |
|---|---|---|---|
| F75-A | yes (operator; tier-1 false convergence) | `computePipelineVerdict`'s `unsuccessful`, the Premises section split | a second section parser: Premises and Open Decisions share one |
| F75-B | yes (operator) | the B-RRH park, ledger, resume, probe interval | the `slice(-100)` window (one scan rule, not two); probing during a warning, which cannot inform |
| F75-C | yes | `resolveTrackedSuffixMatches`, `countContentLines` | `readHeadFile`, root-anchoring, one of two citation resolvers, one sync spawn site |
| F75-D | small, disclosure | the drift line's fetch and comparand, `resolveSetupScopeBaseRef` | the hard-wired `origin/HEAD` base for scoped runs |
| F75-E | opt-in feature (operator) | `isBackend`, `backendEnvOverrides`, the runtime object every phase already reads | nothing (feature), but the default path is the identical object |
| F75-F | yes, prompt-only | `pattern_shape`, PHASE 2.5 | the CRITICAL+pattern predicate, the emit-instead-of-fix step for in-lane siblings |

F75-B's status pair (`rejected`, `allowed_warning`) is a two-member set. It is the API's own closed vocabulary, and
the ninth-member risk is bounded: an unknown status reads as not limited, which is today's behaviour. A
"not `allowed`" formulation was rejected because a pinned test asserts an `accepted` event is benign
(`tests/rate-limit.test.js` "structured events present but not rejected").

## Record-only (no code)

- **M2 asymmetry.** The pickle park honours a known far reset (5 days, measured), while the microverse park clamps to
  360 min and then exhausts. M3 shows that exhaustion is reported honestly (`failed`, exit 1, `rate_limit_exhausted`
  dispositions), so per the decision it stays. Revisit trigger: a field run whose review phases exhaust on a weekly
  reset and the operator wants them held.
- **Resume after SIGKILL inside an overridden phase (F75-E).** `state.backend` keeps the override until the restamp
  runs. `resolveBackendWithSource` prefers `state.json`, so a SIGKILLed run resumed without `--backend` continues on
  the override. Graceful signals restamp. `reviewed by:` reports what ran. The next iteration's operator
  `--backend` fixes it.
- **Incidental, not filed:** repository-name strings of the same class remain in other `extension/src` files (measured: 10
  case-insensitive matches in 8 files). That is outside this bundle's decisions.

## Non-goals

- Any new gate leg, halt, `exit_reason`, `decisions_pending` manifest state, `--accept-decisions` flag, or
  `/pickle-status` change (#75's issue-proposed gate is out by decision).
- Usage budgets (`--max-usage-pct`), a `paused_usage_limit` state, and any change to `max_park_minutes` or
  microverse exhaustion (#72).
- Workspace-package enumeration or an "anchor root mismatch" summary line (#74: unnecessary once resolution is
  correct).
- Auto-restack, Graphite PR ownership, and phase-boundary or restart ancestry checks (#71).
- A new `principle` or `siblings_checked` schema field (#69).
- `--anatomy-backend` CLI flags, or spending a second anatomy pass on another model (#68). `--skip-pickle` without a
  PRD, PR-review ingestion, and a convergence end criterion (#70).
- #73 (on-exit hook, status --all): not decided.
