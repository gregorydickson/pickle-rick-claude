// @tier: integration
//
// AC-C3 (BUG-2026-08-10-install-sh-destroys-its-own-source-tree, WS-C3): asserts no tracked *.md
// occurrence of PICKLE_INSTALL_ROOT outside prds/** claims the env var overrides install.sh's
// deploy prefix (install.sh:33 unconditionally reassigns it — only --prefix/$PREFIX governs the
// deploy root). Enumerated at runtime from `git ls-files '*.md'` so a future doc reintroducing the
// false claim is caught without editing this test.
//
// prds/** is excluded: the PRDs that define this invariant quote the violating sentence verbatim
// as evidence, so including them would make the invariant fail against its own defining documents.
//
// Enumeration source is overridable via DOC_SCAN_REF (a git ref) for red-proofing against a
// pre-fix tree, without ever mutating the working tree (no git-level undo of any kind):
//   - unset (default): `git ls-files '*.md'` + fs.readFileSync (working tree)
//   - set: `git ls-tree -r --name-only <ref> -- '*.md'` + `git show <ref>:<path>` (git-object reads)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 15_000;
const DOC_SCAN_REF = process.env.DOC_SCAN_REF || '';
// git ls-files/ls-tree pathspecs are resolved relative to cwd; anchor at the repo root so
// root-level docs (e.g. CLAUDE.md) are enumerated when this test runs from extension/.
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  timeout: GIT_TIMEOUT_MS,
}).trim();

function listMdFiles() {
  // Filter the .md extension in JS rather than via a git pathspec: `ls-tree -r -- '*.md'`
  // silently matches zero files on some refs (pathspec-glob quirk), which would make an
  // empty enumeration masquerade as a clean pass. List everything, then filter.
  const raw = DOC_SCAN_REF
    ? execFileSync('git', ['-C', REPO_ROOT, 'ls-tree', '-r', '--name-only', DOC_SCAN_REF], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
      })
    : execFileSync('git', ['-C', REPO_ROOT, 'ls-files'], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
      });
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.endsWith('.md') && !line.startsWith('prds/'));
}

function readMdFile(filePath) {
  if (!DOC_SCAN_REF) {
    return fs.readFileSync(path.join(REPO_ROOT, filePath), 'utf8');
  }
  return execFileSync('git', ['-C', REPO_ROOT, 'show', `${DOC_SCAN_REF}:${filePath}`], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
  });
}

function findOccurrences() {
  const occurrences = [];
  for (const filePath of listMdFiles()) {
    const content = readMdFile(filePath);
    const lines = content.split('\n');
    lines.forEach((text, idx) => {
      if (text.includes('PICKLE_INSTALL_ROOT')) {
        occurrences.push({ file: filePath, lineNo: idx + 1, text });
      }
    });
  }
  return occurrences;
}

// Matching rule (documented so a future reader can widen it deliberately): a line is a VIOLATION
// only if it names install.sh AND prefix AND an override/overrides/overriding token, UNLESS a
// negation word (not / n't / never) appears in the 40 characters immediately preceding the
// override token — e.g. "Does NOT override install.sh's deploy prefix" is correct usage, while
// "Deploy-prefix override for install.sh" is the violation this invariant exists to catch.
function claimsOverride(lineText) {
  const lower = lineText.toLowerCase();
  if (!lower.includes('install.sh')) return false;
  if (!lower.includes('prefix')) return false;
  const overrideIdx = lower.search(/overrid/);
  if (overrideIdx === -1) return false;
  const windowStart = Math.max(0, overrideIdx - 40);
  const before = lower.slice(windowStart, overrideIdx);
  if (/\b(not|n't|never)\b/.test(before)) return false;
  return true;
}

const occurrences = findOccurrences();

test('at least one PICKLE_INSTALL_ROOT occurrence is enumerated outside prds/**', () => {
  assert.ok(
    occurrences.length > 0,
    'enumeration found zero occurrences — DOC_SCAN_REF or git ls-files may be misconfigured'
  );
});

for (const { file, lineNo, text } of occurrences) {
  test(`${file}:${lineNo} does not claim PICKLE_INSTALL_ROOT overrides the install.sh prefix`, () => {
    assert.equal(
      claimsOverride(text),
      false,
      `${file}:${lineNo} claims the env var overrides the install.sh deploy prefix: ${text.trim()}`
    );
  });
}
