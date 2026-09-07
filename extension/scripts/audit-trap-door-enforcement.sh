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
    } catch (err) {
      // A root the walk cannot ENTER drops every subsystem CLAUDE.md beneath it while
      // perCatalog -- the number the verdict line reports -- stays satisfied by the
      // readable roots. Measured on the shipped script before this fix: a dark
      // subsystem root collapsed the census from 649 ENFORCE refs across 8 catalogs to
      // 331 across 3, still printing `verified` and still exiting 0. Same swallow that
      // 057b4bec fixed in audit-did-we-count.sh:findClaudeMdFiles; one report, both
      // walks. Fail here rather than counting it: no census over the surviving roots is
      // admissible once an unknown number of catalogs went unswept, so there is no
      // partial verdict worth printing.
      process.stderr.write(
        `catalog discovery: ${path.relative(repoRoot, root) || root}: unreadable catalog ` +
          'root -- every subsystem CLAUDE.md beneath it would go unswept, so no census ' +
          `over the remaining catalogs can be reported as verified (${err instanceof Error ? err.message : String(err)})\n`
      );
      process.exit(1);
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

function anchorMatchCount(fileContent, anchor) {
  const needle = `-${slugify(anchor)}-`;
  let count = 0;
  for (const m of fileContent.matchAll(TEST_NAME_RE)) {
    if (`-${slugify(m[2])}-`.includes(needle)) count++;
  }
  return count;
}

function anchorResolves(fileContent, anchor) {
  return anchorMatchCount(fileContent, anchor) > 0;
}

// The anchor charset above cannot match a SPACE, so a catalog that writes a whole test
// NAME after `#` has it silently truncated to the first token. `#exits 10 when the
// tagged commit package version drifts...` parsed as `#exits`, which resolves against
// all 25 `exits ...` cases in release-gate.test.js — so the case the trap door names
// could be deleted with this gate still printing "verified" (measured: rc=0). Detect
// the loss the one way that needs no terminator list: extend the anchor word by word
// while it still resolves. A STRICTLY smaller resolving set proves the discarded text
// was more of the test name, not commentary. Commentary is excluded structurally, not
// by an exception list -- a parenthetical, a closing backtick or a dash after the
// anchor is not `<one space><alphanumeric>`, so the extension never starts.
function anchorTruncation(fileContent, anchor, trailingText) {
  if (!/^ [A-Za-z0-9]/.test(trailingText)) return null;
  const parsedCount = anchorMatchCount(fileContent, anchor);
  if (parsedCount === 0) return null;
  let extended = anchor;
  let count = parsedCount;
  for (const word of trailingText.trim().split(/\s+/)) {
    const candidate = `${extended} ${word}`;
    const candidateCount = anchorMatchCount(fileContent, candidate);
    if (candidateCount === 0) break;
    extended = candidate;
    count = candidateCount;
  }
  return count < parsedCount ? extended : null;
}

// Collect all ENFORCE: test file references using the same regex as
// extractEnforceTestFiles() in trap-door-conformance.test.js, plus the optional
// `#anchor` that the file-only regex used to drop on the floor.
function collectEnforceRefs(claudePath) {
  const lines = fs.readFileSync(claudePath, 'utf8').split('\n');
  // Keyed on `rel#anchor` so each anchored ref is verified on its own, while every
  // bare ref to one file still collapses to a single `rel#` entry as before.
  const enforceFiles = new Map(); // 'rel#anchor' -> { rel, anchor, trailingText, lineNum }

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
        enforceFiles.set(key, {
          rel: m[1],
          anchor: m[2] ?? null,
          trailingText: entryText.slice(m.index + m[0].length),
          lineNum: i + 1,
        });
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

  for (const { rel, anchor, trailingText, lineNum } of enforceFiles.values()) {
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

    // Resolving is not identifying: a truncated anchor resolves against every sibling
    // that shares its first token, so the named case can vanish and this gate stays
    // green. Fail closed on the loss itself.
    const truncatedFrom = anchor ? anchorTruncation(fileContent, anchor, trailingText) : null;
    if (truncatedFrom) {
      process.stderr.write(
        `ENFORCE: ${label}:${lineNum}: anchor #${anchor} is space-truncated from "${truncatedFrom}" in ${rel} -- write the whole anchor as one hyphenated slug\n`
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
#   * Stripping comments first remains rejected AS THE GATE'S CORPUS, on
#     measurement: it turns the live `referencedFiles` (services/citadel/
#     trap-door-coverage-audit.js) into a failure, because that file has a
#     block-comment opener inside a REGEX LITERAL and a block-comment regex
#     swallows live code from there on. Regex cannot lex, and a FALSE POSITIVE
#     reddens a green release gate — strictly worse than a missed one.
#   * FALSE NEGATIVE, now MEASURED instead of merely stated: a dead symbol still
#     named in a COMMENT resolves as live. The original argument for tolerating it
#     was that for all three motivating cases the surviving comment mention was
#     introduced by the FIX commit, so while each anchor was dead-but-uncorrected
#     the name had zero non-.md hits. That argument covers rename/refactor/
#     false-at-birth. It does NOT cover RETIRE-IN-PLACE, where the commit that
#     deletes a symbol leaves explanatory prose behind on purpose — and three such
#     anchors were resolving as live inside `verified` with no signal at all
#     (AP-EXT-ITER144-01).
#   * SO: a SECOND word set, `codeWords`, is built in the same pass from a
#     LINE-LOCAL comment strip — the SAME rule the B-1SEAM arm already uses, three
#     whole-line markers and nothing else. Line-local by construction, so it can
#     never swallow forward past its own line, which is the precise mechanism that
#     made the block-comment regex inadmissible. It does NOT gate: an anchor absent
#     from `codeWords` but present in `words` is reported as PROSE-ONLY and the
#     exit code is unchanged. That
#     asymmetry is the whole point — the measured objection above is an objection to
#     REDDENING on a lexing heuristic, and a heuristic that only ever moves a
#     reported number cannot redden anything. It buys back exactly the visibility
#     the CANDIDATE RULE note demands: the unchecked population is a number that
#     moves when the catalogs change.
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
    } catch (err) {
      // A root the walk cannot ENTER drops every subsystem CLAUDE.md beneath it while
      // perCatalog -- the number the verdict line reports -- stays satisfied by the
      // readable roots. Measured on the shipped script before this fix: a dark
      // subsystem root collapsed the census from 649 ENFORCE refs across 8 catalogs to
      // 331 across 3, still printing `verified` and still exiting 0. Same swallow that
      // 057b4bec fixed in audit-did-we-count.sh:findClaudeMdFiles; one report, both
      // walks. Fail here rather than counting it: no census over the surviving roots is
      // admissible once an unknown number of catalogs went unswept, so there is no
      // partial verdict worth printing.
      process.stderr.write(
        `catalog discovery: ${path.relative(repoRoot, root) || root}: unreadable catalog ` +
          'root -- every subsystem CLAUDE.md beneath it would go unswept, so no census ' +
          `over the remaining catalogs can be reported as verified (${err instanceof Error ? err.message : String(err)})\n`
      );
      process.exit(1);
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
// A git abbreviated object name is not a symbol claim. The catalogs cite commits in
// backticks throughout, and an all-hex span satisfies BARE_IDENTIFIER_RE, so without
// this the corpus is asked whether a COMMIT is live code. Both tiers were reachable:
// a sha spelled nowhere in the tree FAILS the gate as `names a symbol absent from the
// tree` (mutation-verified, exit 1), and one that happens to appear in a code COMMENT
// -- `aceb54d7`, cited by metrics-utils.ts -- lands in the prose-only advisory. The
// CLAUSE_TERMINATORS list already carries TICKET_TRACEABILITY for exactly this reason,
// but that excludes one LABEL, not the shape: a commit cited inside the INVARIANT body
// is the same token in a place no label can name. Shape is the rule that needs no list.
// The floor of 7 is git's own abbreviation minimum; measured over this tree, zero
// declarations in any tracked file carry a 7-40 char all-lowercase-hex name, so this
// excludes no live symbol.
const GIT_OBJECT_NAME_RE = /^[0-9a-f]{7,40}$/;
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

// Line-local comment strip, feeding the ADVISORY `codeWords` set only — never the
// gate. Every decision is made from ONE line and discards nothing beyond it, so the
// forward-swallowing failure that made a block-comment regex inadmissible for the
// gate's corpus cannot occur here. The three whole-line markers also cover the
// block-comment interior (` * `) without ever matching an opener/closer across lines.
//
// This is DELIBERATELY the same rule, and the same name, as the B-1SEAM arm's
// stripper further down this file. The two arms run as separate `node -` heredocs and
// so cannot share a binding; what they CAN share is one rule, stated identically. A
// second, subtly-wider rule is the divergence CLAUDE.md's subtract-before-add
// governance exists to prevent.
//
// The wider rule was measured, not assumed. Adding a `#` whole-line marker and a
// line-comment TAIL strip changes the prose-only set on this tree by ZERO entries
// (4 either way, same three symbols). It bought no coverage and cost a divergence
// plus fresh over-strip risk — a line-comment marker inside a string or a regex
// literal would truncate live code — so it is not taken.
//
// Residual over-strip, stated: a symbol whose ONLY occurrence sits on a line that
// begins with one of the three markers reads as prose-only. That moves a symbol INTO
// an advisory report; it can never redden the gate.
function nonCommentText(content) {
  return content.split('\n').filter((line) => {
    const t = line.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');
}

// ONE rule for "may this tracked file answer the question the corpus asks" — does
// this identifier still EXIST as code. The predicate used to name FILES, and a file
// list is the incomplete-set shape: it excluded markdown plus ONE hand-written path
// (the sibling wire's anchor-absence allowlist) and was blind to every other file
// that spells a name in order to assert the name is GONE. Measured on this tree, at
// least three more such channels existed — THIS SCRIPT's own `prunedExports` list,
// a deletion-asserting hooks test, and a citadel fixture — so the next member was
// already overdue.
//
// The rule that needs no list is not WHICH FILE answers, it is WHICH OCCURRENCE: a
// file answers with a name it USES, never with one it merely SPELLS. Comment text
// and string/regex literals SPELL; everything else USES. Markdown is still excluded
// wholesale because markdown only ever spells — prose outlives the code it describes
// by design, so it resolves a deleted name off the very document recording the
// deletion.
//
// This subsumes the deleted path exclusion exactly: the allowlist enumerates its
// tokens as string literals inside one file, so under this rule it USES none of them
// and cannot resolve any of them — while the audit script and the conformance sweep
// keep resolving the symbols they genuinely DECLARE (`isLivenessChannel`, `codeWords`
// and `TEST_NAME_RE` are all anchored in extension/CLAUDE.md and all still verify).
// Allowlisting a name can therefore no longer be the act that blinds this arm to it.
function isLivenessChannel(rel) {
  return !rel.endsWith('.md');
}

// The SPELL half of that rule. `nonCommentText` above removes one spelling medium;
// this removes the other, and the two compose — a needle written into a deletion
// assertion is a string either way. Line-local for the same reason its sibling is:
// every decision comes from ONE line, so an unterminated quote cannot swallow the
// rest of the file. Residual, stated: an odd quote (an apostrophe inside a comment
// has already been removed, but one inside a nested string has not) can over-strip
// its own line, which drops a USE and could red a live name spelled by only one
// file. Measured on this tree that set is empty -- the gate is green at HEAD with
// exactly the four intended anchors corrected and nothing else moved.
//
// Deliberately NOT applied to JSON, where a quoted key IS the declaration: JSON has
// no unquoted identifier space at all, so stripping literals there deletes the whole
// file and would report every JSON-declared name as unused. Measured: without this
// exemption `prior_value` (a real `activity-events.schema.json` property) reads as
// spelled-only.
function nonLiteralText(content) {
  return content
    .split('\n')
    .map((line) =>
      line
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/`(?:\\.|[^`\\])*`/g, '``')
    )
    .join('\n');
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
  const codeWords = new Set();
  // Per-token file cardinality for the two halves of the spell/use rule. A name a
  // file merely SPELLS counts in `spelledInFiles` only; one it USES counts in both.
  const spelledInFiles = new Map();
  const usedInFiles = new Map();
  let fileCount = 0;

  for (const rel of tracked.split('\0')) {
    if (!rel || !isLivenessChannel(rel)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue;
    }
    fileCount++;

    const commentFree = nonCommentText(text);
    const useText = rel.endsWith('.json') ? commentFree : nonLiteralText(commentFree);
    const spelledHere = new Set();
    const usedHere = new Set();

    for (const word of text.matchAll(WORD_RE)) {
      words.add(word[0]);
      spelledHere.add(word[0]);
    }
    for (const word of commentFree.matchAll(WORD_RE)) codeWords.add(word[0]);
    for (const word of useText.matchAll(WORD_RE)) usedHere.add(word[0]);

    for (const word of spelledHere) spelledInFiles.set(word, (spelledInFiles.get(word) ?? 0) + 1);
    for (const word of usedHere) usedInFiles.set(word, (usedInFiles.get(word) ?? 0) + 1);
  }

  return { words, codeWords, spelledInFiles, usedInFiles, fileCount };
}

const { words, codeWords, spelledInFiles, usedInFiles, fileCount } = buildSymbolCorpus();

let failures = 0;
let verified = 0;
let nonIdentifierSpans = 0;
const proseOnly = [];
const spelledOnly = [];
const perCatalog = [];

for (const claudePath of discoverCatalogs()) {
  const label = path.relative(repoRoot, claudePath) || claudePath;
  const clauses = collectInvariantClauses(claudePath);
  let catalogCandidates = 0;

  for (const { lineNum, text } of clauses) {
    for (const span of text.matchAll(BACKTICKED_RE)) {
      const candidate = span[1].trim();

      if (!BARE_IDENTIFIER_RE.test(candidate) || GIT_OBJECT_NAME_RE.test(candidate)) {
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

      // Present in the corpus, but every occurrence is comment text. The backticks
      // claim the symbol is LIVE and no code declares or uses it. Reported, never
      // gated -- see the corpus note above for why this side stays advisory. This
      // tier is tested FIRST, and deliberately: the comment strip is a line-local
      // heuristic and AP-EXT-ITER144-01 measured that REDDENING on one is the thing
      // to refuse, so the gate below may only judge a name that reaches real code.
      if (!codeWords.has(candidate)) {
        proseOnly.push(`${label}:${lineNum}: ${candidate}`);
        continue;
      }

      // Reaches real code, but NOTHING in the tree uses it -- every non-comment
      // occurrence is inside a string or regex literal -- and exactly ONE file
      // spells it. That file is the one asserting the name is gone, and the anchor
      // is resolving off it.
      //
      // The cardinality clause is what keeps this sound rather than a lexing guess.
      // A genuinely live string-valued name (an activity-event name, a reason code,
      // an enum member) is never spelled once: it has a producer and a consumer, and
      // in this tree a src file and its compiled mirror, so it lands in >= 2 files.
      // Measured on this tree: all 17 literal-only names with >= 2 files are live
      // event names, and all 4 with exactly one file were deliberately-absent
      // symbols left backticked against this arm's own convention.
      if ((usedInFiles.get(candidate) ?? 0) === 0 && spelledInFiles.get(candidate) === 1) {
        process.stderr.write(
          `INVARIANT: ${label}:${lineNum}: names a symbol nothing in the tree uses: ${candidate}\n`
        );
        spelledOnly.push(`${label}:${lineNum}: ${candidate}`);
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
    `\n${failures} INVARIANT symbol reference(s) name a symbol absent from the tree, ` +
      `or one that nothing in the tree uses (${spelledOnly.length} of them).\n` +
      'Fix the NAME to the live symbol, or — if the clause deliberately names an ABSENT ' +
      'symbol — drop its backticks, which is what marks it as a liveness claim. ' +
      'Do not weaken this arm to accommodate a bad anchor.\n'
  );
  process.exit(1);
}

for (const entry of proseOnly) {
  process.stderr.write(
    `INVARIANT (prose-only): ${entry}: backticked as a live symbol, but every ` +
      'occurrence in the tree is comment text -- no code declares or uses it. ' +
      'Fix the NAME to the live symbol, or drop its backticks if the clause ' +
      'deliberately names an ABSENT one. Advisory: does not fail this audit.\n'
  );
}

console.log(
  `audit-trap-door-enforcement: ${verified} INVARIANT symbol(s) verified across ` +
    `${perCatalog.length} catalog(s) (${perCatalog.join(', ')}) ` +
    `against ${words.size} symbols in ${fileCount} tracked file(s); ` +
    `${nonIdentifierSpans} non-identifier span(s) not checked; ` +
    `${proseOnly.length} resolved in comment text only`
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

# B-CIGREEN ROOT A / AC-M4: `rg` is provisioned on this dev box but NOT installed by
# ci.yml or release.yml, so a bare `if rg ...; then fail; fi` silently no-ops in CI
# ("rg: command not found" on stderr, non-zero exit) and the audit reports OK having
# measured nothing. Route the result through the SAME `isUnrunnableCheckResult`
# fail-closed classifier (R-SZGB-D, convergence-gate.ts) every other unrunnable-check
# call site uses, rather than inventing a second detector: a preflight
# `detectMissingTools` miss produces the identical `tool not installed: <bin>` sentinel
# `runCheckCommand` emits, so one classifier covers both "never spawned" and "spawned
# and failed to run" without a bash-native reimplementation of that logic.
if ! node - "$EXTENSION_ROOT" "$EXTENSION_ROOT/src/bin/spawn-morty.ts" "$EXTENSION_ROOT/src/bin/mux-runner.ts" <<'NODE'
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const [, , extensionRoot, ...targets] = process.argv;

(async () => {
  const { detectMissingTools } = await import(pathToFileURL(path.join(extensionRoot, 'services', 'verify-command-safety.js')).href);
  const { isUnrunnableCheckResult } = await import(pathToFileURL(path.join(extensionRoot, 'services', 'convergence-gate.js')).href);

  const bin = 'rg';
  let result;
  if (detectMissingTools([bin]).length > 0) {
    result = { stdout: '', stderr: `tool not installed: ${bin}`, exitCode: 1 };
  } else {
    const r = spawnSync(bin, ['-n', '-e', 'npm (ci|install)', ...targets], { encoding: 'utf8' });
    const spawnErrorText = r.error ? `${r.error.message}\n` : '';
    result = { stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${spawnErrorText}`, exitCode: r.status ?? 1 };
  }

  if (isUnrunnableCheckResult(result)) {
    process.stderr.write(`worker boot paths npm-install audit could not run (${result.stderr.trim() || 'unrunnable'}) — failing closed, not reporting OK\n`);
    process.exit(1);
  }

  if (result.exitCode === 0) {
    process.stderr.write('worker boot paths must reuse extension/node_modules; found npm ci/install in spawn-morty.ts or mux-runner.ts\n');
    process.exit(1);
  }

  process.exit(0);
})();
NODE
then
  audit_exit_code=1
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

# B-ARGMAX AC-5 — no unbounded caller-supplied content in a single argv element.
#
# Linux refuses one argument to the execve system call at or above 32 pages (131072 bytes) while
# macOS has no per-argument cap, so an oversized prompt is a silent Linux-only no-exec: null
# status, E2BIG, and the caller reads an ordinary negative. The fix is a ceiling applied at the
# backend spawn service's exported dispatchers, which are a choke point because every per-backend
# builder there is module-private.
#
# THE SHAPE, NOT A NAME LIST: this arm keys on "exported function whose name is a build-Invocation
# builder", so a new backend arm added tomorrow is swept the day it is exported. Naming the
# builders individually would scope the invariant to today's set and hide the next sibling — the
# exact failure this bundle exists to close.
#
# It also fails when the file declares ZERO such builders, so a rename or a moved file reds here
# instead of reporting a clean sweep over nothing.
BACKEND_SPAWN_PATH="${BACKEND_SPAWN_PATH_OVERRIDE:-$EXTENSION_ROOT/src/services/backend-spawn.ts}"

if ! node - "$BACKEND_SPAWN_PATH" <<'NODE'
const fs = require('fs');

const [, , spawnPath] = process.argv;

let text;
try {
  text = fs.readFileSync(spawnPath, 'utf8');
} catch (err) {
  process.stderr.write(`B-ARGMAX argv-ceiling sweep: cannot read ${spawnPath} (${err.message})\n`);
  process.exit(1);
}

const lines = text.split('\n');
const declPattern = /^export function (build\w*Invocation)\s*\(/;
const builders = [];

lines.forEach((line, index) => {
  const match = line.match(declPattern);
  if (!match) return;
  let end = lines.length;
  for (let i = index + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') { end = i; break; }
  }
  builders.push({ name: match[1], line: index + 1, body: lines.slice(index, end + 1).join('\n') });
});

if (builders.length === 0) {
  process.stderr.write(
    'B-ARGMAX argv-ceiling sweep: found zero exported invocation builders — the sweep would check nothing\n'
  );
  process.exit(1);
}

// Strip comments before the existence check. A backticked mention of the seam helper inside a
// docblock would otherwise satisfy the pin while the call itself was deleted — a green that proves
// only that someone WROTE the name, which is the failure class this catalog already records twice.
const stripComments = (body) => body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const unbounded = builders.filter((builder) => !stripComments(builder.body).includes('boundInvocationArgs('));

for (const builder of unbounded) {
  process.stderr.write(
    `B-ARGMAX argv-ceiling sweep: ${builder.name} (line ${builder.line}) returns an invocation without applying the argv ceiling — route it through boundInvocationArgs so no single argument can exceed MAX_ARGV_ELEMENT_BYTES\n`
  );
}

if (unbounded.length > 0) {
  process.exit(1);
}

console.log(
  `audit-trap-door-enforcement: B-ARGMAX argv-ceiling verified (${builders.length} exported invocation builder(s) bounded)`
);
NODE
then
  audit_exit_code=1
fi

exit "$audit_exit_code"
