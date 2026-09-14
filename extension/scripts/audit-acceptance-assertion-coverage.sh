#!/usr/bin/env bash
# audit-acceptance-assertion-coverage.sh — O2: executable-assertion coverage is a ratchet, not a hope.
#
# If an authoring path stops emitting the backticked `<command>` exits|returns <N> form, every new ticket is
# unguarded and nothing notices. This audit measures, over the ticket corpus, how many tickets with a non-empty
# Acceptance Criteria section carry at least one executable assertion, and holds that figure to a recorded floor.
#
# Corpus: every git-tracked rick_ticket_*.md in the repo — DISCOVERED, never hand-listed.
# Denominator: tickets whose section is non-empty per the exported executableAcceptanceSection; tickets with no
# section are excluded. Numerator: tickets where the exported readExecutableAcceptanceAssertions yields >=1.
# Both readers are imported from the compiled extension/bin/mux-runner.js — there is no second regex here.
#
# Recorded floor: acceptance-assertion-coverage-floor.json beside this script, integers only.
#   below  fails when the measured ratio is below the recorded floor;
#   raise  fails when the measured pair differs from the record otherwise, naming the pair to write.
# Nothing measured is not clean: a failed enumeration, an unloadable extractor, a malformed floor or a
# denominator of 0 exits non-zero with a named reason.
#
# ACCEPTANCE_COVERAGE_ROOT_OVERRIDE=<dir> scans every rick_ticket_*.md under <dir> instead of the git index
# (fixture tests, or the live session corpus). The recorded floor is read either way.
# A gate that refuses a COMMIT/release — never a run. Exits non-zero on any finding.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXTENSION_ROOT/.." && pwd)"
EXTRACTOR="$EXTENSION_ROOT/bin/mux-runner.js"
FLOOR_PATH="$SCRIPT_DIR/acceptance-assertion-coverage-floor.json"

if ! command -v node >/dev/null 2>&1; then
  echo "audit-acceptance-assertion-coverage: node is required" >&2
  exit 1
fi
if [ ! -f "$EXTRACTOR" ]; then
  echo "audit-acceptance-assertion-coverage: extractor not compiled at $EXTRACTOR — run ./node_modules/.bin/tsc" >&2
  exit 1
fi

node --input-type=module - "$REPO_ROOT" "$EXTRACTOR" "$FLOOR_PATH" "${ACCEPTANCE_COVERAGE_ROOT_OVERRIDE:-}" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [repoRoot, extractorPath, floorPath, overrideRoot] = process.argv.slice(2);
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

function readFloor() {
  let floor;
  try {
    floor = JSON.parse(fs.readFileSync(floorPath, 'utf8'));
  } catch (err) {
    refuse(`cannot read recorded floor ${floorPath}: ${errText(err)}`);
  }
  const { numerator, denominator } = floor ?? {};
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator < 0 || denominator <= 0 || numerator > denominator) {
    refuse(`recorded floor ${floorPath} must hold integers 0 <= numerator <= denominator, denominator > 0`);
  }
  return { numerator, denominator };
}

let files;
try {
  files = overrideRoot ? walkTickets(overrideRoot) : trackedTickets();
} catch (err) {
  refuse(`cannot enumerate ${overrideRoot}: ${errText(err)}`);
}

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

const floor = readFloor();
let denominator = 0;
let numerator = 0;
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  if (executableAcceptanceSection(content).trim() === '') continue;
  denominator += 1;
  if (readExecutableAcceptanceAssertions(content).length > 0) numerator += 1;
}

const scope = overrideRoot || `git index of ${repoRoot}`;
if (denominator === 0) {
  refuse(`${files.length} tickets under ${scope}, none with a non-empty Acceptance Criteria section — nothing measured is not clean`);
}
process.stdout.write(`audit-acceptance-assertion-coverage: ${files.length} tickets scanned, measured ${numerator}/${denominator} guarded, recorded floor ${floor.numerator}/${floor.denominator}\n`);
if (numerator * floor.denominator < floor.numerator * denominator) {
  refuse(`below floor: measured ${numerator}/${denominator} is below the recorded ${floor.numerator}/${floor.denominator} — tickets are being authored without an executable assertion`);
}
if (numerator !== floor.numerator || denominator !== floor.denominator) {
  refuse(`raise the floor: measured ${numerator}/${denominator} differs from the recorded ${floor.numerator}/${floor.denominator} — write numerator ${numerator}, denominator ${denominator} to ${floorPath}`);
}
NODE
