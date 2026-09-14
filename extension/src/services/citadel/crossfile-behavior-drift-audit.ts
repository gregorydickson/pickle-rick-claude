import { runGitSafe } from '../git-utils.js';
import { CitadelFinding, slugify, toPosixPath, uniqueSortedStrings } from './reporter.js';
import { DiffSummary } from './diff-walker.js';

export interface CrossfileBehaviorDriftResult {
  findings: CitadelFinding[];
}

const DRIFT_SEVERITY = 'Medium' as const;

// Top-level production declaration whose name the diff REMOVED. The bundle
// changed/removed behavior X; an out-of-diff file that still pins X is drift.
const REMOVED_DECL_RE =
  /^-\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
const ADDED_DECL_RE =
  /^\+\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;

// A gate command pinned in canonical-config: `bash scripts/<name>.sh` or `npm run <script>`.
const GATE_COMMAND_RE = /(?:bash\s+scripts\/[\w./-]+\.sh|npm\s+run\s+[\w:-]+)/g;

/** Identifiers a unified diff REMOVED from top-level declarations but did NOT re-add. */
export function extractRemovedDeclSymbols(diffText: string): string[] {
  const removed = new Set<string>();
  const added = new Set<string>();
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const rem = REMOVED_DECL_RE.exec(line);
    if (rem) removed.add(rem[1]);
    const add = ADDED_DECL_RE.exec(line);
    if (add) added.add(add[1]);
  }
  return uniqueSortedStrings([...removed].filter((name) => !added.has(name)));
}

/** Gate commands a unified diff REMOVED but did NOT re-add (gate-chain edit). */
export function extractChangedGateCommands(diffText: string): string[] {
  const removed = new Set<string>();
  const added = new Set<string>();
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const isRemoved = line.startsWith('-');
    const isAdded = line.startsWith('+');
    if (!isRemoved && !isAdded) continue;
    for (const match of line.matchAll(new RegExp(GATE_COMMAND_RE.source, GATE_COMMAND_RE.flags))) {
      const command = match[0].replace(/\s+/g, ' ').trim();
      (isRemoved ? removed : added).add(command);
    }
  }
  return uniqueSortedStrings([...removed].filter((command) => !added.has(command)));
}

function unifiedDiffForFile(diff: DiffSummary, filePath: string): string {
  return runGitSafe(
    ['diff', `${diff.base}...${diff.head}`, '--unified=0', '--', filePath],
    diff.repoRoot,
  );
}

/** Out-of-diff files (within the corpus pathspecs) that still pin `token`. */
export function findCrossfilePins(
  token: string,
  repoRoot: string,
  corpusPathspecs: string[],
  changedPaths: Set<string>,
): string[] {
  if (corpusPathspecs.length === 0) return [];
  const out = runGitSafe(['grep', '-l', '-F', '-e', token, '--', ...corpusPathspecs], repoRoot);
  const hits: string[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const file = toPosixPath(raw.trim());
    if (!file || changedPaths.has(file)) continue;
    hits.push(file);
  }
  return uniqueSortedStrings(hits);
}

/** True when `symbol` is still a top-level declaration in tracked production code at head. */
function symbolStillDefinedInProduction(symbol: string, repoRoot: string): boolean {
  // POSIX ERE (-E): git grep's -E flavor does NOT support \s or \b; use [[:space:]]
  // and an explicit word-boundary character class so this stays portable across
  // hosts that lack PCRE (-P) support.
  const out = runGitSafe(
    ['grep', '-l', '-E', '-e', `(function|class|const|let|var)[[:space:]]+${symbol}([^A-Za-z0-9_$]|$)`, '--', 'extension/src'],
    repoRoot,
  );
  return out.trim().length > 0;
}

function corpusPathspecs(): string[] {
  // Test + canonical-config corpus: all tests plus the gate-wiring canonical
  // configs (extension/scripts covers check-wired.sh and the audit-*.sh gate chain).
  return ['extension/tests', 'extension/scripts'];
}

function driftFinding(file: string, token: string): CitadelFinding {
  return {
    id: `crossfile-behavior-drift:${slugify(file)}:${slugify(token, 'token', 60)}`,
    severity: DRIFT_SEVERITY,
    file,
    message:
      `Pre-existing file pins \`${token}\` which this bundle changed/removed — `
      + 'review for cross-file behavior drift (the diff-scoped hammers do not cover this file).',
  };
}

export function auditCrossfileBehaviorDrift(diff: DiffSummary): CrossfileBehaviorDriftResult {
  const changedPaths = new Set(diff.changedFiles.map((file) => toPosixPath(file.path)));
  const pathspecs = corpusPathspecs();
  const findings: CitadelFinding[] = [];
  const emitted = new Set<string>();

  for (const changed of diff.changedFiles) {
    if (changed.status === 'D') continue;
    const diffText = unifiedDiffForFile(diff, changed.path);

    const tokens: string[] = [];
    if (changed.kind === 'production') {
      // Only symbols truly removed from production (renamed-but-kept is not drift).
      for (const symbol of extractRemovedDeclSymbols(diffText)) {
        if (!symbolStillDefinedInProduction(symbol, diff.repoRoot)) tokens.push(symbol);
      }
    }
    tokens.push(...extractChangedGateCommands(diffText));

    for (const token of uniqueSortedStrings(tokens)) {
      for (const file of findCrossfilePins(token, diff.repoRoot, pathspecs, changedPaths)) {
        const key = `${file}::${token}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        findings.push(driftFinding(file, token));
      }
    }
  }

  return { findings };
}
