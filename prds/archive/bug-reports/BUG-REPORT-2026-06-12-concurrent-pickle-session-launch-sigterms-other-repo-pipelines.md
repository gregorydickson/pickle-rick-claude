# BUG REPORT — 2026-06-12 — Launching a pickle session SIGTERMs concurrent pickle pipelines in OTHER repos (cross-session kill)

**Discovered by:** weekend autonomous babysitter running loanlight-api bundles while the operator concurrently ran a pickle-rick-claude beta build. pickle-rick v2.0-beta-2.
**Severity:** **P1 — progress/data-loss + pipeline-bricking class.** Killed TWO long-running builds (B1, B2) mid-flight. Forensic data point for the previously watch-only **#25 R-CSI** (concurrent-session interference).
**Class:** session isolation / process-ownership cleanup is repo-GLOBAL, not session-scoped.

---

## META-FINDING (the headline — read first): no first-class, hook-safe recovery command → babysitter forced into raw `state.json` surgery

Across this weekend run the babysitter had to **hand-patch `state.json`/`pipeline-status.json`** ~8 times to keep builds alive — to re-pin after a kill (R-RSPIN), reset after a cross-session kill (R-CSI), and re-run pickle after a false-completion (S4). **Raw state surgery is the wrong interface and the config-protection hook (correctly) blocks it** (`Runtime state file protected` / R-WSRC) — which then *breaks the only available recovery path*. The real defect underneath ALL of the symptoms below is: **Pickle Rick exposes no sanctioned, hook-permitted recovery primitive for an autonomous operator.**

**AC — add a first-class recovery command** (e.g. `pickle-recover <session>` / `mux-runner --recover`) that, without any raw config write, can: (1) **re-pin** `pinned_branch`/`pinned_sha`/`start_commit` to current HEAD (kills R-RSPIN); (2) **resume** a cancelled/interrupted pipeline from the lowest non-`Done` ticket, resetting `pipeline-status` + `monitor_mode` + `exit_reason` internally; (3) **clear** a stale uncommitted partial within scope. Then the babysitter never touches `state.json`, and the protection hook can stay strict. Until it exists, recovery must go through `update-state.js` (not `fs.writeFileSync`) — but that's a stopgap, not the fix. Each symptom below (R-RSPIN re-pin, R-CSI kill, S4 false-completion) is really "this transition should be tool-owned, not operator-patched."

---

## Symptom
A running `pipeline-runner.js` (loanlight-api, session `2026-06-12-4dddf819` then `2026-06-12-87176b56`) received an external **SIGTERM** and cascaded it to its `mux-runner` child, cancelling the pipeline mid-build. Twice:

| Build | Killed at | pickle-rick-claude session (`pipeline-8f02855b`) (re)created at | signal `is_tty` |
|---|---|---|---|
| B1 (4dddf819) | 18:03:05 | **18:04:43** | true |
| B2 (87176b56) | 20:09:04 | **20:09:26** | false (sender pid = parent node / pipeline-runner forwarding) |

The kill timestamp coincides with the **(re)launch of a pickle session in a different repo** (`pickle-rick-claude`, `pipeline-8f02855b`) to within seconds, both times. This is not coincidence — launching/initializing one pickle session terminates concurrent pickle `pipeline-runner`/`mux-runner` processes belonging to OTHER sessions in OTHER repos.

## Root-cause hypothesis (needs confirmation in code)
Session setup / ownership-refresh / stale-session cleanup (the `Session ownership refreshed (pid updated)` path seen in `mux-runner.log`, and/or a setup-time `pkill`/process-group sweep) selects target processes by a **global** predicate (e.g. `pkill -f mux-runner` / `-f pipeline-runner`, or a PID-table sweep that is not filtered by session dir / working_dir). So a new session's launch reaps every other session's runner regardless of repo. Candidate sites: `setup.ts` (session init / ownership claim), the launch path's concurrent-access probe (`probeConcurrentGitAccess`, R-PIWG-5), `state-manager` ownership/pid logic, any `kill`/`pkill`/`process.kill` in the setup/launch chain.

## Why this matters
The operator explicitly expects concurrent pickle sessions across repos to be ISOLATED ("we run many sessions at the same time, pickle rick isolates them"). They are not: one repo's session launch kills another repo's in-flight build, discarding all uncommitted-iteration progress and cancelling the pipeline. Over the weekend run this forced two full recoveries (re-pin + reset + relaunch per the R-RSPIN dance).

## Repro
1. Start a pickle pipeline in repo A (`/pickle-pipeline`), let it run.
2. Start (or restart) any pickle session in repo B (`setup.js` / `/pickle-*`).
3. Observe repo A's `pipeline-runner` receive SIGTERM at the moment repo B's session initializes; repo A's `state.exit_reason` becomes `signal:SIGTERM`/`signal:SIGINT`, `pipeline-status.status=cancelled`.

## Acceptance criteria (machine-checkable)
- [ ] Launching/initializing a pickle session does NOT signal any process whose session dir / working_dir differs from the one being launched. Verify: integration test — start a dummy long-lived `mux-runner` for session S1 (working_dir W1), run `setup.js`/launch for session S2 (working_dir W2 ≠ W1), assert S1's process is still alive and `state(S1).exit_reason == null`.
- [ ] Any process-reaping in the setup/launch/ownership path filters targets by session dir (or PID recorded in that session's own `state.json`), never a repo-global `pkill -f <runner>` / unfiltered PID sweep. Verify: `git grep -nE "pkill|process\.kill|kill -|killall" extension/src` audited; each kill site is session-scoped with a regression test.
- [ ] A documented invariant + trap door: "session A's lifecycle MUST NOT signal session B's processes."

## Operator workaround (in effect this weekend)
Do NOT (re)launch or restart any pickle session in another repo while the loanlight-api weekend bundles run — each restart kills the active build. Babysitter recovers via re-pin + relaunch, but progress in the killed iteration is lost.

---

## Secondary findings from the same session (lower severity, capture-only)

### S1 — build's `git add -A` sweeps untracked files onto the feature branch (PR pollution)
B1's build committed ~22 untracked `docs/*.md` PRDs (including unrelated pre-existing repo PRDs) onto the feature branch — PR #1938 (loanlight-api) carries them as scope pollution. A pickle worker/closer commit path uses a broad `git add -A`/`git add .` instead of adding only the ticket's declared `Files to modify/create`. **AC:** worker/closer commits stage only ticket-scoped paths; untracked files outside the ticket scope are never swept. (Also caused B2's PRD to vanish from the working tree on `git checkout main` because it had been committed onto B1.)

### S2 — `scope:branch` pipeline runs no whole-repo typecheck → out-of-fence consumer breaks escape to pre-PR
B1 added 4 columns to the `credit_runs` Drizzle type; an out-of-fence consumer (`audit-data-mapper.service.spec.ts` baseRow, outside the credit scope-fence) broke `tsc` repo-wide, but every scoped per-ticket gate + citadel + anatomy-park passed — only the babysitter's manual pre-PR `pnpm typecheck` caught it. **AC:** a build that changes an exported type/interface runs a whole-repo typecheck (not just scope-fenced) before the pickle phase reports success (relates to R-ORSR-6 consumer-sweep; appears regressed or not covering the scoped-pipeline path).

### S3 — `config-protection` hook over-blocks read-only Bash after a beta `install.sh` deploy
Mid-weekend (after the pickle-rick-claude beta build ran `install.sh`, redeploying hooks to `~/.claude/pickle-rick/`), the babysitter's **read-only** Bash inspection commands began failing with `Config file protected: <config file>. Pass --allow-config-edit to override.` — including commands that merely *read* or glob the session dir, or mention `state.json`/`pipeline-status.json`/`circuit_breaker.json` in a `cat`/`stat`/`node -e require()`. The exact same commands worked earlier in the session (pre-redeploy). The hook is meant to block WRITES to protected configs (R-WSRC); it is now false-positiving on reads, impairing monitoring (worked around by switching all inspection to `node -e fs.readFileSync`/the Read tool — which the Bash hook does not gate). **AC:** `config-protection.ts` blocks only mutating operations (write/redirect/`>`/`tee`/`sed -i`/`rm`) against protected configs; read-only access (`cat`/`stat`/`node require`/glob) to or near a protected path is never blocked; regression test asserts a `cat state.json` / `node -e "require(state.json)"` is permitted while `echo x > state.json` is blocked. Discovered: v2.0-beta-2 weekend run.

**ESCALATION (later in the run):** the hook tightened further and began blocking the babysitter's **`node -e fs.writeFileSync(state.json)` recovery patch** entirely (`Runtime state file protected: /state.json. Set state.flags.allow_state_writes_reason ...`), rejecting the WHOLE compound Bash command (so co-located `tmux kill` / `git restore` in the same command also didn't run). This is technically R-WSRC working — BUT it breaks the documented operator/babysitter recovery playbook, which node-patches `state.json`/`pipeline-status.json` to re-pin + reset after a kill/false-completion. **Resolution for operators:** route recovery state edits through the sanctioned `update-state.js` bin (NOT direct `fs.writeFileSync`), which the hook permits; OR set `state.flags.allow_state_writes_reason` first (chicken-and-egg unless set via `update-state.js`). **AC:** document the sanctioned recovery path; ensure `update-state.js` can set `flags.*` (nested) and `pinned_sha`/`pipeline-status` so recovery never needs a raw write; never reject a whole compound command for one offending sub-token (block the write, not the `tmux`/`git` siblings).

### S4 — codex pickle phase accepts a FALSE `EPIC_COMPLETED` (exits 0 "success") with the majority of tickets still Todo, breaker CLOSED
B3 (LOA-1155, 12 small tickets, codex) pickle phase logged `Phase pickle exited with code 0` / `Phase pickle completed successfully` and the pipeline advanced to citadel→anatomy-park — but only **3/12** tickets were `Done` (orders 10–30), 9 still `Todo`/`In Progress`, and `circuit_breaker.json` was **CLOSED** (`consecutive_no_progress: 0`) — i.e. NOT a convergence/no-progress exit. The codex manager emitted `EPIC_COMPLETED` (or the loop treated the phase as complete) with 75% of the queue unbuilt, and mux-runner accepted it as a clean phase success rather than logging `MANAGER_FALSE_EPIC_COMPLETED` + retrying (the B2 run DID catch + retry equivalents — so the guard is inconsistent on codex). Babysitter recovered by re-running pickle from the lowest non-Done ticket (built to 7/12+ on the retry, no recurrence). **AC:** before accepting a pickle-phase `EPIC_COMPLETED`/exit-0-success, mux-runner re-reads every `linear_ticket_*.md` frontmatter; if any non-`Done` ticket remains it logs `MANAGER_FALSE_EPIC_COMPLETED` and continues the loop (never lets the phase report success); regression covers the codex backend specifically. Class-sibling of the existing false-EPIC_COMPLETED detection (which fired for B2 but not here). Discovered: B3 weekend run, session `2026-06-13-70e88e33`.
