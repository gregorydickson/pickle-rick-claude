---
title: P3 — Paused-session orphan with pid=null blocks every future stop-hook
status: Draft
date: 2026-05-03
priority: P3
type: bug
peer_prds:
  related:
    - prds/archive/bundles/loop-runner-relaunch-status-bugs.md   # pid hygiene on relaunch (already shipped)
    - prds/multi-repo-task-state-drift.md         # state machine drift
    - prds/archive/bug-reports/p2-codex-manager-empty-queue-spin.md   # also a "doesn't recognize done state" bug
---

# PRD — Paused-session orphan with pid=null blocks every future stop-hook

## Symptom

`setup.js --paused` (used by `/pickle-prd`, `/pickle-refine-prd`, and any pre-pipeline interview flow) creates a session with `active=true, pid=null` as a placeholder. The actual runner is supposed to claim ownership by stamping its `pid` at startup.

If the user abandons the paused interview (closes terminal, navigates away, network drop), the session is **never claimed** — `pid` stays `null` forever and `active` stays `true`. From then on, every Claude Code session that lands in the same `working_dir` hits this state via `resolve-state.ts`'s same-cwd lookup, sees `active=true`, and the stop-hook returns `BLOCK (Default continuation)` — refusing to let the user end their turn.

Today's manifestation: orphan session `2026-05-03-45edd193` created at 12:57 by an aborted `/pickle-prd` (step=`prd`, pid=`null`, active=`true`). Every subsequent stop in this repo got the *"🥒 Pickle Rick Loop Active (Iteration 0 of 100)"* block. Manual workaround: `jq '.active = false' state.json`.

This is the **second time** this exact orphan-block pattern bit during the recent multi-day session — the first was `2026-05-02-9e48bce6`, also pid=`null`, also from a paused-mode setup that never got claimed.

## Why this is distinct

| Concern | Bug | Existing fix |
|---|---|---|
| "Process died after stamping pid" | dead-pid recovery | shipped — resolve-state.ts demotes |
| "active=true with pid=null forever" | **THIS PRD** | none — pid-recovery doesn't fire because there's no pid to test |
| "All tickets Done; codex doesn't emit completion" | empty-queue spin | `p2-codex-manager-empty-queue-spin.md` |

`extension/CLAUDE.md` already declares the invariant: *"`pid` is the owning process id when a runner claims liveness"* — implying the contract is "pid set ⇔ active". The pid=null+active=true state is technically a violation, but no enforcer demotes it.

## Reproducer

```bash
# 1. Start a /pickle-prd interview (creates session via setup.js --paused)
# 2. Don't complete the interview — abandon it (close terminal, /clear, etc.)
# 3. In any new Claude Code session in the same cwd:
node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook < /dev/null
# → returns BLOCK because active=true, even though no process owns it

# Forensic state:
find ~/.local/share/pickle-rick/sessions -name state.json -exec sh -c \
  'jq -r --arg f "$1" "select(.active==true and .pid==null) | $f" "$1" 2>/dev/null' _ {} \;
# → lists every paused-orphan
```

## Hypotheses

- **H-A**: setup.js should NOT set `active=true` in paused mode. Active should be claimed by the runner when it starts. A paused interview is `active=false, step='prd'/'refinement'`.
- **H-B**: resolve-state.ts already has a dead-pid demotion path. Extend it to demote `active=true && pid==null` IF state mtime is more than ~5 minutes old (window for legitimate "just-created, runner about to claim").
- **H-C**: stop-hook itself could check `pid==null` and treat it as "no claim → not really active" specifically when iteration=0.

H-B is the lowest-risk surgical fix because it lives in resolve-state.ts (already a recovery shim, used by hooks/setup/runners). H-A would require auditing every paused-mode caller.

## Functional Requirements

| ID | Requirement | Priority |
|---|---|---|
| R-PSO-1 | resolve-state.ts demotes `active=true && pid==null` orphans (state mtime > 300s) to `active=false` with `exit_reason='orphan-paused-no-claim'` | P0 |
| R-PSO-2 | Activity event `paused_session_orphan_demoted` for telemetry | P1 |
| R-PSO-3 | setup.js --paused logs warning if a same-cwd active orphan exists, prompts user to clean up first OR auto-cleans at session-create time | P2 |
| R-PSO-4 | Regression test: fixture state with `active:true, pid:null, mtime>300s`; resolve-state.ts read returns demoted view; subsequent stop-hook approves | P0 |

## Acceptance Criteria

| AC | Verification |
|---|---|
| AC-PSO-01 | `pid==null && active=true && mtime>300s` is demoted on read — `cd extension && npm test -- --grep resolve-state.paused-orphan-demote` | test |
| AC-PSO-02 | stop-hook returns APPROVE when only a paused-orphan exists — `cd extension && npm test -- --grep stop-hook.paused-orphan-no-block` | test |
| AC-PSO-03 | Activity event recorded — `cd extension && npm test -- --grep activity.paused-orphan-demoted` | test |
| AC-PSO-04 | Existing dead-pid demotion test still passes — `cd extension && npm test -- --grep resolve-state.dead-pid-demote` | test |

## Workaround until R-PSO-1 lands

```bash
find ~/.local/share/pickle-rick/sessions -name state.json -exec sh -c '
  active=$(jq -r .active "$1")
  pid=$(jq -r .pid "$1")
  if [ "$active" = "true" ] && [ "$pid" = "null" ]; then
    jq ".active = false | .step = \"completed\" | .exit_reason = \"orphan-cleanup\"" "$1" > "$1.tmp" && mv "$1.tmp" "$1"
    echo "demoted $1"
  fi
' _ {} \;
```

## Cross-references

- Bit twice in this session: `2026-05-02-9e48bce6` (cleared mid-session), `2026-05-03-45edd193` (cleared just now)
- Hook log evidence: `~/.claude/pickle-rick/debug.log` lines around `[StopHookJS] State file found: .../45edd193/state.json` → `active=true, iteration=0/100` → `Decision: BLOCK (Default continuation)`
- Related state-field invariant in `extension/CLAUDE.md`: "INVARIANT: `pid` is the owning process id when a runner claims liveness"

— Pickle Rick out. *belch*
