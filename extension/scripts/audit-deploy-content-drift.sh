#!/usr/bin/env bash
# Content-based deploy drift check (TIER-2.7): compares the deployed runtime
# under $DEPLOYED_ROOT against the source tree BY CONTENT, not by version.
# The compared file set is DERIVED from install.sh's own copy manifest
# (its rsync --exclude flags and its MANAGED_KEYS jq filter), never a second
# hand-maintained list. Read-only; never halts the pipeline; standalone.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DEPLOYED_ROOT="${PICKLE_INSTALL_ROOT:-$HOME/.claude/pickle-rick}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-root)
      SOURCE_ROOT="$2"; shift 2 ;;
    --deployed-root)
      DEPLOYED_ROOT="$2"; shift 2 ;;
    *)
      echo "Unknown flag: $1" >&2
      exit 2 ;;
  esac
done

INSTALL_SH="$SOURCE_ROOT/install.sh"
if [ ! -f "$INSTALL_SH" ]; then
  echo "install.sh not found at $INSTALL_SH — cannot derive copy manifest" >&2
  exit 2
fi

if [ ! -d "$DEPLOYED_ROOT/extension" ]; then
  printf '{"status":"skipped","reason":"not_deployed","source_root":"%s","deployed_root":"%s"}\n' \
    "$SOURCE_ROOT" "$DEPLOYED_ROOT"
  exit 0
fi

drifted=()
unverified=()
checked=0

report_drift() {
  local category="$1" path="$2" reason="$3"
  drifted+=("$category|$path|$reason")
  echo "DRIFT [$category] $path ($reason)" >&2
}

report_unverified() {
  local category="$1" path="$2" reason="$3"
  unverified+=("$category|$path|$reason")
}

md5_of() {
  local f="$1"
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$f" 2>/dev/null | awk '{print $1}'
  elif command -v md5 >/dev/null 2>&1; then
    md5 -q "$f" 2>/dev/null
  else
    echo ""
  fi
}

compare_file() {
  local category="$1" src="$2" dst="$3" rel="$4"
  checked=$((checked + 1))
  if [ ! -f "$dst" ]; then
    report_drift "$category" "$rel" "missing_deployed"
    return
  fi
  if [ ! -f "$src" ]; then
    report_drift "$category" "$rel" "missing_source"
    return
  fi
  local src_md5 dst_md5
  src_md5="$(md5_of "$src")"
  dst_md5="$(md5_of "$dst")"
  if [ -z "$src_md5" ] || [ -z "$dst_md5" ]; then
    report_unverified "$category" "$rel" "md5_unavailable"
    return
  fi
  if [ "$src_md5" != "$dst_md5" ]; then
    report_drift "$category" "$rel" "content_mismatch"
  fi
}

# --- Derive the extension/ rsync exclude list from install.sh itself (AC-2) ---
# Scan from the rsync line copying extension/ up to its destination-arg line
# (the one ending in `extension/"`), collecting every --exclude='X' token in
# between. A new exclude added to install.sh is honored automatically; no
# second hardcoded exclude array exists here.
excludes=()
in_block=0
while IFS= read -r line; do
  if [[ "$line" == *'rsync -a --delete --delete-excluded'* ]]; then
    in_block=1
    continue
  fi
  if [ "$in_block" -eq 1 ]; then
    if [[ "$line" =~ --exclude=\'([^\']*)\' ]]; then
      excludes+=("${BASH_REMATCH[1]}")
    fi
    if [[ "$line" == *'extension/"'* ]]; then
      break
    fi
  fi
done < "$INSTALL_SH"

path_excluded() {
  local rel="$1" pattern seg
  IFS='/' read -ra segs <<< "$rel"
  for pattern in "${excludes[@]:-}"; do
    [ -z "$pattern" ] && continue
    for seg in "${segs[@]:-}"; do
      if [ "$seg" = "$pattern" ]; then
        return 0
      fi
    done
  done
  return 1
}

# The candidate set is git-TRACKED files under extension/, so untracked local
# scratch (build caches, *.log runtime artifacts, etc.) is never mistaken for
# managed source content. install.sh's rsync does not consult git at all, but
# tsconfig.json/package-lock.json/src/tests ARE tracked and must still be
# dropped via the same derived exclude list, applied per path-segment (rsync's
# own unanchored --exclude semantics: a name match at any depth excludes it).
find_extension_files() {
  if git -C "$SOURCE_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$SOURCE_ROOT" ls-files -z -- extension | while IFS= read -r -d '' relpath; do
      case "$relpath" in
        extension/*)
          rel_inner="${relpath#extension/}"
          if ! path_excluded "$rel_inner"; then
            printf '%s\n' "$SOURCE_ROOT/$relpath"
          fi
          ;;
      esac
    done
  else
    find "$SOURCE_ROOT/extension" -type f -print 2>/dev/null | while IFS= read -r f; do
      rel_inner="${f#"$SOURCE_ROOT"/extension/}"
      if ! path_excluded "$rel_inner"; then
        printf '%s\n' "$f"
      fi
    done
  fi
}

# --- Derive the MANAGED_KEYS jq filter from install.sh itself (AC-2) ---
managed_filter="$(grep -A 20 'MANAGED_KEYS: force code-owned settings source-authoritative' "$INSTALL_SH" \
  | grep -m1 "^jq '" \
  | sed -E "s/^jq '(.*)'.*/\\1/")"

# --- Category A: extension/ tree (compiled JS via fresh emit; rest direct) ---
schema_stub_rel="activity-events.schema.json"
compiled_rels=()
direct_rels=()
while IFS= read -r f; do
  rel="${f#"$SOURCE_ROOT"/extension/}"
  [ "$rel" = "$f" ] && continue
  if [ "$rel" = "$schema_stub_rel" ]; then
    continue
  fi
  case "$rel" in
    *.js)
      ts_src="$SOURCE_ROOT/extension/src/${rel%.js}.ts"
      if [ -f "$ts_src" ]; then
        compiled_rels+=("$rel")
      else
        direct_rels+=("$rel")
      fi
      ;;
    *)
      direct_rels+=("$rel")
      ;;
  esac
done < <(find_extension_files)

for rel in "${direct_rels[@]:-}"; do
  [ -z "$rel" ] && continue
  compare_file "extension" "$SOURCE_ROOT/extension/$rel" "$DEPLOYED_ROOT/extension/$rel" "$rel"
done

if [ "${#compiled_rels[@]}" -gt 0 ]; then
  tmp_emit="$(mktemp -d)"
  trap 'rm -rf "$tmp_emit"' EXIT
  tsc_ok=1
  local_tsc="$SOURCE_ROOT/extension/node_modules/.bin/tsc"
  if [ -x "$local_tsc" ]; then
    # Prefer the already-installed local compiler directly (matches the
    # `node_modules/.bin/tsc` symlink install.sh itself sets up) — never let
    # a missing local devDependency fall through to npx's registry-fetch
    # prompt, which would be an unexpected network call from a read-only
    # diagnostic script.
    (cd "$SOURCE_ROOT/extension" && "$local_tsc" --outDir "$tmp_emit") >/dev/null 2>&1 || tsc_ok=0
  elif command -v npx >/dev/null 2>&1; then
    (cd "$SOURCE_ROOT/extension" && npx --no-install tsc --outDir "$tmp_emit") >/dev/null 2>&1 || tsc_ok=0
  else
    tsc_ok=0
  fi
  for rel in "${compiled_rels[@]}"; do
    checked=$((checked + 1))
    if [ "$tsc_ok" -ne 1 ]; then
      report_unverified "extension" "$rel" "tsc_unavailable"
      continue
    fi
    fresh="$tmp_emit/$rel"
    deployed="$DEPLOYED_ROOT/extension/$rel"
    if [ ! -f "$fresh" ]; then
      report_unverified "extension" "$rel" "fresh_emit_missing"
      continue
    fi
    if [ ! -f "$deployed" ]; then
      report_drift "extension" "$rel" "missing_deployed"
      continue
    fi
    fresh_md5="$(md5_of "$fresh")"
    deployed_md5="$(md5_of "$deployed")"
    if [ -z "$fresh_md5" ] || [ -z "$deployed_md5" ]; then
      report_unverified "extension" "$rel" "md5_unavailable"
    elif [ "$fresh_md5" != "$deployed_md5" ]; then
      report_drift "extension" "$rel" "content_mismatch_vs_fresh_emit"
    fi
  done
fi

# Schema special-case: deployed extension/activity-events.schema.json is a cp
# of extension/src/types/activity-events.schema.json (install.sh:391-395), not
# of the small $ref stub that lives at extension/activity-events.schema.json
# in the source tree.
compare_file "extension" \
  "$SOURCE_ROOT/extension/src/types/activity-events.schema.json" \
  "$DEPLOYED_ROOT/extension/activity-events.schema.json" \
  "activity-events.schema.json (vs src/types/ source)"

# --- Category B: .claude/commands/*.md ---
if [ -d "$SOURCE_ROOT/.claude/commands" ]; then
  while IFS= read -r f; do
    base="$(basename "$f")"
    compare_file "commands" "$f" "$DEPLOYED_ROOT/../commands/$base" "commands/$base"
  done < <(find "$SOURCE_ROOT/.claude/commands" -maxdepth 1 -type f -name '*.md' 2>/dev/null)
fi

# --- Category C: persona.md ---
if [ -f "$SOURCE_ROOT/persona.md" ]; then
  compare_file "persona" "$SOURCE_ROOT/persona.md" "$DEPLOYED_ROOT/persona.md" "persona.md"
fi

# --- Category D: pickle_settings.json MANAGED_KEYS conformance (expected-transform model) ---
settings_managed_keys_ok="null"
deployed_settings="$DEPLOYED_ROOT/pickle_settings.json"
if [ -n "$managed_filter" ] && [ -f "$deployed_settings" ]; then
  if command -v jq >/dev/null 2>&1; then
    current="$(jq -S . "$deployed_settings" 2>/dev/null)"
    forced="$(jq -S "$managed_filter" "$deployed_settings" 2>/dev/null)"
    if [ -z "$current" ] || [ -z "$forced" ]; then
      report_unverified "settings" "pickle_settings.json" "jq_eval_failed"
    elif [ "$current" = "$forced" ]; then
      settings_managed_keys_ok="true"
    else
      settings_managed_keys_ok="false"
      report_drift "settings" "pickle_settings.json" "managed_keys_not_forced"
    fi
  else
    report_unverified "settings" "pickle_settings.json" "jq_unavailable"
  fi
fi

# --- Emit machine-visible JSON report (AC-3) ---
# Portable to bash 3.2 (macOS default `/usr/bin/env bash`): no namerefs, entries
# passed positionally instead of by array-name reference.
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

join_entries() {
  local out="[" first=1 entry category path reason
  for entry in "$@"; do
    [ -z "$entry" ] && continue
    IFS='|' read -r category path reason <<< "$entry"
    if [ "$first" -eq 0 ]; then out+=","; fi
    first=0
    out+="{\"category\":\"$(json_escape "$category")\",\"path\":\"$(json_escape "$path")\",\"reason\":\"$(json_escape "$reason")\"}"
  done
  out+="]"
  echo "$out"
}

status="clean"
if [ "${#drifted[@]}" -gt 0 ]; then
  status="drift"
fi

drifted_json="$(join_entries "${drifted[@]:-}")"
unverified_json="$(join_entries "${unverified[@]:-}")"

printf '{"status":"%s","source_root":"%s","deployed_root":"%s","checked":%d,"drifted":%s,"unverified":%s,"settings_managed_keys_ok":%s}\n' \
  "$status" "$SOURCE_ROOT" "$DEPLOYED_ROOT" "$checked" "$drifted_json" "$unverified_json" "$settings_managed_keys_ok"

if [ "$status" = "drift" ]; then
  exit 1
fi
exit 0
