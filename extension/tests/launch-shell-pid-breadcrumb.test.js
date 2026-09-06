// @tier: fast
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const COMMANDS_REL = path.join('.claude', 'commands');
const COMMANDS_DIR = path.join(repoRoot, COMMANDS_REL);

// Loose marker for DISCOVERY; `extractLaunchScript` below applies the strict shape and asserts.
// The split is deliberate: a command that emits a launch.sh the extractor cannot parse must FAIL
// here rather than be silently dropped from the derived set.
const LAUNCH_HEREDOC_MARKER = `/launch.sh" <<'LAUNCH_EOF'`;

// The token a slash-command renderer substitutes into a positional. Field-observed as
// `SESSION_ROOT="--refine"` across three live launches (gh-9).
const RENDER_POISON = '--refine';

// Derived from the command directory, never a hardcoded name list: a mirror of five names drifts
// silently the moment a sixth launcher is added or one is renamed.
function discoverLaunchEmitters() {
  const emitters = fs
    .readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .filter((name) => fs.readFileSync(path.join(COMMANDS_DIR, name), 'utf8').includes(LAUNCH_HEREDOC_MARKER));
  assert.ok(
    emitters.length > 0,
    `no launch.sh emitters discovered under ${COMMANDS_DIR} — an empty derived set would register ` +
      `zero tests and read green; check LAUNCH_HEREDOC_MARKER against the command templates`,
  );
  return emitters.map((name) => path.join(COMMANDS_REL, name));
}

const LAUNCH_EMITTERS = discoverLaunchEmitters();

// Models the render-time substitution that corrupts the template: positional tokens and
// `$ARGUMENTS` are replaced BEFORE the model writes the file, so single-quoting the heredoc
// cannot defend against it. A template free of such tokens renders to itself.
function simulateArgumentRendering(text) {
  return text.replace(/\$ARGUMENTS\b/g, RENDER_POISON).replace(/\$\{?[1-9]\}?/g, RENDER_POISON);
}

function makeTmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-launch-shell-pid-')));
}

function extractLaunchScript(markdownPath) {
  const markdown = fs.readFileSync(markdownPath, 'utf8');
  const match = markdown.match(/cat > "\$\{SESSION_ROOT\}\/launch\.sh" <<'LAUNCH_EOF'\n([\s\S]*?)\nLAUNCH_EOF/);
  assert.ok(match, `launch.sh heredoc missing from ${markdownPath}`);
  return match[1];
}

function writeNodeStub(binDir, argvLogPath) {
  const stubPath = path.join(binDir, 'node');
  fs.writeFileSync(
    stubPath,
    [
      '#!/bin/bash',
      `printf "%s\\n" "$*" >> "${argvLogPath}"`,
      'if [ "$1" = "--input-type=module" ]; then',
      `  exec "${process.execPath}" "$@"`,
      'fi',
      'if [[ "$1" == *"read-microverse.js" ]]; then',
      '  echo 0',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  fs.chmodSync(stubPath, 0o755);
}

// Writes the emitted script to <root>/launch.sh — the location the emitter itself uses — and runs
// it with `extraArgs` appended, returning the resulting state plus every node invocation it made.
function runEmittedLaunchScript(scriptBody, extraArgs) {
  const tmpRoot = makeTmpDir();
  try {
    const sessionRoot = path.join(tmpRoot, 'session');
    const binDir = path.join(tmpRoot, 'bin');
    fs.mkdirSync(sessionRoot, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const argvLogPath = path.join(tmpRoot, 'node-argv.log');
    writeNodeStub(binDir, argvLogPath);

    const statePath = path.join(sessionRoot, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ active: true, session_dir: sessionRoot }, null, 2));

    const launchScriptPath = path.join(sessionRoot, 'launch.sh');
    fs.writeFileSync(launchScriptPath, scriptBody);
    fs.chmodSync(launchScriptPath, 0o755);

    const result = spawnSync('bash', [launchScriptPath, ...extraArgs], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` },
      encoding: 'utf8',
      input: '\n',
      timeout: 30_000,
    });

    return {
      result,
      sessionRoot,
      state: JSON.parse(fs.readFileSync(statePath, 'utf8')),
      invocations: fs.existsSync(argvLogPath)
        ? fs.readFileSync(argvLogPath, 'utf8').split('\n').filter(Boolean)
        : [],
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// `plain` is the production invocation. `rendered` reproduces gh-9: the template is passed through
// argument substitution AND the launcher forwards a stray trailing flag. Both must resolve the
// real session root — the emitted script must not depend on a caller-supplied positional at all.
const SCENARIOS = [
  { name: 'plain invocation', render: false, extraArgs: [] },
  { name: 'substituted template + trailing flag', render: true, extraArgs: [RENDER_POISON] },
];

describe('launch.sh templates resolve their own session root', () => {
  for (const relPath of LAUNCH_EMITTERS) {
    test(`${relPath} emits no renderer-substitutable positional`, () => {
      const body = extractLaunchScript(path.join(repoRoot, relPath));
      assert.equal(
        simulateArgumentRendering(body),
        body,
        `${relPath}: the emitted launch.sh contains a positional or $ARGUMENTS token. Command-argument ` +
          `substitution rewrites it before the file is written (field-observed: SESSION_ROOT="--refine"), ` +
          `and the single-quoted heredoc cannot prevent it. Derive the session root from the script's own ` +
          `location instead of accepting one from the caller.`,
      );
    });

    for (const scenario of SCENARIOS) {
      test(`${relPath} resolves the real session root — ${scenario.name}`, () => {
        const body = extractLaunchScript(path.join(repoRoot, relPath));
        const scriptBody = scenario.render ? simulateArgumentRendering(body) : body;
        const { result, sessionRoot, state, invocations } = runEmittedLaunchScript(scriptBody, scenario.extraArgs);
        const where = `${relPath} [${scenario.name}]`;

        assert.equal(result.status, 0, `${where}: launch.sh must exit cleanly: ${result.stderr}`);

        // The breadcrumb write resolves ${SESSION_ROOT}/state.json. A wrong root fails silently —
        // the inline writer's own catch {} and trailing `|| true` keep the exit status 0 — so the
        // written state is the only evidence that the root was correct.
        assert.equal(typeof state.launch_shell_pid, 'number', `${where}: launch_shell_pid missing`);
        assert.ok(state.launch_shell_pid > 0, `${where}: launch_shell_pid must be positive`);

        // The runner handoff must carry the same real root.
        const runnerCalls = invocations.filter((line) => /-runner\.js/.test(line));
        assert.ok(runnerCalls.length > 0, `${where}: no *-runner.js invocation recorded`);
        for (const call of runnerCalls) {
          assert.ok(call.includes(sessionRoot), `${where}: runner invoked with wrong session root: ${call}`);
        }

        for (const call of invocations) {
          assert.ok(
            !call.includes(RENDER_POISON),
            `${where}: substituted token leaked into a downstream invocation: ${call}`,
          );
        }
      });
    }
  }
});
