// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkFixtureTmpDir } from './helpers/fixture-tmpdir.js';
import { resolveCodexCompanion, defaultPluginsDir } from '../bin/resolve-codex-companion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '../bin/resolve-codex-companion.js');

function makeInstall(root, rel) {
  const dir = path.join(root, rel);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  const companion = path.join(dir, 'scripts', 'codex-companion.mjs');
  fs.writeFileSync(companion, '// stub\n');
  return { dir, companion };
}

function writeRegistry(pluginsDir, plugins) {
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
}

function env(pluginsDir, extra = {}) {
  return { PICKLE_CLAUDE_PLUGINS_DIR: pluginsDir, ...extra };
}

test('CLAUDE_PLUGIN_ROOT wins when its companion exists', () => {
  const root = mkFixtureTmpDir('codex-resolve-');
  const pluginsDir = path.join(root, 'plugins');
  const fromRegistry = makeInstall(root, 'cache/codex-fork/codex/1.0.0');
  writeRegistry(pluginsDir, { 'codex@codex-fork': [{ installPath: fromRegistry.dir, lastUpdated: '2026-10-08T00:00:00Z' }] });
  const pluginRoot = makeInstall(root, 'plugin-root');
  const r = resolveCodexCompanion(env(pluginsDir, { CLAUDE_PLUGIN_ROOT: pluginRoot.dir }));
  assert.deepEqual(r, { ok: true, path: pluginRoot.companion, source: 'plugin_root' });
});

test('CLAUDE_PLUGIN_ROOT without a companion falls through to the registry', () => {
  const root = mkFixtureTmpDir('codex-resolve-');
  const pluginsDir = path.join(root, 'plugins');
  const reg = makeInstall(root, 'cache/codex-fork/codex/1.0.0');
  writeRegistry(pluginsDir, { 'codex@codex-fork': [{ installPath: reg.dir, lastUpdated: '2026-10-08T00:00:00Z' }] });
  const r = resolveCodexCompanion(env(pluginsDir, { CLAUDE_PLUGIN_ROOT: path.join(root, 'empty-root') }));
  assert.deepEqual(r, { ok: true, path: reg.companion, source: 'registry' });
});

test('registry: any marketplace whose plugin name is exactly codex, newest lastUpdated wins', () => {
  const root = mkFixtureTmpDir('codex-resolve-');
  const pluginsDir = path.join(root, 'plugins');
  const older = makeInstall(root, 'cache/openai-codex/codex/9.9.9');
  const newer = makeInstall(root, 'cache/codex-fork/codex/1.0.13');
  writeRegistry(pluginsDir, {
    'codex@openai-codex': [{ installPath: older.dir, lastUpdated: '2026-01-01T00:00:00Z' }],
    'codex@codex-fork': [{ installPath: newer.dir, lastUpdated: '2026-10-08T20:26:41.068Z' }],
  });
  assert.equal(resolveCodexCompanion(env(pluginsDir)).path, newer.companion);
});

test('registry: ordering is by lastUpdated, not key or entry order', () => {
  const root = mkFixtureTmpDir('codex-resolve-');
  const pluginsDir = path.join(root, 'plugins');
  const a = makeInstall(root, 'a');
  const b = makeInstall(root, 'b');
  writeRegistry(pluginsDir, {
    'codex@m1': [
      { installPath: a.dir, lastUpdated: '2026-10-09T00:00:00Z' },
      { installPath: b.dir, lastUpdated: '2026-03-01T00:00:00Z' },
    ],
  });
  assert.equal(resolveCodexCompanion(env(pluginsDir)).path, a.companion);
});

test('registry: names that merely contain codex never match, and missing files are skipped', () => {
  const root = mkFixtureTmpDir('codex-resolve-');
  const pluginsDir = path.join(root, 'plugins');
  const tools = makeInstall(root, 'cache/x/codex-tools/1.0.0');
  const notcodex = makeInstall(root, 'cache/y/notcodex/1.0.0');
  const real = makeInstall(root, 'cache/z/codex/0.1.0');
  writeRegistry(pluginsDir, {
    'codex-tools@x': [{ installPath: tools.dir, lastUpdated: '2026-10-09T00:00:00Z' }],
    'notcodex@y': [{ installPath: notcodex.dir, lastUpdated: '2026-10-09T00:00:00Z' }],
    'codex@z': [
      { installPath: path.join(root, 'gone'), lastUpdated: '2026-10-09T00:00:00Z' },
      { installPath: real.dir, lastUpdated: '2026-01-01T00:00:00Z' },
    ],
  });
  assert.deepEqual(resolveCodexCompanion(env(pluginsDir)), { ok: true, path: real.companion, source: 'registry' });
});

test('cache glob fallback: highest semver across marketplaces, codex name only', () => {
  const root = mkFixtureTmpDir('codex-resolve-');
  const pluginsDir = path.join(root, 'plugins');
  makeInstall(pluginsDir, 'cache/m1/codex/1.0.9');
  const best = makeInstall(pluginsDir, 'cache/m2/codex/1.0.13');
  makeInstall(pluginsDir, 'cache/m3/codex-tools/9.0.0');
  makeInstall(pluginsDir, 'cache/m4/notcodex/9.0.0');
  writeRegistry(pluginsDir, { 'codex-tools@m3': [{ installPath: path.join(pluginsDir, 'cache/m3/codex-tools/9.0.0'), lastUpdated: '2026-10-09T00:00:00Z' }] });
  assert.deepEqual(resolveCodexCompanion(env(pluginsDir)), { ok: true, path: best.companion, source: 'cache_glob' });
});

test('nothing installed: not ok, reason names what was searched', () => {
  const root = mkFixtureTmpDir('codex-resolve-');
  const pluginsDir = path.join(root, 'plugins');
  makeInstall(pluginsDir, 'cache/m/codex-tools/1.0.0');
  const r = resolveCodexCompanion(env(pluginsDir));
  assert.equal(r.ok, false);
  assert.match(r.reason, /installed_plugins\.json/);
});

test('defaultPluginsDir honours HOME when no override is set', () => {
  assert.equal(defaultPluginsDir({ HOME: '/h' }), path.join('/h', '.claude', 'plugins'));
  assert.equal(defaultPluginsDir({ HOME: '/h', PICKLE_CLAUDE_PLUGINS_DIR: '/p' }), '/p');
});

test('CLI: prints the path on success and exits non-zero with a reason otherwise', () => {
  const root = mkFixtureTmpDir('codex-resolve-');
  const home = path.join(root, 'home');
  const install = makeInstall(home, '.claude/plugins/cache/codex-fork/codex/1.0.13');
  writeRegistry(path.join(home, '.claude/plugins'), {
    'codex@codex-fork': [{ installPath: install.dir, lastUpdated: '2026-10-08T00:00:00Z' }],
  });
  const base = { ...process.env, HOME: home };
  delete base.CLAUDE_PLUGIN_ROOT;
  delete base.PICKLE_CLAUDE_PLUGINS_DIR;
  const ok = spawnSync(process.execPath, [BIN], { env: base, encoding: 'utf-8', timeout: 30_000 });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, install.companion);

  const empty = spawnSync(process.execPath, [BIN], { env: { ...base, HOME: path.join(root, 'nohome') }, encoding: 'utf-8', timeout: 30_000 });
  assert.notEqual(empty.status, 0);
  assert.equal(empty.stdout, '');
  assert.match(empty.stderr, /codex plugin not installed/);
});
