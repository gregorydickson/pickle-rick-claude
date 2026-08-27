// @tier: fast
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
const anchorCatalogs = [
  'extension/CLAUDE.md',
  'extension/src/bin/CLAUDE.md',
  'extension/src/hooks/CLAUDE.md',
  'extension/src/lib/CLAUDE.md',
  'extension/src/services/CLAUDE.md',
  'extension/src/types/CLAUDE.md',
];

/** camelCase (>= 2 chars before the hump) or SCREAMING_SNAKE with >= 1 underscore. */
const anchorTokenPattern = /\b([a-z][a-zA-Z0-9]{1,}[A-Z][a-zA-Z0-9]*|[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+)\b/g;

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
 * Both are excluded by path. Nothing else in the tree may enumerate absent tokens.
 */
const anchorCorpusExclusions = new Set(['extension/tests/trap-door-conformance.test.js']);

/** Finite ceiling on every git spawn this sweep makes — an unbounded spawn can hang the tier. */
const ANCHOR_GIT_TIMEOUT_MS = 30000;

/**
 * Discriminated result for the same reason `runClaudeDiff` has one: a corpus that failed to
 * build is a sweep that did not run, and a not-run sweep must FAIL rather than report zero.
 */
function buildAnchorCorpus(cwd = repoRoot) {
  let listing;
  try {
    listing = execFileSync(
      'git',
      ['ls-files', '-z', '--', '*.ts', '*.js', '*.sh', '*.json', '*.yml', '*.md'],
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
    .filter(file => path.basename(file) !== 'CLAUDE.md')
    .filter(file => !anchorCorpusExclusions.has(file));
  if (files.length === 0) {
    return { ok: false, reason: 'git ls-files returned zero files — corpus would match nothing' };
  }

  const parts = [];
  for (const file of files) {
    try {
      parts.push(fs.readFileSync(path.join(cwd, file), 'utf8'));
    } catch {
      // A tracked-but-unreadable path (submodule gitlink, deleted worktree entry) is not a
      // corpus failure; the file-count assertion below still proves the sweep ran.
    }
  }

  return { ok: true, corpus: parts.join('\n'), fileCount: files.length };
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

function findDeadAnchors(tokens, corpus) {
  return tokens.filter(entry => !corpus.includes(entry.token));
}

describe('trap-door catalog anchor liveness (fixture parser)', () => {
  const catalog = 'extension/CLAUDE.md';

  test('a dead symbol on an INVARIANT line is reported', () => {
    const content = '- `src/a.ts` — INVARIANT: `liveHelper` delegates to `deletedHelper`. BREAKS: x. ENFORCE: y.';
    const dead = findDeadAnchors(collectAnchorTokens(catalog, content), 'export function liveHelper() {}');

    assert.deepEqual(dead.map(entry => entry.token), ['deletedHelper']);
  });

  test('prose outside backticks and lines without an anchor keyword are not scanned', () => {
    const content = [
      '- `src/a.ts` — some deletedHelper prose with no anchor keyword and no backticks',
      'PATTERN_SHAPE: bareDeletedHelper mentioned outside backticks',
    ].join('\n');

    assert.deepEqual(findDeadAnchors(collectAnchorTokens(catalog, content), ''), []);
  });

  test('a token repeated on one line is reported once', () => {
    const content = '- `src/a.ts` — PATTERN_SHAPE: `deletedHelper` then `deletedHelper` again.';

    assert.equal(findDeadAnchors(collectAnchorTokens(catalog, content), '').length, 1);
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

    const violations = findDeadAnchors(tokens, corpusResult.corpus)
      .filter(entry => !anchorAbsenceAllowlist.has(`${entry.catalog}::${entry.token}`))
      .map(entry => `${entry.catalog}:${entry.line} \`${entry.token}\``);

    assert.deepEqual(
      [...new Set(violations)],
      [],
      'a trap-door anchor names an identifier that exists nowhere in the tree — correct the anchor to the live symbol, or add it to anchorAbsenceAllowlist with its reason if the absence is deliberate (negative assertion / historical shape / meta-placeholder)',
    );
  });

  test('no stale allowlist entries', () => {
    if (!corpusResult.ok) {
      assert.fail(corpusResult.reason);
    }

    const stale = [...anchorAbsenceAllowlist.keys()].filter(key => {
      const token = key.slice(key.indexOf('::') + 2);
      return corpusResult.corpus.includes(token);
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
