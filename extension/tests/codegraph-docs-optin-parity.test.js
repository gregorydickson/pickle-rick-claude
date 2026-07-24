// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const CLAUDE_MD = path.join(repoRoot, 'CLAUDE.md');
const README_MD = path.join(repoRoot, 'README.md');
const SETTINGS = path.join(repoRoot, 'pickle_settings.json');

const claudeMd = fs.readFileSync(CLAUDE_MD, 'utf8');
const readme = fs.readFileSync(README_MD, 'utf8');
const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));

test('AC-GA-CG-2: CLAUDE.md no longer claims codegraph is Default-ON', () => {
  assert.equal(claudeMd.includes('Default-ON since B-CGH'), false);
});

test('AC-GA-CG-2: CLAUDE.md codegraph row describes enabled-by-default', () => {
  const row = claudeMd.split('\n').find((l) => l.startsWith('| `codegraph`'));
  assert.ok(row, 'codegraph settings row present in CLAUDE.md');
  assert.match(row, /Enabled by default/);
  assert.match(row, /`enabled` \(`true`\)/);
  assert.match(row, /`index_at_setup` \(`true`\)/);
});

test('AC-GA-CG-2: README describes codegraph as enabled by default', () => {
  assert.match(readme, /Code Graph is enabled by default/);
});

test('AC-GA-CG-2: README has no unconditional serve --mcp-by-default claim; lane split documented', () => {
  assert.equal(
    /Claude-family workers get a `codegraph serve --mcp` MCP server/.test(readme),
    false,
  );
  assert.match(readme, /injected-context lane/);
  assert.match(readme, /dormant by default/);
  assert.match(readme, /gated OFF unless `expose_mcp_to_workers === true`/);
});

test('AC-GA-CG-2: source pickle_settings.json codegraph booleans match the enabled-by-default docs', () => {
  assert.equal(settings.codegraph.enabled, true);
  assert.equal(settings.codegraph.index_at_setup, true);
});
