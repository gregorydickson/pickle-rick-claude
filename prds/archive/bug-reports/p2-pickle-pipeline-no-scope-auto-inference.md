# PRD: `/pickle-pipeline` Skill Has No Scope Auto-Inference (Strong Branch/Subset Signals Silently Ignored)

**Status**: Bug PRD (2026-05-08) — skill-level UX/safety gap. `/pickle-pipeline` treats `--scope` as strictly opt-in and emits a scopeless `pipeline.json` whenever the operator omits the flag, even when the kickoff prompt explicitly names a branch or scopes the work to a subset (e.g. "API-only", "no cross-repo PR", "Branch: `<name>`"). The runner then operates on the entire `target` directory until an operator notices and stops the pipeline.
**Author**: Pickle Rick
**Project**: `pickle-rick-claude` — Claude Code extension
**Repo**: `https://github.com/gregorydickson/pickle-rick-claude` — branch `main`
**Sibling of**: `prds/archive/bug-reports/p2-anatomy-park-worker-edits-bypass-scope-allowlist.md` (Open Finding #11) — that PRD addresses **edit-time** scope leaks AFTER scope is set. THIS PRD addresses the **launch-time** gap that lets scope go unset in the first place when the operator's signals strongly imply it.
**Triggering session**: `2026-05-08-33d10614` — `/pickle-pipeline docs/prd-shadow-audit-equivalence-diff.md --skip-refine` for LOA-763 (loanlight-api).

---

## What was missed

Operator kickoff message contained **three** strong scope signals:

1. Named the branch verbatim — `gregory/loa-763-shadow-audit-diff-writer`.
2. Said "Scope: API-only (no loanlight-integrations PR — EPC already publishes everything we need via PR #398)" — explicit scope language.
3. Listed the deliverable surface: "Two prereq migrations + writer service + portal viewer" — bounded subset of a monorepo.

The `/pickle-pipeline` skill nonetheless wrote a scopeless `pipeline.json`:

```json
{
  "phases": ["pickle", "anatomy-park", "szechuan-sauce"],
  "target": "/Users/gregorydickson/loanlight/loanlight-api-main",
  "anatomy_stall_limit": 3,
  "szechuan_stall_limit": 5,
  "anatomy_max_iterations": 100,
  "szechuan_max_iterations": 50
}
```

`scope.json` was never created. `pipeline-runner.js` ran citadel + anatomy-park unscoped against the entire `loanlight-api-main` repo. Anatomy-park self-targeted to `shadow-audit-diff/` only because citadel's findings happened to all live there — pure luck. Szechuan-sauce, which does NOT consume citadel findings, was queued to run unscoped and would have been free to "deslop" any file in `packages/api/`.

The operator caught the gap by asking "is it clearly scoped to this branch?" — at which point `scope.json` did not exist and the pipeline had to be stopped, patched, and restarted. The recovery cost ~2 min wall-clock plus a state-corruption hazard (`worker_timeout_seconds=0` after SIGINT, `step=completed` after the runner mis-classified its own restart) that required manual `state.json` patching.

### Why the operator's expectation was reasonable

Compare to `--refine`: the skill DOES auto-infer refinement from natural-language phrasing via Step 0 rule 3:

```
docs/prd-shadow-audit-equivalence-diff.md --skip-refine matches /\brefine[\s-]?prd\b|\bprd[\s-]?refinement\b|\b(refine|refinement|decompose)\b.{0,40}\b(prd|first)\b|\b(refine|refinement|decompose)\b\s*,?\s*then\s+(build|implement|impl|ship|launch|run|tmux|pipeline)\b/i → REFINE=true
```

So the skill already understands the principle: when the operator's prompt strongly implies a configuration, infer it instead of demanding a literal flag. That principle was applied to `--refine` but not to `--scope`. The asymmetry is the bug.

---

## Root causes (composed)

### RC-1: Step 4 of `/pickle-pipeline` treats `scope` and `scope_base` as strictly literal-flag-only

`extension/.claude/commands/pickle-pipeline.md` Step 4:

> Optional keys — include each ONLY when the corresponding flag was set, and use the literal user-supplied value:
> - `scope` (string) — add when `--scope` was passed
> - `scope_base` (string) — add when `--scope-base` was passed

There is no auto-inference clause analogous to the `--refine` regex in Step 0 rule 3. The skill therefore cannot promote natural-language scope signals into a `scope` key, even when the prompt is explicit.

### RC-2: No safety prompt before launch when scope is omitted but signals are strong

The skill report (Step 8) prints the chosen phases, target, and limits but does NOT surface the resolved scope or its absence. Operators who don't think to ask about scope have no chance to catch it before the runner spawns.

A pre-launch safety check — "the prompt mentions a branch / subset but `--scope` was not passed; choose: lock to branch / lock to a subset / proceed unscoped" — would have caught this case in 5 seconds without Step 4 needing to change.

### RC-3: Recovery from a mid-flight scope add is brittle

When the operator opted to add scope mid-flight, the recovery path required:

1. SIGINT to `pipeline-runner.js` — clean enough.
2. Edit `pipeline.json` to add `scope` + `scope_base`.
3. Restart `launch.sh` — but `state.json` had been left with `worker_timeout_seconds: 0` (validator-rejected), `step: "completed"` (caused pickle phase to re-run), `active: false` (caused monitor.js to exit on respawn).
4. Manually patch `state.json` to `{ active: true, step: "anatomy-park", iteration: <prior>, worker_timeout_seconds: 1200, exit_reason: null }`.
5. Manually rewrite `pipeline-status.json` from `{ status: failed, completed_phases: 0 }` to `{ status: running, current_phase: anatomy-park, completed_phases: 0, total_phases: 2 }`.
6. Drop `pickle` from `pipeline.json:phases` (because pickle was already done and re-running it would clobber state).
7. Manually respawn `monitor.js` in pane 0 of the monitor window because the boundary watcher had already fired and would not re-fire until next phase transition.

There is no skill-level "lock scope to branch on a running session" recovery action. Steps 4–7 are operator improvisation.

---

## Severity

**P2** — UX/safety gap, not a pipeline-killer. Concrete harms:

- Anatomy-park ran 5+ iterations on a self-targeted (luck-driven) subsystem. If citadel's findings had spanned the repo, anatomy-park would have wandered.
- Szechuan-sauce was queued to run unscoped. Caught before it started.
- Recovery cost ~2 min wall-clock plus a 6-step manual state patch that a less-experienced operator might not be able to perform.
- No data loss, no commit-leak (this run; the sibling Open Finding #11 covers the edit-time leak class).

Severity climbs to **P1** if combined with: (a) an unscoped szechuan-sauce that touches files outside the operator's mental model (which would land bad commits on the wrong branch), or (b) any operator who launches and detaches without checking `scope.json` (anatomy-park alone on a misclassified subsystem can ship 30+ out-of-scope commits — see RC-2 historical evidence in `p2-anatomy-park-worker-edits-bypass-scope-allowlist.md`).

---

## Acceptance Criteria

### R-PSAI-1: Scope auto-inference clause in Step 0 (or new Step 0.6)

Add a regex-driven scope-inference clause to `/pickle-pipeline` paralleling the `--refine` auto-inference. Pattern fires when the kickoff TASK contains any of:

- `\bbranch\s*[:=]?\s*[A-Za-z0-9._/\-]+\b` — explicit branch name
- `\bon\s+branch\s+[A-Za-z0-9._/\-]+\b`
- `\bscope\s*[:=]?\s*\b(?:api[- ]only|frontend[- ]only|backend[- ]only|<dir>[- ]only)\b`
- `\b(?:no|skip|excluding)\s+(?:cross[- ]repo|other repo|<package>) PR\b`

When matched **and** `--scope` was NOT explicitly passed, the skill MUST:

1. Pause and ask the operator (single AskUserQuestion) to confirm scope: `branch`, `paths:<auto-extracted>`, or `none (proceed unscoped)`.
2. If the operator confirms `branch`, append `--scope branch` (and `--scope-base main` unless overridden) to the resolved args before Step 4.
3. If the operator confirms a paths subset, write a `scope: "paths:<glob,glob,...>"` value into `pipeline.json`.
4. If the operator picks `none`, write a one-line audit log to `mux-runner.log`: `scope-inference: regex matched but operator confirmed unscoped run`.

The auto-inference must NOT silently flip scope on — it must surface the choice. (Distinct from `--refine` because scope has higher blast-radius than refinement.)

### R-PSAI-2: Step 8 report MUST surface the resolved scope

Append to the Step 8 report:

```
Scope: <branch | paths:<list> | unscoped>
       allowed_paths: <N>     ← when scope is set
       refresh: per non-pickle phase  ← when scope is set
```

When scope is unscoped, append a single-line warning under the report: `⚠ scope: unscoped — anatomy-park and szechuan-sauce will operate on the entire target directory.`

### R-PSAI-3: Pre-launch safety prompt when target is a known repo with branch divergence

Before writing `pipeline.json`, the skill MUST check `git -C <target> rev-parse --abbrev-ref HEAD` and `git -C <target> rev-list --count <main-or-default>..HEAD`. When:

- Target is a git repo, AND
- Current branch is NOT `main`/`master`/default, AND
- Branch has ≥1 commit ahead of default, AND
- `--scope` was NOT passed

…the skill MUST surface a single AskUserQuestion: "Target is on branch `<X>` with `<N>` commits ahead of `<default>`. Lock pipeline to branch diff, or proceed unscoped?" with options: `Lock to branch (Recommended)` / `Proceed unscoped (with reason)`.

This is the safety net for operators who didn't include explicit scope language in the kickoff message but ARE on a feature branch.

### R-PSAI-4: Mid-flight scope-lock recovery action

Add a new operator action: `node $HOME/.claude/pickle-rick/extension/bin/lock-scope.js <session-root> --mode branch [--scope-base main]`. The script MUST:

1. Validate the session is paused (no live `pipeline-runner.js` PID in `state.json:pid` or `pipeline-status.json:status === 'failed'/'paused'`).
2. Patch `pipeline.json` with `scope` + `scope_base`.
3. Patch `state.json` to a clean resumable shape: `{ active: true, step: <last-completed-phase + 1 or current>, worker_timeout_seconds: <restored from settings>, exit_reason: null }`.
4. Rewrite `pipeline-status.json` to `{ status: running, current_phase: <next>, completed_phases: <preserved>, total_phases: <pipeline.phases.length> }`.
5. Print the resumed launch command for the operator.

This collapses the 6-step manual patch to a single command. No skill changes required.

### R-PSAI-5: `pickle-utils.ts:ensureMonitorWindow` MUST re-respawn pane 0 on resume

When `ensureMonitorWindow` returns `'exists'` AND `state.json:active === true`, the boundary watcher already fires `restartDeadWatcherPanes`. The bug witnessed in this session: pane 0 (`monitor.js`) self-exited during a transient inactive window AFTER the boundary watcher had already fired, leaving pane 0 as a zsh prompt with no mechanism to recover until the next phase transition.

Fix: extend `startRespawnWatchdog` to also poll pane 0 (it currently polls 1/2/3 by some accounts; verify and harden). Confirmed dead pane 0 with `{ pane_current_command !== 'node' }` MUST be respawned within 30s regardless of phase-transition events.

### R-PSAI-6: Documentation / `PRD_GUIDE.md` update

`PRD_GUIDE.md` and `COMMANDS.md` must document the auto-inference clause + safety prompt + `lock-scope.js` recovery action. Operator-facing doc must call out: "Naming a branch in your kickoff prompt is enough — the skill will ask. Use `--scope branch` to skip the prompt."

### R-PSAI-7: Regression test

`extension/tests/integration/pickle-pipeline-scope-inference.test.js` MUST cover:

- Kickoff containing "Branch: `foo`" → auto-inference fires, prompts operator.
- Kickoff containing "API-only" + path containing `packages/api` → auto-inference fires.
- Kickoff with `--scope` already passed → auto-inference skipped (literal flag wins).
- Kickoff with no scope signals on a default-branch target → no prompt, scopeless run permitted.
- Kickoff on a non-default branch with ≥1 commit ahead and no `--scope` → safety prompt fires per R-PSAI-3.
- Operator picks "unscoped" → audit log line present in `mux-runner.log`.

---

## Trap doors (lock invariants in code)

1. **`extension/.claude/commands/pickle-pipeline.md`** — Step 0.6 (or appended to Step 0) must contain the regex-driven scope-inference clause. ENFORCE-test: `extension/tests/skill-prompt-shape/pickle-pipeline-scope-inference-clause.test.js` greps the deployed skill file for the literal regex tokens and the AskUserQuestion call.
2. **`extension/services/pickle-utils.js::ensureMonitorWindow`** — pane 0 respawn MUST be covered by the in-monitor watchdog, not only by the boundary-driven `restartDeadWatcherPanes`. ENFORCE-test: `extension/tests/integration/monitor-pane-zero-watchdog.test.js` simulates a mid-run pane-0 exit and asserts respawn within 30s.
3. **`extension/bin/lock-scope.js`** (new) — script must refuse to run while a `pipeline-runner.js` PID is alive. ENFORCE-test: `extension/tests/integration/lock-scope-rejects-live-runner.test.js`.

---

## Out of scope (explicit non-goals)

- Edit-time scope enforcement during worker iterations. That's `prds/archive/bug-reports/p2-anatomy-park-worker-edits-bypass-scope-allowlist.md` (Open Finding #11) and the worker preflight there is the right layer for it.
- Discovery-time scope flattening on monorepos. That's `prds/archive/bug-reports/anatomy-park-szechuan-monorepo-missed-detection-gap.md` RC-2.
- Auto-resolving scope without operator confirmation. The blast radius of a wrong scope guess (anatomy-park editing the wrong subsystem for hours) is higher than the cost of a single AskUserQuestion. Always prompt.
- Making `--scope` mandatory by default. Some operators legitimately want repo-wide scope (`/pickle-pipeline` for a fresh repo, no branch divergence). The auto-inference fires only when signals are present.

---

## Session notes

- Recovery walkthrough preserved in this conversation log; operator manually patched state.json + pipeline-status.json + pipeline.json + tmux pane 0 to resume from anatomy-park iter 6 without losing any of the 10 build commits, 5 anatomy-park CRITICAL fixes, or 4 trap-door entries committed earlier in the run.
- `scope.json` resolved correctly on the second start (58 allowed paths, all under the LOA-763 surface area); the bug is purely the absence of auto-inference and the brittleness of the recovery path.
- Anatomy-park's 5 CRITICAL findings (watermark advance on shadow-only error, watermark + LIMIT drops tied rows, URLA field_path missing discriminator, red-flags sort heap-order leak, doc-expiration outer + inner sort heap-order leak) are unrelated to this PRD — they would have surfaced regardless of scope. Scope only changed which subsystems anatomy-park was *allowed* to consider.
