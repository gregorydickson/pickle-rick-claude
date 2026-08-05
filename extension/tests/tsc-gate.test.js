// @tier: integration
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const it = test;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDLER = path.resolve(__dirname, '../hooks/handlers/tsc-gate.js');
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/tsc-gate');
const REPLAY_PATCH = path.resolve(__dirname, 'fixtures/tsc-gate-replay-7d44f22d.patch');

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 5_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test.invalid',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  }
  return (result.stdout || '').trim();
}

function writeExtensionSentinel(extensionDir) {
  const sentinelDir = path.join(extensionDir, 'extension', 'bin');
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.writeFileSync(path.join(sentinelDir, 'log-watcher.js'), '');
}

function resolveGitBinary() {
  const result = spawnSync('bash', ['-lc', 'command -v git'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.status !== 0) {
    throw new Error(`failed to resolve git binary: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function createGitShim(shimDir) {
  const shimPath = path.join(shimDir, 'git');
  const realGit = resolveGitBinary();
  const script = `#!/usr/bin/env bash
set -e

if [ "$1" = "checkout-index" ]; then
  shift
  args=()
  for arg in "$@"; do
    if [ "$arg" = "--stage=0" ]; then
      continue
    fi
    args+=("$arg")
  done
  exec "${realGit}" checkout-index "\${args[@]}"
fi

exec "${realGit}" "$@"
`;
  fs.writeFileSync(shimPath, script);
  fs.chmodSync(shimPath, 0o755);
}

function createNpxShim(shimDir) {
  const shimPath = path.join(shimDir, 'npx');
  const script = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    out.push(full);
  }
  return out;
}

const args = process.argv.slice(2);
if (args[0] !== 'tsc' || args[1] !== '--noEmit') {
  process.exit(0);
}

const mode = process.env.TSC_GATE_NPX_MODE || 'scan';
const sleepMs = Number(process.env.TSC_GATE_SLEEP_MS || '2500');

if (mode === 'timeout-output') {
  process.stderr.write('warming tsc cache...\\n');
  setTimeout(() => process.exit(0), sleepMs);
} else if (mode === 'timeout-silent') {
  setTimeout(() => process.exit(0), sleepMs);
} else if (mode === 'setup-error') {
  process.stderr.write('simulated npx setup error\\n');
  process.exit(1);
} else {
  const files = walk(process.cwd()).filter((file) => /\\.(?:[cm]?ts|tsx)$/.test(file));
  const broken = files.some((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return text.includes('resolveJudgeBackend') || text.includes('getMicroverseSettings');
  });

  if (broken) {
    process.stderr.write("error TS2305: Module './nonexistent.js' has no exported member 'resolveJudgeBackend'.\\n");
    process.exit(2);
  }

  process.exit(0);
}
`;
  fs.writeFileSync(shimPath, script);
  fs.chmodSync(shimPath, 0o755);
}

function makeHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-gate-harness-'));
  const extensionDir = path.join(root, 'extension-root');
  const dataRoot = path.join(root, 'data-root');
  const shimDir = path.join(root, 'bin');
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  writeExtensionSentinel(extensionDir);
  createGitShim(shimDir);
  createNpxShim(shimDir);
  return {
    root,
    extensionDir,
    dataRoot,
    shimDir,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function makeRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-gate-repo-'));
  git(['init', '-q', '-b', 'main'], repoRoot);
  git(['config', 'commit.gpgsign', 'false'], repoRoot);
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# test\n');
  fs.writeFileSync(path.join(repoRoot, 'src', 'entry.ts'), 'export const seedValue = 0;\n');
  git(['add', '.'], repoRoot);
  git(['commit', '-qm', 'initial'], repoRoot);
  return repoRoot;
}

function writeSession(harness, repoRoot, stateOverrides = {}) {
  const sessionDir = path.join(harness.dataRoot, 'sessions', 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  const stateFile = path.join(sessionDir, 'state.json');
  const state = {
    active: true,
    working_dir: repoRoot,
    step: 'implement',
    iteration: 1,
    max_iterations: 5,
    max_time_minutes: 60,
    worker_timeout_seconds: 1200,
    start_time_epoch: Math.floor(Date.now() / 1000) - 30,
    completion_promise: null,
    original_prompt: 'test task',
    current_ticket: 'test-ticket',
    history: [],
    started_at: new Date().toISOString(),
    session_dir: sessionDir,
    tmux_mode: false,
    flags: {},
    ...stateOverrides,
  };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  fs.writeFileSync(
    path.join(harness.dataRoot, 'current_sessions.json'),
    JSON.stringify({ [repoRoot]: sessionDir }, null, 2),
  );
  return { sessionDir, stateFile };
}

function readState(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

function readActivityEvents(harness) {
  const activityDir = path.join(harness.dataRoot, 'activity');
  if (!fs.existsSync(activityDir)) return [];
  const events = [];
  for (const entry of fs.readdirSync(activityDir).sort()) {
    const fullPath = path.join(activityDir, entry);
    const lines = fs.readFileSync(fullPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      events.push(JSON.parse(line));
    }
  }
  return events;
}

function runHandler({
  harness,
  repoRoot = process.cwd(),
  toolName = 'Bash',
  command = 'git commit -m test',
  extraEnv = {},
  timeout = 15_000,
} = {}) {
  const result = spawnSync(process.execPath, [HANDLER], {
    cwd: repoRoot,
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: 'utf-8',
    timeout,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NODE_ENV: 'test',
      EXTENSION_DIR_TEST: '1',
      EXTENSION_DIR: harness.extensionDir,
      PICKLE_DATA_ROOT: harness.dataRoot,
      PATH: `${harness.shimDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extraEnv,
    },
  });
  const lines = (result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const decision = lines.length > 0 ? JSON.parse(lines.at(-1)) : null;
  return { ...result, decision, events: readActivityEvents(harness) };
}

function writeFixture(repoRoot, fixtureName, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE_DIR, fixtureName), destination);
}

function stageTrackedBrokenFile(repoRoot) {
  writeFixture(repoRoot, 'broken-import.ts', path.join(repoRoot, 'src', 'entry.ts'));
  git(['add', 'src/entry.ts'], repoRoot);
}

function stageTrackedCleanFile(repoRoot) {
  writeFixture(repoRoot, 'clean.ts', path.join(repoRoot, 'src', 'entry.ts'));
  git(['add', 'src/entry.ts'], repoRoot);
}

function stageAddedBrokenFile(repoRoot) {
  writeFixture(repoRoot, 'staged-addition.ts', path.join(repoRoot, 'src', 'staged-addition.ts'));
  git(['add', 'src/staged-addition.ts'], repoRoot);
}

function stageTimeoutConfig(repoRoot) {
  writeFixture(repoRoot, 'hang-tsconfig.json', path.join(repoRoot, 'tsconfig.json'));
  git(['add', 'tsconfig.json'], repoRoot);
}

function latestEvent(events, name) {
  return [...events].reverse().find((event) => event.event === name) ?? null;
}

function assertFailedEvent(event, kind) {
  assert.ok(event, `expected ${kind} failure event`);
  assert.equal(event.event, 'tsc_gate_failed');
  assert.equal(event.gate_payload?.failure_kind, kind);
}

it('approves non-Bash tool calls without invoking the gate', () => {
  const harness = makeHarness();
  try {
    const result = runHandler({ harness, toolName: 'Read', command: 'git commit -m ignored' });
    assert.equal(result.status, 0);
    assert.deepStrictEqual(result.decision, { decision: 'approve' });
    assert.equal(result.events.length, 0);
  } finally {
    harness.cleanup();
  }
});

it('approves non-commit Bash commands without invoking the gate', () => {
  const harness = makeHarness();
  try {
    const commands = [
      'git log --oneline -1',
      'git diff --cached',
      'git show HEAD~1',
      'git rev-parse HEAD',
      'gh pr create',
      'gh pr merge --auto',
    ];
    const before = readActivityEvents(harness).length;
    for (const command of commands) {
      const result = runHandler({ harness, command });
      assert.equal(result.status, 0, command);
      assert.deepStrictEqual(result.decision, { decision: 'approve' }, command);
    }
    assert.equal(readActivityEvents(harness).length, before);
  } finally {
    harness.cleanup();
  }
});

it('blocks broken staged tracked TypeScript across supported git commit command forms', () => {
  const harness = makeHarness();
  const repoRoot = makeRepo();
  try {
    writeSession(harness, repoRoot);
    stageTrackedBrokenFile(repoRoot);
    const commands = [
      'git commit -m "broken"',
      'git commit --amend --no-edit',
      'git -c user.name=test -c user.email=test@test.invalid commit -m "broken"',
      'git -C . commit -m "broken"',
      'git --git-dir=.git --work-tree=. commit -m "broken"',
      'cd . && git commit -m "broken"',
      'cd "."; git commit -m "broken"',
      'cd "./" && git -c core.hooksPath=.git/hooks commit -m "broken"',
      // Chained add+commit — the CLAUDE.md-canonical commit form (pickle-microverse.md,
      // meeseeks.md). Previously isGitCommitCommand saw subcommand `add` and SKIPPED
      // the tsc gate, letting broken-TS commits slip the R-WACT backstop.
      'git add -A && git commit -m "broken"',
      'git add -u && git commit -m "broken"',
      'cd . && git add -A && git commit -m "broken"',
      'git status; git commit -m "broken"',
    ];

    for (const command of commands) {
      const before = readActivityEvents(harness).length;
      const result = runHandler({ harness, repoRoot, command });
      assert.equal(result.status, 0, command);
      assert.equal(result.decision?.decision, 'block', command);
      assert.match(result.decision?.reason ?? '', /^R-WACT: tsc --noEmit failed with compile_error:/, command);
      const newEvents = readActivityEvents(harness).slice(before);
      assertFailedEvent(latestEvent(newEvents, 'tsc_gate_failed'), 'compile_error');
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    harness.cleanup();
  }
});

it('isGitCommitCommand detects commit in any chained segment without false positives', async () => {
  const { isGitCommitCommand } = await import('../hooks/handlers/tsc-gate.js');
  const positives = [
    'git add -A && git commit -m "x"',
    'git add -u && git commit -m "x"',
    'cd extension && git add -A && git commit -m "x"',
    'git status; git commit -m "x"',
    'git status;git commit -m "x"',
    'git add . || git commit -m "x"',
  ];
  for (const command of positives) {
    assert.equal(isGitCommitCommand(command), true, command);
  }
  const negatives = [
    'git add -A && echo done',
    'git status && git log --oneline',
    'git diff --cached && git show HEAD',
    'echo "git commit" && ls',
    // Separators inside the commit message must not be mis-segmented, but the
    // command is still a commit, so it MUST be detected.
  ];
  for (const command of negatives) {
    assert.equal(isGitCommitCommand(command), false, command);
  }
  // Quote-awareness: a commit message containing `&&`/`;` is one commit, detected.
  assert.equal(isGitCommitCommand('git commit -m "fix && reset bug"'), true);
  assert.equal(isGitCommitCommand('git commit -m "cleanup; done"'), true);
});

it('isGitCommitCommand detects commit behind arg-consuming git global options', async () => {
  const { isGitCommitCommand } = await import('../hooks/handlers/tsc-gate.js');
  // Each arg-consuming global option (`-C`, `-c`, `--git-dir`, `--work-tree`,
  // `--namespace`, `--super-prefix`, `--exec-path`) consumes its value token in
  // space form; the value must NOT be read as the subcommand. Before the parity
  // fix `--namespace ns commit`, `--super-prefix sp/ commit`, and
  // `--exec-path /p commit` read the value as the subcommand and were classified
  // non-commit, SKIPPING the R-WACT tsc gate for a real broken-TS commit.
  const positives = [
    'git -C . commit -m "x"',
    'git -c user.name=t commit -m "x"',
    'git --git-dir .git commit -m "x"',
    'git --work-tree . commit -m "x"',
    'git --namespace ns commit -m "x"',
    'git --super-prefix sp/ commit -m "x"',
    'git --exec-path /p commit -m "x"',
    'git --exec-path=/p commit -m "x"',
    'git --namespace=ns commit -m "x"',
    'git --super-prefix=sp/ commit -m "x"',
    'git --exec-path /p --namespace ns commit -m "x"',
    'cd extension && git --exec-path /p commit -m "x"',
  ];
  for (const command of positives) {
    assert.equal(isGitCommitCommand(command), true, command);
  }
  // The consumed VALUE token must never be promoted to the subcommand: a global
  // option whose value is `log`/`diff` must not flip the command to non-commit,
  // and a non-commit verb behind the option stays non-commit.
  const negatives = [
    'git --namespace log status',
    'git --exec-path /p log --oneline',
  ];
  for (const command of negatives) {
    assert.equal(isGitCommitCommand(command), false, command);
  }
});

it('isGitCommitCommand detects commit behind non-arg-consuming git global boolean flags', async () => {
  const { isGitCommitCommand } = await import('../hooks/handlers/tsc-gate.js');
  // A git global BOOLEAN option (`--no-pager`, `-p`, `--paginate`,
  // `--no-optional-locks`, `--bare`, …) consumes no value. Before the parity fix
  // segmentIsGitCommit skipped only the arg-consuming options + `=`-glued forms,
  // so any other leading flag fell through to `=== 'commit'`, was mistaken for the
  // subcommand, and `git --no-pager commit` was classified non-commit — SKIPPING
  // the R-WACT tsc gate for a real broken-TS commit. findGitVerb (config-protection)
  // skips ALL `-`-prefixed flags; this closes the one-sided parity gap.
  const positives = [
    'git --no-pager commit -m "x"',
    'git -p commit -m "x"',
    'git --paginate commit -m "x"',
    'git --no-optional-locks commit -m "x"',
    'git --bare commit -m "x"',
    'git --no-pager -c user.name=t commit -m "x"',
    'git -p --namespace ns commit -m "x"',
    'git add -A && git --no-pager commit -m "x"',
    'cd extension && git --no-pager commit -m "x"',
    'git add -A\ngit --no-pager commit -m "x"',
  ];
  for (const command of positives) {
    assert.equal(isGitCommitCommand(command), true, command);
  }
  // A boolean flag before a non-commit subcommand stays non-commit (the flag is
  // skipped, the real subcommand is read).
  const negatives = [
    'git --no-pager log --oneline',
    'git -p status',
    'git --no-optional-locks diff --cached',
  ];
  for (const command of negatives) {
    assert.equal(isGitCommitCommand(command), false, command);
  }
});

it('isGitCommitCommand detects commit behind leading env-var assignments', async () => {
  const { isGitCommitCommand } = await import('../hooks/handlers/tsc-gate.js');
  // A worker may emit an env-var-prefixed git command (`GIT_COMMITTER_DATE=… git
  // commit`, a real git idiom). Before the parity fix segmentIsGitCommit read the
  // assignment token as tokens[0], failed the `=== 'git'` check, classified the
  // segment non-commit, and SKIPPED the R-WACT tsc gate for a real broken-TS
  // commit. config-protection.ts:findGitVerb/parseFirstShellWord already skip
  // leading `NAME=value` tokens (it catches `GIT_DIR=x git reset`); this closes
  // the one-sided sibling-parity gap.
  const positives = [
    'GIT_COMMITTER_DATE=2020-01-01T00:00:00 git commit -m "x"',
    'GIT_AUTHOR_DATE=2020-01-01 git commit -m "x"',
    'GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@x git commit -m "x"',
    'GIT_COMMITTER_DATE=2020-01-01 git --no-pager commit -m "x"',
    'GIT_COMMITTER_DATE=2020-01-01 git -C extension commit -m "x"',
    'git add -A && GIT_AUTHOR_DATE=2020-01-01 git commit -m "x"',
    'cd extension && GIT_COMMITTER_DATE=2020 git commit -m "x"',
    'git add -A\nGIT_AUTHOR_DATE=2020-01-01 git commit -m "x"',
  ];
  for (const command of positives) {
    assert.equal(isGitCommitCommand(command), true, JSON.stringify(command));
  }
  // An env-prefixed non-commit subcommand stays non-commit (prefix skipped, real
  // subcommand read).
  const negatives = [
    'GIT_AUTHOR_DATE=2020-01-01 git log --oneline',
    'GIT_COMMITTER_DATE=2020 git status',
  ];
  for (const command of negatives) {
    assert.equal(isGitCommitCommand(command), false, JSON.stringify(command));
  }
});

it('AP-EXT-EXECFOLD isGitCommitCommand folds the executable token case and path', async () => {
  const { isGitCommitCommand } = await import('../hooks/handlers/tsc-gate.js');
  // On a case-insensitive filesystem (macOS/APFS, Windows) `GIT commit` really
  // runs git — `GIT --version` prints the git version. Before this fix
  // segmentIsGitCommit compared the raw token (`tokens[gitIdx] !== 'git'`), so
  // every variant below classified NON-commit and skipped the R-WACT tsc gate
  // entirely at tsc-gate.ts's `!isGitCommitCommand(command) -> approve()`,
  // letting a worker land broken TypeScript. config-protection.ts already
  // folded through execName (it blocks `GIT reset --hard`); this closes the
  // remaining half of that parity pair.
  const positives = [
    'GIT commit -m "x"',
    'Git commit -m "x"',
    '/usr/bin/git commit -m "x"',
    'GIT_AUTHOR_DATE=2020-01-01 GIT commit -m "x"',
    'cd extension && GIT commit -m "x"',
    'git add -A\n/usr/bin/git commit -m "x"',
    'GIT --no-pager commit -m "x"',
    'GIT -C extension commit -m "x"',
  ];
  for (const command of positives) {
    assert.equal(isGitCommitCommand(command), true, JSON.stringify(command));
  }
  // The fold must not widen what counts as a commit: `gh` stays excluded in any
  // case, and a folded non-commit subcommand stays non-commit.
  const negatives = [
    'GH pr create --fill',
    'gh pr create --fill',
    'GIT log --oneline',
    '/usr/bin/git status',
    'GITHUB_TOKEN=x GIT status',
  ];
  for (const command of negatives) {
    assert.equal(isGitCommitCommand(command), false, JSON.stringify(command));
  }
});

it('AP-EXT-ITER12-01 isGitCommitCommand sees a commit inside a bash -c payload', async () => {
  const { isGitCommitCommand } = await import('../hooks/handlers/tsc-gate.js');
  // The quote-preserving tokenizer keeps `"git commit -m x"` as ONE token, so
  // the only executable segmentIsGitCommit ever saw was the `-c` FLAG: execName
  // read `bash`, classified non-commit, and main() approved WITHOUT running the
  // R-WACT tsc check. Every form below was proven SKIPPED pre-fix while its bare
  // twin gated. config-protection.ts closed this at its own seam
  // (AP-EXT-ITER10-01); tsc-gate carried a private near-identical segmenter and
  // did not inherit it — both now consume shell-exec.ts:splitShellSegments.
  const positives = [
    'bash -c "git commit -m x"',
    "bash -c 'git commit -m x'",
    'bash -lc "git commit -m x"',
    'sh -c "git add -A && git commit -m x"',
    '/bin/bash -c "git commit -m x"',
    'cd extension && bash -c "git commit -m x"',
    'GIT_COMMITTER_DATE=2020 bash -c "git commit -m x"',
    // Unescaped nesting proves the recursion is live, not a one-level unwrap.
    'bash -c \'bash -c "git commit -m x"\'',
  ];
  for (const command of positives) {
    assert.equal(isGitCommitCommand(command), true, JSON.stringify(command));
  }
  // The unwrap must not widen what counts as a commit: a non-commit payload
  // stays non-commit, `bash install.sh` (no `-c`) is untouched, and a `-c`-like
  // string INSIDE a commit message is a quoted argument, not a payload.
  const negatives = [
    'bash -c "git log --oneline"',
    'bash -c "npm test"',
    'bash -c "git status"',
    'bash install.sh',
    'sh -c "gh pr create --fill"',
  ];
  for (const command of negatives) {
    assert.equal(isGitCommitCommand(command), false, JSON.stringify(command));
  }
});

it('AP-EXT-ITER14-01 isGitCommitCommand sees a commit inside an ESCAPED-quote nest', async () => {
  const { isGitCommitCommand } = await import('../hooks/handlers/tsc-gate.js');
  // The residual both ITER10-01 and ITER12-01 cataloged and deferred. The
  // quoted-span pattern `"[^"]*"` stops at the first ESCAPED quote, so the
  // payload token desynchronized and the inner `git commit` never led a
  // segment: classified non-commit, R-WACT tsc gate SKIPPED, while the bare and
  // alternate-quoted twins both gated. Closed by making the double-quoted span
  // escape-aware and unescaping the token at the ONE shell-exec.ts seam.
  const positives = [
    'bash -c "bash -c \\"git commit -m x\\""',
    'sh -lc "bash -c \\"git commit -m x\\""',
    '/bin/bash -c "bash -c \\"git commit -m x\\""',
    'bash -c "cd extension && bash -c \\"git commit -m x\\""',
    // Deeper nesting proves the recursion, not a fixed two-level unwrap.
    'bash -c "bash -c \\"bash -c \\\\\\"git commit -m x\\\\\\"\\""',
  ];
  for (const command of positives) {
    assert.equal(isGitCommitCommand(command), true, JSON.stringify(command));
  }
  // The unwrap must not widen what counts as a commit. The second case is the
  // sharp one: pre-fix, the desync split the quoted argument apart, so a naive
  // implementation that merely looks for `git commit` anywhere still fails it.
  const negatives = [
    'bash -c "bash -c \\"git status\\""',
    'bash -c "echo \\"git commit -m x\\""',
    'bash -c "bash -c \\"npm test\\""',
    'git \\"commit\\" -m x',
  ];
  for (const command of negatives) {
    assert.equal(isGitCommitCommand(command), false, JSON.stringify(command));
  }
});

it('AP-EXT-ITER18-01 isGitCommitCommand sees a commit behind a GLUED operator', async () => {
  const { isGitCommitCommand } = await import('../hooks/handlers/tsc-gate.js');
  // Whitespace around a control operator is not required — bash runs
  // `git add -A&&git commit` exactly as its spaced twin (shim-verified). The
  // tokenizer split glued `;` and nothing else, so `&&`/`||`/`|`/`&` stayed
  // inside one `\S+` token, the segment's subcommand read `add`, and the R-WACT
  // tsc gate was SKIPPED for a broken-TS commit while the spaced twin gated.
  const positives = [
    'git add -A&&git commit -m x',
    'true&&git commit -m x',
    'git add -A||git commit -m x',
    'cd extension&&git commit -m x',
    'git add -A;git commit -m x',
    'git add -A&&git commit -m x&&npm test',
  ];
  for (const command of positives) {
    assert.equal(isGitCommitCommand(command), true, JSON.stringify(command));
  }
  // Splitting must not widen what counts as a commit: an operator inside quotes
  // is an argument, and `2>&1` is an fd-dup, not a background operator.
  const negatives = [
    'git add -A&&npm test',
    'git log --format=%s&&echo done',
    'echo "x&&git commit -m y"',
    'git status 2>&1',
  ];
  for (const command of negatives) {
    assert.equal(isGitCommitCommand(command), false, JSON.stringify(command));
  }
});

it('AP-EXT-ITER18-01 the glued-operator split is DERIVED from the separator set', async () => {
  const shellExec = fs.readFileSync(
    path.resolve(__dirname, '../src/hooks/shell-exec.ts'), 'utf8',
  );
  // The bug was a hardcoded `/(;)/` sitting beside a six-member separator set:
  // declaring an operator a separator did not make the tokenizer yield it as a
  // boundary. Pin the derivation, not just the behavior — a second hardcoded
  // character passes every case above while re-opening the next operator.
  assert.match(shellExec, /const GLUED_SEPARATOR_RE = new RegExp\(\s*`\(\$\{\[\.\.\.SHELL_SEGMENT_SEPARATORS\]/);
  assert.equal(/raw\.split\(\/\(;\)\/\)/.test(shellExec), false,
    'glued-operator split must not hardcode a single separator character');
});

it('AP-EXT-ITER12-01 the hooks segmenter has ONE home (no private tsc-gate copy)', async () => {
  const hooksDir = path.resolve(__dirname, '../src/hooks');
  const shellExec = fs.readFileSync(path.join(hooksDir, 'shell-exec.ts'), 'utf8');
  const tscGate = fs.readFileSync(path.join(hooksDir, 'handlers', 'tsc-gate.ts'), 'utf8');
  const configProtection = fs.readFileSync(path.join(hooksDir, 'handlers', 'config-protection.ts'), 'utf8');
  // The drift this closes was structural, not a missing branch: each handler
  // owned a private segmenter, so a fix landing in one silently skipped the
  // other. Pin the single definition rather than the behavior alone — behavior
  // tests pass again the moment someone re-forks the copy.
  assert.match(shellExec, /export function splitShellSegments\(/);
  for (const [name, source] of [['tsc-gate.ts', tscGate], ['config-protection.ts', configProtection]]) {
    assert.equal(
      /function splitShellSegments\(|function splitTopLevelSegments\(/.test(source),
      false,
      `${name} must consume shell-exec.ts:splitShellSegments, not define its own`,
    );
    assert.match(source, /splitShellSegments[\s\S]*from '\.\.\/shell-exec\.js'/);
  }
});

it('isGitCommitCommand segments on unquoted newlines (newline-separated add+commit)', async () => {
  const { isGitCommitCommand } = await import('../hooks/handlers/tsc-gate.js');
  // A worker naturally emits sequential commands one per line. Before the fix the
  // tokenizer swallowed the unquoted newline as whitespace, collapsing the lines
  // into one segment whose subcommand read `add`, so the gate was SKIPPED.
  const positives = [
    'git add -A\ngit commit -m "x"',
    'git add -u\ngit commit -m "x"',
    'cd extension\ngit add -A\ngit commit -m "x"',
    'git status\ngit commit -m "x"',
  ];
  for (const command of positives) {
    assert.equal(isGitCommitCommand(command), true, JSON.stringify(command));
  }
  const negatives = [
    'git add -A\necho done',
    'git status\ngit log --oneline',
  ];
  for (const command of negatives) {
    assert.equal(isGitCommitCommand(command), false, JSON.stringify(command));
  }
  // A newline INSIDE a quoted commit message stays one token, so a multi-line
  // commit body is a single commit segment, still detected — never mis-split.
  assert.equal(isGitCommitCommand('git commit -m "line1\nline2"'), true);
});

it('blocks broken staged tracked TypeScript across newline-separated git commit forms', () => {
  const harness = makeHarness();
  const repoRoot = makeRepo();
  try {
    writeSession(harness, repoRoot);
    stageTrackedBrokenFile(repoRoot);
    const commands = [
      'git add -A\ngit commit -m "broken"',
      'git add -u\ngit commit -m "broken"',
      'cd .\ngit add -A\ngit commit -m "broken"',
      'git status\ngit commit -m "broken"',
    ];

    for (const command of commands) {
      const before = readActivityEvents(harness).length;
      const result = runHandler({ harness, repoRoot, command });
      assert.equal(result.status, 0, command);
      assert.equal(result.decision?.decision, 'block', command);
      assert.match(result.decision?.reason ?? '', /^R-WACT: tsc --noEmit failed with compile_error:/, command);
      const newEvents = readActivityEvents(harness).slice(before);
      assertFailedEvent(latestEvent(newEvents, 'tsc_gate_failed'), 'compile_error');
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    harness.cleanup();
  }
});

it('approves clean staged TypeScript', () => {
  const harness = makeHarness();
  const repoRoot = makeRepo();
  try {
    writeSession(harness, repoRoot);
    stageTrackedCleanFile(repoRoot);
    const result = runHandler({ harness, repoRoot, command: 'git commit -m "clean"' });
    assert.equal(result.status, 0);
    assert.deepStrictEqual(result.decision, { decision: 'approve' });
    assert.equal(result.events.length, 0);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    harness.cleanup();
  }
});

it('blocks broken staged added files and keeps the full replay patch fixture while using a controlled replay baseline', () => {
  const harness = makeHarness();
  const repoRoot = makeRepo();
  try {
    writeSession(harness, repoRoot);
    stageAddedBrokenFile(repoRoot);
    const addedResult = runHandler({ harness, repoRoot, command: 'git commit -m "added file"' });
    assert.equal(addedResult.decision?.decision, 'block');
    assertFailedEvent(latestEvent(addedResult.events, 'tsc_gate_failed'), 'compile_error');

    git(['rm', '-f', 'src/staged-addition.ts'], repoRoot);

    const patchText = fs.readFileSync(REPLAY_PATCH, 'utf8');
    assert.match(patchText, /From 7d44f22d/i);
    const replayImport = patchText.match(/^\+import \{ .*resolveJudgeBackend.*getMicroverseSettings.*$/m);
    assert.ok(replayImport, 'replay patch keeps the broken import hunk');

    fs.mkdirSync(path.join(repoRoot, 'extension', 'src', 'bin'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'extension', 'src', 'bin', 'microverse-runner.ts'),
      'export const replayBaseline = true;\n',
    );
    git(['add', 'extension/src/bin/microverse-runner.ts'], repoRoot);

    const baselineResult = runHandler({ harness, repoRoot, command: 'git commit -m "baseline"' });
    assert.equal(baselineResult.decision?.decision, 'approve');

    fs.writeFileSync(
      path.join(repoRoot, 'extension', 'src', 'bin', 'microverse-runner.ts'),
      `${replayImport[0].slice(1)}\nexport const replayBaseline = true;\n`,
    );
    git(['add', 'extension/src/bin/microverse-runner.ts'], repoRoot);

    const replayResult = runHandler({ harness, repoRoot, command: 'git commit -m "replay"' });
    assert.equal(replayResult.decision?.decision, 'block');
    assertFailedEvent(latestEvent(replayResult.events, 'tsc_gate_failed'), 'compile_error');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    harness.cleanup();
  }
});

it('uses the override on failure and consumes it on the next clean gated commit', () => {
  const harness = makeHarness();
  const repoRoot = makeRepo();
  try {
    const { stateFile } = writeSession(harness, repoRoot, {
      flags: { allow_tsc_failed_reason: 'emergency revert' },
    });
    stageTrackedBrokenFile(repoRoot);

    const overrideResult = runHandler({ harness, repoRoot, command: 'git commit -m "override"' });
    assert.deepStrictEqual(overrideResult.decision, { decision: 'approve' });
    const overrideEvent = latestEvent(overrideResult.events, 'tsc_gate_override_used');
    assert.ok(overrideEvent);
    assert.equal(overrideEvent.gate_payload?.override_reason, 'emergency revert');
    assert.equal(overrideEvent.gate_payload?.failure_kind, 'compile_error');
    assert.equal(readState(stateFile).flags?.allow_tsc_failed_reason, 'emergency revert');

    stageTrackedCleanFile(repoRoot);
    const consumeResult = runHandler({ harness, repoRoot, command: 'git commit -m "clean"' });
    assert.deepStrictEqual(consumeResult.decision, { decision: 'approve' });
    const consumedEvent = latestEvent(consumeResult.events, 'tsc_gate_override_consumed');
    assert.ok(consumedEvent);
    assert.equal(consumedEvent.gate_payload?.override_reason, 'emergency revert');
    assert.equal(readState(stateFile).flags?.allow_tsc_failed_reason, undefined);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    harness.cleanup();
  }
});

it('blocks deterministic timeout cases using a shimmed npx and the actual configured timeout env', () => {
  const harness = makeHarness();
  const repoRoot = makeRepo();
  try {
    writeSession(harness, repoRoot);
    stageTimeoutConfig(repoRoot);
    const result = runHandler({
      harness,
      repoRoot,
      command: 'git commit -m "timeout"',
      timeout: 6_000,
      extraEnv: {
        PICKLE_DISPATCH_TIMEOUT_MS: '2000',
        TSC_GATE_NPX_MODE: 'timeout-output',
        TSC_GATE_SLEEP_MS: '2500',
      },
    });
    assert.equal(result.decision?.decision, 'block');
    assert.match(result.decision?.reason ?? '', /^R-WACT: tsc --noEmit failed with timeout:/);
    assertFailedEvent(latestEvent(result.events, 'tsc_gate_failed'), 'timeout');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    harness.cleanup();
  }
});

it('keeps non-trigger Bash approvals fast at the handler boundary', async () => {
  // The "handler boundary" is the predicate that decides whether tsc gating
  // applies. Spawning the full handler subprocess measures Node bootstrap
  // cost, not the predicate, so under load (CPU > 4) the p95 spikes into the
  // hundreds of ms regardless of how cheap the rejection path is. Measure
  // `isGitCommitCommand` directly — that IS the fast-path being asserted.
  const { isGitCommitCommand } = await import('../hooks/handlers/tsc-gate.js');
  const negativeCommands = [
    'ls -la',
    'git log --oneline -1',
    'git diff --cached',
    'git show HEAD~1',
    'git rev-parse HEAD',
    'gh pr create',
    'gh pr merge --auto',
    'npm test',
    'echo hello',
    'cd src && ls',
  ];
  const durations = [];
  for (let i = 0; i < 1000; i += 1) {
    const command = negativeCommands[i % negativeCommands.length];
    const started = performance.now();
    const matched = isGitCommitCommand(command);
    durations.push(performance.now() - started);
    assert.equal(matched, false, command);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  // 1ms is generous for in-process predicate eval (tokenize + a few checks);
  // typical observed values are <0.05ms. The threshold catches accidental IO
  // / subprocess / require() additions to the fast-rejection path.
  assert.ok(p95 <= 1, `expected predicate p95 <= 1ms, got ${p95.toFixed(3)}ms`);
});

it('AP-EXT-ITER19-01 isGitCommitCommand sees a commit inside a GROUPED command', async () => {
  const { isGitCommitCommand } = await import('../hooks/handlers/tsc-gate.js');
  // `(`, `)`, `{`, `}` and a backtick begin a command in bash just as `&&` does
  // (shim-verified). They were absent from SHELL_SEGMENT_SEPARATORS, so the
  // grouped form stayed one segment whose leading token was `(git` — folded by
  // execName to `(git`, matching nothing — and the R-WACT tsc gate was SKIPPED
  // for a broken-TS commit while the bare twin gated.
  const positives = [
    '(git commit -m x)',
    '$(git commit -m x)',
    '{ git commit -m x; }',
    '`git commit -m x`',
    '(git add -A; git commit -m x)',
    'cd extension && (git commit -m x)',
    'bash -c "(git commit -m x)"',
  ];
  for (const command of positives) {
    assert.equal(isGitCommitCommand(command), true, JSON.stringify(command));
  }
  // Segmenting on grouping delimiters must not widen what counts as a commit:
  // parens inside quotes are message text, and a format string is an argument.
  const negatives = [
    '(git add -A)',
    'git log --format=%(refname)',
    'echo "x (git commit -m y)"',
    'echo $(git rev-parse HEAD)',
    'cp {a,b} dst',
  ];
  for (const command of negatives) {
    assert.equal(isGitCommitCommand(command), false, JSON.stringify(command));
  }
});

it('AP-EXT-ITER19-01 grouping delimiters are declared in the ONE separator set', async () => {
  const shellExec = fs.readFileSync(
    path.resolve(__dirname, '../src/hooks/shell-exec.ts'), 'utf8',
  );
  // Pin the declaration, not just the behavior. ITER18 made the split derive
  // from SHELL_SEGMENT_SEPARATORS precisely so that declaring an operator is
  // what makes it a boundary — a fix that instead bolted a second hardcoded
  // regex onto splitShellSegments would pass every case above while re-opening
  // the next delimiter, which is the pathology this seam exists to prevent.
  const setBody = shellExec.match(
    /const SHELL_SEGMENT_SEPARATORS = new Set\(\[([\s\S]*?)\]\)/,
  );
  assert.ok(setBody, 'SHELL_SEGMENT_SEPARATORS must remain a single declarative Set literal');
  for (const delimiter of ['(', ')', '{', '}', '`']) {
    assert.ok(
      setBody[1].includes(`'${delimiter}'`),
      `SHELL_SEGMENT_SEPARATORS must declare ${delimiter} — bash starts a command there`,
    );
  }
});
