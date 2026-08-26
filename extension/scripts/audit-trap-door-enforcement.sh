#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$EXTENSION_ROOT/.." && pwd)"
CLAUDE_PATH="${CLAUDE_PATH_OVERRIDE:-$EXTENSION_ROOT/CLAUDE.md}"
SOURCE_CLAUDE_PATH="$EXTENSION_ROOT/src/bin/CLAUDE.md"
SUBSYSTEM_CATALOG_ROOT="${SUBSYSTEM_CATALOG_ROOT_OVERRIDE:-$EXTENSION_ROOT/src}"
CLOSER_AUDIT_REPO="${CLOSER_AUDIT_REPO_OVERRIDE:-$REPO_ROOT}"

if [ ! -f "$CLAUDE_PATH" ]; then
  echo "[skipped: extension/CLAUDE.md not found]" >&2
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[error: node is required]" >&2
  exit 1
fi

audit_exit_code=0

fail() {
  echo "$1" >&2
  audit_exit_code=1
}

if ! node - "$CLAUDE_PATH" <<'NODE'
const fs = require('fs');

const [, , claudePath] = process.argv;
const text = fs.readFileSync(claudePath, 'utf8');
const lines = text.split('\n');
const entry = lines.find((line) => line.includes('(R-CNAR-1 part 2 cap split)'));

if (!entry) {
  process.stderr.write('R-CNAR-7 trap-door entry not found\n');
  process.exit(1);
}

const labels = ['INVARIANT', 'PATTERN_SHAPE', 'BREAKS', 'ENFORCE'];
let failures = 0;

for (const label of labels) {
  const nextLabelPattern = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => `${candidate}:`)
    .join('|');
  const match = entry.match(
    new RegExp(`${label}:([\\s\\S]*?)(?=\\s(?:${nextLabelPattern})|$)`)
  );

  if (!match || match[1].trim().length === 0) {
    process.stderr.write(`R-CNAR-7 trap-door entry is missing populated ${label} content\n`);
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}
NODE
then
  audit_exit_code=1
fi

if ! node - "$CLAUDE_PATH" <<'NODE'
const fs = require('fs');

const [, , claudePath] = process.argv;
const text = fs.readFileSync(claudePath, 'utf8');
const lines = text.split('\n');
const entry = lines.find((line) => line.includes('(dirty-tree guard)'));

if (!entry) {
  process.stderr.write('R-PDT-4 dirty-tree guard trap-door entry not found\n');
  process.exit(1);
}

const labels = ['INVARIANT', 'PATTERN_SHAPE', 'BREAKS', 'ENFORCE'];
let failures = 0;

for (const label of labels) {
  const nextLabelPattern = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => `${candidate}:`)
    .join('|');
  const match = entry.match(
    new RegExp(`${label}:([\\s\\S]*?)(?=\\s(?:${nextLabelPattern})|$)`)
  );

  if (!match || match[1].trim().length === 0) {
    process.stderr.write(`R-PDT-4 dirty-tree guard trap-door entry is missing populated ${label} content\n`);
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}
NODE
then
  audit_exit_code=1
fi

# Parse ENFORCE: references and check reachability via node so we get the
# same regex as trap-door-conformance.test.js (avoids BSD/GNU grep -P gap).
#
# Sweeps the primary catalog AND every subsystem catalog under src/*/CLAUDE.md.
# Scoping this to extension/CLAUDE.md alone left 150 of 365 refs unverified, which
# is how a phantom ENFORCE anchor shipped green under a gate that reported
# "215 ENFORCE reference(s) verified" — the catalog-anchor-executability trap door
# in extension/CLAUDE.md names this exact recurrence ("iter 8 swept only
# extension/CLAUDE.md, and all four anchors iter 9 found false sat in the siblings").
if ! node - "$CLAUDE_PATH" "$EXTENSION_ROOT" "$REPO_ROOT" "$SUBSYSTEM_CATALOG_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const [,, primaryClaudePath, extensionRoot, repoRoot, subsystemCatalogRoot] = process.argv;

const VALID_TIERS = new Set(['fast', 'integration', 'expensive', 'contract']);

// Discovered, never hand-listed: a new subsystem catalog enters the sweep the
// moment it lands, so the sweep cannot drift behind the catalogs it verifies.
// TWO roots, ONE rule. `extension/src/*/` holds the compiled-source subsystems;
// `<repoRoot>/*/` holds every subsystem anatomy-park reviews outside it — repo-root
// `bin/` is enumerated by `discoverSubsystems` exactly like they are and writes its
// trap doors to `bin/CLAUDE.md`, which a src-only walk never sees. `extension` is
// skipped in the repo-root pass: that catalog is the primary, which
// CLAUDE_PATH_OVERRIDE may replace.
function discoverCatalogs() {
  const catalogs = [primaryClaudePath];

  for (const [root, skipDir] of [[subsystemCatalogRoot, null], [repoRoot, 'extension']]) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === skipDir) continue;
      const candidate = path.join(root, entry.name, 'CLAUDE.md');
      if (fs.existsSync(candidate) && !catalogs.includes(candidate)) {
        catalogs.push(candidate);
      }
    }
  }

  return catalogs;
}

// A trap-door ENFORCE ref may name one test case (`…/foo.test.js#AC-CF-15`). The
// catalogs author that anchor three ways — an ID prefix (`AP-RMS-12` for
// `test('AP-RMS-12: …')`), a bare leading word (`Backend`), and a kebab slug of a
// test-name SUFFIX (`a-linked-worktree-still-stamps-the-trailer`). ONE uniform rule
// admits all three: slug both sides, then require segment-boundary containment, so
// `AP-RMS-1` does NOT falsely resolve against `AP-RMS-12`.
const slugify = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const TEST_NAME_RE = /\b(?:it|test)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

function anchorResolves(fileContent, anchor) {
  const needle = `-${slugify(anchor)}-`;
  for (const m of fileContent.matchAll(TEST_NAME_RE)) {
    if (`-${slugify(m[2])}-`.includes(needle)) return true;
  }
  return false;
}

// Collect all ENFORCE: test file references using the same regex as
// extractEnforceTestFiles() in trap-door-conformance.test.js, plus the optional
// `#anchor` that the file-only regex used to drop on the floor.
function collectEnforceRefs(claudePath) {
  const lines = fs.readFileSync(claudePath, 'utf8').split('\n');
  // Keyed on `rel#anchor` so each anchored ref is verified on its own, while every
  // bare ref to one file still collapses to a single `rel#` entry as before.
  const enforceFiles = new Map(); // 'rel#anchor' -> { rel, anchor, lineNum }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('ENFORCE:')) continue;

    // Gather entry text (current line + continuation until next entry/section)
    let entryText = line;
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('- ') && !lines[j].startsWith('## ')) {
      entryText += '\n' + lines[j];
      j++;
    }

    const matches = entryText.matchAll(
      /\b((?:extension\/)?tests\/[A-Za-z0-9_./-]+\.test\.js)\b(?:#([A-Za-z0-9_.:-]+))?/g
    );
    for (const m of matches) {
      const key = `${m[1]}#${m[2] ?? ''}`;
      if (!enforceFiles.has(key)) {
        enforceFiles.set(key, { rel: m[1], anchor: m[2] ?? null, lineNum: i + 1 });
      }
    }
  }

  return enforceFiles;
}

let failures = 0;
let verified = 0;
const perCatalog = [];

for (const claudePath of discoverCatalogs()) {
  // Label carries the catalog so a phantom anchor is attributable to its file,
  // not just a bare line number that could belong to any of six catalogs.
  const label = path.relative(repoRoot, claudePath) || claudePath;
  const enforceFiles = collectEnforceRefs(claudePath);
  perCatalog.push(`${label}=${enforceFiles.size}`);

  for (const { rel, anchor, lineNum } of enforceFiles.values()) {
    // Resolve: 'extension/tests/...' → repo root; 'tests/...' → extension root
    const absPath = rel.startsWith('extension/')
      ? path.join(repoRoot, rel)
      : path.join(extensionRoot, rel);

    if (!fs.existsSync(absPath)) {
      process.stderr.write(`ENFORCE: ${label}:${lineNum}: missing file: ${rel}\n`);
      failures++;
      continue;
    }

    // Read first meaningful line (skip shebang and blank lines)
    const fileContent = fs.readFileSync(absPath, 'utf8');
    const firstMeaningful = fileContent.split(/\r?\n/).find(
      l => !l.startsWith('#!') && l.trim() !== ''
    ) ?? '';

    const tierMatch = firstMeaningful.match(/^\/\/\s*@tier:\s*([A-Za-z0-9_-]+)\s*$/);
    if (!tierMatch || !VALID_TIERS.has(tierMatch[1])) {
      process.stderr.write(
        `ENFORCE: ${label}:${lineNum}: no valid @tier annotation in ${rel} (first line: ${firstMeaningful.substring(0, 80)})\n`
      );
      failures++;
      continue;
    }

    // The @tier check above proves only that the FILE is reachable. Without this the
    // anchor was parsed and discarded, so a phantom `#anchor` still counted as
    // "verified" — the exact recurrence the catalog-widening fix above set out to close.
    if (anchor && !anchorResolves(fileContent, anchor)) {
      process.stderr.write(
        `ENFORCE: ${label}:${lineNum}: anchor #${anchor} matches no test case in ${rel}\n`
      );
      failures++;
      continue;
    }

    verified++;
  }
}

if (failures > 0) {
  process.stderr.write(`\n${failures} ENFORCE reference(s) unreachable\n`);
  process.exit(1);
}

console.log(
  `audit-trap-door-enforcement: ${verified} ENFORCE reference(s) verified across ${perCatalog.length} catalog(s) (${perCatalog.join(', ')})`
);
NODE
then
  audit_exit_code=1
fi

# INVARIANT symbol liveness (AC-V3).
#
# The ENFORCE arm above proves a REFERENCE resolves. Nothing proved that the
# INVARIANT clause names a symbol that still EXISTS. Anatomy-park found three dead
# anchors in one phase with three distinct causes — a rename deleted the symbol
# (`ea40a7e2`), a refactor deleted it as a pure pass-through (`c0b6c2e5`), and one
# was FALSE AT BIRTH and never existed in any commit (`15866fa6`). In all three the
# guard was intact; only the naming was wrong, which is worse than a missing entry:
# a reviewer greps the name, finds nothing, and concludes the guard was deleted.
#
# THE CONVENTION THIS ARM ENFORCES: a backticked bare identifier inside an
# INVARIANT: clause is a CLAIM THAT THE SYMBOL IS LIVE. A clause that deliberately
# names an ABSENT symbol must not backtick it (see the R-POD clause in
# src/services/CLAUDE.md, which asserts a constant name that never existed).
#
# THIS COMMENT IS PART OF THE CORPUS. Every tracked non-.md file is, including this
# script and the tests. Writing a dead identifier here as a literal REVIVES it and
# silently defuses the anchor that names it — this arm's first run proved it, by
# quoting the R-POD name above and dropping its own two true positives from four to
# two. Name such symbols indirectly, never as a bare token.
#
# CANDIDATE RULE — one predicate, NO list. A backticked span is a candidate iff the
# WHOLE span is a single bare identifier. Deliberately NOT "identifier-ish shapes
# minus a skip list of paths/event-names/settings-keys": a skip list is the
# incomplete-set shape CLAUDE.md forbids, one omission from the next silent bypass.
# The widest rule is also the greenest — applying no shape filter at all leaves only
# the handful of genuinely dead anchors, so nothing is bought by narrowing it.
# NOTHING IS DROPPED SILENTLY: the non-identifier spans are COUNTED and printed in
# the success line, so the unchecked population is a visible number that moves when
# the catalogs change.
#
# CORPUS — a word set over every tracked non-.md file, comments INCLUDED.
#   * An AST walk was rejected: it structurally cannot see shell/env identifiers,
#     JSON keys, string-literal values, or node code inside shell heredocs
#     (`discoverCatalogs` itself is declared in a heredoc in THIS file), which
#     reports live symbols as dead.
#   * Stripping comments first was rejected ON MEASUREMENT: it turns the live
#     `referencedFiles` (services/citadel/trap-door-coverage-audit.js) into a
#     failure, because that file has `/*` inside a REGEX LITERAL and a
#     block-comment regex swallows live code from there on. Regex cannot lex, and a
#     FALSE POSITIVE reddens a green release gate — strictly worse than a missed one.
#   * FALSE-NEGATIVE COST, stated: a dead symbol still named in a COMMENT resolves
#     as live (e.g. the retired `SCOPE_ARCHIVE_EXISTS`). This does not defeat the
#     three motivating cases — for all three, the surviving comment mention was
#     introduced by the FIX commit, so while each anchor was dead-but-uncorrected
#     the name had zero non-.md hits and this arm would have caught it.
#
# BREAKS: is OUT OF SCOPE by design — it describes historical breakage and
# legitimately names dead symbols; sweeping it would red correct entries.
if ! node - "$CLAUDE_PATH" "$EXTENSION_ROOT" "$REPO_ROOT" "$SUBSYSTEM_CATALOG_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [, , primaryClaudePath, extensionRoot, repoRoot, subsystemCatalogRoot] = process.argv;

// Same two-roots-one-rule discovery as the ENFORCE arm: a new subsystem catalog
// enters the sweep the moment it lands, so this cannot drift behind the catalogs.
function discoverCatalogs() {
  const catalogs = [primaryClaudePath];

  for (const [root, skipDir] of [[subsystemCatalogRoot, null], [repoRoot, 'extension']]) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === skipDir) continue;
      const candidate = path.join(root, entry.name, 'CLAUDE.md');
      if (fs.existsSync(candidate) && !catalogs.includes(candidate)) {
        catalogs.push(candidate);
      }
    }
  }

  return catalogs;
}

// Clause terminators. This IS the catalog's authored grammar, not a guess about an
// open world, and it FAILS LOUD: an unlisted label makes the INVARIANT clause
// over-read into the next clause, which reds the gate where a human looks — the
// opposite of the silent-miss failure an option enumeration produces.
// TICKET_TRACEABILITY is listed because its body is backticked commit SHAs, which
// are deliberately not symbols.
const CLAUSE_TERMINATORS = ['INVARIANT', 'PATTERN_SHAPE', 'BREAKS', 'ENFORCE', 'TICKET_TRACEABILITY'];
const CLAUSE_RE = new RegExp(
  `INVARIANT:([\\s\\S]*?)(?=\\s(?:${CLAUSE_TERMINATORS.map((l) => `${l}:`).join('|')})|$)`,
  'g'
);
const BACKTICKED_RE = /`([^`\n]+)`/g;
const BARE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

// Entry grammar is the ENFORCE arm's: the line, plus every following line until one
// starts a new entry ('- ') or a new section ('## ').
function collectInvariantClauses(claudePath) {
  const lines = fs.readFileSync(claudePath, 'utf8').split('\n');
  const clauses = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('INVARIANT:')) continue;

    let entryText = lines[i];
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('- ') && !lines[j].startsWith('## ')) {
      entryText += '\n' + lines[j];
      j++;
    }

    for (const match of entryText.matchAll(CLAUSE_RE)) {
      clauses.push({ lineNum: i + 1, text: match[1] });
    }
  }

  return clauses;
}

// maxBuffer is mandatory, not decorative: the 1 MB default was breached at 96b08eba
// and turned a sibling whole-repo enumeration into `spawnSync git ENOBUFS`
// (the 64 MB ceiling is the named trap door in src/services/CLAUDE.md).
function buildSymbolCorpus() {
  let tracked;
  try {
    tracked = execFileSync('git', ['ls-files', '-z'], {
      encoding: 'utf8',
      cwd: repoRoot,
      timeout: 15000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    process.stderr.write(`INVARIANT: cannot enumerate tracked files: ${err.message}\n`);
    process.exit(1);
  }

  const words = new Set();
  let fileCount = 0;

  for (const rel of tracked.split('\0')) {
    if (!rel || rel.endsWith('.md')) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    fileCount++;
    for (const word of text.matchAll(WORD_RE)) words.add(word[0]);
  }

  return { words, fileCount };
}

const { words, fileCount } = buildSymbolCorpus();

let failures = 0;
let verified = 0;
let nonIdentifierSpans = 0;
const perCatalog = [];

for (const claudePath of discoverCatalogs()) {
  const label = path.relative(repoRoot, claudePath) || claudePath;
  const clauses = collectInvariantClauses(claudePath);
  let catalogCandidates = 0;

  for (const { lineNum, text } of clauses) {
    for (const span of text.matchAll(BACKTICKED_RE)) {
      const candidate = span[1].trim();

      if (!BARE_IDENTIFIER_RE.test(candidate)) {
        nonIdentifierSpans++;
        continue;
      }

      catalogCandidates++;

      if (!words.has(candidate)) {
        process.stderr.write(
          `INVARIANT: ${label}:${lineNum}: names a symbol absent from the tree: ${candidate}\n`
        );
        failures++;
        continue;
      }

      verified++;
    }
  }

  perCatalog.push(`${label}=${catalogCandidates}`);
}

if (failures > 0) {
  process.stderr.write(
    `\n${failures} INVARIANT symbol reference(s) name a symbol absent from the tree.\n` +
      'Fix the NAME to the live symbol, or — if the clause deliberately names an ABSENT ' +
      'symbol — drop its backticks, which is what marks it as a liveness claim. ' +
      'Do not weaken this arm to accommodate a bad anchor.\n'
  );
  process.exit(1);
}

console.log(
  `audit-trap-door-enforcement: ${verified} INVARIANT symbol(s) verified across ` +
    `${perCatalog.length} catalog(s) (${perCatalog.join(', ')}) ` +
    `against ${words.size} symbols in ${fileCount} tracked file(s); ` +
    `${nonIdentifierSpans} non-identifier span(s) not checked`
);
NODE
then
  audit_exit_code=1
fi

if ! node - "$SOURCE_CLAUDE_PATH" "$REPO_ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');

const [,, sourceClaudePath, repoRoot] = process.argv;

if (!fs.existsSync(sourceClaudePath)) {
  process.stderr.write(`R-MMTR-5 source trap-door file not found: ${sourceClaudePath}\n`);
  process.exit(1);
}

const text = fs.readFileSync(sourceClaudePath, 'utf8');
const lines = text.split('\n');
const entry = lines.find((line) => line.includes('(R-MMTR-3 claude max-turns relaunch)'));

if (!entry) {
  process.stderr.write('R-MMTR-5 trap-door entry not found in extension/src/bin/CLAUDE.md\n');
  process.exit(1);
}

const labels = ['INVARIANT', 'BREAKS', 'ENFORCE'];
for (const label of labels) {
  const nextLabelPattern = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => `${candidate}:`)
    .join('|');
  const match = entry.match(
    new RegExp(`${label}:([\\s\\S]*?)(?=\\s(?:${nextLabelPattern})|$)`)
  );

  if (!match || match[1].trim().length === 0) {
    process.stderr.write(`R-MMTR-5 trap-door entry is missing populated ${label} content\n`);
    process.exit(1);
  }
}

const requiredSnippets = [
  'mux-runner.ts:3696-3730',
  'evaluateManagerRelaunch',
  'Defaults.CLAUDE_MANAGER_RELAUNCH_CAP',
  'CLAUDE_MANAGER_RELAUNCH_CAP=20',
];

for (const snippet of requiredSnippets) {
  if (!entry.includes(snippet)) {
    process.stderr.write(`R-MMTR-5 trap-door entry missing required snippet: ${snippet}\n`);
    process.exit(1);
  }
}

const matches = [...entry.matchAll(/\b((?:extension\/)?tests\/[A-Za-z0-9_./-]+\.test\.js)\b/g)];
const expected = [
  'extension/tests/mux-runner-claude-max-turns-relaunch.test.js',
  'extension/tests/manager-relaunch.test.js',
];

for (const rel of expected) {
  if (!matches.some((match) => match[1] === rel)) {
    process.stderr.write(`R-MMTR-5 trap-door ENFORCE is missing expected test: ${rel}\n`);
    process.exit(1);
  }

  const absPath = path.join(repoRoot, rel);
  if (!fs.existsSync(absPath)) {
    process.stderr.write(`R-MMTR-5 trap-door ENFORCE target missing: ${rel}\n`);
    process.exit(1);
  }

  const fileContent = fs.readFileSync(absPath, 'utf8');
  const firstMeaningful = fileContent.split(/\r?\n/).find(
    (line) => !line.startsWith('#!') && line.trim() !== ''
  ) ?? '';

  if (!/^\/\/\s*@tier:\s*(fast|integration|expensive|contract)\s*$/.test(firstMeaningful)) {
    process.stderr.write(`R-MMTR-5 trap-door ENFORCE target missing valid @tier: ${rel}\n`);
    process.exit(1);
  }
}

console.log('audit-trap-door-enforcement: R-MMTR-5 source trap-door verified');
NODE
then
  audit_exit_code=1
fi

if ! bash "$SCRIPT_DIR/audit-phantom-done-call-sites.sh"; then
  audit_exit_code=1
fi

if rg -n -e "npm (ci|install)" \
  "$EXTENSION_ROOT/src/bin/spawn-morty.ts" \
  "$EXTENSION_ROOT/src/bin/mux-runner.ts" >/dev/null; then
  fail 'worker boot paths must reuse extension/node_modules; found npm ci/install in spawn-morty.ts or mux-runner.ts'
fi

# T-HARDEN-PROBE: verify --judge-probe requires PICKLE_JUDGE_PROBE_ALLOWED=1 guard
if ! node - "$EXTENSION_ROOT/src/bin/microverse-runner.ts" <<'NODE'
const fs = require('fs');
const [,, sourcePath] = process.argv;

const text = fs.readFileSync(sourcePath, 'utf8');

// Verify --judge-probe flag check exists in the CLI entry block
const probeIdx = text.indexOf("'--judge-probe'");
if (probeIdx < 0) {
  process.stderr.write('T-HARDEN-PROBE: --judge-probe flag not found in microverse-runner.ts\n');
  process.exit(1);
}

// Verify PICKLE_JUDGE_PROBE_ALLOWED guard appears AFTER the --judge-probe check
// (inside the same if-block) within 300 chars
const afterProbe = text.slice(probeIdx);
const guardIdx = afterProbe.indexOf('PICKLE_JUDGE_PROBE_ALLOWED');
if (guardIdx < 0 || guardIdx > 300) {
  process.stderr.write(
    'T-HARDEN-PROBE: PICKLE_JUDGE_PROBE_ALLOWED guard must appear within 300 chars after --judge-probe check\n'
  );
  process.exit(1);
}

console.log('T-HARDEN-PROBE: --judge-probe env guard verified in microverse-runner.ts');
NODE
then
  audit_exit_code=1
fi

# R-CLOSER-ADJACENCY-AUDIT: closer commits must include the 6-step adjacency-audit section
if ! node - "$CLOSER_AUDIT_REPO" <<'NODE'
const { execFileSync } = require('child_process');

const [,, repoRoot] = process.argv;

// Find the commit that introduced R-CLOSER-ADJACENCY-AUDIT to citadel.md.
// Only check closer commits after that point — the template didn't exist before.
let baselineSha = '';
try {
  const pickaxeOut = execFileSync(
    'git',
    ['log', '--oneline', '-S', 'R-CLOSER-ADJACENCY-AUDIT', '--', '.claude/commands/citadel.md'],
    { encoding: 'utf8', cwd: repoRoot, timeout: 10000 }
  ).trim();
  const lines = pickaxeOut.split('\n').filter(Boolean);
  if (lines.length > 0) {
    // Last line is the oldest commit that introduced the template
    baselineSha = lines[lines.length - 1].trim().split(/\s+/)[0];
  }
} catch (_) {
  // Can't determine baseline; check all commits
}

const range = baselineSha ? `${baselineSha}..HEAD` : 'HEAD';
let logOutput;
try {
  logOutput = execFileSync(
    'git',
    ['log', '--format=%H%x00%s%x00%b%x02', range],
    // Full commit BODIES accumulate here, so this output grows without bound as the
    // branch advances; Node's 1MB default maxBuffer breached at 96b08eba (1049881B)
    // and turned the whole audit into `spawnSync git ENOBUFS`.
    { encoding: 'utf8', cwd: repoRoot, timeout: 15000, maxBuffer: 64 * 1024 * 1024 }
  );
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`R-CLOSER-ADJACENCY-AUDIT: git log failed: ${msg}\n`);
  process.exit(1);
}

const commits = logOutput.split('\x02').map(s => s.trim()).filter(Boolean);

const closerSubjectRe = /^(fix|chore|docs)\([0-9a-f]{6,12}\): R-.*[Cc]loser/;
// Detect by body only when the section header itself is present — prevents false
// positives on implementation commits that describe the audit protocol in prose.
const adjacencyBodyRe = /^## Adjacency audit \(R-CLOSER-ADJACENCY-AUDIT\)/m;
const sectionHeaderRe = /^## Adjacency audit \(R-CLOSER-ADJACENCY-AUDIT\)/m;
const itemRe = /^(?:\d+\.|-) .+: (?:Y|N|N\/A)\b/gm;

const failures = [];
let closerCount = 0;

for (const commitText of commits) {
  const nul1 = commitText.indexOf('\x00');
  const nul2 = nul1 >= 0 ? commitText.indexOf('\x00', nul1 + 1) : -1;
  if (nul1 < 0 || nul2 < 0) continue;

  const hash = commitText.slice(0, nul1).trim();
  const subject = commitText.slice(nul1 + 1, nul2).trim();
  const body = commitText.slice(nul2 + 1);

  const isCloser = closerSubjectRe.test(subject) || adjacencyBodyRe.test(body);
  if (!isCloser) continue;
  closerCount++;

  if (!sectionHeaderRe.test(body)) {
    failures.push(
      `${hash.slice(0, 12)} "${subject}": missing "## Adjacency audit (R-CLOSER-ADJACENCY-AUDIT)" section`
    );
    continue;
  }

  const items = body.match(itemRe) || [];
  if (items.length < 6) {
    failures.push(
      `${hash.slice(0, 12)} "${subject}": adjacency-audit section has ${items.length}/6 Y/N items (need ≥6)`
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `R-CLOSER-ADJACENCY-AUDIT: ${failures.length} closer commit(s) missing adjacency-audit section:\n`
  );
  for (const f of failures) {
    process.stderr.write(`  ${f}\n`);
  }
  process.exit(1);
}

console.log(
  `audit-trap-door-enforcement: R-CLOSER-ADJACENCY-AUDIT: ${closerCount} closer commit(s) checked, all pass`
);
NODE
then
  audit_exit_code=1
fi

# R-AFCC-STAGE: non-repo workingDir containment — verify canonical literals present in ticket-completion-evidence.ts
if ! node - "$EXTENSION_ROOT/src/services/ticket-completion-evidence.ts" <<'NODE'
const fs = require('fs');
const [,, sourcePath] = process.argv;

const text = fs.readFileSync(sourcePath, 'utf8');

// Canonical literal 1: R-AFCC-STAGE annotation comment
if (!text.includes('// R-AFCC-STAGE:')) {
  process.stderr.write('R-AFCC-STAGE: canonical annotation "// R-AFCC-STAGE:" missing from ticket-completion-evidence.ts\n');
  process.exit(1);
}

// Canonical literal 2: required-throw guard in persistEvidence
if (!text.includes("if (opts.stage === 'required') throw")) {
  process.stderr.write('R-AFCC-STAGE: canonical literal "if (opts.stage === \'required\') throw" missing from ticket-completion-evidence.ts\n');
  process.exit(1);
}

console.log('audit-trap-door-enforcement: R-AFCC-STAGE literals verified');
NODE
then
  audit_exit_code=1
fi

# R-AFCC-WRITE-OBSERVABILITY: write-vs-stage telemetry split — verify staged?: boolean in PersistResult
if ! node - "$EXTENSION_ROOT/src/services/ticket-completion-evidence.ts" <<'NODE'
const fs = require('fs');
const [,, sourcePath] = process.argv;

const text = fs.readFileSync(sourcePath, 'utf8');

// Canonical literal: staged?: boolean field in PersistResult
if (!text.includes('staged?: boolean')) {
  process.stderr.write('R-AFCC-WRITE-OBSERVABILITY: canonical literal "staged?: boolean" missing from ticket-completion-evidence.ts\n');
  process.exit(1);
}

console.log('audit-trap-door-enforcement: R-AFCC-WRITE-OBSERVABILITY literal verified');
NODE
then
  audit_exit_code=1
fi

# R-AFCC-CALLER-ENUMERATION: oracle callsite audit — verify exactly 2 caller files import ticket-completion-evidence
if ! node - "$EXTENSION_ROOT/src" <<'NODE'
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const [,, srcDir] = process.argv;

let grepOutput;
try {
  grepOutput = execFileSync(
    'grep',
    ['-rln', 'ticket-completion-evidence', srcDir, '--include=*.ts'],
    { encoding: 'utf8', timeout: 10000 }
  );
} catch (e) {
  // grep exits 1 when no matches — treat as 0 files
  grepOutput = (e.stdout) || '';
}

const files = grepOutput.trim().split('\n').filter(Boolean)
  .filter(f => !f.endsWith('ticket-completion-evidence.ts'));

const EXPECTED_CALLERS = [
  'mux-runner.ts',
  'auto-fill-completion-commit.ts',
];

const basenames = files.map(f => path.basename(f));
const missing = EXPECTED_CALLERS.filter(e => !basenames.includes(e));
const unexpected = basenames.filter(b => !EXPECTED_CALLERS.includes(b));

let failures = 0;

if (files.length !== EXPECTED_CALLERS.length) {
  process.stderr.write(
    `R-AFCC-CALLER-ENUMERATION: expected exactly ${EXPECTED_CALLERS.length} caller files, found ${files.length}\n`
  );
  failures++;
}

if (missing.length > 0) {
  process.stderr.write(
    `R-AFCC-CALLER-ENUMERATION: expected caller(s) missing: ${missing.join(', ')}\n`
  );
  failures++;
}

if (unexpected.length > 0) {
  process.stderr.write(
    `R-AFCC-CALLER-ENUMERATION: unexpected new caller(s) found — update pin count: ${unexpected.join(', ')}\n`
  );
  failures++;
}

if (failures > 0) {
  process.exit(1);
}

console.log(`audit-trap-door-enforcement: R-AFCC-CALLER-ENUMERATION verified (${files.length} callers: ${basenames.join(', ')})`);
NODE
then
  audit_exit_code=1
fi

# B-1SEAM WS-1: completion-predicate single-seam pins (mirrors
# extension/tests/completion-predicate-single-seam.test.js; importer-set pin 3
# is the R-AFCC-CALLER-ENUMERATION block above).
if ! node - "$EXTENSION_ROOT/src" <<'NODE'
const fs = require('fs');
const path = require('path');

const [,, srcDir] = process.argv;
let failures = 0;

const ORACLE_BASENAME = 'ticket-completion-evidence.ts';
// Enumerated buildCompletionCtx consumers in mux-runner.ts: collectTwinEvidence,
// validateAutoTicketCompletion, isTicketOracleCommitted,
// guardCompletionCommitBeforeDone, attributeBoundaryHeadMoved, defaultDoneGuard.
const MUX_PREDICATE_CALLSITES = 6;
// A callsite passes an argument; the guard refusal string's zero-arg prose form
// `readEvidence().kind` is spared by the [^)\s] after the paren.
const READ_EVIDENCE_CALLSITE_RE = /\breadEvidence\(\s*[^)\s]/;

function walkTs(dir) {
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkTs(full));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) result.push(full);
  }
  return result;
}

function nonCommentText(content) {
  return content.split('\n').filter((line) => {
    const t = line.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');
}

function extractTopLevelFunction(content, signature, label) {
  const start = content.indexOf(signature);
  if (start === -1) {
    process.stderr.write(`B-1SEAM: ${label}: ${signature} not found in mux-runner.ts\n`);
    failures++;
    return '';
  }
  // \n}\n terminator: bare \n} would truncate at a multi-line params type's column-0 }).
  const end = content.indexOf('\n}\n', start);
  if (end === -1) {
    process.stderr.write(`B-1SEAM: ${label}: no column-0 closing brace after ${signature}\n`);
    failures++;
    return '';
  }
  return content.slice(start, end + 3);
}

// Pin 1: zero readEvidence(<arg>) callsites outside the oracle.
for (const filePath of walkTs(srcDir)) {
  if (path.basename(filePath) === ORACLE_BASENAME) continue;
  if (READ_EVIDENCE_CALLSITE_RE.test(nonCommentText(fs.readFileSync(filePath, 'utf8')))) {
    process.stderr.write(`B-1SEAM: readEvidence( callsite outside ${ORACLE_BASENAME}: ${path.relative(srcDir, filePath)}\n`);
    failures++;
  }
}

// Pin 2: exact evaluateCompletionEvidence( callsite counts.
const muxContent = fs.readFileSync(path.join(srcDir, 'bin', 'mux-runner.ts'), 'utf8');
const autoFillContent = fs.readFileSync(path.join(srcDir, 'bin', 'auto-fill-completion-commit.ts'), 'utf8');
const muxCount = (nonCommentText(muxContent).match(/evaluateCompletionEvidence\(/g) || []).length;
const autoFillCount = (nonCommentText(autoFillContent).match(/evaluateCompletionEvidence\(/g) || []).length;
if (muxCount !== MUX_PREDICATE_CALLSITES) {
  process.stderr.write(`B-1SEAM: evaluateCompletionEvidence( in mux-runner.ts = ${muxCount}, expected exactly ${MUX_PREDICATE_CALLSITES}\n`);
  failures++;
}
if (autoFillCount !== 1) {
  process.stderr.write(`B-1SEAM: evaluateCompletionEvidence( in auto-fill-completion-commit.ts = ${autoFillCount}, expected exactly 1\n`);
  failures++;
}

// Pin 4: defaultDoneGuard routes through the predicate; no bare field-presence accept.
const doneGuard = extractTopLevelFunction(muxContent, 'function defaultDoneGuard(', 'pin 4');
if (doneGuard && !doneGuard.includes('evaluateCompletionEvidence(')) {
  process.stderr.write('B-1SEAM: defaultDoneGuard body missing evaluateCompletionEvidence( (accept-here-revert-there split)\n');
  failures++;
}
if (doneGuard && /\.length\s*>\s*0/.test(doneGuard)) {
  process.stderr.write('B-1SEAM: defaultDoneGuard contains a bare .length > 0 field-presence accept\n');
  failures++;
}

// Pin 5: the Done-flip guard routes through the predicate (predicate UNDER the guard).
const guard = extractTopLevelFunction(muxContent, 'export function guardCompletionCommitBeforeDone(', 'pin 5');
if (guard && !guard.includes('evaluateCompletionEvidence(')) {
  process.stderr.write('B-1SEAM: guardCompletionCommitBeforeDone body missing evaluateCompletionEvidence(\n');
  failures++;
}

if (failures > 0) process.exit(1);
console.log(`audit-trap-door-enforcement: B-1SEAM completion-predicate single-seam verified (mux callsites: ${muxCount}, auto-fill: ${autoFillCount})`);
NODE
then
  audit_exit_code=1
fi

# R-AFCC-DEEP-CONSOLIDATED: single oracle — verify surviving entry points present and pruned exports absent
if ! node - "$EXTENSION_ROOT/src/services/ticket-completion-evidence.ts" <<'NODE'
const fs = require('fs');
const [,, sourcePath] = process.argv;

const text = fs.readFileSync(sourcePath, 'utf8');

const requiredExports = [
  'export function readEvidence',
  'export function persistEvidence',
  'export function gateForPhantomDoneRevert',
];

const prunedExports = [
  'export function gateForDoneFlip',
  'export function recordPostGateOutcome',
];

let failures = 0;

for (const sym of requiredExports) {
  if (!text.includes(sym)) {
    process.stderr.write(`R-AFCC-DEEP-CONSOLIDATED: required export missing: "${sym}" in ticket-completion-evidence.ts\n`);
    failures++;
  }
}

for (const sym of prunedExports) {
  if (text.includes(sym)) {
    process.stderr.write(`R-AFCC-DEEP-CONSOLIDATED: pruned export re-introduced: "${sym}" in ticket-completion-evidence.ts\n`);
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log('audit-trap-door-enforcement: R-AFCC-DEEP-CONSOLIDATED oracle surface verified');
NODE
then
  audit_exit_code=1
fi

# AC-8 MCP forwarding invariant: verify trap door entry present in services/CLAUDE.md with all required labels
if ! node - "$EXTENSION_ROOT/src/services/CLAUDE.md" <<'NODE'
const fs = require('fs');

const [,, claudePath] = process.argv;
const text = fs.readFileSync(claudePath, 'utf8');
const lines = text.split('\n');
const entry = lines.find((line) => line.includes('(AC-8 MCP forwarding invariant)'));

if (!entry) {
  process.stderr.write('AC-8 MCP forwarding invariant: trap-door entry not found in extension/src/services/CLAUDE.md\n');
  process.exit(1);
}

const labels = ['INVARIANT', 'PATTERN_SHAPE', 'BREAKS', 'ENFORCE'];
let failures = 0;

for (const label of labels) {
  const nextLabelPattern = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => `${candidate}:`)
    .join('|');
  const match = entry.match(
    new RegExp(`${label}:([\\s\\S]*?)(?=\\s(?:${nextLabelPattern})|$)`)
  );

  if (!match || match[1].trim().length === 0) {
    process.stderr.write(`AC-8 MCP forwarding invariant: trap-door entry is missing populated ${label} content\n`);
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log('audit-trap-door-enforcement: AC-8 MCP forwarding invariant trap-door verified');
NODE
then
  audit_exit_code=1
fi

if ! node - "$CLAUDE_PATH" <<'NODE'
const fs = require('fs');

const [, , claudePath] = process.argv;
const text = fs.readFileSync(claudePath, 'utf8');
const lines = text.split('\n');
const entry = lines.find((line) => line.includes('(R-RASO attributable-frontmatter-sha single oracle)'));

if (!entry) {
  process.stderr.write('R-RASO attributable-frontmatter-sha single oracle: trap-door entry not found in extension/CLAUDE.md\n');
  process.exit(1);
}

const labels = ['INVARIANT', 'PATTERN_SHAPE', 'BREAKS', 'ENFORCE'];
let failures = 0;

for (const label of labels) {
  const nextLabelPattern = labels
    .filter((candidate) => candidate !== label)
    .map((candidate) => `${candidate}:`)
    .join('|');
  const match = entry.match(
    new RegExp(`${label}:([\\s\\S]*?)(?=\\s(?:${nextLabelPattern})|$)`)
  );

  if (!match || match[1].trim().length === 0) {
    process.stderr.write(`R-RASO attributable-frontmatter-sha single oracle: trap-door entry is missing populated ${label} content\n`);
    failures++;
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log('audit-trap-door-enforcement: R-RASO attributable-frontmatter-sha single oracle trap-door verified');
NODE
then
  audit_exit_code=1
fi

exit "$audit_exit_code"
