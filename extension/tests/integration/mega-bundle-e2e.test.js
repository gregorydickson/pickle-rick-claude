// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { correctPhantomDoneTickets } from '../../bin/mux-runner.js';
import { initializeNewSession, parseArguments } from '../../bin/setup.js';
import { classifyFailure } from '../../services/microverse-state.js';
import { backendEnvOverrides, buildWorkerInvocation } from '../../services/backend-spawn.js';
import { buildReport, scanSessionFiles } from '../../services/metrics-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(EXTENSION_ROOT, '..');
const CHECK_UPDATE = path.join(EXTENSION_ROOT, 'bin/check-update.js');
const TOOL_ERROR_HANDLER = path.join(EXTENSION_ROOT, 'hooks/handlers/tool-error.js');

function tmpRoot(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeExtensionSentinel(root) {
  fs.mkdirSync(path.join(root, 'extension/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extension/bin/log-watcher.js'), '');
}

function makeReleaseTarball(root, version) {
  const contentRoot = path.join(root, `release-${version}`);
  const packageRoot = path.join(contentRoot, 'pickle-rick-claude');
  fs.mkdirSync(path.join(packageRoot, 'extension'), { recursive: true });
  writeJson(path.join(packageRoot, 'extension/package.json'), { version });
  fs.writeFileSync(
    path.join(packageRoot, 'install.sh'),
    '#!/bin/sh\nprintf installed > "$EXTENSION_DIR/install-marker.txt"\n',
    { mode: 0o755 },
  );
  const tarball = path.join(root, `release-${version}.tar.gz`);
  execFileSync('tar', ['czf', tarball, '-C', contentRoot, 'pickle-rick-claude']);
  return tarball;
}

function mockGh(root, tarball) {
  const binDir = path.join(root, 'mock-bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'gh'),
    `#!/bin/sh
dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-D" ]; then
    shift
    dest="$1"
  fi
  shift
done
mkdir -p "$dest"
cp ${JSON.stringify(tarball)} "$dest/pickle-release.tar.gz"
`,
    { mode: 0o755 },
  );
  return binDir;
}

function baseState(sessionDir, workingDir) {
  return {
    active: true,
    working_dir: workingDir,
    step: 'implement',
    iteration: 1,
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'mega bundle fixture',
    current_ticket: 'ticket-c',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: false,
  };
}

function runToolErrorHandler(harness, payload) {
  const stdout = execFileSync(process.execPath, [TOOL_ERROR_HANDLER], {
    input: JSON.stringify({
      session_id: 'session',
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_use_id: 'tool-1',
      cwd: harness.workingDir,
      ...payload,
    }),
    encoding: 'utf8',
    cwd: harness.workingDir,
    env: {
      ...process.env,
      EXTENSION_DIR: harness.dataRoot,
      PICKLE_STATE_FILE: harness.stateFile,
      FORCE_COLOR: '0',
    },
  });
  return JSON.parse(stdout.trim());
}

function writeTicket(sessionDir, ticketId, fields = '') {
  const ticketDir = path.join(sessionDir, ticketId);
  fs.mkdirSync(ticketDir, { recursive: true });
  fs.writeFileSync(
    path.join(ticketDir, `rick_ticket_${ticketId}.md`),
    `---\nid: ${ticketId}\ntitle: Fixture\nstatus: "Done"\norder: 10\n${fields}---\n`,
  );
}

function readActivityEntries(dataRoot) {
  const activityDir = path.join(dataRoot, 'activity');
  const files = fs.readdirSync(activityDir).filter(file => file.endsWith('.jsonl'));
  return files.flatMap(file =>
    fs.readFileSync(path.join(activityDir, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line)),
  );
}

function assistantLine(timestamp, backend) {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    backend,
    message: {
      usage: {
        input_tokens: 11,
        output_tokens: 29,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

test('mega bundle Hermes identity carries through state, activity log, and metrics', () => {
  const root = tmpRoot('mega-hermes-flow-');
  const previousDataRoot = process.env.PICKLE_DATA_ROOT;
  try {
    process.env.PICKLE_DATA_ROOT = root;
    const session = initializeNewSession(parseArguments(['--tmux', '--backend', 'hermes', '--task', 'hermes flow fixture']));
    assert.equal(session.state.backend, 'hermes');

    const activityEntries = readActivityEntries(root);
    const start = activityEntries.find(entry => entry.event === 'session_start' && entry.session === path.basename(session.sessionRoot));
    assert.ok(start, 'session_start activity entry must exist');
    assert.equal(start.backend, session.state.backend);

    const projectsRoot = path.join(root, 'projects');
    const slug = 'hermes-flow-project';
    const timestamp = '2026-05-03T12:00:00Z';
    fs.mkdirSync(path.join(projectsRoot, slug), { recursive: true });
    fs.writeFileSync(path.join(projectsRoot, slug, 'session.jsonl'), `${assistantLine(timestamp, start.backend)}\n`);

    const scanned = scanSessionFiles(projectsRoot, '2026-05-03', '2026-05-03', path.join(root, 'metrics-cache.json'));
    const report = buildReport(scanned, new Map(), '2026-05-03', '2026-05-03', 'daily');
    assert.equal(report.tokens_per_backend.hermes.output, 29);
    assert.equal(report.tokens_per_backend.claude.output, 0);
  } finally {
    if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousDataRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function initGitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial fixture'], { cwd: dir, stdio: 'ignore' });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function makeMicroverseState(overrides = {}) {
  return {
    status: 'iterating',
    prd_path: '/tmp/fixture-prd.md',
    gap_analysis_path: '/tmp/gap.md',
    failed_approaches: [],
    baseline_score: 50,
    failure_history: [],
    approach_exhaustion_fired: false,
    key_metric: {
      description: 'fixture metric',
      validation: 'node metric.js',
      type: 'command',
      timeout_seconds: 10,
      tolerance: 0,
      direction: 'higher',
    },
    convergence: {
      stall_limit: 6,
      stall_counter: 0,
      history: [],
    },
    ...overrides,
  };
}

test('mega bundle A-F smoke paths work together', () => {
  const root = tmpRoot('mega-bundle-e2e-');
  const previousDataRoot = process.env.PICKLE_DATA_ROOT;
  try {
    const installSh = fs.readFileSync(path.join(REPO_ROOT, 'install.sh'), 'utf8');
    const muxRunnerSource = fs.readFileSync(path.join(EXTENSION_ROOT, 'src/bin/mux-runner.ts'), 'utf8');
    const typesSource = fs.readFileSync(path.join(EXTENSION_ROOT, 'src/types/index.ts'), 'utf8');

    assert.equal(fs.existsSync(path.join(REPO_ROOT, 'bin/verify-deploy-parity.js')), false);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, 'bin/finalize-bundle.js')), false);
    assert.equal(fs.existsSync(path.join(REPO_ROOT, 'bin/verify-launch.js')), false);
    assert.doesNotMatch(installSh, /\bcrontab\b/);
    assert.doesNotMatch(installSh, /deploy-baseline[.]json/);
    assert.doesNotMatch(muxRunnerSource, /deploy_drift_detected/);
    assert.doesNotMatch(muxRunnerSource, /ac-dr-pre-flight|ac-dr-15/);
    assert.doesNotMatch(typesSource, /'deploy_drift_detected'/);

    const extensionDir = path.join(root, 'extension-root');
    writeExtensionSentinel(extensionDir);
    writeJson(path.join(extensionDir, 'extension/package.json'), { version: '1.68.0' });
    const binDir = mockGh(root, makeReleaseTarball(root, '1.67.0'));
    const downgradeScript = `
      import { BlockedDowngradeError, performUpgrade } from ${JSON.stringify(pathToFileURL(CHECK_UPDATE).href)};
      try {
        performUpgrade('1.68.0', '1.69.0', 'v1.69.0', { force: true });
      } catch (error) {
        if (error instanceof BlockedDowngradeError) {
          console.log(JSON.stringify({ blocked: true, current: error.current, candidate: error.candidate }));
          process.exit(1);
        }
        throw error;
      }
    `;
    const downgrade = spawnSync(process.execPath, ['--input-type=module', '-e', downgradeScript], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PICKLE_EXTENSION_DIR_TEST: '1',
        EXTENSION_DIR: extensionDir,
        PICKLE_DATA_ROOT: path.join(root, 'data-root-a'),
        PATH: `${binDir}:${process.env.PATH}`,
      },
    });
    assert.equal(downgrade.status, 1, downgrade.stderr || downgrade.stdout);
    assert.deepEqual(JSON.parse(downgrade.stdout), {
      blocked: true,
      current: '1.68.0',
      candidate: '1.67.0',
    });
    assert.equal(fs.existsSync(path.join(extensionDir, 'install-marker.txt')), false);

    const parentSession = path.join(root, 'sessions/session-b');
    const childRepo = path.join(root, 'repos/child');
    const startCommit = initGitRepo(childRepo);
    process.env.PICKLE_DATA_ROOT = path.join(root, 'data-root-b');
    writeTicket(parentSession, 'ticket-b', `working_dir: ${childRepo}\n`);
    const corrected = correctPhantomDoneTickets({
      sessionDir: parentSession,
      workingDir: path.join(root, 'repos/parent'),
      startCommit,
      iteration: 2,
      log: () => {},
    });
    assert.equal(corrected, 1);
    assert.match(
      fs.readFileSync(path.join(parentSession, 'ticket-b/rick_ticket_ticket-b.md'), 'utf8'),
      /status: "Todo"/,
    );

    const sessionDir = path.join(root, 'sessions/session-c');
    const stateFile = path.join(sessionDir, 'state.json');
    fs.mkdirSync(sessionDir, { recursive: true });
    writeExtensionSentinel(path.join(root, 'data-root-c'));
    writeJson(stateFile, baseState(sessionDir, root));
    const toolHarness = {
      dataRoot: path.join(root, 'data-root-c'),
      stateFile,
      workingDir: root,
    };
    assert.equal(runToolErrorHandler(toolHarness, { error: 'Failed at /tmp/a/file.ts:10:2' }).decision, 'approve');
    assert.equal(runToolErrorHandler(toolHarness, { error: 'Failed at /Users/me/file.ts:88:4' }).decision, 'approve');
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(sessionDir, 'last-tool-error.json'), 'utf8')).retry_count,
      2,
    );

    assert.equal(
      classifyFailure(makeMicroverseState(), null, 'a'.repeat(40), 'b'.repeat(40)),
      'tool_failure',
    );
    assert.equal(
      classifyFailure(makeMicroverseState(), { raw: '49', score: 49 }, 'a'.repeat(40), 'b'.repeat(40)),
      'regression',
    );
    assert.equal(
      classifyFailure(
        makeMicroverseState({ failed_approaches: ['one', 'two', 'three'], convergence: { stall_limit: 6, stall_counter: 3, history: [] } }),
        { raw: '50', score: 50 },
        'a'.repeat(40),
        'b'.repeat(40),
      ),
      'approach_exhaustion',
    );
    assert.equal(
      classifyFailure(makeMicroverseState(), { raw: '50', score: 50 }, 'c'.repeat(40), 'c'.repeat(40)),
      'no_progress',
    );

    const hermes = buildWorkerInvocation('hermes', {
      prompt: 'mega bundle hermes',
      addDirs: [],
      toolsets: ['terminal', ' file '],
      provider: 'openrouter',
      model: 'openrouter/test-model',
      maxTurns: 4,
    });
    assert.equal(hermes.cmd, 'hermes');
    assert.equal(hermes.backend, 'hermes');
    assert.deepEqual(hermes.args.slice(0, 4), ['chat', '-q', 'mega bundle hermes', '-Q']);
    assert.equal(hermes.args[hermes.args.indexOf('--toolsets') + 1], 'terminal,file');
    assert.equal(hermes.args[hermes.args.indexOf('--provider') + 1], 'openrouter');
    assert.equal(hermes.args[hermes.args.indexOf('-m') + 1], 'openrouter/test-model');
    assert.equal(hermes.args[hermes.args.indexOf('--max-turns') + 1], '4');
    assert.deepEqual(backendEnvOverrides('hermes'), { PICKLE_BACKEND: 'hermes' });

    const sourceFiles = execFileSync('rg', ['--files', 'src'], { cwd: EXTENSION_ROOT, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean);
    const legacyCarveOuts = spawnSync(
      'rg',
      ['-n', 'eslint-disable-next-line', ...sourceFiles],
      { cwd: EXTENSION_ROOT, encoding: 'utf8' },
    );
    const unreviewedCarveOuts = (legacyCarveOuts.stdout ?? '')
      .split('\n')
      .filter(Boolean)
      .filter(line => {
        if (/eslint-disable-next-line\s*(--)?\s*$/.test(line)) return true;
        if (!/(outside T0|complexity|max-lines-per-function)/.test(line)) return false;
        return !line.includes('HT-1 reviewed:');
      });
    assert.deepEqual(unreviewedCarveOuts, []);
    const eslintConfig = fs.readFileSync(path.join(EXTENSION_ROOT, 'eslint.config.js'), 'utf8');
    assert.match(eslintConfig, /complexity:\s*\['error',\s*\{\s*max:\s*15\s*\}\]/);
    assert.match(eslintConfig, /'max-lines-per-function':\s*\['error',\s*\{\s*max:\s*120/);
  } finally {
    if (previousDataRoot === undefined) delete process.env.PICKLE_DATA_ROOT;
    else process.env.PICKLE_DATA_ROOT = previousDataRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
