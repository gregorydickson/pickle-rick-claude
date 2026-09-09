// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { simulateBinaryAbsent } from './helpers/simulate-binary-absent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');

test('audit-trap-door-enforcement exits 0 at HEAD', () => {
  const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
});

test('audit-trap-door-enforcement fails when R-CNAR-7 PATTERN_SHAPE is blanked in fixture CLAUDE.md', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-trap-door-'));

  try {
    const sourcePath = path.join(EXTENSION_ROOT, 'CLAUDE.md');
    const fixturePath = path.join(tmpDir, 'CLAUDE.md');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const fixture = source.replace(
      /(R-CNAR-1 part 2 cap split\)[\s\S]*?)PATTERN_SHAPE:\s*[\s\S]*?(?=\sBREAKS:)/,
      '$1PATTERN_SHAPE: '
    );

    assert.notEqual(fixture, source, 'fixture must remove the PATTERN_SHAPE clause body');
    fs.writeFileSync(fixturePath, fixture);

    const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PATH_OVERRIDE: fixturePath,
      },
    });

    assert.notEqual(result.status, 0, 'audit should fail when PATTERN_SHAPE is blank');
    assert.match(result.stderr, /PATTERN_SHAPE/, `stderr: ${result.stderr}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// AP-EXT-ITER152-01: the INVARIANT liveness corpus must exclude the sibling wire's
// anchor-absence allowlist.
//
// That allowlist (trap-door-conformance.test.js) exists to spell out, as bare string
// literals, every anchor token that must NOT exist. The sibling excludes itself from its
// own corpus and calls the exclusion load-bearing; this arm did not, so every token the
// sibling declared deliberately-dead read back as LIVE here — and, generally, allowlisting
// a name over there was the act that blinded this gate to it. Measured before the fix: 8
// anchors in src/services/CLAUDE.md resolved SOLELY off those literals and were counted
// among `verified`.
//
// The dead token is DERIVED at run time, never written here as a bare word. Writing one
// into this file would put it in the corpus and revive it — the exact defect under test,
// re-created by its own regression test.
const ANCHOR_ABSENCE_ENUMERATOR = 'extension/tests/trap-door-' + 'conformance.test.js';

/** A token the enumerator declares absent and that occurs in NO other non-markdown tracked file. */
function findTokenLiveOnlyInEnumerator() {
  const repoRoot = path.resolve(EXTENSION_ROOT, '..');
  const enumeratorText = fs.readFileSync(path.join(repoRoot, ANCHOR_ABSENCE_ENUMERATOR), 'utf8');
  const tokens = [...enumeratorText.matchAll(/'[^'\n]*::([A-Za-z_$][A-Za-z0-9_$]*)'/g)].map((m) => m[1]);

  for (const token of tokens) {
    const hits = spawnSync('git', ['grep', '-l', '-w', '-F', '--', token], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (hits.status !== 0 && hits.status !== 1) continue;
    const files = (hits.stdout || '').split('\n').filter(Boolean).filter((f) => !f.endsWith('.md'));
    if (files.length === 1 && files[0] === ANCHOR_ABSENCE_ENUMERATOR) return token;
  }
  return null;
}

function runAuditOverFixtureCatalog(entryLine) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-trap-door-corpus-'));
  try {
    const fixturePath = path.join(tmpDir, 'CLAUDE.md');
    const emptyCatalogRoot = path.join(tmpDir, 'no-subsystems');
    fs.mkdirSync(emptyCatalogRoot);
    fs.writeFileSync(
      fixturePath,
      fs.readFileSync(path.join(EXTENSION_ROOT, 'CLAUDE.md'), 'utf8') + '\n' + entryLine + '\n'
    );

    return spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        CLAUDE_PATH_OVERRIDE: fixturePath,
        SUBSYSTEM_CATALOG_ROOT_OVERRIDE: emptyCatalogRoot,
      },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER152-01 INVARIANT corpus does not resolve a token that only the anchor-absence allowlist spells out', () => {
  const token = findTokenLiveOnlyInEnumerator();
  assert.ok(
    token,
    'precondition: the enumerator must declare at least one token absent from every other ' +
      'non-markdown tracked file, otherwise this test measures nothing'
  );

  const result = runAuditOverFixtureCatalog('- `x.ts` — INVARIANT: `' + token + '` is the anchor.');

  assert.match(
    result.stderr,
    new RegExp('names a symbol nothing in the tree uses: ' + token),
    'a token spelled ONLY in the sibling allowlist must NOT resolve as live; the corpus is ' +
      `resolving it off that allowlist. stderr: ${result.stderr}`
  );
});

test('AP-EXT-ITER152-01 INVARIANT corpus still resolves a genuinely live symbol (exclusion is not a blanket)', () => {
  // Declared in the audit script itself, a tracked non-markdown file that stays in the corpus.
  const liveToken = 'buildSymbolCorpus';
  const result = runAuditOverFixtureCatalog('- `x.ts` — INVARIANT: `' + liveToken + '` is the anchor.');

  assert.doesNotMatch(
    result.stderr,
    new RegExp('names a symbol (?:absent from the tree|nothing in the tree uses): ' + liveToken),
    `excluding the enumerator must not narrow the corpus for live symbols. stderr: ${result.stderr}`
  );
});

test('AP-EXT-ITER153-01 the INVARIANT corpus reads every tracked non-markdown file', () => {
  const withFix = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });

  const trackedNonMarkdown = spawnSync('bash', ['-c', 'git ls-files -z | tr "\\0" "\\n" | grep -cv "\\.md$"'], {
    cwd: path.resolve(EXTENSION_ROOT, '..'),
    encoding: 'utf8',
    timeout: 30_000,
  });

  const reported = /against \d+ symbols in (\d+) tracked file\(s\)/.exec(withFix.stdout);
  assert.ok(reported, `success line must report the corpus file count; stdout: ${withFix.stdout}`);
  assert.equal(
    Number(reported[1]),
    Number(trackedNonMarkdown.stdout.trim()),
    'the corpus is every tracked non-markdown file: AP-EXT-ITER153-01 replaced the ' +
      'per-file exclusion with a per-OCCURRENCE rule, so the enumerator is READ again ' +
      'while the names it only spells still resolve nothing (pin above)'
  );
});

// AP-EXT-ITER153-01: the per-file exclusion was one hand-written path, and the tree held
// more files that spell a name solely to assert it is GONE — including THIS AUDIT's own
// `prunedExports` list, which resolved both of the pruned exports it names (each declared
// MUST-NOT-EXIST by an extension/CLAUDE.md anchor) off the very arm asserting their
// absence. Both wires were blind: the sibling sweep reads *.sh too. The fix stops naming
// files and asks of each OCCURRENCE whether the file USES the name or only SPELLS it.
//
// Those two names are deliberately NOT written anywhere in this file, not even in this
// comment: a comment is stripped from the USE half of the rule but still counts as a
// SPELLING, so naming them here pushes their file cardinality to 2 and defuses the pin
// below. Measured — the first draft of this comment did exactly that.
//
// Same derivation discipline as the pin above: the dead token is read out of the audit
// script at run time. Writing it here as a literal would make THIS file a second speller,
// push the cardinality to 2 and silently defuse the pin.

/** A name the audit's own `prunedExports` list declares absent, spelled nowhere else. */
function findTokenLiveOnlyInAuditScript() {
  const repoRoot = path.resolve(EXTENSION_ROOT, '..');
  const auditRel = 'extension/scripts/audit-trap-door-' + 'enforcement.sh';
  const text = fs.readFileSync(path.join(repoRoot, auditRel), 'utf8');
  const block = /const prunedExports = \[([\s\S]*?)\]/.exec(text);
  if (!block) return null;
  const tokens = [...block[1].matchAll(/'export function ([A-Za-z_$][A-Za-z0-9_$]*)'/g)].map((m) => m[1]);

  for (const token of tokens) {
    const hits = spawnSync('git', ['grep', '-l', '-w', '-F', '--', token], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (hits.status !== 0 && hits.status !== 1) continue;
    const files = (hits.stdout || '').split('\n').filter(Boolean).filter((f) => !f.endsWith('.md'));
    if (files.length === 1 && files[0] === auditRel) return token;
  }
  return null;
}

test('AP-EXT-ITER153-01 a name only the audit\'s own absence-assertion list spells does not resolve as live', () => {
  const token = findTokenLiveOnlyInAuditScript();
  assert.ok(
    token,
    'precondition: the audit\'s prunedExports must declare at least one name absent from ' +
      'every other non-markdown tracked file, otherwise this test measures nothing'
  );

  const result = runAuditOverFixtureCatalog('- `x.ts` — INVARIANT: `' + token + '` is the anchor.');

  assert.match(
    result.stderr,
    new RegExp('names a symbol nothing in the tree uses: ' + token),
    'the arm is resolving the anchor off its OWN list of names that must not exist. ' +
      `stderr: ${result.stderr}`
  );
});

test('AP-EXT-ITER153-01 a symbol the audit script genuinely declares still resolves as live', () => {
  // Declared, not merely spelled, inside the audit script — the file stays in the corpus
  // and must keep answering for what it USES. This is the direction a blanket per-file
  // exclusion would have broken: measured, `isLivenessChannel`, `codeWords` and
  // `TEST_NAME_RE` are all anchored in extension/CLAUDE.md and resolve nowhere else.
  const liveToken = 'isLivenessChannel';
  const result = runAuditOverFixtureCatalog('- `x.ts` — INVARIANT: `' + liveToken + '` is the anchor.');

  assert.doesNotMatch(
    result.stderr,
    new RegExp('names a symbol (?:absent from the tree|nothing in the tree uses): ' + liveToken),
    `a symbol the corpus USES must stay verified. stderr: ${result.stderr}`
  );
});

test('AP-EXT-ITER153-01 a live string-valued name spelled in several files still resolves as live', () => {
  // The cardinality clause is what keeps the spell/use rule from reddening every
  // activity-event name: those exist ONLY as string literals, so they are spelled and
  // never "used" — but they are spelled by a producer, a consumer and a compiled mirror.
  // Drop the `=== 1` and this anchor goes red, which is the mutation this pin catches.
  const eventName = 'worker_gate_red';
  const result = runAuditOverFixtureCatalog('- `x.ts` — INVARIANT: `' + eventName + '` is the anchor.');

  assert.doesNotMatch(
    result.stderr,
    new RegExp('names a symbol (?:absent from the tree|nothing in the tree uses): ' + eventName),
    'a literal-only name spelled by more than one file is live, not spelled-only. ' +
      `stderr: ${result.stderr}`
  );
});

// AP-EXT-ITER45-01 — a unified diff is a RECORD of code, so it SPELLS names and USES none.
//
// A `.patch`/`.diff` fixture is the sharpest case of the medium markdown is already excluded
// for: the line proving a symbol DELETED is byte-identical to the line that would prove it
// live but for a leading `-`. Before the fix the corpus read those hunks as ordinary code and
// counted the names in them among its `verified` symbols — an anchor could name a function the
// tree had deleted and resolve it off the very hunk recording the deletion.
//
// The token is DERIVED at run time and never written here as a literal, for the reason the
// sibling pins above state: a bare occurrence in this file would enter `codeWords`, lift the
// name out of the prose-only tier and silently defuse the pin. Measured — an early draft that
// hard-coded one did exactly that.
const DIFF_HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
const ANCHOR_SHAPED_RE = /^(?:[A-Za-z][a-zA-Z0-9]*[a-z][A-Z][a-zA-Z0-9]*|[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+)$/;

/** Tracked files whose CONTENT is a unified diff — found the way the audit finds them. */
function trackedDiffFixtures() {
  const repoRoot = path.resolve(EXTENSION_ROOT, '..');
  const listed = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return (listed.stdout || '')
    .split('\0')
    .filter(Boolean)
    .filter((rel) => {
      try {
        return DIFF_HUNK_HEADER_RE.test(fs.readFileSync(path.join(repoRoot, rel), 'utf8'));
      } catch {
        return false;
      }
    });
}

/** An anchor-shaped name carried ONLY by a tracked diff fixture — declared by no source file. */
function findTokenLiveOnlyInDiffFixture() {
  const repoRoot = path.resolve(EXTENSION_ROOT, '..');
  const fixtures = trackedDiffFixtures();
  const seen = new Set();

  for (const rel of fixtures) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      const token = match[0];
      if (seen.has(token) || !ANCHOR_SHAPED_RE.test(token)) continue;
      seen.add(token);

      const hits = spawnSync('git', ['grep', '-l', '-w', '-F', '--', token], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (hits.status !== 0 && hits.status !== 1) continue;
      const carriers = (hits.stdout || '')
        .split('\n')
        .filter(Boolean)
        .filter((f) => !f.endsWith('.md'));
      if (carriers.length > 0 && carriers.every((f) => fixtures.includes(f))) return token;
    }
  }
  return null;
}

test('AP-EXT-ITER45-01 the audit finds diff fixtures by CONTENT, not by extension or path', () => {
  const fixtures = trackedDiffFixtures();
  assert.ok(
    fixtures.length > 0,
    'precondition: the tree must track at least one unified-diff fixture, otherwise every ' +
      'case below measures nothing'
  );
  assert.ok(
    fixtures.every((f) => /\.(patch|diff)$/.test(f)),
    `the content detector must not fire on a source file; fired on: ${fixtures.join(', ')}`
  );
});

test('AP-EXT-ITER45-01 a name carried only by a tracked diff hunk does not resolve as a live symbol', () => {
  const token = findTokenLiveOnlyInDiffFixture();
  assert.ok(
    token,
    'precondition: a tracked diff fixture must carry at least one anchor-shaped name absent ' +
      'from every other non-markdown file, otherwise this pin measures nothing'
  );

  const result = runAuditOverFixtureCatalog('- `x.ts` — INVARIANT: `' + token + '` is the anchor.');

  assert.match(
    result.stderr,
    new RegExp('INVARIANT \\(prose-only\\): [^\\n]*: ' + token + ':'),
    'a name only a diff hunk carries must NOT be counted among the verified symbols — the ' +
      `corpus is reading the diff as code. stderr: ${result.stderr}`
  );
});

test('AP-EXT-ITER45-01 a symbol a diff fixture mentions AND real code declares is still live', () => {
  // Written as a literal deliberately: this name is genuinely declared in microverse-runner.ts,
  // so spelling it here cannot manufacture the liveness the case asserts.
  const liveToken = 'probeJudgeBackendAvailability';
  const result = runAuditOverFixtureCatalog('- `x.ts` — INVARIANT: `' + liveToken + '` is the anchor.');

  assert.doesNotMatch(
    result.stderr,
    new RegExp(liveToken),
    'discounting diff hunks must not narrow the corpus for a symbol real code declares — the ' +
      `strip is not a blanket. stderr: ${result.stderr}`
  );
});

// B-ARGMAX AC-5 — the argv-ceiling sweep arm.
//
// The arm asserts that every exported invocation builder in the backend spawn service routes its
// result through the seam that bounds each argv element. These cases exist because an arm that
// only ever passes proves nothing: each one mutates the service into a shape the invariant
// forbids and requires the audit to red. Driven over a COPY via the path override, so the real
// source is never written to.
function runArgvCeilingSweep(sourceText) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argv-ceiling-'));
  try {
    const fixturePath = path.join(tmpDir, 'backend-spawn.ts');
    fs.writeFileSync(fixturePath, sourceText);
    return spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, BACKEND_SPAWN_PATH_OVERRIDE: fixturePath },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readBackendSpawnSource() {
  return fs.readFileSync(path.join(EXTENSION_ROOT, 'src', 'services', 'backend-spawn.ts'), 'utf8');
}

const BOUND_CALL = 'boundInvocationArgs(selectJudgeInvocation(backend, opts))';

test('B-ARGMAX argv-ceiling sweep passes over the real backend spawn service and reports its count', () => {
  // No override and no copy: the point of this case is the count line the arm prints over the
  // REAL tree, so the swept population is a visible number rather than a silent pass.
  const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });

  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /B-ARGMAX argv-ceiling verified \(\d+ exported invocation builder\(s\) bounded\)/);
});

test('B-ARGMAX argv-ceiling sweep fails when one exported builder drops the bound', () => {
  const source = readBackendSpawnSource();
  assert.ok(source.includes(BOUND_CALL), 'fixture premise: the judge dispatcher applies the bound');
  const mutated = source.replace(BOUND_CALL, 'selectJudgeInvocation(backend, opts)');
  assert.notEqual(mutated, source, 'mutation must change the source');

  const result = runArgvCeilingSweep(mutated);

  assert.notEqual(result.status, 0, `audit should fail; stdout: ${result.stdout}`);
  assert.match(result.stderr, /buildJudgeInvocation .* without applying the argv ceiling/);
});

test('B-ARGMAX argv-ceiling sweep is not satisfied by a comment naming the seam helper', () => {
  const source = readBackendSpawnSource();
  const mutated = source.replace(
    BOUND_CALL,
    'selectJudgeInvocation(backend, opts); // boundInvocationArgs( is applied somewhere else',
  );
  assert.notEqual(mutated, source, 'mutation must change the source');

  const result = runArgvCeilingSweep(mutated);

  assert.notEqual(result.status, 0, `a comment must not satisfy the pin; stdout: ${result.stdout}`);
  assert.match(result.stderr, /buildJudgeInvocation .* without applying the argv ceiling/);
});

test('B-ARGMAX argv-ceiling sweep fails rather than reporting a clean sweep over zero builders', () => {
  const result = runArgvCeilingSweep('export const unrelated = 1;\n');

  assert.notEqual(result.status, 0, `audit should fail; stdout: ${result.stdout}`);
  assert.match(result.stderr, /found zero exported invocation builders/);
});

// ---------------------------------------------------------------------------
// AP-BIN-ITER3-01. The ENFORCE anchor charset cannot match a SPACE, so a catalog
// that writes a whole test NAME after `#` had it silently truncated to the first
// token. bin/CLAUDE.md's `#exits 10 when the tagged commit package version drifts
// from HEAD even though the tag name matches` parsed as `#exits`, which resolves
// against all 25 `exits ...` cases in release-gate.test.js. Measured before the fix:
// renaming that one test away left the audit at rc=0, "623 ENFORCE reference(s)
// verified" — resolving is not identifying, and the trap door's whole claim is that
// deleting the named guard reddens the gate.
//
// The arm is BEHAVIORAL: it drives the shipped audit over a fixture catalog rather
// than grepping the script, because a source grep stays green over a check that is
// present but unreachable.
// ---------------------------------------------------------------------------
const TRUNCATION_PROBE_ANCHOR =
  'exits 10 when the tagged commit package version drifts from HEAD even though the tag name matches';

function runAuditWithAppendedEntry(entry) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-anchor-truncation-'));
  try {
    const fixturePath = path.join(tmpDir, 'CLAUDE.md');
    const source = fs.readFileSync(path.join(EXTENSION_ROOT, 'CLAUDE.md'), 'utf8');
    fs.writeFileSync(fixturePath, `${source}\n${entry}\n`);
    return spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, CLAUDE_PATH_OVERRIDE: fixturePath },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('AP-BIN-ITER3-01: a space-truncated ENFORCE anchor fails the audit instead of resolving against its siblings', () => {
  // Non-vacuity: the probe anchor's FIRST token must be shared by other cases in the
  // target file, or a truncated parse would still identify one test and this arm would
  // pass for the wrong reason.
  const targetSource = fs.readFileSync(
    path.join(EXTENSION_ROOT, 'tests', 'release-gate.test.js'),
    'utf8',
  );
  const firstToken = TRUNCATION_PROBE_ANCHOR.split(' ')[0];
  const siblings = [...targetSource.matchAll(/\btest\s*\(\s*'([^']*)'/g)]
    .map((m) => m[1])
    .filter((name) => name.startsWith(`${firstToken} `));
  assert.ok(
    siblings.length > 1,
    `probe is vacuous: only ${siblings.length} case(s) in release-gate.test.js start with "${firstToken} "`,
  );
  assert.ok(
    siblings.includes(TRUNCATION_PROBE_ANCHOR),
    'probe anchor no longer names a live release-gate.test.js case',
  );

  const result = runAuditWithAppendedEntry(
    '- probe-truncated — INVARIANT: probe. BREAKS: probe. '
      + `ENFORCE: extension/tests/release-gate.test.js#${TRUNCATION_PROBE_ANCHOR}. `
      + 'PATTERN_SHAPE: probe.',
  );

  assert.notEqual(result.status, 0, `audit should fail on a truncated anchor; stdout: ${result.stdout}`);
  assert.match(result.stderr, /is space-truncated from/, `stderr: ${result.stderr}`);
});

test('AP-BIN-ITER3-01: the hyphenated repair of that same anchor passes, so the arm is not a blanket rejection', () => {
  const hyphenated = TRUNCATION_PROBE_ANCHOR.replace(/ /g, '-');
  const result = runAuditWithAppendedEntry(
    '- probe-hyphenated — INVARIANT: probe. BREAKS: probe. '
      + `ENFORCE: extension/tests/release-gate.test.js#${hyphenated}. `
      + 'PATTERN_SHAPE: probe.',
  );

  assert.equal(result.status, 0, `hyphenated anchor should pass; stderr: ${result.stderr}`);
});

test('AP-BIN-ITER3-01: commentary after an anchor is not read as truncated anchor text', () => {
  // The live catalogs write `#ANCHOR (prose about the cases)`. That prose is not part of
  // the test name, and the arm must not demand it be slugged into the anchor — the
  // exclusion is structural (a parenthetical is not `<one space><alphanumeric>`), so pin
  // it here rather than leaving it to be re-derived.
  const result = runAuditWithAppendedEntry(
    '- probe-commentary — INVARIANT: probe. BREAKS: probe. '
      + `ENFORCE: extension/tests/release-gate.test.js#${TRUNCATION_PROBE_ANCHOR.replace(/ /g, '-')} `
      + '(exercises the drifted-tag arm). PATTERN_SHAPE: probe.',
  );

  assert.equal(result.status, 0, `commentary must not trip the arm; stderr: ${result.stderr}`);
});

// A backticked git object name is a COMMIT citation, not a claim that a symbol is live.
// The catalogs cite commits in backticks throughout and an all-hex span satisfies
// BARE_IDENTIFIER_RE, so before the shape exclusion the corpus was asked whether a
// COMMIT was live code. Both tiers were reachable and one was live: `aceb54d7` (cited by
// metrics-utils.ts, so it resolves in COMMENT text) sat permanently in the prose-only
// advisory, and a sha spelled nowhere in the tree failed the gate outright -- a
// release-gate red over a commit reference. CLAUSE_TERMINATORS already carries
// TICKET_TRACEABILITY for this reason, but that excludes one LABEL, not the shape.
//
// Every probe token is ASSEMBLED at runtime and never spelled whole in this file. The
// corpus is the tree, this file is in the tree, and a literal probe would resolve itself
// -- the first draft of these cases did exactly that and passed for the wrong reason.
const SHA_PROBE = ['dead', 'beef', '99'].join('');
const ABSENT_SYMBOL_PROBE = ['zzNoSuch', 'Anchor', 'Probe'].join('');
const SUB_FLOOR_HEX_PROBE = ['fac', 'ade'].join('');
const RESOLVING_ANCHOR = TRUNCATION_PROBE_ANCHOR.replace(/ /g, '-');

function auditWithInvariantToken(token) {
  return runAuditWithAppendedEntry(
    `- probe-object-name — INVARIANT: introduced in \`${token}\`, the probe holds. `
      + 'BREAKS: probe. '
      + `ENFORCE: extension/tests/release-gate.test.js#${RESOLVING_ANCHOR}. `
      + 'PATTERN_SHAPE: probe.',
  );
}

function assertTokenAbsentFromTree(token) {
  const found = spawnSync('git', ['grep', '-cw', token], {
    cwd: path.resolve(EXTENSION_ROOT, '..'),
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.notEqual(found.status, 0, `probe token must not appear in the tree: ${found.stdout}`);
}

test('a backticked commit sha inside an INVARIANT clause is not read as a symbol claim', () => {
  assertTokenAbsentFromTree(SHA_PROBE);

  const result = auditWithInvariantToken(SHA_PROBE);
  assert.equal(result.status, 0, `a commit citation must not fail the audit; stderr: ${result.stderr}`);
  assert.doesNotMatch(result.stderr, new RegExp(SHA_PROBE), `stderr: ${result.stderr}`);
});

test('a non-hex identifier in that same position still fails, so the exclusion is not a blanket pass', () => {
  assertTokenAbsentFromTree(ABSENT_SYMBOL_PROBE);

  const result = auditWithInvariantToken(ABSENT_SYMBOL_PROBE);
  assert.notEqual(result.status, 0, `an absent symbol must still fail; stdout: ${result.stdout}`);
  assert.match(
    result.stderr,
    new RegExp(`names a symbol absent from the tree: ${ABSENT_SYMBOL_PROBE}`),
    `stderr: ${result.stderr}`,
  );
});

test('a hex token below git\'s 7-char abbreviation floor is still judged as a symbol', () => {
  // The floor is load-bearing: without it the exclusion would swallow short all-hex
  // identifiers, which are ordinary symbol claims rather than object names.
  assertTokenAbsentFromTree(SUB_FLOOR_HEX_PROBE);

  const result = auditWithInvariantToken(SUB_FLOOR_HEX_PROBE);
  assert.notEqual(result.status, 0, `a sub-floor hex token must still be judged; stdout: ${result.stdout}`);
  assert.match(
    result.stderr,
    new RegExp(`names a symbol absent from the tree: ${SUB_FLOOR_HEX_PROBE}`),
    `stderr: ${result.stderr}`,
  );
});

// A catalog root the walk cannot ENTER used to drop every subsystem CLAUDE.md beneath
// it while the verdict line still reported `verified` over the readable roots and exited
// 0 -- perCatalog counts what the walk FOUND, and nothing invalidated it. Measured on
// the shipped script before the fix: 649 ENFORCE refs across 8 catalogs collapsed to 331
// across 3, silently. Both `discoverCatalogs` copies (the ENFORCE arm and the INVARIANT
// arm) carried the same swallow, so both are exercised here through the one run.
function runAuditWithSubsystemRoot(rootMode) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-trap-door-root-'));
  const root = path.join(tmpDir, 'catalog-root');
  fs.mkdirSync(root);
  // A real catalog beneath the root: what a dark root silently drops must be something
  // the sweep would otherwise have HAD to read, or the row measures nothing.
  fs.mkdirSync(path.join(root, 'services'));
  fs.writeFileSync(
    path.join(root, 'services', 'CLAUDE.md'),
    '- `x.ts` — INVARIANT: `buildSymbolCorpus` is the anchor.\n'
  );

  try {
    fs.chmodSync(root, rootMode);
    if (rootMode === 0o000) {
      // chmod 000 does not stop uid 0, so under root this fixture would assert over a
      // readable directory and pass vacuously. Detect that here rather than measure it.
      try {
        fs.readdirSync(root);
        return { vacuous: true };
      } catch {
        /* unreadable as intended */
      }
    }

    const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, SUBSYSTEM_CATALOG_ROOT_OVERRIDE: root },
    });
    return { vacuous: false, result };
  } finally {
    fs.chmodSync(root, 0o755);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const CENSUS_VERDICT_RE = /(?:reference|symbol)\(s\) verified across/;

test('SZ-CATROOT-01: an unreadable catalog root fails the audit instead of reporting a verified census over the roots it could read', (t) => {
  const { vacuous, result } = runAuditWithSubsystemRoot(0o000);
  if (vacuous) {
    t.skip('running as a user that ignores mode 000 (uid 0) — the dark root is readable, so this row cannot measure');
    return;
  }

  assert.notEqual(result.status, 0, `a catalog root the walk cannot enter must red the audit; stdout: ${result.stdout}`);
  assert.match(
    result.stderr,
    /unreadable catalog root -- every subsystem CLAUDE\.md beneath it would go unswept/,
    `the failure must name the unswept root as the cause; stderr: ${result.stderr}`
  );
  assert.doesNotMatch(
    result.stdout,
    CENSUS_VERDICT_RE,
    `no census may be reported as verified once an unknown number of catalogs went unswept; stdout: ${result.stdout}`
  );
});

test('SZ-CATROOT-01: a readable but empty catalog root still passes, so the unreadable-root failure is not a blanket red', () => {
  const { result } = runAuditWithSubsystemRoot(0o755);

  assert.equal(result.status, 0, `an empty catalog root is not a failure; stderr: ${result.stderr}`);
  assert.match(
    result.stdout,
    CENSUS_VERDICT_RE,
    `a readable root must still produce a census verdict; stdout: ${result.stdout}`
  );
});

// AP-EXT-ITER39-02: `discoverCatalogs` enumerates a seed plus exactly ONE directory level
// under each root, and nothing compared that shape against the catalogs actually on disk —
// so the sweep's own "cannot drift behind the catalogs it verifies" comment was a claim no
// check made true. Measured on the pre-fix script with the fixture below: the nested
// catalog was never opened and the run printed `verified across N catalog(s)` and exited 0.
//
// The fixture's two catalogs carry the SAME clause, differing only in depth, so the row
// isolates depth as the variable — the nested one cannot red for any reason the swept one
// would not also red for.
const CATALOG_CLAUSE = '- `x.ts` — INVARIANT: `buildSymbolCorpus` is the anchor.\n';

function runAuditWithNestedCatalog(nestedContent) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-trap-door-depth-'));
  const root = path.join(tmpDir, 'catalog-root');
  fs.mkdirSync(path.join(root, 'alpha', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'alpha', 'CLAUDE.md'), CATALOG_CLAUSE);
  if (nestedContent !== null) {
    fs.writeFileSync(path.join(root, 'alpha', 'nested', 'CLAUDE.md'), nestedContent);
  }

  try {
    return spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
      cwd: EXTENSION_ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, SUBSYSTEM_CATALOG_ROOT_OVERRIDE: root },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('AP-EXT-ITER39-02: a trap-door catalog deeper than the sweep enumerates reds the audit instead of being silently uncounted', () => {
  const result = runAuditWithNestedCatalog(CATALOG_CLAUSE);

  assert.notEqual(
    result.status,
    0,
    `a CLAUDE.md carrying trap-door clauses that the sweep never opens must red; stdout: ${result.stdout}`
  );
  assert.match(
    result.stderr,
    /nested\/CLAUDE\.md: carries trap-door clauses but is outside the swept set/,
    `the failure must name the uncounted catalog; stderr: ${result.stderr}`
  );
  assert.doesNotMatch(
    result.stdout,
    CENSUS_VERDICT_RE,
    `no census may be reported as verified while a trap-door catalog went unopened; stdout: ${result.stdout}`
  );
});

test('AP-EXT-ITER39-02: the same catalog at the depth the sweep does enumerate passes, so the depth check is not a blanket red', () => {
  const result = runAuditWithNestedCatalog(null);

  assert.equal(result.status, 0, `a catalog at an enumerated depth is not a failure; stderr: ${result.stderr}`);
  assert.match(
    result.stdout,
    CENSUS_VERDICT_RE,
    `the swept catalog must still produce a census verdict; stdout: ${result.stdout}`
  );
});

test('AP-EXT-ITER39-02: an unenumerated CLAUDE.md carrying no trap-door clause passes, so the obligation is derived from content and needs no path exception list', () => {
  const result = runAuditWithNestedCatalog('# notes\n\nProse only, no trap doors.\n');

  assert.equal(
    result.status,
    0,
    `only a catalog carrying INVARIANT/ENFORCE/PATTERN_SHAPE is owed a sweep; stderr: ${result.stderr}`
  );
  assert.match(
    result.stdout,
    CENSUS_VERDICT_RE,
    `a clause-free file outside the swept set must not suppress the census; stdout: ${result.stdout}`
  );
});

// ---------------------------------------------------------------------------
// AC-M4 census arm — every external tool the audit reaches has an existence check.
//
// The defect this closes is not one missing guard, it is that the set of tools was tracked
// by hand. The script carried a comment naming its dependencies; a `grep` call had been in
// the file for three months when that comment was written, and the comment did not mention
// it. A list nobody re-derives is wrong from the moment the next call lands, and it is wrong
// silently, because an unlisted tool looks exactly like a tool that is not used.
//
// So the set is DERIVED from the script on every run and compared with the word list the
// preflight iterates. Adding a call to a new binary without listing it reds this arm.
//
// Honest limit, the same one audit-unprovisioned-binary-spawns.mjs states: only a STRING
// LITERAL first argument is in contract. The `rg` call site passes a variable, so the
// derivation cannot see it -- which is exactly why KNOWN_TOOL_FLOOR below is also asserted.
// The derivation catches what arrives later; the floor pins what was measured by hand here.
// ---------------------------------------------------------------------------

const AUDIT_SCRIPT_PATH = path.join(EXTENSION_ROOT, 'scripts', 'audit-trap-door-enforcement.sh');

// Measured by reading the script at the time this arm was written. `rg` is a member despite
// being invisible to the derivation, so dropping it from the preflight cannot pass unnoticed.
const KNOWN_TOOL_FLOOR = ['bash', 'git', 'grep', 'node', 'rg'];

/** Split the script into its bash-level text and the bodies of its node heredocs. */
function segmentScript(sourceText) {
  const bash = [];
  const heredoc = [];
  let openTag = null;
  for (const line of sourceText.split('\n')) {
    if (openTag === null) {
      bash.push(line);
      const opener = line.match(/<<'?([A-Z_]+)'?\s*$/);
      if (opener) openTag = opener[1];
    } else if (line.trim() === openTag) {
      // The terminator is a delimiter, not a line of bash. Keeping it out of the bash text
      // is what stops the tag itself from being read as a command in command position.
      openTag = null;
    } else {
      heredoc.push(line);
    }
  }
  return { bashText: bash.join('\n'), heredocText: heredoc.join('\n') };
}

/**
 * Classifies every candidate word in ONE shell, rather than one spawn per word. `type -t`
 * is the shell's own answer to "is this a builtin, a keyword, or a program on PATH", so the
 * derivation agrees with the thing that will actually run the script.
 *
 * `type -t` alone is not enough, because PATH lookup asks the FILESYSTEM, and the default
 * macOS filesystem answers case-insensitively: `type -t NODE` reports `file` here and
 * resolves to the real node binary, while on Linux it reports nothing. Left uncorrected the
 * derivation would mean two different things on the two platforms this repo gates on.
 *
 * Comparing against the resolved path does not settle it either -- the resolver echoes the
 * spelling it was asked about, so its basename always matches. The on-disk directory entry
 * is the only case-sensitive answer available, so a word counts as external only when the
 * containing directory really lists a file spelled exactly that way.
 */
function classifyWords(words) {
  const unique = [...new Set(words)];
  if (unique.length === 0) return new Map();
  const probe = spawnSync(
    'bash',
    [
      '-c',
      'for w in "$@"; do k="$(type -t "$w" 2>/dev/null || echo none)"; ' +
        'if [ "$k" = file ]; then p="$(command -v "$w")"; ' +
        'ls -1 "${p%/*}" 2>/dev/null | grep -qxF "${p##*/}" || k=none; fi; ' +
        'printf "%s %s\\n" "$w" "$k"; done',
      '_',
      ...unique,
    ],
    { encoding: 'utf8', timeout: 60_000 }
  );
  assert.equal(probe.status, 0, `word classification probe failed: ${probe.stderr}`);
  const kinds = new Map();
  for (const row of probe.stdout.split('\n')) {
    const [word, kind] = row.trim().split(/\s+/);
    if (word) kinds.set(word, kind || 'none');
  }
  return kinds;
}

/** The census, as code: external tools reached from the script's own text. */
function deriveExternalTools(sourceText) {
  const { bashText, heredocText } = segmentScript(sourceText);

  // Command position: line start, or after a substitution/pipe/separator/control word.
  const commandPosition = /(?:^|\$\(|`|\||;|&&|!\s|\bthen\b|\bdo\b|\belse\b|\bif\b)\s*([A-Za-z_][A-Za-z0-9_.-]*)/gm;
  const candidates = [];
  for (const line of bashText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    for (const hit of line.matchAll(commandPosition)) candidates.push(hit[1]);
  }
  const kinds = classifyWords(candidates);
  const tools = new Set(candidates.filter((word) => kinds.get(word) === 'file'));

  // Matched over WHOLE heredoc content, never line by line: these calls wrap across lines,
  // and a line-based scan would miss the very shape it exists to find.
  const spawnCall = /(?:execFileSync|spawnSync|execSync|execFile|spawn)\s*\(\s*'([A-Za-z0-9_.-]+)'/g;
  for (const hit of heredocText.matchAll(spawnCall)) tools.add(hit[1]);

  return tools;
}

/** The word list the preflight loop iterates. */
function readPreflightTools(sourceText) {
  const loop = sourceText.match(/for\s+_tool\s+in\s+([^;]+);\s*do/);
  assert.ok(loop, 'preflight loop not found in audit-trap-door-enforcement.sh');
  return new Set(loop[1].trim().split(/\s+/));
}

test('AC-M4 census: every external tool derived from the audit script is covered by its preflight', () => {
  const source = fs.readFileSync(AUDIT_SCRIPT_PATH, 'utf8');
  const derived = deriveExternalTools(source);
  const preflight = readPreflightTools(source);

  // A derivation that found nothing would satisfy the subset check vacuously. The first
  // census taken for this ticket did exactly that -- it read only the first token of each
  // line and so never saw the tool inside a command substitution.
  assert.ok(
    derived.size >= 3,
    `derivation found ${derived.size} tools; a near-empty census means the parser broke, not that the script grew simple`
  );

  const uncovered = [...derived].filter((tool) => !preflight.has(tool));
  assert.deepEqual(
    uncovered,
    [],
    `these external tools are invoked with no existence check: ${uncovered.join(', ')}`
  );

  const missingFloor = KNOWN_TOOL_FLOOR.filter((tool) => !preflight.has(tool));
  assert.deepEqual(
    missingFloor,
    [],
    `preflight dropped a tool the script is known to use: ${missingFloor.join(', ')}`
  );
});

test('AC-M4 census: the derivation reports a newly introduced tool that the preflight does not list', () => {
  const source = fs.readFileSync(AUDIT_SCRIPT_PATH, 'utf8');

  // Negative control. Without it the arm above could pass forever on a parser that matches
  // nothing. A name no workflow provisions and no tool list mentions is used deliberately,
  // so the control cannot be satisfied by an unrelated allowlist.
  const injected = source.replace(
    "const { spawnSync } = require('child_process');",
    "const { spawnSync } = require('child_process');\nexecFileSync('zzunprovisionedtool', ['--version']);"
  );
  assert.notEqual(injected, source, 'injection point not found; the control would measure nothing');

  const derived = deriveExternalTools(injected);
  assert.ok(
    derived.has('zzunprovisionedtool'),
    `derivation missed an injected tool call; it cannot detect a real one either (found: ${[...derived].join(', ')})`
  );

  const preflight = readPreflightTools(injected);
  assert.ok(
    !preflight.has('zzunprovisionedtool'),
    'precondition: the injected tool must be absent from the preflight list'
  );
});

/**
 * Runs the audit with one binary made unresolvable, asserting first that everything ELSE
 * still resolves. Without that precondition a failed spawn grades as a passing assertion:
 * an earlier version of the `rg` case deleted the whole directory that resolved it, which
 * on Linux is /usr/bin with /bin symlinked to it, so `bash` itself went missing, the audit
 * was never spawned, and every assertion below graded the failed spawn rather than a
 * verdict. The survivors span several directories so that regression reports "bash no
 * longer resolves" instead of passing the precondition for the wrong reason.
 */
function runAuditWithBinaryAbsent(bin) {
  const filteredPath = simulateBinaryAbsent(process.env.PATH || '', bin);

  for (const survivor of ['bash', 'env', 'git', 'node'].filter((s) => s !== bin)) {
    const probe = spawnSync('bash', ['-c', `command -v ${survivor}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: filteredPath },
      timeout: 30_000,
    });
    assert.equal(
      probe.status,
      0,
      `${survivor} must still resolve with ${bin} absent (got exit ${probe.status}); otherwise this measures a failed spawn, not the audit`
    );
  }

  const which = spawnSync('bash', ['-c', `command -v ${bin}`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: filteredPath },
    timeout: 30_000,
  });
  assert.notEqual(which.status, 0, `precondition: ${bin} must be unresolvable under the filtered PATH`);

  return spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: filteredPath },
    timeout: 60_000,
  });
}

// `rg` is the tool the beta.21 CI log actually caught going missing, and it is the one
// whose call site keeps its own detectMissingTools guard. It rides the same table as the
// others because the observable is identical: fail, name the tool, print no verified check.
for (const bin of ['grep', 'git', 'rg']) {
  test(`audit-trap-door-enforcement fails closed when ${bin} is absent from PATH (never reports OK)`, () => {
    const result = runAuditWithBinaryAbsent(bin);

    assert.notEqual(
      result.status,
      0,
      `audit must FAIL when ${bin} is unrunnable, got exit ${result.status}; stderr: ${result.stderr}`
    );
    assert.match(
      result.stderr,
      new RegExp(`tool not installed: ${bin}`),
      `stderr must name the unrunnable tool, got: ${result.stderr}`
    );
    assert.doesNotMatch(
      result.stderr,
      /command not found/,
      `a raw shell "command not found" leak means a check no-oped instead of failing closed: ${result.stderr}`
    );
    assert.doesNotMatch(
      result.stdout,
      /verified|OK/,
      `an audit that could not run must not report a verified check: ${result.stdout}`
    );
  });
}
