import * as path from 'path';
import { runCmd, writeStateFile, safeErrorMessage } from './pickle-utils.js';
import { readRecoverableJsonObject } from './microverse-state.js';
import { isCodegraphArtifact, listWorkingTreeDirtyPaths } from './git-utils.js';
const CONSTRAINT_DISCOVERY_PATTERN = /\b(constraint|invariant|assumption|requirement|contract|blocked by|discovered)\b/i;
const CORRECT_COURSE_SUGGESTION = 'Suggested recovery: run /pickle-correct-course "<discovery>"';
// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
let warned = false;
// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------
function freshState() {
    return {
        state: 'CLOSED',
        last_change: new Date().toISOString(),
        consecutive_no_progress: 0,
        consecutive_same_error: 0,
        last_error_signature: null,
        last_known_head: '',
        last_known_step: null,
        last_known_ticket: null,
        last_progress_iteration: 0,
        total_opens: 0,
        reason: '',
        opened_at: null,
        history: [],
    };
}
function isCircuitState(value) {
    return value === 'CLOSED' || value === 'HALF_OPEN' || value === 'OPEN';
}
export function readCircuitBreakerState(sessionDir) {
    const cbPath = path.join(sessionDir, 'circuit_breaker.json');
    const raw = readRecoverableJsonObject(cbPath);
    if (!raw || !isCircuitState(raw.state))
        return null;
    return {
        state: raw.state,
        last_change: raw.last_change || new Date().toISOString(),
        consecutive_no_progress: Number(raw.consecutive_no_progress) || 0,
        consecutive_same_error: Number(raw.consecutive_same_error) || 0,
        last_error_signature: raw.last_error_signature ?? null,
        last_known_head: raw.last_known_head || '',
        last_known_step: raw.last_known_step ?? null,
        last_known_ticket: raw.last_known_ticket ?? null,
        last_progress_iteration: Number(raw.last_progress_iteration) || 0,
        total_opens: Number(raw.total_opens) || 0,
        reason: raw.reason || '',
        opened_at: raw.opened_at ?? null,
        history: Array.isArray(raw.history) ? raw.history : [],
    };
}
function transition(state, to, reason, iteration) {
    const from = state.state;
    if (from === to)
        return;
    const now = new Date().toISOString();
    state.history.push({ timestamp: now, iteration, from, to, reason });
    if (state.history.length > 1000)
        state.history.shift();
    state.state = to;
    state.last_change = now;
    state.reason = to === 'CLOSED' ? '' : reason;
    if (to === 'OPEN') {
        state.total_opens++;
        state.opened_at = now;
    }
    if (to === 'CLOSED') {
        state.opened_at = null;
    }
}
export function loadSettings(extensionRoot) {
    const config = {
        enabled: true,
        noProgressThreshold: 5,
        sameErrorThreshold: 5,
        halfOpenAfter: 2,
    };
    try {
        const settingsPath = path.join(extensionRoot, 'pickle_settings.json');
        const raw = readRecoverableJsonObject(settingsPath);
        if (!raw)
            return config;
        if (typeof raw.default_circuit_breaker_enabled === 'boolean') {
            config.enabled = raw.default_circuit_breaker_enabled;
        }
        const rawNP = Number(raw.default_cb_no_progress_threshold);
        if (Number.isFinite(rawNP) && rawNP > 0)
            config.noProgressThreshold = rawNP;
        const rawSE = Number(raw.default_cb_same_error_threshold);
        if (Number.isFinite(rawSE) && rawSE > 0)
            config.sameErrorThreshold = rawSE;
        const rawHO = Number(raw.default_cb_half_open_after);
        if (Number.isFinite(rawHO) && rawHO > 0)
            config.halfOpenAfter = rawHO;
    }
    catch {
        // Silent I/O failure — use defaults
    }
    // Validation: enforce minimums and relationship constraints
    if (config.noProgressThreshold < 2)
        config.noProgressThreshold = 2;
    if (config.sameErrorThreshold < 2)
        config.sameErrorThreshold = 2;
    if (config.halfOpenAfter >= config.noProgressThreshold) {
        config.halfOpenAfter = Math.max(1, config.noProgressThreshold - 1);
    }
    if (config.halfOpenAfter < 1)
        config.halfOpenAfter = 1;
    return config;
}
export function initCircuitBreaker(sessionDir, _settings) {
    try {
        // `state.json`'s `iteration` field is shared across every phase runner in the
        // session (mux-runner, microverse-runner) and is reset at phase boundaries
        // (resetStateForPhase) and on `setup.js --resume --reset`, independently of the
        // breaker's own accumulated progress. Comparing the breaker's
        // `last_progress_iteration` against it cannot distinguish "this file is a foreign
        // leftover" from "a legitimate boundary moved iteration out from under the
        // breaker" — it only ever fires on the latter, silently discarding real
        // accumulated no-progress/error state. Trust a structurally valid
        // circuit_breaker.json as-is; corruption is handled by readCircuitBreakerState's
        // isCircuitState check and the outer catch below.
        return readCircuitBreakerState(sessionDir) ?? freshState();
    }
    catch {
        // Corrupted or missing — start fresh
        return freshState();
    }
}
export function canExecute(state) {
    return state.state !== 'OPEN';
}
export function detectProgress(workingDir, lastKnownHead, prevStep, currentStep, prevTicket, currentTicket) {
    const stepChanged = prevStep !== null && prevStep !== currentStep;
    const ticketChanged = prevTicket !== null && prevTicket !== currentTicket;
    // Verify git availability
    const isGit = runCmd(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: workingDir, check: false });
    if (isGit !== 'true') {
        if (!warned) {
            warned = true;
            console.error('[circuit-breaker] Working directory is not a git repo — assuming progress');
        }
        return { hasProgress: true, currentHead: '', filesChanged: 0, stepChanged, ticketChanged };
    }
    const currentHead = runCmd(['git', 'rev-parse', 'HEAD'], { cwd: workingDir, check: false });
    // First-iteration warm-up: no baseline to compare against.
    // Compute currentHead above so subsequent iterations have a baseline.
    if (lastKnownHead === '') {
        return { hasProgress: true, currentHead, filesChanged: 0, stepChanged, ticketChanged };
    }
    // AP-EXT-ITER222-01: ONE dirty-tree read, not a pair of `git diff` reads. `git diff
    // --stat` plus `--stat --cached` covers tracked modifications staged and unstaged and
    // NOTHING untracked, so a worker whose entire output is NEW files was byte-identical
    // to a clean tree here — and this is the BREAKER, so `noProgressThreshold` such
    // iterations trip OPEN and exit the run `circuit_open` over work sitting on disk.
    // `-uall` inside `listWorkingTreeDirtyPaths` (AP-EXT-ITER98-01) makes new files
    // visible and the union it returns is a SUPERSET of the two diffs it replaces, so
    // this is one read, one branch, one definition of "uncommitted work" — the same one
    // `mux-runner.ts:commitPendingProbe` already uses (AP-EXT-ITER99-01), which is why
    // the rescue probe and the breaker could previously answer the SAME tree oppositely.
    // `.codegraph/` is untracked dirt on a fresh clone (ignored only through the local,
    // unversioned `.git/info/exclude`); unfiltered it would read as progress on every
    // stagnant iteration and the no-progress breaker could never trip at all.
    let dirtyPaths;
    try {
        dirtyPaths = listWorkingTreeDirtyPaths(workingDir).filter((p) => !isCodegraphArtifact(p));
    }
    catch {
        // The working tree could not be measured. Assume progress: advancing the
        // no-progress counter on a measurement that never happened walks the run toward
        // `circuit_open`, and a halt is the one outcome with no recovery.
        return { hasProgress: true, currentHead, filesChanged: 0, stepChanged, ticketChanged };
    }
    const hasUncommittedWork = dirtyPaths.length > 0;
    let headChanged = currentHead !== lastKnownHead;
    // R-DEFCHURN (#127): an EMPTY commit (e.g. a worker's repeated "deferred
    // conformance" no-op when an AC is unsatisfiable from its allowed file set)
    // advances the commit SHA but leaves the TREE unchanged. A pure SHA comparison
    // then reports false progress and resets the no-progress circuit breaker every
    // iteration, so a churn of empty commits burns the whole per-ticket budget
    // (live incident 2026-06-19 session 2b1e2707, ticket 26cd29db: ~12 deferral
    // commits, 9 of them empty) instead of tripping the breaker. Only count a head
    // change as progress when the committed TREE actually changed; on rev-parse
    // failure fall back to the SHA-based result (no behavior change).
    if (headChanged && lastKnownHead) {
        const currentTree = runCmd(['git', 'rev-parse', `${currentHead}^{tree}`], { cwd: workingDir, check: false });
        const lastTree = runCmd(['git', 'rev-parse', `${lastKnownHead}^{tree}`], { cwd: workingDir, check: false });
        if (currentTree && lastTree && currentTree === lastTree) {
            headChanged = false;
        }
    }
    return {
        hasProgress: hasUncommittedWork || headChanged || stepChanged || ticketChanged,
        currentHead,
        filesChanged: dirtyPaths.length,
        stepChanged,
        ticketChanged,
    };
}
export function extractErrorSignature(ndjsonOutput) {
    const lines = ndjsonOutput.split('\n').filter(l => l.trim());
    let lastAssistantText = '';
    let isErrorResult = false;
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'assistant') {
                const msg = parsed.message;
                if (msg && Array.isArray(msg.content)) {
                    for (const block of msg.content) {
                        if (block?.type === 'text' && typeof block.text === 'string') {
                            lastAssistantText = block.text;
                        }
                    }
                }
            }
            if (parsed.type === 'result' && typeof parsed.subtype === 'string') {
                isErrorResult = parsed.subtype.startsWith('error');
            }
        }
        catch {
            continue;
        }
    }
    if (!isErrorResult || !lastAssistantText)
        return null;
    return normalizeErrorSignature(lastAssistantText);
}
export function normalizeErrorSignature(errorLine) {
    let s = errorLine;
    // Rule 1: Replace Unix paths
    s = s.replace(/\/[\w.@/-]+/g, '<PATH>');
    // Rule 2: Replace ISO 8601 timestamps.
    // MUST run before the line:column rule below: `:\d+:\d+` matches the `:MM:SS`
    // inside a timestamp, which leaves this regex unmatchable and the sub-second
    // field unscrubbed — so one repeated error yields a new signature every
    // iteration and consecutive_same_error can never reach its threshold.
    s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<TS>');
    // Rule 3: Replace line:column patterns :N:N
    s = s.replace(/:\d+:\d+/g, ':<N>:<N>');
    // Rule 4: Replace UUIDs
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>');
    // Rule 5: Standalone numbers are preserved (exit codes matter)
    // Rule 6: Collapse consecutive whitespace
    s = s.replace(/\s+/g, ' ').trim();
    // Rule 7: Truncate to 200 chars
    if (s.length > 200)
        s = s.slice(0, 200);
    return s;
}
export function isConstraintDiscoverySignature(signature) {
    return typeof signature === 'string' && CONSTRAINT_DISCOVERY_PATTERN.test(signature);
}
function noProgressReason(count, signature) {
    const base = `No progress in ${count} iterations`;
    return isConstraintDiscoverySignature(signature)
        ? `${base}. ${CORRECT_COURSE_SUGGESTION}`
        : base;
}
function updateErrorTracking(newState, priorSignature, currentSignature) {
    if (currentSignature === null) {
        newState.consecutive_same_error = 0;
        newState.last_error_signature = null;
        return;
    }
    if (currentSignature === priorSignature) {
        newState.consecutive_same_error++;
    }
    else {
        newState.consecutive_same_error = 1;
        newState.last_error_signature = currentSignature;
    }
}
export function recordIterationResult(state, result, iteration, settings) {
    const newState = {
        ...state,
        history: [...state.history],
    };
    updateErrorTracking(newState, state.last_error_signature, result.errorSignature);
    // Progress tracking
    if (result.hasProgress) {
        newState.consecutive_no_progress = 0;
        newState.last_progress_iteration = iteration;
        // Recovery: HALF_OPEN -> CLOSED (error counters NOT reset)
        if (state.state === 'HALF_OPEN') {
            transition(newState, 'CLOSED', 'Progress detected', iteration);
        }
    }
    else {
        newState.consecutive_no_progress++;
    }
    // State transitions (error check first — errors are unambiguous)
    if (newState.consecutive_same_error >= settings.sameErrorThreshold) {
        transition(newState, 'OPEN', `Same error repeated ${newState.consecutive_same_error} times`, iteration);
    }
    else if (newState.consecutive_no_progress >= settings.noProgressThreshold) {
        transition(newState, 'OPEN', noProgressReason(newState.consecutive_no_progress, newState.last_error_signature), iteration);
    }
    else if (newState.consecutive_no_progress >= settings.halfOpenAfter
        && newState.state === 'CLOSED') {
        transition(newState, 'HALF_OPEN', `No progress in ${newState.consecutive_no_progress} iterations`, iteration);
    }
    return newState;
}
export function resetCircuitBreaker(sessionDir, reason) {
    const cbPath = path.join(sessionDir, 'circuit_breaker.json');
    const recovered = readCircuitBreakerState(sessionDir);
    if (!recovered) {
        console.error('[circuit-breaker] No circuit_breaker.json found — nothing to reset');
        return;
    }
    const current = recovered;
    if (current.state === 'CLOSED') {
        console.error('[circuit-breaker] Already CLOSED — no reset needed');
        return;
    }
    const resetState = freshState();
    // Preserve history for audit trail
    resetState.history = Array.isArray(current.history) ? [...current.history] : [];
    resetState.history.push({
        timestamp: new Date().toISOString(),
        iteration: 0,
        from: current.state,
        to: 'CLOSED',
        reason: `Manual reset: ${reason}`,
    });
    try {
        writeStateFile(cbPath, resetState);
        console.error(`[circuit-breaker] Reset from ${current.state} to CLOSED: ${reason}`);
    }
    catch (err) {
        const msg = safeErrorMessage(err);
        console.error(`[circuit-breaker] Failed to write reset state: ${msg}`);
    }
}
