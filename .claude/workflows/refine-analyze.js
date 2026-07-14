export const meta = {
  name: 'refine-prd',
  description: 'Decompose a PRD into atomic, verification-ready tickets via a parallel analyst team (3 roles × N cycles), then synthesize the refined PRD + manifest',
  phases: ['analyze', 'synthesize'],
};

// ---------------------------------------------------------------------------
// R-DWF-2 — Dynamic Workflow conversion of /pickle-refine-prd's analyst fan-out.
//
// Constraints honored (PRD §"The dynamic-workflow primitive"):
//   * No filesystem or shell from this script body — every artifact write happens
//     INSIDE a spawned agent, targeting the ABSOLUTE session dir passed via args.
//   * No module imports — every schema and *Prompt helper is an in-script literal.
//   * No worktree-mode flag and no model-tier pin (workflow agents are always Claude;
//     this satisfies the PICKLE_REFINEMENT_LOCK claude-force for free).
//   * No wall-clock or randomness builtins (the runtime forbids them in the body); the
//     synthesis AGENT stamps `completed_at` (date-time), never this script.
//   * Cross-cycle context flows through the `prior` SCRIPT VARIABLE — NOT by re-reading
//     analysis files from disk. The legacy bin's previous-cycle disk re-read helper is
//     intentionally NOT reproduced here (trap door R-DWF-CROSSCYCLE-VARS).
// ---------------------------------------------------------------------------

// B-FOMC WS-1 single source (extension/src/services/fom-blocks.ts), carried verbatim per
// the workflow-js contract: one top-level unindented template literal per block, never
// `[...].join('\n')`'d (the shape test forbids that form for FOM blocks specifically).
const FOM_EVIDENCE_RULES = `## Evidence rules
A resolving path is not a verified claim; a missing path may be a proposed file, not a fabrication.
Verify the claim itself, not whether a token resolves.`;
const FOM_HONEST_REPORTING_RULES = `## Honest reporting
Silence is not success. A fast clean pass may mean the gate never fired, not that it passed.
Never report an outcome you did not observe; verify before declaring a verdict.`;

const ROLES = ['requirements', 'codebase', 'risk-scope'];

const ROLE_LABELS = {
  requirements: 'Requirements Analyst',
  codebase: 'Codebase Context Analyst',
  'risk-scope': 'Risk & Scope Auditor',
};

const ROLE_INSTRUCTIONS = {
  requirements:
    'Analyze the PRD EXCLUSIVELY for requirements completeness: critical user journeys, the '
    + 'functional-requirements table (P0/P1/P2), testable acceptance criteria, edge/boundary cases, '
    + 'and user-story specificity. Do NOT analyze risk, scope, architecture, or the codebase.',
  codebase:
    'Analyze alignment between the PRD and the actual codebase at the working dir. Use Glob/Grep/Read '
    + 'to map existing patterns. Flag PRD assumptions about components that do not exist, missing '
    + 'technical constraints, integration points, and unspecified technical decisions. Use file:line '
    + 'references you have verified for every codebase claim; mark anything unverified as a hypothesis.',
  'risk-scope':
    'Analyze the PRD EXCLUSIVELY for risk, scope, and assumptions: scope clarity, non-goals / scope '
    + 'creep, risk completeness, mitigation quality, hidden assumptions, and under-specified external '
    + 'dependencies. Do NOT analyze feature completeness or codebase patterns.',
};

// In-script JSON-Schema literal for one ac-shape smell (mirrors
// refinement-manifest.schema.json#/properties/ac_shape_smells/items).
const AC_SHAPE_SMELL_ITEM = {
  type: 'object',
  required: ['ac_id'],
  properties: {
    ac_id: { type: 'string', minLength: 1 },
    headline: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    targets: { type: 'array', items: { type: 'string' } },
    repeated_predicate: { type: 'string' },
    ticket_ids: { type: 'array', items: { type: 'string' } },
  },
};

// In-script JSON-Schema literal for one analyst-proposed ticket hint
// (mirrors refinement-manifest.schema.json#/properties/tickets/items).
const TICKET_HINT_ITEM = {
  type: 'object',
  required: ['id', 'title', 'source_ac_ids'],
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    source_ac_ids: { type: 'array', items: { type: 'string' } },
    acceptance_test: { type: 'string' },
    justification: { type: 'string' },
    mapped_requirements: { type: 'array', items: { type: 'string' } },
  },
};

// Per-analyst structured return. The schema-validated `ac_shape_smells` field REPLACES the
// legacy fenced `## ac_shape_smells` JSON tail parsed at spawn-refinement-team.ts. The manifest
// contract it feeds is unchanged, so B-ACSG's matcher hardening (isParametrizedTicket /
// hasJustificationBlock, operating on manifest.tickets+ac_shape_smells) still applies downstream
// (see research §Finding 5: compatible-not-superseded).
const AnalysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'executive_summary', 'p0_gaps', 'ac_shape_smells', 'markdown_body'],
  properties: {
    role: { type: 'string', enum: ROLES },
    executive_summary: { type: 'string', minLength: 1 },
    p0_gaps: { type: 'array', items: { type: 'string' } },
    p1_gaps: { type: 'array', items: { type: 'string' } },
    ac_shape_smells: { type: 'array', items: AC_SHAPE_SMELL_ITEM },
    tickets: { type: 'array', items: TICKET_HINT_ITEM },
    markdown_body: { type: 'string', minLength: 1 },
  },
};

// The synthesis agent's structured return — an in-script mirror of
// refinement-manifest.schema.json. The agent both WRITES refinement_manifest.json to the
// absolute session dir AND returns this object so the launching skill can consume it without a
// stdout MANIFEST= parse. `completed_at` is generated by the agent (this script cannot call Date).
const ManifestSchema = {
  type: 'object',
  required: [
    'prd_path', 'refinement_dir', 'all_success', 'cycles_requested', 'cycles_completed',
    'max_turns_per_worker', 'ac_shape_smells', 'tickets', 'workers', 'completed_at',
  ],
  properties: {
    prd_path: { type: 'string', minLength: 1 },
    refinement_dir: { type: 'string', minLength: 1 },
    all_success: { type: 'boolean' },
    cycles_requested: { type: 'integer', minimum: 1 },
    cycles_completed: { type: 'integer', minimum: 0 },
    max_turns_per_worker: { type: 'integer', minimum: 0 },
    ac_shape_smells: { type: 'array', items: AC_SHAPE_SMELL_ITEM },
    tickets: { type: 'array', items: TICKET_HINT_ITEM },
    workers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['role', 'success', 'output_file', 'exists', 'log_file', 'cycle'],
        properties: {
          role: { type: 'string', minLength: 1 },
          success: { type: 'boolean' },
          output_file: { type: 'string' },
          exists: { type: 'boolean' },
          log_file: { type: 'string' },
          cycle: { type: 'integer', minimum: 1 },
        },
      },
    },
    // NOTE: `format: 'date-time'` is unsupported by the Workflow-runtime AJV
    // (no ajv-formats plugin), which silently rejected the synthesis manifest
    // and produced no output (B-DWF-2 soak finding). Validate as a non-empty
    // string instead — the synthesis agent stamps a real ISO-8601 timestamp.
    completed_at: { type: 'string', minLength: 1 },
  },
};

const AC_SHAPE_CONTRACT = [
  '## AC-Shape Smell Pass',
  'Inspect every acceptance criterion for endpoint-enumeration shape: the headline lacks a universal',
  'quantifier ("all"/"every"/"for any"), the body has 3+ bullets naming distinct endpoints/handlers/',
  'methods, and those bullets repeat the same predicate. For every match, either collapse to one',
  'parametrized ticket or justify why multiple tickets are necessary. Return matches in the',
  'schema-validated `ac_shape_smells` array (empty array if none); do NOT emit a fenced JSON tail.',
].join('\n');

// Build one analyst's prompt. For cycle > 1, the `prior` SCRIPT VARIABLE (the previous cycle's
// validated analyses) is embedded directly — no analysis_*.md is read from disk.
function analystPrompt(role, prdPath, workingDir, refinementDir, cycle, prior) {
  const persona =
    'You are Pickle Rick — hyper-competent, arrogant, ruthlessly thorough. Output a text brain-dump '
    + 'before every tool call. Jerries write vague analysis; you write SPECIFIC, evidence-backed findings.';

  let crossRef = '';
  if (cycle > 1 && Array.isArray(prior) && prior.length > 0) {
    const blocks = prior.map((a) => {
      const label = ROLE_LABELS[a.role] || a.role;
      const own = a.role === role ? ' (YOUR OWN — improve on it)' : '';
      return `### ${label}'s Cycle ${cycle - 1} findings${own}:\n${a.markdown_body}`;
    });
    crossRef = [
      '',
      `## Previous Cycle Analyses (Cycle ${cycle - 1} — cross-reference these)`,
      'Go DEEPER on under-explored issues, cross-reference other analysts, eliminate duplicates, and',
      'raise new issues visible only across the full picture. These findings came from the prior cycle',
      'and are provided inline — do not re-read any files to obtain them.',
      '',
      ...blocks,
    ].join('\n');
  }

  const body = [
    persona,
    '',
    `## Your Role: ${ROLE_LABELS[role]} Morty`,
    ROLE_INSTRUCTIONS[role],
    `Working dir: ${workingDir}`,
    crossRef,
    '',
    AC_SHAPE_CONTRACT,
    '',
    '## The PRD You Are Analyzing',
    `Read the PRD at the absolute path: ${prdPath}`,
    '',
    '## Your Output',
    `1. Write your full markdown analysis to the ABSOLUTE path ${refinementDir}/analysis_${role}.md.`,
    `2. Return the structured object: role="${role}", a 2-3 sentence executive_summary, p0_gaps[],`,
    '   optional p1_gaps[], ac_shape_smells[] (per the AC-Shape contract above), optional ticket',
    `   hints[], and the full markdown text in markdown_body. THIS IS CYCLE ${cycle}.`,
  ].join('\n');
  return `${body}\n\n${FOM_EVIDENCE_RULES}\n\n${FOM_HONEST_REPORTING_RULES}`;
}

// Build the synthesis agent's prompt. It receives the final-cycle analyses inline (script vars),
// writes prd_refined.md + refinement_manifest.json to the absolute session dir, and returns the
// manifest object.
function synthPrompt(prdPath, sessionDir, refinementDir, analyses, cycles, maxTurns, allSuccess) {
  const findings = analyses
    .map((a) => `### ${ROLE_LABELS[a.role] || a.role}\n${a.markdown_body}`)
    .join('\n\n');
  const body = [
    'You are Pickle Rick synthesizing a final refined PRD from the analyst team\'s findings.',
    '',
    '## Inputs',
    `Original PRD (absolute path): ${prdPath}`,
    `Session dir (absolute): ${sessionDir}`,
    `Refinement dir (absolute): ${refinementDir}`,
    `Cycles requested: ${cycles}. Max turns per worker: ${maxTurns}. All analysts succeeded: ${allSuccess}.`,
    '',
    '## Final-cycle analyses (already in context — do NOT re-read analysis files)',
    findings,
    '',
    '## Tasks',
    `1. Write the synthesized refined PRD to the ABSOLUTE path ${sessionDir}/prd_refined.md`,
    '   (additive over the original; P0 gaps first; every requirement machine-checkable).',
    `2. Aggregate ac_shape_smells and analyst ticket hints across all analyses and write the manifest`,
    `   to the ABSOLUTE path ${sessionDir}/refinement_manifest.json with this exact shape:`,
    '   { prd_path, refinement_dir, all_success, cycles_requested, cycles_completed,',
    '     max_turns_per_worker, ac_shape_smells[], tickets[], workers[], completed_at }.',
    `   workers[] has one entry per role (${ROLES.join(', ')}) with`,
    '     { role, success, output_file (absolute analysis_<role>.md), exists, log_file:"", cycle }.',
    '   completed_at is the current time as an ISO-8601 date-time string.',
    '3. Return that same manifest object as your structured result.',
  ].join('\n');
  return `${body}\n\n${FOM_EVIDENCE_RULES}\n\n${FOM_HONEST_REPORTING_RULES}`;
}

// --------------------------------- body -----------------------------------

const {
  prdPath,
  sessionDir,
  workingDir,
  refinementDir = `${sessionDir}/refinement`,
  cycles = 3,
  maxTurns = 100,
} = args ?? {};

// Fail-fast on missing required inputs. Without this guard, undefined prdPath /
// sessionDir flow into agent prompts ("Original PRD: undefined", manifest path
// "undefined/refinement_manifest.json") and the run stalls without producing a
// manifest (B-DWF-2 soak: a missing-args invocation hung ~34 min). A clear throw
// surfaces the caller's wiring bug immediately instead.
const _missing = ['prdPath', 'sessionDir', 'workingDir'].filter((k) => !{ prdPath, sessionDir, workingDir }[k]);
if (_missing.length > 0) {
  throw new Error(`refine-analyze workflow: missing required args [${_missing.join(', ')}]. The launcher must pass args={prdPath, sessionDir, workingDir[, refinementDir, cycles, maxTurns]}.`);
}

let prior = null;
let analyses = [];

for (let c = 1; c <= cycles; c++) {
  phase('analyze');
  analyses = (
    await parallel(
      ROLES.map((role) => () =>
        agent(analystPrompt(role, prdPath, workingDir, refinementDir, c, prior), {
          label: `analyst-${role}-c${c}`,
          phase: 'analyze',
          schema: AnalysisSchema,
        })),
    )
  ).filter(Boolean);
  if (analyses.length < ROLES.length) {
    log(`cycle ${c}: ${ROLES.length - analyses.length} analyst(s) failed`);
  }
  prior = analyses; // cross-cycle context lives in this script variable — no disk round-trip
}

const allSuccess = analyses.length === ROLES.length;

phase('synthesize');
const manifest = await agent(
  synthPrompt(prdPath, sessionDir, refinementDir, analyses, cycles, maxTurns, allSuccess),
  { label: 'synthesize', phase: 'synthesize', schema: ManifestSchema },
);

return {
  sessionDir,
  refinementDir,
  manifestPath: `${sessionDir}/refinement_manifest.json`,
  manifest,
  analyses,
  allSuccess,
};
