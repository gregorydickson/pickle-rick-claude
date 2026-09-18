// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const skillPath = path.resolve(__dirname, '../../.claude/commands/pickle-pipeline.md');
const skill = fs.readFileSync(skillPath, 'utf8');

const STEP0_START = skill.indexOf('## Step 0: Refinement Prerequisite');
const STEP1_START = skill.indexOf('## Step 1: Check tmux');
const STEP2_START = skill.indexOf('## Step 2: Parse Arguments');
const STEP3_START = skill.indexOf('## Step 3: Session Setup');
const STEP4_START = skill.indexOf('## Step 4: Create pipeline.json');
const step0Body = skill.slice(STEP0_START, STEP1_START);
const step2Body = skill.slice(STEP2_START, STEP3_START);
const step3Body = skill.slice(STEP3_START, STEP4_START);

describe('pickle-pipeline skill prompt — description and structure', () => {
  test('first-line description fits in 80 chars and names all three runtime phases', () => {
    const firstLine = skill.split('\n')[0];
    assert.ok(firstLine.length <= 80, `first line is ${firstLine.length} chars: ${firstLine}`);
    assert.match(firstLine, /pickle-tmux/);
    assert.match(firstLine, /anatomy-park/);
    assert.match(firstLine, /szechuan-sauce/);
  });

  test('Step 0 Refinement Prerequisite is present and runs before Step 1', () => {
    assert.ok(STEP0_START > 0, 'Step 0 header missing');
    assert.ok(STEP1_START > STEP0_START, 'Step 1 must come after Step 0');
  });

  test('no stale "run /pickle-refine-prd FIRST" instruction remains (would contradict Step 0)', () => {
    assert.doesNotMatch(skill, /run\s+`?\/pickle-refine-prd`?\s+FIRST/);
  });
});

describe('pickle-pipeline Step 0 — decision tree', () => {
  test('decision tree is labeled "first match wins"', () => {
    assert.match(step0Body, /first match wins/i);
  });

  test('rule order: --no-refine wins over --refine wins over auto-infer wins over default-false', () => {
    const noRefineRule = step0Body.search(/1\.\s*`?\$ARGUMENTS`?\s+contains\s+`?--no-refine`?/);
    const refineRule = step0Body.search(/2\.\s*`?\$ARGUMENTS`?\s+contains\s+`?--refine`?/);
    const autoInferRule = step0Body.search(/3\.\s*`?\$ARGUMENTS`?\s+matches/);
    const defaultRule = step0Body.search(/4\.\s*Otherwise/);
    assert.ok(noRefineRule >= 0, 'rule 1 (--no-refine) not found');
    assert.ok(refineRule > noRefineRule, '--refine rule must follow --no-refine');
    assert.ok(autoInferRule > refineRule, 'auto-infer rule must follow --refine');
    assert.ok(defaultRule > autoInferRule, 'default-false rule must come last');
  });

  test('conflict pre-check appears BEFORE the decision tree (else rule 1 wins on both flags)', () => {
    const preCheckIdx = step0Body.indexOf('Pre-check');
    const decisionIdx = step0Body.search(/Decision\s*\(first match wins\)/);
    assert.ok(preCheckIdx >= 0, 'Pre-check missing');
    assert.ok(decisionIdx >= 0, 'Decision header missing');
    assert.ok(preCheckIdx < decisionIdx, 'Pre-check must come before Decision tree');
  });

  test('conflict pre-check rejects --refine + --no-refine together with halt semantics', () => {
    assert.match(step0Body, /Pre-check/i);
    assert.match(step0Body, /BOTH\s+`?--refine`?\s+AND\s+`?--no-refine`?/);
    assert.match(step0Body, /Conflicting flags/i);
    assert.match(step0Body, /\bstop\b/i, 'must explicitly halt on conflict');
    assert.match(step0Body, /Do NOT proceed/i, 'must forbid continuation on conflict');
  });
});

describe('pickle-pipeline Step 0 — auto-infer regex behavior', () => {
  function extractAutoInferRegex() {
    // Anchor extraction to rule 3's "matches `/.../i`" — robust against future regexes elsewhere.
    const match = step0Body.match(/3\.\s*`?\$ARGUMENTS`?\s+matches\s+`(\/[^`]+\/i)`/);
    assert.ok(match, 'expected rule 3 to contain a /…/i regex literal in backticks');
    const literal = match[1];
    const body = literal.slice(1, literal.lastIndexOf('/'));
    return new RegExp(body, 'i');
  }

  test('positive triggers: workflow-style refinement requests match', () => {
    const re = extractAutoInferRegex();
    for (const positive of [
      'refine-prd then build the caching layer',
      'pickle refine prd, pickle tmux, szechuan, anatomy park',
      'prd refinement followed by build',
      'refine the prd before building',
      'refinement first, then implement',
      'Refine the PRD then ship',
      'decompose first',
      'refine then build the caching layer',
      'refine, then ship',
    ]) {
      assert.ok(re.test(positive), `should match: ${positive}`);
    }
  });

  test('negative triggers: feature-content uses do NOT match', () => {
    const re = extractAutoInferRegex();
    for (const negative of [
      'refine the dropdown UX',
      'add a refinement loop to the model',
      'refinery pipeline scheduling',
      'redefine the API contract',
      'refactor the auth middleware',
      'refine the dropdown before shipping',
      'refine the dropdown UX then ship the cart',
    ]) {
      assert.ok(!re.test(negative), `should NOT match: ${negative}`);
    }
  });
});

describe('pickle-pipeline Step 0 — PRD resolution and skip gates', () => {
  test('Step 0a documents fail-fast on missing prd.md with explicit halt language', () => {
    const block0a = step0Body.match(/0a[^]*?(?=0b|\*\*0b)/);
    assert.ok(block0a, 'Step 0a block not found');
    assert.match(block0a[0], /fail fast/i);
    assert.match(block0a[0], /No prd\.md found/);
    assert.match(block0a[0], /Run \/pickle-prd first/);
    assert.match(block0a[0], /\bStop\b/, 'Step 0a must halt');
    assert.match(block0a[0], /Do NOT launch tmux/i, 'Step 0a must forbid tmux launch');
  });

  test('Step 0b skip-if-already-refined references prd_refined.md and uses skip language', () => {
    const skipBlock = step0Body.match(/0b[^]*?(?=0c|Mid-refinement)/);
    assert.ok(skipBlock, 'Step 0b block not found');
    assert.match(skipBlock[0], /prd_refined\.md/);
    assert.match(skipBlock[0], /skip|skipping/i);
    assert.match(skipBlock[0], /Continue to Step 1/);
  });

  test('mid-refinement detection fails fast on partial state (manifest without refined PRD)', () => {
    assert.match(step0Body, /Mid-refinement/i);
    assert.match(step0Body, /refinement_manifest\.json/);
    assert.match(step0Body, /in-progress refinement/i);
    assert.match(step0Body, /\/pickle-refine-prd --resume/);
  });

  test('Step 0d documents fail-fast on refine failure', () => {
    const block0d = step0Body.match(/0d[^]*?(?=0e|\*\*0e)/);
    assert.ok(block0d, 'Step 0d block not found');
    assert.match(block0d[0], /refine failure/i);
    assert.match(block0d[0], /fail fast/i);
    assert.match(block0d[0], /Do NOT launch the pipeline/i);
  });
});

describe('pickle-pipeline Step 0 — refine handoff and backend pinning', () => {
  test('Step 0c invokes /pickle-refine-prd inline and sets SESSION_INITIALIZED marker', () => {
    const refineBlock = step0Body.match(/0c[^]*?(?=0d|\*\*0d|Note on interactive)/);
    assert.ok(refineBlock, 'Step 0c block not found');
    assert.match(refineBlock[0], /\/pickle-refine-prd/);
    assert.match(refineBlock[0], /SESSION_ROOT/);
    assert.match(refineBlock[0], /SESSION_INITIALIZED\s*=\s*true/);
    assert.match(refineBlock[0], /TASK_COMPLETED/);
  });

  test('Step 0c explicitly forbids passing --backend to /pickle-refine-prd', () => {
    const refineBlock = step0Body.match(/0c[^]*?(?=0d|\*\*0d|Note on interactive)/);
    assert.ok(refineBlock, 'Step 0c block not found');
    assert.match(refineBlock[0], /NOT\**\s+pass\s+`?--backend`?/i, 'must forbid passing --backend to refine');
  });

  test('refinement is pinned to claude regardless of pipeline --backend, but pipeline phases honor --backend', () => {
    // Both halves of the rule must coexist in Step 0.
    assert.match(step0Body, /pinn?ed\s+to\s+claude|pins\s+itself\s+to\s+claude|claude\s+regardless/i);
    assert.match(step0Body, /Pipeline phases.*honor\s+whatever\s+`?--backend`?/i);
  });

  test('Step 0c documents the interactive verification gate risk', () => {
    assert.match(step0Body, /interactive gating|interactive gate|interview/i);
    assert.match(step0Body, /pause/i);
    assert.match(step0Body, /Step 2c|verification quality/i);
  });

  test('Step 0e strips --refine/--no-refine before Step 2 reparses', () => {
    const continueBlock = step0Body.match(/0e[^]*$/);
    assert.ok(continueBlock, 'Step 0e block not found');
    assert.match(continueBlock[0], /[Ss]trip/);
    assert.match(continueBlock[0], /--refine/);
    assert.match(continueBlock[0], /--no-refine/);
    assert.match(continueBlock[0], /TASK content/);
  });
});

describe('pickle-pipeline Step 2 — scope flags wiring', () => {
  test('scope flags are documented as pipeline.json-bound, NOT setup.js args', () => {
    assert.match(step2Body, /--scope\s+<flag>/);
    assert.match(step2Body, /--scope-base\s+<ref>/);
    assert.match(step2Body, /written into\s+`pipeline\.json`/);
    assert.match(step2Body, /do NOT pass them to\s+`?setup\.js`?/i);
  });
});

describe('pickle-pipeline Step 3 — SESSION_INITIALIZED carryover from Step 0', () => {
  test('Step 3 branches on SESSION_INITIALIZED set by Step 0', () => {
    assert.match(step3Body, /SESSION_INITIALIZED.*=\s*true/);
    assert.match(step3Body, /resume mode/i);
  });

  test('Step 3 resume branch uses --resume with the captured SESSION_ROOT', () => {
    assert.match(step3Body, /setup\.js[^`]*--resume\s+"\$\{SESSION_ROOT\}"/);
  });

  test('Step 3 fresh branch (no refinement) preserves --task argument and never uses --resume', () => {
    const freshHeader = step3Body.indexOf('Otherwise (no refinement');
    assert.ok(freshHeader > 0, 'fresh-branch label missing');
    // Scope to the fresh-branch fenced code block.
    const codeFenceStart = step3Body.indexOf('```bash', freshHeader);
    const codeFenceEnd = step3Body.indexOf('```', codeFenceStart + 7);
    assert.ok(codeFenceStart > 0 && codeFenceEnd > codeFenceStart, 'fresh-branch code block not found');
    const freshCmd = step3Body.slice(codeFenceStart, codeFenceEnd);
    assert.match(freshCmd, /--task\s+"<TASK>"/);
    assert.doesNotMatch(freshCmd, /--resume/, 'fresh branch must NOT pass --resume');
  });
});

describe('pickle-pipeline Step 4 — pipeline.json key emission', () => {
  test('optional keys are conditional, never placeholders', () => {
    const step4Body = skill.slice(STEP4_START, skill.indexOf('## Step 5'));
    assert.match(step4Body, /ONLY when the corresponding flag was passed/);
    assert.match(step4Body, /do NOT emit placeholders/i);
    // backend must be optional (omit when not passed).
    assert.match(step4Body, /`backend`[^.]*omit the key entirely otherwise/i);
  });

  test('--skip-citadel / --skip-anatomy / --skip-szechuan remove phases from pipeline array', () => {
    const step4Body = skill.slice(STEP4_START, skill.indexOf('## Step 5'));
    assert.match(step4Body, /Remove entries if\s+`?--skip-citadel`?,\s+`?--skip-anatomy`?,\s+or\s+`?--skip-szechuan`?\s+were passed/);
  });
});

describe('pickle-pipeline flag table — Step 2', () => {
  test('--refine and --no-refine flags are documented as already consumed in Step 0', () => {
    assert.match(skill, /--refine[^\n]*Step 0/);
    assert.match(skill, /--no-refine[^\n]*Step 0/);
  });
});

// AP-EXT-ITER269-01 regression: Step 0.5's sizing gate keyed on
// `${SESSION_ROOT}/decomposition_manifest.json`, a session artifact no producer in
// the tree writes — measured absent from 16/16 live sessions — so the
// severe-undersizing BLOCK could never fire on any real launch. The roster it must
// count is the one the runtime enumerates: `<id>/rick_ticket_<id>.md` directories.
describe('pickle-pipeline Step 0.5 — sizing keys on a roster a producer writes', () => {
  const STEP05_START = skill.indexOf('## Step 0.5: Sizing Check');
  const step05Body = skill.slice(STEP05_START, skill.indexOf('## Step 0.6'));

  test('Step 0.5 body is locatable', () => {
    assert.ok(STEP05_START > 0 && step05Body.length > 0, 'Step 0.5 section not found');
  });

  test('AP-EXT-ITER269-01: no step keys on decomposition_manifest.json — nothing in the tree writes it', () => {
    assert.doesNotMatch(skill, /decomposition_manifest\.json/);
  });

  test('AP-EXT-ITER269-01: the ticket count comes from the ticket directories, not a manifest file', () => {
    assert.match(step05Body, /TICKET_COUNT=\$\(find "\$\{SESSION_ROOT\}"[^\n]*rick_ticket_\*\.md/);
    assert.match(step05Body, /TICKET_COUNT == 0/, 'an empty roster must skip the sizing verdict');
  });

  test('AP-EXT-ITER269-01: the counted filename prefix is the one collectTickets enumerates (derived, not hardcoded)', () => {
    const pickleUtils = fs.readFileSync(path.resolve(__dirname, '..', 'services', 'pickle-utils.js'), 'utf8');
    assert.match(
      pickleUtils,
      /startsWith\('rick_ticket_'\)/,
      'collectTickets no longer enumerates rick_ticket_ files — Step 0.5 roster expression must move with it',
    );
  });
});
