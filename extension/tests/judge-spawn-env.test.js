// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  isNestedClaude,
  buildJudgeEnv,
  getJudgeEnvForAttempt,
  cleanupJudgeRuntimeDir,
} from '../services/judge-spawn-env.js';
import { execFileSync } from 'node:child_process';
import { backendEnvOverrides, buildJudgeInvocation } from '../services/backend-spawn.js';
import { runCorrectCourse } from '../bin/correct-course.js';

// ---------------------------------------------------------------------------
// isNestedClaude
// ---------------------------------------------------------------------------

test('isNestedClaude: returns true when CLAUDE_CODE is set', () => {
  assert.strictEqual(isNestedClaude({ CLAUDE_CODE: '1' }), true);
});

test('isNestedClaude: returns true when CLAUDECODE is set', () => {
  assert.strictEqual(isNestedClaude({ CLAUDECODE: '1' }), true);
});

test('isNestedClaude: returns true when both CLAUDE_CODE and CLAUDECODE are set', () => {
  assert.strictEqual(isNestedClaude({ CLAUDE_CODE: '1', CLAUDECODE: '1' }), true);
});

test('isNestedClaude: returns false when neither is set', () => {
  assert.strictEqual(isNestedClaude({ PATH: '/usr/bin', HOME: '/home/user' }), false);
});

test('isNestedClaude: returns false for empty env', () => {
  assert.strictEqual(isNestedClaude({}), false);
});

// ---------------------------------------------------------------------------
// buildJudgeEnv — nested claude path
// ---------------------------------------------------------------------------

test('buildJudgeEnv(claude, true): strips CLAUDE_CODE', () => {
  const env = buildJudgeEnv('claude', true, { CLAUDE_CODE: '1', PATH: '/usr/bin' });
  assert.strictEqual(env['CLAUDE_CODE'], undefined);
  assert.strictEqual(env['PATH'], '/usr/bin');
});

test('buildJudgeEnv(claude, true): strips CLAUDECODE', () => {
  const env = buildJudgeEnv('claude', true, { CLAUDECODE: '1', HOME: '/home/user' });
  assert.strictEqual(env['CLAUDECODE'], undefined);
  assert.strictEqual(env['HOME'], '/home/user');
});

test('buildJudgeEnv(claude, true): strips CLAUDE_API_KEY when ANTHROPIC_API_KEY present', () => {
  const env = buildJudgeEnv('claude', true, {
    CLAUDE_API_KEY: 'sk-outer',
    ANTHROPIC_API_KEY: 'sk-inner',
    PATH: '/bin',
  });
  assert.strictEqual(env['CLAUDE_API_KEY'], undefined);
  assert.strictEqual(env['ANTHROPIC_API_KEY'], 'sk-inner');
});

test('buildJudgeEnv(claude, true): does NOT strip CLAUDE_API_KEY when ANTHROPIC_API_KEY absent', () => {
  const env = buildJudgeEnv('claude', true, {
    CLAUDE_API_KEY: 'sk-only-key',
    PATH: '/bin',
  });
  assert.strictEqual(env['CLAUDE_API_KEY'], 'sk-only-key');
});

test('buildJudgeEnv(claude, true): replaces XDG_RUNTIME_DIR with fresh tmpdir', () => {
  const env = buildJudgeEnv('claude', true, {
    XDG_RUNTIME_DIR: '/run/user/1000',
    PATH: '/bin',
  });
  assert.ok(
    typeof env['XDG_RUNTIME_DIR'] === 'string' && env['XDG_RUNTIME_DIR'] !== '/run/user/1000',
    'XDG_RUNTIME_DIR should be replaced',
  );
  assert.ok(env['XDG_RUNTIME_DIR']?.includes('pickle-judge-'), 'new XDG_RUNTIME_DIR should match prefix');
  // cleanup the created tmpdir
  try { fs.rmdirSync(env['XDG_RUNTIME_DIR']); } catch { /* best-effort */ }
});

test('buildJudgeEnv(claude, true): sets XDG_RUNTIME_DIR even when absent in base env', () => {
  const env = buildJudgeEnv('claude', true, { PATH: '/bin' });
  assert.ok(typeof env['XDG_RUNTIME_DIR'] === 'string', 'XDG_RUNTIME_DIR should be set');
  assert.ok(env['XDG_RUNTIME_DIR']?.includes('pickle-judge-'), 'should match prefix');
  try { fs.rmdirSync(env['XDG_RUNTIME_DIR']); } catch { /* best-effort */ }
});

test('buildJudgeEnv(claude, true): preserves ANTHROPIC_API_KEY and PATH', () => {
  const env = buildJudgeEnv('claude', true, {
    CLAUDE_CODE: '1',
    ANTHROPIC_API_KEY: 'sk-test',
    PATH: '/usr/bin:/usr/local/bin',
    HOME: '/home/test',
  });
  assert.strictEqual(env['ANTHROPIC_API_KEY'], 'sk-test');
  assert.strictEqual(env['PATH'], '/usr/bin:/usr/local/bin');
  assert.strictEqual(env['HOME'], '/home/test');
  assert.strictEqual(env['CLAUDE_CODE'], undefined);
  try { fs.rmdirSync(env['XDG_RUNTIME_DIR'] ?? ''); } catch { /* best-effort */ }
});

// ---------------------------------------------------------------------------
// buildJudgeEnv — non-nested paths
// ---------------------------------------------------------------------------

test('buildJudgeEnv(codex, false): env identical to backendEnvOverrides("codex") when baseEnv is empty', () => {
  const env = buildJudgeEnv('codex', false, {});
  assert.deepStrictEqual(env, backendEnvOverrides('codex'));
});

test('buildJudgeEnv(claude, false): does not strip CLAUDE_CODE', () => {
  const env = buildJudgeEnv('claude', false, { CLAUDE_CODE: '1', PATH: '/bin' });
  assert.strictEqual(env['CLAUDE_CODE'], '1');
});

test('buildJudgeEnv(codex, false): merges base env with backendEnvOverrides(codex)', () => {
  const base = { PATH: '/bin', HOME: '/home/test' };
  const env = buildJudgeEnv('codex', false, base);
  assert.strictEqual(env['PATH'], '/bin');
  assert.strictEqual(env['HOME'], '/home/test');
  const overrides = backendEnvOverrides('codex');
  for (const [k, v] of Object.entries(overrides)) {
    assert.strictEqual(env[k], v, `expected override key ${k}`);
  }
});

// ---------------------------------------------------------------------------
// getJudgeEnvForAttempt — integration (delegates to buildJudgeEnv)
// ---------------------------------------------------------------------------

test('getJudgeEnvForAttempt: auto backend falls back to claude', () => {
  // When called with 'auto' (JudgeBackend), should not throw and should return an env.
  // We cannot easily control isNestedClaude() here, but we can verify no crash.
  const env = getJudgeEnvForAttempt('auto', '/tmp');
  assert.ok(typeof env === 'object' && env !== null, 'should return object');
});

test('getJudgeEnvForAttempt: claude backend returns object', () => {
  const env = getJudgeEnvForAttempt('claude', '/tmp');
  assert.ok(typeof env === 'object' && env !== null, 'should return object');
});

// ---------------------------------------------------------------------------
// cleanupJudgeRuntimeDir
// ---------------------------------------------------------------------------

test('cleanupJudgeRuntimeDir: removes a directory buildJudgeEnv created', () => {
  const env = buildJudgeEnv('claude', true, { PATH: '/bin' });
  const dir = env['XDG_RUNTIME_DIR'];
  assert.ok(dir && fs.existsSync(dir), 'precondition: directory exists');
  cleanupJudgeRuntimeDir(env);
  assert.strictEqual(fs.existsSync(dir), false, 'directory should be removed');
});

test('cleanupJudgeRuntimeDir: does not remove a real ambient XDG_RUNTIME_DIR (non-nested passthrough)', () => {
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-pickle-judge-'));
  try {
    const env = buildJudgeEnv('claude', false, { XDG_RUNTIME_DIR: realDir, PATH: '/bin' });
    assert.strictEqual(env['XDG_RUNTIME_DIR'], realDir);
    cleanupJudgeRuntimeDir(env);
    assert.ok(fs.existsSync(realDir), 'ambient XDG_RUNTIME_DIR must survive cleanup');
  } finally {
    try { fs.rmdirSync(realDir); } catch { /* best-effort */ }
  }
});

test('cleanupJudgeRuntimeDir: no-ops when XDG_RUNTIME_DIR is absent', () => {
  assert.doesNotThrow(() => cleanupJudgeRuntimeDir({ PATH: '/bin' }));
});

test('cleanupJudgeRuntimeDir: never throws when the directory was already removed', () => {
  const env = buildJudgeEnv('claude', true, { PATH: '/bin' });
  fs.rmSync(env['XDG_RUNTIME_DIR'], { recursive: true, force: true });
  assert.doesNotThrow(() => cleanupJudgeRuntimeDir(env));
});

test('cleanupJudgeRuntimeDir: never throws for a non-existent path outside tmpdir', () => {
  assert.doesNotThrow(() => cleanupJudgeRuntimeDir({ XDG_RUNTIME_DIR: '/run/user/1000' }));
});


// ---------------------------------------------------------------------------
// B-CLIBRITTLE AC-1 — the judge spawn is decoupled from ambient CLI settings
// ---------------------------------------------------------------------------

test('AP-EXT-ITER36-01: every claude judge invocation carries the ambient-settings decoupling flag', () => {
  // Pins the BUILDER, not a helper a call site may forget: the decoupling reaches
  // the measurement judge, both rate-limit probes and correct-course by construction.
  for (const opts of [
    { prompt: 'score it', addDirs: [] },
    { prompt: 'score it', addDirs: ['/tmp/x'], model: 'm', systemPrompt: 'sp' },
  ]) {
    const { args } = buildJudgeInvocation('claude', opts);
    const i = args.indexOf('--setting-sources');
    assert.notEqual(i, -1, 'the decoupling flag must be present');
    assert.equal(args[i + 1], '', 'empty value means: load NO ambient source');
    assert.equal(
      args.filter((a) => a === '--setting-sources').length,
      1,
      'the flag must appear exactly once',
    );
  }
});

// End-to-end on one of the THREE production sites that forgot the per-callsite step.
// Hosted here rather than beside the other correct-course cases BY FORCE: this session's
// scope.json:allowed_paths does not carry tests/correct-course.test.js, and a commit
// touching it is refused by the check-scope-diff preflight. Move it back when a fence
// carries that file — do NOT read its location as evidence it is about judge env.
test('AP-EXT-ITER36-01: the real correct-course plan is decoupled from ambient settings', () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-clibrittle-'));
  try {
    const result = runCorrectCourse({
      sessionDir,
      repoRoot: sessionDir,
      discovery: 'Ambient settings discovery',
      dryRun: true,
      autoApply: false,
      force: false,
      recoverFromLedger: false,
      recover: false,
    }, { stdout: () => {}, now: () => new Date('2026-04-30T12:00:00.000Z') });

    assert.equal(result.invocation.cmd, 'claude');
    const i = result.invocation.args.indexOf('--setting-sources');
    assert.notEqual(i, -1, 'the course-correction judge spawn must load NO ambient setting source');
    assert.equal(result.invocation.args[i + 1], '');
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('AP-EXT-ITER36-01: the codex judge arm carries its own isolation, not --setting-sources', () => {
  const { args } = buildJudgeInvocation('codex', { prompt: 'score it', addDirs: [] });
  assert.equal(args.includes('--setting-sources'), false, 'codex has no such flag');
  assert.equal(args.includes('--ignore-user-config'), true);
  assert.equal(args.includes('--ignore-rules'), true);
});

// The behavioural half of AC-1. A permissive-but-unrelated ambient rule is INSTALLED in a real
// workspace, and the spawn must still work.
//
// The stub models a CLI that treats the ambient rule as fatal — which is the whole hazard class:
// this repo cannot control which severity a future CLI release assigns to a rule nobody here
// wrote. Whether any particular shipped version happens to warn or fail on it is exactly the
// variable the decoupling removes, so the stub pins the property that survives that variance.
test('AC-1: an ambient permissions rule cannot break the judge spawn once decoupled', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'clibrittle-ac1-'));
  try {
    // The literal rule from the five-day outage.
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Write(.claude/commands/**)'] } }),
    );

    const stub = path.join(ws, 'stub-claude.js');
    fs.writeFileSync(stub, [
      'const fs = require("fs");',
      'const path = require("path");',
      'const args = process.argv.slice(2);',
      'const i = args.indexOf("--setting-sources");',
      // Decoupled === flag present AND its value empty (load no sources).
      'const decoupled = i !== -1 && args[i + 1] === "";',
      'if (!decoupled) {',
      '  const f = path.join(process.cwd(), ".claude", "settings.json");',
      '  if (fs.existsSync(f)) {',
      '    const s = JSON.parse(fs.readFileSync(f, "utf8"));',
      '    for (const rule of (s.permissions && s.permissions.allow) || []) {',
      '      process.stderr.write("Permission allow rule: " + rule + " rejected\\n");',
      '      process.exit(1);',
      '    }',
      '  }',
      '}',
      'process.stdout.write("42\\n");',
    ].join('\n'));

    const run = (extra) => {
      const args = [stub, '--model', 'm', '-p', 'score it', ...extra];
      return execFileSync(process.execPath, args, { cwd: ws, encoding: 'utf8', timeout: 20000 }).trim();
    };

    // Mutation direction that matters: WITHOUT the decoupling the ambient rule kills the spawn.
    assert.throws(() => run([]), /rejected/, 'control: the installed rule must be able to break an undecoupled spawn');

    // AC-1 proper: the args the REAL builder produces make the installed rule inert.
    const builtArgs = buildJudgeInvocation('claude', { prompt: 'score it', addDirs: [] }).args;
    const flagIdx = builtArgs.indexOf('--setting-sources');
    assert.notEqual(flagIdx, -1);
    assert.equal(run(['--setting-sources', builtArgs[flagIdx + 1]]), '42');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AP-EXT-ITER230-01 — the CLAUDE namespace is DEFAULT-DENY in the nested judge.
//
// The prior shape enumerated three session-marker prefixes (CLAUDECODE_,
// CLAUDE_SESSION_, CLAUDE_PROJECT_) that no producer emits, while exempting the
// CLAUDE_CODE_ prefix the CLI actually stamps its session identity under. These
// cases pin the RULE (default-deny plus a vouched routing family), not a list,
// so a marker the CLI adds tomorrow needs no code change here.
// ---------------------------------------------------------------------------

/** Runs buildJudgeEnv's nested-claude branch and cleans up the tmpdir it mints. */
function nestedJudgeEnv(baseEnv) {
  const env = buildJudgeEnv('claude', true, baseEnv);
  try { fs.rmdirSync(env['XDG_RUNTIME_DIR'] ?? ''); } catch { /* best-effort */ }
  return env;
}

/** Every CLAUDE-namespace key the child is allowed to keep. */
function preservedClaudeKeys(env) {
  return Object.keys(env).filter((k) => k.startsWith('CLAUDE'));
}

// The markers a real `claude` CLI stamps into the env of every process it spawns,
// measured off a live Claude Code session's microverse-runner (the process that
// actually spawns the judge). None of these matched the prior enumeration.
const OUTER_SESSION_MARKERS = {
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: '0df636b6-9508-4d85-832e-0cb75ad93e68',
  CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_011FRURWj26SN9JvrzNAfD4A',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_EXECPATH: '/Users/test/.local/share/claude/versions/2.1.252',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/944.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'd35229d899376a8122e61c6a030f6239',
  CLAUDE_PID: '944',
  CLAUDE_EFFORT: 'high',
};

test('AP-EXT-ITER230-01: every live outer-session marker is stripped from the nested judge env', () => {
  const env = nestedJudgeEnv({ ...OUTER_SESSION_MARKERS, PATH: '/usr/bin' });
  for (const key of Object.keys(OUTER_SESSION_MARKERS)) {
    assert.strictEqual(env[key], undefined, `${key} must not reach the nested judge`);
  }
  assert.strictEqual(env['PATH'], '/usr/bin', 'non-CLAUDE env is untouched');
});

test('AP-EXT-ITER230-01: the IPC socket and its auth token never reach the child', () => {
  const env = nestedJudgeEnv({
    CLAUDECODE: '1',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/944.sock',
    CLAUDE_CODE_MESSAGING_TOKEN: 'd35229d899376a8122e61c6a030f6239',
    PATH: '/usr/bin',
  });
  const leaked = Object.entries(env).filter(([, v]) => v === 'd35229d899376a8122e61c6a030f6239');
  assert.deepStrictEqual(leaked, [], 'the outer session messaging token must not be inherited');
  assert.strictEqual(env['CLAUDE_CODE_MESSAGING_SOCKET'], undefined);
});

test('AP-EXT-ITER230-01: a CLAUDE marker the rule has never seen is stripped without a code change', () => {
  // Default-deny is the whole point: an enumeration would need a new member here.
  const env = nestedJudgeEnv({
    CLAUDECODE: '1',
    CLAUDE_CODE_FUTURE_SESSION_HANDLE: 'whatever-the-cli-adds-next',
    CLAUDECODE_LEGACY_MARKER: 'legacy',
    CLAUDE_SOMETHING_ENTIRELY_NEW: 'x',
    PATH: '/usr/bin',
  });
  assert.deepStrictEqual(preservedClaudeKeys(env), [], 'no unvouched CLAUDE key survives');
});

test('AP-EXT-ITER230-01: provider routing survives — the whole reason the namespace is not blanket-stripped', () => {
  const env = nestedJudgeEnv({
    CLAUDECODE: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_API_KEY: 'sk-test',
    PATH: '/usr/bin',
  });
  assert.strictEqual(env['CLAUDE_CODE_USE_VERTEX'], '1');
  assert.strictEqual(env['CLAUDE_CODE_USE_BEDROCK'], '1');
  assert.strictEqual(env['ANTHROPIC_API_KEY'], 'sk-test');
});

test('AP-EXT-ITER230-01: a future CLAUDE_CODE_USE_<PROVIDER> selector routes without a code change', () => {
  const env = nestedJudgeEnv({ CLAUDECODE: '1', CLAUDE_CODE_USE_SOMEPROVIDER: '1', PATH: '/usr/bin' });
  assert.strictEqual(env['CLAUDE_CODE_USE_SOMEPROVIDER'], '1');
});

test('AP-EXT-ITER230-01: the child keeps its own key when ANTHROPIC_API_KEY cannot authenticate it', () => {
  // The auth arm is the one conditional survivor in the namespace; a blanket
  // strip would take the child's only credential on an API-key-only box.
  const withAnthropic = nestedJudgeEnv({ CLAUDECODE: '1', CLAUDE_API_KEY: 'sk-claude', ANTHROPIC_API_KEY: 'sk-ant' });
  assert.strictEqual(withAnthropic['CLAUDE_API_KEY'], undefined);

  const withoutAnthropic = nestedJudgeEnv({ CLAUDECODE: '1', CLAUDE_API_KEY: 'sk-claude' });
  assert.strictEqual(withoutAnthropic['CLAUDE_API_KEY'], 'sk-claude');
  assert.deepStrictEqual(preservedClaudeKeys(withoutAnthropic), ['CLAUDE_API_KEY']);
});

test("AP-EXT-ITER230-01: pickle's own run context is still stripped", () => {
  const env = nestedJudgeEnv({
    CLAUDECODE: '1',
    PICKLE_SESSION: '2026-09-06-27819a21',
    PICKLE_STATE_FILE: '/tmp/state.json',
    PICKLE_RICK_LEGACY: '1',
    SESSION_ROOT: '/tmp/session',
    TICKET_DIR: '/tmp/ticket',
    PATH: '/usr/bin',
  });
  for (const key of ['PICKLE_SESSION', 'PICKLE_STATE_FILE', 'PICKLE_RICK_LEGACY', 'SESSION_ROOT', 'TICKET_DIR']) {
    assert.strictEqual(env[key], undefined, `${key} must not reach the nested judge`);
  }
});

test('AP-EXT-ITER230-01: the non-nested branch is unchanged — nothing is stripped there', () => {
  const base = { ...OUTER_SESSION_MARKERS, PATH: '/usr/bin' };
  const env = buildJudgeEnv('claude', false, base);
  for (const [key, value] of Object.entries(base)) {
    assert.strictEqual(env[key], value, `${key} passes through when not nested`);
  }
});

test('AP-EXT-ITER230-01: the ambient session env — the real producer — is fully stripped', () => {
  // Derivation, not a list: whatever the CLI actually set in THIS process must
  // come out vouched-or-gone. Self-checking so it cannot pass vacuously in CI,
  // where no outer Claude Code session exists.
  const ambient = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => k.startsWith('CLAUDE') && v !== undefined),
  );
  if (Object.keys(ambient).length === 0) {
    assert.strictEqual(isNestedClaude(process.env), false, 'no ambient CLAUDE env means no outer session to leak');
    return;
  }
  const env = nestedJudgeEnv({ ...ambient, PATH: '/usr/bin' });
  for (const key of preservedClaudeKeys(env)) {
    assert.ok(
      key.startsWith('CLAUDE_CODE_USE_') || key === 'CLAUDE_API_KEY',
      `ambient ${key} survived the strip but is neither routing nor the child's own key`,
    );
  }
});
