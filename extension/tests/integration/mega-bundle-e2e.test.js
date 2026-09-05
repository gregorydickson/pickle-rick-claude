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

// --- ripgrep-free source enumeration + scan -----------------------------------
// These replace `rg --files <dir>` and `rg -n <needle> <files>`. Spawning ripgrep
// here was an invisible-locally / fatal-in-CI dependency (ENOENT). Both workflows
// DO install ripgrep today (29b4ecc9), so the walk is no longer what keeps this file
// from ENOENT-ing — but that install step exists for audit-trap-door-enforcement.sh,
// not for this test, and a test that enumerates source files needs no spawned binary
// at all. Depending on nothing beats depending on a provisioning list staying
// correct, which is the property the audit below now derives rather than mirrors.
// `rg --files` additionally honors .gitignore and skips hidden files; neither is
// load-bearing under `src` (measured: rg --files and `find -type f` enumerate an
// identical 173-file set), so a plain walk is equivalent on this input.

// Every regular file under <root>/<relDir>, as root-relative POSIX paths, sorted.
function listFilesUnder(root, relDir) {
  const base = path.join(root, relDir);
  return fs
    .readdirSync(base, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
}

// `rg -n <needle> <files...>` output composition: one `path:lineno:content` per
// matching line, path exactly as passed in. The caller's filters match against
// that whole composed string, so the composition is part of the contract.
function grepLines(root, relFiles, needle) {
  const matches = [];
  for (const rel of relFiles) {
    const lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(needle)) { matches.push(`${rel}:${i + 1}:${lines[i]}`); }
    }
  }
  return matches;
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

    const sourceFiles = listFilesUnder(EXTENSION_ROOT, 'src');
    const legacyCarveOuts = grepLines(EXTENSION_ROOT, sourceFiles, 'eslint-disable-next-line');
    const unreviewedCarveOuts = legacyCarveOuts
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

// Regression case for the unprovisioned-binary predicate added to
// scripts/audit-subprocess-heavy-tests.sh. ripgrep is not installed by
// .github/workflows/{ci,release}.yml, so a test that spawns it is green on a dev
// box and `spawnSync rg ENOENT` in CI — the defect this file's own source above
// used to carry.
//
// Fixture source is assembled from a split token (`CALL + '('`) rather than a
// spawn-call-with-tool-argv0 substring, so THIS file — which the audit scans as
// part of the real extension/tests corpus — never itself reads as a candidate to
// the very audit it is testing. Same technique, same reason, as
// tests/audit-subprocess-heavy-tests-missing-timeout.test.js.
//
// NOTE: the scanner matches raw file text and does NOT exclude comments, so prose
// here must not spell out a spawn call whose first argument is an unprovisioned
// tool — describe the shape instead of quoting it. Teaching the scanner to skip
// comments was rejected: a comment-stripper that mis-parses a string or template
// literal would hide a REAL call site, and a false green is worse than this
// constraint on prose.
const AUDIT_SCRIPT = path.join(EXTENSION_ROOT, 'scripts/audit-subprocess-heavy-tests.sh');

function unprovisionedFixture(argv0, marker) {
  const CALL = 'spawnSync';
  return [
    '// @tier: fast',
    "import { spawnSync } from 'node:child_process';",
    'export function run(cwd) {',
    ...(marker ? [`  ${marker}`] : []),
    `  return ${CALL}(${argv0}, { cwd, encoding: 'utf-8', timeout: 30000 });`,
    '}',
    '',
  ].join('\n');
}

function runAuditOnScanRoot(scanRoot) {
  // timeout exceeds SUBPROCESS_HEAVY_WARN_MS (15000) so this spawn is not itself
  // a subprocess-heavy candidate of the audit it invokes.
  return spawnSync('bash', [AUDIT_SCRIPT, '--scan-root', scanRoot], {
    encoding: 'utf-8',
    timeout: 30000,
  });
}

// The exemplar is `jq`, NOT ripgrep. ripgrep used to be the exemplar, but ci.yml and
// release.yml both install it (commit 29b4ecc9), so asserting it reds would pin a
// premise that is false at HEAD. `jq` is in NON_GUARANTEED_TOOLS and no workflow
// installs it — verified by the derivation test below, not assumed here.
test('mega bundle audit reds a test that spawns an unprovisioned binary', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unprovisioned-scan-root-')));
  try {
    // 1. Spawning an unprovisioned tool fails the audit and names it.
    const fixture = path.join(dir, 'spawns-unprovisioned.test.js');
    fs.writeFileSync(fixture, unprovisionedFixture("'jq', ['-r', '.version']", ''));
    const red = runAuditOnScanRoot(dir);
    assert.notEqual(red.status, 0, `expected non-zero exit; stderr=${red.stderr}`);
    assert.match(red.stderr, /spawns unprovisioned binary 'jq'/);

    // 2. Removing the dependency turns the same scan root green — this is the
    //    mutation half: the audit reacts to the spawn, not to the fixture's mere
    //    existence.
    fs.writeFileSync(fixture, unprovisionedFixture("'git', ['status']", ''));
    const green = runAuditOnScanRoot(dir);
    assert.equal(green.status, 0, `expected exit 0 after removing the dependency; stderr=${green.stderr}`);

    // 3. A guarded call site opts out explicitly via the PROVISIONED-OK marker.
    fs.writeFileSync(
      fixture,
      unprovisionedFixture("'jq', ['-r', '.version']", '// PROVISIONED-OK: guarded by a which() probe'),
    );
    const allowed = runAuditOnScanRoot(dir);
    assert.equal(allowed.status, 0, `expected exit 0 for an allowlisted site; stderr=${allowed.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the provisioned set is DERIVED from the workflows, not mirrored ---------------
//
// These three tests are the ticket's actual property. The predicate above only shows
// the audit reacts to a spawn; it says nothing about where "provisioned" comes from.
// A hardcoded list would pass every assertion above and fail the pair below.

const UNPROVISIONED_SCANNER = path.join(EXTENSION_ROOT, 'scripts/audit-unprovisioned-binary-spawns.mjs');

// A workflow with one install step. `withRipgrep` controls ONLY that step, so the two
// derivations differ by exactly the thing under test.
function workflowFixture(dir, { withRipgrep }) {
  fs.mkdirSync(dir, { recursive: true });
  const install = withRipgrep
    ? [
      '      - name: Install ripgrep',
      // The backticked binary name is how a package name is bridged to the binary it
      // provides; this mirrors the real ci.yml step's own comment.
      '        # audit-trap-door-enforcement.sh shells out to `rg`.',
      '        run: sudo apt-get update && sudo apt-get install -y ripgrep',
    ]
    : [];
  fs.writeFileSync(
    path.join(dir, 'ci.yml'),
    [
      'name: CI',
      'jobs:',
      '  build:',
      '    steps:',
      ...install,
      // Negative control: a NON-install step that backticks a tool name. The
      // derivation must not read this as provisioning — only install steps declare.
      '      - name: Test',
      '        # this project also works with `bat` if you have it',
      '        run: npm test',
      '',
    ].join('\n'),
  );
  return dir;
}

test('unprovisioned-binary audit derives the provisioned set from the workflows', async () => {
  const { deriveProvisionedTools } = await import(pathToFileURL(UNPROVISIONED_SCANNER).href);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'provisioned-derive-')));
  try {
    // Direction A — the step is present: the package AND the binary it provides are
    // both derived as provisioned.
    const withStep = deriveProvisionedTools(workflowFixture(path.join(root, 'with'), { withRipgrep: true }));
    assert.equal(withStep.has('ripgrep'), true, 'package token should be derived');
    assert.equal(withStep.has('rg'), true, 'binary named in the install step should be derived');

    // Direction B — the ONLY change is deleting that step, and the tool stops being
    // provisioned. This is the half a hardcoded mirror cannot pass.
    const withoutStep = deriveProvisionedTools(workflowFixture(path.join(root, 'without'), { withRipgrep: false }));
    assert.equal(withoutStep.has('ripgrep'), false, 'removing the step must un-provision the package');
    assert.equal(withoutStep.has('rg'), false, 'removing the step must un-provision the binary');

    // A tool no step installs is never provisioned, in either direction.
    assert.equal(withStep.has('jq'), false);

    // The negative control, ASSERTED rather than merely described: both fixtures
    // carry a NON-install step whose comment backticks `bat`. Clause 2 must stay
    // scoped to steps that actually install, because `bat` is itself a candidate in
    // NON_GUARANTEED_TOOLS — so reading backticks file-wide would let a passing
    // mention in unrelated prose mark it provisioned and silently green-light a real
    // bat dependency. Measured: without these two lines, widening clause 2 to every
    // block leaves the whole file green.
    assert.equal(withStep.has('bat'), false, 'a backticked tool in a NON-install step must not count as provisioned');
    assert.equal(withoutStep.has('bat'), false, 'and must not, with no install step present at all');

    // Fail-closed: an unreadable workflows dir provisions nothing, so every candidate
    // stays a candidate. Degrading toward more findings, never fewer.
    assert.equal(deriveProvisionedTools(path.join(root, 'does-not-exist')).size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unprovisioned-binary audit reads the real workflows, and they still provision ripgrep', async () => {
  const mod = await import(pathToFileURL(UNPROVISIONED_SCANNER).href);
  const provisioned = mod.deriveProvisionedTools(mod.defaultWorkflowsDir(EXTENSION_ROOT));
  // A tripwire, not decoration: audit-trap-door-enforcement.sh shells out to ripgrep
  // independently of the tests, so dropping the workflow install step must not pass
  // silently. If this reds, the workflows changed — that is the signal, not a flake.
  assert.equal(provisioned.has('ripgrep'), true, 'ci.yml/release.yml must still install ripgrep');
  assert.equal(provisioned.has('rg'), true, 'the install step must still name the binary it provides');
  assert.equal(provisioned.has('jq'), false, 'no workflow installs jq — the red exemplar above depends on this');
});

// The ticket's acceptance property, stated mechanically over the real corpus:
//   (binaries spawned by tests) MINUS (binaries provisioned by the workflows) = {}
test('no test in the repo spawns a binary the workflows do not provision', async () => {
  const mod = await import(pathToFileURL(UNPROVISIONED_SCANNER).href);
  const matchers = mod.buildMatchers(mod.deriveProvisionedTools(mod.defaultWorkflowsDir(EXTENSION_ROOT)));

  const testsRoot = path.join(EXTENSION_ROOT, 'tests');
  const files = fs
    .readdirSync(testsRoot, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.test.js'))
    .map(e => path.join(e.parentPath, e.name));

  // Without this, an empty file list would make the assertion below vacuously true —
  // the scan would report nothing because it scanned nothing.
  assert.ok(files.length > 100, `expected the real test corpus, got ${files.length} files`);

  const findings = files.flatMap(f => mod.scanFile(f, EXTENSION_ROOT, matchers));
  assert.deepEqual(
    findings.map(f => `${f.rel}:${f.lineNo} spawns ${f.tool}`),
    [],
    'a test spawns a binary the workflows do not install; it will ENOENT in CI',
  );
});
