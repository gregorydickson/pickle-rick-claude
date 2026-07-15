// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOM_EVIDENCE_RULES, FOM_HONEST_REPORTING_RULES } from '../../services/fom-blocks.js';
// Data-flow integrity (ticket a4038d7c): the two builders whose assembled OUTPUT can be exercised
// directly. Asserting the block is in the returned prompt string — not merely imported/declared —
// is what proves the constant actually reaches the LLM (the "carries but never splices" class).
import { buildJudgePrompt } from '../../bin/microverse-runner.js';
import { buildWorkerPrompt } from '../../bin/spawn-refinement-team.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const FOM_BLOCKS = {
  FOM_EVIDENCE_RULES: {
    constant: FOM_EVIDENCE_RULES,
    start: '<!-- BEGIN FOM_EVIDENCE_RULES -->',
    end: '<!-- END FOM_EVIDENCE_RULES -->',
  },
  FOM_HONEST_REPORTING_RULES: {
    constant: FOM_HONEST_REPORTING_RULES,
    start: '<!-- BEGIN FOM_HONEST_REPORTING_RULES -->',
    end: '<!-- END FOM_HONEST_REPORTING_RULES -->',
  },
};

// B-FOMC WS-2 (ticket c4ee67ff) infused all ten judging surfaces below. Shape:
// { path: <repo-relative>, blocks: [<FOM_BLOCKS key>, ...], kind: 'md' | 'ts' | 'workflow-js' }
const FAMILY = [
  // The two refinement twins + the synthesizer + the council get BOTH blocks.
  { path: 'extension/src/bin/spawn-refinement-team.ts', blocks: ['FOM_EVIDENCE_RULES', 'FOM_HONEST_REPORTING_RULES'], kind: 'ts' },
  { path: '.claude/workflows/refine-analyze.js', blocks: ['FOM_EVIDENCE_RULES', 'FOM_HONEST_REPORTING_RULES'], kind: 'workflow-js' },
  { path: '.claude/commands/pickle-refine-prd.md', blocks: ['FOM_EVIDENCE_RULES', 'FOM_HONEST_REPORTING_RULES'], kind: 'md' },
  { path: '.claude/workflows/council-round.js', blocks: ['FOM_EVIDENCE_RULES', 'FOM_HONEST_REPORTING_RULES'], kind: 'workflow-js' },

  // The judge (JUDGE_SYSTEM_PROMPT + buildJudgePrompt) and the three rubrics get honest-reporting only.
  { path: 'extension/src/bin/microverse-runner.ts', blocks: ['FOM_HONEST_REPORTING_RULES'], kind: 'ts' },
  { path: 'extension/szechuan-sauce-principles.md', blocks: ['FOM_HONEST_REPORTING_RULES'], kind: 'md' },
  { path: 'extension/szechuan-sauce-ui-principles.md', blocks: ['FOM_HONEST_REPORTING_RULES'], kind: 'md' },
  { path: 'extension/szechuan-sauce-financial-principles.md', blocks: ['FOM_HONEST_REPORTING_RULES'], kind: 'md' },

  // The remediator pair gets BOTH blocks.
  { path: 'extension/src/bin/spawn-gate-remediator.ts', blocks: ['FOM_EVIDENCE_RULES', 'FOM_HONEST_REPORTING_RULES'], kind: 'ts' },
  { path: '.claude/agents/morty-gate-remediator.md', blocks: ['FOM_EVIDENCE_RULES', 'FOM_HONEST_REPORTING_RULES'], kind: 'md' },

  // WS-3 (ticket a460cad3): persona.md's only automated reach is the Morty worker prompt
  // (spawn-morty.ts:readBasePersona) — a BUILDS surface, not a judging one — but it is the
  // one enumerated WS-3 target and gets both blocks.
  { path: 'persona.md', blocks: ['FOM_EVIDENCE_RULES', 'FOM_HONEST_REPORTING_RULES'], kind: 'md' },
];

// Every prompt surface the discovery sweep can find, that is NOT in FAMILY, MUST be listed
// here with a non-empty reason. A few WS-2 targets (the 3 rubrics + spawn-gate-remediator.ts) are
// NOT reachable by the literal AC-FOMC-1b glob predicate (rubrics live outside the five glob roots;
// spawn-gate-remediator.ts's buildBriefContent is unexported and not `*Prompt`-named) — they were
// added to FAMILY by hand for that reason (sweep coverage doesn't gate FAMILY membership).
const EXCLUDED = [
  // --- PRD "Deferred surfaces" (deliberately out of the required family; reasons on the record) ---
  { path: '.claude/commands/send-to-morty-review.md', reason: 'dead on the autonomous path (R-RWNF): only reachable via spawn-morty --review, no production caller' },
  { path: '.claude/agents/morty-phase-implementer.md', reason: 'default-OFF (PICKLE_PHASE_PERSONAS); infuse when that flag graduates' },
  { path: '.claude/agents/morty-phase-planner.md', reason: 'default-OFF (PICKLE_PHASE_PERSONAS); infuse when that flag graduates' },
  { path: '.claude/agents/morty-phase-researcher.md', reason: 'default-OFF (PICKLE_PHASE_PERSONAS); infuse when that flag graduates' },
  { path: '.claude/agents/morty-phase-reviewer.md', reason: 'default-OFF (PICKLE_PHASE_PERSONAS); infuse when that flag graduates' },
  { path: '.claude/agents/morty-phase-simplifier.md', reason: 'default-OFF (PICKLE_PHASE_PERSONAS); infuse when that flag graduates' },
  { path: '.claude/agents/morty-phase-verifier.md', reason: 'default-OFF (PICKLE_PHASE_PERSONAS); infuse when that flag graduates; sole prose donor for FOM_HONEST_REPORTING_RULES' },
  { path: 'extension/src/bin/archaeology.ts', reason: 'ANALYZE-class, user-invoked, not on the autonomous pipeline hot path' },
  { path: '.claude/agents/morty-debater-architect.md', reason: 'ANALYZE-class debate agent, user-invoked, not on the autonomous pipeline hot path' },
  { path: '.claude/agents/morty-debater-implementer.md', reason: 'ANALYZE-class debate agent, user-invoked, not on the autonomous pipeline hot path' },
  { path: '.claude/agents/morty-debater-researcher.md', reason: 'ANALYZE-class debate agent, user-invoked, not on the autonomous pipeline hot path' },
  { path: '.claude/agents/morty-debater-skeptic.md', reason: 'ANALYZE-class debate agent, user-invoked, not on the autonomous pipeline hot path' },
  { path: '.claude/commands/citadel.md', reason: 'manual /citadel path; the autonomous pipeline runs the in-process analyzer instead — opportunistic follow-up' },

  // --- design-lens / course-correction agents: user-invoked, not on the autonomous pipeline hot path ---
  { path: '.claude/agents/morty-design-common-case.md', reason: 'design-lens agent (death-crystal), user-invoked, not on the autonomous pipeline hot path' },
  { path: '.claude/agents/morty-design-flexible.md', reason: 'design-lens agent (death-crystal), user-invoked, not on the autonomous pipeline hot path' },
  { path: '.claude/agents/morty-design-minimal.md', reason: 'design-lens agent (death-crystal), user-invoked, not on the autonomous pipeline hot path' },
  { path: '.claude/agents/morty-design-ports.md', reason: 'design-lens agent (death-crystal), user-invoked, not on the autonomous pipeline hot path' },
  { path: '.claude/agents/morty-course-corrector.md', reason: 'course-correction agent, user-invoked, not on the autonomous pipeline hot path' },

  // --- worker/DRIVE-class dispatch prompts (BUILDS-class, not judging) ---
  { path: '.claude/agents/morty-implementer.md', reason: 'worker dispatch prompt (BUILDS-class), not a WS-2/WS-3 evidence-judging surface' },
  { path: '.claude/agents/morty-reviewer.md', reason: 'worker dispatch prompt (BUILDS-class), not a WS-2/WS-3 evidence-judging surface' },
  { path: '.claude/commands/send-to-morty.md', reason: 'worker dispatch prompt (BUILDS-class), not a WS-2/WS-3 evidence-judging surface' },
  { path: '.claude/commands/pickle-tmux.md', reason: 'orchestration launch command, not a WS-2/WS-3 evidence-judging surface' },
  { path: '.claude/commands/pickle-zellij.md', reason: 'orchestration launch command, not a WS-2/WS-3 evidence-judging surface' },
  { path: '.claude/commands/anatomy-park.md', reason: 'orchestration/review command; its judging prose lives in the in-process citadel analyzer, not this file' },
  { path: '.claude/commands/szechuan-sauce.md', reason: 'orchestration command; the judge prompt itself is microverse-runner.ts (already enumerated above)' },
  { path: 'extension/src/bin/spawn-morty.ts', reason: 'worker prompt builder (BUILDS-class dispatch); persona.md reach is handled separately under WS-3' },
  { path: 'extension/templates/_pickle-manager-prompt.md', reason: 'manager orchestration/ticket-dispatch template, not a WS-2/WS-3 evidence-judging surface' },

  // --- ANALYZE-class / meta / DOT-pipeline commands: no LLM judgment or evidence-reporting prose ---
  { path: '.claude/commands/pickle-debate.md', reason: 'ANALYZE-class, user-invoked, not on the autonomous pipeline hot path' },
  { path: '.claude/commands/death-crystal.md', reason: 'ANALYZE-class, user-invoked, not on the autonomous pipeline hot path' },
  { path: '.claude/commands/council-of-ricks.md', reason: 'command entry point; the judging prompts live in .claude/workflows/council-round.js (already enumerated above)' },
  { path: '.claude/commands/add-to-pickle-jar.md', reason: 'utility/meta command; no LLM judgment or evidence-reporting prompt content' },
  { path: '.claude/commands/disable-pickle.md', reason: 'utility/meta command; no LLM judgment or evidence-reporting prompt content' },
  { path: '.claude/commands/eat-pickle.md', reason: 'utility/meta command; no LLM judgment or evidence-reporting prompt content' },
  { path: '.claude/commands/enable-pickle.md', reason: 'utility/meta command; no LLM judgment or evidence-reporting prompt content' },
  { path: '.claude/commands/help-pickle.md', reason: 'utility/meta command; no LLM judgment or evidence-reporting prompt content' },
  { path: '.claude/commands/pickle-metrics.md', reason: 'utility/meta command; no LLM judgment or evidence-reporting prompt content' },
  { path: '.claude/commands/pickle-status.md', reason: 'utility/meta command; no LLM judgment or evidence-reporting prompt content' },
  { path: '.claude/commands/pickle-recover.md', reason: 'utility/meta command; no LLM judgment or evidence-reporting prompt content' },
  { path: '.claude/commands/pickle-retry.md', reason: 'utility/meta command; no LLM judgment or evidence-reporting prompt content' },
  { path: '.claude/commands/pickle-jar-open.md', reason: 'orchestration/meta command; no LLM judgment or evidence-reporting prompt content of its own' },
  { path: '.claude/commands/pickle-microverse.md', reason: 'orchestration/meta command; no LLM judgment or evidence-reporting prompt content of its own' },
  { path: '.claude/commands/pickle-pipeline.md', reason: 'orchestration/meta command; no LLM judgment or evidence-reporting prompt content of its own' },
  { path: '.claude/commands/pickle-standup.md', reason: 'reporting/meta command; no LLM judgment or evidence-reporting prompt content of its own' },
  { path: '.claude/commands/pickle-prd.md', reason: 'PRD-drafting interview prompt, not a judging surface' },
  { path: '.claude/commands/attract.md', reason: 'DOT-pipeline submission command; no LLM judgment prose' },
  { path: '.claude/commands/pickle-dot.md', reason: 'DOT-pipeline conversion command; no LLM judgment prose' },
  { path: '.claude/commands/pickle-dot-patterns.md', reason: 'DOT-pipeline pattern reference; no LLM judgment prose' },
  { path: '.claude/commands/plumbus.md', reason: 'DOT-pipeline shaping loop command; no LLM judgment prose' },
  { path: '.claude/commands/portal-gun.md', reason: 'cross-codebase pattern-extraction command; no LLM judgment prose' },
  { path: '.claude/commands/project-mayhem.md', reason: 'chaos-engineering command; no LLM judgment prose' },
  { path: '.claude/commands/cronenberg.md', reason: 'meta-router command; no LLM judgment prose of its own' },
  { path: '.claude/commands/codex-rescue.md', reason: 'sub-tool delegation wrapper; no LLM judgment prose of its own' },
];

function stripBlock(content, block) {
  const startIdx = content.indexOf(block.start);
  const endIdx = content.indexOf(block.end);
  if (startIdx === -1 || endIdx === -1) return content;
  return content.slice(0, startIdx) + content.slice(endIdx + block.end.length);
}

// The SHARED helper — both the (currently empty) live per-FAMILY-entry assertions and the
// red-proof below call this exact function. No test-local re-derivation (AC-DR-05 guard).
function assertMdCarriesBlock(filePath, content, blockKey) {
  const block = FOM_BLOCKS[blockKey];
  const startIdx = content.indexOf(block.start);
  const endIdx = content.indexOf(block.end);
  assert.notStrictEqual(startIdx, -1, `${filePath} missing BEGIN ${blockKey} marker`);
  assert.notStrictEqual(endIdx, -1, `${filePath} missing END ${blockKey} marker`);
  assert.ok(endIdx > startIdx, `${filePath} END ${blockKey} marker appears before BEGIN`);
  const between = content.slice(startIdx + block.start.length, endIdx);
  assert.ok(
    between.includes(block.constant),
    `${filePath} does not carry the exact ${blockKey} constant string between its sentinels`,
  );
}

// --- AC-FOMC-13: each constant is thin ---
test('fom-blocks: each constant is <=5 lines and <=400 bytes', () => {
  for (const [key, block] of Object.entries(FOM_BLOCKS)) {
    const lines = block.constant.split('\n');
    assert.ok(lines.length <= 5, `${key} has ${lines.length} lines, must be <=5`);
    const bytes = Buffer.byteLength(block.constant, 'utf8');
    assert.ok(bytes <= 400, `${key} is ${bytes} bytes, must be <=400`);
  }
});

// --- AC-FOMC-2(a)/(e): no backtick, no ${, epistemics only ---
test('fom-blocks: no backtick, no ${, no output-format instruction in the prose', () => {
  const outputFormatPhrases = ['report your findings as', 'emit the following', 'respond with', 'output format', 'return json', 'schema'];
  for (const [key, block] of Object.entries(FOM_BLOCKS)) {
    assert.ok(!block.constant.includes('`'), `${key} prose must not contain a backtick`);
    assert.ok(!block.constant.includes('${'), `${key} prose must not contain the sequence dollar-brace`);
    const lower = block.constant.toLowerCase();
    for (const phrase of outputFormatPhrases) {
      assert.ok(!lower.includes(phrase), `${key} prose must not carry an output-format/emission instruction ("${phrase}")`);
    }
  }
});

// --- AC-FOMC-11a(a): compiled mirror carries each block verbatim ---
test('fom-blocks: compiled mirror extension/services/fom-blocks.js contains each block verbatim', () => {
  const compiledPath = path.join(repoRoot, 'extension', 'services', 'fom-blocks.js');
  assert.ok(fs.existsSync(compiledPath), 'extension/services/fom-blocks.js not found — run npx tsc');
  const compiled = fs.readFileSync(compiledPath, 'utf8');
  for (const [key, block] of Object.entries(FOM_BLOCKS)) {
    assert.ok(compiled.includes(block.constant), `compiled fom-blocks.js is missing the ${key} string verbatim`);
  }
});

// --- AC-FOMC-1 red-proof: the SHARED helper throws when a surface's block is stripped ---
test('fom-infusion red-proof: assertMdCarriesBlock throws when the block is stripped (same helper as live assertions)', () => {
  const donor = FOM_BLOCKS.FOM_HONEST_REPORTING_RULES;
  const syntheticContent = [donor.start, donor.constant, donor.end, '', 'some other prompt content'].join('\n');
  // Sanity: the helper accepts a well-formed surface first.
  assert.doesNotThrow(() => assertMdCarriesBlock('synthetic-surface.md', syntheticContent, 'FOM_HONEST_REPORTING_RULES'));
  // The red-proof: strip the block, feed the SAME helper, assert it throws.
  const stripped = stripBlock(syntheticContent, donor);
  assert.throws(() => assertMdCarriesBlock('synthetic-surface-stripped.md', stripped, 'FOM_HONEST_REPORTING_RULES'));
});

// --- AC-FOMC-1: live per-surface assertions over FAMILY. Only `md`-kind surfaces carry the block
// as a literal sentinel-wrapped string (assertMdCarriesBlock's contract); `ts` surfaces import the
// constant (verified by tsFamilyEntries below — the source text never literally re-types the prose,
// per AC-FOMC-2(b)) and `workflow-js` surfaces carry it as a top-level const (verified by
// workflowFamilyEntries below). ---
const mdFamilyEntries = FAMILY.filter((e) => e.kind === 'md');
for (const entry of mdFamilyEntries) {
  test(`fom-infusion: ${entry.path} carries its required FOM block(s)`, () => {
    const abs = path.join(repoRoot, entry.path);
    const content = fs.readFileSync(abs, 'utf8');
    for (const blockKey of entry.blocks) {
      assertMdCarriesBlock(entry.path, content, blockKey);
    }
  });
}

// --- AC-FOMC-2(b): enumerated .ts builders import the constant, never re-type it ---
const tsFamilyEntries = FAMILY.filter((e) => e.kind === 'ts');
for (const entry of tsFamilyEntries) {
  test(`fom-infusion: ${entry.path} imports the FOM constant(s) rather than re-typing them`, () => {
    const abs = path.join(repoRoot, entry.path);
    const content = fs.readFileSync(abs, 'utf8');
    for (const blockKey of entry.blocks) {
      assert.ok(
        new RegExp(`import\\s*\\{[^}]*\\b${blockKey}\\b[^}]*\\}\\s*from`).test(content),
        `${entry.path} must import ${blockKey} from fom-blocks, not re-type it inline`,
      );
    }
  });
}

// --- AC-FOMC-2(d): .claude/workflows/*.js twins carry the block as ONE top-level const assigned
// a single unindented template literal at column 0; [...].join('\n') is FORBIDDEN for FOM blocks ---
const workflowFamilyEntries = FAMILY.filter((e) => e.kind === 'workflow-js');
for (const entry of workflowFamilyEntries) {
  test(`fom-infusion: ${entry.path} carries its block as an unindented top-level const (no join array)`, () => {
    const abs = path.join(repoRoot, entry.path);
    const content = fs.readFileSync(abs, 'utf8');
    for (const blockKey of entry.blocks) {
      const block = FOM_BLOCKS[blockKey];
      assert.ok(content.includes(block.constant), `${entry.path} must carry the ${blockKey} string as a contiguous substring`);
      assert.ok(
        new RegExp(`^const\\s+${blockKey}\\s*=\\s*\``, 'm').test(content),
        `${entry.path} must assign ${blockKey} via a single top-level unindented template literal at column 0`,
      );
      assert.ok(
        !new RegExp(`${blockKey}[\\s\\S]{0,300}\\]\\s*\\.join\\(`).test(content),
        `${entry.path}: [...].join(...) is FORBIDDEN for the ${blockKey} FOM block — use one contiguous template literal`,
      );
    }
  });
}

// --- AC-FOMC-11a(b): each enumerated .ts builder's COMPILED mirror imports the block symbol ---
for (const entry of tsFamilyEntries) {
  test(`fom-infusion: compiled mirror of ${entry.path} imports (never inlines) the FOM constant`, () => {
    const compiledRel = entry.path.replace(/^extension\/src\//, 'extension/').replace(/\.ts$/, '.js');
    const compiledAbs = path.join(repoRoot, compiledRel);
    assert.ok(fs.existsSync(compiledAbs), `compiled mirror not found: ${compiledRel} — run npx tsc`);
    const compiled = fs.readFileSync(compiledAbs, 'utf8');
    for (const blockKey of entry.blocks) {
      assert.ok(
        new RegExp(`import\\s*\\{[^}]*\\b${blockKey}\\b[^}]*\\}\\s*from\\s*['"].*fom-blocks(\\.js)?['"]`).test(compiled),
        `compiled ${compiledRel} must import ${blockKey} from fom-blocks.js`,
      );
    }
  });
}

// --- AC-FOMC-3: no deployed prompt surface carries an unresolvable FOM citation. The PRD names this
// the regression pin that keeps the door shut (a `(FOM §N)` / "see the operating manual" citation that
// resolves to nothing is the failure mode the whole bundle exists to eliminate). It was green at HEAD
// but pinned by NOTHING in the suite — only a manual grep. This test opens every family + excluded +
// discovered surface (the same space the sweep governs) and asserts the citation never appears. ---
const UNRESOLVABLE_FOM_CITATION_RE = /FOM §|see the operating manual|FABLE_OPERATING_MANUAL/i;
test('fom-infusion AC-FOMC-3: no deployed prompt surface carries an unresolvable FOM citation', () => {
  const surfaces = new Set([
    ...FAMILY.map((e) => e.path),
    ...EXCLUDED.map((e) => e.path),
    ...discoverPromptSurfaces(),
  ]);
  const offenders = [];
  for (const rel of surfaces) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, 'utf8');
    const m = UNRESOLVABLE_FOM_CITATION_RE.exec(content);
    if (m) offenders.push(`${rel} (matched "${m[0]}")`);
  }
  assert.deepStrictEqual(
    offenders,
    [],
    `deployed prompt surface(s) carry an unresolvable FOM citation: ${offenders.join(', ')}`,
  );
});

// --- AC-FOMC-1b: discovery sweep over the five glob classes AC-FOMC-1b names ---
function discoverPromptSurfaces() {
  const discovered = new Set();
  const globDir = (dir, ext) => {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) return;
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith(ext)) discovered.add(path.join(dir, f));
    }
  };
  globDir('.claude/agents', '.md');
  globDir('.claude/commands', '.md');
  globDir('.claude/workflows', '.js');
  const templatesDir = path.join(repoRoot, 'extension', 'templates');
  if (fs.existsSync(templatesDir)) {
    for (const f of fs.readdirSync(templatesDir)) {
      if (f.startsWith('_') && f.endsWith('.md')) discovered.add(path.join('extension', 'templates', f));
    }
  }
  if (fs.existsSync(path.join(repoRoot, 'persona.md'))) discovered.add('persona.md');
  const binDir = path.join(repoRoot, 'extension', 'src', 'bin');
  if (fs.existsSync(binDir)) {
    for (const f of fs.readdirSync(binDir)) {
      if (!f.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(binDir, f), 'utf8');
      if (/export\s+(const|function)\s+(\w*Prompt\w*|build\w*Prompt)\b/.test(content)) {
        discovered.add(path.join('extension', 'src', 'bin', f));
      }
    }
  }
  return discovered;
}

// The SHARED sweep-assertion helper — both the live sweep test and the negative test call this.
function assertSweepCoversDiscovered(discovered, familyPaths, excludedPaths) {
  const unclassified = [];
  for (const p of discovered) {
    if (!familyPaths.has(p) && !excludedPaths.has(p)) unclassified.push(p);
  }
  assert.deepStrictEqual(
    unclassified,
    [],
    `discovered prompt surface(s) unclassified (neither FAMILY nor EXCLUDED): ${unclassified.join(', ')}`,
  );
}

// AC-FOMC-4b: an EXCLUDED entry needs a REAL reason, not a placeholder. A bare `pending`/`todo`/etc.
// is non-empty but carries no classification — the exact "pending reason" AC-FOMC-4b forbids. Anchored
// whole-string match so a legitimate reason that merely contains the word "pending" mid-sentence is safe.
const PLACEHOLDER_REASON_RE = /^(pending|todo|tbd|fixme|xxx|placeholder|n\/a|-)$/i;
test('fom-infusion sweep: every discovered prompt surface is in FAMILY or EXCLUDED with a non-empty reason', () => {
  for (const entry of EXCLUDED) {
    assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length > 0, `EXCLUDED entry ${entry.path} has an empty reason`);
    assert.ok(
      !PLACEHOLDER_REASON_RE.test(entry.reason.trim()),
      `EXCLUDED entry ${entry.path} carries a placeholder reason ("${entry.reason.trim()}") — AC-FOMC-4b forbids pending/TODO reasons`,
    );
  }
  const discovered = discoverPromptSurfaces();
  const familyPaths = new Set(FAMILY.map((e) => e.path));
  const excludedPaths = new Set(EXCLUDED.map((e) => e.path));
  assertSweepCoversDiscovered(discovered, familyPaths, excludedPaths);
});

// --- AC-FOMC-1b-neg: prove the sweep actually fires on an unclassified surface ---
test('fom-infusion sweep: a synthetic unclassified surface makes the sweep throw', () => {
  const discovered = discoverPromptSurfaces();
  discovered.add(path.join('extension', 'src', 'bin', 'synthetic-unclassified-surface.ts'));
  const familyPaths = new Set(FAMILY.map((e) => e.path));
  const excludedPaths = new Set(EXCLUDED.map((e) => e.path));
  assert.throws(() => assertSweepCoversDiscovered(discovered, familyPaths, excludedPaths));
});

// --- ticket a4038d7c: OUTPUT-splice — the block reaches the ASSEMBLED prompt, not merely the file.
// The tests above prove each surface CARRIES its block (md sentinel / ts import / workflow const).
// They do NOT prove the builder SPLICES the imported constant into the string it returns — a
// regression that keeps the import but drops the `parts.push(...)`/`${...}` splice ships green.
// These exercise the actual constant → builder → prompt-string flow the ticket calls CRITICAL. ---

// The two builders whose assembled output is directly callable get real output assertions.
test('fom-infusion output-splice: buildJudgePrompt output carries FOM_HONEST_REPORTING_RULES', () => {
  const prompt = buildJudgePrompt('fix bugs', '/tmp');
  assert.ok(
    prompt.includes(FOM_HONEST_REPORTING_RULES),
    'buildJudgePrompt must splice FOM_HONEST_REPORTING_RULES into the returned judge prompt, not merely import it',
  );
});

for (const role of ['requirements', 'codebase', 'risk-scope']) {
  test(`fom-infusion output-splice: buildWorkerPrompt(${role}) output carries BOTH FOM blocks`, () => {
    const prompt = buildWorkerPrompt(role, '# PRD', '/tmp/out.md', '/tmp/wd', 1);
    assert.ok(
      prompt.includes(FOM_EVIDENCE_RULES),
      `buildWorkerPrompt(${role}) must splice FOM_EVIDENCE_RULES into the returned analyst prompt`,
    );
    assert.ok(
      prompt.includes(FOM_HONEST_REPORTING_RULES),
      `buildWorkerPrompt(${role}) must splice FOM_HONEST_REPORTING_RULES into the returned analyst prompt`,
    );
  });
}

// The remaining builders cannot be imported and called in isolation without breaching the scope
// fence (workflow twins are Workflow-runtime meta-scripts with top-level await + the `agent()`
// global; spawn-gate-remediator's buildBriefContent is unexported and exporting it would widen the
// bin/ Module Export Catalog outside MODIFIED_FILES). Guard their splice TEXTUALLY: assert each
// imported/declared const is actually consumed in a splice position, not merely declared.
const SPLICE_GUARDS = [
  // Workflow twins splice via `${BLOCK}` interpolation in a returned template literal.
  { path: '.claude/workflows/refine-analyze.js', blocks: ['FOM_EVIDENCE_RULES', 'FOM_HONEST_REPORTING_RULES'], splice: (b) => new RegExp(`\\$\\{\\s*${b}\\s*\\}`) },
  { path: '.claude/workflows/council-round.js', blocks: ['FOM_EVIDENCE_RULES', 'FOM_HONEST_REPORTING_RULES'], splice: (b) => new RegExp(`\\$\\{\\s*${b}\\s*\\}`) },
  // The remediator brief splices via `sections.push(BLOCK ...)`.
  { path: 'extension/src/bin/spawn-gate-remediator.ts', blocks: ['FOM_EVIDENCE_RULES', 'FOM_HONEST_REPORTING_RULES'], splice: (b) => new RegExp(`\\.push\\(\\s*${b}\\b`) },
];
for (const entry of SPLICE_GUARDS) {
  test(`fom-infusion output-splice: ${entry.path} consumes (not merely declares) its FOM block(s)`, () => {
    const content = fs.readFileSync(path.join(repoRoot, entry.path), 'utf8');
    for (const blockKey of entry.blocks) {
      assert.ok(
        entry.splice(blockKey).test(content),
        `${entry.path} imports/declares ${blockKey} but never splices it into an assembled prompt`,
      );
    }
  });
}
