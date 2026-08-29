// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeManagerPromptFromSkill, stripStepOneBlock, MANAGER_ROLE_FRAMING_BLOCK, getExtensionRoot } from '../services/pickle-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTempSkill(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-skill-'));
  const p = path.join(dir, 'skill.md');
  fs.writeFileSync(p, content, 'utf-8');
  return { skillPath: p, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const BASE_SKILL = `<!-- BEGIN GIT_BOUNDARY_RULES -->
Some rules here.
<!-- END GIT_BOUNDARY_RULES -->

## SETUP MODE
This setup section should be stripped.
## REAL SECTION
Body content here.

# Step 1: Initialization

Do \`$ARGUMENTS\` and run setup.js --task "$ARGUMENTS" to start.

\`\`\`bash
node "$HOME/.claude/pickle-rick/extension/bin/setup.js" --task "$ARGUMENTS"
\`\`\`

# Step 2: Execution

Real body for execution phase.
`;

// --- $ARGUMENTS substitution ---
test('composeManagerPromptFromSkill: substitutes $ARGUMENTS', () => {
  const { skillPath, cleanup } = makeTempSkill('Hello $ARGUMENTS world $ARGUMENTS');
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'claude', { argumentSubstitution: '--resume /tmp/sess' });
    assert.ok(result.includes('--resume /tmp/sess'));
    assert.ok(!result.includes('$ARGUMENTS'));
  } finally { cleanup(); }
});

// --- $EXTENSION_ROOT} binding (R-MPVU) ---
test('composeManagerPromptFromSkill: binds ${EXTENSION_ROOT} to getExtensionRoot()', () => {
  const { skillPath, cleanup } = makeTempSkill(
    'Run `node ${EXTENSION_ROOT}/extension/bin/spawn-morty.js` then `node "${EXTENSION_ROOT}/extension/bin/update-state.js"`.'
  );
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'claude', { argumentSubstitution: 'x' });
    const root = getExtensionRoot();
    assert.ok(!result.includes('${EXTENSION_ROOT}'), 'no literal ${EXTENSION_ROOT} placeholder should survive composition');
    assert.ok(result.includes(`node ${root}/extension/bin/spawn-morty.js`));
    assert.ok(result.includes(`node "${root}/extension/bin/update-state.js"`));
  } finally { cleanup(); }
});

// --- stripSetupSection integration ---
test('composeManagerPromptFromSkill: strips ## SETUP MODE section', () => {
  const { skillPath, cleanup } = makeTempSkill(BASE_SKILL);
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'claude', { argumentSubstitution: 'test' });
    assert.ok(!result.includes('This setup section should be stripped'));
    assert.ok(result.includes('REAL SECTION'));
  } finally { cleanup(); }
});

// --- stripStepOneBlock integration ---
test('composeManagerPromptFromSkill: strips # Step 1: Initialization block', () => {
  const { skillPath, cleanup } = makeTempSkill(BASE_SKILL);
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'claude', { argumentSubstitution: 'val' });
    assert.ok(!result.includes('# Step 1: Initialization'));
    assert.ok(!result.includes('setup.js --task'));
  } finally { cleanup(); }
});

test('composeManagerPromptFromSkill: preserves # Step 2 heading after strip', () => {
  const { skillPath, cleanup } = makeTempSkill(BASE_SKILL);
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'claude', { argumentSubstitution: 'val' });
    assert.ok(result.includes('# Step 2: Execution'));
    assert.ok(result.includes('Real body for execution phase.'));
  } finally { cleanup(); }
});

// --- Optional appends ---
test('composeManagerPromptFromSkill: appends handoffText when provided', () => {
  const { skillPath, cleanup } = makeTempSkill('Body text.');
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'claude', {
      argumentSubstitution: 'x',
      handoffText: 'HANDOFF CONTENT',
    });
    assert.ok(result.includes('HANDOFF CONTENT'));
  } finally { cleanup(); }
});

test('composeManagerPromptFromSkill: appends iterationSummary when provided', () => {
  const { skillPath, cleanup } = makeTempSkill('Body text.');
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'claude', {
      argumentSubstitution: 'x',
      iterationSummary: 'ITERATION SUMMARY',
    });
    assert.ok(result.includes('ITERATION SUMMARY'));
  } finally { cleanup(); }
});

test('composeManagerPromptFromSkill: appends taskNotes under header when provided', () => {
  const { skillPath, cleanup } = makeTempSkill('Body text.');
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'claude', {
      argumentSubstitution: 'x',
      taskNotes: 'TASK NOTE CONTENT',
    });
    assert.ok(result.includes('=== TASK NOTES (from previous iterations) ==='));
    assert.ok(result.includes('TASK NOTE CONTENT'));
  } finally { cleanup(); }
});

test('composeManagerPromptFromSkill: skips missing optional appends', () => {
  const { skillPath, cleanup } = makeTempSkill('Body only.');
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'claude', { argumentSubstitution: 'x' });
    assert.ok(!result.includes('TASK NOTES'));
    assert.ok(!result.includes('MANAGER_ROLE_FRAMING'));
  } finally { cleanup(); }
});

// --- Codex-only role framing ---
test('composeManagerPromptFromSkill: codex mode prepends MANAGER_ROLE_FRAMING markers', () => {
  const { skillPath, cleanup } = makeTempSkill('Manager body.');
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'codex', { argumentSubstitution: 'x' });
    assert.ok(result.startsWith('<!-- BEGIN MANAGER_ROLE_FRAMING -->'));
    assert.ok(result.includes('<!-- END MANAGER_ROLE_FRAMING -->'));
  } finally { cleanup(); }
});

test('composeManagerPromptFromSkill: claude mode has no MANAGER_ROLE_FRAMING markers', () => {
  const { skillPath, cleanup } = makeTempSkill('Manager body.');
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'claude', { argumentSubstitution: 'x' });
    assert.ok(!result.includes('BEGIN MANAGER_ROLE_FRAMING'));
    assert.ok(!result.includes('END MANAGER_ROLE_FRAMING'));
  } finally { cleanup(); }
});

test('composeManagerPromptFromSkill: hermes mode has no MANAGER_ROLE_FRAMING markers', () => {
  const { skillPath, cleanup } = makeTempSkill('Manager body.');
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'hermes', { argumentSubstitution: 'x' });
    assert.ok(!result.includes('BEGIN MANAGER_ROLE_FRAMING'));
  } finally { cleanup(); }
});

test('composeManagerPromptFromSkill: codex mode PROHIBITED content present', () => {
  const { skillPath, cleanup } = makeTempSkill('Manager body.');
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'codex', { argumentSubstitution: 'x' });
    assert.ok(result.includes('PROHIBITED'));
  } finally { cleanup(); }
});

test('composeManagerPromptFromSkill: codex mode includes no-signal and no-bypass directives', () => {
  const { skillPath, cleanup } = makeTempSkill('Manager body.');
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'codex', { argumentSubstitution: 'x' });
    assert.ok(result.includes('DO NOT send SIGTERM/SIGINT/SIGKILL to the mux-runner subprocess.'));
    assert.ok(result.includes('DO NOT decide that mux-runner is wedged based on session-directory observation.'));
    assert.ok(result.includes('DO NOT attempt to bypass mux-runner by spawning spawn-morty.js directly.'));
  } finally { cleanup(); }
});

// --- stripStepOneBlock unit ---
test('stripStepOneBlock: strips from # Step 1: Initialization through # Step 2:', () => {
  const input = `Preamble.

# Step 1: Initialization

setup.js --task "something"

# Step 2: Execution

Real content.`;
  const result = stripStepOneBlock(input);
  assert.ok(!result.includes('# Step 1: Initialization'));
  assert.ok(!result.includes('setup.js --task'));
  assert.ok(result.includes('# Step 2: Execution'));
  assert.ok(result.includes('Real content.'));
  assert.ok(result.includes('Preamble.'));
});

test('stripStepOneBlock: returns unchanged when no Step 1 heading', () => {
  const input = 'No step one here.\n# Step 2: Execution\nContent.';
  assert.equal(stripStepOneBlock(input), input);
});

test('stripStepOneBlock: returns unchanged when no Step 2 heading after Step 1', () => {
  const input = '# Step 1: Initialization\nOnly step.';
  assert.equal(stripStepOneBlock(input), input);
});

// --- MANAGER_ROLE_FRAMING_BLOCK constant ---
test('MANAGER_ROLE_FRAMING_BLOCK: has correct opening and closing markers', () => {
  assert.ok(MANAGER_ROLE_FRAMING_BLOCK.startsWith('<!-- BEGIN MANAGER_ROLE_FRAMING -->'));
  assert.ok(MANAGER_ROLE_FRAMING_BLOCK.endsWith('<!-- END MANAGER_ROLE_FRAMING -->'));
});

test('MANAGER_ROLE_FRAMING_BLOCK: contains PROHIBITED keyword', () => {
  assert.ok(MANAGER_ROLE_FRAMING_BLOCK.includes('PROHIBITED'));
});

test('MANAGER_ROLE_FRAMING_BLOCK: mentions setup.js in prohibited list', () => {
  assert.ok(MANAGER_ROLE_FRAMING_BLOCK.includes('setup.js'));
});

test('MANAGER_ROLE_FRAMING_BLOCK: includes codex mux safety guardrails', () => {
  assert.ok(MANAGER_ROLE_FRAMING_BLOCK.includes('DO NOT send SIGTERM/SIGINT/SIGKILL to the mux-runner subprocess.'));
  assert.ok(MANAGER_ROLE_FRAMING_BLOCK.includes('DO NOT decide that mux-runner is wedged based on session-directory observation.'));
  assert.ok(MANAGER_ROLE_FRAMING_BLOCK.includes('DO NOT attempt to bypass mux-runner by spawning spawn-morty.js directly.'));
});

// --- Snapshot pins ---
test('composeManagerPromptFromSkill snapshot: codex mode', () => {
  const { skillPath, cleanup } = makeTempSkill('Simple body. $ARGUMENTS here.');
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'codex', {
      argumentSubstitution: '--resume /session',
      handoffText: 'Handoff: done.',
    });
    assert.ok(result.startsWith('<!-- BEGIN MANAGER_ROLE_FRAMING -->'));
    assert.ok(result.includes('Simple body. --resume /session here.'));
    assert.ok(result.includes('Handoff: done.'));
    assert.ok(!result.includes('$ARGUMENTS'));
  } finally { cleanup(); }
});

test('composeManagerPromptFromSkill snapshot: claude mode', () => {
  const { skillPath, cleanup } = makeTempSkill('Simple body. $ARGUMENTS here.');
  try {
    const result = composeManagerPromptFromSkill(skillPath, 'claude', {
      argumentSubstitution: '--resume /session',
    });
    assert.ok(!result.startsWith('<!-- BEGIN MANAGER_ROLE_FRAMING -->'));
    assert.ok(result.includes('Simple body. --resume /session here.'));
    assert.ok(!result.includes('$ARGUMENTS'));
  } finally { cleanup(); }
});

// --- R-PNTR-TEMPLATE-PARITY: _pickle-manager-prompt.md is the canonical manager template ---
// R-PNTR-5: pickle.md deleted — byte-parity tests removed. The template is the sole source.

const PICKLE_TEMPLATE_PATH = path.resolve(__dirname, '../templates/_pickle-manager-prompt.md');

test('AC-PNTR-01 / R-PNTR-TEMPLATE-PARITY: _pickle-manager-prompt.md exists and is non-empty', () => {
  assert.ok(fs.existsSync(PICKLE_TEMPLATE_PATH), '_pickle-manager-prompt.md must exist at extension/templates/');
  const content = fs.readFileSync(PICKLE_TEMPLATE_PATH, 'utf-8');
  assert.ok(content.length > 0, '_pickle-manager-prompt.md must be non-empty');
});

// --- R-MPVU: the composed manager prompt ships with no unbound ${EXTENSION_ROOT} ---
// The real template also carries ${SESSION_ROOT}/${TICKET_ID} tokens the manager (an LLM)
// resolves from the appended "=== PICKLE RICK LOOP CONTEXT ===" handoff block (Session:/Ticket:
// lines) rather than literal substitution — that is by design, so this test asserts the general
// "no unbound ${...}" property scoped to EXTENSION_ROOT specifically, which has no such fallback.
test('R-MPVU: composed manager prompt (claude) has zero unbound ${EXTENSION_ROOT} placeholders', () => {
  const result = composeManagerPromptFromSkill(PICKLE_TEMPLATE_PATH, 'claude', {
    argumentSubstitution: '--resume /tmp/session',
  });
  const unbound = result.match(/\$\{EXTENSION_ROOT\}/g) ?? [];
  assert.deepEqual(unbound, [], `expected zero unbound \${EXTENSION_ROOT} placeholders, found ${unbound.length}`);
  assert.ok(result.includes(getExtensionRoot()), 'composed prompt should contain the resolved extension root path');
});

test('R-MPVU: composed manager prompt (codex) has zero unbound ${EXTENSION_ROOT} placeholders', () => {
  const result = composeManagerPromptFromSkill(PICKLE_TEMPLATE_PATH, 'codex', {
    argumentSubstitution: '--resume /tmp/session',
  });
  const unbound = result.match(/\$\{EXTENSION_ROOT\}/g) ?? [];
  assert.deepEqual(unbound, [], `expected zero unbound \${EXTENSION_ROOT} placeholders, found ${unbound.length}`);
});

test('R-MPVU: source template carries ${EXTENSION_ROOT} occurrences (stale-premise guard)', () => {
  const content = fs.readFileSync(PICKLE_TEMPLATE_PATH, 'utf-8');
  const occurrences = content.match(/\$\{EXTENSION_ROOT\}/g) ?? [];
  assert.ok(occurrences.length > 0, 'the raw template should still reference ${EXTENSION_ROOT} — if this fails, the placeholder was removed upstream and the binding fix may be dead code');
});
