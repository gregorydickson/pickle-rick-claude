#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_ROOT="$EXTENSION_ROOT/extension/tests"
# f009608d swept these two live gate inputs to archive/; the audit follows them
# there (sync-to-landed, matching beta.25's b5f3c85e citadel-hardening repoint).
MATRIX_PATH="$EXTENSION_ROOT/prds/archive/design-notes/bundle-thesis-matrix.md"
PRD_PATH="$EXTENSION_ROOT/prds/archive/bundles/p1-reliability-and-test-coverage-bundle-2026-05-03.md"

if [ ! -d "$TEST_ROOT" ]; then
  echo "[skipped: tests not deployed]" >&2
  exit 0
fi

if [ ! -f "$MATRIX_PATH" ]; then
  echo "[error: missing bundle thesis matrix] $MATRIX_PATH" >&2
  exit 2
fi

if ! command -v git >/dev/null 2>&1; then
  echo "[error: git is required]" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 1
fi

status=0
rows_file="$(mktemp "${TMPDIR:-/tmp}/bundle-thesis-rows.XXXXXX")"
trap 'rm -f "$rows_file"' EXIT

fail() {
  echo "$1" >&2
  status=1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

parse_matrix() {
  awk '
    function trim(value) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      return value
    }
    function emit_error(message) {
      print "ERROR\t" message
    }
    BEGIN {
      in_table = 0
      header_seen = 0
      emitted = 0
    }
    /^[[:space:]]*\|/ || /^[[:space:]]*Bug[[:space:]]*\|/ || /^[[:space:]]*---[[:space:]]*\|/ {
      line = $0
      sub(/^[[:space:]]*\|/, "", line)
      sub(/\|[[:space:]]*$/, "", line)
      count = split(line, cols, /\|/)

      if (!header_seen) {
        if (trim(cols[1]) != "Bug") {
          next
        }
        header_seen = 1
        for (i = 1; i <= count; i++) {
          key = trim(cols[i])
          col_index[key] = i
        }
        required[1] = "Bug"
        required[2] = "Failure-mode classification"
        required[3] = "Section E artifact (R-RTC-N)"
        required[4] = "Canary test path"
        required[5] = "Bug-repro assertion"
        for (i = 1; i <= 5; i++) {
          if (!(required[i] in col_index)) {
            emit_error("missing column: " required[i])
          }
        }
        next
      }

      if (header_seen && cols[1] ~ /^[[:space:]-]+$/) {
        in_table = 1
        next
      }

      if (!in_table) {
        next
      }

      bug = trim(cols[col_index["Bug"]])
      failure_mode = trim(cols[col_index["Failure-mode classification"]])
      artifact = trim(cols[col_index["Section E artifact (R-RTC-N)"]])
      canary = trim(cols[col_index["Canary test path"]])
      assertion = trim(cols[col_index["Bug-repro assertion"]])
      rationale = ""
      if ("other-rationale" in col_index) {
        rationale = trim(cols[col_index["other-rationale"]])
      }
      if (bug != "") {
        emitted++
        print "ROW\t" bug "\t" failure_mode "\t" artifact "\t" canary "\t" assertion "\t" rationale
      }
      next
    }
    {
      if (in_table) {
        exit
      }
    }
    END {
      if (!header_seen) {
        emit_error("missing matrix table header")
      } else if (emitted == 0) {
        emit_error("matrix table has no rows")
      }
    }
  ' "$MATRIX_PATH" >"$rows_file"
}

prd_contains_requirement() {
  local requirement="$1"
  [ -f "$PRD_PATH" ] && grep -Eq "(^|[^A-Za-z0-9-])${requirement}([^A-Za-z0-9-]|$)" "$PRD_PATH"
}

path_exists_at_head() {
  local path="$1"
  git -C "$EXTENSION_ROOT" ls-tree -r --name-only HEAD -- "$path" | grep -Fxq "$path"
}

run_canary() {
  local path="$1"
  (cd "$EXTENSION_ROOT" && env -u NODE_TEST_CONTEXT node --test "$path" >/dev/null)
}

validate_requirement_cell() {
  local bug="$1"
  local cell="$2"
  local found=0
  local requirement

  while IFS= read -r requirement; do
    [ -n "$requirement" ] || continue
    found=1
    if ! prd_contains_requirement "$requirement"; then
      fail "$bug: missing requirement in PRD: $requirement"
    fi
  done < <(printf '%s\n' "$cell" | grep -Eo 'R-RTC-[0-9]+' | sort -u)

  if [ "$found" -eq 0 ]; then
    fail "$bug: no R-RTC requirement cited"
  fi
}

validate_canary_cell() {
  local bug="$1"
  local cell="$2"
  local found=0
  local path

  IFS=',' read -r -a paths <<<"$cell"
  for raw_path in "${paths[@]}"; do
    path="$(trim "$raw_path")"
    [ -n "$path" ] || continue
    found=1
    if ! path_exists_at_head "$path"; then
      fail "$bug: canary missing at HEAD: $path"
      continue
    fi
    if ! run_canary "$path"; then
      fail "$bug: canary failed: $path"
    fi
  done

  if [ "$found" -eq 0 ]; then
    fail "$bug: no canary path cited"
  fi
}

parse_matrix

for expected in A B C D; do
  count="$(awk -F '\t' -v bug="$expected" '$1 == "ROW" && $2 == bug { count++ } END { print count + 0 }' "$rows_file")"
  if [ "$count" -eq 0 ]; then
    fail "$expected: missing matrix row"
  elif [ "$count" -gt 1 ]; then
    fail "$expected: duplicate matrix row"
  fi
done

row_count="$(awk -F '\t' '$1 == "ROW" { count++ } END { print count + 0 }' "$rows_file")"
if [ "$row_count" -ne 4 ]; then
  fail "matrix: expected exactly 4 rows, found $row_count"
fi

while IFS=$'\t' read -r record bug failure_mode artifact canary assertion rationale; do
  if [ "$record" = "ERROR" ]; then
    fail "matrix: $bug"
    continue
  fi

  [ "$record" = "ROW" ] || continue

  case "$bug" in
    A|B|C|D) ;;
    *) fail "$bug: unexpected bug row" ;;
  esac

  case "$failure_mode" in
    coverage-gap|test-seam-bug|missing-e2e|mock-drift) ;;
    other)
      case "$rationale" in
        prds/*.md|*/prds/*.md) ;;
        *) fail "$bug: other classification requires other-rationale PRD path" ;;
      esac
      ;;
    *) fail "$bug: invalid failure mode: $failure_mode" ;;
  esac

  if [ -z "$assertion" ]; then
    fail "$bug: missing bug-repro assertion"
  fi

  validate_requirement_cell "$bug" "$artifact"
  validate_canary_cell "$bug" "$canary"
done <"$rows_file"

exit "$status"
