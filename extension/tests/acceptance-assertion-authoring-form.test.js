// @tier: fast
// AC-O1: every authoring path documents a worked example the real extractor parses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExecutableAcceptanceAssertions } from '../bin/mux-runner.js';
import { buildWorkerPrompt } from '../bin/spawn-refinement-team.js';
import { composeManagerPromptFromSkill } from '../services/pickle-utils.js';

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

// R1: the REAL Phase 2 manager ticket-authoring path, composed exactly as the production call sites
// (mux-runner.ts, jar-runner.ts) compose it — through the real composeManagerPromptFromSkill, over the
// real template file on disk. This is "authored output" (the rendered template), never a doc-string claim.
const managerTemplatePath = path.join(repoRoot, 'extension/templates/_pickle-manager-prompt.md');
const managerPrompt = composeManagerPromptFromSkill(managerTemplatePath, 'claude', {
  argumentSubstitution: 'R1 acceptance-assertion-authoring-form test session',
});

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

test('R1-1: the manager Phase 2 ticket-authoring template (real composeManagerPromptFromSkill output) documents a worked example the real extractor parses', () => {
  const line = extractWorkedExampleLine(managerPrompt, '_pickle-manager-prompt.md');
  assertDocumentedExampleParses(line, '_pickle-manager-prompt.md');
});

test('R1-1: the manager Phase 2 ticket-authoring template states prose criteria remain valid and unguarded', () => {
  assert.ok(
    managerPrompt.includes(PROSE_REMAINS_VALID_SENTINEL),
    '_pickle-manager-prompt.md (composed) must state that prose criteria remain valid and unguarded',
  );
});

test('R1-1 (mutation): stripping backticks from the manager-template example reds the extraction', () => {
  const line = extractWorkedExampleLine(managerPrompt, '_pickle-manager-prompt.md');
  assertMutatedExampleFailsToParse(line, '_pickle-manager-prompt.md');
});

test('R1-1: the ${ACCEPTANCE_CRITERIA_GUIDANCE} placeholder does not survive composition', () => {
  assert.ok(
    !managerPrompt.includes('${ACCEPTANCE_CRITERIA_GUIDANCE}'),
    'composeManagerPromptFromSkill must resolve the placeholder, never leave it literal in the manager prompt',
  );
});

test('R1-3: a prose-only acceptance criterion is neither rewritten into a fake command nor rejected', () => {
  const proseOnlyCriterion = 'The dashboard renders the new widget without a console error.';
  const ticketBody = `## Acceptance Criteria\n- ${proseOnlyCriterion}\n`;
  const assertions = readExecutableAcceptanceAssertions(ticketBody);
  assert.deepEqual(
    assertions,
    [],
    'a prose-only criterion must not be fabricated into an executable assertion',
  );
  assert.ok(
    ticketBody.includes(proseOnlyCriterion),
    'the prose criterion text must survive unmodified — the authoring form never invents a command',
  );
});
