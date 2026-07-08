// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const EXTENSION_ROOT = path.resolve(import.meta.dirname, '..');
const RUNNER_PATH = path.join(EXTENSION_ROOT, 'bin', 'microverse-runner.js');
const RUNNER_URL = pathToFileURL(RUNNER_PATH).href;
const TEST_RUNNER_URL = `${RUNNER_URL}?r-rvmw-test=1`;
const RELAUNCH_PATH = path.join(EXTENSION_ROOT, 'services', 'manager-relaunch.js');
const RELAUNCH_URL = pathToFileURL(RELAUNCH_PATH).href;
const RELAUNCH_ACTUAL_URL = `${RELAUNCH_URL}?r-rvmw-actual=1`;

function writeTicket(sessionDir, id, status, order = 1) {
  const ticketDir = path.join(sessionDir, id);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(path.join(ticketDir, `rick_ticket_${id}.md`), [
    '---',
    `id: ${id}`,
    `title: ${id}`,
    `status: "${status}"`,
    `order: ${order}`,
    '---',
    '',
  ].join('\n'));
}

function readActivityEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  const events = [];
  for (const entry of fs.readdirSync(activityDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(activityDir, entry), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line));
    }
  }
  return events;
}

function makeSessionDir() {
  const sessionDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-microverse-relaunch-')));
  const statePath = path.join(sessionDir, 'state.json');
  fs.writeFileSync(statePath, JSON.stringify({
    active: true,
    working_dir: sessionDir,
    step: 'implement',
    iteration: 3,
    max_iterations: 20,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000),
    completion_promise: null,
    original_prompt: 'R-RVMW fixture',
    current_ticket: 'ticket-001',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    command_template: 'microverse.md',
    backend: 'codex',
    schema_version: 4,
    manager_relaunch_count: 0,
  }, null, 2));
  writeTicket(sessionDir, 'ticket-001', 'Todo', 1);
  writeTicket(sessionDir, 'ticket-002', 'Done', 2);
  return { sessionDir, statePath };
}

function installMicroverseRelaunchHooks() {
  return registerHooks({
    load(url, context, nextLoad) {
      if (url === TEST_RUNNER_URL) {
        const source = fs.readFileSync(RUNNER_PATH, 'utf-8');
        return {
          format: 'module',
          shortCircuit: true,
          source: `${source}\nexport { handleManagerErrorOutcome };`,
        };
      }
      if (url === RELAUNCH_URL) {
        return {
          format: 'module',
          shortCircuit: true,
          source: `
            import * as actual from ${JSON.stringify(RELAUNCH_ACTUAL_URL)};
            export const currentManagerRelaunchCount = actual.currentManagerRelaunchCount;
            export const managerRelaunchCap = actual.managerRelaunchCap;
            export const managerRelaunchCapForBackend = actual.managerRelaunchCapForBackend;
            export function evaluateManagerRelaunch(...args) {
              return actual.evaluateManagerRelaunch(...args);
            }
            export function recordManagerRelaunch(...args) {
              globalThis.__r_rvmw_record_calls ??= [];
              globalThis.__r_rvmw_record_calls.push(args[2]?.exitKind ?? null);
              return actual.recordManagerRelaunch(...args);
            }
          `,
        };
      }
      if (url === RELAUNCH_ACTUAL_URL) {
        return {
          format: 'module',
          shortCircuit: true,
          source: fs.readFileSync(RELAUNCH_PATH, 'utf-8'),
        };
      }
      return nextLoad(url, context);
    },
  });
}

test('microverse-runner relaunches codex manager on subprocess error and records other_error exit kind', async () => {
  const hooks = installMicroverseRelaunchHooks();
  const { handleManagerErrorOutcome, _deps } = await import(TEST_RUNNER_URL);
  const session = makeSessionDir();
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-microverse-relaunch-data-')));
  const previousDataRoot = process.env.PICKLE_DATA_ROOT;
  const originalSleep = _deps.sleep;
  const logs = [];

  try {
    process.env.PICKLE_DATA_ROOT = dataRoot;
    globalThis.__r_rvmw_record_calls = [];
    _deps.sleep = async () => {};

    const result = await handleManagerErrorOutcome({
      sessionDir: session.sessionDir,
      statePath: session.statePath,
      currentRunnerState: JSON.parse(fs.readFileSync(session.statePath, 'utf-8')),
      iteration: 4,
      log: message => logs.push(message),
    });

    const persisted = JSON.parse(fs.readFileSync(session.statePath, 'utf-8'));
    const relaunchEvents = readActivityEvents(dataRoot).filter(event => event.event === 'codex_manager_relaunch');

    assert.equal(result, 'continue');
    assert.deepEqual(globalThis.__r_rvmw_record_calls, ['other_error']);
    assert.equal(persisted.manager_relaunch_count, 1);
    assert.equal(relaunchEvents.length, 1);
    assert.ok(
      logs.some(line => line.includes('codex manager subprocess errored') && line.includes('relaunching')),
      `expected relaunch log, got:\n${logs.join('\n')}`,
    );
  } finally {
    _deps.sleep = originalSleep;
    delete globalThis.__r_rvmw_record_calls;
    hooks.deregister();
    if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousDataRoot;
    fs.rmSync(session.sessionDir, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
