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
