// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUNDLE_DIR = path.join(REPO_ROOT, 'bundle');

// Executable form of the bin/CLAUDE.md trap door: "no tracked bundle/ac-dr-*.json may
// hardcode `pass`". A tracked artifact must be content-stable to keep the repo tree clean
// across runs, and a content-stable file cannot carry a run-dependent verdict — only a
// constant one. verify-bundle reads `pass` as the AC's verdict, so such a file is a
// permanent false-green. Absent is honest: a missing artifact reports INCONCLUSIVE.
//
// AC-DR-02 (iter 10) and AC-DR-06 (iter 12) were both this shape. The trap door existed
// for AC-DR-02 but had no guard, so AC-DR-06 survived the sweep. This is that guard.

function trackedFiles() {
  return execFileSync('git', ['ls-files', 'bundle'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function sourceFilesUnder(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      sourceFilesUnder(full, acc);
    } else if (/\.(ts|js)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

// Collects identifiers bound to a path under the repo-root bundle/ dir, following one level
// of re-binding (`const dir = path.join(REPO_ROOT, 'bundle')` then
// `const file = path.join(dir, 'ac-dr-06.json')`). Merely REFERENCING such a path is fine —
// verify-recapture-fired.test.js asserts the tracked ac-dr-02.json is absent — so the guard
// must key on a write CALL taking one of these identifiers, not on file-level co-occurrence.
function repoRootBundleBindings(src) {
  const bound = new Set();
  const rootBase = /(?:const|let|var)\s+(\w+)\s*=\s*path\.join\(\s*(?:REPO_ROOT|DEFAULT_REPO_ROOT|repoRoot)\s*,\s*['"]bundle['"]/g;
  for (const m of src.matchAll(rootBase)) bound.add(m[1]);

  for (const name of [...bound]) {
    const derived = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=\\s*path\\.join\\(\\s*${name}\\s*,`, 'g');
    for (const m of src.matchAll(derived)) bound.add(m[1]);
  }
  return bound;
}

test('no code writes a bundle/ac-dr-*.json artifact into the repo root', () => {
  // The repo-root bundle/ dir holds tracked, hand-authored evidence receipts. A CODE
  // writer there can only emit a literal verdict (it must stay content-stable), so it
  // manufactures a permanent PASS. Runtime verdicts belong in a session-scoped or
  // getDataRoot()-scoped path (e.g. <session>/bundle/ac-dr-02.runtime.json), never here.
  const candidates = [
    ...sourceFilesUnder(path.join(REPO_ROOT, 'bin')),
    ...sourceFilesUnder(path.join(REPO_ROOT, 'extension', 'src')),
    ...sourceFilesUnder(path.join(REPO_ROOT, 'extension', 'tests')),
  ].filter((f) => f !== fileURLToPath(import.meta.url));

  const offenders = candidates.filter((file) => {
    const src = readFileSync(file, 'utf8');
    if (!/ac-dr-/i.test(src)) return false;

    // Direct form: writeFileSync(path.join(REPO_ROOT, 'bundle', 'ac-dr-XX.json'), ...)
    if (/write(?:FileSync|StateFile)\(\s*path\.join\(\s*(?:REPO_ROOT|DEFAULT_REPO_ROOT|repoRoot)\s*,\s*['"]bundle['"]/.test(src)) {
      return true;
    }
    // Indirect form: the write target is an identifier bound to a repo-root bundle path.
    const bound = repoRootBundleBindings(src);
    return [...bound].some((name) => (
      new RegExp(`write(?:FileSync|StateFile)\\(\\s*${name}\\b`).test(src)
    ));
  }).map((f) => path.relative(REPO_ROOT, f));

  assert.deepEqual(
    offenders,
    [],
    `these files write an ac-dr-* artifact into the repo-root bundle/ dir, which can only ever `
    + `assert a hardcoded pass: ${offenders.join(', ')}`,
  );
});

test('no tracked bundle artifact names a test file as its checker', () => {
  // A test-authored receipt is verdict-independent by construction: a failing test throws
  // before it rewrites the artifact, so the committed pass:true survives the regression and
  // verify-bundle can never go red. The real verdict lives in the test's own exit code,
  // which the release gate already enforces via test:integration.
  const offenders = trackedFiles()
    .filter((rel) => /^bundle\/ac-dr-.*\.json$/.test(rel))
    .filter((rel) => {
      let artifact;
      try {
        artifact = JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      } catch {
        return false;
      }
      return typeof artifact.checker === 'string' && /\.test\.(js|ts)$/.test(artifact.checker);
    });

  assert.deepEqual(
    offenders,
    [],
    `these tracked artifacts claim a test as their checker, so a regression leaves the stale `
    + `committed pass on disk: ${offenders.join(', ')}`,
  );
});

// --no-index is load-bearing: without it `git check-ignore` skips paths that are in the index,
// so it reports every TRACKED file as not-ignored no matter how broad the pattern — which makes
// the over-broad assertion below unfalsifiable. --no-index evaluates the pattern itself.
function isIgnored(rel) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', '--', rel], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// Same repo-tree-cleanliness invariant as the artifacts above, one directory over: a file under
// a TRACKED dir must not dirty the tree across runs. extension/audit/ receives two run-scoped
// artifacts — the OUTPUT_FILE_OVERRIDE test path and audit-subsystem-claude-md.sh's own mktemp
// default when TMPDIR is unset. Both clean up in a `finally` a killed process skips, and the
// launch guard (pipeline-runner.ts allowedDirtyPathsForLaunch) exempts only prds/docs, the
// empty .pipeline-runner-dirty-allowed.json allowlist, and gitignore matches — so a strand is a
// hard launch blocker. Asserted as the outcome (is it ignored?), not as .gitignore text.
test('ephemeral subsystem-CLAUDE audit artifacts are git-ignored', () => {
  for (const rel of [
    'extension/audit/subsystem-claude-md.override.99999.json',
    'extension/audit/subsystem-claude-md.Ab3XyZ',
  ]) {
    assert.ok(
      isIgnored(rel),
      `${rel} is ephemeral audit debris; unignored it strands as a dirty path and fails `
      + 'assertCleanWorkingTree, blocking pipeline launch',
    );
  }
});

test('the tracked subsystem-CLAUDE audit report is NOT swept up by the ephemeral rule', () => {
  // Guards the discriminator: ephemeral shapes take a dot after `subsystem-claude-md`, the
  // committed report a dash. An over-broad rule would hide real edits to the tracked report.
  const rel = 'extension/audit/subsystem-claude-md-2026-05-08.json';
  assert.ok(existsSync(path.join(REPO_ROOT, rel)), `${rel} must exist as the tracked report`);
  assert.ok(!isIgnored(rel), `${rel} is the committed report and must stay visible to git`);
});

test('tracked bundle artifacts that remain still satisfy the verifier', () => {
  // Guards the subtraction: removing a false-green artifact must not disturb the legitimate
  // manual receipts (e.g. ac-dr-04d, whose checker is a human RCA, not a test).
  if (!existsSync(BUNDLE_DIR)) return;
  const tracked = trackedFiles().filter((rel) => /^bundle\/ac-dr-.*\.json$/.test(rel));
  for (const rel of tracked) {
    const artifact = JSON.parse(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
    assert.equal(typeof artifact.pass, 'boolean', `${rel} must carry a boolean pass`);
    assert.equal(typeof artifact.checker, 'string', `${rel} must name its checker`);
  }
});
