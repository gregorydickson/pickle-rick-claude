// @tier: fast
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const claudePath = path.join(extensionRoot, 'CLAUDE.md');
const diffRange = 'v1.62.2..HEAD';
const maxEntryChars = 1500;

/**
 * A not-run diff is not a clean diff. Mirrors the sweepNotRun discriminated-result shape in
 * extension/src/services/orphan-reaper.ts — "an empty census is NOT evidence" unless the sweep
 * actually ran.
 */
function runClaudeDiff(cwd = repoRoot) {
  try {
    const diff = execFileSync('git', ['diff', '--unified=0', diffRange, '--', 'extension/CLAUDE.md'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, diff };
  } catch (error) {
    if (error?.stderr?.includes('bad revision')) {
      return { ok: false, reason: `bad revision: ${diffRange} unreachable` };
    }
    throw error;
  }
}

function parseTouchedNewLineNumbers(diff) {
  const lines = diff.split('\n');
  const lineNumbers = new Set();
  let nextNewLine = null;

  for (const line of lines) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      nextNewLine = Number(hunk[1]);
      continue;
    }

    if (nextNewLine === null) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNumbers.add(nextNewLine);
      nextNewLine += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      continue;
    }

    if (line.startsWith('\\')) {
      continue;
    }

    nextNewLine += 1;
  }

  return [...lineNumbers].sort((a, b) => a - b);
}

function collectTouchedTrapDoorEntries(claudeContent, diff) {
  const lines = claudeContent.split('\n');
  const touchedLines = parseTouchedNewLineNumbers(diff);
  const entries = new Map();

  for (const lineNumber of touchedLines) {
    const index = lineNumber - 1;
    const entryStart = findEntryStart(lines, index);
    if (entryStart === -1) {
      continue;
    }

    const firstLine = lines[entryStart];
    if (!firstLine.startsWith('- `')) {
      continue;
    }

    const entryEnd = findEntryEnd(lines, entryStart);
    entries.set(entryStart + 1, {
      lineNumber: entryStart + 1,
      text: lines.slice(entryStart, entryEnd).join('\n'),
    });
  }

  return [...entries.values()];
}

function findEntryStart(lines, index) {
  for (let i = Math.min(index, lines.length - 1); i >= 0; i -= 1) {
    const line = lines[i];
    if (typeof line !== 'string') continue;
    if (line.startsWith('- ')) {
      return i;
    }
    if (line.startsWith('## ')) {
      return -1;
    }
  }
  return -1;
}

function findEntryEnd(lines, start) {
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('- ') || lines[i].startsWith('## ')) {
      return i;
    }
  }
  return lines.length;
}

function validateTrapDoorEntry(entry, cwd = repoRoot) {
  const errors = [];
  const invariantCount = countToken(entry.text, 'INVARIANT:');
  const breaksCount = countToken(entry.text, 'BREAKS:');
  const enforceCount = countToken(entry.text, 'ENFORCE:');

  if (entry.text.length > maxEntryChars) {
    errors.push(`length: line ${entry.lineNumber} trap-door entry is ${entry.text.length} chars`);
  }

  if (invariantCount !== 1 || breaksCount !== 1 || enforceCount !== 1) {
    errors.push(
      `triple: line ${entry.lineNumber} expected exactly one INVARIANT/BREAKS/ENFORCE triple, got ${invariantCount}/${breaksCount}/${enforceCount}`,
    );
  }

  const enforceFiles = extractEnforceTestFiles(entry.text);
  if (enforceFiles.length === 0) {
    errors.push(`ENFORCE: line ${entry.lineNumber} must name at least one .test.js file`);
  }

  for (const file of enforceFiles) {
    const filePath = file.startsWith('extension/') ? path.join(cwd, file) : path.join(extensionRoot, file);
    if (!fs.existsSync(filePath)) {
      errors.push(`ENFORCE: line ${entry.lineNumber} missing test file ${file}`);
    }
  }

  return errors;
}

function countToken(text, token) {
  return text.split(token).length - 1;
}

function extractEnforceTestFiles(entryText) {
  const enforceMatch = entryText.match(/ENFORCE:\s*([\s\S]*?)\.?\s*$/);
  if (!enforceMatch) {
    return [];
  }

  return [...enforceMatch[1].matchAll(/\b((?:extension\/)?tests\/[A-Za-z0-9_./-]+\.test\.js)\b/g)].map(
    match => match[1],
  );
}

function assertEntriesConform(entries, cwd = repoRoot) {
  const failures = entries.flatMap(entry => validateTrapDoorEntry(entry, cwd));
  assert.deepEqual(failures, []);
}

function makeTempRepoWithTestFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trap-door-conformance-'));
  fs.mkdirSync(path.join(dir, 'extension', 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension', 'tests', 'fixture.test.js'), '');
  return dir;
}

describe('trap-door conformance fixture parser', () => {
  test('added entry conformance passes all checks', () => {
    const tmp = makeTempRepoWithTestFile();
    const claude = [
      '# Extension Rules',
      '- `src/bin/example.ts` - INVARIANT: added entries stay covered. BREAKS: regressions ship. ENFORCE: extension/tests/fixture.test.js.',
      '',
    ].join('\n');
    const diff = [
      'diff --git a/extension/CLAUDE.md b/extension/CLAUDE.md',
      '--- a/extension/CLAUDE.md',
      '+++ b/extension/CLAUDE.md',
      '@@ -0,0 +2 @@',
      '+- `src/bin/example.ts` - INVARIANT: added entries stay covered. BREAKS: regressions ship. ENFORCE: extension/tests/fixture.test.js.',
      '',
    ].join('\n');

    try {
      const entries = collectTouchedTrapDoorEntries(claude, diff);
      assert.equal(entries.length, 1);
      assertEntriesConform(entries, tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('edited entry conformance includes edit-only hunks', () => {
    const tmp = makeTempRepoWithTestFile();
    const claude = [
      '# Extension Rules',
      '- `src/services/pickle-utils.ts` - INVARIANT: edited entries stay covered after reflow. BREAKS: regressions ship. ENFORCE: extension/tests/fixture.test.js.',
      '',
    ].join('\n');
    const diff = [
      'diff --git a/extension/CLAUDE.md b/extension/CLAUDE.md',
      '--- a/extension/CLAUDE.md',
      '+++ b/extension/CLAUDE.md',
      '@@ -2 +2 @@',
      '-- `src/services/pickle-utils.ts` - INVARIANT: edited entries stay covered. BREAKS: regressions ship. ENFORCE: extension/tests/fixture.test.js.',
      '+- `src/services/pickle-utils.ts` - INVARIANT: edited entries stay covered after reflow. BREAKS: regressions ship. ENFORCE: extension/tests/fixture.test.js.',
      '',
    ].join('\n');

    try {
      const entries = collectTouchedTrapDoorEntries(claude, diff);
      assert.equal(entries.length, 1);
      assert.match(entries[0].text, /after reflow/);
      assertEntriesConform(entries, tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('overlength entry fails with length field name', () => {
    const tmp = makeTempRepoWithTestFile();
    const entry = {
      lineNumber: 2,
      text: `- \`src/bin/large.ts\` - INVARIANT: ${'x'.repeat(1501)} BREAKS: regressions ship. ENFORCE: extension/tests/fixture.test.js.`,
    };

    try {
      const errors = validateTrapDoorEntry(entry, tmp);
      assert.ok(errors.some(error => error.includes('length:')), errors.join('\n'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('missing ENFORCE file fails with field name', () => {
    const tmp = makeTempRepoWithTestFile();
    const entry = {
      lineNumber: 2,
      text: '- `src/bin/missing.ts` - INVARIANT: file exists. BREAKS: regressions ship. ENFORCE: extension/tests/missing.test.js.',
    };

    try {
      const errors = validateTrapDoorEntry(entry, tmp);
      assert.ok(
        errors.some(error => error.includes('ENFORCE:') && error.includes('missing.test.js')),
        errors.join('\n'),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('clean diff returns no touched entries and passes', () => {
    const entries = collectTouchedTrapDoorEntries('# Extension Rules\n', '');

    assert.deepEqual(entries, []);
    assertEntriesConform(entries);
  });
});

describe('extension/CLAUDE.md touched trap-door entries', () => {
  const claude = fs.readFileSync(claudePath, 'utf8');
  const diffResult = runClaudeDiff();
  const entries = diffResult.ok ? collectTouchedTrapDoorEntries(claude, diffResult.diff) : [];

  test(`diff range ${diffRange} resolves and checks trap-door entries (${entries.length} checked)`, () => {
    assert.ok(
      diffResult.ok,
      `trap-door conformance verified NOTHING: diff range '${diffRange}' is unreachable (${
        diffResult.ok ? '' : diffResult.reason
      }) — an unresolvable range must FAIL, not silently read as a clean pass`,
    );
    assert.ok(
      entries.length > 0,
      `diff range ${diffRange} resolved but touched ZERO trap-door entries — confirm extension/CLAUDE.md genuinely has no changes since the base tag before trusting this run as evidence`,
    );
  });

  // Per-entry, deliberately with no aggregate arm alongside it. `assertEntriesConform` is a
  // flatMap over `validateTrapDoorEntry` with no cross-entry rule, so a whole-set call re-runs
  // exactly these assertions on exactly these inputs and localizes the failure worse. The arm
  // that used to sit here ('clean or unavailable diff has no false failure') covered the two
  // shapes this block no longer reaches: `unavailable` was deleted when runClaudeDiff started
  // returning a discriminated result, and `clean` is now asserted IMPOSSIBLE by the
  // entries.length > 0 check above. A green line named for an unreachable scenario is the
  // fake-green shape, not coverage. The real clean-diff case is exercised on a synthetic empty
  // diff in the fixture-parser block: 'clean diff returns no touched entries and passes'.
  for (const entry of entries) {
    test(`line ${entry.lineNumber} conforms`, () => {
      assertEntriesConform([entry]);
    });
  }
});

// --- AP-EXT-ITER56-02: catalog ANCHOR LIVENESS ---
//
// The conformance checks above are SHAPE checks: length, the INVARIANT/BREAKS/ENFORCE triple,
// and whether each ENFORCE test file exists on disk. None of them reads the PROSE, so an anchor
// may name a symbol that no longer exists anywhere and still pass every gate — the catalog reads
// authoritative while describing code that was deleted. That is the falsification mode behind
// AP-EXT-ITER8-01 (`isDesignSafeBranch`, false at birth) and AP-EXT-ITER56-02
// (`emitAdvisoryWorkerGateResidual`, deleted by 1889d5bf); `audit-trap-door-enforcement.sh`
// resolves ENFORCE refs only and is blind to it by construction.
//
// AP-BIN-ITER1-01: the catalog set is DISCOVERED, never hand-listed — the same two-roots-one-rule
// walk as `discoverCatalogs` in `extension/scripts/audit-trap-door-enforcement.sh`. The six-entry
// literal it replaces was the incomplete-set shape: `9e89e360` widened the SHELL walk to reach
// repo-root `bin/CLAUDE.md` and this sibling list was never widened with it, so the one catalog
// anatomy-park writes outside `extension/src/` was judged by no oracle at all — the shell arm has
// no scoped-anchor counterpart, so a PATTERN_SHAPE scoping a call to a function that never makes
// it shipped inert there. Deriving the set means a new subsystem catalog cannot ship unswept.
function discoverAnchorCatalogs() {
  const catalogs = ['extension/CLAUDE.md'];

  for (const [root, skipDir] of [['extension/src', null], ['', 'extension']]) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(repoRoot, root), { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name === skipDir) continue;
      const candidate = path.posix.join(root, entry.name, 'CLAUDE.md');
      if (fs.existsSync(path.join(repoRoot, candidate)) && !catalogs.includes(candidate)) {
        catalogs.push(candidate);
      }
    }
  }

  return catalogs;
}

const anchorCatalogs = discoverAnchorCatalogs();

/**
 * An identifier carrying an internal case hump (>= 2 chars before it), or SCREAMING_SNAKE with
 * >= 1 underscore.
 *
 * AP-EXT-ITER151-01: the first arm keys on the HUMP, not on a casing convention. It used to be
 * spelled `[a-z]...[A-Z]` — anchored on a LOWERCASE first character — which made the arm mean
 * "camelCase" and left PascalCase matching neither alternative. Every TypeScript type, interface,
 * class and enum name is PascalCase, so the whole type namespace was invisible to a sweep whose
 * test asserts that no anchor "names a symbol absent from the tree": 104 PascalCase anchor tokens
 * across the six catalogs were never checked, and `ActivityEventName` — named in BOTH the
 * INVARIANT and the PATTERN_SHAPE of `src/bin/CLAUDE.md`'s AP-EXT-ITER148-02 entry while existing
 * in ZERO files repo-wide — sat green.
 *
 * The fix COLLAPSES rather than appends (root CLAUDE.md: prefer the formulation that needs no
 * list). A third `[A-Z][a-z]...` alternative would have been the next member of a casing
 * enumeration, one convention away from the next blind spot; leading with `[A-Za-z]` and requiring
 * a `[a-z][A-Z]` transition subsumes camelCase and PascalCase in ONE arm, so the alternation count
 * stays at 2 and the convention distinction is removed instead of guarded.
 */
const anchorTokenPattern = /\b([A-Za-z][a-zA-Z0-9]*[a-z][A-Z][a-zA-Z0-9]*|[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+)\b/g;

/**
 * Absences that are CORRECT and must NOT be "fixed" — the trap inside this sweep. Only a
 * PRESENT-TENSE clause naming a dead symbol is a violation; a catalog also legitimately names
 * symbols that must NOT exist (negative assertions), the pre-fix shape a trap door was written
 * against (historical), and placeholders inside a shape description (meta).
 *
 * Keyed `<catalog>::<token>` — never bare token — so allowlisting a name in one catalog cannot
 * blind the sweep to the same name going dead in another. Each entry carries its reason; the
 * `no stale allowlist entries` arm below deletes-by-failing any entry whose token comes back.
 */
const anchorAbsenceAllowlist = new Map([
  ['extension/CLAUDE.md::scriptArg', 'meta: placeholder inside a PATTERN_SHAPE description, not a symbol'],
  ['extension/CLAUDE.md::shouldExitForLimits', 'negative: DELETED — the entry says do not re-add'],
  ['extension/CLAUDE.md::shouldExitMainLoop', 'negative: DELETED — the entry says do not re-add'],
  ['extension/src/bin/CLAUDE.md::readRegistryPids', 'historical: named as the pre-fix VIOLATING shape'],
  ['extension/src/hooks/CLAUDE.md::extraWriteCommands', 'negative: entry asserts zero occurrences'],
  ['extension/src/hooks/CLAUDE.md::CONFIG_INPLACE_WRITE_COMMANDS', 'negative: entry asserts zero occurrences'],
  ['extension/src/services/CLAUDE.md::throughStep', 'negative: entry asserts the param does not exist'],
  ['extension/src/services/CLAUDE.md::findPatternShapeViolations', 'negative: entry asserts MUST NOT grep for it'],
  ['extension/src/services/CLAUDE.md::extractPatternShapes', 'negative: entry asserts MUST NOT grep for it'],
  ['extension/src/services/CLAUDE.md::readRegistryPids', 'historical: named as the pre-fix VIOLATING shape'],
  ['extension/src/services/CLAUDE.md::bexecFile', 'artifact: regex tail of the literal \\bexecFile('],
  ['extension/src/services/CLAUDE.md::RUN_CMD_MAX_BUFFER', 'negative: former per-file fork, collapsed into UNBOUNDED_READ_MAX_BUFFER'],
  ['extension/src/services/CLAUDE.md::GIT_STATUS_MAX_BUFFER', 'negative: former per-file fork, collapsed into UNBOUNDED_READ_MAX_BUFFER'],
  ['extension/src/services/CLAUDE.md::GIT_ENUMERATION_MAX_BUFFER', 'negative: former per-file fork, collapsed into UNBOUNDED_READ_MAX_BUFFER'],
  ['extension/src/services/CLAUDE.md::IMPORT_WALK_MAX_BUFFER', 'negative: former per-file fork, collapsed into UNBOUNDED_READ_MAX_BUFFER'],
  ['extension/src/services/CLAUDE.md::GIT_LS_FILES_MAX_BUFFER', 'negative: former per-file fork, collapsed into UNBOUNDED_READ_MAX_BUFFER'],
  ['extension/src/services/CLAUDE.md::GIT_UNBOUNDED_MAX_BUFFER', 'negative: former per-file fork, collapsed into UNBOUNDED_READ_MAX_BUFFER'],
  ['extension/src/services/CLAUDE.md::ARCHIVE_GIT_MAX_BUFFER', 'negative: former per-file fork, collapsed into UNBOUNDED_READ_MAX_BUFFER'],
  // Surfaced the moment the corpus stopped resolving a name off the text that denies it. Each is a
  // token the extractor lifts out of a MULTI-token shape span, where the span as a whole is the
  // claim and the fragment is not a symbol — the same class as `bexecFile` above.
  ['extension/CLAUDE.md::measureLlm', 'artifact: alternation prefix inside a PATTERN_SHAPE regex, not a symbol'],
  ['extension/CLAUDE.md::stolenIno', 'negative: fragment of the must-not-exist comparison the entry forbids'],
  ['extension/CLAUDE.md::parseFirstShellWord', 'negative: entry asserts zero occurrences in src/hooks/'],
  ['extension/src/hooks/CLAUDE.md::parseFirstShellWord', 'negative: entry says an anchor naming it is stale and matches nothing'],
  ['extension/src/bin/CLAUDE.md::runIt', 'meta: illustrative snippet of an unparseable method shape, not a symbol'],
  // AP-BIN-ITER1-01: surfaced the moment the catalog set stopped being hand-listed and the sweep
  // reached repo-root bin/CLAUDE.md. Three are fragments the tokenizer lifts out of a larger span
  // (two regex groups and a filename); the fourth is a local a still-OPEN entry PRESCRIBES.
  ['bin/CLAUDE.md::VarFolder', 'artifact: alternation branch inside a PATTERN_SHAPE regex, not a symbol'],
  ['bin/CLAUDE.md::RUNTIME_ARTIFACT_PATH', 'artifact: optional-group tail inside a PATTERN_SHAPE regex; the live symbol is DEFAULT_RUNTIME_ARTIFACT_PATH'],
  ['bin/CLAUDE.md::resolveSubsystems', 'artifact: fragment of the test FILENAME the entry names; the live symbol is discoverSubsystems'],
  ['bin/CLAUDE.md::auditExisted', 'meta: local the OPEN AP-BIN-ITER14-01 fix would introduce; both of its files are outside this branch scope fence'],
]);

/**
 * Two self-reference traps, and the sweep reads a permanent clean pass through either one.
 *
 * 1. The CATALOGS: include them and they resolve each other — every anchor token trivially
 *    "exists" because the anchor itself is in the corpus.
 * 2. THIS FILE: `anchorAbsenceAllowlist` spells out every legitimately-absent token as a string
 *    literal, so a corpus containing this file resolves all of them — and, worse, would resolve
 *    any dead symbol the moment someone allowlisted it, making the whole sweep vacuous.
 *
 * Trap 1 is excluded by kind: the corpus glob admits no markdown, and the basename filter is the
 * backstop that keeps re-adding `'*.md'` from making the sweep vacuous rather than merely wrong.
 *
 * Trap 2 USED to be excluded by PATH, and a path list is the incomplete-set shape — it named this
 * one file and was blind to every other file that spells a name in order to assert the name is
 * GONE. Measured on this tree, three more such channels existed (a deletion-asserting hooks test,
 * a did-we-count fixture, an integration test pinning a removed comparison), so the next member
 * was already overdue. The rule that needs no list is not WHICH FILE answers but WHICH OCCURRENCE
 * — see `buildAnchorCorpus`. That subsumes this exclusion exactly: the allowlist enumerates its
 * tokens as string literals, so under the spell/use rule this file USES none of them and cannot
 * resolve any of them, while it keeps resolving the symbols it genuinely declares. Allowlisting a
 * name can therefore no longer be the act that blinds this sweep to it.
 */

/** Whole-word tokenizer for the corpus index — the substring resolve is the bug it replaces. */
const CORPUS_WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

// The two SPELL media, stripped line-locally. Both are deliberately the same rule, and the same
// names, as the strippers in `extension/scripts/audit-trap-door-enforcement.sh`: the two arms
// cannot share a binding (one is a shell heredoc), so what they share is one rule stated
// identically. A second, subtly-wider rule here is the divergence this fix exists to remove.
//
// Line-local on purpose: every decision comes from ONE line and discards nothing beyond it, so
// neither a block-comment opener nor an unterminated quote can swallow the rest of the file.
//
// Residual, stated and measured: a symbol whose ONLY occurrence sits on a line beginning with one
// of the three comment markers reads comment-only, and an odd quote can over-strip its own line.
// The first moves a name into the ADVISORY tier, which never gates; on this tree the second set is
// empty. Both residuals cost recall, never a false red.
function nonCommentText(content) {
  return content.split('\n').filter((line) => {
    const t = line.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');
}

// Deliberately NOT applied to JSON, where a quoted key IS the declaration: JSON has no unquoted
// identifier space, so stripping literals there deletes the whole file and reports every
// JSON-declared name as unused.
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

/**
 * ONE indexing routine, shared by the repo sweep and every fixture below, so a fixture can never
 * assert a rule the repo sweep does not run.
 *
 * `words` is every name in any medium; `codeWords` drops comment text; `usedInFiles`/`spelledInFiles`
 * carry the FILE cardinality the third tier's soundness clause needs.
 */
function buildSymbolIndex(sources) {
  const words = new Set();
  const codeWords = new Set();
  const spelledInFiles = new Map();
  const usedInFiles = new Map();

  for (const { file, text } of sources) {
    const commentFree = nonCommentText(text);
    const useText = file.endsWith('.json') ? commentFree : nonLiteralText(commentFree);
    const spelledHere = new Set();
    const usedHere = new Set();

    for (const word of text.matchAll(CORPUS_WORD_RE)) {
      words.add(word[0]);
      spelledHere.add(word[0]);
    }
    for (const word of commentFree.matchAll(CORPUS_WORD_RE)) codeWords.add(word[0]);
    for (const word of useText.matchAll(CORPUS_WORD_RE)) usedHere.add(word[0]);

    for (const word of spelledHere) spelledInFiles.set(word, (spelledInFiles.get(word) ?? 0) + 1);
    for (const word of usedHere) usedInFiles.set(word, (usedInFiles.get(word) ?? 0) + 1);
  }

  return { words, codeWords, spelledInFiles, usedInFiles };
}

/** Fixture shorthand: index a single synthetic source file under the same rule as the repo sweep. */
function indexSource(text, file = 'fixture.ts') {
  return buildSymbolIndex([{ file, text }]);
}

/** Finite ceiling on every git spawn this sweep makes — an unbounded spawn can hang the tier. */
const ANCHOR_GIT_TIMEOUT_MS = 30000;

/**
 * Discriminated result for the same reason `runClaudeDiff` has one: a corpus that failed to
 * build is a sweep that did not run, and a not-run sweep must FAIL rather than report zero.
 *
 * MARKDOWN IS NOT A LIVENESS CHANNEL. The corpus answers one question — does this identifier still
 * EXIST as code — so prose about a symbol must not answer it. Documentation outlives the code it
 * describes by design (design notes, feasibility tables, migration write-ups all name symbols
 * precisely because they were removed), so a corpus that reads .md resolves a deleted name off the
 * very document that records its deletion and reports the anchor live. That is not hypothetical:
 * `shouldExitMainLoop` resolved solely off `extension/REFACTOR_FEASIBILITY.md`, a pre-deletion
 * feasibility table, which silently exempted it from the allowlist and from the `no stale allowlist
 * entries` re-introduction alarm — while its named sibling in the same clause was covered by both.
 *
 * NEITHER IS A COMMENT NOR A STRING LITERAL. Markdown is only the wholesale case of one rule: a
 * file answers "does this identifier still EXIST as code" with a name it USES, never with one it
 * merely SPELLS. Comment text and string/regex literals spell; everything else uses. This is
 * DELIBERATELY the same rule, and the same three tiers, as the INVARIANT-liveness arm of
 * `extension/scripts/audit-trap-door-enforcement.sh`. The two wires read ONE contract off the same
 * catalogs, and this one is the only reader of PATTERN_SHAPE clauses, so a second, subtly-weaker
 * rule here is the divergence the root CLAUDE.md's subtract-before-add governance exists to
 * prevent — it was measured as exactly that: 7 dead anchors read green here, none of them visible
 * to the shell arm because none sits in an `INVARIANT:` span.
 *
 * The corpus is indexed by WHOLE WORD, never by substring. A raw `.includes(token)` resolved two
 * dead anchors off longer live identifiers that merely CONTAIN them (a regex-fragment prefix in
 * `extension/CLAUDE.md`, and a singular spelling of a plural helper in `src/services/CLAUDE.md`) —
 * an anchor whose symbol is a prefix of a live one read live forever.
 *
 * THIS FILE IS IN THE CORPUS, so the two names are described here and never written: spelling a
 * dead identifier as a bare token REVIVES it into the advisory tier and defuses the very anchor
 * that names it. Measured while writing this fix — the first draft of this paragraph spelled both
 * and dropped both from the gate.
 */
function buildAnchorCorpus(cwd = repoRoot) {
  let listing;
  try {
    listing = execFileSync(
      'git',
      ['ls-files', '-z', '--', '*.ts', '*.js', '*.sh', '*.json', '*.yml'],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        timeout: ANCHOR_GIT_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    return { ok: false, reason: `git ls-files failed: ${error?.message ?? error}` };
  }

  const files = listing
    .split('\0')
    .filter(Boolean)
    .filter(file => path.basename(file) !== 'CLAUDE.md');
  if (files.length === 0) {
    return { ok: false, reason: 'git ls-files returned zero files — corpus would match nothing' };
  }

  const sources = [];
  for (const file of files) {
    try {
      sources.push({ file, text: fs.readFileSync(path.join(cwd, file), 'utf8') });
    } catch {
      // A tracked-but-unreadable path (submodule gitlink, deleted worktree entry) is not a
      // corpus failure; the file-count assertion below still proves the sweep ran.
    }
  }

  return { ok: true, index: buildSymbolIndex(sources), fileCount: files.length };
}

/** Backticked identifiers on INVARIANT:/PATTERN_SHAPE lines — the anchors that make claims. */
function collectAnchorTokens(catalog, content) {
  const found = [];
  content.split('\n').forEach((line, index) => {
    if (!/INVARIANT:|PATTERN_SHAPE/.test(line)) {
      return;
    }
    const seen = new Set();
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      for (const match of span[1].matchAll(anchorTokenPattern)) {
        const token = match[1];
        if (seen.has(token)) continue;
        seen.add(token);
        found.push({ catalog, line: index + 1, token });
      }
    }
  });
  return found;
}

/**
 * The three tiers, in the shell arm's order and with its verdicts.
 *
 * `dead`     — the name occurs NOWHERE in the tree, in any medium. Gates.
 * `proseOnly` — it occurs, but every occurrence is comment text: no code declares or uses it.
 *              ADVISORY, never gating, and tested FIRST so a name can only reach the gate below
 *              through real code. The comment strip is a line-local heuristic and reddening on a
 *              heuristic is the thing to refuse (AP-EXT-ITER144-01).
 * `spelledOnly` — it reaches real code, but every non-comment occurrence is inside a string or
 *              regex literal AND exactly ONE file spells it. That file is the one asserting the
 *              name is gone, and the anchor is resolving off it. Gates.
 *
 * The CARDINALITY clause is what makes the last tier sound rather than a lexing guess: a genuinely
 * live string-valued name (an activity-event name, a reason code, a TS string-literal union member)
 * is never spelled once — it has a producer and a consumer, and in this tree a src file plus its
 * compiled mirror, so it lands in >= 2 files. Measured here: dropping the clause would red
 * `SCOPE_EMPTY_DIFF`, `GATE_CHECK_TIMEOUT` and 30 other live reason codes.
 */
function classifyAnchors(tokens, index) {
  const dead = [];
  const proseOnly = [];
  const spelledOnly = [];

  for (const entry of tokens) {
    const token = entry.token;
    if (!index.words.has(token)) {
      dead.push(entry);
    } else if (!index.codeWords.has(token)) {
      proseOnly.push(entry);
    } else if ((index.usedInFiles.get(token) ?? 0) === 0 && index.spelledInFiles.get(token) === 1) {
      spelledOnly.push(entry);
    }
  }

  return { dead, proseOnly, spelledOnly };
}

/** The GATING half: absent from the tree, or spelled by exactly the one file denying it. */
function findDeadAnchors(tokens, index) {
  const { dead, spelledOnly } = classifyAnchors(tokens, index);
  return [...dead, ...spelledOnly];
}

describe('trap-door catalog anchor liveness (fixture parser)', () => {
  const catalog = 'extension/CLAUDE.md';

  test('a dead symbol on an INVARIANT line is reported', () => {
    const content = '- `src/a.ts` — INVARIANT: `liveHelper` delegates to `deletedHelper`. BREAKS: x. ENFORCE: y.';
    const dead = findDeadAnchors(collectAnchorTokens(catalog, content), indexSource('export function liveHelper() {}'));

    assert.deepEqual(dead.map(entry => entry.token), ['deletedHelper']);
  });

  // AP-EXT-ITER151-01: PascalCase is the TypeScript type/interface/class/enum namespace. While the
  // extractor's first arm was anchored on a lowercase first character it meant "camelCase", so a
  // dead TYPE name was not merely unreported — it was never a token at all, and the repo sweep
  // read green over `ActivityEventName`, which exists in zero files. The defect is invisible to a
  // dead-vs-live assertion alone (an unextracted token has no verdict), so the extraction itself
  // is pinned first.
  test('AP-EXT-ITER151-01: a PascalCase type name on a PATTERN_SHAPE line is extracted as an anchor token', () => {
    const content = '- `src/a.ts` — PATTERN_SHAPE: a name absent from the `ActivityEventName` union.';

    assert.deepEqual(
      collectAnchorTokens(catalog, content).map(entry => entry.token),
      ['ActivityEventName'],
      'the extractor dropped a PascalCase identifier — every TS type, interface and class name is '
      + 'PascalCase, so anchoring the arm on a lowercase first character blinds the sweep to the '
      + 'whole type namespace',
    );
  });

  test('a dead PascalCase type name is reported, and a live one is not', () => {
    const content = '- `src/a.ts` — INVARIANT: `ActivityEventType` replaced `ActivityEventName`.';
    const dead = findDeadAnchors(
      collectAnchorTokens(catalog, content),
      indexSource('export type ActivityEventType = typeof VALID_ACTIVITY_EVENTS[number];'),
    );

    assert.deepEqual(dead.map(entry => entry.token), ['ActivityEventName']);
  });

  test('the collapsed arm still reads camelCase and SCREAMING_SNAKE, and still rejects prose', () => {
    const content = '- `src/a.ts` — PATTERN_SHAPE: `deletedHelper`, `DELETED_CONST`, `git`, `off`.';

    assert.deepEqual(
      collectAnchorTokens(catalog, content).map(entry => entry.token),
      ['deletedHelper', 'DELETED_CONST'],
      'widening to PascalCase must not cost either original arm, nor admit humpless prose words',
    );
  });

  test('prose outside backticks and lines without an anchor keyword are not scanned', () => {
    const content = [
      '- `src/a.ts` — some deletedHelper prose with no anchor keyword and no backticks',
      'PATTERN_SHAPE: bareDeletedHelper mentioned outside backticks',
    ].join('\n');

    assert.deepEqual(findDeadAnchors(collectAnchorTokens(catalog, content), indexSource('')), []);
  });

  test('a token repeated on one line is reported once', () => {
    const content = '- `src/a.ts` — PATTERN_SHAPE: `deletedHelper` then `deletedHelper` again.';

    assert.equal(findDeadAnchors(collectAnchorTokens(catalog, content), indexSource('')).length, 1);
  });

  test('the corpus builder rejects an empty listing rather than reporting a clean sweep', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-liveness-empty-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: empty, stdio: 'ignore', timeout: ANCHOR_GIT_TIMEOUT_MS });
      const result = buildAnchorCorpus(empty);

      assert.equal(result.ok, false);
      assert.match(result.reason, /zero files/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  // --- AP-EXT-ITER153-02: the corpus answers with names a file USES, not names it SPELLS ---
  //
  // These five pin the rule that replaced `anchorCorpusExclusions`, a path list that named ONE
  // spelling channel and was blind to the rest. Each fixture token is fictional, so none of them
  // is an anchor anywhere and none can be revived by being written here.

  test('AP-EXT-ITER153-02: a name only a deletion assertion SPELLS does not resolve as live code', () => {
    const content = '- `src/a.ts` — PATTERN_SHAPE: no `evictedProbe` anywhere.';
    // Exactly the shape that hid seven anchors: one file, asserting the name is gone, by quoting it.
    const denier = "assert.ok(!body.includes('evictedProbe'), 'the helper must stay deleted');";
    const dead = findDeadAnchors(collectAnchorTokens(catalog, content), indexSource(denier, 'denies.test.js'));

    assert.deepEqual(
      dead.map(entry => entry.token),
      ['evictedProbe'],
      'the anchor resolved off the assertion that denies it — the corpus is reading spellings again',
    );
  });

  test('AP-EXT-ITER153-02: a name a file genuinely USES still resolves', () => {
    const content = '- `src/a.ts` — PATTERN_SHAPE: `evictedProbe` guards the path.';
    const user = "function evictedProbe() { return 1; }\nconst x = evictedProbe();";

    assert.deepEqual(
      findDeadAnchors(collectAnchorTokens(catalog, content), indexSource(user)),
      [],
      'the spell/use rule must not red a live symbol — that would make the sweep unusable',
    );
  });

  test('AP-EXT-ITER153-02: an anchor is not resolved by a longer identifier that merely contains it', () => {
    const content = '- `src/a.ts` — PATTERN_SHAPE: `evictedProbe` guards the path.';
    const superstring = 'function evictedProbeHandle() { return evictedProbeHandle; }';
    const dead = findDeadAnchors(collectAnchorTokens(catalog, content), indexSource(superstring));

    assert.deepEqual(
      dead.map(entry => entry.token),
      ['evictedProbe'],
      'a substring resolve is back — an anchor whose symbol is a prefix of a live one reads live forever',
    );
  });

  test('AP-EXT-ITER153-02: a name only comment text carries is ADVISORY, never gated', () => {
    const content = '- `src/a.ts` — PATTERN_SHAPE: `evictedProbe` guards the path.';
    const commentOnly = '// evictedProbe used to guard the path here.\nconst other = 1;';
    const tokens = collectAnchorTokens(catalog, content);
    const index = indexSource(commentOnly);

    assert.deepEqual(findDeadAnchors(tokens, index), [], 'the comment strip is a line-local heuristic; reddening on it is the thing to refuse');
    assert.deepEqual(
      classifyAnchors(tokens, index).proseOnly.map(entry => entry.token),
      ['evictedProbe'],
      'the advisory tier must still SEE it — dropping it silently is the failure the tier exists to prevent',
    );
  });

  test('AP-EXT-ITER153-02: a literal-only name spelled by TWO files is a live reason code, not a dead anchor', () => {
    const content = '- `src/a.ts` — PATTERN_SHAPE: `EVICTED_PROBE_REASON` is emitted once.';
    // The cardinality clause. A live string-valued name has a producer and a consumer; a dead one
    // has only the file denying it. Without this clause every reason code in the tree reds.
    const index = buildSymbolIndex([
      { file: 'producer.ts', text: "export const reason = 'EVICTED_PROBE_REASON';" },
      { file: 'consumer.ts', text: "if (r === 'EVICTED_PROBE_REASON') { handle(); }" },
    ]);

    assert.deepEqual(
      findDeadAnchors(collectAnchorTokens(catalog, content), index),
      [],
      'the cardinality clause is gone — a string-literal union member or activity-event name now reds',
    );
  });

  test('AP-EXT-ITER145-01: prose naming a deleted symbol does not resolve it as live code', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-liveness-md-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: fixture, stdio: 'ignore', timeout: ANCHOR_GIT_TIMEOUT_MS });
      fs.writeFileSync(path.join(fixture, 'live.ts'), 'export function livingHelper() {}\n');
      // The shape that revived shouldExitMainLoop: a design doc naming the symbol it removed.
      fs.writeFileSync(path.join(fixture, 'NOTES.md'), '| `buriedHelper` | deleted in the refactor |\n');
      execFileSync('git', ['add', 'live.ts', 'NOTES.md'], { cwd: fixture, stdio: 'ignore', timeout: ANCHOR_GIT_TIMEOUT_MS });

      const result = buildAnchorCorpus(fixture);
      assert.equal(result.ok, true, result.ok ? '' : result.reason);

      const catalogContent = '- `live.ts` — INVARIANT: `livingHelper` replaced `buriedHelper`. BREAKS: x. ENFORCE: y.';
      const dead = findDeadAnchors(collectAnchorTokens(catalog, catalogContent), result.index);

      assert.deepEqual(
        dead.map(entry => entry.token),
        ['buriedHelper'],
        'markdown is in the corpus again — a deleted symbol resolves off the prose that records its deletion, so its anchor reads live and never reaches the allowlist',
      );
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('trap-door catalog anchor liveness (repo)', () => {
  const corpusResult = buildAnchorCorpus();
  const tokens = anchorCatalogs.flatMap(catalog => {
    const absolute = path.join(repoRoot, catalog);
    if (!fs.existsSync(absolute)) return [];
    return collectAnchorTokens(catalog, fs.readFileSync(absolute, 'utf8'));
  });

  test(`corpus and catalogs both resolve (${tokens.length} anchor tokens)`, () => {
    assert.ok(
      corpusResult.ok,
      `anchor liveness verified NOTHING: ${corpusResult.ok ? '' : corpusResult.reason}`,
    );
    assert.ok(
      corpusResult.fileCount > 100,
      `corpus is only ${corpusResult.fileCount} files — too small to be the real tree; a thin corpus reports every anchor dead or the sweep did not run`,
    );
    assert.ok(
      tokens.length > 100,
      `only ${tokens.length} anchor tokens scanned across ${anchorCatalogs.length} catalogs — the extractor matched almost nothing, which reads clean for the wrong reason`,
    );
  });

  test('no INVARIANT/PATTERN_SHAPE anchor names a symbol absent from the tree', () => {
    if (!corpusResult.ok) {
      assert.fail(corpusResult.reason);
    }

    const violations = findDeadAnchors(tokens, corpusResult.index)
      .filter(entry => !anchorAbsenceAllowlist.has(`${entry.catalog}::${entry.token}`))
      .map(entry => `${entry.catalog}:${entry.line} \`${entry.token}\``);

    assert.deepEqual(
      [...new Set(violations)],
      [],
      'a trap-door anchor names an identifier that exists nowhere in the tree — correct the anchor to the live symbol, or add it to anchorAbsenceAllowlist with its reason if the absence is deliberate (negative assertion / historical shape / meta-placeholder)',
    );
  });

  // AP-EXT-ITER153-02: the corpus no longer excludes this file BY PATH, so the file that enumerates
  // every legitimately-absent token now sits inside the corpus that judges them. That is safe for
  // exactly one reason: the enumeration SPELLS its tokens and USES none of them. If the spell/use
  // rule ever weakens back to raw text, allowlisting a name becomes the act that blinds this sweep
  // to it — silently and permanently — so the property is pinned rather than trusted.
  //
  // What is pinned is this file's CONTRIBUTION, not the whole-corpus verdict. An entry does add one
  // spelling of its own token, which can lift it past the third tier's cardinality clause; that is
  // harmless because entry and perturbation move together (a token with an entry is filtered from
  // the gate anyway, and deleting the entry deletes the spelling with it). What would NOT be
  // harmless is this file contributing a USE, because a use is what the gate reads as liveness.
  //
  // Every token is DERIVED from the allowlist at run time. Writing one here as a literal would give
  // it a second spelling file and defeat the pin asserting it stays absent.
  test('AP-EXT-ITER153-02: the allowlist contributes spellings of its tokens, never a use', () => {
    const tokens = [...anchorAbsenceAllowlist.keys()].map(key => key.slice(key.indexOf('::') + 2));
    const selfIndex = buildSymbolIndex([
      { file: 'trap-door-conformance.test.js', text: fs.readFileSync(fileURLToPath(import.meta.url), 'utf8') },
    ]);

    const spelledHere = tokens.filter(token => selfIndex.spelledInFiles.has(token));
    assert.deepEqual(
      [...new Set(spelledHere)].sort(),
      [...new Set(tokens)].sort(),
      'an allowlist key is not spelled by the file that declares it — the keys stopped being bare tokens, so this pin no longer measures the trap it guards',
    );

    const usedHere = tokens.filter(token => selfIndex.usedInFiles.has(token));
    assert.deepEqual(
      usedHere,
      [],
      'this file USES a token it allowlists as absent — the enumeration is now a liveness channel, so allowlisting a name is once again the act that blinds this sweep to it',
    );
  });

  test('no stale allowlist entries', () => {
    if (!corpusResult.ok) {
      assert.fail(corpusResult.reason);
    }

    // "The symbol came back" means it came back AS CODE — `usedInFiles`, the same half of the
    // spell/use rule the gate reads. Not the gate's full verdict, and deliberately so: every key
    // below spells its own token as a string literal, so this file is itself one of the files that
    // SPELL it. Reading anything spelling-sensitive here would make each entry perturb its own
    // answer — an entry would lift its token out of the third tier's `spelledInFiles === 1`
    // cardinality clause and then report itself stale. Reading uses only is immune to that, and it
    // is the honest meaning of the alarm. The old substring form resolved a token off any longer
    // identifier merely containing it.
    const stale = [...anchorAbsenceAllowlist.keys()].filter(key => {
      const token = key.slice(key.indexOf('::') + 2);
      return (corpusResult.index.usedInFiles.get(token) ?? 0) > 0;
    });

    assert.deepEqual(
      stale,
      [],
      'an allowlisted absence is no longer absent — the symbol came back. Delete the entry; if it names something a catalog asserts must NOT exist (e.g. shouldExitForLimits), the re-appearance is the regression the entry exists to catch',
    );
  });
});

// --- AP-EXT-ITER78-01: catalog anchor SCOPE liveness ---
//
// The liveness sweep above proves an anchor's symbol exists SOMEWHERE IN THE TREE. It cannot see
// the next failure mode: an anchor that scopes a call to a named function — ``\`X(\` in \`Y\``` — where
// X is alive, Y is alive, and X is simply not in Y. Both halves resolve, so `findDeadAnchors` and
// `audit-trap-door-enforcement.sh` both read green while the shape is a phantom: run it as the grep
// it is written to be and it reports a violation over correct code, and — the reason this is not
// cosmetic — it is INERT against the regression it names, because deleting the real call site leaves
// its output unchanged.
//
// Measured twice in one pass: `extension/CLAUDE.md`'s R-CWGE shape demanded
// `readWorkerGateVerdict(` in `guardCompletionCommitBeforeDone` (0 hits — the guard consults
// `resolveWorkerGateVerdict`, so the anchor guarding Done-over-red could not detect its own
// deletion), and `src/services/CLAUDE.md`'s R-SLLJ-8 shape demanded `compareMetricSetOps(` in
// `compareMetric` after 3c7f7344 split the logic into `compareMetricWithBasis` and left
// `compareMetric` an 11-line delegation. This is the AP-EXT-ITER74-02 class with a mechanical
// grader: the PATTERN_SHAPE asserted as an executable check instead of reviewer-verified prose.
const scopedAnchorPattern = /`([A-Za-z_][\w.]*\()`\s+in\s+`([A-Za-z_]\w*)`/g;

/**
 * Scope claims that are CORRECT as written and must NOT be "fixed". A catalog legitimately names a
 * function-scoped anchor in order to DENY it — `src/hooks/CLAUDE.md` says an anchor demanding
 * `tokenizeShellCommand(` in `findGitVerb` "is stale and matches nothing", which is a warning to
 * future readers, not a claim. Keyed `<catalog>::<callee> in <fn>` so a denial in one catalog cannot
 * blind the sweep to the same pair going stale in another.
 */
const scopedAnchorAllowlist = new Map([
  [
    'extension/src/hooks/CLAUDE.md::tokenizeShellCommand( in findGitVerb',
    'negative: the entry states this anchor is stale and matches nothing',
  ],
]);

/** Top-level `function`/`const` declaration bodies, keyed by name, across a TS source tree. */
function collectFunctionBodies(files) {
  const declPattern = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*[=:]/;
  const bodies = new Map();
  for (const [file, content] of files) {
    const lines = content.split('\n');
    const starts = [];
    lines.forEach((line, index) => {
      const match = line.match(declPattern);
      if (match) starts.push({ name: match[1] ?? match[2], index });
    });
    starts.forEach(({ name, index }, position) => {
      const end = position + 1 < starts.length ? starts[position + 1].index : lines.length;
      const body = lines.slice(index, end).join('\n');
      if (!bodies.has(name)) bodies.set(name, []);
      bodies.get(name).push({ file, body });
    });
  }
  return bodies;
}

/** Every ``\`X(\` in \`Y\``` claim on an INVARIANT:/PATTERN_SHAPE line, minus explicit denials. */
function collectScopedAnchors(catalog, content) {
  const found = [];
  content.split('\n').forEach((line, index) => {
    if (!/INVARIANT:|PATTERN_SHAPE/.test(line)) return;
    for (const match of line.matchAll(scopedAnchorPattern)) {
      // A clause that calls the anchor stale is denying it, not asserting it. Scope the
      // disclaimer test to the sentence around the match, never the whole line — these lines
      // carry many independent clauses and a file-wide `stale` would mute all of them.
      const clause = line.slice(Math.max(0, match.index - 200), match.index + match[0].length + 200);
      if (/\bstale\b/i.test(clause)) continue;
      found.push({ catalog, line: index + 1, callee: match[1], fn: match[2] });
    }
  });
  return found;
}

function findMisscopedAnchors(anchors, bodies) {
  return anchors.flatMap((anchor) => {
    if (scopedAnchorAllowlist.has(`${anchor.catalog}::${anchor.callee} in ${anchor.fn}`)) return [];
    const declarations = bodies.get(anchor.fn);
    // Y is not a top-level declaration in the source tree (a method, a shell function, a test
    // helper). Out of this oracle's competence — the liveness sweep above still covers the token.
    if (!declarations || declarations.length === 0) return [];
    if (declarations.some(({ body }) => body.includes(anchor.callee))) return [];
    return [anchor];
  });
}

function readSourceFiles(cwd = repoRoot) {
  let listing;
  try {
    listing = execFileSync('git', ['ls-files', '-z', '--', 'extension/src/*.ts', 'extension/src/**/*.ts'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: ANCHOR_GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return { ok: false, reason: `git ls-files failed: ${error?.message ?? error}` };
  }
  const files = new Map();
  for (const file of listing.split('\0').filter(Boolean)) {
    try {
      files.set(file, fs.readFileSync(path.join(cwd, file), 'utf8'));
    } catch {
      // Tracked-but-unreadable is not a sweep failure; the count assertion below proves it ran.
    }
  }
  return files.size === 0
    ? { ok: false, reason: 'git ls-files matched zero TS sources — sweep would check nothing' }
    : { ok: true, files };
}

describe('trap-door catalog anchor scope (fixture parser)', () => {
  const bodies = collectFunctionBodies(new Map([
    ['a.ts', 'export function outer(x) {\n  return helper(x);\n}\n\nfunction wrapper(x) {\n  return outer(x);\n}\n'],
  ]));

  test('an anchor scoping a call to a function that does not contain it is reported', () => {
    const anchors = collectScopedAnchors('c.md', 'PATTERN_SHAPE: `helper(` in `wrapper`.');
    assert.deepEqual(findMisscopedAnchors(anchors, bodies), [
      { catalog: 'c.md', line: 1, callee: 'helper(', fn: 'wrapper' },
    ]);
  });

  test('an anchor whose call really is in the named function passes', () => {
    const anchors = collectScopedAnchors('c.md', 'PATTERN_SHAPE: `helper(` in `outer`.');
    assert.deepEqual(findMisscopedAnchors(anchors, bodies), []);
  });

  test('a clause calling the anchor stale is a denial, not a claim', () => {
    const anchors = collectScopedAnchors(
      'c.md',
      'PATTERN_SHAPE: an anchor demanding `helper(` in `wrapper` is stale and matches nothing.',
    );
    assert.deepEqual(anchors, []);
  });

  test('an unknown target function is skipped rather than failed', () => {
    const anchors = collectScopedAnchors('c.md', 'PATTERN_SHAPE: `helper(` in `notInTree`.');
    assert.equal(anchors.length, 1);
    assert.deepEqual(findMisscopedAnchors(anchors, bodies), []);
  });

  test('lines without an anchor keyword are not scanned', () => {
    assert.deepEqual(collectScopedAnchors('c.md', 'prose: `helper(` in `wrapper`.'), []);
  });
});

describe('trap-door catalog anchor scope (repo)', () => {
  const sources = readSourceFiles();
  const anchors = anchorCatalogs.flatMap(catalog => {
    const absolute = path.join(repoRoot, catalog);
    if (!fs.existsSync(absolute)) return [];
    return collectScopedAnchors(catalog, fs.readFileSync(absolute, 'utf8'));
  });

  test(`sources resolve and scoped anchors are found (${anchors.length} anchors)`, () => {
    if (!sources.ok) assert.fail(sources.reason);
    // An empty anchor list is the vacuous pass this whole section exists to prevent.
    assert.ok(
      anchors.length > 0,
      `zero scoped anchors extracted across ${anchorCatalogs.length} catalogs — the extractor matched nothing, which reads clean for the wrong reason`,
    );
  });

  test('no PATTERN_SHAPE scopes a call to a function that does not contain it', () => {
    if (!sources.ok) assert.fail(sources.reason);

    const violations = findMisscopedAnchors(anchors, collectFunctionBodies(sources.files))
      .map(entry => `${entry.catalog}:${entry.line} \`${entry.callee}\` is not in \`${entry.fn}\``);

    assert.deepEqual(
      violations,
      [],
      'a PATTERN_SHAPE scopes a call to a function whose body does not contain it — the anchor reports a phantom violation on sight AND is inert against the regression it names. Re-scope it to the function that really makes the call, or add it to scopedAnchorAllowlist if the entry is denying the anchor rather than asserting it',
    );
  });
});

/**
 * AP-BIN-ITER1-01 — every trap-door catalog on disk is inside the anchor sweep.
 *
 * `anchorCatalogs` used to be a six-entry literal. `9e89e360` widened the SHELL walk in
 * `extension/scripts/audit-trap-door-enforcement.sh` to reach repo-root `bin/CLAUDE.md`; this
 * sibling list was never widened with it, so `bin/` — the one subsystem `discoverSubsystems`
 * enumerates outside `extension/src/` — sat outside BOTH repo sweeps above. Measured: a
 * PATTERN_SHAPE scoping `logActivity(` to `getActivityDir` (a call that function does not make)
 * reds the scope sweep from `extension/CLAUDE.md` and is invisible from `bin/CLAUDE.md`, and the
 * shell arm has no scoped-anchor counterpart at all, so nothing judged it.
 *
 * The oracle is the git INDEX, not the `readdirSync` walk under test — a pin that re-ran the same
 * walk would agree with itself no matter what the walk omitted. Containment, not equality, so an
 * untracked catalog mid-authoring cannot red a gate; the regression this exists to catch is a
 * catalog PRESENT on disk and ABSENT from the sweep, which containment states exactly.
 */
describe('AP-BIN-ITER1-01 anchor sweep catalog coverage (repo)', () => {
  // The two roots the sweep walks, expressed as a predicate over repo-relative paths so the
  // oracle needs no list of its own.
  function isSweptCatalog(file) {
    if (path.basename(file) !== 'CLAUDE.md') return false;
    const parts = file.split('/');
    if (file === 'extension/CLAUDE.md') return true;
    // `extension/src/<subsystem>/CLAUDE.md` — four segments, not three.
    if (parts.length === 4 && parts[0] === 'extension' && parts[1] === 'src') return true;
    // `<subsystem>/CLAUDE.md` at the repo root. The root CLAUDE.md itself is one segment and is
    // deliberately out: neither walk descends into it, and it carries no trap-door catalog.
    return parts.length === 2 && parts[0] !== 'extension';
  }

  function trackedCatalogs() {
    const listing = execFileSync('git', ['ls-files', '-z', '--', '*CLAUDE.md'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: ANCHOR_GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return listing.split('\0').filter(Boolean).filter(isSweptCatalog);
  }

  test('AP-BIN-ITER1-01: no catalog tracked in a swept root is missing from anchorCatalogs', () => {
    const expected = trackedCatalogs();
    // An empty oracle is the vacuous pass this whole block exists to prevent.
    assert.ok(
      expected.length >= 7,
      `git ls-files found only ${expected.length} swept catalogs — the oracle matched almost nothing, which reads clean for the wrong reason`,
    );

    const missing = expected.filter(catalog => !anchorCatalogs.includes(catalog));
    assert.deepEqual(
      missing,
      [],
      'a CLAUDE.md carrying trap doors sits in a swept root but outside anchorCatalogs, so no oracle reads its anchors — derive the catalog set from the two roots instead of re-listing it by hand',
    );
  });

  // Negative control: the exact literal that shipped. Without it the assertion above could pass
  // against a hand-list that merely happened to be complete today, and would say nothing about
  // the shape that let `bin/CLAUDE.md` ship unswept in the first place.
  test('the oracle can see the hand-list that shipped (negative control)', () => {
    const shippedHandList = [
      'extension/CLAUDE.md',
      'extension/src/bin/CLAUDE.md',
      'extension/src/hooks/CLAUDE.md',
      'extension/src/lib/CLAUDE.md',
      'extension/src/services/CLAUDE.md',
      'extension/src/types/CLAUDE.md',
    ];

    const missing = trackedCatalogs().filter(catalog => !shippedHandList.includes(catalog));
    assert.ok(
      missing.includes('bin/CLAUDE.md'),
      `the oracle did not flag bin/CLAUDE.md against the pre-fix hand-list — it cannot see the regression it pins (flagged: ${JSON.stringify(missing)})`,
    );
  });
});

/**
 * AP-EXT-ITER214-01 — a `## Module Export Catalog` row must name a module that EXISTS.
 *
 * The anchor sweep above resolves IDENTIFIERS, and `anchorTokenPattern` matches only a
 * case hump or SCREAMING_SNAKE. A module FILENAME (`cycles.ts`, `findings.ts`) matches
 * neither alternative, so the catalogs' module-identity axis had no wire at all — the same
 * blind-on-one-axis shape AP-EXT-ITER151-01 fixed for casing, one axis over.
 *
 * Measured on the shipped tree: `src/lib/CLAUDE.md` named `cycles.ts`, `findings.ts` and
 * `generative-audit.ts`, none of which exist. Every SYMBOL those rows advertised was live
 * — `buildCycles` in `tarjan-scc.ts`, `selectFix` in `cluster-fix-selector.ts`,
 * `shouldRunGenerativeAudit` in `plumbus-kill-switch.ts` — so symbol liveness read GREEN
 * over three rows that routed a reader to a file that was never there. `src/bin/CLAUDE.md`
 * says the catalog is "Enforced by `audit-subsystem-claude-md.sh`"; that script writes a
 * report and exits 0 on every drift class, and its own test asserts against a snapshot
 * committed 2026-05-08 rather than the live run, so nothing failed.
 *
 * Derived, never hand-listed: the catalog set comes from `discoverAnchorCatalogs`, the rows
 * from the heading, the verdict from the filesystem. A row resolves against the subsystem
 * dir, the extension root, or the repo root — all three forms are live, so trying all three
 * needs no per-entry exception list and only flags a row NO root can resolve.
 */
describe('AP-EXT-ITER214-01 module export catalog identity (repo)', () => {
  const HEADING_RE = /^## Module Export Catalog/;

  /**
   * AP-EXT-ITER215-01 — a row is what it LOOKS like, not where it SITS.
   *
   * `## Module Export Catalog` is the LAST `## ` heading in all three catalogs that carry
   * one, so the heading-to-next-heading slice runs to end of file — and every trap door a
   * later pass appends lands inside it. A positional `- \`x\`` match therefore read 92 rows
   * in `src/bin` (38 real), 60 in `src/services` (35) and 14 in `src/lib` (13). The rows it
   * invented all resolve, so the phantom arm stayed green; what it broke is the per-catalog
   * vacuity floor below, whose whole job is to notice a section that verifies nothing —
   * 54 / 25 / 1 trap-door bullets keep `rows.length > 0` true with the real catalog deleted
   * outright. It also made this pin's own lib evidence ("14 rows, matching its 14 on-disk
   * modules exactly") a coincidence: the 14th bullet is `reconcile-ticket-truth.ts`'s TRAP
   * DOOR, and that module has no catalog row at all.
   *
   * A row is a backticked path followed by the export arrow — `->` in bin/services, `→` in
   * lib — with at most a parenthetical between them. Trap doors put ` (…) — INVARIANT:` there
   * instead, so the arrow separates the two grammars with no list of section boundaries,
   * heading names or file positions to keep current.
   */
  const ROW_RE = /^- `([^`]+)`\s*(?:\([^)]*\)\s*)?(?:->|→)\s/;

  // A prose mention like "MUST appear in the `## Module Export Catalog` below" sits inside
  // backticks on a normal line, so the heading is matched at LINE START only. Getting this
  // wrong yields an empty section, which is why the floor below is per catalog and not global.
  function catalogSectionLines(catalogRel) {
    const abs = path.join(repoRoot, catalogRel);
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const start = lines.findIndex(line => HEADING_RE.test(line));
    if (start < 0) return null;

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) {
        end = i;
        break;
      }
    }

    return lines.slice(start, end);
  }

  function catalogRows(catalogRel) {
    const section = catalogSectionLines(catalogRel);
    if (section === null) return null;

    return section
      .map(line => line.match(ROW_RE))
      .filter(Boolean)
      .map(match => match[1]);
  }

  function resolves(catalogRel, entry) {
    const subsystemDir = path.dirname(path.join(repoRoot, catalogRel));
    return [
      path.join(subsystemDir, entry),
      path.join(repoRoot, 'extension', entry),
      path.join(repoRoot, entry),
    ].some(candidate => fs.existsSync(candidate));
  }

  /**
   * AP-EXT-ITER216-01 — the catalog was checked in ONE direction only.
   *
   * Everything above asks "does this row name a real module?". Nothing asked the converse,
   * "does this module have a row?", and that is the direction the contract is written in:
   * `src/bin/CLAUDE.md` says every module exported from the subsystem and imported by other
   * modules MUST appear in the catalog, and names `audit-subsystem-claude-md.sh` as the
   * enforcer. That script's only non-zero exit is a missing-`python3` preflight — its
   * `INCOMPLETE` verdict is written into a report and never raised — and it is not in the
   * release-gate chain, so the completeness axis had no wire at all. Measured on the shipped
   * tree: 11 `src/services` modules and 1 `src/lib` module were exported AND imported across
   * a module boundary while carrying no row (`recovery-controller.ts`, `codegraph-service.ts`,
   * `fom-blocks.ts`, `signature-caller-gap.ts`, `reconcile-ticket-truth.ts` among them).
   *
   * The required set is DERIVED — the subsystem's own directory, the import graph under
   * `src/`, and the filesystem — so it is a checked projection of the export surface rather
   * than a second hand-kept copy of it, and it needs no per-module exemption list: a module
   * nothing imports (a CLI entry point) simply never enters the set.
   */
  const srcRoot = path.join(extensionRoot, 'src');
  const RELATIVE_IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g;

  function tsFilesUnder(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...tsFilesUnder(abs));
      else if (entry.name.endsWith('.ts')) found.push(abs);
    }
    return found;
  }

  // A module is "imported across a boundary" when some OTHER `src/**/*.ts` names it. The
  // specifier is written `./foo.js` (NodeNext) and resolves to `foo.ts`, so the `.js` suffix is
  // dropped before probing. ONE resolution form, not a list of them — measured, 0 of the 162
  // scanned files reach a specifier that `${base}.ts` does not already resolve, and a directory
  // specifier resolving to a nested `index.ts` would land in the surface below like any other
  // module rather than falling outside it. `resolved !== file` is not breadth but the contract's
  // word "OTHER"; it has no live instance either, and it stays because dropping it would let a
  // self-import make a module its own importer.
  const importedAcrossModules = (() => {
    const targets = new Set();
    for (const file of tsFilesUnder(srcRoot)) {
      const body = fs.readFileSync(file, 'utf8');
      for (const [, specifier] of body.matchAll(RELATIVE_IMPORT_RE)) {
        const resolved = `${path.resolve(path.dirname(file), specifier).replace(/\.js$/, '')}.ts`;
        if (resolved !== file && fs.existsSync(resolved)) targets.add(resolved);
      }
    }
    return targets;
  })();

  /**
   * AP-EXT-ITER218-01 — a subsystem is a TREE, and the requirement enumerated one level of it.
   *
   * The required set was `readdirSync(catalogDir).filter(entry => entry.isFile())`, so every
   * module in a SUB-directory was dropped before the filters ever saw it — and a directory is
   * dropped the same way a documented module is, silently. MEASURED on the shipped tree: all 27
   * modules under `src/services/citadel/` are exported AND cross-imported, every one of them
   * required by the `services/` contract ("every helper module exported from the subsystem that
   * is imported by other modules"), and NOT ONE has a catalog row — 27 of that subsystem's 69
   * required modules, including the whole audit family the citadel phase runs on, invisible to a
   * completeness wire that reported the catalog complete. The toothless named enforcer
   * `audit-subsystem-claude-md.sh` shares the same flat `os.listdir`, so both wires inherited one
   * assumption and neither could see past it. The previous pass then wrote the blind spot INTO
   * `src/hooks/CLAUDE.md` as "Top-level files only" — a carve-out compensating for the gap
   * instead of closing it.
   *
   * The fix SUBTRACTS the per-catalog directory listing rather than adding a recursive one beside
   * it. There is now ONE enumeration — the cross-imported, exported modules under `src/` — and
   * one ownership rule: a module belongs to the catalog whose directory is its DEEPEST ancestor.
   * That needs no list of which sub-directories to descend into and no exemption list; a future
   * `src/services/citadel/CLAUDE.md` would take ownership of its own modules the moment it exists.
   * Ownership is TOTAL rather than guarded: `extension/CLAUDE.md` is an ancestor of all of `src/`,
   * so a module with no nearer catalog falls up to it and `AP-EXT-ITER217-01` reds because that
   * catalog carries no export section — one mechanism, not a second unowned-module guard beside
   * it (a guard that, measured, could never fire).
   *
   * Keys are the module path RELATIVE to its catalog (`citadel/reporter.ts`, `git-utils.ts`), not
   * the basename: two modules with the same basename in different directories are two rows, and
   * basename keying would have let one satisfy both.
   */
  const catalogModuleSurface = [...importedAcrossModules]
    .filter(abs => /^export\s/m.test(fs.readFileSync(abs, 'utf8')))
    .sort();

  const requiredByCatalog = (() => {
    const owners = anchorCatalogs.map(catalog => [
      catalog,
      path.dirname(path.join(repoRoot, catalog)) + path.sep,
    ]);
    const byCatalog = new Map(anchorCatalogs.map(catalog => [catalog, []]));

    for (const abs of catalogModuleSurface) {
      let owner = null;
      let ownerDir = '';
      for (const [catalog, dir] of owners) {
        if (abs.startsWith(dir) && dir.length > ownerDir.length) {
          owner = catalog;
          ownerDir = dir;
        }
      }

      if (owner !== null) byCatalog.get(owner).push(path.relative(ownerDir, abs));
    }

    for (const modules of byCatalog.values()) modules.sort();
    return byCatalog;
  })();

  function requiredRows(catalogRel) {
    return requiredByCatalog.get(catalogRel) ?? [];
  }

  const catalogsWithSection = anchorCatalogs.filter(c => catalogRows(c) !== null);

  /**
   * AP-EXT-ITER217-01 — carrying the section was a PRECONDITION for being checked.
   *
   * Every arm above quantifies over `catalogsWithSection`, so a catalog enters the ledger only
   * by carrying a `## Module Export Catalog` heading. That makes the STRONGEST drift invisible:
   * MEASURED on the shipped tree, renaming the heading in `src/services/CLAUDE.md` drops all 46
   * rows and all 42 required modules out of the identity arm, both vacuity floors and the
   * completeness arm at once, and the suite stays 280/280 GREEN — while merely deleting one row
   * from that same catalog reds. A weaker drift failed and a total one passed, because a catalog
   * that left the set looks exactly like a catalog the rule never applied to.
   *
   * The requirement side is already derived and does NOT depend on the heading — `requiredRows`
   * walks the subsystem directory and the import graph — so membership can be a VERDICT instead
   * of a precondition. Stating it as a set equality also absorbs the per-catalog vacuity floor it
   * replaces: "carries a section but requires nothing" IS a dark derivation (AP-EXT-ITER213-01),
   * and "requires modules but carries no section" is the hole above. One quantification over one
   * derived set, no list of which catalogs are supposed to have one — a subsystem is in the set
   * because its own modules are cross-imported, or it is not in it at all.
   */
  const catalogsNeedingSection = anchorCatalogs.filter(c => requiredRows(c).length > 0);

  test('AP-EXT-ITER214-01: every module export catalog row names a file that exists', () => {
    // Two floors, because one is satisfiable by the other going dark. A catalog whose
    // section parsed to zero rows reads clean for the wrong reason, and summing rows across
    // catalogs hides it behind its populated siblings — the per-root vacuity lesson from
    // AP-EXT-ITER213-01, applied per catalog.
    assert.ok(
      catalogsWithSection.length >= 2,
      `only ${catalogsWithSection.length} catalog(s) carry a '## Module Export Catalog' heading — the heading matcher reached almost nothing, which reads clean for the wrong reason`,
    );

    const phantoms = [];
    for (const catalog of catalogsWithSection) {
      const rows = catalogRows(catalog);
      assert.ok(
        rows.length > 0,
        `${catalog} has a '## Module Export Catalog' heading but zero parsed rows — the section boundary or row shape drifted, and an empty section verifies nothing`,
      );
      for (const entry of rows) {
        if (!resolves(catalog, entry)) phantoms.push(`${catalog} -> ${entry}`);
      }
    }

    assert.deepEqual(
      phantoms,
      [],
      'a Module Export Catalog row names a module that does not exist on disk. The row is the index a reader follows to find the code, so a phantom row sends them to a file that was renamed or split away — point the row at the real module (its symbols are usually still live elsewhere, which is exactly why the identifier sweep stays green over this)',
    );
  });

  test('the sweep can see a phantom row (negative control)', () => {
    const planted = ['context-key-matrix.ts', 'cycles.ts'];
    const unresolved = planted.filter(entry => !resolves('extension/src/lib/CLAUDE.md', entry));
    assert.deepEqual(
      unresolved,
      ['cycles.ts'],
      'the resolver did not flag the exact phantom row that shipped, so it cannot see the regression it pins',
    );
  });

  test('AP-EXT-ITER215-01: a trap door inside the catalog section is not read as a catalog row', () => {
    // The live half. Every catalog's section ends at EOF, so it holds trap doors; if a
    // positional row shape comes back, they arrive here as "rows" and the floor above stops
    // being able to see the real catalog go dark.
    const misread = [];
    for (const catalog of catalogsWithSection) {
      for (const line of catalogSectionLines(catalog)) {
        if (!line.startsWith('- `') || !ROW_RE.test(line)) continue;
        if (line.includes('INVARIANT')) misread.push(`${catalog} -> ${line.slice(0, 90)}`);
      }
    }
    assert.deepEqual(
      misread,
      [],
      'a trap-door entry sitting below the `## Module Export Catalog` heading was parsed as a catalog row. Section membership is not row-hood — the heading is the last one in the file, so every appended trap door falls inside its slice, and counting them keeps the per-catalog vacuity floor green over a catalog that has been emptied',
    );
  });

  test('AP-EXT-ITER215-01: the row shape accepts both arrow spellings and rejects a trap door (negative control)', () => {
    // Fixed text, so this arm still separates the two grammars if the live catalogs are ever
    // reorganised so that no trap door sits inside a catalog section.
    const asciiRow = '- `pickle-utils.ts` -> `collectTickets`, `ticketFilePath`';
    const unicodeRow = '- `cluster-fix-selector.ts` (shared analyzer types) → `Finding`, `selectFix`';
    const trapDoor = '- `pickle-utils.ts` (AP-EXT-ITER208-01 roster ticket identity) — INVARIANT: every ticket carries a non-null id.';
    assert.deepEqual(
      [asciiRow, unicodeRow, trapDoor].filter(line => ROW_RE.test(line)),
      [asciiRow, unicodeRow],
      'the row shape no longer separates a catalog row from a trap-door entry: it must accept a backticked path followed by `->` or `→` (an optional parenthetical between them) and reject the ` (…) — INVARIANT:` grammar',
    );
  });
  test('AP-EXT-ITER216-01: every module the subsystem exports across a boundary has a catalog row', () => {
    const missing = [];
    for (const catalog of catalogsNeedingSection) {
      const listed = new Set((catalogRows(catalog) ?? []).map(row => row.replace(/^\.\//, '')));
      for (const module of requiredRows(catalog)) {
        if (!listed.has(module)) missing.push(`${catalog} -> ${module}`);
      }
    }

    assert.deepEqual(
      missing,
      [],
      'a module exported from the subsystem and imported by another module carries no `## Module Export Catalog` row. The catalog is the index a reader follows to find the import surface, so an absent module is invisible to everyone who reads the subsystem contract instead of the directory — add the row next to its alphabetical neighbours',
    );
  });

  test('AP-EXT-ITER217-01: a catalog carries an export section exactly where the import graph requires one', () => {
    assert.deepEqual(
      catalogsWithSection,
      catalogsNeedingSection,
      'the set of catalogs carrying a `## Module Export Catalog` section and the set the import graph says must carry one have diverged. A catalog on the right but not the left exports cross-imported modules while documenting none of them under the heading every wire reads, so it is checked by NOTHING — renaming or deleting the heading is a silent pass. A catalog on the left but not the right is being checked against an empty derived set, so its walk, import scan or export probe went dark',
    );
  });

  test('AP-EXT-ITER218-01: the required sets cover the whole src/ export surface, sub-directories included', () => {
    // The floor first: both sides of the equality below are built from the same walk, so a dark
    // import graph or a dark export probe would match EMPTY against EMPTY and read as full
    // coverage — the AP-EXT-ITER213-01 per-root lesson, one level up.
    assert.ok(
      catalogModuleSurface.length > 0,
      'the cross-imported export surface under `src/` is EMPTY, so the coverage equality below is comparing nothing against nothing — the file walk, the import scan or the export probe stopped reaching the tree',
    );

    // Reconstructing the absolute path from (catalog, relative key) is what makes a re-flattened
    // derivation loud: a required set that enumerates only a catalog's direct children drops all
    // 27 `citadel/` modules out of the union while they stay in the surface. It also proves the
    // keys round-trip, so a row spelling that cannot address a nested module fails here rather
    // than passing as an unmatched name.
    const covered = anchorCatalogs
      .flatMap(catalog =>
        requiredRows(catalog).map(rel =>
          path.join(path.dirname(path.join(repoRoot, catalog)), rel),
        ),
      )
      .sort();

    assert.deepEqual(
      covered,
      catalogModuleSurface,
      'the modules the catalogs are held to and the cross-imported export surface under `src/` have diverged. A module in the surface but not covered is required by its subsystem contract and demanded by NO catalog — the shape that hid all 27 `src/services/citadel` modules while the completeness arm read green',
    );
  });

  /**
   * AP-EXT-ITER219-01 — the row's PAYLOAD had no wire.
   *
   * Every arm above judges a row by its FILE: does the path resolve, is the module required,
   * does the required set cover the tree. Nothing read what comes AFTER the arrow — and the
   * symbol list is the whole reason the row exists, the index a reader follows to find where a
   * name is declared. Blind BY CONSTRUCTION, the same way the module-identity axis was before
   * `AP-EXT-ITER214-01`: the catalog's other symbol oracle, `collectAnchorTokens`, skips any
   * line not matching `/INVARIANT:|PATTERN_SHAPE/`, and a catalog row carries neither label, so
   * no sweep in this file or in `audit-trap-door-enforcement.sh` ever saw one of these names.
   *
   * MEASURED on the shipped tree: of 131 rows carrying a symbol list, `src/types/CLAUDE.md`'s
   * `index.ts` row named 15 symbols that module does not export. SEVEN (`ALL_EXITS`,
   * `ALL_STEPS`, `TicketTier`, `PROMISE_TOKEN_STRINGS`, `ALL_TICKET_STATUSES`, `isFailedExit`,
   * `VALID_EFFORTS`) have no export site anywhere under `src/`; the other eight are exported by
   * four OTHER modules (`bin/mux-runner.ts`, `services/pickle-utils.ts`,
   * `services/state-manager.ts`, `services/backend-spawn.ts`,
   * `services/transaction-ticket-ops.ts`), so the row sent a reader to the wrong file for a name
   * that really exists — `AP-EXT-ITER214-01`'s failure mode one level down. The row was carried
   * over from a `## Public Exports` section no wire had ever read, and `git log -S` finds those
   * seven names in `types/index.ts` in NO commit: false at birth, never drifted.
   *
   * LIVENESS IS THE WRONG QUESTION, which is why widening `collectAnchorTokens` to swallow
   * catalog rows would not close this: `ExitReason` IS live, so a liveness sweep passes it while
   * the row still misroutes. The property is SET MEMBERSHIP in the named module's own export
   * surface, so it is derived from that module's AST rather than from a search of the tree.
   *
   * CONTAINMENT, not equality. Measured across the same 131 rows: 111 list exactly the module's
   * exports and 19 legitimately list a curated subset. Demanding equality would red those 19 and
   * force an exemption list; containment needs none, and completeness is already owned by
   * `AP-EXT-ITER216-01` at module granularity.
   */
  function rowSymbols(tail) {
    // The export list is the comma-separated backticked run after the arrow. A row may carry a
    // parenthetical gloss per symbol and an em-dash prose tail, and both spell OTHER identifiers
    // in backticks (`State` inside "load and validate a `State` object"), so reading raw
    // backticks reports names the row never advertised. Cut prose off structurally rather than
    // keeping a list of the words that introduce it.
    const withoutGlosses = tail.replace(/\([^)]*\)/g, ' ');
    const proseAt = withoutGlosses.search(/\s[—–]\s/);
    const list = proseAt >= 0 ? withoutGlosses.slice(0, proseAt) : withoutGlosses;

    return list
      .split(',')
      .map(part => part.trim().match(/^`([A-Za-z_$][A-Za-z0-9_$]*)`$/))
      .filter(Boolean)
      .map(match => match[1]);
  }

  // The AST, not a `/^export (const|function|class|interface|type|enum|…)/` regex: that form is
  // an enumerated set of declaration keywords, correct only until TypeScript grows another one,
  // and it fails by silently reporting a real export missing — which reads here as the row
  // over-claiming, a false RED against a correct catalog.
  function exportedNames(abs) {
    const source = ts.createSourceFile(
      abs,
      fs.readFileSync(abs, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const names = new Set();

    for (const statement of source.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (modifiers && modifiers.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
          }
        } else if (statement.name && ts.isIdentifier(statement.name)) {
          names.add(statement.name.text);
        }
      }

      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
      }
    }

    return names;
  }

  // ONE row grammar. The tail is whatever `ROW_RE` did not consume, so a change to the row shape
  // moves the symbol list with it instead of leaving a second regex to keep in sync.
  const symbolRows = anchorCatalogs.flatMap(catalog => {
    const dir = path.dirname(path.join(repoRoot, catalog));
    return (catalogSectionLines(catalog) ?? [])
      .map(line => ({ line, match: line.match(ROW_RE) }))
      .filter(entry => entry.match !== null)
      .map(entry => ({
        catalog,
        module: entry.match[1],
        abs: path.join(dir, entry.match[1]),
        symbols: rowSymbols(entry.line.slice(entry.match[0].length)),
      }))
      .filter(row => fs.existsSync(row.abs));
  });

  test('AP-EXT-ITER219-01: every symbol a catalog row advertises is exported by the module it names', () => {
    // The floor guards the ROW side only. A dark export probe cannot fake a pass — it makes every
    // listed symbol look unexported and REDS the assertion below — but a row parser that stopped
    // yielding symbols would compare an empty list against every module and read clean, which is
    // the AP-EXT-ITER213-01 shape.
    const listed = symbolRows.reduce((total, row) => total + row.symbols.length, 0);
    assert.ok(
      symbolRows.length >= 100 && listed >= 1000,
      `only ${listed} symbol(s) parsed from ${symbolRows.length} catalog row(s) — the row grammar or the symbol-list parser stopped reaching the catalogs, and an empty list is contained in every export surface`,
    );

    const overclaims = [];
    for (const row of symbolRows) {
      const exported = exportedNames(row.abs);
      for (const symbol of row.symbols) {
        if (!exported.has(symbol)) {
          overclaims.push(`${row.catalog} -> ${row.module}: \`${symbol}\``);
        }
      }
    }

    assert.deepEqual(
      overclaims,
      [],
      'a Module Export Catalog row advertises a symbol the module it names does not export. The row is the index a reader follows to find a declaration, so an over-claimed name sends them to the wrong file — or to no file at all, when the name is dead. Point the symbol at the module that really exports it, or drop it',
    );
  });

  test('AP-EXT-ITER219-01: the probe separates a real export from a name the module lacks (negative control)', () => {
    // Fixed text against a real module, so this still separates the two cases once the live
    // catalogs are clean. `State` is exported by `types/index.ts`; `ALL_EXITS` shipped in that
    // module's own catalog row and is exported by nothing in the tree.
    const exported = exportedNames(path.join(repoRoot, 'extension/src/types/index.ts'));
    assert.deepEqual(
      [exported.has('State'), exported.has('ALL_EXITS')],
      [true, false],
      'the export probe no longer separates a symbol `types/index.ts` really exports from one that shipped in its catalog row while being exported nowhere, so it cannot see the regression it pins',
    );
  });

  test('AP-EXT-ITER219-01: the symbol list stops at glosses and prose (negative control)', () => {
    // Both live grammars, fixed text. Without the cut, `State` and `PICKLE_LINEAR_COMMAND` —
    // spelled inside a gloss and a prose tail — are read as claimed exports and correct rows red.
    const glossed =
      '`sameWorkingDir` (compare canonical realpaths), `loadActiveState` (load a `State` object)';
    const prosed =
      '`shouldRunGenerativeAudit` — returns `false` when `PICKLE_LINEAR_COMMAND` is unset';
    assert.deepEqual(
      [rowSymbols(glossed), rowSymbols(prosed)],
      [['sameWorkingDir', 'loadActiveState'], ['shouldRunGenerativeAudit']],
      "the symbol-list parser is reading identifiers out of a row's parenthetical gloss or its em-dash prose tail, which names symbols the row never advertised as exports of that module",
    );
  });

  test('AP-EXT-ITER216-01: the required set excludes what nothing imports (negative control)', () => {
    // `reap-orphans.ts` is a `src/bin` CLI entry point that no module imports, and it has no
    // row; `mux-runner.ts` is imported and does. If the derivation ever stopped keying on the
    // import graph, the first would be demanded and this arm reds before the live one does.
    const required = requiredRows('extension/src/bin/CLAUDE.md');
    assert.deepEqual(
      [required.includes('reap-orphans.ts'), required.includes('mux-runner.ts')],
      [false, true],
      'the derived required set no longer separates an imported module from a CLI entry point nothing imports, so it is demanding rows the subsystem contract does not ask for (or missing the ones it does)',
    );
  });
});

/**
 * AP-EXT-ITER154-01 — the shared 64 MB ceiling stays collapsed, pinned BY VALUE.
 *
 * `src/services/CLAUDE.md`'s AP-EXT-ITER8-01 entry says of `UNBOUNDED_READ_MAX_BUFFER`:
 * "do NOT re-declare a local copy", and its PATTERN_SHAPE asserts the literal appears in
 * `src/` only in `types/index.ts` plus one named holdout. Nothing executed that clause.
 * The seven collapsed forks are pinned above ONLY as `scopedAnchorAllowlist` entries keyed
 * on their old IDENTIFIERS, so a fork under a NEW name is invisible to every wire: the
 * shell arm reads `INVARIANT:` spans, this file's sweep resolves identifiers, and
 * `64 * 1024 * 1024` is neither. `REPLAY_GIT_MAX_BUFFER` re-forked the ceiling in
 * `bin/did-we-count-replay.ts` on 2026-08-24, seventeen days after the collapse landed, and
 * the catalog read green throughout.
 *
 * Keying on the VALUE is what needs no list of names. The assertion is an EXACT set, not a
 * floor: it reddens when a new file forks the literal AND when a listed holdout is finally
 * collapsed, so the entry cannot rot green in either direction.
 */
describe('AP-EXT-ITER154-01 shared 64 MB read ceiling (repo)', () => {
  // `src/bin/audit-ticket-bundle.ts` is the one un-collapsed pre-existing holdout named by
  // the catalog entry. It is NOT an escape hatch: collapsing it must red this test so the
  // entry and this set are updated together.
  const permitted = ['extension/src/types/index.ts', 'extension/src/bin/audit-ticket-bundle.ts'];
  const literal = /64\s*\*\s*1024\s*\*\s*1024/;

  test('the literal is declared only where the catalog says it is', () => {
    const sources = readSourceFiles();
    if (!sources.ok) assert.fail(sources.reason);

    const forks = [...sources.files]
      .filter(([, content]) => literal.test(content))
      .map(([file]) => file)
      .sort();

    assert.deepEqual(
      forks,
      [...permitted].sort(),
      'a `64 * 1024 * 1024` literal appears outside the files src/services/CLAUDE.md permits. Import UNBOUNDED_READ_MAX_BUFFER from types/index.js instead of re-declaring the ceiling; if a permitted holdout was collapsed, drop it from `permitted` and from the catalog entry in the same commit',
    );
  });

  test('the sweep can see a re-declared ceiling (negative control)', () => {
    const planted = new Map([['extension/src/bin/planted.ts', 'const X = 64 * 1024 * 1024;\n']]);
    const forks = [...planted].filter(([, c]) => literal.test(c)).map(([f]) => f);
    assert.deepEqual(forks, ['extension/src/bin/planted.ts']);
  });
});
