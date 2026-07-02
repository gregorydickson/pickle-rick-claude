// @tier: fast
// R-SIGF (LOA-1488, WS-1): the readiness gate conditionally BLOCKS on a
// `signature_caller_gap` finding when a ticket changes an exported/injected
// symbol's ARITY (adds a constructor param) and a positional caller in an
// out-of-scope `*.spec.ts` / factory file would be left stale.
// Blocking when: skip_quality_gates_reason absent AND
//   (scope.auto_extend_signature_callers is false OR caller count > SCOPE_AUTO_EXTEND_MAX=8).
// Advisory (non-blocking) when: skip_quality_gates_reason set, or flag-on + count ≤ 8.
// (The PICKLE_SIGF kill-switch was retired in the guard-layer prune — the mux-level
// readiness gate is already advisory, so the env demotion route was redundant.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');
const SKIP_FLAG_BUDGETS_KEY = 'pickle::signature_caller_gap';

function tmpDir(prefix = 'pickle-sigf-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, body) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `linear_ticket_${id}.md`), body);
}

function gitRepoWith(files) {
  const repoRoot = tmpDir('pickle-sigf-repo-');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.email', 'sigf@example.com'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.name', 'sigf'], { cwd: repoRoot });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repoRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  spawnSync('git', ['add', '-A'], { cwd: repoRoot });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });
  return repoRoot;
}

function runReadiness(sessionDir, repoRoot, extraEnv = {}) {
  return spawnSync(process.execPath, [
    BIN,
    '--session-dir', sessionDir,
    '--repo-root', repoRoot,
    '--contract-only',
  ], { encoding: 'utf-8', timeout: 15000, env: { ...process.env, ...extraEnv } });
}

// AC-SIGF-1: arity gap with out-of-scope git-TRACKED caller BLOCKS (exit != 0);
// finding kind is 'signature_caller_gap'
test('R-SIGF WS-1: arity change with an out-of-scope positional caller BLOCKS readiness (exit != 0)', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/widget-service.ts': 'export class WidgetService { constructor(a, b) {} }\n',
    'src/widget-service.spec.ts': "import { WidgetService } from './widget-service';\nconst s = new WidgetService(1, 2);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf1', [
      '---',
      'id: sigf1',
      'key: SIGF-1',
      'ac_ids: []',
      '---',
      '',
      '# Add a 3rd constructor parameter to WidgetService',
      '',
      '## Files to modify',
      '',
      '- `src/widget-service.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] `WidgetService` constructor accepts exactly `3` parameters.',
      '',
    ].join('\n'));
    const result = runReadiness(sessionDir, repoRoot);
    assert.notEqual(result.status, 0, `expected non-zero exit (blocking), got ${result.status}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'fail');
    const blocking = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap');
    assert.equal(blocking.length, 1, `expected one signature_caller_gap blocking finding; got ${JSON.stringify(out.findings)}`);
    assert.match(blocking[0].detail, /widget-service\.spec\.ts/, 'finding must name the out-of-scope caller');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// WS-2: schema-shape gap with an out-of-scope `<Schema>.parse(` consumer BLOCKS,
// and the finding message uses kind-aware "Schema-shape change" wording (F2 fix) —
// NEVER the arity "Arity change" wording.
test('R-SIGF WS-2: schema-shape change with an out-of-scope .parse() consumer emits Schema-shape wording (not Arity)', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/threshold-schema.ts': "import { z } from 'zod';\nexport const ThresholdSchema = z.object({ a: z.number() });\n",
    // Out-of-scope spec consumes the schema via .parse( — a schema-shape gap.
    'src/threshold-schema.spec.ts': "import { ThresholdSchema } from './threshold-schema';\nconst v = ThresholdSchema.parse({ a: 1 });\n",
  });
  try {
    writeTicket(sessionDir, 'sigf-shape', [
      '---',
      'id: sigf-shape',
      'key: SIGF-SHAPE',
      'ac_ids: []',
      '---',
      '',
      '# Add a required field to ThresholdSchema',
      '',
      '## Files to modify',
      '',
      '- `src/threshold-schema.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] `ThresholdSchema` adds a required `b` field of type number.',
      '',
    ].join('\n'));
    const result = runReadiness(sessionDir, repoRoot);
    assert.notEqual(result.status, 0, `expected non-zero exit (blocking), got ${result.status}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'fail');
    const blocking = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap' && /ThresholdSchema/.test(f.detail));
    assert.equal(blocking.length, 1, `expected one schema-shape signature_caller_gap; got ${JSON.stringify(out.findings)}`);
    const msg = blocking[0].message;
    assert.match(msg, /schema-shape change/i, `message must use kind-aware schema-shape wording; got: ${msg}`);
    assert.ok(!/Arity change/.test(msg), `schema-shape finding must NOT carry the arity wording; got: ${msg}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// AC-SIGF-1: co-scoped caller → no block (exit 0)
test('R-SIGF: in-scope positional caller emits NOTHING (a fenced worker can fix it)', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/gadget-service.ts': 'export class GadgetService { constructor(a, b) {} }\n',
    'src/gadget-service.spec.ts': "import { GadgetService } from './gadget-service';\nconst s = new GadgetService(1, 2);\n",
  });
  try {
    // The spec IS declared in-scope, so no gap — nothing to flag.
    writeTicket(sessionDir, 'sigf2', [
      '---',
      'id: sigf2',
      'key: SIGF-2',
      'ac_ids: []',
      '---',
      '',
      '# Add a new constructor parameter to GadgetService',
      '',
      '## Files to modify',
      '',
      '- `src/gadget-service.ts`',
      '- `src/gadget-service.spec.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] `GadgetService` constructor accepts exactly `3` parameters.',
      '',
    ].join('\n'));
    const result = runReadiness(sessionDir, repoRoot);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    const sigGapFindings = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap' && /GadgetService/.test(f.detail));
    assert.deepEqual(sigGapFindings, [], `in-scope caller must emit no signature_caller_gap; got ${JSON.stringify(sigGapFindings)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// AC-SIGF-1: no arity change → no finding
test('R-SIGF: a ticket with no arity change emits nothing', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/sprocket-service.ts': 'export class SprocketService { constructor(a) {} }\n',
    'src/sprocket-service.spec.ts': "import { SprocketService } from './sprocket-service';\nconst s = new SprocketService(1);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf3', [
      '---',
      'id: sigf3',
      'key: SIGF-3',
      'ac_ids: []',
      '---',
      '',
      '# Tweak SprocketService behavior',
      '',
      '## Files to modify',
      '',
      '- `src/sprocket-service.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] The service emits exactly `1` event per call.',
      '',
    ].join('\n'));
    const result = runReadiness(sessionDir, repoRoot);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr=${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    const advisory = (out.findings ?? []).filter((f) => f.kind === 'advisory' && /signature|arity/i.test(f.message));
    assert.deepEqual(advisory, [], `no arity change → no advisory; got ${JSON.stringify(advisory)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// AC-SIGF-1: negative FP case — out-of-scope caller uses factory (not positional `new X(`)
// The heuristic only detects `new Symbol(` patterns; a factory call won't match → no gap.
test('R-SIGF: out-of-scope caller using factory/non-positional call emits nothing (negative FP bound)', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/flux-service.ts': 'export class FluxService { static create(a, b) { return new FluxService(a, b); } constructor(a, b) {} }\n',
    // Uses factory — no `new FluxService(` in the spec — heuristic won't match
    'src/flux-service.spec.ts': "import { FluxService } from './flux-service';\nconst s = FluxService.create(1, 2);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf-fp', [
      '---',
      'id: sigf-fp',
      'key: SIGF-FP',
      'ac_ids: []',
      '---',
      '',
      '# Add a 3rd constructor parameter to FluxService',
      '',
      '## Files to modify',
      '',
      '- `src/flux-service.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] `FluxService` constructor accepts exactly `3` parameters.',
      '',
    ].join('\n'));
    const result = runReadiness(sessionDir, repoRoot);
    assert.equal(result.status, 0, `expected exit 0 (factory call → heuristic finds no positional gap), got ${result.status}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    const blocking = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap');
    assert.deepEqual(blocking, [], `factory-only caller must not emit signature_caller_gap; got ${JSON.stringify(blocking)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// AC-SIGF-1d: flag ON + count ≤ 8 → informational (exit 0, advisory kind)
test('R-SIGF AC-SIGF-1d: scope.auto_extend_signature_callers=true + count ≤ 8 → advisory/informational (exit 0)', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/alpha-service.ts': 'export class AlphaService { constructor(a, b) {} }\n',
    'src/alpha-service.spec.ts': "import { AlphaService } from './alpha-service';\nconst s = new AlphaService(1, 2);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf-flag', [
      '---',
      'id: sigf-flag',
      'key: SIGF-FLAG',
      'ac_ids: []',
      '---',
      '',
      '# Add a 3rd constructor parameter to AlphaService',
      '',
      '## Files to modify',
      '',
      '- `src/alpha-service.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] `AlphaService` constructor accepts exactly `3` parameters.',
      '',
    ].join('\n'));
    // Write scope.json with auto_extend_signature_callers: true
    fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({ auto_extend_signature_callers: true }));
    const result = runReadiness(sessionDir, repoRoot);
    assert.equal(result.status, 0, `expected exit 0 (flag on, count ≤ 8 → informational), got ${result.status}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    // Should be advisory, not signature_caller_gap blocking
    const blockingGap = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap');
    assert.deepEqual(blockingGap, [], `flag on+count≤8 must emit advisory not blocking; got ${JSON.stringify(blockingGap)}`);
    const advisory = (out.findings ?? []).filter((f) => f.kind === 'advisory' && /signature|arity/i.test(f.message));
    assert.equal(advisory.length, 1, `expected one advisory finding; got ${JSON.stringify(advisory)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// AC-SIGF-1d: flag ON + count > 8 → still BLOCKS
test('R-SIGF AC-SIGF-1d: scope.auto_extend_signature_callers=true + count > 8 → BLOCKS (exit != 0)', () => {
  const sessionDir = tmpDir();
  // Create 9 out-of-scope callers to exceed the cap (SCOPE_AUTO_EXTEND_MAX=8)
  const files = {
    'src/beta-service.ts': 'export class BetaService { constructor(a, b) {} }\n',
  };
  for (let i = 1; i <= 9; i++) {
    files[`src/beta-consumer-${i}.spec.ts`] =
      `import { BetaService } from './beta-service';\nconst s = new BetaService(${i}, ${i + 1});\n`;
  }
  const repoRoot = gitRepoWith(files);
  try {
    writeTicket(sessionDir, 'sigf-overcap', [
      '---',
      'id: sigf-overcap',
      'key: SIGF-OVERCAP',
      'ac_ids: []',
      '---',
      '',
      '# Add a 3rd constructor parameter to BetaService',
      '',
      '## Files to modify',
      '',
      '- `src/beta-service.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] `BetaService` constructor accepts exactly `3` parameters.',
      '',
    ].join('\n'));
    // Flag ON but count > 8 → should still block
    fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({ auto_extend_signature_callers: true }));
    const result = runReadiness(sessionDir, repoRoot);
    assert.notEqual(result.status, 0, `expected non-zero exit (flag on but count > 8 → blocks), got ${result.status}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    const blocking = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap');
    assert.ok(blocking.length > 0, `expected at least one signature_caller_gap finding; got ${JSON.stringify(out.findings)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// AC-SIGF-1c: blocking text contains all three exit options
test('R-SIGF AC-SIGF-1c: blocking remediation message contains all three exits', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/epsilon-service.ts': 'export class EpsilonService { constructor(a, b) {} }\n',
    'src/epsilon-service.spec.ts': "import { EpsilonService } from './epsilon-service';\nconst s = new EpsilonService(1, 2);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf-msg', [
      '---',
      'id: sigf-msg',
      'key: SIGF-MSG',
      'ac_ids: []',
      '---',
      '',
      '# Add a 3rd constructor parameter to EpsilonService',
      '',
      '## Files to modify',
      '',
      '- `src/epsilon-service.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] `EpsilonService` constructor accepts exactly `3` parameters.',
      '',
    ].join('\n'));
    const result = runReadiness(sessionDir, repoRoot);
    assert.notEqual(result.status, 0, `expected blocking exit; got ${result.status}`);
    const out = JSON.parse(result.stdout);
    const blocking = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap');
    assert.ok(blocking.length > 0, `expected a blocking finding`);
    const msg = blocking[0].message;
    // Exit 1: co-scope the caller
    assert.match(msg, /co-scope|## Files to modify/i, 'message must mention co-scoping the caller');
    // Exit 2: scope.auto_extend_signature_callers
    assert.match(msg, /auto_extend_signature_callers|scope\.auto_extend/i, 'message must mention the scope flag');
    // Exit 3: skip_quality_gates_reason
    assert.match(msg, /skip_quality_gates_reason/i, 'message must mention the skip_quality_gates_reason bypass');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// AC-SIGF-2: skip_quality_gates_reason bypass → exit 0
test('R-SIGF AC-SIGF-2: skip_quality_gates_reason bypass passes (exit 0)', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/zeta-service.ts': 'export class ZetaService { constructor(a, b) {} }\n',
    'src/zeta-service.spec.ts': "import { ZetaService } from './zeta-service';\nconst s = new ZetaService(1, 2);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf-skip', [
      '---',
      'id: sigf-skip',
      'key: SIGF-SKIP',
      'ac_ids: []',
      '---',
      '',
      '# Add a 3rd constructor parameter to ZetaService',
      '',
      '## Files to modify',
      '',
      '- `src/zeta-service.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] `ZetaService` constructor accepts exactly `3` parameters.',
      '',
    ].join('\n'));
    // Write state.json with skip_quality_gates_reason
    const stateDir = sessionDir;
    const sm = { flags: { skip_quality_gates_reason: 'test skip for SIGF' } };
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(sm));
    const result = runReadiness(sessionDir, repoRoot);
    assert.equal(result.status, 0, `skip_quality_gates_reason must bypass the gate (exit 0), got ${result.status}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    const blocking = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap');
    assert.deepEqual(blocking, [], `bypass must produce no blocking signature_caller_gap; got ${JSON.stringify(blocking)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// AC-SIGF-3: block-time event → budget key accrual
// The SKIP_FLAG_BUDGETS key 'pickle::signature_caller_gap' = 3 maps the gate_skipped event.
// We verify: (a) the budget key exists in metrics-utils with non-zero value,
// (b) a blocking run emits the gate_skipped activity event with source:'pickle' + reason:'signature_caller_gap'.
test('R-SIGF AC-SIGF-3: SKIP_FLAG_BUDGETS key exists with non-zero value and block emits gate_skipped event', async () => {
  // Part (a): verify the budget entry exists and is non-zero
  const metricsUtils = path.resolve(__dirname, '../services/metrics-utils.js');
  const { SKIP_FLAG_BUDGETS } = await import(metricsUtils);
  assert.ok(
    Object.prototype.hasOwnProperty.call(SKIP_FLAG_BUDGETS, SKIP_FLAG_BUDGETS_KEY),
    `SKIP_FLAG_BUDGETS must have key '${SKIP_FLAG_BUDGETS_KEY}'`,
  );
  assert.ok(
    typeof SKIP_FLAG_BUDGETS[SKIP_FLAG_BUDGETS_KEY] === 'number' && SKIP_FLAG_BUDGETS[SKIP_FLAG_BUDGETS_KEY] > 0,
    `SKIP_FLAG_BUDGETS['${SKIP_FLAG_BUDGETS_KEY}'] must be a positive number, got ${SKIP_FLAG_BUDGETS[SKIP_FLAG_BUDGETS_KEY]}`,
  );

  // Part (b): a blocking run emits a gate_skipped activity event
  // logActivity writes to PICKLE_DATA_ROOT/activity — use a temp dir so we can read events.
  const dataRoot = tmpDir('pickle-sigf-data-');
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/eta-service.ts': 'export class EtaService { constructor(a, b) {} }\n',
    'src/eta-service.spec.ts': "import { EtaService } from './eta-service';\nconst s = new EtaService(1, 2);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf-budget', [
      '---',
      'id: sigf-budget',
      'key: SIGF-BUDGET',
      'ac_ids: []',
      '---',
      '',
      '# Add a 3rd constructor parameter to EtaService',
      '',
      '## Files to modify',
      '',
      '- `src/eta-service.ts`',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] `EtaService` constructor accepts exactly `3` parameters.',
      '',
    ].join('\n'));
    const result = runReadiness(sessionDir, repoRoot, { PICKLE_DATA_ROOT: dataRoot });
    assert.notEqual(result.status, 0, `expected blocking exit for budget test; got ${result.status}`);

    // Check that a gate_skipped event was emitted with the right fields
    const activityDir = path.join(dataRoot, 'activity');
    const gateSkippedEvents = [];
    if (fs.existsSync(activityDir)) {
      const files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
      for (const file of files) {
        const lines = fs.readFileSync(path.join(activityDir, file), 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev.event === 'gate_skipped' && ev.source === 'pickle' &&
                ev.gate_payload?.reason === 'signature_caller_gap') {
              gateSkippedEvents.push(ev);
            }
          } catch { /* skip malformed */ }
        }
      }
    }
    assert.ok(
      gateSkippedEvents.length > 0,
      `expected at least one gate_skipped event with source:'pickle' reason:'signature_caller_gap'; found ${gateSkippedEvents.length} in ${activityDir}; stderr=${result.stderr}; stdout=${result.stdout}`,
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
