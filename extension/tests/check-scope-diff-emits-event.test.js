// @tier: fast
// Regression test for AC-APWS-1 emission gap: check-scope-diff.js must emit a
// schema-conformant `worker_edit_outside_scope` activity event when staged
// paths fall outside scope.json:allowed_paths. Pre-fix, the gate exited 1 with
// the right JSON on stdout but never logged the event, so /pickle-status
// renderScopeDrift never had any data to surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(extensionRoot, 'bin', 'check-scope-diff.js');

function makeTmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'check-scope-diff-evt-')));
}

function makeRepo(tmp) {
  spawnSync('git', ['init', '-q'], { cwd: tmp });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmp });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
}

function writeScopeJson(dir, allowedPaths) {
  const scopePath = path.join(dir, 'scope.json');
  fs.writeFileSync(scopePath, JSON.stringify({ allowed_paths: allowedPaths }));
  return scopePath;
}

function readActivityLines(activityDir) {
  if (!fs.existsSync(activityDir)) return [];
  const files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.jsonl'));
  const events = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(activityDir, f), 'utf-8');
    for (const line of content.split('\n').filter(Boolean)) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed
      }
    }
  }
  return events;
}

function runScriptWithIsolatedActivity(args, cwd, dataRoot) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf-8',
    timeout: 10_000,
    cwd,
    env: { ...process.env, PICKLE_DATA_ROOT: dataRoot },
  });
}

test('AC-APWS-1: outside_scope status emits worker_edit_outside_scope activity event', () => {
  const tmp = makeTmp();
  try {
    makeRepo(tmp);
    const dataRoot = path.join(tmp, 'data');
    const activityDir = path.join(dataRoot, 'activity');

    fs.mkdirSync(path.join(tmp, 'extension', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'in.ts'), 'export {};');
    fs.writeFileSync(path.join(tmp, 'unrelated', 'leaked.ts'), 'export {};');
    spawnSync('git', ['add', 'extension/src/in.ts', 'unrelated/leaked.ts'], { cwd: tmp });

    const scopePath = writeScopeJson(tmp, ['extension/src']);
    const result = runScriptWithIsolatedActivity(['--scope-json', scopePath], tmp, dataRoot);
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stderr: ${result.stderr}`);

    const events = readActivityLines(activityDir).filter((e) => e.event === 'worker_edit_outside_scope');
    assert.equal(events.length, 1, `expected exactly 1 worker_edit_outside_scope event, got ${events.length}`);

    const ev = events[0];
    assert.equal(typeof ev.ts, 'string', 'event must have ts');
    assert.ok(ev.gate_payload, 'event must have gate_payload');
    assert.equal(ev.gate_payload.scope_json_path, scopePath);
    assert.deepEqual(ev.gate_payload.staged_paths_outside_scope, ['unrelated/leaked.ts']);
    assert.equal(ev.gate_payload.head_ref, 'HEAD');
    assert.equal(typeof ev.gate_payload.suggested_remediation, 'string');
    assert.ok(ev.gate_payload.suggested_remediation.length > 0, 'suggested_remediation must be non-empty');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-APWS-1: --ticket-id flag is forwarded to event payload', () => {
  const tmp = makeTmp();
  try {
    makeRepo(tmp);
    const dataRoot = path.join(tmp, 'data');
    const activityDir = path.join(dataRoot, 'activity');

    fs.mkdirSync(path.join(tmp, 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'unrelated', 'leaked.ts'), 'export {};');
    spawnSync('git', ['add', 'unrelated/leaked.ts'], { cwd: tmp });

    const scopePath = writeScopeJson(tmp, ['extension/src']);
    const result = runScriptWithIsolatedActivity(
      ['--scope-json', scopePath, '--ticket-id', 'abc12345'],
      tmp,
      dataRoot,
    );
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}`);

    const events = readActivityLines(activityDir).filter((e) => e.event === 'worker_edit_outside_scope');
    assert.equal(events.length, 1, 'expected exactly 1 emission');
    assert.equal(events[0].ticket_id, 'abc12345', 'ticket_id must round-trip into the event');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-APWS-1: in-scope staged paths do NOT emit the event (exit 0)', () => {
  const tmp = makeTmp();
  try {
    makeRepo(tmp);
    const dataRoot = path.join(tmp, 'data');
    const activityDir = path.join(dataRoot, 'activity');

    fs.mkdirSync(path.join(tmp, 'extension', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'extension', 'src', 'in.ts'), 'export {};');
    spawnSync('git', ['add', 'extension/src/in.ts'], { cwd: tmp });

    const scopePath = writeScopeJson(tmp, ['extension/src']);
    const result = runScriptWithIsolatedActivity(['--scope-json', scopePath], tmp, dataRoot);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}`);

    const events = readActivityLines(activityDir).filter((e) => e.event === 'worker_edit_outside_scope');
    assert.equal(events.length, 0, `expected zero emissions on clean diff, got ${events.length}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-APWS-1: malformed scope.json (exit 2) does NOT emit the event', () => {
  const tmp = makeTmp();
  try {
    makeRepo(tmp);
    const dataRoot = path.join(tmp, 'data');
    const activityDir = path.join(dataRoot, 'activity');

    const scopePath = path.join(tmp, 'scope.json');
    fs.writeFileSync(scopePath, '{ not valid json !!!');
    const result = runScriptWithIsolatedActivity(['--scope-json', scopePath], tmp, dataRoot);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}`);

    const events = readActivityLines(activityDir).filter((e) => e.event === 'worker_edit_outside_scope');
    assert.equal(events.length, 0, 'malformed scope must not emit drift events');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-APWS-1: emitted event passes the consumer filter in /pickle-status renderScopeDrift', async () => {
  // End-to-end: produce an outside-scope diff with a known ticket-id, then
  // confirm /pickle-status would surface it. Validates the producer→consumer
  // contract as a single data flow rather than two unit tests.
  const tmp = makeTmp();
  try {
    makeRepo(tmp);
    const dataRoot = path.join(tmp, 'data');

    fs.mkdirSync(path.join(tmp, 'unrelated'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'unrelated', 'leaked.ts'), 'export {};');
    spawnSync('git', ['add', 'unrelated/leaked.ts'], { cwd: tmp });
    const scopePath = writeScopeJson(tmp, ['extension/src']);

    // Emit drift event for ticket 'tkt00001' inside dataRoot.
    const emitResult = runScriptWithIsolatedActivity(
      ['--scope-json', scopePath, '--ticket-id', 'tkt00001'],
      tmp,
      dataRoot,
    );
    assert.equal(emitResult.status, 1);

    // Build a session that owns ticket 'tkt00001' so renderScopeDrift surfaces it.
    const fakeCwd = path.join(tmp, 'repo');
    fs.mkdirSync(fakeCwd, { recursive: true });
    const sessionDir = path.join(dataRoot, 'sessions', 'apws-emit-session');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'state.json'),
      JSON.stringify({
        active: true,
        working_dir: fakeCwd,
        session_dir: sessionDir,
        step: 'implement',
        iteration: 1,
        max_iterations: 10,
        current_ticket: 'tkt00001',
        original_prompt: 'AC-APWS-1 emission round-trip test',
      }),
    );
    const ticketDir = path.join(sessionDir, 'tkt00001');
    fs.mkdirSync(ticketDir, { recursive: true });
    fs.writeFileSync(
      path.join(ticketDir, 'rick_ticket_tkt00001.md'),
      '---\nid: tkt00001\ntitle: Drift surfacing\nstatus: In Progress\npriority: Medium\n---\n',
    );
    fs.writeFileSync(
      path.join(dataRoot, 'current_sessions.json'),
      JSON.stringify({ [fakeCwd]: sessionDir }),
    );

    const { showStatus } = await import('../bin/status.js');
    const chunks = [];
    const origWrite = process.stdout.write;
    process.stdout.write = (chunk) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    const savedDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    try {
      showStatus(fakeCwd);
    } finally {
      process.stdout.write = origWrite;
      if (savedDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
      else process.env.PICKLE_DATA_ROOT = savedDataRoot;
    }
    const output = chunks.join('');
    assert.ok(output.includes('Scope drift:'), `expected Scope drift line, got: ${output}`);
    assert.ok(output.includes('tkt00001'), `expected ticket id in output, got: ${output}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
