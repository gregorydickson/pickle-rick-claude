#!/usr/bin/env bash
# audit-acceptance-assertion-coverage.sh — AC-O2: executable-assertion coverage is a ratchet, not a hope.
#
# If an authoring path stops emitting the backticked `<command>` exits|returns <N> form, every new ticket is
# unguarded and nothing notices. This audit measures, over a ticket corpus, how many tickets with a non-empty
# Acceptance Criteria section carry at least one executable assertion, and holds that figure to a recorded
# floor. Every verdict line names the corpus it measured (AC-P1, GitHub #26).
#
# Corpus precedence — DISCOVERED, never hand-listed:
#   1. ACCEPTANCE_COVERAGE_ROOT_OVERRIDE=<dir> — scans every rick_ticket_*.md under <dir> (fixture tests).
#   2. <data root>/sessions — the live session corpus, resolved via the SAME getDataRoot() the runtime uses
#      (extension/services/pickle-utils.js) — when it holds >=1 ticket. This is the population actually at
#      risk from an authoring-path regression.
#   3. git index of the repo — a NAMED fallback (git ls-files -z -- '*rick_ticket_*.md') used only when no
#      session corpus is found (e.g. CI, which has no sessions dir). The fallback is announced on stderr the
#      moment it is chosen, independent of what runs afterward.
#
# Denominator: tickets whose section is non-empty per the exported executableAcceptanceSection; tickets with no
# section are excluded. Numerator: tickets where the exported readExecutableAcceptanceAssertions yields >=1.
# Both readers are imported from the compiled extension/bin/mux-runner.js — there is no second regex here.
#
# Recorded floor: acceptance-assertion-coverage-floor.json beside this script, integers only, two named
# entries:
#   git_index         — used for the override corpus AND the git-index fallback (both deterministic: they
#                        change only when a human edits fixtures or the tracked ticket set). EXACT-PAIR,
#                        raise-only: refuses below the recorded pair (regression) AND refuses any difference
#                        above it (forces recording the improvement) — the house ratchet idiom.
#   session_min_ratio — used for the auto-discovered session corpus, which grows every pipeline run by
#                        construction. RATIO LOWER-BOUND ONLY: refuses a measured ratio below the recorded
#                        one; never refuses for being above it, since "the corpus grew since last time" is
#                        not a regression. Both floors are checked by the SAME cross-multiply comparison —
#                        the session kind just skips the second (forced-exact) check.
# A denominator of 0 reports UNMEASURED (named), never 0% and never below-floor. A failed enumeration, an
# unloadable extractor/resolver, or a malformed floor exits non-zero with a named reason.
#
# A gate that refuses a COMMIT/release — never a run. Exits non-zero on any finding.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXTENSION_ROOT/.." && pwd)"
EXTRACTOR="$EXTENSION_ROOT/bin/mux-runner.js"
UTILS="$EXTENSION_ROOT/services/pickle-utils.js"
FLOOR_PATH="$SCRIPT_DIR/acceptance-assertion-coverage-floor.json"

if ! command -v node >/dev/null 2>&1; then
  echo "audit-acceptance-assertion-coverage: node is required" >&2
  exit 1
fi
if [ ! -f "$EXTRACTOR" ]; then
  echo "audit-acceptance-assertion-coverage: extractor not compiled at $EXTRACTOR — run ./node_modules/.bin/tsc" >&2
  exit 1
fi
if [ ! -f "$UTILS" ]; then
  echo "audit-acceptance-assertion-coverage: data-root resolver not compiled at $UTILS — run ./node_modules/.bin/tsc" >&2
  exit 1
fi

node --input-type=module - "$REPO_ROOT" "$EXTRACTOR" "$FLOOR_PATH" "${ACCEPTANCE_COVERAGE_ROOT_OVERRIDE:-}" "$UTILS" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [repoRoot, extractorPath, floorPath, overrideRoot, utilsPath] = process.argv.slice(2);
const TICKET_NAME_RE = /^rick_ticket_.*\.md$/;
const refuse = (reason) => {
  process.stderr.write(`audit-acceptance-assertion-coverage: ${reason}\n`);
  process.exit(1);
};
const errText = (err) => (err instanceof Error ? err.message : String(err));

function walkTickets(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTickets(full);
    return entry.isFile() && TICKET_NAME_RE.test(entry.name) ? [full] : [];
  });
}

function trackedTickets() {
  const listed = spawnSync('git', ['ls-files', '-z', '--', '*rick_ticket_*.md'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.error || listed.status !== 0) {
    refuse(`git ls-files could not enumerate the corpus: ${listed.error ? errText(listed.error) : listed.stderr.trim() || `status ${listed.status}`}`);
  }
  return listed.stdout.split('\0').filter(Boolean).map((rel) => path.join(repoRoot, rel));
}

function validPair(p) {
  return p && Number.isInteger(p.numerator) && Number.isInteger(p.denominator)
    && p.numerator >= 0 && p.denominator > 0 && p.numerator <= p.denominator;
}

function readFloor() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(floorPath, 'utf8'));
  } catch (err) {
    refuse(`cannot read recorded floor ${floorPath}: ${errText(err)}`);
  }
  const gitIndex = raw?.git_index;
  const sessionMinRatio = raw?.session_min_ratio;
  if (!validPair(gitIndex) || !validPair(sessionMinRatio)) {
    refuse(`recorded floor ${floorPath} must hold {git_index, session_min_ratio}, each integers 0 <= numerator <= denominator, denominator > 0`);
  }
  return { git_index: gitIndex, session_min_ratio: sessionMinRatio };
}

function resolveCorpus(getDataRoot) {
  if (overrideRoot) {
    let files;
    try {
      files = walkTickets(overrideRoot);
    } catch (err) {
      refuse(`cannot enumerate ${overrideRoot}: ${errText(err)}`);
    }
    return { kind: 'override', files, scopeLabel: `override corpus at ${overrideRoot}` };
  }

  const dataRoot = getDataRoot();
  const sessionsDir = path.join(dataRoot, 'sessions');
  let sessionFiles = [];
  if (fs.existsSync(sessionsDir)) {
    try {
      sessionFiles = walkTickets(sessionsDir);
    } catch (err) {
      refuse(`cannot enumerate ${sessionsDir}: ${errText(err)}`);
    }
  }
  if (sessionFiles.length > 0) {
    return { kind: 'session', files: sessionFiles, scopeLabel: `session corpus at ${sessionsDir}` };
  }

  process.stderr.write(`audit-acceptance-assertion-coverage: falling back to git index — no sessions under ${sessionsDir}\n`);
  return {
    kind: 'git-index',
    files: trackedTickets(),
    scopeLabel: `git index of ${repoRoot} (no sessions under ${sessionsDir})`,
  };
}

let utilsModule;
try {
  utilsModule = await import(pathToFileURL(utilsPath).href);
} catch (err) {
  refuse(`cannot load data-root resolver ${utilsPath}: ${errText(err)}`);
}
const { getDataRoot } = utilsModule;
if (typeof getDataRoot !== 'function') {
  refuse(`${utilsPath} does not export getDataRoot`);
}

const { kind, files, scopeLabel } = resolveCorpus(getDataRoot);

let extractor;
try {
  extractor = await import(pathToFileURL(extractorPath).href);
} catch (err) {
  refuse(`cannot load extractor ${extractorPath}: ${errText(err)}`);
}
const { executableAcceptanceSection, readExecutableAcceptanceAssertions } = extractor;
if (typeof executableAcceptanceSection !== 'function' || typeof readExecutableAcceptanceAssertions !== 'function') {
  refuse(`${extractorPath} does not export executableAcceptanceSection and readExecutableAcceptanceAssertions`);
}

const floors = readFloor();
const floor = kind === 'session' ? floors.session_min_ratio : floors.git_index;
const floorLabel = kind === 'session' ? `session_min_ratio ${floor.numerator}/${floor.denominator}` : `git_index ${floor.numerator}/${floor.denominator}`;

let denominator = 0;
let numerator = 0;
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  if (executableAcceptanceSection(content).trim() === '') continue;
  denominator += 1;
  if (readExecutableAcceptanceAssertions(content).length > 0) numerator += 1;
}

if (denominator === 0) {
  refuse(`${scopeLabel}: UNMEASURED — ${files.length} tickets scanned, none with a non-empty Acceptance Criteria section (nothing measured is not clean)`);
}
process.stdout.write(`audit-acceptance-assertion-coverage: ${scopeLabel} — ${files.length} tickets scanned, measured ${numerator}/${denominator} guarded, recorded ${floorLabel}\n`);
if (numerator * floor.denominator < floor.numerator * denominator) {
  refuse(`${scopeLabel}: below floor: measured ${numerator}/${denominator} is below the recorded ${floorLabel} — tickets are being authored without an executable assertion`);
}
if (kind !== 'session' && (numerator !== floor.numerator || denominator !== floor.denominator)) {
  refuse(`${scopeLabel}: raise the floor: measured ${numerator}/${denominator} differs from the recorded ${floorLabel} — write numerator ${numerator}, denominator ${denominator} to git_index in ${floorPath}`);
}
NODE
