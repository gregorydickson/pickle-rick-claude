// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExecutableAcceptanceAssertions } from '../bin/mux-runner.js';
import { buildWorkerPrompt } from '../bin/spawn-refinement-team.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

const PROSE_REMAINS_VALID_SENTINEL = 'Prose criteria remain fully valid and unguarded';
const WORKED_EXAMPLE_SENTINEL = 'Worked example:';
const EXPECTED_COMMAND = 'grep -c FIRSTCOLONY src/gate.ts';
const EXPECTED_KIND = 'returns';
const EXPECTED_VALUE = 0;

/**
 * Locate the single documented worked-example line inside authoring-path content. Uses a fixed
 * sentinel string, never a restatement of EXECUTABLE_ASSERTION_RE — the actual parse is left to the
 * real exported extractor below.
 */
function extractWorkedExampleLine(content, label) {
  const matches = content.split('\n').filter((line) => line.includes(WORKED_EXAMPLE_SENTINEL));
  if (matches.length === 0) {
    throw new Error(`${label}: no "${WORKED_EXAMPLE_SENTINEL}" line found — authoring path documents no worked example`);
  }
  if (matches.length > 1) {
    throw new Error(`${label}: ${matches.length} "${WORKED_EXAMPLE_SENTINEL}" lines found — ambiguous pin target`);
  }
  return matches[0];
}

/** Wrap one line under a minimal ticket body and run the REAL exported extractor over it. */
function assertDocumentedExampleParses(line, label) {
  const ticketBody = `## Acceptance Criteria\n${line}\n`;
  const assertions = readExecutableAcceptanceAssertions(ticketBody);
  assert.equal(assertions.length, 1, `${label}: expected exactly one executable assertion in "${line}"`);
  assert.equal(assertions[0].command, EXPECTED_COMMAND, `${label}: command mismatch`);
  assert.equal(assertions[0].kind, EXPECTED_KIND, `${label}: kind mismatch`);
  assert.equal(assertions[0].expected, EXPECTED_VALUE, `${label}: expected-value mismatch`);
}

/** O1-4: stripping the backticks must make the extractor find nothing — never a vacuous pin. */
function assertMutatedExampleFailsToParse(line, label) {
  const mutated = line.replace(/`/g, '');
  const ticketBody = `## Acceptance Criteria\n${mutated}\n`;
  const assertions = readExecutableAcceptanceAssertions(ticketBody);
  assert.deepEqual(assertions, [], `${label}: mutated (backtick-stripped) example should not parse`);
}

function readCommandFile(filename) {
  return fs.readFileSync(path.join(repoRoot, filename), 'utf8');
}

const pickleprdContent = readCommandFile('.claude/commands/pickle-prd.md');
const refinePrdContent = readCommandFile('.claude/commands/pickle-refine-prd.md');
const refinementPrompt = buildWorkerPrompt(
  'requirements',
  '# Minimal PRD for extraction test',
  '/tmp/acceptance-assertion-authoring-form-out.md',
  '/tmp',
  1,
);

test('O1-1/O1-2: pickle-prd.md documents a worked example the real extractor parses', () => {
  const line = extractWorkedExampleLine(pickleprdContent, 'pickle-prd.md');
  assertDocumentedExampleParses(line, 'pickle-prd.md');
});

test('O1-1/O1-2: pickle-refine-prd.md documents a worked example the real extractor parses', () => {
  const line = extractWorkedExampleLine(refinePrdContent, 'pickle-refine-prd.md');
  assertDocumentedExampleParses(line, 'pickle-refine-prd.md');
});

test('O1-1/O1-2: spawn-refinement-team.ts requirements-analyst prompt OUTPUT documents a worked example the real extractor parses', () => {
  const line = extractWorkedExampleLine(refinementPrompt, 'spawn-refinement-team.ts (buildWorkerPrompt output)');
  assertDocumentedExampleParses(line, 'spawn-refinement-team.ts');
});

test('O1-3: pickle-prd.md states prose criteria remain valid and unguarded', () => {
  assert.ok(
    pickleprdContent.includes(PROSE_REMAINS_VALID_SENTINEL),
    'pickle-prd.md must state that prose criteria remain valid and unguarded',
  );
});

test('O1-3: pickle-refine-prd.md states prose criteria remain valid and unguarded', () => {
  assert.ok(
    refinePrdContent.includes(PROSE_REMAINS_VALID_SENTINEL),
    'pickle-refine-prd.md must state that prose criteria remain valid and unguarded',
  );
});

test('O1-3: spawn-refinement-team.ts requirements-analyst prompt OUTPUT states prose criteria remain valid and unguarded', () => {
  assert.ok(
    refinementPrompt.includes(PROSE_REMAINS_VALID_SENTINEL),
    'spawn-refinement-team.ts prompt output must state that prose criteria remain valid and unguarded',
  );
});

test('O1-4 (mutation): stripping backticks from the pickle-prd.md example reds the extraction', () => {
  const line = extractWorkedExampleLine(pickleprdContent, 'pickle-prd.md');
  assertMutatedExampleFailsToParse(line, 'pickle-prd.md');
});

test('O1-4 (mutation): stripping backticks from the pickle-refine-prd.md example reds the extraction', () => {
  const line = extractWorkedExampleLine(refinePrdContent, 'pickle-refine-prd.md');
  assertMutatedExampleFailsToParse(line, 'pickle-refine-prd.md');
});

test('O1-4 (mutation): stripping backticks from the spawn-refinement-team.ts prompt example reds the extraction', () => {
  const line = extractWorkedExampleLine(refinementPrompt, 'spawn-refinement-team.ts');
  assertMutatedExampleFailsToParse(line, 'spawn-refinement-team.ts');
});
