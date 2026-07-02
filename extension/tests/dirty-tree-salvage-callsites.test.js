// @tier: fast
// B-1SEAM WS-3 (R-MACB) — seam pin for the shared dirty-tree salvage service
// (R-AFCC-CALLER-ENUMERATION pattern). Source-grep assertions that make future
// divergence fail the gate:
//   (a) the deleted unsafe `stageAutoCommitPaths` (empty-excludes whole-tree
//       sweep) cannot resurrect anywhere under extension/src/;
//   (b) the microverse rescue site routes through `salvageDirtyTree(` with the
//       module-scope `AUTO_COMMIT_DIRT_EXCLUDES` (the non-empty owned/exclude
//       args the R-MACB bug report's ENFORCE demands);
//   (c) preflight stages via the shared per-path `stageOwnedPaths(`;
//   (d) no whole-tree `git add -u`, and `add -A` staging only at the pinned
//       pre-existing mux-runner sites + the throwaway-index stash;
//   (e) call-site counts pinned: salvageDirtyTree == 2 (mux exit path,
//       microverse rescue); stashUnattributableRemainder in mux-runner == 2
//       (probe-catch + boundary pre-stash) with the DEFINITION living in the
//       service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function read(rel) {
  return fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8');
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** Extract a top-level function body: from its declaration line to the first `}` at column 0. */
function extractFunction(source, declaration) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.includes(declaration));
  assert.notEqual(start, -1, `declaration not found: ${declaration}`);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  }
  assert.fail(`unterminated function body for: ${declaration}`);
}

test('(a) stageAutoCommitPaths is deleted and cannot resurrect anywhere in extension/src/', () => {
  for (const file of listSourceFiles(SRC_ROOT)) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(
      count(content, 'stageAutoCommitPaths'),
      0,
      `deleted symbol stageAutoCommitPaths reappeared in ${path.relative(SRC_ROOT, file)}`,
    );
  }
});

test('(b) autoRescueDirtyTree routes through salvageDirtyTree with AUTO_COMMIT_DIRT_EXCLUDES (non-empty exclude/owned args)', () => {
  const src = read(path.join('bin', 'microverse-runner.ts'));
  const body = extractFunction(src, 'export function autoRescueDirtyTree(');
  assert.match(body, /salvageDirtyTree\(/, 'rescue must route through the shared salvage seam');
  assert.match(body, /AUTO_COMMIT_DIRT_EXCLUDES/, 'rescue must pass the shared docs/prds excludes when computing owned paths');
  assert.match(body, /stageOwnedPaths\(/, 'rescue must stage via the per-path stager');
  // The shared excludes constant itself must be non-empty and cover prds + docs.
  assert.match(src, /const AUTO_COMMIT_DIRT_EXCLUDES = \['prds', 'docs'\]/, 'module-scope excludes constant must pin prds+docs');
});

test('(c) preflightAutoCommit stages via stageOwnedPaths and shares AUTO_COMMIT_DIRT_EXCLUDES', () => {
  const src = read(path.join('bin', 'microverse-runner.ts'));
  const body = extractFunction(src, 'export function preflightAutoCommit(');
  assert.match(body, /stageOwnedPaths\(/, 'preflight must stage via the shared per-path stager');
  assert.match(body, /AUTO_COMMIT_DIRT_EXCLUDES/, 'preflight must consume the shared excludes constant');
});

test('(d) no whole-tree `git add -u` anywhere; `add -A` staging only at the pinned sanctioned sites', () => {
  const microverse = read(path.join('bin', 'microverse-runner.ts'));
  const mux = read(path.join('bin', 'mux-runner.ts'));
  const salvage = read(path.join('services', 'dirty-tree-salvage.ts'));

  assert.equal(count(microverse, "'add', '-u'"), 0, 'git add -u must not exist in microverse-runner.ts');
  assert.equal(count(mux, "'add', '-u'"), 0, 'git add -u must not exist in mux-runner.ts');
  assert.equal(count(microverse, "'add', '-A'"), 0, 'whole-tree add must not exist in microverse-runner.ts');
  // mux-runner keeps exactly its two PRE-EXISTING documented whole-tree adds:
  // commitAndContinueDoneFlip's no-stagePaths default (Done-flip path) and the
  // execute-converged-plan commitPhase. A THIRD occurrence is a regression.
  assert.equal(count(mux, "'add', '-A'"), 2, 'mux-runner whole-tree add count must stay pinned at the 2 sanctioned sites');
  // The service's only whole-tree add lives inside the throwaway-index stash.
  assert.equal(count(salvage, "'add', '-A'"), 1, 'service must contain exactly one add -A (the stash)');
  assert.match(salvage, /GIT_INDEX_FILE/, 'the service stash must use the throwaway GIT_INDEX_FILE index');
});

test('(e) call-site counts pinned: salvageDirtyTree == 2, stashUnattributableRemainder in mux-runner == 2, definition lives in the service', () => {
  const microverse = read(path.join('bin', 'microverse-runner.ts'));
  const mux = read(path.join('bin', 'mux-runner.ts'));
  const salvage = read(path.join('services', 'dirty-tree-salvage.ts'));

  // Exactly TWO runtime callers of salvageDirtyTree: mux exit path + microverse rescue.
  let salvageCallers = 0;
  for (const file of listSourceFiles(SRC_ROOT)) {
    if (file.endsWith(path.join('services', 'dirty-tree-salvage.ts'))) continue;
    salvageCallers += count(fs.readFileSync(file, 'utf8'), 'salvageDirtyTree(');
  }
  assert.equal(salvageCallers, 2, 'salvageDirtyTree( must have exactly 2 call sites (mux exit path + microverse rescue)');
  assert.equal(count(mux, 'salvageDirtyTree('), 1, 'one salvageDirtyTree call in mux-runner (exit path)');
  assert.equal(count(microverse, 'salvageDirtyTree('), 1, 'one salvageDirtyTree call in microverse-runner (rescue)');

  // stashUnattributableRemainder: defined ONLY in the service; mux-runner keeps
  // exactly its 2 direct calls (ownership-probe catch + boundary pre-stash).
  assert.match(salvage, /export function stashUnattributableRemainder\(/, 'definition must live in the service');
  assert.doesNotMatch(mux, /function stashUnattributableRemainder\(/, 'mux-runner must not re-define the stash');
  assert.equal(count(mux, 'stashUnattributableRemainder('), 2, 'mux-runner direct stash calls pinned at 2 (probe-catch + boundary)');
  assert.match(mux, /export \{ stashUnattributableRemainder \}/, 'mux-runner must re-export the stash for its import surface');
});
