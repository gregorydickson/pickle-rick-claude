// @tier: integration
/**
 * pickle-unit-real-mux-runner — B-PBUILD's unit path with NOTHING stubbed on the pipeline side: `main()` →
 * `runPickleWaves` → `createTicketUnitSession` → the real `spawnRunner` → the real `extension/bin/mux-runner.js
 * <unitDir>`. Only the backend is faked: a `claude` on PATH, the same stub shape as
 * mux-runner-fatal-deactivate.test.js (the two harnesses the ticket names call exported functions and scripted
 * adapters; neither spawns a runner).
 *
 * Three seams live only on this path, so every stub-runner wave test is blind to them:
 *   - pin: the unit is pinned to its own branch, so `checkHeadPinMismatch` must not read the worktree as external drift;
 *   - step: the manager must never see a null/`prd` step, which routes it to Phase 1 (PRD);
 *   - heartbeat: `spawnRunner` must watch the UNIT dir — the parent dir is idle for the whole wave, so a heartbeat
 *     watching it SIGTERMs a healthy unit once the stall window passes.
 * The fake manager outlives the stall window and records how long the parent sat idle, so the heartbeat assertion
 * cannot pass vacuously.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkFixtureTmpDir } from '../helpers/fixture-tmpdir.js';
import { main } from '../../bin/pipeline-runner.js';
import { LATEST_SCHEMA_VERSION } from '../../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_SRC = path.resolve(__dirname, '../..');
const ID = 'aaaa1111';
// ~1s from unit spawn to first manager turn was measured; the stall window is 10x that, and the manager outlives it.
const STALL_SECONDS = 10;
const MANAGER_MS = 15_000;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 }).trim();

function initRepo(dir, file) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@test.local');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, file), 'seed\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'seed');
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * The manager stub. It records the step it was handed and, at the end, how long the PARENT state.json sat idle;
 * it keeps its iteration log live, then does the ticket's work in the unit worktree and deactivates the unit.
 */
const FAKE_MANAGER = `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const statePath = process.env.PICKLE_STATE_FILE;
const unitDir = path.dirname(statePath);
const parentState = path.join(unitDir.replace(/--unit-[0-9a-f]+$/, ''), 'state.json');
const record = (entry) => fs.appendFileSync(path.join(unitDir, 'fake-manager.jsonl'), JSON.stringify(entry) + '\\n');
const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
record({ phase: 'start', step: s.step ?? null });
const tick = setInterval(() => process.stdout.write(JSON.stringify({ type: 'system', subtype: 'fake' }) + '\\n'), 500);
setTimeout(() => {
  clearInterval(tick);
  record({ phase: 'end', parentIdleMs: Date.now() - fs.statSync(parentState).mtimeMs });
  const run = (...args) => execFileSync('git', args, { cwd: s.working_dir, encoding: 'utf8', timeout: 10000 }).trim();
  fs.mkdirSync(path.join(s.working_dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(s.working_dir, 'src', s.current_ticket + '.ts'), 'export const v = 1;\\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'feat(' + s.current_ticket + '): unit work');
  const sha = run('rev-parse', 'HEAD');
  const ticket = path.join(unitDir, s.current_ticket, 'rick_ticket_' + s.current_ticket + '.md');
  fs.writeFileSync(ticket, fs.readFileSync(ticket, 'utf8').replace(/^status:.*$/m, 'status: Done\\ncompletion_commit: ' + sha));
  const cur = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  cur.active = false;
  fs.writeFileSync(statePath, JSON.stringify(cur, null, 2));
  process.exit(0);
}, ${MANAGER_MS});
`;

function makeFixture() {
  const target = fs.realpathSync(mkFixtureTmpDir('pickle-unit-real-mux-'));
  const startCommit = initRepo(target, 'README.md');
  const dataRoot = fs.realpathSync(mkFixtureTmpDir('pickle-unit-real-mux-data-'));
  fs.writeFileSync(path.join(dataRoot, '.gitignore'), 'sessions/\nfakebin/\nextroot\n');
  initRepo(dataRoot, 'NOTES.md');

  const fakeBin = path.join(dataRoot, 'fakebin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'fake-manager.cjs'), FAKE_MANAGER);
  fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(fakeBin, 'fake-manager.cjs')}" "$@"\n`);
  fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);

  // The deployed shape: `<root>/extension/bin/mux-runner.js` plus `<root>/templates/<manager prompt>`.
  const extRoot = path.join(dataRoot, 'extroot');
  fs.mkdirSync(path.join(extRoot, 'templates'), { recursive: true });
  fs.symlinkSync(EXTENSION_SRC, path.join(extRoot, 'extension'));
  fs.copyFileSync(path.join(EXTENSION_SRC, 'templates', '_pickle-manager-prompt.md'), path.join(extRoot, 'templates', '_pickle-manager-prompt.md'));

  const sessionDir = path.join(dataRoot, 'sessions', '2026-09-27-realmux');
  fs.mkdirSync(path.join(sessionDir, ID), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: LATEST_SCHEMA_VERSION, active: false, working_dir: target, session_dir: sessionDir,
    step: 'implement', iteration: 0, max_iterations: 3, worker_timeout_seconds: 600, tmux_mode: false,
    chain_meeseeks: false, backend: 'claude', original_prompt: 'real mux unit', start_commit: startCommit,
    current_ticket: null, exit_reason: null, activity: [], history: [],
    // As setup.js pins a real session: the unit must NOT inherit this pin, its worktree is on another branch.
    pinned_branch: 'main', pinned_sha: startCommit,
  }, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases: ['pickle'], max_parallel_tickets: 2, target, anatomy_stall_limit: 3, szechuan_stall_limit: 5,
    anatomy_max_iterations: 5, szechuan_max_iterations: 5, dirty_exempt_segments: ['prds', 'docs'],
    child_mux_runner_heartbeat_ms: 250, child_mux_runner_stall_seconds: STALL_SECONDS,
  }));
  fs.writeFileSync(path.join(sessionDir, ID, `rick_ticket_${ID}.md`),
    `---\nid: ${ID}\ntitle: ${ID}\nstatus: Todo\norder: 10\nparallel_safe: true\n---\n`
    + `# ${ID}\n## Implementation Details\n**Files to modify/create**: \`src/${ID}.ts\`\n`);
  const cleanup = () => {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  };
  return { target, dataRoot, fakeBin, extRoot, sessionDir, unitDir: `${sessionDir}--unit-${ID}`, cleanup };
}

async function runMain(fx) {
  const saved = { ...process.env };
  const originalExit = process.exit;
  delete process.env.TMUX;
  Object.assign(process.env, {
    PICKLE_DATA_ROOT: fx.dataRoot, EXTENSION_DIR: fx.extRoot, NODE_ENV: 'test', EXTENSION_DIR_TEST: '1',
    PATH: `${fx.fakeBin}:${process.env.PATH}`,
  });
  process.exit = (code) => { throw Object.assign(new Error('exit'), { exitCode: code ?? 0 }); };
  try {
    await main(fx.sessionDir);
    return null;
  } catch (err) {
    if (err && typeof err.exitCode === 'number') return err.exitCode;
    throw err;
  } finally {
    process.exit = originalExit;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const readJsonLines = (file) => fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const field = (content, name) => content.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '');

test('a real mux-runner.js inside a unit: pin holds, the manager never enters Phase 1, the heartbeat watches the unit',
  { timeout: 180_000 }, async () => {
    const fx = makeFixture();
    try {
      const exitCode = await runMain(fx);
      const log = fs.readFileSync(path.join(fx.sessionDir, 'pipeline-runner.log'), 'utf-8');
      const unitState = JSON.parse(fs.readFileSync(path.join(fx.unitDir, 'state.json'), 'utf-8'));

      // Pin: the unit worktree sits on the unit branch, which is what the unit was pinned to.
      assert.notEqual(unitState.exit_reason, 'working_tree_modified_externally', `unit exit_reason: ${unitState.exit_reason}`);
      assert.ok(!(unitState.activity ?? []).some((e) => e.event === 'head_mismatch_detected'), 'no head_mismatch_detected');

      const managerLog = path.join(fx.unitDir, 'fake-manager.jsonl');
      const manager = fs.existsSync(managerLog) ? readJsonLines(managerLog) : [];

      // Step: every manager turn was handed a lifecycle step, never the PRD drafter's.
      const starts = manager.filter((r) => r.phase === 'start');
      assert.ok(starts.length >= 1, `the real mux-runner spawned the manager: ${JSON.stringify(manager)}`);
      for (const { step } of starts) {
        assert.ok(typeof step === 'string' && step !== 'prd', `manager routed to Phase 1 (PRD) by step=${JSON.stringify(step)}`);
      }

      // Heartbeat: silent, and not vacuously — the parent sat idle past the stall window while the unit worked.
      const end = manager.find((r) => r.phase === 'end');
      assert.ok(end, `the manager ran to completion (a heartbeat SIGTERM kills it first): ${JSON.stringify(manager)}`);
      assert.ok(end.parentIdleMs > STALL_SECONDS * 1000,
        `parent idle ${end.parentIdleMs}ms must exceed the ${STALL_SECONDS}s stall window, or a parent-watching heartbeat stays silent too`);
      const activityDir = path.join(fx.dataRoot, 'activity');
      const events = fs.readdirSync(activityDir).flatMap((f) => readJsonLines(path.join(activityDir, f)));
      assert.ok(events.length > 0, 'the activity log under the fixture data root is the one being written');
      assert.deepEqual(events.filter((e) => e.event === 'child_mux_runner_wedge_detected'), [], 'the unit heartbeat never fired');

      // The unit's work landed and was written back.
      assert.match(log, new RegExp(`pickle waves: wave 1 ${ID}: integrated @ [0-9a-f]{40}`));
      assert.doesNotMatch(log, /falling back to serial/);
      assert.ok(exitCode === null || exitCode === 0, `main exit ${exitCode}`);
      const ticket = fs.readFileSync(path.join(fx.sessionDir, ID, `rick_ticket_${ID}.md`), 'utf-8');
      assert.equal(field(ticket, 'status'), 'Done');
      git(fx.target, 'merge-base', '--is-ancestor', field(ticket, 'completion_commit'), 'HEAD');
    } finally {
      fx.cleanup();
    }
  });
