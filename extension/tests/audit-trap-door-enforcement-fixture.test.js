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

// AC-M4 / B-CIGREEN ROOT A: an unrunnable check (missing `rg`, or any absent tool)
// must FAIL, never print OK. beta.21 CI proved the opposite — `rg: command not
// found` on stderr, yet the audit exited 0. Simulate the exact CI condition (rg
// absent from PATH, everything else present) and assert the audit now fails
// closed with an explicit unrunnable reason instead of silently no-oping.
test('audit-trap-door-enforcement fails closed when rg is absent from PATH (never reports OK)', () => {
  const filteredPath = simulateBinaryAbsent(process.env.PATH || '', 'rg');

  // Only `rg` may go missing. The predecessor simulation deleted the whole directory that resolved
  // it, which on Linux is /usr/bin (with /bin symlinked to it) — so `bash` itself became
  // unresolvable, the audit was never spawned, and every assertion below graded a failed spawn
  // rather than the audit's verdict. Assert the survivors FIRST so that regression reports
  // "bash no longer resolves" instead of passing the rg precondition for the wrong reason.
  for (const bin of ['bash', 'env', 'git']) {
    const probe = spawnSync('bash', ['-c', `command -v ${bin}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: filteredPath },
      timeout: 30_000,
    });
    assert.equal(
      probe.status,
      0,
      `${bin} must still resolve under the simulated-absent PATH (got exit ${probe.status}); ` +
        'without it the audit never runs and this test measures nothing',
    );
  }

  const which = spawnSync('bash', ['-c', 'command -v rg'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: filteredPath },
    timeout: 30_000,
  });
  assert.notEqual(which.status, 0, 'precondition: rg must be unresolvable under the filtered PATH');

  const result = spawnSync('bash', ['scripts/audit-trap-door-enforcement.sh'], {
    cwd: EXTENSION_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: filteredPath },
    timeout: 60_000,
  });

  assert.notEqual(result.status, 0, `audit must FAIL when rg is unrunnable, got exit ${result.status}; stderr: ${result.stderr}`);
  assert.match(
    result.stderr,
    /tool not installed: rg/,
    `stderr must name the unrunnable reason, got: ${result.stderr}`
  );
  assert.doesNotMatch(
    result.stderr,
    /command not found/,
    `a raw shell "command not found" leak means the check no-oped instead of failing closed: ${result.stderr}`
  );
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
