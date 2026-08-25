// @tier: fast
// Ticket 984a768c: well-formedness assertions over the honest 18-sha did-we-count corpus.
// Ticket 60f75491 (AC-2'): firing positive-control assertions for 2c857117 — see below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS, DETECTABLE_CEILING } from '../services/did-we-count-corpus.js';
import {
  replayCorpus,
  buildAstCheckRegistry,
  extractEnclosingFunctionSnippet,
  ruleFiresOnSnippet,
} from '../bin/did-we-count-replay.js';

const VALID_BUCKETS = new Set(['detectable', 'semantic', 'out-of-reach']);
const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CORPUS has exactly 18 entries', () => {
  assert.equal(CORPUS.length, 18);
});

test('every entry has a valid bucket literal', () => {
  for (const entry of CORPUS) {
    assert.ok(VALID_BUCKETS.has(entry.bucket), `${entry.sha} has invalid bucket ${entry.bucket}`);
  }
});

test('every entry has a non-empty reason', () => {
  for (const entry of CORPUS) {
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.trim().length > 0, `${entry.sha} has an empty reason`);
  }
});

test('no sha appears twice', () => {
  const shas = CORPUS.map((entry) => entry.sha);
  assert.equal(new Set(shas).size, shas.length);
});

test('detectable count matches DETECTABLE_CEILING', () => {
  const detectable = CORPUS.filter((entry) => entry.bucket === 'detectable');
  assert.equal(detectable.length, DETECTABLE_CEILING);
});

test('2c857117 is present as a positive control, not an exemption', () => {
  const entry = CORPUS.find((e) => e.sha === '2c857117');
  assert.ok(entry, '2c857117 must be present in CORPUS');
  assert.equal(entry.bucket, 'out-of-reach');
  assert.equal(entry.positive_control, true);
  assert.equal(entry.expect_fire_on_parent, true);
  assert.equal(entry.expect_fire_on_fix, true);
});

// AC-2' (ticket 60f75491): a positive control is only real if something actually probes it.
// The metadata test above asserts the CORPUS entry's shape but never reads the source files it
// describes. These two tests probe both documented arms of the 2c857117 defect directly and
// assert the check FIRES (the pattern is found) — a firing positive control is the CORRECT,
// passing outcome, because the defect is genuinely still live at HEAD. If either arm is ever
// actually fixed, the corresponding assertion below MUST fail loudly so a human re-dispositions
// the did-we-count-corpus.ts entry — it must never silently pass over a genuine fix.

test("2c857117 positive control FIRES: pickle-utils.ts process-identity arm is live at HEAD", () => {
  const filePath = path.join(EXTENSION_ROOT, 'src', 'services', 'pickle-utils.ts');
  const source = fs.readFileSync(filePath, 'utf8');
  assert.ok(
    source.includes('const oldPid = s.monitor_pid;'),
    'src/services/pickle-utils.ts no longer contains "const oldPid = s.monitor_pid;". ' +
      'If this arm of the 2c857117 process-identity defect was genuinely fixed, re-dispose the ' +
      'did-we-count-corpus.ts entry for 2c857117 — do not flip expect_fire_on_fix to false ' +
      'without also verifying the mux-runner.ts arm below.',
  );
});

test("2c857117 positive control FIRES: mux-runner.ts process-identity arm is live at HEAD", () => {
  const filePath = path.join(EXTENSION_ROOT, 'src', 'bin', 'mux-runner.ts');
  const source = fs.readFileSync(filePath, 'utf8');
  assert.ok(
    source.includes("suspects.set(pidFromFile, 'from-pidfile');"),
    'src/bin/mux-runner.ts no longer contains "suspects.set(pidFromFile, \'from-pidfile\');". ' +
      'If this arm of the 2c857117 process-identity defect was genuinely fixed, re-dispose the ' +
      'did-we-count-corpus.ts entry for 2c857117 — do not flip expect_fire_on_fix to false ' +
      'without also verifying the pickle-utils.ts arm above.',
  );
});

// Ticket 7b4f5d60 (d7c017ff's 4 landed rules, wired into the replay): the honest partition
// after wiring. Exactly the 7 detectable shas the 4 rules actually cover replay `pass`; the
// other 2 detectable shas (process-identity membership/identity defects no landed rule
// reaches) stay `no-check-yet`, and NO semantic or out-of-reach sha is ever given a check —
// widening either would be the "stretch a matcher" move this ticket is forbidden from making.
test('replay wiring: exactly the 7 rule-covered detectable shas pass, everything else stays no-check-yet', () => {
  const results = replayCorpus(CORPUS, buildAstCheckRegistry());
  const bySha = new Map(results.map((r) => [r.sha, r]));

  const expectedPass = new Set(['7e06e8b2', 'e2804228', 'd24cec5e', 'c7c85ef3', '0cf3b8e3', 'ff8d4739', '41b9b255']);

  for (const sha of expectedPass) {
    assert.equal(bySha.get(sha)?.status, 'pass', `${sha} must replay as pass (fires on parent, not on fix)`);
  }
  for (const entry of CORPUS) {
    if (expectedPass.has(entry.sha)) continue;
    assert.equal(
      bySha.get(entry.sha)?.status,
      'no-check-yet',
      `${entry.sha} (${entry.bucket}) must never replay as pass or fail without a real registered check`,
    );
  }

  const passCount = results.filter((r) => r.status === 'pass').length;
  const failCount = results.filter((r) => r.status === 'fail').length;
  assert.equal(passCount, 7, 'exactly 7 of 18 shas are replayed today — never stretch this number');
  assert.equal(failCount, 0);
});

// ===========================================================================
// AP-EXT-ITER61-01 regression: the replay harness must never report an UNMEASURED
// rule as "did not fire". `Linter.verify()` answers a parse failure with a single
// `fatal` message carrying `ruleId: null`, which a bare
// `.some(m => m.ruleId === ruleId)` reads as `false` — and because every AST check
// expects `expect_fire_on_fix: false`, that silent `false` satisfies the fix-side
// arm of the oracle having linted nothing. This is the did-we-count defect class
// inside the did-we-count harness itself.
//
// The flow traced end to end below is the real one:
//   historical file content
//     -> extractEnclosingFunctionSnippet()   (can emit an unparseable snippet:
//        a ts.isMethodDeclaration hit is returned bare, and `foo() { ... }` is
//        not a standalone statement)
//     -> ruleFiresOnSnippet()                (must refuse to answer, not say false)
// ===========================================================================

// `audit-subprocess-heavy-tests-missing-timeout.mjs` scans this file's SOURCE TEXT
// for `spawnSync(`, so spelling the call inline inside these fixture strings would
// register four phantom un-baselined callsites. The snippets below are lint fixture
// INPUT, never executed here — building the callee from this constant keeps the
// linted snippet byte-identical while leaving the audit nothing to match.
const CAPTURE = 'spawnSync';

test('AP-EXT-ITER61-01: extractEnclosingFunctionSnippet emits an unparseable snippet for a class method', () => {
  const source = [
    'class Runner {',
    '  runIt(args) {',
    `    return ${CAPTURE}('git', args, { encoding: 'utf-8' });`,
    '  }',
    '}',
  ].join('\n');

  const snippet = extractEnclosingFunctionSnippet(source, "spawnSync('git', args");

  assert.equal(
    snippet.startsWith('runIt(args)'),
    true,
    'a method declaration is returned bare — the arrow/function-expression wrap does not cover it',
  );
  assert.equal(
    snippet.includes('class '),
    false,
    'the bare method body is NOT wrapped in a class, which is what makes it unparseable as a module',
  );
});

test('AP-EXT-ITER61-01: ruleFiresOnSnippet throws on an unparseable snippet instead of answering false', () => {
  const source = [
    'class Runner {',
    '  runIt(args) {',
    `    return ${CAPTURE}('git', args, { encoding: 'utf-8' });`,
    '  }',
    '}',
  ].join('\n');

  const unparseable = extractEnclosingFunctionSnippet(source, "spawnSync('git', args");

  assert.throws(
    () => ruleFiresOnSnippet('pickle/require-max-buffer-on-capture', unparseable),
    (err) => {
      assert.match(err.message, /did not parse/);
      assert.match(err.message, /never measured/);
      return true;
    },
    'an unparsed snippet must surface as a thrown cannot-measure, never as a quiet "did not fire" that ' +
      'vacuously satisfies expect_fire_on_fix: false',
  );
});

test('AP-EXT-ITER61-01: a parseable snippet still reports both arms of the rule honestly', () => {
  const firing = [
    'function runIt() {',
    `  return ${CAPTURE}('git', ['ls-files'], { encoding: 'utf-8' });`,
    '}',
  ].join('\n');
  const fixed = [
    'function runIt() {',
    `  return ${CAPTURE}('git', ['ls-files'], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });`,
    '}',
  ].join('\n');

  assert.equal(
    ruleFiresOnSnippet('pickle/require-max-buffer-on-capture', firing),
    true,
    'the defective shape must still fire — the throw must not have swallowed the firing path',
  );
  assert.equal(
    ruleFiresOnSnippet('pickle/require-max-buffer-on-capture', fixed),
    false,
    'the fixed shape must still report a genuine, measured false',
  );
});
