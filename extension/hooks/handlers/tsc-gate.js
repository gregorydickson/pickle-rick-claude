import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { approve, loadActiveState, resolveStateFile } from '../resolve-state.js';
import { logActivity } from '../../services/activity-logger.js';
import { getDataRoot, safeErrorMessage } from '../../services/pickle-utils.js';
import { StateManager } from '../../services/state-manager.js';
import { execAnchorIndex, execNamesIn, splitShellSegments, tokenizeShellTokens } from '../shell-exec.js';
const TSC_TRIGGER_RE = /\.(?:[cm]?ts|tsx)$/i;
const TSC_CONFIG_RE = /^tsconfig(?:\..+)?\.json$/i;
const PACKAGE_JSON_RE = /^package.*\.json$/i;
const NEGATIVE_GIT_SUBCOMMANDS = new Set(['log', 'diff', 'show', 'rev-parse']);
/**
 * The subcommand that RUNS this gate, read as a PATTERN via the shared
 * `execNamesIn` (AP-EXT-ITER93-02) — bash expands every word of a command, not
 * only the command word, so with a file named `commit` in cwd `git commi? -m x`
 * really commits while a `=== 'commit'` compare classified it NON-commit and the
 * R-WACT tsc gate was SKIPPED for a broken-TS commit (`git com[m]it`,
 * `git {commit,status}` measured the same). One name, still the SET read rather
 * than `execNameIs`: `execNamesIn` carries the measured `*` bound, without which
 * `git add c*` would name `commit` and run tsc over a command that commits
 * nothing.
 *
 * `NEGATIVE_GIT_SUBCOMMANDS` deliberately stays a LITERAL read: widening the arm
 * that returns FALSE would let a globbed `lo?` decide the segment is read-only
 * and skip the gate — the under-block direction. Only the arm whose over-reach
 * merely RUNS the gate is pattern-aware.
 */
const GIT_COMMIT_SUBCOMMAND = ['commit'];
const CD_PREFIX_RE = /^cd\s+(?:"[^"]*"|'[^']*'|[^;&]+?)\s*(?:&&|;)\s*/;
const COMMAND_TIMEOUT_MS = 5_000;
const ALLOW_TSC_FAILED_REASON_FIELD = 'allow_tsc_failed_reason';
const sm = new StateManager();
function block(reason) {
    console.log(JSON.stringify({ decision: 'block', reason }));
}
function readHookInputData() {
    try {
        return fs.readFileSync(0, 'utf8');
    }
    catch {
        return null;
    }
}
function parseHookInput(inputData) {
    if (!inputData.trim())
        return null;
    try {
        return JSON.parse(inputData);
    }
    catch {
        return null;
    }
}
function loadResolvedState() {
    const stateFile = resolveStateFile(getDataRoot());
    if (!stateFile)
        return null;
    return loadActiveState(stateFile);
}
function resolveActiveStateFile() {
    return resolveStateFile(getDataRoot());
}
function trimmedFlag(flags, key) {
    if (!flags)
        return null;
    const raw = flags[key];
    if (typeof raw !== 'string')
        return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function stripCdPrefix(command) {
    let stripped = command.trim();
    while (CD_PREFIX_RE.test(stripped)) {
        stripped = stripped.replace(CD_PREFIX_RE, '').trimStart();
    }
    return stripped;
}
function segmentIsGitCommit(segment) {
    const stripped = stripCdPrefix(segment);
    const tokens = tokenizeShellTokens(stripped);
    // The git ANCHOR, not the exec-token prelude — the same collapse
    // config-protection's `findGitVerb` (AP-EXT-ITER63-02) and
    // `extractNodeTestPathsFromSegment` (AP-EXT-ITER63-05) already made. A POSIX
    // command PREFIX (`env`, `command`, `nohup`, `nice`, `exec`, `time`, `sudo`,
    // …) is an ordinary program that takes a command as its argument and execs
    // it, so it stands in exec position with the real executable behind it:
    // `execTokenIndex` landed on the PREFIX, `env git commit -m x` classified
    // NON-commit, and the R-WACT tsc gate was SKIPPED for a broken-TS commit
    // while the bare twin gated. Teaching the prelude those prefixes means
    // enumerating them — the incomplete-declaration shape that has now failed
    // eleven times in this module, one member from the next bypass. Asking
    // instead "does this segment contain a token the shell may exec as git,
    // wherever it sits" needs no table, exactly as the subcommand scan below
    // needs no git-option table.
    //
    // `execAnchorIndex` folds through `execName`, so `GIT commit` and
    // `/usr/bin/git commit` — which really do run git on a case-insensitive
    // filesystem — still classify as commits, and it reads no `.quoted` flag, so
    // `env 'git' commit` cannot hide behind quotes either (AP-EXT-ITER64-01).
    // The `gh` arm the prelude needed is gone with it: `gh pr create` carries no
    // `git` anchor, so it returns -1 rather than needing its own exclusion.
    const gitIdx = execAnchorIndex(tokens, 'git');
    if (gitIdx === -1)
        return false;
    // ONE uniform read, in parity with config-protection.ts:findGitVerb: skip every
    // `-`-prefixed token (boolean global option, `=`-glued arg-option) and classify
    // on the first bare word that is DECISIVE — `commit`, or a read-only subcommand.
    //
    // Deliberately no arg-consuming-option table. The former
    // `ARG_CONSUMING_GIT_GLOBAL_OPTIONS` skip-with-value omitted `--config-env`,
    // whose separate-operand form git accepts, so `git --config-env core.bare=MYVAL
    // commit -m x` read the operand as the subcommand, classified NON-COMMIT, and
    // SKIPPED the R-WACT tsc gate for a broken-TS commit (measured 2026-08-25 against
    // the shipped handler). Any such table fails OPEN on the option it lacks; keying
    // on the subcommand word instead means an unrecognised global option is stepped
    // over, and an option OPERAND spelling `commit` at worst RUNS the gate — safe.
    for (let index = gitIdx + 1; index < tokens.length; index++) {
        const token = tokens[index].value;
        if (token.startsWith('-'))
            continue;
        if (execNamesIn(token, GIT_COMMIT_SUBCOMMAND).length > 0)
            return true;
        // A read-only subcommand decides the segment: without this, `git log <ref>`
        // would scan past `log` and could match a ref literally named `commit`.
        if (NEGATIVE_GIT_SUBCOMMANDS.has(token))
            return false;
    }
    return false;
}
export function isGitCommitCommand(command) {
    return splitShellSegments(command).some(segmentIsGitCommit);
}
function runTextCommand(cmd, args, cwd, timeoutMs) {
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
function hasTimedOut(result) {
    if (!result.error)
        return false;
    const errno = result.error;
    return errno.code === 'ETIMEDOUT';
}
/**
 * The ONE reader of a failed command's diagnosis, and the only place this file
 * turns a `TextCommandResult` into `setup_error` prose.
 *
 * `safeErrorMessage` is deliberately NOT used here: it is `String(err)`, so
 * `safeErrorMessage(undefined)` returns the truthy STRING `"undefined"` and
 * short-circuits any `... || result.stderr || fallback` chain. `spawnSync` sets
 * `.error` ONLY when the spawn itself fails, so on the COMMON failure — a
 * nonzero git exit — all four call sites reported `setup_error: undefined` and
 * dropped git's stderr. MEASURED on the shipped compiled hook: `git commit`
 * from outside a repository blocked with `setup_error: undefined` instead of
 * `fatal: not a git repository`.
 *
 * One helper, four call sites: a fifth hand-spelled `|| stderr ||` chain is how
 * the diagnosis was lost in the first place.
 */
function describeCommandFailure(result, fallback) {
    return result.error?.message || result.stderr || fallback;
}
function isCommandFailure(result) {
    return result.status !== 0 || result.timedOut || Boolean(result.error);
}
/**
 * The ONE reader of what this commit has STAGED, and the only place this file
 * spells `git diff --cached --name-only`. It carries `-z` and splits on NUL —
 * the same contract `scope-resolver.ts:computeAllowedFromDiff` builds the fence
 * from and `mux-runner.ts:listRangeTouchedPaths` (AP-EXT-ITER103-01) already
 * reads back.
 *
 * Without `-z`, `core.quotePath` C-quotes a non-ASCII or tab-bearing staged path
 * to `"src/ba\td.ts"` and the gate breaks in BOTH directions, MEASURED on the
 * shipped compiled hook with identical file CONTENT:
 *   - fail OPEN: the quoted spelling ends in a double quote, so
 *     `TSC_TRIGGER_RE`'s `$` anchor misses, `shouldRunTsc` is false and the
 *     R-WACT gate never runs — an ASCII-named twin of the same broken file
 *     returned `block`, the quoted one returned `approve`.
 *   - fail CLOSED: `materializeStagedTree` hands the quoted spelling to
 *     `git show :<path>`, which cannot resolve it, so a clean-compiling commit
 *     was blocked `setup_error`.
 *
 * Two filters, ONE argv: a second hand-spelled `--name-only` here is how the
 * two readers drifted apart in the first place. `--no-renames` is deliberately
 * absent — `--diff-filter=ACMR` wants a rename's DESTINATION, which is the file
 * to typecheck, and `--diff-filter=A` excludes renames outright.
 *
 * The output is NUL-delimited, so it is split but never trimmed: trimming would
 * corrupt a path git deliberately did not quote, such as one ending in a space.
 */
function listCachedPaths(repoRoot, diffFilter) {
    const result = runTextCommand('git', ['diff', '--cached', '--name-only', '-z', `--diff-filter=${diffFilter}`], repoRoot, COMMAND_TIMEOUT_MS);
    return { ...result, paths: result.stdout.split('\0').filter((entry) => entry.length > 0) };
}
function shouldRunTsc(paths) {
    return paths.some((filePath) => {
        const base = path.basename(filePath);
        return TSC_TRIGGER_RE.test(filePath) || TSC_CONFIG_RE.test(base) || PACKAGE_JSON_RE.test(base);
    });
}
function materializeStagedTree(repoRoot, destinationRoot, addedPaths) {
    const checkoutPrefix = destinationRoot.endsWith(path.sep) ? destinationRoot : `${destinationRoot}${path.sep}`;
    // Stage isolation uses `git checkout-index --prefix` against the staged tree.
    // NO `--stage` flag: git's checkout-index parses `--stage=<n>` as 1|2|3|all and
    // hard-errors `fatal: stage should be between 1 and 3 or all` on anything else, so
    // the `--stage=0` this call used to carry made EVERY materialization exit 128 —
    // the gate blocked every TypeScript commit with `setup_error` instead of gating it.
    // Omitting the flag IS stage 0: checkout-index writes the merged index entry, which
    // is exactly the staged content this gate must type-check.
    const checkoutResult = runTextCommand('git', ['checkout-index', '--prefix', checkoutPrefix, '-a'], repoRoot, COMMAND_TIMEOUT_MS);
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
function getTscTimeoutMs() {
    const dispatchTimeout = Number(process.env.PICKLE_DISPATCH_TIMEOUT_MS) || 10_000;
    return Math.min(8_000, Math.max(1_000, dispatchTimeout - 1_000));
}
function classifyTscFailure(result) {
    if (result.timedOut) {
        return (result.stdout + result.stderr).trim().length === 0 ? 'cold_cache_timeout' : 'timeout';
    }
    return 'compile_error';
}
function formatBlockReason(kind, details) {
    const suffix = details.trim().length > 0 ? `: ${details.trim()}` : '.';
    return `R-WACT: tsc --noEmit failed with ${kind}${suffix}`;
}
function runTscGate(repoRoot, stagedPaths) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-rick-tsc-gate-'));
    try {
        const added = listCachedPaths(repoRoot, 'A');
        if (isCommandFailure(added)) {
            return {
                decision: 'block',
                reason: formatBlockReason('setup_error', describeCommandFailure(added, 'failed to enumerate added staged files')),
                failureKind: 'setup_error',
            };
        }
        const materializeResult = materializeStagedTree(repoRoot, tempDir, added.paths);
        if (materializeResult) {
            return {
                decision: 'block',
                reason: formatBlockReason('setup_error', describeCommandFailure(materializeResult, 'failed to materialize staged tree')),
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
    }
    finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}
function emitTscGateFailed(reason, failureKind, command) {
    try {
        logActivity({
            event: 'tsc_gate_failed',
            source: 'hook',
            reason,
            gate_payload: {
                failure_kind: failureKind,
                command,
            },
        });
    }
    catch {
        /* activity logging is best effort */
    }
}
function emitTscGateOverrideUsed(overrideReason, failureKind, command) {
    try {
        logActivity({
            event: 'tsc_gate_override_used',
            source: 'hook',
            gate_payload: {
                override_reason: overrideReason,
                failure_kind: failureKind,
                command,
            },
        });
    }
    catch {
        /* activity logging is best effort */
    }
}
function emitTscGateOverrideConsumed(overrideReason, command) {
    try {
        logActivity({
            event: 'tsc_gate_override_consumed',
            source: 'hook',
            gate_payload: {
                override_reason: overrideReason,
                command,
            },
        });
    }
    catch {
        /* activity logging is best effort */
    }
}
function consumeTscOverride(command) {
    const stateFile = resolveActiveStateFile();
    if (!stateFile)
        return;
    let consumedReason = null;
    sm.update(stateFile, (loadedState) => {
        const flags = { ...(loadedState.flags ?? {}) };
        const currentReason = trimmedFlag(flags, ALLOW_TSC_FAILED_REASON_FIELD);
        if (!currentReason)
            return;
        consumedReason = currentReason;
        delete flags[ALLOW_TSC_FAILED_REASON_FIELD];
        loadedState.flags = flags;
    });
    if (consumedReason) {
        emitTscGateOverrideConsumed(consumedReason, command);
    }
}
function evaluateCommitCommand(command, state) {
    const allowReason = trimmedFlag(state?.flags, ALLOW_TSC_FAILED_REASON_FIELD);
    const repoRootResult = runTextCommand('git', ['rev-parse', '--show-toplevel'], process.cwd(), COMMAND_TIMEOUT_MS);
    if (isCommandFailure(repoRootResult)) {
        const decision = {
            decision: 'block',
            reason: formatBlockReason('setup_error', describeCommandFailure(repoRootResult, 'failed to resolve repository root')),
            failureKind: 'setup_error',
        };
        if (allowReason) {
            emitTscGateOverrideUsed(allowReason, decision.failureKind, command);
            return { decision: 'approve' };
        }
        emitTscGateFailed(decision.reason, decision.failureKind, command);
        return decision;
    }
    const repoRoot = repoRootResult.stdout.trim();
    const staged = listCachedPaths(repoRoot, 'ACMR');
    if (isCommandFailure(staged)) {
        const decision = {
            decision: 'block',
            reason: formatBlockReason('setup_error', describeCommandFailure(staged, 'failed to enumerate staged files')),
            failureKind: 'setup_error',
        };
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
        if (allowReason)
            consumeTscOverride(command);
        return gateDecision;
    }
    if (allowReason) {
        emitTscGateOverrideUsed(allowReason, gateDecision.failureKind, command);
        return { decision: 'approve' };
    }
    emitTscGateFailed(gateDecision.reason, gateDecision.failureKind, command);
    return gateDecision;
}
function emitCrashEvent(error, command) {
    try {
        logActivity({
            event: 'tsc_gate_crashed',
            source: 'hook',
            gate_payload: {
                error: safeErrorMessage(error),
                command,
                failure_kind: 'crashed',
            },
        });
    }
    catch {
        /* activity logging is best effort */
    }
}
function main() {
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
    }
    catch (error) {
        const inputData = readHookInputData();
        const input = inputData ? parseHookInput(inputData) : null;
        emitCrashEvent(error, input?.tool_input?.command ?? '');
        approve();
    }
}
