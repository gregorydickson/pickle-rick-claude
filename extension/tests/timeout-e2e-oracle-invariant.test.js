// @tier: fast
/**
 * Ticket bb01af94 — durable oracle: timeout-e2e's two tests cannot be skipped, todo'd, or
 * dropped from the serial manifest.
 *
 * AC-7 of prds/BUG-2026-08-18-timeout-e2e-serial-tier-red.md relied on `git diff --stat`,
 * which prints only changed-line counts and passes vacuously if the two tests are deleted
 * and replaced by one (or quarantined via test.skip/test.todo, which still leaves two
 * `test(` occurrences). This file is the durable, in-suite replacement: it reads the fixture
 * and the serial manifest off disk on every fast-tier run and fails loud if any of the four
 * invariants below breaks, independent of any one worker's memory or a one-shot grep.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_E2E_PATH = path.resolve(__dirname, 'integration/timeout-e2e.test.js');
const SERIAL_MANIFEST_PATH = path.resolve(__dirname, 'integration/.serial-tests.json');
const SERIAL_MANIFEST_ENTRY = 'tests/integration/timeout-e2e.test.js';

/** Top-level `test(` declarations — anchored at line start so nested `.skip(`/`.todo(` calls on the same identifier never match. */
function countTopLevelTestDeclarations(sourceText) {
  const matches = sourceText.match(/^test\(/gm);
  return matches ? matches.length : 0;
}

/** True if the source carries any skip/todo modifier, in either call form or options-object form. */
function hasSkipOrTodoModifier(sourceText) {
  return /test\.skip\(|test\.todo\(|\{\s*skip\s*:|\{\s*todo\s*:/.test(sourceText);
}

/** Body text of each top-level `test(...)` declaration, split at declaration boundaries. */
function splitTestBodies(sourceText) {
  const starts = [];
  const re = /^test\(/gm;
  let m;
  while ((m = re.exec(sourceText))) {
    starts.push(m.index);
  }
  return starts.map((start, i) => sourceText.slice(start, i + 1 < starts.length ? starts[i + 1] : sourceText.length));
}

/** True when every one of the given test bodies contains at least one `assert.` call. */
function everyBodyAsserts(bodies) {
  return bodies.length > 0 && bodies.every((body) => /assert\./.test(body));
}

function fileEntryListed(manifestText, entry) {
  return JSON.parse(manifestText).entries.includes(entry);
}

const FIXTURE_SOURCE = fs.readFileSync(TIMEOUT_E2E_PATH, 'utf-8');
const MANIFEST_SOURCE = fs.readFileSync(SERIAL_MANIFEST_PATH, 'utf-8');

test('bb01af94 invariant 1: timeout-e2e.test.js declares exactly 2 top-level test(...)s', () => {
  assert.equal(
    countTopLevelTestDeclarations(FIXTURE_SOURCE),
    2,
    'ticket bb01af94: extension/tests/integration/timeout-e2e.test.js must declare exactly 2 '
    + 'top-level test(...)s — this fixture guards the AC-7 fake-green class where the two tests '
    + 'are silently deleted or merged into one and a git-diff-stat oracle passes vacuously',
  );
});

test('bb01af94 invariant 2: timeout-e2e.test.js has no skip/todo modifier', () => {
  assert.equal(
    hasSkipOrTodoModifier(FIXTURE_SOURCE),
    false,
    'ticket bb01af94: extension/tests/integration/timeout-e2e.test.js must not carry '
    + 'test.skip(...), test.todo(...), { skip: ... } or { todo: ... } — a quarantined test still '
    + 'has 2 `test(` occurrences and the count-only oracle above would miss it',
  );
});

test('bb01af94 invariant 3: neither timeout-e2e test body is empty', () => {
  const bodies = splitTestBodies(FIXTURE_SOURCE);
  assert.equal(bodies.length, 2, 'expected exactly 2 test bodies to check — see invariant 1');
  assert.equal(
    everyBodyAsserts(bodies),
    true,
    'ticket bb01af94: both timeout-e2e tests must contain at least one assert. call each — a '
    + 'gutted body (declaration kept, assertions dropped) is a silent quarantine that preserves '
    + 'the `test(` count',
  );
});

test('bb01af94 invariant 4: timeout-e2e.test.js stays in the serial manifest', () => {
  assert.equal(
    fileEntryListed(MANIFEST_SOURCE, SERIAL_MANIFEST_ENTRY),
    true,
    `ticket bb01af94: extension/tests/integration/.serial-tests.json must list `
    + `"${SERIAL_MANIFEST_ENTRY}" — dropping it lets the fixture run at --test-concurrency=8, `
    + 're-opening the load-dependent-timeout class this ticket protects against',
  );
});

// AC-2 mutation check, executable rather than a one-shot hand mutation of the real fixture
// (this file's scope is read-only over extension/tests/integration/). Each helper is exercised
// against synthetic strings that reproduce the exact mutation the AC describes, proving the
// oracle actually reddens rather than passing vacuously.
test('bb01af94 mutation check: a test.skip on one test trips invariant 1 or 2', () => {
  const skipped = FIXTURE_SOURCE.replace(
    /^test\('timeout-e2e: manager runs 150% of worker_timeout_seconds unkilled, writes artifact'/m,
    "test.skip('timeout-e2e: manager runs 150% of worker_timeout_seconds unkilled, writes artifact'",
  );
  assert.notEqual(skipped, FIXTURE_SOURCE, 'mutation fixture setup failed to match the target test declaration');
  assert.equal(hasSkipOrTodoModifier(skipped), true, 'test.skip mutation must trip the skip/todo modifier check');
  assert.equal(
    countTopLevelTestDeclarations(skipped),
    1,
    'test.skip(...) no longer matches the ^test\\( anchor, so the mutated declaration count must drop below 2 — '
    + 'proving invariant 1 also catches this mutation independently of invariant 2',
  );
});

test('bb01af94 mutation check: a test.todo on one test trips invariant 1 or 2', () => {
  const todo = FIXTURE_SOURCE.replace(
    /^test\('timeout-e2e: session deactivated by subprocess → mux-runner exits cleanly'/m,
    "test.todo('timeout-e2e: session deactivated by subprocess → mux-runner exits cleanly'",
  );
  assert.notEqual(todo, FIXTURE_SOURCE, 'mutation fixture setup failed to match the target test declaration');
  assert.equal(hasSkipOrTodoModifier(todo), true, 'test.todo mutation must trip the skip/todo modifier check');
});

test('bb01af94 mutation check: an emptied test body trips invariant 3', () => {
  const bodies = splitTestBodies(FIXTURE_SOURCE);
  const gutted = bodies.map((body) => body.replace(/assert\.[^\n]*\n/g, ''));
  assert.equal(
    everyBodyAsserts(gutted),
    false,
    'stripping every assert. line from both bodies must trip the empty-body check',
  );
});

test('bb01af94 mutation check: removing the manifest entry trips invariant 4', () => {
  const manifest = JSON.parse(MANIFEST_SOURCE);
  const withoutEntry = JSON.stringify({
    ...manifest,
    entries: manifest.entries.filter((e) => e !== SERIAL_MANIFEST_ENTRY),
  });
  assert.equal(
    fileEntryListed(withoutEntry, SERIAL_MANIFEST_ENTRY),
    false,
    'removing the timeout-e2e entry from a copy of the manifest must trip the manifest-membership check',
  );
});
