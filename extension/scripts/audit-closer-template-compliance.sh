#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PRD_ROOT="${PRD_ROOT_OVERRIDE:-$REPO_ROOT}"

default_scope=(
  "prds/p1-worker-source-state-recursion-contamination.md"
  "prds/archive/bug-reports/p1-mux-runner-wedges-13h-on-unbounded-between-ticket-gate-spawnsync.md"
  "prds/archive/bundles/p1-closer-ticket-spins-on-r-wsrc-forbidden-acs.md"
)

if (($# > 0)); then
  scope=("$@")
else
  scope=("${default_scope[@]}")
fi

failures=0

extract_closer_section() {
  local file="$1"
  awk '
    /^#{2,6}[[:space:]].*Closer/ {
      if (capture) {
        exit
      }
      capture=1
      start=NR
    }
    capture && NR > start && /^#{1,6}[[:space:]]/ {
      exit
    }
    capture {
      print
    }
  ' "$file"
}

require_line_match() {
  local file="$1"
  local regex="$2"
  local message="$3"
  if ! grep -Eq "$regex" "$file"; then
    echo "[FAIL] $message ($file)"
    failures=$((failures + 1))
  fi
}

echo "[audit-closer-template-compliance] scope: ${#scope[@]} file(s)"

for rel_path in "${scope[@]}"; do
  abs_path="$PRD_ROOT/$rel_path"
  echo "  - $rel_path"

  if [[ ! -f "$abs_path" ]]; then
    echo "[FAIL] missing PRD: $rel_path"
    failures=$((failures + 1))
    continue
  fi

  expected_marker='<!-- R-CTSF retroactive (shipped pre-R-CTSF) -->'
  if [[ "$rel_path" == "prds/archive/bundles/p1-closer-ticket-spins-on-r-wsrc-forbidden-acs.md" ]]; then
    expected_marker='<!-- R-CTSF compliant -->'
  fi

  actual_marker="$(grep -m1 '^<!-- R-CTSF ' "$abs_path" || true)"
  if [[ "$actual_marker" != "$expected_marker" ]]; then
    echo "[FAIL] expected marker '$expected_marker' in $rel_path"
    failures=$((failures + 1))
  fi

  closer_section="$(extract_closer_section "$abs_path")"
  if [[ -z "$closer_section" ]]; then
    echo "[FAIL] missing closer section in $rel_path"
    failures=$((failures + 1))
    continue
  fi

  if ! grep -Fq '[worker]' <<<"$closer_section"; then
    echo "[FAIL] closer section missing [worker] ownership tag in $rel_path"
    failures=$((failures + 1))
  fi

  if ! grep -Fq '[manager]' <<<"$closer_section"; then
    echo "[FAIL] closer section missing [manager] ownership tag in $rel_path"
    failures=$((failures + 1))
  fi

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if [[ "$line" =~ ^-[[:space:]] && "$line" =~ Bump[[:space:]]+\`extension/package\.json\`|Deploy[[:space:]]+via[[:space:]]+\`bash[[:space:]]+install\.sh|MD5[[:space:]]+parity[[:space:]]+verify|Update[[:space:]]+\`prds/MASTER_PLAN\.md\`|gh[[:space:]]+release[[:space:]]+create ]]; then
      if [[ "$line" != *"[manager]"* ]]; then
        echo "[FAIL] manager-owned closer step must be tagged [manager] in $rel_path: $line"
        failures=$((failures + 1))
      fi
    fi
  done <<<"$closer_section"
done

if ((failures > 0)); then
  echo "[audit-closer-template-compliance] FAILED ($failures issue(s))"
  exit 1
fi

echo "[audit-closer-template-compliance] OK"
