// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { inferMonitorMode, ensureMonitorWindow } from '../services/pickle-utils.js';

function makeSessionDir(template) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mwcl1-')));
  const state = template === undefined ? {} : { command_template: template };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ active: true, ...state }));
  return dir;
}

function makeExtRoot(tmpRoot) {
  const extRoot = path.join(tmpRoot, 'ext');
  fs.mkdirSync(path.join(extRoot, 'extension', 'bin'), { recursive: true });
  // sentinel file so resolveExtensionRoot accepts this root
  fs.writeFileSync(path.join(extRoot, 'extension', 'bin', 'log-watcher.js'), '// sentinel\n');
  fs.mkdirSync(path.join(extRoot, 'extension', 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(extRoot, 'extension', 'scripts', 'tmux-monitor.sh'),
    '#!/bin/sh\nexit 0\n',
  );
  return extRoot;
}

function makeSpawnFn(sessionName = 'test-session') {
  const calls = [];
  const fn = (command, args = []) => {
    calls.push({ command, args: [...args] });
    if (command === 'tmux') {
      if (args[0] === 'display-message') return { status: 0, stdout: `${sessionName}\n`, stderr: '' };
      if (args[0] === 'list-windows') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

function makeMonitorFixture(template) {
  const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mwcl1-')));
  const sessionDir = path.join(tmpRoot, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const state = template === undefined ? {} : { command_template: template };
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({ active: true, ...state }));
  const extRoot = makeExtRoot(tmpRoot);
  return {
    sessionDir,
    extRoot,
    cleanup() { fs.rmSync(tmpRoot, { recursive: true, force: true }); },
  };
}

// ── inferMonitorMode: mapping branches ──

test('inferMonitorMode: pickle.md → pickle (pickle* glob)', () => {
  const dir = makeSessionDir('pickle.md');
  try {
    const warns = [];
    assert.equal(inferMonitorMode(dir, (m) => warns.push(m)), 'pickle');
    assert.equal(warns.length, 0, 'no WARN expected for recognized template');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inferMonitorMode: szechuan-sauce.md → szechuan-sauce', () => {
  const dir = makeSessionDir('szechuan-sauce.md');
  try {
    const warns = [];
    assert.equal(inferMonitorMode(dir, (m) => warns.push(m)), 'szechuan-sauce');
    assert.equal(warns.length, 0, 'no WARN expected for recognized template');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inferMonitorMode: anatomy-park.md → anatomy-park', () => {
  const dir = makeSessionDir('anatomy-park.md');
  try {
    const warns = [];
    assert.equal(inferMonitorMode(dir, (m) => warns.push(m)), 'anatomy-park');
    assert.equal(warns.length, 0, 'no WARN expected for recognized template');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inferMonitorMode: retired meeseeks.md → pickle default with WARN (B-RSHM subsystem retired)', () => {
  const dir = makeSessionDir('meeseeks.md');
  try {
    const warns = [];
    assert.equal(inferMonitorMode(dir, (m) => warns.push(m)), 'pickle');
    assert.equal(warns.length, 1, 'unrecognized retired template must WARN');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inferMonitorMode: council-of-ricks.md → council (council* glob)', () => {
  const dir = makeSessionDir('council-of-ricks.md');
  try {
    const warns = [];
    assert.equal(inferMonitorMode(dir, (m) => warns.push(m)), 'council');
    assert.equal(warns.length, 0, 'no WARN expected for recognized template');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inferMonitorMode: council-review.md → council (council* glob, variant)', () => {
  const dir = makeSessionDir('council-review.md');
  try {
    const warns = [];
    assert.equal(inferMonitorMode(dir, (m) => warns.push(m)), 'council');
    assert.equal(warns.length, 0, 'no WARN expected for recognized template');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inferMonitorMode: refinement.md → refinement', () => {
  const dir = makeSessionDir('refinement.md');
  try {
    const warns = [];
    assert.equal(inferMonitorMode(dir, (m) => warns.push(m)), 'refinement');
    assert.equal(warns.length, 0, 'no WARN expected for recognized template');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── inferMonitorMode: WARN branches ──

test('inferMonitorMode: undefined template → pickle + WARN (missing)', () => {
  const dir = makeSessionDir(undefined);
  try {
    const warns = [];
    assert.equal(inferMonitorMode(dir, (m) => warns.push(m)), 'pickle');
    assert.equal(warns.length, 1, 'expected exactly one WARN');
    assert.match(warns[0], /\[ensureMonitorWindow\] command_template missing; defaulting to pickle/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inferMonitorMode: unrecognized template → pickle + WARN', () => {
  const dir = makeSessionDir('unknown-widget.md');
  try {
    const warns = [];
    assert.equal(inferMonitorMode(dir, (m) => warns.push(m)), 'pickle');
    assert.equal(warns.length, 1, 'expected exactly one WARN');
    assert.match(warns[0], /\[ensureMonitorWindow\] unrecognized command_template/);
    assert.match(warns[0], /unknown-widget\.md/);
    assert.match(warns[0], /defaulting to pickle/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inferMonitorMode: state.json missing → pickle + WARN (catch path)', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-mwcl1-')));
  try {
    const warns = [];
    assert.equal(inferMonitorMode(dir, (m) => warns.push(m)), 'pickle');
    assert.equal(warns.length, 1, 'expected exactly one WARN');
    assert.match(warns[0], /\[ensureMonitorWindow\] command_template missing; defaulting to pickle/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inferMonitorMode: no log callback → silent fallback without throw (backward compat)', () => {
  const dir = makeSessionDir('unknown-widget.md');
  try {
    assert.equal(inferMonitorMode(dir), 'pickle');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── ensureMonitorWindow: mode flows through to runner log ──

test('ensureMonitorWindow: szechuan-sauce.md without explicit mode → log says mode=szechuan-sauce NOT mode=pickle', () => {
  const fix = makeMonitorFixture('szechuan-sauce.md');
  try {
    const logs = [];
    const result = ensureMonitorWindow({
      sessionDir: fix.sessionDir,
      extensionRoot: fix.extRoot,
      inTmux: true,
      spawnSyncFn: makeSpawnFn('szechuan-session'),
      log: (m) => logs.push(m),
    });
    assert.equal(result.status, 'created', `expected created, got ${result.status}: ${result.reason}`);
    const createdLog = logs.find((m) => m.includes('created 4-pane monitor'));
    assert.ok(createdLog, `missing "created 4-pane monitor" log; logs: ${JSON.stringify(logs)}`);
    assert.match(createdLog, /mode=szechuan-sauce/);
    assert.doesNotMatch(createdLog, /mode=pickle/);
  } finally {
    fix.cleanup();
  }
});

test('ensureMonitorWindow: anatomy-park.md without explicit mode → log says mode=anatomy-park NOT mode=pickle', () => {
  const fix = makeMonitorFixture('anatomy-park.md');
  try {
    const logs = [];
    const result = ensureMonitorWindow({
      sessionDir: fix.sessionDir,
      extensionRoot: fix.extRoot,
      inTmux: true,
      spawnSyncFn: makeSpawnFn('anatomy-session'),
      log: (m) => logs.push(m),
    });
    assert.equal(result.status, 'created', `expected created, got ${result.status}: ${result.reason}`);
    const createdLog = logs.find((m) => m.includes('created 4-pane monitor'));
    assert.ok(createdLog, `missing "created 4-pane monitor" log; logs: ${JSON.stringify(logs)}`);
    assert.match(createdLog, /mode=anatomy-park/);
    assert.doesNotMatch(createdLog, /mode=pickle/);
  } finally {
    fix.cleanup();
  }
});

test('ensureMonitorWindow: pickle.md without explicit mode → log says mode=pickle', () => {
  const fix = makeMonitorFixture('pickle.md');
  try {
    const logs = [];
    const result = ensureMonitorWindow({
      sessionDir: fix.sessionDir,
      extensionRoot: fix.extRoot,
      inTmux: true,
      spawnSyncFn: makeSpawnFn('pickle-session'),
      log: (m) => logs.push(m),
    });
    assert.equal(result.status, 'created', `expected created, got ${result.status}: ${result.reason}`);
    const createdLog = logs.find((m) => m.includes('created 4-pane monitor'));
    assert.ok(createdLog, `missing "created 4-pane monitor" log; logs: ${JSON.stringify(logs)}`);
    assert.match(createdLog, /mode=pickle/);
  } finally {
    fix.cleanup();
  }
});

test('ensureMonitorWindow: undefined template without explicit mode → mode=pickle AND WARN emitted', () => {
  const fix = makeMonitorFixture(undefined);
  try {
    const logs = [];
    const result = ensureMonitorWindow({
      sessionDir: fix.sessionDir,
      extensionRoot: fix.extRoot,
      inTmux: true,
      spawnSyncFn: makeSpawnFn('missing-tpl-session'),
      log: (m) => logs.push(m),
    });
    assert.equal(result.status, 'created', `expected created, got ${result.status}: ${result.reason}`);
    const createdLog = logs.find((m) => m.includes('created 4-pane monitor'));
    assert.ok(createdLog, `missing "created 4-pane monitor" log; logs: ${JSON.stringify(logs)}`);
    assert.match(createdLog, /mode=pickle/);
    const warnLog = logs.find((m) => m.includes('[ensureMonitorWindow]') && m.includes('command_template missing'));
    assert.ok(warnLog, `expected WARN about missing command_template; logs: ${JSON.stringify(logs)}`);
  } finally {
    fix.cleanup();
  }
});

test('ensureMonitorWindow: explicit mode overrides inferred mode (AC #4 backward compat)', () => {
  const fix = makeMonitorFixture('szechuan-sauce.md'); // would infer 'szechuan-sauce' without override
  try {
    const logs = [];
    const result = ensureMonitorWindow({
      sessionDir: fix.sessionDir,
      extensionRoot: fix.extRoot,
      inTmux: true,
      spawnSyncFn: makeSpawnFn('override-session'),
      mode: 'council',
      log: (m) => logs.push(m),
    });
    assert.equal(result.status, 'created', `expected created, got ${result.status}: ${result.reason}`);
    const createdLog = logs.find((m) => m.includes('created 4-pane monitor'));
    assert.ok(createdLog, `missing "created 4-pane monitor" log; logs: ${JSON.stringify(logs)}`);
    assert.match(createdLog, /mode=council/);
    assert.doesNotMatch(createdLog, /mode=szechuan-sauce/);
  } finally {
    fix.cleanup();
  }
});
