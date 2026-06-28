// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function readDoc(relPath) {
  return readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
}

function readLines(relPath) {
  return readDoc(relPath).split('\n');
}

function findBundleTicketRow(ticketKey) {
  const escapedTicketKey = ticketKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rowPattern = new RegExp(`^\\| \\d+ \\| ${escapedTicketKey} \\|`);
  const rows = readLines('prds/archive/bundles/citadel-hardening-bundle.md')
    .filter((line) => rowPattern.test(line));
  assert.equal(rows.length, 1, `${ticketKey} must appear exactly once in bundle implementation table`);
  return rows[0];
}

function findBundleRowsMatching(pattern) {
  return readLines('prds/archive/bundles/citadel-hardening-bundle.md')
    .filter((line) => line.startsWith('|'))
    .filter((line) => pattern.test(line));
}

const CANONICAL_FRAME_NAMES = [
  'Frame 1: Context Key Lifecycle Trace',
  'Frame 2: Success/Failure Symmetry',
  'Frame 3: Edge Condition Exhaustiveness',
  'Frame 4: Tool Exit Code Semantics Audit',
  'Frame 5: Loop Convergence Proof Obligation',
  'Frame 6: Counterfactual Outcome Test',
];

const DOC_FILES_WITH_FRAMES = [
  '.claude/commands/pickle-dot-patterns.md',
  '.claude/commands/plumbus.md',
  'README.md',
];

const DOC_FILES_WITH_ENV_VAR = [
  '.claude/commands/plumbus.md',
  'CLAUDE.md',
  'README.md',
];

const FINGERPRINT_LITERAL = '<!-- graph-fingerprint: <sha256> -->';
const FINGERPRINT_REGEX_LITERAL = '^<!-- graph-fingerprint: ([a-f0-9]{64}) -->$';

test('all six canonical Frame titles appear in each DOC_FILE that covers the rubric', () => {
  const failures = [];
  for (const docFile of DOC_FILES_WITH_FRAMES) {
    const content = readDoc(docFile);
    for (const frameName of CANONICAL_FRAME_NAMES) {
      if (!content.includes(frameName)) {
        failures.push(`${docFile}: missing "${frameName}"`);
      }
    }
  }
  assert.deepEqual(failures, [], `Frame name drift detected:\n${failures.join('\n')}`);
});

test('PLUMBUS_GENERATIVE_AUDIT env var spelled identically in all required DOC_FILES', () => {
  const ENV_VAR = 'PLUMBUS_GENERATIVE_AUDIT';
  const failures = [];
  for (const docFile of DOC_FILES_WITH_ENV_VAR) {
    const content = readDoc(docFile);
    if (!content.includes(ENV_VAR)) {
      failures.push(`${docFile}: missing "${ENV_VAR}"`);
    }
  }
  assert.deepEqual(failures, [], `Env var spelling drift:\n${failures.join('\n')}`);
});

test('fingerprint comment literal appears in plumbus.md', () => {
  const content = readDoc('.claude/commands/plumbus.md');
  assert.ok(
    content.includes(FINGERPRINT_LITERAL),
    `plumbus.md missing fingerprint literal: ${FINGERPRINT_LITERAL}`,
  );
});

test('fingerprint parser regex appears identically in plumbus.md and integration test', () => {
  const plumbus = readDoc('.claude/commands/plumbus.md');
  const integTest = readDoc(
    'extension/tests/plumbus-generative-audit.integration.test.js',
  );
  assert.ok(
    plumbus.includes(FINGERPRINT_REGEX_LITERAL),
    `plumbus.md missing parser regex: ${FINGERPRINT_REGEX_LITERAL}`,
  );
  assert.ok(
    integTest.includes(FINGERPRINT_REGEX_LITERAL),
    `integration test missing parser regex: ${FINGERPRINT_REGEX_LITERAL}`,
  );
});

test('Override 6 appears in plumbus.md with exact heading prefix', () => {
  const content = readDoc('.claude/commands/plumbus.md');
  assert.ok(
    content.includes('Override 6:'),
    'plumbus.md: Override 6 heading not found',
  );
});

test('README.md documents the Generative Audit Frames rubric section', () => {
  const content = readDoc('README.md');
  assert.ok(
    content.includes('Generative Audit Frames'),
    'README.md: missing "Generative Audit Frames" section',
  );
});

test('CLAUDE.md documents extension/data/ convention', () => {
  const content = readDoc('CLAUDE.md');
  assert.ok(
    content.includes('extension/data'),
    'CLAUDE.md: missing extension/data/ convention',
  );
});

test('AC-BUNDLE-04: refined ticket queue has exactly one microverse relaunch implementation ticket', () => {
  const microverseRelaunchRows = findBundleRowsMatching(/microverse-runner\.ts codex-manager relaunch wiring/);

  assert.deepEqual(
    microverseRelaunchRows,
    [
      '| 20 | B-T3 | 02f70776 | `prds/anatomy-park-followups.md` | Atomic Tickets > T3 | microverse-runner.ts codex-manager relaunch wiring | AC-APF-C1, AC-APF-C2, AC-APF-C3, AC-APF-C4, AC-APF-C5, AC-APF-C6 |',
    ],
  );

  const h4Row = findBundleTicketRow('H4');
  assert.match(h4Row, /AC-BUNDLE-04, AC-BUNDLE-17, AC-BUNDLE-19/);
});

test('AC-BUNDLE-17: trap-door ticket rows and enforcement surfaces stay cross-referenced', () => {
  const bT1Row = findBundleTicketRow('B-T1');
  const aT4Row = findBundleTicketRow('A-T4');
  const h4Row = findBundleTicketRow('H4');
  const claude = readDoc('extension/CLAUDE.md');
  const invariantTests = readDoc('extension/tests/state-field-invariants.test.js');

  assert.match(bT1Row, /AC-APF-A1, AC-APF-A2, AC-APF-A3, AC-APF-A4/);
  assert.match(aT4Row, /AC-BUNDLE-17/);
  assert.match(h4Row, /AC-BUNDLE-17/);
  assert.match(claude, /src\/services\/pickle-utils\.ts` \(restartDeadWatcherPanes\).*extension\/tests\/ensure-monitor-window\.test\.js/);
  assert.match(invariantTests, /AC-BUNDLE-17: trap-door entries stay under 1500 chars/);
  assert.match(invariantTests, /AC-BUNDLE-17: every State field has exactly one field invariant/);
});

test('AC-BUNDLE-19: Linear integration ticket rows, code, and tests stay cross-referenced', () => {
  const newT6Row = findBundleTicketRow('NEW-T6');
  const h4Row = findBundleTicketRow('H4');
  const implementation = readDoc('extension/src/services/linear-integration.ts');
  const gitUtils = readDoc('extension/src/services/git-utils.ts');
  const pipelineRunner = readDoc('extension/src/bin/pipeline-runner.ts');
  const tests = readDoc('extension/tests/linear-integration.test.js');

  assert.match(newT6Row, /New Refinement-Derived Tickets > NEW-T6 .* AC-BUNDLE-19/);
  assert.match(h4Row, /AC-BUNDLE-19/);
  // Accept either `newStatus` or `nextStatus` for the third arg — local
  // variable name is not load-bearing for the wire check; the function
  // signature (sessionDir, ticketId, status) is what we're asserting.
  assert.match(gitUtils, /syncLinearTicketStatus\(sessionDir, ticketId, (?:new|next)Status\)/);
  assert.match(implementation, /action: 'createTicket'/);
  assert.match(implementation, /action: 'transitionTicket'/);
  assert.match(implementation, /action: 'commentTicket'/);
  assert.match(pipelineRunner, /emitBundleLinearComments\(runtime\.sessionDir, path\.join\(runtime\.sessionDir, 'pipeline-runner\.log'\)\)/);
  assert.match(tests, /creates a Linear ticket once and mirrors transitions/);
  assert.match(tests, /comments once per Linear-backed ticket with session log link/);
});
