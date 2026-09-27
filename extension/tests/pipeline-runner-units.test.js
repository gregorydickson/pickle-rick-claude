// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkFixtureTmpDir } from './helpers/fixture-tmpdir.js';
import { createTicketUnitSession, main, __setSpawnRunnerForTests } from '../bin/pipeline-runner.js';
import { readEvidence } from '../services/ticket-completion-evidence.js';
import { LATEST_SCHEMA_VERSION } from '../types/index.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 }).trim();

function initRepo(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@test.local');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'seed');
  return git(dir, 'rev-parse', 'HEAD');
}

const TICKET = 'abc12345';
const SIBLING = 'def67890';
const SESSION = '2026-09-27-unitseed';

// A parent session whose start_commit is the seed; HEAD then advances one commit — the second wave's sha.
function makeFixture() {
  const target = fs.realpathSync(mkFixtureTmpDir('pickle-units-'));
  const startCommit = initRepo(target);
  fs.writeFileSync(path.join(target, 'wave1.txt'), 'first wave landed\n');
  git(target, 'add', '.');
  git(target, 'commit', '-q', '-m', 'wave 1');
  const waveSha = git(target, 'rev-parse', 'HEAD');
  const dataRoot = fs.realpathSync(mkFixtureTmpDir('pickle-units-data-'));
  const parent = path.join(dataRoot, 'sessions', SESSION);
  fs.mkdirSync(parent, { recursive: true });
  // At the latest schema, as a live parent is — an older one would be migrated in place on read.
  fs.writeFileSync(path.join(parent, 'state.json'), JSON.stringify({
    schema_version: LATEST_SCHEMA_VERSION,
    active: true,
    working_dir: target,
    session_dir: parent,
    step: 'pickle',
    iteration: 9,
    max_iterations: 50,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    current_ticket: SIBLING,
    current_ticket_tier: 'small',
    command_template: '_pickle-manager-prompt.md',
    history: [],
    started_at: new Date().toISOString(),
    start_commit: startCommit,
    pinned_sha: startCommit,
    pinned_branch: 'main',
  }, null, 2));
  fs.writeFileSync(path.join(parent, 'scope.json'), JSON.stringify({ mode: 'paths', allowed_paths: ['README.md'] }));
  fs.writeFileSync(path.join(parent, 'prd.md'), '# prd\n');
  for (const id of [TICKET, SIBLING]) {
    fs.mkdirSync(path.join(parent, id));
    fs.writeFileSync(path.join(parent, id, `rick_ticket_${id}.md`), `---\nid: ${id}\nstatus: Todo\n---\n# ${id}\n`);
  }
  return { target, dataRoot, parent, startCommit, waveSha };
}

function withFixture(fn) {
  const fixture = makeFixture();
  try {
    fn(fixture);
  } finally {
    fs.rmSync(fixture.target, { recursive: true, force: true });
    fs.rmSync(fixture.dataRoot, { recursive: true, force: true });
  }
}

describe('createTicketUnitSession', () => {
  test('AC-SEED: a second-wave unit is pinned to the wave sha and carried through the pickle transition', () => {
    withFixture(({ target, parent, startCommit, waveSha }) => {
      const parentStateBefore = fs.readFileSync(path.join(parent, 'state.json'), 'utf-8');
      assert.notEqual(waveSha, startCommit, 'fixture precondition: HEAD advanced past the parent start_commit');

      const unit = createTicketUnitSession(parent, TICKET, waveSha, target, 'claude');

      assert.strictEqual(unit.unitDir, `${parent}--unit-${TICKET}`);
      assert.strictEqual(unit.branch, `pickle-lane/${SESSION}/unit-${TICKET}`);
      const worktree = fs.realpathSync(unit.worktree);
      assert.strictEqual(git(worktree, 'rev-parse', 'HEAD'), waveSha);
      assert.strictEqual(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), unit.branch);

      const state = JSON.parse(fs.readFileSync(unit.statePath, 'utf-8'));
      assert.strictEqual(state.start_commit, waveSha);
      assert.strictEqual(state.pinned_sha, waveSha);
      assert.strictEqual(state.pinned_branch, `pickle-lane/${SESSION}/unit-${TICKET}`);
      assert.strictEqual(state.command_template, '_pickle-manager-prompt.md');
      assert.strictEqual(state.step, 'pickle');
      assert.strictEqual(state.session_dir, unit.unitDir);
      assert.strictEqual(state.working_dir, worktree);
      assert.strictEqual(unit.workingDir, worktree);
      assert.strictEqual(state.current_ticket, TICKET);
      assert.strictEqual(state.current_ticket_tier, undefined, 'the parent ticket caches are not carried');
      assert.strictEqual(state.iteration, 0);
      assert.strictEqual(state.backend, 'claude');
      assert.strictEqual(state.active, true);

      assert.strictEqual(
        fs.readFileSync(path.join(unit.unitDir, 'scope.json'), 'utf-8'),
        fs.readFileSync(path.join(parent, 'scope.json'), 'utf-8'),
        'the parent scope.json is copied unchanged',
      );
      assert.strictEqual(fs.readFileSync(path.join(unit.unitDir, 'prd.md'), 'utf-8'), '# prd\n');
      assert.ok(fs.existsSync(path.join(unit.unitDir, TICKET, `rick_ticket_${TICKET}.md`)));
      assert.ok(!fs.existsSync(path.join(unit.unitDir, SIBLING)), 'a sibling ticket dir is not copied');
      assert.strictEqual(fs.readFileSync(path.join(parent, 'state.json'), 'utf-8'), parentStateBefore, 'the parent state is not written');
    });
  });

  test('the seeded state rejects completion_commit === wave sha as a baseline', () => {
    withFixture(({ target, parent, waveSha }) => {
      const unit = createTicketUnitSession(parent, TICKET, waveSha, target, 'claude');
      const state = JSON.parse(fs.readFileSync(unit.statePath, 'utf-8'));
      const ticketPath = path.join(unit.unitDir, TICKET, `rick_ticket_${TICKET}.md`);
      fs.writeFileSync(ticketPath, `---\nid: ${TICKET}\nstatus: Done\ncompletion_commit: ${waveSha}\n---\n# ${TICKET}\n`);

      const evidence = readEvidence({
        ticketPath,
        ticketId: TICKET,
        workingDir: unit.workingDir,
        startCommit: state.start_commit,
        pinnedSha: state.pinned_sha,
      });
      assert.strictEqual(evidence.kind, 'absent');
      assert.strictEqual(evidence.absentReason, 'baseline_sha');
    });
  });

  test('throws when the unit worktree cannot be created', () => {
    withFixture(({ target, parent, waveSha }) => {
      const blocked = path.join(`${parent}--unit-${TICKET}`, 'wt');
      fs.mkdirSync(blocked, { recursive: true });
      fs.writeFileSync(path.join(blocked, 'occupied.txt'), 'x\n');
      assert.throws(() => createTicketUnitSession(parent, TICKET, waveSha, target, 'claude'));
    });
  });
});

// ---------------------------------------------------------------------------
// d9181756: the pickle phase as waves of unit sessions, integrated with write-back
// ---------------------------------------------------------------------------

describe('runPickleWaves via main()', () => {
  const WAVE_TICKETS = ['aaaa1111', 'bbbb2222'];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const readTicket = (dir, id) => fs.readFileSync(path.join(dir, id, `rick_ticket_${id}.md`), 'utf-8');
  const field = (content, name) => content.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '');

  /** Two parallel_safe Todo tickets declaring disjoint files, and a pickle-only pipeline. */
  function makeWaveFixture(pipeline, tickets = WAVE_TICKETS) {
    const target = fs.realpathSync(mkFixtureTmpDir('pickle-waves-'));
    const startCommit = initRepo(target);
    const dataRoot = fs.realpathSync(mkFixtureTmpDir('pickle-waves-data-'));
    const sessionDir = path.join(dataRoot, 'sessions', '2026-09-27-waves');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
      schema_version: LATEST_SCHEMA_VERSION, active: false, working_dir: target, session_dir: sessionDir,
      step: 'implement', iteration: 0, max_iterations: 100, tmux_mode: false, chain_meeseeks: false,
      backend: 'claude', original_prompt: 'wave fixture', start_commit: startCommit, current_ticket: null,
      exit_reason: null, activity: [], history: [],
    }, null, 2));
    fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
      phases: ['pickle'], target, anatomy_stall_limit: 3, szechuan_stall_limit: 5,
      anatomy_max_iterations: 5, szechuan_max_iterations: 5, dirty_exempt_segments: ['prds', 'docs'], ...pipeline,
    }));
    tickets.forEach((id, i) => {
      fs.mkdirSync(path.join(sessionDir, id));
      fs.writeFileSync(path.join(sessionDir, id, `rick_ticket_${id}.md`),
        `---\nid: ${id}\ntitle: ${id}\nstatus: Todo\norder: ${(i + 1) * 10}\nparallel_safe: true\n---\n`
        + `# ${id}\n## Implementation Details\n**Files to modify/create**: \`src/${id}.ts\`\n`);
    });
    const cleanup = () => {
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(dataRoot, { recursive: true, force: true });
    };
    return { target, dataRoot, sessionDir, startCommit, cleanup };
  }

  /**
   * Stub mux-runner: a unit commits its declared file, stamps its OWN ticket Done, and holds.
   * A unit whose id is in `collide` also writes its id as line 1 of the UNDECLARED `shared.txt`, so two such units collide.
   */
  function unitRunner(calls, holdMs, { collide = [] } = {}) {
    return async (_cmd, args, _env, opts) => {
      const call = { dir: args[1], opts, start: Date.now(), end: 0 };
      calls.push(call);
      const unit = /--unit-([0-9a-f]+)$/.exec(args[1]);
      if (unit) {
        const id = unit[1];
        const wt = JSON.parse(fs.readFileSync(path.join(args[1], 'state.json'), 'utf-8')).working_dir;
        fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
        fs.writeFileSync(path.join(wt, 'src', `${id}.ts`), `export const v = '${id}';\n`);
        if (collide.includes(id)) fs.writeFileSync(path.join(wt, 'shared.txt'), `${id}\n`);
        git(wt, 'add', '-A');
        git(wt, 'commit', '-q', '-m', `feat(${id}): unit work`);
        const sha = git(wt, 'rev-parse', 'HEAD');
        const ticketPath = path.join(args[1], id, `rick_ticket_${id}.md`);
        fs.writeFileSync(ticketPath, fs.readFileSync(ticketPath, 'utf-8').replace(/^status:.*$/m, `status: Done\ncompletion_commit: ${sha}`));
        await sleep(holdMs);
      }
      call.end = Date.now();
      return { exitCode: 0, stdout: '', stderr: '' };
    };
  }

  async function runMain(sessionDir, dataRoot) {
    const originalExit = process.exit;
    const originalTmux = process.env.TMUX;
    const prevDataRoot = process.env.PICKLE_DATA_ROOT;
    delete process.env.TMUX;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    process.exit = (code) => { throw Object.assign(new Error('exit'), { exitCode: code ?? 0 }); };
    try {
      await main(sessionDir);
      return null;
    } catch (err) {
      if (err && typeof err.exitCode === 'number') return err.exitCode;
      throw err;
    } finally {
      process.exit = originalExit;
      if (originalTmux === undefined) delete process.env.TMUX; else process.env.TMUX = originalTmux;
      if (prevDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT; else process.env.PICKLE_DATA_ROOT = prevDataRoot;
    }
  }

  test('AC-3/AC-7: two parallel_safe disjoint tickets at cap 2 run concurrently and land Done by fast-forward', async () => {
    const fx = makeWaveFixture({ max_parallel_tickets: 2 });
    const calls = [];
    try {
      __setSpawnRunnerForTests(unitRunner(calls, 2000));
      await runMain(fx.sessionDir, fx.dataRoot);

      assert.deepEqual(calls.map((c) => c.dir).sort(), WAVE_TICKETS.map((id) => `${fx.sessionDir}--unit-${id}`));
      const latestStart = Math.max(...calls.map((c) => c.start));
      const earliestEnd = Math.min(...calls.map((c) => c.end));
      assert.ok(latestStart < earliestEnd, `both units were alive at once (last start ${latestStart} < first end ${earliestEnd})`);
      for (const c of calls) assert.equal(c.opts?.sessionDir, c.dir, 'the heartbeat watches the unit dir');

      const head = git(fx.target, 'rev-parse', 'HEAD');
      git(fx.target, 'merge-base', '--is-ancestor', fx.startCommit, head); // throws if not an ancestor
      const subjects = git(fx.target, 'log', '--format=%s', `${fx.startCommit}..HEAD`).split('\n');
      for (const id of WAVE_TICKETS) assert.ok(subjects.includes(`feat(${id}): unit work`), `${id} landed: ${subjects}`);

      for (const id of WAVE_TICKETS) {
        const ticket = readTicket(fx.sessionDir, id);
        assert.equal(field(ticket, 'status'), 'Done', `${id} written back Done`);
        const sha = field(ticket, 'completion_commit');
        assert.ok(sha, `${id} carries a completion_commit`);
        git(fx.target, 'merge-base', '--is-ancestor', sha, head);
        assert.equal(git(fx.target, 'log', '-1', '--format=%s', sha), `feat(${id}): unit work`, `${id} completion_commit is its own commit`);
      }
      assert.equal(git(fx.target, 'worktree', 'list').split('\n').length, 1, 'every unit worktree is removed');
    } finally {
      __setSpawnRunnerForTests(null);
      fx.cleanup();
    }
  });

  const pipelineLog = (sessionDir) => fs.readFileSync(path.join(sessionDir, 'pipeline-runner.log'), 'utf-8');
  const waveLines = (log) => log.split('\n').filter((l) => /pickle waves: wave \d+ members=/.test(l));

  test('AC-4: a colliding member is re-queued once, runs alone from the new HEAD, and integrates', async () => {
    const fx = makeWaveFixture({ max_parallel_tickets: 2 });
    const calls = [];
    try {
      __setSpawnRunnerForTests(unitRunner(calls, 0, { collide: WAVE_TICKETS }));
      const exitCode = await runMain(fx.sessionDir, fx.dataRoot);
      const log = pipelineLog(fx.sessionDir);

      const waves = waveLines(log);
      assert.equal(waves.length, 2, `exactly two waves: ${waves.join(' | ')}`);
      assert.match(waves[0], /members=aaaa1111,bbbb2222 /);
      assert.match(waves[1], /wave 2 members=bbbb2222 in_flight=1/, 'the re-queued ticket runs alone');
      assert.match(log, /wave 1 aaaa1111: integrated @ /);
      assert.match(log, /wave 1 bbbb2222: conflict — written back Todo \(re-queued\)/);
      assert.match(log, /wave 2 bbbb2222: integrated @ /);
      assert.doesNotMatch(log, /falling back to serial/);
      assert.match(log, /pickle waves: success \(0 ticket\(s\) pending\)/, 'the phase exits 0');
      assert.ok(exitCode === null || exitCode === 0, `main exit ${exitCode}`);

      const [first, second] = WAVE_TICKETS.map((id) => field(readTicket(fx.sessionDir, id), 'completion_commit'));
      assert.equal(git(fx.target, 'rev-parse', `${second}^`), first, 'the re-run started from the HEAD the first ticket landed');
      assert.equal(git(fx.target, 'show', `${second}:shared.txt`), 'bbbb2222');
      for (const id of WAVE_TICKETS) assert.equal(field(readTicket(fx.sessionDir, id), 'status'), 'Done', `${id} written back Done`);
      assert.equal(calls.length, 3, 'one unit per member per wave, and no serial runner');
    } finally {
      __setSpawnRunnerForTests(null);
      fx.cleanup();
    }
  });

  test('AC-4: a re-queued ticket runs in a wave of ONE even when a disjoint parallel_safe ticket is pending', async () => {
    const tickets = [...WAVE_TICKETS, 'cccc3333'];
    const fx = makeWaveFixture({ max_parallel_tickets: 2 }, tickets);
    const calls = [];
    try {
      __setSpawnRunnerForTests(unitRunner(calls, 0, { collide: WAVE_TICKETS }));
      await runMain(fx.sessionDir, fx.dataRoot);
      const waves = waveLines(pipelineLog(fx.sessionDir));

      assert.deepEqual(waves.map((l) => /members=(\S+)/.exec(l)[1]), ['aaaa1111,bbbb2222', 'bbbb2222', 'cccc3333'],
        'wave 2 holds the re-queued ticket alone; the disjoint ticket waits for wave 3');
      for (const id of tickets) assert.equal(field(readTicket(fx.sessionDir, id), 'status'), 'Done', `${id} written back Done`);
    } finally {
      __setSpawnRunnerForTests(null);
      fx.cleanup();
    }
  });

  test('AC-11: a wave whose units all fail to start falls back to the serial runner over the parent session', async () => {
    const fx = makeWaveFixture({ max_parallel_tickets: 2 });
    const calls = [];
    try {
      for (const id of WAVE_TICKETS) {
        const blocked = path.join(`${fx.sessionDir}--unit-${id}`, 'wt');
        fs.mkdirSync(blocked, { recursive: true });
        fs.writeFileSync(path.join(blocked, 'occupied.txt'), 'x\n');
      }
      __setSpawnRunnerForTests(unitRunner(calls, 0));
      await runMain(fx.sessionDir, fx.dataRoot);
      const log = pipelineLog(fx.sessionDir);

      assert.equal(waveLines(log).length, 1, 'exactly one wave is attempted');
      assert.match(log, /pickle waves: zero-progress wave — falling back to serial \(aaaa1111=not_done, bbbb2222=not_done\)/);
      assert.ok(calls.length >= 1, 'the serial runner ran');
      assert.equal(calls[0].dir, fx.sessionDir, 'the serial runner is given the PARENT session dir');
      assert.equal(calls[0].opts, undefined, 'the serial path passes no unit spawn options');
    } finally {
      __setSpawnRunnerForTests(null);
      fx.cleanup();
    }
  });

  test('AC-1b: max_parallel_tickets 1 calls the serial runner with the PARENT session dir', async () => {
    const fx = makeWaveFixture({ max_parallel_tickets: 1 });
    const calls = [];
    try {
      __setSpawnRunnerForTests(unitRunner(calls, 0));
      await runMain(fx.sessionDir, fx.dataRoot);
      assert.ok(calls.length >= 1, 'the serial runner ran');
      assert.equal(calls[0].dir, fx.sessionDir, 'one runner over the parent session');
      assert.equal(calls[0].opts, undefined, 'the serial path passes no unit spawn options');
      for (const id of WAVE_TICKETS) assert.equal(fs.existsSync(`${fx.sessionDir}--unit-${id}`), false, 'no unit session is created');
    } finally {
      __setSpawnRunnerForTests(null);
      fx.cleanup();
    }
  });

  // ---------------------------------------------------------------------------
  // f9b19b78: a crashed prior run's live units are reaped; cancel reaches every unit
  // ---------------------------------------------------------------------------

  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code !== 'ESRCH';
    }
  };
  /** Poll until `pid` is gone (a killed orphan is reaped asynchronously by init); then `ps` must not list it. */
  async function assertGone(pid, label) {
    const deadline = Date.now() + 5000;
    while (isAlive(pid) && Date.now() < deadline) await sleep(50);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `${label} (pid ${pid}) is dead`);
    let listed = '';
    try {
      listed = execFileSync('ps', ['-o', 'pid=', '-p', String(pid)], { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch { /* ps exits 1 when the pid is absent */ }
    assert.equal(listed, '', `ps lists no ${label}`);
  }
  const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf-8'));
  const killQuietly = (pid) => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  };

  test('AC-12: a live detached runner recorded by a prior unit is reaped before wave 1, and its worktree is pruned', async () => {
    const fx = makeWaveFixture({ max_parallel_tickets: 2 });
    const priorId = 'ffff6666';
    const prior = createTicketUnitSession(fx.sessionDir, priorId, fx.startCommit, fx.target, 'claude');
    const runner = spawn('sleep', ['60'], { detached: true, stdio: 'ignore', timeout: 120_000 });
    const calls = [];
    try {
      fs.writeFileSync(prior.statePath, JSON.stringify({ ...readState(prior.unitDir), active: true, pid: runner.pid }, null, 2));
      assert.ok(isAlive(runner.pid), 'fixture precondition: the prior unit runner is alive');
      assert.match(git(fx.target, 'worktree', 'list'), /--unit-ffff6666/, 'fixture precondition: the prior unit worktree is registered');

      let aliveAtFirstSpawn = null;
      const stub = unitRunner(calls, 0);
      __setSpawnRunnerForTests(async (...args) => {
        if (aliveAtFirstSpawn === null) aliveAtFirstSpawn = isAlive(runner.pid);
        return stub(...args);
      });
      await runMain(fx.sessionDir, fx.dataRoot);

      assert.equal(aliveAtFirstSpawn, false, 'the prior runner was dead before wave 1 spawned a unit');
      await assertGone(runner.pid, 'prior unit runner');
      assert.equal(readState(prior.unitDir).active, false, 'the prior unit state is deactivated');
      assert.equal(git(fx.target, 'worktree', 'list').split('\n').length, 1, 'only the main checkout remains');
      assert.match(pipelineLog(fx.sessionDir), new RegExp(`reaping 1 live unit runner\\(s\\) from a previous run: pid ${runner.pid}`));
      for (const id of WAVE_TICKETS) assert.equal(field(readTicket(fx.sessionDir, id), 'status'), 'Done', `${id} still built`);
    } finally {
      __setSpawnRunnerForTests(null);
      killQuietly(runner.pid);
      fx.cleanup();
    }
  });

  test('AC-12: a prior unit whose runner is already dead is left alone', async () => {
    const fx = makeWaveFixture({ max_parallel_tickets: 2 });
    const prior = createTicketUnitSession(fx.sessionDir, 'ffff6666', fx.startCommit, fx.target, 'claude');
    const gone = spawn('true', [], { stdio: 'ignore', timeout: 120_000 });
    try {
      await new Promise((resolve) => gone.on('exit', resolve));
      fs.writeFileSync(prior.statePath, JSON.stringify({ ...readState(prior.unitDir), active: true, pid: gone.pid }, null, 2));
      __setSpawnRunnerForTests(unitRunner([], 0));
      await runMain(fx.sessionDir, fx.dataRoot);

      assert.doesNotMatch(pipelineLog(fx.sessionDir), /reaping \d+ live unit runner/, 'nothing live to reap');
      assert.equal(git(fx.target, 'worktree', 'list').split('\n').length, 1, 'the stale worktree is still pruned');
    } finally {
      __setSpawnRunnerForTests(null);
      fx.cleanup();
    }
  });

  test('AC-5: parent active=false mid-wave deactivates every unit, kills every unit group, and writes the tickets back pending', async () => {
    const fx = makeWaveFixture({ max_parallel_tickets: 2, child_mux_runner_heartbeat_ms: 100 });
    const pids = [];
    let registered = 0;
    try {
      __setSpawnRunnerForTests(async (_cmd, args, _env, opts) => {
        if (!/--unit-/.test(args[1])) return { exitCode: 0, stdout: '', stderr: '' };
        // A unit runner with a DESCENDANT: the shell leads the group, the background sleep is its child.
        const child = spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000 });
        const exited = new Promise((resolve) => child.on('exit', resolve));
        const grandchild = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
        pids.push(child.pid, grandchild);
        opts.onSpawn(child);
        if (++registered === 2) {
          const statePath = path.join(fx.sessionDir, 'state.json');
          fs.writeFileSync(statePath, JSON.stringify({ ...readState(fx.sessionDir), active: false }, null, 2));
        }
        await exited;
        return { exitCode: 143, stdout: '', stderr: '' };
      });
      await runMain(fx.sessionDir, fx.dataRoot);

      assert.equal(pids.length, 4, 'both units spawned a runner and a descendant');
      for (const id of WAVE_TICKETS) {
        assert.equal(readState(`${fx.sessionDir}--unit-${id}`).active, false, `unit ${id} state reads active: false`);
      }
      for (const pid of pids) await assertGone(pid, 'unit process');
      assert.equal(git(fx.target, 'worktree', 'list').split('\n').length, 1, 'only the main checkout remains');
      for (const id of WAVE_TICKETS) {
        assert.ok(['Todo', 'In Progress'].includes(field(readTicket(fx.sessionDir, id), 'status')), `${id} is left pending`);
      }
    } finally {
      __setSpawnRunnerForTests(null);
      pids.forEach(killQuietly);
      fx.cleanup();
    }
  });
});
