#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXTENSION_ROOT/.." && pwd)"

CLAUDE_PATH="$REPO_ROOT/CLAUDE.md"
RELEASE_YML="$REPO_ROOT/.github/workflows/release.yml"
CI_YML="$REPO_ROOT/.github/workflows/ci.yml"

# Canonical gate command — READ from the root CLAUDE.md `## Versioning` line, the documented
# release-gate source of truth. A literal copy here had to be re-registered by hand for every new
# gate step, and a missed registration reddened this script over mirrors that all agreed.
GATE="$(awk '/^## Versioning$/ { in_section = 1; next } in_section && /^## / { exit } in_section && /^`npx tsc --noEmit .*`$/ { print; exit }' "$CLAUDE_PATH" 2>/dev/null | sed 's/^`//; s/`$//')"
if [ -z "$GATE" ]; then
  echo "check-wired: FAIL: $CLAUDE_PATH: ## Versioning carries no release gate line to check against" >&2
  exit 1
fi
FULL_CMD="cd extension && npm ci && $GATE"

status=0

fail() {
  echo "check-wired: FAIL: $1" >&2
  status=1
}

# --- Parity check across three sources ---

claude_line="$(grep '^cd extension &&' "$CLAUDE_PATH" | head -1)"
if [ -z "$claude_line" ]; then
  fail "$CLAUDE_PATH: no line starting with 'cd extension &&'"
elif [ "$claude_line" != "$FULL_CMD" ]; then
  fail "$CLAUDE_PATH Build&Test gate mismatch
  expected: $FULL_CMD
  got:      $claude_line"
fi

release_run="$(grep 'run:.*cd extension' "$RELEASE_YML" | head -1 | sed 's/^[[:space:]]*run:[[:space:]]*//')"
if [ -z "$release_run" ]; then
  fail "$RELEASE_YML: no 'run: cd extension' line found"
elif [ "$release_run" != "$FULL_CMD" ]; then
  fail "$RELEASE_YML gate mismatch
  expected: $FULL_CMD
  got:      $release_run"
fi

ci_run="$(grep 'run:.*cd extension' "$CI_YML" | head -1 | sed 's/^[[:space:]]*run:[[:space:]]*//')"
if [ -z "$ci_run" ]; then
  fail "$CI_YML: no 'run: cd extension' line found"
elif [ "$ci_run" != "$FULL_CMD" ]; then
  fail "$CI_YML gate mismatch
  expected: $FULL_CMD
  got:      $ci_run"
fi

# --- Script existence check ---

# Extract each 'bash scripts/<name>.sh' reference from the gate command
while IFS= read -r script_name; do
  script_path="$EXTENSION_ROOT/scripts/$script_name"
  if [ ! -f "$script_path" ]; then
    fail "referenced script not found: scripts/$script_name"
  elif [ ! -x "$script_path" ]; then
    fail "referenced script not executable: scripts/$script_name"
  fi
done < <(echo "$GATE" | grep -oE 'bash scripts/[A-Za-z0-9_-]+\.sh' | sed 's|bash scripts/||')

if [ "$status" -eq 0 ]; then
  echo "check-wired: OK — gate command parity verified across CLAUDE.md, release.yml, ci.yml"
fi

exit "$status"
