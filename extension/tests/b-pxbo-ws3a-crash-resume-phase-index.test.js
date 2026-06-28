// @tier: fast
//
// B-PXBO WS-3-FacetA (R-CRSR) regression tests.
//
// On pipeline-runner crash-resume, the phase loop must RESUME from the recorded
// prior phase instead of restarting at phases[0]. `computeResumePhaseIndex`
// reads the existing pipeline-status.json (via the recoverable-read primitive,
// NO new state field) and returns the loop start index:
//   AC-CRSR-1: {status:'running', completed_phases>0, current_phase:'anatomy-park'}
//              -> index of that phase (skip the completed phases).
//   AC-CRSR-2: no file / status!=='running' / completed_phases===0 -> 0 (cold start).
//
// R-PTSB: sandbox PICKLE_DATA_ROOT for every session-touching helper invocation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeResumePhaseIndex } from '../bin/pipeline-runner.js';

const PHASES = ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'];

function mkSession() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ws3a-')));
  process.env.PICKLE_DATA_ROOT = root; // R-PTSB sandbox
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

function writeStatus(sessionDir, payload) {
  fs.writeFileSync(
    path.join(sessionDir, 'pipeline-status.json'),
    JSON.stringify(payload, null, 2),
  );
}

function runtimeFor(sessionDir) {
  return { sessionDir, config: { phases: [...PHASES] } };
}

test('AC-CRSR-1: running + completed_phases>0 resumes at the recorded current_phase index', () => {
  const sessionDir = mkSession();
  writeStatus(sessionDir, {
    status: 'running',
    current_phase: 'anatomy-park',
    completed_phases: 2,
    skipped_phases: 0,
    total_phases: 4,
  });
  assert.equal(computeResumePhaseIndex(runtimeFor(sessionDir)), 2);
});

test('AC-CRSR-1: resumes at citadel (index 1) after one completed phase', () => {
  const sessionDir = mkSession();
  writeStatus(sessionDir, {
    status: 'running',
    current_phase: 'citadel',
    completed_phases: 1,
    total_phases: 4,
  });
  assert.equal(computeResumePhaseIndex(runtimeFor(sessionDir)), 1);
});

test('AC-CRSR-2: no pipeline-status.json -> cold start at 0', () => {
  const sessionDir = mkSession();
  assert.equal(computeResumePhaseIndex(runtimeFor(sessionDir)), 0);
});

test('AC-CRSR-2: completed_phases === 0 -> cold start at 0 (no skip)', () => {
  const sessionDir = mkSession();
  writeStatus(sessionDir, {
    status: 'running',
    current_phase: 'pickle',
    completed_phases: 0,
    total_phases: 4,
  });
  assert.equal(computeResumePhaseIndex(runtimeFor(sessionDir)), 0);
});

test('AC-CRSR-2: terminal status (completed/failed/cancelled) -> cold start at 0', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const sessionDir = mkSession();
    writeStatus(sessionDir, {
      status,
      current_phase: 'anatomy-park',
      completed_phases: 2,
      total_phases: 4,
    });
    assert.equal(computeResumePhaseIndex(runtimeFor(sessionDir)), 0, `status=${status}`);
  }
});

test('AC-CRSR-2: null/unrecognized current_phase -> cold start at 0', () => {
  const sessionDir = mkSession();
  writeStatus(sessionDir, {
    status: 'running',
    current_phase: null,
    completed_phases: 2,
    total_phases: 4,
  });
  assert.equal(computeResumePhaseIndex(runtimeFor(sessionDir)), 0);

  const sessionDir2 = mkSession();
  writeStatus(sessionDir2, {
    status: 'running',
    current_phase: 'not-a-phase',
    completed_phases: 2,
    total_phases: 4,
  });
  assert.equal(computeResumePhaseIndex(runtimeFor(sessionDir2)), 0);
});

test('AC-CRSR-2: non-numeric completed_phases -> cold start at 0', () => {
  const sessionDir = mkSession();
  writeStatus(sessionDir, {
    status: 'running',
    current_phase: 'anatomy-park',
    completed_phases: 'two',
    total_phases: 4,
  });
  assert.equal(computeResumePhaseIndex(runtimeFor(sessionDir)), 0);
});

test('AC-CRSR-1: current_phase not in this run\'s configured phases -> 0', () => {
  // szechuan recorded but the configured run only has pickle+citadel.
  const sessionDir = mkSession();
  writeStatus(sessionDir, {
    status: 'running',
    current_phase: 'szechuan-sauce',
    completed_phases: 2,
    total_phases: 2,
  });
  const runtime = { sessionDir, config: { phases: ['pickle', 'citadel'] } };
  assert.equal(computeResumePhaseIndex(runtime), 0);
});

test('recoverable read: promotes a dead-pid pipeline-status.json.tmp snapshot', () => {
  // Only an orphan tmp exists (interrupted rename) — the recoverable-read
  // primitive must surface it so resume still works.
  const sessionDir = mkSession();
  const deadPid = 999999; // not a live process
  fs.writeFileSync(
    path.join(sessionDir, `pipeline-status.json.tmp.${deadPid}`),
    JSON.stringify({
      status: 'running',
      current_phase: 'anatomy-park',
      completed_phases: 2,
      total_phases: 4,
    }),
  );
  assert.equal(computeResumePhaseIndex(runtimeFor(sessionDir)), 2);
});
