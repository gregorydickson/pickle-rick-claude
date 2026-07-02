// @tier: fast
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  __setSpawnRunnerForTests,
  __setCitadelRemediationDepsForTests,
  main,
  readCitadelReport,
  setupPhase,
} from '../bin/pipeline-runner.js';

class ExitIntercept extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function initRepo(repo) {
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@test.local'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.mkdirSync(path.join(repo, 'services'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'services', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'services', 'b.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(repo, 'services', 'c.ts'), 'export const c = 3;\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'seed'], repo);
}

function writeBaseState(sessionDir, repo, overrides = {}) {
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify({
    active: false,
    working_dir: repo,
    step: 'implement',
    iteration: 0,
    max_iterations: 100,
    max_time_minutes: 720,
    worker_timeout_seconds: 1200,
    start_time_epoch: 1000,
    completion_promise: null,
    original_prompt: 'test',
    current_ticket: 'TICKET-7',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: true,
    backend: 'claude',
    ...overrides,
  }, null, 2));
}

function writePipeline(sessionDir, repo, phases, extra = {}) {
  fs.writeFileSync(path.join(sessionDir, 'pipeline.json'), JSON.stringify({
    phases,
    target: repo,
    anatomy_stall_limit: 3,
    szechuan_stall_limit: 5,
    anatomy_max_iterations: 100,
    szechuan_max_iterations: 50,
    dirty_exempt_segments: ['prds', 'docs'],
    ...extra,
  }, null, 2));
}

function makeSession(phases, extra = {}, stateOverrides = {}) {
  const repo = tmpDir('pipeline-dispatch-repo-');
  const sessionDir = tmpDir('pipeline-dispatch-session-');
  initRepo(repo);
  writeBaseState(sessionDir, repo, stateOverrides);
  writePipeline(sessionDir, repo, phases, extra);
  return { repo, sessionDir };
}

function writeCodexRequiredPrd(sessionDir) {
  fs.writeFileSync(path.join(sessionDir, 'prd.md'), [
    '# Bundle',
    '',
    'frontmatter:',
    '```',
    'backend: codex-required',
    '```',
  ].join('\n'));
}

function loaShapePrd() {
  return [
    '# LOA-618 PRD',
    '',
    '## Acceptance Criteria',
    '',
    '**AC-FF-05**: Feature flag off behavior is enforced.',
    '- POST /api/runs/{runId}/retry returns 403 when comparison_retry_enabled is off.',
    '- POST /api/runs/{runId}/cancel returns 403 when comparison_retry_enabled is off.',
    '- PATCH /api/runs/{runId}/override returns 403 when comparison_retry_enabled is off.',
    '',
  ].join('\n');
}

function refinedManifestRows() {
  return [
    '# Refined PRD',
    '',
    '| Order | Key | ID | Source PRD | Section | Title | ACs |',
    '|---|---|---|---|---|---|---|',
    '| 1 | T1 | a | `prd.md` | Tasks | Retry flag | AC-FF-05 |',
    '| 2 | T2 | b | `prd.md` | Tasks | Cancel flag | AC-FF-05 |',
    '| 3 | T3 | c | `prd.md` | Tasks | Override flag | AC-FF-05 |',
    '',
  ].join('\n');
}

function writeCitadelHighFixture(repo, sessionDir) {
  fs.writeFileSync(path.join(repo, 'prd.md'), loaShapePrd());
  git(['add', 'prd.md'], repo);
  git(['commit', '-q', '-m', 'add prd'], repo);
  const base = git(['rev-parse', 'HEAD'], repo);
  // Provide implementation + test evidence so ac-coverage doesn't raise a Critical finding.
  // The fanout-without-justification on AC-FF-05 still yields the High finding the test asserts on.
  fs.writeFileSync(path.join(repo, 'services', 'a.ts'),
    '// AC-FF-05 implementation: comparison_retry_enabled flag check\n' +
    'export const a = 11;\n');
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', 'ac-ff-05.test.ts'),
    '// AC-FF-05 test\nexport const test = true;\n');
  git(['add', 'services/a.ts', 'tests/ac-ff-05.test.ts'], repo);
  git(['commit', '-q', '-m', 'change implementation'], repo);
  fs.writeFileSync(path.join(sessionDir, 'prd_refined.md'), refinedManifestRows());
  return { prdPath: 'prd.md', startCommit: base };
}

function updateState(sessionDir, patch) {
  const statePath = path.join(sessionDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  fs.writeFileSync(statePath, JSON.stringify({ ...state, ...patch }, null, 2));
}

async function expectMainExit(sessionDir, code) {
  const originalExit = process.exit;
  const originalTmux = process.env.TMUX;
  delete process.env.TMUX;
  process.exit = ((actualCode) => {
    throw new ExitIntercept(actualCode ?? 0);
  });
  try {
    await assert.rejects(
      () => main(sessionDir),
      (err) => err instanceof ExitIntercept && err.code === code,
    );
  } finally {
    process.exit = originalExit;
    if (originalTmux === undefined) {
      delete process.env.TMUX;
    } else {
      process.env.TMUX = originalTmux;
    }
  }
}

function cleanup(paths) {
  for (const p of paths) {
    fs.rmSync(p, { recursive: true, force: true });
  }
}

function assertRunnerScript(actualPath, scriptName) {
  const normalized = path.normalize(actualPath);
  assert.equal(path.isAbsolute(normalized), true);
  assert.deepEqual(normalized.split(path.sep).slice(-3), ['extension', 'bin', scriptName]);
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
}

function readActivityEvents(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  return fs.readdirSync(activityDir)
    .filter((file) => file.endsWith('.jsonl'))
    .flatMap((file) => fs.readFileSync(path.join(activityDir, file), 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
}

function assertSectionBody(lines, heading, body) {
  const index = lines.indexOf(heading);
  assert.notEqual(index, -1);
  assert.equal(lines[index + 1], body);
}

afterEach(() => {
  __setSpawnRunnerForTests(null);
  __setCitadelRemediationDepsForTests(null);
});

describe('pipeline phase config dispatch', () => {
  test('setupPhase returns expected config for each phase', () => {
    const config = {
      phases: ['pickle', 'anatomy-park', 'szechuan-sauce'],
      target: '/tmp/project',
      anatomy_stall_limit: 3,
      szechuan_stall_limit: 5,
      anatomy_max_iterations: 100,
      szechuan_max_iterations: 50,
      szechuan_domain: 'typescript',
      szechuan_focus: 'error handling',
      dirty_exempt_segments: [],
      citadel_strict: false,
    };

    const pickle = setupPhase('pickle', config);
    assert.equal(pickle.runnerScript, 'mux-runner.js');
    assert.equal(pickle.setup, null);
    assert.equal(pickle.throwOnEmptyScope, false);
    assert.equal(pickle.preSpawnStateMutation, null);

    const citadel = setupPhase('citadel', config);
    assert.equal(citadel.prevPhase, 'pickle');
    assert.equal(citadel.runnerScript, null);
    assert.equal(citadel.setup, null);
    assert.equal(citadel.refreshScope, false);
    assert.equal(citadel.throwOnEmptyScope, false);

    const anatomy = setupPhase('anatomy-park', config);
    assert.equal(anatomy.prevPhase, 'citadel');
    assert.equal(anatomy.runnerScript, 'microverse-runner.js');
    assert.equal(typeof anatomy.setup, 'function');
    assert.equal(anatomy.refreshScope, true);
    assert.equal(anatomy.throwOnEmptyScope, true);
    assert.equal(anatomy.preSpawnStateMutation, null);

    const szechuan = setupPhase('szechuan-sauce', config);
    assert.equal(szechuan.prevPhase, 'anatomy-park');
    assert.equal(szechuan.runnerScript, 'microverse-runner.js');
    assert.deepEqual(szechuan.setupExtraArgs, { domain: 'typescript', focus: 'error handling' });
    assert.equal(szechuan.throwOnEmptyScope, false);
    assert.equal(szechuan.preSpawnStateMutation, null);
  });

  test('main dispatches pickle through mux-runner without spawning a real runner', async () => {
    const { repo, sessionDir } = makeSession(['pickle']);
    const calls = [];
    __setSpawnRunnerForTests(async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return 0;
    });
    try {
      await expectMainExit(sessionDir, 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cmd, 'node');
      assertRunnerScript(calls[0].args[0], 'mux-runner.js');
      assert.equal(calls[0].args[1], sessionDir);
      assert.equal(calls[0].env.PICKLE_BACKEND, 'claude');
      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
      assert.equal(state.command_template, '_pickle-manager-prompt.md');
    } finally {
      cleanup([repo, sessionDir]);
    }
  });

  test('main persists canonical phase transitions before phase execution', async () => {
    const dataRoot = tmpDir('pipeline-dispatch-data-');
    const originalDataRoot = process.env.PICKLE_DATA_ROOT;
    process.env.PICKLE_DATA_ROOT = dataRoot;
    const { repo, sessionDir } = makeSession(
      ['pickle', 'anatomy-park', 'szechuan-sauce'],
      {},
      { step: 'implement', exit_reason: 'fatal' },
    );
    const fixture = writeCitadelHighFixture(repo, sessionDir);
    updateState(sessionDir, { prd_path: fixture.prdPath, start_commit: fixture.startCommit });
    const expectedChildSteps = ['pickle', 'anatomy-park', 'szechuan-sauce'];
    const childSteps = [];
    __setSpawnRunnerForTests(async () => {
      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
      const expectedStep = expectedChildSteps[childSteps.length];
      assert.equal(state.step, expectedStep);
      childSteps.push(state.step);
      return 0;
    });
    try {
      await expectMainExit(sessionDir, 0);
      assert.deepEqual(childSteps, expectedChildSteps);

      const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
      assert.equal(status.status, 'completed');
      assert.equal(status.current_phase, null);
      assert.equal(status.completed_phases, 4);
      assert.equal(status.total_phases, 4);

      const transitions = readActivityEvents(dataRoot).filter((event) => event.event === 'phase_transition');
      assert.deepEqual(transitions.map((event) => event.next_phase), [
        'pickle',
        'citadel',
        'anatomy-park',
        'szechuan-sauce',
      ]);
      assert.equal(transitions[0].session, path.basename(sessionDir));
      assert.equal(transitions[0].previous_phase, 'implement');
      assert.equal(transitions[0].previous_exit_reason, 'fatal');
      assert.equal(transitions[1].previous_phase, 'pickle');
      assert.equal(transitions[1].next_phase, 'citadel');
      assert.equal(transitions[2].previous_phase, 'citadel');
      assert.equal(transitions[3].previous_phase, 'anatomy-park');
    } finally {
      if (originalDataRoot === undefined) {
        delete process.env.PICKLE_DATA_ROOT;
      } else {
        process.env.PICKLE_DATA_ROOT = originalDataRoot;
      }
      cleanup([repo, sessionDir, dataRoot]);
    }
  });

  test('main inserts citadel between pickle and anatomy and passes report context downstream', async () => {
    const { repo, sessionDir } = makeSession(['pickle', 'anatomy-park']);
    const fixture = writeCitadelHighFixture(repo, sessionDir);
    updateState(sessionDir, { prd_path: fixture.prdPath, start_commit: fixture.startCommit });
    const calls = [];
    __setSpawnRunnerForTests(async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return 0;
    });
    try {
      await expectMainExit(sessionDir, 0);
      assert.equal(calls.length, 2);
      assertRunnerScript(calls[0].args[0], 'mux-runner.js');
      assertRunnerScript(calls[1].args[0], 'microverse-runner.js');
      const report = readCitadelReport(sessionDir);
      assert.ok(report);
      assert.equal(report.summary.high, 1);
      const prd = fs.readFileSync(path.join(sessionDir, 'prd.md'), 'utf-8');
      assert.match(prd, /## Citadel Report/);
      assert.match(prd, /citadel_report\.json/);
    } finally {
      cleanup([repo, sessionDir]);
    }
  });

  test('main does NOT halt on High citadel findings when citadel_strict is enabled (remediates, continues)', async () => {
    const { repo, sessionDir } = makeSession(['pickle', 'anatomy-park'], { citadel_strict: true });
    const fixture = writeCitadelHighFixture(repo, sessionDir);
    updateState(sessionDir, { prd_path: fixture.prdPath, start_commit: fixture.startCommit });
    // R-HRP-1: citadel_strict now WIDENS which findings are remediated (High+); it no longer halts.
    // Stub the remediation spawns so no real worker launches; the pipeline continues to anatomy-park.
    __setCitadelRemediationDepsForTests({
      loadSettings: () => ({ cap: 1, remediatorTimeoutMs: 1000 }),
      spawnGateRemediatorMain: async ({ stdout }) => {
        const briefPath = path.join(sessionDir, 'citadel-brief.md');
        fs.writeFileSync(briefPath, 'fix it');
        stdout(`BRIEF_PATH=${briefPath}`);
        return 0;
      },
      spawnRemediator: () => { /* no-op */ },
    });
    const calls = [];
    __setSpawnRunnerForTests(async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return 0;
    });
    try {
      await expectMainExit(sessionDir, 0);
      // pickle (mux-runner) then anatomy-park (microverse-runner) — citadel ran in-process and continued.
      assert.equal(calls.length, 2);
      assertRunnerScript(calls[0].args[0], 'mux-runner.js');
      assertRunnerScript(calls[1].args[0], 'microverse-runner.js');
      const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
      assert.notEqual(status.status, 'failed');
      const report = readCitadelReport(sessionDir);
      assert.ok(report);
      assert.equal(report.summary.high, 1);
    } finally {
      cleanup([repo, sessionDir]);
    }
  });

  test('main dispatches anatomy-park through microverse-runner after setup', async () => {
    const { repo, sessionDir } = makeSession(['anatomy-park']);
    const calls = [];
    __setSpawnRunnerForTests(async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return 0;
    });
    try {
      await expectMainExit(sessionDir, 0);
      assert.equal(calls.length, 1);
      assertRunnerScript(calls[0].args[0], 'microverse-runner.js');
      assert.equal(calls[0].env.PICKLE_BACKEND, 'claude');
      assert.ok(fs.existsSync(path.join(sessionDir, 'anatomy-park.json')));
      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
      assert.equal(state.command_template, 'anatomy-park.md');
      assert.equal(state.max_iterations, 100);
    } finally {
      cleanup([repo, sessionDir]);
    }
  });

  test('main recovers newer dead-writer pipeline.json tmp before dispatch', async () => {
    const { repo, sessionDir } = makeSession(['pickle']);
    const stalePath = path.join(sessionDir, 'pipeline.json');
    const tmpPath = `${stalePath}.tmp.99999999`;
    fs.writeFileSync(tmpPath, JSON.stringify({
      phases: ['anatomy-park'],
      target: repo,
      anatomy_stall_limit: 3,
      szechuan_stall_limit: 5,
      anatomy_max_iterations: 100,
      szechuan_max_iterations: 50,
      dirty_exempt_segments: ['prds', 'docs'],
    }, null, 2));
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(tmpPath, future, future);
    const calls = [];
    __setSpawnRunnerForTests(async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return 0;
    });
    try {
      await expectMainExit(sessionDir, 0);
      assert.equal(calls.length, 1);
      assertRunnerScript(calls[0].args[0], 'microverse-runner.js');
      assert.ok(fs.existsSync(path.join(sessionDir, 'anatomy-park.json')));
      assert.equal(fs.existsSync(tmpPath), false);
    } finally {
      cleanup([repo, sessionDir]);
    }
  });

  test('main dispatches szechuan-sauce through microverse-runner with domain and focus setup', async () => {
    const { repo, sessionDir } = makeSession(['szechuan-sauce'], {
      szechuan_domain: 'typescript',
      szechuan_focus: 'small functions',
    });
    const calls = [];
    __setSpawnRunnerForTests(async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return 0;
    });
    try {
      await expectMainExit(sessionDir, 0);
      assert.equal(calls.length, 1);
      assertRunnerScript(calls[0].args[0], 'microverse-runner.js');
      assert.equal(calls[0].env.PICKLE_BACKEND, 'claude');
      assertSectionBody(readLines(path.join(sessionDir, 'prd.md')), '## Focus', 'small functions');
      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
      assert.equal(state.command_template, 'szechuan-sauce.md');
      assert.equal(state.max_iterations, 50);
    } finally {
      cleanup([repo, sessionDir]);
    }
  });

  test('main preserves anatomy-park empty scope failure', async () => {
    const { repo, sessionDir } = makeSession(['anatomy-park']);
    const head = git(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify({
      version: 1,
      mode: 'branch',
      strategy: 'strict',
      base_ref: 'main',
      base_sha: head,
      head_sha: head,
      allowed_paths: [],
      resolved_at: new Date().toISOString(),
      refresh_history: [],
    }, null, 2));
    __setSpawnRunnerForTests(async () => {
      throw new Error('runner should not be called');
    });
    const originalTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      await assert.rejects(
        () => main(sessionDir),
        (err) => err && err.name === 'ScopeError' && err.code === 'SCOPE_EMPTY_POST_BUILD',
      );
      const status = JSON.parse(fs.readFileSync(path.join(sessionDir, 'pipeline-status.json'), 'utf-8'));
      assert.equal(status.status, 'failed');
      assert.equal(status.current_phase, 'anatomy-park');
    } finally {
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
      cleanup([repo, sessionDir]);
    }
  });

  test('main rejects codex-required bundle PRD when backend resolves non-codex', async () => {
    const { repo, sessionDir } = makeSession(['pickle']);
    writeCodexRequiredPrd(sessionDir);
    __setSpawnRunnerForTests(async () => {
      throw new Error('runner should not be called');
    });
    const originalTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      await assert.rejects(
        () => main(sessionDir),
        (err) => err instanceof Error &&
          err.message.includes('/pickle-pipeline --backend codex') &&
          err.message.includes('backend: codex-required'),
      );
      const state = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf-8'));
      assert.equal(state.backend, 'claude');
    } finally {
      if (originalTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = originalTmux;
      }
      cleanup([repo, sessionDir]);
    }
  });

  test('main allows codex-required bundle PRD when backend resolves codex', async () => {
    const { repo, sessionDir } = makeSession(['pickle'], {}, { backend: 'codex' });
    writeCodexRequiredPrd(sessionDir);
    const calls = [];
    __setSpawnRunnerForTests(async (cmd, args, env) => {
      calls.push({ cmd, args, env });
      return 0;
    });
    try {
      await expectMainExit(sessionDir, 0);
      assert.equal(calls.length, 1);
      assertRunnerScript(calls[0].args[0], 'mux-runner.js');
      assert.equal(calls[0].env.PICKLE_BACKEND, 'codex');
    } finally {
      cleanup([repo, sessionDir]);
    }
  });
});
