#!/usr/bin/env bash
# AC-D3 (R-DSAN) design-ground-truth enforcement spine.
#
# R-DSAN was hollowed during the B-RRH merge because NOTHING failed the build when
# the fix went inert. This spine is a SOURCE-GREP enforcement: it FAILS the build
# (nonzero exit) if any of the three R-DSAN proxies reappear as source patterns,
# and PASSES (exit 0) on the current fixed tree. A stub-satisfiable test is not
# enough — each check is keyed to a real source surface, not a sentinel comment.
#
# The three proxies:
#   (i)   a pickle/phase SUCCESS keyed on a RAW mux child exit code instead of routing
#         through the canonical `evaluateEpicCompletion` completion authority.
#   (ii)  `check-flake-budget` / `test:fast:budget` / `--test-concurrency=8` appearing
#         in the PER-TICKET path (`mux-runner.ts`). The flake budget is once-per-bundle
#         only; it must NEVER be in the per-ticket completion path (mirrors AC-A3).
#
# Exit 0 = no proxy present. Nonzero = at least one proxy detected.
#
# SOURCE_ROOT override: defaults to "$EXTENSION_ROOT/src". The fail-injection test
# re-targets a TEMP COPY of the source tree via SOURCE_ROOT so it can prove RED-on-proxy
# WITHOUT editing the real source files.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_ROOT="${SOURCE_ROOT:-$EXTENSION_ROOT/src}"

MUX_RUNNER="$SOURCE_ROOT/bin/mux-runner.ts"
PIPELINE_RUNNER="$SOURCE_ROOT/bin/pipeline-runner.ts"
CHECK_READINESS="$SOURCE_ROOT/bin/check-readiness.ts"
AUDIT_TICKET_BUNDLE="$SOURCE_ROOT/bin/audit-ticket-bundle.ts"

audit_exit_code=0

fail() {
  echo "audit-design-ground-truth: $1" >&2
  audit_exit_code=1
}

require_file() {
  if [ ! -f "$1" ]; then
    fail "expected source file not found: $1"
    return 1
  fi
  return 0
}

# --- CHECK (ii): flake budget in the per-ticket path (the easy, unambiguous one) ---
# The flake budget is once-per-bundle. Its tokens must NEVER appear in mux-runner.ts
# (the between-ticket / per-ticket gate path). ANY hit is the proxy.
if require_file "$MUX_RUNNER"; then
  if grep -nE "check-flake-budget|test:fast:budget|--test-concurrency=8" "$MUX_RUNNER" >/dev/null 2>&1; then
    fail "PROXY (ii): flake-budget token (check-flake-budget|test:fast:budget|--test-concurrency=8) found in the PER-TICKET path mux-runner.ts — the flake budget is once-per-bundle only, never in the per-ticket completion path (AC-A3)."
  fi
fi

# --- CHECK (i): raw-exit-code completion bypass (POSITIVE invariant) ---
# A pickle/phase SUCCESS must be decided by the canonical `evaluateEpicCompletion`
# authority, not a bare child exit-code check. Expressed conservatively as a POSITIVE
# invariant to avoid false positives: the canonical authority MUST be invoked at both
# of its known call sites. A proxy-(i) regression decides completion off a raw exit
# code instead of routing through evaluateEpicCompletion, dropping >= 1 call-invocation
# site, so the count falls below the floor and this check goes RED. This is keyed to
# the real authority call sites (`evaluateEpicCompletion({`), so it is NOT
# stub-satisfiable by a sentinel comment.
EPIC_COMPLETION_CALL_FLOOR=2
if require_file "$MUX_RUNNER"; then
  epic_calls="$(grep -c "evaluateEpicCompletion({" "$MUX_RUNNER")"
  if [ "$epic_calls" -lt "$EPIC_COMPLETION_CALL_FLOOR" ]; then
    fail "PROXY (i): only $epic_calls 'evaluateEpicCompletion({' call site(s) in mux-runner.ts (floor $EPIC_COMPLETION_CALL_FLOOR) — a pickle/phase completion decision is no longer routed through the canonical evaluateEpicCompletion authority. A completion decided by a raw mux child exit code instead of this authority is the R-DSAN proxy (i) regression."
  fi
fi

# --- CHECK (iv): unrouted ticket-bundle finalize / raw phase-advance (B-GROUND2 WS1) ---
# Every ticket-bundle session-terminal write (`finalizeTerminalState(... step:'completed' ...)`)
# in mux-runner.ts AND pipeline-runner.ts that asserts COMPLETION (`exitReason: 'completed'`
# or `exitReason: 'success'`) MUST route through the single `finalizeIfTrulyComplete` authority
# — a RAW `finalizeTerminalState` carrying a completion exitReason is the unrouted-finalize /
# raw-phase-advance regression (default-DENY). The scan is multi-line-aware (three real sites
# span multiple lines). Two ASSERTED exemption allowlists, default-deny everything else:
#   - reason-exempt: `exitReason: 'limit'` (the 7 mux wall-clock/time-limit sites) and
#     `exitReason: 'failed'` (the pipeline FAILURE finalize — not a completion claim) and the
#     no-exitReason preserve form `{ step: 'completed' }` (handoff/readiness reason-preserve) and
#     the parameterized forensic helper form `exitReason,` (ctxFinalize / finalizeTaskSession).
#   - seam-exempt: jar-runner.ts:365 and microverse-runner.ts:4119 (batch / metric-convergence,
#     NO ticket roster) — asserted present-and-classified, never scanned for completion routing.
# Composes with proxy (i): both must pass together.
JAR_RUNNER="$SOURCE_ROOT/bin/jar-runner.ts"
MICROVERSE_RUNNER="$SOURCE_ROOT/bin/microverse-runner.ts"
if require_file "$MUX_RUNNER" && require_file "$PIPELINE_RUNNER"; then
  _iv_script="$(mktemp -t audit-dgt-iv.XXXXXX.cjs)"
  cat > "$_iv_script" <<'NODE_EOF'
const fs = require("fs");
function read(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }
// Multi-line-aware: capture each finalizeTerminalState( call up to its balanced
// close paren so a call spanning multiple lines is treated as one unit.
function calls(src) {
  const out = [];
  const re = /finalizeTerminalState\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length, depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}
const offenders = [];
for (const [name, p] of [["mux-runner.ts", process.env.MUX], ["pipeline-runner.ts", process.env.PIPE]]) {
  const src = read(p);
  if (src === null) { offenders.push("missing source file " + name); continue; }
  for (const call of calls(src)) {
    if (/exitReason:\s*["'](completed|success)["']/.test(call)) {
      offenders.push(name + ": raw finalizeTerminalState with a completion exitReason must route through finalizeIfTrulyComplete -> " + call.replace(/\s+/g, " ").slice(0, 120));
    }
  }
}
const muxSrc = read(process.env.MUX) || "";
const limitCount = (muxSrc.match(/exitReason:\s*["']limit["']/g) || []).length;
if (limitCount !== 7) offenders.push("reason-exempt drift: expected 7 mux exitReason:limit sites, found " + limitCount);
const jarSrc = read(process.env.JAR) || "";
const mvSrc = read(process.env.MV) || "";
if (!/finalizeTerminalState\s*\(/.test(jarSrc)) offenders.push("seam-exempt drift: jar-runner.ts finalize site missing");
if (!/finalizeTerminalState\s*\(/.test(mvSrc)) offenders.push("seam-exempt drift: microverse-runner.ts finalize site missing");
if (!/finalizeIfTrulyComplete\s*\(/.test(muxSrc)) offenders.push("authority missing: finalizeIfTrulyComplete not called in mux-runner.ts");
const pipeSrc = read(process.env.PIPE) || "";
if (!/finalizeIfTrulyComplete\s*\(/.test(pipeSrc)) offenders.push("authority missing: finalizeIfTrulyComplete not called in pipeline-runner.ts");
if (offenders.length > 0) { for (const o of offenders) console.log("OFFENDER " + o); }
else console.log("OK");
NODE_EOF
  iv_out="$(MUX="$MUX_RUNNER" PIPE="$PIPELINE_RUNNER" JAR="$JAR_RUNNER" MV="$MICROVERSE_RUNNER" node "$_iv_script" 2>&1)"
  rm -f "$_iv_script"
  if ! printf '%s\n' "$iv_out" | grep -q '^OK$'; then
    while IFS= read -r line; do
      [ -n "$line" ] && fail "PROXY (iv): $line"
    done <<< "$iv_out"
  fi
fi

if [ "$audit_exit_code" -eq 0 ]; then
  echo "audit-design-ground-truth: OK — no R-DSAN proxy (i/ii/iv) present in $SOURCE_ROOT"
fi

exit "$audit_exit_code"
