#!/usr/bin/env bash
# R-TFP-C2 forward-protection: flags integration tests that spawn bash/sh scripts
# with an explicit timeout <= SUBPROCESS_HEAVY_TIMEOUT_MS and lack serialization.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_ROOT="$EXTENSION_ROOT/tests"
SERIAL_MANIFEST_PATH="$EXTENSION_ROOT/tests/integration/.serial-tests.json"
FAST_SERIAL_MANIFEST_PATH="$EXTENSION_ROOT/tests/.serial-tests.json"
MISSING_TIMEOUT_SCANNER="$SCRIPT_DIR/audit-subprocess-heavy-tests-missing-timeout.mjs"
MISSING_TIMEOUT_BASELINE="$SCRIPT_DIR/subprocess-heavy-missing-timeout-baseline.json"
UNPROVISIONED_SCANNER="$SCRIPT_DIR/audit-unprovisioned-binary-spawns.mjs"

# --scan-root <dir>: run against an alternate directory instead of the default
# $EXTENSION_ROOT/tests (e.g. an fs.mkdtemp fixture dir in a test, kept OUT of
# extension/tests so AC-4 stays satisfiable). Consumed before positional args.
#
# --emit-fast-manifest: regenerate tests/.serial-tests.json from this script's OWN
# load-sensitive verdict, so the derived floor is never hand-transcribed. It writes the
# UNION of the verdict and the existing entries — never a replacement — so regeneration
# cannot silently drop an entry or fall below the floor the AC-A1a check enforces.
# Explicit-flag only: the default run performs no write.
SCAN_ROOT_OVERRIDE=""
EMIT_FAST_MANIFEST=0
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --scan-root)
      SCAN_ROOT_OVERRIDE="$2"
      shift 2
      ;;
    --emit-fast-manifest)
      EMIT_FAST_MANIFEST=1
      shift
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
#   <spawnFn>(<program>, [firstArg, ...], { ..., timeout: N, ... })
#   where <spawnFn> is any child_process spawn entry point, <program> is any expression,
#   and firstArg is NOT a '-' flag (i.e., it is a script path/variable).
#
# The program was formerly the two-member enumeration 'bash'|'sh'. That is the
# incomplete-set shape CLAUDE.md names, and this repo had already MEASURED its cost:
# tests/serial-tests-reasons-coverage.test.js:120-151 documents tsc-gate.test.js starving
# the fast tier through `spawnSync(process.execPath, ...)` — invisible to the audit — and
# holds it serial by hand because "serialization is therefore the ONLY guard on it".
# Reading the program as an expression removes the distinction the hand-list compensated for.
#
# Two arms, one scan:
#   program is bash/sh AND N <= SUBPROCESS_HEAVY_TIMEOUT_MS -> FAIL (hard, shipped scope)
#   otherwise             N <= SUBPROCESS_HEAVY_WARN_MS      -> WARN (load-sensitive)
# The FAIL arm deliberately KEEPS the bash/sh program enumeration. That is the load-bearing
# narrowing: dropping it there would convert 12 existing files into hard audit failures and red
# the release gate — a new halt path, which the PRIME DIRECTIVE forbids. A short timeout on a
# non-bash spawn instead degrades to "serialize this", which is strictly the gentler disposition.
# (The FAIL arm's spawn-FUNCTION set does widen with the shared scan, so an
# `execFileSync('bash', [script], { timeout: <=5000 })` now fails as `spawnSync` always did.
# Measured: zero such call sites in the corpus today, so this widening reds nothing.)
#
# A non-numeric timeout (`timeout: CAP_WORKER_GATE`, an imported constant) is NOT classified:
# the audit cannot evaluate it statically, and guessing would be worse than the manifest entry
# that records the measurement instead.
#
# Allowlist (silences a candidate):
#   1. File path present in tests/.serial-tests.json or tests/integration/.serial-tests.json
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
# AC-A1a verdict, kept out of `status` so --emit-fast-manifest can clear THIS and only this.
a1a_status=0

# is_in_manifest <rel_path> [manifest_path...]
# Returns 0 (true) if the relative path is in ANY of the given serial-tests manifests,
# defaulting to every manifest this repo ships. Resolution is EXTENDED across the fast and
# integration manifests rather than forked into a second predicate: membership in a serial
# manifest is one fact, and asking it once keeps the allowlist a single concept.
is_in_manifest() {
  local file_rel="$1"
  shift
  local manifests=("$@")
  if [ "${#manifests[@]}" -eq 0 ]; then
    manifests=("$SERIAL_MANIFEST_PATH" "$FAST_SERIAL_MANIFEST_PATH")
  fi
  local manifest
  for manifest in "${manifests[@]}"; do
    [ -f "$manifest" ] || continue
    if node - "$manifest" "$file_rel" <<'NODE'
const fs = require('fs');
const [, , manifestPath, fileRel] = process.argv;
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const normalized = fileRel.replace(/\\/g, '/');
process.exit(manifest.entries.some((e) => e === normalized) ? 0 : 1);
NODE
    then
      return 0
    fi
  done
  return 1
}

# declared_tier <file>
# Prints the tier from a leading `// @tier: <name>` header, mirroring test-runner's own
# `firstMeaningfulLine` semantics (shebang and blank lines skipped, then the FIRST line
# decides). Matching that exactly matters: test-runner selects files by this header BEFORE
# applying a manifest, so a file whose header it reads as null is never serialized however
# it is listed.
declared_tier() {
  awk '
    /^#!/ { next }
    /^[ \t]*$/ { next }
    {
      if (match($0, /^[ \t]*\/\/[ \t]*@tier:[ \t]*[A-Za-z0-9_-]+[ \t]*$/)) {
        line = $0
        sub(/^[ \t]*\/\/[ \t]*@tier:[ \t]*/, "", line)
        sub(/[ \t]*$/, "", line)
        print line
      }
      exit
    }
  ' "$1"
}

# find_heavy_candidate <file> <fail_threshold_ms> <warn_threshold_ms>
# Classifies the strongest subprocess-heavy spawn in the file by its timeout N:
#   N <= FAIL_THRESHOLD            -> prints "FAIL <reason>", exit 0
#   FAIL_THRESHOLD < N <= WARN     -> prints "WARN <reason>", exit 0
#   N > WARN                       -> not a candidate, exit 1
#   file could not be read         -> prints "UNMEASURED <code>", exit 2
# FAIL takes precedence over WARN when both bands are present in one file.
#
# Exit 1 means MEASURED and clean; anything above it means the file has no verdict at all.
# node exits 1 for an uncaught throw too, so without the split a file this scan could not read
# scored exactly like a file it read and cleared -- AP-EXT-ITER224-01's rule (nothing measured is
# not a clean verdict) one level down, at the per-FILE arm rather than the whole-run one. The 1-vs-2
# idiom is the one bin/release-gate.sh already uses for the same defect class. The caller tests
# `> 1` rather than `= 2`, so an OOM or a signal (134/137) is unmeasured too without enumerating it.
find_heavy_candidate() {
  local file="$1"
  local fail_ms="$2"
  local warn_ms="$3"
  node - "$file" "$fail_ms" "$warn_ms" <<'NODE'
const fs = require('fs');
const [, , filePath, failMs, warnMs] = process.argv;
const FAIL_THRESHOLD = parseInt(failMs, 10);
const WARN_THRESHOLD = parseInt(warnMs, 10);
let content;
try {
  content = fs.readFileSync(filePath, 'utf8');
} catch (err) {
  // stdout, not stderr: the caller captures stdout and discards stderr, so this is the one
  // channel that can carry WHY the file has no verdict back to the operator.
  process.stdout.write(`UNMEASURED ${(err && err.code) || 'read failed'}\n`);
  process.exit(2);
}

// Skip @tier: expensive — not part of the --test-concurrency=8 surface.
const firstLine = content.split('\n')[0];
if (firstLine.includes('@tier: expensive')) process.exit(1);

// SUBPROCESS_HEAVY_PATTERN:
//   <spawnFn>(<program>, [nonFlagFirstArg, ...]) with explicit timeout
//
// The '-' exclusion prevents false positives on inline commands like:
//   spawnSync('bash', ['-lc', 'command -v git'])
//   spawnSync('bash', ['-c', 'echo test'])
const SPAWN_FNS = 'spawnSync|execFileSync|execFile|spawn|fork';
const spawnRe = new RegExp(
  String.raw`\b(?:${SPAWN_FNS})\s*\(\s*([^,()]+?)\s*,\s*\[(?!\s*['"][^'"]*-)`,
  'g',
);
const SHELL_PROGRAM_RE = /^['"](?:bash|sh)['"]$/;
let warnReason = null; // first WARN-band candidate, used only if no FAIL found
let m;
while ((m = spawnRe.exec(content)) !== null) {
  const program = m[1].trim();
  const block = content.slice(m.index, m.index + 600);
  const timeoutMatch = block.match(/\btimeout\s*:\s*([0-9][0-9_]*)\b/);
  if (!timeoutMatch) continue; // no explicit / no statically-readable timeout
  const t = parseInt(timeoutMatch[1].replace(/_/g, ''), 10);
  const isShell = SHELL_PROGRAM_RE.test(program);
  // The FAIL reason keeps its shipped wording — tests/audit-subprocess-heavy-tests.test.js:26
  // pins "subprocess-heavy candidate not serialized", and the FAIL band's scope is unchanged.
  if (isShell && t <= FAIL_THRESHOLD) {
    process.stdout.write(`FAIL spawnSync(bash/sh, script, { timeout: ${t} })\n`);
    process.exit(0);
  }
  if (t <= WARN_THRESHOLD && warnReason === null) {
    // remember; keep scanning in case a FAIL-band spawn exists
    warnReason = `spawn(${program}, script, { timeout: ${t} })`;
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
# Every @tier: fast file this run classified load-sensitive — the DERIVED verdict, collected
# whether or not it is already in the manifest, so --emit-fast-manifest writes the full floor.
FAST_LOAD_SENSITIVE=()

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
  # LOCAL refusal only: this script's own exit code. It breaks no loop (PRIME DIRECTIVE).
  if [ "$candidate_exit" -gt 1 ]; then
    echo "$file_rel: subprocess-heavy classification could not read the file (${candidate_out:-no diagnostic}) - nothing was measured, so this file has no verdict" >&2
    status=1
    return
  fi
  [ "$candidate_exit" -ne 0 ] && return

  local candidate_tag="${candidate_out%% *}"      # FAIL | WARN
  local candidate_reason="${candidate_out#* }"    # reason string

  # AC-A1a — the fast tier's producer/consumer seam. For @tier: fast the WARN band stops being
  # advice and becomes a gate: a load-sensitive file absent from tests/.serial-tests.json FAILS.
  #
  # Neither the integration manifest nor a `// SERIAL:` marker substitutes here, and that is the
  # point rather than an oversight: only membership in the manifest `test:fast:serial` names
  # actually moves a fast test out of the c=8 pool. Accepting either as a silencer would recreate
  # exactly the defect this ticket closes — an annotation that reads as serialized while the test
  # still runs at full concurrency.
  #
  # This is a LOCAL refusal: it sets `status`, which this script returns. It breaks no loop and
  # terminates no pipeline (PRIME DIRECTIVE).
  # `file_rel` is only a MANIFEST KEY when the prefix strip above actually fired — i.e. the file
  # lives under $EXTENSION_ROOT. Under `--scan-root <tmpdir>` it stays absolute, and a file outside
  # the repo can never be listed in a repo manifest, so AC-A1a must not demand it. Those files fall
  # through to the advisory WARN, which is the honest verdict for a synthetic fixture.
  if [ "$candidate_tag" = "WARN" ] && [ "$file_rel" != "$file" ] && [ "$(declared_tier "$file")" = "fast" ]; then
    FAST_LOAD_SENSITIVE+=("$file_rel")
    if is_in_manifest "$file_rel" "$FAST_SERIAL_MANIFEST_PATH"; then
      return
    fi
    echo "$file_rel: load-sensitive subprocess spawn ($candidate_reason) missing from tests/.serial-tests.json — it would run in the --test-concurrency=8 pool; add it (bash scripts/audit-subprocess-heavy-tests.sh --emit-fast-manifest)" >&2
    # Recorded SEPARATELY from `status`, never folded into it here. --emit-fast-manifest resolves
    # exactly this failure and must be able to clear it without also clearing an unrelated red
    # (a missing-timeout callsite, an unprovisioned binary) — a blanket `status=0` after emit would
    # turn the emit flag into a way to green the whole audit.
    a1a_status=1
    return
  fi

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

# NOTHING MEASURED IS NOT A CLEAN VERDICT. Every predicate below is derived from
# AUDITED_FILES, so an empty list disarms all of them and the tail would print
# "audit-subprocess-heavy-tests: OK" over a run that examined no file at all --
# on a script the release gate and `pretest:integration` both chain with &&.
# One check covers every producer of the empty list: a scan root holding zero
# *.test.js, one holding only pruned tests/fixtures/**, and a $TEST_ROOT `find`
# could not read (its status is unreadable from the process substitution above).
# The not-deployed case already exited 0 at the `-d "$TEST_ROOT"` guard, so
# reaching this line with zero files is always a defect, never a deployment shape.
# LOCAL refusal only: this script's own exit code. It breaks no loop (PRIME DIRECTIVE).
if [ "${#AUDITED_FILES[@]}" -eq 0 ]; then
  echo "[error: no *.test.js audited under $TEST_ROOT - nothing was measured, so this audit has no verdict]" >&2
  exit 1
fi

# Missing-timeout predicate (R-TFP-C2 extension): the whole child_process
# family, grandfathered against a committed baseline so pre-existing debt
# does not redden this gate. Only callsites absent from the baseline fail.
if command -v node >/dev/null 2>&1; then
  # stderr is NOT discarded: it is the only channel carrying WHY a scan did not complete, and
  # the scanner writes nothing to it on a run that did.
  missing_timeout_out="$(node "$MISSING_TIMEOUT_SCANNER" --baseline "$MISSING_TIMEOUT_BASELINE" --base "$EXTENSION_ROOT" "${AUDITED_FILES[@]}")"
  missing_timeout_exit=$?
  # Measured-vs-unmeasured split, as `find_heavy_candidate` spends it one arm up: exit 1 means the
  # scan completed and put its findings on stdout, anything above it means it did not complete.
  # Folding the two together printed nothing at all for a crash -- status=1 with no line naming a
  # cause. LOCAL refusal only: this sets this script's exit code and breaks no loop (PRIME DIRECTIVE).
  if [ "$missing_timeout_exit" -gt 1 ]; then
    echo "[error: missing-timeout predicate did not complete (exit $missing_timeout_exit) - nothing was measured, so this predicate has no verdict]" >&2
    status=1
  elif [ "$missing_timeout_exit" -ne 0 ]; then
    while IFS=$'\t' read -r mt_file mt_fn mt_key; do
      [ -z "$mt_file" ] && continue
      echo "$mt_file: new missing-timeout $mt_fn(...) callsite not in baseline ($mt_key)" >&2
    done <<< "$missing_timeout_out"
    status=1
  fi
fi

# Unprovisioned-binary predicate: a test must not spawn a binary the CI/release
# workflows do not install (e.g. ripgrep). Such a call site is green on a dev box
# that happens to have the tool and ENOENT in CI. The tool list is imported by the
# scanner from services/verify-command-safety.js -- not re-enumerated here.
#
# NOTE: deliberately NOT gated on the SERIAL allowlist above. Serialization and
# binary provisioning are orthogonal, and tests/integration/mega-bundle-e2e.test.js
# -- the file whose ripgrep spawn motivated this predicate -- is in the serial
# manifest, so sharing that allowlist would blind this check to the original bug.
if [ ! -f "$UNPROVISIONED_SCANNER" ]; then
  # Absent scanner is an ERROR, never a skip: a silent skip would print
  # "audit-subprocess-heavy-tests: OK" with this predicate disarmed.
  echo "[error: $UNPROVISIONED_SCANNER not found — unprovisioned-binary predicate cannot run]" >&2
  status=1
else
  # stderr kept for the same reason as the missing-timeout arm above.
  unprovisioned_out="$(node "$UNPROVISIONED_SCANNER" --base "$EXTENSION_ROOT" "${AUDITED_FILES[@]}")"
  unprovisioned_exit=$?
  if [ "$unprovisioned_exit" -gt 1 ]; then
    echo "[error: unprovisioned-binary predicate did not complete (exit $unprovisioned_exit) - nothing was measured, so this predicate has no verdict]" >&2
    status=1
  elif [ "$unprovisioned_exit" -ne 0 ]; then
    while IFS=$'\t' read -r up_file up_tool up_line; do
      [ -z "$up_file" ] && continue
      echo "$up_file:$up_line: spawns unprovisioned binary '$up_tool' (not provisioned by .github/workflows/*.yml); remove the dependency or mark the guarded call site PROVISIONED-OK" >&2
    done <<< "$unprovisioned_out"
    status=1
  fi
fi

# --emit-fast-manifest: write the UNION of this run's derived verdict and the manifest's
# existing entries. Union rather than replacement is what makes regeneration safe to run at
# any time: it can raise the floor but never drop an entry that a measurement (rather than the
# static verdict) put there. Runs only under the explicit flag, and clears the AC-A1a failures
# it just resolved so emit-then-report is a single coherent verdict.
if [ "$EMIT_FAST_MANIFEST" -eq 1 ]; then
  node - "$FAST_SERIAL_MANIFEST_PATH" ${FAST_LOAD_SENSITIVE[@]+"${FAST_LOAD_SENSITIVE[@]}"} <<'NODE'
const fs = require('fs');
const [, , manifestPath, ...derived] = process.argv;
let current = {};
try {
  current = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) ?? {};
} catch {
  current = {};
}
const entries = [...new Set([...(current.entries ?? []), ...derived])].sort();
// Spread `current` first so sibling keys (the `_evidence` rationale for entries the static
// verdict cannot derive) survive regeneration. Rewriting `{ entries }` alone would delete the
// only record of WHY those entries exist, on a command whose whole purpose is to be safe to re-run.
fs.writeFileSync(manifestPath, `${JSON.stringify({ ...current, entries }, null, 2)}\n`);
process.stderr.write(`audit-subprocess-heavy-tests: wrote ${entries.length} entries to ${manifestPath}\n`);
NODE
  emit_exit=$?
  if [ "$emit_exit" -ne 0 ]; then
    echo "[error: --emit-fast-manifest failed to write $FAST_SERIAL_MANIFEST_PATH]" >&2
    exit 1
  fi
else
  # Not emitting: the AC-A1a verdict is part of the audit's exit code.
  [ "$a1a_status" -ne 0 ] && status=1
fi

if [ "$status" -eq 0 ]; then
  echo "audit-subprocess-heavy-tests: OK" >&2
fi

exit "$status"
