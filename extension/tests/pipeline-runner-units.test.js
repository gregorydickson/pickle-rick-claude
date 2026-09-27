// @tier: fast
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkFixtureTmpDir } from './helpers/fixture-tmpdir.js';
import { createTicketUnitSession } from '../bin/pipeline-runner.js';
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
