import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { LockError, type ActivityEventType, type GateResult, type GateMode, type GateFailure, type GateBaselineFile } from '../types/index.js';
import { withLock } from './state-manager.js';
import { readRecoverableJsonObject } from './microverse-state.js';
import { writeStateFile } from './pickle-utils.js';
import { detectMissingTools } from './verify-command-safety.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadGateCommands(): Record<string, { typecheck?: string; lint?: string; test?: string }> {
  const dataPath = path.resolve(__dirname, '../data/gate-commands.json');
  return JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Record<string, { typecheck?: string; lint?: string; test?: string }>;
}

export class GateError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = 'GateError';
    this.kind = kind;
  }
}

export class GateTimeoutError extends GateError {
  readonly check: string;
  readonly timeout_ms: number;
  constructor(check: string, timeout_ms: number) {
    super('GATE_CHECK_TIMEOUT', `${check} timed out after ${timeout_ms}ms`);
    this.name = 'GateTimeoutError';
    this.check = check;
    this.timeout_ms = timeout_ms;
  }
}

export class BaselineMissingError extends GateError {
  constructor(baselinePath: string) {
    super('BASELINE_MISSING', `No baseline at ${baselinePath}`);
    this.name = 'BaselineMissingError';
  }
}

export class BaselineStaleError extends GateError {
  constructor(message: string) {
    super('BASELINE_STALE', message);
    this.name = 'BaselineStaleError';
  }
}

export class BaselineWriteFailedError extends GateError {
  readonly baselinePath: string;
  readonly cause?: unknown;

  constructor(baselinePath: string, message?: string, cause?: unknown) {
    super('BASELINE_WRITE_FAILED', message ?? `Failed to persist baseline at ${baselinePath}`);
    this.name = 'BaselineWriteFailedError';
    this.baselinePath = baselinePath;
    if (cause !== undefined) this.cause = cause;
  }
}

function baselineWriteFailed(baselinePath: string, err: unknown): BaselineWriteFailedError {
  if (err instanceof BaselineWriteFailedError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new BaselineWriteFailedError(
    baselinePath,
    `Failed to persist baseline at ${baselinePath}: ${message}`,
    err,
  );
}

/** Event names emitted by the remediator layer after runGate. Exported for remediator callers. */
export const GATE_REMEDIATION_EVENT_NAMES: readonly ActivityEventType[] = [
  'gate_remediation_complete',
  'gate_remediation_aborted_unverified_production_change',
  'gate_autofix_reverted',
] as const;

const PER_CHECK_TIMEOUT_MS: Record<'typecheck' | 'lint' | 'tests', number> = {
  typecheck: 120_000,
  lint: 60_000,
  tests: 300_000,
};
const GATE_TOTAL_TIMEOUT_MS = 600_000;
const GATE_LOCK_TIMEOUT_MS = 30_000;
const WORKSPACE_ROOT_CONTROL_FILES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
]);

const UNSAFE_TEST_SCRIPT_REGEX = /integration|e2e|golden|smoke|baseline|playwright|cypress|hardhat/i;
const SAFE_TEST_RUNNER_REGEX = /(vitest|jest|node|mocha)/;
const PACKAGE_MANAGER_RUN_RE = /^(npm|pnpm|yarn)(?:\s+run)?\s+([A-Za-z0-9:_-]+)\b/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const ENV_WRAPPER_PREFIXES = ['cross-env-shell', 'cross-env', 'env'] as const;

function buildFingerprint(f: GateFailure): string {
  return `${f.file}::${f.ruleOrCode}::${f.occurrence_index}`;
}

export function assignOccurrenceIndices(failures: GateFailure[]): GateFailure[] {
  const groups = new Map<string, GateFailure[]>();
  for (const f of failures) {
    const key = `${f.file}::${f.ruleOrCode}`;
    const group = groups.get(key) ?? [];
    group.push(f);
    groups.set(key, group);
  }
  const result: GateFailure[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.line - b.line);
    for (let i = 0; i < group.length; i++) {
      result.push({ ...group[i], occurrence_index: i });
    }
  }
  return result;
}

function validateBaselineStructure(data: unknown): data is GateBaselineFile {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  const projectType = d['project_type'];
  const capturedIteration = d['captured_iteration'];
  const projectTypeValid =
    projectType === null ||
    (typeof projectType === 'string' &&
      ['pnpm', 'npm', 'yarn', 'cargo', 'go', 'bun'].includes(projectType));
  const capturedIterationValid =
    capturedIteration === undefined ||
    (typeof capturedIteration === 'number' &&
      Number.isInteger(capturedIteration) &&
      capturedIteration >= 0);
  return (
    d['schema_version'] === 1 &&
    typeof d['captured_at'] === 'string' &&
    capturedIterationValid &&
    typeof d['working_dir'] === 'string' &&
    projectTypeValid &&
    Array.isArray(d['checks']) &&
    Array.isArray(d['failures'])
  );
}

function loadBaselineFile(baselinePath: string): GateBaselineFile {
  const raw = readRecoverableJsonObject(baselinePath) as unknown;
  if (!validateBaselineStructure(raw)) {
    throw new GateError('BASELINE_CORRUPT', `Invalid baseline file at ${baselinePath}`);
  }
  return raw;
}

async function inspectBaselinePath(baselinePath: string): Promise<Record<string, unknown>> {
  try {
    const stat = await fs.promises.stat(baselinePath);
    return {
      path: baselinePath,
      exists: true,
      size_bytes: stat.size,
      mtime_ms: stat.mtimeMs,
    };
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? String((err as NodeJS.ErrnoException).code)
      : undefined;
    return {
      path: baselinePath,
      exists: false,
      ...(code ? { error_code: code } : {}),
    };
  }
}

// R-ORSR-6 no-disown classifier. A failure the phase's OWN diff introduced can NEVER be
// labelled "pre-existing"/"unrelated". `changedFiles` is the repo-relative set of files in the
// phase's `start_commit..HEAD` diff; `changedExportedSymbols` is the set of exported identifiers
// whose declaration changed in that diff. A tsc failure is self-introduced iff its file is in the
// phase's own diff OR its message references one of those changed exported symbols (the
// out-of-scope consumer-spec break of Finding #103).
export interface NoDisownContext {
  changedFiles: Set<string>;
  changedExportedSymbols: Set<string>;
  /** Absolute working dir, used to normalize absolute `failure.file` to repo-relative. */
  workingDir?: string;
}

/** Extract identifier-shaped tokens a `tsc` failure references: every quoted token in the
 * message (tsc quotes symbol/type names) plus the basename stem of the failing file. */
export function extractTscFailureIdentifiers(failure: GateFailure): string[] {
  const ids = new Set<string>();
  const idShape = /^[A-Za-z_$][\w$]*$/;
  const quoted = failure.message.match(/['"]([^'"]+)['"]/g) ?? [];
  for (const q of quoted) {
    const inner = q.slice(1, -1).trim();
    if (idShape.test(inner)) ids.add(inner);
  }
  const stem = path.basename(failure.file).replace(/\.[^.]+$/, '');
  if (idShape.test(stem)) ids.add(stem);
  return Array.from(ids);
}

/** True when a failure intersects the phase's own diff (by changed file OR changed exported
 * symbol). Returns false when no context is supplied (the no-guard default). */
export function isSelfIntroducedFailure(failure: GateFailure, ctx?: NoDisownContext): boolean {
  if (!ctx) return false;
  if (ctx.changedFiles.size > 0) {
    const rel = ctx.workingDir
      ? normalizeScopePath(path.relative(ctx.workingDir, failure.file))
      : normalizeScopePath(failure.file);
    if (ctx.changedFiles.has(rel) || ctx.changedFiles.has(normalizeScopePath(failure.file))) {
      return true;
    }
  }
  if (ctx.changedExportedSymbols.size > 0) {
    for (const id of extractTscFailureIdentifiers(failure)) {
      if (ctx.changedExportedSymbols.has(id)) return true;
    }
  }
  return false;
}

/** Partition failures into self-introduced (intersect the phase's own diff) and other. */
export function classifyNoDisown(
  failures: GateFailure[],
  ctx: NoDisownContext,
): { selfIntroduced: GateFailure[]; other: GateFailure[] } {
  const selfIntroduced: GateFailure[] = [];
  const other: GateFailure[] = [];
  for (const f of failures) {
    (isSelfIntroducedFailure(f, ctx) ? selfIntroduced : other).push(f);
  }
  return { selfIntroduced, other };
}

// `selfGuard` (R-ORSR-6): a baseline-matching failure is dropped as pre-existing ONLY when it is
// NOT self-introduced. A failure intersecting the phase's own diff is never subtracted, so a
// self-introduced break can never be disowned as a coincidental baseline match.
export function subtractBaseline(
  current: GateFailure[],
  baseline: GateBaselineFile,
  selfGuard?: NoDisownContext,
): GateFailure[] {
  const baselineSet = new Set(baseline.failures.map(buildFingerprint));
  return current.filter(f => {
    if (!baselineSet.has(buildFingerprint(f))) return true;
    return isSelfIntroducedFailure(f, selfGuard);
  });
}

/** Repo-relative changed files in `sinceCommit..HEAD` (R-ORSR-6 exported wrapper). */
export function getChangedFilesSince(workingDir: string, sinceCommit: string): string[] {
  return getChangedSince(workingDir, sinceCommit);
}

/** Parse a unified `git diff` for exported declarations added or removed on changed lines.
 * Pure — operates on diff text so it is unit-testable without a git repo. */
export function parseChangedExportedSymbolsFromDiff(diffText: string): Set<string> {
  const symbols = new Set<string>();
  const declRe = /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:interface|type|class|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/;
  const namedReExportRe = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/;
  for (const raw of diffText.split('\n')) {
    // Only changed lines; skip the +++/--- file headers.
    if (!/^[+-]/.test(raw) || /^[+-]{3}\s/.test(raw)) continue;
    const line = raw.slice(1);
    const decl = line.match(declRe);
    if (decl?.[1]) symbols.add(decl[1]);
    const named = line.match(namedReExportRe);
    if (named?.[1]) {
      for (const part of named[1].split(',')) {
        const token = part.trim();
        if (!token) continue;
        // `A` or `A as C` → bind the externally-visible name (C if aliased, else A).
        const asMatch = token.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (asMatch?.[2]) symbols.add(asMatch[2]);
        else if (/^[A-Za-z_$][\w$]*$/.test(token)) symbols.add(token);
      }
    }
  }
  return symbols;
}

/** Exported identifiers whose declaration changed in `sinceCommit..HEAD` (TS/TSX only). */
export function getChangedExportedSymbols(workingDir: string, sinceCommit: string): Set<string> {
  const result = spawnSync(
    'git',
    ['diff', `${sinceCommit}..HEAD`, '--', '*.ts', '*.tsx'],
    { cwd: workingDir, encoding: 'utf-8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
  );
  if ((result.status ?? 1) !== 0) return new Set<string>();
  return parseChangedExportedSymbolsFromDiff(result.stdout || '');
}

export function assertBaselineFresh(
  baselinePath: string,
  opts: { max_age_iterations: number; max_age_seconds: number; current_iteration: number }
): void {
  if (!fs.existsSync(baselinePath)) {
    const dir = path.dirname(baselinePath);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const iso = now.replace(/[:.]/g, '-');
    fs.writeFileSync(
      path.join(dir, `baseline_missing_${iso}.md`),
      `# Baseline Missing\n\nPath: \`${baselinePath}\`\nCaptured: ${now}\n`
    );
    throw new BaselineMissingError(baselinePath);
  }
  const stat = fs.statSync(baselinePath);
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > opts.max_age_seconds * 1000) {
    throw new BaselineStaleError(
      `Baseline at ${baselinePath} is ${Math.round(ageMs / 1000)}s old (max ${opts.max_age_seconds}s)`
    );
  }
  const baseline = loadBaselineFile(baselinePath);
  const capturedIteration = baseline.captured_iteration;
  const iterationAge = typeof capturedIteration === 'number'
    ? opts.current_iteration - capturedIteration
    : opts.current_iteration;
  if (iterationAge >= opts.max_age_iterations) {
    throw new BaselineStaleError(
      `baseline iteration age (${iterationAge}) >= max_age_iterations (${opts.max_age_iterations})`
    );
  }
}

export interface RunGateOpts {
  workingDir: string;
  mode: GateMode;
  scope: 'full' | 'changed';
  checks: ('typecheck' | 'lint' | 'tests')[];
  baselinePath?: string;
  baselineIteration?: number;
  since?: string;
  allowedPaths?: string[];
  /** When true, gate skips (green) if the working tree is dirty. P0.6b. */
  workerMode?: boolean;
  /** Expected HEAD SHA. Gate halts with red if current HEAD differs. P0.6c. */
  expected_head?: string;
  /** Expected branch name. Gate halts with red if current branch differs. P0.6c. */
  expected_branch?: string;
  /** Optional event callback for testable gate event emission. */
  onEvent?: (event: string, data: Record<string, unknown>) => void;
  /** Optional settings bag for flake allowlist and other convergence_gate config. */
  settings?: { convergence_gate?: { known_flake_files?: string[] } };
  /** @internal test overrides for timeout values */
  _timeouts?: {
    perCheck?: Partial<Record<'typecheck' | 'lint' | 'tests', number>>;
    total?: number;
    lockMs?: number;
  };
}

export function detectProjectType(workingDir: string): 'pnpm' | 'npm' | 'yarn' | 'cargo' | 'go' | 'bun' | null {
  const has = (f: string) => fs.existsSync(path.join(workingDir, f));
  if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('package-lock.json')) return 'npm';
  if (has('bun.lock') || has('bun.lockb')) return 'bun';
  if (has('package.json')) return 'npm';
  if (has('Cargo.toml')) return 'cargo';
  if (has('go.mod')) return 'go';
  return null;
}

function parsePnpmWorkspaceYaml(content: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'packages:') {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (trimmed.startsWith('- ')) {
      patterns.push(trimmed.slice(2).replace(/^['"]|['"]$/g, ''));
    } else if (trimmed && !trimmed.startsWith('#')) {
      inPackages = false;
    }
  }
  return patterns;
}

function resolveWorkspaceGlobs(workingDir: string, patterns: string[]): string[] {
  const results = new Set<string>();
  const packageDirs = listWorkspacePackageDirs(workingDir).map(abs => ({
    abs,
    rel: normalizeScopePath(path.relative(workingDir, abs)),
  }));
  for (const pattern of patterns) {
    const normalizedPattern = normalizeScopePath(pattern);
    if (!/[*?]/.test(normalizedPattern)) {
      const resolved = path.resolve(workingDir, normalizedPattern);
      if (fs.existsSync(path.join(resolved, 'package.json'))) results.add(resolved);
      continue;
    }

    const regex = workspaceGlobToRegex(normalizedPattern);
    for (const candidate of packageDirs) {
      if (regex.test(candidate.rel)) {
        results.add(candidate.abs);
      }
    }
  }
  return Array.from(results).sort();
}

export function getWorkspacePackages(workingDir: string): string[] {
  const pnpmYaml = path.join(workingDir, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmYaml)) {
    const patterns = parsePnpmWorkspaceYaml(fs.readFileSync(pnpmYaml, 'utf-8'));
    return resolveWorkspaceGlobs(workingDir, patterns);
  }

  const pkgJsonPath = path.join(workingDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
        workspaces?: string[] | { packages: string[] };
      };
      const ws = pkg.workspaces;
      if (ws) {
        const patterns: string[] = Array.isArray(ws) ? ws : (ws.packages ?? []);
        return resolveWorkspaceGlobs(workingDir, patterns);
      }
    } catch {
      /* not a valid package.json with workspaces */
    }
  }

  return [];
}

function globToRegex(pattern: string): RegExp {
  // Strip trailing /** so the base dir itself matches: packages/b/** → ^packages/b(/.*)?$
  const pat = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  const re = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${re}(/.*)?$`);
}

function workspaceGlobToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function listWorkspacePackageDirs(rootDir: string): string[] {
  const found = new Set<string>();
  const pending = [rootDir];

  while (pending.length > 0) {
    const current = pending.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    if (
      current !== rootDir &&
      entries.some(entry => entry.isFile() && entry.name === 'package.json')
    ) {
      found.add(current);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      pending.push(path.join(current, entry.name));
    }
  }

  return Array.from(found);
}

function normalizeScopePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function staticScopePrefix(pattern: string): string {
  const normalized = normalizeScopePath(pattern);
  const wildcardIdx = normalized.search(/[*?]/);
  const prefix = wildcardIdx === -1 ? normalized : normalized.slice(0, wildcardIdx);
  return prefix.replace(/\/+$/, '');
}

function matchesAllowedPath(candidate: string, allowedPaths: readonly string[]): boolean {
  const normalizedCandidate = normalizeScopePath(candidate);
  return allowedPaths.some((allowedPath) => {
    const normalizedAllowed = normalizeScopePath(allowedPath);
    if (globToRegex(normalizedAllowed).test(normalizedCandidate)) return true;

    const prefix = staticScopePrefix(normalizedAllowed);
    if (!prefix) return true;

    return (
      prefix === normalizedCandidate ||
      prefix.startsWith(`${normalizedCandidate}/`) ||
      normalizedCandidate.startsWith(`${prefix}/`)
    );
  });
}

function affectsAllWorkspacePackages(repoRelativePaths: readonly string[]): boolean {
  return repoRelativePaths.some((filePath) => WORKSPACE_ROOT_CONTROL_FILES.has(normalizeScopePath(filePath)));
}

function applyFlakeFilter(
  failures: GateFailure[], workingDir: string, flakeGlobs: string[]
): { real: GateFailure[]; flake: GateFailure[] } {
  if (flakeGlobs.length === 0) return { real: failures, flake: [] };
  const regexes = flakeGlobs.map(globToRegex);
  const isFlake = (f: GateFailure) => {
    const rel = path.relative(workingDir, f.file);
    return regexes.some(re => re.test(rel));
  };
  return { real: failures.filter(f => !isFlake(f)), flake: failures.filter(isFlake) };
}

export function filterByScope(
  files: string[],
  opts: { scope: 'full' | 'changed'; since?: string; allowedPaths?: string[] }
): string[] {
  if (!opts.allowedPaths || opts.allowedPaths.length === 0) return files;
  return files.filter((file) => matchesAllowedPath(file, opts.allowedPaths ?? []));
}

function getChangedSince(workingDir: string, since: string): string[] {
  const result = spawnSync('git', ['diff', '--name-only', `${since}..HEAD`], {
    cwd: workingDir,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  if ((result.status ?? 1) !== 0) return [];
  return (result.stdout || '').split('\n').filter(Boolean);
}

interface CheckResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCheckCommand(
  check: GateCheck,
  cmd: string,
  cwd: string,
  timeout_ms: number,
): Promise<CheckResult> {
  const parts = cmd.split(' ').filter((p) => p.length > 0);
  if (parts.length === 0) {
    throw new Error(`runCheckCommand: empty command — refusing to spawn`);
  }
  const bin = parts[0]!;
  const args = parts.slice(1);
  const missingBin = detectMissingTools([bin]);
  if (missingBin.length > 0) {
    return { stdout: '', stderr: `tool not installed: ${bin}`, exitCode: 1 };
  }
  return await new Promise<CheckResult>((resolve, reject) => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new GateTimeoutError(check, timeout_ms));
    }, timeout_ms);

    execFile(
      bin,
      args,
      {
        cwd,
        encoding: 'utf8',
        killSignal: 'SIGKILL',
        maxBuffer: 10 * 1024 * 1024,
        signal: controller.signal,
      },
      (err, stdout, stderr) => {
        clearTimeout(timeoutHandle);
        if (!err) {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 });
          return;
        }
        if (controller.signal.aborted) return;
        const e = err as { stdout?: string; stderr?: string; code?: number };
        resolve({
          stdout: e.stdout ?? stdout ?? '',
          stderr: e.stderr ?? stderr ?? '',
          exitCode: typeof e.code === 'number' ? e.code : 1,
        });
      },
    );
  });
}

function parseTscOutput(output: string, pkgDir: string): GateFailure[] {
  const failures: GateFailure[] = [];
  const re = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.*)$/;
  for (const line of output.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    failures.push({
      check: 'typecheck',
      file: path.isAbsolute(m[1]!) ? m[1]! : path.resolve(pkgDir, m[1]!),
      line: parseInt(m[2]!, 10),
      ruleOrCode: m[3]!,
      message: (m[4] ?? '').slice(0, 500),
      severity: 'error',
      occurrence_index: 0,
    });
  }
  return failures;
}

function parseEslintOutput(output: string, pkgDir: string): GateFailure[] {
  const failures: GateFailure[] = [];
  let currentFile = '';
  const violationRe = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*\S)\s{2,}(\S+)\s*$/;
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^[✖×√]/.test(trimmed) || /^\d+ problem/.test(trimmed)) continue;
    if (line.charAt(0) !== ' ' && line.charAt(0) !== '\t') {
      currentFile = path.isAbsolute(trimmed) ? trimmed : path.resolve(pkgDir, trimmed);
    } else {
      const m = line.match(violationRe);
      if (m && currentFile) {
        failures.push({
          check: 'lint',
          file: currentFile,
          line: parseInt(m[1]!, 10),
          ruleOrCode: m[5]!.trim(),
          message: m[4]!.trim().slice(0, 500),
          severity: m[3] === 'error' ? 'error' : 'warning',
          occurrence_index: 0,
        });
      }
    }
  }
  return failures;
}

// R-FGNC-1: pnpm prints `WARN  Issue while reading ".../.npmrc". Failed to
// replace env in config: ${...TOKEN}` to stderr on every invocation when a
// token env var referenced by an `.npmrc` is unset. It is benign config-read
// noise — never a check failure — but the classifier's fallback path promoted
// it to the sole reported "failure", masking the real TS/lint errors. Strip
// any pnpm `WARN Issue while reading "<file>"` line (covers the canonical
// `.npmrc`/`${TOKEN}` form and the truncated continuation pnpm emits).
const ENV_NOISE_WARN_RE = /^\s*WARN\s+Issue while reading\s+"/;

export function stripEnvNoise(output: string): string {
  return output
    .split('\n')
    .filter((line) => !ENV_NOISE_WARN_RE.test(line))
    .join('\n');
}

export function buildFailures(result: CheckResult, check: 'typecheck' | 'lint' | 'tests', pkgDir: string): GateFailure[] {
  // R-FGNC-2: the subprocess exit code is the source of truth for "did this
  // check fail" — stdout/stderr is scraped only to enumerate WHICH failures
  // exist. Exit 0 → no failures, regardless of stderr WARN content.
  if (result.exitCode === 0) return [];
  // R-FGNC-1: tsc/eslint errors land on stdout while pnpm env-noise lands on
  // stderr — combine BOTH streams (the prior `stderr || stdout` dropped the
  // real errors whenever stderr carried the `.npmrc` WARN) then strip the
  // benign noise before the failure-line classifier runs.
  const output = stripEnvNoise(`${result.stdout}\n${result.stderr}`).trim();

  if (check === 'typecheck') {
    const parsed = parseTscOutput(output, pkgDir);
    if (parsed.length > 0) return parsed;
  }

  if (check === 'lint') {
    const parsed = parseEslintOutput(output, pkgDir);
    if (parsed.length > 0) return parsed;
  }

  return [{
    check,
    file: pkgDir,
    line: 0,
    ruleOrCode: String(result.exitCode),
    message: output.slice(0, 500) || `${check} failed with exit code ${result.exitCode}`,
    severity: 'error',
    occurrence_index: 0,
  }];
}

// R-SZGB-D: a check whose COMMAND never ran (missing npm/pnpm/yarn script, the binary itself
// absent from PATH, ENOENT, exit 127) is a distinct class from "the tool ran and found nothing" —
// buildFailures' generic fallback branch previously conflated the two, so a missing npm script
// became an ordinary subtractable failure that made the check permanently inert. Kept narrow: a
// REAL tool failure (tsc TSxxxx, eslint violations, failing tests) must never match.
const UNRUNNABLE_CHECK_PATTERNS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /npm (?:error|ERR!) .*missing script/i, reason: 'missing npm script' },
  { re: /ERR_PNPM_NO_SCRIPT|pnpm.*missing script/i, reason: 'missing pnpm script' },
  { re: /error Command "[^"]*" not found|couldn't find a script named/i, reason: 'missing yarn script' },
  { re: /^tool not installed:/im, reason: 'tool not installed' },
  { re: /\bENOENT\b/, reason: 'ENOENT' },
  { re: /\bcommand not found\b|is not recognized as an internal or external command/i, reason: 'command not found' },
];

function classifyUnrunnableCheck(result: CheckResult): string | null {
  if (result.exitCode === 0) return null;
  if (result.exitCode === 127) return 'exit 127: command not found';
  const output = stripEnvNoise(`${result.stdout}\n${result.stderr}`);
  return UNRUNNABLE_CHECK_PATTERNS.find(({ re }) => re.test(output))?.reason ?? null;
}

export function isUnrunnableCheckResult(result: CheckResult): boolean {
  return classifyUnrunnableCheck(result) !== null;
}

const CHECK_KEY_MAP: Record<'typecheck' | 'lint' | 'tests', keyof { typecheck?: string; lint?: string; test?: string }> = {
  typecheck: 'typecheck',
  lint: 'lint',
  tests: 'test',
};

type GateCheck = 'typecheck' | 'lint' | 'tests';
type GateCommandMap = { typecheck?: string; lint?: string; test?: string };
type GateEmit = (event: string, data: Record<string, unknown>) => void;
type ProjectType = NonNullable<ReturnType<typeof detectProjectType>>;

function emptyGateResult(allowedPathsUsed = false): GateResult {
  return {
    status: 'green',
    failures: [],
    baseline_used: false,
    allowed_paths_used: allowedPathsUsed,
    elapsed_ms: 0,
    total_raw_failure_count: 0,
    new_failures_vs_baseline: 0,
  };
}

function finalizeGateResult(opts: RunGateOpts, emit: GateEmit, result: GateResult): GateResult {
  emit('gate_run_complete', {
    gate_payload: {
      mode: opts.mode,
      scope: opts.scope,
      checks: opts.checks,
      status: result.status,
      failure_count: result.failures.length,
      total_raw_failure_count: result.total_raw_failure_count,
      new_failures_vs_baseline: result.new_failures_vs_baseline,
      elapsed_ms: result.elapsed_ms,
      allowed_paths_used: result.allowed_paths_used,
      baseline_used: result.baseline_used,
    },
  });
  return result;
}

function selectWorkspaceTargetDirs(
  opts: RunGateOpts,
  workspacePackages: string[],
  allowedPathsUsed: boolean,
): string[] {
  let candidates = workspacePackages;
  if (opts.scope === 'changed' && opts.since) {
    const changedFiles = getChangedSince(opts.workingDir, opts.since);
    if (!affectsAllWorkspacePackages(changedFiles)) {
      candidates = workspacePackages.filter(pkgDir =>
        changedFiles.some(f => {
          const absFile = path.resolve(opts.workingDir, f);
          return absFile.startsWith(pkgDir + path.sep) || absFile === pkgDir;
        })
      );
    }
  }

  if (!allowedPathsUsed || affectsAllWorkspacePackages(opts.allowedPaths ?? [])) {
    return candidates;
  }
  const relCandidates = candidates.map(p => path.relative(opts.workingDir, p));
  const filtered = filterByScope(relCandidates, { scope: opts.scope, allowedPaths: opts.allowedPaths });
  return filtered.map(rel => path.resolve(opts.workingDir, rel));
}

function resolveGateTargetDirs(
  opts: RunGateOpts,
  workspacePackages: string[],
  allowedPathsUsed: boolean,
  start: number,
  emit: GateEmit,
): { targetDirs: string[]; earlyResult?: GateResult } {
  if (workspacePackages.length > 0) {
    return { targetDirs: selectWorkspaceTargetDirs(opts, workspacePackages, allowedPathsUsed) };
  }
  if (opts.scope === 'changed' && opts.since) {
    const changedFiles = getChangedSince(opts.workingDir, opts.since);
    if (changedFiles.length === 0) {
      emit('gate_diff_scope_fallback', { since: opts.since, reason: 'no_changed_files' });
      // AC-OFFREPO-1: also emit the canonical gate_skipped event (the same
      // reason the other two emptyGateResult() producers use) so this skip
      // participates in SKIP_FLAG_EVENT_NAMES governance and so runGate can
      // return it directly without routing through finalizeGateResult, which
      // would otherwise report the skip as an executed gate_run_complete pass.
      emit('gate_skipped', { reason: 'no_changed_files' });
      return { targetDirs: [], earlyResult: { ...emptyGateResult(), elapsed_ms: Date.now() - start } };
    }
  }
  return { targetDirs: [opts.workingDir] };
}

function workerModeSkipResult(opts: RunGateOpts, start: number, emit: GateEmit): GateResult | null {
  if (!opts.workerMode) return null;
  const porcelainR = spawnSync('git', ['status', '--porcelain'], {
    cwd: opts.workingDir, encoding: 'utf-8', timeout: 10_000,
  });
  const dirtyLines = ((porcelainR.stdout as string | null) ?? '').split('\n').filter(Boolean);
  if (dirtyLines.length === 0) return null;
  emit('gate_skipped', { reason: 'dirty_worktree_no_rescue' });
  return { ...emptyGateResult(), elapsed_ms: Date.now() - start };
}

async function gitDriftResult(
  opts: RunGateOpts,
  allowedPathsUsed: boolean,
  start: number,
  emit: GateEmit,
): Promise<GateResult | null> {
  if (opts.expected_head === undefined && opts.expected_branch === undefined) return null;
  const headR = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: opts.workingDir, encoding: 'utf-8', timeout: 10_000,
  });
  const branchR = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: opts.workingDir, encoding: 'utf-8', timeout: 10_000,
  });
  const currentHead = ((headR.stdout as string | null) ?? '').trim();
  const currentBranch = ((branchR.stdout as string | null) ?? '').trim();
  const headMismatch = opts.expected_head !== undefined && currentHead !== opts.expected_head;
  const branchMismatch = opts.expected_branch !== undefined && currentBranch !== opts.expected_branch;
  if (!headMismatch && !branchMismatch) return null;
  await writeWorkingDirDriftFile(opts, currentHead, currentBranch);
  emit('gate_workingdir_drift_detected', {
    expected_head: opts.expected_head,
    current_head: currentHead,
    expected_branch: opts.expected_branch,
    current_branch: currentBranch,
  });
  return buildWorkingDirDriftResult(opts, currentHead, currentBranch, allowedPathsUsed, start);
}

async function writeWorkingDirDriftFile(opts: RunGateOpts, currentHead: string, currentBranch: string): Promise<void> {
  const now = new Date().toISOString();
  const iso = now.replace(/[:.]/g, '-');
  const gateDir = path.join(opts.workingDir, 'gate');
  await fs.promises.mkdir(gateDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(gateDir, `workingdir_drift_${iso}.md`),
    `# Working Directory Drift\n\nDetected at: ${now}\n\nExpected HEAD: ${opts.expected_head ?? '(any)'}\nCurrent HEAD: ${currentHead}\nExpected branch: ${opts.expected_branch ?? '(any)'}\nCurrent branch: ${currentBranch}\n`
  );
}

function buildWorkingDirDriftResult(
  opts: RunGateOpts,
  currentHead: string,
  currentBranch: string,
  allowedPathsUsed: boolean,
  start: number,
): GateResult {
  return {
    status: 'red',
    failures: [{
      check: 'tests',
      file: '<workingdir-drift>',
      line: 0,
      ruleOrCode: 'GATE_WORKINGDIR_DRIFT',
      message: `Working directory drift: expected branch "${opts.expected_branch ?? '(any)'}", got "${currentBranch}"; expected HEAD "${opts.expected_head ?? '(any)'}", got "${currentHead}"`,
      severity: 'error',
      occurrence_index: 0,
    }],
    baseline_used: false,
    allowed_paths_used: allowedPathsUsed,
    elapsed_ms: Date.now() - start,
    total_raw_failure_count: 1,
    new_failures_vs_baseline: 0,
  };
}

async function canRunTestScript(check: GateCheck, projectType: ProjectType, dir: string, emit: GateEmit): Promise<boolean> {
  if (check !== 'tests' || !['pnpm', 'npm', 'yarn'].includes(projectType)) return true;
  const pkgJsonPath = path.join(dir, 'package.json');
  let scriptContent = '';
  let scripts: Record<string, string> = {};
  try {
    const raw = await fs.promises.readFile(pkgJsonPath, 'utf-8');
    scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
    scriptContent = scripts.test ?? '';
  } catch {
    // file absent or unreadable — leave scriptContent empty
  }

  const leafCommands = resolveDelegatedScriptLeaves('test', scripts);
  const commandsToInspect = leafCommands.length > 0 ? leafCommands : [scriptContent].filter((value) => value.length > 0);
  const unsafeLeaf = commandsToInspect.find((command) => UNSAFE_TEST_SCRIPT_REGEX.test(command));
  if (unsafeLeaf) {
    emit('gate_unsafe_test_command_blocked', { script: scriptContent, leaf_script: unsafeLeaf });
    return false;
  }
  return commandsToInspect.some((command) => SAFE_TEST_RUNNER_REGEX.test(command));
}

function splitScriptSegments(script: string): string[] {
  return script
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function delegatedScriptName(segment: string): string | null {
  let remaining = segment.trim();
  while (remaining.length > 0) {
    const match = remaining.match(PACKAGE_MANAGER_RUN_RE);
    if (match?.[2]) return match[2];

    const wrapper = ENV_WRAPPER_PREFIXES.find((prefix) =>
      remaining === prefix || remaining.startsWith(`${prefix} `));
    if (wrapper) {
      remaining = remaining.slice(wrapper.length).trimStart();
      continue;
    }

    const token = remaining.match(/^\S+/)?.[0];
    if (token && ENV_ASSIGNMENT_RE.test(token)) {
      remaining = remaining.slice(token.length).trimStart();
      continue;
    }

    break;
  }

  return null;
}

function resolveDelegatedScriptLeaves(
  scriptName: string,
  scripts: Record<string, string>,
  seen = new Set<string>(),
): string[] {
  if (seen.has(scriptName)) return [];
  const script = scripts[scriptName];
  if (typeof script !== 'string' || script.trim().length === 0) return [];

  const nextSeen = new Set(seen);
  nextSeen.add(scriptName);
  const leaves: string[] = [];

  for (const segment of splitScriptSegments(script)) {
    const delegatedName = delegatedScriptName(segment);
    if (delegatedName && delegatedName !== scriptName && scripts[delegatedName]) {
      const nestedLeaves = resolveDelegatedScriptLeaves(delegatedName, scripts, nextSeen);
      if (nestedLeaves.length > 0) {
        leaves.push(...nestedLeaves);
        continue;
      }
    }
    leaves.push(segment);
  }

  return leaves;
}

interface UnrunnableCheck {
  check: GateCheck;
  reason: string;
}

interface GateCheckOutcome {
  failures: GateFailure[];
  unrunnable: UnrunnableCheck | null;
}

async function runGateCheck(
  check: GateCheck,
  cmd: string,
  dir: string,
  effectiveMs: number,
): Promise<GateCheckOutcome> {
  try {
    const result = await runCheckCommand(check, cmd, dir, effectiveMs);
    const failures = buildFailures(result, check, dir);
    const unrunnableReason = classifyUnrunnableCheck(result);
    const unrunnable = unrunnableReason !== null ? { check, reason: unrunnableReason } : null;
    return { failures, unrunnable };
  } catch (err) {
    if (!(err instanceof GateTimeoutError)) throw err;
    return {
      failures: [{
        check,
        file: '<timeout>',
        line: 0,
        ruleOrCode: 'GATE_CHECK_TIMEOUT',
        message: `${check} timed out after ${effectiveMs}ms`,
        severity: 'error',
        occurrence_index: 0,
      }],
      unrunnable: null,
    };
  }
}

interface GateFailuresCollection {
  failures: GateFailure[];
  unrunnableCheck: UnrunnableCheck | null;
}

async function collectGateFailures(
  opts: RunGateOpts,
  targetDirs: string[],
  cmdMap: GateCommandMap,
  projectType: ProjectType,
  totalDeadline: number,
  emit: GateEmit,
): Promise<GateFailuresCollection> {
  const allFailures: GateFailure[] = [];
  let unrunnableCheck: UnrunnableCheck | null = null;

  outerLoop:
  for (const dir of targetDirs) {
    for (const check of opts.checks) {
      const remaining = totalDeadline - Date.now();
      if (remaining <= 0) {
        allFailures.push(timeoutFailure(check));
        break outerLoop;
      }
      const cmd = cmdMap[CHECK_KEY_MAP[check]];
      if (!cmd) continue;
      if (!(await canRunTestScript(check, projectType, dir, emit))) continue;
      const perCheckMs = opts._timeouts?.perCheck?.[check] ?? PER_CHECK_TIMEOUT_MS[check];
      const outcome = await runGateCheck(check, cmd, dir, Math.min(perCheckMs, remaining));
      allFailures.push(...outcome.failures);
      if (outcome.unrunnable && !unrunnableCheck) unrunnableCheck = outcome.unrunnable;
    }
  }
  return { failures: allFailures, unrunnableCheck };
}

function timeoutFailure(check: GateCheck): GateFailure {
  return {
    check,
    file: '<timeout>',
    line: 0,
    ruleOrCode: 'GATE_CHECK_TIMEOUT',
    message: `cumulative gate timeout exceeded`,
    severity: 'error',
    occurrence_index: 0,
  };
}

/**
 * Persist a `GateBaselineFile` to disk with mandatory post-write verification.
 * Used by both the empty-baseline early-return paths (no project type detected,
 * or detected type lacks a command map — `checks`/`failures` empty) and the
 * captured-baseline path. The post-write `access` + `inspectBaselinePath` probe
 * keeps the contract with `microverse-runner.capturePerIterationGateBaseline` —
 * which post-checks `pathExists(baselinePath)` — intact, so a green baseline-mode
 * result never reports success while `gate/baseline.json` is absent. Throws
 * `BaselineWriteFailedError` on any disk failure.
 */
async function persistGateBaseline(
  baselinePath: string,
  opts: RunGateOpts,
  projectType: ProjectType | null,
  checks: GateCheck[],
  failures: GateFailure[],
  emit: GateEmit,
): Promise<void> {
  try {
    const baseline: GateBaselineFile = {
      schema_version: 1,
      captured_at: new Date().toISOString(),
      captured_iteration: opts.baselineIteration,
      working_dir: opts.workingDir,
      project_type: projectType as GateBaselineFile['project_type'],
      checks,
      failures,
    };
    await fs.promises.mkdir(path.dirname(baselinePath), { recursive: true });
    writeStateFile(baselinePath, baseline);
    await fs.promises.access(baselinePath);
    const postWriteStatus = await inspectBaselinePath(baselinePath);
    emit('gate_baseline_disk_check', { phase: 'post_write', ...postWriteStatus });
    if (postWriteStatus.exists !== true) {
      throw new BaselineWriteFailedError(
        baselinePath,
        `Baseline write reported success but file is missing at ${baselinePath}`,
      );
    }
  } catch (err) {
    throw baselineWriteFailed(baselinePath, err);
  }
}

async function handleBaselineMode(
  opts: RunGateOpts,
  projectType: ProjectType,
  allowedPathsUsed: boolean,
  realFailures: GateFailure[],
  start: number,
  emit: GateEmit,
  uncertifiable: boolean,
): Promise<GateResult | null> {
  if (opts.mode !== 'baseline' || !opts.baselinePath) return null;
  const baselinePath = opts.baselinePath;
  const withIndices = assignOccurrenceIndices(realFailures);
  const lockKey = `gate-${createHash('sha256').update(opts.workingDir).digest('hex')}`;
  const lockMs = opts._timeouts?.lockMs ?? GATE_LOCK_TIMEOUT_MS;

  try {
    return await withLock(lockKey, { timeout_ms: lockMs }, async () => {
      emit('gate_lock_acquired', { lock_key: lockKey });
      return await resolveBaselineResult(baselinePath, opts, projectType, withIndices, allowedPathsUsed, start, emit, uncertifiable);
    });
  } catch (err) {
    if (err instanceof LockError) {
      emit('gate_lock_timeout', { lock_key: lockKey, waited_ms: err.waited_ms ?? lockMs });
      throw baselineWriteFailed(baselinePath, err);
    }
    throw err;
  }
}

async function resolveBaselineResult(
  baselinePath: string,
  opts: RunGateOpts,
  projectType: ProjectType,
  withIndices: GateFailure[],
  allowedPathsUsed: boolean,
  start: number,
  emit: GateEmit,
  uncertifiable: boolean,
): Promise<GateResult> {
  const preWriteStatus = await inspectBaselinePath(baselinePath);
  emit('gate_baseline_disk_check', { phase: 'pre_write', ...preWriteStatus });
  if (preWriteStatus.exists !== true) {
    // R-SZGB-D: an unrunnable check means the gate inspected NOTHING for that check — reuse the
    // R-SZGB-B `project_type: null` uncertifiable-baseline signal so the existing
    // `isBaselineUncertifiable` consumer in microverse-runner.ts fails closed with no new field.
    await persistGateBaseline(baselinePath, opts, uncertifiable ? null : projectType, opts.checks, withIndices, emit);
    emit('gate_baseline_captured', { path: baselinePath, failure_count: withIndices.length });
    emit('gate_preexisting_tests_baselined', { failure_count: withIndices.length });
    return {
      status: 'green',
      failures: [],
      baseline_used: false,
      allowed_paths_used: allowedPathsUsed,
      elapsed_ms: Date.now() - start,
      total_raw_failure_count: withIndices.length,
      new_failures_vs_baseline: 0,
    };
  }
  const newFailures = subtractBaseline(withIndices, loadBaselineFile(baselinePath));
  return {
    status: newFailures.length === 0 ? 'green' : 'red',
    failures: newFailures,
    baseline_used: true,
    allowed_paths_used: allowedPathsUsed,
    elapsed_ms: Date.now() - start,
    total_raw_failure_count: withIndices.length,
    new_failures_vs_baseline: newFailures.length,
  };
}

async function knownFlakeResult(
  opts: RunGateOpts,
  allFailures: GateFailure[],
  realFailures: GateFailure[],
  flakeFailures: GateFailure[],
  allowedPathsUsed: boolean,
  start: number,
  emit: GateEmit,
): Promise<GateResult | null> {
  if (realFailures.length !== 0 || flakeFailures.length === 0) return null;
  const now = new Date().toISOString();
  const iso = now.replace(/[:.]/g, '-');
  const gateDir = path.join(opts.workingDir, 'gate');
  await fs.promises.mkdir(gateDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(gateDir, `known_flake_failures_${iso}.md`),
    `# Known Flake Failures\n\nCaptured: ${now}\n\n${flakeFailures.map(f => `- \`${f.file}\` [${f.check}]: ${f.message.slice(0, 200)}`).join('\n')}\n`
  );
  emit('gate_out_of_scope_failures_present', { flake_count: flakeFailures.length, paths: flakeFailures.map(f => f.file) });
  return {
    status: 'green-with-known-flake-warnings',
    failures: [],
    baseline_used: false,
    allowed_paths_used: allowedPathsUsed,
    elapsed_ms: Date.now() - start,
    total_raw_failure_count: allFailures.length,
    new_failures_vs_baseline: 0,
  };
}

function finalGateResult(
  realFailures: GateFailure[],
  allFailures: GateFailure[],
  allowedPathsUsed: boolean,
  start: number,
  emit: GateEmit,
): GateResult {
  const status = realFailures.length === 0 ? 'green' : 'red';
  if (status === 'red') {
    emit('gate_regression_threshold_warning', { failure_count: realFailures.length });
  }
  return {
    status,
    failures: realFailures,
    baseline_used: false,
    allowed_paths_used: allowedPathsUsed,
    elapsed_ms: Date.now() - start,
    total_raw_failure_count: allFailures.length,
    new_failures_vs_baseline: 0,
  };
}

/**
 * Emit `gate_skipped` and return an empty (green) gate result. When called in
 * baseline mode with a `baselinePath`, write a valid empty `GateBaselineFile`
 * BEFORE returning so downstream `pathExists(baselinePath)` consumers (notably
 * `microverse-runner.capturePerIterationGateBaseline`) don't observe a silent
 * skip as a missing-baseline error.
 */
async function emitSkippedAndReturn(
  opts: RunGateOpts,
  projectType: ProjectType | null,
  reason: string,
  start: number,
  emit: GateEmit,
  extra: Record<string, unknown> = {},
): Promise<GateResult> {
  if (opts.mode === 'baseline' && opts.baselinePath) {
    await persistGateBaseline(opts.baselinePath, opts, projectType, [], [], emit);
  }
  emit('gate_skipped', { reason, ...extra });
  return { ...emptyGateResult(), elapsed_ms: Date.now() - start };
}

const NON_CANDIDATE_CHILD_DIRS = new Set(['node_modules']);

/**
 * R-SZGB-A: when `target` itself carries no project marker, scan its immediate
 * children (depth 1, skipping node_modules/dot-dirs) for the real package root
 * via the same `detectProjectType` primitive. Returns the single unambiguous
 * candidate, or null on zero or 2+ matches — callers must never guess.
 */
function resolveProjectRootOneLevelDown(target: string): { dir: string; type: ProjectType } | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates: { dir: string; type: ProjectType }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || NON_CANDIDATE_CHILD_DIRS.has(entry.name)) continue;
    const childDir = path.join(target, entry.name);
    const childType = detectProjectType(childDir);
    if (childType) candidates.push({ dir: childDir, type: childType });
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * R-SZGB-A: detect the project type at `opts.workingDir`, falling back to the
 * bounded depth-1 resolver when the target itself has no marker. Returns opts
 * unchanged (and projectType null) when neither the target nor a lone child
 * resolves.
 */
function detectProjectTypeWithRootResolution(opts: RunGateOpts): { opts: RunGateOpts; projectType: ProjectType | null } {
  const projectType = detectProjectType(opts.workingDir);
  if (projectType) return { opts, projectType };
  const resolvedRoot = resolveProjectRootOneLevelDown(opts.workingDir);
  if (!resolvedRoot) return { opts, projectType: null };
  console.error(`gate: resolved project root 1 level(s) below target -> ${resolvedRoot.dir}`);
  return { opts: { ...opts, workingDir: resolvedRoot.dir }, projectType: resolvedRoot.type };
}

/**
 * R-SZGB-D-A: logs the uncertifiable-baseline signal only in baseline mode, keeping this
 * conditional out of runGate's cyclomatic complexity count.
 */
function logUnrunnableCheckIfBaseline(
  unrunnableCheck: UnrunnableCheck | null,
  mode: RunGateOpts['mode'],
): void {
  if (!unrunnableCheck || mode !== 'baseline') return;
  console.error(
    `gate: check '${unrunnableCheck.check}' could not run (${unrunnableCheck.reason}) — baseline uncertifiable, cannot certify`,
  );
}

export async function runGate(rawOpts: RunGateOpts): Promise<GateResult> {
  const start = Date.now();
  const emit = (event: string, data: Record<string, unknown>) => rawOpts.onEvent?.(event, data);

  const { opts, projectType } = detectProjectTypeWithRootResolution(rawOpts);
  if (!projectType) {
    return emitSkippedAndReturn(opts, null, 'no_project_type_detected', start, emit);
  }

  const commands = loadGateCommands();
  const cmdMap = commands[projectType];
  if (!cmdMap) {
    return emitSkippedAndReturn(opts, projectType, 'project_type_low_confidence', start, emit, { detected_signals: [projectType] });
  }

  const workspacePackages = getWorkspacePackages(opts.workingDir);
  const allowedPathsUsed = Boolean(opts.allowedPaths && opts.allowedPaths.length > 0);
  const resolved = resolveGateTargetDirs(opts, workspacePackages, allowedPathsUsed, start, emit);
  // AC-OFFREPO-1: return this skip directly rather than through
  // finalizeGateResult, which would emit gate_run_complete (status green) and
  // make the skip indistinguishable from an executed pass — matching the
  // workerModeSkipResult / emitSkippedAndReturn skip producers below.
  if (resolved.earlyResult) return resolved.earlyResult;

  const workerSkip = workerModeSkipResult(opts, start, emit);
  if (workerSkip) return workerSkip;

  const drift = await gitDriftResult(opts, allowedPathsUsed, start, emit);
  if (drift) return finalizeGateResult(opts, emit, drift);

  const totalDeadline = Date.now() + (opts._timeouts?.total ?? GATE_TOTAL_TIMEOUT_MS);
  const { failures: allFailures, unrunnableCheck } = await collectGateFailures(opts, resolved.targetDirs, cmdMap, projectType, totalDeadline, emit);

  logUnrunnableCheckIfBaseline(unrunnableCheck, opts.mode);

  const flakeGlobs = opts.settings?.convergence_gate?.known_flake_files ?? [];
  const { real: realFailures, flake: flakeFailures } = applyFlakeFilter(allFailures, opts.workingDir, flakeGlobs);

  const baseline = await handleBaselineMode(opts, projectType, allowedPathsUsed, realFailures, start, emit, unrunnableCheck !== null);
  if (baseline) return finalizeGateResult(opts, emit, baseline);

  const flake = await knownFlakeResult(opts, allFailures, realFailures, flakeFailures, allowedPathsUsed, start, emit);
  if (flake) return finalizeGateResult(opts, emit, flake);

  return finalizeGateResult(opts, emit, finalGateResult(realFailures, allFailures, allowedPathsUsed, start, emit));
}
