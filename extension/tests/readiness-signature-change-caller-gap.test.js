// @tier: fast
// R-SIGF (LOA-1488, WS-1) — DEMOTED TO ADVISORY (W5b, 2026-07-10): the readiness
// scan still emits a `signature_caller_gap` finding when a ticket changes an
// exported/injected symbol's ARITY (adds a constructor param) or a schema's shape
// and an out-of-scope `*.spec.ts` / factory caller would be left stale — but the
// finding NEVER fails readiness. The original blocking arm ran ~240x over its
// skip-flag budget (725 gate_skipped uses/10d vs budget 3); per W5b a guard past
// its budget is loosened or removed, never given another hatch. The former
// suppression apparatus (skip_quality_gates_reason bypass, auto-extend degrade)
// was deleted with the block; the build-phase scope auto-extension
// (`computeScopeAutoExtension`, pipeline-runner) remains the absorbing mechanism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/check-readiness.js');

function tmpDir(prefix = 'pickle-sigf-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeTicket(sessionDir, id, body) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), body);
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

function arityTicketBody(id, key, service, file) {
  return [
    '---',
    `id: ${id}`,
    `key: ${key}`,
    'ac_ids: []',
    '---',
    '',
    `# Add a 3rd constructor parameter to ${service}`,
    '',
    '## Files to modify',
    '',
    `- \`${file}\``,
    '',
    '## Acceptance Criteria',
    '',
    `- [ ] \`${service}\` constructor accepts exactly \`3\` parameters.`,
    '',
  ].join('\n');
}

// W5b demotion pin: an arity gap with an out-of-scope git-TRACKED caller SURFACES
// (kind:'signature_caller_gap' in findings) but readiness PASSES (exit 0).
test('W5b: arity change with an out-of-scope positional caller surfaces as advisory — exit 0, finding present', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/widget-service.ts': 'export class WidgetService { constructor(a, b) {} }\n',
    'src/widget-service.spec.ts': "import { WidgetService } from './widget-service';\nconst s = new WidgetService(1, 2);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf1', arityTicketBody('sigf1', 'SIGF-1', 'WidgetService', 'src/widget-service.ts'));
    const result = runReadiness(sessionDir, repoRoot);
    assert.equal(result.status, 0, `signature_caller_gap must not block readiness (exit 0), got ${result.status}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    const gap = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap');
    assert.equal(gap.length, 1, `expected one surfaced signature_caller_gap finding; got ${JSON.stringify(out.findings)}`);
    assert.match(gap[0].detail, /widget-service\.spec\.ts/, 'finding must name the out-of-scope caller');
    assert.match(gap[0].message, /advisory — never blocks readiness/, 'finding must self-describe as advisory');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// WS-2: schema-shape gap keeps kind-aware "Schema-shape change" wording (F2 fix) —
// NEVER the arity "Arity change" wording — and stays advisory.
test('R-SIGF WS-2: schema-shape change with an out-of-scope .parse() consumer emits Schema-shape wording (not Arity), advisory', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/threshold-schema.ts': "import { z } from 'zod';\nexport const ThresholdSchema = z.object({ a: z.number() });\n",
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
    assert.equal(result.status, 0, `schema-shape gap must not block readiness (exit 0), got ${result.status}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, 'pass');
    const gap = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap' && /ThresholdSchema/.test(f.detail));
    assert.equal(gap.length, 1, `expected one schema-shape signature_caller_gap; got ${JSON.stringify(out.findings)}`);
    const msg = gap[0].message;
    assert.match(msg, /schema-shape change/i, `message must use kind-aware schema-shape wording; got: ${msg}`);
    assert.ok(!/Arity change/.test(msg), `schema-shape finding must NOT carry the arity wording; got: ${msg}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Co-scoped caller → no finding at all (a fenced worker can fix it).
test('R-SIGF: in-scope positional caller emits NOTHING (a fenced worker can fix it)', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/gadget-service.ts': 'export class GadgetService { constructor(a, b) {} }\n',
    'src/gadget-service.spec.ts': "import { GadgetService } from './gadget-service';\nconst s = new GadgetService(1, 2);\n",
  });
  try {
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

// No arity change → no finding.
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
    const gap = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap');
    assert.deepEqual(gap, [], `no arity change → no finding; got ${JSON.stringify(gap)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Negative FP bound — out-of-scope caller uses factory (not positional `new X(`).
test('R-SIGF: out-of-scope caller using factory/non-positional call emits nothing (negative FP bound)', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/flux-service.ts': 'export class FluxService { static create(a, b) { return new FluxService(a, b); } constructor(a, b) {} }\n',
    'src/flux-service.spec.ts': "import { FluxService } from './flux-service';\nconst s = FluxService.create(1, 2);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf-fp', arityTicketBody('sigf-fp', 'SIGF-FP', 'FluxService', 'src/flux-service.ts'));
    const result = runReadiness(sessionDir, repoRoot);
    assert.equal(result.status, 0, `expected exit 0 (factory call → heuristic finds no positional gap), got ${result.status}; stdout=${result.stdout}`);
    const out = JSON.parse(result.stdout);
    const gap = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap');
    assert.deepEqual(gap, [], `factory-only caller must not emit signature_caller_gap; got ${JSON.stringify(gap)}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Remediation message: carries BOTH live exits (co-scope, build-phase auto-extend) and
// does NOT direct operators to the retired skip_quality_gates_reason hatch.
test('W5b: advisory remediation message carries co-scope + auto-extend, never the retired skip hatch', () => {
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/epsilon-service.ts': 'export class EpsilonService { constructor(a, b) {} }\n',
    'src/epsilon-service.spec.ts': "import { EpsilonService } from './epsilon-service';\nconst s = new EpsilonService(1, 2);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf-msg', arityTicketBody('sigf-msg', 'SIGF-MSG', 'EpsilonService', 'src/epsilon-service.ts'));
    const result = runReadiness(sessionDir, repoRoot);
    assert.equal(result.status, 0, `expected advisory exit 0; got ${result.status}`);
    const out = JSON.parse(result.stdout);
    const gap = (out.findings ?? []).filter((f) => f.kind === 'signature_caller_gap');
    assert.ok(gap.length > 0, 'expected a surfaced finding');
    const msg = gap[0].message;
    assert.match(msg, /co-scope|## Files to modify/i, 'message must mention co-scoping the caller');
    assert.match(msg, /auto_extend_signature_callers|scope\.auto_extend/i, 'message must mention the scope flag');
    assert.ok(!/skip_quality_gates_reason/.test(msg), `message must NOT point at the retired skip hatch; got: ${msg}`);
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Retirement pins: (a) the SKIP_FLAG_BUDGETS row is gone with the gate, and
// (b) a gap run emits NO gate_skipped signature_caller_gap events (the skip
// surface no longer applies to a gate that cannot block).
test('W5b: budget row retired and no gate_skipped events emitted for signature_caller_gap', async () => {
  const metricsUtils = path.resolve(__dirname, '../services/metrics-utils.js');
  const { SKIP_FLAG_BUDGETS } = await import(metricsUtils);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(SKIP_FLAG_BUDGETS, 'pickle::signature_caller_gap'),
    `SKIP_FLAG_BUDGETS must NOT retain the retired 'pickle::signature_caller_gap' row`,
  );

  const dataRoot = tmpDir('pickle-sigf-data-');
  const sessionDir = tmpDir();
  const repoRoot = gitRepoWith({
    'src/eta-service.ts': 'export class EtaService { constructor(a, b) {} }\n',
    'src/eta-service.spec.ts': "import { EtaService } from './eta-service';\nconst s = new EtaService(1, 2);\n",
  });
  try {
    writeTicket(sessionDir, 'sigf-budget', arityTicketBody('sigf-budget', 'SIGF-BUDGET', 'EtaService', 'src/eta-service.ts'));
    const result = runReadiness(sessionDir, repoRoot, { PICKLE_DATA_ROOT: dataRoot });
    assert.equal(result.status, 0, `expected advisory exit 0; got ${result.status}`);

    const activityDir = path.join(dataRoot, 'activity');
    const gateSkippedEvents = [];
    if (fs.existsSync(activityDir)) {
      const files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
      for (const file of files) {
        const lines = fs.readFileSync(path.join(activityDir, file), 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev.event === 'gate_skipped' && ev.gate_payload?.reason === 'signature_caller_gap') {
              gateSkippedEvents.push(ev);
            }
          } catch { /* skip malformed */ }
        }
      }
    }
    assert.deepEqual(
      gateSkippedEvents, [],
      `a demoted gate must emit no gate_skipped events; found ${JSON.stringify(gateSkippedEvents)}`,
    );
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// AP-EXT-ITER81-01: pins the fact that makes check-readiness.ts's own guarded
// `gitTrackedFiles` (UNBOUNDED_READ_MAX_BUFFER + `enumerationCompleted`) UNREACHABLE:
// `createResolverCache` populates `trackedAllFiles` EAGERLY, so `resolvePathRef`'s
// `cache?.trackedAllFiles ?? gitTrackedFiles(repoRoot)` never takes the right arm.
// The corrected docblock at that function asserts exactly this. If the eager
// population ever goes lazy again the arm comes alive, the docblock's claim becomes
// false, and this test is what says so.
test('AP-EXT-ITER81-01: createResolverCache populates trackedAllFiles eagerly, so the check-readiness ls-files fallback stays unreachable', async () => {
  const { createResolverCache } = await import('../services/signature-caller-gap.js');
  const repoRoot = path.resolve(__dirname, '..', '..');

  const cache = createResolverCache(repoRoot, 120_000);

  assert.ok(
    Array.isArray(cache.trackedAllFiles),
    'trackedAllFiles must be an array on a freshly created cache — a lazy/undefined field '
      + 'revives resolvePathRef\'s `?? gitTrackedFiles(repoRoot)` arm and falsifies the '
      + 'AP-EXT-ITER81-01 docblock in src/bin/check-readiness.ts',
  );
  assert.ok(
    cache.trackedAllFiles.length > 0,
    'trackedAllFiles must be non-empty for this repo; an empty listing means the enumeration '
      + 'itself failed, which is the AP-EXT-ITER81-01 exposure rather than this pin',
  );
  assert.ok(
    cache.trackedSourceFiles.length > 0,
    'trackedSourceFiles feeds resolveSymbolRef candidate selection and comes from the same '
      + 'single enumeration',
  );
});
