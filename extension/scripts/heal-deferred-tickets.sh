#!/usr/bin/env bash
set -uo pipefail

EXTENSION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

HEALED_REASON="R-MMTRH heal — R-WMW shipped; deferred AC now passes; ticket work was correct all along"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
usage: heal-deferred-tickets.sh <session-dir> <ticket-id:commit-sha> [...]

For each ticket-id:commit-sha pair:
  - Runs: cd extension && npm run test:fast
  - On success: flips frontmatter status "Skipped" -> "Done", preserves
    completion_commit, appends healed_at + healed_reason, removes # DEFERRED: lines
  - Idempotent: already-Done tickets are no-ops (byte-identical frontmatter)
  - Missing session dir or ticket file: emits [skip] line to stderr, exits 0
EOF
  exit 0
fi

if [[ $# -lt 2 ]]; then
  echo "[heal] error: session-dir and at least one ticket-id:commit-sha required" >&2
  exit 1
fi

SESSION_DIR="$1"
shift

for pair in "$@"; do
  ticket_id="${pair%%:*}"
  ticket_file="$SESSION_DIR/$ticket_id/rick_ticket_${ticket_id}.md"

  if [[ ! -f "$ticket_file" ]]; then
    echo "[skip] $ticket_id: ticket file not found" >&2
    continue
  fi

  current_status=$(awk '
    /^---$/ { n++ }
    n == 1 && /^status:/ {
      gsub(/^status:[[:space:]]*/, "")
      gsub(/"/, "")
      print
      exit
    }
    n == 2 { exit }
  ' "$ticket_file")

  if [[ "$current_status" == "Done" ]]; then
    echo "[skip] $ticket_id: already Done (idempotent no-op)"
    continue
  fi

  if [[ "$current_status" != "Skipped" ]]; then
    echo "[skip] $ticket_id: status '$current_status' is not Skipped, skipping" >&2
    continue
  fi

  echo "[heal] $ticket_id: running validation gate..."
  if ! (cd "$EXTENSION_DIR" && npm run test:fast); then
    echo "[fail] $ticket_id: validation gate failed, skipping heal" >&2
    continue
  fi

  healed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  if awk -v healed_at="$healed_at" -v healed_reason="$HEALED_REASON" '
    fm_count == 0 && /^---$/ { fm_count = 1; print; next }
    fm_count == 1 && /^---$/ {
      print "healed_at: " healed_at
      print "healed_reason: \"" healed_reason "\""
      fm_count = 2
      print
      next
    }
    fm_count == 1 && /^status:/ {
      print "status: \"Done\""
      next
    }
    fm_count == 2 && /^# DEFERRED:/ { next }
    { print }
  ' "$ticket_file" > "${ticket_file}.tmp"; then
    mv "${ticket_file}.tmp" "$ticket_file"
    echo "[healed] $ticket_id: status Skipped -> Done (healed_at: $healed_at)"
  else
    rm -f "${ticket_file}.tmp"
    echo "[fail] $ticket_id: frontmatter update failed" >&2
  fi
done

exit 0
