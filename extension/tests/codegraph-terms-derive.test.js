// @tier: fast
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { deriveCodegraphTerms } from '../bin/spawn-morty.js';
import { createResolverCache } from '../services/signature-caller-gap.js';
import { computeOneHop } from '../services/scope-resolver.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FIXTURES_DIR = path.resolve(import.meta.dirname, 'fixtures', 'codegraph-terms');
const COMPILED_SPAWN_MORTY_PATH = path.resolve(import.meta.dirname, '..', 'bin', 'spawn-morty.js');

const KEYWORD_STOPWORDS = new Set([
  'return', 'break', 'while', 'for', 'if', 'else', 'const', 'let', 'var', 'function',
  'class', 'true', 'false', 'null', 'undefined', 'new', 'typeof', 'instanceof', 'in',
  'of', 'do', 'switch', 'case', 'default', 'try', 'catch', 'finally', 'throw', 'delete',
  'void', 'async', 'await', 'yield', 'static', 'import', 'export', 'extends',
  'implements', 'interface', 'enum', 'namespace', 'public', 'private', 'protected',
  'readonly', 'super', 'get', 'set',
]);
const BARE_LINE_REF_RE = /^:?~?\d+(-\d+)?\+?$/;
const PATH_LINE_REF_RE = /^[\w./-]+:~?\d+(-\d+)?\+?$/;
const MAX_SPAN_LEN = 40;

// --- fixture loading ---------------------------------------------------------

function loadFixture(id) {
  const raw = readFileSync(path.join(FIXTURES_DIR, `${id}.md`), 'utf-8');
  const titleMatch = raw.match(/^title:\s*"(.*)"\s*$/m);
  if (!titleMatch) { throw new Error(`fixture ${id} has no title: frontmatter field`); }
  const title = titleMatch[1];
  // Production passes the FULL ticket file content as acText (spawn-morty.ts:381,408
  // fs.readFileSync of the whole file), not just the post-frontmatter body — match that here.
  return { title, body: raw };
}

// --- independent ground-truth oracle (cross-file exported primitives only) --

function resolvesInRepo(term, repoRoot, cache) {
  const normalized = term.replace(/\(\)$/, '');
  const parts = normalized.split('.').filter(Boolean);
  if (parts.length === 0) { return false; }
  const partPatterns = parts.map((part) => new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
  const candidates = cache.trackedSourceFiles.filter((file) => {
    const abs = path.join(repoRoot, file);
    let content = cache.fileContents.get(abs);
    if (content === undefined) {
      try {
        content = readFileSync(abs, 'utf-8');
        cache.fileContents.set(abs, content);
      } catch {
        return false;
      }
    }
    return partPatterns.every((pattern) => pattern.test(content));
  });
  if (candidates.length === 0) { return false; }
  if (candidates.length === 1) { return true; }
  try {
    computeOneHop(candidates.slice(0, 1), repoRoot, { findImportersTimeoutMs: 2000 });
    return true;
  } catch {
    return false;
  }
}

function countResolving(terms, repoRoot, cache) {
  return terms.filter((t) => resolvesInRepo(t, repoRoot, cache)).length;
}

// --- AC-CGH-D1: filtered, ranked, resolving output over the real corpus -----

const REAL_FIXTURES = ['de25ce90', 'be604d1d', 'a5f8cf4f', 'a3812edd'];

for (const id of REAL_FIXTURES) {
  test(`AC-CGH-D1: ${id} — derived terms resolve, no noise leaks through`, () => {
    const { title, body } = loadFixture(id);
    const cache = createResolverCache(REPO_ROOT, 5000);
    const derived = deriveCodegraphTerms(title, body, 8, { repoRoot: REPO_ROOT, cache });

    assert.ok(derived.length > 0, `${id}: expected at least one derived term`);

    for (const term of derived) {
      assert.equal(term.length <= MAX_SPAN_LEN, true, `${id}: term "${term}" exceeds ${MAX_SPAN_LEN} chars`);
      assert.equal(BARE_LINE_REF_RE.test(term), false, `${id}: term "${term}" is a bare line-ref`);
      assert.equal(PATH_LINE_REF_RE.test(term), false, `${id}: term "${term}" is a path-qualified line-ref`);
      assert.equal(KEYWORD_STOPWORDS.has(term.toLowerCase()), false, `${id}: term "${term}" is a keyword`);
    }

    const resolvingCount = countResolving(derived, REPO_ROOT, cache);
    const expectedMin = Math.ceil(0.5 * Math.min(derived.length, 8));
    assert.ok(
      resolvingCount >= expectedMin,
      `${id}: expected >= ${expectedMin} resolving terms, got ${resolvingCount} of ${derived.length} (${derived.join(', ')})`,
    );
  });
}

// --- be604d1d regression: pre-fix raw first-8 backticks are noise-dominated, post-fix is clean --

test('AC-CGH-D1 regression: be604d1d — pre-fix raw first-8 backticks are noise-dominated (document-order harvest, zero filtering)', () => {
  const { title, body } = loadFixture('be604d1d');

  const rawSpans = [];
  for (const m of `${title}\n${body}`.matchAll(/`([^`\n]+)`/g)) {
    rawSpans.push(m[1].trim());
    if (rawSpans.length >= 8) { break; }
  }
  assert.ok(rawSpans.length > 0, 'be604d1d: expected at least one raw backtick span');

  // Same predicates deriveCodegraphTerms now applies via isCodegraphTermNoise — proves the
  // documented pre-fix defect: the unfiltered first-8-in-document-order harvest is dominated
  // by line-refs/paths/oversized prose, not usable symbols (Problem section: "the better the
  // citation discipline, the worse the payload").
  const noiseCount = rawSpans.filter(
    (v) => v.length > MAX_SPAN_LEN || BARE_LINE_REF_RE.test(v) || PATH_LINE_REF_RE.test(v) || KEYWORD_STOPWORDS.has(v.toLowerCase()),
  ).length;
  assert.ok(
    noiseCount >= Math.ceil(rawSpans.length / 2),
    `be604d1d: expected a majority of the raw first-${rawSpans.length} spans to be noise, only ${noiseCount} were (${rawSpans.join(', ')})`,
  );
});

test('AC-CGH-D1 regression: be604d1d — post-fix deriveCodegraphTerms resolves >= 1 symbol', () => {
  const { title, body } = loadFixture('be604d1d');
  const cache = createResolverCache(REPO_ROOT, 5000);

  const derived = deriveCodegraphTerms(title, body, 8, { repoRoot: REPO_ROOT, cache });
  const resolvingCount = countResolving(derived, REPO_ROOT, cache);

  assert.ok(resolvingCount >= 1, `be604d1d: post-fix expected >= 1 resolving term, got ${resolvingCount} of ${derived.join(', ')}`);
});

// --- AC-CGH-D2: all-noise fixture yields no terms, and the skip is wired ----

test('AC-CGH-D2: all-noise fixture yields zero terms', () => {
  const { title, body } = loadFixture('all-noise');
  const derived = deriveCodegraphTerms(title, body, 8, { repoRoot: REPO_ROOT });
  assert.deepEqual(derived, []);
});

test('AC-CGH-D2: the empty-terms contract is wired to a real "no section emitted" skip', () => {
  const compiledSource = readFileSync(COMPILED_SPAWN_MORTY_PATH, 'utf-8');
  // The FIRST match is the `export function deriveCodegraphTerms(` declaration; the real call
  // site inside buildCodegraphContextSection is the LAST occurrence in the compiled file.
  const callSiteIdx = compiledSource.lastIndexOf('deriveCodegraphTerms(');
  assert.ok(callSiteIdx !== -1, 'compiled spawn-morty.js: deriveCodegraphTerms( call site not found');
  assert.notEqual(callSiteIdx, compiledSource.indexOf('deriveCodegraphTerms('), 'expected the call site to be distinct from the function declaration');

  const afterCallSite = compiledSource.slice(callSiteIdx, callSiteIdx + 400);
  assert.match(afterCallSite, /terms\.length === 0/, 'expected a terms.length === 0 guard immediately after the deriveCodegraphTerms( call');
  assert.match(afterCallSite, /no_terms/, 'expected the no_terms skip reason immediately after the deriveCodegraphTerms( call');
});

// --- AC-CGH-D4: one shared cache, bounded file reads, no unbounded rescans --

test('AC-CGH-D4: many-terms fixture reuses ONE shared cache across calls, bounded file reads', () => {
  const { title, body } = loadFixture('many-terms');
  const cache = createResolverCache(REPO_ROOT, 5000);

  const midpoint = Math.floor(title.length / 2);
  const titleFirstHalf = title.slice(0, midpoint);
  const titleSecondHalf = title.slice(midpoint);

  const start = Date.now();
  const first = deriveCodegraphTerms(titleFirstHalf, body, 8, { repoRoot: REPO_ROOT, cache });
  const second = deriveCodegraphTerms(titleSecondHalf, body, 8, { repoRoot: REPO_ROOT, cache });
  const elapsedMs = Date.now() - start;

  assert.ok(Array.isArray(first));
  assert.ok(Array.isArray(second));
  assert.ok(
    cache.fileContents.size <= cache.trackedSourceFiles.length,
    `expected fileContents.size (${cache.fileContents.size}) <= trackedSourceFiles.length (${cache.trackedSourceFiles.length}) — each tracked file read at most once`,
  );
  assert.ok(elapsedMs < 4500, `expected both calls to complete well under the 5000ms wall bound, took ${elapsedMs}ms`);
});
