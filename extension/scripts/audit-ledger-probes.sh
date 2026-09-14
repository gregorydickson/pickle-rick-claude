#!/usr/bin/env bash
# audit-ledger-probes.sh — AC-N1: every OPEN BUG / TOP ITEM row in prds/MASTER_PLAN.md carries a
# runnable PROBE, and this audit runs them.
#
# Open-bug rows rot green: a row read as "still broken" purely from the human's memory of writing
# it, with no mechanical check that the defect is still there. This audit closes that gap.
#
# PROBE block convention: an open section — a `## OPEN BUG` / `## TOP ITEM` heading that does NOT
# also carry `RESOLVED` or `DISPOSED` on the same line — MUST contain a fenced code block tagged
# `probe` somewhere before the next `## ` heading:
#
#   ```probe
#   <shell command>
#   ```
#
# The block is run with `bash -c`. Exit 0 means the defect still reproduces (verdict OPEN, matching
# the row's own heading). Any non-zero exit means the probe could not reproduce it (verdict FIXED).
# A probe MUST assert BEHAVIOUR — call the decision function, run the gate over a fixture, read the
# branch outcome — never merely grep for a string.
#
# Sections are discovered by HEADING TEXT alone; there is no list of row ids to maintain. A
# RESOLVED/DISPOSED section is never probed, whether or not it happens to carry a `probe` block.
#
# Fails when:
#   N1-2: an open section's probe exits non-zero (FIXED) or cannot be run (spawn error/timeout).
#   N1-3: an open section carries no `probe` block at all.
#
# LEDGER_PROBES_ROOT_OVERRIDE=<dir> reads <dir>/prds/MASTER_PLAN.md instead of the real ledger
# (fixture tests). LEDGER_PROBES_TIMEOUT_SECONDS overrides the per-probe timeout (default 60).
#
# A gate that refuses a COMMIT/release — never a run. Exits non-zero on any finding.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXTENSION_ROOT/.." && pwd)"
SCAN_ROOT="${LEDGER_PROBES_ROOT_OVERRIDE:-$REPO_ROOT}"
PLAN_PATH="$SCAN_ROOT/prds/MASTER_PLAN.md"
TIMEOUT_SECONDS="${LEDGER_PROBES_TIMEOUT_SECONDS:-60}"

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 1
fi

if [ ! -f "$PLAN_PATH" ]; then
  echo "audit-ledger-probes: no MASTER_PLAN.md at $PLAN_PATH — nothing to check"
  exit 0
fi

node - "$PLAN_PATH" "$TIMEOUT_SECONDS" <<'NODE'
const fs = require('fs');
const { spawnSync } = require('child_process');

const [, , planPath, timeoutSecondsRaw] = process.argv;
const timeoutSeconds = Number(timeoutSecondsRaw);
const timeoutMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 60000;

const failures = [];
const fail = (msg) => failures.push(msg);

function splitSections(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let current = null;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { heading: line.slice(3).trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

function isOpenHeading(heading) {
  const isCandidate = /\bOPEN BUG\b/.test(heading) || /\bTOP ITEM\b/.test(heading);
  if (!isCandidate) return false;
  if (/\bRESOLVED\b/.test(heading)) return false;
  if (/\bDISPOSED\b/.test(heading)) return false;
  return true;
}

function findProbe(bodyText) {
  const match = bodyText.match(/```probe\r?\n([\s\S]*?)```/);
  return match ? match[1] : null;
}

const raw = fs.readFileSync(planPath, 'utf8');
const sections = splitSections(raw);

let openCount = 0;
let confirmedOpenCount = 0;

for (const section of sections) {
  if (!isOpenHeading(section.heading)) continue;
  openCount += 1;

  const probe = findProbe(section.body.join('\n'));
  if (probe === null) {
    fail(`N1-3 no PROBE block: ## ${section.heading}`);
    continue;
  }

  const result = spawnSync('bash', ['-c', probe], { timeout: timeoutMs, encoding: 'utf-8' });
  if (result.error) {
    fail(`N1-2 probe could not run (${result.error.message}): ## ${section.heading}`);
    continue;
  }
  if (result.status === 0) {
    confirmedOpenCount += 1;
    continue;
  }
  fail(`N1-2 probe reports FIXED (exit ${result.status === null ? 'timeout' : result.status}) for a row marked open: ## ${section.heading}`);
}

process.stdout.write(`audit-ledger-probes: ${sections.length} sections scanned, ${openCount} open, ${confirmedOpenCount} probes confirmed OPEN\n`);
for (const msg of failures) process.stderr.write(`audit-ledger-probes: ${msg}\n`);
process.exit(failures.length > 0 ? 1 : 0);
NODE
