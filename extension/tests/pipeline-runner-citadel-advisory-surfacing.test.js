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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citadel-advisory-'));
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
    original_prompt: 'citadel advisory surfacing test',
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

function captureRemediatorIds(captured) {
  return {
    spawnGateRemediatorMain: async ({ argv }) => {
      const idx = argv.indexOf('--gate-result');
      const gateResult = JSON.parse(fs.readFileSync(argv[idx + 1], 'utf-8'));
      captured.push(...gateResult.failures.map((f) => f.ruleOrCode));
      return 1; // no BRIEF_PATH → no spawnRemediator
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

describe('B-CSOR T50 — residual advisory surfacing (AC-9)', () => {
  test('only the mechanical finding remediates; the 2 advisory ids surface to status + event', async () => {
    const dir = tmpDir();
    writeCitadelState(path.join(dir, 'state.json'));
    const captured = [];
    try {
      __setCitadelRemediationDepsForTests({
        ...captureRemediatorIds(captured),
        loadSettings: () => ({ cap: 1, remediatorTimeoutMs: 1000 }),
        runCitadelAudit: async () => citadelResult([
          // mechanical (sub-threshold but deterministically fixable) → reaches the remediator
          { id: 'banned-construct:brace-free-if:foo.ts:10', severity: 'Medium', file: 'foo.ts', line: 10 },
          // by-design advisory: sub-threshold AND non-mechanical
          { id: 'orphan-test-file:bar.test.js', severity: 'Medium', file: 'bar.test.js', line: 1 },
          { id: 'banned-construct:nested-ternary:baz.ts:42', severity: 'Medium', file: 'baz.ts', line: 42 },
        ]),
      });

      const result = await executeCitadelPhase(makeRuntime(dir));
      assert.deepEqual(result, { exitCode: 0 });

      // Only the mechanical finding reached the remediator.
      assert.deepEqual(
        captured,
        ['banned-construct:brace-free-if:foo.ts:10'],
        'orphan-test-file and nested-ternary are NOT remediated (advisory only)',
      );

      // pipeline-status.json carries the advisory COUNT (== 2) additively.
      const status = JSON.parse(
        fs.readFileSync(path.join(dir, 'pipeline-status.json'), 'utf-8'),
      );
      assert.equal(status.citadel_advisory_findings, 2, 'advisory count surfaced in pipeline-status');

      // The citadel_findings_unremediated event carries the orphan + nested-ternary ids.
      const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
      const advisoryEvent = state.activity.find(
        (e) => e.event === 'citadel_findings_unremediated' && e.findings_remaining === 2,
      );
      assert.ok(advisoryEvent, 'an advisory citadel_findings_unremediated event was emitted');
      assert.deepEqual(
        [...advisoryEvent.finding_ids].sort(),
        ['banned-construct:nested-ternary:baz.ts:42', 'orphan-test-file:bar.test.js'],
        'advisory event carries the orphan + nested-ternary finding ids',
      );
    } finally {
      __setCitadelRemediationDepsForTests(null);
    }
  });
});
