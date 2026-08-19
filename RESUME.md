# RESUME — paused 2026-08-19 for a machine reboot

Operator paused the live P0 bundle to reboot the box. Nothing failed; this is a clean pause.
Delete this file once the run is back on its feet.

## What was running

| field | value |
|---|---|
| session | `2026-08-19-f048dbc4` |
| SESSION_ROOT | `/Users/gregorydickson/.local/share/pickle-rick/sessions/2026-08-19-f048dbc4` |
| tmux | `pickle-f048dbc4` (killed) |
| PRD | `prds/BUG-2026-08-19-mux-runner-halts-on-done-without-commit-evidence.md` |
| branch | `release/v2.1-beta` |
| HEAD at pause | `021201f0` |
| iteration | 4 of 100 |
| current_ticket | `96444430` |

Ticket roster at pause:

| ticket | order | status | note |
|---|---|---|---|
| `96444430` | 10 | **In Progress** | park-and-continue fix; landed `0383103d`, then RE-OPENED for a 2-line correction (uncommitted) |
| `573a1daa` | 20 | Done | landed `fa88b4e1` (AC-4 + AC-5 pins) and `021201f0` |
| `29077ab4` | 30 | Todo | verification: run all three tiers at the final sha and commit the recorded evidence |

## State at pause

- `active: false`, `step: "research"`, `exit_reason: "signal:SIGINT"` — that reason is from the
  operator's pause `kill -TERM`, **not** a real halt. It must be cleared before resuming or it will be
  read as a terminal disposition.
- `completion_promise: null` — the run never reached terminal, so there is no verdict to trust or
  distrust.
- **Uncommitted working tree, deliberately left in place** (files survive a reboot):
  `extension/src/bin/mux-runner.ts` +2 and its compiled mirror `extension/bin/mux-runner.js` +2.
  This is `96444430`'s in-flight correction to the park logic. Do NOT commit it blind and do NOT
  `git restore` it — let the resumed worker reconcile it.

## Pause sequence that was executed (for the record)

Killed leaf-up so nothing was orphaned: test children (`67476`, `56917`) → worker shell chain
(`19707`, `19486`, `19484`) → `claude` worker (`42537`) → mux (`36069`) → two leaked worker-gate
fixtures (`32683`, `73319`) → then `tmux kill-session`. Confirmed afterwards: 0 `spawn-morty`,
0 real mux, no tmux server.

One survivor was left for the reboot to clear: pid `37575`, a `pickle-mux-runner-*` tmp fixture at
PPID 1. Plus the standing ~14 `pickle-spawn-morty-worker-gate-*` orphans. **The reboot is the reap.**

## Resume after reboot

1. Confirm the box is genuinely idle before anything else — this is now a binding rule, it cost four
   bundles of wrong conclusions on 2026-08-18:
   ```
   ps -Ao pid,ppid,etime,pcpu,command > /tmp/ps.txt    # dump to a FILE; `ps | grep` is filtered to empty on this box
   grep -c 'pickle-spawn-morty-worker-gate' /tmp/ps.txt   # expect 0 after reboot
   grep -c 'loa-2261\|loanlight-api' /tmp/ps.txt          # foreign jest workload — expect ~0
   uptime                                                  # want load ~1-2, not 10-20
   ```

2. Clear the pause's `exit_reason` (it is `signal:SIGINT`, an artifact of the kill):
   ```
   node -e "const {StateManager}=require('$HOME/.claude/pickle-rick/extension/services/state-manager.js'); \
   const sm=new StateManager(); const p='$HOME/.local/share/pickle-rick/sessions/2026-08-19-f048dbc4/state.json'; \
   sm.update(p, s => { s.exit_reason = null; });"
   ```
   If that module is ESM-only, use a dynamic `import()` instead of `require`. Verify by reading the
   file with the Read tool — never `cat` a path containing `state.json`, config-protection blocks it.

3. Resume and relaunch:
   ```
   node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --resume
   tmux new-session -d -s pickle-f048dbc4 -c /Users/gregorydickson/loanlight/pickle-rick/pickle-rick-claude
   tmux send-keys -t pickle-f048dbc4:0 "export PICKLE_WORKER_TEST_FAST_TIMEOUT_MS=1800000; \
     node $HOME/.claude/pickle-rick/extension/bin/mux-runner.js \
     /Users/gregorydickson/.local/share/pickle-rick/sessions/2026-08-19-f048dbc4; read" Enter
   ```
   Then prove the env reached the process: `ps -p <muxpid> -wwE > /tmp/env.txt` and grep the FILE.

4. **Watch `--resume` specifically.** It has a failure history in this repo: restarting from phase 1
   and re-opening Done tickets. `573a1daa` is Done and its commits are in git either way, but if the
   resumed run re-opens it, that is a finding worth recording, not a surprise.

## What this bundle is proving, and why the tail matters

`29077ab4` (Todo) is a **verification** ticket — the same zero-diff shape that killed the previous
session `2026-08-19-541c0275` with `exit_reason: done_without_commit_evidence`. The deployed runtime
is still the PRE-FIX build, so when that ticket tries to flip Done it may hit the very fatal this
bundle removes (the R-PSRB catch-22). That is the observation the attended run exists to collect:

- **It parks and continues** → the fix is validated by the bug it was written against.
- **It fatals** → recover the run (do NOT hand-build the fix), and record that the deployed runtime
  needs the fix deployed before the bundle can finish itself.

## Do NOT do after reboot

- Do not launch any other bundle until this one reaches terminal. One pipeline at a time.
- Do not trust any tier number measured while the box is loud. `fail 0 AND cancelled 0` from the
  runner's own summary block, on a censused idle box, or it is not evidence.
- Do not re-create the 2-hourly babysitter cron expecting it to have survived — it was session-only
  and died with the pre-reboot session.
