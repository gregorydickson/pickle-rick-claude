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
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import ts from 'typescript';
import { CORPUS, DETECTABLE_CEILING, type CorpusBucket, type CorpusEntry } from '../services/did-we-count-corpus.js';
import { UNBOUNDED_READ_MAX_BUFFER } from '../types/index.js';

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

const REPLAY_GIT_TIMEOUT_MS = 10_000;

/**
 * The repo root this module lives in, derived from its own location.
 *
 * `fileURLToPath`, never the `URL#pathname` accessor: a `file://` URL is
 * percent-encoded by specification, so `pathname` hands back `my%20repo` for a
 * checkout under `my repo` and every path-consuming caller gets a directory that
 * does not exist (measured: `execFileSync` throws ENOENT). `import.meta.url` is
 * injectable so the decoding can be exercised against a real spaced checkout
 * without relocating this module.
 */
export function resolveReplayRepoRoot(moduleUrl: string = import.meta.url): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: path.dirname(fileURLToPath(moduleUrl)),
    encoding: 'utf-8',
    timeout: REPLAY_GIT_TIMEOUT_MS,
  }).trim();
}

function readFileAtRef(repoRoot: string, ref: string, relPath: string): string {
  return execFileSync('git', ['show', `${ref}:${relPath}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: REPLAY_GIT_TIMEOUT_MS,
    maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
  });
}

/**
 * Finds the innermost function-like node (declaration, expression, arrow, or method)
 * enclosing `anchorIndex` and returns its source text, wrapped as a standalone
 * statement when the node itself is only an expression (arrow/function expression).
 */
export function extractEnclosingFunctionSnippet(content: string, anchor: string): string {
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

/**
 * A `Linter.verify()` parse failure comes back as a single `fatal` message with
 * `ruleId: null` — indistinguishable, under a bare `.some(m => m.ruleId === ruleId)`,
 * from "the rule ran and found nothing". Every AST check expects `fire_on_fix: false`,
 * so that silent `false` would satisfy the fix-side arm of the oracle having linted
 * NOTHING: the exact did-we-count defect class this corpus exists to prevent, inside
 * its own replay harness. `extractEnclosingFunctionSnippet` can emit an unparseable
 * snippet today — a `ts.isMethodDeclaration` hit is returned bare, and `foo() { ... }`
 * is not a standalone statement — so this is a live path, not a hypothetical one.
 * Throwing matches how the rest of this measurement path already reports
 * cannot-measure (anchor not found / no enclosing function).
 */
export function ruleFiresOnSnippet(ruleId: string, snippet: string): boolean {
  const messages = replayLinter.verify(snippet, {
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
    plugins: { pickle },
    rules: { [ruleId]: 'error' },
  });
  const fatal = messages.find((m) => m.fatal);
  if (fatal) {
    throw new Error(
      `did-we-count-replay: snippet did not parse (${fatal.message}) — ${ruleId} was never measured, ` +
      'and an unmeasured rule must not be reported as "did not fire"',
    );
  }
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

// ─── Ticket fb9ad56c: ROOT G2 replay — reproduce a ticket's recorded tier red at its ─────
// own completion commit. This is a SEPARATE reporting contract from the AST-check replay
// above (a different corpus, a different question), added alongside it in this same
// read-only replay bin per this ticket's instruction to extend rather than fork.
//
// Binding reporting rule (mirrors the file's existing one): `could-not-measure` is a
// first-class outcome, never collapsed into `not-reproduce`. A missing session dir, a
// ticket with no completion commit (e.g. a `zero_diff_intent: already-satisfied` ticket
// that closed with no diff to attribute), an unreadable `worker_gate_failed` verdict, an
// unresolvable sha, or a timed-out gate run are ALL `could-not-measure` — never stretched
// into either a `reproduce` or `not-reproduce` verdict.

export type TicketReplayOutcome = 'reproduce' | 'not-reproduce' | 'could-not-measure';

export interface TicketReplayResult {
  ticketId: string;
  outcome: TicketReplayOutcome;
  detail: string;
  completionCommit: string | null;
  gatePhase: string | null;
}

const TICKET_REPLAY_GIT_TIMEOUT_MS = 30_000;
const DEFAULT_TICKET_REPLAY_GATE_TIMEOUT_MS = 900_000;

/** One-level scan for the session directory holding `rick_ticket_<ticketId>.md`. Never throws. */
export function findTicketSessionDir(sessionsRoot: string, ticketId: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ticketDir = path.join(sessionsRoot, entry.name, ticketId);
    const ticketFile = path.join(ticketDir, `rick_ticket_${ticketId}.md`);
    if (fs.existsSync(ticketFile)) return path.join(sessionsRoot, entry.name);
  }
  return null;
}

/**
 * Reads `completion_commit` (falling back to `completion_commit_inferred`) from a ticket
 * markdown file's YAML-ish frontmatter block. Quoted or bare, 7-40 hex chars — the R-CCQF
 * shape documented in the root CLAUDE.md, reimplemented minimally here rather than pulling
 * in the session/state-context oracle used by the completion-evidence service. Returns null
 * on any missing/unreadable file or absent/malformed value — never throws.
 */
export function readTicketCompletionCommit(ticketMdPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(ticketMdPath, 'utf-8');
  } catch {
    return null;
  }
  for (const field of ['completion_commit', 'completion_commit_inferred']) {
    const match = raw.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
    if (!match) continue;
    const value = match[1].trim().replace(/^['"]|['"]$/g, '').trim();
    if (/^[0-9a-f]{7,40}$/i.test(value)) return value;
  }
  return null;
}

/**
 * Reads a session's `state.json` and returns the `gate_phase` of the LAST `worker_gate_failed`
 * activity entry naming this ticket id. Returns null on unreadable/unparseable state or no
 * matching event — the "unreadable verdict" could-not-measure case.
 */
export function readRecordedGatePhase(stateJsonPath: string, ticketId: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(stateJsonPath, 'utf-8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const activity = (parsed as { activity?: unknown }).activity;
  if (!Array.isArray(activity)) return null;
  let found: string | null = null;
  for (const entry of activity) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { event?: unknown; ticket_id?: unknown; gate_phase?: unknown };
    if (e.event === 'worker_gate_failed' && e.ticket_id === ticketId && typeof e.gate_phase === 'string') {
      found = e.gate_phase;
    }
  }
  return found;
}

/** Maps a recorded gate phase to the npm argv that reproduces it. Unrecognized -> null. */
export function resolveGateCommand(gatePhase: string): string[] | null {
  if (gatePhase === 'test:fast' || gatePhase === 'test:integration') {
    return ['run', gatePhase];
  }
  return null;
}

/**
 * Materializes `<sha>` into `destDir` via `git worktree add --detach` — a REAL working tree
 * sharing this repo's object store, never a `git archive | tar` extraction. This matters:
 * the recorded tier command (`npm run test:fast`) is itself a test suite whose own tests
 * shell out to `git ls-files`/`git rev-parse` and read repo-root files (e.g.
 * `.claude/commands/*.md`) one level ABOVE `extension/` — an `extension/`-only tar
 * extraction with no `.git` produces exactly those two classes of spurious failure,
 * independent of whatever the ticket's own commit actually did. `git worktree add` neither
 * checks out, switches, nor resets the CURRENT working tree — it creates an entirely
 * separate, detached-HEAD directory the primary checkout never sees. Throws on any failure —
 * the caller (`replayTicketAtCompletionCommit`) converts that into `could-not-measure`.
 */
export function materializeCommitWorktree(repoRoot: string, sha: string, destDir: string): void {
  const result = spawnSync('git', ['worktree', 'add', '--detach', destDir, sha], {
    cwd: repoRoot,
    timeout: TICKET_REPLAY_GIT_TIMEOUT_MS,
    maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`git worktree add ${sha} failed: ${result.stderr?.toString() ?? result.error?.message ?? 'unknown error'}`);
  }
}

/**
 * Removes a worktree created by `materializeCommitWorktree` and prunes its administrative
 * state. Best-effort by design (never throws): a cleanup failure must never mask, or be
 * mistaken for, the replay verdict it runs after.
 */
export function cleanupCommitWorktree(repoRoot: string, destDir: string): void {
  try {
    fs.rmSync(destDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  try {
    spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, timeout: TICKET_REPLAY_GIT_TIMEOUT_MS });
  } catch {
    // best-effort
  }
}

/** Symlinks the live `extension/node_modules` into a materialized worktree. Throws on failure. */
export function symlinkNodeModules(repoRoot: string, destDir: string): void {
  const src = path.join(repoRoot, 'extension', 'node_modules');
  const dest = path.join(destDir, 'extension', 'node_modules');
  fs.symlinkSync(src, dest, 'dir');
}

function commitResolvesOnCurrentBranch(repoRoot: string, sha: string): boolean {
  const result = spawnSync('git', ['cat-file', '-t', sha], {
    cwd: repoRoot,
    timeout: TICKET_REPLAY_GIT_TIMEOUT_MS,
    encoding: 'utf-8',
  });
  return result.status === 0 && result.stdout.trim() === 'commit';
}

export interface TicketReplayDeps {
  sessionsRoot: string;
  repoRoot: string;
  /** Runs the resolved gate argv inside `extensionDir`; injectable for tests. */
  runGateCommand: (extensionDir: string, args: string[]) => { ok: boolean; timedOut: boolean };
  materialize?: typeof materializeCommitWorktree;
  symlink?: typeof symlinkNodeModules;
  cleanup?: typeof cleanupCommitWorktree;
  /** Returns a fresh, NOT-yet-existing path for `git worktree add` to create; injectable. */
  makeTempDir?: () => string;
  resolvesOnCurrentBranch?: (repoRoot: string, sha: string) => boolean;
}

/** `git worktree add` requires its target path not to already exist. */
function defaultMakeTempDir(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-ticket-replay-'));
  return path.join(base, 'worktree');
}

/** Default gate-command runner: a real `npm run <phase>` inside the materialized tree. */
export function defaultRunGateCommand(extensionDir: string, args: string[]): { ok: boolean; timedOut: boolean } {
  const timeoutMs = Number(process.env.PICKLE_TICKET_REPLAY_GATE_TIMEOUT_MS) > 0
    ? Number(process.env.PICKLE_TICKET_REPLAY_GATE_TIMEOUT_MS)
    : DEFAULT_TICKET_REPLAY_GATE_TIMEOUT_MS;
  const result = spawnSync('npm', args, {
    cwd: extensionDir,
    timeout: timeoutMs,
    maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { ok: false, timedOut: true };
  }
  return { ok: result.status === 0, timedOut: false };
}

/** A resolved, ready-to-run replay target, or the could-not-measure result explaining why not. */
type TicketReplayTarget =
  | { ready: true; completionCommit: string; gatePhase: string; gateArgs: string[] }
  | { ready: false; result: TicketReplayResult };

function notMeasured(
  ticketId: string,
  detail: string,
  completionCommit: string | null = null,
  gatePhase: string | null = null,
): TicketReplayResult {
  return { ticketId, outcome: 'could-not-measure', detail, completionCommit, gatePhase };
}

/**
 * Locates the ticket's session, completion commit, and recorded gate command, and confirms
 * the commit resolves on the current branch. Never throws — resolves to the `could-not-measure`
 * result directly when any lookup fails, so the caller only branches once on `ready`.
 */
function resolveTicketReplayTarget(ticketId: string, deps: TicketReplayDeps): TicketReplayTarget {
  const sessionDir = findTicketSessionDir(deps.sessionsRoot, ticketId);
  if (!sessionDir) {
    return { ready: false, result: notMeasured(ticketId, `no session dir found for ticket ${ticketId}`) };
  }

  const ticketMdPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
  const completionCommit = readTicketCompletionCommit(ticketMdPath);
  if (!completionCommit) {
    return {
      ready: false,
      result: notMeasured(
        ticketId,
        `no completion_commit stamped for ticket ${ticketId} (zero-diff-intent or unattributed close — no tree to replay at)`,
      ),
    };
  }

  const gatePhase = readRecordedGatePhase(path.join(sessionDir, 'state.json'), ticketId);
  if (!gatePhase) {
    return {
      ready: false,
      result: notMeasured(ticketId, `no worker_gate_failed event found for ticket ${ticketId}`, completionCommit),
    };
  }

  const gateArgs = resolveGateCommand(gatePhase);
  if (!gateArgs) {
    return {
      ready: false,
      result: notMeasured(ticketId, `unrecognized gate phase "${gatePhase}" for ticket ${ticketId}`, completionCommit, gatePhase),
    };
  }

  const resolves = deps.resolvesOnCurrentBranch ?? commitResolvesOnCurrentBranch;
  if (!resolves(deps.repoRoot, completionCommit)) {
    return {
      ready: false,
      result: notMeasured(
        ticketId,
        `completion commit ${completionCommit} does not resolve to a commit on the current branch`,
        completionCommit,
        gatePhase,
      ),
    };
  }

  return { ready: true, completionCommit, gatePhase, gateArgs };
}

/**
 * Given a ticket id, reads its recorded completion commit and recorded tier command, replays
 * that exact command against that commit's own historical `extension/` tree, and reports
 * reproduce / not-reproduce / could-not-measure. Report-only: never mutates the real working
 * tree, never breaks a phase loop, never throws — every failure mode maps to
 * `could-not-measure` with an explanatory `detail`.
 */
export function replayTicketAtCompletionCommit(ticketId: string, deps: TicketReplayDeps): TicketReplayResult {
  try {
    const target = resolveTicketReplayTarget(ticketId, deps);
    if (!target.ready) return target.result;
    const { completionCommit, gatePhase, gateArgs } = target;

    const makeTempDir = deps.makeTempDir ?? defaultMakeTempDir;
    const materialize = deps.materialize ?? materializeCommitWorktree;
    const symlink = deps.symlink ?? symlinkNodeModules;
    const cleanup = deps.cleanup ?? cleanupCommitWorktree;
    const destDir = makeTempDir();
    // Cleanup covers the WHOLE materialize+run span in one finally: a worktree can be
    // created by `materialize` and then leaked forever if `symlink` throws before the run
    // ever starts — splitting cleanup across two try blocks left exactly that gap.
    try {
      try {
        materialize(deps.repoRoot, completionCommit, destDir);
        symlink(deps.repoRoot, destDir);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return notMeasured(ticketId, `could not materialize ${completionCommit}: ${msg}`, completionCommit, gatePhase);
      }

      const extensionDir = path.join(destDir, 'extension');
      const { ok, timedOut } = deps.runGateCommand(extensionDir, gateArgs);
      if (timedOut) {
        return notMeasured(ticketId, `gate command "npm ${gateArgs.join(' ')}" timed out`, completionCommit, gatePhase);
      }
      return {
        ticketId,
        outcome: ok ? 'not-reproduce' : 'reproduce',
        detail: ok
          ? `"npm ${gateArgs.join(' ')}" exited 0 at ${completionCommit} — recorded red did NOT reproduce`
          : `"npm ${gateArgs.join(' ')}" exited non-zero at ${completionCommit} — recorded red reproduced`,
        completionCommit,
        gatePhase,
      };
    } finally {
      cleanup(deps.repoRoot, destDir);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return notMeasured(ticketId, `unexpected error replaying ticket ${ticketId}: ${msg}`);
  }
}

export function formatTicketReplayReport(results: TicketReplayResult[]): string {
  const rows = results.map(
    (r) => `| \`${r.ticketId}\` | ${r.outcome} | ${r.completionCommit ?? '—'} | ${r.gatePhase ?? '—'} | ${r.detail} |`,
  );
  return [
    '# ROOT G2 ticket replay',
    '',
    '| ticket | outcome | completion_commit | gate_phase | detail |',
    '|--------|---------|--------------------|------------|--------|',
    ...rows,
    '',
  ].join('\n');
}

if (process.argv[1] && path.basename(process.argv[1]) === 'did-we-count-replay.js') {
  const ticketFlagIndex = process.argv.indexOf('--tickets');
  if (ticketFlagIndex !== -1) {
    const ids = process.argv.slice(ticketFlagIndex + 1);
    const sessionsRoot = path.join(os.homedir(), '.local', 'share', 'pickle-rick', 'sessions');
    const repoRoot = resolveReplayRepoRoot();
    const results = ids.map((id) =>
      replayTicketAtCompletionCommit(id, { sessionsRoot, repoRoot, runGateCommand: defaultRunGateCommand }),
    );
    process.stdout.write(formatTicketReplayReport(results));
  } else {
    const results = replayCorpus(CORPUS, buildRegistryOrEmpty());
    process.stdout.write(formatReplayReport(results));
  }
}
