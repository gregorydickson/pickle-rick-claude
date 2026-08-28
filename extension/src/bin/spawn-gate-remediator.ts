import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { isoCompactStamp, safeErrorMessage } from '../services/pickle-utils.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { isBackend } from '../services/backend-spawn.js';
import type { Backend, GateResult, GateFailure } from '../types/index.js';
import {
  acquireLockFile,
  reclaimDeadLock,
  releaseLockFile,
  writeActivityEntry,
  type LockHandle,
} from '../services/state-manager.js';
import { FOM_EVIDENCE_RULES, FOM_HONEST_REPORTING_RULES } from '../services/fom-blocks.js';

const USAGE = 'Usage: spawn-gate-remediator --gate-result <path> --session-root <path> --reason strict|per-iteration';
const LOCKFILE_NAME = 'remediator.lockfile';
const MAX_FILE_BYTES = 50_000;
const VALID_REASONS = new Set(['strict', 'per-iteration']);

export interface SpawnGateRemediatorOpts {
  argv: string[];
  isoOverride?: string;
  extensionClaudeMdContent?: string;
  readFileFn?: (p: string, enc: 'utf-8') => string;
  writeFileFn?: (p: string, data: string, enc: 'utf-8') => void;
  mkdirSyncFn?: (p: string, opts: { recursive: boolean }) => void;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

const VALID_GATE_STATUSES = new Set<string>(['green', 'red', 'green-with-known-flake-warnings']);
const VALID_FAILURE_CHECKS = new Set<string>(['typecheck', 'lint', 'tests']);
const VALID_FAILURE_SEVERITIES = new Set<string>(['error', 'warning']);

export function isGateFailure(v: unknown): v is GateFailure {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f['check'] === 'string' && VALID_FAILURE_CHECKS.has(f['check']) &&
    typeof f['file'] === 'string' &&
    typeof f['line'] === 'number' &&
    typeof f['ruleOrCode'] === 'string' &&
    typeof f['message'] === 'string' &&
    typeof f['severity'] === 'string' && VALID_FAILURE_SEVERITIES.has(f['severity']) &&
    typeof f['occurrence_index'] === 'number'
  );
}

export function isGateResult(v: unknown): v is GateResult {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['status'] === 'string' && VALID_GATE_STATUSES.has(obj['status']) &&
    Array.isArray(obj['failures']) && obj['failures'].every(isGateFailure) &&
    typeof obj['elapsed_ms'] === 'number'
  );
}

function formatFailuresTable(failures: GateFailure[]): string {
  if (failures.length === 0) return '_No failures._\n';
  const rows = failures.map(f =>
    `| ${f.check} | ${f.file} | ${f.line} | ${f.ruleOrCode} | ${f.severity} | ${f.message.replace(/\|/g, '\\|')} |`
  );
  return [
    '| Check | File | Line | Rule/Code | Severity | Message |',
    '|:------|:-----|-----:|:----------|:---------|:--------|',
    ...rows,
  ].join('\n') + '\n';
}

const SECTION_4_HARD_RULE_AND_ABORT_GRAMMAR = `### Hard Rule

**Fix ONLY the failures listed in Section 1. Do not edit any other lines. Do not change behavior.**

You may ONLY hand-edit for these five failure classes. Anything outside → abort immediately.

- **(a)** Regex character class ranges: \`\\xNN\` → \`\\uNNNN\`. Rule: \`no-control-regex\`. Character escape in range only — no logic changes.
- **(b)** async-generator require-await: \`async function*\` without \`await\` → wrap with typed \`AsyncIterable\` helper per trap-door section (see Section 3). No new behavior.
- **(c)** Unnecessary type assertions: Remove \`as Type\` where TypeScript already infers (\`no-unnecessary-type-assertion\`). Removal only.
- **(d)** Spec-file type-only mock alignment: Fix only for \`TS2741\`, \`TS2345\`, \`TS2352\`, \`TS2739\` where change is purely additive AND a production covering test exists.
- **(e)** CLAUDE.md banned-construct wrap: Restricted to finding id \`banned-construct:brace-free-if\` ONLY. Wrap the cited line's brace-free \`if\` statement in \`{ }\`. Abort on any change touching MORE than the single cited line. Purely syntactic — no semantic refactor. \`nested-ternary\` and \`orphan-*\` are NOT in this class. Snapshot-and-revert still applies: a wrap that reddens a previously-green test is auto-reverted.

### Abort Grammar

Write \`\${SESSION_ROOT}/gate/remediation_aborted_<reason>_<iso>.md\` and exit cleanly when:

- A fix outside classes (a)-(e) is required
- Class (d) fix but no covering test exists → filename: \`remediation_aborted_unverified_production_change_<iso>.md\`
- A fix would require changing behavior
- The brief is missing, malformed, or has no SESSION_ROOT
- The failing-files list is empty
- A concurrent remediator lockfile exists at \`\${SESSION_ROOT}/gate/remediator.lockfile\`

The abort file must contain: reason, affected file:line, what fix was requested, why it was refused.

### Invariants

- Edit ONLY files listed in Section 1's failing-files set. Zero exceptions.
- Do not change indentation, whitespace, or comments outside the failing line(s).
- Do not rename symbols, extract helpers, or reorganize imports.
- Do not run \`pnpm install\`, \`npm install\`, or any package manager mutation.
- Do not write to \`state.json\`, \`microverse.json\`, or any orchestrator-owned file.
- Write your outcome to \`\${SESSION_ROOT}/gate/remediation_<iso>_result.json\` only.
`;

function renderFailingFileBody(filePath: string, content: string): string {
  if (content === '__UNREADABLE__') return `_Could not read file (unreadable or not found). Read it fresh before editing._\n`;
  if (content === '__OVERSIZED__') return `_File exceeds ${MAX_FILE_BYTES} bytes. Read path directly: \`${filePath}\`_\n`;
  const ext = path.extname(filePath).slice(1) || 'text';
  return `\`\`\`${ext}\n${content}\n\`\`\`\n`;
}

function renderFailingFileSections(failingFileContents: Map<string, string>): string[] {
  if (failingFileContents.size === 0) return ['_No failing files to display._\n'];
  const out: string[] = [];
  for (const [filePath, content] of failingFileContents) {
    out.push(`### \`${filePath}\`\n`);
    out.push(renderFailingFileBody(filePath, content));
  }
  return out;
}

function buildBriefContent(opts: {
  gateResult: GateResult;
  sessionRoot: string;
  reason: string;
  iso: string;
  failingFileContents: Map<string, string>;
  trapDoorSection: string;
}): string {
  const { gateResult, sessionRoot, reason, iso, failingFileContents, trapDoorSection } = opts;

  const sections: string[] = [];

  sections.push(`# Gate Remediation Brief`);
  sections.push(`\n**Generated**: ${iso}  \n**Session root**: ${sessionRoot}  \n**Reason**: ${reason}  \n**Gate status**: ${gateResult.status}  \n**Failures**: ${gateResult.failures.length}\n`);

  sections.push(`## Section 1: Gate Failures (verbatim)\n`);
  sections.push(formatFailuresTable(gateResult.failures));

  sections.push(`## Section 2: Failing File Contents\n`);
  sections.push(...renderFailingFileSections(failingFileContents));

  sections.push(`## Section 3: Relevant CLAUDE.md Trap Doors\n`);
  sections.push(trapDoorSection + '\n');

  sections.push(`## Section 4: Hard Rule and Abort Grammar\n`);
  sections.push(SECTION_4_HARD_RULE_AND_ABORT_GRAMMAR);

  sections.push(`## Section 5: Evidence & Reporting\n`);
  sections.push(FOM_EVIDENCE_RULES + '\n');
  sections.push(FOM_HONEST_REPORTING_RULES + '\n');

  return sections.join('\n');
}

interface SpawnGateRemediatorDeps {
  hasInjectedReadFile: boolean;
  readFile: (p: string, enc: 'utf-8') => string;
  writeFile: (p: string, data: string, enc: 'utf-8') => void;
  mkdirSync: (p: string, opts: { recursive: boolean }) => void;
}

interface ParsedRemediatorFlags {
  gateResultPath: string;
  sessionRoot: string;
  reason: string;
}

function resolveInheritedBackend(): { backend: Backend; source: 'env' | 'default' } {
  const envBackend = process.env.PICKLE_BACKEND;
  if (isBackend(envBackend)) return { backend: envBackend, source: 'env' };
  return { backend: 'claude', source: 'default' };
}

function resolveDeps(opts: SpawnGateRemediatorOpts): SpawnGateRemediatorDeps {
  return {
    hasInjectedReadFile: typeof opts.readFileFn === 'function',
    readFile: opts.readFileFn ?? ((p: string, enc: 'utf-8') => fs.readFileSync(p, enc)),
    writeFile: opts.writeFileFn ?? ((p: string, data: string, enc: 'utf-8') => fs.writeFileSync(p, data, enc)),
    mkdirSync: opts.mkdirSyncFn ?? ((p: string, o: { recursive: boolean }) => fs.mkdirSync(p, o)),
  };
}

function parseRemediatorFlags(argv: string[]): { ok: true; flags: ParsedRemediatorFlags } | { ok: false; error: string } {
  const gateResultPath = parseFlag(argv, '--gate-result');
  const sessionRoot = parseFlag(argv, '--session-root');
  const reason = parseFlag(argv, '--reason');

  if (!gateResultPath || !sessionRoot || !reason) {
    return { ok: false, error: `Missing required flags.\n${USAGE}` };
  }
  if (!VALID_REASONS.has(reason)) {
    return { ok: false, error: `--reason must be strict|per-iteration, got: ${reason}` };
  }
  return { ok: true, flags: { gateResultPath, sessionRoot, reason } };
}

function loadGateResult(
  gateResultPath: string,
  deps: Pick<SpawnGateRemediatorDeps, 'hasInjectedReadFile' | 'readFile'>,
): { ok: true; gateResult: GateResult } | { ok: false; error: string } {
  try {
    const raw = !deps.hasInjectedReadFile
      ? readRecoverableJsonObject(gateResultPath)
      : JSON.parse(deps.readFile(gateResultPath, 'utf-8'));
    if (raw === null) {
      throw new Error('gate-result JSON is missing, malformed, or not an object');
    }
    if (!isGateResult(raw)) {
      return { ok: false, error: `gate-result JSON at ${gateResultPath} is not a valid GateResult` };
    }
    return { ok: true, gateResult: raw };
  } catch (e) {
    return { ok: false, error: `Failed to read --gate-result ${gateResultPath}: ${safeErrorMessage(e)}` };
  }
}

function ensureGateDir(gateDir: string, deps: Pick<SpawnGateRemediatorDeps, 'mkdirSync'>): string | null {
  try {
    deps.mkdirSync(gateDir, { recursive: true });
    return null;
  } catch (e) {
    return `Failed to create gate dir ${gateDir}: ${safeErrorMessage(e)}`;
  }
}

/**
 * Reclaim a remediator lock stranded by an abrupt death (SIGKILL/SIGTERM/OOM), which skips the
 * `process.on('exit')` release. Reclaims through the shared `reclaimDeadLock` composition, which
 * owns the proof-of-death rule and the no-age-arm rule — both load-bearing here, since a remediator
 * legitimately holds for minutes while it drives a full worker turn.
 */
function reclaimDeadRemediatorLock(lockfilePath: string): void {
  reclaimDeadLock(lockfilePath);
}

function acquireLockfile(
  lockfilePath: string,
  flags: Pick<ParsedRemediatorFlags, 'sessionRoot' | 'reason'>,
  iso: string,
  deps: Pick<SpawnGateRemediatorDeps, 'writeFile'>,
  stdout: (msg: string) => void,
): { ok: true; held: LockHandle } | { ok: false; exitCode: number; error?: string } {
  try {
    // Payload is the BARE holder pid — the one encoding `isDeadPidPayload` reads. The prior
    // create-then-close published an EMPTY payload, which parses to NaN there, so any steal
    // bolted onto it would have silently never fired.
    let held = acquireLockFile(lockfilePath, String(process.pid));
    if (held === null) {
      reclaimDeadRemediatorLock(lockfilePath);
      held = acquireLockFile(lockfilePath, String(process.pid));
    }
    if (held !== null) return { ok: true, held };

    // Still held after a reclaim attempt => a provably LIVE remediator owns it. Defer to it.
    const lockoutPath = path.join(path.dirname(lockfilePath), `remediator_concurrent_lockout_${iso}.md`);
    const lockoutContent = [
      `# Concurrent Remediator Lockout`,
      ``,
      `A live remediator is already running (lockfile held at \`${lockfilePath}\`).`,
      ``,
      `**Timestamp**: ${iso}`,
      `**Session root**: ${flags.sessionRoot}`,
      `**Reason requested**: ${flags.reason}`,
      ``,
      `This invocation exited cleanly without performing any work. The active remediator will complete and release the lock.`,
    ].join('\n');
    try {
      deps.writeFile(lockoutPath, lockoutContent, 'utf-8');
      stdout(`LOCKOUT_PATH=${lockoutPath}`);
    } catch { /* best-effort */ }
    return { ok: false, exitCode: 0 };
  } catch (e) {
    return { ok: false, exitCode: 1, error: `Failed to acquire lockfile ${lockfilePath}: ${safeErrorMessage(e)}` };
  }
}

function loadFailingFileContents(gateResult: GateResult, readFile: (p: string, enc: 'utf-8') => string): Map<string, string> {
  const failingFiles = [...new Set(gateResult.failures.map(f => f.file))];
  const failingFileContents = new Map<string, string>();

  for (const filePath of failingFiles) {
    try {
      const raw = readFile(filePath, 'utf-8');
      failingFileContents.set(filePath, raw.length > MAX_FILE_BYTES ? '__OVERSIZED__' : raw);
    } catch {
      failingFileContents.set(filePath, '__UNREADABLE__');
    }
  }
  return failingFileContents;
}

function loadTrapDoorSection(
  extensionClaudeMdContent: string | undefined,
  readFile: (p: string, enc: 'utf-8') => string,
): string {
  if (extensionClaudeMdContent) return extensionClaudeMdContent;

  const claudeMdPath = path.join(
    path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    'CLAUDE.md'
  );
  try {
    return readFile(claudeMdPath, 'utf-8');
  } catch {
    return '_CLAUDE.md trap-door section not available at brief-prep time. Read extension/CLAUDE.md before editing._';
  }
}

function writeBriefFile(
  gateDir: string,
  iso: string,
  briefContent: string,
  writeFile: (p: string, data: string, enc: 'utf-8') => void,
): string {
  const briefFileName = `remediation_${iso}_brief.md`;
  const briefPath = path.join(gateDir, briefFileName);
  writeFile(briefPath, briefContent, 'utf-8');
  return briefPath;
}

interface RemediatorContext {
  gateResult: GateResult;
  sessionRoot: string;
  reason: string;
  gateDir: string;
}

/**
 * Flags, then gate result, then gate dir. Every failure in that chain has the same disposition —
 * report the operator-facing message and exit 1 — so the three checks collapse into one Result the
 * caller reports at a single site instead of three copies of the same two lines.
 */
function preflightRemediator(
  argv: string[],
  deps: SpawnGateRemediatorDeps,
): { ok: true; ctx: RemediatorContext } | { ok: false; error: string } {
  const parsedFlags = parseRemediatorFlags(argv);
  if (!parsedFlags.ok) return { ok: false, error: parsedFlags.error };
  const { gateResultPath, sessionRoot, reason } = parsedFlags.flags;

  const gateResultLoad = loadGateResult(gateResultPath, deps);
  if (!gateResultLoad.ok) return { ok: false, error: gateResultLoad.error };

  const gateDir = path.join(sessionRoot, 'gate');
  const gateDirError = ensureGateDir(gateDir, deps);
  if (gateDirError) return { ok: false, error: gateDirError };

  return { ok: true, ctx: { gateResult: gateResultLoad.gateResult, sessionRoot, reason, gateDir } };
}

/**
 * R-GRLS: `worker_spawn_backend_resolved.source` stays inside `BackendResolutionSource` semantics
 * (`env` or `default` here). Telemetry only — a failed write never fails the remediation.
 */
function recordInheritedBackend(sessionRoot: string): void {
  const { backend, source } = resolveInheritedBackend();
  try {
    writeActivityEntry(path.join(sessionRoot, 'state.json'), {
      event: 'worker_spawn_backend_resolved',
      ts: new Date().toISOString(),
      backend,
      source,
      pid: process.pid,
      session: path.basename(sessionRoot),
    });
  } catch {
    /* best-effort telemetry */
  }
}

/** Gather the brief's two file-backed inputs, render it, and land it in `gate/`. */
function produceRemediationBrief(
  ctx: RemediatorContext,
  iso: string,
  extensionClaudeMdContent: string | undefined,
  deps: SpawnGateRemediatorDeps,
): string {
  const failingFileContents = loadFailingFileContents(ctx.gateResult, deps.readFile);
  const trapDoorSection = loadTrapDoorSection(extensionClaudeMdContent, deps.readFile);

  const briefContent = buildBriefContent({
    gateResult: ctx.gateResult,
    sessionRoot: ctx.sessionRoot,
    reason: ctx.reason,
    iso,
    failingFileContents,
    trapDoorSection,
  });

  return writeBriefFile(ctx.gateDir, iso, briefContent, deps.writeFile);
}

export async function spawnGateRemediatorMain(opts: SpawnGateRemediatorOpts): Promise<number> {
  const {
    argv,
    isoOverride,
    extensionClaudeMdContent,
    stdout = (msg: string) => process.stdout.write(msg + '\n'),
    stderr = (msg: string) => process.stderr.write(msg + '\n'),
  } = opts;

  const deps = resolveDeps(opts);
  const preflight = preflightRemediator(argv, deps);
  if (!preflight.ok) {
    stderr(preflight.error);
    return 1;
  }
  const ctx = preflight.ctx;
  const iso = isoOverride ?? isoCompactStamp();

  const lockfilePath = path.join(ctx.gateDir, LOCKFILE_NAME);
  const lock = acquireLockfile(lockfilePath, ctx, iso, deps, stdout);
  if (!lock.ok) {
    if (lock.error) stderr(lock.error);
    return lock.exitCode;
  }

  // Release is identity-bound (inode AND payload bytes): a lock we no longer own — ours was reclaimed
  // by a contender after an abrupt death — is left for its new holder, never unlinked out from under it.
  const cleanup = () => {
    try {
      releaseLockFile(lockfilePath, lock.held);
    } catch { /* already gone */ }
  };
  process.on('exit', cleanup);

  try {
    recordInheritedBackend(ctx.sessionRoot);
    const briefPath = produceRemediationBrief(ctx, iso, extensionClaudeMdContent, deps);
    stdout(`BRIEF_PATH=${briefPath}`);
    return 0;
  } catch (e) {
    stderr(`spawn-gate-remediator error: ${safeErrorMessage(e)}`);
    return 1;
  } finally {
    cleanup();
    process.off('exit', cleanup);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === 'spawn-gate-remediator.js') {
  spawnGateRemediatorMain({ argv: process.argv.slice(2) })
    .then(code => process.exit(code))
    .catch(e => {
      process.stderr.write(`spawn-gate-remediator fatal: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
