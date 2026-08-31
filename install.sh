#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ALLOW_DOWNGRADE=0
OVERRIDE_ACTIVE=0
CLOSER_CONTEXT=0
NO_CONFIRM=0
DRY_RUN=0
PREFIX=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-downgrade) ALLOW_DOWNGRADE=1; shift ;;
    --no-confirm) NO_CONFIRM=1; shift ;;
    --override-active) OVERRIDE_ACTIVE=1; shift ;;
    --closer-context) CLOSER_CONTEXT=1; shift ;;
    --dry-ru[n]) DRY_RUN=1; shift ;;
    --force) shift ;;
    --prefix)
      if [[ -z "${2:-}" ]]; then
        echo "❌ --prefix requires a non-empty directory argument" >&2; exit 2
      fi
      PREFIX="$2"; shift 2 ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done
INVOCATION="$0 $*"

PICKLE_INSTALL_ROOT="${PREFIX:-$HOME/.claude/pickle-rick}"
EXTENSION_ROOT="${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}"
COMMANDS_DIR="${PICKLE_INSTALL_ROOT}/../commands"
SETTINGS_FILE="${PICKLE_INSTALL_ROOT}/../settings.json"
# IMPORTANT: ${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick} is intentionally
# a literal here — it gets expanded at hook-invocation time by the shell.
HOOK_CMD_LITERAL='node ${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}/extension/hooks/dispatch.js stop-hook'

md5_file() {
  local f="$1"
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$f" 2>/dev/null | awk '{print $1}'
  elif command -v md5 >/dev/null 2>&1; then
    md5 -q "$f" 2>/dev/null
  else
    echo ""
  fi
}

compare_semver() {
  local a="$1"
  local b="$2"
  local semver_re='^[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z-]+[.][0-9]+)?$'
  if [[ ! "$a" =~ $semver_re ]] || [[ ! "$b" =~ $semver_re ]]; then
    echo "❌ Invalid semver comparison: '$a' vs '$b'" >&2
    return 1
  fi

  local a_core="${a%%-*}" b_core="${b%%-*}"
  local a_pre="" b_pre=""
  [[ "$a" == *-* ]] && a_pre="${a#*-}"
  [[ "$b" == *-* ]] && b_pre="${b#*-}"

  local a_major a_minor a_patch b_major b_minor b_patch
  IFS=. read -r a_major a_minor a_patch <<< "$a_core"
  IFS=. read -r b_major b_minor b_patch <<< "$b_core"

  if (( 10#$a_major < 10#$b_major )); then echo -1; return; fi
  if (( 10#$a_major > 10#$b_major )); then echo 1; return; fi
  if (( 10#$a_minor < 10#$b_minor )); then echo -1; return; fi
  if (( 10#$a_minor > 10#$b_minor )); then echo 1; return; fi
  if (( 10#$a_patch < 10#$b_patch )); then echo -1; return; fi
  if (( 10#$a_patch > 10#$b_patch )); then echo 1; return; fi

  # Triplet equal — mirror check-update.ts:comparePrerelease (release > prerelease;
  # ident compared lexically first, then num numerically).
  if [ -z "$a_pre" ] && [ -z "$b_pre" ]; then echo 0; return; fi
  if [ -z "$a_pre" ]; then echo 1; return; fi
  if [ -z "$b_pre" ]; then echo -1; return; fi

  local a_ident="${a_pre%%.*}" b_ident="${b_pre%%.*}"
  local a_num="${a_pre##*.}" b_num="${b_pre##*.}"
  if [ "$a_ident" != "$b_ident" ]; then
    if [[ "$a_ident" < "$b_ident" ]]; then echo -1; else echo 1; fi
    return
  fi
  if (( 10#$a_num < 10#$b_num )); then echo -1; return; fi
  if (( 10#$a_num > 10#$b_num )); then echo 1; return; fi
  echo 0
}

read_package_version() {
  local package_json="$1"
  local version
  version="$(jq -r '.version' "$package_json")"
  if [ -z "$version" ] || [ "$version" = "null" ]; then
    echo "❌ Could not read version from $package_json" >&2
    exit 1
  fi
  echo "$version"
}

append_downgrade_audit() {
  local session_id="$1"
  local audit_file="$EXTENSION_ROOT/deploy-audit.log"
  mkdir -p "$EXTENSION_ROOT"
  if [ ! -e "$audit_file" ]; then
    : > "$audit_file"
    chmod 600 "$audit_file"
  fi
  jq -nc \
    --arg event "DOWNGRADE" \
    --arg src_version "$SRC_V" \
    --arg dep_version "$DEP_V" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg operator "${USER:-${LOGNAME:-}}" \
    --arg invocation "$INVOCATION" \
    --arg session_id "$session_id" \
    --arg override_active "$OVERRIDE_ACTIVE" \
    --arg no_confirm "$NO_CONFIRM" \
    --arg closer_context "$CLOSER_CONTEXT" \
    '{
      event: $event,
      src_version: $src_version,
      dep_version: $dep_version,
      ts: $ts,
      operator: $operator,
      invocation: $invocation,
      session_id: (if $session_id == "" then null else $session_id end),
      override_active: ($override_active == "1"),
      no_confirm: ($no_confirm == "1"),
      closer_context: ($closer_context == "1")
    }' >> "$audit_file"
  chmod 600 "$audit_file"
}

append_bypass_active_session_audit() {
  local session_id="$1"
  local audit_file="$EXTENSION_ROOT/deploy-audit.log"
  mkdir -p "$EXTENSION_ROOT"
  if [ ! -e "$audit_file" ]; then
    : > "$audit_file"
    chmod 600 "$audit_file"
  fi
  jq -nc \
    --arg event "INSTALL_BYPASS_ACTIVE_SESSION" \
    --arg src_version "$SRC_V" \
    --arg dep_version "$DEP_V" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg operator "${USER:-${LOGNAME:-}}" \
    --arg invocation "$INVOCATION" \
    --arg session_id "$session_id" \
    --arg override_active "$OVERRIDE_ACTIVE" \
    --arg no_confirm "$NO_CONFIRM" \
    --arg closer_context "$CLOSER_CONTEXT" \
    '{
      event: $event,
      src_version: $src_version,
      dep_version: $dep_version,
      ts: $ts,
      operator: $operator,
      invocation: $invocation,
      session_id: (if $session_id == "" then null else $session_id end),
      override_active: ($override_active == "1"),
      no_confirm: ($no_confirm == "1"),
      closer_context: ($closer_context == "1")
    }' >> "$audit_file"
  chmod 600 "$audit_file"
}

find_active_session() {
  local data_root sessions_root state_file active session_id
  data_root="${PICKLE_DATA_ROOT:-$HOME/.local/share/pickle-rick}"
  sessions_root="$data_root/sessions"
  [ -d "$sessions_root" ] || return 1

  for state_file in "$sessions_root"/*/state.json; do
    [ -e "$state_file" ] || return 1
    if ! active="$(jq -r 'if .active == true then "true" else "false" end' "$state_file" 2>/dev/null)"; then
      echo "WARNING: malformed state.json skipped: $state_file" >&2
      continue
    fi
    [ "$active" = "true" ] || continue

    session_id="$(jq -r '.session_id // empty' "$state_file" 2>/dev/null || true)"
    [ -n "$session_id" ] || session_id="$(basename "$(dirname "$state_file")")"
    echo "$session_id"
    return 0
  done
  return 1
}

handle_allowed_downgrade() {
  local session_id=""
  if session_id="$(find_active_session)"; then
    if [ "$OVERRIDE_ACTIVE" -ne 1 ] && [ "$CLOSER_CONTEXT" -ne 1 ]; then
      echo "REFUSE: active session $session_id — kill the pipeline first or pass --override-active" >&2
      exit 2
    fi
  fi

  if [ "$NO_CONFIRM" -ne 1 ]; then
    printf 'Downgrade %s → %s — proceed? [y/N] ' "$DEP_V" "$SRC_V" >&2
    local answer=""
    IFS= read -r answer || true
    if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
      exit 0
    fi
  fi

  append_downgrade_audit "$session_id"
}

SRC_V="$(read_package_version "$SCRIPT_DIR/extension/package.json")"
DEPLOYED_PACKAGE_JSON="$EXTENSION_ROOT/extension/package.json"
if [ -f "$DEPLOYED_PACKAGE_JSON" ]; then
  DEP_V="$(read_package_version "$DEPLOYED_PACKAGE_JSON")"
  if ! cmp="$(compare_semver "$SRC_V" "$DEP_V")"; then
    exit 1
  elif [ "$cmp" -lt 0 ]; then
    if [ "$ALLOW_DOWNGRADE" -ne 1 ]; then
      echo "REFUSE: source v$SRC_V older than deployed v$DEP_V" >&2
      exit 1
    fi
    handle_allowed_downgrade "$@"
  fi
fi

check_worktree_head_fresh() {
  local inside_work_tree wt_top WT_HEAD
  inside_work_tree="$(git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree 2>/dev/null || true)"
  [ "$inside_work_tree" = "true" ] || return 0

  wt_top="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  case "$wt_top" in
    */.claude/worktrees/agent-*) ;;
    *) return 0 ;;
  esac

  WT_HEAD="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD)"
  if ! git -C "$SCRIPT_DIR" merge-base --is-ancestor origin/main HEAD; then
    echo "REFUSE: worktree HEAD $WT_HEAD predates main; pull main first" >&2
    exit 1
  fi
}

check_worktree_head_fresh

# --- LOCK (Forward Fix F2: serialize concurrent install.sh invocations) ---
# Cross-skill workers can run install.sh simultaneously, racing on settings.json
# backup + jq-merge and producing paired backups seconds apart. Acquire an
# exclusive lock for the lifetime of the script.
mkdir -p "$EXTENSION_ROOT"
LOCKFILE="$EXTENSION_ROOT/.install.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE"
  if ! flock -x -n 9; then
    echo "⏳ Another install.sh is running; waiting for lock..."
    flock -x 9
  fi
else
  # Portable fallback for systems without flock(1) (e.g. stock macOS):
  # mkdir is atomic on POSIX filesystems, so it doubles as a lock primitive.
  LOCKDIR="$EXTENSION_ROOT/.install.lock.d"
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    echo "⏳ Another install.sh is running; waiting..."
    sleep 1
  done
  trap 'rmdir "$LOCKDIR"' EXIT
fi

# --- DRY RUN ---
# Handles --dry-run only after lock acquisition.
# Test hook: exits cleanly after lock acquisition so concurrent-invocation
# tests can verify serialization without performing any deploy actions.
if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry run, skipping"
  exit 0
fi

echo "🥒 Installing Pickle Rick for Claude Code..."

# --- ACTIVE-BUNDLE GUARD (R-ITS-5-MIN) ---
# Refuse install.sh when any session is active=true. Pre-fix, an operator
# running install.sh during a live bundle replaced compiled JS in-place
# while the running mux-runner held old code in-memory; new spawns picked
# up new code; the runtime mismatch produced bizarre cross-version bugs
# that took hours to forensic. --override-active and --closer-context
# bypass the guard (closer-release-gate.sh sets the latter).
if active_session_id="$(find_active_session)"; then
  if [ "$OVERRIDE_ACTIVE" -ne 1 ] && [ "$CLOSER_CONTEXT" -ne 1 ]; then
    echo "❌ REFUSE: install.sh blocked — active session $active_session_id is in flight." >&2
    echo "   Mid-bundle install replaces compiled JS while the running mux-runner" >&2
    echo "   holds old code in-memory; new spawns get new code; the version skew" >&2
    echo "   produces cross-state bugs (R-ITS-5-MIN forensic). Either:" >&2
    echo "     1. Wait for the bundle to complete (tmux attach -t pipeline-...)," >&2
    echo "     2. Cancel via 'pickle-rick cancel' first, or" >&2
    echo "     3. Pass --override-active if you understand the consequences." >&2
    exit 2
  fi
  # Bypass path: --override-active or --closer-context set AND a session is live.
  # Emit the documented INSTALL_BYPASS_ACTIVE_SESSION audit event, then proceed.
  append_bypass_active_session_audit "$active_session_id"
fi

# --- VALIDATION ---
node --version >/dev/null 2>&1    || { echo "❌ node not found on PATH"; exit 1; }
jq --version >/dev/null 2>&1     || { echo "❌ jq not found on PATH"; exit 1; }
rsync --version >/dev/null 2>&1  || { echo "❌ rsync not found on PATH"; exit 1; }
claude --version >/dev/null 2>&1 || echo "⚠️  claude CLI not on PATH (needed at runtime for worker spawning)"
bun --version >/dev/null 2>&1    || echo "WARNING: bun not found. Plumbus generative audit is running in degraded mode. Install bun for full analysis."
if [ ! -f "$SETTINGS_FILE" ]; then
  if [ "${PICKLE_INSTALL_ROOT}" = "${HOME}/.claude/pickle-rick" ]; then
    echo "❌ ~/.claude/settings.json not found. Run 'claude' at least once first."; exit 1
  else
    mkdir -p "$(dirname "$SETTINGS_FILE")"
    echo '{}' > "$SETTINGS_FILE"
  fi
fi
jq . "$SETTINGS_FILE" >/dev/null 2>&1 || { echo "❌ settings.json is not valid JSON"; exit 1; }
[ -d "$SCRIPT_DIR/extension" ]   || { echo "❌ extension/ not found. Are you running from the repo root?"; exit 1; }
[ -d "$SCRIPT_DIR/.claude/commands" ] || { echo "❌ .claude/commands/ not found. Are you running from the repo root?"; exit 1; }

# --- MODE DETECTION ---
# `-e`, not `-d`: in a git WORKTREE `.git` is a FILE (a gitdir: pointer), not a directory. Testing
# for a directory silently fell through to tarball mode there — which skips the codegraph symlinks
# and then lets the deploy-root `npm install --omit=dev` prune the `typescript` symlink as
# extraneous, leaving the deployed pipeline-runner unloadable (ERR_MODULE_NOT_FOUND). It failed
# loudly in the tests and SILENTLY for anyone installing from a worktree.
if [ -e "$SCRIPT_DIR/.git" ]; then
  INSTALL_MODE="git"
else
  INSTALL_MODE="tarball"
fi
echo "[install.sh] Mode: $INSTALL_MODE" >&2

# --- COMPILE (git mode only) ---
if [ "$INSTALL_MODE" = "git" ]; then
  echo "📦 Installing dependencies..."
  (cd "$SCRIPT_DIR/extension" && npm install --no-fund --no-audit)
  rm -f "$SCRIPT_DIR/extension/.tsbuildinfo" 2>/dev/null || true
  echo "🔨 Compiling TypeScript..."
  (cd "$SCRIPT_DIR/extension" && npx tsc)
  # Sanity check: compiled JS schemaVersion must match source TS
  SOURCE_VERSION=$(grep -oE 'schemaVersion: [0-9]+' "$SCRIPT_DIR/extension/src/types/index.ts" | head -1 | awk '{print $2}')
  COMPILED_VERSION=$(grep -oE 'schemaVersion: [0-9]+' "$SCRIPT_DIR/extension/types/index.js" | head -1 | awk '{print $2}')
  if [ -z "$SOURCE_VERSION" ] || [ -z "$COMPILED_VERSION" ]; then
    echo "❌ Could not extract schemaVersion from source or compiled types/index. Refusing to deploy." >&2
    exit 1
  fi
  if [ "$SOURCE_VERSION" != "$COMPILED_VERSION" ]; then
    echo "❌ Compiled JS schemaVersion ($COMPILED_VERSION) does not match source TS ($SOURCE_VERSION)." >&2
    echo "   Likely cause: stale tsc build cache. Try: rm extension/types/index.js && bash install.sh" >&2
    exit 1
  fi
else
  echo "[install.sh] Skipping compilation (pre-built tarball)" >&2
fi

# --- BACKUP ---
if [ "${PICKLE_INSTALL_ROOT}" = "${HOME}/.claude/pickle-rick" ]; then
  mkdir -p "$HOME/.claude/backups"
  cp "$SETTINGS_FILE" "$HOME/.claude/backups/settings.json.pickle-backup.$(date +%s)"
  echo "✅ Backed up settings.json to ~/.claude/backups/"
fi

# --- DIRECTORIES ---
mkdir -p "$EXTENSION_ROOT" "$COMMANDS_DIR" "$EXTENSION_ROOT/activity" "$EXTENSION_ROOT/templates"
chmod 700 "$EXTENSION_ROOT/activity"
# Stage install-root sentinel so getExtensionRoot() accepts this prefix before rsync completes
touch "${PICKLE_INSTALL_ROOT}/.pickle-install-root"

# --- EXTENSION SCRIPTS ---
# rsync compiled JS runtime files; exclude TS sources, tests, and dev-only files.
# --delete removes stale files from the destination (e.g. deleted scripts).
# package.json is included — required for ESM "type":"module".
rsync -a --delete --delete-excluded \
  --exclude='node_modules' \
  --exclude='src' \
  --exclude='tests' \
  --exclude='tsconfig.json' \
  --exclude='package-lock.json' \
  --exclude='.pickle-rick' \
  --exclude='.codegraph' \
  "$SCRIPT_DIR/extension/" "$EXTENSION_ROOT/extension/"

# Deploy real schema bytes to deployed extension root, overwriting the $ref stub (R-LASP-1-CC).
# install.sh excludes src/ from rsync, so the real 57KB schema must be copied explicitly.
_schema_src="$SCRIPT_DIR/extension/src/types/activity-events.schema.json"
if [ -f "$_schema_src" ]; then
  echo "📋 Deploying activity-events schema…"
  cp "$_schema_src" "$EXTENSION_ROOT/extension/activity-events.schema.json"
fi

# --- RUNTIME DEPS ---
# Some compiled JS modules (e.g. citadel/frontend-prop-drift-audit.js) import
# packages from extension/node_modules at module-load. Since rsync excludes
# node_modules, symlink the specific runtime deps the deployed code needs.
# Recreated each install.sh run because --delete-excluded above blows them away.
# Runs BEFORE the parity probe below, which executes deployed JS that needs
# these symlinks to load (R-ITS-2 vs C1: a probe that runs before its own
# dependencies exist can crash on a tree that would otherwise install fine).
mkdir -p "$EXTENSION_ROOT/extension/node_modules"
for dep in typescript; do
  if [ -d "$SCRIPT_DIR/extension/node_modules/$dep" ]; then
    ln -sfn "$SCRIPT_DIR/extension/node_modules/$dep" "$EXTENSION_ROOT/extension/node_modules/$dep"
  fi
done

# --- CODEGRAPH RUNTIME DEP (per-mode; recreated each run — rsync deletes node_modules) ---
# @colbymchenry/codegraph is a SCOPED package with a platform-specific native
# binding; the flat-name loop above cannot express the @colbymchenry/ layout, so
# deploy it explicitly per mode. Git: symlink the scoped main package + the one
# resolved platform binding from SOURCE node_modules. Tarball: npm install at the
# deploy root (no lockfile reaches the deploy tree by design — npm ci impossible
# there; lockfile staying rsync-excluded is intentional, NOT a bug to "fix").
_codegraph_scope="$EXTENSION_ROOT/extension/node_modules/@colbymchenry"
if [ "$INSTALL_MODE" = "git" ]; then
  mkdir -p "$_codegraph_scope"
  _cg_src="$SCRIPT_DIR/extension/node_modules/@colbymchenry/codegraph"
  if [ -d "$_cg_src" ]; then
    ln -sfn "$_cg_src" "$_codegraph_scope/codegraph"
  fi
  # Resolve the ONE platform binding present in source node_modules generically
  # (0.9.9 ships six platform optionalDependencies; npm installs only the
  # host-matching one — do not hardcode darwin-arm64).
  for _cg_plat in "$SCRIPT_DIR"/extension/node_modules/@colbymchenry/codegraph-*-*; do
    [ -d "$_cg_plat" ] || continue
    ln -sfn "$_cg_plat" "$_codegraph_scope/$(basename "$_cg_plat")"
  done
else
  echo "📦 Installing @colbymchenry/codegraph@0.9.9 at deploy root (tarball mode)…"
  (cd "$EXTENSION_ROOT/extension" && npm install --omit=dev --no-save @colbymchenry/codegraph@0.9.9 --no-fund --no-audit)
fi

# Self-probe (both modes): the deployed tree MUST resolve the scoped package, or
# the deploy is broken and we abort loudly at install time, not at session time.
if ! (cd "$EXTENSION_ROOT/extension" && node -e "import('@colbymchenry/codegraph').then(()=>process.exit(0),()=>process.exit(1))"); then
  echo "❌ FATAL: @colbymchenry/codegraph does not resolve from the deployed extension root ($EXTENSION_ROOT/extension)." >&2
  echo "   Mode: $INSTALL_MODE. The deploy cannot self-verify its codegraph runtime dependency; aborting." >&2
  exit 1
fi
echo "OK codegraph"

# --- POST-RSYNC MD5 PARITY PROBE (R-ITS-2) ---
# Verifies source-built and deployed copies of the most-trafficked compiled
# JS files are byte-identical after rsync. Mismatch → exit 1 with diff list.
# Set INSTALL_SKIP_PARITY=1 to bypass for emergency deploys.
if [ "${INSTALL_SKIP_PARITY:-0}" != "1" ] && [ "$INSTALL_MODE" = "git" ]; then
  _parity_files=(
    "types/index.js"
    "services/state-manager.js"
    "bin/spawn-morty.js"
    "bin/mux-runner.js"
    "services/pickle-utils.js"
    "bin/spawn-refinement-team.js"
    "bin/microverse-runner.js"
    "bin/spawn-gate-remediator.js"
  )
  _mismatches=()
  for _f in "${_parity_files[@]}"; do
    _src_md5=$(md5_file "$SCRIPT_DIR/extension/$_f")
    _dst_md5=$(md5_file "$EXTENSION_ROOT/extension/$_f")
    if [ -n "$_src_md5" ] && [ -n "$_dst_md5" ] && [ "$_src_md5" != "$_dst_md5" ]; then
      _mismatches+=("$_f (src=$_src_md5 dst=$_dst_md5)")
    fi
  done
  _parity_files_json="$(printf '%s\n' "${_parity_files[@]}" | jq -R . | jq -s .)"
  if [ ${#_mismatches[@]} -gt 0 ]; then
    echo "❌ FAIL: install.sh parity probe found ${#_mismatches[@]} mismatch(es):" >&2
    printf '  - %s\n' "${_mismatches[@]}" >&2
    _mismatches_json="$(printf '%s\n' "${_mismatches[@]}" | jq -R . | jq -s .)"
    _parity_payload="$(jq -nc \
      --argjson files_checked "$_parity_files_json" \
      --argjson mismatches "$_mismatches_json" \
      --arg status fail \
      '{files_checked: $files_checked, mismatches: $mismatches, status: $status}')"
    node "${EXTENSION_ROOT}/extension/bin/log-activity.js" install_sh_parity_check \
      "parity=fail mismatches=${#_mismatches[@]}" \
      --gate-payload "$_parity_payload" 2>/dev/null || true
    exit 1
  fi
  _parity_payload="$(jq -nc \
    --argjson files_checked "$_parity_files_json" \
    --arg status pass \
    '{files_checked: $files_checked, mismatches: [], status: $status}')"
  node "${EXTENSION_ROOT}/extension/bin/log-activity.js" install_sh_parity_check \
    "parity=pass files_checked=${#_parity_files[@]}" \
    --gate-payload "$_parity_payload" 2>/dev/null || true
fi

DEPLOYED_V="$(read_package_version "$EXTENSION_ROOT/extension/package.json")"
UPDATE_CACHE_FILE="$EXTENSION_ROOT/update-check.json"
if [ -f "$UPDATE_CACHE_FILE" ]; then
  CACHE_CURRENT_VERSION="$(jq -r '.current_version // ""' "$UPDATE_CACHE_FILE" 2>/dev/null || echo "")"
  if [ "$CACHE_CURRENT_VERSION" = "1.0.0" ] || [ "$CACHE_CURRENT_VERSION" != "$DEPLOYED_V" ]; then
    rm -f "$UPDATE_CACHE_FILE"
    echo "[install.sh] Removed stale update cache: cached current_version=${CACHE_CURRENT_VERSION:-<missing>} deployed=$DEPLOYED_V" >&2
  fi
fi

# Merge pickle_settings: repo defaults as base, user values overlaid (preserves customizations)
if [ -f "$EXTENSION_ROOT/pickle_settings.json" ]; then
  TMPFILE="$(mktemp)"
  jq -s '.[0] * .[1]' "$SCRIPT_DIR/pickle_settings.json" "$EXTENSION_ROOT/pickle_settings.json" > "$TMPFILE" \
    && mv "$TMPFILE" "$EXTENSION_ROOT/pickle_settings.json"
else
  cp "$SCRIPT_DIR/pickle_settings.json" "$EXTENSION_ROOT/"
fi

# --- MANAGED_KEYS: force code-owned settings source-authoritative ---
# The merge above lets a stale deployed value survive when source omits the
# key (object merge: right/deployed operand always wins per-key; absence
# can't unset). These 5 keys are compiled defaults with no operator-tuning
# story, so force them post-merge on BOTH paths above:
#   worker_test_gate_timeout_ms (deleted), codegraph.enabled,
#   codegraph.index_at_setup, codegraph.expose_mcp_to_workers, auto_update_enabled
# — per-path jq only (never `.codegraph = {...}`, which would destroy sibling
# tunables like staleness_max_age_minutes/context_max_bytes/*_timeout_ms).
_managed_before_timeout="$(jq -r 'if .worker_test_gate_timeout_ms == null then "null" else (.worker_test_gate_timeout_ms | tostring) end' "$EXTENSION_ROOT/pickle_settings.json")"
_managed_before_cg_enabled="$(jq -r 'if .codegraph.enabled == null then "null" else (.codegraph.enabled | tostring) end' "$EXTENSION_ROOT/pickle_settings.json")"
_managed_before_cg_setup="$(jq -r 'if .codegraph.index_at_setup == null then "null" else (.codegraph.index_at_setup | tostring) end' "$EXTENSION_ROOT/pickle_settings.json")"
_managed_before_cg_expose="$(jq -r 'if .codegraph.expose_mcp_to_workers == null then "null" else (.codegraph.expose_mcp_to_workers | tostring) end' "$EXTENSION_ROOT/pickle_settings.json")"
_managed_before_auto_update="$(jq -r 'if .auto_update_enabled == null then "null" else (.auto_update_enabled | tostring) end' "$EXTENSION_ROOT/pickle_settings.json")"

TMPFILE="$(mktemp)"
jq 'del(.worker_test_gate_timeout_ms) | .codegraph.enabled = true | .codegraph.index_at_setup = true | .codegraph.expose_mcp_to_workers = true | .auto_update_enabled = false' \
  "$EXTENSION_ROOT/pickle_settings.json" > "$TMPFILE" \
  && mv "$TMPFILE" "$EXTENSION_ROOT/pickle_settings.json"

if [ "$_managed_before_timeout" != "null" ]; then
  echo "[install.sh] MANAGED_KEYS forced worker_test_gate_timeout_ms: ${_managed_before_timeout} -> deleted" >&2
fi
if [ "$_managed_before_cg_enabled" != "true" ]; then
  echo "[install.sh] MANAGED_KEYS forced codegraph.enabled: ${_managed_before_cg_enabled} -> true" >&2
fi
if [ "$_managed_before_cg_setup" != "true" ]; then
  echo "[install.sh] MANAGED_KEYS forced codegraph.index_at_setup: ${_managed_before_cg_setup} -> true" >&2
fi
if [ "$_managed_before_cg_expose" != "true" ]; then
  echo "[install.sh] MANAGED_KEYS forced codegraph.expose_mcp_to_workers: ${_managed_before_cg_expose} -> true" >&2
fi
if [ "$_managed_before_auto_update" != "false" ]; then
  echo "[install.sh] MANAGED_KEYS forced auto_update_enabled: ${_managed_before_auto_update} -> false" >&2
fi
# Store persona snippet — append this to your project's CLAUDE.md
cp "$SCRIPT_DIR/persona.md" "$EXTENSION_ROOT/persona.md"
# Szechuan Sauce principles references — used by /szechuan-sauce command
for f in "$SCRIPT_DIR"/extension/szechuan-sauce-*-principles.md "$SCRIPT_DIR/extension/szechuan-sauce-principles.md"; do
  [ -f "$f" ] && cp "$f" "$EXTENSION_ROOT/$(basename "$f")"
done

# --- PERMISSIONS (glob; NOT hand-maintained — see extension/CLAUDE.md trap-door) ---
chmod +x "$EXTENSION_ROOT/extension/bin/"*.js
# Explicit chmod +x for plumbus-frame-analyzer.js (glob above already covers it,
# but the install-bun-probe.test.js audit checks for an explicit reference so
# the generative-audit entry-point cannot regress to non-executable silently).
[ -f "$EXTENSION_ROOT/extension/bin/plumbus-frame-analyzer.js" ] && chmod +x "$EXTENSION_ROOT/extension/bin/plumbus-frame-analyzer.js"
chmod +x "$EXTENSION_ROOT/extension/hooks/dispatch.js"
chmod +x "$EXTENSION_ROOT/extension/scripts/tmux-monitor.sh"
ln -sf "$EXTENSION_ROOT/extension/bin/mux-runner.js" "$EXTENSION_ROOT/extension/bin/tmux-runner.js"
# Make tsc resolvable from the repo root for sync-schema validation (npx tsc from parent dir)
mkdir -p "$SCRIPT_DIR/node_modules/.bin"
ln -sf "$SCRIPT_DIR/extension/node_modules/.bin/tsc" "$SCRIPT_DIR/node_modules/.bin/tsc"

# --- POST-INSTALL chmod VERIFICATION (R-ICM-2) ---
_chmod_ok=1
for _js in "$EXTENSION_ROOT/extension/bin/"*.js; do
  [ -e "$_js" ] || continue
  if ! test -x "$_js"; then
    echo "❌ not executable after install: $_js" >&2
    _chmod_ok=0
  fi
done
if ! test -x "$EXTENSION_ROOT/extension/hooks/dispatch.js"; then
  echo "❌ not executable after install: $EXTENSION_ROOT/extension/hooks/dispatch.js" >&2
  _chmod_ok=0
fi
if [ "$_chmod_ok" -eq 0 ]; then
  echo "❌ Post-install chmod verification FAILED" >&2
  exit 1
fi
echo "OK chmod"

# --- POST-INSTALL MODE VERIFICATION (R-ICM-3) ---
# B-CITAIL: GNU stat (`-c`) FIRST. On Linux `stat -f` is --file-system mode (not
# BSD's format flag): `stat -f '%Lp' file` stat-fs's the valid operand to stdout
# (filename-tainted) AND exits non-zero, so the `|| stat -c` fallback CONCATENATES
# tainted output. GNU `-c` succeeds cleanly on Linux; on macOS it fails cleanly
# (illegal option, stderr-only) → BSD `-f` fallback. Order matters on both.
_get_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
_mode_fail=0
_act_mode="$(_get_mode "$EXTENSION_ROOT/activity")"
if [ "$_act_mode" != "700" ]; then
  echo "❌ activity dir mode is '$_act_mode', expected 700" >&2
  _mode_fail=1
fi
if [ -e "$EXTENSION_ROOT/deploy-audit.log" ]; then
  _audit_mode="$(_get_mode "$EXTENSION_ROOT/deploy-audit.log")"
  if [ "$_audit_mode" != "600" ]; then
    echo "❌ deploy-audit.log mode is '$_audit_mode', expected 600" >&2
    _mode_fail=1
  fi
fi
if [ "$_mode_fail" -eq 1 ]; then
  echo "❌ Post-install mode verification FAILED" >&2
  exit 1
fi
echo "OK modes"

# --- INTERNAL TEMPLATES (hidden from slash command list) ---
if [ -d "$SCRIPT_DIR/templates" ]; then
  rsync -a "$SCRIPT_DIR/templates/" "$EXTENSION_ROOT/templates/"
fi
# R-PNTR / C-PNTR-CLOSER: the manager-prompt template source lives in extension/templates/
# (R-PNTR-1, asserted by compose-manager-prompt-from-skill.test.js), but the runtime resolver
# reads getExtensionRoot()/templates = $EXTENSION_ROOT/templates. Deploy it there explicitly
# (mirrors the szechuan-sauce-*-principles.md cp below). Without this a fresh install leaves the
# template only under $EXTENSION_ROOT/extension/templates/ and mux-runner FATALs on launch.
if [ -f "$SCRIPT_DIR/extension/templates/_pickle-manager-prompt.md" ]; then
  cp "$SCRIPT_DIR/extension/templates/_pickle-manager-prompt.md" "$EXTENSION_ROOT/templates/_pickle-manager-prompt.md"
fi

# --- AGENTS ---
# Subagent definitions for /pickle --teams.
# Canonical Pickle agents install under .pickle-managed so top-level files remain user overrides.
# No --delete: preserve locally-added managed agents from newer/experimental installs.
AGENTS_DIR="$HOME/.claude/agents"
MANAGED_AGENTS_DIR="$AGENTS_DIR/.pickle-managed"
# B-CITAIL: GNU stat (`-c`) FIRST — see _get_mode note. The reversed order made
# `same_size_and_mtime` always FALSE on Linux (filename-tainted `stat -f` stdout),
# so unmodified canonical agents were wrongly preserved-as-conflict instead of
# migrated to .pickle-managed on Linux installs.
file_size() {
  stat -c '%s' "$1" 2>/dev/null || stat -f '%z' "$1"
}
file_mtime() {
  stat -c '%Y' "$1" 2>/dev/null || stat -f '%m' "$1"
}
same_size_and_mtime() {
  [ "$(file_size "$1")" = "$(file_size "$2")" ] && [ "$(file_mtime "$1")" = "$(file_mtime "$2")" ]
}
# Provenance manifest: every version of every agent this installer has ever shipped.
# Regenerate with extension/scripts/gen-agent-known-hashes.sh.
KNOWN_AGENT_HASHES="$SCRIPT_DIR/.claude/agents/.known-hashes"
# `command -v` rather than run-and-fallback: the B-CITAIL stat bug above was caused by
# a failing first probe emitting usable-looking stdout. Probing availability can't.
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  fi
}
# Did the installer ever ship these bytes? Comparing against the CURRENT source alone
# (the old same_size_and_mtime check) matched only when the agent had not changed since
# the user's last install — i.e. only when there was nothing to migrate.
# Args: $1 legacy file, $2 current source file, $3 agent filename.
is_installer_output() {
  local legacy_hash
  legacy_hash="$(file_sha256 "$1")"
  if [ -z "$legacy_hash" ]; then
    # No sha256 tool: fall back to the legacy heuristic. It under-migrates rather than
    # over-migrates, so the failure mode stays "preserve the user's file".
    same_size_and_mtime "$1" "$2"
    return $?
  fi
  # Byte-identical to what we are shipping right now.
  [ "$legacy_hash" = "$(file_sha256 "$2")" ] && return 0
  # Byte-identical to a version we shipped previously.
  [ -f "$KNOWN_AGENT_HASHES" ] || return 1
  grep -qFx -- "$3 $legacy_hash" "$KNOWN_AGENT_HASHES"
}
if [ -d "$SCRIPT_DIR/.claude/agents" ]; then
  mkdir -p "$AGENTS_DIR" "$MANAGED_AGENTS_DIR"
  for src_agent in "$SCRIPT_DIR"/.claude/agents/*.md; do
    [ -e "$src_agent" ] || continue
    agent_file="$(basename "$src_agent")"
    legacy_agent="$AGENTS_DIR/$agent_file"
    managed_agent="$MANAGED_AGENTS_DIR/$agent_file"
    if [ -f "$legacy_agent" ]; then
      if is_installer_output "$legacy_agent" "$src_agent" "$agent_file"; then
        if [ -e "$managed_agent" ]; then
          rm -f "$legacy_agent"
          echo "ℹ️  Removed legacy duplicate agent $legacy_agent; managed copy already exists."
        else
          mv "$legacy_agent" "$managed_agent"
          echo "ℹ️  Migrated legacy Pickle agent $agent_file to $MANAGED_AGENTS_DIR/"
        fi
      else
        echo "⚠️  Legacy agent conflict preserved at $legacy_agent; canonical Pickle copy installs to $MANAGED_AGENTS_DIR/$agent_file"
      fi
    fi
  done
  rsync -a "$SCRIPT_DIR/.claude/agents/" "$MANAGED_AGENTS_DIR/"
  echo "✅ Agent definitions installed to $MANAGED_AGENTS_DIR/"
fi

# --- COMMANDS ---
# rsync all commands from .claude/commands/; no --delete to preserve user commands.
rsync -a "$SCRIPT_DIR/.claude/commands/" "$COMMANDS_DIR/"

# Clean up legacy commands AFTER rsync (so they're removed even if source still had them)
rm -f "$COMMANDS_DIR/microverse.md"
rm -f "$COMMANDS_DIR/pickle-microverse-tmux.md"
# R-PNTR-5: manager body extracted to _pickle-manager-prompt.md (R-PNTR-1);
# consumers repointed (R-PNTR-2); bare /pickle removed (R-PNTR-5). Remove deployed copy.
rm -f "$COMMANDS_DIR/pickle.md"

# --- STOP HOOK (idempotent jq merge, literal vars expanded by hook-invocation shell) ---
if jq -e '.hooks.Stop // [] | map(.hooks // [] | map(.command)) | flatten | (any(. == "node $HOME/.claude/pickle-rick/extension/hooks/dispatch.js stop-hook") or any(. == "node ${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}/extension/hooks/dispatch.js stop-hook"))' \
    "$SETTINGS_FILE" >/dev/null 2>&1; then
  echo "⚠️  Stop hook already registered — skipping"
else
  TMPFILE="$(mktemp)"
  jq '
    "node ${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}/extension/hooks/dispatch.js stop-hook" as $cmd |
    {"type": "command", "command": $cmd} as $entry |
    if .hooks == null then
      .hooks = {"Stop": [{"hooks": [$entry]}]}
    elif .hooks.Stop == null then
      .hooks.Stop = [{"hooks": [$entry]}]
    else
      .hooks.Stop += [{"hooks": [$entry]}]
    end
  ' "$SETTINGS_FILE" > "$TMPFILE" \
    && mv "$TMPFILE" "$SETTINGS_FILE"
  echo "✅ Registered Stop hook in $SETTINGS_FILE"
fi

# --- POST-TOOL-USE HOOK (git commit activity logger, idempotent) ---
COMMIT_HOOK_CMD='node ${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}/extension/bin/log-commit.js'
if jq -e --arg cmd "$COMMIT_HOOK_CMD" \
    '.hooks.PostToolUse // [] | map(.hooks // [] | map(.command)) | flatten | any(. == $cmd)' \
    "$SETTINGS_FILE" >/dev/null 2>&1; then
  echo "⚠️  PostToolUse hook already registered — skipping"
else
  TMPFILE="$(mktemp)"
  jq --arg cmd "$COMMIT_HOOK_CMD" '
    {"type": "command", "command": $cmd, "async": true, "timeout": 5} as $entry |
    {"matcher": "Bash", "hooks": [$entry]} as $group |
    if .hooks == null then
      .hooks = {"PostToolUse": [$group]}
    elif .hooks.PostToolUse == null then
      .hooks.PostToolUse = [$group]
    else
      .hooks.PostToolUse += [$group]
    end
  ' "$SETTINGS_FILE" > "$TMPFILE" \
    && mv "$TMPFILE" "$SETTINGS_FILE"
  echo "✅ Registered PostToolUse hook in $SETTINGS_FILE"
fi

# --- POST-TOOL-USE-FAILURE HOOK (tool error retry tracker, idempotent) ---
TOOL_ERROR_HOOK_CMD='node ${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}/extension/hooks/dispatch.js tool-error'
if jq -e --arg cmd "$TOOL_ERROR_HOOK_CMD" \
    '.hooks.PostToolUseFailure // [] | map(.hooks // [] | map(.command)) | flatten | any(. == $cmd)' \
    "$SETTINGS_FILE" >/dev/null 2>&1; then
  echo "⚠️  PostToolUseFailure hook already registered — skipping"
else
  TMPFILE="$(mktemp)"
  jq --arg cmd "$TOOL_ERROR_HOOK_CMD" '
    {"type": "command", "command": $cmd} as $entry |
    {"matcher": "*", "hooks": [$entry]} as $group |
    if .hooks == null then
      .hooks = {"PostToolUseFailure": [$group]}
    elif .hooks.PostToolUseFailure == null then
      .hooks.PostToolUseFailure = [$group]
    else
      .hooks.PostToolUseFailure += [$group]
    end
  ' "$SETTINGS_FILE" > "$TMPFILE" \
    && mv "$TMPFILE" "$SETTINGS_FILE"
  echo "✅ Registered PostToolUseFailure hook in $SETTINGS_FILE"
fi

# --- PRE-TOOL-USE HOOKS (merge from source settings, preserving existing entries) ---
SOURCE_SETTINGS="$SCRIPT_DIR/.claude/settings.json"
SOURCE_PTU_COUNT=$(jq '.hooks.PreToolUse // [] | length' "$SOURCE_SETTINGS" 2>/dev/null || echo "0")
if [ "$SOURCE_PTU_COUNT" -gt 0 ]; then
  echo "🔧 Merging $SOURCE_PTU_COUNT PreToolUse hook group(s) from source..."
  for i in $(seq 0 $((SOURCE_PTU_COUNT - 1))); do
    # Extract the command from the source hook group
    SRC_CMD=$(jq -r ".hooks.PreToolUse[$i].hooks[0].command" "$SOURCE_SETTINGS")
    # Check if this command already exists in deployed settings
    if jq -e --arg cmd "$SRC_CMD" \
        '.hooks.PreToolUse // [] | map(.hooks // [] | map(.command)) | flatten | any(. == $cmd)' \
        "$SETTINGS_FILE" >/dev/null 2>&1; then
      echo "⚠️  PreToolUse hook already registered ($SRC_CMD) — skipping"
    else
      # Extract the full hook group from source and merge into deployed
      TMPFILE="$(mktemp)"
      SRC_GROUP=$(jq ".hooks.PreToolUse[$i]" "$SOURCE_SETTINGS")
      jq --argjson group "$SRC_GROUP" '
        if .hooks == null then
          .hooks = {"PreToolUse": [$group]}
        elif .hooks.PreToolUse == null then
          .hooks.PreToolUse = [$group]
        else
          .hooks.PreToolUse += [$group]
        end
      ' "$SETTINGS_FILE" > "$TMPFILE" \
        && mv "$TMPFILE" "$SETTINGS_FILE"
      echo "✅ Registered PreToolUse hook: $SRC_CMD"
    fi
  done
else
  echo "ℹ️  No PreToolUse hooks in source settings — existing hooks preserved"
fi

# --- VALIDATE result ---
jq . "$SETTINGS_FILE" >/dev/null 2>&1 || { echo "❌ settings.json corrupted after merge — restore from backup"; exit 1; }

echo ""
echo "✅ Pickle Rick for Claude Code installed!"
echo ""
echo "📝 Persona setup — add the Pickle Rick persona to your project's CLAUDE.md:"
echo ""
echo "   # If your project already has a CLAUDE.md:"
echo "   cat $EXTENSION_ROOT/persona.md >> /path/to/project/.claude/CLAUDE.md"
echo ""
echo "   # If starting fresh:"
echo "   mkdir -p /path/to/project/.claude"
echo "   cp $EXTENSION_ROOT/persona.md /path/to/project/.claude/CLAUDE.md"
echo ""
echo "Get started in any project: /pickle \"your task here\""
echo "Queue tasks for later:      /add-to-pickle-jar  then  /pickle-jar-open"
