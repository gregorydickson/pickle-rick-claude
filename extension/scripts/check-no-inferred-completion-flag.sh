#!/usr/bin/env bash
# check-no-inferred-completion-flag.sh — B-DURA T60 pre-deploy live-state check.
#
# The `allow_inferred_completion_commit` flag was deleted from the runtime in
# B-DURA T60. Deleting a best-effort recovery-branch flag changes the recovery
# state machine for any session mid-flight at `install.sh` time. Before deploying
# the flag-free runtime over a live data root, prove no active session still
# persists the flag `true` in its live `state.json` — otherwise the new runtime
# would silently change the in-flight recovery semantics for that session.
#
# Exit 0  — no active session persists the flag true (safe to deploy).
# Exit 2  — at least one active session has `state.flags.allow_inferred_completion_commit === true`.
# Exit 1  — usage / environment error.
#
# PICKLE_DATA_ROOT (or PICKLE_DATA_DIR) selects the data root; defaults to
# $HOME/.local/share/pickle-rick. INFERRED_FLAG_SCAN_ROOT overrides the sessions
# scan root directly (used by the test harness).
set -u

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 1
fi

DATA_ROOT="${PICKLE_DATA_ROOT:-${PICKLE_DATA_DIR:-$HOME/.local/share/pickle-rick}}"
SCAN_ROOT="${INFERRED_FLAG_SCAN_ROOT:-$DATA_ROOT/sessions}"

node - "$SCAN_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const [, , scanRoot] = process.argv;
const FLAG = 'allow_inferred_completion_commit';

if (!scanRoot || !fs.existsSync(scanRoot)) {
  // No sessions directory → nothing live to protect.
  process.exit(0);
}

const offenders = [];
let entries;
try {
  entries = fs.readdirSync(scanRoot, { withFileTypes: true });
} catch {
  process.exit(0);
}

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const statePath = path.join(scanRoot, entry.name, 'state.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    continue;
  }
  const active = state && state.active === true;
  const flagSet = state && state.flags && state.flags[FLAG] === true;
  if (active && flagSet) offenders.push(statePath);
}

if (offenders.length > 0) {
  process.stderr.write(
    `[block] ${offenders.length} active session(s) persist ${FLAG}: true — refusing to deploy the flag-free runtime:\n`,
  );
  for (const p of offenders) process.stderr.write(`  ${p}\n`);
  process.exit(2);
}
process.exit(0);
NODE
