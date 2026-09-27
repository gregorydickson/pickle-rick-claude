// @tier: integration
/**
 * pickle-waves-e2e — B-PBUILD end to end: `main()` → `runConfiguredPhase` → `runPickleWaves` →
 * unit sessions → integration → parent write-back, over two real repos (the build target and the
 * data root holding the session). Only the mux-runner spawn is stubbed.
 *
 * Roster at cap 2: a, b, c are `parallel_safe` with disjoint files; d is unmarked. The planner must
 * run [a,b], then [c] (d cannot join), then [d] alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkFixtureTmpDir } from '../helpers/fixture-tmpdir.js';
import { main, __setSpawnRunnerForTests } from '../../bin/pipeline-runner.js';
import { LATEST_SCHEMA_VERSION } from '../../types/index.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 }).trim();

const SAFE = ['aaaa1111', 'bbbb2222', 'cccc3333'];
const UNMARKED = 'dddd4444';
const TICKETS = [...SAFE, UNMARKED];

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

function makeFixture() {
  const target = fs.realpathSync(mkFixtureTmpDir('pickle-waves-e2e-'));
  const startCommit = initRepo(target, 'README.md');
  const dataRoot = fs.realpathSync(mkFixtureTmpDir('pickle-waves-e2e-data-'));
  // The data root is its own repo: integration must never commit into it.
  fs.writeFileSync(path.join(dataRoot, '.gitignore'), 'sessions/\n');
  const dataHead = initRepo(dataRoot, 'NOTES.md');
  const sessionDir = path.join(dataRoot, 'sessions', '2026-09-27-e2e');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: LATEST_SCHEMA_VERSION, active: false, working_dir: target, session_dir: sessionDir,
    step: 'implement', iteration: 0, max_iterations: 100, tmux_mode: false, chain_meeseeks: false,
    backend: 'claude', original_prompt: 'wave e2e', start_commit: startCommit, current_ticket: null,
    exit_reason: null, activity: [], history: [],
  }, null, 2));
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases: ['pickle'], max_parallel_tickets: 2, target, anatomy_stall_limit: 3, szechuan_stall_limit: 5,
    anatomy_max_iterations: 5, szechuan_max_iterations: 5, dirty_exempt_segments: ['prds', 'docs'],
  }));
  TICKETS.forEach((id, i) => {
    fs.mkdirSync(path.join(sessionDir, id));
    const safe = SAFE.includes(id) ? 'parallel_safe: true\n' : '';
    fs.writeFileSync(path.join(sessionDir, id, `rick_ticket_${id}.md`),
      `---\nid: ${id}\ntitle: ${id}\nstatus: Todo\norder: ${(i + 1) * 10}\n${safe}---\n`
      + `# ${id}\n## Implementation Details\n**Files to modify/create**: \`src/${id}.ts\`\n`);
  });
  const cleanup = () => {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  };
  return { target, dataRoot, dataHead, sessionDir, startCommit, cleanup };
}

/** Stub mux-runner: a unit commits its declared file in its worktree and stamps its own ticket Done. */
function unitRunner(calls) {
  return async (_cmd, args) => {
    calls.push(args[1]);
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
      fs.writeFileSync(ticketPath, fs.readFileSync(ticketPath, 'utf-8').replace(/^status:.*$/m, `status: Done\ncompletion_commit: ${sha}`));
    }
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

const field = (content, name) => content.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '');

test('max_parallel_tickets 2: waves [a,b], [c], [d] land every ticket Done by fast-forward only', async () => {
  const fx = makeFixture();
  const calls = [];
  try {
    __setSpawnRunnerForTests(unitRunner(calls));
    const exitCode = await runMain(fx.sessionDir, fx.dataRoot);
    const log = fs.readFileSync(path.join(fx.sessionDir, 'pipeline-runner.log'), 'utf-8');

    const waves = log.split('\n').filter((l) => /pickle waves: wave \d+ members=/.test(l)).map((l) => /members=(\S+)/.exec(l)[1]);
    assert.deepEqual(waves, ['aaaa1111,bbbb2222', 'cccc3333', UNMARKED], `wave schedule: ${waves.join(' | ')}`);
    assert.match(log, /pickle waves: success \(0 ticket\(s\) pending\)/);
    assert.doesNotMatch(log, /falling back to serial/);
    assert.ok(exitCode === null || exitCode === 0, `main exit ${exitCode}`);
    assert.deepEqual([...calls].sort(), TICKETS.map((id) => `${fx.sessionDir}--unit-${id}`),
      'one unit per ticket; the serial runner never ran over the parent');

    const head = git(fx.target, 'rev-parse', 'HEAD');
    git(fx.target, 'merge-base', '--is-ancestor', fx.startCommit, head);
    assert.equal(git(fx.target, 'rev-list', '--merges', `${fx.startCommit}..HEAD`), '', 'no merge commit: fast-forward only');
    assert.equal(git(fx.target, 'rev-list', '--count', `${fx.startCommit}..HEAD`), String(TICKETS.length), 'one landed commit per ticket');
    assert.equal(git(fx.target, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the working branch is unchanged');
    assert.equal(git(fx.target, 'worktree', 'list').split('\n').length, 1, 'every unit worktree is removed');
    assert.equal(git(fx.dataRoot, 'rev-parse', 'HEAD'), fx.dataHead, 'the data-root repo is never committed into');

    for (const id of TICKETS) {
      const ticket = fs.readFileSync(path.join(fx.sessionDir, id, `rick_ticket_${id}.md`), 'utf-8');
      assert.equal(field(ticket, 'status'), 'Done', `${id} written back Done`);
      const sha = field(ticket, 'completion_commit');
      assert.ok(sha, `${id} carries a completion_commit`);
      git(fx.target, 'merge-base', '--is-ancestor', sha, head);
      assert.equal(git(fx.target, 'log', '-1', '--format=%s', sha), `feat(${id}): unit work`);
    }
  } finally {
    __setSpawnRunnerForTests(null);
    fx.cleanup();
  }
});
