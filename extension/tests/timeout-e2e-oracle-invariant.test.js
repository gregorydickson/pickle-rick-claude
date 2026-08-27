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
import * as ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_E2E_PATH = path.resolve(__dirname, 'integration/timeout-e2e.test.js');
const SERIAL_MANIFEST_PATH = path.resolve(__dirname, 'integration/.serial-tests.json');
const SERIAL_MANIFEST_ENTRY = 'tests/integration/timeout-e2e.test.js';

/**
 * Parse one JavaScript source text into a TypeScript SourceFile. Every check below resolves its
 * subject from this tree rather than from the source's line/column layout, because a guard that
 * locates a construct by WHERE IT SITS fabricates a violation the moment something else moves: a
 * `test(` at column 0 inside a template literal is text, not a declaration, and it is not an AST
 * node at all. `setParentNodes` (4th arg) is `true`, matching the sibling guard in
 * tests/ac6-operator-surface-guard.test.js.
 */
function parseSource(sourceText) {
  return ts.createSourceFile('timeout-e2e.test.js', sourceText, ts.ScriptTarget.Latest, true);
}

/**
 * Split a call's callee into `{ root, modifier }`: `test(...)` gives `{ root: 'test', modifier: null }`,
 * `test.skip(...)` gives `{ root: 'test', modifier: 'skip' }`, anything else gives `{ root: null }`.
 * This is the single place "is this a `test` call, and is it modified" is decided, so no check below
 * carries its own spelling of that question.
 */
function calleeRootName(expression) {
  if (ts.isIdentifier(expression)) {
    return { root: expression.text, modifier: null };
  }
  if (ts.isPropertyAccessExpression(expression)
      && ts.isIdentifier(expression.expression) && ts.isIdentifier(expression.name)) {
    return { root: expression.expression.text, modifier: expression.name.text };
  }
  return { root: null, modifier: null };
}

/** Every `test`-rooted CallExpression anywhere in the tree, with its modifier (`skip`/`todo`/`null`). */
function allTestCalls(sourceText) {
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const { root, modifier } = calleeRootName(node.expression);
      if (root === 'test') calls.push({ call: node, modifier });
    }
    ts.forEachChild(node, visit);
  }
  visit(parseSource(sourceText));
  return calls;
}

/** The unmodified top-level `test(...)` declarations — statements of the file, not lines of it. */
function topLevelTestDeclarations(sourceText) {
  return parseSource(sourceText).statements
    .filter(stmt => ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression))
    .map(stmt => ({ call: stmt.expression, ...calleeRootName(stmt.expression.expression) }))
    .filter(entry => entry.root === 'test' && entry.modifier === null);
}

function countTopLevelTestDeclarations(sourceText) {
  return topLevelTestDeclarations(sourceText).length;
}

/**
 * True if any `test` call carries a skip/todo modifier (`test.skip(...)`) or a skip/todo property in
 * its options object (`test('x', { skip: true }, fn)`). Both are read off the call itself, so an
 * unrelated `{ skip: false }` elsewhere in the file cannot fire it. No alternation of spellings is
 * maintained here: the previous 4-pattern regex was an enumerated set, and an enumerated set is
 * always one unlisted form away from the next silent bypass.
 */
function hasSkipOrTodoModifier(sourceText) {
  return allTestCalls(sourceText).some(({ call, modifier }) => {
    if (modifier === 'skip' || modifier === 'todo') return true;
    return call.arguments.some(arg => ts.isObjectLiteralExpression(arg)
      && arg.properties.some(prop => prop.name
        && (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))
        && (prop.name.text === 'skip' || prop.name.text === 'todo')));
  });
}

/**
 * Body source of each top-level `test(...)`: the callback node's own text, never a slice running from
 * one declaration's offset to the next (which swallowed anything sitting between them, and ran the
 * last body to end-of-file).
 */
function splitTestBodies(sourceText) {
  return topLevelTestDeclarations(sourceText).map(({ call }) => {
    const callback = [...call.arguments].reverse()
      .find(arg => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
    return callback ? callback.getText() : '';
  });
}

/** True when the body text contains a real `assert.*(...)` call, resolved as a call rooted at the `assert` identifier. */
function bodyHasAssertCall(bodyText) {
  let found = false;
  function visit(node) {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      let receiver = node.expression.expression;
      while (ts.isPropertyAccessExpression(receiver)) receiver = receiver.expression;
      if (ts.isIdentifier(receiver) && receiver.text === 'assert') found = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(parseSource(bodyText));
  return found;
}

/** True when every one of the given test bodies contains at least one `assert.` call. */
function everyBodyAsserts(bodies) {
  return bodies.length > 0 && bodies.every(bodyHasAssertCall);
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
    'test.skip(...) resolves to a modified callee, so it is not an unmodified declaration and the '
    + 'mutated count must drop below 2 — '
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

// ROOT-4 discrimination pins. The helpers above previously read this file's subject POSITIONALLY —
// `/^test\(/gm` (identity = column 0) and a 4-member skip/todo pattern alternation — and a positional
// reader matches things that are not the construct it claims to match. Both directions are pinned in
// one place so the fix cannot degrade into a blanket exclusion that blinds the oracle instead.

test('ROOT-4 true negative: a line-initial test( inside a template literal is not a declaration', () => {
  const source = [
    "test('the only real declaration', () => { assert.ok(1); });",
    'const fixtureScript = `',
    "test('this is fixture TEXT written by a fake-claude script, not a declaration', () => {})",
    '`;',
  ].join('\n');

  assert.equal(
    countTopLevelTestDeclarations(source),
    1,
    'a `test(` at column 0 inside a template literal is string content, not an AST declaration — '
    + 'counting it fabricates a violation exactly as the audit once reported RegExp.prototype.exec '
    + 'as a child_process.exec',
  );
});

test('ROOT-4 true negative: an unrelated { skip: ... } object is not a test modifier', () => {
  const source = [
    "test('a real, unskipped test', () => { assert.ok(1); });",
    'const retryOptions = { skip: false, todo: false };',
  ].join('\n');

  assert.equal(
    hasSkipOrTodoModifier(source),
    false,
    'skip/todo is read off the test call itself; an unrelated object literal that happens to carry '
    + 'those keys must not read as a quarantined test',
  );
});

test('ROOT-4 true positive: real declarations, modifiers, and the options form all still fire', () => {
  assert.equal(
    countTopLevelTestDeclarations(
      "test('one', () => { assert.ok(1); });\ntest('two', () => { assert.ok(1); });",
    ),
    2,
    'genuine top-level declarations must still be counted',
  );

  assert.equal(
    hasSkipOrTodoModifier("test.skip('quarantined', () => {});"),
    true,
    'test.skip(...) must still be detected',
  );
  assert.equal(
    hasSkipOrTodoModifier("test.todo('quarantined', () => {});"),
    true,
    'test.todo(...) must still be detected',
  );
  assert.equal(
    hasSkipOrTodoModifier("test('quarantined', { skip: true }, () => {});"),
    true,
    'the options-object form must still be detected',
  );
  assert.equal(
    hasSkipOrTodoModifier("test('quarantined', { 'skip': true }, () => {});"),
    true,
    "a string-literal key ({ 'skip': true }) is the same construct and must be detected too — "
    + 'the property NAME is resolved, not its spelling',
  );

  // Indentation is not identity either: a declaration nested in a describe() is still a modified
  // test call the oracle can see, so quarantining it cannot hide behind a column offset.
  assert.equal(
    hasSkipOrTodoModifier("describe('grp', () => {\n  test.skip('nested', () => {});\n});"),
    true,
    'a nested test.skip must be detected — the previous `^`-anchored reading only saw column 0',
  );
});

test('ROOT-4: a body is the callback node, not a slice running to the next declaration', () => {
  const source = [
    "test('first', () => { assert.ok(1); });",
    'function helperBetweenTests() { return assert.ok; }',
    "test('second', () => { assert.ok(2); });",
  ].join('\n');

  const bodies = splitTestBodies(source);

  assert.equal(bodies.length, 2);
  assert.ok(
    !bodies[0].includes('helperBetweenTests'),
    'the first body must not swallow the helper declared between the two tests — offset slicing did',
  );
});
