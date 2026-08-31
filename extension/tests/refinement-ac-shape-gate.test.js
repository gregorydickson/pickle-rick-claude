// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/spawn-refinement-team.js');

const {
  evaluateAcShapeEnforcement,
  evaluateAcShapeAdvisory,
  runAcShapeEnforcement,
  isParametrizedTicket,
} = await import('../bin/spawn-refinement-team.js');

// AC-ACSG-1a: cross-field recognition — evaluateAcShapeEnforcement returns [] for valid parametrized tickets

test('AC-ACSG-1a: universal quantifier in title, describe.each( only in acceptance_test → no violation', () => {
  const violations = evaluateAcShapeEnforcement({
    ac_shape_smells: [{ ac_id: 'AC-1', ticket_ids: ['T1'] }],
    tickets: [{
      id: 'T1',
      title: 'All handlers validate permissions',
      source_ac_ids: ['AC-1'],
      acceptance_test: 'describe.each([["getA"], ["getB"]]) validates permissions',
    }],
  });
  assert.deepEqual(violations, [], 'quantifier in title + describe.each in acceptance_test should pass');
});

test('AC-ACSG-1a: universal quantifier in acceptance_test, describe.each( only in title → no violation', () => {
  const violations = evaluateAcShapeEnforcement({
    ac_shape_smells: [{ ac_id: 'AC-2', ticket_ids: ['T2'] }],
    tickets: [{
      id: 'T2',
      title: 'describe.each([["getA"], ["getB"]]) validates permissions',
      source_ac_ids: ['AC-2'],
      acceptance_test: 'All handlers validate permissions for every input',
    }],
  });
  assert.deepEqual(violations, [], 'describe.each in title + quantifier in acceptance_test should pass');
});

// AC-ACSG-1b: isParametrizedTicket cross-field recognition

test('AC-ACSG-1b: isParametrizedTicket returns true when quantifier and describe.each are in different fields', () => {
  // quantifier in title, describe.each in acceptance_test
  assert.strictEqual(
    isParametrizedTicket({
      id: 'T1',
      title: 'All handlers must validate permissions',
      source_ac_ids: [],
      acceptance_test: 'describe.each([["getA"], ["getB"]]) tests each handler',
    }),
    true,
    'quantifier in title + describe.each in acceptance_test'
  );

  // quantifier in acceptance_test, describe.each in title
  assert.strictEqual(
    isParametrizedTicket({
      id: 'T2',
      title: 'describe.each([["getA"]]) tests handlers',
      source_ac_ids: [],
      acceptance_test: 'Every handler validates permissions',
    }),
    true,
    'describe.each in title + quantifier in acceptance_test'
  );

  // both tokens in justification field
  assert.strictEqual(
    isParametrizedTicket({
      id: 'T3',
      title: 'Handler validation',
      source_ac_ids: [],
      acceptance_test: 'Handlers validate permissions',
      justification: 'All handlers covered — describe.each([["getA"]]) in test',
    }),
    true,
    'both tokens in justification field'
  );
});

test('AC-ACSG-1b: isParametrizedTicket returns false when neither token appears in any field', () => {
  assert.strictEqual(
    isParametrizedTicket({
      id: 'T4',
      title: 'Handler validates permissions',
      source_ac_ids: [],
      acceptance_test: 'getA returns 200',
    }),
    false,
    'no quantifier and no describe.each → should return false'
  );
});

// AC-ACSG-1c: PICKLE_AC_GATE_DEBUG=1 emits matcher lines; unset emits nothing

test('AC-ACSG-1c: PICKLE_AC_GATE_DEBUG=1 emits matcher: lines to stderr', () => {
  const captured = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };

  const prev = process.env.PICKLE_AC_GATE_DEBUG;
  process.env.PICKLE_AC_GATE_DEBUG = '1';

  try {
    evaluateAcShapeEnforcement({
      ac_shape_smells: [{ ac_id: 'AC-1', ticket_ids: ['T1'] }],
      tickets: [{
        id: 'T1',
        title: 'All handlers validate permissions',
        source_ac_ids: ['AC-1'],
        acceptance_test: 'describe.each([["getA"]]) validates each handler',
      }],
    });
  } finally {
    process.stderr.write = originalWrite;
    if (prev === undefined) {
      delete process.env.PICKLE_AC_GATE_DEBUG;
    } else {
      process.env.PICKLE_AC_GATE_DEBUG = prev;
    }
  }

  const output = captured.join('');
  assert.match(output, /^matcher: regex=.*, field=.*, value=.*, result=(match|no-match)$/m,
    'should emit at least one matcher: line in expected format');
});

test('AC-ACSG-1c: without PICKLE_AC_GATE_DEBUG no matcher: lines emitted', () => {
  const captured = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };

  const prev = process.env.PICKLE_AC_GATE_DEBUG;
  delete process.env.PICKLE_AC_GATE_DEBUG;

  try {
    evaluateAcShapeEnforcement({
      ac_shape_smells: [{ ac_id: 'AC-1', ticket_ids: ['T1'] }],
      tickets: [{
        id: 'T1',
        title: 'All handlers validate permissions',
        source_ac_ids: ['AC-1'],
        acceptance_test: 'describe.each([["getA"]]) validates each handler',
      }],
    });
  } finally {
    process.stderr.write = originalWrite;
    if (prev === undefined) {
      delete process.env.PICKLE_AC_GATE_DEBUG;
    } else {
      process.env.PICKLE_AC_GATE_DEBUG = prev;
    }
  }

  const matcherLines = captured.join('').split('\n').filter((l) => l.startsWith('matcher:'));
  assert.strictEqual(matcherLines.length, 0, 'no matcher: lines should appear without the debug flag');
});

// AC-ACSG-1c lint check: grep-able sentinel for PICKLE_AC_GATE_DEBUG presence in source
test('AC-ACSG-1c: PICKLE_AC_GATE_DEBUG appears in spawn-refinement-team.ts source', async () => {
  const { createReadStream } = await import('node:fs');
  const { createInterface } = await import('node:readline');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');

  const srcPath = path.default.resolve(
    fileURLToPath(import.meta.url),
    '../../src/bin/spawn-refinement-team.ts'
  );

  const rl = createInterface({ input: createReadStream(srcPath, { encoding: 'utf-8' }) });
  let count = 0;
  for await (const line of rl) {
    if (line.includes('PICKLE_AC_GATE_DEBUG')) count++;
  }
  assert.ok(count >= 1, `PICKLE_AC_GATE_DEBUG must appear at least once in spawn-refinement-team.ts (found ${count} times)`);
});

// AC-ACSG-2a: correctly-consolidated tickets produce no normative violation; advisory channel non-empty

test('AC-ACSG-2a: correctly-consolidated tickets pass normative gate; prd_advisory_shape_concerns surfaces advisory warning', () => {
  const manifest = {
    ac_shape_smells: [{ ac_id: 'AC-ADV', ticket_ids: ['T1'] }],
    tickets: [{
      id: 'T1',
      title: 'All handlers validate permissions',
      source_ac_ids: ['AC-ADV'],
      acceptance_test: 'describe.each([["getA"], ["getB"]]) validates each handler',
    }],
    prd_advisory_shape_concerns: [
      'AC-ADV: operator PRD prose enumerated per-row sub-items; analyst correctly consolidated into parametrized ticket T1',
    ],
  };

  const violations = evaluateAcShapeEnforcement(manifest);
  assert.deepEqual(violations, [], 'correctly-consolidated tickets must produce no normative violations');

  const advisory = evaluateAcShapeAdvisory(manifest);
  assert.ok(advisory.length > 0, 'advisory channel must be non-empty when prd_advisory_shape_concerns is present');
  assert.ok(typeof advisory[0] === 'string' && advisory[0].length > 0, 'advisory warning must be a non-empty string');
});

test('AC-ACSG-2a: empty prd_advisory_shape_concerns yields empty advisory channel', () => {
  const manifest = { prd_advisory_shape_concerns: [] };
  assert.deepEqual(evaluateAcShapeAdvisory(manifest), []);
});

test('AC-ACSG-2a: absent prd_advisory_shape_concerns yields empty advisory channel', () => {
  const manifest = {};
  assert.deepEqual(evaluateAcShapeAdvisory(manifest), []);
});

// AC-ACSG-2b: --skip-ac-shape-gate bypass + event registration

test('AC-ACSG-2b: runAcShapeEnforcement with skipAcShapeGate returns 0 on otherwise-violating manifest', () => {
  const violatingManifest = {
    ac_shape_smells: [{ ac_id: 'AC-X', ticket_ids: ['T1'] }],
    tickets: [{
      id: 'T1',
      title: 'Handler validates',
      source_ac_ids: ['AC-X'],
      acceptance_test: 'getA returns 200',
    }],
    prd_advisory_shape_concerns: [],
  };

  const withoutSkip = runAcShapeEnforcement(violatingManifest);
  assert.equal(withoutSkip, 2, 'manifest with normative violation should return 2 without skip');

  const withSkip = runAcShapeEnforcement(violatingManifest, { skipAcShapeGate: 'operator: analyst tickets verified correct' });
  assert.equal(withSkip, 0, '--skip-ac-shape-gate with reason must short-circuit to 0');
});

test('AC-ACSG-2b: --skip-ac-shape-gate emits ac_shape_gate_bypassed activity event to state.json', () => {
  const violatingManifest = {
    ac_shape_smells: [{ ac_id: 'AC-X', ticket_ids: ['T1'] }],
    tickets: [{
      id: 'T1',
      title: 'Handler validates',
      source_ac_ids: ['AC-X'],
      acceptance_test: 'getA returns 200',
    }],
    prd_advisory_shape_concerns: [],
  };

  const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acsg2b-')));
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    schema_version: 5,
    active: false,
    session_dir: sessionDir,
    working_dir: sessionDir,
    iteration: 0,
    max_iterations: 15,
    worker_timeout_seconds: 3600,
    start_time_epoch: 0,
    backend: 'claude',
    step: 'prd',
    history: [],
    activity: [],
    started_at: new Date().toISOString(),
    worker_artifact_progress: {},
  }));
  try {
    runAcShapeEnforcement(violatingManifest, {
      sessionDir,
      skipAcShapeGate: 'operator: analyst tickets verified correct',
    });
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const events = (state.activity ?? []).filter((e) => e.event === 'ac_shape_gate_bypassed');
    assert.equal(events.length, 1, 'exactly one ac_shape_gate_bypassed event must be emitted');
    assert.equal(events[0].gate_payload.reason, 'operator: analyst tickets verified correct', 'event must carry the reason');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AC-ACSG-2b: --skip-ac-shape-gate without reason exits 64', () => {
  const result = spawnSync(process.execPath, [BIN, '--skip-ac-shape-gate'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  assert.equal(result.status, 64, '--skip-ac-shape-gate without reason must exit 64');
  assert.match(result.stderr, /--skip-ac-shape-gate requires a non-empty reason/, 'stderr must explain the requirement');
});

test('AC-ACSG-2b: --skip-ac-shape-gate with --prefixed next arg exits 64', () => {
  const result = spawnSync(process.execPath, [BIN, '--skip-ac-shape-gate', '--next-flag'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  assert.equal(result.status, 64, '--skip-ac-shape-gate followed by a flag must exit 64');
});

test('AC-ACSG-2b: ac_shape_gate_bypassed appears in all 4 required touchpoints', () => {
  const root = path.resolve(__dirname, '../..');
  const files = [
    path.join(root, 'extension/src/types/index.ts'),
    path.join(root, 'extension/types/index.js'),
    path.join(root, 'extension/src/types/activity-events.schema.json'),
    path.join(root, 'extension/src/bin/spawn-refinement-team.ts'),
  ];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    assert.ok(
      content.includes('ac_shape_gate_bypassed'),
      `ac_shape_gate_bypassed must appear in ${path.relative(root, file)}`,
    );
  }
});

// AC-ACSG-2c: actionable error names ac_id+ticket AND includes fix template or override path

test('AC-ACSG-2c: violation stderr contains ac_id+ticket and describe.each or --skip-ac-shape-gate', () => {
  const manifest = {
    ac_shape_smells: [{ ac_id: 'AC-ERR', ticket_ids: ['T1'] }],
    tickets: [{
      id: 'T1',
      title: 'Handler validates',
      source_ac_ids: ['AC-ERR'],
      acceptance_test: 'getA returns 200',
    }],
    prd_advisory_shape_concerns: [],
  };

  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    runAcShapeEnforcement(manifest);
  } finally {
    process.stderr.write = origWrite;
  }

  const output = stderrLines.join('');
  assert.match(output, /AC-ERR.*ticket/, 'output must name the failing ac_id (AC-ERR) and include "ticket"');
  assert.match(output, /describe\.each\(\[|--skip-ac-shape-gate/, 'output must contain describe.each([ fix template OR --skip-ac-shape-gate override path');
});

// AC-ACSG-3a: LOA-727 attempt-2 regression fixture — loosened gate accepts the shape

test('AC-ACSG-3a: LOA-727 attempt-2 fixture accepted (or clear-error per R-ACSG-2c)', () => {
  const fixturePath = path.resolve(__dirname, 'fixtures/ac-shape-gate/loa-727-attempt2-manifest.json');
  assert.ok(fs.existsSync(fixturePath), 'fixture file must exist at extension/tests/fixtures/ac-shape-gate/loa-727-attempt2-manifest.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const violations = evaluateAcShapeEnforcement(fixture);
  if (violations.length > 0) {
    // R-ACSG-2c: if still rejected, error must be actionable — names ac_id+ticket and includes fix template
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      runAcShapeEnforcement(fixture);
    } finally {
      process.stderr.write = origWrite;
    }
    const output = stderrLines.join('');
    assert.match(output, /LOA-727-AC-1.*ticket/, 'if rejected, error must name ac_id and "ticket"');
    assert.match(output, /describe\.each\(\[|--skip-ac-shape-gate/, 'if rejected, error must include fix template or override path');
  } else {
    assert.deepEqual(violations, [], 'LOA-727 attempt-2 fixture must be accepted by the loosened gate');
  }
});

// AC-ACSG-3b: monotonicity — two evaluations on same fixture produce identical results

test('AC-ACSG-3b: evaluateAcShapeEnforcement is deterministic — same result on two calls', () => {
  const fixturePath = path.resolve(__dirname, 'fixtures/ac-shape-gate/loa-727-attempt2-manifest.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const run1 = evaluateAcShapeEnforcement(fixture);
  const run2 = evaluateAcShapeEnforcement(fixture);
  assert.strictEqual(run1.length, run2.length, 'violation count must be identical across two evaluations');
  assert.strictEqual(
    JSON.stringify(run1.map((v) => v.ac_id).sort()),
    JSON.stringify(run2.map((v) => v.ac_id).sort()),
    'violation ac_id set must be identical across two evaluations',
  );
});

// AC-ACSG-3c: negative corpus — genuinely-enumerated ACs still produce violations

test('AC-ACSG-3c: single truly-enumerated ticket (no quantifier, no describe.each) produces >= 1 violation', () => {
  const violations = evaluateAcShapeEnforcement({
    ac_shape_smells: [{ ac_id: 'AC-NEG-1', ticket_ids: ['T-NEG-1'] }],
    tickets: [{
      id: 'T-NEG-1',
      title: 'Handler validates permissions',
      source_ac_ids: ['AC-NEG-1'],
      acceptance_test: 'getA returns 200',
    }],
  });
  assert.ok(violations.length >= 1, 'truly-enumerated single ticket must produce at least one violation');
});

test('AC-ACSG-3c: multi-ticket split with one empty justification produces >= 1 violation', () => {
  const violations = evaluateAcShapeEnforcement({
    ac_shape_smells: [{ ac_id: 'AC-NEG-2', ticket_ids: ['T-NEG-2A', 'T-NEG-2B'] }],
    tickets: [
      {
        id: 'T-NEG-2A',
        title: 'Handler getA validates permissions',
        source_ac_ids: ['AC-NEG-2'],
        acceptance_test: 'getA returns 200',
        justification: 'covers getA path only',
      },
      {
        id: 'T-NEG-2B',
        title: 'Handler getB validates permissions',
        source_ac_ids: ['AC-NEG-2'],
        acceptance_test: 'getB returns 200',
        // no justification — unjustified split
      },
    ],
  });
  assert.ok(violations.length >= 1, 'multi-ticket split with one empty justification must produce at least one violation');
  const unjustifiedViolation = violations.find((v) => v.ac_id === 'AC-NEG-2');
  assert.ok(unjustifiedViolation, 'violation must reference AC-NEG-2');
  assert.ok(unjustifiedViolation.ticket_ids.includes('T-NEG-2B'), 'violation must identify the unjustified ticket T-NEG-2B');
});

// FR-C2: the refinement template must recommend describeEach([...]) (the repo's
// real tests/helpers/describe-each.js idiom), never bare describe.each( — which
// does not exist on node:test — as the spelling to WRITE.

test('FR-C2: no non-comment line in the shipped module advises bare describe.each( as the spelling to write', () => {
  const source = fs.readFileSync(BIN, 'utf-8');
  const offendingLines = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .filter((line) => line.includes('describe.each('));
  assert.deepEqual(
    offendingLines,
    [],
    `every non-comment describe.each( occurrence must be gone — found: ${JSON.stringify(offendingLines)}`,
  );
});

test('FR-C2: every advice string recommends describeEach([...]) with the real helper path', () => {
  const source = fs.readFileSync(BIN, 'utf-8');
  assert.match(
    source,
    /"acceptance_test":\s*"describeEach\(\[\.\.\.\]\).*tests\/helpers\/describe-each\.js/,
    'the acceptance_test template example must recommend describeEach([...]) with the real helper path',
  );
  assert.match(
    source,
    /single-ticket collapse lacks a universal-quantifier title or describeEach\(\[\.\.\.\]\) acceptance test/,
    'the single-ticket-collapse violation reason must recommend describeEach([...])',
  );
  assert.match(
    source,
    /Fix: rewrite ticket to use universal quantifier title AND describeEach\(\[/,
    'the stderr Fix template must recommend describeEach([',
  );
});

test('FR-C2: mutation-verify — the gate still fires on a genuinely bad ticket after the spelling edit', () => {
  const violations = evaluateAcShapeEnforcement({
    ac_shape_smells: [{ ac_id: 'AC-FRC2', ticket_ids: ['T-FRC2'] }],
    tickets: [{
      id: 'T-FRC2',
      title: 'Handler validates permissions',
      source_ac_ids: ['AC-FRC2'],
      acceptance_test: 'getA returns 200',
    }],
  });
  assert.strictEqual(violations.length, 1, 'a genuinely enumerated single ticket must still violate the gate');
  assert.match(
    violations[0].reason,
    /describeEach\(\[\.\.\.\]\)/,
    'the violation reason must cite the describeEach spelling, not describe.each',
  );
});

test('FR-C2: the repo idiom (describeEach) still satisfies isParametrizedTicket', () => {
  const ticket = {
    id: 'T-FRC2-OK',
    title: 'All handlers reject anonymous callers',
    source_ac_ids: ['AC-FRC2-OK'],
    acceptance_test: "describeEach([['getA'], ['getB']])('%s rejects anonymous', ...)",
  };
  assert.ok(isParametrizedTicket(ticket), 'describeEach([...]) over a table must still satisfy the parametrized-ticket predicate');
});
