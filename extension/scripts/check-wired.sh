#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXTENSION_ROOT/.." && pwd)"

CLAUDE_PATH="$REPO_ROOT/CLAUDE.md"
RELEASE_YML="$REPO_ROOT/.github/workflows/release.yml"
CI_YML="$REPO_ROOT/.github/workflows/ci.yml"

# Canonical gate command — byte-identical in all three sources
GATE="npx tsc --noEmit && npx eslint src/ --max-warnings=-1 && npx tsc && bash scripts/audit-test-tiers.sh && bash scripts/audit-test-isolation.sh && bash scripts/audit-subprocess-heavy-tests.sh && bash scripts/audit-fix-commits.sh && bash scripts/audit-bundle-thesis.sh && bash scripts/audit-quarantine.sh && bash scripts/audit-trap-door-enforcement.sh && bash scripts/audit-guarded-reset.sh && bash scripts/audit-un-terminalize-single-path.sh && bash scripts/audit-did-we-count.sh && npm run test:fast:budget && npm run test:integration && npm run test:contract && RUN_EXPENSIVE_TESTS=1 npm run test:expensive"
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
