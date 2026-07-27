import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync, SpawnSyncReturns } from 'child_process';
import { State } from '../../types/index.js';
import { approve, loadActiveState, resolveStateFile } from '../resolve-state.js';
import { logActivity } from '../../services/activity-logger.js';
import { getDataRoot, safeErrorMessage } from '../../services/pickle-utils.js';
import { StateManager } from '../../services/state-manager.js';
import { execName, splitShellSegments, tokenizeShellCommand } from '../shell-exec.js';

interface PreToolUseHookPayload {
  tool_name?: string;
  tool_input?: {
    command?: string;
    [key: string]: unknown;
  };
  session_dir?: string;
}

type GateFailureKind =
  | 'compile_error'
  | 'timeout'
  | 'cold_cache_timeout'
  | 'setup_error'
  | 'crashed';

interface TextCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
  timedOut: boolean;
}

interface CommandFailureResult {
  status: number | null;
  timedOut: boolean;
  error?: Error;
}

/**
 * Git global options that consume the FOLLOWING token as their value in
 * space-separated form (`git -C <path> commit`). The commit-classification scan
 * must skip both the option AND its value, otherwise the value token is read as
 * the subcommand and a real `git commit` is mis-classified as non-commit — the
 * R-WACT tsc gate is then SKIPPED for that commit. Mirrors the 7-option coverage
 * of `config-protection.ts:ARG_CONSUMING_GIT_GLOBAL_OPTIONS` (findGitVerb) so the
 * two sibling git-command detectors stay in parity. The `=`-glued forms
 * (`--git-dir=<path>`) are self-contained and skipped as single flag tokens.
 */
const ARG_CONSUMING_GIT_GLOBAL_OPTIONS = new Set([
  '-c', '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path',
]);

const TSC_TRIGGER_RE = /\.(?:[cm]?ts|tsx)$/i;
const TSC_CONFIG_RE = /^tsconfig(?:\..+)?\.json$/i;
const PACKAGE_JSON_RE = /^package.*\.json$/i;
const NEGATIVE_GIT_SUBCOMMANDS = new Set(['log', 'diff', 'show', 'rev-parse']);
const CD_PREFIX_RE = /^cd\s+(?:"[^"]*"|'[^']*'|[^;&]+?)\s*(?:&&|;)\s*/;
const COMMAND_TIMEOUT_MS = 5_000;
const ALLOW_TSC_FAILED_REASON_FIELD = 'allow_tsc_failed_reason';
const sm = new StateManager();

type GateDecision =
  | { decision: 'approve' }
  | { decision: 'block'; reason: string; failureKind: GateFailureKind };

function block(reason: string): void {
  console.log(JSON.stringify({ decision: 'block', reason }));
}

function readHookInputData(): string | null {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return null;
  }
}

function parseHookInput(inputData: string): PreToolUseHookPayload | null {
  if (!inputData.trim()) return null;
  try {
    return JSON.parse(inputData) as PreToolUseHookPayload;
  } catch {
    return null;
  }
}

function loadResolvedState(): State | null {
  const stateFile = resolveStateFile(getDataRoot());
  if (!stateFile) return null;
  return loadActiveState(stateFile);
}

function resolveActiveStateFile(): string | null {
  return resolveStateFile(getDataRoot());
}

function trimmedFlag(flags: Record<string, unknown> | undefined, key: string): string | null {
  if (!flags) return null;
  const raw = flags[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stripCdPrefix(command: string): string {
  let stripped = command.trim();
  while (CD_PREFIX_RE.test(stripped)) {
    stripped = stripped.replace(CD_PREFIX_RE, '').trimStart();
  }
  return stripped;
}

function segmentIsGitCommit(segment: string): boolean {
  const stripped = stripCdPrefix(segment);
  const tokens = tokenizeShellCommand(stripped);
  if (tokens.length === 0) return false;

  // Skip leading `NAME=value` env-var assignments before the executable token
  // (`GIT_COMMITTER_DATE=… git commit`). config-protection.ts:findGitVerb and
  // parseFirstShellWord both skip these via the identical regex; without the
  // same skip here, an env-prefixed commit reads `GIT_COMMITTER_DATE=…` as
  // tokens[0], fails the `=== 'git'` check, is classified non-commit, and SKIPS
  // the R-WACT tsc gate for a real broken-TS commit — a one-sided parity gap
  // vs the sibling detector (which catches `GIT_DIR=x git reset`).
  let gitIdx = 0;
  while (gitIdx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[gitIdx])) gitIdx++;
  // execName (not a raw compare): folds case and takes the basename, so
  // `GIT commit` and `/usr/bin/git commit` — which really do run git on a
  // case-insensitive filesystem — still classify as commits. A raw
  // `!== 'git'` here classified them non-commit and SKIPPED the R-WACT gate
  // entirely, letting a worker land broken TypeScript. The sibling detector
  // in config-protection.ts already folded through `execName`; this was the
  // remaining half of that parity pair.
  const execToken = execName(tokens[gitIdx]);
  if (execToken === 'gh') return false;
  if (execToken !== 'git') return false;

  let index = gitIdx + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    // Skip a space-separated arg-consuming global option AND its value token
    // (`-C <path>`), so the value is never mistaken for the subcommand.
    if (ARG_CONSUMING_GIT_GLOBAL_OPTIONS.has(token)) {
      index += 2;
      continue;
    }
    // Skip ANY other leading flag before the subcommand: a non-arg-consuming
    // boolean global option (`--no-pager`, `-p`, `--paginate`,
    // `--no-optional-locks`, `--bare`, …) OR an `=`-glued arg-option
    // (`--git-dir=…`, `-cuser.name=x`). Mirrors findGitVerb, which skips every
    // `-`-prefixed token before reading the verb; without this, a boolean flag
    // falls through to the `=== 'commit'` read, is mistaken for the subcommand,
    // mis-classifies `git --no-pager commit` as non-commit, and SKIPS the
    // R-WACT tsc gate for a broken-TS commit.
    if (token.startsWith('-')) {
      index += 1;
      continue;
    }
    if (NEGATIVE_GIT_SUBCOMMANDS.has(token)) return false;
    return token === 'commit';
  }

  return false;
}

export function isGitCommitCommand(command: string): boolean {
  return splitShellSegments(command).some(segmentIsGitCommit);
}

function runTextCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): TextCommandResult {
  const result = spawnSync(cmd, args, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
    timedOut: hasTimedOut(result),
  };
}

function hasTimedOut(result: SpawnSyncReturns<string | Buffer>): boolean {
  if (!result.error) return false;
  const errno = result.error as NodeJS.ErrnoException;
  return errno.code === 'ETIMEDOUT';
}

function parseLineList(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isCommandFailure(result: CommandFailureResult): boolean {
  return result.status !== 0 || result.timedOut || Boolean(result.error);
}

function listStagedPaths(repoRoot: string): TextCommandResult & { paths: string[] } {
  const result = runTextCommand('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], repoRoot, COMMAND_TIMEOUT_MS);
  return { ...result, paths: parseLineList(result.stdout) };
}

function listAddedPaths(repoRoot: string): TextCommandResult & { paths: string[] } {
  const result = runTextCommand('git', ['diff', '--cached', '--name-only', '--diff-filter=A'], repoRoot, COMMAND_TIMEOUT_MS);
  return { ...result, paths: parseLineList(result.stdout) };
}

function shouldRunTsc(paths: string[]): boolean {
  return paths.some((filePath) => {
    const base = path.basename(filePath);
    return TSC_TRIGGER_RE.test(filePath) || TSC_CONFIG_RE.test(base) || PACKAGE_JSON_RE.test(base);
  });
}

function materializeStagedTree(repoRoot: string, destinationRoot: string, addedPaths: string[]): TextCommandResult | null {
  const checkoutPrefix = destinationRoot.endsWith(path.sep) ? destinationRoot : `${destinationRoot}${path.sep}`;
  // Stage isolation uses `git checkout-index --prefix` against the staged tree.
  const checkoutResult = runTextCommand(
    'git',
    ['checkout-index', '--prefix', checkoutPrefix, '--stage=0', '-a'],
    repoRoot,
    COMMAND_TIMEOUT_MS,
  );
  if (checkoutResult.status !== 0 || checkoutResult.timedOut || checkoutResult.error) {
    return checkoutResult;
  }

  for (const relativePath of addedPaths) {
    const showResult = spawnSync('git', ['show', `:${relativePath}`], {
      cwd: repoRoot,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (hasTimedOut(showResult)) {
      return { status: showResult.status, stdout: '', stderr: String(showResult.stderr ?? ''), error: showResult.error, timedOut: true };
    }
    if (showResult.error || showResult.status !== 0) {
      return {
        status: showResult.status,
        stdout: '',
        stderr: String(showResult.stderr ?? ''),
        error: showResult.error,
        timedOut: false,
      };
    }

    const outputPath = path.join(destinationRoot, relativePath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, showResult.stdout);
  }

  return null;
}

function getTscTimeoutMs(): number {
  const dispatchTimeout = Number(process.env.PICKLE_DISPATCH_TIMEOUT_MS) || 10_000;
  return Math.min(8_000, Math.max(1_000, dispatchTimeout - 1_000));
}

function classifyTscFailure(result: TextCommandResult): GateFailureKind {
  if (result.timedOut) {
    return (result.stdout + result.stderr).trim().length === 0 ? 'cold_cache_timeout' : 'timeout';
  }
  return 'compile_error';
}

function formatBlockReason(kind: GateFailureKind, details: string): string {
  const suffix = details.trim().length > 0 ? `: ${details.trim()}` : '.';
  return `R-WACT: tsc --noEmit failed with ${kind}${suffix}`;
}

function runTscGate(repoRoot: string, stagedPaths: string[]): GateDecision {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rick-tsc-gate-'));
  try {
    const added = listAddedPaths(repoRoot);
    if (isCommandFailure(added)) {
      return {
        decision: 'block',
        reason: formatBlockReason('setup_error', safeErrorMessage(added.error) || added.stderr || 'failed to enumerate added staged files'),
        failureKind: 'setup_error',
      };
    }

    const materializeResult = materializeStagedTree(repoRoot, tempDir, added.paths);
    if (materializeResult) {
      return {
        decision: 'block',
        reason: formatBlockReason('setup_error', safeErrorMessage(materializeResult.error) || materializeResult.stderr || 'failed to materialize staged tree'),
        failureKind: 'setup_error',
      };
    }

    const tscResult = runTextCommand('npx', ['tsc', '--noEmit'], tempDir, getTscTimeoutMs());
    if (tscResult.status === 0 && !tscResult.error) {
      return { decision: 'approve' };
    }

    const failureKind = classifyTscFailure(tscResult);
    const detailSource = tscResult.stderr || tscResult.stdout || `staged changes: ${stagedPaths.join(', ')}`;
    return {
      decision: 'block',
      reason: formatBlockReason(failureKind, detailSource.split('\n')[0] || failureKind),
      failureKind,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function emitTscGateFailed(reason: string, failureKind: GateFailureKind, command: string): void {
  try {
    logActivity({
      event: 'tsc_gate_failed',
      source: 'hook',
      reason,
      gate_payload: {
        failure_kind: failureKind,
        command,
      },
    } as never);
  } catch {
    /* activity logging is best effort */
  }
}

function emitTscGateOverrideUsed(overrideReason: string, failureKind: GateFailureKind, command: string): void {
  try {
    logActivity({
      event: 'tsc_gate_override_used',
      source: 'hook',
      gate_payload: {
        override_reason: overrideReason,
        failure_kind: failureKind,
        command,
      },
    } as never);
  } catch {
    /* activity logging is best effort */
  }
}

function emitTscGateOverrideConsumed(overrideReason: string, command: string): void {
  try {
    logActivity({
      event: 'tsc_gate_override_consumed',
      source: 'hook',
      gate_payload: {
        override_reason: overrideReason,
        command,
      },
    } as never);
  } catch {
    /* activity logging is best effort */
  }
}

function consumeTscOverride(command: string): void {
  const stateFile = resolveActiveStateFile();
  if (!stateFile) return;

  let consumedReason: string | null = null;
  sm.update(stateFile, (loadedState) => {
    const flags = { ...(loadedState.flags ?? {}) };
    const currentReason = trimmedFlag(flags, ALLOW_TSC_FAILED_REASON_FIELD);
    if (!currentReason) return;
    consumedReason = currentReason;
    delete flags[ALLOW_TSC_FAILED_REASON_FIELD];
    loadedState.flags = flags;
  });

  if (consumedReason) {
    emitTscGateOverrideConsumed(consumedReason, command);
  }
}

function evaluateCommitCommand(command: string, state: State | null): GateDecision {
  const allowReason = trimmedFlag(state?.flags, ALLOW_TSC_FAILED_REASON_FIELD);
  const repoRootResult = runTextCommand('git', ['rev-parse', '--show-toplevel'], process.cwd(), COMMAND_TIMEOUT_MS);
  if (isCommandFailure(repoRootResult)) {
    const decision = {
      decision: 'block',
      reason: formatBlockReason('setup_error', safeErrorMessage(repoRootResult.error) || repoRootResult.stderr || 'failed to resolve repository root'),
      failureKind: 'setup_error',
    } as const;
    if (allowReason) {
      emitTscGateOverrideUsed(allowReason, decision.failureKind, command);
      return { decision: 'approve' };
    }
    emitTscGateFailed(decision.reason, decision.failureKind, command);
    return decision;
  }
  const repoRoot = repoRootResult.stdout.trim();

  const staged = listStagedPaths(repoRoot);
  if (isCommandFailure(staged)) {
    const decision = {
      decision: 'block',
      reason: formatBlockReason('setup_error', safeErrorMessage(staged.error) || staged.stderr || 'failed to enumerate staged files'),
      failureKind: 'setup_error',
    } as const;
    if (allowReason) {
      emitTscGateOverrideUsed(allowReason, decision.failureKind, command);
      return { decision: 'approve' };
    }
    emitTscGateFailed(decision.reason, decision.failureKind, command);
    return decision;
  }

  if (!shouldRunTsc(staged.paths)) {
    return { decision: 'approve' };
  }

  const gateDecision = runTscGate(repoRoot, staged.paths);
  if (gateDecision.decision === 'approve') {
    if (allowReason) consumeTscOverride(command);
    return gateDecision;
  }

  if (allowReason) {
    emitTscGateOverrideUsed(allowReason, gateDecision.failureKind, command);
    return { decision: 'approve' };
  }

  emitTscGateFailed(gateDecision.reason, gateDecision.failureKind, command);
  return gateDecision;
}

function emitCrashEvent(error: unknown, command: string): void {
  try {
    logActivity({
      event: 'tsc_gate_crashed' as never,
      source: 'hook',
      gate_payload: {
        error: safeErrorMessage(error),
        command,
        failure_kind: 'crashed',
      },
    } as never);
  } catch {
    /* activity logging is best effort */
  }
}

function main(): void {
  const inputData = readHookInputData();
  const input = inputData ? parseHookInput(inputData) : null;
  if (!input) {
    approve();
    return;
  }

  if (input.tool_name !== 'Bash') {
    approve();
    return;
  }

  const command = input.tool_input?.command;
  if (typeof command !== 'string' || !isGitCommitCommand(command)) {
    approve();
    return;
  }

  const state = loadResolvedState();
  const decision = evaluateCommitCommand(command, state);
  if (decision.decision === 'approve') {
    approve();
    return;
  }
  block(decision.reason || formatBlockReason('compile_error', 'unknown tsc failure'));
}

// CLI guard: only execute the hook entrypoint when invoked directly as a
// script. Importing the module (e.g. tests reusing `isGitCommitCommand`)
// must not block on stdin or emit hook decisions.
if (process.argv[1] && path.basename(process.argv[1]) === 'tsc-gate.js') {
  try {
    main();
  } catch (error) {
    const inputData = readHookInputData();
    const input = inputData ? parseHookInput(inputData) : null;
    emitCrashEvent(error, input?.tool_input?.command ?? '');
    approve();
  }
}
