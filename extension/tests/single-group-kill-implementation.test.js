// @tier: fast
/**
 * R-CXHANG AC-CXHANG-3 seam pin: ONE negative-PID group-kill implementation.
 *
 * `killProcessGroup` in services/orphan-reaper.ts is the single shared
 * `process.kill(-pid, sig)` primitive. spawn-morty.ts (killProcessTree) and
 * pipeline-runner.ts (reapChildSubtree) delegate their negative-PID branch to
 * it. If a fourth implementation ever appears, this test fails the gate.
 *
 * ALLOWLIST (with reasons — deliberate, not drift):
 *  - services/orphan-reaper.ts — the shared primitive's ONE definition site.
 *  - hooks/dispatch.ts — the hook ENTRY point must stay dependency-light and
 *    fail-open (dispatch spawns handlers with a bare node runtime; importing
 *    the services tree into it expands the hook blast radius, and a broken
 *    import would fail-open EVERY protection hook). Its killHookChild keeps a
 *    local negative-PID kill by design; do NOT refactor it onto the shared
 *    primitive in this bundle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../src');

const ALLOWLIST = new Set([
  'services/orphan-reaper.ts', // definition site of the shared killProcessGroup primitive
  'hooks/dispatch.ts',         // hook entry stays dependency-light/fail-open (see header)
]);

function walkTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

test('AC-CXHANG-3: process.kill(- appears ONLY in the allowlisted files (code lines, comments excluded)', () => {
  const offenders = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (/process\.kill\(\s*-/.test(line) && !ALLOWLIST.has(rel)) {
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    `negative-PID kill implementations outside the allowlist — delegate to killProcessGroup (services/orphan-reaper.ts):\n${offenders.join('\n')}`);
});

test('AC-CXHANG-3: killProcessGroup is defined exactly once (services/orphan-reaper.ts)', () => {
  const definitionSites = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    if (/export function killProcessGroup\(/.test(fs.readFileSync(file, 'utf-8'))) {
      definitionSites.push(rel);
    }
  }
  assert.deepEqual(definitionSites, ['services/orphan-reaper.ts']);
});

test('AC-CXHANG-3: spawn-morty.ts and pipeline-runner.ts import + call the shared killProcessGroup', () => {
  for (const rel of ['bin/spawn-morty.ts', 'bin/pipeline-runner.ts']) {
    const src = fs.readFileSync(path.join(SRC_ROOT, rel), 'utf-8');
    assert.match(src, /killProcessGroup[^\n]*from '\.\.\/services\/orphan-reaper\.js'|from '\.\.\/services\/orphan-reaper\.js'/,
      `${rel} must import from services/orphan-reaper.js`);
    const callLines = src.split('\n').filter(l => !isCommentLine(l) && l.includes('killProcessGroup('));
    assert.ok(callLines.length >= 1, `${rel} must call killProcessGroup(`);
  }
});
