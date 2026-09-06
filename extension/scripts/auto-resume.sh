#!/usr/bin/env bash
set -euo pipefail

EXTENSION_ROOT="${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}"
MAX_RETRIES="${PICKLE_AUTO_RESUME_MAX_RETRIES:-10}"
PROGRESS_THRESHOLD=3
BANNER_THRESHOLD=3
MAX_WALL_SECONDS="${PICKLE_AUTO_RESUME_MAX_WALL_SECONDS:-7200}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
usage: auto-resume.sh <session-dir>

Foreground wrapper that relaunches mux-runner.js after a transient phase-incomplete exit
(pipeline_phase_incomplete OR R-PIPE-2 phase_no_progress OR R-PPPA phase_incomplete_tickets).

Environment:
  PICKLE_AUTO_RESUME_ON_CAP_HIT=1       enable auto-resume (required to activate loop)
  PICKLE_AUTO_RESUME_MAX_RETRIES        max relaunch count (default: 10)
  PICKLE_AUTO_RESUME_MAX_WALL_SECONDS   max wall-clock seconds before stopping (default: 7200)
  PICKLE_INSTALL_ROOT                   override extension root (default: ~/.claude/pickle-rick)

FOREGROUND ONLY: setsid, nohup, disown, and detach are forbidden. The wrapper dies with the
parent shell. Child mux-runner is killed when the wrapper receives SIGTERM or SIGINT.

Stop conditions (any one triggers halt):
  - exit_reason is 'closer_handoff_terminal'
  - exit_reason is not 'pipeline_phase_incomplete', 'phase_no_progress' (R-PIPE-2),
    or 'phase_incomplete_tickets' (R-PPPA)
  - MAX_RETRIES exhausted
  - wall-clock exceeds MAX_WALL_SECONDS
  - no progress (same ticket + done count) for >= PROGRESS_THRESHOLD consecutive retries
EOF
  exit 0
fi

if [[ $# -lt 1 ]]; then
  echo "[auto-resume] error: session-dir argument required" >&2
  echo "usage: auto-resume.sh <session-dir>" >&2
  exit 1
fi

SESSION_DIR="$1"
STATE_JSON="$SESSION_DIR/state.json"

if [[ ! -d "$SESSION_DIR" ]]; then
  echo "[auto-resume] error: session directory not found: $SESSION_DIR" >&2
  exit 1
fi

MUX_RUNNER="$EXTENSION_ROOT/extension/bin/mux-runner.js"

if [[ ! -f "$MUX_RUNNER" ]]; then
  echo "[auto-resume] error: mux-runner not found: $MUX_RUNNER" >&2
  exit 1
fi

# Without the enable flag, run exactly once and exit — no loop.
if [[ "${PICKLE_AUTO_RESUME_ON_CAP_HIT:-}" != "1" ]]; then
  exec node "$MUX_RUNNER" "$SESSION_DIR"
fi

# Foreground child tracking. INVARIANT: no setsid/nohup/disown/detach — wrapper MUST die with
# parent shell. Child PID is tracked so signals forwarded via trap kill the child immediately.
CHILD_PID=""

_kill_child() {
  if [[ -n "$CHILD_PID" ]]; then
    kill "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
    CHILD_PID=""
  fi
}

trap '_kill_child; exit 130' INT
trap '_kill_child; exit 143' TERM
trap '_kill_child; exit 129' HUP

_read_state_field() {
  local field="$1"
  node -e "
const fs = require('fs');
try {
  const s = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const v = s[process.argv[2]];
  process.stdout.write(v != null ? String(v) : '');
} catch { process.stdout.write(''); }
" "$STATE_JSON" "$field" 2>/dev/null || true
}

_count_done_tickets() {
  node -e "
const fs = require('fs'), path = require('path');
const dir = process.argv[1];
let n = 0;
try {
  for (const hash of fs.readdirSync(dir)) {
    const ticketPath = path.join(dir, hash, 'rick_ticket_' + hash + '.md');
    if (!fs.existsSync(ticketPath)) continue;
    if (/^status:\s*Done\s*$/m.test(fs.readFileSync(ticketPath, 'utf8'))) n++;
  }
} catch {}
process.stdout.write(String(n));
" "$SESSION_DIR" 2>/dev/null || echo "0"
}

_emit_auto_resumed() {
  local retry_idx="$1" ticket_id="$2" done_count="$3"
  AR_RETRY="$retry_idx" AR_TICKET="$ticket_id" AR_DONE="$done_count" \
    AR_STATE="$STATE_JSON" AR_EXT_ROOT="$EXTENSION_ROOT" \
    node --input-type=module << 'JSEOF' 2>/dev/null || true
const { writePipelineAutoResumedEvent } = await import('file://' + process.env.AR_EXT_ROOT + '/extension/services/state-manager.js');
writePipelineAutoResumedEvent(process.env.AR_STATE, {
  retry_index: parseInt(process.env.AR_RETRY || '0', 10),
  ticket_id: process.env.AR_TICKET || '',
  session_done_count_at_retry: parseInt(process.env.AR_DONE || '0', 10),
});
JSEOF
}

start_epoch="$(date +%s)"
retry=0
prev_done=""
prev_ticket=""
no_progress_cycles=0

echo "[auto-resume] starting loop (max_retries=$MAX_RETRIES, session=$SESSION_DIR)" >&2

while true; do
  cur_ticket="$(_read_state_field current_ticket)"
  cur_done="$(_count_done_tickets)"

  _emit_auto_resumed "$retry" "$cur_ticket" "$cur_done"

  # Close child stdin so sync harness pipes cannot be kept open by a background
  # mux-runner process if the wrapper is signalled mid-retry.
  node "$MUX_RUNNER" "$SESSION_DIR" </dev/null &
  CHILD_PID=$!
  wait "$CHILD_PID" 2>/dev/null || true
  CHILD_PID=""

  exit_reason="$(_read_state_field exit_reason)"

  if [[ "$exit_reason" == "closer_handoff_terminal" ]]; then
    echo "[auto-resume] stopped: manager handoff required (exit_reason='$exit_reason')" >&2
    break
  fi

  # R-PIPE-2: phase_no_progress is the same transient retry class as
  # pipeline_phase_incomplete — pipeline-runner stamps it when the pickle
  # phase exits clean (code 0) with 0 Done + 0 commits since session start.
  # R-PPPA: phase_incomplete_tickets is the same transient class for the
  # N-of-M case — pickle exits clean with some but not all tickets resolved.
  if [[ "$exit_reason" != "pipeline_phase_incomplete" && "$exit_reason" != "phase_no_progress" && "$exit_reason" != "phase_incomplete_tickets" ]]; then
    echo "[auto-resume] stopped: exit_reason='$exit_reason'" >&2
    break
  fi

  retry=$((retry + 1))

  if [[ "$retry" -ge "$MAX_RETRIES" ]]; then
    echo "[auto-resume] stopped: exhausted max retries ($MAX_RETRIES)" >&2
    break
  fi

  now_epoch="$(date +%s)"
  elapsed=$((now_epoch - start_epoch))
  if [[ "$elapsed" -ge "$MAX_WALL_SECONDS" ]]; then
    echo "[auto-resume] stopped: wall-clock limit reached (${elapsed}s >= ${MAX_WALL_SECONDS}s)" >&2
    break
  fi

  if [[ -n "$prev_done" && "$cur_done" == "$prev_done" && "$cur_ticket" == "$prev_ticket" ]]; then
    no_progress_cycles=$((no_progress_cycles + 1))
  else
    no_progress_cycles=0
  fi

  if [[ "$retry" -gt "$BANNER_THRESHOLD" ]]; then
    echo "[warn] auto-resume retry $retry/$MAX_RETRIES (no progress for $no_progress_cycles cycles)" >&2
  fi

  if [[ "$no_progress_cycles" -ge 1 && "$retry" -ge "$PROGRESS_THRESHOLD" ]]; then
    echo "[auto-resume] stopped: no progress for $no_progress_cycles consecutive retries (ticket=$cur_ticket, done=$cur_done)" >&2
    break
  fi

  prev_done="$cur_done"
  prev_ticket="$cur_ticket"

  echo "[auto-resume] retry $retry/$MAX_RETRIES (done=$cur_done, ticket=$cur_ticket, elapsed=${elapsed}s)" >&2
done
