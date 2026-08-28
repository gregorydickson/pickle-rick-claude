#!/usr/bin/env node
/**
 * pipeline-runner — Sequential phase orchestrator.
 *
 * Phases (in order):
 *   1. pickle       → mux-runner.js        (build/implement)
 *   2. citadel      → in-process audit     (pipeline risk gate)
 *   3. anatomy-park → microverse-runner.js  (deep subsystem review)
 *   4. szechuan-sauce → microverse-runner.js (principle-driven deslopping)
 *
 * Each phase runs as a child process. Between phases the runner resets
 * state.json, creates required config files, and spawns the next runner.
 *
 * Usage: node pipeline-runner.js <session-dir>
 * Expects: pipeline.json in session-dir with phase configuration.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { BACKENDS, MICROVERSE_EXIT_REASONS, MICROVERSE_FATAL_REASONS, CRASH_FLOOR_EXIT_REASONS, PipelineRunnerExitCode, UNBOUNDED_READ_MAX_BUFFER, isMicroverseFailureExit } from '../types/index.js';
import { StateManager, safeDeactivate, finalizeTerminalState, finalizeIfTrulyComplete, graduationDecision, recordExitReason, clearExitReason, schemaVersionDeployDriftMessage } from '../services/state-manager.js';
import { backendEnvOverrides, isBackend, resolveBackend, buildWorkerInvocation } from '../services/backend-spawn.js';
import { getExtensionRoot, Style, formatTime, printMinimalPanel, safeErrorMessage, ensureMonitorWindow, displayMacNotification, writeStateFile, isoCompactStamp, collectTickets, respawnMonitorWindowForMode, classifyDiffVisualDominance, VISUAL_DOMINANCE_THRESHOLD, loadPickleSettingsBag, resolveScopeSettings, } from '../services/pickle-utils.js';
import { createResolverCache, detectSignatureCallerGaps, SCOPE_AUTO_EXTEND_MAX } from '../services/signature-caller-gap.js';
// B-NONSTOP WS-2 (AC-NS-6): reuse the T3 disposition map to classify a non-pickle
// phase's `state.exit_reason` (no re-mapping — single source of truth in microverse-runner).
import { classifyMicroverseDisposition } from './microverse-runner.js';
// WS-B (f8559470): consume WS-A's single test-dimension reader to detect a ticket
// flipped Done over a red worker_gate_tests_verdict, so the residual can raise
// counters.nonConvergent (see collectDoneTicketsWithRedTestVerdict below).
import { readTicketWorkerGateTestsVerdict } from './setup.js';
// The per-ANALYST -> per-TICKET collapse has ONE home (spawn-refinement-team.ts). Every
// cardinality question over `refinement_manifest.json:tickets` routes through it; see
// `runBundlePreflight`.
import { collapseAnalystTicketCopies } from './spawn-refinement-team.js';
// Re-export the single cap literal so existing importers (tests, Module Export Catalog)
// keep resolving it from pipeline-runner without a second definition.
export { SCOPE_AUTO_EXTEND_MAX } from '../services/signature-caller-gap.js';
import { isGitIgnoredPath, listWorkingTreeDirtyPaths, getDiffFiles, archiveBeforeDestructive, updateTicketStatus, ARCHIVE_UNTRACKED_BYTE_CAP, } from '../services/git-utils.js';
import { logActivity } from '../services/activity-logger.js';
import { killProcessGroup } from '../services/orphan-reaper.js';
import { emitBundleLinearComments } from '../services/linear-integration.js';
import { readRecoverableJsonObject } from '../services/microverse-state.js';
import { runAcPhaseGate } from '../services/ac-phase-gate.js';
import { resolveScope, refreshScope, filterBySubsystem, computeReviewBase, parseScope, ScopeError, } from '../services/scope-resolver.js';
import { readDeclaredFiles } from '../services/ticket-declared-files.js';
import { runCitadelAudit } from '../services/citadel/audit-runner.js';
import { isMechanicalCitadelFinding } from '../services/citadel/mechanical-finding-classifier.js';
import { citadelFindingsToGateResult } from '../services/citadel/citadel-findings-to-gate-result.js';
import { spawnGateRemediatorMain } from './spawn-gate-remediator.js';
import { isProcessAlive } from '../lib/process-liveness.js';
// B-PXBO WS-1: consume the SHARED oracle-recheck helper exported from mux-runner.ts
// (an already-permitted completion-evidence oracle caller). pipeline-runner MUST NOT
// import the oracle module directly — that becomes a 3rd caller and fails
// audit-trap-door-enforcement.sh R-AFCC-CALLER-ENUMERATION.
import { isTicketOracleCommitted, isPerTicketVerdictReason } from './mux-runner.js';
import { loadFinalizeGateSettings, resolveFinalizeSettingsRoot } from './finalize-gate.js';
import { runGate } from '../services/convergence-gate.js';
const sm = new StateManager();
const DEFAULT_DIRTY_EXEMPT_SEGMENTS = ['prds', 'docs'];
const CODEX_REQUIRED_BACKEND = 'codex-required';
const DIRTY_ALLOWED_FILE_REL = path.join('extension', '.pipeline-runner-dirty-allowed.json');
// R-PIAP-B2: within this many points of the threshold (0.60), err toward design-safe.
const NEAR_THRESHOLD_BAND = 0.05;
// ---------------------------------------------------------------------------
// Config Parsing
// ---------------------------------------------------------------------------
/** Parse and validate pipeline.json with safe defaults for all integer limit fields. */
function parsePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function parseHeartbeatInteger(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    if (!Number.isInteger(parsed))
        return fallback;
    return parsed > 0 ? parsed : 0;
}
export function parsePipelineConfig(raw) {
    const rawBackend = raw.backend;
    const backend = typeof rawBackend === 'string' && BACKENDS.includes(rawBackend)
        ? rawBackend
        : undefined;
    const rawExempt = raw.dirty_exempt_segments;
    const dirty_exempt_segments = Array.isArray(rawExempt) && rawExempt.every((p) => typeof p === 'string')
        ? rawExempt
        : [...DEFAULT_DIRTY_EXEMPT_SEGMENTS];
    return {
        phases: normalizePipelinePhases(raw.phases),
        target: raw.target || '',
        szechuan_domain: raw.szechuan_domain,
        szechuan_focus: raw.szechuan_focus,
        child_mux_runner_heartbeat_ms: parseHeartbeatInteger(raw.child_mux_runner_heartbeat_ms, 60_000),
        child_mux_runner_stall_seconds: parsePositiveInteger(raw.child_mux_runner_stall_seconds, 1800),
        anatomy_stall_limit: parsePositiveInteger(raw.anatomy_stall_limit, 3),
        szechuan_stall_limit: parsePositiveInteger(raw.szechuan_stall_limit, 5),
        anatomy_max_iterations: parsePositiveInteger(raw.anatomy_max_iterations, 100),
        szechuan_max_iterations: parsePositiveInteger(raw.szechuan_max_iterations, 50),
        citadel_strict: raw.citadel_strict === true || raw.strict === true,
        backend,
        dirty_exempt_segments,
    };
}
function normalizePipelinePhases(rawPhases) {
    if (!Array.isArray(rawPhases))
        return [];
    const phases = [...rawPhases];
    if (phases.includes('citadel'))
        return phases;
    const pickleIndex = phases.indexOf('pickle');
    const anatomyIndex = phases.indexOf('anatomy-park');
    if (pickleIndex !== -1 && anatomyIndex !== -1 && pickleIndex < anatomyIndex) {
        phases.splice(pickleIndex + 1, 0, 'citadel');
    }
    return phases;
}
/**
 * Resolve the effective backend and the source of that value.
 *
 * Precedence (resume must honor user's new --backend):
 *   state.backend (setup.js --backend, authoritative on resume)
 *     → pipeline.json.backend (original launch flag)
 *       → PICKLE_BACKEND env
 *         → 'claude'
 *
 * setup.js writes state.backend whenever --backend is passed, including on
 * resume. pipeline.json is frozen at first launch, so letting it win would
 * pin the old backend forever even after the user explicitly switched.
 */
export function resolveBackendWithSource(state, pipelineBackend, envBackend) {
    const stateBackend = state ? state.backend : undefined;
    if (isBackend(stateBackend))
        return { backend: stateBackend, source: 'state.json' };
    if (pipelineBackend)
        return { backend: pipelineBackend, source: 'pipeline.json' };
    if (isBackend(envBackend))
        return { backend: envBackend, source: 'env' };
    return { backend: 'claude', source: 'default' };
}
function readYamlLikeField(body, field) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = body.match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, 'm'));
    return match ? match[1].trim().replace(/^["']|["']$/g, '') : undefined;
}
function extractLeadingYamlFrontmatter(content) {
    const openLen = content.startsWith('---\r\n') ? 5 : content.startsWith('---\n') ? 4 : 0;
    if (openLen === 0)
        return undefined;
    const closeIdx = content.indexOf('\n---', openLen);
    return closeIdx === -1 ? undefined : content.slice(openLen, closeIdx);
}
function extractBundleFrontmatterBlock(content) {
    const marker = content.match(/^frontmatter:\s*[\r\n]+```[^\r\n]*[\r\n]/m);
    if (!marker || marker.index == null)
        return undefined;
    const bodyStart = marker.index + marker[0].length;
    const closeIdx = content.indexOf('\n```', bodyStart);
    return closeIdx === -1 ? undefined : content.slice(bodyStart, closeIdx);
}
export function readBundlePrdBackend(content) {
    const bundleBlock = extractBundleFrontmatterBlock(content);
    const bundleBackend = bundleBlock ? readYamlLikeField(bundleBlock, 'backend') : undefined;
    if (bundleBackend)
        return bundleBackend;
    const yamlBlock = extractLeadingYamlFrontmatter(content);
    return yamlBlock ? readYamlLikeField(yamlBlock, 'backend') : undefined;
}
export function assertCodexRequiredBackend(sessionDir, backend, source) {
    const prdPath = path.join(sessionDir, 'prd.md');
    if (!fs.existsSync(prdPath))
        return;
    const requiredBackend = readBundlePrdBackend(fs.readFileSync(prdPath, 'utf-8'));
    if (requiredBackend !== CODEX_REQUIRED_BACKEND || backend === 'codex')
        return;
    throw new Error(`Bundle PRD declares backend: ${CODEX_REQUIRED_BACKEND}, but pipeline-runner resolved backend ` +
        `${backend} from ${source}. Restart with /pickle-pipeline --backend codex.`);
}
// ---------------------------------------------------------------------------
// Subsystem Discovery (mirrors anatomy-park.md Step 3)
// ---------------------------------------------------------------------------
const SOURCE_EXTS = new Set(['.ts', '.js', '.py', '.go', '.rs', '.java', '.tsx', '.jsx']);
const EXCLUDED_DIRS = new Set([
    'node_modules', 'dist', 'build', '.next', 'coverage',
    '__pycache__', '.git', '.turbo', '.vercel',
]);
const TEST_PATTERNS = ['.test.', '.spec.', '__test__', '__spec__'];
export function isTestFile(name) {
    const lower = name.toLowerCase();
    return TEST_PATTERNS.some(p => lower.includes(p));
}
export function discoverSubsystems(target) {
    let entries;
    try {
        entries = fs.readdirSync(target, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const subsystems = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.'))
            continue;
        const fullPath = path.join(target, entry.name);
        let sourceCount = 0;
        let testCount = 0;
        const visited = new Set();
        const walk = (p) => {
            // Resolve real path to detect symlink loops
            let realP;
            try {
                realP = fs.realpathSync(p);
            }
            catch {
                return;
            }
            if (visited.has(realP))
                return;
            visited.add(realP);
            let children;
            try {
                children = fs.readdirSync(p, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const child of children) {
                if (child.isDirectory() && !EXCLUDED_DIRS.has(child.name)) {
                    walk(path.join(p, child.name));
                }
                else if (child.isFile() && SOURCE_EXTS.has(path.extname(child.name))) {
                    sourceCount++;
                    if (isTestFile(child.name))
                        testCount++;
                }
            }
        };
        walk(fullPath);
        // Exclude test-only directories (>80% test files) per anatomy-park spec
        if (sourceCount >= 3 && testCount / sourceCount <= 0.8) {
            subsystems.push({ name: entry.name, fileCount: sourceCount });
        }
    }
    return subsystems.sort((a, b) => a.name.localeCompare(b.name));
}
// ---------------------------------------------------------------------------
// Pre-flight: Clean Working Tree
// ---------------------------------------------------------------------------
/**
 * Pipelines run long and span multiple phases. Starting with a dirty tree
 * masks which phase introduced which change — downstream microverse phases
 * would otherwise auto-commit the user's pre-existing work under a generic
 * message. Fail fast so the user makes that call deliberately.
 *
 * W1d: a SINGLE scope-aware resolver (`allowedDirtyPathsForLaunch`) owns every
 * dirty-tree exemption. A dirty path is exempt when ANY of these hold:
 *   1. one of its path segments matches `exemptSegments` at any depth
 *      (default ['prds','docs'] — frequent doc churn shouldn't block resume),
 *   2. it is listed in `.pipeline-runner-dirty-allowed.json`,
 *   3. it matches `.gitignore`,
 *   4. `allowedPaths` (the run scope) is non-empty AND the path is NOT under
 *      any allowed path — an out-of-scope autofix (`lint --fix` churn) must
 *      not abort a scoped launch.
 */
function loadAllowedDirtyPaths(workingDir) {
    const filePath = path.join(workingDir, DIRTY_ALLOWED_FILE_REL);
    if (!fs.existsSync(filePath))
        return new Set();
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const rawPaths = Array.isArray(parsed)
            ? parsed
            : (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.paths)
                ? parsed.paths
                : []);
        return new Set(rawPaths
            .filter((value) => typeof value === 'string')
            .map((value) => value.replace(/^\.?\/+/, '').replace(/\/+$/, ''))
            .filter((value) => value.length > 0));
    }
    catch (error) {
        throw new Error(`Invalid dirty allowlist at ${filePath}: ${safeErrorMessage(error)}`);
    }
}
// Match the path SEGMENT (e.g. 'docs', 'prds') at ANY depth, not just as a root prefix.
// git pathspec :!docs/** only excludes root-level docs/; this catches packages/api/docs/prd/foo.md.
function isDirtyPathExemptBySegment(filePath, exemptSegments) {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return exemptSegments.some((seg) => parts.includes(seg));
}
// W1d scope restriction: a dirty path is in-scope when it equals an allowed path or sits under one
// (segment-boundary prefix). Reuses the local path machinery — no convergence-gate scope import.
function isDirtyPathInScope(filePath, allowedPaths) {
    const norm = filePath.replace(/\\/g, '/');
    return allowedPaths.some((allowed) => {
        const a = allowed.replace(/\\/g, '/').replace(/\/+$/, '');
        return norm === a || norm.startsWith(`${a}/`);
    });
}
function allowedDirtyPathsForLaunch(workingDir, opts) {
    const exemptSegments = opts?.exemptSegments ?? [...DEFAULT_DIRTY_EXEMPT_SEGMENTS];
    const allowedPaths = opts?.allowedPaths;
    const scopeActive = Array.isArray(allowedPaths) && allowedPaths.length > 0;
    const allowlist = loadAllowedDirtyPaths(workingDir);
    const dirtyPaths = listWorkingTreeDirtyPaths(workingDir, exemptSegments);
    return dirtyPaths.filter((filePath) => !isDirtyPathExemptBySegment(filePath, exemptSegments) &&
        !allowlist.has(filePath) &&
        !isGitIgnoredPath(workingDir, filePath) &&
        (!scopeActive || isDirtyPathInScope(filePath, allowedPaths)));
}
export function assertCleanWorkingTree(workingDir, opts) {
    const exemptSegments = opts?.exemptSegments ?? [...DEFAULT_DIRTY_EXEMPT_SEGMENTS];
    const blockingPaths = allowedDirtyPathsForLaunch(workingDir, opts);
    if (blockingPaths.length === 0)
        return;
    const suffix = exemptSegments.length > 0 ? ` (exempt segments: ${exemptSegments.join(', ')})` : '';
    throw new Error(`Working tree at ${workingDir} is dirty${suffix}. Dirty files:\n${blockingPaths.join('\n')}\nCommit, stash, or discard changes before starting the pipeline.\n` +
        `If a moved branch or advanced HEAD left a stale pin, run \`setup --repin\` to re-pin from HEAD, or \`pickle-recover\` to salvage in-flight work.`);
}
/**
 * At a manager-boundary relaunch (state.manager_relaunch_count > 0), the
 * in-flight ticket's interrupted worker may have left uncommitted partial
 * changes. This resets ONLY the blocking dirty paths (those assertCleanWorkingTree
 * would reject) — exempted paths (prds/, docs/, allowlist, out-of-scope) are never touched.
 *
 * Since the pipeline requires a clean tree at first launch, all blocking dirty
 * files at a relaunch boundary MUST be from the interrupted worker, so resetting
 * them is safe and path-scoped to the in-flight ticket's work.
 */
export function resetInterruptedTicketWorkForRelaunch(workingDir, scope, log) {
    const blockingPaths = allowedDirtyPathsForLaunch(workingDir, scope);
    if (blockingPaths.length === 0)
        return;
    log(`[relaunch-reset] Resetting ${blockingPaths.length} dirty blocking file(s) from interrupted in-flight ticket`);
    // Unstage any staged changes so the post-reset status parse is accurate.
    spawnSync('git', ['reset', 'HEAD', '--', ...blockingPaths], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Re-enumerate post-reset status to split tracked vs untracked.
    const statusResult = spawnSync('git', ['status', '--porcelain', '-z', '--', ...blockingPaths], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const trackedPaths = [];
    const untrackedPaths = [];
    const tokens = (statusResult.stdout || '').split('\0').filter((t) => t.length > 0);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.length < 4)
            continue;
        const xy = token.slice(0, 2);
        const filePath = token.slice(3);
        if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C')
            i++;
        if (xy === '??') {
            untrackedPaths.push(filePath);
        }
        else {
            trackedPaths.push(filePath);
        }
    }
    if (trackedPaths.length > 0) {
        spawnSync('git', ['checkout', '--', ...trackedPaths], {
            cwd: workingDir,
            encoding: 'utf-8',
            timeout: 30_000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    for (const relPath of untrackedPaths) {
        try {
            fs.unlinkSync(path.join(workingDir, relPath));
        }
        catch { /* best effort */ }
    }
    log(`[relaunch-reset] Done: ${trackedPaths.length} tracked restored, ${untrackedPaths.length} untracked removed`);
}
// ---------------------------------------------------------------------------
// R-RRH C8: Dirty-tree relaunch self-heals the crashed ticket's files
// (truncation-safe).
// ---------------------------------------------------------------------------
/**
 * Parse the repo-relative paths a ticket declares it will touch from its
 * `**Files to modify/create**:` line (backtick-quoted tokens). Returns `[]`
 * when the ticket file or the line is absent — best-effort, never throws.
 */
function readDeclaredFilesForTicket(sessionDir, ticketId) {
    try {
        const ticketPath = path.join(sessionDir, ticketId, `rick_ticket_${ticketId}.md`);
        const content = fs.readFileSync(ticketPath, 'utf-8');
        return readDeclaredFiles(content);
    }
    catch {
        return [];
    }
}
function runGitString(args, cwd) {
    try {
        const out = execFileSync('git', ['-C', cwd, ...args], {
            encoding: 'utf-8',
            timeout: GIT_REPO_ROOT_TIMEOUT_MS,
        }).trim();
        return out || null;
    }
    catch {
        return null;
    }
}
function resolveSetupScopeBaseRef(repoRoot, scopeBase) {
    if (scopeBase && scopeBase.length > 0) {
        return scopeBase;
    }
    const currentBranch = runGitString(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    const upstream = runGitString(['rev-parse', '--abbrev-ref', '@{upstream}'], repoRoot);
    if (upstream && (!currentBranch || upstream !== `origin/${currentBranch}`)) {
        return upstream;
    }
    return runGitString(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot) ?? 'origin/main';
}
function normalizeRepoPathForScope(p) {
    return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}
function realpathOrResolveScopePath(p) {
    try {
        return fs.realpathSync(path.resolve(p));
    }
    catch {
        return path.resolve(p);
    }
}
function filterSeedPathsToTarget(paths, target, repoRoot) {
    if (!target) {
        return paths;
    }
    const relTarget = normalizeRepoPathForScope(path.relative(realpathOrResolveScopePath(repoRoot), realpathOrResolveScopePath(target)));
    if (relTarget.length === 0) {
        return paths;
    }
    const prefix = relTarget.endsWith('/') ? relTarget : `${relTarget}/`;
    return paths.filter((candidate) => candidate === relTarget || candidate.startsWith(prefix));
}
function sortScopePaths(paths) {
    return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
function resolveSeedPathsForSetup(sessionDir, statePath, target, repoRoot) {
    let currentTicket;
    try {
        const state = sm.read(statePath);
        currentTicket = typeof state.current_ticket === 'string' && state.current_ticket.length > 0
            ? state.current_ticket
            : null;
    }
    catch {
        currentTicket = null;
    }
    const declared = currentTicket
        ? readDeclaredFilesForTicket(sessionDir, currentTicket)
        : Array.from(buildDeclaredFilesByTicket(sessionDir).values()).flat();
    const normalized = Array.from(new Set(declared.map(normalizeRepoPathForScope).filter(Boolean)));
    return sortScopePaths(filterSeedPathsToTarget(normalized, target, repoRoot));
}
function persistSeededBranchScope(args) {
    const { sessionDir, workingDir, target, scopeBase, scopeFlag } = args;
    const parsed = parseScope(scopeFlag);
    if (parsed.mode !== 'branch') {
        return null;
    }
    const repoRoot = gitRepoRoot(workingDir);
    const allowedPaths = resolveSeedPathsForSetup(sessionDir, path.join(sessionDir, 'state.json'), target, repoRoot);
    if (allowedPaths.length === 0) {
        return null;
    }
    const headSha = runGitString(['rev-parse', 'HEAD'], repoRoot);
    const baseRef = resolveSetupScopeBaseRef(repoRoot, scopeBase);
    const baseSha = runGitString(['merge-base', baseRef, 'HEAD'], repoRoot) ?? computeReviewBase(repoRoot);
    if (!headSha || !baseSha) {
        return null;
    }
    const scope = {
        version: 1,
        mode: 'branch',
        strategy: parsed.strategy,
        base_ref: baseRef,
        base_sha: baseSha,
        head_sha: headSha,
        allowed_paths: allowedPaths,
        resolved_at: new Date().toISOString(),
        refresh_history: [],
    };
    fs.writeFileSync(path.join(sessionDir, 'scope.json'), JSON.stringify(scope, null, 2));
    return scope;
}
/**
 * Resolve the git repo root for `cwd`; falls back to `cwd` for a non-git dir.
 * `git status --porcelain` paths are repo-root-relative, so containment checks
 * MUST resolve dirty paths against the repo root, not the (possibly-subdir) cwd.
 */
function gitRepoRoot(cwd) {
    try {
        const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
            encoding: 'utf-8',
            timeout: GIT_REPO_ROOT_TIMEOUT_MS,
        }).trim();
        return out || cwd;
    }
    catch {
        return cwd;
    }
}
/**
 * True when `dirtyPath` (a `git status --porcelain` repo-root-relative path)
 * resolves inside `workingDir`. A path that resolves outside `workingDir`
 * (e.g. workingDir is a subdir of the repo and the dirt is above it) is OUTSIDE
 * the working dir — Branch 4 (no scope creep).
 */
function isDirtyPathUnderWorkingDir(repoRoot, workingDir, dirtyPath) {
    // Resolve symlinks on BOTH anchors before comparing. `gitRepoRoot` returns git's
    // `--show-toplevel`, which is already realpath-resolved (e.g. macOS /var → /private/var),
    // while `workingDir` (from state.json) is not. Comparing the two raw would mis-classify
    // in-working_dir dirt as "outside" whenever the repo lives under a symlinked path
    // (/var, /tmp), tripping a spurious Branch-4 FATAL and defeating the dirty-tree self-heal.
    const realpathOrResolve = (p) => {
        try {
            return fs.realpathSync(path.resolve(p));
        }
        catch {
            return path.resolve(p);
        }
    };
    const resolvedWorking = realpathOrResolve(workingDir);
    const resolved = path.resolve(realpathOrResolve(repoRoot), dirtyPath);
    return resolved === resolvedWorking || resolved.startsWith(resolvedWorking + path.sep);
}
function emitQuarantineEvent(event, payload) {
    try {
        logActivity({ event, source: 'pickle', ts: new Date().toISOString(), ...payload });
    }
    catch { /* best-effort telemetry; never block the launch decision */ }
}
/** Default destructive cleaner: path-scoped reset + checkout + untracked unlink (runner-only). */
function cleanScopedDirtyPaths(workingDir, scopedPaths) {
    if (scopedPaths.length === 0)
        return;
    spawnSync('git', ['reset', 'HEAD', '--', ...scopedPaths], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const statusResult = spawnSync('git', ['status', '--porcelain', '-z', '--', ...scopedPaths], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tracked = [];
    const untracked = [];
    const tokens = (statusResult.stdout || '').split('\0').filter((t) => t.length > 0);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.length < 4)
            continue;
        const xy = token.slice(0, 2);
        const filePath = token.slice(3);
        if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C')
            i++;
        if (xy === '??')
            untracked.push(filePath);
        else
            tracked.push(filePath);
    }
    if (tracked.length > 0) {
        spawnSync('git', ['checkout', '--', ...tracked], {
            cwd: workingDir,
            encoding: 'utf-8',
            timeout: 30_000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    for (const relPath of untracked) {
        try {
            fs.unlinkSync(path.join(workingDir, relPath));
        }
        catch { /* best effort */ }
    }
}
/**
 * Pure branch decision for the dirty-tree preflight self-heal — no side effects,
 * so it is unit-testable. Builds the scope set from `currentTicket`'s declared
 * files (Branch 1) or the UNION of all passed declared files (Branch 2, when
 * `currentTicket === null`). An empty union is NOT an error — it yields branch
 * `clean` / `unowned_quarantine`, never a FATAL.
 */
export function classifyDirtyTreeBranch(repoRoot, workingDir, blocking, currentTicket, declaredFilesByTicket) {
    if (blocking.length === 0)
        return { branch: 'clean', outside: [], inScope: [], unowned: [] };
    const outside = blocking.filter((p) => !isDirtyPathUnderWorkingDir(repoRoot, workingDir, p));
    if (outside.length > 0)
        return { branch: 'outside_working_dir', outside, inScope: [], unowned: [] };
    const allDeclared = new Set();
    for (const files of declaredFilesByTicket.values()) {
        for (const f of files)
            allDeclared.add(f);
    }
    const scopeSet = currentTicket != null
        ? new Set(declaredFilesByTicket.get(currentTicket) ?? [])
        : allDeclared;
    const inScope = blocking.filter((p) => scopeSet.has(p));
    const unowned = blocking.filter((p) => !allDeclared.has(p));
    if (inScope.length === 0 && unowned.length > 0) {
        return { branch: 'unowned_quarantine', outside: [], inScope, unowned };
    }
    return { branch: 'in_scope', outside: [], inScope, unowned };
}
export function quarantineCrashedTicketFilesOrFatal(args) {
    const { workingDir, sessionDir, currentTicket, declaredFilesByTicket, exemptSegments, allowedPaths, log } = args;
    const archive = args.archive ?? ((cwd, sd, ticketDir, byteCap) => archiveBeforeDestructive({ cwd, sessionDir: sd, ticketDir, reason: 'pre_reset' }, byteCap ?? ARCHIVE_UNTRACKED_BYTE_CAP));
    const applyClean = args.applyClean ?? cleanScopedDirtyPaths;
    const ticketDir = currentTicket ? path.join(sessionDir, currentTicket) : null;
    const repoRoot = gitRepoRoot(workingDir);
    const blocking = allowedDirtyPathsForLaunch(workingDir, { exemptSegments, allowedPaths });
    const decision = classifyDirtyTreeBranch(repoRoot, workingDir, blocking, currentTicket, declaredFilesByTicket);
    if (decision.branch === 'clean')
        return;
    // Branch 4: dirt outside workingDir → FATAL (no scope creep, no archive).
    if (decision.branch === 'outside_working_dir') {
        throw new Error(`Dirty tree contains paths OUTSIDE working_dir (${workingDir}); refusing to self-heal (no scope creep). ` +
            `Outside paths:\n${decision.outside.join('\n')}`);
    }
    // Branch 3: dirt owned by no ticket → quarantine-and-warn (no destruction).
    if (decision.branch === 'unowned_quarantine') {
        try {
            archive(workingDir, sessionDir, ticketDir, args.byteCap);
        }
        catch (err) {
            log(`[crashed-tree-quarantine] archive of unowned dirt failed (warn-only): ${safeErrorMessage(err)}`);
        }
        log(`[crashed-tree-quarantine] dirty paths declared by NO ticket — quarantine-and-warn (left for operator):\n` +
            decision.unowned.join('\n'));
        return;
    }
    // Branch 1/2 destructive path — archive first (FATAL on truncation), then clean.
    const { patchPath } = archiveOrFatalOnTruncation(args, ticketDir, archive);
    applyRecoverableQuarantine({
        workingDir, sessionDir, currentTicket, inScope: decision.inScope,
        patchPath, applyClean, log,
    });
}
/**
 * Branch 1/2 archive step: archive the crashed tree and, when the archive
 * truncated (dirty tree exceeds the byte cap → INCOMPLETE patch), emit
 * `crashed_ticket_files_quarantine_truncated` and FATAL — never clean/reset a
 * partial archive, which would silently destroy the un-archived delta.
 */
function archiveOrFatalOnTruncation(args, ticketDir, archive) {
    const { workingDir, sessionDir, currentTicket } = args;
    const result = archive(workingDir, sessionDir, ticketDir, args.byteCap);
    if (result?.filesTruncated === true) {
        emitQuarantineEvent('crashed_ticket_files_quarantine_truncated', {
            ticket: currentTicket ?? null,
            patch_path: result.patchPath,
            files: result.files,
            working_dir: workingDir,
        });
        throw new Error(`Crashed-ticket archive TRUNCATED (filesTruncated=true): the dirty tree exceeds the archive byte cap, ` +
            `so the patch is INCOMPLETE. Refusing to clean/reset — that would silently destroy the un-archived delta. ` +
            `Resolve the dirty tree manually. Partial archive: ${result.patchPath}`);
    }
    return { patchPath: result?.patchPath ?? null };
}
/** Recoverable Branch 1/2 side effects: clean in-scope dirt, reset ticket → Todo, emit + log. */
function applyRecoverableQuarantine(args) {
    const { workingDir, sessionDir, currentTicket, inScope, patchPath, applyClean, log } = args;
    applyClean(workingDir, inScope);
    if (currentTicket != null) {
        try {
            updateTicketStatus(currentTicket, 'Todo', sessionDir);
        }
        catch (err) {
            log(`[crashed-tree-quarantine] reset-to-Todo failed for ${currentTicket}: ${safeErrorMessage(err)}`);
        }
    }
    emitQuarantineEvent('crashed_ticket_files_quarantined', {
        ticket: currentTicket ?? null,
        patch_path: patchPath,
        files: inScope,
        working_dir: workingDir,
    });
    log(`[crashed-tree-quarantine] archived + reset ${inScope.length} in-scope file(s) from the crashed ticket` +
        `${currentTicket ? ` (${currentTicket} → Todo)` : ''}; preflight proceeds.`);
}
/**
 * Build the declared-files map for the In-Progress/Todo ticket set, keyed by
 * ticket id — the scope input for `quarantineCrashedTicketFilesOrFatal`.
 */
export function buildDeclaredFilesByTicket(sessionDir) {
    const map = new Map();
    for (const t of collectTickets(sessionDir)) {
        if (!t.id)
            continue;
        const status = (t.status ?? '').toLowerCase();
        if (status === 'in progress' || status === 'todo') {
            map.set(t.id, readDeclaredFilesForTicket(sessionDir, t.id));
        }
    }
    return map;
}
// ---------------------------------------------------------------------------
// R-PIAP-B2: Design-safe detection helpers
// ---------------------------------------------------------------------------
/**
 * Parse unified `git diff` output into a `DiffVisualStat` for
 * `classifyDiffVisualDominance`. Each file's added lines (those prefixed with
 * `+` but not `+++`) are collected under the file path from the `+++ b/…` header.
 */
export function parseDiffForVisualStat(diffOutput) {
    const stat = [];
    let currentPath = null;
    let currentLines = [];
    for (const line of diffOutput.split('\n')) {
        if (line.startsWith('+++ b/')) {
            if (currentPath !== null)
                stat.push({ path: currentPath, changedLines: currentLines });
            currentPath = line.slice('+++ b/'.length);
            currentLines = [];
        }
        else if (currentPath !== null && line.startsWith('+') && !line.startsWith('+++')) {
            currentLines.push(line.slice(1));
        }
    }
    if (currentPath !== null)
        stat.push({ path: currentPath, changedLines: currentLines });
    return stat;
}
const GIT_DIFF_DESIGN_SAFE_TIMEOUT_MS = 30_000;
/**
 * R-PIAP-B2: resolve whether the current branch is design-safe.
 *
 * Precedence:
 *   1. `override` (from `--design-safe` / `--no-design-safe` CLI flags) — wins unconditionally.
 *   2. Auto-detect: run `git diff <startCommit>..HEAD`, parse, classify.
 *      Near-threshold policy: effective threshold = `VISUAL_DOMINANCE_THRESHOLD - NEAR_THRESHOLD_BAND`
 *      so any visual ratio within the band of 0.60 errs toward design-safe.
 *   3. If diff cannot be obtained → false (logic-primary assumed).
 */
export function resolveDesignSafe(startCommit, repoRoot, override) {
    if (override !== undefined)
        return override;
    if (!startCommit || typeof startCommit !== 'string')
        return false;
    let diffOutput;
    try {
        diffOutput = execFileSync('git', ['diff', `${startCommit}..HEAD`], {
            cwd: repoRoot,
            encoding: 'utf-8',
            timeout: GIT_DIFF_DESIGN_SAFE_TIMEOUT_MS,
            // AP-EXT-ITER8-01: a bundle-wide patch is unbounded; a truncated one silently
            // under-counts the visual stat that decides `design_safe`.
            maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
        });
    }
    catch {
        return false;
    }
    const diffStat = parseDiffForVisualStat(diffOutput);
    // Lower the threshold by the near-band so ratios within [threshold-band, threshold]
    // also classify as UI-primary (err toward design-safe).
    return classifyDiffVisualDominance(diffStat, VISUAL_DOMINANCE_THRESHOLD - NEAR_THRESHOLD_BAND);
}
/**
 * R-PIAP-B2: After `init-microverse.js` creates `microverse.json`, read it back
 * and inject `design_safe: boolean` so cleanup-phase workers can read the flag.
 * Best-effort: a read/write failure is logged but does not block the phase.
 */
function injectDesignSafeIntoMicroverse(sessionDir, designSafe, log) {
    const microversePath = path.join(sessionDir, 'microverse.json');
    try {
        const existing = readRecoverableJsonObject(microversePath);
        if (!existing) {
            log('design_safe inject: microverse.json not found or empty');
            return;
        }
        existing.design_safe = designSafe ?? false;
        writeStateFile(microversePath, existing);
        log(`design_safe=${String(existing.design_safe)} written to microverse.json`);
    }
    catch (err) {
        log(`design_safe inject failed (non-fatal): ${safeErrorMessage(err)}`);
    }
}
// ---------------------------------------------------------------------------
// Bundle Pre-flight
// ---------------------------------------------------------------------------
export class BundlePreflightError extends Error {
    failedAssertion;
    constructor(failedAssertion, message) {
        super(message);
        this.failedAssertion = failedAssertion;
        this.name = 'BundlePreflightError';
    }
}
const R_CODE_RE = /R-[A-Z]+-\d+/;
function resolveComposePath(composePath, workingDir) {
    return path.isAbsolute(composePath) ? composePath : path.join(workingDir, composePath);
}
function emitPreflightFailed(sessionRoot, failedAssertion, reason) {
    try {
        logActivity({
            event: 'bundle_preflight_failed',
            source: 'pickle',
            session: path.basename(sessionRoot),
            gate_payload: { failed_assertion: failedAssertion, reason },
        });
    }
    catch { /* best-effort telemetry */ }
}
function assertComposesPathsResolve(composes, workingDir, sessionRoot) {
    for (const composePath of composes) {
        if (!fs.existsSync(resolveComposePath(composePath, workingDir))) {
            const reason = `composes path not found: ${composePath}`;
            emitPreflightFailed(sessionRoot, 'composes_paths_resolve', reason);
            throw new BundlePreflightError('composes_paths_resolve', reason);
        }
    }
}
function assertComposedPrdsHaveRCodes(composes, workingDir, sessionRoot) {
    for (const composePath of composes) {
        let content = '';
        try {
            content = fs.readFileSync(resolveComposePath(composePath, workingDir), 'utf-8');
        }
        catch { /* empty */ }
        if (!R_CODE_RE.test(content)) {
            const reason = `composed PRD has no R-<KEY>-<N> codes: ${composePath}`;
            emitPreflightFailed(sessionRoot, 'composed_prds_have_R_codes', reason);
            throw new BundlePreflightError('composed_prds_have_R_codes', reason);
        }
    }
}
/**
 * Validate the bundle's composes: chain and refinement manifest before any
 * downstream phase runs. Checks three preconditions in order; the first
 * failure emits bundle_preflight_failed and throws BundlePreflightError.
 *
 * Preconditions (in order):
 *   1. composes_paths_resolve  — all 3 composes: paths resolve to readable files
 *   2. composed_prds_have_R_codes — each composed PRD declares at least one R-<KEY>-<N>
 *   3. manifest_R_code_count_ge_26 — refinement_manifest.json holds >= 26 DISTINCT
 *      tickets (`collapseAnalystTicketCopies`, not the raw array length)
 */
export function runBundlePreflight(sessionRoot) {
    const pipelinePath = path.join(sessionRoot, 'pipeline.json');
    const statePath = path.join(sessionRoot, 'state.json');
    const manifestPath = path.join(sessionRoot, 'refinement_manifest.json');
    let workingDir = sessionRoot;
    try {
        const state = sm.read(statePath);
        if (typeof state.working_dir === 'string' && state.working_dir.length > 0) {
            workingDir = state.working_dir;
        }
    }
    catch { /* fall back to sessionRoot */ }
    let composes = [];
    try {
        const pipeline = readRecoverableJsonObject(pipelinePath);
        if (pipeline && Array.isArray(pipeline.composes)) {
            composes = pipeline.composes.filter((p) => typeof p === 'string');
        }
    }
    catch { /* composes stays empty */ }
    assertComposesPathsResolve(composes, workingDir, sessionRoot);
    assertComposedPrdsHaveRCodes(composes, workingDir, sessionRoot);
    // `refinement_manifest.json:tickets` is the per-ANALYST concatenation — one logical
    // ticket appears once per analyst that named it. Measured over the 9 live manifests on
    // the authoring box, 4 of the 7 non-empty ones carry duplicates, up to 2.00x (12 raw
    // entries / 6 distinct ids). A raw `.length` therefore overstates the decomposition by
    // up to `WORKER_ROLES.length`, and this threshold can only be WEAKENED by that: at 2.00x
    // a 13-ticket refinement reads as 26 and clears a gate that wanted 26 distinct tickets.
    // The count goes through the collapse's ONE home in `spawn-refinement-team.ts`.
    let ticketCount = 0;
    try {
        const manifest = readRecoverableJsonObject(manifestPath);
        if (manifest && Array.isArray(manifest.tickets)) {
            ticketCount = collapseAnalystTicketCopies(manifest.tickets).length;
        }
    }
    catch { /* ticketCount stays 0 */ }
    if (ticketCount < 26) {
        const reason = `refinement manifest has ${ticketCount} distinct tickets, expected >= 26`;
        emitPreflightFailed(sessionRoot, 'manifest_R_code_count_ge_26', reason);
        throw new BundlePreflightError('manifest_R_code_count_ge_26', reason);
    }
}
// ---------------------------------------------------------------------------
// Child Process Management
// ---------------------------------------------------------------------------
let activeChild = null;
// R-OMTD: true when activeChild was spawned `detached:true` (leads its own
// process group), so teardown must signal the whole group, not just the PID.
let activeChildLeadsGroup = false;
let spawnRunnerOverride = null;
let _closerReleaseActionsForTests = null;
let phaseRunnerContext = null;
function isMuxRunnerInvocation(args) {
    return path.basename(args[0] ?? '') === 'mux-runner.js';
}
/**
 * R-OMTD: Tear down a spawned child. When the child leads its own process group
 * (spawned `detached:true`, e.g. mux-runner), signal the WHOLE group via the
 * negative-PID form so the mux-runner's grandchild subtree is reaped too —
 * otherwise those grandchildren re-parent to PID 1 and outlive the pipeline.
 * `detached:true` alone is insufficient with inherited stdio; the group reap is
 * what severs the orphan. Falls back to a direct `child.kill()` for non-detached
 * children or if the group signal fails (e.g. group already gone).
 */
function reapChildSubtree(child, leadsGroup, signal = 'SIGTERM') {
    // R-CXHANG AC-CXHANG-3: the negative-PID group kill is the SHARED primitive
    // (services/orphan-reaper.ts killProcessGroup); false (group already dead or
    // unsignalable) falls through to the direct kill — behavior-preserving.
    if (leadsGroup && typeof child.pid === 'number' && killProcessGroup(child.pid, signal)) {
        return;
    }
    try {
        child.kill(signal);
    }
    catch {
        // best-effort termination
    }
}
/**
 * Resolve the freshest child-mux liveness mtime for the wedge timer.
 *
 * `state.json` mtime advances only at ticket boundaries, so a single long
 * substantial ticket freezes it past the stall threshold and the worker is
 * SIGTERM'd mid-ticket. The per-iteration `tmux_iteration_*.log` is written
 * continuously and is the truer liveness signal. Take the MAX mtime across
 * those logs; when none exist yet, fall back to `state.json` mtime.
 */
function resolveChildMuxLivenessMtime(sessionDir, statePath, statSyncFn) {
    let names;
    try {
        names = fs.readdirSync(sessionDir);
    }
    catch {
        names = [];
    }
    let maxLogMtimeMs = -Infinity;
    for (const name of names) {
        if (!name.startsWith('tmux_iteration_') || !name.endsWith('.log'))
            continue;
        try {
            const s = statSyncFn(path.join(sessionDir, name));
            if (s.mtimeMs > maxLogMtimeMs)
                maxLogMtimeMs = s.mtimeMs;
        }
        catch {
            // best-effort: a racing log rotation must not crash the heartbeat
        }
    }
    if (maxLogMtimeMs !== -Infinity) {
        return { mtimeMs: maxLogMtimeMs, mtimeIso: new Date(maxLogMtimeMs).toISOString() };
    }
    try {
        const s = statSyncFn(statePath);
        return { mtimeMs: s.mtimeMs, mtimeIso: s.mtime.toISOString() };
    }
    catch {
        return null;
    }
}
export function armChildMuxRunnerHeartbeat(opts, deps = {}) {
    if (opts.heartbeatMs <= 0) {
        return { stop: () => { } };
    }
    const statePath = path.join(opts.sessionDir, 'state.json');
    const statSyncFn = deps.statSync ?? fs.statSync;
    const setIntervalFn = deps.setInterval ?? global.setInterval;
    const clearIntervalFn = deps.clearInterval ?? global.clearInterval;
    const nowFn = deps.now ?? Date.now;
    const isAliveFn = deps.isProcessAlive ?? isProcessAlive;
    const emitActivity = deps.emitActivity ?? logActivity;
    const childPid = opts.child.pid ?? null;
    if (typeof childPid !== 'number' || childPid <= 0) {
        return { stop: () => { } };
    }
    let stopped = false;
    const stop = () => {
        if (stopped)
            return;
        stopped = true;
        clearIntervalFn(timer);
    };
    const tick = () => {
        if (stopped || opts.child.killed)
            return;
        const live = resolveChildMuxLivenessMtime(opts.sessionDir, statePath, statSyncFn);
        if (!live)
            return;
        const elapsedSeconds = Math.floor((nowFn() - live.mtimeMs) / 1000);
        if (elapsedSeconds <= opts.stallSeconds)
            return;
        if (!isAliveFn(childPid)) {
            stop();
            return;
        }
        try {
            emitActivity({
                event: 'child_mux_runner_wedge_detected',
                source: 'pickle',
                session: path.basename(opts.sessionDir),
                gate_payload: {
                    child_pid: childPid,
                    last_state_mtime_iso: live.mtimeIso,
                    elapsed_seconds: elapsedSeconds,
                },
            });
        }
        catch {
            // best-effort telemetry only
        }
        // R-OMTD: the heartbeat is armed only for mux-runner invocations, which are
        // spawned detached (own process group), so reap the whole subtree.
        reapChildSubtree(opts.child, true, 'SIGTERM');
        stop();
    };
    const timer = setIntervalFn(tick, opts.heartbeatMs);
    return { stop };
}
/**
 * One-shot teardown latch for a phase child. `exit` and `error` are both terminal and
 * either can arrive first, so the returned settler lets the FIRST arrival own the
 * teardown — stopping the heartbeat and clearing the active-child tracking that
 * R-OMTD's group reap reads — and makes every later arrival a no-op. Hand-copying this
 * into each handler is how the jar-runner's three settle copies drifted, one of them
 * silently ceasing to clear its timers (root CLAUDE.md § Complexity rule 2).
 */
function makePhaseChildSettler(heartbeat) {
    let settled = false;
    return (finish) => {
        if (settled)
            return;
        settled = true;
        heartbeat?.stop();
        activeChild = null;
        activeChildLeadsGroup = false;
        finish();
    };
}
/**
 * The mux-runner no-progress heartbeat for a phase child, or `null` when there is no
 * progress signal to watch: a non-mux-runner child has no iteration log, and
 * `phaseRunnerContext` is installed by `main` alone, so an out-of-phase spawn has
 * nowhere to read the stall thresholds from.
 */
function armPhaseChildMuxRunnerHeartbeat(child, args) {
    if (!phaseRunnerContext || !isMuxRunnerInvocation(args))
        return null;
    return armChildMuxRunnerHeartbeat({
        child,
        sessionDir: phaseRunnerContext.sessionDir,
        heartbeatMs: phaseRunnerContext.childMuxRunnerHeartbeatMs,
        stallSeconds: phaseRunnerContext.childMuxRunnerStallSeconds,
    });
}
function spawnRunner(cmd, args, env) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        // R-OMTD: spawn the mux-runner child in its OWN process group so a SIGTERM
        // to pipeline-runner can reap the whole subtree (mux-runner + its workers)
        // via the negative-PID group signal in handleShutdown / the heartbeat.
        const leadsGroup = isMuxRunnerInvocation(args);
        const child = spawn(cmd, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: env ?? process.env,
            detached: leadsGroup,
        });
        activeChild = child;
        activeChildLeadsGroup = leadsGroup;
        const heartbeat = armPhaseChildMuxRunnerHeartbeat(child, args);
        // `setEncoding` before the first read, NOT a per-chunk `toString()`: an OS pipe boundary
        // is a BYTE offset, so a multi-byte UTF-8 character straddles it and each half decodes to
        // U+FFFD — mojibake in the echoed phase output AND in the accumulated stdout/stderr this
        // returns. The runner's own log lines are full of non-ASCII (`—`, `◤`, `✓`), so this fires
        // on any phase that emits more than a pipe buffer's worth. StringDecoder holds a partial
        // sequence back until its continuation bytes arrive.
        child.stdout?.setEncoding('utf-8');
        child.stderr?.setEncoding('utf-8');
        child.stdout?.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            process.stdout.write(text);
        });
        child.stderr?.on('data', (chunk) => {
            const text = chunk.toString();
            stderr += text;
            process.stderr.write(text);
        });
        const settle = makePhaseChildSettler(heartbeat);
        child.on('exit', (code) => settle(() => resolve({ exitCode: code ?? 1, stdout, stderr })));
        child.on('error', (err) => settle(() => reject(err)));
    });
}
async function runSpawnRunner(cmd, args, env) {
    const result = await (spawnRunnerOverride ?? spawnRunner)(cmd, args, env);
    if (typeof result === 'number') {
        return { exitCode: result, stdout: '', stderr: '' };
    }
    return result;
}
export function __setSpawnRunnerForTests(fn) {
    spawnRunnerOverride = fn;
}
export function __setCloserReleaseActionsForTests(actions) {
    _closerReleaseActionsForTests = actions;
}
/**
 * AP-EXT-ITER90-01: the persisted record MINUS the two fields the writer always re-authors.
 * Reading is best-effort — an absent, unparseable or unreadable status yields an empty carry
 * so a write never fails for want of a predecessor.
 */
function readPriorStatusDetails(statusPath) {
    try {
        const prior = readRecoverableJsonObject(statusPath);
        if (!prior)
            return {};
        const { status: _priorStatus, updated_at: _priorUpdatedAt, ...carried } = prior;
        return carried;
    }
    catch {
        return {};
    }
}
/**
 * AP-EXT-ITER90-01: carry-forward is the WRITER's job, not each caller's.
 *
 * This function REPLACES pipeline-status.json wholesale (fresh payload + renameSync), so any
 * key a caller omitted used to be erased. Making that a per-callsite obligation produced an
 * enumerated set: two callsites re-read and rest-spread the record while four did not, and a
 * dropped key is indistinguishable from a key that never applied. Measured on the compiled
 * mirror, the four unguarded writes erased `citadel_advisory_findings` (writeRunningStatus),
 * and `phase_skips`/`phase_dispositions`/`citadel_advisory_findings` (the terminal finalize
 * write, the terminal `cancelled` signal write, and the SCOPE_EMPTY_POST_BUILD write).
 *
 * The rule is now uniform and has ONE home: an explicitly supplied value ALWAYS wins —
 * including `null` (the terminal writes clear `current_phase`) and `{}` (an empty counter map
 * clears the key) — and ONLY an omitted key falls through to the persisted record. `status`
 * and `updated_at` are never carried; this write authors both. Unknown keys cannot leak: the
 * payload is copied field by field, never spread, so the per-field type filtering that a
 * callsite rest-spread had to abandon is restored here.
 */
export function writePipelineStatus(sessionDir, status, details = {}) {
    const statusPath = path.join(sessionDir, 'pipeline-status.json');
    const prior = readPriorStatusDetails(statusPath);
    const carry = (key) => details[key] !== undefined ? details[key] : prior[key];
    const counter = (key) => {
        const value = carry(key);
        return typeof value === 'number' ? value : 0;
    };
    const payload = {
        status,
        current_phase: carry('current_phase') ?? null,
        completed_phases: counter('completed_phases'),
        skipped_phases: counter('skipped_phases'),
        total_phases: counter('total_phases'),
        updated_at: new Date().toISOString(),
    };
    // R-PSSS-3: carry per-phase skip dispositions only when non-empty so older
    // status consumers and clean runs see no spurious key.
    const phaseSkips = carry('phase_skips');
    if (phaseSkips && Object.keys(phaseSkips).length > 0) {
        payload.phase_skips = phaseSkips;
    }
    // B-NONSTOP WS-2 (AC-NS-6): carry per-phase non-convergent dispositions only when
    // non-empty so older status consumers and all-converged runs see no spurious key.
    const phaseDispositions = carry('phase_dispositions');
    if (phaseDispositions && Object.keys(phaseDispositions).length > 0) {
        payload.phase_dispositions = phaseDispositions;
    }
    // B-CSOR T50: additive advisory count — assigned only when a numeric value is available
    // so clean runs and older consumers see no spurious key.
    const advisoryFindings = carry('citadel_advisory_findings');
    if (typeof advisoryFindings === 'number') {
        payload.citadel_advisory_findings = advisoryFindings;
    }
    const tmpPath = `${statusPath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
    fs.renameSync(tmpPath, statusPath);
}
// ---------------------------------------------------------------------------
// State Transitions
// ---------------------------------------------------------------------------
export function resetStateForPhase(statePath, template, maxIterations) {
    clearExitReason(statePath, { resetStep: true });
    sm.update(statePath, (s) => {
        // Set inactive — the runner takes ownership and activates on start.
        s.active = false;
        s.iteration = 0;
        s.current_ticket = null;
        // R-CNAR-8: nulling current_ticket REQUIRES clearing the 5 cache fields.
        delete s.current_ticket_tier;
        delete s.current_ticket_budget;
        delete s.current_ticket_max_iterations;
        delete s.current_ticket_worker_timeout_seconds;
        delete s.current_ticket_budget_start_iteration;
        s.start_time_epoch = Math.floor(Date.now() / 1000);
        s.max_iterations = maxIterations;
        s.command_template = template;
        s.tmux_mode = true;
    });
}
export function claimPipelineRunnerActive(statePath) {
    return sm.update(statePath, (s) => {
        s.active = true;
        s.pid = process.pid;
        if (s.exit_reason === 'failed' || s.exit_reason === 'completed'
            || s.exit_reason === 'manager_handoff_pending' || s.exit_reason === 'closer_handoff_terminal') {
            s.exit_reason = null;
        }
    });
}
/**
 * AC-LPB-05: when pipeline-runner re-attaches to a session that already has
 * prior progress (iteration > 0 OR phases_entered non-empty), this is a
 * reconstruction — reset start_time_epoch so wall-clock cap-checks measure
 * from the resume time, not the original launch. Emits a telemetry event
 * (`session_reconstructed_epoch_reset`) for monitor/standup consumers. Fresh
 * launches (iteration === 0 and no phases entered) keep the setup-supplied
 * epoch and this helper is a no-op.
 *
 * Mutates the passed `state` in place AND writes through StateManager so
 * subsequent reads see the new epoch. Returns the {originalEpoch, newEpoch}
 * pair when a reset happened, otherwise null.
 */
export function applyEpochResetOnReconstruction(state, statePath, sessionDir) {
    const isReconstruction = (typeof state.iteration === 'number' && state.iteration > 0) ||
        (Array.isArray(state.phases_entered) && state.phases_entered.length > 0);
    if (!isReconstruction)
        return null;
    const originalEpoch = typeof state.start_time_epoch === 'number' ? state.start_time_epoch : null;
    const newEpoch = Math.floor(Date.now() / 1000);
    sm.update(statePath, (s) => { s.start_time_epoch = newEpoch; });
    state.start_time_epoch = newEpoch;
    try {
        logActivity({
            event: 'session_reconstructed_epoch_reset',
            source: 'pickle',
            session: path.basename(sessionDir),
            original_epoch: originalEpoch ?? undefined,
            new_epoch: newEpoch,
        });
    }
    catch { /* telemetry best-effort */ }
    return { originalEpoch, newEpoch };
}
function archiveFile(sessionDir, filename, phase) {
    const src = path.join(sessionDir, filename);
    if (!fs.existsSync(src))
        return;
    try {
        fs.copyFileSync(src, path.join(sessionDir, `${path.basename(filename, path.extname(filename))}-${phase}${path.extname(filename)}`));
    }
    catch { /* best effort */ }
}
/** Archive and remove inter-phase artifacts that could confuse the next phase. */
// TASK_NOTES.md lifecycle: intra-phase only by design. Pipeline-mode timeout stubs from one phase
// are archived (to TASK_NOTES-<phase>.md) and removed from canonical path before the next phase's
// setup. This prevents stale notes from contaminating downstream phases. See PRD FR-B16.
// Do NOT add cross-phase propagation without updating the PRD.
export function cleanPhaseArtifacts(sessionDir, phase) {
    // TASK_NOTES.md — stale notes from previous phase
    const notesPath = path.join(sessionDir, 'TASK_NOTES.md');
    if (fs.existsSync(notesPath)) {
        archiveFile(sessionDir, 'TASK_NOTES.md', phase);
        try {
            fs.unlinkSync(notesPath);
        }
        catch { /* best effort */ }
    }
    // gap_analysis.md — stale findings could cause szechuan-sauce to skip Phase 0
    const gapPath = path.join(sessionDir, 'gap_analysis.md');
    if (fs.existsSync(gapPath)) {
        archiveFile(sessionDir, 'gap_analysis.md', phase);
        try {
            fs.unlinkSync(gapPath);
        }
        catch { /* best effort */ }
    }
    // handoff.txt — stale handoff from previous runner
    const handoffPath = path.join(sessionDir, 'handoff.txt');
    if (fs.existsSync(handoffPath)) {
        try {
            fs.unlinkSync(handoffPath);
        }
        catch { /* best effort */ }
    }
}
export function readCitadelReport(sessionDir) {
    const reportPath = path.join(sessionDir, 'citadel_report.json');
    if (!fs.existsSync(reportPath))
        return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        if (!isCitadelReport(parsed))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function isCitadelReport(value) {
    if (!value || typeof value !== 'object')
        return false;
    const record = value;
    return Array.isArray(record.findings)
        && typeof record.summary === 'object'
        && record.summary !== null
        && (typeof record.exitCode === 'number' || typeof record.exit_code === 'number');
}
function findingText(finding) {
    const citation = typeof finding.file === 'string'
        ? `${finding.file}:${typeof finding.line === 'number' ? finding.line : 0}`
        : undefined;
    const message = typeof finding.message === 'string' ? finding.message : finding.id;
    return citation
        ? `- [${finding.severity}] ${finding.id} ${citation} - ${message}`
        : `- [${finding.severity}] ${finding.id} - ${message}`;
}
function isUnguardedTrapDoorFinding(finding) {
    const id = finding.id.toLowerCase();
    const message = typeof finding.message === 'string' ? finding.message.toLowerCase() : '';
    return id.includes('trap-door') || message.includes('unguarded trap door');
}
function isDivergenceFinding(finding) {
    const id = finding.id.toLowerCase();
    const source = typeof finding.source === 'string' ? finding.source.toLowerCase() : '';
    return id.includes('divergence') || source.includes('divergence');
}
function buildCitadelAnatomyContext(report) {
    if (!report)
        return [];
    const trapDoors = report.findings.filter(isUnguardedTrapDoorFinding);
    return [
        '',
        '## Citadel Report',
        `Read: ${path.basename('citadel_report.json')}`,
        trapDoors.length > 0
            ? 'Prioritize these unguarded trap-door findings during catalog review:'
            : 'No unguarded trap-door findings were reported by Citadel.',
        ...trapDoors.map(findingText),
    ];
}
function buildCitadelSzechuanContext(report) {
    if (!report)
        return [];
    const divergences = report.findings.filter(isDivergenceFinding);
    return [
        '',
        '## Citadel Report',
        `Read: ${path.basename('citadel_report.json')}`,
        divergences.length > 0
            ? 'Treat these divergence findings as known Citadel inputs; do not double-count intentional divergence:'
            : 'No divergence findings were reported by Citadel.',
        ...divergences.map(findingText),
    ];
}
/**
 * Pickle phase entry: pin command_template and scrub stale phase configs.
 *
 * Two failure modes this guards against on resume:
 *   1. command_template drift: a prior run advanced into anatomy-park or
 *      szechuan-sauce and persisted its template. Without re-pinning, mux-runner
 *      would spawn the pickle worker with the wrong prompt — worker runs the
 *      wrong phase, commits with the wrong prefix, emits EPIC_COMPLETED for the
 *      wrong reason. Always overwrite to '_pickle-manager-prompt.md' on entry.
 *   2. Stale phase config files (anatomy-park.json, szechuan-sauce.json) left
 *      in the session dir from a previous run. A worker that scans the session
 *      dir might infer wrong context even with the right template. Remove them.
 *
 * Intentionally does NOT touch current_ticket / iteration / start_time_epoch —
 * pickle is the only phase that resumes mid-flight, and those pointers must
 * survive an interrupted run. The outer phase transition helper stamps
 * state.step to the active pipeline phase after this entry prep.
 */
export function enterPicklePhase(sessionDir, statePath, backend) {
    // Fix A — pin command_template. Stale value from a previous anatomy-park or
    // szechuan-sauce run would otherwise misroute the pickle worker.
    sm.update(statePath, (s) => {
        s.command_template = '_pickle-manager-prompt.md';
        if (s.backend !== backend)
            s.backend = backend;
    });
    // Fix B — scrub stale foreign-phase residue left behind by a previous
    // pipeline run. cleanPhaseArtifacts archives TASK_NOTES.md / gap_analysis.md
    // and removes handoff.txt for the named phase; the explicit unlinkSync of
    // <phase>.json catches the microverse-runner convergence state files
    // (anatomy-park.json, szechuan-sauce.json) which cleanPhaseArtifacts does
    // not handle. Either residue can misroute a resumed pickle worker even
    // after command_template is pinned.
    cleanPhaseArtifacts(sessionDir, 'anatomy-park');
    cleanPhaseArtifacts(sessionDir, 'szechuan-sauce');
    for (const stalePhase of ['anatomy-park', 'szechuan-sauce']) {
        const stalePath = path.join(sessionDir, `${stalePhase}.json`);
        if (fs.existsSync(stalePath)) {
            try {
                fs.unlinkSync(stalePath);
            }
            catch { /* best effort */ }
        }
    }
}
// SCOPE_AUTO_EXTEND_MAX (the bounded build-phase auto-extension cap) is imported
// and re-exported from ../services/signature-caller-gap.js — single definition there.
/** Locale-independent byte-order comparator (clone of scope-resolver's private `byteOrder`). */
export function scopeByteOrder(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
/**
 * Read the raw `rick_ticket_<id>.md` bodies for every collected ticket.
 * Best-effort: unreadable / missing files are skipped.
 */
function readTicketContents(sessionDir) {
    const contents = [];
    for (const t of collectTickets(sessionDir)) {
        if (!t.id)
            continue;
        const file = path.join(sessionDir, t.id, `rick_ticket_${t.id}.md`);
        try {
            contents.push(fs.readFileSync(file, 'utf-8'));
        }
        catch {
            /* skip unreadable ticket file */
        }
    }
    return contents;
}
/**
 * Pure core of the WS-3 scope auto-extension (no settings gate, no persistence,
 * no event). Merges the detector-NAMED out-of-fence callers into
 * `allowedPaths` (deduped, byte-sorted) — caller paths the detector did not
 * name are NEVER added. Over the `SCOPE_AUTO_EXTEND_MAX` cap, NOTHING is
 * extended (`allowedPaths` returned unchanged, `capHit:true`). Exported so the
 * merge / over-cap contract is testable independent of the deployed setting.
 */
export function computeScopeAutoExtension(allowedPaths, ticketContents, declaredFiles, repoRoot) {
    const unchanged = {
        allowedPaths,
        addedPaths: [],
        symbols: [],
        capHit: false,
        changed: false,
    };
    if (ticketContents.length === 0)
        return unchanged;
    // Mirror check-readiness.ts DEFAULT_MAX_WALL_MS so the build-phase caller scan
    // reuses the WS-1 deadline instead of introducing a second budget shape.
    const cache = createResolverCache(repoRoot, 120_000);
    const gaps = detectSignatureCallerGaps({ ticketContents, declaredFiles, repoRoot, cache });
    if (gaps.length === 0)
        return unchanged;
    const symbols = Array.from(new Set(gaps.map((g) => g.symbol))).sort(scopeByteOrder);
    const namedCallers = new Set();
    for (const g of gaps)
        for (const c of g.outOfScopeCallers)
            namedCallers.add(c);
    const existing = new Set(allowedPaths);
    const newCallers = Array.from(namedCallers).filter((c) => !existing.has(c));
    if (newCallers.length === 0)
        return { ...unchanged, symbols };
    const merged = Array.from(new Set([...allowedPaths, ...newCallers])).sort(scopeByteOrder);
    if (merged.length > SCOPE_AUTO_EXTEND_MAX) {
        // Over-cap extends nothing — allowed_paths unchanged.
        return { allowedPaths, addedPaths: [], symbols, capHit: true, changed: false };
    }
    return {
        allowedPaths: merged,
        addedPaths: [...newCallers].sort(scopeByteOrder),
        symbols,
        capHit: false,
        changed: true,
    };
}
/**
 * Ticket 0b9b2319 (WS-3): bounded, opt-in build-phase scope auto-extension.
 *
 * When the `scope.auto_extend_signature_callers` setting is true AND `scope`
 * is paths-mode (diff/branch are null at setup → synthesize nothing), run the
 * shared `detectSignatureCallerGaps` detector against the current ticket set
 * and merge the detector-NAMED out-of-fence callers into `scope.allowed_paths`
 * BEFORE persistence (deduped, byte-sorted, capped). Mutates `scope` in place,
 * re-persists `scope.json`, and emits `scope_auto_extended`.
 *
 * Best-effort: the entire body is wrapped so a detector / read / write failure
 * never aborts setup.
 */
export function maybeAutoExtendScope(sessionDir, workingDir, scope, log) {
    try {
        if (!resolveScopeSettings(loadPickleSettingsBag()).autoExtendSignatureCallers)
            return;
        // Diff/branch-mode is null at setup → synthesize nothing, no merge.
        if (scope.mode !== 'paths')
            return;
        const ticketContents = readTicketContents(sessionDir);
        const declaredFiles = new Set();
        for (const files of buildDeclaredFilesByTicket(sessionDir).values()) {
            for (const f of files)
                declaredFiles.add(f);
        }
        const result = computeScopeAutoExtension(scope.allowed_paths, ticketContents, declaredFiles, workingDir);
        // No-op: nothing named, or named callers already in scope, and not a cap hit.
        if (!result.changed && !result.capHit)
            return;
        if (result.changed) {
            scope.allowed_paths = result.allowedPaths;
            try {
                const scopePath = path.join(sessionDir, 'scope.json');
                const tmp = `${scopePath}.tmp.${process.pid}`;
                fs.writeFileSync(tmp, JSON.stringify(scope, null, 2));
                fs.renameSync(tmp, scopePath);
            }
            catch (err) {
                log(`scope-auto-extend WARN: re-persist failed — ${safeErrorMessage(err)}`);
                return;
            }
            log(`scope-auto-extend: added ${result.addedPaths.length} detector-named caller(s) to allowed_paths`);
        }
        else {
            log(`scope-auto-extend: cap hit (> ${SCOPE_AUTO_EXTEND_MAX}) — extending nothing`);
        }
        logActivity({
            event: 'scope_auto_extended',
            source: 'pickle',
            ts: new Date().toISOString(),
            session: path.basename(sessionDir),
            gate_payload: { added_paths: result.addedPaths, symbols: result.symbols, cap_hit: result.capHit },
        });
    }
    catch (err) {
        log(`scope-auto-extend WARN: skipped — ${safeErrorMessage(err)}`);
    }
}
/**
 * Setup-time scope resolution. Writes `scope.json` and initializes
 * `state.phases_entered = []`. SCOPE_EMPTY_DIFF is demoted to a WARN (CUJ-6a):
 * a scope-configured session with no diff at setup should not kill the
 * pipeline — the build phase may still produce one. Returns the resolved
 * scope, or `null` when the scope is empty at setup (warning path).
 */
export function setupScope(args) {
    const { sessionDir, workingDir, target, scopeFlag, scopeBase, log } = args;
    const statePath = path.join(sessionDir, 'state.json');
    try {
        const scope = resolveScope({
            scopeFlag,
            scopeBase,
            target,
            sessionRoot: sessionDir,
            repoRoot: workingDir,
        });
        sm.update(statePath, (s) => { s.phases_entered = []; });
        // WS-3 (0b9b2319): bounded, opt-in auto-extension of paths-mode scope with
        // detector-named out-of-fence callers — runs once here at the build-phase
        // setup site, never in refreshScope. No-op unless the setting is on.
        maybeAutoExtendScope(sessionDir, workingDir, scope, log);
        log(`scope-setup: mode=${scope.mode} strategy=${scope.strategy} base=${scope.base_ref ?? '-'} allowed=${scope.allowed_paths.length}`);
        return scope;
    }
    catch (err) {
        if (err instanceof Error && err instanceof ScopeError && err.code === 'SCOPE_EMPTY_DIFF') {
            sm.update(statePath, (s) => { s.phases_entered = []; });
            const seeded = persistSeededBranchScope(args);
            if (seeded) {
                log(`scope-setup: seeded pickle-phase scope from ticket file-impact (${seeded.allowed_paths.length} paths)`);
                log(`scope-setup: mode=${seeded.mode} strategy=${seeded.strategy} base=${seeded.base_ref ?? '-'} allowed=${seeded.allowed_paths.length}`);
                return seeded;
            }
            log(`scope-setup WARN: SCOPE_EMPTY_DIFF — ${err.message} (continuing; build phase may produce diff)`);
            return null;
        }
        if (err instanceof Error && err instanceof ScopeError && err.code === 'SCOPE_BASE_AHEAD_OF_HEAD') {
            log(`scope-setup FATAL: SCOPE_BASE_AHEAD_OF_HEAD — ${err.message} (halting; stale/ahead base ` +
                `ref made the diff untrustworthy — fail-closed, not proceeding unscoped)`);
            recordExitReason(statePath, 'scope_base_ahead_of_head');
            throw err;
        }
        throw err;
    }
}
/**
 * Write `archive/skipped_by_scope.<phase>.json` — an observability record of
 * what scope filtered out for `phase`. Pure audit file; worker-side filters
 * (A6/A7) are out of scope for this ticket.
 */
export function writeSkippedByScope(sessionDir, scopePhase, scope, target, workingDir) {
    const archiveDir = path.join(sessionDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const outPath = path.join(archiveDir, `skipped_by_scope.${scopePhase}.json`);
    let payload;
    if (scopePhase === 'anatomy-park') {
        const discovered = discoverSubsystems(target).map((s) => s.name);
        const kept = filterBySubsystem(discovered, scope.allowed_paths, target, workingDir);
        const keptSet = new Set(kept);
        const skipped = discovered.filter((n) => !keptSet.has(n));
        payload = {
            phase: scopePhase,
            head_sha: scope.head_sha,
            allowed_paths: scope.allowed_paths,
            subsystems_discovered: discovered,
            subsystems_kept: kept,
            subsystems_skipped: skipped,
        };
    }
    else {
        payload = {
            phase: scopePhase,
            head_sha: scope.head_sha,
            allowed_paths: scope.allowed_paths,
        };
    }
    const tmp = `${outPath}.tmp.${process.pid}`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
        fs.renameSync(tmp, outPath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmp);
        }
        catch { /* ignore */ }
        throw err;
    }
}
/**
 * AP-EXT-ITER6-02: `scope.json` is written tmp-rename, so a crash between the write and the
 * rename leaves ONLY `scope.json.tmp.<pid>` — the recoverable state every OTHER scope reader
 * promotes (`scope-resolver.ts:refreshScope`, `check-gate.ts` / `init-microverse.ts`
 * `--allowed-paths-file`). The single recovery-aware existence predicate for this module: a
 * readable base OR a promotable dead tmp. Purely additive over the bare `fs.existsSync` it
 * replaces — it never withholds a scope the old check would have accepted.
 */
function hasRecoverableScopeJson(scopePath) {
    return fs.existsSync(scopePath) || readRecoverableJsonObject(scopePath) !== null;
}
/**
 * Read the fenced `allowed_paths` off the session's persisted `scope.json`. The read goes
 * STRAIGHT to `readRecoverableJsonObject` (which reads AND promotes a dead tmp): an
 * `fs.existsSync` pre-gate here would short-circuit before that recovery ever ran, and a
 * crash-resumed phase would read a recoverable fence as "unscoped" and review the whole repo.
 */
export function readPersistedAllowedPaths(sessionDir) {
    const scopePath = path.join(sessionDir, 'scope.json');
    try {
        const raw = readRecoverableJsonObject(scopePath);
        if (!raw)
            return undefined;
        const field = raw.allowed_paths;
        if (!Array.isArray(field) || field.length === 0 || !field.every((value) => typeof value === 'string')) {
            return undefined;
        }
        return field;
    }
    catch {
        return undefined;
    }
}
function readWorkingDirFromState(sessionDir, fallback) {
    const statePath = path.join(sessionDir, 'state.json');
    if (!fs.existsSync(statePath))
        return fallback;
    try {
        const workingDir = sm.read(statePath).working_dir;
        return typeof workingDir === 'string' && workingDir.length > 0 ? workingDir : fallback;
    }
    catch {
        return fallback;
    }
}
// ---------------------------------------------------------------------------
// Phase Setup: Anatomy Park
// ---------------------------------------------------------------------------
function buildAnatomyPrd(target, subsystems, stallLimit, runnerStallLimit, citadelReport) {
    return [
        '# Anatomy Park: Deep Subsystem Review',
        '',
        '## Objective',
        `Systematically review and fix all subsystems in ${target} through phased review-fix-verify cycles. Catalog structural weaknesses as trap doors in subsystem CLAUDE.md files.`,
        '',
        '## Target',
        target,
        '',
        '## Subsystems',
        ...subsystems.map((s, i) => `${i + 1}. ${s.name} (${s.fileCount} files)`),
        '',
        '## Key Metric',
        '- **Type**: none (worker-managed convergence)',
        `- **Stall Limit**: ${stallLimit} per subsystem | ${runnerStallLimit} total (runner ceiling)`,
        '- **Target**: All subsystems pass clean for 2 consecutive passes',
        '',
        '## Process (each iteration)',
        '1. Select next subsystem from rotation',
        '2. Phase 1: Read-only review — trace data flows, rate all findings',
        '3. Phase 2: Fix the single highest-severity finding + write regression test',
        '4. Phase 3: Read-only self-review of the diff, revert if broken',
        '5. Catalog trap doors in subsystem CLAUDE.md',
        '6. Rotate to next subsystem',
        '',
        '## Rules',
        '- One subsystem per iteration, one fix per iteration',
        '- Three phases per iteration — never combine',
        '- Phase 1 and Phase 3 are READ-ONLY',
        '- Revert on regression, defer to next iteration',
        `- Skip subsystem after ${stallLimit} consecutive failed fixes`,
        ...buildCitadelAnatomyContext(citadelReport),
    ].join('\n');
}
// R-PSSS-1/2: file extensions that count as a reviewable code surface. A
// scope (branch diff) containing none of these is doc-only / test-fixture-only
// and makes anatomy-park / szechuan-sauce a no-op.
const CODE_EXTENSIONS = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'rb', 'php',
    'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'kt', 'swift', 'scala', 'sh',
]);
function isCodePath(p) {
    const dot = p.lastIndexOf('.');
    return dot >= 0 && CODE_EXTENSIONS.has(p.slice(dot + 1).toLowerCase());
}
/**
 * R-PSSS-2: a resolved-but-code-free scope (a doc-only / fixture-only branch
 * diff). An UNSCOPED run — empty `paths` — is the whole-repo case and is NOT
 * code-free for this purpose, so szechuan-sauce still runs.
 */
function isCodeFreeScope(paths) {
    return Array.isArray(paths) && paths.length > 0 && !paths.some(isCodePath);
}
/** WS-B: the session's own baseline commit, or null when it is unreadable. */
function readStartCommitFromState(sessionDir) {
    try {
        const startCommit = sm.read(path.join(sessionDir, 'state.json')).start_commit;
        return typeof startCommit === 'string' && startCommit.length > 0 ? startCommit : null;
    }
    catch {
        return null;
    }
}
/**
 * WS-B: is the branch diff empty — did this run author nothing to review?
 *
 * The base is the session's own `start_commit`, and ONLY that. It is the one
 * base that knows what THIS run produced: a branch ref cannot answer the
 * question, because a repo whose whole history sits on `main` has an empty
 * `main...HEAD` diff while the session may have authored commits on top of its
 * baseline — reading that as "nothing to review" skips a phase with a real
 * review surface. (`computeReviewBase` is unusable for the same reason from the
 * other side: its degenerate floor returns HEAD, so "no base ref resolves" is
 * indistinguishable from "HEAD is the base".)
 *
 * Returns `null` when the fact cannot be established — no readable
 * `start_commit`, an unresolvable one, or a git/dirty-scan failure. Callers
 * MUST fail toward RUNNING the phase on `null`: preserving today's behaviour
 * cannot introduce a silent skip.
 *
 * Uncommitted work is review surface too, so a dirty tree is not an empty diff.
 */
function isBranchDiffEmpty(repoRoot, startCommit) {
    if (!startCommit)
        return null;
    try {
        // `getDiffFiles` throws on an unreachable `start_commit`, which the catch
        // below turns into "undeterminable" — no separate reachability probe.
        if (getDiffFiles(startCommit, 'HEAD', repoRoot).length > 0)
            return false;
        return listWorkingTreeDirtyPaths(repoRoot).length === 0;
    }
    catch {
        return null;
    }
}
/**
 * WS-B: an UNSCOPED run (empty `effectiveAllowedPaths`) whose branch diff is
 * empty has no review surface at all — a narrower, earlier fact than the
 * code-free scope {@link shouldSkipSzechuanForEmptyScope} covers. Emits the same
 * operator WARN + phase empty-scope event (with a cause naming the empty diff)
 * and returns true so the caller skips with `empty_branch_diff`.
 *
 * Returns false for a resolved scope, for a non-empty branch diff, and whenever
 * emptiness cannot be determined.
 */
function shouldSkipPhaseForEmptyBranchDiff(args) {
    if (args.effectiveAllowedPaths && args.effectiveAllowedPaths.length > 0)
        return false;
    if (isBranchDiffEmpty(args.repoRoot, readStartCommitFromState(args.sessionDir)) !== true)
        return false;
    args.log(formatEmptyScopeWarn(args.phase, 'the branch diff is empty — no branch-authored change to review', [], [
        `  Hint: ${args.phase} reviews what this run authored, measured from the session`,
        `  baseline (state.start_commit). This run committed nothing and its tree is clean,`,
        `  so there is no review surface and the phase ends here. Widening --scope cannot`,
        `  help — the recourse is to run the phase against a run that authored a change.`,
    ]));
    logActivity({
        event: args.event,
        source: 'pickle',
        session: path.basename(args.sessionDir),
        gate_payload: { in_scope_paths: [], branch_diff_empty: true, ...args.extraPayload },
    });
    return true;
}
/**
 * R-PSSS-2: when szechuan-sauce's effective scope contains zero code files,
 * emit the operator WARN + `szechuan_sauce_empty_scope_skip` event and return
 * true so `setupSzechuanSauce` skips the phase. Returns false (no emission)
 * for an unscoped run or a scope with at least one code file.
 */
function shouldSkipSzechuanForEmptyScope(sessionDir, effectiveAllowedPaths, log) {
    const paths = isCodeFreeScope(effectiveAllowedPaths) ? effectiveAllowedPaths : null;
    if (!paths)
        return false;
    log(formatEmptyScopeWarn('szechuan-sauce', 'scope contains no code files', paths));
    logActivity({
        event: 'szechuan_sauce_empty_scope_skip',
        source: 'pickle',
        session: path.basename(sessionDir),
        gate_payload: { in_scope_paths: paths },
    });
    return true;
}
/**
 * R-PSSS-2 + WS-B: the two ways szechuan-sauce can have no review surface
 * BEFORE the `init-microverse.js` spawn — a resolved-but-code-free scope
 * (`empty_scope`), and an unscoped run whose branch diff is empty
 * (`empty_branch_diff`). Returns the reason to skip with, or null to run.
 */
function resolveSzechuanEmptySkipReason(sessionDir, target, effectiveAllowedPaths, log) {
    if (shouldSkipSzechuanForEmptyScope(sessionDir, effectiveAllowedPaths, log))
        return 'empty_scope';
    // An unscoped run is the whole-repo case ONLY when the branch actually
    // authored something. An empty branch diff leaves nothing to deslop, so the
    // phase ends here instead of spinning the microverse loop over a review
    // surface that does not exist.
    const emptyDiff = shouldSkipPhaseForEmptyBranchDiff({
        phase: 'szechuan-sauce',
        event: 'szechuan_sauce_empty_scope_skip',
        sessionDir,
        effectiveAllowedPaths,
        repoRoot: gitRepoRoot(target),
        log,
    });
    return emptyDiff ? 'empty_branch_diff' : null;
}
/**
 * R-PSSS-1/2: operator-visible WARN for an empty/code-free-scope phase skip.
 * The original silent `Phase X skipped (setup returned false)` log forced
 * operators to read raw logs to discover why a phase did nothing.
 *
 * Ticket 6625e3ed: `hint` overrode the explanation line but NOT the remediation line
 * beneath it, so the empty-branch-diff caller rendered "…an empty branch diff / diff has
 * no review surface. Widen with --scope paths:<glob>." — a duplicated word, and advice
 * that cannot apply (widening scope conjures no diff). A caller that owns the explanation
 * owns the remediation with it, so the override is now the whole `explain` tail.
 *
 * The path enumeration is likewise dropped when there are no paths: it belongs to a cause
 * that IS a filtered path set, and `(0 path(s)): (none)` is noise on a cause that is not.
 * Both `empty_scope` callers pass a non-empty set (`isCodeFreeScope` guarantees it), so
 * their rendering is unchanged.
 */
function formatEmptyScopeWarn(phase, cause, inScopePaths, explain) {
    const enumeration = [];
    if (inScopePaths.length > 0) {
        const shown = inScopePaths.slice(0, 20);
        const more = inScopePaths.length > shown.length
            ? `, …(+${inScopePaths.length - shown.length} more)`
            : '';
        enumeration.push(`  In-scope diff (${inScopePaths.length} path(s)): ${shown.join(', ')}${more}`);
    }
    return [
        `⚠ ${phase} did not run: ${cause}.`,
        ...enumeration,
        ...(explain ?? [
            `  Hint: ${phase} reviews code subsystems; a doc-only or test-fixture-only`,
            `  diff has no review surface. Widen with --scope paths:<glob>.`,
        ]),
    ].join('\n');
}
function resolveAnatomySubsystems(sessionDir, target, scope, log) {
    const discovered = discoverSubsystems(target);
    if (discovered.length === 0) {
        log('No subsystems discovered — skipping anatomy-park phase');
        return { skipReason: 'no_subsystems' };
    }
    if (!scope || scope.allowedPaths.length === 0) {
        // WS-B: unscoped-with-a-real-branch-diff still reviews every subsystem; an
        // empty branch diff has no review surface at all and ends the phase.
        if (shouldSkipPhaseForEmptyBranchDiff({
            phase: 'anatomy-park',
            event: 'anatomy_park_empty_scope_skip',
            sessionDir,
            effectiveAllowedPaths: scope?.allowedPaths,
            repoRoot: scope?.repoRoot ?? gitRepoRoot(target),
            extraPayload: { discovered_subsystems: discovered.map((s) => s.name) },
            log,
        })) {
            return { skipReason: 'empty_branch_diff' };
        }
        log(`Discovered ${discovered.length} subsystems: ${discovered.map(s => s.name).join(', ')}`);
        return discovered;
    }
    const kept = new Set(filterBySubsystem(discovered.map(s => s.name), scope.allowedPaths, target, scope.repoRoot));
    if (kept.size === 0) {
        // R-PSSS-1: the scope filter excluding every subsystem is a real skip the
        // operator must see — not a silent `setup returned false`. Emit the
        // structured WARN plus an `anatomy_park_empty_scope_skip` activity event.
        log(formatEmptyScopeWarn('anatomy-park', 'scope filter excluded all subsystems', scope.allowedPaths));
        logActivity({
            event: 'anatomy_park_empty_scope_skip',
            source: 'pickle',
            session: path.basename(sessionDir),
            gate_payload: {
                in_scope_paths: scope.allowedPaths,
                discovered_subsystems: discovered.map((s) => s.name),
            },
        });
        return { skipReason: 'empty_scope' };
    }
    const filtered = discovered.filter(s => kept.has(s.name));
    log(`anatomy-park: scope filtered ${discovered.length} → ${filtered.length} subsystems: ${filtered.map(s => s.name).join(', ')}`);
    return filtered;
}
// A subsystem converges at 2 consecutive clean passes (`.claude/commands/anatomy-park.md`).
const ANATOMY_CONVERGED_CLEAN_PASSES = 2;
/**
 * AP-EXT-ITER5-01: a crash-resume re-enters the phase it died in (`readResumePhasePlan`
 * returns `phases.indexOf(priorPhase)`), so phase setup runs a SECOND time over a session
 * dir that already holds a live `anatomy-park.json`. Return the prior ledger when it
 * describes the same subsystem list and has not already converged; the caller then keeps
 * `pass_counts` / `consecutive_clean` / `findings_history` / `trap_doors_added` instead of
 * zeroing them. A converged or mismatched prior ledger yields null (fresh start), and so
 * does an unreadable/malformed one. Cross-run staleness is not a concern: a pipeline that
 * re-enters pickle deletes this file in `enterPicklePhase`.
 */
function readResumableAnatomyProgress(configPath, subsystemNames) {
    const prior = readRecoverableJsonObject(configPath);
    if (!prior)
        return null;
    const priorNames = prior.subsystems;
    if (!Array.isArray(priorNames) || priorNames.length !== subsystemNames.length)
        return null;
    if (priorNames.some((name, i) => name !== subsystemNames[i]))
        return null;
    // Every counter map must already carry a live entry of the RIGHT TYPE per subsystem —
    // a present-but-non-numeric counter is written back verbatim and the worker's `+= 1`
    // lands NaN just as surely as a missing one, so `!== undefined` is not the check.
    const counterMap = (key) => {
        const raw = prior[key];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return null;
        const map = raw;
        if (subsystemNames.some(name => !Number.isFinite(map[name])))
            return null;
        return map;
    };
    const passMap = counterMap('pass_counts');
    const cleanMap = counterMap('consecutive_clean');
    const stallMap = counterMap('stall_counts');
    if (!passMap || !cleanMap || !stallMap)
        return null;
    const history = prior.findings_history;
    if (!history || typeof history !== 'object' || Array.isArray(history))
        return null;
    const historyMap = history;
    if (subsystemNames.some(name => !Array.isArray(historyMap[name])))
        return null;
    const allConverged = subsystemNames.every(name => cleanMap[name] >= ANATOMY_CONVERGED_CLEAN_PASSES);
    return allConverged ? null : prior;
}
function writeAnatomyConfig(sessionDir, subsystems, stallLimit) {
    const subsystemNames = subsystems.map(s => s.name);
    const resumable = readResumableAnatomyProgress(path.join(sessionDir, 'anatomy-park.json'), subsystemNames);
    if (resumable) {
        writeStateFile(path.join(sessionDir, 'anatomy-park.json'), { ...resumable, stall_limit: stallLimit });
        return;
    }
    const apState = {
        subsystems: subsystemNames,
        current_index: 0,
        pass_counts: Object.fromEntries(subsystemNames.map(name => [name, 0])),
        consecutive_clean: Object.fromEntries(subsystemNames.map(name => [name, 0])),
        stall_counts: Object.fromEntries(subsystemNames.map(name => [name, 0])),
        stall_limit: stallLimit,
        findings_history: Object.fromEntries(subsystemNames.map(name => [name, []])),
        trap_doors_added: [],
        trap_doors_committed: [],
    };
    writeStateFile(path.join(sessionDir, 'anatomy-park.json'), apState);
}
export function setupAnatomyPark(sessionDir, target, stallLimit, extensionRoot, log, scope, designSafe) {
    const persistedAllowedPaths = !scope || scope.allowedPaths.length === 0
        ? readPersistedAllowedPaths(sessionDir)
        : undefined;
    const effectiveScope = scope && scope.allowedPaths.length > 0
        ? scope
        : persistedAllowedPaths && persistedAllowedPaths.length > 0
            ? {
                allowedPaths: persistedAllowedPaths,
                repoRoot: readWorkingDirFromState(sessionDir, target),
            }
            : undefined;
    if (!scope && effectiveScope) {
        log(`anatomy-park: reusing persisted scope.json with ${effectiveScope.allowedPaths.length} allowed path(s)`);
    }
    const subsystems = resolveAnatomySubsystems(sessionDir, target, effectiveScope, log);
    if (!Array.isArray(subsystems))
        return subsystems;
    const citadelReport = readCitadelReport(sessionDir);
    if (citadelReport)
        log(`anatomy-park: read citadel_report.json with ${citadelReport.findings.length} finding(s)`);
    writeAnatomyConfig(sessionDir, subsystems, stallLimit);
    const runnerStallLimit = subsystems.length * 10;
    const metricJson = JSON.stringify({
        description: 'none', validation: 'none', type: 'none',
        timeout_seconds: 0, tolerance: 0, direction: 'lower',
    });
    const initArgs = [
        path.join(extensionRoot, 'extension', 'bin', 'init-microverse.js'),
        sessionDir, target,
        '--stall-limit', String(runnerStallLimit),
        '--convergence-mode', 'worker',
        '--convergence-file', 'anatomy-park.json',
        '--metric-json', metricJson,
    ];
    const scopePath = path.join(sessionDir, 'scope.json');
    if (effectiveScope && effectiveScope.allowedPaths.length > 0 && hasRecoverableScopeJson(scopePath)) {
        initArgs.push('--allowed-paths-file', scopePath);
    }
    try {
        execFileSync('node', initArgs, { timeout: 30_000, encoding: 'utf-8' });
    }
    catch (err) {
        log(`init-microverse.js failed: ${safeErrorMessage(err)}`);
        return { skipReason: 'setup_error' };
    }
    injectDesignSafeIntoMicroverse(sessionDir, designSafe, log);
    archiveFile(sessionDir, 'prd.md', 'pickle');
    fs.writeFileSync(path.join(sessionDir, 'prd.md'), buildAnatomyPrd(target, subsystems, stallLimit, runnerStallLimit, citadelReport));
    log('Anatomy Park setup complete');
    return true;
}
// ---------------------------------------------------------------------------
// Phase Setup: Szechuan Sauce
// ---------------------------------------------------------------------------
function buildSzechuanJudgeContext(sessionDir, principlesPath, extensionRoot, domain, focus, log) {
    if (!domain && !focus) {
        return fs.existsSync(principlesPath) ? principlesPath : undefined;
    }
    const parts = [];
    try {
        parts.push(fs.readFileSync(principlesPath, 'utf-8'));
    }
    catch { /* base missing */ }
    if (domain) {
        const domainPath = path.join(extensionRoot, `szechuan-sauce-${domain}-principles.md`);
        try {
            parts.push(fs.readFileSync(domainPath, 'utf-8'));
        }
        catch {
            log(`Domain principles not found: ${domainPath}`);
        }
    }
    if (focus) {
        parts.push(`\n## Focus Directive\n\n${focus}\n\nViolations matching this focus are elevated by one priority level.`);
    }
    const contextPath = path.join(sessionDir, 'judge-context.md');
    fs.writeFileSync(contextPath, parts.join('\n\n'));
    return contextPath;
}
function appendSzechuanPrinciples(prdParts, principlesPath, extensionRoot, domain) {
    prdParts.push('## Principles Reference', `Read: ${principlesPath}`);
    if (domain)
        prdParts.push(`Read: ${path.join(extensionRoot, `szechuan-sauce-${domain}-principles.md`)}`);
}
function appendSzechuanProcess(prdParts, stallLimit) {
    prdParts.push('', '## Key Metric', '- **Type**: llm (LLM judge scoring)', '- **Direction**: lower', '- **Convergence Target**: 0', `- **Stall Limit**: ${stallLimit}`, '', '## Process', '### Iteration 1: Contract Discovery + Gap Analysis', '1. Extract all exports from target files', '2. Grep the entire codebase for importers — build contract map', '3. Flag cross-module mismatches as P1', '4. Catalog all violations into gap_analysis.md', '', '### Each subsequent iteration', '1. Read the principles reference and target code', '2. Identify the highest-priority violation (P0 > P1 > P2 > P3 > P4)', '3. Fix it — one logical change per iteration', '4. Run tests — ensure green', '5. Commit');
}
function buildSzechuanPrd(target, stallLimit, principlesPath, extensionRoot, domain, focus, citadelReport) {
    const prdParts = [
        '# Szechuan Sauce: Iterative Deslopping',
        '',
        '## Objective',
        `Eliminate all coding principle violations in ${target} through iterative review and fix cycles.`,
        '',
        '## Target',
        target,
        '',
    ];
    appendSzechuanPrinciples(prdParts, principlesPath, extensionRoot, domain);
    if (focus)
        prdParts.push('', '## Focus', focus);
    appendSzechuanProcess(prdParts, stallLimit);
    prdParts.push('', '## Rules');
    prdParts.push('- One fix per iteration (atomic, revertible)');
    prdParts.push('- Never repeat a failed approach');
    prdParts.push('- P0 before P1 before P2 before P3 before P4');
    prdParts.push(...buildCitadelSzechuanContext(citadelReport));
    return prdParts.join('\n');
}
export function setupSzechuanSauce(sessionDir, target, stallLimit, extensionRoot, domain, focus, log, scope, designSafe) {
    const principlesPath = path.join(extensionRoot, 'szechuan-sauce-principles.md');
    const judgeContextArg = buildSzechuanJudgeContext(sessionDir, principlesPath, extensionRoot, domain, focus, log);
    const citadelReport = readCitadelReport(sessionDir);
    if (citadelReport)
        log(`szechuan-sauce: read citadel_report.json with ${citadelReport.findings.length} finding(s)`);
    const effectiveAllowedPaths = scope?.allowedPaths?.length
        ? scope.allowedPaths
        : readPersistedAllowedPaths(sessionDir);
    if ((!scope || scope.allowedPaths.length === 0) && effectiveAllowedPaths && effectiveAllowedPaths.length > 0) {
        log(`szechuan-sauce: reusing persisted scope.json with ${effectiveAllowedPaths.length} allowed path(s)`);
    }
    // R-PSSS-2 + WS-B: a scoped pipeline whose effective scope contains zero code
    // files (a doc-only / fixture-only diff), and an unscoped run whose branch
    // diff is empty, both make szechuan-sauce a no-op — unlike anatomy-park it
    // does not skip on its own. Skip with an operator-visible WARN +
    // `szechuan_sauce_empty_scope_skip` event instead of silently grinding the
    // worker. An UNSCOPED run with a real branch diff is the whole-repo case and
    // is left to run.
    const emptySkip = resolveSzechuanEmptySkipReason(sessionDir, target, effectiveAllowedPaths, log);
    if (emptySkip)
        return { skipReason: emptySkip };
    archiveFile(sessionDir, 'microverse.json', 'pre-szechuan');
    const initArgs = [
        path.join(extensionRoot, 'extension', 'bin', 'init-microverse.js'),
        sessionDir, target,
        '--stall-limit', String(stallLimit),
        '--convergence-target', '0',
    ];
    if (judgeContextArg)
        initArgs.push('--judge-context', judgeContextArg);
    const scopePath = path.join(sessionDir, 'scope.json');
    if (effectiveAllowedPaths && effectiveAllowedPaths.length > 0 && hasRecoverableScopeJson(scopePath)) {
        initArgs.push('--allowed-paths-file', scopePath);
    }
    try {
        execFileSync('node', initArgs, { timeout: 30_000, encoding: 'utf-8' });
    }
    catch (err) {
        log(`init-microverse.js failed: ${safeErrorMessage(err)}`);
        return { skipReason: 'setup_error' };
    }
    injectDesignSafeIntoMicroverse(sessionDir, designSafe, log);
    archiveFile(sessionDir, 'prd.md', 'anatomy-park');
    fs.writeFileSync(path.join(sessionDir, 'prd.md'), buildSzechuanPrd(target, stallLimit, principlesPath, extensionRoot, domain, focus, citadelReport));
    log('Szechuan Sauce setup complete');
    return true;
}
const PHASE_NAMES = ['pickle', 'citadel', 'anatomy-park', 'szechuan-sauce'];
function isPhaseName(phase) {
    return typeof phase === 'string' && PHASE_NAMES.includes(phase);
}
export function setupPhase(phase, config) {
    if (phase === 'pickle')
        return picklePhaseConfig();
    if (phase === 'citadel')
        return citadelPhaseConfig();
    if (phase === 'anatomy-park')
        return anatomyPhaseConfig(config);
    return szechuanPhaseConfig(config);
}
function picklePhaseConfig() {
    return {
        name: 'pickle',
        prevPhase: null,
        runnerScript: 'mux-runner.js',
        setup: null,
        refreshScope: false,
        throwOnEmptyScope: false,
        preSpawnStateMutation: null,
    };
}
function citadelPhaseConfig() {
    return {
        name: 'citadel',
        prevPhase: 'pickle',
        runnerScript: null,
        setup: null,
        refreshScope: false,
        throwOnEmptyScope: false,
        preSpawnStateMutation: null,
    };
}
function anatomyPhaseConfig(config) {
    return {
        name: 'anatomy-park',
        prevPhase: 'citadel',
        runnerScript: 'microverse-runner.js',
        setup: (args) => setupAnatomyPark(args.sessionDir, args.target, config.anatomy_stall_limit, args.extensionRoot, args.log, args.scope ? { allowedPaths: args.scope.allowed_paths, repoRoot: args.workingDir } : undefined, args.designSafe),
        refreshScope: true,
        throwOnEmptyScope: true,
        preSpawnStateMutation: null,
    };
}
function szechuanPhaseConfig(config) {
    return {
        name: 'szechuan-sauce',
        prevPhase: 'anatomy-park',
        runnerScript: 'microverse-runner.js',
        setup: (args) => setupSzechuanSauce(args.sessionDir, args.target, config.szechuan_stall_limit, args.extensionRoot, config.szechuan_domain, config.szechuan_focus, args.log, args.scope ? { allowedPaths: args.scope.allowed_paths } : undefined, args.designSafe),
        setupExtraArgs: { domain: config.szechuan_domain, focus: config.szechuan_focus },
        refreshScope: true,
        throwOnEmptyScope: false,
        preSpawnStateMutation: null,
    };
}
export async function executePhaseRunner(phaseConfig, env) {
    if (!phaseRunnerContext)
        throw new Error('phase runner context not initialized');
    if (!phaseConfig.runnerScript)
        throw new Error(`phase ${phaseConfig.name} does not use a child runner`);
    return await runSpawnRunner('node', [
        path.join(phaseRunnerContext.extensionRoot, 'extension', 'bin', phaseConfig.runnerScript),
        phaseRunnerContext.sessionDir,
    ], env);
}
const defaultCitadelRemediationDeps = {
    runCitadelAudit,
    spawnGateRemediatorMain,
    spawnRemediator: (cmd, args, opts) => {
        execFileSync(cmd, args, { cwd: opts.cwd, timeout: opts.timeout, stdio: 'pipe', env: opts.env });
    },
    loadSettings: () => {
        const s = loadFinalizeGateSettings(resolveFinalizeSettingsRoot());
        return { cap: s.citadel_max_remediation_cycles, remediatorTimeoutMs: s.remediator_timeout_s * 1000 };
    },
};
let citadelRemediationDeps = defaultCitadelRemediationDeps;
export function __setCitadelRemediationDepsForTests(partial) {
    citadelRemediationDeps = partial ? { ...defaultCitadelRemediationDeps, ...partial } : defaultCitadelRemediationDeps;
}
// R-HRP-1: the citadel-strict flag no longer halts — it now WIDENS which findings are remediated.
// Strict remediates High+ (Critical + High); non-strict remediates Critical only. The parameter is
// named `strict` (not the config field name) so the removed halt-threshold ternary is not
// re-introduced under that name anywhere in this file.
function remediationSeverityThreshold(strict) {
    return strict ? 'High' : 'Critical';
}
function logCitadelFindingsUnremediated(runtime, findings, cap) {
    runtime.log(`citadel: remediation cap (${cap}) exhausted with ${findings.length} finding(s) still open — continuing pipeline (no halt)`);
    try {
        sm.update(runtime.statePath, state => {
            const activity = Array.isArray(state.activity) ? state.activity : [];
            state.activity = [
                ...activity,
                {
                    event: 'citadel_findings_unremediated',
                    ts: new Date().toISOString(),
                    cycles: cap,
                    findings_remaining: findings.length,
                    finding_ids: findings.slice(0, 50).map(f => f.id),
                },
            ];
        });
    }
    catch (err) {
        runtime.log(`citadel_findings_unremediated activity write failed: ${safeErrorMessage(err)}`);
    }
}
// B-CSOR T50: surface the residual ADVISORY subset — findings that are sub-threshold AND
// non-mechanical (the by-design-never-remediated orphan-*/nested-ternary class). This is a
// SEPARATE signal from logCitadelFindingsUnremediated (which carries the still-open remediable
// union on cap-exhaust). Both reuse the citadel_findings_unremediated event name but answer
// different questions: cap-exhausted-open vs by-design-advisory. Best-effort: never throws.
function surfaceCitadelAdvisory(runtime, advisory) {
    if (advisory.length > 0) {
        try {
            sm.update(runtime.statePath, state => {
                const activity = Array.isArray(state.activity) ? state.activity : [];
                state.activity = [
                    ...activity,
                    {
                        event: 'citadel_findings_unremediated',
                        ts: new Date().toISOString(),
                        cycles: 0,
                        findings_remaining: advisory.length,
                        finding_ids: advisory.slice(0, 50).map(f => f.id),
                    },
                ];
            });
        }
        catch (err) {
            runtime.log(`citadel advisory activity write failed: ${safeErrorMessage(err)}`);
        }
    }
    // AP-EXT-ITER88-01: write the advisory count ADDITIVELY — every other field of the mid-run
    // record must survive a citadel exit, advisory or not, because `readResumePhasePlan` gates
    // crash-resume on `completed_phases > 0` PLUS a recognizable `current_phase`. Carrying is
    // `writePipelineStatus`'s own contract (AP-EXT-ITER90-01), so this callsite names ONLY what it
    // sets. `status` is the one field the writer never carries, so re-read it and keep it.
    try {
        const statusPath = path.join(runtime.sessionDir, 'pipeline-status.json');
        const existing = readRecoverableJsonObject(statusPath);
        writePipelineStatus(runtime.sessionDir, existing?.status ?? 'running', {
            citadel_advisory_findings: advisory.length,
        });
    }
    catch (err) {
        runtime.log(`citadel advisory pipeline-status write failed: ${safeErrorMessage(err)}`);
    }
}
// Sync FS isolated in a non-async helper (mirrors finalize-gate) so the async remediation flow
// stays free of blocking-fs lint warnings.
function writeCitadelGateResultFile(sessionDir, findings) {
    const gateResult = citadelFindingsToGateResult(findings);
    const gateDir = path.join(sessionDir, 'gate');
    fs.mkdirSync(gateDir, { recursive: true });
    const gateResultPath = path.join(gateDir, `citadel_gate_result_${isoCompactStamp()}.json`);
    writeStateFile(gateResultPath, gateResult);
    return gateResultPath;
}
function readCitadelBriefFile(briefPath, runtime) {
    try {
        return fs.readFileSync(briefPath, 'utf-8');
    }
    catch (err) {
        runtime.log(`citadel: cannot read brief at ${briefPath}: ${safeErrorMessage(err)}`);
        return null;
    }
}
async function remediateCitadelFindings(runtime, findings, remediatorTimeoutMs, cycle) {
    const gateResultPath = writeCitadelGateResultFile(runtime.sessionDir, findings);
    // Brief-prep — invoked exactly as finalize-gate does (argv interface, --reason 'strict').
    const briefLines = [];
    let briefCode;
    try {
        briefCode = await citadelRemediationDeps.spawnGateRemediatorMain({
            argv: ['--gate-result', gateResultPath, '--session-root', runtime.sessionDir, '--reason', 'strict'],
            stdout: (msg) => briefLines.push(msg),
            stderr: (msg) => runtime.log(`[citadel-remediator] ${msg}`),
        });
    }
    catch (err) {
        runtime.log(`citadel: brief-prep threw on cycle ${cycle + 1}: ${safeErrorMessage(err)}`);
        return;
    }
    if (briefCode !== 0) {
        runtime.log(`citadel: brief-prep exited ${briefCode} on cycle ${cycle + 1} — skipping remediator`);
        return;
    }
    const briefPathLine = briefLines.find(l => l.startsWith('BRIEF_PATH='));
    if (!briefPathLine) {
        runtime.log(`citadel: no BRIEF_PATH from brief-prep on cycle ${cycle + 1}`);
        return;
    }
    const briefPath = briefPathLine.slice('BRIEF_PATH='.length);
    const briefContent = readCitadelBriefFile(briefPath, runtime);
    if (briefContent === null)
        return;
    const backend = resolveBackend(sm.read(runtime.statePath));
    const invocation = buildWorkerInvocation(backend, { prompt: briefContent, addDirs: [runtime.workingDir] });
    runtime.log(`citadel: spawning remediator (cycle ${cycle + 1})`);
    try {
        citadelRemediationDeps.spawnRemediator(invocation.cmd, invocation.args, {
            cwd: runtime.workingDir,
            timeout: remediatorTimeoutMs,
            env: { ...process.env, ...backendEnvOverrides(invocation.backend) },
        });
    }
    catch (err) {
        runtime.log(`citadel: remediator exited non-zero or timed out: ${safeErrorMessage(err)}`);
    }
}
/**
 * D4 (B-RRH AC-D4): resolve the refined-or-base PRD under a session dir,
 * preferring `prd_refined.md` over `prd.md`. Used by the symmetric citadel
 * preflight heal ({@link healPipelineRequiredFields}) to self-heal a missing
 * `state.prd_path` instead of hard-failing a clean build.
 */
function resolveSessionPrdPath(sessionDir) {
    for (const name of ['prd_refined.md', 'prd.md']) {
        const candidate = path.join(sessionDir, name);
        try {
            if (fs.statSync(candidate).isFile())
                return candidate;
        }
        catch {
            /* missing — try the next candidate */
        }
    }
    return undefined;
}
/**
 * D4 (B-RRH AC-D4) + R-SCPIN (supersedes R-PSCG/B-1SEAM WS-2): symmetric
 * citadel preflight heal. Each required field heals INDEPENDENTLY — the old
 * `!prdPath && start_commit` cross-gate is gone (a deliberate widening: a
 * session missing BOTH fields can now heal both). Missing `prd_path` adopts
 * the session PRD; missing `start_commit` ADOPTS `state.pinned_sha` (the
 * co-stamped session-start baseline — R-SCPIN §0) rather than guessing a
 * merge-base review-base value against the git repoRoot. Healed values are
 * persisted AND returned so the caller uses the fresh values, never a stale
 * pre-heal state snapshot. Unhealable fields stay undefined — the honest fail
 * in {@link executeCitadelPhase} still fires (no session PRD / no pinned_sha
 * to adopt).
 */
function healPipelineRequiredFields(runtime) {
    const state = sm.read(runtime.statePath);
    let prdPath = state.prd_path;
    if (!prdPath) {
        const adopted = resolveSessionPrdPath(runtime.sessionDir);
        if (adopted) {
            sm.update(runtime.statePath, s => { s.prd_path = adopted; });
            prdPath = adopted;
            runtime.log(`citadel: self-healed missing state.prd_path — adopted ${adopted}`);
        }
    }
    let startCommit = state.start_commit;
    if (!startCommit && state.pinned_sha) {
        const adopted = state.pinned_sha;
        sm.update(runtime.statePath, s => { s.start_commit = adopted; });
        startCommit = adopted;
        runtime.log(`citadel: self-healed missing state.start_commit — adopted pinned_sha ${adopted}`);
    }
    return { prdPath, startCommit };
}
/**
 * The two `state.json` fields the citadel audit cannot run without, after
 * `healPipelineRequiredFields` has had its chance to recover them. `null` means the phase
 * fails; the caller must NOT fall back to the pre-heal snapshot (R-PSCG).
 */
function resolveCitadelPhaseInputs(runtime) {
    const { prdPath, startCommit } = healPipelineRequiredFields(runtime);
    if (prdPath && startCommit)
        return { prdPath, startCommit };
    const missing = [
        !prdPath ? 'state.prd_path' : null,
        !startCommit ? 'state.start_commit' : null,
    ].filter(Boolean).join(' and ');
    runtime.log(`citadel: missing ${missing} — failing phase`);
    return null;
}
/**
 * T40: whether the mechanical (deterministically-fixable, sub-threshold) floor is armed.
 * The floor is additive over the severity threshold and otherwise unconditional — the ONLY
 * way to collapse it to threshold-only behavior is the UNIFIED skip surface (no new
 * per-gate flag, W5b). Emits the skip event ONCE per phase invocation, not per cycle.
 */
function resolveCitadelMechanicalFloorEnabled(runtime, state) {
    const rawReason = state.flags?.skip_quality_gates_reason;
    const skipReason = typeof rawReason === 'string' && rawReason.trim() ? rawReason.trim() : null;
    if (!skipReason)
        return true;
    // MUST go to the activity-dir jsonl sink via logActivity, NOT state.json.activity:
    // the W5c skip-flag budget scanner (scanSkipFlagEvents) reads only
    // getDataRoot()/activity/<day>.jsonl, so a state.json.activity write would leave the
    // purpose-built citadel-mechanical::skip_quality_gates budget stuck at 0 forever.
    try {
        logActivity({
            event: 'gate_skipped',
            source: 'citadel-mechanical',
            ts: new Date().toISOString(),
            gate_payload: { reason: 'skip_quality_gates', detail: skipReason },
        });
    }
    catch (err) {
        runtime.log(`citadel: gate_skipped activity write failed: ${safeErrorMessage(err)}`);
    }
    return false;
}
/**
 * Split one audit cycle's findings into the remediator's input set and the advisory
 * remainder. `toRemediate` is the threshold set plus the mechanical floor (deduped by id);
 * `advisory` is the disjoint remainder — sub-threshold AND non-mechanical
 * (`orphan-` prefixes and nested-ternary) — computed via `isMechanicalCitadelFinding`
 * directly so the
 * advisory class stays stable regardless of whether the floor is armed.
 */
function partitionCitadelCycleFindings(findings, threshold, mechanicalFloorEnabled) {
    const remediable = findings.filter(f => findingMeetsThreshold(f, threshold));
    const mechanical = mechanicalFloorEnabled ? findings.filter(isMechanicalCitadelFinding) : [];
    const seen = new Set(remediable.map(f => f.id));
    return {
        toRemediate: [...remediable, ...mechanical.filter(f => !seen.has(f.id))],
        remediable,
        mechanical,
        advisory: findings.filter(f => !findingMeetsThreshold(f, threshold) && !isMechanicalCitadelFinding(f)),
    };
}
export async function executeCitadelPhase(runtime) {
    const inputs = resolveCitadelPhaseInputs(runtime);
    if (!inputs)
        return { exitCode: 1 };
    const { prdPath, startCommit } = inputs;
    const state = sm.read(runtime.statePath);
    const reportPath = path.join(runtime.sessionDir, 'citadel_report.json');
    const { cap, remediatorTimeoutMs } = citadelRemediationDeps.loadSettings();
    const threshold = remediationSeverityThreshold(runtime.config.citadel_strict);
    const mechanicalEnabled = resolveCitadelMechanicalFloorEnabled(runtime, state);
    // Outer accumulator tracks what was actually ATTEMPTED (the union), so the cap-exhausted
    // log below reflects the full set fed to the remediator, not just the threshold subset.
    let toRemediate = [];
    // B-CSOR T50: latest cycle's by-design-advisory subset (sub-threshold AND non-mechanical),
    // surfaced once on phase exit so the cap-exhausted path reflects the final audit.
    let lastAdvisory = [];
    // Bounded detect→remediate loop (mirrors finalize-gate's cycle structure). The phase ALWAYS
    // returns success; the pipeline continues to anatomy-park regardless of remediation outcome.
    for (let cycle = 0; cycle < cap; cycle++) {
        const result = await citadelRemediationDeps.runCitadelAudit({
            prdPath,
            // R-PSCG: use the RETURNED (possibly healed) startCommit, never the
            // pre-heal state snapshot — that would silently diff `undefined..HEAD`.
            diffRange: `${startCommit}..HEAD`,
            repoRoot: runtime.repoRoot,
            sessionDir: runtime.sessionDir,
            reportPath,
            strict: runtime.config.citadel_strict,
        });
        const cyclePartition = partitionCitadelCycleFindings(result.findings, threshold, mechanicalEnabled);
        toRemediate = cyclePartition.toRemediate;
        lastAdvisory = cyclePartition.advisory;
        runtime.log(`citadel: cycle ${cycle + 1}/${cap} — wrote ${reportPath} with ${result.findings.length} finding(s), ${cyclePartition.remediable.length} remediable (>= ${threshold}), ${cyclePartition.mechanical.length} mechanical, ${toRemediate.length} total, ${lastAdvisory.length} advisory`);
        if (toRemediate.length === 0) {
            runtime.log('citadel: no remediable findings — phase complete, continuing pipeline');
            surfaceCitadelAdvisory(runtime, lastAdvisory);
            return { exitCode: 0 };
        }
        await remediateCitadelFindings(runtime, toRemediate, remediatorTimeoutMs, cycle);
    }
    // Cap exhausted with findings still open: surface async + continue (never halt).
    logCitadelFindingsUnremediated(runtime, toRemediate, cap);
    surfaceCitadelAdvisory(runtime, lastAdvisory);
    return { exitCode: 0 };
}
function shouldSkipAnatomyPhaseWithWarning(phase, result, runtime) {
    if (phase !== 'anatomy-park' || result.exitCode === 0)
        return null;
    const runnerState = sm.read(runtime.statePath);
    if (runnerState.command_template !== 'anatomy-park.md' || runnerState.exit_reason !== 'fatal') {
        return null;
    }
    if (!/Cannot read properties of undefined \(reading 'description'\)/.test(result.stderr)) {
        return null;
    }
    return {
        warningClass: 'anatomy_park_missing_key_metric',
        detail: 'microverse-runner crashed on missing key_metric.description; continuing to the next pipeline phase',
    };
}
const SEVERITY_RANK = {
    Critical: 0,
    High: 1,
    Medium: 2,
    Low: 3,
};
function findingMeetsThreshold(finding, threshold) {
    return SEVERITY_RANK[finding.severity] <= SEVERITY_RANK[threshold];
}
const MICROVERSE_FATAL_REASON_SET = new Set(MICROVERSE_FATAL_REASONS);
const CRASH_FLOOR_EXIT_REASON_SET = new Set(CRASH_FLOOR_EXIT_REASONS);
const GIT_PHASE_COMMIT_COUNT_TIMEOUT_MS = 10_000;
const GIT_REPO_ROOT_TIMEOUT_MS = 5_000;
function countCommitsSince(startCommit, workingDir) {
    const output = execFileSync('git', ['rev-list', '--count', `${startCommit}..HEAD`], {
        cwd: workingDir,
        encoding: 'utf-8',
        timeout: GIT_PHASE_COMMIT_COUNT_TIMEOUT_MS,
    }).trim();
    const count = Number.parseInt(output, 10);
    if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Invalid git rev-list --count output: ${output}`);
    }
    return count;
}
function isMicroverseFatalReason(reason) {
    return typeof reason === 'string' && MICROVERSE_FATAL_REASON_SET.has(reason);
}
// B-CRASHFLOOR: the pickle-phase crash floor — mirrors isMicroverseFatalReason's shape exactly.
function isCrashFloorExitReason(reason) {
    return typeof reason === 'string' && CRASH_FLOOR_EXIT_REASON_SET.has(reason);
}
export function isFatalPhaseFailure(phase, runtime) {
    try {
        const runnerState = sm.read(runtime.statePath);
        if (phase === 'pickle') {
            // B-GTRUTH WS-A2: `done_without_commit_evidence` is no longer phase-fatal here.
            // AC-MWMO-D2-8's concern (an all-terminal bundle whose LAST ticket has no commit
            // must not fake-green) is preserved by a BETTER mechanism: mux-runner now exits
            // code 3, so `runPhaseIteration` routes it to `reportPhaseIncomplete` BEFORE
            // reaching this function, and that path consults the completion oracle instead
            // of the session-wide commit count. Demoted in lockstep with `isHaltExit` and
            // `FAILURE_EXIT_REASONS` (mux-runner.ts) so the three classifiers agree.
            //
            // B-NOSTOP-GATES WS-1: the `countCommitsSince === 0` arm below is a SECOND
            // demotion. Zero commits since baseline is a QUALITY signal — reported via
            // `maybeStampPhaseGraduation`'s `phase_no_progress` branch, which now advances
            // instead of halting — not a crash-floor cannot-continue condition. Only the
            // `!startCommit` arm remains fatal: a missing baseline means progress is
            // literally unmeasurable, which no downstream honesty gate can report around.
            const startCommit = runnerState.start_commit?.trim();
            if (!startCommit)
                return true;
            // B-CRASHFLOOR: cannot-physically-continue reasons (toolchain_unavailable,
            // state_working_dir_missing, state_schema_version_ahead) halt the pickle phase, mirroring
            // how the microverse arm below consults MICROVERSE_FATAL_REASONS. Deliberately NOT
            // FAILURE_EXIT_REASONS (mux-runner.ts) — that set is quality/measurement verdicts CLAUDE.md
            // binds to park-and-flag, not the crash floor.
            if (isCrashFloorExitReason(runnerState.exit_reason))
                return true;
            return false;
        }
        if (phase === 'anatomy-park' || phase === 'szechuan-sauce') {
            const reason = runnerState.exit_reason;
            if (isMicroverseFatalReason(reason))
                return true;
            // judge_timeout / all_judge_backends_exhausted / baseline_unmeasurable_transient are intentionally
            // NOT in MICROVERSE_FAILURE_REASONS so logPhaseHaltReason can route them through finalize-gate
            // (R-PRJT-2 / R-S529). Still treat as halt-eligible so the halt path runs instead of
            // recordRecoverablePhaseFailure.
            if (reason === 'judge_timeout' || reason === 'all_judge_backends_exhausted' || reason === 'baseline_unmeasurable_transient') {
                return true;
            }
            // Microverse failure exits (judge_unreachable, error, rate_limit_exhausted, ...) halt
            // the pipeline. R-SCJM-3 expects judge_unreachable to halt without finalize-gate.
            if (typeof reason === 'string' && isMicroverseFailureExit(reason)) {
                return true;
            }
            return false;
        }
        return true;
    }
    catch {
        // B-CRASHFLOOR AC-CF-04: a throwing sm.read is not itself a cannot-continue verdict — fail
        // OPEN (non-halt) rather than fail-closed, so a transient read error parks-and-flags instead
        // of aborting the pipeline.
        return false;
    }
}
export function shouldHaltAfterPhase(phase, exitCode, runtime) {
    if (exitCode === 0)
        return false;
    // R-HRP-1: no phase is special-cased here any more. The conformance audit became fix-forward —
    // it feeds findings to the remediator and always returns exitCode 0, so it only reaches this
    // function on a genuine misconfiguration (missing PRD/start_commit), which isFatalPhaseFailure
    // still treats as halting. Every phase now follows the same fatal-failure / strict-policy path.
    if (isFatalPhaseFailure(phase, runtime))
        return true;
    // Strict phase policy: persisted pipeline_continue_on_phase_fail=false (via --strict-phases or
    // upstream config) halts on any non-zero exit even when downstream remediation phases exist.
    try {
        const runnerState = sm.read(runtime.statePath);
        if (runnerState.pipeline_continue_on_phase_fail === false)
            return true;
    }
    catch {
        // best-effort; fall through to non-halt
    }
    return false;
}
function getRecoverablePhaseFailureReason(phase, runtime) {
    try {
        const runnerState = sm.read(runtime.statePath);
        if (phase === 'pickle') {
            const startCommit = runnerState.start_commit?.trim();
            if (startCommit) {
                const commits = countCommitsSince(startCommit, runtime.repoRoot);
                if (commits > 0) {
                    return 'non-fatal pickle exit, commits present';
                }
            }
            return 'non-fatal pickle exit';
        }
        // R-HRP-1: citadel no longer halts, so it never produces a "recoverable phase failure" reason;
        // its branch (and the deleted High/Critical halt-threshold logic) is gone.
        if (phase === 'anatomy-park' || phase === 'szechuan-sauce') {
            const exitReason = typeof runnerState.exit_reason === 'string'
                ? runnerState.exit_reason
                : 'unknown';
            return `non-fatal ${phase} exit, exit_reason=${exitReason}`;
        }
    }
    catch {
        // Best-effort telemetry; fall back to a generic reason below.
    }
    return `non-fatal ${phase} exit`;
}
export function recordRecoverablePhaseFailure(runtime, phase, exitCode, phaseIndex, decision) {
    const downstreamPhasesRemaining = runtime.config.phases.slice(phaseIndex + 1);
    try {
        sm.update(runtime.statePath, state => {
            const activity = Array.isArray(state.activity) ? state.activity : [];
            state.activity = [
                ...activity,
                {
                    event: 'recoverable_phase_failure',
                    ts: new Date().toISOString(),
                    phase,
                    exit_code: exitCode,
                    fatal: false,
                    reason: getRecoverablePhaseFailureReason(phase, runtime),
                    downstream_phases_remaining: downstreamPhasesRemaining,
                    decision,
                },
            ];
        });
    }
    catch (err) {
        runtime.log(`recoverable_phase_failure activity write failed: ${safeErrorMessage(err)}`);
    }
}
export function logPhaseContinueReason(runtime, phase, exitCode) {
    const phaseIndex = runtime.config.phases.indexOf(phase);
    const nextPhase = phaseIndex >= 0 ? runtime.config.phases[phaseIndex + 1] : undefined;
    if (nextPhase) {
        runtime.log(`Phase ${phase} exited with code ${exitCode} (non-fatal) — continuing to ${nextPhase} for automated remediation`);
        return;
    }
    runtime.log(`Phase ${phase} exited with code ${exitCode} (non-fatal) — no remaining phases; pipeline complete with non-zero phase exits`);
}
function hasPriorNonZeroRecoverableFailure(activity) {
    if (!Array.isArray(activity))
        return false;
    return activity.some((entry) => (entry?.event === 'recoverable_phase_failure'
        && typeof entry.exit_code === 'number'
        && entry.exit_code !== 0));
}
export function buildCloserReleasePlan(state) {
    if (!hasPriorNonZeroRecoverableFailure(state.activity)) {
        return {
            release: true,
            install: true,
            tag: true,
            skipReason: null,
        };
    }
    return {
        release: false,
        install: false,
        tag: false,
        skipReason: 'prior phase non-zero exit detected',
    };
}
export function executeCloserReleasePlan(plan, actions, log) {
    if (!plan.release) {
        log('Closer: prior phase non-zero exit detected — skipping install and tag');
        return;
    }
    actions.install();
    actions.tag();
}
export async function postPhaseCleanup(phase, sessionDir) {
    const prevPhaseByPhase = {
        pickle: null,
        citadel: 'pickle',
        'anatomy-park': 'citadel',
        'szechuan-sauce': 'anatomy-park',
    };
    const prevPhase = prevPhaseByPhase[phase];
    if (prevPhase)
        cleanPhaseArtifacts(sessionDir, prevPhase);
}
function persistPhaseTransition(runtime, phaseConfig, previousState) {
    sm.update(runtime.statePath, s => {
        const history = Array.isArray(s.history) ? s.history : [];
        const last = history[history.length - 1];
        s.step = phaseConfig.name;
        if (previousState.step !== phaseConfig.name && last?.step !== phaseConfig.name) {
            s.history = [...history, {
                    step: phaseConfig.name,
                    timestamp: samplePhaseHistoryTimestamp(history),
                }];
        }
    });
    try {
        logActivity({
            event: 'phase_transition',
            source: 'pickle',
            session: path.basename(runtime.sessionDir),
            previous_phase: previousState.step,
            next_phase: phaseConfig.name,
            previous_exit_reason: previousState.exit_reason ?? null,
        });
    }
    catch { /* telemetry best-effort */ }
}
export function samplePhaseHistoryTimestamp(history, nowMs = Date.now()) {
    const fallbackNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const lastTimestampMs = Array.isArray(history)
        ? [...history].reverse().reduce((found, entry) => {
            if (found !== null)
                return found;
            if (typeof entry?.timestamp !== 'string')
                return null;
            const parsed = Date.parse(entry.timestamp);
            return Number.isFinite(parsed) ? parsed : null;
        }, null)
        : null;
    const sampledMs = lastTimestampMs === null
        ? fallbackNowMs
        : Math.max(fallbackNowMs, lastTimestampMs + 1);
    return new Date(sampledMs).toISOString();
}
function restampBackendIfNeeded(statePath, backend) {
    const cur = sm.read(statePath);
    if (cur.backend !== backend)
        sm.update(statePath, s => { s.backend = backend; });
}
function preparePhaseState(phaseConfig, runtime) {
    const previousState = sm.read(runtime.statePath);
    const resetByPhase = {
        'anatomy-park': {
            template: 'anatomy-park.md',
            maxIterations: runtime.config.anatomy_max_iterations,
        },
        'szechuan-sauce': {
            template: 'szechuan-sauce.md',
            maxIterations: runtime.config.szechuan_max_iterations,
        },
    };
    const reset = resetByPhase[phaseConfig.name];
    if (phaseConfig.name === 'pickle') {
        enterPicklePhase(runtime.sessionDir, runtime.statePath, runtime.backend);
    }
    else if (reset) {
        resetStateForPhase(runtime.statePath, reset.template, reset.maxIterations);
        restampBackendIfNeeded(runtime.statePath, runtime.backend);
    }
    if (phaseConfig.preSpawnStateMutation) {
        sm.update(runtime.statePath, phaseConfig.preSpawnStateMutation);
    }
    claimPipelineRunnerActive(runtime.statePath);
    persistPhaseTransition(runtime, phaseConfig, previousState);
}
function refreshPhaseScope(phaseConfig, runtime, counters) {
    if (!phaseConfig.refreshScope)
        return undefined;
    try {
        const refreshed = refreshScope(runtime.sessionDir, phaseConfig.name, {
            repoRoot: runtime.repoRoot,
            target: runtime.target,
            log: runtime.log,
        });
        if (refreshed) {
            writeSkippedByScope(runtime.sessionDir, phaseConfig.name, refreshed, runtime.target, runtime.repoRoot);
        }
        return refreshed ?? undefined;
    }
    catch (err) {
        if (phaseConfig.throwOnEmptyScope && err instanceof Error && err instanceof ScopeError && err.code === 'SCOPE_EMPTY_POST_BUILD') {
            runtime.log(`SCOPE_EMPTY_POST_BUILD at ${phaseConfig.name} — ${err.message}`);
            writePipelineStatus(runtime.sessionDir, 'failed', {
                current_phase: phaseConfig.name,
                completed_phases: counters.completed,
                skipped_phases: counters.skipped,
                total_phases: runtime.config.phases.length,
            });
            throw err;
        }
        throw err;
    }
}
async function runConfiguredPhase(runtime, phaseConfig, counters) {
    await postPhaseCleanup(phaseConfig.name, runtime.sessionDir);
    preparePhaseState(phaseConfig, runtime);
    const scope = refreshPhaseScope(phaseConfig, runtime, counters);
    const setupResult = phaseConfig.setup ? phaseConfig.setup({
        sessionDir: runtime.sessionDir,
        target: runtime.target,
        workingDir: runtime.repoRoot,
        extensionRoot: runtime.extensionRoot,
        log: runtime.log,
        scope,
        designSafe: runtime.designSafe,
    }) : true;
    // R-PSSS-3: a non-`true` setup result carries the skip reason.
    if (setupResult !== true)
        return { skipped: true, skipReason: setupResult.skipReason, exitCode: null };
    if (phaseConfig.name === 'citadel')
        return { skipped: false, exitCode: (await executeCitadelPhase(runtime)).exitCode };
    const result = await executePhaseRunner(phaseConfig, runtime.phaseEnv);
    return { skipped: false, exitCode: result.exitCode, stderr: result.stderr };
}
export function applyStrictPhasesOverride(statePath, strictPhases, log) {
    if (!strictPhases)
        return false;
    const state = sm.read(statePath);
    if (state.pipeline_continue_on_phase_fail === false)
        return false;
    sm.update(statePath, s => { s.pipeline_continue_on_phase_fail = false; });
    log?.('strict phase policy enabled via --strict-phases; state.pipeline_continue_on_phase_fail=false');
    return true;
}
function createPipelineLog(sessionDir) {
    const runnerLog = path.join(sessionDir, 'pipeline-runner.log');
    return (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        fs.appendFileSync(runnerLog, line);
        process.stderr.write(line);
    };
}
function ensurePipelineMonitor(sessionDir, extensionRoot, log) {
    try {
        const result = ensureMonitorWindow({ sessionDir, extensionRoot, log });
        log(`ensureMonitorWindow: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
        if (result.status === 'created' || result.status === 'recreated' || result.status === 'exists') {
            try {
                sm.update(path.join(sessionDir, 'state.json'), s => {
                    const ext = s;
                    if (ext.monitor_mode === undefined || ext.monitor_mode === null) {
                        ext.monitor_mode = 'pickle';
                    }
                });
            }
            catch { /* best-effort — non-fatal */ }
        }
    }
    catch (err) {
        log(`ensureMonitorWindow: threw (ignored): ${safeErrorMessage(err)}`);
    }
}
function readPipelineConfig(pipelinePath) {
    try {
        const recoveredPipeline = readRecoverableJsonObject(pipelinePath);
        if (!recoveredPipeline)
            throw new Error('pipeline.json did not contain an object');
        const raw = recoveredPipeline;
        return { raw, config: parsePipelineConfig(raw) };
    }
    catch (err) {
        throw new Error(`Cannot read pipeline.json: ${safeErrorMessage(err)}`);
    }
}
function readClaimedPipelineState(statePath) {
    if (!fs.existsSync(statePath)) {
        throw new Error('state.json not found — run setup.js first');
    }
    try {
        sm.read(statePath);
    }
    catch (err) {
        throw new Error(`Cannot read state.json: ${safeErrorMessage(err)}`);
    }
    return claimPipelineRunnerActive(statePath);
}
function resolvePipelineBackend(statePath, state, config, sessionDir, log) {
    const { backend, source } = resolveBackendWithSource(state, config.backend, process.env.PICKLE_BACKEND);
    assertCodexRequiredBackend(sessionDir, backend, source);
    if (state.backend !== backend) {
        sm.update(statePath, s => { s.backend = backend; });
    }
    log(`backend resolved: ${backend} (source: ${source})`);
    return { backend, phaseEnv: { ...process.env, ...backendEnvOverrides(backend) } };
}
function setupRuntimeScope(sessionDir, workingDir, target, opts, pipelineRaw, log) {
    const scopeFlag = opts.scopeFlag ?? (typeof pipelineRaw.scope === 'string' ? pipelineRaw.scope : undefined);
    const scopeBase = opts.scopeBase ?? (typeof pipelineRaw.scope_base === 'string' ? pipelineRaw.scope_base : undefined);
    if (!scopeFlag)
        return;
    setupScope({ sessionDir, workingDir, target, scopeFlag, scopeBase, log });
}
/**
 * Re-reconcile the claimed state with the two launch-time overrides that can rewrite it:
 * the reconstruction epoch reset and `--strict-phases`. Each rewrite lands on disk, so the
 * caller needs the RE-READ state, never its pre-override snapshot.
 */
function applyPipelineStateOverrides(state, statePath, sessionDir, opts, log) {
    const reset = applyEpochResetOnReconstruction(state, statePath, sessionDir);
    if (reset) {
        log(`reconstruction detected (iteration=${state.iteration ?? 0}) — start_time_epoch reset ${reset.originalEpoch ?? '?'} → ${reset.newEpoch}`);
    }
    const strictApplied = applyStrictPhasesOverride(statePath, opts.strictPhases === true, log);
    return reset || strictApplied ? sm.read(statePath) : state;
}
/**
 * Bring the working tree to the clean state the phase loop requires, or FATAL. Three
 * self-heals run first, in order, because each can be the reason the tree is dirty:
 * a manager-boundary relaunch's interrupted ticket, a cold crash mid-implement, and
 * only then the assertion. Dirtiness is evaluated ONLY over `allowed_paths` when a
 * persisted scope.json exists (W1d), so an out-of-scope autofix cannot abort relaunch.
 */
function preparePipelineWorkingTree(state, workingDir, sessionDir, statePath, config, log) {
    const dirtyScope = {
        exemptSegments: config.dirty_exempt_segments,
        allowedPaths: readPersistedAllowedPaths(sessionDir),
    };
    const relaunchCount = typeof state.manager_relaunch_count === 'number' ? state.manager_relaunch_count : 0;
    if (relaunchCount > 0) {
        resetInterruptedTicketWorkForRelaunch(workingDir, dirtyScope, log);
    }
    // R-RRH C8: a cold manager crash mid-implement strands the in-flight ticket's
    // non-gate-passing source files. Self-heal the crashed ticket's files (archive
    // + reset-to-Todo) before assertCleanWorkingTree would FATAL — but NEVER destroy
    // a tree whose archive truncated (that FATALs here instead).
    quarantineCrashedTicketFilesOrFatal({
        workingDir,
        sessionDir,
        statePath,
        currentTicket: typeof state.current_ticket === 'string' ? state.current_ticket : null,
        declaredFilesByTicket: buildDeclaredFilesByTicket(sessionDir),
        exemptSegments: dirtyScope.exemptSegments,
        allowedPaths: dirtyScope.allowedPaths,
        log,
    });
    assertCleanWorkingTree(workingDir, dirtyScope);
}
/**
 * The git toplevel for `workingDir`, which is what citadel's diff walker must key its
 * repo-relative paths on (R-CWRR): in a monorepo the session's working dir is a package
 * subdirectory, and using it as the repo root yields package-relative paths that match
 * nothing. Falls back to `workingDir` itself when it is not a git checkout.
 */
function resolveGitRepoRoot(workingDir) {
    try {
        const out = execFileSync('git', ['-C', workingDir, 'rev-parse', '--show-toplevel'], {
            encoding: 'utf-8',
            timeout: GIT_REPO_ROOT_TIMEOUT_MS,
        }).trim();
        if (out)
            return out;
    }
    catch { /* non-git dir — fall back to workingDir */ }
    return workingDir;
}
function loadPipelineRuntime(sessionDir, opts, log) {
    const extensionRoot = getExtensionRoot();
    const statePath = path.join(sessionDir, 'state.json');
    const pipelinePath = path.join(sessionDir, 'pipeline.json');
    ensurePipelineMonitor(sessionDir, extensionRoot, log);
    const { config, raw: pipelineRaw } = readPipelineConfig(pipelinePath);
    const claimed = readClaimedPipelineState(statePath);
    const workingDir = claimed.working_dir || process.cwd();
    const state = applyPipelineStateOverrides(claimed, statePath, sessionDir, opts, log);
    const { backend, phaseEnv } = resolvePipelineBackend(statePath, state, config, sessionDir, log);
    preparePipelineWorkingTree(state, workingDir, sessionDir, statePath, config, log);
    setupRuntimeScope(sessionDir, workingDir, config.target || workingDir, opts, pipelineRaw, log);
    const repoRoot = resolveGitRepoRoot(workingDir);
    const designSafe = resolveDesignSafe(state.start_commit, repoRoot, opts.designSafeFlag);
    log(`design_safe resolved: ${String(designSafe)}${opts.designSafeFlag !== undefined ? ' (CLI override)' : ' (auto-detected)'}`);
    return {
        sessionDir,
        extensionRoot,
        statePath,
        config,
        target: config.target || workingDir,
        workingDir,
        repoRoot,
        backend,
        phaseEnv,
        log,
        designSafe,
    };
}
export function installShutdownHandlers(runtime, counters, cancelMarker) {
    const handleShutdown = (signal) => {
        const signalPayload = buildSignalReceivedEvent(runtime, signal);
        try {
            logActivity({ event: 'signal_received', ...signalPayload });
        }
        catch { /* telemetry best effort */ }
        runtime.log(`Received ${signal} — shutting down pipeline`);
        runtime.log(`signal_received ${JSON.stringify(signalPayload)}`);
        try {
            fs.writeFileSync(cancelMarker, signal);
        }
        catch { /* best effort */ }
        try {
            writePipelineStatus(runtime.sessionDir, 'cancelled', {
                current_phase: null,
                completed_phases: counters.completed,
                skipped_phases: counters.skipped,
                total_phases: runtime.config.phases.length,
            });
        }
        catch { /* best effort */ }
        if (activeChild && !activeChild.killed)
            reapChildSubtree(activeChild, activeChildLeadsGroup, 'SIGTERM');
        recordExitReason(runtime.statePath, `signal:${signal}`);
        safeDeactivate(runtime.statePath);
        logActivity({ event: 'session_end', source: 'pickle', session: path.basename(runtime.sessionDir), mode: 'tmux', backend: runtime.backend });
        process.exit(1);
    };
    const handlers = {
        SIGTERM: () => handleShutdown('SIGTERM'),
        SIGINT: () => handleShutdown('SIGINT'),
        SIGHUP: () => handleShutdown('SIGHUP'),
    };
    process.on('SIGTERM', handlers.SIGTERM);
    process.on('SIGINT', handlers.SIGINT);
    process.on('SIGHUP', handlers.SIGHUP);
    return () => {
        process.off('SIGTERM', handlers.SIGTERM);
        process.off('SIGINT', handlers.SIGINT);
        process.off('SIGHUP', handlers.SIGHUP);
    };
}
function getProcessGroupId(pid) {
    const pgidFn = process.getpgid;
    if (typeof pgidFn !== 'function')
        return null;
    try {
        return pgidFn(pid);
    }
    catch {
        return null;
    }
}
function getHandlerStackFrames() {
    return new Error('signal received').stack
        ?.split('\n')
        .slice(1, 6)
        .map((line) => line.trim()) ?? [];
}
function buildSignalReceivedEvent(runtime, signal) {
    const state = sm.read(runtime.statePath);
    return {
        source: 'pickle',
        session: path.basename(runtime.sessionDir),
        signal,
        pid: process.pid,
        ppid: process.ppid,
        is_tty: Boolean(process.stdin.isTTY || process.stdout.isTTY),
        pgid: getProcessGroupId(process.pid),
        active_child_pid: activeChild?.pid ?? null,
        active_child_cmd: activeChild?.spawnargs?.[0] ?? null,
        current_phase: typeof state.step === 'string' ? state.step : null,
        received_at_iso: new Date().toISOString(),
        handler_stack: getHandlerStackFrames(),
    };
}
function writeRunningStatus(runtime, counters, currentPhase) {
    writePipelineStatus(runtime.sessionDir, 'running', {
        current_phase: currentPhase,
        completed_phases: counters.completed,
        skipped_phases: counters.skipped,
        total_phases: runtime.config.phases.length,
        phase_skips: counters.phaseSkips,
        phase_dispositions: counters.phaseDispositions,
    });
}
// Frozen: returned by reference from every cold-start path, so a caller that
// mutated the plan would otherwise corrupt the shared constant.
const COLD_START_PLAN = Object.freeze({ index: 0, completed: 0, skipped: 0 });
/** Non-negative integer or 0 — a malformed count must never seed a counter. */
function resumeCount(raw) {
    return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : 0;
}
export function readResumePhasePlan(runtime) {
    let prior = null;
    try {
        prior = readRecoverableJsonObject(path.join(runtime.sessionDir, 'pipeline-status.json'));
    }
    catch { /* best-effort — unreadable status falls through to cold-start */ }
    if (!prior)
        return COLD_START_PLAN;
    if (prior.status !== 'running')
        return COLD_START_PLAN;
    if (typeof prior.completed_phases !== 'number' || prior.completed_phases <= 0)
        return COLD_START_PLAN;
    const priorPhase = prior.current_phase;
    if (!isPhaseName(priorPhase))
        return COLD_START_PLAN;
    const idx = runtime.config.phases.indexOf(priorPhase);
    if (idx < 0)
        return COLD_START_PLAN;
    return {
        index: idx,
        completed: resumeCount(prior.completed_phases),
        skipped: resumeCount(prior.skipped_phases),
    };
}
function logPhaseStart(runtime, phase, index) {
    const phaseLabel = `${index + 1}/${runtime.config.phases.length}`;
    runtime.log(`\n${'═'.repeat(60)}`);
    runtime.log(`PHASE ${phaseLabel}: ${phase.toUpperCase()} (backend=${runtime.backend})`);
    runtime.log(`${'═'.repeat(60)}`);
    printMinimalPanel(`Pipeline Phase: ${phase}`, {
        Phase: phaseLabel,
        Target: runtime.target,
    }, 'CYAN', '🧪');
}
function writeFinalPipelineActivity(runtime, totalElapsed, phasesSummary, pipelineFailed) {
    runtime.log(`Pipeline finished: ${phasesSummary} phases, ${formatTime(totalElapsed)}`);
    emitBundleLinearComments(runtime.sessionDir, path.join(runtime.sessionDir, 'pipeline-runner.log'));
    logActivity({
        event: 'session_end', source: 'pickle',
        session: path.basename(runtime.sessionDir),
        duration_min: Math.round(totalElapsed / 60),
        mode: 'tmux',
        backend: runtime.backend,
    });
    displayMacNotification(pipelineFailed ? '🧪 Pipeline Stopped' : '🧪 Pipeline Complete', `${phasesSummary} phases, ${formatTime(totalElapsed)}`);
}
const UNFINISHED_TICKETS_PRINT_CAP = 50;
/**
 * AC-V4 (dc205237): the named disposition recorded in `phaseDispositions` when the
 * pickle phase exhausts its iteration cap with tickets still unbuilt. Mirrors the
 * existing `done_over_red_worker_gate_tests:<ids>` shape — a name, a colon, the
 * comma-joined ticket ids — so `pipeline-status.json` readers get one vocabulary.
 */
const CAP_DROPPED_DISPOSITION = 'tickets_dropped_at_cap';
/**
 * Append a disposition marker to `phaseDispositions[phase]`, preserving any marker a
 * prior gate already recorded for the same phase. Two gates can legitimately fire on
 * one phase (a degraded post-final verdict AND a cap-dropped ticket), and a bare
 * assignment would silently drop whichever ran first — so the ONE append policy lives
 * here rather than being restated at each call site. The overwrite sites elsewhere in
 * this file are deliberate: they record a phase's single terminal reason, not an
 * accumulating list.
 */
function appendPhaseDisposition(counters, phase, marker) {
    const prior = counters.phaseDispositions[phase];
    counters.phaseDispositions[phase] = prior ? `${prior}; ${marker}` : marker;
}
/**
 * Report unfinished tickets when a phase exits with PhaseIncomplete (3).
 * Walks `<session>/<hash>/rick_ticket_<hash>.md`, prints non-Done entries
 * sorted by `order` ascending, capped at UNFINISHED_TICKETS_PRINT_CAP.
 * Stamps `state.exit_reason = 'pipeline_phase_incomplete'` so the
 * pipeline-level outcome is preserved alongside any per-phase
 * `iteration_cap_exhausted` already recorded by mux-runner.
 */
/**
 * B-PXBO WS-1: resolve the genuinely-unfinished ticket set for `reportPhaseIncomplete`.
 *
 * Starts from the pure status filter (`status !== 'done'`) and then RE-RESOLVES each
 * survivor through the completion oracle via the SHARED `isTicketOracleCommitted`
 * helper (R-DPGT). A ticket whose oracle result is committed is terminal-for-advance
 * — a detached large-tier worker that committed green minutes AFTER the mux cap-check
 * recorded the race-entry `iteration_cap_exhausted` is NOT phase-incomplete, so it is
 * excluded from the unfinished set. The status filter alone (pure string compare)
 * misses this because the frontmatter flip to Done lands after the cap-check.
 *
 * AC-DPGT-3: no new state field — reuses `readEvidence` (via the helper) + the
 * existing ticket roster. AC-DPGT-4 negative path: a genuinely-stuck ticket (no
 * commit) stays in the set and still reaches the `pipeline_phase_incomplete` stamp.
 */
function resolveUnfinishedTickets(runtime, tickets) {
    return tickets
        .filter(t => (t.status || '').toLowerCase() !== 'done')
        .filter(t => !(t.id && isTicketOracleCommitted({
        sessionDir: runtime.sessionDir,
        ticketId: t.id,
        workingDir: runtime.workingDir,
    })))
        .sort((a, b) => (a.order || 0) - (b.order || 0));
}
/** Log the unfinished-ticket list (capped). Extracted to keep reportPhaseIncomplete simple. */
function logUnfinishedTickets(runtime, unfinished) {
    runtime.log('Unfinished tickets:');
    const printable = unfinished.slice(0, UNFINISHED_TICKETS_PRINT_CAP);
    for (const t of printable) {
        runtime.log(`  ${String(t.order ?? 0)}  ${t.id || '<unknown>'}  ${t.title || ''}  [status: ${t.status || 'Todo'}]`);
    }
    const overflow = unfinished.length - printable.length;
    if (overflow > 0)
        runtime.log(`  ... and ${overflow} more`);
}
/**
 * B-NOSTOP-GATES WS-3 (AC-NSG-11): emits one `ticket_auto_skip_no_evidence`
 * residual event per parked (unfinished) ticket — the audit trail for a phase
 * that reports incomplete and advances instead of halting (directive 2: park,
 * flag, continue). Reuses the existing event verbatim (same shape as the
 * mux-runner.ts:2920 emission) via `logActivity` — activity JSONL ONLY, never
 * `writeActivityEntry`/`state.json.activity` (the 20MB phantom-Done-backfill
 * class this must not repeat). Callers invoke this ONCE per phase, never per
 * mux iteration. `logActivity` is itself best-effort (internal try/catch,
 * never throws), so a logging failure here cannot introduce a new halt.
 */
function emitParkedTicketResidualEvents(runtime, phase, unfinished) {
    if (unfinished.length === 0)
        return;
    const session = path.basename(runtime.sessionDir);
    let iteration;
    try {
        const it = sm.read(runtime.statePath).iteration;
        if (typeof it === 'number' && Number.isFinite(it))
            iteration = it;
    }
    catch { /* best-effort */ }
    for (const t of unfinished) {
        if (!t.id)
            continue;
        logActivity({
            event: 'ticket_auto_skip_no_evidence',
            source: 'pickle',
            session,
            ticket: t.id,
            iteration,
            reason: `parked_at_phase_${phase}`,
        });
    }
}
/**
 * Returns TRUE when `pipeline_phase_incomplete` was stamped (genuine incompleteness),
 * FALSE when the B-PXBO oracle re-resolution found nothing genuinely unfinished.
 *
 * B-GTRUTH WS-A2: the boolean makes the no-stamp verdict OBSERVABLE to
 * `runPhaseIteration`, which previously broke the pipeline either way — so a phase
 * whose every status-unfinished ticket had in fact landed still halted on a proxy.
 */
function reportPhaseIncomplete(runtime, phase) {
    const tickets = collectTickets(runtime.sessionDir);
    const unfinished = resolveUnfinishedTickets(runtime, tickets);
    const total = tickets.length;
    // B-NOSTOP-GATES WS-1: the skip gate used to require `statusUnfinished > 0` (at
    // least one non-Done ticket) BEFORE checking oracle exclusion — which an all-Done
    // roster (the healthiest possible state) can never satisfy, so it fell straight
    // through to the stamp below regardless of `unfinished.length`. The gate now keys
    // on `unfinished.length === 0` directly: every REAL ticket in the roster is
    // accounted for, whether by explicit `Done` status or oracle re-resolution. The
    // `total > 0` guard preserves the fallthrough for ticket-less phases (e.g.
    // `all_judge_backends_exhausted` + gate pass on anatomy-park/szechuan-sauce, which
    // have no ticket roster at all) — those still stamp genuinely below.
    if (unfinished.length === 0 && total > 0) {
        runtime.log(`Phase ${phase}: all ${total} ticket(s) accounted for (Done or oracle-committed/terminal) — no phase-incomplete stamp.`);
        return false;
    }
    let priorExitReason = null;
    try {
        const reason = sm.read(runtime.statePath).exit_reason;
        priorExitReason = typeof reason === 'string' ? reason : null;
    }
    catch { /* best-effort: fall back to the iteration-cap phrasing below */ }
    // The genuine iteration-cap-exhausted exit (mux-runner R-ICP-1, exit code 3) still reads
    // "hit iteration cap"; any other cause (e.g. the Layer-A suppressor relaunch class) carries
    // the real exit_reason instead of the historically misleading hardcoded string.
    // AC-D2': an ABSENT measurement (priorExitReason === null — nothing was ever
    // stamped) is a DIFFERENT fact than the cap and must render as an absence, not
    // as the specific cap cause. Conflating "we don't know why it exited" with "it
    // hit the cap" is exactly the dominant defect class this codebase's CLAUDE.md
    // names: an absent measurement reported as a specific cause.
    const cause = priorExitReason === 'iteration_cap_exhausted'
        ? 'hit iteration cap'
        : priorExitReason === null
            ? 'exited with no recorded exit_reason'
            : `exited (exit_reason=${priorExitReason})`;
    runtime.log(`Phase ${phase} ${cause}; ${unfinished.length}/${total} tickets remain unfinished.`);
    if (unfinished.length > 0) {
        logUnfinishedTickets(runtime, unfinished);
        emitParkedTicketResidualEvents(runtime, phase, unfinished);
    }
    recordExitReason(runtime.statePath, 'pipeline_phase_incomplete');
    return true;
}
/**
 * R-PIPE-2: collect Done-ticket count + commits-since-start_commit for the
 * pickle-phase progress gate. Used by `runPhaseIteration` to detect the
 * hallucinated-completion class where mux-runner exits clean (code 0) but
 * no ticket reached markTicketDone AND no commit landed since session start.
 *
 * Both reads are best-effort: a missing/unreadable state file or a `git log`
 * failure collapses to `commitCount: 0` so the gate still fires when
 * tickets are also empty. This matches the B-PIPE-FIX R-PIPE-2 contract:
 * the gate is a safety net for the manager-ran-out-of-turns case observed
 * across the 2026-05-18 PM B-SJET-2 attempts (4 consecutive 31m+ runs at
 * exit_reason='completed' with 0 Done, 0 commits).
 */
function collectPicklePhaseProgress(runtime) {
    const tickets = collectTickets(runtime.sessionDir);
    const doneCount = tickets.filter(t => (t.status || '').toLowerCase() === 'done').length;
    // Pending = still runnable: not Done, not Skipped. Skipped tickets are
    // intentionally terminal, so they must NOT count as incomplete (R-PPPA).
    const pendingCount = tickets.filter(t => {
        const s = (t.status || '').toLowerCase();
        return s !== 'done' && s !== 'skipped';
    }).length;
    let commitCount = 0;
    let startCommit = null;
    try {
        const state = sm.read(runtime.statePath);
        if (typeof state.start_commit === 'string' && state.start_commit.length > 0) {
            startCommit = state.start_commit;
        }
    }
    catch { /* best-effort */ }
    if (startCommit) {
        try {
            // why workingDir, not repoRoot: subprocess cwd — git log resolves HEAD from any dir in the repo
            const out = execFileSync('git', ['log', '--oneline', `${startCommit}..HEAD`], {
                cwd: runtime.workingDir,
                encoding: 'utf8',
                timeout: 10_000,
                maxBuffer: UNBOUNDED_READ_MAX_BUFFER,
            });
            if (typeof out === 'string') {
                commitCount = out.split('\n').filter(line => line.trim().length > 0).length;
            }
        }
        catch { /* git failure → treat as 0 commits */ }
    }
    return { doneCount, commitCount, ticketCount: tickets.length, pendingCount, startCommit };
}
/**
 * B-GROUND2 WS1: the pipeline-seam ground-truth scan fed to
 * `finalizeIfTrulyComplete` at the success finalize. Derives `GraduationCounts`
 * from the canonical `collectPicklePhaseProgress` reader. Fail-closed: any
 * unexpected throw collapses to `null` so the authority refuses the transition.
 */
function pipelineBundleScan(runtime) {
    try {
        const p = collectPicklePhaseProgress(runtime);
        return {
            doneCount: p.doneCount,
            commitCount: p.commitCount,
            pendingCount: p.pendingCount,
            ticketCount: p.ticketCount,
        };
    }
    catch {
        return null;
    }
}
/**
 * AC-V4 (dc205237): the pickle phase can exit with tickets still unbuilt for many
 * reasons, and until now every one of them was reported with the same word —
 * "incomplete". A ticket DROPPED because the phase exhausted its iteration cap is a
 * different measurement from a ticket pending for a milder reason, and a reader of a
 * finished 4/4 pipeline could never tell the two apart. This names the first one.
 *
 * Returns TRUE when it took ownership of the report (caller then suppresses the
 * generic line); FALSE means fall through to today's message unchanged.
 *
 * THIS IS A DISPOSITION PLUS A REPORT, NEVER A GATE. It records
 * `phaseDispositions` (which reaches `pipeline-status.json` via the terminal write),
 * logs a distinct line and emits one activity event carrying the dropped ticket ids.
 * It stamps no `exit_reason`, adds no abort condition and cannot break the phase
 * loop — the caller's `{ action: 'continue', phaseIncomplete: true }` is untouched.
 *
 * Observable: `state.exit_reason === 'iteration_cap_exhausted'`, the literal BOTH
 * mux-runner cap exits write (per-ticket tier budget `mux-runner.ts:11228`, global
 * `max_iterations` `:11236`), and the same literal `reportPhaseIncomplete` already
 * trusts to make this same distinction — so this adds no second observable to keep
 * in sync. Exit code 3 was rejected: it is the GENERIC `PhaseIncomplete` channel and
 * `resolvePhaseIncompleteOutcome` diverts it before `finalizePhaseSuccess` ever
 * reaches here, so it is not merely weaker but usually unavailable at this seam.
 * Must run BEFORE `reportPhaseIncomplete`, which overwrites `exit_reason` with
 * `pipeline_phase_incomplete`.
 *
 * Fails toward the generic message on every uncertainty (unreadable state, a
 * different exit_reason, no resolvable ids). A false negative degrades to today's
 * behaviour; it cannot raise a false alarm.
 */
function capDroppedTicketsReported(runtime, rawPhase, counters, progress, log) {
    try {
        if (sm.read(runtime.statePath).exit_reason !== 'iteration_cap_exhausted') {
            return false;
        }
    }
    catch {
        return false;
    }
    // Only pay the oracle/git cost of resolveUnfinishedTickets on the cap path.
    const ids = resolveUnfinishedTickets(runtime, collectTickets(runtime.sessionDir))
        .map(t => t.id)
        .filter((id) => Boolean(id));
    if (ids.length === 0) {
        return false;
    }
    appendPhaseDisposition(counters, rawPhase, `${CAP_DROPPED_DISPOSITION}:${ids.join(',')}`);
    log(`Phase ${rawPhase} hit its iteration cap with ${ids.length}/${progress.ticketCount} ticket(s) never built (${progress.doneCount} Done) — dropped at cap: ${ids.join(', ')} — reporting phase incomplete, advancing`);
    // `logActivity` is best-effort and never throws (see emitParkedTicketResidualEvents),
    // so a redundant try/catch here would add a state without removing an ambiguity.
    logActivity({
        event: 'phase_cap_dropped_tickets',
        source: 'pickle',
        session: path.basename(runtime.sessionDir),
        phase: rawPhase,
        gate_payload: {
            dropped_ticket_ids: ids,
            dropped_count: ids.length,
            done_count: progress.doneCount,
            ticket_count: progress.ticketCount,
        },
    });
    return true;
}
/**
 * B-GROUND2 WS1 (R-DPMC-2 fix): the ONE proportional graduation gate the
 * pickle phase-exit path delegates to. Collapses the three former guards
 * (`maybeStampPhaseNoProgress` 0-Done/0-commit, `maybeStampPhaseIncompleteTickets`
 * N-of-M, `maybeStampPicklePendingTickets` AC-A1 catch-all) into a single
 * decision routed through `graduationDecision` (state-manager.ts).
 *
 * The byte-identical `exitCode !== 0` early-return that opened all three guards
 * was the literal R-DPMC-2 bypass: a breaker-tripped / error pickle exit reaches
 * `finalizePhaseSuccess` (because `shouldHaltAfterPhase` returns false on non-fatal
 * non-zero pickle, R-PHC-6) and every guard early-returned, so a 14/24-Todo bundle
 * silently graduated. This gate runs on ALL exit codes — the decision is
 * by-invariant on the frontmatter ground-truth counts, never on the exit code.
 *
 * Carve-outs preserved: `rawPhase !== 'pickle'` (R-PHC-6 continue-by-default for
 * anatomy-park / szechuan-sauce is untouched) and `ticketCount === 0`
 * (never-decomposed / dispatch-only bundles, handled inside `graduationDecision`).
 *
 * The gate keys on REAL progress (`doneCount + commitCount`) for the reported REASON
 * (`phase_no_progress` vs `pipeline_phase_incomplete`), NEVER the skip-dampened
 * `pendingCount / ticketCount` ratio for the graduate-vs-report decision.
 *
 * B-NOSTOP-GATES WS-1: neither non-graduate verdict halts the pipeline any more.
 * Honesty (the exit_reason stamp + `phaseIncomplete` flag) and halting are separate
 * wires — both verdicts now report and ADVANCE (`{action:'continue'}`); a real
 * cannot-continue condition is reserved for the crash floor
 * (`isFatalPhaseFailure`'s missing-`start_commit` arm) and the explicit
 * `--strict-phases` / `pipeline_continue_on_phase_fail: false` opt-in.
 */
function maybeStampPhaseGraduation(runtime, rawPhase, _exitCode, counters, log) {
    if (rawPhase !== 'pickle') {
        return null;
    }
    const progress = collectPicklePhaseProgress(runtime);
    const counts = {
        doneCount: progress.doneCount,
        commitCount: progress.commitCount,
        pendingCount: progress.pendingCount,
        ticketCount: progress.ticketCount,
    };
    const verdict = graduationDecision(counts);
    if (verdict.decision === 'graduate') {
        return null;
    }
    // WS4 (b7cc6081): the proportional gate refused phase graduation. INVERTED
    // semantics — a refusal is the gate WORKING (refused-and-recovered), surfaced
    // as an informational count in /pickle-metrics, NOT a regression budget.
    emitPhaseGraduationRefused(runtime, counts, _exitCode);
    if (verdict.reason === 'phase_no_progress') {
        const shortStart = progress.startCommit ? progress.startCommit.slice(0, 8) : 'session start';
        log(`Phase ${rawPhase} exited with no progress (0 Done of ${progress.ticketCount} tickets, 0 commits since ${shortStart}) — reporting incomplete, advancing`);
        recordExitReason(runtime.statePath, 'phase_no_progress');
        emitParkedTicketResidualEvents(runtime, rawPhase, resolveUnfinishedTickets(runtime, collectTickets(runtime.sessionDir)));
        return { action: 'continue', phaseIncomplete: true };
    }
    // AC-V4: name the cap-drop distinctly; every milder cause keeps today's message.
    if (!capDroppedTicketsReported(runtime, rawPhase, counters, progress, log)) {
        log(`Phase ${rawPhase} exited but ${progress.pendingCount}/${progress.ticketCount} tickets remain pending (${progress.doneCount} Done) — not all-tickets-terminal, reporting phase incomplete, advancing`);
    }
    reportPhaseIncomplete(runtime, rawPhase);
    return { action: 'continue', phaseIncomplete: true };
}
/**
 * WS4 (b7cc6081): emit a `phase_graduation_refused` activity entry when the
 * proportional gate refuses to graduate the pickle phase. Best-effort
 * observability — never alters the gate decision or throws.
 */
function emitPhaseGraduationRefused(runtime, counts, exitCode) {
    try {
        logActivity({
            event: 'phase_graduation_refused',
            source: 'pickle',
            ts: new Date().toISOString(),
            gate_payload: {
                pending_count: counts.pendingCount,
                done_count: counts.doneCount,
                exit_code: exitCode,
            },
        });
    }
    catch {
        // best-effort — never block the graduation gate
    }
}
/**
 * R-PRH: exit reasons that a phase runner stamps for a documented clean stop
 * where the worker shipped and a human/manager must finish the handoff (closer
 * release work, manager-handoff section). pipeline-runner must preserve these
 * verbatim — folding them into the generic `failed` mislabels a clean handoff
 * as a fatal failure to anyone reading `state.exit_reason`.
 */
// 'recovery_exhausted' is intentionally absent here — it is a fatal non-recoverable failure
// (isFailureExit=true), NOT an operator handoff; auto-resume.sh R-CNAR-4(c) stops on it.
const PIPELINE_HANDOFF_EXIT_REASONS = new Set(['manager_handoff_pending', 'closer_handoff_terminal']);
function readHandoffExitReason(statePath) {
    try {
        const reason = sm.read(statePath).exit_reason;
        return typeof reason === 'string' && PIPELINE_HANDOFF_EXIT_REASONS.has(reason) ? reason : null;
    }
    catch {
        return null;
    }
}
// AC-MWMO-D2-10: any non-empty exit_reason already recorded on this failure
// (e.g. done_without_commit_evidence) — read so finalizePipeline can preserve
// it instead of overwriting with the generic 'failed'.
function readExistingExitReason(statePath) {
    try {
        const reason = sm.read(statePath).exit_reason;
        return typeof reason === 'string' && reason.trim() ? reason : null;
    }
    catch {
        return null;
    }
}
// Same precedent as the phaseIncomplete/handoffStop branch in
// finalizePipeline: a specific reason already stamped on this failure (e.g.
// done_without_commit_evidence) is preserved rather than overwritten by the
// generic 'failed'. Only stamp 'failed' when no reason was recorded.
function finalizeFailedPipeline(statePath) {
    finalizeTerminalState(statePath, readExistingExitReason(statePath) ? { step: 'completed' } : { step: 'completed', exitReason: 'failed' });
}
// Same precedent as `finalizeFailedPipeline`: a specific reason already stamped on a degraded
// (but not phase-shortfall) run is preserved rather than overwritten with the generic 'completed'
// stamp. Extracted so the branch does not push `finalizePipeline` past the complexity ceiling.
function finalizeDegradedCompleteOpts(statePath, unsuccessful) {
    return unsuccessful && readExistingExitReason(statePath)
        ? { step: 'completed' }
        : { step: 'completed', exitReason: 'completed' };
}
/**
 * B-NONSTOP WS-2 (AC-NS-6): the end-of-pipeline panel fields. Extracted from
 * `finalizePipeline` so the non-convergent conditional does not push that
 * function past the cyclomatic-complexity ceiling.
 *
 * B-NOSTOP-GATES WS-3 (AC-NSG-12/13): `parkedCount` adds a `Parked` row ONLY
 * when > 0, so a clean run (parkedCount 0) renders byte-identical to the
 * pre-WS-3 panel — additive, never a cosmetic change on the happy path.
 */
export function buildPipelineCompletePanel(counters, phasesSummary, totalElapsed, parkedCount = 0) {
    const panel = { Phases: phasesSummary };
    if (counters.nonConvergent > 0)
        panel['Non-convergent'] = String(counters.nonConvergent);
    // R-NOPOSTTIER (AC-12): the count alone names no cause. `phase_dispositions` was already
    // written to `pipeline-status.json`, a file read after the process is gone — an operator
    // watching the run saw a bare `Non-convergent: 1`. Render the disposition STRINGS here so
    // every withholding, including the post-final tier's, states its reason on the screen the
    // operator actually reads. Additive: a clean run has no dispositions and renders unchanged.
    const dispositions = Object.entries(counters.phaseDispositions)
        .map(([phase, disposition]) => `${phase}: ${disposition}`)
        .join('; ');
    if (dispositions)
        panel.Dispositions = dispositions;
    if (parkedCount > 0)
        panel.Parked = String(parkedCount);
    panel.Elapsed = formatTime(totalElapsed);
    return panel;
}
/**
 * B-NOSTOP-GATES WS-3 (AC-NSG-12): the current parked-ticket count for the
 * completion panel — every roster ticket neither Done nor oracle-committed,
 * reusing the same `resolveUnfinishedTickets` predicate `reportPhaseIncomplete`
 * uses. Best-effort: an unreadable roster reads as zero parked rather than
 * crashing the terminal finalize.
 */
function resolveParkedTicketCount(runtime) {
    try {
        return resolveUnfinishedTickets(runtime, collectTickets(runtime.sessionDir)).length;
    }
    catch {
        return 0;
    }
}
/**
 * The terminal banner derives from the SAME `effectiveFailed` predicate that drives the
 * `pipeline-status.json` write and the exit code — a run that exits non-zero must not print
 * a GREEN "Complete". A non-convergent phase leaves `(completed + skipped) < phases.length`,
 * so it lands here as a failure and the `Non-convergent: N` row explains a RED banner rather
 * than contradicting a green one.
 */
function buildPipelineTerminalBanner(effectiveFailed) {
    return effectiveFailed
        ? { title: 'Pipeline Failed', color: 'RED' }
        : { title: 'Pipeline Complete', color: 'GREEN' };
}
/**
 * Preserve the exit_reason stamped by reportPhaseIncomplete or by a phase
 * runner's manager/closer handoff (R-PRH); do not overwrite with the generic
 * 'failed'. This is a deliberate non-success terminal that preserves a prior
 * reason, NOT a fresh "bundle truly complete" claim — it does NOT route
 * through the ground-truth authority (which would clobber the preserved
 * reason).
 *
 * `phaseIncomplete` re-asserts its CAPTURED reason explicitly (when one was
 * actually stamped) rather than trusting whatever is currently on disk: a
 * later phase (anatomy-park / szechuan-sauce) legitimately clears exit_reason
 * on entry and stamps its OWN disposition (e.g. 'converged') on its own clean
 * finalize, which would otherwise silently overwrite the earlier phase's
 * incompleteness signal — the exact value auto-resume.sh:154 depends on to
 * relaunch. `phaseIncompleteReason` is null when the sentinel-forced robust
 * path (`maybeStampPickleIncompleteRobust`) hardcodes `phaseIncomplete: true`
 * for the exit CODE while `reportPhaseIncomplete` itself declined to stamp
 * anything (an honestly all-Done roster — ground truth wins the STAMP, only
 * the code stays forced); that case falls back to the bare preserve-as-is
 * call rather than inventing a reason nothing actually produced.
 * handoffStop-only (no phaseIncomplete) is unaffected: its reason is set and
 * read within the same phase call that breaks the loop, so nothing downstream
 * can clobber it before this runs.
 */
function finalizeNonSuccessTerminal(statePath, phaseIncomplete, phaseIncompleteReason) {
    finalizeTerminalState(statePath, phaseIncomplete && phaseIncompleteReason
        ? { step: 'completed', exitReason: phaseIncompleteReason }
        : { step: 'completed' });
}
function finalizePipeline(runtime, counters, cancelMarker, startTime, phaseIncomplete, phaseIncompleteReason) {
    const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
    const pipelineFailed = (counters.completed + counters.skipped) < runtime.config.phases.length;
    // AC-OA-1c: ran-to-completion ≠ reported-success. `nonConvergent` is the term BOTH degradation
    // paths raise, so a degraded phase withholds the success verdict just as a phase shortfall does.
    // Named once so every downstream verdict reads the same term.
    const unsuccessful = pipelineFailed || counters.nonConvergent > 0;
    const handoffStop = !!readHandoffExitReason(runtime.statePath);
    // A handoff stop is a deliberate pause, not a failure — fold it out once.
    const effectiveFailed = unsuccessful && !handoffStop;
    if (phaseIncomplete || handoffStop) {
        finalizeNonSuccessTerminal(runtime.statePath, phaseIncomplete, phaseIncompleteReason);
    }
    else if (pipelineFailed) {
        finalizeFailedPipeline(runtime.statePath);
    }
    else {
        // R-NOPOSTTIER (AC-4/AC-5): the TERMINAL STAMP keys on `pipelineFailed`, not `unsuccessful`.
        // A withheld verdict with every phase executed is not a phase shortfall: the run reached
        // completion, so `exit_reason` stays `completed` and no member is added to `EXIT_REASONS`.
        // Stamping the generic `failed` here would say the run did not finish, which is false, and
        // would be the only place a degraded verdict masqueraded as a crash.
        //
        // The VERDICT still keys on `unsuccessful` — the banner, `pipeline-status.json`, the exit
        // code, and the closer-release skip below are all unchanged. Reaching completion and
        // reporting success stay separate wires.
        //
        // Same precedent as `finalizeFailedPipeline`: a specific reason already stamped on this
        // degraded phase (e.g. `all_judge_backends_exhausted`) is preserved rather than overwritten
        // — 'completed' is stamped ONLY when no reason was recorded (e.g. the post-final-verdict
        // path, whose degraded classification lives in `state.post_final_verdict`, not `exit_reason`).
        //
        // B-GROUND2 WS1: the success finalize is the one transition that asserts the
        // ticket bundle is truly complete — route it through the single authority so
        // a residual pending ticket refuses the `completed` stamp (fail-closed).
        finalizeIfTrulyComplete(runtime.statePath, () => pipelineBundleScan(runtime), finalizeDegradedCompleteOpts(runtime.statePath, unsuccessful));
    }
    // R-PSSS-3: name each skip disposition (`anatomy-park: empty_scope`) so the
    // final summary distinguishes an empty-scope skip from a setup error.
    const skipDetail = Object.entries(counters.phaseSkips)
        .map(([phase, reason]) => `${phase}: ${reason}`)
        .join('; ');
    const phasesSummary = counters.skipped > 0
        ? `${counters.completed}/${runtime.config.phases.length} (${counters.skipped} skipped${skipDetail ? ` — ${skipDetail}` : ''})`
        : `${counters.completed}/${runtime.config.phases.length}`;
    const banner = buildPipelineTerminalBanner(effectiveFailed);
    const parkedCount = resolveParkedTicketCount(runtime);
    printMinimalPanel(banner.title, buildPipelineCompletePanel(counters, phasesSummary, totalElapsed, parkedCount), banner.color, '🧪');
    writeFinalPipelineActivity(runtime, totalElapsed, phasesSummary, effectiveFailed);
    // handoff stops skip closer-release; so does a degraded run (B-ONEABORT AC-OA-1c).
    if (!unsuccessful && !handoffStop) {
        const closerPlan = buildCloserReleasePlan(sm.read(runtime.statePath));
        executeCloserReleasePlan(closerPlan, _closerReleaseActionsForTests ?? {
            install: () => { },
            tag: () => { },
        }, runtime.log);
    }
    try {
        fs.unlinkSync(cancelMarker);
    }
    catch { /* may not exist */ }
    // AC-NS-1b(i): the dispositions are the only attribution for a non-success exit, and they
    // are read after the process is gone; dropping them leaves an operator a bare `failed`.
    // They are named here because THIS write is their authority — `counters` is the live record
    // and an emptied map must clear the key. Omitted keys are carried by `writePipelineStatus`
    // itself (AP-EXT-ITER90-01); repeating them here is no longer what keeps them alive.
    writePipelineStatus(runtime.sessionDir, effectiveFailed ? 'failed' : 'completed', {
        current_phase: null,
        completed_phases: counters.completed,
        skipped_phases: counters.skipped,
        total_phases: runtime.config.phases.length,
        phase_skips: counters.phaseSkips,
        phase_dispositions: counters.phaseDispositions,
    });
    if (phaseIncomplete) {
        process.exit(PipelineRunnerExitCode.PhaseIncomplete);
    }
    process.exit(effectiveFailed ? PipelineRunnerExitCode.Failure : PipelineRunnerExitCode.Success);
}
function emitHeadMismatchStderr(statePath) {
    try {
        const s = sm.read(statePath);
        if (s.exit_reason !== 'working_tree_modified_externally')
            return false;
        const detail = s.head_pin_mismatch_detail;
        const pinned = detail ? String(detail.pinned_branch ?? 'null') : String(s.pinned_branch ?? 'null');
        const observed = detail ? String(detail.observed_branch ?? 'unknown') : 'unknown';
        process.stderr.write(`[pipeline-runner] HEAD mismatch: pinned_branch=${pinned} observed_branch=${observed}\n`);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * AC-SCPIN-5 / AC-CF-05: honest fatal-pickle-halt reason. `isFatalPhaseFailure`'s
 * `!startCommit` branch, its crash-floor `exit_reason` branch (B-CRASHFLOOR), and its
 * zero-commits-since-baseline branch all return `true`, but they are NOT the same
 * incident: a missing baseline is unmeasurable (no commit-count check ever ran), a
 * crash-floor `exit_reason` (e.g. `toolchain_unavailable`) means the toolchain could
 * not run at all regardless of commit count, and zero commits since a captured
 * baseline is genuine zero build progress. Reporting a crash-floor halt as "zero
 * commits" mis-triages the incident — the crash-floor check MUST run before the
 * commit-count branches so a zero-commit crash-floor halt reports the real reason.
 * This is telemetry-only — it does not change the halt/no-halt decision made by
 * `isFatalPhaseFailure`.
 */
function getFatalPickleHaltReason(runtime) {
    try {
        const runnerState = sm.read(runtime.statePath);
        if (isCrashFloorExitReason(runnerState.exit_reason)) {
            return `crash floor — ${runnerState.exit_reason}`;
        }
        const startCommit = runnerState.start_commit?.trim();
        if (!startCommit) {
            return 'baseline unmeasurable — start_commit was never recorded for this session';
        }
        const shortSha = startCommit.slice(0, 8);
        // This halt path is also reachable via the strict-phase policy
        // (pipeline_continue_on_phase_fail=false) even when isFatalPhaseFailure returned
        // false because real commits landed — countCommitsSince must be checked directly
        // rather than assumed, or this string would falsely claim zero build progress.
        const commitCount = countCommitsSince(startCommit, runtime.repoRoot);
        if (commitCount === 0) {
            return `zero commits since baseline ${shortSha} — no build progress this run`;
        }
        // AC-MWMO-D2-11: commits landed since baseline does not mean the halt was
        // "a reason other than build progress" — a done_without_commit_evidence
        // halt IS about build progress (this ticket's own commit is missing) and
        // has nothing to do with strict-phase policy. Report the recorded reason
        // on disk instead of inferring one from the commit count.
        const recordedReason = typeof runnerState.exit_reason === 'string' && runnerState.exit_reason.trim()
            ? runnerState.exit_reason.trim()
            : null;
        return recordedReason
            ? `${commitCount} commit(s) since baseline ${shortSha} — halted with recorded reason: ${recordedReason}`
            : `${commitCount} commit(s) since baseline ${shortSha} — halted for an unrecorded reason`;
    }
    catch {
        return 'fatal phase failure';
    }
}
/**
 * B-ONEABORT WS-ONEABORT-2 (AC-OA-2a/AC-OA-2b): a termination that names no reason is the worst
 * available shape — the operator learns a run stopped but not why. This is the SITE-level naming
 * helper: given whatever value was actually found at a termination site (a raw `exit_reason` of
 * any type, or nothing at all), it always returns a non-empty, human-readable string. Unclassified
 * input is prefixed `unclassified:` rather than silently dropped.
 */
function describeUnclassifiedExitReason(value) {
    if (value === undefined) {
        return 'unclassified:undefined';
    }
    if (value === null) {
        return 'unclassified:null';
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? `unclassified:${trimmed}` : 'unclassified:empty-string';
    }
    try {
        return `unclassified:${typeof value}:${JSON.stringify(value)}`;
    }
    catch {
        return `unclassified:${typeof value}`;
    }
}
export function logPhaseHaltReason(runtime, rawPhase, exitCode, log) {
    const haltMsg = `Phase ${rawPhase} failed (exit ${exitCode}) — stopping pipeline`;
    // R-PIWG-1: surface HEAD mismatch before phase-type gating so it fires for all phases.
    if (exitCode !== 0 && emitHeadMismatchStderr(runtime.statePath)) {
        log(`Phase ${rawPhase} aborted: working_tree_modified_externally`);
        return 'abort';
    }
    if (exitCode === 0 || (rawPhase !== 'anatomy-park' && rawPhase !== 'szechuan-sauce')) {
        if (rawPhase === 'pickle' && exitCode !== 0) {
            log(`${haltMsg} (${getFatalPickleHaltReason(runtime)})`);
        }
        else {
            log(`${haltMsg} (non-pickle-phase failure, exit code ${exitCode})`);
        }
        return 'abort';
    }
    try {
        const runnerState = sm.read(runtime.statePath);
        const decision = classifyMicroverseHaltDecision(runnerState.exit_reason);
        if (decision.action === 'run-finalize-gate') {
            log(`Phase ${rawPhase}: microverse exited with ${decision.recognizedExitReason} — running finalize-gate anyway (transient measurement timeout, recoverable per R-PRJT-2)`);
            return decision.action;
        }
        if (decision.action === 'run-finalize-gate-incomplete') {
            log(`Phase ${rawPhase}: microverse exited with ${decision.recognizedExitReason} — running finalize-gate (phase will be marked incomplete on pass)`);
            return decision.action;
        }
        if (decision.recognizedExitReason !== null) {
            log(`Phase ${rawPhase}: microverse exited with ${decision.recognizedExitReason} — pipeline aborting (no finalize-gate)`);
            return decision.action;
        }
        log(`${haltMsg} (${describeUnclassifiedExitReason(runnerState.exit_reason)})`);
        return 'abort';
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`${haltMsg} (state read failed: ${msg})`);
        return 'abort';
    }
}
/**
 * R-PRJT-2 recovery: a microverse phase that exited on a transient
 * `judge_timeout` re-runs finalize-gate; a clean gate completes the phase,
 * a red gate breaks the pipeline. Extracted from `runPhaseIteration` to keep
 * that function under the eslint complexity ceiling.
 */
export async function runJudgeTimeoutFinalizeGate(runtime, counters, rawPhase, log) {
    try {
        logActivity({
            event: 'pipeline_judge_timeout_recovery_attempted',
            source: 'pickle',
            phase: rawPhase,
            attempts: 4,
            fall_through_to_finalize_gate: true,
        });
    }
    catch { /* telemetry best-effort */ }
    const skill = rawPhase === 'anatomy-park' ? 'anatomy-park' : 'szechuan';
    const gateResult = await runSpawnRunner('node', [
        path.join(runtime.extensionRoot, 'extension', 'bin', 'finalize-gate.js'),
        runtime.sessionDir,
        skill,
    ], runtime.phaseEnv);
    if (gateResult.exitCode === 0) {
        counters.completed++;
        writeRunningStatus(runtime, counters, null);
        log(`Phase ${rawPhase} finalize-gate passed after judge_timeout recovery`);
        return { action: 'continue' };
    }
    log(`Phase ${rawPhase} finalize-gate failed after judge_timeout recovery (exit ${gateResult.exitCode})`);
    return { action: 'break' };
}
/**
 * The `run-finalize-gate-incomplete` destination: spawn finalize-gate; on pass continue the
 * phase (matches `runJudgeTimeoutFinalizeGate`); on fail break the pipeline.
 * AC-OA-1b: the reason re-read here lands in `phaseDispositions[rawPhase]` → `pipeline-status.json`,
 * so distinct reasons yield distinct residuals. AC-OA-1c: the phase DEGRADED — `completed++` stays
 * (AC-OA-4 pin) and `nonConvergent++` rides alongside it, withholding the success verdict.
 */
export async function runAllBackendsExhaustedFinalizeGate(runtime, counters, rawPhase, log) {
    let reason = 'all_judge_backends_exhausted';
    try {
        reason = classifyMicroverseHaltDecision(sm.read(runtime.statePath).exit_reason).recognizedExitReason ?? reason;
    }
    catch { /* label is telemetry */ }
    try {
        logActivity({
            event: 'pipeline_all_backends_exhausted_recovery_attempted',
            source: 'pickle',
            phase: rawPhase,
            fall_through_to_finalize_gate: true,
        });
    }
    catch { /* telemetry best-effort */ }
    const skill = rawPhase === 'anatomy-park' ? 'anatomy-park' : 'szechuan';
    const gateResult = await runSpawnRunner('node', [
        path.join(runtime.extensionRoot, 'extension', 'bin', 'finalize-gate.js'),
        runtime.sessionDir,
        skill,
    ], runtime.phaseEnv);
    if (gateResult.exitCode === 0) {
        counters.completed++;
        counters.nonConvergent++;
        counters.phaseDispositions[rawPhase] = reason;
        writeRunningStatus(runtime, counters, null);
        log(`Phase ${rawPhase} finalize-gate passed after ${reason} — phase degraded, run cannot report success`);
        return { action: 'continue' };
    }
    log(`Phase ${rawPhase} finalize-gate failed after ${reason} (exit ${gateResult.exitCode})`);
    return { action: 'break' };
}
/**
 * AC-CF-15: a crash-floor pickle halt (missing `start_commit`, or `exit_reason` a
 * member of `CRASH_FLOOR_EXIT_REASONS` — e.g. `toolchain_unavailable`) means the
 * toolchain cannot run at all; the abort-path typecheck+lint `runGate` below is
 * guaranteed red in that state and burns ~60s emitting a misattributed
 * `tsc_gate_failed` record (see `getFatalPickleHaltReason`). The condition is DERIVED
 * from `isFatalPhaseFailure`'s pickle arm rather than restated: a second copy of the
 * same two checks lets a future crash-floor condition halt the pipeline without
 * skipping the doomed gate. This is a narrowing of when the abort gate runs, never a
 * change to whether the pipeline halts.
 */
function isCrashFloorPickleHalt(runtime, rawPhase) {
    return rawPhase === 'pickle' && isFatalPhaseFailure('pickle', runtime);
}
async function dispatchHaltAction(runtime, counters, rawPhase, exitCode, log) {
    const haltAction = logPhaseHaltReason(runtime, rawPhase, exitCode, log);
    if (haltAction === 'run-finalize-gate') {
        return runJudgeTimeoutFinalizeGate(runtime, counters, rawPhase, log);
    }
    if (haltAction === 'run-finalize-gate-incomplete') {
        return runAllBackendsExhaustedFinalizeGate(runtime, counters, rawPhase, log);
    }
    // AC-CF-15: crash-floor halts skip the abort-path gate entirely — the toolchain
    // cannot run, so the gate is guaranteed red and its telemetry misattributes cause.
    if (isCrashFloorPickleHalt(runtime, rawPhase)) {
        return { action: 'break' };
    }
    // AC-RPGT-6: best-effort typecheck+lint gate on abort path — network-free, never masks
    // the original abort reason.
    try {
        const abortGate = await runGate({
            workingDir: runtime.workingDir,
            mode: 'strict',
            scope: 'full',
            checks: ['typecheck', 'lint'],
        });
        if (abortGate.status === 'red') {
            try {
                logActivity({
                    event: 'tsc_gate_failed',
                    source: 'pickle',
                    reason: `[R-RPGT] abort-path gate: tsc/lint RED on phase ${rawPhase} exit`,
                    gate_payload: { failure_kind: 'compile_error' },
                });
            }
            catch { /* swallow emit failure */ }
        }
    }
    catch { /* gate error never masks original abort reason */ }
    return { action: 'break' };
}
/**
 * The PhaseIncomplete (exit code 3) route. Returns the outcome when the phase must
 * stop, or `null` when `runPhaseIteration` should continue to its normal path.
 *
 * B-GTRUTH WS-A2: `reportPhaseIncomplete` re-resolves every status-unfinished ticket
 * through the completion oracle. When it declines to stamp, the work landed — but
 * whether the PHASE may advance is a separate question, answered by the ROSTER:
 *   - a status-runnable ticket still remains -> stop, but do NOT stamp a false
 *     incompleteness (the pre-existing B-PXBO contract, preserved exactly);
 *   - nothing runnable remains               -> graduate (AC-GTRUTH-A2-1).
 *
 * The roster MUST be consulted HERE rather than left to `maybeStampPhaseGraduation`.
 * The observed consequence of falling through, measured by deleting this function
 * and running the whole fast tier, is the EXIT CODE: a still-runnable roster reaches
 * `shouldHaltAfterPhase`/`dispatchHaltAction` and the pipeline terminates as a
 * FAILURE (exit 1) instead of taking the PhaseIncomplete route (exit 3) that the
 * B-PXBO / R-ICP-2 contract requires. auto-resume.sh keys its retry on exit 3, so
 * an exit-1 here silently converts a resumable cap race into a dead session.
 *
 * (On the stamp: in THIS branch the oracle exclusion has already made
 * `reportPhaseIncomplete` return false, and the graduation gate calls that same
 * function, so it declines there too — the stamp is not what differs between the
 * two shapes on the pinned fixture. The exit code is. Both readings agree on the
 * conclusion: this function is load-bearing.)
 *
 * Deleting it therefore LOOKS safe and is not: all three
 * `*-done-without-commit-evidence-*` suites stay green (24/24) and only
 * `pipeline-runner-halt-on-incomplete.test.js` reddens — 'WS-1 oracle-committed
 * non-Done ticket is excluded from unfinished set', which asserts exit 3. That
 * single test is this function's pin; run it before believing a removal is safe.
 */
function resolvePhaseIncompleteOutcome(runtime, rawPhase, exitCode, log) {
    if (exitCode !== PipelineRunnerExitCode.PhaseIncomplete)
        return null;
    // WS-B (f8559470): `done_without_commit_evidence` is a per-ticket measurement
    // verdict ("this ticket's Done has no attributable evidence"), not a
    // cannot-continue budget exhaustion — its fact belongs on the verdict wire
    // (phaseIncomplete, already withholding success via `pipelineFailed`), never
    // the disposition wire that halts the phase loop. Read BEFORE
    // `reportPhaseIncomplete` mutates/re-reads exit_reason.
    const priorExitReasonForIncomplete = readExistingExitReason(runtime.statePath);
    // Branch A: `reportPhaseIncomplete` still found genuinely-unfinished,
    // non-oracle-excludable tickets (real Todo/In-Progress work the oracle cannot
    // vouch for). This IS the resumability contract this function's docstring
    // protects — mux-runner ran out of iteration budget mid-ticket with real work
    // outstanding, and auto-resume.sh needs exactly this exit-3 +
    // `pipeline_phase_incomplete` signal to relaunch and finish it. Stays `break`
    // for every reason EXCEPT `done_without_commit_evidence` (park-and-flag,
    // advances to the remaining phases instead of stopping the pipeline).
    if (reportPhaseIncomplete(runtime, rawPhase)) {
        if (isPerTicketVerdictReason(priorExitReasonForIncomplete)) {
            log(`Phase ${rawPhase}: done_without_commit_evidence is a per-ticket verdict, not a cannot-continue halt — advancing, reporting incomplete for reconciliation`);
            return { action: 'continue', phaseIncomplete: true };
        }
        return { action: 'break', phaseIncomplete: true };
    }
    // Branch B: every ticket is oracle-accounted-for (Done or oracle-confirmed
    // committed), but the raw frontmatter `pendingCount` (status-only, no oracle) still
    // shows tickets outside `done`/`skipped` — a status/evidence desync (e.g. a
    // Failed/In-Progress ticket whose commit the oracle already confirms landed). The
    // work is terminal from a truth standpoint; halting the whole session over a stale
    // status string is the same "stop on a proxy, not truth" class this campaign
    // targets. B-NOSTOP-GATES WS-1: report incomplete for reconciliation, advance.
    const pendingAfterOracle = collectPicklePhaseProgress(runtime).pendingCount;
    if (pendingAfterOracle > 0) {
        log(`Phase ${rawPhase}: oracle-committed ticket(s) excluded from the unfinished set, but ${pendingAfterOracle} ticket(s) remain runnable by status — advancing, reporting incomplete for reconciliation`);
        return { action: 'continue', phaseIncomplete: true };
    }
    log(`Phase ${rawPhase}: PhaseIncomplete exit with no genuinely-unfinished and no runnable ticket remaining — graduating`);
    return null;
}
async function runPhaseIteration(runtime, counters, cancelMarker, rawPhase, index, log) {
    logPhaseStart(runtime, rawPhase, index);
    writeRunningStatus(runtime, counters, rawPhase);
    const result = await runConfiguredPhase(runtime, setupPhase(rawPhase, runtime.config), counters);
    if (result.skipped) {
        counters.skipped++;
        // R-PSSS-3: record the specific skip disposition for pipeline-status.json
        // and the final summary instead of the generic "setup returned false".
        if (result.skipReason)
            counters.phaseSkips[rawPhase] = result.skipReason;
        writeRunningStatus(runtime, counters, null);
        log(`Phase ${rawPhase} skipped (${result.skipReason ?? 'setup returned false'})`);
        return { action: 'continue' };
    }
    const exitCode = result.exitCode ?? 1;
    log(`Phase ${rawPhase} exited with code ${exitCode}`);
    // R-PRH: a manager/closer handoff is a documented clean stop — the worker
    // shipped and a human must finish. Stop the pipeline here, preserving the
    // handoff exit_reason, instead of advancing or mislabeling it as 'failed'.
    // R-CCR-3: gate the handoff break on exitCode === 0. A non-zero exit carrying
    // a stale handoff reason must be treated as a failure, not a clean stop.
    const handoffReason = readHandoffExitReason(runtime.statePath);
    if (handoffReason) {
        if (exitCode === 0) {
            log(`Phase ${rawPhase} stopped for manager handoff (exit_reason=${handoffReason}) — pipeline paused for operator/closer work`);
            return { action: 'break' };
        }
        // Non-zero exit — stale handoff reason must be cleared so finalizePipeline
        // does not preserve it as a clean handoff (R-CCR-3 twin-read leak).
        clearExitReason(runtime.statePath);
    }
    const skipWarning = shouldSkipAnatomyPhaseWithWarning(rawPhase, {
        exitCode,
        stdout: '',
        stderr: result.stderr ?? '',
    }, runtime);
    if (skipWarning) {
        counters.skipped++;
        // AP-EXT-ITER83-01: this downgrade is a continue-past-nonzero like every other
        // one in this loop, so it records the SAME evidence. Without it, the sole
        // writer of `recoverable_phase_failure` is skipped, `buildCloserReleasePlan`
        // reads no prior non-zero exit, and a run whose anatomy-park phase CRASHED
        // returns `{release,install,tag}` with the refusal line never logged — the
        // one signal an operator reads as "the closer refused the tag".
        recordRecoverablePhaseFailure(runtime, rawPhase, exitCode, index, 'continue');
        writeRunningStatus(runtime, counters, null);
        log(`phase_skipped_with_warning ${JSON.stringify({
            phase: rawPhase,
            exit_code: exitCode,
            warning_class: skipWarning.warningClass,
            detail: skipWarning.detail,
        })}`);
        return { action: 'continue' };
    }
    const incompleteOutcome = resolvePhaseIncompleteOutcome(runtime, rawPhase, exitCode, log);
    if (incompleteOutcome)
        return incompleteOutcome;
    const shouldHalt = shouldHaltAfterPhase(rawPhase, exitCode, runtime);
    if (exitCode !== 0 && !shouldHalt) {
        recordRecoverablePhaseFailure(runtime, rawPhase, exitCode, index, 'continue');
        logPhaseContinueReason(runtime, rawPhase, exitCode);
    }
    if (shouldHalt) {
        return dispatchHaltAction(runtime, counters, rawPhase, exitCode, log);
    }
    // why workingDir, not repoRoot: AC gate commands run in the package dir, not the git toplevel
    const acGate = runAcPhaseGate({
        sessionDir: runtime.sessionDir,
        evaluationPhase: 'per-phase',
        pipelinePhase: rawPhase,
        cwd: runtime.workingDir,
        stdout: (msg) => log(msg),
        stderr: (msg) => log(msg),
    });
    if (acGate.status !== 'pass') {
        log(`Phase ${rawPhase} AC gate failed — stopping pipeline`);
        return { action: 'break' };
    }
    return finalizePhaseSuccess(runtime, counters, cancelMarker, rawPhase, exitCode, log);
}
export function classifyMicroverseHaltDecision(exitReason) {
    // B-ONEABORT AC-OA-1a: a halted run has no output, and no output has no quality — the abort
    // surface is the crash floor alone. NO member of `MICROVERSE_EXIT_REASONS` aborts; the union IS
    // the subject list, so a new reason inherits that. The floor is named against the union it lives
    // in: `session_state_corrupted` is in `MICROVERSE_FATAL_REASONS`, NOT the exit union.
    if (typeof exitReason !== 'string') {
        return { action: 'abort', recognizedExitReason: null };
    }
    // R-PRJT-2: a transient measurement timeout over already-converged work — the phase completes.
    if (exitReason === 'judge_timeout') {
        return { action: 'run-finalize-gate', recognizedExitReason: exitReason };
    }
    if (MICROVERSE_EXIT_REASONS.includes(exitReason)) {
        return { action: 'run-finalize-gate-incomplete', recognizedExitReason: exitReason };
    }
    return {
        action: 'abort',
        recognizedExitReason: isMicroverseFatalReason(exitReason) ? exitReason : null,
    };
}
/**
 * B-RRH C1: sentinel filename written by mux-runner's signal teardown
 * (`writePickleIncompleteSentinelIfRemaining`) into SESSION_ROOT when the pickle
 * phase was killed with ≥1 ticket remaining. Its presence forces the pickle
 * phase INCOMPLETE regardless of the mux exit code.
 */
const PICKLE_INCOMPLETE_SENTINEL = 'pickle_incomplete.json';
/**
 * B-RRH C1: the robustness layer on top of the exit-3 / proportional
 * graduation-gate machinery (B-GROUND2 WS1 `maybeStampPhaseGraduation`).
 *
 * The `pickle_incomplete.json` sentinel is written by mux-runner's signal
 * teardown (`writePickleIncompleteSentinelIfRemaining`, C2) ONLY when the mux was
 * killed (SIGTERM/SIGINT/SIGHUP) with ≥1 ticket still remaining. Its presence is
 * the authoritative "abnormal teardown" marker and is the one signal the
 * count-based gate cannot see — an externally-killed mux can exit 0,
 * indistinguishable from a clean completion (the B-XSPA bug). When the sentinel
 * is present this gate forces the pickle phase INCOMPLETE regardless of the mux
 * exit code or roster.
 *
 * When the sentinel is ABSENT this gate defers ENTIRELY to the unified
 * `maybeStampPhaseGraduation` proportional gate (which runs on all exit codes and
 * keys on the frontmatter ground-truth counts).
 *
 * Reuses `reportPhaseIncomplete`'s `pipeline_phase_incomplete` exit_reason and the
 * `{action:'continue', phaseIncomplete:true}` outcome — B-NOSTOP-GATES WS-1: an
 * abnormal-teardown sentinel is a REPORTING signal, not a halt. It reports
 * incomplete for reconciliation but still advances to citadel.
 */
function maybeStampPickleIncompleteRobust(runtime, rawPhase, log) {
    if (rawPhase !== 'pickle')
        return null;
    let sentinelPresent = false;
    try {
        sentinelPresent = fs.existsSync(path.join(runtime.sessionDir, PICKLE_INCOMPLETE_SENTINEL));
    }
    catch { /* best-effort — unreadable treated as absent; existing gates still apply */ }
    if (!sentinelPresent)
        return null;
    log(`Phase ${rawPhase} did NOT complete — advancing with phase reported incomplete (${PICKLE_INCOMPLETE_SENTINEL} sentinel present)`);
    reportPhaseIncomplete(runtime, rawPhase);
    return { action: 'continue', phaseIncomplete: true };
}
/**
 * WS-B (f8559470): tickets that flipped Done while WS-A's shared reader
 * (`readTicketWorkerGateTestsVerdict`) recorded `worker_gate_tests_verdict: red`
 * for them. Done is never blocked on a red test verdict (out of scope) — this
 * only names the offenders so the pipeline can withhold the success verdict
 * (AC-B1/AC-B3), never a new gate.
 */
function collectDoneTicketsWithRedTestVerdict(runtime) {
    const offenders = [];
    for (const t of collectTickets(runtime.sessionDir)) {
        if (!t.id || (t.status || '').toLowerCase() !== 'done')
            continue;
        if (readTicketWorkerGateTestsVerdict(runtime.sessionDir, t.id) === 'red') {
            offenders.push({ id: t.id, title: t.title || '' });
        }
    }
    return offenders;
}
/**
 * R-NOPOSTTIER: the marker naming a withheld success verdict whose cause is the post-final
 * fast-tier measurement (ticket `4dd2d658`). It is a DISPOSITION string, never an exit reason —
 * `EXIT_REASONS` and `CRASH_FLOOR_EXIT_REASONS` gain no member and `exit_reason` stays `completed`.
 *
 * The disposition carries `verdict.state` (`red` / `inconclusive` / `absent`), never a failing
 * test's NAME: `classifyPostFinalVerdict` returns `dimensions: []` for a red gate whose
 * `failures` array is empty, and those names come from `parseBetweenTicketFastGateFailures`
 * (R-GBANNER, out of scope). The state is always present on a degraded verdict, so it is the one
 * parser-independent attribution available.
 */
export const POST_FINAL_DEGRADED_MARKER = 'post_final_tier_degraded';
/**
 * R-NOPOSTTIER: total read of the post-final verdict recorded by `runPostFinalMeasurement`
 * (`mux-runner.ts`). Returns null for anything that is not an explicitly degraded verdict —
 * absent field, unreadable state, malformed shape — so no read failure can fabricate a
 * withholding, and a `green` / `not_applicable` verdict changes nothing.
 */
function readDegradedPostFinalVerdict(statePath) {
    let raw;
    try {
        raw = sm.read(statePath).post_final_verdict;
    }
    catch {
        return null;
    }
    if (!raw || typeof raw !== 'object')
        return null;
    const v = raw;
    if (v.degraded !== true || typeof v.state !== 'string' || !v.state)
        return null;
    const dimensions = Array.isArray(v.dimensions) ? v.dimensions.filter((d) => typeof d === 'string') : [];
    return { state: v.state, dimensions };
}
/**
 * R-NOPOSTTIER (AC-2): a degraded post-final verdict raises the SAME `counters.nonConvergent`
 * term the WS-B red-offender branch above raises, so `finalizePipeline`'s
 * `unsuccessful = pipelineFailed || counters.nonConvergent > 0` withholds the success verdict
 * and skips closer-release. No new gate, field, halt, or exit reason.
 *
 * Reaching completion and reporting success are separate wires: this never returns an outcome,
 * so control falls through to `counters.completed++` — every phase still executes, no ticket is
 * demoted, and no work is discarded.
 *
 * The disposition APPENDS rather than assigns: the red-offender branch may already have named
 * itself for this phase, and both attributions are true.
 */
function withholdForDegradedPostFinalVerdict(runtime, counters, rawPhase, log) {
    const verdict = readDegradedPostFinalVerdict(runtime.statePath);
    if (!verdict)
        return;
    counters.nonConvergent += 1;
    const marker = `${POST_FINAL_DEGRADED_MARKER}:${verdict.state}`;
    appendPhaseDisposition(counters, rawPhase, marker);
    const detail = verdict.dimensions.length > 0 ? ` — ${verdict.dimensions.join(', ')}` : '';
    log(`Phase ${rawPhase}: ${marker} — withholding success verdict${detail}`);
    try {
        writeRunningStatus(runtime, counters, null);
    }
    catch { /* non-blocking */ }
}
/**
 * R-PIPE-2: post-AC-gate success path extracted from `runPhaseIteration` so
 * the no-progress gate, counter increment, cancel-marker check, and success
 * log do not push `runPhaseIteration` past the cyclomatic-complexity ceiling.
 *
 * Exported (B-NONSTOP WS-2) so the honesty gate can be exercised directly by
 * `tests/pipeline-finalize-honesty.test.js`.
 */
export function finalizePhaseSuccess(runtime, counters, cancelMarker, rawPhase, exitCode, log) {
    // B-RRH C1: strict roster+sentinel gate runs FIRST — do not trust exit code 0.
    const robustBreak = maybeStampPickleIncompleteRobust(runtime, rawPhase, log);
    if (robustBreak)
        return robustBreak;
    // B-GROUND2 WS1: the single proportional graduation gate (R-DPMC-2 fix). Runs
    // on ALL exit codes — the former three guards' `exitCode !== 0` early-return
    // let a breaker/error pickle exit silently graduate with pending tickets.
    const graduationBreak = maybeStampPhaseGraduation(runtime, rawPhase, exitCode, counters, log);
    if (graduationBreak) {
        return graduationBreak;
    }
    // WS-B (f8559470): the pickle phase graduated, but ≥1 ticket flipped Done over a
    // red worker_gate_tests_verdict. The run STILL executes every remaining phase
    // (AC-B2 — completed++ below is unaffected) and closer-release still needs the
    // caller to see a name; raise the existing `nonConvergent` term so
    // `finalizePipeline`'s `unsuccessful = pipelineFailed || counters.nonConvergent > 0`
    // withholds the success verdict (AC-B1) and skips closer-release, without adding a
    // new gate, field, or halt.
    if (rawPhase === 'pickle') {
        const redOffenders = collectDoneTicketsWithRedTestVerdict(runtime);
        if (redOffenders.length > 0) {
            counters.nonConvergent += redOffenders.length;
            const names = redOffenders.map((o) => `${o.id}${o.title ? ` (${o.title})` : ''}`).join(', ');
            counters.phaseDispositions[rawPhase] = `done_over_red_worker_gate_tests:${redOffenders.map((o) => o.id).join(',')}`;
            log(`Phase ${rawPhase}: ${redOffenders.length} ticket(s) flipped Done over a red worker_gate_tests_verdict — withholding success verdict: ${names}`);
            try {
                writeRunningStatus(runtime, counters, null);
            }
            catch { /* non-blocking */ }
        }
        withholdForDegradedPostFinalVerdict(runtime, counters, rawPhase, log);
    }
    // B-NONSTOP WS-2 (AC-NS-6): non-pickle honesty gate. `maybeStampPhaseGraduation`
    // is pickle-only (`:3592`), so a non-convergent anatomy-park / szechuan-sauce phase
    // — which reaches here with exitCode 1 (R-PHC-6 continue-by-default) — would otherwise
    // fall straight through to `counters.completed++` and be reported a clean success
    // (the live fake-green: `approach_exhaustion` recorded as success, 2026-07-17-a1597bbe).
    // Citadel carries no microverse disposition and never enters this branch. Template-A
    // continue only (no halt/abort — that routing is T5's scope).
    //
    // AP-EXT-ITER5-01: the test is `!== 'success'`, NOT `=== 'non-convergent'`. `reportAs` has FOUR
    // not-success values (`non-convergent`, `non-success`, `failure`, `non-fatal-halt`) and naming
    // only one of them is the enumerated-set liability: `fatal`, `stalled`, `cancelled` and every
    // unrecognized string classify `non-success`, so a CRASHED phase fell through to `completed++`
    // and the run reported success. `converged` is the sole disposition whose own exitCode is 0, so
    // "not success" and "did not exit clean" are the same set — one comparison against the single
    // success value needs no list, and a future reason can only be caught by it, never missed.
    if (rawPhase === 'anatomy-park' || rawPhase === 'szechuan-sauce') {
        let exitReason = null;
        try {
            exitReason = sm.read(runtime.statePath).exit_reason;
        }
        catch { /* best-effort — unreadable state defers to the success path below */ }
        if (typeof exitReason === 'string' && classifyMicroverseDisposition(exitReason).reportAs !== 'success') {
            counters.nonConvergent++;
            counters.phaseDispositions[rawPhase] = exitReason;
            // Errors are non-blocking: a failed status write still reports the phase and continues.
            try {
                writeRunningStatus(runtime, counters, null);
            }
            catch { /* non-blocking */ }
            log(`Phase ${rawPhase} did NOT converge (${exitReason}) — reported non-convergent, not counted as completed`);
            // Honor operator cancellation here too — the phase loop has no independent
            // cancel check and relies on this exit (mirrors the success path below).
            if (fs.existsSync(cancelMarker)) {
                log('Pipeline cancelled (cancel marker found) — stopping');
                return { action: 'break' };
            }
            return { action: 'continue' };
        }
    }
    counters.completed++;
    writeRunningStatus(runtime, counters, null);
    if (fs.existsSync(cancelMarker)) {
        log('Pipeline cancelled (cancel marker found) — stopping');
        return { action: 'break' };
    }
    log(`Phase ${rawPhase} completed successfully`);
    return { action: 'continue' };
}
function setProducerDone(runtime, value) {
    try {
        sm.update(runtime.statePath, s => {
            if (Array.isArray(s.monitor_panes) && s.monitor_panes[2]) {
                s.monitor_panes[2].producer_done = value;
            }
        });
    }
    catch { /* best-effort */ }
}
async function handlePhaseBoundaryRespawn(runtime, rawPhase, nextRawPhase) {
    if (rawPhase === 'pickle' && nextRawPhase === 'citadel')
        return;
    if (nextRawPhase !== 'anatomy-park' && nextRawPhase !== 'szechuan-sauce' && nextRawPhase !== undefined)
        return;
    // R-MDS-6: signal pane 2 producer is done BEFORE respawn
    setProducerDone(runtime, true);
    // The second arg is a monitor MODE, not a pipeline phase: it is forwarded verbatim
    // as `node monitor.js --mode <it>`, and parseMonitorArgs exits 64 on anything outside
    // VALID_MODES. 'anatomy-park'/'szechuan-sauce' are modes in their own right; the
    // end-of-pipeline case has no next phase and must name the idle mode directly.
    const mode = nextRawPhase ?? 'idle';
    await respawnMonitorWindowForMode(runtime.sessionDir, mode, { log: runtime.log });
    // R-MDS-6: reset flag so replacement watcher shows normal no-data message
    setProducerDone(runtime, false);
}
/**
 * R-CRSR (WS-3-FacetA): the phase index the loop resumes at, seeding `counters` from the
 * same status file that chose it. AC-CWRR-6: skipping phases WITHOUT carrying their counts
 * forward leaves `finalizePipeline`'s (completed + skipped) < phases.length permanently
 * true, so a fully-successful resumed pipeline would finalize FAILED and skip the closer
 * install/tag. Cold start resolves to 0 and seeds nothing.
 */
function seedResumePhaseCounters(runtime, counters, log) {
    const resumePlan = readResumePhasePlan(runtime);
    if (resumePlan.index <= 0)
        return resumePlan.index;
    counters.completed = resumePlan.completed;
    counters.skipped = resumePlan.skipped;
    log(`Crash-resume: starting phase loop at index ${resumePlan.index} (${runtime.config.phases[resumePlan.index]}) per prior pipeline-status.json; seeded counters completed=${counters.completed} skipped=${counters.skipped}`);
    return resumePlan.index;
}
/**
 * Run the configured phases in order from `startIndex`, accumulating the incompleteness
 * verdict. B-NOSTOP-GATES WS-1: the session's exit code derives from WHETHER any phase
 * reported incomplete, not from which arm ended the loop — honesty and halting are
 * separate wires, so a `break` here is a disposition, not a verdict.
 */
async function runPipelinePhaseLoop(runtime, counters, cancelMarker, startIndex, log) {
    const result = { phaseIncomplete: false, phaseIncompleteReason: null };
    for (let i = startIndex; i < runtime.config.phases.length; i++) {
        const rawPhase = runtime.config.phases[i];
        if (!isPhaseName(rawPhase)) {
            log(`Unknown phase: ${String(rawPhase)} — skipping`);
            continue;
        }
        const outcome = await runPhaseIteration(runtime, counters, cancelMarker, rawPhase, i, log);
        if (outcome.phaseIncomplete) {
            result.phaseIncomplete = true;
            // Capture the reason AT THE MOMENT it was stamped — a later phase's own
            // clean finalize (e.g. anatomy-park's 'converged') can overwrite
            // state.json.exit_reason before finalizePipeline runs, so the boolean
            // alone is not enough to recover what auto-resume.sh needs to see.
            const capturedReason = readExistingExitReason(runtime.statePath);
            if (capturedReason)
                result.phaseIncompleteReason = capturedReason;
        }
        if (outcome.action === 'break')
            break;
        // R-MDS-1: Rebind monitor dashboard pane at non-citadel phase boundaries.
        const nextRawPhase = runtime.config.phases[i + 1];
        await handlePhaseBoundaryRespawn(runtime, rawPhase, nextRawPhase);
    }
    return result;
}
export async function main(sessionDir, opts = {}) {
    const schemaDrift = schemaVersionDeployDriftMessage();
    if (schemaDrift !== null) {
        process.stderr.write(`${schemaDrift}\n`);
        process.exit(1);
    }
    const log = createPipelineLog(sessionDir);
    log('pipeline-runner started');
    const runtime = loadPipelineRuntime(sessionDir, opts, log);
    const counters = { completed: 0, skipped: 0, phaseSkips: {}, nonConvergent: 0, phaseDispositions: {} };
    const cancelMarker = path.join(sessionDir, 'pipeline-cancel');
    const cleanupShutdownHandlers = installShutdownHandlers(runtime, counters, cancelMarker);
    const startTime = Date.now();
    phaseRunnerContext = {
        sessionDir,
        extensionRoot: runtime.extensionRoot,
        childMuxRunnerHeartbeatMs: runtime.config.child_mux_runner_heartbeat_ms,
        childMuxRunnerStallSeconds: runtime.config.child_mux_runner_stall_seconds,
    };
    const resumeStartIndex = seedResumePhaseCounters(runtime, counters, log);
    writeRunningStatus(runtime, counters, null);
    let loop;
    try {
        loop = await runPipelinePhaseLoop(runtime, counters, cancelMarker, resumeStartIndex, log);
    }
    finally {
        phaseRunnerContext = null;
        cleanupShutdownHandlers();
    }
    finalizePipeline(runtime, counters, cancelMarker, startTime, loop.phaseIncomplete, loop.phaseIncompleteReason);
}
/** Extract the value following `flag` in argv, or `undefined` if absent. */
function parseArgvFlag(argv, flag) {
    const idx = argv.indexOf(flag);
    if (idx === -1 || idx + 1 >= argv.length)
        return undefined;
    return argv[idx + 1];
}
/** First argv token that's not a flag and not the value of a preceding flag. */
function findPositional(argv, valuedFlags) {
    for (let i = 0; i < argv.length; i++) {
        const prev = i > 0 ? argv[i - 1] : '';
        if (argv[i].startsWith('--'))
            continue;
        if (valuedFlags.has(prev))
            continue;
        return argv[i];
    }
    return undefined;
}
if (process.argv[1] && path.basename(process.argv[1]) === 'pipeline-runner.js') {
    const argv = process.argv.slice(2);
    const valuedFlags = new Set(['--scope', '--scope-base']);
    const sessionDir = findPositional(argv, valuedFlags);
    const statePath = sessionDir ? path.join(sessionDir, 'state.json') : '';
    if (!sessionDir || readRecoverableJsonObject(statePath) === null) {
        console.error('Usage: node pipeline-runner.js <session-dir> [--scope <flag>] [--scope-base <ref>] [--strict-phases] [--design-safe | --no-design-safe]');
        process.exit(1);
    }
    const scopeFlag = parseArgvFlag(argv, '--scope');
    const scopeBase = parseArgvFlag(argv, '--scope-base');
    const strictPhases = argv.includes('--strict-phases');
    // R-PIAP-B2: explicit override wins; if both present, --design-safe wins.
    const designSafeFlag = argv.includes('--design-safe') ? true :
        argv.includes('--no-design-safe') ? false :
            undefined;
    main(sessionDir, { scopeFlag, scopeBase, strictPhases, designSafeFlag }).catch((err) => {
        // AC-CWRR-5 / AP-EXT-ITER89-01: the crash attribution — `current_phase` (WHICH phase was
        // running when the crash hit), `phase_skips`, `phase_dispositions`,
        // `citadel_advisory_findings` — must survive a fatal exit, not just a clean finalize. Naming
        // keys here is what erased it; carrying is now `writePipelineStatus`'s own contract
        // (AP-EXT-ITER90-01), so this handler sets the terminal disposition and nothing else.
        try {
            writePipelineStatus(sessionDir, 'failed', {});
        }
        catch { /* best effort */ }
        const fatalStatePath = path.join(sessionDir, 'state.json');
        try {
            recordExitReason(fatalStatePath, 'fatal');
            safeDeactivate(fatalStatePath);
        }
        catch { /* best effort — never block fatal exit on state write */ }
        const msg = safeErrorMessage(err);
        console.error(`${Style.RED}[FATAL] ${msg}${Style.RESET}`);
        process.exit(1);
    });
}
