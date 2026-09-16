// @tier: fast
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
// f2b426dc^ -- the commit immediately before c27b2673 widened hasTestCase() to accept the repo's
// 'ANCHOR: description' test-naming convention (see ticket 2203fe28).
const PRE_WIDENING_SHA = '071c9e60e8c676f5f5613d8074ba7580beeb15f4';

async function importAnalyzer() {
  const { runT6TrapDoorCoverage, ENFORCE_REF_RE, auditTrapDoorCoverage } = await import(
    '../../services/citadel/trap-door-coverage-audit.js'
  );
  return { runT6TrapDoorCoverage, ENFORCE_REF_RE, auditTrapDoorCoverage };
}

function mkFixture(projectRoot, opts = {}) {
  const extDir = path.join(projectRoot, 'extension');
  const testsDir = path.join(extDir, 'tests');
  fs.mkdirSync(testsDir, { recursive: true });

  const claudeMdPath = path.join(extDir, 'CLAUDE.md');
  const content = opts.claudeMdContent ?? '## Trap Doors\n\n' + (opts.enforceLines ?? '') + '\n';
  fs.writeFileSync(claudeMdPath, content, 'utf-8');

  for (const [rel, body] of Object.entries(opts.testFiles ?? {})) {
    const full = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }

  return { extDir, testsDir, claudeMdPath };
}

describe('runT6TrapDoorCoverage', () => {
  let tmpRoot;
  before(() => { tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdca-')); });
  after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  test('orphan_enforce: ENFORCE points to missing file → HIGH finding', async () => {
    const projectRoot = path.join(tmpRoot, 'orphan-enforce');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/nonexistent.test.js\n',
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 1);
    assert.match(high[0].id, /orphan-enforce/);
    assert.match(high[0].message, /nonexistent\.test\.js/);
  });

  test('orphan_test_case: file exists but anchor missing → HIGH finding', async () => {
    const projectRoot = path.join(tmpRoot, 'orphan-test-case');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/real.test.js#missing-anchor\n',
      testFiles: {
        'extension/tests/real.test.js': "test('other-test', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 1);
    assert.match(high[0].id, /orphan-test-case/);
    assert.match(high[0].message, /missing-anchor/);
  });

  test('orphan_test_file: test file has no inbound ENFORCE ref → MEDIUM finding', async () => {
    const projectRoot = path.join(tmpRoot, 'orphan-test-file');
    mkFixture(projectRoot, {
      enforceLines: '',
      testFiles: {
        'extension/tests/unreferenced.test.js': "test('x', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const medium = result.findings.filter((f) => f.severity === 'Medium');
    const orphan = medium.find((f) => f.id.includes('unreferenced.test.js'));
    assert.ok(orphan, 'expected orphan-test-file finding for unreferenced.test.js');
    assert.match(orphan.id, /orphan-test-file/);
  });

  test('bare-path legacy: no #anchor → exactly 1 LOW finding per CLAUDE.md', async () => {
    const projectRoot = path.join(tmpRoot, 'bare-path');
    mkFixture(projectRoot, {
      enforceLines: [
        '- ENFORCE: extension/tests/a.test.js',
        '- ENFORCE: extension/tests/b.test.js',
        '- ENFORCE: extension/tests/c.test.js#anchor-exists',
      ].join('\n') + '\n',
      testFiles: {
        'extension/tests/a.test.js': "test('a', () => {});\n",
        'extension/tests/b.test.js': "test('b', () => {});\n",
        'extension/tests/c.test.js': "test('anchor-exists', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const low = result.findings.filter((f) => f.severity === 'Low');
    assert.equal(low.length, 1, 'exactly one LOW finding per CLAUDE.md');
    assert.match(low[0].id, /trap-door-bare-path/);
  });

  test('anchored ref with matching test case → no HIGH finding', async () => {
    const projectRoot = path.join(tmpRoot, 'anchor-found');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/suite.test.js#my-invariant\n',
      testFiles: {
        'extension/tests/suite.test.js': "test('my-invariant', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 0, 'no HIGH findings when anchor exists');
  });

  test('AP-EXT-C27B2673-01: anchor satisfied by repo convention "ANCHOR: description" title', async () => {
    const projectRoot = path.join(tmpRoot, 'convention-title');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/conv.test.js#AP-RMS-9\n',
      testFiles: {
        'extension/tests/conv.test.js':
          "test('AP-RMS-9: EVERY synchronous subprocess spawn carries a finite timeout', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 0, 'convention-titled test must satisfy the anchor');
  });

  test('AP-EXT-C27B2673-02: exact-title anchor (no description) still satisfies', async () => {
    const projectRoot = path.join(tmpRoot, 'exact-title');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/exact.test.js#AP-RMS-9\n',
      testFiles: {
        'extension/tests/exact.test.js': "test('AP-RMS-9', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 0, 'exact-title anchor must still satisfy');
  });

  test('AP-EXT-C27B2673-03: prefix safety — short anchor does not match a longer sharing-prefix title', async () => {
    const projectRoot = path.join(tmpRoot, 'prefix-short-anchor');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/prefix1.test.js#4-01\n',
      testFiles: {
        'extension/tests/prefix1.test.js': "test('4-011: unrelated longer id', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 1, 'anchor 4-01 must NOT match a title starting with 4-011');
    assert.match(high[0].id, /orphan-test-case/);
  });

  test('AP-EXT-C27B2673-04: prefix safety — longer anchor does not match a shorter sharing-prefix title', async () => {
    const projectRoot = path.join(tmpRoot, 'prefix-long-anchor');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/prefix2.test.js#4-011\n',
      testFiles: {
        'extension/tests/prefix2.test.js': "test('4-01: unrelated shorter id', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 1, 'anchor 4-011 must NOT match a title starting with 4-01');
    assert.match(high[0].id, /orphan-test-case/);
  });

  test('AP-EXT-C27B2673-05: generic-anchor control — a short generic anchor does not match broadly', async () => {
    const projectRoot = path.join(tmpRoot, 'generic-anchor');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/generic.test.js#X\n',
      testFiles: {
        'extension/tests/generic.test.js': [
          "test('Xavier config loads', () => {});",
          "test('XML parsing works', () => {});",
          "test('Xylophone sounds', () => {});",
          '',
        ].join('\n'),
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(
      high.length,
      1,
      'generic anchor X must not be satisfied by titles that merely start with the letter X',
    );
    assert.match(high[0].id, /orphan-test-case/);
  });

  test('mixed bare and anchored refs in one CLAUDE.md → exactly 1 LOW warning', async () => {
    const projectRoot = path.join(tmpRoot, 'mixed-refs');
    mkFixture(projectRoot, {
      enforceLines: [
        '- ENFORCE: extension/tests/bare1.test.js',
        '- ENFORCE: extension/tests/anchored.test.js#anchor-name',
        '- ENFORCE: extension/tests/bare2.test.js',
      ].join('\n') + '\n',
      testFiles: {
        'extension/tests/bare1.test.js': "test('x', () => {});\n",
        'extension/tests/anchored.test.js': "test('anchor-name', () => {});\n",
        'extension/tests/bare2.test.js': "test('y', () => {});\n",
      },
    });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const low = result.findings.filter((f) => f.severity === 'Low');
    assert.equal(low.length, 1, 'one LOW warning per CLAUDE.md regardless of bare-path ref count');
  });

  test('subsystem CLAUDE bare ENFORCE refs resolve to extension/tests and do not emit false orphan findings', async () => {
    const projectRoot = path.join(tmpRoot, 'subsystem-bare-ref');
    mkFixture(projectRoot, {
      testFiles: {
        'extension/tests/backend-spawn.test.js': "test('cli-override', () => {});\n",
      },
    });
    const subsystemClaudePath = path.join(projectRoot, 'extension', 'src', 'services', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(subsystemClaudePath), { recursive: true });
    fs.writeFileSync(
      subsystemClaudePath,
      [
        '## Trap Doors',
        '',
        '- `backend-spawn.ts` — INVARIANT: cli override wins. BREAKS: stale backend. ENFORCE: `backend-spawn.test.js#cli-override`.',
        '',
      ].join('\n'),
      'utf-8',
    );

    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const highIds = result.findings.filter((f) => f.severity === 'High').map((f) => f.id);
    const mediumIds = result.findings.filter((f) => f.severity === 'Medium').map((f) => f.id);
    assert.deepEqual(highIds, []);
    assert.deepEqual(mediumIds, []);
  });

  test('ENFORCE refs outside ## Trap Doors section are ignored', async () => {
    const projectRoot = path.join(tmpRoot, 'outside-section');
    const claudeMd = [
      '## Trap Doors',
      '',
      '## Other Section',
      '',
      '- ENFORCE: extension/tests/outside.test.js',
      '',
    ].join('\n');
    mkFixture(projectRoot, { claudeMdContent: claudeMd });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot });
    const high = result.findings.filter((f) => f.severity === 'High');
    assert.equal(high.length, 0, 'refs outside Trap Doors section do not produce orphan_enforce');
  });

  test('diff-scoped audit only emits orphan-test-file for changed tests but still honors unchanged ENFORCE refs', async () => {
    const projectRoot = path.join(tmpRoot, 'diff-scoped-orphans');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/referenced.test.js#kept-anchor\n',
      testFiles: {
        'extension/tests/referenced.test.js': "test('kept-anchor', () => {});\n",
        'extension/tests/unreferenced-changed.test.js': "test('changed', () => {});\n",
        'extension/tests/unreferenced-unchanged.test.js': "test('unchanged', () => {});\n",
      },
    });
    const { auditTrapDoorCoverage } = await importAnalyzer();
    const result = auditTrapDoorCoverage({
      range: 'base..head',
      base: 'base',
      head: 'head',
      repoRoot: projectRoot,
      claudeFiles: [],
      changedFiles: [
        {
          path: 'extension/tests/referenced.test.js',
          status: 'M',
          kind: 'test',
          changedLines: [],
          blame: [],
        },
        {
          path: 'extension/tests/unreferenced-changed.test.js',
          status: 'A',
          kind: 'test',
          changedLines: [],
          blame: [],
        },
      ],
    });

    const orphanIds = result.findings
      .filter((f) => f.id.startsWith('orphan-test-file:'))
      .map((f) => f.id)
      .sort();
    assert.deepEqual(orphanIds, [
      'orphan-test-file:extension/tests/unreferenced-changed.test.js',
    ]);
  });

  test('diff-scoped audit still emits orphan-test-case when a changed test breaks an unchanged ENFORCE anchor', async () => {
    const projectRoot = path.join(tmpRoot, 'diff-scoped-anchor-break');
    mkFixture(projectRoot, {
      enforceLines: '- ENFORCE: extension/tests/referenced.test.js#kept-anchor\n',
      testFiles: {
        'extension/tests/referenced.test.js': "test('different-anchor', () => {});\n",
      },
    });
    const { auditTrapDoorCoverage } = await importAnalyzer();
    const result = auditTrapDoorCoverage({
      range: 'base..head',
      base: 'base',
      head: 'head',
      repoRoot: projectRoot,
      claudeFiles: [],
      changedFiles: [
        {
          path: 'extension/tests/referenced.test.js',
          status: 'M',
          kind: 'test',
          changedLines: [],
          blame: [],
        },
      ],
    });

    const highIds = result.findings
      .filter((f) => f.severity === 'High')
      .map((f) => f.id);
    assert.deepEqual(highIds, [
      'orphan-test-case:extension/tests/referenced.test.js#kept-anchor',
    ]);
  });

  test('subsystem CLAUDE.md absence handled gracefully (no throw)', async () => {
    const projectRoot = path.join(tmpRoot, 'no-subsystem');
    mkFixture(projectRoot, { enforceLines: '' });
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    assert.doesNotThrow(() => runT6TrapDoorCoverage({ projectRoot }));
  });

  test('ENFORCE_REF_RE exported and matches comma-separated refs', async () => {
    const { ENFORCE_REF_RE } = await importAnalyzer();
    const line = 'ENFORCE: extension/tests/foo.test.js, extension/tests/bar.test.js.';
    const matches = [...line.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))];
    assert.equal(matches.length, 1);
    const captured = matches[0][1];
    assert.match(captured, /foo\.test\.js/);
    assert.match(captured, /bar\.test\.js/);
  });

  test('ENFORCE_REF_RE matches backtick-wrapped paths', async () => {
    const { ENFORCE_REF_RE } = await importAnalyzer();
    const line = 'ENFORCE: `extension/tests/baz.test.js`';
    const matches = [...line.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))];
    assert.equal(matches.length, 1);
    assert.match(matches[0][1], /baz\.test\.js/);
  });

  test('ENFORCE_REF_RE matches .sh scripts', async () => {
    const { ENFORCE_REF_RE } = await importAnalyzer();
    const line = 'ENFORCE: extension/scripts/audit-check.sh';
    const matches = [...line.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))];
    assert.equal(matches.length, 1);
    assert.match(matches[0][1], /audit-check\.sh/);
  });
});

describe('runT6TrapDoorCoverage — integration: real extension/CLAUDE.md', () => {
  // The acceptance criterion checks extension/CLAUDE.md specifically.
  // Subsystem CLAUDE.md files (extension/src/**/CLAUDE.md) may have pre-existing orphan refs
  // that are filed as separate tickets (NOT in scope per ticket 7a276c38).
  test('0 high-severity findings from extension/CLAUDE.md against HEAD', async () => {
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot: REPO_ROOT });
    const high = result.findings.filter(
      (f) => f.severity === 'High' && f.file === 'extension/CLAUDE.md',
    );
    assert.deepStrictEqual(
      high,
      [],
      `Expected 0 HIGH findings from extension/CLAUDE.md; got:\n${high.map((f) => `  ${f.id}: ${f.message}`).join('\n')}`,
    );
  });
});

// --- ticket 2203fe28: prove the c27b2673 widening repaired the matcher rather than disabling it.
//
// Everything below is re-derived from the live tree and from git history at test-run time -- no
// stored fixture. The OLD (pre-widening) hasTestCase() no longer exists in source, so its body is
// extracted from the compiled mirror at the commit immediately before the fix landed, via git show,
// and evaluated as real code -- never hand-duplicated, which would risk silently drifting from what
// the fix commit actually changed.

function walkForClaudeMdFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkForClaudeMdFiles(full));
    else if (entry.name === 'CLAUDE.md') results.push(full);
  }
  return results;
}

// Mirrors collectClaudeMdFiles() in trap-door-coverage-audit.ts: extension/CLAUDE.md plus every
// extension/src/**/CLAUDE.md -- the same corpus runT6TrapDoorCoverage walks in production.
function collectClaudeMdFilesForTest(repoRoot) {
  const files = [];
  const primary = path.join(repoRoot, 'extension', 'CLAUDE.md');
  if (fs.existsSync(primary)) files.push(primary);
  const srcDir = path.join(repoRoot, 'extension', 'src');
  if (fs.existsSync(srcDir)) files.push(...walkForClaudeMdFiles(srcDir));
  return files;
}

function normalizeRelativePathForTest(filePath) {
  return filePath.split(path.sep).join('/');
}

// Mirrors resolveEnforceRef() in trap-door-coverage-audit.ts.
function resolveEnforceRefForTest(repoRoot, filePath) {
  const normalized = normalizeRelativePathForTest(filePath);
  const canonicalPath = normalized.startsWith('extension/')
    ? normalized
    : normalized.startsWith('tests/')
      ? `extension/${normalized}`
      : `extension/tests/${normalized}`;
  return { canonicalPath, absPath: path.resolve(repoRoot, canonicalPath) };
}

// Mirrors parseEnforceRefs() in trap-door-coverage-audit.ts.
function parseEnforceRefsForTest(raw) {
  return raw.split(/,\s*/).flatMap((part) => {
    const cleaned = part.trim().replace(/^`|`$/g, '');
    if (!cleaned) return [];
    const hashIdx = cleaned.indexOf('#');
    if (hashIdx === -1) return [];
    return [{ filePath: cleaned.slice(0, hashIdx), anchor: cleaned.slice(hashIdx + 1) }];
  });
}

// Every anchored ENFORCE ref, across the real catalog corpus, whose target file exists on disk --
// the exact population runT6TrapDoorCoverage evaluates for orphan-test-case findings.
async function enumerateAnchoredEnforceRefs(repoRoot) {
  const { ENFORCE_REF_RE } = await importAnalyzer();
  const { extractTrapDoorsSection } = await import('../../services/citadel/trap-doors-section.js');

  const pairs = [];
  for (const claudeFile of collectClaudeMdFilesForTest(repoRoot)) {
    const content = fs.readFileSync(claudeFile, 'utf-8');
    const section = extractTrapDoorsSection(content);
    if (!section) continue;
    for (const match of section.matchAll(new RegExp(ENFORCE_REF_RE.source, ENFORCE_REF_RE.flags))) {
      for (const ref of parseEnforceRefsForTest(match[1])) {
        const { canonicalPath, absPath } = resolveEnforceRefForTest(repoRoot, ref.filePath);
        if (!fs.existsSync(absPath)) continue;
        pairs.push({ canonicalPath, absPath, anchor: ref.anchor });
      }
    }
  }

  const seen = new Set();
  return pairs.filter((p) => {
    const key = `${p.canonicalPath}#${p.anchor}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractHasTestCaseSource(jsModuleText) {
  const match = jsModuleText.match(/function hasTestCase\(content, anchor\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('could not extract hasTestCase() from module source');
  return match[0];
}

function buildHasTestCase(fnSource) {
  // eslint-disable-next-line no-new-func -- evaluating real historical/current production source,
  // extracted verbatim by extractHasTestCaseSource(), not a hand-authored regex.
  return new Function('content', 'anchor', `${fnSource}\nreturn hasTestCase(content, anchor);`);
}

function readOldHasTestCase(repoRoot) {
  const oldModuleText = execFileSync(
    'git',
    ['show', `${PRE_WIDENING_SHA}:extension/services/citadel/trap-door-coverage-audit.js`],
    { cwd: repoRoot, encoding: 'utf-8', timeout: 10_000 },
  );
  return buildHasTestCase(extractHasTestCaseSource(oldModuleText));
}

function readCurrentHasTestCase(repoRoot) {
  const currentModuleText = fs.readFileSync(
    path.join(repoRoot, 'extension', 'services', 'citadel', 'trap-door-coverage-audit.js'),
    'utf-8',
  );
  return buildHasTestCase(extractHasTestCaseSource(currentModuleText));
}

// Computed ONCE (module scope) and shared by both describe blocks below, so the process spawns
// `git show` exactly once regardless of how many assertions replay over the result.
let replayCleared;
let replayRemaining;
let replayOldBrokenCount;
let replayPairs;
let replayReadCached;
let replayNewHasTestCase;

const pairKey = (p) => `${p.canonicalPath}#${p.anchor}`;

before(async () => {
  const pairs = await enumerateAnchoredEnforceRefs(REPO_ROOT);
  const oldHasTestCase = readOldHasTestCase(REPO_ROOT);
  const newHasTestCase = readCurrentHasTestCase(REPO_ROOT);

  const fileContentCache = new Map();
  const readCached = (absPath) => {
    if (!fileContentCache.has(absPath)) fileContentCache.set(absPath, fs.readFileSync(absPath, 'utf-8'));
    return fileContentCache.get(absPath);
  };
  replayPairs = pairs;
  replayReadCached = readCached;
  replayNewHasTestCase = newHasTestCase;

  const oldBroken = [];
  const newBroken = [];
  for (const p of pairs) {
    const content = readCached(p.absPath);
    if (!oldHasTestCase(content, p.anchor)) oldBroken.push(p);
    if (!newHasTestCase(content, p.anchor)) newBroken.push(p);
  }

  replayOldBrokenCount = oldBroken.length;
  const newBrokenKeys = new Set(newBroken.map((p) => `${p.canonicalPath}#${p.anchor}`));
  replayCleared = oldBroken.filter((p) => !newBrokenKeys.has(`${p.canonicalPath}#${p.anchor}`));
  replayRemaining = newBroken;
});

describe('runT6TrapDoorCoverage — full corpus replay against the widened anchor matcher (ticket 2203fe28)', () => {
  test('the widened matcher clears the large majority of previously-broken anchors', () => {
    const cleared = replayCleared;
    const remaining = replayRemaining;
    const oldBrokenCount = replayOldBrokenCount;
    // The failure message prints the live counts. Floor is set well below the value measured when
    // the widening landed so ordinary future trap-door additions don't make this flaky; it exists
    // to catch a REGRESSION of the widening (cleared collapsing back toward oldBrokenCount).
    assert.ok(
      cleared.length >= 80,
      `expected the widening to clear at least 80 previously-broken anchors, cleared only ${cleared.length} of ${oldBrokenCount}`,
    );
    assert.ok(
      cleared.length > remaining.length,
      `expected clearing to dominate: cleared=${cleared.length} remaining=${remaining.length}`,
    );
  });

  test('the widened matcher still reports the genuinely-absent anchors -- it did not disable the check', () => {
    const remaining = replayRemaining;
    // remaining > 0 catches over-widening (a matcher that accepts everything would report 0 here,
    // the exact failure mode this ticket exists to rule out). The ceiling catches under-widening
    // (a reverted/weakened matcher would balloon remaining back toward oldBrokenCount, ~145).
    assert.ok(remaining.length > 0, 'the widened matcher must not be vacuous: at least one genuinely-absent anchor must still be reported');
    assert.ok(
      remaining.length < 50,
      `expected remaining genuinely-broken anchors to stay well below the pre-fix scale (~145); got ${remaining.length}`,
    );
  });

  test('the re-derived remaining set matches production\'s own live orphan-test-case findings exactly', async () => {
    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const result = runT6TrapDoorCoverage({ projectRoot: REPO_ROOT });
    const productionIds = result.findings
      .filter((f) => f.id.startsWith('orphan-test-case:'))
      .map((f) => f.id.replace(/^orphan-test-case:/, ''))
      .sort();
    const derivedIds = replayRemaining.map((p) => `${p.canonicalPath}#${p.anchor}`).sort();
    assert.deepEqual(
      derivedIds,
      productionIds,
      'the independently re-derived "still genuinely broken" set must equal what runT6TrapDoorCoverage actually reports',
    );
  });

  // d5b5add3 (AC-T2-2, second half): `remaining > 0` above passes a matcher that clears all but ONE
  // genuinely-absent anchor (measured: accept-everything-but-one left all three tests above GREEN).
  // The population that MUST survive is derived from the text, not from any matcher: an anchor whose
  // characters appear nowhere in its file cannot be satisfied by a test title there, so no correct
  // widening may clear it. At the widening that is the PRD's 26 of 147; no count is hardcoded.
  test('AC-T2-2: every anchor absent from its file\'s text is still reported — a matcher clearing any of them reds', async () => {
    assert.ok(replayPairs.length >= 100, `corpus went dark: only ${replayPairs.length} anchored ENFORCE pairs enumerated`);
    const mustRemain = replayPairs
      .filter((p) => !replayReadCached(p.absPath).includes(p.anchor))
      .map(pairKey);
    assert.ok(mustRemain.length > 0, 'no literally-absent anchor in the corpus — this pin would be vacuous');

    const replayedKeys = new Set(replayRemaining.map(pairKey));
    assert.deepEqual(
      mustRemain.filter((k) => !replayedKeys.has(k)),
      [],
      'the current hasTestCase cleared anchors whose text does not occur in their file',
    );

    const { runT6TrapDoorCoverage } = await importAnalyzer();
    const reported = new Set(
      runT6TrapDoorCoverage({ projectRoot: REPO_ROOT }).findings
        .filter((f) => f.id.startsWith('orphan-test-case:'))
        .map((f) => f.id.replace(/^orphan-test-case:/, '')),
    );
    assert.deepEqual(
      mustRemain.filter((k) => !reported.has(k)),
      [],
      'runT6TrapDoorCoverage stopped reporting anchors whose text does not occur in their file',
    );
  });
});

describe('runT6TrapDoorCoverage vs audit-trap-door-enforcement.sh — no silent contradiction (ticket 2203fe28)', () => {
  test('the shell audit still exits 0 over the same tree', () => {
    const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: path.join(REPO_ROOT, 'extension'),
      encoding: 'utf-8',
      timeout: 60_000,
    });
    assert.equal(
      result.status,
      0,
      `audit-trap-door-enforcement.sh must exit 0; got status=${result.status}\nstderr:\n${result.stderr}`,
    );
  });

  test('a citadel/shell divergence, if any, is reported rather than silently reconciled', async () => {
    // Extract the shell script's OWN slug/segment-boundary anchor rule from its live source text
    // -- the same anti-drift idiom used above for the retired hasTestCase() -- rather than
    // hand-duplicating it, so this can never silently diverge from what the shell script runs.
    const shellSource = fs.readFileSync(
      path.join(REPO_ROOT, 'extension', 'scripts', 'audit-trap-door-enforcement.sh'),
      'utf-8',
    );
    const slugifyMatch = shellSource.match(/const slugify = \([^)]*\) => [^;]+;/);
    const testNameReMatch = shellSource.match(/const TEST_NAME_RE = [^;]+;/);
    const matchCountMatch = shellSource.match(/function anchorMatchCount\(fileContent, anchor\) \{[\s\S]*?\n\}/);
    assert.ok(slugifyMatch && testNameReMatch && matchCountMatch, 'could not extract the shell script\'s anchor-resolution rule from its source');

    const shellAnchorResolves = new Function(
      'fileContent',
      'anchor',
      `${slugifyMatch[0]}\n${testNameReMatch[0]}\n${matchCountMatch[0]}\nreturn anchorMatchCount(fileContent, anchor) > 0;`,
    );

    // Reuses the module-level replay (computed once in the shared `before()` above) instead of
    // re-deriving it, so this test spawns no additional `git show`.
    const divergent = [];
    const agreeing = [];
    for (const p of replayRemaining) {
      const content = fs.readFileSync(p.absPath, 'utf-8');
      const shellResolves = shellAnchorResolves(content, p.anchor);
      (shellResolves ? divergent : agreeing).push(`${p.canonicalPath}#${p.anchor}`);
    }

    // Report, do not swallow: this is the AC-T2-2 "reported rather than tuned away" contract.
    // eslint-disable-next-line no-console -- deliberate CI-visible divergence report.
    console.log(
      `[citadel-vs-shell] ${divergent.length} of ${replayRemaining.length} citadel-genuine anchor(s) ` +
        `are resolved by the shell's more permissive slug matcher (documented divergence, ` +
        `AP-EXT-ITER56-01): ${JSON.stringify(divergent)}`,
    );

    // d5b5add3 (AC-T2-5): the partition above cannot fail, so the non-contradiction is asserted here.
    // The shell audit exits 0 and is authoritative; the contradiction that would matter is citadel
    // CLEARING an anchor the shell cannot resolve. Over the real corpus alone the shell resolves every
    // pair, so the implication would hold for any citadel matcher — each pair is therefore also probed
    // with its anchor lengthened by one character (a derived non-anchor over the same real content).
    const probes = replayPairs.flatMap((p) => [p, { ...p, anchor: `${p.anchor}9` }]);
    let shellRejected = 0;
    const contradictions = [];
    for (const p of probes) {
      const content = replayReadCached(p.absPath);
      if (shellAnchorResolves(content, p.anchor)) continue;
      shellRejected++;
      if (replayNewHasTestCase(content, p.anchor)) contradictions.push(pairKey(p));
    }
    assert.ok(shellRejected > 0, 'the shell rule rejected no probe — the non-contradiction check would be vacuous');
    assert.deepEqual(
      contradictions,
      [],
      'citadel clears anchors the authoritative shell audit cannot resolve on the same content',
    );
  });
});
