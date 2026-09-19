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
  countWrittenAnalyses,
  resolveRefinementDisposition,
  ZERO_ANALYSES_EXIT_CODE,
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

// AP-EXT-ITER234-01: `ticketsForSmell` reaches a smell's tickets through TWO
// independent channels — the smell's own `ticket_ids` cross-reference and the
// ticket's `source_ac_ids` back-reference, OR'd. Every fixture above sets BOTH,
// so `source_ac_ids` decided all of them and the `ticket_ids` arm was never the
// deciding one: deleting it left the whole suite green while a smell that names
// its tickets only through `ticket_ids` (the schema's own
// `"ticket_ids": ["ticket-id-if-known"]` channel, and the only reader of that
// field) matched nothing, took the zero-match branch and returned exit 2 —
// `main()` process.exit(2)s on that, so `/pickle-refine-prd` halts before it
// emits REFINEMENT_DIR=/MANIFEST=.
//
// DERIVED from the channel space, not hand-picked rows: a future third channel
// gets a row here by construction rather than leaving a blind arm behind. Both
// directions are load-bearing — the two single-channel rows kill an arm
// deletion, and the no-channel row kills a matcher that accepts everything.
const SMELL_MATCH_CHANNELS = [
  { name: 'neither channel', byTicketIds: false, bySourceAcIds: false, matches: false },
  { name: 'ticket_ids only', byTicketIds: true, bySourceAcIds: false, matches: true },
  { name: 'source_ac_ids only', byTicketIds: false, bySourceAcIds: true, matches: true },
  { name: 'both channels', byTicketIds: true, bySourceAcIds: true, matches: true },
];

function channelManifest({ byTicketIds, bySourceAcIds }) {
  return {
    ac_shape_smells: [{
      ac_id: 'AC-CHAN-1',
      ...(byTicketIds ? { ticket_ids: ['T-CHAN-1'] } : { ticket_ids: [] }),
    }],
    tickets: [{
      id: 'T-CHAN-1',
      // Parametrized on purpose: the ONLY thing that can make this manifest
      // violate is the smell failing to reach the ticket at all.
      title: 'All handlers enforce the shared invariant',
      source_ac_ids: bySourceAcIds ? ['AC-CHAN-1'] : [],
      acceptance_test: "describeEach([['getA'], ['getB']]) (tests/helpers/describe-each.js) covers every target",
    }],
    prd_advisory_shape_concerns: [],
  };
}

for (const channel of SMELL_MATCH_CHANNELS) {
  test(`AP-EXT-ITER234-01: smell reaches its ticket via ${channel.name} → ${channel.matches ? 'no violation' : 'zero-match violation'}`, () => {
    const manifest = channelManifest(channel);
    const violations = evaluateAcShapeEnforcement(manifest);

    if (channel.matches) {
      assert.deepEqual(
        violations,
        [],
        `a parametrized ticket reachable via ${channel.name} must not violate — the arm carrying it is load-bearing against a halt`
      );
      return;
    }

    assert.equal(violations.length, 1, 'an unreachable smell must produce exactly one violation');
    assert.equal(violations[0].ac_id, 'AC-CHAN-1');
    assert.match(violations[0].reason, /no matching ticket entries were emitted/);
  });
}

test('AP-EXT-ITER234-01: the halt is the consequence — runAcShapeEnforcement exit code per channel', () => {
  // The violation list is advisory until main() reads the code: `if
  // (acShapeStatus !== 0) process.exit(acShapeStatus)`. Assert the verdict that
  // actually stops the pipeline, not just the finding that precedes it.
  const codes = SMELL_MATCH_CHANNELS.map((channel) => ({
    name: channel.name,
    code: runAcShapeEnforcement(channelManifest(channel), {}),
  }));

  assert.deepEqual(
    codes,
    [
      { name: 'neither channel', code: 2 },
      { name: 'ticket_ids only', code: 0 },
      { name: 'source_ac_ids only', code: 0 },
      { name: 'both channels', code: 0 },
    ],
    'exactly one channel combination may halt the refinement phase'
  );
});

// ─── Z3: UNIVERSAL_QUANTIFIER_RE recognizes negative universals ─────────────
//
// `UNIVERSAL_QUANTIFIER_RE` matched only affirmative quantifiers (`all`, `every`,
// `for any`, `each`). "No rule emits an invalid response" and "a FAIL never renders
// below a PASS" state the same universal claim negated, and ordinary "any handler
// that throws is retried" is a bare-`any` universal — none of the three matched,
// so a correctly-parametrized ticket phrased that way failed `isParametrizedTicket`
// and single-ticket-collapse enforcement halted the refinement (exit 2) over the
// shape the gate itself asked for.
//
// `isParametrizedTicket` requires the quantifier AND a `describeEach(...)`-shaped
// acceptance test; pairing every title below with a fixed describeEach acceptance
// test isolates the quantifier bit through the real exported predicate.
const EACH_TABLE_ACCEPTANCE_TEST = "describeEach([['a'], ['b']])('%s passes', ...)";

test('Z3-1: all five probe titles are recognized as universal-quantifier tickets', () => {
  const probes = [
    'All rules emit valid responses',
    'Every rule emits valid responses',
    'NO rule emits an invalid response',
    'A FAIL never renders below a PASS',
    'any handler that throws is retried',
  ];
  for (const title of probes) {
    assert.ok(
      isParametrizedTicket({
        id: 'T-Z3-1',
        title,
        source_ac_ids: [],
        acceptance_test: EACH_TABLE_ACCEPTANCE_TEST,
      }),
      `probe title must be recognized as a universal-quantifier ticket: "${title}"`,
    );
  }
});

test('Z3-3: the four previously-recognized spellings (all, every, for any, each) still match', () => {
  const previouslyPassing = [
    'All handlers pass',
    'Every handler passes',
    'validated for any input',
    'each handler passes',
  ];
  for (const title of previouslyPassing) {
    assert.ok(
      isParametrizedTicket({
        id: 'T-Z3-3',
        title,
        source_ac_ids: [],
        acceptance_test: EACH_TABLE_ACCEPTANCE_TEST,
      }),
      `previously-recognized spelling must still match: "${title}"`,
    );
  }
});

test('Z3-3: the two committed real-corpus fixtures do not regress', () => {
  const corpusRoot = path.resolve(__dirname, 'fixtures', 'greenfield-corpus');
  const positive = JSON.parse(fs.readFileSync(path.join(corpusRoot, 'loa727-ac-shape', 'manifest.json'), 'utf-8'));
  const negative = JSON.parse(fs.readFileSync(path.join(corpusRoot, 'negative-ac-shape', 'manifest.json'), 'utf-8'));

  assert.deepEqual(
    evaluateAcShapeEnforcement(positive), [],
    'the already-parametrized real corpus ticket must still pass with zero violations',
  );
  const negativeViolations = evaluateAcShapeEnforcement(negative);
  assert.ok(
    negativeViolations.length > 0,
    'the genuinely-unparametrized real corpus ticket must still violate — widening must not strip the gate of its teeth',
  );
});

// Z3-2 over-trigger control, plus a positive replay: text below is copied verbatim
// from real Acceptance Criteria bullets authored in this bundle's own sibling
// tickets (session 2026-09-14-859d5d65, tickets 7d42b8d6 and f666fc52) — not
// invented strings. Replayed against the OLD and NEW pattern during research; see
// research_2026-09-14.md for the full before/after table.
const REAL_CORPUS_NO_QUANTIFIER = [
  // Z2-1
  'the shared mapper returns metric_unmeasurable_unrecoverable / metric_unmeasurable_transient, and the phase (baseline | iteration) is recorded as a separate field.',
  // Z2-2
  'a genuine baseline failure records phase baseline.',
  // Z2-4
  'a state.json persisted with exit_reason: baseline_unmeasurable_unrecoverable (and _transient) reads back and classifies identically through classifyMicroverseHaltDecision / isFatalPhaseFailure.',
  // Z1-4
  'the sole ticket-tagged commit is a commit-and-continue recovery (R-ORSR-2) commit, and a grep AC is demonstrably false. The ticket does NOT reach Done through the commitAndContinueDoneFlip path.',
  // Z1-5
  'real work is committed and the executable AC is TRUE. The ticket flips Done on the first attempt.',
];

const REAL_CORPUS_AFFIRMATIVE_UNIVERSAL = [
  // Z2-5 (contains "each")
  'disposition parity. For each renamed reason, reportAs, exitCode, fatal-ness and halt-decision action equal the old reasons values (asserted by a test that derives the old values, not a hand-copied table).',
  // Z1-1 (contains "every")
  'a ticket whose AC carries an explicit executable assertion that FAILS does not reach Done at the Done-flip seam, even with every checkbox ticked.',
];

const REAL_CORPUS_NEGATIVE_UNIVERSAL = [
  // Z1-2
  'that refusal parks the ticket with a named reason and the loop continues. A test asserts no exit_reason is recorded and the decision is not a halt.',
  // Z1-3
  'a ticket with NO executable assertion yields the same decision as before the change (control case).',
  // Z2-3
  'an iteration failure after a successful baseline records phase iteration, and no emitted reason/log/event carries a baseline_-prefixed name (the ec274d75 worked case).',
];

test('Z3-2 (over-trigger control): real criteria stating no universal never become parametrized', () => {
  for (const title of REAL_CORPUS_NO_QUANTIFIER) {
    assert.equal(
      isParametrizedTicket({ id: 'T-Z3-2-neg', title, source_ac_ids: [], acceptance_test: EACH_TABLE_ACCEPTANCE_TEST }),
      false,
      `criterion stating no universal must not become parametrized: "${title}"`,
    );
  }
});

test('Z3-2/Z3-3: real criteria already stating an affirmative universal are unaffected', () => {
  for (const title of REAL_CORPUS_AFFIRMATIVE_UNIVERSAL) {
    assert.equal(
      isParametrizedTicket({ id: 'T-Z3-3-real', title, source_ac_ids: [], acceptance_test: EACH_TABLE_ACCEPTANCE_TEST }),
      true,
      `real criterion already carrying an affirmative universal must still match: "${title}"`,
    );
  }
});

test('Z3-2: real criteria genuinely stating a negative universal are now recognized', () => {
  for (const title of REAL_CORPUS_NEGATIVE_UNIVERSAL) {
    assert.equal(
      isParametrizedTicket({ id: 'T-Z3-2-pos', title, source_ac_ids: [], acceptance_test: EACH_TABLE_ACCEPTANCE_TEST }),
      true,
      `real criterion genuinely stating a negative universal must now be recognized: "${title}"`,
    );
  }
});

// eb189d66: the wrapper's exit disposition must derive from the COUNT of analyses
// actually written to cycleResults.refinementDir, never from which roles were asked.

function makeCycleResults(refinementDir, { allSuccess, finalResults }) {
  return {
    refinementDir,
    cyclesRequested: 1,
    maxTurns: 1,
    allCycleResults: [finalResults],
    finalResults,
    allSuccess,
  };
}

function makeWorkerResult(roleId, success) {
  return { roleId, success, logPath: `worker_${roleId}_c1.log`, cycle: 1, exitCode: success ? 0 : 1 };
}

test('eb189d66: countWrittenAnalyses returns 0 for a non-existent directory', () => {
  const missingDir = path.join(os.tmpdir(), `pickle-refinement-missing-${Date.now()}-${Math.random()}`);
  assert.equal(countWrittenAnalyses(missingDir), 0, 'a directory that was never created has zero written analyses');
});

test('eb189d66: countWrittenAnalyses counts only canonical analysis_<role>.md files', () => {
  const refinementDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-refinement-count-'));
  try {
    fs.writeFileSync(path.join(refinementDir, 'analysis_requirements.md'), '# requirements\n');
    fs.writeFileSync(path.join(refinementDir, 'analysis_codebase.md'), '# codebase\n');
    // per-cycle archive, not canonical — must not be counted
    fs.writeFileSync(path.join(refinementDir, 'analysis_codebase_c1.md'), '# codebase cycle 1\n');
    fs.writeFileSync(path.join(refinementDir, 'worker_requirements_c1.log'), 'log\n');
    assert.equal(countWrittenAnalyses(refinementDir), 2, 'only the two canonical analysis_<role>.md files count');
  } finally {
    fs.rmSync(refinementDir, { recursive: true, force: true });
  }
});

test('eb189d66: total failure (zero analyses written) exits non-zero with a named reason', () => {
  const refinementDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-refinement-zero-'));
  try {
    const finalResults = [
      makeWorkerResult('requirements', false),
      makeWorkerResult('codebase', false),
      makeWorkerResult('risk-scope', false),
    ];
    const cycleResults = makeCycleResults(refinementDir, { allSuccess: false, finalResults });
    const disposition = resolveRefinementDisposition(cycleResults);
    assert.equal(disposition.exitCode, ZERO_ANALYSES_EXIT_CODE, 'zero analyses must exit non-zero');
    assert.notEqual(disposition.exitCode, 0, 'zero analyses must never exit 0');
    // 80b82391: the status must be readable by a caller, not merely non-zero. This file
    // exits 1 for arg/usage errors, for an ensureRefinementDir mkdir failure, and from
    // main().catch on any uncaught throw, so a 1 here is indistinguishable from a crash.
    assert.notEqual(
      disposition.exitCode,
      1,
      'zero analyses must not reuse 1 — this file exits 1 on usage errors and on any uncaught throw'
    );
    assert.match(disposition.message, /zero_analyses_produced/, 'the failure must name a reason');
    assert.match(disposition.message, /requirements/, 'message must name the failed roles');
    assert.doesNotMatch(disposition.message, /available analyses/, 'the false "available analyses" claim must be gone');
  } finally {
    fs.rmSync(refinementDir, { recursive: true, force: true });
  }
});

test('eb189d66 (over-trigger control): partial success still exits 0 and still warns, naming the produced count', () => {
  const refinementDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-refinement-partial-'));
  try {
    fs.writeFileSync(path.join(refinementDir, 'analysis_codebase.md'), '# codebase\n');
    fs.writeFileSync(path.join(refinementDir, 'analysis_risk-scope.md'), '# risk-scope\n');
    const finalResults = [
      makeWorkerResult('requirements', false),
      makeWorkerResult('codebase', true),
      makeWorkerResult('risk-scope', true),
    ];
    const cycleResults = makeCycleResults(refinementDir, { allSuccess: false, finalResults });
    const disposition = resolveRefinementDisposition(cycleResults);
    assert.equal(disposition.exitCode, 0, 'a fix that reds partial success is worse than the defect it fixes');
    assert.match(disposition.message, /⚠/u, 'partial success must still warn');
    assert.match(disposition.message, /\b2\b/, 'the warning must state the produced count (2)');
    assert.match(disposition.message, /requirements/, 'the warning must still name the failed role');
    assert.doesNotMatch(disposition.message, /available analyses/, 'the false "available analyses" claim must be gone');
  } finally {
    fs.rmSync(refinementDir, { recursive: true, force: true });
  }
});

test('eb189d66: full success is a no-op disposition (unreachable via main, but the function is total)', () => {
  const refinementDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-refinement-full-'));
  try {
    const finalResults = [makeWorkerResult('requirements', true)];
    const cycleResults = makeCycleResults(refinementDir, { allSuccess: true, finalResults });
    const disposition = resolveRefinementDisposition(cycleResults);
    assert.equal(disposition.exitCode, 0);
    assert.equal(disposition.message, '');
  } finally {
    fs.rmSync(refinementDir, { recursive: true, force: true });
  }
});
