/**
 * judge-spawn-env.ts — R-SJET-3
 *
 * Purpose: Produce a sanitized env for the LLM judge `claude` / `codex` spawns
 * inside microverse-runner / szechuan / plumbus / microverse.
 *
 * Goals:
 * - Prevent nested-claude auth/session contamination (H2 in the SJET PRD).
 * - Strip PICKLE_* and Claude-Code session markers (`CLAUDECODE`,
 *   `CLAUDECODE_*`, `CLAUDE_SESSION_*`, `CLAUDE_PROJECT_*`) that can leak the
 *   outer manager context.
 * - Preserve auth/routing env: `ANTHROPIC_*`, `CLAUDE_CODE_USE_VERTEX`,
 *   `CLAUDE_CODE_USE_BEDROCK`, and any other non-session `CLAUDE_*` var the
 *   child CLI needs to authenticate or pick its provider.
 * - Provide a single place for future "judge backend specific" pruning.
 *
 * Used by: microverse-runner.ts (measureLlmMetricAttempt + probeJudgeCliAvailability)
 * and any future convergence judge paths.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { backendEnvOverrides } from './backend-spawn.js';
/**
 * Returns true when the current process is running inside a Claude Code session.
 * Detects both CLAUDE_CODE (set by Claude Code CLI) and CLAUDECODE (legacy marker).
 */
export function isNestedClaude(env = process.env) {
    return !!(env['CLAUDE_CODE'] || env['CLAUDECODE']);
}
/**
 * Build a sanitized env for the judge spawn.
 *
 * - `isNested && backend === 'claude'`: strip the outer-session markers
 *   (CLAUDE_CODE, CLAUDECODE, CLAUDE_API_KEY when ANTHROPIC_API_KEY is present)
 *   and replace XDG_RUNTIME_DIR with an isolated tmpdir.
 * - Otherwise: return baseEnv merged with backendEnvOverrides(backend).
 *   Env values are never logged — callers may log Object.keys(result) only.
 */
export function buildJudgeEnv(backend, isNested, baseEnv = process.env) {
    if (isNested && backend === 'claude') {
        const out = {};
        for (const [k, v] of Object.entries(baseEnv)) {
            if (v === undefined)
                continue;
            // Strip outer session markers unconditionally.
            if (k === 'CLAUDE_CODE' || k === 'CLAUDECODE')
                continue;
            // Strip CLAUDE_API_KEY only when ANTHROPIC_API_KEY is present — the child can
            // authenticate via ANTHROPIC_API_KEY directly, so CLAUDE_API_KEY is redundant
            // and might point at the outer session's key material.
            if (k === 'CLAUDE_API_KEY' && baseEnv['ANTHROPIC_API_KEY'])
                continue;
            // R-SJET-3 superset: also strip the DANGEROUS_PREFIXES session markers so
            // the probe path inherits outer-session env hygiene (PICKLE_*,
            // SESSION_ROOT, TICKET_DIR, etc.). CLAUDECODE is handled above.
            if (DANGEROUS_PREFIXES.some(p => k.startsWith(p)))
                continue;
            out[k] = v;
        }
        // Replace XDG_RUNTIME_DIR to prevent the nested claude from sharing the outer
        // session's runtime socket/state directory.
        out['XDG_RUNTIME_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-judge-'));
        return out;
    }
    return { ...baseEnv, ...backendEnvOverrides(backend) };
}
// Narrowly-targeted session markers only. Do NOT add a blanket `CLAUDE_`
// prefix here — that strips routing controls like CLAUDE_CODE_USE_VERTEX /
// CLAUDE_CODE_USE_BEDROCK that the child CLI needs.
const DANGEROUS_PREFIXES = [
    'PICKLE_',
    'PICKLE_RICK_',
    'CLAUDECODE_',
    'CLAUDE_SESSION_',
    'CLAUDE_PROJECT_',
    'SESSION_ROOT',
    'TICKET_DIR',
];
/**
 * Convenience wrapper used at the two judge spawn sites in microverse-runner.ts.
 * Delegates to buildJudgeEnv with isNestedClaude() detection.
 * cwd is accepted for API stability; not used (no repo .env loading at judge spawn time).
 */
export function getJudgeEnvForAttempt(backend, cwd) {
    void cwd;
    const narrowed = (backend === 'claude' || backend === 'codex') ? backend : 'claude';
    return buildJudgeEnv(narrowed, isNestedClaude());
}
const JUDGE_TMPDIR_PREFIX = 'pickle-judge-';
/**
 * Removes the `XDG_RUNTIME_DIR` directory created by buildJudgeEnv, if any.
 *
 * Only removes directories buildJudgeEnv itself created (a `pickle-judge-`-prefixed
 * child of os.tmpdir()) — never a real ambient XDG_RUNTIME_DIR that could be passed
 * through unmodified in the non-nested branch. Best-effort: cleanup failure never
 * throws into the judge spawn path (R-ORCG — pickle-judge-* was 72% of leaked tmpdirs
 * in a measured production census).
 */
export function cleanupJudgeRuntimeDir(env) {
    const dir = env['XDG_RUNTIME_DIR'];
    if (!dir) {
        return;
    }
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith(JUDGE_TMPDIR_PREFIX)) {
        return;
    }
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    catch {
        // Best-effort; cleanup failure must never propagate into the judge spawn path.
    }
}
export default { getJudgeEnvForAttempt, buildJudgeEnv, isNestedClaude, cleanupJudgeRuntimeDir };
