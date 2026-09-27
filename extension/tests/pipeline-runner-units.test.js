// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  function makeWaveFixture(pipeline) {
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
    WAVE_TICKETS.forEach((id, i) => {
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

  /** Stub mux-runner: a unit commits its declared file, stamps its OWN ticket Done, and holds. */
  function unitRunner(calls, holdMs) {
    return async (_cmd, args, _env, opts) => {
      const call = { dir: args[1], opts, start: Date.now(), end: 0 };
      calls.push(call);
      const unit = /--unit-([0-9a-f]+)$/.exec(args[1]);
      if (unit) {
        const id = unit[1];
        const wt = JSON.parse(fs.readFileSync(path.join(args[1], 'state.json'), 'utf-8')).working_dir;
        fs.mkdirSync(path.join(wt, 'src'), { recursive: true });
        fs.writeFileSync(path.join(wt, 'src', `${id}.ts`), `export const v = '${id}';\n`);
        git(wt, 'add', '-A');
        git(wt, 'commit', '-q', '-m', `feat(${id}): unit work`);
        const sha = git(wt, 'rev-parse', 'HEAD');
        const ticketPath = path.join(args[1], id, `rick_ticket_${id}.md`);
        fs.writeFileSync(ticketPath, fs.readFileSync(ticketPath, 'utf-8').replace('status: Todo', `status: Done\ncompletion_commit: ${sha}`));
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
});
