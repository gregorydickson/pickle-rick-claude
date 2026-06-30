#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ ! -d "$EXTENSION_ROOT/extension/tests" ]; then
  echo "[skipped] extension/tests not present" >&2
  exit 0
fi

status=0

audit_file() {
  local file="$1"
  local line_number
  local line

  if [ ! -f "$file" ]; then
    echo "$file:1 [missing @tier]" >&2
    status=1
    return
  fi

  line_number="$(
    awk '
      NR == 1 && /^#!/ { next }
      /^[[:space:]]*$/ { next }
      { print NR; exit }
    ' "$file"
  )"

  if [ -z "$line_number" ]; then
    echo "$file:1 [missing @tier]" >&2
    status=1
    return
  fi

  line="$(sed -n "${line_number}p" "$file")"
  case "$line" in
    "// @tier: fast"|"// @tier: integration"|"// @tier: expensive"|"// @tier: contract")
      ;;
    *)
      echo "$file:$line_number [missing @tier]" >&2
      status=1
      ;;
  esac
}

if [ "$#" -gt 0 ]; then
  for file in "$@"; do
    audit_file "$file"
  done
else
  while IFS= read -r file; do
    audit_file "$file"
  done < <(find "$EXTENSION_ROOT/extension/tests" -type f -name '*.test.js' | sort)
fi

exit "$status"
