export const meta = {
  name: 'council-round',
  description: 'One Council of Ricks review round over a Graphite stack',
  phases: ['A-historical', 'B-categories', 'C-branches', 'C-codex', 'D-synthesis'],
};

// ---------------------------------------------------------------------------
// R-DWF-4 — Dynamic Workflow conversion of the INSIDE of one /council-of-ricks
// round. mux-runner stays the round/loop/state driver (R-DWF-5) and owns the
// PICKLE_COUNCIL_WORKFLOW kill-switch; this script converts only one round.
//
// Constraints honored (PRD §"Workstream B" + the dynamic-workflow primitive):
//   * No filesystem or shell from this script body — every git/gh/codex shell-out
//     and every artifact write (historical brief, council-directive.json, summary
//     append) happens INSIDE a spawned agent, targeting the ABSOLUTE session dir
//     passed via `args.sessionFiles`.
//   * No module imports — `planFanOut` and every schema/prompt are in-script literals.
//     `planFanOut` is a verbatim plain-JS port of council-fanout.ts:29-77 (type
//     annotations + the `KnownCategory` import stripped).
//   * No worktree-mode flag and no model-tier pin; no Date/Math.random builtins.
//   * R-DWF-NO-REPO-EDIT: the review judges (every Phase B + C_correctness agent)
//     run as the read-only built-in `Explore` agentType — they cannot Edit/Write
//     repo files. The historical / codex-sweep / synthesis agents legitimately
//     write under the session dir + run git/gh/codex, so they keep the default
//     workflow agent type and are prompt-constrained to session-dir-only writes.
//   * R-DWF-STATE-FIREWALL: no agent writes state.json (config-protection enforces).
//   * validateDirective + council-publish.ts stay EXTERNAL (publisher path unchanged).
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

// Mirror of council-schema.ts:63-75 (the 11 KNOWN_CATEGORIES).
const KNOWN_CATEGORIES = [
  'B1_stack_structure',
  'B2_claude_md',
  'B3_contract_discovery',
  'B4_cross_branch',
  'B5_test_coverage',
  'B6_security',
  'B7_migration_hygiene',
  'B8_szechuan',
  'B9_polish',
  'C_correctness',
  'C_codex',
];

// Mirror of council-fanout.ts:16-25.
const UNCONDITIONAL_B_CATEGORIES = [
  'B1_stack_structure',
  'B2_claude_md',
  'B3_contract_discovery',
  'B4_cross_branch',
  'B5_test_coverage',
  'B6_security',
  'B8_szechuan',
  'B9_polish',
];

// Mirror of council-fanout.ts:27.
const SHARDED_TIERS = ['l', 'xl', 'xxl'];

// Documented concurrency ceiling for a workflow `parallel()` wave: min(16, cores−2)
// (PRD p2-dynamic-workflow-conversion §"Concurrency cap"). The RUNTIME enforces the actual
// per-machine cap (= min(16, cores−2)) and transparently queues excess thunks across sweeps;
// this script body has no Node/OS access so it cannot read the core count. `16` is the upper
// bound, so `specs.length > 16` is a GUARANTEED-capped fan-out on every machine — the honest
// trigger for the sharded-tier batching announcement below (R-DWF-5 / AC-DWF-05).
const MAX_FANOUT_CONCURRENCY = 16;

// In-script JSON-Schema (draft-07) literal mirroring council-schema.ts SubagentPayload
// (:79-87) + validateSubagentPayload (:288-317). It accepts EXACTLY the payload set the
// TS validator accepts (round-trip parity, R-DWF-SCHEMA-PARITY):
//   * NO `additionalProperties:false` at any level — validateSubagentPayload ignores
//     unknown keys, so a strict schema would reject extra-key payloads it accepts.
//   * Every finding's five nullable fields are REQUIRED keys (requireNullableString
//     fails on absence, not just on bad type).
//   * `skip_reason` non-empty iff `status==='skipped'`, expressed via if/then/else.
const FINDING_SCHEMA = {
  type: 'object',
  required: [
    'severity', 'confidence', 'source', 'file', 'line', 'rule', 'description',
    'recommendation', 'line_range', 'data_flow', 'scenario', 'snippet_before', 'snippet_after',
  ],
  properties: {
    severity: { enum: ['P0', 'P1', 'P2', 'P3', 'P4'] },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    source: { enum: ['COUNCIL', 'CODEX', 'COUNCIL+CODEX'] },
    file: { type: 'string', minLength: 1 },
    line: { type: 'integer', minimum: 1 },
    rule: { type: 'string' },
    description: { type: 'string' },
    recommendation: { type: 'string' },
    line_range: { type: ['string', 'null'] },
    data_flow: { type: ['string', 'null'] },
    scenario: { type: ['string', 'null'] },
    snippet_before: { type: ['string', 'null'] },
    snippet_after: { type: ['string', 'null'] },
  },
};

const TRAPDOOR_SCHEMA = {
  type: 'object',
  required: ['path', 'constraint', 'why_it_breaks', 'what_must_hold'],
  properties: {
    path: { type: 'string', minLength: 1 },
    constraint: { type: 'string', minLength: 1 },
    why_it_breaks: { type: 'string', minLength: 1 },
    what_must_hold: { type: 'string', minLength: 1 },
  },
};

const SUBAGENT_PAYLOAD_SCHEMA = {
  type: 'object',
  required: [
    'category', 'branch', 'status', 'skip_reason', 'findings',
    'trap_door_candidates', 'codex_per_branch',
  ],
  properties: {
    category: { enum: KNOWN_CATEGORIES },
    branch: { type: ['string', 'null'] },
    status: { enum: ['ok', 'skipped'] },
    skip_reason: { type: ['string', 'null'] },
    findings: { type: 'array', items: FINDING_SCHEMA },
    trap_door_candidates: { type: 'array', items: TRAPDOOR_SCHEMA },
    codex_per_branch: {
      type: ['object', 'null'],
      additionalProperties: {
        type: 'object',
        required: ['verdict', 'reason'],
        properties: {
          verdict: { enum: ['approve', 'needs-attention', 'failed', 'timeout'] },
          reason: { type: 'string' },
        },
      },
    },
  },
  // skip_reason non-empty iff status==='skipped' (council-schema.ts:247-266).
  if: { properties: { status: { const: 'skipped' } } },
  then: { properties: { skip_reason: { type: 'string', minLength: 1 } } },
  else: { properties: { skip_reason: { type: 'null' } } },
};

// Verbatim plain-JS port of planFanOut (council-fanout.ts:29-77). The `C_codex`-if-codex
// line is kept faithful, but the body below calls this with codexEnabled:false so the
// codex sweep is a SEPARATE gated agent (no double-counting). Returns SubagentSpec[].
function planFanOut(input) {
  const { stackTier, branches, codexEnabled, hasMigrationJournal } = input;
  const sharded = SHARDED_TIERS.includes(stackTier);
  const specs = [];

  function makeSpec(category, branch) {
    return {
      category,
      branch,
      prompt_vars: {
        stack_tier: stackTier,
        codex_enabled: codexEnabled,
        has_migration_journal: hasMigrationJournal,
        target_branch: branch,
      },
    };
  }

  if (sharded) {
    for (const branch of branches) {
      for (const cat of UNCONDITIONAL_B_CATEGORIES) {
        specs.push(makeSpec(cat, branch));
      }
    }
  } else {
    for (const cat of UNCONDITIONAL_B_CATEGORIES) {
      specs.push(makeSpec(cat, null));
    }
  }

  if (hasMigrationJournal) {
    specs.push(makeSpec('B7_migration_hygiene', null));
  }

  for (const branch of [...branches].sort()) {
    specs.push(makeSpec('C_correctness', branch));
  }

  if (codexEnabled) {
    specs.push(makeSpec('C_codex', null));
  }

  return specs;
}

const PERSONA =
  'You are Pickle Rick on the Council of Ricks — hyper-competent, ruthlessly thorough, '
  + 'non-sycophantic. Output a text brain-dump before every tool call.';

// Phase A historical brief (council-of-ricks.md:240-256). Default agent type: runs git/gh,
// writes the brief under the session dir. JUDGE-ONLY — never edits repo files.
function historicalPrompt(branches, sessionFiles, round) {
  return [
    PERSONA,
    '',
    `## Phase A — Historical Context (round ${round})`,
    'For each file touched by any branch in the stack (dedupe across branches), compute:',
    '1. `git log --oneline -10 -- <file>` — recent fix history.',
    '2. In-file guidance comments (top-of-file banners, `// NOTE:`, `// IMPORTANT:`).',
    '3. If BOTH `gh auth status` and a github.com remote succeed: `gh pr list --state merged '
    + '--search "<file>"` then `gh pr view <N> --comments` for the top 3 most recent. Skip silently '
    + 'on any individual gh failure.',
    `Branches under review (tip → trunk): ${JSON.stringify(branches)}.`,
    `Reference files (absolute paths): ${JSON.stringify(sessionFiles)}.`,
    '',
    '## JUDGE-ONLY',
    'You review history only. You MUST NOT Edit or Write any repo file. The ONLY file you may write '
    + `is the brief BELOW, under the absolute session dir.`,
    '',
    '## Output',
    `1. Write the brief to the ABSOLUTE path ${sessionFiles.historicalBriefPath}: per-file `
    + 'recent-change summary, recurring concerns (2+ prior PRs), in-file guidance, and a final status '
    + 'line that is EXACTLY one of `historical: ok` | `historical: git-only` | '
    + '`historical: skipped (<reason>)`.',
    '2. Return your brief as plain text (it is CONTEXT for the downstream judges, not findings).',
  ].join('\n');
}

// One Phase B category OR Phase C_correctness judge (council-of-ricks.md:266-298). Read-only:
// spawned as the `Explore` agentType so it cannot Edit/Write the repo (R-DWF-NO-REPO-EDIT).
function subagentPrompt(spec, brief, sessionFiles, round) {
  const branchScope = spec.branch
    ? `Scope: branch ${spec.branch} diff ONLY.`
    : 'Scope: stack-wide (all non-trunk branch diffs).';
  const body = [
    PERSONA,
    '',
    `## Category ${spec.category} — round ${round}`,
    branchScope,
    `Reference files (absolute): principles=${sessionFiles.principlesPath}, `
    + `claude_rules=${sessionFiles.claudeRulesPath}, stack=${sessionFiles.stackPath}, `
    + `historical_brief=${sessionFiles.historicalBriefPath}.`,
    '',
    '## Historical brief (inline context — do not re-read it from disk)',
    String(brief || '(none)'),
    '',
    '## Criteria',
    categoryCriteria(spec.category),
    'Apply the szechuan P0–P4 severity matrix and the 0/25/50/75/100 confidence rubric. Trace the '
    + 'complete data path (input → bug → wrong output, file:line chain) for every correctness finding.',
    '',
    '## JUDGE-ONLY (read-only)',
    'You are a reviewer. You have NO Edit/Write tools. Inspect diffs and code only.',
    '',
    '## Output',
    `Return ONE object matching the SubagentPayload shape: category="${spec.category}", `
    + `branch=${spec.branch === null ? 'null' : `"${spec.branch}"`}, status ("ok"|"skipped"), `
    + 'skip_reason (non-empty iff skipped, else null), findings[], trap_door_candidates[], '
    + 'codex_per_branch (null for non-codex categories).',
  ].join('\n');
  return `${body}\n\n${FOM_EVIDENCE_RULES}\n\n${FOM_HONEST_REPORTING_RULES}`;
}

function categoryCriteria(category) {
  const map = {
    B1_stack_structure: 'PR sizing, split candidates, commit hygiene, branch naming, stack ordering.',
    B2_claude_md: 'Verify every rule / required-pattern / forbidden-pattern in council-claude-rules.json against each branch diff.',
    B3_contract_discovery: 'Producer→consumer map. Grep importers of each new/changed export. Zod/enum/union coverage gaps, unhandled union variants (P1).',
    B4_cross_branch: 'Adjacent-branch contract mismatches (shared types, API, state assumptions). Enumerate 2^N boolean/nullable input combos per guard; flag unhandled combos P1.',
    B5_test_coverage: 'Test adequacy per branch. Persisted-field value-set changes without migration/backward-compat → P0.',
    B6_security: 'Input validation, auth gaps, injection, secrets, trust boundaries, cross-tenant data separation.',
    B7_migration_hygiene: 'Only if db/migrations/meta/_journal.json exists. CHECK-constraint drift, redundant churn, idempotency, TS↔SQL drift. No journal → status=skipped, skip_reason="no Drizzle journal".',
    B8_szechuan: 'Scan every diff against council-principles.md. Score every violation P0–P4. Respect the principle-tensions table.',
    B9_polish: 'PR descriptions, naming, dead code, style drift. Identify trap-door candidates.',
    C_correctness: 'Logic bugs, types, error handling, null safety on this branch diff. `git log --oneline -- <file>` for any file with a finding (2+ fix history = trap-door candidate).',
  };
  return map[category] || 'Review this branch/stack against council-principles.md.';
}

// Phase C codex sweep (council-of-ricks.md:311-332). An ordinary Claude agent (NOT codex-backed)
// that shells out to codex-companion.mjs adversarial-review per branch. Default agent type:
// needs Bash for sequential checkout + the codex shell + a session-dir write. JUDGE-ONLY.
function codexSweepPrompt(branches, sessionFiles, round) {
  const body = [
    PERSONA,
    '',
    `## Phase C — Codex Sweep (round ${round})`,
    `Walk every non-trunk branch in ${JSON.stringify(branches)} IN ORDER (shared working tree → `
    + 'sequential checkout). For each branch:',
    '1. Capture ORIG_BRANCH once at sweep start.',
    '2. `gt branch checkout <branch> --no-interactive` (fall back to `git checkout <branch>`).',
    '3. Determine the parent (branch immediately below in `gt log short`, else trunk).',
    '4. `timeout ${CODEX_TIMEOUT:-600} node "${CODEX_COMPANION}" adversarial-review --wait '
    + '--base "<parent_ref>" --scope branch "<council adversarial prompt>"`.',
    `5. Capture stdout to ${sessionFiles.codexDir}/<branch-slug>-round${round}.md (slug: / → __).`,
    '6. Parse the verdict line + findings. needs-attention conf≥0.6 → P1 (P0 if security/data-loss); '
    + 'conf<0.6 → P2. Quote Codex recommendations verbatim.',
    'After the last branch, restore ORIG_BRANCH. On any per-branch timeout/non-zero/empty: record the '
    + 'failure for that branch and continue — one broken run does not kill the sweep.',
    `CODEX_COMPANION=${sessionFiles.codexCompanionPath}. Output dir: ${sessionFiles.codexDir}.`,
    '',
    '## JUDGE-ONLY',
    'You MUST NOT Edit or Write repo source files. The only files you may write are the per-branch '
    + 'codex capture files under the absolute session dir. Always restore ORIG_BRANCH at the end.',
    '',
    '## Output',
    'Return ONE object matching the SubagentPayload shape: category="C_codex", branch=null, status, '
    + 'skip_reason, findings[] (tagged source="CODEX"), trap_door_candidates[], and codex_per_branch '
    + 'keyed by branch name with { verdict: approve|needs-attention|failed|timeout, reason }.',
  ].join('\n');
  return `${body}\n\n${FOM_EVIDENCE_RULES}\n\n${FOM_HONEST_REPORTING_RULES}`;
}

// Phase D synthesis (council-of-ricks.md:299-309, Step 16/17). Default agent type: writes the
// directive + summary under the session dir, returns the structured result. JUDGE-ONLY.
function synthesisPrompt(bc, codex, round, sessionFiles) {
  const payloads = [...bc];
  if (codex) payloads.push(codex);
  const body = [
    PERSONA,
    '',
    `## Phase D — Synthesis (round ${round})`,
    'You are given every Phase B/C payload inline below. Apply IN ORDER: (1) false-positive '
    + 'pre-filter; (2) drop confidence < 80; (3) dedupe COUNCIL vs CODEX on file:line → '
    + '[COUNCIL+CODEX]; (4) severity sort P0-first per branch; (5) consolidate trap-door candidates '
    + 'by (path, constraint).',
    '',
    '## Phase B/C payloads (inline — do not re-read them from disk)',
    JSON.stringify(payloads),
    '',
    '## JUDGE-ONLY',
    'You MUST NOT Edit or Write any repo file. Write ONLY under the absolute session dir.',
    '',
    '## Output',
    `1. Write council-directive.json ATOMICALLY (tmp + rename) to ${sessionFiles.directivePath} `
    + 'conforming to the Directive shape: { schema_version:1, round, codex_enabled, '
    + 'stack_overview{trunk,branches,issue_counts,codex_verdicts}, branches[]{name,pr_purpose,'
    + 'findings[]}, trap_doors[] }.',
    `2. Append this round's record to ${sessionFiles.summaryPath}. The "## Round ${round}:" header `
    + 'MUST end with exactly one of: `— clean round.` | `— partial round (skipped: …).` | '
    + '`— <total> issues (<P0>/<P1>/<P2>/<P3>/<P4>)`.',
    '3. Return the structured object: { round, summary (the full "## Round N: … — <suffix>" header '
    + 'line), directive (the Directive object you wrote), directive_path, issue_counts, '
    + 'codex_verdicts }.',
  ].join('\n');
  return `${body}\n\n${FOM_EVIDENCE_RULES}\n\n${FOM_HONEST_REPORTING_RULES}`;
}

// --------------------------------- body -----------------------------------

const {
  branches,
  stackTier,
  codexEnabled = false,
  hasMigrationJournal = false,
  round = 1,
  sessionFiles,
} = args;

phase('A-historical');
const brief = await agent(historicalPrompt(branches, sessionFiles, round), {
  label: 'historical',
  phase: 'A-historical',
});

phase('B-categories');
// codexEnabled:false → planner emits only B + C_correctness; the codex sweep is the separate
// gated agent below, so C_codex is never double-counted.
const specs = planFanOut({ stackTier, branches, codexEnabled: false, hasMigrationJournal });
// Sharded l/xl/xxl fan-outs (up to ~91 specs) exceed the concurrency ceiling; the runtime queues
// the overflow across multiple sweeps. Announce it so the round summary never carries the false
// "all specs ran in one simultaneous wave" semantics (R-DWF-5 / AC-DWF-05). Capping NEVER drops a
// spec — every queued thunk still runs and returns — so this is a wall-time notice, not a failure.
if (specs.length > MAX_FANOUT_CONCURRENCY) {
  const sweeps = Math.ceil(specs.length / MAX_FANOUT_CONCURRENCY);
  log(`round ${round}: ${specs.length} specs exceed the ${MAX_FANOUT_CONCURRENCY}-agent concurrency cap `
    + `(min(16,cores−2)); the runtime queues them across ≥${sweeps} batched sweeps — NOT a single `
    + 'simultaneous wave');
}
const bcAll = await parallel(
  specs.map((s) => () =>
    agent(subagentPrompt(s, brief, sessionFiles, round), {
      label: `${s.category}:${s.branch ?? 'stack'}`,
      phase: s.category.startsWith('C') ? 'C-branches' : 'B-categories',
      schema: SUBAGENT_PAYLOAD_SCHEMA,
      agentType: 'Explore', // read-only judge — no repo Edit/Write (R-DWF-NO-REPO-EDIT)
    })),
);
const bc = bcAll.filter(Boolean);
if (bc.length < specs.length) {
  log(`round ${round}: ${specs.length - bc.length} of ${specs.length} specs returned null (failed/skipped); directive will be incomplete`);
}

let codex = null;
if (codexEnabled) {
  phase('C-codex');
  codex = await agent(codexSweepPrompt(branches, sessionFiles, round), {
    label: 'C_codex',
    phase: 'C-codex',
    schema: SUBAGENT_PAYLOAD_SCHEMA,
  });
}

phase('D-synthesis');
return await agent(synthesisPrompt(bc, codex, round, sessionFiles), {
  label: 'synthesis',
  phase: 'D-synthesis',
});
