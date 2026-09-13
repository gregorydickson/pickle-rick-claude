// @tier: integration
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  executeCitadelPhase,
  __setCitadelRemediationDepsForTests,
} from '../bin/pipeline-runner.js';
import {
  scanSkipFlagEvents,
  buildSkipFlagBudgetReport,
  SKIP_FLAG_BUDGETS,
} from '../services/metrics-utils.js';

const TMP_DIRS = new Set();
const PRIOR_DATA_ROOT = process.env.PICKLE_DATA_ROOT;

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-mech-skip-'));
  TMP_DIRS.add(dir);
  return dir;
}

// logActivity writes to getDataRoot()/activity/<day>.jsonl — sandbox the data root
// so the gate_skipped emission lands in tmp, not the real ~/.local/share tree.
function withDataRoot() {
  const root = tmpDir();
  process.env.PICKLE_DATA_ROOT = root;
  return path.join(root, 'activity');
}

function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function writeCitadelState(statePath, flags) {
  const dir = path.dirname(statePath);
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    working_dir: dir,
    step: 'citadel',
    iteration: 1,
    max_iterations: 50,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'citadel mechanical skip test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: dir,
    schema_version: 3,
    exit_reason: null,
    prd_path: 'prd.md',
    start_commit: 'abc1234',
    backend: 'claude',
    activity: [],
    ...(flags ? { flags } : {}),
  }, null, 2));
}

function makeRuntime(dir) {
  return {
    sessionDir: dir,
    statePath: path.join(dir, 'state.json'),
    repoRoot: dir,
    workingDir: dir,
    extensionRoot: dir,
    backend: 'claude',
    phaseEnv: { ...process.env },
    log: () => {},
    config: {
      phases: ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'],
      target: dir,
      citadel_strict: false,
      dirty_exempt_segments: [],
    },
  };
}

function citadelResult(findings) {
  return {
    schema: '1.0',
    prd_path: 'prd.md',
    diff_range: 'abc1234..HEAD',
    exit_code: findings.length ? 2 : 0,
    exitCode: findings.length ? 2 : 0,
    header: { pickle_phase_failed: false, pickle_exit_code: 0 },
    sections: {},
    findings,
    decision_required: [],
    decisions: [],
    summary: {
      findings: findings.length, critical: 0, high: 0, medium: 0, low: 0,
      decision_required: 0, decisions: 0, unguarded_trap_doors: 0,
    },
    markdown: '',
    json: {},
  };
}

function captureRemediatorIds(captured) {
  return {
    loadSettings: () => ({ cap: 1, remediatorTimeoutMs: 1000 }),
    spawnGateRemediatorMain: async ({ argv }) => {
      const idx = argv.indexOf('--gate-result');
      const gateResult = JSON.parse(fs.readFileSync(argv[idx + 1], 'utf-8'));
      captured.push(...gateResult.failures.map((f) => f.ruleOrCode));
      return 1;
    },
    spawnRemediator: () => { throw new Error('worker must not spawn in this test'); },
  };
}

afterEach(() => {
  __setCitadelRemediationDepsForTests(null);
  for (const dir of TMP_DIRS) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  TMP_DIRS.clear();
  if (PRIOR_DATA_ROOT === undefined) delete process.env.PICKLE_DATA_ROOT;
  else process.env.PICKLE_DATA_ROOT = PRIOR_DATA_ROOT;
});

describe('B-CSOR T40 — skip_quality_gates_reason bypass (AC-5)', () => {
  test('a non-empty skip reason collapses the union to Critical-only (mechanical NOT remediated)', async () => {
    const dir = tmpDir();
    writeCitadelState(path.join(dir, 'state.json'), { skip_quality_gates_reason: 'operator bypass test' });
    const captured = [];
    __setCitadelRemediationDepsForTests({
      ...captureRemediatorIds(captured),
      runCitadelAudit: async () => citadelResult([
        { id: 'banned-construct:brace-free-if:foo.ts:10', severity: 'Medium', file: 'foo.ts', line: 10 },
      ]),
    });

    const result = await executeCitadelPhase(makeRuntime(dir));

    assert.deepEqual(result, { exitCode: 0 });
    assert.ok(
      !captured.includes('banned-construct:brace-free-if:foo.ts:10'),
      'mechanical finding must NOT reach remediation when the bypass is set',
    );
  });

  test('emits exactly one gate_skipped to the activity-dir jsonl sink the W5c budget scanner reads', async () => {
    const activityDir = withDataRoot();
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeCitadelState(statePath, { skip_quality_gates_reason: 'operator bypass test' });
    const captured = [];
    __setCitadelRemediationDepsForTests({
      ...captureRemediatorIds(captured),
      runCitadelAudit: async () => citadelResult([
        { id: 'banned-construct:brace-free-if:foo.ts:10', severity: 'Medium', file: 'foo.ts', line: 10 },
      ]),
    });

    await executeCitadelPhase(makeRuntime(dir));

    // The event MUST land in the activity-dir jsonl, NOT state.json.activity — that is
    // the sink scanSkipFlagEvents reads. A regression would write to state.activity and
    // leave the dir empty (the original bug: budget stuck at 0 forever).
    const jsonlPath = path.join(activityDir, `${todayKey()}.jsonl`);
    assert.ok(fs.existsSync(jsonlPath), 'gate_skipped must be written to the activity-dir jsonl');
    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const skips = lines.filter((e) => e.event === 'gate_skipped' && e.source === 'citadel-mechanical');
    assert.equal(skips.length, 1, 'exactly one gate_skipped per phase invocation');
    assert.equal(skips[0].gate_payload.reason, 'skip_quality_gates');
    assert.equal(skips[0].gate_payload.detail, 'operator bypass test');
    assert.equal(typeof skips[0].ts, 'string', 'ts stamped for date-window filtering');

    // The state.json sink MUST stay empty — proves the producer is no longer mis-routed.
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    const stateSkips = (state.activity || []).filter((e) => e.event === 'gate_skipped');
    assert.equal(stateSkips.length, 0, 'gate_skipped must NOT be written to state.json.activity');

    // End-to-end: the real consumer (scanner → budget report) must now SEE the use,
    // crediting the purpose-built citadel-mechanical::skip_quality_gates budget.
    const day = todayKey();
    const uses = scanSkipFlagEvents(activityDir, day, day);
    const budgetKeyUses = uses.filter(
      (u) => u.source === 'citadel-mechanical' && u.reason === 'skip_quality_gates',
    );
    assert.equal(budgetKeyUses.length, 1, 'scanner credits the citadel-mechanical::skip_quality_gates budget');
    const report = buildSkipFlagBudgetReport(uses, SKIP_FLAG_BUDGETS, day, day);
    const entry = report.entries.find(
      (e) => e.source === 'citadel-mechanical' && e.reason === 'skip_quality_gates',
    );
    assert.ok(entry, 'budget report includes the citadel-mechanical::skip_quality_gates entry');
    assert.equal(entry.uses, 1, 'budget report uses is non-zero (the disarmed-budget bug is fixed)');
    assert.equal(entry.budget, SKIP_FLAG_BUDGETS['citadel-mechanical::skip_quality_gates'], 'purpose-built budget honored');
  });

  test('no skip reason → mechanical finding IS remediated and NO gate_skipped emitted', async () => {
    const activityDir = withDataRoot();
    const dir = tmpDir();
    const statePath = path.join(dir, 'state.json');
    writeCitadelState(statePath, null);
    const captured = [];
    __setCitadelRemediationDepsForTests({
      ...captureRemediatorIds(captured),
      runCitadelAudit: async () => citadelResult([
        { id: 'banned-construct:brace-free-if:foo.ts:10', severity: 'Medium', file: 'foo.ts', line: 10 },
      ]),
    });

    await executeCitadelPhase(makeRuntime(dir));

    assert.ok(
      captured.includes('banned-construct:brace-free-if:foo.ts:10'),
      'baseline: mechanical finding reaches remediation when bypass absent',
    );
    const jsonlPath = path.join(activityDir, `${todayKey()}.jsonl`);
    const skips = fs.existsSync(jsonlPath)
      ? fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
        .filter((e) => e.event === 'gate_skipped' && e.source === 'citadel-mechanical')
      : [];
    assert.equal(skips.length, 0, 'no gate_skipped when bypass absent');
  });
});
