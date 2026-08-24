/**
 * Ticket 984a768c: the replay scaffold for the 18-sha did-we-count corpus. Reports
 * `no-check-yet` per entry until a real check is registered — tickets 30/40 supply the
 * detection-rule checks, ticket 80 (7b4f5d60) wires them into the replay and runs the
 * full checkout-parent/checkout-fix comparison. This ticket's job is the reporting
 * contract (per-sha, honest, ceiling stated up front), not the git checkout plumbing.
 *
 * Binding reporting rule, applied to itself: an entry with no registered check is reported
 * `no-check-yet`, NEVER stretched into a pass. `CheckRegistry` is empty until
 * `buildAstCheckRegistry()` supplies real checks; any sha it does not cover — including two
 * of the nine `detectable`-bucket shas (`697fd734`, `39c5b33e`: process-identity defects the
 * four landed rules do not reach) — stays `no-check-yet`, and `semantic`/`out-of-reach`
 * shas are never given a check at all.
 */
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import ts from 'typescript';
import { CORPUS, DETECTABLE_CEILING, type CorpusBucket, type CorpusEntry } from '../services/did-we-count-corpus.js';

// `eslint-plugin-pickle/index.js` sits OUTSIDE this project's `rootDir: "src"` — a static
// `import` pulls it into the tsc program and collides its emitted output with its own
// input (`TS5055`). Loading it via a non-literal `import()` specifier keeps it out of the
// compiled program entirely; it is a plain ESLint plugin object at runtime either way.
// The path is relative to the COMPILED file's location (`bin/did-we-count-replay.js`,
// one level under `extension/`), not this source file's (`src/bin/`, two levels under).
const pickleModuleUrl = new URL('../eslint-plugin-pickle/index.js', import.meta.url).href;
const pickleModule = (await import(pickleModuleUrl)) as { default: Record<string, unknown> };
const pickle: Record<string, unknown> = pickleModule.default;

/** Keyed by sha; a registered check reports true/false for parent or fix commit. */
export type CheckRegistry = Record<string, (parentOrFix: 'parent' | 'fix') => boolean>;

export interface ReplayEntryResult {
  sha: string;
  bucket: CorpusBucket;
  status: 'no-check-yet' | 'pass' | 'fail';
}

export function replayEntry(entry: CorpusEntry, registry: CheckRegistry): ReplayEntryResult {
  const check = registry[entry.sha];
  if (!check) {
    return { sha: entry.sha, bucket: entry.bucket, status: 'no-check-yet' };
  }
  const firedOnParent = check('parent');
  const firedOnFix = check('fix');
  const matched = firedOnParent === entry.expect_fire_on_parent && firedOnFix === entry.expect_fire_on_fix;
  return { sha: entry.sha, bucket: entry.bucket, status: matched ? 'pass' : 'fail' };
}

export function replayCorpus(corpus: CorpusEntry[], registry: CheckRegistry): ReplayEntryResult[] {
  return corpus.map((entry) => replayEntry(entry, registry));
}

export function formatReplayReport(results: ReplayEntryResult[]): string {
  const rows = results.map((r) => `| \`${r.sha}\` | ${r.bucket} | ${r.status} |`);
  return [
    '# did-we-count replay',
    '',
    `- **Detectable ceiling**: ${DETECTABLE_CEILING}/${results.length}`,
    '',
    '| sha | bucket | status |',
    '|-----|--------|--------|',
    ...rows,
    '',
  ].join('\n');
}

// ─── AST-check wiring (ticket 7b4f5d60): four landed rules (ticket d7c017ff) ───────
//
// Each covered sha's check fetches the real historical file content at the parent
// commit (`<sha>~1`) and at the fix commit (`<sha>`), isolates the smallest enclosing
// function around the known defect site via the TypeScript compiler API (never a
// hand-rolled brace counter, and never a whole-file scan — a whole-file check would
// count unrelated pre-existing hits elsewhere in a large file as this sha's verdict),
// and runs ONLY the one rule that targets that defect class through `eslint`'s `Linter`
// with the `typescript-eslint` parser (syntax-only — none of these four rules need type
// information). "Fires" means the rule reported >=1 message on that isolated snippet.

const REPLAY_GIT_MAX_BUFFER = 64 * 1024 * 1024;
const REPLAY_GIT_TIMEOUT_MS = 10_000;

function resolveReplayRepoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    encoding: 'utf-8',
    timeout: REPLAY_GIT_TIMEOUT_MS,
  }).trim();
}

function readFileAtRef(repoRoot: string, ref: string, relPath: string): string {
  return execFileSync('git', ['show', `${ref}:${relPath}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: REPLAY_GIT_TIMEOUT_MS,
    maxBuffer: REPLAY_GIT_MAX_BUFFER,
  });
}

/**
 * Finds the innermost function-like node (declaration, expression, arrow, or method)
 * enclosing `anchorIndex` and returns its source text, wrapped as a standalone
 * statement when the node itself is only an expression (arrow/function expression).
 */
function extractEnclosingFunctionSnippet(content: string, anchor: string): string {
  const anchorIndex = content.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error(`did-we-count-replay: anchor not found in source: ${JSON.stringify(anchor)}`);
  }
  const sourceFile = ts.createSourceFile('replay-snippet.ts', content, ts.ScriptTarget.Latest, true);
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) > anchorIndex || node.getEnd() < anchorIndex) return;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) {
    throw new Error(`did-we-count-replay: no enclosing function for anchor: ${JSON.stringify(anchor)}`);
  }
  const text = content.slice(found.getStart(sourceFile), found.getEnd());
  return ts.isArrowFunction(found) || ts.isFunctionExpression(found) ? `const __replayFn = ${text};` : text;
}

const replayLinter = new Linter();

function ruleFiresOnSnippet(ruleId: string, snippet: string): boolean {
  const messages = replayLinter.verify(snippet, {
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
    plugins: { pickle },
    rules: { [ruleId]: 'error' },
  });
  return messages.some((m) => m.ruleId === ruleId);
}

interface AstCheckSpec {
  sha: string;
  ruleId: string;
  file: string;
  anchor: string;
}

/**
 * Only 7 of the 9 `detectable`-bucket shas are covered by the 4 landed rules — the
 * remaining two process-identity shas (`697fd734`, `39c5b33e`) are membership/identity
 * predicate defects (pid-vs-pgid self-protection, registry pid-as-identity) that
 * `require-group-kill-for-spawned-child` does not reach; see `did-we-count-corpus.ts`.
 * Widening that rule to try to catch them is exactly the "stretch a matcher" move this
 * ticket is forbidden from making — they stay `no-check-yet`, honestly.
 */
const AST_CHECKS: readonly AstCheckSpec[] = [
  {
    sha: '7e06e8b2',
    ruleId: 'pickle/require-max-buffer-on-capture',
    file: 'extension/src/bin/mux-runner.ts',
    anchor: 'export function runBetweenTicketFastTests(',
  },
  {
    sha: 'e2804228',
    ruleId: 'pickle/require-max-buffer-on-capture',
    file: 'extension/src/bin/mux-runner.ts',
    anchor: 'spawnSync(phase.verify,',
  },
  {
    sha: 'd24cec5e',
    ruleId: 'pickle/require-max-buffer-on-capture',
    file: 'extension/src/bin/spawn-refinement-team.ts',
    anchor: 'function resolveTrackedSuffixMatches(',
  },
  {
    sha: 'c7c85ef3',
    ruleId: 'pickle/require-spawn-result-error-check',
    file: 'extension/src/bin/check-scope-diff.ts',
    anchor: 'function getStagedPaths(',
  },
  {
    sha: '0cf3b8e3',
    ruleId: 'pickle/no-invalid-checkout-index-stage',
    file: 'extension/src/hooks/handlers/tsc-gate.ts',
    anchor: 'function materializeStagedTree(',
  },
  {
    sha: 'ff8d4739',
    ruleId: 'pickle/require-group-kill-for-spawned-child',
    file: 'extension/src/bin/jar-runner.ts',
    anchor: 'async function runTask(',
  },
  {
    sha: '41b9b255',
    ruleId: 'pickle/require-group-kill-for-spawned-child',
    file: 'extension/src/bin/microverse-runner.ts',
    anchor: 'function spawnWithClosedStdin(',
  },
];

export function buildAstCheckRegistry(repoRoot: string = resolveReplayRepoRoot()): CheckRegistry {
  const registry: CheckRegistry = {};
  for (const spec of AST_CHECKS) {
    registry[spec.sha] = (parentOrFix: 'parent' | 'fix'): boolean => {
      const ref = parentOrFix === 'parent' ? `${spec.sha}~1` : spec.sha;
      const content = readFileAtRef(repoRoot, ref, spec.file);
      const snippet = extractEnclosingFunctionSnippet(content, spec.anchor);
      return ruleFiresOnSnippet(spec.ruleId, snippet);
    };
  }
  return registry;
}

/** Best-effort: an unavailable git/repo yields an empty registry, never a stretched one. */
function buildRegistryOrEmpty(): CheckRegistry {
  try {
    return buildAstCheckRegistry();
  } catch {
    return {};
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'did-we-count-replay.js') {
  const results = replayCorpus(CORPUS, buildRegistryOrEmpty());
  process.stdout.write(formatReplayReport(results));
}
