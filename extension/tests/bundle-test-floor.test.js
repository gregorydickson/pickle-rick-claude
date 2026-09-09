// @tier: fast
//
// AP-EXT-ITER40-02: `bundle-finalize.ts` landed 2026-05-01 computing a "bundle test floor"
// and never acquired a production caller. Its own suite was the entire consumer set, so a
// module that had never executed stayed green for four months — and an accepted AC evidence
// doc cited it as the LIVE mechanism computing the floor. That is the defect this file used
// to hide by passing; it now pins the deletion instead.
//
// The pin is content-derived, not a path list: every export the module published must be
// absent from BOTH shipped trees, so a re-landing under any filename is caught. Absence is
// asserted over `src/` and `services/` only — `tests/` is excluded because this file names
// the symbols itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeEach } from './helpers/describe-each.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = path.resolve(__dirname, '..');

const DELETED_FILES = ['src/services/bundle-finalize.ts', 'services/bundle-finalize.js'];

const DELETED_EXPORTS = [
  'BundleFinalizeTicket',
  'BundleTestFloorContribution',
  'BundleTestFloorInput',
  'BundleTestFloorResult',
  'computeBundleTestFloor',
  'parseCommitTestDelta',
  'parseRefinementBaseline',
  'renderMorningSummaryFrontmatter',
];

/** Recursively lists every `.ts`/`.js` file under `dir`, skipping `node_modules`. */
function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(abs));
    } else if (entry.isFile() && /\.[jt]s$/.test(entry.name)) {
      out.push(abs);
    }
  }
  return out;
}

const SHIPPED_FILES = [
  ...listSourceFiles(path.join(EXTENSION_ROOT, 'src')),
  ...listSourceFiles(path.join(EXTENSION_ROOT, 'services')),
];

test('the shipped trees the pin walks are non-empty, so an absence assertion means something', () => {
  assert.ok(
    SHIPPED_FILES.length > 100,
    `expected the src/ + services/ walk to find a real corpus, found ${SHIPPED_FILES.length} file(s) — ` +
    'an empty walk would make every absence assertion below vacuous',
  );
});

describeEach(DELETED_FILES)('deleted module file is absent', (relPath) => {
  test(`${relPath} does not exist`, () => {
    assert.equal(
      fs.existsSync(path.join(EXTENSION_ROOT, relPath)),
      false,
      `${relPath} is back on disk — it computes a bundle test floor no caller reads`,
    );
  });
});

describeEach(DELETED_EXPORTS)('deleted export is absent from the shipped trees', (symbol) => {
  test(`${symbol} has zero occurrences under src/ and services/`, () => {
    const offenders = SHIPPED_FILES.filter((abs) => fs.readFileSync(abs, 'utf8').includes(symbol))
      .map((abs) => path.relative(EXTENSION_ROOT, abs));
    assert.deepEqual(
      offenders,
      [],
      `${symbol} was deleted with bundle-finalize.ts but is named again in: ${offenders.join(', ')}`,
    );
  });
});

test('the services export catalog names neither the deleted module nor any of its exports', () => {
  const catalog = fs.readFileSync(path.join(EXTENSION_ROOT, 'src/services/CLAUDE.md'), 'utf8');
  assert.ok(
    !catalog.includes('bundle-finalize'),
    'src/services/CLAUDE.md still carries a row for the deleted module — the row-identity sweep ' +
    'resolves rows against modules on disk, so a dangling row reds the catalog audit',
  );
  for (const symbol of DELETED_EXPORTS) {
    assert.ok(!catalog.includes(symbol), `src/services/CLAUDE.md still names deleted symbol "${symbol}"`);
  }
});

test('no AC evidence doc cites the deleted module as a live mechanism', () => {
  const evidenceDir = path.join(EXTENSION_ROOT, 'tests/evidence');
  const docs = fs.readdirSync(evidenceDir).filter((name) => name.endsWith('.md'));
  assert.ok(docs.length > 0, 'tests/evidence holds no .md files — this citation check would be vacuous');
  for (const name of docs) {
    const body = fs.readFileSync(path.join(evidenceDir, name), 'utf8');
    assert.ok(
      !body.includes('bundle-finalize'),
      `tests/evidence/${name} cites bundle-finalize as the mechanism computing the bundle test ` +
      'floor; the module never had a caller, so an AC accepted on that citation was accepted on ' +
      'a mechanism that never ran',
    );
  }
});
