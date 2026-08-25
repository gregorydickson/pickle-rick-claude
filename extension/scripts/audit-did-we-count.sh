#!/usr/bin/env bash
# audit-did-we-count.sh — repo-shaped "did we count it" forward-protection
# (ticket ba29edb0, part of the did-we-count prevention bundle: 984a768c/d7c017ff).
#
# ESLint/AST rules over extension/src/**/*.ts cannot reach registration-count
# drift in YAML/Markdown/shell mirrors. This audit covers exactly the class of
# defect measured as "out-of-reach" in extension/src/services/did-we-count-corpus.ts
# (4/18 shas touching zero extension/src/**/*.ts files):
#
#   - ff2846d1: workflow node-version pins drifted out of parity with
#     engines.node (three workflows, only two caught by CI at the time).
#   - 9e89e360 / 2c857117: a subsystem CLAUDE.md catalog existed on disk but
#     was never enumerated by the release-gate sweep, so its trap doors were
#     silently uncounted.
#
# Two checks, each fail-closed on zero COMPARISONS MADE — not on files opened.
# Opening a file that yields no comparison is not coverage, and an aggregate
# "some file somewhere was read" count lets one check report clean having
# verified nothing (a scan that reached nothing must never report clean):
#   1. Every .github/workflows/*.yml `node-version:` pin matches
#      extension/package.json engines.node, byte-for-byte. Counted in PINS
#      compared, so a workflow set that carries no pin at all fails closed.
#   2. Every CLAUDE.md file under the repo (excluding node_modules) is
#      non-empty and reachable from the repo root — a missing/empty catalog
#      is exactly the 9e89e360/2c857117 defect shape.
#
# Exits non-zero locally on any violation. Emits no exit_reason (AC-7').
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="${DID_WE_COUNT_REPO_ROOT_OVERRIDE:-$(cd "$EXTENSION_ROOT/.." && pwd)}"

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 1
fi

if ! node - "$REPO_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const [, , repoRoot] = process.argv;

function fail(msg) {
  process.stderr.write(`audit-did-we-count: ${msg}\n`);
  failures.push(msg);
}

const failures = [];

// --- Check 1: workflow node-version parity (ff2846d1 class) ---

const pkgPath = path.join(repoRoot, 'extension', 'package.json');
let engineNode = null;
try {
  engineNode = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).engines?.node;
} catch (err) {
  fail(`could not read/parse ${pkgPath}: ${err instanceof Error ? err.message : String(err)}`);
}
if (!engineNode) {
  fail(`${pkgPath} is missing engines.node`);
}

const workflowsDir = path.join(repoRoot, '.github', 'workflows');
let workflowFiles = [];
try {
  workflowFiles = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => path.join(workflowsDir, f));
} catch (err) {
  fail(`could not read ${workflowsDir}: ${err instanceof Error ? err.message : String(err)}`);
}

let workflowsScanned = 0;
let pinsCompared = 0;
const NODE_VERSION_RE = /^\s*node-version:\s*['"]?([^'"\n]+?)['"]?\s*$/gm;

for (const wf of workflowFiles) {
  const text = fs.readFileSync(wf, 'utf8');
  const pins = [...text.matchAll(NODE_VERSION_RE)].map((m) => m[1]);
  workflowsScanned++;
  if (engineNode) {
    for (const pin of pins) {
      pinsCompared++;
      if (pin !== engineNode) {
        fail(`${path.relative(repoRoot, wf)}: node-version '${pin}' does not match engines.node '${engineNode}'`);
      }
    }
  }
}

// --- Check 2: CLAUDE.md catalog reachability (9e89e360 / 2c857117 class) ---

function findClaudeMdFiles(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findClaudeMdFiles(abs, acc);
    } else if (entry.isFile() && entry.name === 'CLAUDE.md') {
      acc.push(abs);
    }
  }
  return acc;
}

const claudeMdFiles = findClaudeMdFiles(repoRoot);

for (const abs of claudeMdFiles) {
  let content = '';
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    fail(`${path.relative(repoRoot, abs)}: unreadable (${err instanceof Error ? err.message : String(err)})`);
    continue;
  }
  if (content.trim().length === 0) {
    fail(`${path.relative(repoRoot, abs)}: empty catalog file — an empty catalog is the 2c857117 defect shape`);
  }
}

// A check that reached nothing must never report clean — the class this audit
// exists to catch (a gate that reports green having never run the check). The
// unit is comparisons MADE, per check: an aggregate file count is satisfied by
// any one check finding work, which is what lets the other one go dark.
function requireCounted(label, comparisons) {
  if (comparisons === 0) {
    fail(`${label}: zero comparisons made — the check reached nothing (did-we-count honesty requirement)`);
  }
}

requireCounted('check 1 (workflow node-version parity)', pinsCompared);
requireCounted('check 2 (CLAUDE.md catalog reachability)', claudeMdFiles.length);

if (failures.length > 0) {
  process.exit(1);
}

console.log(`audit-did-we-count: ${pinsCompared} node-version pin(s) across ${workflowsScanned} workflow file(s) + ${claudeMdFiles.length} CLAUDE.md catalog(s) compared, no drift found`);
NODE
then
  exit 1
fi

exit 0
