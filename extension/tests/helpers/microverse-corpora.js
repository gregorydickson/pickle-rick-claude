/**
 * Loader for the vendored microverse session corpora (B-JUDGESCOPE AC-V-1..V-4). These are a
 * size-disciplined slice of three real microverse sessions, copied under
 * tests/fixtures/microverse-corpora/ because the live source directories under
 * ~/.local/share/pickle-rick/sessions/ are subject to pruneOldSessions(sessionsRoot, 7) — see
 * extension/src/services/pickle-utils.ts. Nothing in this repo reads that live sessions root; the
 * fixtures here are the only supported way to replay these three sessions' shapes.
 *
 * Every loader throws, naming the corpus id, on a missing, empty, or shape-invalid fixture — never
 * an empty object or empty array — so a truncated or absent vendor reds loudly instead of silently
 * producing an empty finding set.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURES_ROOT = path.join(__dirname, '..', 'fixtures', 'microverse-corpora');

/** The three vendored corpus ids. Only 2026-09-09-e959390b carries a vendored scope.json. */
export const MICROVERSE_CORPUS_IDS = [
  '2026-09-09-e959390b',
  '2026-09-12-a4d141e1',
  '2026-09-15-c5a7eb48',
];

function assertKnownCorpusId(corpusId) {
  if (!MICROVERSE_CORPUS_IDS.includes(corpusId)) {
    throw new Error(
      `Unknown microverse corpus id: "${corpusId}" (expected one of ${MICROVERSE_CORPUS_IDS.join(', ')})`,
    );
  }
}

function readNonEmptyFile(filePath, describe) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Missing ${describe}: ${filePath}`);
    }
    throw new Error(`Unreadable ${describe}: ${filePath} (${error && error.message})`);
  }
  if (content.trim().length === 0) {
    throw new Error(`Empty ${describe}: ${filePath}`);
  }
  return content;
}

function parseJsonFixture(content, filePath, describe) {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Malformed ${describe} (invalid JSON): ${filePath} (${error && error.message})`);
  }
}

function assertField(obj, field, predicate, describe) {
  if (!predicate(obj[field])) {
    throw new Error(`Malformed ${describe}: missing or invalid field "${field}"`);
  }
}

/**
 * Loads and shape-checks a vendored microverse.json for the given corpus id. Throws, naming the
 * corpus id, on an unknown id, a missing/empty file, invalid JSON, or a missing/malformed
 * `convergence`/`exit_reason` shape.
 */
export function loadMicroverseJson(corpusId, opts = {}) {
  assertKnownCorpusId(corpusId);
  const fixturesRoot = opts.fixturesRoot ?? DEFAULT_FIXTURES_ROOT;
  const describe = `microverse.json fixture for corpus "${corpusId}"`;
  const filePath = path.join(fixturesRoot, corpusId, 'microverse.json');
  const content = readNonEmptyFile(filePath, describe);
  const parsed = parseJsonFixture(content, filePath, describe);

  assertField(parsed, 'exit_reason', (v) => typeof v === 'string' && v.length > 0, describe);
  assertField(parsed, 'convergence', (v) => v !== null && typeof v === 'object', describe);
  assertField(
    parsed.convergence,
    'stall_limit',
    (v) => typeof v === 'number',
    `${describe} (field "convergence.stall_limit")`,
  );
  assertField(
    parsed.convergence,
    'stall_counter',
    (v) => typeof v === 'number',
    `${describe} (field "convergence.stall_counter")`,
  );
  assertField(
    parsed.convergence,
    'history',
    (v) => Array.isArray(v),
    `${describe} (field "convergence.history")`,
  );

  return parsed;
}

/**
 * Loads and shape-checks a vendored scope.json for the given corpus id. Only
 * 2026-09-09-e959390b carries a vendored scope.json (the only populated-scope sample); the other
 * two corpus ids throw a dedicated "not vendored" error rather than a generic missing-file one,
 * since their absence is deliberate per this bundle's size discipline, not an accidental gap.
 */
export function loadMicroverseScope(corpusId, opts = {}) {
  assertKnownCorpusId(corpusId);
  const fixturesRoot = opts.fixturesRoot ?? DEFAULT_FIXTURES_ROOT;
  const filePath = path.join(fixturesRoot, corpusId, 'scope.json');
  if (!opts.fixturesRoot && !fs.existsSync(filePath)) {
    throw new Error(`No scope.json fixture vendored for corpus "${corpusId}"`);
  }
  const describe = `scope.json fixture for corpus "${corpusId}"`;
  const content = readNonEmptyFile(filePath, describe);
  const parsed = parseJsonFixture(content, filePath, describe);

  assertField(
    parsed,
    'allowed_paths',
    (v) => Array.isArray(v) && v.length > 0,
    `${describe} (field "allowed_paths")`,
  );
  assertField(parsed, 'base_sha', (v) => typeof v === 'string' && v.length > 0, describe);
  assertField(parsed, 'head_sha', (v) => typeof v === 'string' && v.length > 0, describe);

  return parsed;
}

function iterationLogPath(corpusId, iteration, fixturesRoot) {
  return path.join(fixturesRoot, corpusId, `tmux_iteration_${iteration}.log`);
}

/**
 * Resolves the absolute path to a vendored tmux_iteration_<n>.log fixture, throwing (naming the
 * corpus id and iteration) if it is missing or empty. Returns a PATH, not parsed content, because
 * production consumers (e.g. microverse-runner.ts:classifyNoCommitExit) take a file path.
 */
export function microverseIterationLogPath(corpusId, iteration, opts = {}) {
  assertKnownCorpusId(corpusId);
  const fixturesRoot = opts.fixturesRoot ?? DEFAULT_FIXTURES_ROOT;
  const filePath = iterationLogPath(corpusId, iteration, fixturesRoot);
  const describe = `tmux_iteration_${iteration}.log fixture for corpus "${corpusId}"`;
  readNonEmptyFile(filePath, describe);
  return filePath;
}

/** Loads the raw text content of a vendored iteration log. See microverseIterationLogPath. */
export function loadMicroverseIterationLog(corpusId, iteration, opts = {}) {
  const filePath = microverseIterationLogPath(corpusId, iteration, opts);
  return fs.readFileSync(filePath, 'utf-8');
}
