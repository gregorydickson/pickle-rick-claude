#!/usr/bin/env bash
# repro-judge-timeout.sh — 3-probe judge pre-validation (T-HARDEN-PROBE)
#
# Runs three back-to-back probes to bisect judge regressions:
#   probe1: raw legacy spawn (PICKLE_JUDGE_LEGACY_SPAWN=1, execFileSync, stdin=pipe)
#   probe2: async R-SJET-3 env spawn (default path, stdin=ignore, pruned env)
#   probe3: sticky-fallback path (codex backend availability check)
#
# Usage: bash extension/scripts/repro-judge-timeout.sh [cwd]
# Exit 0 = healthy judge; Exit 1 = regression detected
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$EXTENSION_ROOT/bin/microverse-runner.js"
CWD="${1:-$PWD}"

if [ ! -f "$RUNNER" ]; then
  echo "[error] microverse-runner.js not found: $RUNNER" >&2
  echo "[hint] run: cd extension && npx tsc" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[error] node is required" >&2
  exit 1
fi

PASS=0
FAIL=0
RESULTS=""

run_probe() {
  local num="$1" label="$2" backend="$3"
  shift 3
  # $@ = optional KEY=VALUE env overrides passed to env(1)

  local start_s end_s elapsed_s output exit_code probe_kind probe_exit_reason

  start_s=$(date +%s)
  # Capture both stdout and stderr; allow failure so we can inspect exit code. No outer
  # timeout(1): the probe bounds itself (PICKLE_JUDGE_PROBE_TIMEOUT_MS, clamped to 60s), and
  # GNU timeout is absent on macOS, where it turned every probe into exit 127.
  output=$(env PICKLE_JUDGE_PROBE_ALLOWED=1 "$@" node "$RUNNER" --judge-probe "$CWD" "$backend" 2>&1) && exit_code=0 || exit_code=$?
  end_s=$(date +%s)
  elapsed_s=$((end_s - start_s))

  probe_kind=$(printf '%s' "$output" | grep -o 'PROBE_KIND=[a-z_]*' | cut -d= -f2 || true)
  probe_exit_reason=$(printf '%s' "$output" | grep 'PROBE_EXIT_REASON=' | sed 's/PROBE_EXIT_REASON=//' | head -1 || true)
  [ -z "$probe_kind" ] && probe_kind="unknown"

  local status_line="probe${num} [${label} backend=${backend}]"

  if [ "$exit_code" = "0" ]; then
    echo "PASS  ${status_line} elapsed=${elapsed_s}s kind=${probe_kind}"
    PASS=$((PASS + 1))
    RESULTS="${RESULTS}PASS probe${num}\n"
  elif [ "$exit_code" = "2" ] && [ "$backend" = "codex" ]; then
    echo "INFO  ${status_line} elapsed=${elapsed_s}s kind=missing (codex not installed — expected on CI)"
    PASS=$((PASS + 1))
    RESULTS="${RESULTS}INFO probe${num} codex-not-installed\n"
  else
    echo "FAIL  ${status_line} elapsed=${elapsed_s}s kind=${probe_kind} exit=${exit_code}"
    if [ -n "$probe_exit_reason" ]; then
      echo "      exit_reason: ${probe_exit_reason}"
    fi
    FAIL=$((FAIL + 1))
    RESULTS="${RESULTS}FAIL probe${num} exit=${exit_code} kind=${probe_kind}\n"
  fi
}

echo "=== repro-judge-timeout: 3-probe judge validation ==="
echo "runner: $RUNNER"
echo "cwd:    $CWD"
echo ""

run_probe 1 "legacy-spawn"    "claude" "PICKLE_JUDGE_LEGACY_SPAWN=1"
run_probe 2 "async-r-sjet-3"  "claude"
run_probe 3 "sticky-fallback" "codex"

echo ""
echo "=== Results: $PASS passed (or info), $FAIL failed ==="
printf '%b' "$RESULTS"

if [ "$FAIL" -gt 0 ]; then
  echo "JUDGE REGRESSION DETECTED — see probe output above for bisection" >&2
  exit 1
fi

exit 0
