import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { isRecord } from '../lib/is-record.js';
import { auditCodexManagerRelaunchCaps } from './bundle-state-integrity.js';
import { safeErrorMessage } from './pickle-utils.js';
import { detectMissingTools } from './verify-command-safety.js';
export const AC_PHASE_MANIFEST = 'ac-phase-manifest.json';
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const VALID_EVALUATION_PHASES = new Set([
    'pre-refinement',
    'post-refinement',
    'per-phase',
    'bundle-end',
]);
function readManifestArray(manifestPath) {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (Array.isArray(raw))
        return raw;
    if (!isRecord(raw))
        throw new Error('manifest root must be an object or array');
    const criteria = raw.acceptance_criteria ?? raw.acceptanceCriteria;
    if (!Array.isArray(criteria)) {
        throw new Error('manifest must contain acceptance_criteria or acceptanceCriteria array');
    }
    return criteria;
}
const OPTIONAL_INTEGER_RULES = {
    expected_exit_code: { positive: false, reason: 'expected_exit_code must be an integer' },
    timeout_ms: { positive: true, reason: 'timeout_ms must be a positive integer' },
};
function normalizeOptionalIntegerField(raw, key, id) {
    const value = raw[key];
    if (value === undefined)
        return undefined;
    const { positive, reason } = OPTIONAL_INTEGER_RULES[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || (positive && value <= 0)) {
        return { id, reason };
    }
    return value;
}
function normalizeCriterion(raw, index) {
    if (!isRecord(raw))
        return { id: `#${index + 1}`, reason: 'criterion must be an object' };
    const id = typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id : `#${index + 1}`;
    const evaluationPhase = raw.evaluation_phase;
    if (!VALID_EVALUATION_PHASES.has(evaluationPhase)) {
        return { id, reason: 'missing or invalid evaluation_phase' };
    }
    const command = raw.command;
    if (command !== undefined && typeof command !== 'string' && (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === 'string'))) {
        return { id, reason: 'command must be a string or string array' };
    }
    const expectedExitCode = normalizeOptionalIntegerField(raw, 'expected_exit_code', id);
    if (isFailure(expectedExitCode))
        return expectedExitCode;
    const timeoutMs = normalizeOptionalIntegerField(raw, 'timeout_ms', id);
    if (isFailure(timeoutMs))
        return timeoutMs;
    return {
        id,
        evaluation_phase: evaluationPhase,
        command: command,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        phase: typeof raw.phase === 'string' ? raw.phase : undefined,
        expected_exit_code: expectedExitCode,
        timeout_ms: timeoutMs,
    };
}
function isFailure(value) {
    return isRecord(value) && typeof value.reason === 'string';
}
function shouldEvaluate(criterion, evaluationPhase, pipelinePhase) {
    if (criterion.evaluation_phase !== evaluationPhase)
        return false;
    if (evaluationPhase !== 'per-phase')
        return true;
    return !criterion.phase || criterion.phase === pipelinePhase;
}
const SHELL_REQUIRES_RE = /[|&;<>$`(]/;
function requiresShell(command) {
    return SHELL_REQUIRES_RE.test(command);
}
function tokenizeCommand(command) {
    const tokens = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (inSingle) {
            if (ch === "'") {
                inSingle = false;
            }
            else {
                current += ch;
            }
        }
        else if (inDouble) {
            if (ch === '\\' && i + 1 < command.length) {
                current += command[++i];
            }
            else if (ch === '"') {
                inDouble = false;
            }
            else {
                current += ch;
            }
        }
        else if (ch === "'") {
            inSingle = true;
        }
        else if (ch === '"') {
            inDouble = true;
        }
        else if (ch === '\\' && i + 1 < command.length) {
            current += command[++i];
        }
        else if (/\s/.test(ch)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
        }
        else {
            current += ch;
        }
    }
    if (current)
        tokens.push(current);
    return tokens;
}
function runStringCommand(command, cwd, timeout) {
    if (requiresShell(command)) {
        return spawnSync('/bin/sh', ['-c', 'set -f; ' + command], { cwd, encoding: 'utf-8', timeout });
    }
    const [bin, ...args] = tokenizeCommand(command);
    return spawnSync(bin, args, { cwd, encoding: 'utf-8', timeout });
}
function runBuiltinCriterion(criterion, sessionDir) {
    if (criterion.id !== 'AC-BUNDLE-03')
        return null;
    const result = auditCodexManagerRelaunchCaps(sessionDir);
    if (result.violations.length === 0)
        return null;
    const reason = result.violations
        .map((violation) => `${path.relative(sessionDir, violation.statePath) || 'state.json'}: ${violation.reason}`)
        .join('; ');
    return { id: criterion.id, reason };
}
function runCriterion(criterion, cwd, sessionDir) {
    const builtinFailure = runBuiltinCriterion(criterion, sessionDir);
    if (builtinFailure)
        return builtinFailure;
    if (!criterion.command)
        return null;
    const missing = detectMissingTools(criterion.command);
    if (missing.length > 0) {
        return { id: criterion.id, reason: `tool not installed: ${missing.join(', ')} — install the tool or rewrite the AC with POSIX equivalents` };
    }
    const expected = criterion.expected_exit_code ?? 0;
    const commandCwd = criterion.cwd ?? cwd;
    const timeout = criterion.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const result = Array.isArray(criterion.command)
        ? spawnSync(criterion.command[0], criterion.command.slice(1), { cwd: commandCwd, encoding: 'utf-8', timeout })
        : runStringCommand(criterion.command, commandCwd, timeout);
    // AP-EXT-ITER317-01: `status` is null for TWO different events — a timeout (which
    // also sets `error`, measured) and an external signal from a process-tree reap or
    // the OOM killer (which sets ONLY `signal`; `error` is undefined). Collapsing that
    // null onto 1 made a criterion that never completed byte-identical to one that RAN
    // and exited 1: a PASS whenever the criterion declares `expected_exit_code: 1`, and
    // a phantom `got 1` attribution otherwise. A process that did not exit has no exit
    // status, so it is routed through the same did-not-complete branch the timeout
    // already takes rather than compared against `expected`. Widened, not added —
    // enumerating signal numbers into a 128+N exit code would be the same
    // enumerated-set liability that left this hole.
    if (result.error || result.signal) {
        return {
            id: criterion.id,
            reason: safeErrorMessage(result.error ?? `killed by signal ${result.signal}`),
        };
    }
    const actual = result.status ?? 1;
    if (actual !== expected) {
        const detail = result.stderr || result.stdout || `exit ${actual}`;
        return { id: criterion.id, reason: `expected exit ${expected}, got ${actual}: ${detail}`.slice(0, 500) };
    }
    return null;
}
export function runAcPhaseGate(opts) {
    const manifestPath = path.join(opts.sessionDir, AC_PHASE_MANIFEST);
    if (!fs.existsSync(manifestPath)) {
        return { status: 'pass', phase: opts.evaluationPhase, evaluated: [], skipped: [], failures: [] };
    }
    let rawCriteria;
    try {
        rawCriteria = readManifestArray(manifestPath);
    }
    catch (err) {
        return {
            status: 'fail',
            phase: opts.evaluationPhase,
            evaluated: [],
            skipped: [],
            failures: [{ id: AC_PHASE_MANIFEST, reason: safeErrorMessage(err) }],
            manifestPath,
        };
    }
    const normalized = rawCriteria.map(normalizeCriterion);
    const failures = normalized.filter(isFailure);
    const criteria = normalized.filter((item) => !isFailure(item));
    const evaluated = [];
    const skipped = [];
    for (const criterion of criteria) {
        if (!shouldEvaluate(criterion, opts.evaluationPhase, opts.pipelinePhase)) {
            skipped.push(criterion.id);
            continue;
        }
        evaluated.push(criterion.id);
        const failure = runCriterion(criterion, opts.cwd ?? process.cwd(), opts.sessionDir);
        if (failure)
            failures.push(failure);
    }
    if (failures.length > 0) {
        for (const failure of failures) {
            opts.stderr?.(`[ac-phase-gate] ${opts.evaluationPhase} ${failure.id}: ${failure.reason}`);
        }
    }
    else if (evaluated.length > 0) {
        opts.stdout?.(`[ac-phase-gate] ${opts.evaluationPhase}: ${evaluated.length} AC(s) passed`);
    }
    return {
        status: failures.length > 0 ? 'fail' : 'pass',
        phase: opts.evaluationPhase,
        evaluated,
        skipped,
        failures,
        manifestPath,
    };
}
