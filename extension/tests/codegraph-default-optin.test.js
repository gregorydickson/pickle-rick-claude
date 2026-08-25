// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const SETTINGS_PATH = path.join(repoRoot, 'pickle_settings.json');

function loadSourceSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
}

test('AC-GA-CG-1: source codegraph.enabled is true (enabled by default)', () => {
  const settings = loadSourceSettings();
  assert.equal(settings.codegraph.enabled, true);
});

test('AC-GA-CG-1: source codegraph.index_at_setup is true (enabled by default)', () => {
  const settings = loadSourceSettings();
  assert.equal(settings.codegraph.index_at_setup, true);
});

test('AC-GA-CG-1: other codegraph fields remain present and unchanged', () => {
  const { codegraph } = loadSourceSettings();
  assert.equal(codegraph.index_timeout_ms, 120000);
  assert.equal(codegraph.sync_timeout_ms, 30000);
  assert.equal(codegraph.query_timeout_ms, 5000);
  assert.equal(codegraph.staleness_max_age_minutes, 30);
  assert.equal(codegraph.context_max_bytes, 8192);
  // Forced true by install.sh MANAGED_KEYS as of e99b172b — the C7 worker-MCP lane is
  // source-authoritative, so a stale deployed `false` can no longer survive a deploy.
  assert.equal(codegraph.expose_mcp_to_workers, true);
});
