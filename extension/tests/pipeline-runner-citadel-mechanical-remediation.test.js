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

const TMP_DIRS = new Set();

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-mech-remediation-'));
  TMP_DIRS.add(dir);
  return dir;
}

function writeCitadelState(statePath) {
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
    original_prompt: 'citadel mechanical remediation test',
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

// Capture the finding ids that reached the remediator by reading the gate-result file
// remediateCitadelFindings wrote (each failure.ruleOrCode is a finding id). Returning a
// non-zero brief code stops before any real worker spawn.
function captureRemediatorIds(captured) {
  return {
    loadSettings: () => ({ cap: 1, remediatorTimeoutMs: 1000 }),
    spawnGateRemediatorMain: async ({ argv }) => {
      const idx = argv.indexOf('--gate-result');
      const gateResult = JSON.parse(fs.readFileSync(argv[idx + 1], 'utf-8'));
      captured.push(...gateResult.failures.map((f) => f.ruleOrCode));
      return 1; // no BRIEF_PATH → remediateCitadelFindings returns early, no spawnRemediator
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
});

describe('B-CSOR T20 — union floor in executeCitadelPhase', () => {
  test('AC-2: a Medium mechanical finding (sub-threshold) reaches the remediator', async () => {
    const dir = tmpDir();
    writeCitadelState(path.join(dir, 'state.json'));
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
      captured.includes('banned-construct:brace-free-if:foo.ts:10'),
      'the mechanical finding must be passed to remediation (additive floor)',
    );
  });

  test('TD-2 dedupe: a finding in both remediable and mechanical is NOT double-spawned', async () => {
    const dir = tmpDir();
    writeCitadelState(path.join(dir, 'state.json'));
    const captured = [];
    // Critical → threshold-routed (classifier rejects Critical, so NOT mechanical).
    // Medium brace-free-if → mechanical floor. The union must hold each id exactly once.
    __setCitadelRemediationDepsForTests({
      ...captureRemediatorIds(captured),
      runCitadelAudit: async () => citadelResult([
        { id: 'C-dup', severity: 'Critical', file: 'a.ts', line: 1 },
        { id: 'banned-construct:brace-free-if:a.ts:5', severity: 'Medium', file: 'a.ts', line: 5 },
      ]),
    });

    await executeCitadelPhase(makeRuntime(dir));

    const unique = new Set(captured);
    assert.equal(unique.size, captured.length, 'no finding id may appear twice in the remediator set');
    assert.ok(captured.includes('C-dup'), 'threshold (Critical) finding still routed');
    assert.ok(captured.includes('banned-construct:brace-free-if:a.ts:5'), 'mechanical finding routed');
  });

  test('AC-8: executeCitadelPhase returns { exitCode: 0 } (never hard-halts)', async () => {
    const dir = tmpDir();
    writeCitadelState(path.join(dir, 'state.json'));
    const captured = [];
    __setCitadelRemediationDepsForTests({
      ...captureRemediatorIds(captured),
      runCitadelAudit: async () => citadelResult([
        { id: 'banned-construct:brace-free-if:foo.ts:10', severity: 'Medium', file: 'foo.ts', line: 10 },
      ]),
    });

    const result = await executeCitadelPhase(makeRuntime(dir));

    assert.deepEqual(result, { exitCode: 0 });
  });
});
