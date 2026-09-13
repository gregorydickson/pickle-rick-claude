// @tier: fast
//
// WS-B (f8559470): a ticket that flipped Done over a red `worker_gate_tests_verdict`
// must withhold the pipeline's success verdict, so `unsuccessful` becomes true,
// pipeline-status is not `completed`, and closer-release is skipped. The run still
// executes every remaining phase (park-and-flag, no new abort). A clean run with no
// red test verdicts is unaffected.
//
// B-RELVERD V1 (f04ff132): that term is DERIVED AT FINALIZE from each Done ticket's
// CURRENT verdict, never added to `counters.nonConvergent` at the pickle boundary.
// The counter is a one-way latch (5 raise sites, 0 decrements), and a red test verdict
// is a per-ticket, REPAIRABLE fact — latched at phase 1 of 4, one ticket repaired later
// still doomed the whole run. The trigger is unchanged: only a MEASURED red withholds.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  computePipelineVerdict,
  finalizePhaseSuccess,
  readResumePhasePlan,
} from '../bin/pipeline-runner.js';

// The four real pipeline phases. `computePipelineVerdict` derives the done-over-red term only
// for a run that HAS a pickle phase, which is exactly when the old boundary check ran.
const PHASES = ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'success-verdict-withheld-'));
}

function writeState(statePath, iteration = 1, activity = []) {
  fs.writeFileSync(statePath, JSON.stringify({
    active: false,
    working_dir: '/tmp',
    step: 'completed',
    iteration,
    max_iterations: 500,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: path.dirname(statePath),
    tmux_mode: true,
    exit_reason: null,
    activity,
  }));
}

// ROOT G2 (ticket 6445c637): `worker_gate_tests_verdict` persists only the three-valued
// disposition string — the failure list itself lives in the `worker_gate_failed` activity
// event's `failures` array (spawn-morty.ts:finalizeFailedWorkerGate/flagOffRepoGateRed),
// appended to `state.json.activity`. A red ticket corroborated by a non-empty failure list
// there is a MEASURED red; every fixture below that means "this ticket really failed its
// gate" must carry one, or the withhold this suite exists to prove now correctly declines.
function workerGateFailedEvent(ticketId, failures) {
  return {
    event: 'worker_gate_failed',
    ticket_id: ticketId,
    gate_phase: 'test:fast',
    failures,
    retry_count: 0,
    ts: new Date().toISOString(),
  };
}

function makeRuntime(dir, phases = PHASES) {
  const statePath = path.join(dir, 'state.json');
  return {
    runtime: {
      sessionDir: dir,
      statePath,
      config: { phases },
      workingDir: '/tmp',
      log: () => {},
    },
    statePath,
    cancelMarker: path.join(dir, 'pipeline-cancel'),
  };
}

function writeTicket(sessionDir, ticketId, { status, testsVerdict, title } = {}) {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  const lines = [
    '---',
    `id: ${ticketId}`,
    `title: "${title || ticketId}"`,
    `status: ${status}`,
    'order: 1',
  ];
  if (testsVerdict !== undefined) lines.push(`worker_gate_tests_verdict: ${testsVerdict}`);
  lines.push('---', '', `# ${title || ticketId}`, '');
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${ticketId}.md`), lines.join('\n'));
}

function readStatus(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'));
}

// Every phase executed and nothing else withheld: `pipelineFailed` is false, so the
// done-over-red term is the ONLY thing that can make the verdict unsuccessful.
function allPhasesRan() {
  return { completed: PHASES.length, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
}

function makeCounters() {
  return { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
}

// The finalize seam: `finalizePipeline`'s only verdict call. Returns the verdict plus the
// counters and logs it produced, so a case can assert the attribution as well as the verdict.
function finalize(dir, { phases = PHASES, counters = allPhasesRan() } = {}) {
  const { runtime } = makeRuntime(dir, phases);
  const logs = [];
  runtime.log = (m) => logs.push(m);
  const verdict = computePipelineVerdict(runtime, counters);
  return { verdict, counters, logs };
}

describe('WS-B success-verdict-withheld (Done over a red test verdict, derived at finalize)', () => {
  test('AC-B1 / V1-1: a ticket Done over worker_gate_tests_verdict: red withholds success and is named', () => {
    const dir = tmpDir();
    const { statePath } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('aaaaaaaa', [{ name: 'not ok 1 - real test', file: 'foo.test.js', message: 'AssertionError' }]),
    ]);
    writeTicket(dir, 'aaaaaaaa', { status: 'Done', testsVerdict: 'red', title: 'red ticket' });

    const { verdict, counters, logs } = finalize(dir);

    assert.equal(verdict.pipelineFailed, false, 'every phase ran — this is a verdict, not a shortfall');
    assert.equal(verdict.unsuccessful, true, 'the red-test Done ticket must withhold the success verdict');
    assert.equal(verdict.effectiveFailed, true, 'closer-release is skipped');
    assert.equal(
      counters.phaseDispositions.pickle,
      'done_over_red_worker_gate_tests:aaaaaaaa',
      'the offending ticket id must be named in the disposition',
    );
    assert.equal(counters.nonConvergent, 0, 'V1-1: the term is derived, never added to the one-way counter');
    assert.ok(
      logs.some((l) => l.includes('aaaaaaaa') && l.includes('red')),
      'the run summary log must name the offending ticket and its verdict',
    );

    fs.rmSync(dir, { recursive: true });
  });

  test('AC-B2: the pickle boundary counts the phase completed and latches nothing', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('bbbbbbbb', [{ name: 'not ok 1 - real test', file: 'foo.test.js', message: 'AssertionError' }]),
    ]);
    writeTicket(dir, 'bbbbbbbb', { status: 'Done', testsVerdict: 'red' });
    const counters = makeCounters();

    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);

    assert.equal(outcome.action, 'continue', 'the run must still execute every remaining phase');
    assert.equal(counters.completed, 1, 'the pickle phase still counts completed — no new abort');
    assert.equal(counters.nonConvergent, 0, 'V1-1: no boundary-time raise');
    assert.equal(counters.phaseDispositions.pickle, undefined, 'no boundary-time marker');
    // The persisted mid-run status is what `readResumePhasePlan` seeds `nonConvergent` from. A
    // done-over-red marker written here would re-latch a repaired ticket across a crash-resume.
    // `phase_dispositions` is additive-optional: absent entirely when nothing was recorded.
    assert.equal(readStatus(dir).phase_dispositions?.pickle, undefined);
    fs.rmSync(dir, { recursive: true });
  });

  test('V1-2 positive control: red at the flip AND still red at finalize withholds exactly as before', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('cccccccc', [{ name: 'not ok 1 - real test', file: 'foo.test.js', message: 'AssertionError' }]),
    ]);
    writeTicket(dir, 'cccccccc', { status: 'Done', testsVerdict: 'red' });
    const counters = makeCounters();

    finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);
    counters.completed = PHASES.length;
    const { verdict } = finalize(dir, { counters });

    assert.equal(verdict.unsuccessful, true, 'a bundle still red at finalize must not report success');
    assert.equal(counters.phaseDispositions.pickle, 'done_over_red_worker_gate_tests:cccccccc');
    fs.rmSync(dir, { recursive: true });
  });

  test('V1-3 negative control: red at the flip, measurably green at finalize, reports success', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('dddddddd', [{ name: 'not ok 1 - real test', file: 'foo.test.js', message: 'AssertionError' }]),
    ]);
    writeTicket(dir, 'dddddddd', { status: 'Done', testsVerdict: 'red' });
    const counters = makeCounters();

    // Phase 1 of 4: the ticket IS red here. This is the moment the old code latched.
    finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);
    assert.equal(counters.nonConvergent, 0, 'precondition: nothing was latched at the flip');

    // The ticket is repaired during a later phase — the case all four live bundles hit.
    writeTicket(dir, 'dddddddd', { status: 'Done', testsVerdict: 'green' });
    counters.completed = PHASES.length;
    const { verdict } = finalize(dir, { counters });

    assert.equal(verdict.unsuccessful, false, 'V1-3: a repaired bundle must report success');
    assert.equal(verdict.effectiveFailed, false, 'closer-release is not skipped');
    assert.equal(counters.phaseDispositions.pickle, undefined, 'no stale done-over-red attribution');
    fs.rmSync(dir, { recursive: true });
  });

  test('V1-3 (resume): the seeded counter carries no done-over-red latch across a crash boundary', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('eeee1111', [{ name: 'not ok 1 - real test', file: 'foo.test.js', message: 'AssertionError' }]),
    ]);
    writeTicket(dir, 'eeee1111', { status: 'Done', testsVerdict: 'red' });
    const boundary = makeCounters();
    finalizePhaseSuccess(runtime, boundary, cancelMarker, 'pickle', 0, runtime.log);

    // The crash lands mid-run: rewrite the persisted status as the resume reader needs it,
    // carrying forward whatever dispositions the pickle boundary actually wrote.
    const persisted = readStatus(dir);
    fs.writeFileSync(path.join(dir, 'pipeline-status.json'), JSON.stringify({
      ...persisted,
      status: 'running',
      current_phase: 'anatomy-park',
      completed_phases: 2,
    }));

    const plan = readResumePhasePlan({ sessionDir: dir, config: { phases: PHASES } });
    assert.equal(plan.index, 2, 'precondition: this IS a resume, not a cold start');
    assert.equal(plan.counters.nonConvergent, 0, 'the resume seed must not fabricate a withholding');

    // Repaired after the crash: the resumed run derives from the CURRENT verdict.
    writeTicket(dir, 'eeee1111', { status: 'Done', testsVerdict: 'green' });
    const counters = { ...plan.counters, completed: PHASES.length };
    assert.equal(finalize(dir, { counters }).verdict.unsuccessful, false);
    fs.rmSync(dir, { recursive: true });
  });

  test('AC-B4: a bundle with no red test verdicts is unaffected — success reported, release plan runs', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath);
    writeTicket(dir, 'cccccccc', { status: 'Done', testsVerdict: 'green' });
    writeTicket(dir, 'dddddddd', { status: 'Done' }); // no verdict field at all
    const counters = makeCounters();

    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'pickle', 0, runtime.log);
    assert.equal(outcome.action, 'continue');
    assert.equal(counters.completed, 1);
    assert.equal(readStatus(dir).status, 'running');

    counters.completed = PHASES.length;
    const { verdict } = finalize(dir, { counters });
    assert.equal(verdict.unsuccessful, false, 'a clean run must not be flagged');
    assert.equal(counters.phaseDispositions.pickle, undefined);
    assert.equal(counters.nonConvergent, 0);
    fs.rmSync(dir, { recursive: true });
  });

  test('multiple red-test Done tickets are all named and withhold once', () => {
    const dir = tmpDir();
    const { statePath } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('eeeeeeee', [{ name: 'not ok 1 - real test', file: 'foo.test.js', message: 'AssertionError' }]),
      workerGateFailedEvent('ffffffff', [{ name: 'not ok 1 - real test', file: 'bar.test.js', message: 'AssertionError' }]),
    ]);
    writeTicket(dir, 'eeeeeeee', { status: 'Done', testsVerdict: 'red' });
    writeTicket(dir, 'ffffffff', { status: 'Done', testsVerdict: 'red' });
    writeTicket(dir, 'gggggggg', { status: 'Done', testsVerdict: 'green' });

    const { verdict, counters } = finalize(dir);

    assert.equal(verdict.unsuccessful, true);
    assert.ok(counters.phaseDispositions.pickle.includes('eeeeeeee'));
    assert.ok(counters.phaseDispositions.pickle.includes('ffffffff'));
    assert.ok(!counters.phaseDispositions.pickle.includes('gggggggg'));
    fs.rmSync(dir, { recursive: true });
  });

  test('non-pickle phases are unaffected by the red-test check', () => {
    const dir = tmpDir();
    const { runtime, statePath, cancelMarker } = makeRuntime(dir);
    writeState(statePath);
    writeTicket(dir, 'hhhhhhhh', { status: 'Done', testsVerdict: 'red' });
    const counters = makeCounters();

    // citadel has its own exit-code-only path and never scans tickets for this check.
    const outcome = finalizePhaseSuccess(runtime, counters, cancelMarker, 'citadel', 1, runtime.log);

    assert.equal(outcome.action, 'continue');
    assert.equal(counters.nonConvergent, 0);
    fs.rmSync(dir, { recursive: true });
  });

  test('a run with no pickle phase never asks the question (the trigger is unchanged)', () => {
    const dir = tmpDir();
    const { statePath } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('iiiiiiii', [{ name: 'not ok 1 - real test', file: 'foo.test.js', message: 'AssertionError' }]),
    ]);
    writeTicket(dir, 'iiiiiiii', { status: 'Done', testsVerdict: 'red' });
    const phases = ['anatomy-park', 'szechuan-sauce'];

    const { verdict, counters } = finalize(dir, {
      phases,
      counters: { completed: phases.length, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} },
    });

    assert.equal(verdict.unsuccessful, false);
    assert.equal(counters.phaseDispositions.pickle, undefined);
    fs.rmSync(dir, { recursive: true });
  });

  // The OTHER withholding sources still ride the counter. Collapsing the done-over-red term
  // out of it must not collapse the term itself.
  test('a mid-run nonConvergent raise still withholds the success verdict', () => {
    const dir = tmpDir();
    const { statePath } = makeRuntime(dir);
    writeState(statePath);
    const counters = {
      completed: PHASES.length,
      skipped: 0,
      phaseSkips: {},
      nonConvergent: 1,
      phaseDispositions: { 'anatomy-park': 'approach_exhaustion' },
    };

    const { verdict } = finalize(dir, { counters });

    assert.equal(verdict.pipelineFailed, false);
    assert.equal(verdict.unsuccessful, true, 'the counter term is untouched by V1');
    fs.rmSync(dir, { recursive: true });
  });
});

// ROOT G2 (ticket 6445c637): an EMPTY worker gate failure list may not read as red. Only a
// MEASURED red — a `worker_gate_tests_verdict: red` corroborated by a non-empty
// `worker_gate_failed.failures` list in `state.json.activity` — may withhold the success
// verdict. An empty-because-unmeasured verdict (no corroborating event, or one with an empty
// failure list) is reported as a DISTINCT `done_over_unmeasured_worker_gate_tests` disposition
// and the run still reports success — never a halt, never an abort condition.
describe('ROOT G2: an empty worker gate failure list may not read as red', () => {
  test('positive control: a genuine measured red (non-empty failure list) still withholds', () => {
    const dir = tmpDir();
    const { statePath } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('aaa11111', [{ name: 'not ok 1 - some real test', file: 'foo.test.js', message: 'AssertionError' }]),
    ]);
    writeTicket(dir, 'aaa11111', { status: 'Done', testsVerdict: 'red' });

    const { verdict, counters } = finalize(dir);

    assert.equal(verdict.unsuccessful, true, 'a measured red must still withhold the success verdict');
    assert.equal(counters.phaseDispositions.pickle, 'done_over_red_worker_gate_tests:aaa11111');
    assert.equal(verdict.pipelineFailed, false, 'withholding is not a phase shortfall');
    fs.rmSync(dir, { recursive: true });
  });

  test('negative control: a red with NO corroborating worker_gate_failed event does not withhold', () => {
    const dir = tmpDir();
    const { statePath } = makeRuntime(dir);
    writeState(statePath, 1, []); // no worker_gate_failed event for this ticket at all
    writeTicket(dir, 'bbb22222', { status: 'Done', testsVerdict: 'red' });

    const { verdict, counters } = finalize(dir);

    assert.equal(verdict.unsuccessful, false, 'an unmeasured red must not withhold the success verdict');
    assert.equal(counters.phaseDispositions.pickle, 'done_over_unmeasured_worker_gate_tests:bbb22222');
    fs.rmSync(dir, { recursive: true });
  });

  test('negative control: a red whose worker_gate_failed event carries an EMPTY failure list does not withhold', () => {
    const dir = tmpDir();
    const { statePath } = makeRuntime(dir);
    writeState(statePath, 1, [workerGateFailedEvent('ccc33333', [])]);
    writeTicket(dir, 'ccc33333', { status: 'Done', testsVerdict: 'red' });

    const { verdict, counters } = finalize(dir);

    assert.equal(verdict.unsuccessful, false, 'an empty failure list must not read as a measured red');
    assert.equal(counters.phaseDispositions.pickle, 'done_over_unmeasured_worker_gate_tests:ccc33333');
    fs.rmSync(dir, { recursive: true });
  });

  test('the LATEST worker_gate_failed entry for a ticket is authoritative, not the first', () => {
    const dir = tmpDir();
    const { statePath } = makeRuntime(dir);
    // First attempt was genuinely measured; the retry that produced the CURRENT
    // frontmatter verdict reported no evidence — the current verdict is unmeasured.
    writeState(statePath, 1, [
      workerGateFailedEvent('ddd44444', [{ name: 'not ok 1 - real', file: 'foo.test.js', message: 'boom' }]),
      workerGateFailedEvent('ddd44444', []),
    ]);
    writeTicket(dir, 'ddd44444', { status: 'Done', testsVerdict: 'red' });

    const { verdict, counters } = finalize(dir);

    assert.equal(verdict.unsuccessful, false, 'the latest (empty) entry must govern, not the earlier measured one');
    assert.equal(counters.phaseDispositions.pickle, 'done_over_unmeasured_worker_gate_tests:ddd44444');
    fs.rmSync(dir, { recursive: true });
  });

  test('mixed roster: measured and unmeasured offenders are reported distinctly, and only the measured one withholds', () => {
    const dir = tmpDir();
    const { statePath } = makeRuntime(dir);
    writeState(statePath, 1, [
      workerGateFailedEvent('eee55555', [{ name: 'not ok 1 - real', file: 'foo.test.js', message: 'boom' }]),
      workerGateFailedEvent('fff66666', []),
    ]);
    writeTicket(dir, 'eee55555', { status: 'Done', testsVerdict: 'red' });
    writeTicket(dir, 'fff66666', { status: 'Done', testsVerdict: 'red' });

    const { verdict, counters } = finalize(dir);

    assert.equal(verdict.unsuccessful, true, 'only the measured offender withholds — and it does');
    assert.equal(
      counters.phaseDispositions.pickle,
      'done_over_unmeasured_worker_gate_tests:fff66666; done_over_red_worker_gate_tests:eee55555',
      'both dispositions must be named, distinctly',
    );
    fs.rmSync(dir, { recursive: true });
  });

  test('a green or not_run verdict is unaffected by activity contents', () => {
    const dir = tmpDir();
    const { statePath } = makeRuntime(dir);
    writeState(statePath, 1, []);
    writeTicket(dir, 'ggg77777', { status: 'Done', testsVerdict: 'green' });

    const { verdict, counters } = finalize(dir);

    assert.equal(verdict.unsuccessful, false);
    assert.equal(counters.phaseDispositions.pickle, undefined);
    fs.rmSync(dir, { recursive: true });
  });
});

// V1-4: `counters.nonConvergent` is a one-way latch with FIVE historical raise sites and zero
// decrements. V1 removed exactly ONE of them — the done-over-red withhold — and re-derived that
// term at finalize instead. This census enumerates every surviving raise site BY ENCLOSING
// FUNCTION, so removing, adding, or relocating one is a deliberate act that reddens here rather
// than a silent collapse of the term. It reads the GRAMMAR (ts.createSourceFile), so a comment
// naming `nonConvergent` can neither satisfy nor break it.
describe('V1-4: the nonConvergent raise sites are enumerated', () => {
  const SRC = fileURLToPath(new URL('../src/bin/pipeline-runner.ts', import.meta.url));

  function parseSource() {
    const text = fs.readFileSync(SRC, 'utf-8');
    return ts.createSourceFile(SRC, text, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  }

  function enclosingFunctionName(node) {
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
      if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n))
        && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
        return n.parent.name.text;
      }
    }
    return '<top-level>';
  }

  // A raise is `<x>.nonConvergent++` or `<x>.nonConvergent += <n>`. A plain read
  // (`counters.nonConvergent > 0`) and the resume seed's property ASSIGNMENT are not raises.
  function isNonConvergentAccess(node) {
    return ts.isPropertyAccessExpression(node) && node.name.text === 'nonConvergent';
  }

  function collectRaiseSites() {
    const src = parseSource();
    const sites = [];
    const visit = (node) => {
      const incremented = (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node))
        && node.operator === ts.SyntaxKind.PlusPlusToken
        && isNonConvergentAccess(node.operand);
      const compoundAssigned = ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
        && isNonConvergentAccess(node.left);
      if (incremented || compoundAssigned) sites.push(enclosingFunctionName(node));
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(src, visit);
    return sites;
  }

  test('exactly four raise sites survive, one per named withholding path', () => {
    const sites = collectRaiseSites();
    assert.deepEqual(
      [...new Set(sites)].sort(),
      [
        'finalizePhaseSuccess', // the microverse non-convergent arm
        'runAllBackendsExhaustedFinalizeGate',
        'withholdForDegradedPostFinalVerdict',
        'withholdForFailedAcGate',
      ],
      'a raise site was added, removed, or relocated — collapse the counter deliberately, not silently',
    );
    assert.equal(sites.length, 4, 'one raise per path: a second raise in one function is a new latch');
  });

  test('the fifth term is derived at finalize, not raised: the boundary withhold is gone', () => {
    const src = parseSource();

    // The retired function name must not come back as a declaration.
    const declared = [];
    ts.forEachChild(src, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name) declared.push(node.name.text);
    });
    assert.ok(
      !declared.includes('withholdForDoneOverRedTestVerdict'),
      'the boundary-time withhold must stay retired — the term is derived at finalize',
    );
    assert.ok(declared.includes('reportDoneOverRedTestVerdict'), 'the finalize-time reporter must exist');

    // And the verdict must actually call it, or the derivation is dead code.
    let verdictBody = null;
    ts.forEachChild(src, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && node.name.text === 'computePipelineVerdict') {
        verdictBody = node.body;
      }
    });
    assert.ok(verdictBody, 'computePipelineVerdict must be a function declaration in this file');
    const countCalls = (root, name) => {
      let count = 0;
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) count++;
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(root, visit);
      return count;
    };
    assert.equal(
      countCalls(verdictBody, 'reportDoneOverRedTestVerdict'),
      1,
      'V1-1: the verdict must derive the done-over-red term from current tickets',
    );

    // The single reader stays the single reader (no second re-derivation of the trigger).
    assert.equal(
      countCalls(src, 'collectDoneTicketsWithRedTestVerdict'),
      1,
      'collectDoneTicketsWithRedTestVerdict must keep exactly one call site',
    );

    // The derivation APPENDS a disposition, so it is idempotent only while the verdict has ONE
    // caller (`finalizePipeline`). A second call site would name the same offenders twice in
    // `phase_dispositions` and on the completion panel.
    assert.equal(
      countCalls(src, 'computePipelineVerdict'),
      1,
      'computePipelineVerdict must keep exactly one call site — the derivation appends a disposition',
    );
  });
});
