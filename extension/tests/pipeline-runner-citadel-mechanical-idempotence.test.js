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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-idempotence-'));
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
    original_prompt: 'citadel idempotence test',
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

// Records each cycle's spawn by reading the gate-result file remediateCitadelFindings wrote
// (each failure.ruleOrCode is a finding id). Returning brief code 1 (no BRIEF_PATH) stops
// before any real worker spawn, so spawnRemediator must never fire.
function captureRemediatorIds(captured) {
  return {
    spawnGateRemediatorMain: async ({ argv }) => {
      const idx = argv.indexOf('--gate-result');
      const gateResult = JSON.parse(fs.readFileSync(argv[idx + 1], 'utf-8'));
      captured.push(gateResult.failures.map((f) => f.ruleOrCode));
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
});

describe('B-CSOR T50 — idempotence over the bounded citadel loop (AC-7)', () => {
  test('cycle 1 remediates the brace-free-if; cycle 2 finds none → no second spawn, converges exit 0', async () => {
    const dir = tmpDir();
    writeCitadelState(path.join(dir, 'state.json'));
    const captured = [];
    let auditCalls = 0;
    __setCitadelRemediationDepsForTests({
      ...captureRemediatorIds(captured),
      loadSettings: () => ({ cap: 2, remediatorTimeoutMs: 1000 }),
      runCitadelAudit: async () => {
        auditCalls += 1;
        // Cycle 1: the wrapped `if` still matches isBraceFreeIf → mechanical finding present.
        // Cycle 2: the fix landed, audit returns ZERO findings (idempotence — no re-match).
        if (auditCalls === 1) {
          return citadelResult([
            { id: 'banned-construct:brace-free-if:foo.ts:10', severity: 'Medium', file: 'foo.ts', line: 10 },
          ]);
        }
        return citadelResult([]);
      },
    });

    const result = await executeCitadelPhase(makeRuntime(dir));

    assert.deepEqual(result, { exitCode: 0 }, 'bounded loop converges and never hard-halts');
    assert.equal(auditCalls, 2, 'a second audit cycle runs after the first remediation');
    assert.equal(captured.length, 1, 'the remediator is spawned exactly once (cycle 1 only)');
    assert.deepEqual(
      captured[0],
      ['banned-construct:brace-free-if:foo.ts:10'],
      'cycle 1 routed the mechanical finding to the remediator',
    );
  });
});
