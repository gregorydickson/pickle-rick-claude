// @tier: fast
//
// W1a (ticket 34b4d4e5) + guard-layer prune (item e): ONE quality-gate skip surface.
// `state.flags.skip_quality_gates_reason` is the ONLY quality-gate bypass flag.
// The legacy per-gate flags (skip_readiness_reason / skip_ticket_audit_reason),
// their read-time auto-migration, the deprecation-warning machinery, and the
// `skip_flag_legacy_used` event are GONE. Asserts the post-prune invariants:
//   1. single operator-facing bypass surface (no legacy flag strings anywhere in
//      mux-runner / state-manager / types sources; the unified flag is present)
//   2. bundle-bootstrap exemption writes ONLY the unified flag
//   3. retired legacy keys on old sessions are INERT (no promotion, no drop, no crash)
//   4. --skip-ac-shape-gate folds into the unified surface
//   5. skip_smoke_gate_reason stays a SEPARATE flag (ruling 2)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateManager } from '../services/state-manager.js';
import { LATEST_SCHEMA_VERSION, VALID_ACTIVITY_EVENTS } from '../types/index.js';
import { writeStateFile } from '../services/pickle-utils.js';
import { runAcShapeEnforcement } from '../bin/spawn-refinement-team.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const MUX_SRC = fs.readFileSync(path.join(SRC_ROOT, 'bin', 'mux-runner.ts'), 'utf-8');
const SM_SRC = fs.readFileSync(path.join(SRC_ROOT, 'services', 'state-manager.ts'), 'utf-8');
const TYPES_SRC = fs.readFileSync(path.join(SRC_ROOT, 'types', 'index.ts'), 'utf-8');

function tmpDir(prefix = 'one-skip-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeState(flagsOverride = {}) {
  return {
    active: false,
    working_dir: '/tmp/test',
    step: null,
    iteration: 0,
    max_iterations: 10,
    max_time_minutes: 0,
    worker_timeout_seconds: 600,
    start_time_epoch: Date.now(),
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: LATEST_SCHEMA_VERSION,
    pipeline_continue_on_phase_fail: true,
    flags: flagsOverride,
  };
}

function withDataRoot(fn) {
  const dataRoot = tmpDir('one-skip-data-');
  const prev = process.env.PICKLE_DATA_ROOT;
  process.env.PICKLE_DATA_ROOT = dataRoot;
  try {
    return fn(dataRoot);
  } finally {
    if (prev === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = prev;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

// A manifest that FAILS ac-shape enforcement (a smell with no matching ticket
// → violation → runAcShapeEnforcement returns 2) UNLESS it is bypassed.
function failingManifest() {
  return {
    prd_path: '/tmp/prd.md',
    refinement_dir: '/tmp/ref',
    all_success: true,
    cycles_requested: 1,
    cycles_completed: 1,
    max_turns_per_worker: 10,
    ac_shape_smells: [{ ac_id: 'AC-NEEDS-SPLIT' }],
    tickets: [],
    workers: [],
    completed_at: new Date().toISOString(),
  };
}

function writeSessionState(sessionDir, flags) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const state = makeState(flags);
  state.session_dir = sessionDir;
  writeStateFile(path.join(sessionDir, 'state.json'), state);
}

// ---------------------------------------------------------------------------
// 1. Single operator-facing bypass surface — legacy strings fully absent
// ---------------------------------------------------------------------------
test('single skip surface: legacy per-gate flag strings absent from runtime sources', () => {
  for (const [name, src] of [['mux-runner.ts', MUX_SRC], ['state-manager.ts', SM_SRC], ['types/index.ts', TYPES_SRC]]) {
    assert.equal(src.includes('skip_readiness_reason'), false, `${name} must not reference skip_readiness_reason`);
    assert.equal(src.includes('skip_ticket_audit_reason'), false, `${name} must not reference skip_ticket_audit_reason`);
    assert.equal(src.includes('skip_flag_legacy_used'), false, `${name} must not reference skip_flag_legacy_used`);
  }
  // The legacy migration and deprecation machinery are gone.
  assert.equal(SM_SRC.includes('migrateLegacySkipQualityGatesFlags'), false);
  assert.equal(MUX_SRC.includes('_resetQualityGateSkipDeprecation'), false);
  assert.equal(MUX_SRC.includes('skip_quality_gates_deprecation_warning'), false);
  // The skip-log lines name the unified flag.
  assert.equal(MUX_SRC.includes('skipped via state.flags.skip_quality_gates_reason'), true);
  assert.equal(MUX_SRC.includes('bypassed via state.flags.skip_quality_gates_reason'), true);
  // The unified flag is the one surface present.
  assert.ok(MUX_SRC.includes('skip_quality_gates_reason'));
  // The retired events are out of the registry.
  const eventList = Array.from(VALID_ACTIVITY_EVENTS);
  assert.equal(eventList.includes('skip_flag_legacy_used'), false);
  assert.equal(eventList.includes('ticket_audit_failed'), false);
});

// ---------------------------------------------------------------------------
// 2. Bundle-bootstrap writes ONLY the unified flag
// ---------------------------------------------------------------------------
test('bundle-bootstrap exemption: writes the unified flag only', () => {
  const block = MUX_SRC.slice(MUX_SRC.indexOf('R-BUNDLE-1 / W1a'));
  const bootstrapBlock = block.slice(0, block.indexOf('readinessGateChecked'));
  assert.ok(bootstrapBlock.includes('skip_quality_gates_reason: skipQualityGatesReason'));
  // No per-gate dual-write branch survives.
  assert.equal(bootstrapBlock.includes('skipReadinessReason'), false);
  assert.equal(bootstrapBlock.includes('skipTicketAuditReason'), false);
});

// ---------------------------------------------------------------------------
// 3. Retired legacy keys on old sessions are inert (schema-neutral)
// ---------------------------------------------------------------------------
test('retired legacy skip keys are inert: no promotion, no crash, unified untouched', () => {
  withDataRoot(() => {
    const dir = tmpDir('one-skip-inert-');
    try {
      const statePath = path.join(dir, 'state.json');
      writeStateFile(statePath, makeState({ skip_readiness_reason: 'legacy-readiness' }));
      const read = new StateManager().read(statePath);
      assert.equal(read.flags.skip_quality_gates_reason, undefined, 'no promotion into the unified flag');
      assert.equal(read.flags.skip_readiness_reason, 'legacy-readiness', 'retired key left in place, inert');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('unified flag read is unaffected by lingering retired keys', () => {
  withDataRoot(() => {
    const dir = tmpDir('one-skip-unified-');
    try {
      const statePath = path.join(dir, 'state.json');
      writeStateFile(
        statePath,
        makeState({ skip_quality_gates_reason: 'unified', skip_readiness_reason: 'legacy' }),
      );
      const read = new StateManager().read(statePath);
      assert.equal(read.flags.skip_quality_gates_reason, 'unified', 'unified preserved');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. --skip-ac-shape-gate folds into the unified surface
// ---------------------------------------------------------------------------
test('AC-shape gate: explicit --skip-ac-shape-gate CLI flag bypasses (and would-fail manifest returns 0)', () => {
  withDataRoot(() => {
    const sessionDir = tmpDir('one-skip-acshape-cli-');
    try {
      writeSessionState(sessionDir, {});
      // No unified flag set; CLI flag drives the bypass.
      const code = runAcShapeEnforcement(failingManifest(), {
        sessionDir,
        skipAcShapeGate: 'operator: analyst tickets verified correct',
      });
      assert.equal(code, 0, 'CLI flag bypasses the AC-shape gate');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

test('AC-shape gate: unified skip_quality_gates_reason folds in (no CLI flag, would-fail manifest returns 0)', () => {
  withDataRoot(() => {
    const sessionDir = tmpDir('one-skip-acshape-unified-');
    try {
      writeSessionState(sessionDir, { skip_quality_gates_reason: 'bundle_bootstrap_mode=test' });
      const code = runAcShapeEnforcement(failingManifest(), { sessionDir });
      assert.equal(code, 0, 'unified flag bypasses the AC-shape gate without the CLI flag');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

test('AC-shape gate: armed when neither CLI flag nor unified flag is set (would-fail manifest returns 2)', () => {
  withDataRoot(() => {
    const sessionDir = tmpDir('one-skip-acshape-armed-');
    try {
      writeSessionState(sessionDir, {});
      const code = runAcShapeEnforcement(failingManifest(), { sessionDir });
      assert.equal(code, 2, 'gate stays armed when no bypass surface is set');
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. skip_smoke_gate_reason stays SEPARATE (ruling 2)
// ---------------------------------------------------------------------------
test('skip_smoke_gate_reason stays a separate flag (not folded into the quality-gate surface)', () => {
  // The unified read path must NOT fold in the smoke-gate flag.
  const resolver = MUX_SRC.slice(MUX_SRC.indexOf('function resolveQualityGateSkipReason'));
  const resolverBody = resolver.slice(0, resolver.indexOf('\n}\n'));
  assert.equal(
    resolverBody.includes('skip_smoke_gate_reason'),
    false,
    'resolveQualityGateSkipReason must not consult the smoke-gate flag',
  );
  // The smoke-gate flag is still read by its own (spark) gate.
  assert.ok(
    MUX_SRC.includes('skip_smoke_gate_reason'),
    'skip_smoke_gate_reason still exists as a distinct flag',
  );
});
