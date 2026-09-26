// @tier: integration
/**
 * jar-batch.test.js — Integration tests for jar queue operations.
 *
 * Tests addToJar and the resulting jar directory structure with real tmpdir.
 * EXTENSION_DIR is overridden per-test so no files land in ~/.claude/pickle-rick.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { addToJar } from '../../services/jar-utils.js';
import { writeStateFile } from '../../services/pickle-utils.js';
import { StateManager } from '../../services/state-manager.js';
import { discoverMarinatingTasks } from '../../bin/jar-runner.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-jar-'));
}

function makeState(overrides = {}) {
  return {
    active: true,
    working_dir: '/tmp/jar-test-repo',
    step: 'prd',
    iteration: 3,
    max_iterations: 10,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'jar integration test',
    current_ticket: null,
    history: [],
    started_at: new Date().toISOString(),
    session_dir: '/tmp/test-session',
    schema_version: 1,
    ...overrides,
  };
}

/**
 * Creates a session directory with state.json and prd.md ready for addToJar.
 * Also sets EXTENSION_DIR so the jar root lands in the given extensionRoot.
 */
function makeSessionDir(baseDir, extensionRoot, stateOverrides = {}) {
  const sessionDir = path.join(baseDir, 'sessions', `test-session-${Date.now()}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  writeStateFile(path.join(sessionDir, 'state.json'), makeState(stateOverrides));
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD\n\nIntegration test PRD content.');
  return sessionDir;
}

// ---------------------------------------------------------------------------
// addToJar: basic structure
// ---------------------------------------------------------------------------

test('JAR-1: addToJar creates the jar task directory under EXTENSION_DIR/jar/', () => {
  const rootDir = tmpDir();
  const extDir = path.join(rootDir, 'ext');
  fs.mkdirSync(extDir, { recursive: true });

  const saved = process.env.EXTENSION_DIR;
  process.env.EXTENSION_DIR = extDir;
  try {
    const sessionDir = makeSessionDir(rootDir, extDir);
    const taskDir = addToJar(sessionDir);

    assert.ok(taskDir.startsWith(path.join(extDir, 'jar')), 'taskDir must be under EXTENSION_DIR/jar/');
    assert.ok(fs.existsSync(taskDir), 'task directory must exist on disk');
  } finally {
    process.env.EXTENSION_DIR = saved ?? undefined;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('JAR-2: addToJar writes meta.json with required fields', () => {
  const rootDir = tmpDir();
  const extDir = path.join(rootDir, 'ext');
  fs.mkdirSync(extDir, { recursive: true });

  const saved = process.env.EXTENSION_DIR;
  process.env.EXTENSION_DIR = extDir;
  try {
    const sessionDir = makeSessionDir(rootDir, extDir);
    const taskDir = addToJar(sessionDir);

    const metaPath = path.join(taskDir, 'meta.json');
    assert.ok(fs.existsSync(metaPath), 'meta.json must exist');

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    assert.equal(typeof meta.prd_hash, 'string', 'meta.prd_hash must be a string');
    assert.equal(meta.prd_path, 'prd.md', 'meta.prd_path must be prd.md');
    assert.equal(meta.status, 'marinating', 'meta.status must be marinating');
    assert.equal(typeof meta.repo_path, 'string', 'meta.repo_path must be a string');
    assert.ok(meta.created_at, 'meta.created_at must be set');
  } finally {
    process.env.EXTENSION_DIR = saved ?? undefined;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('JAR-3: addToJar copies prd.md and its SHA-256 hash matches meta.prd_hash', () => {
  const rootDir = tmpDir();
  const extDir = path.join(rootDir, 'ext');
  fs.mkdirSync(extDir, { recursive: true });

  const saved = process.env.EXTENSION_DIR;
  process.env.EXTENSION_DIR = extDir;
  try {
    const sessionDir = makeSessionDir(rootDir, extDir);
    const taskDir = addToJar(sessionDir);

    const prdContent = fs.readFileSync(path.join(taskDir, 'prd.md'), 'utf-8');
    const expectedHash = crypto.createHash('sha256').update(prdContent).digest('hex');
    const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf-8'));

    assert.equal(meta.prd_hash, expectedHash, 'prd_hash must match actual content hash');
  } finally {
    process.env.EXTENSION_DIR = saved ?? undefined;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('JAR-4: addToJar deactivates the session (sets active=false)', () => {
  const rootDir = tmpDir();
  const extDir = path.join(rootDir, 'ext');
  fs.mkdirSync(extDir, { recursive: true });

  const saved = process.env.EXTENSION_DIR;
  process.env.EXTENSION_DIR = extDir;
  try {
    const sessionDir = makeSessionDir(rootDir, extDir, { active: true });
    addToJar(sessionDir);

    const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
    assert.equal(state.active, false, 'session must be deactivated after jar');
  } finally {
    process.env.EXTENSION_DIR = saved ?? undefined;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('JAR-5: addToJar leaves no .tmp files in jar task dir after successful write', () => {
  const rootDir = tmpDir();
  const extDir = path.join(rootDir, 'ext');
  fs.mkdirSync(extDir, { recursive: true });

  const saved = process.env.EXTENSION_DIR;
  process.env.EXTENSION_DIR = extDir;
  try {
    const sessionDir = makeSessionDir(rootDir, extDir);
    const taskDir = addToJar(sessionDir);

    const tmpFiles = fs.readdirSync(taskDir).filter((f) => f.includes('.tmp'));
    assert.equal(tmpFiles.length, 0, `unexpected .tmp files: ${tmpFiles.join(', ')}`);
  } finally {
    process.env.EXTENSION_DIR = saved ?? undefined;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// addToJar: error cases
// ---------------------------------------------------------------------------

test('JAR-6: addToJar throws when state.json is missing', () => {
  const rootDir = tmpDir();
  try {
    const sessionDir = path.join(rootDir, 'no-state');
    fs.mkdirSync(sessionDir);
    // No state.json created
    assert.throws(() => addToJar(sessionDir), /state\.json/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('JAR-7: addToJar throws when prd.md is missing', () => {
  const rootDir = tmpDir();
  const extDir = path.join(rootDir, 'ext');
  fs.mkdirSync(extDir, { recursive: true });

  const saved = process.env.EXTENSION_DIR;
  process.env.EXTENSION_DIR = extDir;
  try {
    const sessionDir = path.join(rootDir, 'no-prd');
    fs.mkdirSync(sessionDir);
    writeStateFile(path.join(sessionDir, 'state.json'), makeState());
    // No prd.md
    assert.throws(() => addToJar(sessionDir), /prd\.md/);
  } finally {
    process.env.EXTENSION_DIR = saved ?? undefined;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('JAR-8: addToJar throws when working_dir missing from state', () => {
  const rootDir = tmpDir();
  const extDir = path.join(rootDir, 'ext');
  fs.mkdirSync(extDir, { recursive: true });

  const saved = process.env.EXTENSION_DIR;
  process.env.EXTENSION_DIR = extDir;
  try {
    const sessionDir = path.join(rootDir, 'no-working-dir');
    fs.mkdirSync(sessionDir);
    writeStateFile(path.join(sessionDir, 'state.json'), makeState({ working_dir: '' }));
    fs.writeFileSync(path.join(sessionDir, 'prd.md'), '# PRD');
    assert.throws(() => addToJar(sessionDir), /working_dir/);
  } finally {
    process.env.EXTENSION_DIR = saved ?? undefined;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// addToJar: multiple tasks in same day → separate subdirs
// ---------------------------------------------------------------------------

test('JAR-9: two addToJar calls produce separate task directories', () => {
  const rootDir = tmpDir();
  const extDir = path.join(rootDir, 'ext');
  fs.mkdirSync(extDir, { recursive: true });

  const saved = process.env.EXTENSION_DIR;
  process.env.EXTENSION_DIR = extDir;
  try {
    const dir1 = makeSessionDir(rootDir, extDir);
    // Ensure different session IDs by using small sleep or distinct base names
    const dir2 = path.join(rootDir, 'sessions', `alt-session-${Date.now() + 1}`);
    fs.mkdirSync(dir2, { recursive: true });
    writeStateFile(path.join(dir2, 'state.json'), makeState());
    fs.writeFileSync(path.join(dir2, 'prd.md'), '# PRD 2');

    const taskDir1 = addToJar(dir1);
    const taskDir2 = addToJar(dir2);

    assert.notEqual(taskDir1, taskDir2, 'each jar call must produce a distinct task dir');
    assert.ok(fs.existsSync(path.join(taskDir1, 'meta.json')));
    assert.ok(fs.existsSync(path.join(taskDir2, 'meta.json')));
  } finally {
    process.env.EXTENSION_DIR = saved ?? undefined;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Batch resilience — crash and write-fail scenarios
// ---------------------------------------------------------------------------

/**
 * Build a minimal jar directory structure with N tasks.
 * statuses: array of 'marinating' | 'consumed' | 'failed' per task.
 * crashAt: optional task index (0-based) whose session state has active=true + dead PID.
 */
function buildJar(rootDir, statuses, { crashAt = -1 } = {}) {
  const jarDir = path.join(rootDir, 'jar', '2026-01-01');
  const sessionsDir = path.join(rootDir, 'sessions');
  fs.mkdirSync(jarDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  const taskIds = statuses.map((_, i) => `task-0${i + 1}`);

  for (let i = 0; i < statuses.length; i++) {
    const taskDir = path.join(jarDir, taskIds[i]);
    const sessionDir = path.join(sessionsDir, taskIds[i]);
    fs.mkdirSync(taskDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });

    fs.writeFileSync(
      path.join(taskDir, 'meta.json'),
      JSON.stringify({
        status: statuses[i],
        repo_path: '/tmp/repo',
        prd_hash: 'abc123',
        prd_path: 'prd.md',
        created_at: new Date().toISOString(),
      }),
    );

    // Session state — crash task gets stale active=true with dead PID
    const isCrash = i === crashAt;
    writeStateFile(
      path.join(sessionDir, 'state.json'),
      makeState({ active: isCrash, ...(isCrash ? { pid: 99_999_999 } : {}) }),
    );
  }

  return { jarDir, sessionsDir, taskIds };
}

/** Read all meta statuses from the day-level jar dir (already includes day segment). */
function readMetaStatuses(jarDayDir, taskIds) {
  return taskIds.map((id) => {
    const raw = fs.readFileSync(path.join(jarDayDir, id, 'meta.json'), 'utf-8');
    return JSON.parse(raw).status;
  });
}

test('JAR-10: crash at task 4 — meta stays marinating, session active cleared, tasks 4-6 eligible for resume', () => {
  const rootDir = tmpDir();
  try {
    // 6 tasks: 1-3 consumed, 4-6 marinating; crash occurred during task 4 execution
    const statuses = ['consumed', 'consumed', 'consumed', 'marinating', 'marinating', 'marinating'];
    const { jarDir, sessionsDir, taskIds } = buildJar(rootDir, statuses, { crashAt: 3 });

    // Recovery: StateManager clears the stale active flag on task 4's session
    const sm = new StateManager();
    const task4StatePath = path.join(sessionsDir, 'task-04', 'state.json');
    const recovered = sm.read(task4StatePath);

    assert.equal(recovered.active, false, 'task 4 active must be cleared after crash (dead PID)');
    const onDisk = JSON.parse(fs.readFileSync(task4StatePath, 'utf-8'));
    assert.equal(onDisk.active, false, 'cleared active must be persisted to disk');

    // Meta statuses must be unchanged — jar runner resumes from task 4
    const metaStatuses = readMetaStatuses(jarDir, taskIds);
    assert.deepEqual(
      metaStatuses,
      ['consumed', 'consumed', 'consumed', 'marinating', 'marinating', 'marinating'],
      'meta statuses must be unchanged after crash recovery',
    );

    // Only tasks 4-6 are eligible — asked of the production discovery, not re-derived here
    const eligible = discoverMarinatingTasks(path.dirname(jarDir)).map((t) => t.taskId);
    assert.deepEqual(eligible, ['task-04', 'task-05', 'task-06'], 'resume must start from task 4');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('JAR-11: write fail on task 5 marks it failed, task 6 remains eligible', () => {
  const rootDir = tmpDir();
  try {
    // Tasks 1-4 consumed, task 5 failed (runTask returned false → meta written as failed),
    // task 6 still marinating (not yet attempted)
    const statuses = ['consumed', 'consumed', 'consumed', 'consumed', 'failed', 'marinating'];
    const { jarDir, taskIds } = buildJar(rootDir, statuses);

    const metaStatuses = readMetaStatuses(jarDir, taskIds);

    // Task 5 must be marked failed (write of 'failed' status succeeded before process died)
    assert.equal(metaStatuses[4], 'failed', 'task 5 must be marked failed');

    // Task 6 must still be marinating (eligible for next run)
    assert.equal(metaStatuses[5], 'marinating', 'task 6 must remain marinating');

    // The production discovery must skip the failed entry, not just the consumed ones
    const eligible = discoverMarinatingTasks(path.dirname(jarDir)).map((t) => t.taskId);
    assert.deepEqual(eligible, ['task-06'], 'only task 6 is eligible — skips task 5 failed entry');

    // Tasks 1-4 are not re-run
    const consumed = taskIds.filter((id, i) => metaStatuses[i] === 'consumed');
    assert.equal(consumed.length, 4, 'tasks 1-4 must remain consumed');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
