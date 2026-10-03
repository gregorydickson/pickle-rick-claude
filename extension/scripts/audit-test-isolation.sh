#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_ROOT="$EXTENSION_ROOT/extension/tests"
SRC_ROOT="$EXTENSION_ROOT/extension/src"
SERIAL_MANIFEST_REL="tests/integration/.serial-tests.json"
SERIAL_MANIFEST_PATH="$EXTENSION_ROOT/extension/$SERIAL_MANIFEST_REL"

if [ ! -d "$TEST_ROOT" ]; then
  echo "[skipped: tests not deployed]" >&2
  exit 0
fi

status=0
seen_source_files=""

contains_seen_source() {
  case "
$seen_source_files
" in
    *"
$1
"*) return 0 ;;
    *) return 1 ;;
  esac
}

remember_source() {
  contains_seen_source "$1" && return
  seen_source_files="${seen_source_files}${1}
"
}

window_for_line() {
  local file="$1"
  local line_number="$2"
  local start=$((line_number - 3))
  local end=$((line_number + 3))

  if [ "$start" -lt 1 ]; then
    start=1
  fi

  sed -n "${start},${end}p" "$file"
}

is_inert_fixture_line() {
  local line="$1"

  case "$line" in
    *"code:"*".claude/pickle-rick/extension"*|*"code ="*".claude/pickle-rick/extension"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

has_isolation_opt_in() {
  local window="$1"

  if printf '%s\n' "$window" | grep -Eq "EXTENSION_DIR_TEST|NODE_ENV|os[.]tmpdir[(][)]|tmpdir[(][)]"; then
    return 0
  fi

  return 1
}

has_deployed_extension_context() {
  local line="$1"

  if printf '%s\n' "$line" | grep -Eq "[.]claude/pickle-rick/extension"; then
    return 0
  fi

  return 1
}

report_violation() {
  local file="$1"
  local line_number="$2"
  local matched="$3"

  echo "$file:$line_number $matched" >&2
  status=1
}

report_subprocess_heavy_classification() {
  local serial_output

  serial_output="$(
    cd "$EXTENSION_ROOT/extension" &&
      node bin/test-runner.js --tier integration --manifest "$SERIAL_MANIFEST_REL" --manifest-mode include --dry-run
  )" || {
    status=1
    return
  }

  echo "subprocess-heavy:"
  while IFS='|' read -r fragment expected_path; do
    if printf '%s\n' "$serial_output" | grep -Fxq "$expected_path"; then
      printf '  %s: %s\n' "$fragment" "$expected_path"
    else
      printf '  %s: [missing manifest entry for %s]\n' "$fragment" "$expected_path" >&2
      status=1
    fi
  done <<'EOF'
spawn-morty-backend-resolution|tests/integration/spawn-morty-backend-resolution.test.js
spawn-morty-actual-session-bug|tests/integration/spawn-morty-actual-session-bug.test.js
dispatch|tests/integration/process-cleanup.test.js
refinement-worker-crash|tests/integration/process-cleanup.test.js
pipeline-state-coherence|tests/integration/pipeline-state-coherence.test.js
mega-bundle-e2e|tests/integration/mega-bundle-e2e.test.js
install-script-real|tests/integration/install-typescript-package.test.js
timeout-e2e|tests/integration/timeout-e2e.test.js
worker-backend-split|tests/integration/worker-backend-split.test.js
concurrent-state|tests/integration/concurrent-state.test.js
EOF
}

audit_match_file() {
  local file="$1"
  local source_mode="${2:-test}"
  local matches
  local entry
  local line_number
  local line
  local matched
  local window

  if [ ! -f "$file" ]; then
    report_violation "$file" 1 "[missing file]"
    return
  fi

  matches="$(grep -nE "os[.]homedir[(][)]|[.]claude/pickle-rick/extension" "$file" || true)"

  if [ -z "$matches" ]; then
    return
  fi

  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    line_number="${entry%%:*}"
    line="${entry#*:}"

    if printf '%s\n' "$line" | grep -Eq "os[.]homedir[(][)]"; then
      matched="os.homedir()"
    else
      matched=".claude/pickle-rick/extension"
    fi

    if [ "$source_mode" != "source" ] && is_inert_fixture_line "$line"; then
      continue
    fi

    window="$(window_for_line "$file" "$line_number")"

    if [ "$matched" = ".claude/pickle-rick/extension" ] && ! printf '%s\n' "$line" | grep -Eq "os[.]homedir[(][)]"; then
      continue
    fi

    if ! has_deployed_extension_context "$line"; then
      continue
    fi

    if has_isolation_opt_in "$window"; then
      continue
    fi

    if [ "$source_mode" = "source" ] && grep -Eq "EXTENSION_DIR_TEST|NODE_ENV" "$file"; then
      continue
    fi

    report_violation "$file" "$line_number" "$matched"
  done <<EOF
$matches
EOF
}

source_path_from_import() {
  local test_file="$1"
  local spec="$2"
  local base_dir
  local candidate
  local no_ext

  case "$spec" in
    ../src/*|../../src/*|../services/*|../../services/*|../bin/*|../../bin/*|../hooks/*|../../hooks/*)
      ;;
    *)
      return
      ;;
  esac

  base_dir="$(cd "$(dirname "$test_file")" && pwd)"
  candidate="$base_dir/$spec"

  case "$candidate" in
    *.js)
      no_ext="${candidate%".js"}"
      for candidate in "$no_ext.ts" "$no_ext.js"; do
        if [ -f "$candidate" ]; then
          case "$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")" in
            "$SRC_ROOT"/*) remember_source "$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")" ;;
          esac
          return
        fi
      done
      ;;
    *)
      for candidate in "$candidate.ts" "$candidate.js" "$candidate/index.ts" "$candidate/index.js"; do
        if [ -f "$candidate" ]; then
          case "$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")" in
            "$SRC_ROOT"/*) remember_source "$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")" ;;
          esac
          return
        fi
      done
      ;;
  esac
}

collect_one_hop_source_imports() {
  local file="$1"
  local specs
  local spec

  specs="$(sed -nE "s/.*from[[:space:]]+['\"]([^'\"]+)['\"].*/\\1/p; s/.*import[[:space:]]*[(][[:space:]]*['\"]([^'\"]+)['\"].*/\\1/p; s/^[[:space:]]*import[[:space:]]+['\"]([^'\"]+)['\"].*/\\1/p" "$file")"

  while IFS= read -r spec; do
    [ -z "$spec" ] && continue
    source_path_from_import "$file" "$spec"
  done <<EOF
$specs
EOF
}

audit_session_bin_sandbox() {
  local file="$1"
  local matches entry line_number window

  matches="$(grep -nE "execFileSync\(|spawnSync\(|execSync\(|\bspawn\(" "$file" || true)"
  [ -z "$matches" ] && return

  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    line_number="${entry%%:*}"
    window="$(window_for_line "$file" "$line_number")"

    if ! printf '%s\n' "$window" | grep -Eq "setup\.js|mux-runner\.js|spawn-morty\.js|jar-runner\.js"; then
      continue
    fi

    if printf '%s\n' "$window" | grep -Eq "working_dir[^A-Za-z_].*REPO_ROOT|working_dir[^A-Za-z_].*process\.cwd\(\)"; then
      report_violation "$file" "$line_number" "session-writing bin with real-repo working_dir"
      continue
    fi

    if printf '%s\n' "$window" | grep -Fq "PICKLE_DATA_ROOT"; then
      continue
    fi

    report_violation "$file" "$line_number" "session-writing bin without PICKLE_DATA_ROOT sandbox"
  done <<EOF
$matches
EOF
}

audit_test_file() {
  local file="$1"

  audit_match_file "$file" "test"
  audit_session_bin_sandbox "$file"
  collect_one_hop_source_imports "$file"
}

if [ "$#" -gt 0 ]; then
  for file in "$@"; do
    audit_test_file "$file"
  done
else
  while IFS= read -r file; do
    case "$(basename "$file")" in
      audit-test-isolation-fixture.test.js) continue ;;
    esac
    audit_test_file "$file"
  done < <(find "$TEST_ROOT" -type f -name '*.test.js' \
    ! -path "$TEST_ROOT/fixtures/*" | sort)
fi

while IFS= read -r file; do
  [ -z "$file" ] && continue
  audit_match_file "$file" "source"
done <<EOF
$seen_source_files
EOF

if [ ! -f "$SERIAL_MANIFEST_PATH" ]; then
  echo "Manifest not found: $SERIAL_MANIFEST_REL" >&2
  status=1
else
  report_subprocess_heavy_classification
fi

exit "$status"
