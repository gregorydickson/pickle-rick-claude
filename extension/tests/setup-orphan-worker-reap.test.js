// @tier: fast
/**
 * R-CXHANG AC-CXHANG-2: the orphan-worker reaper is invoked once at pipeline
 * bootstrap in setup.ts (before the first worker spawn), best-effort — a
 * reaper throw never blocks launch.
 *
 * (a) source-shape assertions encode the PRD's literal grep verify as a test;
 * (b) behavior: the extracted runSetupOrphanReap helper swallows a throwing
 *     injected reaper and threads sessionsRoot/statePath correctly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetupOrphanReap } from '../bin/setup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP_TS = path.resolve(__dirname, '../src/bin/setup.ts');

// Sandbox any incidental data-root access.
process.env.PICKLE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cxhang-setup-'));

test('AC-CXHANG-2(a): setup.ts wires reapOrphanedWorkerProcs exactly once, inside a try/catch helper', () => {
  const src = fs.readFileSync(SETUP_TS, 'utf-8');

  // Import from the shared reaper module (no second implementation).
  assert.match(src, /import\s*\{[^}]*reapOrphanedWorkerProcs[^}]*\}\s*from\s*'\.\.\/services\/orphan-reaper\.js'/,
    'setup.ts must import reapOrphanedWorkerProcs from services/orphan-reaper.js');

  // Exactly ONE non-import reference — the single bootstrap invocation seam
  // (default in the injectable helper), not scattered call sites.
  const nonImportRefs = src
    .split('\n')
    .filter(l => l.includes('reapOrphanedWorkerProcs') && !/^\s*import\b/.test(l) && !l.includes(' from '));
  assert.equal(nonImportRefs.length, 1,
    `expected exactly 1 non-import reapOrphanedWorkerProcs reference in setup.ts, got ${nonImportRefs.length}: ${nonImportRefs.join(' | ')}`);

  // The helper body wraps the reap in try/catch (best-effort — never block launch).
  const helperStart = src.indexOf('export function runSetupOrphanReap');
  assert.ok(helperStart >= 0, 'setup.ts must export runSetupOrphanReap');
  const helperSlice = src.slice(helperStart, helperStart + 1200);
  assert.match(helperSlice, /try\s*\{[\s\S]*catch/, 'runSetupOrphanReap must be try/catch best-effort');

  // main() calls the helper after session resolution.
  const mainStart = src.indexOf('async function main()');
  assert.ok(mainStart >= 0, 'setup.ts must have main()');
  const mainSlice = src.slice(mainStart);
  assert.ok(mainSlice.includes('runSetupOrphanReap('), 'main() must invoke runSetupOrphanReap');
});

test('AC-CXHANG-2(b): a throwing reaper is swallowed and returns null', () => {
  const result = runSetupOrphanReap('/tmp/sess-root/session-x', '/tmp/sess-root', {
    reap: () => { throw new Error('reaper exploded'); },
  });
  assert.equal(result, null, 'reaper exception must be swallowed (never block launch)');
});

test('AC-CXHANG-2(b): threads sessionsRoot + session statePath into the reaper and returns counts', () => {
  const calls = [];
  const result = runSetupOrphanReap('/data/sessions/2026-07-02-abc', '/data/sessions', {
    reap: (opts) => { calls.push(opts); return { scanned: 3, reaped: 2 }; },
  });
  assert.deepEqual(result, { scanned: 3, reaped: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionsRoot, '/data/sessions');
  assert.equal(calls[0].statePath, path.join('/data/sessions/2026-07-02-abc', 'state.json'));
});
