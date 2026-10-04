// @tier: fast
//
// R-DWF-2 trap-door test (R-DWF-CROSSCYCLE-VARS / AC-DWF-02) for the Dynamic Workflow at
// .claude/workflows/refine-analyze.js.
//
// A workflow script has a bare top-level `return` (illegal in a normal module): the runtime wraps
// the body in an AsyncFunction with ambient bindings (agent/parallel/pipeline/phase/log/args/budget).
// This test reproduces that wrapping exactly, so it exercises the REAL workflow logic with mocked
// ambients — no re-implementation. Asserts:
//   (a) exactly 3 × cycles schema-valid AnalysisSchema objects;
//   (b) cycle N+1 prompts embed cycle-N findings AND no analysis_*.md is read between cycles;
//   (c) the emitted manifest validates against refinement-manifest.schema.json (ajv);
//   plus the static guard that the workflow path does not reference loadPreviousAnalyses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import AjvModule from 'ajv';

const Ajv = AjvModule.default || AjvModule;

const WORKFLOW_PATH = fileURLToPath(new URL('../../.claude/workflows/refine-analyze.js', import.meta.url));
const MANIFEST_SCHEMA_PATH = fileURLToPath(new URL('../src/types/refinement-manifest.schema.json', import.meta.url));

const ROLES = ['requirements', 'codebase', 'risk-scope'];

function readWorkflowSource() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf-8');
}

/** Wrap the workflow body the way the runtime does, then return the invocable async function. */
function loadWorkflow() {
  const src = readWorkflowSource();
  const body = src.replace(/^export\s+const\s+meta/m, 'const meta');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', body);
}

/** Build a deterministic harness: records analyst prompts/schemas, runs thunks, mocks agents. */
function makeHarness(argsObj, decomposeBehavior = 'ok') {
  const analystCalls = [];
  const decomposeCalls = [];
  let synthSchema = null;
  let synthManifest = null;

  const agent = async (prompt, opts = {}) => {
    if (opts.phase === 'analyze') {
      const m = /^analyst-(.+)-c(\d+)$/.exec(opts.label || '');
      const role = m ? m[1] : 'requirements';
      const cycle = m ? Number(m[2]) : 1;
      const ret = {
        role,
        executive_summary: `exec summary for ${role} cycle ${cycle}`,
        p0_gaps: [`p0-gap-${role}`],
        ac_shape_smells: [],
        markdown_body: `# Analysis: ${role} (cycle ${cycle})\nFINDING::${role}::c${cycle}\nDetail body.`,
      };
      analystCalls.push({ label: opts.label, prompt, schema: opts.schema, cycle, role, ret });
      return ret;
    }
    if (opts.phase === 'decompose') {
      decomposeCalls.push({ prompt, schema: opts.schema });
      if (decomposeBehavior === 'throw') throw new Error('decompose boom');
      return { tickets: decomposeBehavior === 'empty' ? [] : [{ id: 'abcd1234', title: 'T' }] };
    }
    // synthesis call
    synthSchema = opts.schema;
    synthManifest = {
      prd_path: argsObj.prdPath,
      refinement_dir: argsObj.refinementDir,
      all_success: true,
      cycles_requested: argsObj.cycles,
      cycles_completed: argsObj.cycles,
      max_turns_per_worker: argsObj.maxTurns,
      ac_shape_smells: [],
      tickets: [],
      workers: ROLES.map((role) => ({
        role,
        success: true,
        output_file: `${argsObj.refinementDir}/analysis_${role}.md`,
        exists: true,
        log_file: '',
        cycle: argsObj.cycles,
      })),
      completed_at: '2026-06-01T12:00:00.000Z',
    };
    return synthManifest;
  };

  const parallel = (thunks) => Promise.all(thunks.map((t) => t()));
  const pipeline = async () => { throw new Error('pipeline must not be used by R-DWF-2 workflow'); };
  const phase = () => {};
  const log = () => {};

  return {
    ambient: [agent, parallel, pipeline, phase, log, argsObj, {}],
    analystCalls,
    decomposeCalls,
    get synthSchema() { return synthSchema; },
    get synthManifest() { return synthManifest; },
  };
}

function defaultArgs(cycles = 2) {
  return {
    prdPath: '/abs/session/prd.md',
    sessionDir: '/abs/session',
    workingDir: '/abs/repo',
    refinementDir: '/abs/session/refinement',
    cycles,
    maxTurns: 100,
  };
}

async function runWorkflow(cycles = 2) {
  const argsObj = defaultArgs(cycles);
  const harness = makeHarness(argsObj);
  const fn = loadWorkflow();
  const result = await fn(...harness.ambient);
  return { result, harness, argsObj };
}

test('AC-DWF-02(a): exactly 3 × cycles schema-valid AnalysisSchema objects', async () => {
  const cycles = 2;
  const { harness } = await runWorkflow(cycles);

  assert.equal(harness.analystCalls.length, ROLES.length * cycles, 'expected 3 × cycles analyst agent() calls');

  // The schema each analyst call passes to agent() IS the real in-script AnalysisSchema.
  const schema = harness.analystCalls[0].schema;
  assert.ok(schema && schema.type === 'object', 'analyst calls must pass an AnalysisSchema object');
  assert.equal(schema.additionalProperties, false, 'AnalysisSchema must be strict (additionalProperties:false)');

  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  for (const call of harness.analystCalls) {
    assert.equal(call.schema, schema, 'every analyst call must reuse the same AnalysisSchema');
    assert.ok(validate(call.ret), `analyst return must validate: ${ajv.errorsText(validate.errors)}`);
  }

  // Negative: the schema is genuinely strict.
  assert.equal(validate({ role: 'bogus', executive_summary: 'x', p0_gaps: [], ac_shape_smells: [], markdown_body: 'x' }), false, 'bad role enum must fail');
  assert.equal(validate({ role: 'requirements', executive_summary: 'x', p0_gaps: [], ac_shape_smells: [], markdown_body: 'x', stray: 1 }), false, 'extra property must fail');
});

test('AC-DWF-02(b): cycle N+1 prompts embed cycle-N findings AND no analysis_*.md is read between cycles', async () => {
  const { harness } = await runWorkflow(2);

  const cycle2 = harness.analystCalls.filter((c) => c.cycle === 2);
  assert.equal(cycle2.length, ROLES.length, 'expected one cycle-2 call per role');

  for (const call of cycle2) {
    // Every cycle-2 prompt must carry at least one cycle-1 finding token, proving cross-cycle
    // context arrived via the `prior` SCRIPT VARIABLE (prompt-inspection signal).
    const hasPriorFinding = ROLES.some((r) => call.prompt.includes(`FINDING::${r}::c1`));
    assert.ok(hasPriorFinding, `cycle-2 ${call.role} prompt must embed a cycle-1 finding token`);
  }

  // Cycle-1 prompts must NOT carry cycle-1 finding tokens (no prior to embed).
  const cycle1 = harness.analystCalls.filter((c) => c.cycle === 1);
  for (const call of cycle1) {
    assert.ok(!/FINDING::[a-z-]+::c\d/.test(call.prompt), `cycle-1 ${call.role} prompt must not embed prior findings`);
  }

  // "No analysis_*.md read between cycles" — proven structurally: the workflow body cannot reach the
  // filesystem at all (no imports, no require, no fs reference), and the legacy disk re-read helper
  // is absent. A body with no fs binding CANNOT re-read analysis files; the only cross-cycle channel
  // is the `prior` script variable asserted above.
  const src = readWorkflowSource();
  assert.ok(!/^\s*import\s/m.test(src), 'workflow body must have no imports (no fs reachable)');
  assert.ok(!/\brequire\s*\(/.test(src), 'workflow body must have no require() (no fs reachable)');
  assert.ok(!/\bfs\s*\./.test(src), 'workflow body must not reference fs at all');
  assert.ok(!src.includes('loadPreviousAnalyses'), 'workflow must not reference loadPreviousAnalyses');
});

test('AC-DWF-02(c): emitted manifest validates against refinement-manifest.schema.json (ajv)', async () => {
  const { result } = await runWorkflow(2);
  assert.ok(result && result.manifest, 'workflow must return a manifest');

  const schema = JSON.parse(fs.readFileSync(MANIFEST_SCHEMA_PATH, 'utf-8'));
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);

  assert.ok(validate(result.manifest), `manifest must validate (ajv exit 0): ${ajv.errorsText(validate.errors)}`);

  // Negative: additionalProperties:false at the top level is enforced.
  assert.equal(validate({ ...result.manifest, stray_key: true }), false, 'stray top-level key must fail manifest schema');
});

test('AC-DWF-02(c2): the in-script ManifestSchema agrees with the canonical manifest schema', async () => {
  const { harness } = await runWorkflow(2);
  // The synthesis agent receives the in-script ManifestSchema as its `schema`. Anything that
  // satisfies it must also satisfy the canonical contract — proving the literals stay in sync.
  const inScript = harness.synthSchema;
  assert.ok(inScript && inScript.type === 'object', 'synthesis call must pass a ManifestSchema object');
  const canonical = JSON.parse(fs.readFileSync(MANIFEST_SCHEMA_PATH, 'utf-8'));
  assert.deepEqual(
    [...inScript.required].sort(),
    [...canonical.required].sort(),
    'in-script ManifestSchema.required must match the canonical manifest schema required set',
  );

  const ajv = new Ajv({ allErrors: true });
  const validateInScript = ajv.compile(inScript);
  assert.ok(validateInScript(harness.synthManifest), `synth manifest must satisfy in-script ManifestSchema: ${ajv.errorsText(validateInScript.errors)}`);
});

test('workflow honors the dynamic-workflow primitive constraints (static)', () => {
  const src = readWorkflowSource();
  assert.ok(/^export\s+const\s+meta\s*=/m.test(src), 'must begin with `export const meta =`');
  assert.ok(!/^\s*import\s/m.test(src), 'no module imports allowed in the workflow body');
  assert.ok(!/\brequire\s*\(/.test(src), 'no require() allowed');
  assert.ok(!/\bisolation\b/.test(src), 'no worktree isolation flag');
  assert.ok(!/\bmodel\s*:/.test(src), 'no model-tier pin');
  assert.ok(!/new Date\s*\(/.test(src), 'no new Date() — date-time comes from the synthesis agent');
  assert.ok(!/Date\.now\s*\(/.test(src), 'no Date.now()');
  assert.ok(!/Math\.random\s*\(/.test(src), 'no Math.random()');
  assert.ok(!src.includes('loadPreviousAnalyses'), 'no legacy disk re-read helper reference');
});

async function runDecompose(behavior) {
  const argsObj = defaultArgs(1);
  const harness = makeHarness(argsObj, behavior);
  const phases = [];
  harness.ambient[3] = (name) => phases.push(name);
  const result = await loadWorkflow()(...harness.ambient);
  return { result, harness, phases };
}

test('E2-1: meta.phases is analyze, synthesize, decompose and the source calls phase(\'decompose\')', () => {
  const src = readWorkflowSource();
  assert.ok(/phases:\s*\['analyze', 'synthesize', 'decompose'\]/.test(src));
  assert.ok((src.match(/phase\('decompose'\)/g) || []).length >= 1);
});

test('E2-2: decompose runs after synthesize, covers 7a-7e, forbids 7g and state.json', async () => {
  const { result, harness, phases } = await runDecompose('ok');
  assert.deepEqual(phases.slice(-2), ['synthesize', 'decompose']);
  assert.equal(harness.decomposeCalls.length, 1);
  const p = harness.decomposeCalls[0].prompt;
  assert.match(p, /Step 7a through Step 7e/);
  assert.match(p, /Do NOT run Step 7f or 7g/);
  assert.deepEqual(result.decompose, { tickets: [{ id: 'abcd1234', title: 'T' }] });
});

test('E2-3: a throwing decompose agent yields a fallback reason, not a throw', async () => {
  const { result } = await runDecompose('throw');
  assert.equal(result.decompose.fallback, 'decompose boom');
  assert.deepEqual(result.decompose.tickets, []);
  assert.ok(result.manifest, 'earlier phases still return their results');
});

test('E2-4: 0 tickets yields a fallback reason', async () => {
  const { result } = await runDecompose('empty');
  assert.equal(result.decompose.fallback, '0 tickets returned');
});

test('E2-5: command doc and README name the fallback line and the decompose phase', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const line = 'decompose phase: fallback to inline Step 7 (<reason>)';
  for (const f of ['.claude/commands/pickle-refine-prd.md', 'README.md']) {
    assert.ok(fs.readFileSync(path.join(root, f), 'utf-8').includes(line), f);
  }
});

// C1+C2: both synthesis surfaces must ask for a `## Premises` ledger and an `## Open Decisions` table.
const COMMAND_DOC_PATH = fileURLToPath(new URL('../../.claude/commands/pickle-refine-prd.md', import.meta.url));
const commandDocLines = () => fs.readFileSync(COMMAND_DOC_PATH, 'utf-8').split('\n');
/** The command doc's `## Step <n>:` section, cut at the next `## Step` heading (a step embeds `## ` FOM blocks). */
function commandDocStep(n) {
  const lines = commandDocLines();
  const start = lines.findIndex((l) => l.startsWith(`## Step ${n}:`));
  const end = lines.findIndex((l) => l.startsWith(`## Step ${n + 1}:`));
  assert.ok(start > -1 && end > start, `## Step ${n}: and ## Step ${n + 1}: headings present (${start}, ${end})`);
  return lines.slice(start + 1, end);
}
const LEDGER_RULES = [
  /`## Premises` ledger/,
  /`?\(verified\)`?\/`?\(hypothesis\)`? tag verbatim/,
  /converging[^\n]*is not verification/,
  /`## Open Decisions` table/,
  /needs-human item\s+is never written under settled decisions\s+without a quoted human decision/,
  /explicit (?:`none` row|row: `none`)/,
];

test('C1C2-1: the workflow synthesis prompt actually sent to the agent carries the Premises and Open Decisions rules', async () => {
  const argsObj = defaultArgs(1);
  const harness = makeHarness(argsObj);
  const prompts = [];
  const agent = harness.ambient[0];
  harness.ambient[0] = (prompt, opts = {}) => {
    if (opts.phase === 'synthesize') prompts.push(prompt);
    return agent(prompt, opts);
  };
  await loadWorkflow()(...harness.ambient);
  assert.equal(prompts.length, 1, 'one synthesis call');
  for (const rule of LEDGER_RULES) assert.match(prompts[0], rule);
});

test('C1C2-2: the command doc writes both ledgers in Step 6 (Synthesize), not elsewhere', () => {
  const step6 = commandDocStep(6).join('\n');
  for (const rule of LEDGER_RULES) assert.match(step6, rule);
});

// C8b: every Test Expectations table in the refinement template gains a Source column, with a matching
// five-cell separator row directly under each header.
test('C8b-1: all six Test Expectations headers carry Source, none keeps the four-column form', () => {
  const lines = commandDocLines();
  const headers = lines.flatMap((l, i) => (l === '| Criterion | Test File | Description | Assertion | Source |' ? [i] : []));
  assert.equal(headers.length, 6);
  assert.equal(lines.filter((l) => l === '| Criterion | Test File | Description | Assertion |').length, 0);
  for (const i of headers) assert.equal(lines[i + 1].split('|').length - 2, 5, `separator under line ${i + 1}: ${lines[i + 1]}`);
});

test('F75-OPENDEC-prompt: both synthesis surfaces name the five Open Decisions columns and keep the ledger rules', async () => {
  const columns = 'decision, options, default, owner, status';
  const harness = makeHarness(defaultArgs(1));
  const prompts = [];
  const agent = harness.ambient[0];
  harness.ambient[0] = (prompt, opts = {}) => {
    if (opts.phase === 'synthesize') prompts.push(prompt);
    return agent(prompt, opts);
  };
  await loadWorkflow()(...harness.ambient);
  assert.equal(prompts.length, 1, 'one synthesis call');
  assert.ok(prompts[0].includes(columns), 'workflow synthesis prompt names the columns');
  const step6 = commandDocStep(6).join('\n');
  assert.ok(step6.includes(columns), 'command doc Step 6 names the columns');
  for (const surface of [prompts[0], step6]) {
    assert.match(surface, /`default` is the option the build proceeds on/);
    assert.match(surface, /`status` is `open` until a quoted human decision is\s+recorded, then `decided: <quote>`/);
    for (const rule of LEDGER_RULES) assert.match(surface, rule);
  }
});
