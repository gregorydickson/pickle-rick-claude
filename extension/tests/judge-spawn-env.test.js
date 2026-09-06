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
  decoupleJudgeSettingSources,
  JUDGE_DECOUPLED_SETTING_SOURCES,
} from '../services/judge-spawn-env.js';
import { execFileSync } from 'node:child_process';
import { backendEnvOverrides } from '../services/backend-spawn.js';

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

test('decoupleJudgeSettingSources: appends --setting-sources with the repo-owned empty value', () => {
  const out = decoupleJudgeSettingSources(['--model', 'x', '-p', 'prompt']);
  const i = out.indexOf('--setting-sources');
  assert.notEqual(i, -1, 'the decoupling flag must be present');
  assert.equal(out[i + 1], JUDGE_DECOUPLED_SETTING_SOURCES);
  assert.equal(JUDGE_DECOUPLED_SETTING_SOURCES, '', 'empty value means: load NO ambient source');
});

test('decoupleJudgeSettingSources: preserves prior args in order and does not mutate its input', () => {
  const input = ['--model', 'x', '-p', 'prompt'];
  const frozen = [...input];
  const out = decoupleJudgeSettingSources(input);
  assert.deepEqual(input, frozen, 'input array must not be mutated');
  assert.deepEqual(out.slice(0, frozen.length), frozen, 'prior args must keep their order');
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

    // AC-1 proper: with the decoupling the same installed rule is inert and the spawn works.
    assert.equal(run(decoupleJudgeSettingSources([])), '42');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
