#!/bin/bash
# Release gate faithful to root CLAUDE.md at HEAD. Direct exit codes, no pipes, no PIPESTATUS.
set -u
cd /Users/gregorydickson/pickle-rick-claude/extension || exit 99
OUT="$1"; : > "$OUT"
RUNID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
echo "GATE_RUN_ID=$RUNID" >> "$OUT"
echo "GATE_START=$(date -u +%FT%TZ) HEAD=$(git rev-parse --short HEAD)" >> "$OUT"
leg() { local n="$1"; shift; echo "=== LEG_START $n $(date -u +%FT%TZ)" >> "$OUT"; "$@" >> "$OUT" 2>&1; local rc=$?; echo "=== LEG_RC $n $rc" >> "$OUT"; return $rc; }

leg npm_ci npm ci
leg tsc_noemit ./node_modules/.bin/tsc --noEmit
leg eslint_max0 ./node_modules/.bin/eslint src/ --max-warnings=0
leg tsc_emit ./node_modules/.bin/tsc
echo "=== JS_TS_DRIFT" >> "$OUT"; git status --porcelain >> "$OUT" 2>&1
echo "=== LEG_RC js_ts_drift $(git status --porcelain | wc -l | tr -d ' ')" >> "$OUT"
# DERIVE the audit list from root CLAUDE.md — never hardcode it. A hardcoded list
# silently drops any audit added later: this runner missed audit-recorded-ceilings
# for a whole release cycle because R1 added it and the list did not know.
AUDITS=$(grep -oE 'bash scripts/audit-[a-z-]+\.sh' ../CLAUDE.md | sed 's|bash scripts/||;s|\.sh$||' | sort -u)
echo "=== AUDITS_DERIVED $(echo "$AUDITS" | tr '\n' ' ')" >> "$OUT"
if [ -z "$AUDITS" ]; then echo "=== LEG_RC audit_list_derivation 1 (EMPTY — refusing to pass)" >> "$OUT"; fi
for a in $AUDITS; do
  leg "$a" bash "scripts/$a.sh"
done
leg test_fast_budget npm run test:fast:budget
leg test_integration npm run test:integration
leg test_contract npm run test:contract
leg test_expensive env RUN_EXPENSIVE_TESTS=1 npm run test:expensive
echo "GATE_END=$(date -u +%FT%TZ) RUN_ID=$RUNID" >> "$OUT"
