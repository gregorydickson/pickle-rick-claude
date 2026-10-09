#!/usr/bin/env node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const PLUGIN_NAME = 'codex';
const COMPANION_REL = path.join('scripts', 'codex-companion.mjs');

export type CompanionResolution =
  | { ok: true; path: string; source: 'plugin_root' | 'registry' | 'cache_glob' }
  | { ok: false; reason: string };

interface RegistryEntry {
  installPath?: unknown;
  lastUpdated?: unknown;
}

function companionIn(dir: unknown): string | null {
  if (typeof dir !== 'string' || dir === '') return null;
  const candidate = path.join(dir, COMPANION_REL);
  return fs.existsSync(candidate) ? candidate : null;
}

function pluginNameOf(key: string): string {
  const at = key.lastIndexOf('@');
  return at === -1 ? key : key.slice(0, at);
}

function readRegistryEntries(pluginsDir: string): RegistryEntry[] {
  let plugins: unknown;
  try {
    plugins = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf-8'))?.plugins;
  } catch {
    return [];
  }
  if (!plugins || typeof plugins !== 'object') return [];
  return Object.entries(plugins as Record<string, unknown>)
    .filter(([key, entries]) => pluginNameOf(key) === PLUGIN_NAME && Array.isArray(entries))
    .flatMap(([, entries]) => entries as RegistryEntry[]);
}

function updatedAt(entry: RegistryEntry): number {
  const parsed = typeof entry.lastUpdated === 'string' ? Date.parse(entry.lastUpdated) : NaN;
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

function fromRegistry(pluginsDir: string): string | null {
  let best: { path: string; updated: number } | null = null;
  for (const entry of readRegistryEntries(pluginsDir)) {
    const companion = companionIn(entry?.installPath);
    if (!companion) continue;
    const updated = updatedAt(entry);
    if (!best || updated > best.updated) best = { path: companion, updated };
  }
  return best?.path ?? null;
}

function compareVersions(a: string, b: string): number {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function readDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

function fromCacheGlob(pluginsDir: string): string | null {
  const cacheDir = path.join(pluginsDir, 'cache');
  let best: { path: string; version: string } | null = null;
  for (const marketplace of readDirs(cacheDir)) {
    const pluginDir = path.join(cacheDir, marketplace, PLUGIN_NAME);
    for (const version of readDirs(pluginDir)) {
      const companion = companionIn(path.join(pluginDir, version));
      if (companion && (!best || compareVersions(version, best.version) > 0)) best = { path: companion, version };
    }
  }
  return best?.path ?? null;
}

export function defaultPluginsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PICKLE_CLAUDE_PLUGINS_DIR || path.join(env.HOME || os.homedir(), '.claude', 'plugins');
}

export function resolveCodexCompanion(env: NodeJS.ProcessEnv = process.env): CompanionResolution {
  const fromRoot = companionIn(env.CLAUDE_PLUGIN_ROOT);
  if (fromRoot) return { ok: true, path: fromRoot, source: 'plugin_root' };

  const pluginsDir = defaultPluginsDir(env);
  const registered = fromRegistry(pluginsDir);
  if (registered) return { ok: true, path: registered, source: 'registry' };

  const globbed = fromCacheGlob(pluginsDir);
  if (globbed) return { ok: true, path: globbed, source: 'cache_glob' };

  return {
    ok: false,
    reason:
      `codex plugin not installed: no ${COMPANION_REL} under $CLAUDE_PLUGIN_ROOT ` +
      `(${env.CLAUDE_PLUGIN_ROOT || 'unset'}), any "${PLUGIN_NAME}@<marketplace>" entry of ` +
      `${path.join(pluginsDir, 'installed_plugins.json')}, or ${path.join(pluginsDir, 'cache', '*', PLUGIN_NAME, '*')}`,
  };
}

if (process.argv[1] && path.basename(process.argv[1]) === 'resolve-codex-companion.js') {
  const result = resolveCodexCompanion();
  if (result.ok) {
    process.stdout.write(result.path);
  } else {
    process.stderr.write(`resolve-codex-companion: ${result.reason}\n`);
    process.exit(1);
  }
}
