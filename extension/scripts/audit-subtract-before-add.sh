#!/usr/bin/env bash
# audit-subtract-before-add.sh (WS-5, lightweight) — ADVISORY ONLY.
#
# Reports the NET DELTA, current branch vs a base (default `main`), of three
# "machinery" surfaces that the reliability plan (M4) says we keep ADDING instead
# of subtracting:
#   (a) trap-door entries     — `INVARIANT:` enforcement lines in the two CLAUDE.md
#                               trap-door registries (extension/CLAUDE.md +
#                               extension/src/bin/CLAUDE.md)
#   (b) skip_*/allow_* flags  — distinct `skip_*` / `allow_*` override-flag tokens
#                               referenced anywhere under extension/src/
#   (c) audit scripts         — extension/scripts/audit-*.sh script count
#
# It prints a one-line summary and ALWAYS EXITS 0. This is a TREND signal for
# review — subtract-before-add as prose was unmeasured (M4). A hard count-gate was
# deliberately rejected (Codex: gameable); this is advisory and NEVER blocks the
# gate. Do NOT wire it into the blocking quality gate.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# .../extension/scripts -> repo root is two levels up.
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BASE="main"
for arg in "$@"; do
  case "$arg" in
    --base) ;; # value consumed below
    --base=*) BASE="${arg#--base=}" ;;
    *)
      if [ "${PREV:-}" = "--base" ]; then BASE="$arg"; fi
      ;;
  esac
  PREV="$arg"
done

if ! command -v git >/dev/null 2>&1; then
  echo "SUBTRACT_BEFORE_ADD net_trapdoors=NA net_flags=NA net_audits=NA (advisory: git unavailable)"
  exit 0
fi

# Resolve the base to a comparable ref; fall back to an empty-tree diff when the
# base is unknown (e.g. a detached fork) so the audit still prints a summary.
BASE_REF="$BASE"
if ! git -C "$REPO_ROOT" rev-parse --verify --quiet "$BASE^{commit}" >/dev/null 2>&1; then
  BASE_REF=""
fi

# --- counters --------------------------------------------------------------

# Count `INVARIANT:` occurrences across both trap-door registries at HEAD.
count_trapdoors_head() {
  local total=0 f n
  for f in extension/CLAUDE.md extension/src/bin/CLAUDE.md; do
    if [ -f "$REPO_ROOT/$f" ]; then
      n="$(grep -oE 'INVARIANT:' "$REPO_ROOT/$f" 2>/dev/null | wc -l | tr -d '[:space:]')"
      total=$((total + n))
    fi
  done
  printf '%s' "$total"
}

count_trapdoors_base() {
  local total=0 f n
  [ -n "$BASE_REF" ] || { printf '0'; return; }
  for f in extension/CLAUDE.md extension/src/bin/CLAUDE.md; do
    n="$(git -C "$REPO_ROOT" show "$BASE_REF:$f" 2>/dev/null | grep -oE 'INVARIANT:' | wc -l | tr -d '[:space:]')"
    total=$((total + n))
  done
  printf '%s' "$total"
}

# Distinct skip_*/allow_* flag tokens referenced under extension/src/ at HEAD.
count_flags_head() {
  if [ -d "$REPO_ROOT/extension/src" ]; then
    grep -rhoE '\b(skip|allow)_[a-z0-9_]+' "$REPO_ROOT/extension/src" 2>/dev/null \
      | sort -u | grep -c . | tr -d '[:space:]'
  else
    printf '0'
  fi
}

# Distinct skip_*/allow_* tokens under extension/src/ at the BASE ref. Enumerate
# the base's tracked src files via `git ls-tree`, stream each through `git show`.
count_flags_base() {
  [ -n "$BASE_REF" ] || { printf '0'; return; }
  git -C "$REPO_ROOT" ls-tree -r --name-only "$BASE_REF" -- extension/src 2>/dev/null \
    | while IFS= read -r path; do
        git -C "$REPO_ROOT" show "$BASE_REF:$path" 2>/dev/null
      done \
    | grep -oE '\b(skip|allow)_[a-z0-9_]+' 2>/dev/null \
    | sort -u | grep -c . | tr -d '[:space:]'
}

# extension/scripts/audit-*.sh count at HEAD.
count_audits_head() {
  if [ -d "$REPO_ROOT/extension/scripts" ]; then
    find "$REPO_ROOT/extension/scripts" -maxdepth 1 -name 'audit-*.sh' 2>/dev/null \
      | grep -c . | tr -d '[:space:]'
  else
    printf '0'
  fi
}

count_audits_base() {
  [ -n "$BASE_REF" ] || { printf '0'; return; }
  git -C "$REPO_ROOT" ls-tree -r --name-only "$BASE_REF" -- extension/scripts 2>/dev/null \
    | grep -E '/audit-[^/]+\.sh$' | grep -c . | tr -d '[:space:]'
}

signed() {
  local n="$1"
  if [ "$n" -ge 0 ] 2>/dev/null; then printf '+%s' "$n"; else printf '%s' "$n"; fi
}

td_head="$(count_trapdoors_head)"
td_base="$(count_trapdoors_base)"
fl_head="$(count_flags_head)"
fl_base="$(count_flags_base)"
au_head="$(count_audits_head)"
au_base="$(count_audits_base)"

net_td=$(( td_head - td_base ))
net_fl=$(( fl_head - fl_base ))
net_au=$(( au_head - au_base ))

echo "SUBTRACT_BEFORE_ADD net_trapdoors=$(signed "$net_td") net_flags=$(signed "$net_fl") net_audits=$(signed "$net_au") (base=$BASE; advisory)"

exit 0
