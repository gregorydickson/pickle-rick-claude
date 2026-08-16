#!/usr/bin/env bash
# R-TFP-C2 forward-protection: flags integration tests that spawn bash/sh scripts
# with an explicit timeout <= SUBPROCESS_HEAVY_TIMEOUT_MS and lack serialization.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_ROOT="$EXTENSION_ROOT/tests"
SERIAL_MANIFEST_PATH="$EXTENSION_ROOT/tests/integration/.serial-tests.json"
MISSING_TIMEOUT_SCANNER="$SCRIPT_DIR/audit-subprocess-heavy-tests-missing-timeout.mjs"
MISSING_TIMEOUT_BASELINE="$SCRIPT_DIR/subprocess-heavy-missing-timeout-baseline.json"

# --scan-root <dir>: run against an alternate directory instead of the default
# $EXTENSION_ROOT/tests (e.g. an fs.mkdtemp fixture dir in a test, kept OUT of
# extension/tests so AC-4 stays satisfiable). Consumed before positional args.
SCAN_ROOT_OVERRIDE=""
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --scan-root)
      SCAN_ROOT_OVERRIDE="$2"
      shift 2
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}
if [ -n "$SCAN_ROOT_OVERRIDE" ]; then
  TEST_ROOT="$SCAN_ROOT_OVERRIDE"
fi

# SUBPROCESS_HEAVY_PATTERN (source of truth):
#   spawnSync('bash'|'sh', [firstArg, ...], { ..., timeout: N, ... })
#   where firstArg is NOT a '-' flag (i.e., it is a script path/variable)
#   and N <= SUBPROCESS_HEAVY_TIMEOUT_MS (5000)
#
# Allowlist (silences a candidate):
#   1. File path present in tests/integration/.serial-tests.json
#   2. File contains the comment marker: // SERIAL: <reason>
#
# Excluded tiers:
#   @tier: expensive (gated behind RUN_EXPENSIVE_TESTS=1, not part of c=8 surface)

SUBPROCESS_HEAVY_TIMEOUT_MS=5000
# Load-sensitive WARN tier: non-serialized subprocess spawns with a timeout in the
# (5000, 15000] band are flagged with a NON-failing WARN (closes the 10s blind spot,
# e.g. the pntr-pickle-deprecated ~10004ms-under-c=8 class) without hard-failing the gate.
SUBPROCESS_HEAVY_WARN_MS=15000

if [ ! -d "$TEST_ROOT" ]; then
  echo "[skipped: tests not deployed]" >&2
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 1
fi

status=0

# is_in_manifest <rel_path>
# Returns 0 (true) if the relative path is in the serial-tests manifest.
is_in_manifest() {
  local file_rel="$1"
  if [ ! -f "$SERIAL_MANIFEST_PATH" ]; then
    return 1
  fi
  node - "$SERIAL_MANIFEST_PATH" "$file_rel" <<'NODE'
const fs = require('fs');
const [, , manifestPath, fileRel] = process.argv;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const normalized = fileRel.replace(/\\/g, '/');
process.exit(manifest.entries.some((e) => e === normalized) ? 0 : 1);
NODE
}

# find_heavy_candidate <file> <fail_threshold_ms> <warn_threshold_ms>
# Classifies the strongest subprocess-heavy spawn in the file by its timeout N:
#   N <= FAIL_THRESHOLD            -> prints "FAIL <reason>", exit 0
#   FAIL_THRESHOLD < N <= WARN     -> prints "WARN <reason>", exit 0
#   N > WARN                       -> not a candidate, exit 1
# FAIL takes precedence over WARN when both bands are present in one file.
find_heavy_candidate() {
  local file="$1"
  local fail_ms="$2"
  local warn_ms="$3"
  node - "$file" "$fail_ms" "$warn_ms" <<'NODE'
const fs = require('fs');
const [, , filePath, failMs, warnMs] = process.argv;
const FAIL_THRESHOLD = parseInt(failMs, 10);
const WARN_THRESHOLD = parseInt(warnMs, 10);
const content = fs.readFileSync(filePath, 'utf8');

// Skip @tier: expensive — not part of the --test-concurrency=8 surface.
const firstLine = content.split('\n')[0];
if (firstLine.includes('@tier: expensive')) process.exit(1);

// SUBPROCESS_HEAVY_PATTERN:
//   spawnSync('bash'|'sh', [nonFlagFirstArg, ...]) with explicit timeout
//
// The '-' exclusion prevents false positives on inline commands like:
//   spawnSync('bash', ['-lc', 'command -v git'])
//   spawnSync('bash', ['-c', 'echo test'])
const bashSpawnRe = /\bspawnSync\s*\(\s*['"](?:bash|sh)['"]\s*,\s*\[(?!\s*['"][^'"]*-)/g;
let warnReason = null; // first WARN-band candidate, used only if no FAIL found
let m;
while ((m = bashSpawnRe.exec(content)) !== null) {
  const block = content.slice(m.index, m.index + 600);
  const timeoutMatch = block.match(/\btimeout\s*:\s*([0-9][0-9_]*)\b/);
  if (!timeoutMatch) continue; // no explicit timeout: not flagged by this audit
  const t = parseInt(timeoutMatch[1].replace(/_/g, ''), 10);
  const reason = `spawnSync(bash/sh, script, { timeout: ${t} })`;
  if (t <= FAIL_THRESHOLD) {
    process.stdout.write(`FAIL ${reason}\n`);
    process.exit(0);
  }
  if (t <= WARN_THRESHOLD && warnReason === null) {
    warnReason = reason; // remember; keep scanning in case a FAIL-band spawn exists
  }
}

if (warnReason !== null) {
  process.stdout.write(`WARN ${warnReason}\n`);
  process.exit(0);
}

process.exit(1); // not a candidate
NODE
}

AUDITED_FILES=()

audit_file() {
  local file="$1"

  if [ ! -f "$file" ]; then
    echo "$file: not found" >&2
    status=1
    return
  fi

  AUDITED_FILES+=("$file")

  # Derive relative path from EXTENSION_ROOT (e.g. tests/foo.test.js)
  file_rel="${file#"$EXTENSION_ROOT/"}"

  # Run pattern matcher; exit 1 means not a candidate.
  # Output is "<TAG> <reason>" where TAG is FAIL (N <= 5000) or WARN (5000 < N <= 15000).
  candidate_out="$(find_heavy_candidate "$file" "$SUBPROCESS_HEAVY_TIMEOUT_MS" "$SUBPROCESS_HEAVY_WARN_MS" 2>/dev/null)"
  candidate_exit=$?
  [ "$candidate_exit" -ne 0 ] && return

  local candidate_tag="${candidate_out%% *}"      # FAIL | WARN
  local candidate_reason="${candidate_out#* }"    # reason string

  # Allowlist (silences BOTH bands): serial manifest
  if is_in_manifest "$file_rel"; then
    return
  fi

  # Allowlist (silences BOTH bands): // SERIAL: comment in file
  if grep -q '// SERIAL:' "$file"; then
    return
  fi

  if [ "$candidate_tag" = "WARN" ]; then
    echo "WARN: $file_rel: load-sensitive subprocess spawn ($candidate_reason) in 6000-15000ms band — consider serialization" >&2
    return
  fi

  echo "$file_rel: subprocess-heavy candidate not serialized ($candidate_reason)" >&2
  status=1
}

if [ "$#" -gt 0 ]; then
  for file in "$@"; do
    audit_file "$file"
  done
else
  while IFS= read -r file; do
    audit_file "$file"
  done < <(find "$TEST_ROOT" -type f -name '*.test.js' \
    ! -path "$TEST_ROOT/fixtures/*" | sort)
fi

# Missing-timeout predicate (R-TFP-C2 extension): the whole child_process
# family, grandfathered against a committed baseline so pre-existing debt
# does not redden this gate. Only callsites absent from the baseline fail.
if [ "${#AUDITED_FILES[@]}" -gt 0 ] && command -v node >/dev/null 2>&1; then
  missing_timeout_out="$(node "$MISSING_TIMEOUT_SCANNER" --baseline "$MISSING_TIMEOUT_BASELINE" --base "$EXTENSION_ROOT" "${AUDITED_FILES[@]}" 2>/dev/null)"
  missing_timeout_exit=$?
  if [ "$missing_timeout_exit" -ne 0 ]; then
    while IFS=$'\t' read -r mt_file mt_fn mt_key; do
      [ -z "$mt_file" ] && continue
      echo "$mt_file: new missing-timeout $mt_fn(...) callsite not in baseline ($mt_key)" >&2
    done <<< "$missing_timeout_out"
    status=1
  fi
fi

if [ "$status" -eq 0 ]; then
  echo "audit-subprocess-heavy-tests: OK" >&2
fi

exit "$status"
